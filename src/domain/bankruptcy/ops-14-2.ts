/**
 * §14.2 operating rules over the Rule 3002.1 calculators in ./notices.ts:
 * the scope test and deadline set for a detected change (rule 1–2), the
 * post-petition escrow change arithmetic and untimely-notice billing of
 * rule 2, the ARM 5-BD filing and Part-2 attachment of rule 3, the
 * same-due-date supersession of the edge cases, the fee batch schedule
 * and Form 410S-2 lines of rule 5, the Form 410C13-NR response and (g)(4)
 * window of rule 7, the (b)(4) motion hold, the relief-order policy
 * (14.2-Q2) and the Form 410S-1 checklist of the outputs section.
 * Every function is pure; the tools in src/app/tools/section14-2.ts and the
 * tests in ./14-2.spec.test.ts call these.
 */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { paymentChangeDeadline, timeliness, feeBatchDecision, rollForward9006, responseDue, endOfCaseResponse, inScope, challengeDeadline, type FeeItem } from "./notices.ts";

export type ChangeSource = "escrow_analysis" | "arm_adjustment" | "pmi_termination" | "scra_rate" | "modification" | "other";
export type NoticeStatus = "computed" | "package_ready" | "escalated" | "signed" | "filed_served" | "effective" | "objected" | "determined" | "superseded" | "withdrawn";
/** Form 410S-1 part used for a change source (rule 3–4). */
export const PART_FOR_SOURCE: Record<ChangeSource, 1 | 2 | 4> = { escrow_analysis: 1, arm_adjustment: 2, pmi_termination: 4, scra_rate: 4, modification: 4, other: 4 };
/** Form 410S-2 (12/16) Part 1 line captions. */
export const FORM_410S2_LINES: Record<string, string> = { "1": "Late charges", "2": "Non-sufficient funds (NSF) fees", "3": "Attorney fees", "4": "Filing fees and court costs", "5": "Bankruptcy/Proof of claim fees", "6": "Appraisal/Broker's price opinion fees", "7": "Property inspection fees", "8": "Tax advances (non-escrow)", "9": "Insurance advances (non-escrow)", "10": "Property preservation expenses", "11": "Other", "12": "Other", "13": "Other", "14": "Other" };
export const FNMA_FEE_NOTICE_THRESHOLD_CENTS: Cents = 20_000n;
export const RULE_SET_VERSION = "frbp.2025-12; fnma.bk_fees.2025-11-12" as const;

export interface DecisionRecord { readonly filing_type: string; readonly scope_test_result: string; readonly rule_code: string; readonly rationale: string; readonly rule_set_version: typeof RULE_SET_VERSION; readonly outcome: string; }

// ============================================================ rule 1–2: detection, scope, deadlines
export interface CaseFacts { readonly chapter: "7" | "11" | "12" | "13"; readonly principal_residence: boolean | null; readonly treatment: "cure_and_maintain" | "pay_outside" | "surrender" | "unknown"; readonly relief_order_effective: boolean; readonly case_open?: boolean; readonly ch12_local_flag?: boolean; }
export interface ScheduledChange { readonly source: ChangeSource; readonly old_total_cents: Cents; readonly new_total_cents: Cents; readonly effective_due_date: PlainDate; readonly detected_on: PlainDate; readonly evidence_document_ids?: readonly string[]; }
/** Rule 1–2 + `SM_BK_PAYMENT_CHANGE_DETECT_1BD`: scope test, change kind, the 9006 deadline set and the 1-BD row deadline for one `payment.change.scheduled`. */
export function detectChange(c: ScheduledChange, f: CaseFacts): { in_scope: boolean; change_kind: "increase" | "decrease" | "none"; part: 1 | 2 | 4; deadline_file_serve: PlainDate; target_file_date: PlainDate; row_due_by: PlainDate; status: NoticeStatus | "out_of_scope"; decision: DecisionRecord } {
  const scope = inScope({ chapter: f.chapter, principal_residence: f.principal_residence, treatment: f.treatment, relief_order_effective: f.relief_order_effective, policy_continue_after_relief: f.case_open !== false, ...(f.ch12_local_flag !== undefined ? { ch12_local_flag: f.ch12_local_flag } : {}) });
  const d = paymentChangeDeadline(c.effective_due_date);
  const kind = c.new_total_cents > c.old_total_cents ? "increase" : c.new_total_cents < c.old_total_cents ? "decrease" : "none";
  const why = !scope ? `out of scope: chapter ${f.chapter}, principal_residence=${String(f.principal_residence)}, treatment=${f.treatment}, relief=${f.relief_order_effective}` : `in scope (Rule 3002.1(a)): chapter ${f.chapter}, principal residence${f.principal_residence === null ? " unknown → comply" : ""}, ${f.treatment}${f.relief_order_effective ? "; relief order entered → keep filing while the case is open (14.2-Q2)" : ""}`;
  return { in_scope: scope, change_kind: kind, part: PART_FOR_SOURCE[c.source], deadline_file_serve: d.deadline, target_file_date: d.target, row_due_by: addBusinessDays(c.detected_on, 1, servicer), status: scope ? "computed" : "out_of_scope",
    decision: { filing_type: "410S-1", scope_test_result: scope ? (f.relief_order_effective ? "in_scope_policy_continue" : "in_scope") : "out_of_scope", rule_code: f.relief_order_effective && scope ? "14.2-Q2" : "14.2 rule 1", rationale: why, rule_set_version: RULE_SET_VERSION, outcome: scope ? "notice_required" : "skipped_with_decision_record" } };
}

/** Rule 2 worked example: base escrow + shortage ÷ spread months → new escrow and the old/new totals. */
export function postpetitionEscrowChange(i: { pi_cents: Cents; escrow_old_cents: Cents; shortage_cents: Cents; spread_months?: number; effective_due_date: PlainDate }): { shortage_monthly_cents: Cents; escrow_new_cents: Cents; old_total_cents: Cents; new_total_cents: Cents; change_kind: "increase" | "decrease" | "none"; part: 1; deadline_file_serve: PlainDate; target_file_date: PlainDate } {
  const months = BigInt(i.spread_months ?? 12); const monthly = divRound(i.shortage_cents, months, "HALF_UP"); const escrowNew = i.escrow_old_cents + monthly;
  const oldTotal = i.pi_cents + i.escrow_old_cents, newTotal = i.pi_cents + escrowNew; const d = paymentChangeDeadline(i.effective_due_date);
  return { shortage_monthly_cents: monthly, escrow_new_cents: escrowNew, old_total_cents: oldTotal, new_total_cents: newTotal, change_kind: newTotal > oldTotal ? "increase" : newTotal < oldTotal ? "decrease" : "none", part: 1, deadline_file_serve: d.deadline, target_file_date: d.target };
}

/** Rule 2 / (b)(3): what each installment bills after a notice served on `served_on` — an untimely increase waits for the first due date ≥ 21 days after service (the old amount bills meanwhile, 3.2 is told to push its effective date, the timing loss is absorbed, 14.2-Q4); a decrease applies on the actual due date. */
export function untimelyNoticeBilling(i: { effective_due_date: PlainDate; served_on: PlainDate; old_total_cents: Cents; new_total_cents: Cents; timing_loss_monthly_cents?: Cents; months?: number }): { timely: boolean; days_notice: number; effective_date_applied: PlainDate; installments: { due: PlainDate; bills_cents: Cents }[]; pushed_event: { type: "payment.change.effective_date.pushed"; from: PlainDate; to: PlainDate } | null; timing_loss_cents: Cents; re_notice: false } {
  const inc = i.new_total_cents > i.old_total_cents; const t = timeliness(i.effective_due_date, i.served_on, inc);
  const months = i.months ?? 2; const out: { due: PlainDate; bills_cents: Cents }[] = []; let due = i.effective_due_date; let lost = 0n;
  for (let k = 0; k < months; k++) { const applies = due >= t.effective_date_applied; out.push({ due, bills_cents: applies ? i.new_total_cents : i.old_total_cents }); if (!applies) lost += i.timing_loss_monthly_cents ?? 0n; due = nextDue(due); }
  return { timely: t.timely, days_notice: t.days_notice, effective_date_applied: t.effective_date_applied, installments: out, pushed_event: t.effective_date_applied !== i.effective_due_date ? { type: "payment.change.effective_date.pushed", from: i.effective_due_date, to: t.effective_date_applied } : null, timing_loss_cents: lost, re_notice: false };
}
function nextDue(d: PlainDate): PlainDate { const [y, m, day] = d.split("-").map(Number) as [number, number, number]; const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1; return `${ny}-${String(nm).padStart(2, "0")}-${String(day).padStart(2, "0")}` as PlainDate; }

// ============================================================ rule 3: ARM changes
/** Rule 3: the 410S-1 (Part 2, Reg Z notice attached) is filed within 5 BD of the §1026.20(c) notice and in any case by the 9006 deadline (21 days before the change). */
export function armChangeNotice(i: { reg_z_notice_on: PlainDate; effective_due_date: PlainDate; rate_old: string; rate_new: string; pi_old_cents: Cents; pi_new_cents: Cents; escrow_cents: Cents; rate_change_notice_document_id: string | null; filed_served_on?: PlainDate | null }): { part: 2; file_by: PlainDate; deadline_file_serve: PlainDate; target_file_date: PlainDate; attachment_ok: boolean; part2: { current_rate: string; new_rate: string; current_pi_cents: Cents; new_pi_cents: Cents }; new_total_cents: Cents; filed_on: PlainDate | null; timely: boolean | null; deadline_satisfied: boolean | null; days_notice: number | null } {
  const d = paymentChangeDeadline(i.effective_due_date); const five = addBusinessDays(i.reg_z_notice_on, 5, servicer); const fileBy = five < d.deadline ? five : d.deadline;
  const filed = i.filed_served_on ?? null; const t = filed ? timeliness(i.effective_due_date, filed, i.pi_new_cents > i.pi_old_cents) : null;
  return { part: 2, file_by: fileBy, deadline_file_serve: d.deadline, target_file_date: d.target, attachment_ok: Boolean(i.rate_change_notice_document_id), part2: { current_rate: i.rate_old, new_rate: i.rate_new, current_pi_cents: i.pi_old_cents, new_pi_cents: i.pi_new_cents }, new_total_cents: i.pi_new_cents + i.escrow_cents, filed_on: filed, timely: t ? t.timely : null, deadline_satisfied: filed ? filed <= d.deadline : null, days_notice: t ? t.days_notice : null };
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
/** Rule 5 / `SM_BK_3002_1C_BATCH_90`: when the open batch files — immediately at ≥ $200 aggregate, else on the oldest item's day 90 — always before the oldest item's 180-day preclusion; Fannie Mae's $200 fee is claimable only at ≥ $200 (the rule, not the fee schedule, governs). */
export function feeBatchSchedule(items: readonly FeeItem[], today: PlainDate): { file_now: boolean; reason: string | null; files_on: PlainDate | null; preclusion_first: PlainDate | null; before_day_180: boolean | null; aggregate_cents: Cents; fnma_fee_claimable: boolean; filing_required: boolean } {
  const d = feeBatchDecision(items, today); const open = items.filter((i) => i.status === "incurred" && i.recoverable);
  if (!open.length) return { file_now: false, reason: null, files_on: null, preclusion_first: null, before_day_180: null, aggregate_cents: 0n, fnma_fee_claimable: false, filing_required: false };
  const oldest = open.reduce((a, b) => (b.incurred_on < a.incurred_on ? b : a)); const claimable = d.aggregate_cents >= FNMA_FEE_NOTICE_THRESHOLD_CENTS;
  const filesOn = claimable ? (today < oldest.incurred_on ? oldest.incurred_on : today) : addDays(oldest.incurred_on, 90);
  return { file_now: d.file_now, reason: d.reason, files_on: filesOn, preclusion_first: d.preclusion_first, before_day_180: d.preclusion_first ? filesOn < d.preclusion_first : null, aggregate_cents: d.aggregate_cents, fnma_fee_claimable: claimable, filing_required: true };
}
/** Rule 5: Form 410S-2 Part 1 lines from the batch (one line per 410S-2 line number, dates incurred listed), the total and the form checklist. */
export function form410s2Lines(items: readonly FeeItem[], servedOn?: PlainDate | null): { lines: { line_no: string; description: string; amount_cents: Cents; dates_incurred: PlainDate[] }[]; total_cents: Cents; checklist: { FORM410S2_NO_ESCROW_DISBURSEMENTS: boolean; FORM410S2_NO_PREVIOUSLY_NOTICED_ITEMS: boolean; FORM410S2_DATES_PRESENT: boolean; FORM410S2_TOTAL_EQ_SUM: boolean }; passed: boolean; challenge_deadline: PlainDate | null } {
  const inBatch = items.filter((i) => (i.status === "incurred" || i.status === "batched") && i.recoverable);
  const by = new Map<string, { line_no: string; description: string; amount_cents: Cents; dates_incurred: PlainDate[] }>();
  for (const i of inBatch) { const l = by.get(i.line) ?? { line_no: i.line, description: FORM_410S2_LINES[i.line] ?? "Other", amount_cents: 0n, dates_incurred: [] }; l.amount_cents += i.cents; if (!l.dates_incurred.includes(i.incurred_on)) l.dates_incurred.push(i.incurred_on); by.set(i.line, l); }
  const lines = [...by.values()].sort((a, b) => Number(a.line_no) - Number(b.line_no)); const total = lines.reduce((s, l) => s + l.amount_cents, 0n);
  const checklist = { FORM410S2_NO_ESCROW_DISBURSEMENTS: inBatch.every((i) => !/escrow/i.test(i.line)), FORM410S2_NO_PREVIOUSLY_NOTICED_ITEMS: items.every((i) => i.status !== "noticed" || !inBatch.includes(i)), FORM410S2_DATES_PRESENT: lines.every((l) => l.dates_incurred.length > 0), FORM410S2_TOTAL_EQ_SUM: total === inBatch.reduce((s, i) => s + i.cents, 0n) };
  return { lines, total_cents: total, checklist, passed: Object.values(checklist).every(Boolean), challenge_deadline: servedOn ? challengeDeadline(servedOn) : null };
}

// ============================================================ rule 7: end of case (g)
export interface PostpetitionRow { readonly due: PlainDate; readonly amount_cents: Cents; readonly paid_cents: Cents; }
export interface Form410c13nInput { readonly served_on: PlainDate; readonly by_mail: boolean; readonly notice_date?: PlainDate; readonly arrearage_cents: Cents; readonly postpetition: readonly PostpetitionRow[]; readonly unpaid_noticed_fees_cents: Cents; readonly last_payment_received_on: PlainDate | null; readonly next_due: PlainDate; readonly next_due_cents: Cents; readonly upb_cents: Cents; readonly deferred_interest_cents: Cents; readonly escrow_balance_cents: Cents; readonly unapplied_cents: Cents; readonly history: readonly Record<string, unknown>[]; }
/** Rule 7: the Form 410C13-NR from the frozen ledger views — Part 2 cure, Part 3 current / first unpaid + itemization and payoff-style data, Part 4 history whenever the response disagrees, filed as a POC supplement, served on debtor, counsel and trustee. */
export function form410c13nr(i: Form410c13nInput): { response_due: PlainDate; filed_as: "supplement_to_proof_of_claim"; part2: { prepetition_cured: boolean; statement: "paid in full" | "amount remaining"; remaining_cents: Cents }; part3: { statement: "current" | "not current"; first_unpaid_postpetition_due: PlainDate | null; itemization: { due: PlainDate; amount_cents: Cents }[]; unpaid_fees_cents: Cents; last_payment_received_on: PlainDate | null; next_due_date: PlainDate; next_due_cents: Cents; upb_cents: Cents; deferred_interest_cents: Cents; escrow_balance_cents: Cents; unapplied_cents: Cents }; part4_history: readonly Record<string, unknown>[] | null; agree: boolean; service: readonly ["debtor", "debtor_attorney", "trustee"]; checklist: { FORM410C13NR_SUPPLEMENT_TO_CLAIM: true; FORM410C13NR_PART4_REQUIRED_IF_DISAGREE: boolean }; fnma_fee_cents: Cents; precludes_later_default_claim: boolean } {
  const asOf = i.notice_date ?? i.served_on;
  const unpaid = i.postpetition.filter((r) => r.due <= asOf && r.paid_cents < r.amount_cents).sort((a, b) => (a.due < b.due ? -1 : 1)).map((r) => ({ due: r.due, cents: r.amount_cents - r.paid_cents }));
  const e = endOfCaseResponse({ arrearage_cents: i.arrearage_cents, postpetition_unpaid: unpaid, unpaid_noticed_fees_cents: i.unpaid_noticed_fees_cents, upb_cents: i.upb_cents, next_due: i.next_due, next_amount_cents: i.next_due_cents });
  const agree = e.current && e.arrearage === "paid_in_full"; const part4 = e.part4_history_required ? i.history : null;
  return { response_due: responseDue(i.served_on, i.by_mail), filed_as: "supplement_to_proof_of_claim",
    part2: { prepetition_cured: e.arrearage === "paid_in_full", statement: e.arrearage === "paid_in_full" ? "paid in full" : "amount remaining", remaining_cents: i.arrearage_cents },
    part3: { statement: e.current ? "current" : "not current", first_unpaid_postpetition_due: e.first_unpaid_due, itemization: unpaid.map((u) => ({ due: u.due, amount_cents: u.cents })), unpaid_fees_cents: i.unpaid_noticed_fees_cents, last_payment_received_on: i.last_payment_received_on, next_due_date: i.next_due, next_due_cents: i.next_due_cents, upb_cents: i.upb_cents, deferred_interest_cents: i.deferred_interest_cents, escrow_balance_cents: i.escrow_balance_cents, unapplied_cents: i.unapplied_cents },
    part4_history: part4, agree, service: ["debtor", "debtor_attorney", "trustee"], checklist: { FORM410C13NR_SUPPLEMENT_TO_CLAIM: true, FORM410C13NR_PART4_REQUIRED_IF_DISAGREE: !e.part4_history_required || part4 !== null }, fnma_fee_cents: agree ? 12_500n : 62_500n, precludes_later_default_claim: agree };
}
/** Rule 7 / `FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45`: a "not current" response starts the debtor's 45-day motion window on service of the response; an agree/current response ends the bankruptcy accounting. */
export function g4MotionWindow(statement: "current" | "not current", responseServedOn: PlainDate | null): { starts: boolean; timer: "FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45"; anchor: "served_at"; starts_on: PlainDate | null; lapses_on: PlainDate | null; post_case_collectible: "itemized_amounts_only" | "none" } {
  const starts = statement === "not current";
  return { starts, timer: "FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45", anchor: "served_at", starts_on: starts ? responseServedOn : null, lapses_on: starts && responseServedOn ? rollForward9006(addDays(responseServedOn, 45)) : null, post_case_collectible: starts ? "itemized_amounts_only" : "none" };
}

// ============================================================ (b)(4) motion, (e) order
export interface FiledNotice { readonly id: string; readonly effective_due_date: PlainDate; readonly old_total_cents: Cents; readonly new_total_cents: Cents; readonly status: NoticeStatus; }
/** Rule (b)(4) / `FRBP_3002_1B4_OBJECTION_WINDOW`: a motion docketed before the due date holds the old amount; the change applies only per the court's order. */
export function b4MotionHold(n: FiledNotice, motion: { docketed_on: PlainDate }): { status: NoticeStatus; held: boolean; hold_amount_cents: Cents; bills_on_due_date_cents: Cents; applies_on: PlainDate | null; gate_facts: { b4_motion_docketed: boolean; b4_motion_docketed_on: PlainDate }; escalation: { kind: "attorney"; reason: string }; awaiting: "court_order" } {
  const before = motion.docketed_on < n.effective_due_date;
  if (!before) return { status: n.status, held: false, hold_amount_cents: n.new_total_cents, bills_on_due_date_cents: n.new_total_cents, applies_on: n.effective_due_date, gate_facts: { b4_motion_docketed: false, b4_motion_docketed_on: motion.docketed_on }, escalation: { kind: "attorney", reason: `motion docketed ${motion.docketed_on} on/after the due date ${n.effective_due_date}: the change took effect (Rule 3002.1(b)(4))` }, awaiting: "court_order" };
  return { status: "objected", held: true, hold_amount_cents: n.old_total_cents, bills_on_due_date_cents: n.old_total_cents, applies_on: null, gate_facts: { b4_motion_docketed: true, b4_motion_docketed_on: motion.docketed_on }, escalation: { kind: "attorney", reason: `Rule 3002.1(b)(4) motion docketed ${motion.docketed_on}: hold the ${n.effective_due_date} payment at the prior amount pending the court's order` }, awaiting: "court_order" };
}
/** The (b)(4)/(e) order's figures are applied on entry — never the agent's. */
export function applyCourtOrder(n: FiledNotice, order: { entered_on: PlainDate; determined_total_cents: Cents; effective_from: PlainDate }): { status: "determined"; amount_cents: Cents; applies_from: PlainDate; entered_on: PlainDate } {
  return { status: "determined", amount_cents: order.determined_total_cents, applies_from: order.effective_from, entered_on: order.entered_on };
}

// ============================================================ relief from stay (14.2-Q2)
/** `SM_BK_3002_1_RELIEF_CEASE_CHECK`: the rule ceases on stay relief "unless the court orders otherwise"; policy keeps filing while the case is open (14.2-Q2) unless counsel advises the district treats it as improper. */
export function reliefOrderDecision(i: { relief_order_entered_on: PlainDate; case_open: boolean; counsel_advises_improper: boolean; court_orders_continued_compliance?: boolean }): { continue_filing: boolean; in_scope: boolean; gate: "SM_BK_3002_1_RELIEF_CEASE_CHECK"; decision: DecisionRecord } {
  const cont = i.case_open && (i.court_orders_continued_compliance === true || !i.counsel_advises_improper);
  const scope = inScope({ chapter: "13", principal_residence: true, treatment: "cure_and_maintain", relief_order_effective: true, policy_continue_after_relief: cont });
  return { continue_filing: cont, in_scope: scope, gate: "SM_BK_3002_1_RELIEF_CEASE_CHECK",
    decision: { filing_type: "410S-1/410S-2", scope_test_result: cont ? "in_scope_policy_continue" : "ceased_on_relief", rule_code: "14.2-Q2", rule_set_version: RULE_SET_VERSION, outcome: cont ? "continue_filing" : "cease_filing",
      rationale: cont ? `relief order entered ${i.relief_order_entered_on}; case remains open → continue filing (b)/(c) notices per 14.2-Q2 (Rule 3002.1(a): requirements cease on stay relief "unless the court orders otherwise"; filing is harmless and avoids disputes if the relief order is later vacated)` : `relief order entered ${i.relief_order_entered_on}; ${i.case_open ? "counsel advises the district treats continued notices as improper" : "case closed"} → cease per 14.2-Q2 exception` } };
}

// ============================================================ outputs: Form 410S-1 checklist
export interface Form410s1Input { readonly notice_date: PlainDate; readonly effective_due_date: PlainDate; readonly pi_new_cents: Cents; readonly escrow_new_cents: Cents; readonly new_total_cents: Cents; readonly parts: readonly (1 | 2 | 4)[]; readonly escrow_old_cents?: Cents; readonly rate_old?: string; readonly rate_new?: string; readonly pi_old_cents?: Cents; readonly escrow_statement_document_id?: string | null; readonly rate_change_notice_document_id?: string | null; readonly account_last4: string; readonly signer_role: "creditor" | "authorized_agent" | null; }
/** Outputs: the 410S-1 checklist (`FRBP_3002_1B_DATE_GE_21`, Part 1/2 attachments, total tie-out, Rule 9037 redaction, signer role); any failure blocks the package. */
export function form410s1(i: Form410s1Input): { header: { date_of_payment_change: PlainDate; new_total_cents: Cents; account_last4: string }; part1: { current_escrow_cents: Cents; new_escrow_cents: Cents; escrow_statement_attached: boolean } | null; part2: { current_rate: string; new_rate: string; current_pi_cents: Cents; new_pi_cents: Cents; rate_change_notice_attached: boolean } | null; part4: { current_total_cents: Cents | null; new_total_cents: Cents } | null; checklist: Record<"FRBP_3002_1B_DATE_GE_21" | "FORM410S1_PART1_ESCROW_ATTACHED" | "FORM410S1_PART2_RATE_NOTICE_ATTACHED" | "FORM410S1_TOTAL_EQ_PI_PLUS_ESCROW" | "FRBP_9037_REDACTION" | "SIGNER_ROLE_PRESENT", boolean>; blocked: boolean; failed: string[] } {
  const p1 = i.parts.includes(1), p2 = i.parts.includes(2), p4 = i.parts.includes(4);
  const checklist = { FRBP_3002_1B_DATE_GE_21: daysBetween(i.notice_date, i.effective_due_date) >= 21, FORM410S1_PART1_ESCROW_ATTACHED: !p1 || Boolean(i.escrow_statement_document_id), FORM410S1_PART2_RATE_NOTICE_ATTACHED: !p2 || Boolean(i.rate_change_notice_document_id), FORM410S1_TOTAL_EQ_PI_PLUS_ESCROW: i.new_total_cents === i.pi_new_cents + i.escrow_new_cents, FRBP_9037_REDACTION: /^\d{4}$/.test(i.account_last4), SIGNER_ROLE_PRESENT: i.signer_role !== null };
  const failed = Object.entries(checklist).filter(([, ok]) => !ok).map(([k]) => k);
  return { header: { date_of_payment_change: i.effective_due_date, new_total_cents: i.new_total_cents, account_last4: i.account_last4 },
    part1: p1 ? { current_escrow_cents: i.escrow_old_cents ?? 0n, new_escrow_cents: i.escrow_new_cents, escrow_statement_attached: Boolean(i.escrow_statement_document_id) } : null,
    part2: p2 ? { current_rate: i.rate_old ?? "", new_rate: i.rate_new ?? "", current_pi_cents: i.pi_old_cents ?? 0n, new_pi_cents: i.pi_new_cents, rate_change_notice_attached: Boolean(i.rate_change_notice_document_id) } : null,
    part4: p4 ? { current_total_cents: i.pi_old_cents !== undefined && i.escrow_old_cents !== undefined ? i.pi_old_cents + i.escrow_old_cents : null, new_total_cents: i.new_total_cents } : null,
    checklist, blocked: failed.length > 0, failed };
}
