// _signer-c-gateway.mjs — Strategy C signer (CROSSx embedded-wallet gateway).
//
// Goal: let users who logged in with social (Google/Apple) sign the prediction
// service's SIWE message and EIP-712 orders WITHOUT exporting a private key.
// The user only provides a 6-digit PIN; the gateway holds the key.
//
// This signer is configuration-driven because the gateway API has not been
// publicly documented. The first run requires either:
//   1. A captured config at  ~/.claude/skills/cross-prediction/.session/gateway.json
//      (produced by `node scripts/_recon-gateway.mjs`), OR
//   2. Manual override via env vars (CROSSX_GATEWAY_BASE, CROSSX_AUTH_TOKEN, …).
//
// If neither is available, signMessage / signTypedData fail with a clear
// GATEWAY_NOT_CONFIGURED error pointing at the recon tool.
//
// Security:
//   - PIN is sent ONLY over HTTPS to embedded-wallet-gateway.crosstoken.io.
//   - Auth tokens are kept in process memory; never persisted to disk by the
//     signer itself. (The recon tool may persist the *gateway base URL* and
//     captured *endpoint shapes* — never the auth token or the PIN.)

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSignerShape } from './_signer.mjs';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY_CONFIG_PATH = resolve(SKILL_DIR, '.session', 'gateway.json');

const DEFAULT_BASE = 'https://embedded-wallet-gateway.crosstoken.io/api/v1';

// Best-guess endpoint shape. Override via gateway.json after running --recon.
// This is intentionally conservative: if shapes don't match the live gateway,
// we'd rather throw than silently sign the wrong payload.
const HYPOTHESIS = Object.freeze({
  base: DEFAULT_BASE,
  endpoints: {
    pinVerify:     { method: 'POST', path: '/auth/pin/verify',          body: 'pinAndSocial' },
    walletInfo:    { method: 'GET',  path: '/wallets/me',               body: null },
    signMessage:   { method: 'POST', path: '/wallets/sign-message',     body: 'signMessage' },
    signTypedData: { method: 'POST', path: '/wallets/sign-typed-data',  body: 'signTypedData' },
  },
  // Names of fields in request bodies — overridden by recon if different.
  fields: {
    pin:        'pin',
    address:    'address',
    chainId:    'chainId',
    message:    'message',
    typedData:  'typedData',
    signature:  'signature',
    accessToken:'accessToken',
  },
});

function loadGatewayConfig() {
  // 1. ENV override always wins (use case: user pasted endpoint after manual capture).
  const base = process.env.CROSSX_GATEWAY_BASE;
  if (base) {
    return { source: 'env', base, endpoints: HYPOTHESIS.endpoints, fields: HYPOTHESIS.fields };
  }
  // 2. Captured config from recon.
  if (existsSync(GATEWAY_CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(GATEWAY_CONFIG_PATH, 'utf8'));
      return {
        source: 'recon',
        base: raw.base ?? DEFAULT_BASE,
        endpoints: { ...HYPOTHESIS.endpoints, ...(raw.endpoints ?? {}) },
        fields:    { ...HYPOTHESIS.fields,    ...(raw.fields ?? {}) },
        // captured social-login auth token (e.g. from cross-auth.crosstoken.io)
        authToken: raw.authToken ?? null,
      };
    } catch (e) {
      throw new Error(`gateway.json parse failed: ${e.message}`);
    }
  }
  // 3. No config → caller must run recon first.
  return { source: 'none', base: DEFAULT_BASE, endpoints: HYPOTHESIS.endpoints, fields: HYPOTHESIS.fields };
}

async function gatewayFetch(cfg, endpoint, body, { authToken } = {}) {
  const ep = cfg.endpoints[endpoint];
  if (!ep) throw new Error(`gateway endpoint missing: ${endpoint}`);
  const url = cfg.base.replace(/\/$/, '') + ep.path;
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json',
    'origin': 'https://prediction.crossdefi.io',
    'referer': 'https://prediction.crossdefi.io/',
  };
  if (authToken) headers['authorization'] = `Bearer ${authToken}`;
  const res = await fetch(url, {
    method: ep.method,
    headers,
    body: ep.method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json?.message || json?.data || `gateway ${endpoint} → HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    err.endpoint = endpoint;
    throw err;
  }
  return json.data ?? json;
}

class GatewaySession {
  constructor(cfg, { pin, socialAuthToken }) {
    this.cfg = cfg;
    this.pin = pin;
    this.socialAuthToken = socialAuthToken;
    this.accessToken = null;
    this.address = null;
  }
  async ensureAuth() {
    if (this.accessToken) return;
    if (this.cfg.source === 'none') {
      throw Object.assign(new Error(
        'CROSSx gateway is not configured. Run `node scripts/_recon-gateway.mjs` once ' +
        'while signed in, or set CROSSX_GATEWAY_BASE + CROSSX_AUTH_TOKEN env vars.',
      ), { code: 'GATEWAY_NOT_CONFIGURED' });
    }
    if (!this.socialAuthToken) {
      throw Object.assign(new Error(
        'CROSSx gateway requires a social-login auth token (CROSSX_AUTH_TOKEN env or in gateway.json). ' +
        'The recon tool captures it for you.',
      ), { code: 'GATEWAY_NO_AUTH' });
    }
    // Step 1: verify PIN, receive a short-lived signing access token.
    const pinResp = await gatewayFetch(this.cfg, 'pinVerify',
      { [this.cfg.fields.pin]: this.pin },
      { authToken: this.socialAuthToken });
    this.accessToken = pinResp[this.cfg.fields.accessToken] ?? pinResp.accessToken ?? pinResp.token;
    if (!this.accessToken) {
      throw Object.assign(new Error('gateway pinVerify did not return an access token'),
        { code: 'GATEWAY_AUTH_FAIL', body: pinResp });
    }
    // Step 2: discover the wallet address.
    const info = await gatewayFetch(this.cfg, 'walletInfo', null, { authToken: this.accessToken });
    this.address = info[this.cfg.fields.address] ?? info.address ?? info.wallet?.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(this.address ?? '')) {
      throw Object.assign(new Error(`gateway walletInfo returned no address: ${JSON.stringify(info).slice(0, 200)}`),
        { code: 'GATEWAY_NO_ADDRESS' });
    }
  }
  async signMessage(message) {
    await this.ensureAuth();
    const body = {
      [this.cfg.fields.address]: this.address,
      [this.cfg.fields.message]: message,
      [this.cfg.fields.chainId]: 612055,
    };
    const r = await gatewayFetch(this.cfg, 'signMessage', body, { authToken: this.accessToken });
    const sig = r[this.cfg.fields.signature] ?? r.signature ?? r.data?.signature;
    if (!/^0x[0-9a-fA-F]+$/.test(sig ?? '')) {
      throw Object.assign(new Error(`gateway signMessage returned invalid signature: ${JSON.stringify(r).slice(0, 200)}`),
        { code: 'GATEWAY_BAD_SIGNATURE' });
    }
    return sig;
  }
  async signTypedData(typedData) {
    await this.ensureAuth();
    const body = {
      [this.cfg.fields.address]: this.address,
      [this.cfg.fields.typedData]: typedData,
      [this.cfg.fields.chainId]: typedData.domain?.chainId ?? 612055,
    };
    const r = await gatewayFetch(this.cfg, 'signTypedData', body, { authToken: this.accessToken });
    const sig = r[this.cfg.fields.signature] ?? r.signature ?? r.data?.signature;
    if (!/^0x[0-9a-fA-F]+$/.test(sig ?? '')) {
      throw Object.assign(new Error(`gateway signTypedData returned invalid signature: ${JSON.stringify(r).slice(0, 200)}`),
        { code: 'GATEWAY_BAD_SIGNATURE' });
    }
    return sig;
  }
}

export async function createGatewaySigner({ pin } = {}) {
  if (!/^\d{6}$/.test(pin ?? '')) {
    throw new Error('PIN must be 6 digits');
  }
  const cfg = loadGatewayConfig();
  const socialAuthToken = process.env.CROSSX_AUTH_TOKEN ?? cfg.authToken ?? null;
  const session = new GatewaySession(cfg, { pin, socialAuthToken });
  // Eagerly authenticate so caller learns of GATEWAY_NOT_CONFIGURED at construction time.
  await session.ensureAuth();
  return assertSignerShape({
    strategy: 'C',
    address: session.address,
    async signMessage(message) { return session.signMessage(message); },
    async signTypedData(args) { return session.signTypedData(args); },
    async close() { session.accessToken = null; },
  });
}
