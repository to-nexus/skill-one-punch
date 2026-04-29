# Conditional Token Framework — 30-second primer

The CROSS Prediction market uses a Conditional Token Framework (CTF), the same pattern popularized by Polymarket. You need three mental models to reason about trades:

## 1. Collateral ↔ Share pair

Splitting `N` BILL creates `N` YES-shares **and** `N` NO-shares (bound together).
When the market resolves:
- If YES wins → each YES-share redeems for 1 BILL, each NO-share → 0
- If NO wins → the reverse
- If the market voids → each side redeems for 0.5 BILL (tie payout)

`split(marketId, N BILL) → N YES + N NO shares`
`merge(marketId, N YES + N NO) → N BILL`

## 2. The orderbook is about price per share

Prices are always in `[0, 1] BILL`. The YES and NO prices sum to ≈ 1 (minus spread).

A "limit buy YES at 0.52 for 10 shares" means: I lock up `10 × 0.52 = 5.2 BILL`, and in return I get 10 YES shares if filled.

## 3. Settlement

- Event markets: UMA Optimistic Oracle + Polymarket API cross-verification.
- Crypto (BTC 1-min) markets: volume-weighted internal price feed.
- 1-hour cooling period before Redeem is enabled.
- Disputed or voided → tie payout (0.5 BILL per share each side).

Until Redeem is called, winning shares sit in your wallet and simply represent a claim — your balance in BILL doesn't change.

---

See `chain-addresses.md` for the actual CTF contract address once captured.
