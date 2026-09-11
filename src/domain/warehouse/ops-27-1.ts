/**
 * §27.1 Warehouse facility mechanics — Supermortgage as warehouse provider under a recourse loan-and-security
 * agreement (LSA) with the partner (structure decision: never table funding; the purchase-at-closing form is refused
 * by configuration without an officer-and-counsel record; no California advance until Financing Law licensing is
 * resolved — 27.1-Q8 / 31.1). One small pure function per rule / T-id, plus the event emitters the timers arm on and
 * the balanced ledger sets the advance, accrual, capitalization, fee and curtailment postings produce.
 *
 * Money is bigint cents; rates are integer basis points; interest is actual/360 decimal arithmetic (Decimal, never
 * floating point) rounded half-up to the cent only at posting by the cumulative method of rule 6: the posting for
 * day n is round_half_up(C(n)) − Σ previous postings, so Σ postings always equals the rounded cumulative amount
 * ($725.64 for the 7-day fixture; a per-diem-rounding implementation gives $725.62 and is rejected — 27.1-T3).
 *
 * Events (timer subject in brackets; every advance-level event carries loanId + applicationId so the origination
 * timers arm — src/kernel/timers/engine.ts isOriginationContext; facility-level events carry aggregate
 * {kind: warehouse_facility} and payload.source = "origination"):
 *   warehouse.advance.requested{advance_id, requested_at, …}                         [loan/application — arms SM_WH_ADVANCE_APPROVAL_2BH]
 *   warehouse.advance.approved{decision=approved, …} / warehouse.advance.rejected{decision=rejected, reasons}   [satisfies …_2BH; approved arms the cut-off and haircut gates]
 *   warehouse.advance.funded{note_form, wet, collateral_status, advance_date, interim_funder_anchor_date, secured_party_anchor_date}
 *                                                                                    [arms the wet/eNote/Interim Funder clocks, the aging clocks, the accrual and capitalization recurrences]
 *   warehouse.note.received (trust receipt)            warehouse.secured_party.added / .released            warehouse.interim_funder.designated
 *   warehouse.collateral.status_changed                warehouse.interest.accrued / .capitalized             warehouse.fee.assessed
 *   warehouse.aging.bucket_changed                     warehouse.curtailment.due / .paid{kind}               warehouse.margin_call.issued
 *   warehouse.collateral.defect_recorded / .defect_cured                             warehouse.repurchase.demanded / .completed
 *   warehouse.kickout.issued                           warehouse.borrowing_base.computed                     warehouse.daily_report.issued
 *   warehouse.bailee_letter.issued / .acknowledged / .corrected / .released         warehouse.note.shipment_requested / .shipment_released
 *   warehouse.facility.activation_requested / .activated{ucc1_filed_on} / .suspended / .resumed / .ucc_continuation_filed
 *   warehouse.covenant.period_ended{frequency} / .tested{period_complete} / .breached{reporting, kind}
 * Consumed (never re-emitted): `funding.authorized` (26.3), `clear_to_close.issued` (23.3 — SM_UW_CTC_GATE),
 * `compliance.gate.opened{gate=disbursement}` (25.1), `enote.registered` (26.2), `mers.min.registered` (26.4),
 * `rescission.exercised` (25.3 — unwinds an advance), `warehouse.advance.repaid` (27.2 — repayment; 30.1 consumes it).
 */
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, daysBetween, plainDate as D, addMonths, parts, ymd } from "../../kernel/calendar/date.ts";
import { addBusinessDays, rollForward, servicer, federal } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { AccountRef, EntrySetInput, LineInput, LoanAccount, CustodialAccount, CorporateAccount } from "../../kernel/ledger/ledger.ts";
import { origFundingClearing } from "../orig-boarding/ops-30-2.ts";
import { mersClocks } from "../transfers/custody-mers.ts";
import { SUPERMORTGAGE_ORG_ID } from "../transfers/inbound.ts";
import { FANNIE_MAE_ORG_ID } from "../../infra/integrations/mers.ts";

export const WAREHOUSE_AGENT: Actor = { kind: "agent", id: "warehouse" };
export const POLICY_VERSION = "sm.warehouse.v1";
export const RULE_SETS = { mers: "mers.proc.26.1", eregistry: "mers.eregistry.16.25", fnma: "fnma.selling.2026-09-02", ucc: "ucc.9.2010", esign: "esign.7021", policy: POLICY_VERSION } as const;
export const SM_MERS_ORG_ID = SUPERMORTGAGE_ORG_ID;
export { FANNIE_MAE_ORG_ID };

// ============================================================ types
export type NoteForm = "enote" | "paper";
export type WetDry = "wet" | "dry";
export type AgreementKind = "lsa" | "mra";
export type FacilityStatus = "draft" | "active" | "suspended" | "terminated";
export type WetReason = "wet_state_paper" | "enote_pre_secured_party" | "none";
export type CollateralStatus = "unsecured_wet" | "secured_possession" | "secured_control" | "transferred_pending_payment" | "released" | "returned";
export type AdvanceStatus = "requested" | "approved" | "rejected" | "funded" | "delivered" | "transferred_pending_payment" | "repaid" | "repurchased" | "kicked_out" | "returned";
export type AgingBucket = "d0_30" | "d31_45" | "d46_60" | "d61_90" | "d90_plus";
export type CurtailmentKind = "aging_45" | "margin_call" | "wet_overdue" | "partner_voluntary";
export type DefectSource = "custodian_exception" | "loan_delivery_edit" | "purchase_error" | "earlycheck_fatal" | "qc_finding" | "compliance_failure" | "missing_document" | "eregistry_mismatch" | "mers_mismatch";
export type CovenantFrequency = "quarterly" | "annual";

export interface FacilityTerms {
  readonly facility_id: string; readonly partner_id: string; readonly agreement_kind: AgreementKind; readonly status: FacilityStatus;
  readonly facility_limit_cents: Cents; readonly wet_sublimit_pct: number; readonly advance_rate_bps: number;
  readonly index: "sofr_daily_simple"; readonly index_lookback_business_days: number; readonly spread_bps: number; readonly floor_bps: number; readonly day_count: "act_360";
  readonly interest_treatment: "capitalize_monthly" | "invoice_monthly";
  readonly wet_note_delivery_business_days: number; readonly aging_curtail_day: number; readonly curtail_pct: number; readonly dwell_stepup_bps: number; readonly wet_overdue_stepup_bps: number;
  readonly repurchase_day: number; readonly kickout_day: number; readonly wire_fee_cents: Cents; readonly custodian_fee_cents: Cents; readonly max_loan_cents: Cents;
  readonly concentration_limits: Readonly<Record<string, number>>;
  readonly covenants: readonly CovenantTerm[];
  readonly ucc1_filing_number: string | null; readonly ucc1_filed_on: PlainDate | null; readonly ucc1_lapse_on: PlainDate | null; readonly ucc_jurisdiction: string;
  readonly collection_account_ref: string; readonly funding_account_ref: string; readonly haircut_reserve_account_ref: string;
  readonly fnma_warehouse_lender_id: string; readonly bailee_letter_name: string; readonly form_482_payee_hash: string;
  readonly funding_agreement_fnma_executed_at: string | null; readonly mers_org_id_sm: string; readonly policy_version: string;
  /** 31.1 §G: the legal form the facility takes; `purchase_at_closing` (table funding) is refused without an officer-and-counsel record. */
  readonly legal_form: "secured_loan_to_partner" | "purchase_at_closing";
  readonly partner_state: string;
  readonly california_financing_law_resolved: boolean;
}
export interface CovenantTerm { readonly code: string; readonly threshold: string; readonly unit: "cents" | "ratio" | "days" | "boolean"; readonly test_frequency: CovenantFrequency; readonly direction: "min" | "max" | "true"; }

/** Facility fixture (section README "Facility fixture"): limit $50,000,000; 98%; wet 40%; SOFR + 250 bps, floor 0, act/360, 1-BD lookback; 45/10%/60/90; +50 bps dwell; +100 bps wet-overdue; $25.00 wire fee; UCC-1 filed Sept 15, 2026. */
export const FACILITY_FIXTURE: FacilityTerms = {
  facility_id: "WHF-1", partner_id: "partner-1", agreement_kind: "lsa", status: "active",
  facility_limit_cents: 5_000_000_000n, wet_sublimit_pct: 40, advance_rate_bps: 9800, index: "sofr_daily_simple", index_lookback_business_days: 1, spread_bps: 250, floor_bps: 0, day_count: "act_360",
  interest_treatment: "capitalize_monthly", wet_note_delivery_business_days: 5, aging_curtail_day: 45, curtail_pct: 10, dwell_stepup_bps: 50, wet_overdue_stepup_bps: 100, repurchase_day: 60, kickout_day: 90,
  wire_fee_cents: 2_500n, custodian_fee_cents: 0n, max_loan_cents: 83_275_000n,
  concentration_limits: { wet_pct: 40, state_pct: 50, arm_pct: 25, investment_pct: 15, two_to_four_pct: 15, tx_50a6_pct: 10, aged_over_45_pct: 10, paper_pct: 40 },
  covenants: [
    { code: "tangible_net_worth", threshold: "250000000", unit: "cents", test_frequency: "quarterly", direction: "min" },
    { code: "liquidity_30d", threshold: "0", unit: "cents", test_frequency: "quarterly", direction: "min" },
    { code: "leverage", threshold: "15", unit: "ratio", test_frequency: "quarterly", direction: "max" },
    { code: "fnma_approval_maintained", threshold: "true", unit: "boolean", test_frequency: "quarterly", direction: "true" },
    { code: "negative_pledge", threshold: "true", unit: "boolean", test_frequency: "quarterly", direction: "true" },
    { code: "haircut_reserve_maintained", threshold: "true", unit: "boolean", test_frequency: "quarterly", direction: "true" },
  ],
  ucc1_filing_number: "2026-1234567", ucc1_filed_on: D("2026-09-15"), ucc1_lapse_on: D("2031-09-15"), ucc_jurisdiction: "DE",
  collection_account_ref: "bank:sm-collection:hash-c1", funding_account_ref: "bank:sm-funding:hash-f1", haircut_reserve_account_ref: "bank:partner-haircut:hash-h1",
  fnma_warehouse_lender_id: "123456789", bailee_letter_name: "Supermortgage Warehouse Finance, LLC", form_482_payee_hash: "sha256:form482-sm-collection-account",
  funding_agreement_fnma_executed_at: "2026-10-01T00:00:00.000Z", mers_org_id_sm: SM_MERS_ORG_ID, policy_version: POLICY_VERSION,
  legal_form: "secured_loan_to_partner", partner_state: "AZ", california_financing_law_resolved: false,
};

// ============================================================ helpers
const nonEmpty = (v: string | null | undefined, what: string): string => { if (!v || !String(v).trim()) throw new RangeError(`${what} is required`); return v; };
const bps = (n: number): Decimal => Decimal.ratio(BigInt(n), 10_000n);
const pct = (n: number): Decimal => Decimal.ratio(BigInt(n), 100n);
/** round_half_up(amount × rate) in cents. */
/** A cents-valued Decimal rounded half-up to whole cents. */
export const roundCents = (d: Decimal): Cents => d.toScaledInt(0, "HALF_UP");
const mulRound = (amount: Cents, rate: Decimal): Cents => roundCents(Decimal.fromBigInt(amount).mul(rate));
export const etDate = (iso: string): PlainDate => wallClock(Date.parse(iso), "America/New_York").date;
export const etHour = (iso: string): number => wallClock(Date.parse(iso), "America/New_York").hour;
export const etMinute = (iso: string): number => wallClock(Date.parse(iso), "America/New_York").minute;
export class GuardrailViolation extends Error { readonly code: string; readonly citation: string; constructor(code: string, citation: string, why: string) { super(`${code}: ${why}`); this.name = "GuardrailViolation"; this.code = code; this.citation = citation; } }

// ============================================================ structure decision (LSA; never table funding)
/** The facility's legal form is a loan secured by the notes; the purchase-at-closing (table-funding / MRA-at-settlement) form is refused unless an officer-and-counsel record exists (27.1 structure decision; 31.1 §G). No California advance until Financing Law licensing is resolved (27.1-Q8). */
export function assertFacilityForm(f: FacilityTerms, r: { officer_and_counsel_record_id: string | null }): { legal_form: FacilityTerms["legal_form"]; respa_lender: "partner"; table_funding: false } {
  if (f.legal_form === "purchase_at_closing" && !r.officer_and_counsel_record_id) throw new GuardrailViolation("TABLE_FUNDING_FORM_REFUSED", "27.1 structure decision / Reg X §1024.2(b): an assignment at settlement in exchange for the advance is table funding", "the purchase-at-closing form is refused by configuration without an officer-and-counsel record");
  return { legal_form: f.legal_form, respa_lender: "partner", table_funding: false };
}
export function assertJurisdictionLicensed(f: FacilityTerms, propertyState: string): void {
  if (propertyState === "CA" && !f.california_financing_law_resolved) throw new GuardrailViolation("CA_FINANCING_LAW_UNRESOLVED", "27.1-Q8 / 31.1: commercial-lender licensing (California Financing Law)", "no California advance until Financing Law licensing is resolved");
}

// ============================================================ rule 1: eligibility (objective criteria; never re-underwritten)
export interface EligibilityFacts {
  readonly du_recommendation: string; readonly du_final_matches_closing: boolean;
  /** 23.3: `clear_to_close.issued` observed and SM_UW_CTC_GATE satisfied. */
  readonly ctc_issued: boolean;
  /** 25.1: `compliance.gate.opened{gate=disbursement}` observed. */
  readonly disbursement_gate_opened: boolean;
  readonly commitment: { readonly commitment_id_fnma: string; readonly live: boolean; readonly expires_on: PlainDate; readonly type: "best_efforts" | "mandatory" } | null;
  readonly wire_verification: { readonly id: string; readonly match_result: string; readonly expires_at: string; readonly blocks_disbursement: boolean } | null;
  readonly transaction_type: "purchase" | "limited_cash_out" | "cash_out";
  readonly rescission_gate_open: boolean | null;
  readonly wet_dry: WetDry; readonly dry_recording_condition_met: boolean | null;
  readonly note_amount_cents: Cents; readonly units: number; readonly program_in_scope: boolean;
  readonly first_payment_date: PlainDate; readonly disbursement_date: PlainDate;
  readonly qc_prefunding_blocking: boolean; readonly ltv_pct: number; readonly mi_active: boolean;
  readonly flood_gate_open: boolean; readonly insurance_gate_open: boolean; readonly cpl_names_partner: boolean;
  readonly duplicate_advance: boolean; readonly partner_suspended: boolean; readonly facility_status: FacilityStatus;
  readonly appraisal_expires_at: PlainDate | null; readonly lock_extension_count: number;
  readonly evidence: Readonly<Record<string, string>>;
}
export interface CriterionResult { readonly code: string; readonly kind: "hard" | "soft"; readonly pass: boolean; readonly reason: string | null; readonly evidence_id: string | null; }
export interface EligibilitySnapshot { readonly criteria: readonly CriterionResult[]; readonly hard_pass: boolean; readonly reasons: readonly string[]; readonly soft_flags: readonly string[]; readonly rule_set_versions: typeof RULE_SETS; readonly policy_version: string; readonly evaluated_on: PlainDate; }

/** 2026 conforming limit by unit count (FHFA; F11 table — one-unit baseline $832,750; high-cost ceiling handled by `max_loan_cents` per county). */
export const CONFORMING_LIMIT_2026_CENTS: Readonly<Record<number, Cents>> = { 1: 83_275_000n, 2: 106_620_000n, 3: 128_875_000n, 4: 160_160_000n };

export function evaluateEligibility(f: EligibilityFacts, facility: FacilityTerms): EligibilitySnapshot {
  const ev = (k: string): string | null => f.evidence[k] ?? null;
  const hard = (code: string, pass: boolean, reason: string, evidenceKey: string): CriterionResult => ({ code, kind: "hard", pass, reason: pass ? null : reason, evidence_id: ev(evidenceKey) });
  const soft = (code: string, flagged: boolean, reason: string, evidenceKey: string): CriterionResult => ({ code, kind: "soft", pass: !flagged, reason: flagged ? reason : null, evidence_id: ev(evidenceKey) });
  const wv = f.wire_verification;
  const wireOk = !!wv && wv.match_result === "verified" && Date.parse(wv.expires_at) > Date.parse(`${f.disbursement_date}T00:00:00Z`) && !wv.blocks_disbursement;
  const limit = f.note_amount_cents <= (facility.max_loan_cents < (CONFORMING_LIMIT_2026_CENTS[f.units] ?? facility.max_loan_cents) ? facility.max_loan_cents : (CONFORMING_LIMIT_2026_CENTS[f.units] ?? facility.max_loan_cents));
  const refinance = f.transaction_type !== "purchase";
  const criteria: CriterionResult[] = [
    hard("a_du_approve_eligible", f.du_recommendation === "approve_eligible" && f.du_final_matches_closing, "du_not_approve_eligible", "du_submission_id"),
    hard("b_ctc_gate", f.ctc_issued, "ctc_gate_closed", "ctc_checklist_id"),
    hard("c_disbursement_gate", f.disbursement_gate_opened, "disbursement_gate_closed", "compliance_test_run_id"),
    hard("d_commitment_live", !!f.commitment && f.commitment.live && f.commitment.expires_on >= f.disbursement_date, "commitment_missing", "commitment_id"),
    hard("e_wire_verification", wireOk, "wire_verification_failed", "wire_verification_id"),
    hard("f_rescission_gate", !refinance || (f.rescission_gate_open === true && (f.wet_dry === "wet" || f.dry_recording_condition_met !== false)), "rescission_gate_closed", "rescission_id"),
    hard("g_loan_limit", limit, "loan_limit_exceeded", "loan_terms_id"),
    hard("h_program_scope", f.program_in_scope, "program_out_of_scope", "loan_terms_id"),
    hard("i_first_payment_2m", f.first_payment_date <= addMonths(f.disbursement_date, 2), "first_payment_beyond_2m", "loan_terms_id"),
    hard("j_qc_prefunding", !f.qc_prefunding_blocking, "qc_prefunding_hold", "qc_review_id"),
    hard("k_mi_active", f.ltv_pct <= 80 || f.mi_active, "mi_certificate_missing", "mi_certificate_id"),
    hard("l_flood_insurance", f.flood_gate_open && f.insurance_gate_open, "flood_insurance_gate_closed", "insurance_evidence_id"),
    hard("m_cpl_partner", f.cpl_names_partner, "cpl_missing", "cpl_document_id"),
    hard("n_no_duplicate", !f.duplicate_advance, "duplicate_advance", "advance_id"),
    hard("o_facility_active", !f.partner_suspended && f.facility_status === "active", f.partner_suspended ? "partner_suspended" : "facility_not_active", "facility_id"),
    soft("s_appraisal_expiry", !!f.appraisal_expires_at && daysBetween(f.disbursement_date, f.appraisal_expires_at) <= 30, "appraisal_expiring_30d", "appraisal_id"),
    soft("s_lock_extensions", f.lock_extension_count > 1, "lock_extensions_gt_1", "lock_id"),
    soft("s_commitment_expiry", !!f.commitment && daysBetween(f.disbursement_date, f.commitment.expires_on) < 15, "commitment_expiry_lt_15d", "commitment_id"),
  ];
  const reasons = criteria.filter((c) => c.kind === "hard" && !c.pass).map((c) => c.reason!);
  return { criteria, hard_pass: reasons.length === 0, reasons, soft_flags: criteria.filter((c) => c.kind === "soft" && !c.pass).map((c) => c.reason!), rule_set_versions: RULE_SETS, policy_version: facility.policy_version, evaluated_on: f.disbursement_date };
}

// ============================================================ rule 2: advance amount
/** `advance_cents = min(round_half_up(advance_rate × note_amount), net_disbursement)`; `partner_contribution = net_disbursement − advance` (fixture: $560,000 × 0.98 = $548,800.00; $557,249.57 − $548,800.00 = $8,449.57). */
export function advanceAmount(facility: FacilityTerms, noteAmountCents: Cents, netDisbursementCents: Cents): { advance_cents: Cents; partner_contribution_cents: Cents; wire_cents: Cents } {
  if (noteAmountCents <= 0n) throw new RangeError("note_amount_cents must be > 0");
  if (netDisbursementCents <= 0n) throw new RangeError("net_disbursement_cents must be > 0");
  const rated = mulRound(noteAmountCents, bps(facility.advance_rate_bps));
  const advance_cents = rated < netDisbursementCents ? rated : netDisbursementCents;
  return { advance_cents, partner_contribution_cents: netDisbursementCents - advance_cents, wire_cents: netDisbursementCents };
}
/** 26.3's net disbursement (illustrative composition the fixture uses): note − prepaid interest (days × cent-rounded per diem) − initial escrow deposit + lender credit. */
export function netDisbursement(i: { note_amount_cents: Cents; per_diem_cents: Cents; prepaid_days: number; initial_escrow_deposit_cents: Cents; lender_credit_cents: Cents }): { prepaid_interest_cents: Cents; net_disbursement_cents: Cents } {
  const prepaid_interest_cents = i.per_diem_cents * BigInt(i.prepaid_days);
  return { prepaid_interest_cents, net_disbursement_cents: i.note_amount_cents - prepaid_interest_cents - i.initial_escrow_deposit_cents + i.lender_credit_cents };
}

// ============================================================ rule 3: borrowing base, availability, margin calls
export interface OpenAdvance {
  readonly advance_id: string; readonly loan_id: string | null; readonly application_id: string;
  readonly note_amount_cents: Cents; readonly outstanding_principal_cents: Cents; readonly capitalized_interest_cents: Cents;
  readonly commitment_price: string;                      // "101.375"; premium commitments cap at par
  readonly advance_date: PlainDate; readonly note_form: NoteForm; readonly wet: boolean; readonly wet_deadline_on: PlainDate | null;
  readonly collateral_status: CollateralStatus;
  readonly interim_funder_designated_at: string | null; readonly interim_funder_due_on: PlainDate | null;
  readonly open_incurable_defect: boolean; readonly status: AdvanceStatus;
  readonly state: string; readonly arm: boolean; readonly occupancy: "primary" | "second_home" | "investment"; readonly units: number; readonly tx_50a6: boolean;
}
export interface BorrowingBaseRow { readonly advance_id: string; readonly outstanding_cents: Cents; readonly collateral_value_cents: Cents; readonly eligible: boolean; readonly ineligible_reason: string | null; readonly aged_days: number; readonly margin_call_cents: Cents; }
export interface BorrowingBaseSnapshot {
  readonly facility_id: string; readonly as_of: PlainDate; readonly facility_limit_cents: Cents; readonly outstanding_cents: Cents; readonly eligible_collateral_value_cents: Cents;
  readonly ineligible_cents: Readonly<Record<string, Cents>>; readonly availability_cents: Cents; readonly wet_outstanding_cents: Cents; readonly wet_sublimit_cents: Cents; readonly wet_availability_cents: Cents;
  readonly concentrations: Readonly<Record<string, Cents>>; readonly margin_call_cents: Cents; readonly rows: readonly BorrowingBaseRow[];
}
/** `collateral_value = round_half_up(advance_rate × min(note_amount, price/100 × note_amount))` — mark-to-commitment, capped at par (T10: 98% × 99.5% × $560,000 = $546,056.00). */
export function collateralValue(facility: FacilityTerms, noteAmountCents: Cents, commitmentPrice: string): Cents {
  const price = Decimal.parse(commitmentPrice).div(Decimal.fromInt(100));
  const marked = price.cmp(Decimal.ONE) < 0 ? Decimal.fromBigInt(noteAmountCents).mul(price) : Decimal.fromBigInt(noteAmountCents);
  return roundCents(marked.mul(bps(facility.advance_rate_bps)));
}
export const agedDays = (advanceDate: PlainDate, asOf: PlainDate): number => daysBetween(advanceDate, asOf);
export function ineligibilityReason(facility: FacilityTerms, a: OpenAdvance, asOf: PlainDate): string | null {
  if (a.status === "kicked_out" || agedDays(a.advance_date, asOf) > facility.kickout_day) return "aged_over_kickout";
  if (a.collateral_status === "unsecured_wet" && a.wet_deadline_on !== null && asOf > a.wet_deadline_on) return "unsecured_wet_overdue";
  if (a.note_form === "paper" && a.interim_funder_designated_at === null && a.interim_funder_due_on !== null && asOf > a.interim_funder_due_on) return "interim_funder_missing";
  if (a.open_incurable_defect) return "incurable_defect";
  return null;
}
export const wetSublimitCents = (facility: FacilityTerms): Cents => mulRound(facility.facility_limit_cents, pct(facility.wet_sublimit_pct));
export function computeBorrowingBase(facility: FacilityTerms, advances: readonly OpenAdvance[], asOf: PlainDate, pendingEligibleCents: Cents = 0n): BorrowingBaseSnapshot {
  const open = advances.filter((a) => a.status !== "repaid" && a.status !== "repurchased" && a.status !== "rejected" && a.status !== "requested");
  const ineligible: Record<string, Cents> = {}; const conc: Record<string, Cents> = { wet: 0n, paper: 0n, arm: 0n, investment: 0n, two_to_four: 0n, tx_50a6: 0n, aged_over_45: 0n };
  let outstanding = 0n, eligibleValue = 0n, wetOut = 0n, marginTotal = 0n;
  const rows: BorrowingBaseRow[] = open.map((a) => {
    const out = a.outstanding_principal_cents + a.capitalized_interest_cents;
    const value = collateralValue(facility, a.note_amount_cents, a.commitment_price);
    const reason = ineligibilityReason(facility, a, asOf);
    const aged = agedDays(a.advance_date, asOf);
    outstanding += out;
    if (a.wet || a.collateral_status === "unsecured_wet") { wetOut += out; conc.wet! += out; }
    if (a.note_form === "paper") conc.paper! += out; if (a.arm) conc.arm! += out; if (a.occupancy === "investment") conc.investment! += out; if (a.units >= 2) conc.two_to_four! += out; if (a.tx_50a6) conc.tx_50a6! += out; if (aged > 45) conc.aged_over_45! += out;
    const margin = reason === null && out > value ? out - value : 0n;
    if (reason) ineligible[reason] = (ineligible[reason] ?? 0n) + out; else { eligibleValue += value; marginTotal += margin; }
    return { advance_id: a.advance_id, outstanding_cents: out, collateral_value_cents: value, eligible: reason === null, ineligible_reason: reason, aged_days: aged, margin_call_cents: margin };
  });
  const cap = eligibleValue + pendingEligibleCents < facility.facility_limit_cents ? eligibleValue + pendingEligibleCents : facility.facility_limit_cents;
  const wetSub = wetSublimitCents(facility);
  return { facility_id: facility.facility_id, as_of: asOf, facility_limit_cents: facility.facility_limit_cents, outstanding_cents: outstanding, eligible_collateral_value_cents: eligibleValue, ineligible_cents: ineligible,
    availability_cents: cap - outstanding, wet_outstanding_cents: wetOut, wet_sublimit_cents: wetSub, wet_availability_cents: wetSub - wetOut, concentrations: conc, margin_call_cents: marginTotal, rows };
}

// ============================================================ rule 4: collateral control by note form and funding type
export interface AdvanceRequest {
  readonly advance_id: string; readonly facility_id: string; readonly loan_id: string | null; readonly application_id: string; readonly funding_id: string;
  readonly requested_at: string; readonly note_form: NoteForm; readonly closing_type: "ron" | "ipen" | "hybrid" | "wet"; readonly wet_dry: WetDry;
  readonly note_amount_cents: Cents; readonly net_disbursement_cents: Cents; readonly note_date: PlainDate; readonly transaction_type: "purchase" | "limited_cash_out" | "cash_out";
  readonly commitment_price: string; readonly commitment_id_fnma: string; readonly wire_verification_id: string; readonly property_state: string;
  readonly enote_registered_at: PlainDate | null; readonly secured_party_added_at: string | null; readonly trust_receipt_at: string | null;
}
export function wetReason(r: Pick<AdvanceRequest, "note_form" | "wet_dry" | "secured_party_added_at" | "trust_receipt_at">): WetReason {
  if (r.note_form === "enote") return r.secured_party_added_at ? "none" : "enote_pre_secured_party";
  if (r.wet_dry === "wet") return "wet_state_paper";
  return r.trust_receipt_at ? "none" : "wet_state_paper";
}
export function collateralStatusAtFunding(r: Pick<AdvanceRequest, "note_form" | "wet_dry" | "secured_party_added_at" | "trust_receipt_at">): CollateralStatus {
  if (r.note_form === "enote") return r.secured_party_added_at ? "secured_control" : "unsecured_wet";
  return r.trust_receipt_at ? "secured_possession" : "unsecured_wet";
}
/** Wet note delivery clock: +5 `business_days_servicer` from the advance date (fixture B: Nov 18 → Wed Nov 25, 2026; Thanksgiving excluded). */
export const wetNoteDeadline = (facility: FacilityTerms, advanceDate: PlainDate): PlainDate => addBusinessDays(advanceDate, facility.wet_note_delivery_business_days, servicer);
/** Day 6 of a wet advance without a trust receipt: `wet_overdue` (+100 bps) and a full-repayment curtailment due at day 10 (rolled to the next servicer business day when day 10 is not one). */
export function wetOverdue(facility: FacilityTerms, advanceDate: PlainDate, asOf: PlainDate, receivedAt: string | null): { overdue: boolean; overdue_from: PlainDate; stepup_bps: number; full_repayment_day: PlainDate; full_repayment_due_on: PlainDate } {
  const deadline = wetNoteDeadline(facility, advanceDate);
  const overdue_from = addDays(deadline, 1); const day10 = addDays(advanceDate, 10);
  return { overdue: receivedAt === null && asOf >= overdue_from, overdue_from, stepup_bps: facility.wet_overdue_stepup_bps, full_repayment_day: day10, full_repayment_due_on: rollForward(day10, servicer) };
}
/** Interim Funder designation: note date + 7 calendar days (refinance / escrow states: funding date — MERS_PROC_MOM_REGISTER_7, 26.4; 1.5's mersClocks registration clock reused). */
export const interimFunderAnchor = (r: { note_date: PlainDate; advance_date: PlainDate; transaction_type: AdvanceRequest["transaction_type"]; escrow_state: boolean }): PlainDate => (r.transaction_type !== "purchase" || r.escrow_state ? r.advance_date : r.note_date);
export const interimFunderDeadline = (anchor: PlainDate): PlainDate => mersClocks(anchor).registration_due_for_unregistered;
/** eNote Secured Party clock anchor: max(advance_date, enotes.registered_at). */
export const securedPartyAnchor = (advanceDate: PlainDate, registeredAt: PlainDate | null): PlainDate => (registeredAt && registeredAt > advanceDate ? registeredAt : advanceDate);
/** 26.4's `mers.min.registered` verified for SM's Interim Funder Org ID (rule 4: 26.4 registers; 27.1 verifies). */
export function verifyInterimFunder(reg: { min: string; interim_funder_org_id: string | null }, smOrgId: string = SM_MERS_ORG_ID): { designated: boolean; mismatch: DefectSource | null } {
  nonEmpty(reg.min, "min");
  return reg.interim_funder_org_id === smOrgId ? { designated: true, mismatch: null } : { designated: false, mismatch: "mers_mismatch" };
}
/** The state machine guard: no advance moves to `delivered` unless its collateral is secured (9-330(d): possession/control, not filing, protects SM). */
export function assertDeliverable(status: CollateralStatus): void {
  if (status !== "secured_possession" && status !== "secured_control") throw new GuardrailViolation("DELIVERY_NEEDS_SECURED_COLLATERAL", "27.1 state machine guard / UCC 9-330(d)", `collateral_status ${status} — delivery requires secured_possession or secured_control`);
}

// ============================================================ rule 5: bailee letter
export interface BaileeLetterDraft {
  readonly bailee_letter_id: string; readonly facility_id: string; readonly custodian_party_id: string; readonly letter_name: string; readonly letter_date: PlainDate;
  readonly loan_list: readonly { advance_id: string; seller_loan_number: string; borrower_last_name: string; note_amount_cents: Cents; note_date: PlainDate }[];
  readonly wire_instructions_hash: string; readonly fnma_letter_type: "bailee" | "form_2004a"; readonly signature_kind: "esign" | "wet_ink";
}
export const releaseConditionText = (smName: string): string => `the lien of ${smName}'s security interest will be released only if the proceeds from the transfer of the mortgages to Fannie Mae are delivered to ${smName} in accordance with the delivery instructions in this letter`;
export const BAILEE_LETTER_EXPIRY_DAYS = 90;
export type BaileeRefusal = "letter_name_mismatch" | "form_482_mismatch" | "empty_loan_list";
export function issueBaileeLetter(facility: FacilityTerms, d: BaileeLetterDraft): { ok: true; letter: BaileeLetterDraft & { release_condition_text: string; expires_on: PlainDate; status: "draft"; signed_by: null } } | { ok: false; refusal: BaileeRefusal; detail: string } {
  if (d.letter_name !== facility.bailee_letter_name) return { ok: false, refusal: "letter_name_mismatch", detail: `letter_name ${JSON.stringify(d.letter_name)} must equal warehouse_facilities.bailee_letter_name ${JSON.stringify(facility.bailee_letter_name)} character-for-character (Warehouse Lender User Guide p. 5)` };
  if (d.wire_instructions_hash !== facility.form_482_payee_hash) return { ok: false, refusal: "form_482_mismatch", detail: "wire instructions must match the partner's Form 482 payee code for SM (Form 482: \"instructions on the Form 482 must match the bailee letter on file\")" };
  if (d.loan_list.length === 0) return { ok: false, refusal: "empty_loan_list", detail: "a bailee letter lists at least one loan" };
  return { ok: true, letter: { ...d, release_condition_text: releaseConditionText(facility.bailee_letter_name), expires_on: addDays(d.letter_date, BAILEE_LETTER_EXPIRY_DAYS), status: "draft", signed_by: null } };
}
/** Signing a bailee letter or Form 2004A is a human `officer{sm}` act — the agent renders and routes, never signs. */
export function signBaileeLetter(by: Actor): { signed_by: string; status: "issued" } {
  if (!(by.kind === "human" && by.role === "officer")) throw new GuardrailViolation("BAILEE_LETTER_SIGNATURE_IS_OFFICER", "27.1 guardrails: sign a bailee letter or Form 2004A (human officer{sm} signature)", `signature requires officer; actor is ${by.kind}:${by.id}`);
  return { signed_by: `${by.kind}:${by.id}`, status: "issued" };
}

// ============================================================ rule 6: interest (Daily Simple SOFR + spread, act/360, cumulative rounding)
export interface SofrPoint { readonly publication_date: PlainDate; readonly rate_bps: number; }
/** `index_rate` for accrual date d = SOFR published on the last `business_days_federal` on or before d − 1 business day (one-business-day lookback; weekends/holidays reuse the last published value; floor 0). */
export function indexRateFor(date: PlainDate, series: readonly SofrPoint[], lookbackBusinessDays = 1): { rate_bps: number; publication_date: PlainDate } {
  const lookback = addBusinessDays(date, -lookbackBusinessDays, federal);
  const candidates = series.filter((p) => p.publication_date <= lookback).sort((a, b) => (a.publication_date < b.publication_date ? -1 : 1));
  const last = candidates.at(-1);
  if (!last) throw new RangeError(`no SOFR publication on or before ${lookback} (lookback for ${date})`);
  return { rate_bps: last.rate_bps < 0 ? 0 : last.rate_bps, publication_date: last.publication_date };
}
export interface RateFlags { readonly dwell_stepup_active: boolean; readonly wet_overdue: boolean; }
/** `all_in = max(index, floor) + spread + dwell step-up (aged ≥ curtail day + 1) + wet-overdue step-up (100 bps)`. */
export function allInRateBps(facility: FacilityTerms, indexBps: number, flags: RateFlags): { all_in_rate_bps: number; stepup_bps: number } {
  const stepup_bps = (flags.dwell_stepup_active ? facility.dwell_stepup_bps : 0) + (flags.wet_overdue ? facility.wet_overdue_stepup_bps : 0);
  return { all_in_rate_bps: Math.max(indexBps, facility.floor_bps) + facility.spread_bps + stepup_bps, stepup_bps };
}
export interface AccrualState { readonly cumulative: Decimal; readonly posted_total_cents: Cents; }
export const ACCRUAL_START: AccrualState = { cumulative: Decimal.ZERO, posted_total_cents: 0n };
/** One day's unrounded interest `P × r / 360` (cents, Decimal). */
export const dailyInterest = (principalCents: Cents, allInBps: number): Decimal => Decimal.fromBigInt(principalCents).mul(bps(allInBps)).div(Decimal.fromInt(360));
/** Cumulative method: `posting(n) = round_half_up(C(n)) − Σ previous postings`. */
export function accrueDay(state: AccrualState, principalCents: Cents, allInBps: number): { state: AccrualState; posted_cents: Cents; cumulative: Decimal } {
  const cumulative = state.cumulative.add(dailyInterest(principalCents, allInBps));
  const posted_cents = roundCents(cumulative) - state.posted_total_cents;
  return { state: { cumulative, posted_total_cents: state.posted_total_cents + posted_cents }, posted_cents, cumulative };
}
export interface AccrualRow { readonly accrual_date: PlainDate; readonly principal_basis_cents: Cents; readonly index_rate_bps: number; readonly index_publication_date: PlainDate; readonly spread_bps: number; readonly stepup_bps: number; readonly all_in_rate_bps: number; readonly cumulative_interest_dollars: string; readonly posted_cents: Cents; readonly capitalized: boolean; }
export interface AccrualPath { readonly from: PlainDate; readonly to: PlainDate; readonly principalOn: (d: PlainDate) => Cents; readonly flagsOn: (d: PlainDate) => RateFlags; readonly sofr: readonly SofrPoint[]; }
/** The accrual rows for every date in [from, to] (inclusive) by the cumulative method — one unbroken cumulative across rate and principal changes (rule 6's `C(n) = Σ P_k × r_k / 360`). */
export function accrualSchedule(facility: FacilityTerms, p: AccrualPath, start: AccrualState = ACCRUAL_START): { rows: AccrualRow[]; state: AccrualState; total_posted_cents: Cents } {
  const rows: AccrualRow[] = []; let state = start;
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) {
    const idx = indexRateFor(d, p.sofr, facility.index_lookback_business_days); const rate = allInRateBps(facility, idx.rate_bps, p.flagsOn(d)); const principal = p.principalOn(d);
    const r = accrueDay(state, principal, rate.all_in_rate_bps); state = r.state;
    rows.push({ accrual_date: d, principal_basis_cents: principal, index_rate_bps: idx.rate_bps, index_publication_date: idx.publication_date, spread_bps: facility.spread_bps, stepup_bps: rate.stepup_bps, all_in_rate_bps: rate.all_in_rate_bps, cumulative_interest_dollars: r.cumulative.div(Decimal.fromInt(100)).toFixed(8), posted_cents: r.posted_cents, capitalized: false });
  }
  return { rows, state, total_posted_cents: state.posted_total_cents - start.posted_total_cents };
}
/** The rejected implementation (T3): per-diem rounded to the cent and multiplied — $103.66 × 7 = $725.62 against the cumulative $725.64. */
export const naivePerDiemTotal = (principalCents: Cents, allInBps: number, days: number): Cents => roundCents(dailyInterest(principalCents, allInBps)) * BigInt(days);
/** Interest for one segment (constant principal and rate) by the cumulative method, standalone — the worked examples' per-segment figures ($4,768.46 for 46 days at 6.80% on $548,800; $801.25 / $1,402.18 for 8 / 14 days at 7.30% on $493,920). */
export const segmentInterest = (principalCents: Cents, allInBps: number, days: number): Cents => roundCents(dailyInterest(principalCents, allInBps).mul(Decimal.fromInt(days)));
/** Monthly capitalization on the 1st: `capitalized_interest += Σ postings of the prior month` (invoice instead when `interest_treatment = invoice_monthly`). Ordered before any same-day payoff (edge case: capitalize first). */
export function capitalizeMonth(facility: FacilityTerms, rows: readonly AccrualRow[], monthEndingBefore: PlainDate): { month: string; capitalized_cents: Cents; treatment: FacilityTerms["interest_treatment"]; rows: AccrualRow[] } {
  const { y, m } = parts(monthEndingBefore); const prior = addMonths(ymd(y, m, 1), -1); const pm = parts(prior);
  const inMonth = rows.filter((r) => { const p = parts(r.accrual_date); return p.y === pm.y && p.m === pm.m && !r.capitalized; });
  const capitalized_cents = inMonth.reduce((s, r) => s + r.posted_cents, 0n);
  return { month: `${pm.y}-${String(pm.m).padStart(2, "0")}`, capitalized_cents, treatment: facility.interest_treatment, rows: inMonth.map((r) => ({ ...r, capitalized: true })) };
}
export interface PayoffStatement { readonly outstanding_principal_cents: Cents; readonly capitalized_interest_cents: Cents; readonly accrued_not_capitalized_cents: Cents; readonly fees_cents: Cents; readonly total_cents: Cents; readonly through: PlainDate; }
/** Payoff = principal + capitalized interest + accrued-not-capitalized interest through the day before repayment + fees (fixture A: $548,800.00 + $725.64 + $25.00 = $549,550.64). */
export function payoffStatement(i: { outstanding_principal_cents: Cents; capitalized_interest_cents: Cents; accrued_not_capitalized_cents: Cents; fees_cents: Cents; repayment_on: PlainDate }): PayoffStatement {
  return { outstanding_principal_cents: i.outstanding_principal_cents, capitalized_interest_cents: i.capitalized_interest_cents, accrued_not_capitalized_cents: i.accrued_not_capitalized_cents, fees_cents: i.fees_cents, total_cents: i.outstanding_principal_cents + i.capitalized_interest_cents + i.accrued_not_capitalized_cents + i.fees_cents, through: addDays(i.repayment_on, -1) };
}

// ============================================================ rule 7: fees
export type FeeKind = "wire_out" | "wire_in" | "custodian";
export function assessFee(facility: FacilityTerms, kind: FeeKind, usesSmCustodian = false): { kind: FeeKind; amount_cents: Cents; pass_through: true } {
  const amount_cents = kind === "custodian" ? (usesSmCustodian ? facility.custodian_fee_cents : 0n) : facility.wire_fee_cents;
  return { kind, amount_cents, pass_through: true };
}

// ============================================================ rule 8: aging, curtailment, repurchase, kick-out
export function agingBucket(aged: number): AgingBucket { return aged <= 30 ? "d0_30" : aged <= 45 ? "d31_45" : aged <= 60 ? "d46_60" : aged <= 90 ? "d61_90" : "d90_plus"; }
/** Day 45: curtailment = curtail_pct × outstanding principal, payable the next servicer business day when day 45 is not one (fixture: Sun Dec 27, 2026 → Mon Dec 28; 10% × $548,800 = $54,880.00); the dwell step-up applies from day 46. */
export function curtailmentAt45(facility: FacilityTerms, advanceDate: PlainDate, outstandingPrincipalCents: Cents): { day45_on: PlainDate; due_on: PlainDate; amount_cents: Cents; stepup_from: PlainDate; stepup_bps: number; balance_after_cents: Cents } {
  const day45_on = addDays(advanceDate, facility.aging_curtail_day);
  const amount_cents = mulRound(outstandingPrincipalCents, pct(facility.curtail_pct));
  return { day45_on, due_on: rollForward(day45_on, servicer), amount_cents, stepup_from: addDays(advanceDate, facility.aging_curtail_day + 1), stepup_bps: facility.dwell_stepup_bps, balance_after_cents: outstandingPrincipalCents - amount_cents };
}
/** Day 60: repurchase demanded; full payoff within +5 `business_days_servicer` (fixture: Mon Jan 11, 2027 → Tue Jan 19, 2027, MLK Day excluded). */
export function repurchaseSchedule(facility: FacilityTerms, advanceDate: PlainDate): { demand_on: PlainDate; payment_due_on: PlainDate } {
  const demand_on = addDays(advanceDate, facility.repurchase_day);
  return { demand_on, payment_due_on: addBusinessDays(demand_on, 5, servicer) };
}
export const kickoutOn = (facility: FacilityTerms, advanceDate: PlainDate): PlainDate => addDays(advanceDate, facility.kickout_day);
export const defectCureDue = (recordedOn: PlainDate): PlainDate => addBusinessDays(recordedOn, 10, servicer);
/** Kick-outs and repurchase demands require an `officer{sm}` acknowledgment — no automated enforcement wires. */
export function assertOfficerAck(ack: { officer_ack_id: string | null; acknowledged_by_role?: string | null }, what: string): string {
  if (!ack.officer_ack_id || (ack.acknowledged_by_role !== undefined && ack.acknowledged_by_role !== null && ack.acknowledged_by_role !== "officer")) throw new GuardrailViolation("ENFORCEMENT_NEEDS_OFFICER_ACK", "27.1 state machine guards: `kicked_out` and `repurchase demanded` require officer{sm} acknowledgment", `${what} without an officer{sm} acknowledgment record`);
  return ack.officer_ack_id;
}

// ============================================================ rule 10: covenants
export function covenantPackageDeadline(periodEnd: PlainDate, frequency: CovenantFrequency): PlainDate { return addDays(periodEnd, frequency === "quarterly" ? 45 : 90); }
export function testCovenant(term: CovenantTerm, reportedValue: string): "pass" | "fail" {
  if (term.unit === "boolean") return reportedValue === "true" ? "pass" : "fail";
  const v = Decimal.parse(reportedValue), t = Decimal.parse(term.threshold);
  return term.direction === "min" ? (v.cmp(t) >= 0 ? "pass" : "fail") : v.cmp(t) <= 0 ? "pass" : "fail";
}
/** Waiving a covenant is an `officer{sm}` act within 5 business days of the breach; the agent never waives. */
export function covenantWaiverAllowed(by: Actor, breachedOn: PlainDate, on: PlainDate): boolean { return by.kind === "human" && by.role === "officer" && on <= addBusinessDays(breachedOn, 5, servicer); }

// ============================================================ wire cut-off (SM_WH_ADVANCE_CUTOFF_GATE) and value date
export const WIRE_CUTOFF_ET = "13:00";
/** Requests approved by 13:00 ET fund same day; later → next `business_days_federal` (Fedwire); non-Fedwire days roll forward. */
export function wireValueDate(approvedAtIso: string): { value_date: PlainDate; same_day: boolean } {
  const date = etDate(approvedAtIso); const beforeCutoff = etHour(approvedAtIso) < 13;
  const onFedwireDay = federal.isBusinessDay(date);
  if (beforeCutoff && onFedwireDay) return { value_date: date, same_day: true };
  return { value_date: addBusinessDays(date, 1, federal), same_day: false };
}

// ============================================================ ledger sets (SM books + the 30.2 clearing seam)
const loanAcct = (loanId: string, account: LoanAccount): AccountRef => ({ scope: "loan", loanId, account });
const corpAcct = (account: CorporateAccount): AccountRef => ({ scope: "corporate", account });
const custodialAcct = (custodialAccountId: string, account: CustodialAccount): AccountRef => ({ scope: "custodial", custodialAccountId, account });
export const WH_ACCOUNTS = { advance_principal: "warehouse_advance_receivable.principal", advance_capitalized: "warehouse_advance_receivable.capitalized_interest", advance_fees: "warehouse_advance_receivable.fees", interest_receivable: "warehouse_interest_receivable", fees_receivable: "warehouse_fees_receivable", interest_income: "warehouse_interest_income", fees: "warehouse_fees", funding_cash: "sm_funding_cash", collection_cash: "sm_collection_cash", haircut_reserve: "partner_haircut_reserve", loss_reserve: "warehouse_loss_reserve", partner_payable: "warehouse_payable", partner_interest_expense: "warehouse_interest_expense", partner_contribution: "partner_funding_contribution" } as const;
export const sumLines = (lines: readonly LineInput[]): Cents => lines.reduce((t, l) => t + l.amountCents, 0n);
/**
 * The advance wire, split in the ledger into the advance and the partner contribution (spec Outputs: Dr
 * warehouse_advance_receivable{loan}.principal / Cr sm_funding_cash; Dr partner_haircut_reserve / Cr sm_funding_cash),
 * and the seam set that clears 30.2's per-loan `origination_funding_clearing` credit against the partner mirror
 * (`warehouse_payable` for the advance; the partner's own contribution for the haircut).
 */
export function advanceLedgerSets(i: { loan_id: string; advance_id: string; advance_date: PlainDate; advance_cents: Cents; partner_contribution_cents: Cents; funding_account_ref: string; haircut_reserve_account_ref: string }): { sm_wire: EntrySetInput; clearing: EntrySetInput } {
  const wire = i.advance_cents + i.partner_contribution_cents;
  const smLines: LineInput[] = [
    { account: loanAcct(i.loan_id, WH_ACCOUNTS.advance_principal), amountCents: i.advance_cents, ruleRef: "27.1:advance:principal", memo: `advance ${i.advance_id}` },
    { account: custodialAcct(i.funding_account_ref, WH_ACCOUNTS.funding_cash), amountCents: -wire, ruleRef: "27.1:advance:wire", memo: "one Fedwire to the settlement agent on the partner's behalf" },
  ];
  if (i.partner_contribution_cents > 0n) smLines.push({ account: custodialAcct(i.haircut_reserve_account_ref, WH_ACCOUNTS.haircut_reserve), amountCents: i.partner_contribution_cents, ruleRef: "27.1:advance:partner_contribution", memo: "funded from the partner haircut reserve (SM_WH_HAIRCUT_RESERVE_GATE)" });
  const clearingLines: LineInput[] = [
    { account: origFundingClearing(i.loan_id), amountCents: wire, ruleRef: "27.1:advance:clearing", memo: "clears 30.2's origination_funding_clearing credit for the funded disbursement" },
    { account: loanAcct(i.loan_id, WH_ACCOUNTS.partner_payable), amountCents: -i.advance_cents, ruleRef: "27.1:advance:partner_mirror", memo: "partner mirror: warehouse_payable (27.2 GL export)" },
  ];
  if (i.partner_contribution_cents > 0n) clearingLines.push({ account: loanAcct(i.loan_id, WH_ACCOUNTS.partner_contribution), amountCents: -i.partner_contribution_cents, ruleRef: "27.1:advance:partner_mirror_contribution", memo: "partner mirror: haircut contribution from its own reserve" });
  return { sm_wire: { effectiveDate: i.advance_date, description: `warehouse advance ${i.advance_id} wire`, lines: smLines }, clearing: { effectiveDate: i.advance_date, description: `warehouse advance ${i.advance_id} clearing`, lines: clearingLines } };
}
export const accrualLedgerSet = (loanId: string, row: AccrualRow): EntrySetInput => ({ effectiveDate: row.accrual_date, description: `warehouse interest accrual ${row.accrual_date}`, lines: [
  { account: loanAcct(loanId, WH_ACCOUNTS.interest_receivable), amountCents: row.posted_cents, ruleRef: "27.1:accrual:receivable", memo: `${row.all_in_rate_bps} bps act/360 on ${row.principal_basis_cents}` },
  { account: corpAcct(WH_ACCOUNTS.interest_income), amountCents: -row.posted_cents, ruleRef: "27.1:accrual:income" }] });
export const capitalizationLedgerSet = (loanId: string, on: PlainDate, cents: Cents): EntrySetInput => ({ effectiveDate: on, description: `warehouse interest capitalization ${on}`, lines: [
  { account: loanAcct(loanId, WH_ACCOUNTS.advance_capitalized), amountCents: cents, ruleRef: "27.1:capitalize:advance" },
  { account: loanAcct(loanId, WH_ACCOUNTS.interest_receivable), amountCents: -cents, ruleRef: "27.1:capitalize:receivable" }] });
export const feeLedgerSet = (loanId: string, on: PlainDate, kind: FeeKind, cents: Cents): EntrySetInput => ({ effectiveDate: on, description: `warehouse ${kind} fee`, lines: [
  { account: loanAcct(loanId, WH_ACCOUNTS.fees_receivable), amountCents: cents, ruleRef: "27.1:fee:receivable" },
  { account: corpAcct(WH_ACCOUNTS.fees), amountCents: -cents, ruleRef: "27.1:fee:income" }] });
export const curtailmentLedgerSet = (loanId: string, on: PlainDate, cents: Cents, collectionAccountRef: string, kind: CurtailmentKind): EntrySetInput => ({ effectiveDate: on, description: `warehouse curtailment ${kind}`, lines: [
  { account: custodialAcct(collectionAccountRef, WH_ACCOUNTS.collection_cash), amountCents: cents, ruleRef: "27.1:curtailment:cash" },
  { account: loanAcct(loanId, WH_ACCOUNTS.advance_principal), amountCents: -cents, ruleRef: "27.1:curtailment:principal" }] });

// ============================================================ ports (bank, custodian, eRegistry) with fakes
export interface WireApproval { readonly approval_id: string; readonly approved_by: Actor; readonly approved_at: string; readonly wire_cents: Cents; }
export interface WireRequest { readonly advance_id: string; readonly value_date: PlainDate; readonly amount_cents: Cents; readonly beneficiary_wire_verification_id: string; readonly funding_account_ref: string; readonly idempotency_key: string; }
export interface WarehouseBankPort { releaseWire(req: WireRequest, approval: WireApproval | null): Promise<{ wire_out_id: string; value_date: PlainDate; duplicate: boolean }>; }
/** The dual-control bank wire API: a release without a `funding_approver` approval record is refused (T12) — the platform, not the bank, is the guardrail. */
export class FakeWarehouseBank implements WarehouseBankPort {
  readonly wires: { wire_out_id: string; req: WireRequest; approval_id: string }[] = [];
  readonly refusals: { req: WireRequest; code: string }[] = [];
  async releaseWire(req: WireRequest, approval: WireApproval | null): Promise<{ wire_out_id: string; value_date: PlainDate; duplicate: boolean }> {
    if (!approval || !(approval.approved_by.kind === "human" && approval.approved_by.role === "funding_approver") || approval.wire_cents !== req.amount_cents) { this.refusals.push({ req, code: "WIRE_NEEDS_FUNDING_APPROVER" }); throw new GuardrailViolation("WIRE_NEEDS_FUNDING_APPROVER", "27.1 guardrails: the agent may never fund without funding_approver release (dual control)", `wire for ${req.advance_id} has no funding_approver approval record for ${req.amount_cents} cents`); }
    const dup = this.wires.find((w) => w.req.idempotency_key === req.idempotency_key);
    if (dup) return { wire_out_id: dup.wire_out_id, value_date: dup.req.value_date, duplicate: true };
    const wire_out_id = `fedwire-${this.wires.length + 1}`; this.wires.push({ wire_out_id, req, approval_id: approval.approval_id });
    return { wire_out_id, value_date: req.value_date, duplicate: false };
  }
}
export interface WarehouseCustodianPort { trustReceipts(sinceIso: string): Promise<readonly { receipt_id: string; seller_loan_number: string; min: string | null; received_at: string; bailee_letter_id: string }[]>; }
export class FakeWarehouseCustodian implements WarehouseCustodianPort {
  readonly receipts: { receipt_id: string; seller_loan_number: string; min: string | null; received_at: string; bailee_letter_id: string }[] = [];
  async trustReceipts(sinceIso: string): Promise<readonly { receipt_id: string; seller_loan_number: string; min: string | null; received_at: string; bailee_letter_id: string }[]> { return this.receipts.filter((r) => r.received_at >= sinceIso); }
}
export interface ERegistryTransfer { readonly transfer_id: string; readonly min: string; readonly from_controller_org_id: string; readonly to_controller_org_id: string; readonly effective_date: PlainDate; readonly initiated_by_org_id: string; readonly kind: "control_and_location"; }
export interface ERegistryPort {
  confirmTransfer(t: ERegistryTransfer, secured_party_org_id: string, now: string): Promise<{ accepted: boolean; secured_party_removed_at: string; notification_id: string }>;
  releaseSecuredParty(min: string, secured_party_org_id: string, now: string): Promise<{ released_at: string; notification_id: string }>;
  secured_party(min: string): Promise<string | null>;
}
/** eRegistry (Release 16.25): Transfer of Control "is accepted or rejected in full"; processing "Removes any Secured Party … if the Transfer transaction included a Transfer of Control" (p. 33). */
export class FakeERegistry implements ERegistryPort {
  readonly securedParties = new Map<string, string | null>();
  readonly transfers: { t: ERegistryTransfer; confirmed_by: string; at: string }[] = [];
  async confirmTransfer(t: ERegistryTransfer, spOrg: string, now: string): Promise<{ accepted: boolean; secured_party_removed_at: string; notification_id: string }> {
    if (t.effective_date < etDate(now)) return { accepted: false, secured_party_removed_at: "", notification_id: "" };   // "cannot be retroactive" (p. 28)
    this.transfers.push({ t, confirmed_by: spOrg, at: now }); this.securedParties.set(t.min, null);
    return { accepted: true, secured_party_removed_at: now, notification_id: `ereg-${this.transfers.length}` };
  }
  async releaseSecuredParty(min: string, _spOrg: string, now: string): Promise<{ released_at: string; notification_id: string }> { this.securedParties.set(min, null); return { released_at: now, notification_id: `ereg-rel-${min}` }; }
  async secured_party(min: string): Promise<string | null> { return this.securedParties.get(min) ?? null; }
}

// ============================================================ event emitters (the timers' triggers and satisfiers)
export interface AdvanceKeys { readonly advance_id: string; readonly loan_id: string | null; readonly application_id: string; readonly facility_id: string; }
const keys = (k: AdvanceKeys): { loanId?: string; applicationId: string } => ({ ...(k.loan_id ? { loanId: k.loan_id } : {}), applicationId: k.application_id });
const base = (k: AdvanceKeys): Record<string, unknown> => ({ advance_id: k.advance_id, application_id: k.application_id, loan_id: k.loan_id, facility_id: k.facility_id, source: "origination" });
type Emit = (type: string, k: AdvanceKeys, payload: Record<string, unknown>, at?: string, actor?: Actor) => DomainEvent;
export const emitAdvance = (events: EventStore): Emit => (type, k, payload, at, actor = WAREHOUSE_AGENT) => events.append({ type, ...keys(k), actor, ...(at ? { occurredAt: at } : {}), payload: { ...base(k), ...payload } });
const facilityAgg = (facilityId: string) => ({ kind: "warehouse_facility", id: facilityId });
export const emitFacility = (events: EventStore, facilityId: string, type: string, payload: Record<string, unknown>, at?: string, actor: Actor = WAREHOUSE_AGENT): DomainEvent =>
  events.append({ type, aggregate: facilityAgg(facilityId), actor, ...(at ? { occurredAt: at } : {}), payload: { facility_id: facilityId, source: "origination", ...payload } });

export interface AdvanceRecord extends AdvanceKeys {
  readonly funding_id: string; readonly requested_at: string; readonly approved_at: string | null; readonly advance_date: PlainDate | null; readonly value_date: PlainDate | null;
  readonly note_form: NoteForm; readonly wet_reason: WetReason; readonly wet: boolean; readonly note_amount_cents: Cents; readonly net_disbursement_cents: Cents; readonly advance_cents: Cents; readonly partner_contribution_cents: Cents;
  readonly outstanding_principal_cents: Cents; readonly capitalized_interest_cents: Cents; readonly fees_outstanding_cents: Cents; readonly interest_accrued_cents: Cents;
  readonly index_rate_bps: number | null; readonly all_in_rate_bps: number | null; readonly dwell_stepup_active: boolean; readonly wet_overdue: boolean; readonly collateral_value_cents: Cents;
  readonly eligibility_snapshot: EligibilitySnapshot | null; readonly collateral_status: CollateralStatus; readonly custody_record_id: string | null; readonly bailee_letter_id: string | null;
  readonly interim_funder_designated_at: string | null; readonly secured_party_added_at: string | null; readonly secured_party_released_at: string | null;
  readonly aging_bucket: AgingBucket; readonly aged_days: number; readonly curtailment_due_cents: Cents; readonly repurchase_demanded_at: string | null; readonly kickout_at: string | null;
  readonly status: AdvanceStatus; readonly wire_out_id: string | null; readonly agent_decision_id: string | null; readonly repaid_at: string | null; readonly repaid_from: string | null;
  readonly note_date: PlainDate; readonly transaction_type: AdvanceRequest["transaction_type"]; readonly wet_dry: WetDry; readonly commitment_price: string; readonly commitment_id_fnma: string; readonly wire_verification_id: string; readonly property_state: string;
  readonly enote_registered_at: PlainDate | null; readonly wet_deadline_on: PlainDate | null; readonly interim_funder_due_on: PlainDate | null; readonly reasons: readonly string[];
}
export function newAdvanceRecord(r: AdvanceRequest): AdvanceRecord {
  return { advance_id: r.advance_id, loan_id: r.loan_id, application_id: r.application_id, facility_id: r.facility_id, funding_id: r.funding_id, requested_at: r.requested_at, approved_at: null, advance_date: null, value_date: null,
    note_form: r.note_form, wet_reason: wetReason(r), wet: wetReason(r) !== "none", note_amount_cents: r.note_amount_cents, net_disbursement_cents: r.net_disbursement_cents, advance_cents: 0n, partner_contribution_cents: 0n,
    outstanding_principal_cents: 0n, capitalized_interest_cents: 0n, fees_outstanding_cents: 0n, interest_accrued_cents: 0n, index_rate_bps: null, all_in_rate_bps: null, dwell_stepup_active: false, wet_overdue: false, collateral_value_cents: 0n,
    eligibility_snapshot: null, collateral_status: collateralStatusAtFunding(r), custody_record_id: null, bailee_letter_id: null, interim_funder_designated_at: null, secured_party_added_at: r.secured_party_added_at, secured_party_released_at: null,
    aging_bucket: "d0_30", aged_days: 0, curtailment_due_cents: 0n, repurchase_demanded_at: null, kickout_at: null, status: "requested", wire_out_id: null, agent_decision_id: null, repaid_at: null, repaid_from: null,
    note_date: r.note_date, transaction_type: r.transaction_type, wet_dry: r.wet_dry, commitment_price: r.commitment_price, commitment_id_fnma: r.commitment_id_fnma, wire_verification_id: r.wire_verification_id, property_state: r.property_state,
    enote_registered_at: r.enote_registered_at, wet_deadline_on: null, interim_funder_due_on: null, reasons: [] };
}
export const toOpenAdvance = (a: AdvanceRecord, extra: Partial<Pick<OpenAdvance, "state" | "arm" | "occupancy" | "units" | "tx_50a6" | "open_incurable_defect">> = {}): OpenAdvance => ({
  advance_id: a.advance_id, loan_id: a.loan_id, application_id: a.application_id, note_amount_cents: a.note_amount_cents, outstanding_principal_cents: a.outstanding_principal_cents, capitalized_interest_cents: a.capitalized_interest_cents,
  commitment_price: a.commitment_price, advance_date: a.advance_date ?? etDate(a.requested_at), note_form: a.note_form, wet: a.wet || a.collateral_status === "unsecured_wet", wet_deadline_on: a.wet_deadline_on, collateral_status: a.collateral_status,
  interim_funder_designated_at: a.interim_funder_designated_at, interim_funder_due_on: a.interim_funder_due_on, open_incurable_defect: extra.open_incurable_defect ?? false, status: a.status,
  state: extra.state ?? a.property_state, arm: extra.arm ?? false, occupancy: extra.occupancy ?? "primary", units: extra.units ?? 1, tx_50a6: extra.tx_50a6 ?? false });

/** `funding.authorized` (26.3) → `warehouse.advance.requested` (arms SM_WH_ADVANCE_APPROVAL_2BH on `requested_at`). */
export function requestAdvance(events: EventStore, r: AdvanceRequest): { record: AdvanceRecord; event: DomainEvent } {
  nonEmpty(r.advance_id, "advance_id"); nonEmpty(r.application_id, "application_id"); nonEmpty(r.funding_id, "funding_id"); nonEmpty(r.requested_at, "requested_at");
  const record = newAdvanceRecord(r);
  const event = emitAdvance(events)("warehouse.advance.requested", record, { funding_id: r.funding_id, requested_at: r.requested_at, note_form: r.note_form, closing_type: r.closing_type, wet_dry: r.wet_dry, note_amount_cents: String(r.note_amount_cents), net_disbursement_cents: String(r.net_disbursement_cents), wet_reason: record.wet_reason }, r.requested_at);
  return { record, event };
}
export interface AdvanceDecision { readonly outcome: "approved" | "rejected"; readonly reasons: readonly string[]; readonly advance_cents: Cents; readonly partner_contribution_cents: Cents; readonly wet: boolean; readonly wet_reason: WetReason; readonly availability_before_cents: Cents; readonly availability_after_cents: Cents; readonly wet_check: { wet_availability_cents: Cents; required_cents: Cents; pass: boolean }; readonly collateral_plan: CollateralStatus; readonly decided_at: string; readonly rationale: string; }
/** The `warehouse` agent's advance decision: every hard criterion, the facility and wet availabilities, and the structure/licensing guards; approves or rejects with reasons. */
export function decideAdvance(facility: FacilityTerms, r: AdvanceRequest, snapshot: EligibilitySnapshot, baseSnapshot: BorrowingBaseSnapshot, decidedAt: string): AdvanceDecision {
  assertFacilityForm(facility, { officer_and_counsel_record_id: null }); assertJurisdictionLicensed(facility, r.property_state);
  const amt = advanceAmount(facility, r.note_amount_cents, r.net_disbursement_cents);
  const wr = wetReason(r); const wet = wr !== "none";
  const reasons = [...snapshot.reasons];
  const collateralPending = collateralValue(facility, r.note_amount_cents, r.commitment_price);
  const availabilityBefore = baseSnapshot.availability_cents;
  const availabilityWithPending = (baseSnapshot.eligible_collateral_value_cents + collateralPending < facility.facility_limit_cents ? baseSnapshot.eligible_collateral_value_cents + collateralPending : facility.facility_limit_cents) - baseSnapshot.outstanding_cents;
  if (availabilityWithPending < amt.advance_cents) reasons.push("availability_exceeded");
  const wetCheck = { wet_availability_cents: baseSnapshot.wet_availability_cents, required_cents: wet ? amt.advance_cents : 0n, pass: !wet || baseSnapshot.wet_availability_cents >= amt.advance_cents };
  if (!wetCheck.pass) reasons.push("wet_sublimit_exceeded");
  if (facility.status !== "active" && !reasons.includes("facility_not_active")) reasons.push("facility_not_active");
  const outcome = reasons.length ? "rejected" : "approved";
  return { outcome, reasons, advance_cents: amt.advance_cents, partner_contribution_cents: amt.partner_contribution_cents, wet, wet_reason: wr, availability_before_cents: availabilityBefore, availability_after_cents: availabilityWithPending - (outcome === "approved" ? amt.advance_cents : 0n), wet_check: wetCheck, collateral_plan: collateralStatusAtFunding(r), decided_at: decidedAt,
    rationale: outcome === "approved" ? `every hard criterion passed; availability ${availabilityWithPending} ≥ ${amt.advance_cents}; wet ${wet ? `${baseSnapshot.wet_availability_cents} ≥ ${amt.advance_cents}` : "n/a"}${snapshot.soft_flags.length ? `; soft flags ${snapshot.soft_flags.join(", ")}` : ""}` : `rejected: ${reasons.join(", ")}` };
}
/** `warehouse.advance.approved{decision=approved}` / `warehouse.advance.rejected{decision=rejected, reasons}` — the `decision` field lets one pattern (`warehouse.advance.*{decision∈{approved, rejected}}`) satisfy the 2-business-hour SLA. */
export function recordAdvanceDecision(events: EventStore, a: AdvanceRecord, d: AdvanceDecision, snapshot: EligibilitySnapshot): { record: AdvanceRecord; event: DomainEvent } {
  if (a.status !== "requested") throw new RangeError(`advance ${a.advance_id} is ${a.status}, not requested`);
  const approved = d.outcome === "approved";
  const record: AdvanceRecord = { ...a, status: approved ? "approved" : "rejected", approved_at: approved ? d.decided_at : null, advance_cents: approved ? d.advance_cents : 0n, partner_contribution_cents: approved ? d.partner_contribution_cents : 0n, eligibility_snapshot: snapshot, wet: d.wet, wet_reason: d.wet_reason, reasons: d.reasons, collateral_value_cents: 0n };
  const event = emitAdvance(events)(approved ? "warehouse.advance.approved" : "warehouse.advance.rejected", a, { decision: d.outcome, reasons: [...d.reasons], advance_cents: String(d.advance_cents), partner_contribution_cents: String(d.partner_contribution_cents), wet: d.wet, wet_reason: d.wet_reason, approved_at: d.decided_at, availability_after_cents: String(d.availability_after_cents), soft_flags: [...snapshot.soft_flags] }, d.decided_at);
  return { record, event };
}
/** The outbound wire released by `funding_approver` → `warehouse.advance.funded` with the anchors every collateral and aging clock needs (T1: the wire is released only after funding_approver approval). */
export async function fundAdvance(events: EventStore, bank: WarehouseBankPort, facility: FacilityTerms, a: AdvanceRecord, approval: WireApproval | null, escrowState = false): Promise<{ record: AdvanceRecord; event: DomainEvent; wire_out_id: string; ledger: ReturnType<typeof advanceLedgerSets> | null }> {
  if (a.status !== "approved") throw new RangeError(`advance ${a.advance_id} is ${a.status}, not approved`);
  const vd = wireValueDate(a.approved_at ?? approval?.approved_at ?? new Date().toISOString());
  const wire = await bank.releaseWire({ advance_id: a.advance_id, value_date: vd.value_date, amount_cents: a.net_disbursement_cents, beneficiary_wire_verification_id: a.wire_verification_id, funding_account_ref: facility.funding_account_ref, idempotency_key: `${a.advance_id}:${vd.value_date}` }, approval);
  const advance_date = wire.value_date;
  const ifAnchor = interimFunderAnchor({ note_date: a.note_date, advance_date, transaction_type: a.transaction_type, escrow_state: escrowState });
  const record: AdvanceRecord = { ...a, status: "funded", advance_date, value_date: advance_date, wire_out_id: wire.wire_out_id, outstanding_principal_cents: a.advance_cents, wet_deadline_on: a.note_form === "paper" && a.collateral_status === "unsecured_wet" ? wetNoteDeadline(facility, advance_date) : null,
    interim_funder_due_on: a.note_form === "paper" ? interimFunderDeadline(ifAnchor) : null, collateral_value_cents: collateralValue(facility, a.note_amount_cents, a.commitment_price), fees_outstanding_cents: a.fees_outstanding_cents };
  const event = emitAdvance(events)("warehouse.advance.funded", a, { note_form: a.note_form, wet: a.wet, wet_reason: a.wet_reason, collateral_status: a.collateral_status, advance_date, value_date: advance_date, advance_cents: String(a.advance_cents), partner_contribution_cents: String(a.partner_contribution_cents), wire_out_id: wire.wire_out_id,
    funding_approver_approval_id: approval?.approval_id ?? null, note_date: a.note_date, interim_funder_anchor_date: ifAnchor, secured_party_anchor_date: securedPartyAnchor(advance_date, a.enote_registered_at), wet_deadline_on: record.wet_deadline_on, interim_funder_due_on: record.interim_funder_due_on }, approval?.approved_at);
  return { record, event, wire_out_id: wire.wire_out_id, ledger: a.loan_id ? advanceLedgerSets({ loan_id: a.loan_id, advance_id: a.advance_id, advance_date, advance_cents: a.advance_cents, partner_contribution_cents: a.partner_contribution_cents, funding_account_ref: facility.funding_account_ref, haircut_reserve_account_ref: facility.haircut_reserve_account_ref }) : null };
}
const statusChange = (events: EventStore, a: AdvanceRecord, from: CollateralStatus, to: CollateralStatus, why: string, at?: string): DomainEvent => emitAdvance(events)("warehouse.collateral.status_changed", a, { from, to, collateral_status: to, why }, at);
/** Custodian trust receipt → `warehouse.note.received` (satisfies SM_WH_WET_NOTE_DELIVERY_5BD) and `secured_possession` (9-313(c) possession through the bailee). */
export function recordTrustReceipt(events: EventStore, a: AdvanceRecord, r: { receipt_id: string; received_at: string; custody_record_id: string; bailee_letter_id: string | null }): { record: AdvanceRecord; events: DomainEvent[] } {
  nonEmpty(r.receipt_id, "receipt_id"); nonEmpty(r.received_at, "received_at");
  const record: AdvanceRecord = { ...a, collateral_status: "secured_possession", custody_record_id: r.custody_record_id, bailee_letter_id: r.bailee_letter_id ?? a.bailee_letter_id, wet_overdue: false };
  const e1 = emitAdvance(events)("warehouse.note.received", a, { receipt_id: r.receipt_id, received_at: r.received_at, custody_record_id: r.custody_record_id, bailee_letter_id: record.bailee_letter_id, collateral_status: "secured_possession", note_received_at: r.received_at }, r.received_at, { kind: "external", id: "custodian" });
  return { record, events: [e1, statusChange(events, a, a.collateral_status, "secured_possession", "custodian trust receipt", r.received_at)] };
}
/** eRegistry notification that the Controller added SM as Secured Party → `warehouse.secured_party.added` (satisfies SM_WH_ENOTE_SECURED_PARTY_1BD) and `secured_control`. */
export function recordSecuredPartyAdded(events: EventStore, a: AdvanceRecord, r: { min: string; secured_party_org_id: string; added_at: string; notification_id: string; reason: "add_secured_party" | "control_returned" }): { record: AdvanceRecord; events: DomainEvent[] } {
  if (r.secured_party_org_id !== SM_MERS_ORG_ID) throw new RangeError(`Secured Party ${r.secured_party_org_id} is not SM's Org ID ${SM_MERS_ORG_ID}`);
  const record: AdvanceRecord = { ...a, collateral_status: "secured_control", secured_party_added_at: r.added_at, wet: false, wet_reason: "none", wet_overdue: false, status: a.status === "transferred_pending_payment" ? "returned" : a.status };
  const e1 = emitAdvance(events)("warehouse.secured_party.added", a, { min: r.min, secured_party_org_id: r.secured_party_org_id, added_at: r.added_at, notification_id: r.notification_id, reason: r.reason, collateral_status: "secured_control" }, r.added_at, { kind: "external", id: "mers_eregistry" });
  return { record, events: [e1, statusChange(events, a, a.collateral_status, "secured_control", r.reason, r.added_at)] };
}
/** 26.4's `mers.min.registered` checked for SM's Interim Funder Org ID: designated → `warehouse.interim_funder.designated` (satisfies SM_WH_INTERIM_FUNDER_DESIGNATION_7); otherwise a `mers_mismatch` defect with the cure handed to `post-closing` and the partner's `signing_officer`. */
export function recordInterimFunderCheck(events: EventStore, a: AdvanceRecord, reg: { min: string; interim_funder_org_id: string | null; registered_at: string }): { record: AdvanceRecord; event: DomainEvent; designated: boolean; escalations: { kind: "signing_officer" | "sev2"; owner_role: string; payload: Record<string, unknown> }[] } {
  const v = verifyInterimFunder(reg);
  if (v.designated) {
    const record: AdvanceRecord = { ...a, interim_funder_designated_at: reg.registered_at };
    return { record, designated: true, escalations: [], event: emitAdvance(events)("warehouse.interim_funder.designated", a, { min: reg.min, interim_funder_org_id: reg.interim_funder_org_id, designated_at: reg.registered_at }, reg.registered_at, { kind: "external", id: "mers" }) };
  }
  const recorded_on = etDate(reg.registered_at);
  const event = emitAdvance(events)("warehouse.collateral.defect_recorded", a, { defect_id: `${a.advance_id}:mers_mismatch:${reg.min}`, source: "mers_mismatch", recorded_at: reg.registered_at, description: `MIN ${reg.min} registered with Interim Funder ${reg.interim_funder_org_id ?? "(none)"}, not SM ${SM_MERS_ORG_ID}`, cure_due_at: defectCureDue(recorded_on), cure_owner: "post-closing" }, reg.registered_at);
  const payload = { advance_id: a.advance_id, min: reg.min, reason: "interim_funder_missing", action: "MIN Update: add SM's Interim Funder Org ID", party: "partner", due_on: a.interim_funder_due_on };
  return { record: a, event, designated: false, escalations: [{ kind: "sev2", owner_role: "post-closing", payload: { ...payload, party: "sm", hand_off: "post-closing agent (26.4 MERS adapter)" } }, { kind: "signing_officer", owner_role: "signing_officer", payload }] };
}
/** SM confirms the partner's Transfer of Control and Location to Fannie Mae as Secured Party; the registry removes SM's Secured Party entry → `warehouse.secured_party.released{reason=transfer_of_control}`, `transferred_pending_payment` (Funding Agreement protection; still in the borrowing base). */
export async function confirmTransferOfControl(events: EventStore, registry: ERegistryPort, facility: FacilityTerms, a: AdvanceRecord, t: ERegistryTransfer, now: string): Promise<{ record: AdvanceRecord; events: DomainEvent[]; accepted: boolean; secured_party_released_at: string | null }> {
  if (a.note_form !== "enote") throw new RangeError("Transfer of Control applies to eNotes only");
  if (t.to_controller_org_id !== FANNIE_MAE_ORG_ID) throw new RangeError(`Transfer of Control to ${t.to_controller_org_id} is not to Fannie Mae ${FANNIE_MAE_ORG_ID}`);
  if (!facility.funding_agreement_fnma_executed_at) throw new GuardrailViolation("FUNDING_AGREEMENT_REQUIRED", "Fannie Mae eNote Transfer of Control and Location and Custodial Agreement (Funding Agreement) executed prior to delivery of eNotes", "no Funding Agreement on file");
  assertDeliverable(a.collateral_status);
  const res = await registry.confirmTransfer(t, facility.mers_org_id_sm, now);
  if (!res.accepted) return { record: a, events: [], accepted: false, secured_party_released_at: null };
  const record: AdvanceRecord = { ...a, collateral_status: "transferred_pending_payment", status: "transferred_pending_payment", secured_party_released_at: res.secured_party_removed_at };
  const e1 = emitAdvance(events)("warehouse.secured_party.released", a, { min: t.min, transfer_id: t.transfer_id, reason: "transfer_of_control", confirmed_by_org_id: facility.mers_org_id_sm, effective_date: t.effective_date, secured_party_released_at: res.secured_party_removed_at, registry_notification_id: res.notification_id, funding_agreement_reference: facility.funding_agreement_fnma_executed_at, collateral_status: "transferred_pending_payment" }, now);
  return { record, events: [e1, statusChange(events, a, a.collateral_status, "transferred_pending_payment", "Transfer of Control accepted; Funding Agreement governs until proceeds", now)], accepted: true, secured_party_released_at: res.secured_party_removed_at };
}
/** Fannie Mae declines and returns Control (Funding Agreement: "return control to the warehouse bank (or add them back … as the Secured Party)") → `secured_control` again and a `purchase_error` defect. */
export function recordControlReturned(events: EventStore, a: AdvanceRecord, r: { min: string; returned_at: string; notification_id: string; reason: string }): { record: AdvanceRecord; events: DomainEvent[] } {
  const sp = recordSecuredPartyAdded(events, a, { min: r.min, secured_party_org_id: SM_MERS_ORG_ID, added_at: r.returned_at, notification_id: r.notification_id, reason: "control_returned" });
  const d = recordDefect(events, sp.record, { defect_id: `${a.advance_id}:purchase_error:${r.notification_id}`, source: "purchase_error", recorded_at: r.returned_at, description: `Fannie Mae returned Control: ${r.reason}`, cure_owner: "secondary" });
  return { record: { ...d.record, status: "returned" }, events: [...sp.events, d.event] };
}

// ---- interest, capitalization, fees
export function recordAccrual(events: EventStore, a: AdvanceRecord, row: AccrualRow): { record: AdvanceRecord; event: DomainEvent } {
  const record: AdvanceRecord = { ...a, interest_accrued_cents: a.interest_accrued_cents + row.posted_cents, index_rate_bps: row.index_rate_bps, all_in_rate_bps: row.all_in_rate_bps };
  const event = emitAdvance(events)("warehouse.interest.accrued", a, { accrual_date: row.accrual_date, posted_cents: String(row.posted_cents), principal_basis_cents: String(row.principal_basis_cents), index_rate_bps: row.index_rate_bps, index_publication_date: row.index_publication_date, all_in_rate_bps: row.all_in_rate_bps, stepup_bps: row.stepup_bps, cumulative_interest_dollars: row.cumulative_interest_dollars, interest_accrued_cents: String(record.interest_accrued_cents) });
  return { record, event };
}
export function recordCapitalization(events: EventStore, a: AdvanceRecord, c: { on: PlainDate; month: string; capitalized_cents: Cents; treatment: FacilityTerms["interest_treatment"] }): { record: AdvanceRecord; event: DomainEvent } {
  const record: AdvanceRecord = { ...a, capitalized_interest_cents: a.capitalized_interest_cents + c.capitalized_cents };
  const event = emitAdvance(events)("warehouse.interest.capitalized", a, { capitalized_on: c.on, month: c.month, capitalized_cents: String(c.capitalized_cents), treatment: c.treatment, capitalized_interest_cents: String(record.capitalized_interest_cents) });
  return { record, event };
}
export function recordFee(events: EventStore, a: AdvanceRecord, f: { kind: FeeKind; amount_cents: Cents; on: PlainDate }): { record: AdvanceRecord; event: DomainEvent } {
  const record: AdvanceRecord = { ...a, fees_outstanding_cents: a.fees_outstanding_cents + f.amount_cents };
  const event = emitAdvance(events)("warehouse.fee.assessed", a, { kind: f.kind, amount_cents: String(f.amount_cents), assessed_on: f.on, fees_outstanding_cents: String(record.fees_outstanding_cents) });
  return { record, event };
}

// ---- aging, curtailments, margin calls, repurchase, kick-out
export function ageAdvance(events: EventStore, facility: FacilityTerms, a: AdvanceRecord, asOf: PlainDate): { record: AdvanceRecord; events: DomainEvent[]; aged_days: number; bucket: AgingBucket } {
  if (!a.advance_date) throw new RangeError(`advance ${a.advance_id} is not funded`);
  const aged_days = agedDays(a.advance_date, asOf); const bucket = agingBucket(aged_days);
  const out: DomainEvent[] = [];
  if (bucket !== a.aging_bucket) out.push(emitAdvance(events)("warehouse.aging.bucket_changed", a, { from: a.aging_bucket, to: bucket, aged_days, as_of: asOf }));
  const dwell = aged_days >= facility.aging_curtail_day + 1;
  const wo = a.note_form === "paper" && a.collateral_status === "unsecured_wet" ? wetOverdue(facility, a.advance_date, asOf, null) : null;
  return { record: { ...a, aged_days, aging_bucket: bucket, dwell_stepup_active: dwell, wet_overdue: wo?.overdue ?? a.wet_overdue }, events: out, aged_days, bucket };
}
export interface CurtailmentRow { readonly curtailment_id: string; readonly advance_id: string; readonly kind: CurtailmentKind; readonly due_on: PlainDate; readonly amount_cents: Cents; readonly paid_at: string | null; readonly wire_in_ref: string | null; readonly status: "due" | "paid" | "cancelled"; }
export function issueCurtailment(events: EventStore, a: AdvanceRecord, c: { kind: CurtailmentKind; due_on: PlainDate; amount_cents: Cents; issued_at: string }): { record: AdvanceRecord; row: CurtailmentRow; event: DomainEvent } {
  if (c.amount_cents <= 0n) throw new RangeError("curtailment amount must be > 0");
  const row: CurtailmentRow = { curtailment_id: `${a.advance_id}:${c.kind}:${c.due_on}`, advance_id: a.advance_id, kind: c.kind, due_on: c.due_on, amount_cents: c.amount_cents, paid_at: null, wire_in_ref: null, status: "due" };
  const event = emitAdvance(events)("warehouse.curtailment.due", a, { curtailment_id: row.curtailment_id, kind: c.kind, due_on: c.due_on, amount_cents: String(c.amount_cents), issued_at: c.issued_at }, c.issued_at);
  return { record: { ...a, curtailment_due_cents: a.curtailment_due_cents + c.amount_cents }, row, event };
}
export function payCurtailment(events: EventStore, a: AdvanceRecord, row: CurtailmentRow, p: { paid_at: string; wire_in_ref: string; amount_cents: Cents }): { record: AdvanceRecord; row: CurtailmentRow; event: DomainEvent } {
  if (row.status !== "due") throw new RangeError(`curtailment ${row.curtailment_id} is ${row.status}`);
  if (p.amount_cents !== row.amount_cents) throw new RangeError(`curtailment ${row.curtailment_id} expects ${row.amount_cents} cents, received ${p.amount_cents}`);
  const paid: CurtailmentRow = { ...row, paid_at: p.paid_at, wire_in_ref: p.wire_in_ref, status: "paid" };
  const event = emitAdvance(events)("warehouse.curtailment.paid", a, { curtailment_id: row.curtailment_id, kind: row.kind, paid_at: p.paid_at, wire_in_ref: p.wire_in_ref, amount_cents: String(p.amount_cents), paid_on: etDate(p.paid_at) }, p.paid_at);
  return { record: { ...a, outstanding_principal_cents: a.outstanding_principal_cents - p.amount_cents, curtailment_due_cents: a.curtailment_due_cents - p.amount_cents }, row: paid, event };
}
export function issueMarginCall(events: EventStore, a: AdvanceRecord, m: { amount_cents: Cents; collateral_value_cents: Cents; issued_at: string }): { record: AdvanceRecord; row: CurtailmentRow; events: DomainEvent[] } {
  if (m.amount_cents <= 0n) throw new RangeError("margin call amount must be > 0");
  const due_on = addBusinessDays(etDate(m.issued_at), 1, servicer);
  const e1 = emitAdvance(events)("warehouse.margin_call.issued", a, { amount_cents: String(m.amount_cents), collateral_value_cents: String(m.collateral_value_cents), outstanding_cents: String(a.outstanding_principal_cents + a.capitalized_interest_cents), issued_at: m.issued_at, due_on }, m.issued_at);
  const c = issueCurtailment(events, { ...a, collateral_value_cents: m.collateral_value_cents }, { kind: "margin_call", due_on, amount_cents: m.amount_cents, issued_at: m.issued_at });
  return { record: c.record, row: c.row, events: [e1, c.event] };
}
export interface DefectRow { readonly defect_id: string; readonly advance_id: string; readonly source: DefectSource; readonly recorded_at: string; readonly description: string; readonly cure_due_at: PlainDate; readonly cured_at: string | null; readonly outcome: "cured" | "repurchased" | "substituted" | "written_off" | null; readonly cure_owner: string; }
export function recordDefect(events: EventStore, a: AdvanceRecord, d: { defect_id: string; source: DefectSource; recorded_at: string; description: string; cure_owner: "secondary" | "post-closing" | "compliance-tester" | "title-closing" }): { record: AdvanceRecord; row: DefectRow; event: DomainEvent } {
  nonEmpty(d.defect_id, "defect_id"); nonEmpty(d.description, "description");
  const row: DefectRow = { defect_id: d.defect_id, advance_id: a.advance_id, source: d.source, recorded_at: d.recorded_at, description: d.description, cure_due_at: defectCureDue(etDate(d.recorded_at)), cured_at: null, outcome: null, cure_owner: d.cure_owner };
  const event = emitAdvance(events)("warehouse.collateral.defect_recorded", a, { defect_id: row.defect_id, source: row.source, recorded_at: row.recorded_at, description: row.description, cure_due_at: row.cure_due_at, cure_owner: row.cure_owner }, d.recorded_at);
  return { record: a, row, event };
}
export function cureDefect(events: EventStore, a: AdvanceRecord, row: DefectRow, c: { cured_at: string; outcome: "cured" | "substituted"; evidence_document_id: string }): { row: DefectRow; event: DomainEvent } {
  if (row.cured_at) throw new RangeError(`defect ${row.defect_id} already cured ${row.cured_at}`);
  const cured: DefectRow = { ...row, cured_at: c.cured_at, outcome: c.outcome };
  return { row: cured, event: emitAdvance(events)("warehouse.collateral.defect_cured", a, { defect_id: row.defect_id, cured_at: c.cured_at, outcome: c.outcome, evidence_document_id: c.evidence_document_id, late: etDate(c.cured_at) > row.cure_due_at }, c.cured_at) };
}
export function demandRepurchase(events: EventStore, facility: FacilityTerms, a: AdvanceRecord, d: { demanded_at: string; payoff: PayoffStatement; officer_ack_id: string | null; reason: "aged_60" | "defect_uncured" | "wet_overdue" }): { record: AdvanceRecord; event: DomainEvent; payment_due_on: PlainDate } {
  const ack = assertOfficerAck({ officer_ack_id: d.officer_ack_id }, "repurchase demand");
  const demand_on = etDate(d.demanded_at); const payment_due_on = addBusinessDays(demand_on, 5, servicer);
  const event = emitAdvance(events)("warehouse.repurchase.demanded", a, { demanded_at: d.demanded_at, demand_on, payment_due_on, reason: d.reason, payoff_cents: String(d.payoff.total_cents), payoff: { principal: String(d.payoff.outstanding_principal_cents), capitalized_interest: String(d.payoff.capitalized_interest_cents), accrued_interest: String(d.payoff.accrued_not_capitalized_cents), fees: String(d.payoff.fees_cents), through: d.payoff.through }, officer_ack_id: ack, repurchase_day: facility.repurchase_day }, d.demanded_at);
  return { record: { ...a, repurchase_demanded_at: d.demanded_at }, event, payment_due_on };
}
export function completeRepurchase(events: EventStore, a: AdvanceRecord, r: { paid_at: string; wire_in_ref: string; amount_cents: Cents; payoff_cents: Cents }): { record: AdvanceRecord; events: DomainEvent[] } {
  if (r.amount_cents < r.payoff_cents) throw new RangeError(`repurchase wire ${r.amount_cents} is below the payoff ${r.payoff_cents}`);
  const e1 = emitAdvance(events)("warehouse.repurchase.completed", a, { paid_at: r.paid_at, wire_in_ref: r.wire_in_ref, amount_cents: String(r.amount_cents), repaid_from: "partner_repurchase" }, r.paid_at);
  const e2 = emitAdvance(events)("warehouse.advance.repaid", a, { repaid_at: etDate(r.paid_at), repaid_from: "partner_repurchase", bank_matched: true, note_form: a.note_form, amount_cents: String(r.amount_cents) }, r.paid_at);
  return { record: { ...a, status: "repurchased", repaid_at: r.paid_at, repaid_from: "partner_repurchase", outstanding_principal_cents: 0n, capitalized_interest_cents: 0n, fees_outstanding_cents: 0n }, events: [e1, e2] };
}
export function issueKickout(events: EventStore, a: AdvanceRecord, k: { issued_at: string; reason: "aged_90" | "incurable_defect"; officer_ack_id: string | null }): { record: AdvanceRecord; events: DomainEvent[]; facility_suspended: true } {
  const ack = assertOfficerAck({ officer_ack_id: k.officer_ack_id }, "kick-out");
  const e1 = emitAdvance(events)("warehouse.kickout.issued", a, { issued_at: k.issued_at, reason: k.reason, officer_ack_id: ack, removed_from_borrowing_base: true, remedies: "per LSA; officer{sm} decision; no automated liquidation" }, k.issued_at);
  const e2 = emitFacility(events, a.facility_id, "warehouse.facility.suspended", { reason: "kickout", advance_id: a.advance_id, suspended_at: k.issued_at, new_advances: false }, k.issued_at);
  return { record: { ...a, status: "kicked_out", kickout_at: k.issued_at }, events: [e1, e2], facility_suspended: true };
}
/** 25.3's `rescission.exercised` after disbursement unwinds the advance: the partner refunds, the advance is repaid `repaid_from=rescission_unwind` and the collateral is released to the partner. */
export function unwindOnRescission(events: EventStore, a: AdvanceRecord, r: { exercise_id: string; exercised_at: string }): { record: AdvanceRecord; events: DomainEvent[] } {
  if (a.status !== "funded" && a.status !== "delivered") throw new RangeError(`advance ${a.advance_id} is ${a.status}; only a funded advance is unwound by rescission`);
  const e1 = emitAdvance(events)("warehouse.advance.repaid", a, { repaid_at: etDate(r.exercised_at), repaid_from: "rescission_unwind", bank_matched: false, note_form: a.note_form, rescission_exercise_id: r.exercise_id }, r.exercised_at);
  const e2 = statusChange(events, a, a.collateral_status, "released", `rescission exercised ${r.exercise_id}`, r.exercised_at);
  return { record: { ...a, status: "repaid", repaid_at: r.exercised_at, repaid_from: "rescission_unwind", collateral_status: "released", outstanding_principal_cents: 0n }, events: [e1, e2] };
}

// ---- facility, borrowing base, reports, covenants, shipments
export function requestFacilityActivation(events: EventStore, f: FacilityTerms, at: string): DomainEvent { return emitFacility(events, f.facility_id, "warehouse.facility.activation_requested", { partner_id: f.partner_id, agreement_kind: f.agreement_kind, legal_form: f.legal_form, requested_at: at }, at); }
export function activateFacility(events: EventStore, f: FacilityTerms, r: { ucc1_filed_on: PlainDate; ucc1_acknowledged: boolean; lien_search_clean: boolean; activated_at: string }): { facility: FacilityTerms; event: DomainEvent; ucc1_lapse_on: PlainDate; continuation_window_from: PlainDate } {
  if (!r.ucc1_acknowledged || !r.lien_search_clean) throw new GuardrailViolation("SM_WH_UCC1_FILING_GATE", "27.1 timers: UCC-1 filed and acknowledged; lien search clean — else no advances", "the facility activates only on an acknowledged UCC-1 and a clean lien search");
  assertFacilityForm(f, { officer_and_counsel_record_id: null });
  const ucc1_lapse_on = addMonths(r.ucc1_filed_on, 60); const continuation_window_from = addMonths(r.ucc1_filed_on, 54);
  const facility: FacilityTerms = { ...f, status: "active", ucc1_filed_on: r.ucc1_filed_on, ucc1_lapse_on };
  return { facility, ucc1_lapse_on, continuation_window_from, event: emitFacility(events, f.facility_id, "warehouse.facility.activated", { ucc1_filed_on: r.ucc1_filed_on, ucc1_lapse_on, continuation_window_from, activated_at: r.activated_at, legal_form: f.legal_form }, r.activated_at) };
}
export const fileUccContinuation = (events: EventStore, f: FacilityTerms, r: { filed_on: PlainDate; filing_number: string }): DomainEvent => emitFacility(events, f.facility_id, "warehouse.facility.ucc_continuation_filed", { filed_on: r.filed_on, filing_number: r.filing_number, new_lapse_on: addMonths(f.ucc1_lapse_on ?? r.filed_on, 60) }, `${r.filed_on}T17:00:00.000Z`);
export const suspendFacility = (events: EventStore, facilityId: string, reason: string, at: string): DomainEvent => emitFacility(events, facilityId, "warehouse.facility.suspended", { reason, suspended_at: at, new_advances: false }, at);
export const resumeFacility = (events: EventStore, facilityId: string, reason: string, at: string): DomainEvent => emitFacility(events, facilityId, "warehouse.facility.resumed", { reason, resumed_at: at }, at);
export function recordBorrowingBase(events: EventStore, snap: BorrowingBaseSnapshot, at: string): { event: DomainEvent; snapshot_id: string } {
  const snapshot_id = `${snap.facility_id}:${snap.as_of}`;
  const ineligible: Record<string, string> = {}; for (const [k, v] of Object.entries(snap.ineligible_cents)) ineligible[k] = String(v);
  return { snapshot_id, event: emitFacility(events, snap.facility_id, "warehouse.borrowing_base.computed", { snapshot_id, as_of: snap.as_of, outstanding_cents: String(snap.outstanding_cents), eligible_collateral_value_cents: String(snap.eligible_collateral_value_cents), availability_cents: String(snap.availability_cents), wet_outstanding_cents: String(snap.wet_outstanding_cents), wet_availability_cents: String(snap.wet_availability_cents), ineligible_cents: ineligible, margin_call_cents: String(snap.margin_call_cents), ineligible_advances: snap.rows.filter((r) => !r.eligible).map((r) => ({ advance_id: r.advance_id, reason: r.ineligible_reason })) }, at) };
}
export interface DailyReport { readonly report_id: string; readonly facility_id: string; readonly as_of: PlainDate; readonly position: { outstanding_cents: string; availability_cents: string; wet_outstanding_cents: string; wet_availability_cents: string }; readonly advances: readonly Record<string, unknown>[]; readonly curtailments_due: readonly Record<string, unknown>[]; readonly defects: readonly Record<string, unknown>[]; readonly covenant_status: string; readonly index_history: readonly SofrPoint[]; readonly document_id: string; readonly data_export_id: string; readonly channel: "partner_portal" | "sftp" | "api"; }
export function renderDailyReport(snap: BorrowingBaseSnapshot, advances: readonly AdvanceRecord[], curtailments: readonly CurtailmentRow[], defects: readonly DefectRow[], covenantStatus: string, sofr: readonly SofrPoint[], expectedPurchaseOn: (a: AdvanceRecord) => PlainDate | null): DailyReport {
  const report_id = `${snap.facility_id}:${snap.as_of}:daily`;
  return { report_id, facility_id: snap.facility_id, as_of: snap.as_of, position: { outstanding_cents: String(snap.outstanding_cents), availability_cents: String(snap.availability_cents), wet_outstanding_cents: String(snap.wet_outstanding_cents), wet_availability_cents: String(snap.wet_availability_cents) },
    advances: advances.filter((a) => a.advance_date).map((a) => ({ advance_id: a.advance_id, advance_date: a.advance_date, aged_days: agedDays(a.advance_date!, snap.as_of), bucket: agingBucket(agedDays(a.advance_date!, snap.as_of)), collateral_status: a.collateral_status, accrued_interest_cents: String(a.interest_accrued_cents), all_in_rate_bps: a.all_in_rate_bps, expected_purchase_on: expectedPurchaseOn(a), exceptions: snap.rows.find((r) => r.advance_id === a.advance_id)?.ineligible_reason ?? null })),
    curtailments_due: curtailments.filter((c) => c.status === "due").map((c) => ({ curtailment_id: c.curtailment_id, kind: c.kind, due_on: c.due_on, amount_cents: String(c.amount_cents) })),
    defects: defects.filter((d) => !d.cured_at).map((d) => ({ defect_id: d.defect_id, source: d.source, cure_due_at: d.cure_due_at, cure_owner: d.cure_owner })),
    covenant_status: covenantStatus, index_history: sofr.slice(-10), document_id: `doc:${report_id}.pdf`, data_export_id: `export:${report_id}.json`, channel: "partner_portal" };
}
export const issueDailyReport = (events: EventStore, r: DailyReport, at: string): DomainEvent => emitFacility(events, r.facility_id, "warehouse.daily_report.issued", { report_id: r.report_id, as_of: r.as_of, document_id: r.document_id, data_export_id: r.data_export_id, channel: r.channel, delivered_at: at, position: r.position }, at);
export const endCovenantPeriod = (events: EventStore, facilityId: string, p: { period_end: PlainDate; frequency: CovenantFrequency }): DomainEvent => emitFacility(events, facilityId, "warehouse.covenant.period_ended", { period_end: p.period_end, frequency: p.frequency, package_due_on: covenantPackageDeadline(p.period_end, p.frequency) }, `${p.period_end}T23:59:00.000Z`);
export interface CovenantTestRow { readonly test_id: string; readonly facility_id: string; readonly covenant_code: string; readonly period_end: PlainDate; readonly reported_value: string; readonly threshold: string; readonly result: "pass" | "fail" | "waived"; readonly evidence_document_id: string; readonly certified_by: string; readonly waiver_id: string | null; }
/** The partner's package tests every covenant of the period's frequency; the last row carries `period_complete=true` (satisfies the covenant clock); a failure or a late package breaches. */
export function recordCovenantTests(events: EventStore, f: FacilityTerms, p: { period_end: PlainDate; frequency: CovenantFrequency; received_at: string; reported: Readonly<Record<string, string>>; evidence_document_id: string; certified_by: string }): { rows: CovenantTestRow[]; events: DomainEvent[]; late: boolean; failed: string[]; breach: DomainEvent | null } {
  const terms = f.covenants.filter((c) => c.test_frequency === p.frequency || p.frequency === "annual");
  const rows: CovenantTestRow[] = terms.map((t) => ({ test_id: `${f.facility_id}:${t.code}:${p.period_end}`, facility_id: f.facility_id, covenant_code: t.code, period_end: p.period_end, reported_value: p.reported[t.code] ?? "", threshold: t.threshold, result: p.reported[t.code] === undefined ? "fail" : testCovenant(t, p.reported[t.code]!), evidence_document_id: p.evidence_document_id, certified_by: p.certified_by, waiver_id: null }));
  const late = etDate(p.received_at) > covenantPackageDeadline(p.period_end, p.frequency);
  const evs = rows.map((r, i) => emitFacility(events, f.facility_id, "warehouse.covenant.tested", { test_id: r.test_id, covenant_code: r.covenant_code, period_end: r.period_end, result: r.result, reported_value: r.reported_value, threshold: r.threshold, period_complete: i === rows.length - 1, late }, p.received_at));
  const failed = rows.filter((r) => r.result === "fail").map((r) => r.covenant_code);
  const breach = late || failed.length ? breachCovenant(events, f.facility_id, { kind: late ? "reporting" : "financial", period_end: p.period_end, covenant_codes: failed, at: p.received_at }) : null;
  return { rows, events: evs, late, failed, breach };
}
/** `warehouse.covenant.breached{reporting}` (a late package) or `{kind=financial}` → the facility is `suspended` for new advances unless waived by `officer{sm}` within 5 business days; existing advances accrue and repay normally. */
export function breachCovenant(events: EventStore, facilityId: string, b: { kind: "reporting" | "financial"; period_end: PlainDate; covenant_codes: readonly string[]; at: string }): DomainEvent {
  const e = emitFacility(events, facilityId, "warehouse.covenant.breached", { kind: b.kind, reporting: b.kind === "reporting", period_end: b.period_end, covenant_codes: [...b.covenant_codes], breached_at: b.at, facility_status: "suspended", waiver_window_ends_on: addBusinessDays(etDate(b.at), 5, servicer) }, b.at);
  suspendFacility(events, facilityId, `covenant breach (${b.kind})`, b.at);
  return e;
}
export const requestShipment = (events: EventStore, a: AdvanceRecord, s: { shipment_id: string; custodian_party_id: string; requested_at: string }): DomainEvent => emitAdvance(events)("warehouse.note.shipment_requested", a, { shipment_id: s.shipment_id, custodian_party_id: s.custodian_party_id, requested_at: s.requested_at, bailee_letter_id: a.bailee_letter_id }, s.requested_at);
export const releaseShipment = (events: EventStore, a: AdvanceRecord, s: { shipment_id: string; bailee_letter_id: string; released_at: string; tracking: string }): DomainEvent => emitAdvance(events)("warehouse.note.shipment_released", a, { shipment_id: s.shipment_id, bailee_letter_id: s.bailee_letter_id, released_at: s.released_at, tracking: s.tracking }, s.released_at);
export const baileeLetterEvent = (events: EventStore, facilityId: string, type: "warehouse.bailee_letter.issued" | "warehouse.bailee_letter.acknowledged" | "warehouse.bailee_letter.corrected" | "warehouse.bailee_letter.released", p: Record<string, unknown>, at: string, actor: Actor = WAREHOUSE_AGENT): DomainEvent => emitFacility(events, facilityId, type, p, at, actor);

/** The LL-2026-04 decision record for an advance (AI agent design: `{advance_id, eligibility_snapshot, availability_before/after, wet_check, advance_cents, partner_contribution_cents, collateral_plan, rationale, policy_version, rule_set_versions, model/prompt versions, outcome, reviewer}`). */
export function advanceDecisionRecord(a: AdvanceRecord, d: AdvanceDecision, snapshot: EligibilitySnapshot, llm: { model_version: string | null; prompt_version: string | null }, reviewer: string | null): Record<string, unknown> {
  return { advance_id: a.advance_id, eligibility_snapshot: snapshot, availability_before_cents: String(d.availability_before_cents), availability_after_cents: String(d.availability_after_cents), wet_check: { ...d.wet_check, wet_availability_cents: String(d.wet_check.wet_availability_cents), required_cents: String(d.wet_check.required_cents) }, advance_cents: String(d.advance_cents), partner_contribution_cents: String(d.partner_contribution_cents), collateral_plan: d.collateral_plan, rationale: d.rationale, policy_version: POLICY_VERSION, rule_set_versions: RULE_SETS, model_version: llm.model_version, prompt_version: llm.prompt_version, outcome: d.outcome, reviewer, agent: WAREHOUSE_AGENT.id };
}
