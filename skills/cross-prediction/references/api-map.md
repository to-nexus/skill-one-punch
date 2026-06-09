# Internal API Map — CROSS Prediction APIs

**Default BILL Base URL**: `https://pred-bill-service-api.crossdefi.io/api/v1`
**Alternate CROSS Base URL**: `https://pred-cross-service-api.crossdefi.io/api/v1`
**Legacy Base URL**: `https://prediction-service-api.crossdefi.io/api/v1` (retired; CloudFront returns 502 because the origin domain no longer resolves)
**Mapped at**: 2026-04-24; default refreshed 2026-06-08 from live frontend bundle + direct probes.

## Response envelope

All responses follow this shape:
```json
{ "code": 200, "message": "OK", "data": { ... } }
```

On error: `code` is a negative number (e.g. `-30001` INVALID_PARAMETER, `-30002` VALIDATION_REQUIRED_FIELD, `-20006` AUTH_REQUIRED), HTTP status mirrors it (400/401/500).

## Public (no auth)

| # | Purpose | Verified | URL |
|---|---|---|---|
| 1 | Platform config — contract addresses | ✅ | `GET /config` |
| 2 | Active events list | ✅ | `GET /events?status=ACTIVE&limit={n}&page={n}&category={cat}&query={q}` |
| 3 | Closed events list | ✅ (currently empty) | `GET /events?status=CLOSED` |
| 4 | Event categories | ✅ | `GET /events/categories` |
| 5 | Event detail | ✅ | `GET /events/{eventId}` |
| 6 | Markets for event | ✅ | `GET /events/{eventId}/markets?status=ACTIVE\|REDEEMABLE\|CLOSED&limit={n}` |
| 7 | Market detail | ✅ | `GET /markets/{marketId}` |
| 8 | Market orderbook | ✅ | `GET /markets/{marketId}/orderbook?outcomeIndex={0\|1}` |
| 9 | Market candles | ✅ | `GET /markets/{marketId}/candles?interval={...}` |
| 10 | Index prices (oracle) | ✅ | `GET /index-prices/{SYMBOL}` (e.g. `BTCUSDT`) |
| 11 | WebSocket (live ticks) | (not exercised here) | service-specific `/api/v1/ws` — auth token via `getToken` callback |

### Valid enums (from error-driven discovery)

- **Event.status**: `ACTIVE`, `CLOSED` (others return `-30001 INVALID_PARAMETER`)
- **Market.status**: `ACTIVE` (tradable), `REDEEMABLE` (settled, shares can be redeemed), `CLOSED`
- **outcomeIndex**: `0` or `1` for binary markets. The outcome `name` (`"UP"`/`"DOWN"` or `"YES"`/`"NO"`) is per-market.

## Auth required (Bearer JWT)

| # | Purpose | URL | Notes |
|---|---|---|---|
| 12 | Login step 1: get nonce | `POST /login/unsigned-hash` | returns a hash to sign (SIWE-style) |
| 13 | Login step 2: exchange signed hash for JWT | `POST /login/token` | returns `{ accessToken, refreshToken }` |
| 14 | Refresh token | `POST /login/refresh` | |
| 15 | Logout | `POST /login/logout` | |
| 16 | Portfolio summary | `GET /portfolio/summary` | 401 w/o auth, confirmed |
| 17 | My open orders | `GET /portfolio/orders` | |
| 18 | My closed orders | `GET /portfolio/closed-orders` | |
| 19 | My positions | `GET /portfolio/positions` | — enables per-user settled PnL |
| 20 | My trades | `GET /portfolio/trades` | |
| 21 | My rebates | `GET /portfolio/rebates` | |
| 22 | My orders for market | `GET /markets/{id}/orders/me` | |
| 23 | Place limit order | `POST /orders/place/limit` | body below |
| 24 | Place market order | `POST /orders/place/market` | body below |
| 25 | Cancel order | `POST /orders/cancel` | |
| 26 | Cancel all | `POST /orders/cancel-all` | |
| 27 | Refund proof | `GET /markets/{id}/refund-proof` | for disputed markets |

## Order signing — EIP-712

```js
domain = {
  name: "PredictionExchange",
  version: "1",
  chainId: 612055,
  verifyingContract: /* exchangeContract.address from GET /config */
}

types.Order = [
  { name: "maker",       type: "address" },
  { name: "feePpm",      type: "uint32"  },
  { name: "side",        type: "uint8"   },  // BUY / SELL
  { name: "orderType",   type: "uint8"   },  // LIMIT / MARKET
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "tokenId",     type: "uint256" },  // outcome CTF token id
  { name: "expiration",  type: "uint256" },
  { name: "nonce",       type: "uint256" },  // read from exchange.getMinValidNonce(maker)
  { name: "salt",        type: "bytes32" }
]
primaryType: "Order"
```

Body posted to `/orders/place/limit`:
```json
{
  "marketId": "019dbf24-…",
  "tokenId": "0x4a7162…",           // from outcome.tokenId
  "oppositeTokenId": "0xc07be260…",
  "maker": "0x…",
  "side": 0,                         // 0=BUY 1=SELL (confirmed by code, not probed)
  "orderType": 1,                    // 1=LIMIT 0=MARKET
  "makerAmount": "…",                // wei, 18 decimals
  "takerAmount": "…",
  "expiration": 0,
  "nonce": "…",
  "salt": "0x…",
  "signature": "0x…"                 // EIP-712 signed by maker
}
```

## Login payload

Verified live sequence on 2026-06-08:
1. `POST https://cross-auth.crosstoken.io/cross-auth/login/unsigned-hash`
   with `{ address, domain: "https://prediction.crossdefi.io", chain_id: 612055 }`
   and `Origin` / `Referer` set to `https://prediction.crossdefi.io`.
2. Sign the returned SIWE message with the selected EOA signer.
3. `POST https://cross-auth.crosstoken.io/cross-auth/login/token`
   with `{ address, signature, domain: "https://prediction.crossdefi.io" }`
   → `{ token, refresh }`.
4. Send `Authorization: Bearer {accessToken}` on subsequent requests

Using bare `prediction.crossdefi.io` as the domain can mint a token that the prediction API rejects with `Session token invalid or revoked`.

## Redemption

Winning settled CTF shares redeem through the CTF contract, not the REST API:

```solidity
redeemPositions(
  address collateralToken,      // BILL
  bytes32 parentCollectionId,   // 0x00...00
  bytes32 conditionId,
  uint256[] indexSets           // outcomeIndex 0 => [1], outcomeIndex 1 => [2]
)
```

CROSSx embedded-wallet side (for users without an exported EOA):
- `https://cross-auth.crosstoken.io/…` (Google/Apple OAuth entry)
- `https://embedded-wallet-gateway.crosstoken.io/api/v1/…` (PIN auth + wallet ops, including `/mnemonic/*` → PK export likely supported)

## Embedded wallet / SDK

**CROSSx** (custom CROSS ecosystem wallet). Not Privy / Web3Auth / Magic / Dynamic.
- Connector id `"crossx"`, also supports `io.metamask` and `com.binance.wallet` via EIP-6963.
- WalletConnect projectId (app-level): `a95e46c310c7cd2011cb3fd13eb4a317`.
- Env map hardcoded in prod bundle: `cross-wallet-oauth.crosstoken.io`, `cross-auth.crosstoken.io`, `embedded-wallet-gateway.crosstoken.io/api/v1`.

## Not explored (TBD)

- WS frame schemas (auth handshake, subscribe topics, diff format)
- `GET /markets/{id}/trades` → returned 500 on probe, may be bug or needs auth
- `GET /faucet/*` (likely testnet only)
- Exact `side` / `orderType` int values (derived from code but not runtime-confirmed)
