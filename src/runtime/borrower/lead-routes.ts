/**
 * The anonymous minute's HTTP layer (32.14 DELTA-11; docs/ux/15-entry-sign-up-and-sign-in.md §2 S0–S2, §4, §6.1):
 *
 *   POST /v1/borrower/lead    NO session. The proxy (apps/borrower/app/api/[...path]/route.ts) keeps the lead token in the HttpOnly
 *                             cookie `sm_borrower_lead` and forwards it as the header `x-borrower-lead`; the browser never sees it.
 *     { action: "start", channel: "web_chat", referral?, utm? }   → 32.2 lead.start (global scope, party_id null) + lead.acknowledgeAiDisclosure
 *                                                                  (no tap) → { lead_token, lead_id, partner, lines: [the disclosure], step: goal }.
 *                                                                  A live lead cookie answers that lead's state instead. LEAD_START_PER_HOUR per IP.
 *     { action: "state" }                                         → the lead's current { lead_id, lines, step, closed?, range? } (a reload); 404 LEAD_UNKNOWN when stale.
 *     { action: "answer", step, value }                           → 32.14 lead.answer (20.3 set_fact; the state gate through 31.1; UT/CA re-log; CO pre-use) →
 *                                                                  { lead_id, lines: [new lines], step: next | null, closed? }; 409 L0_FACTS_ONLY / STATE_GATE_FIRST / STEP_ORDER / LEAD_CLOSED.
 *     { action: "range" }                                         → 32.14 lead.requestRange (20.3 rule 7 through 20.2's checklist) → { range, card, promise_copy_key,
 *                                                                  disclaimer_copy_key, next: identify } or { range: null, refused: RANGE_CONTENT_CHECK, next }.
 *
 *   linkAtVerify(req, party_id, at)   the OTP-verify, passkey-assert and OIDC-callback routes call this before `flows.sessionOpened`: the lead behind
 *                                     the cookie is linked to the party (`lead.linked{party_id}` on the lead; lead_tokens.linked_party_id) and its id rides
 *                                     on the SessionOpened object so flows/14-entry-lead.ts creates the application from it.
 *
 * The routes call `runtime.execute` in global scope with the `borrower-app` actor — not BorrowerCommands.runCommand, which needs an
 * authenticated context. Every answer goes through the serializer (`lead_state` / `lead_answer` / `lead_range`); the token leaves the
 * API once (start) and is never echoed. No personal fact is ever accepted here (L0_FACTS_ONLY at the edge, again inside lead.answer).
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Runtime } from "../app.ts";
import type { Logger } from "../log.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { EntityStore } from "../../app/tools.ts";
import { isUuid, toJson } from "../../infra/db/client.ts";
import { entryPartner, partnerById } from "./partner.ts";
import { PgLeadTokenRepository, type LeadTokenRow } from "../../infra/db/lead-tokens.ts";
import { linkParty, PROGRAM_MAX_LTV_PCT, type Lead } from "../../domain/leads-pricing/ops-20-3.ts";
import { BorrowerError, toBorrowerError } from "./errors.ts";
import { serialize, type ShapeName } from "./serialize.ts";
import { ipOf, userAgentOf } from "./auth.ts";
import type { BorrowerFlows } from "./flows/index.ts";
import { transactionTypeOf, type TransactionType } from "./flows/14-entry-lead.ts";

export const LEAD_HEADER = "x-borrower-lead";
export const LEAD_START_PER_HOUR = 20;
export const LEAD_PATH = "/v1/borrower/lead";
const BORROWER_APP: Actor = { kind: "agent", id: "borrower-app" };
const RUN = { runId: "lead:borrower-api", modelVersion: "borrower-app api (deterministic)", promptVersion: "32.14" } as const;
const MAX_BODY = 64 * 1024;
type P = Record<string, unknown>;

/** 20.3 rule 6 / 32.14 §2 S1 "never at S1": the fact names that are never lead facts — refused at the edge as L0_FACTS_ONLY before any tool runs (and again inside lead.answer). */
export const FORBIDDEN_LEAD_FACTS: ReadonlySet<string> = new Set(["income", "income_cents", "monthly_income", "monthly_income_cents", "stated_income_cents", "name", "legal_name", "first_name", "last_name", "email", "phone", "mobile", "ssn", "tin", "ssn_last4", "tin_last4", "date_of_birth", "dob",
  "ethnicity", "race", "sex", "demographics", "demographic", "marital_status", "citizenship", "citizenship_status", "documents", "document", "military_service", "military", "loan_amount", "loan_amount_sought", "loan_amount_sought_cents", "alimony", "child_support", "dependents", "address", "current_address"]);
export const STEPS = ["goal", "contract", "occupancy", "state", "estimate"] as const;
export type StepId = (typeof STEPS)[number];
export const GOALS: Readonly<Record<string, TransactionType>> = { buy: "purchase", lower_rate: "limited_cash_out", cash_out: "cash_out" };
export const US_STATES: readonly string[] = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"];
/** Copy keys of the lines the anonymous minute renders (docs/ux/12 "Entry, sign-up and sign-in (32.14)"; the Colorado pre-use line's key is the one section32-14.ts names — requested in COPY-REQUESTS.md). */
export const LEAD_LINE_COPY: Readonly<Record<string, string>> = { "lead.disclosure.delivered": "entry.disclosure.first", "co_admt.preuse_notice.delivered": "entry.disclosure.co_admt", "lead.closed": "lead.state_closed" };
const IDENTIFY_STEP = { id: "identify", kind: "ChoiceCard", copy_key: "auth.choose_method", options: [{ id: "sms" }, { id: "email" }, { id: "google" }] } as const;

export interface LeadRoutesOptions { readonly runtime: Runtime; readonly logger: Logger; readonly flows?: BorrowerFlows | undefined; /** the Phase I partner from configuration (DELTA-15); the referral's partner overrides it */ readonly defaultPartnerId?: string | undefined; readonly defaultPartnerNmlsrId?: string | undefined; readonly now?: () => string }
export interface LeadRoutes {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
  /** The link at verify (OTP / passkey / OIDC): returns the linked lead's id, or null when no live lead cookie rode on the request. Never fails the sign-in. */
  linkAtVerify(req: IncomingMessage, partyId: string, at: string): Promise<string | null>;
  readonly tokens: PgLeadTokenRepository;
}

async function readBody(req: IncomingMessage): Promise<P> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new RangeError(`request body over ${MAX_BODY} bytes`); chunks.push(c as Buffer); }
  const b = Buffer.concat(chunks); if (!b.length) return {};
  const v = JSON.parse(b.toString("utf8")) as unknown; if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError("request body must be a JSON object"); return v as P;
}
const str = (b: P, k: string): string => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
export const leadTokenOf = (req: IncomingMessage): string => { const h = req.headers[LEAD_HEADER]; const s = Array.isArray(h) ? h[0] : h; return typeof s === "string" ? s.trim() : ""; };
const centsStr = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : typeof v === "bigint" ? v.toString() : /^\d+$/.test(String(v)) ? String(v) : null);
/** The names a client posted, at the top level and inside `value` / `fact` (one level down). */
const postedNames = (b: P): string[] => { const out = new Set<string>(); for (const k of Object.keys(b)) out.add(k); for (const k of ["value", "fact", "facts"]) { const v = b[k]; if (v && typeof v === "object" && !Array.isArray(v)) for (const kk of Object.keys(v as P)) out.add(kk); } if (typeof b["step"] === "string") out.add(b["step"] as string); if (typeof b["fact"] === "string") out.add(b["fact"] as string); return [...out]; };

/** The next chip from the lead's own facts on a reload (order fixed: goal → contract | occupancy → state → estimate; the same descriptor section32-14.ts's `stepCard` answers), or null when the give-back is next. Nothing preselected: the tap is required. */
export function nextStepOf(lead: P): P | null {
  const goal = transactionTypeOf(lead);
  if (!goal) return { id: "goal", kind: "ChoiceCard", copy_key: "entry.goal.question", options: Object.entries(GOALS).map(([id, transaction_type]) => ({ id, transaction_type })), preselected: null };
  if (goal === "purchase" && !lead["contract_status"]) return { id: "contract", kind: "ChoiceCard", copy_key: "entry.buy.contract_question", options: [{ id: "signed" }, { id: "looking" }], preselected: null };
  if (goal !== "purchase" && !lead["occupancy"]) return { id: "occupancy", kind: "ChoiceCard", copy_key: "entry.occupancy.question", options: [{ id: "primary" }, { id: "second_home" }, { id: "investment" }], preselected: null };
  if (!lead["consumer_state"]) return { id: "state", kind: "ChoiceCard", copy_key: "entry.state.question", options: US_STATES.map((id) => ({ id })), preselected: null };
  if (goal === "purchase") { if (centsStr(lead["price_range_cents"]) === null) return normalizeStep({ id: "estimate", kind: "ConfirmCard", fields: [{ id: "price_range_cents", copy_key: "entry.estimate.price_range", kind: "money" }, { id: "down_payment_cents", copy_key: "entry.estimate.down_payment", kind: "money" }] }, goal); }
  else if (centsStr(lead["value_estimate_cents"]) === null) return normalizeStep({ id: "estimate", kind: "ConfirmCard", fields: [{ id: "value_estimate_cents", copy_key: "entry.estimate.value", kind: "money" }, { id: "stated_existing_balance_cents", copy_key: "entry.estimate.balance", kind: "money" }] }, goal);
  return null;
}
/** The step as the wire carries it: the estimate step names no copy_key of its own (each field is one accessible name — a duplicate is an a11y defect); a cash-out estimate carries the 80% cap as a plain limit `{max_ltv_pct: "80"}` (PROGRAM_MAX_LTV_PCT.cash_out, a decimal string), never a decline. */
export function normalizeStep(step: P | null, goal: TransactionType | null): P | null {
  if (!step || step["id"] !== "estimate") return step;
  const { copy_key: _copyKey, max_ltv_pct: _cap, ltv_cap_is_a_limit_not_a_decline: _flag, ...rest } = step;
  return { ...rest, ...(goal === "cash_out" ? { limit: { max_ltv_pct: String(PROGRAM_MAX_LTV_PCT.cash_out) } } : {}) };
}
/** A lead a closed state ended (no range, no identity ask), or an expired one; null while it is live. */
export const closedOf = (lead: P): { reason: string; copy_key: string; gate?: string; state?: string | null } | null => (lead["status"] === "closed_lost" ? { reason: String(lead["closed_reason"] ?? "closed"), copy_key: "lead.state_closed", ...(lead["closed_reason"] === "state_not_licensed" ? { gate: "SM_LICENSE_STATE_GATE", state: (lead["consumer_state"] as string | null) ?? null } : {}) } : lead["status"] === "expired" ? { reason: "expired", copy_key: "lead.state_closed" } : null);

export function createLeadRoutes(opts: LeadRoutesOptions): LeadRoutes {
  const { runtime, logger } = opts;
  const now = opts.now ?? ((): string => runtime.clock.now());
  const tokens = new PgLeadTokenRepository(runtime.db);
  const starts = new Map<string, number[]>();   // per-IP start instants within the hour (in-memory, best effort across instances; Cloud Armor's 300/min sits in front)
  const send = (res: ServerResponse, status: number, shape: ShapeName, body: unknown): void => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(toJson(serialize(shape, body))); };
  const exec = (process: string, name: string, input: P, actor: Actor = BORROWER_APP) => runtime.execute({ process, name, loanId: "", actor, input, run: { ...RUN } });

  function throttle(ip: string | null, at: string): void {
    const key = ip ?? "?"; const t = Date.parse(at); const kept = (starts.get(key) ?? []).filter((x) => x > t - 3_600_000);
    if (kept.length >= LEAD_START_PER_HOUR) throw new BorrowerError(429, "LEAD_THROTTLED", undefined, `${LEAD_START_PER_HOUR} lead starts per hour per IP`);
    kept.push(t); starts.set(key, kept);
  }
  /** The partner's NMLSR ID for the §1026.24 footer: the configured one (DELTA-15) when set, else the global `partners/<id>` row 20.3 and the demo seed keep, else "" (20.2's checklist then refuses the range). */
  async function nmlsrOf(partnerId: string): Promise<string> {
    const configured = (opts.defaultPartnerNmlsrId ?? process.env["BORROWER_DEFAULT_PARTNER_NMLSR_ID"] ?? "").trim();
    if (configured) return configured;
    const row = partnerId ? await runtime.entities.current("partners", partnerId) : undefined;
    return String(row?.data["nmlsr_id"] ?? "").trim();
  }
  /** The partner the lead is opened for: the referral's partner party when it names one, else the configured Phase I partner (DELTA-15), else the newest servicer party. */
  async function partnerFor(referral: P): Promise<{ id: string; legal_name: string; nmlsr_id: string }> {
    const wanted = str(referral, "partner_party_id") || str(referral, "partner_id");
    const configured = opts.defaultPartnerId ?? process.env["BORROWER_DEFAULT_PARTNER_ID"] ?? "";
    // partner.ts: the referral's party, else the configured partner, else the newest servicer party that is not Supermortgage — never Supermortgage as the lender
    const row = (await partnerById(runtime.db, wanted)) ?? (await entryPartner(runtime.db, configured));
    if (!row) throw new BorrowerError(503, "NOT_WIRED", undefined, "no partner: BORROWER_DEFAULT_PARTNER_ID is unset and no partner party exists (32.14 DELTA-15)");
    return { ...row, nmlsr_id: await nmlsrOf(row.id) };
  }
  const leadOf = async (leadId: string): Promise<P | null> => { const r = await runtime.entities.current("leads", leadId); return r ? r.data : null; };
  /** The live lead behind the request's cookie: 404 LEAD_UNKNOWN when there is none or it is stale. */
  async function liveLead(req: IncomingMessage, at: string): Promise<{ row: LeadTokenRow; lead: P }> {
    const token = leadTokenOf(req); if (!token) throw new BorrowerError(404, "LEAD_UNKNOWN");
    const row = await tokens.byToken(token); if (!row || Date.parse(row.expires_at) <= Date.parse(at)) throw new BorrowerError(404, "LEAD_UNKNOWN");
    const lead = await leadOf(row.lead_id); if (!lead || lead["status"] === "expired") throw new BorrowerError(404, "LEAD_UNKNOWN");
    await tokens.touch(row.token_hash, at);
    return { row, lead };
  }
  interface LeadEvent { readonly id: string; readonly sequence: string; readonly type: string; readonly occurred_at: string; readonly payload: P }
  /** The lead's own events (its aggregate; the pre-use notice 21.6 keys on the lead's id as the application it becomes; 31.1's gate names the lead). */
  const leadEvents = (leadId: string, afterSeq = "0"): Promise<LeadEvent[]> => runtime.db.query<LeadEvent & Record<string, unknown>>(
    `SELECT id, sequence::text AS sequence, type, occurred_at, payload FROM loan_events WHERE ((aggregate_kind = 'lead' AND aggregate_id = $1) OR payload->>'lead_id' = $1 OR payload->>'application_id' = $1) AND sequence > $2::bigint ORDER BY loan_events.sequence`, [leadId, afterSeq]);
  const lastSeq = async (leadId: string): Promise<string> => (await runtime.db.query<{ s: string | null }>(`SELECT max(sequence)::text AS s FROM loan_events WHERE (aggregate_kind = 'lead' AND aggregate_id = $1) OR payload->>'lead_id' = $1 OR payload->>'application_id' = $1`, [leadId]))[0]?.s ?? "0";
  /** Lines from events: the disclosure (with its state variant), the Colorado pre-use line, the closed-state line — copy references with tokens, never loan data. */
  function linesOf(events: readonly LeadEvent[], partner: { legal_name: string }): P[] {
    const out: P[] = [];
    for (const e of events) {
      const copy_key = LEAD_LINE_COPY[e.type]; if (!copy_key) continue;
      if (e.type === "lead.closed" && e.payload["reason"] !== "state_not_licensed") continue;
      const tokens: P = { "partner.legal_name": partner.legal_name };
      if (e.type === "lead.disclosure.delivered") { tokens["state_variant"] = e.payload["state_variant"] ?? null; tokens["reason"] = e.payload["reason"] ?? null; }
      if (e.type === "lead.closed") tokens["state"] = e.payload["state"] ?? null;
      out.push({ message_id: e.id, at: e.occurred_at, sender: "agent", automation_marker: true, copy_key, copy_tokens: tokens, event_type: e.type });
    }
    return out;
  }
  const rangeOf = (events: readonly LeadEvent[]): P | null => { const e = events.filter((x) => x.type === "lead.range.shown").at(-1); return e ? rangeShape(e.payload) : null; };
  const rangeShape = (p: P): P => ({ low_pct: p["low_pct"] ?? null, high_pct: p["high_pct"] ?? null, apr_low_pct: p["apr_low_pct"] ?? null, apr_high_pct: p["apr_high_pct"] ?? null, product_code: p["product_code"] ?? null, rate_sheet_id: p["rate_sheet_id"] ?? null, text: p["text"] ?? null, checklist_run_id: p["checklist_run_id"] ?? null });
  const partnerOfLead = async (lead: P): Promise<{ legal_name: string; nmlsr_id: string }> => ({ legal_name: String(lead["partner_name"] ?? ""), nmlsr_id: await nmlsrOf(String(lead["partner_id"] ?? "")) });
  async function stateOf(leadId: string, lead: P): Promise<P> {
    const events = await leadEvents(leadId); const closed = closedOf(lead);
    return { lead_id: leadId, partner: await partnerOfLead(lead), lines: linesOf(events, { legal_name: String(lead["partner_name"] ?? "") }), step: closed ? null : nextStepOf(lead), closed, range: closed ? null : rangeOf(events) };
  }

  // ───────────────────────────── start (S0)
  async function start(req: IncomingMessage, res: ServerResponse, b: P, at: string): Promise<void> {
    const token = leadTokenOf(req);
    if (token) { const row = await tokens.byToken(token); const lead = row && Date.parse(row.expires_at) > Date.parse(at) ? await leadOf(row.lead_id) : null; if (row && lead && lead["status"] !== "expired") { await tokens.touch(row.token_hash, at); send(res, 200, "lead_state", await stateOf(row.lead_id, lead)); return; } }   // a live lead cookie: that lead's state, never a second lead
    throttle(ipOf(req), at);
    const channel = str(b, "channel") || "web_chat"; if (channel !== "web_chat") throw new RangeError("channel must be web_chat (SMS and voice entry arrive through the telephony webhook)");
    const referral = (b["referral"] && typeof b["referral"] === "object" && !Array.isArray(b["referral"]) ? (b["referral"] as P) : {});
    const utm = (b["utm"] && typeof b["utm"] === "object" && !Array.isArray(b["utm"]) ? (b["utm"] as P) : {});
    const partner = await partnerFor(referral);
    const lead_id = randomUUID(); const interaction_id = randomUUID();
    // 32.2 lead.start as borrower-app in global scope with party_id null (the lead is global; SUBJECT_FREE_COMMANDS lists it), then the disclosure on the render (no tap)
    await exec("32.2", "lead.start", { partner_id: partner.id, partner_name: partner.legal_name, party_id: null, lead_id, interaction_id, channel, lead_channel: Object.keys(referral).length ? "referral" : "organic", consumer_state: null, time_zone: "America/New_York", utm, ...(str(referral, "ref") ? { utm_touch_id: str(referral, "ref") } : {}) });
    const ack = await exec("32.2", "lead.acknowledgeAiDisclosure", { lead_id, interaction_id, notice_id: `n-disc-${interaction_id.slice(0, 8)}`, party_id: null });
    const created = await tokens.create({ lead_id, partner_party_id: isUuid(partner.id) ? partner.id : null, now: at, ip: ipOf(req), user_agent: userAgentOf(req) });
    const events = await leadEvents(lead_id);
    logger.info("borrower.lead.started", { lead_id, partner_id: partner.id, channel, referral: Object.keys(referral).length > 0, events: ack.events.map((e) => e.type) });
    send(res, 200, "lead_state", { lead_token: created.token, lead_id, partner: { legal_name: partner.legal_name, nmlsr_id: partner.nmlsr_id }, lines: linesOf(events, partner), step: nextStepOf((await leadOf(lead_id)) ?? {}), closed: null, range: null });
  }
  // ───────────────────────────── state (a reload)
  async function state(req: IncomingMessage, res: ServerResponse, at: string): Promise<void> {
    const { row, lead } = await liveLead(req, at);
    send(res, 200, "lead_state", await stateOf(row.lead_id, lead));
  }
  // ───────────────────────────── answer (S1)
  async function answer(req: IncomingMessage, res: ServerResponse, b: P, at: string): Promise<void> {
    const { row, lead } = await liveLead(req, at);
    // L0_FACTS_ONLY at the edge (20.3 rule 6; 32.14 §5): a personal fact is refused before anything runs — nothing is written
    const forbidden = postedNames(b).filter((k) => FORBIDDEN_LEAD_FACTS.has(k.toLowerCase()));
    if (forbidden.length) throw new BorrowerError(409, "L0_FACTS_ONLY", undefined, `${forbidden.join(", ")} is never a lead fact (20.3 rule 6)`);
    const step = str(b, "step"); if (!step) throw new RangeError("step is required");
    const value = b["value"];
    const before = await lastSeq(row.lead_id);
    // 32.14 lead.answer: the S1 facts through 20.3 explainProgram{op=set_fact}; the state gate through 31.1; UT/CA re-log; CO pre-use notice — the tool refuses STEP_ORDER / STATE_GATE_FIRST / LEAD_CLOSED / L0_FACTS_ONLY itself
    const r = await exec("32.14", "lead.answer", { lead_id: row.lead_id, step, value });
    const out = (r.output ?? {}) as P;
    const after = (await leadOf(row.lead_id)) ?? lead;
    const closed = (out["closed"] && typeof out["closed"] === "object" ? (out["closed"] as P) : null) ?? closedOf(after);
    // the lines the tool rendered (the state-closed line, the UT/CA re-delivered disclosure, the CO pre-use line); the lead's own events are the fallback on a tool that answers none
    const lines = Array.isArray(out["lines"]) ? (out["lines"] as P[]).map((l) => ({ ...l, copy_tokens: { "partner.legal_name": after["partner_name"] ?? null, ...((l["copy_tokens"] as P | undefined) ?? {}) } })) : linesOf(await leadEvents(row.lead_id, before), { legal_name: String(after["partner_name"] ?? "") });
    logger.info("borrower.lead.answered", { lead_id: row.lead_id, step, closed: !!closed, events: r.events.map((e) => e.type) });
    send(res, 200, "lead_answer", { lead_id: row.lead_id, lines, step: closed ? null : normalizeStep(out["next_step"] && typeof out["next_step"] === "object" ? (out["next_step"] as P) : nextStepOf(after), transactionTypeOf(after)), closed });
  }
  // ───────────────────────────── range (S2)
  async function range(req: IncomingMessage, res: ServerResponse, at: string): Promise<void> {
    const { row, lead } = await liveLead(req, at);
    let out: P;   // the tool refuses STATE_GATE_FIRST (no state yet, readiness closed, a state-closed lead) and LEAD_CLOSED itself
    try { out = ((await exec("32.14", "lead.requestRange", { lead_id: row.lead_id, at, partner_nmlsr_id: (await partnerOfLead(lead)).nmlsr_id })).output ?? {}) as P; }
    catch (e) {
      const be = toBorrowerError(e);
      if (be.code !== "RANGE_CONTENT_CHECK") throw e;
      // the 20.2 checklist failed: no number — the identity ask still renders (T4)
      logger.info("borrower.lead.range.refused", { lead_id: row.lead_id, code: be.code });
      send(res, 200, "lead_range", { lead_id: row.lead_id, range: null, refused: "RANGE_CONTENT_CHECK", card: null, promise_copy_key: "entry.range.promise", disclaimer_copy_key: "entry.range.disclaimer", next: IDENTIFY_STEP }); return;
    }
    const refused = typeof out["refused"] === "string" ? String(out["refused"]) : out["range"] === null && typeof out["code"] === "string" ? String(out["code"]) : null;
    const src = (out["range"] && typeof out["range"] === "object" ? (out["range"] as P) : typeof out["low_pct"] === "string" ? out : null);
    const shown = (await leadEvents(row.lead_id)).filter((e) => e.type === "lead.range.shown").at(-1);
    const rangeOut = refused ? null : src ? rangeShape({ ...(shown?.payload ?? {}), ...src }) : shown ? rangeShape(shown.payload) : null;
    logger.info("borrower.lead.range", { lead_id: row.lead_id, refused, product_code: rangeOut?.["product_code"] ?? null, rate_sheet_id: rangeOut?.["rate_sheet_id"] ?? null });
    const card = rangeOut ? { kind: "StatusCard", copy_key: "entry.range.card", personal_terms: false, ...((out["card"] && typeof out["card"] === "object" ? (out["card"] as P) : {})) } : null;
    send(res, 200, "lead_range", { lead_id: row.lead_id, range: rangeOut, refused, card, promise_copy_key: "entry.range.promise", disclaimer_copy_key: "entry.range.disclaimer", next: (out["next"] && typeof out["next"] === "object" ? out["next"] : IDENTIFY_STEP) });
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const started = Date.now(); const at = now();
    const log = (status: number, extra: P = {}): void => logger.info("http", { method: "POST", path: url.pathname, status, ms: Date.now() - started, surface: "borrower", ...extra });
    try {
      const b = await readBody(req); const action = str(b, "action") || "start";
      if (action === "start") await start(req, res, b, at);
      else if (action === "state") await state(req, res, at);
      else if (action === "answer") await answer(req, res, b, at);
      else if (action === "range") await range(req, res, at);
      else throw new RangeError("action must be start, state, answer or range");
      log(res.statusCode);
    } catch (e) {
      const be = toBorrowerError(e);
      if (be.status >= 500) logger.error("borrower.lead.unhandled", { path: url.pathname, error: e });
      send(res, be.status, "error", be.body());
      log(be.status, { code: be.code, ...(be.gate ? { gate: be.gate } : {}), reason: be.message });
    }
  }

  // ───────────────────────────── the link at verify (S3)
  async function linkAtVerify(req: IncomingMessage, partyId: string, at: string): Promise<string | null> {
    const token = leadTokenOf(req); if (!token) return null;
    try {
      const row = await tokens.byToken(token); if (!row || Date.parse(row.expires_at) <= Date.parse(at)) return null;
      if (row.linked_party_id && row.linked_party_id !== partyId) { logger.info("borrower.lead.link.other_party", { lead_id: row.lead_id }); return null; }
      const lead = await leadOf(row.lead_id); if (!lead) return null;
      if (["expired", "closed_lost", "converted"].includes(String(lead["status"]))) return null;   // a closed state never reaches the identity ask; an expired lead is gone
      if (lead["party_id"] && lead["party_id"] !== partyId) { logger.info("borrower.lead.link.other_party", { lead_id: row.lead_id }); return null; }
      if (!lead["party_id"]) {
        // `lead.linked{party_id}` on the lead (20.3 linkParty — the lead is linked, never copied), in the lead's own global unit of work
        const store = new EntityStore(); store.seed(await runtime.entities.load({})); const mark = store.versionCount();
        await runtime.uow.run({}, (ctx) => {
          const cur = store.get("leads", row.lead_id); if (!cur) throw new RangeError(`no lead ${row.lead_id}`);
          const r = linkParty(ctx.events, cur.data as unknown as Lead, { party_id: partyId, at });
          store.put("leads", row.lead_id, r.lead as unknown as P, BORROWER_APP, at);
          return r.event.type;
        }, { clock: runtime.clock, commit: async (q) => { await runtime.entities.save(store.versionsSince(mark), {}, q); } });
      }
      await tokens.link(row.token_hash, partyId, at);
      logger.info("borrower.lead.linked", { lead_id: row.lead_id, party_id: partyId });
      return row.lead_id;
    } catch (e) { logger.error("borrower.lead.link.failed", { error: e instanceof Error ? e.message : String(e) }); return null; }
  }

  return { handle, linkAtVerify, tokens };
}
