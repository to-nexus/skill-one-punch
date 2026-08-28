// _markets.mjs — market routing for punch.win.
//
// The skill used to hardcode a single API base (the BILL market). BILL and CROSS
// markets are retired: both still answer HTTP but return zero ACTIVE events, and
// the web app classifies them as redeem-only legacy. Live markets are:
//
//   usd   — real-money markets, collateral pONEUSD (Wrapped Prediction ONEUSD)
//   point — free-to-play markets, collateral POINT, with daily claim + weekly season
//
// Both speak the same REST shape and the same CTF/Exchange contract interfaces;
// only the base URL and the collateral differ. Contract addresses are NOT
// hardcoded here — they differ per market and rotate, so callers resolve them at
// runtime through loadMarketConfig().

/** SIWE origin. The service checks Origin/Referer; this must match the live app. */
export const AUTH_ORIGIN = process.env.PRED_ORIGIN ?? 'https://www.punch.win';

const MARKETS = {
  usd: {
    key: 'usd',
    label: 'USD',
    apiBase: process.env.PRED_API_USD ?? 'https://pred-usd-service-api.crossdefi.io/api/v1',
    /** Collateral ERC-20 symbol as reported by GET /config → quoteToken.symbol. */
    collateral: 'pONEUSD',
    /** Real money. Trading writes are capped and require explicit --confirm. */
    realMoney: true,
    /** No free-to-play endpoints on this base. */
    f2p: false,
  },
  point: {
    key: 'point',
    label: 'POINT',
    apiBase: process.env.PRED_API_POINT ?? 'https://point-service-api.punch.win/api/v1',
    collateral: 'POINT',
    realMoney: false,
    /** /f2p/* endpoints (claim, season) live on this base only. */
    f2p: true,
  },
};

/** Markets that still list ACTIVE events. bill/cross are intentionally absent. */
export const LIVE_MARKETS = Object.keys(MARKETS);

/** Default market for mutating commands. POINT is free, so it is the safe default. */
export const DEFAULT_WRITE_MARKET = process.env.PRED_MARKET ?? 'point';

/** Default market for read commands. */
export const DEFAULT_READ_MARKET = process.env.PRED_MARKET ?? 'usd';

export function resolveMarket(key) {
  const k = String(key ?? DEFAULT_READ_MARKET).toLowerCase();
  if (k === 'bill' || k === 'cross') {
    throw new Error(
      `market "${k}" is retired — it returns no ACTIVE events. ` +
        `Live markets: ${LIVE_MARKETS.join(', ')}. ` +
        `Legacy positions can still be redeemed in the web app.`,
    );
  }
  const m = MARKETS[k];
  if (!m) throw new Error(`unknown market "${k}". Live markets: ${LIVE_MARKETS.join(', ')}`);
  return m;
}

/**
 * Parse `--market=<key>` / `--market <key>` out of argv.
 * Returns the resolved market descriptor; falls back to `fallback`.
 */
export function marketFromArgv(argv, fallback = DEFAULT_READ_MARKET) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--market=')) return resolveMarket(a.slice('--market='.length));
    if (a === '--market') return resolveMarket(argv[i + 1]);
  }
  return resolveMarket(fallback);
}
