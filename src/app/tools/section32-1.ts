/**
 * §32.1 process-owned tools — DELTA-07's three card tools of the thread-owning agents (`intake` before funding,
 * `borrower-comms` after; spec/registry/agents.json carries them on `intake`, the owner of 32.1), defined with
 * `defineTools("32.1", "intake", defs)`. Spread by ./index.ts.
 *
 *   send_card                 a typed card (01 §3 CardBase) for ONE party: the card_instances row (+ its first
 *                             card_instance_events transition) and the thread message that carries it, committed with
 *                             the command (`services.deferWrite`); never for a party other than the one it is for.
 *   resolve_card_by_evidence  resolves a pending card from out-of-band evidence {channel, transcript_ref} — a spoken
 *                             "proceed" with its transcript, a human agent's confirmation — ONLY where the owning
 *                             process permits that manner: intent and choice cards. A ConsentCard, a signature or a
 *                             payment card is never resolved this way (01 §3.5, 32.1 guardrails); it is sent, not
 *                             resolved. The mapped 32.2 command runs nested in the same unit of work; its refusal
 *                             leaves the card pending.
 *   create_deep_link          mints the 01 §6.5 deep link for an outbound message about a pending card / document /
 *                             route: 7-day expiry, opaque token, never loan data.
 */
import { createHash, randomUUID } from "node:crypto";
import { defineTools, compute, never, str, flag, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { toJson, isUuid } from "../../infra/db/client.ts";
import { addDaysIso, newDeepLinkToken, DEEP_LINK_DAYS, type CardInstanceRow, type DeepLinkTarget } from "../../infra/db/borrower-ui.ts";
import { CARD_KIND_SET, delegate } from "./section32-2.ts";

const obj = (i: ToolInput, k: string): Record<string, unknown> => ((i[k] && typeof i[k] === "object" && !Array.isArray(i[k]) ? (i[k] as Record<string, unknown>) : {}));
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const defer = (rt: ToolRuntime, fn: (q: Queryable) => Promise<void>): void => { const d = rt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined; if (!d) throw new PortUnavailable("service:deferWrite"); d(fn); };

/** 32.1 guardrails: the agent never resolves a consent, a signature or a payment — by kind or by the command the card issues. */
export const EVIDENCE_RESOLVABLE_KINDS: ReadonlySet<string> = new Set(["ChoiceCard", "ComparisonCard", "OfferCard"]);
export const NEVER_BY_EVIDENCE_COMMANDS = /^(consent\.|closing\.captureEsignConsent|payment\.|autodraft\.|credit\.authorize|application\.answerDemographics|disclosure\.acknowledgeReceipt)/;
export function evidenceResolvable(card: Pick<CardInstanceRow, "kind" | "command_ref">): boolean {
  if (card.kind === "ConsentCard" || card.kind === "PaymentCard" || card.kind === "DemographicsCard") return false;
  if (card.command_ref && NEVER_BY_EVIDENCE_COMMANDS.test(card.command_ref)) return false;
  return EVIDENCE_RESOLVABLE_KINDS.has(card.kind) || card.command_ref === "intent.record";
}
const CARD_COLS = "card_instance_id, conversation_id, party_id, subject_application_id, subject_loan_id, kind, status, created_by, copy_key, props, evidence, command_ref, expires_at, created_at, resolved_at";

/** The mapped 32.2 command's input from a card's props and the borrower's choice (the option's `command_args_by_option`, else the props' `command_args`). */
export function commandInputFor(card: CardInstanceRow, choice: { option_id?: string | null; args?: Record<string, unknown> }, subject: { application_id: string | null; loan_id: string | null }): Record<string, unknown> {
  const props = card.props;
  const byOption = (props["command_args_by_option"] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const base = (props["command_args"] as Record<string, unknown> | undefined) ?? {};
  return { ...base, ...(choice.option_id ? (byOption[choice.option_id] ?? {}) : {}), ...(choice.args ?? {}), card_instance_id: card.card_instance_id, party_id: card.party_id, ...(subject.application_id ? { application_id: subject.application_id } : {}), ...(subject.loan_id ? { loan_id: subject.loan_id } : {}) };
}

export const TOOLS_32_1: readonly ToolDef[] = defineTools("32.1", "intake", [
  { name: "send_card", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "party_id", "kind", "copy_key"); const kind = str(i, "kind"); if (!CARD_KIND_SET.has(kind)) throw new RangeError(`kind ${kind} is not a 01 §3 card kind`);
      const party_id = str(i, "party_id"); if (!isUuid(party_id)) throw new RangeError("party_id must be the party's uuid");
      const subject = obj(i, "subject"); const application_id = (subject["application_id"] as string | undefined) ?? (str(i, "application_id") || ctx.applicationId || null); const loan_id = (subject["loan_id"] as string | undefined) ?? (str(i, "loan_id") || ctx.loanId || null);
      const card_instance_id = str(i, "card_instance_id") || randomUUID(); const message_id = randomUUID();
      // `at` (optional, additive — 32.5): a flow dates the card to the fact it answers (the reacted event's instant) when that precedes the clock's reading; never later than now
      const now = str(i, "at") && !Number.isNaN(Date.parse(str(i, "at"))) && str(i, "at") < ctx.now ? str(i, "at") : ctx.now;
      const created_by = str(i, "created_by") || (ctx.actor.kind === "agent" ? `agent:${ctx.actor.id}` : ctx.actor.kind === "human" ? `human:${ctx.actor.role ?? "human_agent"}` : "system");
      const props = obj(i, "props"); const command_ref = str(i, "command_ref") || null; const copy_key = str(i, "copy_key"); const expires_at = str(i, "expires_at") || null; const body_text = str(i, "body_text") || null;
      defer(rt, async (q) => {
        const conv = await q.query<{ conversation_id: string }>(`INSERT INTO conversations (party_id, retention_class) VALUES ($1, $2::retention_class) ON CONFLICT (party_id) DO UPDATE SET party_id = EXCLUDED.party_id RETURNING conversation_id`, [party_id, application_id || loan_id ? "fnma_loan_file_life_plus_4y" : "sm_lead_36m"]);
        const conversation_id = conv[0]!.conversation_id;
        await q.query(`INSERT INTO card_instances (card_instance_id, conversation_id, party_id, subject_application_id, subject_loan_id, kind, created_by, copy_key, props, command_ref, expires_at, created_at, retention_class) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::retention_class)`,
          [card_instance_id, conversation_id, party_id, application_id, loan_id, kind, created_by, copy_key, toJson(props), command_ref, expires_at, now, application_id || loan_id ? "fnma_loan_file_life_plus_4y" : "sm_lead_36m"]);
        await q.query(`INSERT INTO card_instance_events (card_instance_id, from_status, to_status, at, actor) VALUES ($1, NULL, 'pending', $2, $3)`, [card_instance_id, now, created_by]);
        await q.query(`INSERT INTO messages (message_id, conversation_id, at, sender, sender_ref, channel, body_text, card_instance_id, subject_application_id, subject_loan_id) VALUES ($1, $2, $3, $4, $5, 'app', $6, $7, $8, $9)`,
          [message_id, conversation_id, now, created_by.startsWith("human:") ? "human" : created_by === "system" ? "system" : "agent", created_by, body_text, card_instance_id, application_id, loan_id]);
      });
      ctx.events.append({ type: "card.sent", ...(loan_id ? { loanId: loan_id } : {}), ...(application_id ? { applicationId: application_id } : {}), aggregate: { kind: "card_instance", id: card_instance_id }, actor: ctx.actor, payload: { card_instance_id, party_id, kind, copy_key, command_ref, created_by, expires_at, message_id, ...(str(i, "trigger") ? { trigger: str(i, "trigger") } : {}) } });   // `trigger`: a 32.16 tool command names what raised the card (card.request); the flows registry attributes it (DELTA-26)
      return { card_instance_id, message_id, party_id, kind, status: "pending", copy_key, command_ref, created_by, expires_at, subject: { application_id, loan_id } };
    }),
    decision: (i, out) => ({ action: "send_card", rationale: str(i, "rationale") || `${str(i, "kind")} ${str(i, "copy_key")} for party ${str(i, "party_id")}${str(i, "command_ref") ? ` → ${str(i, "command_ref")}` : ""}`, subject: { kind: "card_instance", id: String((out as { card_instance_id: string }).card_instance_id) } }),
    guardrails: [never("CARD_FOR_OWN_PARTY", "32.1 guardrails: no card is created for a party other than the one it is for", (i) => str(i, "for_party_id") !== "" && str(i, "for_party_id") !== str(i, "party_id"), "the card's party_id must be the party it is for"),
      never("NO_RATE_BEFORE_MLO_REVIEW", "32.1 guardrails: no rate or payment is presented as personal before mlo.review.completed{approved}", (i) => flag(i, "personal_terms") && i.mlo_review_approved !== true, "personal terms need the MLO of record's approved review first")] },

  { name: "resolve_card_by_evidence", kind: "act", handler: compute(async (i, ctx, rt) => {
      need(i, "card_instance_id"); const evidence = obj(i, "evidence"); const channel = String(evidence["channel"] ?? str(i, "channel") ?? ""); const transcript_ref = String(evidence["transcript_ref"] ?? str(i, "transcript_ref") ?? "");
      if (!channel || !transcript_ref) throw new RangeError("evidence {channel, transcript_ref} is required");
      const db = dbOf(rt); const id = str(i, "card_instance_id"); if (!isUuid(id)) throw new RangeError("card_instance_id must be a uuid");
      const card = (await db.query<CardInstanceRow & Record<string, unknown>>(`SELECT ${CARD_COLS} FROM card_instances WHERE card_instance_id = $1`, [id]))[0];
      if (!card) throw new RangeError(`no card ${id}`);
      if (card.status !== "pending") throw new CardRefused("CARD_NOT_PENDING", `card ${id} is ${card.status}`);
      if (!evidenceResolvable(card)) throw new CardRefused("CARD_EVIDENCE_KIND", `a ${card.kind}${card.command_ref ? ` (${card.command_ref})` : ""} is never resolved from evidence — the borrower resolves it by tap`);
      const now = ctx.now; const option_id = str(i, "option_id") || null;
      const subject = { application_id: card.subject_application_id ?? ctx.applicationId ?? null, loan_id: card.subject_loan_id ?? (ctx.loanId || null) };
      const resolvedEvidence = { channel, transcript_ref, option_id, resolved_by: `${ctx.actor.kind}:${ctx.actor.id}`, manner: "out_of_band_evidence", resolved_at: now, ...(typeof evidence["spoken_text"] === "string" ? { spoken_text_sha256: createHash("sha256").update(evidence["spoken_text"] as string).digest("hex") } : {}) };
      let command_output: unknown = null;
      if (card.command_ref) command_output = await delegate(rt, ctx, "32.2", card.command_ref, { ...commandInputFor(card, { option_id, args: obj(i, "args") }, subject), evidence: resolvedEvidence, channel });
      const actor = `${ctx.actor.kind}:${ctx.actor.id}`;
      defer(rt, async (q) => {
        const updated = await q.query<{ card_instance_id: string }>(`UPDATE card_instances SET status = 'resolved', evidence = $2::jsonb, resolved_at = $3 WHERE card_instance_id = $1 AND status = 'pending' RETURNING card_instance_id`, [id, toJson({ ...resolvedEvidence, command_output: summarize(command_output) }), now]);
        if (!updated.length) throw new CardRefused("CARD_NOT_PENDING", `card ${id} was resolved concurrently`);
        await q.query(`INSERT INTO card_instance_events (card_instance_id, from_status, to_status, at, actor, evidence) VALUES ($1, 'pending', 'resolved', $2, $3, $4::jsonb)`, [id, now, actor, toJson(resolvedEvidence)]);
        await q.query(`INSERT INTO ui_events (party_id, conversation_id, card_instance_id, kind, at, payload) VALUES ($1, $2, $3, 'card_resolved', $4, $5::jsonb)`, [card.party_id, card.conversation_id, id, now, toJson({ manner: "out_of_band_evidence", channel, transcript_ref, option_id, command_ref: card.command_ref })]);
        await q.query(`INSERT INTO messages (message_id, conversation_id, at, sender, sender_ref, channel, body_text, card_instance_id, subject_application_id, subject_loan_id) VALUES ($1, $2, $3, 'system', $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), card.conversation_id, now, actor, channel === "voice" || channel === "sms" || channel === "email" ? channel : "app", `receipt:${card.copy_key}`, id, card.subject_application_id, card.subject_loan_id]);   // the collapsed receipt line (02 §1.3)
      });
      ctx.events.append({ type: "card.resolved", ...(subject.loan_id ? { loanId: subject.loan_id } : {}), ...(subject.application_id ? { applicationId: subject.application_id } : {}), aggregate: { kind: "card_instance", id }, actor: ctx.actor, payload: { card_instance_id: id, party_id: card.party_id, kind: card.kind, command_ref: card.command_ref, manner: "out_of_band_evidence", channel, transcript_ref, option_id } });
      return { card_instance_id: id, status: "resolved", kind: card.kind, command_ref: card.command_ref, manner: "out_of_band_evidence", channel, transcript_ref, option_id, command_output: summarize(command_output) };
    }),
    decision: (i, _out, ctx) => ({ action: "resolve_card_by_evidence", rationale: str(i, "rationale") || `card ${str(i, "card_instance_id")} resolved from ${String(obj(i, "evidence")["channel"] ?? "?")} evidence ${String(obj(i, "evidence")["transcript_ref"] ?? "?")} by ${ctx.actor.kind}:${ctx.actor.id}`, subject: { kind: "card_instance", id: str(i, "card_instance_id") } }),
    guardrails: [never("CARD_EVIDENCE_KIND", "32.1 guardrails / 01 §3.5: a consent, a signature or a payment is never resolved from evidence; a spoken yes never resolves a ConsentCard", (i) => str(i, "card_kind") !== "" && !evidenceResolvable({ kind: str(i, "card_kind"), command_ref: str(i, "command_ref") || null }), "only intent and choice cards resolve from out-of-band evidence")] },

  { name: "create_deep_link", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "party_id"); const party_id = str(i, "party_id"); if (!isUuid(party_id)) throw new RangeError("party_id must be the party's uuid");
      const t = obj(i, "target"); const target: DeepLinkTarget | null = typeof t["card_instance_id"] === "string" ? { card_instance_id: t["card_instance_id"] as string } : typeof t["document_id"] === "string" ? { document_id: t["document_id"] as string } : typeof t["route"] === "string" ? { route: t["route"] as string } : str(i, "card_instance_id") ? { card_instance_id: str(i, "card_instance_id") } : null;
      if (!target) throw new RangeError("target {card_instance_id | document_id | route} is required");
      if ("route" in target && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(target.route) === false && /\$|amount|balance|rate=/i.test(target.route)) throw new RangeError("a deep-link route never encodes loan data");
      const token = newDeepLinkToken(); const now = ctx.now; const expires_at = addDaysIso(now, DEEP_LINK_DAYS); const message_id = str(i, "message_id") || null; const single_use = flag(i, "single_use");
      defer(rt, async (q) => { await q.query(`INSERT INTO deep_links (token, party_id, target, expires_at, single_use, created_for_message_id, created_at) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`, [token, party_id, toJson(target), expires_at, single_use, message_id && isUuid(message_id) ? message_id : null, now]); });
      return { token, party_id, target, expires_at, single_use, path: `/d/${token}`, created_for_message_id: message_id };
    }),
    decision: (i, out) => ({ action: "create_deep_link", rationale: `deep link for party ${str(i, "party_id")} → ${JSON.stringify((out as { target: unknown }).target)}`, subject: { kind: "deep_link", id: String((out as { token: string }).token) } }) },
]);

/** A refusal the card tools name themselves (the bus turns a thrown *Refused into {code, gate?, copy_key} at the borrower API). */
export class CardRefused extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.name = "CardRefused"; this.code = code; } }
const summarize = (v: unknown): unknown => (v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 24).map(([k, x]) => [k, typeof x === "bigint" ? x.toString() : x && typeof x === "object" ? "[object]" : x])) : v ?? null);
