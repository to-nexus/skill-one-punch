// _approval.mjs — ensure the Exchange contract is allowed to move the trader's
// collateral / shares. Matches the frontend's behavior:
//   BUY:  check ERC20 allowance (BILL → Exchange); approve MaxUint256 if short.
//   SELL: check ERC-1155 isApprovedForAll (CTF → Exchange); setApprovalForAll(true) if not.

import { maxUint256 } from 'viem';
import {
  getPublicClient, KNOWN_ADDRESSES, ERC20_ABI, ERC1155_ABI,
} from './_chain.mjs';

export async function ensureBillAllowance(walletClient, account, requiredWei) {
  const pub = getPublicClient();
  const current = await pub.readContract({
    address: KNOWN_ADDRESSES.bill,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, KNOWN_ADDRESSES.exchange],
  });
  if (current >= requiredWei) return { approved: false, already: true, current };
  const hash = await walletClient.writeContract({
    account,
    address: KNOWN_ADDRESSES.bill,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [KNOWN_ADDRESSES.exchange, maxUint256],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { approved: true, already: false, txHash: hash, status: receipt.status };
}

const ERC1155_APPROVAL_ABI = [
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }, { name: 'operator', type: 'address' }],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable',
    inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }],
    outputs: [] },
];

export async function ensureCtfApprovedForAll(walletClient, account) {
  const pub = getPublicClient();
  const approved = await pub.readContract({
    address: KNOWN_ADDRESSES.ctf,
    abi: ERC1155_APPROVAL_ABI,
    functionName: 'isApprovedForAll',
    args: [account.address, KNOWN_ADDRESSES.exchange],
  });
  if (approved) return { approved: false, already: true };
  const hash = await walletClient.writeContract({
    account,
    address: KNOWN_ADDRESSES.ctf,
    abi: ERC1155_APPROVAL_ABI,
    functionName: 'setApprovalForAll',
    args: [KNOWN_ADDRESSES.exchange, true],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { approved: true, already: false, txHash: hash, status: receipt.status };
}
