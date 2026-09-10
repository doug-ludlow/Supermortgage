/**
 * Transfer-batch tape codec: the CSV files a transferor delivers under 1.1
 * ("Inputs and triggers": boarding_tape.final, payment_history, escrow_history,
 * escrow_analysis, lossmit_file, fc_bk_file, consents_file, images_manifest,
 * trial_balance) plus the two external positions the DQ gate compares against
 * (the LSDU position pull and a MERS lookup), mapped to and from the canonical
 * `StagedLoan` the gate evaluates.
 *
 * The spec's mapping is per transferor (transferor column → MISMO v3.6 path →
 * canonical field, `mapping_rules`); this module is the mapping set for the
 * demo transferor's layout and the reference layout documented in
 * fixtures/transfer-batch-demo/LAYOUT.md. Money is a decimal dollar string on
 * tape and bigint cents in the record; dates are ISO; booleans are Y/N.
 */
import { cents, formatCents } from "../../kernel/money/cents.ts";
import { plainDate, type PlainDate } from "../../kernel/calendar/date.ts";
import type { StagedLoan, FnmaPosition, MersRecord, Installment, HistoricalPayment, InterestMethod, Amortization } from "./types.ts";

// ───────── CSV ─────────
export function csvEscape(v: string): string { return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }
export function toCsv(columns: readonly string[], rows: readonly Record<string, string>[]): string {
  const lines = [columns.map(csvEscape).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvEscape(r[c] ?? "")).join(","));
  return lines.join("\n") + "\n";
}
/** RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF. Returns objects keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() ?? [];
  return rows.filter((r) => r.length > 1 || (r[0] ?? "") !== "").map((r) => Object.fromEntries(header.map((h, k) => [h, r[k] ?? ""])));
}

// ───────── field encodings ─────────
const money = (c: bigint | null | undefined): string => (c === null || c === undefined ? "" : formatCents(c, { symbol: false, grouping: false }));
const yn = (b: boolean | null | undefined): string => (b === null || b === undefined ? "" : b ? "Y" : "N");
const str = (s: string | number | null | undefined): string => (s === null || s === undefined ? "" : String(s));
const rMoney = (s: string): bigint | null => (s === "" ? null : cents(s));
const rYn = (s: string): boolean | null => (s === "" ? null : s === "Y");
const rStr = (s: string): string | null => (s === "" ? null : s);
const rNum = (s: string): number | null => (s === "" ? null : Number(s));
const rDate = (s: string): PlainDate | null => (s === "" ? null : plainDate(s));

/** Column dictionary of `boarding_tape.final.csv`: column, illustrative MISMO v3.6 path, canonical field, and the DQ rules that read it. */
export const FINAL_TAPE_COLUMNS: readonly { column: string; mismo: string; field: string; rules: string }[] = [
  { column: "transferor_loan_number", mismo: "LOAN/LOAN_IDENTIFIERS/LOAN_IDENTIFIER[@LoanIdentifierType='ServicerLoanIdentifier']", field: "transferor_loan_number", rules: "HF-003 (trial balance key)" },
  { column: "fnma_loan_number", mismo: "LOAN/LOAN_IDENTIFIERS/LOAN_IDENTIFIER[@LoanIdentifierType='InvestorLoanIdentifier']", field: "fnma_loan_number", rules: "HF-001, HF-002, HF-003, HF-017" },
  { column: "min", mismo: "LOAN/LOAN_IDENTIFIERS/LOAN_IDENTIFIER[@LoanIdentifierType='MERS_MIN']", field: "min", rules: "HF-008, HF-017, W-016" },
  { column: "mers_eligible", mismo: "LOAN/LOAN_DETAIL/MERSRegistrationIndicator", field: "mers_eligible", rules: "MERS_PROC_REGISTER_UNREGISTERED_7" },
  { column: "remittance_type", mismo: "LOAN/INVESTOR_LOAN_INFORMATION/InvestorRemittanceType (A/A, S/A, S/S)", field: "remittance_type", rules: "HF-002, HF-003" },
  { column: "upb", mismo: "LOAN/LOAN_DETAIL/UPBAmount", field: "upb_cents", rules: "HF-003, HF-005" },
  { column: "scheduled_upb", mismo: "LOAN/INVESTOR_LOAN_INFORMATION/ScheduledUPBAmount (S/S only)", field: "scheduled_upb_cents", rules: "HF-003" },
  { column: "next_due_date", mismo: "LOAN/PAYMENT/PAYMENT_SUMMARY/NextPaymentDueDate", field: "next_due_date", rules: "HF-004, SM_BOARD_FIRST_CYCLE" },
  { column: "note_rate_pct", mismo: "LOAN/TERMS_OF_LOAN/NoteRatePercent", field: "note_rate_pct", rules: "HF-005, HF-012, W-014" },
  { column: "pi_payment", mismo: "LOAN/PAYMENT/PAYMENT_SUMMARY/ScheduledPrincipalAndInterestPaymentAmount", field: "pi_cents", rules: "HF-005, W-010" },
  { column: "escrow_payment", mismo: "LOAN/ESCROW/ESCROW_DETAIL/EscrowMonthlyPaymentAmount", field: "escrow_payment_cents", rules: "W-010" },
  { column: "maturity_date", mismo: "LOAN/MATURITY/MATURITY_RULE/LoanMaturityDate", field: "maturity_date", rules: "HF-005" },
  { column: "original_term_months", mismo: "LOAN/MATURITY/MATURITY_RULE/LoanMaturityPeriodCount", field: "original_term_months", rules: "HF-005" },
  { column: "original_upb", mismo: "LOAN/TERMS_OF_LOAN/NoteAmount", field: "original_upb_cents", rules: "HF-005" },
  { column: "instrument_date", mismo: "LOAN/TERMS_OF_LOAN/NoteDate", field: "instrument_date", rules: "1.4 custody" },
  { column: "origination_date", mismo: "LOAN/ORIGINATION_SYSTEMS/LoanOriginationDate", field: "origination_date", rules: "W-011" },
  { column: "first_payment_date", mismo: "LOAN/PAYMENT/PAYMENT_RULE/ScheduledFirstPaymentDate", field: "first_payment_date", rules: "amortization" },
  { column: "interest_method", mismo: "LOAN/TERMS_OF_LOAN/InterestCalculationBasisType (30_360, actual_360, actual_365, daily_simple)", field: "interest_method", rules: "HF-005, W-014" },
  { column: "amortization", mismo: "LOAN/AMORTIZATION/AMORTIZATION_RULE/AmortizationType (fixed, arm, step, balloon, interest_only, buydown)", field: "amortization", rules: "HF-005, HF-006" },
  { column: "arm_index", mismo: "LOAN/ADJUSTMENT/INTEREST_RATE_ADJUSTMENT/INDEX_RULES/INDEX_RULE/IndexType", field: "arm.index", rules: "HF-006" },
  { column: "arm_margin_bps", mismo: "…/INTEREST_RATE_LIFETIME_ADJUSTMENT_RULE/MarginRatePercent (basis points)", field: "arm.margin_bps", rules: "HF-006" },
  { column: "arm_initial_cap_bps", mismo: "…/INTEREST_RATE_PER_CHANGE_ADJUSTMENT_RULE[First]/PerChangeMaximumIncreaseRatePercent", field: "arm.initial_cap_bps", rules: "HF-006" },
  { column: "arm_periodic_cap_bps", mismo: "…/INTEREST_RATE_PER_CHANGE_ADJUSTMENT_RULE[Subsequent]/PerChangeMaximumIncreaseRatePercent", field: "arm.periodic_cap_bps", rules: "HF-006" },
  { column: "arm_lifetime_cap_bps", mismo: "…/INTEREST_RATE_LIFETIME_ADJUSTMENT_RULE/CeilingRatePercent − NoteRatePercent", field: "arm.lifetime_cap_bps", rules: "HF-006" },
  { column: "arm_lookback_days", mismo: "…/INDEX_RULE/IndexLookbackDaysCount", field: "arm.lookback_days", rules: "HF-006" },
  { column: "arm_next_change_date", mismo: "…/INTEREST_RATE_ADJUSTMENT/NextRateAdjustmentEffectiveDate", field: "arm.next_change_date", rules: "HF-006" },
  { column: "escrowed", mismo: "LOAN/ESCROW/ESCROW_DETAIL/EscrowIndicator", field: "escrowed", rules: "HF-007, W-009" },
  { column: "escrow_balance", mismo: "LOAN/ESCROW/ESCROW_DETAIL/EscrowBalanceAmount (negative = shortage/advance)", field: "escrow_balance_cents", rules: "HF-007, 1.6" },
  { column: "late_charge_pct", mismo: "LOAN/LATE_CHARGE/LATE_CHARGE_RULE/LateChargeRatePercent", field: "late_charge_pct", rules: "HF-015" },
  { column: "late_charge_grace_days", mismo: "LOAN/LATE_CHARGE/LATE_CHARGE_RULE/LateChargeGracePeriodDaysCount", field: "late_charge_grace_days", rules: "HF-015" },
  { column: "deferred_principal", mismo: "LOAN/LOAN_DETAIL/DeferredPrincipalBalanceAmount (D2-3.2-04 NIB)", field: "deferred_principal_cents", rules: "HF-016" },
  { column: "forborne_principal", mismo: "LOAN/LOAN_DETAIL/ForbornePrincipalBalanceAmount", field: "forborne_principal_cents", rules: "HF-016" },
  { column: "nib_separated", mismo: "servicer extension: NIB balances carried outside interest-bearing UPB", field: "nib_separated", rules: "HF-016" },
  { column: "bk_active", mismo: "LOAN/BANKRUPTCY/BankruptcyIndicator (details in fc_bk_file)", field: "bankruptcy.active", rules: "HF-009, 14.1" },
  { column: "fc_active", mismo: "LOAN/FORECLOSURE/ForeclosureIndicator (details in fc_bk_file)", field: "foreclosure.active", rules: "HF-010, 13.x" },
  { column: "lm_in_process", mismo: "LOAN/LOSS_MITIGATION/LossMitigationInProcessIndicator (details in lossmit_file)", field: "lossmit.in_process", rules: "HF-011, 1.7" },
  { column: "scra_active", mismo: "LOAN/SERVICEMEMBER/SCRAProtectionIndicator", field: "scra.active", rules: "HF-012, 13.9" },
  { column: "scra_rate_cap_reason", mismo: "servicer extension: reason the 6% cap applies", field: "scra.rate_cap_reason", rules: "HF-012" },
  { column: "borrower_name", mismo: "PARTY[Borrower]/INDIVIDUAL/NAME/FullName", field: "borrower.legal_name", rules: "HF-013" },
  { column: "borrower_tin", mismo: "PARTY[Borrower]/TAXPAYER_IDENTIFIERS/TaxpayerIdentifierValue (PII, encrypted at rest)", field: "borrower.tin", rules: "HF-013" },
  { column: "borrower_phone", mismo: "PARTY[Borrower]/CONTACT_POINTS/CONTACT_POINT_TELEPHONE/ContactPointTelephoneValue", field: "borrower.phone", rules: "W-001" },
  { column: "borrower_email", mismo: "PARTY[Borrower]/CONTACT_POINTS/CONTACT_POINT_EMAIL/ContactPointEmailValue", field: "borrower.email", rules: "W-001" },
  { column: "borrower_language", mismo: "PARTY[Borrower]/LANGUAGES/LANGUAGE/LanguageCode (F-1-11 preferred language)", field: "borrower.preferred_language", rules: "W-012" },
  { column: "coborrower_name", mismo: "PARTY[CoBorrower]/INDIVIDUAL/NAME/FullName", field: "(unmapped → boarding_staging raw, flagged info)", rules: "—" },
  { column: "property_address1", mismo: "PROPERTY/ADDRESS/AddressLineText", field: "property.address_line1", rules: "HF-014" },
  { column: "property_city", mismo: "PROPERTY/ADDRESS/CityName", field: "property.city", rules: "—" },
  { column: "property_state", mismo: "PROPERTY/ADDRESS/StateCode", field: "property.state", rules: "HF-014, HF-020" },
  { column: "property_zip", mismo: "PROPERTY/ADDRESS/PostalCode", field: "property.postal_code", rules: "—" },
  { column: "occupancy", mismo: "PROPERTY/PROPERTY_DETAIL/PropertyUsageType (owner_occupied, second_home, investment)", field: "property.occupancy", rules: "—" },
  { column: "custodian", mismo: "DOCUMENT_CUSTODY/CustodianName", field: "custody.custodian", rules: "HF-018, 1.4" },
  { column: "custody_certification_status", mismo: "DOCUMENT_CUSTODY/CertificationStatus", field: "custody.certification_status", rules: "HF-018, 1.4" },
  { column: "enote_evault_ref", mismo: "LOAN/LOAN_DETAIL/ENoteIndicator + eVault reference (F-1-11 eMortgages)", field: "custody.enote_evault_ref", rules: "HF-018, 1.5" },
  { column: "tax_parcel_verified", mismo: "PROPERTY/PROPERTY_TAX/ParcelIdentificationVerifiedIndicator", field: "tax_parcel_verified", rules: "W-004" },
  { column: "hazard_policy_expires", mismo: "LOAN/HAZARD_INSURANCE/POLICY/PolicyExpirationDate", field: "hazard_policy_expires", rules: "W-005, 9.x" },
  { column: "mi_flag", mismo: "LOAN/MI/MIIndicator", field: "mi.flag", rules: "W-006, 10.x" },
  { column: "mi_certificate_number", mismo: "LOAN/MI/MI_DETAIL/MICertificateIdentifier", field: "mi.certificate_number", rules: "W-006" },
  { column: "flood_determination_life_of_loan", mismo: "LOAN/FLOOD_DETERMINATION/LifeOfLoanIndicator", field: "flood_determination_life_of_loan", rules: "W-007" },
  { column: "sii_present", mismo: "PARTY[SuccessorInInterest] present", field: "sii.present", rules: "W-008, 4.4" },
  { column: "sii_complete", mismo: "PARTY[SuccessorInInterest] confirmation complete", field: "sii.complete", rules: "W-008" },
  { column: "unapplied_funds", mismo: "LOAN/PAYMENT/PAYMENT_SUMMARY/UnappliedFundsAmount (suspense)", field: "unapplied_cents", rules: "W-010, 1.6" },
  { column: "fair_lending_present", mismo: "F-1-11 fair-lending elements delivered (fair_lending.csv, restricted)", field: "fair_lending_present", rules: "W-011" },
  { column: "acp_enrolled", mismo: "PARTY[Borrower]/AddressConfidentialityProgramIndicator", field: "acp_enrolled", rules: "W-013" },
  { column: "fees_advances", mismo: "LOAN/FEES/FeeTotalAmount (recoverable fees + advances owed)", field: "fees_advances_cents", rules: "W-015, 1.6" },
  { column: "fees_itemized", mismo: "itemization delivered (A2-7-03)", field: "fees_itemized", rules: "W-015" },
  { column: "corporate_advances", mismo: "LOAN/ADVANCES/CorporateAdvanceBalanceAmount", field: "corporate_advances_cents", rules: "1.6" },
  { column: "late_charges_due", mismo: "LOAN/LATE_CHARGE/LateChargeDueAmount", field: "late_charges_due_cents", rules: "1.6" },
  { column: "mers_investor_is_fnma", mismo: "MERS Investor/Note-Owner field = Fannie Mae", field: "mers_investor_is_fnma", rules: "W-016, 1.5" },
  { column: "last_principal_applied", mismo: "LOAN/PAYMENT/PAYMENT_SUMMARY/LastPrincipalAppliedAmount", field: "last_principal_applied_cents", rules: "W-014" },
];
export const FINAL_TAPE_HEADER: readonly string[] = FINAL_TAPE_COLUMNS.map((c) => c.column);

export const PAYMENT_HISTORY_HEADER = ["transferor_loan_number", "due_date", "scheduled_amount", "received_on", "received_amount"] as const;
export const ESCROW_HISTORY_HEADER = ["transferor_loan_number", "line_type", "annual_amount", "next_due_date"] as const;
export const ESCROW_ANALYSIS_HEADER = ["transferor_loan_number", "last_analysis_date", "escrow_balance", "balance_sign_consistent"] as const;
export const LOSSMIT_HEADER = ["transferor_loan_number", "application_status", "received_on"] as const;
export const FC_BK_HEADER = ["transferor_loan_number", "bk_chapter", "bk_case_number", "bk_filed_on", "fc_referral_date", "fc_attorney"] as const;
export const CONSENTS_HEADER = ["transferor_loan_number", "esign_evidence", "tcpa_voice_evidence"] as const;
export const IMAGES_HEADER = ["transferor_loan_number", "document_type", "filename", "sha256"] as const;
export const TRIAL_BALANCE_HEADER = ["transferor_loan_number", "fnma_loan_number", "upb_as_of_t_minus_1"] as const;
export const FNMA_POSITION_HEADER = ["fnma_loan_number", "on_approved_list", "remittance_type", "upb", "scheduled_upb"] as const;
export const MERS_LOOKUP_HEADER = ["min", "status", "servicer_org_id", "investor_org_id"] as const;
export const FAIR_LENDING_HEADER = ["transferor_loan_number", "ethnicity", "race", "sex", "age", "preferred_language"] as const;

/** The files of one transfer batch, keyed by the spec's file name. */
export interface TransferBatchFiles {
  readonly "boarding_tape.final.csv": string;
  readonly "payment_history.csv": string;
  readonly "escrow_history.csv": string;
  readonly "escrow_analysis.csv": string;
  readonly "lossmit_file.csv": string;
  readonly "fc_bk_file.csv": string;
  readonly "consents_file.csv": string;
  readonly "images_manifest.csv": string;
  readonly "trial_balance.csv": string;
  readonly "fnma_position.csv": string;
  readonly "mers_lookup.csv": string;
  readonly "fair_lending.csv": string;
}
export interface ImageRow { readonly transferor_loan_number: string; readonly document_type: string; readonly filename: string; readonly sha256: string; }
export interface FairLendingRow { readonly transferor_loan_number: string; readonly ethnicity: string; readonly race: string; readonly sex: string; readonly age: string; readonly preferred_language: string; }
export interface TransferBatchData {
  readonly loans: readonly StagedLoan[];
  readonly fnma: readonly FnmaPosition[];
  readonly trialBalance: readonly { transferor_loan_number: string; fnma_loan_number: string | null; upb_cents: bigint }[];
  readonly mers: readonly MersRecord[];
  readonly images: readonly ImageRow[];
  readonly fairLending: readonly FairLendingRow[];
}

// ───────── encode ─────────
export function encodeFinalTapeRow(l: StagedLoan): Record<string, string> {
  const a = l.arm ?? {};
  return {
    transferor_loan_number: l.transferor_loan_number, fnma_loan_number: str(l.fnma_loan_number), min: str(l.min), mers_eligible: yn(l.mers_eligible), remittance_type: str(l.remittance_type),
    upb: money(l.upb_cents), scheduled_upb: money(l.scheduled_upb_cents), next_due_date: str(l.next_due_date), note_rate_pct: str(l.note_rate_pct), pi_payment: money(l.pi_cents), escrow_payment: money(l.escrow_payment_cents),
    maturity_date: str(l.maturity_date), original_term_months: str(l.original_term_months), original_upb: money(l.original_upb_cents), instrument_date: l.instrument_date, origination_date: str(l.origination_date), first_payment_date: str(l.first_payment_date),
    interest_method: str(l.interest_method), amortization: l.amortization,
    arm_index: str(a.index), arm_margin_bps: str(a.margin_bps), arm_initial_cap_bps: str(a.initial_cap_bps), arm_periodic_cap_bps: str(a.periodic_cap_bps), arm_lifetime_cap_bps: str(a.lifetime_cap_bps), arm_lookback_days: str(a.lookback_days), arm_next_change_date: str(a.next_change_date),
    escrowed: yn(l.escrowed), escrow_balance: money(l.escrow_balance_cents), late_charge_pct: str(l.late_charge_pct), late_charge_grace_days: str(l.late_charge_grace_days),
    deferred_principal: money(l.deferred_principal_cents), forborne_principal: money(l.forborne_principal_cents), nib_separated: yn(l.nib_separated),
    bk_active: yn(l.bankruptcy.active), fc_active: yn(l.foreclosure.active), lm_in_process: yn(l.lossmit.in_process), scra_active: yn(l.scra.active), scra_rate_cap_reason: str(l.scra.rate_cap_reason),
    borrower_name: str(l.borrower.legal_name), borrower_tin: str(l.borrower.tin), borrower_phone: str(l.borrower.phone), borrower_email: str(l.borrower.email), borrower_language: str(l.borrower.preferred_language), coborrower_name: "",
    property_address1: str(l.property.address_line1), property_city: str(l.property.city), property_state: str(l.property.state), property_zip: str(l.property.postal_code), occupancy: str(l.property.occupancy),
    custodian: str(l.custody?.custodian), custody_certification_status: str(l.custody?.certification_status), enote_evault_ref: str(l.custody?.enote_evault_ref),
    tax_parcel_verified: yn(l.tax_parcel_verified), hazard_policy_expires: str(l.hazard_policy_expires), mi_flag: yn(l.mi.flag), mi_certificate_number: str(l.mi.certificate_number), flood_determination_life_of_loan: yn(l.flood_determination_life_of_loan),
    sii_present: yn(l.sii.present), sii_complete: yn(l.sii.complete), unapplied_funds: money(l.unapplied_cents), fair_lending_present: yn(l.fair_lending_present), acp_enrolled: yn(l.acp_enrolled),
    fees_advances: money(l.fees_advances_cents), fees_itemized: yn(l.fees_itemized), corporate_advances: money(l.corporate_advances_cents), late_charges_due: money(l.late_charges_due_cents), mers_investor_is_fnma: yn(l.mers_investor_is_fnma),
    last_principal_applied: money(l.last_principal_applied_cents),
  };
}

export function encodeTransferBatch(d: TransferBatchData, coborrowers: ReadonlyMap<string, string> = new Map()): TransferBatchFiles {
  const finalRows = d.loans.map((l) => ({ ...encodeFinalTapeRow(l), coborrower_name: coborrowers.get(l.transferor_loan_number) ?? "" }));
  const payments: Record<string, string>[] = [];
  for (const l of d.loans) {
    // the transferor's history pairs each scheduled installment with the receipt that satisfied it, in FIFO order (schedule order)
    const sched = [...l.installments].sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
    const paid = [...l.payments].sort((a, b) => (a.received_on < b.received_on ? -1 : a.received_on > b.received_on ? 1 : 0));
    sched.forEach((i, k) => { const p = paid[k]; payments.push({ transferor_loan_number: l.transferor_loan_number, due_date: i.due_date, scheduled_amount: money(i.amount_cents), received_on: p ? p.received_on : "", received_amount: p ? money(p.amount_cents) : "" }); });
  }
  const escrow: Record<string, string>[] = [];
  for (const l of d.loans) for (const e of l.escrow_lines) escrow.push({ transferor_loan_number: l.transferor_loan_number, line_type: e.line_type, annual_amount: money(e.annual_amount_cents), next_due_date: str(e.next_due_date) });
  const analysis = d.loans.filter((l) => l.escrowed).map((l) => ({ transferor_loan_number: l.transferor_loan_number, last_analysis_date: str(l.last_escrow_analysis_date), escrow_balance: money(l.escrow_balance_cents), balance_sign_consistent: yn(l.escrow_sign_consistent) }));
  const lossmit = d.loans.filter((l) => l.lossmit.in_process).map((l) => ({ transferor_loan_number: l.transferor_loan_number, application_status: str(l.lossmit.application_status), received_on: str(l.lossmit.received_on) }));
  const fcbk = d.loans.filter((l) => l.bankruptcy.active || l.foreclosure.active).map((l) => ({ transferor_loan_number: l.transferor_loan_number, bk_chapter: str(l.bankruptcy.chapter), bk_case_number: str(l.bankruptcy.case_number), bk_filed_on: str(l.bankruptcy.filed_on), fc_referral_date: str(l.foreclosure.referral_date), fc_attorney: str(l.foreclosure.attorney) }));
  const consents = d.loans.map((l) => ({ transferor_loan_number: l.transferor_loan_number, esign_evidence: yn(l.consents.esign_evidence), tcpa_voice_evidence: yn(l.consents.tcpa_voice_evidence) }));
  return {
    "boarding_tape.final.csv": toCsv(FINAL_TAPE_HEADER, finalRows),
    "payment_history.csv": toCsv(PAYMENT_HISTORY_HEADER, payments),
    "escrow_history.csv": toCsv(ESCROW_HISTORY_HEADER, escrow),
    "escrow_analysis.csv": toCsv(ESCROW_ANALYSIS_HEADER, analysis),
    "lossmit_file.csv": toCsv(LOSSMIT_HEADER, lossmit),
    "fc_bk_file.csv": toCsv(FC_BK_HEADER, fcbk),
    "consents_file.csv": toCsv(CONSENTS_HEADER, consents),
    "images_manifest.csv": toCsv(IMAGES_HEADER, d.images.map((r) => ({ ...r }))),
    "trial_balance.csv": toCsv(TRIAL_BALANCE_HEADER, d.trialBalance.map((r) => ({ transferor_loan_number: r.transferor_loan_number, fnma_loan_number: str(r.fnma_loan_number), upb_as_of_t_minus_1: money(r.upb_cents) }))),
    "fnma_position.csv": toCsv(FNMA_POSITION_HEADER, d.fnma.map((p) => ({ fnma_loan_number: p.fnma_loan_number, on_approved_list: yn(p.on_approved_list), remittance_type: p.remittance_type, upb: money(p.upb_cents), scheduled_upb: money(p.scheduled_upb_cents) }))),
    "mers_lookup.csv": toCsv(MERS_LOOKUP_HEADER, d.mers.map((m) => ({ min: m.min, status: m.status, servicer_org_id: m.servicer_org_id, investor_org_id: str(m.investor_org_id) }))),
    "fair_lending.csv": toCsv(FAIR_LENDING_HEADER, d.fairLending.map((r) => ({ ...r }))),
  };
}

// ───────── decode ─────────
const group = <T extends Record<string, string>>(rows: readonly T[]): Map<string, T[]> => { const m = new Map<string, T[]>(); for (const r of rows) { const k = r["transferor_loan_number"] ?? ""; const a = m.get(k); if (a) a.push(r); else m.set(k, [r]); } return m; };
const optional = <T>(k: string, v: T | null): Record<string, T> => (v === null || v === undefined ? {} : { [k]: v } as Record<string, T>);

export function decodeTransferBatch(files: TransferBatchFiles): TransferBatchData {
  const finalRows = parseCsv(files["boarding_tape.final.csv"]);
  const payments = group(parseCsv(files["payment_history.csv"]));
  const escrow = group(parseCsv(files["escrow_history.csv"]));
  const analysis = group(parseCsv(files["escrow_analysis.csv"]));
  const lossmit = group(parseCsv(files["lossmit_file.csv"]));
  const fcbk = group(parseCsv(files["fc_bk_file.csv"]));
  const consents = group(parseCsv(files["consents_file.csv"]));
  const loans: StagedLoan[] = finalRows.map((r) => {
    const n = r["transferor_loan_number"]!;
    const hist = payments.get(n) ?? [];
    const installments: Installment[] = hist.map((h) => ({ due_date: plainDate(h["due_date"]!), amount_cents: cents(h["scheduled_amount"]!) }));
    const paid: HistoricalPayment[] = hist.filter((h) => h["received_on"]).map((h) => ({ received_on: plainDate(h["received_on"]!), amount_cents: cents(h["received_amount"]!) }));
    const an = (analysis.get(n) ?? [])[0]; const lm = (lossmit.get(n) ?? [])[0]; const fb = (fcbk.get(n) ?? [])[0]; const co = (consents.get(n) ?? [])[0];
    const arm = r["amortization"] === "arm" ? { index: rStr(r["arm_index"]!), margin_bps: rNum(r["arm_margin_bps"]!), initial_cap_bps: rNum(r["arm_initial_cap_bps"]!), periodic_cap_bps: rNum(r["arm_periodic_cap_bps"]!), lifetime_cap_bps: rNum(r["arm_lifetime_cap_bps"]!), lookback_days: rNum(r["arm_lookback_days"]!), next_change_date: rDate(r["arm_next_change_date"]!) } : undefined;
    const custodian = rStr(r["custodian"]!), cert = rStr(r["custody_certification_status"]!), evault = rStr(r["enote_evault_ref"]!);
    const loan: StagedLoan = {
      transferor_loan_number: n, fnma_loan_number: rStr(r["fnma_loan_number"]!), min: rStr(r["min"]!), mers_eligible: rYn(r["mers_eligible"]!) === true, remittance_type: rStr(r["remittance_type"]!),
      upb_cents: rMoney(r["upb"]!), ...optional("scheduled_upb_cents", rMoney(r["scheduled_upb"]!)), next_due_date: rDate(r["next_due_date"]!), note_rate_pct: rStr(r["note_rate_pct"]!), pi_cents: rMoney(r["pi_payment"]!), escrow_payment_cents: rMoney(r["escrow_payment"]!) ?? 0n,
      maturity_date: rDate(r["maturity_date"]!), original_term_months: rNum(r["original_term_months"]!), original_upb_cents: rMoney(r["original_upb"]!), instrument_date: plainDate(r["instrument_date"]!), origination_date: rDate(r["origination_date"]!), first_payment_date: rDate(r["first_payment_date"]!),
      interest_method: rStr(r["interest_method"]!) as InterestMethod | null, amortization: r["amortization"] as Amortization, ...(arm ? { arm } : {}),
      escrowed: rYn(r["escrowed"]!) === true, escrow_balance_cents: rMoney(r["escrow_balance"]!) ?? 0n,
      escrow_lines: (escrow.get(n) ?? []).map((e) => ({ line_type: e["line_type"]!, annual_amount_cents: cents(e["annual_amount"]!), ...(e["next_due_date"] ? { next_due_date: plainDate(e["next_due_date"]) } : {}) })),
      escrow_sign_consistent: an ? rYn(an["balance_sign_consistent"]!) !== false : true, last_escrow_analysis_date: an ? rDate(an["last_analysis_date"]!) : null,
      late_charge_pct: rStr(r["late_charge_pct"]!), late_charge_grace_days: rNum(r["late_charge_grace_days"]!),
      deferred_principal_cents: rMoney(r["deferred_principal"]!) ?? 0n, forborne_principal_cents: rMoney(r["forborne_principal"]!) ?? 0n, nib_separated: rYn(r["nib_separated"]!) !== false,
      bankruptcy: { active: rYn(r["bk_active"]!) === true, ...(fb && rYn(r["bk_active"]!) ? { chapter: rStr(fb["bk_chapter"]!), case_number: rStr(fb["bk_case_number"]!), filed_on: rDate(fb["bk_filed_on"]!) } : {}) },
      foreclosure: { active: rYn(r["fc_active"]!) === true, ...(fb && rYn(r["fc_active"]!) ? { referral_date: rDate(fb["fc_referral_date"]!), attorney: rStr(fb["fc_attorney"]!) } : {}) },
      lossmit: { in_process: rYn(r["lm_in_process"]!) === true, ...(lm ? { application_status: rStr(lm["application_status"]!), received_on: rDate(lm["received_on"]!) } : {}) },
      scra: { active: rYn(r["scra_active"]!) === true, ...optional("rate_cap_reason", rStr(r["scra_rate_cap_reason"]!)) },
      borrower: { legal_name: rStr(r["borrower_name"]!), tin: rStr(r["borrower_tin"]!), ...optional("phone", rStr(r["borrower_phone"]!)), ...optional("email", rStr(r["borrower_email"]!)), ...optional("preferred_language", rStr(r["borrower_language"]!)) },
      property: { address_line1: rStr(r["property_address1"]!), city: rStr(r["property_city"]!), state: rStr(r["property_state"]!), postal_code: rStr(r["property_zip"]!), ...optional("occupancy", rStr(r["occupancy"]!)) },
      custody: custodian || cert || evault ? { ...optional("custodian", custodian), ...optional("certification_status", cert), ...optional("enote_evault_ref", evault) } : null,
      consents: { esign_evidence: co ? rYn(co["esign_evidence"]!) === true : false, tcpa_voice_evidence: co ? rYn(co["tcpa_voice_evidence"]!) === true : false },
      tax_parcel_verified: rYn(r["tax_parcel_verified"]!) === true, hazard_policy_expires: rDate(r["hazard_policy_expires"]!),
      mi: { flag: rYn(r["mi_flag"]!) === true, ...optional("certificate_number", rStr(r["mi_certificate_number"]!)) }, flood_determination_life_of_loan: rYn(r["flood_determination_life_of_loan"]!) === true,
      sii: { present: rYn(r["sii_present"]!) === true, complete: rYn(r["sii_complete"]!) !== false }, unapplied_cents: rMoney(r["unapplied_funds"]!) ?? 0n,
      fair_lending_present: rYn(r["fair_lending_present"]!) === true, acp_enrolled: rYn(r["acp_enrolled"]!) === true,
      fees_advances_cents: rMoney(r["fees_advances"]!) ?? 0n, fees_itemized: rYn(r["fees_itemized"]!) !== false, corporate_advances_cents: rMoney(r["corporate_advances"]!) ?? 0n, late_charges_due_cents: rMoney(r["late_charges_due"]!) ?? 0n,
      mers_investor_is_fnma: rYn(r["mers_investor_is_fnma"]!), installments, payments: paid, ...optional("last_principal_applied_cents", rMoney(r["last_principal_applied"]!)),
    };
    return loan;
  });
  const fnma: FnmaPosition[] = parseCsv(files["fnma_position.csv"]).map((p) => ({ fnma_loan_number: p["fnma_loan_number"]!, on_approved_list: p["on_approved_list"] === "Y", remittance_type: p["remittance_type"] as FnmaPosition["remittance_type"], upb_cents: cents(p["upb"]!), ...(p["scheduled_upb"] ? { scheduled_upb_cents: cents(p["scheduled_upb"]) } : {}) }));
  const trialBalance = parseCsv(files["trial_balance.csv"]).map((t) => ({ transferor_loan_number: t["transferor_loan_number"]!, fnma_loan_number: rStr(t["fnma_loan_number"]!), upb_cents: cents(t["upb_as_of_t_minus_1"]!) }));
  const mers: MersRecord[] = parseCsv(files["mers_lookup.csv"]).map((m) => ({ min: m["min"]!, status: m["status"] as MersRecord["status"], servicer_org_id: m["servicer_org_id"]!, ...(m["investor_org_id"] ? { investor_org_id: m["investor_org_id"] } : {}) }));
  const images = parseCsv(files["images_manifest.csv"]).map((r) => ({ transferor_loan_number: r["transferor_loan_number"]!, document_type: r["document_type"]!, filename: r["filename"]!, sha256: r["sha256"]! }));
  const fairLending = parseCsv(files["fair_lending.csv"]).map((r) => ({ transferor_loan_number: r["transferor_loan_number"]!, ethnicity: r["ethnicity"]!, race: r["race"]!, sex: r["sex"]!, age: r["age"]!, preferred_language: r["preferred_language"]! }));
  return { loans, fnma, trialBalance, mers, images, fairLending };
}
