# cross-prediction

A Claude Code skill that drives the **CROSS Prediction Market** at [`prediction.crossdefi.io`](https://prediction.crossdefi.io/) on **CROSS Chain** (chain id `612055`). Lists active events, fetches event/market details with live orderbook prices, shows BILL + CROSS wallet balance + CTF Share holdings, reads settled market results, places BILL-denominated YES/NO Share buy/sell through explicit wallet execution strategies, and redeems winning Shares back into BILL.

- **Stack:** Node 20+, viem
- **Payment token:** BILL (ERC-20 on CROSS Chain)
- **Outcome representation:** Conditional Token Framework (CTF) Shares
- **Subcommands:** `list-events`, `get-event`, `get-results`, `balance`, `buy`, `sell`, `redeem`
- **Trading strategies:** A (local viem signer) · C (configured CROSSx gateway signer)
- **Live BILL API:** `https://pred-bill-service-api.crossdefi.io/api/v1`
- **Distribution:** standalone Claude skill **and** Claude Code plugin

> ⚠️ **This skill submits real EIP-712 orders that lock BILL collateral against outcome shares.** Trades are DRY-RUN by default; use `--live` to actually submit. Always set `MAX_TRADE_BILL` in `.env`. Read `skills/cross-prediction/SKILL.md` and the relevant signer module before using.

---

## Install — Recommended (via Marketplace)

```bash
/plugin marketplace add github.com/to-nexus/cross-skills-suite
/plugin install cross-prediction@cross-skills-suite
```

Part of the [CROSS Skills Suite](https://github.com/to-nexus/cross-skills-suite) — installs alongside `cross-dex-trade` and other CROSS Chain ecosystem skills.

---

## Install — Standalone

### Option 1 — Plain skill (one user, fastest)

```bash
git clone https://github.com/to-nexus/skill-cross-prediction /tmp/skill-cross-prediction
bash /tmp/skill-cross-prediction/install.sh        # symlinks into ~/.claude/skills/
```

### Option 2 — Claude Code plugin (marketplace-installable)

If you maintain a marketplace, add an entry pointing at this repo:

```json
{
  "name": "cross-prediction",
  "source": { "source": "github", "repo": "to-nexus/skill-cross-prediction" },
  "category": "blockchain"
}
```

End users then run `/plugin marketplace add <your-marketplace>` then `/plugin install cross-prediction`.

---

## Configuration

Copy the template and fill in the strategy-specific vars:

```bash
cp skills/cross-prediction/.env.example skills/cross-prediction/.env
chmod 600 skills/cross-prediction/.env
```

Required for all strategies:

| Variable | Description |
|---|---|
| `WALLET_ADDRESS` | Your CROSS Chain EOA / embedded wallet address (`0x` + 40 hex) |
| `MAX_TRADE_BILL` | Per-trade BILL notional cap. Default `100`; recommend `10` for new users |

Strategy-specific:

| Strategy | Vars | One-time setup |
|---|---|---|
| **A — local viem** | local signer env/config | none |
| **C — CROSSx gateway** | `PIN=123456` (6 digit) + configured gateway | maintainer-provided gateway config |

Optional: `STRATEGY=A|C|auto` to force a specific path. Default `auto` prefers A → C.

The skill resolves `.env` from (in order): cwd → `~/.claude/skills/cross-prediction/` → asks once.

---

## Usage

Inside Claude Code, just describe in plain language:

- "list active prediction events"
- "BTC 1분 예측 이벤트 찾아줘"
- "show my BILL balance and active shares"
- "buy 10 YES shares of <event> at max 0.55 BILL/share"
- "sell all my YES shares of <event>"
- "show settled results for event <id>"
- "redeem my winning shares for market <id>"

Direct CLI (skipping Claude):

```bash
cd ~/.claude/skills/cross-prediction

# Read-only (works without any signer credentials)
node scripts/list-events.mjs --status ACTIVE --query "BTC"
node scripts/get-event.mjs <eventId>
node scripts/balance.mjs --with-shares
node scripts/get-results.mjs <eventId> --only-mine

# Mutations — DRY-RUN by default
node scripts/buy.mjs  <marketId> UP 1
node scripts/sell.mjs <marketId> UP 1
node scripts/redeem.mjs <marketId>

# LIVE (auto-pick strategy from env; redeem requires Strategy A)
node scripts/buy.mjs  <marketId> UP 1 --live
node scripts/buy.mjs  <marketId> UP 1 --live --strategy A   # force a specific strategy
node scripts/redeem.mjs <marketId> --live --strategy A
```

All commands emit a single JSON object on stdout (txHash, status, explorer URL, chosen strategy and reason).

---

## Layout

```
skill-cross-prediction/                    # repo root = plugin
├── .claude-plugin/
│   └── plugin.json                        # plugin manifest
├── install.sh                             # symlink installer
├── README.md
├── LICENSE
└── skills/
    └── cross-prediction/                  # the skill itself
        ├── SKILL.md                       # what Claude reads to drive the market
        ├── package.json                   # viem + playwright deps
        ├── .env.example
        ├── scripts/                       # 20 .mjs subcommand modules
        │   ├── _signer.mjs / _signer-a-viem.mjs / _signer-c-gateway.mjs
        │   ├── _strategy.mjs              # auto-router
        │   ├── _auth.mjs / _order.mjs / _approval.mjs   # SIWE + EIP-712 + on-chain approve
        │   ├── _chain.mjs / _guard.mjs                  # viem client + safety
        │   ├── buy.mjs / sell.mjs / redeem.mjs / balance.mjs
        │   └── list-events.mjs / get-event.mjs / get-results.mjs
        └── references/
            ├── api-map.md                 # discovered + TODO internal endpoints
            ├── chain-addresses.md         # BILL + CTF/Exchange addresses
            └── ctf-basics.md              # 30s primer on Conditional Token math
```

---

## Safety model

The skill enforces **five** independent rails (one more than `cross-dex-trade`):

1. **Chain-id check.** RPC client re-verifies `eth_chainId == 612055` and aborts on mismatch.
2. **MAX_TRADE_BILL cap.** Worst-case notional (`shares × maxPrice`) compared to the cap before submission.
3. **User confirmation.** SKILL.md instructs Claude to require an explicit "yes / 진행" for any trade with notional > 1 BILL, rendering the parsed intent (event, side, price, amount, total, MAX cap, chosen strategy) as a human summary first.
4. **Address mismatch abort.** Each strategy resolves an EOA at runtime (A: local signer derive; C: gateway lookup). If `WALLET_ADDRESS` is set in env and the resolved address differs, abort with `ADDRESS_MISMATCH`.
5. **On-chain gap detection (Strategy C).** Strategy C signs off-chain prediction orders through the configured gateway. On-chain approvals and `redeem` require Strategy A unless a gateway tx path is explicitly configured.

Secrets handling: `PRIVATE_KEY` / `PIN` / SIWE-derived JWT never appear in the conversation transcript or in process argv (they go through `set -a; source .env; set +a` or `process.env`). `.auth/state.json` and `.session/gateway.json` are gitignored and never committed.

---

## Limitations

- **Prediction market only.** Gametoken DEX (`x.crosstoken.io`) is covered by [`cross-dex-trade`](https://github.com/to-nexus/skill-cross-dex-trade). Forge / CrossDefi swap-bridge / Rewards / NFT / Shop are out of scope here.
- **Strategy C cannot perform on-chain approvals or redeem transactions in this distributable skill.** Use Strategy A for `BILL.approve`, `CTF.setApprovalForAll`, and `redeem`.
- **Outcome redemption is supported through `redeem.mjs`.** `get-results --only-mine` surfaces redeemable positions; `redeem.mjs <marketId> --live --strategy A` calls `CTF.redeemPositions`.

---

## License

[MIT](LICENSE) — but read the disclaimer at the bottom of the LICENSE file before using.
