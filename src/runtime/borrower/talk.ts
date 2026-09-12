/**
 * Talk — the anonymous minute and sign-in as one conversation (an experiment on top of 32.14).
 *
 *   POST /v1/borrower/talk   { text?: string }   with the `sm_borrower_lead` cookie (x-borrower-lead) and, after sign-in, the session bearer
 *                            → { lead_id, agent, model, transcript: [{role, text, copy_key?, at}], lines: [the new ones], step, session_opened, level }
 *   An empty text on an existing transcript returns it without a model turn (a reload never re-greets). After the range the
 *   visitor is handed to Create account (docs/ux/17 §2.0 — the account is the door; no code by text or e-mail here): the lead
 *   cookie rides to /app/sign-up, where the session links the lead and the thread resumes from its answers (`entry.resumed`).
 *
 * The visitor types (or speaks, in the app) and a language-model agent answers — but the agent never holds a fact, a rate or
 * a decision. Everything that matters is a tool call into the same deterministic machinery the chips and the SMS channel
 * use (32.14 `lead.answer`, `lead.requestRange`), and everything a regulation wants said verbatim (the automation disclosure,
 * the §1026.24 range sentence, the account hand-off) is a `notice` line the endpoint renders
 * from the copy library or the tool's own output — never the model's paraphrase. Guardrails on the model's text: no figure it
 * did not get from a tool, none of the forbidden words (32.13 T14), nothing when the model refuses.
 *
 * The agent is Claude (@anthropic-ai/sdk, tool use on the Messages API; `claude-opus-5` unless TALK_MODEL says otherwise),
 * with ANTHROPIC_API_KEY from Secret Manager. There is no fake agent: without the key the endpoint answers 503
 * TALK_NOT_CONFIGURED and the rest of the API is unaffected. Tests drive the same loop through a scripted API client.
 *
 * The transcript is the lead's own: kind `talk_transcripts`, id = lead id, in the entity store (append-only versions), so a
 * reload continues the conversation and a bounced visitor leaves a record. Nothing here computes a regulatory date, a money
 * figure or a rate; dollars the model reports become bigint cents in code.
 */
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../../kernel/events/index.ts";
import type { Runtime } from "../app.ts";
import type { Logger } from "../log.ts";
import { EntityStore } from "../../app/tools.ts";
import { isUuid, toJson } from "../../infra/db/client.ts";
import type { PgBorrowerUiRepository } from "../../infra/db/borrower-ui.ts";
import { BorrowerAuth, ipOf, userAgentOf, type BorrowerContext } from "./auth.ts";
import { copyOptions, copyText, stepOf, type Step } from "./channels.ts";
import type { BorrowerCommands } from "./commands.ts";
import { BorrowerError, toBorrowerError } from "./errors.ts";
import { partnerOf } from "./flows/3-entry.ts";
import type { BorrowerFlows } from "./flows/index.ts";
import { leadTokenOf, type LeadRoutes } from "./lead-routes.ts";
import { serialize, type ShapeName } from "./serialize.ts";
import { AnthropicLlm, DEFAULT_LLM_MODEL } from "./agent/llm.ts";

type P = Record<string, unknown>;
const BORROWER_APP: Actor = { kind: "agent", id: "borrower-app" };
const INTAKE: Actor = { kind: "agent", id: "intake" };
const RUN = { runId: "talk:borrower-api", modelVersion: "borrower-app talk (deterministic tools)", promptVersion: "talk-1" } as const;
const MAX_BODY = 16 * 1024;
const MAX_TURNS_KEPT = 200;
export const TALK_PATH = "/v1/borrower/talk";
export const DEFAULT_TALK_MODEL = DEFAULT_LLM_MODEL;
/** The hand-off line after the range (docs/ux/12 `account.from_talk`): the app renders the Create account link beside it. */
export const ACCOUNT_HANDOFF_KEY = "account.from_talk";

// ---------------------------------------------------------------- the transcript
export type TalkRole = "you" | "agent" | "notice";
export interface TalkLine { readonly role: TalkRole; readonly text: string; readonly copy_key?: string; readonly at: string }
interface Transcript { lead_id: string; agent: string; turns: TalkLine[]; human_requested: boolean }

// ---------------------------------------------------------------- the tools the agent may call
/** What a tool hands back: a result the model reads, and the lines the visitor sees verbatim (never through the model). */
export interface ToolOutcome { readonly result: P; readonly lines: readonly TalkLine[] }
export type ToolExecutor = (name: string, input: P) => Promise<ToolOutcome>;

/** The situation the agent reasons from each turn — measured from the lead, never remembered by the model. */
export interface Situation {
  readonly step: Step | "signed_in";
  readonly goal: string | null;
  readonly facts: P;
  readonly next_question: string | null;
  readonly options: readonly { id: string; label: string }[];
  readonly partner: string;
  readonly closed: boolean;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "set_fact",
    description: "Record one fact the visitor just gave, for the current step only. goal: buy | lower_rate | cash_out. contract: signed | looking. occupancy: primary | second_home | investment. state: the two-letter USPS code. estimate: give amounts_dollars instead of value (home_value and balance_owed for a refinance or cash-out; price and down_payment for a purchase). Call it once per fact, in the order the steps come. The result names the next step.",
    input_schema: {
      type: "object",
      properties: {
        step: { type: "string", enum: ["goal", "contract", "occupancy", "state", "estimate"] },
        value: { type: "string", description: "The option id or the state code; empty for estimate." },
        amounts_dollars: {
          type: "object",
          description: "Whole dollars the visitor said (estimate step only).",
          properties: { home_value: { type: "number" }, balance_owed: { type: "number" }, price: { type: "number" }, down_payment: { type: "number" } },
          additionalProperties: false,
        },
      },
      required: ["step", "value"],
      additionalProperties: false,
    },
  },
  { name: "show_rates", description: "Show today's published rate range for the visitor's product once every fact is in (the system shows the checked sentence to the visitor verbatim; you never state a rate yourself). Returns whether it was shown.", input_schema: { type: "object", properties: {}, additionalProperties: false }, strict: true },
  { name: "create_account", description: "After the rates are shown: seeing the rate they would actually get needs an account. Call this once; the system shows the Create account step and their answers carry over. Never ask for a phone number, an e-mail address or a code yourself.", input_schema: { type: "object", properties: {}, additionalProperties: false }, strict: true },
  { name: "talk_to_person", description: "The visitor asked for a human. Hand off; the system tells them what happens next.", input_schema: { type: "object", properties: {}, additionalProperties: false }, strict: true },
  { name: "send_message", description: "After sign-in only: pass the visitor's message to their file's conversation and return the reply.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, strict: true },
];
const L0_TOOLS = new Set(["set_fact", "show_rates", "create_account", "talk_to_person"]);
const L1_TOOLS = new Set(["send_message", "talk_to_person"]);

// ---------------------------------------------------------------- the system prompt (stable: cached as a prefix)
export const TALK_SYSTEM = `You are Supermortgage's automated assistant, talking with a visitor who just arrived. Supermortgage is the self-improving mortgage: it checks every loan against the market every day and, when a refinance would put the borrower ahead, does it, covering the third-party costs and passing the gain through as a lower rate. You work for the lender named in the situation block.

How to talk: plain words a 13-year-old reads easily, one or two short sentences, one question at a time, no bullet points, no headings, no emoji. Be warm and quick. Never restate the automation disclosure (the system already showed it). Do not narrate your tools.

What you do: the visitor's goal (buy a home, lower the rate or payment, take cash out), then one follow-up (a signed contract or still looking for a purchase; primary, second home or investment for a refinance), then the state the home is in, then two rough amounts (home value and balance owed, or price and down payment). Ask the step named in the situation block in your own words; when the visitor gives a fact, call set_fact at once — several facts in one message mean several calls in order. Never invent a fact; if it is unclear, ask. When every fact is in, call show_rates. After the rates are shown, call create_account and say in one sentence that seeing the rate they would actually get takes a soft credit check that does not affect their score and starts with an account; the system shows the Create account step. Never ask for a phone number, an e-mail address or a code. After sign-in, use send_message for what they say and tell them their numbers continue in their file.

Hard rules. Never say a rate, an APR, a payment or a dollar figure yourself; the system shows the checked rate sentence to the visitor when show_rates succeeds, and you may only refer to "the rates above". Never use the words guarantee, guaranteed, pre-approved, preapproved, approved, denied or lowest. Before sign-in never ask for or accept income, a Social Security number, date of birth, employer, full name, race, sex, ethnicity, marital status, citizenship, military service, documents or a loan amount; if offered, say you do not need it yet and move on. If the visitor asks for a person, call talk_to_person. If they ask whether you are a person, say you are automated and they can reach a person at any time. If a tool refuses, tell the visitor simply what happened and do not retry the same call.`;

const FORBIDDEN = /\b(guarantee[ds]?|pre-?approved|approved|denied|lowest)\b/i;
const FIGURE = /(\$\s?\d|\d+(\.\d+)?\s?%|\bAPR\b)/i;

// ---------------------------------------------------------------- the agent port
export interface AgentTurnInput { readonly system: string; readonly history: Anthropic.MessageParam[]; readonly situation: Situation; readonly text: string; readonly tools: Anthropic.Tool[]; readonly execute: ToolExecutor }
export interface AgentTurnOutput { readonly text: string; readonly calls: readonly { name: string; input: P }[]; readonly refused?: boolean }
export interface TalkAgent { readonly name: string; readonly model: string | null; turn(input: AgentTurnInput): Promise<AgentTurnOutput> }

const situationText = (s: Situation): string => [
  `Lender: ${s.partner}.`,
  `Current step: ${s.step}.`,
  s.goal ? `Goal so far: ${s.goal}.` : "Goal so far: none.",
  Object.keys(s.facts).length ? `Facts so far: ${Object.entries(s.facts).map(([k, v]) => `${k}=${String(v)}`).join(", ")}.` : "Facts so far: none.",
  s.next_question ? `Question to ask now (in your own words): "${s.next_question}"` : "",
  s.options.length ? `Options for this step: ${s.options.map((o) => `${o.id} ("${o.label}")`).join(", ")}.` : "",
  s.closed ? "The lead is closed (a state we cannot lend in): no rates, no sign-in; be kind and brief." : "",
].filter(Boolean).join("\n");

/** The Claude agent: the shared Messages API loop of agent/llm.ts (AnthropicLlm) over the talk tools; the client is injectable for tests. */
export class ClaudeTalkAgent implements TalkAgent {
  readonly name = "claude";
  readonly model: string;
  private readonly llm: AnthropicLlm;
  constructor(opts: { apiKey?: string | undefined; model?: string | undefined; effort?: "low" | "medium" | "high" | undefined; client?: Anthropic | undefined; logger?: Logger | undefined }) {
    this.llm = new AnthropicLlm({ apiKey: opts.apiKey, model: opts.model || DEFAULT_TALK_MODEL, effort: opts.effort ?? "low", client: opts.client, logger: opts.logger });
    this.model = this.llm.model;
  }
  async turn(input: AgentTurnInput): Promise<AgentTurnOutput> {
    const messages: Anthropic.MessageParam[] = [...input.history, { role: "user", content: `[situation]\n${situationText(input.situation)}\n\n[visitor]\n${input.text || "(the visitor just arrived and has not said anything yet — greet them and ask the first question)"}` }];
    const r = await this.llm.turn({ system: input.system, messages, tools: input.tools, maxTokens: 1024, execute: async (name, args) => {
      try { const outcome = await input.execute(name, args); return { result: outcome.result, is_error: !!outcome.result["error"] }; }
      catch (e) { const be = toBorrowerError(e); return { result: { error: be.code, message: be.message }, is_error: true }; }
    } });
    const calls = r.calls.map((c) => ({ name: c.name, input: c.input }));
    return r.refused ? { text: "", calls, refused: true } : { text: r.text, calls };
  }
}

// ---------------------------------------------------------------- the endpoint
export interface TalkOptions { readonly model?: string | undefined; readonly apiKey?: string | undefined; readonly effort?: "low" | "medium" | "high" | undefined; /** tests: a scripted client in place of the network */ readonly client?: Anthropic | undefined }
export interface TalkDeps {
  readonly runtime: Runtime; readonly logger: Logger; readonly auth: BorrowerAuth; readonly ui: PgBorrowerUiRepository; readonly flows: BorrowerFlows; readonly commands: BorrowerCommands; readonly leads: LeadRoutes;
  readonly nonProduction: boolean; readonly defaultPartnerId?: string | undefined; readonly defaultPartnerNmlsrId?: string | undefined; readonly talk?: TalkOptions | undefined;
}
export interface TalkRoutes { handle(req: IncomingMessage, res: ServerResponse): Promise<void>; readonly agent: TalkAgent | null }

/** The agent, or null when no key is configured (the endpoint then answers 503 TALK_NOT_CONFIGURED; nothing else changes). */
export function chooseAgent(o: TalkOptions | undefined, logger?: Logger): TalkAgent | null {
  const key = (o?.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "").trim();
  if (!key && !o?.client) return null;
  return new ClaudeTalkAgent({ apiKey: key, model: o?.model ?? process.env["TALK_MODEL"], effort: o?.effort ?? (process.env["TALK_EFFORT"] as "low" | "medium" | "high" | undefined), client: o?.client, logger });
}

const OPTION_LABEL_KEY: Readonly<Record<string, string>> = { goal: "entry.goal.question", contract: "entry.buy.contract_question", occupancy: "entry.occupancy.question", state: "entry.state.question" };
const OPTION_IDS: Readonly<Record<string, readonly string[]>> = { goal: ["buy", "lower_rate", "cash_out"], contract: ["signed", "looking"], occupancy: ["primary", "second_home", "investment"] };
function questionFor(step: Step, lead: P): { question: string | null; options: { id: string; label: string }[] } {
  const purchase = lead["transaction_intent"] === "purchase";
  if (step === "estimate") return { question: purchase ? `${copyText("entry.estimate.price_range")} ${copyText("entry.estimate.down_payment")}` : `${copyText("entry.estimate.value")} ${copyText("entry.estimate.balance")}`, options: [] };
  if (step === "state") return { question: copyText("entry.state.question"), options: [] };
  const key = OPTION_LABEL_KEY[step]; if (!key) return { question: null, options: [] };
  const labels = copyOptions(key); const ids = OPTION_IDS[step] ?? [];
  return { question: copyText(key), options: ids.map((id, i) => ({ id, label: labels[i] ?? id })) };
}
const cents = (dollars: unknown): string | null => { const n = Number(dollars); return Number.isFinite(n) && n >= 0 ? (BigInt(Math.round(n)) * 100n).toString() : null; };

export function createTalkRoutes(deps: TalkDeps): TalkRoutes {
  const { runtime, logger, auth, ui, flows, commands, leads } = deps;
  const agent = chooseAgent(deps.talk, logger);
  const now = (): string => runtime.clock.now();
  const exec = (process: string, name: string, input: P, actor: Actor = BORROWER_APP) => runtime.execute({ process, name, loanId: "", actor, input, run: { ...RUN } });
  const send = (res: ServerResponse, status: number, shape: ShapeName, body: unknown): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(toJson(serialize(shape, body))); };
  const leadOf = async (id: string): Promise<P | null> => (await runtime.entities.current("leads", id))?.data ?? null;
  const rangeShown = async (leadId: string): Promise<boolean> => (await runtime.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'lead.range.shown' AND (payload->>'lead_id' = $1 OR (aggregate_kind = 'lead' AND aggregate_id = $1))`, [leadId]))[0]?.n !== "0";
  const nmlsrOf = async (lead: P): Promise<string> => { const configured = (deps.defaultPartnerNmlsrId ?? process.env["BORROWER_DEFAULT_PARTNER_NMLSR_ID"] ?? "").trim(); if (configured) return configured; const id = String(lead["partner_id"] ?? ""); const row = id ? await runtime.entities.current("partners", id) : undefined; return String(row?.data["nmlsr_id"] ?? "").trim(); };
  const partnerTokens = (lead: P): Record<string, string> => ({ "partner.legal_name": String(lead["partner_name"] ?? "") });
  const interactionOf = (lead: P): string | null => { const all = (lead["interactions"] as P[] | undefined) ?? []; return String(all.at(-1)?.["interaction_id"] ?? "") || null; };

  async function readBody(req: IncomingMessage): Promise<P> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new RangeError(`request body over ${MAX_BODY} bytes`); chunks.push(c as Buffer); }
    const b = Buffer.concat(chunks); if (!b.length) return {};
    const v = JSON.parse(b.toString("utf8")) as unknown; if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError("request body must be a JSON object"); return v as P;
  }

  // ---- the transcript in the entity store (the lead's own record; append-only versions)
  async function loadTranscript(leadId: string): Promise<Transcript> {
    const cur = await runtime.entities.current("talk_transcripts", leadId);
    return cur ? (cur.data as unknown as Transcript) : { lead_id: leadId, agent: agent?.name ?? "", turns: [], human_requested: false };
  }
  async function saveTranscript(t: Transcript, at: string): Promise<void> {
    const store = new EntityStore(); store.seed(await runtime.entities.load({})); const mark = store.versionCount();
    await runtime.uow.run({}, () => { store.put("talk_transcripts", t.lead_id, { ...t, turns: t.turns.slice(-MAX_TURNS_KEPT) } as unknown as P, BORROWER_APP, at); return null; }, { clock: runtime.clock, commit: async (q) => { await runtime.entities.save(store.versionsSince(mark), {}, q); } });
  }
  const history = (t: Transcript): Anthropic.MessageParam[] => {
    const out: Anthropic.MessageParam[] = [];
    for (const l of t.turns) {
      const role = l.role === "you" ? "user" : "assistant"; const text = l.role === "notice" ? `[shown to the visitor by the system] ${l.text}` : l.text;
      const last = out.at(-1);
      if (last && last.role === role && typeof last.content === "string") last.content = `${last.content}\n${text}`; else out.push({ role, content: text });
    }
    if (out.length && out[0]!.role === "assistant") out.unshift({ role: "user", content: "(the visitor arrived)" });
    return out;
  };

  // ---- the lead behind the cookie, or a new one (the same start as POST /v1/borrower/lead: partner, lead.start, the disclosure first)
  async function leadFor(req: IncomingMessage, at: string): Promise<{ lead_id: string; lead: P; lead_token: string | null; started: boolean }> {
    const token = leadTokenOf(req);
    if (token) { const row = await leads.tokens.byToken(token); const lead = row && Date.parse(row.expires_at) > Date.parse(at) ? await leadOf(row.lead_id) : null; if (row && lead && lead["status"] !== "expired") { await leads.tokens.touch(row.token_hash, at); return { lead_id: row.lead_id, lead, lead_token: null, started: false }; } }
    const partner = await partnerOf({ runtime, ui, logger, defaultPartnerId: deps.defaultPartnerId });
    if (!partner) throw new BorrowerError(503, "NOT_WIRED", undefined, "no partner: BORROWER_DEFAULT_PARTNER_ID is unset and no servicer party exists (32.14 DELTA-15)");
    const lead_id = randomUUID(); const interaction_id = randomUUID();
    await exec("32.2", "lead.start", { partner_id: partner.id, partner_name: partner.legal_name, party_id: null, lead_id, interaction_id, channel: "web_chat", lead_channel: "organic", consumer_state: null, time_zone: "America/New_York", utm: { channel: "talk", agent: agent?.name ?? "" } });
    await exec("32.2", "lead.acknowledgeAiDisclosure", { lead_id, interaction_id, notice_id: `n-disc-${interaction_id.slice(0, 8)}`, party_id: null });
    const created = await leads.tokens.create({ lead_id, partner_party_id: isUuid(partner.id) ? partner.id : null, now: at, ip: ipOf(req), user_agent: userAgentOf(req) });
    logger.info("borrower.talk.lead.started", { lead_id, partner_id: partner.id, agent: agent?.name ?? null });
    return { lead_id, lead: (await leadOf(lead_id)) ?? {}, lead_token: created.token, started: true };
  }

  async function situationOf(leadId: string, lead: P, t: Transcript, ctx: BorrowerContext | null): Promise<Situation> {
    const step: Step | "signed_in" = ctx ? "signed_in" : stepOf(lead, await rangeShown(leadId));
    const q = ctx || step === "range" || step === "identify" || step === "closed" ? { question: null, options: [] } : questionFor(step as Step, lead);
    const facts: P = {};
    for (const k of ["transaction_intent", "contract_status", "occupancy", "consumer_state", "value_estimate_cents", "stated_existing_balance_cents", "price_range_cents", "down_payment_cents"]) if (lead[k] !== undefined && lead[k] !== null && lead[k] !== "") facts[k] = lead[k];
    return { step, goal: (lead["transaction_intent"] as string | undefined) ?? null, facts, next_question: q.question, options: q.options, partner: String(lead["partner_name"] ?? ""), closed: step === "closed" };
  }

  // ---- the tools
  function executor(req: IncomingMessage, leadId: string, t: Transcript, ctx: BorrowerContext | null, at: string): ToolExecutor {
    const line = (role: TalkRole, text: string, copy_key?: string): TalkLine => ({ role, text, ...(copy_key ? { copy_key } : {}), at });
    return async (name, input) => {
      const allowed = ctx ? L1_TOOLS : L0_TOOLS;
      if (!allowed.has(name)) return { result: { error: "TOOL_NOT_ALLOWED", message: `${name} is not available ${ctx ? "after" : "before"} sign-in` }, lines: [] };
      const lead = (await leadOf(leadId)) ?? {};
      if (name === "set_fact") {
        const step = String(input["step"] ?? ""); const lines: TalkLine[] = [];
        let value: unknown = String(input["value"] ?? "");
        if (step === "estimate") {
          const a = (input["amounts_dollars"] && typeof input["amounts_dollars"] === "object" ? (input["amounts_dollars"] as P) : {});
          const purchase = lead["transaction_intent"] === "purchase";
          value = purchase ? { price_range_cents: cents(a["price"]), down_payment_cents: cents(a["down_payment"]) } : { value_estimate_cents: cents(a["home_value"]), stated_existing_balance_cents: cents(a["balance_owed"]) };
          if (Object.values(value as P).some((v) => v === null)) return { result: { error: "AMOUNTS_REQUIRED", message: purchase ? "price and down_payment in whole dollars are both needed" : "home_value and balance_owed in whole dollars are both needed" }, lines: [] };
        }
        const r = await exec("32.14", "lead.answer", { lead_id: leadId, step, value });
        const out = (r.output ?? {}) as P;
        for (const l of ((out["lines"] as P[] | undefined) ?? [])) { const key = String(l["copy_key"] ?? ""); if (key) lines.push(line("notice", copyText(key, { ...partnerTokens(lead), ...((l["copy_tokens"] as Record<string, string> | undefined) ?? {}) }), key)); }
        const after = (await leadOf(leadId)) ?? lead;
        const closed = out["closed"] ?? (after["status"] === "closed_lost" ? { reason: after["closed_reason"] } : null);
        if (closed && !lines.some((l) => l.copy_key === "lead.state_closed")) lines.push(line("notice", copyText("lead.state_closed", { state: String(after["consumer_state"] ?? "") }), "lead.state_closed"));
        const nextStep = closed ? "closed" : stepOf(after, await rangeShown(leadId));
        const q = nextStep === "range" || nextStep === "identify" || nextStep === "closed" ? { question: null, options: [] } : questionFor(nextStep, after);
        return { result: { ok: true, recorded: { step, value }, closed: closed ?? null, next_step: nextStep === "range" ? null : { id: nextStep, question: q.question, options: q.options }, all_facts_in: nextStep === "range" }, lines };
      }
      if (name === "show_rates") {
        const r = await exec("32.14", "lead.requestRange", { lead_id: leadId, at, partner_nmlsr_id: await nmlsrOf(lead) });
        const out = (r.output ?? {}) as P; const range = (out["range"] && typeof out["range"] === "object" ? (out["range"] as P) : null);
        if (!range || typeof range["text"] !== "string") return { result: { shown: false, refused: out["refused"] ?? "RANGE_CONTENT_CHECK", message: "the published range could not be shown; go on to the sign-in ask without a number" }, lines: [] };
        return { result: { shown: true, note: "the checked rate sentence was shown to the visitor; refer to it as the rates above" }, lines: [line("notice", String(range["text"]), "entry.range.card"), line("notice", copyText("entry.range.promise"), "entry.range.promise")] };
      }
      if (name === "create_account") {
        // docs/ux/17 §2.0: the account is the door — no code by text or e-mail here; the lead cookie rides to /app/sign-up and the session resumes from the lead
        return { result: { shown: true, note: "the Create account step is shown; tell them in one sentence and stop asking questions" }, lines: [line("notice", copyText(ACCOUNT_HANDOFF_KEY), ACCOUNT_HANDOFF_KEY)] };
      }
      if (name === "talk_to_person") {
        if (ctx) { await commands.runCommand(ctx, "human.request", { reason: "talk" }, at); }
        else { const interaction_id = interactionOf(lead); if (interaction_id) await exec("20.3", "deliverDisclosure", { op: "transfer_to_human", lead_id: leadId, interaction_id, reason: "consumer_request" }, INTAKE); }
        t.human_requested = true;
        return { result: { requested: true }, lines: [line("notice", copyText("thread.human_requested"), "thread.human_requested")] };
      }
      if (name === "send_message") {
        if (!ctx) return { result: { error: "AUTH_REQUIRED" }, lines: [] };
        const r = await commands.borrowerMessage(ctx, { text: String(input["text"] ?? ""), channel: "app" }, at);
        const text = (r.reply.body_text ?? `{{copy:${r.reply.copy_key}}}`).replace(/\{\{copy:([a-z0-9_.]+)\}\}/g, (_all, k: string) => copyText(k, partnerTokens(lead)));
        return { result: { reply: text, routed_to: r.routed_to, command_executed: r.command_executed }, lines: [] };
      }
      return { result: { error: "UNKNOWN_TOOL" }, lines: [] };
    };
  }
  const answersOf = (lead: P): string => [({ purchase: "buy a home", limited_cash_out: "lower my rate", cash_out: "cash out" } as Record<string, string>)[String(lead["transaction_intent"])], lead["occupancy"] ? String(lead["occupancy"]).replace("_", " ") + " home" : null, lead["contract_status"] ? (lead["contract_status"] === "signed" ? "contract signed" : "still looking") : null, lead["consumer_state"] ? String(lead["consumer_state"]) : null].filter(Boolean).join(" · ");

  /** The model's sentence through the guard: no figure it did not get from a tool, none of the forbidden words. */
  function guard(text: string, shownRange: boolean): { text: string; guarded: string | null } {
    if (!text) return { text, guarded: null };
    if (FORBIDDEN.test(text)) return { text: "Let me put that another way. What would you like to do next?", guarded: "forbidden_word" };
    if (!shownRange && FIGURE.test(text)) return { text: "I can't give a number yet, but I can get you today's published rates in a moment. What's the next thing you can tell me?", guarded: "figure_before_range" };
    return { text, guarded: null };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now(); const at = now();
    try {
      if (!agent) throw new BorrowerError(503, "TALK_NOT_CONFIGURED", undefined, "ANTHROPIC_API_KEY is not set: the conversational entry needs the model (docs/DEPLOY.md \"Talk\")");
      const b = await readBody(req); const text = typeof b["text"] === "string" ? (b["text"] as string).trim().slice(0, 2000) : "";
      let ctx: BorrowerContext | null = null;
      if (String(req.headers["authorization"] ?? "")) { try { ctx = await auth.authenticate(req, at); } catch { ctx = null; } }
      const { lead_id, lead_token, started: fresh } = await leadFor(req, at);
      const t = await loadTranscript(lead_id); const before = t.turns.length;
      // a reload (no text) on a transcript that already has the agent's opening never re-greets: the transcript comes back as it is
      if (!text && !fresh && t.turns.some((l) => l.role === "agent")) {
        const step0 = ctx ? "signed_in" : stepOf((await leadOf(lead_id)) ?? {}, await rangeShown(lead_id));
        send(res, 200, "talk_turn", { lead_id, agent: agent.name, model: agent.model, transcript: t.turns, lines: [], step: step0, session_opened: false, level: ctx?.session.level ?? null }); return;
      }
      if (fresh || !t.turns.length) {
        const lead0 = (await leadOf(lead_id)) ?? {};
        t.turns.push({ role: "notice", text: copyText("entry.disclosure.first", partnerTokens(lead0)), copy_key: "entry.disclosure.first", at });
        // a lead that already carries answers (the chip flow, an earlier visit on this cookie) is read back before the model picks up mid-way: `entry.resumed`, the same receipt sign-in uses
        const answers = answersOf(lead0); if (!fresh && answers) t.turns.push({ role: "notice", text: copyText("entry.resumed", { answers }), copy_key: "entry.resumed", at });
      }
      if (text) t.turns.push({ role: "you", text, at });
      const lead = (await leadOf(lead_id)) ?? {};
      const situation = await situationOf(lead_id, lead, t, ctx);
      const pending: TalkLine[] = [];
      const execute = executor(req, lead_id, t, ctx, at);
      const traced: ToolExecutor = async (name, input) => { const o = await execute(name, input); pending.push(...o.lines); logger.info("borrower.talk.tool", { lead_id, tool: name, ok: !o.result["error"], error: o.result["error"] ?? null }); return o; };
      const prior = text ? t.turns.slice(0, -1) : t.turns;   // the history is everything before this message; the message itself rides in the situation turn
      const out = await agent.turn({ system: TALK_SYSTEM, history: history({ ...t, turns: prior }), situation, text, tools: TOOLS, execute: traced });
      const g = guard(out.text, pending.some((l) => l.copy_key === "entry.range.card") || (await rangeShown(lead_id)));
      if (g.guarded) logger.warn("borrower.talk.guard", { lead_id, guarded: g.guarded, agent: agent.name });
      t.turns.push(...pending);
      const agentText = out.refused ? copyText("error.generic") : g.text;
      if (agentText) t.turns.push({ role: "agent", text: agentText, at });
      t.agent = agent.name;
      await saveTranscript(t, at);
      const after = (await leadOf(lead_id)) ?? lead; const step = ctx ? "signed_in" : stepOf(after, await rangeShown(lead_id));
      logger.info("borrower.talk.turn", { lead_id, agent: agent.name, model: agent.model, step, calls: out.calls.map((c) => c.name), guarded: g.guarded, ms: Date.now() - started });
      send(res, 200, "talk_turn", { lead_id, agent: agent.name, model: agent.model, transcript: t.turns, lines: t.turns.slice(before), step, session_opened: false, level: ctx?.session.level ?? null, ...(lead_token ? { lead_token } : {}) });
    } catch (e) {
      const be = toBorrowerError(e);
      if (be.status >= 500) logger.error("borrower.talk.unhandled", { error: e });
      send(res, be.status, "error", be.body());
      logger.info("http", { method: "POST", path: TALK_PATH, status: be.status, ms: Date.now() - started, surface: "borrower", code: be.code, reason: be.message });
    }
  }
  return { handle, agent };
}

