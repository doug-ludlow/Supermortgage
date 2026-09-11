/**
 * §25.3 Right of rescission (refinances of principal dwellings) — pure rule functions, one per rule / T-id.
 * spec/sections/25-compliance-testing-the-closing-disclosure-rescission-and-clo/25-3-right-of-rescission-refinances-of-principal-dwellings-notice.md
 *
 *   determineRescindability        §1026.23(f)(1)–(3), comment 23(f)-4, decision 25.3-Q6 (per-consumer occupancy)
 *   rescissionExpiry               §1026.23(a)(3)(i): midnight of the 3rd `business_days_regz_specific` day (Saturdays count)
 *   computeRescissionPeriod        the LATEST of consummation / notice delivery / material disclosures, per consumer, then across consumers
 *   materialDisclosureAccuracy     §1026.23(g)(1)(i) ½ % / (g)(2)(i) 1 % / (h) $35 tolerances (25.1's (o)(2) verdict carried alongside)
 *   fundingReleaseDate / fedwire   §1026.23(c) has no business-day condition on the disbursement day — the Fed holiday calendar does
 *   sweepChannels                  comment 23(c): "reasonably satisfied that the consumer has not rescinded"
 *   validateRescissionWaiver       §1026.23(e): consumer-authored, dated, signed by all; "Printed forms for this purpose are prohibited"
 *   evaluateExercise               §1026.23(a)(2): given when mailed (postmark) / delivered; (d)(2) 20 calendar days to unwind
 *   noticeAtSigningCheck           §1026.23(b)(1): two copies per consumer (one when electronic under E-SIGN — 25.3-Q1 delivers two anyway)
 *   classifyInboundDocument        an "I want to cancel" message is always a rescission candidate (oral = not a valid exercise)
 *
 * Every event carries `applicationId` so the 25.3 timers arm under origination context (src/kernel/timers/engine.ts
 * isOriginationContext). Delivery/receipt evidence rides 21.2's channel/receipt machinery (ops-21-2.ts); the material-
 * disclosure accuracy verdict reuses 25.1's finance-charge test shape (ops-25-1.ts) with the §1026.23(g)/(h) tolerances.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { ratePercent } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, addYears, dayOfWeek, isWeekend, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, regzSpecific, rollForward, type Calendar } from "../../kernel/calendar/business.ts";
import { federalHolidays } from "../../kernel/calendar/holidays.ts";
import { toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { AGENT, civilDate, isElectronic, tzAbbreviation, consentValidFor, type DeliveryChannel, type EsignConsent } from "../application/ops-21-2.ts";
import { financeChargeAccuracyTest, type FinanceChargeAccuracy } from "./ops-25-1.ts";

export { AGENT };
export const RULE_SET_25_3 = "regz.rescission.1026_23";
export const RETENTION_CLASS_25_3 = "regz_cd_5y";
export const CITATION = "12 CFR 1026.23";

export class RescissionRefused extends Error {
  readonly code: string; readonly citation: string;
  constructor(code: string, citation: string, msg: string) { super(`${code}: ${msg}`); this.name = "RescissionRefused"; this.code = code; this.citation = citation; }
}
const need = (ok: boolean, msg: string): void => { if (!ok) throw new RangeError(msg); };
const laterDate = (a: PlainDate, b: PlainDate): PlainDate => (b > a ? b : a);

// ============================================================ Fedwire calendar (§1026.23(c) does not require a business day; the Fed does)
/** frbservices.org holiday schedule: weekends closed; federal holidays closed; a Saturday holiday leaves "the preceding Friday" OPEN; a Sunday holiday is observed "the following Monday". */
function fedwireClosed(d: PlainDate): boolean {
  const year = Number(d.slice(0, 4));
  return federalHolidays(year).some((h) => dayOfWeek(h.date) !== 6 && h.observed === d);
}
export const fedwire: Calendar = { unit: "business_days_federal", timeZone: "America/New_York", isBusinessDay: (d) => !isWeekend(d) && !fedwireClosed(d) };
export const isFedwireOpen = (d: PlainDate): boolean => fedwire.isBusinessDay(d);

// ============================================================ applicability (§1026.23(a)(1), (f); comment 23(f)-4; decision 25.3-Q6)
export type RescissionApplicability = "rescindable_full" | "rescindable_new_advance" | "exempt_purchase_money" | "exempt_same_creditor_no_new_money" | "not_principal_dwelling" | "exempt_other";
export type RescissionForm = "h8" | "h9" | "none";
export type Occupancy = "primary" | "second_home" | "investment";
export type TransactionType = "purchase" | "construction_initial" | "limited_cash_out" | "cash_out" | "rate_term" | "other";
export interface RescissionConsumer { readonly consumer_id: string; readonly role: "borrower" | "non_borrower_owner"; readonly ownership_interest: boolean; readonly occupancy: Occupancy; readonly ownership_basis?: string; }
export interface ExistingLoan { readonly original_creditor_id: string; readonly upb_cents: Cents; readonly earned_unpaid_finance_charge_cents: Cents; readonly refinancing_costs_cents: Cents; }
export interface RescindabilityInput {
  readonly application_id: string; readonly transaction_type: TransactionType; readonly consumers: readonly RescissionConsumer[]; readonly partner_id: string;
  /** Creditors merged into the partner — the successor is the original creditor (comment 23(f)-4). */
  readonly predecessor_creditor_ids?: readonly string[]; readonly existing_loan?: ExistingLoan | null; readonly amount_financed_cents: Cents; readonly state_agency_creditor?: boolean;
}
export interface Rescindability {
  readonly application_id: string; readonly applicability: RescissionApplicability; readonly form: RescissionForm; readonly original_creditor_match: boolean;
  /** H-9: the new advance = amount financed − (UPB + earned unpaid finance charge + costs of the refinancing); null for a fully rescindable (H-8) transaction. */
  readonly rescindable_amount_cents: Cents | null; readonly consumers: readonly RescissionConsumer[]; readonly gated: boolean; readonly citation: string; readonly rationale: string;
}
/** Consumers entitled to rescind: an ownership interest subject to the security interest in a dwelling that is THAT person's principal dwelling (§1026.2(a)(11); comment 23(a)(1)-2; decision Q6). */
export const entitledConsumers = (consumers: readonly RescissionConsumer[]): RescissionConsumer[] => consumers.filter((c) => c.ownership_interest && c.occupancy === "primary");
export const newAdvanceCents = (amount_financed_cents: Cents, x: ExistingLoan): Cents => amount_financed_cents - (x.upb_cents + x.earned_unpaid_finance_charge_cents + x.refinancing_costs_cents);
export function determineRescindability(i: RescindabilityInput): Rescindability {
  need(i.consumers.length > 0, "at least one consumer with a title/vesting record (application_properties, title_orders)");
  const base = { application_id: i.application_id, consumers: entitledConsumers(i.consumers), original_creditor_match: false, rescindable_amount_cents: null };
  if (i.transaction_type === "purchase" || i.transaction_type === "construction_initial") return { ...base, applicability: "exempt_purchase_money", form: "none", gated: false, citation: "§1026.23(f)(1); §1026.2(a)(24)", rationale: "residential mortgage transaction — the security interest finances the acquisition or initial construction of the dwelling" };
  if (base.consumers.length === 0) return { ...base, applicability: "not_principal_dwelling", form: "none", gated: false, citation: "§1026.23(a)(1); §1026.2(a)(11)", rationale: `no consumer with an ownership interest occupies the dwelling as a principal dwelling (occupancy: ${[...new Set(i.consumers.map((c) => c.occupancy))].join("/")})` };
  if (i.state_agency_creditor) return { ...base, applicability: "exempt_other", form: "none", gated: false, citation: "§1026.23(f)(3)", rationale: "state-agency creditor" };
  const x = i.existing_loan ?? null;
  const match = !!x && (x.original_creditor_id === i.partner_id || (i.predecessor_creditor_ids ?? []).includes(x.original_creditor_id));
  if (x && match) {
    const advance = newAdvanceCents(i.amount_financed_cents, x);
    if (advance <= 0n) return { ...base, original_creditor_match: true, rescindable_amount_cents: advance, applicability: "exempt_same_creditor_no_new_money", form: "none", gated: false, citation: "§1026.23(f)(2)", rationale: `same-creditor refinancing with no new advance: ${advance} = amount financed − (UPB + earned unpaid finance charge + refinancing costs) ≤ 0` };
    return { ...base, original_creditor_match: true, rescindable_amount_cents: advance, applicability: "rescindable_new_advance", form: "h9", gated: true, citation: "§1026.23(f)(2) second sentence; comment 23(f)-4", rationale: `same-creditor refinancing: the new advance of ${advance} cents is rescindable (H-9)` };
  }
  return { ...base, applicability: "rescindable_full", form: "h8", gated: true, citation: "§1026.23(a)(1); comment 23(f)-4 (exemption applies only to refinancings by the original creditor)", rationale: x ? `existing loan originated by ${x.original_creditor_id}, not the partner ${i.partner_id} — fully rescindable (H-8); Fannie Mae ownership of the existing loan does not change the original-creditor test` : "non-purchase-money transaction secured by a principal dwelling — fully rescindable (H-8)" };
}
/** Decision 25.3-Q3: the payoff and the new advance are never separated — the ENTIRE disbursement is held until expiry, even for an H-9 loan. */
export function disbursementHold(r: Pick<Rescindability, "form" | "rescindable_amount_cents" | "gated">, total_disbursement_cents: Cents): { held_cents: Cents; released_early_cents: Cents; basis: string } {
  if (!r.gated) return { held_cents: 0n, released_early_cents: total_disbursement_cents, basis: "not rescindable — no rescission hold" };
  return { held_cents: total_disbursement_cents, released_early_cents: 0n, basis: r.form === "h9" ? `H-9: only ${r.rescindable_amount_cents} cents is rescindable but the whole disbursement is held (decision 25.3-Q3 — no escrow disbursement of the exempt portion)` : "H-8: entire transaction rescindable" };
}

// ============================================================ the period (§1026.23(a)(3)(i); comment 23(a)(3)-1)
/** Midnight of the third specific business day after `period_start_date`: `expires_on` is day 3; `expires_at` is 00:00 local of the following day (Nov 10 24:00 MST = 2026-11-11T07:00:00Z). */
export function rescissionExpiry(period_start_date: PlainDate, time_zone: string): { expires_on: PlainDate; expires_at: string; expires_display: string } {
  const expires_on = addBusinessDays(period_start_date, 3, regzSpecific);
  const ms = zonedEpochMs(addDays(expires_on, 1), "00:00", time_zone);
  return { expires_on, expires_at: toIso(ms), expires_display: `${expires_on}T24:00 ${tzAbbreviation(time_zone, ms - 1)}` };
}
export interface NoticeDelivery { readonly consumer_id: string; readonly delivered_at: string; readonly channel: DeliveryChannel; readonly copies: number; readonly evidence_document_id: string | null; readonly esign_consent_id?: string | null; readonly form?: RescissionForm; }
export interface MaterialDisclosureDelivery { readonly consumer_id: string; readonly cd_version: number; readonly effective_receipt_date: PlainDate; readonly accurate: boolean; }
export type RescissionStatus = "not_applicable" | "pending_consummation" | "running" | "expired_not_rescinded" | "waived" | "rescinded" | "extended_3y";
export type SatisfactionBasis = "channel_sweep" | "borrower_confirmation" | "both";
export interface ConsumerPeriod { readonly consumer_id: string; readonly consummation_date_local: PlainDate; readonly notice_delivered_on: PlainDate | null; readonly notice_copies: number | null; readonly material_disclosures_received_on: PlainDate | null; readonly period_start_date: PlainDate | null; readonly expires_on: PlainDate | null; readonly expires_at: string | null; readonly defect: string | null; }
export interface PeriodInput {
  readonly application_id: string; readonly rescindability: Pick<Rescindability, "applicability" | "form" | "consumers" | "gated">; readonly consummation_at: string | null; readonly time_zone: string;
  readonly notice_deliveries: readonly NoticeDelivery[]; readonly material_disclosures: readonly MaterialDisclosureDelivery[];
  /** 25.1's (g) verdict on the CD version whose figures are used — copied to `material_disclosures_accurate` (rule "Material-disclosure accuracy for the period start"). */
  readonly material_disclosures_accurate: boolean; readonly now?: string | null;
}
export interface RescissionPeriod {
  readonly rescission_id: string; readonly application_id: string; readonly loan_id: string | null; readonly applicability: RescissionApplicability; readonly form: RescissionForm; readonly status: RescissionStatus;
  readonly consummation_at: string | null; readonly consummation_date_local: PlainDate | null; readonly period_start_date: PlainDate | null; readonly expires_on: PlainDate | null; readonly expires_at: string | null; readonly expires_display: string | null;
  readonly consumers: readonly ConsumerPeriod[]; readonly material_disclosures_accurate: boolean; readonly extended_expires_at: PlainDate | null; readonly defects: readonly string[]; readonly time_zone: string;
  readonly reasonably_satisfied_at: string | null; readonly satisfaction_basis: SatisfactionBasis | null; readonly waiver_id: string | null; readonly funding_release_at: string | null; readonly mail_allowance_ends_on: PlainDate | null;
}
export const rescissionIdFor = (application_id: string): string => `${application_id}:rescission`;
/** Two paper copies, or ≥ 1 electronic copy under a valid E-SIGN consent (§1026.23(b)(1)); the platform delivers two either way (decision 25.3-Q1). */
export function noticeCopiesSufficient(d: Pick<NoticeDelivery, "channel" | "copies" | "esign_consent_id">, consent?: EsignConsent | null, delivered_at?: string): { ok: boolean; reason?: string } {
  if (isElectronic(d.channel)) {
    if (!d.esign_consent_id) return { ok: false, reason: "electronic delivery needs an E-SIGN consent (§1026.23(b)(1) parenthetical; 15 U.S.C. 7001(c))" };
    if (consent !== undefined && delivered_at) { const v = consentValidFor(consent, delivered_at); if (!v.ok) return { ok: false, reason: v.reason ?? "E-SIGN consent invalid" }; }
    return d.copies >= 1 ? { ok: true } : { ok: false, reason: "at least one electronic copy per consumer" };
  }
  return d.copies >= 2 ? { ok: true } : { ok: false, reason: `paper delivery requires two copies per consumer (§1026.23(b)(1)); ${d.copies} delivered` };
}
/** The period start for ONE consumer: the latest of consummation, delivery of the notice and delivery of all material disclosures — never consummation alone. */
export function consumerPeriodStart(consumer_id: string, consummation_at: string, time_zone: string, notices: readonly NoticeDelivery[], material: readonly MaterialDisclosureDelivery[]): ConsumerPeriod {
  const consummation_date_local = civilDate(consummation_at, time_zone);
  const notice = [...notices].filter((n) => n.consumer_id === consumer_id && n.evidence_document_id).sort((a, b) => a.delivered_at.localeCompare(b.delivered_at)).find((n) => noticeCopiesSufficient(n).ok) ?? null;
  const md = [...material].filter((m) => m.consumer_id === consumer_id && m.accurate).sort((a, b) => b.cd_version - a.cd_version)[0] ?? null;
  const notice_delivered_on = notice ? civilDate(notice.delivered_at, time_zone) : null;
  const md_on = md ? md.effective_receipt_date : null;
  const base = { consumer_id, consummation_date_local, notice_delivered_on, notice_copies: notice?.copies ?? null, material_disclosures_received_on: md_on };
  if (!notice_delivered_on) return { ...base, period_start_date: null, expires_on: null, expires_at: null, defect: "notice_not_delivered" };
  if (!md_on) return { ...base, period_start_date: null, expires_on: null, expires_at: null, defect: "material_disclosures_not_delivered" };
  const period_start_date = laterDate(laterDate(consummation_date_local, notice_delivered_on), md_on);
  const x = rescissionExpiry(period_start_date, time_zone);
  return { ...base, period_start_date, expires_on: x.expires_on, expires_at: x.expires_at, defect: null };
}
/** The loan's period: per consumer, then the LATEST across consumers; a consumer whose notice or material disclosures were never delivered (or were inaccurate under (g)) leaves the period unstarted → `extended_3y`. */
export function computeRescissionPeriod(i: PeriodInput): RescissionPeriod {
  const rescission_id = rescissionIdFor(i.application_id);
  const empty = { rescission_id, application_id: i.application_id, loan_id: null, applicability: i.rescindability.applicability, form: i.rescindability.form, consumers: [] as ConsumerPeriod[], material_disclosures_accurate: i.material_disclosures_accurate, extended_expires_at: null, time_zone: i.time_zone, reasonably_satisfied_at: null, satisfaction_basis: null, waiver_id: null, funding_release_at: null, mail_allowance_ends_on: null };
  if (!i.rescindability.gated) return { ...empty, status: "not_applicable", consummation_at: i.consummation_at, consummation_date_local: i.consummation_at ? civilDate(i.consummation_at, i.time_zone) : null, period_start_date: null, expires_on: null, expires_at: null, expires_display: null, defects: [] };
  if (!i.consummation_at) return { ...empty, status: "pending_consummation", consummation_at: null, consummation_date_local: null, period_start_date: null, expires_on: null, expires_at: null, expires_display: null, defects: [] };
  need(i.rescindability.consumers.length > 0, "a rescindable loan has at least one consumer entitled to rescind");
  const consummation_date_local = civilDate(i.consummation_at, i.time_zone);
  const material = i.material_disclosures_accurate ? i.material_disclosures : i.material_disclosures.map((m) => ({ ...m, accurate: false }));
  const consumers = i.rescindability.consumers.map((c) => consumerPeriodStart(c.consumer_id, i.consummation_at!, i.time_zone, i.notice_deliveries, material));
  const defects = consumers.filter((c) => c.defect).map((c) => `${c.consumer_id}: ${c.defect}`);
  if (!i.material_disclosures_accurate) defects.unshift("material_disclosures_inaccurate (§1026.23(g))");
  const common = { ...empty, consumers, consummation_at: i.consummation_at, consummation_date_local, defects };
  if (defects.length) return { ...common, status: "extended_3y", period_start_date: null, expires_on: null, expires_at: null, expires_display: null, extended_expires_at: addYears(consummation_date_local, 3) };
  const period_start_date = consumers.map((c) => c.period_start_date!).reduce(laterDate);
  const x = rescissionExpiry(period_start_date, i.time_zone);
  const status: RescissionStatus = i.now && Date.parse(i.now) >= Date.parse(x.expires_at) ? "expired_not_rescinded" : "running";
  return { ...common, status, period_start_date, expires_on: x.expires_on, expires_at: x.expires_at, expires_display: x.expires_display, mail_allowance_ends_on: addDays(x.expires_on, 2) };
}
/** Fields 30.2 boards onto the loan (OB-018 reads `rescission_expires_at`; servicing 9.x/16.x read `rescission_extended_until`). */
export function servicingHandoffFields(p: RescissionPeriod): { rescindable: boolean; rescission_expires_at: string | null; rescission_extended_until: PlainDate | null } {
  return { rescindable: p.status !== "not_applicable", rescission_expires_at: p.expires_at, rescission_extended_until: p.status === "extended_3y" ? p.extended_expires_at : null };
}

// ============================================================ material-disclosure accuracy for rescission (§1026.23(g), (h); §1026.22(a)(4))
export type MdAccuracyBasis = "exact" | "overstated" | "g1i_half_pct_or_100" | "g2i_one_pct_or_100" | "h_35_after_foreclosure" | "h_broker_fee_omitted" | "h_model_form_defective";
export interface MdAccuracyInput { readonly disclosed_finance_charge_cents: Cents; readonly actual_finance_charge_cents: Cents; readonly face_amount_cents: Cents; readonly new_creditor_no_new_advance?: boolean; readonly foreclosure_initiated?: boolean; readonly broker_fee_omitted?: boolean; readonly model_form_defective?: boolean; readonly as_of?: PlainDate; }
export interface MdAccuracy { readonly accurate: boolean; readonly tolerance_cents: Cents; readonly understated_by_cents: Cents; readonly basis: MdAccuracyBasis; readonly citation: string; readonly trid_o2: FinanceChargeAccuracy; }
const maxCents = (a: Cents, b: Cents): Cents => (a > b ? a : b);
/** The finance charge (and the APR/amount financed/total of payments that follow from it) is accurate for rescission if understated by no more than ½ % of the face amount or $100 ((g)(1)(i)) — 1 % for a new-creditor refinancing with no new advance ((g)(2)(i)) — or overstated; $35 after foreclosure is initiated ((h)). */
export function materialDisclosureAccuracy(i: MdAccuracyInput): MdAccuracy {
  const trid_o2 = financeChargeAccuracyTest(i.disclosed_finance_charge_cents, i.actual_finance_charge_cents, i.as_of ?? plainDate("2026-09-01"));
  const understated = i.actual_finance_charge_cents - i.disclosed_finance_charge_cents;
  if (i.foreclosure_initiated) {
    if (i.broker_fee_omitted) return { accurate: false, tolerance_cents: 3_500n, understated_by_cents: understated, basis: "h_broker_fee_omitted", citation: "§1026.23(h)(1)(i)", trid_o2 };
    if (i.model_form_defective) return { accurate: false, tolerance_cents: 3_500n, understated_by_cents: understated, basis: "h_model_form_defective", citation: "§1026.23(h)(1)(ii)", trid_o2 };
    return { accurate: understated <= 3_500n, tolerance_cents: 3_500n, understated_by_cents: understated, basis: "h_35_after_foreclosure", citation: "§1026.23(h)(2)", trid_o2 };
  }
  const tolerance = i.new_creditor_no_new_advance ? maxCents(i.face_amount_cents / 100n, 10_000n) : maxCents(i.face_amount_cents * 5n / 1_000n, 10_000n);
  const basis: MdAccuracyBasis = understated === 0n ? "exact" : understated < 0n ? "overstated" : i.new_creditor_no_new_advance ? "g2i_one_pct_or_100" : "g1i_half_pct_or_100";
  return { accurate: understated <= tolerance, tolerance_cents: tolerance, understated_by_cents: understated, basis, citation: i.new_creditor_no_new_advance ? "§1026.23(g)(2)(i)" : "§1026.23(g)(1)(i)", trid_o2 };
}

// ============================================================ delay of performance and the funding date (§1026.23(c); comment 23(c); Fedwire)
export interface FundingReleaseInput { readonly expires_on: PlainDate | null; readonly waiver_accepted_on?: PlainDate | null; readonly hold_through_mail_allowance?: boolean; readonly calendar?: Calendar; }
/** The earliest wire date: the first Fed business day after `expires_on` (the day after expiry is lawful under Reg Z whatever day it is); after an accepted waiver, the acceptance date rolled to a Fed business day; a logged rescission candidate holds funding through the 2-day mail allowance (decision 25.3-Q5). */
export function fundingReleaseDate(i: FundingReleaseInput): { earliest_funding_date: PlainDate; basis: string } {
  const cal = i.calendar ?? fedwire;
  if (i.waiver_accepted_on) return { earliest_funding_date: rollForward(i.waiver_accepted_on, cal), basis: "§1026.23(e) waiver accepted — funding may proceed on the next Fed business day" };
  need(!!i.expires_on, "no expiry: the period has not started (notice or material disclosures missing) — the loan cannot fund");
  let d = rollForward(addDays(i.expires_on!, 1), cal);
  if (i.hold_through_mail_allowance) d = laterDate(d, rollForward(addDays(i.expires_on!, 2), cal));
  return { earliest_funding_date: d, basis: i.hold_through_mail_allowance ? "held through the 2-day mailed-notice allowance (rescission candidate logged)" : `first Fed business day after midnight ending ${i.expires_on} (§1026.23(c) sets no business-day condition; Fedwire does)` };
}
export interface DisburseFacts { readonly status: RescissionStatus; readonly expires_at: string | null; readonly reasonably_satisfied_at: string | null; readonly waiver_id: string | null; readonly now: string; }
export function rescissionGate(f: DisburseFacts): { open: boolean; reason?: string } {
  if (f.status === "not_applicable") return { open: true };
  if (f.status === "waived" && f.waiver_id) return { open: true };
  if (f.status === "rescinded") return { open: false, reason: "the transaction was rescinded — nothing may be disbursed (§1026.23(d)(1))" };
  if (f.status === "extended_3y" || !f.expires_at) return { open: false, reason: "the rescission period has not started (notice or material disclosures not delivered / inaccurate) — the loan cannot fund" };
  if (Date.parse(f.now) < Date.parse(f.expires_at)) return { open: false, reason: `the rescission period runs until ${f.expires_at} — no money shall be disbursed other than in escrow (§1026.23(c))` };
  if (!f.reasonably_satisfied_at) return { open: false, reason: "expired, but the creditor is not yet reasonably satisfied that the consumer has not rescinded (channel sweep pending)" };
  return { open: true };
}
/** `disburse` / `releaseFunding` call this: refused before `expires_at`, before the sweep, or without an officer-accepted waiver. */
export function assertDisburseAllowed(f: DisburseFacts): void { const g = rescissionGate(f); if (!g.open) throw new RescissionRefused("REGZ_1026_23_RESCISSION_3SBD_GATE", "§1026.23(c)", g.reason ?? "closed"); }
/** Post-hoc test for the funding record: the only Reg Z conditions are expiry and reasonable satisfaction (or a waiver); a holiday gap after expiry is not a violation. */
export function disbursementTimingCompliance(f: { expires_at: string | null; disbursed_at: string; reasonably_satisfied_at: string | null; waiver_id: string | null }): { compliant: boolean; violations: readonly string[] } {
  const v: string[] = [];
  if (!f.waiver_id) {
    if (!f.expires_at) v.push("disbursed with no rescission expiry on record (§1026.23(c))");
    else if (Date.parse(f.disbursed_at) < Date.parse(f.expires_at)) v.push(`disbursed at ${f.disbursed_at} before the period expired at ${f.expires_at} (§1026.23(c))`);
    if (!f.reasonably_satisfied_at || Date.parse(f.reasonably_satisfied_at) > Date.parse(f.disbursed_at)) v.push("disbursed before the creditor was reasonably satisfied that the consumer had not rescinded (comment 23(c))");
  }
  return { compliant: v.length === 0, violations: v };
}

// ============================================================ confirmation of non-rescission (comment 23(c); platform practice)
export type InboundChannel = "mail" | "email" | "portal" | "fax" | "phone" | "voicemail";
export interface InboundItem { readonly document_id: string; readonly channel: InboundChannel; readonly received_at: string; readonly postmark_date?: PlainDate | null; readonly classification: "rescission_notice_candidate" | "other"; readonly consumer_id?: string | null; }
export interface SweepInput { readonly rescission_id: string; readonly expires_at: string; readonly expires_on: PlainDate; readonly swept_at: string; readonly time_zone: string; readonly channels_checked: readonly InboundChannel[]; readonly items: readonly InboundItem[]; readonly borrower_confirmation_at?: string | null; }
export interface SweepResult { readonly rescission_id: string; readonly swept_at: string; readonly channels_checked: readonly InboundChannel[]; readonly candidates: readonly (InboundItem & { given_on: PlainDate; within_period: boolean })[]; readonly reasonably_satisfied_at: string | null; readonly satisfaction_basis: SatisfactionBasis | null; }
/** A mailed notice is given when mailed (postmark); anything else when delivered. Candidates given on or before `expires_on` defeat satisfaction. */
export const givenOn = (it: Pick<InboundItem, "channel" | "received_at" | "postmark_date">, time_zone: string): PlainDate => (it.channel === "mail" && it.postmark_date ? it.postmark_date : civilDate(it.received_at, time_zone));
export function sweepChannels(i: SweepInput): SweepResult {
  const required: InboundChannel[] = ["mail", "email", "portal", "fax"];
  const missing = required.filter((c) => !i.channels_checked.includes(c));
  need(missing.length === 0, `the sweep covers every inbound channel — missing ${missing.join(", ")}`);
  const candidates = i.items.filter((it) => it.classification === "rescission_notice_candidate").map((it) => { const g = givenOn(it, i.time_zone); return { ...it, given_on: g, within_period: g <= i.expires_on }; });
  const satisfied = candidates.every((c) => !c.within_period) && Date.parse(i.swept_at) >= Date.parse(i.expires_at);
  const basis: SatisfactionBasis | null = !satisfied ? null : i.borrower_confirmation_at ? "both" : "channel_sweep";
  return { rescission_id: i.rescission_id, swept_at: i.swept_at, channels_checked: i.channels_checked, candidates, reasonably_satisfied_at: satisfied ? i.swept_at : null, satisfaction_basis: basis };
}

// ============================================================ waiver (§1026.23(e); comment 23(e)-1)
export interface WaiverStatementInput { readonly waiver_id: string; readonly rescission_id: string; readonly statement_document_id: string; readonly statement_text: string; readonly dated_on: PlainDate | null; readonly signed_by: readonly string[]; readonly emergency_summary: string; readonly received_at: string; readonly consumer_written: boolean; readonly template_used?: boolean; readonly printed_form?: boolean; readonly preprinted_language?: boolean; }
export interface RescissionWaiver extends WaiverStatementInput { readonly accepted_by: string; readonly accepted_at: string; readonly accepted_on: PlainDate; readonly rejected_reason: null; }
const WAIVER_BOILERPLATE = /\b(?:i\/we|the undersigned) hereby (?:waive|modify)\b|\[\s*(?:describe|insert)[^\]]*\]|_{4,}/i;
/** "a dated written statement that describes the emergency, specifically modifies or waives the right to rescind, and bears the signature of all the consumers entitled to rescind. Printed forms for this purpose are prohibited." */
export function validateRescissionWaiver(w: WaiverStatementInput, entitledConsumerIds: readonly string[]): void {
  if (w.printed_form || w.template_used || w.preprinted_language || !w.consumer_written || WAIVER_BOILERPLATE.test(w.statement_text)) throw new RescissionRefused("PRINTED_FORM", "§1026.23(e) 'Printed forms for this purpose are prohibited'", "the waiver must be the consumer's own dated, signed statement — no template, pre-printed language or platform-supplied wording");
  need(!!w.statement_document_id && w.statement_text.trim().length > 0, "the consumer's dated, signed statement (document and text) is required");
  if (!w.dated_on) throw new RescissionRefused("WAIVER_UNDATED", "§1026.23(e) 'a dated written statement'", "the statement must be dated");
  if (!w.emergency_summary.trim()) throw new RescissionRefused("WAIVER_NO_EMERGENCY", "§1026.23(e); comment 23(e)-1", "the statement must describe the bona fide personal financial emergency that must be met before the end of the rescission period");
  if (!/\b(waive|modify|cancel(?:ling)? my right|give up my right)\b/i.test(w.statement_text) || !/\b(rescind|rescission|cancel)\b/i.test(w.statement_text)) throw new RescissionRefused("WAIVER_NOT_SPECIFIC", "§1026.23(e) 'specifically modifies or waives the right to rescind'", "the statement must specifically waive or modify the right to rescind");
  const unsigned = entitledConsumerIds.filter((c) => !w.signed_by.includes(c));
  if (unsigned.length) throw new RescissionRefused("ALL_CONSUMERS_SIGN", "§1026.23(e); comment 23(e)-1 'Each consumer entitled to rescind must sign'", `missing signature(s): ${unsigned.join(", ")}`);
}
export const isOfficer = (a: Actor): boolean => a.kind === "human" && a.role === "officer";
export function acceptRescissionWaiver(events: EventStore, period: RescissionPeriod, w: WaiverStatementInput, officer: Actor, accepted_at: string): { waiver: RescissionWaiver; period: RescissionPeriod; events: readonly DomainEvent[] } {
  if (!isOfficer(officer)) throw new RescissionRefused("WAIVER_OFFICER_ONLY", "25.3 state machine: `running` → `waived` (accepted waiver) is the partner officer's act", `waiver acceptance requires role officer, not ${officer.kind}:${officer.id}${officer.role ? ` (${officer.role})` : ""}`);
  if (period.status !== "running") throw new RescissionRefused("WAIVER_PERIOD_NOT_RUNNING", "§1026.23(e); comment 23(e)-1 'before the end of the rescission period'", `a waiver is accepted only while the period is running (status ${period.status})`);
  validateRescissionWaiver(w, period.consumers.map((c) => c.consumer_id));
  const accepted_on = civilDate(accepted_at, period.time_zone);
  const waiver: RescissionWaiver = { ...w, accepted_by: officer.id, accepted_at, accepted_on, rejected_reason: null };
  const release = fundingReleaseDate({ expires_on: period.expires_on, waiver_accepted_on: accepted_on });
  const next: RescissionPeriod = { ...period, status: "waived", waiver_id: w.waiver_id, funding_release_at: toIso(zonedEpochMs(release.earliest_funding_date, "09:00", period.time_zone)) };
  const base = { applicationId: period.application_id, actor: officer, occurredAt: accepted_at };
  const received = events.append({ type: "rescission.waiver.received", ...base, occurredAt: w.received_at, payload: { application_id: period.application_id, rescission_id: period.rescission_id, waiver_id: w.waiver_id, statement_document_id: w.statement_document_id, signed_by: [...w.signed_by] } });
  const accepted = events.append({ type: "rescission.waiver.accepted", ...base, payload: { application_id: period.application_id, rescission_id: period.rescission_id, waiver_id: w.waiver_id, accepted_by: officer.id, accepted_on, earliest_funding_date: release.earliest_funding_date } });
  // the gate row is satisfied by `rescission.confirmed_not_rescinded` OR `rescission.waiver.accepted` — the registry keeps the first pattern, so the acceptance also records satisfaction on a waiver basis
  const confirmed = events.append({ type: "rescission.confirmed_not_rescinded", ...base, payload: { application_id: period.application_id, rescission_id: period.rescission_id, reasonably_satisfied_at: accepted_at, satisfaction_basis: "waiver_accepted", waiver_id: w.waiver_id } });
  return { waiver, period: next, events: [received, accepted, confirmed] };
}

// ============================================================ exercise and unwind (§1026.23(a)(2), (d))
export type ExerciseMethod = "mail" | "email" | "portal" | "fax" | "hand";
export interface ExerciseInput { readonly exercise_id: string; readonly application_id: string; readonly consumer_id: string; readonly method: ExerciseMethod; readonly received_at: string; readonly postmark_date?: PlainDate | null; readonly document_id: string; readonly written: boolean; readonly disbursed_at?: string | null; }
export interface RescissionExercise { readonly exercise_id: string; readonly rescission_id: string; readonly application_id: string; readonly consumer_id: string; readonly received_at: string; readonly received_on: PlainDate; readonly given_at: PlainDate; readonly method: ExerciseMethod; readonly document_id: string; readonly valid: boolean; readonly invalid_reason: string | null; readonly refund_due_at: PlainDate; readonly security_terminated_at: string | null; readonly money_returned_at: string | null; readonly tender_status: "pending" | "tendered" | "court_modified"; readonly status: "received" | "validated" | "unwinding" | "closed" | "disputed"; readonly after_disbursement: boolean; }
/** Valid if written, from a consumer entitled to rescind, and given (mailed: postmark; otherwise delivered to the designated place) on or before `expires_on` — or while the extended right is running. One consumer's rescission rescinds the transaction for all. */
export function evaluateExercise(period: RescissionPeriod, i: ExerciseInput): RescissionExercise {
  const received_on = civilDate(i.received_at, period.time_zone);
  const given_at = i.method === "mail" && i.postmark_date ? i.postmark_date : received_on;
  const entitled = period.consumers.some((c) => c.consumer_id === i.consumer_id);
  const extended = period.status === "extended_3y" && !!period.extended_expires_at && given_at <= period.extended_expires_at;
  const inPeriod = !!period.expires_on && given_at <= period.expires_on;
  let invalid_reason: string | null = null;
  if (!i.written) invalid_reason = "an oral statement is not a valid exercise — §1026.23(a)(2) requires written communication";
  else if (!entitled) invalid_reason = `${i.consumer_id} is not a consumer entitled to rescind`;
  else if (period.status === "waived") invalid_reason = "the right was waived under §1026.23(e)";
  else if (!inPeriod && !extended) invalid_reason = `given ${given_at}, after the period expired ${period.expires_on ?? "(unstarted)"} and no extended right is running`;
  const valid = invalid_reason === null;
  return { exercise_id: i.exercise_id, rescission_id: period.rescission_id, application_id: i.application_id, consumer_id: i.consumer_id, received_at: i.received_at, received_on, given_at, method: i.method, document_id: i.document_id, valid, invalid_reason, refund_due_at: addDays(received_on, 20), security_terminated_at: null, money_returned_at: null, tender_status: "pending", status: valid ? "validated" : "disputed", after_disbursement: !!i.disbursed_at && Date.parse(i.disbursed_at) < Date.parse(i.received_at) };
}
export interface UnwindItem { readonly step: string; readonly owner: string; readonly citation: string; }
/** The 20-day unwind checklist (§1026.23(d)(2); comment 23(d)(2)-1 "Any amount"): differs by whether the loan funded, whether an eNote was registered and whether the security instrument was recorded. */
export function unwindChecklist(x: RescissionExercise, ctx: { disbursed: boolean; enote_registered: boolean; security_instrument_recorded: boolean; purchased_by_fnma: boolean }): UnwindItem[] {
  const items: UnwindItem[] = [];
  if (!ctx.disbursed) items.push({ step: "cancel the funding wire / release the warehouse advance reservation", owner: "funder", citation: "§1026.23(c)" });
  else items.push({ step: "reverse the payoff where possible, otherwise treat the paid-off lender's release as the consumer's tender problem", owner: "closer", citation: "§1026.23(d)(3)" });
  if (ctx.enote_registered) items.push({ step: "MERS eRegistry change status / registration reversal; eVault void", owner: "closer", citation: "26.2/26.4" });
  if (ctx.security_instrument_recorded) items.push({ step: "record the release / reconveyance of the security instrument", owner: "closer", citation: "§1026.23(d)(2) 'any action necessary to reflect the termination of the security interest'" });
  items.push({ step: "refund every amount paid by any consumer — finance charges accrued, appraisal and credit fees paid in cash, broker fees", owner: "funder", citation: "comment 23(d)(2)-1 'Any amount'" });
  items.push({ step: "return SM-borne third-party costs to the SM cost ledger; reverse origination_fees_receivable (balanced entries linked to rescission.unwind.completed)", owner: "funder", citation: "25.3 Outputs: Ledger" });
  if (ctx.purchased_by_fnma) items.push({ step: "repurchase from Fannie Mae (29.4); warehouse_advances.repaid_from = partner_repurchase", owner: "officer", citation: "27.1/29.4" });
  else items.push({ step: "withdraw from any commitment (29.1 pair-off rules); never deliver", owner: "officer", citation: "29.1" });
  items.push({ step: `complete by ${x.refund_due_at} (received ${x.received_on} + 20 calendar days)`, owner: "officer", citation: "§1026.23(d)(2)" });
  return items;
}
export function recordExercise(events: EventStore, period: RescissionPeriod, i: ExerciseInput, actor: Actor = AGENT): { exercise: RescissionExercise; period: RescissionPeriod; events: readonly DomainEvent[] } {
  const exercise = evaluateExercise(period, i);
  const base = { applicationId: period.application_id, actor, occurredAt: i.received_at };
  const received = events.append({ type: "rescission.notice.received", ...base, payload: { application_id: period.application_id, rescission_id: period.rescission_id, exercise_id: exercise.exercise_id, consumer_id: exercise.consumer_id, given_at: exercise.given_at, received_at: exercise.received_at, received_on: exercise.received_on, method: exercise.method, valid: exercise.valid, refund_due_at: exercise.refund_due_at, invalid_reason: exercise.invalid_reason } });
  if (!exercise.valid) return { exercise, period, events: [received] };
  const exercised = events.append({ type: "rescission.exercised", ...base, payload: { application_id: period.application_id, rescission_id: period.rescission_id, exercise_id: exercise.exercise_id, consumer_id: exercise.consumer_id, refund_due_at: exercise.refund_due_at, after_disbursement: exercise.after_disbursement } });
  return { exercise, period: { ...period, status: "rescinded" }, events: [received, exercised] };
}
export interface UnwindEvidence { readonly completed_at: string; readonly money_returned_at: string; readonly security_terminated_at: string; readonly release_document_id: string | null; readonly enote_reversal_ref: string | null; readonly refund_ledger_set_id: string | null; readonly signed_off_by: Actor; }
export function completeUnwind(events: EventStore, x: RescissionExercise, ev: UnwindEvidence): { exercise: RescissionExercise; event: DomainEvent } {
  if (!isOfficer(ev.signed_off_by)) throw new RescissionRefused("UNWIND_OFFICER_SIGNOFF", "25.3 automation class: the partner officer signs off on a rescission unwind", "unwind completion requires officer sign-off");
  const exercise: RescissionExercise = { ...x, money_returned_at: ev.money_returned_at, security_terminated_at: ev.security_terminated_at, tender_status: "tendered", status: "closed" };
  const event = events.append({ type: "rescission.unwind.completed", applicationId: x.application_id, actor: ev.signed_off_by, occurredAt: ev.completed_at, payload: { application_id: x.application_id, rescission_id: x.rescission_id, exercise_id: x.exercise_id, money_returned_at: ev.money_returned_at, security_terminated_at: ev.security_terminated_at, release_document_id: ev.release_document_id, enote_reversal_ref: ev.enote_reversal_ref, refund_ledger_set_id: ev.refund_ledger_set_id, on_time: ev.completed_at.slice(0, 10) <= x.refund_due_at } });
  return { exercise, event };
}

// ============================================================ notice at signing (§1026.23(b)(1); §1026.17(d)); inbound classification
export interface SigningConsumerFacts { readonly consumer_id: string; readonly copies: number; readonly channel: DeliveryChannel; readonly esign_consent_id?: string | null; readonly consent?: EsignConsent | null; readonly delivered_at?: string; readonly material_disclosures_in_package: boolean; readonly receipt_capture: boolean; }
export function noticeAtSigningCheck(consumers: readonly SigningConsumerFacts[]): { open: boolean; reason?: string; per_consumer: readonly { consumer_id: string; ok: boolean; reason: string | null; compliance_copies_accepted: readonly number[] }[] } {
  need(consumers.length > 0, "every consumer entitled to rescind is listed in the signing package");
  const per_consumer = consumers.map((c) => {
    const copies = noticeCopiesSufficient(c, c.consent, c.delivered_at);
    const reason = !copies.ok ? copies.reason! : !c.material_disclosures_in_package ? "material disclosures (the CD) not in the package for this consumer (§1026.17(d))" : !c.receipt_capture ? "no per-consumer receipt capture" : null;
    return { consumer_id: c.consumer_id, ok: reason === null, reason, compliance_copies_accepted: isElectronic(c.channel) ? [1, 2] : [2] };
  });
  const bad = per_consumer.filter((p) => !p.ok);
  return { open: bad.length === 0, ...(bad.length ? { reason: `SM_O63_NOTICE_AT_SIGNING_GATE: ${bad.map((b) => `${b.consumer_id} — ${b.reason}`).join("; ")}` } : {}), per_consumer };
}
export function assertNoticeAtSigning(consumers: readonly SigningConsumerFacts[]): void { const g = noticeAtSigningCheck(consumers); if (!g.open) throw new RescissionRefused("SM_O63_NOTICE_AT_SIGNING_GATE", "§1026.23(b)(1)", g.reason ?? "closed"); }
const CANCEL_WORDS = /\b(cancel(?:l(?:ing|ed))?|rescind(?:ing|ed)?|rescission|call (?:it|the loan|this) off|back out|do not want (?:the|this) loan|withdraw from (?:the|this) (?:loan|transaction))\b/i;
export interface InboundClassification { readonly classification: "rescission_notice_candidate" | "other"; readonly oral: boolean; readonly valid_exercise_possible: boolean; readonly confidence: number; readonly human_review: boolean; readonly action: string; }
/** Any "I want to cancel" message — written or oral — is a rescission candidate; an oral one is not a valid exercise but triggers the human contact that tells the consumer how to exercise in writing before midnight. */
export function classifyInboundDocument(i: { text: string; channel: InboundChannel }): InboundClassification {
  const oral = i.channel === "phone" || i.channel === "voicemail";
  if (CANCEL_WORDS.test(i.text)) return { classification: "rescission_notice_candidate", oral, valid_exercise_possible: !oral, confidence: 0.99, human_review: false, action: oral ? "send the H-8/H-9 form and instructions immediately; log the contact; hold funding through the 2-day mail allowance" : "record a rescission_exercises row (recordExercise) and open the unwind checklist if valid" };
  const ambiguous = /\b(loan|closing|documents?|signed|mortgage)\b/i.test(i.text) && /\b(concern|worried|mistake|regret|second thoughts|not sure)\b/i.test(i.text);
  return { classification: "other", oral, valid_exercise_possible: false, confidence: ambiguous ? 0.6 : 0.95, human_review: ambiguous, action: ambiguous ? "ambiguous — route to human_agent for review" : "no rescission content" };
}
export interface OralCandidateResponse { readonly logged_at: string; readonly send_form_by: string; readonly exercise_deadline_text: string; readonly funding_hold_through: PlainDate; readonly escalate_to: "human_agent"; readonly valid_exercise: false; }
/** Edge case "Oral cancellation call at 11:30 p.m. on day 3": form and instructions within 5 minutes; funding held through the mail allowance. */
export function oralCancellationResponse(period: RescissionPeriod, call_at: string): OralCandidateResponse {
  need(!!period.expires_on, "the period has not started");
  return { logged_at: call_at, send_form_by: toIso(Date.parse(call_at) + 5 * 60_000), exercise_deadline_text: `sign and send the form to the address on it by midnight of ${period.expires_on}`, funding_hold_through: addDays(period.expires_on!, 2), escalate_to: "human_agent", valid_exercise: false };
}

// ============================================================ notices (Appendix H, forms H-8 and H-9)
export interface CreditorDesignation { readonly creditor_name: string; readonly designated_address: string; readonly designated_email?: string | null; readonly designated_fax?: string | null; }
export const templateCodeFor = (form: RescissionForm): "NTC_REGZ_1026_23_H8" | "NTC_REGZ_1026_23_H9" => { need(form !== "none", "no rescission notice for a non-rescindable transaction"); return form === "h8" ? "NTC_REGZ_1026_23_H8" : "NTC_REGZ_1026_23_H9"; };
/** The merge fields of the model form: transaction date, the printed expiry "midnight of ______", the creditor's designated place of business and, for H-9, the amount of the increase. Re-rendered whenever the period is recomputed (a stale printed date is not a "properly completed" form). */
export function rescissionNoticePayload(i: { form: RescissionForm; consumer_id: string; consumer_name: string; transaction_date: PlainDate; expires_on: PlainDate | null; creditor: CreditorDesignation; rescindable_amount_cents?: Cents | null; property_address: string; copies: number }): Record<string, unknown> {
  const template_code = templateCodeFor(i.form);
  need(!!i.expires_on, "the printed expiry date needs a computed period — never render the notice from consummation alone");
  if (i.form === "h9") need(typeof i.rescindable_amount_cents === "bigint" && i.rescindable_amount_cents > 0n, "H-9 states the amount of the increase (the rescindable new advance)");
  return { template_code, form: i.form, consumer_id: i.consumer_id, consumer_name: i.consumer_name, transaction_date: i.transaction_date, expiry_date: i.expires_on, creditor_name: i.creditor.creditor_name, designated_address: i.creditor.designated_address, designated_email: i.creditor.designated_email ?? null, designated_fax: i.creditor.designated_fax ?? null, property_address: i.property_address, copies: i.copies, ...(i.form === "h9" ? { increase_cents: i.rescindable_amount_cents } : {}) };
}
/** Worked example B's per-diem figure: the platform per diem is 26.3's `365_rounded_per_diem` (cent-rounded, 25.1); the spec's $2,913.15 is 31 × the unrounded per diem — both are computed here so the discrepancy is measured, not remembered. */
export function perDiemInterestForDays(loan_cents: Cents, rate_pct: string, days: number): { rounded_per_diem_cents: Cents; total_rounded_per_diem_cents: Cents; total_unrounded_cents: Cents } {
  const annual = loan_cents * ratePercent(rate_pct).unscaled;           // cents × rate (scaled)
  const rounded_per_diem_cents = divRound(annual, 365n * Decimal.ONE.unscaled, "HALF_UP");
  const total_unrounded_cents = divRound(annual * BigInt(days), 365n * Decimal.ONE.unscaled, "HALF_UP");
  return { rounded_per_diem_cents, total_rounded_per_diem_cents: rounded_per_diem_cents * BigInt(days), total_unrounded_cents };
}

// ============================================================ events (every one carries applicationId — origination context)
const P = (period: Pick<RescissionPeriod, "application_id" | "rescission_id">) => ({ application_id: period.application_id, rescission_id: period.rescission_id });
export function recordApplicability(events: EventStore, r: Rescindability, actor: Actor = AGENT, at?: string): DomainEvent {
  return events.append({ type: "rescission.applicability.determined", applicationId: r.application_id, actor, ...(at ? { occurredAt: at } : {}), payload: { application_id: r.application_id, rescission_id: rescissionIdFor(r.application_id), applicability: r.applicability, form: r.form, rescindable_amount_cents: r.rescindable_amount_cents === null ? null : r.rescindable_amount_cents.toString(), original_creditor_match: r.original_creditor_match, consumers: r.consumers.map((c) => c.consumer_id), citation: r.citation } });
}
/** Guardrail "never mark a notice delivered without per-consumer evidence": no evidence document → refused. */
export function recordNoticeDelivery(events: EventStore, application_id: string, d: NoticeDelivery, time_zone: string, actor: Actor = AGENT): { delivery: NoticeDelivery & { delivered_on: PlainDate; kind: "rescission_h8" | "rescission_h9" }; event: DomainEvent } {
  if (!d.evidence_document_id) throw new RescissionRefused("NOTICE_DELIVERY_EVIDENCE", "25.3 guardrails: never mark a notice delivered without per-consumer evidence", `no evidence document for ${d.consumer_id} (signing-session audit trail, courier receipt or e-delivery certificate)`);
  const copies = noticeCopiesSufficient(d);
  if (!copies.ok) throw new RescissionRefused("NOTICE_COPIES", "§1026.23(b)(1)", copies.reason ?? "copies");
  const kind = (d.form ?? "h8") === "h9" ? "rescission_h9" : "rescission_h8";
  const delivered_on = civilDate(d.delivered_at, time_zone);
  const event = events.append({ type: "rescission.notice.delivered", applicationId: application_id, actor, occurredAt: d.delivered_at, payload: { application_id, rescission_id: rescissionIdFor(application_id), consumer_id: d.consumer_id, copies: d.copies, channel: d.channel, delivered_on, evidence_document_id: d.evidence_document_id, kind } });
  return { delivery: { ...d, delivered_on, kind }, event };
}
/** `rescission.period.started{period_start_date, expires_at}` when the period runs; `rescission.extended_right.flagged` when it cannot start. */
export function startPeriod(events: EventStore, period: RescissionPeriod, actor: Actor = AGENT, at?: string): DomainEvent | null {
  if (period.status === "extended_3y") return flagExtendedRight(events, period, period.defects.join("; "), actor, at);
  if (!period.period_start_date || !period.expires_at) return null;
  return events.append({ type: "rescission.period.started", applicationId: period.application_id, actor, ...(at ? { occurredAt: at } : {}), payload: { ...P(period), period_start_date: period.period_start_date, expires_on: period.expires_on, expires_at: period.expires_at, form: period.form, consumers: period.consumers.map((c) => ({ consumer_id: c.consumer_id, period_start_date: c.period_start_date })) } });
}
/** The baseline `rescission.period.expired` at the expiry instant (arms the sweep +8 h and the 2-day mailed-notice allowance). */
export function expirePeriod(events: EventStore, period: RescissionPeriod, now: string, actor: Actor = AGENT): DomainEvent | null {
  if (!period.expires_at || !period.expires_on || Date.parse(now) < Date.parse(period.expires_at) || period.status === "waived" || period.status === "rescinded") return null;
  return events.append({ type: "rescission.period.expired", applicationId: period.application_id, actor, occurredAt: period.expires_at, payload: { ...P(period), basis: "regz_1026_23", expires_on: period.expires_on, expires_at: period.expires_at, mail_allowance_ends_on: addDays(period.expires_on, 2) } });
}
export function confirmNotRescinded(events: EventStore, period: RescissionPeriod, sweep: SweepResult, actor: Actor = AGENT): { period: RescissionPeriod; events: readonly DomainEvent[] } {
  const done = events.append({ type: "rescission.sweep.completed", applicationId: period.application_id, actor, occurredAt: sweep.swept_at, payload: { ...P(period), swept_at: sweep.swept_at, channels_checked: [...sweep.channels_checked], candidates: sweep.candidates.map((c) => c.document_id), satisfied: sweep.reasonably_satisfied_at !== null } });
  if (!sweep.reasonably_satisfied_at) return { period, events: [done] };
  const release = fundingReleaseDate({ expires_on: period.expires_on });
  const confirmed = events.append({ type: "rescission.confirmed_not_rescinded", applicationId: period.application_id, actor, occurredAt: sweep.reasonably_satisfied_at, payload: { ...P(period), reasonably_satisfied_at: sweep.reasonably_satisfied_at, satisfaction_basis: sweep.satisfaction_basis, channels_checked: [...sweep.channels_checked], earliest_funding_date: release.earliest_funding_date } });
  return { period: { ...period, status: "expired_not_rescinded", reasonably_satisfied_at: sweep.reasonably_satisfied_at, satisfaction_basis: sweep.satisfaction_basis, funding_release_at: toIso(zonedEpochMs(release.earliest_funding_date, "09:00", period.time_zone)) }, events: [done, confirmed] };
}
export function closeMailAllowance(events: EventStore, period: RescissionPeriod, closed_at: string, notices_received: readonly string[], actor: Actor = AGENT): DomainEvent {
  need(!!period.mail_allowance_ends_on, "no allowance window without an expiry");
  return events.append({ type: "rescission.mail_allowance.closed", applicationId: period.application_id, actor, occurredAt: closed_at, payload: { ...P(period), expires_on: period.expires_on, mail_allowance_ends_on: period.mail_allowance_ends_on, notices_received: [...notices_received] } });
}
export function flagExtendedRight(events: EventStore, period: RescissionPeriod, reason: string, actor: Actor = AGENT, at?: string): DomainEvent {
  need(!!period.consummation_date_local, "the extended right runs from consummation");
  const extended_expires_at = period.extended_expires_at ?? addYears(period.consummation_date_local!, 3);
  return events.append({ type: "rescission.extended_right.flagged", applicationId: period.application_id, ...(period.loan_id ? { loanId: period.loan_id } : {}), actor, ...(at ? { occurredAt: at } : {}), payload: { ...P(period), consummation_date_local: period.consummation_date_local, extended_expires_at, reason, rescission_extended_until: extended_expires_at } });
}
export type LapseReason = "expired_3y" | "transfer_of_all_interest" | "sale" | "cured";
export function lapseExtendedRight(events: EventStore, period: Pick<RescissionPeriod, "application_id" | "rescission_id" | "loan_id">, reason: LapseReason, at: string, actor: Actor = AGENT): DomainEvent {
  return events.append({ type: "rescission.extended_right.lapsed", applicationId: period.application_id, ...(period.loan_id ? { loanId: period.loan_id } : {}), actor, occurredAt: at, payload: { ...P(period), reason, lapsed_at: at } });
}
export function logOralCandidate(events: EventStore, period: RescissionPeriod, call_at: string, transcript: string, actor: Actor = AGENT): { response: OralCandidateResponse; event: DomainEvent } {
  const response = oralCancellationResponse(period, call_at);
  const event = events.append({ type: "rescission.candidate.logged", applicationId: period.application_id, actor, occurredAt: call_at, payload: { ...P(period), oral: true, transcript, send_form_by: response.send_form_by, funding_hold_through: response.funding_hold_through, valid_exercise: false } });
  return { response, event };
}
export function verifySigningPackage(events: EventStore, application_id: string, consumers: readonly SigningConsumerFacts[], at: string, actor: Actor = AGENT): { check: ReturnType<typeof noticeAtSigningCheck>; event: DomainEvent | null } {
  const check = noticeAtSigningCheck(consumers);
  if (!check.open) return { check, event: null };
  return { check, event: events.append({ type: "rescission.signing_package.verified", applicationId: application_id, actor, occurredAt: at, payload: { application_id, rescission_id: rescissionIdFor(application_id), consumers: check.per_consumer.map((c) => c.consumer_id), copies_complete: true } }) };
}
