// _strategy.mjs — resolve the execution strategy.
//
// The skill executes through ONE path: a local viem signer holding PRIVATE_KEY.
// This is deliberate. The full product loop — buy, sell, redeem, enterSeason,
// claim — ends in on-chain transactions, and only a local key can submit them.
//
// The CROSSx gateway signer was removed: it exposes signMessage/signTypedData
// but cannot send transactions, so it could never finish a claim or a redeem.
// Accounts created with Google/Apple social login live in a CROSSx embedded
// wallet whose key can be exported from the CROSSx app, so they can be used.
// Prefer a dedicated wallet anyway: an exported key carries full authority with
// no spend cap and no revocation.

import { walletCount, accountAt, walletSelectionFromArgv } from './_wallets.mjs';

function hasSigningConfig() {
  try {
    return walletCount() > 0;
  } catch {
    return false;
  }
}

const NO_KEY_MESSAGE = [
  'No signing config found. This skill signs and submits transactions locally.',
  '',
  'Set it up:',
  '  1. Create or pick a dedicated wallet (do not reuse a high-value one).',
  '  2. Fund it with a little CROSS for gas.',
  '  3. Put it in the skill .env — either form works:',
  '       PRIVATE_KEY=0x<64 hex>                 # one wallet',
  '       MNEMONIC="word word ..."  WALLET_COUNT=5   # many, derived at m/44\'/60\'/0\'/0/N',
  '       WALLET_ADDRESS=0x<wallet 0>',
  '     chmod 600 the file. Never paste the key into chat or a command argument.',
  '',
  'Using a Google/Apple punch.win account? Its CROSSx embedded wallet key can be',
  'exported from the CROSSx app. Prefer moving only what you need into a dedicated',
  'wallet instead — an exported key has full authority and cannot be revoked.',
].join('\n');

/**
 * Resolve the strategy. Kept as a function (rather than inlining) so command
 * scripts keep a single, uniform failure path.
 *
 *  override: explicit value from --strategy=… . Only "A" is accepted.
 *  Returns:  { strategy: 'A', reason }
 *  Throws:   { code } on any unusable configuration.
 */
export function resolveStrategy({ override } = {}) {
  const requested = (override ?? process.env.STRATEGY ?? 'A').toUpperCase();

  if (requested === 'B' || requested === 'C') {
    const e = new Error(
      requested === 'C'
        ? 'Strategy C (CROSSx gateway) was removed: the gateway signs payloads but cannot submit ' +
          'on-chain transactions, so it cannot complete buy, sell, redeem, enterSeason, or claim. ' +
          'Use a local signer (Strategy A).'
        : 'Strategy B (browser session reuse) is not an allowed execution path. Use a local signer (Strategy A).',
    );
    e.code = 'STRATEGY_REMOVED';
    throw e;
  }

  if (requested !== 'A' && requested !== 'AUTO') {
    const e = new Error(`Unknown STRATEGY=${requested}. The only supported strategy is A (local signer).`);
    e.code = 'BAD_STRATEGY';
    throw e;
  }

  if (!hasSigningConfig()) {
    const e = new Error(NO_KEY_MESSAGE);
    e.code = 'NO_STRATEGY';
    throw e;
  }

  return { strategy: 'A', reason: 'local viem signer (PRIVATE_KEY)' };
}

/**
 * Build the local signer for a wallet index.
 * Index comes from --wallet=<n> / WALLET_INDEX, defaulting to 0.
 */
export async function buildSigner(strategy = 'A', { index } = {}) {
  if (strategy !== 'A') throw new Error(`buildSigner: unsupported strategy ${strategy}`);
  const i = index ?? walletSelectionFromArgv(process.argv.slice(2)).index;
  const { createViemSignerFromAccount } = await import('./_signer-a-viem.mjs');
  return createViemSignerFromAccount(accountAt(i), i);
}
