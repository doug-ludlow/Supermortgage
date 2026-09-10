/** §3.3 Annual escrow account statement — exemption test, deadlines, low-point explanation. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

export type Exemption = "delinquent_30" | "foreclosure_action" | "bankruptcy";
export function exemption(f: { regx_days_delinquent: number; foreclosure_first_legal_filed: boolean; bankruptcy_open: boolean; bk_suppress?: boolean }): Exemption | null {
  if (f.regx_days_delinquent > 30) return "delinquent_30"; if (f.foreclosure_first_legal_filed) return "foreclosure_action"; if (f.bankruptcy_open && f.bk_suppress) return "bankruptcy"; return null;
}
/** Annual: 30 days after computation-year end (calendar, no roll); send target 5 BD earlier. */
export function annualDeadline(yearEnd: PlainDate): { due_on: PlainDate; send_target_on: PlainDate } { const due = addDays(yearEnd, 30); return { due_on: due, send_target_on: addBusinessDays(due, -5, servicer) }; }
export function shortYearDeadline(kind: "transfer" | "payoff" | "reset", eventOn: PlainDate): PlainDate { return addDays(eventOn, 60); }
export function postExemptionDeadline(exemptionEndedOn: PlainDate): PlainDate { return addDays(exemptionEndedOn, 90); }

export interface HistoryLine { readonly month: PlainDate; readonly line_type: string; readonly projected_cents: Cents | null; readonly actual_cents: Cents; }
/** (i)(1)(viii): differences between projected and actual disbursements and the low-balance comparison. */
export function lowPointExplanation(lines: readonly HistoryLine[], actualLow: Cents, projectedLow: Cents): string[] {
  const out: string[] = [];
  const fmt = (c: Cents) => `$${(c / 100n).toString()}.${(c % 100n).toString().padStart(2, "0")}`;
  for (const l of lines) {
    const mm = `${l.month.slice(5, 7)}/${l.month.slice(0, 4)}`;
    if (l.projected_cents === null) out.push(`a ${l.line_type} bill of ${fmt(l.actual_cents)} was paid ${mm} (not projected)`);
    else if (l.projected_cents !== l.actual_cents) out.push(`${l.line_type} paid ${mm} was ${fmt(l.actual_cents)} vs ${fmt(l.projected_cents)} projected`);
  }
  if (actualLow !== projectedLow) out.push(`low balance ${fmt(actualLow)} vs ${fmt(projectedLow)} projected`);
  return out;
}
/** 3.3 rule 4 validator: ≥-one-month shortage text must not mention a lump sum. */
export function lumpSumWordingAllowed(shortageCents: Cents, oneMonthCents: Cents): boolean { return shortageCents < oneMonthCents; }
