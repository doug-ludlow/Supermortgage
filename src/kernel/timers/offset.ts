/**
 * Parser for the registry's `offset` column. The corpus (1,365 rows) uses a
 * small grammar with a lot of prose decoration:
 *
 *   "+1 business_days_servicer (close of business T-1 ...)"
 *   "−14 calendar_days"        "30 `calendar_days`"        "+5 BD"
 *   "+5 business_days_fannie_et, 20:00 ET"
 *   "next business_days_fannie_et at 03:00 America/New_York"
 *   "every 90 calendar_days"   "6 × months"   "annual"   "monthly"
 *   "0"   "same day"   "—"
 *
 * Everything that can be evaluated mechanically becomes a `ParsedOffset`; the
 * rest is preserved verbatim as `{ kind: "prose" }` so the engine can surface
 * it to a human rather than silently guessing.
 */
import type { DayUnit } from "../calendar/business.ts";

export type OffsetUnit = DayUnit | "hours" | "minutes" | "months" | "years";

export interface StepOffset {
  readonly kind: "step";
  readonly n: number;                 // signed
  readonly unit: OffsetUnit;
  /** Wall-clock deadline on the resulting day, e.g. "20:00" in `timeZone`. */
  readonly at?: { readonly hhmm: string; readonly timeZone: string };
  /** Roll the resulting date forward to the next business day of this unit. */
  readonly rollTo?: DayUnit;
  readonly note?: string;
}
export interface NextBusinessDayOffset {
  readonly kind: "next_business_day";
  readonly unit: DayUnit;
  readonly at?: { readonly hhmm: string; readonly timeZone: string };
  readonly note?: string;
}
export interface RecurringOffset {
  readonly kind: "recurring";
  readonly every: number;
  readonly unit: OffsetUnit;
  readonly note?: string;
}
export interface SameDayOffset { readonly kind: "same_day"; readonly note?: string; }
export interface NoneOffset { readonly kind: "none"; readonly note?: string; }
export interface ProseOffset { readonly kind: "prose"; readonly text: string; }
/** A gate that stays open until a named event/condition; no computed due date. */
export interface UntilOffset { readonly kind: "until"; readonly condition: string; readonly note?: string; }
/**
 * A fixed calendar day: "CD18", "15th of the following month", "first day of next
 * month", "last calendar day of that month", "Jan 31". `day` −1 = end of month.
 * `rollBackTo` moves a non-business day to the preceding business day (Fannie
 * Mae drafts on the preceding BD); `rollTo` moves it forward.
 */
export interface CalendarDayOffset {
  readonly kind: "calendar_day";
  readonly day: number;
  readonly monthOffset: number;
  readonly month?: number;             // fixed month (1–12) → next occurrence on/after the anchor (+yearOffset)
  readonly yearOffset?: number;
  readonly at?: { readonly hhmm: string; readonly timeZone: string };
  readonly rollBackTo?: DayUnit;
  readonly rollTo?: DayUnit;
  readonly note?: string;
}
/** A window [open, close] relative to the anchor; the timer is due at `close` and reports `opens`. */
export interface WindowOffset {
  readonly kind: "window";
  readonly open: { readonly n: number; readonly unit: OffsetUnit };
  readonly close: { readonly n: number; readonly unit: OffsetUnit };
  readonly note?: string;
}
/**
 * A gate or rule whose "offset" is a condition evaluated by domain code, not a
 * clock. `ref` names the evaluator (section.function) that asserts it.
 */
export interface EvaluatorOffset { readonly kind: "evaluator"; readonly ref: string; readonly note?: string; }

export type ParsedOffset = StepOffset | NextBusinessDayOffset | RecurringOffset | SameDayOffset | NoneOffset | ProseOffset | UntilOffset | CalendarDayOffset | WindowOffset | EvaluatorOffset;

const UNIT_ALIASES: Record<string, OffsetUnit> = {
  calendar_days: "calendar_days", calendar_day: "calendar_days", "calendar days": "calendar_days", "calendar day": "calendar_days",
  days: "calendar_days", day: "calendar_days", d: "calendar_days",
  business_days_federal: "business_days_federal",
  business_days_servicer: "business_days_servicer", "business days": "business_days_servicer", "business day": "business_days_servicer",
  bd: "business_days_servicer", bds: "business_days_servicer", business_days: "business_days_servicer",
  business_days_fannie_et: "business_days_fannie_et", fannie_et: "business_days_fannie_et", "fannie_et bd": "business_days_fannie_et",
  "banking days": "business_days_federal", "banking day": "business_days_federal", cd: "calendar_days",
  business_days_creditor: "business_days_creditor", creditor: "business_days_creditor", "creditor business days": "business_days_creditor", "creditor business day": "business_days_creditor",
  business_days_regz_specific: "business_days_regz_specific", regz_specific: "business_days_regz_specific", sbd: "business_days_regz_specific", sbds: "business_days_regz_specific",
  "specific business days": "business_days_regz_specific", "specific business day": "business_days_regz_specific",
  calendar_year: "years", calendar_years: "years", "calendar year": "years", "calendar years": "years",
  hours: "hours", hour: "hours", h: "hours", hrs: "hours",
  minutes: "minutes", minute: "minutes", min: "minutes",
  months: "months", month: "months", mo: "months",
  years: "years", year: "years", yr: "years", yrs: "years",
};

function clean(raw: string): { text: string; note?: string } {
  let s = raw.replace(/\*\*\[[^\]]*\]\*\*/g, " ");          // **[PARTIALLY VERIFIED …]**
  const notes: string[] = [];
  s = s.replace(/\(([^()]*)\)/g, (_m, inner: string) => { notes.push(inner.trim()); return " "; });
  s = s.replace(/`/g, "").replace(/\s+/g, " ").trim();
  const note = notes.length ? notes.join("; ") : undefined;
  return note !== undefined ? { text: s, note } : { text: s };
}

function normNumber(s: string): number {
  return Number(s.replace(/[−–]/g, "-").replace(/\+/g, ""));
}

function parseTime(s: string): { hhmm: string; timeZone: string } | undefined {
  const m = /(\d{1,2}):(\d{2})\s*(ET|EST|EDT|America\/New_York|servicer[- ]local|loan[- ]local|loan tz|local|PT|CT|MT)?/i.exec(s);
  if (!m) return undefined;
  const tzRaw = (m[3] ?? "ET").toLowerCase();
  const timeZone = /loan/.test(tzRaw) ? "loan_local" : /local/.test(tzRaw) ? "servicer_local" : tzRaw === "pt" ? "America/Los_Angeles" : tzRaw === "ct" ? "America/Chicago" : tzRaw === "mt" ? "America/Denver" : "America/New_York";
  return { hhmm: `${m[1]!.padStart(2, "0")}:${m[2]}`, timeZone };
}

/** "rolled to the next servicer/federal/fannie business day" → the calendar to roll forward on. */
function rollFrom(s: string): DayUnit | undefined {
  const roll = /roll(?:ed)?\s+(?:forward\s+)?to\s+(?:the\s+)?next\s+(servicer|federal|fannie|creditor|regz[_ ]specific)/i.exec(s);
  if (!roll) return undefined;
  const k = roll[1]!.toLowerCase();
  return k === "servicer" ? "business_days_servicer" : k === "federal" ? "business_days_federal" : k === "creditor" ? "business_days_creditor" : k.startsWith("regz") ? "business_days_regz_specific" : "business_days_fannie_et";
}

function unitOf(s: string): OffsetUnit | undefined {
  const k = s.trim().toLowerCase().replace(/[.,;]+$/, "");
  return UNIT_ALIASES[k] ?? UNIT_ALIASES[k.replace(/\s+/g, "_")];
}

export function parseOffset(raw: string): ParsedOffset {
  const { text, note } = clean(raw);
  const withNote = <T extends object>(o: T): T & { note?: string } => (note !== undefined ? { ...o, note } : o);
  if (text === "" || text === "—" || text === "-" || /^n\/a$/i.test(text)) return withNote({ kind: "none" });
  let m: RegExpExecArray | null;
  // "same day" / "0", optionally with a wall-clock deadline or a roll to the next business day: "same day, 16:00 ET", "0 (rolled to the next servicer business day)"
  m = /^(0|same day|T0|T\+0|day 0|immediate(?:ly)?)(?:[,;]?\s*(?:at\s+)?(.*))?$/i.exec(text);
  if (m) {
    const at = parseTime(m[2] ?? "");
    const rollTo = rollFrom(raw);
    if (!at && !rollTo) return withNote({ kind: "same_day" });
    return withNote({ kind: "step", n: 0, unit: "calendar_days", ...(at ? { at } : {}), ...(rollTo ? { rollTo } : {}) });
  }

  // evaluator: "evaluator:section.fn" — written by section overrides for condition-shaped gates/rules
  m = /^evaluator:\s*([A-Za-z0-9_.:-]+)$/.exec(text);
  if (m) return withNote({ kind: "evaluator", ref: m[1]! });

  // window: "between −35 and −1 calendar_days", "opens −15 calendar_days, closes −7 calendar_days", "window [−15, 0] calendar_days", "mail between +30 and +35 calendar_days"
  m = /(?:between|window)\s*\[?\s*([+\-−–]?\d+)\s*(?:,|and|→)\s*([+\-−–]?\d+)\s*\]?\s*([a-z_ ]+?)(?:\s|$|;|,)/i.exec(text) ?? /opens\s+([+\-−–]?\d+)\s*([a-z_]+),\s*closes\s+([+\-−–]?\d+)/i.exec(text);
  if (m) {
    const [a, b, u] = m.length === 4 && /^opens/i.test(m[0]!) ? [m[1]!, m[3]!, m[2]!] : [m[1]!, m[2]!, m[3]!];
    const unit = unitOf(u) ?? "calendar_days";
    const n1 = normNumber(a), n2 = normNumber(b);
    return withNote({ kind: "window", open: { n: Math.min(n1, n2), unit }, close: { n: Math.max(n1, n2), unit } });
  }

  // fixed month/day: "Jan 31", "Mar 31 e-file", "Nov 1", "Oct 15 following year", "file before Nov 1"
  m = /^(?:file\s+)?(?:by|before|on)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:\s+(following|next)\s+year)?/i.exec(text);
  if (m) {
    const months: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
    const at = parseTime(text);
    const rollTo = rollFrom(raw);
    return withNote({ kind: "calendar_day", day: Number(m[2]), monthOffset: 0, month: months[m[1]!.toLowerCase()]!, yearOffset: m[3] ? 1 : 0, ...(at ? { at } : {}), ...(rollTo ? { rollTo } : {}) });
  }

  // first/last day of a month: "first day of next month", "last calendar day of that month, 23:59 servicer-local", "end of that month", "last day of month"
  m = /^(?:by\s+)?(?:the\s+)?(first|last|end)\s+(?:(?:calendar\s+|business\s+)?day\s+)?(?:of\s+)?(?:the\s+|that\s+)?(next|following|same|that|the|month after next|)\s*month/i.exec(text);
  if (m) {
    const which = m[1]!.toLowerCase();
    const mo = /after next/i.test(m[2] ?? "") ? 2 : /^(next|following)$/i.test(m[2] ?? "") ? 1 : 0;
    const at = parseTime(text) ?? (/servicer[- ]local|local/i.test(text) ? { hhmm: "23:59", timeZone: "servicer_local" } : undefined);
    const bizRoll: DayUnit | undefined = /business\s+day/i.test(text) ? (/fannie/i.test(raw) ? "business_days_fannie_et" : "business_days_servicer") : undefined;
    return withNote({ kind: "calendar_day", day: which === "first" ? 1 : -1, monthOffset: mo, ...(at ? { at } : {}), ...(bizRoll ? (which === "first" ? { rollTo: bizRoll } : { rollBackTo: bizRoll }) : {}) });
  }

  // calendar day of month: "CD18", "by CD15", "by the 20th", "15th of the following month", "20th", "CD7 (preceding fannie_et BD)"
  m = /^(?:by\s+)?(?:the\s+)?(?:CD\s*)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:calendar\s+)?day)?(?:\s+of\s+(?:the\s+)?(?:(following|next|same|that)\s+month|(month\s+after\s+next)))?(?:\s|$|,|;)/i.exec(text);
  if (m && !/^\d+\s*[×x]?\s*(?:calendar|business|days?|months?|years?|hours?|minutes?|bd|cd\b)/i.test(text)) {
    const mo = m[3] ? 2 : /^(following|next)$/i.test(m[2] ?? "") ? 1 : 0;
    const at = parseTime(text);
    const rollBack = /preceding/i.test(raw) ? "business_days_fannie_et" as DayUnit : undefined;
    return withNote({ kind: "calendar_day", day: Number(m[1]), monthOffset: mo, ...(at ? { at } : {}), ...(rollBack ? { rollBackTo: rollBack } : {}) });
  }

  // gates: "until `case.noe.responded`", "until closed", "through plan end"
  m = /^(?:until|through|while)\s+(.+)$/i.exec(text);
  if (m) return withNote({ kind: "until", condition: m[1]!.trim() });

  // bounded windows used as validation/recency rules: "≤30 calendar_days at approval", "within −7 calendar_days", "max 90"
  m = /^(?:≤|<=|≥|>=|within|max|no more than|at most)\s*([+\-−–]?\d+)\s*[×x]?\s*([a-z_]+(?:\s+(?:days?|day))?)?/i.exec(text);
  if (m) {
    const u = m[2] ? unitOf(m[2]) : "calendar_days";
    if (u) return withNote({ kind: "step", n: normNumber(m[1]!), unit: u, note: [note, `bound: ${text}`].filter(Boolean).join("; ") });
  }

  // recurring: "every 90 calendar_days", "every 3 months", "annual", "monthly", "quarterly", "daily"
  m = /^every\s+(\d+)\s*[×x]?\s*([a-z_ ]+?)(?:[,;].*)?$/i.exec(text);
  if (m) { const u = unitOf(m[2]!); if (u) return withNote({ kind: "recurring", every: Number(m[1]), unit: u }); }
  m = /^(daily|weekly|monthly|quarterly|semi-?annual(?:ly)?|annual(?:ly)?)(?:[,;].*)?$/i.exec(text);
  if (m) {
    const w = m[1]!.toLowerCase();
    const map: Record<string, [number, OffsetUnit]> = { daily: [1, "calendar_days"], weekly: [7, "calendar_days"], monthly: [1, "months"], quarterly: [3, "months"], "semi-annual": [6, "months"], semiannual: [6, "months"], "semi-annually": [6, "months"], semiannually: [6, "months"], annual: [1, "years"], annually: [1, "years"] };
    const hit = map[w] ?? map[w.replace(/ly$/, "")];
    if (hit) return withNote({ kind: "recurring", every: hit[0], unit: hit[1] });
  }

  // next business day: "next business_days_fannie_et at 03:00 America/New_York", "next fannie_et BD 03:00 ET", "next BD 20:00 ET"
  m = /^next\s+([a-z_]+)?\s*(?:BD|business_day|business day)?\s*(?:at\s+)?(.*)$/i.exec(text);
  if (m) {
    const u = m[1] ? unitOf(m[1]) : "business_days_servicer";
    if (u && u !== "hours" && u !== "minutes" && u !== "months" && u !== "years") {
      const at = parseTime(m[2] ?? "");
      return withNote(at ? { kind: "next_business_day", unit: u, at } : { kind: "next_business_day", unit: u });
    }
  }

  // "BD5 20:00 ET" / "BD1 03:00 ET" style (Fannie business-day counting from anchor)
  m = /^BD\s*(\d+)\s*(.*)$/i.exec(text);
  if (m) {
    const at = parseTime(m[2] ?? "");
    return withNote({ kind: "step", n: Number(m[1]), unit: "business_days_fannie_et", ...(at ? { at } : {}) });
  }

  // step: "+1 business_days_servicer", "−14 calendar_days", "30 calendar days", "6 × months", "+5 business_days_fannie_et, 20:00 ET"
  m = /^([+\-−–]?\s*\d+)\s*[×x]?\s*([a-z_]+(?:\s+(?:days?|day))?)\s*(?:[,;]?\s*(.*))?$/i.exec(text);
  if (m) {
    const u = unitOf(m[2]!);
    if (u) {
      const rest = m[3] ?? "";
      const at = parseTime(rest);
      const rollTo = rollFrom(rest) ?? rollFrom(raw);
      return withNote({ kind: "step", n: normNumber(m[1]!.replace(/\s/g, "")), unit: u, ...(at ? { at } : {}), ...(rollTo ? { rollTo } : {}) });
    }
  }

  return { kind: "prose", text: raw.trim() };
}
