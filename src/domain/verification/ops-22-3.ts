/**
 * §22.3 operating rules — income and employment verification: the B3-3.1-04 verification windows (10 creditor business
 * days for the verbal VOE, 15 for the paystub/bank-statement alternative, 120 calendar days for the self-employment
 * business-existence check), the versioned income formulas (base, hourly, 2026 variable-income trending, bonus
 * annualisation, Social Security and child-support gross-up, B3-3.8 subject-property rental with the management-
 * experience test and the 30% ADU cap, employment offers, temporary leave), the three-year continuance test, the DU
 * "Close by Date" gate, the Form 4506-C/8821 validity clock, the Income Calculator ceiling, the Reg B no-discount check
 * and the ATR record manifest. Pure functions over the application aggregate; every state change is an appended event
 * keyed by `applicationId` (the origination context src/kernel/timers/engine.ts arms 22.3's clocks on).
 *
 * Money is bigint cents; intermediate values keep full precision (bigint cross-multiplication or src/kernel/money
 * Decimal) and the single half-up rounding happens at the final monthly figure of each source (spec 22.3 rule preamble).
 *
 * Events (timer subject = the application):
 *   income.documentation.matrix.built{application_id, items}                                        (buildDocumentationMatrix)
 *   income.calculated{income_id, income_type, formula_version, monthly_qualifying_cents, gross_up_cents, nontaxable_cents, qualifying_cents, trend,
 *                     stabilized_since, continuance_basis, continuance_end_date, regb_flags, regb_check, scheduled_note_date}   arms FNMA_B3_3_1_01_CONTINUANCE_3Y
 *   income.trend.assessed{income_id, trend, ytd_monthly_cents, prior_monthly_cents}
 *   income.continuance.evaluated{income_id, result∈{pass, fail}, continuance_end_date, required_through}   satisfies FNMA_B3_3_1_01_CONTINUANCE_3Y when result=pass
 *   income.excluded{income_id, reason_code, written_reason}                                          (22.5 recalculates the DTI)
 *   income.validated{component, close_by_date, report_reference_id, supplier_code}                   arms FNMA_B3_2_02_DU_CLOSE_BY_GATE (component=employment)
 *   income.not_validated{component, documentation_required}                                          22.1 needs-list items
 *   du.close_by.missed{close_by_date, scheduled_note_date, cure_options, vvoe_window_start, vvoe_window_end}
 *   du.resubmission.requested{reason} / rep_warrant_relief.updated{component, status}
 *   vvoe.window.opened{vvoe_id, borrower_id, window_start, note_date_used, method}                   arms SM_VVOE_SCHEDULE_2BD
 *   vvoe.completed{vvoe_id, borrower_id, method, contacted_on, window_start, note_date_used, within_window}   satisfies FNMA_B3_3_1_04_VVOE_10BD / _ALT_15BD / SM_VVOE_SCHEDULE_2BD
 *   vvoe.window.missed{vvoe_id, contacted_on, window_start, note_date_used}
 *   business.existence.verified{verification_id, borrower_id, source, verified_at, window_start, within_window}   satisfies FNMA_B3_3_1_04_SE_VERIFY_120
 *   transcript.authorization.signed{request_id, borrower_id, form, signed_at, valid_until}          arms FNMA_B3_3_1_02_4506C_VALID_120
 *   transcript.ordered{request_id, channel, transcript_types, tax_years, fee_cents}                 satisfies FNMA_B3_3_1_02_4506C_VALID_120
 *   transcript.received{request_id, status} / transcript.discrepancy.detected{request_id, tax_year, transcript_cents, return_cents}
 *   employment.offer.option.selected{income_id, option, start_date, scheduled_note_date}            arms FNMA_B3_3_3_03_OFFER_START_WINDOW (option=2)
 *   employment.offer.verified{income_id, option, within_window, reserves_documented, sfc_codes}     satisfies it (option=2, within_window=true)
 *   employment.offer.option.refused{income_id, option, reason} / delivery.sfc.queued{code=707}
 *   income_calculator.submitted{income_id, borrower_id} / income_calculator.findings.received{income_id, report_id, result_cents}
 *   verification.received{kind∈{income, employment, vvoe, tax_transcript, rental}, verification_id, supplier_code, report_reference_id}
 *   income.finalized{application_id, total_qualifying_cents, sources, atr_manifest}                 23.1 final DU submission, 23.3 credit decision, 22.5 DTI, 23.4 ATR
 */
import { type PlainDate, addDays, addYears, plainDate as D } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor, type Calendar } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { Decimal, divRound } from "../../kernel/money/index.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { AGENT, CREDITOR_TZ, RULE_SET_VERSION } from "./ops-22-1.ts";

export { AGENT, CREDITOR_TZ, RULE_SET_VERSION };
export const BORROWER: Actor = { kind: "external", id: "borrower" };

const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
/** The creditor's civil date of an instant (or a date string as-is). */
export const civilDate = (iso: string, tz: string = CREDITOR_TZ): PlainDate => (isDate(iso) ? D(iso) : wallClock(Date.parse(iso), tz).date);
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const nonNeg = (v: bigint, what: string): bigint => { if (typeof v !== "bigint") throw new RangeError(`${what} must be bigint cents`); if (v < 0n) throw new RangeError(`${what} must be ≥ 0`); return v; };
const pct = (v: number, what: string): number => { if (!Number.isFinite(v) || v < 0 || v > 100) throw new RangeError(`${what} must be a percentage 0–100`); return v; };
const S = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : String(v));
const ids = (() => { let n = 0; return (prefix: string): string => `${prefix}-${(++n).toString(36)}`; })();

/** A refusal with a stable code and citation (tool handlers surface it as CommandRefused). */
export class IncomeRuleRefused extends Error {
  readonly code: string; readonly citation: string;
  constructor(code: string, citation: string, reason: string) { super(`${code}: ${reason}`); this.name = "IncomeRuleRefused"; this.code = code; this.citation = citation; }
}

// ============================================================ versioned formulas (data model `calc_method`; audit: "formula id and step-by-step arithmetic in cents")
export const FORMULAS = {
  base_salary: "B3-3.3-01.base_salary.v2026-03-04",
  base_hourly_fixed: "B3-3.3-01.base_hourly_fixed.v2026-03-04",
  variable_trending: "B3-3.3-02.variable_trending.v2026-03-04",
  bonus_annualized: "B3-3.3-02.bonus_annualized.v2026-03-04",
  employment_offer: "B3-3.3-03.employment_offer.v2026-03-04",
  temporary_leave: "B3-3.3-09.temporary_leave.v2026-03-04",
  gross_up: "B3-3.1-01.nontaxable_gross_up_25.v2026-03-04",
  social_security: "B3-3.4-15.social_security.v2026-03-04",
  child_support: "B3-3.4-02.alimony_child_support.v2026-03-04",
  retirement: "B3-3.4-03.retirement.v2026-03-04",
  public_assistance: "B3-3.4-12.public_assistance.v2026-03-04",
  rental_subject: "B3-3.8-02.subject_rental_75.v2026-09-02",
  adu_cap: "B3-3.8-02.adu_cap_30.v2026-09-02",
  self_employment: "B3-3.5-01.form_1084.v2023-12-13",
} as const;
export type FormulaId = (typeof FORMULAS)[keyof typeof FORMULAS];

export type IncomeType = "base_salary" | "base_hourly_fixed" | "base_hourly_variable" | "overtime" | "bonus" | "commission" | "tip" | "second_job" | "seasonal" | "employment_offer" | "temporary_leave" | "military_base" | "military_allowance" | "rsu"
  | "self_employment_sole_prop" | "self_employment_partnership" | "self_employment_s_corp" | "self_employment_c_corp" | "k1_under_25" | "rental_subject" | "rental_non_subject" | "rental_departing_residence" | "rental_short_term" | "rental_adu"
  | "alimony" | "child_support" | "separate_maintenance" | "equalization_payment" | "annuity_pension" | "retirement_distribution" | "social_security_retirement" | "social_security_disability" | "social_security_survivor_dependent" | "long_term_disability"
  | "public_assistance" | "section_8_homeownership" | "va_benefits" | "foster_care" | "interest_dividend" | "capital_gains" | "notes_receivable" | "royalty" | "trust" | "unemployment_seasonal" | "boarder" | "mortgage_credit_certificate" | "foreign_employment" | "other";
export type Trend = "stable" | "increasing" | "decreasing" | "n_a";
export type ContinuanceBasis = "no_expiration" | "documented_3y" | "retirement_own_record" | "n_a";
export type RegBFlag = "part_time" | "retirement" | "public_assistance" | "alimony_child_support" | "age_related" | "leave";
export type AtrRecordType = "payroll_statement" | "w2" | "irs_transcript" | "tax_return" | "employer_record_third_party" | "government_benefit_statement" | "financial_institution_record" | "court_order" | "lease" | "appraisal_rent_schedule";

export interface CalcStep { readonly label: string; readonly cents: string; }
/** One versioned calculation (data model `income_calculations`): inputs, steps with cents and the single rounding, the result. */
export interface IncomeCalculation {
  readonly income_type: IncomeType;
  readonly formula_version: FormulaId;
  readonly inputs: Record<string, string | number | boolean | null>;
  readonly steps: readonly CalcStep[];
  /** The monthly qualifying figure before any gross-up (R13 sums this and `gross_up_cents` separately). */
  readonly monthly_qualifying_cents: bigint;
  readonly nontaxable_cents: bigint;
  readonly gross_up_cents: bigint;
  /** monthly_qualifying_cents + gross_up_cents — the figure the spec calls "qualifying" for grossed-up sources. */
  readonly qualifying_cents: bigint;
  readonly trend: Trend;
  readonly stabilized_since: PlainDate | null;
  readonly continuance_basis: ContinuanceBasis;
  readonly continuance_end_date: PlainDate | null;
  readonly reason: string | null;
  readonly reclassified_to: IncomeType | null;
}
const calc = (c: Partial<IncomeCalculation> & Pick<IncomeCalculation, "income_type" | "formula_version" | "inputs" | "steps" | "monthly_qualifying_cents">): IncomeCalculation => {
  const nontaxable = c.nontaxable_cents ?? 0n, gross = c.gross_up_cents ?? 0n;
  return { nontaxable_cents: nontaxable, gross_up_cents: gross, qualifying_cents: c.monthly_qualifying_cents + gross, trend: "n_a", stabilized_since: null, continuance_basis: "no_expiration", continuance_end_date: null, reason: null, reclassified_to: null, ...c };
};

// ============================================================ R1 — verification windows (B3-3.1-04)
export const VVOE_BUSINESS_DAYS = 10;
export const VVOE_ALT_BUSINESS_DAYS = 15;
export const SE_VERIFY_CALENDAR_DAYS = 120;
export const LES_DMDC_CALENDAR_DAYS = 120;
export interface VerificationWindow { readonly note_date: PlainDate; readonly window_start: PlainDate; readonly rule: string; }
/** `window_start = subtract_business_days(note_date, 10, calendar='creditor')` — refinance fixture Fri Nov 6, 2026 → Fri Oct 23, 2026; purchase Wed Nov 18 → Tue Nov 3 (Veterans Day skipped). */
export function vvoeWindow(noteDate: PlainDate, cal: Calendar = creditor): VerificationWindow {
  return { note_date: noteDate, window_start: addBusinessDays(noteDate, -VVOE_BUSINESS_DAYS, cal), rule: "B3-3.1-04 verbal VOE within 10 business days prior to the note date" };
}
/** Paystub / bank-statement alternative: dated ≥ note_date − 15 creditor business days (fixture Fri Oct 16, 2026; purchase Tue Oct 27, 2026). */
export function vvoeAlternativeWindow(noteDate: PlainDate, cal: Calendar = creditor): VerificationWindow {
  return { note_date: noteDate, window_start: addBusinessDays(noteDate, -VVOE_ALT_BUSINESS_DAYS, cal), rule: "B3-3.1-04 paystub/bank statement dated no earlier than 15 business days prior to the note date" };
}
/** Self-employment business existence: within 120 calendar days prior to the note date (fixture Thu Jul 9, 2026; purchase Tue Jul 21, 2026). */
export function businessVerificationWindow(noteDate: PlainDate): VerificationWindow {
  return { note_date: noteDate, window_start: addDays(noteDate, -SE_VERIFY_CALENDAR_DAYS), rule: "B3-3.1-04 business existence verified within 120 calendar days prior to the note date" };
}
/** A verification is timely iff `window_start ≤ date ≤ note_date`. */
export const withinWindow = (w: VerificationWindow, date: PlainDate): boolean => w.window_start <= date && date <= w.note_date;

export type VvoeMethod = "verbal_ai_voice" | "verbal_human" | "written_form_1005" | "employer_email" | "vendor_written" | "paystub_15bd" | "bank_statement_15bd" | "military_les_120" | "dmdc" | "du_validation";
export type PhoneSource = "directory_assistance" | "internet_listing" | "licensing_bureau" | "telephone_book" | "vendor_database";
export const PHONE_SOURCES: readonly PhoneSource[] = ["directory_assistance", "internet_listing", "licensing_bureau", "telephone_book", "vendor_database"];
const VERBAL_METHODS: ReadonlySet<VvoeMethod> = new Set(["verbal_ai_voice", "verbal_human"]);
/** The window a method is measured against: 15 BD for the document alternatives, 120 days for LES/DMDC, 10 BD otherwise. */
export function windowForMethod(method: VvoeMethod, noteDate: PlainDate, cal: Calendar = creditor): VerificationWindow {
  if (method === "paystub_15bd" || method === "bank_statement_15bd") return vvoeAlternativeWindow(noteDate, cal);
  if (method === "military_les_120" || method === "dmdc") return { note_date: noteDate, window_start: addDays(noteDate, -LES_DMDC_CALENDAR_DAYS), rule: "B3-3.1-04 military LES / DMDC within 120 calendar days" };
  return vvoeWindow(noteDate, cal);
}

export interface EmploymentVerification {
  readonly vvoe_id: string; readonly application_id: string; readonly borrower_id: string; readonly income_ids: readonly string[]; readonly method: VvoeMethod;
  readonly employer_name: string; readonly employer_phone: string | null; readonly phone_source: PhoneSource | null; readonly phone_source_evidence_document_id: string | null;
  readonly contact_name: string | null; readonly contact_title: string | null; readonly verifier_identity: string; readonly contacted_at: string; readonly contacted_on: PlainDate;
  readonly employment_status: "active" | "on_leave" | "terminated" | "unknown"; readonly start_date_confirmed: PlainDate | null;
  readonly note_date_used: PlainDate; readonly window_start: PlainDate; readonly within_window: boolean; readonly recording_document_id: string | null; readonly transcript_document_id: string | null;
}
export interface VvoeInput {
  readonly application_id: string; readonly borrower_id: string; readonly income_ids?: readonly string[]; readonly method: VvoeMethod; readonly employer_name: string;
  readonly employer_phone?: string | null; readonly phone_source?: PhoneSource | string | null; readonly phone_source_evidence_document_id?: string | null;
  readonly contact_name?: string | null; readonly contact_title?: string | null; readonly verifier_identity: string; readonly contacted_at: string;
  readonly employment_status?: EmploymentVerification["employment_status"]; readonly start_date_confirmed?: PlainDate | null; readonly note_date: PlainDate; readonly calendar?: Calendar;
  readonly recording_document_id?: string | null; readonly transcript_document_id?: string | null; readonly vvoe_id?: string;
}
/** The window opens (R1): the agent schedules the VVOE two creditor business days before the note date by default (edge case: survive small slips); arms SM_VVOE_SCHEDULE_2BD. */
export function scheduleVvoe(events: EventStore, r: { application_id: string; borrower_id: string; method?: VvoeMethod; note_date: PlainDate; calendar?: Calendar; vvoe_id?: string }, actor: Actor = AGENT): { vvoe_id: string; window: VerificationWindow; scheduled_for: PlainDate; event: DomainEvent } {
  nonEmpty(r.application_id, "application_id"); nonEmpty(r.borrower_id, "borrower_id");
  const method = r.method ?? "verbal_ai_voice"; const cal = r.calendar ?? creditor;
  const window = windowForMethod(method, r.note_date, cal); const vvoe_id = r.vvoe_id ?? ids("vvoe");
  const scheduled_for = addBusinessDays(r.note_date, -2, cal);
  const event = events.append({ type: "vvoe.window.opened", applicationId: r.application_id, actor, payload: { vvoe_id, borrower_id: r.borrower_id, method, window_start: window.window_start, note_date_used: r.note_date, scheduled_for, application_id: r.application_id } });
  return { vvoe_id, window, scheduled_for, event };
}
/**
 * A completed verification of employment (verbal by AI voice or human, written, vendor, document alternative, LES/DMDC or DU validation):
 * validates the independent phone source (never a borrower-supplied number — AI-design guardrail) and the B3-3.1-04 record fields, computes the
 * window for the method against the note date used, and appends `vvoe.completed{within_window}` (plus `vvoe.window.missed` when outside).
 */
export function recordVvoe(events: EventStore, r: VvoeInput, actor: Actor = AGENT): { record: EmploymentVerification; event: DomainEvent; missed: DomainEvent | null } {
  nonEmpty(r.application_id, "application_id"); nonEmpty(r.borrower_id, "borrower_id"); nonEmpty(r.employer_name, "employer_name"); nonEmpty(r.verifier_identity, "verifier_identity"); nonEmpty(r.contacted_at, "contacted_at");
  const verbal = VERBAL_METHODS.has(r.method);
  if (verbal) {
    nonEmpty(r.contact_name, "contact_name (B3-3.1-04: name and title of the person who confirmed the employment)"); nonEmpty(r.contact_title, "contact_title");
    if (!r.phone_source || !PHONE_SOURCES.includes(r.phone_source as PhoneSource)) throw new IncomeRuleRefused("VVOE_PHONE_SOURCE", "B3-3.1-04: the lender must independently obtain a phone number for the borrower's employer", `phone_source ${JSON.stringify(r.phone_source ?? null)} is not one of ${PHONE_SOURCES.join("/")} (borrower-supplied numbers are never used)`);
    nonEmpty(r.phone_source_evidence_document_id, "phone_source_evidence_document_id (the listing/screenshot evidence is stored)");
  }
  const window = windowForMethod(r.method, r.note_date, r.calendar ?? creditor);
  const contacted_on = civilDate(r.contacted_at);
  const within_window = withinWindow(window, contacted_on);
  const record: EmploymentVerification = { vvoe_id: r.vvoe_id ?? ids("vvoe"), application_id: r.application_id, borrower_id: r.borrower_id, income_ids: r.income_ids ?? [], method: r.method, employer_name: r.employer_name,
    employer_phone: r.employer_phone ?? null, phone_source: (r.phone_source as PhoneSource | undefined) ?? null, phone_source_evidence_document_id: r.phone_source_evidence_document_id ?? null, contact_name: r.contact_name ?? null, contact_title: r.contact_title ?? null,
    verifier_identity: r.verifier_identity, contacted_at: r.contacted_at, contacted_on, employment_status: r.employment_status ?? "active", start_date_confirmed: r.start_date_confirmed ?? null, note_date_used: r.note_date, window_start: window.window_start, within_window,
    recording_document_id: r.recording_document_id ?? null, transcript_document_id: r.transcript_document_id ?? null };
  const event = events.append({ type: "vvoe.completed", applicationId: r.application_id, actor, payload: { vvoe_id: record.vvoe_id, borrower_id: record.borrower_id, method: record.method, contacted_on, window_start: window.window_start, note_date_used: r.note_date, within_window, employment_status: record.employment_status, application_id: r.application_id } });
  const missed = within_window ? null : events.append({ type: "vvoe.window.missed", applicationId: r.application_id, actor, payload: { vvoe_id: record.vvoe_id, borrower_id: record.borrower_id, contacted_on, window_start: window.window_start, note_date_used: r.note_date, application_id: r.application_id } });
  return { record, event, missed };
}
/** DU employment validation with a Close by Date on/after the note date satisfies the VVOE gate (timer row: "or `du_validation` employment with Close by Date ≥ note date"). */
export function vvoeFromDuValidation(events: EventStore, r: { application_id: string; borrower_id: string; employer_name: string; close_by_date: PlainDate; note_date: PlainDate; report_reference_id: string }, actor: Actor = AGENT): ReturnType<typeof recordVvoe> | null {
  if (r.close_by_date < r.note_date) return null;
  return recordVvoe(events, { application_id: r.application_id, borrower_id: r.borrower_id, method: "du_validation", employer_name: r.employer_name, verifier_identity: `du_validation:${r.report_reference_id}`, contacted_at: r.note_date, note_date: r.note_date }, actor);
}

export type BusinessSource = "cpa_letter" | "regulatory_agency" | "licensing_bureau" | "phone_listing_and_address" | "secretary_of_state";
export interface BusinessVerification { readonly verification_id: string; readonly application_id: string; readonly borrower_id: string; readonly business_name: string; readonly source: BusinessSource; readonly source_reference: string; readonly verified_at: PlainDate; readonly note_date_used: PlainDate; readonly window_start: PlainDate; readonly within_window: boolean; readonly evidence_document_id: string; }
/** Self-employment business existence (B3-3.1-04, 120 calendar days): appends `business.existence.verified{within_window}` (satisfies FNMA_B3_3_1_04_SE_VERIFY_120 when true). */
export function verifyBusinessExistence(events: EventStore, r: Omit<BusinessVerification, "verification_id" | "window_start" | "within_window"> & { verification_id?: string }, actor: Actor = AGENT): { record: BusinessVerification; event: DomainEvent } {
  nonEmpty(r.application_id, "application_id"); nonEmpty(r.borrower_id, "borrower_id"); nonEmpty(r.business_name, "business_name"); nonEmpty(r.source_reference, "source_reference"); nonEmpty(r.evidence_document_id, "evidence_document_id");
  const window = businessVerificationWindow(r.note_date_used);
  const record: BusinessVerification = { ...r, verification_id: r.verification_id ?? ids("bv"), window_start: window.window_start, within_window: withinWindow(window, r.verified_at) };
  const event = events.append({ type: "business.existence.verified", applicationId: r.application_id, actor, payload: { verification_id: record.verification_id, borrower_id: r.borrower_id, business_name: r.business_name, source: r.source, verified_at: r.verified_at, note_date_used: r.note_date_used, window_start: record.window_start, within_window: record.within_window, application_id: r.application_id } });
  return { record, event };
}

// ============================================================ R2 — base income (B3-3.3-01)
/** Salary: `monthly = round(annual / 12)` — $75,000.00 → 625,000 cents. */
export function baseSalary(annual_salary_cents: bigint, regb_flags: readonly RegBFlag[] = []): IncomeCalculation {
  nonNeg(annual_salary_cents, "annual_salary_cents");
  const monthly = divRound(annual_salary_cents, 12n);
  return calc({ income_type: "base_salary", formula_version: FORMULAS.base_salary, inputs: { annual_salary_cents: String(annual_salary_cents), regb_flags: regb_flags.join(",") }, steps: [{ label: "annual_salary_cents", cents: String(annual_salary_cents) }, { label: "round(annual / 12)", cents: String(monthly) }], monthly_qualifying_cents: monthly });
}
/** A base salary already stated monthly (paystub/Form 1005 monthly rate): the same B3-3.3-01 formula id, factor 1 — part-time or not (Reg B §1002.6(b)(5)). */
export function baseMonthly(monthly_cents: bigint, regb_flags: readonly RegBFlag[] = []): IncomeCalculation {
  nonNeg(monthly_cents, "monthly_cents");
  return calc({ income_type: "base_salary", formula_version: FORMULAS.base_salary, inputs: { monthly_cents: String(monthly_cents), annual_salary_cents: String(monthly_cents * 12n), regb_flags: regb_flags.join(",") }, steps: [{ label: "annual = monthly × 12", cents: String(monthly_cents * 12n) }, { label: "round(annual / 12)", cents: String(monthly_cents) }], monthly_qualifying_cents: monthly_cents });
}
export interface HourlyInput { readonly rate_cents: bigint; readonly guaranteed_hours_per_week?: number | null; readonly hours_min?: number | null; readonly hours_max?: number | null; readonly avg_hours_per_week?: number | null; }
/** B3-3.3-01: "minor variances from pay period to pay period" keep hourly income fixed; beyond this band (of the high week) the hours fluctuate and R3 applies. */
export const HOURLY_MINOR_VARIANCE_PCT = 10;
export function hourlyClassification(h: HourlyInput): "base_hourly_fixed" | "base_hourly_variable" {
  if (h.guaranteed_hours_per_week !== null && h.guaranteed_hours_per_week !== undefined && h.guaranteed_hours_per_week > 0) return "base_hourly_fixed";
  const lo = h.hours_min ?? h.avg_hours_per_week ?? 0, hi = h.hours_max ?? h.avg_hours_per_week ?? 0;
  if (hi <= 0) throw new RangeError("hours (guaranteed, or a min–max range) are required");
  return (hi - lo) * 100 <= HOURLY_MINOR_VARIANCE_PCT * hi ? "base_hourly_fixed" : "base_hourly_variable";
}
/** Fixed hourly: `monthly = round(rate × hours × 52 / 12)` — $32.50 × 40 → 563,333 cents; fluctuating hours reclassify to `base_hourly_variable` (R3). */
export function hourlyBase(h: HourlyInput): IncomeCalculation {
  nonNeg(h.rate_cents, "rate_cents");
  const cls = hourlyClassification(h);
  const inputs = { rate_cents: String(h.rate_cents), guaranteed_hours_per_week: h.guaranteed_hours_per_week ?? null, hours_min: h.hours_min ?? null, hours_max: h.hours_max ?? null };
  if (cls === "base_hourly_variable") return calc({ income_type: "base_hourly_variable", formula_version: FORMULAS.variable_trending, inputs, steps: [{ label: "hours fluctuate beyond minor variances → variable base income (R3 trending applies)", cents: "0" }], monthly_qualifying_cents: 0n, reason: "reclassified_variable_hours", reclassified_to: "base_hourly_variable" });
  const hours = h.guaranteed_hours_per_week ?? h.avg_hours_per_week ?? h.hours_max!;
  const hoursTenths = BigInt(Math.round(hours * 10));                     // hours at 0.1 precision keep the arithmetic in integers
  const annual = h.rate_cents * hoursTenths * 52n;                          // ×10 scale
  const monthly = divRound(annual, 120n);                                    // ÷12 and ÷10, one half-up rounding
  return calc({ income_type: "base_hourly_fixed", formula_version: FORMULAS.base_hourly_fixed, inputs, steps: [{ label: `rate × ${hours} h × 52 (annual)`, cents: String(divRound(annual, 10n)) }, { label: "round(annual / 12)", cents: String(monthly) }], monthly_qualifying_cents: monthly });
}

// ============================================================ R3 — variable income trending (B3-3.3-02, 2026 rewrite)
export const STABLE_BAND_PCT_DEFAULT = 5;
export interface TrendInput { readonly ytd_cents: bigint; readonly ytd_months: number; readonly prior_year_cents: bigint; readonly stable_band_pct?: number; }
export interface TrendResult { readonly trend: Trend; readonly ytd_monthly_cents: bigint; readonly prior_monthly_cents: bigint; readonly change_pct: string; readonly band_pct: number; }
const monthsDec = (m: number): Decimal => { if (!Number.isFinite(m) || m <= 0) throw new RangeError("months must be > 0"); return Decimal.parse(m.toFixed(4)); };
/** Step 1–2: `ytd_monthly` vs `prior_monthly`; increasing if above, stable within ±band (Q4 default 5%), otherwise decreasing. Compared on the exact ratios (cross-multiplied), displayed rounded. */
export function assessTrend(t: TrendInput): TrendResult {
  nonNeg(t.ytd_cents, "ytd_cents"); nonNeg(t.prior_year_cents, "prior_year_cents");
  const band = t.stable_band_pct ?? STABLE_BAND_PCT_DEFAULT; pct(band, "stable_band_pct");
  const months = monthsDec(t.ytd_months);
  const ytdMonthly = Decimal.fromBigInt(t.ytd_cents).div(months), priorMonthly = Decimal.fromBigInt(t.prior_year_cents).div(Decimal.fromInt(12));
  const diff = ytdMonthly.sub(priorMonthly);
  const changePct = priorMonthly.isZero() ? (ytdMonthly.isZero() ? Decimal.fromInt(0) : Decimal.fromInt(100)) : diff.div(priorMonthly).mul(Decimal.fromInt(100));
  const bandDec = Decimal.parse(band.toFixed(4));
  const trend: Trend = diff.cmp(Decimal.fromInt(0)) > 0 ? "increasing" : changePct.abs().cmp(bandDec) <= 0 ? "stable" : "decreasing";
  return { trend, ytd_monthly_cents: ytdMonthly.toScaledInt(0, "HALF_UP"), prior_monthly_cents: priorMonthly.toScaledInt(0, "HALF_UP"), change_pct: changePct.toScaledInt(2, "HALF_UP").toString(), band_pct: band };
}
export interface VariableIncomeInput extends TrendInput {
  readonly income_type?: IncomeType;
  /** Paystub-level evidence of a flat run after a decline: the date it stabilised and the income received since. */
  readonly stabilization?: { readonly since: PlainDate; readonly cents_since: bigint; readonly months_since: number; readonly evidence_document_ids?: readonly string[] } | null;
  readonly history_months?: number | null; readonly offsetting_factors?: readonly string[] | null;
}
/**
 * Step 3: stable/increasing → `round((ytd + prior_year) / (ytd_months + 12))` (example A: 1,935,000 / 21 → 92,143); decreasing → the documented
 * stabilised run `round(ytd_since_stabilized / months_since_stabilized)` (example B: 570,000 / 6 → 95,000), else 0 with reason `not_stabilized`.
 */
export function variableIncome(v: VariableIncomeInput): IncomeCalculation & { trend_detail: TrendResult } {
  const trend_detail = assessTrend(v);
  const income_type = v.income_type ?? "overtime";
  const history = v.history_months ?? null;
  if (history !== null && history < 12) return { ...calc({ income_type, formula_version: FORMULAS.variable_trending, inputs: { ytd_cents: String(v.ytd_cents), ytd_months: v.ytd_months, prior_year_cents: String(v.prior_year_cents), history_months: history }, steps: [{ label: "history < 12 months → not eligible (B3-3.3-02)", cents: "0" }], monthly_qualifying_cents: 0n, trend: trend_detail.trend, reason: "history_under_12_months" }), trend_detail };
  const inputs = { ytd_cents: String(v.ytd_cents), ytd_months: v.ytd_months, prior_year_cents: String(v.prior_year_cents), stable_band_pct: trend_detail.band_pct, history_months: history, offsetting_factors: (v.offsetting_factors ?? []).join(";") || null };
  const steps: CalcStep[] = [{ label: `ytd_monthly = ytd / ${v.ytd_months}`, cents: String(trend_detail.ytd_monthly_cents) }, { label: "prior_monthly = prior_year / 12", cents: String(trend_detail.prior_monthly_cents) }];
  if (trend_detail.trend !== "decreasing") {
    const total = v.ytd_cents + v.prior_year_cents;
    const monthly = Decimal.fromBigInt(total).div(monthsDec(v.ytd_months + 12)).toScaledInt(0, "HALF_UP");
    steps.push({ label: "ytd + prior_year", cents: String(total) }, { label: `round(total / ${v.ytd_months + 12})`, cents: String(monthly) });
    return { ...calc({ income_type, formula_version: FORMULAS.variable_trending, inputs, steps, monthly_qualifying_cents: monthly, trend: trend_detail.trend }), trend_detail };
  }
  const s = v.stabilization ?? null;
  if (!s) {
    steps.push({ label: "decreasing with no stabilization evidence → not eligible", cents: "0" });
    return { ...calc({ income_type, formula_version: FORMULAS.variable_trending, inputs, steps, monthly_qualifying_cents: 0n, trend: "decreasing", reason: "not_stabilized" }), trend_detail };
  }
  nonNeg(s.cents_since, "stabilization.cents_since");
  const monthly = Decimal.fromBigInt(s.cents_since).div(monthsDec(s.months_since)).toScaledInt(0, "HALF_UP");
  steps.push({ label: `income since ${s.since}`, cents: String(s.cents_since) }, { label: `round(since_stabilized / ${s.months_since})`, cents: String(monthly) });
  return { ...calc({ income_type, formula_version: FORMULAS.variable_trending, inputs: { ...inputs, stabilized_since: s.since, cents_since_stabilized: String(s.cents_since), months_since_stabilized: s.months_since }, steps, monthly_qualifying_cents: monthly, trend: "decreasing", stabilized_since: s.since }), trend_detail };
}
/** Bonus paid annually is annualised (÷ 12) for the trend comparison: $12,000.00 on Mar 31 → 100,000 cents per month. */
export function bonusMonthly(annual_bonus_cents: bigint): { monthly_cents: bigint; formula_version: FormulaId } {
  nonNeg(annual_bonus_cents, "annual_bonus_cents");
  return { monthly_cents: divRound(annual_bonus_cents, 12n), formula_version: FORMULAS.bonus_annualized };
}

// ============================================================ R6 — other income and gross-up (B3-3.1-01, B3-3.4-x)
export const GROSS_UP_PCT = 25;
export const SS_NONTAXABLE_PCT_DEFAULT = 15;
/** `gross_up = round(nontaxable × 25%)`. */
export const grossUp = (nontaxable_cents: bigint): bigint => divRound(nonNeg(nontaxable_cents, "nontaxable_cents") * BigInt(GROSS_UP_PCT), 100n);
export interface SocialSecurityInput { readonly amount_cents: bigint; readonly record: "own" | "another_person" | "dependent"; readonly benefit: "retirement" | "disability" | "survivor"; readonly documented_nontaxable_pct?: number | null; readonly continuance_end_date?: PlainDate | null; }
/** Social Security: 15% treated as nontaxable without documentation (or the documented share if larger), grossed up 25% — $2,000.00 → 30,000 / 7,500 / 207,500. Own-record benefits need no continuance proof. */
export function socialSecurity(s: SocialSecurityInput): IncomeCalculation {
  nonNeg(s.amount_cents, "amount_cents");
  const documented = s.documented_nontaxable_pct ?? null; if (documented !== null) pct(documented, "documented_nontaxable_pct");
  const share = documented !== null && documented > SS_NONTAXABLE_PCT_DEFAULT ? documented : SS_NONTAXABLE_PCT_DEFAULT;
  const nontaxable = divRound(s.amount_cents * BigInt(Math.round(share * 100)), 10_000n);
  const gross = grossUp(nontaxable);
  const income_type: IncomeType = s.record === "own" ? (s.benefit === "disability" ? "social_security_disability" : "social_security_retirement") : "social_security_survivor_dependent";
  const own = s.record === "own";
  return calc({ income_type, formula_version: FORMULAS.social_security, inputs: { amount_cents: String(s.amount_cents), record: s.record, benefit: s.benefit, nontaxable_pct: share, documented_nontaxable_pct: documented },
    steps: [{ label: `nontaxable = round(amount × ${share}%)`, cents: String(nontaxable) }, { label: `gross_up = round(nontaxable × ${GROSS_UP_PCT}%)`, cents: String(gross) }, { label: "qualifying = amount + gross_up", cents: String(s.amount_cents + gross) }],
    monthly_qualifying_cents: s.amount_cents, nontaxable_cents: nontaxable, gross_up_cents: gross, continuance_basis: own ? "retirement_own_record" : "documented_3y", continuance_end_date: own ? null : (s.continuance_end_date ?? null) });
}
export interface SupportInput { readonly amount_cents: bigint; readonly kind: "child_support" | "alimony" | "separate_maintenance"; readonly receipts_months: number; readonly receipts_full_regular_timely: boolean; readonly agreement_document_id: string | null; readonly child_date_of_birth?: PlainDate | null; readonly term_end_date?: PlainDate | null; readonly state_extends_support_to?: PlainDate | null; }
export const CHILD_SUPPORT_AGE_END = 18;
/** Child support ends at the child's 18th birthday unless state law extends it (R6). */
export const continuanceEndFromChildAge = (dob: PlainDate, extendedTo: PlainDate | null = null): PlainDate => { const end = addYears(dob, CHILD_SUPPORT_AGE_END); return extendedTo && extendedTo > end ? extendedTo : end; };
/** Alimony / child support / separate maintenance (B3-3.4-02): the six-month full/regular/timely receipt history is the consistency test (never a haircut); child support is fully nontaxable and grossed up — $800.00 → 100,000 cents. */
export function supportIncome(s: SupportInput): IncomeCalculation {
  nonNeg(s.amount_cents, "amount_cents");
  if (!s.agreement_document_id) return calc({ income_type: s.kind, formula_version: FORMULAS.child_support, inputs: { amount_cents: String(s.amount_cents), agreement: null }, steps: [{ label: "no decree/agreement → proposed or voluntary payments are not income (B3-3.4-02)", cents: "0" }], monthly_qualifying_cents: 0n, reason: "no_agreement", continuance_basis: "n_a" });
  if (s.receipts_months < 6 || !s.receipts_full_regular_timely) return calc({ income_type: s.kind, formula_version: FORMULAS.child_support, inputs: { amount_cents: String(s.amount_cents), receipts_months: s.receipts_months, full_regular_timely: s.receipts_full_regular_timely }, steps: [{ label: "receipt history under six months or not full/regular/timely → not consistently made", cents: "0" }], monthly_qualifying_cents: 0n, reason: "receipt_history_insufficient", continuance_basis: "n_a" });
  const nontaxable = s.kind === "child_support" ? s.amount_cents : 0n;
  const gross = grossUp(nontaxable);
  const end = s.kind === "child_support" ? (s.child_date_of_birth ? continuanceEndFromChildAge(s.child_date_of_birth, s.state_extends_support_to ?? null) : (s.term_end_date ?? null)) : (s.term_end_date ?? null);
  return calc({ income_type: s.kind, formula_version: FORMULAS.child_support, inputs: { amount_cents: String(s.amount_cents), receipts_months: s.receipts_months, agreement_document_id: s.agreement_document_id, child_date_of_birth: s.child_date_of_birth ?? null, term_end_date: s.term_end_date ?? null },
    steps: [{ label: "documented monthly amount", cents: String(s.amount_cents) }, { label: "nontaxable share (child support: 100%)", cents: String(nontaxable) }, { label: `gross_up = round(nontaxable × ${GROSS_UP_PCT}%)`, cents: String(gross) }, { label: "qualifying = amount + gross_up", cents: String(s.amount_cents + gross) }],
    monthly_qualifying_cents: s.amount_cents, nontaxable_cents: nontaxable, gross_up_cents: gross, continuance_basis: "documented_3y", continuance_end_date: end });
}
/** Retirement-account distributions: continuance proved by combined eligible balances ≥ 36 × the monthly distribution with unrestricted, penalty-free access. */
export function retirementDistribution(r: { monthly_cents: bigint; eligible_balances_cents: readonly bigint[]; unrestricted_penalty_free: boolean }): IncomeCalculation {
  nonNeg(r.monthly_cents, "monthly_cents");
  const combined = r.eligible_balances_cents.reduce((a, b) => a + nonNeg(b, "balance"), 0n);
  const needed = r.monthly_cents * 36n;
  const ok = r.unrestricted_penalty_free && combined >= needed;
  return calc({ income_type: "retirement_distribution", formula_version: FORMULAS.retirement, inputs: { monthly_cents: String(r.monthly_cents), combined_balances_cents: String(combined), unrestricted_penalty_free: r.unrestricted_penalty_free },
    steps: [{ label: "36 × monthly distribution", cents: String(needed) }, { label: "combined eligible balances", cents: String(combined) }], monthly_qualifying_cents: ok ? r.monthly_cents : 0n, continuance_basis: ok ? "documented_3y" : "n_a", reason: ok ? null : "continuance_assets_insufficient" });
}
/** Public assistance (B3-3.4-12): the agency letter with amount/frequency/duration; never a reason to discount (Reg B §1002.6(b)(2)). */
export function publicAssistance(p: { monthly_cents: bigint; agency_letter_document_id: string | null; duration_end_date: PlainDate | null }): IncomeCalculation {
  nonNeg(p.monthly_cents, "monthly_cents");
  if (!p.agency_letter_document_id) return calc({ income_type: "public_assistance", formula_version: FORMULAS.public_assistance, inputs: { monthly_cents: String(p.monthly_cents) }, steps: [{ label: "agency letter missing → documentation requested", cents: "0" }], monthly_qualifying_cents: 0n, reason: "agency_letter_missing", continuance_basis: "n_a" });
  return calc({ income_type: "public_assistance", formula_version: FORMULAS.public_assistance, inputs: { monthly_cents: String(p.monthly_cents), agency_letter_document_id: p.agency_letter_document_id, duration_end_date: p.duration_end_date }, steps: [{ label: "agency-stated monthly benefit", cents: String(p.monthly_cents) }], monthly_qualifying_cents: p.monthly_cents, continuance_basis: p.duration_end_date ? "documented_3y" : "no_expiration", continuance_end_date: p.duration_end_date });
}

// ============================================================ continuance (B3-3.1-01; FNMA_B3_3_1_01_CONTINUANCE_3Y)
export const CONTINUANCE_YEARS = 3;
export interface ContinuanceResult { readonly pass: boolean; readonly required_through: PlainDate; readonly continuance_end_date: PlainDate | null; readonly reason: string | null; }
/** `continuance_end_date ≥ note_date + 3 years` where a defined end exists; no defined end with a documented history → likely to continue. */
export function continuance3y(end: PlainDate | null, noteDate: PlainDate, basis: ContinuanceBasis = end ? "documented_3y" : "no_expiration"): ContinuanceResult {
  const required_through = addYears(noteDate, CONTINUANCE_YEARS);
  if (basis === "retirement_own_record" || basis === "no_expiration" || !end) return { pass: true, required_through, continuance_end_date: end, reason: null };
  return end >= required_through ? { pass: true, required_through, continuance_end_date: end, reason: null }
    : { pass: false, required_through, continuance_end_date: end, reason: `FNMA_B3_3_1_01_CONTINUANCE_3Y: income ends ${end}, before ${required_through} (note date ${noteDate} + 3 years; B3-3.1-01 "expected to continue for at least three years from the note date")` };
}
/** The gate evaluation with its record: `income.continuance.evaluated{result}` and, on failure, `income.excluded{written_reason}` (22.5 recalculates the DTI). */
export function evaluateContinuance(events: EventStore, r: { application_id: string; income_id: string; income_type: IncomeType; note_date: PlainDate; continuance_end_date: PlainDate | null; continuance_basis?: ContinuanceBasis; qualifying_cents: bigint }, actor: Actor = AGENT): ContinuanceResult & { qualifying_cents: bigint; written_reason: string | null; event: DomainEvent; excluded: DomainEvent | null } {
  nonEmpty(r.application_id, "application_id"); nonEmpty(r.income_id, "income_id");
  const res = continuance3y(r.continuance_end_date, r.note_date, r.continuance_basis ?? (r.continuance_end_date ? "documented_3y" : "no_expiration"));
  const event = events.append({ type: "income.continuance.evaluated", applicationId: r.application_id, actor, payload: { income_id: r.income_id, income_type: r.income_type, result: res.pass ? "pass" : "fail", continuance_end_date: res.continuance_end_date, required_through: res.required_through, note_date: r.note_date, application_id: r.application_id } });
  const written_reason = res.pass ? null : `${r.income_type} income of ${r.qualifying_cents} cents/month is excluded from qualifying: ${res.reason}. The exclusion rests on the documented end date, not on the nature of the income (Reg B §1002.6(b)).`;
  const excluded = res.pass ? null : events.append({ type: "income.excluded", applicationId: r.application_id, actor, payload: { income_id: r.income_id, income_type: r.income_type, reason_code: "FNMA_B3_3_1_01_CONTINUANCE_3Y", written_reason, application_id: r.application_id } });
  return { ...res, qualifying_cents: res.pass ? r.qualifying_cents : 0n, written_reason, event, excluded };
}

// ============================================================ R5 — rental income (B3-3.8; SEL-2026-08)
export const RENTAL_RULE_SET_MANDATORY_FROM: PlainDate = D("2026-11-01");
export const RENTAL_NET_PCT = 75;
export const ADU_CAP_PCT = 30;
export const MANAGEMENT_EXPERIENCE_MONTHS = 12;
export const FAIR_RENTAL_DAYS_FULL_YEAR = 365;
export const MIN_LEASE_TERM_MONTHS = 6;
/** B3-3.8 is mandatory for applications on/after Nov 1, 2026; earlier applications use it by platform default unless it removes income the prior rule allowed (Q5). */
export function rentalRuleSet(applicationDate: PlainDate): { rule_set: "B3-3.8.2026-09-02" | "B3-3.4.prior"; mandatory: boolean } {
  return { rule_set: "B3-3.8.2026-09-02", mandatory: applicationDate >= RENTAL_RULE_SET_MANDATORY_FROM };
}
export interface SubjectRentalInput { readonly gross_rent_cents: bigint; readonly pitia_cents: bigint; readonly transaction: "purchase" | "refinance"; readonly management_experience_months?: number | null; readonly fair_rental_days?: number | null; readonly lease_term_months?: number | null; readonly on_1040?: boolean; }
export interface RentalResult { readonly net_cents: bigint; readonly anri_cents: bigint; readonly income_added_cents: bigint; readonly liability_added_cents: bigint; readonly offset_only: boolean; readonly experienced: boolean; readonly formula_version: FormulaId; readonly reason: string | null; }
/** 12 months of property-management experience: Schedule E with 365 Fair Rental Days (B3-3.8-01) or a documented ≥ 12-month history. */
export const managementExperienced = (r: { management_experience_months?: number | null; fair_rental_days?: number | null }): boolean => (r.fair_rental_days ?? 0) >= FAIR_RENTAL_DAYS_FULL_YEAR || (r.management_experience_months ?? 0) >= MANAGEMENT_EXPERIENCE_MONTHS;
/**
 * Subject property purchase (B3-3.8-02): `net = round(gross × 75%)`, `anri = net − PITIA`; positive ANRI adds to income only with the experience test, otherwise
 * it offsets PITIA only (`offset_only`); negative ANRI adds to obligations regardless — $2,400.00 / $2,150.00 → 350.00 to liabilities; $1,650.00 → +150.00 (experienced).
 */
export function subjectRental(r: SubjectRentalInput): RentalResult {
  nonNeg(r.gross_rent_cents, "gross_rent_cents"); nonNeg(r.pitia_cents, "pitia_cents");
  if (r.on_1040 === false && (r.lease_term_months ?? 0) < MIN_LEASE_TERM_MONTHS) return { net_cents: 0n, anri_cents: 0n, income_added_cents: 0n, liability_added_cents: r.pitia_cents, offset_only: false, experienced: managementExperienced(r), formula_version: FORMULAS.rental_subject, reason: "lease_term_under_6_months" };
  const net = divRound(r.gross_rent_cents * BigInt(RENTAL_NET_PCT), 100n);
  const anri = net - r.pitia_cents;
  const experienced = managementExperienced(r);
  if (anri < 0n) return { net_cents: net, anri_cents: anri, income_added_cents: 0n, liability_added_cents: -anri, offset_only: false, experienced, formula_version: FORMULAS.rental_subject, reason: null };
  if (experienced) return { net_cents: net, anri_cents: anri, income_added_cents: anri, liability_added_cents: 0n, offset_only: false, experienced, formula_version: FORMULAS.rental_subject, reason: null };
  return { net_cents: net, anri_cents: anri, income_added_cents: 0n, liability_added_cents: 0n, offset_only: true, experienced, formula_version: FORMULAS.rental_subject, reason: "management_experience_under_12_months: positive rental income offsets PITIA only (B3-3.8-01)" };
}
/** ADU rental income ≤ 30% of total qualifying income, purchase / limited cash-out only — $9,000.00 total caps the ADU at 270,000 cents; excluded on a cash-out refinance. */
export function aduCap(a: { total_qualifying_cents: bigint; adu_net_cents: bigint; transaction: "purchase" | "lcor" | "cash_out_refinance" }): { allowed_cents: bigint; cap_cents: bigint; capped: boolean; excluded: boolean; formula_version: FormulaId; reason: string | null } {
  nonNeg(a.total_qualifying_cents, "total_qualifying_cents"); nonNeg(a.adu_net_cents, "adu_net_cents");
  const cap = divRound(a.total_qualifying_cents * BigInt(ADU_CAP_PCT), 100n);
  if (a.transaction === "cash_out_refinance") return { allowed_cents: 0n, cap_cents: cap, capped: false, excluded: true, formula_version: FORMULAS.adu_cap, reason: "ADU rental income: purchase or limited cash-out refinance transactions only (B3-3.8-02)" };
  const capped = a.adu_net_cents > cap;
  return { allowed_cents: capped ? cap : a.adu_net_cents, cap_cents: cap, capped, excluded: false, formula_version: FORMULAS.adu_cap, reason: capped ? `ADU income limited to ${ADU_CAP_PCT}% of total qualifying income (DU 12.1 message)` : null };
}

// ============================================================ R7 — employment offers (B3-3.3-03)
export const OFFER_START_BEFORE_DAYS = 30;
export const OFFER_START_AFTER_DAYS = 90;
export const OFFER_RESERVE_MONTHS = 6;
export const SFC_EMPLOYMENT_OFFER_OPTION_2 = "707";
export interface OfferWindow { readonly start: PlainDate; readonly end: PlainDate; }
/** Option 2 start-date window `[note_date − 30, note_date + 90]` calendar days — purchase fixture Mon Oct 19, 2026 – Tue Feb 16, 2027. */
export const offerStartWindow = (noteDate: PlainDate): OfferWindow => ({ start: addDays(noteDate, -OFFER_START_BEFORE_DAYS), end: addDays(noteDate, OFFER_START_AFTER_DAYS) });
export interface OfferInput {
  readonly note_date: PlainDate; readonly start_date: PlainDate; readonly monthly_income_cents: bigint; readonly non_contingent: boolean; readonly fully_executed: boolean;
  readonly transaction: "purchase" | "refinance"; readonly occupancy: "principal_residence" | "second_home" | "investment"; readonly units: number; readonly fixed_base_income: boolean; readonly family_or_interested_party: boolean;
  readonly reserves_months_pitia?: number | null; readonly bridge_reserves_documented?: boolean; readonly paystub_saved_before_delivery?: boolean;
}
export interface OfferOption2Result { readonly available: boolean; readonly window: OfferWindow; readonly reserves_documented: boolean; readonly within_window: boolean; readonly refusal_reasons: readonly string[]; readonly sfc_codes: readonly string[]; readonly monthly_income_cents: bigint; readonly formula_version: FormulaId; }
/** Option 2 (no paystub before delivery): purchase, principal residence, one unit, fixed base income, non-contingent executed offer, start inside the window, six months' PITIA (or the bridge) — SFC 707 at delivery. */
export function offerOption2(o: OfferInput): OfferOption2Result {
  nonNeg(o.monthly_income_cents, "monthly_income_cents");
  const window = offerStartWindow(o.note_date);
  const within_window = o.start_date >= window.start && o.start_date <= window.end;
  const bridgeMonths = o.start_date > o.note_date ? Math.ceil(Math.max(0, (Date.parse(o.start_date) - Date.parse(o.note_date)) / 86_400_000) / 30) + 1 : 0;
  const reserves_documented = (o.reserves_months_pitia ?? 0) >= OFFER_RESERVE_MONTHS || (o.bridge_reserves_documented === true && bridgeMonths > 0);
  const reasons: string[] = [];
  if (!within_window) reasons.push(`start date ${o.start_date} outside [${window.start}, ${window.end}] (no earlier than 30 days prior to / no later than 90 days after the note date)`);
  if (!o.non_contingent || !o.fully_executed) reasons.push("offer must be fully executed and non-contingent");
  if (o.transaction !== "purchase" || o.occupancy !== "principal_residence" || o.units !== 1) reasons.push("purchase of a one-unit principal residence only");
  if (!o.fixed_base_income) reasons.push("fixed base income only");
  if (o.family_or_interested_party) reasons.push("not employed by a family member or interested party");
  if (!reserves_documented) reasons.push(`reserves: ${OFFER_RESERVE_MONTHS} months' PITIA or the liabilities-plus-PITIA bridge (${bridgeMonths} months) must be documented`);
  const available = reasons.length === 0;
  return { available, window, reserves_documented, within_window, refusal_reasons: reasons, sfc_codes: available ? [SFC_EMPLOYMENT_OFFER_OPTION_2] : [], monthly_income_cents: o.monthly_income_cents, formula_version: FORMULAS.employment_offer };
}
/** Option 1 (paystub before delivery): qualifying income = the offer's monthly amount; the paystub is a 29.4 delivery gate, the VVOE is required. */
export function offerOption1(o: Pick<OfferInput, "monthly_income_cents" | "fully_executed" | "paystub_saved_before_delivery">): { qualifying_cents: bigint; delivery_gate: "offer_paystub_saved"; paystub_saved: boolean; formula_version: FormulaId } {
  nonNeg(o.monthly_income_cents, "monthly_income_cents"); if (!o.fully_executed) throw new RangeError("the offer or contract must be fully executed");
  return { qualifying_cents: o.monthly_income_cents, delivery_gate: "offer_paystub_saved", paystub_saved: o.paystub_saved_before_delivery === true, formula_version: FORMULAS.employment_offer };
}
/** The agent's option choice: `employment.offer.option.selected{option}` (option 2 arms FNMA_B3_3_3_03_OFFER_START_WINDOW), then verified (SFC 707 queued) or refused. */
export function selectOfferOption(events: EventStore, r: { application_id: string; income_id: string; borrower_id: string; option: 1 | 2; offer: OfferInput }, actor: Actor = AGENT): { selected: DomainEvent; outcome: DomainEvent; sfc: DomainEvent | null; option2: OfferOption2Result | null; qualifying_cents: bigint } {
  nonEmpty(r.application_id, "application_id"); nonEmpty(r.income_id, "income_id");
  const selected = events.append({ type: "employment.offer.option.selected", applicationId: r.application_id, actor, payload: { income_id: r.income_id, borrower_id: r.borrower_id, option: r.option, start_date: r.offer.start_date, scheduled_note_date: r.offer.note_date, application_id: r.application_id } });
  if (r.option === 1) {
    const o1 = offerOption1(r.offer);
    const outcome = events.append({ type: "employment.offer.verified", applicationId: r.application_id, actor, payload: { income_id: r.income_id, option: 1, within_window: true, reserves_documented: true, sfc_codes: [], delivery_gate: o1.delivery_gate, application_id: r.application_id } });
    return { selected, outcome, sfc: null, option2: null, qualifying_cents: o1.qualifying_cents };
  }
  const o2 = offerOption2(r.offer);
  if (!o2.available) {
    const outcome = events.append({ type: "employment.offer.option.refused", applicationId: r.application_id, actor, payload: { income_id: r.income_id, option: 2, reasons: [...o2.refusal_reasons], window_start: o2.window.start, window_end: o2.window.end, fallback: "option 1 (paystub before delivery) or income excluded", application_id: r.application_id } });
    return { selected, outcome, sfc: null, option2: o2, qualifying_cents: 0n };
  }
  const outcome = events.append({ type: "employment.offer.verified", applicationId: r.application_id, actor, payload: { income_id: r.income_id, option: 2, within_window: true, reserves_documented: true, sfc_codes: [...o2.sfc_codes], window_start: o2.window.start, window_end: o2.window.end, application_id: r.application_id } });
  const sfc = events.append({ type: "delivery.sfc.queued", applicationId: r.application_id, actor, payload: { code: SFC_EMPLOYMENT_OFFER_OPTION_2, reason: "employment offer option 2 (B3-3.3-03)", income_id: r.income_id, application_id: r.application_id } });
  return { selected, outcome, sfc, option2: o2, qualifying_cents: o2.monthly_income_cents };
}

// ============================================================ R8 — temporary leave (B3-3.3-09; Reg B (b)(3))
/** Return before the first payment due date → regular income; after → the lesser of leave income and regular income, reserves bridging the gap. The borrower states the return date; nothing is inferred. */
export function temporaryLeaveIncome(l: { regular_income_cents: bigint; leave_income_cents: bigint | null; return_date: PlainDate; first_payment_due_date: PlainDate; borrower_intent_to_return_document_id: string; employer_return_confirmation_document_id: string }): IncomeCalculation {
  nonNeg(l.regular_income_cents, "regular_income_cents"); nonEmpty(l.borrower_intent_to_return_document_id, "borrower_intent_to_return_document_id"); nonEmpty(l.employer_return_confirmation_document_id, "employer_return_confirmation_document_id");
  const inputs = { regular_income_cents: String(l.regular_income_cents), leave_income_cents: S(l.leave_income_cents), return_date: l.return_date, first_payment_due_date: l.first_payment_due_date };
  if (l.return_date <= l.first_payment_due_date) return calc({ income_type: "temporary_leave", formula_version: FORMULAS.temporary_leave, inputs, steps: [{ label: "return before first payment → regular employment income", cents: String(l.regular_income_cents) }], monthly_qualifying_cents: l.regular_income_cents });
  const leave = l.leave_income_cents ?? 0n; const lesser = leave < l.regular_income_cents ? leave : l.regular_income_cents;
  return calc({ income_type: "temporary_leave", formula_version: FORMULAS.temporary_leave, inputs, steps: [{ label: "return after first payment → lesser of leave income and regular income (+ documented liquid reserves to bridge)", cents: String(lesser) }], monthly_qualifying_cents: lesser, reason: "return_after_first_payment" });
}

// ============================================================ R11 — Reg B evaluation rules (§1002.6(b))
export class RegBViolation extends IncomeRuleRefused { constructor(reason: string) { super("REGB_1002_6_B_NO_DISCOUNT", "12 CFR 1002.6(b)(2), (b)(5): a creditor shall not discount or exclude income because it is part-time, retirement, public assistance, alimony/child support or age-related", reason); this.name = "RegBViolation"; } }
export const REGB_FLAGS: readonly RegBFlag[] = ["part_time", "retirement", "public_assistance", "alimony_child_support", "age_related", "leave"];
const NATURE_WORDS = /\b(part[- ]?time|retire|retirement|pension|annuity|public assistance|welfare|alimony|child support|age|elderly|maternity|pregnan|childbearing|childrearing|family plans)\b/i;
export interface RegBCheckInput { readonly income_type: IncomeType; readonly regb_flags: readonly RegBFlag[]; readonly formula_version: FormulaId; readonly factor?: string | number | null; readonly exclusion_reason?: string | null; readonly history_months?: number | null; }
/** The formula id used must be the one every source of the type gets; a factor < 1.0 or an exclusion citing the source's nature is refused by the engine. */
export function regbCheck(c: RegBCheckInput): { regb_check: "pass"; formula_version: FormulaId; regb_flags: readonly RegBFlag[]; permitted_variables: readonly string[] } {
  const factor = c.factor === null || c.factor === undefined || c.factor === "" ? null : Decimal.parse(String(c.factor));
  if (factor !== null && factor.cmp(Decimal.fromInt(1)) < 0) throw new RegBViolation(`a factor of ${factor.toString()} would discount ${c.income_type} income flagged ${c.regb_flags.join("/") || "none"}; only amount and probable continuance may vary`);
  if (c.exclusion_reason && NATURE_WORDS.test(c.exclusion_reason)) throw new RegBViolation(`exclusion reason cites the nature of the income (${JSON.stringify(c.exclusion_reason)}); an exclusion must cite a documented continuance or history failure`);
  const expected = formulaForType(c.income_type);
  if (expected && expected !== c.formula_version) throw new RegBViolation(`formula ${c.formula_version} differs from the ${c.income_type} formula ${expected} every source of the type gets`);
  return { regb_check: "pass", formula_version: c.formula_version, regb_flags: c.regb_flags, permitted_variables: ["amount", "probable_continuance"] };
}
/** The one formula id a type gets (part-time base salary uses the full-time base formula). */
export function formulaForType(t: IncomeType): FormulaId | null {
  switch (t) {
    case "base_salary": case "second_job": case "military_base": case "military_allowance": return FORMULAS.base_salary;
    case "base_hourly_fixed": return FORMULAS.base_hourly_fixed;
    case "base_hourly_variable": case "overtime": case "bonus": case "commission": case "tip": case "seasonal": case "rsu": return FORMULAS.variable_trending;
    case "employment_offer": return FORMULAS.employment_offer;
    case "temporary_leave": return FORMULAS.temporary_leave;
    case "social_security_retirement": case "social_security_disability": case "social_security_survivor_dependent": return FORMULAS.social_security;
    case "alimony": case "child_support": case "separate_maintenance": return FORMULAS.child_support;
    case "annuity_pension": case "retirement_distribution": return FORMULAS.retirement;
    case "public_assistance": case "section_8_homeownership": return FORMULAS.public_assistance;
    case "rental_subject": case "rental_non_subject": case "rental_departing_residence": case "rental_short_term": return FORMULAS.rental_subject;
    case "rental_adu": return FORMULAS.adu_cap;
    case "self_employment_sole_prop": case "self_employment_partnership": case "self_employment_s_corp": case "self_employment_c_corp": return FORMULAS.self_employment;
    default: return null;
  }
}

// ============================================================ R4 / R9 — self-employment, DU validation and the Income Calculator
export const SELF_EMPLOYED_OWNERSHIP_PCT = 25;
export const selfEmployed = (ownership_pct: number): boolean => pct(ownership_pct, "ownership_pct") >= SELF_EMPLOYED_OWNERSHIP_PCT;
/** Years of returns required (B3-3.5-01): two unless the one-year conditions hold (business ≥ 5 consecutive years with ≥ 25% ownership and increasing income) or DU permits one year. */
export function returnsRequired(s: { business_years: number; ownership_pct: number; income_increasing_two_years: boolean; du_permits_one_year?: boolean }): { years: 1 | 2; basis: string } {
  if (s.du_permits_one_year) return { years: 1, basis: "DU message permits one year (23.2)" };
  if (s.business_years >= 5 && selfEmployed(s.ownership_pct) && s.income_increasing_two_years) return { years: 1, basis: "business ≥ 5 consecutive years, ≥ 25% ownership, increasing self-employment income (B3-3.5-01)" };
  return { years: 2, basis: "two years of signed federal income tax returns (B3-3.5-01)" };
}
/** Income Calculator ceiling (B3-3.1-03): qualifying ≤ the calculator result when the calculator was used; the Findings Report id is attached. */
export function incomeCalculatorCeiling(c: { calculator_result_cents: bigint; agent_result_cents: bigint; findings_report_id: string }): { qualifying_cents: bigint; ceiling_applied: boolean; income_calculator_report_id: string; formula_version: FormulaId } {
  nonNeg(c.calculator_result_cents, "calculator_result_cents"); nonNeg(c.agent_result_cents, "agent_result_cents"); nonEmpty(c.findings_report_id, "findings_report_id (a copy of the Findings Report must be maintained in the loan file)");
  const capped = c.agent_result_cents > c.calculator_result_cents;
  return { qualifying_cents: capped ? c.calculator_result_cents : c.agent_result_cents, ceiling_applied: capped, income_calculator_report_id: c.findings_report_id, formula_version: FORMULAS.self_employment };
}
/** Any qualifying figure above the calculator result — including a manual override — is refused. */
export function assertUnderCalculatorCeiling(qualifying_cents: bigint, calculator_result_cents: bigint | null): void {
  if (calculator_result_cents !== null && qualifying_cents > calculator_result_cents) throw new IncomeRuleRefused("INCOME_CALCULATOR_CEILING", "B3-3.1-03: the amount of qualifying income used is not more than the amount calculated by Income Calculator", `${qualifying_cents} cents exceeds the Income Calculator result ${calculator_result_cents} cents`);
}
export function submitIncomeCalculator(events: EventStore, r: { application_id: string; income_id: string; borrower_id: string; business_structure: "schedule_c" | "partnership" | "s_corp" | "c_corp"; tax_years: readonly number[]; path: "tsp" | "iframe" | "web" }, actor: Actor = AGENT): DomainEvent {
  nonEmpty(r.application_id, "application_id"); nonEmpty(r.income_id, "income_id"); if (!r.tax_years.length) throw new RangeError("tax_years are required");
  return events.append({ type: "income_calculator.submitted", applicationId: r.application_id, actor, payload: { income_id: r.income_id, borrower_id: r.borrower_id, business_structure: r.business_structure, tax_years: [...r.tax_years], path: r.path, application_id: r.application_id } });
}
export function recordCalculatorFindings(events: EventStore, r: { application_id: string; income_id: string; findings_report_id: string; calculator_result_cents: bigint; agent_result_cents: bigint }, actor: Actor = AGENT): ReturnType<typeof incomeCalculatorCeiling> & { event: DomainEvent; du_fields: Record<string, string> } {
  const c = incomeCalculatorCeiling(r);
  const event = events.append({ type: "income_calculator.findings.received", applicationId: r.application_id, actor, payload: { income_id: r.income_id, report_id: r.findings_report_id, result_cents: String(r.calculator_result_cents), agent_result_cents: String(r.agent_result_cents), qualifying_cents: String(c.qualifying_cents), ceiling_applied: c.ceiling_applied, application_id: r.application_id } });
  return { ...c, event, du_fields: { "DU:VerificationReportSupplierType": "IncomeCalculator", "DU:VerificationReportType": "IncomeCalculator", "DU:VerificationReportIdentifier": r.findings_report_id } };
}

export type DuOutcome = "validated" | "not_validated" | "not_eligible" | "not_submitted";
export interface DuValidationMessage { readonly application_id: string; readonly borrower_id: string; readonly component: "income" | "employment" | "assets"; readonly outcome: DuOutcome; readonly report_reference_id: string; readonly supplier_code: string; readonly employer_name?: string | null; readonly close_by_date?: PlainDate | null; readonly documentation_required?: readonly string[]; readonly submission_number?: string | null; readonly message_date: PlainDate; }
/**
 * A DU validation message (23.2): `validated` → `income.validated{component}` (employment carries the Close by Date and arms FNMA_B3_2_02_DU_CLOSE_BY_GATE; paper requests are
 * waived by 22.1 and relief recorded); anything else → `income.not_validated{component, documentation_required}` — never treated as a validation (AI-design guardrail).
 */
export function recordDuValidation(events: EventStore, m: DuValidationMessage, actor: Actor = AGENT): { validated: boolean; event: DomainEvent; relief: { component: string; status: "granted_subject_to_conditions" | "none"; conditions: readonly string[] } } {
  nonEmpty(m.application_id, "application_id"); nonEmpty(m.borrower_id, "borrower_id"); nonEmpty(m.report_reference_id, "report_reference_id"); nonEmpty(m.supplier_code, "supplier_code");
  if (m.outcome !== "validated") {
    const event = events.append({ type: "income.not_validated", applicationId: m.application_id, actor, payload: { component: m.component, borrower_id: m.borrower_id, outcome: m.outcome, report_reference_id: m.report_reference_id, documentation_required: [...(m.documentation_required ?? [])], application_id: m.application_id } });
    return { validated: false, event, relief: { component: m.component, status: "none", conditions: [] } };
  }
  if (m.component === "employment") nonEmpty(m.close_by_date, "close_by_date (the DU employment validation message states it)");
  const event = events.append({ type: "income.validated", applicationId: m.application_id, actor, payload: { component: m.component, borrower_id: m.borrower_id, employer_name: m.employer_name ?? null, close_by_date: m.close_by_date ?? null, report_reference_id: m.report_reference_id, supplier_code: m.supplier_code, submission_number: m.submission_number ?? null, message_date: m.message_date, application_id: m.application_id } });
  return { validated: true, event, relief: { component: m.component, status: "granted_subject_to_conditions", conditions: ["all DU validation service requirements met", "verification messages and approval conditions resolved", ...(m.component === "employment" ? [`loan closes by the Close by Date ${m.close_by_date}`] : [])] } };
}
/** The Close by Date gate: consummation must occur ≤ close_by_date; open while the scheduled note date is on/before it. */
export function closeByGate(closeBy: PlainDate, scheduledNoteDate: PlainDate): { open: boolean; reason: string | null } {
  return scheduledNoteDate <= closeBy ? { open: true, reason: null } : { open: false, reason: `scheduled note date ${scheduledNoteDate} is after the DU Close by Date ${closeBy} (B3-2-02; A2-2-04 relief lost if not cured)` };
}
/**
 * A closing move re-checks the gate (R9 worked example: Close by Fri Nov 20 → slip to Mon Nov 23): the breach requires a supplemental report or a VVOE inside the
 * recomputed window (Fri Nov 6 – Mon Nov 23) and a DU resubmission (23.1); the employment relief record is updated to `lost_unless_cured`.
 */
export function reassessCloseBy(events: EventStore, r: { application_id: string; borrower_id: string; close_by_date: PlainDate; scheduled_note_date: PlainDate; report_reference_id: string; calendar?: Calendar }, actor: Actor = AGENT): { breached: boolean; cure_options: readonly string[]; vvoe_window: VerificationWindow | null; relief: { component: "employment"; status: "in_force" | "lost_unless_cured" }; events: DomainEvent[] } {
  nonEmpty(r.application_id, "application_id");
  const g = closeByGate(r.close_by_date, r.scheduled_note_date);
  if (g.open) return { breached: false, cure_options: [], vvoe_window: null, relief: { component: "employment", status: "in_force" }, events: [] };
  const w = vvoeWindow(r.scheduled_note_date, r.calendar ?? creditor);
  const out = [
    events.append({ type: "du.close_by.missed", applicationId: r.application_id, actor, payload: { borrower_id: r.borrower_id, close_by_date: r.close_by_date, scheduled_note_date: r.scheduled_note_date, report_reference_id: r.report_reference_id, cure_options: ["supplemental_report", "vvoe"], vvoe_window_start: w.window_start, vvoe_window_end: w.note_date, reason: g.reason, application_id: r.application_id } }),
    events.append({ type: "du.resubmission.requested", applicationId: r.application_id, actor, payload: { reason: "close_by_date_missed", borrower_id: r.borrower_id, close_by_date: r.close_by_date, scheduled_note_date: r.scheduled_note_date, application_id: r.application_id } }),
    events.append({ type: "rep_warrant_relief.updated", applicationId: r.application_id, actor, payload: { component: "employment", borrower_id: r.borrower_id, status: "lost_unless_cured", cure_options: ["supplemental_report", "vvoe"], report_reference_id: r.report_reference_id, application_id: r.application_id } }),
  ];
  return { breached: true, cure_options: ["supplemental_report", "vvoe"], vvoe_window: w, relief: { component: "employment", status: "lost_unless_cured" }, events: out };
}
export type VerificationKind = "income" | "employment" | "vvoe" | "tax_transcript" | "rental" | "assets";
/** A vendor report / IVES delivery lands as `verification.received{kind}` (baseline event; 23.1 cites the report reference in the DU submission). */
export function receiveVerification(events: EventStore, r: { application_id: string; borrower_id: string; kind: VerificationKind; supplier_code: string; report_reference_id: string; vendor_data_as_of: PlainDate; report_document_id: string; authorization_consent_id: string; verification_id?: string }, actor: Actor = AGENT): { verification_id: string; event: DomainEvent } {
  nonEmpty(r.application_id, "application_id"); nonEmpty(r.supplier_code, "supplier_code"); nonEmpty(r.report_reference_id, "report_reference_id"); nonEmpty(r.authorization_consent_id, "authorization_consent_id (B3-2-02: borrower authorization to receive the information from the vendor)");
  const verification_id = r.verification_id ?? ids("ver");
  const event = events.append({ type: "verification.received", applicationId: r.application_id, actor, payload: { kind: r.kind, verification_id, borrower_id: r.borrower_id, supplier_code: r.supplier_code, report_reference_id: r.report_reference_id, vendor_data_as_of: r.vendor_data_as_of, report_document_id: r.report_document_id, authorization_consent_id: r.authorization_consent_id, application_id: r.application_id } });
  return { verification_id, event };
}

// ============================================================ R10 — transcripts and Form 4506-C / 8821
export const FORM_4506C_VALID_DAYS = 120;
export const IVES_FEE_CENTS = 400n;
export type TranscriptForm = "4506c" | "8821";
export type SignatureMethod = "esign_2fa" | "esign_kba" | "esign_sso" | "wet";
export type TranscriptChannel = "ives_a2a" | "ives_webui" | "du_transcript_supplier";
export type TranscriptType = "return_1040" | "wage_income";
export interface TaxTranscriptRequest {
  readonly request_id: string; readonly application_id: string; readonly borrower_id: string; readonly form: TranscriptForm; readonly signed_at: string; readonly signed_on: PlainDate; readonly signature_method: SignatureMethod; readonly signature_audit_log_document_id: string;
  readonly valid_until: PlainDate; readonly channel: TranscriptChannel | null; readonly participant_id_masked: string | null; readonly transcript_types: readonly TranscriptType[]; readonly tax_years: readonly number[]; readonly ordered_at: string | null; readonly received_at: string | null;
  readonly status: "signed" | "ordered" | "received" | "no_record" | "rejected" | "expired"; readonly fee_cents: bigint; readonly discrepancy: Record<string, unknown> | null; readonly retention_class: "irs_ives_2y"; readonly fannie_mae_disclosure_authorized: boolean;
}
/** `valid_until = signed_at + 120 calendar days` — signed Mon Oct 5, 2026 → Tue Feb 2, 2027. */
export const form4506cValidUntil = (signedOn: PlainDate): PlainDate => addDays(signedOn, FORM_4506C_VALID_DAYS);
/**
 * The borrower's signature on the 4506-C (or 8821 with the Fannie Mae-disclosure authorization) with an IVES-grade e-signature audit log; the agent prepares, never signs
 * (AI-design guardrail). Appends `transcript.authorization.signed` (arms FNMA_B3_3_1_02_4506C_VALID_120).
 */
export function signAuthorization(events: EventStore, r: { application_id: string; borrower_id: string; form: TranscriptForm; signed_at: string; signed_by: "borrower" | string; signature_method: SignatureMethod; signature_audit_log_document_id: string | null; tax_years: readonly number[]; transcript_types?: readonly TranscriptType[]; fannie_mae_disclosure_authorized?: boolean; request_id?: string }, actor: Actor = BORROWER): { record: TaxTranscriptRequest; event: DomainEvent } {
  nonEmpty(r.application_id, "application_id"); nonEmpty(r.borrower_id, "borrower_id"); nonEmpty(r.signed_at, "signed_at");
  if (r.signed_by !== "borrower") throw new IncomeRuleRefused("FORM_4506C_SIGNER", "B3-3.1-02: each borrower whose income is used in qualifying must complete and sign the form; 22.3 AI design: the agent prepares, the borrower signs", `signed_by ${JSON.stringify(r.signed_by)} is not the borrower`);
  if (r.signature_method !== "wet" && !r.signature_audit_log_document_id) throw new RangeError("signature_audit_log_document_id is required for an electronic signature (IVES: an audit log of the entire signing ceremony must accompany the document)");
  if (r.form === "8821" && r.fannie_mae_disclosure_authorized !== true) throw new IncomeRuleRefused("FORM_8821_FNMA_DISCLOSURE", "B3-3.1-02: Form 8821 is acceptable only with the borrower's authorization to disclose IRS-derived information to Fannie Mae", "fannie_mae_disclosure_authorized must be true");
  if (!r.tax_years.length || r.tax_years.length > 4) throw new RangeError("tax_years: 1–4 years or periods per form");
  const signed_on = civilDate(r.signed_at);
  const record: TaxTranscriptRequest = { request_id: r.request_id ?? ids("ttr"), application_id: r.application_id, borrower_id: r.borrower_id, form: r.form, signed_at: r.signed_at, signed_on, signature_method: r.signature_method, signature_audit_log_document_id: r.signature_audit_log_document_id ?? "wet-signature",
    valid_until: form4506cValidUntil(signed_on), channel: null, participant_id_masked: null, transcript_types: r.transcript_types ?? ["return_1040"], tax_years: [...r.tax_years], ordered_at: null, received_at: null, status: "signed", fee_cents: 0n, discrepancy: null, retention_class: "irs_ives_2y", fannie_mae_disclosure_authorized: r.form === "4506c" ? true : r.fannie_mae_disclosure_authorized === true };
  const event = events.append({ type: "transcript.authorization.signed", applicationId: r.application_id, actor, payload: { request_id: record.request_id, borrower_id: r.borrower_id, form: r.form, signed_at: r.signed_at, signed_on, valid_until: record.valid_until, signature_method: r.signature_method, tax_years: [...r.tax_years], application_id: r.application_id } });
  return { record, event };
}
/** Order transcripts under a live authorization: 400 cents per transcript (IVES) to `third_party_costs`; an expired signature is refused (re-sign via the needs list). */
export function orderTranscript(events: EventStore, req: TaxTranscriptRequest, o: { channel: TranscriptChannel; ordered_at: string; participant_id_masked: string }, actor: Actor = AGENT): { record: TaxTranscriptRequest; event: DomainEvent; fee_cents: bigint } {
  nonEmpty(o.participant_id_masked, "participant_id_masked");
  const ordered_on = civilDate(o.ordered_at);
  if (ordered_on > req.valid_until) throw new IncomeRuleRefused("FORM_4506C_EXPIRED", "B3-3.1-02: IRS Form 4506-C is valid for 120 days after completion", `signed ${req.signed_on}, valid until ${req.valid_until}; ordered ${ordered_on}`);
  if (req.status !== "signed") throw new RangeError(`request ${req.request_id} is ${req.status}, not signed`);
  const fee_cents = IVES_FEE_CENTS * BigInt(req.transcript_types.length * req.tax_years.length);
  const record: TaxTranscriptRequest = { ...req, channel: o.channel, participant_id_masked: o.participant_id_masked, ordered_at: o.ordered_at, status: "ordered", fee_cents };
  const event = events.append({ type: "transcript.ordered", applicationId: req.application_id, actor, payload: { request_id: req.request_id, borrower_id: req.borrower_id, channel: o.channel, transcript_types: [...req.transcript_types], tax_years: [...req.tax_years], fee_cents: String(fee_cents), ledger_account: "third_party_costs", application_id: req.application_id } });
  return { record, event, fee_cents };
}
export interface TranscriptDelivery { readonly received_at: string; readonly result: "received" | "no_record" | "rejected"; readonly figures?: readonly { tax_year: number; line: string; transcript_cents: bigint; return_cents: bigint }[]; readonly rejection_code?: string | null; }
/** The IRS response: figures are reconciled to the returns; a difference is `transcript.discrepancy.detected` and must be resolved before `income.finalized`; "no record" for a required year → the B1-1-03 Form 4868 path or exclusion. */
export function receiveTranscript(events: EventStore, req: TaxTranscriptRequest, d: TranscriptDelivery, actor: Actor = AGENT): { record: TaxTranscriptRequest; event: DomainEvent; discrepancies: DomainEvent[] } {
  if (req.status !== "ordered") throw new RangeError(`request ${req.request_id} is ${req.status}, not ordered`);
  const discrepancies: DomainEvent[] = [];
  for (const f of d.figures ?? []) if (f.transcript_cents !== f.return_cents) discrepancies.push(events.append({ type: "transcript.discrepancy.detected", applicationId: req.application_id, actor, payload: { request_id: req.request_id, borrower_id: req.borrower_id, tax_year: f.tax_year, line: f.line, transcript_cents: String(f.transcript_cents), return_cents: String(f.return_cents), resolution_required_before: "income.finalized", application_id: req.application_id } }));
  const record: TaxTranscriptRequest = { ...req, received_at: d.received_at, status: d.result, discrepancy: discrepancies.length ? { count: discrepancies.length, items: discrepancies.map((e) => e.payload) } : null };
  const event = events.append({ type: "transcript.received", applicationId: req.application_id, actor, payload: { request_id: req.request_id, borrower_id: req.borrower_id, status: d.result, rejection_code: d.rejection_code ?? null, discrepancy_count: discrepancies.length, no_record_path: d.result === "no_record" ? "B1-1-03 Form 4868 extension path or exclusion" : null, application_id: req.application_id } });
  return { record, event, discrepancies };
}
export interface BorrowerAuthorizationFact { readonly borrower_id: string; readonly income_used_for_qualifying: boolean; readonly all_income_du_validated: boolean; readonly authorization_signed: boolean; readonly authorization_valid_until?: PlainDate | null; }
/** The `consummate` gate: a signed 4506-C/8821 at or before closing for every qualifying borrower unless all of that borrower's income is DU-validated. */
export function form4506cGate(borrowers: readonly BorrowerAuthorizationFact[], closingOn: PlainDate | null = null): { open: boolean; required: string[]; missing: string[]; exempt: string[] } {
  const required: string[] = [], missing: string[] = [], exempt: string[] = [];
  for (const b of borrowers) {
    if (!b.income_used_for_qualifying) continue;
    if (b.all_income_du_validated) { exempt.push(b.borrower_id); continue; }
    required.push(b.borrower_id);
    const live = b.authorization_signed && (!closingOn || !b.authorization_valid_until || b.authorization_valid_until >= closingOn);
    if (!live) missing.push(b.borrower_id);
  }
  return { open: missing.length === 0, required, missing, exempt };
}
/** Q3 transcript policy: Return Transcripts whenever tax returns are relied upon; Wage & Income transcripts when 22.1 flagged W-2/1099 integrity. */
export function transcriptPolicy(s: { returns_relied_upon: boolean; w2_1099_integrity_flagged: boolean; tax_years: readonly number[] }): { order: boolean; transcript_types: TranscriptType[]; tax_years: readonly number[] } {
  const types: TranscriptType[] = []; if (s.returns_relied_upon) types.push("return_1040"); if (s.w2_1099_integrity_flagged) types.push("wage_income");
  return { order: types.length > 0, transcript_types: types, tax_years: s.tax_years };
}

// ============================================================ documentation matrix, ATR manifest, the calculation record and finalisation
export interface DeclaredSource { readonly income_id: string; readonly borrower_id: string; readonly income_type: IncomeType; readonly employer_name?: string | null; readonly ownership_pct?: number | null; readonly du_validation_outcome?: DuOutcome; readonly integrity_flagged_document_ids?: readonly string[]; }
export interface MatrixItem { readonly income_id: string; readonly borrower_id: string; readonly income_type: IncomeType; readonly preferred: readonly string[]; readonly paper: readonly string[]; readonly vvoe_required: boolean; readonly business_verification_required: boolean; readonly returns_required: boolean; readonly form_4506c_required: boolean; readonly waived_by_du: boolean; }
const EMPLOYMENT_TYPES: ReadonlySet<IncomeType> = new Set(["base_salary", "base_hourly_fixed", "base_hourly_variable", "overtime", "bonus", "commission", "tip", "second_job", "seasonal", "employment_offer", "temporary_leave", "military_base", "military_allowance", "rsu"]);
const SELF_EMPLOYMENT_TYPES: ReadonlySet<IncomeType> = new Set(["self_employment_sole_prop", "self_employment_partnership", "self_employment_s_corp", "self_employment_c_corp"]);
const RETURN_TYPES: ReadonlySet<IncomeType> = new Set([...SELF_EMPLOYMENT_TYPES, "rental_subject", "rental_non_subject", "rental_departing_residence", "rental_short_term", "rental_adu", "foreign_employment", "k1_under_25", "capital_gains", "interest_dividend", "royalty", "notes_receivable", "trust"]);
/** Per source: the source-obtained report first (DU validation service supplier), the B3-3.2-01 paper alternative, and the verifications the type needs. */
export function documentationMatrix(sources: readonly DeclaredSource[]): MatrixItem[] {
  return sources.map((s) => {
    const validated = s.du_validation_outcome === "validated";
    const employment = EMPLOYMENT_TYPES.has(s.income_type), self = SELF_EMPLOYMENT_TYPES.has(s.income_type) || (s.ownership_pct !== null && s.ownership_pct !== undefined && s.ownership_pct >= SELF_EMPLOYED_OWNERSHIP_PCT);
    const preferred = employment ? ["du_validation_income_employment_report"] : self ? ["income_calculator_findings_report", "du_validation_tax_transcript_report"] : RETURN_TYPES.has(s.income_type) ? ["du_validation_tax_transcript_report"] : ["source_obtained_benefit_statement"];
    const paper = employment ? (s.income_type === "base_salary" || s.income_type === "base_hourly_fixed" ? ["form_1005_voe", "paystub_ytd", "w2_most_recent"] : ["form_1005_voe", "paystub_ytd", "w2_two_years"]) : self ? ["tax_returns_personal_2y", "tax_returns_business_2y", "ytd_pnl", "business_statements_2m", "se_written_evaluation"]
      : s.income_type.startsWith("rental") ? ["form_1007_or_1025", "lease_agreements", "schedule_e"] : s.income_type === "child_support" || s.income_type === "alimony" || s.income_type === "separate_maintenance" ? ["divorce_decree_or_agreement", "receipts_6m"] : s.income_type.startsWith("social_security") ? ["ssa_award_letter_or_1099", "proof_of_current_receipt"] : ["benefit_statement", "proof_of_receipt"];
    return { income_id: s.income_id, borrower_id: s.borrower_id, income_type: s.income_type, preferred, paper: validated ? [] : paper, vvoe_required: employment || self, business_verification_required: self, returns_required: RETURN_TYPES.has(s.income_type) && !validated, form_4506c_required: !validated, waived_by_du: validated };
  });
}
export function buildDocumentationMatrix(events: EventStore, r: { application_id: string; sources: readonly DeclaredSource[] }, actor: Actor = AGENT): { items: MatrixItem[]; event: DomainEvent } {
  nonEmpty(r.application_id, "application_id"); if (!r.sources.length) throw new RangeError("sources are required (the 1003 interview's declared income)");
  const items = documentationMatrix(r.sources);
  const event = events.append({ type: "income.documentation.matrix.built", applicationId: r.application_id, actor, payload: { application_id: r.application_id, items: items.map((i) => ({ ...i, preferred: [...i.preferred], paper: [...i.paper] })) } });
  return { items, event };
}
/** §1026.43(c)(4) record categories a source's evidence falls in (R12); an oral VOE counts only with the written R1 record. */
export function atrRecordTypes(evidence: readonly { doc_class: string }[], vvoe: EmploymentVerification | null = null): AtrRecordType[] {
  const map: Record<string, AtrRecordType> = { paystub: "payroll_statement", paystub_ytd: "payroll_statement", military_les: "payroll_statement", w2: "w2", w2_most_recent: "w2", w2_two_years: "w2", form_1099: "w2", tax_return: "tax_return", tax_returns_personal_2y: "tax_return", tax_returns_business_2y: "tax_return", irs_transcript: "irs_transcript", return_transcript: "irs_transcript", wage_income_transcript: "irs_transcript",
    form_1005_voe: "employer_record_third_party", du_validation_income_employment_report: "employer_record_third_party", vendor_voe: "employer_record_third_party", ssa_award_letter: "government_benefit_statement", ssa_1099: "government_benefit_statement", benefit_statement: "government_benefit_statement", agency_letter: "government_benefit_statement", bank_statement: "financial_institution_record", divorce_decree: "court_order", lease: "lease", form_1007: "appraisal_rent_schedule", form_1025: "appraisal_rent_schedule" };
  const out = new Set<AtrRecordType>();
  for (const e of evidence) { const t = map[e.doc_class]; if (t) out.add(t); }
  if (vvoe && vvoe.contact_name && vvoe.contact_title && vvoe.phone_source) out.add("employer_record_third_party");
  return [...out];
}
export interface CalculateIncomeInput {
  readonly application_id: string; readonly borrower_id: string; readonly income_id: string; readonly income_type: IncomeType; readonly regb_flags?: readonly RegBFlag[]; readonly scheduled_note_date?: PlainDate | null;
  readonly factor?: string | number | null; readonly evidence_document_ids?: readonly string[]; readonly flagged_document_ids?: readonly string[]; readonly calculator_result_cents?: bigint | null; readonly income_calculator_report_id?: string | null;
  readonly inputs: Record<string, unknown>;
}
/** Dispatch by type to the versioned formula, run the Reg B check and append `income.calculated` (arms FNMA_B3_3_1_01_CONTINUANCE_3Y; `income.trend.assessed` for variable types). */
export function calculateIncome(events: EventStore, r: CalculateIncomeInput, actor: Actor = AGENT): { calculation: IncomeCalculation; regb: ReturnType<typeof regbCheck>; event: DomainEvent; trend_event: DomainEvent | null } {
  nonEmpty(r.application_id, "application_id"); nonEmpty(r.borrower_id, "borrower_id"); nonEmpty(r.income_id, "income_id");
  const flagged = r.flagged_document_ids ?? [], evidence = r.evidence_document_ids ?? [];
  if (evidence.length && evidence.every((d) => flagged.includes(d))) throw new IncomeRuleRefused("FLAGGED_SOLE_EVIDENCE", "22.3 AI design: never accept a paystub/W-2 that 22.1 marked `flagged` as the sole evidence", `every evidence document (${evidence.join(", ")}) is integrity-flagged; a source-obtained VOE/validation report is required`);
  const i = r.inputs; const c = (k: string): bigint => { const v = i[k]; if (typeof v === "bigint") return v; if (typeof v === "string" || typeof v === "number") return BigInt(v); throw new RangeError(`inputs.${k} (bigint cents) is required`); };
  const n = (k: string, d: number | null = null): number | null => (i[k] === undefined || i[k] === null ? d : Number(i[k]));
  const dt = (k: string): PlainDate | null => (typeof i[k] === "string" && i[k] ? D(String(i[k])) : null);
  const flags = r.regb_flags ?? [];
  let calculation: IncomeCalculation; let trendDetail: TrendResult | null = null;
  switch (r.income_type) {
    case "base_salary": case "second_job": case "military_base": case "military_allowance": calculation = i.monthly_cents !== undefined ? { ...baseMonthly(c("monthly_cents"), flags), income_type: r.income_type } : { ...baseSalary(c("annual_salary_cents"), flags), income_type: r.income_type }; break;
    case "base_hourly_fixed": calculation = hourlyBase({ rate_cents: c("rate_cents"), guaranteed_hours_per_week: n("guaranteed_hours_per_week"), hours_min: n("hours_min"), hours_max: n("hours_max"), avg_hours_per_week: n("avg_hours_per_week") }); break;
    case "base_hourly_variable": if (i.ytd_cents === undefined) { calculation = hourlyBase({ rate_cents: c("rate_cents"), guaranteed_hours_per_week: n("guaranteed_hours_per_week"), hours_min: n("hours_min"), hours_max: n("hours_max"), avg_hours_per_week: n("avg_hours_per_week") }); break; }
    // falls through: a variable-hours source with YTD / prior-year earnings is trended under R3 (B3-3.3-01: "Variable base income refers to a fixed hourly rate with fluctuating hours")
    case "overtime": case "bonus": case "commission": case "tip": case "seasonal": case "rsu": {
      const s = i.stabilization as { since: string; cents_since: bigint | string; months_since: number } | null | undefined;
      const v = variableIncome({ income_type: r.income_type, ytd_cents: c("ytd_cents"), ytd_months: n("ytd_months")!, prior_year_cents: c("prior_year_cents"), stable_band_pct: n("stable_band_pct", STABLE_BAND_PCT_DEFAULT)!, history_months: n("history_months"), stabilization: s ? { since: D(s.since), cents_since: BigInt(s.cents_since), months_since: Number(s.months_since) } : null });
      trendDetail = v.trend_detail; calculation = v; break; }
    case "social_security_retirement": case "social_security_disability": case "social_security_survivor_dependent": calculation = socialSecurity({ amount_cents: c("amount_cents"), record: (i.record as SocialSecurityInput["record"]) ?? "own", benefit: (i.benefit as SocialSecurityInput["benefit"]) ?? "retirement", documented_nontaxable_pct: n("documented_nontaxable_pct"), continuance_end_date: dt("continuance_end_date") }); break;
    case "child_support": case "alimony": case "separate_maintenance": calculation = supportIncome({ amount_cents: c("amount_cents"), kind: r.income_type, receipts_months: n("receipts_months", 0)!, receipts_full_regular_timely: i.receipts_full_regular_timely !== false, agreement_document_id: typeof i.agreement_document_id === "string" ? i.agreement_document_id : null, child_date_of_birth: dt("child_date_of_birth"), term_end_date: dt("term_end_date"), state_extends_support_to: dt("state_extends_support_to") }); break;
    case "retirement_distribution": case "annuity_pension": calculation = retirementDistribution({ monthly_cents: c("monthly_cents"), eligible_balances_cents: ((i.eligible_balances_cents as (bigint | string)[] | undefined) ?? []).map((b) => BigInt(b)), unrestricted_penalty_free: i.unrestricted_penalty_free !== false }); break;
    case "public_assistance": case "section_8_homeownership": calculation = publicAssistance({ monthly_cents: c("monthly_cents"), agency_letter_document_id: typeof i.agency_letter_document_id === "string" ? i.agency_letter_document_id : null, duration_end_date: dt("duration_end_date") }); break;
    case "temporary_leave": calculation = temporaryLeaveIncome({ regular_income_cents: c("regular_income_cents"), leave_income_cents: i.leave_income_cents === null || i.leave_income_cents === undefined ? null : c("leave_income_cents"), return_date: dt("return_date")!, first_payment_due_date: dt("first_payment_due_date")!, borrower_intent_to_return_document_id: String(i.borrower_intent_to_return_document_id ?? ""), employer_return_confirmation_document_id: String(i.employer_return_confirmation_document_id ?? "") }); break;
    case "rental_subject": case "rental_non_subject": case "rental_departing_residence": case "rental_short_term": {
      const rr = subjectRental({ gross_rent_cents: c("gross_rent_cents"), pitia_cents: c("pitia_cents"), transaction: (i.transaction as "purchase" | "refinance") ?? "purchase", management_experience_months: n("management_experience_months"), fair_rental_days: n("fair_rental_days"), lease_term_months: n("lease_term_months"), on_1040: i.on_1040 !== false });
      calculation = calc({ income_type: r.income_type, formula_version: rr.formula_version, inputs: { gross_rent_cents: String(c("gross_rent_cents")), pitia_cents: String(c("pitia_cents")), management_experience_months: n("management_experience_months"), fair_rental_days: n("fair_rental_days"), offset_only: rr.offset_only, liability_added_cents: String(rr.liability_added_cents) },
        steps: [{ label: "net = round(gross × 75%)", cents: String(rr.net_cents) }, { label: "anri = net − PITIA", cents: String(rr.anri_cents) }, { label: rr.offset_only ? "positive ANRI, < 12 months experience → offset only" : rr.anri_cents < 0n ? "negative ANRI → monthly obligation (22.5)" : "positive ANRI → income", cents: String(rr.income_added_cents) }], monthly_qualifying_cents: rr.income_added_cents, reason: rr.reason }); break; }
    case "rental_adu": {
      const a = aduCap({ total_qualifying_cents: c("total_qualifying_cents"), adu_net_cents: c("adu_net_cents"), transaction: (i.transaction as "purchase" | "lcor" | "cash_out_refinance") ?? "purchase" });
      calculation = calc({ income_type: "rental_adu", formula_version: a.formula_version, inputs: { total_qualifying_cents: String(c("total_qualifying_cents")), adu_net_cents: String(c("adu_net_cents")), transaction: String(i.transaction ?? "purchase") }, steps: [{ label: `cap = round(total × ${ADU_CAP_PCT}%)`, cents: String(a.cap_cents) }, { label: a.excluded ? "cash-out refinance → excluded" : a.capped ? "capped" : "under the cap", cents: String(a.allowed_cents) }], monthly_qualifying_cents: a.allowed_cents, reason: a.reason }); break; }
    case "self_employment_sole_prop": case "self_employment_partnership": case "self_employment_s_corp": case "self_employment_c_corp": {
      const agent = c("form_1084_result_cents"); const ceiling = r.calculator_result_cents ?? null;
      const q = ceiling !== null ? incomeCalculatorCeiling({ calculator_result_cents: ceiling, agent_result_cents: agent, findings_report_id: r.income_calculator_report_id ?? "" }).qualifying_cents : agent;
      calculation = calc({ income_type: r.income_type, formula_version: FORMULAS.self_employment, inputs: { form_1084_result_cents: String(agent), calculator_result_cents: S(ceiling), income_calculator_report_id: r.income_calculator_report_id ?? null, ownership_pct: n("ownership_pct") }, steps: [{ label: "Form 1084 cash-flow analysis", cents: String(agent) }, ...(ceiling !== null ? [{ label: "min(analysis, Income Calculator result)", cents: String(q) }] : [])], monthly_qualifying_cents: q }); break; }
    default: throw new RangeError(`no versioned formula for income_type ${r.income_type}`);
  }
  const regb = regbCheck({ income_type: calculation.reclassified_to ?? r.income_type, regb_flags: flags, formula_version: calculation.formula_version, factor: r.factor ?? null, history_months: n("history_months") });
  assertUnderCalculatorCeiling(calculation.monthly_qualifying_cents, r.calculator_result_cents ?? null);
  const event = events.append({ type: "income.calculated", applicationId: r.application_id, actor, payload: { income_id: r.income_id, borrower_id: r.borrower_id, income_type: calculation.income_type, formula_version: calculation.formula_version, monthly_qualifying_cents: String(calculation.monthly_qualifying_cents), gross_up_cents: String(calculation.gross_up_cents), nontaxable_cents: String(calculation.nontaxable_cents), qualifying_cents: String(calculation.qualifying_cents),
    trend: calculation.trend, stabilized_since: calculation.stabilized_since, continuance_basis: calculation.continuance_basis, continuance_end_date: calculation.continuance_end_date, regb_flags: [...flags], regb_check: regb.regb_check, reason: calculation.reason, reclassified_to: calculation.reclassified_to, scheduled_note_date: r.scheduled_note_date ?? null, rule_set_version: RULE_SET_VERSION, steps: calculation.steps.map((s) => ({ ...s })), application_id: r.application_id } });
  const trend_event = trendDetail ? events.append({ type: "income.trend.assessed", applicationId: r.application_id, actor, payload: { income_id: r.income_id, trend: trendDetail.trend, ytd_monthly_cents: String(trendDetail.ytd_monthly_cents), prior_monthly_cents: String(trendDetail.prior_monthly_cents), change_pct: trendDetail.change_pct, stabilized_since: calculation.stabilized_since, application_id: r.application_id } }) : null;
  return { calculation, regb, event, trend_event };
}
export interface QualifyingSource { readonly income_id: string; readonly monthly_qualifying_cents: bigint; readonly gross_up_cents: bigint; readonly used_for_qualifying: boolean; readonly offset_only?: boolean; readonly liability_added_cents?: bigint; }
/** R13: `Σ monthly_qualifying_cents (used_for_qualifying, not offset-only) + Σ gross_up_cents`; net rental losses go to 22.5 as obligations — $6,250.00 + $921.43 + $2,075.00 = 924,643 cents. */
export function totalQualifying(sources: readonly QualifyingSource[]): { total_qualifying_cents: bigint; obligations_from_rental_cents: bigint; counted: string[] } {
  let total = 0n, obligations = 0n; const counted: string[] = [];
  for (const s of sources) {
    obligations += s.liability_added_cents ?? 0n;
    if (!s.used_for_qualifying || s.offset_only) continue;
    total += nonNeg(s.monthly_qualifying_cents, "monthly_qualifying_cents") + nonNeg(s.gross_up_cents, "gross_up_cents"); counted.push(s.income_id);
  }
  return { total_qualifying_cents: total, obligations_from_rental_cents: obligations, counted };
}
export interface FinalizeSource extends QualifyingSource { readonly income_type: IncomeType; readonly formula_version: FormulaId | null; readonly evidence_document_ids: readonly string[]; readonly continuance_documented: boolean; readonly regb_check: "pass" | null; readonly atr_record_types: readonly AtrRecordType[]; readonly transcript_discrepancy_open?: boolean; }
/** The terminal snapshot for 23.1/23.3/22.5/23.4: every guard of the state machine holds, and no closing move since the windows were last run. */
export function finalizeIncome(events: EventStore, r: { application_id: string; sources: readonly FinalizeSource[]; windows_run_for_note_date: PlainDate | null; scheduled_note_date: PlainDate | null }, actor: Actor = AGENT): { total_qualifying_cents: bigint; event: DomainEvent; atr_manifest: Record<string, readonly AtrRecordType[]> } {
  nonEmpty(r.application_id, "application_id"); if (!r.sources.length) throw new RangeError("sources are required");
  if (r.scheduled_note_date && r.windows_run_for_note_date !== r.scheduled_note_date) throw new IncomeRuleRefused("WINDOWS_NOT_RERUN", "22.3 AI design: never finalize income after a closing move without re-running the windows", `windows were run for ${r.windows_run_for_note_date ?? "no note date"}; the scheduled note date is ${r.scheduled_note_date}`);
  for (const s of r.sources) {
    if (!s.used_for_qualifying) continue;
    if (!s.formula_version) throw new RangeError(`${s.income_id}: a calculation with a versioned formula is required`);
    if (!s.evidence_document_ids.length) throw new RangeError(`${s.income_id}: evidence meeting B3-3.2-01 / B1-1-03 freshness is required`);
    if (!s.continuance_documented) throw new RangeError(`${s.income_id}: continuance must be documented where required`);
    if (s.regb_check !== "pass") throw new RangeError(`${s.income_id}: the Reg B check must be recorded as pass`);
    if (!s.atr_record_types.length) throw new RangeError(`${s.income_id}: §1026.43(c)(4) record types must be recorded`);
    if (s.transcript_discrepancy_open) throw new RangeError(`${s.income_id}: transcript discrepancies must be resolved before income.finalized (B3-3.1-02)`);
  }
  const t = totalQualifying(r.sources);
  const atr_manifest = Object.fromEntries(r.sources.map((s) => [s.income_id, s.atr_record_types]));
  const event = events.append({ type: "income.finalized", applicationId: r.application_id, actor, payload: { application_id: r.application_id, total_qualifying_cents: String(t.total_qualifying_cents), obligations_from_rental_cents: String(t.obligations_from_rental_cents), scheduled_note_date: r.scheduled_note_date,
    sources: r.sources.map((s) => ({ income_id: s.income_id, income_type: s.income_type, formula_version: s.formula_version, monthly_qualifying_cents: String(s.monthly_qualifying_cents), gross_up_cents: String(s.gross_up_cents), used_for_qualifying: s.used_for_qualifying, offset_only: s.offset_only ?? false, atr_record_types: [...s.atr_record_types] })), atr_manifest, rule_set_version: RULE_SET_VERSION } });
  return { total_qualifying_cents: t.total_qualifying_cents, event, atr_manifest };
}
/** The agent's decision record for one source (AI-design "Decision record"). */
export function decisionRecord(c: IncomeCalculation, r: { income_id: string; regb_flags: readonly RegBFlag[]; regb_check: "pass"; evidence_document_ids: readonly string[]; du_validation_outcome: DuOutcome; calculator_report_id: string | null; atr_record_types: readonly AtrRecordType[]; rationale: string; confidence: number }): Record<string, unknown> {
  return { income_id: r.income_id, formula_version: c.formula_version, inputs_cents: c.inputs, steps: c.steps, trend: c.trend, qualifying_cents: String(c.qualifying_cents), gross_up_cents: String(c.gross_up_cents), continuance: { basis: c.continuance_basis, end_date: c.continuance_end_date }, regb_flags: [...r.regb_flags], regb_check: r.regb_check,
    evidence_document_ids: [...r.evidence_document_ids], du_validation_outcome: r.du_validation_outcome, calculator_report_id: r.calculator_report_id, atr_record_types: [...r.atr_record_types], rationale: r.rationale, confidence: r.confidence, rule_set_version: RULE_SET_VERSION };
}
