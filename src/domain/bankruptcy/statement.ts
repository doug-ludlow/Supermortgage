/** §14.3 Periodic statement in bankruptcy — variant decision, single-statement skip, Chapter 12/13 content. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, daysBetween } from "../../kernel/calendar/date.ts";
export type Mode = "standard" | "single_statement_skip" | "modified_ch7_11" | "modified_ch12_13" | "exempt_court_order" | "exempt_surrender_plan" | "exempt_soi_surrender" | "exempt_cease_request";
export function mode(f: { debtor_or_discharged: boolean; chapter: "7" | "11" | "12" | "13" | null; court_order_cease: boolean; plan_surrenders: boolean; ch7_soi_surrender_no_payment: boolean; cease_request: boolean; later_request_for_statements: boolean; reaffirmed_final: boolean; dismissed_no_discharge: boolean; mixed_chapters?: boolean }): Mode {
  if (!f.debtor_or_discharged || f.reaffirmed_final || f.dismissed_no_discharge) return "standard";
  if (f.court_order_cease) return "exempt_court_order"; if (f.plan_surrenders) return "exempt_surrender_plan"; if (f.ch7_soi_surrender_no_payment) return "exempt_soi_surrender";
  if (f.cease_request && !f.later_request_for_statements) return "exempt_cease_request";
  if (f.mixed_chapters) return "modified_ch12_13"; return f.chapter === "12" || f.chapter === "13" ? "modified_ch12_13" : "modified_ch7_11";
}
/** (e)(5)(iv): skip the next cycle when the event lands before that cycle's courtesy end and nothing is rendered; else send unmodified and skip the following. */
export function singleStatementSkip(eventOn: PlainDate, courtesyEnd: PlainDate, rendered: boolean): "skip_this_cycle" | "send_unmodified_skip_next" { return eventOn <= courtesyEnd && !rendered ? "skip_this_cycle" : "send_unmodified_skip_next"; }
export function ch13Content(f: { statement_date: PlainDate; postpetition_installment_cents: Cents; postpetition_unpaid: { due: PlainDate; cents: Cents }[]; allowed_noticed_fees_unpaid_cents: Cents; suspense_cents: Cents; prepetition_arrearage_cents: Cents | null; trustee_pays_postpetition: boolean }): { amount_due_cents: Cents; past_due_postpetition_cents: Cents; shortfall_text_cents: Cents | null; over_45_sentence: boolean; arrearage_display: string; late_fee_line: false; delinquency_box: false; informational_legend: true } {
  const past = f.postpetition_unpaid.reduce((s, i) => s + i.cents, 0n);
  const oldest = f.postpetition_unpaid.sort((a, b) => (a.due < b.due ? -1 : 1))[0];
  return { amount_due_cents: f.postpetition_installment_cents + past + f.allowed_noticed_fees_unpaid_cents, past_due_postpetition_cents: past, shortfall_text_cents: f.suspense_cents > 0n ? f.postpetition_installment_cents - f.suspense_cents : null, over_45_sentence: !!oldest && daysBetween(oldest.due, f.statement_date) > 45, arrearage_display: f.prepetition_arrearage_cents === null ? "amount not yet determined" : f.prepetition_arrearage_cents.toString(), late_fee_line: false, delinquency_box: false, informational_legend: true };
}
export function addressing(f: { fdcpa_covered: boolean; attorney_of_record: boolean; counsel_consents_debtor_copy: boolean }): ("counsel" | "debtor")[] { if (f.fdcpa_covered && f.attorney_of_record) return f.counsel_consents_debtor_copy ? ["counsel", "debtor"] : ["counsel"]; return f.attorney_of_record ? ["counsel", "debtor"] : ["debtor"]; }
