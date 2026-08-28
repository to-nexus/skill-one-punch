# Relayed season entry — contract change proposal

## Problem

Claiming POINT requires two on-chain calls:

| Call | Signature | Who can submit |
|---|---|---|
| `mint` | `mint(address to, bytes32[] labels, uint256[] amounts, uint256 deadline, bytes signature)` | anyone — the recipient is an argument bound into the server's signature |
| `enterSeason` | `enterSeason(bytes signature)` | **only the user** — no user argument, so the contract must read `msg.sender` |

Entering the season is a prerequisite for claiming and for placing POINT orders,
so the second row gates the whole loop. The consequence:

- The user's own wallet must submit a transaction, so it needs a gas balance and
  a key the client can sign with.
- A relayer cannot complete the flow on the user's behalf even though the server
  already authorized the action.

Verified on the deployed contract (proxy `0xF0CA…9583`, implementation
`0xfa76…bb70`): the implementation exposes selector `2f924634`
(`enterSeason(bytes)`) and none of `enterSeason(address,bytes)`,
`enterSeasonFor(address,bytes)`, or `enterSeasonWithSig(address,bytes)`.
`mint(address,bytes32[],uint256[],uint256,bytes)` (`0725f3ba`) is present.

## Proposed change

Add an overload that takes the user explicitly, and bind that address into the
signed payload so the signature — not `msg.sender` — is the authority:

```solidity
/// @notice Enter the current season on behalf of `user`.
/// @dev The server signature must cover `user`, so any address may submit.
///      Keeps the existing enterSeason(bytes) for backward compatibility.
function enterSeason(address user, bytes calldata signature) external;
```

Requirements:

1. The EIP-712 payload the backend signs must include `user`. It already carries
   a `user` field (`typedData.message.user` is returned by
   `POST /f2p/season/enter`), so this is likely a verification change only, not a
   payload change.
2. Replay protection must be per `user`, not per `msg.sender` — a nonce or a
   `hasEntered[seasonId][user]` guard.
3. Keep `enterSeason(bytes)` so existing clients keep working; implement it as
   `enterSeason(msg.sender, signature)`.

## What it unlocks

With both calls relayer-submittable, the server (or any funded relayer) can
complete season entry and claiming for a user who never holds gas and never
exports a key. That removes the two hardest steps in onboarding a
social-login account:

- no key export, so no full-authority secret leaves the CROSSx wallet
- no gas funding step for the user

The client's only remaining job is producing a SIWE signature to authenticate,
which the CROSSx gateway already supports (`signMessage`).

## Skill support

`_f2p.mjs` detects the overload at runtime via `supportsRelayedEntry()`. When the
selector is present on the implementation, `enterSeasonCall()` returns the
two-argument form so a relayer can submit; otherwise it falls back to the
one-argument form and the user's own wallet must send it. No skill change is
needed when the contract ships — the capability is picked up automatically.
