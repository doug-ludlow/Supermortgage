/**
 * The video agent's HTTP layer (32.17; spec/sections/32-borrower-experience/32-17-the-video-agent-the-same-conversation-face-to-face.md):
 * the same conversation as 32.16, spoken by a Tavus replica — the vendor is the face and the voice, Supermortgage is the model, the
 * tools, the guard and the record. Mounted by one line in routes.ts `handle` (before its /v1/borrower prefix check).
 *
 *   POST /v1/borrower/video/sessions                       L1+ — opens a session: the guarded first turn (routes.ts firstTurn, run here when the
 *                                                          conversation has none yet) rendered as the greeting, the per-session bearer (32 random
 *                                                          bytes, base64url; the row keeps its sha-256), then 32.17 video.open on the bus: the persona
 *                                                          (custom LLM = this API's /v1/video/llm/{token}, perception off) and the conversation
 *                                                          (recording off, the call limits) at the vendor or the FAKE, video_sessions{created}
 *                                                          → { video_session_id, conversation_url, status, vendor, … }; a vendor outage → {status: failed}
 *                                                          with the copy library's line (video.unavailable) and the thread at /app
 *   GET  /v1/borrower/video/sessions/{id}                  the session's current row for the page (status, end_reason, conversation_url; never the token)
 *   POST /v1/borrower/video/sessions/{id}/end              the borrower leaves: 32.17 video.end (the conversation ended, the persona deleted, {ended})
 *   POST /v1/borrower/video/sessions/{id}/fake-callback    FAKE only: the FAKE page's join and leave → the same callback path the vendor's HTTP callback runs
 *   POST /v1/video/llm/{token}/chat/completions            the vendor's custom-LLM call, one per spoken borrower turn (an OpenAI chat-completions request,
 *                                                          `Authorization: Bearer {token}` and/or the path token): the token must match a session in
 *                                                          created | joined (else 401 before anything is written — T8); the last user message is the
 *                                                          utterance; it goes through BorrowerCommands.borrowerMessage with channel = video — the same
 *                                                          order as a typed message (a spoken affirmative reaches the turn; a flow reply; "human"; the
 *                                                          32.16 agent turn with its context, tools, guard and agent_turns row); the reply is rendered
 *                                                          (every {{copy:key}} and {{token}} filled through the copy library, a rates element spoken
 *                                                          with each rate's APR) and streamed as chat.completion.chunk events ending in [DONE]; then
 *                                                          32.17 video.turn records the turn on the bus
 *   POST /v1/video/tavus/callback/{secret}                 the vendor's callbacks (system.replica_joined, system.shutdown, application.transcription_ready);
 *                                                          a wrong secret is 404 and the attempt is logged; 32.17 video.callback applies the row change
 *
 * The transcript is Supermortgage's: the utterance is messages{channel=video, sender=borrower}, the reply messages{sender=agent} — the vendor's own
 * messages[] history is ignored except for its last user entry (rule 7; T13). Nothing is committed by speech: a proposal goes to the card's
 * props.proposal and the rail's Confirm resolves it (rule 3). The window, the tools and the guard are 32.16's, unchanged.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Runtime } from "../app.ts";
import type { Logger } from "../log.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { PgBorrowerUiRepository, MessageRow } from "../../infra/db/borrower-ui.ts";
import type { SessionRow } from "../../infra/db/borrower-sessions.ts";
import { toJson } from "../../infra/db/client.ts";
import { FakeTavus, TavusClient, type TavusCallback, type TavusPort } from "../../infra/integrations/tavus.ts";
import { currentVideoSession, sha256, videoSessionByToken, type VideoSessionRow } from "../../app/tools/section32-17.ts";
import { AgentToolRefused } from "../../app/tools/section32-16.ts";
import { BorrowerAuth, ipOf, sessionExpiry, userAgentOf, type BorrowerContext } from "./auth.ts";
import { BorrowerError, toBorrowerError } from "./errors.ts";
import { serialize, type ShapeName } from "./serialize.ts";
import { copyText } from "./channels.ts";
import type { BorrowerCommands } from "./commands.ts";
import type { BorrowerFlows } from "./flows/index.ts";
import type { BorrowerStreamHub } from "./stream.ts";
import type { AgentTurnRunner } from "./agent/turn.ts";

type P = Record<string, unknown>;
export const PROCESS_32_17 = "32.17";
export const VIDEO_LLM_PATH = /^\/v1\/video\/llm\/([A-Za-z0-9_-]+)\/chat\/completions$/;
export const VIDEO_CALLBACK_PATH = /^\/v1\/video\/tavus\/callback\/([^/]+)$/;
export const VIDEO_UNAVAILABLE_COPY = "video.unavailable";
export const CUSTOM_LLM_RESPONSE_MODEL = "supermortgage-turn";
const BORROWER_APP: Actor = { kind: "agent", id: "borrower-app" };
const RUN = { runId: "video:borrower-api", modelVersion: "borrower-app api (deterministic)", promptVersion: "32.17" } as const;
const MAX_BODY = 256 * 1024;
const MAX_UTTERANCE = 4000;

export interface VideoRoutesOptions {
  /** The vendor port; FakeTavus (FAKE) unless `tavusApiKey` is set. */
  readonly tavus?: TavusPort | undefined;
  readonly tavusApiKey?: string | undefined;
  readonly replicaId?: string | undefined;
  /** The secret path segment of the vendor's callback URL (VIDEO_CALLBACK_SECRET); random per process when unset (the FAKE's in-process callbacks still work). */
  readonly callbackSecret?: string | undefined;
  readonly borrowerCamera?: "on" | "off" | undefined;
  /** The public origin the vendor reaches this API on (VIDEO_API_URL); the request's own origin when unset. */
  readonly publicApiUrl?: string | undefined;
  readonly joinTimeoutS?: number | undefined;
}
export interface VideoRoutesDeps extends VideoRoutesOptions {
  readonly runtime: Runtime; readonly logger: Logger; readonly auth: BorrowerAuth; readonly ui: PgBorrowerUiRepository; readonly flows: BorrowerFlows; readonly commands: BorrowerCommands; readonly hub: BorrowerStreamHub;
  readonly agent: AgentTurnRunner | null;
  readonly partnerFor: (ctx: BorrowerContext) => Promise<{ legal_name: string; nmlsr_id: string }>;
  /** routes.ts `firstTurn`: the guarded first turn of an account session (no borrower text) — reused for the greeting, never duplicated. */
  readonly firstTurn: (req: IncomingMessage, opened: { session: SessionRow; party: { id: string }; token?: string }, at: string) => Promise<void>;
  readonly nonProduction: boolean;
  /** The app's public base (BORROWER_APP_URL): the FAKE's conversation_url is a page there. */
  readonly appBase: string;
}
export interface VideoRoutes {
  handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean>;
  readonly tavus: TavusPort;
  readonly callbackSecret: string;
  /** The vendor's callback applied (the HTTP route and the FAKE's in-process emit both land here). */
  applyCallback(body: TavusCallback): Promise<P>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new RangeError(`request body over ${MAX_BODY} bytes`); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
const jsonOf = (b: Buffer): P => { if (!b.length) return {}; const v = JSON.parse(b.toString("utf8")) as unknown; if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError("request body must be a JSON object"); return v as P; };
const same = (a: string, b: string): boolean => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bearerOf = (req: IncomingMessage): string => { const h = String(req.headers["authorization"] ?? ""); return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : ""; };

// ---------------------------------------------------------------- the spoken text (32.17 rule 2: tokens are filled before speech)
/** The last user entry of the vendor's messages[] — the utterance; the rest of the history is ignored (rule 7). */
export function utteranceOf(body: P): string {
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as P[]) : [];
  const last = [...messages].reverse().find((m) => m["role"] === "user");
  const content = last?.["content"];
  const text = typeof content === "string" ? content : Array.isArray(content) ? (content as P[]).map((part) => (typeof part["text"] === "string" ? part["text"] : "")).join(" ") : "";
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_UTTERANCE);
}
/** A message row as words: every `{{copy:key}}` rendered through the copy library with the tokens, deep-link paths dropped, no `{{` ever leaves. */
export function renderSpoken(bodyText: string | null, tokens: Readonly<Record<string, string>>): string {
  if (!bodyText) return "";
  let text = bodyText.replace(/\{\{copy:([a-z0-9_.]+)\}\}/g, (_all, key: string) => copyText(key, tokens));
  text = text.replace(/\/d\/[A-Za-z0-9_-]+/g, "");                                    // a spoken deep link means nothing (the rail is the confirm surface)
  text = text.replace(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g, (_all, k: string) => tokens[k] ?? "");   // any token left: filled, else dropped — never spoken raw
  return text.replace(/\*([^*\n]+)\*/g, "$1").replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;!?])/g, "$1").trim();
}
/** Reg Z §1026.24(c): a spoken rate carries its APR — the rates element (32.16 T7) as one sentence naming each rate with its APR, the lender and its NMLSR ID. */
export function spokenRatesElement(el: P): string {
  const pct = (v: unknown): string => `${String(v ?? "")} percent`;
  const lender = String(el["lender"] ?? "").trim(); const nmlsr = String(el["nmlsr_id"] ?? "").trim(); const product = String(el["product"] ?? "").trim();
  return `Today's published rates${lender ? ` from ${lender}` : ""}${nmlsr ? `, NMLS number ${nmlsr}` : ""}${product ? `, for a ${product}` : ""}: from ${pct(el["low_rate"])} with an APR of ${pct(el["low_apr"])}, up to ${pct(el["high_rate"])} with an APR of ${pct(el["high_apr"])}. Rates change daily and this is not a commitment to lend.`;
}
const isRatesElement = (m: MessageRow): boolean => m.sender === "system" && !m.body_text && (m.copy_tokens as P | null)?.["element"] === "rates";
/** Sentences for the stream: the whole guarded text is known before the first chunk (32.17 open question 1 — no partial, unguarded speech). */
export function sentencesOf(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)?.map((s) => s).filter((s) => s.trim()) ?? [];
  return parts.length ? parts : text ? [text] : [];
}

export function createVideoRoutes(deps: VideoRoutesDeps): VideoRoutes {
  const { runtime, logger, auth, ui, commands, hub, agent } = deps;
  const tavus: TavusPort = deps.tavus ?? (deps.tavusApiKey ? new TavusClient({ apiKey: deps.tavusApiKey, logger: (line) => logger.info("vendor", line) }) : new FakeTavus({ appBase: deps.appBase, logger: (line) => logger.info("vendor", line) }));
  const fake = tavus instanceof FakeTavus ? tavus : null;
  const vendorLabel = fake ? "FAKE" : tavus.vendorName;
  const callbackSecret = deps.callbackSecret || randomBytes(16).toString("hex");
  const borrowerCamera: "on" | "off" = deps.borrowerCamera ?? "on";
  // the tool handlers reach the vendor through the runtime's ports (src/app/tools/section32-17.ts portOf): the router wires the port it built unless the runtime already carries one
  if (!runtime.ports.tavus) (runtime.ports as { tavus?: TavusPort }).tavus = tavus;
  if (fake) fake.onCallback = (body) => applyCallback(body).then(() => undefined);
  logger.info("borrower.video.vendor", { vendor: vendorLabel, fake: !!fake, replica: deps.replicaId || (fake ? "FAKE" : "first stock replica [UNVERIFIED filter]"), callback_secret: deps.callbackSecret ? "configured" : "random per process", borrower_camera: borrowerCamera });
  if (!deps.callbackSecret && !fake) logger.warn("borrower.video.callback_secret_missing", { reason: "VIDEO_CALLBACK_SECRET is unset: the vendor's callbacks cannot authenticate (a random per-process secret is in use)" });

  const now = (): string => runtime.clock.now();
  const send = (res: ServerResponse, status: number, shape: ShapeName, body: unknown): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(toJson(serialize(shape, body))); };
  const publicOrigin = (req: IncomingMessage): string => {
    if (deps.publicApiUrl) return deps.publicApiUrl;
    const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]!.trim(); const host = String(req.headers["x-forwarded-host"] ?? req.headers["host"] ?? "localhost").split(",")[0]!.trim();
    return `${proto}://${host}`;
  };
  const subjectOf = (r: VideoSessionRow) => ({ application_id: r.subject_application_id, loan_id: r.subject_loan_id });
  const view = (r: VideoSessionRow, extra: P = {}): P => ({ video_session_id: r.video_session_id, status: r.status, vendor: r.vendor, conversation_url: r.conversation_url, end_reason: r.end_reason, transcript_ref: r.transcript_ref, created_at: r.created_at, joined_at: r.joined_at, ended_at: r.ended_at, subject: subjectOf(r), conversation_id: r.conversation_id, replica_id: r.replica_id, borrower_camera: borrowerCamera, ...(r.status === "failed" ? { fallback_copy_key: VIDEO_UNAVAILABLE_COPY } : {}), ...extra });
  const tokensFor = (ctx: BorrowerContext, partner: { legal_name: string; nmlsr_id: string }, extra: P | null = null): Record<string, string> => {
    const t: Record<string, string> = { "partner.legal_name": partner.legal_name || "your lender", "partner.nmlsr_id": partner.nmlsr_id || "", "party.first_name": ctx.party.legal_name.split(/\s+/)[0] ?? ctx.party.legal_name };
    for (const [k, v] of Object.entries(extra ?? {})) if (typeof v === "string" || typeof v === "number") t[k] = String(v);
    return t;
  };
  const execute = (name: string, row: { subject_application_id: string | null; subject_loan_id: string | null } | null, input: P) =>
    runtime.execute({ process: PROCESS_32_17, name, loanId: row?.subject_loan_id ?? "", ...(row?.subject_application_id ? { applicationId: row.subject_application_id } : {}), actor: BORROWER_APP, run: RUN, input });
  const notify = (r: VideoSessionRow, event_name: string, at: string): void => { hub.notify(r.party_id, { event_name, at, subject: subjectOf(r), ref: r.video_session_id }); };

  /** The guarded first turn's reply (routes.ts firstTurn appended it as the first agent_turn reply of the conversation), or null. */
  async function firstTurnReply(conversationId: string): Promise<MessageRow | null> {
    const rows = await ui.messagesAfter(conversationId, null, 500);
    return rows.find((m) => m.sender === "agent" && (m.copy_tokens as P | null)?.["source"] === "agent_turn") ?? null;
  }
  /** The party's own session row as the turn's context (the app session the video session was opened on; it must still be live). */
  async function contextOf(req: IncomingMessage, row: VideoSessionRow, at: string): Promise<BorrowerContext> {
    const session = await auth.sessions.get(row.session_id);
    if (!session || session.revoked_at || Date.parse(session.expires_at) <= Date.parse(at)) throw new BorrowerError(401, "SESSION_EXPIRED");
    const [party, subjects] = await Promise.all([auth.parties.get(session.party_id), auth.parties.subjectsOf(session.party_id)]);
    if (!party || party.id !== row.party_id) throw new BorrowerError(401, "AUTH_REQUIRED");
    const expiresAt = sessionExpiry(session.auth_method, subjects, at);
    await auth.sessions.touch(session.session_id, at, expiresAt);
    return { session: { ...session, last_seen_at: at, expires_at: expiresAt }, party, subjects, token: "", ip: ipOf(req), userAgent: userAgentOf(req) };
  }

  // ---------------------------------------------------------------- POST /v1/borrower/video/sessions
  async function open(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const conv = await ui.conversationFor(ctx.party.id); const subject = ctx.subjects[0] ?? null; const partner = await deps.partnerFor(ctx);
    // the greeting: the guarded first turn (32.16 §2.0) — run through routes.ts firstTurn when the conversation has none yet, then rendered; the disclosure line speaks first (20.3; Utah §13-2-12; Cal. §17941)
    await agent?.settle();
    let first = await firstTurnReply(conv.conversation_id);
    if (!first && agent) { await deps.firstTurn(req, { session: ctx.session, party: ctx.party, token: ctx.token }, at); await agent.settle(); await deps.flows.settle(); first = await firstTurnReply(conv.conversation_id); }
    const tokens = tokensFor(ctx, partner, (first?.copy_tokens as P | null) ?? null);
    const greeting = [copyText("entry.disclosure.first", tokens), first ? renderSpoken(first.body_text, tokens) : ""].filter(Boolean).join(" ").trim();
    // the per-session bearer (rule 6): 32 random bytes, base64url, in the persona's base_url; the row keeps its sha-256
    const token = randomBytes(32).toString("base64url"); const origin = publicOrigin(req); const video_session_id = randomUUID();
    const r = await execute("video.open", { subject_application_id: subject?.application_id ?? null, subject_loan_id: subject?.loan_id ?? null }, {
      video_session_id, party_id: ctx.party.id, session_id: ctx.session.session_id, conversation_id: conv.conversation_id, subject: { application_id: subject?.application_id ?? null, loan_id: subject?.loan_id ?? null },
      token, token_hash: sha256(token), base_url: `${origin}/v1/video/llm/${token}`, callback_url: `${origin}/v1/video/tavus/callback/${callbackSecret}`, greeting, first_name: tokens["party.first_name"], partner_name: partner.legal_name, ...(deps.replicaId ? { replica_id: deps.replicaId } : {}),
    });
    const row = await currentVideoSession(runtime.db, video_session_id);
    if (!row) throw new BorrowerError(500, "INTERNAL", undefined, "video.open wrote no row");
    notify(row, row.status === "failed" ? "video.session.failed" : "video.session.opened", at);
    logger.info("borrower.video.opened", { video_session_id, party_id: ctx.party.id, vendor: row.vendor, status: row.status, events: r.events.map((e) => e.type), greeting_chars: greeting.length });
    send(res, row.status === "failed" ? 503 : 201, "video_session", view(row, { greeting }));
  }
  async function status(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const row = await currentVideoSession(runtime.db, id);
    if (!row || row.party_id !== ctx.party.id) throw new BorrowerError(404, "NOT_FOUND");
    send(res, 200, "video_session", view(row));
  }
  async function end(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    const row = await currentVideoSession(runtime.db, id);
    if (!row || row.party_id !== ctx.party.id) throw new BorrowerError(404, "NOT_FOUND");
    const b = jsonOf(await readBody(req));
    const r = await execute("video.end", row, { video_session_id: id, party_id: ctx.party.id, ...(typeof b["reason"] === "string" ? { reason: String(b["reason"]).slice(0, 64) } : {}) });
    const after = (await currentVideoSession(runtime.db, id))!;
    if ((r.output as P)["outcome"] === "ended") notify(after, "video.session.ended", at);
    logger.info("borrower.video.ended", { video_session_id: id, party_id: ctx.party.id, outcome: (r.output as P)["outcome"], end_reason: after.end_reason });
    send(res, 200, "video_session", view(after));
  }
  /** FAKE only: the FAKE page's join and leave, through the FAKE's own emit → the same callback path the vendor's HTTP callback runs. */
  async function fakeCallback(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const at = now(); const ctx = await auth.authenticate(req, at);
    if (!fake) throw new BorrowerError(404, "NOT_FOUND");
    const row = await currentVideoSession(runtime.db, id);
    if (!row || row.party_id !== ctx.party.id || !row.vendor_conversation_id) throw new BorrowerError(404, "NOT_FOUND");
    const b = jsonOf(await readBody(req)); const event_type = typeof b["event_type"] === "string" ? b["event_type"] : "";
    if (!["system.replica_joined", "system.shutdown", "application.transcription_ready"].includes(event_type)) throw new RangeError("event_type must be a vendor callback type");
    const out = await applyCallback({ message_type: "system", event_type, conversation_id: row.vendor_conversation_id, properties: (b["properties"] as P | undefined) ?? {}, timestamp: at });
    send(res, 200, "video_callback", { received: true, vendor: "FAKE", event_type, ...out });
  }

  // ---------------------------------------------------------------- POST /v1/video/tavus/callback/{secret}
  async function applyCallback(body: TavusCallback): Promise<P> {
    const at = now();
    try {
      const r = await execute("video.callback", null, { event_type: body.event_type, conversation_id: body.conversation_id, properties: body.properties ?? {} });
      const out = r.output as P; const id = String(out["video_session_id"] ?? "");
      const row = await currentVideoSession(runtime.db, id);
      if (row && (out["outcome"] === "joined" || out["outcome"] === "ended")) notify(row, `video.session.${out["outcome"]}`, at);
      logger.info("borrower.video.callback", { vendor: vendorLabel, event_type: body.event_type, vendor_conversation_id: body.conversation_id, video_session_id: id || null, outcome: out["outcome"], status: out["status"] });
      return { outcome: out["outcome"], video_session_id: id || null, status: out["status"] ?? null };
    } catch (e) {
      const refused = e instanceof AgentToolRefused ? e.code : (e as { code?: string }).code;
      if (refused === "VIDEO_CONVERSATION_UNKNOWN") { logger.warn("borrower.video.callback.unknown_conversation", { vendor: vendorLabel, event_type: body.event_type, vendor_conversation_id: body.conversation_id }); return { outcome: "unknown_conversation", video_session_id: null, status: null }; }
      throw e;
    }
  }
  async function callback(req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> {
    if (!same(secret, callbackSecret)) { logger.warn("borrower.video.callback.refused", { reason: "wrong callback secret", ip: ipOf(req) }); send(res, 404, "error", new BorrowerError(404, "NOT_FOUND").body()); return; }
    const b = jsonOf(await readBody(req));
    const event_type = typeof b["event_type"] === "string" ? b["event_type"] : ""; const conversation_id = typeof b["conversation_id"] === "string" ? b["conversation_id"] : "";
    if (!event_type || !conversation_id) throw new RangeError("event_type and conversation_id are required");
    const out = await applyCallback({ message_type: typeof b["message_type"] === "string" ? b["message_type"] : "system", event_type, conversation_id, properties: (b["properties"] as P | undefined) ?? {} });
    send(res, 200, "video_callback", { received: true, vendor: vendorLabel, event_type, ...out });
  }

  // ---------------------------------------------------------------- POST /v1/video/llm/{token}/chat/completions
  const openAiError = (res: ServerResponse, status: number, message: string): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify({ error: { message, type: status === 401 ? "invalid_request_error" : "server_error", code: status } })); };
  async function chatCompletions(req: IncomingMessage, res: ServerResponse, pathToken: string): Promise<void> {
    const received = Date.now(); const at = now();
    // rule 6: the token in the path (the persona's base_url carries it) or, failing that, the bearer (the vendor sends the same token as api_key) must name one session in created | joined — refused before anything is written (T8). The app's proxy replaces the bearer with the app session on its way through, so the path form is the one the FAKE page relies on.
    const bearer = bearerOf(req);
    const row = (await videoSessionByToken(runtime.db, pathToken)) ?? (bearer ? await videoSessionByToken(runtime.db, bearer) : undefined);
    if (!row) { logger.warn("borrower.video.llm.refused", { reason: "no live session for the token" }); openAiError(res, 401, "unauthorized"); return; }
    let body: P; try { body = jsonOf(await readBody(req)); } catch (e) { openAiError(res, 400, e instanceof Error ? e.message : "bad request"); return; }
    let ctx: BorrowerContext;
    try { ctx = await contextOf(req, row, at); } catch { openAiError(res, 401, "unauthorized"); return; }
    const utterance = utteranceOf(body);
    const partner = await deps.partnerFor(ctx); const subject = ctx.subjects[0] ?? null;
    // the turn: the same path as POST /v1/borrower/messages, with channel = video (the utterance row, the affirmative → the turn, a flow reply, "human", the 32.16 agent turn)
    let messageId: string | null = null; let reply: (MessageRow & { copy_key?: string }) | null = null; let routed_to = subject?.stage === "servicing" ? "borrower-comms" : "intake"; let command: string | null = null; let fallback: string | null = null;
    if (utterance) {
      const r = await commands.borrowerMessage(ctx, { text: utterance, channel: "video", received_at_ms: received }, at);
      messageId = r.message.message_id; reply = r.reply; routed_to = r.routed_to; command = r.command;
      hub.notify(ctx.party.id, { event_name: "message.appended", at, subject: { application_id: r.message.subject_application_id, loan_id: r.message.subject_loan_id }, ref: r.message.message_id });
      if ((r.reply.copy_tokens as P | null)?.["source"] !== "agent_turn") hub.notify(ctx.party.id, { event_name: "message.appended", at, subject: { application_id: r.reply.subject_application_id, loan_id: r.reply.subject_loan_id }, ref: r.reply.message_id });
    } else if (agent) {
      // no user entry (the vendor's first call, or noise): the turn restates where things stand (no borrower text — the "borrower is back" situation)
      const t = await agent.run(ctx.party.id, { ctx, conversation_id: row.conversation_id, message_id: null, text: "", channel: "video", subject, routed_to: routed_to as "intake" | "borrower-comms", now: at, started_at_ms: received });
      if (t) reply = t.reply;
    }
    await deps.flows.settle();
    // the spoken text: a rates element the turn produced (each rate with its APR), then the reply with every copy line and token rendered — never a `{{`
    const tokens = tokensFor(ctx, partner, (reply?.copy_tokens as P | null) ?? null);
    const rows = messageId ? await ui.messagesAfter(row.conversation_id, messageId, 50) : [];
    const elements = rows.filter((m) => isRatesElement(m) && (!reply || m.message_id !== reply.message_id)).map((m) => spokenRatesElement(m.copy_tokens as P));
    const replyText = reply ? renderSpoken(reply.body_text, tokens) : "";
    if (reply && (reply.copy_tokens as P | null)?.["fallback"] === "default_copy") fallback = String((reply.copy_tokens as P)["rejected_by"] ?? "default_copy");
    const spoken = [...elements, replyText].filter(Boolean).join(" ").trim() || copyText(routed_to === "intake" ? "thread.assistant_placeholder.intake" : "thread.assistant_placeholder.servicing", tokens);
    // the stream: chat.completion.chunk events, the whole guarded text known before the first chunk, then [DONE]
    const id = `chatcmpl-${(reply?.copy_tokens as P | null)?.["turn_id"] ?? randomUUID()}`; const created = Math.floor(Date.parse(at) / 1000);
    const chunk = (delta: P, finish: string | null): string => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: CUSTOM_LLM_RESPONSE_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(chunk({ role: "assistant", content: "" }, null));
    for (const s of sentencesOf(spoken)) res.write(chunk({ content: s }, null));
    res.write(chunk({}, "stop"));
    const latency_ms = Date.now() - received;
    // the turn recorded on the bus (an agent_decisions row) before [DONE] closes the stream: the utterance, the reply, the 32.16 turn, the latency from receipt to the last chunk
    try {
      await execute("video.turn", row, { video_session_id: row.video_session_id, party_id: ctx.party.id, message_id: messageId, reply_message_id: reply?.message_id ?? null, turn_id: (reply?.copy_tokens as P | null)?.["turn_id"] ?? null, latency_ms, spoken_chars: spoken.length, fallback, routed_to, command });
    } catch (e) { logger.warn("borrower.video.turn.record_failed", { video_session_id: row.video_session_id, error: e instanceof Error ? e.message : String(e) }); }
    res.write("data: [DONE]\n\n"); res.end();
    logger.info("borrower.video.turn", { video_session_id: row.video_session_id, party_id: ctx.party.id, vendor: row.vendor, routed_to, message_id: messageId, reply_message_id: reply?.message_id ?? null, fallback, command, spoken_chars: spoken.length, latency_ms });
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith("/v1/video/") && !path.startsWith("/v1/borrower/video/")) return false;
    const started = Date.now();
    const log = (status: number, extra: P = {}): void => logger.info("http", { method, path: path.replace(VIDEO_LLM_PATH, "/v1/video/llm/{token}/chat/completions").replace(VIDEO_CALLBACK_PATH, "/v1/video/tavus/callback/{secret}"), status, ms: Date.now() - started, surface: "borrower", ...extra });
    try {
      let m: RegExpExecArray | null;
      if (method === "POST" && (m = VIDEO_LLM_PATH.exec(path))) { await chatCompletions(req, res, m[1]!); log(res.statusCode, { video_llm: true }); return true; }
      if (method === "POST" && (m = VIDEO_CALLBACK_PATH.exec(path))) await callback(req, res, decodeURIComponent(m[1]!));
      else if (method === "POST" && path === "/v1/borrower/video/sessions") await open(req, res);
      else if (method === "GET" && (m = /^\/v1\/borrower\/video\/sessions\/([^/]+)$/.exec(path))) await status(req, res, decodeURIComponent(m[1]!));
      else if (method === "POST" && (m = /^\/v1\/borrower\/video\/sessions\/([^/]+)\/end$/.exec(path))) await end(req, res, decodeURIComponent(m[1]!));
      else if (method === "POST" && (m = /^\/v1\/borrower\/video\/sessions\/([^/]+)\/fake-callback$/.exec(path))) await fakeCallback(req, res, decodeURIComponent(m[1]!));
      else { send(res, 404, "error", new BorrowerError(404, "NOT_FOUND").body()); log(404); return true; }
      log(res.statusCode);
    } catch (e) {
      const be = toBorrowerError(e);
      if (be.status >= 500) logger.error("borrower.video.unhandled", { method, path, error: e });
      if (!res.headersSent) send(res, be.status, "error", be.body()); else res.end();
      log(be.status, { code: be.code, reason: be.message });
    }
    return true;
  }
  return { handle, tavus, callbackSecret, applyCallback };
}
