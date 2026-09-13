/**
 * Tavus — the video agent's face and voice (32.17 Integrations). The vendor renders a Conversational Video Interface replica in a
 * Daily room; Supermortgage stays the brain: the persona's language-model layer is a *custom LLM* whose base URL is the API's own
 * chat-completions endpoint keyed per video session (`POST /v1/video/llm/{token}/chat/completions`), perception is off, recording is
 * off, and the only context the vendor ever holds is the borrower's first name and the partner's name (32.17 rules 4 and 5, T7).
 *
 *   TavusPort     createPersona · createConversation · endConversation · deletePersona · listReplicas
 *   FakeTavus     FAKE: in memory; `conversation_url` is the app's own page (/app/video/fake/{video_session_token}) that posts each
 *                 utterance through the same chat-completions endpoint and triggers the same callbacks (system.replica_joined on
 *                 open, system.shutdown on leave) through `emit`, an in-process call the routes bind to the callback handler; every
 *                 body it was given is kept on `bodies` for the contract test (T7). The default in every build stage (32 README).
 *   TavusClient   the live vendor over HTTPS (x-api-key), retry ×3 with backoff on 5xx / network, idempotent per video_session_id
 *                 (a retry never creates two personas or two conversations). Selected only when TAVUS_API_KEY is set.
 *
 * [PARTIALLY VERIFIED — spec 32.17 "Verified requirement" and "Integrations": the persona `layers.llm` fields (`model`, `base_url`,
 * `api_key`, `speculative_inference`), `layers.perception.perception_model`, and the conversation body fields (`replica_id`,
 * `persona_id`, `callback_url`, `custom_greeting`, `conversational_context`, `properties.{max_call_duration, participant_left_timeout,
 * participant_absent_timeout, enable_recording, apply_greenscreen, language}`) are taken from the vendor's SDK and published examples;
 * the vendor's documentation was not reachable from the build container on 2026-09-12. No other field is sent.]
 */
import { randomUUID } from "node:crypto";

type P = Record<string, unknown>;
export const TAVUS_API_BASE = "https://tavusapi.com/v2";
/** 32.17 rule 8: the call's limits, sent verbatim on every conversation. */
export const CALL_PROPERTIES = { max_call_duration: 1800, participant_left_timeout: 60, participant_absent_timeout: 120, enable_recording: false, apply_greenscreen: false, language: "english" } as const;
/** The custom-LLM model name the persona names (the vendor forwards it on every chat-completions request; the endpoint ignores it). */
export const CUSTOM_LLM_MODEL = "supermortgage-turn";

export interface TavusPersonaRequest {
  readonly persona_name: string;
  /** 32.17 rule 4: a one-line pointer — the real prompt is assembled per turn by agent/context.ts and never sent to the vendor. */
  readonly system_prompt: string;
  readonly context?: string;
  readonly default_replica_id?: string;
  readonly layers: {
    readonly llm: { readonly model: string; readonly base_url: string; readonly api_key: string; readonly speculative_inference: boolean };
    readonly perception: { readonly perception_model: "off" };
  };
}
export interface TavusConversationRequest {
  readonly persona_id: string;
  readonly replica_id: string;
  readonly callback_url: string;
  /** The guarded first turn's rendered text (32.17 T5). */
  readonly custom_greeting: string;
  /** The borrower's first name and the partner's name — nothing else (32.17 T7). */
  readonly conversational_context: string;
  readonly properties: typeof CALL_PROPERTIES;
}
export interface TavusReplica { readonly replica_id: string; readonly replica_name?: string; readonly replica_type?: string; readonly status?: string }
/** The vendor's callbacks (unsigned JSON POSTs to callback_url; the URL's secret path segment authenticates). */
export interface TavusCallback { readonly event_type: "system.replica_joined" | "system.shutdown" | "application.transcription_ready" | string; readonly conversation_id: string; readonly properties?: P; readonly message_type?: string; readonly timestamp?: string }
/** Idempotency: the video session the call belongs to (kept on the row; a retry never creates two conversations). */
export interface TavusIdempotency { readonly video_session_id: string }

export interface TavusPort {
  readonly vendorName: string;
  createPersona(req: TavusPersonaRequest, idem: TavusIdempotency): Promise<{ persona_id: string }>;
  createConversation(req: TavusConversationRequest, idem: TavusIdempotency): Promise<{ conversation_id: string; conversation_url: string }>;
  endConversation(conversationId: string): Promise<void>;
  deletePersona(personaId: string): Promise<void>;
  listReplicas(): Promise<readonly TavusReplica[]>;
}

/** The video session token the persona's base_url carries (`…/v1/video/llm/{token}`). */
export const tokenOfBaseUrl = (baseUrl: string): string | null => { const m = /\/v1\/video\/llm\/([A-Za-z0-9_-]+)\/?$/.exec(baseUrl); return m ? m[1]! : null; };

// ---------------------------------------------------------------- the FAKE
export interface FakeTavusOptions { readonly appBase: string; readonly logger?: ((line: Record<string, unknown>) => void) | undefined }
export interface FakeTavusBody { readonly at: string; readonly op: "createPersona" | "createConversation" | "endConversation" | "deletePersona" | "listReplicas"; readonly video_session_id: string | null; readonly body: P }
export class FakeTavus implements TavusPort {
  readonly vendorName = "tavus";
  readonly marker = "FAKE" as const;
  /** Every body handed to the vendor, in order (the T7 contract test reads it). */
  readonly bodies: FakeTavusBody[] = [];
  readonly personas = new Map<string, { request: TavusPersonaRequest; video_session_id: string; token: string | null; deleted: boolean }>();
  readonly conversations = new Map<string, { request: TavusConversationRequest; video_session_id: string; conversation_url: string; ended: boolean; token: string | null }>();
  /** The in-process callback the routes bind (the same handler the vendor's HTTP callback runs): `emit` calls it. */
  onCallback: ((body: TavusCallback) => Promise<void>) | null = null;
  private readonly byIdem = new Map<string, { persona_id?: string; conversation_id?: string }>();
  private readonly appBase: string;
  private readonly logger: (line: Record<string, unknown>) => void;
  constructor(o: FakeTavusOptions) { this.appBase = o.appBase.replace(/\/$/, ""); this.logger = o.logger ?? (() => undefined); }
  private note(op: FakeTavusBody["op"], video_session_id: string | null, body: P): void { const line = { at: new Date().toISOString(), op, video_session_id, body }; this.bodies.push(line); this.logger({ msg: "tavus", vendor: this.marker, op, video_session_id }); }

  async createPersona(req: TavusPersonaRequest, idem: TavusIdempotency): Promise<{ persona_id: string }> {
    this.note("createPersona", idem.video_session_id, req as unknown as P);
    const prior = this.byIdem.get(idem.video_session_id)?.persona_id; if (prior) return { persona_id: prior };
    const persona_id = `p_FAKE_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.personas.set(persona_id, { request: req, video_session_id: idem.video_session_id, token: tokenOfBaseUrl(req.layers.llm.base_url), deleted: false });
    this.byIdem.set(idem.video_session_id, { ...(this.byIdem.get(idem.video_session_id) ?? {}), persona_id });
    return { persona_id };
  }
  async createConversation(req: TavusConversationRequest, idem: TavusIdempotency): Promise<{ conversation_id: string; conversation_url: string }> {
    this.note("createConversation", idem.video_session_id, req as unknown as P);
    const prior = this.byIdem.get(idem.video_session_id)?.conversation_id; if (prior) return { conversation_id: prior, conversation_url: this.conversations.get(prior)!.conversation_url };
    const persona = this.personas.get(req.persona_id); if (!persona || persona.deleted) throw new Error(`FAKE tavus: no persona ${req.persona_id}`);
    const conversation_id = `c_FAKE_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    // the FAKE page: the app's own route, keyed on the same per-session token the persona's base_url carries — the page posts each utterance through the same endpoint the vendor would
    const conversation_url = `${this.appBase}/app/video/fake/${persona.token ?? "no-token"}?vs=${encodeURIComponent(idem.video_session_id)}`;
    this.conversations.set(conversation_id, { request: req, video_session_id: idem.video_session_id, conversation_url, ended: false, token: persona.token });
    this.byIdem.set(idem.video_session_id, { ...(this.byIdem.get(idem.video_session_id) ?? {}), conversation_id });
    return { conversation_id, conversation_url };
  }
  async endConversation(conversationId: string): Promise<void> {
    this.note("endConversation", this.conversations.get(conversationId)?.video_session_id ?? null, { conversation_id: conversationId });
    const c = this.conversations.get(conversationId); if (!c) return; c.ended = true;
  }
  async deletePersona(personaId: string): Promise<void> {
    this.note("deletePersona", this.personas.get(personaId)?.video_session_id ?? null, { persona_id: personaId });
    const p = this.personas.get(personaId); if (p) p.deleted = true;
  }
  async listReplicas(): Promise<readonly TavusReplica[]> { this.note("listReplicas", null, {}); return [{ replica_id: "r_FAKE_stock", replica_name: "FAKE stock replica", replica_type: "system", status: "completed" }]; }

  /** The vendor's callback, in process: the FAKE page's join and leave (and a test) call this; the routes bound `onCallback` to the same handler the HTTP path runs. */
  async emit(conversationId: string, event_type: TavusCallback["event_type"], properties: P = {}): Promise<void> {
    if (!this.onCallback) throw new Error("FAKE tavus: no callback handler bound (createVideoRoutes binds one)");
    await this.onCallback({ message_type: "system", event_type, conversation_id: conversationId, properties, timestamp: new Date().toISOString() });
  }
  /** The conversation the FAKE page is on, by the token in its URL. */
  conversationByToken(token: string): { conversation_id: string; video_session_id: string; ended: boolean } | undefined {
    for (const [conversation_id, c] of this.conversations) if (c.token === token) return { conversation_id, video_session_id: c.video_session_id, ended: c.ended };
    return undefined;
  }
}

// ---------------------------------------------------------------- the live client
export interface TavusClientOptions { readonly apiKey: string; readonly baseUrl?: string | undefined; readonly fetch?: typeof fetch | undefined; readonly retries?: number | undefined; readonly backoffMs?: number | undefined; readonly logger?: ((line: Record<string, unknown>) => void) | undefined }
export class TavusVendorError extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.name = "TavusVendorError"; this.status = status; } }
export class TavusClient implements TavusPort {
  readonly vendorName = "tavus";
  private readonly o: { apiKey: string; baseUrl: string; retries: number; backoffMs: number; fetch: typeof fetch; logger: (line: Record<string, unknown>) => void };
  private readonly byIdem = new Map<string, { persona_id?: string; conversation_id?: string; conversation_url?: string }>();
  constructor(o: TavusClientOptions) { this.o = { apiKey: o.apiKey, baseUrl: (o.baseUrl ?? TAVUS_API_BASE).replace(/\/$/, ""), fetch: o.fetch ?? globalThis.fetch, retries: o.retries ?? 3, backoffMs: o.backoffMs ?? 250, logger: o.logger ?? (() => undefined) }; }

  private async call<T>(method: string, path: string, body?: P): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.o.retries; attempt++) {
      try {
        const r = await this.o.fetch(`${this.o.baseUrl}${path}`, { method, headers: { "x-api-key": this.o.apiKey, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (r.status >= 500) { lastError = new TavusVendorError(r.status, `tavus ${method} ${path}: ${r.status}`); }
        else if (!r.ok) { throw new TavusVendorError(r.status, `tavus ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`); }
        else { const text = await r.text(); return (text ? JSON.parse(text) : {}) as T; }
      } catch (e) {
        if (e instanceof TavusVendorError && e.status < 500) throw e;
        lastError = e instanceof Error ? e : new Error(String(e));
      }
      this.o.logger({ msg: "tavus.retry", attempt, path, error: lastError?.message });
      if (attempt < this.o.retries) await new Promise((res) => setTimeout(res, this.o.backoffMs * 2 ** (attempt - 1)));
    }
    throw lastError ?? new TavusVendorError(503, `tavus ${method} ${path}: unavailable`);
  }
  async createPersona(req: TavusPersonaRequest, idem: TavusIdempotency): Promise<{ persona_id: string }> {
    const prior = this.byIdem.get(idem.video_session_id)?.persona_id; if (prior) return { persona_id: prior };
    const r = await this.call<{ persona_id: string }>("POST", "/personas", req as unknown as P);
    this.byIdem.set(idem.video_session_id, { ...(this.byIdem.get(idem.video_session_id) ?? {}), persona_id: r.persona_id });
    return { persona_id: r.persona_id };
  }
  async createConversation(req: TavusConversationRequest, idem: TavusIdempotency): Promise<{ conversation_id: string; conversation_url: string }> {
    const prior = this.byIdem.get(idem.video_session_id); if (prior?.conversation_id && prior.conversation_url) return { conversation_id: prior.conversation_id, conversation_url: prior.conversation_url };
    const r = await this.call<{ conversation_id: string; conversation_url: string }>("POST", "/conversations", req as unknown as P);
    this.byIdem.set(idem.video_session_id, { ...(prior ?? {}), conversation_id: r.conversation_id, conversation_url: r.conversation_url });
    return { conversation_id: r.conversation_id, conversation_url: r.conversation_url };
  }
  async endConversation(conversationId: string): Promise<void> { await this.call("POST", `/conversations/${encodeURIComponent(conversationId)}/end`); }
  async deletePersona(personaId: string): Promise<void> { await this.call("DELETE", `/personas/${encodeURIComponent(personaId)}`); }
  /** [UNVERIFIED — the stock-replica listing filter: the first replica whose type reads as stock/system is picked when TAVUS_REPLICA_ID is unset] */
  async listReplicas(): Promise<readonly TavusReplica[]> { const r = await this.call<{ data?: TavusReplica[] } | TavusReplica[]>("GET", "/replicas"); return Array.isArray(r) ? r : (r.data ?? []); }
}

/** The replica for a session: the configured one, else the first stock/system replica the vendor lists [UNVERIFIED filter], else the first listed. */
export async function pickReplica(port: TavusPort, configured: string | undefined): Promise<string> {
  if (configured) return configured;
  const all = await port.listReplicas();
  const stock = all.find((r) => /stock|system/i.test(String(r.replica_type ?? r.replica_name ?? ""))) ?? all[0];
  if (!stock) throw new TavusVendorError(503, "tavus: no replica available (set TAVUS_REPLICA_ID)");
  return stock.replica_id;
}
