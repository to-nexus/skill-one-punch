#!/usr/bin/env node
// get-event — full detail for a single event (all markets + orderbook per outcome).
//
// Usage:
//   node scripts/get-event.mjs <eventId>
//   node scripts/get-event.mjs <eventId> --marketId <marketId>
//   node scripts/get-event.mjs <eventId> --status REDEEMABLE   # inspect settled markets

import { apiGet } from './_chain.mjs';
import { printJson, fail } from './_guard.mjs';

function parseArgs(argv) {
  const out = { eventId: null, marketId: null, status: 'ACTIVE', withOrderbook: true };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--marketId') out.marketId = argv[++i];
    else if (a === '--status') out.status = argv[++i].toUpperCase();
    else if (a === '--no-orderbook') out.withOrderbook = false;
    else if (!a.startsWith('--')) pos.push(a);
  }
  out.eventId = pos[0] ?? null;
  return out;
}

async function main() {
  const { eventId, marketId, status, withOrderbook } = parseArgs(process.argv.slice(2));
  if (!/^[0-9a-f-]{36}$/.test(eventId ?? '')) {
    return fail('BAD_ARG', 'eventId required (UUID)');
  }

  let event;
  try {
    event = await apiGet(`/events/${eventId}`);
  } catch (e) {
    return fail('API_FAIL', `event fetch: ${e.message}`, { status: e.status });
  }

  // Always fetch markets (detail endpoint sometimes excludes some statuses).
  let markets = [];
  try {
    const m = await apiGet(`/events/${eventId}/markets?status=${encodeURIComponent(status)}&limit=50`);
    markets = m?.items ?? [];
  } catch (e) {
    markets = event.markets ?? [];
  }

  if (marketId) {
    markets = markets.filter((m) => m.id === marketId);
    if (!markets.length) {
      // single-market fallback
      try { markets = [await apiGet(`/markets/${marketId}`)]; } catch { /* empty */ }
    }
  }

  // Hydrate orderbooks in parallel (public endpoint).
  if (withOrderbook) {
    await Promise.all(
      markets.map(async (m) => {
        if (m.status !== 'ACTIVE') return;
        m._orderbook = {};
        await Promise.all(
          (m.outcomes ?? []).map(async (o) => {
            try {
              const ob = await apiGet(
                `/markets/${m.id}/orderbook?outcomeIndex=${o.outcomeIndex}`,
              );
              m._orderbook[o.outcomeIndex] = {
                bestBid: ob?.bestBid,
                bestAsk: ob?.bestAsk,
                spread: ob?.spread,
                lastTradedPrice: ob?.lastTradedPrice,
                topBids: (ob?.bids ?? []).slice(0, 3),
                topAsks: (ob?.asks ?? []).slice(0, 3),
              };
            } catch { /* ignore per-outcome failures */ }
          }),
        );
      }),
    );
  }

  const out = {
    eventId: event.id,
    title: event.title,
    category: event.category,
    eventType: event.eventType,
    status: event.status,
    volume: event.volume,
    marketCount: event.marketCount,
    markets: markets.map((m) => ({
      marketId: m.id,
      title: m.title,
      status: m.status,
      tradable: m.tradable,
      oracleSymbol: m.oracleSymbol,
      basePrice: m.basePrice,
      endedPrice: m.endedPrice,
      volume: m.volume,
      startAt: m.startAt,
      closingAt: m.closingAt,
      conditionId: m.conditionId,
      outcomes: (m.outcomes ?? []).map((o) => ({
        outcomeIndex: o.outcomeIndex,
        name: o.name,
        price: o.price,
        tokenId: o.tokenId,
        isWinner: o.isWinner,
        payoutNumerator: o.payoutNumerator,
      })),
      orderbook: m._orderbook,
    })),
  };

  printJson(out);
}

main().catch((e) => fail('UNEXPECTED', e.message, { stack: e.stack }));
