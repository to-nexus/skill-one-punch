#!/usr/bin/env node
// wallets — list the wallets this skill can act as, and top them up with gas.
//
// Configure one seed instead of N keys:
//   MNEMONIC="word word ..."   WALLET_COUNT=5
// Wallets derive at m/44'/60'/0'/0/N.
//
// Usage:
//   node scripts/wallets.mjs list [--market=usd|point]
//   node scripts/wallets.mjs fund --amount 0.01 [--from 0]   # dry run
//   node scripts/wallets.mjs fund --amount 0.01 --confirm

import { formatUnits, parseEther, createWalletClient, http } from 'viem';
import { getPublicClient, loadMarketConfig, crossChain, ERC20_ABI } from './_chain.mjs';
import { marketFromArgv } from './_markets.mjs';
import { allAccounts, accountAt, walletCount, DERIVATION_PREFIX } from './_wallets.mjs';
import { assertChainId, printJson, fail } from './_guard.mjs';

function argVal(argv, name, dflt) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return dflt;
}

async function list(argv) {
  const { market, reason } = await marketFromArgv(argv);
  const cfg = await loadMarketConfig(market.key);
  const pub = getPublicClient();
  const decimals = cfg.quoteToken?.decimals ?? 18;
  const symbol = cfg.quoteToken?.symbol ?? market.collateral;

  const rows = [];
  for (const { index, account } of allAccounts()) {
    const [gas, collateral] = await Promise.all([
      pub.getBalance({ address: account.address }),
      pub.readContract({
        address: cfg.quoteToken.address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
      }),
    ]);
    rows.push({
      index,
      path: `${DERIVATION_PREFIX}/${index}`,
      address: account.address,
      gasCROSS: formatUnits(gas, 18),
      collateralSymbol: symbol,
      collateralBalance: formatUnits(collateral, decimals),
    });
  }

  printJson({
    market: market.key,
    _marketNote: reason ?? undefined,
    walletCount: walletCount(),
    wallets: rows,
    _note:
      'Extra addresses are for strategy and risk isolation. Free-to-play rewards and ' +
      'season prizes are awarded per operator, not per address.',
  });
}

async function fund(argv) {
  const amount = argVal(argv, 'amount');
  const fromIndex = Number(argVal(argv, 'from', '0'));
  const confirm = argv.includes('--confirm');
  if (!amount || !(Number(amount) > 0)) return fail('BAD_ARG', '--amount <CROSS> is required');

  const funder = accountAt(fromIndex);
  const targets = allAccounts().filter((w) => w.index !== fromIndex);
  if (!targets.length) return fail('NOTHING_TO_DO', 'only one wallet is configured');

  const pub = getPublicClient();
  const value = parseEther(String(amount));
  const balance = await pub.getBalance({ address: funder.address });
  const needed = value * BigInt(targets.length);

  if (!confirm) {
    return printJson({
      dryRun: true,
      from: { index: fromIndex, address: funder.address, gasCROSS: formatUnits(balance, 18) },
      perWallet: amount,
      targets: targets.map((w) => ({ index: w.index, address: w.account.address })),
      totalCROSS: formatUnits(needed, 18),
      sufficient: balance > needed,
      _note: 're-run with --confirm to send',
    });
  }
  if (balance <= needed) {
    return fail(
      'INSUFFICIENT_FUNDS',
      `funder holds ${formatUnits(balance, 18)} CROSS, needs more than ${formatUnits(needed, 18)}`,
    );
  }

  const wallet = createWalletClient({ account: funder, chain: crossChain, transport: http() });
  const sent = [];
  for (const w of targets) {
    const hash = await wallet.sendTransaction({ to: w.account.address, value });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    sent.push({ index: w.index, address: w.account.address, hash, status: r.status });
  }
  printJson({ from: funder.address, perWallet: amount, sent });
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith('-')) ?? 'list';
  try {
    await assertChainId();
    if (walletCount() === 0) {
      return fail('NO_WALLETS', 'set MNEMONIC (+ WALLET_COUNT) or PRIVATE_KEY first');
    }
  } catch (e) {
    return fail('GUARD_FAIL', e.message);
  }
  if (cmd === 'list') return list(argv);
  if (cmd === 'fund') return fund(argv);
  return fail('BAD_ARG', `unknown subcommand "${cmd}". Use: list | fund`);
}

main().catch((e) => fail('UNEXPECTED', e.message));
