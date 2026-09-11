/**
 * Formatting for the 01 §7.4 tokens: {{money(x)}}, {{rate(x)}}, {{date(x)}}, {{count}}.
 *
 * Money arrives as a decimal string of integer cents and is handled as `bigint`;
 * rates arrive as decimal strings in percent units. Both are handed to
 * `Intl.NumberFormat` as *strings* (Intl.NumberFormat v3 formats a decimal string
 * exactly), so there is no float arithmetic anywhere in the client (13 §3 T-X-09).
 */
import type { Cents, Rate } from "@/lib/types/cards";

const LOCALE = "en-US";

const usd = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdWhole = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });

/** Parse a decimal string of cents to bigint. Throws on anything that is not an integer string. */
export function toCents(value: Cents | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!/^-?\d+$/.test(value)) throw new TypeError(`not a cents string: ${JSON.stringify(value)}`);
  return BigInt(value);
}

/** Split signed cents into a sign and an exact "dollars.cc" decimal string. */
function centsToDecimalString(cents: bigint): { negative: boolean; decimal: string } {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return { negative, decimal: `${whole}.${frac.toString().padStart(2, "0")}` };
}

/** {{money(x)}} — "$560,000.00"; `whole: true` drops the cents when they are zero ("$560,000"). */
export function formatMoney(value: Cents | bigint, opts: { whole?: boolean } = {}): string {
  const cents = toCents(value);
  const { negative, decimal } = centsToDecimalString(cents);
  const fmt = opts.whole && cents % 100n === 0n ? usdWhole : usd;
  // Intl.NumberFormat accepts a decimal string and formats it exactly (no Number()).
  const s = fmt.format(decimal as unknown as number);
  return negative ? `−${s}` : s;
}

/** Signed variant for savings/deltas: "+$212.40" / "−$50.00". */
export function formatMoneySigned(value: Cents | bigint): string {
  const cents = toCents(value);
  const base = formatMoney(cents < 0n ? -cents : cents);
  return cents < 0n ? `−${base}` : `+${base}`;
}

/** Exact bigint sum of cents strings — the only arithmetic the client ever does on money. */
export function sumCents(...values: (Cents | bigint)[]): bigint {
  return values.reduce<bigint>((acc, v) => acc + toCents(v), 0n);
}

const rate3 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** {{rate(x)}} — "6.125%". Input is a decimal string in percent units; trailing zeros beyond 3 places are trimmed exactly by Intl. */
export function formatRate(rate: Rate): string {
  if (!/^-?\d+(\.\d+)?$/.test(rate)) throw new TypeError(`not a rate string: ${JSON.stringify(rate)}`);
  return `${rate3.format(rate as unknown as number)}%`;
}

export type DateStyle = "date" | "datetime" | "time" | "month";

/** {{date(x)}} — in the borrower's time zone. "Oct 22, 2026" / "Oct 22, 2026 9:41 AM". */
export function formatDate(iso: string, timeZone: string, style: DateStyle = "date"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const base: Intl.DateTimeFormatOptions = { timeZone };
  const opts: Intl.DateTimeFormatOptions =
    style === "date"
      ? { ...base, month: "short", day: "numeric", year: "numeric" }
      : style === "datetime"
        ? { ...base, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
        : style === "time"
          ? { ...base, hour: "numeric", minute: "2-digit" }
          : { ...base, month: "long", year: "numeric" };
  return new Intl.DateTimeFormat(LOCALE, opts).format(d);
}

/** Day-divider label: "Today", "Yesterday", or the date; computed by civil date in the borrower's zone. */
export function civilDate(iso: string, timeZone: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function dayDividerLabel(iso: string, timeZone: string, now: Date = new Date()): string {
  const day = civilDate(iso, timeZone);
  const today = civilDate(now.toISOString(), timeZone);
  const yesterday = civilDate(new Date(now.getTime() - 86_400_000).toISOString(), timeZone);
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  return new Intl.DateTimeFormat(LOCALE, { timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(iso));
}

/** Countdown text for `expires_at` < 72h (01 §3): "2 days 4 hours left" / "expired". Integer arithmetic on milliseconds only. */
export function countdown(expiresAt: string, now: Date = new Date()): { text: string; under72h: boolean; expired: boolean } {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(ms)) return { text: "", under72h: false, expired: false };
  if (ms <= 0) return { text: "expired", under72h: true, expired: true };
  const under72h = ms < 72 * 3_600_000;
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  const text = days > 0 ? `${days} day${days === 1 ? "" : "s"} ${remH} hour${remH === 1 ? "" : "s"} left` : hours > 0 ? `${hours} hour${hours === 1 ? "" : "s"} ${mins} min left` : `${mins} min left`;
  return { text, under72h, expired: false };
}

/** Is a deadline within 3 days (caution styling, 01 §2)? */
export function withinDays(iso: string, days: number, now: Date = new Date()): boolean {
  const ms = new Date(iso).getTime() - now.getTime();
  return ms >= 0 && ms <= days * 86_400_000;
}

/** {{count}} helper: "3 things" / "1 thing". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Masked account/loan numbers: never more than the last four (01 §5). */
export function mask4(last4: string): string {
  return `••••${last4.slice(-4)}`;
}
