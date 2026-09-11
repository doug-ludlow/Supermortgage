/**
 * §26.3 Funding authorization and disbursement — pure rule functions, one per rule / T-id, plus the event emitters
 * the 26.3 timers arm on and the balanced ledger set `loan.funded` links to.
 * spec/sections/26-closing-execution-documents-eclosing-ron-funding-and-post-cl/26-3-funding-authorization-and-disbursement-funding-conditions-we.md
 *
 *   computeDates                   rescission expiry (25.3 rescissionExpiry) → first Fedwire day (25.3 fundingReleaseDate) → wet/dry mode; TX later-of (26.1)
 *   computePerDiem                 `365_rounded_per_diem` (30.2 perDiem365Rounded / prepaidInterest): per diem rounded once, × days
 *   decideInterestMode             rule 3: prepaid / interest_credit (day(D) ≤ 7, borrower-elected or note consistency) / none; C2-2-01 two-month gate; LPI; maturity
 *   buildFundingWorksheet          rule 4: gross − lender-retained + lender credits (+ interest credit) = net wire
 *   reconcileToSettlementStatement rule 4: variance_cents = net_wire − agent_requested; 0 (or ≤ $1.00 explained) → FC_FIGURES_RECONCILED
 *   fundingLedgerLines             rule 5: Dr warehouse_advance_receivable / Dr partner_haircut_reserve / Cr sm_funding_cash (+ partner mirror for 27.2)
 *   evaluateFundingConditions      rule 1: the 31 FC_ codes resolved from platform state; waivers only for the three waivable items
 *   authorizeFunding               gates re-asserted at the boundary: 25.3 assertDisburseAllowed, 23.3 PTF, 22.4, 22.6 fraud hold, 23.4 QM/HOEPA, 31.1 legal form
 *   scoreBecIndicators             FIN-2016-A003 red flags; any hit → funding.held{bec_indicator}; two → officer + fraud case; no same-day changes
 *   prepareWire / runFourEyesChecks / releaseWire (funding_approver ≠ every editor) / acceptWire / confirmAgentReceipt / confirmDisbursement → loan.funded
 *   resyncDates                    SM_O73_DATE_RESYNC: recompute per-diem, mode, gates; re-test 24.5 hazard and 24.4 payoff; ask 25.2 about a corrected CD
 *   cancelFunding / openUnwind     rule 10: unwind steps by funds position; money steps after disbursement need `officer`; 24.2 recordNotConsummated
 *
 * Every event carries `applicationId` (origination context — src/kernel/timers/engine.ts isOriginationContext) and, for the
 * hour/minute clocks, `occurredAt` = the instant the spec anchors on (released_at, accepted_at, prepared_at).
 * Upstream events consumed (never re-emitted): `closing.scheduled` / `closing.execution_review.passed` / `closing.audit_trail.received` /
 * `closing.consummated` (26.2), `rescission.period.started` / `rescission.period.expired` / `rescission.confirmed_not_rescinded` /
 * `rescission.exercised` (25.3; 26.1 emits `rescission.period.expired{basis=tx_50a6}`), `disclosure.cd.consummated` (25.2),
 * `warehouse.advance.approved` / `.rejected` (27.1), `debt_payoff.evidenced` / `.failed` (22.5), `recording.confirmed` (26.2).
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { centsToDecimal, ratePercent } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, addMonths, daysBetween, parts, ymd, plainDate as D } from "../../kernel/calendar/date.ts";
import { addBusinessDays, rollForward, creditor } from "../../kernel/calendar/business.ts";
import { toIso, wallClock, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { AccountRef, CorporateAccount, EntrySet, Ledger, LineInput } from "../../kernel/ledger/ledger.ts";
import { fedwire, isFedwireOpen, rescissionExpiry, fundingReleaseDate, assertDisburseAllowed, rescissionGate, type DisburseFacts, type RescissionExercise } from "../compliance-disclosures/ops-25-3.ts";
import { perDiem365Rounded, prepaidInterest, type LoanFundedPayload } from "../orig-boarding/ops-30-2.ts";
import { firstPaymentDate, maturityDate, DRY_FUNDING_STATES } from "./ops-26-1.ts";
import { wireVerificationGate, payoffGoodThroughGate } from "../property/ops-24-4.ts";
import { hazardEvidenceGate } from "../property/ops-24-5.ts";
import { recordNotConsummated } from "../property/ops-24-2.ts";
import { qmDeterminationGate, hoepaGate, type GateOutcome as QmGateOutcome } from "../underwriting/ops-23-4.ts";
import { assertNoFraudHold } from "../verification/ops-22-6.ts";
import { evaluateGate } from "../../app/evaluators.ts";

export const FUNDER: Actor = { kind: "agent", id: "funder" };
export const POLICY_VERSION_26_3 = "sm.funding.v1";
export const RULE_SETS_26_3 = { trid: "regz.trid.2017", rescission: "regz.rescission.1026_23", respa: "respa.1024_2b", fnma: "fnma.selling.2026-09-02", fedwire: "fedwire.calendar.2026", policy: POLICY_VERSION_26_3, warehouse: "sm.warehouse.v1" } as const;
export const PER_DIEM_CONVENTION = "365_rounded_per_diem";
export const INTEREST_CREDIT_WINDOW_DAYS = 7;
export const WIRE_CUTOFF_ET = "13:00";
export const WET_RELEASE_BY_LOCAL = "10:00";
export const RECONCILIATION_TOLERANCE_CENTS: Cents = 100n;
export const DEFAULT_ADVANCE_RATE_BPS = 9800;
export const LPI_DELIVERY_WINDOW_DAYS = 45;
export { DRY_FUNDING_STATES };

/** Inbound event types this process reacts to (26.2 / 25.3 / 25.2 / 27.1 / 22.5 own them; 26.3 never re-emits them). */
export const CONSUMED_EVENTS_26_3 = ["closing.scheduled", "closing.execution_review.passed", "closing.audit_trail.received", "closing.consummated", "rescission.period.started", "rescission.period.expired", "rescission.confirmed_not_rescinded", "rescission.waiver.accepted", "rescission.exercised", "disclosure.cd.consummated", "disclosure.cd.corrected", "warehouse.advance.approved", "warehouse.advance.rejected", "warehouse.advance.funded", "debt_payoff.evidenced", "debt_payoff.failed", "recording.confirmed", "wire.instructions.change_detected"] as const;
export type ConsumedEvent = (typeof CONSUMED_EVENTS_26_3)[number];
export const consumes = (type: string): type is ConsumedEvent => (CONSUMED_EVENTS_26_3 as readonly string[]).includes(type);

export class FundingRefused extends Error {
  readonly code: string; readonly citation: string;
  constructor(code: string, citation: string, msg: string) { super(`${code}: ${msg}`); this.name = "FundingRefused"; this.code = code; this.citation = citation; }
}
const need = (ok: boolean, msg: string): void => { if (!ok) throw new RangeError(msg); };
const later = (a: PlainDate, b: PlainDate): PlainDate => (b > a ? b : a);
const civil = (iso: string, tz: string): PlainDate => wallClock(Date.parse(iso), tz).date;
const abs = (c: Cents): Cents => (c < 0n ? -c : c);

type Emit = (events: EventStore, application_id: string, type: string, payload: Record<string, unknown>, at?: string | null, actor?: Actor, loan_id?: string | null) => DomainEvent;
const emit: Emit = (events, application_id, type, payload, at, actor = FUNDER, loan_id) =>
  events.append({ type, applicationId: application_id, ...(loan_id ? { loanId: loan_id } : {}), actor, ...(at ? { occurredAt: at } : {}), payload: { application_id, source: "origination", ...payload } });

// ============================================================ jurisdiction rules (rule 6; VA § 55.1-902 verified; others counsel matrix)
export interface FundingJurisdictionRule { readonly wet_dry: "wet" | "dry"; readonly wet_settlement_statute: string | null; readonly post_rescission_disbursement_days: number | null; readonly interest_before_disbursement_prohibited: boolean; readonly record_before_fund: boolean; readonly verified: boolean; }
export const FUNDING_JURISDICTION_RULES: Readonly<Record<string, FundingJurisdictionRule>> = {
  VA: { wet_dry: "wet", wet_settlement_statute: "Va. Code § 55.1-902 (Wet Settlement Act)", post_rescission_disbursement_days: 1, interest_before_disbursement_prohibited: true, record_before_fund: false, verified: true },
  OH: { wet_dry: "wet", wet_settlement_statute: "custom (00a-fed §16.3)", post_rescission_disbursement_days: null, interest_before_disbursement_prohibited: false, record_before_fund: false, verified: false },
  AZ: { wet_dry: "dry", wet_settlement_statute: null, post_rescission_disbursement_days: null, interest_before_disbursement_prohibited: false, record_before_fund: false, verified: false },
  TX: { wet_dry: "wet", wet_settlement_statute: "custom; TX 50(a)(6) rescission (26.1)", post_rescission_disbursement_days: null, interest_before_disbursement_prohibited: false, record_before_fund: false, verified: false },
};
export function fundingJurisdictionRule(state: string): FundingJurisdictionRule {
  return FUNDING_JURISDICTION_RULES[state] ?? { wet_dry: DRY_FUNDING_STATES.includes(state) ? "dry" : "wet", wet_settlement_statute: null, post_rescission_disbursement_days: null, interest_before_disbursement_prohibited: false, record_before_fund: false, verified: false };
}
export type FundingType = "wet" | "dry";
export type AuthorizationMode = "table_funds_then_authorize" | "review_then_fund";
export const decideFundingType = (state: string, override?: FundingType | null): { funding_type: FundingType; disbursement_authorization_mode: AuthorizationMode } => {
  const funding_type = override ?? fundingJurisdictionRule(state).wet_dry;
  return { funding_type, disbursement_authorization_mode: funding_type === "wet" ? "table_funds_then_authorize" : "review_then_fund" };
};

// ============================================================ rule: dates (`computeDates`) — rescission clock, Fedwire calendar, wet/dry readiness
export type TransactionType = "purchase" | "limited_cash_out" | "cash_out" | "rate_term" | "other";
export interface FundingCalendarInput {
  readonly application_id: string; readonly state: string; readonly transaction_type: TransactionType; readonly time_zone: string;
  readonly consummation_at: string | null; readonly rescindable: boolean;
  readonly waiver_accepted_on?: PlainDate | null; readonly hold_through_mail_allowance?: boolean;
  readonly tx_50a6_expires_on?: PlainDate | null; readonly review_completed_on?: PlainDate | null; readonly recording_confirmed_on?: PlainDate | null; readonly record_before_fund?: boolean;
  readonly closing_date?: PlainDate | null; readonly funding_type_override?: FundingType | null; readonly scheduled_funding_date?: PlainDate | null;
}
export interface FundingCalendar {
  readonly application_id: string; readonly funding_type: FundingType; readonly disbursement_authorization_mode: AuthorizationMode;
  readonly note_date: PlainDate | null; readonly consummation_at: string | null;
  readonly rescission_expires_on: PlainDate | null; readonly rescission_expires_at: string | null; readonly rescission_expires_display: string | null;
  readonly earliest_funding_date: PlainDate; readonly earliest_basis: readonly string[]; readonly scheduled_funding_date: PlainDate;
}
/** Fixture: consummation Fri Nov 6 → expiry midnight ending Tue Nov 10 (25.3) → Wed Nov 11 is a Reserve Bank holiday → earliest Thu Nov 12. */
export function computeDates(i: FundingCalendarInput): FundingCalendar {
  const mode = decideFundingType(i.state, i.funding_type_override ?? null);
  const note_date = i.consummation_at ? civil(i.consummation_at, i.time_zone) : i.closing_date ?? null;
  const basis: string[] = [];
  let earliest: PlainDate | null = null;
  let expiry: { expires_on: PlainDate; expires_at: string; expires_display: string } | null = null;
  if (i.rescindable && i.transaction_type !== "purchase") {
    if (!note_date) throw new RangeError("a rescindable transaction needs consummation_at before its funding calendar can be computed");
    expiry = rescissionExpiry(note_date, i.time_zone);
    const rel = fundingReleaseDate({ expires_on: expiry.expires_on, waiver_accepted_on: i.waiver_accepted_on ?? null, hold_through_mail_allowance: i.hold_through_mail_allowance ?? false, calendar: fedwire });
    earliest = rel.earliest_funding_date; basis.push(rel.basis);
    if (i.tx_50a6_expires_on) { const tx = rollForward(addDays(i.tx_50a6_expires_on, 1), fedwire); if (tx > earliest) { earliest = tx; basis.push("TX 50(a)(6) rescission expiry governs (later of the federal and Texas periods — 26.1)"); } }
  } else {
    earliest = rollForward(note_date ?? i.closing_date ?? i.scheduled_funding_date ?? D(new Date(0).toISOString().slice(0, 10)), fedwire); basis.push("not rescindable — funds on the closing/note date (next Fedwire day if closed)");
  }
  if (mode.funding_type === "dry") {
    if (i.review_completed_on) { if (i.review_completed_on > earliest) basis.push("executed-package review completion (26.2)"); earliest = later(earliest, i.review_completed_on); }
    if (i.record_before_fund && i.recording_confirmed_on) { if (i.recording_confirmed_on > earliest) basis.push("recording confirmation (record_before_fund elected)"); earliest = later(earliest, i.recording_confirmed_on); }
  }
  if (!isFedwireOpen(earliest)) { earliest = rollForward(earliest, fedwire); basis.push("rolled to the next Fedwire funds-transfer day"); }
  const scheduled = i.scheduled_funding_date && i.scheduled_funding_date >= earliest ? i.scheduled_funding_date : earliest;
  return { application_id: i.application_id, ...mode, note_date, consummation_at: i.consummation_at, rescission_expires_on: expiry?.expires_on ?? null, rescission_expires_at: expiry?.expires_at ?? null, rescission_expires_display: expiry?.expires_display ?? null, earliest_funding_date: earliest, earliest_basis: basis, scheduled_funding_date: scheduled };
}
/** FC_FEDWIRE_DAY: the release/value date is a Fedwire funds-transfer business day (weekends and Reserve Bank holidays fail). */
export const fedwireDayCheck = (date: PlainDate): { code: "FC_FEDWIRE_DAY"; status: "pass" | "fail"; note: string } =>
  isFedwireOpen(date) ? { code: "FC_FEDWIRE_DAY", status: "pass", note: `${date} is a Fedwire day` } : { code: "FC_FEDWIRE_DAY", status: "fail", note: `${date} is not a Fedwire funds-transfer day (Reserve Bank holiday or weekend); next ${rollForward(date, fedwire)}` };
/** `disburse` on a given date: the Fedwire day check AND 25.3's rescission gate (assertDisburseAllowed) — both asserted, the first failure reported. */
export function assertDisburseDate(date: PlainDate, rescission: DisburseFacts | null): { fedwire: ReturnType<typeof fedwireDayCheck>; rescission_gate: { open: boolean; reason?: string } } {
  const fw = fedwireDayCheck(date);
  const gate = rescission ? rescissionGate(rescission) : { open: true };
  if (fw.status === "fail") throw new FundingRefused("FC_FEDWIRE_DAY", "Fedwire Funds Service holiday schedule (frbservices.org)", fw.note);
  if (rescission) assertDisburseAllowed(rescission);
  return { fedwire: fw, rescission_gate: gate };
}
/** Va. Code § 55.1-902: disburse "within one business day after the expiration of the rescission period" — SM reads business day on the Fedwire calendar (§55.1-900 defines none). */
export const vaDisburseDeadline = (expires_on: PlainDate): PlainDate => addBusinessDays(expires_on, 1, fedwire);
export function vaDisbursementCompliance(expires_on: PlainDate, released_on: PlainDate | null): { deadline: PlainDate; compliant: boolean; statutory_exposure: string | null } {
  const deadline = vaDisburseDeadline(expires_on);
  const compliant = !!released_on && released_on <= deadline;
  return { deadline, compliant, statutory_exposure: compliant ? null : `Va. Code § 55.1-902: funds not disbursed to the settlement agent by ${deadline} (rescission expired ${expires_on}); released ${released_on ?? "not yet"}` };
}

// ============================================================ rule 2: per-diem interest (`computePerDiem`, convention 365_rounded_per_diem)
export interface PerDiemResult {
  readonly convention: typeof PER_DIEM_CONVENTION; readonly per_diem_basis: 365; readonly annual_interest_cents: Cents; readonly per_diem_cents: Cents;
  readonly prepaid_days: number; readonly prepaid_interest_cents: Cents; readonly per_diem_interest_cents: Cents; readonly interest_paid_through_date: PlainDate;
  /** exact per-diem × days, rounded once — computed for the reconciliation note only; never placed on an artifact. */
  readonly unrounded_product_cents: Cents;
}
/** Fixture: 56,000,000 × 0.06125 = 3,430,000 ($34,300.00)/yr; / 365 = 9,397.26… → 9,397; Nov 12–30 = 19 days → 178,543 ($1,785.43); the unrounded product 178,548 is not used. */
export function computePerDiem(gross_loan_cents: Cents, note_rate_pct: string, disbursement_date: PlainDate): PerDiemResult {
  need(gross_loan_cents > 0n, "gross_loan_cents must be positive");
  const p = prepaidInterest(gross_loan_cents, note_rate_pct, disbursement_date);
  const annual = centsToDecimal(gross_loan_cents).mul(ratePercent(note_rate_pct)).toCents("HALF_UP");
  return { convention: PER_DIEM_CONVENTION, per_diem_basis: 365, annual_interest_cents: annual, per_diem_cents: p.per_diem_cents, prepaid_days: p.days, prepaid_interest_cents: p.prepaid_interest_cents, per_diem_interest_cents: p.prepaid_interest_cents, interest_paid_through_date: p.interest_paid_through_date, unrounded_product_cents: p.unrounded_product_cents };
}
export const perDiemCents = (gross_loan_cents: Cents, note_rate_pct: string): Cents => perDiem365Rounded(gross_loan_cents, note_rate_pct);
/** The CD prepaid-interest line (§1026.37(g)(2)(iii)): per day × days = total, reproducible by the consumer — the artifact never carries the unrounded product. */
export function prepaidInterestArtifact(r: Pick<PerDiemResult, "per_diem_cents" | "prepaid_days" | "prepaid_interest_cents">, from: PlainDate, to: PlainDate, rate_pct: string): { label: string; per_day_cents: Cents; days: number; total_cents: Cents; from: PlainDate; to: PlainDate } {
  return { label: `Prepaid Interest ($${(Number(r.per_diem_cents) / 100).toFixed(2)} per day for ${r.prepaid_days} days @ ${rate_pct}%)`, per_day_cents: r.per_diem_cents, days: r.prepaid_days, total_cents: r.per_diem_cents * BigInt(r.prepaid_days), from, to };
}

// ============================================================ rule 3: interest mode, first payment date, LPI and maturity (`decideInterestMode`)
export type InterestMode = "prepaid" | "interest_credit" | "none";
export interface InterestModeInput {
  readonly disbursement_date: PlainDate; readonly gross_loan_cents: Cents; readonly note_rate_pct: string;
  readonly window_days?: number; readonly borrower_elected_credit?: boolean; readonly term_months?: number;
  /** The printed note's dates (26.1 closing_data_snapshots) — a mismatch means a re-draw unless interest-credit mode reconciles it. */
  readonly note_first_payment_date?: PlainDate | null; readonly note_maturity_date?: PlainDate | null;
}
export interface InterestModeDecision {
  readonly mode: InterestMode; readonly interest_credit_available: boolean; readonly interest_credit_offered: boolean; readonly refusal: string | null;
  readonly interest_accrual_start_date: PlainDate; readonly per_diem_cents: Cents; readonly prepaid_days: number; readonly prepaid_interest_cents: Cents;
  readonly interest_credit_days: number; readonly interest_credit_cents: Cents;
  readonly first_payment_date: PlainDate; readonly first_payment_latest_allowed_date: PlainDate; readonly lpi_date: PlainDate; readonly maturity_date_expected: PlainDate;
  readonly first_payment_gate: { readonly code: "FC_FIRST_PAYMENT_2M"; readonly status: "pass" | "fail"; readonly citation: "C2-2-01" };
  readonly redraw_required: boolean; readonly redraw_reason: "date_change" | null; readonly lpi_45_date: PlainDate; readonly delivery_window_compressed: boolean;
}
/** C2-2-01: first payment ≤ disbursement + 2 calendar months (same day-of-month, clamped: Dec 31 → Feb 28). */
export const firstPaymentLatestAllowed = (disbursement_date: PlainDate): PlainDate => addMonths(disbursement_date, 2);
export function decideInterestMode(i: InterestModeInput): InterestModeDecision {
  const D0 = i.disbursement_date; const { y, m, d: day } = parts(D0);
  const window = i.window_days ?? INTEREST_CREDIT_WINDOW_DAYS; const term = i.term_months ?? 360;
  const pd = computePerDiem(i.gross_loan_cents, i.note_rate_pct, D0);
  const monthStart = ymd(y, m, 1);
  const creditFirst = addMonths(monthStart, 1);
  const available = day > 1 && day <= window;
  const wanted = i.borrower_elected_credit === true || (!!i.note_first_payment_date && i.note_first_payment_date === creditFirst && day > 1);
  let mode: InterestMode; let refusal: string | null = null;
  if (day === 1) mode = "none";
  else if (wanted && available) mode = "interest_credit";
  else { mode = "prepaid"; if (wanted) refusal = `interest credit refused: day(${D0}) = ${day} > interest_credit_window_days ${window} (policy ${POLICY_VERSION_26_3}, 26.3-Q2) — prepaid mode with the two-month gate`; }
  const first_payment_date = mode === "prepaid" ? firstPaymentDate(D0) : creditFirst;
  const latest = firstPaymentLatestAllowed(D0);
  const credit_days = mode === "interest_credit" ? day - 1 : 0;
  const lpi = addMonths(first_payment_date, -1);
  const lpi45 = addDays(lpi, LPI_DELIVERY_WINDOW_DAYS);
  const redraw = !!i.note_first_payment_date && i.note_first_payment_date !== first_payment_date;
  return {
    mode, interest_credit_available: available, interest_credit_offered: available && (wanted || mode === "interest_credit"), refusal,
    interest_accrual_start_date: mode === "interest_credit" ? monthStart : D0, per_diem_cents: pd.per_diem_cents,
    prepaid_days: mode === "prepaid" ? pd.prepaid_days : 0, prepaid_interest_cents: mode === "prepaid" ? pd.prepaid_interest_cents : 0n,
    interest_credit_days: credit_days, interest_credit_cents: pd.per_diem_cents * BigInt(credit_days),
    first_payment_date, first_payment_latest_allowed_date: latest, lpi_date: lpi, maturity_date_expected: maturityDate(first_payment_date, term),
    first_payment_gate: { code: "FC_FIRST_PAYMENT_2M", status: first_payment_date <= latest ? "pass" : "fail", citation: "C2-2-01" },
    redraw_required: redraw, redraw_reason: redraw ? "date_change" : null, lpi_45_date: lpi45, delivery_window_compressed: daysBetween(D0, lpi45) < LPI_DELIVERY_WINDOW_DAYS,
  };
}
/** FNMA_B2_1_5_FIRST_PAYMENT_2M as a gate over facts (the evaluator wraps it). */
export function firstPaymentTwoMonthsGate(f: { first_payment_date: PlainDate | null; disbursement_date: PlainDate | null }): { open: boolean; reason?: string; latest_allowed: PlainDate | null } {
  if (!f.disbursement_date || !f.first_payment_date) return { open: false, reason: "FNMA_B2_1_5_FIRST_PAYMENT_2M: disbursement_date and first_payment_date are required (C2-2-01)", latest_allowed: null };
  const latest = firstPaymentLatestAllowed(f.disbursement_date);
  return f.first_payment_date <= latest ? { open: true, latest_allowed: latest } : { open: false, reason: `FNMA_B2_1_5_FIRST_PAYMENT_2M: first payment ${f.first_payment_date} is later than two months from disbursement ${f.disbursement_date} (latest ${latest}, C2-2-01) — re-draw (26.1 date_change) or interest-credit election`, latest_allowed: latest };
}

// ============================================================ rule 4: funding worksheet (`buildFundingWorksheet`, `reconcileToSettlementStatement`)
export interface WorksheetLine { readonly line_code: string; readonly description: string; readonly amount_cents: Cents; readonly sign: 1 | -1 | 0; readonly source: "cd" | "settlement_statement" | "computed"; readonly cd_reference: string | null; }
export interface WorksheetInput {
  readonly funding_id: string; readonly version: number; readonly cd_version: number; readonly settlement_statement_document_id?: string | null;
  readonly gross_loan_cents: Cents; readonly prepaid_interest_cents: Cents; readonly interest_credit_cents?: Cents; readonly escrow_deposit_cents: Cents;
  readonly lender_retained_fees_cents?: Cents; readonly lender_credits_cents: Cents;
  readonly informational?: readonly { line_code: string; description: string; amount_cents: Cents; cd_reference?: string | null }[];
}
export interface FundingWorksheet {
  readonly worksheet_id: string; readonly funding_id: string; readonly version: number; readonly cd_version: number; readonly settlement_statement_document_id: string | null;
  readonly lines: readonly WorksheetLine[]; readonly gross_loan_cents: Cents; readonly lender_retained_cents: Cents; readonly lender_credits_cents: Cents; readonly interest_credit_cents: Cents; readonly net_wire_cents: Cents;
  readonly agent_requested_net_cents: Cents | null; readonly variance_cents: Cents | null; readonly reconciled: boolean; readonly reconciled_at: string | null; readonly reconciled_by_run_id: string | null; readonly variance_explanation: string | null;
}
/** Fixture: $560,000.00 − $1,785.43 − $1,665.00 + $700.00 = $557,249.57 (55,724,957). Interest credit raises the net (example 3: $559,222.94). */
export function buildFundingWorksheet(i: WorksheetInput): FundingWorksheet {
  need(i.gross_loan_cents > 0n, "gross_loan_cents must be positive"); need(i.prepaid_interest_cents >= 0n && i.escrow_deposit_cents >= 0n && i.lender_credits_cents >= 0n, "worksheet amounts are non-negative");
  const credit = i.interest_credit_cents ?? 0n; const fees = i.lender_retained_fees_cents ?? 0n;
  need(!(credit > 0n && i.prepaid_interest_cents > 0n), "a loan is in prepaid OR interest-credit mode, never both");
  const lender_retained = i.prepaid_interest_cents + i.escrow_deposit_cents + fees;
  const net = i.gross_loan_cents - lender_retained + i.lender_credits_cents + credit;
  const lines: WorksheetLine[] = [
    { line_code: "GROSS_LOAN", description: "Loan amount (CD §1026.38(b))", amount_cents: i.gross_loan_cents, sign: 1, source: "cd", cd_reference: "§1026.38(b)" },
    { line_code: "PREPAID_INTEREST", description: "Prepaid interest retained by the partner (interest income)", amount_cents: i.prepaid_interest_cents, sign: -1, source: "cd", cd_reference: "§1026.38(g)(2)" },
    { line_code: "ESCROW_INITIAL_DEPOSIT", description: "Initial escrow deposit (30.3 initial analysis)", amount_cents: i.escrow_deposit_cents, sign: -1, source: "cd", cd_reference: "§1026.38(g)(3)" },
    { line_code: "LENDER_RETAINED_FEES", description: "Lender fees withheld (zero under the SM model — 20.4)", amount_cents: fees, sign: -1, source: "cd", cd_reference: "§1026.38(f)(1)" },
    { line_code: "LENDER_CREDITS", description: "Lender credits (§1026.38(h)(3))", amount_cents: i.lender_credits_cents, sign: 1, source: "cd", cd_reference: "§1026.38(h)(3)" },
    ...(credit > 0n ? [{ line_code: "INTEREST_CREDIT", description: "Interest credit (negative prepaid interest — 25.2)", amount_cents: credit, sign: 1, source: "computed", cd_reference: "§1026.38(g)(2)" } as WorksheetLine] : []),
    ...(i.informational ?? []).map((l): WorksheetLine => ({ line_code: l.line_code, description: l.description, amount_cents: l.amount_cents, sign: 0, source: "settlement_statement", cd_reference: l.cd_reference ?? null })),
  ];
  return { worksheet_id: `${i.funding_id}:ws:${i.version}`, funding_id: i.funding_id, version: i.version, cd_version: i.cd_version, settlement_statement_document_id: i.settlement_statement_document_id ?? null, lines, gross_loan_cents: i.gross_loan_cents, lender_retained_cents: lender_retained, lender_credits_cents: i.lender_credits_cents, interest_credit_cents: credit, net_wire_cents: net, agent_requested_net_cents: null, variance_cents: null, reconciled: false, reconciled_at: null, reconciled_by_run_id: null, variance_explanation: null };
}
export interface Reconciliation { readonly worksheet: FundingWorksheet; readonly item: { code: "FC_FIGURES_RECONCILED"; status: "pass" | "fail" }; readonly hold: { held: boolean; reason: string | null; escalate_to: "settlement_agent" | null }; }
/** variance_cents = net_wire − agent_requested (data model): 0 passes; ≤ $1.00 passes only with an explanation; otherwise the funding holds and the settlement agent reconciles. */
export function reconcileToSettlementStatement(ws: FundingWorksheet, agent_requested_net_cents: Cents, r: { at: string; run_id: string; explanation?: string | null }): Reconciliation {
  const variance = ws.net_wire_cents - agent_requested_net_cents;
  const explained = abs(variance) <= RECONCILIATION_TOLERANCE_CENTS && !!r.explanation;
  const reconciled = variance === 0n || explained;
  const worksheet: FundingWorksheet = { ...ws, agent_requested_net_cents, variance_cents: variance, reconciled, reconciled_at: reconciled ? r.at : null, reconciled_by_run_id: reconciled ? r.run_id : null, variance_explanation: r.explanation ?? null };
  return { worksheet, item: { code: "FC_FIGURES_RECONCILED", status: reconciled ? "pass" : "fail" }, hold: reconciled ? { held: false, reason: null, escalate_to: null } : { held: true, reason: `figures_variance: settlement statement requests ${agent_requested_net_cents} cents, worksheet net ${ws.net_wire_cents} (variance ${variance} cents) — the settlement agent reconciles (payoff per-diem / recording fee); a CD figure change → corrected CD (25.2) before release`, escalate_to: "settlement_agent" } };
}
export function recordReconciliation(events: EventStore, application_id: string, r: Reconciliation, at: string): DomainEvent {
  return r.hold.held
    ? emit(events, application_id, "funding.held", { reason: "figures_variance", detail: r.hold.reason, variance_cents: String(r.worksheet.variance_cents), worksheet_version: r.worksheet.version, escalate_to: r.hold.escalate_to }, at)
    : emit(events, application_id, "funding.worksheet.reconciled", { worksheet_id: r.worksheet.worksheet_id, version: r.worksheet.version, cd_version: r.worksheet.cd_version, net_wire_cents: String(r.worksheet.net_wire_cents), variance_cents: String(r.worksheet.variance_cents) }, at);
}

// ============================================================ rule 5: ledger postings (balanced sets linked to `loan.funded`)
const corp = (account: string): AccountRef => ({ scope: "corporate", account: account as CorporateAccount });   // baseline §5 SM accounts named by 26.3/27.1
export const WAREHOUSE_ADVANCE_RECEIVABLE = "warehouse_advance_receivable", PARTNER_HAIRCUT_RESERVE = "partner_haircut_reserve", SM_FUNDING_CASH = "sm_funding_cash";
export interface FundingLedgerInput { readonly gross_loan_cents: Cents; readonly net_wire_cents: Cents; readonly advance_rate_bps?: number; readonly loan_ref: string; }
export interface FundingSplit { readonly advance_cents: Cents; readonly partner_contribution_cents: Cents; readonly haircut_reserve_cents: Cents; readonly wire_cents: Cents; }
/** 27.1 rule 2: advance = min(98 % × note amount, net wire); partner contribution = net − advance (fixture: $548,800.00 / $8,449.57). */
export function fundingSplit(i: FundingLedgerInput): FundingSplit {
  const rated = centsToDecimal(i.gross_loan_cents).mul(Decimal.ratio(BigInt(i.advance_rate_bps ?? DEFAULT_ADVANCE_RATE_BPS), 10_000n)).toCents("HALF_UP");
  const advance = rated < i.net_wire_cents ? rated : i.net_wire_cents;
  return { advance_cents: advance, partner_contribution_cents: i.net_wire_cents - advance, haircut_reserve_cents: i.net_wire_cents - advance, wire_cents: i.net_wire_cents };
}
/** SM set: Dr warehouse_advance_receivable 54,880,000 / Dr partner_haircut_reserve 844,957 / Cr sm_funding_cash 55,724,957 — the posting target is always the receivable, never a loan-purchase account (rule 9). */
export function fundingLedgerLines(i: FundingLedgerInput): { lines: LineInput[]; split: FundingSplit; posting_target: typeof WAREHOUSE_ADVANCE_RECEIVABLE } {
  const s = fundingSplit(i); const rule = "26.3 rule 5 (baseline §5; 27.1 rule 2)";
  const lines: LineInput[] = [
    { account: corp(WAREHOUSE_ADVANCE_RECEIVABLE), amountCents: s.advance_cents, ruleRef: rule, memo: `warehouse advance ${i.loan_ref}` },
    { account: corp(PARTNER_HAIRCUT_RESERVE), amountCents: s.haircut_reserve_cents, ruleRef: rule, memo: `partner contribution applied ${i.loan_ref}` },
    { account: corp(SM_FUNDING_CASH), amountCents: -s.wire_cents, ruleRef: rule, memo: `outbound funding wire ${i.loan_ref}` },
  ];
  return { lines, split: s, posting_target: WAREHOUSE_ADVANCE_RECEIVABLE };
}
export function postFundingLedger(ledger: Ledger, i: FundingLedgerInput & { effective_date: PlainDate; source_event_id?: string | null }, at?: string): EntrySet & { split: FundingSplit } {
  const { lines, split } = fundingLedgerLines(i);
  const set = ledger.post({ effectiveDate: i.effective_date, description: `26.3 funding wire ${i.loan_ref}`, lines, ...(i.source_event_id ? { sourceEventId: i.source_event_id } : {}) }, at);
  return { ...set, split };
}
/** Partner mirror exported by 27.2: Dr loans_held_for_sale / Dr lender_credits_expense; Cr warehouse_payable / haircut_reserve_applied / prepaid_interest / escrow_initial_deposit — Σ = 0. */
export function partnerMirrorLines(i: { gross_loan_cents: Cents; lender_credits_cents: Cents; prepaid_interest_cents: Cents; interest_credit_cents?: Cents; escrow_deposit_cents: Cents; net_wire_cents: Cents; advance_rate_bps?: number; loan_ref: string }): { lines: readonly { account: string; amount_cents: Cents }[]; balanced: boolean } {
  const s = fundingSplit({ gross_loan_cents: i.gross_loan_cents, net_wire_cents: i.net_wire_cents, ...(i.advance_rate_bps !== undefined ? { advance_rate_bps: i.advance_rate_bps } : {}), loan_ref: i.loan_ref });
  const credit = i.interest_credit_cents ?? 0n;
  const lines = [
    { account: "loans_held_for_sale", amount_cents: i.gross_loan_cents }, { account: "lender_credits_expense", amount_cents: i.lender_credits_cents },
    ...(credit > 0n ? [{ account: "prepaid_interest", amount_cents: credit }] : []),
    { account: "warehouse_payable", amount_cents: -s.advance_cents }, { account: "haircut_reserve_applied", amount_cents: -s.haircut_reserve_cents },
    ...(i.prepaid_interest_cents > 0n ? [{ account: "prepaid_interest", amount_cents: -i.prepaid_interest_cents }] : []),
    { account: "escrow_initial_deposit", amount_cents: -i.escrow_deposit_cents },
  ];
  return { lines, balanced: lines.reduce((a, l) => a + l.amount_cents, 0n) === 0n };
}

// ============================================================ rule 1: funding-conditions checklist (`evaluateFundingConditions`)
export const FC_CODES = ["FC_DOCS_EXECUTED_QC", "FC_CD_ACK", "FC_ID_VERIFIED", "FC_RESCISSION_EXPIRED", "FC_TX_RESCISSION_EXPIRED", "FC_HAZARD_EVIDENCE", "FC_FLOOD_COVERAGE", "FC_PROJECT_INSURANCE", "FC_TITLE_CPL", "FC_TITLE_COMMITMENT_UPDATED", "FC_VVOE", "FC_CREDIT_REFRESH", "FC_MI_CERT", "FC_COMPLIANCE_DISBURSE", "FC_PTF_CLEARED", "FC_CASH_TO_CLOSE", "FC_GIFT_TRANSFER", "FC_WIRE_VERIFIED", "FC_PAYOFF_GOOD_THROUGH", "FC_WAREHOUSE_ADVANCE", "FC_FIRST_PAYMENT_2M", "FC_AUDIT_TRAIL", "FC_ENOTE_REGISTERED_SECURED", "FC_PAPER_NOTE_CONTROL", "FC_RECORDING_CONFIRMED", "FC_NO_QC_HOLD", "FC_COMMITMENT_LIVE", "FC_FIGURES_RECONCILED", "FC_NO_FRAUD_HOLD", "FC_FEDWIRE_DAY"] as const;
export type FcCode = (typeof FC_CODES)[number];
export type FcStatus = "pass" | "fail" | "waived" | "n/a" | "pending";
export interface FcItem { readonly code: FcCode; readonly owner_process: string; readonly status: FcStatus; readonly evidence_ref: string | null; readonly evaluated_at: string; readonly note: string | null; }
export const WAIVABLE_FC: readonly FcCode[] = ["FC_RECORDING_CONFIRMED", "FC_COMMITMENT_LIVE", "FC_CD_ACK"];
/** Items the wet-state pre-signing subset excludes (they can only pass after signing). */
export const POST_SIGNING_FC: readonly FcCode[] = ["FC_DOCS_EXECUTED_QC", "FC_CD_ACK", "FC_ID_VERIFIED", "FC_AUDIT_TRAIL", "FC_ENOTE_REGISTERED_SECURED"];
const FC_OWNER: Readonly<Record<FcCode, string>> = { FC_DOCS_EXECUTED_QC: "26.2", FC_CD_ACK: "25.2", FC_ID_VERIFIED: "26.2", FC_RESCISSION_EXPIRED: "25.3", FC_TX_RESCISSION_EXPIRED: "26.1", FC_HAZARD_EVIDENCE: "24.5", FC_FLOOD_COVERAGE: "24.5", FC_PROJECT_INSURANCE: "24.5", FC_TITLE_CPL: "24.4", FC_TITLE_COMMITMENT_UPDATED: "24.4", FC_VVOE: "22.3", FC_CREDIT_REFRESH: "22.2", FC_MI_CERT: "24.6", FC_COMPLIANCE_DISBURSE: "25.1", FC_PTF_CLEARED: "23.3", FC_CASH_TO_CLOSE: "22.4", FC_GIFT_TRANSFER: "22.4", FC_WIRE_VERIFIED: "24.4", FC_PAYOFF_GOOD_THROUGH: "24.4", FC_WAREHOUSE_ADVANCE: "27.1", FC_FIRST_PAYMENT_2M: "26.3", FC_AUDIT_TRAIL: "26.2", FC_ENOTE_REGISTERED_SECURED: "26.2", FC_PAPER_NOTE_CONTROL: "27.1", FC_RECORDING_CONFIRMED: "26.2", FC_NO_QC_HOLD: "28.1", FC_COMMITMENT_LIVE: "29.1", FC_FIGURES_RECONCILED: "26.3", FC_NO_FRAUD_HOLD: "22.6", FC_FEDWIRE_DAY: "26.3" };
export interface Waiver { readonly code: FcCode; readonly waived_by: "funding_approver" | "officer"; readonly reason: string; readonly at: string; }
export interface ConditionFacts {
  readonly as_of: string; readonly time_zone?: string;
  readonly funding: { readonly funding_type: FundingType; readonly transaction_type: TransactionType; readonly disbursement_date: PlainDate | null; readonly release_date: PlainDate | null; readonly note_date: PlainDate | null; readonly authorized: boolean; readonly stage?: "pre_signing" | "post_signing" };
  readonly loan: { readonly ltv_pct: number; readonly sfha: boolean; readonly project: boolean; readonly enote: boolean; readonly tx_50a6: boolean; readonly record_before_fund: boolean };
  readonly execution?: { readonly review_passed: boolean; readonly all_docs_signed: boolean; readonly blocking_defects: number; readonly package_returned: boolean } | null;
  readonly cd?: { readonly consummated_version: number | null; readonly delivered_with_receipt: boolean; readonly signed_copy_in_documents: boolean | null } | null;
  readonly identity?: { readonly all_signers_proofed: boolean } | null;
  readonly rescission?: DisburseFacts | null; readonly tx_rescission?: { readonly expired: boolean } | null;
  readonly hazard?: Parameters<typeof hazardEvidenceGate>[0] | null; readonly flood?: { readonly covered: boolean } | null; readonly project_insurance?: { readonly verified: boolean } | null;
  readonly title?: { readonly cpl_open: boolean; readonly commitment_open: boolean } | null;
  readonly vvoe?: { readonly verified_on: PlainDate | null; readonly self_employed: boolean } | null;
  readonly credit_refresh_open?: boolean | null; readonly mi?: { readonly status: string | null } | null;
  readonly compliance_disburse_open?: boolean | null; readonly ptf?: { readonly ptf_cleared: boolean; readonly blocking_codes?: readonly string[] } | null;
  readonly cash_to_close?: Record<string, unknown> | null; readonly gifts?: readonly { gift_id: string; status: string }[] | null;
  readonly wire?: Parameters<typeof wireVerificationGate>[0] | null; readonly payoffs?: readonly { liability_id: string; status: string; good_through_date: PlainDate | null }[] | null;
  readonly warehouse_advance_approved?: boolean | null;
  readonly first_payment?: { readonly first_payment_date: PlainDate | null } | null;
  readonly audit_trail_open?: boolean | null; readonly enote?: { readonly registered: boolean; readonly secured_party_set: boolean } | null; readonly paper_note?: { readonly in_custody_or_transit: boolean } | null;
  readonly recording_confirmed?: boolean | null; readonly qc_hold?: boolean | null; readonly commitment?: { readonly active: boolean; readonly expires_on: PlainDate | null } | null;
  readonly worksheet?: { readonly reconciled: boolean } | null; readonly fraud?: { readonly fraud_hold: boolean; readonly ofac_clear: boolean } | null;
  readonly waivers?: readonly Waiver[];
}
export interface FundingConditions { readonly checklist_id: string; readonly funding_id: string; readonly evaluated_at: string; readonly items: readonly FcItem[]; readonly passed: boolean; readonly blocking_codes: readonly FcCode[]; readonly pending_codes: readonly FcCode[]; readonly waivers: readonly Waiver[]; readonly pre_signing_subset_passed: boolean; readonly soft_flags: readonly string[]; }
type Res = { status: FcStatus; note?: string | null; evidence?: string | null };
const P = (ok: boolean, note?: string | null): Res => ({ status: ok ? "pass" : "fail", note: note ?? null });
const NA = (note: string): Res => ({ status: "n/a", note });
const PEND = (note: string): Res => ({ status: "pending", note });
/** Only the three waivable items may be waived, and only by the funding_approver (officer also accepted); a regulatory gate is never waivable. */
export function assertWaivable(code: FcCode, by: string): void {
  if (!WAIVABLE_FC.includes(code)) throw new FundingRefused("FC_NOT_WAIVABLE", "26.3 rule 1: a regulatory gate is never waivable", `${code} cannot be waived (only ${WAIVABLE_FC.join(", ")})`);
  if (by !== "funding_approver" && by !== "officer") throw new FundingRefused("FC_WAIVER_ROLE", "26.3 rule 1: waivers by funding_approver with a reason", `${by} may not waive ${code}`);
}
export function evaluateFundingConditions(funding_id: string, f: ConditionFacts): FundingConditions {
  const at = f.as_of; const purchase = f.funding.transaction_type === "purchase"; const wet = f.funding.funding_type === "wet";
  const soft: string[] = [];
  const resolve = (code: FcCode): Res => {
    switch (code) {
      case "FC_DOCS_EXECUTED_QC": return !f.execution || !f.execution.package_returned ? PEND("executed package not yet returned / reviewed (26.2 SM_O72_POST_SIGNING_REVIEW_4H)") : P(f.execution.review_passed && f.execution.all_docs_signed && f.execution.blocking_defects === 0, "closing.execution_review.passed with every required document ≥ signed and no blocking execution_defects");
      case "FC_CD_ACK": return !f.cd ? PEND("consummated CD not yet recorded (25.2)") : f.cd.consummated_version === null ? PEND("no consummated CD version") : P(f.cd.delivered_with_receipt && f.cd.signed_copy_in_documents !== false, `CD v${f.cd.consummated_version} delivered with receipt evidence${f.cd.signed_copy_in_documents ? "; signed copy in documents_signed" : ""}`);
      case "FC_ID_VERIFIED": return !f.identity ? PEND("identity proofing evidence pending (26.2 RON/IPEN or certified ID copies)") : P(f.identity.all_signers_proofed, "closing.identity.proofed for every signer");
      case "FC_RESCISSION_EXPIRED": { if (purchase) return NA("purchase-money transaction — §1026.23(f)(1) exempt"); if (!f.rescission) return PEND("rescission_periods row pending (25.3)"); if (f.rescission.status === "not_applicable") return NA("not rescindable (rescission_periods.applicability)"); const g = rescissionGate(f.rescission); return P(g.open, g.open ? "REGZ_1026_23_RESCISSION_3SBD_GATE open (rescission.confirmed_not_rescinded or accepted waiver)" : g.reason ?? null); }
      case "FC_TX_RESCISSION_EXPIRED": return !f.loan.tx_50a6 ? NA("not a TX 50(a)(6) loan") : !f.tx_rescission ? PEND("TX 50(a)(6) rescission period running (26.1 TX_50A6_RESCISSION_3D_GATE)") : P(f.tx_rescission.expired, "TX_50A6_RESCISSION_3D_GATE");
      case "FC_HAZARD_EVIDENCE": { if (!f.hazard) return PEND("hazard policy evidence pending (24.5)"); const g = hazardEvidenceGate({ ...f.hazard, disbursement_date: f.funding.disbursement_date }); return P(g.open, g.reason ?? "FNMA_B7_3_02_HAZARD_EVIDENCE_GATE open (effective ≤ disbursement)"); }
      case "FC_FLOOD_COVERAGE": return !f.loan.sfha ? NA("not in an SFHA (Zone X) — FNMA_B7_3_06_FLOOD_COVERAGE_GATE n/a") : !f.flood ? PEND("flood coverage evidence pending (24.5)") : P(f.flood.covered, "FNMA_B7_3_06_FLOOD_COVERAGE_GATE");
      case "FC_PROJECT_INSURANCE": return !f.loan.project ? NA("not a condo/co-op/attached PUD") : !f.project_insurance ? PEND("project insurance review pending (24.5)") : P(f.project_insurance.verified, "FNMA_B7_3_03_PROJECT_INSURANCE_GATE");
      case "FC_TITLE_CPL": return !f.title ? PEND("CPL pending (24.4)") : P(f.title.cpl_open, "SM_CPL_BEFORE_FUNDING_GATE (CPL naming the partner and SM per facility terms)");
      case "FC_TITLE_COMMITMENT_UPDATED": return !f.title ? PEND("title commitment pending (24.4)") : P(f.title.commitment_open, "FNMA_B7_2_01_TITLE_EVIDENCE_GATE / commitment date-down current");
      case "FC_VVOE": { if (!f.vvoe || !f.vvoe.verified_on) return PEND("VVOE pending (22.3)"); if (!f.funding.note_date) return PEND("note date unknown — VVOE is measured against the note date"); const ok = f.vvoe.self_employed ? daysBetween(f.vvoe.verified_on, f.funding.note_date) <= 120 : f.vvoe.verified_on >= addBusinessDays(f.funding.note_date, -10, creditor); return P(ok, `FNMA_B3_3_1_04_VVOE_10BD: verified ${f.vvoe.verified_on} vs note date ${f.funding.note_date}`); }
      case "FC_CREDIT_REFRESH": return f.credit_refresh_open === undefined || f.credit_refresh_open === null ? PEND("credit refresh pending (22.2)") : P(f.credit_refresh_open, "SM_CREDIT_REFRESH_PRECLOSE_GATE");
      case "FC_MI_CERT": return f.loan.ltv_pct <= 80 ? NA(`LTV ${f.loan.ltv_pct}% ≤ 80% — no MI`) : !f.mi ? PEND("MI certificate pending (24.6)") : P(["committed", "docs_ready", "activation_requested", "active"].includes(f.mi.status ?? ""), `mi_certificates.status = ${f.mi.status}`);
      case "FC_COMPLIANCE_DISBURSE": return f.compliance_disburse_open === undefined || f.compliance_disburse_open === null ? PEND("compliance disbursement gate not yet run (25.1)") : P(f.compliance_disburse_open, "SM_O61_COMPLIANCE_PASS_DISBURSE_GATE (compliance.gate.opened{gate=disbursement})");
      case "FC_PTF_CLEARED": { if (!f.ptf) return PEND("PTF conditions pending (23.3)"); const g = evaluateGate("23.3.ptfClearedGate", { ptf_cleared: f.ptf.ptf_cleared, blocking_codes: f.ptf.blocking_codes ?? [], command: "authorizeFunding" }); return P(g.open, g.reason ?? "SM_UW_PTF_CLEARED_GATE open"); }
      case "FC_CASH_TO_CLOSE": { if (!f.cash_to_close) return PEND("cash-to-close worksheet pending (22.4)"); const g = evaluateGate("22.4.cashToCloseReconciled", f.cash_to_close); return P(g.open, g.reason ?? "SM_CASH_TO_CLOSE_RECONCILED_GATE open"); }
      case "FC_GIFT_TRANSFER": { if (f.gifts === undefined || f.gifts === null) return PEND("gift evidence pending (22.4)"); if (!f.gifts.length) return NA("no gift funds"); const g = evaluateGate("22.4.giftTransfer", { gifts: f.gifts }); return P(g.open, g.reason ?? "FNMA_B3_4_3_04_GIFT_TRANSFER_GATE open"); }
      case "FC_WIRE_VERIFIED": { if (!f.wire) return PEND("wire verification pending (24.4)"); const g = wireVerificationGate({ ...f.wire, as_of: f.wire.as_of || at }); return P(g.open, g.reason ?? "SM_WIRE_VERIFICATION_GATE open (≤ 30 days; no change inside the 48-hour freeze)"); }
      case "FC_PAYOFF_GOOD_THROUGH": { if (purchase) return NA("purchase — no liens paid from proceeds"); if (!f.payoffs) return PEND("payoff statements pending (24.4)"); if (!f.payoffs.length) return NA("no liens paid from proceeds"); const g = payoffGoodThroughGate({ payoffs: f.payoffs, disbursement_date: f.funding.disbursement_date }); return P(g.open, g.reason ?? "SM_PAYOFF_GOOD_THROUGH_GATE open"); }
      case "FC_WAREHOUSE_ADVANCE": return !f.funding.authorized ? PEND("evaluated after funding.authorized — never blocks authorization itself") : f.warehouse_advance_approved === undefined || f.warehouse_advance_approved === null ? PEND("warehouse.advance.* pending (27.1 SM_WH_ADVANCE_APPROVAL_2BH)") : P(f.warehouse_advance_approved, "warehouse.advance.approved");
      case "FC_FIRST_PAYMENT_2M": { const g = firstPaymentTwoMonthsGate({ first_payment_date: f.first_payment?.first_payment_date ?? null, disbursement_date: f.funding.disbursement_date }); return P(g.open, g.reason ?? `FNMA_B2_1_5_FIRST_PAYMENT_2M: first payment ≤ ${g.latest_allowed} (C2-2-01)`); }
      case "FC_AUDIT_TRAIL": return wet ? NA("wet closing — no electronic audit trail gate") : f.audit_trail_open === undefined || f.audit_trail_open === null ? PEND("closing.audit_trail.received pending (26.2)") : P(f.audit_trail_open, "SM_O72_AUDIT_TRAIL_BEFORE_FUNDING_GATE");
      case "FC_ENOTE_REGISTERED_SECURED": return !f.loan.enote ? NA("paper note") : !f.enote ? PEND("eNote registration pending (26.2)") : P(f.enote.registered && f.enote.secured_party_set, "enotes.status ≥ registered and enote.secured_party.set (SM_O72_SECURED_PARTY_BEFORE_ADVANCE_GATE)");
      case "FC_PAPER_NOTE_CONTROL": return f.loan.enote ? NA("eNote — control through the eRegistry") : wet ? NA("wet state — the 5-BD wet clock runs in 27.1") : !f.paper_note ? PEND("original note custody pending (27.1 bailee / 26.4 tracking)") : P(f.paper_note.in_custody_or_transit, "custody.paper_note.received or tracked transit under a bailee letter");
      case "FC_RECORDING_CONFIRMED": return !f.loan.record_before_fund ? NA("record_before_fund not elected (26.2-Q3 / 26.3-Q5)") : f.recording_confirmed === undefined || f.recording_confirmed === null ? PEND("recording.confirmed pending") : P(f.recording_confirmed, "recording.confirmed (security instrument)");
      case "FC_NO_QC_HOLD": return f.qc_hold === undefined || f.qc_hold === null ? PEND("prefunding QC status pending (28.1)") : P(!f.qc_hold, "FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE (no SM_QC_PREFUNDING_HOLD)");
      case "FC_COMMITMENT_LIVE": { if (!f.commitment) return PEND("commitment status pending (29.1)"); const ok = f.commitment.active && !!f.commitment.expires_on && !!f.funding.disbursement_date && f.commitment.expires_on >= f.funding.disbursement_date; if (ok && f.funding.disbursement_date && daysBetween(f.funding.disbursement_date, f.commitment.expires_on!) < 15) soft.push(`FC_COMMITMENT_LIVE: commitment expires ${f.commitment.expires_on} (< 15 days after disbursement)`); return P(ok, `commitment ${f.commitment.active ? "active" : "not active"}, expires ${f.commitment.expires_on ?? "?"}`); }
      case "FC_FIGURES_RECONCILED": return !f.worksheet ? PEND("funding worksheet not yet reconciled (rule 4)") : P(f.worksheet.reconciled, "worksheet reconciled to the consummated CD and the settlement statement");
      case "FC_NO_FRAUD_HOLD": return !f.fraud ? PEND("fraud/OFAC status pending (22.6 / 28.4)") : P(!f.fraud.fraud_hold && f.fraud.ofac_clear, f.fraud.fraud_hold ? "open fraud_cases hold" : f.fraud.ofac_clear ? "no fraud hold; OFAC clear on the beneficiary" : "OFAC not clear on the beneficiary");
      case "FC_FEDWIRE_DAY": { if (!f.funding.release_date) return PEND("release date not scheduled"); const c = fedwireDayCheck(f.funding.release_date); return { status: c.status, note: c.note }; }
    }
  };
  const waivers = f.waivers ?? [];
  for (const w of waivers) assertWaivable(w.code, w.waived_by);
  const items: FcItem[] = FC_CODES.map((code) => {
    const r = resolve(code);
    const w = r.status !== "pass" && r.status !== "n/a" ? waivers.find((x) => x.code === code) : undefined;
    return { code, owner_process: FC_OWNER[code], status: w ? "waived" : r.status, evidence_ref: r.evidence ?? null, evaluated_at: at, note: w ? `waived by ${w.waived_by}: ${w.reason}` : r.note ?? null };
  });
  const blocking = items.filter((x) => x.status === "fail").map((x) => x.code);
  const pending = items.filter((x) => x.status === "pending" && x.code !== "FC_WAREHOUSE_ADVANCE").map((x) => x.code);
  const ok = (x: FcItem) => x.status === "pass" || x.status === "n/a" || x.status === "waived";
  const pre = items.filter((x) => !POST_SIGNING_FC.includes(x.code) && x.code !== "FC_WAREHOUSE_ADVANCE" && x.code !== "FC_FIGURES_RECONCILED");
  return { checklist_id: `${funding_id}:fc:${at}`, funding_id, evaluated_at: at, items, passed: blocking.length === 0 && pending.length === 0, blocking_codes: blocking, pending_codes: pending, waivers, pre_signing_subset_passed: pre.every(ok), soft_flags: soft };
}
export const fcStatus = (c: FundingConditions, code: FcCode): FcStatus => c.items.find((x) => x.code === code)!.status;
export function recordConditionsEvaluated(events: EventStore, application_id: string, c: FundingConditions, at: string): DomainEvent {
  return emit(events, application_id, "funding.conditions.evaluated", { checklist_id: c.checklist_id, funding_id: c.funding_id, passed: c.passed, blocking_codes: [...c.blocking_codes], pending_codes: [...c.pending_codes], first_payment_2m: fcStatus(c, "FC_FIRST_PAYMENT_2M"), pre_signing_subset_passed: c.pre_signing_subset_passed, soft_flags: [...c.soft_flags] }, at);
}
/** Rule 10(d) — dry state, executed package not returned: deadline = next creditor business day after signing, 17:00 local; day 2 → settlement agent; day 5 → title underwriter (CPL) and cancellation/re-schedule. */
export function documentsNotReturned(i: { signing_on: PlainDate; time_zone: string; as_of: string; package_returned: boolean }): { return_deadline_at: string; overdue: boolean; day: number; stage: "not_due" | "overdue" | "escalate_settlement_agent" | "notify_title_underwriter"; escalate_settlement_agent_on: PlainDate; notify_title_underwriter_on: PlainDate } {
  const deadlineDay = addBusinessDays(i.signing_on, 1, creditor);
  const return_deadline_at = toIso(zonedEpochMs(deadlineDay, "17:00", i.time_zone));
  const day2 = addBusinessDays(i.signing_on, 2, creditor), day5 = addBusinessDays(i.signing_on, 5, creditor);
  const today = civil(i.as_of, i.time_zone);
  const overdue = !i.package_returned && Date.parse(i.as_of) > Date.parse(return_deadline_at);
  const day = Math.max(0, daysBetween(i.signing_on, today));
  const stage = i.package_returned || !overdue ? "not_due" : today >= day5 ? "notify_title_underwriter" : today >= day2 ? "escalate_settlement_agent" : "overdue";
  return { return_deadline_at, overdue, day, stage, escalate_settlement_agent_on: day2, notify_title_underwriter_on: day5 };
}

// ============================================================ funding record + state machine
export type FundingStatus = "pending_conditions" | "conditions_met" | "authorized" | "advance_approved" | "wire_pending_release" | "wire_released" | "wire_accepted" | "funds_at_agent" | "disbursed" | "held" | "cancelled" | "returned" | "unwinding" | "unwound";
export type CancelReason = "rescinded_before_funding" | "conditions_failed" | "borrower_withdrew" | "documents_not_returned" | "fraud_suspected" | "lock_or_commitment_expired" | "partner_hold";
export type LegalForm = "secured_loan_to_partner" | "purchase_at_settlement";
export interface Funding {
  readonly funding_id: string; readonly application_id: string; readonly loan_id: string | null; readonly closing_id: string | null; readonly partner_id: string; readonly partner_loan_number: string;
  readonly funding_type: FundingType; readonly disbursement_authorization_mode: AuthorizationMode; readonly note_date: PlainDate | null; readonly consummation_at: string | null;
  readonly scheduled_funding_date: PlainDate; readonly earliest_funding_date: PlainDate; readonly funding_date: PlainDate | null; readonly disbursement_date: PlainDate | null;
  readonly rescission_expires_at: string | null; readonly rescission_expires_on: PlainDate | null;
  readonly gross_loan_cents: Cents; readonly note_rate_pct: string; readonly interest: InterestModeDecision;
  readonly worksheet: FundingWorksheet | null; readonly net_wire_cents: Cents | null; readonly wire_id: string | null; readonly warehouse_advance_id: string | null;
  readonly escrow_prefund: boolean; readonly hold_reason: string | null; readonly cancel_reason: CancelReason | null; readonly unwind_id: string | null;
  readonly status: FundingStatus; readonly prior_status: FundingStatus | null; readonly passed_wire_pending_release: boolean;
  readonly funds_received_by_agent_at: string | null; readonly disbursement_confirmed_at: string | null; readonly disbursement_confirmation_source: DisbursementSource | null;
  readonly delivery_window_compressed: boolean; readonly legal_form: LegalForm;
}
export type DisbursementSource = "final_settlement_statement" | "recording_confirmation" | "agent_attestation" | "bank_debit_trace";
export interface OpenFundingInput {
  readonly funding_id: string; readonly application_id: string; readonly closing_id?: string | null; readonly partner_id: string; readonly partner_loan_number: string;
  readonly calendar: FundingCalendar; readonly gross_loan_cents: Cents; readonly note_rate_pct: string; readonly interest?: Partial<Pick<InterestModeInput, "borrower_elected_credit" | "note_first_payment_date" | "note_maturity_date" | "window_days">>;
  readonly legal_form?: LegalForm; readonly escrow_prefund?: boolean;
}
/** Open the fundings row at `closing.scheduled`: dates from the calendar, interest mode from the scheduled disbursement date; status pending_conditions. */
export function openFunding(i: OpenFundingInput): Funding {
  const c = i.calendar;
  const interest = decideInterestMode({ disbursement_date: c.scheduled_funding_date, gross_loan_cents: i.gross_loan_cents, note_rate_pct: i.note_rate_pct, ...(i.interest ?? {}) });
  return { funding_id: i.funding_id, application_id: i.application_id, loan_id: null, closing_id: i.closing_id ?? null, partner_id: i.partner_id, partner_loan_number: i.partner_loan_number, funding_type: c.funding_type, disbursement_authorization_mode: c.disbursement_authorization_mode, note_date: c.note_date, consummation_at: c.consummation_at, scheduled_funding_date: c.scheduled_funding_date, earliest_funding_date: c.earliest_funding_date, funding_date: null, disbursement_date: null, rescission_expires_at: c.rescission_expires_at, rescission_expires_on: c.rescission_expires_on, gross_loan_cents: i.gross_loan_cents, note_rate_pct: i.note_rate_pct, interest, worksheet: null, net_wire_cents: null, wire_id: null, warehouse_advance_id: null, escrow_prefund: i.escrow_prefund ?? false, hold_reason: null, cancel_reason: null, unwind_id: null, status: "pending_conditions", prior_status: null, passed_wire_pending_release: false, funds_received_by_agent_at: null, disbursement_confirmed_at: null, disbursement_confirmation_source: null, delivery_window_compressed: interest.delivery_window_compressed, legal_form: i.legal_form ?? "secured_loan_to_partner" };
}
const ORDER: readonly FundingStatus[] = ["pending_conditions", "conditions_met", "authorized", "advance_approved", "wire_pending_release", "wire_released", "wire_accepted", "funds_at_agent", "disbursed"];
export function transition(f: Funding, to: FundingStatus): Funding {
  const from = f.status;
  const idx = (s: FundingStatus) => ORDER.indexOf(s);
  if (to === "held") { if (idx(from) >= idx("wire_released") && from !== "held") throw new FundingRefused("HOLD_AFTER_RELEASE", "26.3 state machine", `cannot hold from ${from} — the wire is released; use return/unwind`); return { ...f, status: "held", prior_status: from }; }
  if (to === "cancelled") { if (idx(from) >= idx("wire_released") && from !== "held" && from !== "returned") throw new FundingRefused("CANCEL_AFTER_RELEASE", "26.3 state machine", `cannot cancel from ${from} without a return`); return { ...f, status: "cancelled", prior_status: from }; }
  if (to === "returned") { if (!["wire_released", "wire_accepted", "funds_at_agent"].includes(from)) throw new FundingRefused("RETURN_STATE", "26.3 state machine", `returned only from wire_released/wire_accepted/funds_at_agent (was ${from})`); return { ...f, status: "returned", prior_status: from }; }
  if (to === "unwinding") { if (from !== "disbursed") throw new FundingRefused("UNWIND_STATE", "26.3 state machine", `unwinding only from disbursed (was ${from})`); return { ...f, status: "unwinding", prior_status: from }; }
  if (to === "unwound") { if (from !== "unwinding") throw new FundingRefused("UNWIND_STATE", "26.3 state machine", `unwound only from unwinding`); return { ...f, status: "unwound", prior_status: from }; }
  if (from === "held" && to === "pending_conditions") return { ...f, status: to, prior_status: from, hold_reason: null };
  if (idx(to) < 0) throw new FundingRefused("BAD_TRANSITION", "26.3 state machine", `${from} → ${to}`);
  if (from === "disbursed" || from === "cancelled" || from === "unwound") throw new FundingRefused("TERMINAL", "26.3 state machine", `${from} is terminal`);
  if (idx(from) >= 0 && idx(to) !== idx(from) + 1) throw new FundingRefused("SKIPPED_STATE", "26.3 state machine: no transition may skip wire_pending_release", `${from} → ${to} skips ${ORDER[idx(from) + 1]}`);
  return { ...f, status: to, prior_status: from, passed_wire_pending_release: f.passed_wire_pending_release || to === "wire_pending_release" };
}
export function requestFunding(events: EventStore, f: Funding, at: string): { funding: Funding; event: DomainEvent } {
  const event = emit(events, f.application_id, "funding.requested", { funding_id: f.funding_id, scheduled_funding_date: f.scheduled_funding_date, disbursement_date: f.scheduled_funding_date, earliest_funding_date: f.earliest_funding_date, first_payment_date: f.interest.first_payment_date, first_payment_latest_allowed_date: f.interest.first_payment_latest_allowed_date, interest_mode: f.interest.mode, funding_type: f.funding_type, rescission_expires_at: f.rescission_expires_at }, at);
  return { funding: f, event };
}
export function holdFunding(events: EventStore, f: Funding, reason: string, at: string, detail: Record<string, unknown> = {}): { funding: Funding; event: DomainEvent } {
  const funding = { ...transition(f, "held"), hold_reason: reason };
  return { funding, event: emit(events, f.application_id, "funding.held", { funding_id: f.funding_id, reason, ...detail }, at) };
}

// ============================================================ authorization boundary (`authorizeFunding`) — every gate re-asserted
export interface AuthorizeInput {
  readonly at: string; readonly conditions: FundingConditions; readonly rescission: DisburseFacts | null; readonly fraud_hold: { fraud_hold: boolean; reason?: string | null } | null;
  readonly ptf: { ptf_cleared: boolean; blocking_codes?: readonly string[] }; readonly cash_to_close: Record<string, unknown>; readonly gifts: readonly { gift_id: string; status: string }[]; readonly sale_proceeds?: Record<string, unknown> | null;
  readonly qm?: Parameters<typeof qmDeterminationGate>[0] | null; readonly is_hoepa?: boolean;
  readonly legal_form_decision_id?: string | null; readonly decision_roles?: readonly string[];
  readonly officer_prefund_approval_id?: string | null;
}
export interface Authorization { readonly funding: Funding; readonly events: readonly DomainEvent[]; readonly gates_asserted: readonly string[]; readonly advance_request: Record<string, unknown>; }
/** Rule 9 / 31.1-T9: Form B (`purchase_at_settlement`) is refused absent an officer + attorney decision record. */
export function assertLegalForm(form: LegalForm, decision: { decision_id?: string | null; roles?: readonly string[] } = {}): void {
  if (form === "secured_loan_to_partner") return;
  const roles = decision.roles ?? [];
  if (!decision.decision_id || !roles.includes("officer") || !roles.includes("attorney")) throw new FundingRefused("table_funding_form_not_approved", "26.3 rule 9 / 31.1-Q3 (§1024.2(b) table funding)", `origination.warehouse_legal_form = ${form} without an officer + attorney decision record — SM would become the RESPA lender`);
}
export function authorizeFunding(events: EventStore, f: Funding, i: AuthorizeInput): Authorization {
  const gates: string[] = [];
  assertLegalForm(f.legal_form, { decision_id: i.legal_form_decision_id ?? null, roles: i.decision_roles ?? [] }); gates.push("31.1 warehouse_legal_form");
  assertNoFraudHold(i.fraud_hold, "funding.authorized"); gates.push("22.6 fraud_hold");
  const ptf = evaluateGate("23.3.ptfClearedGate", { ptf_cleared: i.ptf.ptf_cleared, blocking_codes: i.ptf.blocking_codes ?? [], command: "authorizeFunding" }); if (!ptf.open) throw new FundingRefused("SM_UW_PTF_CLEARED_GATE", "23.3", ptf.reason ?? "closed"); gates.push("SM_UW_PTF_CLEARED_GATE");
  for (const [ref, facts] of [["22.4.giftTransfer", { gifts: i.gifts }], ["22.4.cashToCloseReconciled", i.cash_to_close], ...(i.sale_proceeds ? [["22.4.saleProceeds", i.sale_proceeds] as const] : [])] as const) { const g = evaluateGate(ref, facts as Record<string, unknown>); if (!g.open) throw new FundingRefused(ref, "22.4", g.reason ?? "closed"); gates.push(ref); }
  if (i.qm) { const q: QmGateOutcome = qmDeterminationGate(i.qm, "authorizeFunding"); if (!q.open) throw new FundingRefused("REGZ_1026_43_QM_DETERMINATION_GATE", "23.4", q.reason ?? "closed"); gates.push("REGZ_1026_43_QM_DETERMINATION_GATE"); }
  const h = hoepaGate(i.is_hoepa === true, "authorizeFunding"); if (!h.open) throw new FundingRefused("REGZ_1026_32_HOEPA_GATE", "23.4", h.reason ?? "closed"); gates.push("REGZ_1026_32_HOEPA_GATE");
  if (i.rescission && i.rescission.status !== "not_applicable") {
    if (!f.escrow_prefund) assertDisburseAllowed(i.rescission);
    else if (!i.officer_prefund_approval_id) throw new FundingRefused("ESCROW_PREFUND_NEEDS_OFFICER", "§1026.23(c) 'other than in escrow'; 26.3-Q4", "escrow pre-fund requires an officer approval per loan");
    gates.push("REGZ_1026_23_RESCISSION_3SBD_GATE");
  }
  const fp = firstPaymentTwoMonthsGate({ first_payment_date: f.interest.first_payment_date, disbursement_date: f.scheduled_funding_date }); if (!fp.open) throw new FundingRefused("FNMA_B2_1_5_FIRST_PAYMENT_2M", "C2-2-01", fp.reason ?? "closed"); gates.push("FNMA_B2_1_5_FIRST_PAYMENT_2M");
  if (!i.conditions.passed) throw new FundingRefused("FUNDING_CONDITIONS", "26.3 rule 1", `checklist not passed: blocking ${i.conditions.blocking_codes.join(", ") || "none"}; pending ${i.conditions.pending_codes.join(", ") || "none"}`);
  if (!f.worksheet?.reconciled) throw new FundingRefused("FC_FIGURES_RECONCILED", "26.3 rule 4: never funds a loan whose worksheet does not reconcile", "worksheet not reconciled");
  const on = civil(i.at, "America/New_York");
  if (on < f.earliest_funding_date) throw new FundingRefused("BEFORE_EARLIEST_FUNDING_DATE", "26.3 rule 6", `${on} is before earliest_funding_date ${f.earliest_funding_date}`);
  const advance_request = { funding_id: f.funding_id, application_id: f.application_id, note_amount_cents: String(f.gross_loan_cents), net_disbursement_cents: String(f.worksheet.net_wire_cents), note_date: f.note_date, scheduled_funding_date: f.scheduled_funding_date, legal_form: f.legal_form, worksheet_version: f.worksheet.version };
  const funding = transition(transition(f, "conditions_met"), "authorized");
  const e1 = emit(events, f.application_id, "funding.authorized", { funding_id: f.funding_id, gates_asserted: gates, advance_request, checklist_id: i.conditions.checklist_id, delivery_window_compressed: f.delivery_window_compressed, lpi_date: f.interest.lpi_date, lpi_45_date: f.interest.lpi_45_date, first_payment_date: f.interest.first_payment_date, interest_mode: f.interest.mode }, i.at);
  return { funding, events: [e1], gates_asserted: gates, advance_request };
}
export function recordAdvanceApproved(f: Funding, advance_id: string): Funding { return { ...transition(f, "advance_approved"), warehouse_advance_id: advance_id }; }

// ============================================================ rule 7: BEC scoring (`scoreBecIndicators`), wire preparation, four-eyes, dual-control release
export interface InboundInstruction {
  readonly received_at: string; readonly channel: "email" | "portal" | "phone" | "letterhead"; readonly sender_email?: string | null; readonly registered_email_domain?: string | null; readonly display_name?: string | null; readonly registered_display_name?: string | null;
  readonly account_hash?: string | null; readonly verified_account_hash?: string | null; readonly beneficiary_known?: boolean; readonly beneficiary_bank_country?: string | null; readonly markings?: readonly string[]; readonly limited_time_to_confirm?: boolean; readonly additional_payment_after_first?: boolean; readonly new_payee_no_history?: boolean;
}
export type BecIndicator = "altered_sender_domain" | "altered_display_name" | "urgent_secret_confidential_marking" | "changed_account_at_known_beneficiary" | "foreign_beneficiary_bank" | "new_payee_without_history" | "limited_time_to_confirm" | "additional_payment_after_first";
export interface BecScore { readonly indicators: readonly BecIndicator[]; readonly score: number; readonly hold: boolean; readonly callback_required: boolean; readonly callback_number_source: "alta_registry" | "underwriter"; readonly officer_and_fraud_case: boolean; readonly earliest_release_after_confirmation: PlainDate; readonly prepare_from: "verified_record_only"; readonly citation: string; }
const domainOf = (email: string): string => email.toLowerCase().split("@")[1] ?? "";
/** FIN-2016-A003 red flags. Any hit → hold + callback to a registry/underwriter number (never the e-mail's); a change on the funding day → the earliest release is the next Fedwire day (no same-day changes). */
export function scoreBecIndicators(i: InboundInstruction, funding_date: PlainDate, time_zone = "America/New_York"): BecScore {
  const hits: BecIndicator[] = [];
  if (i.channel === "email" && i.sender_email && i.registered_email_domain && domainOf(i.sender_email) !== i.registered_email_domain.toLowerCase()) hits.push("altered_sender_domain");
  if (i.display_name && i.registered_display_name && i.display_name.trim().toLowerCase() !== i.registered_display_name.trim().toLowerCase()) hits.push("altered_display_name");
  if ((i.markings ?? []).some((m) => /urgent|secret|confidential/i.test(m))) hits.push("urgent_secret_confidential_marking");
  if (i.beneficiary_known !== false && i.account_hash && i.verified_account_hash && i.account_hash !== i.verified_account_hash) hits.push("changed_account_at_known_beneficiary");
  if (i.beneficiary_bank_country && i.beneficiary_bank_country !== "US") hits.push("foreign_beneficiary_bank");
  if (i.new_payee_no_history || i.beneficiary_known === false) hits.push("new_payee_without_history");
  if (i.limited_time_to_confirm) hits.push("limited_time_to_confirm");
  if (i.additional_payment_after_first) hits.push("additional_payment_after_first");
  const received_on = civil(i.received_at, time_zone);
  const changeDay = received_on >= funding_date ? received_on : funding_date;
  return { indicators: hits, score: hits.length, hold: hits.length > 0, callback_required: hits.length > 0, callback_number_source: "alta_registry", officer_and_fraud_case: hits.length >= 2, earliest_release_after_confirmation: hits.length > 0 ? addBusinessDays(changeDay, 1, fedwire) : funding_date, prepare_from: "verified_record_only", citation: "FinCEN FIN-2016-A003 / FIN-2019-A005" };
}
export function recordBecHold(events: EventStore, f: Funding, s: BecScore, at: string): { funding: Funding; events: readonly DomainEvent[] } {
  if (!s.hold) return { funding: f, events: [] };
  const h = holdFunding(events, f, "bec_indicator", at, { indicators: [...s.indicators], score: s.score, callback_required: s.callback_required, callback_number_source: s.callback_number_source, earliest_release_after_confirmation: s.earliest_release_after_confirmation, officer_and_fraud_case: s.officer_and_fraud_case });
  const out: DomainEvent[] = [h.event];
  if (s.officer_and_fraud_case) out.push(emit(events, f.application_id, "funding.fraud_case.requested", { funding_id: f.funding_id, reason: "bec_indicators", indicators: [...s.indicators], escalate_to: "officer", fraud_case_process: "28.4" }, at));
  return { funding: h.funding, events: out };
}
export interface VerifiedWireRecord { readonly verification_id: string; readonly beneficiary_party_id: string; readonly beneficiary_name: string; readonly instructions_hash: string; readonly verified_at: string | null; readonly expires_at: string | null; readonly blocks_disbursement: boolean; readonly change_detected_at: string | null; readonly callback_number_source: string | null; readonly cpl_agent_party_id: string | null; readonly ofac_screen_ref: string | null; readonly ofac_clear: boolean; }
export interface FourEyes { readonly instructions_hash_match: boolean; readonly verification_unexpired: boolean; readonly change_freeze_ok: boolean; readonly ofac_screen_ref: string | null; readonly ofac_clear: boolean; readonly amount_matches_worksheet: boolean; readonly beneficiary_matches_cpl: boolean; readonly all_pass: boolean; readonly failures: readonly string[]; }
export function runFourEyesChecks(i: { prepared_hash: string; amount_cents: Cents; worksheet_net_cents: Cents | null; record: VerifiedWireRecord; as_of: string; funding_date: PlainDate }): FourEyes {
  const gate = wireVerificationGate({ verified_at: i.record.verified_at, change_detected_at: i.record.change_detected_at, blocks_disbursement: i.record.blocks_disbursement, callback_number_source: i.record.callback_number_source, as_of: i.as_of });
  const hash = i.prepared_hash === i.record.instructions_hash;
  const unexpired = !!i.record.verified_at && !gate.reasons.includes("wire_verification_older_than_30_days") && (!i.record.expires_at || Date.parse(i.record.expires_at) >= Date.parse(i.as_of));
  // (iii) 24.4 encodes the 48-hour freeze on the record (verifyWireInstructions → blocks_disbursement / release_requires; releaseWireBlock clears it after the funding_approver's second callback); a change after the last verification, or on the funding day itself, is never releasable same-day.
  const changedAfterVerification = !!i.record.change_detected_at && (!i.record.verified_at || Date.parse(i.record.change_detected_at) > Date.parse(i.record.verified_at));
  const changedOnFundingDay = !!i.record.change_detected_at && civil(i.record.change_detected_at, "America/New_York") >= i.funding_date;
  const freeze = !i.record.blocks_disbursement && !changedAfterVerification && !changedOnFundingDay;
  const amount = i.worksheet_net_cents !== null && i.amount_cents === i.worksheet_net_cents;
  const cpl = !!i.record.cpl_agent_party_id && i.record.cpl_agent_party_id === i.record.beneficiary_party_id;
  const failures = [!hash && "instructions_hash_mismatch", !unexpired && "verification_expired", !freeze && "change_inside_48h_freeze", !i.record.ofac_clear && "ofac_not_clear", !amount && "amount_differs_from_worksheet", !cpl && "beneficiary_not_cpl_agent"].filter((x): x is string => typeof x === "string");
  return { instructions_hash_match: hash, verification_unexpired: unexpired, change_freeze_ok: freeze, ofac_screen_ref: i.record.ofac_screen_ref, ofac_clear: i.record.ofac_clear, amount_matches_worksheet: amount, beneficiary_matches_cpl: cpl, all_pass: failures.length === 0, failures };
}
export type WireStatus = "prepared" | "pending_release" | "released" | "accepted" | "settled" | "rejected" | "returned" | "recalled";
export interface FundingWire {
  readonly wire_id: string; readonly funding_id: string; readonly application_id: string; readonly kind: "funding" | "return" | "unwind_refund" | "curtailment"; readonly direction: "out" | "in"; readonly amount_cents: Cents; readonly value_date: PlainDate;
  readonly originator_account_ref: string; readonly beneficiary_party_id: string; readonly beneficiary_verification_id: string; readonly beneficiary_name_on_wire: string; readonly originator_to_beneficiary_info: string; readonly instructions_hash: string;
  readonly prepared_at: string; readonly prepared_by_run_id: string; readonly editors: readonly string[]; readonly four_eyes_check: FourEyes; readonly posting_target: typeof WAREHOUSE_ADVANCE_RECEIVABLE;
  readonly released_by: string | null; readonly released_at: string | null; readonly bank_ref: string | null; readonly imad: string | null; readonly omad: string | null; readonly status: WireStatus; readonly reject_reason: string | null; readonly recall_requested_at: string | null; readonly recall_outcome: string | null;
}
export interface PrepareWireInput {
  readonly wire_id: string; readonly funding: Funding; readonly record: VerifiedWireRecord; readonly instructions_hash: string; readonly instructions_source: "verified_record" | "email" | "portal"; readonly value_date: PlainDate; readonly prepared_at: string; readonly run_id: string;
  readonly editors: readonly string[]; readonly borrower_last_name: string; readonly property_short: string; readonly funding_account_ref_hash: string;
  readonly closing_documents: readonly { kind: string; assignee?: string | null }[]; readonly sm_party_names?: readonly string[]; readonly replacement_for_missing_wire?: boolean; readonly officer_approval_id?: string | null; readonly existing_wire?: FundingWire | null;
}
/** Rule 7 / rule 9: beneficiary = the verified settlement-agent account only; originator-to-beneficiary text names the partner as lender; no assignment/endorsement to SM may exist; posting target = warehouse_advance_receivable. */
export function prepareWire(i: PrepareWireInput): FundingWire {
  const f = i.funding;
  if (i.instructions_source === "email") throw new FundingRefused("WIRE_INSTRUCTIONS_FROM_EMAIL", "26.3 guardrails: never accepts wire instructions from e-mail", "instructions must come from the 24.4 verified record");
  if (i.instructions_hash !== i.record.instructions_hash) throw new FundingRefused("WIRE_NOT_VERIFIED_RECORD", "26.3 rule 7 (i): the original verified instructions are the only ones the agent may prepare", "prepared instructions differ from wire_verifications");
  if (i.existing_wire && ["released", "accepted", "settled"].includes(i.existing_wire.status) && !i.officer_approval_id) throw new FundingRefused("NO_SECOND_WIRE", "26.3 rule 7: never a replacement wire for a 'missing' wire without officer approval — bank trace with OMAD", `wire ${i.existing_wire.wire_id} is ${i.existing_wire.status}`);
  if (i.replacement_for_missing_wire && !i.officer_approval_id) throw new FundingRefused("NO_SECOND_WIRE", "26.3 rule 7", "replacement wire needs officer approval");
  if (f.status !== "advance_approved") throw new FundingRefused("WIRE_BEFORE_ADVANCE", "26.3 state machine: wire prepared after warehouse.advance.approved", `funding is ${f.status}`);
  assertLegalForm(f.legal_form);
  const sm = (i.sm_party_names ?? ["Supermortgage", "SM"]).map((s) => s.toLowerCase());
  const toSm = i.closing_documents.filter((d) => /assignment|allonge|endorsement/i.test(d.kind) && !!d.assignee && sm.some((s) => d.assignee!.toLowerCase().includes(s)));
  if (toSm.length) throw new FundingRefused("ASSIGNMENT_TO_SM", "26.3 rule 9 / 26.4: no assignment, allonge or endorsement to SM is ever generated (endorsement in blank only)", toSm.map((d) => d.kind).join(", "));
  if (!f.worksheet?.reconciled) throw new FundingRefused("FC_FIGURES_RECONCILED", "26.3 rule 4", "worksheet not reconciled");
  const amount = f.worksheet.net_wire_cents;
  const four = runFourEyesChecks({ prepared_hash: i.instructions_hash, amount_cents: amount, worksheet_net_cents: amount, record: i.record, as_of: i.prepared_at, funding_date: i.value_date });
  return { wire_id: i.wire_id, funding_id: f.funding_id, application_id: f.application_id, kind: "funding", direction: "out", amount_cents: amount, value_date: i.value_date, originator_account_ref: i.funding_account_ref_hash, beneficiary_party_id: i.record.beneficiary_party_id, beneficiary_verification_id: i.record.verification_id, beneficiary_name_on_wire: i.record.beneficiary_name,
    originator_to_beneficiary_info: `Lender: ${f.partner_id}; Partner loan ${f.partner_loan_number}; ${i.borrower_last_name}; ${i.property_short}; funds advanced by SM under the warehouse credit agreement (27.1)`, instructions_hash: i.instructions_hash, prepared_at: i.prepared_at, prepared_by_run_id: i.run_id, editors: [...new Set(i.editors)], four_eyes_check: four, posting_target: WAREHOUSE_ADVANCE_RECEIVABLE,
    released_by: null, released_at: null, bank_ref: null, imad: null, omad: null, status: four.all_pass ? "pending_release" : "prepared", reject_reason: null, recall_requested_at: null, recall_outcome: null };
}
export function recordWirePrepared(events: EventStore, f: Funding, w: FundingWire): { funding: Funding; event: DomainEvent } {
  if (!w.four_eyes_check.all_pass) throw new FundingRefused("FOUR_EYES_FAILED", "26.3 rule 7", w.four_eyes_check.failures.join(", "));
  const funding = { ...transition(f, "wire_pending_release"), wire_id: w.wire_id, net_wire_cents: w.amount_cents };
  return { funding, event: emit(events, f.application_id, "funding.wire.prepared", { funding_id: f.funding_id, wire_id: w.wire_id, amount_cents: String(w.amount_cents), value_date: w.value_date, prepared_at: w.prepared_at, four_eyes_check: w.four_eyes_check, escalate_to: "funding_approver" }, w.prepared_at) };
}
/** Same-day value needs release by 13:00 ET (27.1 SM_WH_ADVANCE_CUTOFF_GATE); later → the next Fedwire day. */
export function wireCutoff(released_at: string, value_date: PlainDate): { same_day: boolean; effective_value_date: PlainDate } {
  const cutoff = zonedEpochMs(value_date, WIRE_CUTOFF_ET, "America/New_York");
  const same = Date.parse(released_at) <= cutoff && civil(released_at, "America/New_York") <= value_date;
  return { same_day: same, effective_value_date: same ? value_date : addBusinessDays(later(value_date, civil(released_at, "America/New_York")), same ? 0 : 1, fedwire) };
}
export interface ReleaseInput { readonly by: Actor; readonly released_at: string; readonly bank_ref: string; readonly time_zone?: string; }
/** Dual control: a human funding_approver distinct from every editor of the worksheet/wire releases in the bank channel; the agent never releases. */
export function releaseWire(events: EventStore, f: Funding, w: FundingWire, i: ReleaseInput): { funding: Funding; wire: FundingWire; events: readonly DomainEvent[]; cutoff: ReturnType<typeof wireCutoff> } {
  if (i.by.kind !== "human" || i.by.role !== "funding_approver") throw new FundingRefused("RELEASE_NEEDS_FUNDING_APPROVER", "26.3 automation class: the only human step is the funding_approver release (dual control)", `${i.by.kind}:${i.by.id} may not release`);
  if (w.editors.includes(i.by.id)) throw new FundingRefused("RELEASE_BY_EDITOR", "26.3 rule 7: the approver must not be the person who edited any instruction — released_by must differ from every editor", `${i.by.id} edited the worksheet/wire`);
  if (w.status !== "pending_release" || !w.four_eyes_check.all_pass) throw new FundingRefused("WIRE_NOT_RELEASABLE", "26.3 rule 7", `wire is ${w.status}`);
  if (f.status !== "wire_pending_release") throw new FundingRefused("RELEASE_STATE", "26.3 state machine", `funding is ${f.status}`);
  const cutoff = wireCutoff(i.released_at, w.value_date);
  const out: DomainEvent[] = [];
  let funding = f;
  if (!cutoff.same_day) { out.push(emit(events, f.application_id, "funding.date.resynced", { funding_id: f.funding_id, old: w.value_date, new: cutoff.effective_value_date, reason: "released after 13:00 ET cutoff" }, i.released_at)); funding = { ...funding, scheduled_funding_date: cutoff.effective_value_date }; }
  const wire: FundingWire = { ...w, status: "released", released_by: i.by.id, released_at: i.released_at, bank_ref: i.bank_ref, value_date: cutoff.effective_value_date };
  funding = { ...transition(funding, "wire_released"), funding_date: cutoff.effective_value_date };
  out.push(emit(events, f.application_id, "funding.wire.released", { funding_id: f.funding_id, wire_id: w.wire_id, by: i.by.id, released_by: i.by.id, released_at: i.released_at, value_date: wire.value_date, amount_cents: String(w.amount_cents), bank_ref: i.bank_ref, same_day: cutoff.same_day }, i.released_at, i.by));
  return { funding, wire, events: out, cutoff };
}
export function acceptWire(events: EventStore, f: Funding, w: FundingWire, i: { imad: string; accepted_at: string }): { funding: Funding; wire: FundingWire; event: DomainEvent } {
  if (w.status !== "released") throw new FundingRefused("ACCEPT_STATE", "26.3", `wire is ${w.status}`);
  const wire: FundingWire = { ...w, status: "accepted", imad: i.imad };
  return { funding: transition(f, "wire_accepted"), wire, event: emit(events, f.application_id, "funding.wire.accepted", { funding_id: f.funding_id, wire_id: w.wire_id, imad: i.imad, accepted_at: i.accepted_at, value_date: w.value_date, amount_cents: String(w.amount_cents) }, i.accepted_at) };
}
export function settleWire(events: EventStore, w: FundingWire, i: { omad: string; settled_at: string }): { wire: FundingWire; event: DomainEvent } {
  return { wire: { ...w, status: "settled", omad: i.omad }, event: emit(events, w.application_id, "funding.wire.settled", { funding_id: w.funding_id, wire_id: w.wire_id, omad: i.omad, settled_at: i.settled_at }, i.settled_at) };
}
export function rejectWire(events: EventStore, f: Funding, w: FundingWire, i: { reason: string; at: string }): { funding: Funding; wire: FundingWire; event: DomainEvent } {
  return { funding: transition(f, "held"), wire: { ...w, status: "rejected", reject_reason: i.reason }, event: emit(events, f.application_id, "funding.wire.rejected", { funding_id: f.funding_id, wire_id: w.wire_id, reason: i.reason, next: "correct and re-release under a new wire_id with a new four-eyes record" }, i.at) };
}
/** SM_O73_WIRE_ACCEPT_30M breach: contact the bank; never a second wire (prepareWire refuses without officer approval). */
export function wireAcceptOverdue(events: EventStore, f: Funding, w: FundingWire, at: string): { event: DomainEvent; second_wire_allowed: false } {
  return { event: emit(events, f.application_id, "funding.wire.bank_contacted", { funding_id: f.funding_id, wire_id: w.wire_id, reason: "IMAD not received within 30 minutes of release", released_at: w.released_at, action: "bank contact; if rejected → correct and re-release (new four-eyes check); no second wire" }, at), second_wire_allowed: false };
}
export function confirmAgentReceipt(events: EventStore, f: Funding, i: { funds_received_by_agent_at: string; channel: "portal" | "callback" | "verified_email"; confirmed_by: string }): { funding: Funding; event: DomainEvent } {
  if (i.channel === "verified_email" || i.channel === "portal" || i.channel === "callback") { /* verified channels only — 24.4 exchange */ }
  const funding = { ...transition(f, "funds_at_agent"), funds_received_by_agent_at: i.funds_received_by_agent_at };
  return { funding, event: emit(events, f.application_id, "funding.agent_receipt.confirmed", { funding_id: f.funding_id, wire_id: f.wire_id, funds_received_by_agent_at: i.funds_received_by_agent_at, channel: i.channel, confirmed_by: i.confirmed_by }, i.funds_received_by_agent_at) };
}
export function returnWire(events: EventStore, f: Funding, w: FundingWire, i: { returned_cents: Cents; returned_at: string; matched_advance_id: string | null }): { funding: Funding; wire: FundingWire; event: DomainEvent } {
  const funding = transition(f, "returned");
  return { funding, wire: { ...w, status: "returned" }, event: emit(events, f.application_id, "funding.wire.returned", { funding_id: f.funding_id, wire_id: w.wire_id, returned_cents: String(i.returned_cents), returned_at: i.returned_at, matched_advance_id: i.matched_advance_id }, i.returned_at) };
}

// ============================================================ wet-state table funding (rule 6) — SM_O73_WET_FUNDS_AT_TABLE_GATE, disbursement authorization
export function wetFundsAtTableGate(f: { funding_type: FundingType | null; wire_accepted_at: string | null; wire_value_date: PlainDate | null; closing_date: PlainDate | null; signing_start_at: string | null; pre_signing_subset_passed: boolean }): { open: boolean; reason?: string } {
  if (f.funding_type === "dry") return { open: true };
  if (!f.pre_signing_subset_passed) return { open: false, reason: "SM_O73_WET_FUNDS_AT_TABLE_GATE: the pre-signing subset of funding_conditions has not passed (release window closed)" };
  if (!f.wire_accepted_at) return { open: false, reason: "SM_O73_WET_FUNDS_AT_TABLE_GATE: funds not accepted (IMAD) before signing — signing proceeds only with the settlement agent's written hold-in-escrow agreement" };
  if (f.wire_value_date && f.closing_date && f.wire_value_date !== f.closing_date) return { open: false, reason: `SM_O73_WET_FUNDS_AT_TABLE_GATE: wire value date ${f.wire_value_date} ≠ closing date ${f.closing_date}` };
  if (f.signing_start_at && Date.parse(f.wire_accepted_at) > Date.parse(f.signing_start_at)) return { open: false, reason: `SM_O73_WET_FUNDS_AT_TABLE_GATE: wire accepted ${f.wire_accepted_at} after signing start ${f.signing_start_at}` };
  return { open: true };
}
/** After 26.2's execution review passes, the disbursement authorization (funding number) goes to the settlement agent through the verified channel (`notifySettlementAgent`). */
export function issueDisbursementAuthorization(events: EventStore, f: Funding, i: { execution_review_passed_at: string; issued_at: string; channel: "portal" | "verified_email" | "callback"; funding_number: string }): DomainEvent {
  if (f.funding_type !== "wet") throw new FundingRefused("AUTHORIZATION_MODE", "26.3 rule 6", "disbursement authorization is the wet-state (table_funds_then_authorize) step");
  if (f.status !== "funds_at_agent" && f.status !== "wire_accepted") throw new FundingRefused("AUTHORIZATION_STATE", "26.3 rule 6: funds must be at the table", `funding is ${f.status}`);
  if (Date.parse(i.issued_at) < Date.parse(i.execution_review_passed_at)) throw new FundingRefused("AUTHORIZATION_BEFORE_REVIEW", "26.3 rule 6: after signing, 26.2's execution review completes the remaining items first", "issued before closing.execution_review.passed");
  return emit(events, f.application_id, "funding.disbursement.authorized", { funding_id: f.funding_id, funding_number: i.funding_number, channel: i.channel, issued_at: i.issued_at, execution_review_passed_at: i.execution_review_passed_at }, i.issued_at);
}
export function notifySettlementAgent(events: EventStore, f: Funding, i: { kind: "wire_notice" | "disbursement_authorization" | "return_demand" | "recall_notice"; channel: "portal" | "verified_email" | "callback"; at: string; detail?: Record<string, unknown> }): DomainEvent {
  return emit(events, f.application_id, "funding.settlement_agent.notified", { funding_id: f.funding_id, kind: i.kind, channel: i.channel, ...(i.detail ?? {}) }, i.at);
}

// ============================================================ disbursement confirmation → `loan.funded` (the payload 30.2 reads)
export interface ConfirmDisbursementInput { readonly disbursement_date: PlainDate; readonly confirmed_at: string; readonly source: DisbursementSource; readonly evidence_document_id: string | null; readonly escrow_deposit_cents: Cents; readonly time_zone?: string; }
export type LoanFundedEvent = LoanFundedPayload & { readonly funding_id: string; readonly first_payment_date: PlainDate; readonly lpi_date: PlainDate; readonly maturity_date_expected: PlainDate; readonly interest_accrual_start_date: PlainDate; readonly interest_mode: InterestMode; readonly interest_credit_cents: Cents; readonly prepaid_days: number; readonly escrow_deposit_cents: Cents; readonly net_wire_cents: Cents; readonly worksheet_version: number | null; readonly delivery_window_compressed: boolean; readonly source: "origination" };
export function confirmDisbursement(events: EventStore, f: Funding, i: ConfirmDisbursementInput): { funding: Funding; events: readonly DomainEvent[]; loan_funded: LoanFundedEvent } {
  if (f.status !== "funds_at_agent" && f.status !== "wire_accepted") throw new FundingRefused("DISBURSE_STATE", "26.3 state machine: disbursed requires funds at the agent", `funding is ${f.status}`);
  if (!f.passed_wire_pending_release) throw new FundingRefused("SKIPPED_STATE", "26.3 state machine: no transition may skip wire_pending_release", "funding never passed wire_pending_release");
  if (!f.funding_date || !f.wire_id) throw new FundingRefused("DISBURSE_STATE", "26.3", "no released wire");
  if (i.disbursement_date < f.funding_date) throw new FundingRefused("DISBURSEMENT_BEFORE_FUNDING", "26.3 data model: disbursement_date equals funding_date unless the agent disburses later", `${i.disbursement_date} < ${f.funding_date}`);
  const interest = i.disbursement_date === f.scheduled_funding_date ? f.interest : decideInterestMode({ disbursement_date: i.disbursement_date, gross_loan_cents: f.gross_loan_cents, note_rate_pct: f.note_rate_pct, borrower_elected_credit: f.interest.mode === "interest_credit" });
  const funding: Funding = { ...transition(f.status === "wire_accepted" ? transition(f, "funds_at_agent") : f, "disbursed"), disbursement_date: i.disbursement_date, disbursement_confirmed_at: i.confirmed_at, disbursement_confirmation_source: i.source, interest };
  const e1 = emit(events, f.application_id, "funding.disbursement.confirmed", { funding_id: f.funding_id, disbursement_date: i.disbursement_date, source: i.source, evidence_document_id: i.evidence_document_id, confirmed_at: i.confirmed_at }, i.confirmed_at);
  const loan_funded: LoanFundedEvent = { application_id: f.application_id, funding_id: f.funding_id, funded_at: i.confirmed_at, funding_date: f.funding_date, disbursement_date: i.disbursement_date, wire_id: f.wire_id, funded_amount_cents: f.gross_loan_cents, per_diem_cents: interest.per_diem_cents, prepaid_interest_cents: interest.prepaid_interest_cents, interest_credit: interest.mode === "interest_credit", rescission_expires_at: f.rescission_expires_at,
    first_payment_date: interest.first_payment_date, lpi_date: interest.lpi_date, maturity_date_expected: interest.maturity_date_expected, interest_accrual_start_date: interest.interest_accrual_start_date, interest_mode: interest.mode, interest_credit_cents: interest.interest_credit_cents, prepaid_days: interest.prepaid_days, escrow_deposit_cents: i.escrow_deposit_cents, net_wire_cents: f.net_wire_cents ?? f.worksheet?.net_wire_cents ?? 0n, worksheet_version: f.worksheet?.version ?? null, delivery_window_compressed: interest.delivery_window_compressed, source: "origination" };
  const e2 = events.append({ type: "loan.funded", applicationId: f.application_id, actor: FUNDER, occurredAt: i.confirmed_at, causationId: e1.id, payload: { ...loan_funded, funded_amount_cents: String(loan_funded.funded_amount_cents), per_diem_cents: String(loan_funded.per_diem_cents), prepaid_interest_cents: String(loan_funded.prepaid_interest_cents), interest_credit_cents: String(loan_funded.interest_credit_cents), escrow_deposit_cents: String(loan_funded.escrow_deposit_cents), net_wire_cents: String(loan_funded.net_wire_cents) } });
  return { funding, events: [e1, e2], loan_funded: { ...loan_funded, event_id: e2.id } };
}

// ============================================================ SM_O73_DATE_RESYNC (`resyncDates`)
export interface ResyncInput { readonly new_date: PlainDate; readonly at: string; readonly reason: string; readonly hazard?: Parameters<typeof hazardEvidenceGate>[0] | null; readonly payoffs?: readonly { liability_id: string; status: string; good_through_date: PlainDate | null }[] | null; readonly consummated_cd?: { disbursement_date: PlainDate | null; prepaid_interest_cents: Cents | null } | null; readonly vvoe?: { verified_on: PlainDate | null; self_employed: boolean } | null; }
export interface Resync { readonly funding: Funding; readonly events: readonly DomainEvent[]; readonly hazard: { code: "FC_HAZARD_EVIDENCE"; status: FcStatus; note: string | null }; readonly payoff: { code: "FC_PAYOFF_GOOD_THROUGH"; status: FcStatus; note: string | null }; readonly first_payment_gate: ReturnType<typeof firstPaymentTwoMonthsGate>; readonly corrected_cd_review: { asked: boolean; reasons: readonly string[] }; readonly held: boolean; }
export function resyncDates(events: EventStore, f: Funding, i: ResyncInput): Resync {
  const old = f.scheduled_funding_date;
  const out: DomainEvent[] = [emit(events, f.application_id, "funding.date.change_requested", { funding_id: f.funding_id, old, new: i.new_date, reason: i.reason }, i.at)];
  const interest = decideInterestMode({ disbursement_date: i.new_date, gross_loan_cents: f.gross_loan_cents, note_rate_pct: f.note_rate_pct, borrower_elected_credit: f.interest.mode === "interest_credit", note_first_payment_date: f.interest.redraw_required ? null : f.interest.first_payment_date });
  const hz = i.hazard ? hazardEvidenceGate({ ...i.hazard, disbursement_date: i.new_date }) : null;
  const hazard = { code: "FC_HAZARD_EVIDENCE" as const, status: (hz ? (hz.open ? "pass" : "fail") : "pending") as FcStatus, note: hz ? hz.reason ?? "effective ≤ disbursement" : "hazard facts not supplied" };
  const po = i.payoffs ? payoffGoodThroughGate({ payoffs: i.payoffs, disbursement_date: i.new_date }) : null;
  const payoff = { code: "FC_PAYOFF_GOOD_THROUGH" as const, status: (po ? (po.open ? "pass" : "fail") : "pending") as FcStatus, note: po ? po.reason ?? "every payoff good through ≥ disbursement" : "payoff facts not supplied" };
  const gate = firstPaymentTwoMonthsGate({ first_payment_date: interest.first_payment_date, disbursement_date: i.new_date });
  const reasons: string[] = [];
  if (i.consummated_cd) { if (i.consummated_cd.disbursement_date && i.consummated_cd.disbursement_date !== i.new_date) reasons.push(`CD Disbursement Date ${i.consummated_cd.disbursement_date} → ${i.new_date}`); if (i.consummated_cd.prepaid_interest_cents !== null && i.consummated_cd.prepaid_interest_cents !== interest.prepaid_interest_cents) reasons.push(`CD prepaid interest ${i.consummated_cd.prepaid_interest_cents} → ${interest.prepaid_interest_cents} cents`); }
  const firstPaymentMoved = interest.first_payment_date !== f.interest.first_payment_date;
  let funding: Funding = { ...f, scheduled_funding_date: i.new_date, interest, delivery_window_compressed: interest.delivery_window_compressed };
  const held = hazard.status === "fail" || payoff.status === "fail" || !gate.open || firstPaymentMoved;
  if (held && f.status !== "held" && f.status !== "pending_conditions") { const h = holdFunding(events, funding, firstPaymentMoved ? "date_slip_changed_first_payment_date" : !gate.open ? "first_payment_2m_gate" : hazard.status === "fail" ? "hazard_effective_after_disbursement" : "payoff_good_through_stale", i.at); funding = h.funding; out.push(h.event); }
  out.push(emit(events, f.application_id, "funding.date.resynced", { funding_id: f.funding_id, old, new: i.new_date, disbursement_date: i.new_date, first_payment_date: interest.first_payment_date, first_payment_latest_allowed_date: interest.first_payment_latest_allowed_date, lpi_date: interest.lpi_date, interest_mode: interest.mode, prepaid_days: interest.prepaid_days, prepaid_interest_cents: String(interest.prepaid_interest_cents), hazard: hazard.status, payoff_good_through: payoff.status, first_payment_2m: gate.open ? "pass" : "fail", corrected_cd_review_requested: reasons.length > 0, corrected_cd_reasons: reasons, vvoe_retest: !!i.vvoe }, i.at));
  if (reasons.length) out.push(emit(events, f.application_id, "funding.corrected_cd.review_requested", { funding_id: f.funding_id, to_process: "25.2", reasons, new_disbursement_date: i.new_date, prepaid_interest_cents: String(interest.prepaid_interest_cents) }, i.at));
  return { funding, events: out, hazard, payoff, first_payment_gate: gate, corrected_cd_review: { asked: reasons.length > 0, reasons }, held };
}

// ============================================================ rule 10: cancellation and unwind (`openUnwind`)
export type UnwindTrigger = "rescission_exercised_pre_disbursement" | "rescission_exercised_post_disbursement" | "conditions_failed" | "documents_not_returned" | "agent_failed_to_disburse" | "fraud" | "borrower_withdrew" | "partner_hold";
export type FundsPosition = "not_released" | "released_not_disbursed" | "disbursed";
export interface UnwindStep { readonly step: string; readonly owner: string; readonly moves_money: boolean; readonly due_at: PlainDate; readonly refund_due_at: PlainDate | null; readonly done_at: string | null; readonly evidence: string | null; readonly approved_by: string | null; readonly process: string; }
export interface FundingUnwind { readonly unwind_id: string; readonly funding_id: string; readonly application_id: string; readonly trigger: UnwindTrigger; readonly opened_at: string; readonly funds_position: FundsPosition; readonly steps: readonly UnwindStep[]; readonly approved_by: string | null; readonly closed_at: string | null; readonly outcome: string | null; }
export const fundsPosition = (f: Funding): FundsPosition => (f.status === "disbursed" || f.status === "unwinding" || f.status === "unwound" ? "disbursed" : ["wire_released", "wire_accepted", "funds_at_agent", "returned"].includes(f.status) ? "released_not_disbursed" : "not_released");
export function unwindSteps(position: FundsPosition, ctx: { opened_on: PlainDate; refund_due_at: PlainDate | null; enote: boolean; security_instrument_recorded: boolean; prior_lien_paid: boolean }): UnwindStep[] {
  const nonMoneyDue = addBusinessDays(ctx.opened_on, 5, creditor);
  const S = (step: string, owner: string, moves_money: boolean, process: string): UnwindStep => ({ step, owner, moves_money, due_at: moves_money && ctx.refund_due_at ? ctx.refund_due_at : nonMoneyDue, refund_due_at: moves_money ? ctx.refund_due_at : null, done_at: null, evidence: null, approved_by: null, process });
  const steps: UnwindStep[] = [];
  if (position === "not_released") steps.push(S("cancel the prepared wire; withdraw the warehouse advance request", "funder", false, "27.1"));
  if (position === "released_not_disbursed") { steps.push(S("recall request / obtain return of funds from the settlement agent", "funder", true, "26.3")); steps.push(S("reverse the warehouse advance on return", "warehouse", true, "27.1")); }
  if (position === "disbursed") {
    steps.push(S("recover the escrow deposit and any undisbursed funds from the settlement agent", "funder", true, "26.3"));
    if (ctx.prior_lien_paid) steps.push(S("request the payoff-lender refund of the prior lien payoff (counsel direction — open question 3)", "officer", true, "25.3"));
    steps.push(S("partner repurchase of the advance (warehouse_advances.repaid_from = partner_repurchase)", "warehouse", true, "27.1"));
  }
  steps.push(S("void the document set and closing set (closing_document_sets.status = voided)", "closer", false, "26.1"));
  if (ctx.enote) steps.push(S("eNote Registration Reversal in the eRegistry; eVault void", "closer", false, "26.2"));
  steps.push(S("MIN reversal or deactivation", "post-closing", false, "26.4"));
  if (ctx.security_instrument_recorded) steps.push(S("release or reconveyance of the recorded security instrument prepared by the settlement agent and recorded", "post-closing", false, "26.4"));
  steps.push(S("refund every amount paid by any consumer (REGZ_1026_23D2_RESCISSION_REFUND_20)", "funder", true, "25.3"));
  if (position === "disbursed") steps.push(S("servicing de-board (30.2); reverse ledger entries with new entries", "boarding", true, "30.2"));
  steps.push(S("commitment fallout / pair-off (29.1)", "secondary", false, "29.1"));
  steps.push(S("HMDA action taken: withdrawn / approved not accepted per 28.3", "compliance", false, "28.3"));
  return steps;
}
export interface OpenUnwindInput { readonly unwind_id: string; readonly trigger: UnwindTrigger; readonly at: string; readonly time_zone?: string; readonly exercise?: Pick<RescissionExercise, "refund_due_at" | "exercise_id"> | null; readonly enote: boolean; readonly security_instrument_recorded: boolean; readonly prior_lien_paid: boolean; }
export function openUnwind(events: EventStore, f: Funding, i: OpenUnwindInput): { funding: Funding; unwind: FundingUnwind; event: DomainEvent } {
  const position = fundsPosition(f);
  if (i.trigger === "rescission_exercised_post_disbursement" && position !== "disbursed") throw new FundingRefused("UNWIND_POSITION", "26.3 rule 10(b)", `post-disbursement rescission unwind on a funding that is ${f.status}`);
  const steps = unwindSteps(position, { opened_on: civil(i.at, i.time_zone ?? "America/New_York"), refund_due_at: i.exercise?.refund_due_at ?? null, enote: i.enote, security_instrument_recorded: i.security_instrument_recorded, prior_lien_paid: i.prior_lien_paid });
  const unwind: FundingUnwind = { unwind_id: i.unwind_id, funding_id: f.funding_id, application_id: f.application_id, trigger: i.trigger, opened_at: i.at, funds_position: position, steps, approved_by: null, closed_at: null, outcome: null };
  const funding: Funding = position === "disbursed" ? { ...transition(f, "unwinding"), unwind_id: i.unwind_id } : { ...f, unwind_id: i.unwind_id };
  const event = emit(events, f.application_id, "funding.unwind.opened", { funding_id: f.funding_id, unwind_id: i.unwind_id, trigger: i.trigger, funds_position: position, opened_at: i.at, steps: steps.map((s) => ({ step: s.step, owner: s.owner, moves_money: s.moves_money, due_at: s.due_at, refund_due_at: s.refund_due_at })), exercise_id: i.exercise?.exercise_id ?? null }, i.at, FUNDER, f.loan_id);
  return { funding, unwind, event };
}
/** A step that moves money after disbursement executes only with an `officer` approval record. */
export function executeUnwindStep(u: FundingUnwind, index: number, i: { actor: Actor; at: string; evidence: string }): FundingUnwind {
  const s = u.steps[index]; if (!s) throw new RangeError(`no unwind step ${index}`);
  if (s.moves_money && u.funds_position === "disbursed" && !(i.actor.kind === "human" && i.actor.role === "officer")) throw new FundingRefused("UNWIND_MONEY_NEEDS_OFFICER", "26.3 automation class: officer sign-off on any unwind that moves money after disbursement", `step '${s.step}' moves money — ${i.actor.kind}:${i.actor.id} is not the officer`);
  const steps = u.steps.map((x, k) => (k === index ? { ...x, done_at: i.at, evidence: i.evidence, approved_by: s.moves_money ? `${i.actor.kind}:${i.actor.id}` : x.approved_by } : x));
  return { ...u, steps };
}
export function completeUnwind(events: EventStore, f: Funding, u: FundingUnwind, i: { at: string; by: Actor; outcome: string }): { funding: Funding; unwind: FundingUnwind; event: DomainEvent } {
  const open = u.steps.filter((s) => !s.done_at); if (open.length) throw new FundingRefused("UNWIND_STEPS_OPEN", "26.3 rule 10", open.map((s) => s.step).join("; "));
  if (u.funds_position === "disbursed" && !(i.by.kind === "human" && i.by.role === "officer")) throw new FundingRefused("UNWIND_MONEY_NEEDS_OFFICER", "26.3", "officer signs off a post-disbursement unwind");
  const unwind = { ...u, closed_at: i.at, outcome: i.outcome, approved_by: `${i.by.kind}:${i.by.id}` };
  const funding = u.funds_position === "disbursed" ? transition(f, "unwound") : f;
  return { funding, unwind, event: emit(events, f.application_id, "funding.unwind.completed", { funding_id: f.funding_id, unwind_id: u.unwind_id, outcome: i.outcome, closed_at: i.at, on_time: u.steps.every((s) => !s.done_at || s.done_at.slice(0, 10) <= s.due_at) }, i.at, i.by, f.loan_id) };
}
export interface CancelInput { readonly reason: CancelReason; readonly at: string; readonly hpml_appraisal_rules_apply: boolean; readonly unwind_id: string; readonly enote: boolean; readonly security_instrument_recorded: boolean; }
/** Cancellation before disbursement: `funding.cancelled{reason}`, 24.2's not-consummated determination (Reg B / HPML copy clocks), and an unwind file by funds position. */
export function cancelFunding(events: EventStore, f: Funding, i: CancelInput): { funding: Funding; unwind: FundingUnwind; events: readonly DomainEvent[] } {
  const position = fundsPosition(f);
  if (position === "disbursed") throw new FundingRefused("CANCEL_AFTER_DISBURSEMENT", "26.3 rule 10(b): a disbursed loan is unwound, not cancelled", `funding is ${f.status}`);
  const funding: Funding = { ...transition(f, "cancelled"), cancel_reason: i.reason };
  const e1 = emit(events, f.application_id, "funding.cancelled", { funding_id: f.funding_id, reason: i.reason, funds_position: position, wire_id: f.wire_id, after_wire_accepted: ["wire_accepted", "funds_at_agent"].includes(f.status) }, i.at);
  const e2 = recordNotConsummated(events, { application_id: f.application_id, actor: FUNDER, at: i.at }, { cause: "funding.cancelled", decision_kind: null, determination_at: i.at, hpml_appraisal_rules_apply: i.hpml_appraisal_rules_apply, copy_required_by: addDays(civil(i.at, "America/New_York"), 30) });
  const trigger: UnwindTrigger = i.reason === "rescinded_before_funding" ? "rescission_exercised_pre_disbursement" : i.reason === "documents_not_returned" ? "documents_not_returned" : i.reason === "fraud_suspected" ? "fraud" : i.reason === "borrower_withdrew" ? "borrower_withdrew" : i.reason === "partner_hold" ? "partner_hold" : "conditions_failed";
  const u = openUnwind(events, funding, { unwind_id: i.unwind_id, trigger, at: i.at, exercise: null, enote: i.enote, security_instrument_recorded: i.security_instrument_recorded, prior_lien_paid: false });
  return { funding: u.funding, unwind: u.unwind, events: [e1, e2, u.event] };
}

// ============================================================ decision record (`writeDecision`)
export interface FunderDecisionInput { readonly funding: Funding; readonly checklist: FundingConditions | null; readonly wire?: FundingWire | null; readonly bec_score?: number | null; readonly advance?: { advance_id: string; amount_cents: Cents } | null; readonly gates_asserted: readonly string[]; readonly rationale: string; readonly confidence: number; readonly model_version: string; readonly prompt_version: string; }
export function funderDecisionRecord(i: FunderDecisionInput): Record<string, unknown> {
  const f = i.funding;
  return { funding_id: f.funding_id, checklist_snapshot: i.checklist ? { checklist_id: i.checklist.checklist_id, passed: i.checklist.passed, blocking_codes: [...i.checklist.blocking_codes], items: i.checklist.items.map((x) => ({ code: x.code, status: x.status, evidence_ref: x.evidence_ref })) } : null,
    dates: { consummation: f.consummation_at, rescission_expires_at: f.rescission_expires_at, earliest_funding_date: f.earliest_funding_date, scheduled_funding_date: f.scheduled_funding_date, disbursement_date: f.disbursement_date, first_payment_date: f.interest.first_payment_date, latest_allowed: f.interest.first_payment_latest_allowed_date, lpi_date: f.interest.lpi_date },
    interest: { mode: f.interest.mode, per_diem_cents: String(f.interest.per_diem_cents), days: f.interest.mode === "interest_credit" ? f.interest.interest_credit_days : f.interest.prepaid_days, amount_cents: String(f.interest.mode === "interest_credit" ? f.interest.interest_credit_cents : f.interest.prepaid_interest_cents) },
    worksheet: f.worksheet ? { version: f.worksheet.version, net_wire_cents: String(f.worksheet.net_wire_cents), variance_cents: f.worksheet.variance_cents === null ? null : String(f.worksheet.variance_cents) } : null,
    wire: i.wire ? { beneficiary_verification_id: i.wire.beneficiary_verification_id, instructions_hash: i.wire.instructions_hash, four_eyes: i.wire.four_eyes_check, bec_score: i.bec_score ?? 0 } : null,
    advance: i.advance ? { advance_id: i.advance.advance_id, amount_cents: String(i.advance.amount_cents) } : null,
    gates_asserted: [...i.gates_asserted], rationale: i.rationale, confidence: i.confidence, rule_set_versions: RULE_SETS_26_3, model_version: i.model_version, prompt_version: i.prompt_version, legal_form: f.legal_form, delivery_window_compressed: f.delivery_window_compressed };
}
