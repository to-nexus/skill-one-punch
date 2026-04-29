// Safety guards applied to every mutating operation.
// Keep logic in ONE place so SKILL.md and scripts share behavior.

import { CROSS_CHAIN_ID, getPublicClient } from './_chain.mjs';

export function requireEnv(name, { pattern } = {}) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  if (pattern && !pattern.test(value)) {
    throw new Error(`Env var ${name} has invalid format`);
  }
  return value;
}

export function requireWalletAddress() {
  return requireEnv('WALLET_ADDRESS', { pattern: /^0x[0-9a-fA-F]{40}$/ });
}

export async function assertChainId() {
  const client = getPublicClient();
  const chainId = await client.getChainId();
  if (chainId !== CROSS_CHAIN_ID) {
    throw new Error(`RPC reports chain id ${chainId}, expected ${CROSS_CHAIN_ID}. Aborting.`);
  }
}

export function capTrade({ sideBill }) {
  const max = Number(process.env.MAX_TRADE_BILL ?? '100');
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('MAX_TRADE_BILL must be a positive number');
  }
  if (sideBill > max) {
    throw new Error(
      `Trade notional ${sideBill} BILL exceeds MAX_TRADE_BILL=${max}. ` +
      `Raise the cap explicitly if this is intentional.`,
    );
  }
  return max;
}

export function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export function fail(code, message, extra = {}) {
  printJson({ error: message, code, ...extra });
  process.exit(1);
}
