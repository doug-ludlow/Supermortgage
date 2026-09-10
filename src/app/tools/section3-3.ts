/**
 * §3.3 process-owned tools — additional bus tools for 3.3 defined with `defineTools("3.3", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section03.ts). Every tool string must be one
 * spec/registry/agents.json names for 3.3; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * The 3.3 agents row names renderStatement / validateChecklist / sendNotice only, all registered in ./section03.ts (p33);
 * the 3.3 renderStatement's handler is `renderAnnualStatement_3_3` below ("Renders from approved analysis; … applies
 * exemption policy"). It is the state machine's `due` step: the (i)(2) exemption test (rule 5) runs over the engine's own
 * facts — the approved annual analysis's `regx_days_delinquent` (the `escrow_analyses` record runEscrowAnalysis stored,
 * or the approval fact's `borrower_current`), the log's open foreclosure action / bankruptcy case — and either records the
 * hold (`escrow.statement.exempt_hold`, domain/escrow/ops-3-3.ts applyExemptionPolicy → ops.ts recordExemptHold: the
 * REGX_1024_17I_ANNUAL_STMT_30 satisfier with a valid (i)(2) reason; no statement rendered) or assembles the statement
 * (with the §14 legend on a bankruptcy loan). On a held loan, `requested_on` + `regx_days_delinquent_at_request` is the
 * borrower's request while current (`escrow.statement.requested`, send target +5 business days, no new timer) and the
 * statement renders; its annual send closes the hold. Before deciding, the tool ingests lazily the §13.3 / §14.1 cause
 * events already on the log (settleExemption) so a reinstatement recorded while no reactor listened still ends the hold
 * on its own date — the REGX_1024_17I2_POST_EXEMPTION_HISTORY_90 trigger; the history's send is sendNotice's
 * recordStatementSent (`escrow.statement.sent{statement_type=post_exemption_history}`).
 */
import { compute, str, cents, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import type { Decision, Projection } from "../../domain/escrow/analysis.ts";
import type { Plan } from "../../domain/escrow/shortage.ts";
import { assembleAnnualStatement, type StatementHistoryRow } from "../../domain/escrow/ops.ts";
import { applyExemptionPolicy, exemptionFactsFromLog, openExemptHold, recordBorrowerRequest, settleExemption } from "../../domain/escrow/ops-3-3.ts";

const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
/** The engine's latest approved annual analysis on the loan (3.3 inputs: "`escrow.analysis.approved` (type annual) → render the annual statement"). */
const annualApproval = (ctx: CommandContext, loanId: string, analysisId: string): DomainEvent | undefined => {
  const approvals = ctx.events.ofType("escrow.analysis.approved").filter((e) => e.loanId === loanId && p(e).analysis_type === "annual" && (!analysisId || p(e).analysis_id === analysisId));
  return approvals[approvals.length - 1];
};
const shortageOf = (d: unknown): bigint => { const x = d as { kind?: unknown; shortage_cents?: unknown; deficiency_cents?: unknown } | undefined; return x?.kind === "shortage" ? cents(x.shortage_cents) + cents(x.deficiency_cents) : 0n; };

export const renderAnnualStatement_3_3 = compute((i: ToolInput, ctx, rt) => {
  const loanId = (typeof i.loan_id === "string" && i.loan_id) || ctx.loanId;
  // Lazy ingestion: a §13.3 reinstatement / case closing or §14.1 case closing already on the log ends an open hold on the date it carries (the eager path is exemptionReactors_3_3).
  const settled = settleExemption(ctx.events, loanId, ctx.actor);
  const approval = annualApproval(ctx, loanId, str(i, "analysis_id"));
  if (!approval) throw new RangeError(`no approved annual analysis on loan ${loanId}${i.analysis_id ? ` (${str(i, "analysis_id")})` : ""}: approveAnalysis first (3.3 inputs)`);
  const analysisId = String(p(approval).analysis_id ?? "");
  const rec = rt.store.get("escrow_analyses", analysisId)?.data;
  // §1024.17(i)(2) "more than 30 days overdue": the engine's day count on its analysis record; the approval fact's own `borrower_current` (≤ 30 days) when the record is not in this runtime.
  const days = typeof rec?.regx_days_delinquent === "number" ? rec.regx_days_delinquent : p(approval).borrower_current === false ? 31 : 0;
  const asOf = isDate(p(approval).as_of) ? p(approval).as_of as PlainDate : D(approval.occurredAt.slice(0, 10));
  const facts = exemptionFactsFromLog(ctx.events, loanId);
  const yearEnd = isDate(i.year_end) ? D(i.year_end) : isDate(p(approval).computation_year_end) ? p(approval).computation_year_end as PlainDate : (() => { throw new RangeError("year_end is required (the computation year end the statement covers)"); })();
  const yearStart = isDate(i.year_start) ? D(i.year_start) : addDays(addMonths(yearEnd, -12), 1);
  const approvedOn = isDate(i.approved_on) ? D(i.approved_on) : D(approval.occurredAt.slice(0, 10));
  // The state machine's `due` step: a hold is recorded once (rule 5); on a held loan only the borrower's request while current renders.
  let request: ReturnType<typeof recordBorrowerRequest> | null = null;
  let policy: ReturnType<typeof applyExemptionPolicy>;
  if (openExemptHold(ctx.events, loanId) && (i.requested_on !== undefined || i.regx_days_delinquent_at_request !== undefined)) {
    request = recordBorrowerRequest(ctx.events, { loan_id: loanId, requested_on: D(str(i, "requested_on")), regx_days_delinquent_at_request: Number(i.regx_days_delinquent_at_request), actor: ctx.actor });
    policy = { status: "render", exemption: null, bankruptcy: facts.bankruptcy_open && facts.bankruptcy_chapter ? { chapter: facts.bankruptcy_chapter } : null, as_of: asOf, analysis_id: analysisId };
  } else {
    policy = applyExemptionPolicy(ctx.events, { loan_id: loanId, analysis_id: analysisId, as_of: asOf, regx_days_delinquent: days, facts, shortage_cents: shortageOf(rec?.decision), actor: ctx.actor });
    if (policy.status === "exempt_hold") return { ...policy, regx_days_delinquent: days, facts, rendered: false, settled: settled.ended?.status ?? null };
  }
  const decision = (i.decision as Decision | undefined) ?? (rec?.decision as Decision | undefined);
  const s = assembleAnnualStatement({ year_start: yearStart, year_end: yearEnd, approved_on: approvedOn, new_payment_cents: cents(i.new_payment_cents), prior_escrow_portion_cents: cents(i.prior_escrow_portion_cents), history: (i.history as StatementHistoryRow[]) ?? [],
    ...(decision ? { decision } : { decision_text: str(i, "decision_text") }), ...(i.plan ? { plan: i.plan as Plan } : {}), ...(i.prior_projection ? { prior_projection: i.prior_projection as Projection } : {}), low_point_explanation: (i.low_point_explanation as string[]) ?? [], bankruptcy: policy.bankruptcy });
  return { ...s, status: request ? "rendered_on_request" : "rendered", rendered: true, exemption: null, analysis_id: analysisId, regx_days_delinquent: days, facts, request: request ? { requested_on: request.requested_on, send_target_on: request.send_target_on, new_timer: null } : null, settled: settled.ended?.status ?? null };
});

export const TOOLS_3_3: readonly ToolDef[] = [];
