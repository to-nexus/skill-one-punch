// _trader-ui.mjs — Strategy B trader (Playwright UI automation).
//
// Different shape from A/C. Instead of signing locally and POSTing to the API,
// we drive the website itself: navigate → click Buy/Sell → fill form → submit
// → enter PIN in the modal → wait for the tx hash to appear.
//
// Selector strategy
// ─────────────────
// We don't ship hard-coded CSS selectors because the production HTML is shipped
// as hashed class names. Instead, we resolve elements via Playwright's
// accessibility-first locators (`getByRole`, `getByLabel`, `getByText`),
// optionally overridden by `~/.claude/skills/cross-prediction/.session/selectors.json`
// (produced by `_recon-selectors.mjs`).
//
// If a step can't find its element after all candidates are exhausted, we throw
// `SELECTOR_NOT_FOUND` with the candidate list — never click something at random.

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE_PATH = resolve(SKILL_DIR, '.auth', 'state.json');
const SELECTORS_PATH = resolve(SKILL_DIR, '.session', 'selectors.json');
const PRED_BASE = process.env.PREDICTION_BASE_URL ?? 'https://prediction.crossdefi.io';

// Default candidate locators per logical step. Tried in order.
// Each entry is one of:
//   { role, name }      → page.getByRole(role, { name }) — preferred (a11y)
//   { label }           → page.getByLabel(label)
//   { text }            → page.getByText(text, { exact: false })
//   { testId }          → page.getByTestId(testId)
//   { css }             → page.locator(css) — last resort
const DEFAULT_CANDIDATES = Object.freeze({
  buyTab:        [{ role: 'tab',    name: /^buy$/i },        { role: 'button', name: /^buy$/i }],
  sellTab:       [{ role: 'tab',    name: /^sell$/i },       { role: 'button', name: /^sell$/i }],
  outcomeUp:     [{ role: 'button', name: /^(up|yes|long)$/i }],
  outcomeDown:   [{ role: 'button', name: /^(down|no|short)$/i }],
  marketOrderTab:[{ role: 'tab',    name: /market/i }],
  limitOrderTab: [{ role: 'tab',    name: /limit/i }],
  amountInput:   [{ label: /amount|quantity|shares/i }, { role: 'spinbutton' }, { role: 'textbox', name: /amount|quantity|shares/i }],
  priceInput:    [{ label: /price|limit/i },             { role: 'textbox', name: /price/i }],
  reviewButton:  [{ role: 'button', name: /^(review|preview|confirm)$/i }],
  submitButton:  [{ role: 'button', name: /^(buy|sell|place|confirm|submit)$/i }],
  pinInput:      [{ label: /pin/i }, { role: 'textbox', name: /pin/i }, { css: 'input[type="password"]' }],
  txExplorerLink:[{ css: 'a[href*="explorer.crosstoken.io/612055/tx/"]' }],
});

function loadOverrides() {
  if (!existsSync(SELECTORS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SELECTORS_PATH, 'utf8')) ?? {};
  } catch (e) {
    throw new Error(`selectors.json parse failed: ${e.message}`);
  }
}

async function findFirst(page, candidates, { timeoutMs = 4000 } = {}) {
  for (const c of candidates) {
    let loc;
    if (c.role)   loc = page.getByRole(c.role, { name: c.name });
    else if (c.label) loc = page.getByLabel(c.label);
    else if (c.text)  loc = page.getByText(c.text, { exact: false });
    else if (c.testId) loc = page.getByTestId(c.testId);
    else if (c.css)   loc = page.locator(c.css);
    else continue;
    try {
      await loc.first().waitFor({ state: 'visible', timeout: timeoutMs });
      return loc.first();
    } catch { /* try next candidate */ }
  }
  const err = new Error(`SELECTOR_NOT_FOUND: none of ${JSON.stringify(candidates)} matched`);
  err.code = 'SELECTOR_NOT_FOUND';
  err.candidates = candidates;
  throw err;
}

async function openAuthedContext({ headful = false } = {}) {
  if (!existsSync(STORAGE_PATH)) {
    const e = new Error(`No saved session at ${STORAGE_PATH}. Run \`node scripts/_login-capture.mjs\` once first.`);
    e.code = 'NO_STORAGE_STATE';
    throw e;
  }
  const browser = await chromium.launch({ headless: !headful });
  const context = await browser.newContext({
    storageState: STORAGE_PATH,
    viewport: { width: 1280, height: 900 },
  });
  return { browser, context };
}

/**
 * Place a trade via the website UI.
 *
 *  opts: {
 *    side:        "BUY" | "SELL"
 *    marketId:    UUID
 *    outcomeIndex: 0 | 1
 *    outcomeName: "UP" | "DOWN" | "YES" | "NO" (for selector fallback)
 *    orderType:   "MARKET" | "LIMIT"
 *    amount:      number  (BUY+MARKET → BILL; otherwise → shares)
 *    price?:      number  (LIMIT only — 0 < p < 1)
 *    pin:         "\d{6}"
 *    confirm:     boolean (must be true to actually submit)
 *  }
 *
 * Returns { txHash?, raw, durationMs }.
 */
export async function placeTradeUI(opts) {
  if (!/^\d{6}$/.test(opts.pin ?? '')) throw new Error('PIN must be 6 digits');
  if (!opts.confirm) {
    return { _notice: 'DRY_RUN — Strategy B did not open a browser. Pass --live to actually drive the UI.' };
  }
  const t0 = Date.now();
  const overrides = loadOverrides();
  const candidates = (key) => (overrides[key] ?? DEFAULT_CANDIDATES[key]);

  const { browser, context } = await openAuthedContext({ headful: process.env.PW_HEADFUL === '1' });
  try {
    const page = await context.newPage();
    await page.goto(`${PRED_BASE}/markets/${opts.marketId}`, { waitUntil: 'domcontentloaded' });

    // 1. Pick BUY or SELL panel.
    const tab = await findFirst(page, candidates(opts.side === 'BUY' ? 'buyTab' : 'sellTab'));
    await tab.click();

    // 2. Pick the outcome.
    const outcomeKey = opts.outcomeIndex === 0 ? 'outcomeUp' : 'outcomeDown';
    try {
      const out = await findFirst(page, candidates(outcomeKey), { timeoutMs: 2000 });
      await out.click();
    } catch {
      // Some markets render the outcomes as a single segmented control where the
      // outcome name is the actual text — try a free-form text match as fallback.
      const free = page.getByText(new RegExp(`^${opts.outcomeName}$`, 'i')).first();
      await free.click({ timeout: 2000 }).catch(() => { throw new Error(`could not select outcome ${opts.outcomeName}`); });
    }

    // 3. Order type tab (MARKET/LIMIT).
    const orderKey = opts.orderType === 'LIMIT' ? 'limitOrderTab' : 'marketOrderTab';
    try {
      const otab = await findFirst(page, candidates(orderKey), { timeoutMs: 1500 });
      await otab.click();
    } catch { /* page may default to MARKET with no tab — proceed */ }

    // 4. Fill amount.
    const amountInput = await findFirst(page, candidates('amountInput'));
    await amountInput.fill(String(opts.amount));

    // 5. (LIMIT only) fill price.
    if (opts.orderType === 'LIMIT') {
      const priceInput = await findFirst(page, candidates('priceInput'));
      await priceInput.fill(String(opts.price));
    }

    // 6. Review (some flows have a separate Review step before Submit).
    try {
      const review = await findFirst(page, candidates('reviewButton'), { timeoutMs: 1500 });
      await review.click();
    } catch { /* no separate review step */ }

    // 7. Submit.
    const submit = await findFirst(page, candidates('submitButton'));
    await submit.click();

    // 8. PIN modal.
    const pinInput = await findFirst(page, candidates('pinInput'), { timeoutMs: 10_000 });
    await pinInput.fill(opts.pin);
    // PIN modals usually auto-submit on the 6th digit, but click a confirm if present.
    try {
      const confirm = await findFirst(page, candidates('submitButton'), { timeoutMs: 1500 });
      await confirm.click();
    } catch { /* auto-submitted */ }

    // 9. Wait for tx hash link in the result toast / receipt panel.
    let txHash = null;
    try {
      const link = await findFirst(page, candidates('txExplorerLink'), { timeoutMs: 60_000 });
      const href = await link.getAttribute('href');
      const m = href?.match(/0x[a-fA-F0-9]{64}/);
      if (m) txHash = m[0];
    } catch { /* receipt panel may render differently — caller can poll the API */ }

    return { txHash, durationMs: Date.now() - t0, raw: { url: page.url() } };
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}
