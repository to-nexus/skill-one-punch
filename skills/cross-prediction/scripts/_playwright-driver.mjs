// _playwright-driver.mjs — kept for backwards compatibility.
//
// Strategy B's runtime now lives in `_trader-ui.mjs`. This file re-exports the
// shared context opener so older imports keep working. New code should import
// from `_trader-ui.mjs` directly.

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_PATH = resolve(SKILL_DIR, '.auth', 'state.json');

export async function openAuthedContext({ headful } = {}) {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(
      `No saved session at ${AUTH_PATH}. Run \`node scripts/_login-capture.mjs\` once first.`,
    );
  }
  const browser = await chromium.launch({
    headless: !(headful ?? process.env.PW_HEADFUL === '1'),
  });
  const context = await browser.newContext({ storageState: AUTH_PATH });
  return { browser, context };
}

export async function closeContext(browser) {
  try { await browser.close(); } catch { /* ignore */ }
}

export { placeTradeUI } from './_trader-ui.mjs';
