#!/usr/bin/env node
// redeem — redeem settled winning CTF Shares back into the market's collateral.
//
// DRY-RUN by default. Pass --live to send CTF.redeemPositions().
// Strategy A is required for live execution because redeem is an on-chain
// transaction, so it requires the local signer.
//
// Usage:
//   node scripts/redeem.mjs <marketId>
//   node scripts/redeem.mjs <marketId> --live
//   node scripts/redeem.mjs <marketId> --live --strategy A

import { formatUnits, zeroHash } from 'viem';
import {
  apiGet, getPublicClient, loadMarketConfig, ERC1155_ABI, CTF_REDEEM_ABI,
} from './_chain.mjs';
import { marketFromArgv } from './_markets.mjs';
import {
  assertChainId, requireWalletAddress, printJson, fail,
} from './_guard.mjs';
import { resolveStrategy, buildSigner } from './_strategy.mjs';

function parseArgs(argv) {
  const out = { marketId: null, live: false, strategy: null };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') out.live = true;
    else if (a === '--strategy') out.strategy = String(argv[++i] ?? '').toUpperCase();
    else if (!a.startsWith('--')) pos.push(a);
  }
  out.marketId = pos[0] ?? null;
  return out;
}

function indexSetFor(outcomeIndex) {
  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0) {
    throw new Error(`invalid outcomeIndex=${outcomeIndex}`);
  }
  return 1n << BigInt(outcomeIndex);
}

async function main() {
  let venue;
  let cfg;
  let marketReason;
  const args = parseArgs(process.argv.slice(2));
  if (!/^[0-9a-f-]{36}$/.test(args.marketId ?? '')) {
    return fail('BAD_ARG', 'marketId must be a UUID');
  }

  let walletAddress;
  try {
    walletAddress = requireWalletAddress();
    await assertChainId();
    ({ market: venue, reason: marketReason } = await marketFromArgv(process.argv.slice(2)));
    cfg = await loadMarketConfig(venue.key);

  } catch (e) {
    return fail('GUARD_FAIL', e.message);
  }

  let market;
  try {
    market = await apiGet(`/markets/${args.marketId}`, { market: venue });
  } catch (e) {
    return fail('API_FAIL', `market fetch: ${e.message}`, { status: e.status });
  }

  if (market.status !== 'REDEEMABLE') {
    return fail('NOT_REDEEMABLE', `market status=${market.status}; redeem requires REDEEMABLE`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(market.conditionId ?? '')) {
    return fail('BAD_MARKET', 'market has no valid conditionId');
  }

  const winner = (market.outcomes ?? []).find((o) => o.isWinner === true);
  if (!winner) return fail('BAD_MARKET', 'market has no winning outcome yet');
  if (!winner.tokenId) return fail('BAD_MARKET', 'winner has no tokenId');

  const indexSet = indexSetFor(winner.outcomeIndex);
  const pub = getPublicClient();
  let shareWei;
  try {
    shareWei = await pub.readContract({
      address: cfg.ctf,
      abi: ERC1155_ABI,
      functionName: 'balanceOf',
      args: [walletAddress, BigInt(winner.tokenId)],
    });
  } catch (e) {
    return fail('RPC_FAIL', `winner share balance read failed: ${e.message}`);
  }

  const plan = {
    mode: args.live ? 'LIVE' : 'DRY_RUN',
    wallet: walletAddress,
    marketId: args.marketId,
    marketTitle: `${market.event?.title ?? ''} — ${market.title}`,
    conditionId: market.conditionId,
    collateralToken: cfg.quoteToken.address,
    parentCollectionId: zeroHash,
    winningOutcome: {
      outcomeIndex: winner.outcomeIndex,
      name: winner.name,
      tokenId: winner.tokenId,
      indexSet: indexSet.toString(),
      shares: formatUnits(shareWei, 18),
      redeemableBill: formatUnits(shareWei * BigInt(winner.payoutNumerator ?? 1), 18),
    },
  };

  if (shareWei <= 0n) {
    return fail('NO_REDEEMABLE_SHARES', 'wallet holds no winning shares for this market', plan);
  }

  if (!args.live) {
    return printJson({
      ...plan,
      _notice: 'DRY_RUN — no transaction submitted. Re-run with --live to redeem.',
    });
  }

  let strategyPlan;
  try { strategyPlan = resolveStrategy({ override: args.strategy }); }
  catch (e) { return fail(e.code || 'NO_STRATEGY', e.message, { available: e.available }); }
  if (strategyPlan.strategy !== 'A') {
    return fail('STRATEGY_UNSUPPORTED',
      'redeem is an on-chain transaction and currently requires Strategy A local signer.',
      { strategy: strategyPlan.strategy, available: strategyPlan.available });
  }

  let signer;
  try { signer = await buildSigner('A'); }
  catch (e) { return fail(e.code || 'SIGNER_FAIL', e.message); }
  try {
    if (signer.address.toLowerCase() !== walletAddress.toLowerCase()) {
      return fail('ADDRESS_MISMATCH', `PRIVATE_KEY resolves to ${signer.address}, WALLET_ADDRESS is ${walletAddress}`);
    }

    const callArgs = [
      cfg.quoteToken.address,
      zeroHash,
      market.conditionId,
      [indexSet],
    ];

    let simulation;
    try {
      simulation = await pub.simulateContract({
        account: signer.account,
        address: cfg.ctf,
        abi: CTF_REDEEM_ABI,
        functionName: 'redeemPositions',
        args: callArgs,
      });
    } catch (e) {
      return fail('SIMULATION_FAIL', e.shortMessage || e.message, plan);
    }

    const hash = await signer.walletClient.writeContract(simulation.request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return printJson({
      ...plan,
      strategy: strategyPlan.strategy,
      strategyReason: strategyPlan.reason,
      txHash: hash,
      receipt: {
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
      },
    });
  } finally {
    try { await signer?.close(); } catch {}
  }
}

main().catch((e) => fail('UNEXPECTED', e.message));
