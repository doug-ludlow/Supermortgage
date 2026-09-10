/**
 * Engine B for 7.2 (`verifyArmAdjustment`): an independent re-implementation
 * of the adjustment arithmetic in BigInt fixed-point (7.2 decision 6:
 * "separate TypeScript module with decimal.js replaced by BigInt fixed-point
 * arithmetic"). It shares nothing with engine A but the input/output types —
 * no Decimal, no levelPayment, no kernel rounding helpers — so a defect in
 * one engine cannot hide in the other. Both must agree to the cent before a
 * (c)/(d) notice renders (`SM_ARM_DUAL_CALC_VERIFY_T0`).
 */
import type { ArmAdjustmentInput, ArmAdjustmentResult, RateBound } from "./arm.ts";

const RATE_DP = 8;                                   // rates carry 8 decimal places (7.2 rule 2)
const RATE_SCALE = 10n ** BigInt(RATE_DP);
const EIGHTH = RATE_SCALE / 8n;                      // 0.125 % at RATE_SCALE
const PREC = 10n ** 40n;                             // fixed-point scale of the amortization factor

/** Parse a percent string ("6.375", "3.64883") to RATE_SCALE; more than 8 places is rejected, not truncated. */
export function parseRate8(s: string): bigint {
  const m = /^([+-]?)(\d+)(?:\.(\d{1,8}))?$/.exec(s.trim());
  if (!m) throw new TypeError(`engine B: not a rate with ≤ ${RATE_DP} decimal places: ${JSON.stringify(s)}`);
  const v = BigInt(m[2]! + (m[3] ?? "").padEnd(RATE_DP, "0"));
  return m[1] === "-" ? -v : v;
}
/** Integer division rounded half away from zero (the spec's round_half_up). */
export function divHalfUp(n: bigint, d: bigint): bigint {
  if (d < 0n) { n = -n; d = -d; }
  const neg = n < 0n; const a = neg ? -n : n;
  const q = a / d; const r = a % d;
  const out = r * 2n >= d ? q + 1n : q;
  return neg ? -out : out;
}
/** Format a RATE_SCALE value with `dp` places (half-up). */
export function formatRate8(v: bigint, dp: number): string {
  const scaled = divHalfUp(v, 10n ** BigInt(RATE_DP - dp));
  const neg = scaled < 0n; const abs = (neg ? -scaled : scaled).toString().padStart(dp + 1, "0");
  return `${neg ? "-" : ""}${abs.slice(0, abs.length - dp)}.${abs.slice(-dp)}`;
}
/** Nearest one-eighth at RATE_SCALE; exact midpoints follow the rounding rule (default half-down, B2-1.4-02). */
export function roundToEighth8(v: bigint, rule: "half_down" | "half_up"): { rate: bigint; midpoint: boolean } {
  const q = v / EIGHTH; const rem = v - q * EIGHTH; const half = EIGHTH / 2n;
  const midpoint = rem === half;
  const up = rem > half || (midpoint && rule === "half_up");
  return { rate: (up ? q + 1n : q) * EIGHTH, midpoint };
}
/** Level payment in cents from a RATE_SCALE annual rate: P·r·(1+r)^n / ((1+r)^n − 1), r = rate/1200, at PREC. */
export function levelPaymentCents8(upbCents: bigint, rate8: bigint, months: number): bigint {
  if (months <= 0) throw new RangeError("months must be positive");
  if (rate8 === 0n) return divHalfUp(upbCents, BigInt(months));
  const r = (rate8 * PREC) / (1200n * RATE_SCALE);          // monthly rate at PREC
  let g = PREC;                                             // (1+r)^n at PREC
  for (let k = 0; k < months; k++) g = (g * (PREC + r)) / PREC;
  return divHalfUp(upbCents * r * g, PREC * (g - PREC));
}

/** Engine B (7.2 tool `verifyArmAdjustment`); with engine A's result it reports agreement to the cent. */
export function verifyArmAdjustment(i: ArmAdjustmentInput, a?: ArmAdjustmentResult): ArmAdjustmentResult & { agrees: boolean | null; discrepancy: string | null } {
  const unrounded = parseRate8(i.index_pct) + parseRate8(i.margin_pct);
  let rate = roundToEighth8(unrounded, i.rounding ?? "half_down").rate;
  const prior = parseRate8(i.prior_rate_pct); const cap = parseRate8(i.first_change ? i.initial_cap_pct : i.periodic_cap_pct);
  let bound: RateBound = "none";
  if (rate > prior + cap) { rate = prior + cap; bound = i.first_change ? "initial" : "periodic"; }
  else if (rate < prior - cap) { rate = prior - cap; bound = i.first_change ? "initial" : "periodic"; }
  const life = parseRate8(i.initial_note_rate_pct) + parseRate8(i.lifetime_cap_pct); if (rate > life) { rate = life; bound = "lifetime"; }
  const floor = parseRate8(i.margin_pct); if (rate < floor) { rate = floor; bound = "floor"; }
  const pi = i.interest_only ? divHalfUp(i.expected_upb_cents * rate, 1200n * RATE_SCALE) : levelPaymentCents8(i.expected_upb_cents, rate, i.remaining_term_months);
  const res: ArmAdjustmentResult = { new_rate_pct: formatRate8(rate, 3), unrounded_pct: formatRate8(unrounded, 5), bound, new_pi_cents: pi, engine: "B" };
  if (!a) return { ...res, agrees: null, discrepancy: null };
  const diffs = [a.new_rate_pct !== res.new_rate_pct ? `rate ${a.new_rate_pct} vs ${res.new_rate_pct}` : null, a.new_pi_cents !== res.new_pi_cents ? `payment ${a.new_pi_cents} vs ${res.new_pi_cents}` : null].filter((x): x is string => x !== null);
  return { ...res, agrees: diffs.length === 0, discrepancy: diffs.length ? diffs.join("; ") : null };
}
