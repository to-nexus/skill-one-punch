#!/usr/bin/env node
// balance — show CROSS gas + BILL balance + (optionally) CTF Share balances
// for every active/redeemable market the wallet is involved in.
//
// All on-chain reads; no auth. Uses GET /events to discover tokenIds, then
// CTF.balanceOfBatch to enumerate the wallet's Shares.
//
// Usage:
//   node scripts/balance.mjs                     # CROSS + BILL only (fast)
//   node scripts/balance.mjs --with-shares       # also fetch Share positions (slower)

import { formatUnits } from 'viem';
import {
  getPublicClient, apiGet,
  KNOWN_ADDRESSES, ERC20_ABI, ERC1155_ABI,
} from './_chain.mjs';
import { requireWalletAddress, assertChainId, printJson, fail } from './_guard.mjs';

function parseArgs(argv) {
  const out = {
    withShares: false,
    includeRedeemable: false,
    redeemableLimit: 20,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--with-shares') out.withShares = true;
    else if (a === '--include-redeemable') out.includeRedeemable = true;
    else if (a === '--redeemable-limit') out.redeemableLimit = Number(argv[++i]);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let address;
  try {
    address = requireWalletAddress();
    await assertChainId();
  } catch (e) {
    return fail('GUARD_FAIL', e.message);
  }

  const client = getPublicClient();
  const [crossWei, billWei] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: KNOWN_ADDRESSES.bill,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
    }),
  ]);

  let positions = [];
  let positionsNote;
  if (args.withShares) {
    try {
      // Walk ACTIVE events → their ACTIVE markets (always). Optionally also
      // scan the most recent REDEEMABLE markets per event (there are tens of
      // thousands of historical ones, so we cap per-event and per-run).
      const events = (await apiGet('/events?status=ACTIVE&limit=100'))?.items ?? [];
      const discovered = [];
      for (const ev of events) {
        const statuses = args.includeRedeemable ? ['ACTIVE', 'REDEEMABLE'] : ['ACTIVE'];
        for (const status of statuses) {
          const lim = status === 'REDEEMABLE' ? args.redeemableLimit : 50;
          const page = await apiGet(
            `/events/${ev.id}/markets?status=${status}&limit=${lim}`,
          );
          for (const m of page?.items ?? []) {
            for (const o of m.outcomes ?? []) {
              discovered.push({
                eventId: ev.id,
                eventTitle: ev.title,
                marketId: m.id,
                marketStatus: m.status,
                outcomeIndex: o.outcomeIndex,
                outcomeName: o.name,
                tokenId: o.tokenId,
                price: o.price,
                isWinner: o.isWinner,
                payoutNumerator: o.payoutNumerator,
              });
            }
          }
        }
      }

      if (discovered.length) {
        // Chunk balanceOfBatch to avoid pathological call sizes.
        const CHUNK = 250;
        const balances = [];
        for (let i = 0; i < discovered.length; i += CHUNK) {
          const chunk = discovered.slice(i, i + CHUNK);
          const res = await client.readContract({
            address: KNOWN_ADDRESSES.ctf,
            abi: ERC1155_ABI,
            functionName: 'balanceOfBatch',
            args: [chunk.map(() => address), chunk.map((d) => BigInt(d.tokenId))],
          });
          balances.push(...res);
        }
        positions = discovered
          .map((d, i) => ({ ...d, sharesWei: balances[i] }))
          .filter((p) => p.sharesWei > 0n)
          .map((p) => ({
            eventId: p.eventId,
            eventTitle: p.eventTitle,
            marketId: p.marketId,
            marketStatus: p.marketStatus,
            outcomeIndex: p.outcomeIndex,
            outcomeName: p.outcomeName,
            shares: formatUnits(p.sharesWei, 18),
            markPrice: p.price,
            isWinner: p.isWinner,
            // If market is REDEEMABLE and this outcome won, shares redeem 1:1 to BILL.
            redeemableBill: p.isWinner === true && p.payoutNumerator
              ? formatUnits(p.sharesWei * BigInt(p.payoutNumerator), 18)
              : undefined,
          }));
      }
    } catch (e) {
      positionsNote = `positions scan failed: ${e.message}`;
    }
  } else {
    positionsNote = 'positions omitted — pass --with-shares to include them (slower, uses API + CTF batch read)';
  }

  printJson({
    address,
    chainId: 612055,
    crossBalance: formatUnits(crossWei, 18),
    billBalance: formatUnits(billWei, 18),
    positions,
    _note: positionsNote,
  });
}

main().catch((e) => fail('UNEXPECTED', e.message));
