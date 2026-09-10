/**
 * §3.1 operating rules over the pure calculators in ./ops.ts — the event-appending code paths behind the 3.1
 * `readBoardingFile` tool (src/app/tools/section03.ts). Each function validates its input, appends the `loan_events`
 * fact the 3.1 timer table keys on and returns what the tool records:
 *
 *   verifyInitialStatementEvidence  escrow.initial_statement.evidence_verified (originator evidence dated ≤ settlement + 45 days,
 *                                   or a transfer-in that keeps the transferor's payment and method — §1024.17(e)(1)(ii)), else
 *                                   escrow.initial_statement.required{reason=settlement} — the REGX_1024_17G_INITIAL_STMT_45 trigger
 *                                   (anchored on `settlement_date`); either fact closes ESC_BOARDING_EVIDENCE_CHECK_5BD.
 *   transferInInitialStatement      escrow.initial_statement.required{reason=transfer_in} after §1.6's `escrow.terms.changed_at_transfer`
 *                                   (the platform's spelling of "`transfer.in.completed` with payment/method change", the
 *                                   REGX_1024_17E_TRANSFER_INITIAL_STMT_60 trigger anchored on its `transfer_date`).
 *   readBoardingFile                the tool's entry: routes a boarded loan to the transfer-in path when the §1.6 continuity
 *                                   decision is on the loan's event log, else to the origination evidence check.
 *
 * Money is bigint cents; dates are PlainDate; the statement itself is a Notice Registry output (sendNotice →
 * recordStatementSent's `escrow.statement.sent{statement_type=initial}`, which satisfies both deadline rows).
 */
import { type PlainDate, plainDate } from "../../kernel/calendar/date.ts";
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { initialStatementStatus, establishmentStatement, type InitialStatementStatus } from "./ops.ts";

export const RULE_SET_3_1 = "regx.escrow.2013" as const;   // 3.1 decision record: rule_set='regx.escrow.2013'

/** Boarding-file evidence of an origination-delivered initial statement: the document and its delivery date (3.1 rule 1). */
export interface OriginatorEvidence { readonly document_id: string; readonly delivered_on: PlainDate; }
export interface BoardingEvidenceInput { readonly loan_id: string; readonly settlement_date: PlainDate; readonly boarded_on: PlainDate; readonly evidence?: OriginatorEvidence | null; }
export interface EvidenceCheckResult {
  readonly kind: "settlement";
  readonly status: InitialStatementStatus;
  readonly timer: { code: "REGX_1024_17G_INITIAL_STMT_45"; due_on: PlainDate; breached_at_boarding: boolean; waiver_reason?: "inherited_from_originator" } | null;
  readonly send_by: PlainDate | null;
  readonly qc_finding: "originator_failed_g1" | null;
  readonly event: DomainEvent;
}

const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * 3.1 inputs: `loan.boarded` with an active escrow account → verify evidence of an origination-delivered initial statement.
 * Evidence found (document + delivery date ≤ settlement_date + 45 days, rule 1) → `escrow.initial_statement.evidence_verified`
 * and the state machine ends at `satisfied_by_originator` (no 45-day instance is armed). Otherwise
 * `escrow.initial_statement.required{reason=settlement}` anchored on `settlement_date`; a window already lapsed at boarding
 * carries `breached_at_boarding=true` and `waiver_reason='inherited_from_originator'` (the timer the fact arms is due in the
 * past and breaches on the next evaluation) and names the `qc_finding` case the tool opens against the originator.
 */
export function verifyInitialStatementEvidence(events: EventStore, i: BoardingEvidenceInput, actor: Actor): EvidenceCheckResult {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  if (!isDate(i.settlement_date) || !isDate(i.boarded_on)) throw new RangeError("settlement_date and boarded_on are required (boarding file spec, Section 1.1)");
  if (i.boarded_on < i.settlement_date) throw new RangeError(`boarded_on ${i.boarded_on} precedes settlement_date ${i.settlement_date}`);
  if (i.evidence && (!i.evidence.document_id || !isDate(i.evidence.delivered_on))) throw new RangeError("originator statement evidence needs the document and its delivery date (3.1 rule 1)");
  const r = initialStatementStatus({ settlement_date: i.settlement_date, boarded_on: i.boarded_on, originator_statement_delivered_on: i.evidence?.delivered_on ?? null });
  const base = { settlement_date: i.settlement_date, boarded_on: i.boarded_on, rule_ref: "§1024.17(g)(1)", rule_set: RULE_SET_3_1 };
  if (r.status === "satisfied_by_originator") {
    const event = events.append({ type: "escrow.initial_statement.evidence_verified", loanId: i.loan_id, actor, payload: { ...base, basis: "originator_delivered", evidence_document_id: i.evidence!.document_id, delivered_on: i.evidence!.delivered_on, status: r.status } });
    return { kind: "settlement", status: r.status, timer: null, send_by: null, qc_finding: null, event };
  }
  const event = events.append({ type: "escrow.initial_statement.required", loanId: i.loan_id, actor, payload: { ...base, reason: "settlement", status: r.status, due_on: r.timer!.due_on, send_by: r.send_by, breached_at_boarding: r.timer!.breached_at_boarding, ...(r.timer!.waiver_reason ? { waiver_reason: r.timer!.waiver_reason } : {}), qc_finding: r.qc_finding, evidence_document_id: i.evidence?.document_id ?? null, evidence_delivered_on: i.evidence?.delivered_on ?? null, timer: r.timer!.code } });
  return { kind: "settlement", status: r.status, timer: r.timer, send_by: r.send_by, qc_finding: r.qc_finding, event };
}

/** The §1.6 continuity decision for a transfer-in loan, read from the loan's own event log (never from the caller). */
export interface TransferInFacts { readonly transfer_date: PlainDate; readonly payment_changed: boolean; readonly accounting_method_changed: boolean; readonly decision: "retained" | "short_year" | "new_year"; readonly source_event_id: string; }
export function transferInFacts(events: EventStore, loanId: string): TransferInFacts | null {
  const decided = events.ofType("escrow.computation_year.decided").filter((e) => e.loanId === loanId);
  const e = decided[decided.length - 1]; if (!e) return null;
  const p = e.payload as Record<string, unknown>;
  if (!isDate(p.transfer_date)) throw new RangeError(`escrow.computation_year.decided ${e.id} carries no transfer_date`);
  const decision = p.decision === "retained" || p.decision === "short_year" || p.decision === "new_year" ? p.decision : null;
  if (!decision) throw new RangeError(`escrow.computation_year.decided ${e.id} carries an unknown decision ${String(p.decision)}`);
  return { transfer_date: plainDate(p.transfer_date), payment_changed: p.payment_changed === true, accounting_method_changed: p.method_changed === true, decision, source_event_id: e.id };
}

export interface TransferInInput { readonly loan_id: string; readonly transfer_date: PlainDate; readonly payment_changed: boolean; readonly accounting_method_changed: boolean; readonly source_event_id?: string; }
export interface TransferInResult { readonly kind: "transfer_in"; readonly status: "required"; readonly timer: { code: "REGX_1024_17E_TRANSFER_INITIAL_STMT_60"; due_on: PlainDate }; readonly computation_year_start: PlainDate; readonly qc_finding: null; readonly event: DomainEvent; }
/**
 * 3.1 inputs: `transfer.in.completed` with `payment_changed=true` or `accounting_method_changed=true` → reason='transfer_in',
 * the 60-day statement (§1024.17(e)(1)) and a computation year that starts on the transfer effective date ((e)(1)(i)).
 * Unchanged payment and method is not an initial-statement case ((e)(1)(ii): continue or reset via 3.3) — refused.
 */
export function transferInInitialStatement(events: EventStore, i: TransferInInput, actor: Actor): TransferInResult {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  if (!isDate(i.transfer_date)) throw new RangeError("transfer_date (transfer effective date) is required");
  if (!i.payment_changed && !i.accounting_method_changed) throw new RangeError("no initial statement on a transfer-in that keeps the transferor's payment and accounting method (§1024.17(e)(1)(ii))");
  const r = establishmentStatement("transfer_in_changed", i.transfer_date, 1n);   // a method-only change is the same (e)(1) duty as a payment change
  if (!r.timer) throw new RangeError("unreachable: a changed transfer-in always carries the 60-day statement");
  const due_on = r.due_on;
  const event = events.append({ type: "escrow.initial_statement.required", loanId: i.loan_id, actor, ...(i.source_event_id ? { causationId: i.source_event_id } : {}), payload: {
    reason: "transfer_in", status: "required", transfer_date: i.transfer_date, due_on, computation_year_start: i.transfer_date, payment_changed: i.payment_changed, accounting_method_changed: i.accounting_method_changed,
    timer: "REGX_1024_17E_TRANSFER_INITIAL_STMT_60", rule_ref: "§1024.17(e)(1)", rule_set: RULE_SET_3_1 } });
  return { kind: "transfer_in", status: "required", timer: { code: "REGX_1024_17E_TRANSFER_INITIAL_STMT_60", due_on }, computation_year_start: i.transfer_date, qc_finding: null, event };
}

export interface BoardingFileInput { readonly loan_id: string; readonly boarded_on: PlainDate; readonly settlement_date?: PlainDate | null; readonly evidence?: OriginatorEvidence | null; }
export type BoardingFileResult = EvidenceCheckResult | TransferInResult | { readonly kind: "transfer_in_retained"; readonly status: "satisfied_by_originator"; readonly timer: null; readonly qc_finding: null; readonly event: DomainEvent };
/**
 * The `readBoardingFile` tool: a boarded loan whose log carries the §1.6 continuity decision is a transfer-in — changed
 * payment/method → the 60-day statement; retained → the transferor's computation year continues and the boarding check is
 * closed with `escrow.initial_statement.evidence_verified{basis=transferor_computation_year_retained}` (3.1 edge case
 * "transfer-in mid-computation-year with unchanged payment and method: no initial statement"). Otherwise the origination
 * evidence check runs on the boarding file's `settlement_date` and `initial_escrow_statement_evidence`.
 */
export function readBoardingFile(events: EventStore, i: BoardingFileInput, actor: Actor): BoardingFileResult {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  if (!isDate(i.boarded_on)) throw new RangeError("boarded_on is required");
  const t = transferInFacts(events, i.loan_id);
  if (t && (t.payment_changed || t.accounting_method_changed)) return transferInInitialStatement(events, { loan_id: i.loan_id, transfer_date: t.transfer_date, payment_changed: t.payment_changed, accounting_method_changed: t.accounting_method_changed, source_event_id: t.source_event_id }, actor);
  if (t) {
    const event = events.append({ type: "escrow.initial_statement.evidence_verified", loanId: i.loan_id, actor, causationId: t.source_event_id, payload: { basis: "transferor_computation_year_retained", transfer_date: t.transfer_date, boarded_on: i.boarded_on, decision: t.decision, status: "satisfied_by_originator", rule_ref: "§1024.17(e)(1)(ii)", rule_set: RULE_SET_3_1 } });
    return { kind: "transfer_in_retained", status: "satisfied_by_originator", timer: null, qc_finding: null, event };
  }
  if (!isDate(i.settlement_date)) throw new RangeError("settlement_date is required for the origination evidence check (boarding file spec, Section 1.1)");
  return verifyInitialStatementEvidence(events, { loan_id: i.loan_id, settlement_date: i.settlement_date, boarded_on: i.boarded_on, evidence: i.evidence ?? null }, actor);
}
