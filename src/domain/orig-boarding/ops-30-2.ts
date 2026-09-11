/**
 * §30.2 New-origination boarding at funding — the seam where the origination aggregate (`applications`, 0057) becomes
 * a servicing `loans` row. One small function per rule / T-id, plus a thin `OriginationBoardingService` that runs 1.1's
 * pipeline in origination mode: the same `boardingMachine` (src/domain/boarding/machine.ts) drives staged → validated |
 * exception → boarded, the DQ gate has 1.1's `Rule` shape with `OB-*`/`OW-*` codes written to `boarding_validations`
 * (`application_id` + `loan_id`, `source='origination'`), the opening ledger follows 1.6's balanced-set pattern against a
 * per-loan `origination_funding_clearing` account, and the first statement cycle is 7.1's `statement.cycle.opened`.
 * Nothing here copies 1.1: `isValidMin`/`minOrgId`/`luhnCheckDigit` (min.ts), `levelPayment`/`monthlyInterest`/
 * `PI_TOLERANCE_CENTS`, `BOARDING_AGENT` and the machine are imported.
 *
 * Events (every one carries BOTH `applicationId` and `loanId` once the loan row exists — the hand-off rule of the
 * architecture baseline addendum; the timer engine arms origination rows only on origination context):
 *   loan.funded{application_id, funding_date, disbursement_date, funded_at, …}   — 26.3 owns; appended here only as the
 *       in-memory entry point's fallback when the caller hands the payload without an event id (`ingestFunded`)
 *   loan.staged{source=origination, application_id, loan_id, servicing_loan_number}           [arms FNMA_B2_1_5_FIRST_PAYMENT_2M gate]
 *   loan.validated | loan.boarding_exception.raised{severity=hard, money_field, raised_at} | loan.boarding_exception.resolved
 *   loan.boarded{application_id, loan_id, boarded_at, first_payment_date, funding_date, source=origination, warnings}
 *   loan.boarding.warnings_open{boarded_at, warnings} → loan.boarding_warning.resolved{rule_code} → loan.boarding.warnings_cleared
 *   ledger.opening_posted, consents.boarded, documents.indexed, timers.seeded, boarding.defect.routed{owner_processes}
 *   notice.sent{template=NTC_SM_FIRST_PAYMENT_LETTER, carries=[NTC_FCRA_1681S2A7_B1 (, NTC_ESIGN_7001C_DISCLOSURE)]}
 *   statement.cycle.opened{first_cycle=true, cycle_due_date}   (7.1's event)
 *   mers.min.registered{min, status=active}   (26.4's event, recorded here from the MERS acknowledgment that clears OW-004)
 *   loan.active{loan_id, application_id, active_at}
 */
import { randomUUID, createHash } from "node:crypto";
import { type PlainDate, addDays, addMonths, endOfMonth, daysBetween, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, type CalendarSet, defaultCalendars } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { type Cents, levelPayment, monthlyInterest, ratePercent, absDiff, centsToDecimal, formatCents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { Ledger, EntrySet, LineInput, AccountRef, LoanAccount, CustodialAccount } from "../../kernel/ledger/ledger.ts";
import type { TimerEngine, TimerInstance, Breach } from "../../kernel/timers/engine.ts";
import { Machine } from "../../kernel/fsm/machine.ts";
import { boardingMachine, type BoardingStatus } from "../boarding/machine.ts";
import { BOARDING_AGENT } from "../boarding/service.ts";
import { PI_TOLERANCE_CENTS } from "../boarding/rules.ts";
import { isValidMin, minOrgId, luhnCheckDigit } from "../boarding/min.ts";
import type { RuleResult, Severity } from "../boarding/types.ts";
import { cycle as statementCycle } from "../notices/statement.ts";
import { MODEL_B1 } from "../../notices/authored/section08.ts";
import type { LoanCashState } from "../cashiering/types.ts";
import type { EscalationService } from "../../app/escalations.ts";
import type { NoticeService } from "../../notices/service.ts";
import type { Recipient } from "../../notices/channel.ts";
import type { Consent as EsignConsent } from "../notices/esign.ts";

export const RULE_SET_VERSION_30_2 = "boarding.orig.dq.v1";
/** OB-003 tolerance: $0.01 (1.1 HF-005). */
export const PI_TOLERANCE_CENTS_30_2 = PI_TOLERANCE_CENTS;
export const MAPPING_VERSION_30_2 = "lbds.mismo36.origination.v1";
export const FIRST_PAYMENT_LETTER = "NTC_SM_FIRST_PAYMENT_LETTER";
export const B1_TEMPLATE = "NTC_FCRA_1681S2A7_B1";
export const ESIGN_INVITATION = "NTC_ESIGN_7001C_DISCLOSURE";
/** 7.4 servicing record classes an origination E-SIGN disclosure must list to cover servicing (rule 7). */
export const SERVICING_CONSENT_CLASSES = ["periodic_statements", "escrow_statements", "regx_correspondence", "arm_notices", "privacy_notices", "lossmit_notices", "early_intervention_notices", "insurance_notices", "pmi_notices", "payoff_statements", "general_correspondence"] as const;
export const ORIGINATION_CONSENT_CLASSES = ["origination_disclosures", "origination_esign_signatures"] as const;
/** Guardrail: money fields come only from the signed note / CD data hashes — the agent may never edit them. */
export const ORIG_MONEY_FIELDS = ["amount_cents", "note_rate_pct", "pi_cents", "initial_escrow_deposit_cents", "monthly_escrow_cents", "prepaid_interest_cents", "buydown_funds_cents", "holdback_escrow_cents", "late_charge_pct"] as const;
export const FAIR_LENDING_PATH = "PARTY/ROLES/ROLE/BORROWER/GOVERNMENT_MONITORING";
export const FIRST_STATEMENT_LEAD_DAYS = 15;
export const ACTIVE_GATE_BUSINESS_DAYS = 5;
export const LETTER_TARGET_BUSINESS_DAYS = 3;
export const SERVICING_FILE_COMPILE_LIMIT_MS = 5 * 60 * 1000;

// ───────────────────────────── snapshot of the origination aggregate at funding ─────────────────────────────
export interface OrigBorrower {
  readonly party_id: string; readonly legal_name: string; readonly tin: string | null; readonly dob: PlainDate | null;
  readonly phone?: string | null; readonly email?: string | null; readonly mailing_address: string | null;
  readonly language_preference?: string | null; readonly acp_enrolled?: boolean; readonly role?: "borrower" | "coborrower";
  /** 21.1 `applicant_demographics` (restricted). "information not provided" → `collected_via='not_provided'`; never inferred. */
  readonly demographics: { readonly race: readonly string[] | "not_provided"; readonly ethnicity: readonly string[] | "not_provided"; readonly sex: string | "not_provided"; readonly age: number | null; readonly preferred_language: string | null; readonly collected_via: "self_reported" | "not_provided" };
}
export interface OrigConsent {
  readonly id: string; readonly party_id: string; readonly kind: "esign" | "tcpa_voice" | "tcpa_sms" | "ach";
  readonly disclosure_version?: string; readonly servicing_group_elected?: boolean; readonly demonstration_passed?: boolean;
  readonly demonstration_channel?: "portal" | "pdf" | "voice"; readonly captured_via: "portal" | "ai_chat_link" | "ai_voice_link" | "voice" | "paper";
  readonly captured_at: string; readonly evidence_document_id?: string | null;
}
export interface OrigDocument { readonly id: string; readonly kind: string; readonly sha256: string; readonly custody: "platform" | "custodian" | "evault" | "recorder"; readonly recorded?: boolean; }
export interface OriginationSnapshot {
  readonly application_id: string; readonly partner_id: string; readonly partner_name: string; readonly partner_mers_org_id: string;
  readonly loan_purpose: "purchase" | "refinance"; readonly rescindable: boolean; readonly rescission_expires_at: string | null;
  readonly note: { readonly document_id: string; readonly data_hash: string; readonly note_date: PlainDate; readonly amount_cents: Cents; readonly note_rate_pct: string; readonly term_months: number; readonly first_payment_date: PlainDate; readonly maturity_date: PlainDate; readonly late_charge_pct: string; readonly late_charge_grace_days: number; readonly amortization: "fixed" | "arm"; readonly arm?: { index?: string | null; margin_bps?: number | null; initial_cap_bps?: number | null; periodic_cap_bps?: number | null; lifetime_cap_bps?: number | null; lookback_days?: number | null; first_change_date?: PlainDate | null; rounding?: string | null } | null; readonly buydown_schedule?: readonly { period: number; subsidy_cents: Cents }[] | null; readonly partner_nmlsr_id: string | null; readonly mlo_nmlsr_id: string | null; readonly security_instrument_version: string };
  /** `closing_documents.data_hash` of the signed note (OB-002 compares the mapped terms' hash to it). */
  readonly closing: { readonly consummation_date: PlainDate; readonly note_terms_hash: string; readonly security_instrument_document_id: string | null };
  readonly final_cd: { readonly document_id: string; readonly pi_cents: Cents; readonly monthly_escrow_cents: Cents; readonly initial_escrow_deposit_cents: Cents; readonly prepaid_interest_cents: Cents; readonly prepaid_interest_days: number; readonly compliance_tests_passed: boolean };
  readonly escrow_analysis: { readonly source: "origination"; readonly type: "initial"; readonly required_start_balance_cents: Cents; readonly cushion_cents: Cents; readonly monthly_escrow_cents: Cents; readonly lines: readonly { line_type: string; annual_amount_cents: Cents; monthly_cents: Cents }[]; readonly status: "active"; readonly hpml_escrow_min_cancel_date?: PlainDate | null } | null;
  readonly hpml: boolean; readonly qm_type: string; readonly ltv_pct: string;
  readonly mi: { readonly certificate_number: string | null; readonly status: string; readonly coverage_pct: string; readonly premium_plan: string; readonly monthly_premium_cents: Cents; readonly hpa_disclosure_kind: string | null } | null;
  readonly hazard: { readonly verified: boolean; readonly mortgagee_clause_partner_isaoa_co_sm: boolean; readonly expires_on: PlainDate };
  readonly flood: { readonly determination_present: boolean; readonly lol_purchased: boolean; readonly lol_contract_linked: boolean; readonly sfha: boolean; readonly policy_verified: boolean };
  readonly min: { readonly value: string | null; readonly registration: "active" | "pending" | "pre_closing" };
  readonly custody: { readonly kind: "paper" | "enote"; readonly custodian?: string | null; readonly status?: string | null; readonly enote_registered_at?: string | null; readonly controller?: string | null };
  readonly warehouse_advance_id: string | null;
  readonly borrowers: readonly OrigBorrower[];
  readonly consents: readonly OrigConsent[];
  /** 21.1 `consent_disclosure_versions`: categories listed and providers named per version. */
  readonly disclosure_versions: Record<string, { readonly categories: readonly string[]; readonly providers: readonly string[]; readonly delivery_form: "portal_pdf" | "other" }>;
  readonly property: { readonly address_line1: string | null; readonly city: string | null; readonly state: string | null; readonly postal_code: string | null; readonly county: string | null; readonly apn: string | null; readonly property_type: string; readonly units: number; readonly occupancy: string; readonly flood_zone: string | null; readonly sfha: boolean; readonly appraised_value_cents: Cents; readonly original_value_cents: Cents };
  readonly documents: readonly OrigDocument[];
  readonly trailing: { readonly recorded_security_instrument_received: boolean; readonly final_title_policy_received: boolean };
  readonly tax_service_parcel_verified: boolean;
  readonly initial_escrow_statement_delivered: boolean;
  readonly ach_autopay_elected: boolean;
}
/** 26.3's `loan.funded` payload (the fields 30.2 reads). */
export interface LoanFundedPayload {
  readonly application_id: string; readonly funded_at: string; readonly funding_date: PlainDate; readonly disbursement_date: PlainDate;
  readonly wire_id: string | null; readonly funded_amount_cents: Cents; readonly per_diem_cents: Cents; readonly prepaid_interest_cents: Cents;
  readonly interest_credit: boolean; readonly rescission_expires_at: string | null;
  /** The id of 26.3's event when it is already on the store; absent → `ingestFunded` appends the fallback event. */
  readonly event_id?: string | null;
}
export interface OrigExternal {
  licensed(state: string): boolean;
  onPlatform(kind: "servicing_loan_number" | "min", value: string): boolean;
  mers(min: string): { status: "Active" | "Pending" | "Inactive"; org_id: string } | undefined;
}

// ───────────────────────────── identifiers (rule 4) ─────────────────────────────
/** `loans.servicing_loan_number`: 10 digits = 9-digit sequence + Mod-10 check digit (same Luhn as the MIN; OB-001). Exposed to 29.3 as the Lender Loan Number. */
export function servicingLoanNumber(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence <= 0 || sequence > 999_999_999) throw new RangeError("servicing loan number sequence must be 1..999999999");
  const body = String(sequence).padStart(9, "0");
  return body + String(luhnCheckDigit(body));
}
export function isValidServicingLoanNumber(n: string): boolean { return /^\d{10}$/.test(n) && luhnCheckDigit(n.slice(0, 9)) === Number(n[9]); }
/** 29.3's ULDD projection of the identifier: the Lender Loan Number is the servicing loan number so Fannie Mae's "servicer's unique identifier" equals SM's from purchase (30.1 rule 6). */
export function ulddLenderLoanNumber(loan: { servicing_loan_number: string }): { path: string; LoanIdentifierType: "SellerLoan"; LoanIdentifier: string } {
  if (!isValidServicingLoanNumber(loan.servicing_loan_number)) throw new RangeError("servicing_loan_number must be allocated (10 digits, valid check digit) before the ULDD export");
  return { path: "LOAN/LOAN_IDENTIFIERS/LOAN_IDENTIFIER[LoanIdentifierType=SellerLoan]/LoanIdentifier", LoanIdentifierType: "SellerLoan", LoanIdentifier: loan.servicing_loan_number };
}
/** 30.1's `fnma_establishment_checks` identifier check: Fannie Mae's recorded servicer loan identifier equals the servicing loan number → no LAR 81 (servicer loan number change) is needed. */
export function fnmaEstablishmentIdentifierCheck(i: { servicing_loan_number: string; fnma_recorded_servicer_loan_identifier: string | null; fnma_loan_number: string | null }): { check: "servicer_loan_identifier"; result: "pass" | "fail"; lar_81_required: boolean; fnma_loan_number: string | null } {
  const match = i.fnma_recorded_servicer_loan_identifier === i.servicing_loan_number;
  return { check: "servicer_loan_identifier", result: match ? "pass" : "fail", lar_81_required: !match, fnma_loan_number: i.fnma_loan_number };
}

// ───────────────────────────── money (rule 3 OB-003/OB-004) ─────────────────────────────
/** 26.3's `365_rounded_per_diem` convention: per diem = round_half_up(amount × rate / 365) to the cent, then × days. */
export function perDiem365Rounded(amountCents: Cents, noteRatePct: string): Cents {
  return centsToDecimal(amountCents).mul(ratePercent(noteRatePct)).div(Decimal.fromInt(365)).toCents("HALF_UP");
}
/** `interest_paid_through_date` = the day before the first accrual month = end of the disbursement month (fixture 2026-11-30). */
export function interestPaidThroughDate(disbursement: PlainDate): PlainDate { return endOfMonth(disbursement); }
export interface PrepaidInterest { readonly days: number; readonly per_diem_cents: Cents; readonly prepaid_interest_cents: Cents; readonly unrounded_product_cents: Cents; readonly interest_paid_through_date: PlainDate; }
/** Prepaid interest on the CD covers disbursement → interest_paid_through_date (fixture Nov 12–30, 2026 = 19 days × $93.97 = $1,785.43; the unrounded product $1,785.48 is not used). */
export function prepaidInterest(amountCents: Cents, noteRatePct: string, disbursement: PlainDate): PrepaidInterest {
  const ipt = interestPaidThroughDate(disbursement);
  const days = daysBetween(disbursement, ipt) + 1;
  const perDiem = perDiem365Rounded(amountCents, noteRatePct);
  const unrounded = centsToDecimal(amountCents).mul(ratePercent(noteRatePct)).div(Decimal.fromInt(365)).mul(Decimal.fromInt(days)).toCents("HALF_UP");
  return { days, per_diem_cents: perDiem, prepaid_interest_cents: perDiem * BigInt(days), unrounded_product_cents: unrounded, interest_paid_through_date: ipt };
}
/**
 * OB-003: P&I recomputation from the signed note at decimal precision (`r = note_rate/12`, `P&I = amount × r / (1 − (1+r)^−n)`),
 * tolerance $0.01 against the CD figure. The tolerance is measured on the unrounded recomputation (fixture 3,402.619…):
 * a CD P&I of $3,402.62 is 0.0006 away (pass) and $3,402.63 is 0.0104 away (fail — T2). 1.1's HF-005 compares the
 * cent-rounded figure to a transferor tape within ±1 cent; for an origination the CD was drawn from the same note, so
 * the rounded figure must match (`recomputed_cents` is `levelPayment`'s HALF_UP cents).
 */
export function recomputePi(note: { amount_cents: Cents; note_rate_pct: string; term_months: number }, cdPiCents: Cents): { recomputed_cents: Cents; recomputed_unrounded: string; cd_pi_cents: Cents; diff_cents: Cents; within_tolerance: boolean } {
  const recomputed = levelPayment(note.amount_cents, ratePercent(note.note_rate_pct), note.term_months);
  const r = ratePercent(note.note_rate_pct).div(Decimal.fromInt(12));
  const growth = Decimal.ONE.add(r).pow(note.term_months);
  const unrounded = centsToDecimal(note.amount_cents).mul(r).mul(growth).div(growth.sub(Decimal.ONE));
  const gap = unrounded.sub(centsToDecimal(cdPiCents));
  const within = (gap.cmp(Decimal.ZERO) < 0 ? Decimal.ZERO.sub(gap) : gap).cmp(centsToDecimal(PI_TOLERANCE_CENTS)) <= 0;
  return { recomputed_cents: recomputed, recomputed_unrounded: unrounded.toFixed(6), cd_pi_cents: cdPiCents, diff_cents: absDiff(recomputed, cdPiCents), within_tolerance: within };
}
/** First installment split (30/360): December interest 560,000 × 6.125% ÷ 12 = $2,858.33, principal $544.29, UPB after payment 1 $559,455.71. */
export function firstInstallmentSplit(note: { amount_cents: Cents; note_rate_pct: string }, piCents: Cents): { interest_cents: Cents; principal_cents: Cents; upb_after_cents: Cents } {
  const interest = monthlyInterest(note.amount_cents, ratePercent(note.note_rate_pct));
  return { interest_cents: interest, principal_cents: piCents - interest, upb_after_cents: note.amount_cents - (piCents - interest) };
}
/** OB-006 / C2-2-01: disbursement + 1 day ≤ first_payment_date ≤ disbursement + 2 months (day clamped to month end). */
export function firstPaymentWindow(disbursement: PlainDate, firstPayment: PlainDate): { earliest: PlainDate; latest: PlainDate; ok: boolean } {
  const earliest = addDays(disbursement, 1), latest = addMonths(disbursement, 2);
  return { earliest, latest, ok: firstPayment >= earliest && firstPayment <= latest };
}
/** OB-018 / guardrail: a rescindable loan funds only after `rescission_expires_at`. */
export function rescissionClear(rescindable: boolean, rescissionExpiresAt: string | null, fundedAt: string): boolean {
  if (!rescindable) return true;
  if (!rescissionExpiresAt) return false;
  return Date.parse(fundedAt) > Date.parse(rescissionExpiresAt);
}

// ───────────────────────────── mapping (rule 1) ─────────────────────────────
export interface StagingRow { readonly source: "origination"; readonly canonical_path: string; readonly raw_value: unknown; readonly canonical_value: unknown; readonly source_document_id: string | null; readonly mapping_rule_id: string; }
export interface MappedLoan {
  readonly loans: { id: string; origination_application_id: string; partner_id: string; servicing_loan_number: string; investor: "partner_warehouse" | "fnma"; owner_party_id: string; warehouse_advance_id: string | null; boarding_source: "origination"; note_date: PlainDate; consummation_date: PlainDate; disbursement_date: PlainDate; first_payment_date: PlainDate; maturity_date: PlainDate; interest_paid_through_date: PlainDate; original_loan_amount_cents: Cents; rescission_extended_until: PlainDate | null; mlo_of_record_nmlsr_id: string | null; partner_nmlsr_id: string | null; default_status_at_boarding: false; fdcpa_debt_collector_flag: false; credit_reporting_status: "active"; min: string | null; fnma_loan_number: string | null };
  readonly loan_terms: { version: 1; note_rate: string; pi_cents: Cents; original_term_months: number; amortization_type: "fixed" | "arm"; arm: OriginationSnapshot["note"]["arm"] | null; late_charge_pct: string; late_charge_grace_days: number; late_charge_basis: "pi"; interest_calc_method: "30_360"; payment_frequency: "monthly"; escrow_payment_cents: Cents; mi_premium_cents: Cents; buydown_schedule: readonly { period: number; subsidy_cents: Cents }[] | null; prepayment_penalty: false; security_instrument_version: string; hpml_flag: boolean; qm_type: string; remittance_type: null; source_document_id: string };
  readonly borrowers: readonly { party_id: string; legal_name: string; tin: string | null; dob: PlainDate | null; phone: string | null; email: string | null; mailing_address: string | null; language_preference: string | null; acp_enrolled: boolean; role: "borrower" | "coborrower" }[];
  readonly borrower_fair_lending: readonly { party_id: string; race: readonly string[] | null; ethnicity: readonly string[] | null; sex: string | null; age: number | null; preferred_language: string | null; source: "application"; collected_via: "self_reported" | "not_provided" }[];
  readonly properties: OriginationSnapshot["property"];
  readonly staging: readonly StagingRow[];
  readonly mapping_version: string;
  readonly snapshot_hash: string;
}
/** Rule 1 guardrail (T7): a mapping of a fair-lending, consent or TCPA field may only carry the applicant's own statement — inference is refused before anything is written. */
export function mapFieldGuard(i: { canonical_path: string; derivation?: string | null }): { ok: true } | { ok: false; code: "INFERRED_DEMOGRAPHICS" | "INFERRED_CONSENT"; reason: string } {
  const d = (i.derivation ?? "self_reported").toLowerCase();
  const own = d === "self_reported" || d === "not_provided" || d === "source_document";
  if (i.canonical_path.startsWith(FAIR_LENDING_PATH) && !own) return { ok: false, code: "INFERRED_DEMOGRAPHICS", reason: `${i.canonical_path}: demographics are copied from applicant_demographics (F-1-11) or recorded as not_provided — never derived (${d}; HMDA Appendix B forbids inference)` };
  if (/CONSENT|TCPA/i.test(i.canonical_path) && !own) return { ok: false, code: "INFERRED_CONSENT", reason: `${i.canonical_path}: consents and TCPA authority are never inferred (7001(c)(6); 20.2)` };
  return { ok: true };
}
const fl = (v: readonly string[] | "not_provided"): readonly string[] | null => (v === "not_provided" ? null : v);
export function snapshotHash(s: OriginationSnapshot): string {
  return createHash("sha256").update(JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).digest("hex");
}
/** Rule 1: origination → LBDS/MISMO 3.6 paths → platform targets, every row with its `source_document_id`. */
export function mapOrigination(s: OriginationSnapshot, funded: LoanFundedPayload, ids: { loan_id: string; servicing_loan_number: string }): MappedLoan {
  const n = s.note; const noteDoc = n.document_id; const cdDoc = s.final_cd.document_id;
  const row = (canonical_path: string, raw: unknown, canonical: unknown, doc: string | null, rule: string): StagingRow => ({ source: "origination", canonical_path, raw_value: raw, canonical_value: canonical, source_document_id: doc, mapping_rule_id: rule });
  const staging: StagingRow[] = [
    row("LOAN/CLOSING_INFORMATION/CLOSING_INFORMATION_DETAIL/DisbursementDate", funded.disbursement_date, funded.disbursement_date, null, "M-01"),
    row("LOAN/CLOSING_INFORMATION/CLOSING_INFORMATION_DETAIL/ClosingDate", s.closing.consummation_date, s.closing.consummation_date, null, "M-02"),
    row("LOAN/TERMS_OF_LOAN/NoteDate", n.note_date, n.note_date, noteDoc, "M-03"), row("LOAN/TERMS_OF_LOAN/NoteAmount", n.amount_cents.toString(), n.amount_cents.toString(), noteDoc, "M-03"),
    row("LOAN/TERMS_OF_LOAN/NoteRatePercent", n.note_rate_pct, n.note_rate_pct, noteDoc, "M-03"), row("LOAN/TERMS_OF_LOAN/LoanMaturityDate", n.maturity_date, n.maturity_date, noteDoc, "M-03"),
    row("LOAN/PAYMENT/PAYMENT_RULE/ScheduledFirstPaymentDate", n.first_payment_date, n.first_payment_date, noteDoc, "M-03"), row("LOAN/PAYMENT/PAYMENT_RULE/InitialPrincipalAndInterestPaymentAmount", s.final_cd.pi_cents.toString(), s.final_cd.pi_cents.toString(), cdDoc, "M-03"),
    row("LOAN/AMORTIZATION/AMORTIZATION_RULE/LoanAmortizationPeriodCount", n.term_months, n.term_months, noteDoc, "M-03"), row("LOAN/AMORTIZATION/AMORTIZATION_RULE/LoanAmortizationType", n.amortization, n.amortization === "arm" ? "AdjustableRate" : "Fixed", noteDoc, "M-03"),
    row("LOAN/LATE_CHARGE/LATE_CHARGE_RULE/LateChargeRatePercent", n.late_charge_pct, n.late_charge_pct, noteDoc, "M-04"), row("LOAN/LATE_CHARGE/LATE_CHARGE_RULE/LateChargeGracePeriodDaysCount", n.late_charge_grace_days, n.late_charge_grace_days, noteDoc, "M-04"),
    row("LOAN/ESCROW/ESCROW_DETAIL/InitialEscrowDepositAmount", s.final_cd.initial_escrow_deposit_cents.toString(), s.final_cd.initial_escrow_deposit_cents.toString(), cdDoc, "M-06"),
    row("LOAN/CLOSING_INFORMATION/PREPAID_ITEMS/PREPAID_ITEM[PrepaidItemType=PrepaidInterest]/PrepaidItemPaymentAmount", s.final_cd.prepaid_interest_cents.toString(), s.final_cd.prepaid_interest_cents.toString(), cdDoc, "M-06"),
    row("LOAN/LOAN_IDENTIFIERS/LOAN_IDENTIFIER[LoanIdentifierType=MERS_MIN]/LoanIdentifier", s.min.value, s.min.value, null, "M-15"),
    row("LOAN/LOAN_IDENTIFIERS/LOAN_IDENTIFIER[LoanIdentifierType=SellerLoan]/LoanIdentifier", ids.servicing_loan_number, ids.servicing_loan_number, null, "M-16"),
    row("PARTY/ROLES/ROLE/LOAN_ORIGINATOR/LICENSE/LICENSE_DETAIL/NMLSRIdentifier", n.mlo_nmlsr_id, n.mlo_nmlsr_id, noteDoc, "M-17"),
    row("LOAN/LOAN_DETAIL/HigherPricedMortgageLoanIndicator", s.hpml, s.hpml, null, "M-14"),
    ...s.borrowers.flatMap((b, i) => [row(`DEAL/PARTIES/PARTY[${i + 1}]/INDIVIDUAL/NAME/FullName`, b.legal_name, b.legal_name, null, "M-08"),
      row(`DEAL/PARTIES/PARTY[${i + 1}]/ROLES/ROLE/BORROWER/GOVERNMENT_MONITORING/collected_via`, b.demographics.collected_via, b.demographics.collected_via, null, "M-09"),
      row(`DEAL/PARTIES/PARTY[${i + 1}]/ROLES/ROLE/BORROWER/BORROWER_DETAIL/LanguagePreference`, b.language_preference ?? null, b.language_preference ?? null, null, "M-09")]),
    row("COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/ADDRESS/StateCode", s.property.state, s.property.state, null, "M-10"),
  ];
  return {
    loans: { id: ids.loan_id, origination_application_id: s.application_id, partner_id: s.partner_id, servicing_loan_number: ids.servicing_loan_number, investor: "partner_warehouse", owner_party_id: s.partner_id, warehouse_advance_id: s.warehouse_advance_id, boarding_source: "origination",
      note_date: n.note_date, consummation_date: s.closing.consummation_date, disbursement_date: funded.disbursement_date, first_payment_date: n.first_payment_date, maturity_date: n.maturity_date, interest_paid_through_date: interestPaidThroughDate(funded.disbursement_date),
      original_loan_amount_cents: n.amount_cents, rescission_extended_until: null, mlo_of_record_nmlsr_id: n.mlo_nmlsr_id, partner_nmlsr_id: n.partner_nmlsr_id, default_status_at_boarding: false, fdcpa_debt_collector_flag: false, credit_reporting_status: "active", min: s.min.value, fnma_loan_number: null },
    loan_terms: { version: 1, note_rate: n.note_rate_pct, pi_cents: s.final_cd.pi_cents, original_term_months: n.term_months, amortization_type: n.amortization, arm: n.arm ?? null, late_charge_pct: n.late_charge_pct, late_charge_grace_days: n.late_charge_grace_days, late_charge_basis: "pi", interest_calc_method: "30_360", payment_frequency: "monthly",
      escrow_payment_cents: s.final_cd.monthly_escrow_cents, mi_premium_cents: s.mi?.monthly_premium_cents ?? 0n, buydown_schedule: n.buydown_schedule ?? null, prepayment_penalty: false, security_instrument_version: n.security_instrument_version, hpml_flag: s.hpml, qm_type: s.qm_type, remittance_type: null, source_document_id: noteDoc },
    borrowers: s.borrowers.map((b, i) => ({ party_id: b.party_id, legal_name: b.legal_name, tin: b.tin, dob: b.dob, phone: b.phone ?? null, email: b.email ?? null, mailing_address: b.mailing_address ?? s.property.address_line1, language_preference: b.language_preference ?? null, acp_enrolled: b.acp_enrolled ?? false, role: b.role ?? (i === 0 ? "borrower" : "coborrower") })),
    borrower_fair_lending: s.borrowers.map((b) => ({ party_id: b.party_id, race: fl(b.demographics.race), ethnicity: fl(b.demographics.ethnicity), sex: b.demographics.sex === "not_provided" ? null : b.demographics.sex, age: b.demographics.age, preferred_language: b.demographics.preferred_language, source: "application", collected_via: b.demographics.collected_via })),
    properties: s.property, staging, mapping_version: MAPPING_VERSION_30_2, snapshot_hash: snapshotHash(s),
  };
}
/** OB-002's comparator: the data hash of the mapped note terms, computed the way 26.1 hashes the rendered note (`closing_documents.data_hash`). */
export function noteTermsHash(t: { amount_cents: Cents; note_rate_pct: string; term_months: number; first_payment_date: PlainDate; maturity_date: PlainDate; late_charge_pct: string; late_charge_grace_days: number }): string {
  return createHash("sha256").update([t.amount_cents.toString(), t.note_rate_pct, t.term_months, t.first_payment_date, t.maturity_date, t.late_charge_pct, t.late_charge_grace_days].join("|")).digest("hex");
}

// ───────────────────────────── DQ gate (rule 2): OB-001…OB-022 hard, OW-001…OW-012 warnings ─────────────────────────────
export interface OrigRuleInput { readonly s: OriginationSnapshot; readonly m: MappedLoan; readonly funded: LoanFundedPayload; readonly ext: OrigExternal; }
export interface OrigRule { readonly code: string; readonly severity: Severity; readonly money_field: boolean; readonly title: string; readonly owner_process: string | null; readonly check: (i: OrigRuleInput) => Omit<RuleResult, "code" | "severity" | "money_field">; }
const pass = () => ({ result: "pass" as const });
const fail = (message: string, expected?: unknown, actual?: unknown) => ({ result: "fail" as const, message, expected, actual });
const missing = (v: unknown) => v === null || v === undefined || v === "";
const H = (code: string, title: string, money_field: boolean, owner_process: string | null, check: OrigRule["check"]): OrigRule => ({ code, severity: "hard", money_field, title, owner_process, check });
const W = (code: string, title: string, check: OrigRule["check"]): OrigRule => ({ code, severity: "warning", money_field: false, title, owner_process: null, check });

export const OB_RULES: readonly OrigRule[] = [
  H("OB-001", "servicing_loan_number allocated, unique, check digit valid", false, null, ({ m, ext }) => { const n = m.loans.servicing_loan_number; if (!isValidServicingLoanNumber(n)) return fail("servicing loan number missing or check digit invalid", "10 digits + Mod-10", n); if (ext.onPlatform("servicing_loan_number", n)) return fail("duplicate servicing loan number (HF-017 semantics)", "unique", n); return pass(); }),
  H("OB-002", "note terms match the signed note (data hash = closing_documents.data_hash)", true, "26.1", ({ s, m }) => { const h = noteTermsHash({ amount_cents: m.loans.original_loan_amount_cents, note_rate_pct: m.loan_terms.note_rate, term_months: m.loan_terms.original_term_months, first_payment_date: m.loans.first_payment_date, maturity_date: m.loans.maturity_date, late_charge_pct: m.loan_terms.late_charge_pct, late_charge_grace_days: m.loan_terms.late_charge_grace_days }); return h === s.closing.note_terms_hash ? pass() : fail("mapped note terms ≠ signed note data hash", s.closing.note_terms_hash, h); }),
  H("OB-003", "P&I recomputation within $0.01 of the CD", true, "25.2", ({ s, m }) => { const r = recomputePi({ amount_cents: m.loans.original_loan_amount_cents, note_rate_pct: m.loan_terms.note_rate, term_months: m.loan_terms.original_term_months }, s.final_cd.pi_cents); return r.within_tolerance ? pass() : fail("P&I recomputation off by > $0.01", { recomputed_cents: r.recomputed_cents.toString() }, { cd_pi_cents: r.cd_pi_cents.toString() }); }),
  H("OB-004", "30/360 monthly; interest_paid_through_date and CD prepaid interest cover disbursement → that date", true, "25.2", ({ s, m, funded }) => { const p = prepaidInterest(m.loans.original_loan_amount_cents, m.loan_terms.note_rate, funded.disbursement_date); if (m.loan_terms.interest_calc_method !== "30_360") return fail("interest method must be 30/360", "30_360", m.loan_terms.interest_calc_method); if (funded.interest_credit) return pass(); if (s.final_cd.prepaid_interest_cents !== p.prepaid_interest_cents || s.final_cd.prepaid_interest_days !== p.days) return fail("CD prepaid interest ≠ cent-rounded per diem × days", { days: p.days, cents: p.prepaid_interest_cents.toString() }, { days: s.final_cd.prepaid_interest_days, cents: s.final_cd.prepaid_interest_cents.toString() }); return pass(); }),
  H("OB-005", "ARM fields present and consistent with the rider", false, "26.1", ({ m }) => { if (m.loan_terms.amortization_type !== "arm") return pass(); const a = m.loan_terms.arm ?? {}; const gaps = (["index", "margin_bps", "initial_cap_bps", "periodic_cap_bps", "lifetime_cap_bps", "lookback_days", "first_change_date", "rounding"] as const).filter((k) => missing(a[k])); return gaps.length ? fail(`ARM missing ${gaps.join(", ")}`, "all ARM fields", gaps) : pass(); }),
  H("OB-006", "first_payment_date within (disbursement + 1 day, disbursement + 2 months] (C2-2-01)", false, "26.3", ({ m, funded }) => { const w = firstPaymentWindow(funded.disbursement_date, m.loans.first_payment_date); return w.ok ? pass() : fail("first payment date outside C2-2-01 window", `${w.earliest}..${w.latest}`, m.loans.first_payment_date); }),
  H("OB-007", "escrow flag consistent: lines sum to the CD monthly escrow; initial deposit = CD (g)(3) = 30.3 analysis", true, "30.3", ({ s }) => { const a = s.escrow_analysis; if (!a) return s.final_cd.monthly_escrow_cents === 0n ? pass() : fail("CD escrows but no escrow account/analysis", ">0 lines", null); const sum = a.lines.reduce((t, l) => t + l.monthly_cents, 0n); if (sum !== s.final_cd.monthly_escrow_cents) return fail("escrow lines ≠ CD monthly escrow payment", s.final_cd.monthly_escrow_cents.toString(), sum.toString()); const deposit = a.required_start_balance_cents + a.cushion_cents; if (deposit !== s.final_cd.initial_escrow_deposit_cents) return fail("initial deposit ≠ CD (g)(3) total", s.final_cd.initial_escrow_deposit_cents.toString(), deposit.toString()); return pass(); }),
  H("OB-008", "MIN present, 18 digits, Mod-10 valid, Org ID = partner's (registration may be pending → OW-004)", false, "26.4", ({ s, ext }) => { const min = s.min.value; if (!min) return fail("MIN missing", "18-digit MIN", null); if (!isValidMin(min)) return fail("MIN fails Mod-10 check digit", "valid MIN", min); const rec = ext.mers(min); const org = rec?.org_id ?? minOrgId(min); if (org !== s.partner_mers_org_id || minOrgId(min) !== s.partner_mers_org_id) return fail("MERS Org ID ≠ partner", s.partner_mers_org_id, org); return pass(); }),
  H("OB-009", "MI when LTV > 80%: certificate active/activation_requested with number, coverage, plan and HPA disclosure", false, "24.6", ({ s }) => { if (Decimal.parse(s.ltv_pct).cmp(Decimal.parse("80")) <= 0) return pass(); const mi = s.mi; if (!mi || !["active", "activation_requested"].includes(mi.status) || missing(mi.certificate_number) || missing(mi.coverage_pct) || missing(mi.premium_plan) || missing(mi.hpa_disclosure_kind)) return fail("MI certificate/HPA disclosure incomplete for LTV > 80%", "active certificate + HPA disclosure", mi); return pass(); }),
  H("OB-010", "hazard verified with mortgagee clause partner ISAOA c/o SM; flood determination with LOL; flood policy when SFHA", false, "24.5", ({ s }) => { if (!s.hazard.verified || !s.hazard.mortgagee_clause_partner_isaoa_co_sm) return fail("hazard policy not verified with the partner ISAOA c/o SM mortgagee clause"); if (!s.flood.determination_present || !s.flood.lol_purchased) return fail("flood determination / life-of-loan purchase missing"); if (s.flood.sfha && !s.flood.policy_verified) return fail("SFHA property without a verified flood policy"); return pass(); }),
  H("OB-011", "consents: E-SIGN rows for e-delivery recipients evaluated per rule 7; TCPA never inferred; ACH if autopay", false, "20.3", ({ s }) => { const bad = s.consents.filter((c) => c.kind === "esign" && (c.captured_via === "voice" || c.demonstration_channel === "voice")); if (bad.length) return fail("an oral E-SIGN consent is not consent (7001(c)(6))", "portal/ai_chat_link/ai_voice_link capture", bad.map((c) => c.id)); if (s.ach_autopay_elected && !s.consents.some((c) => c.kind === "ach")) return fail("autopay elected without an ACH authorization"); return pass(); }),
  H("OB-012", "NMLSR IDs (partner and mlo_of_record) present and equal to the note/security instrument", false, "26.1", ({ s, m }) => (missing(m.loans.partner_nmlsr_id) || missing(m.loans.mlo_of_record_nmlsr_id) || m.loans.partner_nmlsr_id !== s.note.partner_nmlsr_id || m.loans.mlo_of_record_nmlsr_id !== s.note.mlo_nmlsr_id) ? fail("NMLSR IDs missing or ≠ note (§1026.36(g))", { partner: s.note.partner_nmlsr_id, mlo: s.note.mlo_nmlsr_id }, { partner: m.loans.partner_nmlsr_id, mlo: m.loans.mlo_of_record_nmlsr_id }) : pass()),
  H("OB-013", "borrower_fair_lending row per borrower with collected_via ∈ {self_reported, not_provided} (F-1-11; never inferred)", false, "21.1", ({ m }) => { const rows = new Map(m.borrower_fair_lending.map((r) => [r.party_id, r])); const bad = m.borrowers.filter((b) => { const r = rows.get(b.party_id); return !r || (r.collected_via !== "self_reported" && r.collected_via !== "not_provided"); }); return bad.length ? fail("fair-lending row missing or not self-reported/not_provided", "self_reported|not_provided", bad.map((b) => b.party_id)) : pass(); }),
  H("OB-014", "borrower legal name/TIN/DOB present; property address/state present", false, "21.1", ({ m }) => { const b = m.borrowers.filter((x) => missing(x.legal_name) || missing(x.tin) || missing(x.dob)).map((x) => x.party_id); const p = (["address_line1", "state"] as const).filter((k) => missing(m.properties[k])); return b.length || p.length ? fail(`missing ${[...b.map((x) => `borrower ${x}`), ...p].join(", ")}`, "name/TIN/DOB + address/state", { borrowers: b, property: p }) : pass(); }),
  H("OB-015", "custody: paper shipped/received with custodian, or eNote registered with Controller = partner", false, "26.4", ({ s }) => { const c = s.custody; if (c.kind === "enote") return (!missing(c.enote_registered_at) && c.controller === s.partner_id) ? pass() : fail("eNote not registered or Controller ≠ partner", s.partner_id, c); return (!missing(c.custodian) && ["shipped", "received"].includes(c.status ?? "")) ? pass() : fail("no custody record (custodian + shipped/received)", "custodian+status", c); }),
  H("OB-016", "security instrument copy (unrecorded) in documents (§1024.38(c)(2)(ii))", false, "26.4", ({ s }) => s.documents.some((d) => d.kind === "security_instrument") ? pass() : fail("security instrument copy missing from documents")),
  H("OB-017", "final CD present and 25.1's compliance tests passed", false, "25.2", ({ s }) => (s.documents.some((d) => d.kind === "closing_disclosure_final") && s.final_cd.compliance_tests_passed) ? pass() : fail("final CD missing or compliance tests not passed")),
  H("OB-018", "rescindable loans funded after rescission_expires_at", false, "26.3", ({ s, funded }) => rescissionClear(s.rescindable, s.rescission_expires_at ?? funded.rescission_expires_at, funded.funded_at) ? pass() : fail("loan.funded before rescission_expires_at", s.rescission_expires_at ?? funded.rescission_expires_at, funded.funded_at)),
  H("OB-019", "no deferred/forborne balances; UPB = original loan amount", true, "26.3", ({ m, funded }) => funded.funded_amount_cents === m.loans.original_loan_amount_cents ? pass() : fail("funded amount ≠ original loan amount", m.loans.original_loan_amount_cents.toString(), funded.funded_amount_cents.toString())),
  H("OB-020", "property state covered by an SM servicer license", false, "31.1", ({ m, ext }) => (m.properties.state && !ext.licensed(m.properties.state)) ? fail("property state not covered by a servicer license", "licensed", m.properties.state) : pass()),
  H("OB-021", "HPML: escrow account active with hpml_escrow_min_cancel_date", false, "30.3", ({ s }) => !s.hpml ? pass() : (s.escrow_analysis?.status === "active" && !missing(s.escrow_analysis.hpml_escrow_min_cancel_date)) ? pass() : fail("HPML loan without an active escrow account / min cancel date")),
  H("OB-022", "investor = partner_warehouse and warehouse_advance_id present at boarding; inverted after purchase", false, "27.1", ({ m }) => (m.loans.investor === "partner_warehouse" && !missing(m.loans.warehouse_advance_id) && m.loans.fnma_loan_number === null) ? pass() : m.loans.investor === "fnma" && !missing(m.loans.fnma_loan_number) ? pass() : fail("investor fields inconsistent for the loan's ownership", "partner_warehouse + warehouse_advance_id (or fnma + fnma_loan_number after purchase)", { investor: m.loans.investor, warehouse_advance_id: m.loans.warehouse_advance_id, fnma_loan_number: m.loans.fnma_loan_number })),
];
export const OW_RULES: readonly OrigRule[] = [
  W("OW-001", "phone/email present", ({ m }) => m.borrowers.some((b) => missing(b.phone) && missing(b.email)) ? fail("a borrower has neither phone nor email") : pass()),
  W("OW-002", "E-SIGN scope covers the servicing classes", ({ s }) => { const out = s.borrowers.filter((b) => { const c = s.consents.filter((x) => x.kind === "esign" && x.party_id === b.party_id); return c.length > 0 && c.every((x) => consentScopeAtBoarding(x, s.disclosure_versions).scope_servicing.length === 0); }).map((b) => b.party_id); return out.length ? fail("E-SIGN scope excludes servicing classes — 7.4 invitation goes with the first-payment letter", [...SERVICING_CONSENT_CLASSES], out) : pass(); }),
  W("OW-003", "TCPA voice consent present", ({ s }) => s.consents.some((c) => c.kind === "tcpa_voice") ? pass() : fail("no TCPA voice consent — outbound AI voice blocked")),
  W("OW-004", "MIN registration active", ({ s, ext }) => { if (!s.min.value) return pass(); const rec = ext.mers(s.min.value); return (rec?.status === "Active" || (!rec && s.min.registration === "active")) ? pass() : fail("MIN registration pending (26.4 7-day clock)", "Active", rec?.status ?? s.min.registration); }),
  W("OW-005", "hazard policy expires ≥ 60 days after the first payment date", ({ s, m }) => s.hazard.expires_on < addDays(m.loans.first_payment_date, 60) ? fail("hazard policy expiring < 60 days after first payment", `≥ ${addDays(m.loans.first_payment_date, 60)}`, s.hazard.expires_on) : pass()),
  W("OW-006", "tax parcel/APN verified by the tax service (30.4)", ({ s }) => s.tax_service_parcel_verified ? pass() : fail("tax parcel unverified — tax service match pending")),
  W("OW-007", "flood LOL contract linked (FDPA_4012A_LOL_ENROLLED_GATE)", ({ s }) => s.flood.lol_contract_linked ? pass() : fail("LOL contract not yet linked")),
  W("OW-008", "recorded security instrument received (trailing)", ({ s }) => s.trailing.recorded_security_instrument_received ? pass() : fail("recorded security instrument outstanding (trailing)")),
  W("OW-009", "final title policy received (trailing)", ({ s }) => s.trailing.final_title_policy_received ? pass() : fail("final title policy outstanding (trailing)")),
  W("OW-010", "preferred language present", ({ m }) => m.borrowers.some((b) => missing(b.language_preference)) ? fail("preferred language missing") : pass()),
  W("OW-011", "ACP enrollment flagged", ({ m }) => m.borrowers.some((b) => b.acp_enrolled) ? fail("Address Confidentiality Program enrollment — restrict address handling") : pass()),
  W("OW-012", "initial escrow statement evidence present (3.1 rule 1)", ({ s }) => (s.escrow_analysis && !s.initial_escrow_statement_delivered) ? fail("initial escrow statement evidence missing — deliver immediately") : pass()),
];
export const ALL_ORIG_RULES: readonly OrigRule[] = [...OB_RULES, ...OW_RULES];
export function runOrigRules(input: OrigRuleInput, rules: readonly OrigRule[] = ALL_ORIG_RULES): RuleResult[] {
  return rules.map((r) => ({ code: r.code, severity: r.severity, money_field: r.money_field, ...r.check(input) }));
}
/** Rule 2 routing: a money-field defect goes to the owning origination process (note terms 26.1, CD 25.2, escrow 30.3). */
export function defectOwners(code: string): readonly string[] {
  const r = OB_RULES.find((x) => x.code === code);
  if (!r) return [];
  if (code === "OB-003") return ["25.2", "26.1"];
  return r.owner_process ? [r.owner_process] : [];
}

// ───────────────────────────── consents (rule 7) ─────────────────────────────
export interface ConsentScopeDecision { readonly party_id: string; readonly consent_id: string; readonly kind: OrigConsent["kind"]; readonly provenance: "origination"; readonly captured_via: string; readonly verified: boolean; readonly scope: readonly string[]; readonly scope_servicing: readonly string[]; readonly basis_disclosure_version: string | null; readonly invitation_required: boolean; }
export function consentScopeAtBoarding(c: OrigConsent, versions: OriginationSnapshot["disclosure_versions"]): ConsentScopeDecision {
  const base = { party_id: c.party_id, consent_id: c.id, kind: c.kind, provenance: "origination" as const, captured_via: c.captured_via === "portal" ? "origination_portal" : c.captured_via, basis_disclosure_version: c.disclosure_version ?? null };
  if (c.kind !== "esign") return { ...base, verified: c.captured_via !== "voice" || c.kind === "tcpa_voice", scope: [], scope_servicing: [], invitation_required: false };
  const v = c.disclosure_version ? versions[c.disclosure_version] : undefined;
  const verified = ["portal", "ai_chat_link", "ai_voice_link"].includes(c.captured_via) && c.demonstration_passed === true && c.demonstration_channel !== "voice";
  const providersOk = !!v && v.providers.some((p) => /supermortgage/i.test(p)) && v.delivery_form === "portal_pdf";
  const servicing = v && providersOk && verified && c.servicing_group_elected === true ? v.categories.filter((k) => (SERVICING_CONSENT_CLASSES as readonly string[]).includes(k)) : [];
  const origination = v ? v.categories.filter((k) => (ORIGINATION_CONSENT_CLASSES as readonly string[]).includes(k)) : [];
  return { ...base, verified, scope: [...origination, ...servicing], scope_servicing: servicing, invitation_required: servicing.length === 0 };
}

// ───────────────────────────── opening ledger (rule 3) ─────────────────────────────
export interface OpeningFigures { readonly principal_cents: Cents; readonly escrow_deposit_cents: Cents; readonly prepaid_interest_cents: Cents; readonly buydown_funds_cents?: Cents; readonly holdback_escrow_cents?: Cents; }
export const origFundingClearing = (loanId: string): AccountRef => ({ scope: "custodial", custodialAccountId: `orig-funding-clearing:${loanId}`, account: "origination_funding_clearing" as CustodialAccount });   // new clearing account per loan, cleared by 27.1
export const prepurchaseTiCash = (custodialAccountId: string): AccountRef => ({ scope: "custodial", custodialAccountId, account: "custodial_ti_prepurchase_cash" as CustodialAccount });
const loanAcct = (loanId: string, account: "principal" | "escrow" | "prepaid_interest" | "buydown_funds" | "holdback_escrow"): AccountRef => ({ scope: "loan", loanId, account: account as LoanAccount });   // prepaid_interest / buydown_funds / holdback_escrow: baseline §5 loan sub-accounts named by 30.2
/** Balanced entry set: (a) Dr principal / Cr origination_funding_clearing; (b) Dr custodial_ti_prepurchase_cash / Cr escrow; (c) Dr clearing / Cr prepaid_interest; (d)(e) buydown / holdback; Σ = 0. */
export function openingLedgerLines(loanId: string, prepurchaseTiAccountId: string, f: OpeningFigures): LineInput[] {
  if (f.principal_cents <= 0n) throw new RangeError("principal must be the original loan amount (> 0)");
  const clearing = origFundingClearing(loanId), ti = prepurchaseTiCash(prepurchaseTiAccountId);
  const lines: LineInput[] = [
    { account: loanAcct(loanId, "principal"), amountCents: f.principal_cents, ruleRef: "30.2:opening:principal", memo: "UPB = original loan amount" },
    { account: clearing, amountCents: -f.principal_cents, ruleRef: "30.2:opening:clearing", memo: "cleared by 27.1 warehouse advance posting" },
  ];
  if (f.escrow_deposit_cents > 0n) lines.push({ account: ti, amountCents: f.escrow_deposit_cents, ruleRef: "30.2:opening:escrow_deposit_cash" }, { account: loanAcct(loanId, "escrow"), amountCents: -f.escrow_deposit_cents, ruleRef: "30.2:opening:escrow_liability", memo: "CD (g)(3) = 30.3 analysis" });
  if (f.prepaid_interest_cents > 0n) lines.push({ account: clearing, amountCents: f.prepaid_interest_cents, ruleRef: "30.2:opening:prepaid_interest_clearing" }, { account: loanAcct(loanId, "prepaid_interest"), amountCents: -f.prepaid_interest_cents, ruleRef: "30.2:opening:prepaid_interest", memo: "partner income; 26.3 cent-rounded per diem × days" });
  if ((f.buydown_funds_cents ?? 0n) > 0n) lines.push({ account: ti, amountCents: f.buydown_funds_cents!, ruleRef: "30.2:opening:buydown_cash" }, { account: loanAcct(loanId, "buydown_funds"), amountCents: -f.buydown_funds_cents!, ruleRef: "30.2:opening:buydown_funds" });
  if ((f.holdback_escrow_cents ?? 0n) > 0n) lines.push({ account: ti, amountCents: f.holdback_escrow_cents!, ruleRef: "30.2:opening:holdback_cash" }, { account: loanAcct(loanId, "holdback_escrow"), amountCents: -f.holdback_escrow_cents!, ruleRef: "30.2:opening:holdback_escrow" });
  return lines;
}
export const sumLines = (lines: readonly LineInput[]): Cents => lines.reduce((t, l) => t + l.amountCents, 0n);

// ───────────────────────────── documents and retention (rule 6) ─────────────────────────────
export const RETENTION_BY_KIND: Record<string, string> = {
  loan_estimate: "regz_le_3y", closing_disclosure_final: "regz_cd_5y", closing_disclosure_corrected: "regz_cd_5y", atr_qm_evidence: "regz_atr_3y", urla_1003: "regb_25m", regb_notice: "regb_25m", hmda_record: "hmda_3y", afba_disclosure: "respa_afba_5y", sfhdf: "fdpa_life_of_loan",
  note: "fnma_loan_file_life_plus_4y", security_instrument: "fnma_loan_file_life_plus_4y", recorded_security_instrument: "fnma_loan_file_life_plus_4y", rider: "fnma_loan_file_life_plus_4y", title_policy: "fnma_loan_file_life_plus_4y", appraisal: "fnma_loan_file_life_plus_4y", mi_certificate: "fnma_loan_file_life_plus_4y", hpa_disclosure: "fnma_loan_file_life_plus_4y", flood_notice: "fnma_loan_file_life_plus_4y", escrow_initial_statement: "fnma_loan_file_life_plus_4y", closing_instructions: "fnma_loan_file_life_plus_4y", funding_wire_evidence: "fnma_loan_file_life_plus_4y", ron_audit_trail: "fnma_loan_file_life_plus_4y",
  ron_recording: "ron_recording_state_<n>y", esign_consent: "esign_consent_life", sar: "bsa_sar_5y",
};
const RETENTION_RANK: readonly string[] = ["regb_25m", "regz_le_3y", "regz_atr_3y", "hmda_3y", "regz_cd_5y", "respa_afba_5y", "bsa_sar_5y", "ron_recording_state_<n>y", "fnma_loan_file_life_plus_4y", "esign_consent_life", "fdpa_life_of_loan"];
/** Rule 6: the class per addendum §10; where an artifact is in several classes the longest wins. */
export function retentionClassFor(kinds: readonly string[] | string): string {
  const ks = typeof kinds === "string" ? [kinds] : kinds;
  const classes = ks.map((k) => RETENTION_BY_KIND[k] ?? "fnma_loan_file_life_plus_4y");
  return classes.sort((a, b) => RETENTION_RANK.indexOf(b) - RETENTION_RANK.indexOf(a))[0]!;
}
export interface LoanDocumentIndexRow { readonly loan_id: string; readonly document_id: string; readonly kind: string; readonly retention_class: string; readonly custody: OrigDocument["custody"]; readonly required_for_servicing_file: boolean; readonly trailing: boolean; }
export function indexOriginationDocuments(loanId: string, docs: readonly OrigDocument[]): LoanDocumentIndexRow[] {
  return docs.map((d) => ({ loan_id: loanId, document_id: d.id, kind: d.kind, retention_class: retentionClassFor(d.kind), custody: d.custody, required_for_servicing_file: d.kind === "security_instrument", trailing: d.kind === "recorded_security_instrument" || d.kind === "title_policy" }));
}

// ───────────────────────────── first statement (rule 9) and timers seeded ─────────────────────────────
export interface FirstStatementFigures { readonly cycle_due_date: PlainDate; readonly pi_cents: Cents; readonly escrow_cents: Cents; readonly mi_cents: Cents; readonly amount_due_cents: Cents; readonly past_due_cents: 0n; readonly late_fee_cents: Cents; readonly late_fee_after_date: PlainDate; readonly late_fee_line: string; readonly statement_due_by: PlainDate; readonly courtesy_period_end: PlainDate; readonly second_statement_due_by: PlainDate; }
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (d: PlainDate): string => { const [y, m, day] = d.split("-").map(Number); return `${MONTHS[m! - 1]} ${day}, ${y}`; };
const shortDate = (d: PlainDate): string => { const [y, m, day] = d.split("-").map(Number); return `${MONTHS[m! - 1]!.slice(0, 3)} ${day}, ${y}`; };
/** Late charge per the note: pct × P&I, rounded half-up to the cent (fixture 5% × $3,402.62 = $170.13). */
export function lateChargeCents(piCents: Cents, pct: string): Cents { return centsToDecimal(piCents).mul(Decimal.parse(pct)).div(Decimal.fromInt(100)).toCents("HALF_UP"); }
export function firstStatementFigures(t: { first_payment_date: PlainDate; pi_cents: Cents; escrow_payment_cents: Cents; mi_premium_cents?: Cents; late_charge_pct: string; late_charge_grace_days: number }): FirstStatementFigures {
  const mi = t.mi_premium_cents ?? 0n;
  const lateFee = lateChargeCents(t.pi_cents, t.late_charge_pct);
  const after = addDays(t.first_payment_date, t.late_charge_grace_days);
  const next = statementCycle(t.first_payment_date, t.late_charge_grace_days);   // 7.1: the clock from the first due date governs cycle 2
  return { cycle_due_date: t.first_payment_date, pi_cents: t.pi_cents, escrow_cents: t.escrow_payment_cents, mi_cents: mi, amount_due_cents: t.pi_cents + t.escrow_payment_cents + mi, past_due_cents: 0n, late_fee_cents: lateFee, late_fee_after_date: after,
    late_fee_line: `${formatCents(lateFee, { symbol: true, grouping: true })} after ${shortDate(after)}`, statement_due_by: addDays(t.first_payment_date, -FIRST_STATEMENT_LEAD_DAYS), courtesy_period_end: next.courtesy_period_end, second_statement_due_by: next.statement_due_by };
}
export function activeBeforeFirstDueGateDate(firstPayment: PlainDate, cals: CalendarSet = defaultCalendars): PlainDate { return addBusinessDays(firstPayment, -ACTIVE_GATE_BUSINESS_DAYS, cals.business_days_servicer); }
export function firstPaymentLetterTarget(fundingDate: PlainDate, cals: CalendarSet = defaultCalendars): PlainDate { return addBusinessDays(fundingDate, LETTER_TARGET_BUSINESS_DAYS, cals.business_days_servicer); }
/** 26.4's MOM registration clock re-stated for OW-004: note date (purchase, non-escrow state) / funding date (refinance or escrow state) + 7 calendar days. */
export function mersRegistrationDue(i: { loan_purpose: "purchase" | "refinance"; escrow_state: boolean; note_date: PlainDate; funding_date: PlainDate }): { anchor_date: PlainDate; due: PlainDate } {
  const anchor = i.loan_purpose === "refinance" || i.escrow_state ? i.funding_date : i.note_date;
  return { anchor_date: anchor, due: addDays(anchor, 7) };
}
export interface SeedPlanRow { readonly code: string; readonly owner: string; readonly anchor: PlainDate; readonly expected_due: PlainDate; }
/** 30.4 rule 10's verification set — the instances 30.2 owns or arms at boarding, with the fixture anchors. */
export function seedPlan(l: { funding_date: PlainDate; first_payment_date: PlainDate; boarded_on: PlainDate }, cals: CalendarSet = defaultCalendars): SeedPlanRow[] {
  return [
    { code: "SM_ORIG_BOARD_T1BD", owner: "30.2", anchor: l.funding_date, expected_due: addBusinessDays(l.funding_date, 1, cals.business_days_servicer) },
    { code: "SM_ORIG_FIRST_STATEMENT_LEAD_15", owner: "30.2", anchor: l.first_payment_date, expected_due: addDays(l.first_payment_date, -FIRST_STATEMENT_LEAD_DAYS) },
    { code: "SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE", owner: "30.2", anchor: l.first_payment_date, expected_due: activeBeforeFirstDueGateDate(l.first_payment_date, cals) },
    { code: "SM_O64_FIRST_PAYMENT_LETTER_5BD", owner: "25.4", anchor: l.funding_date, expected_due: addBusinessDays(l.funding_date, 5, cals.business_days_servicer) },
    { code: "SM_O64_FIRST_PAYMENT_LETTER_PREDUE_20", owner: "25.4", anchor: l.first_payment_date, expected_due: addDays(l.first_payment_date, -20) },
    { code: "SM_O64_1098_SEEDS_AT_BOARDING_GATE", owner: "25.4", anchor: l.boarded_on, expected_due: l.boarded_on },
  ];
}

// ───────────────────────────── first-payment letter (rule 10) ─────────────────────────────
export interface FirstPaymentLetterPayload {
  readonly servicer_name: string; readonly partner_name: string; readonly servicing_loan_number: string; readonly property_address: string;
  readonly first_payment_date: PlainDate; readonly pi_cents: Cents; readonly escrow_cents: Cents; readonly mi_cents: Cents; readonly total_cents: Cents;
  readonly remittance_address: string; readonly portal_url: string; readonly ach_enrollment: string; readonly servicer_phone: string; readonly automation_disclosure: string;
  readonly late_charge_pct: string; readonly late_charge_grace_days: number; readonly escrow_summary: string; readonly initial_escrow_statement_pointer: string;
  readonly not_a_transfer_notice: boolean; readonly b1_text: string | null; readonly esign_invitation: boolean; readonly privacy_reference: string; readonly hud_cfpb_block: string; readonly acp_or_successor_handling: string | null;
  readonly account_last4: string;
}
export interface LetterCheck { readonly rule_id: string; readonly citation: string; readonly passed: boolean; readonly message: string; }
/** Rule 10 content checklist (a)–(m); every item blocks release. */
export function firstPaymentLetterChecklist(p: FirstPaymentLetterPayload, rendered: string): { passed: boolean; results: LetterCheck[]; blocking: LetterCheck[] } {
  const c = (rule_id: string, citation: string, passed: boolean, message: string): LetterCheck => ({ rule_id, citation, passed, message });
  const results: LetterCheck[] = [
    c("a-servicer-on-behalf", "30.2 rule 10(a); 1.3 branding", /servicing on behalf of/.test(rendered) && rendered.includes(p.partner_name) && !!p.partner_name, "SM identified as servicer 'servicing on behalf of [Partner], your lender' with the creditor's name as on the note"),
    c("b-loan-number", "30.2 rule 10(b)", isValidServicingLoanNumber(p.servicing_loan_number) && rendered.includes(p.servicing_loan_number), "servicing loan number"),
    c("c-property", "30.2 rule 10(c)", !!p.property_address && rendered.includes(p.property_address), "property address"),
    c("d-first-payment", "30.2 rule 10(d)", p.total_cents === p.pi_cents + p.escrow_cents + p.mi_cents && rendered.includes(longDate(p.first_payment_date)) && rendered.includes(formatCents(p.total_cents, { symbol: true, grouping: true })), "first payment due date and amount with the P&I / escrow / MI breakdown and the monthly total"),
    c("e-how-to-pay", "30.2 rule 10(e)", !!p.remittance_address && !!p.portal_url && !!p.ach_enrollment && !!p.servicer_phone && !!p.automation_disclosure && rendered.includes(p.automation_disclosure), "how to pay: mailing address, portal, ACH enrollment, phone/AI assistant with the automation disclosure"),
    c("f-grace-late-charge", "30.2 rule 10(f); note §7", /grace period/.test(rendered) && /late charge/.test(rendered), "grace period and late-charge statement per the note"),
    c("g-escrow-summary", "30.2 rule 10(g)", !!p.escrow_summary && !!p.initial_escrow_statement_pointer, "escrow account summary with a pointer to the initial escrow statement delivered at settlement"),
    c("h-not-a-transfer-notice", "30.2 rule 10(h); §1024.33(b)", p.not_a_transfer_notice && /not a notice of servicing transfer/.test(rendered) && /as disclosed at closing/.test(rendered), "loan terms and payee as disclosed at closing; this letter is not a notice of servicing transfer"),
    c("i-fcra-b1", "30.2 rule 10(i); 15 U.S.C. §1681s-2(a)(7); 12 CFR 1022 App. B Model B-1", p.b1_text === MODEL_B1 && rendered.includes(MODEL_B1), "FCRA §623(a)(7) negative-information notice (model B-1 text verbatim)"),
    c("j-esign-invitation", "30.2 rule 10(j); 7.4", !p.esign_invitation || rendered.includes("enroll in electronic delivery"), "E-SIGN enrollment invitation when OW-002"),
    c("k-privacy", "30.2 rule 10(k); 21.3 / 7.5", !!p.privacy_reference, "reference to the partner's privacy notice delivered at application"),
    c("l-hud-cfpb", "30.2 rule 10(l)", !!p.hud_cfpb_block && rendered.includes(p.hud_cfpb_block), "HUD counseling / CFPB contact block"),
    c("m-acp-successor", "30.2 rule 10(m); 1.3 ACP rule", p.acp_or_successor_handling === null || rendered.includes(p.acp_or_successor_handling), "successor/ACP handling as applicable"),
  ];
  const blocking = results.filter((r) => !r.passed);
  return { passed: blocking.length === 0, results, blocking };
}
/** The letter body when 25.4's registry version is not yet published (25.4 owns `NTC_SM_FIRST_PAYMENT_LETTER`; the registry render is preferred whenever an active version exists). */
export function renderFirstPaymentLetter(p: FirstPaymentLetterPayload): string {
  const money = (c: Cents) => formatCents(c, { symbol: true, grouping: true });
  return [
    `${p.servicer_name}, servicing on behalf of ${p.partner_name}, your lender.`,
    `Servicing loan number ${p.servicing_loan_number}. Property: ${p.property_address}.`,
    `Your first payment of ${money(p.total_cents)} is due ${longDate(p.first_payment_date)}: principal and interest ${money(p.pi_cents)}, escrow ${money(p.escrow_cents)}${p.mi_cents > 0n ? `, mortgage insurance ${money(p.mi_cents)}` : ""}; monthly total ${money(p.total_cents)}.`,
    `How to pay: mail to ${p.remittance_address}; online at ${p.portal_url}; ${p.ach_enrollment}; or call ${p.servicer_phone}. ${p.automation_disclosure}`,
    `Your note provides a grace period of ${p.late_charge_grace_days} days; a late charge of ${p.late_charge_pct}% of the principal and interest payment applies to a payment received after the grace period.`,
    `Escrow: ${p.escrow_summary} ${p.initial_escrow_statement_pointer}`,
    `Your loan terms and the payee are as disclosed at closing. This letter is not a notice of servicing transfer.`,
    p.b1_text ?? "",
    p.esign_invitation ? "You can enroll in electronic delivery of your statements and notices in the borrower portal (E-SIGN disclosure enclosed)." : "",
    `Privacy: ${p.privacy_reference}`, p.hud_cfpb_block, p.acp_or_successor_handling ?? "",
  ].filter(Boolean).join("\n");
}

// ───────────────────────────── §1024.38(c)(2) servicing file (rule 8) and the Sentinel view ─────────────────────────────
export interface ServicingFile { readonly loan_id: string; readonly compiled_at: string; readonly transaction_schedule: readonly { set_id: string; effective_date: PlainDate; account: string; amount_cents: string; rule_ref: string }[]; readonly security_instrument: LoanDocumentIndexRow | null; readonly contact_log: readonly unknown[]; readonly data_field_report: readonly StagingRow[]; readonly borrower_submissions: readonly unknown[]; readonly compile_ms: number; readonly within_five_minutes: boolean; readonly within_five_days: boolean; }
export function sentinelBoardingReport(breaches: readonly Breach[], asOf: string): { as_of: string; items: { loan_id: string | null; application_id: string | null; code: string; severity: 1 | 2 | 3 | 4 | null; due_date: PlainDate | null; escalate_to: readonly string[] }[] } {
  return { as_of: asOf, items: breaches.filter((b) => b.def.process === "30.2").map((b) => ({ loan_id: b.instance.loanId ?? null, application_id: b.instance.applicationId ?? null, code: b.instance.code, severity: b.severity, due_date: b.instance.dueDate ?? null, escalate_to: b.escalateTo })) };
}
/** 2.x's view of the boarded loan: one contractual installment on the first payment date (no history, no suspense, no holds). */
export function cashStateAtBoarding(l: { loan_id: string; note_date: PlainDate; note_rate_pct: string; amount_cents: Cents; pi_cents: Cents; escrow_payment_cents: Cents; first_payment_date: PlainDate; late_charge_pct: string; late_charge_grace_days: number; escrowed: boolean }): LoanCashState {
  return { loan_id: l.loan_id, instrument_date: l.note_date, lien: "first", escrowed: l.escrowed, note_rate_pct: l.note_rate_pct, remittance_type: "A/A", upb_cents: l.amount_cents, lpi_date: null, installments: [{ due_date: l.first_payment_date, pi_cents: l.pi_cents, escrow_cents: l.escrow_payment_cents, status: "due" }],
    late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false, late_charge_pct: l.late_charge_pct, late_charge_grace_days: l.late_charge_grace_days, late_charge_basis: "pi", loan_terms_version: 1 };
}

// ───────────────────────────── the service (1.1's pipeline in origination mode) ─────────────────────────────
export type OrigBoardingStatus = BoardingStatus | "boarded_with_warnings" | "unwound";
interface TailCtx { readonly openWarnings: number; readonly letterSent: boolean; readonly vendorAcksComplete: boolean; }
/** The origination tail of 1.1's machine: boarded —(any open OW-*)→ boarded_with_warnings —(warnings cleared/waived; letter sent; vendor acks)→ active; any → unwound (26.3). */
export const origTailMachine = new Machine<OrigBoardingStatus, TailCtx>({
  name: "boarding.origination_tail", initial: "boarded", states: ["staged", "validated", "exception", "boarded", "boarded_with_warnings", "reconciled", "active", "rejected_to_transferor", "withdrawn", "unwound"], terminal: ["active", "unwound", "rejected_to_transferor", "withdrawn"],
  transitions: [
    { from: "boarded", to: "boarded_with_warnings", on: "warn", guard: (t) => (t.ctx.openWarnings > 0 ? undefined : "no open warnings") },
    { from: ["boarded", "boarded_with_warnings"], to: "active", on: "activate", guard: (t) => t.ctx.openWarnings > 0 ? `${t.ctx.openWarnings} open OW-* warning(s)` : !t.ctx.letterSent ? "first-payment letter not sent" : !t.ctx.vendorAcksComplete ? "vendor activations (30.4) not acknowledged" : undefined },
    { from: ["staged", "validated", "exception", "boarded", "boarded_with_warnings"], to: "unwound", on: "unwind" },
  ],
});
export interface OrigValidation extends RuleResult { readonly id: number; readonly run_id: string; readonly application_id: string; readonly loan_id: string; readonly rule_set_version: string; resolved?: { by: string; resolution: "cleared" | "waived_with_reason" | "source_corrected"; reason: string; at: string }; }
export interface LetterRecord { readonly notice_id: string; readonly party_id: string; readonly template: string; readonly carries: readonly string[]; readonly status: "held" | "sent"; readonly channel: "mail_first_class" | "mail_and_portal"; readonly sent_on: PlainDate | null; readonly mailed_at: string | null; readonly checklist: ReturnType<typeof firstPaymentLetterChecklist>; readonly rendered: string; }
export interface NoticeRow { readonly id: string; readonly template_code: string; readonly loan_id: string; readonly application_id: string; readonly party_id: string; readonly status: "sent"; readonly carrier_notice_id: string | null; readonly sent_at: string; }
export interface OrigLoanRecord {
  readonly application_id: string; readonly loan_id: string; readonly servicing_loan_number: string;
  status: OrigBoardingStatus; readonly funded: LoanFundedPayload; readonly funded_event_id: string; snapshot: OriginationSnapshot; mapped: MappedLoan;
  validations: OrigValidation[]; staged_at: string; boarded_at?: string; active_at?: string; opening_entry_set_id?: string; prepaid: PrepaidInterest;
  consents: ConsentScopeDecision[]; documents_index: LoanDocumentIndexRow[]; letters: LetterRecord[]; seeded: SeedPlanRow[]; vendor_acks: Set<string>; corrections: { fields: string[]; provenance: string; decision_id: string }[];
}
export interface OrigBoardingDeps {
  readonly events: EventStore; readonly ledger: Ledger; readonly clock: { now(): string }; readonly ext: OrigExternal;
  readonly calendars?: CalendarSet; readonly timers?: TimerEngine; readonly escalations?: EscalationService; readonly notices?: NoticeService;
  /** Pre-purchase T&I custodial account (30.1 prerequisite) that holds the closing escrow deposit. */
  readonly prepurchaseTiAccountId: string;
  readonly servicerTz?: string; readonly loanIdFor?: (applicationId: string) => string;
  readonly letterContext?: Partial<Pick<FirstPaymentLetterPayload, "servicer_name" | "remittance_address" | "portal_url" | "ach_enrollment" | "servicer_phone" | "automation_disclosure" | "hud_cfpb_block" | "privacy_reference">>;
}
export interface BoardFundedResult { readonly status: OrigBoardingStatus; readonly loan_id: string; readonly application_id: string; readonly servicing_loan_number: string; readonly validations: readonly OrigValidation[]; readonly ledger_set: EntrySet | null; readonly timers: readonly TimerInstance[]; readonly seed_plan: readonly SeedPlanRow[]; readonly letters: readonly LetterRecord[]; readonly consents: readonly ConsentScopeDecision[]; readonly documents_index: readonly LoanDocumentIndexRow[]; readonly duplicate: boolean; readonly refusal: string | null; }

export class OriginationBoardingService {
  readonly d: OrigBoardingDeps;
  private readonly cals: CalendarSet;
  private readonly byApp = new Map<string, OrigLoanRecord>();
  private readonly rows: NoticeRow[] = [];
  private seq = 0; private validationSeq = 0;
  constructor(deps: OrigBoardingDeps) { this.d = deps; this.cals = deps.calendars ?? defaultCalendars; }

  record(applicationId: string): OrigLoanRecord { const r = this.byApp.get(applicationId); if (!r) throw new RangeError(`no origination boarding record for application ${applicationId}`); return r; }
  find(applicationId: string): OrigLoanRecord | undefined { return this.byApp.get(applicationId); }
  all(): readonly OrigLoanRecord[] { return [...this.byApp.values()]; }
  noticeRows(): readonly NoticeRow[] { return this.rows; }
  private now(): string { return this.d.clock.now(); }
  private append(r: Pick<OrigLoanRecord, "application_id" | "loan_id">, type: string, payload: Record<string, unknown>, actor: Actor = BOARDING_AGENT, causationId?: string): DomainEvent {
    return this.d.events.append({ type, loanId: r.loan_id, applicationId: r.application_id, actor, payload: { application_id: r.application_id, loan_id: r.loan_id, ...payload }, ...(causationId ? { causationId } : {}) });
  }
  openHard(r: OrigLoanRecord): OrigValidation[] { return r.validations.filter((v) => v.severity === "hard" && v.result === "fail" && !v.resolved); }
  openWarnings(r: OrigLoanRecord): OrigValidation[] { return r.validations.filter((v) => v.severity === "warning" && v.result === "fail" && !v.resolved); }

  /** `loan.funded` intake — idempotent by application id (T13): a second delivery is ignored with a receipt. When the caller has no event id (in-memory entry), the fallback event is appended so SM_ORIG_BOARD_T1BD / 25.4's letter clocks arm (26.3 is the owner emitter). */
  ingestFunded(s: OriginationSnapshot, f: LoanFundedPayload): { status: "accepted" | "duplicate"; record: OrigLoanRecord } {
    if (f.application_id !== s.application_id) throw new RangeError("loan.funded application_id must match the snapshot");
    const existing = this.byApp.get(f.application_id);
    if (existing) { this.d.events.append({ type: "loan.funded.duplicate_ignored", applicationId: f.application_id, loanId: existing.loan_id, actor: BOARDING_AGENT, payload: { application_id: f.application_id, loan_id: existing.loan_id, funded_event_id: existing.funded_event_id, receipt: "duplicate" } }); return { status: "duplicate", record: existing }; }
    const fundedEvent = f.event_id ? null : this.d.events.append({ type: "loan.funded", applicationId: f.application_id, actor: { kind: "agent", id: "funding" }, occurredAt: f.funded_at, payload: { application_id: f.application_id, source: "origination", funding_date: f.funding_date, disbursement_date: f.disbursement_date, funded_at: f.funded_at, wire_id: f.wire_id, funded_amount_cents: f.funded_amount_cents.toString(), per_diem_cents: f.per_diem_cents.toString(), prepaid_interest_cents: f.prepaid_interest_cents.toString(), interest_credit: f.interest_credit, rescission_expires_at: f.rescission_expires_at, first_payment_date: s.note.first_payment_date } });
    const r = this.stage(s, f, fundedEvent?.id ?? f.event_id!);
    return { status: "accepted", record: r };
  }
  /** Rule 4: the servicing loan number is allocated at `staged`; the `loans` row (id) exists from here (30.2 creates it at funding). */
  private stage(s: OriginationSnapshot, f: LoanFundedPayload, fundedEventId: string): OrigLoanRecord {
    let number = servicingLoanNumber(++this.seq);
    while (this.d.ext.onPlatform("servicing_loan_number", number)) number = servicingLoanNumber(++this.seq);
    const loan_id = this.d.loanIdFor ? this.d.loanIdFor(s.application_id) : randomUUID();
    const mapped = mapOrigination(s, f, { loan_id, servicing_loan_number: number });
    const r: OrigLoanRecord = { application_id: s.application_id, loan_id, servicing_loan_number: number, status: "staged", funded: f, funded_event_id: fundedEventId, snapshot: s, mapped, validations: [], staged_at: this.now(), prepaid: prepaidInterest(s.note.amount_cents, s.note.note_rate_pct, f.disbursement_date), consents: [], documents_index: [], letters: [], seeded: [], vendor_acks: new Set(), corrections: [] };
    this.byApp.set(s.application_id, r);
    this.append(r, "loan.staged", { source: "origination", servicing_loan_number: number, funding_date: f.funding_date, disbursement_date: f.disbursement_date, first_payment_date: s.note.first_payment_date, mapping_version: mapped.mapping_version, snapshot_hash: mapped.snapshot_hash, staging_rows: mapped.staging.length }, BOARDING_AGENT, fundedEventId);
    return r;
  }
  /** Rule 2 gate — deterministic and idempotent on the same snapshot; a hard failure raises `loan.boarding_exception.raised{severity=hard}` once; OB-020 escalates to `officer`. */
  validate(applicationId: string): { status: OrigBoardingStatus; validations: readonly OrigValidation[] } {
    const r = this.record(applicationId);
    if (r.status !== "staged" && r.status !== "exception" && r.status !== "validated") throw new RangeError(`loan ${r.loan_id} is ${r.status}: validation runs before boarding (post-boarding corrections are a new loan_terms version)`);
    const run_id = randomUUID();
    const prevResolved = new Map(r.validations.filter((v) => v.resolved).map((v) => [v.code, v.resolved!]));
    const prevOpenHard = new Set(this.openHard(r).map((v) => v.code));
    const results = runOrigRules({ s: r.snapshot, m: r.mapped, funded: r.funded, ext: this.d.ext });
    r.validations = results.map((x) => { const res = prevResolved.get(x.code); return { ...x, id: ++this.validationSeq, run_id, application_id: r.application_id, loan_id: r.loan_id, rule_set_version: RULE_SET_VERSION_30_2, ...(res && x.result === "fail" ? { resolved: res } : {}) }; });
    const openHard = this.openHard(r);
    const t = boardingMachine.attempt(r.status as BoardingStatus, "validate", BOARDING_AGENT, { openHardFailures: openHard.length, transferDateReached: true, finalTapeReconciled: true, onApprovedList: true });
    if (!t.ok) throw new RangeError(t.reason);
    const prior = r.status; r.status = t.to;
    if (t.to === "validated") {
      this.append(r, "loan.validated", { run_id, warnings: this.openWarnings(r).map((v) => v.code), prior_status: prior, rule_set_version: RULE_SET_VERSION_30_2 });
      if (prior === "exception") this.append(r, "loan.boarding_exception.resolved", { run_id, resolution: "source_corrected" });
    } else {
      for (const v of openHard) if (!prevOpenHard.has(v.code)) {
        this.append(r, "loan.boarding_exception.raised", { rule_code: v.code, severity: "hard", money_field: v.money_field, raised_at: this.now(), run_id, expected: v.expected ?? null, actual: v.actual ?? null, owner_processes: defectOwners(v.code) });
        if (v.code === "OB-020") this.d.escalations?.open({ kind: "officer", loanId: r.loan_id, applicationId: r.application_id, severity: "sev1", payload: { rule_code: "OB-020", reason: `property state ${r.mapped.properties.state} not covered by an SM servicer license — the loan should never have funded (31.1 gate)`, state: r.mapped.properties.state } }, BOARDING_AGENT);
      }
    }
    return { status: r.status, validations: r.validations };
  }
  /** Rule 2 / T2: a money-field defect is routed to the owning origination process; the boarding command stays refused until the source record is corrected. */
  routeToOwner(applicationId: string, ruleCode: string): { rule_code: string; owner_processes: readonly string[]; money_field: boolean; event: DomainEvent } {
    const r = this.record(applicationId);
    const v = r.validations.find((x) => x.code === ruleCode && x.result === "fail" && !x.resolved);
    if (!v) throw new RangeError(`${ruleCode} is not an open failure on ${r.loan_id}`);
    const owners = defectOwners(ruleCode);
    if (!owners.length) throw new RangeError(`${ruleCode} has no owning origination process to route to`);
    const event = this.append(r, "boarding.defect.routed", { rule_code: ruleCode, owner_processes: owners, money_field: v.money_field, expected: v.expected ?? null, actual: v.actual ?? null });
    return { rule_code: ruleCode, owner_processes: owners, money_field: v.money_field, event };
  }
  /** Non-money corrections from the origination record (agent) or a corrected source document (provenance=source with evidence); the snapshot is replaced, never edited; money fields are refused. */
  proposeCorrection(applicationId: string, changes: Partial<Pick<OriginationSnapshot, "borrowers" | "property" | "min" | "custody" | "documents" | "consents" | "note" | "final_cd" | "escrow_analysis" | "trailing" | "tax_service_parcel_verified">>, actor: Actor, opts: { provenance: "agent" | "source"; evidence_document_ids?: readonly string[]; rationale?: string }): { ok: true; fields: string[]; status: OrigBoardingStatus; decision_id: string } | { ok: false; code: "MONEY_FIELD_GUARD" | "EVIDENCE_REQUIRED" | "NOT_CORRECTABLE"; reason: string } {
    const r = this.record(applicationId);
    const fields = Object.keys(changes);
    if (!fields.length) throw new RangeError("proposeCorrection needs at least one changed field");
    if (r.status !== "staged" && r.status !== "validated" && r.status !== "exception") return { ok: false, code: "NOT_CORRECTABLE", reason: `loan is ${r.status}: post-funding corrections are a new loan_terms version or reversing entries (rule 12)` };
    const money = ["note", "final_cd", "escrow_analysis"].filter((k) => fields.includes(k));
    if (money.length && opts.provenance !== "source") return { ok: false, code: "MONEY_FIELD_GUARD", reason: `${money.join(", ")} carry money fields (${ORIG_MONEY_FIELDS.join(", ")}) — they come only from the signed note / CD data hashes; route the defect to the owning process (routeToOwner)` };
    if (opts.provenance === "source" && !(opts.evidence_document_ids ?? []).length) return { ok: false, code: "EVIDENCE_REQUIRED", reason: "a source correction cites the re-executed/corrected document (evidence_document_ids)" };
    const decision_id = randomUUID();
    r.snapshot = { ...r.snapshot, ...changes };
    r.mapped = mapOrigination(r.snapshot, r.funded, { loan_id: r.loan_id, servicing_loan_number: r.servicing_loan_number });
    r.corrections.push({ fields, provenance: opts.provenance, decision_id });
    this.append(r, "boarding.correction.applied", { fields, provenance: opts.provenance, evidence_document_ids: [...(opts.evidence_document_ids ?? [])], decision_id, rationale: opts.rationale ?? null }, actor);
    const v = this.validate(applicationId);
    return { ok: true, fields, status: v.status, decision_id };
  }
  /** Waiver of a hard rule needs `officer` (money) or the boarding lead with a written reason; warnings need any human with a reason. */
  waive(applicationId: string, ruleCode: string, actor: Actor, reason: string): { ok: true; status: OrigBoardingStatus } | { ok: false; code: "ROLE_DENIED" | "NOT_FAILED"; reason: string } {
    const r = this.record(applicationId);
    const v = r.validations.find((x) => x.code === ruleCode && x.result === "fail" && !x.resolved);
    if (!v) return { ok: false, code: "NOT_FAILED", reason: `${ruleCode} is not an open failure` };
    if (actor.kind !== "human" || !reason) return { ok: false, code: "ROLE_DENIED", reason: "a waiver is a human act with a written reason" };
    if ((v.money_field || v.severity === "hard") && actor.role !== "officer" && !(v.severity === "hard" && !v.money_field && actor.role === "ops_analyst")) return { ok: false, code: "ROLE_DENIED", reason: `waiver of ${v.severity} rule ${ruleCode}${v.money_field ? " (money field)" : ""} requires officer${v.money_field ? "" : " or the boarding lead (ops_analyst)"}` };
    v.resolved = { by: `${actor.kind}:${actor.id}`, resolution: "waived_with_reason", reason, at: this.now() };
    this.append(r, "loan.boarding_validation.waived", { rule_code: ruleCode, money_field: v.money_field, reason }, actor);
    if (v.severity === "hard" && this.openHard(r).length === 0 && r.status === "exception") { r.status = "validated"; this.append(r, "loan.validated", { via: "waiver" }, actor); this.append(r, "loan.boarding_exception.resolved", { resolution: "waived_with_reason" }, actor); }
    if (v.severity === "warning") this.warningResolved(r, ruleCode, actor);
    return { ok: true, status: r.status };
  }
  /** `boarded` (rule 2/3): zero open OB-*, rescission clear; posts the opening ledger, emits `loan.boarded` (both ids), then `boarded_with_warnings` when any OW-* is open. */
  board(applicationId: string): { ok: true; status: OrigBoardingStatus; boarded_at: string; ledger_set: EntrySet } | { ok: false; reason: string } {
    const r = this.record(applicationId);
    if (!rescissionClear(r.snapshot.rescindable, r.snapshot.rescission_expires_at ?? r.funded.rescission_expires_at, r.funded.funded_at)) return { ok: false, reason: `rescission_expires_at ${r.snapshot.rescission_expires_at ?? r.funded.rescission_expires_at} is not before loan.funded ${r.funded.funded_at} (OB-018; guardrail)` };
    const t = boardingMachine.attempt(r.status as BoardingStatus, "board", BOARDING_AGENT, { openHardFailures: this.openHard(r).length, transferDateReached: true, finalTapeReconciled: true, onApprovedList: true });
    if (!t.ok) return { ok: false, reason: `${t.reason}${this.openHard(r).length ? ` (${this.openHard(r).map((v) => v.code).join(", ")})` : ""}` };
    const now = this.now();
    r.status = "boarded"; r.boarded_at = now;
    const set = this.postOpeningEntries(applicationId);
    const warnings = this.openWarnings(r).map((v) => v.code);
    const boarded = this.append(r, "loan.boarded", { source: "origination", servicing_loan_number: r.servicing_loan_number, boarded_at: now, funding_date: r.funded.funding_date, disbursement_date: r.funded.disbursement_date, first_payment_date: r.mapped.loans.first_payment_date, maturity_date: r.mapped.loans.maturity_date, interest_paid_through_date: r.mapped.loans.interest_paid_through_date,
      escrowed: r.snapshot.escrow_analysis !== null, min: r.mapped.loans.min, mers_eligible: true, investor: "partner_warehouse", opening_entry_set_id: set.id, warnings, default_status_at_boarding: false, fdcpa_debt_collector_flag: false, mi_certificates_present: r.snapshot.mi !== null, hazard_expires_on: r.snapshot.hazard.expires_on, note_date: r.mapped.loans.note_date, consummation_date: r.mapped.loans.consummation_date });
    if (warnings.length) { const w = origTailMachine.attempt("boarded", "warn", BOARDING_AGENT, { openWarnings: warnings.length, letterSent: false, vendorAcksComplete: false }); if (w.ok) { r.status = w.to; this.append(r, "loan.boarding.warnings_open", { boarded_at: now, warnings }, BOARDING_AGENT, boarded.id); } }
    return { ok: true, status: r.status, boarded_at: now, ledger_set: set };
  }
  /** Rule 3 opening entries, balanced against the per-loan `origination_funding_clearing`; `loans.interest_paid_through_date` set. */
  postOpeningEntries(applicationId: string): EntrySet {
    const r = this.record(applicationId);
    if (r.opening_entry_set_id) throw new RangeError(`opening entries already posted for ${r.loan_id} (${r.opening_entry_set_id}); corrections are reversing entries`);
    const s = r.snapshot;
    const lines = openingLedgerLines(r.loan_id, this.d.prepurchaseTiAccountId, { principal_cents: r.mapped.loans.original_loan_amount_cents, escrow_deposit_cents: s.escrow_analysis ? s.final_cd.initial_escrow_deposit_cents : 0n, prepaid_interest_cents: r.funded.interest_credit ? 0n : r.prepaid.prepaid_interest_cents });
    const set = this.d.ledger.post({ effectiveDate: r.funded.disbursement_date, description: `opening balances ${r.servicing_loan_number} (origination)`, lines }, this.now());
    r.opening_entry_set_id = set.id;
    this.append(r, "ledger.opening_posted", { entry_set_id: set.id, principal_cents: r.mapped.loans.original_loan_amount_cents.toString(), escrow_cents: (s.escrow_analysis ? s.final_cd.initial_escrow_deposit_cents : 0n).toString(), prepaid_interest_cents: r.prepaid.prepaid_interest_cents.toString(), interest_paid_through_date: r.mapped.loans.interest_paid_through_date });
    return set;
  }
  /** Rule 7: origination consents re-keyed with `provenance='origination'`; servicing scope only when the disclosure version listed the classes and the demonstration passed. Never inferred. */
  boardConsents(applicationId: string): readonly ConsentScopeDecision[] {
    const r = this.record(applicationId);
    r.consents = r.snapshot.consents.map((c) => consentScopeAtBoarding(c, r.snapshot.disclosure_versions));
    this.append(r, "consents.boarded", { consents: r.consents.map((c) => ({ party_id: c.party_id, kind: c.kind, scope: c.scope, verified: c.verified, basis_disclosure_version: c.basis_disclosure_version, invitation_required: c.invitation_required })) });
    return r.consents;
  }
  /** Rule 6: every origination artifact re-keyed to `loan_id` with its retention class into `documents` + `loan_documents_index`. */
  indexDocuments(applicationId: string): readonly LoanDocumentIndexRow[] {
    const r = this.record(applicationId);
    r.documents_index = indexOriginationDocuments(r.loan_id, r.snapshot.documents);
    this.append(r, "documents.indexed", { count: r.documents_index.length, required_for_servicing_file: r.documents_index.filter((d) => d.required_for_servicing_file).map((d) => d.document_id), trailing: r.documents_index.filter((d) => d.trailing).map((d) => d.document_id), retention_classes: [...new Set(r.documents_index.map((d) => d.retention_class))] });
    return r.documents_index;
  }
  /** Timers are registry-driven (the engine arms them on the events above); `seedTimers` records the verification set for 30.4 (rule 10) and what is actually armed. */
  seedTimers(applicationId: string): { plan: readonly SeedPlanRow[]; armed: readonly TimerInstance[] } {
    const r = this.record(applicationId);
    if (!r.boarded_at) throw new RangeError("seedTimers runs after loan.boarded");
    r.seeded = seedPlan({ funding_date: r.funded.funding_date, first_payment_date: r.mapped.loans.first_payment_date, boarded_on: plainDate(wallClock(Date.parse(r.boarded_at), this.d.servicerTz ?? "America/New_York").date) }, this.cals);
    const armed = this.d.timers ? [...this.d.timers.forSubject("loan", r.loan_id), ...this.d.timers.forSubject("application", r.application_id)] : [];
    this.append(r, "timers.seeded", { expected: r.seeded.map((p) => ({ code: p.code, anchor: p.anchor, expected_due: p.expected_due })), armed: armed.map((t) => ({ code: t.code, due_date: t.dueDate ?? null, status: t.status })) });
    return { plan: r.seeded, armed };
  }
  /** Rule 9: 7.1's `statement.cycle.opened{first_cycle=true}` at boarding with the first statement's figures (amount due = P&I + escrow (+ MI); no past-due; late-fee line). */
  openFirstStatementCycle(applicationId: string): FirstStatementFigures {
    const r = this.record(applicationId);
    const f = firstStatementFigures({ first_payment_date: r.mapped.loans.first_payment_date, pi_cents: r.mapped.loan_terms.pi_cents, escrow_payment_cents: r.mapped.loan_terms.escrow_payment_cents, mi_premium_cents: r.mapped.loan_terms.mi_premium_cents, late_charge_pct: r.mapped.loan_terms.late_charge_pct, late_charge_grace_days: r.mapped.loan_terms.late_charge_grace_days });
    this.append(r, "statement.cycle.opened", { first_cycle: true, cycle_due_date: f.cycle_due_date, statement_due_by: f.statement_due_by, template: "NTC_REGZ_41_STMT_STD", variant: "standard", amount_due_cents: f.amount_due_cents.toString(), pi_cents: f.pi_cents.toString(), escrow_cents: f.escrow_cents.toString(), mi_cents: f.mi_cents.toString(), past_due_cents: "0", late_fee_cents: f.late_fee_cents.toString(), late_fee_after_date: f.late_fee_after_date, courtesy_period_end: f.courtesy_period_end, second_statement_due_by: f.second_statement_due_by, late_charge_grace_days: r.mapped.loan_terms.late_charge_grace_days });
    return f;
  }
  letterPayload(applicationId: string, partyId: string): FirstPaymentLetterPayload {
    const r = this.record(applicationId); const b = r.mapped.borrowers.find((x) => x.party_id === partyId); if (!b) throw new RangeError(`no borrower ${partyId} on ${r.loan_id}`);
    const c = r.consents.find((x) => x.party_id === partyId && x.kind === "esign");
    const invitation = !!c && c.invitation_required;   // declining every electronic delivery (no consent row) is not a defect: no invitation
    const p = r.mapped.properties; const lc = this.d.letterContext ?? {};
    const ti = r.mapped.loan_terms;
    return { servicer_name: lc.servicer_name ?? "Supermortgage", partner_name: r.snapshot.partner_name, servicing_loan_number: r.servicing_loan_number, property_address: `${p.address_line1}, ${p.city}, ${p.state} ${p.postal_code}`, first_payment_date: r.mapped.loans.first_payment_date,
      pi_cents: ti.pi_cents, escrow_cents: ti.escrow_payment_cents, mi_cents: ti.mi_premium_cents, total_cents: ti.pi_cents + ti.escrow_payment_cents + ti.mi_premium_cents,
      remittance_address: lc.remittance_address ?? "PO Box 7, Testville TX 75001", portal_url: lc.portal_url ?? "portal.supermortgage.example", ach_enrollment: lc.ach_enrollment ?? "enroll in automatic payments (ACH) in the portal", servicer_phone: lc.servicer_phone ?? "(800) 555-0100", automation_disclosure: lc.automation_disclosure ?? "Our phone and chat assistant is automated; you can ask for a person at any time.",
      late_charge_pct: ti.late_charge_pct, late_charge_grace_days: ti.late_charge_grace_days, escrow_summary: r.snapshot.escrow_analysis ? `your escrow account starts with ${formatCents(r.snapshot.final_cd.initial_escrow_deposit_cents, { symbol: true, grouping: true })} and collects ${formatCents(ti.escrow_payment_cents, { symbol: true, grouping: true })} monthly.` : "your loan has no escrow account.", initial_escrow_statement_pointer: r.snapshot.escrow_analysis ? "See the initial escrow account statement delivered at settlement." : "",
      not_a_transfer_notice: true, b1_text: MODEL_B1, esign_invitation: invitation, privacy_reference: lc.privacy_reference ?? `${r.snapshot.partner_name}'s privacy notice was delivered with your application; it continues to apply.`, hud_cfpb_block: lc.hud_cfpb_block ?? "Housing counseling: (800) 569-4287 (HUD) / consumerfinance.gov/find-a-housing-counselor.", acp_or_successor_handling: b.acp_enrolled ? "Address Confidentiality Program: correspondence goes to your designated substitute address." : null, account_last4: r.servicing_loan_number.slice(-4) };
  }
  /** Rule 10: the first-payment letter to every borrower — first-class mail (+ portal copy when `general_correspondence` is in scope); the B-1 text rides on it and is recorded as its own `notices` row so 8.1's FCRA_1681S2A7_NEG_INFO_NOTICE_30 is pre-satisfied. A payload missing any checklist item is held and never sent. */
  async sendFirstPaymentLetter(applicationId: string, f: { sent_on: PlainDate; mailed_at?: string | null; payloadOverride?: (p: FirstPaymentLetterPayload) => FirstPaymentLetterPayload }): Promise<LetterRecord[]> {
    const r = this.record(applicationId);
    if (r.letters.some((l) => l.status === "sent")) throw new RangeError(`first-payment letter already sent for ${r.loan_id} (idempotent — one letter per borrower)`);
    if (!r.consents.length && r.snapshot.consents.length) this.boardConsents(applicationId);
    const out: LetterRecord[] = [];
    for (const b of r.mapped.borrowers) {
      const p0 = this.letterPayload(applicationId, b.party_id); const p = f.payloadOverride ? f.payloadOverride(p0) : p0;
      const registry = this.d.notices && this.hasActiveVersion(this.d.notices, f.sent_on) ? this.d.notices : null;
      let rendered = renderFirstPaymentLetter(p);
      let notice_id: string = randomUUID(); let viaRegistry = false;
      if (registry) {   // 25.4's authored version wins when published
        const rec: Recipient = { partyId: b.party_id, name: b.legal_name, mailingAddress: b.mailing_address, ...(b.email ? { email: b.email } : {}), ...(this.esignConsentFor(r, b.party_id) ? { consent: this.esignConsentFor(r, b.party_id)! } : {}) };
        const n = registry.render({ templateCode: FIRST_PAYMENT_LETTER, loanId: r.loan_id, recipients: [rec], payload: { ...p, b1_text: p.b1_text ?? "" }, asOf: f.sent_on });
        rendered = n.rendered.text ?? rendered; notice_id = n.id; viaRegistry = true;
      }
      const checklist = firstPaymentLetterChecklist(p, rendered);
      const carries = [...(p.b1_text === MODEL_B1 ? [B1_TEMPLATE] : []), ...(p.esign_invitation ? [ESIGN_INVITATION] : [])];
      const c = r.consents.find((x) => x.party_id === b.party_id && x.kind === "esign");
      const channel: LetterRecord["channel"] = c && c.scope_servicing.includes("general_correspondence") ? "mail_and_portal" : "mail_first_class";
      if (!checklist.passed) {
        const held: LetterRecord = { notice_id, party_id: b.party_id, template: FIRST_PAYMENT_LETTER, carries, status: "held", channel, sent_on: null, mailed_at: null, checklist, rendered };
        r.letters.push(held); out.push(held);
        this.append(r, "notice.held", { notice_id, template: FIRST_PAYMENT_LETTER, party_id: b.party_id, reason: `checklist: ${checklist.blocking.map((x) => `${x.rule_id} (${x.citation})`).join(", ")}`, blocking: checklist.blocking.map((x) => x.rule_id) });
        continue;
      }
      if (viaRegistry) await registry!.send(notice_id, {});
      const sent: LetterRecord = { notice_id, party_id: b.party_id, template: FIRST_PAYMENT_LETTER, carries, status: "sent", channel, sent_on: f.sent_on, mailed_at: f.mailed_at ?? null, checklist, rendered };
      r.letters.push(sent); out.push(sent);
      const sentAt = f.mailed_at ?? this.now();
      if (!viaRegistry) this.append(r, "notice.sent", { notice_id, template: FIRST_PAYMENT_LETTER, party_id: b.party_id, carries, channel, sent_on: f.sent_on, mailed_at: f.mailed_at ?? null, informational: true, servicing_transfer_notice: false, rendered_sha256: createHash("sha256").update(rendered).digest("hex") });
      else this.append(r, "notice.sent", { notice_id, template: FIRST_PAYMENT_LETTER, party_id: b.party_id, carries, channel, sent_on: f.sent_on, mailed_at: f.mailed_at ?? null, via: "registry" });
      // The B-1 carried on the letter is its own `notices` row (8.1 template code) — "one notice per account suffices".
      const b1: NoticeRow = { id: randomUUID(), template_code: B1_TEMPLATE, loan_id: r.loan_id, application_id: r.application_id, party_id: b.party_id, status: "sent", carrier_notice_id: notice_id, sent_at: sentAt };
      this.rows.push(b1);
      this.append(r, "notice.sent", { notice_id: b1.id, template: B1_TEMPLATE, party_id: b.party_id, carrier_notice_id: notice_id, carrier_template: FIRST_PAYMENT_LETTER, sent_on: f.sent_on, mailed_at: f.mailed_at ?? null });
      if (p.esign_invitation) this.rows.push({ id: randomUUID(), template_code: ESIGN_INVITATION, loan_id: r.loan_id, application_id: r.application_id, party_id: b.party_id, status: "sent", carrier_notice_id: notice_id, sent_at: sentAt });
    }
    return out;
  }
  /** 25.4 owns `NTC_SM_FIRST_PAYMENT_LETTER`: the registry render is used only once its version is published (a draft-only or unknown code falls back to the rule-10 body above). */
  private hasActiveVersion(svc: NoticeService, asOf: PlainDate): boolean {
    try { svc.template(FIRST_PAYMENT_LETTER); } catch { return false; }
    const reg = (svc as unknown as { deps?: { registry?: { activeVersion(code: string, asOf: PlainDate): unknown } } }).deps?.registry;
    return reg?.activeVersion(FIRST_PAYMENT_LETTER, asOf) !== undefined;
  }
  private esignConsentFor(r: OrigLoanRecord, partyId: string): EsignConsent | null {
    const c = r.consents.find((x) => x.party_id === partyId && x.kind === "esign"); if (!c || !c.verified) return null;
    const src = r.snapshot.consents.find((x) => x.id === c.consent_id)!;
    return { party_id: partyId, classes: c.scope, disclosure_version: c.basis_disclosure_version ?? "", status: "active", consented_on: plainDate(src.captured_at.slice(0, 10)), verified_on: plainDate(src.captured_at.slice(0, 10)), soft_bounces_30d: 0 };
  }
  /** 26.4's MERS acknowledgment for the loan's MIN: `mers.min.registered{status=active}` (26.4's event) clears OW-004. */
  recordMersAcknowledgment(applicationId: string, ack: { min: string; status: "active" | "rejected"; acknowledged_at: string; codes?: readonly string[] }): { cleared: boolean; event: DomainEvent } {
    const r = this.record(applicationId);
    if (ack.min !== r.mapped.loans.min) throw new RangeError(`MIN ${ack.min} is not the loan's MIN ${r.mapped.loans.min}`);
    if (ack.status !== "active") { const e = this.append(r, "mers.min.registration_rejected", { min: ack.min, codes: [...(ack.codes ?? [])], acknowledged_at: ack.acknowledged_at }, { kind: "external", id: "mers" }); this.d.escalations?.open({ kind: "officer", ownerRole: "ops_analyst", loanId: r.loan_id, applicationId: r.application_id, severity: "sev3", payload: { reason: "MIN registration rejected — OW-004 escalates to post-closing; boarding is not undone", codes: ack.codes ?? [] } }, BOARDING_AGENT); return { cleared: false, event: e }; }
    const e = this.append(r, "mers.min.registered", { min: ack.min, status: "active", registration_kind: "mom", acknowledged_at: ack.acknowledged_at }, { kind: "external", id: "mers" });
    const cleared = this.clearWarning(applicationId, "OW-004", "MERS acknowledgment: MIN active", { kind: "external", id: "mers" });
    return { cleared, event: e };
  }
  /** A vendor/trailing-document/tax-service fact that clears one OW-* row (30.4's acks feed OW-006/OW-007; recordings clear OW-008; title OW-009). */
  clearWarning(applicationId: string, ruleCode: string, evidence: string, actor: Actor = BOARDING_AGENT): boolean {
    const r = this.record(applicationId);
    const v = r.validations.find((x) => x.code === ruleCode && x.severity === "warning" && x.result === "fail" && !x.resolved);
    if (!v) return false;
    v.resolved = { by: `${actor.kind}:${actor.id}`, resolution: "cleared", reason: evidence, at: this.now() };
    this.warningResolved(r, ruleCode, actor);
    return true;
  }
  private warningResolved(r: OrigLoanRecord, ruleCode: string, actor: Actor): void {
    this.append(r, "loan.boarding_warning.resolved", { rule_code: ruleCode, open_warnings: this.openWarnings(r).map((v) => v.code) }, actor);
    if (this.openWarnings(r).length === 0 && r.boarded_at) this.append(r, "loan.boarding.warnings_cleared", { boarded_at: r.boarded_at }, actor);
  }
  recordVendorActivation(applicationId: string, kind: "tax_service" | "flood_lol" | "insurance_tracking" | "mi"): void {
    const r = this.record(applicationId); r.vendor_acks.add(kind);
    if (kind === "tax_service") this.clearWarning(applicationId, "OW-006", "tax service parcel match");
    if (kind === "flood_lol") this.clearWarning(applicationId, "OW-007", "flood LOL contract linked");
  }
  /** `active`: warnings cleared/waived, letter sent (proof of mailing), vendor activations acked (30.4). `loan.active` closes SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE. */
  activate(applicationId: string, requiredVendorAcks: readonly ("tax_service" | "flood_lol" | "insurance_tracking" | "mi")[] = ["tax_service", "flood_lol", "insurance_tracking"]): { ok: true; active_at: string } | { ok: false; reason: string } {
    const r = this.record(applicationId);
    const t = origTailMachine.attempt(r.status, "activate", BOARDING_AGENT, { openWarnings: this.openWarnings(r).length, letterSent: r.letters.some((l) => l.status === "sent"), vendorAcksComplete: requiredVendorAcks.every((k) => r.vendor_acks.has(k)) });
    if (!t.ok) return { ok: false, reason: t.reason };
    const now = this.now(); r.status = "active"; r.active_at = now;
    this.append(r, "loan.active", { active_at: now, servicing_loan_number: r.servicing_loan_number, first_payment_date: r.mapped.loans.first_payment_date });
    return { ok: true, active_at: now };
  }
  /** Rule 11: on 30.1's `loan.purchased` the investor fields flip and OB-022 is re-run inverted. */
  recordPurchase(applicationId: string, p: { fnma_loan_number: string; purchase_date: PlainDate; purchase_advice_document_id?: string | null }): { ob_022: OrigValidation; identifier_check: ReturnType<typeof fnmaEstablishmentIdentifierCheck> } {
    const r = this.record(applicationId);
    if (!/^\d{10}$/.test(p.fnma_loan_number)) throw new RangeError("fnma_loan_number must be 10 digits");
    r.mapped = { ...r.mapped, loans: { ...r.mapped.loans, investor: "fnma", fnma_loan_number: p.fnma_loan_number } };
    const res = OB_RULES.find((x) => x.code === "OB-022")!.check({ s: r.snapshot, m: r.mapped, funded: r.funded, ext: this.d.ext });
    const v: OrigValidation = { code: "OB-022", severity: "hard", money_field: false, ...res, id: ++this.validationSeq, run_id: randomUUID(), application_id: r.application_id, loan_id: r.loan_id, rule_set_version: RULE_SET_VERSION_30_2 };
    r.validations = [...r.validations.filter((x) => x.code !== "OB-022"), v];
    if (p.purchase_advice_document_id) r.documents_index.push({ loan_id: r.loan_id, document_id: p.purchase_advice_document_id, kind: "purchase_advice", retention_class: retentionClassFor("purchase_advice"), custody: "platform", required_for_servicing_file: false, trailing: false });
    this.append(r, "boarding.purchase_update.applied", { investor: "fnma", fnma_loan_number: p.fnma_loan_number, purchase_date: p.purchase_date, ob_022: v.result });
    return { ob_022: v, identifier_check: fnmaEstablishmentIdentifierCheck({ servicing_loan_number: r.servicing_loan_number, fnma_recorded_servicer_loan_identifier: r.servicing_loan_number, fnma_loan_number: p.fnma_loan_number }) };
  }
  /** Edge case: funding reversed / rescission exercised after disbursement — reverse opening entries, `unwound`; no servicing record survives except the audit trail. */
  unwind(applicationId: string, reason: string, actor: Actor): { status: "unwound"; reversal_set_id: string | null } {
    const r = this.record(applicationId);
    if (actor.kind !== "human" || actor.role !== "officer") throw new RangeError("unwinding a funded loan moves money — officer approval required (26.3)");
    const t = origTailMachine.attempt(r.status, "unwind", actor, { openWarnings: 0, letterSent: false, vendorAcksComplete: false });
    if (!t.ok) throw new RangeError(t.reason);
    const rev = r.opening_entry_set_id ? this.d.ledger.reverse(r.opening_entry_set_id, plainDate(this.now().slice(0, 10)), reason, this.now()) : null;
    r.status = "unwound";
    this.append(r, "loan.unwound", { reason, reversal_set_id: rev?.id ?? null }, actor);
    return { status: "unwound", reversal_set_id: rev?.id ?? null };
  }
  /** Rule 8 / T11: the §1024.38(c)(2) servicing file for the boarded loan — compiled from what boarding already wrote. */
  compileServicingFile(applicationId: string): ServicingFile {
    const t0 = performance.now(); const r = this.record(applicationId);
    if (!r.boarded_at) throw new RangeError("the servicing file exists from loan.boarded");
    const schedule = this.d.ledger.sets().filter((s) => s.lines.some((l) => l.account.scope === "loan" && l.account.loanId === r.loan_id)).flatMap((s) => s.lines.map((l) => ({ set_id: s.id, effective_date: s.effectiveDate, account: l.account.scope === "loan" ? `loan:${l.account.account}` : l.account.scope === "custodial" ? `custodial:${l.account.account}` : `corporate:${l.account.account}`, amount_cents: l.amountCents.toString(), rule_ref: l.ruleRef })));
    const contacts = this.d.events.byLoan(r.loan_id).filter((e) => e.type.startsWith("contact."));   // the servicing contact log starts at boarding; origination interactions are linked, not notes
    const submissions = this.d.events.byLoan(r.loan_id).filter((e) => e.type === "noe.received" || e.type === "rfi.received" || e.type === "lossmit.application.received");
    const compiled_at = this.now(); const ms = performance.now() - t0;
    const file: ServicingFile = { loan_id: r.loan_id, compiled_at, transaction_schedule: schedule, security_instrument: r.documents_index.find((d) => d.required_for_servicing_file) ?? null, contact_log: contacts, data_field_report: r.mapped.staging, borrower_submissions: submissions, compile_ms: ms, within_five_minutes: ms < SERVICING_FILE_COMPILE_LIMIT_MS, within_five_days: daysBetween(plainDate(r.boarded_at.slice(0, 10)), plainDate(compiled_at.slice(0, 10))) <= 5 };
    this.append(r, "servicing_file.compiled", { compile_ms: Math.round(ms), transaction_lines: schedule.length, security_instrument_document_id: file.security_instrument?.document_id ?? null, contact_notes: contacts.length, data_fields: r.mapped.staging.length, borrower_submissions: submissions.length });
    return file;
  }
  /** Decision record (AI agent design): the boarding decision the audit exports. */
  decisionRecord(applicationId: string, run: { rule_set_version?: string; model_version: string | null; prompt_version: string | null; rationale: string; confidence: number | null }): Record<string, unknown> {
    const r = this.record(applicationId);
    return { loan_id: r.loan_id, application_id: r.application_id, funding_date: r.funded.funding_date, validations: r.validations.map((v) => ({ rule_code: v.code, result: v.result, resolved: v.resolved ?? null })), corrections: r.corrections, consent_scope_decisions: r.consents.map((c) => ({ party_id: c.party_id, classes_granted: c.scope, basis_disclosure_version: c.basis_disclosure_version })), ledger_entry_ids: r.opening_entry_set_id ? [r.opening_entry_set_id] : [], timers_seeded: r.seeded.map((s) => s.code), letter_notice_id: r.letters.find((l) => l.status === "sent")?.notice_id ?? null, rule_set_version: run.rule_set_version ?? RULE_SET_VERSION_30_2, mapping_version: r.mapped.mapping_version, model_version: run.model_version, prompt_version: run.prompt_version, rationale: run.rationale, confidence: run.confidence };
  }
}

/**
 * The pure, importable entry point the platform lifecycle test and the hosted runtime call at `loan.funded`.
 *
 * Input shape:
 *   deps      — { events, ledger, clock, ext: { licensed(state), onPlatform(kind, value), mers(min) }, prepurchaseTiAccountId,
 *                 timers? (TimerEngine subscribed to `events`, so the registry rows arm on the events below), escalations?, notices?,
 *                 calendars?, servicerTz?, loanIdFor?, letterContext? } — or an already-constructed OriginationBoardingService
 *   snapshot  — OriginationSnapshot: the in-memory origination aggregate at funding (applications + application_borrowers +
 *                 applicant_demographics + application_properties, signed-note terms, final CD figures, 30.3's initial escrow
 *                 analysis, MI/hazard/flood, MIN + custody, consents + disclosure versions, documents, trailing-document flags)
 *   funded    — LoanFundedPayload: 26.3's `loan.funded` payload (funded_at, funding_date, disbursement_date, funded amount,
 *                 per diem / prepaid interest, interest_credit, rescission_expires_at, event_id when the event is already stored)
 *   opts      — { sent_on?: letter date (default: the funding date), mailed_at?: proof-of-mailing instant }
 *
 * Runs: ingest (idempotent by application id) → stage (servicing loan number, LBDS mapping) → validate (OB-* and OW-* rules) →
 * board (opening ledger, `loan.boarded`) → consents → documents → timers → first statement cycle → first-payment letter.
 * A hard failure stops at `exception` with `refusal` set (defects routed to their owners); the loan never boards until the
 * source record is corrected. Returns the created loan id, validations, ledger set, armed timers, letters and consents.
 */
export async function boardFundedApplication(deps: OrigBoardingDeps | OriginationBoardingService, snapshot: OriginationSnapshot, funded: LoanFundedPayload, opts: { sent_on?: PlainDate; mailed_at?: string | null } = {}): Promise<BoardFundedResult & { service: OriginationBoardingService }> {
  const svc = deps instanceof OriginationBoardingService ? deps : new OriginationBoardingService(deps);
  const timers = svc.d.timers;
  const armed = (r: OrigLoanRecord) => (timers ? [...timers.forSubject("loan", r.loan_id), ...timers.forSubject("application", r.application_id)] : []);
  const intake = svc.ingestFunded(snapshot, funded);
  const r = intake.record;
  const base = (refusal: string | null, ledger_set: EntrySet | null, duplicate: boolean): BoardFundedResult & { service: OriginationBoardingService } => ({ status: r.status, loan_id: r.loan_id, application_id: r.application_id, servicing_loan_number: r.servicing_loan_number, validations: r.validations, ledger_set, timers: armed(r), seed_plan: r.seeded, letters: r.letters, consents: r.consents, documents_index: r.documents_index, duplicate, refusal, service: svc });
  if (intake.status === "duplicate") return base("duplicate loan.funded ignored (idempotent by application id)", null, true);
  const v = svc.validate(snapshot.application_id);
  if (v.status === "exception") {
    for (const x of svc.openHard(r)) if (x.money_field) svc.routeToOwner(snapshot.application_id, x.code);
    return base(`boarding refused: open hard failures ${svc.openHard(r).map((x) => x.code).join(", ")}`, null, false);
  }
  const b = svc.board(snapshot.application_id);
  if (!b.ok) return base(`boarding refused: ${b.reason}`, null, false);
  svc.boardConsents(snapshot.application_id);
  svc.indexDocuments(snapshot.application_id);
  svc.seedTimers(snapshot.application_id);
  svc.openFirstStatementCycle(snapshot.application_id);
  await svc.sendFirstPaymentLetter(snapshot.application_id, { sent_on: opts.sent_on ?? funded.funding_date, mailed_at: opts.mailed_at ?? null });
  return base(null, b.ledger_set, false);
}
