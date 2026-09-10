/**
 * §10.3 process-owned operations above the calculators in ./schedule.ts, ./termination.ts and ./ops.ts — the code path
 * that appends the event the 10.3 policy clock closes on:
 *
 *   - the 90-day midpoint preview (`SM_MI_MIDPOINT_PREVIEW_90`, anchored `midpoint_termination_date − 90 days`; satisfied by
 *     `mi.midpoint.preview.completed` — "data completeness check: schedule, original value, insurer channel"). The `pmi`
 *     agent "verifies `amortization_start`/term against the note and any modification agreement (`documents`), confirms the
 *     insurer channel and refund payee data, and pre-computes the refund estimate" (AI agent design). A preview that finds
 *     the data incomplete appends `mi.midpoint.preview.incomplete` instead and queues the loan to the `pmi` agent (the
 *     timer's breach action); a missing or note-inconsistent `amortization_term_months` "escalates to `officer` with the
 *     note image rather than guessing" (guardrail) — the clock stays open until a later preview completes.
 */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import type { Sink, Escalator } from "./ops-10-2.ts";

export type MidpointBasis = "consummation" | "modification";

/** What the preview verifies (10.3 Audit and evidence: "the recorded `amortization_start`/term derivation with the note/modification document hashes, the preview checklist"). */
export interface MidpointPreviewInput {
  readonly midpoint_termination_date: PlainDate;
  readonly midpoint_basis: MidpointBasis;
  /** `mi_schedules` version the midpoint derives from (`midpoint_schedule_id`); null when no schedule version exists. */
  readonly schedule_id: string | null;
  readonly amortization_start: PlainDate | null;
  readonly amortization_term_months: number | null;
  /** Amortization term the note (or modification agreement) states; null when the document has not been read. */
  readonly note_term_months: number | null;
  readonly note_document_hash: string | null;
  readonly modification_document_hash: string | null;
  /** Evidenced original value (10.2 prerequisites); null when missing. */
  readonly original_value_cents: Cents | null;
  /** Insurer channel: certificate and insurer code on the policy. */
  readonly insurer_certificate: string | null;
  readonly insurer: string | null;
  readonly refund_payee: string | null;
  /** Pre-computed unearned-premium estimate (10.5), when the premium data allows one. */
  readonly refund_estimate_cents: Cents | null;
}

export interface MidpointPreviewChecklist {
  readonly schedule: boolean;
  readonly amortization_terms: boolean;
  readonly note_consistent: boolean;
  readonly document_hash: boolean;
  readonly original_value: boolean;
  readonly insurer_channel: boolean;
  readonly refund_payee: boolean;
}

export interface MidpointPreview {
  readonly complete: boolean;
  readonly checklist: MidpointPreviewChecklist;
  readonly missing: readonly (keyof MidpointPreviewChecklist)[];
  /** `SM_MI_MIDPOINT_PREVIEW_90` due date: `midpoint_termination_date − 90 days`. */
  readonly preview_due: PlainDate;
  /** True when the amortization term is missing or disagrees with the note — the officer, not the agent, resolves it. */
  readonly officer_review: boolean;
}

/** The policy clock's anchor: `midpoint_termination_date − 90 days` (10.3 timer table, offset 0). */
export function midpointPreviewDue(midpointTerminationDate: PlainDate): PlainDate { return addDays(midpointTerminationDate, -90); }

/** The data-completeness check itself (pure): schedule version, amortization terms verified against the note, original value, insurer channel, refund payee. */
export function midpointPreviewCheck(i: MidpointPreviewInput): MidpointPreview {
  const termsPresent = i.amortization_start !== null && i.amortization_term_months !== null && Number.isInteger(i.amortization_term_months) && i.amortization_term_months > 0;
  const hash = i.midpoint_basis === "modification" ? i.modification_document_hash : i.note_document_hash;
  const checklist: MidpointPreviewChecklist = {
    schedule: i.schedule_id !== null && i.schedule_id !== "",
    amortization_terms: termsPresent,
    note_consistent: termsPresent && i.note_term_months !== null && i.note_term_months === i.amortization_term_months,
    document_hash: hash !== null && hash !== "",
    original_value: i.original_value_cents !== null && i.original_value_cents > 0n,
    insurer_channel: i.insurer_certificate !== null && i.insurer_certificate !== "" && i.insurer !== null && i.insurer !== "",
    refund_payee: i.refund_payee !== null && i.refund_payee !== "",
  };
  const missing = (Object.keys(checklist) as (keyof MidpointPreviewChecklist)[]).filter((k) => !checklist[k]);
  return { complete: missing.length === 0, checklist, missing, preview_due: midpointPreviewDue(i.midpoint_termination_date), officer_review: !checklist.amortization_terms || !checklist.note_consistent };
}

export interface MidpointPreviewRun extends MidpointPreview {
  readonly event: DomainEvent;
  /** The `pmi` agent queue item (incomplete preview; the timer's breach action) or null. */
  readonly queue_id: string | null;
  /** The `officer` item for a missing/inconsistent amortization term (AI agent design guardrail) or null. */
  readonly officer_escalation_id: string | null;
}

/**
 * Run the 90-day preview for a policy: complete → `mi.midpoint.preview.completed` (closes SM_MI_MIDPOINT_PREVIEW_90) with the
 * checklist, the derivation and the refund estimate; incomplete → `mi.midpoint.preview.incomplete` plus the `pmi` queue item
 * (and the `officer` item with the note reference when the term itself is in doubt). Throws RangeError on an empty input.
 */
export function runMidpointPreview(sink: Sink, esc: Escalator, loanId: string, i: MidpointPreviewInput): MidpointPreviewRun {
  if (!loanId) throw new RangeError("loan_id is required");
  if (!i.midpoint_termination_date) throw new RangeError("midpoint_termination_date is required");
  const r = midpointPreviewCheck(i);
  const derivation = { midpoint_termination_date: i.midpoint_termination_date, midpoint_basis: i.midpoint_basis, schedule_id: i.schedule_id, amortization_start: i.amortization_start, amortization_term_months: i.amortization_term_months, note_term_months: i.note_term_months, note_document_hash: i.note_document_hash, modification_document_hash: i.modification_document_hash };
  if (r.complete) {
    const event = sink.events.append({ type: "mi.midpoint.preview.completed", loanId, actor: sink.actor, payload: { ...derivation, preview_due: r.preview_due, checklist: { ...r.checklist }, original_value_cents: i.original_value_cents, insurer_channel: { certificate: i.insurer_certificate, insurer: i.insurer }, refund_payee: i.refund_payee, refund_estimate_cents: i.refund_estimate_cents, timer: "SM_MI_MIDPOINT_PREVIEW_90" } });
    return { ...r, event, queue_id: null, officer_escalation_id: null };
  }
  const event = sink.events.append({ type: "mi.midpoint.preview.incomplete", loanId, actor: sink.actor, payload: { ...derivation, preview_due: r.preview_due, checklist: { ...r.checklist }, missing: [...r.missing], officer_review: r.officer_review, timer: "SM_MI_MIDPOINT_PREVIEW_90" } });
  const queue = esc.open({ kind: "human_agent", ownerRole: "pmi", loanId, payload: { queue: "midpoint_preview", timer: "SM_MI_MIDPOINT_PREVIEW_90", preview_due: r.preview_due, midpoint_termination_date: i.midpoint_termination_date, missing: [...r.missing] } }, sink.actor);
  const officer = r.officer_review
    ? esc.open({ kind: "officer", loanId, severity: "2", payload: { reason: "AMORTIZATION_TERM_UNVERIFIED", timer: "SM_MI_MIDPOINT_PREVIEW_90", amortization_term_months: i.amortization_term_months, note_term_months: i.note_term_months, note_document_hash: i.note_document_hash, modification_document_hash: i.modification_document_hash, midpoint_basis: i.midpoint_basis, instruction: "verify the amortization period against the note image; do not guess" } }, sink.actor)
    : null;
  return { ...r, event, queue_id: queue.id, officer_escalation_id: officer ? officer.id : null };
}
