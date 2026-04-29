---
name: cross-prediction
description: Drive the CROSS Prediction market (prediction.crossdefi.io) by natural language. Lists active events, fetches event/market details, shows BILL + CROSS wallet balance, and places BILL-denominated Share buy/sell on CROSS Chain (chain id 612055) via three interchangeable strategies — local PK signer, Playwright UI automation, or CROSSx remote gateway. Activates on phrases like "예측 마켓", "CROSS prediction", "BILL 매수/매도", "BTC 1분 예측", "prediction events", "cross defi prediction".
version: 0.3.0
license: MIT
---

# CROSS Prediction Market — Claude Code Skill

A distributable skill that lets Claude operate [`prediction.crossdefi.io`](https://prediction.crossdefi.io/) — listing events, inspecting markets with real orderbook prices, reading settled market results, checking wallet + Share balances, and trading outcome Shares in BILL via any of three strategies.

> **v0.3 scope:** read paths fully live (`list-events`, `get-event`, `get-results`, `balance --with-shares`). Trading supports **all three** signing strategies through a single dispatcher: A (local viem PK), B (Playwright UI + PIN), C (CROSSx gateway + PIN). DRY-RUN by default; `--live` gates real submission. `--strategy` flag forces a specific path.

---

## 1. Activation

Activate when the user asks for:
- An active prediction events list, or to search ("BTC 예측 이벤트 찾아줘")
- Detail on a specific event or market
- Settled results (their own PnL)
- The CROSS / BILL balance of their connected wallet
- To buy or sell YES/NO Shares

If the user asks about Gametoken / CROSS DEX trading instead, hand off to the `cross-dex-trade` skill — this one is prediction-market-specific.

---

## 2. Prerequisites

```bash
node --version                         # require >= 20
```

Install deps once (first use):
```bash
SKILL_DIR="$HOME/.claude/skills/cross-prediction"
[ -d "$SKILL_DIR/node_modules" ] || (cd "$SKILL_DIR" && npm install --silent)
```

Playwright (only if user needs Strategy B trading — skip for read-only usage):
```bash
cd "$SKILL_DIR" && npx playwright install chromium
```

---

## 3. Credential resolution & strategy routing

### 3.1 Env resolution priority

1. `./.env` in the user's current working directory
2. `$HOME/.claude/skills/cross-prediction/.env`
3. Prompt the user (only if both are missing required vars)

**Never echo PRIVATE_KEY or PIN into the conversation, never log, never persist to anywhere other than the `.env` file the user chose.**

Required: `WALLET_ADDRESS` (0x…).
Optional per strategy: `PRIVATE_KEY` (A), `PIN` (B/C), `STRATEGY` (force a strategy), `MAX_TRADE_BILL` (default 100), endpoint overrides.

Validation:
- `WALLET_ADDRESS` must match `^0x[0-9a-fA-F]{40}$`
- `PRIVATE_KEY` (if set) must match `^0x[0-9a-fA-F]{64}$`
- `PIN` (if set) must match `^\d{6}$`

### 3.2 Strategy auto-routing

The dispatcher (`scripts/_strategy.mjs`) picks a strategy from env unless `--strategy A|B|C` is passed:

| Strategy | Signing | Prerequisite | Best for |
|---|---|---|---|
| **A** | local viem | `PRIVATE_KEY` set | Power users who exported the embedded wallet PK |
| **B** | site UI + PIN | `PIN` + `.auth/state.json` (run `_login-capture.mjs` once) | Social-login users who can't / won't export PK |
| **C** | CROSSx gateway + PIN | `PIN` + `.session/gateway.json` (run `_recon-gateway.mjs` once) | Same as B but headless / faster than UI automation |

`STRATEGY=auto` (default) prefers A → B → C. The dispatcher reports the chosen strategy and reason in every DRY_RUN response.

### 3.3 If no strategy is usable

Tell the user precisely what's missing. Example for the empty case:

> "Trading needs one of:
> • `PRIVATE_KEY=0x…` in `.env` (Strategy A — local signer)
> • `PIN=123456` + run `node scripts/_login-capture.mjs` once (Strategy B — UI automation)
> • `PIN=123456` + run `node scripts/_recon-gateway.mjs` once (Strategy C — gateway signer)
> Pick whichever matches what your CROSSx wallet exposes."

---

## 4. Safety rails — apply every time

Every mutating operation checks:
1. **Chain id** = 612055. The RPC client re-verifies via `eth_chainId` and aborts on mismatch.
2. **`MAX_TRADE_BILL`** cap. The script aborts when worst-case notional (`shares × maxPrice`, or `shares` if price is unbounded) exceeds the cap.
3. **User confirmation** before any trade whose notional > 1 BILL. Render the parsed intent as a human summary:
   > "Buying **10** YES shares of *Will BTC go up in the next minute?* at max **0.55 BILL/share** → up to **5.50 BILL** from wallet `0x0000…0000` via **Strategy A**. `MAX_TRADE_BILL=10`. Confirm?"
   Wait for explicit "yes / 진행" before running.
4. **Address mismatch abort** — every strategy resolves an EOA at runtime (A: PK derive; C: gateway lookup; B: storageState). If `WALLET_ADDRESS` is set and the resolved address differs, abort with `ADDRESS_MISMATCH`.
5. **Approval gap (Strategy C only)** — Strategy C cannot send on-chain `BILL.approve` / `CTF.setApprovalForAll` because the gateway only signs messages, not transactions. If allowance is missing, abort with `APPROVAL_GAP` and instruct the user to do one tiny manual trade through the website UI to set approvals once.
6. **Never** save PK/PIN/JWT outside the `.env`/`.session/` files the user chose. In particular, do NOT include them in Bash argv (they'd show in `ps`); export via `set -a; source .env; set +a` instead. JWT lives in process memory only.

---

## 5. Execution

All subcommands print a single JSON object on stdout. Errors follow `{ "error": "...", "code": "..." }`.

### Read-only (works today — all via public API, no login)

```bash
cd "$HOME/.claude/skills/cross-prediction"

# List events. --status ACTIVE (default) | CLOSED. --category CRYPTO|POLITICS|SPORTS|MACRO|CULTURE
node scripts/list-events.mjs [--status ACTIVE] [--query "BTC"] [--category CRYPTO] [--limit 20]

# Event + all markets + live orderbook per outcome
node scripts/get-event.mjs <eventId> [--marketId <marketId>] [--status ACTIVE|REDEEMABLE]

# Wallet balance. --with-shares enumerates CTF Share holdings across active markets.
# Add --include-redeemable to also scan recent settled markets for unredeemed shares.
node scripts/balance.mjs [--with-shares] [--include-redeemable] [--redeemable-limit 20]

# Settled-market results. --only-mine also fetches on-chain CTF balance per outcome.
node scripts/get-results.mjs <eventId> [--only-mine] [--limit 20]
```

### Trading (dry-run by default, `--live` gated)

```bash
# DRY_RUN — preview order, price sanity, allowance + funds check, chosen strategy.
node scripts/buy.mjs  <marketId> <UP|DOWN|YES|NO|0|1> <amount>
node scripts/sell.mjs <marketId> <UP|DOWN|YES|NO|0|1> <shares>

# LIVE — auto-pick strategy from env (A → B → C).
node scripts/buy.mjs  <marketId> UP 1 --live
node scripts/sell.mjs <marketId> UP 1 --live

# Force a specific strategy:
node scripts/buy.mjs <marketId> UP 1 --live --strategy A
node scripts/buy.mjs <marketId> UP 1 --live --strategy B
node scripts/buy.mjs <marketId> UP 1 --live --strategy C
```

Order-type semantics (asymmetric, matching the Exchange's native encoding):
- `MARKET BUY <amount>` → `<amount>` is **BILL notional to spend**.
- `LIMIT BUY <shares> --max-price <p>` → shares to acquire at ≤ p BILL/share.
- `SELL` always takes shares; `--limit --min-price <p>` for limit sells.

`outcomeIndex` is canonical; names (UP/DOWN/YES/NO/LONG/SHORT) are resolved case-insensitively to `0`/`1`. All trade args go through `capTrade(MAX_TRADE_BILL)` so a rogue run cannot exceed the cap. The dispatcher emits `strategy`, `strategyReason`, and `strategyAvailable` in every response so Claude can read which path was taken.

### One-time setup per strategy

```bash
# Strategy B — capture an authenticated browser session (headful, ~1 min)
node scripts/_login-capture.mjs        # writes .auth/state.json (chmod 600)

# Strategy C — capture the CROSSx gateway endpoint shapes (headful, ~2 min)
node scripts/_recon-gateway.mjs        # writes .session/gateway.json (chmod 600)
```

Both produce files inside `~/.claude/skills/cross-prediction/`; never commit them.

---

## 6. Module map

```
scripts/
├── _signer.mjs               common Signer interface (signMessage, signTypedData, address)
├── _signer-a-viem.mjs        Strategy A: viem account from PRIVATE_KEY
├── _signer-c-gateway.mjs     Strategy C: HTTP client to embedded-wallet-gateway
├── _strategy.mjs             auto-router: env → A | B | C
├── _trader-ui.mjs            Strategy B: Playwright UI automation (selector autodiscovery)
├── _login-capture.mjs        Strategy B setup — saves .auth/state.json
├── _recon-gateway.mjs        Strategy C setup — saves .session/gateway.json
├── _auth.mjs                 SIWE login (consumes any Signer)
├── _order.mjs                EIP-712 order builder + sign + POST
├── _approval.mjs             on-chain BILL.approve / CTF.setApprovalForAll (Strategy A only)
├── _chain.mjs                viem client, addresses, ABIs, REST helpers
├── _guard.mjs                chain-id check, MAX_TRADE_BILL cap, env validation
├── buy.mjs / sell.mjs        dispatchers — DRY_RUN by default, --live --strategy gated
├── balance.mjs               wallet + share enumeration (read-only)
├── list-events.mjs           public event list
├── get-event.mjs             event + markets + orderbook
└── get-results.mjs           settled markets + per-user PnL
```

Strategy A and C share the API path (`_auth` → `_order` → REST POST), differing only in which Signer the dispatcher hands them. Strategy B has its own runtime (`_trader-ui`) because UI automation does not produce an EIP-712 signature the caller can hold; the website signs and submits internally.

---

## 7. Reporting back

After every mutating op, surface to the user:
- Parsed intent (audit trail)
- `txHash` + explorer link `https://explorer.crosstoken.io/612055/tx/<hash>`
- Receipt status (`success` / `reverted`)
- Wallet address last 6 chars only

Never include PK, PIN, raw `.env`, or full session storage contents.

---

## 8. Distribution

This folder is the unit of distribution:

1. `cp -r cross-prediction/ ~/.claude/skills/`
2. `cd ~/.claude/skills/cross-prediction && npm install`
3. Create `.env` from `.env.example`. Fill `WALLET_ADDRESS`, then **one** of:
   - `PRIVATE_KEY=0x…` (Strategy A)
   - `PIN=123456` and run `node scripts/_login-capture.mjs` (Strategy B)
   - `PIN=123456` and run `node scripts/_recon-gateway.mjs` (Strategy C)
4. (B/C only) `npx playwright install chromium` first.

---

## 9. Deeper references (loaded on demand)

Read these only when needed — they stay out of context otherwise:
- `references/api-map.md` — discovered + TODO internal endpoints
- `references/chain-addresses.md` — BILL + TODO CTF/Exchange addresses
- `references/ctf-basics.md` — 30-second primer on Conditional Token math

Project-level background (in the source `skill-cross-prediction-test` repo, not shipped with the skill):
- `docs/PLAN-cross-prediction-skill.md` · `docs/REQUIREMENTS-cross-prediction-skill.md` · `docs/RISKS-cross-prediction-skill.md` · `docs/ADR-001`, `ADR-002`.
