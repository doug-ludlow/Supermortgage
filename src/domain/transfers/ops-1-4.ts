/**
 * §1.4 operating rules over the custody calculators in custody-mers.ts and the custodian-feed mechanics in
 * inbound.ts: the Form 2009 release/return records the `security-records` agent and the custodian feed carry
 * (a non-liquidation release arms FNMA_RDC_FORM2009_90 and sits on the 90-Day Non-Liquidation Report until the
 * documents come back), the 90-day report derived from those events, and the signing_officer rule on resolving
 * an assignment exception. An event is the platform's statement that a record was received and checked, so every
 * function validates before it appends; nothing here contacts a borrower or posts to the ledger.
 *
 * Events (timer subject in brackets — src/kernel/timers/engine.ts arms on `loanId`, else the aggregate):
 *   custody.release.opened{form_2009_id, reason∈{non_liquidation, liquidation}, release_reason, released_at, released_to, expected_return_at, note_location=released_form_2009}
 *                                                                         [loan — arms FNMA_RDC_FORM2009_90 when reason=non_liquidation]
 *   custody.release.returned{form_2009_id, released_at, returned_at, receipt_id, days_open, on_time}   [loan — satisfies FNMA_RDC_FORM2009_90]
 *   custody.exception.resolved{loan_id, kind, raised_at, resolved_at, resolution, evidence_document_id, resolved_by}   [loan]
 *
 * Spec 1.4: "Form 2009 non-liquidation releases are tracked on the 90-Day Non-Liquidation Report" (Document
 * Transfers Job Aid v5); "loans with an open Form 2009 release are boarded with `note_location='released_form_2009'`
 * and a return timer"; "`exception` resolution involving an assignment requires `signing_officer`".
 */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { type CustodianFeedItem, type CustodyExceptionRow, ingestCustodianFeedItem, resolveCustodyException, form2009Report } from "./inbound.ts";

const AGENT: Actor = { kind: "agent", id: "security-records" };
const CUSTODIAN: Actor = { kind: "external", id: "custodian" };
/** Timer handle a return needs to retire the engine's recurring re-arm (src/app/commands.ts CommandContext.timers). */
export interface ReleaseTimerHandle { byCode(code: string): readonly { id: string; code: string; status: string; loanId?: string; armedByEventId: string }[]; cancel(id: string, reason: string, actor?: Actor): void; }

// ============================================================ Form 2009 releases (FNMA_RDC_FORM2009_90)
/** Release reasons and their Form 2009 class: liquidation releases (payoff, sale, repurchase) close the custody record; non-liquidation releases (counsel, correction, modification, assumption) are tracked on the 90-Day Non-Liquidation Report (spec 1.4 edge cases; Job Aid v5). */
export const FORM_2009_RELEASE_REASONS = {
  foreclosure_counsel: "non_liquidation", bankruptcy_counsel: "non_liquidation", correction: "non_liquidation", modification: "non_liquidation", assumption: "non_liquidation", lost_note_affidavit: "non_liquidation",
  payoff: "liquidation", foreclosure_sale: "liquidation", short_sale: "liquidation", deed_in_lieu: "liquidation", repurchase: "liquidation",
} as const;
export type Form2009ReleaseReason = keyof typeof FORM_2009_RELEASE_REASONS;
export type Form2009Class = (typeof FORM_2009_RELEASE_REASONS)[Form2009ReleaseReason];
export const FORM_2009_RETURN_DAYS = 90;

export function form2009Class(reason: string): Form2009Class {
  const c = (FORM_2009_RELEASE_REASONS as Record<string, Form2009Class>)[reason];
  if (!c) throw new RangeError(`release_reason ${JSON.stringify(reason)} is not one of ${Object.keys(FORM_2009_RELEASE_REASONS).join("/")}`);
  return c;
}
const nonEmpty = (v: string, what: string): string => { if (!v || !v.trim()) throw new RangeError(`${what} is required`); return v; };

export interface Form2009Release { readonly loan_id: string; readonly form_2009_id: string; readonly release_reason: Form2009ReleaseReason | string; readonly released_on: PlainDate; readonly released_to: string; }
/**
 * A Form 2009 release opened for a loan (13.3/16.3 requests, or a release open at transfer): appends
 * `custody.release.opened` with `reason` = the Form 2009 class. A non-liquidation release carries the return date
 * (+90 calendar days) and moves the note to `released_form_2009`; the engine arms FNMA_RDC_FORM2009_90 from it.
 */
export function openForm2009Release(events: EventStore, r: Form2009Release, actor: Actor = AGENT): { event: DomainEvent; reason: Form2009Class; expected_return_at: PlainDate | null; note_location: "released_form_2009" } {
  nonEmpty(r.loan_id, "loan_id"); nonEmpty(r.form_2009_id, "form_2009_id"); nonEmpty(r.released_to, "released_to");
  const reason = form2009Class(r.release_reason);
  const expected_return_at = reason === "non_liquidation" ? addDays(r.released_on, FORM_2009_RETURN_DAYS) : null;
  const event = events.append({ type: "custody.release.opened", loanId: r.loan_id, actor,
    payload: { form_2009_id: r.form_2009_id, reason, release_reason: r.release_reason, released_at: r.released_on, released_to: r.released_to, expected_return_at, note_location: "released_form_2009" } });
  return { event, reason, expected_return_at, note_location: "released_form_2009" };
}

export interface Form2009Return { readonly loan_id: string; readonly form_2009_id: string; readonly released_on: PlainDate; readonly returned_on: PlainDate; readonly custodian_receipt_id: string; }
/**
 * The custodian's receipt of the returned documents: appends `custody.release.returned` (satisfies
 * FNMA_RDC_FORM2009_90 on the loan). The registry row is `recurring`, so the engine re-arms a fresh 90-day instance
 * from the satisfying event; a returned release is off the 90-Day report, so that re-arm is retired here when the
 * caller passes its timer handle.
 */
export function returnForm2009Release(events: EventStore, r: Form2009Return, actor: Actor = CUSTODIAN, timers?: ReleaseTimerHandle): { event: DomainEvent; days_open: number; on_time: boolean; retired_rearm_id: string | null } {
  nonEmpty(r.loan_id, "loan_id"); nonEmpty(r.form_2009_id, "form_2009_id"); nonEmpty(r.custodian_receipt_id, "custodian_receipt_id");
  const days_open = daysBetween(r.released_on, r.returned_on);
  if (days_open < 0) throw new RangeError(`returned_on ${r.returned_on} is before released_on ${r.released_on}`);
  const on_time = days_open <= FORM_2009_RETURN_DAYS;
  const event = events.append({ type: "custody.release.returned", loanId: r.loan_id, actor,
    payload: { form_2009_id: r.form_2009_id, released_at: r.released_on, returned_at: r.returned_on, receipt_id: r.custodian_receipt_id, days_open, on_time } });
  let retired: string | null = null;
  if (timers) for (const t of timers.byCode("FNMA_RDC_FORM2009_90")) if (t.status === "armed" && t.loanId === r.loan_id && t.armedByEventId === event.id) { timers.cancel(t.id, `Form 2009 ${r.form_2009_id} returned ${r.returned_on} (receipt ${r.custodian_receipt_id})`, actor); retired = t.id; }
  return { event, days_open, on_time, retired_rearm_id: retired };
}

/** Open and returned releases reconstructed from the loan's `custody.release.*` events (one row per form_2009_id). */
export function form2009ReleasesFromEvents(events: EventStore): { loan_id: string; form_2009_id: string; released_at: PlainDate; reason: string; release_class: Form2009Class; returned_at: PlainDate | null }[] {
  const rows = new Map<string, { loan_id: string; form_2009_id: string; released_at: PlainDate; reason: string; release_class: Form2009Class; returned_at: PlainDate | null }>();
  for (const e of events.ofType("custody.release.opened")) { const p = e.payload as { form_2009_id: string; released_at: PlainDate; release_reason: string; reason: Form2009Class }; rows.set(`${e.loanId}:${p.form_2009_id}`, { loan_id: e.loanId!, form_2009_id: p.form_2009_id, released_at: p.released_at, reason: p.release_reason, release_class: p.reason, returned_at: null }); }
  for (const e of events.ofType("custody.release.returned")) { const p = e.payload as { form_2009_id: string; returned_at: PlainDate }; const row = rows.get(`${e.loanId}:${p.form_2009_id}`); if (row) row.returned_at = p.returned_at; }
  return [...rows.values()];
}
/** The 90-Day Non-Liquidation Report from the event store: non-liquidation releases still out after 90 days as of `asOf`. */
export function form2009ReportFromEvents(events: EventStore, asOf: PlainDate): ReturnType<typeof form2009Report> {
  return form2009Report(form2009ReleasesFromEvents(events).filter((r) => r.release_class === "non_liquidation").map((r) => ({ loan_id: r.loan_id, released_at: r.released_at, reason: r.reason, returned_at: r.returned_at })), asOf);
}

// ============================================================ custodian feed with Form 2009 items
export type CustodyFeedItem = CustodianFeedItem
  | { kind: "form_2009_released"; loan_id: string; form_2009_id: string; release_reason: string; released_on: PlainDate; released_to: string }
  | { kind: "form_2009_returned"; loan_id: string; form_2009_id: string; released_on: PlainDate; returned_on: PlainDate; custodian_receipt_id: string };
/** One custodian feed item → its `custody.*` event: Form 2009 release/return items land on the loan (above); everything else is the batch-level item inbound.ts ingests. */
export function ingestCustodyFeedItem(events: EventStore, batchId: string, item: CustodyFeedItem, timers?: ReleaseTimerHandle): DomainEvent {
  switch (item.kind) {
    case "form_2009_released": return openForm2009Release(events, item, CUSTODIAN).event;
    case "form_2009_returned": return returnForm2009Release(events, item, CUSTODIAN, timers).event;
    default: return ingestCustodianFeedItem(events, batchId, item);
  }
}

// ============================================================ exception resolution (signing_officer rule)
const ASSIGNMENT_KINDS: ReadonlySet<CustodyExceptionRow["kind"]> = new Set(["assignment_missing", "endorsement_break", "allonge_missing"]);
export class CustodyRoleDenied extends Error { readonly code = "ROLE_DENIED"; readonly actor: Actor; readonly required: string; constructor(actor: Actor, required: string, what: string) { super(`${what} requires role ${required}; actor is ${actor.kind}:${actor.id}${actor.role ? ` (${actor.role})` : ""}`); this.name = "CustodyRoleDenied"; this.actor = actor; this.required = required; } }
/** Whether resolving this exception is an assignment/allonge act (spec 1.4: "`exception` resolution involving an assignment requires `signing_officer`"; agent design: "`signing_officer` for any assignment or allonge execution"). */
export const resolutionNeedsSigningOfficer = (kind: CustodyExceptionRow["kind"] | string): boolean => ASSIGNMENT_KINDS.has(kind as CustodyExceptionRow["kind"]);
/**
 * Resolve a custody exception with the recorded instrument / evidence image: appends `custody.exception.resolved`
 * and returns the new (append-only) row. Assignment, endorsement and allonge resolutions are a `signing_officer`
 * act; the custodian's own acknowledgment (external ack) and the agent close every other kind.
 */
export function closeCustodyException(events: EventStore, row: CustodyExceptionRow, evidence: { document_id: string; received_on: PlainDate; resolution: string }, by: Actor): CustodyExceptionRow & { event: DomainEvent } {
  nonEmpty(evidence.document_id, "document_id"); nonEmpty(evidence.resolution, "resolution");
  if (row.resolved_at) throw new RangeError(`exception ${row.kind} on ${row.loan_id} was already resolved ${row.resolved_at}`);
  if (resolutionNeedsSigningOfficer(row.kind) && !(by.kind === "human" && by.role === "signing_officer")) throw new CustodyRoleDenied(by, "signing_officer", `resolving a ${row.kind} exception (assignment/allonge execution)`);
  const resolved = resolveCustodyException(row, evidence);
  const event = events.append({ type: "custody.exception.resolved", loanId: row.loan_id, actor: by,
    payload: { loan_id: row.loan_id, kind: row.kind, raised_at: row.raised_at, resolved_at: resolved.resolved_at, resolution: resolved.resolution, evidence_document_id: resolved.evidence_document_id, resolved_by: `${by.kind}:${by.id}` } });
  return { ...resolved, event };
}
