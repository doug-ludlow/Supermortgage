// 18.2 Fannie Mae MORA reviews
// spec/sections/18-qc-audit-regulatory-reporting/18-2-fannie-mae-mora-reviews.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { plainDate as D, isWeekend, type PlainDate } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt, federal, servicer } from "../../kernel/calendar/business.ts";
import { FixedClock, MemoryEventStore, SYSTEM, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { SPEC_TOOLS_18_2, TOOLS_18_2 } from "../../app/tools/section18-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { REVIEW_FILE_SECTIONS, compileReviewFile, manifestMatches, type ReviewFileInput } from "./ops.ts";
import { allowable as e3215Allowable } from "../foreclosure/timeframes.ts";
import { EVALUATORS_17_3 } from "../transfers/evaluators-17-3.ts";
import { examClocks, legalConclusionGuardrail, privilegeExcluded } from "./mora.ts";
import { qcResultsDelivered } from "./ops-18-1.ts";
import {
  type EvidenceBundle, type ExamFindingInput, type ExamNotice, type ProductionDocument, type ResponseParagraph, type SweepRequest,
  counselReviewOnRecord, counselReviewRecorded, counselReviewed, examClocks18_2, examDeadlineSweep, examFindingReceived, examRemedyDemand, examRequestReceived, examinerContact, extensionRequest, findingResponseSubmitted, foreclosureLogFromExhibit,
  ingestExamFinding, ingestExamNotice, ingestExamRequest, ingestLitigationNotice, ingestRemedyDemand, internalNotification, latestPackageAssembled, legalConclusion18_2, legalHoldFacts, litigationHoldRecord, litigationHoldReleased, litigationNoticeEvent, officerApproval, openRequestNos, packageApprovalOnRecord, packageAssembled, packageReviewWindow, privilegeScreen,
  productionCompleteness, recordCounselReview, recordFindingResponse, recordInternalNotification, recordPackageApproval, recordRemediationPlanApproval, recordSubmission, releaseGate, remediationPlanApproved, renderExamResponse, responseDraftReview, retentionPurge, reviewFileQa, scopeNotice, signatureBlockCheck, statedBusinessDayDeadline, submissionRecorded,
} from "./ops-18-2.ts";
import { EVALUATORS_18_2 } from "./evaluators-18-2.ts";
import { applyQcAuditTimerOverrides } from "./timers.ts";
import { applyInvestorTimerOverrides } from "../investor/timers.ts";

// ---- harness: the real registry with the section overrides, driven through the TimerEngine by the events ops-18-2 emits
const overridden = () => { const reg = loadRegistry(); applyQcAuditTimerOverrides(reg); return reg; };
function engine(nowIso = "2026-10-16T14:00:00.000Z") { const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const reg = overridden(); return { events, timers: new TimerEngine(reg, events, { processes: ["18.2"] }), reg, clock }; }
/** Append an ops-18-2 event under an aggregate; an event that names a `loan_id` is a per-loan event (the engine's subject is then the loan). */
const emit = <E extends { readonly type: string }>(events: MemoryEventStore, ev: E, aggregate: { kind: string; id: string }) => { const { type, ...payload } = ev as { type: string } & Record<string, unknown>; return events.append({ type, aggregate, ...(typeof payload.loan_id === "string" ? { loanId: payload.loan_id } : {}), actor: SYSTEM, payload }); };
const EXAM = { kind: "exam", id: "EX-2026-07" };
const EXAMINER = "Fannie Mae SF CPM division";
/** A hand count that ignores holidays: every weekday is a business day. */
const weekdaysOnly: Calendar = { unit: "calendar_days", timeZone: "UTC", isBusinessDay: (d) => !isWeekend(d) };

test("18.2-T1: Given an LQC servicing-review notice dated 2026-10-16 for 25 loans, then 25 `exam_requests` exist with `due_at = 2026-11-15`, internal target 2026-11-13, warnings at 2026-10-31 and 2026-11-09.", () => {
  // Given: an LQC servicing-review notice dated Fri 2026-10-16 naming 25 Fannie Mae loan numbers, all on the platform.
  const numbers = Array.from({ length: 25 }, (_, k) => String(1234567800 + k));
  const loans = numbers.map((n, k) => ({ loan_id: `L-${100 + k}`, fnma_loan_number: n }));
  const notice: ExamNotice = { exam_id: "EX-2026-07", source: "fnma_lqc", review_type: "servicing_review", examiner: EXAMINER, subject_entity: "partner", notified_on: D("2026-10-16"), received_on: D("2026-10-16"), stated_due: null, fnma_loan_numbers: numbers, taxonomy_nodes: ["a1103.collections", "a1103.loss_mitigation"], notice_document_id: "doc-lqc-1" };
  const s = scopeNotice({ notice, loans, scoped_on: D("2026-10-19") });
  // Then: 25 exam_requests, one per loan, each with due_at 2026-11-15 (day 30, a Sunday — no roll-forward), internal target 2026-11-13, warnings 2026-10-31 / 2026-11-09.
  assert.equal(s.requests.length, 25);
  for (const r of s.requests) {
    assert.equal(r.due_at, D("2026-11-15")); assert.equal(r.internal_target_at, D("2026-11-13")); assert.equal(r.warn_50_at, D("2026-10-31")); assert.equal(r.warn_80_at, D("2026-11-09"));
    // Officer-review gate on business days: approval ≥1 BD before the Sunday due date → Fri 11-13; the officer has 3 BD → the package is assembled by Mon 2026-11-09
    // (Wed 2026-11-11, Veterans Day, is not a business day). The spec's worked figure "assembled by 2026-11-10" is the weekday-only count — spec discrepancy, calendar-correct value kept.
    assert.equal(r.approve_by_at, D("2026-11-13")); assert.equal(r.officer_gate_at, D("2026-11-09"));
    assert.equal(r.status, "open"); assert.equal(r.loan_ids.length, 1); assert.equal(r.exam_id, "EX-2026-07"); assert.deepEqual(r.taxonomy_nodes, ["a1103.collections", "a1103.loss_mitigation"]); assert.equal(r.submitted_at, null);
  }
  assert.equal(servicer.isBusinessDay(D("2026-11-11")), false); assert.equal(fannieEt.isBusinessDay(D("2026-11-11")), false);
  assert.equal(addBusinessDays(D("2026-11-13"), -3, servicer), D("2026-11-09")); assert.equal(addBusinessDays(D("2026-11-13"), -3, weekdaysOnly), D("2026-11-10"), "the spec's 11-10 counts Veterans Day as a business day");
  assert.equal(examClocks(D("2026-10-16")).officer_gate, D("2026-11-10"), "the shared mora.examClocks reproduces the spec figure (3 calendar days before the target) — corrected in examClocks18_2");
  assert.deepEqual(s.requests.slice(0, 3).map((r) => [r.request_no, r.fnma_loan_number, r.loan_ids[0]]), [["R-001", "1234567800", "L-100"], ["R-002", "1234567801", "L-101"], ["R-003", "1234567802", "L-102"]]);
  assert.equal(new Set(s.requests.map((r) => r.loan_ids[0])).size, 25);
  assert.equal(fannieEt.isBusinessDay(D("2026-11-15")), false); assert.equal(s.clocks.due, D("2026-11-15")); assert.equal(s.clocks.internal_target, D("2026-11-13")); assert.equal(s.clocks.approve_by, D("2026-11-13")); assert.equal(s.clocks.officer_gate, D("2026-11-09"));
  assert.equal(s.exam.status, "scoped"); assert.equal(s.exam.scope.loan_ids.length, 25); assert.deepEqual(s.unknown_loan_numbers, []); assert.equal(s.examiner_query, null); assert.deepEqual(s.escalations, []);
  assert.deepEqual(s.timers.find((t) => t.code === "FNMA_A2401_REVIEW_FILE_30"), { code: "FNMA_A2401_REVIEW_FILE_30", anchor: D("2026-10-16"), due: D("2026-11-15"), warn_50: D("2026-10-31"), warn_80: D("2026-11-09") });
  assert.deepEqual(s.timers.find((t) => t.code === "SM_EXAM_SCOPE_5BD"), { code: "SM_EXAM_SCOPE_5BD", anchor: D("2026-10-16"), due: D("2026-10-23") });
  assert.deepEqual(s.timers.find((t) => t.code === "SM_EXAM_INTERNAL_NOTIFY_2BD"), { code: "SM_EXAM_INTERNAL_NOTIFY_2BD", anchor: D("2026-10-16"), due: D("2026-10-20") });
  assert.deepEqual(s.timers.find((t) => t.code === "EXAM_REQUEST_DUE_AS_STATED"), { code: "EXAM_REQUEST_DUE_AS_STATED", anchor: D("2026-11-15"), due: D("2026-11-15"), warn_50: D("2026-10-31"), warn_80: D("2026-11-09"), instances: 25 });
  // The notice is an examiner contact, a notice, one request item per loan, and the transition to `scoped` — in that order.
  assert.deepEqual(s.events.map((e) => e.type), ["exam.contact.received", "exam.notice.received", ...Array(25).fill("exam.request.received"), "exam.scoped"]);
  assert.equal(s.notice_event.due_at, D("2026-11-15")); assert.equal(s.notice_event.internal_target_at, D("2026-11-13")); assert.equal(s.contact_event.channel, "lqc_email");
  assert.deepEqual(s.request_events[0], { type: "exam.request.received", exam_id: "EX-2026-07", request_no: "R-001", source: "fnma_lqc", loan_id: "L-100", due_at: D("2026-11-15"), received_at: D("2026-10-16") });
  // The events arm the registry rows: the contact arms SM_EXAM_INTERNAL_NOTIFY_2BD (receipt + 2 BD), the notice arms FNMA_A2401_REVIEW_FILE_30 on its rule-4 `due_at` and SM_EXAM_SCOPE_5BD on receipt + 5 BD,
  // each request item arms EXAM_REQUEST_DUE_AS_STATED for its loan; `exam.scoped` satisfies the scope clock and leaves the others running.
  const { events, timers } = engine();
  for (const ev of s.events.slice(0, -1)) emit(events, ev, EXAM);
  const notify = timers.byCode("SM_EXAM_INTERNAL_NOTIFY_2BD")[0]!; assert.equal(notify.status, "armed"); assert.equal(notify.anchorDate, D("2026-10-16")); assert.equal(notify.dueDate, D("2026-10-20"));
  const file30 = timers.byCode("FNMA_A2401_REVIEW_FILE_30")[0]!; assert.equal(file30.status, "armed"); assert.equal(file30.anchorDate, D("2026-11-15")); assert.equal(file30.dueDate, D("2026-11-15"));
  const scope = timers.byCode("SM_EXAM_SCOPE_5BD")[0]!; assert.equal(scope.anchorDate, D("2026-10-16")); assert.equal(scope.dueDate, D("2026-10-23"));
  const perLoan = timers.byCode("EXAM_REQUEST_DUE_AS_STATED"); assert.equal(perLoan.length, 25);
  assert.ok(perLoan.every((t) => t.status === "armed" && t.dueDate === D("2026-11-15") && t.subject.kind === "loan")); assert.equal(new Set(perLoan.map((t) => t.subject.id)).size, 25);
  emit(events, s.scoped_event, EXAM);
  assert.equal(scope.status, "satisfied"); assert.equal(file30.status, "armed"); assert.equal(notify.status, "armed");
  emit(events, internalNotification({ exam_id: "EX-2026-07", partner_notified_on: D("2026-10-16"), officer_notified_on: D("2026-10-19") }).event!, EXAM); assert.equal(notify.status, "satisfied");
  // R-001's LQC submission satisfies its own loan's request clock only; the exam-level A2-4-01 clock closes on the submission that leaves no request open.
  emit(events, submissionRecorded({ exam_id: "EX-2026-07", request_no: "R-001", loan_id: "L-100", channel: "fnma_lqc", submitted_on: D("2026-11-12"), confirmation_id: "LQC-88201", evidence_document_id: "doc-lqc-shot-1", open_requests_after: 24 }).event!, EXAM);
  assert.equal(perLoan.find((t) => t.subject.id === "L-100")!.status, "satisfied"); assert.equal(perLoan.filter((t) => t.status === "armed").length, 24); assert.equal(file30.status, "armed");
  emit(events, submissionRecorded({ exam_id: "EX-2026-07", request_no: "R-025", loan_id: "L-124", channel: "fnma_lqc", submitted_on: D("2026-11-13"), confirmation_id: "LQC-88225", evidence_document_id: "doc-lqc-shot-25", open_requests_after: 0 }).event!, EXAM);
  assert.equal(file30.status, "satisfied"); assert.equal(perLoan.filter((t) => t.status === "armed").length, 23);
  // The platform path — ingestExamNotice (LQC e-mail / mailroom / partner forward) — appends the same 28 events to the store, each per-loan request under its loan, so the engine arms the 25 rows per loan without a harness convention;
  // recordSubmission derives the count of still-open requests from the store's own history (never from the caller), so the exam-level A2-4-01 clock closes only on the submission that leaves none open.
  const live = engine();
  const ing = ingestExamNotice(live.events, { notice, loans, scoped_on: D("2026-10-19") });
  assert.deepEqual(ing.appended.map((e) => e.type), s.events.map((e) => e.type)); assert.equal(ing.appended.length, 28);
  assert.deepEqual(ing.appended.slice(2, 27).map((e) => e.loanId), loans.map((l) => l.loan_id)); assert.equal(ing.appended[1]!.loanId, undefined); assert.deepEqual(ing.appended[1]!.aggregate, { kind: "exam", id: "EX-2026-07" });
  assert.equal(live.timers.byCode("SM_EXAM_SCOPE_5BD")[0]!.status, "satisfied"); assert.equal(live.timers.byCode("SM_EXAM_INTERNAL_NOTIFY_2BD")[0]!.status, "armed");
  // The exam response protocol's internal notification is recorded against the contact on record: partial → nothing appended; both notified → `exam.notice.acknowledged` satisfies the 2-BD row; an exam with no contact on record is refused.
  const partial = recordInternalNotification(live.events, { exam_id: "EX-2026-07", partner_notified_on: D("2026-10-16"), officer_notified_on: null });
  assert.equal(partial.event, null); assert.deepEqual(partial.missing, ["officer"]); assert.equal(live.timers.byCode("SM_EXAM_INTERNAL_NOTIFY_2BD")[0]!.status, "armed");
  assert.match(recordInternalNotification(live.events, { exam_id: "EX-2026-99", partner_notified_on: D("2026-10-16"), officer_notified_on: D("2026-10-19") }).refusal!, /no `exam.contact.received` on record/);
  const acked = recordInternalNotification(live.events, { exam_id: "EX-2026-07", partner_notified_on: D("2026-10-16"), officer_notified_on: D("2026-10-19") });
  assert.equal(acked.event!.type, "exam.notice.acknowledged"); assert.deepEqual([acked.event!.payload.partner_notified, acked.event!.payload.officer_notified, acked.event!.payload.acknowledged_at], [true, true, "2026-10-19"]); assert.equal(live.timers.byCode("SM_EXAM_INTERNAL_NOTIFY_2BD")[0]!.status, "satisfied");
  const liveFile30 = live.timers.byCode("FNMA_A2401_REVIEW_FILE_30")[0]!; assert.equal(liveFile30.dueDate, D("2026-11-15"));
  const livePerLoan = live.timers.byCode("EXAM_REQUEST_DUE_AS_STATED"); assert.equal(livePerLoan.length, 25); assert.deepEqual(new Set(livePerLoan.map((t) => t.subject.id)), new Set(loans.map((l) => l.loan_id)));
  assert.equal(openRequestNos(live.events, "EX-2026-07").length, 25);
  const OPERATOR: Actor = { kind: "human", id: "u-portal-op", role: "fnma_portal_operator" };
  const first = recordSubmission(live.events, { exam_id: "EX-2026-07", request_no: "R-001", channel: "fnma_lqc", submitted_on: D("2026-11-12"), confirmation_id: "LQC-88201", evidence_document_id: "doc-lqc-shot-1" }, OPERATOR);
  assert.equal(first.remaining_open_requests, 24); assert.equal(first.event!.payload.remaining_open_requests, 24); assert.equal(first.event!.loanId, "L-100"); assert.equal(first.request_status, "submitted");
  assert.equal(livePerLoan.find((t) => t.subject.id === "L-100")!.status, "satisfied"); assert.equal(liveFile30.status, "armed", "24 files of the review are still open");
  assert.match(recordSubmission(live.events, { exam_id: "EX-2026-07", request_no: "R-001", channel: "fnma_lqc", submitted_on: D("2026-11-12"), confirmation_id: "LQC-88201", evidence_document_id: "doc-lqc-shot-1" }, OPERATOR).refusal!, /already submitted/);
  assert.match(recordSubmission(live.events, { exam_id: "EX-2026-07", request_no: "R-099", channel: "fnma_lqc", submitted_on: D("2026-11-12"), confirmation_id: "LQC-1", evidence_document_id: "doc-x" }, OPERATOR).refusal!, /never ingested/);
  assert.equal(recordSubmission(live.events, { exam_id: "EX-2026-07", request_no: "R-002", channel: "fnma_lqc", submitted_on: D("2026-11-12"), confirmation_id: null, evidence_document_id: "doc-shot-2" }, OPERATOR).event, null, "LQC without a confirmation id is refused");
  for (let k = 2; k <= 25; k++) { const r = recordSubmission(live.events, { exam_id: "EX-2026-07", request_no: `R-${String(k).padStart(3, "0")}`, channel: "fnma_lqc", submitted_on: D("2026-11-13"), confirmation_id: `LQC-882${String(k).padStart(2, "0")}`, evidence_document_id: `doc-lqc-shot-${k}` }, OPERATOR); assert.equal(r.remaining_open_requests, 25 - k); if (k < 25) assert.equal(liveFile30.status, "armed"); }
  assert.equal(liveFile30.status, "satisfied"); assert.deepEqual(openRequestNos(live.events, "EX-2026-07"), []); assert.equal(livePerLoan.filter((t) => t.status === "armed").length, 0);
  // The inbound record is validated before anything is appended.
  assert.throws(() => ingestExamNotice(new MemoryEventStore(new FixedClock("2026-10-16T14:00:00.000Z")), { notice: { ...notice, fnma_loan_numbers: [] }, loans, scoped_on: D("2026-10-19") }), RangeError);
  assert.throws(() => ingestExamNotice(new MemoryEventStore(new FixedClock("2026-10-16T14:00:00.000Z")), { notice: { ...notice, received_on: D("2026-10-15") }, loans, scoped_on: D("2026-10-19") }), RangeError);
  assert.throws(() => ingestExamNotice(new MemoryEventStore(new FixedClock("2026-10-16T14:00:00.000Z")), { notice: { ...notice, stated_due: D("2026-10-01") }, loans, scoped_on: D("2026-10-19") }), RangeError);
  // An LQC notice for an origination review is not an A2-4-01 servicing-review file request.
  emit(events, { ...s.notice_event, exam_id: "EX-2026-08", review_type: "origination_review" }, { kind: "exam", id: "EX-2026-08" });
  assert.equal(timers.byCode("FNMA_A2401_REVIEW_FILE_30").length, 1); assert.equal(timers.byCode("SM_EXAM_SCOPE_5BD").length, 2);
  // Rule 1: an unknown Fannie Mae loan number → no request row, an immediate query to the examiner drafted for officer signature.
  const u = scopeNotice({ notice: { ...notice, fnma_loan_numbers: [...numbers, "9999999999"] }, loans, scoped_on: D("2026-10-19") });
  assert.equal(u.requests.length, 25); assert.deepEqual(u.unknown_loan_numbers, ["9999999999"]);
  assert.deepEqual(u.examiner_query, { kind: "unknown_loan_numbers", to: EXAMINER, numbers: ["9999999999"], drafted_on: D("2026-10-19"), signature: "officer", citation: "rule 1: unknown Fannie Mae loan numbers → immediate query to the examiner drafted for officer signature" });
  assert.equal(u.escalations[0]!.kind, "officer"); assert.match(u.escalations[0]!.reason, /9999999999/);
  // A stated shorter period overrides the 30 days (A2-4-01 "shorter or longer period of time"): the rows, the notice event's `due_at` and — through it — the registry's FNMA_A2401_REVIEW_FILE_30 due date.
  const shorter = scopeNotice({ notice: { ...notice, stated_due: D("2026-10-30") }, loans, scoped_on: D("2026-10-19") });
  assert.equal(shorter.requests[0]!.due_at, D("2026-10-30")); assert.equal(shorter.notice_event.due_at, D("2026-10-30")); assert.equal(shorter.clocks.approve_by, D("2026-10-29")); assert.equal(shorter.clocks.officer_gate, D("2026-10-26"));
  const short = engine(); for (const ev of shorter.events) emit(short.events, ev, EXAM);
  assert.equal(short.timers.byCode("FNMA_A2401_REVIEW_FILE_30")[0]!.dueDate, D("2026-10-30")); assert.ok(short.timers.byCode("EXAM_REQUEST_DUE_AS_STATED").every((t) => t.dueDate === D("2026-10-30")));
});
test("18.2-T2: Given a loan with a bankruptcy and a foreclosure referral, when the package compiles, then the PDF contains the header fields, collection history, workout summary, BK log, FC log with E-3.2-15 comparison, expense support and the timer appendix, and the manifest hash matches the stored document.", () => {
  // Given: an A2-4-01 servicing review on a Chapter 13 loan in Sangamon County, Illinois, referred to foreclosure after stay relief; LPI due 2026-02-01, package assembled 2026-11-06.
  const LOAN = { fnma_loan_number: "1234567890", servicer_loan_number: "SM-0001", borrower_name: "Jane Q. Borrower", property_address: "12 Elm St, Springfield, IL 62701", remittance_type: "S/A", servicing_option: "special", file_type: "servicing_review" } as const;
  // The FC log's E-3.2-15 comparison comes from the Foreclosure Time Frames exhibit (foreclosure/timeframes.ts): Illinois, judicial, 720 allowable days; elapsed = as-of − LPI due; the Chapter 13 stay earns its capped delay credit.
  const fcLog = foreclosureLogFromExhibit({ state: "IL", county: "Sangamon", sale_on: null, lpi_due: D("2026-02-01"), referral_on: D("2026-09-01"), milestones: [{ on: D("2026-09-01"), milestone: "referral" }, { on: D("2026-09-18"), milestone: "first_legal_action" }], delays: [{ category: "bk13", from: D("2026-06-01"), to: D("2026-08-20"), reported_timely: true, status_code_reported: "67" }], delay_communications: ["bankruptcy stay 2026-06-01 → 2026-08-20 reported through the delinquency status code"], as_of: D("2026-11-06") });
  assert.equal(e3215Allowable("IL").days, 720); assert.equal(e3215Allowable("IL").method, "judicial");
  assert.deepEqual([fcLog.allowable_days, fcLog.elapsed_days, fcLog.credited_days, fcLog.excess_days, fcLog.within_timeframe, fcLog.status, fcLog.exhibit_version, fcLog.comparison], [720, 278, 80, 0, true, "tracking", "2025-06-18", "E-3.2-15"]);
  const input: ReviewFileInput = {
    loan: LOAN,
    contacts: [{ on: D("2026-03-20"), mode: "phone", result: "qrpc_established", qrpc: true }, { on: D("2026-04-06"), mode: "letter", result: "no_response", qrpc: false }],
    delinquency_notices: [{ template_code: "NTC_REGX_1024_39_EARLY_INTERVENTION", sent_on: D("2026-04-15") }],
    payment_history: [{ on: D("2026-02-01"), amount_cents: 142_011n }],
    workouts: [{ kind: "flex_mod", decided_on: D("2026-05-12"), outcome: "denied", smdu_case_id: "SMDU-77" }],
    bankruptcy: { chapter: "13", filed_on: D("2026-06-01"), events: [{ on: D("2026-06-01"), event: "petition_filed", pacer_ref: "ILNB 26-01234 dkt 1" }, { on: D("2026-07-15"), event: "stay_relief_motion_filed", pacer_ref: "dkt 22" }, { on: D("2026-08-20"), event: "stay_relief_granted", pacer_ref: "dkt 31" }] },
    foreclosure: fcLog,
    expenses: [{ advance_id: "ADV-1", vendor: "Springfield Inspections LLC", invoice_document_id: "doc-inv-1", amount_cents: 2_000n }],
    timers: [{ code: "REGX_1024_39_LIVE_CONTACT_36", status: "satisfied", satisfied_by_event_id: "ev-101", evidence_hash: "ab12" }, { code: "FNMA_E1202_NONPR_REFER_BY_120", status: "satisfied", satisfied_by_event_id: "ev-140", evidence_hash: "cd34" }],
  };
  // When: the package compiles.
  const f = compileReviewFile(input);
  // Then: the single PDF carries every A2-4-01 content in order — header, collection history, workout summary, BK log, FC log, expense support, timer appendix.
  const rows = Object.fromEntries(f.sections.map((s) => [s.id, s.present ? s.rows : -1]));
  assert.deepEqual(rows, { header: 1, collection_history: 4, workout_summary: 1, bankruptcy_log: 3, foreclosure_log: 2, expense_support: 1, inspections_plans_disclosures_settlements: 0, timer_appendix: 2 });
  assert.deepEqual(f.header, LOAN);
  assert.deepEqual(f.foreclosure_log, { allowable_days: 720, elapsed_days: 278, within_timeframe: true, comparison: "E-3.2-15" });
  const pdf = JSON.parse(f.document) as Record<string, any>;
  assert.deepEqual(Object.keys(pdf), [...REVIEW_FILE_SECTIONS]);
  assert.equal(pdf.header.remittance_type, "S/A"); assert.equal(pdf.header.servicing_option, "special"); assert.equal(pdf.header.file_type, "servicing_review");
  assert.equal(pdf.collection_history.contacts[0].qrpc, true); assert.equal(pdf.collection_history.delinquency_notices[0].template_code, "NTC_REGX_1024_39_EARLY_INTERVENTION");
  assert.equal(pdf.workout_summary[0].smdu_case_id, "SMDU-77");
  assert.equal(pdf.bankruptcy_log.chapter, "13"); assert.equal(pdf.bankruptcy_log.events[1].pacer_ref, "dkt 22");
  assert.equal(pdf.foreclosure_log.comparison, "E-3.2-15"); assert.equal(pdf.foreclosure_log.within_timeframe, true); assert.equal(pdf.foreclosure_log.referral_on, "2026-09-01"); assert.match(pdf.foreclosure_log.delay_communications[0], /bankruptcy stay/);
  assert.deepEqual([pdf.foreclosure_log.allowable_days, pdf.foreclosure_log.elapsed_days, pdf.foreclosure_log.credited_days, pdf.foreclosure_log.exhibit_version, pdf.foreclosure_log.status, pdf.foreclosure_log.elapsed_basis], [720, 278, 80, "2025-06-18", "tracking", "as-of 2026-11-06 − LPI due 2026-02-01"]);
  assert.equal(pdf.expense_support[0].invoice_document_id, "doc-inv-1"); assert.equal(pdf.expense_support[0].amount_cents, "2000n");
  assert.deepEqual(pdf.timer_appendix.map((t: { code: string; satisfied_by_event_id: string; evidence_hash: string }) => [t.code, t.satisfied_by_event_id, t.evidence_hash]), [["REGX_1024_39_LIVE_CONTACT_36", "ev-101", "ab12"], ["FNMA_E1202_NONPR_REFER_BY_120", "ev-140", "cd34"]]);
  // and the manifest hash matches the stored document (exam_productions.manifest) — recomputed independently here; a tampered copy does not match. The compiled file is one page (≈2 KB of canonical JSON at 3,000 characters a page).
  assert.equal(f.manifest.sha256, createHash("sha256").update(f.document).digest("hex")); assert.equal(f.manifest.sha256.length, 64);
  assert.deepEqual(f.manifest.sections, [...REVIEW_FILE_SECTIONS]); assert.equal(f.manifest.loan_header, "1234567890/SM-0001"); assert.equal(f.manifest.pages, 1); assert.ok(f.document.length > 2000 && f.document.length < 3000);
  assert.equal(manifestMatches(f.manifest, f.document), true);
  assert.equal(manifestMatches(f.manifest, f.document.replace("SM-0001", "SM-0002")), false);
  const qa = reviewFileQa(f, f.document, { bankruptcy: true, foreclosure: true, jurisdiction: { state: "IL", county: "Sangamon" } });
  assert.equal(qa.passed, true); assert.deepEqual(qa.missing_sections, []); assert.deepEqual(qa.missing_header_fields, []); assert.equal(qa.fc_comparison, "E-3.2-15"); assert.equal(qa.fc_allowable_matches_exhibit, true); assert.deepEqual(qa.timers_without_evidence, []);
  assert.equal(reviewFileQa(f, f.document.replace("SM-0001", "SM-0002"), { bankruptcy: true, foreclosure: true }).checklist.find((c) => c.id === "hash_manifest")!.ok, false);
  // A hand-entered allowable figure that is not the exhibit's (540 is Colorado's) fails the E-3.2-15 check.
  const handFigure = compileReviewFile({ ...input, foreclosure: { ...fcLog, allowable_days: 540 } });
  assert.equal(reviewFileQa(handFigure, handFigure.document, { bankruptcy: true, foreclosure: true, jurisdiction: { state: "IL" } }).checklist.find((c) => c.id === "e3215_comparison")!.ok, false);
  assert.equal(reviewFileQa(handFigure, handFigure.document, { bankruptcy: true, foreclosure: true }).fc_allowable_matches_exhibit, false, "no jurisdiction from the caller → the log's own IL/Sangamon is checked against the exhibit and 540 fails");
  // A log that carries no jurisdiction at all cannot be verified against the exhibit: the check fails rather than passing a hand-entered figure through to officer review.
  const unverifiable = compileReviewFile({ ...input, foreclosure: { ...fcLog, allowable_days: 540, state: "" } as ReviewFileInput["foreclosure"] });
  const uq = reviewFileQa(unverifiable, unverifiable.document, { bankruptcy: true, foreclosure: true });
  assert.equal(uq.fc_allowable_matches_exhibit, null); assert.equal(uq.checklist.find((c) => c.id === "e3215_comparison")!.ok, false); assert.equal(uq.passed, false);
  assert.equal(packageAssembled({ exam_id: "EX-2026-07", request_no: "R-001", assembled_on: D("2026-11-06"), due_at: D("2026-11-15"), manifest_sha256: unverifiable.manifest.sha256, qa: uq }).request_status, "assembling");
  const noBk = compileReviewFile({ ...input, bankruptcy: null });
  assert.deepEqual(reviewFileQa(noBk, noBk.document, { bankruptcy: true, foreclosure: true }).missing_sections, ["bankruptcy_log"]);
  const noEvidence = compileReviewFile({ ...input, timers: [{ code: "REGX_1024_39_LIVE_CONTACT_36", status: "satisfied", satisfied_by_event_id: "ev-101", evidence_hash: null }] });
  assert.deepEqual(reviewFileQa(noEvidence, noEvidence.document, { bankruptcy: true, foreclosure: true }).timers_without_evidence, ["REGX_1024_39_LIVE_CONTACT_36"]);
  // A package that fails QA never reaches officer review; one that passes emits `exam.package.assembled` with the review window (opens 11-09; approve by 11-12 = assembled + 3 BD over Veterans Day) and moves the request to `officer_review`.
  const failed = packageAssembled({ exam_id: "EX-2026-07", request_no: "R-001", assembled_on: D("2026-11-06"), due_at: D("2026-11-15"), manifest_sha256: noBk.manifest.sha256, qa: reviewFileQa(noBk, noBk.document, { bankruptcy: true, foreclosure: true }) });
  assert.equal(failed.event, null); assert.equal(failed.request_status, "assembling"); assert.match(failed.refusal!, /a2401_contents_present/);
  const ok = packageAssembled({ exam_id: "EX-2026-07", request_no: "R-001", assembled_on: D("2026-11-06"), due_at: D("2026-11-15"), manifest_sha256: f.manifest.sha256, qa, cal: fannieEt });
  assert.equal(ok.request_status, "officer_review"); assert.deepEqual(ok.event, { type: "exam.package.assembled", exam_id: "EX-2026-07", request_no: "R-001", assembled_at: D("2026-11-06"), due_at: D("2026-11-15"), review_opens_on: D("2026-11-09"), approve_by: D("2026-11-12"), manifest_sha256: f.manifest.sha256 });
});
test("18.2-T3: Given the package is not assembled by the 80% warning, then an extension request letter is drafted and escalated to `officer`.", () => {
  // Given: the T1 review (notified 2026-10-16 → warnings 2026-10-31 / 2026-11-09) with no assembled package, swept daily.
  const clocks = examClocks18_2(D("2026-10-16")); assert.equal(clocks.warn_50, D("2026-10-31")); assert.equal(clocks.warn_80, D("2026-11-09"));
  const req: SweepRequest = { exam_id: "EX-2026-07", request_no: "R-001", examiner: EXAMINER, subject_entity: "partner", clocks, assembled_on: null, approved_on: null, submitted_on: null, warnings_fired: [], requested_until: D("2026-11-30"), circumstances: ["PACER dockets for 6 bankruptcy loans requested from prior servicer's archive (1.6), delivery expected 2026-11-16"] };
  // The sweep on 2026-11-06 fires the 50 % warning (once) and drafts nothing.
  const first = examDeadlineSweep({ requests: [req], today: D("2026-11-06") });
  assert.deepEqual(first.warnings, [{ exam_id: "EX-2026-07", request_no: "R-001", level: 50, warning_at: D("2026-10-31"), fired_at: D("2026-11-06") }]);
  assert.deepEqual(first.events.map((e) => [e.type, e.level, e.package_assembled]), [["exam.request.warning", 50, false]]); assert.deepEqual(first.extension_requests, []); assert.deepEqual(first.escalations, []);
  // When: the 2026-11-09 sweep fires the 80 % warning and the package is still not assembled.
  const sweep = examDeadlineSweep({ requests: [{ ...req, warnings_fired: [50] }], today: D("2026-11-09") });
  assert.deepEqual(sweep.warnings.map((w) => [w.level, w.warning_at]), [[80, D("2026-11-09")]]);
  // Then: the extension request letter is drafted, citing the extenuating circumstances and A2-4-01, for the officer's signature.
  assert.equal(sweep.extension_requests.length, 1); const r = sweep.extension_requests[0]!; assert.equal(r.trigger, "warn_80_without_package"); assert.equal(r.needed, true);
  assert.equal(r.letter!.template, "EXAM-EXT-REQ-v1"); assert.equal(r.letter!.to, EXAMINER); assert.equal(r.letter!.drafted_on, D("2026-11-09")); assert.equal(r.letter!.current_due, D("2026-11-15")); assert.equal(r.letter!.requested_until, D("2026-11-30"));
  assert.deepEqual(r.letter!.extenuating_circumstances, req.circumstances); assert.match(r.letter!.citation, /A2-4-01: "Fannie Mae will make every effort to work with the seller\/servicer"/);
  assert.deepEqual(r.letter!.signature_block, { role: "officer", entity: "partner", signed: false });
  // and escalated to `officer` (sign before the internal target); the request records the ask and the exam enters the side state `extension_pending`.
  assert.equal(r.escalation!.kind, "officer"); assert.equal(r.escalation!.severity, "sev2"); assert.equal(r.escalation!.due, D("2026-11-13")); assert.match(r.escalation!.reason, /80% warning 2026-11-09 reached without an assembled package/);
  assert.deepEqual(sweep.escalations, [r.escalation]);
  assert.deepEqual(r.request, { extension_requested_at: D("2026-11-09"), status: "open" }); assert.equal(r.exam_side_state, "extension_pending");
  assert.equal(r.written_confirmation_required, true, "open question 4: never rely on an extension not confirmed in writing");
  // Fired warnings do not fire twice; a package assembled before the warning day gets the 80 % warning but no extension request; a submitted request is left alone.
  assert.deepEqual(examDeadlineSweep({ requests: [{ ...req, warnings_fired: [50, 80] }], today: D("2026-11-10") }), { warnings: [], events: [], extension_requests: [], officer_review_breaches: [], escalations: [] });
  const assembled = examDeadlineSweep({ requests: [{ ...req, assembled_on: D("2026-11-06"), warnings_fired: [50] }], today: D("2026-11-09") });
  assert.deepEqual(assembled.events.map((e) => [e.level, e.package_assembled]), [[80, true]]); assert.deepEqual(assembled.extension_requests, []);
  assert.deepEqual(examDeadlineSweep({ requests: [{ ...req, submitted_on: D("2026-11-08"), warnings_fired: [50] }], today: D("2026-11-09") }).warnings, []);
  // The rule itself, called directly: before the warning, or once the package is assembled, nothing is drafted.
  const base = { exam_id: "EX-2026-07", request_no: "R-001", examiner: EXAMINER, clocks, requested_until: D("2026-11-30"), circumstances: req.circumstances!, subject_entity: "partner" as const };
  const early = extensionRequest({ ...base, assembled_on: null, today: D("2026-11-06") }); assert.equal(early.needed, false); assert.equal(early.letter, null); assert.equal(early.escalation, null);
  const done = extensionRequest({ ...base, assembled_on: D("2026-11-06"), today: D("2026-11-09") }); assert.equal(done.needed, false); assert.equal(done.exam_side_state, null);
  // The officer-review window breaching (approve-by = min(assembled + 3 BD, due − 1 BD)) also drafts the request automatically (timer table: "sev-2; auto-extension request drafted") …
  const w = packageReviewWindow({ assembled_on: D("2026-11-10"), due_at: D("2026-11-15"), today: D("2026-11-16"), approved_on: null, cal: fannieEt });
  assert.equal(w.approve_by, D("2026-11-13")); assert.equal(w.breached, true); assert.equal(w.extension_request_drafted, true); assert.match(w.reason!, /sev-2, extension request drafted/);
  const late = examDeadlineSweep({ requests: [{ ...req, assembled_on: D("2026-11-10"), warnings_fired: [50, 80] }], today: D("2026-11-16"), cal: fannieEt });
  assert.deepEqual(late.officer_review_breaches.map((b) => [b.request_no, b.approve_by]), [["R-001", D("2026-11-13")]]);
  assert.deepEqual(late.extension_requests.map((e) => [e.trigger, e.needed, e.letter!.drafted_on, e.escalation!.kind]), [["officer_review_breached", true, D("2026-11-16"), "officer"]]); assert.match(late.extension_requests[0]!.letter!.extenuating_circumstances[0]!, /assembled 2026-11-10 not approved by 2026-11-13/);
  // … and the registry row breaches in the engine: `exam.package.assembled{approve_by}` is due on approve-by (offset 0), so the day after, TimerEngine.evaluate breaches it at sev-2 with the auto-extension breach text.
  const { events, timers } = engine("2026-11-10T20:00:00.000Z");
  const p = packageAssembled({ exam_id: "EX-2026-07", request_no: "R-001", assembled_on: D("2026-11-10"), due_at: D("2026-11-15"), manifest_sha256: "ab".repeat(32), qa: { passed: true, missing_sections: [], missing_header_fields: [], fc_comparison: null, fc_allowable_matches_exhibit: null, manifest_matches: true, timers_without_evidence: [], checklist: [] }, cal: fannieEt });
  assert.equal(p.event!.approve_by, D("2026-11-13")); assert.equal(p.event!.review_opens_on, D("2026-11-12"));
  emit(events, p.event!, EXAM);
  const win = timers.byCode("SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD")[0]!; assert.equal(win.anchorDate, D("2026-11-13")); assert.equal(win.dueDate, D("2026-11-13")); assert.equal(win.status, "armed");
  assert.deepEqual(timers.evaluate("2026-11-13T23:00:00.000Z").map((b) => b.instance.code), [], "still open on approve-by");
  const breaches = timers.evaluate("2026-11-14T12:00:00.000Z");
  assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity, b.breachText]), [["SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD", 2, "sev-2; auto-extension request drafted"]]); assert.equal(win.status, "breached");
});
test("18.2-T4: Given an attorney-client memo in the loan's documents, then it is excluded and appears on the privilege log; no other Fannie Mae-owned record is withheld.", () => {
  // Given: the loan's documents include counsel's attorney-client memo, servicing notes, the payment history, an inspection report naming a tenant, and the PACER docket.
  const docs: ProductionDocument[] = [
    { document_id: "doc-memo-1", document_class: "attorney_client", description: "counsel memo on foreclosure strategy, 2026-08-02" },
    { document_id: "doc-note-1", document_class: "servicing_note", description: "collection notes 2026-03 to 2026-09" },
    { document_id: "doc-pay-1", document_class: "payment_history", description: "ledger export" },
    { document_id: "doc-insp-1", document_class: "inspection_report", description: "exterior inspection 2026-07-10", non_borrower_pii: ["tenant name: R. Occupant", "tenant phone: (217) 555-0142"] },
    { document_id: "doc-bk-1", document_class: "bankruptcy_docket", description: "PACER docket ILNB 26-01234" },
  ];
  // When: the production is screened — the agent also proposes withholding an unflattering servicing note.
  const p = privilegeScreen({ exam_request_id: "R-001", documents: docs, proposed_withholdings: [{ document_id: "doc-note-1", reason: "internal note unflattering to the collector" }] });
  // Then: the memo is excluded and appears on the privilege log …
  assert.deepEqual(p.excluded.map((e) => [e.document_id, e.document_class, e.basis]), [["doc-memo-1", "attorney_client", "attorney_client"]]);
  assert.equal(p.privilege_log.document_id, "privlog-R-001"); assert.deepEqual(p.privilege_log.entries, p.excluded); assert.match(p.privilege_log.entries[0]!.description, /^withheld — attorney client: counsel memo/);
  assert.ok(privilegeExcluded("attorney_client") && privilegeExcluded("work_product") && privilegeExcluded("attorney_communication")); assert.equal(privilegeExcluded("servicing_note"), false);
  // … and no other Fannie Mae-owned record is withheld: the proposed withholding is refused under A2-4.1-02 and the note stays in the production set.
  assert.deepEqual(p.produced, ["doc-note-1", "doc-pay-1", "doc-insp-1", "doc-bk-1"]);
  assert.deepEqual(p.refused_withholdings.map((w) => w.document_id), ["doc-note-1"]); assert.match(p.refused_withholdings[0]!.citation, /A2-4\.1-02: loan records are Fannie Mae's property/);
  // The compiled package is checked against the documents: every non-privileged record is in it, so nothing Fannie Mae owns is withheld …
  const complete = productionCompleteness({ documents: docs, screen: p, compiled_document_ids: ["doc-note-1", "doc-pay-1", "doc-insp-1", "doc-bk-1"] });
  assert.deepEqual([complete.complete, complete.fannie_mae_records_withheld, complete.privileged_excluded, complete.not_in_documents], [true, [], ["doc-memo-1"], []]);
  // … while a package the note was quietly left out of names the withheld Fannie Mae record and fails, as does one the privileged memo leaked into.
  const short = productionCompleteness({ documents: docs, screen: p, compiled_document_ids: ["doc-pay-1", "doc-insp-1", "doc-bk-1"] });
  assert.equal(short.complete, false); assert.deepEqual(short.fannie_mae_records_withheld, ["doc-note-1"]); assert.match(short.citation, /Fannie Mae's property/);
  assert.equal(productionCompleteness({ documents: docs, screen: p, compiled_document_ids: ["doc-memo-1", ...p.produced] }).complete, false);
  // Non-borrower PII is redacted, never the record itself.
  assert.deepEqual(p.redactions, [{ document_id: "doc-insp-1", redacted: ["tenant name: R. Occupant", "tenant phone: (217) 555-0142"], reason: "non_borrower_pii" }]);
  assert.deepEqual(p.production, { privilege_log_document_id: "privlog-R-001", pii_redaction_applied: true });
  // A production with no privileged material has an empty log and nothing withheld.
  const clean = privilegeScreen({ exam_request_id: "R-002", documents: docs.slice(1) });
  assert.deepEqual(clean.excluded, []); assert.deepEqual(clean.produced, ["doc-note-1", "doc-pay-1", "doc-insp-1", "doc-bk-1"]); assert.deepEqual(clean.refused_withholdings, []);
  assert.deepEqual(productionCompleteness({ documents: docs.slice(1), screen: clean, compiled_document_ids: clean.produced }).fannie_mae_records_withheld, []);
});
test("18.2-T5: Given a Fannie Mae finding alleging a missed D2-2-02 outreach cadence, then a `qc_finding` case opens, CAPA is due in 15 BD, and the draft response cites `contacts` rows and timer history.", () => {
  // Given: a Servicing Compliance Review finding received Fri 2026-11-20 alleging a missed D2-2-02 outreach cadence on loan L-100; the evidence index holds that loan's contacts and timer history (and another loan's, which must not bleed in).
  const finding: ExamFindingInput = { exam_id: "EX-2026-07", finding_ref: "F-3", text: "Servicer did not maintain the D2-2-02 outreach cadence on loan L-100 between day 36 and day 60 of delinquency.", severity: "medium", taxonomy_nodes: ["a1103.collections", "fnma.d2202.outreach"], cited_requirement: "D2-2-02", alleged_violation: true, loan_ids: ["L-100"] };
  const evidence: EvidenceBundle = {
    contacts: [{ contact_id: "ct-501", loan_id: "L-100", on: D("2026-03-20"), mode: "phone", result: "qrpc_established", qrpc: true }, { contact_id: "ct-502", loan_id: "L-100", on: D("2026-04-06"), mode: "letter", result: "no_response", qrpc: false }, { contact_id: "ct-777", loan_id: "L-200", on: D("2026-04-06"), mode: "phone", result: "no_answer", qrpc: false }],
    timers: [{ timer_id: "tm-9001", loan_id: "L-100", code: "REGX_1024_39_LIVE_CONTACT_36", status: "satisfied", due_date: D("2026-03-22"), satisfied_at: D("2026-03-20") }, { timer_id: "tm-9002", loan_id: "L-100", code: "FNMA_D2202_OUTREACH_CADENCE", status: "satisfied", due_date: D("2026-04-10"), satisfied_at: D("2026-04-06") }, { timer_id: "tm-8000", loan_id: "L-200", code: "REGX_1024_39_LIVE_CONTACT_36", status: "breached", due_date: D("2026-03-22"), satisfied_at: null }],
  };
  const r = examFindingReceived({ finding, received_on: D("2026-11-20"), stated_response_due: null, examiner: EXAMINER, subject_entity: "partner", servicer_number_owner: "partner", evidence });
  // Then: a qc_finding case opens (18.1: root cause required before capa_assigned), mirrored on exam_findings.qc_finding_case_id …
  assert.equal(r.case.kind, "qc_finding"); assert.equal(r.case.case_id, "QCF-EX-2026-07-F-3"); assert.equal(r.case.status, "open"); assert.equal(r.case.source, "exam"); assert.equal(r.case.root_cause_required, true); assert.deepEqual(r.case.loan_ids, ["L-100"]);
  assert.equal(r.finding_row.qc_finding_case_id, "QCF-EX-2026-07-F-3"); assert.equal(r.finding_row.status, "responding"); assert.equal(r.finding_row.response_document_id, null);
  // … CAPA is due in 15 BD: Fri 2026-11-20 + 15 servicer business days over Thanksgiving = Mon 2026-12-14 …
  assert.equal(servicer.isBusinessDay(D("2026-11-26")), false);
  assert.equal(r.case.capa_due, D("2026-12-14")); assert.equal(r.case.capa_due, addBusinessDays(D("2026-11-20"), 15, servicer)); assert.equal(r.finding_row.remediation_due_at, D("2026-12-14"));
  assert.deepEqual(r.timers[0], { code: "SM_EXAM_REMEDIATION_PLAN_15BD", anchor: D("2026-11-20"), due: D("2026-12-14"), business_days: 15 });
  assert.deepEqual(r.timers[1], { code: "FNMA_SCR_FINDING_RESPONSE_AS_STATED", anchor_field: "response_due_stated", due: D("2026-12-20"), basis: "default_30_calendar_days" });
  assert.equal(examFindingReceived({ finding, received_on: D("2026-11-20"), stated_response_due: D("2026-12-04"), examiner: EXAMINER, subject_entity: "partner", servicer_number_owner: "partner", evidence }).timers[1].due, D("2026-12-04"));
  // … and the draft response (EXAM-RESP-v1) cites the loan's contacts rows and timer history — every paragraph carries a record id; the other loan's records are not cited.
  assert.equal(r.draft.template, "EXAM-RESP-v1"); assert.equal(r.draft.header.examiner, EXAMINER); assert.deepEqual(r.draft.request_reference, { reference: "F-3", received_on: D("2026-11-20"), cited_requirement: "D2-2-02" });
  assert.deepEqual(r.draft.evidence_citations.filter((c) => c.ref_type === "contacts").map((c) => c.ref_id), ["ct-501", "ct-502"]);
  assert.deepEqual(r.draft.evidence_citations.filter((c) => c.ref_type === "timers").map((c) => c.ref_id), ["tm-9001", "tm-9002"]);
  assert.ok(r.draft.response.every((p) => p.citations.length > 0)); assert.equal(r.draft.checklist.find((c) => c.id === "every_paragraph_cites_a_record")!.ok, true);
  assert.match(r.draft.response[0]!.text, /^Finding F-3 \(D2-2-02\): Servicer did not maintain/); assert.deepEqual(r.draft.response[0]!.citations, [{ ref_type: "cases", ref_id: "QCF-EX-2026-07-F-3" }]);
  assert.equal(r.draft.response[1]!.text, "2026-03-20: phone contact on loan L-100 — qrpc_established (QRPC established)."); assert.equal(r.draft.response[3]!.text, "REGX_1024_39_LIVE_CONTACT_36 on loan L-100: satisfied (due 2026-03-22, satisfied 2026-03-20).");
  assert.deepEqual(r.draft.signature_block, { role: "officer", entity: "partner", signer_id: null, signed_on: null }); assert.equal(r.draft.checklist.find((c) => c.id === "officer_signature_block")!.ok, true);
  assert.equal(r.draft.checklist.find((c) => c.id === "rule6_finding_root_cause_remediation_population_evidence")!.ok, false, "root cause, remediation, affected population and evidence of correction are still to be drafted");
  assert.deepEqual(r.review.legal_conclusions, [], "the draft states facts and the finding's own text — no compliance characterization of ours");
  assert.deepEqual(r.review.route, ["attorney", "officer"], "the finding alleges a violation: counsel reviews before the officer signs");
  // The finding event arms both rows on the real registry: the 15-BD plan clock on receipt, the response clock on the computed stated date; the officer-approved CAPA set satisfies the plan clock.
  const { events, timers } = engine("2026-11-20T15:00:00.000Z");
  // The finding is ingested through the store (validated: text, severity, dates, no second ingestion of the same finding) and the appended event is the one the rows are armed by.
  const ing = ingestExamFinding(events, { finding, received_on: D("2026-11-20"), stated_response_due: null, examiner: EXAMINER, subject_entity: "partner", servicer_number_owner: "partner", evidence });
  assert.equal(ing.appended.type, "exam.finding.received"); assert.deepEqual(ing.appended.payload, { exam_id: "EX-2026-07", finding_ref: "F-3", received_at: "2026-11-20", response_due_stated: "2026-12-20", qc_finding_case_id: "QCF-EX-2026-07-F-3" }); assert.deepEqual(ing.event, r.event);
  assert.throws(() => ingestExamFinding(events, { finding, received_on: D("2026-11-20"), stated_response_due: null, examiner: EXAMINER, subject_entity: "partner", servicer_number_owner: "partner", evidence }), /already on record/);
  assert.throws(() => ingestExamFinding(events, { finding: { ...finding, finding_ref: "F-9", text: "" }, received_on: D("2026-11-20"), stated_response_due: null, examiner: EXAMINER, subject_entity: "partner", servicer_number_owner: "partner", evidence }), RangeError);
  assert.throws(() => ingestExamFinding(events, { finding: { ...finding, finding_ref: "F-9" }, received_on: D("2026-11-20"), stated_response_due: D("2026-11-19"), examiner: EXAMINER, subject_entity: "partner", servicer_number_owner: "partner", evidence }), RangeError);
  const plan = timers.byCode("SM_EXAM_REMEDIATION_PLAN_15BD")[0]!; assert.equal(plan.anchorDate, D("2026-11-20")); assert.equal(plan.dueDate, D("2026-12-14"));
  const resp = timers.byCode("FNMA_SCR_FINDING_RESPONSE_AS_STATED")[0]!; assert.equal(resp.anchorDate, D("2026-12-20")); assert.equal(resp.dueDate, D("2026-12-20"));
  const capas = [{ capa_id: "CAPA-1", action_kind: "process_fix", owner: "collections_lead", due: D("2027-01-15") }, { capa_id: "CAPA-2", action_kind: "retrain", owner: "collections_lead", due: D("2027-01-29") }];
  const noRoot = remediationPlanApproved({ exam_id: "EX-2026-07", finding_ref: "F-3", qc_finding_case_id: r.case.case_id, root_cause: null, capas, approved_by_role: "officer", approved_on: D("2026-12-04") });
  assert.equal(noRoot.event, null); assert.match(noRoot.refusal!, /root cause required before `capa_assigned`/);
  const byAgent = remediationPlanApproved({ exam_id: "EX-2026-07", finding_ref: "F-3", qc_finding_case_id: r.case.case_id, root_cause: "dialer campaign excluded loans with an open lossmit case", capas, approved_by_role: "qc-audit", approved_on: D("2026-12-04") });
  assert.equal(byAgent.event, null); assert.match(byAgent.refusal!, /officer act/);
  assert.equal(plan.status, "armed");
  const approved = remediationPlanApproved({ exam_id: "EX-2026-07", finding_ref: "F-3", qc_finding_case_id: r.case.case_id, root_cause: "dialer campaign excluded loans with an open lossmit case", capas, approved_by_role: "officer", approved_on: D("2026-12-04") });
  assert.equal(approved.case_status, "capa_assigned"); assert.deepEqual(approved.event!.capa_ids, ["CAPA-1", "CAPA-2"]);
  // On the store the approval is the `officer` actor's act — the agent's call appends nothing, a finding not on record is refused, the officer's call satisfies the plan clock.
  const planInput = { exam_id: "EX-2026-07", finding_ref: "F-3", qc_finding_case_id: r.case.case_id, root_cause: "dialer campaign excluded loans with an open lossmit case", capas, approved_on: D("2026-12-04") };
  assert.match(recordRemediationPlanApproval(events, planInput, { kind: "agent", id: "qc-audit" }).refusal!, /officer act; agent refused/); assert.equal(plan.status, "armed");
  assert.match(recordRemediationPlanApproval(events, { ...planInput, finding_ref: "F-8" }, { kind: "human", id: "u-officer", role: "officer" }).refusal!, /no `exam.finding.received` on record/);
  const rec = recordRemediationPlanApproval(events, planInput, { kind: "human", id: "u-officer", role: "officer" });
  assert.equal(rec.case_status, "capa_assigned"); assert.deepEqual([rec.event!.type, rec.event!.payload.approved_by_role, rec.event!.payload.qc_finding_case_id, rec.event!.payload.capa_ids], ["exam.remediation_plan.approved", "officer", "QCF-EX-2026-07-F-3", ["CAPA-1", "CAPA-2"]]);
  assert.equal(plan.status, "satisfied"); assert.equal(resp.status, "armed");
});
test("18.2-T6: Given a remedy demand received with the report, then Section 5.x `FNMA_A1302_APPEAL1_60` starts and the exam record links the repurchase case.", () => {
  // Given: the Servicing Final Report arrives with a repurchase demand on one reviewed loan.
  const exam = { id: "EX-2026-07", status: "findings_received", repurchase_case_id: null };
  const r = examRemedyDemand({ exam, received_on: D("2026-12-01"), demand: { kind: "repurchase", fnma_loan_number: "1234567890", amount_cents: 24_977_400n }, repurchase_case_id: "RC-2026-0042" });
  // Then: Section 5.x `FNMA_A1302_APPEAL1_60` starts — 60 calendar days from receipt (A1-3-02), owned by 5.6.
  assert.equal(r.hand_off.timer.code, "FNMA_A1302_APPEAL1_60"); assert.equal(r.hand_off.timer.anchor, D("2026-12-01")); assert.equal(r.hand_off.timer.due, D("2027-01-30")); assert.equal(r.hand_off.timer.owner_process, "5.6");
  const reg = loadRegistry(); applyInvestorTimerOverrides(reg); const ladder = reg.get("FNMA_A1302_APPEAL1_60")!;
  assert.equal(ladder.process, "5.6"); assert.equal(ladder.offsetParsed.kind, "step"); assert.deepEqual([(ladder.offsetParsed as { n: number }).n, (ladder.offsetParsed as { unit: string }).unit], [60, "calendar_days"]);
  assert.equal(r.ladder_event.type, ladder.triggerPattern!.type, "the hand-off emits the event the 5.6 row is armed by");
  assert.deepEqual(r.ladder_event, { type: "repurchase.demand.received", repurchase_case_id: "RC-2026-0042", exam_id: "EX-2026-07", received_at: D("2026-12-01"), demand_kind: "repurchase", amount_cents: 24_977_400n });
  // and the exam record links the repurchase case in the side state `disputed`; no ledger posting from 18.2.
  assert.equal(r.hand_off.event.type, "exam.remedy_demand.received");
  assert.deepEqual(r.exam, { id: "EX-2026-07", status: "disputed", repurchase_case_id: "RC-2026-0042" });
  assert.deepEqual(r.hand_off.exam_link, { exam_id: "EX-2026-07", repurchase_case_id: "RC-2026-0042", demand_kind: "repurchase", amount_cents: 24_977_400n });
  assert.ok(!("ledger" in r.hand_off));
  // Through the store: the hand-off appends `exam.remedy_demand.received` under the exam and the 5.6 intake's `repurchase.demand.received{received_at}` under the repurchase case — on the 5.6 registry that arms FNMA_A1302_APPEAL1_60 at 2027-01-30.
  const clock = new FixedClock("2026-12-01T15:00:00.000Z"); const events = new MemoryEventStore(clock); const t56 = new TimerEngine(reg, events, { processes: ["5.6"] });
  const ing = ingestRemedyDemand(events, { exam, received_on: D("2026-12-01"), demand: { kind: "repurchase", fnma_loan_number: "1234567890", amount_cents: 24_977_400n }, repurchase_case_id: "RC-2026-0042", loan_id: "L-100", demand_document_id: "doc-demand-1", now: clock.now() });
  assert.deepEqual(ing.appended.map((e) => e.type), ["exam.remedy_demand.received", "repurchase.demand.received"]); assert.deepEqual(ing.appended[0]!.aggregate, { kind: "exam", id: "EX-2026-07" }); assert.equal(ing.appended[0]!.payload.repurchase_case_id, "RC-2026-0042"); assert.equal(ing.appended[0]!.payload.exam_status, "disputed");
  assert.equal(ing.appended[1]!.payload.received_at, "2026-12-01"); assert.equal(ing.appended[1]!.payload.repurchase_id, "RC-2026-0042"); assert.equal(ing.ladder.first_appeal_by, D("2027-01-30"));
  const appeal = t56.byCode("FNMA_A1302_APPEAL1_60"); assert.equal(appeal.length, 1); assert.equal(appeal[0]!.status, "armed"); assert.equal(appeal[0]!.dueDate, D("2027-01-30"));
  assert.throws(() => ingestRemedyDemand(events, { exam, received_on: D("2026-12-01"), demand: { kind: "repurchase", fnma_loan_number: "1234567890", amount_cents: -1n }, repurchase_case_id: "RC-2026-0043", loan_id: "L-100", demand_document_id: "doc-demand-1", now: clock.now() }), RangeError);
  assert.throws(() => ingestRemedyDemand(events, { exam, received_on: D("2026-12-01"), demand: { kind: "repurchase", fnma_loan_number: "1234567890", amount_cents: 1n }, repurchase_case_id: "RC-2026-0043", loan_id: "", demand_document_id: "doc-demand-1", now: clock.now() }), RangeError);
});
test("18.2-T7: Given a CFPB information request with a stated 10-business-day deadline over a federal holiday, then `EXAM_REQUEST_DUE_AS_STATED` uses the stated date and the officer gate lands ≥1 BD before it.", () => {
  // Given: a CFPB information request received Thu 2026-11-05 stating "within 10 business days" — Veterans Day (Wed 2026-11-11) falls inside the count.
  assert.equal(federal.isBusinessDay(D("2026-11-11")), false);
  const stated = statedBusinessDayDeadline({ received_on: D("2026-11-05"), business_days: 10, cal: federal });
  assert.equal(stated.stated_due, D("2026-11-20")); assert.deepEqual(stated.holidays_skipped, [D("2026-11-11")]); assert.equal(stated.weekend_days_skipped, 4);
  assert.equal(stated.weekday_only_due, D("2026-11-19"), "a hand count that treated Veterans Day as a business day lands one day early");
  const r = examRequestReceived({ exam_id: "EX-CFPB-2026-02", request_no: "IR-7", source: "cfpb", received_on: D("2026-11-05"), stated_due: stated.stated_due, cal: federal });
  // Then: EXAM_REQUEST_DUE_AS_STATED uses the stated date — anchor `due_at`, offset 0, not receipt + anything …
  assert.deepEqual(r.timer, { code: "EXAM_REQUEST_DUE_AS_STATED", anchor_field: "due_at", anchor: D("2026-11-20"), due: D("2026-11-20"), basis: "as_stated", warn_50: D("2026-11-12"), warn_80: D("2026-11-17") });
  assert.equal(r.clocks.due, D("2026-11-20")); assert.equal(r.clocks.internal_target, D("2026-11-20"), "a Friday: no roll-back");
  const t = overridden().get("EXAM_REQUEST_DUE_AS_STATED")!; assert.equal(t.anchorField, "due_at"); assert.equal(t.offsetParsed.kind, "same_day"); assert.equal(t.triggerPattern!.type, "exam.request.received");
  const { events, timers } = engine("2026-11-05T16:00:00.000Z");
  const ingested = ingestExamRequest(events, { exam_id: "EX-CFPB-2026-02", request_no: "IR-7", source: "cfpb", received_on: D("2026-11-05"), stated_due: stated.stated_due, cal: federal });
  assert.deepEqual(ingested.event, r.event); assert.equal(ingested.appended.type, "exam.request.received"); assert.equal(ingested.appended.payload.due_at, D("2026-11-20")); assert.equal(ingested.appended.loanId, undefined);
  assert.throws(() => ingestExamRequest(events, { exam_id: "EX-CFPB-2026-02", request_no: "IR-8", source: "cfpb", received_on: D("2026-11-05"), stated_due: D("2026-11-04"), cal: federal }), RangeError);
  const inst = timers.byCode("EXAM_REQUEST_DUE_AS_STATED")[0]!; assert.equal(inst.status, "armed"); assert.equal(inst.anchorDate, D("2026-11-20")); assert.equal(inst.dueDate, D("2026-11-20"));
  // … and the officer gate lands ≥1 BD before it: approval by Thu 2026-11-19 (1 federal BD before the Fri 11-20 due date), the officer's 3 BD before that → package assembled by Mon 2026-11-16, four business days ahead of the due date.
  assert.equal(r.officer_gate.approve_by, D("2026-11-19")); assert.equal(r.officer_gate.latest_allowed, D("2026-11-19")); assert.equal(r.officer_gate.latest_allowed, addBusinessDays(D("2026-11-20"), -1, federal));
  assert.equal(r.officer_gate.at, D("2026-11-16")); assert.equal(r.officer_gate.at, addBusinessDays(D("2026-11-19"), -3, servicer));
  assert.ok(r.officer_gate.at <= r.officer_gate.latest_allowed); assert.equal(r.officer_gate.business_days_before_due, 4); assert.equal(r.officer_gate.ok, true);
  // The package-review gate keeps the margins: assembled Fri 11-13 → opens Mon 11-16, officer 3 BD → Wed 11-18, ≥1 BD before due → Thu 11-19; approve-by is the earlier, 11-18.
  const w = packageReviewWindow({ assembled_on: D("2026-11-13"), due_at: D("2026-11-20"), today: D("2026-11-18"), approved_on: null, cal: federal });
  assert.deepEqual([w.opens_on, w.officer_3bd, w.one_bd_before_due, w.approve_by, w.open, w.breached], [D("2026-11-16"), D("2026-11-18"), D("2026-11-19"), D("2026-11-18"), true, false]);
  assert.match(packageReviewWindow({ assembled_on: D("2026-11-13"), due_at: D("2026-11-20"), today: D("2026-11-13"), approved_on: null, cal: federal }).reason!, /must sit ≥1 BD for review — gate opens 2026-11-16/);
  assert.match(packageReviewWindow({ assembled_on: D("2026-11-19"), due_at: D("2026-11-20"), today: D("2026-11-20"), approved_on: D("2026-11-20"), cal: federal }).reason!, /after approve-by 2026-11-19 \(≥1 BD before due 2026-11-20/);
  // In the engine the assembled package is due on approve-by (11-18); an approval before the gate opens is refused, the officer's approval inside the window satisfies the row.
  const qa = reviewFileQa(compileReviewFile({ loan: { fnma_loan_number: "1", servicer_loan_number: "SM-1", borrower_name: "B", property_address: "A", remittance_type: "A/A", servicing_option: "special", file_type: "servicing_review" }, contacts: [], delinquency_notices: [], payment_history: [], workouts: [], bankruptcy: null, foreclosure: null, expenses: [], timers: [] }), "", { bankruptcy: false, foreclosure: false });
  const p = packageAssembled({ exam_id: "EX-CFPB-2026-02", request_no: "IR-7", assembled_on: D("2026-11-13"), due_at: D("2026-11-20"), manifest_sha256: "cd".repeat(32), qa: { ...qa, passed: true, checklist: [] }, cal: federal });
  emit(events, p.event!, { kind: "exam", id: "EX-CFPB-2026-02" });
  const win = timers.byCode("SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD")[0]!; assert.equal(win.anchorDate, D("2026-11-18")); assert.equal(win.dueDate, D("2026-11-18"));
  const common = { exam_id: "EX-CFPB-2026-02", request_no: "IR-7", assembled_on: D("2026-11-13"), due_at: D("2026-11-20"), approved_by_id: "u-officer", approver_entity: "partner" as const, manifest_sha256: "cd".repeat(32), cal: federal };
  assert.match(officerApproval({ ...common, approved_on: D("2026-11-13"), approved_by_role: "officer" }).refusal!, /before the package sat ≥1 BD/);
  assert.deepEqual(officerApproval({ ...common, approved_on: D("2026-11-17"), approved_by_role: "officer" }).event, { type: "exam.package.approved", exam_id: "EX-CFPB-2026-02", request_no: "IR-7", approved_by_role: "officer", approved_by_officer_id: "u-officer", approver_entity: "partner", approved_at: D("2026-11-17"), manifest_sha256: "cd".repeat(32) });
  // On the store the approval is the `officer` actor's act against the package on record (its stamped window): the agent is refused, so is a day before the gate opens, a manifest that is not the package's, or a request with no package; the officer's approval inside the window satisfies the row and is what an upload task finds on record.
  const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" }; const approveInput = { exam_id: "EX-CFPB-2026-02", request_no: "IR-7", approver_entity: "partner" as const, servicer_number_owner: "partner" as const };
  assert.equal(latestPackageAssembled(events, { exam_id: "EX-CFPB-2026-02", request_no: "IR-7" })!.payload.approve_by, "2026-11-18"); assert.equal(latestPackageAssembled(events, { exam_id: "EX-CFPB-2026-02", request_no: "IR-9" }), null);
  assert.match(recordPackageApproval(events, { ...approveInput, approved_on: D("2026-11-17") }, { kind: "agent", id: "qc-audit" }).refusal!, /approval by agent refused/);
  assert.match(recordPackageApproval(events, { ...approveInput, approved_on: D("2026-11-13") }, OFFICER).refusal!, /before the package sat ≥1 BD for review \(opens 2026-11-16\)/);
  assert.match(recordPackageApproval(events, { ...approveInput, approved_on: D("2026-11-19") }, OFFICER).refusal!, /after approve-by 2026-11-18/);
  assert.match(recordPackageApproval(events, { ...approveInput, approved_on: D("2026-11-17"), manifest_sha256: "00".repeat(32) }, OFFICER).refusal!, /not the package on record/);
  assert.match(recordPackageApproval(events, { ...approveInput, request_no: "IR-9", approved_on: D("2026-11-17") }, OFFICER).refusal!, /no `exam.package.assembled` on record/);
  assert.equal(events.ofType("exam.package.approved").length, 0); assert.equal(win.status, "armed"); assert.equal(packageApprovalOnRecord(events, { exam_id: "EX-CFPB-2026-02", request_no: "IR-7", manifest_sha256: "cd".repeat(32) }), null);
  const approvedOnRecord = recordPackageApproval(events, { ...approveInput, approved_on: D("2026-11-17") }, OFFICER);
  assert.equal(approvedOnRecord.approved, true); assert.equal(approvedOnRecord.appended!.type, "exam.package.approved"); assert.deepEqual([approvedOnRecord.appended!.payload.approved_by_officer_id, approvedOnRecord.appended!.payload.approved_by_role, approvedOnRecord.appended!.payload.manifest_sha256], ["u-officer", "officer", "cd".repeat(32)]);
  assert.equal(win.status, "satisfied"); assert.deepEqual(packageApprovalOnRecord(events, { exam_id: "EX-CFPB-2026-02", request_no: "IR-7", manifest_sha256: "cd".repeat(32) }), { approved_by_officer_id: "u-officer", approver_entity: "partner", approved_at: D("2026-11-17") });
  assert.equal(packageApprovalOnRecord(events, { exam_id: "EX-CFPB-2026-02", request_no: "IR-7", manifest_sha256: "ab".repeat(32) }), null, "a recompiled package is unapproved");
  // Submission evidence satisfies the stated-date row; a submission without evidence is refused and satisfies nothing.
  const noEvidence = submissionRecorded({ exam_id: "EX-CFPB-2026-02", request_no: "IR-7", channel: "cfpb_portal", submitted_on: D("2026-11-19"), confirmation_id: null, evidence_document_id: null });
  assert.equal(noEvidence.event, null); assert.equal(noEvidence.request_status, "officer_review"); assert.match(noEvidence.refusal!, /submission evidence required/);
  const sub = submissionRecorded({ exam_id: "EX-CFPB-2026-02", request_no: "IR-7", channel: "cfpb_portal", submitted_on: D("2026-11-19"), confirmation_id: "CFPB-RCPT-4471", evidence_document_id: "doc-cfpb-receipt-1" });
  assert.equal(sub.request_status, "submitted"); assert.equal(sub.event!.submission_evidence, "doc-cfpb-receipt-1"); assert.equal(sub.event!.lqc_confirmation_id, null); assert.equal(sub.event!.loan_id, null);
  assert.equal(sub.event!.remaining_open_requests, null, "a caller that does not know the open count stamps null — it never closes an exam-level clock");
  const recorded = recordSubmission(events, { exam_id: "EX-CFPB-2026-02", request_no: "IR-7", channel: "cfpb_portal", submitted_on: D("2026-11-19"), confirmation_id: "CFPB-RCPT-4471", evidence_document_id: "doc-cfpb-receipt-1" }, { kind: "human", id: "u-portal-op", role: "fnma_portal_operator" });
  assert.equal(recorded.remaining_open_requests, 0); assert.equal(recorded.event!.payload.submission_evidence, "doc-cfpb-receipt-1"); assert.equal(inst.status, "satisfied");
});
test("18.2-T8: Given a subpoena, then `SM_EXAM_LITIGATION_HOLD` blocks retention purges for the scoped loans (verified by attempting a purge job).", () => {
  // Given: a subpoena received 2026-10-20 scoped to two loans.
  const hold = litigationHoldRecord({ source: "subpoena", scope_loan_ids: ["L-101", "L-102"], received_on: D("2026-10-20") });
  assert.equal(hold.code, "SM_EXAM_LITIGATION_HOLD"); assert.equal(hold.active, true); assert.equal(hold.released_by_counsel_on, null); assert.equal(hold.gate.open, false);
  // When: the nightly retention purge is attempted over three loans.
  const attempt = retentionPurge({ loan_ids: ["L-101", "L-102", "L-103"], holds: [hold] });
  // Then: the scoped loans are refused with the gate's reason, the unscoped loan purges.
  assert.deepEqual(attempt.purged, ["L-103"]);
  assert.deepEqual(attempt.blocked.map((b) => [b.loan_id, b.hold_code]), [["L-101", "SM_EXAM_LITIGATION_HOLD"], ["L-102", "SM_EXAM_LITIGATION_HOLD"]]);
  assert.match(attempt.blocked[0]!.reason, /retention purge refused: subpoena hold received 2026-10-20 — SM_EXAM_LITIGATION_HOLD: retention purge blocked for scoped records until released by counsel/);
  // The hold is the platform's `legal_hold` fact: the purge job feeds it into 17.3's retention gate (`retentionFloorElapsed`), which refuses on it before the one-year floor is even considered —
  // L-101 (transferred out 2025-01-15, floor long past) is still refused, L-103 (same transfer, no hold) purges, L-104 (transferred 2026-06-01, no hold) is refused by the floor itself.
  assert.deepEqual(legalHoldFacts([hold], "L-101"), { legal_hold: true, hold_count: 1, legal_hold_code: "SM_EXAM_LITIGATION_HOLD", legal_hold_source: "subpoena", legal_hold_reason: "subpoena hold received 2026-10-20 — SM_EXAM_LITIGATION_HOLD: retention purge blocked for scoped records until released by counsel" });
  assert.equal(legalHoldFacts([hold], "L-103").legal_hold, false);
  const facts = { "L-101": { transfer_date: D("2025-01-15") }, "L-103": { transfer_date: D("2025-01-15") }, "L-104": { transfer_date: D("2026-06-01") } };
  const platform = retentionPurge({ loan_ids: ["L-101", "L-102", "L-103", "L-104"], holds: [hold], today: D("2026-10-21"), retention_facts: facts });
  assert.deepEqual(platform.purged, ["L-103"]);
  assert.deepEqual(platform.blocked.map((b) => [b.loan_id, b.gate, b.hold_code]), [["L-101", "17.3.retentionFloorElapsed", "SM_EXAM_LITIGATION_HOLD"], ["L-102", "SM_EXAM_LITIGATION_HOLD", "SM_EXAM_LITIGATION_HOLD"], ["L-104", "17.3.retentionFloorElapsed", null]]);
  assert.match(platform.blocked[0]!.reason, /legal hold: no purge or de-identification while the hold is open — subpoena hold received 2026-10-20/); assert.match(platform.blocked[2]!.reason, /no purge before 2027-06-01/);
  assert.equal(EVALUATORS_17_3["17.3.retentionFloorElapsed"]!(platform.facts["L-101"]!).open, false); assert.equal(EVALUATORS_17_3["17.3.retentionFloorElapsed"]!({ ...platform.facts["L-101"]!, legal_hold: false }).open, true, "the same facts without the hold pass the 17.3 gate");
  // A release recorded by the officer (or the agent) is not a counsel release: the purge job stays blocked.
  const officerRelease = litigationHoldRecord({ source: "subpoena", scope_loan_ids: ["L-101", "L-102"], received_on: D("2026-10-20"), released_by_counsel_on: D("2027-02-01"), released_by_role: "officer" });
  assert.equal(officerRelease.active, true);
  const stillHeld = retentionPurge({ loan_ids: ["L-101", "L-102"], holds: [officerRelease] });
  assert.deepEqual(stillHeld.purged, []); assert.match(stillHeld.blocked[0]!.reason, /release recorded by officer is not a counsel release — scoped records stay held/);
  assert.equal(retentionPurge({ loan_ids: ["L-101"], holds: [litigationHoldRecord({ source: "subpoena", scope_loan_ids: ["L-101"], received_on: D("2026-10-20"), released_by_counsel_on: D("2027-02-01"), released_by_role: "qc-audit" })] }).purged.length, 0);
  // Released by counsel → the gate opens and the same purge proceeds — through the 17.3 gate as well.
  const counsel = litigationHoldRecord({ source: "subpoena", scope_loan_ids: ["L-101", "L-102"], received_on: D("2026-10-20"), released_by_counsel_on: D("2027-02-01"), released_by_role: "attorney" });
  assert.equal(counsel.active, false); assert.deepEqual(retentionPurge({ loan_ids: ["L-101", "L-102"], holds: [counsel] }).purged, ["L-101", "L-102"]);
  assert.deepEqual(retentionPurge({ loan_ids: ["L-101"], holds: [counsel], today: D("2027-02-02"), retention_facts: facts }).purged, ["L-101"]);
  // The gate evaluator behind the registry row.
  const gate = EVALUATORS_18_2["18.2.litigationHoldReleased"]!;
  assert.equal(gate({ released_by_counsel_on: null, released_by_role: null }).open, false); assert.match(gate({}).reason!, /until released by counsel/);
  assert.equal(gate({ released_by_counsel_on: "2027-02-01", released_by_role: "officer" }).open, false); assert.match(litigationHoldReleased({ released_by_counsel_on: D("2027-02-01"), released_by_role: "officer" }).reason!, /not a counsel release/);
  assert.equal(gate({ released_by_counsel_on: "2027-02-01", released_by_role: "attorney" }).open, true);
  // Registry: the subpoena notice itself arms the not-before gate (trigger `source ∈ {litigation_discovery, subpoena}`), evaluator-backed, with no due date.
  const t = overridden().get("SM_EXAM_LITIGATION_HOLD")!;
  assert.equal(t.kindNorm, "not_before_gate"); assert.equal(t.triggerPattern!.type, "exam.notice.received"); assert.deepEqual(t.triggerPattern!.conditions, [{ field: "source", op: "in", value: ["litigation_discovery", "subpoena"] }]);
  assert.equal(t.offsetParsed.kind, "evaluator"); assert.equal((t.offsetParsed as { ref: string }).ref, "18.2.litigationHoldReleased");
  const { events, timers } = engine("2026-10-20T13:00:00.000Z");
  const served = ingestLitigationNotice(events, { exam_id: "LIT-2026-01", source: "subpoena", received_on: D("2026-10-20"), scope_loan_ids: ["L-101", "L-102"], document_id: "doc-subpoena-1" });
  assert.deepEqual(served.event, litigationNoticeEvent({ exam_id: "LIT-2026-01", source: "subpoena", received_on: D("2026-10-20"), scope_loan_ids: ["L-101", "L-102"], document_id: "doc-subpoena-1" })); assert.equal(served.appended.type, "exam.notice.received"); assert.equal(served.appended.payload.source, "subpoena"); assert.equal(served.hold.active, true);
  assert.throws(() => ingestLitigationNotice(events, { exam_id: "LIT-2026-03", source: "subpoena", received_on: D("2026-10-20"), scope_loan_ids: [], document_id: "doc-subpoena-3" }), RangeError);
  assert.throws(() => ingestLitigationNotice(events, { exam_id: "LIT-2026-03", source: "fnma_lqc" as "subpoena", received_on: D("2026-10-20"), scope_loan_ids: ["L-1"], document_id: "doc-x" }), RangeError);
  const armed = timers.byCode("SM_EXAM_LITIGATION_HOLD"); assert.equal(armed.length, 1); assert.equal(armed[0]!.status, "armed"); assert.equal(armed[0]!.dueDate, undefined); assert.equal(armed[0]!.note, "evaluator:18.2.litigationHoldReleased");
  emit(events, litigationNoticeEvent({ exam_id: "LIT-2026-02", source: "litigation_discovery", received_on: D("2026-10-21"), scope_loan_ids: ["L-300"], document_id: "doc-discovery-1" }), { kind: "exam", id: "LIT-2026-02" });
  assert.equal(timers.byCode("SM_EXAM_LITIGATION_HOLD").length, 2);
  emit(events, { type: "exam.notice.received", exam_id: "EX-2026-09", source: "fnma_lqc", review_type: "servicing_review", notified_on: "2026-10-21", received_at: "2026-10-21", stated_due: null, due_at: "2026-11-20", internal_target_at: "2026-11-20", document_id: "doc-lqc-9" }, { kind: "exam", id: "EX-2026-09" });
  assert.equal(timers.byCode("SM_EXAM_LITIGATION_HOLD").length, 2, "an LQC review notice is not a litigation hold");
});
test('18.2-T9: Given a response draft containing a legal conclusion ("we complied with §1024.41"), then the guardrail routes it to `attorney` before `officer`.', () => {
  // Given: a response draft to finding F-3 (which alleges a violation) whose second paragraph is a legal conclusion.
  const paragraphs: ResponseParagraph[] = [
    { text: "Finding F-3 (D2-2-02): the examiner alleges a missed outreach cadence on loan L-100.", citations: [{ ref_type: "cases", ref_id: "QCF-EX-2026-07-F-3" }] },
    { text: "We complied with §1024.41 throughout the evaluation of the borrower's application.", citations: [{ ref_type: "cases", ref_id: "LM-100" }] },
    { text: "2026-03-20: phone contact on loan L-100 — QRPC established.", citations: [{ ref_type: "contacts", ref_id: "ct-501" }] },
  ];
  const draft = renderExamResponse({ examiner: EXAMINER, exam_id: "EX-2026-07", date: D("2026-12-01"), subject_entity: "partner", servicer_number_owner: "partner", reference: { reference: "F-3", received_on: D("2026-11-20"), cited_requirement: "D2-2-02" }, paragraphs, elements: { root_cause: true, remediation: true, affected_population_with_count: true, evidence_of_correction: true } });
  assert.ok(draft.checklist.every((c) => c.ok)); assert.equal(draft.draft_hash.length, 64);
  const review = responseDraftReview({ draft, alleged_violation: true, counsel_review: null });
  // Then: the guardrail finds the legal conclusion and routes the draft to `attorney` before `officer`.
  assert.deepEqual(review.legal_conclusions, [{ paragraph: 1, text: "We complied with §1024.41 throughout the evaluation of the borrower's application.", phrase: "We complied with §1024" }]);
  assert.equal(legalConclusionGuardrail("we complied with §1024.41 throughout"), "attorney"); assert.equal(legalConclusionGuardrail("the borrower's complete application was received 2026-05-12"), null);
  assert.deepEqual(review.route, ["attorney", "officer"]);
  assert.deepEqual(review.escalations.map((e) => e.kind), ["attorney", "officer"]); assert.match(review.escalations[0]!.reason, /legal conclusion in the draft response \(¶1: "We complied with §1024\.41/); assert.match(review.escalations[1]!.reason, /officer certifications.*after counsel review/);
  assert.equal(review.officer_signature_allowed, false); assert.equal(review.refusal, "COUNSEL_REVIEW_REQUIRED");
  // The guardrail recognizes every characterization of legal compliance, not just the three cited phrases — while the examiner's own allegation, quoted, and plain facts pass.
  for (const s of ["We did not violate §1024.41 at any point.", "The servicer was compliant with D2-2-02.", "Servicing was in compliance with Regulation X.", "No violation of the D2-2-02 cadence occurred.", "We met every requirement of 12 CFR 1024.41(c).", "Our handling was lawful and consistent with the requirements of the Servicing Guide."]) assert.equal(legalConclusion18_2(s).attorney, true, s);
  assert.deepEqual(legalConclusion18_2("We did not violate §1024.41 at any point."), { attorney: true, phrase: "violate", basis: "compliance_characterization" });
  for (const s of ["Finding F-3 (D2-2-02): the examiner alleges a missed outreach cadence on loan L-100.", "The finding asserts a violation of D2-2-02; the contacts below are the record.", "2026-03-20: phone contact on loan L-100 — QRPC established.", "REGX_1024_39_LIVE_CONTACT_36 on loan L-100: satisfied (due 2026-03-22, satisfied 2026-03-20).", "the borrower's complete application was received 2026-05-12"]) assert.equal(legalConclusion18_2(s).attorney, false, s);
  // Even an officer signature cannot release it before counsel's review is recorded.
  assert.deepEqual(releaseGate({ review, signed_by_role: "officer", signer_entity: "partner", servicer_number_owner: "partner" }).refusal, "COUNSEL_REVIEW_REQUIRED");
  // Counsel's review is an `attorney` act on this draft's hash: recorded by the officer or the agent it is refused and the draft stays counsel-first; a date alone lifts nothing.
  const byOfficer = counselReviewRecorded({ exam_id: "EX-2026-07", reference: "F-3", draft, reviewed_on: D("2026-12-03"), reviewed_by_role: "officer", reviewer_id: "u-partner-officer" });
  assert.equal(byOfficer.event, null); assert.equal(byOfficer.refusal, "NOT_COUNSEL"); assert.equal(counselReviewed({ reviewed_on: D("2026-12-03"), reviewed_by_role: "officer" }), false); assert.equal(counselReviewed(null), false);
  const stillFirst = responseDraftReview({ draft, alleged_violation: true, counsel_review: { reviewed_on: D("2026-12-03"), reviewed_by_role: "officer" } });
  assert.deepEqual(stillFirst.route, ["attorney", "officer"]); assert.equal(stillFirst.refusal, "COUNSEL_REVIEW_REQUIRED"); assert.match(stillFirst.escalations[0]!.reason, /review recorded by officer is not a counsel review/);
  const byCounsel = counselReviewRecorded({ exam_id: "EX-2026-07", reference: "F-3", draft, reviewed_on: D("2026-12-03"), reviewed_by_role: "attorney", reviewer_id: "u-counsel" });
  assert.deepEqual(byCounsel.event, { type: "exam.response.counsel_reviewed", exam_id: "EX-2026-07", reference: "F-3", draft_hash: draft.draft_hash, reviewed_by_role: "attorney", reviewer_id: "u-counsel", reviewed_at: D("2026-12-03") });
  // On the event store: recordCounselReview appends it only for the `attorney` actor; counselReviewOnRecord finds it for this draft's hash and for no other draft.
  const store = new MemoryEventStore(new FixedClock("2026-12-03T15:00:00.000Z"));
  assert.equal(recordCounselReview(store, { exam_id: "EX-2026-07", reference: "F-3", draft, reviewed_on: D("2026-12-03") }, { kind: "human", id: "u-partner-officer", role: "officer" }).refusal, "NOT_COUNSEL");
  assert.equal(recordCounselReview(store, { exam_id: "EX-2026-07", reference: "F-3", draft, reviewed_on: D("2026-12-03") }, { kind: "agent", id: "qc-audit" }).refusal, "NOT_COUNSEL");
  assert.equal(store.all().length, 0); assert.equal(counselReviewOnRecord(store, { exam_id: "EX-2026-07", reference: "F-3", draft_hash: draft.draft_hash }), null);
  const rec = recordCounselReview(store, { exam_id: "EX-2026-07", reference: "F-3", draft, reviewed_on: D("2026-12-03") }, { kind: "human", id: "u-counsel", role: "attorney" });
  assert.equal(rec.event!.type, "exam.response.counsel_reviewed"); assert.equal(rec.event!.payload.draft_hash, draft.draft_hash); assert.deepEqual(rec.review, { reviewed_on: D("2026-12-03"), reviewed_by_role: "attorney", reviewer_id: "u-counsel" });
  assert.deepEqual(counselReviewOnRecord(store, { exam_id: "EX-2026-07", reference: "F-3", draft_hash: draft.draft_hash }), rec.review);
  assert.equal(counselReviewOnRecord(store, { exam_id: "EX-2026-07", reference: "F-3", draft_hash: "0".repeat(64) }), null, "an edited draft is unreviewed");
  // After counsel review the route is `officer` only — and no communication leaves without the officer's signature; under the partner's servicer number the partner's officer signs.
  const reviewed = responseDraftReview({ draft, alleged_violation: true, counsel_review: rec.review });
  assert.equal(reviewed.counsel_reviewed, true);
  assert.deepEqual(reviewed.route, ["officer"]); assert.equal(reviewed.officer_signature_allowed, true); assert.equal(reviewed.refusal, null);
  assert.equal(releaseGate({ review: reviewed, signed_by_role: null, signer_entity: null, servicer_number_owner: "partner" }).refusal, "OFFICER_SIGNATURE_REQUIRED");
  assert.equal(releaseGate({ review: reviewed, signed_by_role: "qc-audit", signer_entity: "supermortgage", servicer_number_owner: "partner" }).refusal, "OFFICER_SIGNATURE_REQUIRED");
  assert.equal(releaseGate({ review: reviewed, signed_by_role: "officer", signer_entity: "supermortgage", servicer_number_owner: "partner" }).refusal, "PARTNER_OFFICER_SIGNS");
  assert.deepEqual(releaseGate({ review: reviewed, signed_by_role: "officer", signer_entity: "supermortgage", servicer_number_owner: "supermortgage" }).allowed, true);
  const release = releaseGate({ review: reviewed, signed_by_role: "officer", signer_entity: "partner", servicer_number_owner: "partner" });
  assert.equal(release.allowed, true); assert.equal(release.refusal, null); assert.match(release.citation, /MORA\/exam responses.*officer certifications/);
  // The EXAM-RESP-v1 checklist judges the officer signature block: unsigned, `officer`, the entity whose servicer number the response goes out under. A pre-signed block, an agent's block or the wrong entity's officer fails and blocks release.
  assert.deepEqual(signatureBlockCheck({ role: "officer", entity: "partner", signer_id: null, signed_on: null }, "partner"), { ok: true });
  const preSigned = renderExamResponse({ examiner: EXAMINER, exam_id: "EX-2026-07", date: D("2026-12-01"), subject_entity: "partner", servicer_number_owner: "partner", reference: { reference: "F-3", received_on: D("2026-11-20"), cited_requirement: "D2-2-02" }, paragraphs: [paragraphs[0]!, paragraphs[2]!], elements: { root_cause: true, remediation: true, affected_population_with_count: true, evidence_of_correction: true }, signature_block: { role: "qc-audit", entity: "supermortgage", signer_id: "agent:qc-audit", signed_on: D("2026-12-01") } });
  const sig = preSigned.checklist.find((c) => c.id === "officer_signature_block")!; assert.equal(sig.ok, false); assert.match(sig.why!, /names qc-audit, not the officer/);
  assert.match(signatureBlockCheck({ role: "officer", entity: "supermortgage", signer_id: null, signed_on: null }, "partner").why!, /goes out under the partner's servicer number/);
  assert.match(signatureBlockCheck({ role: "officer", entity: "partner", signer_id: "u-officer", signed_on: D("2026-12-01") }, "partner").why!, /pre-signed at draft/);
  const badBlock = responseDraftReview({ draft: preSigned, alleged_violation: false, counsel_review: null });
  assert.equal(badBlock.refusal, "SIGNATURE_BLOCK_INVALID"); assert.equal(badBlock.officer_signature_allowed, false); assert.deepEqual(badBlock.route, ["officer"]); assert.match(badBlock.escalations[0]!.reason, /fix the signature block first/);
  assert.equal(releaseGate({ review: badBlock, signed_by_role: "officer", signer_entity: "partner", servicer_number_owner: "partner" }).refusal, "SIGNATURE_BLOCK_INVALID");
  // A factual draft on a finding that alleges no violation goes straight to the officer; an alleged violation alone still puts counsel first.
  const factual = renderExamResponse({ examiner: EXAMINER, exam_id: "EX-2026-07", date: D("2026-12-01"), subject_entity: "partner", servicer_number_owner: "partner", reference: { reference: "F-4", received_on: D("2026-11-20"), cited_requirement: "A2-4-01" }, paragraphs: [paragraphs[0]!, paragraphs[2]!], elements: { root_cause: true, remediation: true, affected_population_with_count: true, evidence_of_correction: true } });
  assert.deepEqual(responseDraftReview({ draft: factual, alleged_violation: false, counsel_review: null }).route, ["officer"]);
  assert.deepEqual(responseDraftReview({ draft: factual, alleged_violation: true, counsel_review: null }).route, ["attorney", "officer"]);
  // A compliance characterization on a finding that alleges no violation is still counsel-first (the guardrail, not the flag, catches it).
  const characterized = renderExamResponse({ ...factual.header, examiner: EXAMINER, reference: factual.request_reference, paragraphs: [paragraphs[0]!, { text: "The servicer was compliant with D2-2-02 throughout.", citations: [{ ref_type: "timers", ref_id: "tm-9002" }] }], elements: { root_cause: true, remediation: true, affected_population_with_count: true, evidence_of_correction: true } });
  assert.deepEqual(responseDraftReview({ draft: characterized, alleged_violation: false, counsel_review: null }).route, ["attorney", "officer"]);
  // The counsel-reviewed, officer-signed response is what satisfies FNMA_SCR_FINDING_RESPONSE_AS_STATED; the pre-review submission is refused and satisfies nothing.
  const { events, timers } = engine("2026-11-20T15:00:00.000Z");
  emit(events, { type: "exam.finding.received", exam_id: "EX-2026-07", finding_ref: "F-3", received_at: "2026-11-20", response_due_stated: "2026-12-20", qc_finding_case_id: "QCF-EX-2026-07-F-3" }, EXAM);
  const resp = timers.byCode("FNMA_SCR_FINDING_RESPONSE_AS_STATED")[0]!; assert.equal(resp.dueDate, D("2026-12-20"));
  const refused = findingResponseSubmitted({ exam_id: "EX-2026-07", finding_ref: "F-3", review, signed_by_role: "officer", signer_entity: "partner", servicer_number_owner: "partner", response_document_id: "doc-resp-1", submitted_on: D("2026-12-04") });
  assert.equal(refused.event, null); assert.equal(refused.refusal, "COUNSEL_REVIEW_REQUIRED"); assert.equal(resp.status, "armed");
  assert.equal(findingResponseSubmitted({ exam_id: "EX-2026-07", finding_ref: "F-3", review: reviewed, signed_by_role: "officer", signer_entity: "partner", servicer_number_owner: "partner", response_document_id: null, submitted_on: D("2026-12-04") }).refusal, "RESPONSE_DOCUMENT_REQUIRED");
  const sent = findingResponseSubmitted({ exam_id: "EX-2026-07", finding_ref: "F-3", review: reviewed, signed_by_role: "officer", signer_entity: "partner", servicer_number_owner: "partner", response_document_id: "doc-resp-1", submitted_on: D("2026-12-04") });
  assert.deepEqual(sent.event, { type: "exam.finding.responded", exam_id: "EX-2026-07", finding_ref: "F-3", response_document_id: "doc-resp-1", submitted_at: D("2026-12-04") });
  // On the store the release is the `officer` actor's act (the actor's role, never a role the input claims) for a finding on record: the agent's release, an unreviewed draft, or a finding not on record appends nothing; the partner officer's release satisfies the row.
  const OFFICER: Actor = { kind: "human", id: "u-partner-officer", role: "officer" }; const sendInput = { exam_id: "EX-2026-07", finding_ref: "F-3", signer_entity: "partner" as const, servicer_number_owner: "partner" as const, response_document_id: "doc-resp-1", submitted_on: D("2026-12-04") };
  assert.equal(recordFindingResponse(events, { ...sendInput, review }, OFFICER).refusal, "COUNSEL_REVIEW_REQUIRED");
  assert.equal(recordFindingResponse(events, { ...sendInput, review: reviewed }, { kind: "agent", id: "qc-audit" }).refusal, "OFFICER_SIGNATURE_REQUIRED");
  assert.equal(recordFindingResponse(events, { ...sendInput, review: reviewed, finding_ref: "F-7" }, OFFICER).refusal, "NO_FINDING_ON_RECORD");
  assert.equal(events.ofType("exam.finding.responded").length, 0); assert.equal(resp.status, "armed");
  const released = recordFindingResponse(events, { ...sendInput, review: reviewed }, OFFICER);
  assert.equal(released.refusal, null); assert.equal(released.event!.type, "exam.finding.responded"); assert.equal(released.event!.payload.response_document_id, "doc-resp-1"); assert.equal(released.event!.actor.id, "u-partner-officer");
  assert.equal(resp.status, "satisfied");
});

test("18.2 timers: every registry row of the process is armable and satisfiable after the section overrides, and each is armed and satisfied by the events ops-18-2 emits", () => {
  const reg = overridden();
  const rows = reg.unique().filter((t) => t.process === "18.2");
  assert.equal(rows.length, 9);
  for (const t of rows) {
    assert.ok(t.offsetParsed.kind !== "prose" && t.triggerPattern !== null && t.triggerPattern.type.includes("."), `${t.code} armable`);
    assert.ok(t.offsetParsed.kind === "evaluator" || (t.satisfiedPattern !== null && t.satisfiedPattern.type.includes(".")), `${t.code} satisfiable`);
  }
  // anchors survive the override merge (TimerRegistry.override re-parses anchorField unless the override passes it); two computed anchors carry conditions the offset grammar cannot
  assert.deepEqual(Object.fromEntries(rows.map((t) => [t.code, t.anchorField])), {
    FNMA_A2401_REVIEW_FILE_30: "due_at", SM_EXAM_INTERNAL_NOTIFY_2BD: "received_at", SM_EXAM_SCOPE_5BD: "received_at", EXAM_REQUEST_DUE_AS_STATED: "due_at", SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD: "approve_by",
    FNMA_SCR_FINDING_RESPONSE_AS_STATED: "response_due_stated", SM_EXAM_REMEDIATION_PLAN_15BD: "received_at", FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD: "received_at", SM_EXAM_LITIGATION_HOLD: null,
  });
  assert.equal(reg.get("FNMA_A2401_REVIEW_FILE_30")!.offsetParsed.kind, "same_day"); assert.equal(reg.get("SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD")!.offsetParsed.kind, "same_day"); assert.equal(reg.get("FNMA_SCR_FINDING_RESPONSE_AS_STATED")!.offsetParsed.kind, "same_day");
  assert.deepEqual(reg.get("SM_EXAM_REMEDIATION_PLAN_15BD")!.offsetParsed, { kind: "step", n: 15, unit: "business_days_servicer" }); assert.deepEqual(reg.get("SM_EXAM_INTERNAL_NOTIFY_2BD")!.offsetParsed, { kind: "step", n: 2, unit: "business_days_servicer" });
  assert.equal(reg.get("SM_EXAM_INTERNAL_NOTIFY_2BD")!.triggerPattern!.type, "exam.contact.received"); assert.equal(reg.get("SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD")!.kindNorm, "not_before_gate");
  // the evaluator ref exists and every evaluator key is referenced
  const refs = rows.filter((t) => t.offsetParsed.kind === "evaluator").map((t) => (t.offsetParsed as { ref: string }).ref).sort();
  assert.deepEqual(refs, ["18.2.litigationHoldReleased"]); assert.deepEqual(Object.keys(EVALUATORS_18_2).sort(), refs);
  // FNMA_A2401_REVIEW_FILE_30: due on the notice's `due_at`; a mailed submission (no LQC confirmation) does not satisfy it; the LQC confirmation that leaves no request open does.
  const { events, timers } = engine();
  emit(events, { type: "exam.notice.received", exam_id: "EX-2026-07", source: "fnma_lqc", review_type: "servicing_review", notified_on: "2026-10-16", received_at: "2026-10-16", stated_due: null, due_at: "2026-11-15", internal_target_at: "2026-11-13", document_id: "doc-lqc-1" }, EXAM);
  const file30 = timers.byCode("FNMA_A2401_REVIEW_FILE_30")[0]!; assert.equal(file30.dueDate, D("2026-11-15"));
  const scope = timers.byCode("SM_EXAM_SCOPE_5BD")[0]!; assert.equal(scope.dueDate, D("2026-10-23")); emit(events, { type: "exam.scoped", exam_id: "EX-2026-07", request_count: 25, scoped_at: "2026-10-19" }, EXAM); assert.equal(scope.status, "satisfied");
  emit(events, submissionRecorded({ exam_id: "EX-2026-07", request_no: "R-001", channel: "mail", submitted_on: D("2026-11-12"), confirmation_id: null, evidence_document_id: "doc-sent-mail-1" }).event!, EXAM);
  assert.equal(file30.status, "armed");
  assert.match(submissionRecorded({ exam_id: "EX-2026-07", request_no: "R-001", channel: "fnma_lqc", submitted_on: D("2026-11-13"), confirmation_id: null, evidence_document_id: "doc-screenshot-1" }).refusal!, /only by `exam.request.submitted` with LQC confirmation/);
  emit(events, submissionRecorded({ exam_id: "EX-2026-07", request_no: "R-001", channel: "fnma_lqc", submitted_on: D("2026-11-13"), confirmation_id: "LQC-88213", evidence_document_id: "doc-screenshot-1", open_requests_after: 3 }).event!, EXAM);
  assert.equal(file30.status, "armed", "three files of the review are still open");
  const lqc = submissionRecorded({ exam_id: "EX-2026-07", request_no: "R-004", channel: "fnma_lqc", submitted_on: D("2026-11-13"), confirmation_id: "LQC-88216", evidence_document_id: "doc-screenshot-4", open_requests_after: 0 });
  assert.equal(lqc.event!.lqc_confirmation_id, "LQC-88216"); assert.equal(lqc.event!.remaining_open_requests, 0); emit(events, lqc.event!, EXAM); assert.equal(file30.status, "satisfied");
  // SM_EXAM_INTERNAL_NOTIFY_2BD: examiner contact → partner + officer within 2 BD; the acknowledgment exists only once both are notified.
  const contact = examinerContact({ exam_id: "EX-2026-07", source: "fnma_letter", contacted_on: D("2026-10-16"), channel: "letter", summary: "SF CPM division letter" });
  assert.equal(contact.notify_by, D("2026-10-20")); emit(events, contact.event, EXAM);
  const notify = timers.byCode("SM_EXAM_INTERNAL_NOTIFY_2BD")[0]!; assert.equal(notify.dueDate, D("2026-10-20"));
  const partial = internalNotification({ exam_id: "EX-2026-07", partner_notified_on: D("2026-10-16"), officer_notified_on: null }); assert.equal(partial.event, null); assert.deepEqual(partial.missing, ["officer"]);
  emit(events, internalNotification({ exam_id: "EX-2026-07", partner_notified_on: D("2026-10-16"), officer_notified_on: D("2026-10-19") }).event!, EXAM); assert.equal(notify.status, "satisfied");
  // SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD: assembled → due on the computed approve-by; approval by the agent, or by the officer before the package sat 1 BD, is refused; the officer's approval inside the window satisfies it.
  emit(events, { type: "exam.package.assembled", exam_id: "EX-2026-07", request_no: "R-001", assembled_at: "2026-11-06", due_at: "2026-11-15", review_opens_on: "2026-11-09", approve_by: "2026-11-12", manifest_sha256: "ab".repeat(32) }, EXAM);
  const win = timers.byCode("SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD")[0]!; assert.equal(win.anchorDate, D("2026-11-12")); assert.equal(win.dueDate, D("2026-11-12")); assert.equal(win.note, undefined);
  const common = { exam_id: "EX-2026-07", request_no: "R-001", assembled_on: D("2026-11-06"), due_at: D("2026-11-15"), approved_by_id: "u-officer", approver_entity: "partner" as const, manifest_sha256: "ab".repeat(32), cal: fannieEt };
  assert.match(officerApproval({ ...common, approved_on: D("2026-11-10"), approved_by_role: "qc-audit" }).refusal!, /officer certifications/);
  assert.match(officerApproval({ ...common, approved_on: D("2026-11-10"), approved_by_role: "officer", approver_entity: "supermortgage" }).refusal!, /partner's officer signs/);
  assert.match(officerApproval({ ...common, approved_on: D("2026-11-06"), approved_by_role: "officer" }).refusal!, /before the package sat ≥1 BD/);
  const approved = officerApproval({ ...common, approved_on: D("2026-11-10"), approved_by_role: "officer" });
  assert.equal(approved.approved, true); assert.deepEqual(approved.production, { approved_by_officer_id: "u-officer", approver_entity: "partner", approved_at: D("2026-11-10") }); assert.equal(approved.portal_task!.to, "fnma_portal_operator");
  emit(events, approved.event!, EXAM); assert.equal(win.status, "satisfied");
  // FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD: the 18.1 delivery event satisfies the 18.2 row.
  emit(events, { type: "fnma.request.received", kind: "qc_results", request_id: "QR-1", received_at: "2026-10-16" }, EXAM);
  const qr = timers.byCode("FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD")[0]!; assert.equal(qr.dueDate, D("2026-10-30"));
  emit(events, qcResultsDelivered({ request_id: "QR-1", delivered_on: D("2026-10-28"), signed_by_role: "officer", delivery_evidence_document_id: "doc-qc-results-1" }).event!, EXAM); assert.equal(qr.status, "satisfied");
  const open = timers.open().map((t) => t.code).sort(); assert.deepEqual(open, []);
});

test("18.2 tools: the spec's eight tools run through the command bus for `qc-audit`, and the three guardrail sentences refuse on it", async () => {
  // The spec's Tools line, verbatim; the bus list is the subset the agent registry names (empty until tools/extract_agents.py reads this Tools line).
  assert.deepEqual(SPEC_TOOLS_18_2.map((t) => t.name), ["evidence.query(taxonomy_node, loan_ids, period)", "documents.compile_pdf", "privilege.screen", "pii.redact", "letters.render", "escalations.create", "human_portal_task.create", "cases.create{qc_finding}"]);
  assert.ok(SPEC_TOOLS_18_2.every((t) => t.process === "18.2" && t.agent === "qc-audit"));
  const named = new Set(loadAgentsFile().processes.find((p) => p.process === "18.2")!.tools);
  assert.deepEqual(TOOLS_18_2.map((t) => t.name), SPEC_TOOLS_18_2.map((t) => t.name).filter((n) => named.has(n)), "only registry-named tools reach the bus");
  // Harness: the definitions bound as commands over a runtime, allowlisted to the agent, executed through the real CommandBus (the same path src/app/tools.test.ts drives).
  const clock = new FixedClock("2026-11-10T15:00:00.000Z"); const events = new MemoryEventStore(clock); const reg = overridden(); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "L-100", events, ledger: new MemoryLedger(), timers: new TimerEngine(reg, events, { processes: ["18.2"] }), clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = new Map(SPEC_TOOLS_18_2.map((t) => { const c = toolCommand(t, rt, ["attorney", "fnma_portal_operator", "officer"]); agents.registerTool(t.agent, c.name); return [t.name, c] as const; }));
  const bus = new CommandBus(agents); const QC: Actor = { kind: "agent", id: "qc-audit" }; const PARTNER_OFFICER: Actor = { kind: "human", id: "u-partner-officer", role: "officer" };
  const run = (name: string, actor: Actor, input: Record<string, unknown>) => bus.execute(cmds.get(name)!, actor, input, uow);
  const refused = async (name: string, actor: Actor, input: Record<string, unknown>, code: string) => assert.rejects(run(name, actor, input), (e: unknown) => e instanceof CommandRefused && e.code === code, `${name} → ${code}`);
  // evidence.query: reads the evidence index by taxonomy node / loans / period; never writes; empty input is a RangeError, not a TypeError.
  rt.store.put("evidence_index", "1", { loan_id: "L-100", node: "cfpb.m8.loss_mitigation.41c_evaluation", ref_type: "contacts", ref_id: "ct-501", occurred_at: "2026-03-20" }, SYSTEM, clock.now());
  rt.store.put("evidence_index", "2", { loan_id: "L-200", node: "cfpb.m8.loss_mitigation.41c_evaluation", ref_type: "contacts", ref_id: "ct-777", occurred_at: "2026-04-06" }, SYSTEM, clock.now());
  const q = await run("evidence.query(taxonomy_node, loan_ids, period)", QC, { taxonomy_node: "cfpb.m8", loan_ids: ["L-100"], period: { from: "2026-01-01", to: "2026-12-31" } });
  assert.deepEqual((q.output as { evidence_refs: unknown[] }).evidence_refs, [{ ref_type: "contacts", ref_id: "ct-501" }]); assert.equal(decisions.length, 0, "a read leaves no decision row");
  await refused("evidence.query(taxonomy_node, loan_ids, period)", QC, { taxonomy_node: "cfpb.m8", loan_ids: ["L-100"], op: "write" }, "EVIDENCE_INDEX_READ_ONLY");
  await assert.rejects(run("evidence.query(taxonomy_node, loan_ids, period)", QC, {}), (e: unknown) => e instanceof RangeError);
  // Guardrail 1 — the agent never characterizes legal compliance without counsel review when a finding alleges a violation: the draft renders and is routed to counsel; releasing it is refused until counsel's review of this draft is on record — an `attorney` act through the bus, never a date the caller asserts.
  const letter = { examiner: EXAMINER, exam_id: "EX-2026-07", date: "2026-12-01", subject_entity: "partner", servicer_number_owner: "partner", reference: { reference: "F-3", received_on: "2026-11-20", cited_requirement: "D2-2-02" }, alleged_violation: true, elements: { root_cause: true, remediation: true, affected_population_with_count: true, evidence_of_correction: true },
    paragraphs: [{ text: "Finding F-3 (D2-2-02): the examiner alleges a missed outreach cadence on loan L-100.", citations: [{ ref_type: "cases", ref_id: "QCF-EX-2026-07-F-3" }] }, { text: "We complied with §1024.41 throughout the evaluation.", citations: [{ ref_type: "cases", ref_id: "LM-100" }] }] };
  const drafted = await run("letters.render", QC, letter);
  assert.deepEqual((drafted.output as { review: { route: string[] } }).review.route, ["attorney", "officer"]); assert.equal(decisions.at(-1)!.action, "letters.render");
  await refused("letters.render", QC, { ...letter, op: "release" }, "COUNSEL_REVIEW_REQUIRED");
  await refused("letters.render", PARTNER_OFFICER, { ...letter, op: "release", signer_entity: "partner" }, "COUNSEL_REVIEW_REQUIRED");
  // Recording counsel's review is an attorney act: the agent, the officer and an analyst are refused on it; the attorney's call appends `exam.response.counsel_reviewed` for this draft's hash.
  await refused("letters.render", QC, { ...letter, op: "counsel_review", reviewed_on: "2026-12-03" }, "COUNSEL_REVIEW_IS_AN_ATTORNEY_ACT");
  await refused("letters.render", PARTNER_OFFICER, { ...letter, op: "counsel_review", reviewed_on: "2026-12-03" }, "COUNSEL_REVIEW_IS_AN_ATTORNEY_ACT");
  await refused("letters.render", { kind: "human", id: "u-analyst", role: "ops_analyst" }, { ...letter, op: "counsel_review", reviewed_on: "2026-12-03" }, "COUNSEL_REVIEW_IS_AN_ATTORNEY_ACT");
  assert.equal(events.ofType("exam.response.counsel_reviewed").length, 0);
  const ATTORNEY: Actor = { kind: "human", id: "u-counsel", role: "attorney" };
  const counsel = await run("letters.render", ATTORNEY, { ...letter, op: "counsel_review", reviewed_on: "2026-12-03" });
  assert.deepEqual((counsel.output as { counsel_review: unknown }).counsel_review, { reviewed_on: "2026-12-03", reviewed_by_role: "attorney", reviewer_id: "u-counsel" });
  const cr = events.ofType("exam.response.counsel_reviewed"); assert.equal(cr.length, 1); assert.equal(cr[0]!.payload.draft_hash, (drafted.output as { draft: { draft_hash: string } }).draft.draft_hash); assert.equal(cr[0]!.actor.id, "u-counsel");
  // An edited draft (one more paragraph) is not the draft counsel reviewed: still counsel-first.
  await refused("letters.render", PARTNER_OFFICER, { ...letter, op: "release", signer_entity: "partner", paragraphs: [...letter.paragraphs, { text: "2026-04-06: letter sent, no response.", citations: [{ ref_type: "contacts", ref_id: "ct-502" }] }] }, "COUNSEL_REVIEW_REQUIRED");
  // Guardrail 2 — no communication leaves without `officer` signature: after counsel review the agent still cannot release; the officer can.
  await refused("letters.render", QC, { ...letter, op: "release" }, "OFFICER_SIGNATURE_REQUIRED");
  await refused("letters.render", { kind: "human", id: "u-analyst", role: "ops_analyst" }, { ...letter, op: "release", signer_entity: "partner" }, "OFFICER_SIGNATURE_REQUIRED");
  // Guardrail 3 — the partner's officer signs anything submitted under the partner's servicer number.
  await refused("letters.render", { kind: "human", id: "u-sm-officer", role: "officer" }, { ...letter, op: "release", signer_entity: "supermortgage" }, "PARTNER_OFFICER_SIGNS");
  const released = await run("letters.render", PARTNER_OFFICER, { ...letter, op: "release", signer_entity: "partner" });
  const rel = released.output as { released: boolean; review: { refusal: null; counsel_reviewed: boolean }; response_document_id: string; finding_on_record: boolean };
  assert.equal(rel.released, true); assert.equal(rel.review.refusal, null); assert.equal(rel.review.counsel_reviewed, true);
  // The released letter is stored as the response document under the officer's signature; F-3 is not yet a finding on record, so this release is a plain `exam.response.released` (the finding path is proved below, after cases.create ingests F-3).
  assert.equal(rt.store.get("documents", rel.response_document_id)!.data.signed_by, "u-partner-officer"); assert.equal(rt.store.get("documents", rel.response_document_id)!.data.sha256, (drafted.output as { draft: { draft_hash: string } }).draft.draft_hash);
  assert.equal(rel.finding_on_record, false); assert.equal(events.ofType("exam.response.released").length, 1); assert.equal(events.ofType("exam.finding.responded").length, 0);
  // Under Supermortgage's own servicer number the draft (a different hash: different owner) needs its own counsel review before the Supermortgage officer releases it.
  const own = { ...letter, servicer_number_owner: "supermortgage", signer_entity: "supermortgage" };
  await refused("letters.render", { kind: "human", id: "u-sm-officer", role: "officer" }, { ...own, op: "release" }, "COUNSEL_REVIEW_REQUIRED");
  await run("letters.render", ATTORNEY, { ...own, op: "counsel_review", reviewed_on: "2026-12-03" });
  assert.equal((await run("letters.render", { kind: "human", id: "u-sm-officer", role: "officer" }, { ...own, op: "release" })).event.type, "command.executed");
  // privilege.screen / pii.redact: A2-4.1-02 — a withholding or a redaction aimed at what Fannie Mae owns is refused before the handler runs.
  const docs = [{ document_id: "doc-memo-1", document_class: "attorney_client", description: "counsel memo" }, { document_id: "doc-note-1", document_class: "servicing_note", description: "notes", non_borrower_pii: ["tenant name: R. Occupant"] }];
  const screen = await run("privilege.screen", QC, { exam_request_id: "R-001", documents: docs, proposed_withholdings: [{ document_id: "doc-note-1", reason: "unflattering" }] });
  assert.deepEqual((screen.output as { produced: string[]; refused_withholdings: { document_id: string }[] }).produced, ["doc-note-1"]); assert.equal((screen.output as { refused_withholdings: unknown[] }).refused_withholdings.length, 1);
  await refused("privilege.screen", QC, { exam_request_id: "R-001", documents: docs, op: "withhold" }, "FNMA_RECORDS_NEVER_WITHHELD");
  assert.deepEqual((await run("pii.redact", QC, { documents: docs })).output, { redactions: [{ document_id: "doc-note-1", redacted: ["tenant name: R. Occupant"], reason: "non_borrower_pii" }], untouched: ["doc-memo-1"] });
  await refused("pii.redact", QC, { documents: docs, target: "borrower" }, "NO_REDACTION_OF_FNMA_RECORDS");
  // documents.compile_pdf: refused without the privilege screen; with it, compiles, QA's, stores the production and emits `exam.package.assembled` — which arms the officer-review row on its approve-by.
  const file: ReviewFileInput = { loan: { fnma_loan_number: "1234567890", servicer_loan_number: "SM-0001", borrower_name: "Jane Q. Borrower", property_address: "12 Elm St, Springfield, IL 62701", remittance_type: "S/A", servicing_option: "special", file_type: "servicing_review" }, contacts: [{ on: D("2026-03-20"), mode: "phone", result: "qrpc_established", qrpc: true }], delinquency_notices: [], payment_history: [], workouts: [{ kind: "flex_mod", decided_on: D("2026-05-12"), outcome: "denied", smdu_case_id: "SMDU-77" }], bankruptcy: null, foreclosure: null, expenses: [{ advance_id: "ADV-1", vendor: "Springfield Inspections LLC", invoice_document_id: "doc-inv-1", amount_cents: 2_000n }], timers: [{ code: "REGX_1024_39_LIVE_CONTACT_36", status: "satisfied", satisfied_by_event_id: "ev-101", evidence_hash: "ab12" }] };
  await refused("documents.compile_pdf", QC, { exam_id: "EX-2026-07", request_no: "R-001", file, due_at: "2026-11-15" }, "PRIVILEGE_SCREEN_REQUIRED");
  const compiled = await run("documents.compile_pdf", QC, { exam_id: "EX-2026-07", request_no: "R-001", file, due_at: "2026-11-15", assembled_on: "2026-11-06", calendar: "fannie_et", privilege_screen: screen.output, documents: docs, compiled_document_ids: ["doc-note-1"] });
  const out = compiled.output as { manifest: { sha256: string }; package_document_id: string; qa: { passed: boolean; manifest_matches: boolean }; completeness: { complete: boolean }; request_status: string; window: { approve_by: PlainDate } };
  assert.equal(out.qa.passed, true); assert.equal(out.completeness.complete, true); assert.equal(out.request_status, "officer_review"); assert.equal(out.window.approve_by, D("2026-11-12"));
  assert.equal(rt.store.get("exam_productions", "EX-2026-07/R-001")!.data.privilege_log_document_id, "privlog-R-001");
  // The compiled PDF is persisted: a `documents` row whose stored content hashes to the manifest (the QA's hash check read it back from the store), linked from exam_requests.package_document_id and exam_productions.package_document_id.
  const storedPdf = rt.store.get("documents", out.package_document_id)!.data as { kind: string; content: string; sha256: string };
  assert.equal(storedPdf.kind, "exam_production_package"); assert.equal(createHash("sha256").update(storedPdf.content).digest("hex"), out.manifest.sha256); assert.equal(storedPdf.sha256, out.manifest.sha256); assert.equal(out.qa.manifest_matches, true);
  assert.equal(rt.store.get("exam_requests", "EX-2026-07/R-001")!.data.package_document_id, out.package_document_id); assert.equal(rt.store.get("exam_productions", "EX-2026-07/R-001")!.data.package_document_id, out.package_document_id); assert.equal(rt.store.get("exam_productions", "EX-2026-07/R-001")!.data.approved_by_officer_id, null);
  const win = uow.timers.byCode("SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD")[0]!; assert.equal(win.dueDate, D("2026-11-12")); assert.equal(win.status, "armed");
  const incomplete = await run("documents.compile_pdf", QC, { exam_id: "EX-2026-07", request_no: "R-002", file, due_at: "2026-11-15", privilege_screen: screen.output, documents: docs, compiled_document_ids: [] });
  assert.equal((incomplete.output as { request_status: string }).request_status, "assembling", "a package missing a Fannie Mae-owned record never reaches the officer"); assert.equal(rt.store.get("exam_requests", "EX-2026-07/R-002")!.data.package_document_id, null);
  // The communication that leaves — the LQC upload task — carries the officer-approved package only: with no `exam.package.approved` on record it is refused, however the input asserts an officer id, an approval date or a review window.
  const task = { exam_id: "EX-2026-07", request_no: "R-001", manifest_sha256: out.manifest.sha256, servicer_number_owner: "partner" };
  await refused("human_portal_task.create", QC, { ...task, approved_by_officer_id: "u-partner-officer", approver_entity: "partner", approved_on: "2026-11-10", assembled_on: "2026-11-06", due_at: "2026-11-15", calendar: "fannie_et" }, "OFFICER_SIGNATURE_REQUIRED");
  await refused("human_portal_task.create", QC, task, "OFFICER_SIGNATURE_REQUIRED");
  // Approval is the officer's act on the package on record (`documents.compile_pdf op=approve`): the agent is refused; the supermortgage officer cannot approve a package under the partner's number; a request with no package, a day before the window opens (clock 11-06) and a day after approve-by (clock 11-13) are refused — nothing is appended by any of them.
  const approve = { exam_id: "EX-2026-07", request_no: "R-001", op: "approve", approver_entity: "partner", servicer_number_owner: "partner", manifest_sha256: out.manifest.sha256 };
  const SM_OFFICER: Actor = { kind: "human", id: "u-sm-officer", role: "officer" };
  await refused("documents.compile_pdf", QC, approve, "OFFICER_SIGNATURE_REQUIRED");
  await refused("documents.compile_pdf", { kind: "human", id: "u-analyst", role: "ops_analyst" }, approve, "OFFICER_SIGNATURE_REQUIRED");
  await refused("documents.compile_pdf", SM_OFFICER, { ...approve, approver_entity: "supermortgage" }, "PARTNER_OFFICER_SIGNS");
  await refused("documents.compile_pdf", PARTNER_OFFICER, { ...approve, request_no: "R-009" }, "SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD");
  clock.set("2026-11-06T18:00:00.000Z"); await refused("documents.compile_pdf", PARTNER_OFFICER, approve, "SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD");
  clock.set("2026-11-13T15:00:00.000Z"); await refused("documents.compile_pdf", PARTNER_OFFICER, approve, "SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD");
  clock.set("2026-11-10T15:00:00.000Z");
  const wrongManifest = await run("documents.compile_pdf", PARTNER_OFFICER, { ...approve, manifest_sha256: "00".repeat(32) });
  assert.equal((wrongManifest.output as { approved: boolean }).approved, false); assert.match((wrongManifest.output as { refusal: string }).refusal, /not the package on record/);
  assert.equal(events.ofType("exam.package.approved").length, 0); assert.equal(win.status, "armed");
  const approved = await run("documents.compile_pdf", PARTNER_OFFICER, approve);
  assert.equal((approved.output as { approved: boolean }).approved, true); assert.equal(decisions.at(-1)!.action, "documents.compile_pdf:approve");
  const pa = events.ofType("exam.package.approved"); assert.equal(pa.length, 1); assert.deepEqual([pa[0]!.payload.approved_by_officer_id, pa[0]!.payload.approved_by_role, pa[0]!.payload.approver_entity, pa[0]!.payload.approved_at, pa[0]!.payload.manifest_sha256], ["u-partner-officer", "officer", "partner", "2026-11-10", out.manifest.sha256]);
  assert.equal(win.status, "satisfied"); assert.deepEqual([rt.store.get("exam_productions", "EX-2026-07/R-001")!.data.approved_by_officer_id, rt.store.get("exam_productions", "EX-2026-07/R-001")!.data.approved_at], ["u-partner-officer", "2026-11-10"]);
  // Now the upload task goes out — for this manifest only, and the approving officer on the task is the one on record, not the id the input asserts.
  await refused("human_portal_task.create", QC, { ...task, manifest_sha256: "00".repeat(32) }, "OFFICER_SIGNATURE_REQUIRED");
  const portal = await run("human_portal_task.create", QC, { ...task, approved_by_officer_id: "u-someone-else", lqc_identifiers: { case: "LQC-C-1" } });
  const portalOut = portal.output as { ownerRole: string; kind: string; payload: { approved_by_officer_id: string; approver_entity: string; approved_at: string; manifest_sha256: string } };
  assert.equal(portalOut.ownerRole, "fnma_portal_operator"); assert.equal(portalOut.kind, "human_portal_task"); assert.equal(decisions.at(-1)!.action, "human_portal_task.create");
  assert.deepEqual([portalOut.payload.approved_by_officer_id, portalOut.payload.approver_entity, portalOut.payload.approved_at, portalOut.payload.manifest_sha256], ["u-partner-officer", "partner", "2026-11-10", out.manifest.sha256]);
  // A package under Supermortgage's own number is approved by its own officer; a task that then claims the partner's number for it is refused — the entity comes from the approval on record.
  const ownPkg = await run("documents.compile_pdf", QC, { exam_id: "EX-2026-07", request_no: "R-003", file, due_at: "2026-11-15", assembled_on: "2026-11-06", calendar: "fannie_et", privilege_screen: screen.output, documents: docs, compiled_document_ids: ["doc-note-1"], servicer_number_owner: "supermortgage" });
  const ownManifest = (ownPkg.output as { manifest: { sha256: string } }).manifest.sha256;
  await run("documents.compile_pdf", SM_OFFICER, { ...approve, request_no: "R-003", approver_entity: "supermortgage", servicer_number_owner: "supermortgage", manifest_sha256: ownManifest });
  await refused("human_portal_task.create", QC, { ...task, request_no: "R-003", manifest_sha256: ownManifest, servicer_number_owner: "partner" }, "PARTNER_OFFICER_SIGNS");
  assert.equal(((await run("human_portal_task.create", QC, { ...task, request_no: "R-003", manifest_sha256: ownManifest, servicer_number_owner: "supermortgage" })).output as { payload: { approver_entity: string } }).payload.approver_entity, "supermortgage");
  // escalations.create / cases.create{qc_finding}: the process's escalation roles; only `qc_finding` cases.
  assert.equal(((await run("escalations.create", QC, { kind: "attorney", reason: "privilege review of the production" })).output as { ownerRole: string }).ownerRole, "attorney");
  await refused("escalations.create", QC, { kind: "lossmit_reviewer" }, "ESCALATION_ROLE");
  const findingInput = { exam_id: "EX-2026-07", finding_ref: "F-3", text: "Servicer did not maintain the D2-2-02 outreach cadence on loan L-100.", severity: "medium", cited_requirement: "D2-2-02", alleged_violation: true, received_on: "2026-11-20", examiner: EXAMINER, loan_ids: ["L-100"], taxonomy_nodes: ["fnma.d2202.outreach"], capa_due: "2027-06-01" };
  const c = await run("cases.create{qc_finding}", QC, findingInput);
  const co = c.output as { kind: string; case_id: string; root_cause_required: boolean; capa_due: string; finding_event_id: string };
  assert.equal(co.kind, "qc_finding"); assert.equal(co.case_id, "QCF-EX-2026-07-F-3"); assert.equal(rt.store.get("cases", "QCF-EX-2026-07-F-3")!.data.root_cause_required, true); assert.equal(events.all().filter((e) => e.type === "case.opened").length, 1);
  assert.equal(co.capa_due, "2026-12-14", "CAPA due is receipt + 15 BD, never the caller's date");
  // The finding is ingested as `exam.finding.received` (ops-18-2 ingestExamFinding): the 15-BD plan row and the stated-date response row arm on the bus's own engine; the same finding cannot be ingested twice; the exam_findings row mirrors the case.
  const fr = events.ofType("exam.finding.received"); assert.equal(fr.length, 1); assert.equal(fr[0]!.id, co.finding_event_id); assert.deepEqual([fr[0]!.payload.received_at, fr[0]!.payload.response_due_stated, fr[0]!.payload.qc_finding_case_id], ["2026-11-20", "2026-12-20", "QCF-EX-2026-07-F-3"]);
  assert.equal(uow.timers.byCode("SM_EXAM_REMEDIATION_PLAN_15BD")[0]!.dueDate, D("2026-12-14")); const respRow = uow.timers.byCode("FNMA_SCR_FINDING_RESPONSE_AS_STATED")[0]!; assert.equal(respRow.dueDate, D("2026-12-20")); assert.equal(respRow.status, "armed");
  assert.equal(rt.store.get("exam_findings", "EX-2026-07/F-3")!.data.qc_finding_case_id, "QCF-EX-2026-07-F-3"); assert.equal(rt.store.get("exam_findings", "EX-2026-07/F-3")!.data.response_document_id, null);
  await assert.rejects(run("cases.create{qc_finding}", QC, findingInput), (e: unknown) => e instanceof RangeError && /already on record/.test(e.message));
  await refused("cases.create{qc_finding}", QC, { exam_id: "EX-2026-07", finding_ref: "F-4", kind: "bankruptcy" }, "QC_FINDING_ONLY");
  // With F-3 on record, the partner officer's release of the counsel-reviewed letter appends `exam.finding.responded{response_document_id}` — the stored signed letter — which satisfies FNMA_SCR_FINDING_RESPONSE_AS_STATED and lands on the exam_findings row.
  const responded = await run("letters.render", PARTNER_OFFICER, { ...letter, op: "release", signer_entity: "partner" });
  const ro = responded.output as { finding_on_record: boolean; response_document_id: string; event_id: string };
  assert.equal(ro.finding_on_record, true); const fd = events.ofType("exam.finding.responded"); assert.equal(fd.length, 1); assert.equal(fd[0]!.id, ro.event_id); assert.equal(fd[0]!.payload.response_document_id, ro.response_document_id); assert.equal(fd[0]!.actor.id, "u-partner-officer");
  assert.equal(respRow.status, "satisfied"); assert.equal(rt.store.get("exam_findings", "EX-2026-07/F-3")!.data.response_document_id, ro.response_document_id); assert.equal(rt.store.get("exam_findings", "EX-2026-07/F-3")!.data.status, "responded");
  // Every tool executes for its agent with an empty input, or refuses with a typed reason (no TypeErrors).
  for (const t of SPEC_TOOLS_18_2) { try { await run(t.name, QC, {}); } catch (e) { assert.ok(e instanceof RangeError || e instanceof CommandRefused, `${t.name}: ${(e as Error).message}`); } }
});
