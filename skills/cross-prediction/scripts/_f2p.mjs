// _f2p.mjs — free-to-play (POINT) season + claim primitives.
//
// These endpoints exist only on the POINT market base. Verified end to end on
// 2026-08-27 with nothing but a private key:
//
//   1. POST /f2p/season/enter  → server-signed EnterSeason authorization
//      → submit enterSeason(signature) on the PunchPoint contract. Once per season.
//   2. POST /f2p/point/claim   → server-signed mint authorization for everything earned
//      → submit mint(to, labels, amounts, deadline, signature). The server never
//        holds your key; you submit the transaction yourself.
//
// Referral rewards sweep in batches: a claim response can come back with
// hasMore=true and a referralCursor, meaning more is claimable in another round.
// A response with signed=false is an in-progress sweep and must NOT be submitted.

import { AUTH_ORIGIN, resolveMarket } from './_markets.mjs';

/** PunchPoint contract surface used by the F2P flow. */
export const PUNCH_POINT_ABI = [
  {
    type: 'function',
    name: 'enterSeason',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'signature', type: 'bytes' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'labels', type: 'bytes32[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
];

/**
 * Defensive bound on the referral sweep loop. The API documents the scan as
 * "bounded, resumable" without giving a maximum, so this only guards against a
 * server bug returning hasMore forever — it is not a spec value.
 */
export const MAX_SWEEP_ROUNDS = 50;

function f2pBase() {
  return resolveMarket('point').apiBase;
}

async function f2pFetch(path, { token, method = 'GET', body, timeoutMs = 15_000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(f2pBase() + path, {
      method,
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        origin: AUTH_ORIGIN,
        referer: AUTH_ORIGIN + '/',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json, data: json?.data ?? json };
  } finally {
    clearTimeout(t);
  }
}

/** Global F2P summary — season state, prize pool. No auth required. */
export async function getSummary() {
  const r = await f2pFetch('/f2p/summary');
  return r.data;
}

/** Everything the wallet has earned but not yet claimed. Requires auth. */
export async function getEarn(token) {
  const r = await f2pFetch('/f2p/point/earn', { token });
  if (r.status !== 200) {
    const err = new Error(`GET /f2p/point/earn failed: HTTP ${r.status}`);
    err.body = r.body;
    throw err;
  }
  return r.data;
}

/** Request a server-signed EnterSeason authorization. */
export async function requestEnterSeason(token) {
  const r = await f2pFetch('/f2p/season/enter', { token, method: 'POST', body: {} });
  if (r.status !== 200 || !r.data?.signed) {
    const err = new Error(`POST /f2p/season/enter did not return a signed authorization (HTTP ${r.status})`);
    err.body = r.body;
    throw err;
  }
  return r.data;
}

/**
 * Request a server-signed mint authorization for claimable POINT.
 * Pass `referralCursor` to continue a batched referral sweep.
 *
 * Returns the raw response plus a `needsSeasonEntry` flag: the service answers
 * 409 with an EnterSeason hint when the wallet has not entered the season yet.
 */
export async function requestClaim(token, referralCursor) {
  const r = await f2pFetch('/f2p/point/claim', {
    token,
    method: 'POST',
    body: referralCursor ? { referralCursor } : {},
  });
  const needsSeasonEntry =
    r.status === 409 && /entersseason|enterseason/i.test(JSON.stringify(r.body ?? {}));
  return { ...r, needsSeasonEntry };
}

/** Pull the verifying contract address out of a signed authorization envelope. */
export function verifyingContractOf(auth) {
  return auth?.verifyingContract ?? auth?.typedData?.domain?.verifyingContract;
}

/** Selector of the relayed overload enterSeason(address,bytes). */
const RELAYED_ENTER_SELECTOR = '38c5cbc1';

const relayedSupport = new Map();

/**
 * Does the deployed contract expose enterSeason(address,bytes)?
 *
 * The proxy holds no logic, so the selector is probed on the implementation
 * behind the EIP-1967 slot. Result is cached per contract address.
 */
export async function supportsRelayedEntry(publicClient, contractAddress) {
  const key = String(contractAddress).toLowerCase();
  if (relayedSupport.has(key)) return relayedSupport.get(key);
  let ok = false;
  try {
    let code = await publicClient.getBytecode({ address: contractAddress });
    // A proxy is a few hundred bytes; follow it to the implementation.
    if (code && code.length < 1000) {
      const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
      const raw = await publicClient.getStorageAt({ address: contractAddress, slot });
      const impl = raw && '0x' + raw.slice(-40);
      if (impl && /^0x[0-9a-fA-F]{40}$/.test(impl) && BigInt(impl) !== 0n) {
        code = await publicClient.getBytecode({ address: impl });
      }
    }
    ok = Boolean(code && code.includes(RELAYED_ENTER_SELECTOR));
  } catch {
    ok = false;
  }
  relayedSupport.set(key, ok);
  return ok;
}

/**
 * Build the enterSeason call for the deployed contract.
 *
 * Returns { functionName, args, relayable }. When the relayed overload exists,
 * `relayable` is true and any funded address may submit the transaction; the
 * user address is bound into the call rather than inferred from msg.sender.
 * Otherwise the legacy one-argument form is used and the user's own wallet must
 * be the sender.
 */
export async function enterSeasonCall(publicClient, contractAddress, { user, signature }) {
  const relayable = await supportsRelayedEntry(publicClient, contractAddress);
  // Separate single-entry ABIs: viem rejects an ambiguous overload set.
  return relayable
    ? { abi: RELAYED_ENTER_ABI, functionName: 'enterSeason', args: [user, signature], relayable: true }
    : { abi: PUNCH_POINT_ABI, functionName: 'enterSeason', args: [signature], relayable: false };
}

/** enterSeason(address,bytes) — only valid once the overload is deployed. */
export const RELAYED_ENTER_ABI = [
  {
    type: 'function',
    name: 'enterSeason',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
];
