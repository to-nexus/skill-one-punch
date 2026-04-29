# CROSS Chain Addresses (for cross-prediction skill)

Chain id: **612055** · Mainnet RPC: `https://mainnet.crosstoken.io:22001/` · Explorer: `https://explorer.crosstoken.io/612055`

## Captured from `GET /api/v1/config` (2026-04-24)

| Role | Address | Standard | Notes |
|---|---|---|---|
| **BILL** (quote / collateral) | `0xA6272D8053B4F5d5F7943dfBc1039B1cedebf3d4` | ERC-20 (18 decimals) | `name="BILLIONS"`, `symbol="BILL"` |
| **CTF** (Conditional Token) | `0x31677b2427ded0badf00b834a5ae13c3fc999859` | ERC-1155 | Mints outcome Shares per `tokenId` |
| **Exchange** | `0xb39faa85f5c353db5bd71f6f2a48bc7d6dc08fd9` | custom | EIP-712 `PredictionExchange v1`. `getMinValidNonce(maker)` for order nonce. |

> `GET /config` is the source of truth — if the service rotates contracts, `_chain.mjs` should refetch once per process. Hardcoding these addresses is a convenience; always validate on startup.

## CTF token id convention

Each market's outcomes carry a `tokenId` (bytes32, 64-char hex) that doubles as the ERC-1155 `id` on the CTF contract. Example from a REDEEMABLE BTC-1min market:

```json
"outcomes": [
  { "outcomeIndex": 0, "name": "UP",   "tokenId": "0x4a7162f8426d0c4e730e1bbdbf318f5d0ca738ff07e60a10f95e53fd424af907" },
  { "outcomeIndex": 1, "name": "DOWN", "tokenId": "0xc07be260675d8818b0664505fc4afa13ed8e1b0189fcc4814e1b74aabb4f8f63" }
]
```

To check a wallet's Share balance: `CTF.balanceOf(walletAddress, uint256(tokenId))`.
To check multiple markets at once: `CTF.balanceOfBatch([addr, addr, …], [id1, id2, …])`.

Resolution fields appear on REDEEMABLE markets:
```json
{ "outcomeIndex": 0, "name": "UP", "isWinner": true,  "payoutNumerator": "1" },
{ "outcomeIndex": 1, "name": "DOWN", "isWinner": false, "payoutNumerator": "0" }
```

Winning Share → `1 BILL` redemption; losing Share → `0 BILL`; tie/void → 0.5 BILL each side.
