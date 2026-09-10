/**
 * Money is always integer cents (`bigint`), never floats — matching the
 * baseline data model where every money column is `bigint` cents.
 */
import { Decimal, divRound, type Rounding } from "./decimal.ts";

export type Cents = bigint;

export function cents(dollars: string | number): Cents {
  if (typeof dollars === "number") {
    if (!Number.isFinite(dollars)) throw new TypeError("non-finite amount");
    // Numbers are accepted only for literals; go through the string path to avoid float drift.
    return cents(dollars.toFixed(2));
  }
  const m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(dollars.trim().replace(/,/g, ""));
  if (!m) throw new TypeError(`not a dollar amount with ≤2 decimals: ${JSON.stringify(dollars)}`);
  const [, sign, int = "0", frac = ""] = m;
  const v = BigInt(int) * 100n + BigInt(frac.padEnd(2, "0"));
  return sign === "-" ? -v : v;
}

export function formatCents(c: Cents, opts: { symbol?: boolean; grouping?: boolean } = {}): string {
  const neg = c < 0n;
  const abs = (neg ? -c : c).toString().padStart(3, "0");
  let int = abs.slice(0, -2);
  const frac = abs.slice(-2);
  if (opts.grouping !== false) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${opts.symbol === false ? "" : "$"}${int}.${frac}`;
}

export function centsToDecimal(c: Cents): Decimal { return Decimal.ratio(c, 100n); }

/** Annual rate expressed as a percentage string, e.g. "6.375" for 6.375%. */
export function ratePercent(pct: string): Decimal { return Decimal.parse(pct).div(Decimal.fromInt(100)); }

/**
 * Scheduled monthly interest per F-1-09 / the boarding spec:
 *   scheduled_interest = round_half_up(UPB_cents × note_rate / 12)
 * Worked example in 1.1: UPB $245,634.12 at 6.375% → $1,304.93.
 */
export function monthlyInterest(upbCents: Cents, annualRate: Decimal, mode: Rounding = "HALF_UP"): Cents {
  // upb × rate / 12, all exact until the final rounding to cents.
  const num = upbCents * annualRate.unscaled;
  const den = 12n * Decimal.ONE.unscaled;
  return divRound(num, den, mode);
}

/**
 * Level payment on an amortizing loan:
 *   P&I = UPB × r / (1 − (1+r)^−n),  r = note_rate / 12
 * Computed at Decimal scale, rounded to cents half-up (the spec's `HF-005`
 * recomputation uses this on the original UPB and original term).
 */
export function levelPayment(upbCents: Cents, annualRate: Decimal, termMonths: number): Cents {
  if (termMonths <= 0) throw new RangeError("termMonths must be positive");
  const principal = centsToDecimal(upbCents);
  if (annualRate.isZero()) return divRound(upbCents, BigInt(termMonths), "HALF_UP");
  const r = annualRate.div(Decimal.fromInt(12));
  const growth = Decimal.ONE.add(r).pow(termMonths);          // (1+r)^n
  // P × r × (1+r)^n / ((1+r)^n − 1)  — algebraically identical, avoids the negative power.
  const pmt = principal.mul(r).mul(growth).div(growth.sub(Decimal.ONE));
  return pmt.toCents("HALF_UP");
}

/** Absolute difference in cents. */
export function absDiff(a: Cents, b: Cents): Cents { const d = a - b; return d < 0n ? -d : d; }

export function sumCents(xs: Iterable<Cents>): Cents { let s = 0n; for (const x of xs) s += x; return s; }

/**
 * Allocate `total` across `weights` proportionally with largest-remainder so
 * the parts always sum exactly to `total` (no lost or invented cents).
 */
export function allocateProportional(total: Cents, weights: readonly bigint[]): Cents[] {
  const wsum = weights.reduce((a, b) => a + b, 0n);
  if (wsum <= 0n) throw new RangeError("weights must sum to a positive value");
  const parts = weights.map((w) => (total * w) / wsum);
  let remainder = total - parts.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, frac: (total * w) % wsum }))
    .sort((a, b) => (a.frac === b.frac ? a.i - b.i : a.frac > b.frac ? -1 : 1));
  const step = remainder < 0n ? -1n : 1n;
  for (const { i } of order) {
    if (remainder === 0n) break;
    parts[i] = (parts[i] as bigint) + step;
    remainder -= step;
  }
  return parts;
}
