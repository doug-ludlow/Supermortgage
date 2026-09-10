/**
 * §15.4 Delinquency (P&I) advance recovery — one pure function per rule / T-id on top of ./advances.ts
 * (expectations by exit event, FIFO matching at $0.05): the daily position row (rule 2), the expected-recovery
 * event and amount by exit (rule 3), the rule-4 line matching / ledger / corporate transfer (T2–T4), the reclass /
 * payoff / rescission branches (T5, T8, T9 — rules 3 and 8), the S/A month-4 LAR 96 recovery (T6), the E-3.5-01
 * sale-package gate (T7), the rule-5 claim-leak check (T1, T10), Cash Adjustments parsing, the Investor
 * Reporting Representative variance package, the `officer` write-off rule and the partner's monthly aging report.
 *
 * Fannie Mae reimburses P&I delinquency advances through investor-reporting/draft mechanics — no form, no 571
 * line (rule 5). All amounts are bigint cents as drafted/reported; variances are investigated, never rounded
 * away (rule 9).
 */
import { type PlainDate, addDays, addMonths, daysBetween } from "../../kernel/calendar/date.ts";
import { wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { AccountRef, LineInput } from "../../kernel/ledger/ledger.ts";
import type { EventInput } from "../../kernel/events/index.ts";
import { calendarDraftDate, nextMonth, fannieBusinessDay, period, larDeadlineMs } from "../investor/period.ts";
import { advanceSpecialRemittance } from "../payoff/ops-16-2.ts";
import { type Advance, type MatchResult, expectedRecovery, matchReimbursement, outstanding, unrecoveredEscalationDue, duplicateCreditNoticeDue, mbsRemovalGate, MATCH_TOLERANCE, saRecoveryLar } from "./advances.ts";
import { validateLine, type ClaimLine, type ClaimContext } from "./claims.ts";
import { rescissionClocks } from "./reogram.ts";

export type RemittanceType = "SS" | "SA" | "AA";
export type ServicingOption = "special" | "regular_mbs" | "portfolio";
export type AdvanceKind = "delinquency_pi" | "delinquency_interest_sa";
export type AdvanceStatus = Advance["status"] | "written_off";
export type SdaStatus = "not_applicable" | "predicted" | "active" | "exited";
export type ExpectedRecoveryEvent = "liquidation_lar" | "reclass_pa" | "deferral_acceptance" | "payoff" | "repurchase" | "borrower_contractual" | "pre_fcl_removal";
export type PositionStatus = "accruing" | "sda_active" | "recovery_expected" | "matched" | "variance" | "escalated" | "closed";
export type RecoverySource = "fnma_liquidation_reimb" | "fnma_reclass_pa" | "fnma_deferral_reimb" | "fnma_sda_recovery_credit" | "sa_negative_interest_lar" | "payoff_proceeds" | "repurchase_price" | "borrower_contractual" | "write_off" | "reversal";
export type SdaExitReason = "reclass" | "deferral" | "liquidation" | "current" | "payoff" | "repurchase";

/** `advances` row (kind delinquency_pi / delinquency_interest_sa) with the components the position row stores. */
export interface AdvanceRow {
  readonly id: string; readonly activity_period: string; readonly amount_cents: Cents; readonly status: AdvanceStatus;
  readonly kind?: AdvanceKind; readonly principal_cents?: Cents; readonly interest_cents?: Cents; readonly drafted_at?: PlainDate | null; readonly funded_from?: string | null;
}
/** `advance_recoveries` row — every booked recovery carries a report-line reference (guardrail). */
export interface RecoveryRow { readonly id?: string; readonly advance_id: string; readonly source: RecoverySource; readonly amount_cents: Cents; readonly recovered_at: PlainDate; readonly report_line_ref: string; readonly crs_code?: string | null; readonly notes?: string; /** Rule 4/9: the ≤ $0.05 the reported credit fell short of this advance — carried, never rounded into cash. */ readonly tolerance_cents?: Cents; }
export interface LedgerLine { readonly account: "custodial_pi_cash" | "corporate_cash" | "servicer_advance_receivable" | "fnma_payable"; readonly side: "Dr" | "Cr"; readonly amount_cents: Cents; }

const abs = (v: Cents): Cents => (v < 0n ? -v : v);
const kindOf = (a: AdvanceRow): AdvanceKind => a.kind ?? "delinquency_pi";
/** The outstanding rows of one kind as ./advances.ts `Advance`s (rule 2: S/S P&I and S/A interest are summed separately; FIFO matching ignores every other status). */
export function openAdvances(rows: readonly AdvanceRow[], kind: AdvanceKind = "delinquency_pi"): Advance[] {
  return rows.filter((a) => a.status === "outstanding" && kindOf(a) === kind).map((a) => ({ id: a.id, activity_period: a.activity_period, amount_cents: a.amount_cents, status: "outstanding" as const }));
}
export function outstandingCents(rows: readonly AdvanceRow[], kind: AdvanceKind = "delinquency_pi"): Cents { return outstanding(openAdvances(rows, kind)); }
const withStatus = (rows: readonly AdvanceRow[], ids: ReadonlySet<string>, status: AdvanceStatus): AdvanceRow[] => rows.map((a) => (ids.has(a.id) ? { ...a, status } : a));

// ---------------------------------------------------------------------------
// Rule 2 — the daily position row (`delinquency_advance_positions`)
// ---------------------------------------------------------------------------
export interface PositionPeriod { readonly activity_period: string; readonly principal_cents: Cents; readonly interest_cents: Cents; readonly drafted_at: PlainDate | null; readonly funded_from: string | null; readonly advance_id: string; readonly status: AdvanceStatus; }
export interface PositionInput {
  readonly loan_id: string; readonly as_of: PlainDate; readonly remittance_type: RemittanceType; readonly servicing_option: ServicingOption; readonly sda_status: SdaStatus;
  readonly advances: readonly AdvanceRow[]; readonly fnma_sda_receivable_cents: Cents;
  readonly sa_interest_advanced_cents?: Cents; readonly sa_month4_interest_cents?: Cents; readonly gfee_advanced_cents?: Cents;
  readonly expected_recovery_event?: ExpectedRecoveryEvent | null; readonly expected_by?: PlainDate | null; readonly matched_cents?: Cents; readonly variance_cents?: Cents; readonly escalated?: boolean;
}
export interface PositionRow {
  readonly loan_id: string; readonly as_of: PlainDate; readonly remittance_type: RemittanceType; readonly servicing_option: ServicingOption; readonly applies: boolean;
  readonly servicer_pi_advances_outstanding_cents: Cents; readonly periods: readonly PositionPeriod[]; readonly fnma_sda_receivable_cents: Cents;
  readonly sa_interest_advanced_cents: Cents; readonly sa_month4_interest_cents: Cents; readonly gfee_advanced_cents: Cents;
  readonly expected_recovery_event: ExpectedRecoveryEvent | null; readonly expected_by: PlainDate | null; readonly matched_cents: Cents; readonly variance_cents: Cents; readonly status: PositionStatus;
}
/**
 * Rule 2: `servicer_pi_advances_outstanding = Σ advances.kind = delinquency_pi with status = outstanding`; the S/A interest advanced is
 * the `delinquency_interest_sa` rows (never counted twice); Fannie Mae's receivable is carried, never netted.
 */
export function advancePosition(f: PositionInput): PositionRow {
  const applies = f.remittance_type !== "AA";
  const out = outstandingCents(f.advances, "delinquency_pi");
  const sa = f.sa_interest_advanced_cents ?? outstandingCents(f.advances, "delinquency_interest_sa");
  const matched = f.matched_cents ?? 0n; const variance = f.variance_cents ?? 0n;
  const periods = f.advances.map((a) => ({ activity_period: a.activity_period, principal_cents: a.principal_cents ?? (kindOf(a) === "delinquency_interest_sa" ? 0n : a.amount_cents - (a.interest_cents ?? 0n)), interest_cents: a.interest_cents ?? (kindOf(a) === "delinquency_interest_sa" ? a.amount_cents : 0n), drafted_at: a.drafted_at ?? null, funded_from: a.funded_from ?? null, advance_id: a.id, status: a.status }));
  let status: PositionStatus;
  if (!applies || (f.advances.length > 0 && out + sa === 0n && !f.escalated)) status = "closed";
  else if (f.escalated) status = "escalated";
  else if (matched > 0n && abs(variance) > MATCH_TOLERANCE) status = "variance";
  else if (matched > 0n) status = "matched";
  else if (f.expected_recovery_event) status = "recovery_expected";
  else if (f.sda_status === "active") status = "sda_active";
  else status = "accruing";
  return { loan_id: f.loan_id, as_of: f.as_of, remittance_type: f.remittance_type, servicing_option: f.servicing_option, applies,
    servicer_pi_advances_outstanding_cents: out, periods, fnma_sda_receivable_cents: f.fnma_sda_receivable_cents,
    sa_interest_advanced_cents: sa, sa_month4_interest_cents: f.sa_month4_interest_cents ?? 0n, gfee_advanced_cents: f.gfee_advanced_cents ?? 0n,
    expected_recovery_event: f.expected_recovery_event ?? null, expected_by: f.expected_by ?? null, matched_cents: matched, variance_cents: variance, status };
}
/** Guardrail (5.4 / FNMA_F120_SDA_FUNDING_HOLD): an `advances` row drafted on or after the Stop Delinquency Advance start date is an advance funded on a Stop Advance loan. */
export function advancesFundedDuringSda(rows: readonly AdvanceRow[], sdaStatus: SdaStatus, sdaStartDate: PlainDate | null): readonly string[] {
  if (sdaStatus !== "active" || sdaStartDate === null) return [];
  return rows.filter((a) => a.status === "outstanding" && a.drafted_at != null && a.drafted_at >= sdaStartDate).map((a) => a.id);
}
/**
 * Stop Advance as Fannie Mae reported it (5.4 state machine), read from the loan's `sda_status.*` history: the last of
 * `sda_status.predicted` / `sda_status.active` / `sda_status.exited` decides (`sda_status.reconciled` confirms, never moves, the
 * status); the start date is the active event's `start_date` (`sda_start_date` / `effective_date`), else the day it was recorded.
 */
export function sdaStatusFromEvents(events: readonly { readonly type: string; readonly payload: Record<string, unknown>; readonly occurredAt: string }[]): { status: SdaStatus; start_date: PlainDate | null } {
  const moves = events.filter((e) => e.type === "sda_status.active" || e.type === "sda_status.predicted" || e.type === "sda_status.exited");
  const last = moves[moves.length - 1];
  if (!last) return { status: "not_applicable", start_date: null };
  const status: SdaStatus = last.type === "sda_status.active" ? "active" : last.type === "sda_status.predicted" ? "predicted" : "exited";
  const raw = last.payload.start_date ?? last.payload.sda_start_date ?? last.payload.effective_date;
  const start = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw) ? (raw.slice(0, 10) as PlainDate) : wallClock(Date.parse(last.occurredAt), "America/New_York").date;
  return { status, start_date: status === "exited" ? null : start };
}
/** The timer row's trigger — "any delinquent S/S or S/A loan": a loan the position applies to that still carries an advance (or an open expectation). */
export function positionSweepDue(row: PositionRow): boolean { return row.applies && row.status !== "closed"; }
export const POSITION_SWEEP_JOB = "deladv-position-sweep";
/**
 * SM_DELADV_POSITION_DAILY's arming event — the 15.4 daily schedule as an event (spec "Schedules: daily position recompute (post
 * `timer-sweep`)"): `schedule.tick{cadence=daily, at=00:30, job=deladv-position-sweep}` at 00:30 on the loan's calendar, once per
 * delinquent S/S or S/A loan; the row the sweep then writes (`delinquency_advance_positions.written`) satisfies the recurring row,
 * which re-arms itself for the next day, so the tick is emitted only for a loan whose daily clock is not already open.
 */
export function positionSweepTick(today: PlainDate, loanId: string): EventInput {
  return { type: "schedule.tick", loanId, actor: { kind: "system", id: "scheduler" }, payload: { cadence: "daily", at: "00:30", tz: "loan_local", job: POSITION_SWEEP_JOB, date: today } };
}

// ---------------------------------------------------------------------------
// Rule 3 — expected recovery event and amount by exit
// ---------------------------------------------------------------------------
export type ExitEvent = Exclude<ExpectedRecoveryEvent, "borrower_contractual">;
export interface ExpectationInput { readonly remittance_type: RemittanceType; readonly servicing_option: ServicingOption; readonly event: ExitEvent; readonly accepted_on: PlainDate; readonly advances: readonly AdvanceRow[]; readonly sa_month4_interest_cents?: Cents; }
export interface Expectation {
  readonly expected_recovery_event: ExpectedRecoveryEvent; readonly expected_by: PlainDate | null; readonly cycles: readonly PlainDate[]; readonly expected_cents: Cents; readonly fnma_reimburses: boolean;
  readonly source: RecoverySource | null; readonly timer: string | null; readonly data_error: string | null; readonly escalation: { kind: "sev2" | "officer"; reason: string } | null;
}
/** S/A liquidation: the fourth-month interest is reimbursed after the LAR 70/71/72 — expected within two S/A (CD20) draft cycles. */
export function saLiquidationInterestExpectation(acceptedOn: PlainDate, month4InterestCents: Cents): { expected_cents: Cents; expected_by: PlainDate; cycles: readonly PlainDate[]; timer: "FNMA_IRM_SA_LIQ_INTEREST_REIMB" } {
  const c1 = calendarDraftDate(nextMonth(acceptedOn), 20), c2 = calendarDraftDate(nextMonth(addMonths(acceptedOn, 1)), 20);
  return { expected_cents: month4InterestCents, expected_by: c2, cycles: [c1, c2], timer: "FNMA_IRM_SA_LIQ_INTEREST_REIMB" };
}
/**
 * Rule 3: liquidation (S/S special) → full outstanding within two S/S draft cycles; reclass → full amount on the purchase advice;
 * deferral → full amount within 4 `fannie_et` BD; payoff/repurchase → Fannie Mae reimburses nothing (recovery from the proceeds
 * the same day); regular servicing option MBS → recovered through the pre-foreclosure removal, never a liquidation reimbursement.
 * Guardrail: an S/S special servicing loan liquidated with a zero expectation is flagged as a data error.
 */
export function recoveryExpectation(f: ExpectationInput): Expectation {
  const out = outstandingCents(f.advances);
  const none = (event: ExpectedRecoveryEvent, source: RecoverySource | null, timer: string | null, extra: Partial<Expectation> = {}): Expectation =>
    ({ expected_recovery_event: event, expected_by: null, cycles: [], expected_cents: 0n, fnma_reimburses: false, source, timer, data_error: null, escalation: null, ...extra });
  if (f.remittance_type === "AA") return none(f.event, null, null, { data_error: "aa_loan_has_no_delinquency_advances" });
  switch (f.event) {
    case "liquidation_lar": {
      if (f.servicing_option === "regular_mbs") return none("pre_fcl_removal", "repurchase_price", "FNMA_E3501_MBS_REMOVAL_BEFORE_FCL", { data_error: "regular_servicing_option_liquidated_in_pool", escalation: { kind: "officer", reason: "E-3.5-01: a regular servicing option MBS loan must be repurchased/reclassified before foreclosure completion; advances recover through the removal, not a liquidation reimbursement" } });
      if (f.remittance_type === "SA") { const e = saLiquidationInterestExpectation(f.accepted_on, f.sa_month4_interest_cents ?? outstandingCents(f.advances, "delinquency_interest_sa")); return { expected_recovery_event: "liquidation_lar", expected_by: e.expected_by, cycles: e.cycles, expected_cents: e.expected_cents, fnma_reimburses: e.expected_cents > 0n, source: "fnma_liquidation_reimb", timer: e.timer, data_error: null, escalation: null }; }
      const e = expectedRecovery("liquidation_lar", f.accepted_on);
      const zero = out === 0n;
      return { expected_recovery_event: "liquidation_lar", expected_by: e.expected_by, cycles: e.cycles, expected_cents: out, fnma_reimburses: true, source: "fnma_liquidation_reimb", timer: "SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES",
        data_error: zero ? "zero_expectation_on_ss_special_liquidation" : null, escalation: zero ? { kind: "sev2", reason: "S/S special servicing loan liquidated with a zero delinquency-advance expectation — data error (15.4 guardrail)" } : null };
    }
    case "reclass_pa": return { expected_recovery_event: "reclass_pa", expected_by: f.accepted_on, cycles: [], expected_cents: out, fnma_reimburses: true, source: "fnma_reclass_pa", timer: "FNMA_A1306_RECLASS_REIMB_PA", data_error: null, escalation: null };
    case "deferral_acceptance": { const e = expectedRecovery("deferral", f.accepted_on); return { expected_recovery_event: "deferral_acceptance", expected_by: e.expected_by, cycles: [], expected_cents: out, fnma_reimburses: true, source: "fnma_deferral_reimb", timer: "FNMA_IRM_PD_ADV_REIMB_4BD", data_error: null, escalation: null }; }
    case "payoff": return none("payoff", "payoff_proceeds", "SM_PAYOFF_ADV_RECOVERY_SAME_DAY", { expected_by: f.accepted_on });
    case "repurchase": return none("repurchase", "repurchase_price", "SM_PAYOFF_ADV_RECOVERY_SAME_DAY", { expected_by: f.accepted_on });
    case "pre_fcl_removal": return none("pre_fcl_removal", "repurchase_price", "FNMA_E3501_MBS_REMOVAL_BEFORE_FCL", { expected_by: f.accepted_on, expected_cents: out });
  }
}

/** 5.4: the exit transaction that ends Stop Delinquency Advance (F-1-20 exit table) — `sda_status.exited{reason}` lifts FNMA_F120_SDA_FUNDING_HOLD and arms SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES (liquidation / reclass / deferral only: a payoff or repurchase is reimbursed by nobody, rule 3). */
export const SDA_EXIT_REASON: Readonly<Record<ExitEvent, SdaExitReason | null>> = { liquidation_lar: "liquidation", reclass_pa: "reclass", deferral_acceptance: "deferral", payoff: "payoff", repurchase: "repurchase", pre_fcl_removal: null };
export function sdaExit(event: ExitEvent, sdaStatus: SdaStatus, exitedOn: PlainDate): { status: "exited"; reason: SdaExitReason; exited_on: PlainDate } | null {
  if (sdaStatus !== "active" && sdaStatus !== "predicted") return null;
  const reason = SDA_EXIT_REASON[event];
  return reason ? { status: "exited", reason, exited_on: exitedOn } : null;
}

// ---------------------------------------------------------------------------
// The 5.3 clock on the 15.4 rail — liquidation processed, LAR not yet accepted (FNMA_IRM_LIQ_AC70_72_NEXTBD_2000: "reimbursement cannot trigger")
// ---------------------------------------------------------------------------
export type LiquidationActionCode = "70" | "71" | "72";
export const LIQUIDATION_EVENT_TYPE: Readonly<Record<LiquidationActionCode, string>> = { "70": "removal.liquidation.uninsured", "71": "removal.liquidation.third_party", "72": "removal.liquidation.insured" };
export interface LiquidationProcessedInput {
  readonly fact_id: string; /** ISO instant the liquidation was processed in servicing (5.3 `liquidation_facts.processed_at`). */ readonly processed_at: string; readonly action_code: string;
  readonly sale_date?: PlainDate | null; readonly mi_insured?: boolean; readonly remittance_type: RemittanceType; readonly servicing_option: ServicingOption; readonly advances: readonly AdvanceRow[];
}
export interface LiquidationProcessed {
  readonly event: "liquidation_facts.processed";
  readonly payload: { fact_id: string; processed_at: string; action_code: LiquidationActionCode; event_type: string; sale_date: PlainDate | null; mi_insured: boolean; remittance_type: RemittanceType; servicing_option: ServicingOption; advances_outstanding_cents: Cents; reimbursement_can_trigger: false; lar_due_at: string };
  readonly timer: "FNMA_IRM_LIQ_AC70_72_NEXTBD_2000"; readonly lar_due_at_ms: number; readonly lar_due_at: string; readonly lar_due_date: PlainDate;
  readonly reimbursement_can_trigger: false; readonly pending_expected_recovery_event: "liquidation_lar" | "pre_fcl_removal" | null; readonly advances_outstanding_cents: Cents; readonly data_error: string | null;
}
/**
 * "Trigger transactions (ours): `removal.liquidation.uninsured|insured|third_party` accepted (LAR 70/72/71)" and "the deadlines that
 * exist are ours (report the triggering transaction on the 5.1/5.3 clocks)": the liquidation fact validated and recorded as
 * `liquidation_facts.processed{processed_at}` — the 5.3 row arms next BD 20:00 ET (BD2 17:00 ET when processed on BD1) and is
 * satisfied by the LAR submission; until the LAR is accepted no reimbursement expectation exists (breach sev-1: "reimbursement cannot trigger").
 */
export function liquidationProcessed(f: LiquidationProcessedInput): LiquidationProcessed {
  if (!(f.action_code in LIQUIDATION_EVENT_TYPE)) throw new RangeError(`action_code ${f.action_code} is not a liquidation LAR (70/71/72)`);
  const ms = Date.parse(f.processed_at);
  if (Number.isNaN(ms)) throw new RangeError(`processed_at ${f.processed_at} is not an ISO instant`);
  if (!f.fact_id) throw new RangeError("fact_id is required");
  const code = f.action_code as LiquidationActionCode;
  const dueMs = larDeadlineMs(ms, true);
  const out = outstandingCents(f.advances, "delinquency_pi") + outstandingCents(f.advances, "delinquency_interest_sa");
  const regular = f.servicing_option === "regular_mbs";
  const payload = { fact_id: f.fact_id, processed_at: toIso(ms), action_code: code, event_type: LIQUIDATION_EVENT_TYPE[code], sale_date: f.sale_date ?? null, mi_insured: f.mi_insured === true, remittance_type: f.remittance_type, servicing_option: f.servicing_option, advances_outstanding_cents: out, reimbursement_can_trigger: false as const, lar_due_at: toIso(dueMs) };
  return { event: "liquidation_facts.processed", payload, timer: "FNMA_IRM_LIQ_AC70_72_NEXTBD_2000", lar_due_at_ms: dueMs, lar_due_at: toIso(dueMs), lar_due_date: wallClock(dueMs, "America/New_York").date,
    reimbursement_can_trigger: false, pending_expected_recovery_event: f.remittance_type === "AA" ? null : regular ? "pre_fcl_removal" : "liquidation_lar", advances_outstanding_cents: out,
    data_error: f.remittance_type === "AA" ? "aa_loan_has_no_delinquency_advances" : regular ? "regular_servicing_option_liquidated_in_pool" : f.remittance_type === "SS" && out === 0n ? "zero_expectation_on_ss_special_liquidation" : null };
}

// ---------------------------------------------------------------------------
// 13.x sale scheduled on the 15.4 rail — E-3.5-01 gate (T7): `foreclosure.sale.scheduled{mbs_regular_servicing}` arms FNMA_E3501_MBS_REMOVAL_BEFORE_FCL
// ---------------------------------------------------------------------------
export interface SaleScheduledInput { readonly sale_on: PlainDate; readonly servicing_option: ServicingOption | null; readonly repurchase_or_reclass_accepted: boolean; readonly advances: readonly AdvanceRow[]; }
export interface SaleScheduled {
  readonly event: "foreclosure.sale.scheduled";
  readonly payload: { sale_at: PlainDate; mbs_regular_servicing: boolean; servicing_option: ServicingOption | null; repurchase_or_reclass_accepted: boolean; remove_by: PlainDate; advances_outstanding_cents: Cents; timer: "FNMA_E3501_MBS_REMOVAL_BEFORE_FCL" };
  readonly gate: SalePackageGate;
  readonly expectation: { expected_recovery_event: "pre_fcl_removal" | null; expected_by: PlainDate; expected_cents: Cents; source: "repurchase_price" | null; timer: "FNMA_E3501_MBS_REMOVAL_BEFORE_FCL" };
}
/** The scheduled sale (13.x) ingested: a regular servicing option MBS loan must leave the pool before the sale — the gate closes the sale-package release and opens an `officer` escalation until the repurchase/reclass is accepted (rule 1; E-3.5-01). */
export function saleScheduled(f: SaleScheduledInput): SaleScheduled {
  const gate = salePackageReleaseGate({ servicing_option: f.servicing_option, repurchase_or_reclass_accepted: f.repurchase_or_reclass_accepted, sale_on: f.sale_on });
  const out = outstandingCents(f.advances, "delinquency_pi");
  const regular = f.servicing_option === "regular_mbs";
  return { event: "foreclosure.sale.scheduled",
    payload: { sale_at: f.sale_on, mbs_regular_servicing: regular, servicing_option: f.servicing_option, repurchase_or_reclass_accepted: f.repurchase_or_reclass_accepted, remove_by: gate.remove_by, advances_outstanding_cents: out, timer: "FNMA_E3501_MBS_REMOVAL_BEFORE_FCL" },
    gate, expectation: { expected_recovery_event: regular ? "pre_fcl_removal" : null, expected_by: gate.remove_by, expected_cents: regular ? out : 0n, source: regular ? "repurchase_price" : null, timer: "FNMA_E3501_MBS_REMOVAL_BEFORE_FCL" } };
}

// ---------------------------------------------------------------------------
// Rule 4 — a reimbursement line matched FIFO to `advances`, the ledger and the corporate transfer (T2, T3, T4)
// ---------------------------------------------------------------------------
export type FnmaReimbursementSource = Extract<RecoverySource, "fnma_liquidation_reimb" | "fnma_deferral_reimb" | "fnma_reclass_pa" | "fnma_sda_recovery_credit" | "sa_negative_interest_lar">;
export interface ReimbursementLineInput {
  readonly line: { readonly report_line_ref: string; readonly amount_cents: Cents; readonly crs_code?: string | null }; readonly advances: readonly AdvanceRow[]; readonly source: FnmaReimbursementSource;
  readonly recovered_at: PlainDate; readonly disbursed_to?: "custodial" | "corporate"; readonly kind?: AdvanceKind;
}
export interface ReimbursementLineResult {
  readonly status: MatchResult["status"]; readonly match: MatchResult; readonly recoveries: readonly RecoveryRow[]; readonly advances_after: readonly AdvanceRow[];
  readonly ledger: RecoveryLedger | null; readonly remaining_outstanding_cents: Cents; readonly position_closed: boolean; readonly variance_cents: Cents;
  /** Rule 9: the ≤ $0.05 the credit fell short of the matched advances — left in `servicer_advance_receivable`, never rounded into cash. */ readonly residual_cents: Cents;
  /** A credit above the matched advances — a payable to Fannie Mae, never kept. */ readonly excess_cents: Cents;
}
/**
 * Rule 4: FIFO by activity period at $0.05 per line; the matched rows move to `reimbursed_by_fnma`; Dr cash for the amount Fannie Mae
 * actually credited (rule 9: as reported, never recomputed) / Cr `servicer_advance_receivable` for what that cash relieves, then the
 * corporate transfer. A credit within tolerance but short of the advances leaves the residual cents in the receivable (on the last
 * matched recovery row as `tolerance_cents`); a credit above them books the excess as a payable to Fannie Mae.
 */
export function applyReimbursementLine(f: ReimbursementLineInput): ReimbursementLineResult {
  const kind = f.kind ?? "delinquency_pi";
  const match = matchReimbursement(openAdvances(f.advances, kind), f.line.amount_cents);
  const ids = new Set(match.matched);
  const ledger = match.matched_cents > 0n ? recoveryLedger(match.matched_cents, f.disbursed_to ?? "custodial", f.line.amount_cents) : null;
  const residual = ledger?.residual_cents ?? 0n;
  const matchedRows = f.advances.filter((a) => ids.has(a.id));
  const recoveries: RecoveryRow[] = matchedRows.map((a, idx) => {
    const last = idx === matchedRows.length - 1;
    const short = last ? residual : 0n;
    return { advance_id: a.id, source: f.source, amount_cents: a.amount_cents - short, recovered_at: f.recovered_at, report_line_ref: f.line.report_line_ref, crs_code: f.line.crs_code ?? null, ...(short > 0n ? { tolerance_cents: short, notes: `credit ${short}¢ short of the advance within the $0.05 line tolerance (rule 4); residual stays in servicer_advance_receivable (rule 9)` } : {}) };
  });
  const after = withStatus(f.advances, ids, "reimbursed_by_fnma");
  const remaining = outstandingCents(after, "delinquency_pi") + outstandingCents(after, "delinquency_interest_sa");
  return { status: match.status, match, recoveries, advances_after: after, ledger, remaining_outstanding_cents: remaining, position_closed: remaining === 0n && recoveries.length > 0, variance_cents: match.variance_cents, residual_cents: residual, excess_cents: ledger?.excess_cents ?? 0n };
}
/** A reimbursement line as it lands from the report: the reference, the amount as reported (never recomputed), the report date and the CRS code if any. */
export interface ReportLine { readonly report_line_ref: string; readonly amount_cents: Cents; readonly report_date: PlainDate; readonly crs_code?: string | null; }
export interface LiquidationReimbursementInput {
  readonly accepted_on: PlainDate; readonly lar: { readonly id: string; readonly ack_id: string | null; readonly action_code: "70" | "71" | "72" }; readonly advances: readonly AdvanceRow[];
  readonly line: ReportLine | null; readonly today: PlainDate; readonly servicing_option?: ServicingOption;
}
export interface LiquidationReimbursement {
  readonly expectation: Expectation; readonly applied: ReimbursementLineResult | null; readonly variance_cents: Cents;
  readonly timers: { readonly SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES: { due: PlainDate | null; satisfied: boolean }; readonly SM_DELADV_UNRECOVERED_60: { due: PlainDate; satisfied: boolean } };
  readonly irr_package: IrrPackage | null; readonly sda_exit: { status: "exited"; reason: "liquidation"; exited_on: PlainDate } ;
}
/** Rule 7 flow (T1–T3): LAR 70/71/72 accepted → expectation over two S/S draft cycles; the Cash Adjustments line matched FIFO; a short line → variance package; the 60-day clock from the exit. */
export function liquidationReimbursement(f: LiquidationReimbursementInput): LiquidationReimbursement {
  const expectation = recoveryExpectation({ remittance_type: "SS", servicing_option: f.servicing_option ?? "special", event: "liquidation_lar", accepted_on: f.accepted_on, advances: f.advances });
  const applied = f.line ? applyReimbursementLine({ line: f.line, advances: f.advances, source: "fnma_liquidation_reimb", recovered_at: f.line.report_date }) : null;
  const matchedCents = applied?.match.matched_cents ?? 0n;
  const variance = applied ? applied.variance_cents : expectation.expected_cents;
  const allReimbursed = applied !== null && applied.remaining_outstanding_cents === 0n && applied.status === "matched";
  const officerDue = unrecoveredEscalationDue(f.accepted_on);
  const needsPackage = applied ? applied.status !== "matched" : expectation.expected_by !== null && f.today > expectation.expected_by;
  const pkg = needsPackage ? irrPackage({ loan_id: "", exit_event: "liquidation_lar", exit_on: f.accepted_on, today: f.today,
    activity_periods: f.advances.filter((a) => kindOf(a) === "delinquency_pi").map((a) => ({ period: a.activity_period, drafted_cents: a.amount_cents, draft_id: a.drafted_at ? `draft:${a.drafted_at}` : null })),
    lar: { id: f.lar.id, ack_id: f.lar.ack_id, action_code: f.lar.action_code, accepted_on: f.accepted_on }, report_lines: f.line ? [f.line.report_line_ref] : [],
    expected_cents: expectation.expected_cents, matched_cents: matchedCents, variance_cents: variance, expected_by: expectation.expected_by }) : null;
  return { expectation, applied, variance_cents: variance,
    timers: { SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES: { due: expectation.expected_by, satisfied: allReimbursed }, SM_DELADV_UNRECOVERED_60: { due: officerDue, satisfied: allReimbursed } },
    irr_package: pkg, sda_exit: { status: "exited", reason: "liquidation", exited_on: f.accepted_on } };
}
export interface DeferralReimbursement {
  readonly expectation: Expectation; readonly cycle: { readonly activity_period: string; readonly draft_date: PlainDate; readonly bd3_notification: PlainDate }; readonly applied: ReimbursementLineResult | null;
  readonly matched_on_cycle: boolean; readonly timer: { code: "FNMA_IRM_PD_ADV_REIMB_4BD"; due: PlainDate | null; satisfied: boolean }; readonly sda_exit: { status: "exited"; reason: "deferral"; exited_on: PlainDate } | null;
}
/** Rule 3 / T4: deferral accepted in Fannie Mae's investor reporting system → the outstanding advances within 4 `fannie_et` BD (IRM p. 35), matched on the draft cycle that day falls in. */
export function deferralReimbursement(f: { readonly accepted_on: PlainDate; readonly advances: readonly AdvanceRow[]; readonly line: ReportLine | null; readonly sda_status?: SdaStatus }): DeferralReimbursement {
  const expectation = recoveryExpectation({ remittance_type: "SS", servicing_option: "special", event: "deferral_acceptance", accepted_on: f.accepted_on, advances: f.advances });
  const by = expectation.expected_by ?? f.accepted_on;
  const draft = calendarDraftDate(by, 18);
  const cycle = { activity_period: period(by), draft_date: draft, bd3_notification: fannieBusinessDay(by, 3) };
  const applied = f.line ? applyReimbursementLine({ line: f.line, advances: f.advances, source: "fnma_deferral_reimb", recovered_at: f.line.report_date }) : null;
  const onCycle = applied !== null && applied.status === "matched" && period(f.line!.report_date) === cycle.activity_period && f.line!.report_date <= draft;
  return { expectation, cycle, applied, matched_on_cycle: onCycle, timer: { code: "FNMA_IRM_PD_ADV_REIMB_4BD", due: expectation.expected_by, satisfied: applied !== null && applied.status === "matched" && f.line!.report_date <= by },
    sda_exit: f.sda_status === "active" || f.sda_status === "predicted" ? { status: "exited", reason: "deferral", exited_on: f.accepted_on } : null };
}

// ---------------------------------------------------------------------------
// T5 — reclass purchase advice: reimbursement matched on the PA; `sda_status` exits with reason `reclass`
// ---------------------------------------------------------------------------
export interface ReclassInput { readonly purchase_advice_id: string; readonly purchase_advice_date: PlainDate; readonly pa_reimbursement_cents: Cents; readonly advances: readonly AdvanceRow[]; readonly sda_status: SdaStatus; readonly remittance_type?: RemittanceType; readonly servicing_option?: ServicingOption; }
export interface ReclassResult {
  readonly expectation: Expectation; readonly match: MatchResult; readonly recoveries: readonly RecoveryRow[]; readonly advances_after: readonly AdvanceRow[];
  readonly sda_exit: { status: "exited"; reason: "reclass"; exited_on: PlainDate } | null; readonly timer: { code: "FNMA_A1306_RECLASS_REIMB_PA"; due: PlainDate; satisfied: boolean }; readonly ledger: readonly LedgerLine[];
}
/** Rule 3 (reclass → full amount on the purchase advice, A1-3-06 / IRM p. 37) and 5.4: the reclass to A/A ends Stop Delinquency Advance. */
export function reclassReimbursement(f: ReclassInput): ReclassResult {
  const expectation = recoveryExpectation({ remittance_type: f.remittance_type ?? "SS", servicing_option: f.servicing_option ?? "special", event: "reclass_pa", accepted_on: f.purchase_advice_date, advances: f.advances });
  const applied = applyReimbursementLine({ line: { report_line_ref: `purchase_advice:${f.purchase_advice_id}`, amount_cents: f.pa_reimbursement_cents }, advances: f.advances, source: "fnma_reclass_pa", recovered_at: f.purchase_advice_date });
  return {
    expectation, match: applied.match, recoveries: applied.recoveries.map(({ crs_code: _c, ...r }) => r), advances_after: applied.advances_after,
    sda_exit: f.sda_status === "active" || f.sda_status === "predicted" ? { status: "exited", reason: "reclass", exited_on: f.purchase_advice_date } : null,
    timer: { code: "FNMA_A1306_RECLASS_REIMB_PA", due: f.purchase_advice_date, satisfied: applied.status === "matched" },
    ledger: applied.ledger?.lines ?? [],
  };
}

// ---------------------------------------------------------------------------
// T8 — payoff / repurchase: Fannie Mae drafts its SDA receivable from the proceeds; ours is recovered from the delinquent P&I
// ---------------------------------------------------------------------------
export interface PayoffRecoveryInput { readonly kind: "payoff" | "repurchase"; readonly posted_on: PlainDate; readonly posting_id: string; readonly fnma_sda_receivable_cents: Cents; readonly delinquent_pi_collected_cents: Cents; readonly advances: readonly AdvanceRow[]; readonly fnma_share_cents?: Cents; }
export interface PayoffRecoveryResult {
  /** The 16.2 payoff remittance (advanceSpecialRemittance): Fannie Mae's receivable rides as the CRS 352 special remittance, outside the 001 payoff draft and never netted against ours. */
  readonly remittance: { readonly fnma_sda_receivable_cents: Cents; readonly included: boolean; readonly crs_code: "352"; readonly crs_352_cents: Cents; readonly crs_001_cents: Cents; readonly special_remit_by: PlainDate | null; readonly excluded_from_001: boolean; readonly memo: "fnma_pi_receivable_sda"; readonly drafted_by: "fannie_mae" };
  readonly recoveries: readonly RecoveryRow[]; readonly advances_after: readonly AdvanceRow[]; readonly recovered_cents: Cents; readonly shortfall_cents: Cents; readonly netted: false;
  readonly expectation: null; readonly timer: { code: "SM_PAYOFF_ADV_RECOVERY_SAME_DAY"; due: PlainDate }; readonly ledger: readonly LedgerLine[];
}
/**
 * Rule 3 (payoff/repurchase): the 16.2 payoff calculator carries Fannie Mae's SDA receivable as the special remittance (F-1-09/F-1-20:
 * advances repaid by special remittance, never inside the payoff draft); the borrower's/seller's delinquent P&I recovers Fannie Mae
 * first (5.4 rule 4), then our advances FIFO; no reimbursement expectation is created and the two receivables are never netted.
 */
export function payoffAdvanceRecovery(f: PayoffRecoveryInput): PayoffRecoveryResult {
  const available0 = f.delinquent_pi_collected_cents - f.fnma_sda_receivable_cents;
  let available = available0 > 0n ? available0 : 0n;
  const source: RecoverySource = f.kind === "payoff" ? "payoff_proceeds" : "repurchase_price";
  const recoveries: RecoveryRow[] = []; const ids = new Set<string>();
  for (const a of openAdvances(f.advances)) { if (available < a.amount_cents) break; available -= a.amount_cents; ids.add(a.id); recoveries.push({ advance_id: a.id, source, amount_cents: a.amount_cents, recovered_at: f.posted_on, report_line_ref: `${f.kind}:${f.posting_id}` }); }
  const recovered = recoveries.reduce((s, r) => s + r.amount_cents, 0n);
  const remit = advanceSpecialRemittance({ payoff_on: f.posted_on, fnma_share_cents: f.fnma_share_cents ?? 0n, fnma_advance_repay_cents: f.fnma_sda_receivable_cents, servicer_advance_recovered_cents: recovered });
  return {
    remittance: { fnma_sda_receivable_cents: f.fnma_sda_receivable_cents, included: remit.crs_352_cents === f.fnma_sda_receivable_cents, crs_code: "352", crs_352_cents: remit.crs_352_cents, crs_001_cents: remit.crs_001_cents, special_remit_by: remit.special_remit_by, excluded_from_001: remit.excluded_from_001, memo: "fnma_pi_receivable_sda", drafted_by: "fannie_mae" },
    recoveries, advances_after: withStatus(f.advances, ids, "recovered_from_borrower"), recovered_cents: recovered, shortfall_cents: outstandingCents(f.advances) - recovered, netted: false,
    expectation: null, timer: { code: "SM_PAYOFF_ADV_RECOVERY_SAME_DAY", due: f.posted_on }, ledger: recovered > 0n ? recoveryLedger(recovered, "custodial").lines : [],
  };
}

// ---------------------------------------------------------------------------
// T9 / rule 8 — elimination or rescission after reimbursement reverses the position
// ---------------------------------------------------------------------------
export interface RescissionInput { readonly approved_on: PlainDate; readonly approved_at_ms?: number | null; readonly recoveries: readonly RecoveryRow[]; readonly advances: readonly AdvanceRow[]; readonly sda_status: SdaStatus; }
export interface RescissionResult {
  readonly reversing_recoveries: readonly RecoveryRow[]; readonly expected_debit_cents: Cents; readonly expected_report: "remittance_detail_cash_adjustments"; readonly expected_report_period: string; readonly expected_on: PlainDate;
  readonly position_status: "sda_active" | "accruing"; readonly advances_after: readonly AdvanceRow[]; readonly expectation: { expected_recovery_event: null; expected_by: null }; readonly ledger: readonly LedgerLine[]; readonly reintegrate_by_ms: number | null;
}
/**
 * Rule 8: a rescission (15.1) after reimbursement puts the loan back in `sda_active` (Fannie Mae's Stop Advance status still stands, 5.4)
 * or `accruing` (no SDA yet); Fannie Mae's clawback appears as a debit adjustment on the Cash Adjustments report for the activity period
 * of the approval (available at the following month's BD3 notification), matched to a reversing `advance_recoveries` row per reimbursed advance.
 */
export function rescissionReversal(f: RescissionInput): RescissionResult {
  const reversing = f.recoveries.filter((r) => r.source !== "reversal" && r.source !== "write_off").map((r) => ({ advance_id: r.advance_id, source: "reversal" as const, amount_cents: -r.amount_cents, recovered_at: f.approved_on, report_line_ref: `reverses:${r.report_line_ref}`, notes: "rescission approved; Fannie Mae clawback expected on the next Cash Adjustments report" }));
  const debit = reversing.reduce((s, r) => s - r.amount_cents, 0n);
  const ids = new Set(reversing.map((r) => r.advance_id));
  return {
    reversing_recoveries: reversing, expected_debit_cents: debit, expected_report: "remittance_detail_cash_adjustments", expected_report_period: period(f.approved_on), expected_on: fannieBusinessDay(nextMonth(f.approved_on), 3),
    position_status: f.sda_status === "active" || f.sda_status === "predicted" ? "sda_active" : "accruing", advances_after: withStatus(f.advances, ids, "outstanding"), expectation: { expected_recovery_event: null, expected_by: null },
    ledger: debit > 0n ? reversalLedger(debit) : [],
    reintegrate_by_ms: rescissionClocks(f.approved_on, f.approved_at_ms ?? null).reactivate_by_ms,
  };
}

// ---------------------------------------------------------------------------
// Rule 4 — matching inputs (Cash Adjustments lines → `draft_adjustments`) and the ledger
// ---------------------------------------------------------------------------
/** `draft_adjustments.type` values (0006 + 0037): the two the spec adds, the 5.4 recovery credit and the rule-8 clawback debit. */
export type AdjustmentType = "delinquency_advance_reimbursement" | "sa_interest_reimbursement" | "sda_recovery_credit" | "debit_adjustment" | "other";
export interface CashAdjustmentLine { readonly row: number; readonly loan_id: string; readonly description: string; readonly amount_cents: Cents; readonly crs_code?: string | null; }
export interface DraftAdjustment { readonly report_line_ref: string; readonly report_id: string; readonly row: number; readonly loan_id: string; readonly activity_period: string; readonly type: AdjustmentType; readonly amount_cents: Cents; readonly crs_code: string | null; readonly description: string; }
/** FNV-1a over the row's fields — the report-line reference is report id + row + hash (audit and evidence). */
export function rowHash(parts: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of parts.join("")) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
export function classifyAdjustment(description: string, amountCents: Cents, crsCode: string | null): AdjustmentType {
  if (amountCents < 0n) return "debit_adjustment";
  if (crsCode === "208" || /delinq(?:uency)?[\s-]*adv(?:ance)?|p&i\s+advance\s+reimb/i.test(description)) return "delinquency_advance_reimbursement";
  if (/(?:fourth|4th)[\s-]*month|s\/a\s+interest/i.test(description)) return "sa_interest_reimbursement";
  if (/stop\s+(?:delinquency\s+)?advance\s+recovery|sda\s+recovery/i.test(description)) return "sda_recovery_credit";
  return "other";
}
/** Remittance Detail – Cash Adjustments / draft-notification credits parsed into `draft_adjustments` rows with the new `type` values. */
export function parseCashAdjustmentLines(f: { readonly report_id: string; readonly activity_period: string; readonly lines: readonly CashAdjustmentLine[] }): DraftAdjustment[] {
  return f.lines.map((l) => {
    const crs = l.crs_code ?? null;
    return { report_line_ref: `${f.report_id}#${l.row}:${rowHash([l.loan_id, l.description, String(l.amount_cents), crs ?? ""])}`, report_id: f.report_id, row: l.row, loan_id: l.loan_id, activity_period: f.activity_period, type: classifyAdjustment(l.description, l.amount_cents, crs), amount_cents: l.amount_cents, crs_code: crs, description: l.description };
  });
}
export interface RecoveryLedger {
  readonly lines: readonly LedgerLine[]; readonly rule_ref: "15.4 rule 4"; readonly corporate_transfer: { readonly scheduled: boolean; readonly amount_cents: Cents; readonly from: "custodial_pi_cash" | "corporate_cash"; readonly to: "partner_advance_line" };
  /** The credit as Fannie Mae reported it (the cash debit). */ readonly received_cents: Cents; /** Matched advances the credit did not cover (≤ tolerance) — still in the receivable. */ readonly residual_cents: Cents; /** Credit above the matched advances — Cr `fnma_payable`, never kept. */ readonly excess_cents: Cents;
}
/**
 * A matched line posts Dr `custodial_pi_cash` (or corporate cash where Fannie Mae disburses separately) for the amount actually
 * credited, Cr `servicer_advance_receivable` for the advances that cash relieves, then the corporate transfer returns the funds to the
 * partner's advance line. Rule 9: Fannie Mae's amount is never recomputed — a credit a few cents short leaves the residual in the
 * receivable (the position's variance), a credit above the matched advances is a payable to Fannie Mae.
 */
export function recoveryLedger(matchedCents: Cents, disbursedTo: "custodial" | "corporate", receivedCents: Cents = matchedCents): RecoveryLedger {
  const cash = disbursedTo === "custodial" ? "custodial_pi_cash" : "corporate_cash";
  const relieved = receivedCents < matchedCents ? receivedCents : matchedCents;
  const residual = matchedCents - relieved;
  const excess = receivedCents > matchedCents ? receivedCents - matchedCents : 0n;
  const lines: LedgerLine[] = [];
  if (receivedCents > 0n) lines.push({ account: cash, side: "Dr", amount_cents: receivedCents });
  if (relieved > 0n) lines.push({ account: "servicer_advance_receivable", side: "Cr", amount_cents: relieved });
  if (excess > 0n) lines.push({ account: "fnma_payable", side: "Cr", amount_cents: excess });
  return { lines, rule_ref: "15.4 rule 4", corporate_transfer: { scheduled: relieved > 0n, amount_cents: relieved, from: cash, to: "partner_advance_line" }, received_cents: receivedCents, residual_cents: residual, excess_cents: excess };
}
/** Rule 8: the clawback re-establishes the receivable — Dr `servicer_advance_receivable` Cr `custodial_pi_cash`. */
export function reversalLedger(amountCents: Cents): readonly LedgerLine[] { return [{ account: "servicer_advance_receivable", side: "Dr", amount_cents: amountCents }, { account: "custodial_pi_cash", side: "Cr", amount_cents: amountCents }]; }
/**
 * The 15.4 ledger names on the kernel chart (src/kernel/ledger/ledger.ts): `servicer_advance_receivable` is the corporate
 * `advance_receivable` account (its per-custodial-account subledger is the `servicer_advance_receivable` table, 0027) — the memo
 * carries the spec's name so the posted line is the tested `LedgerLine`.
 */
export function kernelAccount(account: LedgerLine["account"], custodialAccountId: string): AccountRef {
  switch (account) {
    case "custodial_pi_cash": return { scope: "custodial", custodialAccountId, account: "custodial_pi_cash" };
    case "corporate_cash": return { scope: "corporate", account: "corporate_cash" };
    case "fnma_payable": return { scope: "corporate", account: "fnma_payable" };
    case "servicer_advance_receivable": return { scope: "corporate", account: "advance_receivable" };
  }
}
export function entryLines(lines: readonly LedgerLine[], custodialAccountId: string, ruleRef: string): LineInput[] {
  return lines.map((l) => ({ account: kernelAccount(l.account, custodialAccountId), amountCents: l.side === "Dr" ? l.amount_cents : -l.amount_cents, ruleRef, ...(l.account === "servicer_advance_receivable" ? { memo: "servicer_advance_receivable" } : {}) }));
}
/** Edge case: Fannie Mae reimburses more than outstanding (duplicate credit) → a payable, never kept; Investor Reporting Representative notified within 2 BD. */
export function duplicateCredit(f: { readonly credit_cents: Cents; readonly advances: readonly AdvanceRow[]; readonly received_on: PlainDate; readonly report_line_ref: string }): { payable_cents: Cents; ledger: readonly LedgerLine[]; notify_irr_by: PlainDate; keep: false; report_line_ref: string; match_status: MatchResult["status"] } {
  const m = matchReimbursement(openAdvances(f.advances), f.credit_cents);
  const excess = m.status === "duplicate" ? f.credit_cents : f.credit_cents - m.matched_cents > 0n ? f.credit_cents - m.matched_cents : 0n;
  return { payable_cents: excess, ledger: excess > 0n ? [{ account: "custodial_pi_cash", side: "Dr", amount_cents: excess }, { account: "fnma_payable", side: "Cr", amount_cents: excess }] : [], notify_irr_by: duplicateCreditNoticeDue(f.received_on), keep: false, report_line_ref: f.report_line_ref, match_status: m.status };
}

// ---------------------------------------------------------------------------
// Rule 4 — variance package for the Investor Reporting Representative; `officer` at 60 days
// ---------------------------------------------------------------------------
export interface IrrPackageInput {
  readonly loan_id: string; readonly exit_event: ExpectedRecoveryEvent; readonly exit_on: PlainDate; readonly today: PlainDate;
  readonly activity_periods: readonly { period: string; drafted_cents: Cents; draft_id: string | null }[]; readonly lar: { id: string; ack_id: string | null; action_code: string; accepted_on: PlainDate } | null;
  readonly report_lines: readonly string[]; readonly expected_cents: Cents; readonly matched_cents: Cents; readonly variance_cents: Cents; readonly expected_by: PlainDate | null;
}
export interface IrrPackage {
  readonly recipient: "investor_reporting_representative"; readonly channel: "email_phone_f402"; readonly irt_is_the_venue: false;
  readonly contents: { loan_id: string; exit_event: ExpectedRecoveryEvent; exit_on: PlainDate; activity_periods: IrrPackageInput["activity_periods"]; drafted_total_cents: Cents; lar: IrrPackageInput["lar"]; report_lines: readonly string[]; expected_cents: Cents; matched_cents: Cents; variance_cents: Cents; expected_by: PlainDate | null; variance_kind: "amount" | "timing" | "none" };
  readonly officer_due: PlainDate; readonly escalation: { kind: "human_agent" | "officer"; severity: "sev2" | "sev1"; reason: string }; readonly partner_monthly_report: boolean;
}
/** Amount variance beyond tolerance or timing beyond the expectation window → package (loan, periods, drafted amounts, LAR ids/acks, report lines); unresolved 60 days after the exit → `officer` (write-off authority) and the partner's monthly report. */
export function irrPackage(f: IrrPackageInput): IrrPackage {
  const officerDue = unrecoveredEscalationDue(f.exit_on);
  const atOfficer = f.today >= officerDue;
  const amount = abs(f.variance_cents) > MATCH_TOLERANCE; const timing = !amount && f.expected_by !== null && f.today > f.expected_by && f.matched_cents < f.expected_cents;
  return {
    recipient: "investor_reporting_representative", channel: "email_phone_f402", irt_is_the_venue: false,
    contents: { loan_id: f.loan_id, exit_event: f.exit_event, exit_on: f.exit_on, activity_periods: f.activity_periods, drafted_total_cents: f.activity_periods.reduce((s, p) => s + p.drafted_cents, 0n), lar: f.lar, report_lines: f.report_lines, expected_cents: f.expected_cents, matched_cents: f.matched_cents, variance_cents: f.variance_cents, expected_by: f.expected_by, variance_kind: amount ? "amount" : timing ? "timing" : "none" },
    officer_due: officerDue,
    escalation: atOfficer ? { kind: "officer", severity: "sev1", reason: `delinquency advances unrecovered ${daysBetween(f.exit_on, f.today)} days after the ${f.exit_event} exit (SM_DELADV_UNRECOVERED_60 due ${officerDue})` } : { kind: "human_agent", severity: "sev2", reason: `${amount ? "amount" : "timing"} variance ${f.variance_cents} cents on the ${f.exit_event} reimbursement — Investor Reporting Representative package` },
    partner_monthly_report: atOfficer,
  };
}
/** Guardrail: never write off without `officer` approval; write-offs above $500 per loan are the officer's own decision task. */
export const WRITE_OFF_OFFICER_TASK_THRESHOLD_CENTS: Cents = 50_000n;
export function writeOffDecision(f: { readonly amount_cents: Cents; readonly approved_by_role: string | null; readonly exit_on: PlainDate; readonly today: PlainDate; readonly advance_ids: readonly string[]; readonly report_line_ref?: string | null }): { allowed: boolean; refusal: string | null; requires_officer: true; officer_task: boolean; recoveries: readonly RecoveryRow[]; timer_satisfied: "SM_DELADV_UNRECOVERED_60" | null } {
  const officer = f.approved_by_role === "officer";
  const task = f.amount_cents > WRITE_OFF_OFFICER_TASK_THRESHOLD_CENTS;
  if (!officer) return { allowed: false, refusal: "15.4 guardrail: never write off without `officer` approval", requires_officer: true, officer_task: task, recoveries: [], timer_satisfied: null };
  // the officer's approved figure is booked to the cent (rule 9): an even split, the remainder cents on the earliest rows
  const n = BigInt(f.advance_ids.length); const per = n ? f.amount_cents / n : 0n; const rem = n ? f.amount_cents % n : 0n;
  return { allowed: true, refusal: null, requires_officer: true, officer_task: task, recoveries: f.advance_ids.map((id, idx) => ({ advance_id: id, source: "write_off" as const, amount_cents: per + (BigInt(idx) < rem ? 1n : 0n), recovered_at: f.today, report_line_ref: f.report_line_ref ?? `write_off_approval:${f.exit_on}` })), timer_satisfied: "SM_DELADV_UNRECOVERED_60" };
}

// ---------------------------------------------------------------------------
// Rule 5 — no claims, no interest: P&I advances never leak into the 571 (15.2) or the MI claim (15.3) — T1, T10
// ---------------------------------------------------------------------------
export const PI_ADVANCE_KINDS: ReadonlySet<string> = new Set(["delinquency_pi", "delinquency_interest_sa"]);
export interface PiLeakInput {
  readonly advances: readonly AdvanceRow[]; readonly claim_571_lines: readonly ClaimLine[]; readonly claim_context: ClaimContext;
  /** 15.3 itemized MI-claim advances (`ClaimAdvance` shape: advance_id, kind, amount). */
  readonly mi_claim_advances: readonly { readonly advance_id: string; readonly kind: string; readonly amount_cents: Cents }[];
}
export interface PiLeakReport {
  readonly rule: "15.4 rule 5"; readonly clean: boolean;
  readonly claim_571: { readonly rejected: readonly { index: number; kind: string; reason: "pi_advances_not_claimable" }[]; readonly accepted: number };
  readonly mi_claim: { readonly leaks: readonly { advance_id: string; reason: "pi_advances_not_claimable" }[]; readonly accepted: number; readonly basis: "MI claims cover note-rate interest and expenses, not investor advances (15.3)" };
}
/** The 15.2 validator rejects `delinquency_pi`/`delinquency_interest_sa` lines (`pi_advances_not_claimable`); an MI-claim advance that is one of our P&I advances is a leak. */
export function piAdvanceLeaks(f: PiLeakInput): PiLeakReport {
  const piIds = new Set(f.advances.filter((a) => PI_ADVANCE_KINDS.has(kindOf(a))).map((a) => a.id));
  const rejected = f.claim_571_lines.map((l, index) => ({ index, kind: l.kind, messages: validateLine(l, f.claim_context).messages })).filter((r) => r.messages.includes("pi_advances_not_claimable")).map(({ index, kind }) => ({ index, kind, reason: "pi_advances_not_claimable" as const }));
  const leaks = f.mi_claim_advances.filter((a) => piIds.has(a.advance_id) || PI_ADVANCE_KINDS.has(a.kind)).map((a) => ({ advance_id: a.advance_id, reason: "pi_advances_not_claimable" as const }));
  return { rule: "15.4 rule 5", clean: rejected.length === 0 && leaks.length === 0,
    claim_571: { rejected, accepted: f.claim_571_lines.length - rejected.length },
    mi_claim: { leaks, accepted: f.mi_claim_advances.length - leaks.length, basis: "MI claims cover note-rate interest and expenses, not investor advances (15.3)" } };
}

// ---------------------------------------------------------------------------
// Rule 1 / T7 — E-3.5-01: a regular servicing option MBS loan leaves the pool before the foreclosure completes
// ---------------------------------------------------------------------------
export interface SalePackageGate {
  readonly timer: "FNMA_E3501_MBS_REMOVAL_BEFORE_FCL"; readonly kind: "not_before_gate"; readonly blocked: boolean; readonly release_allowed: boolean; readonly remove_by: PlainDate;
  readonly expected_recovery_event: "pre_fcl_removal" | null; readonly escalation: { kind: "officer"; severity: "sev2"; reason: string } | null; readonly reason: string | null;
}
/** The gate closes the sale-package release (13.x) until the repurchase/reclass is accepted; while closed an `officer` escalation is open (removal decisions with 5.6). Unknown servicing option fails closed. */
export function salePackageReleaseGate(f: { readonly servicing_option: ServicingOption | null; readonly repurchase_or_reclass_accepted: boolean; readonly sale_on: PlainDate }): SalePackageGate {
  const removeBy = addDays(f.sale_on, -1);
  const unknown = f.servicing_option === null;
  const g = unknown ? { blocked: true, escalate: "officer" as const } : mbsRemovalGate(f.servicing_option!, f.repurchase_or_reclass_accepted);
  const reason = g.blocked ? (unknown ? "servicing_option not boarded (1.1) — E-3.5-01 cannot be evaluated; sale-package release blocked" : `E-3.5-01: regular servicing option MBS loan not repurchased/reclassified before the ${f.sale_on} sale — sale-package release blocked; remove from the pool by ${removeBy}`) : null;
  return { timer: "FNMA_E3501_MBS_REMOVAL_BEFORE_FCL", kind: "not_before_gate", blocked: g.blocked, release_allowed: !g.blocked, remove_by: removeBy,
    expected_recovery_event: f.servicing_option === "regular_mbs" ? "pre_fcl_removal" : null,
    escalation: g.blocked ? { kind: "officer", severity: "sev2", reason: reason! } : null, reason };
}

// ---------------------------------------------------------------------------
// Outputs — monthly unreimbursed-advance aging report (partner / FHFA-liquidity view)
// ---------------------------------------------------------------------------
export type AgingBucket = "not_exited" | "0-30" | "31-60" | "61-90" | "90+";
export interface AgingInput { readonly as_of: PlainDate; readonly positions: readonly { loan_id: string; exit_on: PlainDate | null; outstanding_cents: Cents; status: PositionStatus; expected_recovery_event: ExpectedRecoveryEvent | null }[]; }
export interface AgingRow { readonly loan_id: string; readonly outstanding_cents: Cents; readonly days_since_exit: number | null; readonly bucket: AgingBucket; readonly officer_flag: boolean; readonly status: PositionStatus; readonly expected_recovery_event: ExpectedRecoveryEvent | null; }
export function agingBucket(days: number | null): AgingBucket { return days === null ? "not_exited" : days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+"; }
export function agingReport(f: AgingInput): { as_of: PlainDate; cadence: "monthly"; recipient: "partner"; rows: readonly AgingRow[]; totals: { outstanding_cents: Cents; by_bucket: Record<AgingBucket, Cents>; loans: number; officer_flagged: number } } {
  const rows = f.positions.filter((p) => p.outstanding_cents > 0n).map((p) => { const days = p.exit_on ? daysBetween(p.exit_on, f.as_of) : null; return { loan_id: p.loan_id, outstanding_cents: p.outstanding_cents, days_since_exit: days, bucket: agingBucket(days), officer_flag: days !== null && days >= 60, status: p.status, expected_recovery_event: p.expected_recovery_event }; });
  const by: Record<AgingBucket, Cents> = { not_exited: 0n, "0-30": 0n, "31-60": 0n, "61-90": 0n, "90+": 0n };
  for (const r of rows) by[r.bucket] += r.outstanding_cents;
  return { as_of: f.as_of, cadence: "monthly", recipient: "partner", rows, totals: { outstanding_cents: rows.reduce((s, r) => s + r.outstanding_cents, 0n), by_bucket: by, loans: rows.length, officer_flagged: rows.filter((r) => r.officer_flag).length } };
}

// ---------------------------------------------------------------------------
// S/A portfolio — month-4 negative-interest LAR 96 on the 5.1 period clock (T6)
// ---------------------------------------------------------------------------
export interface SaMonth4Input { readonly period_end: PlainDate; readonly monthly_interest_cents: Cents; readonly months_advanced: number; readonly sa_advances?: readonly AdvanceRow[]; readonly lar_ack_id?: string | null; }
export interface SaMonth4Recovery {
  readonly lar: "96"; readonly interest_cents: Cents; readonly report_period: string; readonly due_bd2: PlainDate; readonly timer: "FNMA_IRM_SA_MONTH4_NEG_INTEREST";
  readonly advanced_before_cents: Cents; readonly recovered_cents: Cents; readonly recoveries: readonly RecoveryRow[]; readonly advances_after: readonly AdvanceRow[]; readonly position_after: { sa_interest_advanced_cents: Cents };
}
/**
 * IRM p. 26: the servicer recovers its months 1–3 interest advances by reporting a negative interest remittance on the Transaction
 * Type 96 LAR for the month the loan becomes four months delinquent. The `delinquency_interest_sa` rows are recovered FIFO on
 * acceptance (source `sa_negative_interest_lar`) and the position's `sa_interest_advanced` falls by the amount recovered.
 */
export function saMonth4Recovery(f: SaMonth4Input): SaMonth4Recovery {
  const rows = f.sa_advances ?? [];
  const advanced = rows.length ? outstandingCents(rows, "delinquency_interest_sa") : f.monthly_interest_cents * BigInt(f.months_advanced);
  const l = saRecoveryLar(f.monthly_interest_cents, f.months_advanced);
  const claimed = -l.interest_cents;
  const recoverable = claimed < advanced ? claimed : advanced;
  const ref = `lar96:${period(f.period_end)}${f.lar_ack_id ? `:${f.lar_ack_id}` : ""}`;
  const m = rows.length ? matchReimbursement(openAdvances(rows, "delinquency_interest_sa"), recoverable) : null;
  const ids = new Set(m?.matched ?? []);
  const recoveries = rows.filter((a) => ids.has(a.id)).map((a) => ({ advance_id: a.id, source: "sa_negative_interest_lar" as const, amount_cents: a.amount_cents, recovered_at: f.period_end, report_line_ref: ref }));
  const recovered = rows.length ? recoveries.reduce((s, r) => s + r.amount_cents, 0n) : recoverable;
  const after = withStatus(rows, ids, "reimbursed_by_fnma");
  return { lar: l.lar, interest_cents: -recoverable, report_period: period(f.period_end), due_bd2: fannieBusinessDay(nextMonth(f.period_end), 2), timer: "FNMA_IRM_SA_MONTH4_NEG_INTEREST",
    advanced_before_cents: advanced, recovered_cents: recovered, recoveries, advances_after: after, position_after: { sa_interest_advanced_cents: rows.length ? outstandingCents(after, "delinquency_interest_sa") : advanced - recovered } };
}
