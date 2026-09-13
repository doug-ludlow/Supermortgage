/**
 * §32.17 process-owned tools — the video agent (spec/sections/32-borrower-experience/32-17-the-video-agent-the-same-conversation-face-to-face.md
 * "AI agent design"), defined with `defineTools("32.17", "borrower-app", defs)` and spread by ./index.ts. The `borrower-app` agent
 * opens and ends the session and applies the vendor's callbacks; the turn itself is 32.16's (`intake` / `borrower-comms` with their
 * nine tools unchanged — src/runtime/borrower/agent/turn.ts runs it with `channel = video` from src/runtime/borrower/video-routes.ts).
 *
 *   video.open       creates the persona (custom LLM = the API's own chat-completions endpoint keyed per session; perception off) and
 *                    the conversation (recording off, the call limits of rule 8, the guarded first turn as the greeting, the first name
 *                    and the partner's name as the only context) at the vendor — FakeTavus (FAKE) unless TAVUS_API_KEY is set — and
 *                    writes video_sessions{status = created}; a vendor error writes {status = failed, end_reason = vendor_unavailable}
 *   video.turn       the chat-completions endpoint's command record: the token was checked (videoSessionByToken, before anything is
 *                    written — T8), the utterance appended, the 32.16 turn run with channel = video, the reply rendered and streamed
 *                    (the route does those, exactly as POST /v1/borrower/messages does; the turn is not a bus command, its tool calls are);
 *                    this tool refuses a session that is not live and records the turn (message, reply, agent_turns row, latency)
 *   video.end        ends the conversation and deletes the persona at the vendor; a new row {status = ended, end_reason}
 *   video.callback   applies a vendor callback to the row: system.replica_joined → joined; system.shutdown → ended{end_reason = the
 *                    vendor's reason}; application.transcription_ready → transcript_ref (a reference, never the record)
 *
 * Rows are append-only (0121): a status change is a new row keyed on video_session_id; the newest is current (v_video_sessions_current).
 * Every call writes an agent_decisions row (`decision`); the session events ride the event spine (video.session.opened / joined / ended
 * / failed) under aggregate video_session.
 */
import { createHash, randomUUID } from "node:crypto";
import { defineTools, compute, str, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { isUuid } from "../../infra/db/client.ts";
import { CALL_PROPERTIES, CUSTOM_LLM_MODEL, FakeTavus, pickReplica, type TavusConversationRequest, type TavusPersonaRequest, type TavusPort } from "../../infra/integrations/tavus.ts";
import { AgentToolRefused } from "./section32-16.ts";

export const PROCESS_32_17 = "32.17";
export const BORROWER_APP = "borrower-app";
type P = Record<string, unknown>;

export type VideoStatus = "created" | "joined" | "ended" | "failed";
export interface VideoSessionRow {
  readonly id: string; readonly video_session_id: string; readonly party_id: string; readonly session_id: string; readonly conversation_id: string;
  readonly subject_application_id: string | null; readonly subject_loan_id: string | null; readonly vendor: "tavus" | "FAKE";
  readonly vendor_conversation_id: string | null; readonly vendor_persona_id: string | null; readonly replica_id: string | null; readonly conversation_url: string | null;
  readonly token_hash: string; readonly status: VideoStatus; readonly end_reason: string | null; readonly transcript_ref: string | null;
  readonly created_at: string; readonly joined_at: string | null; readonly ended_at: string | null; readonly row_at: string;
}
const COLS = "id::text AS id, video_session_id, party_id, session_id, conversation_id, subject_application_id, subject_loan_id, vendor, vendor_conversation_id, vendor_persona_id, replica_id, conversation_url, token_hash, status, end_reason, transcript_ref, created_at, joined_at, ended_at, row_at";
const LIVE: ReadonlySet<string> = new Set(["created", "joined"]);
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const isLive = (row: VideoSessionRow | undefined): boolean => !!row && LIVE.has(row.status);

/** The current row (the newest) of a session. */
export async function currentVideoSession(db: Queryable, videoSessionId: string): Promise<VideoSessionRow | undefined> {
  if (!isUuid(videoSessionId)) return undefined;
  return (await db.query<VideoSessionRow & Record<string, unknown>>(`SELECT ${COLS} FROM v_video_sessions_current WHERE video_session_id = $1`, [videoSessionId]))[0];
}
/** 32.17 rule 6: the per-session bearer → its live session, or undefined (the route answers 401 before anything is written — T8). */
export async function videoSessionByToken(db: Queryable, token: string): Promise<VideoSessionRow | undefined> {
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
  const row = (await db.query<VideoSessionRow & Record<string, unknown>>(`SELECT ${COLS} FROM v_video_sessions_current WHERE token_hash = $1`, [sha256(token)]))[0];
  return row && isLive(row) ? row : undefined;
}
export async function videoSessionByVendorConversation(db: Queryable, vendorConversationId: string): Promise<VideoSessionRow | undefined> {
  if (!vendorConversationId) return undefined;
  return (await db.query<VideoSessionRow & Record<string, unknown>>(`SELECT ${COLS} FROM v_video_sessions_current WHERE vendor_conversation_id = $1`, [vendorConversationId]))[0];
}
export async function videoSessionsOf(db: Queryable, partyId: string): Promise<VideoSessionRow[]> {
  return db.query<VideoSessionRow & Record<string, unknown>>(`SELECT ${COLS} FROM v_video_sessions_current WHERE party_id = $1 ORDER BY id DESC`, [partyId]);
}
async function insertRow(q: Queryable, r: Omit<VideoSessionRow, "id" | "row_at">): Promise<void> {
  await q.query(`INSERT INTO video_sessions (video_session_id, party_id, session_id, conversation_id, subject_application_id, subject_loan_id, vendor, vendor_conversation_id, vendor_persona_id, replica_id, conversation_url, token_hash, status, end_reason, transcript_ref, created_at, joined_at, ended_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [r.video_session_id, r.party_id, r.session_id, r.conversation_id, r.subject_application_id, r.subject_loan_id, r.vendor, r.vendor_conversation_id, r.vendor_persona_id, r.replica_id, r.conversation_url, r.token_hash, r.status, r.end_reason, r.transcript_ref, r.created_at, r.joined_at, r.ended_at]);
}

// ---------------------------------------------------------------- the vendor bodies (32.17 rules 4, 5, 8; T1, T5, T7)
/** The persona: a one-line pointer as the system prompt (the real prompt is assembled per turn and never sent), the custom LLM keyed per session, perception off; no tools, no knowledge base. */
export function personaBodyFor(i: { readonly base_url: string; readonly token: string; readonly partner_name: string; readonly replica_id?: string | undefined }): TavusPersonaRequest {
  return {
    persona_name: `Supermortgage video agent for ${i.partner_name || "the lender"}`,
    system_prompt: "You are Supermortgage's automated assistant. Every sentence you speak comes from the connected language model; add nothing of your own.",
    ...(i.replica_id ? { default_replica_id: i.replica_id } : {}),
    layers: { llm: { model: CUSTOM_LLM_MODEL, base_url: i.base_url, api_key: i.token, speculative_inference: true }, perception: { perception_model: "off" } },
  };
}
/** The conversation: recording off, the call limits, the guarded first turn as the greeting, the first name and the partner's name as the only context. */
export function conversationBodyFor(i: { readonly persona_id: string; readonly replica_id: string; readonly callback_url: string; readonly greeting: string; readonly first_name: string; readonly partner_name: string }): TavusConversationRequest {
  return { persona_id: i.persona_id, replica_id: i.replica_id, callback_url: i.callback_url, custom_greeting: i.greeting, conversational_context: conversationalContext(i.first_name, i.partner_name), properties: { ...CALL_PROPERTIES } };
}
/** A provisional party name (an e-mail address, the phone placeholder — src/runtime/borrower/vendors/fake-stripe-identity.ts provisionalName) is not a first name: the vendor never gets it. */
export const firstNameForVendor = (name: string | null | undefined): string => { const first = (name ?? "").trim().split(/\s+/)[0] ?? ""; return !first || first.includes("@") || /^borrower$/i.test(first) || /\d/.test(first) ? "" : first; };
export const conversationalContext = (firstName: string, partnerName: string): string => `The borrower's first name is ${firstNameForVendor(firstName) || "not on file yet"}. The lender is ${partnerName || "the partner lender"}.`;

// ---------------------------------------------------------------- helpers
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const obj = (i: ToolInput, k: string): P => ((i[k] && typeof i[k] === "object" && !Array.isArray(i[k]) ? (i[k] as P) : {}));
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const defer = (rt: ToolRuntime, fn: (q: Queryable) => Promise<void>): void => { const d = rt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined; if (!d) throw new PortUnavailable("service:deferWrite"); d(fn); };
const portOf = (rt: ToolRuntime): TavusPort => { const p = rt.ports.tavus; if (!p) throw new PortUnavailable("tavus"); return p; };
const vendorOf = (port: TavusPort): "tavus" | "FAKE" => (port instanceof FakeTavus ? "FAKE" : "tavus");
const scopeOf = (r: { subject_application_id: string | null; subject_loan_id: string | null }) => ({ ...(r.subject_application_id ? { applicationId: r.subject_application_id } : {}), ...(r.subject_loan_id ? { loanId: r.subject_loan_id } : {}) });
const summary = (r: VideoSessionRow | Omit<VideoSessionRow, "id" | "row_at">): P => ({ video_session_id: r.video_session_id, party_id: r.party_id, session_id: r.session_id, conversation_id: r.conversation_id, subject_application_id: r.subject_application_id, subject_loan_id: r.subject_loan_id, vendor: r.vendor, vendor_conversation_id: r.vendor_conversation_id, vendor_persona_id: r.vendor_persona_id, replica_id: r.replica_id, conversation_url: r.conversation_url, status: r.status, end_reason: r.end_reason, transcript_ref: r.transcript_ref, created_at: r.created_at, joined_at: r.joined_at, ended_at: r.ended_at });

const decisionFor = (name: string) => (i: ToolInput, out: unknown, ctx: CommandContext) => {
  const o = out as P | null; const id = str(i, "video_session_id") || String(o?.["video_session_id"] ?? "");
  return { action: `video.${name.split(".")[1]}`, rationale: `32.17 ${name} video_session_id=${id || "-"} party_id=${str(i, "party_id") || String(o?.["party_id"] ?? "-")}${o && typeof o["outcome"] === "string" ? ` outcome=${o["outcome"]}` : ""}${o && typeof o["status"] === "string" ? ` status=${o["status"]}` : ""} by ${ctx.actor.kind}:${ctx.actor.id}`, subject: { kind: "video_session", id: id || "-" } };
};
type Def = Omit<ToolDef, "process" | "agent">;
const tool = (name: string, handler: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime) => unknown | Promise<unknown>, extra: Partial<Def> = {}): Def => ({ name, kind: "act", handler: compute(handler), decision: decisionFor(name), ...extra });

export const TOOLS_32_17: readonly ToolDef[] = defineTools(PROCESS_32_17, BORROWER_APP, [
  tool("video.open", async (i, ctx, rt) => {
    need(i, "party_id", "session_id", "conversation_id", "token_hash", "base_url", "callback_url");
    const party_id = str(i, "party_id"); if (!isUuid(party_id)) throw new RangeError("party_id must be the party's uuid");
    const video_session_id = str(i, "video_session_id") || randomUUID(); const subject = obj(i, "subject");
    const port = portOf(rt); const vendor = vendorOf(port);
    const base: Omit<VideoSessionRow, "id" | "row_at"> = { video_session_id, party_id, session_id: str(i, "session_id"), conversation_id: str(i, "conversation_id"), subject_application_id: (subject["application_id"] as string | null) ?? null, subject_loan_id: (subject["loan_id"] as string | null) ?? null, vendor, vendor_conversation_id: null, vendor_persona_id: null, replica_id: null, conversation_url: null, token_hash: str(i, "token_hash"), status: "created", end_reason: null, transcript_ref: null, created_at: ctx.now, joined_at: null, ended_at: null };
    let row = base; let error: string | null = null;
    try {
      // the vendor (or the FAKE): the replica, the persona with the custom LLM keyed on this session's token, the conversation with the guarded first turn as its greeting
      const replica_id = await pickReplica(port, str(i, "replica_id") || undefined);
      const persona = await port.createPersona(personaBodyFor({ base_url: str(i, "base_url"), token: str(i, "token") || "", partner_name: str(i, "partner_name"), replica_id }), { video_session_id });
      const conv = await port.createConversation(conversationBodyFor({ persona_id: persona.persona_id, replica_id, callback_url: str(i, "callback_url"), greeting: str(i, "greeting"), first_name: str(i, "first_name"), partner_name: str(i, "partner_name") }), { video_session_id });
      row = { ...base, replica_id, vendor_persona_id: persona.persona_id, vendor_conversation_id: conv.conversation_id, conversation_url: conv.conversation_url };
    } catch (e) {
      // 32.17 edge cases: the vendor is down at open → failed{vendor_unavailable}; the page offers the thread in the copy library's words
      error = e instanceof Error ? e.message : String(e);
      row = { ...base, status: "failed", end_reason: "vendor_unavailable", ended_at: ctx.now };
    }
    defer(rt, (q) => insertRow(q, row));
    ctx.events.append({ type: "video.session.opened", ...scopeOf(row), aggregate: { kind: "video_session", id: video_session_id }, actor: ctx.actor, payload: { video_session_id, vendor, party_id, session_id: row.session_id, conversation_id: row.conversation_id, status: row.status } });
    if (row.status === "failed") ctx.events.append({ type: "video.session.failed", ...scopeOf(row), aggregate: { kind: "video_session", id: video_session_id }, actor: ctx.actor, payload: { video_session_id, vendor, party_id, reason: "vendor_unavailable", error } });
    return { ...summary(row), outcome: row.status === "failed" ? "failed" : "opened", ...(error ? { error } : {}) };
  }),

  tool("video.turn", async (i, ctx, rt) => {
    need(i, "video_session_id", "party_id");
    const row = await currentVideoSession(dbOf(rt), str(i, "video_session_id"));
    if (!row || row.party_id !== str(i, "party_id")) throw new AgentToolRefused("VIDEO_SESSION_UNKNOWN", "no such video session for the party");
    if (!isLive(row)) throw new AgentToolRefused("VIDEO_SESSION_NOT_LIVE", `the video session is ${row.status}`);
    // the record of one spoken turn: the utterance row, the reply row, the 32.16 agent_turns row (channel = video), the latency from request receipt to the last chunk
    return { ...summary(row), outcome: "spoken", message_id: str(i, "message_id") || null, reply_message_id: str(i, "reply_message_id") || null, turn_id: str(i, "turn_id") || null, latency_ms: typeof i["latency_ms"] === "number" ? i["latency_ms"] : null, fallback: str(i, "fallback") || null, routed_to: str(i, "routed_to") || null, command: str(i, "command") || null, spoken_chars: typeof i["spoken_chars"] === "number" ? i["spoken_chars"] : null };
  }),

  tool("video.end", async (i, ctx, rt) => {
    need(i, "video_session_id", "party_id");
    const row = await currentVideoSession(dbOf(rt), str(i, "video_session_id"));
    if (!row || row.party_id !== str(i, "party_id")) throw new AgentToolRefused("VIDEO_SESSION_UNKNOWN", "no such video session for the party");
    if (!isLive(row)) return { ...summary(row), outcome: "already_ended" };
    const port = portOf(rt); const errors: string[] = [];
    if (row.vendor_conversation_id) await port.endConversation(row.vendor_conversation_id).catch((e) => errors.push(`end: ${e instanceof Error ? e.message : String(e)}`));
    if (row.vendor_persona_id) await port.deletePersona(row.vendor_persona_id).catch((e) => errors.push(`delete persona: ${e instanceof Error ? e.message : String(e)}`));
    const end_reason = str(i, "reason") || "borrower_left";
    const next: Omit<VideoSessionRow, "id" | "row_at"> = { ...row, status: "ended", end_reason, ended_at: ctx.now };
    defer(rt, (q) => insertRow(q, next));
    ctx.events.append({ type: "video.session.ended", ...scopeOf(row), aggregate: { kind: "video_session", id: row.video_session_id }, actor: ctx.actor, payload: { video_session_id: row.video_session_id, party_id: row.party_id, vendor: row.vendor, end_reason, by: "borrower" } });
    return { ...summary(next), outcome: "ended", ...(errors.length ? { vendor_errors: errors } : {}) };
  }),

  tool("video.callback", async (i, ctx, rt) => {
    need(i, "event_type", "conversation_id");
    const event_type = str(i, "event_type"); const props = obj(i, "properties");
    const row = await videoSessionByVendorConversation(dbOf(rt), str(i, "conversation_id"));
    if (!row) throw new AgentToolRefused("VIDEO_CONVERSATION_UNKNOWN", `no video session for vendor conversation ${str(i, "conversation_id")}`);
    const scope = scopeOf(row); const agg = { kind: "video_session", id: row.video_session_id };
    if (event_type === "system.replica_joined") {
      if (row.status !== "created") return { ...summary(row), event_type, outcome: "ignored", note: `the session is ${row.status}` };
      const next: Omit<VideoSessionRow, "id" | "row_at"> = { ...row, status: "joined", joined_at: ctx.now };
      defer(rt, (q) => insertRow(q, next));
      ctx.events.append({ type: "video.session.joined", ...scope, aggregate: agg, actor: ctx.actor, payload: { video_session_id: row.video_session_id, party_id: row.party_id, vendor: row.vendor } });
      return { ...summary(next), event_type, outcome: "joined" };
    }
    if (event_type === "system.shutdown") {
      if (!isLive(row)) return { ...summary(row), event_type, outcome: "ignored", note: `the session is ${row.status}` };
      const end_reason = String(props["shutdown_reason"] ?? props["reason"] ?? "shutdown");
      const port = rt.ports.tavus; if (port && row.vendor_persona_id) await port.deletePersona(row.vendor_persona_id).catch(() => undefined);
      const next: Omit<VideoSessionRow, "id" | "row_at"> = { ...row, status: "ended", end_reason, ended_at: ctx.now };
      defer(rt, (q) => insertRow(q, next));
      ctx.events.append({ type: "video.session.ended", ...scope, aggregate: agg, actor: ctx.actor, payload: { video_session_id: row.video_session_id, party_id: row.party_id, vendor: row.vendor, end_reason, by: "vendor" } });
      return { ...summary(next), event_type, outcome: "ended" };
    }
    if (event_type === "application.transcription_ready") {
      // the vendor's transcript is a reference on the row, never the record (32.17 "The transcript is Supermortgage's")
      const transcript_ref = String(props["transcript_url"] ?? props["transcript_ref"] ?? props["url"] ?? `${row.vendor}:transcript:${row.vendor_conversation_id ?? ""}`);
      const next: Omit<VideoSessionRow, "id" | "row_at"> = { ...row, transcript_ref };
      defer(rt, (q) => insertRow(q, next));
      return { ...summary(next), event_type, outcome: "transcript_ref_set" };
    }
    return { ...summary(row), event_type, outcome: "ignored", note: "an event type the session row does not carry" };
  }),
]);
