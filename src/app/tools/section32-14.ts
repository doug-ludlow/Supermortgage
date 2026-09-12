/**
 * §32.14 process-owned tools — the anonymous minute's three commands of the `borrower-app` agent (spec/registry/agents.json
 * names `lead.answer`, `lead.requestRange`, `lead.proceed` for 32.14; src/app/tools.test.ts refuses the rest), defined with
 * `defineTools("32.14", "borrower-app", defs)` and spread by ./index.ts. Like 32.2, each is a thin translation of the API's
 * step / value into the owning process's own bus tool, executed NESTED in the same unit of work as that tool's agent
 * (`delegate`): 20.3 `explainProgram{op=set_fact | show_range | convert | defer_intent | close}`, `deliverDisclosure{reason=
 * channel_change | op=co_preuse}`, 31.1 `nmls.sync{op=readiness}` plus the SM_LICENSE_STATE_GATE assertion (31.1 rule 1).
 *
 *   lead.answer        one S1 chip → one rule-6 fact on the L0 lead, in the fixed order goal → (Buy: contract · refi/cash-out:
 *                      occupancy) → state → estimate. The state step runs, in order: (i) 31.1 readiness — closed →
 *                      `licensing.gate.blocked{state}`, `lead.closed{reason=state_not_licensed}`, the `lead.state_closed` line,
 *                      no further step; (ii) UT/CA → the disclosure re-delivered with the state variant (`deliverDisclosure
 *                      {reason=channel_change}`, one appended line); (iii) CO → `deliverCoPreuseNotice` before anything priced.
 *                      Answers the lines the API renders, the next step (a card descriptor) or `closed`.
 *   lead.requestRange  20.3 rule 7's published range from the active sheet — FRM30 unless a product is named (no chip implies
 *                      another) — APR beside each rate, the not-a-commitment footer, through 20.2 `runContentChecklist`;
 *                      `lead.range.shown{…, checklist_run_id}` on the lead. A failing checklist answers `{range: null, refused:
 *                      RANGE_CONTENT_CHECK}` and the identity ask (`auth.choose_method`) still follows. STATE_GATE_FIRST before
 *                      the state is known and while 31.1 readiness is closed.
 *   lead.proceed       "Show me my rate" → 20.3 `explainProgram{op=convert}` → `application.received` (Reg B; 32.3's E6 cards
 *                      fire on it unchanged); refused TERMS_NOT_PRESENTED before `terms.presented` under
 *                      origination.ai_mlo_intake=assisted. "Not yet" → `intent.deferred{lead_id}` (nothing ordered, pulled or
 *                      converted; SM_LEAD_INACTIVITY_EXPIRY_90 remains the only clock).
 *
 * Guardrails (32.14 AI agent design): L0_FACTS_ONLY (no name, contact, income, SSN or prohibited inquiry on a lead without a
 * party), RANGE_IS_PUBLISHED (the sheet's low–high; no tier, no LLPA, no borrower figure), STATE_GATE_FIRST (no range and no
 * identity ask while licensing.gate.blocked), NO_RATE_BEFORE_MLO_REVIEW (32.1's send_card rule restated for the hand-off);
 * CONSENT_VOICE_VOID is 32.2's. The agent proposes nothing and computes no regulatory date; every decision row names the lead
 * id and the step. Refusals are typed (`EntryRefused{code, gate?}` or the owning process's *Refused) and the borrower API
 * answers them as {code, gate?, copy_key} (src/runtime/borrower/errors.ts, copy-keys.ts).
 */
import { randomUUID } from "node:crypto";
import { defineTools, compute, never, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { delegate, LINK_LOAN_DEF, specToolNames } from "./section32-2.ts";
import { assertLicenseStateGate } from "./section31-1.ts";
import { LicensingRefused, type Readiness } from "../../domain/governance/ops-31-1.ts";
import { DEFAULT_AI_INTAKE_MODE } from "../../domain/application/ops-21-1.ts";
import { type Lead, type EntryStep, ENTRY_STEPS, ENTRY_OCCUPANCIES, ENTRY_TRANSACTION_TYPES, GOAL_TRANSACTION_TYPES, PROGRAM_MAX_LTV_PCT, l0ProhibitedKeys, nextEntryStep, entryFacts, transactionTypeOf } from "../../domain/leads-pricing/ops-20-3.ts";

export const PROCESS_32_14 = "32.14";
export const BORROWER_APP = "borrower-app";
/** A refusal these tools name themselves; the bus lets it through untouched and the borrower API turns any *Refused with a code into {code, gate?, copy_key}. */
export class EntryRefused extends Error { readonly code: string; readonly gate: string | undefined; constructor(code: string, message: string, gate?: string) { super(`${code}: ${message}`); this.name = "EntryRefused"; this.code = code; this.gate = gate; } }

/** The 50 states and DC as the state chip offers them (32.14 S1 / E's `select`). */
export const USPS_STATES: readonly string[] = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"];
export const GOAL_OPTIONS = ["buy", "lower_rate", "cash_out"] as const;
/** S3's identity ask — the step after the range, whether or not the range passed its checklist. */
export const IDENTIFY_STEP = { id: "identify", kind: "ChoiceCard", copy_key: "auth.choose_method", options: [{ id: "sms" }, { id: "email" }, { id: "google" }] } as const;
/** convertToApplication's placeholder for the Colorado public-notice page until the portal page ships (the CO line the borrower reads is the copy key `entry.disclosure.co_admt`). */
export const CO_PUBLIC_NOTICE_URL_PLACEHOLDER = "[public notice URL]";
export const RANGE_CONTENT_CHECK = "RANGE_CONTENT_CHECK";

// ---------------------------------------------------------------- helpers
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const loadLead = (i: ToolInput, rt: ToolRuntime): Lead => { need(i, "lead_id"); const r = rt.store.get("leads", str(i, "lead_id")); if (!r) throw new RangeError(`no lead ${str(i, "lead_id")} in the entity store (32.2 lead.start first)`); return r.data as unknown as Lead; };
const reload = (rt: ToolRuntime, lead_id: string): Lead => rt.store.require("leads", lead_id).data as unknown as Lead;
/** A lead a closed state ended is STATE_GATE_FIRST (no range, no identity ask); an expired, walked-away or converted lead is LEAD_CLOSED. */
const closedCode = (lead: Lead): string | null => (lead.status === "closed_lost" ? (lead.closed_reason === "state_not_licensed" ? "STATE_GATE_FIRST" : "LEAD_CLOSED") : lead.status === "expired" || lead.status === "converted" ? "LEAD_CLOSED" : null);
const assertOpen = (lead: Lead): void => { const c = closedCode(lead); if (c) throw new EntryRefused(c, `lead ${lead.lead_id} is ${lead.status}${lead.closed_reason ? ` (${lead.closed_reason})` : ""}${lead.application_id ? ` → application ${lead.application_id}` : ""}`, c === "STATE_GATE_FIRST" ? "SM_LICENSE_STATE_GATE" : undefined); };
/** One thread line as the API returns it (S0's response shape): the agent's, with the automation marker, rendered from a copy key. */
const line = (ctx: CommandContext, copy_key: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ message_id: randomUUID(), at: ctx.now, sender: "agent", automation_marker: true, copy_key, ...extra });
const ok = (name: string, extra: Record<string, unknown>): Record<string, unknown> => ({ command: name, outcome: "accepted", ...extra });
/** The 32.2 decision shape: every row names the lead id and the step. */
const decisionFor = (name: string) => (i: ToolInput, out: unknown, ctx: CommandContext) => {
  const o = out as Record<string, unknown> | null; const step = str(i, "step") || str(i, "choice") || (name === "lead.requestRange" ? "range" : "-");
  return { action: `borrower.command:${name}`, rationale: `command=${name} lead_id=${str(i, "lead_id") || "-"} step=${step} outcome=${o && typeof o["outcome"] === "string" ? o["outcome"] : "accepted"} gate=${o && typeof o["gate"] === "string" ? o["gate"] : "-"} by ${ctx.actor.kind}:${ctx.actor.id}`, subject: { kind: "lead", id: str(i, "lead_id") || "-" } };
};
/** `origination.ai_mlo_intake` from a `flags` input, the entity store (`feature_flags`, as 21.1 reads it) or the default `assisted`. */
const aiIntakeMode = (i: ToolInput, rt: ToolRuntime): string => { const fromInput = (i.flags as Record<string, unknown> | undefined)?.["origination.ai_mlo_intake"]; if (typeof fromInput === "string") return fromInput; const row = rt.store.get("feature_flags", "origination.ai_mlo_intake"); return typeof row?.data["value"] === "string" ? (row.data["value"] as string) : DEFAULT_AI_INTAKE_MODE; };
const PERSONAL_FIGURE_KEYS = ["tier", "representative_score", "score", "llpa", "llpa_adjustments", "loan_amount_cents", "ltv", "ltv_band", "quote_id", "pi_cents", "payment_cents"];

/** The next chip as the API renders it: a ChoiceCard / ConfirmCard descriptor keyed by §6.2 copy; nothing preselected (the tap is required). */
export function stepCard(step: EntryStep, lead: Lead): Record<string, unknown> {
  const tt = transactionTypeOf(lead);
  switch (step) {
    case "goal": return { id: "goal", kind: "ChoiceCard", copy_key: "entry.goal.question", options: GOAL_OPTIONS.map((id) => ({ id, transaction_type: GOAL_TRANSACTION_TYPES[id] })), preselected: null };
    case "contract": return { id: "contract", kind: "ChoiceCard", copy_key: "entry.buy.contract_question", options: [{ id: "signed" }, { id: "looking" }], preselected: null };
    case "occupancy": return { id: "occupancy", kind: "ChoiceCard", copy_key: "entry.occupancy.question", options: ENTRY_OCCUPANCIES.map((id) => ({ id })), preselected: null };
    case "state": return { id: "state", kind: "ChoiceCard", copy_key: "entry.state.question", options: USPS_STATES.map((id) => ({ id })), preselected: null };
    case "estimate": return tt === "purchase"
      ? { id: "estimate", kind: "ConfirmCard", copy_key: "entry.estimate.price_range", fields: [{ id: "price_range_cents", copy_key: "entry.estimate.price_range", kind: "money" }, { id: "down_payment_cents", copy_key: "entry.estimate.down_payment", kind: "money" }], max_ltv_pct: PROGRAM_MAX_LTV_PCT.purchase }
      : { id: "estimate", kind: "ConfirmCard", copy_key: "entry.estimate.value", fields: [{ id: "value_estimate_cents", copy_key: "entry.estimate.value", kind: "money" }, { id: "stated_existing_balance_cents", copy_key: "entry.estimate.balance", kind: "money" }], max_ltv_pct: tt ? PROGRAM_MAX_LTV_PCT[tt] : null, ...(tt === "cash_out" ? { ltv_cap_is_a_limit_not_a_decline: true } : {}) };
  }
}
/** The API's `{step, value}` → the 20.3 `set_fact` input (cents stay decimal strings on the bus; the domain coerces). */
export function factInput(step: EntryStep, value: unknown): Record<string, unknown> {
  const s = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "bigint" ? String(value) : "";
  switch (step) {
    case "goal": { const tt = (GOAL_TRANSACTION_TYPES as Record<string, string>)[s] ?? ((ENTRY_TRANSACTION_TYPES as readonly string[]).includes(s) ? s : null); if (!tt) throw new RangeError(`goal ${JSON.stringify(s)} is not one of ${GOAL_OPTIONS.join("/")}`); return { kind: "goal", transaction_intent: tt }; }
    case "contract": if (s !== "signed" && s !== "looking") throw new RangeError(`contract ${JSON.stringify(s)} is not signed | looking`); return { kind: "contract", contract_status: s };
    case "occupancy": if (!(ENTRY_OCCUPANCIES as readonly string[]).includes(s)) throw new RangeError(`occupancy ${JSON.stringify(s)} is not one of ${ENTRY_OCCUPANCIES.join("/")}`); return { kind: "occupancy", occupancy: s };
    case "state": { const st = s.toUpperCase(); if (!USPS_STATES.includes(st)) throw new RangeError(`state ${JSON.stringify(s)} is not a two-letter USPS state code`); return { kind: "state", consumer_state: st }; }
    case "estimate": { const o = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
      const c = (k: string): string | null => { const x = o[k]; if (x === undefined || x === null || x === "") return null; if (typeof x === "bigint") return String(x); if (typeof x !== "string" || !/^\d+$/.test(x)) throw new RangeError(`${k} must be a decimal string of cents`); return x; };
      return { kind: "estimate", value_estimate_cents: c("value_estimate_cents"), stated_existing_balance_cents: c("stated_existing_balance_cents"), price_range_cents: c("price_range_cents"), down_payment_cents: c("down_payment_cents") }; }
  }
}
/** FRM30 by default; a product is used only when named (no S1 chip implies FRM15 or an ARM) and the sheet decides whether it exists. */
const productFor = (i: ToolInput): string => { const p = str(i, "product_code").trim().toUpperCase(); if (p && !/^[A-Z][A-Z0-9_]{2,15}$/.test(p)) throw new RangeError(`product_code ${JSON.stringify(p)} is not a rate-sheet product code`); return p || "FRM30"; };

type Def = Omit<ToolDef, "process" | "agent">;
const cmd = (name: string, handler: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime) => unknown | Promise<unknown>, extra: Partial<Def> = {}): Def => ({ name, kind: "act", handler: compute(handler), decision: decisionFor(name), ...extra });
const L0_FACTS_ONLY = never("L0_FACTS_ONLY", "20.3 rule 6 / 32.14 guardrails: no name, contact, income, SSN or prohibited inquiry on a lead without a party (20.3 T12; 32.14 T6)", (i) => l0ProhibitedKeys(i).length > 0, "only goal, contract status, occupancy, state and the consumer's own estimates are lead facts before a session — nothing was written");
const STATE_GATE_BYPASS = never("STATE_GATE_FIRST", "32.14 §1.7 / 31.1 rule 1: the state runs readiness before anything else; no range and no identity ask while licensing.gate.blocked", (i) => flag(i, "bypass_state_gate") || flag(i, "skip_state_gate") || flag(i, "force_open"), "readiness is computed from the 31.1 registry rows only; a closed state ends the lead");

export const TOOLS_32_14: readonly ToolDef[] = defineTools(PROCESS_32_14, BORROWER_APP, [
  // lead.answer → 20.3 explainProgram{set_fact}; the state step runs 31.1 readiness, then the UT/CA re-log and the CO pre-use notice through 20.3's own tool
  cmd("lead.answer", async (i, ctx, rt) => {
    const lead = loadLead(i, rt); need(i, "step"); const step = str(i, "step"); const lead_id = lead.lead_id;
    assertOpen(lead);
    if (!(ENTRY_STEPS as readonly string[]).includes(step)) throw new RangeError(`step ${JSON.stringify(step)} is not one of ${ENTRY_STEPS.join("/")}`);
    const expected = nextEntryStep(lead);
    if (step !== expected) {
      if (step === "estimate" && expected === "state") throw new EntryRefused("STATE_GATE_FIRST", "the state is answered and 31.1 readiness runs before any estimate, range or identity ask", "SM_LICENSE_STATE_GATE");
      throw new EntryRefused("STEP_ORDER", expected ? `step ${step} is out of order: the next step is ${expected}` : `step ${step} is out of order: every chip is answered (the range and the identity ask follow)`);
    }
    const fact = factInput(step as EntryStep, i.value);
    const set = await delegate(rt, ctx, "20.3", "explainProgram", { op: "set_fact", lead_id, fact }) as Record<string, unknown>;
    const lines: Record<string, unknown>[] = []; let after = reload(rt, lead_id);
    if (step === "state") {
      const state = after.consumer_state!;
      // (i) 31.1 readiness (nmls.sync{op=readiness}) and the SM_LICENSE_STATE_GATE assertion: closed → licensing.gate.blocked{state} + the officer escalation (31.1 rule 1), the lead closed_lost{state_not_licensed}, the lead.state_closed line, stop
      const readiness = await delegate(rt, ctx, "31.1", "nmls.sync", { op: "readiness", state }) as Readiness;
      let blocked = readiness.open !== true; let reason: string | null = readiness.reason ?? null;
      try { assertLicenseStateGate(ctx, rt, { state, command: "lead.answer", lead_id, partner_name: lead.partner_name }); }
      catch (e) { if (!(e instanceof LicensingRefused)) throw e; blocked = true; reason = reason ?? e.message; }
      if (blocked) {
        await delegate(rt, ctx, "20.3", "explainProgram", { op: "close", lead_id, reason: "state_not_licensed" }); after = reload(rt, lead_id);
        lines.push(line(ctx, "lead.state_closed", { state, copy_tokens: { state } }));
        return ok("lead.answer", { lead_id, step, value: fact, lines, next_step: null, closed: { reason: "state_not_licensed", copy_key: "lead.state_closed", gate: "SM_LICENSE_STATE_GATE", state, readiness_reason: reason }, facts: entryFacts(after), gate: "SM_LICENSE_STATE_GATE" });
      }
      // (ii) UT / CA: the disclosure re-delivered with the state variant — the existing re-log pattern (deliverDisclosure{reason=channel_change}), one appended line
      if (state === "UT" || state === "CA") {
        const interaction_id = after.interactions[after.interactions.length - 1]?.interaction_id; if (!interaction_id) throw new RangeError(`lead ${lead_id} has no interaction to re-deliver the disclosure on (32.2 lead.start first)`);
        const d = await delegate(rt, ctx, "20.3", "deliverDisclosure", { lead_id, interaction_id, reason: "channel_change", notice_id: str(i, "notice_id") || `n-disc-${state.toLowerCase()}-${interaction_id.slice(0, 8)}` }) as Record<string, unknown>;
        lines.push(line(ctx, "entry.disclosure.first", { state_variant: d["state_variant"] ?? null, reason: "channel_change", text: d["text"] ?? null, consent_id: d["consent_id"] ?? null }));
      }
      // (iii) CO: the pre-use notice (co_admt.preuse_notice.delivered) before anything priced
      if (state === "CO") {
        const url = str(i, "public_notice_url") || String(rt.store.get("feature_flags", "co_admt.public_notice_url")?.data["value"] ?? CO_PUBLIC_NOTICE_URL_PLACEHOLDER);
        const d = await delegate(rt, ctx, "20.3", "deliverDisclosure", { op: "co_preuse", lead_id, notice_id: str(i, "co_notice_id") || `n-co-admt-${lead_id.slice(0, 8)}`, public_notice_url: url }) as Record<string, unknown>;
        lines.push(line(ctx, "entry.disclosure.co_admt", { text: d["text"] ?? null, gate_required: d["gate_required"] ?? false, public_notice_url: url }));
      }
      after = reload(rt, lead_id);
    }
    const next = nextEntryStep(after);
    return ok("lead.answer", { lead_id, step, value: fact, lines, next_step: next ? stepCard(next, after) : null, closed: null, facts: entryFacts(after), ...(set["max_ltv_pct"] !== undefined ? { max_ltv_pct: set["max_ltv_pct"] } : {}) });
  }, { guardrails: [L0_FACTS_ONLY, STATE_GATE_BYPASS] }),

  // lead.requestRange → 20.3 explainProgram{show_range}: generalRateRange on the active sheet + 20.2 runContentChecklist → lead.range.shown, or {range: null, refused: RANGE_CONTENT_CHECK}; STATE_GATE_FIRST before the state / while readiness is closed
  cmd("lead.requestRange", async (i, ctx, rt) => {
    const lead = loadLead(i, rt); const lead_id = lead.lead_id; assertOpen(lead);
    if (!lead.consumer_state) throw new EntryRefused("STATE_GATE_FIRST", "the state is answered and 31.1 readiness runs before any range or identity ask", "SM_LICENSE_STATE_GATE");
    const readiness = await delegate(rt, ctx, "31.1", "nmls.sync", { op: "readiness", state: lead.consumer_state }) as Readiness;
    if (readiness.open !== true) throw new EntryRefused("STATE_GATE_FIRST", `${lead.consumer_state} readiness is closed (${readiness.reason ?? "unknown"}): no range and no identity ask`, "SM_LICENSE_STATE_GATE");
    const product_code = productFor(i);
    const r = await delegate(rt, ctx, "20.3", "explainProgram", { op: "show_range", lead_id, product_code, ...(str(i, "partner_nmlsr_id") ? { partner_nmlsr_id: str(i, "partner_nmlsr_id") } : {}), ...(str(i, "checklist_run_id") ? { checklist_run_id: str(i, "checklist_run_id") } : {}) }) as Record<string, unknown>;
    const next = { ...IDENTIFY_STEP, options: [...IDENTIFY_STEP.options] };
    if (!r["range"]) return { command: "lead.requestRange", outcome: "refused", refused: RANGE_CONTENT_CHECK, gate: RANGE_CONTENT_CHECK, lead_id, range: null, failures: r["failures"] ?? [], checklist_run_id: r["checklist_run_id"] ?? null, lines: [], next, next_step: next, facts: entryFacts(reload(rt, lead_id)) };
    const range = r["range"] as Record<string, unknown>;
    const copy_tokens = { low_pct: range["low_pct"], high_pct: range["high_pct"], apr_low_pct: range["apr_low_pct"], apr_high_pct: range["apr_high_pct"], product: range["product_label"], "partner.legal_name": lead.partner_name, ...(str(i, "partner_nmlsr_id") ? { "partner.nmlsr_id": str(i, "partner_nmlsr_id") } : {}) };
    return ok("lead.requestRange", { lead_id, range, card: { kind: "StatusCard", copy_key: "entry.range.card", personal_terms: false, copy_tokens }, promise_copy_key: "entry.range.promise", disclaimer_copy_key: "entry.range.disclaimer", checklist_run_id: range["checklist_run_id"], refused: null, failures: [],
      lines: [line(ctx, "entry.range.card", { text: range["text"], personal_terms: false, copy_tokens })], next, next_step: next, facts: entryFacts(reload(rt, lead_id)) });
  }, { guardrails: [STATE_GATE_BYPASS,
    never("RANGE_IS_PUBLISHED", "32.14 guardrails / 20.3 rule 7: the range is the sheet's low–high for the product; no tier, no LLPA, no borrower figure", (i) => flag(i, "personal_terms") || PERSONAL_FIGURE_KEYS.some((k) => i[k] !== undefined && i[k] !== null && i[k] !== ""), "a published range carries no tier, LLPA or borrower-specific figure; personal terms follow the soft pull and the MLO of record's review")] }),

  // lead.proceed → 20.3 explainProgram{convert} (application.received) or {defer_intent} (intent.deferred); refused before terms.presented under origination.ai_mlo_intake=assisted
  cmd("lead.proceed", async (i, ctx, rt) => {
    const lead = loadLead(i, rt); const lead_id = lead.lead_id; const choice = str(i, "choice") || (flag(i, "not_yet") ? "not_yet" : "proceed");
    if (choice !== "proceed" && choice !== "not_yet") throw new RangeError(`choice ${JSON.stringify(choice)} is not proceed | not_yet`);
    assertOpen(lead);
    if (choice === "not_yet") {
      const r = await delegate(rt, ctx, "20.3", "explainProgram", { op: "defer_intent", lead_id, reason: "not_yet" }) as Record<string, unknown>;
      return ok("lead.proceed", { lead_id, choice, deferred: true, status: r["status"], ordered: false, pulled: false, document: null, clocks: ["SM_LEAD_INACTIVITY_EXPIRY_90"], copy_key: "entry.proceed.not_yet" });
    }
    const mode = aiIntakeMode(i, rt);
    const ready = mode === "autonomous" ? ["prequalified", "terms_review", "terms_presented"].includes(lead.status) : lead.status === "terms_presented";
    if (!ready) throw new EntryRefused("TERMS_NOT_PRESENTED", `lead ${lead_id} is ${lead.status}; under origination.ai_mlo_intake=${mode} the borrower proceeds only after terms.presented (mlo.review.completed{approved} — NO_RATE_BEFORE_MLO_REVIEW)`, "SM_MLO_PREAPP_TERMS_REVIEW_1BH");
    const transaction_type = transactionTypeOf(lead); if (!transaction_type) throw new RangeError(`lead ${lead_id} has no goal (lead.answer{step=goal} first)`);
    const occupancy = str(i, "occupancy") || lead.occupancy || "primary";
    const r = await delegate(rt, ctx, "20.3", "explainProgram", { op: "convert", lead_id, transaction_type, occupancy, creditor_time_zone: lead.time_zone, ...(str(i, "borrower_name") ? { borrower_name: str(i, "borrower_name") } : {}) }) as Record<string, unknown>;
    return ok("lead.proceed", { lead_id, choice, application_id: r["application_id"], application_date: r["application_date"], trid_application_date: r["trid_application_date"] ?? null, le_due_on: r["le_due_on"] ?? null, decision_due_on: r["decision_due_on"], transaction_type, occupancy, occupancy_defaulted: !str(i, "occupancy") && !lead.occupancy, ai_mlo_intake: mode, next: "32.3 E6 on application.received: consent.esign.title, consent.tcpa.title, consent.credit.title{hard_pull} (L3)" });
  }, { guardrails: [never("NO_RATE_BEFORE_MLO_REVIEW", "32.1 / 32.14 guardrails: no rate or payment is presented as personal before mlo.review.completed{approved}; the hand-off never carries one", (i) => flag(i, "skip_review") || flag(i, "personal_terms"), "personal terms need the MLO of record's approved review first (SM_MLO_PREAPP_TERMS_REVIEW_1BH)")] }),
  // 32.14 DELTA-16 (phase 3): link my loan — `party.linkLoan` (defined beside 32.2's helpers in section32-2.ts, a 32.14 tool here); on the bus once the registry names it for 32.14
  ...(specToolNames(PROCESS_32_14).has("party.linkLoan") ? [LINK_LOAN_DEF] : []),
]);
