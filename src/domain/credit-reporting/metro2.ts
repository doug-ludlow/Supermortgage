/**
 * 8.1 Furnish tradeline — snapshot builder, field rendering, validation and
 * transmission clocks. Everything is derived from ledger/terms state; the PHP
 * is the one field carried from history (rule 4).
 */
import { type PlainDate, addDays, addMonths, daysBetween, endOfMonth, parts, plainDate } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { type Cents, sumCents } from "../../kernel/money/cents.ts";
import { earliestUnpaidDueDate, isUnpaidAsOf } from "../boarding/delinquency.ts";
import {
  type AccountStatus, type CreditLoanState, type CreditPolicy, type ConsumerSegment, type Ecoa, type Metro2Snapshot,
  type PaymentRating, type PhpChar, type PriorHistory, type RoundingPolicy, type SpecialComment, DEFAULT_POLICY, STATUS_TO_PHP,
} from "./types.ts";

/** Days past due → Account Status (rule 1). */
export function statusForDays(days: number): AccountStatus {
  if (days < 30) return "11";
  if (days < 60) return "71";
  if (days < 90) return "78";
  if (days < 120) return "80";
  if (days < 150) return "82";
  if (days < 180) return "83";
  return "84";
}

/** Payment Rating at close = the delinquency bucket at that date. */
export function paymentRatingForDays(days: number): PaymentRating {
  const s = statusForDays(days);
  return { "11": "0", "71": "1", "78": "2", "80": "3", "82": "4", "83": "5", "84": "6" }[s as "11"] as PaymentRating;
}

/** 9-digit whole-dollar field (rule 2; 8.1-T19). */
export function metro2Money(c: Cents, rounding: RoundingPolicy = "truncate"): string {
  const abs = c < 0n ? -c : c;
  const dollars = rounding === "truncate" ? abs / 100n : (abs + 50n) / 100n;
  return dollars.toString().padStart(9, "0").slice(-9);
}

/** MMDDYYYY, zero-filled when null. */
export function metro2Date(d: PlainDate | null): string {
  if (d === null) return "00000000";
  const { y, m, d: dd } = parts(d);
  return `${String(m).padStart(2, "0")}${String(dd).padStart(2, "0")}${y}`;
}

export function phpCharFor(status: AccountStatus | null, omitted = false): PhpChar {
  if (omitted || status === null) return "D";
  return STATUS_TO_PHP[status] ?? "0";
}

/**
 * Carry the 24-character PHP forward: position 1 = the month before `as_of`,
 * which is the status the prior snapshot reported (rule 4). No prior history →
 * `B` × 24 (rule 14).
 */
/** Accept either a stored PriorHistory or last cycle's snapshot. */
export function toPrior(p: PriorHistory | Metro2Snapshot | null): PriorHistory | null {
  if (p === null) return null;
  if ("account_status" in p) return { php: p.php, status: p.account_status, dofd: p.dofd };
  return p;
}

export function carryPhp(priorIn: PriorHistory | Metro2Snapshot | null): string {
  const prior = toPrior(priorIn);
  if (prior === null) return "B".repeat(24);
  const ch = phpCharFor(prior.status, prior.omitted === true);
  return (ch + prior.php).slice(0, 24);
}

/** PHP position (1-based) that represents calendar month `month` for a snapshot as of `asOf`; null when outside 24 months. */
export function phpPosition(asOf: PlainDate, month: PlainDate): number | null {
  const a = parts(asOf), m = parts(month);
  const pos = (a.y - m.y) * 12 + (a.m - m.m);
  return pos >= 1 && pos <= 24 ? pos : null;
}

export function setPhp(php: string, position: number, ch: PhpChar): string {
  return php.slice(0, position - 1) + ch + php.slice(position);
}

/** Last calendar day of the month containing `d` (rule 1). */
export function snapshotDate(d: PlainDate): PlainDate { return endOfMonth(d); }

export interface DelinquencyDerivation { readonly days: number; readonly earliest_unpaid: PlainDate | null; readonly amount_past_due_cents: Cents; }

/** FIFO delinquency as of the snapshot date over the given installments (rule 1). */
export function deriveDelinquency(installments: readonly CreditLoanState["installments"][number][], asOf: PlainDate): DelinquencyDerivation {
  const earliest = earliestUnpaidDueDate(installments, asOf);
  const unpaid = installments.filter((i) => isUnpaidAsOf(i, asOf) && i.due_date <= asOf);
  return {
    days: earliest === null ? 0 : Math.max(0, daysBetween(earliest, asOf)),
    earliest_unpaid: earliest,
    amount_past_due_cents: sumCents(unpaid.map((i) => i.amount_cents - i.paid_cents)),
  };
}

/**
 * DOFD: populated only with a 71+ status (rule 3, policy †); never moved later
 * while the same delinquency continues; reset only after a cure.
 */
export function deriveDofd(status: AccountStatus, earliestUnpaid: PlainDate | null, priorIn: PriorHistory | Metro2Snapshot | null): PlainDate | null {
  const prior = toPrior(priorIn);
  if (earliestUnpaid === null) return null;                                    // current → zero-filled
  if (status === "11") return null;                                            // policy †: populated only with 71+
  if (prior?.dofd && prior.dofd <= earliestUnpaid) return prior.dofd;          // same delinquency → keep the earlier anchor
  return earliestUnpaid;
}

export class DofdReageBlocked extends Error {
  readonly from: PlainDate;
  readonly to: PlainDate;
  constructor(from: PlainDate, to: PlainDate) { super(`DOFD_REAGE_BLOCKED: ${from} → ${to} requires evidence`); this.from = from; this.to = to; }
}

/** 8.1-T14: a correction may only move DOFD later with evidence (the original was wrong). */
export function correctDofd(current: PlainDate | null, proposed: PlainDate | null, evidence: string | null): PlainDate | null {
  if (current !== null && proposed !== null && proposed > current && !evidence) throw new DofdReageBlocked(current, proposed);
  return proposed;
}

function ecoaFor(c: CreditLoanState["consumers"][number]): Ecoa {
  if (c.never_liable) return "Z";
  if (c.deceased) return "X";
  if (c.released) return "T";
  return c.liability === "guarantor" ? "5" : c.liability === "joint" ? "2" : "1";
}

export function consumerSegments(state: CreditLoanState, special: SpecialComment): ConsumerSegment[] {
  return state.consumers
    .filter((c) => !c.successor_in_interest)                                   // rule 5: successors are not furnished
    .sort((a, b) => a.position - b.position)
    .map((c) => ({
      party_id: c.party_id,
      segment: c.position === 1 ? "base" : c.same_address_as_base ? "J1" : "J2",
      ecoa: ecoaFor(c),
      cii: "",
      ccc: "",
      special_comment: c.released ? "H" : special,
    }));
}

/** Build the canonical snapshot for one loan (rules 1–7, 13). Overlays from 8.3 are applied on top. */
export function buildSnapshot(state: CreditLoanState, policy: CreditPolicy = DEFAULT_POLICY): Metro2Snapshot {
  const asOf = state.as_of;
  const trail: string[] = [];
  const dq = deriveDelinquency(state.installments, asOf);
  trail.push(`fifo: earliest_unpaid=${dq.earliest_unpaid ?? "none"} days=${dq.days} apd=${dq.amount_past_due_cents}`);
  let status: AccountStatus = statusForDays(dq.days);
  let paymentRating: PaymentRating | null = null;
  let special: SpecialComment = "";
  let apd = dq.amount_past_due_cents;
  let scheduled = state.pi_cents + state.escrow_cents;
  let balance = state.upb_cents + state.deferred_principal_cents + state.forborne_principal_cents;
  let closed: PlainDate | null = null;
  let chargeOff = 0n;
  let terms = policy.terms_duration === "original" ? state.original_term_months : state.remaining_term_months;
  let k4: Metro2Snapshot["k4"] = null;
  let final = false;
  const c = state.condition;

  switch (c.kind) {
    case "none": break;
    case "forbearance":
      if (policy.forbearance_status === "freeze") {
        status = c.entry_status; apd = c.entry_amount_past_due_cents;
        trail.push(`forbearance freeze: status ${status} apd ${apd} from entry ${c.effective_on}`);
      }
      special = "CP"; scheduled = c.plan_payment_cents;
      break;
    case "repayment_plan":
      apd = c.remaining_arrears_cents;
      if (c.plan_payment_cents < state.pi_cents + state.escrow_cents) special = "AC";
      break;
    case "trial": special = "AC"; break;                                        // contractual aging continues (8.1-Q5)
    case "modification":
      status = "11"; special = "CO"; terms = c.new_term_months; scheduled = c.new_piti_cents; apd = 0n;
      if (state.forborne_principal_cents > 0n) k4 = { specialized_payment_indicator: "01", balloon_due_on: state.maturity_date, balloon_amount_cents: state.forborne_principal_cents };
      break;
    case "deferral":
      status = "11"; apd = 0n;
      k4 = { specialized_payment_indicator: "01", balloon_due_on: state.maturity_date, balloon_amount_cents: state.deferred_principal_cents };
      break;
    case "foreclosure_sale":
      status = "94"; paymentRating = paymentRatingForDays(dq.days); closed = c.closed_on; final = true; apd = 0n;
      if (!c.deficiency_pursued) balance = 0n;
      break;
    case "deed_in_lieu": status = "89"; paymentRating = paymentRatingForDays(dq.days); closed = c.closed_on; balance = 0n; apd = 0n; final = true; break;
    case "short_sale":
      status = c.foreclosure_started ? "65" : "13"; paymentRating = paymentRatingForDays(dq.days); special = "AU";
      closed = c.closed_on; balance = 0n; apd = 0n; final = true; break;
    case "paid_in_full":
      status = "13"; paymentRating = paymentRatingForDays(dq.days); if (c.by_refinance) special = "AS";
      closed = c.closed_on; balance = 0n; apd = 0n; final = true; break;
    case "charge_off": status = "97"; closed = c.closed_on; chargeOff = c.charge_off_cents; final = true; break;
    case "transfer_out": status = "05"; paymentRating = paymentRatingForDays(dq.days); special = "BA"; closed = c.transfer_date; final = true; break;
  }
  if (!final && state.foreclosure_referred && special === "") special = "BO";
  if (!final && state.disaster_case_open && special === "") special = "AW";      // AW yields to CP (8.3-Q2)

  const dofd = deriveDofd(status, dq.earliest_unpaid, state.prior);
  return {
    loan_id: state.loan_id, as_of: asOf, account_status: status, payment_rating: paymentRating, special_comment: special,
    current_balance_cents: balance, amount_past_due_cents: apd, scheduled_monthly_payment_cents: scheduled,
    actual_payment_cents: state.payments_in_month_cents, original_loan_amount_cents: state.original_amount_cents,
    original_charge_off_cents: chargeOff, days_past_due: dq.days, dofd, date_opened: state.note_date, date_closed: closed,
    date_of_last_payment: state.last_payment_on, terms_duration: terms, interest_type: state.interest_type,
    php: carryPhp(state.prior),
    k3: { agency_identifier: "01", fnma_loan_number: state.fnma_loan_number, min: state.min },
    k4, consumers: consumerSegments(state, special), final_reported: final, derivation: trail,
  };
}

/** Render the money/date fields the way they appear in the Base segment. */
export function renderBase(s: Metro2Snapshot, rounding: RoundingPolicy = "truncate"): Record<string, string> {
  return {
    account_status: s.account_status,
    payment_rating: s.payment_rating ?? "",
    special_comment: s.special_comment,
    current_balance: metro2Money(s.current_balance_cents, rounding),
    amount_past_due: metro2Money(s.amount_past_due_cents, rounding),
    scheduled_monthly_payment: metro2Money(s.scheduled_monthly_payment_cents, rounding),
    actual_payment_amount: metro2Money(s.actual_payment_cents, rounding),
    original_loan_amount: metro2Money(s.original_loan_amount_cents, rounding),
    original_charge_off_amount: metro2Money(s.original_charge_off_cents, rounding),
    date_opened: metro2Date(s.date_opened),
    date_of_first_delinquency: metro2Date(s.dofd),
    date_closed: metro2Date(s.date_closed),
    date_of_last_payment: metro2Date(s.date_of_last_payment),
    date_of_account_information: metro2Date(s.as_of),
    terms_duration: String(s.terms_duration).padStart(3, "0"),
    terms_frequency: "M",
    portfolio_type: "M",
    account_type: "26",
    interest_type_indicator: s.interest_type,
    payment_history_profile: s.php,
    k4_balloon_due_date: s.k4 ? metro2Date(s.k4.balloon_due_on) : "",
    k4_balloon_amount: s.k4 ? metro2Money(s.k4.balloon_amount_cents, rounding) : "",
  };
}

// ---- Validation (rule 9) ----------------------------------------------------

const DOFD_REQUIRED: ReadonlySet<AccountStatus> = new Set(["71", "78", "80", "82", "83", "84", "89", "94", "97", "65"]);
const RATING_REQUIRED: ReadonlySet<AccountStatus> = new Set(["13", "65", "89", "94", "05"]);

/** Hard errors block the record (omitted from the file, PHP `D` next month). */
export function validateSnapshot(s: Metro2Snapshot): string[] {
  const errs: string[] = [];
  if (s.account_status === "11" && s.dofd !== null) errs.push("STATUS_11_WITH_DOFD");
  if (DOFD_REQUIRED.has(s.account_status) && s.dofd === null) errs.push("DOFD_REQUIRED");
  if (RATING_REQUIRED.has(s.account_status) && s.payment_rating === null) errs.push("PAYMENT_RATING_REQUIRED");
  if (s.php.length !== 24) errs.push("PHP_LENGTH");
  if (s.amount_past_due_cents > 0n && (s.account_status === "13" || s.account_status === "94" || s.account_status === "89")) errs.push("APD_WITH_CLOSED_STATUS");
  if (s.k3.min !== null && !/^\d{18}$/.test(s.k3.min)) errs.push("MIN_NOT_18_DIGITS");
  if (!/^\d{10}$/.test(s.k3.fnma_loan_number)) errs.push("K3_FNMA_LOAN_NUMBER");
  if (s.consumers.length === 0) errs.push("NO_CONSUMER_SEGMENT");
  if (s.account_status === "97" && s.original_charge_off_cents <= 0n) errs.push("CHARGE_OFF_AMOUNT_REQUIRED");
  return errs;
}

// ---- Cycle-level anomaly gate (rule 9, soft) --------------------------------

export interface CycleRecordDelta {
  readonly loan_id: string;
  readonly prior_status: AccountStatus | null;
  readonly status: AccountStatus;
  readonly explained_by_event: boolean;       // a payment/workout/BK event explains the change
  readonly dofd_moved_later: boolean;
  readonly deleted: boolean;
}

export interface AnomalyThresholds { readonly unexplained_improvement_pct: number; readonly deleted_pct: number; readonly unexplained_change_pct: number; }
export const DEFAULT_ANOMALY: AnomalyThresholds = { unexplained_improvement_pct: 0.02, deleted_pct: 0.005, unexplained_change_pct: 0.02 };

const BUCKET_RANK: Readonly<Record<AccountStatus, number>> = { "11": 0, "71": 1, "78": 2, "80": 3, "82": 4, "83": 5, "84": 6, "13": 0, "65": 6, "89": 6, "94": 6, "97": 6, "05": 0 };

export function anomalyGate(records: readonly CycleRecordDelta[], t: AnomalyThresholds = DEFAULT_ANOMALY): { held: boolean; reasons: string[] } {
  const n = Math.max(1, records.length);
  const reasons: string[] = [];
  const improved = records.filter((r) => r.prior_status && BUCKET_RANK[r.status] < BUCKET_RANK[r.prior_status] && !r.explained_by_event).length;
  if (improved / n > t.unexplained_improvement_pct) reasons.push(`unexplained status improvements ${(100 * improved / n).toFixed(2)}%`);
  const deleted = records.filter((r) => r.deleted).length;
  if (deleted / n > t.deleted_pct) reasons.push(`deleted records ${(100 * deleted / n).toFixed(2)}%`);
  const changed = records.filter((r) => r.prior_status && r.prior_status !== r.status && !r.explained_by_event).length;
  if (changed / n > t.unexplained_change_pct) reasons.push(`unexplained status changes ${(100 * changed / n).toFixed(2)}%`);
  if (records.some((r) => r.dofd_moved_later)) reasons.push("DOFD moved later");
  if (records.some((r) => r.prior_status && Math.abs(BUCKET_RANK[r.status] - BUCKET_RANK[r.prior_status]) > 1 && !r.explained_by_event)) reasons.push("status jump > 1 bucket");
  return { held: reasons.length > 0, reasons };
}

// ---- Transmission clocks (8.1-T11) ------------------------------------------

export interface TransmissionClocks { readonly target: PlainDate; readonly hard_stop: PlainDate; }

/** Files go by the 3rd servicer business day after `as_of`; hard stop = as_of + 10 calendar days. */
export function transmissionClocks(asOf: PlainDate, cal: Calendar = servicer): TransmissionClocks {
  return { target: addBusinessDays(asOf, 3, cal), hard_stop: addDays(asOf, 10) };
}

/** §1681s-2(a)(7)(B) B-2: negative-information notice within 30 days of first furnishing negative info (8.1-T13). */
export function negativeInfoNoticeDue(firstNegativeFurnishedOn: PlainDate, b1OnFile: boolean): PlainDate | null {
  return b1OnFile ? null : addDays(firstNegativeFurnishedOn, 30);
}

/** Rule 14: who reports the boarding month — Supermortgage if the transfer date ≤ 15th. */
export function boardingMonthReporter(transferDate: PlainDate): "supermortgage" | "transferor" {
  return parts(transferDate).d <= 15 ? "supermortgage" : "transferor";
}

/** Boarding hand-off PHP: as supplied; missing → `B` × 24 (8.1-T15). */
export function handoffHistory(php: string | null, dofd: PlainDate | null, status: AccountStatus | null): PriorHistory {
  return { php: php ? (php + "B".repeat(24)).slice(0, 24) : "B".repeat(24), status, dofd };
}

/** The calendar month `n` months before `asOf` (helper for PHP tests). */
export function monthBefore(asOf: PlainDate, n: number): PlainDate { return addMonths(plainDate(asOf.slice(0, 7) + "-01"), -n); }
