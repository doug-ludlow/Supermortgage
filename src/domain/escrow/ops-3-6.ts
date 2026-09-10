/**
 * §3.6 process ops — the repayment-plan lifecycle facts the 3.6 tools append (src/app/tools/section3-6.ts) and the
 * gate facts they assert. Spec "Outputs and artifacts": "`escrow_repayment_plans`; `loan_terms` versions (payment and
 * step-down); … `loan_events`: `escrow.repayment_plan.created/completed/superseded/paid_lump/cancelled`,
 * `escrow.deficiency.retained`, `escrow.lump_sum.received`."
 *
 *   recordElection        rule 3 — "lump sum, or a shorter period ≥ 12 months, captured with evidence" → `escrow.election.recorded`
 *   evidencedElection     the loan's latest evidenced election (the `borrower_election_evidenced` fact of FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE)
 *   advanceAwaitingAnalysis  REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE: the latest `escrow.advance.posted{cause!=default}` and whether an
 *                         `escrow.analysis.completed` follows it ((f)(1)(ii): "analysis required before seeking repayment of a servicer advance
 *                         not caused by borrower default")
 *   planGateFacts         the facts of the three plan gates (3.6.shortageMinSpread / 3.6.deficiencyMinInstallments / 3.6.workoutSpread60)
 *   recordPlanCreated     rule 1 plan + rule 5 `loan_terms` version ("a new `loan_terms` version is created at plan creation with the
 *                         step-down date so no re-analysis is needed"); supersedes the loan's active plan of the same kind (T9 / edge case 1)
 *   receiveLumpSum        rule 4 — "post to `escrow`; mark plan `paid_lump` when received ≥ remaining; run an interim analysis within 10 BD"
 *                         → ledger set + `escrow.lump_sum.received{received_on}` (arms ESC_LUMPSUM_REANALYSIS_10BD) + `escrow.repayment_plan.paid_lump`
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addMonths, plainDate } from "../../kernel/calendar/date.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { Ledger, LineInput } from "../../kernel/ledger/ledger.ts";
import { lumpSum, type Plan } from "./shortage.ts";

export const ELECTION_RECORDED = "escrow.election.recorded" as const;
export const PLAN_CREATED = "escrow.repayment_plan.created" as const;
export const PLAN_SUPERSEDED = "escrow.repayment_plan.superseded" as const;
export const PLAN_PAID_LUMP = "escrow.repayment_plan.paid_lump" as const;
export const LUMP_SUM_RECEIVED = "escrow.lump_sum.received" as const;
export const LOAN_TERMS_VERSIONED = "loan_terms.versioned" as const;
/** Fannie Mae B-1-01: a workout borrower may elect "a shorter period of not less than 12 months". */
export const ELECTION_MIN_MONTHS = 12;

const need = (cond: boolean, what: string): void => { if (!cond) throw new RangeError(what); };
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const latest = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
const loanEvents = (events: EventStore, loanId: string, type: string): readonly DomainEvent[] => events.byLoan(loanId).filter((e) => e.type === type);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// ============================================================ borrower elections (rule 3; T4)
export type ElectionKind = "shorter_period" | "lump_sum";
export interface ElectionInput {
  readonly loan_id: string; readonly election_id: string; readonly kind: ElectionKind;
  /** Months of the shorter spread (null for a lump-sum election). */
  readonly months: number | null;
  readonly evidence_document_id: string | null; readonly recorded_call_id: string | null; readonly analysis_id?: string | null; readonly recorded_on: PlainDate;
}
export interface Election { readonly election_id: string; readonly kind: ElectionKind; readonly months: number | null; readonly evidence_document_id: string | null; readonly recorded_call_id: string | null; readonly analysis_id: string | null; readonly recorded_on: PlainDate; }

/** Validate and append the election fact; the evidence (e-signed form / recorded call) is what makes it `evidenced`. */
export function recordElection(events: EventStore, i: ElectionInput, actor: Actor): { event: DomainEvent; election: Election } {
  need(!!i.loan_id && !!i.election_id, "loan_id and election_id are required");
  need(i.kind === "shorter_period" || i.kind === "lump_sum", `election kind ${String(i.kind)} is not shorter_period|lump_sum`);
  need(!!i.evidence_document_id || !!i.recorded_call_id, "an election needs evidence (evidence_document_id or recorded_call_id)");
  if (i.kind === "shorter_period") { need(Number.isInteger(i.months) && (i.months as number) >= ELECTION_MIN_MONTHS, `a shorter period is at least ${ELECTION_MIN_MONTHS} months (B-1-01)`); }
  else need(i.months === null, "a lump-sum election carries no months");
  const election: Election = { election_id: i.election_id, kind: i.kind, months: i.months, evidence_document_id: i.evidence_document_id, recorded_call_id: i.recorded_call_id, analysis_id: i.analysis_id ?? null, recorded_on: i.recorded_on };
  const event = events.append({ type: ELECTION_RECORDED, loanId: i.loan_id, actor, payload: { ...election, evidenced: true } });
  return { event, election };
}
/** The loan's latest evidenced election (a `recordElection` fact carrying evidence), or null. */
export function evidencedElection(events: EventStore, loanId: string): Election | null {
  const e = latest(loanEvents(events, loanId, ELECTION_RECORDED).filter((x) => p(x).evidenced === true && (str(p(x).evidence_document_id) || str(p(x).recorded_call_id))));
  if (!e) return null;
  const x = p(e);
  return { election_id: String(x.election_id), kind: x.kind as ElectionKind, months: typeof x.months === "number" ? x.months : null, evidence_document_id: str(x.evidence_document_id), recorded_call_id: str(x.recorded_call_id), analysis_id: str(x.analysis_id), recorded_on: plainDate(String(x.recorded_on)) };
}

// ============================================================ (f)(1)(ii) advance gate (T8)
/** The registry trigger `escrow.advance.posted{cause!=default}` and whether the interim `escrow.analysis.completed` followed it. */
export function advanceAwaitingAnalysis(events: EventStore, loanId: string): { advance: DomainEvent | null; analysis_done: boolean } {
  const advance = latest(loanEvents(events, loanId, "escrow.advance.posted").filter((e) => p(e).cause !== "default")) ?? null;
  if (!advance) return { advance: null, analysis_done: true };
  return { advance, analysis_done: loanEvents(events, loanId, "escrow.analysis.completed").some((e) => e.sequence > advance.sequence) };
}
/** The loan's latest approved analysis (`escrow.analysis.approved`) — the input a plan is created from (3.6 inputs). */
export function latestApprovedAnalysis(events: EventStore, loanId: string): { analysis_id: string; event: DomainEvent } | null {
  const e = latest(loanEvents(events, loanId, "escrow.analysis.approved")); return e ? { analysis_id: String(p(e).analysis_id), event: e } : null;
}
/** The engine's `escrow.analysis.completed` / `escrow.analysis.computing` facts for one analysis id. */
export function analysisFacts(events: EventStore, loanId: string, analysisId: string): { completed: DomainEvent | null; workout: boolean; base_payment_cents: Cents; analysis_type: string } {
  const completed = latest(loanEvents(events, loanId, "escrow.analysis.completed").filter((e) => p(e).analysis_id === analysisId)) ?? null;
  const computing = latest(loanEvents(events, loanId, "escrow.analysis.computing").filter((e) => p(e).analysis_id === analysisId)) ?? null;
  return { completed, workout: !!computing && p(computing).reason === "workout", base_payment_cents: completed ? BigInt(String(p(completed).base_payment_cents ?? "0")) : 0n, analysis_type: completed ? String(p(completed).analysis_type ?? "") : "" };
}

// ============================================================ gate facts (timer table rows; evaluators-3-6.ts)
export type PlanGateFacts = { readonly plan_months: number; readonly shortage_cents: Cents; readonly one_month_escrow_cents: Cents; readonly borrower_election_evidenced: boolean; };
/**
 * The facts the three plan gates read: `plan_months` is the spread the plan would have; `borrower_election_evidenced` holds only when the
 * loan carries an evidenced shorter-period election for exactly that spread (rule 3 — the caller's `election_months` is not evidence).
 */
export function planGateFacts(months: number, shortageCents: Cents, oneMonthCents: Cents, election: Election | null): PlanGateFacts {
  return { plan_months: months, shortage_cents: shortageCents, one_month_escrow_cents: oneMonthCents, borrower_election_evidenced: !!election && election.kind === "shorter_period" && election.months === months };
}

// ============================================================ plan records (rules 1, 5; T1, T9)
export interface RepaymentPlanRecord extends Plan {
  readonly id: string; readonly loan_id: string; readonly analysis_id: string | null; remaining_cents: Cents;
  readonly election_id: string | null; readonly election_evidence_document_id: string | null; readonly interest_bearing: false;
  /** The engine's base escrow payment the plan's installment is added to (rule 5 / `loan_terms`). */
  readonly base_payment_cents: Cents;
  /** Rule 5: the payment steps down the month after `end_due_date`. */
  readonly step_down_on: PlainDate;
}
/** Rule 5 `loan_terms` version: escrow payment = base + every active installment; steps down to base + the other plans' installments after this plan ends. */
export interface LoanTermsVersion { readonly escrow_payment_cents: Cents; readonly escrow_payment_effective_from: PlainDate; readonly escrow_step_down_on: PlainDate; readonly escrow_step_down_to_cents: Cents; readonly shortage_installment_cents: Cents; readonly deficiency_installment_cents: Cents; readonly plan_id: string; }

export function planRecord(id: string, loanId: string, analysisId: string | null, plan: Plan, base: Cents, election: Election | null): RepaymentPlanRecord {
  need(!!id, "plan id is required"); need(plan.total_cents > 0n, "a plan needs a positive total");
  const elected = plan.basis === "election" ? election : null;
  return { ...plan, id, loan_id: loanId, analysis_id: analysisId, remaining_cents: plan.total_cents - plan.collected_cents, election_id: elected?.election_id ?? null, election_evidence_document_id: elected?.evidence_document_id ?? null, interest_bearing: false, base_payment_cents: base, step_down_on: addMonths(plan.end_due_date, 1) };
}
export function loanTermsVersion(plan: RepaymentPlanRecord, otherActive: readonly RepaymentPlanRecord[]): LoanTermsVersion {
  const sum = (ps: readonly RepaymentPlanRecord[], kind: Plan["kind"]): Cents => ps.filter((x) => x.kind === kind).reduce((a, x) => a + x.installment_cents, 0n);
  const all = [...otherActive, plan];
  const others = sum(otherActive, "shortage") + sum(otherActive, "deficiency");
  return { escrow_payment_cents: plan.base_payment_cents + sum(all, "shortage") + sum(all, "deficiency"), escrow_payment_effective_from: plan.start_due_date, escrow_step_down_on: plan.step_down_on, escrow_step_down_to_cents: plan.base_payment_cents + others, shortage_installment_cents: sum(all, "shortage"), deficiency_installment_cents: sum(all, "deficiency"), plan_id: plan.id };
}
/** Appends `escrow.repayment_plan.superseded` for each prior plan (T9: the new gap already nets what was collected — nothing is added back) and `escrow.repayment_plan.created` + `loan_terms.versioned`. */
export function recordPlanCreated(events: EventStore, i: { plan: RepaymentPlanRecord; supersedes: readonly RepaymentPlanRecord[]; terms: LoanTermsVersion; terms_version: number; gates: readonly string[]; actor: Actor }): DomainEvent {
  for (const old of i.supersedes) {
    old.status = "superseded";
    events.append({ type: PLAN_SUPERSEDED, loanId: i.plan.loan_id, actor: i.actor, payload: { plan_id: old.id, superseded_by: i.plan.id, collected_cents: String(old.collected_cents), remaining_not_carried_cents: String(old.total_cents - old.collected_cents) } });
  }
  const pl = i.plan;
  const created = events.append({ type: PLAN_CREATED, loanId: pl.loan_id, actor: i.actor, payload: { plan_id: pl.id, analysis_id: pl.analysis_id, kind: pl.kind, basis: pl.basis, months: pl.months, total_cents: String(pl.total_cents), installment_cents: String(pl.installment_cents), final_installment_cents: String(pl.final_installment_cents), start_due_date: pl.start_due_date, end_due_date: pl.end_due_date, step_down_on: pl.step_down_on, election_id: pl.election_id, election_evidence_document_id: pl.election_evidence_document_id, interest_rate_pct: pl.interest_rate_pct, status: pl.status, gates: [...i.gates] } });
  events.append({ type: LOAN_TERMS_VERSIONED, loanId: pl.loan_id, actor: i.actor, payload: { version: i.terms_version, reason: "escrow_repayment_plan", plan_id: pl.id, escrow_payment_cents: String(i.terms.escrow_payment_cents), effective_from: i.terms.escrow_payment_effective_from, step_down_on: i.terms.escrow_step_down_on, step_down_to_cents: String(i.terms.escrow_step_down_to_cents) } });
  return created;
}

// ============================================================ lump sums (rule 4; T6)
export interface LumpSumInput { readonly plan: RepaymentPlanRecord; readonly amount_cents: Cents; readonly received_on: PlainDate; readonly custodial_account_id?: string; readonly actor: Actor; readonly now: string; }
export interface LumpSumResult { readonly plan_id: string; readonly paid: boolean; readonly status: Plan["status"]; readonly remaining_cents: Cents; readonly interim_analysis_by: PlainDate; readonly entry_set_id: string; readonly event: DomainEvent; }
/** Rule 4: post the receipt to loan `escrow` (Dr custodial T&I cash / Cr loan escrow), mark `paid_lump` when it covers the remaining balance, and append the fact that starts the 10-BD interim-analysis clock. */
export function receiveLumpSum(events: EventStore, ledger: Ledger, i: LumpSumInput): LumpSumResult {
  need(i.amount_cents > 0n, "amount_cents must be positive");
  need(i.plan.status === "active", `plan ${i.plan.id} is ${i.plan.status}; only an active plan takes a lump sum`);
  const before = i.plan.total_cents - i.plan.collected_cents;
  const ti = { scope: "custodial" as const, custodialAccountId: i.custodial_account_id ?? "TI-1014", account: "custodial_ti_cash" as const };
  const lines: LineInput[] = [{ account: ti, amountCents: i.amount_cents, ruleRef: "3.6 rule 4: Dr custodial_ti_cash (unsolicited lump sum)" }, { account: { scope: "loan" as const, loanId: i.plan.loan_id, account: "escrow" as const }, amountCents: -i.amount_cents, ruleRef: "3.6 rule 4: Cr loan escrow (lump-sum receipt)" }];
  const set = ledger.post({ effectiveDate: i.received_on, description: `escrow lump sum ${i.plan.loan_id} plan ${i.plan.id}`, lines }, i.now);
  const out = lumpSum(i.plan, i.amount_cents, i.received_on);
  if (!out.paid) i.plan.collected_cents += i.amount_cents;
  i.plan.remaining_cents = i.plan.total_cents - i.plan.collected_cents;
  const event = events.append({ type: LUMP_SUM_RECEIVED, loanId: i.plan.loan_id, actor: i.actor, payload: { plan_id: i.plan.id, amount_cents: String(i.amount_cents), received_on: i.received_on, paid: out.paid, remaining_before_cents: String(before), remaining_cents: String(i.plan.remaining_cents), interim_analysis_by: out.interim_analysis_by, entry_set_id: set.id } });
  if (out.paid) events.append({ type: PLAN_PAID_LUMP, loanId: i.plan.loan_id, actor: i.actor, payload: { plan_id: i.plan.id, received_on: i.received_on, amount_cents: String(i.amount_cents), interim_analysis_by: out.interim_analysis_by } });
  return { plan_id: i.plan.id, paid: out.paid, status: i.plan.status, remaining_cents: i.plan.remaining_cents, interim_analysis_by: out.interim_analysis_by, entry_set_id: set.id, event };
}
