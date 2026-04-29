#!/usr/bin/env node
// buy — Phase 2.2 (Strategy A / B / C, ADR-002 + ADR-003).
//
// Default order type: MARKET. Pass --limit --max-price X for LIMIT.
// DRY-RUN by default. Pass --live to auth + sign + submit.
//
// ⚠ SEMANTICS (asymmetric, matches the Exchange's native u-param encoding):
//   MARKET BUY : <amount> = BILL notional to spend
//   LIMIT  BUY : <amount> = shares to buy (requires --max-price)
//
// Strategies:
//   A (default if PRIVATE_KEY set) : viem local signer, full server-API path
//   B (default if PIN + saved session) : Playwright UI automation
//   C (default if PIN only)        : CROSSx gateway remote signer, server-API path
// Force a strategy with --strategy A|B|C  or  STRATEGY=A|B|C env.
//
// Usage:
//   node scripts/buy.mjs <marketId> <UP|DOWN|YES|NO|0|1> <billAmount>
//   node scripts/buy.mjs <marketId> <outcome> <shares> --limit --max-price 0.55
//   (append --live to execute)

import { formatUnits, parseUnits } from 'viem';
import {
  apiGet, getPublicClient, KNOWN_ADDRESSES, ERC20_ABI,
} from './_chain.mjs';
import {
  assertChainId, capTrade, requireWalletAddress, printJson, fail,
} from './_guard.mjs';
import {
  buildLimitOrder, buildMarketBuyOrder, signOrder,
  submitLimitOrder, submitMarketOrder, readMinValidNonce,
} from './_order.mjs';
import { login } from './_auth.mjs';
import { ensureBillAllowance } from './_approval.mjs';
import { resolveStrategy, buildSigner } from './_strategy.mjs';

const NAME_TO_INDEX = { UP: 0, YES: 0, LONG: 0, DOWN: 1, NO: 1, SHORT: 1, '0': 0, '1': 1 };

function parseArgs(argv) {
  const out = {
    marketId: null, outcome: null, amount: null,
    maxPrice: null, limit: false, live: false, strategy: null,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-price') out.maxPrice = Number(argv[++i]);
    else if (a === '--limit') out.limit = true;
    else if (a === '--live') out.live = true;
    else if (a === '--strategy') out.strategy = String(argv[++i] ?? '').toUpperCase();
    else if (!a.startsWith('--')) pos.push(a);
  }
  out.marketId = pos[0] ?? null;
  out.outcome = (pos[1] ?? '').toUpperCase();
  out.amount = Number(pos[2] ?? NaN);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!/^[0-9a-f-]{36}$/.test(args.marketId ?? ''))
    return fail('BAD_ARG', 'marketId must be a UUID');
  const outcomeIndex = NAME_TO_INDEX[args.outcome];
  if (outcomeIndex !== 0 && outcomeIndex !== 1)
    return fail('BAD_ARG', `outcome must be one of: 0, 1, UP, DOWN, YES, NO, LONG, SHORT (got ${args.outcome || 'empty'})`);
  if (!Number.isFinite(args.amount) || args.amount <= 0)
    return fail('BAD_ARG', args.limit ? 'shares must be positive' : 'billAmount must be positive');
  if (args.limit && (args.maxPrice == null || !(args.maxPrice > 0 && args.maxPrice < 1)))
    return fail('BAD_ARG', '--limit requires --max-price in (0, 1) BILL/share');

  let walletAddress;
  try {
    walletAddress = requireWalletAddress();
    await assertChainId();
  } catch (e) { return fail('GUARD_FAIL', e.message); }

  let market;
  try { market = await apiGet(`/markets/${args.marketId}`); }
  catch (e) { return fail('API_FAIL', `market fetch: ${e.message}`); }

  if (market.status !== 'ACTIVE' || !market.tradable) {
    return fail('MARKET_CLOSED', `market status=${market.status} tradable=${market.tradable}`);
  }

  const outcome = market.outcomes.find((o) => o.outcomeIndex === outcomeIndex);
  const opposite = market.outcomes.find((o) => o.outcomeIndex === 1 - outcomeIndex);
  if (!outcome || !opposite) return fail('BAD_MARKET', 'outcomes missing expected indices');

  let orderbookSnap;
  try { orderbookSnap = await apiGet(`/markets/${args.marketId}/orderbook?outcomeIndex=${outcomeIndex}`); } catch {}
  const bestAsk = orderbookSnap?.bestAsk ? Number(orderbookSnap.bestAsk) : null;

  // Cap math differs per order type.
  const notionalBill = args.limit ? args.amount * args.maxPrice : args.amount;
  try { capTrade({ sideBill: notionalBill }); }
  catch (e) { return fail('GUARD_FAIL', e.message); }

  const requiredWei = parseUnits(notionalBill.toFixed(18).replace(/0+$/, '').replace(/\.$/, '.0'), 18);

  const pub = getPublicClient();
  const currentAllowance = await pub.readContract({
    address: KNOWN_ADDRESSES.bill, abi: ERC20_ABI, functionName: 'allowance',
    args: [walletAddress, KNOWN_ADDRESSES.exchange],
  });
  const allowanceOk = currentAllowance >= requiredWei;
  const currentBill = await pub.readContract({
    address: KNOWN_ADDRESSES.bill, abi: ERC20_ABI, functionName: 'balanceOf', args: [walletAddress],
  });
  const fundsOk = currentBill >= requiredWei;

  // Resolve which strategy WILL be used (does not require PK/PIN — just inspects env).
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
    outcome: { outcomeIndex, name: outcome.name, tokenId: outcome.tokenId, currentPrice: outcome.price, bestAsk },
    oppositeOutcome: { outcomeIndex: opposite.outcomeIndex, name: opposite.name, tokenId: opposite.tokenId },
    intent: args.limit
      ? { side: 'BUY', shares: args.amount, maxPrice: args.maxPrice, worstCaseNotionalBill: notionalBill }
      : { side: 'BUY', billToSpend: args.amount, bestAsk, estimatedShares: bestAsk ? (args.amount / bestAsk) : null },
    feePpm: market.feePpm,
    allowance: {
      currentBill: formatUnits(currentAllowance, 18).slice(0, 30),
      requiredBill: formatUnits(requiredWei, 18),
      ok: allowanceOk,
    },
    balance: { currentBill: formatUnits(currentBill, 18), fundsOk },
    maxTradeBillCap: Number(process.env.MAX_TRADE_BILL ?? '100'),
  };

  if (!args.live) {
    return printJson({ ...plan, _notice: 'DRY_RUN — no auth, no signature, no submission. Re-run with --live to execute.' });
  }

  // ──────── LIVE ────────
  if (!strategyPlan.strategy) return fail('NO_STRATEGY', strategyPlan.reason ?? 'no usable strategy');
  if (!fundsOk) return fail('INSUFFICIENT_FUNDS', `wallet has ${plan.balance.currentBill} BILL, need ${plan.allowance.requiredBill}`);

  if (strategyPlan.strategy === 'B') {
    return placeViaUI(plan, args, walletAddress);
  }
  return placeViaApi(plan, args, walletAddress, strategyPlan.strategy, {
    market, outcome, opposite, allowanceOk, requiredWei,
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
    if (!ctx.allowanceOk) {
      if (strategy === 'A') {
        approvalResult = await ensureBillAllowance(signer.walletClient, signer.account, ctx.requiredWei);
      } else {
        return fail('APPROVAL_GAP',
          'Strategy C cannot send on-chain approvals from outside the website. ' +
          'Open prediction.crossdefi.io once and execute a tiny BUY through the UI to set BILL allowance, then retry.',
        );
      }
    }

    const session = await login(signer);
    const nonce = await readMinValidNonce(signer.address);

    const order = args.limit
      ? buildLimitOrder({
          marketOutcome: { tokenId: ctx.outcome.tokenId, oppositeTokenId: ctx.opposite.tokenId },
          side: 'BUY', shares: args.amount, price: args.maxPrice,
          feePpm: ctx.market.feePpm, maker: signer.address, nonce,
        })
      : buildMarketBuyOrder({
          marketOutcome: { tokenId: ctx.outcome.tokenId, oppositeTokenId: ctx.opposite.tokenId },
          billAmount: args.amount,
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

async function placeViaUI(plan, args, walletAddress) {
  const { placeTradeUI } = await import('./_trader-ui.mjs');
  let result;
  try {
    result = await placeTradeUI({
      side: 'BUY',
      marketId: args.marketId,
      outcomeIndex: plan.outcome.outcomeIndex,
      outcomeName: plan.outcome.name,
      orderType: args.limit ? 'LIMIT' : 'MARKET',
      amount: args.amount,
      price: args.maxPrice,
      pin: process.env.PIN,
      confirm: true,
    });
  } catch (e) {
    return fail(e.code || 'UI_FAIL', e.message);
  }
  return printJson({
    ...plan,
    uiResult: result,
    _notice: 'Strategy B placed the trade via the website UI; tx hash extracted from the receipt panel if available.',
  });
}

main().catch((e) => fail('UNEXPECTED', e.message, { stack: e.stack }));
