/**
 * §33.2 process-owned tools — the `refi-analyst` agent's `review.run`, `review.facts`, `review.write`, `offer.deliver` and
 * `offer.expire` (spec/sections/33-partner-book/33-2-*.md "AI agent design"), defined with `defineTools("33.2", "refi-analyst", defs)`
 * and spread by ./index.ts. Every tool string is one spec/registry/agents.json names for 33.2. Thin bus wrappers over the
 * runtime functions of src/runtime/partner-book-review.ts / partner-book-offers.ts (the pass-shaped tools run the pass through
 * `services.runtime`, their own units of work sequential to this command's):
 *
 *   review.run     act    the daily pass (rules 1–6): facts → universe (inside refi-daily), one review per monitored loan with the
 *                         analyst's turn, offer delivery and expiry, `partner_book.review.run_completed` — idempotent per day.
 *   review.facts   read   the model's first tool: the day's review facts as `{{facts.<key>}}` tokens and the engine's verdict and
 *                         reasons in words — never a raw figure in the result text (the surface resolves the tokens).
 *   review.write   write  the model's second tool: `{rationale, flags[]}` → the decision record {loan_id, as_of_date, verdict,
 *                         opportunity_id, rule_set_version sm.refi_trigger.v1+partner_book.review.v1, model_version, prompt_version,
 *                         confidence, rationale, flags}, `partner_book.review.written` and the partner_book_reviews row (one per loan-day).
 *                         The verdict, the opportunity and every figure are read from the engine's rows — a verdict or a number in the
 *                         input is refused (ANALYST_NEVER_DECIDES); a figure outside a token in the rationale is refused (PROVENANCE).
 *   offer.deliver  act    rule 5 (src/runtime/partner-book-offers.ts deliverOffers).
 *   offer.expire   act    rule 6 (expireOffers).
 *
 * Guardrails (the paragraph's list): ANALYST_NEVER_DECIDES, NO_CREDIT_PULL, NO_PRESCREEN, NO_INVESTOR_FIELDS, NO_PROHIBITED_BASIS,
 * NO_UNCONSENTED_TEXT_OR_VOICE, PROVENANCE.
 */
import { randomUUID } from "node:crypto";
import { defineTools, compute, never, str, flag, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { PgDecisionRepository } from "../../infra/db/decisions.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { INVESTOR_FIELDS, PROHIBITED_SELECTION_FIELDS, type PartnerProgram, type RefiOpportunity, type UniverseLoan } from "../../domain/leads-pricing/ops-20-1.ts";
import { provenanceViolation } from "../../runtime/borrower/agent/guard.ts";
import { ET, REVIEW_RULE_SET_VERSION, VERDICT_WORDS, entityRowsById, insertReviewRow, loanLoadExceptions, opportunityIdFor, partiesOfLoans, partnerBookReviewRun, reasonsInWords, reviewOf, reviewRunIdFor, reviewTokens, reviewWriteRecord, type Review, type ReviewAnalyst } from "../../runtime/partner-book-review.ts";
import { ANALYST_FLAGS, ANALYST_MODEL, ANALYST_PROMPT_VERSION } from "../../runtime/partner-book-analyst.ts";
import { deliverOffers, expireOffers } from "../../runtime/partner-book-offers.ts";
import type { Runtime } from "../../runtime/app.ts";

type P = Record<string, unknown>;
const PROCESS_33_2 = "33.2"; const AGENT = "refi-analyst";
export const REVIEW_PROMPT_VERSION_ENGINE = "33.2-v1";
const obj = (v: unknown): P => (v && typeof v === "object" && !Array.isArray(v) ? (v as P) : {});
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`33.2 tool needs ${k}`); };
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const asOfOf = (i: ToolInput, ctx: CommandContext): PlainDate => (str(i, "as_of_date") ? D(str(i, "as_of_date")) : wallClock(Date.parse(ctx.now), ET).date);

// ───────── guardrails ─────────

/** The engine's figures and its verdict never enter through the analyst's input (rule 4 / ANALYST_NEVER_DECIDES). */
const FIGURE_KEYS = new Set(["verdict", "status", "opportunity_status", "reasons", "facts", "note_rate", "note_rate_pct", "rate", "rate_now", "candidate_rate", "candidate_rate_pct", "rate_delta_bps", "rate_delta", "npv_cents", "npv", "pi_cents", "candidate_pi_cents", "loan_amount_cents", "candidate_loan_amount_cents", "upb_cents", "value_cents", "value", "ltv", "watch_rate_pct", "watch_rate", "monthly_delta_cents", "monthly_delta", "breakeven_months", "seven_year_delta_cents", "seven_year_total_cost_delta_cents", "days_delinquent", "remaining_term_months", "fire", "offer_ready", "suppression_reasons"]);
const NUMBER_ALLOWED = new Set(["confidence", "max_analyst_turns"]);
const decides = (i: ToolInput): string | null => {
  const hit = Object.keys(i).find((k) => FIGURE_KEYS.has(k)); if (hit) return `input carries \`${hit}\``;
  const num = Object.entries(i).find(([k, v]) => !NUMBER_ALLOWED.has(k) && (typeof v === "number" || typeof v === "bigint" || (typeof v === "string" && k !== "loan_id" && k !== "party_id" && k !== "as_of_date" && k !== "run_id" && k !== "turn_id" && k !== "rationale" && k !== "model_version" && k !== "prompt_version" && /^-?\$?\d[\d,]*(\.\d+)?%?$/.test(v.trim()))));
  if (num) return `input carries a number under \`${num[0]}\``;
  if (typeof i["confidence"] === "number" && (i["confidence"] < 0 || i["confidence"] > 1)) return "confidence is outside 0..1";
  return null;
};
const ANALYST_NEVER_DECIDES = never("ANALYST_NEVER_DECIDES", "33.2 Verified requirement / rule 4: the engine is 20.1's; the analyst's turn cannot change the verdict, the rate or any figure — `review.write` refuses a verdict or a number in its input", (i) => decides(i) !== null, "the verdict, the opportunity and every figure are the engine's rows (refi_universe, refi_opportunities): review.write takes {rationale, flags[]} only");
const PROVENANCE = never("PROVENANCE", "33.2 rule 4 / guardrails: the rationale states the verdict's reason using only tokens for figures — the guard's provenance rule refuses a digit or a spelled-out amount outside a {{token}}", (i) => typeof i["rationale"] === "string" && provenanceViolation(i["rationale"]) !== null, "the rationale carries a figure outside a {{facts.*}} token; figures are the surface's to resolve");
const pullsCredit = (i: ToolInput): boolean => flag(i, "credit_pull") || flag(i, "consumer_report") || flag(i, "soft_pull") || flag(i, "order_consumer_report") || str(i, "score_source") === "consumer_report" || str(i, "score_source") === "soft_pull";
const NO_CREDIT_PULL = never("NO_CREDIT_PULL", "33.2 Verified requirement / FCRA §604 (15 U.S.C. §1681b): no consumer report is obtained for selection — the partner's score is a fact of the partner's file (score_source = partner_file); a report is ordered only after the homeowner's own Yes (32.11 §3, 33.3)", pullsCredit, "the review never orders or reads a consumer report; the partner's FICO prices only");
const NO_PRESCREEN = never("NO_PRESCREEN", "33.2 guardrails / FCRA §615(d) (15 U.S.C. §1681m(d)): a firm offer of credit only through 20.2's prescreen path — the review is not a prescreen and selects on no consumer report", (i) => flag(i, "prescreen") || flag(i, "firm_offer") || flag(i, "prescreen_list") || flag(i, "use_score_for_selection"), "the daily review is not a prescreen: selection reads 20.1's allowlist, never a consumer report or the score");
const keysOf = (o: P): string[] => Object.keys(o);
const nested = (i: ToolInput): P[] => [i, obj(i["row"]), obj(i["loan"]), obj(i["facts"]), obj(i["where"])];
const NO_INVESTOR_FIELDS = never("NO_INVESTOR_FIELDS", "33.2 guardrails (20.1 rule 7 INVESTOR_FIELDS): investor identity never reaches the row, the review or the analyst", (i) => nested(i).some((o) => keysOf(o).some((k) => INVESTOR_FIELDS.includes(k))), `investor fields (${INVESTOR_FIELDS.join(", ")}) are never an input here`);
const PROHIBITED_KEYS: readonly string[] = [...PROHIBITED_SELECTION_FIELDS, "dti", "dti_pct", "fico_current", "fico_original", "property_zip", "borrower_name"];
const NO_PROHIBITED_BASIS = never("NO_PROHIBITED_BASIS", "33.2 Verified requirement / Reg B §1002.4, §1002.5(b) / 20.1 rule 8 PROHIBITED_SELECTION_FIELDS: name, ZIP, DTI, age and the score never reach the selection row or the review", (i) => nested(i).some((o) => keysOf(o).some((k) => PROHIBITED_KEYS.includes(k))), "prohibited-basis inputs (name, ZIP, DTI, age, the score) are never an input here");
const consentedChannel = (i: ToolInput): boolean => { const chans = [str(i, "channel"), ...(Array.isArray(i["channels"]) ? (i["channels"] as unknown[]).map(String) : [])].filter(Boolean); return chans.some((ch) => /^(sms|text|ai_voice|voice|human_voice)$/i.test(ch)) && !str(i, "consent_id") && !(Array.isArray(i["consents"]) && (i["consents"] as unknown[]).length > 0); };
const NO_UNCONSENTED_TEXT_OR_VOICE = never("NO_UNCONSENTED_TEXT_OR_VOICE", "33.2 rule 5 / TCPA 47 U.S.C. §227(b) / 20.2's gates: a text or an AI voice call is never scheduled without consents{kind=tcpa_sms|tcpa_voice, purpose=marketing}; e-mail and the in-app card are the default channels", consentedChannel, "no text or voice touch without a marketing consent id (consents{tcpa_sms|tcpa_voice, purpose=marketing}); the default channels are e-mail and the portal card");

// ───────── the review as the engine's rows determine it (shared by review.facts and review.write) ─────────

async function programOfLoan(rt: ToolRuntime, db: Queryable, loanId: string): Promise<PartnerProgram> {
  const loan = (await db.query<{ partner_id: string; status: string }>(`SELECT partner_party_id::text AS partner_id, status::text AS status FROM loans WHERE id = $1`, [loanId]))[0];
  if (!loan) throw new RangeError(`no loan ${loanId}`);
  if (loan.status !== "monitored") throw new RangeError(`loan ${loanId} is ${loan.status}, not monitored (33.2 reviews the partner book only)`);
  const programs = rt.store.list("partner_programs").map((r) => r.data as unknown as PartnerProgram);
  const p = programs.find((x) => x.partner_id === loan.partner_id); if (!p) throw new RangeError(`no partner_programs row for partner ${loan.partner_id} (20.1 loadUniverse{op=register_program})`);
  return p;
}
async function reviewFor(rt: ToolRuntime, db: Queryable, loanId: string, asOf: PlainDate): Promise<Review> {
  const program = await programOfLoan(rt, db, loanId);
  const oppId = opportunityIdFor(loanId, asOf, program.program_id);
  // the loan scope's store first (the command's transactional view), the current entity rows otherwise (a global-scope execution)
  const row = (rt.store.get("refi_universe", loanId)?.data as unknown as UniverseLoan | undefined) ?? ((await entityRowsById(db, "refi_universe", [loanId])).get(loanId) as unknown as UniverseLoan | undefined) ?? null;
  const opp = (rt.store.get("refi_opportunities", oppId)?.data as unknown as RefiOpportunity | undefined) ?? ((await entityRowsById(db, "refi_opportunities", [oppId])).get(oppId) as unknown as RefiOpportunity | undefined) ?? null;
  const [exceptions, parties] = await Promise.all([loanLoadExceptions(db, [loanId]), partiesOfLoans(db, [loanId])]);
  return reviewOf({ loan_id: loanId, party_id: parties.get(loanId) ?? null, as_of: asOf, program_id: program.program_id, row, opportunity: opp, exceptions: exceptions.get(loanId) ?? [] });
}
/** The model-facing text of a review: no digit, no spelled-out amount outside a token (asserted — a violation here is a bug, never a model's). */
function factsText(review: Review): { reasons_text: string[]; text: string } {
  const reasons_text = reasonsInWords(review.reasons);
  const t = reviewTokens(review.facts);
  const parts: string[] = [`The engine's verdict is ${review.verdict.replace(/_/g, " ")} (${VERDICT_WORDS[review.verdict]}).`, `Reasons: ${reasons_text.join("; ") || "none"}.`,
    `The rate now is ${t.rate_now}${t.candidate_rate ? ` and today's candidate rate is ${t.candidate_rate} (a change of ${t.rate_delta})` : ""}.`,
    `The balance is ${t.upb} against a value of ${t.value} (${review.facts.value_source.replace("partner_", "the partner's ").replace("fmv", "current market value").replace("bpo", "broker price opinion").replace("appraisal", "original appraisal")}, as of ${t.value_as_of}, ${review.facts.value_confidence} confidence), a loan-to-value of ${t.ltv}, with ${t.remaining_term} left.`,
    `The payment now is ${t.payment_now}${t.candidate_payment ? `; the candidate payment would be ${t.candidate_payment}, a monthly change of ${t.monthly_delta}, savings over the holding period of ${t.npv}, a total-cost change over seven years of ${t.seven_year_delta}${t.breakeven ? ` and a breakeven of ${t.breakeven}` : ""}` : ""}.`,
    `Days delinquent: ${t.days_delinquent}.`, ...(t.watch_rate ? [`The rate the sheet would need to show for the numbers to work is ${t.watch_rate}.`] : []), ...(review.facts.flags.length ? [`Flags on the facts: ${review.facts.flags.map((f) => f.replace(/_/g, " ")).join(", ")}.`] : [])];
  const text = parts.join(" ");
  const v = provenanceViolation(text); if (v) throw new RangeError(`review.facts text carries ${v}`);
  for (const r of reasons_text) { const w = provenanceViolation(r); if (w) throw new RangeError(`review.facts reason carries ${w}`); }
  return { reasons_text, text };
}

// ───────── the tools ─────────

export const TOOLS_33_2: readonly ToolDef[] = defineTools(PROCESS_33_2, AGENT, [
  { name: "review.run", kind: "act", ruleSetVersion: REVIEW_RULE_SET_VERSION, guardrails: [NO_CREDIT_PULL, NO_PRESCREEN, NO_INVESTOR_FIELDS, NO_PROHIBITED_BASIS],
    handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt);
      return partnerBookReviewRun(runtime, str(i, "at") || ctx.now, { logger: runtime.logger, llm: runtime.analystLlm, force: flag(i, "force"), ...(typeof i["max_analyst_turns"] === "number" ? { maxAnalystTurns: i["max_analyst_turns"] } : {}) });
    }),
    decision: (_i, output) => { const o = obj(output); return { action: "review.run", subject: { kind: "partner_book_review_run", id: String(o["as_of_date"] ?? "") }, rationale: String(o["line"] ?? "partner book review") }; } },

  { name: "review.facts", kind: "read", guardrails: [ANALYST_NEVER_DECIDES, NO_CREDIT_PULL, NO_PRESCREEN, NO_INVESTOR_FIELDS, NO_PROHIBITED_BASIS],
    handler: compute(async (i, ctx, rt) => {
      const loanId = str(i, "loan_id") || ctx.loanId; if (!loanId) throw new RangeError("33.2 tool needs loan_id");
      const review = await reviewFor(rt, dbOf(rt), loanId, asOfOf(i, ctx));
      const { reasons_text, text } = factsText(review);
      return { loan_id: review.loan_id, as_of_date: review.as_of_date, verdict: review.verdict, verdict_text: VERDICT_WORDS[review.verdict], reasons: review.reasons, reasons_text, facts: reviewTokens(review.facts), value_source: review.facts.value_source, value_confidence: review.facts.value_confidence, flags: review.facts.flags, text, allowed_flags: [...ANALYST_FLAGS] };
    }) },

  { name: "review.write", kind: "write", ruleSetVersion: REVIEW_RULE_SET_VERSION, guardrails: [ANALYST_NEVER_DECIDES, PROVENANCE, NO_CREDIT_PULL, NO_INVESTOR_FIELDS, NO_PROHIBITED_BASIS],
    handler: compute(async (i, ctx, rt) => {
      const loanId = str(i, "loan_id") || ctx.loanId; if (!loanId) throw new RangeError("33.2 tool needs loan_id");
      const db = dbOf(rt); const asOf = asOfOf(i, ctx);
      const prior = (await db.query<{ id: string; decision_id: string | null; verdict: string; opportunity_id: string | null }>(`SELECT id::text AS id, decision_id::text AS decision_id, verdict, opportunity_id FROM partner_book_reviews WHERE loan_id = $1 AND as_of_date = $2`, [loanId, asOf]))[0];
      if (prior) return { already_written: true, review_id: prior.id, decision_id: prior.decision_id, loan_id: loanId, as_of_date: asOf, verdict: prior.verdict, opportunity_id: prior.opportunity_id };
      const review = await reviewFor(rt, db, loanId, asOf);
      const flags = Array.isArray(i["flags"]) ? (i["flags"] as unknown[]).map(String) : [];
      const bad = flags.filter((f) => !(ANALYST_FLAGS as readonly string[]).includes(f)); if (bad.length) throw new RangeError(`flags outside the analyst's list: ${bad.join(", ")} (allowed: ${ANALYST_FLAGS.join(", ")})`);
      const rationale = str(i, "rationale");
      const analyst: ReviewAnalyst = str(i, "skipped") ? { skipped: str(i, "skipped"), explanation_text: review.engine_explanation }
        : rationale ? { model_version: str(i, "model_version") || ctx.run?.modelVersion || ANALYST_MODEL, prompt_version: str(i, "prompt_version") || ctx.run?.promptVersion || ANALYST_PROMPT_VERSION, turn_id: str(i, "turn_id") || randomUUID(), rationale, flags, confidence: typeof i["confidence"] === "number" ? i["confidence"] : (ctx.run?.confidence ?? 1) }
        : { skipped: "model_off", explanation_text: review.engine_explanation };
      const run_id = str(i, "run_id") || reviewRunIdFor(asOf, review.program_id);
      const r = reviewWriteRecord(review, analyst, run_id);
      ctx.events.append({ type: r.event.type, loanId: r.event.loanId, aggregate: r.event.aggregate, actor: ctx.actor, payload: r.event.payload });
      const defer = rt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined; if (!defer) throw new PortUnavailable("service:deferWrite");
      // the decision (the id the row carries) and the row, in the command's transaction
      defer(async (q) => { await new PgDecisionRepository(q).record(r.decision, q, r.decision_id); await insertReviewRow(q, review, analyst, run_id, r, ctx.now); });
      return { already_written: false, review_id: r.review_id, decision_id: r.decision_id, loan_id: review.loan_id, party_id: review.party_id, as_of_date: asOf, run_id, verdict: review.verdict, opportunity_id: review.opportunity_id, reasons: review.reasons, rule_set_version: REVIEW_RULE_SET_VERSION,
        analyst: "skipped" in analyst ? { skipped: analyst.skipped } : { turn_id: analyst.turn_id, model_version: analyst.model_version, prompt_version: analyst.prompt_version, confidence: analyst.confidence, flags: analyst.flags } };
    }),
    decision: () => null },   // the decision row is written with the review row (reviewWriteRecord: agent refi-analyst, action review.write, rule set sm.refi_trigger.v1+partner_book.review.v1)

  { name: "offer.deliver", kind: "act", ruleSetVersion: REVIEW_RULE_SET_VERSION, guardrails: [NO_UNCONSENTED_TEXT_OR_VOICE, NO_CREDIT_PULL, NO_PRESCREEN, NO_INVESTOR_FIELDS, NO_PROHIBITED_BASIS],
    handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt);
      return deliverOffers(runtime, str(i, "at") || ctx.now, { logger: runtime.logger, ...(str(i, "as_of_date") ? { as_of_date: D(str(i, "as_of_date")) } : {}), ...(str(i, "program_id") ? { program_id: str(i, "program_id") } : {}), ...(Array.isArray(i["opportunity_ids"]) ? { opportunity_ids: (i["opportunity_ids"] as unknown[]).map(String) } : {}) });
    }),
    decision: (i, output) => { const o = obj(output); return { action: "offer.deliver", subject: { kind: "partner_book_offers", id: str(i, "as_of_date") || "today" }, rationale: `offers delivered ${String(o["delivered"] ?? 0)}, portal only ${String(o["portal_only"] ?? 0)} (33.2 rule 5: e-mail and the portal card; text or voice only with a marketing consent)` }; } },

  { name: "offer.expire", kind: "act", ruleSetVersion: REVIEW_RULE_SET_VERSION, guardrails: [NO_CREDIT_PULL, NO_INVESTOR_FIELDS, NO_PROHIBITED_BASIS],
    handler: compute(async (i, ctx, rt) => expireOffers(runtimeOf(rt), str(i, "at") || ctx.now)),
    decision: (i, output) => { const o = obj(output); return { action: "offer.expire", subject: { kind: "partner_book_offers", id: str(i, "as_of_date") || "today" }, rationale: `opportunities expired ${String(o["expired"] ?? 0)} (33.2 rule 6: every breached SM_REFI_OPPORTUNITY_EXPIRY_30 on a monitored loan → refi.opportunity.expired)` }; } },
]);
export const REFI_ANALYST_TOOLS = TOOLS_33_2.map((t) => t.name);
export { need };
