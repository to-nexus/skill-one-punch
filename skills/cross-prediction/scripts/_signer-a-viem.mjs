// _signer-a-viem.mjs — Strategy A signer.
//
// Wraps a viem `privateKeyToAccount` so callers don't need to know whether
// signing happens locally or via the gateway.

import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { crossChain } from './_chain.mjs';
import { assertSignerShape } from './_signer.mjs';

export function createViemSigner(privateKey) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '')) {
    throw new Error('PRIVATE_KEY must be a 0x-prefixed 64-char hex string');
  }
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, chain: crossChain, transport: http() });

  return assertSignerShape({
    strategy: 'A',
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
