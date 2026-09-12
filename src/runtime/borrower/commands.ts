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
 *                    anything else is the agent turn (32.16 DELTA-23, src/runtime/borrower/agent/turn.ts — Claude on the bus's
 *                    tools, routed to `intake` before funding and `borrower-comms` after); the copy library's placeholder reply
 *                    stands only when no model is configured or the 18.1 kill switch bypasses the turn.
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
import { TOOLS_32_14 } from "../../app/tools/section32-14.ts";
import { commandInputFor } from "../../app/tools/section32-1.ts";
import { assertSubject, hasFreshL1, requireFreshL1, type BorrowerContext } from "./auth.ts";
import { BorrowerError } from "./errors.ts";
import { THREAD_COPY_KEYS } from "./copy-keys.ts";
import type { BorrowerFlows } from "./flows/index.ts";
import { SUBJECT_FREE_COMMANDS, TERMINAL_ALLOWED_COMMANDS, terminalStateOf } from "./flows/13-cross-cutting.ts";
import type { AgentTurnRequest, AgentTurnReply } from "./agent/turn.ts";

export const BORROWER_APP_ACTOR: Actor = { kind: "agent", id: "borrower-app" };
/** The commands a card or a direct endpoint may name: 32.2's 45 and 32.14's three (`lead.answer`, `lead.requestRange`, `lead.proceed` — the S4 proceed card's command; the L0 routes call the bus directly) — each executed as its own process's tool. */
const PROCESS_OF: ReadonlyMap<string, string> = new Map([...TOOLS_32_2.map((t) => [t.name, "32.2"] as const), ...TOOLS_32_14.map((t) => [t.name, "32.14"] as const)]);
/** 32.2's own command surface — the 45 of 02 §2 (commands.test.ts); the 32.14 names a card or endpoint may also issue are `PROCESS_OF`'s. */
export const COMMAND_NAMES: ReadonlySet<string> = new Set(TOOLS_32_2.map((t) => t.name));
export const CARD_COMMAND_NAMES: ReadonlySet<string> = new Set(PROCESS_OF.keys());
/** 32.2 guardrails: the money-field commands — a fresh L1 code first, never an agent-side waiver. */
export const FRESH_L1_COMMANDS: ReadonlySet<string> = new Set(["payment.makeOneTime", "payment.extraPrincipal", "autodraft.enroll", "autodraft.change", "autodraft.pause", "autodraft.revoke", "escrow.electShortage", "party.updateContact"]);
/** 01 §5 / 02 §2: the level a command needs. 32.14 DELTA-13 / 20.3 rule 2: a soft pull is L1 when the consumer entered (or confirmed) name, address, DOB and SSN themselves — a fact the API states from the application_borrowers row (`consumerEnteredIdentity`), never the client's claim; L2 otherwise; a hard pull stays L3 (32.3 T4). */
const LEVEL_REQUIRED: Readonly<Record<string, (args: Record<string, unknown>) => "L1" | "L2" | "L3">> = { "credit.authorize": (a) => (a["kind"] === "hard_pull" ? "L3" : a["consumer_entered_identity"] === true ? "L1" : "L2"), "party.startIdentity": () => "L1" };
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

/** The subject of a subject-free command for a party that has none yet (32.14 DELTA-16 party.linkLoan): the command runs in global scope; nothing is scoped to it. */
const NO_SUBJECT: Subject = { application_id: null, loan_id: null, role: "party", stage: "origination", label: "", application_borrower_id: null };
export interface CommandOutcome { readonly command: string; readonly subject: { application_id: string | null; loan_id: string | null }; readonly result: unknown; readonly events: string[]; readonly decision_id: string | null }

/**
 * A commit that lost the entity store's optimistic version to a flow reaction on the same subject: the 32.x flows react to the party's
 * previous commit in the background (32.5 runs 21.1 `captureField` as `intake` after `application.party.invited`, …) and write the intake
 * record's next version while the borrower's next command has already hydrated its store one version behind — Postgres 23505 on
 * entity_records_pkey (0115: (kind, id, version, scope_key)). The unit of work rolled back, so nothing of the command was written.
 */
const isEntityVersionRace = (e: unknown): boolean => e instanceof Error && (e as { code?: unknown }).code === "23505" && /entity_records_pkey/.test(String((e as { constraint?: unknown }).constraint ?? "") + e.message);

export class BorrowerCommands {
  private readonly runtime: Runtime; private readonly db: Db; private readonly ui: PgBorrowerUiRepository;
  /** The 32.x flows (src/runtime/borrower/flows): a message a flow answers itself (32.3 T2 "are you a real person?", P9 listings) comes before the generic reply. */
  flows: BorrowerFlows | undefined;
  /** 32.16 DELTA-23: the agent turn (routes.ts wires it when a model is configured); null from it = bypassed (the placeholder answers). */
  agentTurn: ((req: AgentTurnRequest) => Promise<AgentTurnReply | null>) | undefined;
  constructor(runtime: Runtime, ui: PgBorrowerUiRepository, flows?: BorrowerFlows) { this.runtime = runtime; this.db = runtime.db; this.ui = ui; this.flows = flows; }

  /** Every queued flow reaction has run (read-your-writes across the seam: a command sees the cards, rows and entity versions the flows wrote for the party's previous commit). */
  private async settled(): Promise<void> { if (this.flows) await this.flows.settle(); }

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
    // 32.5 §7 / 21.1 rule 4: a co-borrower's credit is never ordered before their own joint-intent affirmation — the fact comes from 21.1's record (SM_O21_JOINT_INTENT_GATE armed by `application.borrower.added{joint_intent_required}`), stated before the level check so the invitee sees the gate rather than a step-up
    if (name === "credit.authorize" && subject.application_id) { const ji = await this.jointIntentFacts(subject); input["joint_intent_required"] = ji.required; input["joint_intent_affirmed"] = ji.affirmed; if (ji.required && !ji.affirmed) throw new BorrowerError(409, "SM_O21_JOINT_INTENT_GATE", "SM_O21_JOINT_INTENT_GATE", `borrower ${ji.borrower_id ?? "?"} has not affirmed joint intent (21.1 rule 4)`); }
    // 32.14 DELTA-13 / 20.3 rule 2: whether the consumer entered or confirmed their own identity (the API's fact from the row the identity and SSN cards wrote — the client's `consumer_entered_identity` is overwritten, never trusted)
    const facts: Record<string, unknown> = { ...args };
    if (name === "credit.authorize" && args["kind"] !== "hard_pull") { const entered = await this.consumerEnteredIdentity(subject); facts["consumer_entered_identity"] = entered; input["consumer_entered_identity"] = entered; }
    // 01 §5 / 32.3 T4: a hard pull needs L3 — the refusal names the identity gate (SM_IDENTITY_IAL2_GATE) so the client renders "verify your ID first"
    const need = LEVEL_REQUIRED[name]?.(facts); if (need && RANK[ctx.session.level] < RANK[need]) throw new BorrowerError(403, "LEVEL_REQUIRED", need === "L3" ? "SM_IDENTITY_IAL2_GATE" : undefined, `${need} required; session is ${ctx.session.level}`);
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
  /**
   * 20.3 rule 2 (32.14 S4): the consumer's own entry or confirmation of name, address, DOB and SSN on their application_borrowers row — the
   * identity ConfirmCard wrote `prefill.legal_name / date_of_birth / current_address{confirmed_at}` (typed, or the vendor's extraction confirmed
   * item by item) and the SSN card stored the last four (01 §5). Nothing else counts: a servicing-file prefill nobody confirmed is not an entry.
   */
  private async consumerEnteredIdentity(subject: Subject): Promise<boolean> {
    if (!subject.application_borrower_id) return false;
    const row = (await this.db.query<{ prefill: Record<string, { confirmed_at?: unknown } | undefined> | null; tin_last4: string | null }>(`SELECT prefill, tin_last4 FROM application_borrowers WHERE id = $1`, [subject.application_borrower_id]))[0];
    if (!row || !row.tin_last4) return false;
    const confirmed = (k: string): boolean => typeof row.prefill?.[k]?.confirmed_at === "string";
    return confirmed("legal_name") && confirmed("date_of_birth") && (confirmed("current_address") || confirmed("address"));
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

  /** 32.5 §7: the 21.1 joint-intent facts for the party's own borrower — required only while 21.1's gate is armed on the application (a co-borrower added after the interview), affirmed once that borrower's `application.joint_intent.affirmed` landed on the intake record. */
  private async jointIntentFacts(subject: Subject): Promise<{ required: boolean; affirmed: boolean; borrower_id: string | null }> {
    if (!subject.application_id) return { required: false, affirmed: true, borrower_id: null };
    const armed = await this.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM timers WHERE application_id = $1 AND code = 'SM_O21_JOINT_INTENT_GATE' AND status IN ('armed', 'breached')`, [subject.application_id]);
    const own = await this.intakeBorrowerId(subject);
    if (Number(armed[0]?.n ?? 0) === 0 || !own) return { required: false, affirmed: true, borrower_id: own };
    const intake = (await this.db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'applications' AND id = $1`, [subject.application_id]))[0];
    const b = intake ? ((decodeEntityData(intake.data)["borrowers"] as { id: string; credit_requested?: boolean; joint_intent_affirmed_at?: string | null }[] | undefined) ?? []).find((x) => x.id === own) : undefined;
    if (!b || b.credit_requested === false) return { required: false, affirmed: true, borrower_id: own };
    return { required: true, affirmed: !!b.joint_intent_affirmed_at, borrower_id: own };
  }

  /** A direct command (02 §7 POST /v1/borrower/commands/{name}). */
  async runCommand(ctx: BorrowerContext, name: string, body: Record<string, unknown>, now: string, cardInstanceId: string | null = null): Promise<CommandOutcome> {
    if (!CARD_COMMAND_NAMES.has(name)) throw new BorrowerError(404, "COMMAND_UNKNOWN", undefined, `${name} is not a 32.2 or 32.14 command`);
    const wanted = (body["subject"] as { application_id?: string | null; loan_id?: string | null } | undefined) ?? { application_id: typeof body["application_id"] === "string" ? body["application_id"] : null, loan_id: typeof body["loan_id"] === "string" ? body["loan_id"] : null };
    // 20.3 T12 / 32.3 T15: the demographic request exists only on an application — a lead-stage party (no application subject) is refused before anything runs
    if (name === "application.answerDemographics" && !ctx.subjects.some((s) => s.application_id)) throw new BorrowerError(409, "NO_DEMOGRAPHIC_AT_LEAD", undefined, "demographic information is requested only at application (21.1), never at the lead stage");
    // 32.14 DELTA-16 / SUBJECT_FREE_COMMANDS: a signed-in party with no application or loan yet (a Google e-mail not on file) runs a subject-free command — party.linkLoan — on no subject; every other command needs one
    const subject = SUBJECT_FREE_COMMANDS.has(name) && !ctx.subjects.length && !wanted.application_id && !wanted.loan_id ? NO_SUBJECT : this.subjectFor(ctx, wanted);
    // the flows' reactions to the party's previous commit finish before this command reads its facts and hydrates its entity store (a direct command settles
    // here; a card resolve settled before its transaction — the reactions need their own connections)
    if (cardInstanceId === null) await this.settled();
    // 32.13 T-X-16: a terminal subject (denied | withdrawn | closed_incomplete | rescinded | paid_in_full | transferred_out) is read-only — only case.open, human.request and party.updateContact run (document download is a GET)
    if (!TERMINAL_ALLOWED_COMMANDS.has(name) && !SUBJECT_FREE_COMMANDS.has(name)) { const terminal = await terminalStateOf(this.db, subject); if (terminal) throw new BorrowerError(409, "SUBJECT_TERMINAL", undefined, `the subject is ${terminal}: the Record is read-only (32.13 T-X-16)`); }
    const { subject: _s, ...args } = body;
    const input = await this.enrich(ctx, name, subject, { ...args, ...(cardInstanceId ? { card_instance_id: cardInstanceId } : {}) }, now);
    const process = PROCESS_OF.get(name) ?? "32.2";
    const req = { process, name, loanId: subject.loan_id ?? "", ...(subject.application_id ? { applicationId: subject.application_id } : {}), actor: BORROWER_APP_ACTOR, input, run: { runId: `session:${ctx.session.session_id}`, modelVersion: "borrower-app api (deterministic)", promptVersion: process } };
    let r;
    try { r = await this.runtime.execute(req); }
    catch (e) {
      if (!isEntityVersionRace(e)) throw e;
      // a reaction landed between the hydrate and the commit: nothing was written — once the reactions settle, the command runs again on the current versions
      await this.settled();
      r = await this.runtime.execute(req);
    }
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
    // the flows' reactions to the party's previous commit finish before the card's command hydrates its store (outside the transaction: the reactions need their own connections)
    await this.settled();
    // the card's own lock: a second tap waits here and then answers the stored outcome (idempotency key = card_instance_id)
    return this.db.tx(async (q) => {
      await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [cardId]);
      const card = (await this.ui.card(cardId, q))!;
      if (card.status === "resolved") return { card, command: card.command_ref, idempotent: true, result: (card.evidence as Record<string, unknown> | null)?.["command_output"] ?? null, events: [] };
      if (card.status !== "pending") throw new BorrowerError(409, "CARD_NOT_PENDING", undefined, `the card is ${card.status}`);
      let result: unknown = null; let events: string[] = [];
      // an option the card lists under `no_command_options` (Keep floating, Not yet, Wait) records the choice and issues no command (32.4 §3–4)
      const noCommand = optionId !== null && Array.isArray(card.props["no_command_options"]) && (card.props["no_command_options"] as unknown[]).includes(optionId);
      // 32.3: what the card's evidence contributes to the command (the API settles it, never the client): the confirmed fields with the source the platform holds (or `borrower` where edited),
      // the profile answers, the demographic answers (never persisted on the card), the declarations list hash; a required field without an answer refuses before anything runs (T13)
      const card32 = cardArgs(card, evidence, optionId);
      if (card.command_ref && !noCommand) {
        const args = commandInputFor(card, { option_id: optionId, args: (body["args"] as Record<string, unknown> | undefined) ?? {} }, { application_id: subject.application_id, loan_id: subject.loan_id });
        const out = await this.runCommand(ctx, card.command_ref, { ...args, ...card32.args, evidence: card32.stored, channel, subject: { application_id: subject.application_id, loan_id: subject.loan_id } }, now, cardId);
        result = out.result; events = out.events;
      }
      const stored = { ...card32.stored, command_ref: card.command_ref, command_output: summarize(result) };
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
    // a flow that answers this message itself (32.3 T2 "are you a real person?" → 20.3's script with the disclosure re-logged; P9 listings) — before the human path, which "real person" would otherwise match
    if (this.flows) {
      const fr = await this.flows.message({ party_id: ctx.party.id, session_id: ctx.session.session_id, conversation_id: conv.conversation_id, message_id: messageId, text, channel, subject: subject ? { application_id: subject.application_id, loan_id: subject.loan_id } : null, claimed_subject: wanted, at: now });
      if (fr) return { message, reply: await reply(fr.copy_key, { card_instance_id: fr.card_instance_id ?? null, ...(fr.body_text ? { body: fr.body_text } : {}) }), routed_to, command_executed: !!fr.command, command: fr.command ?? null };
    }
    // "human" at any time (01 §1.1, §7.1): the human.request command
    if (/\b(human|real person|a person|talk to (a|someone)|representative|agent)\b/i.test(text) && subject) {
      const out = await this.runCommand(ctx, "human.request", { reason: "borrower_request", channel, utterance: text, subject: { application_id: subject.application_id, loan_id: subject.loan_id } }, now);
      return { message, reply: await reply(THREAD_COPY_KEYS.humanRequested, {}), routed_to, command_executed: true, command: out.command };
    }
    // 32.16 §3.1: the agent turn replaces the placeholder — the same order in front of it; the placeholder stands only without a model or under the kill switch
    if (this.agentTurn) {
      const t = await this.agentTurn({ ctx, conversation_id: conv.conversation_id, message_id: messageId, text, channel, subject, routed_to, now });
      if (t) return { message, reply: { ...t.reply, copy_key: t.copy_key, deep_link: null }, routed_to, command_executed: t.command_executed, command: t.command };
    }
    return { message, reply: await reply(routed_to === "intake" ? THREAD_COPY_KEYS.placeholderIntake : THREAD_COPY_KEYS.placeholderServicing, {}), routed_to, command_executed: false, command: null };
  }
}

const summarize = (v: unknown): unknown => JSON.parse(toJson(v ?? null));

/** 32.3: the card's evidence → the command's input and the evidence the card keeps (01 §3.3 ConfirmCard, §3.18 ProfileCard, §3.19 DemographicsCard, R5 declarations). */
export function cardArgs(card: CardInstanceRow, evidence: Record<string, unknown>, optionId: string | null): { args: Record<string, unknown>; stored: Record<string, unknown> } {
  const props = card.props; const args: Record<string, unknown> = {}; let stored: Record<string, unknown> = { ...evidence };
  // 32.16 §3.4: a Confirm on a proposal the assistant read back carries `evidence.source = borrower_stated` (the six items count when stated — 21.2); it stays on the card's evidence and names the fields' source
  const evidenceSource = typeof evidence["source"] === "string" ? (evidence["source"] as string) : null;
  const required = Array.isArray(props["required_paths"]) ? (props["required_paths"] as string[]) : [];
  const evFields = Array.isArray(evidence["fields"]) ? (evidence["fields"] as Record<string, unknown>[]) : [];
  const valueOf = (f: Record<string, unknown>): string => { const v = f["value_confirmed"] ?? f["value"]; return v === undefined || v === null ? "" : String(v); };
  if (required.length && (card.kind === "ConfirmCard" || card.kind === "ProfileCard")) {
    const missing = required.filter((p) => !evFields.some((f) => f["path"] === p && valueOf(f).trim() !== ""));
    if (missing.length) throw new BorrowerError(409, "CARD_FIELD_REQUIRED", undefined, `${missing.join(", ")} need an answer — nothing is written without the tap (01 §3.18)`);
  }
  if (card.kind === "ConfirmCard" && evFields.length) {
    const shown = Array.isArray(props["fields"]) ? (props["fields"] as { path?: unknown; value?: unknown; source?: unknown }[]) : [];
    args["fields"] = evFields.map((f) => { const path = String(f["path"] ?? ""); const orig = shown.find((x) => x["path"] === path); const value = valueOf(f); const edited = !orig || String(orig["value"] ?? "") !== value; return { path, value, source: evidenceSource === "borrower_stated" || edited ? "borrower" : String(orig?.["source"] ?? f["source"] ?? "borrower"), edited }; });
    const masked = Array.isArray(props["masked_paths"]) ? (props["masked_paths"] as string[]) : [];
    if (masked.length) stored = { ...stored, fields: evFields.map((f) => (masked.includes(String(f["path"])) ? { ...f, value_confirmed: `••••${valueOf(f).replace(/\D/g, "").slice(-4)}`, value: undefined, masked: true } : f)) };   // the SSN is stored once by the owning handler, never echoed (01 §5)
  }
  if (card.kind === "ProfileCard" && evFields.length) args["fields"] = evFields.map((f) => ({ path: String(f["path"] ?? ""), value: valueOf(f), source: "borrower" }));
  // 32.10 T6 (01 §3.12): a PaymentCard's evidence IS the payment — the amount, date and account the borrower confirmed go to `payment.makeOneTime` as its input (the card's `command_args` carry the designation)
  if (card.kind === "PaymentCard") { for (const k of ["amount_cents", "date", "account_id", "include_late_charge"]) if (evidence[k] !== undefined && args[k] === undefined) args[k] = evidence[k]; if (evidence["new_account"] && typeof evidence["new_account"] === "object") args["account"] = evidence["new_account"]; }
  if (card.kind === "DemographicsCard") {
    const answers = (evidence["answers"] as { ethnicity?: unknown; race?: unknown; sex?: unknown } | undefined) ?? {};
    const decline = (v: unknown): boolean => v === "do_not_wish" || v === "declined" || (Array.isArray(v) && (v as unknown[]).some((x) => x === "do_not_wish" || x === "declined"));
    const keep = (v: unknown): string[] | null => (Array.isArray(v) ? (v as unknown[]).map(String).filter((x) => x !== "do_not_wish" && x !== "declined") : []);
    const declined_ethnicity = decline(answers.ethnicity) || (Array.isArray(answers.ethnicity) && !(answers.ethnicity as unknown[]).length); const declined_race = decline(answers.race) || (Array.isArray(answers.race) && !(answers.race as unknown[]).length); const declined_sex = decline(answers.sex) || !answers.sex;
    Object.assign(args, { ethnicity: declined_ethnicity ? null : keep(answers.ethnicity), race: declined_race ? null : keep(answers.race), sex: declined_sex ? null : String(answers.sex), declined_ethnicity, declined_race, declined_sex, collection_method: String(evidence["collection_method"] ?? props["collection_method"] ?? "internet") });
    const { answers: _a, ...rest } = stored; stored = rest;   // the answers are written once by 21.1 and never kept on the card (01 §3.19)
  }
  if (typeof props["list_version_hash"] === "string") stored = { ...stored, list_version: props["list_version"] ?? null, list_version_hash: props["list_version_hash"], ...(optionId ? { option_id: optionId } : {}) };
  return { args, stored };
}
