/**
 * §3.6 tools — shortage repayment (`escrow`). spec/registry/agents.json names three tool strings for 3.6
 * (`createRepaymentPlan`, `recordBorrowerElection`, `postEscrowLumpSum`; src/app/tools.test.ts refuses the rest), defined
 * with `defineTools("3.6", "escrow", defs)` and spread by ./index.ts (the §3 section file ./section03.ts carries no 3.6
 * block). Every handler appends the `loan_events` the 3.6 timer rows arm on and are satisfied by through
 * src/domain/escrow/ops-3-6.ts:
 *
 *   createRepaymentPlan     the plan the latest approved analysis proposes (3.6 inputs: "`escrow.analysis.approved` with
 *                           decision.shortage_cents > 0 or deficiency_cents > 0"), bound by the registry gates — asserted here on
 *                           facts read from the loan's events, never from the caller: REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE
 *                           (3.6.interimAnalysisBeforeDemand — a non-default advance without its interim analysis), REGX_1024_17F3_…
 *                           (3.6.shortageMinSpread), REGX_1024_17F4_… (3.6.deficiencyMinInstallments), FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE
 *                           (3.6.workoutSpread60 — `borrower_election_evidenced` is the loan's `escrow.election.recorded` fact). Writes
 *                           `escrow_repayment_plans`, supersedes the active plan of the same kind (T9), versions `loan_terms` with the
 *                           step-down date (rule 5) and appends `escrow.repayment_plan.created` (+ `.superseded`, `loan_terms.versioned`).
 *   recordBorrowerElection  rule 3: a lump-sum or shorter-period (≥ 12 months) election with evidence → `escrow.election.recorded`.
 *   postEscrowLumpSum       rule 4: post to `escrow`, `paid_lump` when received ≥ remaining, `escrow.lump_sum.received{received_on}`
 *                           (arms ESC_LUMPSUM_REANALYSIS_10BD, satisfied by the interim `escrow.analysis.completed`).
 *
 * `assertAnalysisApprovalGates36` is the "analysis approval" the three gate rows are satisfied by: approveAnalysis (./section03.ts)
 * asserts the gates on the engine's decision before appending `escrow.analysis.approved` (breach column: "approval refused").
 */
import { defineTools, compute, guard, never, str, num, flag, cents, data, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { assertGate } from "../evaluators.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Decision } from "../../domain/escrow/analysis.ts";
import { buildPlan, type Plan, type PlanOptions } from "../../domain/escrow/shortage.ts";
import {
  recordElection, evidencedElection, advanceAwaitingAnalysis, latestApprovedAnalysis, analysisFacts, planGateFacts, planRecord, loanTermsVersion, recordPlanCreated, receiveLumpSum,
  ELECTION_MIN_MONTHS, type Election, type ElectionKind, type RepaymentPlanRecord,
} from "../../domain/escrow/ops-3-6.ts";

const PLANS = "escrow_repayment_plans";
const ELECTIONS = "escrow_elections";
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const kindOf = (i: ToolInput): Plan["kind"] => { const k = str(i, "kind") || "shortage"; if (k !== "shortage" && k !== "deficiency") throw new RangeError(`kind ${k} is not shortage|deficiency`); return k; };
const optNum = (i: ToolInput, k: string): number | undefined => (i[k] === undefined || i[k] === null ? undefined : num(i, k));

// ---- gate facts: read from the loan's events and the input's shape, never from caller-supplied verdicts ------------------------
interface PlanShape { readonly kind: Plan["kind"]; readonly workout: boolean; readonly election: Election | null; readonly options: PlanOptions; readonly months: number; readonly one_month_cents: Cents; readonly analysis_id: string | null; }
/** The plan the input describes: spread options, the analysis it follows, and the months buildPlan would give it (an election below 12 keeps its months so the gate refuses it). */
const planShape = (i: ToolInput, ctx: CommandContext): PlanShape => {
  const kind = kindOf(i);
  const approved = latestApprovedAnalysis(ctx.events, ctx.loanId);
  const facts = approved ? analysisFacts(ctx.events, ctx.loanId, approved.analysis_id) : null;
  const workout = flag(i, "workout") || (facts?.workout ?? false);
  const election = evidencedElection(ctx.events, ctx.loanId);
  // Rule 3: the caller's `election_months` is honored only against the loan's evidenced election; with none given, a workout plan takes the recorded election.
  const electionMonths = optNum(i, "election_months") ?? (workout && election?.kind === "shorter_period" ? election.months ?? undefined : undefined);
  const options: PlanOptions = { workout, ...(electionMonths !== undefined ? { election_months: electionMonths } : {}), ...(optNum(i, "instrument_max_months") !== undefined ? { instrument_max_months: num(i, "instrument_max_months") } : {}),
    ...(typeof i.state === "string" ? { state: i.state } : {}), ...(kind === "deficiency" && (optNum(i, "deficiency_installments") ?? optNum(i, "months")) !== undefined ? { deficiency_installments: optNum(i, "deficiency_installments") ?? num(i, "months") } : {}),
    ...(kind === "shortage" && !workout && optNum(i, "months") !== undefined && num(i, "months") !== 1 ? { policy_months: num(i, "months") } : {}), ...(kind === "shortage" && (str(i, "option") === "30_day" || optNum(i, "months") === 1) ? { thirty_day: true } : {}) };
  const built = buildPlan(kind, 1n, D("2000-01-01"), options);
  const months = "error" in built ? (electionMonths ?? NaN) : built.months;
  return { kind, workout, election, options, months, one_month_cents: facts?.base_payment_cents ?? 0n, analysis_id: approved?.analysis_id ?? null };
};
const gateRefusal = (ref: string, facts: Record<string, unknown>): string | undefined => { try { assertGate(ref, facts); return undefined; } catch (e) { return (e as Error).message; } };
/** The shortage the gate compares with one month's payment: the caller's total (the handler refuses one that is not the engine's), or — unstated — the one-month figure itself so the 30-day option is never opened blind. */
const statedShortage = (i: ToolInput, s: PlanShape): Cents => (i.total_cents === undefined ? s.one_month_cents : cents(i.total_cents));

// ---- createRepaymentPlan -------------------------------------------------------------------------------------------------------
/** The active plans on the loan (store) — the one of the same kind is superseded by a new plan (T9; edge case 1). */
const activePlans = (rt: ToolRuntime, loanId: string): RepaymentPlanRecord[] =>
  rt.store.list(PLANS, (d) => d.loan_id === loanId && d.status === "active").map((r) => r.data as unknown as RepaymentPlanRecord);

const createRepaymentPlan: Omit<ToolDef, "process" | "agent"> = { name: "createRepaymentPlan", kind: "act", handler: compute((i, ctx, rt) => {
  const s = planShape(i, ctx);
  if (!s.analysis_id) throw new RangeError("no approved escrow analysis on this loan: runEscrowAnalysis + approveAnalysis first (3.6 inputs)");
  const rec = rt.store.get("escrow_analyses", s.analysis_id); if (!rec) throw new RangeError(`no analysis record ${s.analysis_id}`);
  const a = rec.data as unknown as { decision: Decision; year_start: PlainDate; projection: { base_payment_cents: Cents } };
  const d = a.decision; if (d.kind !== "shortage") throw new RangeError(`analysis ${s.analysis_id} decided ${d.kind}: no shortage or deficiency to repay`);
  const engineTotal = s.kind === "deficiency" ? d.deficiency_cents : d.shortage_cents;
  if (engineTotal <= 0n) throw new RangeError(`analysis ${s.analysis_id} carries no ${s.kind} (${engineTotal} cents)`);
  // 3.1 guardrails: the agent cannot edit engine outputs — a stated total must be the engine's figure.
  const total = i.total_cents === undefined ? engineTotal : cents(i.total_cents);
  if (total !== engineTotal) throw new RangeError(`total_cents ${total} is not the engine's ${s.kind} of ${engineTotal} cents (analysis ${s.analysis_id}); engine outputs are not editable`);
  const start = i.start ? D(str(i, "start")) : a.year_start;
  const built = buildPlan(s.kind, total, start, s.options); if ("error" in built) throw new RangeError(built.error);
  const id = str(i, "plan_id") || `RP-${ctx.loanId}-${rt.store.list(PLANS).length + 1}`;
  const plan = planRecord(id, ctx.loanId, s.analysis_id, built, s.one_month_cents || a.projection.base_payment_cents, s.election);
  const active = activePlans(rt, ctx.loanId); const supersedes = active.filter((x) => x.kind === plan.kind); const others = active.filter((x) => x.kind !== plan.kind);
  const gates = [s.kind === "shortage" ? "REGX_1024_17F3_SHORTAGE_MIN_SPREAD_GATE" : "REGX_1024_17F4_DEFICIENCY_MIN_INSTALLMENTS_GATE", ...(s.workout ? ["FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE"] : []), ...(s.kind === "deficiency" ? ["REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE"] : [])];
  const terms = loanTermsVersion(plan, others);
  for (const old of supersedes) rt.store.put(PLANS, old.id, { status: "superseded", superseded_by: id }, ctx.actor, ctx.now);
  const termsRec = rt.store.put("loan_terms", ctx.loanId, { loan_id: ctx.loanId, ...terms }, ctx.actor, ctx.now);
  recordPlanCreated(ctx.events, { plan, supersedes, terms, terms_version: termsRec.version, gates, actor: ctx.actor });
  rt.store.put(PLANS, id, plan as unknown as Record<string, unknown>, ctx.actor, ctx.now);
  return { ...plan, superseded: supersedes.map((x) => x.id), loan_terms: { version: termsRec.version, ...terms }, gates };
}),
  decision: (i, out, ctx) => { const o = out as RepaymentPlanRecord & { gates: string[] }; return { action: "escrow.repayment_plan.created", rationale: str(i, "rationale") || `${o.kind} ${o.total_cents} cents → ${o.months} × ${o.installment_cents} (final ${o.final_installment_cents}) from ${o.start_due_date}; basis ${o.basis}; gates ${o.gates.join(", ")}; by ${ctx.actor.kind}:${ctx.actor.id}`, subject: { kind: "escrow_repayment_plan", id: o.id }, ruleCode: o.basis === "workout_60" || o.basis === "election" ? "FNMA B-1-01" : o.basis === "nh_0pct" ? "NH RSA 397-A:9, III" : "§1024.17(f)(3)–(4)", ...(o.election_evidence_document_id ? { evidenceDocumentIds: [o.election_evidence_document_id] } : {}) }; },
  guardrails: [
    // (f)(1)(ii): a deficiency from a servicer advance (non-default cause) is not demanded before the interim analysis — the gate fact is the loan's own `escrow.analysis.completed` after the advance, never a caller-supplied `analysis_done`.
    guard("3.6.interimAnalysisBeforeDemand", "REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE", (i, ctx) => { if (kindOf(i) !== "deficiency") return undefined; const g = advanceAwaitingAnalysis(ctx.events, ctx.loanId); return g.advance ? gateRefusal("3.6.interimAnalysisBeforeDemand", { analysis_done: g.analysis_done }) : undefined; }),
    guard("ANALYSIS_REQUIRED", "3.6 inputs: `escrow.analysis.approved` with decision.shortage_cents > 0 or deficiency_cents > 0 → repayment plan", (_i, ctx) => (latestApprovedAnalysis(ctx.events, ctx.loanId) ? undefined : "a repayment plan follows an approved escrow analysis; none on this loan")),
    // B-1-01 governs a workout plan (60 months unless an evidenced ≥12-month election), so its gate is read before the Reg X floor.
    guard("3.6.workoutSpread60", "FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE", (i, ctx) => { const s = planShape(i, ctx); return s.workout && s.kind === "shortage" ? gateRefusal("3.6.workoutSpread60", planGateFacts(s.months, statedShortage(i, s), s.one_month_cents, s.election)) : undefined; }),
    guard("3.6.shortageMinSpread", "REGX_1024_17F3_SHORTAGE_MIN_SPREAD_GATE", (i, ctx) => { if (kindOf(i) !== "shortage") return undefined; const s = planShape(i, ctx); return gateRefusal("3.6.shortageMinSpread", planGateFacts(s.months, statedShortage(i, s), s.one_month_cents, s.election)); }),
    guard("3.6.deficiencyMinInstallments", "REGX_1024_17F4_DEFICIENCY_MIN_INSTALLMENTS_GATE", (i, ctx) => { if (kindOf(i) !== "deficiency") return undefined; const s = planShape(i, ctx); return gateRefusal("3.6.deficiencyMinInstallments", planGateFacts(s.months, 0n, s.one_month_cents, s.election)); }),
    never("NO_INTEREST_OR_FEES", "3.6 guardrails: no interest; no fees", (i) => cents(i.interest_cents) > 0n || cents(i.fee_cents) > 0n || i.interest_bearing === true, "no interest or fees on escrow repayment"),
  ] };

// ---- recordBorrowerElection ----------------------------------------------------------------------------------------------------
/** Election fields arrive at the top level or under `data` (the generic write shape). */
const electionOf = (i: ToolInput): Record<string, unknown> => ({ ...data(i), ...i });
const electionKind = (e: Record<string, unknown>): ElectionKind => (e.lump_sum === true || e.kind === "lump_sum" ? "lump_sum" : "shorter_period");
const recordBorrowerElection: Omit<ToolDef, "process" | "agent"> = { name: "recordBorrowerElection", kind: "write", handler: compute((i, ctx, rt) => {
  const e = electionOf(i); const kind = electionKind(e);
  const id = typeof e.election_id === "string" && e.election_id ? e.election_id : typeof e.id === "string" && e.id ? e.id : `EL-${ctx.loanId}-${rt.store.list(ELECTIONS).length + 1}`;
  const { election } = recordElection(ctx.events, { loan_id: ctx.loanId, election_id: id, kind, months: kind === "lump_sum" ? null : Number(e.months ?? NaN), evidence_document_id: typeof e.evidence_document_id === "string" ? e.evidence_document_id : null, recorded_call_id: typeof e.recorded_call_id === "string" ? e.recorded_call_id : null,
    analysis_id: typeof e.analysis_id === "string" ? e.analysis_id : latestApprovedAnalysis(ctx.events, ctx.loanId)?.analysis_id ?? null, recorded_on: e.recorded_on ? D(String(e.recorded_on)) : today(ctx) }, ctx.actor);
  return rt.store.put(ELECTIONS, id, { loan_id: ctx.loanId, ...election }, ctx.actor, ctx.now).data;
}),
  decision: (i, out, ctx) => { const o = out as Election; return { action: "escrow.election.recorded", rationale: str(i, "rationale") || `${o.kind}${o.months ? ` ${o.months} months` : ""} elected with evidence ${o.evidence_document_id ?? o.recorded_call_id}; by ${ctx.actor.kind}:${ctx.actor.id}`, subject: { kind: "escrow_election", id: o.election_id }, ruleCode: "FNMA B-1-01", ...(o.evidence_document_id ? { evidenceDocumentIds: [o.evidence_document_id] } : {}) }; },
  guardrails: [never("EVIDENCED", "3.6 rule 3: borrower elections are captured with evidence (recorded call with disclosure, portal e-form, or signed form)", (i) => { const e = electionOf(i); return !e.evidence_document_id && !e.recorded_call_id; }, "an election needs evidence (evidence_document_id or recorded_call_id)"),
    never("ELECTION_MIN_12", "FNMA B-1-01: a shorter period 'of not less than 12 months'", (i) => { const e = electionOf(i); return electionKind(e) === "shorter_period" && !(Number(e.months) >= ELECTION_MIN_MONTHS); }, `a shorter-period election is at least ${ELECTION_MIN_MONTHS} months (≥ 12)`)] };

// ---- postEscrowLumpSum ---------------------------------------------------------------------------------------------------------
const postEscrowLumpSum: Omit<ToolDef, "process" | "agent"> = { name: "postEscrowLumpSum", kind: "act", handler: compute((i, ctx, rt) => {
  const amount = cents(i.amount_cents); if (amount <= 0n) throw new RangeError("postEscrowLumpSum needs a positive amount_cents");
  const planId = str(i, "plan_id") || activePlans(rt, ctx.loanId)[0]?.id || ""; if (!planId) throw new RangeError("no active repayment plan on this loan");
  const rec = rt.store.get(PLANS, planId); if (!rec) throw new RangeError(`no plan ${planId}`);
  const plan = { ...(rec.data as unknown as RepaymentPlanRecord) };
  const out = receiveLumpSum(ctx.events, ctx.ledger, { plan, amount_cents: amount, received_on: i.received_on ? D(str(i, "received_on")) : today(ctx), ...(typeof i.custodial_account_id === "string" ? { custodial_account_id: i.custodial_account_id } : {}), actor: ctx.actor, now: ctx.now });
  rt.store.put(PLANS, planId, { status: plan.status, collected_cents: plan.collected_cents, remaining_cents: plan.remaining_cents }, ctx.actor, ctx.now);
  return { plan_id: out.plan_id, paid: out.paid, status: out.status, remaining_cents: out.remaining_cents, interim_analysis_by: out.interim_analysis_by, entry_set_id: out.entry_set_id };
}),
  decision: (i, out, ctx) => { const o = out as { plan_id: string; paid: boolean; interim_analysis_by: PlainDate }; return { action: "escrow.lump_sum.received", rationale: str(i, "rationale") || `unsolicited lump sum ${String(i.amount_cents)} cents on plan ${o.plan_id}${o.paid ? " (paid_lump)" : ""}; interim analysis by ${o.interim_analysis_by}; by ${ctx.actor.kind}:${ctx.actor.id}`, subject: { kind: "escrow_repayment_plan", id: o.plan_id }, ruleCode: "3.6 rule 4; CFPB FAQ (unsolicited lump sums)" }; },
  guardrails: [never("UNSOLICITED_ONLY", "3.6 rule 8 / CFPB FAQ: a lump sum is accepted when the borrower offers it; the servicer never demands or offers it in the statement", (i) => i.demanded === true || i.solicited === true, "a lump-sum repayment is accepted only as the borrower's own unsolicited payment")] };

export const TOOLS_3_6: readonly ToolDef[] = defineTools("3.6", "escrow", [createRepaymentPlan, recordBorrowerElection, postEscrowLumpSum]);

// ---- "analysis approval" — the satisfying act of the three gate rows -----------------------------------------------------------
/**
 * REGX_1024_17F3_SHORTAGE_MIN_SPREAD_GATE / REGX_1024_17F4_DEFICIENCY_MIN_INSTALLMENTS_GATE / FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE are
 * "satisfied by analysis approval; breach: approval refused": approveAnalysis asserts them on the engine's decision (the plan it proposes)
 * before `escrow.analysis.approved` closes the armed instances. Throws GateClosed (the refusal). Returns the refs asserted.
 */
export function assertAnalysisApprovalGates36(ctx: CommandContext, analysisId: string, decision: Decision, oneMonthCents: Cents): string[] {
  if (decision.kind !== "shortage") return [];
  const election = evidencedElection(ctx.events, ctx.loanId); const workout = analysisFacts(ctx.events, ctx.loanId, analysisId).workout; const asserted: string[] = [];
  if (decision.shortage_cents > 0n) { assertGate("3.6.shortageMinSpread", planGateFacts(decision.months, decision.shortage_cents, oneMonthCents, election)); asserted.push("3.6.shortageMinSpread"); }
  if (decision.deficiency_cents > 0n) { const dm = decision.deficiency_installment_cents > 0n ? Number((decision.deficiency_cents + decision.deficiency_installment_cents - 1n) / decision.deficiency_installment_cents) : 0; assertGate("3.6.deficiencyMinInstallments", planGateFacts(dm, 0n, oneMonthCents, election)); asserted.push("3.6.deficiencyMinInstallments"); }
  if (workout && decision.shortage_cents > 0n) { assertGate("3.6.workoutSpread60", planGateFacts(decision.months, decision.shortage_cents, oneMonthCents, election)); asserted.push("3.6.workoutSpread60"); }
  return asserted;
}
