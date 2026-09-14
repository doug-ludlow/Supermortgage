/**
 * §33.3 process-owned tools — the `refi-readiness` agent's `readiness.run`, `readiness.check`, `readiness.read` and `refi.open`
 * (spec/sections/33-partner-book/33-3-*.md "AI agent design"), defined with `defineTools("33.3", "refi-readiness", defs)` and
 * spread by ./index.ts. Every tool string is one spec/registry/agents.json names for 33.3. Thin bus wrappers over the runtime
 * functions of src/runtime/partner-book-readiness.ts (the pass-shaped tools run the pass through `services.runtime`, their own
 * units of work sequential to this command's — the pattern of 33.2's review.run):
 *
 *   readiness.run    act    the daily pass: one readiness.check per candidate and per open refinance application from a
 *                           monitored loan, then `partner_book.readiness.run_completed` — idempotent per day (07:15 ET gate; `force`).
 *   readiness.check  write  the row for one loan: computed from rows (party-level facts always, application-level once the
 *                           refinance application exists), one readiness_checks row + the decision (rule set
 *                           partner_book.readiness.v1, model deterministic, prompt 33.3-v1, confidence 1) + `partner_book.readiness.checked`.
 *                           ORDERS NOTHING. `party_id` and `application_id` are resolved from the loan when not given.
 *   readiness.read   read   the latest row of a loan (the console and the turn's situation) — nothing written.
 *   refi.open        act    rule 3: the homeowner's Yes opens the refinance application from the monitored loan (idempotent:
 *                           an open application on the loan is returned, nothing more created). The `refi.opportunity.engaged`
 *                           event is resolved from the loan's log only (engaged_event_id / the given object's id / the latest for
 *                           opportunity_id) — an event object in the input is never trusted, so the bus cannot open an application
 *                           on a made-up engagement.
 *
 * Guardrails (the paragraph's list): NO_PULL_BEFORE_YES (never a vendor order, a consumer report or a card before the Yes — these
 * tools take no such instruction at all), YES_REQUIRED (refi.open needs the engagement the borrower's own Yes wrote), ONE_OPEN_APPLICATION_PER_LOAN
 * (never a second open application on the same loan), NO_COMPUTED_FIGURE (never a figure the agent computed on the application —
 * the candidate's and the borrower's only: no amount, rate or value enters through these inputs).
 */
import { defineTools, compute, never, str, flag, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { PgBorrowerUiRepository } from "../../infra/db/borrower-ui.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { ET, partiesOfLoans } from "../../runtime/partner-book-review.ts";
import { READINESS_RULE_SET_VERSION, openRefinanceApplication, projectedNoteDate, readinessCheck, readinessRead, readinessRun, refiOpen } from "../../runtime/partner-book-readiness.ts";
import type { Runtime } from "../../runtime/app.ts";

type P = Record<string, unknown>;
const PROCESS_33_3 = "33.3"; const AGENT = "refi-readiness";
const obj = (v: unknown): P => (v && typeof v === "object" && !Array.isArray(v) ? (v as P) : {});
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const asOfOf = (i: ToolInput, ctx: CommandContext): PlainDate => (str(i, "as_of_date") ? D(str(i, "as_of_date")) : wallClock(Date.parse(ctx.now), ET).date);
const loanOf = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "loan_id") || ctx.loanId; if (!id) throw new RangeError("33.3 tool needs loan_id"); return id; };

// ───────── guardrails ─────────

/** Rule 2 / FCRA §604: the check reads; an instruction to order, pull, request or send anything is refused outright — before or after the Yes, readiness never orders (the owning processes' flows do, after the Yes). */
const PULL_KEYS = new Set(["order", "pull", "credit_pull", "soft_pull", "hard_pull", "order_credit", "order_consumer_report", "consumer_report", "prescreen", "order_verification", "order_income", "order_assets", "order_identity", "vendor_order", "call_vendor", "send_card", "open_card", "push_card", "send_email", "send_sms", "notify", "request", "ask"]);
const pullsBeforeYes = (i: ToolInput): string | null => { const hit = Object.keys(i).find((k) => PULL_KEYS.has(k) && i[k] !== false && i[k] !== null && i[k] !== undefined && i[k] !== ""); return hit ? `input carries \`${hit}\`` : null; };
const NO_PULL_BEFORE_YES = never("NO_PULL_BEFORE_YES", "33.3 rule 2 / Verified requirement / FCRA §604 (15 U.S.C. §1681b) / 32.11 §5: no data is pulled before the homeowner's Yes — the daily check reads; it orders nothing, calls no vendor, sends no card", (i) => pullsBeforeYes(i) !== null, "readiness reads rows only: no vendor order, no consumer report, no card, no message — the owning processes' flows ask after the Yes (32.3 E5/R3, 32.18 rule 1)");
/** Rule 3 / guardrails: never an application without the borrower's own engagement — refi.open names the `refi.opportunity.engaged` event the borrower's Yes wrote (its id, or the opportunity); the event itself is read from the loan's log, never from the input, and the runtime verifies the stored actor (the 32.2 offer.respond actor or a resolved OfferCard with yes). */
const yesMissing = (i: ToolInput): boolean => { const e = obj(i["engaged"]); const named = typeof e["type"] === "string" && e["type"] === "refi.opportunity.engaged" && (typeof e["id"] === "string" || typeof e["payload"] === "object"); return !named && !str(i, "engaged_event_id") && !str(i, "opportunity_id"); };
const YES_REQUIRED = never("YES_REQUIRED", "33.3 rule 3 / guardrails: never an application without the borrower's own engagement — the actor is the borrower's command (32.2 offer.respond) or the resolved OfferCard with yes; an ops-driven or agent-driven engagement never opens one here", (i) => yesMissing(i) || flag(i, "without_yes") || flag(i, "skip_yes") || flag(i, "ops_initiated"), "refi.open needs the homeowner's Yes: the `refi.opportunity.engaged` event (or engaged_event_id / opportunity_id) the borrower's own tap wrote — never an engagement the agent or ops made up");
/** Rule 3 / edge cases: two Yes taps → one application; an instruction to create another is refused. */
const ONE_OPEN_APPLICATION_PER_LOAN = never("ONE_OPEN_APPLICATION_PER_LOAN", "33.3 rule 3 / guardrails / edge cases ('Two Yes taps → one application'): never a second open application on the same loan — refi.open finds the open one and returns it", (i) => flag(i, "force_new") || flag(i, "create_new") || flag(i, "second_application") || flag(i, "duplicate") || flag(i, "replace_open_application"), "one open refinance application per monitored loan: refi.open returns the open one; nothing more is created");
/** Guardrails: never a figure the agent computed on the application — the candidate's (20.1) and the borrower's own only; no amount, rate or value enters through these inputs. */
const FIGURE_KEYS = new Set(["loan_amount_cents", "loan_amount", "amount_cents", "amount", "value_cents", "value", "estimated_value_cents", "property_value", "appraised_value_cents", "payoff_cents", "payoff", "upb_cents", "balance_cents", "rate", "note_rate", "note_rate_pct", "candidate_rate_pct", "pi_cents", "payment_cents", "monthly_payment_cents", "income_monthly_cents", "income_cents", "assets_cents", "ltv", "dti", "npv_cents", "cash_to_close_cents", "closing_costs_cents", "fee_cents", "points"]);
const computedFigure = (i: ToolInput): string | null => { for (const o of [i, obj(i["application"]), obj(i["property"]), obj(i["terms"]), obj(i["borrower"]), obj(i["changes"])]) { const hit = Object.keys(o).find((k) => FIGURE_KEYS.has(k)); if (hit) return hit; } return null; };
const NO_COMPUTED_FIGURE = never("NO_COMPUTED_FIGURE", "33.3 Business rules ('No money figure is computed here; every amount on the refinance application is the candidate's from 20.1 or the borrower's own') / guardrails: never a figure the agent computed on the application", (i) => computedFigure(i) !== null, "no amount, rate or value enters here: the application's figures are the candidate terms (20.1 refi_opportunities) and what the borrower confirms on their own cards");
const GUARDS = [NO_PULL_BEFORE_YES, NO_COMPUTED_FIGURE];

// ───────── the tools ─────────

export const TOOLS_33_3: readonly ToolDef[] = defineTools(PROCESS_33_3, AGENT, [
  { name: "readiness.run", kind: "act", ruleSetVersion: READINESS_RULE_SET_VERSION, guardrails: GUARDS,
    handler: compute(async (i, ctx, rt) => { const runtime = runtimeOf(rt); return readinessRun(runtime, str(i, "at") || ctx.now, { logger: runtime.logger, force: flag(i, "force") }); }),
    decision: (_i, output) => { const o = obj(output); return { action: "readiness.run", subject: { kind: "partner_book_readiness_run", id: String(o["as_of_date"] ?? "") }, rationale: String(o["line"] ?? "partner book readiness") }; } },

  { name: "readiness.check", kind: "write", ruleSetVersion: READINESS_RULE_SET_VERSION, guardrails: GUARDS,
    handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt); const db = dbOf(rt); const loanId = loanOf(i, ctx); const asOf = asOfOf(i, ctx);
      // the refinance application: the one given, else the loan's open one (prior_loan_id = the loan, status not closed), else none (before the Yes)
      const open = str(i, "application_id") ? null : await openRefinanceApplication(db, loanId);
      const application_id = str(i, "application_id") || open?.application_id || null;
      const party_id = str(i, "party_id") || open?.party_id || (await partiesOfLoans(db, [loanId])).get(loanId) || "";
      if (!party_id) throw new RangeError(`loan ${loanId} has no party (33.1 rule 3: borrowers.party_id) — readiness.check needs party_id`);
      const projected = str(i, "projected_note_date") ? D(str(i, "projected_note_date")) : projectedNoteDate(asOf);
      const r = await readinessCheck(runtime, { loan_id: loanId, party_id, application_id, as_of_date: asOf, projected_note_date: projected });
      return { readiness_check_id: r.id, decision_id: r.decision_id, loan_id: loanId, party_id, application_id, as_of_date: asOf, projected_note_date: projected, ready: r.ready, missing: r.missing, items: r.items, rule_set_version: READINESS_RULE_SET_VERSION };
    }),
    decision: () => null },   // the decision row is written with the readiness row (readinessWriteRecord: agent refi-readiness, action readiness.check, rule set partner_book.readiness.v1, model deterministic, prompt 33.3-v1, confidence 1)

  { name: "readiness.read", kind: "read", guardrails: GUARDS,
    handler: compute(async (i, ctx, rt) => { const row = await readinessRead(runtimeOf(rt), loanOf(i, ctx)); return row ? { found: true, ...row } : { found: false, loan_id: loanOf(i, ctx), ready: false, missing: [], items: [] }; }) },

  { name: "refi.open", kind: "act", ruleSetVersion: READINESS_RULE_SET_VERSION, guardrails: [YES_REQUIRED, ONE_OPEN_APPLICATION_PER_LOAN, ...GUARDS],
    handler: compute(async (i, ctx, rt) => {
      const runtime = runtimeOf(rt); const db = dbOf(rt); const loanId = loanOf(i, ctx);
      const given = obj(i["engaged"]); const givenPayload = obj(given["payload"]);
      // YES_REQUIRED: the engagement is READ FROM THE LOAN'S LOG, never taken from the input — an `engaged` object only names the logged row (its id, or its opportunity);
      // the stored row's actor and payload are what the runtime tests (the borrower's own Yes: the 32.2 offer.respond actor or a resolved OfferCard with yes)
      const wantedId = str(i, "engaged_event_id") || (typeof given["id"] === "string" ? given["id"] : "") || null;
      const wantedOpportunity = str(i, "opportunity_id") || (typeof givenPayload["opportunity_id"] === "string" ? givenPayload["opportunity_id"] : "") || null;
      if (wantedId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wantedId)) throw new RangeError(`engaged event ${wantedId} is not a logged event id — the homeowner's Yes has not been logged on loan ${loanId} (YES_REQUIRED)`);
      const rows = await db.query<{ id: string; type: string; occurred_at: string; loan_id: string | null; application_id: string | null; aggregate_kind: string | null; aggregate_id: string | null; actor_kind: string; actor_id: string; actor_role: string | null; payload: P; sequence: string }>(
        `SELECT id::text AS id, type, occurred_at::text AS occurred_at, loan_id::text AS loan_id, application_id::text AS application_id, aggregate_kind, aggregate_id, actor_kind::text AS actor_kind, actor_id, actor_role, payload, sequence::text AS sequence FROM loan_events WHERE type = 'refi.opportunity.engaged' AND loan_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid) AND ($3::text IS NULL OR payload->>'opportunity_id' = $3) ORDER BY loan_events.sequence DESC LIMIT 1`, [loanId, wantedId, wantedOpportunity]);
      const e = rows[0]; if (!e) throw new RangeError(`no refi.opportunity.engaged logged on loan ${loanId}${wantedId ? ` with id ${wantedId}` : ""}${wantedOpportunity ? ` for opportunity ${wantedOpportunity}` : ""} — the homeowner's Yes has not been logged (YES_REQUIRED)`);
      const engaged = { id: e.id, type: e.type, occurredAt: e.occurred_at, loanId: e.loan_id ?? undefined, applicationId: e.application_id ?? undefined, aggregate: e.aggregate_kind && e.aggregate_id ? { kind: e.aggregate_kind, id: e.aggregate_id } : undefined, actor: { kind: e.actor_kind as DomainEvent["actor"]["kind"], id: e.actor_id, ...(e.actor_role ? { role: e.actor_role } : {}) }, payload: e.payload, sequence: Number(e.sequence) } as unknown as DomainEvent;
      const opportunity_id = wantedOpportunity || String(engaged.payload["opportunity_id"] ?? ""); const lead_id = str(i, "lead_id") || String(engaged.payload["lead_id"] ?? "");
      if (!opportunity_id || !lead_id) throw new RangeError("refi.open needs opportunity_id and lead_id (from the engagement or the input)");
      const r = await refiOpen(runtime, { loan_id: loanId, opportunity_id, lead_id, engaged }, { runtime, ui: new PgBorrowerUiRepository(runtime.db), logger: runtime.logger });
      return { loan_id: loanId, opportunity_id, lead_id, application_id: r.application_id, created: r.created, rule_set_version: READINESS_RULE_SET_VERSION };
    }),
    decision: (i, output) => { const o = obj(output); return { action: "refi.open", subject: { kind: "application", id: String(o["application_id"] ?? "") }, rationale: `${o["created"] === true ? "refinance application opened" : "the open refinance application returned (one per loan)"} for loan ${String(o["loan_id"] ?? str(i, "loan_id"))} on the homeowner's Yes (opportunity ${String(o["opportunity_id"] ?? "")}); 33.3 rule 3: channel refi_trigger, prior_loan_id = the loan, the party linked, the property with the facts' value; no figure computed here` }; } },
]);
export const REFI_READINESS_TOOLS = TOOLS_33_3.map((t) => t.name);
