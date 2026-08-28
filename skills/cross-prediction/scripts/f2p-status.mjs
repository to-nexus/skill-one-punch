#!/usr/bin/env node
// f2p-status — free-to-play season state, prize pool, and what this wallet can claim.
//
// The summary is public; the claimable breakdown needs auth, so a wallet is
// optional: without a signer this prints the season only.
//
// Usage:
//   node scripts/f2p-status.mjs            # season only (no auth)
//   node scripts/f2p-status.mjs --me       # also this wallet's claimable POINT

import { formatUnits } from 'viem';
import { resolveStrategy, buildSigner } from './_strategy.mjs';
import { login } from './_auth.mjs';
import { getSummary, getEarn } from './_f2p.mjs';
import { printJson, fail } from './_guard.mjs';

async function main() {
  const withMe = process.argv.slice(2).includes('--me');
  const summary = await getSummary();

  const out = {
    market: 'point',
    season: {
      state: summary?.state,
      seasonId: summary?.seasonId,
      startsAt: summary?.startsAt,
      endsAt: summary?.endsAt,
      prizePool: summary?.prizePool,
    },
  };

  if (withMe) {
    const signer = await buildSigner(resolveStrategy().strategy);
    const { accessToken } = await login(signer);
    const earn = await getEarn(accessToken);
    const total = earn?.claimable?.totalAmount ?? '0';
    out.wallet = {
      address: signer.address,
      claimable: formatUnits(BigInt(total), 18),
      breakdown: (earn?.claimable?.breakdown ?? []).map((g) => ({
        ruleType: g.ruleType,
        label: g.label,
        amount: g.amount,
      })),
      attendanceDeadline: earn?.claimable?.attendanceDeadline,
    };
    out._note = BigInt(total) > 0n ? 'run `node scripts/claim.mjs --confirm` to claim' : undefined;
  }

  printJson(out);
}

main().catch((e) => fail('UNEXPECTED', e.message));
