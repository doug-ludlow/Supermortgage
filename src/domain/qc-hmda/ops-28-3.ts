/**
 * §28.3 HMDA data capture, ULI generation, rate-spread and other derived fields, LAR editing, annual/quarterly submission
 * and public disclosure obligations — the pure rules of the `hmda` agent over the `hmda_records` row of an `applications`
 * aggregate (migration 0068 created the row for 21.6's action-taken write; 0101 adds every other §1003.4(a) data point,
 * `hmda_ulis`, `hmda_lar_files`, `hmda_edit_verifications`, `hmda_coverage_tests`, `hmda_public_notices`,
 * `hmda_correction_log`). One small function per rule / T-id; every function validates, returns a new copy of the record
 * and appends its events with `applicationId` (origination timers arm only on origination context).
 *
 * Reused, never re-implemented: 23.4's `rateSetDate` (21.4 rule 10: the last executed lock version before final action),
 * 25.1's `aporAsOf` + `determineHpml` (rate spread = APR − APOR to 3 dp — the same engine 23.4's HPML test runs, so a
 * mismatch is impossible by construction), 22.2's `applicableScore` (middle of three / lower of two / the one) and 21.1's
 * `demographicsRow` (the 0057 CHECK constraints: no visual observation outside an in-person application).
 *
 * Events (subject = the application unless noted):
 *   hmda.record.created{uli, application_date, loan_purpose}                 hmda.uli.assigned{uli, lei, loan_identifier, check_digit}
 *   hmda.record.field_derived{data_point, value, source}                     hmda.action_taken.recorded{action_taken, action_taken_date, quarter_end, lar_entry_due_on}   [21.6's name; 28.3 finalises code 1/2 — arms HMDA_1003_4F_LAR_ENTRY_Q30]
 *   hmda.record.finalized{uli, completeness_status=complete}                 [satisfies HMDA_1003_4F_LAR_ENTRY_Q30]
 *   hmda.completeness.checked{date, records, complete, incomplete, failed}   [the daily job run — satisfies SM_HMDA_LAR_COMPLETENESS_DAILY]
 *   hmda.completeness.failed{uli, missing_fields, lar_entry_due_on}          hmda.coverage.determined{reporting_year, covered, quarterly_reporter, decided_by, filing_deadline}   [covered=true arms HMDA_1003_5_ANNUAL_0301]
 *   hmda.lar.built{kind, reporting_year, lar_row_count, sha256, edits_target_on}   [arms SM_HMDA_PRE_SUBMISSION_EDITS_0201]
 *   hmda.lar.uploaded{sequence_number}   hmda.lar.edits_received{status_code}   hmda.lar.quality_verified   hmda.lar.macro_verified{status_code=14, verified_on}   [arms SM_HMDA_OFFICER_SIGN_SLA_5BD]
 *   hmda.lar.signed{signed_by, signed_at}   hmda.lar.accepted{kind, reporting_year, quarter, status_code=15, signed_at, receipt}   [satisfies the annual/quarterly deadlines; 31.3's HMDA_1003_5_LAR_RETENTION_3Y arms on it]
 *   hmda.ffiec.disclosure_notice.received{received_on}   [arms HMDA_1003_5B_DISCLOSURE_NOTICE_3BD]   hmda.public_notice.made_available{kind∈{b2, c1, e}, made_available_on, available_until}   hmda.public_notice.attested{kind, year}
 *   applicant_demographics.access_logged{actor_id, process, borrower_id}   applicant_demographics.access_denied{actor_id, process}
 *   schedule.tick{cadence, job}   (the platform scheduler's daily / annual / quarterly ticks the recurring rows arm on)
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays, addYears, plainDate, parts, ymd, endOfMonth, daysBetween, addMonths } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor } from "../../kernel/calendar/business.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { EscalationService, Escalation } from "../../app/escalations.ts";
import { rateSetDate, type LockRow } from "../underwriting/ops-23-4.ts";
import { aporAsOf, determineHpml, type AporTable } from "../compliance-disclosures/ops-25-1.ts";
import { applicableScore, REPOSITORIES, REPOSITORY_NAMES, type Repository } from "../verification/ops-22-2.ts";
import { demographicsRow, type DemographicsInput, type DemographicsRow } from "../application/ops-21-1.ts";

export const HMDA_AGENT: Actor = { kind: "agent", id: "hmda" };
export const COMPLIANCE_SENTINEL: Actor = { kind: "agent", id: "compliance-sentinel" };
export const SCHEDULER: Actor = { kind: "system", id: "scheduler" };
export const RULE_SET_VERSION_28_3 = "regc.hmda.2026";
export const RETENTION_CLASS_28_3 = "hmda_3y";
/** Fixture LEI (fictitious, MOD 97-10-consistent); refinance identifier `A26R000101` → ULI `549300SMPARTNER00155A26R00010149`. */
export const FIXTURE_LEI = "549300SMPARTNER00155";
/** Appendix C: LEI 20 characters; loan identifier up to 23; check digit 2 → ULI ≤ 45. */
export const LEI_LENGTH = 20;
export const LOAN_IDENTIFIER_MAX = 23;
export const ULI_MAX = 45;
/** §1003.4(f): LAR entry within 30 calendar days after the end of the calendar quarter of final action. */
export const LAR_ENTRY_DAYS_AFTER_QUARTER = 30;
/** §1003.5(a)(1)(ii): quarterly filing within 60 calendar days after quarter-end when the preceding year had ≥ 60,000 records. */
export const QUARTERLY_DAYS_AFTER_QUARTER = 60;
export const QUARTERLY_REPORTER_THRESHOLD = 60_000;
/** §1003.2(g)(2)(ii): ≥ 25 closed-end (or ≥ 200 open-end) originations in each of the two preceding calendar years. */
export const COVERAGE_CLOSED_END_MIN = 25;
export const COVERAGE_OPEN_END_MIN = 200;
/** §1003.5(b)(2): the disclosure-statement notice within 3 business days (unit `business_days_creditor` by policy). */
export const DISCLOSURE_NOTICE_BUSINESS_DAYS = 3;
/** §1003.5(d): the (b)(2) notice 5 years; the (c) modified-LAR notice 3 years. */
export const B2_NOTICE_YEARS = 5;
export const C1_NOTICE_YEARS = 3;
/** Policy: the officer signs within 5 creditor business days of status 14, never later than Mar 1; sign by Feb 20; Feb 1 clean-edit target; Jan 5 first build. */
export const OFFICER_SIGN_BUSINESS_DAYS = 5;
export const ANNUAL_BUILD_MONTH_DAY = "01-05";
export const EDITS_TARGET_MONTH_DAY = "02-01";
export const SIGN_BY_MONTH_DAY = "02-20";
export const COVERAGE_DECISION_MONTH_DAY = "01-31";
export const MODIFIED_LAR_NOTICE_MONTH_DAY = "03-31";
export const NOTICE_CODES_28_3 = { b2: "NTC_HMDA_1003_5B_DISCLOSURE_STMT_NOTICE", c1: "NTC_HMDA_1003_5C_MODIFIED_LAR_NOTICE", e: "NTC_HMDA_1003_5E_LOBBY_NOTICE" } as const;
/** The only readers of `applicant_demographics` outside the restricted path: the `hmda` agent and 31.2's fair-lending monitoring (`qc-audit` under process 31.2). */
export const DEMOGRAPHICS_READERS: readonly { agent: string; process: string }[] = [{ agent: "hmda", process: "28.3" }, { agent: "qc-audit", process: "31.2" }];

const need = (cond: unknown, msg: string): void => { if (!cond) throw new RangeError(msg); };
const isDate = (s: unknown): s is PlainDate => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const civil = (iso: string): PlainDate => plainDate(iso.slice(0, 10));
const dec = (v: string | number): Decimal => Decimal.parse(String(v));
const r3 = (d: Decimal): string => d.toFixed(3, "HALF_UP");
export function emit(events: EventStore, applicationId: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor = HMDA_AGENT): DomainEvent {
  return events.append({ type, applicationId, actor, occurredAt: at, payload: { application_id: applicationId, source: "origination", ...payload } });
}

// ============================================================ rule 2 / T1 / T2 — the ULI and its Appendix C check digit (ISO/IEC 7064 MOD 97-10)
/** Step 1: letters → numbers (A = 10 … Z = 35; not case-sensitive); digits stay. */
export function uliNumeric(s: string): string {
  need(/^[A-Za-z0-9]+$/.test(s), `ULI characters are letters and numerals only (got ${JSON.stringify(s)})`);
  return [...s.toUpperCase()].map((c) => (c >= "A" && c <= "Z" ? String(c.charCodeAt(0) - 55) : c)).join("");
}
/** Steps 2–4: append "00", mod 97, 98 − remainder, two digits. FFIEC example `EILKZAIZF6TX4HB8ZDX33H` → `54`. */
export function checkDigit(leiPlusIdentifier: string): string {
  const mod = Number(BigInt(uliNumeric(leiPlusIdentifier) + "00") % 97n);
  return String(98 - mod).padStart(2, "0");
}
/** Validation: the whole ULI converted per step 1, mod 97 = 1 → no transcription error. Returns the remainder for the audit. */
export function validateUli(uli: string): { valid: boolean; remainder: number } {
  need(uli.length <= ULI_MAX, `ULI longer than ${ULI_MAX} characters`);
  const remainder = Number(BigInt(uliNumeric(uli)) % 97n);
  return { valid: remainder === 1, remainder };
}
export type TransactionType = "purchase" | "limited_cash_out" | "cash_out";
/** Class letter: R refinance (limited cash-out), P purchase, C cash-out — the class is not PII. */
export const TRANSACTION_CLASS: Record<TransactionType, "R" | "P" | "C"> = { limited_cash_out: "R", purchase: "P", cash_out: "C" };
/** `'A' || yy || class || lpad(seq, 6, '0')` — opaque: never derived from names, SSN, DOB or phone. */
export function loanIdentifier(i: { application_date: PlainDate; transaction_type: TransactionType; sequence: number }): string {
  need(Number.isInteger(i.sequence) && i.sequence >= 1 && i.sequence <= 999_999, "ULI sequence is 1…999999 per partner per year");
  const cls = TRANSACTION_CLASS[i.transaction_type]; need(cls, `unknown transaction_type ${i.transaction_type}`);
  return `A${String(parts(i.application_date).y % 100).padStart(2, "0")}${cls}${String(i.sequence).padStart(6, "0")}`;
}
export interface UliAssignment { readonly uli: string; readonly lei: string; readonly loan_identifier: string; readonly check_digit: string; }
/** `uli = lei || loan_identifier || check_digit` (§1003.4(a)(1)(i)(A)–(C)). */
export function assignUli(lei: string, loan_identifier: string): UliAssignment {
  need(lei.length === LEI_LENGTH && /^[A-Za-z0-9]+$/.test(lei), `LEI is ${LEI_LENGTH} alphanumeric characters`);
  need(loan_identifier.length >= 1 && loan_identifier.length <= LOAN_IDENTIFIER_MAX && /^[A-Za-z0-9]+$/.test(loan_identifier), `loan identifier is 1…${LOAN_IDENTIFIER_MAX} letters/numerals`);
  const cd = checkDigit(lei + loan_identifier);
  const uli = `${lei}${loan_identifier}${cd}`;
  need(validateUli(uli).valid, "check digit self-test failed");
  return { uli, lei, loan_identifier, check_digit: cd };
}
/** The FFIEC Check Digit API contract (public POST JSON; no auth): `{"loanId"}` → `{"loanId","checkDigit"}`; `{"uli"}` → `{"uli","isValid"}`. */
export interface FfiecCheckDigitApi { checkDigit(loanId: string): { loanId: string; checkDigit: string }; validate(uli: string): { uli: string; isValid: boolean }; }
/** Local adapter with the API's exact response shapes — the algorithm is Appendix C's; the real endpoint is an independent cross-check (`validated_by_ffiec_api`). */
export const localFfiecCheckDigitApi: FfiecCheckDigitApi = {
  checkDigit: (loanId) => ({ loanId, checkDigit: checkDigit(loanId) }),
  validate: (uli) => ({ uli, isValid: validateUli(uli).valid }),
};

// ============================================================ FIG code lists (rule_sets.regc.hmda.2026)
export function loanPurposeCode(t: TransactionType): 1 | 31 | 32 { return t === "purchase" ? 1 : t === "limited_cash_out" ? 31 : t === "cash_out" ? 32 : (() => { throw new RangeError(`unknown transaction_type ${t}`); })(); }
export function occupancyCode(o: "primary" | "second_home" | "investment"): 1 | 2 | 3 { return o === "primary" ? 1 : o === "second_home" ? 2 : 3; }
export function constructionMethodCode(property_type: string | null | undefined): 1 | 2 { return property_type === "manufactured" ? 2 : 1; }
/** MH property type / land interest: 3/5 (NA) for site-built; 1 (home and land, titled as real property) / 1 (direct ownership) for a manufactured home in scope. */
export function manufacturedHomeCodes(construction_method: 1 | 2): { mh_secured_property_type: 1 | 3; mh_land_property_interest: 1 | 5 } { return construction_method === 2 ? { mh_secured_property_type: 1, mh_land_property_interest: 1 } : { mh_secured_property_type: 3, mh_land_property_interest: 5 }; }
export type DuRecommendation = "approve_eligible" | "approve_ineligible" | "refer_with_caution" | "out_of_scope" | "error";
/** Rule 11: DU (1) and the result relied on; an application denied before any DU submission → AUS 6 / result 17. */
export function ausCodes(du: DuRecommendation | null): { aus_1: number; aus_result_1: number } {
  if (du === null) return { aus_1: 6, aus_result_1: 17 };
  const map: Record<DuRecommendation, number> = { approve_eligible: 1, approve_ineligible: 2, refer_with_caution: 5, out_of_scope: 6, error: 7 };
  need(map[du] !== undefined, `unknown DU recommendation ${du}`);
  return { aus_1: 1, aus_result_1: map[du] };
}
export const ETHNICITY_CODES: Record<string, number> = { hispanic_or_latino: 1, mexican: 11, puerto_rican: 12, cuban: 13, other_hispanic_or_latino: 14, not_hispanic_or_latino: 2 };
export const RACE_CODES: Record<string, number> = { american_indian_or_alaska_native: 1, asian: 2, asian_indian: 21, chinese: 22, filipino: 23, japanese: 24, korean: 25, vietnamese: 26, other_asian: 27, black_or_african_american: 3, native_hawaiian_or_other_pacific_islander: 4, native_hawaiian: 41, guamanian_or_chamorro: 42, samoan: 43, other_pacific_islander: 44, white: 5 };
export const SEX_CODES: Record<string, number> = { male: 1, female: 2, both: 6 };
/** FIG "not provided by applicant in mail, internet, or telephone application": ethnicity 3, race 6, sex 3; observed flag 3 (NA). */
export const NOT_PROVIDED = { ethnicity: 3, race: 6, sex: 3, observed: 3 } as const;
/** No co-applicant: ethnicity 5, race 8, sex 5, age 9999, observed 4. */
export const NO_CO_APPLICANT = { ethnicity: [5], race: [8], sex: 5, age: 9999, observed: 4 } as const;
export const NA_SCORE = 8888;
export const NA_SCORE_MODEL = 9;
export const NA_AGE = 8888;

// ============================================================ the record (hmda_records; one per application)
export type CompletenessStatus = "open" | "final_action_pending_fields" | "complete" | "edits_failed" | "filed";
export interface FieldSource { readonly source: string; readonly ref: string; readonly version: number | string; readonly derived_at: string; }
export interface ApplicantCodes { readonly ethnicity: readonly number[]; readonly ethnicity_free_text: string | null; readonly race: readonly number[]; readonly race_free_text: readonly string[]; readonly sex: number; readonly ethnicity_observed: number; readonly race_observed: number; readonly sex_observed: number; readonly age: number; }
export interface HmdaRecord {
  readonly hmda_record_id: string; readonly application_id: string; readonly loan_id: string | null; readonly partner_id: string; readonly lei: string; readonly reporting_year: number | null;
  readonly uli: string; readonly loan_identifier: string; readonly check_digit: string; readonly application_date: PlainDate;
  readonly loan_type: 1; readonly loan_purpose: 1 | 31 | 32; readonly preapproval: 1 | 2; readonly construction_method: 1 | 2; readonly occupancy_type: 1 | 2 | 3; readonly loan_amount_cents: Cents;
  readonly action_taken: number | null; readonly action_taken_date: PlainDate | null; readonly action_basis: string | null;
  readonly street_address: string | null; readonly city: string | null; readonly state: string | null; readonly zip: string | null; readonly county_fips: string | null; readonly census_tract: string | null; readonly geocode_source: string | null; readonly geocoded_at: string | null;
  readonly applicant: ApplicantCodes | null; readonly co_applicant: ApplicantCodes | null;
  readonly income_thousands: number | null; readonly purchaser_type: number | null;
  readonly rate_spread: string | null; readonly rate_set_date: PlainDate | null; readonly apr: string | null; readonly apor: string | null; readonly apor_table_id: string | null; readonly rate_spread_ffiec_response: string | null;
  readonly hoepa_status: 1 | 2 | 3 | null; readonly lien_status: 1 | 2;
  readonly applicant_credit_score: number | null; readonly applicant_score_model: number | null; readonly applicant_score_model_text: string | null; readonly co_applicant_credit_score: number | null; readonly co_applicant_score_model: number | null;
  readonly denial_reasons: readonly number[]; readonly denial_reason_other_text: string | null;
  readonly total_loan_costs_cents: Cents | null; readonly total_points_and_fees_cents: Cents | null; readonly origination_charges_cents: Cents | null; readonly discount_points_cents: Cents | null; readonly lender_credits_cents: Cents | null;
  readonly interest_rate: string | null; readonly prepayment_penalty_term: number | null; readonly dti: string | null; readonly cltv: string | null; readonly loan_term_months: number | null; readonly intro_rate_period_months: number | null;
  readonly balloon: 1 | 2; readonly interest_only: 1 | 2; readonly negative_amortization: 1 | 2; readonly other_non_amortizing: 1 | 2;
  readonly property_value_cents: Cents | null; readonly mh_secured_property_type: 1 | 2 | 3; readonly mh_land_property_interest: 1 | 2 | 3 | 4 | 5; readonly total_units: number | null; readonly multifamily_affordable_units: number | null;
  readonly submission_of_application: 1 | 2 | 3; readonly initially_payable: 1 | 2 | 3; readonly nmlsr_id: string | null;
  readonly aus_1: number | null; readonly aus_result_1: number | null; readonly reverse_mortgage: 2; readonly open_end: 2; readonly business_purpose: 2;
  readonly completeness_status: CompletenessStatus; readonly missing_fields: readonly string[]; readonly field_sources: Readonly<Record<string, FieldSource>>; readonly last_derived_at: string | null;
  readonly lar_file_id: string | null; readonly excluded_reason: string | null; readonly lar_entry_due_on: PlainDate | null; readonly correction_log: readonly CorrectionLogEntry[];
  readonly rule_set_version: string; readonly retention_class: "hmda_3y";
}
export interface CorrectionLogEntry { readonly correction_id: string; readonly ulis: readonly string[]; readonly error_class: string; readonly discovery_route: "platform_edit" | "qc" | "exam" | "self_identified"; readonly owning_process: string; readonly corrected_by: string; readonly corrected_at: string; readonly detail: Record<string, unknown>; }
export interface HmdaUliRow { readonly uli: string; readonly lei: string; readonly loan_identifier: string; readonly check_digit: string; readonly application_id: string; readonly partner_id: string; readonly sequence_year: number; readonly sequence_number: number; readonly assigned_at: string; readonly validated_by_ffiec_api: boolean; readonly ffiec_validated_at: string | null; }
export interface CreateRecordInput {
  readonly application_id: string; readonly partner_id: string; readonly lei: string; readonly sequence: number; readonly received_at: string;
  readonly application_date: PlainDate; readonly transaction_type: TransactionType; readonly occupancy: "primary" | "second_home" | "investment"; readonly loan_amount_cents: Cents;
  readonly property_type?: string | null; readonly total_units?: number | null; readonly nmlsr_id?: string | null; readonly preapproval?: 1 | 2;
  readonly property?: { street_address: string; city: string; state: string; zip: string } | null;
}
/** T1: at `application.received` the row exists in the same transaction with its ULI (rule 2), the Reg B application date (rule 3), the purpose (rule 4) and the application-stage fields. */
export function createHmdaRecord(events: EventStore, i: CreateRecordInput, actor: Actor = HMDA_AGENT): { record: HmdaRecord; uli: HmdaUliRow; events: DomainEvent[] } {
  need(isDate(i.application_date), "application_date is the Reg B PlainDate (21.1-Q6)");
  need(i.loan_amount_cents > 0n, "loan amount applied for must be positive");
  const id = loanIdentifier({ application_date: i.application_date, transaction_type: i.transaction_type, sequence: i.sequence });
  const u = assignUli(i.lei, id);
  const construction_method = constructionMethodCode(i.property_type ?? null);
  const src = (source: string, ref: string): FieldSource => ({ source, ref, version: 1, derived_at: i.received_at });
  const record: HmdaRecord = {
    hmda_record_id: `HMDA-${i.application_id}`, application_id: i.application_id, loan_id: null, partner_id: i.partner_id, lei: i.lei, reporting_year: null,
    uli: u.uli, loan_identifier: u.loan_identifier, check_digit: u.check_digit, application_date: i.application_date,
    loan_type: 1, loan_purpose: loanPurposeCode(i.transaction_type), preapproval: i.preapproval ?? 2, construction_method, occupancy_type: occupancyCode(i.occupancy), loan_amount_cents: i.loan_amount_cents,
    action_taken: null, action_taken_date: null, action_basis: null,
    street_address: i.property?.street_address ?? null, city: i.property?.city ?? null, state: i.property?.state ?? null, zip: i.property?.zip ?? null, county_fips: null, census_tract: null, geocode_source: null, geocoded_at: null,
    applicant: null, co_applicant: null, income_thousands: null, purchaser_type: null,
    rate_spread: null, rate_set_date: null, apr: null, apor: null, apor_table_id: null, rate_spread_ffiec_response: null, hoepa_status: null, lien_status: 1,
    applicant_credit_score: null, applicant_score_model: null, applicant_score_model_text: null, co_applicant_credit_score: null, co_applicant_score_model: null,
    denial_reasons: [], denial_reason_other_text: null,
    total_loan_costs_cents: null, total_points_and_fees_cents: null, origination_charges_cents: null, discount_points_cents: null, lender_credits_cents: null,
    interest_rate: null, prepayment_penalty_term: null, dti: null, cltv: null, loan_term_months: null, intro_rate_period_months: null,
    balloon: 2, interest_only: 2, negative_amortization: 2, other_non_amortizing: 2,
    property_value_cents: null, ...manufacturedHomeCodes(construction_method), total_units: i.total_units ?? 1, multifamily_affordable_units: null,
    submission_of_application: 1, initially_payable: 1, nmlsr_id: i.nmlsr_id ?? null,
    aus_1: null, aus_result_1: null, reverse_mortgage: 2, open_end: 2, business_purpose: 2,
    completeness_status: "open", missing_fields: [], field_sources: { uli: src("hmda_ulis", u.uli), application_date: src("applications.application_date", i.application_id), loan_purpose: src("applications.transaction_type", i.application_id), loan_amount: src("applications.six_items.loan_amount_sought", i.application_id) },
    last_derived_at: i.received_at, lar_file_id: null, excluded_reason: null, lar_entry_due_on: null, correction_log: [], rule_set_version: RULE_SET_VERSION_28_3, retention_class: "hmda_3y",
  };
  const uli: HmdaUliRow = { uli: u.uli, lei: u.lei, loan_identifier: u.loan_identifier, check_digit: u.check_digit, application_id: i.application_id, partner_id: i.partner_id, sequence_year: parts(i.application_date).y, sequence_number: i.sequence, assigned_at: i.received_at, validated_by_ffiec_api: false, ffiec_validated_at: null };
  const e1 = emit(events, i.application_id, "hmda.record.created", { uli: u.uli, application_date: i.application_date, loan_purpose: record.loan_purpose, loan_amount_cents: String(i.loan_amount_cents), rule_set_version: RULE_SET_VERSION_28_3 }, i.received_at, actor);
  const e2 = emit(events, i.application_id, "hmda.uli.assigned", { uli: u.uli, lei: u.lei, loan_identifier: u.loan_identifier, check_digit: u.check_digit, sequence: i.sequence }, i.received_at, actor);
  return { record, uli, events: [e1, e2] };
}
/** The once-per-ULI FFIEC validation (`validated_by_ffiec_api`); a mismatch with the local algorithm is a sev 1 defect, never silently accepted. */
export function validateUliFfiec(uli: HmdaUliRow, api: FfiecCheckDigitApi, at: string): { uli: HmdaUliRow; response: { uli: string; isValid: boolean } } {
  const response = api.validate(uli.uli);
  need(response.isValid === validateUli(uli.uli).valid, `FFIEC validate disagrees with the local Appendix C algorithm for ${uli.uli}`);
  return { uli: { ...uli, validated_by_ffiec_api: response.isValid, ffiec_validated_at: at }, response };
}
/** Provenance: every derived data point carries its source, ref and version (`field_sources`). */
export function derive<K extends keyof HmdaRecord>(events: EventStore | null, rec: HmdaRecord, data_point: K, value: HmdaRecord[K], source: FieldSource, at: string): HmdaRecord {
  const next: HmdaRecord = { ...rec, [data_point]: value, field_sources: { ...rec.field_sources, [data_point]: source }, last_derived_at: at };
  if (events) emit(events, rec.application_id, "hmda.record.field_derived", { data_point, value: typeof value === "bigint" ? String(value) : value, source: source.source, ref: source.ref, version: source.version }, at);
  return next;
}

// ============================================================ rule 5 — property location (geocoder; tract NA only under comment 4(a)(9)-1)
export interface GeocodeResult { readonly state: string; readonly county_fips: string; readonly census_tract: string | null; readonly county_population: number; readonly source: string; readonly version: string; }
export function applyGeocode(rec: HmdaRecord, g: GeocodeResult | null, at: string): HmdaRecord {
  if (!g) {
    need(rec.action_taken !== null && rec.action_taken >= 3 && rec.street_address === null, "census tract NA only when the county population is ≤ 30,000 or the address is unknown for a denied/withdrawn application (comment 4(a)(9)-1)");
    return { ...rec, county_fips: "NA", census_tract: "NA", geocode_source: "address_unknown", geocoded_at: at };
  }
  need(/^[0-9]{5}$/.test(g.county_fips), "county FIPS is 5 digits");
  const tract = g.county_population > 30_000 ? g.census_tract : "NA";
  need(tract === "NA" || (tract !== null && /^[0-9]{11}$/.test(tract)), "census tract is 11 digits (FIG) unless NA");
  return { ...rec, state: g.state, county_fips: g.county_fips, census_tract: tract, geocode_source: `${g.source}@${g.version}`, geocoded_at: at, field_sources: { ...rec.field_sources, census_tract: { source: g.source, ref: g.version, version: g.version, derived_at: at } } };
}

// ============================================================ rule 6 / T11 — demographics (App. B; never inferred; visual observation only in person)
/** Age at the application date from the date of birth. */
export function ageAt(dob: PlainDate, on: PlainDate): number {
  const a = parts(dob), b = parts(on);
  let age = b.y - a.y; if (b.m < a.m || (b.m === a.m && b.d < a.d)) age -= 1;
  need(age >= 18 && age < 130, `implausible age ${age}`);
  return age;
}
/** The FIG codes for one applicant from 21.1's row: disaggregated codes (≤ 5 each); 3/6/3 with observed flags 3 when declined in a telephone/internet application; observed 2 when the applicant answered. */
export function demographicCodes(row: DemographicsRow, i: { dob: PlainDate | null; application_date: PlainDate }): ApplicantCodes {
  need(row.visual_observation_used === false || row.collection_channel === "in_person", "visual_observation_used is possible only for an in-person application (0057 CHECK applicant_demographics_no_observation_remote)");
  const inPerson = row.collection_channel === "in_person";
  const codes = (vals: readonly string[] | null, table: Record<string, number>, what: string): number[] => { const out = (vals ?? []).map((v) => { const c = table[v]; if (c === undefined) throw new RangeError(`unknown ${what} value ${v}`); return c; }); need(out.length <= 5, `at most five ${what} codes`); return out; };
  const observedFlag = (declined: boolean): number => (declined ? NOT_PROVIDED.observed : row.visual_observation_used ? 1 : 2);
  const ethnicity = row.declined_ethnicity || !row.ethnicity?.length ? [inPerson && row.visual_observation_used ? 4 : NOT_PROVIDED.ethnicity] : codes(row.ethnicity, ETHNICITY_CODES, "ethnicity");
  const race = row.declined_race || !row.race?.length ? [inPerson && row.visual_observation_used ? 7 : NOT_PROVIDED.race] : codes(row.race, RACE_CODES, "race");
  const sex = row.declined_sex || !row.sex ? (inPerson && row.visual_observation_used ? 4 : NOT_PROVIDED.sex) : (() => { const c = SEX_CODES[row.sex!]; if (c === undefined) throw new RangeError(`unknown sex value ${row.sex}`); return c; })();
  return { ethnicity, ethnicity_free_text: null, race, race_free_text: [], sex, ethnicity_observed: observedFlag(row.declined_ethnicity || !row.ethnicity?.length), race_observed: observedFlag(row.declined_race || !row.race?.length), sex_observed: observedFlag(row.declined_sex || !row.sex), age: i.dob ? ageAt(i.dob, i.application_date) : NA_AGE };
}
/** The guardrail as a function: the row is built through 21.1's `demographicsRow`, so an attempt to set `visual_observation_used=true` on a telephone/internet application is a constraint violation (RangeError) — never a stored row. */
export function collectDemographics(d: DemographicsInput): DemographicsRow { return demographicsRow(d); }
export function noCoApplicant(): ApplicantCodes { return { ethnicity: [...NO_CO_APPLICANT.ethnicity], ethnicity_free_text: null, race: [...NO_CO_APPLICANT.race], race_free_text: [], sex: NO_CO_APPLICANT.sex, ethnicity_observed: NO_CO_APPLICANT.observed, race_observed: NO_CO_APPLICANT.observed, sex_observed: NO_CO_APPLICANT.observed, age: NO_CO_APPLICANT.age }; }
/** `income_thousands = round_half_up(relied-on annual income / 1000)`; $98,400 → 98. */
export function incomeThousands(annual_income_cents: Cents | null): number | null {
  if (annual_income_cents === null) return null;
  return Number(Decimal.ratio(annual_income_cents, 100_000n).toFixed(0, "HALF_UP"));
}

// ============================================================ rule 7 / T8 — credit score and model (§1003.4(a)(15); LL-2026-06)
export type ScoreModel = "classic_fico" | "vantagescore_4";
/** Classic FICO by the bureau that produced the representative score: Equifax 1 (Beacon 5.0), Experian 2 (Fair Isaac Risk Model v2), TransUnion 3 (FICO Risk Score Classic 04); VantageScore 4.0 → 15 whichever bureau. */
export const CLASSIC_FICO_MODEL_BY_BUREAU: Record<Repository, 1 | 2 | 3> = { efx: 1, exp: 2, tu: 3 };
export const VANTAGESCORE_4_MODEL = 15;
export const SCORE_MODEL_TEXT: Record<number, string> = { 1: "Equifax Beacon 5.0", 2: "Experian Fair Isaac Risk Model v2", 3: "TransUnion FICO Risk Score Classic 04", 9: "Not applicable", 15: "VantageScore 4.0" };
export interface ApplicantScore { readonly score: number; readonly model: number; readonly model_text: string; readonly bureau: string | null; readonly basis: string; }
/** The applicant's own relied-on score (22.2's middle/lower/one rule) with the model of the bureau that produced it; no score → 8888 / 9. */
export function applicantScore(i: { score_model: ScoreModel; scores: Partial<Record<Repository, number | null>> }): ApplicantScore {
  const applicable = applicableScore(REPOSITORIES.map((r) => i.scores[r]));
  if (applicable === null) return { score: NA_SCORE, model: NA_SCORE_MODEL, model_text: SCORE_MODEL_TEXT[NA_SCORE_MODEL]!, bureau: null, basis: "no credit score for this applicant → 8888 / 9 (FIG Not applicable)" };
  const bureau = REPOSITORIES.find((r) => i.scores[r] === applicable)!;
  if (i.score_model === "vantagescore_4") return { score: applicable, model: VANTAGESCORE_4_MODEL, model_text: SCORE_MODEL_TEXT[VANTAGESCORE_4_MODEL]!, bureau: REPOSITORY_NAMES[bureau], basis: `applications.score_model = vantagescore_4 → model 15 (${REPOSITORY_NAMES[bureau]} ${applicable})` };
  need(i.score_model === "classic_fico", `unknown score_model ${i.score_model}`);
  const model = CLASSIC_FICO_MODEL_BY_BUREAU[bureau];
  return { score: applicable, model, model_text: SCORE_MODEL_TEXT[model]!, bureau: REPOSITORY_NAMES[bureau], basis: `Classic FICO relied-on score ${applicable} from ${REPOSITORY_NAMES[bureau]} → model ${model}` };
}

// ============================================================ rule 8 / T3 — rate spread (comment 4(a)(12)-3 to -6; FFIEC Rate Spread API)
export type ActionTakenType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const RATE_SPREAD_ACTIONS: readonly number[] = [1, 2, 8];
export interface RateSpreadInput { readonly apr: string | number; readonly locks: readonly LockRow[]; readonly final_action_on: PlainDate; readonly apor_tables: readonly AporTable[]; readonly action_taken: ActionTakenType; readonly loan_term_years?: number; readonly amortization?: "fixed" | "adjustable"; readonly loan_amount_cents: Cents; readonly reverse_mortgage?: boolean; }
export interface FfiecRateSpreadRequest { readonly actionTakenType: number; readonly loanTerm: number; readonly amortizationType: "FixedRate" | "VariableRate"; readonly apr: number; readonly lockInDate: PlainDate; readonly reverseMortgage: 1 | 2; }
export interface RateSpreadResult { readonly rate_spread: string; readonly rate_set_date: PlainDate | null; readonly apr: string; readonly apor: string | null; readonly apor_table_date: PlainDate | null; readonly api_request: FfiecRateSpreadRequest | null; readonly api_response: { rateSpread: string }; readonly basis: string; }
/** Local computation through 25.1's engine (`aporAsOf` for the week containing the final rate-set date; `determineHpml` computes APR − APOR to 3 dp) and the FFIEC request/response the annual reconciliation cross-checks. */
export function computeRateSpread(i: RateSpreadInput): RateSpreadResult {
  const apr = r3(dec(i.apr));
  if (!RATE_SPREAD_ACTIONS.includes(i.action_taken) || i.reverse_mortgage === true) return { rate_spread: "NA", rate_set_date: null, apr, apor: null, apor_table_date: null, api_request: null, api_response: { rateSpread: "NA" }, basis: `action ${i.action_taken}${i.reverse_mortgage ? " / reverse mortgage" : ""} → NA (comment 4(a)(12)-6; the API returns NA for 3, 4, 5, 6 or 7)` };
  const rs = rateSetDate(i.locks, i.final_action_on);
  const rate_set_date = rs.rate_set_date;
  if (rate_set_date === null) throw new RangeError("no executed lock before final action: the rate-set date is required for the spread (21.4 rule 10)");
  const term = i.loan_term_years ?? 30, product = i.amortization ?? "fixed";
  const apor = aporAsOf(i.apor_tables, rate_set_date, term, product);
  if (apor === null) throw new RangeError(`no ${product} ${term}-year APOR table in effect for the week of ${rate_set_date} (23.4 apor_tables)`);
  const det = determineHpml({ apr, apor, rate_set_date, as_of: i.final_action_on, loan_amount_cents: i.loan_amount_cents, total_loan_amount_cents: i.loan_amount_cents, points_and_fees_cents: 0n, lien_position: "first", term_months: term * 12 });
  if (det.spread === null) throw new RangeError(det.message);
  const rate_spread = r3(dec(det.spread));
  const api_request: FfiecRateSpreadRequest = { actionTakenType: i.action_taken, loanTerm: term, amortizationType: product === "fixed" ? "FixedRate" : "VariableRate", apr: Number(apr), lockInDate: rate_set_date, reverseMortgage: 2 };
  return { rate_spread, rate_set_date, apr, apor: apor.apor_pct, apor_table_date: apor.table_date, api_request, api_response: localRateSpreadApi(api_request, i.apor_tables), basis: `APR ${apr} − APOR ${apor.apor_pct} (table ${apor.table_date}, rate set ${rate_set_date}${rs.superseded_lock_ids.length ? `; supersedes ${rs.superseded_lock_ids.join(", ")}` : ""}) = ${rate_spread}` };
}
/** The FFIEC Rate Spread API as the annual reconciliation sees it (`POST https://ffiec.cfpb.gov/public/rateSpread`): `{"rateSpread":"0.139"}`; "NA" for action types 3–7. */
export function localRateSpreadApi(req: FfiecRateSpreadRequest, tables: readonly AporTable[]): { rateSpread: string } {
  if (!RATE_SPREAD_ACTIONS.includes(req.actionTakenType) || req.reverseMortgage !== 2) return { rateSpread: "NA" };
  need(req.loanTerm >= 1 && req.loanTerm <= 50, "loanTerm 1–50");
  const apor = aporAsOf(tables, req.lockInDate, req.loanTerm, req.amortizationType === "FixedRate" ? "fixed" : "adjustable");
  if (!apor) return { rateSpread: "NA" };
  return { rateSpread: r3(dec(req.apr).sub(dec(apor.apor_pct))) };
}
export function applyRateSpread(events: EventStore | null, rec: HmdaRecord, r: RateSpreadResult, at: string): HmdaRecord {
  const src: FieldSource = { source: "apr_calculations+apor_tables+locks", ref: r.basis, version: r.apor_table_date ?? "NA", derived_at: at };
  let next = derive(events, rec, "rate_spread", r.rate_spread === "NA" ? null : r.rate_spread, src, at);
  next = { ...next, rate_set_date: r.rate_set_date, apr: r.apr, apor: r.apor, apor_table_id: r.apor_table_date ? `T-${r.apor_table_date}` : null, rate_spread_ffiec_response: r.api_response.rateSpread };
  return next;
}

// ============================================================ rule 9 / T4 — action taken (finalisation of 21.6's mapping)
export function quarterEnd(d: PlainDate): PlainDate { const { y, m } = parts(d); return endOfMonth(ymd(y, m + 2 - ((m - 1) % 3), 1)); }
/** §1003.4(f): the LAR entry is due 30 calendar days after the end of the calendar quarter of final action (Q4 2026 → Sat Jan 30, 2027). */
export function larEntryDue(action_taken_date: PlainDate): { quarter_end: PlainDate; due_on: PlainDate } { const qe = quarterEnd(action_taken_date); return { quarter_end: qe, due_on: addDays(qe, LAR_ENTRY_DAYS_AFTER_QUARTER) }; }
export interface FundingFacts { readonly consummation_date: PlainDate; readonly funded_on: PlainDate; readonly rescindable: boolean; readonly rescission_expires_on: PlainDate | null; readonly rescission_exercised_on: PlainDate | null; readonly note_amount_cents: Cents; }
function recordAction(events: EventStore, rec: HmdaRecord, action_taken: number, action_taken_date: PlainDate, basis: string, at: string, extra: Record<string, unknown> = {}): { record: HmdaRecord; event: DomainEvent } {
  need(rec.action_taken === null || rec.action_taken === action_taken, `application ${rec.application_id} already reports action ${rec.action_taken} on ${rec.action_taken_date}: exactly one action code per application`);
  need(action_taken_date >= rec.application_date, `action_taken_date ${action_taken_date} precedes application_date ${rec.application_date}`);
  const due = larEntryDue(action_taken_date);
  const record: HmdaRecord = { ...rec, action_taken, action_taken_date, action_basis: basis, reporting_year: parts(action_taken_date).y, lar_entry_due_on: due.due_on, completeness_status: rec.completeness_status === "open" ? "final_action_pending_fields" : rec.completeness_status, field_sources: { ...rec.field_sources, action_taken: { source: "28.3", ref: basis, version: 1, derived_at: at } }, last_derived_at: at };
  const event = emit(events, rec.application_id, "hmda.action_taken.recorded", { uli: rec.uli, action_taken, action_taken_date, basis, quarter_end: due.quarter_end, lar_entry_due_on: due.due_on, reporting_year: record.reporting_year, ...extra }, at);
  return { record, event };
}
/** Originated → 1 with `action_taken_date = consummation date` when `loan.funded` fires after `rescission.period.expired` without rescission; a rescinded loan → 2 with the rescission date (comment 4(a)(8)(i)-10) and the loan costs NA. */
export function finalizeActionTaken(events: EventStore, rec: HmdaRecord, f: FundingFacts, at: string): { record: HmdaRecord; event: DomainEvent } {
  if (f.rescission_exercised_on !== null) {
    need(f.rescission_exercised_on >= f.consummation_date, "rescission is exercised after consummation");
    const r = recordAction(events, rec, 2, f.rescission_exercised_on, "rescinded after closing → approved but not accepted (comment 4(a)(8)(i)-10); loan costs NA (not originated)", at, { rescinded: true });
    return { record: { ...r.record, total_loan_costs_cents: null, origination_charges_cents: null, discount_points_cents: null, lender_credits_cents: null, loan_amount_cents: rec.loan_amount_cents }, event: r.event };
  }
  need(f.funded_on >= f.consummation_date, "funding follows consummation");
  if (f.rescindable) { need(f.rescission_expires_on !== null && f.funded_on > f.rescission_expires_on, "a rescindable loan is originated only after rescission.period.expired without rescission (state-machine guard)"); }
  const r = recordAction(events, rec, 1, f.consummation_date, `loan.funded ${f.funded_on}${f.rescindable ? ` after rescission expired ${f.rescission_expires_on}` : ""} → originated; action date = consummation ${f.consummation_date}`, at, { funded_on: f.funded_on });
  return { record: { ...r.record, loan_amount_cents: f.note_amount_cents }, event: r.event };
}
/** 21.6's codes 2–5 (`hmda.action_taken.recorded` from deliverAdverseNotice / recordWithdrawal / closeIncomplete): the record adopts them with denial reasons (≤ 4; 10 for non-denials) and NA money/rate fields (rule 12; T6). */
export function applyAdverseAction(events: EventStore, rec: HmdaRecord, a: { action_taken: 2 | 3 | 4 | 5; action_taken_date: PlainDate; denial_reasons?: readonly number[]; denial_reason_other_text?: string | null; basis?: string }, at: string): { record: HmdaRecord; event: DomainEvent } {
  const reasons = a.action_taken === 3 ? [...(a.denial_reasons ?? [])] : [10];
  need(a.action_taken !== 3 || (reasons.length >= 1 && reasons.length <= 4 && reasons.every((c) => c >= 1 && c <= 9)), "a denial carries one to four FIG denial reasons 1–9");
  need(!reasons.includes(9) || (a.denial_reason_other_text ?? "").length <= 255, "code 9 free text ≤ 255 characters");
  const r = recordAction(events, rec, a.action_taken, a.action_taken_date, a.basis ?? `21.6 disposition → action ${a.action_taken}`, at, { denial_reasons: reasons });
  return { record: { ...r.record, denial_reasons: reasons, denial_reason_other_text: reasons.includes(9) ? (a.denial_reason_other_text ?? null) : null, rate_spread: null, rate_spread_ffiec_response: "NA", total_loan_costs_cents: null, origination_charges_cents: null, discount_points_cents: null, lender_credits_cents: null, interest_rate: null, purchaser_type: 0 }, event: r.event };
}

// ============================================================ §1003.4(a)(11) / T5 — purchaser type (same calendar year only)
export function applyPurchase(events: EventStore | null, rec: HmdaRecord, p: { purchase_date: PlainDate; investor: "fnma" | "other" }, at: string): HmdaRecord {
  need(rec.action_taken === 1 && rec.action_taken_date !== null, "only an originated loan has a purchaser");
  const sameYear = parts(p.purchase_date).y === parts(rec.action_taken_date!).y;
  const code = sameYear ? (p.investor === "fnma" ? 1 : 71) : 0;
  return derive(events, rec, "purchaser_type", code, { source: "loan.purchased", ref: p.purchase_date, version: p.investor, derived_at: at }, at);
}
/** Jan 1, Y+1: an originated loan not sold by Dec 31 of its origination year reports purchaser type 0 (no later restatement). */
export function yearEndPurchaserJob(events: EventStore | null, rec: HmdaRecord, as_of: PlainDate): HmdaRecord {
  if (rec.action_taken !== 1 || rec.purchaser_type !== null || rec.action_taken_date === null) return rec;
  if (parts(as_of).y <= parts(rec.action_taken_date).y) return rec;
  return derive(events, rec, "purchaser_type", 0, { source: "28.3 year-end job", ref: as_of, version: "not sold by Dec 31", derived_at: `${as_of}T09:00:00.000Z` }, `${as_of}T09:00:00.000Z`);
}

// ============================================================ rule 10 / T12 — TRID-derived money fields (dollars with two decimals; blank vs 0 vs NA)
export type MoneyField = "total_loan_costs" | "total_points_and_fees" | "origination_charges" | "discount_points" | "lender_credits";
export function larDollars(c: Cents): string { const neg = c < 0n; const a = neg ? -c : c; return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`; }
/** Originated loans: Total Loan Costs / Origination Charges "If the amount is zero, enter 0"; Discount Points / Lender Credits "leave this field blank" when none; non-originated → NA. */
export function larMoneyField(kind: MoneyField, cents: Cents | null, action_taken: number | null): string {
  if (action_taken !== 1) return "NA";
  if (kind === "total_points_and_fees") return "NA";   // TRID loans report §1026.38 figures, not points and fees
  if (kind === "discount_points" || kind === "lender_credits") return cents === null || cents === 0n ? "" : larDollars(cents);
  if (cents === null) throw new RangeError(`${kind} is required for an originated loan`);
  return cents === 0n ? "0" : larDollars(cents);
}
export function larRate(pct: string | null, action_taken: number | null): string { return pct === null || (action_taken !== null && action_taken >= 3 && action_taken !== 8 && action_taken !== 2) ? "NA" : r3(dec(pct)); }
export interface ClosingDisclosureFacts { readonly total_loan_costs_cents: Cents; readonly origination_charges_cents: Cents; readonly discount_points_cents: Cents | null; readonly lender_credits_cents: Cents | null; readonly interest_rate: string; readonly loan_term_months: number; readonly intro_rate_period_months: number | null; readonly apr: string; readonly cd_version: number; readonly dti: string; readonly cltv: string; readonly property_value_cents: Cents; readonly hoepa_status: 1 | 2 | 3; }
/** The final (or corrected — comment 4(a)(12)-5) CD's money and term fields with provenance to the CD version. */
export function applyClosingDisclosure(events: EventStore | null, rec: HmdaRecord, cd: ClosingDisclosureFacts, at: string): HmdaRecord {
  const src = (ref: string): FieldSource => ({ source: "closing_disclosures", ref, version: cd.cd_version, derived_at: at });
  let n = derive(events, rec, "total_loan_costs_cents", cd.total_loan_costs_cents, src("§1026.38(f)(4)"), at);
  n = derive(events, n, "origination_charges_cents", cd.origination_charges_cents, src("§1026.38(f)(1)"), at);
  n = derive(events, n, "discount_points_cents", cd.discount_points_cents !== null && cd.discount_points_cents !== 0n ? cd.discount_points_cents : null, src("§1026.37(f)(1)(i)"), at);
  n = derive(events, n, "lender_credits_cents", cd.lender_credits_cents !== null && cd.lender_credits_cents !== 0n ? cd.lender_credits_cents : null, src("§1026.38(h)(3)"), at);
  n = derive(events, n, "interest_rate", r3(dec(cd.interest_rate)), src("note rate"), at);
  n = derive(events, n, "dti", r3(dec(cd.dti)), { source: "decisions.risk_assessment", ref: "dti relied on", version: cd.cd_version, derived_at: at }, at);
  n = derive(events, n, "cltv", r3(dec(cd.cltv)), { source: "decisions.risk_assessment", ref: "cltv relied on", version: cd.cd_version, derived_at: at }, at);
  n = derive(events, n, "property_value_cents", cd.property_value_cents, { source: "valuations", ref: "value relied on (24.x)", version: cd.cd_version, derived_at: at }, at);
  n = derive(events, n, "hoepa_status", cd.hoepa_status, { source: "23.4 hoepa determination", ref: "compliance.high_cost.determined", version: cd.cd_version, derived_at: at }, at);
  return { ...n, apr: r3(dec(cd.apr)), loan_term_months: cd.loan_term_months, intro_rate_period_months: cd.intro_rate_period_months, total_points_and_fees_cents: null };
}

// ============================================================ rule 13 / T7 — the daily LAR-completeness job (§1003.4(f) aging; local S/V/Q edits)
/** Required fields per FIG conditionality: originated → money fields, rate spread, purchaser type (when sold or after year-end); denied → denial reasons; every final action → location, demographics, AUS. */
export function requiredFields(rec: HmdaRecord, as_of: PlainDate): string[] {
  const missing: string[] = [];
  if (rec.action_taken === null) return ["action_taken"];
  if (!rec.county_fips || !rec.census_tract) missing.push("census_tract");
  if (!rec.applicant) missing.push("applicant_demographics");
  if (rec.applicant_credit_score === null && rec.action_taken <= 3) missing.push("applicant_credit_score");
  if (rec.aus_1 === null) missing.push("aus_1");
  if (rec.action_taken === 1) {
    if (rec.total_loan_costs_cents === null) missing.push("total_loan_costs");
    if (rec.origination_charges_cents === null) missing.push("origination_charges");
    if (rec.interest_rate === null) missing.push("interest_rate");
    if (rec.rate_spread === null) missing.push("rate_spread");
    if (rec.loan_term_months === null) missing.push("loan_term");
    if (rec.purchaser_type === null) missing.push("purchaser_type");   // pending the sale or the Jan 1 year-end job
  }
  if (rec.action_taken === 3 && rec.denial_reasons.length === 0) missing.push("denial_reasons");
  if (rec.action_taken_date !== null && parts(as_of).y > parts(rec.action_taken_date).y && missing.includes("purchaser_type")) { /* the year-end job sets 0 before the daily run */ }
  return missing;
}
export interface LocalEditFinding { readonly edit_code: string; readonly edit_type: "S" | "V" | "Q"; readonly field: string; readonly message: string; }
/** Local syntactical/validity/quality edits: formats, code lists, the check digit, date ordering, ratio ranges, tract/county consistency, plausibility and the spread/HPML cross-check. */
export function runLocalEdits(rec: HmdaRecord, ctx: { hpml_spread?: string | null } = {}): LocalEditFinding[] {
  const out: LocalEditFinding[] = [];
  if (!validateUli(rec.uli).valid) out.push({ edit_code: "V600", edit_type: "V", field: "uli", message: "ULI check digit invalid (Appendix C)" });
  if (rec.action_taken_date !== null && rec.application_date > rec.action_taken_date) out.push({ edit_code: "V612", edit_type: "V", field: "action_taken_date", message: "application_date must be ≤ action_taken_date" });
  if (rec.census_tract !== null && rec.census_tract !== "NA" && rec.county_fips !== null && !rec.census_tract.startsWith(rec.county_fips)) out.push({ edit_code: "V625", edit_type: "V", field: "census_tract", message: "census tract must lie in the reported county" });
  if (rec.dti !== null && (Number(rec.dti) < 0 || Number(rec.dti) > 100)) out.push({ edit_code: "V690", edit_type: "V", field: "dti", message: "DTI outside 0–100" });
  if (rec.cltv !== null && (Number(rec.cltv) <= 0 || Number(rec.cltv) > 200)) out.push({ edit_code: "V691", edit_type: "V", field: "cltv", message: "CLTV outside 0–200" });
  if (rec.rate_spread !== null && rec.action_taken !== null && !RATE_SPREAD_ACTIONS.includes(rec.action_taken)) out.push({ edit_code: "V655", edit_type: "V", field: "rate_spread", message: "rate spread must be NA for actions 3–7" });
  if (rec.action_taken === 3 && (rec.denial_reasons.length === 0 || rec.denial_reasons.includes(10))) out.push({ edit_code: "V670", edit_type: "V", field: "denial_reasons", message: "a denial carries reasons 1–9" });
  if (rec.property_value_cents !== null && rec.action_taken === 1 && rec.loan_amount_cents > rec.property_value_cents * 2n) out.push({ edit_code: "Q614", edit_type: "Q", field: "loan_amount", message: "loan amount implausible against the property value" });
  if (rec.hoepa_status === 1 && rec.rate_spread !== null && Number(rec.rate_spread) < 1.5) out.push({ edit_code: "Q617", edit_type: "Q", field: "hoepa_status", message: "HOEPA status inconsistent with the spread" });
  if (ctx.hpml_spread !== undefined && ctx.hpml_spread !== null && rec.rate_spread !== null && ctx.hpml_spread !== rec.rate_spread) out.push({ edit_code: "SM-HPML-SPREAD", edit_type: "Q", field: "rate_spread", message: `rate spread ${rec.rate_spread} ≠ 23.4 HPML spread ${ctx.hpml_spread}` });
  return out;
}
export interface CompletenessResult { readonly uli: string; readonly application_id: string; readonly status: CompletenessStatus; readonly missing_fields: readonly string[]; readonly edits: readonly LocalEditFinding[]; readonly lar_entry_due_on: PlainDate | null; readonly overdue: boolean; readonly days_to_due: number | null; }
export interface CompletenessRun { readonly date: PlainDate; readonly records: HmdaRecord[]; readonly results: CompletenessResult[]; readonly failed: CompletenessResult[]; readonly escalations: Escalation[]; readonly events: DomainEvent[]; }
/** The 02:00 daily job: required fields (a), local S/V/Q edits (b–c), provenance (d) and the §1003.4(f) aging (e) → `completeness_status`, `missing_fields`, `hmda.record.finalized` when complete, `hmda.completeness.failed` + sev 2 when still incomplete past the due date. */
export function runCompletenessJob(events: EventStore, records: readonly HmdaRecord[], i: { as_of: PlainDate; escalations?: EscalationService | null; hpml_spreads?: Readonly<Record<string, string | null>> }, actor: Actor = HMDA_AGENT): CompletenessRun {
  const at = `${i.as_of}T09:00:00.000Z`;   // 02:00 America/Phoenix
  const out: HmdaRecord[] = [], results: CompletenessResult[] = [], failed: CompletenessResult[] = [], escs: Escalation[] = [], evs: DomainEvent[] = [];
  for (const r0 of records) {
    if (r0.excluded_reason !== null || r0.completeness_status === "filed" || r0.completeness_status === "edits_failed" || r0.action_taken === null) { out.push(r0); continue; }
    const rec = yearEndPurchaserJob(events, r0, i.as_of);
    const missing = requiredFields(rec, i.as_of);
    const edits = runLocalEdits(rec, { hpml_spread: i.hpml_spreads?.[rec.application_id] ?? null }).filter((e) => e.edit_type !== "Q");
    const complete = missing.length === 0 && edits.length === 0;
    const due = rec.lar_entry_due_on; const overdue = !complete && due !== null && i.as_of > due;
    const status: CompletenessStatus = complete ? "complete" : "final_action_pending_fields";
    const next: HmdaRecord = { ...rec, completeness_status: status, missing_fields: [...missing, ...edits.map((e) => e.field)], last_derived_at: at };
    const res: CompletenessResult = { uli: rec.uli, application_id: rec.application_id, status, missing_fields: next.missing_fields, edits, lar_entry_due_on: due, overdue, days_to_due: due ? daysBetween(i.as_of, due) : null };
    results.push(res); out.push(next);
    if (complete && rec.completeness_status !== "complete") evs.push(emit(events, rec.application_id, "hmda.record.finalized", { uli: rec.uli, completeness_status: "complete", action_taken: rec.action_taken, lar_entry_due_on: due, completed_on: i.as_of }, at, actor));
    if (overdue) {
      failed.push(res);
      evs.push(emit(events, rec.application_id, "hmda.completeness.failed", { uli: rec.uli, missing_fields: next.missing_fields, lar_entry_due_on: due, days_overdue: daysBetween(due!, i.as_of), severity: 2, route: "compliance-sentinel" }, at, actor));
      if (i.escalations) escs.push(i.escalations.open({ kind: "sev2", ownerRole: "compliance", applicationId: rec.application_id, severity: "sev2", payload: { timer: "HMDA_1003_4F_LAR_ENTRY_Q30", uli: rec.uli, missing_fields: next.missing_fields, lar_entry_due_on: due, route: "compliance-sentinel" } }, actor));
    }
  }
  evs.push(events.append({ type: "hmda.completeness.checked", actor, occurredAt: at, aggregate: { kind: "hmda_job", id: "lar_completeness" }, payload: { source: "origination", date: i.as_of, records: results.length, complete: results.filter((r) => r.status === "complete").length, incomplete: results.filter((r) => r.status !== "complete").length, failed: failed.length, ulis_overdue: failed.map((f) => f.uli) } }));
  return { date: i.as_of, records: out, results, failed, escalations: escs, events: evs };
}
/** The scheduler's 02:00 partner-time tick (`SM_HMDA_LAR_COMPLETENESS_DAILY` arms on it; the job run satisfies it). */
export function dailyCompletenessTick(events: EventStore, date: PlainDate, tz = "America/Phoenix"): DomainEvent {
  return events.append({ type: "schedule.tick", actor: SCHEDULER, occurredAt: `${date}T09:00:00.000Z`, aggregate: { kind: "hmda_job", id: "lar_completeness" }, payload: { source: "origination", cadence: "daily", at: "02:00", tz, job: "hmda_lar_completeness", date } });
}

// ============================================================ rule 1 / T10 — coverage (12 CFR 1003.2(g)(2)) and the filing deadlines
export interface CoverageInput { readonly partner_id: string; readonly reporting_year: number; readonly msa_office_on_dec31: boolean; readonly closed_end_y1: number; readonly closed_end_y2: number; readonly open_end_y1?: number; readonly open_end_y2?: number; readonly preceding_year_total_records?: number; readonly evidence_document_id?: string | null; }
export interface CoverageTest extends CoverageInput { readonly test_id: string; readonly covered: boolean; readonly quarterly_reporter: boolean; readonly basis: string; readonly filing_deadline: PlainDate; readonly decided_by_officer_id: string | null; readonly decided_by_officer_at: string | null; }
/** Mar 1 of Y+1 (2026 data → Mon Mar 1, 2027; 2027 → Wed Mar 1, 2028) — no weekend/holiday adjustment stated in the rule. */
export function annualDeadline(reporting_year: number): PlainDate { return ymd(reporting_year + 1, 3, 1); }
/** Quarter-end + 60 calendar days (Q1 2027 → Sun May 30; Q2 → Sun Aug 29; Q3 → Mon Nov 29, 2027). */
export function quarterlyDeadline(year: number, quarter: 1 | 2 | 3): PlainDate { return addDays(endOfMonth(ymd(year, quarter * 3, 1)), QUARTERLY_DAYS_AFTER_QUARTER); }
export function coverageTest(i: CoverageInput): CoverageTest {
  for (const n of [i.closed_end_y1, i.closed_end_y2, i.open_end_y1 ?? 0, i.open_end_y2 ?? 0]) need(Number.isInteger(n) && n >= 0, "origination counts are non-negative integers");
  const closed = i.closed_end_y1 >= COVERAGE_CLOSED_END_MIN && i.closed_end_y2 >= COVERAGE_CLOSED_END_MIN;
  const open = (i.open_end_y1 ?? 0) >= COVERAGE_OPEN_END_MIN && (i.open_end_y2 ?? 0) >= COVERAGE_OPEN_END_MIN;
  const covered = i.msa_office_on_dec31 && (closed || open);
  const quarterly_reporter = covered && (i.preceding_year_total_records ?? 0) >= QUARTERLY_REPORTER_THRESHOLD;
  const y = i.reporting_year;
  const basis = `${y} data: MSA office on Dec 31, ${y - 1} = ${i.msa_office_on_dec31}; closed-end ${y - 2} = ${i.closed_end_y2}, ${y - 1} = ${i.closed_end_y1} (each ≥ ${COVERAGE_CLOSED_END_MIN}: ${closed}); open-end test ${open} → covered = ${covered}${covered ? `; file by ${annualDeadline(y)}` : "; captured and edit-checked, not filed (28.3-Q2: no voluntary filing)"}`;
  return { ...i, open_end_y1: i.open_end_y1 ?? 0, open_end_y2: i.open_end_y2 ?? 0, preceding_year_total_records: i.preceding_year_total_records ?? 0, evidence_document_id: i.evidence_document_id ?? null, test_id: `COV-${i.partner_id}-${y}`, covered, quarterly_reporter, basis, filing_deadline: annualDeadline(y), decided_by_officer_id: null, decided_by_officer_at: null };
}
/** The partner `officer` decides coverage (by Jan 31; SM supplies the evidence) — `hmda.coverage.determined{covered}`; `covered=true` arms `HMDA_1003_5_ANNUAL_0301` anchored on the Mar 1 deadline. */
export function recordCoverageDecision(events: EventStore, test: CoverageTest, officer: Actor, at: string): { test: CoverageTest; event: DomainEvent } {
  need(officer.kind === "human" && officer.role === "officer", "the coverage decision is the partner officer's own act (28.3 guardrail: never files for an uncovered partner without the officer's coverage decision)");
  const decided: CoverageTest = { ...test, decided_by_officer_id: officer.id, decided_by_officer_at: at };
  const event = events.append({ type: "hmda.coverage.determined", actor: officer, occurredAt: at, aggregate: { kind: "hmda_filing", id: `${test.partner_id}-${test.reporting_year}` }, payload: { source: "origination", application_id: `hmda-filing-${test.partner_id}-${test.reporting_year}`, partner_id: test.partner_id, reporting_year: test.reporting_year, covered: test.covered, quarterly_reporter: test.quarterly_reporter, filing_deadline: test.filing_deadline, decided_by: officer.id, basis: test.basis } });
  return { test: decided, event };
}
/** Jan 2 each year: the coverage-test tick (`HMDA_1003_2G_COVERAGE_TEST_ANNUAL`; undecided by Jan 31 → sev 2, default "covered" — file rather than miss). */
export function coverageTestTick(events: EventStore, date: PlainDate, partner_id: string): DomainEvent {
  return events.append({ type: "schedule.tick", actor: SCHEDULER, occurredAt: `${date}T13:00:00.000Z`, aggregate: { kind: "hmda_filing", id: `${partner_id}-${parts(date).y - 1}` }, payload: { source: "origination", application_id: `hmda-filing-${partner_id}-${parts(date).y - 1}`, cadence: "annual", job: "hmda_coverage_test", date, partner_id, reporting_year: parts(date).y - 1, decide_by: ymd(parts(date).y, 1, 31) } });
}
/** Quarter-end tick for a quarterly reporter (`HMDA_1003_5_QUARTERLY_60`: +60 calendar days). */
export function quarterEndTick(events: EventStore, quarter_end: PlainDate, partner_id: string, quarterly_reporter: boolean): DomainEvent {
  const { y, m } = parts(quarter_end); const quarter = m / 3; need([3, 6, 9].includes(m) && parts(quarter_end).d === parts(endOfMonth(quarter_end)).d, "Q1–Q3 quarter-end date");
  return events.append({ type: "schedule.tick", actor: SCHEDULER, occurredAt: `${quarter_end}T23:59:00.000Z`, aggregate: { kind: "hmda_filing", id: `${partner_id}-${y}-Q${quarter}` }, payload: { source: "origination", application_id: `hmda-filing-${partner_id}-${y}-Q${quarter}`, cadence: "quarterly", job: "hmda_quarterly_lar", date: quarter_end, quarter_end, quarter, reporting_year: y, quarterly_reporter, partner_id, filing_deadline: quarterlyDeadline(y, quarter as 1 | 2 | 3) } });
}

// ============================================================ rule 14 / T9 — the annual file (TS + LAR), the platform workflow and the officer's signature
export interface PartnerFiling { readonly partner_id: string; readonly institution_name: string; readonly lei: string; readonly tin: string; readonly contact: { name: string; phone: string; email: string; address: string; city: string; state: string; zip: string }; readonly federal_agency?: number; }
export type LarFileKind = "annual" | "quarterly" | "resubmission";
export interface PlatformEdit { readonly edit_code: string; readonly edit_type: "S" | "V" | "Q" | "M"; readonly affected_ulis: readonly string[]; readonly description: string; }
export interface EditVerification { readonly verification_id: string; readonly lar_file_id: string; readonly edit_code: string; readonly edit_type: "S" | "V" | "Q" | "M"; readonly affected_ulis: readonly string[]; readonly explanation: string; readonly verified_by: string; readonly verified_at: string; }
export interface LarFile {
  readonly lar_file_id: string; readonly partner_id: string; readonly lei: string; readonly reporting_year: number; readonly quarter: 1 | 2 | 3 | null; readonly kind: LarFileKind;
  readonly ts_row: string; readonly lar_rows: readonly string[]; readonly lar_row_count: number; readonly ulis: readonly string[]; readonly sha256: string; readonly built_at: string;
  readonly platform_sequence_number: number | null; readonly status_code: number; readonly parse_errors: readonly string[]; readonly sv_edits: readonly PlatformEdit[]; readonly quality_edits: readonly PlatformEdit[]; readonly macro_edits: readonly PlatformEdit[];
  readonly verifications: readonly EditVerification[]; readonly quality_verified_by: string | null; readonly quality_verified_at: string | null; readonly macro_verified_by: string | null; readonly macro_verified_at: string | null;
  readonly signed_by_officer_id: string | null; readonly signed_at: string | null; readonly receipt: string | null; readonly filing_deadline: PlainDate; readonly edits_target_on: PlainDate; readonly sign_by_on: PlainDate; readonly supersedes_lar_file_id: string | null; readonly retention_class: "hmda_3y";
}
const filingSubject = (f: Pick<LarFile, "partner_id" | "reporting_year" | "quarter">): { kind: string; id: string } => ({ kind: "hmda_filing", id: `${f.partner_id}-${f.reporting_year}${f.quarter ? `-Q${f.quarter}` : ""}` });
function emitFiling(events: EventStore, f: LarFile, type: string, payload: Record<string, unknown>, at: string, actor: Actor = HMDA_AGENT): DomainEvent {
  return events.append({ type, actor, occurredAt: at, aggregate: filingSubject(f), payload: { source: "origination", application_id: `hmda-filing-${filingSubject(f).id}`, lar_file_id: f.lar_file_id, partner_id: f.partner_id, reporting_year: f.reporting_year, quarter: f.quarter, kind: f.kind, ...payload } });
}
const pipe = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const codes5 = (xs: readonly number[]): string[] => Array.from({ length: 5 }, (_, k) => pipe(xs[k]));
/** One LAR row (Record Identifier 2; the 110 FIG fields in order) from the record. */
export function larRow(r: HmdaRecord): string {
  const a = r.applicant ?? { ethnicity: [NOT_PROVIDED.ethnicity], ethnicity_free_text: null, race: [NOT_PROVIDED.race], race_free_text: [], sex: NOT_PROVIDED.sex, ethnicity_observed: 3, race_observed: 3, sex_observed: 3, age: NA_AGE };
  const c = r.co_applicant ?? noCoApplicant();
  const denial = r.action_taken === 3 ? r.denial_reasons : [10];
  const f: unknown[] = [
    2, r.lei, r.uli, r.application_date.replace(/-/g, ""), r.loan_type, r.loan_purpose, r.preapproval, r.construction_method, r.occupancy_type, larDollars(r.loan_amount_cents).replace(/\.00$/, ""), r.action_taken, r.action_taken_date?.replace(/-/g, ""),
    r.street_address ?? "NA", r.city ?? "NA", r.state ?? "NA", r.zip ?? "NA", r.county_fips ?? "NA", r.census_tract ?? "NA",
    ...codes5(a.ethnicity), a.ethnicity_free_text, ...codes5(c.ethnicity), c.ethnicity_free_text, a.ethnicity_observed, c.ethnicity_observed,
    ...codes5(a.race), a.race_free_text[0], a.race_free_text[1], a.race_free_text[2], ...codes5(c.race), c.race_free_text[0], c.race_free_text[1], c.race_free_text[2], a.race_observed, c.race_observed,
    a.sex, c.sex, a.sex_observed, c.sex_observed, a.age, c.age, r.income_thousands ?? "NA", r.purchaser_type ?? 0, r.rate_spread ?? "NA", r.hoepa_status ?? 3, r.lien_status,
    r.applicant_credit_score ?? NA_SCORE, r.co_applicant_credit_score ?? NA_SCORE, r.applicant_score_model ?? NA_SCORE_MODEL, "", r.co_applicant_score_model ?? (r.co_applicant ? NA_SCORE_MODEL : 10), "",
    denial[0], denial[1], denial[2], denial[3], r.denial_reason_other_text,
    larMoneyField("total_loan_costs", r.total_loan_costs_cents, r.action_taken), larMoneyField("total_points_and_fees", r.total_points_and_fees_cents, r.action_taken), larMoneyField("origination_charges", r.origination_charges_cents, r.action_taken), larMoneyField("discount_points", r.discount_points_cents, r.action_taken), larMoneyField("lender_credits", r.lender_credits_cents, r.action_taken),
    larRate(r.interest_rate, r.action_taken), r.prepayment_penalty_term ?? "NA", r.dti ?? "NA", r.cltv ?? "NA", r.loan_term_months ?? "NA", r.intro_rate_period_months ?? "NA", r.balloon, r.interest_only, r.negative_amortization, r.other_non_amortizing,
    r.property_value_cents !== null ? larDollars(r.property_value_cents).replace(/\.00$/, "") : "NA", r.mh_secured_property_type, r.mh_land_property_interest, r.total_units ?? 1, r.multifamily_affordable_units ?? "NA", r.submission_of_application, r.initially_payable, r.nmlsr_id ?? "NA",
    r.aus_1 ?? 6, "", "", "", "", "", r.aus_result_1 ?? 17, "", "", "", "", "", r.reverse_mortgage, r.open_end, r.business_purpose,
  ];
  need(f.length === 110, `LAR row has ${f.length} fields, FIG requires 110`);
  return f.map(pipe).join("|");
}
/** The transmittal sheet (Record Identifier 1; 15 fields; federal agency 9 = CFPB for a nondepository). */
export function tsRow(p: PartnerFiling, reporting_year: number, quarter: 1 | 2 | 3 | 4, total_entries: number): string {
  const f = [1, p.institution_name, reporting_year, quarter, p.contact.name, p.contact.phone, p.contact.email, p.contact.address, p.contact.city, p.contact.state, p.contact.zip, p.federal_agency ?? 9, total_entries, p.tin, p.lei];
  need(f.length === 15, "TS row has 15 fields");
  return f.map(pipe).join("|");
}
/** Jan 5, Y+1 (or a quarter-end + policy days): every non-excluded record of the year → TS + LAR .txt (pipe-delimited, not fixed length), sha256, `hmda.lar.built`. */
export function buildLarFile(events: EventStore, records: readonly HmdaRecord[], i: { partner: PartnerFiling; reporting_year: number; quarter?: 1 | 2 | 3 | null; kind?: LarFileKind; built_at: string; supersedes?: LarFile | null }, actor: Actor = HMDA_AGENT): { file: LarFile; text: string; event: DomainEvent } {
  const rows = records.filter((r) => r.reporting_year === i.reporting_year && r.excluded_reason === null && r.action_taken !== null && (!i.quarter || Math.ceil(parts(r.action_taken_date!).m / 3) === i.quarter));
  need(rows.length > 0, `no ${i.reporting_year} records to file`);
  const incomplete = rows.filter((r) => r.completeness_status !== "complete" && r.completeness_status !== "filed");
  need(incomplete.length === 0, `records not complete: ${incomplete.map((r) => r.uli).join(", ")} — the daily job must clear them before the build`);
  const lar_rows = rows.map(larRow);
  const ts = tsRow(i.partner, i.reporting_year, i.quarter ?? 4, lar_rows.length);
  const text = [ts, ...lar_rows].join("\n") + "\n";
  const kind: LarFileKind = i.kind ?? (i.supersedes ? "resubmission" : i.quarter ? "quarterly" : "annual");
  const y = i.reporting_year;
  const file: LarFile = { lar_file_id: `LAR-${i.partner.partner_id}-${y}${i.quarter ? `-Q${i.quarter}` : ""}-${(i.supersedes ? (i.supersedes.platform_sequence_number ?? 0) + 1 : 1)}`, partner_id: i.partner.partner_id, lei: i.partner.lei, reporting_year: y, quarter: i.quarter ?? null, kind,
    ts_row: ts, lar_rows, lar_row_count: lar_rows.length, ulis: rows.map((r) => r.uli), sha256: createHash("sha256").update(text).digest("hex"), built_at: i.built_at, platform_sequence_number: null, status_code: 1, parse_errors: [], sv_edits: [], quality_edits: [], macro_edits: [], verifications: [],
    quality_verified_by: null, quality_verified_at: null, macro_verified_by: null, macro_verified_at: null, signed_by_officer_id: null, signed_at: null, receipt: null,
    filing_deadline: i.quarter ? quarterlyDeadline(y, i.quarter) : annualDeadline(y), edits_target_on: plainDate(`${y + 1}-${EDITS_TARGET_MONTH_DAY}`), sign_by_on: plainDate(`${y + 1}-${SIGN_BY_MONTH_DAY}`), supersedes_lar_file_id: i.supersedes?.lar_file_id ?? null, retention_class: "hmda_3y" };
  const event = emitFiling(events, file, "hmda.lar.built", { lar_row_count: file.lar_row_count, sha256: file.sha256, edits_target_on: file.edits_target_on, filing_deadline: file.filing_deadline, built_on: civil(i.built_at) }, i.built_at, actor);
  return { file, text, event };
}
/** `POST …/filings/{year}` + `POST …/submissions` + the multipart upload: a new sequence number per submission; −1 restarts at a new sequence. */
export function uploadSubmission(events: EventStore, file: LarFile, i: { sequence_number: number; at: string; operator: Actor }): { file: LarFile; event: DomainEvent } {
  need(Number.isInteger(i.sequence_number) && i.sequence_number >= 1, "platform sequence number ≥ 1");
  need(file.platform_sequence_number === null || file.status_code === -1, `file ${file.lar_file_id} already uploaded as sequence ${file.platform_sequence_number}; corrections create a new submission`);
  const next: LarFile = { ...file, platform_sequence_number: i.sequence_number, status_code: 3 };
  return { file: next, event: emitFiling(events, next, "hmda.lar.uploaded", { sequence_number: i.sequence_number, sha256: file.sha256, uploaded_by: i.operator.id }, i.at) };
}
/** The platform's edit report (`GET …/edits`): status 5 → parse errors; 8/9 S/V; 10/11 quality; 12/13 macro; records named by an S/V edit go `edits_failed`. */
export function receiveEdits(events: EventStore, file: LarFile, records: readonly HmdaRecord[], i: { status_code: number; edits?: readonly PlatformEdit[]; parse_errors?: readonly string[]; at: string }): { file: LarFile; records: HmdaRecord[]; failed_ulis: string[]; event: DomainEvent } {
  need([5, 6, 7, 8, 9, 10, 11, 12, 13, -1].includes(i.status_code), `unexpected platform status ${i.status_code}`);
  const edits = i.edits ?? [];
  const sv = edits.filter((e) => e.edit_type === "S" || e.edit_type === "V"), q = edits.filter((e) => e.edit_type === "Q"), m = edits.filter((e) => e.edit_type === "M");
  const failed = [...new Set(sv.flatMap((e) => e.affected_ulis))];
  const next: LarFile = { ...file, status_code: i.status_code, parse_errors: [...(i.parse_errors ?? [])], sv_edits: sv.length ? sv : file.sv_edits, quality_edits: q.length ? q : file.quality_edits, macro_edits: m.length ? m : file.macro_edits };
  const recs = records.map((r) => (failed.includes(r.uli) ? { ...r, completeness_status: "edits_failed" as const, missing_fields: sv.filter((e) => e.affected_ulis.includes(r.uli)).map((e) => e.edit_code) } : r));
  return { file: next, records: recs, failed_ulis: failed, event: emitFiling(events, next, "hmda.lar.edits_received", { status_code: i.status_code, sv: sv.map((e) => e.edit_code), quality: q.map((e) => e.edit_code), macro: m.map((e) => e.edit_code), failed_ulis: failed }, i.at) };
}
/** Rule 15: a data correction flows through the owning process; the record returns to `complete` with a `correction_log` entry (ULIs, error class, discovery route) — evidence for §1003.6. */
export function correctAtSource<K extends keyof HmdaRecord>(events: EventStore, rec: HmdaRecord, i: { data_point: K; value: HmdaRecord[K]; source: FieldSource; error_class: string; discovery_route: CorrectionLogEntry["discovery_route"]; owning_process: string; corrected_by: string; at: string }): { record: HmdaRecord; entry: CorrectionLogEntry } {
  need(rec.completeness_status === "edits_failed" || rec.completeness_status === "filed" || rec.completeness_status === "complete", "corrections apply to complete/edits_failed/filed records; open records are re-derived");
  const entry: CorrectionLogEntry = { correction_id: `CORR-${rec.uli}-${rec.correction_log.length + 1}`, ulis: [rec.uli], error_class: i.error_class, discovery_route: i.discovery_route, owning_process: i.owning_process, corrected_by: i.corrected_by, corrected_at: i.at, detail: { data_point: i.data_point, before: typeof rec[i.data_point] === "bigint" ? String(rec[i.data_point]) : rec[i.data_point], after: typeof i.value === "bigint" ? String(i.value) : i.value } };
  const next = derive(events, rec, i.data_point, i.value, i.source, i.at);
  return { record: { ...next, completeness_status: "complete", missing_fields: [], correction_log: [...rec.correction_log, entry] }, entry };
}
/** Every Q/M edit is explained with the supporting numbers before verification (`hmda_edit_verifications`); an explanation that cites no data is refused. */
export function explainEdit(file: LarFile, i: { edit_code: string; explanation: string; verified_by: string; at: string }): { file: LarFile; verification: EditVerification } {
  const edit = [...file.quality_edits, ...file.macro_edits].find((e) => e.edit_code === i.edit_code);
  need(edit, `${i.edit_code} is not a quality or macro edit on ${file.lar_file_id} (S/V edits are corrected at source, never explained)`);
  need(/\d/.test(i.explanation) && i.explanation.length >= 20, "an edit explanation is a record: it must cite the data (numbers) supporting the verification");
  const verification: EditVerification = { verification_id: `EV-${file.lar_file_id}-${i.edit_code}`, lar_file_id: file.lar_file_id, edit_code: i.edit_code, edit_type: edit!.edit_type, affected_ulis: edit!.affected_ulis, explanation: i.explanation, verified_by: i.verified_by, verified_at: i.at };
  return { file: { ...file, verifications: [...file.verifications.filter((v) => v.edit_code !== i.edit_code), verification] }, verification };
}
const unexplained = (file: LarFile, type: "Q" | "M"): string[] => (type === "Q" ? file.quality_edits : file.macro_edits).filter((e) => !file.verifications.some((v) => v.edit_code === e.edit_code)).map((e) => e.edit_code);
/** `POST …/edits/quality {"verified": true}` — only when every quality edit has a stored explanation; status → 12 (macro analysis) or 13 (macro edits already reported). */
export function verifyQualityEdits(events: EventStore, file: LarFile, i: { by: string; at: string }): { file: LarFile; event: DomainEvent } {
  need(file.status_code >= 10 && file.status_code < 12, `quality verification needs status 10/11 (status ${file.status_code})`);
  const open = unexplained(file, "Q"); need(open.length === 0, `quality edits without a stored explanation: ${open.join(", ")}`);
  const next: LarFile = { ...file, status_code: file.macro_edits.length ? 13 : 12, quality_verified_by: i.by, quality_verified_at: i.at };
  return { file: next, event: emitFiling(events, next, "hmda.lar.quality_verified", { status_code: next.status_code, verified_by: i.by, edits: file.quality_edits.map((e) => e.edit_code) }, i.at) };
}
/** `POST …/edits/macro {"verified": true}` — status 14 "Ready for submission"; arms `SM_HMDA_OFFICER_SIGN_SLA_5BD` (+5 creditor business days, never later than Mar 1). */
export function verifyMacroEdits(events: EventStore, file: LarFile, i: { by: string; at: string }): { file: LarFile; event: DomainEvent; sign_due_on: PlainDate } {
  need(file.status_code === 12 || file.status_code === 13, `macro verification needs status 12/13 (status ${file.status_code})`);
  need(file.quality_verified_at !== null, "quality edits are verified before macro edits");
  const open = unexplained(file, "M"); need(open.length === 0, `macro edits without a stored explanation: ${open.join(", ")}`);
  const next: LarFile = { ...file, status_code: 14, macro_verified_by: i.by, macro_verified_at: i.at };
  const sign_due_on = officerSignDue(civil(i.at), file.filing_deadline);
  return { file: next, event: emitFiling(events, next, "hmda.lar.macro_verified", { status_code: 14, verified_by: i.by, verified_on: civil(i.at), sign_due_on, filing_deadline: file.filing_deadline }, i.at), sign_due_on };
}
/** +5 `business_days_creditor` from the verification date, capped at the filing deadline (Jan 8 → Fri Jan 15, 2027). */
export function officerSignDue(verified_on: PlainDate, filing_deadline: PlainDate): PlainDate { const d = addBusinessDays(verified_on, OFFICER_SIGN_BUSINESS_DAYS, creditor); return d < filing_deadline ? d : filing_deadline; }
/** `POST …/sign {"signed": true}` — executed only under the officer's own token (human `officer`), only at status 14; stores the receipt; `hmda.lar.signed` + `hmda.lar.accepted` (status 15) satisfy the SLA and the deadline. */
export function signSubmission(events: EventStore, file: LarFile, i: { officer: Actor; at: string; receipt: string }): { file: LarFile; events: DomainEvent[] } {
  need(i.officer.kind === "human" && i.officer.role === "officer", "the /sign call is executed only with the officer's token after the officer's explicit approval (28.3 guardrail: the agent never signs)");
  need(file.status_code === 14, `signing needs status 14 Ready for submission (status ${file.status_code}: ${file.status_code < 14 ? "edits outstanding" : "already accepted"})`);
  need(i.receipt.length > 0, "the platform receipt is stored with the signature");
  const next: LarFile = { ...file, status_code: 15, signed_by_officer_id: i.officer.id, signed_at: i.at, receipt: i.receipt };
  const e1 = emitFiling(events, next, "hmda.lar.signed", { signed_by: i.officer.id, signed_at: i.at, signed_on: civil(i.at) }, i.at, i.officer);
  const e2 = emitFiling(events, next, "hmda.lar.accepted", { status_code: 15, signed_at: i.at, signed_by: i.officer.id, receipt: i.receipt, sequence_number: next.platform_sequence_number, lar_row_count: next.lar_row_count, sha256: next.sha256, retention_class: RETENTION_CLASS_28_3 }, i.at, i.officer);
  return { file: next, events: [e1, e2] };
}
/** Records included in an accepted submission are `filed` (terminal for the year). */
export function markFiled(records: readonly HmdaRecord[], file: LarFile): HmdaRecord[] {
  need(file.status_code === 15, "records are filed only by an accepted submission");
  return records.map((r) => (file.ulis.includes(r.uli) ? { ...r, completeness_status: "filed" as const, lar_file_id: file.lar_file_id } : r));
}

// ============================================================ rule 16 / T13 — public notices (§1003.5(b)(2), (c)(1), (d), (e))
export type PublicNoticeKind = "disclosure_statement_notice_b2" | "modified_lar_notice_c1" | "lobby_notice_e";
export const PUBLIC_NOTICE_SHORT: Record<PublicNoticeKind, "b2" | "c1" | "e"> = { disclosure_statement_notice_b2: "b2", modified_lar_notice_c1: "c1", lobby_notice_e: "e" };
export interface PublicNotice { readonly notice_id: string; readonly partner_id: string; readonly kind: PublicNoticeKind; readonly year: number; readonly template_code: string; readonly ffiec_notice_received_at: PlainDate | null; readonly due_on: PlainDate | null; readonly made_available_at: PlainDate; readonly available_until: PlainDate | null; readonly locations: readonly string[]; readonly evidence_document_id: string | null; readonly last_attested_at: PlainDate | null; }
/** +3 `business_days_creditor` from the FFIEC availability notice (Wed Jun 16, 2027 → Mon Jun 21, 2027). */
export function disclosureNoticeDue(received_on: PlainDate): PlainDate { return addBusinessDays(received_on, DISCLOSURE_NOTICE_BUSINESS_DAYS, creditor); }
/** The FFIEC's disclosure-statement availability e-mail: arms `HMDA_1003_5B_DISCLOSURE_NOTICE_3BD`. */
export function receiveFfiecDisclosureNotice(events: EventStore, i: { partner_id: string; year: number; received_on: PlainDate; at: string }): { due_on: PlainDate; event: DomainEvent } {
  const due_on = disclosureNoticeDue(i.received_on);
  return { due_on, event: events.append({ type: "hmda.ffiec.disclosure_notice.received", actor: { kind: "external", id: "ffiec" }, occurredAt: i.at, aggregate: { kind: "hmda_filing", id: `${i.partner_id}-${i.year}` }, payload: { source: "origination", application_id: `hmda-filing-${i.partner_id}-${i.year}`, partner_id: i.partner_id, reporting_year: i.year, received_on: i.received_on, due_on } }) };
}
/** The notice made available at the home office and each MSA/MD branch: b2 for 5 years, c1 for 3 years, the lobby notice permanently; `hmda.public_notice.made_available{kind}`. */
export function makePublicNoticeAvailable(events: EventStore, i: { partner_id: string; kind: PublicNoticeKind; year: number; made_available_on: PlainDate; locations: readonly string[]; ffiec_notice_received_on?: PlainDate | null; evidence_document_id?: string | null; at?: string }): { notice: PublicNotice; event: DomainEvent } {
  need(i.locations.length >= 1 && i.locations.some((l) => /home/i.test(l)), "the home office (and each MSA/MD branch) is a required location");
  const short = PUBLIC_NOTICE_SHORT[i.kind];
  const available_until = short === "b2" ? addYears(i.made_available_on, B2_NOTICE_YEARS) : short === "c1" ? addYears(i.made_available_on, C1_NOTICE_YEARS) : null;
  const due_on = short === "b2" && i.ffiec_notice_received_on ? disclosureNoticeDue(i.ffiec_notice_received_on) : null;
  need(due_on === null || i.made_available_on <= due_on, `the (b)(2) notice was due ${due_on} (3 business days after ${i.ffiec_notice_received_on}); made available ${i.made_available_on} is late`);
  const notice: PublicNotice = { notice_id: `PN-${i.partner_id}-${short}-${i.year}`, partner_id: i.partner_id, kind: i.kind, year: i.year, template_code: NOTICE_CODES_28_3[short], ffiec_notice_received_at: i.ffiec_notice_received_on ?? null, due_on, made_available_at: i.made_available_on, available_until, locations: [...i.locations], evidence_document_id: i.evidence_document_id ?? null, last_attested_at: i.made_available_on };
  const at = i.at ?? `${i.made_available_on}T17:00:00.000Z`;
  const event = events.append({ type: "hmda.public_notice.made_available", actor: { kind: "human", id: "office-manager", role: "officer" }, occurredAt: at, aggregate: { kind: "hmda_filing", id: `${i.partner_id}-${i.year}` }, payload: { source: "origination", application_id: `hmda-filing-${i.partner_id}-${i.year}`, notice_id: notice.notice_id, partner_id: i.partner_id, kind: short, year: i.year, template_code: notice.template_code, made_available_on: i.made_available_on, available_until, locations: notice.locations, evidence_document_id: notice.evidence_document_id } });
  return { notice, event };
}
/** The office manager's annual attestation that the notice is still available during business hours (`HMDA_1003_5D_NOTICE_AVAILABILITY`). */
export function attestNoticeAvailability(events: EventStore, notice: PublicNotice, i: { attested_on: PlainDate; attested_by: string; evidence_document_id: string }): { notice: PublicNotice; event: DomainEvent } {
  need(notice.available_until === null || i.attested_on <= notice.available_until, `the ${PUBLIC_NOTICE_SHORT[notice.kind]} window closed ${notice.available_until}`);
  const next: PublicNotice = { ...notice, last_attested_at: i.attested_on, evidence_document_id: i.evidence_document_id };
  return { notice: next, event: events.append({ type: "hmda.public_notice.attested", actor: { kind: "human", id: i.attested_by, role: "officer" }, occurredAt: `${i.attested_on}T17:00:00.000Z`, aggregate: { kind: "hmda_filing", id: `${notice.partner_id}-${notice.year}` }, payload: { source: "origination", application_id: `hmda-filing-${notice.partner_id}-${notice.year}`, notice_id: notice.notice_id, kind: PUBLIC_NOTICE_SHORT[notice.kind], year: notice.year, attested_on: i.attested_on, evidence_document_id: i.evidence_document_id } }) };
}
/** The availability window as the evaluator sees it: open (compliant) while the notice is within its window and attested within the last 12 months. */
export function noticeAvailabilityWindow(f: { made_available_on?: unknown; available_until?: unknown; last_attested_on?: unknown; as_of?: unknown }): { open: boolean; reason?: string } {
  const start = isDate(f.made_available_on) ? f.made_available_on : null, until = isDate(f.available_until) ? f.available_until : null, attested = isDate(f.last_attested_on) ? f.last_attested_on : null, as_of = isDate(f.as_of) ? f.as_of : null;
  if (!start || !as_of) return { open: false, reason: "made_available_on and as_of are required" };
  if (until !== null && as_of > until) return { open: true, reason: `window closed ${until}: no availability duty remains` };
  if (!attested || daysBetween(attested, as_of) > 365) return { open: false, reason: `notice made available ${start} needs an office attestation within 12 months (last ${attested ?? "none"}, as of ${as_of})` };
  return { open: true };
}
/** Jan 1 following the data year: the modified-LAR notice tick (`HMDA_1003_5C_MODIFIED_LAR_NOTICE_ANNUAL`; policy: available by Mar 31). */
export function modifiedLarNoticeTick(events: EventStore, date: PlainDate, partner_id: string): DomainEvent {
  const year = parts(date).y - 1;
  return events.append({ type: "schedule.tick", actor: SCHEDULER, occurredAt: `${date}T13:00:00.000Z`, aggregate: { kind: "hmda_filing", id: `${partner_id}-${year}` }, payload: { source: "origination", application_id: `hmda-filing-${partner_id}-${year}`, cadence: "annual", job: "hmda_modified_lar_notice", date, partner_id, reporting_year: year, available_by: plainDate(`${parts(date).y}-${MODIFIED_LAR_NOTICE_MONTH_DAY}`) } });
}

// ============================================================ T14 — the access-logged read path to `applicant_demographics`
export interface DemographicsAccess { readonly actor: Actor; readonly process: string; readonly application_id: string; readonly borrower_id: string; readonly purpose: string; readonly at: string; }
/** Only the `hmda` agent (28.3) and 31.2's fair-lending monitoring read `applicant_demographics`; every read is logged; any production agent is refused and the refusal logged. */
export function readApplicantDemographics<T>(events: EventStore, a: DemographicsAccess, rows: Readonly<Record<string, T>>): { row: T; event: DomainEvent } {
  const allowed = a.actor.kind === "agent" && DEMOGRAPHICS_READERS.some((r) => r.agent === a.actor.id && r.process === a.process);
  if (!allowed) {
    emit(events, a.application_id, "applicant_demographics.access_denied", { actor_id: a.actor.id, actor_kind: a.actor.kind, process: a.process, borrower_id: a.borrower_id, purpose: a.purpose, table: "restricted_fl.applicant_demographics" }, a.at, a.actor);
    throw new RangeError(`restricted_fl.applicant_demographics: read by ${a.actor.kind}:${a.actor.id} (${a.process}) refused — only the hmda agent (28.3) and 31.2 monitoring read demographic fields (28.3 guardrail)`);
  }
  const row = rows[a.borrower_id]; need(row !== undefined, `no applicant_demographics row for ${a.borrower_id}`);
  const event = emit(events, a.application_id, "applicant_demographics.access_logged", { actor_id: a.actor.id, actor_kind: a.actor.kind, process: a.process, borrower_id: a.borrower_id, purpose: a.purpose, table: "restricted_fl.applicant_demographics" }, a.at, a.actor);
  return { row: row!, event };
}
export function demographicsAccessLog(events: EventStore): { actor_id: string; process: string; allowed: boolean; borrower_id: string }[] {
  return events.all().filter((e) => e.type === "applicant_demographics.access_logged" || e.type === "applicant_demographics.access_denied").map((e) => { const p = e.payload as Record<string, unknown>; return { actor_id: String(p.actor_id), process: String(p.process), allowed: e.type === "applicant_demographics.access_logged", borrower_id: String(p.borrower_id) }; });
}

// ============================================================ the agent's decision record
export function inputsHash(x: unknown): string { return createHash("sha256").update(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))).digest("hex"); }
export function decisionRecord(i: { hmda_record_id?: string | null; lar_file_id?: string | null; action: string; inputs: unknown; field_sources?: Readonly<Record<string, FieldSource>>; edits?: readonly EditVerification[]; model_version: string; prompt_version: string; rationale: string; confidence?: number }): Record<string, unknown> {
  need(i.rationale.trim().length > 0, "a decision record carries a rationale");
  return { hmda_record_id: i.hmda_record_id ?? null, lar_file_id: i.lar_file_id ?? null, action: i.action, inputs_hash: inputsHash(i.inputs), field_sources: i.field_sources ?? {}, edits: (i.edits ?? []).map((e) => ({ code: e.edit_code, type: e.edit_type, ulis: e.affected_ulis, explanation: e.explanation, verified_by: e.verified_by })), rule_set_version: RULE_SET_VERSION_28_3, model_version: i.model_version, prompt_version: i.prompt_version, rationale: i.rationale, confidence: i.confidence ?? 1, demographics_read_path: "restricted (hmda agent; access-logged)" };
}
/** Policy calendar for a data year: Jan 5 build, Feb 1 clean edits, Feb 20 sign, Mar 1 deadline, Jan 2 coverage tick, Jan 31 coverage decision, Mar 31 modified-LAR notice. */
export function filingCalendar(reporting_year: number): { build_on: PlainDate; edits_target_on: PlainDate; sign_by_on: PlainDate; deadline: PlainDate; coverage_tick_on: PlainDate; coverage_decide_by: PlainDate; modified_lar_notice_by: PlainDate; q1: PlainDate; q2: PlainDate; q3: PlainDate } {
  const y = reporting_year + 1;
  return { build_on: plainDate(`${y}-${ANNUAL_BUILD_MONTH_DAY}`), edits_target_on: plainDate(`${y}-${EDITS_TARGET_MONTH_DAY}`), sign_by_on: plainDate(`${y}-${SIGN_BY_MONTH_DAY}`), deadline: annualDeadline(reporting_year), coverage_tick_on: ymd(y, 1, 2), coverage_decide_by: plainDate(`${y}-${COVERAGE_DECISION_MONTH_DAY}`), modified_lar_notice_by: plainDate(`${y}-${MODIFIED_LAR_NOTICE_MONTH_DAY}`), q1: quarterlyDeadline(y, 1), q2: quarterlyDeadline(y, 2), q3: quarterlyDeadline(y, 3) };
}
export { addMonths };
