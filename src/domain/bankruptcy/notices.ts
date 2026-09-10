/** §14.2 Rule 3002.1 notices — 9006 deadlines, timeliness, fee batching, responses. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, addMonths, addYears, dayOfWeek } from "../../kernel/calendar/date.ts";
import { isFederalHoliday } from "../../kernel/calendar/holidays.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

const closed = (d: PlainDate) => dayOfWeek(d) === 0 || dayOfWeek(d) === 6 || isFederalHoliday(d);
/** Rule 9006(a): backward periods step back to the preceding open day; forward periods roll to the next. */
export function rollBack9006(d: PlainDate): PlainDate { while (closed(d)) d = addDays(d, -1); return d; }
export function rollForward9006(d: PlainDate): PlainDate { while (closed(d)) d = addDays(d, 1); return d; }
export function inScope(f: { chapter: "7" | "11" | "12" | "13"; principal_residence: boolean | null; treatment: "cure_and_maintain" | "pay_outside" | "surrender" | "unknown"; relief_order_effective: boolean; policy_continue_after_relief?: boolean; ch12_local_flag?: boolean }): boolean {
  if (!(f.chapter === "13" || (f.chapter === "12" && f.ch12_local_flag))) return false;
  if (f.principal_residence === false) return false; if (f.treatment === "surrender") return false;
  if (f.relief_order_effective && !f.policy_continue_after_relief) return false; return true;
}
export function paymentChangeDeadline(effectiveDue: PlainDate): { deadline: PlainDate; target: PlainDate } { return { deadline: rollBack9006(addDays(effectiveDue, -21)), target: rollBack9006(addDays(effectiveDue, -35)) }; }
export function timeliness(effectiveDue: PlainDate, servedOn: PlainDate, increase: boolean): { timely: boolean; effective_date_applied: PlainDate; days_notice: number } {
  const days = (Date.parse(effectiveDue) - Date.parse(servedOn)) / 86_400_000; const timely = days >= 21;
  if (timely || !increase) return { timely, effective_date_applied: effectiveDue, days_notice: days };
  let d = effectiveDue; const min = addDays(servedOn, 21); while (d < min) d = addMonths(d, 1);
  return { timely, effective_date_applied: d, days_notice: days };
}
export interface FeeItem { readonly incurred_on: PlainDate; readonly cents: Cents; readonly line: string; readonly recoverable: boolean; status: "incurred" | "batched" | "noticed" | "waived" | "precluded_not_noticed"; }
export function feeBatchDecision(items: readonly FeeItem[], today: PlainDate): { file_now: boolean; reason: string | null; preclusion_first: PlainDate | null; aggregate_cents: Cents } {
  const open = items.filter((i) => i.status === "incurred" && i.recoverable); if (!open.length) return { file_now: false, reason: null, preclusion_first: null, aggregate_cents: 0n };
  const agg = open.reduce((s, i) => s + i.cents, 0n); const oldest = open.reduce((a, b) => (b.incurred_on < a.incurred_on ? b : a));
  const ageDays = (Date.parse(today) - Date.parse(oldest.incurred_on)) / 86_400_000;
  const preclusion = rollForward9006(addDays(oldest.incurred_on, 180));
  if (agg >= 20_000n) return { file_now: true, reason: "aggregate ≥ $200", preclusion_first: preclusion, aggregate_cents: agg };
  if (ageDays >= 90) return { file_now: true, reason: "oldest item day 90", preclusion_first: preclusion, aggregate_cents: agg };
  return { file_now: false, reason: null, preclusion_first: preclusion, aggregate_cents: agg };
}
export function challengeDeadline(servedOn: PlainDate): PlainDate { return rollForward9006(addYears(servedOn, 1)); }
export function precludeUnnoticed(items: FeeItem[], today: PlainDate): FeeItem[] { const out: FeeItem[] = []; for (const i of items) if ((i.status === "incurred" || i.status === "batched") && rollForward9006(addDays(i.incurred_on, 180)) < today) { i.status = "precluded_not_noticed"; out.push(i); } return out; }
export function responseDue(servedOn: PlainDate, byMail: boolean): PlainDate { return rollForward9006(addDays(servedOn, 28 + (byMail ? 3 : 0))); }
export function endOfCaseResponse(f: { arrearage_cents: Cents; postpetition_unpaid: { due: PlainDate; cents: Cents }[]; unpaid_noticed_fees_cents: Cents; upb_cents: Cents; next_due: PlainDate; next_amount_cents: Cents }): { arrearage: "paid_in_full" | "remainder"; current: boolean; first_unpaid_due: PlainDate | null; part4_history_required: boolean; g4_window_starts: boolean } {
  const cur = f.postpetition_unpaid.length === 0 && f.unpaid_noticed_fees_cents === 0n;
  return { arrearage: f.arrearage_cents === 0n ? "paid_in_full" : "remainder", current: cur, first_unpaid_due: cur ? null : f.postpetition_unpaid[0]!.due, part4_history_required: !cur || f.arrearage_cents !== 0n, g4_window_starts: !cur };
}
export function armFilingDue(regZNoticeOn: PlainDate, effectiveDue: PlainDate): PlainDate { const a = addBusinessDays(regZNoticeOn, 5, servicer); const b = paymentChangeDeadline(effectiveDue).deadline; return a < b ? a : b; }
export const FNMA_FEES = { payment_change: 17_500n, fee_notice: 20_000n, response_agree: 12_500n, response_disagree: 62_500n } as const;
