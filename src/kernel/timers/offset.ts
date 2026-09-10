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

export type ParsedOffset = StepOffset | NextBusinessDayOffset | RecurringOffset | SameDayOffset | NoneOffset | ProseOffset | UntilOffset;

const UNIT_ALIASES: Record<string, OffsetUnit> = {
  calendar_days: "calendar_days", calendar_day: "calendar_days", "calendar days": "calendar_days", "calendar day": "calendar_days",
  days: "calendar_days", day: "calendar_days", d: "calendar_days",
  business_days_federal: "business_days_federal",
  business_days_servicer: "business_days_servicer", "business days": "business_days_servicer", "business day": "business_days_servicer",
  bd: "business_days_servicer", bds: "business_days_servicer", business_days: "business_days_servicer",
  business_days_fannie_et: "business_days_fannie_et", fannie_et: "business_days_fannie_et",
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
  const m = /(\d{1,2}):(\d{2})\s*(ET|EST|EDT|America\/New_York|local|PT|CT|MT)?/i.exec(s);
  if (!m) return undefined;
  const tzRaw = (m[3] ?? "ET").toLowerCase();
  const timeZone = tzRaw === "local" ? "servicer_local" : tzRaw === "pt" ? "America/Los_Angeles" : tzRaw === "ct" ? "America/Chicago" : tzRaw === "mt" ? "America/Denver" : "America/New_York";
  return { hhmm: `${m[1]!.padStart(2, "0")}:${m[2]}`, timeZone };
}

function unitOf(s: string): OffsetUnit | undefined {
  const k = s.trim().toLowerCase().replace(/[.,;]+$/, "");
  return UNIT_ALIASES[k] ?? UNIT_ALIASES[k.replace(/\s+/g, "_")];
}

export function parseOffset(raw: string): ParsedOffset {
  const { text, note } = clean(raw);
  const withNote = <T extends object>(o: T): T & { note?: string } => (note !== undefined ? { ...o, note } : o);
  if (text === "" || text === "—" || text === "-" || /^n\/a$/i.test(text)) return withNote({ kind: "none" });
  if (/^(0|same day|T0|T\+0|day 0|immediate(ly)?)$/i.test(text)) return withNote({ kind: "same_day" });

  // gates: "until `case.noe.responded`", "until closed", "through plan end"
  let m = /^(?:until|through|while)\s+(.+)$/i.exec(text);
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
      const roll = /roll(?:ed)?\s+to\s+(?:the\s+)?next\s+(servicer|federal|fannie)/i.exec(rest);
      const rollTo: DayUnit | undefined = roll ? (roll[1]!.toLowerCase() === "servicer" ? "business_days_servicer" : roll[1]!.toLowerCase() === "federal" ? "business_days_federal" : "business_days_fannie_et") : undefined;
      return withNote({ kind: "step", n: normNumber(m[1]!.replace(/\s/g, "")), unit: u, ...(at ? { at } : {}), ...(rollTo ? { rollTo } : {}) });
    }
  }

  return { kind: "prose", text: raw.trim() };
}
