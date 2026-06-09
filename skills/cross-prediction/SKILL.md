---
name: cross-prediction
description: Drive the CROSS Prediction market (prediction.crossdefi.io) by natural language. Lists active events, fetches event/market details, shows BILL + CROSS wallet balance, and places BILL-denominated Share buy/sell on CROSS Chain (chain id 612055) through explicit wallet execution strategies only: local signer or configured CROSSx gateway signer. Browser session reuse is not part of the distributable skill. Activates on phrases like "예측 마켓", "CROSS prediction", "BILL 매수/매도", "BTC 1분 예측", "prediction events", "cross defi prediction".
version: 0.3.1
license: MIT
---

# CROSS Prediction Market

A distributable skill for `prediction.crossdefi.io`: list events, inspect markets, read settled results, check balances, and trade outcome Shares in BILL.

> **v0.3.1 security posture:** read paths are public. Trading is DRY-RUN by default and can execute only through Strategy A (local viem signer) or Strategy C (configured CROSSx gateway signer). Browser-login state tooling is not shipped.
> **Live endpoint:** BILL-denominated markets use `https://pred-bill-service-api.crossdefi.io/api/v1`; SIWE auth uses domain `https://prediction.crossdefi.io`.

---

## 1. Activation

Activate when the user asks for:

- Active prediction events or search results
- Detail on a specific event or market
- Settled results and per-user PnL where wallet data is available
- CROSS / BILL balance for a wallet
- A BUY or SELL preview or execution for YES/NO Shares
- Redeem settled winning Shares back into BILL

If the user asks about Gametoken / CROSS DEX trading instead, hand off to `cross-dex-trade`.

---

## 2. Prerequisites

```bash
node --version                         # require >= 20
SKILL_DIR="$HOME/.claude/skills/cross-prediction"
[ -d "$SKILL_DIR/node_modules" ] || (cd "$SKILL_DIR" && npm install --silent)
```

No browser automation dependency is required.

---

## 3. Credential Resolution And Strategy Routing

Env resolution priority:

1. `./.env` in the user's current working directory
2. `$HOME/.claude/skills/cross-prediction/.env`
3. Ask the user only for non-secret missing values needed by the requested action

Never echo `PRIVATE_KEY`, `PIN`, raw `.env`, gateway auth material, or signed payload secrets into the conversation. Do not pass secrets in Bash argv; source env files or pass through process env.

For personal testing, the default `env` backend reads the key from local
environment variables or a gitignored `.env` file. For team, hosted-agent, or
production funds, prefer Vault Transit, KMS, or HSM-backed signing so the raw
key is not exported to the agent runtime. Strategy C remains for configured
CROSSx gateway signing.

Required for wallet-specific reads/trades:

- `WALLET_ADDRESS=0x...`

Optional per strategy:

- local `PRIVATE_KEY` env/config for Strategy A
- `PIN=123456`, `CROSSX_GATEWAY_BASE`, and `CROSSX_AUTH_TOKEN` or `.session/gateway.json` for Strategy C
- `STRATEGY=A|C|auto`
- `MAX_TRADE_BILL` default `100`

Validation:

- `WALLET_ADDRESS` must match `^0x[0-9a-fA-F]{40}$`
- `PRIVATE_KEY`, when set, must match `^0x[0-9a-fA-F]{64}$`
- `PIN`, when set, must match `^\d{6}$`

### Strategy Map

| Strategy | Signing | Prerequisite | Notes |
|---|---|---|---|
| A | local viem signer | `PRIVATE_KEY` | Can perform required on-chain approvals |
| C | CROSSx gateway signer | `PIN` + configured gateway | Cannot perform on-chain approvals; fails with `APPROVAL_GAP` when allowance is missing |

`STRATEGY=auto` prefers A, then C. Deprecated browser-driven strategy names are rejected with `STRATEGY_REMOVED`.

If no strategy is usable, tell the user that trading needs either local Strategy A signer config or a configured Strategy C gateway. Do not suggest collecting web-login state from a browser.

---

## 4. Safety Rails

Every mutating operation checks:

1. **Chain id** — RPC must report `612055`.
2. **Dry-run first** — `buy.mjs` and `sell.mjs` preview by default; `--live` is required for execution.
3. **Explicit confirmation** — before any live trade above 1 BILL notional, summarize parsed intent and wait for explicit "yes / 진행".
4. **`MAX_TRADE_BILL` cap** — aborts when worst-case notional exceeds the configured cap.
5. **Address mismatch abort** — runtime signer address must match `WALLET_ADDRESS`.
6. **Approval hygiene** — Strategy A sends exact required approvals; Strategy C aborts if approvals are missing.
7. **Redeem hygiene** — `redeem.mjs` previews by default and live redeem requires Strategy A because it sends an on-chain `CTF.redeemPositions` transaction.
8. **No session reuse** — no browser storage, cookies, or saved login state are loaded by this skill.

---

## 5. Execution

All subcommands print a single JSON object on stdout.

### Read-Only

```bash
cd "$HOME/.claude/skills/cross-prediction"

node scripts/list-events.mjs [--status ACTIVE] [--query "BTC"] [--category CRYPTO] [--limit 20]
node scripts/get-event.mjs <eventId> [--marketId <marketId>] [--status ACTIVE|REDEEMABLE]
node scripts/balance.mjs [--with-shares] [--include-redeemable] [--redeemable-limit 20]
node scripts/get-results.mjs <eventId> [--only-mine] [--limit 20]
```

### Trading

```bash
# DRY_RUN
node scripts/buy.mjs  <marketId> <UP|DOWN|YES|NO|0|1> <amount>
node scripts/sell.mjs <marketId> <UP|DOWN|YES|NO|0|1> <shares>

# LIVE
node scripts/buy.mjs  <marketId> UP 1 --live
node scripts/sell.mjs <marketId> UP 1 --live

# Force a strategy
node scripts/buy.mjs <marketId> UP 1 --live --strategy A
node scripts/buy.mjs <marketId> UP 1 --live --strategy C
```

Order semantics:

- `MARKET BUY <amount>` means BILL notional to spend.
- `LIMIT BUY <shares> --max-price <p>` means shares to acquire at no more than `p` BILL/share.
- `SELL` takes shares; use `--limit --min-price <p>` for limit sells.

### Redeem

```bash
# DRY_RUN
node scripts/redeem.mjs <marketId>

# LIVE; Strategy A required because redeem is an on-chain CTF transaction
node scripts/redeem.mjs <marketId> --live --strategy A
```

`redeem.mjs` fetches the REDEEMABLE market, identifies the winning outcome, reads the caller's CTF Share balance, simulates `CTF.redeemPositions(collateralToken, zeroHash, conditionId, indexSets)`, and then submits the transaction only when `--live` is present.

---

## 6. Module Map

```text
scripts/
├── _signer.mjs               common Signer interface
├── _signer-a-viem.mjs        Strategy A: viem account from PRIVATE_KEY
├── _signer-c-gateway.mjs     Strategy C: configured CROSSx gateway signer
├── _strategy.mjs             auto-router: env -> A | C
├── _auth.mjs                 SIWE login using the selected signer
├── _order.mjs                EIP-712 order builder + sign + POST
├── _approval.mjs             on-chain BILL.approve / CTF.setApprovalForAll
├── _chain.mjs                viem client, addresses, ABIs, REST helpers
├── _guard.mjs                chain-id check, MAX_TRADE_BILL cap, env validation
├── buy.mjs / sell.mjs        dispatchers
├── redeem.mjs                settled winning Share redemption
├── balance.mjs               wallet + share enumeration
├── list-events.mjs           public event list
├── get-event.mjs             event + markets + orderbook
└── get-results.mjs           settled markets + per-user PnL
```

---

## 7. Reporting Back

For every mutating operation, surface:

- Parsed intent
- Mode: `DRY_RUN` or `LIVE`
- Strategy and strategy reason
- Trade notional and `MAX_TRADE_BILL`
- Allowance/balance status
- `txHash` or submit response when live
- Redeemable winning Share count and redeemed BILL amount for `redeem.mjs`

Never include `PRIVATE_KEY`, `PIN`, raw `.env`, gateway auth material, or full session/config contents.

---

## 8. Distribution

This folder is the unit of distribution:

1. Copy `cross-prediction/` into `~/.claude/skills/`.
2. Run `npm install`.
3. Create `.env` from `.env.example`.
4. For execution, configure Strategy A or Strategy C. Read-only commands require no signer unless the command asks for wallet-specific balances.

Read deeper references only when needed:

- `references/api-map.md`
- `references/chain-addresses.md`
- `references/ctf-basics.md`
