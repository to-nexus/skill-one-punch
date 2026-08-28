// _wallets.mjs — one seed, many wallets.
//
// Two ways to configure the signer set:
//
//   MNEMONIC     — a BIP-39 phrase. Wallets are derived at m/44'/60'/0'/0/N.
//                  Preferred: you store one secret instead of N, and every
//                  wallet is provably derived from the same seed, so an
//                  operator's addresses are linkable rather than anonymous.
//   PRIVATE_KEY  — a single key. Still supported; index selection is a no-op.
//
// Wallet selection is per command:
//   --wallet=<n>   act as the wallet at derivation index n (default 0)
//   --all          act as every derived wallet in sequence (trading commands)
//
// Deriving more addresses does not create more entitlement. Free-to-play
// rewards and season prizes are awarded per operator, not per address, and the
// service is free to consolidate addresses that share a seed. Treat extra
// wallets as strategy and risk isolation, not as extra faucet claims.

import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

export const DERIVATION_PREFIX = "m/44'/60'/0'/0";

function mnemonic() {
  const m = process.env.MNEMONIC?.trim();
  return m && m.split(/\s+/).length >= 12 ? m : null;
}

function singleKey() {
  const k = process.env.PRIVATE_KEY?.trim();
  return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? k : null;
}

/** How many wallets the current config exposes. */
export function walletCount() {
  if (mnemonic()) {
    const n = Number(process.env.WALLET_COUNT ?? '1');
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      throw new Error('WALLET_COUNT must be an integer between 1 and 200');
    }
    return n;
  }
  return singleKey() ? 1 : 0;
}

/** viem account at derivation index `i`. */
export function accountAt(i = 0) {
  const m = mnemonic();
  if (m) {
    if (i < 0 || i >= walletCount()) {
      throw new Error(`wallet index ${i} is outside 0..${walletCount() - 1} (WALLET_COUNT)`);
    }
    return mnemonicToAccount(m, { path: `${DERIVATION_PREFIX}/${i}` });
  }
  const k = singleKey();
  if (!k) throw new Error('no MNEMONIC or PRIVATE_KEY configured');
  if (i !== 0) throw new Error('PRIVATE_KEY exposes a single wallet; use MNEMONIC for multiple');
  return privateKeyToAccount(k);
}

/** Every configured account, in derivation order. */
export function allAccounts() {
  return Array.from({ length: walletCount() }, (_, i) => ({ index: i, account: accountAt(i) }));
}

/** Parse --wallet=<n> / --wallet <n> and --all out of argv. */
export function walletSelectionFromArgv(argv) {
  let index = Number(process.env.WALLET_INDEX ?? '0');
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') all = true;
    else if (a.startsWith('--wallet=')) index = Number(a.slice('--wallet='.length));
    else if (a === '--wallet') index = Number(argv[i + 1]);
  }
  if (!Number.isInteger(index) || index < 0) throw new Error('--wallet must be a non-negative integer');
  return { index, all };
}

/**
 * Cross-check the configured WALLET_ADDRESS against the selected wallet.
 * With a mnemonic the address changes per index, so WALLET_ADDRESS is only
 * enforced for index 0 — that keeps the mismatch guard useful for the common
 * single-wallet case without breaking multi-wallet runs.
 */
export function assertAddressMatch(account, index) {
  const declared = process.env.WALLET_ADDRESS?.trim();
  if (!declared) return;
  if (index !== 0) return;
  if (declared.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `WALLET_ADDRESS is ${declared} but wallet 0 derives to ${account.address}. ` +
        `Fix one of them before trading.`,
    );
  }
}
