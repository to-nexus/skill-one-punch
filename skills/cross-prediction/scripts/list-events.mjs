#!/usr/bin/env node
// list-events — search active / closed prediction events.
//
// Uses the public REST API at prediction-service-api.crossdefi.io (no auth needed).
//
// Usage:
//   node scripts/list-events.mjs
//   node scripts/list-events.mjs --status ACTIVE --limit 20 --query BTC --category CRYPTO

import { apiGet } from './_chain.mjs';
import { printJson, fail } from './_guard.mjs';

function parseArgs(argv) {
  const out = { status: 'ACTIVE', limit: 20, query: null, category: null, page: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status') out.status = argv[++i].toUpperCase();
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--page') out.page = Number(argv[++i]);
    else if (a === '--query') out.query = argv[++i];
    else if (a === '--category') out.category = argv[++i].toUpperCase();
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const params = new URLSearchParams();
  params.set('status', args.status);
  params.set('limit', String(args.limit));
  params.set('page', String(args.page));
  if (args.category) params.set('category', args.category);

  let data;
  try {
    data = await apiGet(`/events?${params}`);
  } catch (e) {
    return fail('API_FAIL', e.message, { status: e.status, body: e.body });
  }

  // Client-side text filter — the API has no query param we've confirmed.
  const items = (data?.items ?? []).filter((ev) => {
    if (!args.query) return true;
    const q = args.query.toLowerCase();
    return (
      (ev.title ?? '').toLowerCase().includes(q) ||
      (ev.description ?? '').toLowerCase().includes(q) ||
      (ev.category ?? '').toLowerCase().includes(q)
    );
  });

  const trimmed = items.slice(0, args.limit).map((ev) => ({
    eventId: ev.id,
    title: ev.title,
    category: ev.category,
    eventType: ev.eventType,
    status: ev.status,
    marketCount: ev.marketCount,
    volume: ev.volume,
    firstMarket: ev.markets?.[0] && {
      marketId: ev.markets[0].id,
      status: ev.markets[0].status,
      oracleSymbol: ev.markets[0].oracleSymbol,
      basePrice: ev.markets[0].basePrice,
      closingAt: ev.markets[0].closingAt,
      outcomes: ev.markets[0].outcomes?.map((o) => ({
        outcomeIndex: o.outcomeIndex,
        name: o.name,
        price: o.price,
      })),
    },
  }));

  printJson({
    count: trimmed.length,
    totalMatched: items.length,
    filters: args,
    pagination: data?.pagination,
    events: trimmed,
  });
}

main().catch((e) => fail('UNEXPECTED', e.message, { stack: e.stack }));
