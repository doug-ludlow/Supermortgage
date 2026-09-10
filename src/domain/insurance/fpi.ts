/**
 * 9.2–9.4 Force-placed insurance — reasonable basis, track selection, escrow
 * guard, LPI coverage/deductible, the §1024.37 notice clocks, reminder
 * variants and renewal timing.
 */
import { type PlainDate, addDays, addYears, daysBetween, max as maxDate } from "../../kernel/calendar/date.ts";
import { type Calendar, businessDaysBetween, federal } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Deficiency } from "./hazard.ts";
import { isLpiCurable } from "./hazard.ts";

export type BasisKind = "carrier_cancellation" | "carrier_nonrenewal" | "vendor_expiration_no_renewal" | "borrower_statement" | "evidence_rejected" | "insufficient_coverage";
export type FpiTrack = "regx_hazard" | "fdpa_flood";
export type InsuranceType = "hazard" | "wind" | "flood";

export function reasonableBasis(kind: BasisKind, deficiency?: Deficiency): boolean {
  if (kind === "insufficient_coverage") return deficiency !== undefined && isLpiCurable(deficiency);
  return true;
}

export function selectTrack(type: InsuranceType): FpiTrack { return type === "flood" ? "fdpa_flood" : "regx_hazard"; }

export type EscrowGuard = "proceed" | "servicer_pays" | "k5_blocked" | "k5_inability_documented";

/** Rule 3 — escrowed loans ≤ 30 days delinquent never see FPI; > 30 days runs the §1024.17(k)(5) gate. */
export function escrowGuard(escrowed: boolean, regxDaysDelinquent: number, cancellationReason: "nonpayment" | "underwriting" | "other" | null): EscrowGuard {
  if (!escrowed) return "proceed";
  if (regxDaysDelinquent <= 30) return "servicer_pays";
  // (k)(5)(ii): the servicer may not fail to advance unless it has a reasonable basis to believe the policy was cancelled for reasons other than non-payment.
  return cancellationReason === "nonpayment" || cancellationReason === null ? "k5_blocked" : "k5_inability_documented";
}

/** B-6-01 deductible tiers (worked example: ≤ $250,000 → $2,000; above → $2,500). */
export function tierDeductible(coverage: Cents): Cents {
  if (coverage <= 10_000_000n) return 100_000n;
  if (coverage <= 25_000_000n) return 200_000n;
  if (coverage <= 50_000_000n) return 250_000n;
  return 500_000n;
}

export interface LpiCoverageInput { readonly last_known_cents: Cents | null; readonly rcv_cents: Cents; readonly upb_cents: Cents; readonly state_cap_cents: Cents | null; readonly vacant?: boolean; }

/** Rule 4 — coverage = min(last known if within ±15% of RCV else RCV, state cap); never below UPB unless RCV < UPB. */
export function lpiCoverage(i: LpiCoverageInput): { coverage_cents: Cents; deductible_cents: Cents; basis: string } {
  let cov = i.rcv_cents, basis = "rcv";
  if (i.last_known_cents !== null && !i.vacant) {
    const diff = i.last_known_cents > i.rcv_cents ? i.last_known_cents - i.rcv_cents : i.rcv_cents - i.last_known_cents;
    if (diff * 100n <= i.rcv_cents * 15n) { cov = i.last_known_cents; basis = "last_known_within_15pct"; }
  }
  if (cov < i.upb_cents && i.rcv_cents >= i.upb_cents) { cov = i.upb_cents; basis = "upb_floor"; }
  if (i.state_cap_cents !== null && cov > i.state_cap_cents) { cov = i.state_cap_cents; basis = "state_cap"; }
  return { coverage_cents: cov, deductible_cents: tierDeductible(cov), basis };
}

/** Premium from a rate table: coverage × rate% (round-half-up at the end). */
export function premiumFromRate(coverage: Cents, ratePct: string): Cents {
  return Decimal.fromBigInt(coverage).mul(Decimal.parse(ratePct).div(Decimal.fromInt(100))).toScaledInt(0, "HALF_UP");
}

export interface FpiClocks {
  readonly t0: PlainDate;                       // first notice mailed
  readonly reminder_not_before: PlainDate;      // t0 + 30
  readonly t1: PlainDate | null;                // reminder mailed
  readonly earliest_charge: PlainDate;          // max(t0+45, t1+15)
  readonly evidence_window_end: PlainDate;      // = earliest_charge; evidence on that day counts
}

/** Rule 6 / 9.3 rule 3. */
export function fpiClocks(t0: PlainDate, t1: PlainDate | null): FpiClocks {
  const base = addDays(t0, 45);
  const charge = t1 === null ? base : maxDate(base, addDays(t1, 15));
  return { t0, reminder_not_before: addDays(t0, 30), t1, earliest_charge: charge, evidence_window_end: charge };
}

export function reminderAllowed(clocks: FpiClocks, on: PlainDate): boolean { return on >= clocks.reminder_not_before; }

export type ChargeDecision = { readonly allowed: false; readonly reason: string } | { readonly allowed: true; readonly effective: PlainDate; readonly expiration: PlainDate };

/** Charge only after both gates and no continuous-coverage evidence by the window end; coverage is retroactive to the lapse. */
export function chargeDecision(clocks: FpiClocks, on: PlainDate, evidenceReceivedOn: PlainDate | null, lapseStart: PlainDate): ChargeDecision {
  if (clocks.t1 === null) return { allowed: false, reason: "REMINDER_NOT_MAILED" };
  if (on < clocks.earliest_charge) return { allowed: false, reason: `REGX_1024_37C_FPI_FIRST_NOTICE_45 open until ${clocks.earliest_charge}` };
  if (evidenceReceivedOn !== null && evidenceReceivedOn <= clocks.evidence_window_end) return { allowed: false, reason: "closed_evidence" };
  return { allowed: true, effective: lapseStart, expiration: addYears(lapseStart, 1) };
}

/** §1024.37(d)(5) / 9.3 rule 5 — a notice produced more than 5 federal business days before mailing must be regenerated. */
export function productionWindowOk(producedOn: PlainDate, mailedOn: PlainDate, cal: Calendar = federal): boolean {
  return businessDaysBetween(producedOn, mailedOn, cal) <= 5;
}

/** Rule 5 content assembly: first notices always say "will purchase"; wind gaps name windstorm. */
export interface NoticeContent { readonly condition: "is expiring" | "expired" | "provides insufficient coverage"; readonly purchase_phrase: "will purchase"; readonly insurance_type: "hazard" | "windstorm"; readonly extra_content_allowed: readonly string[]; }
export function firstNoticeContent(kind: "expiring" | "expired" | "insufficient", type: InsuranceType): NoticeContent {
  return {
    condition: kind === "expiring" ? "is expiring" : kind === "expired" ? "expired" : "provides insufficient coverage",
    purchase_phrase: "will purchase", insurance_type: type === "wind" ? "windstorm" : "hazard", extra_content_allowed: ["account_number"],
  };
}

/** (c)(4): nothing but the required content and the account number on the notice pages. */
export function noticeChecklist(paragraphs: readonly { readonly kind: "required" | "account_number" | "other" }[]): { ok: boolean; violations: string[] } {
  const v = paragraphs.filter((p) => p.kind === "other").map(() => "extra_content_(c)(4)");
  return { ok: v.length === 0, violations: v };
}

// ---- 9.3 reminder ------------------------------------------------------------

export interface EvidenceRow { readonly received_on: PlainDate; readonly effective: PlainDate; readonly expiration: PlainDate | null; readonly written: boolean; }
export interface ReminderVariant { readonly variant: "b_no_info" | "c_insufficient"; readonly gaps: readonly { readonly from: PlainDate; readonly to: PlainDate }[]; }

/** Rule 1 — no written evidence → MS-3(B); evidence leaving gaps from lapse_start → MS-3(C) with [Date Range]s (end exclusive → printed as the day before). */
export function reminderVariant(evidence: readonly EvidenceRow[], lapseStart: PlainDate, asOf: PlainDate): ReminderVariant {
  const written = evidence.filter((e) => e.written).sort((a, b) => (a.effective < b.effective ? -1 : 1));
  if (written.length === 0) return { variant: "b_no_info", gaps: [{ from: lapseStart, to: asOf }] };
  const gaps: { from: PlainDate; to: PlainDate }[] = [];
  let cursor = lapseStart;
  for (const e of written) {
    if (e.effective > cursor) gaps.push({ from: cursor, to: addDays(e.effective, -1) });
    const end = e.expiration ?? asOf;
    if (end > cursor) cursor = end;
  }
  if (cursor < asOf) gaps.push({ from: cursor, to: asOf });
  return gaps.length === 0 ? { variant: "c_insufficient", gaps: [] } : { variant: "c_insufficient", gaps };
}

export interface PremiumQuote { readonly annual_premium_cents: Cents; readonly is_estimate: boolean; readonly basis: string; }
export function premiumQuote(carrierQuote: Cents | null, coverage: Cents, tableRatePct: string): PremiumQuote {
  if (carrierQuote !== null) return { annual_premium_cents: carrierQuote, is_estimate: false, basis: "carrier_quote" };
  return { annual_premium_cents: premiumFromRate(coverage, tableRatePct), is_estimate: true, basis: `rate_table ${tableRatePct}%` };
}

// ---- 9.4 renewal ---------------------------------------------------------------

export interface RenewalClocks { readonly anniversary: PlainDate; readonly notice_target: PlainDate; readonly chargeable: PlainDate | null; readonly charge_on: PlainDate | null; }

/** Rule 2 — renewal charge = max(A, t2 + 45); coverage renews on A regardless. */
export function renewalClocks(placementEffective: PlainDate, t2: PlainDate | null): RenewalClocks {
  const a = addYears(placementEffective, 1);
  const chargeable = t2 === null ? null : addDays(t2, 45);                     // (e)(4) gate
  return { anniversary: a, notice_target: addDays(a, -60), chargeable, charge_on: chargeable === null ? null : maxDate(a, chargeable) };
}

/** (e)(5) — one MS-3(D) per anniversary: refuse a second notice within 365 days for the same anniversary. */
export function renewalNoticeAllowed(last: { mailed: PlainDate; anniversary: PlainDate } | null, targetAnniversary: PlainDate, on: PlainDate): boolean {
  if (last === null) return true;
  return daysBetween(last.mailed, on) >= 365 || last.anniversary !== targetAnniversary;
}

/** Rule 4 — prompt gap charge where state law permits, else a new 9.2 cycle. */
export function gapChargeDecision(gapDays: number, dailyRateCents: Decimal, statePromptChargeProhibited: boolean): { action: "prompt_charge"; cents: Cents } | { action: "new_cycle" } {
  if (statePromptChargeProhibited) return { action: "new_cycle" };
  return { action: "prompt_charge", cents: dailyRateCents.mul(Decimal.fromInt(gapDays)).toScaledInt(0, "HALF_UP") };
}
