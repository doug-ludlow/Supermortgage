/**
 * §4.3 process-owned operations: the code paths that append the events the 4.3 timer rows arm on and are satisfied by
 * (the §4 overrides in ./timers.ts spell the patterns; src/kernel/events/match.ts compares payload fields exactly).
 *
 *  - logContact — the `contact.log` tool's write: resolves the loan's active `continuity_episodes` row, decides
 *    `by_assigned_personnel` from the record (the contact is by the assigned team when the actor is the team's AI first
 *    line or its named human, or the caller names an `assigned_personnel_id` on the team), completes the callback request
 *    it answers, and appends `contact.logged{live_contact, by_assigned_personnel}` — the event that satisfies
 *    REGX_1024_40A3_LIVE_RESPONSE_1BD ("`contact` with `live_contact=true` by assigned personnel"; 4.3-T4).
 *  - receiveInboundMessage — the ingestion handler for an inbound borrower message on the chat widget / secure
 *    message / voice line: validates the record, appends `chat.session.started` for the first message of a chat session
 *    (arms FNMA_A4_2_1_04_CHAT_5MIN: "chat session start → first response within 5 minutes") and, when the text asks for
 *    a foreclosure-prevention alternative ("any channel, no magic words" — rule 4), appends
 *    `lossmit.assistance.requested{state, s2924_15, channel}` (arms CA_CIV_2923_7_SPOC_ASSIGN_PROMPT for a CA §2924.15
 *    loan; 4.3-T7: 'a chat message "can I get help with my payments"').
 *  - sendChatResponse — appends `chat.first_response.sent` for the first response of a chat session (satisfies
 *    FNMA_A4_2_1_04_CHAT_5MIN) and `chat.response.sent` for every later one.
 *  - permanentAgreementEffective — the ingestion handler for the 12.x agreement record: only a *permanent* agreement
 *    opens the release gate (rule 3: "Trial-period payments do not count (the agreement must be *permanent*)"); appends
 *    `lossmit.permanent_agreement.effective` (arms REGX_1024_40A2_RELEASE_2_PERMANENT_PAYMENTS; 4.3-T6).
 */
import type { CommandContext } from "../../app/commands.ts";
import type { ToolInput, ToolRuntime } from "../../app/tools.ts";
import type { Actor, DomainEvent } from "../../kernel/events/index.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { caSpocRequest } from "./ops.ts";
import { caSpocDue } from "./continuity.ts";

const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isInstant = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const AI_FIRST_LINE = "borrower-comms";

// ---------------------------------------------------------------- contact log (REGX_1024_40A3_LIVE_RESPONSE_1BD)
export interface ContactLogged extends Record<string, unknown> {
  readonly id: string; readonly episode_id: string | null; readonly channel: string; readonly live_contact: boolean;
  /** The contact was made by the personnel assigned to the borrower (§1024.40(a)(3): "a live response from such personnel"). */
  readonly by_assigned_personnel: boolean;
  readonly assigned_personnel_id: string | null; readonly disclosure_given: boolean; readonly human_transfer_requested: boolean;
  readonly callback_request_id: string | null; readonly logged_at: string;
}
/** The loan's active continuity episode (status `assigned`), if any. */
export function activeEpisodeFor(rt: ToolRuntime, loanId: string, episodeId?: string): { id: string; data: Record<string, unknown> } | null {
  const id = episodeId || `ep-${loanId}`; const e = rt.store.get("continuity_episodes", id);
  return e && e.data.status === "assigned" ? { id, data: e.data } : null;
}
/**
 * Whether a contact is by the assigned personnel: an explicit `by_assigned_personnel` from the telephony adapter wins;
 * otherwise the AI first line of an `ai_first_named_human` team, the episode's named human, or a caller-named
 * `assigned_personnel_id` that is on the team.
 */
export function contactByAssignedPersonnel(episode: Record<string, unknown> | null, actor: Actor, d: Record<string, unknown>): boolean {
  if (typeof d.by_assigned_personnel === "boolean") return d.by_assigned_personnel;
  if (!episode) return false;
  const named = s(episode.named_human), team = s(episode.team_name), mode = s(episode.mode);
  const pid = s(d.assigned_personnel_id);
  if (pid) return pid === named || pid === team || pid === s(episode.team);
  if (actor.kind === "agent") return actor.id === AI_FIRST_LINE && mode === "ai_first_named_human";
  return !!named && (actor.id === named || s((actor as { name?: string }).name) === named);
}
/** The `contact.log` write: stores the `contacts` row and appends `contact.logged` with the conditioned fields. */
export function logContact(rt: ToolRuntime, ctx: CommandContext, i: ToolInput): { id: string; data: Record<string, unknown>; event: DomainEvent<ContactLogged> } {
  const d = (i.data as Record<string, unknown> | undefined) ?? {};
  const id = s(i.id) || `contact-${rt.store.list("contacts").length + 1}`;
  const ep = activeEpisodeFor(rt, ctx.loanId, s(i.episode_id) || s(d.episode_id));
  const byAssigned = contactByAssignedPersonnel(ep?.data ?? null, ctx.actor, d);
  const assignedId = s(d.assigned_personnel_id) || (byAssigned && ep ? (ctx.actor.kind === "agent" ? s(ep.data.team_name) || s(ep.data.team) : s(ep.data.named_human)) : "") || null;
  const cbId = s(d.callback_request_id) || null;
  const live = d.live_contact === true;
  const row = { ...d, episode_id: ep?.id ?? null, live_contact: live, by_assigned_personnel: byAssigned, assigned_personnel_id: assignedId, disclosure_given: d.disclosure_given === true, human_transfer_requested: d.human_transfer_requested === true, logged_at: ctx.now };
  const rec = rt.store.put("contacts", id, row, ctx.actor, ctx.now);
  if (cbId && live && byAssigned && rt.store.get("callback_requests", cbId)) rt.store.put("callback_requests", cbId, { completed_contact_id: id, completed_at: ctx.now }, ctx.actor, ctx.now);
  const payload: ContactLogged = { id, episode_id: ep?.id ?? null, channel: s(d.channel) || "voice", live_contact: live, by_assigned_personnel: byAssigned, assigned_personnel_id: assignedId, disclosure_given: d.disclosure_given === true, human_transfer_requested: d.human_transfer_requested === true, callback_request_id: cbId, logged_at: ctx.now, ...(d.note !== undefined ? { note: d.note } : {}), ...(d.purpose !== undefined ? { purpose: d.purpose } : {}) };
  const event = ctx.events.append<ContactLogged>({ type: "contact.logged", loanId: ctx.loanId, aggregate: { kind: "contacts", id }, actor: ctx.actor, payload });
  return { id, data: rec.data, event };
}

// ---------------------------------------------------------------- inbound messages (FNMA_A4_2_1_04_CHAT_5MIN / CA_CIV_2923_7_SPOC_ASSIGN_PROMPT)
export type InboundChannel = "chat" | "secure_message" | "voice" | "portal";
export interface InboundMessageRecord {
  readonly channel: InboundChannel;
  /** Chat/secure-message session the message belongs to (the FNMA_A4_2_1_04_CHAT_5MIN subject). */
  readonly session_id?: string;
  readonly text: string;
  /** ISO instant the widget/gateway received the message — the anchor of the 5-minute clock. */
  readonly received_at: string;
  /** Property state; `s2924_15` (first lien, owner-occupied principal residence, 1–4 units) is required for CA. */
  readonly state: string;
  readonly s2924_15?: boolean;
  readonly borrower_id?: string | null;
}
export interface ChatSessionStarted extends Record<string, unknown> { readonly session_id: string; readonly channel: InboundChannel; readonly started_at: string; readonly first_message_length: number; readonly first_response_due_at: string; }
export interface AssistanceRequested extends Record<string, unknown> {
  readonly state: string; readonly s2924_15: boolean; readonly channel: InboundChannel; readonly session_id: string | null; readonly text: string; readonly requested_on: PlainDate; readonly requested_at: string;
  /** CA §2924.15 loan: the human SPOC with a direct means of communication is due within 2 servicer BD (caSpocDue). */
  readonly ca_spoc_required: boolean; readonly ca_spoc_assign_by: PlainDate | null;
}
export const CHAT_FIRST_RESPONSE_MS = 5 * 60_000;
/** Problems with an inbound message record (empty when it can be ingested). */
export function validateInboundMessage(r: Partial<InboundMessageRecord>): string[] {
  const p: string[] = [];
  if (!r.channel || !["chat", "secure_message", "voice", "portal"].includes(r.channel)) p.push("channel must be chat | secure_message | voice | portal");
  if ((r.channel === "chat" || r.channel === "secure_message") && !r.session_id) p.push("session_id required for a chat / secure-message session");
  if (!r.text || !r.text.trim()) p.push("text required (an empty message is not an inquiry)");
  if (!isInstant(r.received_at)) p.push("received_at must be an ISO instant");
  if (!r.state || !/^[A-Z]{2}$/.test(r.state)) p.push("state must be a two-letter code");
  if (r.state === "CA" && typeof r.s2924_15 !== "boolean") p.push("s2924_15 must be stated for a California loan (Cal. Civ. Code §2923.7(f))");
  return p;
}
/**
 * Ingest an inbound borrower message: the first message of a chat session appends `chat.session.started` (arms
 * FNMA_A4_2_1_04_CHAT_5MIN); a request for a foreclosure-prevention alternative appends `lossmit.assistance.requested`
 * with `state` / `s2924_15` (arms CA_CIV_2923_7_SPOC_ASSIGN_PROMPT when CA and §2924.15).
 */
export function receiveInboundMessage(events: CommandContext["events"], loanId: string, r: InboundMessageRecord, actor: Actor): { session_started: DomainEvent<ChatSessionStarted> | null; assistance: DomainEvent<AssistanceRequested> | null; spoc_required: boolean; assign_by: PlainDate | null } {
  const problems = validateInboundMessage(r);
  if (problems.length) throw new RangeError(`inbound message rejected: ${problems.join("; ")}`);
  const receivedAt = new Date(Date.parse(r.received_at)).toISOString();
  const isChat = r.channel === "chat" || r.channel === "secure_message";
  const sessionId = r.session_id ?? null;
  const known = isChat && events.ofType("chat.session.started").some((e) => e.loanId === loanId && e.payload.session_id === sessionId);
  let session: DomainEvent<ChatSessionStarted> | null = null;
  if (isChat && !known) session = events.append<ChatSessionStarted>({ type: "chat.session.started", loanId, aggregate: { kind: "chat_session", id: sessionId! }, actor, occurredAt: receivedAt,
    payload: { session_id: sessionId!, channel: r.channel, started_at: receivedAt, first_message_length: r.text.length, first_response_due_at: new Date(Date.parse(receivedAt) + CHAT_FIRST_RESPONSE_MS).toISOString() } });
  const requestedOn = D(receivedAt.slice(0, 10));
  const q = caSpocRequest({ state: r.state, s2924_15: r.s2924_15 === true, text: r.text, requested_on: requestedOn, lossmit: { current: false, determination: null, appeal_pending: false } });
  let assistance: DomainEvent<AssistanceRequested> | null = null;
  if (q.assistance_requested) assistance = events.append<AssistanceRequested>({ type: "lossmit.assistance.requested", loanId, actor, occurredAt: receivedAt,
    payload: { state: r.state, s2924_15: r.s2924_15 === true, channel: r.channel, session_id: sessionId, text: r.text, requested_on: requestedOn, requested_at: receivedAt, ca_spoc_required: q.spoc_required, ca_spoc_assign_by: q.spoc_required ? caSpocDue(requestedOn) : null } });
  return { session_started: session, assistance, spoc_required: q.spoc_required, assign_by: q.assign_by };
}
export interface ChatResponseSent extends Record<string, unknown> { readonly session_id: string; readonly first: boolean; readonly responded_at: string; readonly response_seconds: number; readonly by: "ai_first_line" | "human"; readonly text_length: number; }
/** Record a response on a chat session: `chat.first_response.sent` for the first one (satisfies FNMA_A4_2_1_04_CHAT_5MIN), `chat.response.sent` after. */
export function sendChatResponse(events: CommandContext["events"], loanId: string, f: { session_id: string; text: string; sent_at: string }, actor: Actor): DomainEvent<ChatResponseSent> {
  if (!f.session_id) throw new RangeError("session_id required");
  if (!f.text || !f.text.trim()) throw new RangeError("a chat response needs text");
  if (!isInstant(f.sent_at)) throw new RangeError("sent_at must be an ISO instant");
  const start = events.ofType("chat.session.started").find((e) => e.loanId === loanId && e.payload.session_id === f.session_id);
  if (!start) throw new RangeError(`no chat session ${f.session_id} on ${loanId}`);
  const first = !events.ofType("chat.first_response.sent").some((e) => e.loanId === loanId && e.payload.session_id === f.session_id);
  const sentAt = new Date(Date.parse(f.sent_at)).toISOString();
  const payload: ChatResponseSent = { session_id: f.session_id, first, responded_at: sentAt, response_seconds: Math.round((Date.parse(sentAt) - Date.parse(start.occurredAt)) / 1000), by: actor.kind === "agent" ? "ai_first_line" : "human", text_length: f.text.length };
  return events.append<ChatResponseSent>({ type: first ? "chat.first_response.sent" : "chat.response.sent", loanId, aggregate: { kind: "chat_session", id: f.session_id }, actor, occurredAt: sentAt, payload });
}

// ---------------------------------------------------------------- permanent agreement (REGX_1024_40A2_RELEASE_2_PERMANENT_PAYMENTS)
export interface AgreementRecord {
  readonly agreement_id: string;
  /** Only `permanent` opens the release gate; a trial period plan or forbearance never does (rule 3; edge case "Disaster/forbearance"). */
  readonly kind: "permanent" | "trial" | "forbearance" | "repayment_plan";
  readonly effective_on: PlainDate;
  /** Day of month the modified payment is due (spec rule 3: "payments due the 1st"). */
  readonly payment_due_day?: number;
  /** Grace period before a late charge (spec rule 3: "a 15-day grace"). */
  readonly grace_days?: number;
}
export interface PermanentAgreementEffective extends Record<string, unknown> { readonly agreement_id: string; readonly kind: "permanent"; readonly effective_on: PlainDate; readonly payment_due_day: number; readonly grace_days: number; readonly episode_id: string | null; }
/** Problems with an agreement record for the continuity release gate (empty when it opens the gate). */
export function validateAgreement(r: Partial<AgreementRecord>): string[] {
  const p: string[] = [];
  if (!r.agreement_id) p.push("agreement_id required");
  if (r.kind !== "permanent") p.push(`only a permanent loss-mitigation agreement counts toward release (got ${r.kind ?? "nothing"}; §1024.40(a)(2) 'permanent loss mitigation agreement')`);
  if (!isDate(r.effective_on)) p.push("effective_on must be a PlainDate");
  if (r.payment_due_day !== undefined && !(Number.isInteger(r.payment_due_day) && r.payment_due_day >= 1 && r.payment_due_day <= 28)) p.push("payment_due_day must be 1–28");
  if (r.grace_days !== undefined && !(Number.isInteger(r.grace_days) && r.grace_days >= 0)) p.push("grace_days must be a non-negative integer");
  return p;
}
/** Ingest the effective permanent agreement: records it on the episode and appends `lossmit.permanent_agreement.effective`. */
export function permanentAgreementEffective(rt: ToolRuntime, ctx: CommandContext, r: AgreementRecord): DomainEvent<PermanentAgreementEffective> {
  const problems = validateAgreement(r);
  if (problems.length) throw new RangeError(`agreement rejected: ${problems.join("; ")}`);
  const ep = activeEpisodeFor(rt, ctx.loanId);
  if (ep) rt.store.put("continuity_episodes", ep.id, { permanent_agreement_id: r.agreement_id, permanent_agreement_effective_on: r.effective_on, consecutive_on_time_payments: 0 }, ctx.actor, ctx.now);
  const payload: PermanentAgreementEffective = { agreement_id: r.agreement_id, kind: "permanent", effective_on: r.effective_on, payment_due_day: r.payment_due_day ?? 1, grace_days: r.grace_days ?? 15, episode_id: ep?.id ?? null };
  return ctx.events.append<PermanentAgreementEffective>({ type: "lossmit.permanent_agreement.effective", loanId: ctx.loanId, ...(ep ? { aggregate: { kind: "continuity_episode", id: ep.id } } : {}), actor: ctx.actor, payload });
}
