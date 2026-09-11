/**
 * §21.2 operating rules — TRID application receipt, application date and the initial Loan Estimate: the two Reg Z
 * business-day clocks (§1026.2(a)(6) general = `creditor`, specific = `regzSpecific`), the 3-business-day issuance
 * deadline (§1026.19(e)(1)(iii)(A)), the 7-specific-business-day pre-consummation gate anchored on delivery/mailing
 * (§1026.19(e)(1)(iii)(B), comment 19(e)(1)(iii)-2), the mailbox presumption (§1026.19(e)(1)(iv)), the closing-cost
 * expiration (§1026.37(a)(13)(ii); §1026.19(e)(3)(iv)(E)), the good-faith tolerance classes (§1026.19(e)(3)), the
 * §1026.37 calculations (P&I, TIP, In 5 Years) and the Appendix J actuarial APR — all in decimal arithmetic
 * (src/kernel/money) and bigint cents, never floating point. `LoanEstimateService` is the process's command surface:
 * it emits the events the 21.2 timers arm on and are satisfied by (spec 21.2 "Events"):
 *
 *   disclosure.le.rendered{disclosure_id, le_version, data_hash}                       [application]
 *   escalation.created{kind=mlo_of_record, stage=le_terms, sla_due_at}                 [application — arms SM_O22_MLO_LE_REVIEW_SLA_1BD]
 *   disclosure.le.mlo_reviewed{decision∈{approved, returned}, data_hash}               [application — satisfies SM_O22_MLO_LE_REVIEW_SLA_1BD]
 *   disclosure.le.mlo_approved{data_hash, mlo_review_id}
 *   disclosure.le.delivered{channel} / disclosure.le.mailed{mailing_proof_id}          [the spec's own events]
 *   disclosure.le.issued{le_version, channel, in_person, issued_on}                    [application — satisfies REGZ_1026_19E1_LE_3BD; arms the
 *                                                                                        7-SBD gate, the mailbox derivation and the 10-BD expiration]
 *   disclosure.le.received{evidence, received_on, effective_receipt_date}              [application — satisfies REGZ_1026_19E1IV_LE_MAILBOX_3SBD]
 *   disclosure.le.deemed_received{deemed_receipt_date}
 *   gate.le_7sbd.opened{earliest_consummation_date, waived}                            [application — satisfies REGZ_1026_19E1III_LE_7SBD_GATE]
 *   fee.baseline.set{disclosure_id, ten_percent_baseline_cents, items}                 [consumed by 21.5 / 25.2]
 *   provider_list.delivered{disclosure_id}
 *   disclosure.le.delivery.refused{channel, reason}
 *
 * Consumed: `application.trid_received` (21.1; carries `trid_received_at` and `trid_application_date`) and
 * `intent.to_proceed.received` (21.4; blanks the closing-cost expiration field on later LEs, comment 37(a)(13)-4).
 */
import { createHash } from "node:crypto";
import { type PlainDate, plainDate, addDays, isWeekend, dayOfWeek } from "../../kernel/calendar/date.ts";
import { addBusinessDays, regzSpecific, type Calendar } from "../../kernel/calendar/business.ts";
import { isFederalHoliday } from "../../kernel/calendar/holidays.ts";
import { wallClock, zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { Decimal, divRound, levelPayment, monthlyInterest, ratePercent, centsToDecimal, formatCents, type Cents } from "../../kernel/money/index.ts";
import type { Actor, DomainEvent, EventStore, Clock } from "../../kernel/events/index.ts";
import { solveAppendixJ } from "../compliance-disclosures/ops-25-1.ts";

export const AGENT: Actor = { kind: "agent", id: "disclosure" };
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };

// ============================================================ rule 1: calendars
/** The partner's declared `creditor` calendar (spec 21.2 operational prerequisites; open question 1): Mon–Fri, federal holidays and published closures off; Saturday and holiday openings only shorten deadlines. */
export interface CreditorCalendarSpec { readonly time_zone: string; readonly saturday_open?: boolean; readonly open_on_holidays?: readonly PlainDate[]; readonly closures?: readonly PlainDate[]; }
/** Refinance fixture: Phoenix, AZ — MST year-round (America/Phoenix), Mon–Fri, closed Columbus Day. */
export const PHOENIX_CREDITOR: CreditorCalendarSpec = { time_zone: "America/Phoenix" };
/** Purchase fixture: Columbus, OH — Eastern time. */
export const COLUMBUS_CREDITOR: CreditorCalendarSpec = { time_zone: "America/New_York" };
export function creditorCalendarFrom(spec: CreditorCalendarSpec): Calendar {
  const closures = new Set(spec.closures ?? []); const open = new Set(spec.open_on_holidays ?? []);
  return { unit: "business_days_creditor", timeZone: spec.time_zone, isBusinessDay: (d) => { if (closures.has(d)) return false; const w = dayOfWeek(d); if (w === 0) return false; if (w === 6) return spec.saturday_open === true; if (open.has(d)) return true; return !isWeekend(d) && !isFederalHoliday(d); } };
}
/** Civil date of an instant in the creditor's time zone (edge case: six items at 23:50 stay on that creditor day). */
export const civilDate = (iso: string, timeZone: string): PlainDate => wallClock(Date.parse(iso), timeZone).date;
export const tridApplicationDate = civilDate;
const endOfDayIso = (d: PlainDate, tz: string): string => toIso(zonedEpochMs(d, "23:59", tz));

// ============================================================ rule 2: LE due date (REGZ_1026_19E1_LE_3BD)
/** `le_due_at = end_of_day(nth_business_day(trid_application_date, 3, creditor))` — day 0 is the application day. */
export function leDueAt(tridApplicationDateOn: PlainDate, spec: CreditorCalendarSpec = PHOENIX_CREDITOR): { due_on: PlainDate; due_at: string } {
  const due_on = addBusinessDays(tridApplicationDateOn, 3, creditorCalendarFrom(spec));
  return { due_on, due_at: endOfDayIso(due_on, spec.time_zone) };
}
/** `SM_O22_MLO_LE_REVIEW_SLA_1BD`: +1 creditor business day (end of day) but never later than `le_due_at` − 2 hours. */
export function mloReviewSlaDueAt(openedAtIso: string, leDueAtIso: string, spec: CreditorCalendarSpec = PHOENIX_CREDITOR): string {
  const oneBd = zonedEpochMs(addBusinessDays(civilDate(openedAtIso, spec.time_zone), 1, creditorCalendarFrom(spec)), "23:59", spec.time_zone);
  const cap = Date.parse(leDueAtIso) - 2 * 3_600_000;
  return toIso(Math.min(oneBd, cap));
}

// ============================================================ rule 3: receipt, the 7-SBD gate and the 10-BD expiration
export type DeliveryChannel = "esign_portal" | "email" | "mail" | "in_person" | "courier";
export const DELIVERY_CHANNELS: readonly DeliveryChannel[] = ["esign_portal", "email", "mail", "in_person", "courier"];
export const isElectronic = (c: DeliveryChannel): boolean => c === "esign_portal" || c === "email";
export const isInPerson = (c: DeliveryChannel): boolean => c === "in_person";
export type ReceiptEvidence = "esign_confirmed" | "mailbox_rule" | "in_person" | "courier";
/** §1026.19(e)(1)(iv): three specific business days after delivery or mailing (Saturdays count; Sundays and legal holidays do not). */
export const deemedReceiptDate = (issuedOn: PlainDate): PlainDate => addBusinessDays(issuedOn, 3, regzSpecific);
/** §1026.19(e)(1)(iii)(B) + comment 19(e)(1)(iii)-2: consummation on or after the seventh specific business day after delivery/mailing. */
export const earliestConsummationDate = (issuedOn: PlainDate): PlainDate => addBusinessDays(issuedOn, 7, regzSpecific);
/** The last day the initial LE may be delivered or mailed for a given consummation date (worked example 2(b): Nov 18 → Mon Nov 9). */
export const latestLeIssueDateFor = (consummationOn: PlainDate): PlainDate => addBusinessDays(consummationOn, -7, regzSpecific);

export interface ReceiptInput { readonly channel: DeliveryChannel; readonly issued_on: PlainDate; readonly evidence_at?: string | null; readonly time_zone: string; }
export interface ReceiptDetermination { readonly receipt_evidence: ReceiptEvidence; readonly received_on: PlainDate | null; readonly deemed_receipt_date: PlainDate | null; readonly effective_receipt_date: PlainDate; }
/** In person = receipt that day; e-sign portal with an authenticated view/acknowledgement = receipt on the evidence date; everything else waits for the mailbox presumption unless earlier evidence arrives. */
export function receiptDetermination(r: ReceiptInput): ReceiptDetermination {
  if (isInPerson(r.channel)) return { receipt_evidence: "in_person", received_on: r.issued_on, deemed_receipt_date: null, effective_receipt_date: r.issued_on };
  const deemed = deemedReceiptDate(r.issued_on);
  if (r.evidence_at) {
    const on = civilDate(r.evidence_at, r.time_zone);
    if (on < r.issued_on) throw new RangeError(`receipt evidence ${r.evidence_at} precedes delivery on ${r.issued_on}`);
    return { receipt_evidence: "esign_confirmed", received_on: on, deemed_receipt_date: deemed, effective_receipt_date: on < deemed ? on : deemed };
  }
  return { receipt_evidence: "mailbox_rule", received_on: null, deemed_receipt_date: deemed, effective_receipt_date: deemed };
}

/** §1026.37(a)(13)(ii): estimated closing costs expire at 5:00 p.m. creditor time on the tenth creditor business day after delivery/mailing (policy hour; longer only if the creditor specifies). */
export function closingCostsExpireAt(issuedOn: PlainDate, spec: CreditorCalendarSpec = PHOENIX_CREDITOR, days = 10): { expires_on: PlainDate; expires_at: string; display: string } {
  if (days < 10) throw new RangeError("the closing-cost expiration period may not be shorter than 10 business days (§1026.19(e)(3)(iv)(E))");
  const expires_on = addBusinessDays(issuedOn, days, creditorCalendarFrom(spec));
  const ms = zonedEpochMs(expires_on, "17:00", spec.time_zone);
  const abbr = tzAbbreviation(spec.time_zone, ms);
  const [y, m, d] = expires_on.split("-");
  return { expires_on, expires_at: toIso(ms), display: `${Number(m)}/${Number(d)}/${y} at 5:00 p.m. ${abbr}` };
}
export function tzAbbreviation(timeZone: string, ms: number): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(ms)).find((x) => x.type === "timeZoneName");
  return p?.value ?? timeZone;
}

export interface GateFacts { readonly earliest_consummation_date?: PlainDate | string; readonly requested_on?: PlainDate | string; readonly waiver_recorded_on?: PlainDate | string | null; }
/** REGZ_1026_19E1III_LE_7SBD_GATE: open on/after the earliest consummation date, or from the day a bona fide personal financial emergency statement is recorded (§1026.19(e)(1)(v)). */
export function le7sbdGate(f: GateFacts): { open: boolean; reason?: string } {
  if (!f.earliest_consummation_date) return { open: false, reason: "no initial Loan Estimate delivered or mailed — the seven-business-day period has not started (§1026.19(e)(1)(iii)(B))" };
  if (!f.requested_on) return { open: false, reason: "requested consummation date is required" };
  if (f.waiver_recorded_on && f.waiver_recorded_on <= f.requested_on) return { open: true };
  if (f.requested_on >= f.earliest_consummation_date) return { open: true };
  return { open: false, reason: `consummation ${f.requested_on} precedes the earliest permitted date ${f.earliest_consummation_date} (seventh specific business day after LE delivery/mailing, §1026.19(e)(1)(iii)(B)); waiver only by a written, dated, signed emergency statement (§1026.19(e)(1)(v))` };
}
export class LeGateClosed extends Error { readonly code = "REGZ_1026_19E1III_LE_7SBD_GATE"; readonly reason: string; constructor(reason: string) { super(`REGZ_1026_19E1III_LE_7SBD_GATE: ${reason}`); this.name = "LeGateClosed"; this.reason = reason; } }
export function assertGateOpen(f: GateFacts): void { const g = le7sbdGate(f); if (!g.open) throw new LeGateClosed(g.reason ?? "closed"); }

// ============================================================ rule 4–6: fees, tolerance classes, baseline
export type LeSection = "A_origination" | "B_cannot_shop" | "C_can_shop" | "E_taxes_gov" | "F_prepaids" | "G_initial_escrow" | "H_other" | "J_lender_credit";
export type ProviderSource = "creditor" | "affiliate" | "creditor_selected_third_party" | "list_provider" | "consumer_selected_off_list" | "government" | "none";
export type EstimateSource = "pricing_engine" | "fee_schedule" | "vendor_quote" | "county_table" | "tax_bill" | "insurance_policy" | "borrower_stated" | "default_table";
export type ToleranceClass = "zero" | "ten_percent" | "unlimited";
export interface FeeItemInput {
  readonly fee_code: string; readonly description: string; readonly le_section: LeSection; readonly mismo_fee_type: string;
  readonly amount_cents: Cents; readonly provider_source: ProviderSource; readonly shoppable: boolean;
  readonly estimate_source: EstimateSource; readonly estimate_source_ref: string; readonly estimated_at: PlainDate;
  readonly finance_charge: boolean; readonly paid_to?: string; readonly required_by_creditor?: boolean;
}
export interface FeeItem extends FeeItemInput { readonly tolerance_class: ToleranceClass; readonly baseline_amount_cents: Cents; readonly baseline_disclosure_id: string; }
const isRecording = (f: FeeItemInput): boolean => /recording/i.test(f.mismo_fee_type) || /recording/i.test(f.fee_code);
/** Rule 4 — §1026.19(e)(3)(i)–(iii) tolerance class by section and provider source. */
export function deriveToleranceClass(f: FeeItemInput): ToleranceClass {
  switch (f.le_section) {
    case "A_origination": case "B_cannot_shop": case "J_lender_credit": return "zero";
    case "C_can_shop":
      if (f.provider_source === "consumer_selected_off_list") return "unlimited";
      if (f.provider_source === "affiliate" || f.provider_source === "creditor") return "zero";
      return "ten_percent";
    case "E_taxes_gov": return isRecording(f) ? "ten_percent" : "zero";
    case "F_prepaids": case "G_initial_escrow": return "unlimited";
    case "H_other":
      if (f.required_by_creditor === false) return "unlimited";
      return f.shoppable && f.provider_source !== "affiliate" && f.provider_source !== "creditor" ? "ten_percent" : "zero";
  }
}
export const FEE_TABLE_MAX_AGE_DAYS = 30;
/** Rule 5 — every estimate carries its source; one older than the freshness rule blocks rendering. */
export function assembleFees(items: readonly FeeItemInput[], asOf: PlainDate, maxAgeDays = FEE_TABLE_MAX_AGE_DAYS): FeeItemInput[] {
  if (!items.length) throw new RangeError("at least one fee item is required");
  const seen = new Set<string>();
  for (const f of items) {
    nonEmpty(f.fee_code, "fee_code"); nonEmpty(f.estimate_source_ref, `estimate_source_ref for ${f.fee_code}`);
    if (seen.has(f.fee_code)) throw new RangeError(`duplicate fee ${f.fee_code}`); seen.add(f.fee_code);
    if (typeof f.amount_cents !== "bigint") throw new RangeError(`amount_cents for ${f.fee_code} must be bigint cents`);
    if (f.le_section === "J_lender_credit" ? f.amount_cents > 0n : f.amount_cents < 0n) throw new RangeError(`${f.fee_code}: a ${f.le_section} amount has the wrong sign`);
    if (addDays(plainDate(f.estimated_at), maxAgeDays) < asOf) throw new RangeError(`${f.fee_code}: estimate dated ${f.estimated_at} is older than ${maxAgeDays} days on ${asOf} (rule_sets.fee_table_max_age_days)`);
  }
  return [...items];
}
export interface SectionTotals { readonly A: Cents; readonly B: Cents; readonly C: Cents; readonly E: Cents; readonly F: Cents; readonly G: Cents; readonly H: Cents; readonly J: Cents; readonly loan_costs_cents: Cents; readonly other_costs_cents: Cents; readonly lender_credits_cents: Cents; readonly total_closing_costs_cents: Cents; }
export function sectionTotals(items: readonly FeeItemInput[]): SectionTotals {
  const sum = (s: LeSection): Cents => items.filter((f) => f.le_section === s).reduce((a, f) => a + f.amount_cents, 0n);
  const A = sum("A_origination"), B = sum("B_cannot_shop"), C = sum("C_can_shop"), E = sum("E_taxes_gov"), F = sum("F_prepaids"), G = sum("G_initial_escrow"), H = sum("H_other"), J = sum("J_lender_credit");
  const loan_costs_cents = A + B + C, other_costs_cents = E + F + G + H;
  return { A, B, C, E, F, G, H, J, loan_costs_cents, other_costs_cents, lender_credits_cents: J, total_closing_costs_cents: loan_costs_cents + other_costs_cents + J };
}
/** §1026.19(e)(3)(ii): the aggregate of the ten-percent items (shoppable non-affiliate third-party services + recording fees). */
export const tenPercentAggregate = (items: readonly (FeeItemInput & { tolerance_class: ToleranceClass })[]): Cents => items.filter((f) => f.tolerance_class === "ten_percent").reduce((a, f) => a + f.amount_cents, 0n);
/** Rule 6 — SM-borne third-party charges are disclosed in B/C with an equal general lender credit in J (zero tolerance; 21.5 may never reduce it). */
export const smBorneLenderCredit = (items: readonly FeeItemInput[]): Cents => -(sectionTotals(items).B + sectionTotals(items).C);

// ============================================================ rule 9: calculations
export const perDiemInterest = (loanCents: Cents, ratePct: string): Cents => divRound(loanCents * ratePercent(ratePct).unscaled, 365n * Decimal.ONE.unscaled, "HALF_UP");
/** 365-day per diem rounded to the cent first (26.3 rule 2 `365_rounded_per_diem`), then × days — $93.97 × 19 = $1,785.43 on the fixture. */
export function prepaidInterest(loanCents: Cents, ratePct: string, days: number): { per_diem_cents: Cents; days: number; total_cents: Cents } {
  if (!Number.isInteger(days) || days < 0) throw new RangeError("days must be a non-negative integer");
  const per_diem_cents = perDiemInterest(loanCents, ratePct);
  return { per_diem_cents, days, total_cents: per_diem_cents * BigInt(days) };
}
export interface Amortization { readonly pi_cents: Cents; readonly balance_after_60_cents: Cents; readonly principal_paid_60_cents: Cents; readonly scheduled_interest_cents: Cents; readonly final_payment_cents: Cents; readonly total_of_payments_cents: Cents; }
/** Level-payment schedule with each month's interest rounded half-up (F-1-09 convention); the last payment retires the balance. */
export function amortize(loanCents: Cents, ratePct: string, termMonths: number): Amortization {
  const rate = ratePercent(ratePct); const pi_cents = levelPayment(loanCents, rate, termMonths);
  let bal = loanCents, interest = 0n, balance60 = loanCents, final = pi_cents;
  for (let k = 1; k <= termMonths; k++) {
    const i = monthlyInterest(bal, rate);
    if (k === termMonths) { final = bal + i; interest += i; bal = 0n; break; }
    interest += i; bal -= pi_cents - i;
    if (k === 60) balance60 = bal;
  }
  return { pi_cents, balance_after_60_cents: termMonths >= 60 ? balance60 : 0n, principal_paid_60_cents: loanCents - (termMonths >= 60 ? balance60 : 0n), scheduled_interest_cents: interest, final_payment_cents: final, total_of_payments_cents: pi_cents * BigInt(termMonths) };
}
export interface LeCalcInput { readonly loan_cents: Cents; readonly rate_pct: string; readonly term_months: number; readonly mi_monthly_cents?: Cents; readonly loan_costs_cents: Cents; }
export interface LeCalcs { readonly pi_cents: Cents; readonly tip_pct: string; readonly in_5y_total_cents: Cents; readonly in_5y_principal_cents: Cents; readonly balance_after_60_cents: Cents; readonly scheduled_interest_cents: Cents; }
/** §1026.37(c)/(l): P&I, TIP (Σ scheduled interest ÷ loan amount, three decimals), In 5 Years (60 × (P&I + MI) + loan costs; principal paid = loan − balance after payment 60). */
export function loanEstimateCalcs(i: LeCalcInput): LeCalcs {
  const a = amortize(i.loan_cents, i.rate_pct, i.term_months);
  const tip = Decimal.ratio(a.scheduled_interest_cents * 100n, i.loan_cents);
  return { pi_cents: a.pi_cents, tip_pct: tip.toFixed(3), in_5y_total_cents: 60n * (a.pi_cents + (i.mi_monthly_cents ?? 0n)) + i.loan_costs_cents, in_5y_principal_cents: a.principal_paid_60_cents, balance_after_60_cents: a.balance_after_60_cents, scheduled_interest_cents: a.scheduled_interest_cents };
}

// ---- Appendix J actuarial APR
export interface AprInput { readonly loan_cents: Cents; readonly rate_pct: string; readonly term_months: number; readonly prepaid_finance_charge_cents: Cents; /** odd days before the first full unit period (Appendix J (b)(3)); the LE assumes 0. */ readonly odd_days?: number; readonly unit_period_days?: number; readonly mi_monthly_cents?: Cents; }
export interface AprCalculation { readonly method: "appendix_j_exact"; readonly amount_financed_cents: Cents; readonly finance_charge_cents: Cents; readonly payment_cents: Cents; readonly term_months: number; readonly odd_days: number; readonly odd_fraction: string; readonly monthly_rate: string; readonly apr_pct: string; readonly apr_disclosed: string; readonly inputs: Record<string, string | number>; }
/**
 * Appendix J (b)(8): solve A = Σ P / ((1 + f·i)(1 + i)^k), k = 1..n, for the unit-period rate i; APR = 12 i, displayed to three
 * decimals. The solver is 25.1's `solveAppendixJ` (one Appendix J engine on the platform — the LE is the level-payment case
 * with one full unit period before the first payment and f = odd_days / unit_period_days); 25.1's checkpoint `computeApr`
 * adds the dated first-period count, payment streams and the §1026.17(c)(4) disregard on the same solver.
 */
export function computeApr(a: AprInput): AprCalculation {
  if (a.term_months <= 0) throw new RangeError("term_months must be positive");
  if (a.prepaid_finance_charge_cents < 0n) throw new RangeError("prepaid finance charges cannot be negative");
  const pi = levelPayment(a.loan_cents, ratePercent(a.rate_pct), a.term_months) + (a.mi_monthly_cents ?? 0n);
  const odd = a.odd_days ?? 0, unit = a.unit_period_days ?? 30;
  const f = Decimal.ratio(BigInt(odd), BigInt(unit));
  const amount_financed_cents = a.loan_cents - a.prepaid_finance_charge_cents;
  const A = centsToDecimal(amount_financed_cents), P = centsToDecimal(pi);
  const { i } = solveAppendixJ(A, Array.from({ length: a.term_months }, () => P), 1, f);
  const apr = i.mul(Decimal.fromInt(1200));
  return { method: "appendix_j_exact", amount_financed_cents, finance_charge_cents: pi * BigInt(a.term_months) + a.prepaid_finance_charge_cents - a.loan_cents, payment_cents: pi, term_months: a.term_months, odd_days: odd, odd_fraction: f.toFixed(10), monthly_rate: i.toFixed(12), apr_pct: apr.toFixed(6), apr_disclosed: apr.toFixed(3),
    inputs: { loan_cents: a.loan_cents.toString(), rate_pct: a.rate_pct, term_months: a.term_months, prepaid_finance_charge_cents: a.prepaid_finance_charge_cents.toString(), odd_days: odd, unit_period_days: unit } };
}
/** The LE's APR: Appendix J on the finance-charge set after the lender credit (25.1's rules) — the net prepaid finance charge is Σ finance-charge fees − the lender credit absorbed against them, never below zero. */
export function netPrepaidFinanceCharge(items: readonly FeeItemInput[]): Cents {
  const pfc = items.filter((f) => f.finance_charge && f.le_section !== "J_lender_credit").reduce((a, f) => a + f.amount_cents, 0n);
  const credit = -items.filter((f) => f.le_section === "J_lender_credit").reduce((a, f) => a + f.amount_cents, 0n);
  const net = pfc - credit; return net > 0n ? net : 0n;
}

// ============================================================ data hash, H-24 payload, provider list
const canonical = (v: unknown): unknown => typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
export const dataHash = (v: unknown): string => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
export const H24_TEMPLATE_VERSION = "H-24 2017";
export interface PricingScenario { readonly quote_id: string; readonly rate_pct: string; readonly price: string; readonly points_cents: Cents; readonly lender_credit_cents: Cents; readonly locked: boolean; readonly lock_expires_at?: string | null; readonly lock_time_zone?: string | null; }
export interface Provider { readonly party_id: string; readonly name: string; readonly affiliate: boolean; readonly estimated_fee_cents: Cents; }
export interface ProviderListService { readonly service: string; readonly providers: readonly Provider[]; }
/** §1026.19(e)(1)(vi)(C): at least one available provider for every settlement service the consumer may shop for; affiliates flagged (§1024.15 / 21.3). */
export function buildProviderList(fees: readonly FeeItemInput[], providers: Readonly<Record<string, readonly Provider[]>>): ProviderListService[] {
  const shoppable = fees.filter((f) => f.le_section === "C_can_shop" || (f.shoppable && f.le_section === "H_other"));
  return shoppable.map((f) => { const p = providers[f.fee_code] ?? []; if (!p.length) throw new RangeError(`no available provider listed for shoppable service ${f.fee_code} (§1026.19(e)(1)(vi)(C))`); return { service: f.fee_code, providers: [...p] }; });
}

// ============================================================ the LE lifecycle (state machine, timers, evidence)
export type LeStatus = "assembling" | "rendered" | "pending_mlo" | "approved" | "delivered" | "mailed" | "received" | "deemed_received" | "superseded" | "withdrawn_application";
export interface LeRenderInput {
  readonly application_id: string; readonly disclosure_id: string; readonly as_of: PlainDate;
  readonly loan_cents: Cents; readonly term_months: number; readonly transaction_type: "purchase" | "limited_cash_out" | "cash_out"; readonly product: string;
  readonly pricing: PricingScenario; readonly fees: readonly FeeItemInput[]; readonly mi_monthly_cents?: Cents;
  readonly applicants: readonly string[]; readonly property_address: string; readonly estimated_value_cents: Cents;
  readonly creditor: { readonly name: string; readonly nmlsr_id: string; readonly email: string; readonly phone: string };
  readonly loan_officer: { readonly name: string; readonly nmlsr_id: string } | null;
  readonly servicing_intent?: "service" | "transfer";
  readonly calendar?: CreditorCalendarSpec;
  readonly providers?: Readonly<Record<string, readonly Provider[]>>;
}
export interface LeRow {
  readonly application_id: string; readonly disclosure_id: string; readonly kind: "le"; readonly le_version: number; readonly basis: "initial";
  status: LeStatus; readonly rendered_at: string; data_hash: string; readonly template_version: string; readonly time_zone: string;
  readonly servicing_intent: "service"; readonly creditor_nmlsr_id: string; readonly loan_officer_name: string; readonly loan_officer_nmlsr_id: string;
  fees: readonly FeeItem[]; totals: SectionTotals; calcs: LeCalcs; apr: AprCalculation; pricing: PricingScenario; rate_locked: boolean; lock_expires_at: string | null;
  mlo_review_id: string | null; mlo_approved_hash: string | null; mlo_escalation_id: string | null; sla_due_at: string | null;
  delivery_channel: DeliveryChannel | null; delivered_at: string | null; mailed_at: string | null; issued_on: PlainDate | null; esign_consent_id: string | null; mailing_proof_id: string | null;
  deemed_receipt_date: PlainDate | null; received_at: string | null; receipt_evidence: ReceiptEvidence | null; effective_receipt_date: PlainDate | null;
  earliest_consummation_date: PlainDate | null; gate_opened_at: string | null; waiver_consent_id: string | null; closing_costs_expire_at: string | null; closing_costs_expire_display: string | null;
  provider_list: readonly ProviderListService[]; refusals: { at: string; channel: DeliveryChannel; reason: string }[];
  breach: { code: string; at: string; severity: 1; escalated_to: readonly string[]; incident_id: string } | null;
  readonly h24: Record<string, unknown>;
}
export interface EsignConsent { readonly id: string; readonly scope: readonly string[]; readonly granted_at: string; readonly revoked_at?: string | null; }
/** §1026.37(o)(3)(iii): the E-SIGN consent must be scoped to disclosures, granted before delivery and unrevoked. */
export function consentValidFor(c: EsignConsent | null | undefined, deliveredAtIso: string): { ok: boolean; reason?: string } {
  if (!c) return { ok: false, reason: "no E-SIGN consent on file for the disclosures class (15 U.S.C. 7001(c); §1026.37(o)(3)(iii))" };
  if (!c.scope.includes("disclosures")) return { ok: false, reason: `E-SIGN consent ${c.id} is not scoped to disclosures` };
  if (c.revoked_at && Date.parse(c.revoked_at) <= Date.parse(deliveredAtIso)) return { ok: false, reason: `E-SIGN consent ${c.id} was revoked ${c.revoked_at}` };
  if (Date.parse(c.granted_at) > Date.parse(deliveredAtIso)) return { ok: false, reason: `E-SIGN consent ${c.id} (${c.granted_at}) was not obtained before delivery ${deliveredAtIso}` };
  return { ok: true };
}
export class LeRefused extends Error { readonly code: string; constructor(code: string, msg: string) { super(`${code}: ${msg}`); this.name = "LeRefused"; this.code = code; } }
interface EscalationOpener { open(input: { kind: "mlo_of_record" | "sev1" | "sev2"; applicationId?: string; severity?: string; ownerRole?: string; payload?: Record<string, unknown> }, by: Actor): { id: string }; }
export interface LeServiceDeps { readonly events: EventStore; readonly clock: Clock; readonly escalations?: EscalationOpener; readonly calendar?: CreditorCalendarSpec; }

export class LoanEstimateService {
  private readonly events: EventStore; private readonly clock: Clock; private readonly esc: EscalationOpener; readonly calendar: CreditorCalendarSpec;
  private readonly rows = new Map<string, LeRow>();
  private readonly breaches = new Map<string, LeRow["breach"]>();
  private readonly apps = new Map<string, { trid_received_at: string; trid_application_date: PlainDate; le_due_on: PlainDate; le_due_at: string }>();
  constructor(deps: LeServiceDeps) {
    this.events = deps.events; this.clock = deps.clock; this.calendar = deps.calendar ?? PHOENIX_CREDITOR;
    this.esc = deps.escalations ?? { open: (input, by) => { const id = `ESC-${this.events.all().length + 1}`; this.events.append({ type: "escalation.created", applicationId: input.applicationId ?? "", actor: by, payload: { escalation_id: id, kind: input.kind, owner_role: input.ownerRole ?? input.kind, severity: input.severity ?? null, ...(input.payload ?? {}) } }); return { id }; } };
  }
  private append(type: string, applicationId: string, payload: Record<string, unknown>, actor: Actor = AGENT, occurredAt?: string): DomainEvent {
    return this.events.append({ type, applicationId, actor, payload: { application_id: applicationId, ...payload }, ...(occurredAt ? { occurredAt } : {}) });
  }
  get(disclosureId: string): LeRow { const r = this.rows.get(disclosureId); if (!r) throw new RangeError(`no LE ${disclosureId}`); return r; }
  forApplication(applicationId: string): LeRow | undefined { return [...this.rows.values()].find((r) => r.application_id === applicationId && r.le_version === 1); }
  application(applicationId: string) { const a = this.apps.get(applicationId); if (!a) throw new RangeError(`no application ${applicationId} — application.trid_received not seen`); return a; }

  /** `application.trid_received` (21.1): the TRID application date in the creditor's zone and `le_due_at` (the engine arms REGZ_1026_19E1_LE_3BD from the event itself). */
  onTridReceived(applicationId: string, tridReceivedAtIso: string): { trid_application_date: PlainDate; le_due_on: PlainDate; le_due_at: string } {
    nonEmpty(applicationId, "application_id"); nonEmpty(tridReceivedAtIso, "trid_received_at");
    const trid_application_date = tridApplicationDate(tridReceivedAtIso, this.calendar.time_zone); const due = leDueAt(trid_application_date, this.calendar);
    const rec = { trid_received_at: tridReceivedAtIso, trid_application_date, le_due_on: due.due_on, le_due_at: due.due_at }; this.apps.set(applicationId, rec);
    return { trid_application_date, le_due_on: due.due_on, le_due_at: due.due_at };
  }
  /** Fee assembly → tolerance classes → calculations → H-24 data → `rendered` with its data hash; the servicing statement is always `service` and the MLO's NMLSR ID is mandatory (§1026.36(g)). */
  render(i: LeRenderInput): LeRow {
    nonEmpty(i.application_id, "application_id"); nonEmpty(i.disclosure_id, "disclosure_id"); nonEmpty(i.creditor?.nmlsr_id, "creditor NMLSR ID");
    if (!i.loan_officer || !i.loan_officer.nmlsr_id) throw new LeRefused("NO_MLO_NMLSR_ID", "an LE is never issued without the MLO of record's NMLSR ID (§1026.36(g); SAFE_1008_103_MLO_OF_RECORD_GATE)");
    if (i.servicing_intent !== undefined && i.servicing_intent !== "service") throw new LeRefused("SERVICING_INTENT", "the servicing statement is never altered from `service` (rule 7; §1026.37(m)(6))");
    const fees = assembleFees(i.fees, i.as_of);
    const totals = sectionTotals(fees);
    const calcs = loanEstimateCalcs({ loan_cents: i.loan_cents, rate_pct: i.pricing.rate_pct, term_months: i.term_months, loan_costs_cents: totals.loan_costs_cents, ...(i.mi_monthly_cents !== undefined ? { mi_monthly_cents: i.mi_monthly_cents } : {}) });
    const apr = computeApr({ loan_cents: i.loan_cents, rate_pct: i.pricing.rate_pct, term_months: i.term_months, prepaid_finance_charge_cents: netPrepaidFinanceCharge(fees), ...(i.mi_monthly_cents !== undefined ? { mi_monthly_cents: i.mi_monthly_cents } : {}) });
    const provider_list = i.providers ? buildProviderList(fees, i.providers) : [];
    const existing = this.rows.get(i.disclosure_id);
    const classed: FeeItem[] = fees.map((f) => ({ ...f, tolerance_class: deriveToleranceClass(f), baseline_amount_cents: f.amount_cents, baseline_disclosure_id: i.disclosure_id }));
    const h24 = h24Payload({ ...i, fees: classed, totals, calcs, apr, rendered_on: civilDate(this.clock.now(), this.calendar.time_zone) });
    const hash = dataHash({ loan_cents: i.loan_cents, term_months: i.term_months, pricing: i.pricing, fees: classed.map((f) => [f.fee_code, f.amount_cents]), calcs, apr: apr.apr_disclosed, loan_officer: i.loan_officer });
    const row: LeRow = { ...(existing ?? {}), application_id: i.application_id, disclosure_id: i.disclosure_id, kind: "le", le_version: 1, basis: "initial", status: "rendered", rendered_at: this.clock.now(), data_hash: hash, template_version: H24_TEMPLATE_VERSION, time_zone: this.calendar.time_zone,
      servicing_intent: "service", creditor_nmlsr_id: i.creditor.nmlsr_id, loan_officer_name: i.loan_officer.name, loan_officer_nmlsr_id: i.loan_officer.nmlsr_id, fees: classed, totals, calcs, apr, pricing: i.pricing, rate_locked: i.pricing.locked, lock_expires_at: i.pricing.lock_expires_at ?? null,
      mlo_review_id: existing?.mlo_review_id ?? null, mlo_approved_hash: existing?.mlo_approved_hash ?? null, mlo_escalation_id: existing?.mlo_escalation_id ?? null, sla_due_at: existing?.sla_due_at ?? null,
      delivery_channel: null, delivered_at: null, mailed_at: null, issued_on: null, esign_consent_id: null, mailing_proof_id: null, deemed_receipt_date: null, received_at: null, receipt_evidence: null, effective_receipt_date: null,
      earliest_consummation_date: null, gate_opened_at: null, waiver_consent_id: null, closing_costs_expire_at: null, closing_costs_expire_display: null, provider_list, refusals: existing?.refusals ?? [], breach: existing?.breach ?? this.breaches.get(i.application_id) ?? null, h24 };
    this.rows.set(i.disclosure_id, row);
    this.append("disclosure.le.rendered", i.application_id, { disclosure_id: i.disclosure_id, le_version: 1, data_hash: hash, template_version: H24_TEMPLATE_VERSION, pricing_scenario_id: i.pricing.quote_id, apr: apr.apr_disclosed, tip_pct: calcs.tip_pct });
    return row;
  }
  /** Stage `le_terms` escalation to the MLO of record; the SLA clock is +1 creditor BD capped at `le_due_at` − 2h (SM_O22_MLO_LE_REVIEW_SLA_1BD). */
  openMloReview(disclosureId: string): { escalation_id: string; sla_due_at: string } {
    const r = this.get(disclosureId); const app = this.application(r.application_id);
    const sla_due_at = mloReviewSlaDueAt(this.clock.now(), app.le_due_at, this.calendar);
    const e = this.esc.open({ kind: "mlo_of_record", applicationId: r.application_id, payload: { stage: "le_terms", disclosure_id: disclosureId, data_hash: r.data_hash, sla_due_at, le_due_at: app.le_due_at, pricing_rationale: `scenario ${r.pricing.quote_id} at ${r.pricing.rate_pct}% / ${r.pricing.price}` } }, AGENT);
    r.status = "pending_mlo"; r.mlo_escalation_id = e.id; r.sla_due_at = sla_due_at;
    return { escalation_id: e.id, sla_due_at };
  }
  /** `mlo_reviews.decision` for this exact data hash; `approved` only when the hash matches the current rendering. */
  mloDecision(disclosureId: string, d: { review_id: string; decision: "approved" | "returned"; data_hash: string; nmlsr_id: string; note?: string }): LeRow {
    const r = this.get(disclosureId); nonEmpty(d.review_id, "review_id"); nonEmpty(d.nmlsr_id, "nmlsr_id");
    if (d.nmlsr_id !== r.loan_officer_nmlsr_id) throw new LeRefused("MLO_MISMATCH", `review by NMLSR ${d.nmlsr_id} is not the MLO of record ${r.loan_officer_nmlsr_id}`);
    this.append("disclosure.le.mlo_reviewed", r.application_id, { disclosure_id: disclosureId, mlo_review_id: d.review_id, decision: d.decision, data_hash: d.data_hash, nmlsr_id: d.nmlsr_id, note: d.note ?? null });
    r.mlo_review_id = d.review_id;
    if (d.decision === "returned") { r.status = "rendered"; return r; }
    if (d.data_hash !== r.data_hash) throw new LeRefused("MLO_APPROVAL_HASH", `approval is for data hash ${d.data_hash.slice(0, 8)} but the current rendering is ${r.data_hash.slice(0, 8)}`);
    r.mlo_approved_hash = d.data_hash; r.status = "approved";
    this.append("disclosure.le.mlo_approved", r.application_id, { disclosure_id: disclosureId, mlo_review_id: d.review_id, data_hash: d.data_hash, nmlsr_id: d.nmlsr_id });
    return r;
  }
  /** A changed pricing scenario after approval re-renders: new hash, back to `rendered`, the old approval no longer releases anything. */
  reprice(disclosureId: string, input: LeRenderInput): LeRow { const r = this.get(disclosureId); if (r.issued_on) throw new LeRefused("ALREADY_ISSUED", "a delivered LE is revised by 21.5, not re-rendered here"); return this.render(input); }

  /** Deliver (esign_portal/in_person/courier) or place in the mail (print vendor proof): guards — MLO approval for this exact hash; E-SIGN consent for electronic channels. Emits the spec's channel event and `disclosure.le.issued`, derives the mailbox date, the 7-SBD gate date and the closing-cost expiration, and sets the fee baseline. */
  deliver(disclosureId: string, d: { channel: DeliveryChannel; at?: string; consent?: EsignConsent | null; mailing_proof_id?: string | null; ai_intake_mode?: "assisted" | "supervised_present" | "autonomous" }): LeRow {
    const r = this.get(disclosureId); const at = d.at ?? this.clock.now();
    if (!DELIVERY_CHANNELS.includes(d.channel)) throw new RangeError(`channel ${d.channel} is not one of ${DELIVERY_CHANNELS.join("/")}`);
    if (r.issued_on) throw new LeRefused("ALREADY_ISSUED", `LE ${disclosureId} was already issued on ${r.issued_on}`);
    const refuse = (code: string, reason: string): never => { r.refusals.push({ at, channel: d.channel, reason }); this.append("disclosure.le.delivery.refused", r.application_id, { disclosure_id: disclosureId, channel: d.channel, code, reason }, AGENT, at); throw new LeRefused(code, reason); };
    if ((d.ai_intake_mode ?? "assisted") === "assisted" && (r.mlo_approved_hash === null || r.mlo_approved_hash !== r.data_hash)) refuse("MLO_APPROVAL_REQUIRED", r.mlo_approved_hash === null ? "no MLO-of-record approval exists for this LE's data hash (assisted mode)" : `the MLO approved hash ${r.mlo_approved_hash.slice(0, 8)} but the pricing scenario changed to ${r.data_hash.slice(0, 8)}; a new approval is required before release`);
    if (isElectronic(d.channel)) { const c = consentValidFor(d.consent, at); if (!c.ok) refuse("NO_ESIGN_CONSENT", `${c.reason} — deliver by print the same day; the mailbox rule applies`); }
    if (d.channel === "mail" && !d.mailing_proof_id) refuse("NO_MAILING_PROOF", "a mailed LE needs the print vendor's mailing-date evidence");
    const issued_on = civilDate(at, this.calendar.time_zone);
    const receipt = receiptDetermination({ channel: d.channel, issued_on, evidence_at: null, time_zone: this.calendar.time_zone });
    const exp = closingCostsExpireAt(issued_on, this.calendar);
    r.delivery_channel = d.channel; r.issued_on = issued_on; r.esign_consent_id = isElectronic(d.channel) ? d.consent!.id : null; r.mailing_proof_id = d.mailing_proof_id ?? null;
    r.deemed_receipt_date = receipt.deemed_receipt_date; r.earliest_consummation_date = earliestConsummationDate(issued_on); r.closing_costs_expire_at = exp.expires_at; r.closing_costs_expire_display = exp.display;
    if (d.channel === "mail") { r.mailed_at = at; r.status = "mailed"; this.append("disclosure.le.mailed", r.application_id, { disclosure_id: disclosureId, le_version: 1, mailed_at: at, mailing_proof_id: d.mailing_proof_id, issued_on }, AGENT, at); }
    else { r.delivered_at = at; r.status = "delivered"; this.append("disclosure.le.delivered", r.application_id, { disclosure_id: disclosureId, le_version: 1, channel: d.channel, delivered_at: at, esign_consent_id: r.esign_consent_id, issued_on }, AGENT, at); }
    this.append("disclosure.le.issued", r.application_id, { disclosure_id: disclosureId, le_version: 1, channel: d.channel, in_person: isInPerson(d.channel), issued_on, deemed_receipt_date: receipt.deemed_receipt_date, earliest_consummation_date: r.earliest_consummation_date, closing_costs_expire_at: exp.expires_at }, AGENT, at);
    if (r.provider_list.length) this.append("provider_list.delivered", r.application_id, { disclosure_id: disclosureId, services: r.provider_list.map((s) => s.service), delivered_with_le: true }, AGENT, at);
    this.setFeeBaseline(disclosureId, at);
    if (isInPerson(d.channel)) { r.received_at = at; r.receipt_evidence = "in_person"; r.effective_receipt_date = issued_on; r.status = "received"; this.append("disclosure.le.received", r.application_id, { disclosure_id: disclosureId, evidence: "in_person", received_on: issued_on, effective_receipt_date: issued_on }, AGENT, at); }
    return r;
  }
  /** `fee.baseline.set`: the LE fixes the good-faith baseline for every fee (§1026.19(e)(3)); 21.5 tests against these classes. */
  setFeeBaseline(disclosureId: string, at?: string): { ten_percent_baseline_cents: Cents; items: readonly FeeItem[] } {
    const r = this.get(disclosureId); const ten_percent_baseline_cents = tenPercentAggregate(r.fees);
    this.append("fee.baseline.set", r.application_id, { disclosure_id: disclosureId, le_version: 1, ten_percent_baseline_cents: ten_percent_baseline_cents.toString(), lender_credit_baseline_cents: r.totals.lender_credits_cents.toString(),
      items: r.fees.map((f) => ({ fee_code: f.fee_code, le_section: f.le_section, tolerance_class: f.tolerance_class, baseline_amount_cents: f.amount_cents.toString(), estimate_source: f.estimate_source, estimate_source_ref: f.estimate_source_ref })) }, AGENT, at);
    return { ten_percent_baseline_cents, items: r.fees };
  }
  /** Receipt evidence tied to the authenticated borrower (portal view, acknowledgement reply, e-signature) → `received_at` and an earlier `effective_receipt_date`. */
  recordReceipt(disclosureId: string, ev: { kind: "authenticated_view" | "acknowledgement" | "esignature"; at: string; borrower_id: string }): LeRow {
    const r = this.get(disclosureId); if (!r.issued_on || r.delivery_channel === null) throw new LeRefused("NOT_ISSUED", "no delivery to evidence receipt of"); nonEmpty(ev.borrower_id, "borrower_id");
    if (r.receipt_evidence === "esign_confirmed" || r.receipt_evidence === "in_person") return r;
    const rec = receiptDetermination({ channel: r.delivery_channel, issued_on: r.issued_on, evidence_at: ev.at, time_zone: this.calendar.time_zone });
    r.received_at = ev.at; r.receipt_evidence = rec.receipt_evidence; r.effective_receipt_date = rec.effective_receipt_date; r.status = "received";
    this.append("disclosure.le.received", r.application_id, { disclosure_id: disclosureId, evidence: rec.receipt_evidence, evidence_kind: ev.kind, borrower_id: ev.borrower_id, received_on: rec.received_on, effective_receipt_date: rec.effective_receipt_date }, AGENT, ev.at);
    return r;
  }
  /** Mailbox presumption sweep: once the third specific business day has passed with no evidence, the LE is deemed received (feeds 21.4's fee/intent gate). */
  deemReceived(disclosureId: string, today: PlainDate): LeRow {
    const r = this.get(disclosureId);
    if (r.receipt_evidence || !r.deemed_receipt_date || today < r.deemed_receipt_date) return r;
    r.receipt_evidence = "mailbox_rule"; r.effective_receipt_date = r.deemed_receipt_date; r.status = "deemed_received";
    this.append("disclosure.le.deemed_received", r.application_id, { disclosure_id: disclosureId, deemed_receipt_date: r.deemed_receipt_date, effective_receipt_date: r.deemed_receipt_date });
    this.append("disclosure.le.received", r.application_id, { disclosure_id: disclosureId, evidence: "mailbox_rule", received_on: null, effective_receipt_date: r.deemed_receipt_date });
    return r;
  }
  gateFacts(applicationId: string, requestedOn: PlainDate): GateFacts {
    const r = this.forApplication(applicationId);
    return { ...(r?.earliest_consummation_date ? { earliest_consummation_date: r.earliest_consummation_date } : {}), requested_on: requestedOn, waiver_recorded_on: r?.gate_opened_at && r.waiver_consent_id ? civilDate(r.gate_opened_at, this.calendar.time_zone) : null };
  }
  /** `assertGateOpen(application_id, REGZ_1026_19E1III_LE_7SBD_GATE)` for consummation / CD scheduling (25.2, 26.x). */
  assertGateOpen(applicationId: string, requestedOn: PlainDate): void { assertGateOpen(this.gateFacts(applicationId, requestedOn)); }
  /** Daily sweep: on the earliest consummation date the gate opens and the row's satisfying event is emitted. */
  openGateIfDue(disclosureId: string, today: PlainDate): boolean {
    const r = this.get(disclosureId); if (r.gate_opened_at || !r.earliest_consummation_date || today < r.earliest_consummation_date) return false;
    r.gate_opened_at = this.clock.now(); this.append("gate.le_7sbd.opened", r.application_id, { disclosure_id: disclosureId, earliest_consummation_date: r.earliest_consummation_date, waived: false }); return true;
  }
  /** §1026.19(e)(1)(v): a bona fide personal financial emergency — written, dated, signed by every consumer, never a printed form — opens the gate on receipt. */
  recordEmergencyWaiver(disclosureId: string, w: { consent_id: string; signed_on: PlainDate; all_consumers_signed: boolean; printed_form: boolean; statement: string }): LeRow {
    const r = this.get(disclosureId); nonEmpty(w.consent_id, "consent_id"); nonEmpty(w.statement, "statement");
    if (!r.issued_on) throw new LeRefused("NOT_ISSUED", "the waiver may only follow receipt of the LE (§1026.19(e)(1)(v))");
    if (w.printed_form) throw new LeRefused("PRINTED_FORM", "printed waiver forms are prohibited (§1026.19(e)(1)(v))");
    if (!w.all_consumers_signed) throw new LeRefused("ALL_CONSUMERS", "every consumer must sign the dated written statement");
    r.waiver_consent_id = w.consent_id; r.gate_opened_at = this.clock.now();
    this.append("gate.le_7sbd.opened", r.application_id, { disclosure_id: disclosureId, earliest_consummation_date: r.earliest_consummation_date, waived: true, waiver_consent_id: w.consent_id, signed_on: w.signed_on, consent_kind: "trid_7day_waiver" });
    return r;
  }
  /** REGZ_1026_37A13_COSTS_EXPIRE_10BD: expired when 5:00 p.m. creditor time on the tenth creditor business day passed with no intent (21.5 may then reset under (e)(3)(iv)(E)). */
  intentReceivedAt(applicationId: string): string | null { const e = this.events.ofType("intent.to_proceed.received").find((x) => x.applicationId === applicationId || (x.payload as { application_id?: string }).application_id === applicationId); return e?.occurredAt ?? null; }
  costsExpired(disclosureId: string, nowIso: string): boolean { const r = this.get(disclosureId); if (!r.closing_costs_expire_at) return false; const intent = this.intentReceivedAt(r.application_id); return (intent === null || Date.parse(intent) > Date.parse(r.closing_costs_expire_at)) && Date.parse(nowIso) > Date.parse(r.closing_costs_expire_at); }
  /** Comment 37(a)(13)-4: once intent is indicated within the period, the expiration field on a later LE is left blank. */
  closingCostsExpirationField(disclosureId: string): string | null { const r = this.get(disclosureId); const intent = this.intentReceivedAt(r.application_id); if (r.closing_costs_expire_at && intent && Date.parse(intent) <= Date.parse(r.closing_costs_expire_at)) return null; return r.closing_costs_expire_display; }
  /** Breach of REGZ_1026_19E1_LE_3BD: sev 1 to compliance-sentinel and the partner officer, an incident record for the exam file; the LE still issues immediately. */
  onLeDeadlineBreached(applicationId: string, nowIso: string): { severity: 1; escalated_to: readonly string[]; incident_id: string } {
    const r = this.forApplication(applicationId); const incident_id = `INC-LE3BD-${applicationId}`;
    const escalated_to = ["compliance-sentinel", "officer"] as const;
    this.esc.open({ kind: "sev1", applicationId, severity: "1", ownerRole: "officer", payload: { code: "REGZ_1026_19E1_LE_3BD", incident_id, root_cause_required: true, escalated_to: [...escalated_to] } }, AGENT);
    this.append("compliance.incident.opened", applicationId, { incident_id, code: "REGZ_1026_19E1_LE_3BD", severity: 1, escalated_to: [...escalated_to], root_cause_required: true, breached_at: nowIso });
    const rec = { code: "REGZ_1026_19E1_LE_3BD", at: nowIso, severity: 1 as const, escalated_to, incident_id }; this.breaches.set(applicationId, rec); if (r) r.breach = rec;
    return { severity: 1, escalated_to, incident_id };
  }
  /** The decision record the `disclosure` agent writes (spec 21.2 AI agent design). */
  decisionRecord(disclosureId: string, run: { model_version: string; prompt_version: string; rationale: string }): Record<string, unknown> {
    const r = this.get(disclosureId); const app = this.apps.get(r.application_id);
    return { application_id: r.application_id, disclosure_id: disclosureId, le_version: r.le_version, trid_application_date: app?.trid_application_date ?? null, le_due_at: app?.le_due_at ?? null,
      fees: r.fees.map((f) => ({ fee: f.fee_code, section: f.le_section, source: f.estimate_source, ref: f.estimate_source_ref, amount: f.amount_cents.toString(), tolerance_class: f.tolerance_class })),
      pricing_scenario_id: r.pricing.quote_id, calculations: { apr: r.apr.apr_disclosed, tip: r.calcs.tip_pct, in5y: r.calcs.in_5y_total_cents.toString() }, mlo_review_id: r.mlo_review_id, data_hash: r.data_hash,
      delivery: { channel: r.delivery_channel, consent_id: r.esign_consent_id, delivered_at: r.delivered_at, mailed_at: r.mailed_at, refusals: r.refusals.map((x) => ({ channel: x.channel, reason: x.reason, at: x.at })) },
      receipt: { evidence: r.receipt_evidence, effective_receipt_date: r.effective_receipt_date }, earliest_consummation_date: r.earliest_consummation_date, closing_costs_expire_at: r.closing_costs_expire_at,
      model_version: run.model_version, prompt_version: run.prompt_version, rationale: run.rationale };
  }
}

// ============================================================ H-24 payload
const secLabel: Record<LeSection, string> = { A_origination: "A. Origination Charges", B_cannot_shop: "B. Services You Cannot Shop For", C_can_shop: "C. Services You Can Shop For", E_taxes_gov: "E. Taxes and Other Government Fees", F_prepaids: "F. Prepaids", G_initial_escrow: "G. Initial Escrow Payment at Closing", H_other: "H. Other", J_lender_credit: "Lender Credits" };
/** The form H-24 data set (§1026.37) rendered by NTC_REGZ_1026_37_LE. */
export function h24Payload(i: Omit<LeRenderInput, "fees"> & { fees: readonly FeeItem[]; totals: SectionTotals; calcs: LeCalcs; apr: AprCalculation; rendered_on: PlainDate }): Record<string, unknown> {
  const items = (s: LeSection) => i.fees.filter((f) => f.le_section === s).map((f) => `${f.description} ${formatCents(f.amount_cents)}`);
  const lockTz = i.pricing.lock_time_zone ?? null; const lockMs = i.pricing.lock_expires_at ? Date.parse(i.pricing.lock_expires_at) : null;
  return { date_issued: i.rendered_on, applicants: i.applicants.join("; "), property_address: i.property_address, estimated_value_cents: i.estimated_value_cents, loan_term_years: Math.round(i.term_months / 12), purpose: i.transaction_type === "purchase" ? "Purchase" : "Refinance", product: i.product, loan_type: "Conventional",
    rate_locked: i.pricing.locked, lock_expires: lockMs !== null && lockTz ? `${wallClock(lockMs, lockTz).date} ${String(wallClock(lockMs, lockTz).hour).padStart(2, "0")}:${String(wallClock(lockMs, lockTz).minute).padStart(2, "0")} ${tzAbbreviation(lockTz, lockMs)}` : "",
    loan_amount_cents: i.loan_cents, interest_rate_pct: i.pricing.rate_pct, pi_cents: i.calcs.pi_cents, mi_monthly_cents: i.mi_monthly_cents ?? 0n, loan_costs_cents: i.totals.loan_costs_cents, other_costs_cents: i.totals.other_costs_cents, lender_credits_cents: i.totals.lender_credits_cents, total_closing_costs_cents: i.totals.total_closing_costs_cents,
    section_a: items("A_origination"), section_b: items("B_cannot_shop"), section_c: items("C_can_shop"), section_e: items("E_taxes_gov"), section_f: items("F_prepaids"), section_g: items("G_initial_escrow"), section_h: items("H_other"), section_labels: Object.values(secLabel),
    total_a_cents: i.totals.A, total_b_cents: i.totals.B, total_c_cents: i.totals.C, total_e_cents: i.totals.E, total_f_cents: i.totals.F, total_g_cents: i.totals.G, total_h_cents: i.totals.H,
    lender_name: i.creditor.name, lender_nmlsr_id: i.creditor.nmlsr_id, lender_email: i.creditor.email, lender_phone: i.creditor.phone, loan_officer_name: i.loan_officer?.name ?? "", loan_officer_nmlsr_id: i.loan_officer?.nmlsr_id ?? "",
    in_5y_total_cents: i.calcs.in_5y_total_cents, in_5y_principal_cents: i.calcs.in_5y_principal_cents, apr_pct: i.apr.apr_disclosed, tip_pct: i.calcs.tip_pct, servicing_intent: "service", refinance_transaction: i.transaction_type !== "purchase", late_payment_statement: "If your payment is more than 15 days late, we will charge a late fee of 5% of the monthly principal and interest payment." };
}
