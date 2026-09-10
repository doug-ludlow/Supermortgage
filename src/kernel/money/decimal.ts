/**
 * Fixed-scale decimal arithmetic on bigint.
 *
 * The spec asks for `decimal.js` precision 20 for rate/amortization math and
 * integer cents for every stored money value. `Decimal` covers the former with
 * zero dependencies: every value is `unscaled / 10^SCALE`, all ops are exact
 * except division and `pow`, which round to SCALE with the rounding mode given.
 */

export const SCALE = 30;
const TEN = 10n;
export const ONE_UNIT = TEN ** BigInt(SCALE);

export type Rounding = "HALF_UP" | "HALF_EVEN" | "DOWN" | "UP" | "FLOOR" | "CEIL";

/** Integer division of `n / d` with the given rounding. `d` must be non-zero. */
export function divRound(n: bigint, d: bigint, mode: Rounding = "HALF_UP"): bigint {
  if (d === 0n) throw new RangeError("division by zero");
  if (d < 0n) { n = -n; d = -d; }
  const q = n / d;           // truncates toward zero
  const r = n % d;           // sign follows n
  if (r === 0n) return q;
  const negative = n < 0n;
  const twiceAbsR = (negative ? -r : r) * 2n;
  switch (mode) {
    case "DOWN": return q;
    case "UP": return negative ? q - 1n : q + 1n;
    case "FLOOR": return negative ? q - 1n : q;
    case "CEIL": return negative ? q : q + 1n;
    case "HALF_UP": // half away from zero (Java BigDecimal ROUND_HALF_UP)
      if (twiceAbsR >= d) return negative ? q - 1n : q + 1n;
      return q;
    case "HALF_EVEN":
      if (twiceAbsR > d) return negative ? q - 1n : q + 1n;
      if (twiceAbsR < d) return q;
      return (q % 2n === 0n) ? q : (negative ? q - 1n : q + 1n);
  }
}

export class Decimal {
  readonly unscaled: bigint;
  private constructor(unscaled: bigint) { this.unscaled = unscaled; }

  static ZERO = new Decimal(0n);
  static ONE = new Decimal(ONE_UNIT);

  static fromUnscaled(u: bigint): Decimal { return new Decimal(u); }
  static fromBigInt(i: bigint): Decimal { return new Decimal(i * ONE_UNIT); }
  static fromInt(i: number): Decimal {
    if (!Number.isInteger(i)) throw new TypeError(`fromInt expects an integer, got ${i}`);
    return Decimal.fromBigInt(BigInt(i));
  }
  /** Parse "6.375", "-0.05", "1e-3" is NOT supported — plain decimal strings only. */
  static parse(s: string): Decimal {
    const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
    if (!m) throw new TypeError(`not a plain decimal string: ${JSON.stringify(s)}`);
    const [, sign, intPart, fracPart = ""] = m;
    if (fracPart.length > SCALE) throw new RangeError(`more than ${SCALE} decimal places: ${s}`);
    const digits = intPart + fracPart.padEnd(SCALE, "0");
    const u = BigInt(digits);
    return new Decimal(sign === "-" ? -u : u);
  }
  /** Ratio n/d as a Decimal (rounded to SCALE). */
  static ratio(n: bigint, d: bigint, mode: Rounding = "HALF_EVEN"): Decimal {
    return new Decimal(divRound(n * ONE_UNIT, d, mode));
  }

  add(o: Decimal): Decimal { return new Decimal(this.unscaled + o.unscaled); }
  sub(o: Decimal): Decimal { return new Decimal(this.unscaled - o.unscaled); }
  neg(): Decimal { return new Decimal(-this.unscaled); }
  mul(o: Decimal, mode: Rounding = "HALF_EVEN"): Decimal {
    return new Decimal(divRound(this.unscaled * o.unscaled, ONE_UNIT, mode));
  }
  div(o: Decimal, mode: Rounding = "HALF_EVEN"): Decimal {
    return new Decimal(divRound(this.unscaled * ONE_UNIT, o.unscaled, mode));
  }
  /** Integer power by repeated squaring; negative exponents via reciprocal. */
  pow(n: number): Decimal {
    if (!Number.isInteger(n)) throw new TypeError("pow expects an integer exponent");
    if (n < 0) return Decimal.ONE.div(this.pow(-n));
    let result = Decimal.ONE;
    let base: Decimal = this;
    let e = n;
    while (e > 0) {
      if (e & 1) result = result.mul(base);
      e >>= 1;
      if (e > 0) base = base.mul(base);
    }
    return result;
  }
  cmp(o: Decimal): -1 | 0 | 1 {
    return this.unscaled < o.unscaled ? -1 : this.unscaled > o.unscaled ? 1 : 0;
  }
  isZero(): boolean { return this.unscaled === 0n; }
  isNegative(): boolean { return this.unscaled < 0n; }
  abs(): Decimal { return this.unscaled < 0n ? this.neg() : this; }

  /** Round to `places` decimal places, returning the integer at that scale. */
  toScaledInt(places: number, mode: Rounding = "HALF_UP"): bigint {
    if (places < 0 || places > SCALE) throw new RangeError("places out of range");
    return divRound(this.unscaled, TEN ** BigInt(SCALE - places), mode);
  }
  /** Round to whole cents (2 places). */
  toCents(mode: Rounding = "HALF_UP"): bigint { return this.toScaledInt(2, mode); }

  toString(): string {
    const neg = this.unscaled < 0n;
    const abs = (neg ? -this.unscaled : this.unscaled).toString().padStart(SCALE + 1, "0");
    const int = abs.slice(0, abs.length - SCALE);
    const frac = abs.slice(abs.length - SCALE).replace(/0+$/, "");
    return (neg ? "-" : "") + int + (frac ? "." + frac : "");
  }
  toFixed(places: number, mode: Rounding = "HALF_UP"): string {
    const v = this.toScaledInt(places, mode);
    const neg = v < 0n;
    const abs = (neg ? -v : v).toString().padStart(places + 1, "0");
    if (places === 0) return (neg ? "-" : "") + abs;
    return (neg ? "-" : "") + abs.slice(0, -places) + "." + abs.slice(-places);
  }
}
