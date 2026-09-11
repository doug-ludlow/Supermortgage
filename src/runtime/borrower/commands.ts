/**
 * The command half of the borrower API (docs/ux/02-data-contracts.md §2, §7; 01 §3, §5, §6.4; 13 T-X-05):
 *
 *   resolveCard      POST /v1/borrower/cards/{id}/resolve — the ONLY way a borrower commits anything. Idempotency key =
 *                    card_instance_id (a resolved card answers its stored outcome again; a concurrent second tap waits
 *                    on the card's advisory lock and then sees it resolved). The evidence is persisted to card_instances
 *                    (+ card_instance_events) and ui_events{card_resolved}; then the card's mapped 32.2 command runs on the
 *                    bus as the `borrower-app` agent. A refusal leaves the card pending and answers {code, gate, copy_key}.
 *                    A ConsentCard never resolves from a voice channel (01 §3.5).
 *   runCommand       POST /v1/borrower/commands/{name} — a direct command not tied to a card (human.request, refi.request,
 *                    case.open, …): the same bus path with the same scoping and the same facts.
 *   borrowerMessage  POST /v1/borrower/messages — the borrower's text lands in `messages`; a text matching a pending
 *                    card's affirmative ("yes proceed", "lock it", "I agree") executes NO command and is answered with the
 *                    card's deep link (T-X-05; 01 §6.4 "tap to confirm so it counts"); "human" routes to human.request;
 *                    anything else gets the assistant's placeholder reply from the copy library (the agent turn is later),
 *                    routed to `intake` before funding and `borrower-comms` after.
 *
 * Facts only the API knows ride into the command input: `party_id`, `fresh_l1` (01 §5: money movement needs a code within
 * 10 minutes — checked here first, never client-asserted), `assurance_level`, the party's own application_borrower row,
 * and the E-SIGN consent state for a receipt. The client's body can never set them.
 */
import { randomUUID } from "node:crypto";
import type { Runtime } from "../app.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { Db } from "../../infra/db/client.ts";
import { isUuid, toJson } from "../../infra/db/client.ts";
import { PgBorrowerUiRepository, type CardInstanceRow, type MessageRow } from "../../infra/db/borrower-ui.ts";
import type { Subject } from "../../infra/db/borrower-parties.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { TOOLS_32_2 } from "../../app/tools/section32-2.ts";
import { commandInputFor } from "../../app/tools/section32-1.ts";
import { assertSubject, hasFreshL1, requireFreshL1, type BorrowerContext } from "./auth.ts";
import { BorrowerError } from "./errors.ts";
import { THREAD_COPY_KEYS } from "./copy-keys.ts";

export const BORROWER_APP_ACTOR: Actor = { kind: "agent", id: "borrower-app" };
export const COMMAND_NAMES: ReadonlySet<string> = new Set(TOOLS_32_2.map((t) => t.name));
/** 32.2 guardrails: the money-field commands — a fresh L1 code first, never an agent-side waiver. */
export const FRESH_L1_COMMANDS: ReadonlySet<string> = new Set(["payment.makeOneTime", "payment.extraPrincipal", "autodraft.enroll", "autodraft.change", "autodraft.pause", "autodraft.revoke", "escrow.electShortage", "party.updateContact"]);
const LEVEL_REQUIRED: Readonly<Record<string, (args: Record<string, unknown>) => "L1" | "L2" | "L3">> = { "credit.authorize": (a) => (a["kind"] === "hard_pull" ? "L3" : "L2"), "party.startIdentity": () => "L1" };
const RANK = { L1: 1, L2: 2, L3: 3 } as const;
/** 01 §6.4 / T-X-05: a borrower message that answers a pending card. Card props may carry their own `affirmatives`. */
export const DEFAULT_AFFIRMATIVES = ["yes proceed", "proceed", "lock it", "lock", "i agree", "agree", "agreed", "confirm", "confirmed", "accept", "accepted", "yes", "yep", "yeah", "ok", "okay", "sounds good", "go ahead", "do it", "let's do it", "sign me up", "approve", "i consent", "consent", "sure"];
const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
export function affirmativeFor(text: string, cards: readonly CardInstanceRow[]): CardInstanceRow | undefined {
  const t = normalize(text); if (!t || t.length > 80) return undefined;
  for (const c of cards) {
    if (c.status !== "pending") continue;
    const own = Array.isArray(c.props["affirmatives"]) ? (c.props["affirmatives"] as unknown[]).map((x) => normalize(String(x))) : [];
    const optionLabels = Array.isArray(c.props["options"]) ? (c.props["options"] as { label?: unknown; id?: unknown }[]).flatMap((o) => [o.label, o.id].filter((x) => typeof x === "string").map((x) => normalize(x as string))) : [];
    const phrases = [...own, ...optionLabels, ...DEFAULT_AFFIRMATIVES];
    if (phrases.some((p) => p && (t === p || t === `${p} please` || t === `${p} thanks` || (p.length > 3 && (t.startsWith(`${p} `) || t.endsWith(` ${p}`) || t.includes(` ${p} `)))))) return c;
  }
  return undefined;
}

export interface CommandOutcome { readonly command: string; readonly subject: { application_id: string | null; loan_id: string | null }; readonly result: unknown; readonly events: string[]; readonly decision_id: string | null }

export class BorrowerCommands {
  private readonly runtime: Runtime; private readonly db: Db; private readonly ui: PgBorrowerUiRepository;
  constructor(runtime: Runtime, ui: PgBorrowerUiRepository) { this.runtime = runtime; this.db = runtime.db; this.ui = ui; }

  /** The subject a command runs on: the body's / card's subject when given (scoped), else the party's first subject. */
  subjectFor(ctx: BorrowerContext, wanted: { application_id?: string | null; loan_id?: string | null } | null): Subject {
    if (wanted && (wanted.application_id || wanted.loan_id)) return assertSubject(ctx, wanted);
    const s = ctx.subjects[0]; if (!s) throw new BorrowerError(409, "SUBJECT_REQUIRED", undefined, "the party has no application or loan yet");
    return s;
  }

  /** The API's facts on the input (never the client's): party, fresh L1, level, the own application_borrower row, the E-SIGN state, the lock/quote facts. */
  private async enrich(ctx: BorrowerContext, name: string, subject: Subject, args: Record<string, unknown>, now: string): Promise<Record<string, unknown>> {
    const input: Record<string, unknown> = { ...args, party_id: ctx.party.id, assurance_level: ctx.session.level, fresh_l1: hasFreshL1(ctx.session, now), ...(subject.application_id ? { application_id: subject.application_id } : {}), ...(subject.loan_id ? { loan_id: subject.loan_id } : {}) };
    if (FRESH_L1_COMMANDS.has(name)) requireFreshL1(ctx.session, now);
    const need = LEVEL_REQUIRED[name]?.(args); if (need && RANK[ctx.session.level] < RANK[need]) throw new BorrowerError(403, "LEVEL_REQUIRED", undefined, `${need} required; session is ${ctx.session.level}`);
    if (subject.application_borrower_id) {
      // the party's OWN borrower as the interview knows it (never the client's claim): the default subject of a borrower-scoped command, and the fact the own-party guardrails compare against
      const own = await this.intakeBorrowerId(subject); input["own_borrower_id"] = own;
      if (input["borrower_id"] === undefined && ["application.answerDemographics", "application.affirmJointIntent", "application.confirmField", "verification.connect", "document.upload", "explanation.submit"].includes(name)) input["borrower_id"] = own;
      if (input["consumer_id"] === undefined && ["disclosure.acknowledgeReceipt", "rescission.exercise"].includes(name)) input["consumer_id"] = own;
      if (!input["application_borrower_id"]) input["application_borrower_id"] = subject.application_borrower_id;
    }
    if (name === "party.updateContact") input["application_borrower_ids"] = ctx.subjects.map((s) => s.application_borrower_id).filter((x): x is string => !!x);
    if (name === "disclosure.acknowledgeReceipt") { const rows = await this.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM consents WHERE kind = 'esign' AND status = 'active' AND (party_id = $1 OR application_id = $2 OR loan_id = $3)`, [ctx.party.id, subject.application_id, subject.loan_id]); input["esign_consent_active"] = Number(rows[0]?.n ?? 0) > 0 || (await this.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE application_id = $1 AND type IN ('disclosure.le.delivered', 'disclosure.cd.delivered') AND payload->>'channel' = 'esign_portal'`, [subject.application_id])).some((r) => Number(r.n) > 0); }
    if (name === "lock.request" && subject.application_id) {
      if (!input["property_state"]) input["property_state"] = (await this.db.query<{ state: string | null }>(`SELECT state FROM application_properties WHERE application_id = $1 ORDER BY is_subject DESC, created_at LIMIT 1`, [subject.application_id]))[0]?.state ?? null;
      if (!input["le_loan_amount_cents"] && typeof input["quote_id"] === "string") { const q = (await this.db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'pricing_quotes' AND id = $1`, [input["quote_id"]]))[0]; const d = q ? decodeEntityData(q.data) : null; const amt = d?.["loan_amount_cents"] ?? (d?.["inputs"] as Record<string, unknown> | undefined)?.["loan_amount_cents"]; if (amt !== undefined) input["le_loan_amount_cents"] = typeof amt === "bigint" ? amt.toString() : String(amt); }
    }
    if (name === "human.request" && !input["channel"]) input["channel"] = "app";
    return input;
  }
  /** The party's borrower id as the 21.1 interview knows it (the intake application's own borrower ids, e.g. "B1"), else the application_borrowers row id. */
  private async intakeBorrowerId(subject: Subject): Promise<string | null> {
    if (!subject.application_id || !subject.application_borrower_id) return null;
    const abs = await this.db.query<{ id: string; legal_name: string }>(`SELECT id, legal_name FROM application_borrowers WHERE application_id = $1 ORDER BY created_at, id`, [subject.application_id]);
    const intake = (await this.db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'applications' AND id = $1`, [subject.application_id]))[0];
    const mine = abs.find((a) => a.id === subject.application_borrower_id);
    if (intake && mine) { const d = decodeEntityData(intake.data); const bs = (d["borrowers"] as { id: string; legal_name: string }[] | undefined) ?? []; const b = bs.find((x) => x.legal_name === mine.legal_name) ?? bs[abs.findIndex((a) => a.id === mine.id)]; if (b) return b.id; }
    return subject.application_borrower_id;
  }

  /** A direct command (02 §7 POST /v1/borrower/commands/{name}). */
  async runCommand(ctx: BorrowerContext, name: string, body: Record<string, unknown>, now: string, cardInstanceId: string | null = null): Promise<CommandOutcome> {
    if (!COMMAND_NAMES.has(name)) throw new BorrowerError(404, "COMMAND_UNKNOWN", undefined, `${name} is not a 32.2 command`);
    const wanted = (body["subject"] as { application_id?: string | null; loan_id?: string | null } | undefined) ?? { application_id: typeof body["application_id"] === "string" ? body["application_id"] : null, loan_id: typeof body["loan_id"] === "string" ? body["loan_id"] : null };
    const subject = this.subjectFor(ctx, wanted);
    const { subject: _s, ...args } = body;
    const input = await this.enrich(ctx, name, subject, { ...args, ...(cardInstanceId ? { card_instance_id: cardInstanceId } : {}) }, now);
    const r = await this.runtime.execute({ process: "32.2", name, loanId: subject.loan_id ?? "", ...(subject.application_id ? { applicationId: subject.application_id } : {}), actor: BORROWER_APP_ACTOR, input, run: { runId: `session:${ctx.session.session_id}`, modelVersion: "borrower-app api (deterministic)", promptVersion: "32.2" } });
    return { command: name, subject: { application_id: subject.application_id, loan_id: subject.loan_id }, result: r.output, events: r.events.map((e) => e.type), decision_id: r.decisionId ?? null };
  }

  /** 02 §7 POST /v1/borrower/cards/{id}/resolve. */
  async resolveCard(ctx: BorrowerContext, cardId: string, body: Record<string, unknown>, now: string): Promise<{ card: CardInstanceRow; command: string | null; idempotent: boolean; result: unknown; events: string[] }> {
    if (!isUuid(cardId)) throw new BorrowerError(403, "PARTY_SCOPE", undefined, "card id must be a uuid");
    const first = await this.ui.card(cardId);
    if (!first || first.party_id !== ctx.party.id) throw new BorrowerError(403, "PARTY_SCOPE", undefined, "the card is not this party's");
    const channel = typeof body["channel"] === "string" ? (body["channel"] as string) : "app";
    if (first.status === "resolved") return { card: first, command: first.command_ref, idempotent: true, result: (first.evidence as Record<string, unknown> | null)?.["command_output"] ?? null, events: [] };
    if (first.status !== "pending") throw new BorrowerError(409, "CARD_NOT_PENDING", undefined, `the card is ${first.status}`);
    if (channel === "voice" && (first.kind === "ConsentCard" || first.command_ref === "closing.captureEsignConsent" || first.command_ref === "consent.capture")) throw new BorrowerError(409, "CARD_VOICE_CONSENT", undefined, "a consent is never captured by voice — the card resolves by tap");
    if (first.expires_at && Date.parse(first.expires_at) <= Date.parse(now)) { await this.ui.transitionCard(cardId, "expired", "system", now); throw new BorrowerError(409, "CARD_NOT_PENDING", undefined, "the card expired"); }
    const subject = this.subjectFor(ctx, { application_id: first.subject_application_id, loan_id: first.subject_loan_id });
    const optionId = typeof body["option_id"] === "string" ? (body["option_id"] as string) : null;
    const evidence = { ...((body["evidence"] as Record<string, unknown> | undefined) ?? {}), option_id: optionId, channel, tapped_at: now, session_id: ctx.session.session_id, ip: ctx.ip, user_agent: ctx.userAgent, disclosure_version_shown: (first.props["disclosure_version_id"] as string | null) ?? ((body["evidence"] as Record<string, unknown> | undefined)?.["disclosure_version_shown"] as string | null) ?? null };
    // the card's own lock: a second tap waits here and then answers the stored outcome (idempotency key = card_instance_id)
    return this.db.tx(async (q) => {
      await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [cardId]);
      const card = (await this.ui.card(cardId, q))!;
      if (card.status === "resolved") return { card, command: card.command_ref, idempotent: true, result: (card.evidence as Record<string, unknown> | null)?.["command_output"] ?? null, events: [] };
      if (card.status !== "pending") throw new BorrowerError(409, "CARD_NOT_PENDING", undefined, `the card is ${card.status}`);
      let result: unknown = null; let events: string[] = [];
      if (card.command_ref) {
        const args = commandInputFor(card, { option_id: optionId, args: (body["args"] as Record<string, unknown> | undefined) ?? {} }, { application_id: subject.application_id, loan_id: subject.loan_id });
        const out = await this.runCommand(ctx, card.command_ref, { ...args, evidence, channel, subject: { application_id: subject.application_id, loan_id: subject.loan_id } }, now, cardId);
        result = out.result; events = out.events;
      }
      const stored = { ...evidence, command_ref: card.command_ref, command_output: summarize(result) };
      const resolved = await this.ui.transitionCard(cardId, "resolved", `borrower:${ctx.party.id}`, now, stored, q);
      await this.ui.logUiEvent({ party_id: ctx.party.id, session_id: ctx.session.session_id, conversation_id: card.conversation_id, card_instance_id: cardId, kind: card.kind === "ConsentCard" ? "consent_affirmed" : "card_resolved", at: now, ip: ctx.ip, user_agent: ctx.userAgent, disclosure_version_id: isUuid(evidence.disclosure_version_shown) ? evidence.disclosure_version_shown : null, payload: { option_id: optionId, channel, command_ref: card.command_ref, ...(card.kind === "DemographicsCard" ? {} : { evidence_keys: Object.keys(evidence) }) } }, q);
      await this.ui.appendMessage({ conversation_id: card.conversation_id, at: now, sender: "system", sender_ref: "borrower-api", channel: channel === "voice" || channel === "sms" || channel === "email" ? channel : "app", body_text: `{{copy:receipt.${card.copy_key}}}`, card_instance_id: cardId, subject_application_id: card.subject_application_id, subject_loan_id: card.subject_loan_id }, q);   // the collapsed receipt line (01 §1.3, 02 §1.3)
      return { card: resolved, command: card.command_ref, idempotent: false, result, events };
    });
  }

  /** 02 §7 POST /v1/borrower/messages. */
  async borrowerMessage(ctx: BorrowerContext, body: Record<string, unknown>, now: string): Promise<{ message: MessageRow; reply: MessageRow & { copy_key: string; deep_link: { token: string; path: string; expires_at: string } | null }; routed_to: "intake" | "borrower-comms"; command_executed: boolean; command: string | null }> {
    const text = typeof body["text"] === "string" ? (body["text"] as string).trim() : ""; if (!text) throw new RangeError("text is required");
    if (text.length > 4000) throw new RangeError("text is over 4000 characters");
    const channelIn = typeof body["channel"] === "string" ? (body["channel"] as string) : "app"; const channel = (["app", "sms", "email", "voice"].includes(channelIn) ? channelIn : "app") as "app" | "sms" | "email" | "voice";
    const wanted = (body["subject"] as { application_id?: string | null; loan_id?: string | null } | undefined) ?? null;
    const subject = ctx.subjects.length ? this.subjectFor(ctx, wanted) : null;
    const routed_to: "intake" | "borrower-comms" = subject?.stage === "servicing" ? "borrower-comms" : "intake";
    const conv = await this.ui.conversationFor(ctx.party.id);
    const messageId = await this.ui.appendMessage({ conversation_id: conv.conversation_id, at: now, sender: "borrower", sender_ref: `party:${ctx.party.id}`, channel, body_text: text, subject_application_id: subject?.application_id ?? null, subject_loan_id: subject?.loan_id ?? null, voice_turn: channel === "voice" });
    const message = (await this.ui.message(messageId))!;
    const pending = await this.ui.cardsOf(ctx.party.id, { status: "pending" });
    const reply = async (copy_key: string, extra: { card_instance_id?: string | null; deep_link?: { token: string; path: string; expires_at: string } | null; body?: string }) => {
      const id = await this.ui.appendMessage({ conversation_id: conv.conversation_id, at: now, sender: "agent", sender_ref: `agent:${routed_to}`, channel, body_text: extra.body ?? `{{copy:${copy_key}}}`, card_instance_id: extra.card_instance_id ?? null, subject_application_id: subject?.application_id ?? null, subject_loan_id: subject?.loan_id ?? null, voice_turn: channel === "voice" });
      return { ...(await this.ui.message(id))!, copy_key, deep_link: extra.deep_link ?? null };
    };
    // T-X-05: an affirmative that answers a pending card executes nothing — the deep link is the answer (01 §6.4; a spoken yes never resolves a ConsentCard, 01 §3.5)
    const card = affirmativeFor(text, pending);
    if (card) {
      const link = await this.ui.createDeepLink({ party_id: ctx.party.id, target: { card_instance_id: card.card_instance_id }, now, created_for_message_id: messageId });
      const r = await reply(card.kind === "ConsentCard" && channel === "voice" ? THREAD_COPY_KEYS.voiceConsentLink : THREAD_COPY_KEYS.affirmativeNeedsCard, { card_instance_id: card.card_instance_id, deep_link: { token: link.token, path: `/d/${link.token}`, expires_at: link.expires_at }, body: `{{copy:${THREAD_COPY_KEYS.affirmativeNeedsCard}}} /d/${link.token}` });
      return { message, reply: r, routed_to, command_executed: false, command: null };
    }
    // "human" at any time (01 §1.1, §7.1): the human.request command
    if (/\b(human|real person|a person|talk to (a|someone)|representative|agent)\b/i.test(text) && subject) {
      const out = await this.runCommand(ctx, "human.request", { reason: "borrower_request", channel, utterance: text, subject: { application_id: subject.application_id, loan_id: subject.loan_id } }, now);
      return { message, reply: await reply(THREAD_COPY_KEYS.humanRequested, {}), routed_to, command_executed: true, command: out.command };
    }
    return { message, reply: await reply(routed_to === "intake" ? THREAD_COPY_KEYS.placeholderIntake : THREAD_COPY_KEYS.placeholderServicing, {}), routed_to, command_executed: false, command: null };
  }
}

const summarize = (v: unknown): unknown => JSON.parse(toJson(v ?? null));
