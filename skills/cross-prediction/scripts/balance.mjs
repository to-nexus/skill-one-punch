#!/usr/bin/env node
// balance — show CROSS gas + the market's collateral balance + (optionally)
// CTF Share positions for every active/redeemable market the wallet is in.
//
// Collateral depends on the market:
//   --market=usd    → pONEUSD (Wrapped Prediction ONEUSD), real money
//   --market=point  → POINT, free-to-play
//
// All on-chain reads; no auth. Contract addresses come from GET /config at
// runtime, so this keeps working when they rotate.
//
// Usage:
//   node scripts/balance.mjs --market=usd                    # CROSS + pONEUSD
//   node scripts/balance.mjs --market=point --with-shares    # also Share positions

import { formatUnits } from 'viem';
import { getPublicClient, apiGet, loadMarketConfig, ERC20_ABI, ERC1155_ABI } from './_chain.mjs';
import { marketFromArgv, DEFAULT_READ_MARKET } from './_markets.mjs';
import { requireWalletAddress, assertChainId, printJson, fail } from './_guard.mjs';

function parseArgs(argv) {
  const out = { withShares: false, includeRedeemable: false, redeemableLimit: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--with-shares') out.withShares = true;
    else if (a === '--include-redeemable') out.includeRedeemable = true;
    else if (a === '--redeemable-limit') out.redeemableLimit = Number(argv[++i]);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  let address;
  let market;
  try {
    market = marketFromArgv(argv, DEFAULT_READ_MARKET);
    address = requireWalletAddress();
    await assertChainId();
  } catch (e) {
    return fail('GUARD_FAIL', e.message);
  }

  const cfg = await loadMarketConfig(market.key);
  const collateralDecimals = cfg.quoteToken?.decimals ?? 18;
  const collateralSymbol = cfg.quoteToken?.symbol ?? market.collateral;

  const client = getPublicClient();
  const [crossWei, collateralWei] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: cfg.quoteToken.address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
    }),
  ]);

  let positions = [];
  let positionsNote;
  if (args.withShares) {
    try {
      const events = (await apiGet('/events?status=ACTIVE&limit=100', { market }))?.items ?? [];
      const discovered = [];
      for (const ev of events) {
        const statuses = args.includeRedeemable ? ['ACTIVE', 'REDEEMABLE'] : ['ACTIVE'];
        for (const status of statuses) {
          const lim = status === 'REDEEMABLE' ? args.redeemableLimit : 50;
          const page = await apiGet(`/events/${ev.id}/markets?status=${status}&limit=${lim}`, { market });
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
        const CHUNK = 250;
        const balances = [];
        for (let i = 0; i < discovered.length; i += CHUNK) {
          const chunk = discovered.slice(i, i + CHUNK);
          const res = await client.readContract({
            address: cfg.ctf,
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
            // A winning Share in a REDEEMABLE market redeems 1:1 into the collateral.
            redeemableCollateral:
              p.isWinner === true && p.payoutNumerator
                ? formatUnits(p.sharesWei * BigInt(p.payoutNumerator), collateralDecimals)
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
    market: market.key,
    gasBalanceCROSS: formatUnits(crossWei, 18),
    collateralSymbol,
    collateralBalance: formatUnits(collateralWei, collateralDecimals),
    positions,
    _note: positionsNote,
  });
}

main().catch((e) => fail('UNEXPECTED', e.message));
