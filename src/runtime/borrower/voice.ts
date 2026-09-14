/**
 * The spoken turn (docs/ux/17 §2.4, §3.4, §3.6 — DELTA-27): an utterance through the speech front end (agent/speech.ts, FAKE in every
 * build stage) into the same turn loop as text, on channel `voice`. Two doors feed it: the in-app microphone
 *
 *   POST /v1/borrower/voice/utterance   { transcript | audio_base64, confidence?, subject? }   with the session bearer
 *                                       → { utterance, reply, attested, misses, spoken, routed_to, command_executed }
 *
 * and the phone line after L1 (src/runtime/borrower/channels.ts hands a live call's speech to `spoken`). The order of a spoken turn, in
 * front of the text order borrowerMessage keeps (affirmative → flow → "human" → the agent turn):
 *
 *   1. speech-to-text — the FAKE echoes the request's transcript and confidence; the utterance id is the platform's. Below
 *      STT_LOW_CONFIDENCE nothing is heard: no turn, no proposal; the utterance row is kept (`messages{voice_turn, copy_tokens.stt}`), the
 *      current card (`session.next`) counts a miss and the reply is the step's default copy; the third miss answers with the card's deep
 *      link (32.16-T20 — the SSN is typed, never heard).
 *   2. a read-back "yes" — a bare affirmative (nothing else in the utterance) that answers the assistant's LAST line, when that line read
 *      back a proposal on a ConfirmCard / ChoiceCard / ProfileCard: 32.1 `resolve_card_by_evidence{channel: voice, utterance_id,
 *      transcript_ref, read_back_copy_key}` resolves it (32.16-T17); the transition row carries `evidence.kind = voice_attestation` and the
 *      borrower as its actor; the turn then continues from the written card (32.17 rule 22). A "yes, but…" is not a yes: it is words.
 *   3. any other affirmative — a ConsentCard, a payment, anything in NOT_VOICE, a card without a read-back — answers with its deep link
 *      (`voiceConsentLink` for a consent, 32.16-T18); nothing resolves.
 *   4. everything else — borrowerMessage on channel `voice`: the flows, "human", the agent turn (which proposes and, on voice, never commits).
 *
 * The reply is spoken through the TTS FAKE (an audio reference; a deep link is never read aloud — the app shows it).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Runtime } from "../app.ts";
import type { Logger } from "../log.ts";
import { toJson } from "../../infra/db/client.ts";
import type { PgBorrowerUiRepository, CardInstanceRow, MessageRow } from "../../infra/db/borrower-ui.ts";
import type { Subject } from "../../infra/db/borrower-parties.ts";
import { sessionNextOf } from "../../app/tools/section32-16.ts";
import { voiceAttestable } from "../../app/tools/section32-1.ts";
import { BorrowerAuth, assertSubject, type BorrowerContext } from "./auth.ts";
import { affirmativeFor, isBareAffirmative, type BorrowerCommands } from "./commands.ts";
import { copyText } from "./channels.ts";
import { THREAD_COPY_KEYS } from "./copy-keys.ts";
import { BorrowerError, toBorrowerError } from "./errors.ts";
import type { BorrowerFlows } from "./flows/index.ts";
import type { BorrowerRecordReader } from "./record.ts";
import { serialize, type ShapeName } from "./serialize.ts";
import type { BorrowerStreamHub } from "./stream.ts";
import type { AgentTurnRunner } from "./agent/turn.ts";
import { FakeStt, FakeTts, STT_LOW_CONFIDENCE, LOW_CONFIDENCE_MISSES_TO_LINK, type SttPort, type TtsPort } from "./agent/speech.ts";

type P = Record<string, unknown>;
const MAX_BODY = 512 * 1024;   // an audio payload for a real adapter; the FAKE reads the transcript only

export interface VoiceRouteDeps {
  readonly runtime: Runtime; readonly logger: Logger; readonly auth: BorrowerAuth; readonly ui: PgBorrowerUiRepository; readonly reader: BorrowerRecordReader; readonly flows: BorrowerFlows; readonly commands: BorrowerCommands; readonly hub: BorrowerStreamHub;
  readonly agent: AgentTurnRunner | null;
  readonly partnerFor: (ctx: BorrowerContext) => Promise<{ legal_name: string; nmlsr_id: string }>;
  readonly stt?: SttPort | undefined; readonly tts?: TtsPort | undefined;
}
export interface SpokenInput { readonly transcript: string | null; readonly audio_base64?: string | null; readonly confidence?: number | null; readonly language?: string | null; readonly client_utterance_id?: string | null; readonly subject?: { application_id?: string | null; loan_id?: string | null } | null }
export type DeepLink = { token: string; path: string; expires_at: string };
export interface SpokenReply extends MessageRow { readonly copy_key: string; readonly deep_link: DeepLink | null }
export interface SpokenResult {
  readonly message: MessageRow; readonly reply: SpokenReply; readonly attested: P | null; readonly misses: number; readonly command_executed: boolean; readonly command: string | null; readonly routed_to: "intake" | "borrower-comms";
  readonly heard: { transcript: string; vendor: string; confidence: number; utterance_id: string; language: string; low_confidence: boolean; client_utterance_id: string | null };
  /** The reply as the speaker says it (copy lines rendered, no deep-link token) and the TTS FAKE's reference; null when the speaker failed (the reply still stands on the thread). */
  readonly spoken: { vendor: string; audio_ref: string; text: string } | null;
  readonly path: string;
}
export interface VoiceRoutes { utterance(req: IncomingMessage, res: ServerResponse): Promise<void>; spoken(ctx: BorrowerContext, i: SpokenInput, at: string): Promise<SpokenResult>; readonly stt: SttPort; readonly tts: TtsPort }

export function createVoiceRoutes(deps: VoiceRouteDeps): VoiceRoutes {
  const { runtime, logger, auth, ui, reader, commands, agent, hub } = deps;
  const stt: SttPort = deps.stt ?? new FakeStt(); const tts: TtsPort = deps.tts ?? new FakeTts();
  const now = (): string => runtime.clock.now();
  const send = (res: ServerResponse, status: number, shape: ShapeName, body: unknown): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(toJson(serialize(shape, body))); };
  // resolve_card_by_evidence is 32.1's (the intake agent's) tool; the servicing thread's agent runs it too (spec/registry/agents.json names the thread-owning agents)
  runtime.agents.registerTool("borrower-comms", "resolve_card_by_evidence");

  async function readBody(req: IncomingMessage): Promise<P> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new RangeError(`request body over ${MAX_BODY} bytes`); chunks.push(c as Buffer); }
    const b = Buffer.concat(chunks); if (!b.length) return {};
    const v = JSON.parse(b.toString("utf8")) as unknown; if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError("request body must be a JSON object"); return v as P;
  }
  /** The reply as the speaker says it: the copy lines rendered with the partner's tokens; a deep-link token is never spoken (the app shows the link). */
  const spokenText = (m: MessageRow, partner: { legal_name: string; nmlsr_id: string }): string => (m.body_text ?? "").replace(/\{\{copy:([a-z0-9_.]+)\}\}/g, (_all, k: string) => copyText(k, { "partner.legal_name": partner.legal_name, "partner.nmlsr_id": partner.nmlsr_id })).replace(/\s*\/d\/[A-Za-z0-9_-]+/g, "").trim();
  const out = (m: MessageRow, subject: Subject | null) => ({ ...m, subject: { application_id: m.subject_application_id ?? subject?.application_id ?? null, loan_id: m.subject_loan_id ?? subject?.loan_id ?? null }, delivery: { sent: true, delivered: true, read: m.sender === "borrower" }, sender_label: m.sender === "borrower" ? "You" : "Supermortgage" });
  const isConsent = (c: CardInstanceRow): boolean => c.kind === "ConsentCard" || c.command_ref === "consent.capture" || c.command_ref === "closing.captureEsignConsent";
  const placeholderOf = (routed_to: "intake" | "borrower-comms"): string => (routed_to === "intake" ? THREAD_COPY_KEYS.placeholderIntake : THREAD_COPY_KEYS.placeholderServicing);

  /** One spoken turn for a signed-in party: the STT, then steps 1–4 above; every path leaves the utterance row and a reply row on the thread. */
  async function spoken(ctx: BorrowerContext, i: SpokenInput, at: string): Promise<SpokenResult> {
    const started = Date.now();
    const wanted = i.subject ?? null;
    const subject: Subject | null = wanted && (wanted.application_id || wanted.loan_id) ? assertSubject(ctx, wanted) : (ctx.subjects[0] ?? null);
    const routed_to: "intake" | "borrower-comms" = subject?.stage === "servicing" ? "borrower-comms" : "intake";
    if (!(typeof i.transcript === "string" && i.transcript.trim()) && !(typeof i.audio_base64 === "string" && i.audio_base64)) throw new BorrowerError(400, "BAD_REQUEST", undefined, "transcript (or audio the adapter can decode) is required");
    // the utterance id is the platform's (the vendor's own rides on the STT result; a client's is kept beside it, never as the key)
    const heard0 = await stt.transcribe({ transcript: i.transcript ?? null, audio_base64: i.audio_base64 ?? null, confidence: i.confidence ?? null, utterance_id: null, language: i.language ?? null });
    const heard = { ...heard0, low_confidence: heard0.confidence < STT_LOW_CONFIDENCE, client_utterance_id: typeof i.client_utterance_id === "string" && i.client_utterance_id ? i.client_utterance_id.slice(0, 80) : null };
    const sttFacts: P = { vendor: heard.vendor, confidence: heard.confidence, utterance_id: heard.utterance_id, language: heard.language, low_confidence: heard.low_confidence, ...(heard.client_utterance_id ? { client_utterance_id: heard.client_utterance_id } : {}) };
    const conv = await ui.conversationFor(ctx.party.id);
    const partner = await deps.partnerFor(ctx);
    const cards = await ui.cardsOf(ctx.party.id); const pending = cards.filter((c) => c.status === "pending");
    const record = subject ? await reader.record(ctx.party, subject, cards, at) : null;
    const next = sessionNextOf(record, cards); const current = next.card_instance_id ? pending.find((c) => c.card_instance_id === next.card_instance_id) ?? null : null;
    const subjectIds = { subject_application_id: subject?.application_id ?? null, subject_loan_id: subject?.loan_id ?? null };
    const utteranceRow = async (text: string | null): Promise<MessageRow> => (await ui.message(await ui.appendMessage({ conversation_id: conv.conversation_id, at, sender: "borrower", sender_ref: `party:${ctx.party.id}`, channel: "voice", body_text: text, voice_turn: true, copy_tokens: { stt: sttFacts }, ...subjectIds })))!;
    const agentRow = async (copy_key: string, extra: P, card_instance_id: string | null, body = `{{copy:${copy_key}}}`): Promise<SpokenReply> => ({ ...(await ui.message(await ui.appendMessage({ conversation_id: conv.conversation_id, at, sender: "agent", sender_ref: `agent:${routed_to}`, channel: "voice", body_text: body, card_instance_id, voice_turn: true, copy_tokens: { source: "voice", ...extra }, ...subjectIds })))!, copy_key, deep_link: null });
    const deepLinkReply = async (card: CardInstanceRow, messageId: string, copy_key: string, extra: P): Promise<SpokenReply> => {
      const link = await ui.createDeepLink({ party_id: ctx.party.id, target: { card_instance_id: card.card_instance_id }, now: at, created_for_message_id: messageId });
      const r = await agentRow(copy_key, extra, card.card_instance_id, `{{copy:${copy_key}}} /d/${link.token}`);
      return { ...r, deep_link: { token: link.token, path: `/d/${link.token}`, expires_at: link.expires_at } };
    };
    const finish = async (r: { message: MessageRow; reply: SpokenReply; attested: P | null; misses: number; command_executed: boolean; command: string | null; path: string }): Promise<SpokenResult> => {
      await deps.flows.settle().catch((e) => logger.warn("borrower.voice.settle_failed", { party_id: ctx.party.id, error: e instanceof Error ? e.message : String(e) }));
      const text = spokenText(r.reply, partner);
      let spokenOut: SpokenResult["spoken"] = null;
      try { const s = await tts.speak(text); spokenOut = { vendor: s.vendor, audio_ref: s.audio_ref, text }; } catch (e) { logger.warn("borrower.voice.tts_failed", { party_id: ctx.party.id, vendor: tts.vendorName, error: e instanceof Error ? e.message : String(e) }); }
      hub.notify(ctx.party.id, { event_name: "message.appended", at, subject: { application_id: subjectIds.subject_application_id, loan_id: subjectIds.subject_loan_id }, ref: r.message.message_id });
      if ((r.reply.copy_tokens as P | null)?.["source"] !== "agent_turn") hub.notify(ctx.party.id, { event_name: "message.appended", at, subject: { application_id: subjectIds.subject_application_id, loan_id: subjectIds.subject_loan_id }, ref: r.reply.message_id });
      logger.info("borrower.voice.utterance", { party_id: ctx.party.id, routed_to, path: r.path, stt_vendor: heard.vendor, confidence: heard.confidence, low_confidence: heard.low_confidence, attested: r.attested?.["card_instance_id"] ?? null, misses: r.misses, reply_copy_key: r.reply.copy_key, deep_link: !!r.reply.deep_link, tts_vendor: spokenOut?.vendor ?? null, ms: Date.now() - started });
      return { ...r, routed_to, heard, spoken: spokenOut };
    };

    // ---- 1. not heard: the utterance is kept, the current card counts a miss, the step's default copy answers; the third miss is the deep link (no turn, no proposal)
    if (heard.low_confidence) {
      const message = await utteranceRow(heard.transcript || null);
      let misses = 0;
      if (current) misses = Number((await runtime.db.query<{ misses: number }>(`UPDATE card_instances SET misses = misses + 1 WHERE card_instance_id = $1 AND status = 'pending' RETURNING misses`, [current.card_instance_id]))[0]?.misses ?? 0);
      if (current && misses >= LOW_CONFIDENCE_MISSES_TO_LINK) return finish({ message, reply: await deepLinkReply(current, message.message_id, THREAD_COPY_KEYS.affirmativeNeedsCard, { stt: sttFacts, misses, reason: "low_confidence" }), attested: null, misses, command_executed: false, command: null, path: "low_confidence.deep_link" });
      return finish({ message, reply: await agentRow(current?.copy_key ?? placeholderOf(routed_to), { stt: sttFacts, misses, reason: "low_confidence" }, current?.card_instance_id ?? null), attested: null, misses, command_executed: false, command: null, path: "low_confidence.default_copy" });
    }

    const text = heard.transcript;
    // ---- 2. the read-back "yes": a bare affirmative answering the assistant's last line, when that line read back a proposal on a card the voice may attest
    const lastAgent = (await ui.messagesAfter(conv.conversation_id, null, 500)).filter((m) => m.sender === "agent" && (m.body_text ?? "") !== "").at(-1) ?? null;
    const readBack = lastAgent && (lastAgent.copy_tokens as P | null)?.["source"] === "agent_turn" && lastAgent.card_instance_id ? pending.find((c) => c.card_instance_id === lastAgent.card_instance_id) ?? null : null;
    const waiting = readBack && voiceAttestable(readBack) && isBareAffirmative(text) ? readBack : null;
    if (waiting) {
      const message = await utteranceRow(text);
      const transcript_ref = `conversation:${conv.conversation_id}#${message.message_id}`;
      try {
        await deps.flows.settle();
        const r = await runtime.execute({ process: "32.1", name: "resolve_card_by_evidence", loanId: waiting.subject_loan_id ?? subject?.loan_id ?? "", ...((waiting.subject_application_id ?? subject?.application_id) ? { applicationId: (waiting.subject_application_id ?? subject?.application_id)! } : {}), actor: { kind: "agent", id: routed_to },
          run: { runId: `voice:${heard.utterance_id}`, modelVersion: `speech ${stt.vendorName} (attestation)`, promptVersion: "32.16-voice" },
          input: { card_instance_id: waiting.card_instance_id, party_id: ctx.party.id, session_id: ctx.session.session_id, evidence: { channel: "voice", transcript_ref, utterance_id: heard.utterance_id, read_back_copy_key: waiting.copy_key, read_back_message_id: lastAgent!.message_id, spoken_text: text, stt_vendor: heard.vendor, stt_confidence: heard.confidence }, rationale: `32.16 §2.4 voice attestation: the borrower's spoken "${text.slice(0, 40)}" on the read-back of ${waiting.copy_key} (${heard.utterance_id})` } });
        const o = r.output as P;
        const attested: P = { card_instance_id: waiting.card_instance_id, kind: waiting.kind, copy_key: waiting.copy_key, status: String(o["status"] ?? "resolved"), manner: o["manner"] ?? "voice_attestation", utterance_id: heard.utterance_id, transcript_ref, read_back_message_id: lastAgent!.message_id, decision_id: r.decisionId ?? null };
        await deps.flows.settle();
        // 32.17 rule 22: the turn continues from the written card — acknowledges it and goes on to the current ask; without a turn the placeholder stands
        const t = agent ? await agent.run(ctx.party.id, { ctx, conversation_id: conv.conversation_id, message_id: message.message_id, text: "", channel: "voice", subject, routed_to, now: at, started_at_ms: started, continuation: { card_instance_id: waiting.card_instance_id, copy_key: waiting.copy_key, kind: waiting.kind, status: "resolved" } }) : null;
        const reply: SpokenReply = t ? { ...t.reply, copy_key: t.copy_key, deep_link: null } : await agentRow(placeholderOf(routed_to), { attested: waiting.card_instance_id }, waiting.card_instance_id);
        return finish({ message, reply, attested, misses: Number(waiting.misses ?? 0), command_executed: true, command: waiting.command_ref, path: "attestation" });
      } catch (e) {
        // the write refused (a required path, a gate, the AI path off): the card stays pending with the proposal; the deep link is the way out
        const be = toBorrowerError(e); logger.warn("borrower.voice.attestation_refused", { party_id: ctx.party.id, card_instance_id: waiting.card_instance_id, code: be.code, reason: be.message });
        return finish({ message, reply: await deepLinkReply(waiting, message.message_id, be.body().copy_key === "error.generic" ? THREAD_COPY_KEYS.affirmativeNeedsCard : be.body().copy_key, { stt: sttFacts, refused: be.code }), attested: null, misses: Number(waiting.misses ?? 0), command_executed: false, command: null, path: "attestation.refused" });
      }
    }
    // ---- 3. any other affirmative: a consent (read first — the safest reading of "I agree", 01 §3.5), the current ask, the rest — the deep link, nothing resolves
    const affirmed = affirmativeFor(text, [...pending.filter(isConsent), current, ...pending].filter((c): c is CardInstanceRow => !!c));
    if (affirmed) {
      const message = await utteranceRow(text); const consent = isConsent(affirmed);
      return finish({ message, reply: await deepLinkReply(affirmed, message.message_id, consent ? THREAD_COPY_KEYS.voiceConsentLink : THREAD_COPY_KEYS.affirmativeNeedsCard, { stt: sttFacts, reason: consent ? "consent_never_by_voice" : "needs_tap" }), attested: null, misses: Number(affirmed.misses ?? 0), command_executed: false, command: null, path: consent ? "affirmative.consent_link" : "affirmative.deep_link" });
    }
    // ---- 4. words: the text order on channel voice (a flow reply, "human", the agent turn — which proposes and never commits on voice); the STT facts ride as the API's, never the client's
    const r = await commands.borrowerMessage(ctx, { text, channel: "voice", ...(subject ? { subject: { application_id: subject.application_id, loan_id: subject.loan_id } } : {}) }, at, { stt: sttFacts });
    return finish({ message: r.message, reply: r.reply, attested: null, misses: Number(current?.misses ?? 0), command_executed: r.command_executed, command: r.command, path: "turn" });
  }

  async function utterance(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = now(); const started = Date.now();
    try {
      const ctx = await auth.authenticate(req, at);
      const b = await readBody(req);
      const r = await spoken(ctx, { transcript: typeof b["transcript"] === "string" ? (b["transcript"] as string) : null, audio_base64: typeof b["audio_base64"] === "string" ? (b["audio_base64"] as string) : null, confidence: typeof b["confidence"] === "number" ? (b["confidence"] as number) : null, language: typeof b["language"] === "string" ? (b["language"] as string) : null, client_utterance_id: typeof b["utterance_id"] === "string" ? (b["utterance_id"] as string) : null, subject: (b["subject"] as SpokenInput["subject"]) ?? null }, at);
      const subject = ctx.subjects.find((s) => s.application_id === r.message.subject_application_id || s.loan_id === r.message.subject_loan_id) ?? ctx.subjects[0] ?? null;
      send(res, 200, "voice_utterance", { utterance: { ...out(r.message, subject), transcript: r.heard.transcript, vendor: r.heard.vendor, confidence: r.heard.confidence, utterance_id: r.heard.utterance_id, language: r.heard.language, low_confidence: r.heard.low_confidence }, reply: { ...out(r.reply, subject), copy_key: r.reply.copy_key, deep_link: r.reply.deep_link }, attested: r.attested, misses: r.misses, spoken: r.spoken, routed_to: r.routed_to, command_executed: r.command_executed, command: r.command });
    } catch (e) {
      const be = toBorrowerError(e);
      if (be.status >= 500) logger.error("borrower.voice.unhandled", { error: e });
      send(res, be.status, "error", be.body());
      logger.info("http", { method: "POST", path: "/v1/borrower/voice/utterance", status: be.status, ms: Date.now() - started, surface: "borrower", code: be.code, reason: be.message });
    }
  }
  return { utterance, spoken, stt, tts };
}
