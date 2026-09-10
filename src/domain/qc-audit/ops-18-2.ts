/**
 * §18.2 exam-module rules over the shared calculators in ./ops.ts and ./mora.ts — one small pure function per
 * rule / T-id, each emitting the event the process's timer rows are armed or satisfied by:
 *   rule 1 / T1  scopeNotice            notice → examiner contact + notice + one `exam.request.received` per loan + `exam.scoped`; rule-4 clocks
 *   rule 2 / T2  reviewFileQa           A2-4-01 package QA checklist behind `documents.compile_pdf`; foreclosureLogFromExhibit = the E-3.2-15 comparison
 *   rule 5 / T3  examDeadlineSweep      the daily job that fires the 50 % / 80 % warnings and drafts the extension request (extensionRequest)
 *   rule 3 / T4  privilegeScreen        counsel work product excluded + privilege log; productionCompleteness proves nothing Fannie Mae owns is withheld
 *   rule 6 / T5  examFindingReceived    finding → `qc_finding` case, CAPA 15 BD, EXAM-RESP-v1 draft citing records
 *   5.x  / T6    examRemedyDemand       remedy demand → A1-3-02 ladder, exam `disputed` + repurchase case link
 *   rule 4 / T7  examRequestReceived    stated deadline (business days over a holiday) → `EXAM_REQUEST_DUE_AS_STATED`, officer gate ≥1 BD before
 *   hold / T8    retentionPurge         `SM_EXAM_LITIGATION_HOLD` feeds `legal_hold` into the platform's 17.3 retention gate; only counsel releases
 *   guard / T9   responseDraftReview    legal conclusion → `attorney` before `officer`; releaseGate = officer signature rules;
 *                                       counselReviewRecorded = the `attorney` act that lifts the counsel-first route
 * Event-store paths (the Inputs/Integrations paragraphs) — every event a 18.2 registry row is armed by or satisfied
 * with is appended here or by the bus tools in src/app/tools/section18-2.ts, never only by the test harness:
 *   ingestExamNotice        LQC e-mail / mailroom / partner forward → `exam.contact.received`, `exam.notice.received{due_at}`, per-loan `exam.request.received`, `exam.scoped`
 *   ingestExamRequest       a letter's request item → `exam.request.received{due_at}`
 *   recordInternalNotification  partner + officer notified → `exam.notice.acknowledged{partner_notified, officer_notified}`
 *   recordPackageApproval   the `officer` actor's approval of the package on record → `exam.package.approved{approved_by_role=officer, manifest_sha256}` (documents.compile_pdf op=approve)
 *   recordSubmission        the `fnma_portal_operator`'s confirmation → `exam.request.submitted` (open count derived from the store, never remembered by the caller)
 *   ingestExamFinding       examiner finding → `exam.finding.received{response_due_stated, qc_finding_case_id}` (cases.create{qc_finding})
 *   recordRemediationPlanApproval  the `officer` actor's CAPA plan → `exam.remediation_plan.approved{qc_finding_case_id, approved_by_role=officer}`
 *   recordCounselReview / recordFindingResponse  the `attorney` act → `exam.response.counsel_reviewed{draft_hash}`; the officer's release → `exam.finding.responded{response_document_id}` (letters.render)
 *   ingestRemedyDemand      remedy demand with the report → `exam.remedy_demand.received` + the 5.6 intake's `repurchase.demand.received`
 *   ingestLitigationNotice  subpoena / discovery notice → `exam.notice.received{source∈{litigation_discovery, subpoena}}`
 * Clocks: examClocks18_2 (rule 4 plus the officer-review row, counted in business days — the shared mora.examClocks
 * counts the officer gate in calendar days, see the note there). packageReviewWindow backs the
 * `SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD` row: its deadline half is the computed anchor `approve_by` stamped on
 * `exam.package.assembled` (offset 0, so TimerEngine.evaluate breaches it), its not-before half (`review_opens_on`)
 * is asserted by officerApproval and the bus guardrails. The litigation-hold gate backs the evaluator in ./evaluators-18-2.ts.
 */
import { type PlainDate, addDays, daysBetween, isWeekend } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, businessDaysBetween, rollBack, servicer, fannieEt } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { type Actor, type DomainEvent, type EventStore, SYSTEM } from "../../kernel/events/index.ts";
import { type ExamClocks, extensionRequestNeeded, findingCapaDue, legalConclusionGuardrail, privilegeExcluded } from "./mora.ts";
import { REVIEW_FILE_SECTIONS, type QcEscalation, type ReviewFile, type ReviewFileInput, manifestMatches, remedyDemandReceived, sha256 } from "./ops.ts";
import { type Delay, allowable as e3215Allowable, creditDelays, trackingStatus } from "../foreclosure/timeframes.ts";
import { EVALUATORS_17_3 } from "../transfers/evaluators-17-3.ts";
import { ingestRepurchaseDemand } from "../investor/ops-5-6.ts";

const A2_4_01 = "Servicing Guide A2-4-01: the review file must reach Fannie Mae within 30 days after notification (or the shorter/longer period stated)";
const A2_4_1_02 = "Selling Guide A2-4.1-02: loan records are Fannie Mae's property — nothing Fannie Mae owns is withheld or redacted from a production";
const BASELINE_8_3 = "baseline §8 item 3: MORA/exam responses are officer certifications — no communication leaves without `officer` signature";

// ================================================================ clocks (rule 4 + the officer-review row)
export interface ExamClocks18_2 extends ExamClocks {
  /** Approval must land ≥1 BD before `due` (examiner's calendar): `due − 1 BD`. */
  readonly approve_by: PlainDate;
  readonly officer_business_days: 3;
  readonly review_calendar: Calendar["unit"];
  readonly officer_calendar: Calendar["unit"];
}
/**
 * Rule 4 — `due = notification + 30 CD` (A2-4-01) unless the notice states otherwise; a weekend/Fannie Mae-holiday due
 * date targets the prior business day (no roll-forward). The officer-review row on business days: approval ≥1 BD
 * before `due` (`approve_by`, examiner's calendar) and the officer has 3 BD, so the package must be assembled by
 * `approve_by − 3 BD` on the officer's (servicer) calendar — the `officer_gate`. Warnings at 50 % / 80 % of the span.
 * The shared mora.examClocks puts the gate 3 *calendar* days before the target (the spec's worked figure 2026-11-10,
 * which counts Veterans Day 2026-11-11 as a business day); counted correctly the T1 gate is Mon 2026-11-09.
 */
export function examClocks18_2(notifiedOn: PlainDate, statedDue: PlainDate | null = null, cal: Calendar = fannieEt, officerCal: Calendar = servicer): ExamClocks18_2 {
  const due = statedDue ?? addDays(notifiedOn, 30);
  const internal_target = rollBack(due, cal);
  const approve_by = addBusinessDays(due, -1, cal);
  const officer_gate = addBusinessDays(approve_by, -3, officerCal);
  const span = Math.max(1, daysBetween(notifiedOn, due));
  return { due, internal_target, approve_by, officer_gate, warn_50: addDays(notifiedOn, Math.floor(span * 0.5)), warn_80: addDays(notifiedOn, Math.floor(span * 0.8)), officer_business_days: 3, review_calendar: cal.unit, officer_calendar: officerCal.unit };
}

// ================================================================ intake and scoping (rule 1, rule 4; T1)
export type ExamSource = "fnma_lqc" | "fnma_letter" | "fnma_scr" | "cfpb" | "state" | "multistate" | "partner" | "investor" | "rating_agency" | "litigation_discovery" | "subpoena";
export type ReviewType = "servicing_review" | "origination_review" | "compliance_review" | "information_request" | "discovery";
export type ContactChannel = "lqc_email" | "letter" | "phone" | "portal" | "partner_forward" | "email";
export interface ExamNotice {
  readonly exam_id: string; readonly source: ExamSource; readonly review_type: ReviewType; readonly examiner: string;
  readonly subject_entity: "partner" | "supermortgage" | "both"; readonly notified_on: PlainDate; readonly received_on: PlainDate;
  readonly stated_due: PlainDate | null; readonly fnma_loan_numbers: readonly string[]; readonly taxonomy_nodes: readonly string[]; readonly notice_document_id: string;
}
export interface ExamNoticeEvent { readonly type: "exam.notice.received"; readonly exam_id: string; readonly source: ExamSource; readonly review_type: ReviewType; readonly notified_on: PlainDate; readonly received_at: PlainDate; readonly stated_due: PlainDate | null; readonly due_at: PlainDate | null; readonly internal_target_at: PlainDate | null; readonly document_id: string; }
export interface ExamContactEvent { readonly type: "exam.contact.received"; readonly exam_id: string | null; readonly source: ExamSource; readonly channel: ContactChannel; readonly received_at: PlainDate; readonly summary: string; }
export interface ExamRequestReceivedEvent { readonly type: "exam.request.received"; readonly exam_id: string; readonly request_no: string; readonly source: ExamSource; readonly loan_id: string | null; readonly due_at: PlainDate; readonly received_at: PlainDate; }
export interface ExamScopedEvent { readonly type: "exam.scoped"; readonly exam_id: string; readonly request_count: number; readonly scoped_at: PlainDate; }
/**
 * `exam.notice.received` as the spec's Inputs paragraph shapes it: `source ∈ {fnma_lqc, …}`, the document, stated
 * deadlines — and `due_at`, the rule-4 date the `FNMA_A2401_REVIEW_FILE_30` row anchors on (its "`due_at` override":
 * notification + 30 CD, or the shorter/longer period Fannie Mae states).
 */
export function noticeEvent(n: ExamNotice, cal: Calendar = fannieEt): ExamNoticeEvent {
  const c = examClocks18_2(n.notified_on, n.stated_due, cal);
  return { type: "exam.notice.received", exam_id: n.exam_id, source: n.source, review_type: n.review_type, notified_on: n.notified_on, received_at: n.received_on, stated_due: n.stated_due, due_at: c.due, internal_target_at: c.internal_target, document_id: n.notice_document_id };
}
/** A notice is an examiner contact: the same `exam.contact.received` every other intake path emits (arms `SM_EXAM_INTERNAL_NOTIFY_2BD`). */
export function noticeContactEvent(n: ExamNotice): ExamContactEvent {
  const channel: ContactChannel = n.source === "fnma_lqc" ? "lqc_email" : n.source === "partner" ? "partner_forward" : "letter";
  return { type: "exam.contact.received", exam_id: n.exam_id, source: n.source, channel, received_at: n.received_on, summary: `${n.review_type.replace(/_/g, " ")} notice from ${n.examiner} (${n.notice_document_id})` };
}

export interface ExamRequestRow {
  readonly exam_id: string; readonly request_no: string; readonly text: string; readonly taxonomy_nodes: readonly string[]; readonly loan_ids: readonly string[]; readonly fnma_loan_number: string;
  readonly due_at: PlainDate; readonly internal_target_at: PlainDate; readonly warn_50_at: PlainDate; readonly warn_80_at: PlainDate; readonly officer_gate_at: PlainDate; readonly approve_by_at: PlainDate;
  readonly extension_requested_at: null; readonly extension_granted_until: null; readonly package_document_id: null; readonly submitted_at: null; readonly submission_evidence: null; readonly status: "open";
}
export type ScopedExamEvent = ExamContactEvent | ExamNoticeEvent | ExamRequestReceivedEvent | ExamScopedEvent;
export interface ScopedExam {
  readonly clocks: ExamClocks18_2;
  readonly exam: { id: string; status: "scoped"; scope: { loan_ids: string[]; fnma_loan_numbers: string[]; taxonomy_nodes: string[] } };
  readonly requests: ExamRequestRow[];
  readonly unknown_loan_numbers: string[];
  readonly examiner_query: { kind: "unknown_loan_numbers"; to: string; numbers: string[]; drafted_on: PlainDate; signature: "officer"; citation: string } | null;
  readonly escalations: QcEscalation[];
  readonly timers: { code: "FNMA_A2401_REVIEW_FILE_30" | "SM_EXAM_SCOPE_5BD" | "SM_EXAM_INTERNAL_NOTIFY_2BD" | "EXAM_REQUEST_DUE_AS_STATED"; anchor: PlainDate; due: PlainDate; warn_50?: PlainDate; warn_80?: PlainDate; instances?: number }[];
  readonly contact_event: ExamContactEvent;
  readonly notice_event: ExamNoticeEvent;
  readonly request_events: ExamRequestReceivedEvent[];
  readonly scoped_event: ExamScopedEvent;
  /** In emission order: contact, notice, one request per loan, scoped. */
  readonly events: readonly ScopedExamEvent[];
}
/**
 * Rule 1 — scoping: the notice is parsed into one `exam_requests` row per loan (taxonomy nodes and loan lists); loans
 * resolve by Fannie Mae loan number → `loans.fnma_loan_number`; unknown numbers → immediate query to the examiner
 * drafted for officer signature. Rule 4 — every row carries `due_at = notification + 30 CD` (or the stated date), the
 * prior-business-day internal target, the 50 %/80 % warnings, the approve-by date and the officer gate. Events: the
 * notice is an examiner contact (`SM_EXAM_INTERNAL_NOTIFY_2BD`), the notice itself (`FNMA_A2401_REVIEW_FILE_30` on
 * `due_at`, `SM_EXAM_SCOPE_5BD`), one `exam.request.received` per request item (`EXAM_REQUEST_DUE_AS_STATED`, per
 * loan) and the transition received → scoped (`exam.scoped` satisfies the scope clock).
 */
export function scopeNotice(i: { notice: ExamNotice; loans: readonly { loan_id: string; fnma_loan_number: string }[]; scoped_on: PlainDate; cal?: Calendar; officer_cal?: Calendar }): ScopedExam {
  const n = i.notice; const cal = i.cal ?? fannieEt; const officerCal = i.officer_cal ?? servicer;
  const clocks = examClocks18_2(n.notified_on, n.stated_due, cal, officerCal);
  const byNumber = new Map(i.loans.map((l) => [l.fnma_loan_number, l.loan_id] as const));
  const unknown = n.fnma_loan_numbers.filter((x) => !byNumber.has(x));
  const requests: ExamRequestRow[] = n.fnma_loan_numbers.filter((x) => byNumber.has(x)).map((num, k) => ({
    exam_id: n.exam_id, request_no: `R-${String(k + 1).padStart(3, "0")}`, text: `A2-4-01 ${n.review_type.replace("_", " ")} file — Fannie Mae loan ${num}`, taxonomy_nodes: [...n.taxonomy_nodes], loan_ids: [byNumber.get(num)!], fnma_loan_number: num,
    due_at: clocks.due, internal_target_at: clocks.internal_target, warn_50_at: clocks.warn_50, warn_80_at: clocks.warn_80, officer_gate_at: clocks.officer_gate, approve_by_at: clocks.approve_by,
    extension_requested_at: null, extension_granted_until: null, package_document_id: null, submitted_at: null, submission_evidence: null, status: "open",
  }));
  const query = unknown.length ? { kind: "unknown_loan_numbers" as const, to: n.examiner, numbers: unknown, drafted_on: i.scoped_on, signature: "officer" as const, citation: "rule 1: unknown Fannie Mae loan numbers → immediate query to the examiner drafted for officer signature" } : null;
  const timers: ScopedExam["timers"] = [
    ...(n.source === "fnma_lqc" && n.review_type === "servicing_review" ? [{ code: "FNMA_A2401_REVIEW_FILE_30" as const, anchor: n.notified_on, due: clocks.due, warn_50: clocks.warn_50, warn_80: clocks.warn_80 }] : []),
    { code: "SM_EXAM_INTERNAL_NOTIFY_2BD", anchor: n.received_on, due: addBusinessDays(n.received_on, 2, officerCal) },
    { code: "SM_EXAM_SCOPE_5BD", anchor: n.received_on, due: addBusinessDays(n.received_on, 5, officerCal) },
    ...(requests.length ? [{ code: "EXAM_REQUEST_DUE_AS_STATED" as const, anchor: clocks.due, due: clocks.due, warn_50: clocks.warn_50, warn_80: clocks.warn_80, instances: requests.length }] : []),
  ];
  const contact_event = noticeContactEvent(n);
  const notice_event = noticeEvent(n, cal);
  const request_events: ExamRequestReceivedEvent[] = requests.map((r) => ({ type: "exam.request.received", exam_id: n.exam_id, request_no: r.request_no, source: n.source, loan_id: r.loan_ids[0]!, due_at: r.due_at, received_at: n.received_on }));
  const scoped_event: ExamScopedEvent = { type: "exam.scoped", exam_id: n.exam_id, request_count: requests.length, scoped_at: i.scoped_on };
  return {
    clocks,
    exam: { id: n.exam_id, status: "scoped", scope: { loan_ids: requests.map((r) => r.loan_ids[0]!), fnma_loan_numbers: [...n.fnma_loan_numbers], taxonomy_nodes: [...n.taxonomy_nodes] } },
    requests, unknown_loan_numbers: unknown, examiner_query: query,
    escalations: query ? [{ kind: "officer", severity: "sev3", reason: `sign the query to ${n.examiner}: Fannie Mae loan number(s) ${unknown.join(", ")} not on the platform (rule 1)`, due: i.scoped_on }] : [],
    timers,
    contact_event, notice_event, request_events, scoped_event,
    events: [contact_event, notice_event, ...request_events, scoped_event],
  };
}

/** `SM_EXAM_INTERNAL_NOTIFY_2BD`: any examiner contact (phone, portal, e-mail, partner forward) → partner + officer notified within 2 business days (exam response protocol). */
export function examinerContact(i: { exam_id: string | null; source: ExamSource; contacted_on: PlainDate; channel: ContactChannel; summary: string; cal?: Calendar }): { event: ExamContactEvent; notify_by: PlainDate; recipients: ["partner", "officer"] } {
  return { event: { type: "exam.contact.received", exam_id: i.exam_id, source: i.source, channel: i.channel, received_at: i.contacted_on, summary: i.summary }, notify_by: addBusinessDays(i.contacted_on, 2, i.cal ?? servicer), recipients: ["partner", "officer"] };
}
/** The satisfying `exam.notice.acknowledged` exists only once both the partner and the officer are notified. */
export function internalNotification(i: { exam_id: string; partner_notified_on: PlainDate | null; officer_notified_on: PlainDate | null }): { complete: boolean; event: { type: "exam.notice.acknowledged"; exam_id: string; partner_notified: true; officer_notified: true; acknowledged_at: PlainDate } | null; missing: ("partner" | "officer")[] } {
  const missing: ("partner" | "officer")[] = [...(i.partner_notified_on ? [] : ["partner" as const]), ...(i.officer_notified_on ? [] : ["officer" as const])];
  if (missing.length) return { complete: false, event: null, missing };
  const at = i.partner_notified_on! > i.officer_notified_on! ? i.partner_notified_on! : i.officer_notified_on!;
  return { complete: true, event: { type: "exam.notice.acknowledged", exam_id: i.exam_id, partner_notified: true, officer_notified: true, acknowledged_at: at }, missing: [] };
}
/**
 * Event-store path (exam response protocol): the internal notification of an examiner contact is recorded against a
 * contact on record — `exam.contact.received` for the exam — and `exam.notice.acknowledged{partner_notified=true,
 * officer_notified=true}` is appended only once both the partner and the officer are notified (never on a partial
 * notification, never for an exam the store holds no contact for).
 */
export function recordInternalNotification(events: EventStore, i: { exam_id: string; partner_notified_on: PlainDate | null; officer_notified_on: PlainDate | null }, actor: Actor = SYSTEM): { event: DomainEvent | null; missing: ("partner" | "officer")[]; refusal: string | null } {
  if (!i.exam_id) throw new RangeError("exam_id is required");
  for (const [k, v] of [["partner_notified_on", i.partner_notified_on], ["officer_notified_on", i.officer_notified_on]] as const) if (v !== null && !isDate(v)) throw new RangeError(`${k} must be a PlainDate or null`);
  const contact = events.ofType("exam.contact.received").find((e) => e.payload.exam_id === i.exam_id);
  if (!contact) return { event: null, missing: [], refusal: `no \`exam.contact.received\` on record for ${i.exam_id} — the notification acknowledges a contact the store holds` };
  const r = internalNotification(i);
  if (!r.event) return { event: null, missing: r.missing, refusal: `internal notification incomplete: ${r.missing.join(", ")} not yet notified` };
  return { event: appendExamEvent(events, r.event, actor), missing: [], refusal: null };
}

// ================================================================ stated deadlines (rule 4; T7)
/**
 * A letter that states its deadline in business days ("within 10 business days") is resolved on the examiner's
 * calendar: weekends and the calendar's holidays do not count. The weekday-only count is reported alongside so a
 * hand count that ignored a holiday is visibly one day early.
 */
export function statedBusinessDayDeadline(i: { received_on: PlainDate; business_days: number; cal: Calendar }): { stated_due: PlainDate; holidays_skipped: PlainDate[]; weekend_days_skipped: number; weekday_only_due: PlainDate } {
  let d = i.received_on; let counted = 0; let weekdays = 0; let weekendSkipped = 0; const holidays: PlainDate[] = []; let weekdayOnly: PlainDate = i.received_on;
  while (counted < i.business_days) {
    d = addDays(d, 1);
    if (isWeekend(d)) { weekendSkipped++; continue; }
    weekdays++; if (weekdays === i.business_days) weekdayOnly = d;
    if (i.cal.isBusinessDay(d)) counted++; else holidays.push(d);
  }
  return { stated_due: d, holidays_skipped: holidays, weekend_days_skipped: weekendSkipped, weekday_only_due: weekdayOnly };
}
export interface ExamRequestReceived {
  readonly timer: { code: "EXAM_REQUEST_DUE_AS_STATED"; anchor_field: "due_at"; anchor: PlainDate; due: PlainDate; basis: "as_stated"; warn_50: PlainDate; warn_80: PlainDate };
  readonly clocks: ExamClocks18_2;
  readonly officer_gate: { at: PlainDate; approve_by: PlainDate; latest_allowed: PlainDate; business_days_before_due: number; ok: boolean };
  readonly event: ExamRequestReceivedEvent;
}
/** `exam.request.received` → `EXAM_REQUEST_DUE_AS_STATED` uses the letter's stated date (anchor `due_at`, offset 0); approval ≥1 BD before it, the officer gate 3 BD before that. */
export function examRequestReceived(i: { exam_id: string; request_no: string; source: ExamSource; received_on: PlainDate; stated_due: PlainDate; loan_id?: string | null; cal: Calendar; officer_cal?: Calendar }): ExamRequestReceived {
  const clocks = examClocks18_2(i.received_on, i.stated_due, i.cal, i.officer_cal ?? servicer);
  const latest = addBusinessDays(i.stated_due, -1, i.cal);
  return {
    timer: { code: "EXAM_REQUEST_DUE_AS_STATED", anchor_field: "due_at", anchor: i.stated_due, due: i.stated_due, basis: "as_stated", warn_50: clocks.warn_50, warn_80: clocks.warn_80 },
    clocks,
    officer_gate: { at: clocks.officer_gate, approve_by: clocks.approve_by, latest_allowed: latest, business_days_before_due: businessDaysBetween(clocks.officer_gate, i.stated_due, i.cal), ok: clocks.officer_gate <= latest },
    event: { type: "exam.request.received", exam_id: i.exam_id, request_no: i.request_no, source: i.source, loan_id: i.loan_id ?? null, due_at: i.stated_due, received_at: i.received_on },
  };
}

// ================================================================ package assembly, officer review, submission (rule 2; T2)
/** A2-4-01: each file must identify the servicing file type, remittance type (A/A, S/A, S/S), servicing option, Fannie Mae loan number, servicer loan number, borrower name and property address. */
export const HEADER_FIELDS = ["file_type", "remittance_type", "servicing_option", "fnma_loan_number", "servicer_loan_number", "borrower_name", "property_address"] as const;
export type ReviewFileSection = (typeof REVIEW_FILE_SECTIONS)[number];

export interface ForeclosureLogE3215 {
  readonly referral_on: PlainDate; readonly milestones: readonly { on: PlainDate; milestone: string }[]; readonly delay_communications: readonly string[];
  readonly allowable_days: number; readonly elapsed_days: number; readonly credited_days: number; readonly at_risk_days: number; readonly excess_days: number; readonly within_timeframe: boolean;
  readonly status: "tracking" | "at_risk_70pct" | "over_allowable"; readonly exhibit_version: string; readonly method: "judicial" | "non_judicial"; readonly comparison: "E-3.2-15"; readonly elapsed_basis: string;
  readonly state: string; readonly county: string | null; readonly lpi_due: PlainDate; readonly as_of: PlainDate;
}
/**
 * Rule 2 — the foreclosure log's "milestones vs. E-3.2-15 allowable time frames": the allowable days come from the
 * Foreclosure Time Frames exhibit in force for the sale date (foreclosure/timeframes.ts, never a caller's integer),
 * elapsed days = sale (or as-of) − LPI due (A1-4.2-02, no +1), delay credits from the exhibit's per-category caps.
 */
export function foreclosureLogFromExhibit(i: { state: string; county?: string | null; sale_on?: PlainDate | null; lpi_due: PlainDate; referral_on: PlainDate; milestones: readonly { on: PlainDate; milestone: string }[]; delays: readonly Delay[]; delay_communications: readonly string[]; as_of: PlainDate }): ForeclosureLogE3215 {
  const a = e3215Allowable(i.state, i.county ?? null, i.sale_on ?? null);
  const through = i.sale_on ?? i.as_of;
  const elapsed = daysBetween(i.lpi_due, through);
  const credits = creditDelays(i.delays, { lpi_due: i.lpi_due });
  const excess = Math.max(0, elapsed - a.days - credits.credited_days);
  return {
    referral_on: i.referral_on, milestones: [...i.milestones], delay_communications: [...i.delay_communications],
    allowable_days: a.days, elapsed_days: elapsed, credited_days: credits.credited_days, at_risk_days: credits.at_risk_days, excess_days: excess, within_timeframe: excess === 0,
    status: trackingStatus(elapsed, a.days, credits.credited_days), exhibit_version: a.exhibit_version, method: a.method, comparison: "E-3.2-15", elapsed_basis: `${i.sale_on ? "sale" : "as-of"} ${through} − LPI due ${i.lpi_due}`,
    state: i.state.toUpperCase(), county: i.county ?? null, lpi_due: i.lpi_due, as_of: i.as_of,
  };
}

export interface ReviewFileQa {
  readonly passed: boolean;
  readonly missing_sections: ReviewFileSection[];
  readonly missing_header_fields: string[];
  readonly fc_comparison: "E-3.2-15" | null;
  readonly fc_allowable_matches_exhibit: boolean | null;
  readonly manifest_matches: boolean;
  readonly timers_without_evidence: string[];
  readonly checklist: readonly { id: "a2401_contents_present" | "header_fields" | "e3215_comparison" | "hash_manifest" | "timer_appendix_evidence"; ok: boolean }[];
}
/**
 * Agent QA checklist behind `documents.compile_pdf` (spec §18.2 agent design: "A2-4-01 required contents present;
 * header fields; hash manifest"): the BK/FC logs are required only when the loan has a bankruptcy / a foreclosure
 * referral; the FC log must carry the E-3.2-15 comparison and its allowable days must be the exhibit's figure for
 * the loan's jurisdiction — the jurisdiction the caller names or, failing that, the one the log itself carries
 * (foreclosureLogFromExhibit stamps `state`/`county`/`sale_on`); a log whose figure cannot be checked against the
 * exhibit at all (no jurisdiction anywhere) fails the check — a hand-entered `allowable_days` never reaches officer
 * review unverified; every satisfied timer in the appendix must name its satisfying event and evidence hash; the
 * manifest hash must match the stored document.
 */
export function reviewFileQa(file: ReviewFile, storedDocument: string, expect: { bankruptcy: boolean; foreclosure: boolean; jurisdiction?: { state: string; county?: string | null; sale_on?: PlainDate | null } }): ReviewFileQa {
  const required = REVIEW_FILE_SECTIONS.filter((id) => (id === "bankruptcy_log" ? expect.bankruptcy : id === "foreclosure_log" ? expect.foreclosure : true));
  const present = new Set(file.sections.filter((s) => s.present).map((s) => s.id));
  const missing_sections = required.filter((id) => !present.has(id));
  const missing_header_fields = HEADER_FIELDS.filter((k) => !file.header[k]);
  const fc_comparison = expect.foreclosure && file.foreclosure_log?.comparison === "E-3.2-15" ? "E-3.2-15" : null;
  const manifest_matches = manifestMatches(file.manifest, storedDocument);
  const body = JSON.parse(file.document) as { timer_appendix?: readonly { code: string; status: string; satisfied_by_event_id?: string | null; evidence_hash?: string | null }[]; foreclosure_log?: { state?: unknown; county?: unknown; sale_on?: unknown } | null };
  const logState = typeof body.foreclosure_log?.state === "string" && body.foreclosure_log.state !== "" ? body.foreclosure_log.state : null;
  const jurisdiction = expect.jurisdiction ?? (logState ? { state: logState, county: typeof body.foreclosure_log?.county === "string" ? body.foreclosure_log.county : null, sale_on: typeof body.foreclosure_log?.sale_on === "string" ? (body.foreclosure_log.sale_on as PlainDate) : null } : null);
  const fc_allowable_matches_exhibit = expect.foreclosure && jurisdiction && file.foreclosure_log ? file.foreclosure_log.allowable_days === e3215Allowable(jurisdiction.state, jurisdiction.county ?? null, jurisdiction.sale_on ?? null).days : null;
  const timers_without_evidence = (body.timer_appendix ?? []).filter((t) => t.status === "satisfied" && (!t.satisfied_by_event_id || !t.evidence_hash)).map((t) => t.code);
  const checklist = [
    { id: "a2401_contents_present" as const, ok: missing_sections.length === 0 },
    { id: "header_fields" as const, ok: missing_header_fields.length === 0 },
    // an unverifiable allowable figure (null: no jurisdiction from the caller or the log) fails, exactly as a wrong one does
    { id: "e3215_comparison" as const, ok: !expect.foreclosure || (fc_comparison !== null && fc_allowable_matches_exhibit === true) },
    { id: "hash_manifest" as const, ok: manifest_matches },
    { id: "timer_appendix_evidence" as const, ok: timers_without_evidence.length === 0 },
  ];
  return { passed: checklist.every((c) => c.ok), missing_sections, missing_header_fields, fc_comparison, fc_allowable_matches_exhibit, manifest_matches, timers_without_evidence, checklist };
}

export interface PackageReviewWindow { readonly opens_on: PlainDate; readonly approve_by: PlainDate; readonly officer_3bd: PlainDate; readonly one_bd_before_due: PlainDate; readonly open: boolean; readonly reason?: string; readonly breached: boolean; readonly extension_request_drafted: boolean; }
/**
 * `SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD` (not-before gate + deadline): the package must sit ≥1 BD for review (the gate
 * opens the business day after `assembled_at`), the officer has 3 BD, and approval must land ≥1 BD before `due_at` —
 * `approve_by = min(assembled + 3 BD, due − 1 BD)`. Past `approve_by` without approval: sev-2 and the extension
 * request is drafted automatically (rule 5). `approve_by` is the computed anchor the registry row is due on.
 */
export function packageReviewWindow(i: { assembled_on: PlainDate; due_at: PlainDate; today: PlainDate; approved_on: PlainDate | null; cal?: Calendar }): PackageReviewWindow {
  const cal = i.cal ?? servicer;
  const opens = addBusinessDays(i.assembled_on, 1, cal); const three = addBusinessDays(i.assembled_on, 3, cal); const before = addBusinessDays(i.due_at, -1, cal);
  const approveBy = three < before ? three : before;
  const base = { opens_on: opens, approve_by: approveBy, officer_3bd: three, one_bd_before_due: before };
  if (i.approved_on) {
    if (i.approved_on < opens) return { ...base, open: false, reason: `SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD: approval ${i.approved_on} before the package sat ≥1 BD for review (opens ${opens})`, breached: false, extension_request_drafted: false };
    if (i.approved_on > approveBy) return { ...base, open: false, reason: `SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD: approval ${i.approved_on} after approve-by ${approveBy} (≥1 BD before due ${i.due_at}; officer 3 BD)`, breached: true, extension_request_drafted: true };
    return { ...base, open: true, breached: false, extension_request_drafted: false };
  }
  if (i.today < opens) return { ...base, open: false, reason: `SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD: package assembled ${i.assembled_on} must sit ≥1 BD for review — gate opens ${opens}`, breached: false, extension_request_drafted: false };
  if (i.today > approveBy) return { ...base, open: false, reason: `SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD breached: not approved by ${approveBy} (≥1 BD before due ${i.due_at}) — sev-2, extension request drafted`, breached: true, extension_request_drafted: true };
  return { ...base, open: true, breached: false, extension_request_drafted: false };
}
export interface PackageAssembledEvent { readonly type: "exam.package.assembled"; readonly exam_id: string; readonly request_no: string; readonly assembled_at: PlainDate; readonly due_at: PlainDate; readonly review_opens_on: PlainDate; readonly approve_by: PlainDate; readonly manifest_sha256: string; }
/**
 * Package assembled → `exam.package.assembled{assembled_at, due_at, review_opens_on, approve_by}`: the registry row
 * anchors its deadline on `approve_by` (offset 0) and its not-before half on `review_opens_on`; the request moves to
 * `officer_review`. A package that fails QA never reaches the officer.
 */
export function packageAssembled(i: { exam_id: string; request_no: string; assembled_on: PlainDate; due_at: PlainDate; manifest_sha256: string; qa: ReviewFileQa; cal?: Calendar }): { event: PackageAssembledEvent | null; window: PackageReviewWindow; request_status: "officer_review" | "assembling"; refusal: string | null } {
  const window = packageReviewWindow({ assembled_on: i.assembled_on, due_at: i.due_at, today: i.assembled_on, approved_on: null, cal: i.cal ?? servicer });
  if (!i.qa.passed) return { event: null, window, request_status: "assembling", refusal: `package QA failed: ${i.qa.checklist.filter((c) => !c.ok).map((c) => c.id).join(", ")}` };
  return { event: { type: "exam.package.assembled", exam_id: i.exam_id, request_no: i.request_no, assembled_at: i.assembled_on, due_at: i.due_at, review_opens_on: window.opens_on, approve_by: window.approve_by, manifest_sha256: i.manifest_sha256 }, window, request_status: "officer_review", refusal: null };
}
export interface PackageApprovedEvent { readonly type: "exam.package.approved"; readonly exam_id: string; readonly request_no: string; readonly approved_by_role: "officer"; readonly approved_by_officer_id: string; readonly approver_entity: "partner" | "supermortgage"; readonly approved_at: PlainDate; readonly manifest_sha256: string; }
export interface PackageApproval { readonly approved: boolean; readonly refusal: string | null; readonly event: PackageApprovedEvent | null; readonly production: { approved_by_officer_id: string; approver_entity: "partner" | "supermortgage"; approved_at: PlainDate } | null; readonly portal_task: { kind: "human_portal_task"; to: "fnma_portal_operator"; manifest_sha256: string; expected_confirmation: "LQC confirmation id or screenshot → exam.request.submitted" } | null; }
const PORTAL_TASK = (manifest: string): NonNullable<PackageApproval["portal_task"]> => ({ kind: "human_portal_task", to: "fnma_portal_operator", manifest_sha256: manifest, expected_confirmation: "LQC confirmation id or screenshot → exam.request.submitted" });
/**
 * `officer` approval closes the window (`exam.package.approved{approved_by_role=officer}`) and opens the LQC upload
 * task for `fnma_portal_operator`; the partner's officer approves anything submitted under the partner's servicer
 * number (guardrails). The event names the manifest approved, so an upload task can only carry that package.
 */
export function officerApproval(i: { exam_id: string; request_no: string; assembled_on: PlainDate; due_at: PlainDate; approved_on: PlainDate; approved_by_role: string; approved_by_id: string; approver_entity: "partner" | "supermortgage"; servicer_number_owner?: "partner" | "supermortgage"; manifest_sha256: string; cal?: Calendar }): PackageApproval {
  const refused = (refusal: string): PackageApproval => ({ approved: false, refusal, event: null, production: null, portal_task: null });
  if (i.approved_by_role !== "officer") return refused(`${BASELINE_8_3}; approval by ${i.approved_by_role} refused`);
  if ((i.servicer_number_owner ?? "partner") === "partner" && i.approver_entity !== "partner") return refused("§18.2 guardrails: the partner's officer signs anything submitted under the partner's servicer number — approval by the supermortgage officer refused");
  const w = packageReviewWindow({ assembled_on: i.assembled_on, due_at: i.due_at, today: i.approved_on, approved_on: i.approved_on, cal: i.cal ?? servicer });
  if (!w.open) return refused(w.reason ?? "review window closed");
  return { approved: true, refusal: null, event: { type: "exam.package.approved", exam_id: i.exam_id, request_no: i.request_no, approved_by_role: "officer", approved_by_officer_id: i.approved_by_id, approver_entity: i.approver_entity, approved_at: i.approved_on, manifest_sha256: i.manifest_sha256 }, production: { approved_by_officer_id: i.approved_by_id, approver_entity: i.approver_entity, approved_at: i.approved_on }, portal_task: PORTAL_TASK(i.manifest_sha256) };
}
/** The latest `exam.package.assembled` on record for a request item — the package (manifest, review window) the officer can approve; null before the package compiles. */
export function latestPackageAssembled(events: EventStore, i: { exam_id: string; request_no: string }): DomainEvent | null {
  const all = events.ofType("exam.package.assembled").filter((e) => e.payload.exam_id === i.exam_id && e.payload.request_no === i.request_no);
  return all.length ? all[all.length - 1]! : null;
}
/**
 * Event-store path: the officer's approval is recorded by the `officer` actor itself — the actor's role, never a role
 * or an officer id the input asserts — against the package on record (`exam.package.assembled`: its manifest and the
 * review window stamped on it, `review_opens_on` ≤ approval ≤ `approve_by`), on the day of the act. Nothing on record
 * to approve, a different manifest, the wrong entity's officer, or an approval outside the window is refused and
 * nothing is appended. Mirrors recordCounselReview: the act lifts the gate, not a field on the upload task.
 */
export function recordPackageApproval(events: EventStore, i: { exam_id: string; request_no: string; approved_on: PlainDate; approver_entity: "partner" | "supermortgage"; servicer_number_owner: "partner" | "supermortgage"; manifest_sha256?: string | null }, actor: Actor): PackageApproval & { appended: DomainEvent | null } {
  if (!i.exam_id || !i.request_no) throw new RangeError("exam_id and request_no are required");
  if (!isDate(i.approved_on)) throw new RangeError("approved_on is required (PlainDate)");
  if (i.approver_entity !== "partner" && i.approver_entity !== "supermortgage") throw new RangeError("approver_entity must be partner or supermortgage");
  const refused = (refusal: string): PackageApproval & { appended: null } => ({ approved: false, refusal, event: null, production: null, portal_task: null, appended: null });
  const role = actor.kind === "human" ? (actor.role ?? "") : actor.kind;
  if (role !== "officer") return refused(`${BASELINE_8_3}; approval by ${role || "nobody"} refused`);
  const assembled = latestPackageAssembled(events, i);
  if (!assembled) return refused(`no \`exam.package.assembled\` on record for ${i.exam_id}/${i.request_no} — compile the package (documents.compile_pdf) before the officer approves it`);
  const p = assembled.payload as { manifest_sha256?: unknown; review_opens_on?: unknown; approve_by?: unknown; due_at?: unknown };
  const manifest = String(p.manifest_sha256 ?? "");
  if (i.manifest_sha256 && i.manifest_sha256 !== manifest) return refused(`manifest ${i.manifest_sha256} is not the package on record (${manifest}) — the officer approves the compiled package, never a hash the caller names`);
  if (i.servicer_number_owner === "partner" && i.approver_entity !== "partner") return refused("§18.2 guardrails: the partner's officer signs anything submitted under the partner's servicer number — approval by the supermortgage officer refused");
  if (!isDate(p.review_opens_on) || !isDate(p.approve_by)) return refused("the package on record carries no review window — recompile it");
  if (i.approved_on < p.review_opens_on) return refused(`SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD: approval ${i.approved_on} before the package sat ≥1 BD for review (opens ${p.review_opens_on})`);
  if (i.approved_on > p.approve_by) return refused(`SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD: approval ${i.approved_on} after approve-by ${p.approve_by} (≥1 BD before due ${String(p.due_at)}; officer 3 BD)`);
  const event: PackageApprovedEvent = { type: "exam.package.approved", exam_id: i.exam_id, request_no: i.request_no, approved_by_role: "officer", approved_by_officer_id: actor.id, approver_entity: i.approver_entity, approved_at: i.approved_on, manifest_sha256: manifest };
  return { approved: true, refusal: null, event, production: { approved_by_officer_id: actor.id, approver_entity: i.approver_entity, approved_at: i.approved_on }, portal_task: PORTAL_TASK(manifest), appended: appendExamEvent(events, event, actor) };
}
/** The officer approval on record for exactly this package (same exam, request and manifest hash — a recompiled package is unapproved); null when there is none. */
export function packageApprovalOnRecord(events: EventStore, i: { exam_id: string; request_no: string; manifest_sha256: string }): { approved_by_officer_id: string; approver_entity: "partner" | "supermortgage"; approved_at: PlainDate } | null {
  const ev = events.ofType("exam.package.approved").find((e) => e.payload.exam_id === i.exam_id && e.payload.request_no === i.request_no && e.payload.manifest_sha256 === i.manifest_sha256 && e.payload.approved_by_role === "officer");
  if (!ev || !isDate(ev.payload.approved_at) || !i.manifest_sha256) return null;
  return { approved_by_officer_id: String(ev.payload.approved_by_officer_id ?? ""), approver_entity: ev.payload.approver_entity === "supermortgage" ? "supermortgage" : "partner", approved_at: ev.payload.approved_at };
}
export type SubmissionChannel = "fnma_lqc" | "cfpb_portal" | "nmls" | "secure_email" | "mail";
export interface ExamRequestSubmittedEvent { readonly type: "exam.request.submitted"; readonly exam_id: string; readonly request_no: string; readonly loan_id: string | null; readonly channel: SubmissionChannel; readonly submitted_at: PlainDate; readonly submission_evidence: string; readonly lqc_confirmation_id: string | null; readonly remaining_open_requests: number | null; }
/**
 * The operator records the confirmation → `exam.request.submitted{submission_evidence, lqc_confirmation_id,
 * remaining_open_requests}`; no evidence, no event (both stated-date and A2-4-01 rows satisfy only on evidence). The
 * per-loan request row is satisfied by its own submission (`loan_id`); the exam-level A2-4-01 clock only by the
 * submission that leaves no request open — `remaining_open_requests=0`. A caller that does not know the count stamps
 * `null` (unknown), which satisfies nothing at exam level: the 30-day clock never closes on a guess. recordSubmission
 * derives the count from the event store.
 */
export function submissionRecorded(i: { exam_id: string; request_no: string; loan_id?: string | null; channel: SubmissionChannel; submitted_on: PlainDate; confirmation_id: string | null; evidence_document_id: string | null; open_requests_after?: number | null }): { event: ExamRequestSubmittedEvent | null; request_status: "submitted" | "officer_review"; refusal: string | null } {
  const evidence = i.evidence_document_id ?? i.confirmation_id;
  if (!evidence) return { event: null, request_status: "officer_review", refusal: "submission evidence required (LQC confirmation id/screenshot, portal receipt or sent-mail capture) before the request is `submitted`" };
  if (i.channel === "fnma_lqc" && !i.confirmation_id) return { event: null, request_status: "officer_review", refusal: "FNMA_A2401_REVIEW_FILE_30 is satisfied only by `exam.request.submitted` with LQC confirmation — record the LQC confirmation id" };
  const remaining = typeof i.open_requests_after === "number" && Number.isInteger(i.open_requests_after) && i.open_requests_after >= 0 ? i.open_requests_after : null;
  return { event: { type: "exam.request.submitted", exam_id: i.exam_id, request_no: i.request_no, loan_id: i.loan_id ?? null, channel: i.channel, submitted_at: i.submitted_on, submission_evidence: evidence, lqc_confirmation_id: i.channel === "fnma_lqc" ? i.confirmation_id : null, remaining_open_requests: remaining }, request_status: "submitted", refusal: null };
}

// ================================================================ event-store paths (Inputs / Integrations)
const EXAM_SOURCES: readonly ExamSource[] = ["fnma_lqc", "fnma_letter", "fnma_scr", "cfpb", "state", "multistate", "partner", "investor", "rating_agency", "litigation_discovery", "subpoena"];
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
/** Append an ops-18-2 event: the exam is the aggregate; an event that names a `loan_id` is a per-loan event, so the loan rides on the envelope and the TimerEngine's subject is the loan. */
function appendExamEvent(events: EventStore, ev: { readonly type: string; readonly exam_id?: string | null; readonly loan_id?: string | null }, actor: Actor): DomainEvent {
  const { type, ...payload } = ev as { type: string } & Record<string, unknown>;
  const loanId = typeof ev.loan_id === "string" && ev.loan_id ? ev.loan_id : null;
  return events.append({ type, ...(loanId ? { loanId } : {}), ...(ev.exam_id ? { aggregate: { kind: "exam", id: ev.exam_id } } : {}), actor, payload });
}
export interface IngestedExamNotice { readonly scoped: ScopedExam; readonly appended: DomainEvent[]; }
/**
 * Inputs: "`exam.notice.received` … created from LQC email notifications, mail intake (`security-records` mailroom),
 * partner forwards." The inbound record is validated (a known source, the notice document, dates in order, the
 * stated deadline not before notification, a servicing-review notice naming at least one loan) and the scoped
 * exam's events are appended in order — contact, notice, one `exam.request.received` per loan *under that loan*
 * (`EXAM_REQUEST_DUE_AS_STATED` arms per loan), `exam.scoped`. Rule 1's examiner query for unknown loan numbers
 * stays on the result for the officer's signature.
 */
export function ingestExamNotice(events: EventStore, i: { notice: ExamNotice; loans: readonly { loan_id: string; fnma_loan_number: string }[]; scoped_on: PlainDate; cal?: Calendar; officer_cal?: Calendar }, actor: Actor = SYSTEM): IngestedExamNotice {
  const n = i.notice;
  if (!n.exam_id) throw new RangeError("exam_id is required");
  if (!EXAM_SOURCES.includes(n.source)) throw new RangeError(`source must be one of ${EXAM_SOURCES.join(", ")} (§18.2 Inputs)`);
  if (!n.notice_document_id) throw new RangeError("notice_document_id is required (the notice document in `documents`)");
  if (!isDate(n.notified_on) || !isDate(n.received_on) || !isDate(i.scoped_on)) throw new RangeError("notified_on, received_on and scoped_on are required (PlainDate)");
  if (n.received_on < n.notified_on) throw new RangeError(`received_on ${n.received_on} is before the notification date ${n.notified_on}`);
  if (i.scoped_on < n.received_on) throw new RangeError(`scoped_on ${i.scoped_on} is before receipt ${n.received_on}`);
  if (n.stated_due !== null && (!isDate(n.stated_due) || n.stated_due < n.notified_on)) throw new RangeError(`stated_due ${n.stated_due} is not a date on or after the notification date`);
  if (n.review_type === "servicing_review" && n.fnma_loan_numbers.length === 0) throw new RangeError("a servicing-review notice names at least one Fannie Mae loan number (A2-4-01)");
  if (new Set(n.fnma_loan_numbers).size !== n.fnma_loan_numbers.length) throw new RangeError("duplicate Fannie Mae loan numbers on the notice");
  const scoped = scopeNotice({ notice: n, loans: i.loans, scoped_on: i.scoped_on, ...(i.cal ? { cal: i.cal } : {}), ...(i.officer_cal ? { officer_cal: i.officer_cal } : {}) });
  return { scoped, appended: scoped.events.map((ev) => appendExamEvent(events, ev, actor)) };
}
/** A letter's document/information request item (T7: a CFPB request with a stated deadline) → `exam.request.received` appended, under the loan when it names one. */
export function ingestExamRequest(events: EventStore, i: { exam_id: string; request_no: string; source: ExamSource; received_on: PlainDate; stated_due: PlainDate; loan_id?: string | null; cal: Calendar; officer_cal?: Calendar }, actor: Actor = SYSTEM): ExamRequestReceived & { appended: DomainEvent } {
  if (!i.exam_id || !i.request_no) throw new RangeError("exam_id and request_no are required");
  if (!EXAM_SOURCES.includes(i.source)) throw new RangeError(`source must be one of ${EXAM_SOURCES.join(", ")} (§18.2 Inputs)`);
  if (!isDate(i.received_on) || !isDate(i.stated_due)) throw new RangeError("received_on and stated_due are required (PlainDate)");
  if (i.stated_due < i.received_on) throw new RangeError(`stated_due ${i.stated_due} is before receipt ${i.received_on}`);
  const r = examRequestReceived(i);
  return { ...r, appended: appendExamEvent(events, r.event, actor) };
}
/** Request items of an exam still open in the store: received and not yet submitted (the `exam_requests.status` projection, derived from the log). */
export function openRequestNos(events: EventStore, examId: string): string[] {
  const submitted = new Set(events.ofType("exam.request.submitted").filter((e) => e.payload.exam_id === examId).map((e) => String(e.payload.request_no)));
  return [...new Set(events.ofType("exam.request.received").filter((e) => e.payload.exam_id === examId).map((e) => String(e.payload.request_no)))].filter((no) => !submitted.has(no));
}
/**
 * Integrations: "operator records the LQC confirmation (screenshot/id) → `exam.request.submitted`". The
 * `fnma_portal_operator` (or the mailbox/portal channel) records the evidence; the count of requests still open after
 * this one is derived from the store's own `exam.request.received` / `exam.request.submitted` history — never
 * remembered by the caller — so the exam-level A2-4-01 clock closes only on the submission that really leaves none
 * open. A request the store never received is refused; so is a second submission of the same item.
 */
export function recordSubmission(events: EventStore, i: { exam_id: string; request_no: string; channel: SubmissionChannel; submitted_on: PlainDate; confirmation_id: string | null; evidence_document_id: string | null }, actor: Actor): { event: DomainEvent | null; remaining_open_requests: number | null; request_status: "submitted" | "officer_review"; refusal: string | null } {
  if (!i.exam_id || !i.request_no) throw new RangeError("exam_id and request_no are required");
  if (!isDate(i.submitted_on)) throw new RangeError("submitted_on is required (PlainDate)");
  const received = events.ofType("exam.request.received").find((e) => e.payload.exam_id === i.exam_id && e.payload.request_no === i.request_no);
  if (!received) return { event: null, remaining_open_requests: null, request_status: "officer_review", refusal: `no \`exam.request.received\` for ${i.exam_id}/${i.request_no} — the request item was never ingested` };
  const open = openRequestNos(events, i.exam_id);
  if (!open.includes(i.request_no)) return { event: null, remaining_open_requests: open.length, request_status: "submitted", refusal: `${i.exam_id}/${i.request_no} is already submitted` };
  const remaining = open.filter((no) => no !== i.request_no).length;
  const r = submissionRecorded({ ...i, loan_id: received.loanId ?? null, open_requests_after: remaining });
  if (!r.event) return { event: null, remaining_open_requests: remaining, request_status: r.request_status, refusal: r.refusal };
  return { event: appendExamEvent(events, r.event, actor), remaining_open_requests: remaining, request_status: "submitted", refusal: null };
}

// ================================================================ extension requests and the warning sweep (rule 5; T3)
export interface ExtensionRequest {
  readonly needed: boolean;
  readonly letter: { template: "EXAM-EXT-REQ-v1"; to: string; exam_id: string; request_no: string; drafted_on: PlainDate; current_due: PlainDate; requested_until: PlainDate; extenuating_circumstances: string[]; citation: string; signature_block: { role: "officer"; entity: "partner" | "supermortgage"; signed: false } } | null;
  readonly escalation: QcEscalation | null;
  readonly request: { extension_requested_at: PlainDate; status: "open" } | null;
  readonly exam_side_state: "extension_pending" | null;
  readonly written_confirmation_required: true;
}
/**
 * Rule 5 / open question 4: an extension request is drafted automatically when the 80 % warning fires without an
 * assembled package, citing the extenuating circumstances (A2-4-01 "Fannie Mae will make every effort to work with
 * the seller/servicer"), and escalated to `officer` for signature; never rely on an extension not confirmed in writing.
 */
export function extensionRequest(i: { exam_id: string; request_no: string; examiner: string; clocks: ExamClocks; assembled_on: PlainDate | null; today: PlainDate; requested_until: PlainDate; circumstances: readonly string[]; subject_entity: "partner" | "supermortgage"; force?: boolean }): ExtensionRequest {
  const needed = i.force === true || extensionRequestNeeded(i.assembled_on, i.clocks.warn_80, i.today);
  if (!needed) return { needed, letter: null, escalation: null, request: null, exam_side_state: null, written_confirmation_required: true };
  return {
    needed,
    letter: { template: "EXAM-EXT-REQ-v1", to: i.examiner, exam_id: i.exam_id, request_no: i.request_no, drafted_on: i.today, current_due: i.clocks.due, requested_until: i.requested_until, extenuating_circumstances: [...i.circumstances], citation: "Servicing Guide A2-4-01: \"Fannie Mae will make every effort to work with the seller/servicer\"; \"Fannie Mae, in its sole discretion, may request the documentation in a shorter or longer period of time\"", signature_block: { role: "officer", entity: i.subject_entity, signed: false } },
    escalation: { kind: "officer", severity: "sev2", reason: i.force ? `officer-review window breached for ${i.exam_id}/${i.request_no} (due ${i.clocks.due}) — sign the extension request to ${i.examiner}` : `80% warning ${i.clocks.warn_80} reached without an assembled package for ${i.exam_id}/${i.request_no} (due ${i.clocks.due}) — sign the extension request to ${i.examiner}`, due: i.clocks.internal_target },
    request: { extension_requested_at: i.today, status: "open" },
    exam_side_state: "extension_pending",
    written_confirmation_required: true,
  };
}
export type WarningLevel = 50 | 80;
export interface SweepRequest {
  readonly exam_id: string; readonly request_no: string; readonly examiner: string; readonly subject_entity: "partner" | "supermortgage";
  readonly clocks: ExamClocks18_2;
  readonly assembled_on: PlainDate | null; readonly approved_on: PlainDate | null; readonly submitted_on: PlainDate | null;
  /** Warnings already fired on earlier sweeps (idempotence). */
  readonly warnings_fired: readonly WarningLevel[];
  readonly circumstances?: readonly string[];
  readonly requested_until?: PlainDate;
}
export interface ExamWarningEvent { readonly type: "exam.request.warning"; readonly exam_id: string; readonly request_no: string; readonly level: WarningLevel; readonly warning_at: PlainDate; readonly fired_at: PlainDate; readonly due_at: PlainDate; readonly package_assembled: boolean; }
export interface DeadlineSweep {
  readonly warnings: { exam_id: string; request_no: string; level: WarningLevel; warning_at: PlainDate; fired_at: PlainDate }[];
  readonly events: ExamWarningEvent[];
  readonly extension_requests: (ExtensionRequest & { exam_id: string; request_no: string; trigger: "warn_80_without_package" | "officer_review_breached" })[];
  readonly officer_review_breaches: { exam_id: string; request_no: string; approve_by: PlainDate; reason: string }[];
  readonly escalations: QcEscalation[];
}
/**
 * The daily deadline sweep — the warning mechanism the timer table's "warning at 50% and 80%" columns describe (the
 * kernel has no warning kind, so the request rows' `warn_50_at`/`warn_80_at` are fired here, once each): on or after
 * a warning date it emits `exam.request.warning{level}`; the 80 % warning without an assembled package drafts the
 * extension request (rule 5); an assembled package still unapproved past `approve_by` is the officer-review breach,
 * which also drafts the extension request (timer table: "sev-2; auto-extension request drafted").
 */
export function examDeadlineSweep(i: { requests: readonly SweepRequest[]; today: PlainDate; cal?: Calendar; default_extension_days?: number }): DeadlineSweep {
  const cal = i.cal ?? servicer; const extDays = i.default_extension_days ?? 14;
  const out: DeadlineSweep = { warnings: [], events: [], extension_requests: [], officer_review_breaches: [], escalations: [] };
  for (const r of i.requests) {
    if (r.submitted_on) continue;
    for (const [level, at] of [[50, r.clocks.warn_50], [80, r.clocks.warn_80]] as const) {
      if (i.today < at || r.warnings_fired.includes(level)) continue;
      out.warnings.push({ exam_id: r.exam_id, request_no: r.request_no, level, warning_at: at, fired_at: i.today });
      out.events.push({ type: "exam.request.warning", exam_id: r.exam_id, request_no: r.request_no, level, warning_at: at, fired_at: i.today, due_at: r.clocks.due, package_assembled: r.assembled_on !== null && r.assembled_on <= i.today });
    }
    const requestedUntil = r.requested_until ?? addDays(r.clocks.due, extDays);
    const circumstances = r.circumstances ?? ["package not assembled by the 80 % warning — see the request's open-issues list"];
    if (i.today >= r.clocks.warn_80 && !r.warnings_fired.includes(80)) {
      const ext = extensionRequest({ exam_id: r.exam_id, request_no: r.request_no, examiner: r.examiner, clocks: r.clocks, assembled_on: r.assembled_on, today: i.today, requested_until: requestedUntil, circumstances, subject_entity: r.subject_entity });
      if (ext.needed) { out.extension_requests.push({ ...ext, exam_id: r.exam_id, request_no: r.request_no, trigger: "warn_80_without_package" }); if (ext.escalation) out.escalations.push(ext.escalation); }
    }
    if (r.assembled_on && !r.approved_on) {
      const w = packageReviewWindow({ assembled_on: r.assembled_on, due_at: r.clocks.due, today: i.today, approved_on: null, cal });
      if (w.breached) {
        out.officer_review_breaches.push({ exam_id: r.exam_id, request_no: r.request_no, approve_by: w.approve_by, reason: w.reason ?? "officer-review window breached" });
        const ext = extensionRequest({ exam_id: r.exam_id, request_no: r.request_no, examiner: r.examiner, clocks: r.clocks, assembled_on: r.assembled_on, today: i.today, requested_until: requestedUntil, circumstances: [`package assembled ${r.assembled_on} not approved by ${w.approve_by}`, ...(r.circumstances ?? [])], subject_entity: r.subject_entity, force: true });
        out.extension_requests.push({ ...ext, exam_id: r.exam_id, request_no: r.request_no, trigger: "officer_review_breached" }); if (ext.escalation) out.escalations.push(ext.escalation);
      }
    }
  }
  return out;
}

// ================================================================ privilege / PII (rule 3; T4)
export interface ProductionDocument { readonly document_id: string; readonly document_class: string; readonly description: string; readonly non_borrower_pii?: readonly string[]; }
export interface PrivilegeLogEntry { readonly document_id: string; readonly document_class: string; readonly basis: "attorney_client" | "work_product" | "attorney_communication"; readonly description: string; }
export interface PrivilegeScreen {
  readonly produced: string[];
  readonly excluded: PrivilegeLogEntry[];
  readonly privilege_log: { document_id: string; entries: PrivilegeLogEntry[] };
  readonly redactions: { document_id: string; redacted: string[]; reason: "non_borrower_pii" }[];
  readonly refused_withholdings: { document_id: string; reason: string; citation: string }[];
  readonly production: { privilege_log_document_id: string; pii_redaction_applied: boolean };
}
/**
 * Rule 3: counsel work product and attorney communications are excluded by document class and listed on a privilege
 * log; PII of non-borrowers is redacted; nothing is redacted or withheld from what Fannie Mae owns (Selling Guide
 * A2-4.1-02 — records are Fannie Mae's property), so any proposed withholding that is not privilege-based is refused
 * and the record stays in `produced`. Whether the compiled package really carries every non-privileged record is
 * proved afterwards by productionCompleteness.
 */
export function privilegeScreen(i: { exam_request_id: string; documents: readonly ProductionDocument[]; proposed_withholdings?: readonly { document_id: string; reason: string }[] }): PrivilegeScreen {
  const excluded: PrivilegeLogEntry[] = i.documents.filter((d) => privilegeExcluded(d.document_class)).map((d) => ({ document_id: d.document_id, document_class: d.document_class, basis: d.document_class as PrivilegeLogEntry["basis"], description: `withheld — ${d.document_class.replace(/_/g, " ")}: ${d.description}` }));
  const excludedIds = new Set(excluded.map((e) => e.document_id));
  const refused = (i.proposed_withholdings ?? []).filter((w) => !excludedIds.has(w.document_id)).map((w) => ({ document_id: w.document_id, reason: w.reason, citation: A2_4_1_02 }));
  const produced = i.documents.filter((d) => !excludedIds.has(d.document_id)).map((d) => d.document_id);
  const redactions = i.documents.filter((d) => !excludedIds.has(d.document_id) && (d.non_borrower_pii?.length ?? 0) > 0).map((d) => ({ document_id: d.document_id, redacted: [...d.non_borrower_pii!], reason: "non_borrower_pii" as const }));
  return {
    produced, excluded,
    privilege_log: { document_id: `privlog-${i.exam_request_id}`, entries: excluded },
    redactions, refused_withholdings: refused,
    production: { privilege_log_document_id: `privlog-${i.exam_request_id}`, pii_redaction_applied: redactions.length > 0 },
  };
}
/**
 * T4's "no other Fannie Mae-owned record is withheld", checked against what was actually compiled: every document
 * that is not on the privilege log must be in the package; anything missing is a withheld Fannie Mae record
 * (A2-4.1-02) and the package fails QA.
 */
export function productionCompleteness(i: { documents: readonly ProductionDocument[]; screen: PrivilegeScreen; compiled_document_ids: readonly string[] }): { complete: boolean; fannie_mae_records_withheld: string[]; privileged_excluded: string[]; not_in_documents: string[]; citation: string } {
  const privileged = new Set(i.screen.excluded.map((e) => e.document_id)); const compiled = new Set(i.compiled_document_ids); const known = new Set(i.documents.map((d) => d.document_id));
  const withheld = i.documents.filter((d) => !privileged.has(d.document_id) && !compiled.has(d.document_id)).map((d) => d.document_id);
  const leaked = i.compiled_document_ids.filter((id) => privileged.has(id));
  return { complete: withheld.length === 0 && leaked.length === 0, fannie_mae_records_withheld: withheld, privileged_excluded: [...privileged], not_in_documents: i.compiled_document_ids.filter((id) => !known.has(id)), citation: A2_4_1_02 };
}

// ================================================================ EXAM-RESP-v1 response letter (outputs; rule 6)
export interface EvidenceCitation { readonly ref_type: "contacts" | "timers" | "notices" | "ledger_entries" | "cases" | "documents" | "evidence_index" | "agent_decisions"; readonly ref_id: string; }
export interface ResponseParagraph { readonly text: string; readonly citations: readonly EvidenceCitation[]; }
export const EXAM_RESP_V1_BLOCKS = ["header", "request_reference", "response", "evidence_citations", "signature_block"] as const;
export interface SignatureBlock { readonly role: string; readonly entity: "partner" | "supermortgage"; readonly signer_id: string | null; readonly signed_on: PlainDate | null; }
export interface ExamResponseLetter {
  readonly template: "EXAM-RESP-v1";
  readonly header: { examiner: string; exam_id: string; date: PlainDate; subject_entity: "partner" | "supermortgage" | "both"; servicer_number_owner: "partner" | "supermortgage"; prepared_by: "supermortgage" };
  readonly request_reference: { reference: string; received_on: PlainDate; cited_requirement: string | null };
  readonly response: readonly ResponseParagraph[];
  readonly evidence_citations: readonly EvidenceCitation[];
  readonly signature_block: SignatureBlock;
  readonly rule6_elements: { finding: boolean; root_cause: boolean; remediation: boolean; affected_population_with_count: boolean; evidence_of_correction: boolean };
  readonly checklist: readonly { id: string; ok: boolean; why?: string }[];
  readonly draft_hash: string;
}
/** The officer signature block is right when it names the `officer` of the entity whose servicer number the response goes out under, unsigned at draft (the officer signs at release; the agent never pre-signs). */
export function signatureBlockCheck(block: SignatureBlock, servicerNumberOwner: "partner" | "supermortgage"): { ok: boolean; why?: string } {
  if (block.role !== "officer") return { ok: false, why: `signature block names ${block.role || "nobody"}, not the officer (${BASELINE_8_3})` };
  if (block.entity !== servicerNumberOwner) return { ok: false, why: `signature block names the ${block.entity} officer but the response goes out under the ${servicerNumberOwner}'s servicer number` };
  if (block.signer_id !== null || block.signed_on !== null) return { ok: false, why: "signature block is pre-signed at draft — the officer signs at release, never the agent" };
  return { ok: true };
}
/**
 * The response letter (template `EXAM-RESP-v1`: header, request reference, response, evidence citations, officer
 * signature block). Facts only from the evidence index — every paragraph cites a record id; the officer block is
 * unsigned until `officer` signs; under the partner's servicer number the partner's officer signs. A caller may pass
 * the block it proposes; the checklist judges it.
 */
export function renderExamResponse(i: { examiner: string; exam_id: string; date: PlainDate; subject_entity: "partner" | "supermortgage" | "both"; servicer_number_owner: "partner" | "supermortgage"; reference: { reference: string; received_on: PlainDate; cited_requirement: string | null }; paragraphs: readonly ResponseParagraph[]; elements: { root_cause: boolean; remediation: boolean; affected_population_with_count: boolean; evidence_of_correction: boolean }; signature_block?: SignatureBlock }): ExamResponseLetter {
  const citations = [...new Map(i.paragraphs.flatMap((p) => p.citations).map((c) => [`${c.ref_type}:${c.ref_id}`, c] as const)).values()];
  const uncited = i.paragraphs.filter((p) => p.citations.length === 0).length;
  const rule6 = { finding: i.paragraphs.some((p) => p.text.includes(i.reference.reference)), ...i.elements };
  const signature_block: SignatureBlock = i.signature_block ?? { role: "officer", entity: i.servicer_number_owner, signer_id: null, signed_on: null };
  const sig = signatureBlockCheck(signature_block, i.servicer_number_owner);
  const body = { template: "EXAM-RESP-v1", header: { examiner: i.examiner, exam_id: i.exam_id, date: i.date, subject_entity: i.subject_entity, servicer_number_owner: i.servicer_number_owner, prepared_by: "supermortgage" }, request_reference: i.reference, response: i.paragraphs, evidence_citations: citations, signature_block };
  const checklist = [
    { id: "header_complete", ok: Boolean(i.examiner && i.exam_id && i.date) },
    { id: "request_reference", ok: Boolean(i.reference.reference) },
    { id: "every_paragraph_cites_a_record", ok: uncited === 0 && i.paragraphs.length > 0 },
    { id: "evidence_citations_present", ok: citations.length > 0 },
    { id: "officer_signature_block", ok: sig.ok, ...(sig.why ? { why: sig.why } : {}) },
    { id: "rule6_finding_root_cause_remediation_population_evidence", ok: Object.values(rule6).every(Boolean) },
  ];
  return { ...body, template: "EXAM-RESP-v1", header: { ...body.header, prepared_by: "supermortgage" }, signature_block, rule6_elements: rule6, checklist, draft_hash: sha256(JSON.stringify(body)) };
}

// ================================================================ findings → 18.1 (rule 6; T5)
export interface ExamFindingInput { readonly exam_id: string; readonly finding_ref: string; readonly text: string; readonly severity: "high" | "medium" | "low"; readonly taxonomy_nodes: readonly string[]; readonly cited_requirement: string; readonly alleged_violation: boolean; readonly loan_ids: readonly string[]; }
export interface EvidenceBundle {
  readonly contacts: readonly { contact_id: string; loan_id: string; on: PlainDate; mode: string; result: string; qrpc: boolean }[];
  readonly timers: readonly { timer_id: string; loan_id: string; code: string; status: string; due_date: PlainDate | null; satisfied_at: PlainDate | null }[];
}
export interface ExamFindingReceived {
  readonly case: { kind: "qc_finding"; case_id: string; source: "exam"; exam_id: string; finding_ref: string; loan_ids: string[]; taxonomy_nodes: string[]; status: "open"; root_cause_required: true; capa_due: PlainDate; opened_on: PlainDate };
  readonly finding_row: { exam_id: string; finding_ref: string; text: string; severity: string; taxonomy_nodes: string[]; response_document_id: null; qc_finding_case_id: string; remediation_due_at: PlainDate; status: "responding" };
  readonly timers: [{ code: "SM_EXAM_REMEDIATION_PLAN_15BD"; anchor: PlainDate; due: PlainDate; business_days: 15 }, { code: "FNMA_SCR_FINDING_RESPONSE_AS_STATED"; anchor_field: "response_due_stated"; due: PlainDate; basis: "as_stated" | "default_30_calendar_days" }];
  readonly event: { type: "exam.finding.received"; exam_id: string; finding_ref: string; received_at: PlainDate; response_due_stated: PlainDate; qc_finding_case_id: string };
  readonly draft: ExamResponseLetter;
  readonly review: ResponseReview;
}
/**
 * Rule 6: every examiner finding becomes a `qc_finding` case with CAPA (18.1: root cause required before
 * `capa_assigned`); the remediation plan is due in 15 BD (`SM_EXAM_REMEDIATION_PLAN_15BD`), the response by the
 * letter's stated date or 30 calendar days (`FNMA_SCR_FINDING_RESPONSE_AS_STATED`, computed anchor
 * `response_due_stated`); the draft response cites the `contacts` rows and the timer history of the affected loans.
 */
export function examFindingReceived(i: { finding: ExamFindingInput; received_on: PlainDate; stated_response_due: PlainDate | null; examiner: string; subject_entity: "partner" | "supermortgage" | "both"; servicer_number_owner: "partner" | "supermortgage"; evidence: EvidenceBundle; cal?: Calendar }): ExamFindingReceived {
  const f = i.finding; const cal = i.cal ?? servicer;
  const capaDue = findingCapaDue(i.received_on, cal);
  const responseDue = i.stated_response_due ?? addDays(i.received_on, 30);
  const caseId = `QCF-${f.exam_id}-${f.finding_ref}`;
  const loans = new Set(f.loan_ids);
  const contacts = i.evidence.contacts.filter((c) => loans.has(c.loan_id)); const timers = i.evidence.timers.filter((t) => loans.has(t.loan_id));
  const paragraphs: ResponseParagraph[] = [
    { text: `Finding ${f.finding_ref} (${f.cited_requirement}): ${f.text}`, citations: [{ ref_type: "cases", ref_id: caseId }] },
    ...contacts.map((c) => ({ text: `${c.on}: ${c.mode} contact on loan ${c.loan_id} — ${c.result}${c.qrpc ? " (QRPC established)" : ""}.`, citations: [{ ref_type: "contacts" as const, ref_id: c.contact_id }] })),
    ...timers.map((t) => ({ text: `${t.code} on loan ${t.loan_id}: ${t.status}${t.due_date ? ` (due ${t.due_date}` : ""}${t.satisfied_at ? `, satisfied ${t.satisfied_at})` : t.due_date ? ")" : ""}.`, citations: [{ ref_type: "timers" as const, ref_id: t.timer_id }] })),
  ];
  const draft = renderExamResponse({ examiner: i.examiner, exam_id: f.exam_id, date: i.received_on, subject_entity: i.subject_entity, servicer_number_owner: i.servicer_number_owner, reference: { reference: f.finding_ref, received_on: i.received_on, cited_requirement: f.cited_requirement }, paragraphs, elements: { root_cause: false, remediation: false, affected_population_with_count: false, evidence_of_correction: false } });
  return {
    case: { kind: "qc_finding", case_id: caseId, source: "exam", exam_id: f.exam_id, finding_ref: f.finding_ref, loan_ids: [...f.loan_ids], taxonomy_nodes: [...f.taxonomy_nodes], status: "open", root_cause_required: true, capa_due: capaDue, opened_on: i.received_on },
    finding_row: { exam_id: f.exam_id, finding_ref: f.finding_ref, text: f.text, severity: f.severity, taxonomy_nodes: [...f.taxonomy_nodes], response_document_id: null, qc_finding_case_id: caseId, remediation_due_at: capaDue, status: "responding" },
    timers: [{ code: "SM_EXAM_REMEDIATION_PLAN_15BD", anchor: i.received_on, due: capaDue, business_days: 15 }, { code: "FNMA_SCR_FINDING_RESPONSE_AS_STATED", anchor_field: "response_due_stated", due: responseDue, basis: i.stated_response_due ? "as_stated" : "default_30_calendar_days" }],
    event: { type: "exam.finding.received", exam_id: f.exam_id, finding_ref: f.finding_ref, received_at: i.received_on, response_due_stated: responseDue, qc_finding_case_id: caseId },
    draft,
    review: responseDraftReview({ draft, alleged_violation: f.alleged_violation, counsel_review: null }),
  };
}
/** "remediation plan approved (CAPA set in 18.1)" → `exam.remediation_plan.approved{qc_finding_case_id, approved_by_role=officer}` satisfies `SM_EXAM_REMEDIATION_PLAN_15BD`; a plan without CAPAs or without the officer does not. */
export function remediationPlanApproved(i: { exam_id: string; finding_ref: string; qc_finding_case_id: string; root_cause: string | null; capas: readonly { capa_id: string; action_kind: string; owner: string; due: PlainDate }[]; approved_by_role: string; approved_on: PlainDate }): { event: { type: "exam.remediation_plan.approved"; exam_id: string; finding_ref: string; qc_finding_case_id: string; capa_ids: string[]; approved_by_role: "officer"; approved_at: PlainDate } | null; refusal: string | null; case_status: "capa_assigned" | "validated" } {
  if (!i.root_cause) return { event: null, refusal: "18.1: root cause required before `capa_assigned`", case_status: "validated" };
  if (i.capas.length === 0) return { event: null, refusal: "remediation plan needs at least one CAPA with an owner and a due date (18.1)", case_status: "validated" };
  if (i.approved_by_role !== "officer") return { event: null, refusal: `remediation plan approval is an officer act; ${i.approved_by_role} refused`, case_status: "validated" };
  return { event: { type: "exam.remediation_plan.approved", exam_id: i.exam_id, finding_ref: i.finding_ref, qc_finding_case_id: i.qc_finding_case_id, capa_ids: i.capas.map((c) => c.capa_id), approved_by_role: "officer", approved_at: i.approved_on }, refusal: null, case_status: "capa_assigned" };
}
const FINDING_SEVERITIES: readonly ExamFindingInput["severity"][] = ["high", "medium", "low"];
/**
 * Event-store path (Inputs: `exam.finding.received`): an examiner's finding — from the Servicing Final Report, an SCR
 * letter or a CFPB/state report — is validated (ids, text, a known severity, dates in order, no second ingestion of
 * the same finding) and appended as `exam.finding.received{response_due_stated, qc_finding_case_id}`, which arms
 * `SM_EXAM_REMEDIATION_PLAN_15BD` on receipt and `FNMA_SCR_FINDING_RESPONSE_AS_STATED` on the stated date. The
 * mirrored `qc_finding` case, the `exam_findings` row and the EXAM-RESP-v1 draft ride on the result (rule 6).
 */
export function ingestExamFinding(events: EventStore, i: Parameters<typeof examFindingReceived>[0], actor: Actor = SYSTEM): ExamFindingReceived & { appended: DomainEvent } {
  const f = i.finding;
  if (!f.exam_id || !f.finding_ref) throw new RangeError("exam_id and finding_ref are required");
  if (!f.text) throw new RangeError("the finding's text is required (rule 6: the response cites the finding)");
  if (!FINDING_SEVERITIES.includes(f.severity)) throw new RangeError(`severity must be one of ${FINDING_SEVERITIES.join(", ")}`);
  if (!isDate(i.received_on)) throw new RangeError("received_on is required (PlainDate)");
  if (i.stated_response_due !== null && (!isDate(i.stated_response_due) || i.stated_response_due < i.received_on)) throw new RangeError(`stated_response_due ${i.stated_response_due} is not a date on or after receipt ${i.received_on}`);
  if (events.ofType("exam.finding.received").some((e) => e.payload.exam_id === f.exam_id && e.payload.finding_ref === f.finding_ref)) throw new RangeError(`finding ${f.exam_id}/${f.finding_ref} is already on record`);
  const r = examFindingReceived(i);
  return { ...r, appended: appendExamEvent(events, r.event, actor) };
}
/**
 * Event-store path: the remediation plan is approved by the `officer` actor itself (the actor's role, never a role the
 * input claims) for a finding on record; `exam.remediation_plan.approved{qc_finding_case_id, approved_by_role=officer}`
 * is appended only then — a plan without a root cause or CAPAs, or approved by anyone else, appends nothing.
 */
export function recordRemediationPlanApproval(events: EventStore, i: { exam_id: string; finding_ref: string; qc_finding_case_id: string; root_cause: string | null; capas: readonly { capa_id: string; action_kind: string; owner: string; due: PlainDate }[]; approved_on: PlainDate }, actor: Actor): { event: DomainEvent | null; refusal: string | null; case_status: "capa_assigned" | "validated" } {
  if (!i.exam_id || !i.finding_ref || !i.qc_finding_case_id) throw new RangeError("exam_id, finding_ref and qc_finding_case_id are required");
  if (!isDate(i.approved_on)) throw new RangeError("approved_on is required (PlainDate)");
  if (!events.ofType("exam.finding.received").some((e) => e.payload.exam_id === i.exam_id && e.payload.finding_ref === i.finding_ref)) return { event: null, refusal: `no \`exam.finding.received\` on record for ${i.exam_id}/${i.finding_ref}`, case_status: "validated" };
  const role = actor.kind === "human" ? (actor.role ?? "") : actor.kind;
  const r = remediationPlanApproved({ ...i, approved_by_role: role });
  if (!r.event) return { event: null, refusal: r.refusal, case_status: r.case_status };
  return { event: appendExamEvent(events, r.event, actor), refusal: null, case_status: r.case_status };
}

// ================================================================ guardrails on the response (T9)
/** A clause the examiner/finding/regulator is reported as making is the examiner's characterization, not ours. */
const ATTRIBUTED = /\b(examiner|finding|fannie mae|cfpb|regulator|report|letter|reviewer)\b[^.;]{0,40}\b(alleg\w*|assert\w*|contend\w*|state[sd]?|found|finds|cite[sd]?|claim\w*)\b/i;
/** Compliance characterizations — a verdict on whether the servicing met the law/Guide — however phrased. */
const COMPLIANCE_VERDICT = /\b(complied|compliance|compliant|non-?compliant|non-?compliance|violat(?:e|ed|es|ing|ion|ions)|met (?:every|all|each|the|its|our) (?:\w+ )?requirements?|satisf(?:y|ied|ies) (?:every|all|each|the|its|our)? ?(?:\w+ )?requirements?|adhered to|conform(?:ed|s) to|consistent with (?:the )?requirements?|(?:in )?accordance with (?:the )?requirements?|lawful(?:ly)?|unlawful(?:ly)?|permissible|impermissible|no (?:legal )?(?:deficiency|error of law))\b/i;
/**
 * The guardrail's detector: the shared mora.legalConclusionGuardrail (three cited phrases) plus every other
 * characterization of legal compliance — "compliant with D2-2-02", "did not violate §1024.41", "no violation of the
 * cadence occurred", "met every requirement of 12 CFR 1024.41(c)", "in compliance with Regulation X" — while a
 * clause attributed to the examiner ("the examiner alleges a violation") is the examiner's, not ours.
 */
export function legalConclusion18_2(text: string): { attorney: boolean; phrase: string | null; basis: "shared_guardrail" | "compliance_characterization" | null } {
  if (legalConclusionGuardrail(text) === "attorney") return { attorney: true, phrase: /\b(we complied with|in compliance with|no violation of)\s+§?\s*\d[^\s,.;]*/i.exec(text)?.[0] ?? text, basis: "shared_guardrail" };
  for (const sentence of text.split(/(?<=[.;])\s+/)) {
    if (ATTRIBUTED.test(sentence)) continue;
    const m = COMPLIANCE_VERDICT.exec(sentence);
    if (m) return { attorney: true, phrase: m[0], basis: "compliance_characterization" };
  }
  return { attorney: false, phrase: null, basis: null };
}
export type ReviewRefusal = "COUNSEL_REVIEW_REQUIRED" | "SIGNATURE_BLOCK_INVALID";
/** Counsel's review as recorded: who reviewed (role) and when. Only an `attorney` review counts — a date alone, or a review "recorded" by the officer or the agent, is not counsel review. */
export interface CounselReview { readonly reviewed_on: PlainDate; readonly reviewed_by_role: string; readonly reviewer_id?: string; }
/** True only for a review recorded by counsel (`attorney`), mirroring litigationHoldReleased: the role, not the date, is what lifts the gate. */
export const counselReviewed = (r: CounselReview | null | undefined): boolean => r !== null && r !== undefined && isDate(r.reviewed_on) && r.reviewed_by_role === "attorney";
export interface ResponseReview { readonly legal_conclusions: { paragraph: number; text: string; phrase: string }[]; readonly route: ("attorney" | "officer")[]; readonly escalations: QcEscalation[]; readonly officer_signature_allowed: boolean; readonly refusal: ReviewRefusal | null; readonly checklist_failures: string[]; readonly counsel_reviewed: boolean; }
/**
 * Guardrail: the agent never characterizes legal compliance in a response without counsel review when a finding
 * alleges a violation — a draft carrying a legal conclusion ("we complied with §1024.41") is routed to `attorney`
 * before `officer`; the officer signature is refused until counsel's review — an `attorney` act, never a date the
 * agent or the officer asserts — is recorded. A draft whose officer signature block fails the checklist cannot be
 * signed either.
 */
export function responseDraftReview(i: { draft: ExamResponseLetter; alleged_violation: boolean; counsel_review: CounselReview | null }): ResponseReview {
  const conclusions = i.draft.response.map((p, k) => ({ paragraph: k, text: p.text, detection: legalConclusion18_2(p.text) })).filter((p) => p.detection.attorney).map((p) => ({ paragraph: p.paragraph, text: p.text, phrase: p.detection.phrase ?? p.text }));
  const reviewed = counselReviewed(i.counsel_review);
  const counselFirst = (conclusions.length > 0 || i.alleged_violation) && !reviewed;
  const failures = i.draft.checklist.filter((c) => !c.ok && c.id === "officer_signature_block").map((c) => c.why ?? c.id);
  const route: ("attorney" | "officer")[] = counselFirst ? ["attorney", "officer"] : ["officer"];
  const notCounsel = i.counsel_review && !reviewed ? ` (review recorded by ${i.counsel_review.reviewed_by_role || "nobody"} is not a counsel review)` : "";
  const escalations: QcEscalation[] = [
    ...(counselFirst ? [{ kind: "attorney" as const, severity: "sev2" as const, reason: `${conclusions.length ? `legal conclusion in the draft response (${conclusions.map((c) => `¶${c.paragraph}: "${c.text}"`).join("; ")}) — counsel review before officer signature` : "finding alleges a violation — counsel review of the response before officer signature"}${notCounsel}` }] : []),
    { kind: "officer", severity: "sev2", reason: `${BASELINE_8_3}${counselFirst ? " — after counsel review" : ""}${failures.length ? ` — fix the signature block first: ${failures.join("; ")}` : ""}` },
  ];
  return { legal_conclusions: conclusions, route, escalations, officer_signature_allowed: !counselFirst && failures.length === 0, refusal: counselFirst ? "COUNSEL_REVIEW_REQUIRED" : failures.length ? "SIGNATURE_BLOCK_INVALID" : null, checklist_failures: failures, counsel_reviewed: reviewed };
}
export interface CounselReviewedEvent { readonly type: "exam.response.counsel_reviewed"; readonly exam_id: string; readonly reference: string; readonly draft_hash: string; readonly reviewed_by_role: "attorney"; readonly reviewer_id: string; readonly reviewed_at: PlainDate; }
/**
 * Counsel's review is an `attorney` act on a specific draft (its hash): `exam.response.counsel_reviewed`. Recorded by
 * anyone else it is refused — the escalation to `attorney` stands and the draft stays counsel-first.
 */
export function counselReviewRecorded(i: { exam_id: string; reference: string; draft: ExamResponseLetter; reviewed_on: PlainDate; reviewed_by_role: string; reviewer_id: string }): { event: CounselReviewedEvent | null; review: CounselReview | null; refusal: "NOT_COUNSEL" | null } {
  if (i.reviewed_by_role !== "attorney") return { event: null, review: null, refusal: "NOT_COUNSEL" };
  return { event: { type: "exam.response.counsel_reviewed", exam_id: i.exam_id, reference: i.reference, draft_hash: i.draft.draft_hash, reviewed_by_role: "attorney", reviewer_id: i.reviewer_id, reviewed_at: i.reviewed_on }, review: { reviewed_on: i.reviewed_on, reviewed_by_role: "attorney", reviewer_id: i.reviewer_id }, refusal: null };
}
/**
 * Event-store path: counsel's review of a draft is recorded by the `attorney` actor itself — the actor's role, never a
 * role the input claims — as `exam.response.counsel_reviewed{draft_hash}`; any other actor is refused and nothing is
 * appended. Mirrors litigationHoldReleased: the act, not a date, lifts the gate.
 */
export function recordCounselReview(events: EventStore, i: { exam_id: string; reference: string; draft: ExamResponseLetter; reviewed_on: PlainDate }, actor: Actor): { event: DomainEvent | null; review: CounselReview | null; refusal: "NOT_COUNSEL" | null } {
  if (!i.exam_id || !i.reference) throw new RangeError("exam_id and reference are required");
  if (!isDate(i.reviewed_on)) throw new RangeError("reviewed_on is required (PlainDate)");
  const role = actor.kind === "human" ? (actor.role ?? "") : actor.kind;
  const r = counselReviewRecorded({ exam_id: i.exam_id, reference: i.reference, draft: i.draft, reviewed_on: i.reviewed_on, reviewed_by_role: role, reviewer_id: actor.id });
  if (!r.event) return { event: null, review: null, refusal: r.refusal };
  return { event: appendExamEvent(events, r.event, actor), review: r.review, refusal: null };
}
/** The counsel review on record for exactly this draft (same exam, reference and draft hash — an edit after counsel's review is unreviewed); null when there is none. */
export function counselReviewOnRecord(events: EventStore, i: { exam_id: string; reference: string; draft_hash: string }): CounselReview | null {
  const ev = events.ofType("exam.response.counsel_reviewed").find((e) => e.payload.exam_id === i.exam_id && e.payload.reference === i.reference && e.payload.draft_hash === i.draft_hash && e.payload.reviewed_by_role === "attorney");
  if (!ev || !isDate(ev.payload.reviewed_at)) return null;
  return { reviewed_on: ev.payload.reviewed_at, reviewed_by_role: "attorney", reviewer_id: String(ev.payload.reviewer_id ?? "") };
}
export type ReleaseRefusal = ReviewRefusal | "OFFICER_SIGNATURE_REQUIRED" | "PARTNER_OFFICER_SIGNS";
/** No communication leaves without `officer` signature; the partner's officer signs anything submitted under the partner's servicer number; counsel first where the review says so. */
export function releaseGate(i: { review: ResponseReview; signed_by_role: string | null; signer_entity: "partner" | "supermortgage" | null; servicer_number_owner: "partner" | "supermortgage" }): { allowed: boolean; refusal: ReleaseRefusal | null; citation: string } {
  if (!i.review.officer_signature_allowed) return i.review.refusal === "SIGNATURE_BLOCK_INVALID"
    ? { allowed: false, refusal: "SIGNATURE_BLOCK_INVALID", citation: `${BASELINE_8_3}; ${i.review.checklist_failures.join("; ")}` }
    : { allowed: false, refusal: "COUNSEL_REVIEW_REQUIRED", citation: "§18.2 guardrails: the agent never characterizes legal compliance in a response without counsel review when a finding alleges a violation" };
  if (i.signed_by_role !== "officer") return { allowed: false, refusal: "OFFICER_SIGNATURE_REQUIRED", citation: BASELINE_8_3 };
  if (i.servicer_number_owner === "partner" && i.signer_entity !== "partner") return { allowed: false, refusal: "PARTNER_OFFICER_SIGNS", citation: "§18.2 guardrails: the partner's officer signs anything submitted under the partner's servicer number" };
  return { allowed: true, refusal: null, citation: BASELINE_8_3 };
}
/** The signed response goes out → `exam.finding.responded{response_document_id}` satisfies `FNMA_SCR_FINDING_RESPONSE_AS_STATED`. */
export function findingResponseSubmitted(i: { exam_id: string; finding_ref: string; review: ResponseReview; signed_by_role: string | null; signer_entity: "partner" | "supermortgage" | null; servicer_number_owner: "partner" | "supermortgage"; response_document_id: string | null; submitted_on: PlainDate }): { event: { type: "exam.finding.responded"; exam_id: string; finding_ref: string; response_document_id: string; submitted_at: PlainDate } | null; refusal: ReleaseRefusal | "RESPONSE_DOCUMENT_REQUIRED" | null } {
  const gate = releaseGate({ review: i.review, signed_by_role: i.signed_by_role, signer_entity: i.signer_entity, servicer_number_owner: i.servicer_number_owner });
  if (!gate.allowed) return { event: null, refusal: gate.refusal };
  if (!i.response_document_id) return { event: null, refusal: "RESPONSE_DOCUMENT_REQUIRED" };
  return { event: { type: "exam.finding.responded", exam_id: i.exam_id, finding_ref: i.finding_ref, response_document_id: i.response_document_id, submitted_at: i.submitted_on }, refusal: null };
}
/**
 * Event-store path behind `letters.render op=release`: the officer actor's release of an EXAM-RESP-v1 letter (the
 * actor's role, never a role the input claims) for a finding on record appends `exam.finding.responded
 * {response_document_id}` — the stored, signed letter — which satisfies `FNMA_SCR_FINDING_RESPONSE_AS_STATED`. The
 * release gate (counsel first where the review says so; officer signature; the partner's officer under the partner's
 * number) is re-asserted here so a release that reaches the store without the bus is held to the same rules.
 */
export function recordFindingResponse(events: EventStore, i: { exam_id: string; finding_ref: string; review: ResponseReview; signer_entity: "partner" | "supermortgage" | null; servicer_number_owner: "partner" | "supermortgage"; response_document_id: string | null; submitted_on: PlainDate }, actor: Actor): { event: DomainEvent | null; refusal: ReleaseRefusal | "RESPONSE_DOCUMENT_REQUIRED" | "NO_FINDING_ON_RECORD" | null } {
  if (!i.exam_id || !i.finding_ref) throw new RangeError("exam_id and finding_ref are required");
  if (!isDate(i.submitted_on)) throw new RangeError("submitted_on is required (PlainDate)");
  if (!events.ofType("exam.finding.received").some((e) => e.payload.exam_id === i.exam_id && e.payload.finding_ref === i.finding_ref)) return { event: null, refusal: "NO_FINDING_ON_RECORD" };
  const role = actor.kind === "human" ? (actor.role ?? "") : actor.kind;
  const r = findingResponseSubmitted({ ...i, signed_by_role: role });
  if (!r.event) return { event: null, refusal: r.refusal };
  return { event: appendExamEvent(events, r.event, actor), refusal: null };
}

// ================================================================ remedy demand → 5.x ladder (T6)
export interface ExamRecord { readonly id: string; readonly status: string; readonly repurchase_case_id: string | null; }
export type RemedyDemand = { kind: "repurchase" | "make_whole" | "compensatory_fee"; fnma_loan_number: string; amount_cents: Cents };
/**
 * `exam.remedy_demand.received`: the demand is handed to the Section 5.x repurchase/appeal ladder — the 5.6 row
 * `FNMA_A1302_APPEAL1_60` is armed by `repurchase.demand.received` (60 calendar days from receipt, A1-3-02) — and the
 * exam record moves to the side state `disputed` linked to the repurchase case. No ledger posting here: remedies flow
 * through Section 5.x.
 */
export function examRemedyDemand(i: { exam: ExamRecord; received_on: PlainDate; demand: RemedyDemand; repurchase_case_id: string }): {
  exam: ExamRecord;
  hand_off: ReturnType<typeof remedyDemandReceived>;
  ladder_event: { type: "repurchase.demand.received"; repurchase_case_id: string; exam_id: string; received_at: PlainDate; demand_kind: RemedyDemand["kind"]; amount_cents: Cents };
} {
  const hand_off = remedyDemandReceived({ exam_id: i.exam.id, received_on: i.received_on, demand: i.demand, repurchase_case_id: i.repurchase_case_id });
  return {
    exam: { id: i.exam.id, status: hand_off.exam_status, repurchase_case_id: i.repurchase_case_id },
    hand_off,
    ladder_event: { type: "repurchase.demand.received", repurchase_case_id: i.repurchase_case_id, exam_id: i.exam.id, received_at: i.received_on, demand_kind: i.demand.kind, amount_cents: i.demand.amount_cents },
  };
}
const REMEDY_KINDS: readonly RemedyDemand["kind"][] = ["repurchase", "make_whole", "compensatory_fee"];
/**
 * Event-store path (Inputs: `exam.remedy_demand.received` → Section 5.x): the demand received with the report is
 * validated (a known kind, a Fannie Mae loan number, a non-negative amount in cents, the repurchase case it is handed
 * to) and two events are appended — `exam.remedy_demand.received` under the exam (the `disputed` side state) and
 * `repurchase.demand.received` under the repurchase case, which arms the 5.6 `FNMA_A1302_APPEAL1_60` row.
 */
export function ingestRemedyDemand(events: EventStore, i: { exam: ExamRecord; received_on: PlainDate; demand: RemedyDemand; repurchase_case_id: string; loan_id: string; demand_document_id: string; now: string }, actor: Actor = SYSTEM): ReturnType<typeof examRemedyDemand> & { appended: [DomainEvent, DomainEvent]; ladder: ReturnType<typeof ingestRepurchaseDemand> } {
  if (!i.exam.id || !i.repurchase_case_id) throw new RangeError("exam.id and repurchase_case_id are required");
  if (!i.loan_id || !i.demand_document_id) throw new RangeError("loan_id and demand_document_id are required (the 5.6 demand intake boards the demand letter under the loan)");
  if (!isDate(i.received_on)) throw new RangeError("received_on is required (PlainDate)");
  if (!REMEDY_KINDS.includes(i.demand.kind)) throw new RangeError(`demand.kind must be one of ${REMEDY_KINDS.join(", ")}`);
  if (i.demand.kind === "compensatory_fee") throw new RangeError("a compensatory-fee demand is not a repurchase/make-whole demand — it follows the Section 5.x compensatory-fee path, not the 5.6 repurchase ladder (ops-5-6 DemandKind)");
  if (!i.demand.fnma_loan_number) throw new RangeError("demand.fnma_loan_number is required");
  if (typeof i.demand.amount_cents !== "bigint" || i.demand.amount_cents < 0n) throw new RangeError("demand.amount_cents must be a non-negative bigint");
  const r = examRemedyDemand(i);
  const { type: examType, ...examPayload } = r.hand_off.event;
  const first = events.append({ type: examType, loanId: i.loan_id, aggregate: { kind: "exam", id: i.exam.id }, actor, payload: { ...examPayload, received_at: i.received_on, demand_kind: i.demand.kind, fnma_loan_number: i.demand.fnma_loan_number, amount_cents: i.demand.amount_cents.toString(), demand_document_id: i.demand_document_id, exam_status: r.exam.status } });
  // The 5.6 intake is the ladder: `repurchase.demand.received{received_at, pay_by, first_appeal_by}` under the repurchase case arms FNMA_A1302_APPEAL1_60 (and the pay-by row) exactly as a demand received outside an exam would.
  const ladder = ingestRepurchaseDemand({ events, actor, now: i.now }, { repurchase_id: i.repurchase_case_id, loan_id: i.loan_id, received_on: i.received_on, demand_kind: i.demand.kind, amount_cents: i.demand.amount_cents, demand_document_id: i.demand_document_id });
  return { ...r, appended: [first, ladder.event], ladder };
}

// ================================================================ litigation hold (T8)
/**
 * Gate behind `SM_EXAM_LITIGATION_HOLD` (not-before gate, "until released by counsel"): a retention purge of a scoped
 * record may proceed only once counsel (`attorney`) has recorded the release. A release recorded by anyone else — the
 * officer, the agent — leaves the gate closed.
 */
export function litigationHoldReleased(i: { released_by_counsel_on: PlainDate | null; released_by_role: string | null }): { open: boolean; reason?: string } {
  if (i.released_by_counsel_on && i.released_by_role === "attorney") return { open: true };
  if (i.released_by_counsel_on) return { open: false, reason: `SM_EXAM_LITIGATION_HOLD: release recorded by ${i.released_by_role ?? "unknown"} is not a counsel release — scoped records stay held` };
  return { open: false, reason: "SM_EXAM_LITIGATION_HOLD: retention purge blocked for scoped records until released by counsel" };
}
export interface LitigationHoldRecord { readonly code: "SM_EXAM_LITIGATION_HOLD"; readonly source: "subpoena" | "litigation_discovery"; readonly scope_loan_ids: readonly string[]; readonly received_on: PlainDate; readonly released_by_counsel_on: PlainDate | null; readonly released_by_role: string | null; readonly active: boolean; readonly gate: { open: boolean; reason?: string }; }
/** A subpoena or discovery notice holds the scoped loans' records; `active` is the counsel-only gate, not the mere presence of a release date (the ops.ts `litigationHold` ignores who released). */
export function litigationHoldRecord(i: { source: "subpoena" | "litigation_discovery"; scope_loan_ids: readonly string[]; received_on: PlainDate; released_by_counsel_on?: PlainDate | null; released_by_role?: string | null }): LitigationHoldRecord {
  const gate = litigationHoldReleased({ released_by_counsel_on: i.released_by_counsel_on ?? null, released_by_role: i.released_by_role ?? null });
  return { code: "SM_EXAM_LITIGATION_HOLD", source: i.source, scope_loan_ids: [...i.scope_loan_ids], received_on: i.received_on, released_by_counsel_on: i.released_by_counsel_on ?? null, released_by_role: i.released_by_role ?? null, active: !gate.open, gate };
}
/** `exam.notice.received{source∈{litigation_discovery, subpoena}}` — the event that arms the hold gate (no due date). */
export function litigationNoticeEvent(i: { exam_id: string; source: "subpoena" | "litigation_discovery"; received_on: PlainDate; scope_loan_ids: readonly string[]; document_id: string }): ExamNoticeEvent & { scope_loan_ids: string[] } {
  return { type: "exam.notice.received", exam_id: i.exam_id, source: i.source, review_type: "discovery", notified_on: i.received_on, received_at: i.received_on, stated_due: null, due_at: null, internal_target_at: null, document_id: i.document_id, scope_loan_ids: [...i.scope_loan_ids] };
}
/**
 * Event-store path (Inputs: `exam.notice.received{source=litigation_discovery}` or a subpoena, from the mailroom or
 * counsel): the inbound record is validated (a litigation source, the served document, at least one scoped loan, no
 * duplicate loans) and `exam.notice.received{source}` is appended under the exam — the event the
 * `SM_EXAM_LITIGATION_HOLD` not-before gate is armed by; the hold record the purge job consumes rides on the result.
 */
export function ingestLitigationNotice(events: EventStore, i: { exam_id: string; source: "subpoena" | "litigation_discovery"; received_on: PlainDate; scope_loan_ids: readonly string[]; document_id: string }, actor: Actor = SYSTEM): { hold: LitigationHoldRecord; event: ReturnType<typeof litigationNoticeEvent>; appended: DomainEvent } {
  if (!i.exam_id) throw new RangeError("exam_id is required");
  if (i.source !== "subpoena" && i.source !== "litigation_discovery") throw new RangeError("source must be subpoena or litigation_discovery (§18.2 timer table: SM_EXAM_LITIGATION_HOLD)");
  if (!i.document_id) throw new RangeError("document_id is required (the subpoena / discovery notice in `documents`)");
  if (!isDate(i.received_on)) throw new RangeError("received_on is required (PlainDate)");
  if (i.scope_loan_ids.length === 0) throw new RangeError("a litigation hold names at least one scoped loan");
  if (new Set(i.scope_loan_ids).size !== i.scope_loan_ids.length) throw new RangeError("duplicate loans in scope_loan_ids");
  const event = litigationNoticeEvent(i);
  return { hold: litigationHoldRecord({ source: i.source, scope_loan_ids: i.scope_loan_ids, received_on: i.received_on }), event, appended: appendExamEvent(events, event, actor) };
}
export const RETENTION_FLOOR_GATE = "17.3.retentionFloorElapsed" as const;
export interface LegalHoldFacts { readonly legal_hold: boolean; readonly hold_count: number; readonly legal_hold_code: "SM_EXAM_LITIGATION_HOLD" | null; readonly legal_hold_source: "subpoena" | "litigation_discovery" | null; readonly legal_hold_reason: string | null; }
/** The `legal_hold` fact the platform's retention gates consume (17.3 `retentionFloorElapsed`; 19.1 `retention().hold_count`), derived from the open 18.2 holds on a loan. */
export function legalHoldFacts(holds: readonly LitigationHoldRecord[], loanId: string): LegalHoldFacts {
  const active = holds.filter((h) => h.scope_loan_ids.includes(loanId) && !litigationHoldReleased({ released_by_counsel_on: h.released_by_counsel_on, released_by_role: h.released_by_role }).open);
  const h = active[0];
  return { legal_hold: h !== undefined, hold_count: active.length, legal_hold_code: h ? "SM_EXAM_LITIGATION_HOLD" : null, legal_hold_source: h ? h.source : null, legal_hold_reason: h ? `${h.source} hold received ${h.received_on} — ${h.gate.reason ?? "released only by counsel"}` : null };
}
export interface RetentionFacts { readonly transfer_date?: PlainDate | null; readonly retain_until?: PlainDate | null; }
export interface RetentionPurge {
  readonly purged: string[];
  readonly blocked: { loan_id: string; hold_code: "SM_EXAM_LITIGATION_HOLD" | null; gate: "SM_EXAM_LITIGATION_HOLD" | typeof RETENTION_FLOOR_GATE; reason: string }[];
  readonly facts: Record<string, Record<string, unknown>>;
}
/**
 * The retention purge job: for every loan it builds the retention facts — the loan's transfer/retain-until facts plus
 * `legal_hold` from the open 18.2 holds — and asserts the platform's retention gate (17.3 `retentionFloorElapsed`,
 * which refuses on `legal_hold` before it even looks at the one-year floor); a loan with no transfer facts is gated
 * by the hold alone. Held loans are refused with the gate's reason, the rest proceed.
 */
export function retentionPurge(i: { loan_ids: readonly string[]; holds: readonly LitigationHoldRecord[]; today?: PlainDate; retention_facts?: Readonly<Record<string, RetentionFacts>> }): RetentionPurge {
  const purged: string[] = []; const blocked: RetentionPurge["blocked"] = []; const facts: Record<string, Record<string, unknown>> = {};
  const floor = EVALUATORS_17_3[RETENTION_FLOOR_GATE]!;
  for (const id of i.loan_ids) {
    const hold = legalHoldFacts(i.holds, id); const r = i.retention_facts?.[id];
    const f: Record<string, unknown> = { loan_id: id, ...(i.today ? { today: i.today } : {}), ...(r?.transfer_date ? { transfer_date: r.transfer_date } : {}), ...(r?.retain_until ? { retain_until: r.retain_until } : {}), ...hold };
    facts[id] = f;
    if (typeof f.transfer_date === "string" && typeof f.today === "string") {
      const g = floor(f);
      if (!g.open) { blocked.push({ loan_id: id, hold_code: hold.legal_hold_code, gate: RETENTION_FLOOR_GATE, reason: `retention purge refused (${RETENTION_FLOOR_GATE}): ${g.reason ?? "closed"}${hold.legal_hold_reason ? ` — ${hold.legal_hold_reason}` : ""}` }); continue; }
      purged.push(id); continue;
    }
    if (hold.legal_hold) { blocked.push({ loan_id: id, hold_code: "SM_EXAM_LITIGATION_HOLD", gate: "SM_EXAM_LITIGATION_HOLD", reason: `retention purge refused: ${hold.legal_hold_reason}` }); continue; }
    purged.push(id);
  }
  return { purged, blocked, facts };
}
export { A2_4_01, A2_4_1_02 };
