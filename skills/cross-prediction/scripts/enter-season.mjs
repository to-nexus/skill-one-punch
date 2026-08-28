#!/usr/bin/env node
// enter-season — submit the EnterSeason authorization for the current F2P season.
//
// Entering is a prerequisite for claiming POINT and for placing POINT orders:
// the service rejects both with 409 until the wallet is in the season. `claim`
// does this automatically, so run this only to enter without claiming.
//
// Strategy A only (on-chain submission).
//
// Usage:
//   node scripts/enter-season.mjs --confirm

import { getPublicClient, getWalletClient } from './_chain.mjs';
import { resolveStrategy, buildSigner } from './_strategy.mjs';
import { login } from './_auth.mjs';
import { PUNCH_POINT_ABI, getSummary, requestEnterSeason, verifyingContractOf } from './_f2p.mjs';
import { assertChainId, printJson, fail } from './_guard.mjs';

const GAS_MARGIN_PERCENT = 20n;

async function main() {
  const confirm = process.argv.slice(2).includes('--confirm');

  let signer;
  try {
    await assertChainId();
    signer = await buildSigner(resolveStrategy().strategy);
  } catch (e) {
    return fail('GUARD_FAIL', e.message);
  }

  const summary = await getSummary();
  if (!confirm) {
    return printJson({
      dryRun: true,
      market: 'point',
      address: signer.address,
      seasonState: summary?.state,
      seasonId: summary?.seasonId,
      _note: 're-run with --confirm to submit enterSeason on-chain',
    });
  }

  const { accessToken } = await login(signer);
  const auth = await requestEnterSeason(accessToken);

  const publicClient = getPublicClient();
  const { client: walletClient, account } = getWalletClient(process.env.PRIVATE_KEY);
  const entry = await enterSeasonCall(publicClient, verifyingContractOf(auth), {
    user: signer.address,
    signature: auth.signature,
  });
  const params = {
    address: verifyingContractOf(auth),
    abi: entry.abi,
    functionName: entry.functionName,
    args: entry.args,
    account,
  };
  const estimated = await publicClient.estimateContractGas(params);
  const hash = await walletClient.writeContract({
    ...params,
    gas: estimated + (estimated * GAS_MARGIN_PERCENT) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== 'success') return fail('TX_REVERTED', `enterSeason reverted: ${hash}`);

  printJson({ market: 'point', address: signer.address, seasonId: auth.seasonId, tx: hash });
}

main().catch((e) => fail('UNEXPECTED', e.message));
