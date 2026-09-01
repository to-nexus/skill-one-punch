# skill-one-punch

## Install — Standalone (fastest)

```bash
git clone https://github.com/to-nexus/skill-one-punch /tmp/skill-one-punch
bash /tmp/skill-one-punch/install.sh        # symlinks into ~/.claude/skills/cross-prediction
```

## Install — Claude Code plugin (marketplace-installable)

If you maintain a marketplace, add an entry pointing at this repo:

```json
{
  "name": "cross-prediction",
  "source": { "source": "github", "repo": "to-nexus/skill-one-punch" },
  "category": "blockchain"
}
```

End users then run `/plugin marketplace add <your-marketplace>` and `/plugin install cross-prediction`.

---

A Claude Code skill that drives **[PUNCH.WIN](https://www.punch.win)** — the prediction market on **CROSS Chain** (chain id `612055`). Lists active events, fetches event/market details with live orderbook prices, shows gas + collateral balances + CTF Share holdings, reads settled results, places YES/NO Share buy/sell through a local signer, redeems winning Shares, and runs the full **free-to-play POINT loop** (daily claim + weekly seasons) from the terminal.

- **Stack:** Node 20+, viem
- **Markets:** `usd` (collateral **pONEUSD**, real money) · `point` (**POINT**, free to play)
- **Outcome representation:** Conditional Token Framework (CTF) Shares
- **Subcommands:** `list-events`, `get-event`, `get-results`, `balance`, `buy`, `sell`, `redeem`, `f2p-status`, `enter-season`, `claim`, `wallets`
- **Execution:** single path — local viem signer (`PRIVATE_KEY` or `MNEMONIC` multi-wallet)
- **Live APIs:** `usd` → `https://pred-usd-service-api.crossdefi.io/api/v1` · `point` → `https://point-service-api.punch.win/api/v1`
- **Distribution:** standalone Claude skill **and** Claude Code plugin
- **User guide:** [docs.punch.win/trading/agent-skill](https://docs.punch.win/trading/agent-skill)

> ⚠️ **This skill submits real EIP-712 orders that lock collateral against outcome shares.** Trades are DRY-RUN by default; use `--live` to actually submit. Always set `MAX_TRADE_ONEUSD` (and `MAX_TRADE_POINT`) in `.env`. Read `skills/cross-prediction/SKILL.md` before using.

---

## Markets

| Market | Collateral | Money | F2P | Notes |
|---|---|---|---|---|
| `usd` | pONEUSD (Wrapped Prediction ONEUSD) | real | no | always on — stocks, sports, crypto |
| `point` | POINT | free | yes | **only exists during an F2P season** |
| `bill` / `cross` | — | — | — | **retired** — redeem-only legacy, zero active events |

Select with `--market=usd` or `--market=point` on any command. **Without a flag the skill is season-aware:** it prefers the free POINT market while a season is live and falls back to USD during the gap between seasons (POINT markets return zero events outside a season). Every command reports which market it chose and why.

Seasons run roughly weekly with a prize pool paid in ONE. Contract addresses are never hardcoded — they are resolved at runtime from each market's `GET /config`. SIWE auth sends origin `https://www.punch.win`.

---

## Wallet setup (read this first)

The skill signs and submits transactions itself, so it needs a private key it can read. **Use a dedicated wallet — never your main one.**

1. Create a fresh wallet and fund it with only what you intend to risk, plus a little CROSS for gas. POINT claim transactions net out to zero fees, but the node still requires a dust balance to accept them.
2. Put the key in the skill `.env` and `chmod 600` it. Never paste it into chat or a command argument.

A punch.win account created with **Google or Apple login** lives in a CROSSx embedded wallet. Its key can be exported from the CROSSx app, so such accounts can be used — but an exported key carries full authority and cannot be revoked, so moving just your trading funds to a dedicated wallet is safer.

## Configuration

```bash
cp skills/cross-prediction/.env.example skills/cross-prediction/.env
chmod 600 skills/cross-prediction/.env
```

| Variable | Description |
|---|---|
| `PRIVATE_KEY` | Local signer key (**or** use `MNEMONIC` + `WALLET_COUNT` for multi-wallet) |
| `WALLET_ADDRESS` | Cross-check for wallet 0 — aborts on mismatch |
| `MAX_TRADE_ONEUSD` | Per-trade cap on the real-money market. Default `10` |
| `MAX_TRADE_POINT` | Per-trade cap on the free market. Default `1000` |
| `PRED_MARKET` | Optional market override; unset = season-aware auto pick |

The skill resolves `.env` from (in order): cwd → `~/.claude/skills/cross-prediction/` → asks once.

### Multiple wallets

Set `MNEMONIC` + `WALLET_COUNT` instead of a bare `PRIVATE_KEY` and the skill derives wallets at `m/44'/60'/0'/0/N` — one secret to hold, every address provably from the same seed.

```bash
node scripts/wallets.mjs list                      # balances for every derived wallet
node scripts/wallets.mjs fund --amount 0.01 --confirm   # spread gas from wallet 0
node scripts/buy.mjs <marketId> UP 1 --wallet=2    # act as a specific wallet
```

Deriving more addresses does **not** create more entitlement: free-to-play rewards and season prizes are awarded per operator, not per address. Running many wallets against the same faucet or season is abuse, not a strategy.

---

## Usage

Inside Claude Code, just describe in plain language:

- "list active prediction events"
- "BTC 1분 예측 이벤트 찾아줘"
- "show my balance and active shares"
- "buy 10 UP shares of <event> at max 0.55"
- "sell all my UP shares of <event>"
- "how much POINT can I claim?" / "포인트 클레임해줘"
- "redeem my winning shares for market <id>"

Direct CLI (skipping Claude):

```bash
cd ~/.claude/skills/cross-prediction

# Read-only (works without any signer credentials)
node scripts/list-events.mjs --status ACTIVE --query "BTC"
node scripts/get-event.mjs <eventId>
node scripts/balance.mjs --with-shares
node scripts/get-results.mjs <eventId> --only-mine
node scripts/f2p-status.mjs --me

# Mutations — DRY-RUN by default
node scripts/buy.mjs  <marketId> UP 1
node scripts/sell.mjs <marketId> UP 1
node scripts/redeem.mjs <marketId>

# LIVE
node scripts/buy.mjs  <marketId> UP 1 --live
node scripts/redeem.mjs <marketId> --live
```

All commands emit a single JSON object on stdout (txHash, status, explorer URL, chosen market and reason).

### Free-to-play (POINT)

POINT is claimable daily and scored in weekly seasons with a prize pool paid in ONE. The full loop runs from the terminal:

```bash
node scripts/f2p-status.mjs --me            # season state, prize pool, claimable POINT
node scripts/enter-season.mjs --confirm     # enterSeason(sig) on-chain — once per season
node scripts/claim.mjs --confirm            # mint authorization + on-chain submit
```

`claim` enters the season automatically when the service returns 409 and follows the referral sweep across batches. Claim transactions cost no fee, but the wallet needs a dust CROSS balance to pass the node's minimum-gas-price check.

---

## Layout

```
skill-one-punch/                           # repo root = plugin
├── .claude-plugin/
│   └── plugin.json                        # plugin manifest
├── install.sh                             # symlink installer
├── README.md
├── LICENSE
└── skills/
    └── cross-prediction/                  # the skill itself
        ├── SKILL.md                       # what Claude reads to drive the market
        ├── package.json
        ├── .env.example
        ├── scripts/                       # 21 .mjs modules
        │   ├── _signer.mjs / _signer-a-viem.mjs / _wallets.mjs   # local signer + BIP-44 derivation
        │   ├── _markets.mjs / _strategy.mjs                      # market registry + season-aware routing
        │   ├── _auth.mjs / _order.mjs / _approval.mjs            # SIWE + EIP-712 + on-chain approve
        │   ├── _f2p.mjs / _chain.mjs / _guard.mjs                # F2P API + viem client + safety
        │   ├── buy.mjs / sell.mjs / redeem.mjs / balance.mjs / wallets.mjs
        │   ├── f2p-status.mjs / enter-season.mjs / claim.mjs
        │   └── list-events.mjs / get-event.mjs / get-results.mjs
        └── references/
            ├── api-map.md                 # discovered endpoints per market
            ├── chain-addresses.md         # collateral + CTF/Exchange addresses
            ├── ctf-basics.md              # 30s primer on Conditional Token math
            └── relayed-entry.md           # spec for gasless season entry (needs contract overload)
```

---

## Safety model

The skill enforces five independent rails:

1. **Chain-id check.** RPC client re-verifies `eth_chainId == 612055` and aborts on mismatch.
2. **Per-market trade caps.** Worst-case notional (`shares × maxPrice`) compared to `MAX_TRADE_ONEUSD` / `MAX_TRADE_POINT` before submission. Real money and free money get separate caps on purpose.
3. **User confirmation.** SKILL.md instructs Claude to require an explicit "yes / 진행" before live trades, rendering the parsed intent (event, side, price, amount, total, cap, chosen market) as a human summary first.
4. **Address mismatch abort.** The signer's derived EOA is compared to `WALLET_ADDRESS`; on mismatch the command aborts with `ADDRESS_MISMATCH`.
5. **DRY-RUN by default.** Every mutation previews unless `--live` / `--confirm` is passed.

Secrets handling: `PRIVATE_KEY` / `MNEMONIC` / SIWE-derived JWT never appear in the conversation transcript or in process argv (they go through `.env` / `process.env`). Auth state files are gitignored and never committed.

Why a single execution path: the CROSSx gateway signer shipped in earlier versions could sign payloads but never submit transactions, so it could not complete a buy, redeem, or claim. It was removed in v0.4.0 rather than left as a half-working option.

---

## Limitations

- **Prediction market only.** Gametoken DEX (`x.crosstoken.io`) is covered by [`cross-dex-trade`](https://github.com/to-nexus/skill-cross-dex-trade). Forge / swap-bridge / Rewards / NFT / Shop are out of scope.
- **POINT only exists during a season.** Between seasons the POINT market has zero events in every status; the skill falls back to USD automatically.
- **Season entry cannot be relayed.** The current contract only exposes `enterSeason(bytes)` and judges the user by `msg.sender`, so the entering wallet must hold dust gas and send the transaction itself. `mint` (claim) can be relayed. A gasless-entry contract overload is specced in `references/relayed-entry.md`; the skill detects it at runtime and will switch automatically if deployed.
- **`bill` and `cross` markets are retired.** Passing `--market=bill|cross` fails with a pointer to the live markets.

---

## License

[MIT](LICENSE) — but read the disclaimer at the bottom of the LICENSE file before using.
