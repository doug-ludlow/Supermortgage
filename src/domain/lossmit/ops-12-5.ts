/**
 * §12.5 repayment-plan operating rules that append the plan's own events — the code paths the 12.5 timer rows arm
 * and close on (spec/sections/12-loss-mitigation/12-5-repayment-plan.md, "Timers and gates"):
 *
 *  - `termCreate`         → `workout_plan.term.create{plan_kind=repayment, forbearance_component, …facts}` on plan
 *                           create / extend / modify — the trigger of the four not_before gates
 *                           (`FNMA_D23202_REPAY_PAYMENT_CAP_150`, `_TERM_MAX_12`, `_BRP_REQUIRED`, `FNMA_D23201_FORB_COMBINED_36M`);
 *                           the payload carries every fact those evaluators read (src/app/evaluators.ts "12.5.*").
 *  - `buildSchedule`      → the `workout_plan_schedule` rows (rule 2: ceil-to-cent installment, residual in the last row).
 *  - `rowDue`             → `workout_plan_schedule.row_due{due_date, expected_total_cents}` on the row's due date — arms
 *                           `FNMA_D23202_REPAY_PAYMENT_EOM` (last day of that month, 23:59 servicer-local).
 *  - `recordPlanPayment`  → `workout_plan.payment.received{covers_expected_total}` (rule 8: oldest row first; a partial
 *                           receipt sits in suspense until a full expected_total accumulates) — satisfies the EOM row.
 *  - `monthEndSweep`      → `period.month_end{workout_plan_active=true, plan_kind=repayment, month_end}` for a loan with an
 *                           active plan (arms `FNMA_F121_STATUS_12_BD2`) and `workout_plan.payment.missed` when the month's
 *                           row is short (the EOM row's breach action).
 *  - `reportStatus12` / `claimIncentive` → the outbound F-1-21 status-12 submission and the F-2-02 $500 claim.
 *  - `ingestInvestorAck`  → the inbound Fannie Mae acknowledgement (5.x feedback) validated and appended as
 *                           `investor.event.accepted{status_code=12}` / `{kind=incentive, workout=repayment_plan}` —
 *                           what satisfies `FNMA_F121_STATUS_12_BD2` and `FNMA_F202_REPAY_INCENTIVE_CLAIM`.
 *
 * Money is bigint cents; dates are PlainDate. The store is the append-only entity store (structural interface so this
 * file depends on the kernel only); `repaymentPlanOps` is the `op` dispatcher the 12.5 `workout_plan.*` tool calls.
 */
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { type PlainDate, plainDate, addMonths, endOfMonth, parts, ymd, startOfMonth } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { repaymentTerms, COMBINED_MAX } from "./plans.ts";
import { repaymentReporting } from "./ops.ts";

export interface PlanRecord { readonly id: string; readonly data: Record<string, unknown> }
export interface PlanStore {
  get(kind: string, id: string): PlanRecord | undefined;
  require(kind: string, id: string): PlanRecord;
  list(kind: string, where?: (d: Record<string, unknown>) => boolean): readonly PlanRecord[];
  put(kind: string, id: string, data: Record<string, unknown>, by: Actor, now: string): PlanRecord;
}
export interface RepaymentEnv { readonly events: EventStore; readonly store: PlanStore; readonly actor: Actor; readonly now: string }

const need = (ok: unknown, msg: string): void => { if (!ok) throw new RangeError(msg); };
const cents = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const num = (v: unknown): number => (v === undefined || v === null || v === "" ? 0 : Number(v));
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
export const INCENTIVE_CENTS: Cents = 50_000n;   // F-2-02 repayment-plan incentive
export const STATUS_CODE_12 = "12";              // F-1-21 Repayment Plan

// ---- gates ---------------------------------------------------------------------------------------------------
/** D2-3.2-01: a repayment plan combined with a forbearance component must not exceed 36 months in total. */
export function combinedTermGate(i: { term_months: number; forbearance_months: number }): { allowed: boolean; combined_months: number; forbearance_component: boolean; refusal: string | null } {
  const combined = i.term_months + i.forbearance_months;
  const allowed = combined <= COMBINED_MAX;
  return { allowed, combined_months: combined, forbearance_component: i.forbearance_months > 0, refusal: allowed ? null : `plan refused: ${i.forbearance_months} forbearance + ${i.term_months} repayment months = ${combined} exceeds the 36-month combined cap (FNMA_D23201_FORB_COMBINED_36M)` };
}

export interface TermCreateInput {
  readonly loan_id: string; readonly plan_id: string; readonly op: "create" | "extend" | "modify";
  readonly term_months: number; readonly arrears_cents: Cents; readonly contractual_cents: Cents;
  readonly fnma_days_delinquent: number; readonly brp_complete: boolean; readonly fnma_approval_id: string | null; readonly forbearance_months: number;
}
/**
 * "plan create/modify/extend" — appends `workout_plan.term.create` with the facts the four not_before gates evaluate
 * (`combined_months`, `fnma_days_delinquent`, `term_months`, `brp_complete`, `expected_total_cents`, `contractual_cents`,
 * `fnma_approval_id`). Returns the computed terms and the refusals the caller must raise (the cap and BRP/term gates are
 * asserted by the calculator and ops.ts; the combined 36-month cap here).
 */
export function termCreate(env: RepaymentEnv, i: TermCreateInput): { event: DomainEvent; terms: ReturnType<typeof repaymentTerms>; combined: ReturnType<typeof combinedTermGate>; refusals: string[] } {
  need(i.loan_id, "loan_id is required"); need(i.term_months >= 1, "term_months must be ≥ 1"); need(i.contractual_cents > 0n, "contractual_cents must be > 0"); need(i.arrears_cents > 0n, "arrears_cents must be > 0");
  const terms = repaymentTerms(i.arrears_cents, i.contractual_cents, i.term_months);
  const combined = combinedTermGate({ term_months: i.term_months, forbearance_months: i.forbearance_months });
  const event = env.events.append({ type: "workout_plan.term.create", loanId: i.loan_id, actor: env.actor, payload: {
    plan_id: i.plan_id, op: i.op, plan_kind: "repayment", term_months: i.term_months, installment_cents: terms.installment_cents, expected_total_cents: terms.total_monthly_cents, contractual_cents: i.contractual_cents,
    pct_of_contractual: terms.pct_of_contractual, fnma_days_delinquent: i.fnma_days_delinquent, brp_complete: i.brp_complete, fnma_approval_id: i.fnma_approval_id,
    forbearance_component: combined.forbearance_component, forbearance_months: i.forbearance_months, combined_months: combined.combined_months } });
  const refusals: string[] = [];
  if (!combined.allowed) refusals.push(combined.refusal!);
  return { event, terms, combined, refusals };
}

// ---- schedule --------------------------------------------------------------------------------------------------
export interface ScheduleRow { readonly plan_id: string; readonly loan_id: string; readonly row: number; readonly due_date: PlainDate; readonly month_end: PlainDate; readonly contractual_cents: Cents; readonly installment_cents: Cents; readonly expected_total_cents: Cents; readonly received_cents: Cents; readonly status: "scheduled" | "due" | "paid" | "missed"; readonly estimate_flags: readonly string[] }
const rowId = (planId: string, row: number): string => `${planId}-${String(row).padStart(2, "0")}`;
const asRow = (d: Record<string, unknown>): ScheduleRow => ({ plan_id: str(d.plan_id), loan_id: str(d.loan_id), row: num(d.row), due_date: plainDate(str(d.due_date)), month_end: plainDate(str(d.month_end)), contractual_cents: cents(d.contractual_cents), installment_cents: cents(d.installment_cents), expected_total_cents: cents(d.expected_total_cents), received_cents: cents(d.received_cents), status: str(d.status) as ScheduleRow["status"], estimate_flags: Array.isArray(d.estimate_flags) ? (d.estimate_flags as string[]) : [] });
/** Rule 2: installment = ceil-to-cent(arrears ÷ months); the last row absorbs the rounding so the rows sum exactly to the arrears. */
export function buildSchedule(env: RepaymentEnv, i: { loan_id: string; plan_id: string; start_on: PlainDate; months: number; contractual_cents: Cents; arrears_cents: Cents; estimate_flags?: readonly string[] }): { rows: ScheduleRow[]; cure_date: PlainDate; sum_cents: Cents } {
  need(i.months >= 1, "months must be ≥ 1"); need(i.arrears_cents > 0n, "arrears_cents must be > 0");
  const terms = repaymentTerms(i.arrears_cents, i.contractual_cents, i.months);
  const first = startOfMonth(i.start_on); const rows: ScheduleRow[] = [];
  for (let k = 0; k < i.months; k++) {
    const due = addMonths(first, k); const inst = k === i.months - 1 ? terms.final_installment_cents : terms.installment_cents;
    const row: ScheduleRow = { plan_id: i.plan_id, loan_id: i.loan_id, row: k + 1, due_date: due, month_end: endOfMonth(due), contractual_cents: i.contractual_cents, installment_cents: inst, expected_total_cents: i.contractual_cents + inst, received_cents: 0n, status: "scheduled", estimate_flags: [...(i.estimate_flags ?? [])] };
    env.store.put("workout_plan_schedule", rowId(i.plan_id, row.row), { ...row }, env.actor, env.now); rows.push(row);
  }
  const sum = rows.reduce((a, r) => a + r.installment_cents, 0n);
  need(sum === i.arrears_cents, `schedule installments ${sum} must sum to the arrears ${i.arrears_cents}`);
  return { rows, cure_date: rows[rows.length - 1]!.month_end, sum_cents: sum };
}
export const scheduleRows = (env: RepaymentEnv, planId: string): ScheduleRow[] => env.store.list("workout_plan_schedule", (d) => d.plan_id === planId).map((r) => asRow(r.data)).sort((a, b) => a.row - b.row);

/** "schedule row → due date": on the row's due date, `workout_plan_schedule.row_due` arms the month-end payment clock for that row alone. */
export function rowDue(env: RepaymentEnv, i: { loan_id: string; plan_id: string; due_date: PlainDate }): { row: ScheduleRow; event: DomainEvent } {
  const row = scheduleRows(env, i.plan_id).find((r) => r.due_date === i.due_date);
  need(row, `no schedule row of ${i.plan_id} is due ${i.due_date}`); need(row!.status === "scheduled", `row ${row!.row} of ${i.plan_id} is already ${row!.status}`);
  const due = { ...row!, status: "due" as const }; env.store.put("workout_plan_schedule", rowId(i.plan_id, due.row), { ...due }, env.actor, env.now);
  const event = env.events.append({ type: "workout_plan_schedule.row_due", loanId: i.loan_id, actor: env.actor, payload: { plan_id: i.plan_id, plan_kind: "repayment", row: due.row, due_date: due.due_date, month_end: due.month_end, contractual_cents: due.contractual_cents, installment_cents: due.installment_cents, expected_total_cents: due.expected_total_cents } });
  return { row: due, event };
}

/** Rule 8: a plan payment posts to the oldest unpaid row; partials sit in suspense until a full expected_total accumulates. `covers_expected_total=true` satisfies `FNMA_D23202_REPAY_PAYMENT_EOM`. */
export function recordPlanPayment(env: RepaymentEnv, i: { loan_id: string; plan_id: string; received_cents: Cents; received_on: PlainDate }): { row: ScheduleRow; covers_expected_total: boolean; suspense_cents: Cents; event: DomainEvent } {
  need(i.received_cents > 0n, "received_cents must be > 0");
  const row = scheduleRows(env, i.plan_id).find((r) => r.status === "due" || r.status === "scheduled" || r.status === "missed");
  need(row, `no unpaid schedule row on ${i.plan_id}`);
  const cumulative = row!.received_cents + i.received_cents; const covers = cumulative >= row!.expected_total_cents;
  const next: ScheduleRow = { ...row!, received_cents: cumulative, status: covers ? "paid" : row!.status };
  env.store.put("workout_plan_schedule", rowId(i.plan_id, next.row), { ...next, paid_on: covers ? i.received_on : null }, env.actor, env.now);
  const event = env.events.append({ type: "workout_plan.payment.received", loanId: i.loan_id, actor: env.actor, payload: { plan_id: i.plan_id, plan_kind: "repayment", row: next.row, due_date: next.due_date, received_on: i.received_on, received_cents: i.received_cents, cumulative_received_cents: cumulative, expected_total_cents: next.expected_total_cents, covers_expected_total: covers, suspense_cents: covers ? 0n : cumulative } });
  return { row: next, covers_expected_total: covers, suspense_cents: covers ? 0n : cumulative, event };
}

// ---- month end -------------------------------------------------------------------------------------------------
/**
 * The month-end job for a loan with an active repayment plan: `period.month_end{workout_plan_active=true, plan_kind=repayment,
 * month_end}` (arms the F-1-21 status-12 BD2 row) and, when the month's row is short, `workout_plan.payment.missed`.
 */
export function monthEndSweep(env: RepaymentEnv, i: { loan_id: string; plan_id: string; month_end: PlainDate }): { period_event: DomainEvent; missed_event: DomainEvent | null; report_by: PlainDate; shortfall_cents: Cents } {
  need(i.month_end === endOfMonth(i.month_end), `${i.month_end} is not a month end`);
  const plan = env.store.require("workout_plans", i.plan_id);
  need(plan.data.kind === "repayment_plan", `${i.plan_id} is not a repayment plan`); need(plan.data.status === "active", `${i.plan_id} is ${String(plan.data.status)}, not active`);
  const { y, m } = parts(i.month_end); const period = `${y}-${String(m).padStart(2, "0")}`;
  const reportBy = addBusinessDays(i.month_end, 2, fannieEt);
  const period_event = env.events.append({ type: "period.month_end", loanId: i.loan_id, actor: env.actor, payload: { plan_id: i.plan_id, plan_kind: "repayment", workout_plan_active: true, month_end: i.month_end, period, status_code: STATUS_CODE_12, effective_date: str(plan.data.term_start) || null, report_by: reportBy } });
  const row = scheduleRows(env, i.plan_id).find((r) => r.month_end === i.month_end);
  let missed_event: DomainEvent | null = null; let shortfall = 0n;
  if (row && row.status !== "paid") {
    shortfall = row.expected_total_cents - row.received_cents;
    env.store.put("workout_plan_schedule", rowId(i.plan_id, row.row), { ...row, status: "missed" }, env.actor, env.now);
    missed_event = env.events.append({ type: "workout_plan.payment.missed", loanId: i.loan_id, actor: env.actor, payload: { plan_id: i.plan_id, plan_kind: "repayment", row: row.row, due_date: row.due_date, month_end: i.month_end, expected_total_cents: row.expected_total_cents, received_cents: row.received_cents, shortfall_cents: shortfall } });
  }
  return { period_event, missed_event, report_by: reportBy, shortfall_cents: shortfall };
}

// ---- F-1-21 status 12 and the F-2-02 incentive ---------------------------------------------------------------------
/** Outbound status-12 submission for the reporting month (effective date = plan start; completion date in the completion month). */
export function reportStatus12(env: RepaymentEnv, i: { loan_id: string; plan_id: string; reporting_month: PlainDate }): { submission_id: string; effective_date: PlainDate; completion_date: PlainDate | null; report_by: PlainDate; event: DomainEvent } {
  const plan = env.store.require("workout_plans", i.plan_id); need(plan.data.kind === "repayment_plan", `${i.plan_id} is not a repayment plan`);
  const start = plainDate(str(plan.data.term_start)); const completed = plan.data.status === "completed" && isDate(str(plan.data.ended_on)) ? plainDate(str(plan.data.ended_on)) : null;
  const rep = repaymentReporting({ start_on: start, completed_on: completed, start_days_delinquent: num(plan.data.start_days_delinquent) });
  const { y, m } = parts(i.reporting_month); const month = ymd(y, m, 1);
  const completionDate = completed && rep.completion_report_month === month ? completed : null;
  const submission_id = `st12-${i.plan_id}-${y}${String(m).padStart(2, "0")}`;
  env.store.put("investor_events", submission_id, { loan_id: i.loan_id, plan_id: i.plan_id, kind: "status_code", status_code: STATUS_CODE_12, effective_date: rep.effective_date, completion_date: completionDate, reporting_month: month, status: "submitted", submitted_on: env.now.slice(0, 10) }, env.actor, env.now);
  const event = env.events.append({ type: "investor.status_code.reported", loanId: i.loan_id, actor: env.actor, payload: { submission_id, plan_id: i.plan_id, status_code: STATUS_CODE_12, effective_date: rep.effective_date, completion_date: completionDate, reporting_month: month } });
  return { submission_id, effective_date: rep.effective_date, completion_date: completionDate, report_by: rep.report_by, event };
}

/** F-2-02: $500 when the loan was ≥60 days delinquent at start and completed; claimed in the following month's cycle. */
export function claimIncentive(env: RepaymentEnv, i: { loan_id: string; plan_id: string }): { submission_id: string; amount_cents: Cents; claim_cycle: PlainDate; event: DomainEvent } {
  const plan = env.store.require("workout_plans", i.plan_id); need(plan.data.kind === "repayment_plan", `${i.plan_id} is not a repayment plan`);
  need(plan.data.status === "completed" && isDate(str(plan.data.ended_on)), `${i.plan_id} has not completed`);
  const rep = repaymentReporting({ start_on: plainDate(str(plan.data.term_start)), completed_on: plainDate(str(plan.data.ended_on)), start_days_delinquent: num(plan.data.start_days_delinquent) });
  need(rep.incentive_cents > 0n, `${i.plan_id} was ${num(plan.data.start_days_delinquent)} days delinquent at start; the F-2-02 incentive needs ≥60`);
  const submission_id = `inc-${i.plan_id}`;
  env.store.put("investor_events", submission_id, { loan_id: i.loan_id, plan_id: i.plan_id, kind: "incentive", workout: "repayment_plan", amount_cents: rep.incentive_cents, claim_cycle: rep.incentive_claim_cycle, status: "submitted", submitted_on: env.now.slice(0, 10) }, env.actor, env.now);
  const event = env.events.append({ type: "investor.incentive.claimed", loanId: i.loan_id, actor: env.actor, payload: { submission_id, plan_id: i.plan_id, kind: "incentive", workout: "repayment_plan", amount_cents: rep.incentive_cents, claim_cycle: rep.incentive_claim_cycle } });
  return { submission_id, amount_cents: rep.incentive_cents, claim_cycle: rep.incentive_claim_cycle!, event };
}

/** An inbound Fannie Mae acknowledgement (5.x feedback) for a 12.5 submission: status-12 report or the incentive claim. */
export interface InvestorAck { readonly loan_id: string; readonly submission_id: string; readonly status: "accepted" | "accepted_with_warnings" | "rejected"; readonly kind: "status_code" | "incentive"; readonly status_code?: string; readonly workout?: string; readonly amount_cents?: Cents; readonly accepted_at?: string; readonly source?: string; readonly reason?: string }
/** Validates the record against the submission on file and appends `investor.event.accepted{status_code=12}` / `{kind=incentive, workout=repayment_plan}` (or `investor.event.rejected`). */
export function ingestInvestorAck(env: RepaymentEnv, a: InvestorAck): DomainEvent {
  need(a.loan_id, "loan_id is required"); need(a.submission_id, "submission_id is required");
  need(a.status === "accepted" || a.status === "accepted_with_warnings" || a.status === "rejected", `status ${String(a.status)} is not accepted / accepted_with_warnings / rejected`);
  need(a.kind === "status_code" || a.kind === "incentive", `kind ${String(a.kind)} is not status_code / incentive`);
  const sub = env.store.get("investor_events", a.submission_id); need(sub, `no submission ${a.submission_id} on file`); need(sub!.data.loan_id === a.loan_id, `submission ${a.submission_id} belongs to another loan`);
  const statusCode = a.kind === "status_code" ? str(a.status_code ?? sub!.data.status_code) : null; const workout = a.kind === "incentive" ? str(a.workout ?? sub!.data.workout) : null;
  if (a.kind === "status_code") need(statusCode === STATUS_CODE_12, `status_code ${statusCode} is not the repayment-plan code 12 (F-1-21)`);
  if (a.kind === "incentive") { need(workout === "repayment_plan", `workout ${workout} is not repayment_plan`); need(cents(a.amount_cents ?? sub!.data.amount_cents) === INCENTIVE_CENTS, `incentive amount must be ${INCENTIVE_CENTS} (F-2-02)`); }
  const acceptedAt = a.accepted_at ?? env.now; const accepted = a.status !== "rejected";
  env.store.put("investor_events", a.submission_id, { status: a.status, acknowledged_at: acceptedAt, ...(a.reason ? { reason: a.reason } : {}) }, env.actor, env.now);
  return env.events.append({ type: accepted ? "investor.event.accepted" : "investor.event.rejected", loanId: a.loan_id, actor: env.actor, payload: {
    submission_id: a.submission_id, plan_id: str(sub!.data.plan_id), kind: a.kind, status_code: statusCode, workout, amount_cents: a.kind === "incentive" ? INCENTIVE_CENTS : null, status: a.status, source: a.source ?? "fnma_feedback", accepted_at: accepted ? acceptedAt : null, reason: a.reason ?? null } });
}

// ---- dispatcher ------------------------------------------------------------------------------------------------
/** The 12.5 `workout_plan.*` ops beyond the shared lifecycle: schedule, row_due, payment, month_end. Returns undefined for any other op. */
export function repaymentPlanOps(env: RepaymentEnv, i: Record<string, unknown>): unknown {
  const loanId = str(i.loan_id); const planId = str(i.id);
  switch (i.op) {
    case "schedule": { need(planId, "id is required"); const plan = env.store.require("workout_plans", planId); return buildSchedule(env, { loan_id: loanId, plan_id: planId, start_on: plainDate(str(i.start_on || plan.data.term_start)), months: num(i.months || plan.data.months), contractual_cents: cents(i.contractual_cents ?? plan.data.contractual_cents), arrears_cents: cents(i.arrears_cents ?? plan.data.arrears_cents), ...(Array.isArray(i.estimate_flags) ? { estimate_flags: i.estimate_flags as string[] } : {}) }); }
    case "row_due": { need(planId && isDate(str(i.due_date)), "id and due_date are required"); return rowDue(env, { loan_id: loanId, plan_id: planId, due_date: plainDate(str(i.due_date)) }); }
    case "payment": { need(planId && isDate(str(i.received_on)), "id and received_on are required"); return recordPlanPayment(env, { loan_id: loanId, plan_id: planId, received_cents: cents(i.received_cents), received_on: plainDate(str(i.received_on)) }); }
    case "month_end": { need(planId && isDate(str(i.month_end)), "id and month_end are required"); return monthEndSweep(env, { loan_id: loanId, plan_id: planId, month_end: plainDate(str(i.month_end)) }); }
    default: return undefined;
  }
}
/** The 12.5 `fnma.status_code.report` ops: op=report (status 12), op=incentive_claim, op=ack (inbound acknowledgement). Returns undefined for any other op. */
export function statusReportOps(env: RepaymentEnv, i: Record<string, unknown>): unknown {
  const loanId = str(i.loan_id); const planId = str(i.plan_id ?? i.id);
  switch (i.op) {
    case "report": { need(loanId && planId && isDate(str(i.reporting_month)), "loan_id, plan_id and reporting_month are required"); return reportStatus12(env, { loan_id: loanId, plan_id: planId, reporting_month: plainDate(str(i.reporting_month)) }); }
    case "incentive_claim": { need(loanId && planId, "loan_id and plan_id are required"); return claimIncentive(env, { loan_id: loanId, plan_id: planId }); }
    case "ack": return ingestInvestorAck(env, { loan_id: loanId, submission_id: str(i.submission_id), status: str(i.status) as InvestorAck["status"], kind: str(i.kind) as InvestorAck["kind"], ...(i.status_code !== undefined ? { status_code: str(i.status_code) } : {}), ...(i.workout !== undefined ? { workout: str(i.workout) } : {}), ...(i.amount_cents !== undefined ? { amount_cents: cents(i.amount_cents) } : {}), ...(typeof i.accepted_at === "string" ? { accepted_at: i.accepted_at } : {}), ...(typeof i.source === "string" ? { source: i.source } : {}), ...(typeof i.reason === "string" ? { reason: i.reason } : {}) });
    default: return undefined;
  }
}
