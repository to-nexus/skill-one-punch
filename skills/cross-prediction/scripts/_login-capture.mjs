#!/usr/bin/env node
// _login-capture — one-time login + storageState persistence for Strategy B.
//
// Run this once from a desktop environment. A headful Chromium opens, you log
// in with Google/Apple and set/enter your PIN. When you return to the home
// screen logged in, press ENTER in the terminal. The session is saved to:
//   ./.auth/state.json (chmod 600)
//
// Usage:
//   node scripts/_login-capture.mjs
//
// NOTE: requires `npx playwright install chromium` first.

import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { chromium } from 'playwright';

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_PATH = resolve(SKILL_DIR, '.auth', 'state.json');
const BASE = process.env.PREDICTION_BASE_URL ?? 'https://prediction.crossdefi.io';

async function main() {
  if (!existsSync(dirname(AUTH_PATH))) {
    mkdirSync(dirname(AUTH_PATH), { recursive: true, mode: 0o700 });
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE);

  console.error(
    '\n1) Sign in with Google/Apple.' +
    '\n2) Create or enter your PIN until you return to the home screen.' +
    '\n3) Come back to this terminal and press ENTER to save the session.\n',
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  await rl.question('Press ENTER when logged in: ');
  rl.close();

  await context.storageState({ path: AUTH_PATH });
  try { chmodSync(AUTH_PATH, 0o600); } catch { /* best effort */ }
  await browser.close();

  process.stdout.write(JSON.stringify({ saved: AUTH_PATH, baseUrl: BASE }, null, 2) + '\n');
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: e.message, code: 'LOGIN_CAPTURE_FAIL' }) + '\n');
  process.exit(1);
});
