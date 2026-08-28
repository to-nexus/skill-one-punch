// _auth.mjs — SIWE login against cross-auth.crosstoken.io.
//
// Flow (captured from the live service on 2026-04-24):
//   1. POST https://cross-auth.crosstoken.io/cross-auth/login/unsigned-hash
//        body: { address, domain, chain_id }
//        headers: must set origin+referer to the live app origin (punch.win)
//        → { hash, message }  (SIWE message string)
//   2. signer.signMessage(message) — EIP-191 personal_sign
//      • Strategy A: signs locally with viem account
//      • Strategy C: signs remotely via CROSSx gateway (PIN-gated)
//   3. POST /login/token
//        body: { address, signature, domain }
//        → { token, refresh }  ← prediction-service JWT
//
// JWT is cached in memory only — never written to disk.

import { AUTH_ORIGIN } from './_markets.mjs';

const AUTH_BASE = process.env.CROSS_AUTH_BASE ?? 'https://cross-auth.crosstoken.io/cross-auth';
// The auth service validates Origin/Referer against the calling app. The product
// moved to punch.win; sending the old prediction.crossdefi.io origin gets rejected.
const PRED_ORIGIN = AUTH_ORIGIN;

function authHeaders() {
  return {
    'content-type': 'application/json',
    'accept': 'application/json',
    'origin': PRED_ORIGIN,
    'referer': PRED_ORIGIN + '/',
    'user-agent': 'punch-prediction-skill/0.4',
  };
}

async function postJson(url, body, { timeoutMs = 10_000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.code < 0) {
      const err = new Error(json.data || json.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json.data;
  } finally { clearTimeout(t); }
}

/**
 * Run the full SIWE login flow using the given Signer.
 *
 *   signer: { address, signMessage(text) → 0x… } (see _signer.mjs)
 *
 * Returns { accessToken, refreshToken, address, strategy }.
 */
export async function login(signer) {
  if (!signer || !signer.address || typeof signer.signMessage !== 'function') {
    throw new Error('login() requires a Signer with address + signMessage()');
  }
  const address = signer.address;

  // 1) fetch unsigned hash + SIWE message
  const { message } = await postJson(`${AUTH_BASE}/login/unsigned-hash`, {
    address, domain: PRED_ORIGIN, chain_id: 612055,
  });
  if (typeof message !== 'string' || !message.includes('wants you to sign in')) {
    throw new Error(`unexpected SIWE message: ${String(message).slice(0, 120)}`);
  }

  // 2) personal_sign — delegate to whatever the strategy provides
  const signature = await signer.signMessage(message);

  // 3) exchange for JWT
  const tokens = await postJson(`${AUTH_BASE}/login/token`, {
    address, signature, domain: PRED_ORIGIN,
  });

  // Shape observed: { token, refresh } — accept aliases defensively.
  const accessToken = tokens.token ?? tokens.accessToken;
  const refreshToken = tokens.refresh ?? tokens.refreshToken;
  if (!accessToken) throw new Error(`login/token returned no access token: ${JSON.stringify(tokens).slice(0, 200)}`);
  return { accessToken, refreshToken, address, strategy: signer.strategy };
}

/** Simple JWT cache — single account per process. Reset by setSession(null). */
let _session = null;
export function setSession(s) { _session = s; }
export function getSession() { return _session; }

/** Convenience: login if not already cached. */
export async function ensureLoggedIn(signer) {
  if (_session?.accessToken && _session.address?.toLowerCase() === signer.address.toLowerCase()) return _session;
  _session = await login(signer);
  return _session;
}
