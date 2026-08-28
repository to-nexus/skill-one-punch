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

/**
 * Default market when the caller does not pass --market.
 *
 * Resolution is dynamic, not a constant: POINT markets only exist while an F2P
 * season is running. Between seasons the POINT base returns zero events in every
 * status, so defaulting to POINT unconditionally would hand a first-time user an
 * empty market. autoMarket() prefers POINT while a season is live and falls back
 * to USD during the gap.
 */
export const DEFAULT_WRITE_MARKET = 'auto';
export const DEFAULT_READ_MARKET = 'auto';

/** Cached season probe so a single command does not re-query per call. */
let seasonProbe;

/**
 * Is an F2P season currently open? Determines whether POINT markets exist.
 * Network failures resolve to false so trading degrades to USD rather than
 * dead-ending on an empty POINT market.
 */
export async function isSeasonActive() {
  if (seasonProbe !== undefined) return seasonProbe;
  try {
    const res = await fetch(MARKETS.point.apiBase + '/f2p/summary', {
      headers: { accept: 'application/json', origin: AUTH_ORIGIN },
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json();
    const d = body?.data ?? body;
    seasonProbe = d?.seasonActive === true || d?.state === 'ACTIVE';
  } catch {
    seasonProbe = false;
  }
  return seasonProbe;
}

/**
 * Pick the market to act on when the user did not specify one:
 * POINT while a season is live (free), otherwise USD.
 * Returns { market, reason } so commands can explain the choice.
 */
export async function autoMarket() {
  const active = await isSeasonActive();
  return active
    ? { market: MARKETS.point, reason: 'F2P season is live — defaulting to the free POINT market' }
    : {
        market: MARKETS.usd,
        reason:
          'no F2P season is running, so POINT markets have no events — defaulting to the USD market (real money, pONEUSD)',
      };
}

export function resolveMarket(key) {
  const k = String(key ?? 'usd').toLowerCase();
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
/** Read an explicit --market=<key> / --market <key> from argv, or null. */
export function explicitMarketFromArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--market=')) return resolveMarket(a.slice('--market='.length));
    if (a === '--market') return resolveMarket(argv[i + 1]);
  }
  if (process.env.PRED_MARKET) return resolveMarket(process.env.PRED_MARKET);
  return null;
}

/**
 * Resolve the market for a command: an explicit --market wins, otherwise the
 * season-aware automatic choice. Async because the auto path probes the season.
 * Returns { market, reason, explicit }.
 */
export async function marketFromArgv(argv) {
  const explicit = explicitMarketFromArgv(argv);
  if (explicit) return { market: explicit, reason: null, explicit: true };
  const { market, reason } = await autoMarket();
  return { market, reason, explicit: false };
}
