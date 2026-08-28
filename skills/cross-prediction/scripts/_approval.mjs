// _approval.mjs — ensure the Exchange contract is allowed to move the trader's
// collateral / shares. Matches the frontend's behavior:
//   BUY:  check ERC20 allowance (collateral → Exchange); approve MaxUint256 if short.
//   SELL: check ERC-1155 isApprovedForAll (CTF → Exchange); setApprovalForAll(true) if not.
//
// Addresses come from GET /config per market, so this works for both the usd
// (pONEUSD) and point (POINT) markets without hardcoding.

import { maxUint256 } from 'viem';
import { getPublicClient, loadMarketConfig, ERC20_ABI } from './_chain.mjs';

/**
 * Ensure the Exchange may pull `requiredWei` of the market's collateral.
 * `market` is a market key or descriptor ('usd' | 'point').
 */
export async function ensureCollateralAllowance(walletClient, account, requiredWei, market) {
  const cfg = await loadMarketConfig(market?.key ?? market);
  const pub = getPublicClient();
  const current = await pub.readContract({
    address: cfg.quoteToken.address,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, cfg.exchange],
  });
  if (current >= requiredWei) return { approved: false, already: true, current };
  const hash = await walletClient.writeContract({
    account,
    address: cfg.quoteToken.address,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [cfg.exchange, maxUint256],
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

export async function ensureCtfApprovedForAll(walletClient, account, market) {
  const cfg = await loadMarketConfig(market?.key ?? market);
  const pub = getPublicClient();
  const approved = await pub.readContract({
    address: cfg.ctf,
    abi: ERC1155_APPROVAL_ABI,
    functionName: 'isApprovedForAll',
    args: [account.address, cfg.exchange],
  });
  if (approved) return { approved: false, already: true };
  const hash = await walletClient.writeContract({
    account,
    address: cfg.ctf,
    abi: ERC1155_APPROVAL_ABI,
    functionName: 'setApprovalForAll',
    args: [cfg.exchange, true],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { approved: true, already: false, txHash: hash, status: receipt.status };
}
