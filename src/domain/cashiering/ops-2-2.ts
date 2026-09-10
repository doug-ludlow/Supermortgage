/**
 * §2.2 process-owned operations over ./partials.ts (the four-condition matrix) and ./allocation.ts (the $50 rule):
 *  - the `partial_payment_evaluations` row (spec "Data model": payment_id, shortfall_cents, rule_path ∈ partial_rule_path,
 *    the four condition booleans, evidence_refs[], decision_id, decided_at) and its decision record (spec "AI agent design":
 *    `{payment_id, shortfall_cents, rule_path, conditions{…}, evidence_refs[], policy_override_reason?, credited_as_of_if_applied,
 *    confidence, rationale}`) — both appended as events, never edited;
 *  - the `statement_suspense_summary` read model 7.1 renders as the §1026.41(d)(3) amount and the (d)(5) "what must be done
 *    for the funds to be applied" text (spec "Integrations — Statements"; REGZ_1026_41D5_STATEMENT_SUSPENSE_DISCLOSURE facts).
 * Money stays bigint cents; dates are PlainDate.
 */
import { randomUUID } from "node:crypto";
import type { EventStore, Actor } from "../../kernel/events/index.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { type Cents, formatCents } from "../../kernel/money/cents.ts";
import type { AllocationPlan } from "./allocation.ts";
import { partialConditions, type PartialContext, type PartialDecision, type SuspenseItem } from "./partials.ts";

export const RULE_SET_2_2 = "2.2@rules.v1";
const CASHIERING_AGENT: Actor = { kind: "agent", id: "cashiering" };
export interface Deps22 { readonly events: EventStore; readonly clock: { now(): string }; readonly actor?: Actor; }

/** `partial_rule_path` (db/migrations/0003_cashiering.sql). */
export type PartialRulePath = "fifty_rule_escrow" | "hold_four_conditions" | "hold_policy_override" | "return" | "apply_forbearance_plan" | "apply_trial";

export interface PartialEvaluation {
  readonly id: string; readonly payment_id: string; readonly loan_id: string;
  readonly shortfall_cents: Cents; readonly rule_path: PartialRulePath;
  /** null = not evaluated: the $50 rule is deterministic and runs first (rule 2); a pending commitment is unknown until captured. */
  readonly condition_commitment: boolean | null; readonly condition_not_habitual: boolean | null;
  readonly condition_no_nsf_history: boolean | null; readonly condition_30day_commitment: boolean | null;
  readonly evidence_refs: readonly string[]; readonly decision_id: string; readonly decided_at: string;
  readonly cite: string; readonly policy_override_reason: string | null; readonly credited_as_of_if_applied: PlainDate | null;
  /** The `suspense_items{partial_payment_50_rule}` counter row an applied $50-rule payment records (never a held item). */
  readonly counter_suspense_item_id?: string;
}

const money = (c: Cents): string => formatCents(c, { symbol: true, grouping: true });
const str = (c: Cents): string => c.toString();

/**
 * Rule 1: s = P − (a + U). `ctx.state` is the loan's state as the item was opened from it (after the receipt posted), so Σ open
 * unapplied already includes this receipt; a pre-receipt state (U = 0) counts the receipt itself.
 */
export function shortfallFor(ctx: PartialContext): Cents {
  const inst = ctx.state.installments.filter((i) => i.status === "due").sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  if (!inst) throw new RangeError(`no due installment on ${ctx.state.loan_id}`);
  const P = inst.pi_cents + inst.escrow_cents;
  const held = ctx.state.suspense_unapplied_cents > ctx.amount_cents ? ctx.state.suspense_unapplied_cents : ctx.amount_cents;
  return P > held ? P - held : 0n;
}

/** The decision kind → the row's enum. A `foreclosure_hold` records the Guide's default ("authorized to return") pending the case owner. */
const RULE_PATH: Record<PartialDecision["kind"], PartialRulePath> = { hold: "hold_four_conditions", contact_pending: "hold_four_conditions", hold_policy_override: "hold_policy_override", foreclosure_hold: "return" };

function appendEvaluation(deps: Deps22, ev: PartialEvaluation, rationale: string, ruleRef: string): void {
  const actor = deps.actor ?? CASHIERING_AGENT;
  deps.events.append({ type: "agent.decision", loanId: ev.loan_id, aggregate: { kind: "payment", id: ev.payment_id }, actor,
    payload: { decision_id: ev.decision_id, agent: "cashiering", action: "partial_payment.evaluated", rule_set_version: RULE_SET_2_2, rule_code: ruleRef, rule_path: ev.rule_path, cite: ev.cite, rationale,
      payment_id: ev.payment_id, shortfall_cents: str(ev.shortfall_cents),
      conditions: { commitment: ev.condition_commitment, not_habitual: ev.condition_not_habitual, no_nsf_history: ev.condition_no_nsf_history, thirty_day_commitment: ev.condition_30day_commitment },
      evidence_refs: [...ev.evidence_refs], policy_override_reason: ev.policy_override_reason, credited_as_of_if_applied: ev.credited_as_of_if_applied, confidence: 1 } });
  deps.events.append({ type: "partial_payment_evaluations.created", loanId: ev.loan_id, aggregate: { kind: "partial_payment_evaluation", id: ev.id }, actor,
    payload: { evaluation_id: ev.id, payment_id: ev.payment_id, loan_id: ev.loan_id, shortfall_cents: str(ev.shortfall_cents), rule_path: ev.rule_path,
      condition_commitment: ev.condition_commitment, condition_not_habitual: ev.condition_not_habitual, condition_no_nsf_history: ev.condition_no_nsf_history, condition_30day_commitment: ev.condition_30day_commitment,
      evidence_refs: [...ev.evidence_refs], decision_id: ev.decision_id, decided_at: ev.decided_at } });
}

/** Rule 3: the four-condition evaluation behind a `decidePartial` outcome, as the append-only row plus the agent's decision record. */
export function recordPartialEvaluation(deps: Deps22, ctx: PartialContext, d: PartialDecision, opts: { readonly evidence_refs?: readonly string[] } = {}): PartialEvaluation {
  const cond = partialConditions(ctx);
  const pending = d.kind === "contact_pending";
  const shortfall = shortfallFor(ctx);
  const override = d.kind === "hold_policy_override"
    ? `${ctx.days_delinquent} days delinquent (≤ 60) and no foreclosure referral: policy holds the funds 30 days rather than returning them (2.2 rule 3; decision 2.2-Q3)`
    : d.kind === "foreclosure_hold" ? "foreclosure position: the foreclosure case owner decides accept-and-apply vs return within 2 BD (2.2 rule 3)" : null;
  const ev: PartialEvaluation = { id: randomUUID(), payment_id: ctx.payment_id, loan_id: ctx.state.loan_id, shortfall_cents: shortfall, rule_path: RULE_PATH[d.kind],
    condition_commitment: pending ? null : cond.commitment, condition_not_habitual: cond.not_habitual, condition_no_nsf_history: cond.no_nsf_history, condition_30day_commitment: pending ? null : cond.thirty_day_commitment,
    evidence_refs: [...(opts.evidence_refs ?? [])], decision_id: randomUUID(), decided_at: deps.clock.now(), cite: d.cite, policy_override_reason: override, credited_as_of_if_applied: null };
  const rationale = `shortfall ${money(shortfall)}: ${d.rule_path}` + (override ? ` — ${override}` : pending ? " — commitment unknown; borrower-comms captures it within 2 BD (SM_PARTIAL_COMMITMENT_CAPTURE_2BD)" : "");
  appendEvaluation(deps, ev, rationale, d.rule_path);
  return ev;
}

/**
 * Rule 2 / example D: the `fifty_rule_escrow` row for an `applied_with_50_rule` allocation (no conditions evaluated — the rule is
 * deterministic and first), plus the `suspense_items` counter row the data model names — `reason_code = partial_payment_50_rule`
 * "(applied, not held — recorded for the 3-in-12 counter)": `suspense.item.created{reason_code=partial_payment_50_rule}` is what
 * FNMA_C1102_50_RULE_COUNT_12M (6.5's row, gated by 2.2.fiftyRuleCount) arms on. Called by CashieringService.post in the posting transaction.
 */
export function recordFiftyRuleEvaluation(deps: Deps22, payment: { readonly payment_id: string; readonly loan_id: string }, plan: AllocationPlan, creditedAsOf: PlainDate): PartialEvaluation {
  const inst = plan.installments[0];
  if (plan.outcome !== "applied_with_50_rule" || !inst || inst.fifty_rule_shortfall_cents === undefined) throw new RangeError("not an applied_with_50_rule allocation");
  const s = inst.fifty_rule_shortfall_cents;
  const ev: PartialEvaluation = { id: randomUUID(), payment_id: payment.payment_id, loan_id: payment.loan_id, shortfall_cents: s, rule_path: "fifty_rule_escrow",
    condition_commitment: null, condition_not_habitual: null, condition_no_nsf_history: null, condition_30day_commitment: null,
    evidence_refs: [], decision_id: randomUUID(), decided_at: deps.clock.now(),
    cite: "Servicing Guide C-1.1-02 ($50 rule: escrowed first lien, instrument dated March 1999 or later, deficient by $50 or less, at most three in a 12-month period)",
    policy_override_reason: null, credited_as_of_if_applied: creditedAsOf };
  appendEvaluation(deps, ev, `shortfall ${money(s)} ≤ $50.00: applied as a full periodic payment with the escrow bucket reduced by ${money(s)} (rule 2); the shortfall surfaces at the next escrow analysis (3.2)`, plan.rule_path.join(";"));
  const counterId = randomUUID();
  deps.events.append({ type: "suspense.item.created", loanId: payment.loan_id, aggregate: { kind: "suspense_item", id: counterId }, actor: deps.actor ?? CASHIERING_AGENT,
    payload: { suspense_item_id: counterId, payment_id: payment.payment_id, reason_code: "partial_payment_50_rule", partial_payment_50_rule: true, status: "applied", amount_cents: str(s), held_cents: "0",
      received_on: creditedAsOf, credited_as_of: creditedAsOf, installment_due_date: inst.due_date, partial_count_12m: plan.next.partial_count_12m, evaluation_id: ev.id, decision_id: ev.decision_id } });
  return { ...ev, counter_suspense_item_id: counterId };
}

// ───────────────────────── statement_suspense_summary (7.1 read model; §1026.41(d)(3)/(d)(5))
export interface StatementSuspenseItem { readonly suspense_item_id: string; readonly received_on: PlainDate; readonly amount_cents: Cents; readonly reason_code: string; }
export interface StatementSuspenseSummary {
  readonly loan_id: string; readonly period_end: PlainDate; readonly periodic_payment_cents: Cents;
  /** (d)(3): Σ open unapplied funds on the loan at period end. */
  readonly sum_unapplied_cents: Cents;
  /** What the borrower must still send for one periodic payment to apply (0 once Σ ≥ P — the accumulation rule applies it). */
  readonly balance_needed_cents: Cents;
  readonly items_since_last_statement: readonly StatementSuspenseItem[];
  /** (d)(5): "information explaining what must be done for the funds to be applied"; null when nothing is held. */
  readonly instruction_text: string | null;
}
export type OpenSuspenseItem = Pick<SuspenseItem, "id" | "amount_cents" | "received_on" | "reason_code" | "status">;

export function statementSuspenseSummary(f: { readonly loan_id: string; readonly periodic_payment_cents: Cents; readonly items: readonly OpenSuspenseItem[]; readonly since: PlainDate | null; readonly period_end: PlainDate }): StatementSuspenseSummary {
  if (f.periodic_payment_cents <= 0n) throw new RangeError("periodic_payment_cents must be positive");
  const open = f.items.filter((i) => (i.status === "open" || i.status === "contact_pending") && i.received_on <= f.period_end);
  const sum = open.reduce((s, i) => s + i.amount_cents, 0n);
  const needed = sum < f.periodic_payment_cents ? f.periodic_payment_cents - sum : 0n;
  const since = open.filter((i) => f.since === null || i.received_on > f.since).map((i) => ({ suspense_item_id: i.id, received_on: i.received_on, amount_cents: i.amount_cents, reason_code: i.reason_code }));
  const text = sum <= 0n ? null
    : needed > 0n ? `We received ${money(sum)}, which is being held. We need ${money(needed)} more to apply a full payment.`
    : `We received ${money(sum)}, which is being held and will be applied as a full payment.`;
  return { loan_id: f.loan_id, period_end: f.period_end, periodic_payment_cents: f.periodic_payment_cents, sum_unapplied_cents: sum, balance_needed_cents: needed, items_since_last_statement: since, instruction_text: text };
}

/** Facts for the `2.2.statementSuspenseDisclosure` gate (REGZ_1026_41D5_STATEMENT_SUSPENSE_DISCLOSURE) from the summary and 7.1's template checklist. */
export function statementDisclosureFacts(summary: StatementSuspenseSummary, checklist: { readonly results: readonly { readonly rule_id: string; readonly passed: boolean }[] }): { suspense_unapplied_cents: Cents; d3_amount_shown: boolean; d5_instructions_shown: boolean } {
  const passed = (id: string): boolean => checklist.results.some((r) => r.rule_id === id && r.passed);
  return { suspense_unapplied_cents: summary.sum_unapplied_cents, d3_amount_shown: passed("d3-past-payments") && passed("d3-ytd-suspense"), d5_instructions_shown: passed("d5-suspense") };
}
