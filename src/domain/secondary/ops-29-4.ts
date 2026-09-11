/**
 * §29.4 Loan Delivery submission, custodian certification, purchase, purchase advice reconciliation and post-delivery
 * corrections/remedies — the `secondary` agent's pure rules over the `deliveries` status columns and the tables this
 * process owns (migration 0106: delivery_operator_tasks, custodian_certifications, wire_instructions, purchase_advices,
 * post_purchase_adjustments; `deliveries` shared with 29.3). One small function per rule / T-id plus a thin
 * `DeliveryService` over the event store. Loan Delivery is a web UI with no API: every status here is set from
 * evidence (`status_source`), never from an intent to act; the only human steps are `fnma_portal_operator` tasks
 * (`human_portal_task` escalations), SM's warehouse-org wire approvals and partner `officer` sign-offs.
 *
 * Reused, never re-implemented: 29.1's `fannieSifma` calendar (business_days_fannie_et) and `loanAgeDueOn`
 * (B2-1.5-02), 30.1's `purchaseMonthInterestDeduction` (C2-1.1-06), 5.6's `processRepurchase` (LAR 65/67 on the
 * removal clock), 23.4's gates through `evaluateGate`, 22.6's `assertNoFraudHold`, 27.1's `ERegistryPort` and the
 * `bailee_letters.letter_name` letterhead text.
 *
 * Events (every one carries `loanId` + `applicationId` and `payload.source = "origination"`, so the 29.4 rows arm under
 * origination context — src/kernel/timers/engine.ts isOriginationContext):
 *   delivery.operator_task.opened{kind, sla_due_at}                           [arms nothing; SM_LOAN_DELIVERY_OPERATOR_SLA_1BD arms on 29.3's `delivery.package.frozen`]
 *   delivery.operator_task.blocked{reason} · delivery.operator_task.completed{task_id}
 *   delivery.extension.requested{expected_receipt_on, receipt_deadline_on}    (29.1 requestExtension is the next act)
 *   delivery.submitted{fnma_loan_number, submitted_at, submit_before_2100_et, resubmit}   [satisfies SM_LOAN_DELIVERY_OPERATOR_SLA_1BD / SM_LD_PURCHASE_ERROR_RESUBMIT_1BD{resubmit=true}; arms the ship / 07:30 / release gate rows]
 *   delivery.status.observed{loan_delivery_status, certification_status, source}         [purchase_ready satisfies FNMA_B2_1_5_02_LOAN_AGE_6M_PURCHASE_READY]
 *   delivery.edit.observed{fatal, prefix, owner_process}  (shared with 29.3)  · delivery.commitment_edit.notified{process=29.1}
 *   delivery.purchase_error.observed · delivery.data_revision.received · delivery.data_revision.responded{accepted} · delivery.certification.cancelled · delivery.withdrawn{reason}
 *   custody.package.shipped{first_morning_service} · custody.package.received{by_0730_et, expected_certification_date} · custody.certified{certification_kind, certified_on}
 *   custody.loan_number.requested · custody.loan_number.responded · custody.loan_number.recorded
 *   wire.instruction.listed · wire.instruction.approved{payee_code, bailee_letter_name} · form_482.submitted · payee_code.activated
 *   payee.security_breach.detected · fnma.breach.notified{telephone=true} · fnma.breach.confirmed{written=true}
 *   enote.edelivered · enote.transfer_of_control.requested{effective_date} · enote.transfer_of_control.completed
 *   purchase_advice.received{advice_date, net_proceeds_cents} · purchase_advice.reconciled{variance_cents} · loan.purchased{purchase_date, acquisition_date} (once per loan)
 *   ppa.opened · ppa.requested{channel=lsdu, llpa_relevant} · ppa.resolved (27.2's spellings, emitted here as the platform record until 27.2 lands)
 *   lqc.data_validation.requested · lqc.data_validation.responded · rep_warrant_relief.confirmed{component} · rep_warrant_relief.lost{component}
 *   remedy.collateral_return.requested{kind} · remedy.readvance.refused
 * Consumed: delivery.package.frozen / delivery.package.superseded (29.3), lock.commitment.linked{expires_on} (21.4), commitment.closed_status.set (29.1),
 * loan.funded{first_payment_date, lpi_due_date} (26.3/30.2), payment.posted (2.x), warehouse.bailee_letter.released / warehouse.secured_party.released (27.1/27.2),
 * rep_warrant_relief.evaluated (23.3), valuation.review.completed{doc_file_id} (24.2), ucd.accepted{is_final} (25.2), fraud hold (22.6).
 */
import { randomUUID } from "node:crypto";
import { type PlainDate, addDays, addMonths, addYears, daysBetween, endOfMonth, plainDate } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, businessDaysBetween, creditor, rollBack } from "../../kernel/calendar/business.ts";
import { toIso, wallClock, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { type Cents, centsToDecimal } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import type { Actor, Clock, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { EscalationService } from "../../app/escalations.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { fannieSifma, loanAgeDueOn } from "./ops-29-1.ts";
import { purchaseMonthInterestDeduction } from "../orig-boarding/ops-30-1.ts";
import { processRepurchase } from "../investor/ops-5-6.ts";
import { assertNoFraudHold } from "../verification/ops-22-6.ts";
import { SUPERMORTGAGE_ORG_ID } from "../transfers/inbound.ts";
import type { ERegistryPort } from "../warehouse/ops-27-1.ts";

export const SECONDARY_AGENT_29_4: Actor = { kind: "agent", id: "secondary" };
export const ET = "America/New_York";
/** The creditor's clock (Phoenix — MST all year; the spec writes MT/MST). */
export const MT = "America/Phoenix";
export const RULE_SET_VERSIONS_29_4 = { selling: "fnma.selling.2026-09-02", uldd: "fnma.uldd.5.2.0", mers: "mers.proc.26.1", rdc: "fnma.rdc.15.0", ld_user_guide: "fnma.ld.user_guide.2026-05" } as const;
export const MODEL_VERSION_29_4 = "secondary.delivery.v1";
export const PROMPT_VERSION_29_4 = "29.4.submit.v1";
/** Open question 8: operator tasks due 15:00 MT (carrier pickup 16:30 MT; data cutoff 9:00 p.m. ET). */
export const OPERATOR_TASK_DUE_HHMM_MT = "15:00";
export const CARRIER_PICKUP_HHMM_MT = "16:30";
/** C2-2-04: clean data "by 9:00 p.m. (Eastern time)"; User Guide p. 64: custodian receipt by 7:30 a.m. ET; Job Aids v4.0: custodian cash SLA 4:00 p.m. EST. */
export const DATA_CUTOFF_HHMM_ET = "21:00";
export const FIRST_MORNING_HHMM_ET = "07:30";
export const CUSTODIAN_CUTOFF_HHMM_ET = "16:00";
/** C2-2-03: delivery "up to 45 days from the due date of the reported last paid installment". */
export const LPI_WINDOW_DAYS = 45;
/** C1-2-02: repricing of LLPAs only for corrections "within 18 months of the loan's acquisition date"; PPA FAQ Q9: $100 minimum. */
export const PPA_LLPA_LOOKBACK_MONTHS = 18;
export const PPA_LLPA_MINIMUM_CENTS: Cents = 10_000n;
export const PPA_PROCESSING_BD = 10;
/** C2-2-05: adjustment request "within 30 days of the date of the Purchase Advice" (27.2's clock); the officer package is prepared within 5 Fannie Mae business days. */
export const PPA_REQUEST_DAYS = 30;
export const ADJUSTMENT_PACKAGE_BD = 5;
/** R3 tie-out tolerance; AI design: any variance > $1,000 goes to the `officer`. */
export const RECONCILE_TOLERANCE_CENTS: Cents = 100n;
export const OFFICER_VARIANCE_CENTS: Cents = 100_000n;
/** A2-3.2-01: demands are paid "within 60 days after receipt of the demand". */
export const REMEDY_PAYMENT_DAYS = 60;
/** The four mandatory evidence items of the `import_and_submit` task (AI design: task design (3)). */
export const REQUIRED_EVIDENCE = ["import_result_screenshot", "edit_history_csv", "loan_record_print", "wire_details_screenshot"] as const;
export const SM_WAREHOUSE_ORG_ID = SUPERMORTGAGE_ORG_ID;

export type LoanDeliveryStatus = "not_started" | "draft" | "purchase_requested" | "purchase_error" | "purchase_ready" | "purchased_and_funded" | "cancelled_to_draft" | "withdrawn";
export type CertificationStatus = "none" | "awaiting_certification" | "certified" | "qualified_cert" | "auto_certified";
export type StatusSource = "operator_capture" | "custodian_notice" | "connect_report" | "purchase_advice_api" | "evault_event";
export type TaskKind = "import_and_submit" | "resolve_edits" | "assign_wire" | "data_revision_response" | "cancel_certification" | "warehouse_wire_approval" | "form_482_request" | "form_2004a_execution" | "ldte_validation" | "lqc_data_validation" | "connect_purchase_advice_download" | "purchase_expected_check";
export type TaskOrg = "partner_seller_org" | "sm_warehouse_org";
export type TaskOutcome = "completed" | "blocked" | "cancelled";
export type BlockReason = "unexpected_edit" | "commitment_missing" | "commitment_edit" | "wire_pending" | "ui_outage" | "hash_mismatch";
export type CustodyMode = "shipped_package" | "pre_positioned_at_fcc" | "evault_auto";
export type CertificationKind = "certified" | "qualified_cert" | "auto_certified_enote" | "manual_evault_review";
export type NoteForm = "paper" | "enote";
export type RemittanceType = "actual_actual" | "scheduled_scheduled" | "scheduled_actual";
export type ReliefComponent = "limited_waiver_du" | "income_validated" | "employment_validated" | "assets_validated" | "undisclosed_debt" | "income_calculator" | "value_acceptance" | "cu_score_2_5" | "payment_history_36";
export type ReliefStatus = "eligible" | "at_risk" | "lost" | "confirmed_by_fnma" | "not_applicable";
export type PpaStatus = "open" | "submitted" | "processed" | "closed" | "declined";

export class DeliveryRefused extends Error {
  readonly code: string; readonly citation: string;
  constructor(code: string, citation: string, why: string) { super(`${code}: ${why}`); this.name = "DeliveryRefused"; this.code = code; this.citation = citation; }
}
const need = (cond: boolean, what: string): void => { if (!cond) throw new RangeError(what); };
const nonEmpty = (v: unknown, what: string): string => { need(typeof v === "string" && v.trim() !== "", `${what} is required`); return v as string; };
const HUNDRED = Decimal.fromInt(100);
export const etWall = (iso: string): { date: PlainDate; hour: number; minute: number } => wallClock(Date.parse(iso), ET);
export const etDate = (iso: string): PlainDate => etWall(iso).date;
export const etInstant = (d: PlainDate, hhmm: string): string => toIso(zonedEpochMs(d, hhmm, ET));
export const mtInstant = (d: PlainDate, hhmm: string): string => toIso(zonedEpochMs(d, hhmm, MT));
const minutes = (w: { hour: number; minute: number }): number => w.hour * 60 + w.minute;
const hhmmMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;

// ============================================================ R2 / worked example A: the operator task and the timeline
/** SM_LOAN_DELIVERY_OPERATOR_SLA_1BD: +1 `business_days_creditor` after the freeze, due 15:00 MT (Fri Nov 13 10:05 MST → Mon Nov 16 15:00 MT). */
export function operatorTaskDue(frozenAtIso: string, cal: Calendar = creditor): { frozen_on: PlainDate; due_on: PlainDate; sla_due_at: string } {
  const frozen_on = wallClock(Date.parse(frozenAtIso), MT).date;
  const due_on = addBusinessDays(frozen_on, 1, cal);
  return { frozen_on, due_on, sla_due_at: mtInstant(due_on, OPERATOR_TASK_DUE_HHMM_MT) };
}
/** C2-2-04: data submitted before 9:00 p.m. ET counts that day; later (or on a non-business day) it counts on the next Fannie Mae business day. */
export function submitBefore2100Et(submittedAtIso: string): boolean { return minutes(etWall(submittedAtIso)) < hhmmMinutes(DATA_CUTOFF_HHMM_ET); }
export function dataDay(submittedAtIso: string, cal: Calendar = fannieSifma): PlainDate {
  const w = etWall(submittedAtIso);
  return submitBefore2100Et(submittedAtIso) && cal.isBusinessDay(w.date) ? w.date : addBusinessDays(w.date, 1, cal);
}
export interface ExpectedDates { readonly data_day: PlainDate; readonly submit_before_2100_et: boolean; readonly expected_receipt_on: PlainDate; readonly expected_receipt_at: string; readonly expected_certification_date: PlainDate; readonly expected_purchase_date: PlainDate; }
/** R2: receipt = next `business_days_fannie_et` after the data day at 07:30 ET; certification that day (custodian SLA 4:00 p.m. EST); purchase +1 BD (User Guide p. 64; C2-2-04). */
export function expectedDates(submittedAtIso: string, cal: Calendar = fannieSifma): ExpectedDates {
  const data_day = dataDay(submittedAtIso, cal);
  const expected_receipt_on = addBusinessDays(data_day, 1, cal);
  return { data_day, submit_before_2100_et: submitBefore2100Et(submittedAtIso), expected_receipt_on, expected_receipt_at: etInstant(expected_receipt_on, FIRST_MORNING_HHMM_ET), expected_certification_date: expected_receipt_on, expected_purchase_date: addBusinessDays(expected_receipt_on, 1, cal) };
}
export interface ReceiptRecompute { readonly received_on: PlainDate; readonly received_by_0730_et: boolean; readonly received_by_custodian_cutoff: boolean; readonly expected_certification_date: PlainDate; readonly expected_purchase_date: PlainDate; }
/** FNMA_LD_UG_CUSTODIAN_0730_ET_EXPECTATION / FNMA_C2_2_04_CERTIFICATION_EXPECTED_1BD: actual receipt re-plans — same business day if by the custodian's 4:00 p.m. cutoff, else the next; purchase +1 BD (Tue Nov 17 17:05 ET → cert Wed Nov 18 → purchase Thu Nov 19). */
export function recomputeOnReceipt(receivedAtIso: string, cal: Calendar = fannieSifma): ReceiptRecompute {
  const w = etWall(receivedAtIso); const m = minutes(w);
  const received_by_0730_et = m <= hhmmMinutes(FIRST_MORNING_HHMM_ET) && cal.isBusinessDay(w.date);
  const received_by_custodian_cutoff = m <= hhmmMinutes(CUSTODIAN_CUTOFF_HHMM_ET) && cal.isBusinessDay(w.date);
  const expected_certification_date = received_by_custodian_cutoff ? w.date : addBusinessDays(w.date, 1, cal);
  return { received_on: w.date, received_by_0730_et, received_by_custodian_cutoff, expected_certification_date, expected_purchase_date: addBusinessDays(expected_certification_date, 1, cal) };
}
/** FNMA_C2_2_04_PURCHASE_EXPECTED_1BD: certification date + 1 `business_days_fannie_et` (Wed Nov 18 → Thu Nov 19; eNote auto-cert Thu Nov 19 → Fri Nov 20). */
export function recomputeOnCertification(certifiedAtIso: string, cal: Calendar = fannieSifma): { certified_on: PlainDate; purchase_ready_at: PlainDate; expected_purchase_date: PlainDate } {
  const certified_on = etDate(certifiedAtIso);
  return { certified_on, purchase_ready_at: certified_on, expected_purchase_date: addBusinessDays(certified_on, 1, cal) };
}

// ============================================================ R1: LPI, the 45-day window, loan age and seasoning
/** R1: the LPI of a newly disbursed loan with no payment posted is `first_payment_date − 1 month`; after a posting it is the paid installment's due date. */
export const lpiDueDate = (firstPaymentDate: PlainDate, lastPaidInstallmentDue: PlainDate | null = null): PlainDate => lastPaidInstallmentDue ?? addMonths(firstPaymentDate, -1);
/** FNMA_C2_2_DELIVERY_LPI_45: `lpi_due_date + 45 calendar_days` (Dec 1, 2026 → Fri Jan 15, 2027; Jan 1, 2027 → Mon Feb 15, 2027). */
export const deliveryLpiDue = (lpi: PlainDate): PlainDate => addDays(lpi, LPI_WINDOW_DAYS);
export interface LpiWindow { readonly lpi_due_date: PlainDate; readonly delivery_lpi_due: PlainDate; readonly loan_age_due_on: PlainDate; readonly seasoned_on: PlainDate; }
/** The three delivery bounds of R1 (the loan-age due date is 29.1's `loanAgeDueOn` — B2-1.5-02's example; seasoned = the first-payment anniversary). */
export function lpiWindow(firstPaymentDate: PlainDate, lastPaidInstallmentDue: PlainDate | null = null): LpiWindow {
  const lpi = lpiDueDate(firstPaymentDate, lastPaidInstallmentDue);
  return { lpi_due_date: lpi, delivery_lpi_due: deliveryLpiDue(lpi), loan_age_due_on: loanAgeDueOn(firstPaymentDate), seasoned_on: seasonedOn(firstPaymentDate) };
}
export const seasonedOn = (firstPaymentDate: PlainDate): PlainDate => addYears(firstPaymentDate, 1);
/** B2-1.5-02: "no more than six months old measured from the first payment date to the 'Purchase Ready' date" — Jul 1, 2027 breaches a Jan 1, 2027 first payment (due Wed Jun 30). */
export function loanAgeCheck(firstPaymentDate: PlainDate, purchaseReadyAt: PlainDate): { due_on: PlainDate; breached: boolean; days_before_due: number } {
  const due_on = loanAgeDueOn(firstPaymentDate);
  return { due_on, breached: purchaseReadyAt > due_on, days_before_due: daysBetween(purchaseReadyAt, due_on) };
}
/** Seasoned (> 1 year from first payment to purchase): B2-1.5-02 conditions must be evidenced before any later delivery. */
export function seasonedCheck(firstPaymentDate: PlainDate, purchaseDate: PlainDate | null, today: PlainDate): { seasoned_on: PlainDate; seasoned: boolean } {
  const s = seasonedOn(firstPaymentDate);
  return { seasoned_on: s, seasoned: purchaseDate ? purchaseDate >= s : today >= s };
}

// ============================================================ C2-2-01: custodian receipt before commitment expiry
export interface ReceiptDeadline { readonly expires_on: PlainDate; readonly anchor_on: PlainDate; readonly due_on: PlainDate; readonly due_at: string; readonly rolled_backward: boolean; }
/** FNMA_C2_2_01_CUSTODIAN_RECEIPT_BEFORE_EXPIRY: anchored "the day prior to the expiration date" (Sun Dec 6), due at first-morning delivery on the prior Fannie Mae business day when that day cannot receive (Fri Dec 4 07:30 ET). */
export function custodianReceiptDeadline(expiresOn: PlainDate, cal: Calendar = fannieSifma): ReceiptDeadline {
  const anchor_on = addDays(expiresOn, -1);
  const due_on = rollBack(anchor_on, cal);
  return { expires_on: expiresOn, anchor_on, due_on, due_at: etInstant(due_on, FIRST_MORNING_HHMM_ET), rolled_backward: due_on !== anchor_on };
}
export interface ReceiptPlan { readonly task_due_on: PlainDate; readonly sla_due_at: string; readonly expected_submit_on: PlainDate; readonly expected_receipt_on: PlainDate; readonly deadline: ReceiptDeadline; readonly slack_business_days: number; readonly extension_required: boolean; }
/** R2 commitment guard / edge case: the operator task is scheduled so that `expected_receipt ≤ receipt_deadline`; otherwise the agent requests a 29.1 extension before opening the task (freeze Wed Nov 18, expiry Fri Nov 20 → receipt Fri Nov 20 > due Thu Nov 19). */
export function receiptPlan(frozenAtIso: string, expiresOn: PlainDate, cal: Calendar = fannieSifma): ReceiptPlan {
  const task = operatorTaskDue(frozenAtIso);
  const expected_receipt_on = addBusinessDays(task.due_on, 1, cal);
  const deadline = custodianReceiptDeadline(expiresOn, cal);
  return { task_due_on: task.due_on, sla_due_at: task.sla_due_at, expected_submit_on: task.due_on, expected_receipt_on, deadline, slack_business_days: businessDaysBetween(expected_receipt_on, deadline.due_on, cal), extension_required: expected_receipt_on > deadline.due_on };
}

// ============================================================ operator task design: the instruction sheet and the evidence gate
export interface WireInstruction {
  readonly wire_instruction_id: string; readonly partner_id: string; readonly payee_code: string; readonly receiver_type: "seller" | "warehouse_lender" | "disbursement_agent"; readonly warehouse_lender_org_id: string | null;
  readonly letter_type: "bailee" | "form_2004a" | "none"; readonly bailee_letter_name: string | null; readonly status: "pending" | "active" | "inactive"; readonly form_482_document_id: string | null; readonly form_482_signed_by: string | null;
  readonly fnma_confirmation_call_at: string | null; readonly approved_by_warehouse_at: string | null; readonly approved_by_operator_id: string | null;
}
export interface InstructionSheet {
  readonly package_id: string; readonly file_name: string; readonly sha256: string; readonly commitment_number: string; readonly loan_count: 1; readonly expected_edits: readonly string[]; readonly pre_justified_warnings: readonly string[];
  readonly payee_code: string; readonly receiver_type_label: "Warehouse Lender" | "Seller" | "Disbursement Agent"; readonly letter_type_label: "Bailee" | "2004A" | "None"; readonly bailee_letter_name: string | null; readonly enote_indicator: boolean;
  readonly evidence_required: readonly string[]; readonly attestation: string; readonly steps: readonly { step: string; expected: string }[];
}
const RECEIVER_LABEL = { seller: "Seller", warehouse_lender: "Warehouse Lender", disbursement_agent: "Disbursement Agent" } as const;
const LETTER_LABEL = { bailee: "Bailee", form_2004a: "2004A", none: "None" } as const;
/** `renderInstructionSheet`: the one-page sheet with commitment number, payee code, Receiver Type / Letter Type, Bailee Letter Name, eNote indicator, expected edits and the exact evidence list. */
export function renderInstructionSheet(i: { package_id: string; file_name: string; sha256: string; commitment_id_fnma: string; wire: WireInstruction; enote_indicator: boolean; pre_justified_warnings?: readonly string[] }): InstructionSheet {
  nonEmpty(i.commitment_id_fnma, "commitment_id_fnma"); nonEmpty(i.sha256, "sha256");
  const warnings = i.pre_justified_warnings ?? [];
  const sheet: Omit<InstructionSheet, "steps"> = { package_id: i.package_id, file_name: i.file_name, sha256: i.sha256, commitment_number: i.commitment_id_fnma, loan_count: 1, expected_edits: warnings.length ? warnings : ["none"], pre_justified_warnings: warnings, payee_code: i.wire.payee_code,
    receiver_type_label: RECEIVER_LABEL[i.wire.receiver_type], letter_type_label: LETTER_LABEL[i.wire.letter_type], bailee_letter_name: i.wire.bailee_letter_name, enote_indicator: i.enote_indicator, evidence_required: [...REQUIRED_EVIDENCE], attestation: `file imported = ${i.file_name} (SHA-256 ${i.sha256})` };
  return { ...sheet, steps: [{ step: "Home → Import → Whole Loan Delivery → Commitment Number", expected: sheet.commitment_number }, { step: "Import File", expected: `${i.file_name}; loan count = 1; edits = ${sheet.expected_edits.join(", ")}` }, { step: "Wire Details → Payee Code", expected: sheet.payee_code },
    { step: "Wire Details → Receiver Type", expected: sheet.receiver_type_label }, { step: "Wire Details → Letter Type", expected: sheet.letter_type_label }, { step: "Wire Details → Bailee Letter Name", expected: sheet.bailee_letter_name ?? "n/a" }, { step: "eNote Indicator", expected: String(sheet.enote_indicator) }, { step: "Submit", expected: "Fannie Mae loan number captured; status Purchase Requested / Awaiting Certification" }] };
}
export interface OperatorEvidence { readonly evidence: readonly { kind: string; document_id: string }[]; readonly hash_confirmed: boolean; readonly captured_state: Record<string, unknown>; }
/** The task "cannot be marked complete without the four evidence items and `hash_confirmed = true`" (T1); the captured commitment number must equal `commitments.commitment_id_fnma` (state-machine guard). */
export function evidenceGate(ev: OperatorEvidence, expected: { commitment_id_fnma: string; sha256: string }): { complete: boolean; missing: string[]; reasons: string[] } {
  const kinds = new Set(ev.evidence.map((e) => e.kind));
  const missing = REQUIRED_EVIDENCE.filter((k) => !kinds.has(k));
  const reasons: string[] = missing.map((k) => `evidence ${k} missing`);
  if (!ev.hash_confirmed) reasons.push("hash_confirmed must be true (file imported = file named on the sheet)");
  const cap = ev.captured_state;
  if (typeof cap.commitment_number === "string" && cap.commitment_number !== expected.commitment_id_fnma) reasons.push(`captured commitment number ${cap.commitment_number} ≠ ${expected.commitment_id_fnma}`);
  if (typeof cap.file_sha256 === "string" && cap.file_sha256 !== expected.sha256) reasons.push("captured file hash ≠ package sha256");
  return { complete: reasons.length === 0, missing, reasons };
}
export interface CapturedEdit { readonly edit_code: string; readonly severity: "fatal" | "warning"; readonly message?: string; }
/** Loan Delivery edit prefixes (FAQ Q9): "A" UCDP, "C" UCD, "D" DU, 3000-series commitment/contract (numeric — 29.1's), else general. */
export function editPrefix(code: string): "A" | "C" | "D" | "numeric" | "general" {
  const c = code.trim().toUpperCase();
  if (/^A/.test(c)) return "A"; if (/^C/.test(c)) return "C"; if (/^D/.test(c)) return "D"; if (/^3\d{3}/.test(c)) return "numeric"; return "general";
}
/** Edge cases: a fatal 3000-series edit blocks the task (`commitment_edit`, 29.1 acts, no 29.3 rebuild); other fatals go to 29.3; an unlisted warning blocks (`unexpected_edit`). */
export function classifyImportEdits(edits: readonly CapturedEdit[], preJustifiedWarnings: readonly string[]): { block: BlockReason | null; observed: { edit_code: string; fatal: boolean; prefix: ReturnType<typeof editPrefix>; owner_process: string; rebuild_required: boolean }[] } {
  const observed = edits.map((e) => { const prefix = editPrefix(e.edit_code); const fatal = e.severity === "fatal"; const owner_process = prefix === "numeric" ? "29.1" : prefix === "A" ? "24.2" : prefix === "C" ? "25.2" : prefix === "D" ? "23.1" : "29.3"; return { edit_code: e.edit_code, fatal, prefix, owner_process, rebuild_required: fatal && prefix !== "numeric" }; });
  const fatalNumeric = observed.find((o) => o.fatal && o.prefix === "numeric");
  if (fatalNumeric) return { block: "commitment_edit", observed };
  if (observed.some((o) => o.fatal)) return { block: "unexpected_edit", observed };
  const unlisted = edits.filter((e) => e.severity === "warning" && !preJustifiedWarnings.includes(e.edit_code));
  return { block: unlisted.length ? "unexpected_edit" : null, observed };
}

// ============================================================ R4: custodian data revisions
export interface DataRevision { readonly field: string; readonly custodian_value: string; readonly seller_value: string; readonly editable_by_custodian: boolean; }
export type RevisionCase = "accept_qualified_cert" | "decline_note_reference" | "non_editable_operator_correction";
/** R4 (a)–(c): note = custodian ≠ ULDD → accept (Qualified Cert) + `delivery.edit.observed` + 25.2/26.1 review; note = ULDD ≠ custodian → decline with the note page; non-editable → operator/Cancel Certification. */
export function dataRevisionDecision(r: DataRevision, note: { value: string; page_ref: string }): { case: RevisionCase; response: "accepted" | "declined" | null; note_page_ref: string; edit_observed: boolean; review_processes: readonly string[]; rationale: string } {
  if (!r.editable_by_custodian) return { case: "non_editable_operator_correction", response: null, note_page_ref: note.page_ref, edit_observed: true, review_processes: ["29.3"], rationale: `${r.field} is not custodian-editable — the operator corrects it in Loan Delivery (or Cancel Certification → Draft → re-import)` };
  if (note.value === r.custodian_value && note.value !== r.seller_value) return { case: "accept_qualified_cert", response: "accepted", note_page_ref: note.page_ref, edit_observed: true, review_processes: ["29.3", "25.2", "26.1"], rationale: `note ${note.page_ref} reads ${note.value} = custodian value; ULDD ${r.seller_value} was wrong → accept (Qualified Cert); 29.3 corrects the source, 25.2/26.1 review CD/note consistency` };
  return { case: "decline_note_reference", response: "declined", note_page_ref: note.page_ref, edit_observed: false, review_processes: [], rationale: `note ${note.page_ref} reads ${note.value} = ULDD ${r.seller_value}; the custodian value ${r.custodian_value} does not match the signed note → decline` };
}
/** SM_LD_DATA_REVISION_RESPONSE_1BD: +1 `business_days_creditor` from receipt. */
export const dataRevisionResponseDue = (receivedAtIso: string, cal: Calendar = creditor): PlainDate => addBusinessDays(etDate(receivedAtIso), 1, cal);

// ============================================================ R5: bailee letter name (byte comparison) and Form 2004A
/** T7 / Warehouse Lender User Guide p. 5: "The name entered in Loan Delivery must exactly match the Bailee letterhead text" — a byte comparison, no normalization. */
export function baileeNameCheck(entered: string, letterheadText: string): { matches: boolean; entered_bytes: number; letterhead_bytes: number; reason: string | null } {
  const a = Buffer.from(entered, "utf8"), b = Buffer.from(letterheadText, "utf8");
  const matches = a.equals(b);
  return { matches, entered_bytes: a.length, letterhead_bytes: b.length, reason: matches ? null : `bailee_letter_name ${JSON.stringify(entered)} ≠ letterhead ${JSON.stringify(letterheadText)} (byte comparison)` };
}
/** State-machine guard: the payee code must be `active` (or `pending` with the SM warehouse-approval task opened in parallel and completed before submit); never submit on an inactive/unknown code (Form 482 path, 3 BD). */
export function wireGate(w: WireInstruction | null, warehouseTaskOpen: boolean): { open: boolean; reason: string | null; needs_form_482: boolean } {
  if (!w || w.status === "inactive") return { open: false, reason: "payee code inactive/unknown at submit — Form 482 path (three business days); no submission", needs_form_482: true };
  if (w.status === "active") return { open: true, reason: null, needs_form_482: false };
  return warehouseTaskOpen ? { open: true, reason: "pending: SM warehouse-approval task opened in parallel; must complete before submit", needs_form_482: false } : { open: false, reason: "wire instruction pending without the SM warehouse-approval task", needs_form_482: false };
}
export const payeeCodeChangeDue = (submittedOn: PlainDate, cal: Calendar = fannieSifma): PlainDate => addBusinessDays(submittedOn, 3, cal);

// ============================================================ B8-8 / C1-2-04: eNote transfer gate
export interface EnoteTransferFacts { readonly edelivered?: unknown; readonly effective_date?: unknown; readonly request_date?: unknown; readonly master_servicer_org_id?: unknown; readonly sm_org_id?: unknown; readonly accepted?: unknown; }
/** FNMA_C1_2_04_ENOTE_TRANSFER_SAME_DAY_GATE: eDelivery completed; Transfer of Control and Location with `effective_date = request_date` ("must include an 'Effective Date' of the same day as the request"); Master Servicer = SM Org ID (open question 7). */
export function enoteTransferGate(f: EnoteTransferFacts): { open: boolean; reason?: string } {
  if (f.edelivered !== true) return { open: false, reason: "eNote not yet eDelivered to Fannie Mae's eVault (C1-2-04)" };
  const eff = String(f.effective_date ?? ""), req = String(f.request_date ?? "").slice(0, 10);
  if (!eff || eff !== req) return { open: false, reason: `Transfer of Control and Location effective_date ${eff || "missing"} ≠ request date ${req || "missing"} (C1-2-04: same day as the request)` };
  const ms = f.master_servicer_org_id === undefined ? SM_WAREHOUSE_ORG_ID : String(f.master_servicer_org_id);
  if (ms !== String(f.sm_org_id ?? SM_WAREHOUSE_ORG_ID)) return { open: false, reason: `Master Servicer field ${ms} ≠ SM Org ID (29.4-Q7 / 30.1-Q4)` };
  if (f.accepted === false) return { open: false, reason: "eRegistry rejected the transfer request — re-request with a new same-day effective date" };
  return { open: true };
}

// ============================================================ C2-2-03: warehouse release by acquisition
export interface ReleaseFacts { readonly release_effective_on?: unknown; readonly purchase_date?: unknown; readonly proceeds_received?: unknown; }
/** FNMA_C2_2_03_WAREHOUSE_RELEASE_BY_ACQUISITION_GATE: SM's release (bailee terms / Form 2004A / eNote Secured Party release) effective no later than `purchase_date`; never released before proceeds are confirmed received (guardrail). */
export function warehouseReleaseGate(f: ReleaseFacts): { open: boolean; reason?: string } {
  const rel = String(f.release_effective_on ?? ""), pd = String(f.purchase_date ?? "");
  if (!pd) return { open: false, reason: "no purchase_date yet" };
  if (!rel) return { open: false, reason: "SM's warehouse interest not yet released (warehouse.bailee_letter.released / warehouse.secured_party.released)" };
  if (rel > pd) return { open: false, reason: `release effective ${rel} is after the acquisition date ${pd} (C2-2-03: released no later than the date Fannie Mae acquires the note)` };
  if (f.proceeds_received === false) return { open: false, reason: "release recorded before proceeds were confirmed received (guardrail)" };
  return { open: true };
}

// ============================================================ R3: purchase advice reconciliation (formula owned by 27.2; 29.4 checks the tie-out)
export interface PurchaseAdviceInput {
  readonly purchase_advice_id?: string; readonly fnma_loan_number: string; readonly advice_date: PlainDate; readonly purchase_date: PlainDate; readonly commitment_id_fnma: string; readonly payee_code: string; readonly remittance_type: RemittanceType;
  readonly pass_through_rate: string; readonly servicing_fee_rate: string; readonly price: string; readonly upb_cents: Cents; readonly principal_proceeds_cents: Cents; readonly interest_adjustment_cents: Cents; readonly llpa_total_cents: Cents;
  readonly llpa_lines: readonly { code: string; pct: string; cents: Cents }[]; readonly fees: readonly { kind: string; cents: Cents }[]; readonly net_proceeds_cents: Cents; readonly wire_reference: string | null; readonly source: "api" | "connect_report"; readonly raw_payload_document_id: string | null; readonly received_at: string;
}
/** `principal_proceeds = round(upb × price ÷ 100)` — 56,000,000 × 1.01125 = 56,630,000 cents. */
export function principalProceedsCents(upbCents: Cents, price: string): Cents { return centsToDecimal(upbCents).mul(Decimal.parse(price)).div(HUNDRED).toCents("HALF_UP"); }
export interface InterestAdjustment { readonly days: number; readonly prepaid: boolean; readonly cents_30_360: Cents; readonly cents_act_365: Cents; }
/** C2-1.1-06 (A/A): interest "from the last paid installment date … up to, but not including, the purchase date"; a new origination (LPI after the purchase date) has prepaid interest and Fannie Mae *deducts* it (Nov 19–30 = 12 days: −$1,096.67 at 30/360, −$1,081.64 at act/365 — 30.1's calculator). S/S and S/A: from the first of the purchase month. */
export function interestAdjustment(upbCents: Cents, ptrPct: string, purchaseDate: PlainDate, lpiDate: PlainDate, remittance: RemittanceType = "actual_actual"): InterestAdjustment {
  if (remittance === "actual_actual") {
    if (lpiDate >= purchaseDate) { const d = purchaseMonthInterestDeduction(upbCents, ptrPct, purchaseDate, lpiDate); return { days: d.days, prepaid: true, cents_30_360: -d.cents_360, cents_act_365: -d.cents_365 }; }
    const d = purchaseMonthInterestDeduction(upbCents, ptrPct, lpiDate, purchaseDate); return { days: d.days, prepaid: false, cents_30_360: d.cents_360, cents_act_365: d.cents_365 };
  }
  const first = plainDate(`${purchaseDate.slice(0, 8)}01`);
  const d = purchaseMonthInterestDeduction(upbCents, ptrPct, first, purchaseDate); return { days: d.days, prepaid: false, cents_30_360: d.cents_360, cents_act_365: d.cents_365 };
}
export interface ExpectedProceeds { readonly principal_proceeds_cents: Cents; readonly interest: InterestAdjustment; readonly llpa_total_cents: Cents; readonly fees_cents: Cents; readonly expected_net_low_cents: Cents; readonly expected_net_high_cents: Cents; readonly expected_net_cents: Cents; }
/** `net_proceeds = principal + interest_adjustment − llpa_total − fees`, stored as a range while the day count is unresolved (open question 3): 30/360 → $564,503.33, act/365 → $564,518.36. */
export function expectedProceeds(i: { upb_cents: Cents; price: string; pass_through_rate: string; purchase_date: PlainDate; lpi_due_date: PlainDate; remittance_type?: RemittanceType; llpa_total_cents: Cents; fees_cents?: Cents }): ExpectedProceeds {
  const principal = principalProceedsCents(i.upb_cents, i.price);
  const interest = interestAdjustment(i.upb_cents, i.pass_through_rate, i.purchase_date, i.lpi_due_date, i.remittance_type ?? "actual_actual");
  const fees = i.fees_cents ?? 0n;
  const a = principal + interest.cents_30_360 - i.llpa_total_cents - fees, b = principal + interest.cents_act_365 - i.llpa_total_cents - fees;
  return { principal_proceeds_cents: principal, interest, llpa_total_cents: i.llpa_total_cents, fees_cents: fees, expected_net_low_cents: a < b ? a : b, expected_net_high_cents: a < b ? b : a, expected_net_cents: a };
}
export interface VarianceComponent { readonly component: "price" | "interest_days" | "llpa_line" | "fee" | "unexplained"; readonly cents: Cents; readonly detail: string; }
export interface Reconciliation { readonly reconciled: boolean; readonly variance_cents: Cents; readonly day_count: "30_360" | "act_365" | "in_range" | null; readonly decomposition: readonly VarianceComponent[]; readonly officer_package: boolean; readonly fnma_error_indicated: boolean; readonly package_due_on: PlainDate; readonly adjustment_request_due_on: PlainDate; readonly adjustment_request_due_at_on: PlainDate; }
/** R3 tie-out: |variance| ≤ $1.00 against the expected range → auto-reconciled (`variance_cents = 0`); otherwise decompose by component (an LLPA-shaped delta is a multiple of 0.125% of UPB) and prepare the adjustment-request package for the `officer` within 5 Fannie Mae business days (advice Nov 19 → Fri Nov 27), inside 27.2's 30-day clock (Sat Dec 19 → due-at Fri Dec 18). */
export function reconcileProceeds(advice: Pick<PurchaseAdviceInput, "net_proceeds_cents" | "advice_date" | "upb_cents" | "price" | "llpa_lines" | "fees" | "interest_adjustment_cents" | "principal_proceeds_cents">, expected: ExpectedProceeds, cal: Calendar = fannieSifma): Reconciliation {
  const net = advice.net_proceeds_cents;
  const inRange = net >= expected.expected_net_low_cents - RECONCILE_TOLERANCE_CENTS && net <= expected.expected_net_high_cents + RECONCILE_TOLERANCE_CENTS;
  const day_count = inRange ? (net === expected.expected_net_low_cents ? "30_360" : net === expected.expected_net_high_cents ? "act_365" : "in_range") : null;
  const adj = addDays(advice.advice_date, PPA_REQUEST_DAYS);
  const base = { package_due_on: addBusinessDays(advice.advice_date, ADJUSTMENT_PACKAGE_BD, cal), adjustment_request_due_on: adj, adjustment_request_due_at_on: rollBack(adj, cal) };
  if (inRange) return { reconciled: true, variance_cents: 0n, day_count, decomposition: [], officer_package: false, fnma_error_indicated: false, ...base };
  const variance = net - expected.expected_net_cents;
  const decomposition: VarianceComponent[] = [];
  let unexplained = variance;
  const priceDelta = advice.principal_proceeds_cents - expected.principal_proceeds_cents;
  if (priceDelta !== 0n) { decomposition.push({ component: "price", cents: priceDelta, detail: `principal proceeds ${advice.principal_proceeds_cents} vs expected ${expected.principal_proceeds_cents} at price ${advice.price}` }); unexplained -= priceDelta; }
  const intDelta = advice.interest_adjustment_cents - expected.interest.cents_30_360;
  if (intDelta !== 0n && (advice.interest_adjustment_cents === expected.interest.cents_act_365)) { decomposition.push({ component: "interest_days", cents: intDelta, detail: "interest on an actual/365 basis" }); unexplained -= intDelta; }
  else if (intDelta !== 0n) { decomposition.push({ component: "interest_days", cents: intDelta, detail: `interest adjustment ${advice.interest_adjustment_cents} vs expected ${expected.interest.cents_30_360} (${expected.interest.days} days)` }); unexplained -= intDelta; }
  const llpaAdvice = advice.llpa_lines.reduce((s, l) => s + l.cents, 0n); const llpaDelta = -(llpaAdvice - expected.llpa_total_cents);
  if (llpaDelta !== 0n) { const pct = centsToDecimal(-llpaDelta).mul(HUNDRED).div(centsToDecimal(advice.upb_cents)).toFixed(3, "HALF_UP"); decomposition.push({ component: "llpa_line", cents: llpaDelta, detail: `unexpected LLPA line ${pct}% of UPB (${advice.llpa_lines.map((l) => `${l.code} ${l.pct}%`).join(", ") || "unlabelled"})` }); unexplained -= llpaDelta; }
  const feeDelta = -(advice.fees.reduce((s, f) => s + f.cents, 0n) - expected.fees_cents);
  if (feeDelta !== 0n) { decomposition.push({ component: "fee", cents: feeDelta, detail: advice.fees.map((f) => `${f.kind} ${f.cents}`).join(", ") }); unexplained -= feeDelta; }
  if (unexplained !== 0n) decomposition.push({ component: "unexplained", cents: unexplained, detail: "residual after price / interest / LLPA / fee decomposition" });
  const abs = variance < 0n ? -variance : variance;
  return { reconciled: false, variance_cents: variance, day_count: null, decomposition, officer_package: abs > OFFICER_VARIANCE_CENTS || decomposition.some((d) => d.component === "llpa_line" || d.component === "unexplained"), fnma_error_indicated: decomposition.some((d) => d.component === "llpa_line" || d.component === "unexplained" || d.component === "price"), ...base };
}
/** Worked example A: one day of SM warehouse interest on the $548,800.00 advance (98% of $560,000) at 27.1's all-in 6.80% act/360 = $103.66 — SM's cost of the slip, never the partner's or borrower's. */
export function warehouseSlipCostCents(advanceCents: Cents, allInRateBps: number, days: number): Cents { return divRound(advanceCents * BigInt(allInRateBps) * BigInt(days), 10_000n * 360n, "HALF_UP"); }
export const advanceCents = (upbCents: Cents, advanceRatePct: number): Cents => divRound(upbCents * BigInt(Math.round(advanceRatePct * 100)), 10_000n, "HALF_UP");
/** Purchase Advice Sellers API: idempotency by `(fnma_loan_number, advice_date)`. */
export const adviceIdempotencyKey = (a: Pick<PurchaseAdviceInput, "fnma_loan_number" | "advice_date">): string => `${a.fnma_loan_number}|${a.advice_date}`;
/** T14: the API returned nothing for two consecutive business days after `purchase_ready` → Connect report task; the PURCHASE_EXPECTED breach check list. */
export function adviceLagCheck(purchaseReadyOn: PlainDate, today: PlainDate, adviceReceived: boolean, cal: Calendar = fannieSifma): { business_days_without_advice: number; connect_report_task: boolean; checks: readonly string[] } {
  const bd = adviceReceived ? 0 : businessDaysBetween(purchaseReadyOn, today, cal);
  return { business_days_without_advice: bd, connect_report_task: !adviceReceived && bd >= 2, checks: ["payee_code_active", "no_purchase_error", "commitment_valid"] };
}

// ============================================================ R7: rep & warrant relief bookkeeping at submission
export interface ReliefFacts { readonly du_recommendation?: string | null; readonly sfc_codes?: readonly string[]; readonly sid_322_casefile_id?: string | null; readonly data_hash_matches?: boolean; readonly du_income_validated?: boolean; readonly du_employment_validated?: boolean; readonly du_assets_validated?: boolean; readonly close_by_date?: PlainDate | null; readonly consummation_date?: PlainDate | null; readonly unresolved_verification_messages?: number; readonly undisclosed_debt_message_on_final?: boolean; readonly qualifying_income_cents?: Cents | null; readonly calculator_income_cents?: Cents | null; readonly collateral_program?: string | null; readonly cu_score?: string | null; readonly units?: number; readonly purchase_date?: PlainDate | null; readonly first_payment_date?: PlainDate | null; }
export interface ReliefEvaluation { readonly component: ReliefComponent; readonly delivered_with_conditions_met: boolean; readonly status: ReliefStatus; readonly basis_ref: string; readonly reasons: readonly string[]; readonly target_date: PlainDate | null; }
/** R7: per component the conditions checked on `delivery.submitted`; `status` stays `eligible` until Fannie Mae's report (`confirmed_by_fnma`) or a QC finding (`lost`). */
export function evaluateRelief(components: readonly ReliefComponent[], f: ReliefFacts): ReliefEvaluation[] {
  const sfcs = f.sfc_codes ?? []; const closedInTime = !!f.consummation_date && (!f.close_by_date || f.consummation_date <= f.close_by_date); const noMsgs = (f.unresolved_verification_messages ?? 0) === 0;
  const one = (component: ReliefComponent, basis_ref: string, checks: readonly [boolean, string][], target_date: PlainDate | null = null): ReliefEvaluation => { const reasons = checks.filter(([ok]) => !ok).map(([, r]) => r); return { component, delivered_with_conditions_met: reasons.length === 0, status: reasons.length ? "at_risk" : "eligible", basis_ref, reasons, target_date }; };
  return components.map((c) => {
    switch (c) {
      case "limited_waiver_du": return one(c, "A2-2-04", [[f.du_recommendation === "approve_eligible", "final DU Approve/Eligible"], [sfcs.includes("127"), "SFC 127 delivered"], [!!f.sid_322_casefile_id, "SID 322 (DU casefile id) delivered"], [f.data_hash_matches !== false, "delivered data hash matches the final findings"]]);
      case "income_validated": return one(c, "A2-2-04 (DU validation service)", [[f.du_income_validated === true, "DU message: income validated"], [closedInTime, "closed on/before the Close by Date"], [noMsgs, "no unresolved verification messages"]]);
      case "employment_validated": return one(c, "A2-2-04 (DU validation service)", [[f.du_employment_validated === true, "DU message: employment validated"], [closedInTime, "closed on/before the Close by Date"], [noMsgs, "no unresolved verification messages"]]);
      case "assets_validated": return one(c, "A2-2-04 (DU validation service)", [[f.du_assets_validated === true, "DU message: assets validated"], [closedInTime, "closed on/before the Close by Date"], [noMsgs, "no unresolved verification messages"]]);
      case "undisclosed_debt": return one(c, "A2-2-04 (SEL-2025-09)", [[f.undisclosed_debt_message_on_final === true, "DU relief message on the final submission"]]);
      case "income_calculator": return one(c, "A2-2-04 (Income Calculator)", [[f.qualifying_income_cents !== null && f.qualifying_income_cents !== undefined && f.calculator_income_cents !== null && f.calculator_income_cents !== undefined && f.qualifying_income_cents <= f.calculator_income_cents, "qualifying income ≤ calculator amount"]]);
      case "value_acceptance": return one(c, "A2-2-06", [[sfcs.includes("801") || sfcs.includes("774"), "SFC 801/774 delivered"], [f.collateral_program === "ValueAcceptance", "InvestorCollateralProgramIdentifier = ValueAcceptance"]]);
      case "cu_score_2_5": return one(c, "A2-2-06", [[!!f.cu_score && Decimal.parse(f.cu_score).cmp(Decimal.parse("2.5")) <= 0, "CU risk score ≤ 2.5 on the delivered Doc File ID"], [(f.units ?? 1) === 1, "one-unit property"]]);
      case "payment_history_36": { const target = f.first_payment_date ? addMonths(f.first_payment_date, 35) : null; return one(c, "A2-3.2-02", [[!!f.purchase_date, "acquisition date known"]], target); }
    }
  });
}
export const RELIEF_36TH_PAYMENT = (firstPaymentDate: PlainDate): PlainDate => addMonths(firstPaymentDate, 35);

// ============================================================ R8: post-purchase adjustments (seller-initiated)
export interface PpaAttribute { readonly attribute: string; readonly delivered_value: string; readonly corrected_value: string; readonly evidence_document_id: string; }
export interface PpaPlan { readonly repricing_due_on: PlainDate; readonly repricing_eligible: boolean; readonly correction_required: true; readonly csv_rows: readonly Record<string, string>[]; readonly document_names: readonly string[]; readonly expected_llpa_delta_cents: Cents; readonly llpa_draft_expected: boolean; readonly processing_expected_on: PlainDate | null; readonly lookback_note: string; }
/** R8: `repricing_eligible = (today ≤ acquisition_date + 18 months)` (Nov 19, 2026 → May 19, 2028); the PPA .csv and `<FM Loan No.>_<Document Name>.pdf` names; a correction is required regardless of price effect (C1-2-02); no draft below the $100 minimum; processing 10 `business_days_fannie_et` from submission. */
export function preparePpa(i: { fnma_loan_number: string; acquisition_date: PlainDate; discovered_on: PlainDate; attributes: readonly PpaAttribute[]; expected_llpa_delta_cents: Cents; submitted_on?: PlainDate | null }, cal: Calendar = fannieSifma): PpaPlan {
  need(/^\d{10}$/.test(i.fnma_loan_number), "fnma_loan_number must be 10 digits"); need(i.attributes.length > 0, "at least one attribute");
  const repricing_due_on = addMonths(i.acquisition_date, PPA_LLPA_LOOKBACK_MONTHS);
  const delta = i.expected_llpa_delta_cents; const abs = delta < 0n ? -delta : delta;
  return { repricing_due_on, repricing_eligible: i.discovered_on <= repricing_due_on, correction_required: true,
    csv_rows: i.attributes.map((a) => ({ "Fannie Mae Loan Number": i.fnma_loan_number, Attribute: a.attribute, "Delivered Value": a.delivered_value, "Corrected Value": a.corrected_value })),
    document_names: i.attributes.map((a) => `${i.fnma_loan_number}_${a.attribute.replace(/\s+/g, "")}.pdf`), expected_llpa_delta_cents: delta, llpa_draft_expected: abs >= PPA_LLPA_MINIMUM_CENTS,
    processing_expected_on: i.submitted_on ? addBusinessDays(i.submitted_on, PPA_PROCESSING_BD, cal) : null, lookback_note: "data corrections have no lookback or threshold (PPA FAQ Q9); LLPA repricing only within 18 months of acquisition; $100 minimum draft/refund" };
}
export const ppaProcessingExpected = (submittedOn: PlainDate, cal: Calendar = fannieSifma): PlainDate => addBusinessDays(submittedOn, PPA_PROCESSING_BD, cal);
/** FNMA_LQC_DATA_VALIDATION_RESPONSE_30: +30 calendar days from the LQC notification (an earlier date on the request wins). */
export const lqcResponseDue = (notifiedOn: PlainDate, statedDue: PlainDate | null = null): PlainDate => { const d = addDays(notifiedOn, 30); return statedDue && statedDue < d ? statedDue : d; };

// ============================================================ R9: remedy execution from the delivery side
export interface RemedyPlan { readonly demand_on: PlainDate; readonly pay_by: PlainDate; readonly paid_on: PlainDate | null; readonly within_60_days: boolean | null; readonly collateral_return: { kind: "note_release_request" | "enote_transfer_of_control" | "none"; form: string | null; to: string | null }; readonly lar_action_code: "65" | "67"; readonly readvance_allowed: boolean; readonly readvance_refusal: string | null; }
/** A2-3.2-01: paid within 60 days of the demand (Mon Feb 22 → by Fri Apr 23, 2027; paid Thu Apr 15); collateral returns by a Form 2009-equivalent request (paper) or a Transfer of Control from Fannie Mae (eNote); servicing 5.6 reports LAR 65 (67 for an ARM-modification feature); 27.1 re-advances only under the `warehouse.repurchase_advance` facility flag. */
export function remedyPlan(i: { demand_on: PlainDate; paid_on: PlainDate | null; note_form: NoteForm; liquidated?: boolean; arm_modification_feature?: boolean; flags?: Record<string, unknown> }): RemedyPlan {
  const pay_by = addDays(i.demand_on, REMEDY_PAYMENT_DAYS);
  const collateral_return = i.liquidated ? { kind: "none" as const, form: null, to: null } : i.note_form === "enote" ? { kind: "enote_transfer_of_control" as const, form: "MERS eRegistry Transfer of Control (and Location)", to: "partner" } : { kind: "note_release_request" as const, form: "Form 2009-equivalent (Request for Release/Return of Documents)", to: "partner" };
  const readvance_allowed = i.flags?.["warehouse.repurchase_advance"] === true || i.flags?.["warehouse.repurchase_advance"] === "true";
  return { demand_on: i.demand_on, pay_by, paid_on: i.paid_on, within_60_days: i.paid_on ? i.paid_on <= pay_by : null, collateral_return, lar_action_code: i.arm_modification_feature ? "67" : "65", readvance_allowed, readvance_refusal: readvance_allowed ? null : "27.1 re-advance blocked: facility flag warehouse.repurchase_advance is off (the partner funds the repurchase price from corporate funds)" };
}

// ============================================================ the delivery record and the service
export interface Delivery {
  readonly delivery_id: string; readonly loan_id: string; readonly application_id: string; readonly partner_id: string; readonly seller_loan_number: string; readonly commitment_id_fnma: string; commitment_expires_on: PlainDate; commitment_closed: boolean;
  readonly note_form: NoteForm; readonly enote_indicator: boolean; readonly min: string | null; readonly upb_cents: Cents; readonly note_rate: string; readonly pass_through_rate: string; readonly servicing_fee_rate: string; readonly commitment_price: string; readonly remittance_type: RemittanceType;
  readonly disbursement_date: PlainDate; readonly first_payment_date: PlainDate; lpi_due_date: PlainDate; readonly custodian_fin: string | null; readonly custodian_party_id: string | null; readonly bailee_letter_id: string | null; readonly wire_instruction_id: string | null; payee_code: string | null;
  package_id: string | null; package_sha256: string | null; package_file_name: string | null; frozen_at: string | null;
  loan_delivery_status: LoanDeliveryStatus; certification_status: CertificationStatus; fnma_loan_number: string | null; submitted_at: string | null; submitted_by_operator_id: string | null; submit_before_2100_et: boolean | null; edit_history_document_id: string | null;
  purchase_ready_at: PlainDate | null; purchase_date: PlainDate | null; acquisition_date: PlainDate | null; purchase_advice_id: string | null; transfer_of_control_request_id: string | null; custodian_certification_id: string | null;
  status_observed_at: string | null; status_source: StatusSource | null; expected_certification_date: PlainDate | null; expected_purchase_date: PlainDate | null; delivery_attempt: number; withdrawn_reason: string | null;
}
export type DeliveryInput = Pick<Delivery, "delivery_id" | "loan_id" | "application_id" | "partner_id" | "seller_loan_number" | "commitment_id_fnma" | "commitment_expires_on" | "note_form" | "upb_cents" | "note_rate" | "pass_through_rate" | "servicing_fee_rate" | "commitment_price" | "remittance_type" | "disbursement_date" | "first_payment_date"> &
  Partial<Pick<Delivery, "enote_indicator" | "min" | "custodian_fin" | "custodian_party_id" | "bailee_letter_id" | "wire_instruction_id" | "payee_code" | "commitment_closed" | "lpi_due_date">>;
export interface OperatorTask { readonly task_id: string; readonly delivery_id: string; readonly package_id: string | null; readonly kind: TaskKind; readonly org: TaskOrg; readonly escalation_id: string; readonly instruction_document_id: string | null; readonly checklist: readonly { step: string; expected: string }[]; readonly sla_due_at: string | null; readonly opened_at: string; started_at: string | null; completed_at: string | null; operator_id: string | null; captured_state: Record<string, unknown>; evidence_document_ids: string[]; hash_confirmed: boolean; outcome: TaskOutcome | null; block_reason: BlockReason | null; }
export interface CustodianCertification { readonly certification_id: string; readonly delivery_id: string; readonly custodian_party_id: string | null; readonly custodian_fin: string | null; custody_mode: CustodyMode; package_document_ids: string[]; carrier: string | null; tracking_number: string | null; package_shipped_at: string | null; first_morning_service: boolean | null; received_at_custodian: string | null; received_by_0730_et: boolean | null; custodian_cutoff_local_at: string | null; certified_at: string | null; certification_kind: CertificationKind | null; data_revisions: (DataRevision & { seller_response: "accepted" | "declined" | null; responded_at: string | null })[]; document_exceptions: Record<string, unknown>[]; bailee_validation: "n/a" | "passed" | "failed"; bailee_letter_name_used: string | null; notice_document_ids: string[]; fnma_loan_number_recorded_at: string | null; }
export interface PurchaseAdviceRow extends PurchaseAdviceInput { readonly purchase_advice_id: string; readonly delivery_id: string; readonly loan_id: string; expected_net_proceeds_cents: Cents | null; expected_net_high_cents: Cents | null; variance_cents: Cents | null; reconciled_at: string | null; readonly adjustment_request_due_at: PlainDate; }
export interface PostPurchaseAdjustment { readonly ppa_id: string; readonly loan_id: string; readonly fnma_loan_number: string; readonly initiated_by: "seller" | "fnma_lqc"; readonly discovered_at: string; readonly attributes: readonly PpaAttribute[]; lsdu_submitted_at: string | null; ppa_form_document_id: string | null; readonly expected_llpa_delta_cents: Cents; notification_report_document_id: string | null; llpa_draft_or_refund_cents: Cents | null; settled_at: string | null; status: PpaStatus; readonly repricing_eligible: boolean; readonly plan: PpaPlan; }
export interface ReliefRow { readonly relief_id: string; readonly application_id: string; readonly loan_id: string; readonly component: ReliefComponent; delivered_with_conditions_met: boolean; status: ReliefStatus; fnma_report_id: string | null; confirmed_at: string | null; readonly evaluation: ReliefEvaluation; }
export interface DecisionRecord29_4 { readonly delivery_id: string; readonly package_id: string | null; readonly sha256: string | null; readonly planned_dates: Record<string, string | null>; readonly deadlines: Record<string, string | null>; readonly wire: Record<string, unknown> | null; readonly evidence_ids: readonly string[]; readonly observed_statuses: readonly { status: string; source: string; at: string }[]; readonly variances: readonly VarianceComponent[]; readonly relief_evaluation: readonly ReliefEvaluation[]; readonly rationale: string; readonly confidence: number; readonly rule_set_versions: typeof RULE_SET_VERSIONS_29_4; readonly model_version: string; readonly prompt_version: string; }
export interface ServiceDeps29_4 { readonly events: EventStore; readonly clock: Clock; readonly escalations?: EscalationService; readonly calendar?: Calendar; readonly creditorCalendar?: Calendar; readonly registry?: ERegistryPort; readonly sm_org_id?: string; }

export class DeliveryService {
  readonly rows = new Map<string, Delivery>(); readonly tasks: OperatorTask[] = []; readonly certifications: CustodianCertification[] = []; readonly wires = new Map<string, WireInstruction>(); readonly advices: PurchaseAdviceRow[] = []; readonly ppas: PostPurchaseAdjustment[] = []; readonly relief: ReliefRow[] = [];
  readonly observed: { delivery_id: string; status: string; source: string; at: string }[] = [];
  readonly d: ServiceDeps29_4; readonly cal: Calendar; readonly creditorCal: Calendar; readonly actor: Actor = SECONDARY_AGENT_29_4; readonly smOrgId: string;
  constructor(deps: ServiceDeps29_4) { this.d = deps; this.cal = deps.calendar ?? fannieSifma; this.creditorCal = deps.creditorCalendar ?? creditor; this.smOrgId = deps.sm_org_id ?? SM_WAREHOUSE_ORG_ID; }
  private now(): string { return this.d.clock.now(); }
  get(id: string): Delivery { const r = this.rows.get(id); if (!r) throw new RangeError(`no delivery ${id}`); return r; }
  byLoan(loanId: string): Delivery | null { return [...this.rows.values()].find((r) => r.loan_id === loanId) ?? null; }
  wire(id: string | null): WireInstruction | null { return id ? this.wires.get(id) ?? null : null; }
  private emit(r: Pick<Delivery, "delivery_id" | "loan_id" | "application_id">, type: string, payload: Record<string, unknown>, at: string = this.now(), actor: Actor = this.actor): DomainEvent {
    return this.d.events.append({ type, loanId: r.loan_id, applicationId: r.application_id, aggregate: { kind: "delivery", id: r.delivery_id }, actor, occurredAt: at, payload: { delivery_id: r.delivery_id, loan_id: r.loan_id, application_id: r.application_id, source: "origination", ...payload } });
  }
  private observe(r: Delivery, ld: LoanDeliveryStatus | null, cert: CertificationStatus | null, source: StatusSource, at: string, extra: Record<string, unknown> = {}): DomainEvent {
    if (ld) r.loan_delivery_status = ld; if (cert) r.certification_status = cert; r.status_observed_at = at; r.status_source = source;
    this.observed.push({ delivery_id: r.delivery_id, status: `${r.loan_delivery_status}/${r.certification_status}`, source, at });
    return this.emit(r, "delivery.status.observed", { loan_delivery_status: r.loan_delivery_status, certification_status: r.certification_status, source, ...extra }, at);
  }
  /** The `deliveries` row 29.3 built, with 29.4's status columns initialised. */
  register(i: DeliveryInput): Delivery {
    nonEmpty(i.delivery_id, "delivery_id"); nonEmpty(i.loan_id, "loan_id"); nonEmpty(i.application_id, "application_id"); nonEmpty(i.commitment_id_fnma, "commitment_id_fnma");
    const r: Delivery = { ...i, enote_indicator: i.enote_indicator ?? i.note_form === "enote", min: i.min ?? null, custodian_fin: i.custodian_fin ?? null, custodian_party_id: i.custodian_party_id ?? null, bailee_letter_id: i.bailee_letter_id ?? null, wire_instruction_id: i.wire_instruction_id ?? null, payee_code: i.payee_code ?? null, commitment_closed: i.commitment_closed ?? false, lpi_due_date: i.lpi_due_date ?? lpiDueDate(i.first_payment_date),
      package_id: null, package_sha256: null, package_file_name: null, frozen_at: null, loan_delivery_status: "not_started", certification_status: "none", fnma_loan_number: null, submitted_at: null, submitted_by_operator_id: null, submit_before_2100_et: null, edit_history_document_id: null, purchase_ready_at: null, purchase_date: null, acquisition_date: null, purchase_advice_id: null,
      transfer_of_control_request_id: null, custodian_certification_id: null, status_observed_at: null, status_source: null, expected_certification_date: null, expected_purchase_date: null, delivery_attempt: 1, withdrawn_reason: null };
    this.rows.set(r.delivery_id, r); return r;
  }
  registerWire(w: WireInstruction): WireInstruction { this.wires.set(w.wire_instruction_id, w); return w; }
  /** 29.3's `delivery.package.frozen{package_id, sha256}` / `delivery.package.superseded` as this process consumes them. */
  onPackageFrozen(deliveryId: string, i: { package_id: string; sha256: string; file_name: string; frozen_at: string }): Delivery { const r = this.get(deliveryId); r.package_id = i.package_id; r.package_sha256 = i.sha256; r.package_file_name = i.file_name; r.frozen_at = i.frozen_at; return r; }
  /** 29.3's `delivery.package.superseded{package_id, reason}` / `delivery.operator_task.cancelled{package_id, escalation_ids}`: the open import_and_submit task for that package is cancelled (29.3 appends the record event; nothing is re-emitted here). */
  onPackageSuperseded(deliveryId: string, i: { package_id: string; reason: string; at?: string }): { cancelled: OperatorTask[] } {
    const r = this.get(deliveryId); const at = i.at ?? this.now(); const cancelled: OperatorTask[] = [];
    for (const t of this.tasks) if (t.delivery_id === r.delivery_id && t.package_id === i.package_id && t.outcome === null) { t.outcome = "cancelled"; t.block_reason = null; t.completed_at = at; cancelled.push(t); }
    if (r.package_id === i.package_id) { r.package_id = null; r.package_sha256 = null; r.frozen_at = null; }
    return { cancelled };
  }
  /** 26.3/30.2 `loan.funded` and 2.x `payment.posted` before purchase: R1's LPI re-anchoring. */
  onPaymentPosted(deliveryId: string, installmentDue: PlainDate, at: string = this.now()): LpiWindow {
    const r = this.get(deliveryId); need(!r.purchase_date, "payments after purchase are the investor's (5.x)");
    r.lpi_due_date = installmentDue; const w = lpiWindow(r.first_payment_date, installmentDue);
    this.emit(r, "delivery.lpi.reanchored", { lpi_due_date: w.lpi_due_date, delivery_lpi_due: w.delivery_lpi_due, installment_due: installmentDue }, at);
    return w;
  }
  window(deliveryId: string): LpiWindow { const r = this.get(deliveryId); return lpiWindow(r.first_payment_date, r.lpi_due_date === addMonths(r.first_payment_date, -1) ? null : r.lpi_due_date); }
  private task(r: Delivery, kind: TaskKind, org: TaskOrg, payload: Record<string, unknown>, o: { sla_due_at?: string | null; checklist?: readonly { step: string; expected: string }[]; instruction_document_id?: string | null; at?: string; role?: string } = {}): OperatorTask {
    const at = o.at ?? this.now();
    const esc = this.d.escalations ? this.d.escalations.open({ kind: "human_portal_task", ownerRole: o.role ?? "fnma_portal_operator", loanId: r.loan_id, applicationId: r.application_id, payload: { task: kind, org, delivery_id: r.delivery_id, sla_due_at: o.sla_due_at ?? null, source: "origination", ...payload } }, this.actor) : null;
    const t: OperatorTask = { task_id: randomUUID(), delivery_id: r.delivery_id, package_id: r.package_id, kind, org, escalation_id: esc?.id ?? `esc-${randomUUID()}`, instruction_document_id: o.instruction_document_id ?? null, checklist: o.checklist ?? [], sla_due_at: o.sla_due_at ?? null, opened_at: at, started_at: null, completed_at: null, operator_id: null, captured_state: {}, evidence_document_ids: [], hash_confirmed: false, outcome: null, block_reason: null };
    this.tasks.push(t);
    this.emit(r, "delivery.operator_task.opened", { task_id: t.task_id, kind, org, escalation_id: t.escalation_id, sla_due_at: t.sla_due_at, package_id: r.package_id }, at);
    return t;
  }
  /** `openOperatorTask` (R2, T1, T5, edge cases): guards — frozen package (SM_O103_PACKAGE_FREEZE_GATE), commitment closed (FAQ Q26), wire active (or pending + SM task), 23.4 gates, 22.6 hold, expected receipt inside the commitment guard (else a 29.1 extension request first). */
  openOperatorTask(i: { delivery_id: string; at?: string; pre_justified_warnings?: readonly string[]; gate_facts?: Record<string, unknown>; fraud_hold?: { fraud_hold: boolean; reason?: string | null } | null; command?: string }): { task: OperatorTask | null; sheet: InstructionSheet | null; plan: ReceiptPlan; warehouse_task: OperatorTask | null; extension_requested: boolean; escalation_id: string | null } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now();
    need(!!r.package_id && !!r.package_sha256 && !!r.frozen_at, "SM_O103_PACKAGE_FREEZE_GATE: no frozen package (delivery.package.frozen) for this delivery");
    if (!r.commitment_closed) throw new DeliveryRefused("COMMITMENT_NOT_CLOSED", "PE–WL FAQ Q26 / 29.4 edge case: best-efforts commitments are available in Loan Delivery once moved to a closed status", "the operator task waits on commitment.status = closed (29.1 FNMA_PEWL_CLOSED_STATUS_1BD)");
    assertNoFraudHold(i.fraud_hold ?? null, i.command ?? "funding.authorized");
    for (const g of ["23.4.qmDeterminationGate", "23.4.hoepaGate", "23.4.stateHighCostGate"]) { const res = evaluateGate(g, { ...(i.gate_facts ?? {}), command: "submitDelivery" }); if (!res.open) throw new DeliveryRefused(g, "23.4 gates on submitDelivery (HOEPA/state high-cost loans are not eligible for delivery — B2-1.5-02)", res.reason ?? "closed"); }
    const plan = receiptPlan(r.frozen_at!, r.commitment_expires_on, this.cal);
    if (plan.extension_required) {
      const e = this.emit(r, "delivery.extension.requested", { expected_receipt_on: plan.expected_receipt_on, receipt_deadline_on: plan.deadline.due_on, receipt_deadline_at: plan.deadline.due_at, commitment_expires_on: r.commitment_expires_on, commitment_id_fnma: r.commitment_id_fnma, requested_of: "29.1" }, at);
      return { task: null, sheet: null, plan, warehouse_task: null, extension_requested: true, escalation_id: e.id };
    }
    const w = this.wire(r.wire_instruction_id);
    let warehouse_task: OperatorTask | null = null;
    if (w && w.status === "pending") warehouse_task = this.task(r, "warehouse_wire_approval", "sm_warehouse_org", { payee_code: w.payee_code, bailee_letter_name_expected: w.bailee_letter_name }, { at, sla_due_at: etInstant(addBusinessDays(etDate(at), 1, this.creditorCal), "17:00") });
    const g = wireGate(w, warehouse_task !== null);
    if (!g.open) throw new DeliveryRefused("PAYEE_CODE_NOT_ACTIVE", "C2-2-07 / 29.4 edge case: no submission with an inactive code", g.reason ?? "wire instruction not active");
    const sheet = renderInstructionSheet({ package_id: r.package_id!, file_name: r.package_file_name ?? `${r.package_id}.xml`, sha256: r.package_sha256!, commitment_id_fnma: r.commitment_id_fnma, wire: w!, enote_indicator: r.enote_indicator, ...(i.pre_justified_warnings ? { pre_justified_warnings: i.pre_justified_warnings } : {}) });
    const task = this.task(r, "import_and_submit", "partner_seller_org", { file_name: sheet.file_name, sha256: sheet.sha256, commitment_number: sheet.commitment_number, payee_code: sheet.payee_code, receiver_type: sheet.receiver_type_label, letter_type: sheet.letter_type_label, bailee_letter_name: sheet.bailee_letter_name, enote_indicator: sheet.enote_indicator, evidence_required: sheet.evidence_required }, { at, sla_due_at: plan.sla_due_at, checklist: sheet.steps, instruction_document_id: `doc-sheet-${r.package_id}` });
    return { task, sheet, plan, warehouse_task, extension_requested: false, escalation_id: task.escalation_id };
  }
  /** `parseOperatorEvidence` for the import_and_submit task: the evidence gate, the edit classification, then the submission record. Two operators never share a loan across the seller and warehouse orgs. */
  completeOperatorTask(i: { task_id: string; operator_id: string; evidence: readonly { kind: string; document_id: string }[]; hash_confirmed: boolean; captured_state: Record<string, unknown>; edits?: readonly CapturedEdit[]; pre_justified_warnings?: readonly string[]; at?: string }): { task: OperatorTask; blocked: BlockReason | null; submission: DomainEvent | null; expected: ExpectedDates | null; relief: ReliefRow[] } {
    const t = this.tasks.find((x) => x.task_id === i.task_id); if (!t) throw new RangeError(`no task ${i.task_id}`);
    const r = this.get(t.delivery_id); const at = i.at ?? this.now();
    need(t.outcome === null, `task ${t.task_id} is ${t.outcome}`);
    const other = this.tasks.find((x) => x.delivery_id === r.delivery_id && x.org !== t.org && x.operator_id === i.operator_id);
    if (other) throw new DeliveryRefused("SEGREGATION_OF_DUTIES", "29.4 task design: the person who submits the delivery does not approve the warehouse wire", `operator ${i.operator_id} already acted on this loan in the ${other.org}`);
    t.operator_id = i.operator_id; t.captured_state = { ...i.captured_state }; t.evidence_document_ids = i.evidence.map((e) => e.document_id); t.hash_confirmed = i.hash_confirmed; t.started_at = t.started_at ?? at;
    const block = (reason: BlockReason): ReturnType<DeliveryService["completeOperatorTask"]> => { t.outcome = "blocked"; t.block_reason = reason; t.completed_at = at; this.emit(r, "delivery.operator_task.blocked", { task_id: t.task_id, reason, captured_state: t.captured_state }, at); return { task: t, blocked: reason, submission: null, expected: null, relief: [] }; };
    if (i.captured_state.ui_outage === true) return block("ui_outage");
    if (i.captured_state.commitment_missing === true) return block("commitment_missing");
    const edits = classifyImportEdits(i.edits ?? [], i.pre_justified_warnings ?? []);
    for (const o of edits.observed) this.emit(r, "delivery.edit.observed", { edit_id: randomUUID(), source: "loan_delivery", edit_code: o.edit_code, severity: o.fatal ? "fatal" : "warning", fatal: o.fatal, prefix: o.prefix, owner_process: o.owner_process, rebuild_required: o.rebuild_required, task_id: t.task_id }, at);
    if (edits.block === "commitment_edit") { this.emit(r, "delivery.commitment_edit.notified", { process: "29.1", commitment_id_fnma: r.commitment_id_fnma, edit_codes: edits.observed.filter((o) => o.prefix === "numeric").map((o) => o.edit_code), rebuild: false }, at); if (r.loan_delivery_status === "not_started") this.observe(r, "draft", null, "operator_capture", at); return block("commitment_edit"); }
    if (edits.block) return block(edits.block);
    const ev = evidenceGate({ evidence: i.evidence, hash_confirmed: i.hash_confirmed, captured_state: i.captured_state }, { commitment_id_fnma: r.commitment_id_fnma, sha256: r.package_sha256 ?? "" });
    if (!ev.complete) throw new DeliveryRefused("EVIDENCE_INCOMPLETE", "29.4 T1 / task design (3)–(4): the task cannot be marked complete without the four evidence items and hash_confirmed = true", ev.reasons.join("; "));
    const fnma = nonEmpty(i.captured_state.fnma_loan_number, "captured fnma_loan_number"); need(/^\d{10}$/.test(fnma), "fnma_loan_number must be 10 digits");
    const submitted_at = nonEmpty(i.captured_state.submitted_at, "captured submitted_at");
    t.outcome = "completed"; t.completed_at = at;
    this.emit(r, "delivery.operator_task.completed", { task_id: t.task_id, escalation_id: t.escalation_id, evidence_document_ids: t.evidence_document_ids, hash_confirmed: true }, at);
    const sub = this.recordSubmission({ delivery_id: r.delivery_id, fnma_loan_number: fnma, submitted_at, operator_id: i.operator_id, edit_history_document_id: i.evidence.find((e) => e.kind === "edit_history_csv")?.document_id ?? null, at, relief: (i.captured_state.relief_facts as ReliefFacts | undefined) ?? null, relief_components: (i.captured_state.relief_components as ReliefComponent[] | undefined) ?? [] });
    return { task: t, blocked: null, submission: sub.event, expected: sub.expected, relief: sub.relief };
  }
  /** `delivery.submitted` from submit evidence: Fannie Mae loan number, Purchase Requested / Awaiting Certification, the 9:00 p.m. ET flag, expected dates (R2), and R7's relief bookkeeping. */
  recordSubmission(i: { delivery_id: string; fnma_loan_number: string; submitted_at: string; operator_id: string; edit_history_document_id?: string | null; at?: string; resubmit?: boolean; relief?: ReliefFacts | null; relief_components?: readonly ReliefComponent[] }): { event: DomainEvent; expected: ExpectedDates; relief: ReliefRow[] } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now();
    if (r.enote_indicator) { const g = enoteTransferGate(this.enoteFacts(r)); if (!g.open) throw new DeliveryRefused("FNMA_C1_2_04_ENOTE_TRANSFER_SAME_DAY_GATE", "C1-2-04: eDelivery and a same-day Transfer of Control and Location before submission", g.reason ?? "closed"); }
    const exp = expectedDates(i.submitted_at, this.cal);
    r.fnma_loan_number = i.fnma_loan_number; r.submitted_at = i.submitted_at; r.submitted_by_operator_id = i.operator_id; r.submit_before_2100_et = exp.submit_before_2100_et; r.edit_history_document_id = i.edit_history_document_id ?? null; r.expected_certification_date = exp.expected_certification_date; r.expected_purchase_date = exp.expected_purchase_date;
    const event = this.emit(r, "delivery.submitted", { fnma_loan_number: i.fnma_loan_number, submitted_at: i.submitted_at, submitted_on: etDate(i.submitted_at), submit_before_2100_et: exp.submit_before_2100_et, resubmit: i.resubmit === true, data_day: exp.data_day, expected_receipt_at: exp.expected_receipt_at, expected_certification_date: exp.expected_certification_date, expected_purchase_date: exp.expected_purchase_date, delivery_attempt: r.delivery_attempt, commitment_id_fnma: r.commitment_id_fnma, payee_code: r.payee_code, enote_indicator: r.enote_indicator }, at);
    this.observe(r, "purchase_requested", "awaiting_certification", "operator_capture", at, { fnma_loan_number: i.fnma_loan_number });
    if (r.note_form === "enote") this.emit(r, "custody.package.received", { custody_mode: "evault_auto", by_0730_et: true, received_at: i.submitted_at, expected_certification_date: exp.expected_certification_date, expected_purchase_date: exp.expected_purchase_date, note: "eNote: Fannie Mae is the custodian; eDelivery stands in for receipt" }, at);
    const relief = i.relief && i.relief_components?.length ? this.bookRelief(r, i.relief_components, i.relief, at) : [];
    return { event, expected: exp, relief };
  }
  /** R7 bookkeeping at submission. */
  bookRelief(r: Delivery, components: readonly ReliefComponent[], facts: ReliefFacts, at: string = this.now()): ReliefRow[] {
    return evaluateRelief(components, { ...facts, purchase_date: facts.purchase_date ?? r.purchase_date, first_payment_date: facts.first_payment_date ?? r.first_payment_date }).map((ev) => {
      const row: ReliefRow = { relief_id: `rwr:${r.application_id}:${ev.component}`, application_id: r.application_id, loan_id: r.loan_id, component: ev.component, delivered_with_conditions_met: ev.delivered_with_conditions_met, status: ev.status, fnma_report_id: null, confirmed_at: null, evaluation: ev };
      const idx = this.relief.findIndex((x) => x.relief_id === row.relief_id); if (idx >= 0) this.relief[idx] = row; else this.relief.push(row);
      this.emit(r, "rep_warrant_relief.delivered", { relief_id: row.relief_id, component: ev.component, delivered_with_conditions_met: ev.delivered_with_conditions_met, status: ev.status, reasons: ev.reasons, basis_ref: ev.basis_ref }, at);
      return row;
    });
  }
  /** Fannie Mae's relief report confirms; a QC finding (28.2) loses — never `confirmed_by_fnma` without a report id (guardrail). */
  confirmRelief(i: { delivery_id: string; component: ReliefComponent; fnma_report_id: string; at?: string }): ReliefRow {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); nonEmpty(i.fnma_report_id, "fnma_report_id (a Fannie Mae relief report)");
    const row = this.relief.find((x) => x.loan_id === r.loan_id && x.component === i.component); if (!row) throw new RangeError(`no relief row ${i.component}`);
    row.status = "confirmed_by_fnma"; row.fnma_report_id = i.fnma_report_id; row.confirmed_at = at;
    this.emit(r, "rep_warrant_relief.confirmed", { relief_id: row.relief_id, component: row.component, fnma_report_id: i.fnma_report_id, confirmed_at: at }, at);
    return row;
  }
  loseRelief(i: { delivery_id: string; component: ReliefComponent; finding: string; qc_case_id?: string | null; at?: string }): ReliefRow {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now();
    const row = this.relief.find((x) => x.loan_id === r.loan_id && x.component === i.component); if (!row) throw new RangeError(`no relief row ${i.component}`);
    row.status = "lost"; this.emit(r, "rep_warrant_relief.lost", { relief_id: row.relief_id, component: row.component, finding: i.finding, qc_case_id: i.qc_case_id ?? null, owner: "28.2" }, at);
    return row;
  }
  private certification(r: Delivery, mode: CustodyMode): CustodianCertification {
    let c = this.certifications.find((x) => x.delivery_id === r.delivery_id && x.certified_at === null) ?? null;
    if (!c) { c = { certification_id: randomUUID(), delivery_id: r.delivery_id, custodian_party_id: r.custodian_party_id, custodian_fin: r.custodian_fin, custody_mode: mode, package_document_ids: [], carrier: null, tracking_number: null, package_shipped_at: null, first_morning_service: null, received_at_custodian: null, received_by_0730_et: null, custodian_cutoff_local_at: null, certified_at: null, certification_kind: null, data_revisions: [], document_exceptions: [], bailee_validation: "n/a", bailee_letter_name_used: null, notice_document_ids: [], fnma_loan_number_recorded_at: null }; this.certifications.push(c); r.custodian_certification_id = c.certification_id; }
    return c;
  }
  /** `scheduleShipment` / `prepareCustodianPackage` → `custody.package.shipped{first_morning_service=true}` the same day as the data submission (C2-2-02; FNMA_C2_2_02_SHIP_SAME_DAY_AS_SUBMIT). */
  recordShipment(i: { delivery_id: string; carrier: string; tracking_number: string; tendered_at: string; first_morning_service: boolean; package_document_ids: readonly string[]; custody_mode?: CustodyMode; at?: string }): { certification: CustodianCertification; event: DomainEvent; same_day_as_submit: boolean } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); need(r.note_form === "paper", "eNotes have no paper custodian package (C1-2-04)");
    const c = this.certification(r, i.custody_mode ?? "shipped_package"); c.carrier = i.carrier; c.tracking_number = i.tracking_number; c.package_shipped_at = i.tendered_at; c.first_morning_service = i.first_morning_service; c.package_document_ids = [...i.package_document_ids];
    const same_day_as_submit = !!r.submitted_at && etDate(r.submitted_at) === etDate(i.tendered_at);
    const event = this.emit(r, "custody.package.shipped", { certification_id: c.certification_id, carrier: i.carrier, tracking_number: i.tracking_number, package_shipped_at: i.tendered_at, first_morning_service: i.first_morning_service, same_day_as_submit, custody_mode: c.custody_mode, package_document_ids: c.package_document_ids }, at);
    return { certification: c, event, same_day_as_submit };
  }
  /** `trackShipment`: carrier delivery → `custody.package.received{by_0730_et}` with the recomputed expectations. */
  recordReceipt(i: { delivery_id: string; received_at: string; at?: string }): { certification: CustodianCertification; recompute: ReceiptRecompute; event: DomainEvent } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); const c = this.certification(r, "shipped_package");
    const rc = recomputeOnReceipt(i.received_at, this.cal);
    c.received_at_custodian = i.received_at; c.received_by_0730_et = rc.received_by_0730_et; c.custodian_cutoff_local_at = etInstant(rc.received_on, CUSTODIAN_CUTOFF_HHMM_ET);
    r.expected_certification_date = rc.expected_certification_date; r.expected_purchase_date = rc.expected_purchase_date;
    const event = this.emit(r, "custody.package.received", { certification_id: c.certification_id, received_at: i.received_at, received_on: rc.received_on, by_0730_et: rc.received_by_0730_et, received_by_custodian_cutoff: rc.received_by_custodian_cutoff, expected_certification_date: rc.expected_certification_date, expected_purchase_date: rc.expected_purchase_date, carrier_claim: !rc.received_by_0730_et && c.first_morning_service === true }, at);
    return { certification: c, recompute: rc, event };
  }
  /** Document Certification notice → `custody.certified{certification_kind}`; Purchase Ready with `purchase_ready_at` (the LLPA date); the loan-age rule checked. */
  recordCertification(i: { delivery_id: string; certified_at: string; certification_kind: CertificationKind; bailee_validation?: "n/a" | "passed" | "failed"; bailee_letter_name_used?: string | null; notice_document_id?: string | null; source?: StatusSource; at?: string }): { certification: CustodianCertification; event: DomainEvent; expected_purchase_date: PlainDate; loan_age: ReturnType<typeof loanAgeCheck> } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); const c = this.certification(r, i.certification_kind === "auto_certified_enote" ? "evault_auto" : "shipped_package");
    if (i.bailee_validation === "failed") throw new DeliveryRefused("BAILEE_VALIDATION_FAILED", "Job Aids v4.0: a letterhead mismatch is a document exception that cannot be certified", "SM's warehouse-org operator corrects the Letter Name (or SM reissues the letter); the custodian re-validates");
    const rc = recomputeOnCertification(i.certified_at, this.cal);
    c.certified_at = i.certified_at; c.certification_kind = i.certification_kind; c.bailee_validation = i.bailee_validation ?? (r.bailee_letter_id ? "passed" : "n/a"); c.bailee_letter_name_used = i.bailee_letter_name_used ?? null; if (i.notice_document_id) c.notice_document_ids.push(i.notice_document_id);
    r.purchase_ready_at = rc.purchase_ready_at; r.expected_purchase_date = rc.expected_purchase_date;
    const cert: CertificationStatus = i.certification_kind === "qualified_cert" ? "qualified_cert" : i.certification_kind === "auto_certified_enote" ? "auto_certified" : "certified";
    const event = this.emit(r, "custody.certified", { certification_id: c.certification_id, certification_kind: i.certification_kind, certified_at: i.certified_at, certified_on: rc.certified_on, purchase_ready_at: rc.purchase_ready_at, expected_purchase_date: rc.expected_purchase_date, bailee_validation: c.bailee_validation, fnma_loan_number: r.fnma_loan_number }, at);
    const loan_age = loanAgeCheck(r.first_payment_date, rc.purchase_ready_at);
    this.observe(r, "purchase_ready", cert, i.source ?? (r.note_form === "enote" ? "evault_event" : "custodian_notice"), at, { purchase_ready_at: rc.purchase_ready_at, loan_age_due_on: loan_age.due_on, loan_age_breached: loan_age.breached });
    if (loan_age.breached && this.d.escalations) this.d.escalations.open({ kind: "officer", loanId: r.loan_id, applicationId: r.application_id, severity: "sev1", payload: { task: "loan_age_flow_ineligible", purchase_ready_at: rc.purchase_ready_at, due_on: loan_age.due_on, citation: "B2-1.5-02", source: "origination" } }, this.actor);
    return { certification: c, event, expected_purchase_date: rc.expected_purchase_date, loan_age };
  }
  /** FNMA_C1_2_02_FNMA_LOAN_NUMBER_TO_CUSTODIAN_30 / _CUSTODIAN_LOAN_NUMBER_REQUEST_3BD. */
  custodianLoanNumber(i: { delivery_id: string; op: "requested" | "responded" | "recorded"; evidence_document_id?: string | null; at?: string }): DomainEvent {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); const c = this.certification(r, "shipped_package");
    if (i.op === "recorded") c.fnma_loan_number_recorded_at = at;
    const due = i.op === "requested" ? addBusinessDays(etDate(at), 3, this.cal) : null;
    const type = i.op === "requested" ? "custody.loan_number.requested" : i.op === "responded" ? "custody.loan_number.responded" : "custody.loan_number.recorded";
    return this.emit(r, type, { certification_id: c.certification_id, fnma_loan_number: r.fnma_loan_number, evidence_document_id: i.evidence_document_id ?? null, response_due_on: due }, at);
  }
  /** R4: the custodian's data revision → the agent's prepared response (operator UI act) inside SM_LD_DATA_REVISION_RESPONSE_1BD. */
  dataRevisionReceived(i: { delivery_id: string; revision: DataRevision; notice_document_id?: string | null; at?: string }): { certification: CustodianCertification; event: DomainEvent; response_due_on: PlainDate } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); const c = this.certification(r, "shipped_package");
    c.data_revisions.push({ ...i.revision, seller_response: null, responded_at: null }); if (i.notice_document_id) c.notice_document_ids.push(i.notice_document_id);
    const due = dataRevisionResponseDue(at, this.creditorCal);
    const event = this.emit(r, "delivery.data_revision.received", { certification_id: c.certification_id, field: i.revision.field, custodian_value: i.revision.custodian_value, seller_value: i.revision.seller_value, editable_by_custodian: i.revision.editable_by_custodian, response_due_on: due }, at);
    return { certification: c, event, response_due_on: due };
  }
  prepareDataRevisionResponse(i: { delivery_id: string; field: string; note: { value: string; page_ref: string }; at?: string }): { decision: ReturnType<typeof dataRevisionDecision>; task: OperatorTask; response_due_on: PlainDate } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); const c = this.certification(r, "shipped_package");
    const rev = c.data_revisions.find((x) => x.field === i.field && x.seller_response === null); if (!rev) throw new RangeError(`no open data revision for ${i.field}`);
    const decision = dataRevisionDecision(rev, i.note);
    const task = this.task(r, "data_revision_response", "partner_seller_org", { field: i.field, response: decision.response, note_page_ref: decision.note_page_ref, rationale: decision.rationale }, { at, sla_due_at: etInstant(dataRevisionResponseDue(at, this.creditorCal), "17:00") });
    return { decision, task, response_due_on: dataRevisionResponseDue(at, this.creditorCal) };
  }
  recordDataRevisionResponse(i: { delivery_id: string; field: string; accepted: boolean; operator_id: string; evidence_document_id: string; at?: string }): { event: DomainEvent; edit_observed: DomainEvent | null; reviews: DomainEvent[] } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); const c = this.certification(r, "shipped_package");
    const rev = c.data_revisions.find((x) => x.field === i.field && x.seller_response === null); if (!rev) throw new RangeError(`no open data revision for ${i.field}`);
    rev.seller_response = i.accepted ? "accepted" : "declined"; rev.responded_at = at;
    const event = this.emit(r, "delivery.data_revision.responded", { certification_id: c.certification_id, field: i.field, accepted: i.accepted, operator_id: i.operator_id, evidence_document_id: i.evidence_document_id }, at);
    if (!i.accepted) { this.observe(r, null, "awaiting_certification", "custodian_notice", at); return { event, edit_observed: null, reviews: [] }; }
    this.observe(r, null, "qualified_cert", "custodian_notice", at);
    const edit_observed = this.emit(r, "delivery.edit.observed", { edit_id: randomUUID(), source: "custodian_data_revision", edit_code: `DR-${i.field}`, severity: "warning", fatal: false, prefix: "general", owner_process: "29.3", field: i.field, corrected_value: rev.custodian_value, delivered_value: rev.seller_value, rebuild_required: false }, at);
    const reviews = ["25.2", "26.1"].map((proc) => this.emit(r, "delivery.consistency_review.requested", { process: proc, field: i.field, note_value: rev.custodian_value, cd_value_to_check: rev.seller_value }, at));
    return { event, edit_observed, reviews };
  }
  /** Loan Delivery branch states observed from evidence. */
  purchaseErrorObserved(i: { delivery_id: string; edit_codes: readonly string[]; evidence_document_id: string; at?: string }): { event: DomainEvent; resubmit_due_on: PlainDate } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); need(r.loan_delivery_status === "purchase_requested" || r.loan_delivery_status === "purchase_ready", "Purchase Error follows a submitted, certified loan (User Guide p. 42)");
    const due = addBusinessDays(etDate(at), 1, this.creditorCal);
    const event = this.emit(r, "delivery.purchase_error.observed", { edit_codes: [...i.edit_codes], evidence_document_id: i.evidence_document_id, resubmit_due_on: due, second_submit_required: true }, at);
    this.observe(r, "purchase_error", null, "operator_capture", at);
    return { event, resubmit_due_on: due };
  }
  cancelCertification(i: { delivery_id: string; reason: string; operator_id: string; evidence_document_id: string; at?: string }): DomainEvent {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); need(r.loan_delivery_status === "purchase_requested" || r.loan_delivery_status === "purchase_ready" || r.loan_delivery_status === "purchase_error", "Cancel Certification moves a submitted loan back to Draft (User Guide pp. 61–62)");
    r.delivery_attempt += 1; r.purchase_ready_at = null;
    const e = this.emit(r, "delivery.certification.cancelled", { reason: i.reason, operator_id: i.operator_id, evidence_document_id: i.evidence_document_id, delivery_attempt: r.delivery_attempt }, at);
    this.observe(r, "cancelled_to_draft", "none", "operator_capture", at); r.loan_delivery_status = "draft";
    return e;
  }
  withdraw(i: { delivery_id: string; reason: string; at?: string }): DomainEvent {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); need(r.loan_delivery_status !== "purchased_and_funded", "a purchased loan is not withdrawn (repurchase is 28.2/R9)");
    r.withdrawn_reason = i.reason; const e = this.emit(r, "delivery.withdrawn", { reason: i.reason }, at); this.observe(r, "withdrawn", null, "operator_capture", at); return e;
  }
  // ---- R5: wires (SM warehouse org)
  wireListed(i: { wire_instruction_id: string; delivery_id: string; at?: string }): { task: OperatorTask; event: DomainEvent } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); const w = this.wires.get(i.wire_instruction_id); if (!w) throw new RangeError(`no wire instruction ${i.wire_instruction_id}`);
    const event = this.emit(r, "wire.instruction.listed", { wire_instruction_id: w.wire_instruction_id, payee_code: w.payee_code, receiver_type: w.receiver_type, letter_type: w.letter_type, warehouse_lender_org_id: w.warehouse_lender_org_id, approval_due_on: addBusinessDays(etDate(at), 1, this.creditorCal) }, at);
    const task = this.task(r, "warehouse_wire_approval", "sm_warehouse_org", { wire_instruction_id: w.wire_instruction_id, payee_code: w.payee_code, bailee_letter_name_expected: w.bailee_letter_name }, { at, sla_due_at: etInstant(addBusinessDays(etDate(at), 1, this.creditorCal), "17:00") });
    return { task, event };
  }
  /** `approveWarehouseWire`: the platform pre-check (byte comparison to the letterhead) blocks the approval task; the human `fnma_portal_operator` in SM's org approves (Pending → Active). */
  approveWarehouseWire(i: { wire_instruction_id: string; delivery_id: string; entered_letter_name: string; letterhead_text: string; operator_id: string; operator_role?: string; at?: string }): { check: ReturnType<typeof baileeNameCheck>; wire: WireInstruction; event: DomainEvent | null } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); const w = this.wires.get(i.wire_instruction_id); if (!w) throw new RangeError(`no wire instruction ${i.wire_instruction_id}`);
    const check = baileeNameCheck(i.entered_letter_name, i.letterhead_text);
    if (!check.matches) { this.emit(r, "wire.instruction.precheck_failed", { wire_instruction_id: w.wire_instruction_id, reason: check.reason, entered: i.entered_letter_name, letterhead_text: i.letterhead_text }, at); return { check, wire: w, event: null }; }
    if (i.operator_role !== undefined && i.operator_role !== "fnma_portal_operator") throw new DeliveryRefused("WAREHOUSE_WIRE_NEEDS_OPERATOR", "29.4 AI design: never approves a wire instruction (SM warehouse org) without a human fnma_portal_operator in that org", `role ${i.operator_role} cannot approve in SM's warehouse org`);
    const other = this.tasks.find((t) => t.delivery_id === r.delivery_id && t.org === "partner_seller_org" && t.operator_id === i.operator_id);
    if (other) throw new DeliveryRefused("SEGREGATION_OF_DUTIES", "29.4 task design: the person who submits the delivery does not approve the warehouse wire", `operator ${i.operator_id} already acted in the partner org`);
    const next: WireInstruction = { ...w, status: "active", bailee_letter_name: i.entered_letter_name, approved_by_warehouse_at: at, approved_by_operator_id: i.operator_id }; this.wires.set(w.wire_instruction_id, next);
    for (const t of this.tasks) if (t.delivery_id === r.delivery_id && t.kind === "warehouse_wire_approval" && t.outcome === null) { t.outcome = "completed"; t.completed_at = at; t.operator_id = i.operator_id; }
    const event = this.emit(r, "wire.instruction.approved", { wire_instruction_id: w.wire_instruction_id, payee_code: w.payee_code, bailee_letter_name: i.entered_letter_name, receiver_type: w.receiver_type, letter_type: w.letter_type, status: "active", approved_by_operator_id: i.operator_id }, at);
    return { check, wire: next, event };
  }
  /** C2-2-07: Form 482 (partner `officer` signs; dual approval with `funding_approver` on a beneficiary change) → three business days → payee code active. */
  form482(i: { delivery_id: string; op: "submitted" | "activated"; wire_instruction_id: string; form_482_document_id?: string | null; signed_by_role?: string | null; beneficiary_changed?: boolean; funding_approver_approved?: boolean; at?: string }): DomainEvent {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); const w = this.wires.get(i.wire_instruction_id); if (!w) throw new RangeError(`no wire instruction ${i.wire_instruction_id}`);
    if (i.op === "submitted") {
      if (i.signed_by_role !== "officer") throw new DeliveryRefused("FORM_482_OFFICER_SIGNS", "C2-2-07 / 29.4 capacity: the partner's officer signs Forms 482/360", "Form 482 must be signed by the partner officer");
      if (i.beneficiary_changed && !i.funding_approver_approved) throw new DeliveryRefused("FORM_482_DUAL_APPROVAL", "29.4 wire fraud control: dual approval (officer + funding_approver) for any Form 482 that changes a beneficiary account", "funding_approver approval missing");
      this.wires.set(w.wire_instruction_id, { ...w, status: "pending", form_482_document_id: i.form_482_document_id ?? w.form_482_document_id, form_482_signed_by: "officer" });
      return this.emit(r, "form_482.submitted", { wire_instruction_id: w.wire_instruction_id, payee_code: w.payee_code, form_482_document_id: i.form_482_document_id ?? null, submitted_on: etDate(at), active_expected_on: payeeCodeChangeDue(etDate(at), this.cal), account_details_transmitted: "never by e-mail" }, at);
    }
    this.wires.set(w.wire_instruction_id, { ...w, status: "active", fnma_confirmation_call_at: at });
    return this.emit(r, "payee_code.activated", { wire_instruction_id: w.wire_instruction_id, payee_code: w.payee_code, activated_on: etDate(at) }, at);
  }
  /** C2-2-03 security-breach chain: detection → immediate telephone notice → written confirmation within 24 clock hours; sev 1 to the `officer`. */
  securityBreach(i: { delivery_id: string; op: "detected" | "notified" | "confirmed"; detail: string; at?: string }): DomainEvent {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now();
    if (i.op === "detected") { if (this.d.escalations) this.d.escalations.open({ kind: "officer", loanId: r.loan_id, applicationId: r.application_id, severity: "sev1", payload: { task: "payee_security_breach", detail: i.detail, citation: "C2-2-03", written_confirmation_due_at: toIso(Date.parse(at) + 24 * 3_600_000), source: "origination" } }, this.actor); return this.emit(r, "payee.security_breach.detected", { detail: i.detail, detected_at: at, written_confirmation_due_at: toIso(Date.parse(at) + 24 * 3_600_000) }, at); }
    if (i.op === "notified") return this.emit(r, "fnma.breach.notified", { telephone: true, contact: "Fannie Mae Asset Acquisitions", detail: i.detail, notified_at: at }, at);
    return this.emit(r, "fnma.breach.confirmed", { written: true, detail: i.detail, confirmed_at: at }, at);
  }
  // ---- B8-8 / C1-2-04: the eNote path
  private enoteFacts(r: Delivery): EnoteTransferFacts {
    const ev = this.d.events.byLoan(r.loan_id); const ed = ev.some((e) => e.type === "enote.edelivered"); const req = [...ev].reverse().find((e) => e.type === "enote.transfer_of_control.requested");
    return { edelivered: ed, effective_date: req ? p(req).effective_date : undefined, request_date: req ? p(req).request_date : undefined, master_servicer_org_id: req ? p(req).master_servicer_org_id : undefined, sm_org_id: this.smOrgId, accepted: req ? p(req).accepted : undefined };
  }
  async requestEnoteTransfer(i: { delivery_id: string; op: "edeliver" | "transfer" | "completed"; effective_date?: PlainDate; at?: string; transfer_id?: string; partner_org_id?: string; fnma_org_id?: string; master_servicer_org_id?: string; delegatee_on_file?: boolean; document_ids?: readonly string[] }): Promise<{ event: DomainEvent; gate: { open: boolean; reason?: string }; accepted: boolean | null }> {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); need(r.note_form === "enote" && !!r.min, "an eNote delivery with a MIN");
    if (i.op === "edeliver") { const event = this.emit(r, "enote.edelivered", { min: r.min, edelivered_at: at, to: "fannie_mae_evault", document_ids: [...(i.document_ids ?? [])] }, at); return { event, gate: enoteTransferGate(this.enoteFacts(r)), accepted: null }; }
    if (i.op === "completed") { const event = this.emit(r, "enote.transfer_of_control.completed", { min: r.min, transfer_id: i.transfer_id ?? r.transfer_of_control_request_id, controller: "fannie_mae", location: "fannie_mae_evault", master_servicer_org_id: i.master_servicer_org_id ?? this.smOrgId, completed_at: at }, at); return { event, gate: enoteTransferGate(this.enoteFacts(r)), accepted: true }; }
    if (i.delegatee_on_file === false) throw new DeliveryRefused("ENOTE_CONTROLLER_CHANGE_NEEDS_DELEGATEE", "29.4 AI design: never changes the eNote Controller without the partner's authorization on file (Delegatee for Transfers)", "no Delegatee for Transfers authorization on file");
    const effective_date = i.effective_date ?? etDate(at); const request_date = etDate(at); const transfer_id = i.transfer_id ?? `toc-${randomUUID()}`;
    let accepted: boolean | null = null;
    if (this.d.registry) { const res = await this.d.registry.confirmTransfer({ transfer_id, min: r.min!, from_controller_org_id: i.partner_org_id ?? "partner", to_controller_org_id: i.fnma_org_id ?? "fannie_mae", effective_date, initiated_by_org_id: i.partner_org_id ?? "partner", kind: "control_and_location" }, this.smOrgId, at); accepted = res.accepted; }
    r.transfer_of_control_request_id = transfer_id;
    const event = this.emit(r, "enote.transfer_of_control.requested", { min: r.min, transfer_id, effective_date, request_date, same_day: effective_date === request_date, master_servicer_org_id: i.master_servicer_org_id ?? this.smOrgId, secured_party_release: "eNote Control Transfer and Custodial Agreement", accepted, kind: "control_and_location" }, at);
    return { event, gate: enoteTransferGate(this.enoteFacts(r)), accepted };
  }
  // ---- R3: purchase advice → purchase → reconciliation
  /** `ingestPurchaseAdvice` (API daily pull or the Connect report): idempotent by (fnma_loan_number, advice_date); sets purchase/acquisition dates, `purchased_and_funded`, and emits `loan.purchased` once per loan (30.1/5.x/25.4 consume). */
  ingestPurchaseAdvice(i: { delivery_id: string; advice: PurchaseAdviceInput; at?: string }): { advice: PurchaseAdviceRow; replayed: boolean; received: DomainEvent | null; purchased: DomainEvent | null } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); const a = i.advice;
    need(/^\d{10}$/.test(a.fnma_loan_number), "fnma_loan_number must be 10 digits"); need(!r.fnma_loan_number || r.fnma_loan_number === a.fnma_loan_number, `advice loan number ${a.fnma_loan_number} ≠ delivery ${r.fnma_loan_number}`);
    const key = adviceIdempotencyKey(a); const prior = this.advices.find((x) => x.delivery_id === r.delivery_id && adviceIdempotencyKey(x) === key);
    if (prior) return { advice: prior, replayed: true, received: null, purchased: null };
    const row: PurchaseAdviceRow = { ...a, purchase_advice_id: a.purchase_advice_id ?? randomUUID(), delivery_id: r.delivery_id, loan_id: r.loan_id, expected_net_proceeds_cents: null, expected_net_high_cents: null, variance_cents: null, reconciled_at: null, adjustment_request_due_at: addDays(a.advice_date, PPA_REQUEST_DAYS) };
    this.advices.push(row);
    r.purchase_advice_id = row.purchase_advice_id; r.purchase_date = a.purchase_date; r.acquisition_date = a.purchase_date; r.fnma_loan_number = a.fnma_loan_number;
    const received = this.emit(r, "purchase_advice.received", { purchase_advice_id: row.purchase_advice_id, fnma_loan_number: a.fnma_loan_number, advice_date: a.advice_date, purchase_date: a.purchase_date, source: "origination", advice_source: a.source, net_proceeds_cents: String(a.net_proceeds_cents), price: a.price, upb_cents: String(a.upb_cents), interest_adjustment_cents: String(a.interest_adjustment_cents), llpa_total_cents: String(a.llpa_total_cents), remittance_type: a.remittance_type, pass_through_rate: a.pass_through_rate, payee_code: a.payee_code, adjustment_request_due_on: row.adjustment_request_due_at, adjustment_request_due_at_on: rollBack(row.adjustment_request_due_at, this.cal) }, at);
    this.observe(r, "purchased_and_funded", null, a.source === "api" ? "purchase_advice_api" : "connect_report", at, { purchase_date: a.purchase_date });
    const already = this.d.events.byLoan(r.loan_id).some((e) => e.type === "loan.purchased");
    const purchased = already ? null : this.emit(r, "loan.purchased", { purchase_date: a.purchase_date, acquisition_date: a.purchase_date, fnma_loan_number: a.fnma_loan_number, purchase_advice_id: row.purchase_advice_id, remittance_type: a.remittance_type, pass_through_rate: a.pass_through_rate, commitment_id_fnma: r.commitment_id_fnma, date_of_transfer: a.purchase_date, investor: "fnma", fnma_purchase_date: a.purchase_date, seasoned: seasonedCheck(r.first_payment_date, a.purchase_date, a.purchase_date).seasoned, ppa_llpa_repricing_due_on: addMonths(a.purchase_date, PPA_LLPA_LOOKBACK_MONTHS) }, at);
    return { advice: row, replayed: false, received, purchased };
  }
  /** `reconcileProceeds`: the tie-out against the platform's expected range; 27.2 receives `purchase_advice.reconciled{variance_cents}`; a Fannie Mae-error variance goes to the `officer` as an adjustment-request package. */
  reconcile(i: { delivery_id: string; purchase_advice_id?: string; llpa_expected_cents: Cents; fees_expected_cents?: Cents; at?: string }): { reconciliation: Reconciliation; expected: ExpectedProceeds; event: DomainEvent; escalation_id: string | null } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now();
    const a = i.purchase_advice_id ? this.advices.find((x) => x.purchase_advice_id === i.purchase_advice_id) : this.advices.filter((x) => x.delivery_id === r.delivery_id).at(-1); if (!a) throw new RangeError("no purchase advice to reconcile");
    const expected = expectedProceeds({ upb_cents: r.upb_cents, price: r.commitment_price, pass_through_rate: r.pass_through_rate, purchase_date: a.purchase_date, lpi_due_date: r.lpi_due_date, remittance_type: r.remittance_type, llpa_total_cents: i.llpa_expected_cents, ...(i.fees_expected_cents !== undefined ? { fees_cents: i.fees_expected_cents } : {}) });
    const rec = reconcileProceeds(a, expected, this.cal);
    a.expected_net_proceeds_cents = expected.expected_net_cents; a.expected_net_high_cents = expected.expected_net_high_cents; a.variance_cents = rec.variance_cents; a.reconciled_at = rec.reconciled ? at : null;
    const event = this.emit(r, "purchase_advice.reconciled", { purchase_advice_id: a.purchase_advice_id, variance_cents: String(rec.variance_cents), reconciled: rec.reconciled, day_count: rec.day_count, expected_net_low_cents: String(expected.expected_net_low_cents), expected_net_high_cents: String(expected.expected_net_high_cents), net_proceeds_cents: String(a.net_proceeds_cents), decomposition: rec.decomposition.map((d) => ({ ...d, cents: String(d.cents) })), fnma_error_indicated: rec.fnma_error_indicated, package_due_on: rec.package_due_on, adjustment_request_due_on: rec.adjustment_request_due_on, consumers: ["27.2"] }, at);
    let escalation_id: string | null = null;
    if (rec.officer_package && this.d.escalations) escalation_id = this.d.escalations.open({ kind: "officer", loanId: r.loan_id, applicationId: r.application_id, payload: { task: "purchase_advice_adjustment_request", purchase_advice_id: a.purchase_advice_id, variance_cents: String(rec.variance_cents), decomposition: rec.decomposition.map((d) => ({ ...d, cents: String(d.cents) })), package_due_on: rec.package_due_on, adjustment_request_due_on: rec.adjustment_request_due_on, adjustment_request_due_at_on: rec.adjustment_request_due_at_on, clock: "FNMA_C2_2_05_PPA_REQUEST_30 (27.2)", source: "origination" } }, this.actor).id;
    return { reconciliation: rec, expected, event, escalation_id };
  }
  /** T14: two consecutive business days without an advice after `purchase_ready` → the Connect report download task; the PURCHASE_EXPECTED breach check task. */
  adviceLag(i: { delivery_id: string; today: PlainDate; at?: string }): { check: ReturnType<typeof adviceLagCheck>; task: OperatorTask | null; breach_check: OperatorTask | null } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); need(!!r.purchase_ready_at, "no purchase_ready_at yet");
    const check = adviceLagCheck(r.purchase_ready_at!, i.today, this.advices.some((a) => a.delivery_id === r.delivery_id), this.cal);
    if (!check.connect_report_task) return { check, task: null, breach_check: null };
    const w = this.wire(r.wire_instruction_id);
    const task = this.task(r, "connect_purchase_advice_download", "partner_seller_org", { report: "Fannie Mae Connect Whole Loan Purchase Advice", fnma_loan_number: r.fnma_loan_number, business_days_without_advice: check.business_days_without_advice }, { at });
    const breach_check = this.task(r, "purchase_expected_check", "partner_seller_org", { timer: "FNMA_C2_2_04_PURCHASE_EXPECTED_1BD", checks: check.checks, payee_code_active: w?.status === "active", no_purchase_error: r.loan_delivery_status !== "purchase_error", commitment_valid: r.commitment_closed && r.commitment_expires_on >= i.today, commitment_id_fnma: r.commitment_id_fnma }, { at });
    return { check, task, breach_check };
  }
  // ---- R8: PPAs and LQC
  openPpa(i: { delivery_id: string; discovered_at: string; attributes: readonly PpaAttribute[]; expected_llpa_delta_cents: Cents; initiated_by?: "seller" | "fnma_lqc"; at?: string }): { ppa: PostPurchaseAdjustment; event: DomainEvent } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); need(!!r.acquisition_date && !!r.fnma_loan_number, "a purchased loan (acquisition_date, fnma_loan_number)");
    const plan = preparePpa({ fnma_loan_number: r.fnma_loan_number!, acquisition_date: r.acquisition_date!, discovered_on: etDate(i.discovered_at), attributes: i.attributes, expected_llpa_delta_cents: i.expected_llpa_delta_cents }, this.cal);
    const ppa: PostPurchaseAdjustment = { ppa_id: randomUUID(), loan_id: r.loan_id, fnma_loan_number: r.fnma_loan_number!, initiated_by: i.initiated_by ?? "seller", discovered_at: i.discovered_at, attributes: i.attributes, lsdu_submitted_at: null, ppa_form_document_id: `doc-ppa-${r.fnma_loan_number}`, expected_llpa_delta_cents: i.expected_llpa_delta_cents, notification_report_document_id: null, llpa_draft_or_refund_cents: null, settled_at: null, status: "open", repricing_eligible: plan.repricing_eligible, plan };
    this.ppas.push(ppa);
    const event = this.emit(r, "ppa.opened", { ppa_id: ppa.ppa_id, fnma_loan_number: ppa.fnma_loan_number, initiated_by: ppa.initiated_by, attributes: i.attributes.map((a) => a.attribute), repricing_eligible: plan.repricing_eligible, repricing_due_on: plan.repricing_due_on, expected_llpa_delta_cents: String(i.expected_llpa_delta_cents), llpa_draft_expected: plan.llpa_draft_expected, csv_rows: plan.csv_rows, document_names: plan.document_names }, at);
    return { ppa, event };
  }
  /** The LSDU upload is an operator act (money moves only with the partner `officer` where a draft results); `ppa.requested{channel=lsdu}` is 27.2's spelling, emitted here as the platform record; `ppa.resolved` from the Connect notification report. */
  ppaStatus(i: { delivery_id: string; ppa_id: string; op: "submitted" | "processed" | "closed" | "declined"; operator_id?: string; officer_approval_id?: string | null; notification_report_document_id?: string | null; llpa_draft_or_refund_cents?: Cents; at?: string }): { ppa: PostPurchaseAdjustment; event: DomainEvent; processing_expected_on: PlainDate | null } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); const ppa = this.ppas.find((x) => x.ppa_id === i.ppa_id); if (!ppa) throw new RangeError(`no PPA ${i.ppa_id}`);
    if (i.op === "submitted") {
      if (ppa.plan.llpa_draft_expected && !i.officer_approval_id) throw new DeliveryRefused("PPA_NEEDS_OFFICER", "29.4 AI design: never files a PPA … without the partner officer's approval where money moves", "an LLPA draft/refund is expected — officer approval escalation required");
      ppa.status = "submitted"; ppa.lsdu_submitted_at = at; const exp = ppaProcessingExpected(etDate(at), this.cal);
      const event = this.emit(r, "ppa.requested", { ppa_id: ppa.ppa_id, kind: "data_correction", channel: "lsdu", llpa_relevant: ppa.plan.llpa_draft_expected, submitted_on: etDate(at), processing_expected_on: exp, operator_id: i.operator_id ?? null, officer_approval_id: i.officer_approval_id ?? null, fnma_loan_number: ppa.fnma_loan_number }, at);
      return { ppa, event, processing_expected_on: exp };
    }
    if (i.op === "processed") { ppa.status = "processed"; ppa.notification_report_document_id = i.notification_report_document_id ?? null; ppa.llpa_draft_or_refund_cents = i.llpa_draft_or_refund_cents ?? 0n; const event = this.emit(r, "ppa.resolved", { ppa_id: ppa.ppa_id, outcome: "processed", llpa_draft_or_refund_cents: String(ppa.llpa_draft_or_refund_cents), notification_report_document_id: ppa.notification_report_document_id, consumers: ["27.2"] }, at); return { ppa, event, processing_expected_on: null }; }
    ppa.status = i.op; if (i.op === "closed") ppa.settled_at = at;
    return { ppa, event: this.emit(r, "ppa.resolved", { ppa_id: ppa.ppa_id, outcome: i.op, consumers: ["27.2"] }, at), processing_expected_on: null };
  }
  lqc(i: { delivery_id: string; op: "requested" | "responded"; request_id: string; stated_due_on?: PlainDate | null; document_ids?: readonly string[]; at?: string }): DomainEvent {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now();
    if (i.op === "requested") return this.emit(r, "lqc.data_validation.requested", { request_id: i.request_id, notified_on: etDate(at), response_due_on: lqcResponseDue(etDate(at), i.stated_due_on ?? null), case_owner: "28.2" }, at);
    return this.emit(r, "lqc.data_validation.responded", { request_id: i.request_id, document_ids: [...(i.document_ids ?? [])], responded_on: etDate(at) }, at);
  }
  // ---- R9: remedy execution
  remedy(i: { delivery_id: string; repurchase_id: string; demand_on: PlainDate; paid_on: PlainDate | null; officer_approval_document_id: string | null; liquidated?: boolean; arm_modification_feature?: boolean; flags?: Record<string, unknown>; at?: string }): { plan: RemedyPlan; collateral: DomainEvent | null; lar: ReturnType<typeof processRepurchase> | null; readvance: DomainEvent | null } {
    const r = this.get(i.delivery_id); const at = i.at ?? this.now(); need(!!r.purchase_date, "a purchased loan");
    const plan = remedyPlan({ demand_on: i.demand_on, paid_on: i.paid_on, note_form: r.note_form, ...(i.liquidated !== undefined ? { liquidated: i.liquidated } : {}), ...(i.arm_modification_feature !== undefined ? { arm_modification_feature: i.arm_modification_feature } : {}), ...(i.flags ? { flags: i.flags } : {}) });
    if (!i.paid_on) return { plan, collateral: null, lar: null, readvance: null };
    if (!i.officer_approval_document_id) throw new DeliveryRefused("REMEDY_PAYMENT_NEEDS_OFFICER", "29.4 AI design: never files a … remedy payment without the partner officer's approval", "the partner officer authorizes the repurchase payment (A2-3.2-01)");
    const collateral = plan.collateral_return.kind === "none" ? null : plan.collateral_return.kind === "enote_transfer_of_control"
      ? this.emit(r, "enote.transfer_of_control.requested", { min: r.min, transfer_id: `toc-return-${i.repurchase_id}`, effective_date: i.paid_on, request_date: i.paid_on, same_day: true, direction: "fannie_mae_to_partner", reason: "repurchase", accepted: null }, at)
      : this.emit(r, "remedy.collateral_return.requested", { kind: plan.collateral_return.kind, form: plan.collateral_return.form, to: plan.collateral_return.to, repurchase_id: i.repurchase_id, fnma_loan_number: r.fnma_loan_number }, at);
    const rt: "AA" | "SA" | "SS" = r.remittance_type === "actual_actual" ? "AA" : r.remittance_type === "scheduled_actual" ? "SA" : "SS";
    const lar = processRepurchase({ events: this.d.events, actor: this.actor, now: at }, { repurchase_id: i.repurchase_id, loan_id: r.loan_id, processed_at_ms: Date.parse(at), approval_document_id: i.officer_approval_document_id, arm_modification_feature: i.arm_modification_feature ?? false, effective_date: i.paid_on, remittance_type: rt });
    const readvance = plan.readvance_allowed ? null : this.emit(r, "remedy.readvance.refused", { repurchase_id: i.repurchase_id, reason: plan.readvance_refusal, flag: "warehouse.repurchase_advance" }, at);
    return { plan, collateral, lar, readvance };
  }
  /** LL-2026-04: the plan/observation/reconciliation as one `agent_decisions` record. */
  decisionRecord(deliveryId: string, rationale: string, confidence = 0.95): DecisionRecord29_4 {
    const r = this.get(deliveryId); const w = this.wire(r.wire_instruction_id); const win = lpiWindow(r.first_payment_date, null); const dl = custodianReceiptDeadline(r.commitment_expires_on, this.cal);
    const plan = r.frozen_at ? receiptPlan(r.frozen_at, r.commitment_expires_on, this.cal) : null;
    const adv = this.advices.filter((a) => a.delivery_id === r.delivery_id).at(-1); const recEv = [...this.d.events.byLoan(r.loan_id)].reverse().find((e) => e.type === "purchase_advice.reconciled");
    return { delivery_id: r.delivery_id, package_id: r.package_id, sha256: r.package_sha256, planned_dates: { submit: plan?.expected_submit_on ?? null, ship: plan?.expected_submit_on ?? null, receipt: plan?.expected_receipt_on ?? null, certification: r.expected_certification_date, purchase: r.expected_purchase_date },
      deadlines: { commitment_expiry: r.commitment_expires_on, custodian_receipt: dl.due_at, lpi_45: win.delivery_lpi_due, loan_age_6m: win.loan_age_due_on, seasoned: win.seasoned_on, adjustment_request: adv?.adjustment_request_due_at ?? null },
      wire: w ? { payee_code: w.payee_code, receiver_type: w.receiver_type, letter_type: w.letter_type, bailee_letter_name: w.bailee_letter_name, status: w.status } : null, evidence_ids: this.tasks.filter((t) => t.delivery_id === r.delivery_id).flatMap((t) => t.evidence_document_ids), observed_statuses: this.observed.filter((o) => o.delivery_id === r.delivery_id).map(({ status, source, at }) => ({ status, source, at })),
      variances: recEv ? ((p(recEv).decomposition as VarianceComponent[] | undefined) ?? []) : [], relief_evaluation: this.relief.filter((x) => x.loan_id === r.loan_id).map((x) => x.evaluation), rationale, confidence, rule_set_versions: RULE_SET_VERSIONS_29_4, model_version: MODEL_VERSION_29_4, prompt_version: PROMPT_VERSION_29_4 };
  }
}
export const plainDate29_4 = plainDate; export { endOfMonth };
