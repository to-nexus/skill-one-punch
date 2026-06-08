// _signer.mjs — common signer interface used by Strategy A and Strategy C.
//
// A `Signer` abstracts away "who actually holds the key":
//   - Strategy A: a viem account derived from PRIVATE_KEY (local).
//   - Strategy C: a CROSSx embedded-wallet gateway client (remote, PIN-gated).
//
// All distributable trading strategies use this interface.
//
// All signers MUST expose:
//   strategy            : "A" | "C"
//   address             : 0x… EIP-55 EOA
//   signMessage(text)   : EIP-191 personal_sign over a UTF-8 string → 0x…
//   signTypedData(args) : EIP-712 typed-data sign → 0x…
//                          args = { domain, types, primaryType, message }
//   close()             : best-effort teardown (idempotent)

export const SIGNER_INTERFACE = Object.freeze([
  'strategy', 'address', 'signMessage', 'signTypedData', 'close',
]);

export function assertSignerShape(s) {
  for (const key of SIGNER_INTERFACE) {
    if (s == null || s[key] === undefined) {
      throw new Error(`signer is missing required field: ${key}`);
    }
  }
  return s;
}
