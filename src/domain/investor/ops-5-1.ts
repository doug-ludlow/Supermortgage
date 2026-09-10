/**
 * §5.1 operating rules over the LAR calculators (./lar.ts, ./period.ts, ./batch.ts, ./ops.ts): every event a 5.1
 * registry row is armed by or satisfied with is appended to the event store here, by the code path the spec names —
 * canonical event creation (rules 1–2), the adapter acknowledgement (state machine: `submitted` is written by the
 * fnma-lsdu / fnma-servicing-events adapters), the parsed Fannie Mae feedback (rule 9: `accepted` / `rejected_*` only
 * from parsed responses), the triage decision record, the superseding acceptance and the period-close soft-reject
 * closure (`resolved`), the period scheduler (open with per-loan enrolment, the IRED sweep, the BD2 15:00 bulk cutoff,
 * the BD2 17:00 close, month end), the escrow attestation portal task, the SMDU deferral acceptance and the A1-4.2-01
 * compensatory-fee watch. timers-5-1.ts cites these emitters. Money is bigint cents; every clock is `fannie_et`.
 *
 * Kernel defect worked around in the tests (not fixable from §5): TimerEngine.onEvent re-arms a `recurring` row inside
 * its own satisfaction loop, so a satisfied FNMA_IRM_LAR_IRED_CD22_2000 or FNMA_A14201_COMPFEE_WATCH instance is re-armed
 * and re-satisfied by the same event without end (src/kernel/timers/engine.ts). Those two rows' satisfaction is proven
 * with `eventMatches` on the events this file emits; every deadline-kind row is proven through the engine.
 */
import { type PlainDate, endOfMonth, plainDate } from "../../kernel/calendar/date.ts";
import { wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import { SYSTEM, type Actor, type DomainEvent } from "../../kernel/events/types.ts";
import type { EventStore } from "../../kernel/events/store.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { LarFeedback, LarSubmission, ServicingEventsSubmission } from "../../infra/integrations/fnma.ts";
import { assignActivityPeriod, larDeadlineMs, eventDeadlineMs, periodAnchors, iredSweepRunMs, bulkCutoffMs, bd2CloseMs, fannieBusinessDay, nextMonth, periodEndOf, periodStart, deferralLarDeadlineOn, type PeriodAnchors } from "./period.ts";
import { validateLar80, idempotencyKey, type Lar96 } from "./lar.ts";
import { SequenceAllocator } from "./batch.ts";
import { EVENT_FAMILY, type InvestorEventType, type EventFamily, type ChannelMode, type LarPayload } from "./types.ts";
import { ET, noActivityProjection, iredSweep, periodCloseChecklist, exceptionDetectedEvent, workException, closeSoftRejectAtPeriodClose, type PeriodCloseFacts, type PeriodCloseChecklist, type RootCause, type LarDecisionRecord, type NoActivityProjection } from "./ops.ts";

const SERVICER = /^\d{9}$/, FNMA_LOAN = /^\d{10}$/, PERIOD = /^\d{4}-\d{2}$/;
const periodAggregate = (servicer: string, period: string): { kind: "period"; id: string } => ({ kind: "period", id: `${servicer}:${period}` });
const need = (cond: boolean, what: string): void => { if (!cond) throw new RangeError(what); };

// ───────────────────────────── rules 1–2: canonical event creation ─────────────────────────────
export interface CreateInvestorEventInput {
  readonly loan_id: string; readonly servicer_number: string; readonly fnma_loan_number: string; readonly event_type: InvestorEventType;
  readonly effective_date: PlainDate; readonly processed_at_ms: number; readonly payload: LarPayload; readonly mode: ChannelMode;
  /** Open activity periods for the servicer number (at most two, rule 2 / decision 6). */
  readonly open_periods: readonly string[];
  /** The §2/§10/§17 loan event this row is created from; a replay with the same source returns the existing row (rule 1). */
  readonly source_loan_event_id?: string;
  /** A correction: new sequence, same period, `supersedes_event_id` (rule 1). */
  readonly supersedes_event_id?: string | null;
  /** The contractual-payment LAR a payment deferral waits on (IRM 4-01; FNMA_IRM_DEFERRAL_LAR_BEFORE_EOM_1BD). */
  readonly deferral_pending?: boolean;
  readonly actor?: Actor;
}
export interface CreatedInvestorEvent {
  readonly event_id: string; readonly family: EventFamily; readonly activity_period: string; readonly per_loan_sequence: number; readonly idempotency_key: string;
  /** Legacy LAR clock (next `fannie_et` BD 20:00 ET; removal on BD1 → BD2 17:00 ET), the LL-2026-05 03:00 ET clock under `mode=event`; null for an escrow event that has no production rail yet (escrow has no LAR). */
  readonly due_at_ms: number | null; readonly replayed: boolean; readonly event: DomainEvent;
}
/** Rule 1: exactly one `investor_events` row per qualifying loan event, sequence allocated in processing order and never reused; rule 2 assigns the activity period. */
export function createInvestorEvent(store: EventStore, seq: SequenceAllocator, i: CreateInvestorEventInput): CreatedInvestorEvent {
  const family = EVENT_FAMILY[i.event_type]; need(family !== undefined, `unknown investor event type ${String(i.event_type)}`);
  need(SERVICER.test(i.servicer_number) && FNMA_LOAN.test(i.fnma_loan_number), "servicer_number (9 digits) and fnma_loan_number (10 digits) are required");
  need(i.open_periods.every((p) => PERIOD.test(p)) && i.open_periods.length <= 2, "open_periods: at most two YYYY-MM periods");
  if (i.source_loan_event_id) {
    const prior = store.byLoan(i.loan_id).find((e) => e.type === "investor_events.created" && e.payload.source_loan_event_id === i.source_loan_event_id && e.payload.event_type === i.event_type);
    if (prior) return { event_id: String(prior.payload.event_id), family, activity_period: String(prior.payload.activity_period), per_loan_sequence: Number(prior.payload.per_loan_sequence), idempotency_key: String(prior.payload.idempotency_key), due_at_ms: prior.payload.due_at ? Date.parse(String(prior.payload.due_at)) : null, replayed: true, event: prior };
  }
  const isRemoval = family === "removal";
  const activity_period = assignActivityPeriod(i.effective_date, i.processed_at_ms, isRemoval, i.open_periods);
  const per_loan_sequence = seq.allocate(i.loan_id);
  const key = idempotencyKey(i.servicer_number, i.fnma_loan_number, i.event_type, i.effective_date, per_loan_sequence, i.payload);
  const due = family === "escrow" ? (i.mode === "event" ? eventDeadlineMs(i.processed_at_ms) : null) : i.mode === "event" ? eventDeadlineMs(i.processed_at_ms) : larDeadlineMs(i.processed_at_ms, isRemoval);
  const event_id = `ie-${key.slice(0, 16)}`;
  const event = store.append({ type: "investor_events.created", loanId: i.loan_id, aggregate: { kind: "investor_event", id: event_id }, actor: i.actor ?? SYSTEM, occurredAt: toIso(i.processed_at_ms),
    ...(i.source_loan_event_id ? { causationId: i.source_loan_event_id } : {}),
    payload: { event_id, event_type: i.event_type, family, mode: i.mode, servicer_number: i.servicer_number, fnma_loan_number: i.fnma_loan_number, effective_date: i.effective_date, processed_at: toIso(i.processed_at_ms),
      activity_period, per_loan_sequence, idempotency_key: key, source_loan_event_id: i.source_loan_event_id ?? null, supersedes_event_id: i.supersedes_event_id ?? null, deferral_pending: i.deferral_pending ?? false, due_at: due === null ? null : toIso(due), status: "pending" } });
  return { event_id, family, activity_period, per_loan_sequence, idempotency_key: key, due_at_ms: due, replayed: false, event };
}

/** Feature flags `investor_reporting.<event_type>.mode` (data model): the channel mode of an event type on a date. */
export const CHANNEL_MODE_FLAGS: readonly { readonly prefix: string; readonly dual_from: PlainDate | null; readonly event_from: PlainDate | null; readonly basis: string }[] = [
  { prefix: "escrow.", dual_from: plainDate("2026-10-01"), event_from: plainDate("2026-12-01"), basis: "escrow.*: event from 2026-12-01 (dual from 2026-10-01 in CIT)" },
  { prefix: "delinquency.status", dual_from: plainDate("2027-02-01"), event_from: plainDate("2027-03-15"), basis: "delinquency.status: dual 2027-02-01, event 2027-03-15" },
  { prefix: "loan_data.change", dual_from: null, event_from: plainDate("2027-03-08"), basis: "loan_data.change: event 2027-03-08" },
  { prefix: "removal.liquidation.", dual_from: plainDate("2027-01-01"), event_from: null, basis: "removal.liquidation.*: dual Q1 2027 per Liquidation CIT plan" },
];
export function channelMode(eventType: InvestorEventType, on: PlainDate): ChannelMode {
  const f = CHANNEL_MODE_FLAGS.find((x) => eventType.startsWith(x.prefix));
  if (!f) return "legacy";                                                        // payment.*: legacy until Fannie Mae publishes dates (decision 3)
  if (f.event_from && on >= f.event_from) return "event";
  return f.dual_from && on >= f.dual_from ? "dual" : "legacy";
}

// ───────────────────────────── submission: the adapter acknowledgement → `submitted` ─────────────────────────────
export interface SubmittedRecord { readonly event_id: string; readonly loan_id: string; readonly fnma_loan_number: string; readonly event_type: InvestorEventType; readonly family: EventFamily; readonly sequence: number; }
export type LarChannel = "lsdu_b2b" | "lsdu_upload" | "lsdu_single" | "se_api" | "se_b2b" | "se_csv";
/** The transport's acknowledgement: one `investor_events.submitted{event_type, family}` per record — the fact the next-BD clocks are satisfied by. */
export function recordSubmissionAck(store: EventStore, i: { readonly submission_id: string; readonly channel: LarChannel; readonly format: "lar80" | "se_json_v1" | "csv"; readonly records: readonly SubmittedRecord[]; readonly acked_at_ms: number; readonly actor?: Actor }): { readonly ack: DomainEvent; readonly submitted: DomainEvent[] } {
  need(i.submission_id !== "" && i.records.length > 0, "an acknowledgement names a submission id and at least one record");
  const at = toIso(i.acked_at_ms); const actor = i.actor ?? SYSTEM;
  const ack = store.append({ type: "investor_submissions.acked", aggregate: { kind: "investor_submission", id: i.submission_id }, actor, occurredAt: at, payload: { submission_id: i.submission_id, channel: i.channel, format: i.format, record_count: i.records.length, acked_at: at } });
  const submitted = i.records.map((r) => store.append({ type: "investor_events.submitted", loanId: r.loan_id, aggregate: { kind: "investor_event", id: r.event_id }, actor, causationId: ack.id, occurredAt: at,
    payload: { event_id: r.event_id, event_type: r.event_type, family: r.family, sequence: r.sequence, fnma_loan_number: r.fnma_loan_number, submission_id: i.submission_id, channel: i.channel, submitted_at: at, status: "submitted" } }));
  return { ack, submitted };
}
/** The fnma-lsdu adapter path: validated 80-character records go to the port (CR stripped for transport) and its acknowledgement is recorded. */
export async function submitLarFile(store: EventStore, port: { submitLarFile(records: readonly { fnmaLoanNumber: string; record: string; eventId: string; sequence: number }[], now: string): Promise<LarSubmission> },
  i: { readonly channel: "lsdu_b2b" | "lsdu_upload"; readonly records: readonly (SubmittedRecord & { readonly record: string })[]; readonly now_ms: number; readonly actor?: Actor }): Promise<{ readonly submission: LarSubmission; readonly submitted: DomainEvent[] }> {
  need(i.records.length > 0, "a LAR file needs at least one record");
  for (const r of i.records) { const errs = validateLar80(r.record); need(errs.length === 0, `${r.event_id}: ${errs.join("; ")}`); }
  const submission = await port.submitLarFile(i.records.map((r) => ({ fnmaLoanNumber: r.fnma_loan_number, record: r.record.replace(/\r$/, ""), eventId: r.event_id, sequence: r.sequence })), toIso(i.now_ms));
  const { submitted } = recordSubmissionAck(store, { submission_id: submission.submissionId, channel: i.channel, format: "lar80", records: i.records, acked_at_ms: Date.parse(submission.acceptedAt), ...(i.actor ? { actor: i.actor } : {}) });
  return { submission, submitted };
}

// ───────────────────────────── rule 9: parsed Fannie Mae feedback → accepted / exception / superseded ─────────────────────────────
export interface TrackedEvent {
  readonly event_id: string; readonly loan_id: string; readonly fnma_loan_number: string; readonly event_type: InvestorEventType; readonly family: EventFamily; readonly activity_period: string; readonly sequence: number;
  readonly supersedes_event_id?: string | null; readonly deferral_pending?: boolean;
  /** A TT 32 record belongs to §17.1's outbound batch: its acceptance is recorded against that batch (the subject FNMA_IRM_TT32_15CD is armed on). */
  readonly transfer_batch_id?: string;
}
export type ExceptionSeverity = "hard" | "soft" | "invalid" | "missing" | "fatal" | "warning" | "notification";
export interface FeedbackIngestion { readonly accepted: string[]; readonly exceptions: { event_id: string; severity: ExceptionSeverity; code: string }[]; readonly superseded: string[]; readonly unknown: string[]; readonly events: DomainEvent[] }

function acceptEvent(store: EventStore, t: TrackedEvent, f: { source: "lsdu" | "se"; submission_id: string; at: string; status: "accepted" | "accepted_with_warnings"; warnings?: readonly { code: string; message: string }[]; actor: Actor }): DomainEvent[] {
  const out: DomainEvent[] = [];
  const aggregate = t.transfer_batch_id ? { kind: "transfer_batch", id: t.transfer_batch_id } : { kind: "investor_event", id: t.event_id };
  out.push(store.append({ type: "investor_events.accepted", loanId: t.loan_id, aggregate, actor: f.actor, occurredAt: f.at,
    payload: { event_id: t.event_id, event_type: t.event_type, family: t.family, activity_period: t.activity_period, sequence: t.sequence, submission_id: f.submission_id, source: f.source, status: f.status, accepted_at: f.at,
      deferral_pending: t.deferral_pending ?? false, supersedes_event_id: t.supersedes_event_id ?? null, warnings: f.warnings ? [...f.warnings] : [] } }));
  // the command that accepts the correcting event supersedes the rejected one (state machine: rejected_* / invalid → superseded)
  if (t.supersedes_event_id) out.push(resolveInvestorEvent(store, { event_id: t.supersedes_event_id, loan_id: t.loan_id, family: t.family, activity_period: t.activity_period, status: "superseded", resolution: "resubmitted", superseded_by: t.event_id, resolved_at_ms: Date.parse(f.at), actor: f.actor }));
  return out;
}
function raiseException(store: EventStore, t: TrackedEvent, f: { source: "lsdu" | "se"; submission_id: string; at_ms: number; severity: ExceptionSeverity; code: string; message: string; fnma_expected?: Record<string, string>; actor: Actor }): DomainEvent {
  const built = exceptionDetectedEvent({ event_id: t.event_id, loan_id: t.loan_id, family: t.family, activity_period: t.activity_period, severity: f.severity, code: f.code, detected_at_ms: f.at_ms });
  return store.append({ type: built.type, loanId: built.loanId, aggregate: { kind: "investor_event", id: t.event_id }, actor: f.actor, occurredAt: toIso(f.at_ms),
    payload: { ...built.payload, event_type: t.event_type, sequence: t.sequence, source: f.source, submission_id: f.submission_id, message: f.message, fnma_expected: f.fnma_expected ?? null, status: f.severity === "hard" ? "rejected_hard" : f.severity === "soft" ? "rejected_soft" : f.severity === "invalid" ? "invalid" : f.severity === "missing" ? "missing" : f.severity === "fatal" ? "rejected_hard" : "accepted_with_warnings" } });
}
/** LSDU Payment (LAR 96) Exceptions / acknowledgements (15–30 min latency): `accepted` only from the parsed feedback; hard/soft/invalid/missing raise `investor_event_exceptions.detected` (the correction and 4-hour triage clocks). */
export function ingestLarFeedback(store: EventStore, i: { readonly submission_id: string; readonly feedback: readonly LarFeedback[]; readonly events: readonly TrackedEvent[]; readonly received_at_ms: number; readonly actor?: Actor }): FeedbackIngestion {
  need(i.feedback.length > 0, "feedback is required (an empty extract is not a response)");
  const actor = i.actor ?? { kind: "external", id: "fnma-lsdu" }; const at = toIso(i.received_at_ms);
  const r: FeedbackIngestion = { accepted: [], exceptions: [], superseded: [], unknown: [], events: [] };
  for (const fb of i.feedback) {
    const t = i.events.find((e) => e.event_id === fb.eventId);
    if (!t) { r.unknown.push(fb.eventId); continue; }
    need(fb.fnmaLoanNumber === t.fnma_loan_number, `${fb.eventId}: feedback names loan ${fb.fnmaLoanNumber}, our record is ${t.fnma_loan_number}`);
    if (fb.kind === "accepted") { const evs = acceptEvent(store, t, { source: "lsdu", submission_id: i.submission_id, at, status: "accepted", actor }); r.events.push(...evs); r.accepted.push(t.event_id); if (t.supersedes_event_id) r.superseded.push(t.supersedes_event_id); continue; }
    const severity: ExceptionSeverity = fb.kind;
    r.events.push(raiseException(store, t, { source: "lsdu", submission_id: i.submission_id, at_ms: i.received_at_ms, severity, code: fb.code ?? fb.kind.toUpperCase(), message: fb.message ?? "", ...(fb.fnmaExpected ? { fnma_expected: fb.fnmaExpected } : {}), actor }));
    r.exceptions.push({ event_id: t.event_id, severity, code: fb.code ?? fb.kind.toUpperCase() });
  }
  return r;
}
/** Servicing Platform responses (Accepted / Accepted with Warnings / Rejected (fatal)) — the same protocol answers every inbound transaction. */
export function ingestServicingEventResponses(store: EventStore, i: { readonly submission: ServicingEventsSubmission; readonly events: readonly TrackedEvent[]; readonly received_at_ms: number; readonly actor?: Actor }): FeedbackIngestion {
  need(i.submission.responses.length > 0, "responses are required");
  const actor = i.actor ?? { kind: "external", id: "fnma-servicing-events" }; const at = toIso(i.received_at_ms);
  const r: FeedbackIngestion = { accepted: [], exceptions: [], superseded: [], unknown: [], events: [] };
  for (const res of i.submission.responses) {
    const t = i.events.find((e) => e.event_id === res.eventId);
    if (!t) { r.unknown.push(res.eventId); continue; }
    if (res.status === "rejected") {
      const fatal = res.messages.find((m) => m.severity === "fatal") ?? { code: "REJECTED", message: "rejected" };
      r.events.push(raiseException(store, t, { source: "se", submission_id: i.submission.submissionId, at_ms: i.received_at_ms, severity: "fatal", code: fatal.code, message: fatal.message, actor }));
      r.exceptions.push({ event_id: t.event_id, severity: "fatal", code: fatal.code }); continue;
    }
    const warnings = res.messages.filter((m) => m.severity === "warning").map((m) => ({ code: m.code, message: m.message }));
    r.events.push(...acceptEvent(store, t, { source: "se", submission_id: i.submission.submissionId, at, status: res.status, warnings, actor }));
    r.accepted.push(t.event_id); if (t.supersedes_event_id) r.superseded.push(t.supersedes_event_id);
    for (const w of warnings) { r.events.push(raiseException(store, t, { source: "se", submission_id: i.submission.submissionId, at_ms: i.received_at_ms, severity: "warning", code: w.code, message: w.message, actor })); r.exceptions.push({ event_id: t.event_id, severity: "warning", code: w.code }); }
  }
  return r;
}

// ───────────────────────────── rule 9: triage decision / resolution ─────────────────────────────
export interface TriageInput {
  readonly event_id: string; readonly loan_id: string; readonly exception_code: string; readonly root_cause: RootCause; readonly evidence: readonly string[]; readonly action: string; readonly deadline_at: string;
  readonly confidence: number; readonly rule_set_version: string; readonly model_version?: string; readonly actor: { kind: "agent" | "human"; id: string }; readonly agent_enabled: boolean; readonly triaged_at_ms: number;
}
export interface TriageOutcome { readonly record: LarDecisionRecord; readonly worked_by: "agent" | "human"; readonly held: boolean; readonly escalation: { kind: "human_agent"; severity: "sev2"; reason: string } | null; readonly event: DomainEvent }
/** The triage decision (`agent_decisions` schema, identical for the human path): confidence < 0.8 on the root cause holds the fix and escalates (guardrail), still a recorded decision for the 4-hour SLA. */
export function recordTriage(store: EventStore, i: TriageInput): TriageOutcome {
  need(i.event_id !== "" && i.exception_code !== "", "event_id and exception_code are required");
  const held = i.confidence < 0.8;
  const w = workException({ agent_enabled: i.agent_enabled, actor: i.actor, event_id: i.event_id, exception_code: i.exception_code, root_cause: i.root_cause, evidence: i.evidence, action: held ? "hold_and_escalate" : i.action, deadline_at: i.deadline_at, confidence: i.confidence, rule_set_version: i.rule_set_version, ...(i.model_version !== undefined ? { model_version: i.model_version } : {}) });
  const event = store.append({ type: "investor_event_exceptions.triaged", loanId: i.loan_id, aggregate: { kind: "investor_event", id: i.event_id }, actor: { kind: i.actor.kind, id: i.actor.id }, occurredAt: toIso(i.triaged_at_ms),
    payload: { event_id: i.event_id, exception_code: i.exception_code, root_cause: i.root_cause, action: w.record.action, confidence: i.confidence, held, worked_by: w.worked_by, decision: w.record, triaged_at: toIso(i.triaged_at_ms) } });
  return { record: w.record, worked_by: w.worked_by, held, escalation: held ? { kind: "human_agent", severity: "sev2", reason: `root-cause confidence ${i.confidence} < 0.8: hold and escalate` } : null, event };
}
export type Resolution = "resubmitted" | "superseded" | "ppa_filed" | "fnma_adjusted" | "closed_manual" | "accepted_as_is";
/** `investor_events.resolved{status}`: the rejected/invalid event is superseded when its correction is accepted, or a soft reject closes `accepted` at period close (rule 9). */
export function resolveInvestorEvent(store: EventStore, i: { readonly event_id: string; readonly loan_id: string; readonly family: EventFamily; readonly activity_period: string; readonly status: "superseded" | "accepted"; readonly resolution: Resolution; readonly superseded_by?: string; readonly decision_id?: string; readonly audit_note?: string; readonly resolved_at_ms: number; readonly actor?: Actor }): DomainEvent {
  need(i.event_id !== "", "event_id is required");
  need(i.resolution !== "closed_manual" || i.decision_id !== undefined, "closed_manual requires an agent_decisions record (state machine)");
  return store.append({ type: "investor_events.resolved", loanId: i.loan_id, aggregate: { kind: "investor_event", id: i.event_id }, actor: i.actor ?? SYSTEM, occurredAt: toIso(i.resolved_at_ms),
    payload: { event_id: i.event_id, family: i.family, activity_period: i.activity_period, status: i.status, resolution: i.resolution, superseded_by: i.superseded_by ?? null, decision_id: i.decision_id ?? null, audit_note: i.audit_note ?? null, resolved_at: toIso(i.resolved_at_ms) } });
}
/** Period close (rule 9 / 5.1-T12): every open soft reject closes `accepted` with `resolution=fnma_adjusted|accepted_as_is`, the decision record attached. */
export function closeSoftRejectsAtPeriodClose(store: EventStore, i: { readonly soft_rejects: readonly { event_id: string; loan_id: string; family: EventFamily; activity_period: string; fnma_adjusted: boolean; decision_id: string }[]; readonly closed_at_ms: number; readonly actor?: Actor }): { event_id: string; status: "accepted"; resolution: "fnma_adjusted" | "accepted_as_is"; event: DomainEvent }[] {
  return i.soft_rejects.map((s) => { const c = closeSoftRejectAtPeriodClose({ fnma_adjusted: s.fnma_adjusted, decision_id: s.decision_id });
    return { event_id: s.event_id, status: c.status, resolution: c.resolution, event: resolveInvestorEvent(store, { event_id: s.event_id, loan_id: s.loan_id, family: s.family, activity_period: s.activity_period, status: "accepted", resolution: c.resolution, decision_id: c.decision_id, audit_note: c.audit_note, resolved_at_ms: i.closed_at_ms, ...(i.actor ? { actor: i.actor } : {}) }) }; });
}

// ───────────────────────────── the period scheduler ─────────────────────────────
export interface EnrolledLoan { readonly loan_id: string; readonly fnma_loan_number: string; readonly reporting: "summary" | "detailed"; readonly mode?: ChannelMode; }
/** A period opens once per servicer number (the period-anchored clocks) and enrols every active loan (the per-loan IRED / no-payment floors — the row's "recurring monthly, per loan"). */
export function openReportingPeriod(store: EventStore, i: { readonly month_of: PlainDate; readonly servicer_number: string; readonly loans: readonly EnrolledLoan[]; readonly opened_at_ms?: number; readonly actor?: Actor }): { readonly anchors: PeriodAnchors; readonly opened: DomainEvent; readonly enrolled: DomainEvent[] } {
  need(SERVICER.test(i.servicer_number), "servicer_number (9 digits) is required");
  const anchors = periodAnchors(i.month_of); const actor = i.actor ?? SYSTEM; const aggregate = periodAggregate(i.servicer_number, anchors.period);
  const at = i.opened_at_ms !== undefined ? { occurredAt: toIso(i.opened_at_ms) } : {};
  const opened = store.append({ type: "investor_reporting_periods.opened", aggregate, actor, ...at, payload: { ...anchors, servicer_number: i.servicer_number, active_loans: i.loans.length, status: "open" } });
  const enrolled = i.loans.map((l) => store.append({ type: "investor_reporting_periods.loan_enrolled", loanId: l.loan_id, aggregate, actor, causationId: opened.id, ...at,
    payload: { ...anchors, servicer_number: i.servicer_number, loan_id: l.loan_id, fnma_loan_number: l.fnma_loan_number, reporting: l.reporting, mode: l.mode ?? "legacy" } }));
  return { anchors, opened, enrolled };
}
export interface SweepLoan extends EnrolledLoan { readonly accepted_payment_event: boolean; readonly position: { lpi_date: PlainDate | null; upb_cents: Cents; nib_cents: Cents }; }
/** Rule 4: the 18:00 ET IRED sweep — every summary-reporting loan without an accepted `payment.*` event in the period gets a `payment.none` row (LAR 96 with unchanged LPI/UPB, or the No Payment Event under `mode=event`), created here and then submitted through the adapter. */
export function iredSweepRun(store: EventStore, seq: SequenceAllocator, i: { readonly month_of: PlainDate; readonly servicer_number: string; readonly loans: readonly SweepLoan[]; readonly now_ms: number; readonly actor?: Actor }): { readonly sweep: ReturnType<typeof iredSweep>; readonly projections: { loan_id: string; projection: NoActivityProjection; created: CreatedInvestorEvent; lar: Lar96 | null }[] } {
  const sweep = iredSweep({ month_of: i.month_of, loans: i.loans.filter((l) => l.reporting === "summary") });
  need(i.now_ms >= iredSweepRunMs(i.month_of), `the IRED sweep runs at 18:00 ET on ${sweep.sweep_on} (2-hour buffer to the 20:00 ET deadline)`);
  const period = anchorsPeriod(i.month_of);
  const projections = i.loans.filter((l) => sweep.project_none_for.includes(l.loan_id)).map((l) => {
    const mode = l.mode ?? "legacy";
    const projection = noActivityProjection({ month_of: i.month_of, mode, servicer_number: i.servicer_number, fnma_loan_number: l.fnma_loan_number, sequence: seq.peek(l.loan_id), position: l.position });
    const created = createInvestorEvent(store, seq, { loan_id: l.loan_id, servicer_number: i.servicer_number, fnma_loan_number: l.fnma_loan_number, event_type: "payment.none", effective_date: sweep.sweep_on, processed_at_ms: i.now_ms, payload: projection.payload, mode, open_periods: [period], ...(i.actor ? { actor: i.actor } : {}) });
    return { loan_id: l.loan_id, projection, created, lar: projection.lar };
  });
  return { sweep, projections };
}
const anchorsPeriod = (monthOf: PlainDate): string => periodAnchors(monthOf).period;

/** BD2 15:00 ET (IRM): after the cutoff the adapter switches the bulk channel off; unacknowledged files become `lsdu_single` portal tasks due at the 17:00 ET close. */
export function bulkCutoffSweep(store: EventStore, i: { readonly servicer_number: string; readonly period: string; readonly now_ms: number; readonly unacked_files: readonly { file_id: string; record_count: number }[]; readonly actor?: Actor }): { readonly cutoff_ms: number; readonly closed: boolean; readonly event: DomainEvent | null; readonly portal_tasks: { kind: "human_portal_task"; role: "fnma_portal_operator"; channel: "lsdu_single"; file_id: string; record_count: number; due_ms: number }[] } {
  need(PERIOD.test(i.period) && SERVICER.test(i.servicer_number), "servicer_number and period (YYYY-MM) are required");
  const cutoff = bulkCutoffMs(i.period);
  if (i.now_ms < cutoff) return { cutoff_ms: cutoff, closed: false, event: null, portal_tasks: [] };
  const closeMs = bd2CloseMs(nextMonth(periodStart(i.period)));
  const portal_tasks = i.unacked_files.map((f) => ({ kind: "human_portal_task" as const, role: "fnma_portal_operator" as const, channel: "lsdu_single" as const, file_id: f.file_id, record_count: f.record_count, due_ms: closeMs }));
  const event = store.append({ type: "investor_batches.bulk_channel.closed", aggregate: periodAggregate(i.servicer_number, i.period), actor: i.actor ?? SYSTEM, occurredAt: toIso(i.now_ms),
    payload: { servicer_number: i.servicer_number, period: i.period, cutoff_at: toIso(cutoff), closed_at: toIso(i.now_ms), remaining_files: i.unacked_files.map((f) => f.file_id), fallback_channel: "lsdu_single", portal_tasks_due_at: toIso(closeMs) } });
  return { cutoff_ms: cutoff, closed: true, event, portal_tasks };
}

export interface PeriodCloseInput { readonly servicer_number: string; readonly facts: PeriodCloseFacts; readonly escrow_events: boolean; readonly closed_at_ms: number; readonly documents?: { checklist_document_id: string; diff_document_id: string }; readonly actor?: Actor }
export interface PeriodClosed { readonly checklist: PeriodCloseChecklist; readonly closed: boolean; readonly event: DomainEvent; readonly escalation: "officer" | null; readonly attestation_window: { opens_on: PlainDate; close_on: PlainDate } | null }
/** Rule 10: the BD2 close runs the checklist; complete → `investor_reporting_periods.closed{checklist_complete=true}` (the escrow attestation window BD3 → BD2 of the following month rides on it); incomplete → the row stays open and the `officer` escalation opens. */
export function closeReportingPeriod(store: EventStore, i: PeriodCloseInput): PeriodClosed {
  need(SERVICER.test(i.servicer_number) && PERIOD.test(i.facts.period), "servicer_number and facts.period (YYYY-MM) are required");
  const checklist = periodCloseChecklist(i.facts); const start = periodStart(i.facts.period); const anchors = periodAnchors(start);
  const following = nextMonth(start); const window = { opens_on: fannieBusinessDay(following, 3), close_on: fannieBusinessDay(nextMonth(following), 2) };
  const aggregate = periodAggregate(i.servicer_number, i.facts.period); const actor = i.actor ?? SYSTEM; const at = toIso(i.closed_at_ms);
  if (!checklist.complete) {
    const event = store.append({ type: "investor_reporting_periods.close_blocked", aggregate, actor, occurredAt: at, payload: { ...anchors, servicer_number: i.servicer_number, checklist_complete: false, items: checklist.items.map((x) => ({ ...x })), escalation: "officer", close_at: toIso(checklist.close_ms) } });
    return { checklist, closed: false, event, escalation: "officer", attestation_window: null };
  }
  const event = store.append({ type: "investor_reporting_periods.closed", aggregate, actor, occurredAt: at,
    payload: { ...anchors, servicer_number: i.servicer_number, checklist_complete: true, items: checklist.items.map((x) => ({ ...x })), closed_at: at, late: i.closed_at_ms > checklist.close_ms, escrow_events: i.escrow_events,
      attestation_window_opens_on: window.opens_on, attestation_window_close_on: window.close_on, documents: i.documents ?? null, status: "closed" } });
  return { checklist, closed: true, event, escalation: null, attestation_window: window };
}
/** The escrow attestation is a UI-only act of the `fnma_portal_operator` (or an officer): completed only with the attestation evidence attached. */
export function completeEscrowAttestation(store: EventStore, i: { readonly servicer_number: string; readonly period: string; readonly evidence_document_id: string; readonly evidence_sha256?: string; readonly submission_id?: string; readonly completed_at_ms: number; readonly actor: Actor }): DomainEvent {
  need(PERIOD.test(i.period) && SERVICER.test(i.servicer_number), "servicer_number and period (YYYY-MM) are required");
  need(i.evidence_document_id !== "", "the attestation evidence (screenshot / Submission ID document) is required");
  need(i.actor.kind === "human" && (i.actor.role === "fnma_portal_operator" || i.actor.role === "officer"), "a human_portal_task is completed by the fnma_portal_operator (or an officer), never by the agent");
  return store.append({ type: "human_portal_task.completed", aggregate: periodAggregate(i.servicer_number, i.period), actor: i.actor, occurredAt: toIso(i.completed_at_ms),
    payload: { task: "escrow_attestation", servicer_number: i.servicer_number, period: i.period, evidence_document_id: i.evidence_document_id, evidence_sha256: i.evidence_sha256 ?? null, submission_id: i.submission_id ?? null, completed_by: i.actor.id, completed_at: toIso(i.completed_at_ms) } });
}
/** The monthly `period.month_end` fact the comp-fee watch (and the §5.4/5.7 month-end rows) arm on: last calendar day of the month, run on or after it. */
export function monthEnd(store: EventStore, i: { readonly month_of: PlainDate; readonly servicer_number: string; readonly now_ms: number; readonly actor?: Actor }): { readonly anchors: PeriodAnchors; readonly event: DomainEvent } {
  need(SERVICER.test(i.servicer_number), "servicer_number (9 digits) is required");
  const anchors = periodAnchors(i.month_of);
  need(wallClock(i.now_ms, ET).date >= anchors.period_end, `the month-end job for ${anchors.period} runs on or after ${anchors.period_end}`);
  const event = store.append({ type: "period.month_end", aggregate: periodAggregate(i.servicer_number, anchors.period), actor: i.actor ?? SYSTEM, occurredAt: toIso(i.now_ms), payload: { ...anchors, servicer_number: i.servicer_number, month_end: anchors.period_end } });
  return { anchors, event };
}

// ───────────────────────────── A1-4.2-01: the compensatory-fee watch ─────────────────────────────
/** Late/inaccurate investor reporting: first instance the greater of $250 or $50 per loan up to $5,000; second $500 / $50 up to $10,000; each subsequent within a year $1,000 / $50 up to $15,000. */
export function compFeeLadder(instanceNumber: number, loans: number): { readonly fee_cents: Cents; readonly floor_cents: Cents; readonly per_loan_cents: Cents; readonly cap_cents: Cents; readonly rung: 1 | 2 | 3 } {
  need(Number.isInteger(instanceNumber) && instanceNumber >= 1 && Number.isInteger(loans) && loans >= 0, "instanceNumber ≥ 1 and loans ≥ 0");
  const rung = (Math.min(instanceNumber, 3)) as 1 | 2 | 3;
  const floor: Cents = rung === 1 ? 25_000n : rung === 2 ? 50_000n : 100_000n; const cap: Cents = rung === 1 ? 500_000n : rung === 2 ? 1_000_000n : 1_500_000n;
  const perLoan = 5_000n * BigInt(loans); const raw = perLoan > floor ? perLoan : floor;
  return { fee_cents: raw > cap ? cap : raw, floor_cents: floor, per_loan_cents: perLoan, cap_cents: cap, rung };
}
export interface CompFeeInstance { readonly kind: "late_lar" | "inaccurate_lar" | "late_delinquency_file" | "late_removal"; readonly loans: number; readonly occurred_on: PlainDate; readonly timer_code?: string }
/** The monthly watch report: instances counted toward the ladder (prior instances within the year set the rung) — informational, satisfies FNMA_A14201_COMPFEE_WATCH. */
export function compensatoryFeeWatch(store: EventStore, i: { readonly servicer_number: string; readonly period: string; readonly instances: readonly CompFeeInstance[]; readonly prior_instances_within_year: number; readonly produced_at_ms: number; readonly actor?: Actor }): { readonly lines: { instance_number: number; kind: string; loans: number; fee_cents: Cents; rung: 1 | 2 | 3 }[]; readonly exposure_cents: Cents; readonly officer_likely: boolean; readonly event: DomainEvent } {
  need(PERIOD.test(i.period) && SERVICER.test(i.servicer_number), "servicer_number and period (YYYY-MM) are required");
  const lines = i.instances.map((x, k) => { const n = i.prior_instances_within_year + k + 1; const l = compFeeLadder(n, x.loans); return { instance_number: n, kind: x.kind, loans: x.loans, fee_cents: l.fee_cents, rung: l.rung }; });
  const exposure = lines.reduce((s, l) => s + l.fee_cents, 0n);
  const event = store.append({ type: "report.produced", aggregate: periodAggregate(i.servicer_number, i.period), actor: i.actor ?? SYSTEM, occurredAt: toIso(i.produced_at_ms),
    payload: { report: "compfee_watch", servicer_number: i.servicer_number, period: i.period, instances: lines.map((l) => ({ ...l, fee_cents: l.fee_cents.toString() })), exposure_cents: exposure.toString(), prior_instances_within_year: i.prior_instances_within_year, produced_at: toIso(i.produced_at_ms) } });
  return { lines, exposure_cents: exposure, officer_likely: lines.length > 0, event };
}

// ───────────────────────────── inbound `fnma-smdu` (read): deferral acceptance ─────────────────────────────
/** SMDU's acceptance of a payment deferral case is the fact the contractual-payment LAR clock keys on (IRM 4-01: at least one business day before the end of the processing month, else the case slips a month). */
export function ingestSmduDeferralAcceptance(store: EventStore, i: { readonly loan_id: string; readonly smdu_case_id: string; readonly program: string; readonly decision_status: string; readonly processing_month: string; readonly effective_date: PlainDate; readonly accepted_at_ms: number; readonly actor?: Actor }): { readonly processing_month_end: PlainDate; readonly contractual_lar_due_on: PlainDate; readonly event: DomainEvent } {
  need(i.loan_id !== "" && i.smdu_case_id !== "", "loan_id and smdu_case_id are required");
  need(/^(payment_deferral|disaster_payment_deferral)$/.test(i.program), `${i.program} is not a payment deferral program (SMDU modification acceptance triggers the single post-modification LAR instead)`);
  need(/^(accepted|approved|completed)$/i.test(i.decision_status), `SMDU case ${i.smdu_case_id} is ${i.decision_status}, not accepted`);
  need(PERIOD.test(i.processing_month), "processing_month must be YYYY-MM");
  const start = periodStart(i.processing_month); const processing_month_end = endOfMonth(start); const due = deferralLarDeadlineOn(start);
  const event = store.append({ type: "lossmit.deferral.approved", loanId: i.loan_id, aggregate: { kind: "smdu_case", id: i.smdu_case_id }, actor: i.actor ?? { kind: "external", id: "fnma-smdu" }, occurredAt: toIso(i.accepted_at_ms),
    payload: { smdu_case_id: i.smdu_case_id, program: i.program, decision_status: i.decision_status.toLowerCase(), effective_date: i.effective_date, processing_month: i.processing_month, processing_month_end, contractual_lar_due_on: due, source: "smdu" } });
  return { processing_month_end, contractual_lar_due_on: due, event };
}

/** The last calendar day of an activity period (the `period_end` anchor of the correction clocks). */
export const periodEnd = (activityPeriod: string): PlainDate => periodEndOf(periodStart(activityPeriod));
