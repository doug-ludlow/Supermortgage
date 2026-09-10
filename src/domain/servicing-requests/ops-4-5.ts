/**
 * §4.5 process-owned operations: the e-mail channel behind FNMA_A4_2_1_04_EMAIL_48H.
 *
 * Spec 4.5 timer table: `FNMA_A4_2_1_04_EMAIL_48H` — trigger "inbound email", anchor `received_at`, 48 hours, satisfied by
 * "reply"; rule 1: "A direct email complaint received the same day must get a substantive reply within 48 hours
 * (A4-2.1-04)"; 4.5-T10: "Given an inbound email complaint at 09:00 ET Monday, then a substantive reply by 09:00 ET
 * Wednesday (48h)". The §4 override (timers.ts) spells the row as
 * `communication.inbound.received{channel=email}` → `communication.outbound.sent{channel=email, reply=true}`; these are
 * the two code paths that append those events:
 *   - receiveInboundEmail: the ingestion handler for an inbound e-mail record (the complaint.open command calls it for an
 *     e-mail complaint; the mail gateway calls it directly for any other inbound e-mail on the loan). It validates the
 *     record and appends `communication.inbound.received` at the record's `received_at`, so the 48-hour clock anchors on
 *     receipt, not on the moment the case was opened.
 *   - sendEmailReply: appends `communication.outbound.sent` for an e-mail the platform sends in reply; `reply=true`
 *     only for the substantive reply (complaint.respond) — an acknowledgment (complaint.acknowledge) is sent with
 *     `reply=false` and does not stop the clock.
 */
import { SYSTEM, type Actor, type DomainEvent, type EventStore } from "../../kernel/events/index.ts";
import { emailReplyDeadlineMs } from "./complaints.ts";

export interface InboundEmailRecord {
  readonly loan_id: string;
  /** Complaint / NoE / RFI case the e-mail was routed to, when known at ingestion. */
  readonly case_id?: string | null;
  readonly from: string;
  /** ISO instant the gateway received the message — the `received_at` anchor of FNMA_A4_2_1_04_EMAIL_48H. */
  readonly received_at: string;
  readonly subject?: string;
  readonly text: string;
  readonly message_id?: string;
}
export interface InboundEmailReceived extends Record<string, unknown> {
  readonly channel: "email"; readonly case_id: string | null; readonly from: string; readonly received_at: string; readonly subject: string | null; readonly message_id: string | null; readonly text_length: number;
  /** received_at + 48 hours (complaints.emailReplyDeadlineMs) — informational; the engine computes the due instant from the event. */
  readonly reply_due_at: string;
}
export interface EmailReplySent extends Record<string, unknown> {
  readonly channel: "email"; readonly reply: boolean; readonly case_id: string | null; readonly in_reply_to: string | null; readonly kind: "substantive_reply" | "acknowledgment"; readonly template: string | null; readonly sent_at: string; readonly to: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Problems with an inbound e-mail record (empty when it can be ingested). */
export function validateInboundEmail(r: Partial<InboundEmailRecord>): string[] {
  const problems: string[] = [];
  if (!r.loan_id) problems.push("loan_id required");
  if (!r.from || !EMAIL.test(r.from)) problems.push("from must be an e-mail address");
  if (!r.received_at || Number.isNaN(Date.parse(r.received_at))) problems.push("received_at must be an ISO instant");
  if (!r.text || !r.text.trim()) problems.push("text required (an empty message is not an inquiry)");
  return problems;
}
/** Ingest an inbound e-mail: validates the record and appends `communication.inbound.received{channel=email}` at `received_at` (arms FNMA_A4_2_1_04_EMAIL_48H). */
export function receiveInboundEmail(events: Pick<EventStore, "append">, r: InboundEmailRecord, actor: Actor = SYSTEM): DomainEvent<InboundEmailReceived> {
  const problems = validateInboundEmail(r);
  if (problems.length) throw new RangeError(`inbound e-mail rejected: ${problems.join("; ")}`);
  const receivedAt = new Date(Date.parse(r.received_at)).toISOString();
  const payload: InboundEmailReceived = { channel: "email", case_id: r.case_id ?? null, from: r.from, received_at: receivedAt, subject: r.subject ?? null, message_id: r.message_id ?? null, text_length: r.text.length, reply_due_at: new Date(emailReplyDeadlineMs(Date.parse(receivedAt))).toISOString() };
  return events.append<InboundEmailReceived>({ type: "communication.inbound.received", loanId: r.loan_id, ...(r.case_id ? { aggregate: { kind: "case", id: r.case_id } } : {}), actor, payload, occurredAt: receivedAt });
}
export interface EmailReplyInput {
  readonly loan_id: string; readonly case_id?: string | null; readonly to?: string | null;
  /** Event id or message id of the inbound e-mail answered. */
  readonly in_reply_to?: string | null;
  /** Substantive reply (`reply=true`, satisfies FNMA_A4_2_1_04_EMAIL_48H) or a bare acknowledgment (`reply=false`). */
  readonly substantive: boolean;
  readonly template?: string | null; readonly text: string; readonly sent_at: string;
}
/** Record an e-mail the platform sent: appends `communication.outbound.sent{channel=email, reply=<substantive>}`. */
export function sendEmailReply(events: Pick<EventStore, "append">, f: EmailReplyInput, actor: Actor = SYSTEM): DomainEvent<EmailReplySent> {
  if (!f.loan_id) throw new RangeError("loan_id required");
  if (!f.text.trim()) throw new RangeError("an e-mail reply needs text");
  if (Number.isNaN(Date.parse(f.sent_at))) throw new RangeError("sent_at must be an ISO instant");
  const payload: EmailReplySent = { channel: "email", reply: f.substantive, case_id: f.case_id ?? null, in_reply_to: f.in_reply_to ?? null, kind: f.substantive ? "substantive_reply" : "acknowledgment", template: f.template ?? null, sent_at: f.sent_at, to: f.to ?? null };
  return events.append<EmailReplySent>({ type: "communication.outbound.sent", loanId: f.loan_id, ...(f.case_id ? { aggregate: { kind: "case", id: f.case_id } } : {}), actor, payload, occurredAt: f.sent_at });
}
/** The inbound e-mail event a case's substantive reply answers (the latest one routed to the case). */
export function inboundEmailFor(events: Pick<EventStore, "ofType">, caseId: string): DomainEvent | undefined {
  return events.ofType("communication.inbound.received").filter((e) => e.payload.channel === "email" && e.payload.case_id === caseId).at(-1);
}
