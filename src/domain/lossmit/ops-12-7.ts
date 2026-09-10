/**
 * §12.7 operating rules over the pure calculators in ops.ts — the LL-2026-01 disaster foreclosure prior-approval
 * trail (`FNMA_LL202601_DISASTER_FC_PRIOR_APPROVAL_5`):
 *  - `prepareDisasterForeclosurePackage` — on the 13.4 pre-referral review completing on a disaster loan
 *    (`prereferral.review.completed{outcome=hold_disaster_approval}`), the agent prepares the hazard_loss@fanniemae.com
 *    package (due review completion + 5 `calendar_days`) → `fnma.disaster_fc_approval.prepared`; the
 *    `disaster_fc_approval_requests` row (13.4 data model) starts `fnma_response=pending`, which keeps the 13.1
 *    `FNMA_D1301_DISASTER_FC_APPROVAL_GATE` closed;
 *  - `submitDisasterForeclosurePackage` — the package is sent only by a human `officer`/`fnma_portal_operator`
 *    (12.7 guardrail; open question 2) → `fnma.disaster_fc_approval.submitted`;
 *  - `ingestFnmaDisasterForeclosureApproval` — the inbound hazard_loss@ reply feed: the record is validated
 *    (request on file, approval id, decision, date) before anything is appended; an approval appends
 *    `fnma.approval.received{kind=disaster_foreclosure, approval_id}` (the timer's satisfier) and marks the request
 *    `approved` with its response document so the 13.1/13.3 referral gate opens; a denial or information request
 *    appends `fnma.approval.declined` / `fnma.approval.info_requested` and leaves the gate closed.
 * Dates are PlainDate; a bad record throws RangeError and appends nothing.
 */
import { type PlainDate, plainDate } from "../../kernel/calendar/date.ts";
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { disasterForeclosureGate, DISASTER_FC_PACKAGE_SENDERS } from "./ops.ts";

export const HAZARD_LOSS_MAILBOX = "hazard_loss@fanniemae.com";
export const DISASTER_FC_APPROVAL_KIND = "disaster_foreclosure";
export type FnmaDisasterDecision = "approved" | "denied" | "info_requested";
export const FNMA_DISASTER_DECISIONS: readonly FnmaDisasterDecision[] = ["approved", "denied", "info_requested"];

/** The append-only request row a runtime keeps (src/app/tools.ts `EntityStore` satisfies this structurally). */
export interface RequestStore {
  get(kind: string, id: string): { readonly data: Record<string, unknown> } | undefined;
  put(kind: string, id: string, data: Record<string, unknown>, by: Actor, now: string): unknown;
}
/** What every 12.7 operation needs from the command: the event store, who acts, the loan, the clock and (optionally) the request rows. */
export interface DisasterFcCtx { readonly events: EventStore; readonly actor: Actor; readonly loanId: string; readonly now: string; readonly store?: RequestStore; }
export const DISASTER_FC_REQUESTS = "disaster_fc_approval_requests";

const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const requireDate = (v: unknown, what: string): PlainDate => { if (!isDate(v)) throw new RangeError(`${what} must be a YYYY-MM-DD date`); return plainDate(v); };
const requireId = (v: unknown, what: string): string => { if (typeof v !== "string" || v === "") throw new RangeError(`${what} is required`); return v; };
const append = (c: DisasterFcCtx, type: string, payload: Record<string, unknown>): DomainEvent => c.events.append({ type, loanId: c.loanId, actor: c.actor, payload });
const by = (a: Actor): string => `${a.kind}:${a.id}`;
/** The role a sender acts under: a human actor's `role` (its id when unset); an agent never carries a human role. */
const senderOf = (a: Actor): { kind: "agent" | "human"; role: string } => ({ kind: a.kind === "human" ? "human" : "agent", role: a.role ?? a.id });

export interface PackagePreparation { readonly review_id: string; readonly review_completed_on: PlainDate; readonly disaster_event_id?: string | null; readonly request_id?: string | null; }
export interface PreparedPackage { readonly request_id: string; readonly submission_by: PlainDate; readonly referral_allowed: false; readonly refusal: string; readonly event: DomainEvent; }
/** LL-2026-01: within 5 calendar days of the pre-referral review the package is prepared; referral stays refused until the approval id is recorded. */
export function prepareDisasterForeclosurePackage(c: DisasterFcCtx, i: PackagePreparation): PreparedPackage {
  const review_id = requireId(i.review_id, "review_id");
  const completed = requireDate(i.review_completed_on, "review_completed_on");
  const gate = disasterForeclosureGate({ review_completed_on: completed, sender: senderOf(c.actor) });
  const request_id = i.request_id || `dfa-${c.loanId}-${review_id}`;
  c.store?.put(DISASTER_FC_REQUESTS, request_id, { loan_id: c.loanId, review_id, review_completed_on: completed, disaster_event_id: i.disaster_event_id ?? null, submission_by: gate.submission_by, fnma_response: "pending", prepared_by: by(c.actor), prepared_on: c.now.slice(0, 10), mailbox: HAZARD_LOSS_MAILBOX, basis: "LL-2026-01" }, c.actor, c.now);
  const event = append(c, "fnma.disaster_fc_approval.prepared", { request_id, review_id, review_completed_on: completed, submission_by: gate.submission_by, prepared_by: by(c.actor), disaster_event_id: i.disaster_event_id ?? null, mailbox: HAZARD_LOSS_MAILBOX });
  return { request_id, submission_by: gate.submission_by, referral_allowed: false, refusal: gate.refusal!, event };
}

export interface PackageSubmission { readonly request_id: string; readonly submitted_on: PlainDate; readonly submission_id?: string | null; }
/** The package is sent only by a human `officer`/`fnma_portal_operator` (12.7 guardrail; open question 2 default `officer`). */
export function submitDisasterForeclosurePackage(c: DisasterFcCtx, i: PackageSubmission): { readonly submission_id: string; readonly submitted_on: PlainDate; readonly event: DomainEvent } {
  const request_id = requireId(i.request_id, "request_id");
  const submitted_on = requireDate(i.submitted_on, "submitted_on");
  const gate = disasterForeclosureGate({ review_completed_on: submitted_on, sender: senderOf(c.actor) });
  if (!gate.send_allowed) throw new RangeError(gate.send_refusal ?? `package send refused: only ${DISASTER_FC_PACKAGE_SENDERS.join("/")} may submit to ${HAZARD_LOSS_MAILBOX} (12.7 guardrail)`);
  const row = c.store?.get(DISASTER_FC_REQUESTS, request_id);
  if (c.store && !row) throw new RangeError(`no ${DISASTER_FC_REQUESTS} ${request_id}: prepare the package first`);
  if (row && row.data.loan_id !== c.loanId) throw new RangeError(`${DISASTER_FC_REQUESTS} ${request_id} belongs to loan ${String(row.data.loan_id)}, not ${c.loanId}`);
  const submission_id = i.submission_id || `${request_id}:sub`;
  c.store?.put(DISASTER_FC_REQUESTS, request_id, { fnma_response: "pending", submission_id, submitted_on, submitted_by: by(c.actor) }, c.actor, c.now);
  const event = append(c, "fnma.disaster_fc_approval.submitted", { request_id, submission_id, submitted_on, submitted_by: by(c.actor), mailbox: HAZARD_LOSS_MAILBOX, basis: "LL-2026-01", review_id: row?.data.review_id ?? null });
  return { submission_id, submitted_on, event };
}

/** The inbound hazard_loss@fanniemae.com reply as the integration delivers it. */
export interface FnmaDisasterApprovalRecord { readonly request_id: string; readonly loan_id?: string | null; readonly decision: FnmaDisasterDecision | string; readonly approval_id?: string | null; readonly received_on: PlainDate; readonly response_document_id?: string | null; readonly conditions?: string | null; }
export interface IngestedApproval { readonly decision: FnmaDisasterDecision; readonly approval_id: string | null; readonly referral_allowed: boolean; readonly event: DomainEvent; }
/** LL-2026-01 approval trail: validates the reply, records it on the request row and appends the event the 12.7 gate is satisfied by. */
export function ingestFnmaDisasterForeclosureApproval(c: DisasterFcCtx, r: FnmaDisasterApprovalRecord): IngestedApproval {
  const request_id = requireId(r.request_id, "request_id");
  if (!(FNMA_DISASTER_DECISIONS as readonly string[]).includes(r.decision)) throw new RangeError(`decision ${String(r.decision)} is not one of ${FNMA_DISASTER_DECISIONS.join("/")}`);
  const decision = r.decision as FnmaDisasterDecision;
  const received_on = requireDate(r.received_on, "received_on");
  if (r.loan_id != null && r.loan_id !== c.loanId) throw new RangeError(`reply for loan ${r.loan_id} cannot be recorded on loan ${c.loanId}`);
  const row = c.store?.get(DISASTER_FC_REQUESTS, request_id);
  if (c.store && !row) throw new RangeError(`no ${DISASTER_FC_REQUESTS} ${request_id}: a Fannie Mae reply must answer a prepared request`);
  if (row && row.data.loan_id !== c.loanId) throw new RangeError(`${DISASTER_FC_REQUESTS} ${request_id} belongs to loan ${String(row.data.loan_id)}, not ${c.loanId}`);
  const approval_id = decision === "approved" ? requireId(r.approval_id, "approval_id (an approval without Fannie Mae's approval id is not recorded)") : (r.approval_id ?? null);
  const response_document_id = r.response_document_id ?? approval_id;
  c.store?.put(DISASTER_FC_REQUESTS, request_id, { fnma_response: decision, approval_id, response_document_id, responded_on: received_on, conditions: r.conditions ?? null }, c.actor, c.now);
  const common = { kind: DISASTER_FC_APPROVAL_KIND, request_id, received_on, response_document_id, review_id: row?.data.review_id ?? null, basis: "LL-2026-01" };
  const event = decision === "approved" ? append(c, "fnma.approval.received", { ...common, approval_id, conditions: r.conditions ?? null })
    : decision === "denied" ? append(c, "fnma.approval.declined", { ...common, reason: r.conditions ?? null })
    : append(c, "fnma.approval.info_requested", { ...common, requested: r.conditions ?? null });
  const gate = disasterForeclosureGate({ review_completed_on: received_on, fnma_approval_id: decision === "approved" ? approval_id : null });
  return { decision, approval_id, referral_allowed: gate.referral_allowed, event };
}
