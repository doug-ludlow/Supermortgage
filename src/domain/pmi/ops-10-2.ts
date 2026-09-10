/**
 * §10.2 process-owned operations above the calculators in ./termination.ts and ./ops.ts — the code paths that append
 * the events the 10.2 registry clocks arm and close on:
 *
 *   - cure detection on a deferred policy (R3; `payment.applied` → subsequent review) → `loan.became_current`
 *     (HPA_4902B2_CURE_TERMINATE_1ST, anchored on the cure date, due the first day of the next month; 12 U.S.C. 4902(b)(2));
 *   - the nightly LTV snapshot → `mi.ltv_snapshot{state, ltv_bps}` (NY_INS_6503D_STOP_PREMIUM_75 when NY and ≤ 75%) and the
 *     gate's resolution `mi.ny_premium_gate.resolved` with the officer's corporate-carry record (N.Y. Ins. Law §6503(d); 10.2-Q2);
 *   - the LAR 89 fields Section 5.1's FNMA_IRM_LAR89_PERIOD_END arms on (`lar89_action_code`, `period_end_date`) and the
 *     LSDU feedback ingestion that closes it — `investor_events.accepted{event_type=mi.discontinuance}` — or, on a reject,
 *     the `fnma_portal_operator` single-LAR-entry task and the "MI not on file" data-alignment case (Integrations, failure handling);
 *   - the boarding check for a policy without an evidenced original value → `mi.original_value.missing{boarded_at}`
 *     (SM_MI_ORIGINAL_VALUE_MISSING_60; prerequisites: escalation `MI_ORIGINAL_VALUE_MISSING`, 60-day SLA);
 *   - the sweep self-check (10.2-T6) and the R-F2 premium-stop statement check (10.2-T8) opening their officer sev-1 items.
 */
import { type PlainDate, endOfMonth, addDays } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { AppliedInstallment } from "../boarding/delinquency.ts";
import { ltvBps } from "./cancellation.ts";
import { becameCurrentOn, type AutoResult, type Lar89Code } from "./termination.ts";
import { firstOfFollowingMonth } from "./schedule.ts";
import { ET, lar89AckStatus, lar89Clocks, nyPremiumGate, statementMiGuard, sweepMissedCheck } from "./ops.ts";

/** The event sink a 10.2 operation appends through (a CommandContext satisfies it). */
export interface Sink { readonly events: EventStore; readonly actor: Actor; readonly now: string; }
/** The escalation opener (src/app/escalations.ts EscalationService satisfies it structurally). */
export interface Escalator {
  open(input: { kind: "officer" | "human_portal_task" | "human_agent"; loanId?: string; ownerRole?: string; severity?: string; payload?: Record<string, unknown> }, by: Actor): { id: string };
}

// ---- LAR 89 (Section 5.1 cross-reference) --------------------------------------------------------------------------

/** 5.1's `period_end_date` anchor for FNMA_IRM_LAR89_PERIOD_END: the last calendar day of the month containing E (the reporting period the effective date falls in). */
export function lar89PeriodEnd(effective: PlainDate): PlainDate { return endOfMonth(effective); }

/** Fields the canonical `mi.terminated` / `mi.cancelled` event carries for Section 5.1: `mi.*{lar89_action_code present}` anchored on `period_end_date` (R6; IRM §3-04). */
export function lar89ReportingFields(effective: PlainDate, code: Lar89Code): { lar89_action_code: Lar89Code; period_end_date: PlainDate; lar89_action_date: string } {
  const [y, m, d] = effective.split("-");
  return { lar89_action_code: code, period_end_date: lar89PeriodEnd(effective), lar89_action_date: `${m}${d}${y!.slice(2)}` };
}

export interface Lar89Feedback { readonly record: "89"; readonly action_code: Lar89Code; readonly action_date: string; readonly status: "accepted" | "rejected"; readonly reason: string | null; readonly fnma_loan_number: string | null; readonly received_at: string; }

/** Validate an inbound LSDU feedback record for a LAR 89 (IRM §3-04: action code 51–54, action date MMDDYY = effective date). Throws RangeError on anything else. */
export function parseLar89Feedback(raw: unknown, now: string): Lar89Feedback {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new RangeError("LSDU feedback record is required");
  const f = raw as Record<string, unknown>;
  if (String(f.record ?? f.legacy_record ?? "") !== "89") throw new RangeError("LSDU feedback is not a LAR 89 record");
  const code = String(f.action_code ?? "");
  if (!["51", "52", "53", "54"].includes(code)) throw new RangeError(`LAR 89 action code ${code || "(missing)"} is not one of 51/52/53/54`);
  const ad = String(f.action_date ?? "");
  const mm = Number(ad.slice(0, 2)), dd = Number(ad.slice(2, 4));
  if (!/^\d{6}$/.test(ad) || mm < 1 || mm > 12 || dd < 1 || dd > 31) throw new RangeError(`LAR 89 action date ${ad || "(missing)"} is not MMDDYY`);
  const status = String(f.status ?? "");
  if (status !== "accepted" && status !== "rejected") throw new RangeError(`LSDU feedback status ${status || "(missing)"} is not accepted/rejected`);
  const receivedAt = typeof f.received_at === "string" && f.received_at ? f.received_at : now;
  if (Number.isNaN(Date.parse(receivedAt))) throw new RangeError(`LSDU feedback received_at ${receivedAt} is not an instant`);
  return { record: "89", action_code: code as Lar89Code, action_date: ad, status, reason: typeof f.reason === "string" && f.reason ? f.reason : null, fnma_loan_number: typeof f.fnma_loan_number === "string" && f.fnma_loan_number ? f.fnma_loan_number : null, received_at: receivedAt };
}

/** The queued LAR 89 (`investor_events.queued{legacy_record=89}`) the feedback reconciles against — same loan, action code and action date. */
export function queuedLar89For(events: EventStore, loanId: string, f: Pick<Lar89Feedback, "action_code" | "action_date">): DomainEvent | undefined {
  const q = events.byLoan(loanId).filter((e) => e.type === "investor_events.queued" && Number(e.payload.legacy_record) === 89 && String(e.payload.action_code) === f.action_code && String(e.payload.action_date) === f.action_date);
  return q[q.length - 1];
}

export interface Lar89Ingestion { readonly status: "accepted" | "rejected"; readonly event: DomainEvent; readonly queued_event_id: string; readonly portal_task_id: string | null; readonly data_alignment_case_id: string | null; }

/**
 * Ingest Fannie Mae's LSDU feedback for a queued LAR 89. Accepted → `investor_events.accepted{event_type=mi.discontinuance}`
 * (closes FNMA_IRM_LAR89_PERIOD_END). Rejected → `investor_events.rejected` plus the `fnma_portal_operator` single-LAR-entry
 * task before the period close; a hard reject "MI not on file" also opens the data-alignment case with the Investor Reporting
 * representative — the termination stands (HPA) and only the reporting is corrected.
 */
export function ingestLar89Feedback(sink: Sink, esc: Escalator, loanId: string, raw: unknown, effective: PlainDate | null): Lar89Ingestion {
  const f = parseLar89Feedback(raw, sink.now);
  const queued = queuedLar89For(sink.events, loanId, f);
  if (!queued) throw new RangeError(`no queued LAR 89 ${f.action_code} ${f.action_date} on ${loanId} to reconcile the LSDU feedback against`);
  const common = { family: "mi", legacy_record: 89, legacy_event_type: "mi_discontinuance", action_code: f.action_code, action_date: f.action_date, queued_event_id: queued.id, fnma_loan_number: f.fnma_loan_number, fnma_response_parsed: true };
  if (f.status === "accepted") {
    const event = sink.events.append({ type: "investor_events.accepted", loanId, actor: sink.actor, causationId: queued.id, occurredAt: f.received_at, payload: { ...common, event_type: "mi.discontinuance", accepted_at: f.received_at } });
    return { status: "accepted", event, queued_event_id: queued.id, portal_task_id: null, data_alignment_case_id: null };
  }
  const closeMs = effective ? lar89Clocks(effective).period_close_ms : null;
  const event = sink.events.append({ type: "investor_events.rejected", loanId, actor: sink.actor, causationId: queued.id, occurredAt: f.received_at, payload: { ...common, event_type: "mi.discontinuance", rejected_at: f.received_at, reason: f.reason, single_lar_entry_by: closeMs === null ? null : toIso(closeMs) } });
  const task = esc.open({ kind: "human_portal_task", loanId, payload: { task: "single_lar_entry", record: "LAR 89", action_code: f.action_code, action_date: f.action_date, reason: f.reason, by: closeMs === null ? null : toIso(closeMs) } }, sink.actor);
  const hard = f.reason !== null && /not on file/i.test(f.reason);
  const dataCase = hard ? esc.open({ kind: "human_agent", ownerRole: "investor-reporting", loanId, payload: { case: "data_alignment", with: "Investor Reporting representative", reason: f.reason, termination_stands: true, action_code: f.action_code, action_date: f.action_date } }, sink.actor) : null;
  return { status: "rejected", event, queued_event_id: queued.id, portal_task_id: task.id, data_alignment_case_id: dataCase ? dataCase.id : null };
}

/** Instant of the last accepted LAR 89 on the loan, or null. */
export function lar89AckedAtMs(events: EventStore, loanId: string): number | null {
  const acks = events.byLoan(loanId).filter((e) => e.type === "investor_events.accepted" && Number(e.payload.legacy_record) === 89);
  const last = acks[acks.length - 1];
  return last ? Date.parse(String(last.payload.accepted_at ?? last.occurredAt)) : null;
}

/** 10.2-T7 — the LAR 89 ack check at the bulk cutoff / period close: opens the single-LAR-entry portal task (once) when the bulk channel has closed without an ack. */
export function lar89StatusCheck(sink: Sink, esc: Escalator, loanId: string, effective: PlainDate, openTasks: readonly { payload: Record<string, unknown> }[]): ReturnType<typeof lar89AckStatus> & { portal_task_id: string | null; officer_escalation_id: string | null } {
  const r = lar89AckStatus({ effective, acked_at_ms: lar89AckedAtMs(sink.events, loanId), now_ms: Date.parse(sink.now) });
  let portal: string | null = null, officer: string | null = null;
  if (r.human_portal_task) {
    const existing = openTasks.find((t) => t.payload.task === "single_lar_entry" && t.payload.effective === effective);
    portal = existing ? null : esc.open({ kind: "human_portal_task", loanId, payload: { task: "single_lar_entry", record: "LAR 89", effective, by: toIso(r.human_portal_task.by_ms), status: r.status } }, sink.actor).id;
    sink.events.append({ type: "investor_events.portal_entry.required", loanId, actor: sink.actor, payload: { record: "LAR 89", effective, status: r.status, timer_breached: r.timer_breached, by: toIso(r.human_portal_task.by_ms) } });
  }
  if (r.escalation) officer = esc.open({ kind: "officer", loanId, severity: String(r.escalation.severity), payload: { timer: "FNMA_IRM_LAR89_PERIOD_END", record: "LAR 89", effective, period_close: toIso(r.clocks.period_close_ms) } }, sink.actor).id;
  return { ...r, portal_task_id: portal, officer_escalation_id: officer };
}

// ---- cure of a deferred termination (R3; 4902(b)(2)) -----------------------------------------------------------------

export interface CureDetected { readonly became_current_on: PlainDate; readonly effective_on: PlainDate; }

/** R3 cure: the first date on which no installment is past due; the termination is effective the first day of the following month. */
export function cureDetected(installments: readonly AppliedInstallment[], scheduledDate: PlainDate): CureDetected | null {
  const cure = becameCurrentOn(installments, scheduledDate);
  return cure === null ? null : { became_current_on: cure, effective_on: firstOfFollowingMonth(cure) };
}

/**
 * The subsequent review of a `deferred_not_current` policy: when the ledger shows the cure, append `loan.became_current`
 * (trigger of HPA_4902B2_CURE_TERMINATE_1ST: anchor `became_current_on`, due the first of the next month) before the
 * termination itself is evented. Returns the event, or null when the policy is not deferred or is still delinquent.
 */
export function emitCureDetected(sink: Sink, loanId: string, i: { result: AutoResult; scheduled_date: PlainDate; installments: readonly AppliedInstallment[] }): DomainEvent | null {
  if (i.result.status !== "deferred_not_current" || i.result.cure_on === null) return null;
  const cure = cureDetected(i.installments, i.scheduled_date) ?? { became_current_on: i.result.cure_on, effective_on: firstOfFollowingMonth(i.result.cure_on) };
  return sink.events.append({ type: "loan.became_current", loanId, actor: sink.actor, payload: { became_current_on: cure.became_current_on, cure_date: cure.became_current_on, effective_on: cure.effective_on, mi_auto_status: "deferred_not_current", scheduled_date: i.scheduled_date, grounds: [...i.result.grounds], timer: "HPA_4902B2_CURE_TERMINATE_1ST" } });
}

// ---- NY §6503(d) nightly LTV snapshot -------------------------------------------------------------------------------

export interface LtvSnapshot { readonly state: string; readonly ltv_bps: number; readonly snapshot_date: PlainDate; readonly upb_cents: Cents; readonly original_appraised_value_cents: Cents; readonly ny_stop_reached: boolean; }

/** Actual UPB ÷ original appraised value in bps on the snapshot date; `ny_stop_reached` = NY ∧ ≤ 7500 (the NY_INS_6503D_STOP_PREMIUM_75 trigger condition). */
export function ltvSnapshot(i: { state: string; upb_cents: Cents; original_appraised_value_cents: Cents; snapshot_date: PlainDate }): LtvSnapshot {
  if (i.original_appraised_value_cents <= 0n) throw new RangeError("original appraised value must be positive");
  const bps = ltvBps(i.upb_cents, i.original_appraised_value_cents);
  return { state: i.state, ltv_bps: bps, snapshot_date: i.snapshot_date, upb_cents: i.upb_cents, original_appraised_value_cents: i.original_appraised_value_cents, ny_stop_reached: i.state === "NY" && bps <= 7500 };
}

export interface NySnapshotOutcome { readonly snapshot: LtvSnapshot; readonly gate: ReturnType<typeof nyPremiumGate>; readonly escalation_id: string | null; readonly next: string | null; }

/**
 * The nightly snapshot for one policy: append `mi.ltv_snapshot{state, ltv_bps, snapshot_date}` (arms the NY gate at ≤ 75%),
 * then resolve the gate the same night — borrower premium stops; unless Fannie Mae's criteria are met (10.1 terminates) the
 * servicer carries the premium at corporate expense with an `officer` record and a monthly 10.1 re-evaluation (10.2-Q2).
 */
export function runLtvSnapshot(sink: Sink, esc: Escalator, loanId: string, i: { state: string; upb_cents: Cents; original_appraised_value_cents: Cents; snapshot_date: PlainDate; history_ok: boolean; fnma_eligible?: boolean }): NySnapshotOutcome {
  const snapshot = ltvSnapshot(i);
  sink.events.append({ type: "mi.ltv_snapshot", loanId, actor: sink.actor, payload: { state: snapshot.state, ltv_bps: snapshot.ltv_bps, snapshot_date: snapshot.snapshot_date, upb_cents: snapshot.upb_cents, original_appraised_value_cents: snapshot.original_appraised_value_cents, ny_stop_reached: snapshot.ny_stop_reached } });
  const gate = nyPremiumGate({ state: i.state, upb_cents: i.upb_cents, original_appraised_value_cents: i.original_appraised_value_cents, history_ok: i.history_ok, ...(i.fnma_eligible !== undefined ? { fnma_eligible: i.fnma_eligible } : {}) });
  if (!gate.gate_open) return { snapshot, gate, escalation_id: null, next: null };
  if (gate.premium_borne_by === "servicer_corporate") {
    sink.events.append({ type: "mi.premium.borne_by_servicer", loanId, actor: sink.actor, payload: { ltv_bps: gate.ltv_bps, snapshot_date: snapshot.snapshot_date, premium_borne_by: gate.premium_borne_by, reevaluate: gate.reevaluate, rule: "N.Y. Ins. Law §6503(d)" } });
    sink.events.append({ type: "mi.ny_premium_gate.resolved", loanId, actor: sink.actor, payload: { outcome: "premium_borne_by_servicer", snapshot_date: snapshot.snapshot_date, ltv_bps: gate.ltv_bps } });
    const e = esc.open({ kind: "officer", loanId, payload: { record: "corporate premium carry", rule: "N.Y. Ins. Law §6503(d)", ltv_bps: gate.ltv_bps, snapshot_date: snapshot.snapshot_date, reevaluate: gate.reevaluate } }, sink.actor);
    return { snapshot, gate, escalation_id: e.id, next: "10.1 evaluation monthly (pmi.* evaluate) until Fannie Mae criteria are met" };
  }
  return { snapshot, gate, escalation_id: null, next: "10.1 evaluation → pmi.* cancel (terminates; the gate resolves on `mi.coverage.ended`)" };
}

// ---- boarding: original value missing (SM_MI_ORIGINAL_VALUE_MISSING_60) ---------------------------------------------

/** A boarded MI policy without an evidenced original value: `mi.original_value.missing{boarded_at}` (the 60-day clock) and the boarding escalation `MI_ORIGINAL_VALUE_MISSING`. */
export function emitOriginalValueMissing(sink: Sink, esc: Escalator, loanId: string, i: { boarded_at: PlainDate; premium_plan: string }): { event: DomainEvent; escalation_id: string; sla_due: PlainDate } {
  const slaDue = addDays(i.boarded_at, 60);
  const event = sink.events.append({ type: "mi.original_value.missing", loanId, actor: sink.actor, payload: { boarded_at: i.boarded_at, premium_plan: i.premium_plan, reason: "ORIGINAL_VALUE_MISSING", sla_days: 60, sla_due: slaDue, timer: "SM_MI_ORIGINAL_VALUE_MISSING_60" } });
  const e = esc.open({ kind: "human_agent", ownerRole: "boarding", loanId, payload: { escalation: "MI_ORIGINAL_VALUE_MISSING", sla_days: 60, sla_due: slaDue, request: "origination file evidence of original value (sales contract / appraisal / Closing Disclosure)" } }, sink.actor);
  return { event, escalation_id: e.id, sla_due: slaDue };
}

// ---- sweep self-check (10.2-T6) and premium-stop statement check (10.2-T8) --------------------------------------------

/** The next sweep's self-check: the 0-day clock breached for policies whose scheduled date passed with no decision → `officer` sev-1 with the affected loan list. */
export function escalateMissedSweep(sink: Sink, esc: Escalator, i: Parameters<typeof sweepMissedCheck>[0]): ReturnType<typeof sweepMissedCheck> & { escalation_id: string | null } {
  const r = sweepMissedCheck(i);
  if (!r.escalation) return { ...r, escalation_id: null };
  sink.events.append({ type: "mi.sweep.missed", actor: sink.actor, payload: { timer: r.timer, affected_loans: [...r.escalation.affected_loans], job_failure: r.job_failure, last_sweep_on: i.last_sweep_on, checked_on: i.today } });
  const e = esc.open({ kind: "officer", severity: String(r.escalation.severity), payload: { timer: r.timer, affected_loans: [...r.escalation.affected_loans], job_failure: r.job_failure, checked_on: i.today } }, sink.actor);
  return { ...r, escalation_id: e.id };
}

/** R-F2 / 10.2-T8: a periodic statement for an installment due after the premium-stop date may not carry the MI escrow component — blocked by HPA_4902E_STOP_PREMIUM_30 with an officer sev-1 alert. */
export function statementPremiumStopCheck(sink: Sink, esc: Escalator, loanId: string, i: { installment_due: PlainDate; effective: PlainDate; premium_stop_from: PlainDate; includes_mi: boolean; gate_status: string | null }): ReturnType<typeof statementMiGuard> & { alert_id: string | null; gate_status: string | null } {
  const r = statementMiGuard({ installment_due: i.installment_due, effective: i.effective, includes_mi: i.includes_mi, premium_stop_from: i.premium_stop_from });
  if (!r.blocked) return { ...r, alert_id: null, gate_status: i.gate_status };
  sink.events.append({ type: "statement.blocked", loanId, actor: sink.actor, payload: { gate: r.gate, installment_due: i.installment_due, premium_stop_by: r.premium_stop_by, reason: "MI escrow component after the premium-stop date (12 U.S.C. 4902(e))" } });
  const e = esc.open({ kind: "officer", loanId, severity: "1", payload: { alert: "statement blocked", gate: r.gate, installment_due: i.installment_due, premium_stop_by: r.premium_stop_by, gate_status: i.gate_status } }, sink.actor);
  return { ...r, alert_id: e.id, gate_status: i.gate_status };
}

/** 17:00 ET on a date — the FNMA period close instant (5.1) used when reporting the single-LAR-entry deadline. */
export function periodCloseMs(d: PlainDate): number { return zonedEpochMs(d, "17:00", ET); }
