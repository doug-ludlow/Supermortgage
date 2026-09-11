/**
 * 32.14 S1 — typed money → a decimal string of integer cents, with no float arithmetic
 * (docs/ux/13 T-X-09; docs/ARCHITECTURE.md bigint cents). "$300,000" → "30000000";
 * "1,250.5" → "125050"; "$0.99" → "99". The text is split on the decimal point and the
 * fraction is truncated to two digits — no Number(), no parseFloat, no rounding.
 */
import type { Cents } from "@/lib/types/cards";

/** Parse what a visitor types into a money field. Returns null when there is no amount in it. */
export function parseMoneyToCents(text: string): Cents | null {
  const cleaned = text.replace(/[$,\s_]/g, "");
  if (cleaned.length === 0) return null;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!m) return null;
  const whole = m[1] ?? "";
  const frac = m[2] ?? "";
  if (whole.length === 0 && frac.length === 0) return null;
  const cents = `${whole.length ? whole : "0"}${frac.slice(0, 2).padEnd(2, "0")}`;
  // BigInt normalizes leading zeros exactly ("000123" → "123"); it is integer-only by construction.
  return BigInt(cents).toString();
}
