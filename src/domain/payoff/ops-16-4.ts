/**
 * §16.4 MERS deactivation — operating rules over the §16.3/16.4 calculators in ./release.ts:
 * the rule-1 recording gate shared by the registry evaluator and the tool (T2), eligibility with the
 * multi-county conservative clock and warning (T3), the pre-submission data-integrity check (rule 2,
 * Rule 2 §4), the prepared transaction, batch scheduling and ack ingestion (rule 3, T1), reject handling
 * with the 1.5 Subservicer-designation check (rule 3, T4), post-acceptance and post-reversal snapshot
 * verification (rule 4, T1/T6), the monthly MRE reconciliation (rule 4, T7), the eNote overlay and its
 * `mers_eregistry_transactions` rows (rule 5, T5), reversals and the $24.95 re-registration fee (rule 6),
 * and the batch-channel outage path (Integrations, T8).
 * Every rule returns the loan event it produces (`event` / `*_event` fields, payload included) so the tool
 * (src/app/tools/section16-4.ts) appends exactly what the timer rows in ./timers-16-4.ts name.
 * Pure functions; bigint cents; PlainDate strings; the servicer calendar for business days.
 */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { deactivationGate, deactivationClocks, enoteClocks, reversalDue, mreException } from "./release.ts";

export type DeactivationReason = "paid_in_full" | "charge_off";
export type ReleaseTaskStatus = "prepared" | "executed" | "submitted" | "recorded" | "third_party_recorded" | "rejected";
export interface ReleaseTask { readonly county: string; readonly status: ReleaseTaskStatus; readonly recorded_on?: PlainDate | null; readonly third_party_verified?: boolean; readonly release_task_id?: string | null; readonly recording_reference?: string | null; }
export interface Escalation { readonly kind: "officer" | "attorney" | "fnma_portal_operator"; readonly severity: "sev1" | "sev2" | "sev3"; readonly reason: string; }
export const RELEASE_GATE = "SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE" as const;

/** MERS Procedures: Paid-in-Full deactivation clock (60 CD after the lien release is recorded); policy target +5 BD; escalate at deadline − 5 CD. */
export const MERS_DEACTIVATE_CALENDAR_DAYS = 60;
export const OUTAGE_ESCALATION_DAYS_BEFORE_DEADLINE = 5;
/** Rule 6: MERS registration fee when a MIN must be re-registered after the reversal window (partner's MERS invoice, never the borrower). */
export const MERS_REREGISTRATION_FEE_CENTS: Cents = 2_495n;
/** Rule 3: same-day submission when the 60-day deadline is within 5 days. */
export const SAME_DAY_WHEN_DUE_WITHIN_DAYS = 5;
/** Nightly batch cutoff (local ET): recording evidence received before it rides the same evening's batch (T+0); later, T+1. [policy] */
export const BATCH_CUTOFF_LOCAL = "18:00";
/** Rule 6: the only documented causes for a deactivation reversal. */
export const REVERSAL_CAUSES = ["payoff_reversed", "wrong_min"] as const;
export type ReversalCause = (typeof REVERSAL_CAUSES)[number];

// ============================================================ rule 1 / T2 — the recording gate
/**
 * `SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE` (rule 1): open only with recording evidence for every county —
 * `release_tasks.status ∈ {recorded, third_party_recorded}` for all counties, a third-party recording only after it
 * is verified against the land records (recorder search or vendor return), or a recorded charge-off release.
 * No release task at all is *no evidence* and closes the gate. Shared by the registry evaluator
 * (evaluators-16-4.ts "16.4.allCountiesRecorded") and the tool guardrail (src/app/tools/section16-4.ts).
 */
export function releaseRecordedGate(i: { release_tasks: readonly ReleaseTask[]; chargeoff_release_recorded_on?: PlainDate | null }): { open: boolean; reason: string | null; blocked_counties: readonly string[]; recorded_dates: readonly PlainDate[]; source: "recorded" | "third_party_recorded" | "chargeoff" | null } {
  const chargeoff = i.chargeoff_release_recorded_on ?? null;
  if (chargeoff) return { open: true, reason: null, blocked_counties: [], recorded_dates: [chargeoff], source: "chargeoff" };
  if (i.release_tasks.length === 0) return { open: false, reason: "no recording evidence: no release task carries a recorded image/reference from 16.3 (rule 1)", blocked_counties: [], recorded_dates: [], source: null };
  const notRecorded = i.release_tasks.filter((t) => t.status !== "recorded" && t.status !== "third_party_recorded");
  const unverified = i.release_tasks.filter((t) => t.status === "third_party_recorded" && t.third_party_verified !== true);
  const recorded_dates = i.release_tasks.map((t) => t.recorded_on ?? null).filter((d): d is PlainDate => d !== null);
  const source = i.release_tasks.some((t) => t.status === "third_party_recorded") ? "third_party_recorded" : "recorded";
  if (notRecorded.length || unverified.length) {
    const why = [notRecorded.length ? `release not recorded in ${notRecorded.map((t) => t.county).join(", ")}` : null, unverified.length ? `third-party recording not yet verified against the land records in ${unverified.map((t) => t.county).join(", ")}` : null].filter((x): x is string => x !== null).join("; ");
    return { open: false, reason: `${why} — no Paid-in-Full deactivation before the release executed in MERS' name is recorded (${RELEASE_GATE})`, blocked_counties: [...notRecorded, ...unverified].map((t) => t.county), recorded_dates, source };
  }
  return { open: true, reason: null, blocked_counties: [], recorded_dates, source };
}

// ============================================================ rule 1 / T2 / T3 — eligibility
export interface MultiCountyWarning { readonly kind: "multi_county_conservative_clock"; readonly first_recorded_on: PlainDate; readonly conservative_due_on: PlainDate; readonly counties_recorded: number; readonly counties_total: number; readonly message: string; }
export interface AttemptLog { readonly type: "mers.deactivation.refused"; readonly min: string; readonly loan_id: string; readonly attempted_on: PlainDate; readonly actor: string; readonly gate: typeof RELEASE_GATE; readonly reason: string; }
/** State machine awaiting_release → eligible: arms `MERS_PROC_PAID_IN_FULL_DEACTIVATE_60` / `SM_MERS_DEACTIVATE_TARGET_5BD` on the *last* recording (timers-16-4.ts). */
export interface EligibleEvent { readonly type: "mers.deactivation.eligible"; readonly min: string; readonly loan_id: string; readonly last_recorded_at: PlainDate; readonly first_recorded_at: PlainDate; readonly source: "recorded" | "third_party_recorded" | "chargeoff"; readonly release_task_ids: readonly string[]; readonly due_on: PlainDate; readonly policy_target: PlainDate; readonly counties: number; }
/** Multi-county edge case: the conservative clock from the first recording is a warning, never a premature timer. */
export interface WarningEvent { readonly type: "mers.deactivation.multi_county_warning"; readonly min: string; readonly loan_id: string; readonly first_recorded_on: PlainDate; readonly conservative_due_on: PlainDate; readonly counties_recorded: number; readonly counties_total: number; readonly pending_counties: readonly string[]; readonly message: string; }
export interface Eligibility {
  readonly eligible: boolean; readonly state: "awaiting_release" | "eligible" | "already_inactive" | "not_payoff"; readonly reason: DeactivationReason | null;
  readonly source: "recorded" | "third_party_recorded" | "chargeoff" | null; readonly first_recorded_on: PlainDate | null; readonly last_recorded_on: PlainDate | null; readonly blocked_counties: readonly string[];
  readonly gate: { code: typeof RELEASE_GATE; ok: boolean }; readonly refusal: string | null; readonly attempt_log: AttemptLog | null;
  readonly clocks: { due_on: PlainDate; policy_target: PlainDate; escalate_on: PlainDate } | null; readonly warning: MultiCountyWarning | null;
  readonly release_task_ids: readonly string[]; readonly recording_references: readonly string[];
  /** Appended by the tool when the loan first becomes eligible (idempotent on the (min, txn_type, effective_date) key). */
  readonly eligible_event: EligibleEvent | null;
  /** Appended by the tool while other counties are still pending (the "warning from 10/26" of T3). */
  readonly warning_event: WarningEvent | null;
}
/**
 * Rule 1 (Eligibility): deactivate only after the release is recorded in every county (third-party releases after
 * verification against the land records; charge-off releases follow the same rule) and only for a loan that is
 * `paid_in_full` or `charged_off`. A blocked command is refused by `SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE`
 * and the attempt is logged (T2); a MIN already inactive is nothing to do, documented (edge cases).
 * Multi-county loans deactivate after the *last* recording; the 60-day clock runs from the last recording,
 * conservatively from the first with a warning from the first recording date (edge cases; T3).
 */
export function deactivationEligibility(i: { min: string; loan_id: string; loan_status: string; min_status: "active" | "inactive"; release_tasks: readonly ReleaseTask[]; chargeoff_release_recorded_on?: PlainDate | null; attempted_on: PlainDate; actor: string }): Eligibility {
  const reason: DeactivationReason | null = i.loan_status === "paid_in_full" ? "paid_in_full" : i.loan_status === "charged_off" ? "charge_off" : null;
  const ids = i.release_tasks.map((t) => t.release_task_id ?? null).filter((x): x is string => x !== null);
  const refs = i.release_tasks.map((t) => t.recording_reference ?? null).filter((x): x is string => x !== null);
  const warningEvent = (w: MultiCountyWarning | null, g: ReturnType<typeof releaseRecordedGate> | null): WarningEvent | null => w && g ? { type: "mers.deactivation.multi_county_warning", min: i.min, loan_id: i.loan_id, first_recorded_on: w.first_recorded_on, conservative_due_on: w.conservative_due_on, counties_recorded: w.counties_recorded, counties_total: w.counties_total, pending_counties: g.blocked_counties, message: w.message } : null;
  const refused = (state: "awaiting_release" | "not_payoff", why: string, g: ReturnType<typeof releaseRecordedGate> | null, warning: MultiCountyWarning | null): Eligibility => ({
    eligible: false, state, reason, source: g?.source ?? null, first_recorded_on: warning?.first_recorded_on ?? null, last_recorded_on: null, blocked_counties: g?.blocked_counties ?? [], gate: { code: RELEASE_GATE, ok: false }, refusal: why,
    attempt_log: { type: "mers.deactivation.refused", min: i.min, loan_id: i.loan_id, attempted_on: i.attempted_on, actor: i.actor, gate: RELEASE_GATE, reason: why }, clocks: null, warning, release_task_ids: ids, recording_references: refs, eligible_event: null, warning_event: warningEvent(warning, g) });
  if (i.min_status === "inactive") return { eligible: false, state: "already_inactive", reason, source: null, first_recorded_on: null, last_recorded_on: null, blocked_counties: [], gate: { code: RELEASE_GATE, ok: true }, refusal: "MIN already inactive (prior deactivation) — nothing to do; documented", attempt_log: null, clocks: null, warning: null, release_task_ids: ids, recording_references: refs, eligible_event: null, warning_event: null };
  if (!reason) return refused("not_payoff", `loan status ${i.loan_status} is not paid_in_full/charged_off — never deactivate a MIN whose loan is not paid in full or charged off (16.4 guardrail)`, null, null);
  const g = releaseRecordedGate({ release_tasks: i.release_tasks, chargeoff_release_recorded_on: i.chargeoff_release_recorded_on ?? null });
  const first = g.recorded_dates.length ? g.recorded_dates.reduce((a, b) => (b < a ? b : a)) : null;
  const warning: MultiCountyWarning | null = i.release_tasks.length > 1 && first !== null && g.source !== "chargeoff"
    ? { kind: "multi_county_conservative_clock", first_recorded_on: first, conservative_due_on: addDays(first, MERS_DEACTIVATE_CALENDAR_DAYS), counties_recorded: g.recorded_dates.length, counties_total: i.release_tasks.length, message: `multi-county release: the MERS 60-day clock runs from the last recording; conservatively from the first recording ${first} (deactivate by ${addDays(first, MERS_DEACTIVATE_CALENDAR_DAYS)}) — warning active from ${first}` }
    : null;
  const datesComplete = g.source === "chargeoff" || g.recorded_dates.length === i.release_tasks.length;
  const gate = deactivationGate(g.open && datesComplete);
  if (!gate.ok) return refused("awaiting_release", g.reason ?? `recorded_on missing for a recorded county — recording evidence incomplete (${RELEASE_GATE})`, g, warning);
  const last = g.recorded_dates.reduce((a, b) => (b > a ? b : a));   // the clock runs from the *last* recording
  const c = deactivationClocks(last);
  const eligible_event: EligibleEvent = { type: "mers.deactivation.eligible", min: i.min, loan_id: i.loan_id, last_recorded_at: last, first_recorded_at: first ?? last, source: g.source!, release_task_ids: ids, due_on: c.due_on, policy_target: c.policy_target, counties: g.recorded_dates.length };
  return { eligible: true, state: "eligible", reason, source: g.source, first_recorded_on: first, last_recorded_on: last, blocked_counties: [], gate: { code: RELEASE_GATE, ok: true }, refusal: null, attempt_log: null, clocks: { due_on: c.due_on, policy_target: c.policy_target, escalate_on: c.escalate_on }, warning, release_task_ids: ids, recording_references: refs, eligible_event, warning_event: null };
}
/** Spec idempotency key for `mers_transactions` (Integrations: `(min, txn_type, effective_date)`). */
export const mersTxnKey = (min: string, txn_type: string, effective_date: PlainDate): string => `${min}:${txn_type}:${effective_date}`;
/** The submit attempt the gate row arms on (timers-16-4.ts `SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE`): appended *before* the evaluator is asserted, so a blocked attempt is on the log (T2). */
export function submitRequestedEvent(e: Eligibility, min: string, loan_id: string, attempted_on: PlainDate): { type: "mers.deactivation.submit_requested"; min: string; loan_id: string; attempted_on: PlainDate; gate: typeof RELEASE_GATE; gate_open: boolean; blocked_counties: readonly string[]; release_task_ids: readonly string[]; reason: string | null } {
  return { type: "mers.deactivation.submit_requested", min, loan_id, attempted_on, gate: RELEASE_GATE, gate_open: e.gate.ok && e.state !== "already_inactive", blocked_counties: e.blocked_counties, release_task_ids: e.release_task_ids, reason: e.refusal };
}

// ============================================================ rule 2 — data-integrity check
export interface MinRecordFields { readonly borrower_names: readonly string[]; readonly property_address: string; readonly note_date: PlainDate; readonly original_amount_cents: Cents; }
const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toUpperCase();
/**
 * Rule 2 (Transaction content): the 1.5 data-integrity check (borrower names, property, note date, original amount)
 * runs before submission; any mismatch is corrected first via a MIN update (Rules of Membership Rule 2 §4 —
 * "promptly correct" discrepancies), then the deactivation is submitted. The submitting Org ID is Supermortgage
 * as the named Subservicer; a MIN naming another subservicer is a 1.5 designation exception.
 */
export function minIntegrity(i: { min: string; platform: MinRecordFields; mers: MinRecordFields; our_org_id: string; min_subservicer_org_id: string | null }): {
  ok: boolean; mismatches: readonly { field: keyof MinRecordFields; platform: string; mers: string }[]; subservicer_named: boolean; action: "proceed" | "correct_via_min_update_first" | "request_subservicer_designation"; citation: string; transaction: { min: string; reason: "Paid in Full"; submitting_org_id: string } | null;
} {
  const mm: { field: keyof MinRecordFields; platform: string; mers: string }[] = [];
  const pn = i.platform.borrower_names.map(norm).sort().join(" | "), mn = i.mers.borrower_names.map(norm).sort().join(" | ");
  if (pn !== mn) mm.push({ field: "borrower_names", platform: pn, mers: mn });
  if (norm(i.platform.property_address) !== norm(i.mers.property_address)) mm.push({ field: "property_address", platform: i.platform.property_address, mers: i.mers.property_address });
  if (i.platform.note_date !== i.mers.note_date) mm.push({ field: "note_date", platform: i.platform.note_date, mers: i.mers.note_date });
  if (i.platform.original_amount_cents !== i.mers.original_amount_cents) mm.push({ field: "original_amount_cents", platform: i.platform.original_amount_cents.toString(), mers: i.mers.original_amount_cents.toString() });
  const named = i.min_subservicer_org_id === i.our_org_id;
  const action = !named ? "request_subservicer_designation" : mm.length ? "correct_via_min_update_first" : "proceed";
  return { ok: action === "proceed", mismatches: mm, subservicer_named: named, action, citation: action === "correct_via_min_update_first" ? "MERS Rules of Membership Rule 2 §4 — correct the MIN record before the deactivation transaction" : action === "request_subservicer_designation" ? "MERS Procedures: only the Servicer or Subservicer named on the MIN can update it (1.5)" : "16.4 rule 2 — data-integrity check passed", transaction: action === "proceed" ? { min: i.min, reason: "Paid in Full", submitting_org_id: i.our_org_id } : null };
}

// ============================================================ rules 1–3 / T1 — the prepared transaction
export interface PreparedDeactivation { readonly txn_type: "deactivation_paid_in_full"; readonly min: string; readonly loan_id: string; readonly reason_code: "Paid in Full" | "Charge-off"; readonly effective_date: PlainDate; readonly submitting_org_id: string; readonly release_task_ids: readonly string[]; readonly release_recorded_at: PlainDate; readonly recording_reference: string | null; readonly source: "recorded" | "third_party_recorded" | "chargeoff"; readonly status: "prepared"; }
/**
 * State machine `eligible → prepared`: the transaction content of rule 2 (MIN, reason "Paid in Full", the recording
 * date as effective date, Supermortgage's Org ID as named Subservicer, the 16.3 evidence links) after the gate is
 * open and the data-integrity check passed; the `mers.deactivation.requested` event arms the gate row.
 */
export function prepareDeactivation(i: { loan_id: string; eligibility: Eligibility; integrity: ReturnType<typeof minIntegrity> }): { prepared: boolean; refusal: string | null; next_state: "prepared" | "awaiting_release" | "not_payoff" | "already_inactive" | "integrity_fix_first"; transaction: PreparedDeactivation | null; requested_event: { type: "mers.deactivation.requested"; min: string; loan_id: string; release_task_ids: readonly string[]; last_recorded_at: PlainDate } | null } {
  const e = i.eligibility;
  if (!e.eligible || !e.clocks || !e.last_recorded_on || !e.source) return { prepared: false, refusal: e.refusal, next_state: e.state === "eligible" ? "awaiting_release" : e.state, transaction: null, requested_event: null };
  if (!i.integrity.ok || !i.integrity.transaction) return { prepared: false, refusal: `${i.integrity.action}: ${i.integrity.citation}`, next_state: "integrity_fix_first", transaction: null, requested_event: null };
  const transaction: PreparedDeactivation = { txn_type: "deactivation_paid_in_full", min: i.integrity.transaction.min, loan_id: i.loan_id, reason_code: e.reason === "charge_off" ? "Charge-off" : "Paid in Full", effective_date: e.last_recorded_on, submitting_org_id: i.integrity.transaction.submitting_org_id, release_task_ids: e.release_task_ids, release_recorded_at: e.last_recorded_on, recording_reference: e.recording_references.length ? e.recording_references[e.recording_references.length - 1]! : null, source: e.source, status: "prepared" };
  return { prepared: true, refusal: null, next_state: "prepared", transaction, requested_event: { type: "mers.deactivation.requested", min: transaction.min, loan_id: i.loan_id, release_task_ids: e.release_task_ids, last_recorded_at: e.last_recorded_on } };
}

// ============================================================ rule 3 — batching
/** Rule 3 (Batching): nightly batch, T+1 after recording confirmation (T+0 when the evidence arrives before the cutoff); same day when the 60-day deadline is within 5 days. */
export function batchSchedule(i: { eligible_on: PlainDate; due_on: PlainDate; evidence_time_local?: string | null }): { batch_on: PlainDate; same_day_required: boolean; window: "same_day" | "T+0" | "T+1"; ack_ingested_on: PlainDate } {
  const within = daysBetween(i.eligible_on, i.due_on) <= SAME_DAY_WHEN_DUE_WITHIN_DAYS;
  const t0 = i.evidence_time_local !== undefined && i.evidence_time_local !== null && i.evidence_time_local < BATCH_CUTOFF_LOCAL;
  const window = within ? "same_day" : t0 ? "T+0" : "T+1";
  const batch_on = window === "T+1" ? addDays(i.eligible_on, 1) : i.eligible_on;
  return { batch_on, same_day_required: within, window, ack_ingested_on: addDays(batch_on, 1) };
}

// ============================================================ rule 3 / T4 — rejects
export type RejectClass = "min_not_found_under_org_id" | "min_already_inactive" | "data_mismatch" | "format" | "other";
export type RejectAction = "resubmit_as_is" | "request_subservicer_designation_then_resubmit" | "document_already_inactive" | "correct_via_min_update_first";
/** The deterministic mapping of a MERS reject text; the data-mismatch patterns are tested before the Org-ID ones so "name does not match … for Org ID …" is a mismatch (Rule 2 §4), not a designation problem. */
export function classifyReject(reject_code: string, reject_reason: string): RejectClass {
  const txt = `${reject_code} ${reject_reason}`.toLowerCase();
  if (/not found|unknown min|no min|not registered/.test(txt)) return "min_not_found_under_org_id";
  if (/inactive|already deactivated|deactivated/.test(txt)) return "min_already_inactive";
  if (/mismatch|does not match|do not match|invalid (name|amount|date|address)/.test(txt)) return "data_mismatch";
  if (/org id|orgid|not authorized|not the (servicer|subservicer)/.test(txt)) return "min_not_found_under_org_id";
  if (/format|layout|parse/.test(txt)) return "format";
  return "other";
}
/**
 * Rule 3: "rejects are mapped and resubmitted within 1 BD"; a MIN-not-found-under-our-Org-ID reject checks the
 * Subservicer designation of 1.5 first (T4). The LLM only classifies the reject and drafts the QA note: its drafts
 * (`llm`) are kept beside the platform's classification, never in place of it, and the action is the platform's.
 */
export function mersReject(i: { min: string; txn_type: "deactivation_paid_in_full" | "deactivation_reversal"; rejected_on: PlainDate; reject_code: string; reject_reason: string; our_org_id: string; min_subservicer_org_id: string | null; llm?: { reject_class?: string | null; qa_note?: string | null } | null }): {
  reject_class: RejectClass; exception: { kind: "mers_reject"; min: string; txn_type: string; reject_code: string; reject_reason: string; opened_on: PlainDate; status: "open"; qa_note_draft: string | null };
  subservicer_check: { checked_per: "1.5"; designation_ok: boolean; named_org_id: string | null; action: RejectAction };
  resubmit_by: PlainDate; next_state: "prepared" | "closed"; llm_scope: "classify_reject_and_draft_qa_note_only"; llm_drafts: { reject_class: string | null; agrees: boolean | null; qa_note: string | null };
  event: { type: "mers.txn.rejected"; txn_type: "deactivation_paid_in_full" | "deactivation_reversal"; min: string; reject_code: string; reject_reason: string; reject_class: RejectClass; rejected_at: PlainDate; resubmit_by: PlainDate; action: RejectAction };
} {
  const cls = classifyReject(i.reject_code, i.reject_reason);
  const named = i.min_subservicer_org_id === i.our_org_id;
  const action: RejectAction = cls === "min_already_inactive" ? "document_already_inactive" : cls === "data_mismatch" ? "correct_via_min_update_first" : named ? "resubmit_as_is" : "request_subservicer_designation_then_resubmit";
  const resubmit_by = addBusinessDays(i.rejected_on, 1, servicer);
  const draftClass = i.llm?.reject_class ?? null; const qa = i.llm?.qa_note ?? null;
  return { reject_class: cls, exception: { kind: "mers_reject", min: i.min, txn_type: i.txn_type, reject_code: i.reject_code, reject_reason: i.reject_reason, opened_on: i.rejected_on, status: "open", qa_note_draft: qa }, subservicer_check: { checked_per: "1.5", designation_ok: named, named_org_id: i.min_subservicer_org_id, action }, resubmit_by, next_state: action === "document_already_inactive" ? "closed" : "prepared", llm_scope: "classify_reject_and_draft_qa_note_only",
    llm_drafts: { reject_class: draftClass, agrees: draftClass === null ? null : draftClass === cls, qa_note: qa },
    event: { type: "mers.txn.rejected", txn_type: i.txn_type, min: i.min, reject_code: i.reject_code, reject_reason: i.reject_reason, reject_class: cls, rejected_at: i.rejected_on, resubmit_by, action } };
}
/** Rule 3 resubmission (T4): within 1 BD of the reject; a data mismatch is corrected through the 1.5 MIN update first (Rule 2 §4) — the resubmitted content is the platform's prepared row, never agent-authored. */
export function mersResubmission(i: { min: string; txn_type: "deactivation_paid_in_full" | "deactivation_reversal"; reject_action: RejectAction; resubmit_by: PlainDate; resubmitted_on: PlainDate; attempt: number; min_update_accepted_on?: PlainDate | null; min_subservicer_org_id: string | null; our_org_id: string }): { allowed: boolean; refusal: { code: "MIN_UPDATE_FIRST" | "SUBSERVICER_NOT_NAMED" | "NOTHING_TO_RESUBMIT"; reason: string } | null; on_time: boolean; attempt: number; event: { type: "mers.txn.resubmitted"; txn_type: string; min: string; attempt: number; resubmitted_at: PlainDate; resubmit_by: PlainDate; on_time: boolean } | null; next_state: "prepared" | "rejected" | "closed" } {
  const on_time = i.resubmitted_on <= i.resubmit_by;
  if (i.reject_action === "document_already_inactive") return { allowed: false, refusal: { code: "NOTHING_TO_RESUBMIT", reason: `MIN ${i.min} is already inactive — nothing to resubmit; documented (16.4 edge case)` }, on_time, attempt: i.attempt, event: null, next_state: "closed" };
  if (i.reject_action === "correct_via_min_update_first" && !i.min_update_accepted_on) return { allowed: false, refusal: { code: "MIN_UPDATE_FIRST", reason: "the data mismatch is corrected through the 1.5 MIN update with evidence before the deactivation is resubmitted (MERS Rules of Membership Rule 2 §4); record min_update_accepted_on" }, on_time, attempt: i.attempt, event: null, next_state: "rejected" };
  if (i.reject_action === "request_subservicer_designation_then_resubmit" && i.min_subservicer_org_id !== i.our_org_id) return { allowed: false, refusal: { code: "SUBSERVICER_NOT_NAMED", reason: `Supermortgage (${i.our_org_id}) is not the Subservicer named on MIN ${i.min} — obtain the 1.5 designation first` }, on_time, attempt: i.attempt, event: null, next_state: "rejected" };
  const attempt = i.attempt + 1;
  return { allowed: true, refusal: null, on_time, attempt, event: { type: "mers.txn.resubmitted", txn_type: i.txn_type, min: i.min, attempt, resubmitted_at: i.resubmitted_on, resubmit_by: i.resubmit_by, on_time }, next_state: "prepared" };
}

// ============================================================ rule 3 / T1 / T6 — ack ingestion
export type MersAck = { status: "accepted" } | { status: "rejected"; reject_code: string; reject_reason: string };
/**
 * Rule 3: ack files are ingested the next morning. An accepted ack is the `mers.txn.accepted{txn_type}` event that
 * satisfies `MERS_PROC_PAID_IN_FULL_DEACTIVATE_60` / `SM_MERS_DEACTIVATE_TARGET_5BD` (deactivation) or
 * `SM_MERS_DEACT_REVERSAL_5BD` (reversal) and arms `SM_MERS_DEACTIVATION_VERIFY_3BD` (accepted_at + 3 BD);
 * a reject goes through `mersReject` (T4).
 */
export function mersAck(i: { min: string; txn_type: "deactivation_paid_in_full" | "deactivation_reversal"; submitted_on: PlainDate; ack_ingested_on: PlainDate; ack: MersAck; our_org_id: string; min_subservicer_org_id: string | null; due_on?: PlainDate | null; policy_target?: PlainDate | null; effective_date?: PlainDate | null; batch_id?: string | null; enote?: boolean; paper_note_return_required?: boolean; llm?: { reject_class?: string | null; qa_note?: string | null } | null }): {
  state: "accepted" | "rejected"; accepted_on: PlainDate | null; event: { type: "mers.txn.accepted"; txn_type: "deactivation_paid_in_full" | "deactivation_reversal"; min: string; accepted_at: PlainDate; acked_at: PlainDate; effective_date: PlainDate | null; batch_id: string | null; enote: boolean; paper_note_return_required: boolean; all_mins: false } | null; satisfies: readonly string[]; arms: readonly string[]; verify_by: PlainDate | null;
  on_time: { deadline: boolean | null; policy_target: boolean | null }; reject: ReturnType<typeof mersReject> | null; next_state: "accepted" | "prepared" | "closed";
} {
  if (i.ack.status === "rejected") {
    const r = mersReject({ min: i.min, txn_type: i.txn_type, rejected_on: i.ack_ingested_on, reject_code: i.ack.reject_code, reject_reason: i.ack.reject_reason, our_org_id: i.our_org_id, min_subservicer_org_id: i.min_subservicer_org_id, llm: i.llm ?? null });
    return { state: "rejected", accepted_on: null, event: null, satisfies: [], arms: [], verify_by: null, on_time: { deadline: null, policy_target: null }, reject: r, next_state: r.next_state };
  }
  const accepted_on = i.ack_ingested_on;
  const deact = i.txn_type === "deactivation_paid_in_full";
  const enote = i.enote === true, paper = enote && i.paper_note_return_required === true;
  return { state: "accepted", accepted_on, event: { type: "mers.txn.accepted", txn_type: i.txn_type, min: i.min, accepted_at: accepted_on, acked_at: accepted_on, effective_date: i.effective_date ?? null, batch_id: i.batch_id ?? null, enote, paper_note_return_required: paper, all_mins: false }, satisfies: deact ? ["MERS_PROC_PAID_IN_FULL_DEACTIVATE_60", "SM_MERS_DEACTIVATE_TARGET_5BD"] : ["SM_MERS_DEACT_REVERSAL_5BD"],
    arms: deact ? ["SM_MERS_DEACTIVATION_VERIFY_3BD", ...(paper ? ["SM_ENOTE_PAPER_COPY_10BD"] : [])] : [],
    verify_by: deact ? addBusinessDays(accepted_on, 3, servicer) : null, on_time: { deadline: i.due_on ? accepted_on <= i.due_on : null, policy_target: i.policy_target ? accepted_on <= i.policy_target : null }, reject: null, next_state: "accepted" };
}

// ============================================================ rule 4 / T1 — verification
export interface MinSnapshotRow { readonly taken_on: PlainDate; readonly status: "active" | "inactive"; readonly reason: string | null; }
/** Rule 4 (Verification): a post-acceptance snapshot must show `status = inactive` with the Paid-in-Full reason within 3 BD of acceptance (`SM_MERS_DEACTIVATION_VERIFY_3BD`, anchor accepted_at). */
export function verificationSnapshot(i: { min: string; accepted_on: PlainDate; snapshot: MinSnapshotRow | null }): { verify_by: PlainDate; verified: boolean; satisfied_on: PlainDate | null; event: { type: "mers.snapshot.verified"; min: string; status: "inactive"; reason: string; taken_on: PlainDate; verified_at: PlainDate; all_mins: false } | null; state: "submitted" | "verified" | "closed"; breach: "sev3_resubmit_or_inquiry" | null; escalation: Escalation | null; snapshot_row: { min: string; taken_on: PlainDate; status: "active" | "inactive"; reason: string | null; verified: boolean } | null } {
  const verify_by = addBusinessDays(i.accepted_on, 3, servicer);
  const s = i.snapshot;
  const verified = s !== null && s.status === "inactive" && /paid.?in.?full/i.test(s.reason ?? "");
  const late = !verified && s !== null && s.taken_on > verify_by;
  return { verify_by, verified, satisfied_on: verified ? s!.taken_on : null, event: verified ? { type: "mers.snapshot.verified", min: i.min, status: "inactive", reason: s!.reason ?? "", taken_on: s!.taken_on, verified_at: s!.taken_on, all_mins: false } : null, state: verified ? "verified" : "submitted", breach: late ? "sev3_resubmit_or_inquiry" : null,
    escalation: late ? { kind: "officer", severity: "sev3", reason: `MIN ${i.min} not inactive/Paid in Full on the ${s!.taken_on} snapshot after the deactivation accepted ${i.accepted_on} (verify by ${verify_by}) — resubmit or MERS inquiry (SM_MERS_DEACTIVATION_VERIFY_3BD)` } : null,
    snapshot_row: s ? { min: i.min, taken_on: s.taken_on, status: s.status, reason: s.reason, verified } : null };
}
/**
 * Rule 6 / state machine `reversal_submitted → reactivated` (T6): after `mers.txn.accepted{deactivation_reversal}`
 * the MIN snapshot must show `status = active` again; the `mers.deactivation.reversed` loan event closes the
 * reversal and the loan returns to its 16.2/16.3 states. A snapshot still inactive after 3 BD goes to the `officer`.
 */
export function reactivationSnapshot(i: { min: string; reversal_accepted_on: PlainDate; snapshot: MinSnapshotRow | null }): { reactivated: boolean; state: "reversal_submitted" | "reactivated"; satisfied_on: PlainDate | null; event: { type: "mers.deactivation.reversed"; min: string; status: "active"; taken_on: PlainDate } | null; loan_returns_to: "16.2/16.3 states of the reopened loan" | null; escalation: Escalation | null; snapshot_row: { min: string; taken_on: PlainDate; status: "active" | "inactive"; reason: string | null; verified: boolean } | null } {
  const s = i.snapshot;
  const reactivated = s !== null && s.status === "active";
  const late = !reactivated && s !== null && s.taken_on > addBusinessDays(i.reversal_accepted_on, 3, servicer);
  return { reactivated, state: reactivated ? "reactivated" : "reversal_submitted", satisfied_on: reactivated ? s!.taken_on : null, event: reactivated ? { type: "mers.deactivation.reversed", min: i.min, status: "active", taken_on: s!.taken_on } : null, loan_returns_to: reactivated ? "16.2/16.3 states of the reopened loan" : null,
    escalation: late ? { kind: "officer", severity: "sev2", reason: `MIN ${i.min} still inactive ${s!.taken_on} after the reversal accepted ${i.reversal_accepted_on} — MERS inquiry` } : null, snapshot_row: s ? { min: i.min, taken_on: s.taken_on, status: s.status, reason: s.reason, verified: reactivated } : null };
}

// ============================================================ rule 4 / T7 — MRE reconciliation
export interface MreRow { readonly min: string; readonly loan_id: string; readonly min_active: boolean; readonly loan_status: string; readonly release_recorded_on: PlainDate | null; readonly subservicer_org_id: string | null; }
export interface MreFinding { readonly min: string; readonly loan_id: string; readonly exception: "active_min_on_paid_loan" | "inactive_min_on_active_loan" | "wrong_subservicer"; readonly days_since_recording: number | null; readonly qa_finding: { severity: "sev1" | "sev2" | "sev3"; opened_on: PlainDate }; readonly action: "submit_deactivation" | "submit_reversal" | "request_subservicer_designation"; readonly submit_on: PlainDate; readonly batch: "same_day"; readonly escalation: Escalation | null; }
/**
 * Rule 4: the monthly MRE reconciliation flags (a) active MINs on paid-off loans older than 60 days from recording
 * → QA finding sev-1 and the deactivation submitted the same day (T7); (b) inactive MINs on active loans → reversal;
 * (c) MINs where Supermortgage is not the named Subservicer → 1.5 designation. `mers.recon.completed` satisfies
 * `MERS_QA_MRE_RECON_MONTHLY`.
 */
export function mreReconcile(i: { mre_received_on: PlainDate; our_org_id: string; rows: readonly MreRow[] }): { findings: readonly MreFinding[]; clean: number; received_event: { type: "mers.mre.received"; received_on: PlainDate; org_id: string; rows: number }; completed_event: { type: "mers.recon.completed"; received_on: PlainDate; org_id: string; exceptions: number; findings: readonly { min: string; exception: MreFinding["exception"]; severity: "sev1" | "sev2" | "sev3" }[] }; eligible_events: readonly EligibleEvent[] } {
  const findings: MreFinding[] = [];
  for (const r of i.rows) {
    const paid = r.loan_status === "paid_in_full" || r.loan_status === "charged_off";
    const ex = mreException({ min_active: r.min_active, paid_off_release_recorded_on: paid ? r.release_recorded_on : null, today: i.mre_received_on, loan_active: !paid, subservicer_is_us: r.subservicer_org_id === i.our_org_id });
    if (!ex) continue;
    const days = r.release_recorded_on ? daysBetween(r.release_recorded_on, i.mre_received_on) : null;
    if (ex === "active_min_on_paid_loan") findings.push({ min: r.min, loan_id: r.loan_id, exception: ex, days_since_recording: days, qa_finding: { severity: "sev1", opened_on: i.mre_received_on }, action: "submit_deactivation", submit_on: i.mre_received_on, batch: "same_day", escalation: { kind: "officer", severity: "sev1", reason: `MIN ${r.min} still active ${days} days after the release recorded on ${r.release_recorded_on} (> ${MERS_DEACTIVATE_CALENDAR_DAYS} CD; Rule 7 exposure)` } });
    else if (ex === "inactive_min_on_active_loan") findings.push({ min: r.min, loan_id: r.loan_id, exception: ex, days_since_recording: days, qa_finding: { severity: "sev2", opened_on: i.mre_received_on }, action: "submit_reversal", submit_on: i.mre_received_on, batch: "same_day", escalation: { kind: "officer", severity: "sev2", reason: `MIN ${r.min} inactive on an active loan — erroneous deactivation; reversal within 5 BD` } });
    else findings.push({ min: r.min, loan_id: r.loan_id, exception: ex, days_since_recording: days, qa_finding: { severity: "sev3", opened_on: i.mre_received_on }, action: "request_subservicer_designation", submit_on: i.mre_received_on, batch: "same_day", escalation: null });
  }
  // (a) an active MIN on a paid-off loan is eligible now on its recording date: the 60-day row arms (already past due → sev-1 breach on evaluate) and the deactivation rides the same-day batch
  const eligible_events: EligibleEvent[] = i.rows.filter((r) => findings.some((f) => f.min === r.min && f.action === "submit_deactivation") && r.release_recorded_on).map((r) => { const c = deactivationClocks(r.release_recorded_on!); return { type: "mers.deactivation.eligible", min: r.min, loan_id: r.loan_id, last_recorded_at: r.release_recorded_on!, first_recorded_at: r.release_recorded_on!, source: "recorded", release_task_ids: [], due_on: c.due_on, policy_target: c.policy_target, counties: 1 }; });
  return { findings, clean: i.rows.length - findings.length, received_event: { type: "mers.mre.received", received_on: i.mre_received_on, org_id: i.our_org_id, rows: i.rows.length }, completed_event: { type: "mers.recon.completed", received_on: i.mre_received_on, org_id: i.our_org_id, exceptions: findings.length, findings: findings.map((f) => ({ min: f.min, exception: f.exception, severity: f.qa_finding.severity })) }, eligible_events };
}

// ============================================================ rule 5 / T5 — eNotes
/**
 * Rule 5 (eNotes): at payoff request the eRegistry "Paid Off" status through the Controller/delegation path within
 * 2 BD; after the release records, deactivate the eRegistry registration and the MERS System MIN; in a
 * `paper_note_return_required` state, print the eVault authoritative copy marked "Copy" and "Paid-In-Full" and mail
 * it with the F-1-09 letter (`NTC_ENOTE_PAPER_COPY`). Two 10-BD dates exist in the spec: T5's "mailed by 11/09" is
 * 10 BD from the recording (`mail_by`, the policy date) while the `SM_ENOTE_PAPER_COPY_10BD` row anchors
 * accepted_at (`timer_due_on`); acceptance follows recording, so the policy date is never later than the timer.
 * A Controller other than Fannie Mae escalates; a Fannie Mae UI step is a `human_portal_task`.
 */
export function enoteOverlay(i: { payoff_on: PlainDate; release_recorded_on: PlainDate | null; deactivation_accepted_on?: PlainDate | null; paper_note_return_required: boolean; controller: "fnma" | "other"; requires_fnma_ui?: boolean }): {
  status_request: { txn_type: "change_status_paid_off"; requested_via: "evault_api" | "fnma_request" | "ui"; due_by: PlainDate; event: "enote.status.paid_off" }; registration_deactivation: { txn_type: "registration_deactivation"; after: PlainDate; event: "enote.registration.deactivated" } | null;
  paper_copy: { markings: readonly ["Copy", "Paid-In-Full"]; notice: "NTC_ENOTE_PAPER_COPY"; mail_by: PlainDate; timer_due_on: PlainDate | null; event: "enote.paper_copy.sent" } | null; escalation: Escalation | null; portal_task: { kind: "human_portal_task"; owner: "fnma_portal_operator" } | null;
} {
  const c = enoteClocks(i.payoff_on, i.release_recorded_on ?? undefined);
  const ui = i.requires_fnma_ui === true;
  const accepted = i.deactivation_accepted_on ?? null;
  return {
    status_request: { txn_type: "change_status_paid_off", requested_via: ui ? "ui" : "evault_api", due_by: c.paid_off_status_by, event: "enote.status.paid_off" },
    registration_deactivation: i.release_recorded_on ? { txn_type: "registration_deactivation", after: i.release_recorded_on, event: "enote.registration.deactivated" } : null,
    paper_copy: i.paper_note_return_required && c.paper_copy_by ? { markings: ["Copy", "Paid-In-Full"], notice: "NTC_ENOTE_PAPER_COPY", mail_by: c.paper_copy_by, timer_due_on: accepted ? addBusinessDays(accepted, 10, servicer) : null, event: "enote.paper_copy.sent" } : null,
    escalation: i.controller !== "fnma" ? { kind: "officer", severity: "sev2", reason: "eNote Controller is not Fannie Mae — status change path unknown (16.4 edge case)" } : null,
    portal_task: ui ? { kind: "human_portal_task", owner: "fnma_portal_operator" } : null,
  };
}

export type ERegistryTxnType = "change_status_paid_off" | "registration_deactivation" | "change_status_reversal";
export type ERegistryStatus = "requested" | "accepted" | "rejected" | "confirmed";
export interface ERegistryRow { readonly id: string; readonly loan_id: string; readonly min: string; readonly enote_id: string | null; readonly txn_type: ERegistryTxnType; readonly requested_at: PlainDate; readonly requested_via: "evault_api" | "fnma_request" | "ui"; readonly controller_org_id: string | null; readonly status: ERegistryStatus; readonly ack_reference: string | null; readonly evidence_document_id: string | null; }
export const EREGISTRY_EVENT: Record<ERegistryTxnType, "enote.status.paid_off" | "enote.registration.deactivated" | "enote.status.reversed"> = { change_status_paid_off: "enote.status.paid_off", registration_deactivation: "enote.registration.deactivated", change_status_reversal: "enote.status.reversed" };
/**
 * Rule 5 / data model `mers_eregistry_transactions`: the eRegistry status change ("Paid Off" at payoff, within 2 BD),
 * the registration deactivation (after the release records) and the status reversal, each `requested` → `accepted` |
 * `rejected` → `confirmed` with the eVault/Fannie Mae ack reference; the loan event carries the row's status so
 * `SM_ENOTE_PAIDOFF_STATUS_2BD` is satisfied by a request or a confirmation, never by a reject.
 */
export interface ERegistryEvent { readonly type: "enote.status.paid_off" | "enote.registration.deactivated" | "enote.status.reversed"; readonly min: string; readonly txn_type: ERegistryTxnType; readonly status: ERegistryStatus; readonly requested_at: PlainDate; readonly requested_via: "evault_api" | "fnma_request" | "ui"; readonly due_by: PlainDate | null; readonly ack_reference: string | null; }
export function eregistryTransaction(i: { loan_id: string; min: string; enote_id?: string | null; txn_type: ERegistryTxnType; requested_on: PlainDate; requested_via: "evault_api" | "fnma_request" | "ui"; controller_org_id?: string | null; ack?: { status: "accepted" | "rejected" | "confirmed"; reference?: string | null; evidence_document_id?: string | null } | null; payoff_on?: PlainDate | null; release_recorded_on?: PlainDate | null }): { row: ERegistryRow | null; event: ERegistryEvent | null; refusal: string | null } {
  if (i.txn_type === "registration_deactivation" && !i.release_recorded_on) return { row: null, event: null, refusal: `no eRegistry registration deactivation before the release records (rule 5; ${RELEASE_GATE})` };
  const status: ERegistryStatus = i.ack?.status ?? "requested";
  const row: ERegistryRow = { id: `${i.min}:${i.txn_type}:${i.requested_on}`, loan_id: i.loan_id, min: i.min, enote_id: i.enote_id ?? null, txn_type: i.txn_type, requested_at: i.requested_on, requested_via: i.requested_via, controller_org_id: i.controller_org_id ?? null, status, ack_reference: i.ack?.reference ?? null, evidence_document_id: i.ack?.evidence_document_id ?? null };
  const due_by = i.txn_type === "change_status_paid_off" && i.payoff_on ? enoteClocks(i.payoff_on).paid_off_status_by : null;
  return { row, event: { type: EREGISTRY_EVENT[i.txn_type], min: i.min, txn_type: i.txn_type, status, requested_at: i.requested_on, requested_via: i.requested_via, due_by, ack_reference: row.ack_reference }, refusal: null };
}
/** Rule 5: the F-1-09 paper copy — printed from the eVault authoritative copy marked "Copy" and "Paid-In-Full", mailed with `NTC_ENOTE_PAPER_COPY`; the `enote.paper_copy.sent` loan event and the 16.2 housekeeping task closure. */
export function enotePaperCopy(i: { loan_id: string; min: string; payoff_on: PlainDate; release_recorded_on: PlainDate; deactivation_accepted_on?: PlainDate | null; paper_note_return_required: boolean; mailed_on: PlainDate; notice_id: string | null; evault_document_id?: string | null }): { required: boolean; event: { type: "enote.paper_copy.sent"; min: string; notice: "NTC_ENOTE_PAPER_COPY"; notice_id: string | null; markings: readonly ["Copy", "Paid-In-Full"]; mailed_at: PlainDate; mail_by: PlainDate; timer_due_on: PlainDate | null; on_time: boolean; evault_document_id: string | null } | null; housekeeping: { task: "enote_paper_copy"; status: "done"; completed_on: PlainDate } | null } {
  const en = enoteOverlay({ payoff_on: i.payoff_on, release_recorded_on: i.release_recorded_on, deactivation_accepted_on: i.deactivation_accepted_on ?? null, paper_note_return_required: i.paper_note_return_required, controller: "fnma" });
  if (!en.paper_copy) return { required: false, event: null, housekeeping: null };
  const by = en.paper_copy.timer_due_on ?? en.paper_copy.mail_by;
  return { required: true, event: { type: "enote.paper_copy.sent", min: i.min, notice: "NTC_ENOTE_PAPER_COPY", notice_id: i.notice_id, markings: en.paper_copy.markings, mailed_at: i.mailed_on, mail_by: en.paper_copy.mail_by, timer_due_on: en.paper_copy.timer_due_on, on_time: i.mailed_on <= by, evault_document_id: i.evault_document_id ?? null }, housekeeping: { task: "enote_paper_copy", status: "done", completed_on: i.mailed_on } };
}

// ============================================================ rule 6 / T6 — reversals ($24.95)
/**
 * Rule 6 (Reversals): only for a documented cause (payoff reversed pre-close; deactivation of the wrong MIN);
 * submitted within 5 BD with the reason. If MERS' reversal window has passed, re-register per the Procedures —
 * registration fee $24.95 to the partner's MERS invoice, never the borrower — and open a QA finding; the partner
 * `officer` is escalated to for reversals outside the window, `attorney` for a contested payoff reversal.
 * A payoff reversed before the release records cancels eligibility — nothing to reverse.
 */
export function deactivationReversal(i: { min: string; cause: ReversalCause | null; cause_document_id?: string | null; reversal_needed_on: PlainDate; deactivated_on: PlainDate | null; mers_window_open: boolean; contested?: boolean }): {
  path: "refused" | "nothing_to_reverse" | "reversal" | "re_register"; refusal: string | null; submit_by: PlainDate | null; txn_type: "deactivation_reversal" | "registration" | null;
  fee_cents: Cents; bill_to: "partner_mers_invoice" | null; borrower_charge_cents: Cents; qa_finding: boolean; escalation: Escalation | null; snapshot_expected: "active" | null; satisfied_by: "mers.txn.accepted{deactivation_reversal}" | null;
  /** State machine → `reversal_needed`: arms `SM_MERS_DEACT_REVERSAL_5BD` on the reversal date (timers-16-4.ts). */
  reversal_needed_event: { type: "mers.deactivation.reversal_needed"; min: string; reversal_needed_on: PlainDate; cause: ReversalCause; cause_document_id: string; deactivated_on: PlainDate; path: "reversal" | "re_register"; submit_by: PlainDate; contested: boolean } | null;
  /** The reversal (or re-registration) `mers_transactions` row content. */
  transaction: { txn_type: "deactivation_reversal" | "registration"; min: string; effective_date: PlainDate; reason_code: ReversalCause; status: "prepared"; fee_cents: Cents } | null;
  /** Rule 6 / edge cases: a payoff reversed before any deactivation cancels the deactivation eligibility (open 60-day / 5-BD instances) — nothing to reverse. */
  cancel_eligibility: { timers: readonly ["MERS_PROC_PAID_IN_FULL_DEACTIVATE_60", "SM_MERS_DEACTIVATE_TARGET_5BD"]; reason: string; event: { type: "mers.deactivation.eligibility_cancelled"; min: string; cause: ReversalCause; reversal_needed_on: PlainDate } } | null;
} {
  const none = { submit_by: null, txn_type: null, fee_cents: 0n, bill_to: null, borrower_charge_cents: 0n, qa_finding: false, escalation: null, snapshot_expected: null, satisfied_by: null, reversal_needed_event: null, transaction: null, cancel_eligibility: null } as const;
  if (!i.cause || !(REVERSAL_CAUSES as readonly string[]).includes(i.cause) || !i.cause_document_id) return { path: "refused", refusal: "no reversal without a documented cause (16.4 guardrail; rule 6)", ...none };
  if (i.deactivated_on === null) return { path: "nothing_to_reverse", refusal: null, ...none, cancel_eligibility: { timers: ["MERS_PROC_PAID_IN_FULL_DEACTIVATE_60", "SM_MERS_DEACTIVATE_TARGET_5BD"], reason: `payoff reversed ${i.reversal_needed_on} (${i.cause}) before any deactivation — eligibility cancelled, nothing to reverse (16.4 edge cases)`, event: { type: "mers.deactivation.eligibility_cancelled", min: i.min, cause: i.cause, reversal_needed_on: i.reversal_needed_on } } };
  const contested = i.contested === true ? { kind: "attorney", severity: "sev2", reason: "deactivation must be undone after a contested payoff reversal" } as const : null;
  const submit_by = reversalDue(i.reversal_needed_on);
  const needed = (path: "reversal" | "re_register") => ({ type: "mers.deactivation.reversal_needed" as const, min: i.min, reversal_needed_on: i.reversal_needed_on, cause: i.cause!, cause_document_id: i.cause_document_id!, deactivated_on: i.deactivated_on!, path, submit_by, contested: i.contested === true });
  if (i.mers_window_open) return { path: "reversal", refusal: null, submit_by, txn_type: "deactivation_reversal", fee_cents: 0n, bill_to: null, borrower_charge_cents: 0n, qa_finding: false, escalation: contested, snapshot_expected: "active", satisfied_by: "mers.txn.accepted{deactivation_reversal}", reversal_needed_event: needed("reversal"), transaction: { txn_type: "deactivation_reversal", min: i.min, effective_date: i.reversal_needed_on, reason_code: i.cause, status: "prepared", fee_cents: 0n }, cancel_eligibility: null };
  return { path: "re_register", refusal: null, submit_by, txn_type: "registration", fee_cents: MERS_REREGISTRATION_FEE_CENTS, bill_to: "partner_mers_invoice", borrower_charge_cents: 0n, qa_finding: true, escalation: contested ?? { kind: "officer", severity: "sev2", reason: `MERS reversal window passed for MIN ${i.min} — re-register ($24.95 to the partner's MERS invoice) and open a QA finding` }, snapshot_expected: "active", satisfied_by: null, reversal_needed_event: needed("re_register"), transaction: { txn_type: "registration", min: i.min, effective_date: i.reversal_needed_on, reason_code: i.cause, status: "prepared", fee_cents: MERS_REREGISTRATION_FEE_CENTS }, cancel_eligibility: null };
}

// ============================================================ Integrations / T8 — batch channel outage
/**
 * `mers` adapter outage: resubmit next window, timers unaffected (60-day cushion), escalate at deadline − 5 days;
 * when the deadline is inside the cushion a manual MERS OnLine upload task is created for the `officer`-authorized
 * operator (AI-off path: the ops-console MERS workbench builds the same batch) (T8).
 */
export function batchOutage(i: { min: string; outage_on: PlainDate; due_on: PlainDate; batch_document_id?: string | null }): {
  escalate_on: PlainDate; escalation_fired: boolean; escalation: Escalation | null; manual_task: { kind: "mers_online_manual_upload"; authorized_role: "officer"; min: string; due_on: PlainDate; batch_document_id: string | null } | null;
  resubmit_next_window: PlainDate; timers_unaffected: true; days_to_deadline: number;
  event: { type: "mers.batch.outage"; min: string; outage_on: PlainDate; due_on: PlainDate; escalate_on: PlainDate; escalation_fired: boolean; resubmit_next_window: PlainDate; days_to_deadline: number };
} {
  const escalate_on = addDays(i.due_on, -OUTAGE_ESCALATION_DAYS_BEFORE_DEADLINE);
  const fired = i.outage_on >= escalate_on;
  const days = daysBetween(i.outage_on, i.due_on);
  const resubmit_next_window = addDays(i.outage_on, 1);
  return {
    escalate_on, escalation_fired: fired,
    escalation: fired ? { kind: "officer", severity: "sev2", reason: `MERS batch channel down on ${i.outage_on}; Paid-in-Full deactivation of MIN ${i.min} due ${i.due_on} (deadline − ${OUTAGE_ESCALATION_DAYS_BEFORE_DEADLINE} days reached) — manual MERS OnLine submission required` } : null,
    manual_task: fired ? { kind: "mers_online_manual_upload", authorized_role: "officer", min: i.min, due_on: i.due_on, batch_document_id: i.batch_document_id ?? null } : null,
    resubmit_next_window, timers_unaffected: true, days_to_deadline: days,
    event: { type: "mers.batch.outage", min: i.min, outage_on: i.outage_on, due_on: i.due_on, escalate_on, escalation_fired: fired, resubmit_next_window, days_to_deadline: days },
  };
}
