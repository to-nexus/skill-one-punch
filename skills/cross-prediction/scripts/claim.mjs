#!/usr/bin/env node
// claim — claim earned POINT (free-to-play) and mint it on-chain.
//
// Claiming ends in a contract call, so it needs a local key that can submit it.
//
// The claim transaction itself costs nothing: fees on PunchPoint calls net out
// to zero. The wallet still needs a dust balance of CROSS to clear the node's
// minimum-gas-price admission check, and that dust is not consumed.
//
// Usage:
//   node scripts/claim.mjs                 # dry run — show what is claimable
//   node scripts/claim.mjs --confirm       # request authorization and submit

import { formatUnits } from 'viem';
import { getPublicClient, getWalletClient } from './_chain.mjs';
import { resolveStrategy, buildSigner } from './_strategy.mjs';
import { login } from './_auth.mjs';
import {
  PUNCH_POINT_ABI,
  MAX_SWEEP_ROUNDS,
  getEarn,
  getSummary,
  requestEnterSeason,
  enterSeasonCall,
  requestClaim,
  verifyingContractOf,
} from './_f2p.mjs';
import { assertChainId, printJson, fail } from './_guard.mjs';

const GAS_MARGIN_PERCENT = 20n;

async function submit({ walletClient, publicClient, account, address, abi, functionName, args }) {
  const params = { address, abi, functionName, args, account };
  const estimated = await publicClient.estimateContractGas(params);
  const hash = await walletClient.writeContract({
    ...params,
    gas: estimated + (estimated * GAS_MARGIN_PERCENT) / 100n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== 'success') {
    const err = new Error(`transaction reverted on-chain: ${hash}`);
    err.hash = hash;
    throw err;
  }
  return hash;
}

async function main() {
  const argv = process.argv.slice(2);
  const confirm = argv.includes('--confirm');

  let signer;
  try {
    await assertChainId();
    signer = await buildSigner(resolveStrategy().strategy);
  } catch (e) {
    return fail('GUARD_FAIL', e.message);
  }

  const { accessToken } = await login(signer);

  // What is claimable right now?
  const [summary, earn] = await Promise.all([getSummary(), getEarn(accessToken)]);
  const claimable = earn?.claimable;
  const totalRaw = claimable?.totalAmount ?? '0';
  const breakdown = (claimable?.breakdown ?? []).map((g) => ({
    ruleType: g.ruleType,
    label: g.label,
    amount: g.amount,
  }));

  if (BigInt(totalRaw) === 0n) {
    return printJson({
      market: 'point',
      address: signer.address,
      seasonState: summary?.state,
      claimable: '0',
      breakdown: [],
      _note: 'nothing to claim right now',
    });
  }

  if (!confirm) {
    return printJson({
      dryRun: true,
      market: 'point',
      address: signer.address,
      seasonState: summary?.state,
      claimable: formatUnits(BigInt(totalRaw), 18),
      breakdown,
      _note: 're-run with --confirm to request authorization and submit the mint',
    });
  }

  const publicClient = getPublicClient();
  const { client: walletClient, account } = getWalletClient(process.env.PRIVATE_KEY);

  const txs = [];
  let claimedRaw = 0n;
  let cursor;
  let moreRemaining = false;

  for (let round = 0; round < MAX_SWEEP_ROUNDS; round++) {
    let res = await requestClaim(accessToken, cursor);

    // First claim of a season is rejected until the wallet has entered it.
    if (res.needsSeasonEntry) {
      const auth = await requestEnterSeason(accessToken);
      const entry = await enterSeasonCall(publicClient, verifyingContractOf(auth), {
        user: signer.address,
        signature: auth.signature,
      });
      const hash = await submit({
        walletClient,
        publicClient,
        account,
        address: verifyingContractOf(auth),
        abi: entry.abi,
        functionName: entry.functionName,
        args: entry.args,
      });
      txs.push({ step: 'enterSeason', seasonId: auth.seasonId, hash });
      res = await requestClaim(accessToken, cursor);
    }

    if (res.status !== 200) {
      return fail('CLAIM_REQUEST_FAILED', `POST /f2p/point/claim returned HTTP ${res.status}`, {
        body: res.body,
        txs,
      });
    }

    const c = res.data;
    if (!c?.breakdown?.length) break;

    // An in-progress sweep has no usable signature. Submitting it would revert.
    if (!c.signed) {
      moreRemaining = true;
      break;
    }

    const hash = await submit({
      walletClient,
      publicClient,
      account,
      address: verifyingContractOf(c),
      abi: PUNCH_POINT_ABI,
      functionName: 'mint',
      args: [signer.address, c.labels, c.amounts.map(BigInt), BigInt(c.deadline), c.signature],
    });
    txs.push({ step: 'mint', amount: formatUnits(BigInt(c.totalAmount ?? '0'), 18), hash });
    claimedRaw += BigInt(c.totalAmount ?? '0');

    moreRemaining = Boolean(c.hasMore);
    if (!c.hasMore) break;
    cursor = c.referralCursor;
  }

  printJson({
    market: 'point',
    address: signer.address,
    claimed: formatUnits(claimedRaw, 18),
    txs,
    moreRemaining,
    _note: moreRemaining
      ? 'referral sweep did not finish — re-run claim shortly to collect the rest'
      : undefined,
  });
}

main().catch((e) => fail('UNEXPECTED', e.message));
