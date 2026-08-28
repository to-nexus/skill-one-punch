// Shared viem client, chain config, ABIs, and API helpers for cross-prediction.

import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { resolveMarket, AUTH_ORIGIN } from './_markets.mjs';

export const CROSS_CHAIN_ID = 612055;

/**
 * Default API base, kept for callers that have not been made market-aware yet.
 * Prefer apiGet(path, { market }) — the base is resolved per market.
 */
export const API_BASE = resolveMarket().apiBase;

export const crossChain = defineChain({
  id: CROSS_CHAIN_ID,
  name: 'CROSS Chain',
  // CROSS remains the chain's native gas token. It is no longer a traded asset:
  // the CROSS-denominated prediction market is retired.
  nativeCurrency: { name: 'CROSS', symbol: 'CROSS', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.CROSS_RPC_URL ?? 'https://mainnet.crosstoken.io:22001/'] },
  },
  blockExplorers: {
    default: { name: 'CROSS Explorer', url: 'https://explorer.crosstoken.io/612055' },
  },
});

// Contract addresses are resolved at runtime from GET /config, per market.
// They are NOT hardcoded: usd and point deploy separate CTF/Exchange instances,
// and the previously pinned BILL-market addresses are dead.
const CONFIG_CACHE = new Map();

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
];

export const ERC1155_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }],
    outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOfBatch', stateMutability: 'view',
    inputs: [{ name: 'accounts', type: 'address[]' }, { name: 'ids', type: 'uint256[]' }],
    outputs: [{ type: 'uint256[]' }] },
];

export const CTF_REDEEM_ABI = [
  { type: 'function', name: 'redeemPositions', stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    outputs: [] },
];

// Exchange ABI subset needed for nonce read (trading writes come in Phase 2.2).
export const EXCHANGE_ABI = [
  { type: 'function', name: 'getMinValidNonce', stateMutability: 'view',
    inputs: [{ name: 'maker', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

export function getPublicClient() {
  return createPublicClient({ chain: crossChain, transport: http() });
}

export function getWalletClient(privateKey) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '')) {
    throw new Error('PRIVATE_KEY must be a 0x-prefixed 64-char hex string');
  }
  const account = privateKeyToAccount(privateKey);
  return { client: createWalletClient({ account, chain: crossChain, transport: http() }), account };
}

/** Minimal JSON GET helper. Returns data.data (unwrapping the { code, message, data } envelope). */
export async function apiGet(path, { headers = {}, timeoutMs = 10_000, market } = {}) {
  const base = market ? resolveMarket(market.key ?? market).apiBase : API_BASE;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      signal: ctl.signal,
      headers: { accept: 'application/json', origin: AUTH_ORIGIN, ...headers },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.code < 0) {
      const err = new Error(body?.data || body?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body.data;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch GET /config for a market and return its live contract addresses.
 * Cached per market for the process lifetime.
 *
 *   { quoteToken: { address, symbol, decimals }, ctf, exchange, batchRedeemer,
 *     negRiskAdapter, referralVault, shareDecimals }
 */
export async function loadMarketConfig(marketKey) {
  const m = resolveMarket(marketKey);
  if (CONFIG_CACHE.has(m.key)) return CONFIG_CACHE.get(m.key);
  const cfg = await apiGet('/config', { market: m });
  const resolved = {
    market: m.key,
    quoteToken: cfg?.quoteToken,
    ctf: cfg?.ctfContract?.address,
    exchange: cfg?.exchangeContract?.address,
    batchRedeemer: cfg?.batchRedeemerContract?.address,
    negRiskAdapter: cfg?.negRiskAdapterContract?.address,
    referralVault: cfg?.referralVaultContract?.address,
    shareDecimals: cfg?.shareDecimals ?? 2,
  };
  if (!resolved.quoteToken?.address || !resolved.ctf || !resolved.exchange) {
    throw new Error(`GET /config for market "${m.key}" is missing required contract addresses`);
  }
  CONFIG_CACHE.set(m.key, resolved);
  return resolved;
}
