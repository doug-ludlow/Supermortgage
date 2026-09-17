/**
 * Formatting for the partner console. Money arrives from /v1/partner/* as a decimal string of integer cents
 * (34.3's rows, 36.3 rule 5) and is handled as `bigint`; rates arrive as the tape's percent strings. Both are
 * handed to `Intl.NumberFormat` as *strings* (it formats a decimal string exactly), so there is no float
 * arithmetic anywhere in the client and never a number dollar (apps/borrower's rule, kept here verbatim).
 */
const LOCALE = "en-US";
const usd = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rate3 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
export const EMPTY = "—";

/** Parse a decimal string of cents to bigint. Throws on anything that is not an integer string. */
export function toCents(value: string | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!/^-?\d+$/.test(value)) throw new TypeError(`not a cents string: ${JSON.stringify(value)}`);
  return BigInt(value);
}

/** "$441,366.13" from "44136613"; null → "—". Exact: the string is split as bigint, never divided as a float. */
export function formatMoney(value: string | bigint | null | undefined): string {
  if (value === null || value === undefined || value === "") return EMPTY;
  const cents = toCents(value);
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const decimal = `${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
  const s = usd.format(decimal as unknown as number);   // Intl formats a decimal string exactly (no Number())
  return negative ? `−${s}` : s;
}

/** "7.250%" from the tape's "7.25"; null → "—". */
export function formatRate(rate: string | null | undefined): string {
  if (rate === null || rate === undefined || rate === "") return EMPTY;
  if (!/^-?\d+(\.\d+)?$/.test(rate)) throw new TypeError(`not a rate string: ${JSON.stringify(rate)}`);
  return `${rate3.format(rate as unknown as number)}%`;
}

/** A civil date "2026-09-01" → "Sep 1, 2026"; an instant → its date in America/New_York; null → "—". */
export function formatDate(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const civil = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (civil) {
    const d = new Date(Date.UTC(+civil[1]!, +civil[2]! - 1, +civil[3]!));
    return new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(d);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat(LOCALE, { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(d);
}

/** An instant → "Sep 15, 2026, 7:05 AM ET"; null → "—". */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${new Intl.DateTimeFormat(LOCALE, { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d)} ET`;
}

/** A masked loan number: never more than the last four. */
export function mask4(last4: string | null | undefined): string {
  return last4 ? `••••${last4.slice(-4)}` : EMPTY;
}

/** "3 loans" / "1 loan". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A snake_case code as words ("not_on_latest_tape" → "not on latest tape"). */
export function words(code: string | null | undefined): string {
  return code ? code.replace(/_/g, " ") : EMPTY;
}
