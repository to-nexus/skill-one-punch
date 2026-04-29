// _strategy.mjs — pick the right execution strategy from environment.
//
//   STRATEGY=A → require PRIVATE_KEY            (local viem signer; fastest, full control)
//   STRATEGY=B → require PIN + saved storageState (Playwright UI automation)
//   STRATEGY=C → require PIN                    (CROSSx gateway remote signer)
//   STRATEGY=auto (default) → pick the highest-fidelity option that has its
//                              prerequisites met, in order: A → B → C.
//
// Returning a `Plan` object keeps the dispatch site (buy.mjs / sell.mjs) tiny.

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE_PATH = resolve(SKILL_DIR, '.auth', 'state.json');

export const STORAGE_STATE_PATH = STORAGE_PATH;

function envHas(name, pattern) {
  const v = process.env[name];
  return typeof v === 'string' && (!pattern || pattern.test(v));
}

function detectAvailable() {
  return {
    A: envHas('PRIVATE_KEY', /^0x[0-9a-fA-F]{64}$/),
    B: envHas('PIN', /^\d{6}$/) && existsSync(STORAGE_PATH),
    C: envHas('PIN', /^\d{6}$/),
  };
}

/**
 * Resolve the strategy.
 *
 *  override: explicit "A"|"B"|"C" from CLI flag (--strategy=…).
 *  Returns:  { strategy, available, reason }
 *  Throws:   { code: "NO_STRATEGY", message } if nothing usable.
 */
export function resolveStrategy({ override } = {}) {
  const requested = (override ?? process.env.STRATEGY ?? 'auto').toUpperCase();
  const avail = detectAvailable();

  if (requested === 'A' || requested === 'B' || requested === 'C') {
    if (!avail[requested]) {
      const e = new Error(reasonMissing(requested));
      e.code = 'STRATEGY_PREREQ_MISSING';
      e.requested = requested;
      e.available = avail;
      throw e;
    }
    return { strategy: requested, available: avail, reason: 'forced by user' };
  }

  if (requested !== 'AUTO') {
    const e = new Error(`Unknown STRATEGY=${requested}. Valid: A, B, C, auto.`);
    e.code = 'BAD_STRATEGY';
    throw e;
  }

  // auto: prefer A → B → C
  if (avail.A) return { strategy: 'A', available: avail, reason: 'PRIVATE_KEY present (local viem signer)' };
  if (avail.B) return { strategy: 'B', available: avail, reason: 'PIN + saved session present (Playwright UI)' };
  if (avail.C) return { strategy: 'C', available: avail, reason: 'PIN present, no saved session (gateway signer)' };

  const e = new Error(
    'No usable trading strategy. Provide one of:\n' +
    '  • PRIVATE_KEY=0x… (Strategy A — local viem signer)\n' +
    '  • PIN=123456 + run `node scripts/_login-capture.mjs` once (Strategy B — Playwright UI)\n' +
    '  • PIN=123456 + run `node scripts/_recon-gateway.mjs` once (Strategy C — CROSSx gateway)',
  );
  e.code = 'NO_STRATEGY';
  e.available = avail;
  throw e;
}

function reasonMissing(strategy) {
  switch (strategy) {
    case 'A': return 'STRATEGY=A requires PRIVATE_KEY (0x + 64 hex) in env.';
    case 'B': return `STRATEGY=B requires PIN (6 digits) AND a saved session at ${STORAGE_PATH}. Run \`node scripts/_login-capture.mjs\` first.`;
    case 'C': return 'STRATEGY=C requires PIN (6 digits) AND a configured gateway. Run `node scripts/_recon-gateway.mjs` first.';
    default:  return `unknown strategy ${strategy}`;
  }
}

/** Build a signer for A/C. Returns null for B (B has no signer — uses UI). */
export async function buildSigner(strategy) {
  if (strategy === 'A') {
    const { createViemSigner } = await import('./_signer-a-viem.mjs');
    return createViemSigner(process.env.PRIVATE_KEY);
  }
  if (strategy === 'C') {
    const { createGatewaySigner } = await import('./_signer-c-gateway.mjs');
    return createGatewaySigner({ pin: process.env.PIN });
  }
  if (strategy === 'B') return null;
  throw new Error(`buildSigner: unsupported strategy ${strategy}`);
}
