/**
 * 15.1 REOgram / conveyance — confirmation clock, LAR code linkage,
 * third-party-sale arithmetic (F-1-20), deed/insurance/rescission clocks.
 */
import { type PlainDate, addDays, addMonths, daysBetween } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, businessDaysBetween, fannieEt, nextBusinessDay, rollForward } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";
import { type Cents, monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";

const ET = "America/New_York";

export type Purchaser = "fnma" | "third_party";
export type AcquisitionType = "foreclosure" | "mortgage_release";

/** Rule 1 — LAR 70 (uninsured) / 72 (insured) for Fannie Mae acquisitions, 71 for third-party sales. */
export function larCode(purchaser: Purchaser, insured: boolean): "70" | "71" | "72" { return purchaser === "third_party" ? "71" : insured ? "72" : "70"; }
export function caseKind(purchaser: Purchaser): "reo_cases" | "tps_cases" { return purchaser === "fnma" ? "reo_cases" : "tps_cases"; }

/** Rule 2 — confirm by close of business (17:00 ET) on the next fannie_et business day after receipt. */
export function confirmDueAt(receivedMs: number, cal: Calendar = fannieEt): { date: PlainDate; ms: number } {
  const date = nextBusinessDay(wallClock(receivedMs, ET).date, cal);
  return { date, ms: zonedEpochMs(date, "17:00", ET) };
}
export function warningAt(receivedMs: number, dueMs: number, pct = 0.7): number { return receivedMs + Math.floor((dueMs - receivedMs) * pct); }

/** Rule 11 — late business days between the due date and confirmation. */
export function lateDays(dueOn: PlainDate, confirmedOn: PlainDate, cal: Calendar = fannieEt): number { return confirmedOn <= dueOn ? 0 : businessDaysBetween(dueOn, confirmedOn, cal); }

/** Exceptions raised on the REOgram are resolved within 3 fannie_et BD (15.1-T4). */
export function exceptionResolutionDue(raisedOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(raisedOn, 3, cal); }

/** Rule 4 — resale-restriction representation gate. */
export function resaleRestrictionGate(restriction: string | null, noticeEvidence: boolean): { blocked: boolean; escalate: "attorney" | null } {
  if (restriction === null || restriction === "none") return { blocked: false, escalate: null };
  return noticeEvidence ? { blocked: false, escalate: null } : { blocked: true, escalate: "attorney" };
}

/** Rule 5 — deed recorded the next recording day when foreclosed in the servicer's name. */
export function deedRecordDue(legalDate: PlainDate, foreclosedInNameOf: "servicer" | "fnma"): { due: PlainDate; task: "record_deed" | "obtain_recorded_copy_30" } {
  return foreclosedInNameOf === "servicer" ? { due: addDays(legalDate, 1), task: "record_deed" } : { due: addDays(legalDate, 30), task: "obtain_recorded_copy_30" };
}

/** Rule 6/7 — insurance cancellation requests by day 14; advances after sale + 14 are non-reimbursable. */
export function insuranceCancellationDue(saleDate: PlainDate): PlainDate { return addDays(saleDate, 14); }
export function advanceReimbursable(advanceDate: PlainDate, saleDate: PlainDate): boolean { return advanceDate <= addDays(saleDate, 14); }

// ---- Rule 8: third-party sale arithmetic (F-1-20) -----------------------------

export interface TpsInput {
  readonly upb_cents: Cents; readonly ptr_pct: string; readonly lpi_due: PlainDate; readonly liquidation_date: PlainDate; readonly settlement_date: PlainDate;
  readonly gross_proceeds_cents: Cents; readonly restricted_resale_price_cents?: Cents | null; readonly unrecovered_advances_cents: Cents;
}
export interface TpsResult {
  readonly months_full: number; readonly stub_days: number; readonly ptr_interest_cents: Cents; readonly fnma_total_indebtedness_cents: Cents;
  readonly amount_due_fnma_cents: Cents; readonly servicer_recovery_cents: Cents; readonly surplus_cents: Cents; readonly claim_571_advances_cents: Cents;
  readonly crs_code: "311"; readonly settle_by: PlainDate; readonly instruct_by: PlainDate;
}

/** PTR interest: full 30/360 months + stub days ÷ 365, half-up at the end (worked example: $13,699.87 + $163.78). */
export function ptrInterest(upb: Cents, ptrPct: string, from: PlainDate, to: PlainDate): { months_full: number; stub_days: number; cents: Cents } {
  let months = 0, cursor = from;
  while (addMonths(cursor, 1) <= to) { cursor = addMonths(cursor, 1); months++; }
  const days = daysBetween(cursor, to);
  const rate = ratePercent(ptrPct);
  const u = Decimal.fromBigInt(upb);
  const monthly = u.mul(rate).div(Decimal.fromInt(12)).mul(Decimal.fromInt(months));
  const daily = u.mul(rate).div(Decimal.fromInt(365)).mul(Decimal.fromInt(days));
  return { months_full: months, stub_days: days, cents: monthly.toScaledInt(0, "HALF_UP") + daily.toScaledInt(0, "HALF_UP") };
}

export function thirdPartySale(i: TpsInput, cal: Calendar = fannieEt): TpsResult {
  const end = i.liquidation_date > i.settlement_date ? i.liquidation_date : i.settlement_date;
  const int = ptrInterest(i.upb_cents, i.ptr_pct, i.lpi_due, end);
  const total = i.upb_cents + int.cents;
  const cands = [i.gross_proceeds_cents, total, ...(i.restricted_resale_price_cents ? [i.restricted_resale_price_cents] : [])];
  const due = cands.reduce((a, b) => (b < a ? b : a));
  const remaining = i.gross_proceeds_cents - due;
  const recovery = remaining < i.unrecovered_advances_cents ? remaining : i.unrecovered_advances_cents;
  const settle = addBusinessDays(i.settlement_date, 5, cal);
  return {
    months_full: int.months_full, stub_days: int.stub_days, ptr_interest_cents: int.cents, fnma_total_indebtedness_cents: total,
    amount_due_fnma_cents: due, servicer_recovery_cents: recovery, surplus_cents: remaining - recovery, claim_571_advances_cents: i.unrecovered_advances_cents - recovery,
    crs_code: "311", settle_by: settle, instruct_by: addBusinessDays(settle, -1, cal),
  };
}

/** Rule 9 — failed third-party sale: deposit remitted (311) within 5 BD of discovery. */
export function failedSaleDepositDue(discoveredOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(discoveredOn, 5, cal); }

/** Rule 10 — elimination/rescission clocks. */
export function rescissionClocks(identifiedOn: PlainDate, approvedMs: number | null): { template_due: PlainDate; reactivate_by_ms: number | null; counsel_by: PlainDate | null } {
  return {
    template_due: addDays(identifiedOn, 5),
    reactivate_by_ms: approvedMs === null ? null : approvedMs + 24 * 3600 * 1000,
    counsel_by: approvedMs === null ? null : addDays(wallClock(approvedMs, ET).date, 2),
  };
}
export function refoFeesReimbursable(rescissionCause: "servicer" | "other"): boolean { return rescissionCause !== "servicer"; }

export { rollForward, monthlyInterest };
