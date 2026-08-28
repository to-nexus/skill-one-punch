// _signer-a-viem.mjs — Strategy A signer.
//
// Wraps a viem `privateKeyToAccount` so callers don't need to know whether
// signing happens locally.

import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { crossChain } from './_chain.mjs';
import { assertSignerShape } from './_signer.mjs';

export function createViemSigner(privateKey) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '')) {
    throw new Error('PRIVATE_KEY must be a 0x-prefixed 64-char hex string');
  }
  return createViemSignerFromAccount(privateKeyToAccount(privateKey), 0);
}

/**
 * Wrap an already-constructed viem account (from a raw key or from a mnemonic
 * derivation) as a Signer. `walletIndex` is carried through so callers can
 * report which wallet acted.
 */
export function createViemSignerFromAccount(account, walletIndex = 0) {
  const walletClient = createWalletClient({ account, chain: crossChain, transport: http() });

  return assertSignerShape({
    strategy: 'A',
    walletIndex,
    address: account.address,
    account,                 // expose for on-chain writes (collateral.approve, CTF.setApprovalForAll)
    walletClient,
    async signMessage(message) {
      return account.signMessage({ message });
    },
    async signTypedData({ domain, types, primaryType, message }) {
      return account.signTypedData({ domain, types, primaryType, message });
    },
    async close() { /* nothing to release */ },
  });
}
