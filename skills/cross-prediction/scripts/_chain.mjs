// Shared viem client, chain config, ABIs, and API helpers for cross-prediction.

import { createPublicClient, createWalletClient, http, defineChain, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const CROSS_CHAIN_ID = 612055;

export const API_BASE =
  process.env.PREDICTION_API_BASE ?? 'https://pred-bill-service-api.crossdefi.io/api/v1';

export const crossChain = defineChain({
  id: CROSS_CHAIN_ID,
  name: 'CROSS Chain',
  nativeCurrency: { name: 'CROSS', symbol: 'CROSS', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.CROSS_RPC_URL ?? 'https://mainnet.crosstoken.io:22001/'] },
  },
  blockExplorers: {
    default: { name: 'CROSS Explorer', url: 'https://explorer.crosstoken.io/612055' },
  },
});

// Canonical addresses — captured from GET /api/v1/config on 2026-04-24.
// Runtime code should still call refreshConfig() once on startup to protect against rotation.
// Normalized via viem getAddress to guarantee EIP-55 checksum correctness.
export const KNOWN_ADDRESSES = {
  bill:     getAddress('0xa6272d8053b4f5d5f7943dfbc1039b1cedebf3d4'),
  ctf:      getAddress('0x31677b2427ded0badf00b834a5ae13c3fc999859'),
  exchange: getAddress('0xb39faa85f5c353db5bd71f6f2a48bc7d6dc08fd9'),
};

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
export async function apiGet(path, { headers = {}, timeoutMs = 10_000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, {
      signal: ctl.signal,
      headers: { accept: 'application/json', ...headers },
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

/** Fetch /config and verify the hardcoded addresses still match. Returns the config.data object. */
export async function refreshConfig() {
  const cfg = await apiGet('/config');
  const warn = [];
  if (cfg?.quoteToken?.address?.toLowerCase() !== KNOWN_ADDRESSES.bill.toLowerCase())
    warn.push(`BILL address changed: got ${cfg.quoteToken.address}, expected ${KNOWN_ADDRESSES.bill}`);
  if (cfg?.ctfContract?.address?.toLowerCase() !== KNOWN_ADDRESSES.ctf.toLowerCase())
    warn.push(`CTF address changed: got ${cfg.ctfContract.address}, expected ${KNOWN_ADDRESSES.ctf}`);
  if (cfg?.exchangeContract?.address?.toLowerCase() !== KNOWN_ADDRESSES.exchange.toLowerCase())
    warn.push(`Exchange address changed: got ${cfg.exchangeContract.address}, expected ${KNOWN_ADDRESSES.exchange}`);
  return { config: cfg, warn };
}
