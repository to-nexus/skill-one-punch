#!/usr/bin/env node
// get-results — inspect settled (REDEEMABLE) markets and, if --only-mine,
// cross-reference with on-chain CTF Share balances to compute user-level PnL.
//
// The public endpoint returns every outcome's isWinner / payoutNumerator,
// so market-level results work without auth. Per-user PnL uses on-chain
// CTF.balanceOf(address, tokenId) — also no login required.
//
// Full per-user trading history (entry price, fees) still needs the authed
// /portfolio/trades endpoint — flagged in output when --only-mine is set.
//
// Usage:
//   node scripts/get-results.mjs <eventId>
//   node scripts/get-results.mjs <eventId> --only-mine
//   node scripts/get-results.mjs <eventId> --limit 20

import { formatUnits } from 'viem';
import {
  apiGet, getPublicClient, loadMarketConfig, ERC1155_ABI,
} from './_chain.mjs';
import { marketFromArgv } from './_markets.mjs';
import { printJson, fail } from './_guard.mjs';

function parseArgs(argv) {
  const out = { eventId: null, onlyMine: false, limit: 20 };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only-mine') out.onlyMine = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (!a.startsWith('--')) pos.push(a);
  }
  out.eventId = pos[0] ?? null;
  return out;
}

async function main() {
  let venue;
  let cfg;
  ({ market: venue, reason: marketReason } = await marketFromArgv(process.argv.slice(2)));
  cfg = await loadMarketConfig(venue.key);
  const { eventId, onlyMine, limit } = parseArgs(process.argv.slice(2));
  if (!/^[0-9a-f-]{36}$/.test(eventId ?? '')) {
    return fail('BAD_ARG', 'eventId required (UUID)');
  }

  const walletAddress = onlyMine ? process.env.WALLET_ADDRESS : null;
  if (onlyMine && !/^0x[0-9a-fA-F]{40}$/.test(walletAddress ?? '')) {
    return fail('GUARD_FAIL', '--only-mine requires WALLET_ADDRESS in env');
  }

  let page;
  try {
    page = await apiGet(`/events/${eventId}/markets?status=REDEEMABLE&limit=${limit}`, { market: venue });
  } catch (e) {
    return fail('API_FAIL', e.message, { status: e.status });
  }
  const markets = page?.items ?? [];

  // If only-mine, fetch the caller's CTF balance for every outcome across all markets
  // in a single batched call.
  let myShareByTokenId = new Map();
  if (onlyMine && markets.length) {
    const allTokenIds = markets.flatMap((m) => (m.outcomes ?? []).map((o) => o.tokenId));
    const accounts = allTokenIds.map(() => walletAddress);
    const client = getPublicClient();
    try {
      const balances = await client.readContract({
        address: cfg.ctf,
        abi: ERC1155_ABI,
        functionName: 'balanceOfBatch',
        args: [accounts, allTokenIds.map((id) => BigInt(id))],
      });
      allTokenIds.forEach((id, i) => myShareByTokenId.set(id.toLowerCase(), balances[i]));
    } catch (e) {
      // best-effort — don't abort the read command just because one RPC call failed
      myShareByTokenId.set('_error', e.message);
    }
  }

  const results = markets.map((m) => {
    const outcomes = (m.outcomes ?? []).map((o) => {
      const myShares = onlyMine
        ? myShareByTokenId.get(o.tokenId?.toLowerCase())
        : undefined;
      const myRedeemableBill =
        onlyMine && o.isWinner && typeof myShares === 'bigint' && o.payoutNumerator
          ? formatUnits(myShares * BigInt(o.payoutNumerator), 18)
          : undefined;
      return {
        outcomeIndex: o.outcomeIndex,
        name: o.name,
        isWinner: o.isWinner,
        payoutNumerator: o.payoutNumerator,
        finalPrice: o.price,
        ...(onlyMine && {
          myShares: typeof myShares === 'bigint' ? formatUnits(myShares, 18) : '0',
          myRedeemableBill,
        }),
      };
    });
    return {
      marketId: m.id,
      title: m.title,
      status: m.status,
      oracleSymbol: m.oracleSymbol,
      basePrice: m.basePrice,
      endedPrice: m.endedPrice,
      closingAt: m.closingAt,
      conditionId: m.conditionId,
      outcomes,
    };
  });

  printJson({
    market: venue.key,
    _marketNote: marketReason ?? undefined,
    eventId,
    onlyMine,
    walletAddress: onlyMine ? walletAddress : undefined,
    pagination: page?.pagination,
    _notes: [
      'Market-level results (isWinner, payoutNumerator) come from public API and are final once REDEEMABLE.',
      onlyMine
        ? 'myShares is the on-chain CTF balance. Entry price / fees / realized PnL require /portfolio/trades (auth).'
        : 'Add --only-mine to also report your CTF Share balances per outcome.',
    ],
    results,
  });
}

main().catch((e) => fail('UNEXPECTED', e.message));
