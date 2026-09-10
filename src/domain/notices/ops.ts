/**
 * §7 mechanics beyond statement/arm/esign/privacy/payoff-statement: TPP and
 * bankruptcy statement variants, cease requests, charge-off suspension, the
 * D2-2-03 reminder decision, checklist holds, bounce fallback, Form 1098
 * cycle, successor and transfer-out addressing (7.1); Fannie Mae-only ARM
 * notices, buydown steps, boarding-error re-amortization and correction,
 * FDCPA cease handling, index fallback, Chapter 13 payment-change timing,
 * channel selection and the second-engine verification (7.2); the initial
 * (d) notice holds, transferor evidence, envelope composition, state HFA
 * contacts and corrected notices (7.3); TCPA STOP, transfer-in flags and exam
 * records (7.4); portal acknowledgment, state lines, termination and copies
 * (7.5); clock start, oral requests, updated statements, successors and NoE
 * links (7.6). bigint cents; calendars as the spec names them.
 */
import { addDays, addMonths, daysBetween, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, federal, rollForward } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound, Decimal } from "../../kernel/money/decimal.ts";
import { amountDue, reminderPanel, form1098, chargeOffNoticeDue } from "./statement.ts";
import { newRate, newPayment, indexFreshForInitial, initialNoticeWindow, correction, type IndexObs, type RateInputs } from "./arm.ts";
import { bounce, type Consent } from "./esign.ts";
import { portalAcknowledgmentFallback } from "./privacy.ts";
import { federalDeadline, requesterAuthorization } from "./payoff-statement.ts";

// ---------------------------------------------------------------------------
// 7.1 periodic statement
// ---------------------------------------------------------------------------
/** Comment 41(d)(1)-2 / (d)(2)-2 (7.1 rule 6): the TPP payment is the amount due; the explanation carries both amounts; application is shown per contract. */
export function tppStatement(f: { tpp_payment_cents: Cents; contractual_payment_cents: Cents; past_due_cents: Cents; late_charges_cents: Cents; fees_cents: Cents; suspense_cents: Cents; regx_days: number }): { template: "NTC_REGZ_41_STMT_TPP"; amount_due_cents: Cents; explanation: { tpp_payment_cents: Cents; contractual_payment_cents: Cents }; application_basis: "contract"; delinquency_box: boolean } {
  const a = amountDue({ current_payment_cents: f.contractual_payment_cents, past_due_cents: f.past_due_cents, late_charges_cents: f.late_charges_cents, fees_cents: f.fees_cents, suspense_cents: f.suspense_cents, tpp_payment_cents: f.tpp_payment_cents });
  return { template: "NTC_REGZ_41_STMT_TPP", amount_due_cents: a.amount_due_cents, explanation: { tpp_payment_cents: f.tpp_payment_cents, contractual_payment_cents: f.contractual_payment_cents }, application_basis: "contract", delinquency_box: f.regx_days > 45 };
}
/** §1026.41(e)(5)(iv)(B) + (f) (7.1 rules 7–8): the first cycle after the petition may use the single-statement exemption; the next must be the chapter's modified statement. */
export function bankruptcyStatementPlan(f: { chapter: "7" | "11" | "12" | "13"; petition_on: PlainDate; docket_reference: string | null; cycles: readonly { due_date: PlainDate; statement_date: PlainDate }[]; post_petition_due_cents: Cents; prepetition_arrearage_cents: Cents }): { cycles: { due_date: PlainDate; treatment: "single_statement_exemption" | "bk_modified"; template: "NTC_REGZ_41_STMT_BK12_13" | "NTC_REGZ_41_STMT_BK7_11" | null; amount_due_cents: Cents | null; prepetition_arrearage_cents: Cents | null; late_fee_language: false; foreclosure_language: false; legend: string | null }[] } {
  if (!f.docket_reference) throw new RangeError("bk_* variants require an open bankruptcy case with a PACER/vendor docket reference (7.1 guardrail)");
  const template = f.chapter === "12" || f.chapter === "13" ? "NTC_REGZ_41_STMT_BK12_13" : "NTC_REGZ_41_STMT_BK7_11";
  let exemptionUsed = false;
  return { cycles: f.cycles.filter((c) => c.statement_date >= f.petition_on).map((c) => {
    if (!exemptionUsed) { exemptionUsed = true; return { due_date: c.due_date, treatment: "single_statement_exemption" as const, template: null, amount_due_cents: null, prepetition_arrearage_cents: null, late_fee_language: false as const, foreclosure_language: false as const, legend: null }; }
    return { due_date: c.due_date, treatment: "bk_modified" as const, template, amount_due_cents: template === "NTC_REGZ_41_STMT_BK12_13" ? f.post_petition_due_cents : f.post_petition_due_cents, prepetition_arrearage_cents: template === "NTC_REGZ_41_STMT_BK12_13" ? f.prepetition_arrearage_cents : null, late_fee_language: false as const, foreclosure_language: false as const, legend: "This statement is for informational purposes only" };
  }) };
}
/** §1026.41(e)(5)(i)(A) / comment 41(e)(5)-3 (7.1-T6): a written cease request is effective on receipt with the image as evidence; a later written request for statements resumes them the next cycle. */
export function ceaseRequest(f: { received_on: PlainDate; evidence_document_id: string | null; cycles: readonly { due_date: PlainDate; statement_date: PlainDate }[]; resume_request_on?: PlainDate | null }): { exemption: { event: "statement.cycle.exempt"; effective_on: PlainDate; evidence_document_id: string }; cycles: { due_date: PlainDate; send: boolean; reason: string }[] } {
  if (!f.evidence_document_id) throw new RangeError("a cycle cannot be marked exempt without a linked evidence document (7.1 guardrail)");
  const resume = f.resume_request_on ?? null;
  return { exemption: { event: "statement.cycle.exempt", effective_on: f.received_on, evidence_document_id: f.evidence_document_id }, cycles: f.cycles.map((c) => {
    if (c.statement_date <= f.received_on) return { due_date: c.due_date, send: true, reason: "before the cease request" };
    if (resume && c.statement_date > resume) return { due_date: c.due_date, send: true, reason: `resumed: written request for statements received ${resume}` };
    return { due_date: c.due_date, send: false, reason: "exempt: written cease request (§1026.41(e)(5)(i)(A))" };
  }) };
}
export const CHARGEOFF_TITLE = "Suspension of Statements & Notice of Charge Off — Retain This Copy for Your Records";
export const CHARGEOFF_ITEMS = ["the loan has been charged off and we will not charge any additional fees or interest", "we will no longer provide a periodic statement for each billing cycle", "the lien on the property remains in place and you remain liable for the loan and any obligations arising from or related to the property, which may include property taxes", "you may be required to pay the balance in the future, for example upon sale of the property", "the balance is not being canceled or forgiven", "the loan may be purchased, assigned, or transferred", "you may request a payoff statement at any time"] as const;
/** §1026.41(e)(6) (7.1-T7): the charge-off notice within 30 days with the exact title and seven items; any fee or interest charged later lapses the exemption, statements resume and the fee is reversed. */
export function chargeOffSuspension(f: { approved_on: PlainDate; fee_assessed_on?: PlainDate | null; fee_cents?: Cents }): { template: "NTC_REGZ_41E6_CHARGEOFF_SUSPENSION"; due_on: PlainDate; title: string; items: readonly string[]; exemption_lapsed: boolean; statements_resume: boolean; fee_reversed_cents: Cents } {
  const lapsed = !!f.fee_assessed_on;
  return { template: "NTC_REGZ_41E6_CHARGEOFF_SUSPENSION", due_on: chargeOffNoticeDue(f.approved_on), title: CHARGEOFF_TITLE, items: CHARGEOFF_ITEMS, exemption_lapsed: lapsed, statements_resume: lapsed, fee_reversed_cents: lapsed ? (f.fee_cents ?? 0n) : 0n };
}
/** D2-2-03 (7.1 rule 10 / T8): a statement dated ≥ the 17th with the month's payment unpaid carries the panel and satisfies the reminder timer; a held statement means a standalone reminder by the 20th. */
export function reminderDecision(f: { statement_date: PlainDate; month_payment_unpaid: boolean; forbearance_active: boolean; statement_held: boolean }): { panel: boolean; timer: "FNMA_D2_2_03_PAYMENT_REMINDER_20"; satisfied_by: "statement.sent{reminder_panel=true}" | "notice.sent{template=NTC_FNMA_D2_2_03_PAYMENT_REMINDER}" | null; standalone: { template: "NTC_FNMA_D2_2_03_PAYMENT_REMINDER"; by: PlainDate } | null } {
  const r = reminderPanel(f.statement_date, f.month_payment_unpaid, f.forbearance_active);
  if (!r.standalone_by) return { panel: false, timer: "FNMA_D2_2_03_PAYMENT_REMINDER_20", satisfied_by: null, standalone: null };
  if (r.panel && !f.statement_held) return { panel: true, timer: "FNMA_D2_2_03_PAYMENT_REMINDER_20", satisfied_by: "statement.sent{reminder_panel=true}", standalone: null };
  return { panel: r.panel && !f.statement_held, timer: "FNMA_D2_2_03_PAYMENT_REMINDER_20", satisfied_by: "notice.sent{template=NTC_FNMA_D2_2_03_PAYMENT_REMINDER}", standalone: { template: "NTC_FNMA_D2_2_03_PAYMENT_REMINDER", by: r.standalone_by } };
}
/** 7.1 guardrail / T11: any `block` failure holds the statement; it cannot be sent and an ops alert fires within 5 minutes. */
export function checklistHold(f: { failures: readonly { rule_id: string; severity: "block" | "warn" }[]; detected_at: string }): { held: boolean; can_send: boolean; blocking: string[]; ops_alert_by: string | null } {
  const blocking = f.failures.filter((x) => x.severity === "block").map((x) => x.rule_id);
  return { held: blocking.length > 0, can_send: blocking.length === 0, blocking, ops_alert_by: blocking.length ? new Date(Date.parse(f.detected_at) + 5 * 60_000).toISOString() : null };
}
/** 7.4 rule 8 / 7.1-T12: a hard bounce on the availability email → paper statement within 1 business day, consent `suspect`. */
export function availabilityEmailBounce(f: { consent: Consent; bounced_on: PlainDate; kind: "hard" | "soft" | "complaint" }): { mail_paper_by: PlainDate | null; consent_status: Consent["status"]; reverification_invite: boolean; timer: "SM_EMAIL_BOUNCE_SUSPECT_1BD" } {
  const b = bounce(f.consent, f.kind);
  return { mail_paper_by: b.mail_same_day ? addBusinessDays(f.bounced_on, 1, servicer) : null, consent_status: f.consent.status, reverification_invite: b.mail_same_day, timer: "SM_EMAIL_BOUNCE_SUSPECT_1BD" };
}
/** IRC §6050H / Pub. 1179 (7.1 rule 11 / T13): boxes 1–2, furnish by Jan 31, e-file by Mar 31, electronic copies accessible through Oct 15. */
export function form1098Cycle(f: { tax_year: number; interest_received_cents: Cents; points_cents?: Cents; gov_assistance_interest_cents?: Cents; upb_jan1_cents: Cents; electronic: boolean }): { box1_cents: Cents; box2_cents: Cents; furnish_by: PlainDate; furnish_by_business: PlainDate; efile_by: PlainDate; accessible_through: PlainDate | null; template: "NTC_IRS_1098" } {
  const b = form1098(f.interest_received_cents, f.points_cents ?? 0n, f.gov_assistance_interest_cents ?? 0n, f.upb_jan1_cents);
  const y = f.tax_year + 1; const furnish = `${y}-01-31` as PlainDate;
  return { box1_cents: b.box1_cents, box2_cents: b.box2_cents, furnish_by: furnish, furnish_by_business: rollForward(furnish, federal), efile_by: `${y}-03-31` as PlainDate, accessible_through: f.electronic ? (`${y}-10-15` as PlainDate) : null, template: "NTC_IRS_1098" };
}
/** §1026.41(g) / 7.1 rule 12 (T14): a confirmed successor is addressed only once the §1024.32(c)(1)(iv) acknowledgment is executed. */
export function statementRecipients(f: { borrower_of_record: string; successor: { name: string; confirmed: boolean; acknowledgment_executed: boolean; assumed: boolean } | null }): { recipients: string[]; successor_added_from: "next_cycle" | null } {
  if (!f.successor || !f.successor.confirmed || !f.successor.acknowledgment_executed) return { recipients: [f.borrower_of_record], successor_added_from: null };
  return { recipients: f.successor.assumed ? [f.successor.name] : [f.borrower_of_record, f.successor.name], successor_added_from: "next_cycle" };
}
/** 7.1 edge "Transfer-out" (T15): no statement for cycles with due dates after the transfer date; the last statement references the goodbye notice. */
export function transferOutStatements(f: { transfer_effective: PlainDate; cycles: readonly { due_date: PlainDate }[] }): { cycles: { due_date: PlainDate; generate: boolean; goodbye_reference: boolean }[] } {
  const kept = f.cycles.filter((c) => c.due_date < f.transfer_effective);
  const last = kept.length ? kept[kept.length - 1]!.due_date : null;
  return { cycles: f.cycles.map((c) => ({ due_date: c.due_date, generate: c.due_date < f.transfer_effective, goodbye_reference: c.due_date === last })) };
}

// ---------------------------------------------------------------------------
// 7.2 ARM adjustments
// ---------------------------------------------------------------------------
/** 7.2 rule 6 / C-2.1-02 (T8): rate-only or payment-only changes get the Fannie Mae notice ≥ 25 days before the change and no Reg Z (c) notice. */
export function armNoticeSelection(f: { rate_changed: boolean; payment_changed: boolean; change_date: PlainDate; courtesy_no_change_notice?: boolean }): { regz_c_notice: boolean; fnma_notice: "NTC_FNMA_C2_1_02_RATE_CHANGE" | null; send_by: PlainDate | null } {
  if (f.rate_changed && f.payment_changed) return { regz_c_notice: true, fnma_notice: null, send_by: null };
  if (f.rate_changed || f.payment_changed) return { regz_c_notice: false, fnma_notice: "NTC_FNMA_C2_1_02_RATE_CHANGE", send_by: addDays(f.change_date, -25) };
  return { regz_c_notice: false, fnma_notice: f.courtesy_no_change_notice ? "NTC_FNMA_C2_1_02_RATE_CHANGE" : null, send_by: f.courtesy_no_change_notice ? addDays(f.change_date, -25) : null };
}
/** C-2.1-02 temporary buydowns (T9): notice 90 days before the payment change. */
export function buydownStepNotice(stepOn: PlainDate): { template: "NTC_FNMA_C2_1_02_BUYDOWN_STEP_90"; send_by: PlainDate; timer: "FNMA_C2_1_02_BUYDOWN_STEP_NOTICE_90" } { return { template: "NTC_FNMA_C2_1_02_BUYDOWN_STEP_90", send_by: addDays(stepOn, -90), timer: "FNMA_C2_1_02_BUYDOWN_STEP_NOTICE_90" }; }
/** Amortize `months` scheduled payments at one note rate (interest half-up to cents each month); the F-1-01 "expected UPB". */
export function scheduledUpbAfter(upb: Cents, ratePct: string, paymentCents: Cents, months: number): Cents {
  let bal = upb; const r = Decimal.parse(ratePct).unscaled;
  for (let i = 0; i < months; i++) { const interest = divRound(bal * r, 1200n * Decimal.ONE.unscaled, "HALF_UP"); bal -= paymentCents - interest; }
  return bal;
}
/** C-2.2-01 / F-1-01 (7.2 rule 8, T10): re-amortize from the first erroneous change date at the correct rates with the actual payments; overcharge > $1.00 combined → cash refund; report only after the IRR discussion; everything within 60 days. */
export function marginErrorCorrection(f: { discovered_on: PlainDate; upb_at_first_change_cents: Cents; segments: readonly { correct_rate_pct: string; booked_rate_pct: string; months: number; payment_cents: Cents }[]; current: boolean; advances: boolean; irr_discussed_at: string | null }): { reamortized_upb_cents: Cents; actual_upb_cents: Cents; net_effect_cents: Cents; treatment: "cash_refund" | "credit_reallocation" | "absorbed"; correction_notice: "NTC_FNMA_C2_2_01_ARM_CORRECTION"; report_to_fnma: boolean; complete_by: PlainDate; timer: "FNMA_C2_2_01_CORRECT_60" } {
  let correct = f.upb_at_first_change_cents, actual = f.upb_at_first_change_cents;
  for (const s of f.segments) { correct = scheduledUpbAfter(correct, s.correct_rate_pct, s.payment_cents, s.months); actual = scheduledUpbAfter(actual, s.booked_rate_pct, s.payment_cents, s.months); }
  // Overcharge = the booked balance exceeds the re-amortized one (the borrower paid interest that was not owed); positive per 7.2 rule 8.
  const c = correction(actual, correct, f.current, f.advances);
  return { reamortized_upb_cents: correct, actual_upb_cents: actual, net_effect_cents: c.net_effect_cents, treatment: c.treatment, correction_notice: "NTC_FNMA_C2_2_01_ARM_CORRECTION", report_to_fnma: f.irr_discussed_at !== null, complete_by: addDays(f.discovered_on, 60), timer: "FNMA_C2_2_01_CORRECT_60" };
}
/** §1026.20(c)(1)(ii)(C) (T11): an FDCPA §805(c) cease notification exempts the (c) notice; Fannie Mae's informational notice still goes, marked required-by-contract. */
export function fdcpaCeaseArmNotice(f: { fdcpa_cease_on_file: boolean; debt_collector: boolean }): { regz_c_notice: boolean; fnma_notice: "NTC_FNMA_C2_1_02_RATE_CHANGE" | null; marked_as: "required_by_contract_information" | null; decision_cite: string | null } {
  if (f.fdcpa_cease_on_file && f.debt_collector) return { regz_c_notice: false, fnma_notice: "NTC_FNMA_C2_1_02_RATE_CHANGE", marked_as: "required_by_contract_information", decision_cite: "12 CFR 1026.20(c)(1)(ii)(C)" };
  return { regz_c_notice: true, fnma_notice: null, marked_as: null, decision_cite: null };
}
/** 7.2 edge "Index unavailable" (T12): two failed API days → capture-timer alert; the fallback source is used with dual-control evidence on the correct index date. */
export function indexCaptureFallback(f: { index_date: PlainDate; api_failures: readonly { on: PlainDate; status: number }[]; fallback: { source: string; value: string; effective_date: PlainDate; evidence_ids: readonly string[]; approvers: readonly string[] } | null }): { alert: boolean; source: "api" | "fallback" | null; index_date: PlainDate; index_value: string | null; dual_control: boolean; qc_flag: boolean } {
  const failedDays = new Set(f.api_failures.filter((x) => x.status >= 500).map((x) => x.on)).size;
  const alert = failedDays >= 2;
  if (!alert) return { alert: false, source: "api", index_date: f.index_date, index_value: null, dual_control: false, qc_flag: false };
  const dual = !!f.fallback && f.fallback.approvers.length >= 2 && f.fallback.evidence_ids.length > 0 && f.fallback.effective_date <= f.index_date;
  return { alert: true, source: dual ? "fallback" : null, index_date: f.index_date, index_value: dual ? f.fallback!.value : null, dual_control: dual, qc_flag: true };
}
/** Rule 3002.1(b) + 14.2 (T13): the payment-change event reaches 14.2 at least 60 days before the new payment; the notice is filed ≥ 21 days before. */
export function ch13PaymentChange(f: { first_new_payment_due: PlainDate; verified_on: PlainDate }): { emit: "payment.change.scheduled"; emit_by: PlainDate; emitted_on: PlainDate; on_time: boolean; rule_3002_1_file_by: PlainDate } {
  const by = addDays(f.first_new_payment_due, -60);
  return { emit: "payment.change.scheduled", emit_by: by, emitted_on: f.verified_on, on_time: f.verified_on <= by, rule_3002_1_file_by: addDays(f.first_new_payment_due, -21) };
}
/** §1026.17(a)(1) + 7.4 (T14): electronic only with `arm_notices` consent; otherwise mail; SMS-only never. */
export function armNoticeChannel(f: { consent: Consent | null }): { channel: "electronic" | "mail"; sms_only_allowed: false } {
  return { channel: f.consent?.status === "active" && f.consent.classes.includes("arm_notices") ? "electronic" : "mail", sms_only_allowed: false };
}
export interface ArmAdjustmentInput extends RateInputs { readonly expected_upb_cents: Cents; readonly remaining_term_months: number; readonly interest_only?: boolean; }
export interface ArmAdjustmentResult { readonly new_rate_pct: string; readonly unrounded_pct: string; readonly bound: "none" | "initial" | "periodic" | "lifetime" | "floor"; readonly new_pi_cents: Cents; readonly engine: "A" | "B"; }
/** Engine A: the decimal engine in arm.ts (7.2 tool `computeArmAdjustment`). */
export function computeArmAdjustment(i: ArmAdjustmentInput): ArmAdjustmentResult {
  const r = newRate(i);
  return { new_rate_pct: r.new_rate_pct, unrounded_pct: r.unrounded_pct, bound: r.bound, new_pi_cents: newPayment(i.expected_upb_cents, r.new_rate_pct, i.remaining_term_months, i.interest_only ?? false), engine: "A" };
}
/** Engine B (7.2 tool `verifyArmAdjustment`): an independent floating-point path; both engines must agree to the cent before a notice renders. */
export function verifyArmAdjustment(i: ArmAdjustmentInput, a?: ArmAdjustmentResult): ArmAdjustmentResult & { agrees: boolean | null; discrepancy: string | null } {
  const unrounded = Number(i.index_pct) + Number(i.margin_pct);
  const q = unrounded / 0.125; const fl = Math.floor(q + 1e-9); const frac = q - fl;
  let rate = (frac > 0.5 + 1e-9 || (Math.abs(frac - 0.5) < 1e-9 && i.rounding === "half_up") ? fl + 1 : fl) * 0.125;
  const prior = Number(i.prior_rate_pct); const cap = Number(i.first_change ? i.initial_cap_pct : i.periodic_cap_pct);
  let bound: ArmAdjustmentResult["bound"] = "none";
  if (rate > prior + cap + 1e-9) { rate = prior + cap; bound = i.first_change ? "initial" : "periodic"; } else if (rate < prior - cap - 1e-9) { rate = prior - cap; bound = i.first_change ? "initial" : "periodic"; }
  const life = Number(i.initial_note_rate_pct) + Number(i.lifetime_cap_pct); if (rate > life + 1e-9) { rate = life; bound = "lifetime"; }
  const floor = Number(i.margin_pct); if (rate < floor - 1e-9) { rate = floor; bound = "floor"; }
  const upb = Number(i.expected_upb_cents) / 100; const rm = rate / 1200;
  const pmt = i.interest_only ? upb * rm : rm === 0 ? upb / i.remaining_term_months : (upb * rm) / (1 - Math.pow(1 + rm, -i.remaining_term_months));
  const pi = BigInt(Math.round(pmt * 100 + 1e-7));
  const res: ArmAdjustmentResult = { new_rate_pct: rate.toFixed(3), unrounded_pct: unrounded.toFixed(5), bound, new_pi_cents: pi, engine: "B" };
  if (!a) return { ...res, agrees: null, discrepancy: null };
  const diffs = [a.new_rate_pct !== res.new_rate_pct ? `rate ${a.new_rate_pct} vs ${res.new_rate_pct}` : null, a.new_pi_cents !== res.new_pi_cents ? `payment ${a.new_pi_cents} vs ${res.new_pi_cents}` : null].filter((x): x is string => x !== null);
  return { ...res, agrees: diffs.length === 0, discrepancy: diffs.length ? diffs.join("; ") : null };
}

// ---------------------------------------------------------------------------
// 7.3 ARM initial (d) notice
// ---------------------------------------------------------------------------
/** 7.3 rule 3 / T3: the estimate needs an index published within 15 servicer business days of the disclosure date; otherwise rendering holds. */
export function initialNoticeIndexHold(f: { latest: IndexObs; disclosure_date: PlainDate }): { hold: boolean; reason: string | null; business_days_old: number } {
  let n = 0; let d = f.latest.effective_date; while (d < f.disclosure_date) { d = addDays(d, 1); if (servicer.isBusinessDay(d)) n++; }
  const fresh = indexFreshForInitial(f.latest, f.disclosure_date);
  return { hold: !fresh, reason: fresh ? null : `latest index publication is ${n} business days old (> 15); hold until a fresh value is captured`, business_days_old: n };
}
/** 7.3 edge "Boarded after T−210" (T4/T5): transferor evidence in the file → `transferor_evidenced`; none → send within 5 business days and record the transferor breach. */
export function transferInInitialNotice(f: { boarded_on: PlainDate; first_new_payment_due: PlainDate; consummation: PlainDate; term_months: number; transferor_evidence: { document_id: string; dated: PlainDate } | null }): { status: "transferor_evidenced" | "send_now" | "servicer_window"; send_by: PlainDate | null; duplicate: false; breach_record: { attributable_to: "transferor"; window_deadline: PlainDate } | null; evidence_document_id: string | null } {
  const w = initialNoticeWindow(f.first_new_payment_due, f.consummation, f.term_months);
  if (f.transferor_evidence) return { status: "transferor_evidenced", send_by: null, duplicate: false, breach_record: null, evidence_document_id: f.transferor_evidence.document_id };
  if (f.boarded_on > w.deadline) return { status: "send_now", send_by: addBusinessDays(f.boarded_on, 5, servicer), duplicate: false, breach_record: { attributable_to: "transferor", window_deadline: w.deadline }, evidence_document_id: null };
  return { status: "servicer_window", send_by: w.deadline, duplicate: false, breach_record: null, evidence_document_id: null };
}
/** 7.3 rule 5 (T7): the (d) notice is its own PDF with its own first page; it may share the envelope with the statement. */
export function composeEnvelope(docs: readonly { template: string; separate_document: boolean; pages: number }[]): { documents: { template: string; own_pdf: boolean; first_page: number }[]; envelope_count: 1; composer_log: string } {
  let page = 1; const out = docs.map((d) => { const entry = { template: d.template, own_pdf: true, first_page: page }; page += d.pages; return entry; });
  return { documents: out, envelope_count: 1, composer_log: `${docs.length} documents in one envelope: ${docs.map((d) => d.template).join(" + ")}` };
}
/** §1026.20(d)(2)(xi) (T8): the state housing finance authority comes from `jurisdiction_rules` by property state. */
export function stateHfaContact(state: string, rules: Record<string, { hfa_name: string; hfa_phone: string }>): { hfa_name: string; hfa_phone: string } { const r = rules[state]; if (!r) throw new RangeError(`no state HFA contact for ${state} in jurisdiction_rules`); return r; }
/** 7.3 rule 6 (T9): a term correction after sending → corrected (d) notice within 7 days when still ≥ 210 days out; otherwise rely on the (c) notice and document the discrepancy. */
export function correctedInitialNotice(f: { sent_on: PlainDate; corrected_on: PlainDate; first_new_payment_due: PlainDate }): { action: "send_corrected_d_notice" | "rely_on_c_notice"; send_by: PlainDate | null; days_out: number } {
  const daysOut = daysBetween(f.corrected_on, f.first_new_payment_due);
  return daysOut >= 210 ? { action: "send_corrected_d_notice", send_by: addDays(f.corrected_on, 7), days_out: daysOut } : { action: "rely_on_c_notice", send_by: null, days_out: daysOut };
}

// ---------------------------------------------------------------------------
// 7.4 E-SIGN / TCPA
// ---------------------------------------------------------------------------
/** 7.4 rule 12 / T7: a STOP reply suppresses the number immediately; the revocation reaches every list within 1 business day (policy) and never later than 10. */
export function tcpaStop(f: { number: string; reply: string; received_on: PlainDate }): { revocation: boolean; suppressed_immediately: boolean; apply_to_all_lists_by: PlainDate; outside_bound: PlainDate; recognized_from: "keyword" | "free_text" | null } {
  const kw = /^\s*(stop|unsubscribe|cancel|end|quit)\s*$/i.test(f.reply); const free = !kw && /\b(stop|don't|do not|no more|remove)\b.*\b(text|call|message|contact)/i.test(f.reply);
  const rev = kw || free;
  return { revocation: rev, suppressed_immediately: rev, apply_to_all_lists_by: addBusinessDays(f.received_on, 1, servicer), outside_bound: addBusinessDays(f.received_on, 10, servicer), recognized_from: kw ? "keyword" : free ? "free_text" : null };
}
/** 7.4 rule 5 / T8: a transfer-in `estatement_flag=Y` without evidence is not consent — the loan boards with mail delivery and an invitation rides with the hello notice. */
export function transferInEstatementFlag(f: { estatement_flag: "Y" | "N"; evidence: { checkbox_text: string; demonstration_proof_id: string } | null }): { delivery: "mail" | "electronic"; consent_status: Consent["status"] | null; invitation_with_hello: boolean } {
  if (f.estatement_flag !== "Y") return { delivery: "mail", consent_status: null, invitation_with_hello: true };
  return f.evidence ? { delivery: "mail", consent_status: "evidence_only", invitation_with_hello: true } : { delivery: "mail", consent_status: null, invitation_with_hello: true };
}
export interface ConsentEvidence { readonly disclosure_version: string; readonly disclosure_hash: string; readonly consented_at: string; readonly verification_link_opened_at: string | null; readonly token_entered_at: string | null; readonly ip: string; readonly user_agent: string; readonly token_ok: boolean; }
/** 15 U.S.C. §7001(d) (T11): the consent record reproduces the disclosure version and hash, timestamps, IP/user-agent and the demonstration proof. */
export function consentExamRecord(c: Consent, e: ConsentEvidence): { reproducible: boolean; fields: { party_id: string; classes: readonly string[]; status: Consent["status"]; disclosure_version: string; disclosure_hash: string; consented_at: string; verification: { link_opened_at: string | null; token_entered_at: string | null; token_ok: boolean }; ip: string; user_agent: string }; missing: string[] } {
  const missing: string[] = [];
  if (!e.disclosure_hash) missing.push("disclosure_hash"); if (!e.ip) missing.push("ip"); if (!e.user_agent) missing.push("user_agent");
  if (c.status === "active" && (!e.verification_link_opened_at || !e.token_entered_at || !e.token_ok)) missing.push("verification_proof");
  return { reproducible: missing.length === 0, fields: { party_id: c.party_id, classes: c.classes, status: c.status, disclosure_version: e.disclosure_version, disclosure_hash: e.disclosure_hash, consented_at: e.consented_at, verification: { link_opened_at: e.verification_link_opened_at, token_entered_at: e.token_entered_at, token_ok: e.token_ok }, ip: e.ip, user_agent: e.user_agent }, missing };
}

// ---------------------------------------------------------------------------
// 7.5 privacy
// ---------------------------------------------------------------------------
/** §1016.9(b)(1)(iii) (T6): an e-consented initial notice is posted with a required acknowledgment; no acknowledgment within 30 days → paper copy. */
export function privacyPortalPosting(f: { posted_on: PlainDate; acknowledged_at: string | null; today: PlainDate }): { acknowledgment_required: true; acknowledged_at: string | null; paper_fallback_on: PlainDate; mail_paper: boolean } {
  const fb = portalAcknowledgmentFallback(f.posted_on);
  return { acknowledgment_required: true, acknowledged_at: f.acknowledged_at, paper_fallback_on: fb, mail_paper: f.acknowledged_at === null && f.today >= fb };
}
/** 7.5 rule 7 + state overlays (T7): CalFIPA line only when the sharing profile requires it; the CCPA is never cited (§1798.145(e)). */
export function otherImportantInformation(f: { state: string; sharing_profile: "exceptions_only" | "broader" }): { lines: string[]; cites_ccpa: false } {
  const lines: string[] = [];
  if (f.state === "CA" && f.sharing_profile === "broader") lines.push("California residents: under the California Financial Information Privacy Act we will not share your personal financial information with nonaffiliated companies without your consent, except as permitted by law.");
  if (f.state === "VT" && f.sharing_profile === "broader") lines.push("Vermont residents: we will not share information with nonaffiliated companies unless you authorize us to do so.");
  return { lines, cites_ccpa: false };
}
/** §1016.5(b) (T8): no annual notice after the relationship ends; the party's privacy status is `terminated`. */
export function annualNoticeAfterTermination(f: { terminated_on: PlainDate; notice_year: number }): { annual_notice: boolean; party_status: "terminated" } { return { annual_notice: Number(f.terminated_on.slice(0, 4)) > f.notice_year, party_status: "terminated" }; }
/** 7.5 escalations / T9: a copy requested by any channel goes within 5 business days by the borrower's consented channel. */
export function privacyCopyOnRequest(f: { requested_on: PlainDate; consent: Consent | null }): { send_by: PlainDate; channel: "electronic" | "mail"; kind: "on_request" } {
  return { send_by: addBusinessDays(f.requested_on, 5, servicer), channel: f.consent?.status === "active" && f.consent.classes.includes("privacy_notices") ? "electronic" : "mail", kind: "on_request" };
}

// ---------------------------------------------------------------------------
// 7.6 payoff statement
// ---------------------------------------------------------------------------
/** 7.6 rule 1 (T2): mail requests start on the scanning vendor's receipt date, not the postmark; electronic requests on the local business date of receipt. */
export function payoffClockStart(f: { channel: "email" | "fax" | "portal" | "mail"; received_on: PlainDate; postmark_on?: PlainDate | null; vendor_receipt_on?: PlainDate | null }): { clock_start: PlainDate; basis: string; federal_due: PlainDate } {
  const start = f.channel === "mail" ? (f.vendor_receipt_on ?? f.received_on) : f.received_on;
  return { clock_start: start, basis: f.channel === "mail" ? "scanning vendor receipt date (postmark ignored)" : "electronic receipt converted to the local business date", federal_due: federalDeadline(start) };
}
/** 7.6 (T5): an oral request gets a 16.1 quote and no §1026.36(c)(3) timer; the one-click written request starts the clock at the click time. */
export function oralPayoffRequest(f: { channel: "ai_voice" | "chat" | "phone"; clicked_written_at: string | null }): { quote: "16.1_engine"; timer_started: boolean; timer_started_at: string | null; written_offer: "one_click_written_request" } {
  return { quote: "16.1_engine", timer_started: f.clicked_written_at !== null, timer_started_at: f.clicked_written_at, written_offer: "one_click_written_request" };
}
/** 7.6 rule 5 (T9): a change affecting the figure before the good-through date issues an updated statement the same day; the original is superseded and retained. */
export function updatedPayoffStatement(f: { original: { id: string; good_through: PlainDate; total_cents: Cents }; change: { kind: string; posted_on: PlainDate; delta_cents: Cents } }): { updated: boolean; updated_on: PlainDate | null; template: "NTC_PAYOFF_UPDATED_STMT" | null; original_status: "superseded" | "current"; new_total_cents: Cents; retained_original: true } {
  if (f.change.posted_on > f.original.good_through) return { updated: false, updated_on: null, template: null, original_status: "current", new_total_cents: f.original.total_cents, retained_original: true };
  return { updated: true, updated_on: f.change.posted_on, template: "NTC_PAYOFF_UPDATED_STMT", original_status: "superseded", new_total_cents: f.original.total_cents + f.change.delta_cents, retained_original: true };
}
/** §1026.2(a)(11) (T10): a confirmed successor's request is a consumer request; the statement goes to the successor. */
export function successorPayoffRequest(f: { confirmed: boolean }): { classification: ReturnType<typeof requesterAuthorization>; deliver_to: "successor" | "borrower_of_record"; authorization_needed: boolean } {
  const c = requesterAuthorization(f.confirmed ? "confirmed_successor" : "unknown", false);
  return { classification: c, deliver_to: c === "consumer_request" ? "successor" : "borrower_of_record", authorization_needed: c !== "consumer_request" };
}
/** §1024.35(b)(6) (T11): a NoE alleging an inaccurate payoff links the 4.1 case to the request row and the statement hash under investigation. */
export function noePayoffLink(f: { noe_case_id: string; payoff_request_id: string; statement_hash: string }): { case_id: string; links: { payoff_request_id: string; statement_hash: string }; error_type: "1024.35(b)(6)"; freeze_updates: false } {
  return { case_id: f.noe_case_id, links: { payoff_request_id: f.payoff_request_id, statement_hash: f.statement_hash }, error_type: "1024.35(b)(6)", freeze_updates: false };
}
export const monthsAfter = (d: PlainDate, n: number): PlainDate => addMonths(d, n);
