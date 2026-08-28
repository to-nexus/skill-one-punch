// _order.mjs — build, sign, and POST a PredictionExchange order.
//
// Per references/api-map.md § Order signing. Fields and math match the client
// exactly:
//   side      : 0=BUY, 1=SELL
//   orderType : 0=MARKET, 1=LIMIT (GTC)
//   makerAmount/takerAmount : *uint256*, 18-decimal scaling for both sides
//     LIMIT BUY : makerAmount = price*qty*1e18 (collateral offered), takerAmount = qty*1e18 (shares)
//     LIMIT SELL: makerAmount = qty*1e18 (shares offered),     takerAmount = price*qty*1e18 (collateral)
//   expiration: uint256 seconds (client default now+30d; never 0)
//   salt      : random bytes32
//   nonce     : Exchange.getMinValidNonce(maker) — read on-chain
//
// After signTypedData, POST to /orders/place/limit (Bearer JWT).

import { parseUnits } from 'viem';
import { AUTH_ORIGIN } from './_markets.mjs';
import {
  API_BASE, getPublicClient, loadMarketConfig, EXCHANGE_ABI,
} from './_chain.mjs';

export const SIDE = { BUY: 0, SELL: 1 };
export const ORDER_TYPE = { MARKET: 0, LIMIT: 1, IOC: 2, FOK: 3 };

export async function readMinValidNonce(maker, market) {
  const cfg = await loadMarketConfig(market?.key ?? market);
  const pub = getPublicClient();
  return pub.readContract({
    address: cfg.exchange,
    abi: EXCHANGE_ABI,
    functionName: 'getMinValidNonce',
    args: [maker],
  });
}

/** Generate a cryptographically random bytes32 salt. */
export function randomSalt() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return '0x' + Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build an unsigned Order struct for a LIMIT order.
 *   side         : "BUY" | "SELL"
 *   shares / price: limit terms
 */
export function buildLimitOrder({ marketOutcome, side, shares, price, feePpm, maker, nonce, expirationSec }) {
  const s = side.toUpperCase();
  if (s !== 'BUY' && s !== 'SELL') throw new Error('side must be BUY or SELL');
  if (!(shares > 0)) throw new Error('shares must be > 0');
  if (!(price > 0 && price < 1)) throw new Error('price must be in (0, 1)');

  const qtyWei = parseUnits(String(shares), 18);
  const priceWei = parseUnits(String(price), 18);
  const notionalWei = (priceWei * qtyWei) / 10n ** 18n;

  const makerAmount = s === 'BUY' ? notionalWei : qtyWei;
  const takerAmount = s === 'BUY' ? qtyWei : notionalWei;

  return {
    maker,
    feePpm: feePpm | 0,
    side: SIDE[s],
    orderType: ORDER_TYPE.LIMIT,
    makerAmount,
    takerAmount,
    tokenId: BigInt(marketOutcome.tokenId),
    expiration: BigInt(expirationSec ?? Math.floor(Date.now() / 1000) + 30 * 24 * 3600),
    nonce: BigInt(nonce),
    salt: randomSalt(),
  };
}

/**
 * Build an unsigned Order struct for a MARKET order.
 *
 *  ⚠ Empirical semantics (verified by live trade 2026-04-24):
 *  - MARKET BUY  : the frontend's `u` = **collateral notional to spend**, not shares.
 *                  makerAmount = takerAmount = notional × 1e18.
 *                  Fill ≈ floor(notional / avgFillPrice) shares, capped by orderbook depth.
 *  - MARKET SELL : the frontend's `u` = **shares to sell**.
 *                  makerAmount = shares × 1e18,  takerAmount = 1 wei (any collateral proceeds).
 *
 *  (Bundle @ 0-3h.rd2xoxoa.js:114100, reconciled with captured UI requests
 *   and real fill observations — the `u` field is asymmetric between BUY and SELL.)
 */
export function buildMarketBuyOrder({ marketOutcome, notional, feePpm, maker, nonce, expirationSec }) {
  if (!(notional > 0)) throw new Error('notional must be > 0');
  const notionalWei = parseUnits(String(notional), 18);
  return {
    maker,
    feePpm: feePpm | 0,
    side: SIDE.BUY,
    orderType: ORDER_TYPE.MARKET,
    makerAmount: notionalWei,
    takerAmount: notionalWei,
    tokenId: BigInt(marketOutcome.tokenId),
    expiration: BigInt(expirationSec ?? Math.floor(Date.now() / 1000) + 30 * 24 * 3600),
    nonce: BigInt(nonce),
    salt: randomSalt(),
  };
}

export function buildMarketSellOrder({ marketOutcome, shares, feePpm, maker, nonce, expirationSec }) {
  if (!(shares > 0)) throw new Error('shares must be > 0');
  const qtyWei = parseUnits(String(shares), 18);
  return {
    maker,
    feePpm: feePpm | 0,
    side: SIDE.SELL,
    orderType: ORDER_TYPE.MARKET,
    makerAmount: qtyWei,
    takerAmount: 1n,
    tokenId: BigInt(marketOutcome.tokenId),
    expiration: BigInt(expirationSec ?? Math.floor(Date.now() / 1000) + 30 * 24 * 3600),
    nonce: BigInt(nonce),
    salt: randomSalt(),
  };
}

export const EIP712_TYPES = {
  Order: [
    { name: 'maker',       type: 'address' },
    { name: 'feePpm',      type: 'uint32'  },
    { name: 'side',        type: 'uint8'   },
    { name: 'orderType',   type: 'uint8'   },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'tokenId',     type: 'uint256' },
    { name: 'expiration',  type: 'uint256' },
    { name: 'nonce',       type: 'uint256' },
    { name: 'salt',        type: 'bytes32' },
  ],
};

export function eip712Domain(exchangeAddress) {
  if (!exchangeAddress) throw new Error('eip712Domain() requires the market exchange address');
  return {
    name: 'PredictionExchange',
    version: '1',
    chainId: 612055,
    verifyingContract: exchangeAddress,
  };
}

/**
 * Sign the typed order. Accepts either a viem account or any Signer
 * (see _signer.mjs) — both expose `signTypedData(...)`.
 * Returns a hex signature.
 */
export async function signOrder(signer, order) {
  return signer.signTypedData({
    domain: eip712Domain(),
    types: EIP712_TYPES,
    primaryType: 'Order',
    message: order,
  });
}

/** Wire body (captured from live UI request, 2026-04-24):
 *  - side         : lowercase "buy" / "sell"
 *  - orderType    : NUMBER 0 (MARKET) / 1 (LIMIT) — NOT a string
 *  - tokenId / oppositeTokenId : hex 0x… string
 *  - makerAmount / takerAmount : decimal uint256 strings
 *  - expiration   : number (seconds)
 *  - nonce        : decimal string
 *  - salt         : 0x… 32-byte hex
 *  - signature    : 0x… hex, signatureType: 0 (EOA)
 */
function buildWireBody({ marketId, order, tokenIdHex, oppositeTokenId, signature }) {
  return {
    tokenId: tokenIdHex,
    oppositeTokenId,
    marketId,
    side: order.side === SIDE.BUY ? 'buy' : 'sell',
    maker: order.maker,
    taker: '0x0000000000000000000000000000000000000000',
    makerAmount: order.makerAmount.toString(),
    takerAmount: order.takerAmount.toString(),
    salt: order.salt,
    nonce: order.nonce.toString(),
    expiration: Number(order.expiration),
    feeRatePpm: order.feePpm,
    signature,
    signatureType: 0,
    signer: order.maker,
    orderType: order.orderType, // number: 0=MARKET, 1=LIMIT
  };
}

async function postOrder(path, body, accessToken) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'authorization': `Bearer ${accessToken}`,
      'origin': AUTH_ORIGIN,
      'referer': AUTH_ORIGIN + '/',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.code && json.code < 0)) {
    const err = new Error(json.data || json.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    err.requestBody = body;
    throw err;
  }
  return json.data ?? json;
}

export async function submitLimitOrder({ accessToken, marketId, order, tokenIdHex, oppositeTokenId, signature }) {
  return postOrder('/orders/place/limit', buildWireBody({ marketId, order, tokenIdHex, oppositeTokenId, signature }), accessToken);
}

export async function submitMarketOrder({ accessToken, marketId, order, tokenIdHex, oppositeTokenId, signature }) {
  return postOrder('/orders/place/market', buildWireBody({ marketId, order, tokenIdHex, oppositeTokenId, signature }), accessToken);
}
