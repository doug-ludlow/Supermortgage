/**
 * §1.7 operating rules over the pure clocks in lossmit-inflight.ts and the per-case emitters in inbound.ts — the code
 * paths behind the `lossmit-underwriter` tools in src/app/tools/section1-7.ts. Each function validates its input,
 * appends the event the §1.7 timer table keys on and returns what the tool records:
 *
 *   inflightBoardingFacts        the loss-mit facts `BoardingService.board` spreads onto `loan.boarded` — the fields the
 *                                (k) clocks arm on: `lossmit_ack_unexpired`/`lossmit_ack_sent` (REGX_1024_41K2_TRANSFEREE_ACK_10),
 *                                `lossmit_application_open`/`prior_1024_41_subject` (REGX_1024_41B2_ACK_5_DEEMED_T0),
 *                                `completeness_status` (REGX_1024_41K3_COMPLETE_APP_EVAL_30), `lossmit_offer_pending`/`acceptance_deadline`
 *                                (REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE), `lossmit_application_incomplete`/`reasonable_date`/
 *                                `transferor_reasonable_date` (REGX_1024_41K2_NO_FIRST_FILING_GATE), `appeal_window_unexpired`/
 *                                `transferor_denial_sent_on` (REGX_1024_41H_APPEAL_WINDOW_14), `forbearance_history`/`initial_start_date`
 *                                (FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M), `lossmit_status` (SM_SMDU_CASE_ACCESS_T0)
 *   openInheritedCase            `loan.boarded{lossmit_in_process=true}` → `lossmit.case.opened{origin=transferor}` (+ `lossmit.appeal.pending_at_transfer`
 *                                through inbound.ts appealReceived when the transferor's denial is under appeal — REGX_1024_41K4_APPEAL_DETERMINATION_30)
 *   seedDelinquencyCounters      `delinquency.counters.updated{seeded_at_boarding=true}` from the transferor's dates on `loan.boarded` — the
 *                                13.1/13.2 gates REGX_1024_41F1_120_DAY_GATE / REGX_1024_41G_DUAL_TRACK_GATE arm on it ("seeded from transferor dates")
 *   verifyBatchCarryover         per-case `lossmit.carryover.verified` / `.deficient` (inbound.ts) and, once every case of the batch is verified,
 *                                the batch-level `lossmit.carryover.verified{all_cases=true}` that closes SM_LOSSMIT_FILE_VERIFY_T0
 *   smduCaseAccessChecked        SMDU inbound case-status record under the partner's servicer number → `smdu.case.accessible` (SM_SMDU_CASE_ACCESS_T0)
 *                                | `smdu.case.inaccessible` + `human_portal_task` to the `fnma_portal_operator` (request package)
 *   closeAppealWindow            `lossmit.appeal_window.closed{outcome ∈ appeal_received, expired}` (REGX_1024_41H_APPEAL_WINDOW_14); an appeal received
 *                                within the window also arms the (k)(4) determination clock through inbound.ts appealReceived
 *   expireTransferorOffer        `lossmit.offer.closed{outcome=expired}` — refused before the original `acceptance_deadline` (REGX_1024_41K5: the
 *                                case may not be closed as expired before the unexpired balance runs out)
 *   foreclosureReferralGate      the `no_first_filing_41k2` gate fact for a `foreclosure.referral` command, derived from the reasonable date on
 *                                the transferor's (or Supermortgage's) incomplete-application acknowledgment (REGX_1024_41K2_NO_FIRST_FILING_GATE)
 *
 * Dates are PlainDate on the federal calendar where §1024.41 says "excluding legal public holidays, Saturdays, and Sundays";
 * money on an inherited offer is bigint cents carried as offered (comment 41(k)(5)-1: never re-underwritten).
 */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { deemedReceived, firstFilingGate } from "./lossmit-inflight.ts";
import { verifyCarryover, appealReceived, type TransferorLossmitFile, type CarryoverResult, type EscalationOpener } from "./inbound.ts";

export const LOSSMIT_UNDERWRITER: Actor = { kind: "agent", id: "lossmit-underwriter" };
const BATCH = (id: string) => ({ kind: "transfer_batch", id });
const CASE = (id: string) => ({ kind: "case", id });
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// ============================================================ boarding facts (the `loan.boarded` payload the (k) clocks read)
/** The transferor's loss-mit file as staged on the loan (Bulletin 2020-02 Appendix A §VII), plus the 1.7 data-model facts the file itself does not carry. */
export interface InheritedLossmitFile extends TransferorLossmitFile {
  /** `cases.subject_to_1024_41_at_transferor` — false when the transferor was exempt (small servicer): deemed received on the transfer date (comment 41(k)(1)(i)-1). Defaults to true. */
  readonly subject_to_1024_41_at_transferor?: boolean;
  /** `cases.borrower_response` on the transferor's offer, as of the transfer date. */
  readonly borrower_response?: "none" | "accepted" | "rejected";
  /** A trial period plan in progress at transfer (F-1-27; continue the transferor's schedule). Defaults to `!!trial`. */
  readonly trial_in_progress?: boolean;
}
/** `StagedLoan.lossmit` (domain/boarding/types.ts): the tape's flag and status plus the inherited file when the lossmit tape delivered one. */
export interface StagedLossmit { readonly in_process: boolean; readonly application_status?: string | null; readonly received_on?: PlainDate | null; readonly inherited_file?: InheritedLossmitFile | null; }
export type CompletenessStatus = "incomplete" | "facially_complete" | "complete";
export interface InflightBoardingFacts {
  readonly lossmit_in_process: boolean;
  /** SM_SMDU_CASE_ACCESS_T0: `loan.boarded{lossmit_status ∈ lossmit_in_process, trial_in_progress}`. */
  readonly lossmit_status: "lossmit_in_process" | "trial_in_progress" | null;
  readonly lossmit_case_origin: "transferor" | null;
  /** An application the transferor received that is not fully resolved (comment 41(k)(1)(i)-1: a denial whose appeal period expired is not pending). */
  readonly lossmit_application_open: boolean;
  /** REGX_1024_41B2_ACK_5_DEEMED_T0 arms on `prior_1024_41_subject=false`: the transferee is considered to have received the application on the transfer date. */
  readonly prior_1024_41_subject: boolean | null;
  readonly transferor_received_at: PlainDate | null;
  readonly deemed_received_at: PlainDate | null;
  /** REGX_1024_41K2_TRANSFEREE_ACK_10: the transferor's 5-business-day (b)(2)(i)(B) period had not expired as of the transfer date … */
  readonly lossmit_ack_unexpired: boolean;
  /** … and the transferor had not provided the notice (§1024.41(k)(2)(i)). */
  readonly lossmit_ack_sent: boolean;
  readonly transferor_ack_sent_on: PlainDate | null;
  /** REGX_1024_41K3_COMPLETE_APP_EVAL_30 arms on `completeness_status=complete` (§1024.41(k)(3): 30 days from the transfer date). */
  readonly completeness_status: CompletenessStatus | null;
  readonly complete_at: PlainDate | null;
  /** REGX_1024_41K2_NO_FIRST_FILING_GATE arms on `lossmit_application_incomplete=true, reasonable_date is not null`; anchor `transferor_reasonable_date`. */
  readonly lossmit_application_incomplete: boolean;
  readonly reasonable_date: PlainDate | null;
  readonly transferor_reasonable_date: PlainDate | null;
  /** REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE arms on `lossmit_offer_pending=true`; anchor the original `acceptance_deadline` (§1024.41(k)(5)). */
  readonly lossmit_offer_pending: boolean;
  readonly acceptance_deadline: PlainDate | null;
  /** REGX_1024_41H_APPEAL_WINDOW_14 arms on `appeal_window_unexpired=true`; anchor `transferor_denial_sent_on` (+14 calendar days, §1024.41(h)(2)). */
  readonly appeal_window_unexpired: boolean;
  readonly transferor_denial_sent_on: PlainDate | null;
  readonly appeal_window_end: PlainDate | null;
  readonly appeal_pending_at_transfer: boolean;
  readonly appeal_received_at: PlainDate | null;
  /** FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M arms on a present `forbearance_history`; anchor `initial_start_date` (12-month cumulative cap). */
  readonly forbearance_history: { readonly initial_start_date: PlainDate; readonly cumulative_months: number | null; readonly increments: readonly { start: PlainDate; months: number }[] } | null;
  readonly initial_start_date: PlainDate | null;
  readonly smdu_case_id: string | null;
}
const NOT_IN_PROCESS: InflightBoardingFacts = { lossmit_in_process: false, lossmit_status: null, lossmit_case_origin: null, lossmit_application_open: false, prior_1024_41_subject: null, transferor_received_at: null, deemed_received_at: null, lossmit_ack_unexpired: false, lossmit_ack_sent: false, transferor_ack_sent_on: null, completeness_status: null, complete_at: null, lossmit_application_incomplete: false, reasonable_date: null, transferor_reasonable_date: null, lossmit_offer_pending: false, acceptance_deadline: null, appeal_window_unexpired: false, transferor_denial_sent_on: null, appeal_window_end: null, appeal_pending_at_transfer: false, appeal_received_at: null, forbearance_history: null, initial_start_date: null, smdu_case_id: null };
const asCompleteness = (s: string | null | undefined): CompletenessStatus | null => (s === "incomplete" || s === "facially_complete" || s === "complete" ? s : null);
/**
 * The 1.7 facts of a loan at boarding, from the tape's `lossmit` block and the inherited file. `BoardingService.board`
 * spreads the result onto `loan.boarded`, so the (k) clocks arm from the real boarding path (1.7 timer table triggers).
 * A loan with no loss mitigation in process carries the flag and null facts only.
 */
export function inflightBoardingFacts(lossmit: StagedLossmit, transferDate: PlainDate): InflightBoardingFacts {
  if (!lossmit.in_process) return NOT_IN_PROCESS;
  const file: InheritedLossmitFile = lossmit.inherited_file ?? {};
  const received = file.application_received_on ?? lossmit.received_on ?? null;
  const subject = file.subject_to_1024_41_at_transferor ?? true;
  const det = file.determination ?? null;
  const denial = det?.kind === "denial" ? det : null;
  const appealWindowEnd = denial ? (denial.appeal_window_end ?? addDays(denial.sent_on, 14)) : null;
  const appealOnFile = file.appeal_pending === true || !!file.appeal;
  // comment 41(k)(1)(i)-1: a denial whose appeal period expired before transfer with no appeal is fully resolved — not pending.
  const notPending = denial !== null && !appealOnFile && appealWindowEnd! < transferDate;
  const applicationOpen = det === null && !notPending && file.application_present !== false;
  const completeness = asCompleteness(file.completeness ?? lossmit.application_status ?? null);
  const ackSent = !!file.ack_sent_on;
  // §1024.41(k)(2)(i): the (b)(2)(i)(B) period (5 business days from the transferor's receipt) had not expired as of the transfer date.
  const ackUnexpired = applicationOpen && subject && received !== null && addBusinessDays(received, 5, federal) >= transferDate;
  const offer = file.offer ?? null;
  const offerPending = offer !== null && (file.borrower_response ?? "none") === "none" && offer.acceptance_deadline >= transferDate;
  const fb = file.forbearance_history ?? null;
  const trial = file.trial_in_progress ?? !!file.trial;
  return {
    lossmit_in_process: true, lossmit_status: trial ? "trial_in_progress" : "lossmit_in_process", lossmit_case_origin: "transferor",
    lossmit_application_open: applicationOpen, prior_1024_41_subject: subject, transferor_received_at: received,
    deemed_received_at: applicationOpen || appealOnFile ? deemedReceived(received ?? transferDate, subject, transferDate) : null,
    lossmit_ack_unexpired: ackUnexpired, lossmit_ack_sent: ackSent, transferor_ack_sent_on: file.ack_sent_on ?? null,
    completeness_status: applicationOpen ? completeness : null, complete_at: applicationOpen && completeness === "complete" ? (received ?? transferDate) : null,
    lossmit_application_incomplete: applicationOpen && completeness !== "complete", reasonable_date: file.reasonable_date ?? null, transferor_reasonable_date: file.reasonable_date ?? null,
    lossmit_offer_pending: offerPending, acceptance_deadline: offer?.acceptance_deadline ?? null,
    appeal_window_unexpired: denial !== null && !appealOnFile && appealWindowEnd! >= transferDate, transferor_denial_sent_on: denial?.sent_on ?? null, appeal_window_end: appealWindowEnd,
    appeal_pending_at_transfer: denial !== null && appealOnFile, appeal_received_at: file.appeal?.received_on ?? null,
    forbearance_history: fb ? { initial_start_date: fb.initial_start_date, cumulative_months: fb.cumulative_months, increments: [...fb.increments] } : null, initial_start_date: fb?.initial_start_date ?? null,
    smdu_case_id: file.smdu_case_id ?? null,
  };
}

// ============================================================ case creation at boarding
/** `loan.boarded{lossmit_in_process=true}` → `lossmit.case.opened{origin=transferor}`; an appeal unresolved at transfer arms REGX_1024_41K4_APPEAL_DETERMINATION_30 at once. */
export function openInheritedCase(events: EventStore, c: { case_id: string; loan_id: string; batch_id: string; transfer_date: PlainDate; lossmit: StagedLossmit }, actor: Actor = LOSSMIT_UNDERWRITER): { case_id: string; status: "inherited_pending" | "not_pending"; facts: InflightBoardingFacts; event: DomainEvent; appeal: ReturnType<typeof appealReceived> | null } {
  if (!c.case_id || !c.loan_id) throw new RangeError("openInheritedCase needs case_id and loan_id");
  const facts = inflightBoardingFacts(c.lossmit, c.transfer_date);
  if (!facts.lossmit_in_process) throw new RangeError(`loan ${c.loan_id} has no loss mitigation in process; no inherited case to open`);
  const pending = facts.lossmit_application_open || facts.appeal_pending_at_transfer || facts.appeal_window_unexpired || facts.lossmit_offer_pending || facts.lossmit_status === "trial_in_progress";
  const status = pending ? "inherited_pending" : "not_pending";
  const event = events.append({ type: "lossmit.case.opened", loanId: c.loan_id, aggregate: CASE(c.case_id), actor, payload: { case_id: c.case_id, case_type: "lossmit", origin: "transferor", batch_id: c.batch_id, transfer_date: c.transfer_date, status, ...facts } });
  const appeal = facts.appeal_pending_at_transfer && facts.appeal_received_at
    ? appealReceived(events, { case_id: c.case_id, loan_id: c.loan_id, transfer_date: c.transfer_date, appeal_received_on: facts.appeal_received_at, received_by: "transferor", pending_at_transfer: true }, actor)
    : null;
  return { case_id: c.case_id, status, facts, event, appeal };
}

// ============================================================ 13.1/13.2 gates seeded from transferor dates
/**
 * 1.7 timer table: REGX_1024_41F1_120_DAY_GATE / REGX_1024_41G_DUAL_TRACK_GATE on `loan.boarded` — "seeded from transferor dates".
 * The 13.1 gate arms on `delinquency.counters.updated`; at boarding that event is emitted from the boarded loan's transferor-derived
 * §1024.31 counter so the pre-foreclosure review period keeps its original anchor (`earliest_unpaid_due`), never the transfer date.
 * Returns null for a current loan (no delinquency to seed).
 */
export function seedDelinquencyCounters(events: EventStore, boarded: DomainEvent, actor: Actor = LOSSMIT_UNDERWRITER): DomainEvent | null {
  const p = boarded.payload as Record<string, unknown>;
  if (boarded.type !== "loan.boarded" || !boarded.loanId) throw new RangeError("seedDelinquencyCounters takes the loan's `loan.boarded` event");
  const days = p.regx_days_delinquent;
  if (typeof days !== "number" || !Number.isFinite(days)) throw new RangeError(`loan.boarded for ${boarded.loanId} carries no regx_days_delinquent`);
  if (days <= 0) return null;
  const eu = isDate(p.earliest_unpaid_due_date) ? p.earliest_unpaid_due_date : null;
  const asOf = isDate(p.transfer_date) ? p.transfer_date : null;
  if (!eu || !asOf) throw new RangeError(`loan.boarded for ${boarded.loanId} carries no earliest_unpaid_due_date/transfer_date to seed the 13.1 gate from`);
  // Same payload contract as the 13.1 daily sweep (ops-13-1.ts): `entered_delinquency` on the run that first finds days > 0 — at boarding
  // that is this seed — and `earliest_unpaid_due_date` as the gate's anchor (timers-13-1.ts), carried over from the transferor's history.
  const pr = p.principal_residence === undefined ? true : p.principal_residence !== false;
  return events.append({ type: "delinquency.counters.updated", loanId: boarded.loanId, actor, causationId: boarded.id, payload: {
    loan_id: p.loan_id ?? boarded.loanId, on: asOf, as_of: asOf, regx_days_delinquent: days, earliest_unpaid_due: eu, earliest_unpaid_due_date: eu, fnma_delinquency_status: p.fnma_delinquency_status ?? null,
    principal_residence: pr, non_principal_residence: !pr, entered_delinquency: true, seeded_at_boarding: true, source: "transferor", transfer_date: asOf } });
}

// ============================================================ SM_LOSSMIT_FILE_VERIFY_T0 (batch roll-up of the per-case checks)
export interface BatchCarryoverCase { readonly case_id: string; readonly loan_id: string; readonly file: TransferorLossmitFile | null; }
/**
 * Every inherited case of the batch runs its CO-01…CO-10 checks (per-case `lossmit.carryover.verified` / `.deficient`, inbound.ts).
 * SM_LOSSMIT_FILE_VERIFY_T0 is armed on the batch-scoped `transfer.tape.received{kind=lossmit}` ("per case" in the satisfied column
 * means every case of the tape), so once no case is deficient the batch-level `lossmit.carryover.verified{all_cases=true}` closes it.
 */
export function verifyBatchCarryover(events: EventStore, batch: { batch_id: string; transfer_date: PlainDate }, cases: readonly BatchCarryoverCase[], boardedOn: PlainDate = batch.transfer_date, actor: Actor = LOSSMIT_UNDERWRITER): { batch_id: string; verified: boolean; results: (CarryoverResult & { case_id: string; loan_id: string })[]; deficient: string[]; event: DomainEvent | null } {
  if (!batch.batch_id) throw new RangeError("verifyBatchCarryover needs batch_id");
  if (cases.length === 0) throw new RangeError(`verifyBatchCarryover: no inherited cases on ${batch.batch_id} — nothing to verify`);
  const results = cases.map((c) => { const r = verifyCarryover(events, { case_id: c.case_id, loan_id: c.loan_id }, c.file, boardedOn, actor); const { event: _e, ...rest } = r; void _e; return { case_id: c.case_id, loan_id: c.loan_id, ...rest }; });
  const deficient = results.filter((r) => r.status === "file_deficient").map((r) => r.case_id);
  const event = deficient.length ? null : events.append({ type: "lossmit.carryover.verified", aggregate: BATCH(batch.batch_id), actor, payload: { batch_id: batch.batch_id, all_cases: true, case_ids: results.map((r) => r.case_id), verified_on: boardedOn, transfer_date: batch.transfer_date } });
  return { batch_id: batch.batch_id, verified: event !== null, results, deficient, event };
}

// ============================================================ SM_SMDU_CASE_ACCESS_T0
/** The SMDU case-status record read under the partner's servicer number (B2B name/value pairs or the UI via SSO). */
export interface SmduCaseRecord { readonly case_id: string; readonly servicer_number: string; readonly status: string; readonly fnma_loan_number?: string | null; }
/**
 * `smdu.case.accessible` when the inherited case answers under the partner's servicer number (Supermortgage performs under it);
 * otherwise `smdu.case.inaccessible` and a `human_portal_task` to the `fnma_portal_operator` with the servicing-representative request
 * package (loan list, SMDU case IDs, transfer date, D-Code) — the spec's [UNVERIFIED mechanics] default (open question 1).
 */
export function smduCaseAccessChecked(events: EventStore, esc: EscalationOpener | null, c: { case_id: string; loan_id: string; smdu_case_id: string; partner_servicer_number: string; transfer_date: PlainDate; record: SmduCaseRecord | null; fnma_loan_number?: string | null }, checkedOn: PlainDate, actor: Actor = LOSSMIT_UNDERWRITER): { accessible: boolean; reason: string | null; event: DomainEvent; portal_task_id: string | null } {
  if (!c.case_id || !c.loan_id || !c.smdu_case_id || !c.partner_servicer_number) throw new RangeError("smduCaseAccessChecked needs case_id, loan_id, smdu_case_id and partner_servicer_number");
  const r = c.record;
  const reason = r === null ? `SMDU case ${c.smdu_case_id} not readable under servicer number ${c.partner_servicer_number}`
    : r.case_id !== c.smdu_case_id ? `SMDU returned case ${r.case_id}, not the inherited case ${c.smdu_case_id}`
    : r.servicer_number !== c.partner_servicer_number ? `SMDU case ${c.smdu_case_id} sits under servicer number ${r.servicer_number}, not the partner's ${c.partner_servicer_number}`
    : r.status === "closed" || r.status === "declined" ? `SMDU case ${c.smdu_case_id} is ${r.status}; no open workout to continue` : null;
  if (reason === null) {
    const event = events.append({ type: "smdu.case.accessible", loanId: c.loan_id, aggregate: CASE(c.case_id), actor, payload: { case_id: c.case_id, smdu_case_id: c.smdu_case_id, servicer_number: c.partner_servicer_number, status: r!.status, checked_on: checkedOn, transfer_date: c.transfer_date } });
    return { accessible: true, reason: null, event, portal_task_id: null };
  }
  const event = events.append({ type: "smdu.case.inaccessible", loanId: c.loan_id, aggregate: CASE(c.case_id), actor, payload: { case_id: c.case_id, smdu_case_id: c.smdu_case_id, servicer_number: c.partner_servicer_number, reason, checked_on: checkedOn, transfer_date: c.transfer_date } });
  const task = esc?.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", loanId: c.loan_id, caseId: c.case_id, severity: "sev-1", payload: { task: "smdu_case_continuity_request", request_package: { loans: [{ loan_id: c.loan_id, fnma_loan_number: c.fnma_loan_number ?? null, smdu_case_id: c.smdu_case_id }], transfer_date: c.transfer_date, servicer_number: c.partner_servicer_number, d_code: "D" }, reason } }, actor) ?? null;
  return { accessible: false, reason, event, portal_task_id: task?.id ?? null };
}

// ============================================================ REGX_1024_41H_APPEAL_WINDOW_14 (the borrower's window on a transferor denial)
export type AppealWindowOutcome = { kind: "appeal_received"; received_on: PlainDate; received_by: "transferor" | "transferee" } | { kind: "expired"; today: PlainDate };
/**
 * The 14-day appeal window on the transferor's denial is the borrower's: an appeal received by either servicer on or before its end
 * closes it as `appeal_received` (and the (k)(4) determination clock starts through inbound.ts appealReceived, anchored on the later of
 * the transfer date and the appeal date); the sweep may close it as `expired` only after the window end (no breach; case not closed before expiry).
 */
export function closeAppealWindow(events: EventStore, c: { case_id: string; loan_id: string; transfer_date: PlainDate; appeal_window_end: PlainDate }, outcome: AppealWindowOutcome, actor: Actor = LOSSMIT_UNDERWRITER): { outcome: "appeal_received" | "expired"; event: DomainEvent; appeal: ReturnType<typeof appealReceived> | null } {
  if (!c.case_id || !c.loan_id) throw new RangeError("closeAppealWindow needs case_id and loan_id");
  if (outcome.kind === "expired") {
    if (outcome.today <= c.appeal_window_end) throw new RangeError(`appeal window on case ${c.case_id} runs through ${c.appeal_window_end}; it cannot be closed as expired on ${outcome.today} (§1024.41(k)(5)/(h): the borrower keeps the unexpired balance)`);
    const event = events.append({ type: "lossmit.appeal_window.closed", loanId: c.loan_id, aggregate: CASE(c.case_id), actor, payload: { case_id: c.case_id, outcome: "expired", appeal_window_end: c.appeal_window_end, closed_on: outcome.today } });
    return { outcome: "expired", event, appeal: null };
  }
  // comment 41(k)(4)-1: an appeal the borrower gave the transferor after transfer is timely by its transferor receipt date — never untimely because of the transfer.
  if (outcome.received_on > c.appeal_window_end) throw new RangeError(`appeal received ${outcome.received_on} is after the window end ${c.appeal_window_end} on case ${c.case_id}; it is untimely under §1024.41(h)(2), not a window closure`);
  const event = events.append({ type: "lossmit.appeal_window.closed", loanId: c.loan_id, aggregate: CASE(c.case_id), actor, payload: { case_id: c.case_id, outcome: "appeal_received", appeal_window_end: c.appeal_window_end, closed_on: outcome.received_on, received_by: outcome.received_by } });
  const appeal = appealReceived(events, { case_id: c.case_id, loan_id: c.loan_id, transfer_date: c.transfer_date, appeal_received_on: outcome.received_on, received_by: outcome.received_by }, actor);
  return { outcome: "appeal_received", event, appeal };
}

// ============================================================ REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE (expiry leg)
/** The transferor's offer expires unaccepted only after its original `acceptance_deadline`: `lossmit.offer.closed{outcome=expired}`; earlier closure is refused (§1024.41(k)(5)). */
export function expireTransferorOffer(events: EventStore, c: { case_id: string; loan_id: string; option: string; acceptance_deadline: PlainDate }, today: PlainDate, actor: Actor = LOSSMIT_UNDERWRITER): { outcome: "expired"; event: DomainEvent } {
  if (!c.case_id || !c.loan_id) throw new RangeError("expireTransferorOffer needs case_id and loan_id");
  if (today <= c.acceptance_deadline) throw new RangeError(`offer on case ${c.case_id} may be accepted through ${c.acceptance_deadline}; it cannot be closed as expired on ${today} (§1024.41(k)(5): the borrower keeps the unexpired balance of the acceptance period)`);
  const event = events.append({ type: "lossmit.offer.closed", loanId: c.loan_id, aggregate: CASE(c.case_id), actor, payload: { case_id: c.case_id, outcome: "expired", status: "expired", option: c.option, acceptance_deadline: c.acceptance_deadline, closed_on: today, re_underwritten: false } });
  return { outcome: "expired", event };
}

// ============================================================ REGX_1024_41K2_NO_FIRST_FILING_GATE on `foreclosure.referral`
/**
 * The `no_first_filing_41k2` gate fact a `foreclosure.referral` / first-filing command must carry (foreclosure/referral.ts Gates):
 * derived from the reasonable date on the incomplete-application acknowledgment — the transferor's (`loan.boarded` /
 * `lossmit.case.opened` `transferor_reasonable_date`) or Supermortgage's own (`notice.sent{template=NTC_REGX_41B2_ACK_INCOMPLETE}`
 * carrying `reasonable_date`) — never a caller-supplied boolean. §1024.41(k)(2)(ii)(A): no first notice or filing until a date after it.
 */
export function foreclosureReferralGate(events: EventStore, loanId: string, today: PlainDate): { no_first_filing_41k2: boolean; gate: "REGX_1024_41K2_NO_FIRST_FILING_GATE"; reasonable_date: PlainDate | null; allowed_from: PlainDate | null; source: "transferor" | "supermortgage" | null } {
  if (!loanId) throw new RangeError("foreclosureReferralGate needs the loan id");
  let reasonable: PlainDate | null = null, source: "transferor" | "supermortgage" | null = null;
  for (const e of events.all()) {
    if (e.loanId !== loanId) continue;
    const p = e.payload as Record<string, unknown>;
    if ((e.type === "loan.boarded" || e.type === "lossmit.case.opened") && isDate(p.transferor_reasonable_date)) { reasonable = p.transferor_reasonable_date; source = "transferor"; }
    else if (e.type === "notice.sent" && p.template === "NTC_REGX_41B2_ACK_INCOMPLETE" && isDate(p.reasonable_date)) { reasonable = p.reasonable_date; source = "supermortgage"; }
  }
  const g = firstFilingGate(reasonable, today);
  return { no_first_filing_41k2: g.ok, gate: g.gate, reasonable_date: reasonable, allowed_from: g.allowed_from, source };
}
