#!/usr/bin/env node
// sell — mirror of buy.mjs. DRY_RUN by default, --live to submit.
// Default order type: MARKET. Pass --limit --min-price X for limit SELL.
//
// Strategies: A (PRIVATE_KEY), C (PIN + gateway recon).
// Force with --strategy A|C or STRATEGY=… env.
//
// Usage:
//   node scripts/sell.mjs <marketId> <UP|DOWN|YES|NO|0|1> <shares> [--live]
//   node scripts/sell.mjs <marketId> <outcome> <shares> --limit --min-price 0.45 [--live]

import { formatUnits, parseUnits } from 'viem';
import {
  apiGet, getPublicClient, loadMarketConfig, ERC1155_ABI,
} from './_chain.mjs';
import { marketFromArgv } from './_markets.mjs';
import {
  assertChainId, capTrade, requireWalletAddress, printJson, fail,
} from './_guard.mjs';
import {
  buildLimitOrder, buildMarketSellOrder, signOrder, submitLimitOrder, submitMarketOrder, readMinValidNonce,
} from './_order.mjs';
import { login } from './_auth.mjs';
import { ensureCtfApprovedForAll } from './_approval.mjs';
import { resolveStrategy, buildSigner } from './_strategy.mjs';

const NAME_TO_INDEX = { UP: 0, YES: 0, LONG: 0, DOWN: 1, NO: 1, SHORT: 1, '0': 0, '1': 1 };

function parseArgs(argv) {
  const out = {
    marketId: null, outcome: null, shares: null,
    minPrice: null, limit: false, live: false, strategy: null,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-price') out.minPrice = Number(argv[++i]);
    else if (a === '--limit') out.limit = true;
    else if (a === '--live') out.live = true;
    else if (a === '--strategy') out.strategy = String(argv[++i] ?? '').toUpperCase();
    else if (!a.startsWith('--')) pos.push(a);
  }
  out.marketId = pos[0] ?? null;
  out.outcome = (pos[1] ?? '').toUpperCase();
  out.shares = Number(pos[2] ?? NaN);
  return out;
}

async function main() {
  let venue;
  let cfg;
  let marketReason;
  const args = parseArgs(process.argv.slice(2));
  if (!/^[0-9a-f-]{36}$/.test(args.marketId ?? ''))
    return fail('BAD_ARG', 'marketId must be a UUID');
  const outcomeIndex = NAME_TO_INDEX[args.outcome];
  if (outcomeIndex !== 0 && outcomeIndex !== 1)
    return fail('BAD_ARG', `outcome must be one of: 0, 1, UP, DOWN, YES, NO, LONG, SHORT (got ${args.outcome || 'empty'})`);
  if (!Number.isFinite(args.shares) || args.shares <= 0)
    return fail('BAD_ARG', 'shares must be positive');
  if (args.limit && (args.minPrice == null || !(args.minPrice > 0 && args.minPrice < 1)))
    return fail('BAD_ARG', '--limit requires --min-price in (0, 1) collateral/share');

  let walletAddress;
  try {
    walletAddress = requireWalletAddress();
    await assertChainId();
    ({ market: venue, reason: marketReason } = await marketFromArgv(process.argv.slice(2)));
    cfg = await loadMarketConfig(venue.key);

  } catch (e) { return fail('GUARD_FAIL', e.message); }

  let market;
  try { market = await apiGet(`/markets/${args.marketId}`, { market: venue }); }
  catch (e) { return fail('API_FAIL', `market fetch: ${e.message}`); }

  if (market.status !== 'ACTIVE' || !market.tradable) {
    return fail('MARKET_CLOSED', `market status=${market.status} tradable=${market.tradable}`);
  }

  const outcome = market.outcomes.find((o) => o.outcomeIndex === outcomeIndex);
  const opposite = market.outcomes.find((o) => o.outcomeIndex === 1 - outcomeIndex);
  if (!outcome || !opposite) return fail('BAD_MARKET', 'outcomes missing expected indices');

  let orderbookSnap;
  try { orderbookSnap = await apiGet(`/markets/${args.marketId}/orderbook?outcomeIndex=${outcomeIndex}`, { market: venue }); } catch {}
  const bestBid = orderbookSnap?.bestBid ? Number(orderbookSnap.bestBid) : null;

  const priceForCap = args.limit ? args.minPrice : (bestBid ?? 1);
  const notionalBill = args.shares * priceForCap;
  try { capTrade({ sideBill: notionalBill }); }
  catch (e) { return fail('GUARD_FAIL', e.message); }

  const pub = getPublicClient();
  const shareBalance = await pub.readContract({
    address: cfg.ctf, abi: ERC1155_ABI, functionName: 'balanceOf',
    args: [walletAddress, BigInt(outcome.tokenId)],
  });
  const requiredShareWei = parseUnits(String(args.shares), 18);
  const hasShares = shareBalance >= requiredShareWei;

  const ERC1155_APPROVAL_ABI = [
    { type: 'function', name: 'isApprovedForAll', stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }, { name: 'operator', type: 'address' }],
      outputs: [{ type: 'bool' }] },
  ];
  const approvedForAll = await pub.readContract({
    address: cfg.ctf, abi: ERC1155_APPROVAL_ABI, functionName: 'isApprovedForAll',
    args: [walletAddress, cfg.exchange],
  });

  let strategyPlan;
  try { strategyPlan = resolveStrategy({ override: args.strategy }); }
  catch (e) { strategyPlan = { strategy: null, available: e.available, reason: e.message }; }

  const plan = {
    mode: args.live ? 'LIVE' : 'DRY_RUN',
    strategy: strategyPlan.strategy,
    strategyReason: strategyPlan.reason,
    strategyAvailable: strategyPlan.available,
    orderType: args.limit ? 'LIMIT' : 'MARKET',
    wallet: walletAddress,
    marketId: args.marketId,
    marketTitle: `${market.event?.title ?? ''} — ${market.title}`,
    outcome: { outcomeIndex, name: outcome.name, tokenId: outcome.tokenId, currentPrice: outcome.price, bestBid },
    oppositeOutcome: { outcomeIndex: opposite.outcomeIndex, name: opposite.name, tokenId: opposite.tokenId },
    intent: args.limit
      ? { side: 'SELL', shares: args.shares, minPrice: args.minPrice, minNotionalBill: notionalBill }
      : { side: 'SELL', shares: args.shares, bestBid, estimatedNotionalBill: notionalBill },
    feePpm: market.feePpm,
    holdings: { currentShares: formatUnits(shareBalance, 18), sharesOk: hasShares },
    ctfApprovedForAll: approvedForAll,
    maxTradeCap: Number(process.env[venue.key === 'usd' ? 'MAX_TRADE_ONEUSD' : 'MAX_TRADE_POINT'] ?? (venue.key === 'usd' ? '10' : '1000')),
  };

  if (!args.live) {
    return printJson({ ...plan, _notice: 'DRY_RUN — no signature, no submission. Re-run with --live to execute.' });
  }

  // ──────── LIVE ────────
  if (!strategyPlan.strategy) return fail('NO_STRATEGY', strategyPlan.reason ?? 'no usable strategy');
  if (!hasShares) return fail('INSUFFICIENT_SHARES', `wallet holds ${plan.holdings.currentShares} shares, need ${args.shares}`);

  return placeViaApi(plan, args, walletAddress, strategyPlan.strategy, {
    market, outcome, opposite, approvedForAll,
  });
}

async function placeViaApi(plan, args, walletAddress, strategy, ctx) {
  let signer;
  try { signer = await buildSigner(strategy); }
  catch (e) { return fail(e.code || 'SIGNER_FAIL', e.message); }
  try {
    if (signer.address.toLowerCase() !== walletAddress.toLowerCase()) {
      return fail('ADDRESS_MISMATCH', `${strategy === 'A' ? 'PRIVATE_KEY' : 'gateway wallet'} resolves to ${signer.address}, WALLET_ADDRESS is ${walletAddress}`);
    }

    let approvalResult = null;
    if (!ctx.approvedForAll) {
      if (strategy === 'A') {
        approvalResult = await ensureCtfApprovedForAll(signer.walletClient, signer.account);
      } else {
        return fail('APPROVAL_GAP',
          'Strategy C cannot send on-chain approvals from outside the website. ' +
          'Open punch.win once and execute a tiny SELL through the UI to set CTF approval, then retry.',
        );
      }
    }

    const session = await login(signer);
    const nonce = await readMinValidNonce(signer.address);

    const order = args.limit
      ? buildLimitOrder({
          marketOutcome: { tokenId: ctx.outcome.tokenId, oppositeTokenId: ctx.opposite.tokenId },
          side: 'SELL', shares: args.shares, price: args.minPrice,
          feePpm: ctx.market.feePpm, maker: signer.address, nonce,
        })
      : buildMarketSellOrder({
          marketOutcome: { tokenId: ctx.outcome.tokenId, oppositeTokenId: ctx.opposite.tokenId },
          shares: args.shares,
          feePpm: ctx.market.feePpm, maker: signer.address, nonce,
        });
    const signature = await signOrder(signer, order);

    const submit = args.limit ? submitLimitOrder : submitMarketOrder;
    let submitResponse;
    try {
      submitResponse = await submit({
        accessToken: session.accessToken,
        marketId: args.marketId,
        order,
        tokenIdHex: ctx.outcome.tokenId,
        oppositeTokenId: ctx.opposite.tokenId,
        signature,
      });
    } catch (e) {
      return fail('SUBMIT_FAIL', e.message, {
        status: e.status, serverBody: e.body, sentBody: e.requestBody,
      });
    }

    return printJson({
      ...plan,
      approval: approvalResult,
      orderNonce: nonce.toString(),
      orderSalt: order.salt,
      orderExpiration: order.expiration.toString(),
      signaturePrefix: signature.slice(0, 18) + '…',
      submitResponse,
    });
  } finally {
    try { await signer?.close(); } catch {}
  }
}

main().catch((e) => fail('UNEXPECTED', e.message));
