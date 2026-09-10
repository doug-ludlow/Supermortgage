/**
 * §2.7 process-owned operations over ./ops.ts (CashieringOps) and ./latecharges.ts — the late-charge engine's
 * inbound hand-offs and the code paths that append the events its timer rows arm on and are satisfied by:
 *
 *   - `installmentDue` / `dailyRun` (inputs and triggers): `installment.due_date_reached{grace_end_on}` per installment on
 *     its due date — the trigger of `NOTE_6A_LATE_CHARGE_GRACE_GATE` (anchor: the grace end, Note ¶6(A) + decision 2) —
 *     and the 00:30 run for every installment whose grace end was the previous day (`late_charge.assessment.run` →
 *     `late_charge.assessment.decided`, closing `SM_LATE_CHARGE_ASSESS_1CD`). The run derives the credited-funds test
 *     from the loan state (rule 1, `receivedTowardBasis`) — nothing is hand-fed.
 *   - `forbearanceOpened` / `forbearanceDefaulted` (rule 3(ii), D2-3.2-01): the 12.x overlay hand-off —
 *     `case.forbearance.opened{plan_start}` arms `FNMA_D23201_FORBEARANCE_NO_ACCRUAL_GATE` (`mode=no_accrual`); on
 *     `case.forbearance.defaulted` accrual resumes from the default date (installments due on/after it are assessable).
 *   - `repaymentOpened` / `repaymentCompleted` (rule 3(v), D2-3.2-02): charges accrue suspended during the plan;
 *     `case.repayment.completed{completed_on}` arms `FNMA_D23202_REPAYMENT_WAIVE_ON_COMPLETION_0` and the same call
 *     waives every charge accrued during the plan the same day (`fee.waived{reason=workout_completion}`, its satisfier).
 *   - `scraPeriodStarted` (rule 3(iii), C-1.1-02 / 50 U.S.C. 3937): 13.9's period → `scra_reduced_rate` overlay; charges
 *     assessed on/after the service start are waived (`fee.waived{scra}`, the satisfier of
 *     `FNMA_C1102_MILITARY_INDULGENCE_LC_WAIVER_GATE`); pre-service charges are held `no_collection` (example O).
 *   - `bankruptcyFiled` (rule 3(iv)): charges accrue suspended `{bankruptcy_active}` with no collection and no statement
 *     billing; each one is exposed to 14.2 as `fee.incurred_postpetition{incurred_on}` (Rule 3002.1(c): the trigger of
 *     `BK_3002_1C_FEE_NOTICE_180`); `bkExposureList` is the 14.2 exposure list with incurred dates.
 *   - `collect` (rule 4): funds designated for fees (never P&I/escrow) → `fee.collected{late_charge}` (the trigger of
 *     `FNMA_A2304_LC_COLLECTED_REPORT_MONTHLY`); refused while a collection hold (SCRA) or a suspension is in force.
 *   - `redate` (rule 6 / T12): a payment re-dated on time reverses the charge (`fee.reversed`, refund if collected) and
 *     hands 8.1 a correction (`credit.correction.requested`) where the delinquency was reported.
 *   - `reportCollected` (rule 8): Σ `collected_cents` for the period → the 5.1 `fees.collected` figure on the LAR/event.
 *   - `reminderData` / `billableLateCharges` (rule 9): the statement (7.1) and D2-2-03 reminder (11.x) figures.
 *
 * Money is bigint cents; dates are PlainDate; nothing here edits a row — state changes are events and new versions.
 */
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { servicer, type Calendar } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { CashieringOps, CASHIERING_OPS_ACTOR, type OpsDeps } from "./ops.ts";
import { graceEndFor, lateFeeDisclosure, reverseOnRedate, collectedForPeriod, basisCents, type AssessmentInput, type AssessmentResult } from "./latecharges.ts";
import type { LoanCashState, Fee, Overlay, OverlayKind } from "./types.ts";

type Payload = Record<string, unknown>;
type Aggregate = { readonly kind: string; readonly id: string };
const str = (c: Cents): string => c.toString();
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const feeAgg = (id: string): Aggregate => ({ kind: "fee", id });

/** `late_charge_suppressions` row (data model): who suppressed what, from when, in which mode. */
export interface Suppression {
  readonly loan_id: string;
  readonly reason: OverlayKind;
  readonly source_case_id: string;
  readonly starts_on: PlainDate;
  readonly ends_on: PlainDate | null;
  readonly mode: "no_accrual" | "accrue_suspended" | "no_collection";
}
/** One row of the 14.2 exposure list (Rule 3002.1(c): post-petition charges with the dates they were incurred). */
export interface BkExposureRow { readonly fee_id: string; readonly incurred_on: PlainDate; readonly installment_due_date: PlainDate | null; readonly amount_cents: Cents; readonly case_id: string | null; }

export type CollectResult = { ok: true; fee: Fee; collected_cents: Cents } | { ok: false; code: "COLLECTION_HOLD" | "NOT_COLLECTIBLE" | "NOT_FROM_PI_ESCROW"; reason: string };

/** A workout plan hand-off from 12.x: the case and its dates, validated before the overlay is written. */
export interface PlanInput { readonly case_id: string; readonly plan_start: PlainDate; readonly plan_end?: PlainDate | null; }

export class LateChargeOps {
  readonly ops: CashieringOps;
  private readonly events: EventStore;
  private readonly clock: { now(): string };
  private readonly cal: Calendar;
  private readonly actor: Actor;

  constructor(deps: OpsDeps) {
    this.events = deps.events; this.clock = deps.clock; this.cal = deps.calendar ?? servicer; this.actor = deps.actor ?? CASHIERING_OPS_ACTOR;
    this.ops = new CashieringOps(deps);
  }
  private emit(type: string, loanId: string | undefined, payload: Payload, aggregate?: Aggregate): DomainEvent {
    return this.events.append({ type, ...(loanId ? { loanId } : {}), ...(aggregate ? { aggregate } : {}), actor: this.actor, payload });
  }
  private today(): PlainDate { return this.clock.now().slice(0, 10) as PlainDate; }

  // ───────────────────────── inputs and triggers
  /** An installment reaches its due date: `installment.due_date_reached{grace_end_on}` arms the note's grace gate (NOTE_6A_LATE_CHARGE_GRACE_GATE). */
  installmentDue(state: LoanCashState, due: PlainDate, on: PlainDate = this.today()): DomainEvent {
    const inst = state.installments.find((x) => x.due_date === due);
    if (!inst) throw new RangeError(`installmentDue: no installment ${due} on ${state.loan_id}`);
    if (on < due) throw new RangeError(`installmentDue: ${due} has not been reached on ${on}`);
    const grace_end_on = graceEndFor(state, due, this.cal);
    const d = lateFeeDisclosure(state, due);
    return this.emit("installment.due_date_reached", state.loan_id, { installment_due_date: due, due_date: due, reached_on: on, grace_end_on, basis_cents: str(basisCents(state, inst)), late_fee_amount_if_unpaid: str(d.late_fee_amount_if_unpaid), late_fee_date: d.late_fee_date, status: inst.status }, { kind: "installment", id: `${state.loan_id}:${due}` });
  }
  /** The engine run for one installment (rule 1 test derived from the state unless the caller carries it); bankruptcy-suspended charges are exposed to 14.2. */
  assess(i: AssessmentInput): AssessmentResult {
    const r = this.ops.runAssessment(i);
    if (r.outcome === "accrued_suspended" && r.fee.suppression === "bankruptcy_active") {
      const bk = i.state.overlays?.find((o) => o.kind === "bankruptcy_active");
      this.emit("fee.incurred_postpetition", i.state.loan_id, { fee_id: r.fee.id, fee_type: "late_charge", incurred_on: r.fee.assessed_on, installment_due_date: r.fee.installment_due_date, amount_cents: str(r.fee.amount_cents), case_id: bk?.source_case_id ?? null, cite: "Fed. R. Bankr. P. 3002.1(c)" }, feeAgg(r.fee.id));
    }
    return r;
  }
  /**
   * The daily 00:30 run: `installment.due_date_reached` for every installment due today, and the assessment for every installment
   * whose grace end was the previous day (re-runs for earlier installments are decided by the once-only gate).
   */
  dailyRun(state: LoanCashState, runOn: PlainDate, opts: { unposted_receipts_on_or_before_grace?: number } = {}): { due_reached: PlainDate[]; decisions: AssessmentResult[] } {
    const due_reached: PlainDate[] = []; const decisions: AssessmentResult[] = [];
    for (const inst of state.installments) {
      if (inst.due_date === runOn) { this.installmentDue(state, inst.due_date, runOn); due_reached.push(inst.due_date); }
      if (graceEndFor(state, inst.due_date, this.cal) === addDays(runOn, -1)) decisions.push(this.assess({ state, installment_due_date: inst.due_date, run_on: runOn, unposted_receipts_on_or_before_grace: opts.unposted_receipts_on_or_before_grace ?? 0 }));
    }
    return { due_reached, decisions };
  }

  // ───────────────────────── rule 3 overlays (case hand-offs from 12.x / 13.9 / 14.x)
  private openSuppression(state: LoanCashState, reason: OverlayKind, mode: Suppression["mode"], plan: PlanInput, extra: Payload = {}): Suppression {
    if (!plan.case_id) throw new RangeError(`${reason}: case_id is required`);
    if (!isDate(plan.plan_start)) throw new RangeError(`${reason}: plan_start must be a date (got ${String(plan.plan_start)})`);
    if (plan.plan_end != null && plan.plan_end < plan.plan_start) throw new RangeError(`${reason}: plan_end ${plan.plan_end} is before plan_start ${plan.plan_start}`);
    const overlay: Overlay = { kind: reason, from: plan.plan_start, to: plan.plan_end ?? null, source_case_id: plan.case_id };
    state.overlays = [...(state.overlays ?? []).filter((o) => !(o.kind === reason && o.source_case_id === plan.case_id)), overlay];
    const row: Suppression = { loan_id: state.loan_id, reason, source_case_id: plan.case_id, starts_on: plan.plan_start, ends_on: plan.plan_end ?? null, mode };
    this.emit("late_charge.suppression.opened", state.loan_id, { ...row, ...extra }, { kind: "case", id: plan.case_id });
    return row;
  }
  /** D2-3.2-01: "must not accrue or collect late charges from the borrower during the forbearance plan" — `case.forbearance.opened{plan_start}`. */
  forbearanceOpened(state: LoanCashState, plan: PlanInput): Suppression {
    const row = this.openSuppression(state, "forbearance_active", "no_accrual", plan, { cite: "Servicing Guide D2-3.2-01" });
    this.emit("case.forbearance.opened", state.loan_id, { case_id: plan.case_id, plan_start: plan.plan_start, plan_end: plan.plan_end ?? null, mode: "no_accrual", cite: "Servicing Guide D2-3.2-01" }, { kind: "case", id: plan.case_id });
    return row;
  }
  /** D2-3.2-01: on plan default "the servicer is authorized to accrue late charges from the date the borrower defaulted on the plan". */
  forbearanceDefaulted(state: LoanCashState, caseId: string, defaultedOn: PlainDate): Overlay {
    const o = (state.overlays ?? []).find((x) => x.kind === "forbearance_active" && x.source_case_id === caseId);
    if (!o) throw new RangeError(`forbearanceDefaulted: no forbearance overlay for case ${caseId}`);
    if (defaultedOn < o.from) throw new RangeError(`forbearanceDefaulted: ${defaultedOn} is before the plan start ${o.from}`);
    const next: Overlay = { ...o, defaulted_on: defaultedOn };
    state.overlays = (state.overlays ?? []).map((x) => (x === o ? next : x));
    this.emit("case.forbearance.defaulted", state.loan_id, { case_id: caseId, defaulted_on: defaultedOn, accrual_resumes_for_installments_due_on_or_after: defaultedOn, cite: "Servicing Guide D2-3.2-01" }, { kind: "case", id: caseId });
    return next;
  }
  /** D2-3.2-02: charges accrued during the repayment plan are carried `accrued_suspended{repayment_plan_pending_waiver}` until completion (waive) or failure (assess). */
  repaymentOpened(state: LoanCashState, plan: PlanInput): Suppression {
    const row = this.openSuppression(state, "repayment_plan_pending_waiver", "accrue_suspended", plan, { cite: "Servicing Guide D2-3.2-02" });
    this.emit("case.repayment.opened", state.loan_id, { case_id: plan.case_id, plan_start: plan.plan_start, plan_end: plan.plan_end ?? null, mode: "accrue_suspended", cite: "Servicing Guide D2-3.2-02" }, { kind: "case", id: plan.case_id });
    return row;
  }
  /** `case.repayment.completed{completed_on}` → every charge accrued during the plan waived the same day (`fee.waived{reason=workout_completion}`); pre-plan charges are untouched. */
  repaymentCompleted(state: LoanCashState, caseId: string, completedOn: PlainDate = this.today()): { waived: Fee[]; total_cents: Cents } {
    const o = (state.overlays ?? []).find((x) => x.kind === "repayment_plan_pending_waiver" && x.source_case_id === caseId);
    if (!o) throw new RangeError(`repaymentCompleted: no repayment-plan overlay for case ${caseId}`);
    if (completedOn < o.from) throw new RangeError(`repaymentCompleted: ${completedOn} is before the plan start ${o.from}`);
    this.emit("case.repayment.completed", state.loan_id, { case_id: caseId, completion: completedOn, completed_on: completedOn, plan_start: o.from, cite: "Servicing Guide D2-3.2-02" }, { kind: "case", id: caseId });
    const waived: Fee[] = []; let total = 0n;
    for (const f of state.fees ?? []) {
      if (f.fee_type !== "late_charge" || f.state !== "accrued_suspended" || f.suppression !== "repayment_plan_pending_waiver" || f.assessed_on < o.from) continue;
      const r = this.ops.waive(state, f.id, "workout_completion", this.actor, completedOn);
      if (r.ok) { waived.push(f); total += r.waived_cents; }
    }
    state.overlays = (state.overlays ?? []).map((x) => (x === o ? { ...x, to: completedOn } : x));
    this.emit("late_charge.suppression.closed", state.loan_id, { loan_id: state.loan_id, reason: "repayment_plan_pending_waiver", source_case_id: caseId, ends_on: completedOn, outcome: "waived_on_completion", waived_count: waived.length, waived_cents: str(total) }, { kind: "case", id: caseId });
    return { waived, total_cents: total };
  }
  /**
   * 13.9's period: `scra.period.started{service_begin_on}` → no assessment for installments due in the period, charges assessed on/after the
   * service start waived (`fee.waived{scra}`), pre-service charges held `no_collection` (C-1.1-02; 50 U.S.C. 3937(d)(1); example O).
   */
  scraPeriodStarted(state: LoanCashState, period: { case_id: string; service_begin_on: PlainDate; service_end_on?: PlainDate | null }): { waived: Fee[]; held: Fee[] } {
    if (!isDate(period.service_begin_on)) throw new RangeError(`scraPeriodStarted: service_begin_on must be a date (got ${String(period.service_begin_on)})`);
    this.openSuppression(state, "scra_reduced_rate", "no_collection", { case_id: period.case_id, plan_start: period.service_begin_on, plan_end: period.service_end_on ?? null }, { cite: "Servicing Guide C-1.1-02; 50 U.S.C. 3937" });
    this.emit("scra.period.started", state.loan_id, { case_id: period.case_id, service_begin_on: period.service_begin_on, service_end_on: period.service_end_on ?? null, late_charges: "no assessment; assessed amounts waived; pre-service charges no_collection", cite: "Servicing Guide C-1.1-02; 50 U.S.C. 3937(d)(1)" }, { kind: "case", id: period.case_id });
    const waived: Fee[] = []; const held: Fee[] = [];
    for (const f of state.fees ?? []) {
      if (f.fee_type !== "late_charge" || (f.state !== "assessed" && f.state !== "accrued_suspended")) continue;
      if (f.assessed_on >= period.service_begin_on) { const r = this.ops.waive(state, f.id, "scra", this.actor, this.today()); if (r.ok) waived.push(f); }
      else { f.collection_hold = "scra_reduced_rate"; held.push(f); this.emit("fee.collection.held", state.loan_id, { fee_id: f.id, hold: "scra_reduced_rate", amount_cents: str(f.amount_cents), from: period.service_begin_on, post_period_default: "waive (2.7-Q6)" }, feeAgg(f.id)); }
    }
    return { waived, held };
  }
  /** 14.1's petition: charges accrue suspended `{bankruptcy_active}` — no collection, no statement billing; each is exposed to 14.2 by `assess`. */
  bankruptcyFiled(state: LoanCashState, filing: { case_id: string; chapter: 7 | 11 | 12 | 13; petition_date: PlainDate }): Suppression {
    if (![7, 11, 12, 13].includes(filing.chapter)) throw new RangeError(`bankruptcyFiled: chapter ${String(filing.chapter)} is not 7/11/12/13`);
    return this.openSuppression(state, "bankruptcy_active", "accrue_suspended", { case_id: filing.case_id, plan_start: filing.petition_date }, { chapter: filing.chapter, cite: "Fed. R. Bankr. P. 3002.1(c); 14.3 statement rules" });
  }
  /** The 14.2 exposure list: every post-petition charge with the date it was incurred (Rule 3002.1(c): noticed within 180 days). */
  bkExposureList(state: LoanCashState): BkExposureRow[] {
    const bk = (state.overlays ?? []).find((o) => o.kind === "bankruptcy_active");
    const rows = (state.fees ?? []).filter((f) => f.state === "accrued_suspended" && f.suppression === "bankruptcy_active")
      .map((f): BkExposureRow => ({ fee_id: f.id, incurred_on: f.assessed_on, installment_due_date: f.installment_due_date, amount_cents: f.amount_cents, case_id: bk?.source_case_id ?? null }));
    this.emit("bk.postpetition_fees.exposure_listed", state.loan_id, { case_id: bk?.source_case_id ?? null, count: rows.length, total_cents: str(rows.reduce((s, r) => s + r.amount_cents, 0n)), fees: rows.map((r) => ({ ...r, amount_cents: str(r.amount_cents) })), for: "14.2" });
    return rows;
  }

  // ───────────────────────── rule 4 collection, rule 6 reversal, rule 8 reporting
  /** Collect a charge from funds beyond the periodic payment (or designated for fees) — never from P&I/escrow; refused under a collection hold or a suspension. */
  collect(state: LoanCashState, feeId: string, amount: Cents, on: PlainDate, source: { payment_id: string; from: "remainder" | "fees_only" | "pi" | "escrow" }): CollectResult {
    if (amount <= 0n) throw new RangeError("collect: amount must be positive");
    const fee = (state.fees ?? []).find((f) => f.id === feeId);
    const refuse = (code: Exclude<CollectResult, { ok: true }>["code"], reason: string): CollectResult => { this.emit("fee.collection.refused", state.loan_id, { fee_id: feeId, code, reason, amount_cents: str(amount), payment_id: source.payment_id, on }, feeAgg(feeId)); return { ok: false, code, reason }; };
    if (source.from === "pi" || source.from === "escrow") return refuse("NOT_FROM_PI_ESCROW", "late charges are never netted from P&I or escrow (rule 4)");
    if (!fee || (fee.state !== "assessed" && fee.state !== "partially_collected")) return refuse("NOT_COLLECTIBLE", fee ? `fee is ${fee.state}${fee.suppression ? ` (${fee.suppression})` : ""}` : "no such fee");
    if (fee.collection_hold) return refuse("COLLECTION_HOLD", `no_collection during the ${fee.collection_hold} period (C-1.1-02 / 50 U.S.C. 3937)`);
    const open = fee.amount_cents - fee.collected_cents;
    const take = amount > open ? open : amount;
    fee.collected_cents += take; fee.collected_on = on;
    fee.state = fee.collected_cents >= fee.amount_cents ? "collected" : "partially_collected";
    if (fee.fee_type === "late_charge") state.late_charges_due_cents -= take; else state.nsf_fees_due_cents -= take;
    this.emit("fee.collected", state.loan_id, { fee_id: feeId, fee_type: fee.fee_type, [fee.fee_type]: true, amount_cents: str(take), collected_on: on, payment_id: source.payment_id, from: source.from, state: fee.state, period: on.slice(0, 7) }, feeAgg(feeId));
    return { ok: true, fee, collected_cents: take };
  }
  /** Rule 6: a payment re-dated on time (4.1 correction, lockbox date error, transferor forwarding) reverses the charge, refunds what was collected and corrects 8.1. */
  redate(state: LoanCashState, installmentDueDate: PlainDate, newCreditedAsOf: PlainDate, opts: { correction_ref: string; delinquency_reported?: boolean; on?: PlainDate }): { reversed: Fee | null; refund_cents: Cents; credit_reporting_correction: boolean } {
    if (!isDate(newCreditedAsOf)) throw new RangeError(`redate: credited_as_of must be a date (got ${String(newCreditedAsOf)})`);
    const on = opts.on ?? this.today();
    const inst = state.installments.find((x) => x.due_date === installmentDueDate);
    if (inst && (inst.credited_as_of === undefined || newCreditedAsOf < inst.credited_as_of)) inst.credited_as_of = newCreditedAsOf;
    this.emit("payment.reapplied", state.loan_id, { installment_due_date: installmentDueDate, credited_as_of: newCreditedAsOf, correction_ref: opts.correction_ref, on });
    const r = reverseOnRedate(state, installmentDueDate, newCreditedAsOf);
    if (!r.reversed) return { ...r, credit_reporting_correction: false };
    const f = r.reversed;
    this.emit("fee.reversed", state.loan_id, { fee_id: f.id, fee_type: f.fee_type, installment_due_date: installmentDueDate, amount_cents: str(f.amount_cents), refund_cents: str(r.refund_cents), credited_as_of: newCreditedAsOf, correction_ref: opts.correction_ref, reversed_on: on, ledger: r.refund_cents > 0n ? "Dr late_charge_income / Cr late_charges; refund to borrower" : "Dr late_charge_income / Cr late_charges" }, feeAgg(f.id));
    if (r.refund_cents > 0n) this.emit("fee.refund.due", state.loan_id, { fee_id: f.id, refund_cents: str(r.refund_cents), reason: "late charge reversed: payment re-dated on time", correction_ref: opts.correction_ref }, feeAgg(f.id));
    const correct = opts.delinquency_reported !== false;
    if (correct) this.emit("credit.correction.requested", state.loan_id, { loan_id: state.loan_id, reason: "payment re-dated on time; late charge reversed", installment_due_date: installmentDueDate, credited_as_of: newCreditedAsOf, correction_ref: opts.correction_ref, for: "8.1" });
    return { ...r, credit_reporting_correction: correct };
  }
  /** Rule 8 / A2-3-04: Σ collected in the period → 5.1's `fees.collected` on the loan's next LAR/event. */
  reportCollected(state: LoanCashState, period: string): { period: string; fees_collected_cents: Cents } {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new RangeError(`reportCollected: period must be YYYY-MM (got ${period})`);
    const total = collectedForPeriod(state.fees ?? [], period);
    this.emit("investor_events.created", state.loan_id, { type: "fees.collected", period, fees_collected_cents: str(total), lar_field: "other fees", cite: "Servicing Guide A2-3-04" });
    return { period, fees_collected_cents: total };
  }

  // ───────────────────────── rule 9 statement / reminder data
  /** Charges the statement bills: `assessed`/`partially_collected` only — suspended (bankruptcy, plan, trial) charges are never billed (14.3 statement rules). */
  billableLateCharges(state: LoanCashState): Cents {
    return (state.fees ?? []).filter((f) => f.fee_type === "late_charge" && (f.state === "assessed" || f.state === "partially_collected")).reduce((s, f) => s + f.amount_cents - f.collected_cents, 0n);
  }
  /** 7.1 (§1026.41(d)(2)(ii)) and the D2-2-03 reminder: the fee if unpaid, the date it is imposed, and the late charges due. */
  reminderData(state: LoanCashState, due: PlainDate): { late_fee_amount_if_unpaid: Cents; late_fee_date: PlainDate; late_charges_due_cents: Cents } {
    return { ...lateFeeDisclosure(state, due), late_charges_due_cents: this.billableLateCharges(state) };
  }
}

