# cross-prediction

A Claude Code skill that drives the **CROSS Prediction Market** at [`prediction.crossdefi.io`](https://prediction.crossdefi.io/) on **CROSS Chain** (chain id `612055`). Lists active events, fetches event/market details with live orderbook prices, shows BILL + CROSS wallet balance + CTF Share holdings, reads settled market results, and places BILL-denominated YES/NO Share buy/sell through any of three interchangeable signing strategies.

- **Stack:** Node 20+, viem, Playwright (optional)
- **Payment token:** BILL (ERC-20 on CROSS Chain)
- **Outcome representation:** Conditional Token Framework (CTF) Shares
- **Subcommands:** `list-events`, `get-event`, `get-results`, `balance`, `buy`, `sell`
- **Trading strategies:** A (local PK + viem) · B (Playwright UI + PIN) · C (CROSSx gateway + PIN)
- **Distribution:** standalone Claude skill **and** Claude Code plugin

> ⚠️ **This skill submits real EIP-712 orders that lock BILL collateral against outcome shares.** Trades are DRY-RUN by default; use `--live` to actually submit. Always set `MAX_TRADE_BILL` in `.env`. Read `skills/cross-prediction/SKILL.md` and the relevant signer module before using.

> 🔒 **Private repository.** Owner (`to-nexus`) installs via `gh auth login`. Others need collaborator access or `GITHUB_TOKEN`. See the umbrella [`cross-skills-suite` README](https://github.com/to-nexus/cross-skills-suite#authenticating-to-private-repos) for details.

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
| **A — local viem** | `PRIVATE_KEY=0x…` (64 hex) | none |
| **B — Playwright UI** | `PIN=123456` (6 digit) | `node scripts/_login-capture.mjs` (writes `.auth/state.json`) |
| **C — CROSSx gateway** | `PIN=123456` (6 digit) | `node scripts/_recon-gateway.mjs` (writes `.session/gateway.json`) |

Optional: `STRATEGY=A|B|C|auto` to force a specific path. Default `auto` prefers A → B → C.

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

Direct CLI (skipping Claude):

```bash
cd ~/.claude/skills/cross-prediction

# Read-only (works without any signer credentials)
node scripts/list-events.mjs --status ACTIVE --query "BTC"
node scripts/get-event.mjs <eventId>
node scripts/balance.mjs --with-shares
node scripts/get-results.mjs <eventId> --only-mine

# Trading — DRY-RUN by default
node scripts/buy.mjs  <marketId> UP 1
node scripts/sell.mjs <marketId> UP 1

# Trading — LIVE (auto-pick strategy from env)
node scripts/buy.mjs  <marketId> UP 1 --live
node scripts/buy.mjs  <marketId> UP 1 --live --strategy A   # force a specific strategy
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
        │   ├── _trader-ui.mjs             # Strategy B (Playwright)
        │   ├── _login-capture.mjs / _recon-gateway.mjs   # one-time setup
        │   ├── _auth.mjs / _order.mjs / _approval.mjs   # SIWE + EIP-712 + on-chain approve
        │   ├── _chain.mjs / _guard.mjs                  # viem client + safety
        │   ├── _playwright-driver.mjs
        │   ├── buy.mjs / sell.mjs / balance.mjs
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
4. **Address mismatch abort.** Each strategy resolves an EOA at runtime (A: PK derive; C: gateway lookup; B: storageState). If `WALLET_ADDRESS` is set in env and the resolved address differs, abort with `ADDRESS_MISMATCH`.
5. **Approval gap detection (Strategy C).** Strategy C cannot send on-chain `BILL.approve` / `CTF.setApprovalForAll` because the gateway only signs messages, not transactions. If allowance is missing, abort with `APPROVAL_GAP` and instruct the user to do one tiny manual trade through the website UI to set approvals once.

Secrets handling: `PRIVATE_KEY` / `PIN` / SIWE-derived JWT never appear in the conversation transcript or in process argv (they go through `set -a; source .env; set +a` or `process.env`). `.auth/state.json` and `.session/gateway.json` are gitignored and never committed.

---

## Limitations

- **Prediction market only.** Gametoken DEX (`x.crosstoken.io`) is covered by [`cross-dex-trade`](https://github.com/to-nexus/skill-cross-dex-trade). Forge / CrossDefi swap-bridge / Rewards / NFT / Shop are out of scope here.
- **Strategy B requires headful Playwright once.** `_login-capture.mjs` opens a real browser to capture an authenticated session; subsequent trades are headless.
- **Strategy C cannot perform on-chain approvals.** First-time users on Strategy C must do one manual trade via the website UI to grant `BILL.approve` and `CTF.setApprovalForAll`. After that, Strategy C is fully autonomous.
- **No automated outcome redemption yet.** `get-results --only-mine` surfaces redeemable positions, but the actual `redeemPositions` call is a planned v0.4 addition.

---

## License

[MIT](LICENSE) — but read the disclaimer at the bottom of the LICENSE file before using.
