// _strategy.mjs — resolve the execution strategy.
//
// The skill executes through ONE path: a local viem signer holding PRIVATE_KEY.
// This is deliberate. The full product loop — buy, sell, redeem, enterSeason,
// claim — ends in on-chain transactions, and only a local key can submit them.
//
// The CROSSx gateway signer was removed: it exposes signMessage/signTypedData
// but cannot send transactions, so it could never finish a claim or a redeem.
// Accounts created with Google/Apple social login live in a CROSSx embedded
// wallet and do not expose their key, so they cannot drive this skill. Use a
// dedicated wallet whose key you hold.

function hasPrivateKey() {
  const v = process.env.PRIVATE_KEY;
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
}

const NO_KEY_MESSAGE = [
  'No PRIVATE_KEY found. This skill signs and submits transactions locally, so it needs a key you hold.',
  '',
  'Set it up:',
  '  1. Create or pick a dedicated wallet (do not reuse a high-value one).',
  '  2. Fund it with a little CROSS for gas.',
  '  3. Put the key in the skill .env:',
  '       PRIVATE_KEY=0x<64 hex>',
  '       WALLET_ADDRESS=0x<that wallet>',
  '     chmod 600 the file. Never paste the key into chat or a command argument.',
  '',
  'Note: an account created on punch.win with Google or Apple login uses a CROSSx',
  'embedded wallet that does not expose its private key, so it cannot be used here.',
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

  if (!hasPrivateKey()) {
    const e = new Error(NO_KEY_MESSAGE);
    e.code = 'NO_STRATEGY';
    throw e;
  }

  return { strategy: 'A', reason: 'local viem signer (PRIVATE_KEY)' };
}

/** Build the local signer. */
export async function buildSigner(strategy = 'A') {
  if (strategy !== 'A') throw new Error(`buildSigner: unsupported strategy ${strategy}`);
  const { createViemSigner } = await import('./_signer-a-viem.mjs');
  return createViemSigner(process.env.PRIVATE_KEY);
}
