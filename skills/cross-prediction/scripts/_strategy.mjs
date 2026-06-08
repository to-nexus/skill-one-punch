// _strategy.mjs — pick the right execution strategy from environment.
//
//   STRATEGY=A → require PRIVATE_KEY            (local viem signer; fastest, full control)
//   STRATEGY=C → require PIN                    (CROSSx gateway remote signer)
//   STRATEGY=auto (default) → pick the highest-fidelity option that has its
//                              prerequisites met, in order: A → C.
//
// Returning a `Plan` object keeps the dispatch site (buy.mjs / sell.mjs) tiny.

function envHas(name, pattern) {
  const v = process.env[name];
  return typeof v === 'string' && (!pattern || pattern.test(v));
}

function detectAvailable() {
  return {
    A: envHas('PRIVATE_KEY', /^0x[0-9a-fA-F]{64}$/),
    C: envHas('PIN', /^\d{6}$/),
  };
}

/**
 * Resolve the strategy.
 *
 *  override: explicit "A"|"C" from CLI flag (--strategy=…).
 *  Returns:  { strategy, available, reason }
 *  Throws:   { code: "NO_STRATEGY", message } if nothing usable.
 */
export function resolveStrategy({ override } = {}) {
  const requested = (override ?? process.env.STRATEGY ?? 'auto').toUpperCase();
  const avail = detectAvailable();

  if (requested === 'B') {
    const e = new Error('Requested strategy was removed from the distributable skill because web-login state reuse is not an allowed execution path. Use STRATEGY=A or STRATEGY=C.');
    e.code = 'STRATEGY_REMOVED';
    e.available = avail;
    throw e;
  }

  if (requested === 'A' || requested === 'C') {
    if (!avail[requested]) {
      const e = new Error(reasonMissing(requested));
      e.code = 'STRATEGY_PREREQ_MISSING';
      e.requested = requested;
      e.available = avail;
      throw e;
    }
    return { strategy: requested, available: avail, reason: 'forced by user' };
  }

  if (requested !== 'AUTO') {
    const e = new Error(`Unknown STRATEGY=${requested}. Valid: A, C, auto.`);
    e.code = 'BAD_STRATEGY';
    throw e;
  }

  // auto: prefer A → C
  if (avail.A) return { strategy: 'A', available: avail, reason: 'PRIVATE_KEY present (local viem signer)' };
  if (avail.C) return { strategy: 'C', available: avail, reason: 'PIN present (gateway signer)' };

  const e = new Error(
    'No usable trading strategy. Provide one of:\n' +
    '  • local signer env/config (Strategy A — viem)\n' +
    '  • PIN=123456 + configured CROSSx gateway (Strategy C)',
  );
  e.code = 'NO_STRATEGY';
  e.available = avail;
  throw e;
}

function reasonMissing(strategy) {
  switch (strategy) {
    case 'A': return 'STRATEGY=A requires PRIVATE_KEY (0x + 64 hex) in env.';
    case 'C': return 'STRATEGY=C requires PIN (6 digits) AND a configured gateway (CROSSX_GATEWAY_BASE + CROSSX_AUTH_TOKEN or .session/gateway.json).';
    default:  return `unknown strategy ${strategy}`;
  }
}

/** Build a signer for A/C. */
export async function buildSigner(strategy) {
  if (strategy === 'A') {
    const { createViemSigner } = await import('./_signer-a-viem.mjs');
    return createViemSigner(process.env.PRIVATE_KEY);
  }
  if (strategy === 'C') {
    const { createGatewaySigner } = await import('./_signer-c-gateway.mjs');
    return createGatewaySigner({ pin: process.env.PIN });
  }
  throw new Error(`buildSigner: unsupported strategy ${strategy}`);
}
