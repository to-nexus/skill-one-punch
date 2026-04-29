#!/usr/bin/env node
// _recon-gateway — one-time capture of the CROSSx embedded-wallet gateway calls.
//
// Run this once from a desktop. A headful Chromium opens at prediction.crossdefi.io
// already authenticated (using the Strategy B `state.json`). Trigger ONE small
// signature flow in the UI — e.g. open a market, click Buy 1 share, enter PIN.
// We tail every request to `embedded-wallet-gateway.crosstoken.io` and persist
// what we see at:
//   ~/.claude/skills/cross-prediction/.session/gateway.json
//
// The captured file is enough for `_signer-c-gateway.mjs` to drive Strategy C.
//
// SECURITY: we DO NOT persist PIN, refresh tokens, or full request bodies. We
// persist only:
//   - base URL
//   - endpoint path / method per logical action
//   - field names observed in request bodies (so the signer knows the schema)
//   - one short-lived `authToken` (the social-login bearer the gateway expects)
//     ↳ stored chmod 600. Wipe with `rm .session/gateway.json` to revoke.
//
// Usage:
//   node scripts/_recon-gateway.mjs

import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { chromium } from 'playwright';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE_PATH = resolve(SKILL_DIR, '.auth', 'state.json');
const SESSION_DIR = resolve(SKILL_DIR, '.session');
const OUT_PATH = resolve(SESSION_DIR, 'gateway.json');
const PRED_BASE = process.env.PREDICTION_BASE_URL ?? 'https://prediction.crossdefi.io';
const GATEWAY_HOST = 'embedded-wallet-gateway.crosstoken.io';

function classify(url, method) {
  const u = new URL(url);
  const p = u.pathname.toLowerCase();
  if (p.includes('pin')   && method === 'POST') return 'pinVerify';
  if (p.includes('typed') && method === 'POST') return 'signTypedData';
  if (p.includes('sign')  && method === 'POST') return 'signMessage';
  if (p.includes('wallet') && method === 'GET') return 'walletInfo';
  return null;
}

async function main() {
  if (!existsSync(STORAGE_PATH)) {
    console.error(`No storage state at ${STORAGE_PATH}. Run \`node scripts/_login-capture.mjs\` first.`);
    process.exit(1);
  }
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: STORAGE_PATH });
  const page = await context.newPage();

  const captures = {
    base: `https://${GATEWAY_HOST}/api/v1`,
    endpoints: {},
    fields: {},
    authToken: null,
  };

  context.on('request', (req) => {
    const url = req.url();
    if (!url.includes(GATEWAY_HOST)) return;
    const kind = classify(url, req.method());
    if (!kind) return;
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1/, '');
    captures.endpoints[kind] = { method: req.method(), path };
    if (req.method() !== 'GET') {
      try {
        const body = JSON.parse(req.postData() ?? '{}');
        captures.fields = { ...captures.fields, ...Object.fromEntries(Object.keys(body).map((k) => [k, k])) };
      } catch { /* non-JSON */ }
    }
    const auth = req.headers()['authorization'];
    if (auth?.startsWith('Bearer ')) captures.authToken = auth.slice(7);
  });

  await page.goto(PRED_BASE);
  console.error(
    '\nA browser is open at ' + PRED_BASE + '.\n' +
    '1) Make sure you are signed in.\n' +
    '2) Open ANY market and execute a tiny BUY (e.g. 1 share) — enter your PIN.\n' +
    '3) Wait for the trade to confirm in the UI.\n' +
    '4) Return to this terminal and press ENTER.\n',
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  await rl.question('Press ENTER when done capturing: ');
  rl.close();

  // Merge with any existing capture so re-running adds, never silently drops.
  let prior = {};
  if (existsSync(OUT_PATH)) {
    try { prior = JSON.parse(readFileSync(OUT_PATH, 'utf8')); } catch {}
  }
  const merged = {
    base: captures.base,
    endpoints: { ...(prior.endpoints ?? {}), ...captures.endpoints },
    fields:    { ...(prior.fields    ?? {}), ...captures.fields },
    authToken: captures.authToken ?? prior.authToken ?? null,
    capturedAt: new Date().toISOString(),
  };
  writeFileSync(OUT_PATH, JSON.stringify(merged, null, 2));
  try { chmodSync(OUT_PATH, 0o600); } catch {}
  await browser.close();

  process.stdout.write(JSON.stringify({
    saved: OUT_PATH,
    capturedEndpoints: Object.keys(merged.endpoints),
    sawAuthToken: !!merged.authToken,
    note: 'If `endpoints` is empty, the gateway calls did not match recon heuristics. ' +
          'Re-run with the browser DevTools network tab open and verify the host is ' + GATEWAY_HOST + '.',
  }, null, 2) + '\n');
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: e.message, code: 'RECON_GATEWAY_FAIL' }) + '\n');
  process.exit(1);
});
