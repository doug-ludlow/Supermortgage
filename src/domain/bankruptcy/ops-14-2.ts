/**
 * §14.2 operating rules over the Rule 3002.1 calculators in ./notices.ts:
 * the scope test, decision record and Rule 9006 deadline set for a detected
 * change (rules 1–2, 9), the post-petition escrow change arithmetic and the
 * 9006-aware timeliness / untimely-notice billing of rule 2 ((b)(3)), the ARM
 * 5-BD filing and Part-2 attachment of rule 3, the same-due-date supersession
 * of the edge cases, the fee batch schedule, Form 410S-2 lines, day-180
 * preclusion write-off and statement/payoff exclusion of rule 5, the
 * Form 410C13-M1R / 410C13-NR / 410C13-M2R responses of rules 6–7 (facts
 * compared with the motion's/trustee's stated facts at $0.00 tolerance; Part 3
 * derived from the ledger views), the (g)(4) window, the (b)(4) motion hold,
 * the relief-order policy (14.2-Q2), the Form 410S-1 checklist and the
 * Official Form content the filings must carry.
 * Every function is pure; the tools in src/app/tools/section14-2.ts and the
 * tests in ./14-2.spec.test.ts call these.
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays, addMonths, addYears, daysBetween, dayOfWeek, parts } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { isFederalHoliday, federalHolidays } from "../../kernel/calendar/holidays.ts";
import { levelPayment, ratePercent, formatCents, type Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";
import { paymentChangeDeadline, timeliness, feeBatchDecision, rollForward9006, responseDue, endOfCaseResponse, inScope, challengeDeadline, type FeeItem } from "./notices.ts";
import { documentRequestDue } from "./ops-14-1.ts";

export type ChangeSource = "escrow_analysis" | "arm_adjustment" | "pmi_termination" | "scra_rate" | "modification" | "other";
export type NoticeStatus = "computed" | "package_ready" | "escalated" | "signed" | "filed_served" | "effective" | "objected" | "determined" | "superseded" | "withdrawn";
/** Form 410S-1 part used for a change source (rule 3–4). */
export const PART_FOR_SOURCE: Record<ChangeSource, 1 | 2 | 4> = { escrow_analysis: 1, arm_adjustment: 2, pmi_termination: 4, scra_rate: 4, modification: 4, other: 4 };
/** Form 410S-2 (12/16) Part 1 line captions. */
export const FORM_410S2_LINES: Record<string, string> = { "1": "Late charges", "2": "Non-sufficient funds (NSF) fees", "3": "Attorney fees", "4": "Filing fees and court costs", "5": "Bankruptcy/Proof of claim fees", "6": "Appraisal/Broker's price opinion fees", "7": "Property inspection fees", "8": "Tax advances (non-escrow)", "9": "Insurance advances (non-escrow)", "10": "Property preservation expenses", "11": "Other", "12": "Other", "13": "Other", "14": "Other" };
export const FNMA_FEE_NOTICE_THRESHOLD_CENTS: Cents = 20_000n;
/** Escalations: `officer` for write-offs above $1,000 per case (and every late-notice attempt). */
export const OFFICER_WRITE_OFF_THRESHOLD_CENTS: Cents = 100_000n;
export const RULE_SET_VERSION = "frbp.2025-12; fnma.bk_fees.2025-11-12" as const;
/** Calendar the 9006 computations ran on — recorded in every decision record (rule 9). */
export const CALENDAR_VERSION = "frbp9006:federal-holidays-5-usc-6103;court:<district>@2026-09" as const;
/** No model sits in the computation path: every figure and date is a deterministic calculator output. */
export const MODEL_VERSION = "deterministic-calculators/14.2@frbp.2025-12" as const;
export const SERVICE_LIST = ["debtor", "debtor_attorney", "trustee"] as const;
export type ServiceParty = (typeof SERVICE_LIST)[number];

// ============================================================ rule 9: computation hash and the decision record
/** sha256 over the canonical JSON of the computation inputs/outputs (keys sorted, bigint cents as "<n>n"). */
export function computationHash(o: unknown): string {
  const canon = (v: unknown): unknown => typeof v === "bigint" ? `${v}n` : Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return createHash("sha256").update(JSON.stringify(canon(o))).digest("hex");
}
export interface DeadlineCalc { readonly anchor: PlainDate; readonly anchor_field: "effective_due_date"; readonly offset: "−21 calendar_days"; readonly roll_rule: "frbp_9006_backward"; readonly calendar_version: typeof CALENDAR_VERSION; readonly holidays_applied: readonly { date: PlainDate; reason: string }[]; readonly result: PlainDate; readonly target: PlainDate; readonly target_offset: "−35 calendar_days"; }
function closedReason(d: PlainDate): string | null {
  const w = dayOfWeek(d); if (w === 6) return "Saturday"; if (w === 0) return "Sunday";
  if (isFederalHoliday(d)) return federalHolidays(parts(d).y).find((h) => h.observed === d || h.date === d)?.name ?? "legal holiday";
  return null;
}
/** Rule 2 / rule 9: the 9006(a) backward count with every weekend/holiday day it stepped over — the evidence bundle's `deadline_calc`. */
export function deadlineCalc(effectiveDue: PlainDate): DeadlineCalc {
  const d = paymentChangeDeadline(effectiveDue); const applied: { date: PlainDate; reason: string }[] = [];
  for (let x = addDays(effectiveDue, -21); x > d.deadline; x = addDays(x, -1)) applied.push({ date: x, reason: closedReason(x) ?? "closed" });
  return { anchor: effectiveDue, anchor_field: "effective_due_date", offset: "−21 calendar_days", roll_rule: "frbp_9006_backward", calendar_version: CALENDAR_VERSION, holidays_applied: applied, result: d.deadline, target: d.target, target_offset: "−35 calendar_days" };
}
/** The spec's decision record: {case_id, filing_type, trigger_event_id, computation_hash, deadline_calc, scope_test_result, fee_items[], service_list, rule_set_version, model_version, rationale, outcome, reviewer_id?}. */
export interface DecisionRecord { readonly case_id: string | null; readonly filing_type: string; readonly trigger_event_id: string | null; readonly computation_hash: string; readonly deadline_calc: DeadlineCalc | null; readonly scope_test_result: string; readonly fee_items: readonly string[]; readonly service_list: readonly ServiceParty[]; readonly rule_code: string; readonly rule_set_version: typeof RULE_SET_VERSION; readonly model_version: typeof MODEL_VERSION; readonly rationale: string; readonly outcome: string; readonly reviewer_id: string | null; }
function decisionRecord(d: Pick<DecisionRecord, "filing_type" | "scope_test_result" | "rule_code" | "rationale" | "outcome"> & Partial<DecisionRecord>, inputs: unknown): DecisionRecord {
  return { case_id: d.case_id ?? null, filing_type: d.filing_type, trigger_event_id: d.trigger_event_id ?? null, computation_hash: computationHash({ inputs, outcome: d.outcome, deadline_calc: d.deadline_calc ?? null }), deadline_calc: d.deadline_calc ?? null, scope_test_result: d.scope_test_result, fee_items: d.fee_items ?? [], service_list: d.service_list ?? SERVICE_LIST, rule_code: d.rule_code, rule_set_version: RULE_SET_VERSION, model_version: MODEL_VERSION, rationale: d.rationale, outcome: d.outcome, reviewer_id: d.reviewer_id ?? null };
}

// ============================================================ rule 1–2: detection, scope, deadlines
export interface CaseFacts { readonly chapter: "7" | "11" | "12" | "13"; readonly principal_residence: boolean | null; readonly treatment: "cure_and_maintain" | "pay_outside" | "surrender" | "unknown"; readonly relief_order_effective: boolean; readonly case_open?: boolean; readonly ch12_local_flag?: boolean; readonly case_id?: string | null;
  /** 14.2-Q2 exception: counsel advises the district treats continued notices after stay relief as improper (recorded by `bk.change.detect op=docket_event kind=relief_order_entered`). */
  readonly counsel_advises_improper?: boolean;
  /** Rule 3002.1(a) "unless the court orders otherwise": the relief order itself directs continued compliance. */
  readonly court_orders_continued_compliance?: boolean; }
/** 14.2-Q2: after a relief order the (b)/(c) notices continue while the case is open unless counsel advises the district treats them as improper (the court ordering continued compliance always wins). */
export const continueAfterRelief = (f: Pick<CaseFacts, "case_open" | "counsel_advises_improper" | "court_orders_continued_compliance">): boolean => f.case_open !== false && (f.court_orders_continued_compliance === true || f.counsel_advises_improper !== true);
export interface ScheduledChange { readonly source: ChangeSource; readonly old_total_cents: Cents; readonly new_total_cents: Cents; readonly effective_due_date: PlainDate; readonly detected_on: PlainDate; readonly evidence_document_ids?: readonly string[]; readonly trigger_event_id?: string | null; }
/** Rule 1–2 + `SM_BK_PAYMENT_CHANGE_DETECT_1BD`: scope test, change kind (increase|decrease; equal totals are no change and no notice), the 9006 deadline set with its calc, the 1-BD row deadline and the decision record for one `payment.change.scheduled`. */
export function detectChange(c: ScheduledChange, f: CaseFacts): { in_scope: boolean; notice_required: boolean; change_kind: "increase" | "decrease" | null; part: 1 | 2 | 4; deadline_file_serve: PlainDate; target_file_date: PlainDate; deadline_calc: DeadlineCalc; row_due_by: PlainDate; status: NoticeStatus | "out_of_scope" | "no_change"; decision: DecisionRecord } {
  const scope = inScope({ chapter: f.chapter, principal_residence: f.principal_residence, treatment: f.treatment, relief_order_effective: f.relief_order_effective, policy_continue_after_relief: continueAfterRelief(f), ...(f.ch12_local_flag !== undefined ? { ch12_local_flag: f.ch12_local_flag } : {}) });
  const calc = deadlineCalc(c.effective_due_date);
  const kind = c.new_total_cents > c.old_total_cents ? "increase" : c.new_total_cents < c.old_total_cents ? "decrease" : null;
  const required = scope && kind !== null;
  const ceased = f.relief_order_effective && !continueAfterRelief(f) && inScope({ chapter: f.chapter, principal_residence: f.principal_residence, treatment: f.treatment, relief_order_effective: false, ...(f.ch12_local_flag !== undefined ? { ch12_local_flag: f.ch12_local_flag } : {}) });
  const why = ceased ? `out of scope: relief order effective and ${f.case_open === false ? "the case is closed/dismissed" : "counsel advises the district treats continued Rule 3002.1 notices as improper"} → the rule's requirements ceased (Rule 3002.1(a); 14.2-Q2 exception)`
    : !scope ? `out of scope: chapter ${f.chapter}, principal_residence=${String(f.principal_residence)}, treatment=${f.treatment}, relief=${f.relief_order_effective}`
    : kind === null ? `in scope (Rule 3002.1(a)) but the total payment is unchanged (${formatCents(c.old_total_cents, { symbol: true })}) — Rule 3002.1(b)(1) requires a notice of "any change in the payment amount"; none here`
    : `in scope (Rule 3002.1(a)): chapter ${f.chapter}, principal residence${f.principal_residence === null ? " unknown → comply" : ""}, ${f.treatment}${f.relief_order_effective ? "; relief order entered → keep filing while the case is open (14.2-Q2)" : ""}; ${kind} ${formatCents(c.old_total_cents, { symbol: true })} → ${formatCents(c.new_total_cents, { symbol: true })} effective ${c.effective_due_date}; file and serve by ${calc.result} (9006 backward${calc.holidays_applied.length ? `, stepped over ${calc.holidays_applied.map((h) => `${h.date} ${h.reason}`).join(", ")}` : ""}), target ${calc.target}`;
  return { in_scope: scope, notice_required: required, change_kind: kind, part: PART_FOR_SOURCE[c.source], deadline_file_serve: calc.result, target_file_date: calc.target, deadline_calc: calc, row_due_by: addBusinessDays(c.detected_on, 1, servicer), status: !scope ? "out_of_scope" : kind === null ? "no_change" : "computed",
    decision: decisionRecord({ case_id: f.case_id ?? null, filing_type: "410S-1", trigger_event_id: c.trigger_event_id ?? null, deadline_calc: calc, scope_test_result: scope ? (f.relief_order_effective ? "in_scope_policy_continue" : "in_scope") : ceased ? "ceased_on_relief" : "out_of_scope", rule_code: f.relief_order_effective && (scope || ceased) ? "14.2-Q2" : "14.2 rule 1", rationale: why, outcome: !scope ? "skipped_with_decision_record" : kind === null ? "no_change_no_filing" : "notice_required" }, { change: c, facts: f }) };
}

/** Rule 2 worked example: base escrow + shortage ÷ spread months → new escrow and the old/new totals. */
export function postpetitionEscrowChange(i: { pi_cents: Cents; escrow_old_cents: Cents; shortage_cents: Cents; spread_months?: number; effective_due_date: PlainDate }): { shortage_monthly_cents: Cents; escrow_new_cents: Cents; old_total_cents: Cents; new_total_cents: Cents; change_kind: "increase" | "decrease" | null; part: 1; deadline_file_serve: PlainDate; target_file_date: PlainDate } {
  const months = BigInt(i.spread_months ?? 12); const monthly = divRound(i.shortage_cents, months, "HALF_UP"); const escrowNew = i.escrow_old_cents + monthly;
  const oldTotal = i.pi_cents + i.escrow_old_cents, newTotal = i.pi_cents + escrowNew; const d = paymentChangeDeadline(i.effective_due_date);
  return { shortage_monthly_cents: monthly, escrow_new_cents: escrowNew, old_total_cents: oldTotal, new_total_cents: newTotal, change_kind: newTotal > oldTotal ? "increase" : newTotal < oldTotal ? "decrease" : null, part: 1, deadline_file_serve: d.deadline, target_file_date: d.target };
}

/**
 * Rule 2 / (b)(1)–(b)(3) with Rule 9006(a): "filed and served" means both acts by the deadline — `effective_due_date` − 21
 * calendar days rolled backward off a Saturday, Sunday or legal holiday. A notice completed after that day is untimely even
 * when it still gives ≥ 21 days' notice (a Saturday/Sunday filing in the roll window), so `timely` and the day count are
 * reported separately; the (b)(3) effective date of an untimely increase is the first due date ≥ 21 days after the later of
 * filing and service, a decrease keeps the actual due date.
 */
export function timeliness9006(i: { effective_due_date: PlainDate; filed_on: PlainDate; served_on: PlainDate; increase: boolean }): { timely: boolean; deadline: PlainDate; completed_on: PlainDate; days_notice: number; effective_date_applied: PlainDate; late_by_days: number; sanctions_exposure: boolean; breach: { severity: 1; timer: "BK_3002_1_PAYMENT_CHANGE_21"; gate: "new amount may not be billed on the scheduled date" } | null } {
  const deadline = paymentChangeDeadline(i.effective_due_date).deadline; const completed = i.filed_on > i.served_on ? i.filed_on : i.served_on;
  const timely = i.filed_on <= deadline && i.served_on <= deadline; const t = timeliness(i.effective_due_date, completed, i.increase);
  return { timely, deadline, completed_on: completed, days_notice: daysBetween(completed, i.effective_due_date), effective_date_applied: timely ? i.effective_due_date : t.effective_date_applied, late_by_days: timely ? 0 : daysBetween(deadline, completed), sanctions_exposure: !timely, breach: timely ? null : { severity: 1, timer: "BK_3002_1_PAYMENT_CHANGE_21", gate: "new amount may not be billed on the scheduled date" } };
}

/** Rule 2 / (b)(3): what each installment bills after a notice filed/served on the given days — an untimely increase waits for the first due date ≥ 21 days after filing and service (the old amount bills meanwhile, 3.2 is told to push its effective date, the timing loss is absorbed, 14.2-Q4); a decrease applies on the actual due date. */
export function untimelyNoticeBilling(i: { effective_due_date: PlainDate; served_on: PlainDate; filed_on?: PlainDate | null; old_total_cents: Cents; new_total_cents: Cents; timing_loss_monthly_cents?: Cents; months?: number }): { timely: boolean; deadline: PlainDate; days_notice: number; effective_date_applied: PlainDate; installments: { due: PlainDate; bills_cents: Cents }[]; pushed_event: { type: "payment.change.effective_date.pushed"; from: PlainDate; to: PlainDate } | null; timing_loss_cents: Cents; re_notice: false; sanctions_exposure: boolean } {
  const inc = i.new_total_cents > i.old_total_cents; const t = timeliness9006({ effective_due_date: i.effective_due_date, filed_on: i.filed_on ?? i.served_on, served_on: i.served_on, increase: inc });
  const months = i.months ?? 2; const out: { due: PlainDate; bills_cents: Cents }[] = []; let due = i.effective_due_date; let lost = 0n;
  for (let k = 0; k < months; k++) { const applies = due >= t.effective_date_applied; out.push({ due, bills_cents: applies ? i.new_total_cents : i.old_total_cents }); if (!applies) lost += i.timing_loss_monthly_cents ?? 0n; due = nextDue(due); }
  return { timely: t.timely, deadline: t.deadline, days_notice: t.days_notice, effective_date_applied: t.effective_date_applied, installments: out, pushed_event: t.effective_date_applied !== i.effective_due_date ? { type: "payment.change.effective_date.pushed", from: i.effective_due_date, to: t.effective_date_applied } : null, timing_loss_cents: lost, re_notice: false, sanctions_exposure: t.sanctions_exposure };
}
function nextDue(d: PlainDate): PlainDate { const [y, m, day] = d.split("-").map(Number) as [number, number, number]; const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1; return `${ny}-${String(nm).padStart(2, "0")}-${String(day).padStart(2, "0")}` as PlainDate; }

// ============================================================ rule 3: ARM changes
/** Rule 3: the 410S-1 (Part 2, Reg Z notice attached) is filed within 5 BD of the §1026.20(c) notice and in any case by the 9006 deadline (21 days before the change). */
export function armChangeNotice(i: { reg_z_notice_on: PlainDate; effective_due_date: PlainDate; rate_old: string; rate_new: string; pi_old_cents: Cents; pi_new_cents: Cents; escrow_cents: Cents; rate_change_notice_document_id: string | null; filed_served_on?: PlainDate | null }): { part: 2; file_by: PlainDate; deadline_file_serve: PlainDate; target_file_date: PlainDate; attachment_ok: boolean; part2: { current_rate: string; new_rate: string; current_pi_cents: Cents; new_pi_cents: Cents }; new_total_cents: Cents; filed_on: PlainDate | null; timely: boolean | null; deadline_satisfied: boolean | null; days_notice: number | null } {
  const d = paymentChangeDeadline(i.effective_due_date); const five = addBusinessDays(i.reg_z_notice_on, 5, servicer); const fileBy = five < d.deadline ? five : d.deadline;
  const filed = i.filed_served_on ?? null; const t = filed ? timeliness9006({ effective_due_date: i.effective_due_date, filed_on: filed, served_on: filed, increase: i.pi_new_cents > i.pi_old_cents }) : null;
  return { part: 2, file_by: fileBy, deadline_file_serve: d.deadline, target_file_date: d.target, attachment_ok: Boolean(i.rate_change_notice_document_id), part2: { current_rate: i.rate_old, new_rate: i.rate_new, current_pi_cents: i.pi_old_cents, new_pi_cents: i.pi_new_cents }, new_total_cents: i.pi_new_cents + i.escrow_cents, filed_on: filed, timely: t ? t.timely : null, deadline_satisfied: t ? t.timely : null, days_notice: t ? t.days_notice : null };
}

// ============================================================ edge case: multiple changes for one due date
export interface NoticeRow { readonly id: string; readonly effective_due_date: PlainDate; readonly parts: readonly (1 | 2 | 4)[]; readonly status: NoticeStatus; readonly detected_on: PlainDate; readonly source: ChangeSource; }
/** Edge case: a later change for the same due date → one superseding 410S-1 with every part completed; the earlier notice is marked `superseded`. */
export function supersedingNotice(prior: NoticeRow, later: { id: string; source: ChangeSource; detected_on: PlainDate; effective_due_date: PlainDate }): { same_due_date: boolean; single_filing: boolean; filing: NoticeRow & { supersedes: string | null }; prior: NoticeRow } {
  if (prior.effective_due_date !== later.effective_due_date) return { same_due_date: false, single_filing: false, filing: { id: later.id, effective_due_date: later.effective_due_date, parts: [PART_FOR_SOURCE[later.source]], status: "computed", detected_on: later.detected_on, source: later.source, supersedes: null }, prior };
  const parts = [...new Set([...prior.parts, PART_FOR_SOURCE[later.source]])].sort((a, b) => a - b) as (1 | 2 | 4)[];
  return { same_due_date: true, single_filing: true, filing: { id: later.id, effective_due_date: later.effective_due_date, parts, status: "computed", detected_on: later.detected_on, source: later.source, supersedes: prior.id }, prior: { ...prior, status: "superseded" } };
}

// ============================================================ rule 5: fees (c)
/** Rule 5 / `SM_BK_3002_1C_BATCH_90`: when the open batch files — immediately at ≥ $200 aggregate, else on the oldest item's day 90 — never on a court-closed day and never in the past, always before the oldest item's 180-day preclusion; Fannie Mae's $200 fee is claimable only at ≥ $200 (the rule, not the fee schedule, governs). */
export function feeBatchSchedule(items: readonly Form410s2Item[], today: PlainDate, opts: { court_holidays?: readonly PlainDate[] } = {}): { file_now: boolean; reason: string | null; files_on: PlainDate | null; preclusion_first: PlainDate | null; before_day_180: boolean | null; aggregate_cents: Cents; fnma_fee_claimable: boolean; filing_required: boolean } {
  const d = feeBatchDecision(items as readonly FeeItem[], today); const open = items.filter((i) => i.status === "incurred" && i.recoverable);
  if (!open.length) return { file_now: false, reason: null, files_on: null, preclusion_first: null, before_day_180: null, aggregate_cents: 0n, fnma_fee_claimable: false, filing_required: false };
  const oldest = open.reduce((a, b) => (b.incurred_on < a.incurred_on ? b : a)); const claimable = d.aggregate_cents >= FNMA_FEE_NOTICE_THRESHOLD_CENTS;
  // day 90 (or today, never a past date) rolled off a court-closed day the way the filing itself must be (the SM_BK_3002_1C_BATCH_90 row carries the same roll); the preclusion date honours the district's holidays (9006(a)(6)(C))
  const base = claimable ? oldest.incurred_on : addDays(oldest.incurred_on, 90); const filesOn = rollForward9006Court(base > today ? base : today, opts.court_holidays ?? []); const preclusion = noticeDeadline180(oldest.incurred_on, opts.court_holidays ?? []);
  return { file_now: d.file_now, reason: d.reason, files_on: filesOn, preclusion_first: preclusion, before_day_180: filesOn < preclusion, aggregate_cents: d.aggregate_cents, fnma_fee_claimable: claimable, filing_required: true };
}
/** A fee item as the 410S-2 calculators see it: the 2.7 exposure row (./notices.ts FeeItem) plus the identity, description and prior-notice linkage the checklist tests. */
export interface Form410s2Item { readonly incurred_on: PlainDate; readonly cents: Cents; readonly line: string; readonly recoverable: boolean; readonly status: FeeItemStatus; readonly id?: string; readonly description?: string | null; readonly escrow_disbursement?: boolean; readonly noticed_on?: PlainDate | null; readonly notice_filing_id?: string | null; }
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Official Form 410S-2 Part 1 has lines 1–14; anything else (or an escrow disbursement) does not belong on the form. */
const S2_LINE = /^([1-9]|1[0-4])$/;
/**
 * Rule 5: Form 410S-2 Part 1 lines from the batch (one line per 410S-2 line number, dates incurred listed), the total and the
 * form checklist — each rule tests something the batch can get wrong: an escrow disbursement or an off-form line
 * (`FORM410S2_NO_ESCROW_DISBURSEMENTS`), an item a prior notice in the case already itemized — by id (`previously_noticed_ids`,
 * the fee_item_ids of the case's filed 410S-2s) or by its own `noticed_on`/`notice_filing_id` (`FORM410S2_NO_PREVIOUSLY_NOTICED_ITEMS`),
 * an item without a real incurrence date or one "incurred" after the notice date (`FORM410S2_DATES_PRESENT`), and a total that
 * does not tie to the open fee memo balance the ledger carries (`FORM410S2_TOTAL_EQ_SUM`, when `memo_balance_cents` is given).
 */
export function form410s2Lines(items: readonly Form410s2Item[], servedOn?: PlainDate | null, opts: { previously_noticed_ids?: readonly string[]; memo_balance_cents?: Cents | null } = {}): { lines: { line_no: string; description: string; amount_cents: Cents; dates_incurred: PlainDate[] }[]; total_cents: Cents; checklist: { FORM410S2_NO_ESCROW_DISBURSEMENTS: boolean; FORM410S2_NO_PREVIOUSLY_NOTICED_ITEMS: boolean; FORM410S2_DATES_PRESENT: boolean; FORM410S2_TOTAL_EQ_SUM: boolean }; passed: boolean; failed: string[]; challenge_deadline: PlainDate | null; item_ids: string[] } {
  const inBatch = items.filter((i) => (i.status === "incurred" || i.status === "batched") && i.recoverable);
  const by = new Map<string, { line_no: string; description: string; amount_cents: Cents; dates_incurred: PlainDate[] }>();
  for (const i of inBatch) { const l = by.get(i.line) ?? { line_no: i.line, description: FORM_410S2_LINES[i.line] ?? "Other", amount_cents: 0n, dates_incurred: [] }; l.amount_cents += i.cents; if (!l.dates_incurred.includes(i.incurred_on)) l.dates_incurred.push(i.incurred_on); by.set(i.line, l); }
  const lines = [...by.values()].sort((a, b) => Number(a.line_no) - Number(b.line_no)); const total = lines.reduce((s, l) => s + l.amount_cents, 0n);
  const prev = new Set(opts.previously_noticed_ids ?? []);
  const checklist = {
    FORM410S2_NO_ESCROW_DISBURSEMENTS: inBatch.every((i) => S2_LINE.test(i.line) && i.escrow_disbursement !== true && !/escrow/i.test(i.description ?? "")),
    FORM410S2_NO_PREVIOUSLY_NOTICED_ITEMS: inBatch.every((i) => !(i.id !== undefined && prev.has(i.id)) && !i.noticed_on && !i.notice_filing_id),
    FORM410S2_DATES_PRESENT: inBatch.every((i) => ISO_DATE.test(i.incurred_on) && (!servedOn || i.incurred_on <= servedOn)),
    FORM410S2_TOTAL_EQ_SUM: total === inBatch.reduce((s, i) => s + i.cents, 0n) && (opts.memo_balance_cents === undefined || opts.memo_balance_cents === null || total === opts.memo_balance_cents),
  };
  const failed = Object.entries(checklist).filter(([, ok]) => !ok).map(([k]) => k);
  return { lines, total_cents: total, checklist, passed: failed.length === 0, failed, challenge_deadline: servedOn ? challengeDeadline(servedOn) : null, item_ids: inBatch.map((i) => i.id).filter((id): id is string => typeof id === "string") };
}

/** The data model's `bk_postpetition_fee_items.status` set. */
export type FeeItemStatus = "incurred" | "batched" | "noticed" | "challenged" | "determined_allowed" | "determined_disallowed" | "allowed_by_lapse" | "precluded_not_noticed" | "waived" | "collected";
export interface PostpetitionFeeItem { readonly id: string; readonly line: string; readonly incurred_on: PlainDate; readonly cents: Cents; readonly recoverable: boolean; readonly status: FeeItemStatus; readonly paid_cents?: Cents; readonly fnma_reimbursed?: boolean; readonly noticed_on?: PlainDate | null; }
export interface Posting { readonly account: string; readonly debit: Cents; readonly credit: Cents; readonly rule_ref: string; }
/**
 * Rule 9006(a)(6)(C): for a period measured after an event, "legal holiday" also means any day the state where the district
 * court sits declares a holiday — the `court:<district>` calendar the timer rows name. Forward periods (180/28/45 days, one
 * year) roll over those days too; the backward 21-day count uses federal holidays only (rule 2). The engine's own clock
 * (federal roll) is never later than this date, so a court-holiday roll only ever gives the filing more time.
 */
export function rollForward9006Court(d: PlainDate, courtHolidays: readonly PlainDate[] = []): PlainDate {
  const closed = new Set(courtHolidays); let x = rollForward9006(d);
  while (closed.has(x)) x = rollForward9006(addDays(x, 1));
  return x;
}
/** `BK_3002_1C_FEE_NOTICE_180`: 180 calendar days after `incurred_on`, 9006 forward (court holidays honoured when given). */
export function noticeDeadline180(incurredOn: PlainDate, courtHolidays: readonly PlainDate[] = []): PlainDate { return rollForward9006Court(addDays(incurredOn, 180), courtHolidays); }
/** Rules 6–7: 28 calendar days after service (+3 when served by mail, Rule 9006(f)), 9006(a) forward over federal and court holidays. */
export function responseDueCourt(servedOn: PlainDate, byMail: boolean, courtHolidays: readonly PlainDate[] = []): PlainDate { return rollForward9006Court(addDays(servedOn, 28 + (byMail ? 3 : 0)), courtHolidays); }
/** Rule 3002.1(e): one year after service of the 410S-2, 9006(a) forward over federal and court holidays. */
export function challengeDeadlineCourt(servedOn: PlainDate, courtHolidays: readonly PlainDate[] = []): PlainDate { return rollForward9006Court(addYears(servedOn, 1), courtHolidays); }
/**
 * Rule 5 / `BK_3002_1C_FEE_NOTICE_180` breach: an item still un-noticed after its day-180 deadline becomes
 * `precluded_not_noticed` (Rule 3002.1(c), (h)) and is written off — Dr fee expense / Cr the post-petition fee memo — as a
 * balanced set with a rule_ref; write-offs above $1,000 per case and any late-notice attempt (with counsel's advice) are the
 * `officer`'s decision. Pure: returns new item rows (append-only), never mutates.
 */
export function precludeAndWriteOff(items: readonly PostpetitionFeeItem[], today: PlainDate, opts: { case_written_off_to_date_cents?: Cents } = {}): { items: PostpetitionFeeItem[]; precluded: PostpetitionFeeItem[]; write_off_cents: Cents; postings: Posting[]; balanced: boolean; case_write_off_total_cents: Cents; officer_required: boolean; officer_threshold_cents: Cents; severity: 2; timer: "BK_3002_1C_FEE_NOTICE_180"; late_notice_attempt: { requires_role: "officer"; requires: "counsel_advice_document_id"; otherwise: "waived" } } {
  const out = items.map((i) => ((i.status === "incurred" || i.status === "batched") && i.recoverable && noticeDeadline180(i.incurred_on) < today ? { ...i, status: "precluded_not_noticed" as const } : i));
  const precluded = out.filter((i, k) => i.status === "precluded_not_noticed" && items[k]!.status !== "precluded_not_noticed");
  const amt = precluded.reduce((s, i) => s + i.cents, 0n);
  const postings: Posting[] = precluded.flatMap((i) => [{ account: "bk_fee_expense", debit: i.cents, credit: 0n, rule_ref: `14.2 rule 5: item ${i.id} not noticed by day 180 (Rule 3002.1(c)) → precluded (Rule 3002.1(h)), written off` }, { account: "bk_postpetition_fee_memo", debit: 0n, credit: i.cents, rule_ref: `14.2 rule 5: item ${i.id} removed from the 2.7 exposure memo` }]);
  const total = (opts.case_written_off_to_date_cents ?? 0n) + amt;
  return { items: out, precluded, write_off_cents: amt, postings, balanced: postings.reduce((s, p) => s + p.debit - p.credit, 0n) === 0n, case_write_off_total_cents: total, officer_required: total > OFFICER_WRITE_OFF_THRESHOLD_CENTS, officer_threshold_cents: OFFICER_WRITE_OFF_THRESHOLD_CENTS, severity: 2, timer: "BK_3002_1C_FEE_NOTICE_180", late_notice_attempt: { requires_role: "officer", requires: "counsel_advice_document_id", otherwise: "waived" } };
}
/** Outputs/ledger: fee items reach the receivable (statement and payoff) only on `allowed_by_lapse`/`determined_allowed`; noticed-but-open items stay memo; precluded, waived and disallowed items never appear in a later statement or payoff. */
export function collectibleFees(items: readonly PostpetitionFeeItem[]): { allowed_noticed_fees_unpaid_cents: Cents; payoff_fees_cents: Cents; memo_only_cents: Cents; excluded: { id: string; status: FeeItemStatus; cents: Cents }[] } {
  const unpaid = (i: PostpetitionFeeItem) => i.cents - (i.paid_cents ?? 0n);
  const allowed = items.filter((i) => i.status === "allowed_by_lapse" || i.status === "determined_allowed").reduce((s, i) => s + unpaid(i), 0n);
  const memo = items.filter((i) => i.status === "incurred" || i.status === "batched" || i.status === "noticed" || i.status === "challenged").reduce((s, i) => s + unpaid(i), 0n);
  const excluded = items.filter((i) => i.status === "precluded_not_noticed" || i.status === "waived" || i.status === "determined_disallowed").map((i) => ({ id: i.id, status: i.status, cents: i.cents }));
  return { allowed_noticed_fees_unpaid_cents: allowed, payoff_fees_cents: allowed, memo_only_cents: memo, excluded };
}
/** (e) outcomes: lapse of the one-year window or an order moves an item; allowed items move memo → receivable. */
export function resolveFeeItems(items: readonly PostpetitionFeeItem[], ids: readonly string[], result: "allowed_by_lapse" | "challenged" | "determined_allowed" | "determined_disallowed"): { items: PostpetitionFeeItem[]; postings: Posting[] } {
  const set = new Set(ids); const out = items.map((i) => (set.has(i.id) ? { ...i, status: result } : i));
  const moved = out.filter((i) => set.has(i.id) && (result === "allowed_by_lapse" || result === "determined_allowed"));
  return { items: out, postings: moved.flatMap((i) => [{ account: "other_fees", debit: i.cents, credit: 0n, rule_ref: `14.2 outputs: item ${i.id} ${result} (Rule 3002.1(e)) → receivable` }, { account: "bk_postpetition_fee_memo", debit: 0n, credit: i.cents, rule_ref: `14.2 outputs: item ${i.id} leaves the memo` }]) };
}

// ============================================================ rules 6–7: (f) mid-case status and (g) end of case
export type ResponseKind = "m1r" | "nr" | "m2r";
export interface PostpetitionRow { readonly due: PlainDate; readonly amount_cents: Cents; readonly paid_cents: Cents; readonly received_on?: PlainDate | null; }
/** What the motion (410C13-M1 / M2) or the trustee's 410C13-N states — compared with our ledger at $0.00 tolerance. */
export interface StatedFacts { readonly prepetition_cured: boolean; readonly prepetition_remaining_cents?: Cents | null; readonly cure_disbursed_cents?: Cents | null; readonly postpetition_current: boolean; readonly first_unpaid_postpetition_due?: PlainDate | null; readonly postpetition_disbursed_cents?: Cents | null; }
export interface Amortization { readonly original_principal_cents: Cents; readonly rate_pct: string; readonly term_months: number; readonly first_due: PlainDate; }
export interface Form410c13nInput {
  readonly served_on: PlainDate; readonly by_mail: boolean; readonly notice_date?: PlainDate;
  readonly arrearage_cents: Cents; readonly postpetition: readonly PostpetitionRow[]; readonly unpaid_noticed_fees_cents: Cents;
  /** The paper's own statements (trustee's 410C13-N / movant's 410C13-M1 or M2); absent = the paper asserts cure and current. */
  readonly stated_facts?: StatedFacts | null; readonly cure_received_cents?: Cents | null; readonly postpetition_received_cents?: Cents | null;
  /** Ledger views: with the note terms Part 3's UPB, next due and P&I are derived from the paid rows; without them the explicit payoff-style figures are used. */
  readonly amortization?: Amortization | null; readonly escrow_monthly_cents?: Cents | null;
  readonly last_payment_received_on?: PlainDate | null; readonly next_due?: PlainDate | null; readonly next_due_cents?: Cents | null; readonly upb_cents?: Cents | null;
  readonly deferred_interest_cents: Cents; readonly escrow_balance_cents: Cents; readonly unapplied_cents: Cents; readonly history: readonly Record<string, unknown>[];
  /** `court:<district>` holidays (Rule 9006(a)(6)(C): state holidays count for periods measured after an event) — the 28(+3)-day response clock rolls over them too. */
  readonly court_holidays?: readonly PlainDate[];
}
export interface StatusResponse {
  readonly kind: ResponseKind; readonly form: "410C13-M1R" | "410C13-NR" | "410C13-M2R"; readonly responds_to: "410C13-M1" | "410C13-N" | "410C13-M2"; readonly response_due: PlainDate; readonly filed_as: "supplement_to_proof_of_claim" | "response_to_motion";
  readonly part2: { prepetition_cured: boolean; statement: "paid in full" | "amount remaining"; remaining_cents: Cents };
  readonly part3: { statement: "current" | "not current"; first_unpaid_postpetition_due: PlainDate | null; itemization: { due: PlainDate; amount_cents: Cents }[]; unpaid_fees_cents: Cents; last_payment_received_on: PlainDate | null; next_due_date: PlainDate; next_due_cents: Cents; pi_cents: Cents | null; upb_cents: Cents; upb_after_installment: PlainDate | null; installments_paid: number | null; deferred_interest_cents: Cents; escrow_balance_cents: Cents; unapplied_cents: Cents; source: "ledger_views" | "explicit" };
  readonly part4_history: readonly Record<string, unknown>[] | null; readonly stated_facts_used: StatedFacts; readonly disagreements: string[]; readonly agree: boolean; readonly service: readonly ["debtor", "debtor_attorney", "trustee"];
  readonly checklist: { FORM410C13NR_SUPPLEMENT_TO_CLAIM: boolean; FORM410C13NR_PART4_REQUIRED_IF_DISAGREE: boolean }; readonly fnma_fee_cents: Cents; readonly fnma_fee_line: string; readonly precludes_later_default_claim: boolean; readonly computation_hash: string;
}
function monthsBetween(a: PlainDate, b: PlainDate): number { const pa = parts(a), pb = parts(b); return (pb.y - pa.y) * 12 + (pb.m - pa.m); }
/**
 * Rules 6–7: the (f)/(g) response computed from the frozen ledger views as of the paper's date — Part 2 cure, Part 3
 * current / first unpaid + itemization and payoff-style data (UPB after the last paid installment, next due date and P&I +
 * then-current escrow from the note terms), Part 4 history whenever the response disagrees or asserts non-payment; the paper's
 * stated facts are compared at $0.00 tolerance — any variance is a disagreement ($625 objection fee) — otherwise the response
 * agrees ($125). The NR is filed as a POC supplement; M1R/M2R respond to the motion. Served on debtor, counsel and trustee.
 */
export function statusResponse(kind: ResponseKind, i: Form410c13nInput): StatusResponse {
  const asOf = i.notice_date ?? i.served_on;
  const unpaidRows = i.postpetition.filter((r) => r.due <= asOf && r.paid_cents < r.amount_cents).sort((a, b) => (a.due < b.due ? -1 : 1));
  const unpaid = unpaidRows.map((r) => ({ due: r.due, cents: r.amount_cents - r.paid_cents }));
  const paidRows = i.postpetition.filter((r) => r.paid_cents >= r.amount_cents && r.due <= asOf).sort((a, b) => (a.due < b.due ? 1 : -1));
  const lastPaid = paidRows[0] ?? null;
  let upb: Cents, nextDue: PlainDate, nextCents: Cents, pi: Cents | null = null, paidCount: number | null = null, source: "ledger_views" | "explicit";
  if (i.amortization) {
    // installments paid = every scheduled installment through the last paid one, less the unpaid ones the ledger view lists before it (a skipped installment never amortized the note)
    const a = i.amortization; paidCount = lastPaid ? monthsBetween(a.first_due, lastPaid.due) + 1 - unpaidRows.filter((r) => r.due < lastPaid.due).length : 0; pi = levelPayment(a.original_principal_cents, ratePercent(a.rate_pct), a.term_months);
    upb = balanceAfter(a.original_principal_cents, a.rate_pct, a.term_months, paidCount); nextDue = unpaidRows[0]?.due ?? (lastPaid ? addMonths(lastPaid.due, 1) : a.first_due); nextCents = pi + (i.escrow_monthly_cents ?? 0n); source = "ledger_views";
  } else {
    if (i.upb_cents === undefined || i.upb_cents === null || !i.next_due || i.next_due_cents === undefined || i.next_due_cents === null) throw new RangeError("Part 3 needs the note terms (amortization) or explicit upb_cents / next_due / next_due_cents");
    upb = i.upb_cents; nextDue = i.next_due; nextCents = i.next_due_cents; source = "explicit";
  }
  const lastReceived = paidRows.map((r) => r.received_on ?? null).filter((d): d is PlainDate => d !== null).sort().at(-1) ?? i.last_payment_received_on ?? null;
  const e = endOfCaseResponse({ arrearage_cents: i.arrearage_cents, postpetition_unpaid: unpaid, unpaid_noticed_fees_cents: i.unpaid_noticed_fees_cents, upb_cents: upb, next_due: nextDue, next_amount_cents: nextCents });
  const cured = e.arrearage === "paid_in_full";
  const stated: StatedFacts = i.stated_facts ?? { prepetition_cured: true, postpetition_current: true };
  const dis: string[] = [];
  const money = (c: Cents) => formatCents(c, { symbol: true });
  if (stated.prepetition_cured !== cured) dis.push(`Part 2: the paper states the prepetition arrearage ${stated.prepetition_cured ? "is cured" : "is not cured"}; the ledger shows ${cured ? "paid in full" : `${money(i.arrearage_cents)} remaining`}`);
  if (stated.prepetition_remaining_cents !== undefined && stated.prepetition_remaining_cents !== null && stated.prepetition_remaining_cents !== i.arrearage_cents) dis.push(`Part 2: stated remaining ${money(stated.prepetition_remaining_cents)} ≠ ledger ${money(i.arrearage_cents)}`);
  if (stated.cure_disbursed_cents !== undefined && stated.cure_disbursed_cents !== null && i.cure_received_cents !== undefined && i.cure_received_cents !== null && stated.cure_disbursed_cents !== i.cure_received_cents) dis.push(`Part 2: stated cure disbursements ${money(stated.cure_disbursed_cents)} ≠ received ${money(i.cure_received_cents)} (trustee vouchers)`);
  if (stated.postpetition_current !== e.current) dis.push(`Part 3: the paper states the debtor ${stated.postpetition_current ? "is current" : "is not current"}; the ledger shows ${e.current ? "current" : `first unpaid ${e.first_unpaid_due}`}`);
  if (stated.first_unpaid_postpetition_due !== undefined && stated.first_unpaid_postpetition_due !== null && stated.first_unpaid_postpetition_due !== e.first_unpaid_due) dis.push(`Part 3: stated first unpaid due ${stated.first_unpaid_postpetition_due} ≠ ledger ${e.first_unpaid_due ?? "none"}`);
  if (stated.postpetition_disbursed_cents !== undefined && stated.postpetition_disbursed_cents !== null && i.postpetition_received_cents !== undefined && i.postpetition_received_cents !== null && stated.postpetition_disbursed_cents !== i.postpetition_received_cents) dis.push(`Part 3: stated post-petition disbursements ${money(stated.postpetition_disbursed_cents)} ≠ received ${money(i.postpetition_received_cents)}`);
  const agree = dis.length === 0; const part4Required = !agree || !e.current || !cured; const part4 = part4Required ? i.history : null;
  const filedAs = kind === "nr" ? "supplement_to_proof_of_claim" : "response_to_motion";
  const part3 = { statement: e.current ? "current" as const : "not current" as const, first_unpaid_postpetition_due: e.first_unpaid_due, itemization: unpaid.map((u) => ({ due: u.due, amount_cents: u.cents })), unpaid_fees_cents: i.unpaid_noticed_fees_cents, last_payment_received_on: lastReceived, next_due_date: nextDue, next_due_cents: nextCents, pi_cents: pi, upb_cents: upb, upb_after_installment: lastPaid?.due ?? null, installments_paid: paidCount, deferred_interest_cents: i.deferred_interest_cents, escrow_balance_cents: i.escrow_balance_cents, unapplied_cents: i.unapplied_cents, source };
  return { kind, form: kind === "m1r" ? "410C13-M1R" : kind === "nr" ? "410C13-NR" : "410C13-M2R", responds_to: kind === "m1r" ? "410C13-M1" : kind === "nr" ? "410C13-N" : "410C13-M2", response_due: responseDueCourt(i.served_on, i.by_mail, i.court_holidays ?? []), filed_as: filedAs,
    part2: { prepetition_cured: cured, statement: cured ? "paid in full" : "amount remaining", remaining_cents: i.arrearage_cents }, part3, part4_history: part4, stated_facts_used: stated, disagreements: dis, agree, service: ["debtor", "debtor_attorney", "trustee"],
    checklist: { FORM410C13NR_SUPPLEMENT_TO_CLAIM: kind !== "nr" || filedAs === "supplement_to_proof_of_claim", FORM410C13NR_PART4_REQUIRED_IF_DISAGREE: !part4Required || (part4 !== null && part4.length > 0) },
    fnma_fee_cents: agree ? 12_500n : 62_500n, fnma_fee_line: kind === "m1r" ? "Response to Motion to Determine Status" : kind === "nr" ? "Response to Trustee's Notice of Disbursements Made" : "Response to Motion to Determine Final Cure and Payment (exhibit line as for the status response)", precludes_later_default_claim: kind === "nr" && agree && e.current,
    computation_hash: computationHash({ kind, asOf, arrearage: i.arrearage_cents, unpaid, fees: i.unpaid_noticed_fees_cents, upb, nextDue, nextCents, stated }) };
}
/** Rule 7: the Form 410C13-NR (a POC supplement). */
export function form410c13nr(i: Form410c13nInput): StatusResponse { return statusResponse("nr", i); }
/** Rule 6: the Form 410C13-M1R response to a mid-case status motion — 28 days (+3 if mail) after service. */
export function form410c13m1r(i: Form410c13nInput): StatusResponse { return statusResponse("m1r", i); }
/** Rule 7 / (g)(4): the Form 410C13-M2R response to the debtor's or trustee's motion after the NR. */
export function form410c13m2r(i: Form410c13nInput): StatusResponse { return statusResponse("m2r", i); }
/** Rule 7 / `FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45`: a "not current" response starts the debtor's 45-day motion window on service of the response; an agree/current response ends the bankruptcy accounting. */
export function g4MotionWindow(statement: "current" | "not current", responseServedOn: PlainDate | null, courtHolidays: readonly PlainDate[] = []): { starts: boolean; timer: "FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45"; anchor: "served_at"; starts_on: PlainDate | null; lapses_on: PlainDate | null; post_case_collectible: "itemized_amounts_only" | "none" } {
  const starts = statement === "not current";
  return { starts, timer: "FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45", anchor: "served_at", starts_on: starts ? responseServedOn : null, lapses_on: starts && responseServedOn ? rollForward9006Court(addDays(responseServedOn, 45), courtHolidays) : null, post_case_collectible: starts ? "itemized_amounts_only" : "none" };
}

// ============================================================ (b)(4) motion, (e) order
export interface FiledNotice { readonly id: string; readonly effective_due_date: PlainDate; readonly old_total_cents: Cents; readonly new_total_cents: Cents; readonly status: NoticeStatus; }
/** Rule (b)(4) / `FRBP_3002_1B4_OBJECTION_WINDOW`: a motion docketed before the due date holds the old amount; the change applies only per the court's order. */
export function b4MotionHold(n: FiledNotice, motion: { docketed_on: PlainDate }): { status: NoticeStatus; held: boolean; hold_amount_cents: Cents; bills_on_due_date_cents: Cents; applies_on: PlainDate | null; gate_facts: { b4_motion_docketed: boolean; b4_motion_docketed_on: PlainDate; effective_due_date: PlainDate }; escalation: { kind: "attorney"; reason: string }; awaiting: "court_order" } {
  const before = motion.docketed_on < n.effective_due_date;
  if (!before) return { status: n.status, held: false, hold_amount_cents: n.new_total_cents, bills_on_due_date_cents: n.new_total_cents, applies_on: n.effective_due_date, gate_facts: { b4_motion_docketed: false, b4_motion_docketed_on: motion.docketed_on, effective_due_date: n.effective_due_date }, escalation: { kind: "attorney", reason: `motion docketed ${motion.docketed_on} on/after the due date ${n.effective_due_date}: the change took effect (Rule 3002.1(b)(4))` }, awaiting: "court_order" };
  return { status: "objected", held: true, hold_amount_cents: n.old_total_cents, bills_on_due_date_cents: n.old_total_cents, applies_on: null, gate_facts: { b4_motion_docketed: true, b4_motion_docketed_on: motion.docketed_on, effective_due_date: n.effective_due_date }, escalation: { kind: "attorney", reason: `Rule 3002.1(b)(4) motion docketed ${motion.docketed_on}: hold the ${n.effective_due_date} payment at the prior amount pending the court's order` }, awaiting: "court_order" };
}
/** The (b)(4)/(e) order's figures are applied on entry — never the agent's. */
export function applyCourtOrder(n: FiledNotice, order: { entered_on: PlainDate; determined_total_cents: Cents; effective_from: PlainDate }): { status: "determined"; amount_cents: Cents; applies_from: PlainDate; entered_on: PlainDate } {
  return { status: "determined", amount_cents: order.determined_total_cents, applies_from: order.effective_from, entered_on: order.entered_on };
}

// ============================================================ relief from stay (14.2-Q2)
/** `SM_BK_3002_1_RELIEF_CEASE_CHECK`: the rule ceases on stay relief "unless the court orders otherwise"; policy keeps filing while the case is open (14.2-Q2) unless counsel advises the district treats it as improper. `gate_facts` feed the `14.2.rule3002_1NoticesCeaseAfterRelief` evaluator. */
export function reliefOrderDecision(i: { relief_order_entered_on: PlainDate; case_open: boolean; counsel_advises_improper: boolean; court_orders_continued_compliance?: boolean; case_id?: string | null }): { continue_filing: boolean; in_scope: boolean; gate: "SM_BK_3002_1_RELIEF_CEASE_CHECK"; gate_facts: { relief_order_entered: true; relief_order_entered_on: PlainDate; case_open: boolean; counsel_advises_improper: boolean; court_orders_continued_compliance: boolean }; decision: DecisionRecord } {
  const cont = i.case_open && (i.court_orders_continued_compliance === true || !i.counsel_advises_improper);
  const scope = inScope({ chapter: "13", principal_residence: true, treatment: "cure_and_maintain", relief_order_effective: true, policy_continue_after_relief: cont });
  return { continue_filing: cont, in_scope: scope, gate: "SM_BK_3002_1_RELIEF_CEASE_CHECK", gate_facts: { relief_order_entered: true, relief_order_entered_on: i.relief_order_entered_on, case_open: i.case_open, counsel_advises_improper: i.counsel_advises_improper, court_orders_continued_compliance: i.court_orders_continued_compliance === true },
    decision: decisionRecord({ case_id: i.case_id ?? null, filing_type: "410S-1/410S-2", scope_test_result: cont ? "in_scope_policy_continue" : "ceased_on_relief", rule_code: "14.2-Q2", outcome: cont ? "continue_filing" : "cease_filing",
      rationale: cont ? `relief order entered ${i.relief_order_entered_on}; case remains open → continue filing (b)/(c) notices per 14.2-Q2 (Rule 3002.1(a): requirements cease on stay relief "unless the court orders otherwise"; filing is harmless and avoids disputes if the relief order is later vacated)` : `relief order entered ${i.relief_order_entered_on}; ${i.case_open ? "counsel advises the district treats continued notices as improper" : "case closed"} → cease per 14.2-Q2 exception` }, i) };
}

// ============================================================ outputs: Form 410S-1 checklist
export interface Form410s1Input { readonly notice_date: PlainDate; readonly effective_due_date: PlainDate; readonly pi_new_cents: Cents; readonly escrow_new_cents: Cents; readonly new_total_cents: Cents; readonly parts: readonly (1 | 2 | 4)[]; readonly escrow_old_cents?: Cents; readonly rate_old?: string; readonly rate_new?: string; readonly pi_old_cents?: Cents; readonly escrow_statement_document_id?: string | null; readonly rate_change_notice_document_id?: string | null; readonly account_last4: string; readonly signer_role: "creditor" | "authorized_agent" | null; }
/** Outputs: the 410S-1 checklist (`FRBP_3002_1B_DATE_GE_21`, Part 1/2 attachments, total tie-out, Rule 9037 redaction, signer role); any failure blocks the package. */
export function form410s1(i: Form410s1Input): { header: { date_of_payment_change: PlainDate; new_total_cents: Cents; account_last4: string }; part1: { current_escrow_cents: Cents; new_escrow_cents: Cents; escrow_statement_attached: boolean } | null; part2: { current_rate: string; new_rate: string; current_pi_cents: Cents; new_pi_cents: Cents; rate_change_notice_attached: boolean } | null; part4: { current_total_cents: Cents | null; new_total_cents: Cents } | null; checklist: Record<"FRBP_3002_1B_DATE_GE_21" | "FORM410S1_PART1_ESCROW_ATTACHED" | "FORM410S1_PART2_RATE_NOTICE_ATTACHED" | "FORM410S1_TOTAL_EQ_PI_PLUS_ESCROW" | "FRBP_9037_REDACTION" | "SIGNER_ROLE_PRESENT", boolean>; blocked: boolean; failed: string[] } {
  const p1 = i.parts.includes(1), p2 = i.parts.includes(2), p4 = i.parts.includes(4);
  const oldTotal = i.escrow_old_cents !== undefined ? (i.pi_old_cents ?? i.pi_new_cents) + i.escrow_old_cents : i.pi_old_cents !== undefined ? i.pi_old_cents + i.escrow_new_cents : null; const decrease = oldTotal !== null && i.new_total_cents < oldTotal;   // Rule 3002.1(b)(3): a decrease applies on the actual due date even when noticed late
  const checklist = { FRBP_3002_1B_DATE_GE_21: decrease || daysBetween(i.notice_date, i.effective_due_date) >= 21, FORM410S1_PART1_ESCROW_ATTACHED: !p1 || Boolean(i.escrow_statement_document_id), FORM410S1_PART2_RATE_NOTICE_ATTACHED: !p2 || Boolean(i.rate_change_notice_document_id), FORM410S1_TOTAL_EQ_PI_PLUS_ESCROW: i.new_total_cents === i.pi_new_cents + i.escrow_new_cents, FRBP_9037_REDACTION: /^\d{4}$/.test(i.account_last4), SIGNER_ROLE_PRESENT: i.signer_role !== null };
  const failed = Object.entries(checklist).filter(([, ok]) => !ok).map(([k]) => k);
  return { header: { date_of_payment_change: i.effective_due_date, new_total_cents: i.new_total_cents, account_last4: i.account_last4 },
    part1: p1 ? { current_escrow_cents: i.escrow_old_cents ?? 0n, new_escrow_cents: i.escrow_new_cents, escrow_statement_attached: Boolean(i.escrow_statement_document_id) } : null,
    part2: p2 ? { current_rate: i.rate_old ?? "", new_rate: i.rate_new ?? "", current_pi_cents: i.pi_old_cents ?? 0n, new_pi_cents: i.pi_new_cents, rate_change_notice_attached: Boolean(i.rate_change_notice_document_id) } : null,
    part4: p4 ? { current_total_cents: i.pi_old_cents !== undefined && i.escrow_old_cents !== undefined ? i.pi_old_cents + i.escrow_old_cents : null, new_total_cents: i.new_total_cents } : null,
    checklist, blocked: failed.length > 0, failed };
}

// ============================================================ outputs: Official Form content (operational prerequisites)
/**
 * The Official Forms the filings render from (`CRT_B410S1` 12/25, `CRT_B410S2` 12/16, `CRT_B410C13_M1R`/`_NR`/`_M2R` 12/25)
 * and the certificate of service, with the captions and declarations each carries (spec "Official Forms", verified at
 * uscourts.gov 2026-09-09). The Notice Registry catalog (spec/registry/notices.json) carries only NTC_/INS_ codes, so these
 * court papers are rendered here and checked — against the payload, never against the template's own text — before the
 * package is handed to counsel (`documents.render` refuses a blocked form).
 */
export const COURT_FORMS = {
  CRT_B410S1: { form: "Official Form 410S-1", title: "Notice of Mortgage Payment Change", revision: "12/25", captions: ["Court claim no. (if known)", "Last 4 digits of any number you use to identify the debtor's account", "Date of payment change — Must be at least 21 days after date of this notice", "New total payment: Principal, interest, and escrow, if any", "Will there be a change in the debtor's escrow account payment?", "The person completing this Notice must sign it", "under penalty of perjury that the information provided in this claim is true and correct to the best of my knowledge, information, and reasonable belief"] },
  CRT_B410S2: { form: "Official Form 410S-2", title: "Notice of Postpetition Mortgage Fees, Expenses, and Charges", revision: "12/16", captions: ["Dates incurred", "Do not include any escrow account disbursements or any amounts previously itemized in a notice filed in this case", "under penalty of perjury"] },
  CRT_B410C13_M1R: { form: "Official Form 410C13-M1R", title: "Response to Motion to Determine the Status of the Mortgage Claim", revision: "12/25", captions: ["within 28 days after the motion is served", "under penalty of perjury"] },
  CRT_B410C13_NR: { form: "Official Form 410C13-NR", title: "Response to Trustee's Notice of Payments Made", revision: "12/25", captions: ["filed as a supplement to the claim holder's proof of claim", "The amount required to cure any prepetition arrearage has been paid in full", "The debtor is current on all postpetition payments, including all fees, charges, expenses, escrow, and costs", "Part 4", "under penalty of perjury"] },
  CRT_B410C13_M2R: { form: "Official Form 410C13-M2R", title: "Response to Motion to Determine Final Cure and Payment", revision: "12/25", captions: ["within 28 days", "under penalty of perjury"] },
  CRT_CERTIFICATE_OF_SERVICE: { form: "Certificate of Service", title: "Certificate of Service", revision: "14.2 rule 8", captions: ["I certify that on", "first-class mail", "CM/ECF"] },
} as const;
export type CourtFormCode = keyof typeof COURT_FORMS;
const RESPONSE_FORM: Partial<Record<CourtFormCode, StatusResponse["form"]>> = { CRT_B410C13_M1R: "410C13-M1R", CRT_B410C13_NR: "410C13-NR", CRT_B410C13_M2R: "410C13-M2R" };
const DECLARATION = "I declare under penalty of perjury that the information provided in this claim is true and correct to the best of my knowledge, information, and reasonable belief.";
const m = (v: unknown): string => (typeof v === "bigint" ? formatCents(v, { symbol: true }) : String(v ?? ""));
const s = (p: Record<string, unknown>, k: string): string => String(p[k] ?? "");
/** Payload cents as a bigint, or null when the field is absent/not an integer — a missing figure fails its tie-out rather than defaulting to zero. */
const asCents = (v: unknown): Cents | null => (typeof v === "bigint" ? v : typeof v === "number" && Number.isInteger(v) ? BigInt(v) : typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : null);
/**
 * Rule 8/9 and the outputs section: the form text and its checklist, evaluated on the payload (the analysis/ledger figures,
 * attachments, dates, signer, service list) before `documents.render` stores the PDF/A. Every rule can fail: `FRBP_3002_1B_DATE_GE_21`
 * needs both dates and 21 days between them; the Part 1/2 attachments must be present when the part is completed; the header total
 * must equal P&I + escrow; the 410S-2 lines must be on-form, dated, un-noticed and sum to the stated total; a 410C13 response must
 * be the computed `StatusResponse` for that form, filed as a POC supplement (NR) with Part 4 attached whenever it disagrees or asserts
 * a default; the certificate must name the debtor (mail, or consented e-mail), the debtor's attorney (unless pro se) and the trustee;
 * every paper needs a creditor, a Rule 9037-redacted account and a signer (creditor / authorized agent, name and date).
 */
export function renderCourtForm(code: string, p: Record<string, unknown>): { code: CourtFormCode; form: string; title: string; revision: string; text: string; checklist: Record<string, boolean>; blocked: boolean; failed: string[]; sha256: string } {
  if (!(code in COURT_FORMS)) throw new RangeError(`${code} is not a 3002.1 court form (${Object.keys(COURT_FORMS).join(", ")})`);
  const f = COURT_FORMS[code as CourtFormCode]; const role = s(p, "signer_role");
  const signer = role === "creditor" ? "I am the creditor" : role === "authorized_agent" ? "I am the creditor's authorized agent" : "[signer role missing]";
  const checklist: Record<string, boolean> = {};
  const lines: string[] = [`${f.form} ${f.title} (${f.revision})`, `Name of creditor: ${s(p, "creditor_name")}`, `Court claim no. (if known): ${s(p, "claim_no")}`, `Last 4 digits of any number you use to identify the debtor's account: ${s(p, "account_last4")}`];
  switch (code as CourtFormCode) {
    case "CRT_B410S1": {
      lines.push(`Date of payment change — Must be at least 21 days after date of this notice: ${s(p, "date_of_payment_change")}`, `New total payment: Principal, interest, and escrow, if any: ${m(p.new_total_cents)}`);
      const p1 = p.part1 as Record<string, unknown> | undefined, p2 = p.part2 as Record<string, unknown> | undefined, p4 = p.part4 as Record<string, unknown> | undefined;
      lines.push(`Part 1: Escrow Account Payment Adjustment. Will there be a change in the debtor's escrow account payment? ${p1 ? `Yes. Current escrow payment: ${m(p1.current_escrow_cents)}. New escrow payment: ${m(p1.new_escrow_cents)}. Escrow statement attached: ${p1.escrow_statement_attached ? "yes" : "no"}.` : "No."}`);
      lines.push(`Part 2: Mortgage Payment Adjustment. ${p2 ? `Yes. Current interest rate: ${s(p2, "current_rate")}%. New interest rate: ${s(p2, "new_rate")}%. Current principal and interest payment: ${m(p2.current_pi_cents)}. New principal and interest payment: ${m(p2.new_pi_cents)}. Attach a copy of the rate change notice: ${p2.rate_change_notice_attached ? "attached" : "missing"}.` : "No."}`);
      lines.push("Part 3: Annual HELOC Notice. Not applicable (closed-end lien).", `Part 4: Other Payment Change. ${p4 ? `Yes. Reason: ${s(p4, "reason")}. Current mortgage payment: ${m(p4.current_total_cents)}. New mortgage payment: ${m(p4.new_total_cents)}.` : "No."}`);
      lines.push(`Part 5: Sign Here. The person completing this Notice must sign it. ${signer}. ${DECLARATION} Signed: ${s(p, "signer_name")} (${role}) on ${s(p, "signed_on")}.`);
      const nd = s(p, "notice_date"), dpc = s(p, "date_of_payment_change");
      checklist.FRBP_3002_1B_DATE_GE_21 = ISO_DATE.test(nd) && ISO_DATE.test(dpc) && (p.change_kind === "decrease" || daysBetween(nd as PlainDate, dpc as PlainDate) >= 21);   // (b)(3): a late-noticed decrease is still filed
      checklist.FORM410S1_AT_LEAST_ONE_PART = Boolean(p1 || p2 || p4);
      checklist.FORM410S1_PART1_ESCROW_ATTACHED = !p1 || p1.escrow_statement_attached === true;
      checklist.FORM410S1_PART2_RATE_NOTICE_ATTACHED = !p2 || p2.rate_change_notice_attached === true;
      const piNew = p2 ? asCents(p2.new_pi_cents) : asCents(p.pi_new_cents), escNew = p1 ? asCents(p1.new_escrow_cents) : asCents(p.escrow_new_cents), total = asCents(p.new_total_cents);
      checklist.FORM410S1_TOTAL_EQ_PI_PLUS_ESCROW = piNew !== null && escNew !== null && total !== null && total === piNew + escNew;
      break;
    }
    case "CRT_B410S2": {
      const items = (p.lines as { line_no: string; description: string; amount_cents: unknown; dates_incurred: string[] }[] | undefined) ?? [];
      lines.push("Part 1: Itemize Postpetition Fees, Expenses, and Charges. Do not include any escrow account disbursements or any amounts previously itemized in a notice filed in this case. Description | Dates incurred | Amount");
      for (const l of items) lines.push(`${l.line_no}. ${l.description} | Dates incurred: ${(l.dates_incurred ?? []).join(", ")} | Amount: ${m(l.amount_cents)}`);
      lines.push(`Total: ${m(p.total_cents)}`, `Part 2: Sign Here. ${signer}. ${DECLARATION} Signed: ${s(p, "signer_name")} on ${s(p, "signed_on")}.`);
      const ids = (p.fee_item_ids as string[] | undefined) ?? [], prev = new Set((p.previously_noticed_ids as string[] | undefined) ?? []);
      checklist.FORM410S2_LINES_PRESENT = items.length > 0;
      checklist.FORM410S2_DATES_PRESENT = items.every((l) => Array.isArray(l.dates_incurred) && l.dates_incurred.length > 0 && l.dates_incurred.every((d) => ISO_DATE.test(d)));
      checklist.FORM410S2_NO_ESCROW_DISBURSEMENTS = items.every((l) => S2_LINE.test(String(l.line_no)) && !/escrow/i.test(String(l.description ?? "")));
      checklist.FORM410S2_NO_PREVIOUSLY_NOTICED_ITEMS = ids.every((id) => !prev.has(id));
      const sum = items.reduce<Cents | null>((acc, l) => { const c = asCents(l.amount_cents); return acc === null || c === null ? null : acc + c; }, 0n); const total = asCents(p.total_cents);
      checklist.FORM410S2_TOTAL_EQ_SUM = sum !== null && total !== null && sum === total;
      break;
    }
    case "CRT_B410C13_M1R": case "CRT_B410C13_NR": case "CRT_B410C13_M2R": {
      const r = p.response as StatusResponse | undefined;
      lines.push(code === "CRT_B410C13_NR" ? "This response is filed as a supplement to the claim holder's proof of claim within 28 days after service of the trustee's notice." : code === "CRT_B410C13_M1R" ? "This response is filed within 28 days after the motion is served and addresses each fact stated in the motion." : "This response is filed within 28 days after service of the motion under Rule 3002.1(g)(4).");
      if (r) {
        lines.push(`Part 2: Prepetition Arrearage. ${r.part2.prepetition_cured ? "The amount required to cure any prepetition arrearage has been paid in full." : `The amount required to cure the prepetition arrearage has not been paid in full; ${m(r.part2.remaining_cents)} remains.`}`);
        lines.push(`Part 3: Postpetition Payments. ${r.part3.statement === "current" ? "The debtor is current on all postpetition payments, including all fees, charges, expenses, escrow, and costs." : `The debtor is not current; the debtor first became delinquent on ${r.part3.first_unpaid_postpetition_due}: ${r.part3.itemization.map((x) => `${x.due} ${m(x.amount_cents)}`).join("; ")}.`} Last payment received: ${r.part3.last_payment_received_on ?? "none"}. Next payment due ${r.part3.next_due_date}: ${m(r.part3.next_due_cents)}. Unpaid principal balance: ${m(r.part3.upb_cents)}. Deferred/accrued interest: ${m(r.part3.deferred_interest_cents)}. Escrow balance: ${m(r.part3.escrow_balance_cents)}. Unapplied/suspense funds: ${m(r.part3.unapplied_cents)}. Unpaid fees/charges: ${m(r.part3.unpaid_fees_cents)}.`);
        lines.push(`Part 4: Itemized Payment History. ${r.part4_history ? `Attached (${r.part4_history.length} entries).` : "Not required — the response agrees and asserts no default."}`);
        if (r.disagreements.length) lines.push(`Disputed facts: ${r.disagreements.join(" | ")}`);
      } else lines.push("Part 2: Prepetition Arrearage. Part 3: Postpetition Payments. Part 4: Itemized Payment History.");
      lines.push(`Part 5: Sign Here. ${signer}. ${DECLARATION} Signed: ${s(p, "signer_name")} on ${s(p, "signed_on")}.`);
      checklist.RESPONSE_PRESENT = r !== undefined && r !== null && typeof r === "object" && "part3" in r;
      checklist.RESPONSE_FORM_MATCHES_TEMPLATE = checklist.RESPONSE_PRESENT && r!.form === RESPONSE_FORM[code as CourtFormCode];
      checklist.FORM410C13NR_SUPPLEMENT_TO_CLAIM = code !== "CRT_B410C13_NR" || (checklist.RESPONSE_PRESENT && r!.filed_as === "supplement_to_proof_of_claim");
      const part4Required = checklist.RESPONSE_PRESENT && (!r!.agree || r!.part3.statement !== "current" || !r!.part2.prepetition_cured);
      checklist.FORM410C13NR_PART4_REQUIRED_IF_DISAGREE = !part4Required || (Array.isArray(r!.part4_history) && r!.part4_history.length > 0);
      break;
    }
    case "CRT_CERTIFICATE_OF_SERVICE": {
      const parties = (p.service_list as { party: string; method: string; address?: string; consent?: boolean }[] | undefined) ?? [];
      lines.push(`I certify that on ${s(p, "served_on")} I served the foregoing ${s(p, "paper")} on: ${parties.map((x) => `${x.party} by ${x.method === "mail" ? "first-class mail" : x.method === "email" ? "e-mail (consented)" : "CM/ECF"}${x.address ? ` at ${x.address}` : ""}`).join("; ")}.`, `Signed: ${s(p, "signer_name")}.`);
      const by = new Map(parties.map((x) => [x.party, x] as const)); const debtor = by.get("debtor");
      checklist.SERVED_ON_PRESENT = ISO_DATE.test(s(p, "served_on"));
      checklist.SERVICE_LIST_COMPLETE = by.has("debtor") && by.has("trustee") && (by.has("debtor_attorney") || p.pro_se === true);
      checklist.SERVICE_METHODS_VALID = parties.length > 0 && parties.every((x) => /^(mail|cm_ecf|email)$/.test(x.method));
      checklist.DEBTOR_SERVED_BY_MAIL_OR_CONSENTED_EMAIL = debtor !== undefined && (debtor.method === "mail" || (debtor.method === "email" && debtor.consent === true));
      break;
    }
  }
  const text = lines.join("\n");
  checklist.CREDITOR_NAMED = s(p, "creditor_name").trim() !== "";
  // Rule 9037: only the last four digits of any account identifier; no full account, SSN or loan number anywhere on the paper
  checklist.FRBP_9037_REDACTION = /^\d{4}$/.test(s(p, "account_last4")) && !/\b\d{5,}\b/.test(text) && !/\b\d{3}-\d{2}-\d{4}\b/.test(text);
  checklist.SIGNER_ROLE_PRESENT = (role === "creditor" || role === "authorized_agent") && s(p, "signer_name").trim() !== "" && ISO_DATE.test(s(p, "signed_on"));
  const failed = Object.entries(checklist).filter(([, ok]) => !ok).map(([k]) => k);
  return { code: code as CourtFormCode, form: f.form, title: f.title, revision: f.revision, text, checklist, blocked: failed.length > 0, failed, sha256: createHash("sha256").update(text).digest("hex") };
}

// ============================================================ inputs: `fee.incurred_postpetition` ingestion (2.7 / 9.x / 13.6 → the exposure list owned here)
export type FilingType = "s1_payment_change" | "s2_fee_notice" | "m1r_status_response" | "nr_final_cure_response" | "m2r_motion_response";
export const FILING_TYPES: readonly FilingType[] = ["s1_payment_change", "s2_fee_notice", "m1r_status_response", "nr_final_cure_response", "m2r_motion_response"];
/** The inbound record of the spec's inputs: `{loan_id, fee_type (410S-2 line), incurred_on, amount_cents, recoverable_basis, evidence_document_id}`. */
export interface IncomingFeeItem { readonly id: string; readonly line: string; readonly description?: string | null; readonly incurred_on: string; readonly amount_cents: Cents; readonly recoverable_basis: string | null; readonly evidence_document_id: string | null; readonly fnma_reimbursed?: boolean; readonly netting_rule_confirmed?: boolean; readonly intend_to_recover?: boolean; }
export interface StoredFeeItem extends PostpetitionFeeItem { readonly description: string; readonly recoverable_basis: string | null; readonly evidence_document_id: string | null; readonly fnma_reimbursed: boolean; readonly notice_deadline: PlainDate; }
/**
 * Rule 5 / `BK_3002_1C_FEE_NOTICE_180` + `SM_BK_3002_1C_BATCH_90` triggers: validate one inbound fee item (an on-form line, a real
 * incurrence date on or before `today`, a positive amount, its evidence) and decide whether it enters the exposure list as `incurred`
 * (recoverable per `recoverable_basis`, not reimbursed by Fannie Mae without the 15.2 netting rule) or is `waived` and never noticed
 * (policy defaults: 14.1-Q6 late charges, reimbursed fees). Only an `incurred` item emits `fee.incurred_postpetition`; `first_unnoticed`
 * is true when no other open (incurred/batched, recoverable) item exists for the loan — that item's `incurred_on` anchors the 90-day batch cadence.
 */
export function ingestFeeItem(i: IncomingFeeItem, openItems: readonly { id: string; status: FeeItemStatus; recoverable: boolean }[], today: PlainDate, courtHolidays: readonly PlainDate[] = []): { item: StoredFeeItem; first_unnoticed: boolean; waived_reason: string | null; event: { type: "fee.incurred_postpetition"; payload: Record<string, unknown> } | { type: "bankruptcy.fee_item.waived"; payload: Record<string, unknown> } } {
  if (!S2_LINE.test(i.line)) throw new RangeError(`fee_type/line ${i.line} is not a Form 410S-2 line (1–14)`);
  const incurredOn = (() => { try { return (i.incurred_on.length >= 10 && ISO_DATE.test(i.incurred_on.slice(0, 10)) ? i.incurred_on.slice(0, 10) : i.incurred_on) as PlainDate; } catch { throw new RangeError(`incurred_on ${i.incurred_on} is not a date`); } })();
  if (!ISO_DATE.test(incurredOn)) throw new RangeError(`incurred_on ${i.incurred_on} is not a date`);
  if (incurredOn > today) throw new RangeError(`incurred_on ${incurredOn} is after today ${today}: a fee is noticed after it is incurred, never before`);
  if (i.amount_cents <= 0n) throw new RangeError(`amount_cents ${i.amount_cents} must be positive`);
  if (!i.evidence_document_id) throw new RangeError("evidence_document_id is required (incurrence evidence for the sanction-proof bundle)");
  const basis = (i.recoverable_basis ?? "").trim();
  const waived = i.intend_to_recover === false ? "servicer does not intend to recover the item from the debtor (rule 5 policy)" : basis === "" ? "no recoverable_basis (note/security instrument clause, state law or exhibit line) — not asserted against the debtor" : i.fnma_reimbursed === true && i.netting_rule_confirmed !== true ? "reimbursed by Fannie Mae and the 15.2 netting rule is not confirmed — never noticed for recovery" : null;
  const item: StoredFeeItem = { id: i.id, line: i.line, description: (i.description ?? "").trim() || (FORM_410S2_LINES[i.line] ?? "Other"), incurred_on: incurredOn, cents: i.amount_cents, recoverable: waived === null, status: waived === null ? "incurred" : "waived", recoverable_basis: basis || null, evidence_document_id: i.evidence_document_id, fnma_reimbursed: i.fnma_reimbursed === true, notice_deadline: noticeDeadline180(incurredOn, courtHolidays) };
  const others = openItems.filter((o) => o.id !== i.id && (o.status === "incurred" || o.status === "batched") && o.recoverable);
  const firstUnnoticed = waived === null && others.length === 0;
  const event = waived === null
    ? { type: "fee.incurred_postpetition" as const, payload: { fee_item_id: item.id, fee_type: item.line, line: item.line, description: item.description, incurred_on: item.incurred_on, amount_cents: item.cents, recoverable_basis: item.recoverable_basis, evidence_document_id: item.evidence_document_id, first_unnoticed: firstUnnoticed, notice_deadline: item.notice_deadline, fnma_reimbursed: item.fnma_reimbursed } }
    : { type: "bankruptcy.fee_item.waived" as const, payload: { fee_item_id: item.id, line: item.line, incurred_on: item.incurred_on, amount_cents: item.cents, reason: waived } };
  return { item, first_unnoticed: firstUnnoticed, waived_reason: waived, event };
}

// ============================================================ rule 7: plan completion → the ledger views frozen for the (g) response
export const PLAN_COMPLETION_SOURCES = ["tfs", "epay", "final_voucher", "trustee_final_report", "ntc_final_report"] as const;
/** The frozen post-petition and arrearage views (from `bankruptcy_ledger_views`) the 410C13-NR is computed from. */
export interface FrozenLedgerViews { readonly prepetition_arrearage_cents: Cents; readonly postpetition: readonly PostpetitionRow[]; readonly unpaid_noticed_fees_cents: Cents; readonly escrow_balance_cents: Cents; readonly unapplied_cents: Cents; readonly deferred_interest_cents: Cents; readonly last_payment_received_on: PlainDate | null; readonly history: readonly Record<string, unknown>[]; readonly amortization: Amortization | null; readonly escrow_monthly_cents: Cents | null; readonly cure_received_cents: Cents | null; readonly postpetition_received_cents: Cents | null; readonly source_view_id: string | null; }
/**
 * `SM_BK_3002_1G1_TRUSTEE_NOTICE_WATCH_45`: the trustee's plan-completion signal (TFS/EPay final voucher, final report) is validated and the
 * post-petition and arrearage views are frozen — hashed — for the expected Form 410C13-N (within 45 days). The (g)(3) response is then computed
 * from this snapshot, never from figures a caller hands in.
 */
export function planCompletionFreeze(sig: { completed_on: string; source: string; final_voucher_id?: string | null; trustee_id?: string | null }, views: FrozenLedgerViews, frozenAt: string): { completed_on: PlainDate; source: string; final_voucher_id: string | null; trustee_id: string | null; frozen_at: string; views: FrozenLedgerViews; ledger_snapshot_hash: string; watch: { timer: "SM_BK_3002_1G1_TRUSTEE_NOTICE_WATCH_45"; anchor: "completed_on"; lapses_on: PlainDate; on_lapse: string }; event: { type: "bankruptcy.plan.completed"; payload: Record<string, unknown> } } {
  if (!ISO_DATE.test(sig.completed_on)) throw new RangeError(`completed_on ${sig.completed_on} is not a date`);
  const completedOn = sig.completed_on as PlainDate;
  if (!(PLAN_COMPLETION_SOURCES as readonly string[]).includes(sig.source)) throw new RangeError(`source ${sig.source} is not one of ${PLAN_COMPLETION_SOURCES.join("/")}`);
  if (completedOn > (frozenAt.slice(0, 10) as PlainDate)) throw new RangeError(`completed_on ${completedOn} is in the future`);
  if ((sig.source === "final_voucher" || sig.source === "tfs" || sig.source === "epay") && !sig.final_voucher_id) throw new RangeError("final_voucher_id is required for a voucher-based completion signal");
  const hash = computationHash({ completed_on: completedOn, views });
  const lapses = addDays(completedOn, 45);
  return { completed_on: completedOn, source: sig.source, final_voucher_id: sig.final_voucher_id ?? null, trustee_id: sig.trustee_id ?? null, frozen_at: frozenAt, views, ledger_snapshot_hash: hash,
    watch: { timer: "SM_BK_3002_1G1_TRUSTEE_NOTICE_WATCH_45", anchor: "completed_on", lapses_on: lapses, on_lapse: "counsel requests the trustee's Form 410C13-N / considers an (f) motion; the post-petition ledger stays frozen; no post-case collection of plan-period amounts until resolved" },
    event: { type: "bankruptcy.plan.completed", payload: { completed_on: completedOn, source: sig.source, final_voucher_id: sig.final_voucher_id ?? null, trustee_id: sig.trustee_id ?? null, ledger_snapshot_hash: hash, watch_timer: "SM_BK_3002_1G1_TRUSTEE_NOTICE_WATCH_45", watch_lapses_on: lapses } } };
}

// ============================================================ docket papers the 14.1 monitor hands to 14.2
export const RESPONSE_PAPERS = { motion_410c13_m1: { kind: "m1r", form: "410C13-M1R", timer: "FRBP_3002_1F_STATUS_RESPONSE_28", filing_type: "m1r_status_response", cite: "Rule 3002.1(f)" }, trustee_notice_410c13_n: { kind: "nr", form: "410C13-NR", timer: "FRBP_3002_1G3_FINAL_CURE_RESPONSE_28", filing_type: "nr_final_cure_response", cite: "Rule 3002.1(g)(3)" }, motion_410c13_m2: { kind: "m2r", form: "410C13-M2R", timer: "FRBP_3002_1G4_MOTION_RESPONSE_28", filing_type: "m2r_motion_response", cite: "Rule 3002.1(g)(4)" } } as const;
export type ResponsePaperKind = keyof typeof RESPONSE_PAPERS;
/** Rules 6–7: a served (f)/(g) paper opens the response (`triggered`) with its 28-day (+3 if mailed, 9006(f)) deadline, 9006(a) forward over federal and court holidays. */
export function responseTrigger(kind: string, servedOn: PlainDate, byMail: boolean, docketEventId: string | null, courtHolidays: readonly PlainDate[] = []): { kind: ResponseKind; form: string; responds_to: string; timer: string; filing_type: FilingType; trigger_docket_event_id: string | null; served_on: PlainDate; service_method: "mail" | "cm_ecf"; mail_days_added: 0 | 3; response_deadline: PlainDate; status: "triggered"; cite: string } {
  if (!(kind in RESPONSE_PAPERS)) throw new RangeError(`docket kind ${kind} is not one of ${Object.keys(RESPONSE_PAPERS).join("/")}`);
  const p = RESPONSE_PAPERS[kind as ResponsePaperKind];
  return { kind: p.kind, form: p.form, responds_to: kind, timer: p.timer, filing_type: p.filing_type, trigger_docket_event_id: docketEventId, served_on: servedOn, service_method: byMail ? "mail" : "cm_ecf", mail_days_added: byMail ? 3 : 0, response_deadline: responseDueCourt(servedOn, byMail, courtHolidays), status: "triggered", cite: p.cite };
}
/**
 * `FRBP_3002_1B4_OBJECTION_WINDOW` resolution on the due date: absent a (b)(4) motion docketed before the day the new payment is due
 * (or once the court's order is entered) the notice is `effective` and the new amount bills; a pending motion keeps the notice `objected`
 * and the prior amount bills until the order (Rule 3002.1(b)(4)).
 */
export function effectiveOnDueDate(n: FiledNotice & { objection?: { docketed_on: PlainDate } | null; order?: { entered_on: PlainDate } | null }, today: PlainDate): { status: NoticeStatus; effective: boolean; bills_cents: Cents; reason: string; gate_facts: { b4_motion_docketed: boolean; b4_motion_docketed_on: PlainDate | null; effective_due_date: PlainDate; court_order_entered: boolean } } {
  const motion = n.objection ?? null; const before = motion !== null && motion.docketed_on < n.effective_due_date; const ordered = Boolean(n.order);
  const facts = { b4_motion_docketed: before, b4_motion_docketed_on: motion?.docketed_on ?? null, effective_due_date: n.effective_due_date, court_order_entered: ordered };
  if (n.status === "determined" || n.status === "superseded" || n.status === "withdrawn") return { status: n.status, effective: false, bills_cents: n.status === "determined" ? n.new_total_cents : n.old_total_cents, reason: `notice is ${n.status}`, gate_facts: facts };
  if (today < n.effective_due_date) return { status: n.status, effective: false, bills_cents: n.old_total_cents, reason: `before the due date ${n.effective_due_date}: the (b)(4) window is open`, gate_facts: facts };
  if (before && !ordered) return { status: "objected", effective: false, bills_cents: n.old_total_cents, reason: `Rule 3002.1(b)(4) motion docketed ${motion!.docketed_on} before the due date: held at the prior amount pending the court's order`, gate_facts: facts };
  return { status: "effective", effective: true, bills_cents: n.new_total_cents, reason: `no (b)(4) motion before ${n.effective_due_date}: the change went into effect on that date (Rule 3002.1(b)(4))`, gate_facts: facts };
}

// ============================================================ E-2.1-04: counsel's request for figures for a 3002.1 paper (FNMA_E2_1_04_DOCS_TO_FIRM_3BD)
/** Validates counsel's figures request for a 3002.1 paper and computes the 3-servicer-business-day delivery deadline (14.1 `documentRequestDue`). */
export function figuresRequest(i: { request_id: string; firm_id: string; filing_type: string; requested_at: string; fulfilled_at?: string | null; today?: PlainDate | null }): { request_id: string; firm_id: string; filing_type: FilingType; request_at: string; requested_on: PlainDate; due: PlainDate; timer: "FNMA_E2_1_04_DOCS_TO_FIRM_3BD"; business_days: 3; calendar: "business_days_servicer"; fulfilled_at: string | null; late: boolean; breached: boolean; escalation: { kind: "officer"; severity: "sev2"; reason: string } | null } {
  if (!i.request_id) throw new RangeError("request_id is required"); if (!i.firm_id) throw new RangeError("firm_id is required");
  if (!(FILING_TYPES as readonly string[]).includes(i.filing_type)) throw new RangeError(`filing_type ${i.filing_type} is not a 3002.1 paper (${FILING_TYPES.join("/")})`);
  if (Number.isNaN(Date.parse(i.requested_at))) throw new RangeError(`requested_at ${i.requested_at} is not a timestamp`);
  const fulfilledOn = i.fulfilled_at ? (i.fulfilled_at.slice(0, 10) as PlainDate) : null;
  const r = documentRequestDue({ requested_at: i.requested_at, fulfilled_on: fulfilledOn, today: i.today ?? null });
  const late = fulfilledOn !== null && fulfilledOn > r.due;
  const esc = r.escalation ? { kind: "officer" as const, severity: "sev2" as const, reason: r.escalation.reason } : late ? { kind: "officer" as const, severity: "sev2" as const, reason: `figures for the ${i.filing_type} delivered ${fulfilledOn} after the E-2.1-04 deadline ${r.due}` } : null;
  return { request_id: i.request_id, firm_id: i.firm_id, filing_type: i.filing_type as FilingType, request_at: i.requested_at, requested_on: r.requested_on, due: r.due, timer: "FNMA_E2_1_04_DOCS_TO_FIRM_3BD", business_days: 3, calendar: "business_days_servicer", fulfilled_at: i.fulfilled_at ?? null, late, breached: r.breached, escalation: esc };
}
