/**
 * §21.3 operating rules — the companion early disclosures that ride with (or precede) the Loan Estimate: the
 * §1024.20 homeownership counseling list (ten HUD-approved agencies, eleven fields, 30-day freshness), the
 * §1026.19(g) special information booklet (Your Home Loan Toolkit, purchase only), the §1024.15 affiliated business
 * arrangement statement and referral gate, the Reg B §1002.14(a)(2) appraisal notice (ordinarily satisfied by the
 * LE's "Appraisal" block inside the Reg B window; standalone C-9 otherwise) and the §1026.35(c)(5) HPML statement it
 * satisfies, the FCRA §609(g) / Reg V §1022.74(d) credit-score notices (one per consumer, only that consumer's
 * scores, H-3 elements (A)–(I), consummation gate), the §1026.19(b) ARM program disclosure + CHARM booklet gate, the
 * GLBA §1016.4 initial privacy notice (never orally, §1016.9(d)), the retired RESPA Servicing Disclosure Statement
 * (`exempt{reverse_only}` on every forward application) and the state early-disclosure matrix (NY/NJ/FL
 * pre-application gates, AZ fee-agreement gate, TX/MA/CA at-application notices, CA §1632.5 translated LE).
 *
 * Calendars, delivery channels, receipt evidence and E-SIGN consent checks are 21.2's (`creditorCalendarFrom`,
 * `civilDate`, `consentValidFor`, `DeliveryChannel`) — one product, one vocabulary. Every companion clock runs on
 * `business_days_creditor` (rule 1). Money is bigint cents; rates are decimal strings (never floating point).
 *
 * `CompanionDisclosureService` is the process's command surface. Events it emits (spec 21.3 "Events emitted"):
 *   disclosure.companion.planned{package_id}                            disclosure.companion.exempt{rule_code, reason}
 *   counseling_list.generated{list_id, zip_used, zip_source, hud_snapshot_at, agency_count}
 *   disclosure.companion.delivered{kind, rule_code, channel} / .mailed{kind, rule_code, mailing_proof_id}
 *   disclosure.companion.issued{kind, rule_code, via∈{delivered, mailed, le}}   ← one event for every way a rule is
 *        discharged (delivered, placed in the mail, or carried on an LE inside the window); the timers satisfy on it
 *   disclosure.companion.received{kind, rule_code}   disclosure.companion.acknowledged{kind, rule_code}
 *   disclosure.companion.satisfied_by_le{rule_code, le_disclosure_id}   disclosure.companion.delivery.refused{kind, code, reason}
 *   arm.disclosures.delivered{fnma_plan_number}      score_disclosure.delivered{application_borrower_id, all_borrowers_covered}
 *   afba.disclosure.delivered{referral_id}           referral.requested{provider_party_id, service, afba_required} / referral.recorded{referral_id, afba_gate}
 *   privacy.initial_notice.delivered{channel, edition}   state_notice.delivered{code, state} / state_notice.acknowledged{code, state}
 * Bridged inbound events (emitted here until their owners land — 22.2 `credit.report.received`, 23.4
 * `compliance.hpml.determined`): `ingestCreditReport`, `ingestHpmlDetermination`.
 */
import { randomUUID } from "node:crypto";
import { type PlainDate, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { Decimal, levelPayment, monthlyInterest, ratePercent, type Cents } from "../../kernel/money/index.ts";
import type { Actor, DomainEvent, EventStore, Clock } from "../../kernel/events/index.ts";
import { type CreditorCalendarSpec, PHOENIX_CREDITOR, creditorCalendarFrom, civilDate, consentValidFor, isElectronic, isInPerson, DELIVERY_CHANNELS, type DeliveryChannel, type EsignConsent, type Provider, AGENT } from "./ops-21-2.ts";

export { AGENT };
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const isoOrThrow = (v: unknown, what: string): string => { if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new RangeError(`${what} must be an ISO instant`); return v; };

// ============================================================ vocabulary: kinds, rule codes, notice codes, timers
export type CompanionKind = "hcl" | "toolkit" | "afba" | "regb_appraisal_notice" | "credit_score_notice" | "rbp_notice" | "arm_program" | "charm" | "privacy" | "sds" | `state:${string}`;
export type CompanionStatus = "planned" | "generated" | "delivered" | "mailed" | "received" | "acknowledged" | "satisfied_by_le" | "exempt" | "superseded" | "cancelled";
export const TERMINAL_STATUSES: readonly CompanionStatus[] = ["acknowledged", "received", "satisfied_by_le", "exempt", "superseded", "cancelled"];
export type ExemptionReason = "refinance_no_toolkit" | "reverse_only" | "no_affiliate_referral" | "fixed_rate" | "not_hpml" | "state_not_applicable" | "provided_by_other_person" | "no_score";
export type RetentionClass = "regb_25m" | "respa_afba_5y" | "regz_general_2y" | "fnma_loan_file_life_plus_4y";
export type CompanionChannel = DeliveryChannel | "oral";

export const RULE_CODES = { hcl: "REGX_1024_20", toolkit: "REGZ_1026_19G", regb: "REGB_1002_14A2", hpml: "REGZ_1026_35C5", fcra: "FCRA_609G", regv: "REGV_1022_74D", arm: "REGZ_1026_19B", privacy: "GLBA_1016_4", afba: "REGX_1024_15", sds: "REGX_1024_33A" } as const;
export const NOTICE_CODES: Record<string, string> = {
  hcl: "NTC_REGX_1024_20_HCL", toolkit: "NTC_REGX_1024_6_TOOLKIT", afba: "NTC_REGX_1024_15_AFBA", regb_appraisal_notice: "NTC_REGB_1002_14_APPRAISAL_NOTICE",
  credit_score_notice: "NTC_FCRA_609G_CREDIT_SCORE", rbp_notice: "NTC_REGV_1022_74_RBP_EXCEPTION", arm_program: "NTC_REGZ_1026_19B_ARM_PROGRAM", charm: "NTC_REGZ_1026_19B_CHARM",
  privacy: "NTC_GLBA_1016_4_PRIVACY_INITIAL", sds: "NTC_REGX_1024_33A_SDS",
};
export const TIMER_CODES = {
  hcl: "REGX_1024_20_HCL_3BD", toolkit: "REGZ_1026_19G_TOOLKIT_3BD", regb: "REGB_1002_14_APPRAISAL_NOTICE_3BD", hpml: "REGZ_1026_35C5_HPML_APPRAISAL_NOTICE_3BD",
  arm_gate: "REGZ_1026_19B_ARM_DISCLOSURE_GATE", arm_3bd: "REGZ_1026_19B_ARM_DISCLOSURE_3BD", fcra: "FCRA_609G_SCORE_NOTICE_1BD", score_gate: "REGV_1022_74D_SCORE_NOTICE_CONSUMMATION_GATE",
  afba_gate: "REGX_1024_15_AFBA_REFERRAL_GATE", privacy: "SM_O23_PRIVACY_INITIAL_3BD",
} as const;
export const TOOLKIT_EDITION = "2026-08";
export const CHARM_EDITION = "2020-06";
export const PRIVACY_EDITION = "2026-01";
export const ARM_PROGRAM_TEMPLATE_VERSION = "19b-sofr-2026-10";
export const STANDALONE_REGB_LEAD_HOURS = 4;
export const RULE_SETS = { regx: "regx.2013", regb: "regb.2013", regv: "regv.subpart_h", regz: "regz.trid.2017", glba: "regp.2011", state: "state.early_disclosures.2026" } as const;

// ============================================================ rule 1: calendar and counting
/** `due_at = end_of_day(nth_business_day(anchor_date, n, creditor))`; day 0 is the anchor day in the creditor's zone; n = 0 is a same-day rule. */
export function companionDueAt(anchorIso: string, n: number, spec: CreditorCalendarSpec = PHOENIX_CREDITOR): { anchor_on: PlainDate; due_on: PlainDate; due_at: string } {
  isoOrThrow(anchorIso, "anchor"); if (!Number.isInteger(n) || n < 0) throw new RangeError("business-day count must be a non-negative integer");
  const anchor_on = civilDate(anchorIso, spec.time_zone);
  const due_on = n === 0 ? anchor_on : addBusinessDays(anchor_on, n, creditorCalendarFrom(spec));
  return { anchor_on, due_on, due_at: toIso(zonedEpochMs(due_on, "23:59", spec.time_zone)) };
}
/** The Reg B standalone notice issues at `due_at − 4h` when no LE has gone out (timer table, breach column). */
export const standaloneNoticeBy = (dueAtIso: string, hours = STANDALONE_REGB_LEAD_HOURS): string => toIso(Date.parse(dueAtIso) - hours * 3_600_000);

// ============================================================ rule 3: counseling list (§1024.20; 80 FR 22091)
export const HCL_AGENCY_COUNT = 10;
export const HCL_MAX_AGE_DAYS = 30;
export const HCL_FIELDS = ["agency_name", "phone", "street_address", "street_address_2", "city", "state", "zip", "website", "email", "services", "languages"] as const;
export type HclField = (typeof HCL_FIELDS)[number];
export const HCL_ACCOMPANYING_LANGUAGE = "The counseling agencies on this list are approved by the U.S. Department of Housing and Urban Development (HUD), and they can offer independent advice about whether a particular set of mortgage loan terms is a good fit based on your objectives and circumstances, often at little or no cost to you. This list shows you several approved agencies in your area. You can find other approved counseling agencies at the Consumer Financial Protection Bureau's (CFPB) Web site: consumerfinance.gov/mortgagehelp or by calling 1-855-411-CFPB (2372). You can also access a list of nationwide HUD-approved counseling intermediaries at http://portal.hud.gov/hudportal/HUD?src=/ohc_nint.";
export const HCL_LANGUAGE_VERSION = "80 FR 22091 (2015-04-21)";
export type ZipSource = "current_address" | "mailing_address" | "property_address_overseas";
export interface ApplicantAddresses { readonly current_address_zip5?: string | null; readonly current_address_country?: string | null; readonly mailing_address_zip5?: string | null; }
/** The applicant's current-address five-digit zip is the default; the mailing address is permitted; the property zip only when the current address has no five-digit zip (overseas). */
export function counselingZip(a: ApplicantAddresses, propertyZip5: string | null | undefined): { zip_used: string; zip_source: ZipSource } {
  const five = (z: string | null | undefined): string | null => (typeof z === "string" && /^\d{5}$/.test(z.trim()) ? z.trim() : null);
  const domestic = !a.current_address_country || a.current_address_country === "US";
  const cur = domestic ? five(a.current_address_zip5) : null;
  if (cur) return { zip_used: cur, zip_source: "current_address" };
  const mail = domestic ? five(a.mailing_address_zip5) : null;
  if (mail) return { zip_used: mail, zip_source: "mailing_address" };
  const prop = five(propertyZip5);
  if (!prop) throw new RangeError("no five-digit zip available for the counseling list (current, mailing or property address)");
  return { zip_used: prop, zip_source: "property_address_overseas" };
}
export interface HudAgency { readonly agency_name: string; readonly phone: string; readonly street_address: string; readonly street_address_2: string; readonly city: string; readonly state: string; readonly zip: string; readonly website: string; readonly email: string; readonly services: string; readonly languages: string; readonly distance_miles: string; }
export interface HudSnapshot { readonly snapshot_at: string; readonly centroid: { readonly lat: string; readonly long: string }; readonly agencies: readonly HudAgency[]; }
export interface CounselingList {
  readonly list_id: string; readonly application_id: string; readonly application_borrower_id: string | null; readonly zip_used: string; readonly zip_source: ZipSource;
  readonly centroid_lat: string; readonly centroid_long: string; readonly hud_snapshot_at: string; readonly agencies: readonly HudAgency[]; readonly accompanying_language: string; readonly accompanying_language_version: string;
  readonly generated_at: string; readonly disclosure_id: string | null; superseded_by_list_id: string | null;
}
const num = (s: string): number => { const n = Number(s); if (!Number.isFinite(n)) throw new RangeError(`distance ${s} is not numeric`); return n; };
/** Exactly ten agencies, the eleven fields each, sorted by distance from the zip centroid, the accompanying language verbatim; `hud_snapshot_at` is the "obtained" moment for the 30-day rule. */
export function generateCounselingList(i: { application_id: string; application_borrower_id?: string | null; zip_used: string; zip_source: ZipSource; hud: HudSnapshot; generated_at: string; disclosure_id?: string | null }): CounselingList {
  nonEmpty(i.application_id, "application_id"); if (!/^\d{5}$/.test(i.zip_used)) throw new RangeError("zip_used must be a five-digit zip");
  isoOrThrow(i.hud.snapshot_at, "hud.snapshot_at");
  const sorted = [...i.hud.agencies].sort((a, b) => num(a.distance_miles) - num(b.distance_miles));
  if (sorted.length < HCL_AGENCY_COUNT) throw new RangeError(`the HUD data returned ${sorted.length} agencies; the list needs ${HCL_AGENCY_COUNT} (80 FR 22091)`);
  const agencies: HudAgency[] = sorted.slice(0, HCL_AGENCY_COUNT).map((a) => ({ agency_name: a.agency_name ?? "", phone: a.phone ?? "", street_address: a.street_address ?? "", street_address_2: a.street_address_2 ?? "", city: a.city ?? "", state: a.state ?? "", zip: a.zip ?? "", website: a.website ?? "", email: a.email ?? "", services: a.services ?? "", languages: a.languages ?? "", distance_miles: a.distance_miles }));
  return { list_id: randomUUID(), application_id: i.application_id, application_borrower_id: i.application_borrower_id ?? null, zip_used: i.zip_used, zip_source: i.zip_source, centroid_lat: i.hud.centroid.lat, centroid_long: i.hud.centroid.long,
    hud_snapshot_at: i.hud.snapshot_at, agencies, accompanying_language: HCL_ACCOMPANYING_LANGUAGE, accompanying_language_version: HCL_LANGUAGE_VERSION, generated_at: i.generated_at, disclosure_id: i.disclosure_id ?? null, superseded_by_list_id: null };
}
/** Freshness at delivery: `delivered_at − hud_snapshot_at ≤ 30 calendar_days` (civil dates in the creditor's zone); Sept 5 → Oct 6 is 31 days (stale), Sept 6 → Oct 6 is 30 (fresh). */
export function counselingListFreshness(hudSnapshotAtIso: string, deliveredAtIso: string, timeZone: string): { age_days: number; fresh: boolean } {
  const age_days = daysBetween(civilDate(hudSnapshotAtIso, timeZone), civilDate(deliveredAtIso, timeZone));
  return { age_days, fresh: age_days >= 0 && age_days <= HCL_MAX_AGE_DAYS };
}
/** The list's document payload for NTC_REGX_1024_20_HCL. */
export function counselingListPayload(l: CounselingList, p: { applicant_name: string; lender_name: string; lender_nmlsr_id: string; application_id: string }): Record<string, unknown> {
  return { ...p, zip_used: l.zip_used, zip_source: l.zip_source, generated_on: civilDate(l.generated_at, "America/New_York"), hud_snapshot_at: l.hud_snapshot_at, agency_count: l.agencies.length, agencies: l.agencies.map((a, k) => ({ ...a, rank: k + 1 })), accompanying_language: l.accompanying_language, field_count: HCL_FIELDS.length };
}

// ============================================================ rule 4: Reg B appraisal notice (§1002.14(a)(2); C-9; §1026.37(m)(1)) and the HPML (c)(5) statement
export const C9_TEXT = "We may order an appraisal to determine the property's value and charge you for this appraisal. We will promptly give you a copy of any appraisal, even if your loan does not close. You can pay for an additional appraisal for your own use at your own cost.";
export interface LeOut { readonly disclosure_id: string; readonly le_version?: number; readonly delivered_at: string | null; readonly mailed_at: string | null; }
/** `le_out = min(delivered_at, mailed_at)`; an LE out on or before the Reg B `due_at` is the notice (`satisfied_by_le`). */
export function regBSatisfaction(le: LeOut | null | undefined, dueAtIso: string): { satisfied_by_le: boolean; le_out: string | null; satisfied_by_disclosure_id: string | null } {
  if (!le) return { satisfied_by_le: false, le_out: null, satisfied_by_disclosure_id: null };
  const outs = [le.delivered_at, le.mailed_at].filter((x): x is string => typeof x === "string").map((x) => Date.parse(x));
  if (!outs.length) return { satisfied_by_le: false, le_out: null, satisfied_by_disclosure_id: null };
  const le_out = toIso(Math.min(...outs));
  const ok = Date.parse(le_out) <= Date.parse(dueAtIso);
  return { satisfied_by_le: ok, le_out, satisfied_by_disclosure_id: ok ? le.disclosure_id : null };
}

// ============================================================ rule 5: Toolkit (§1026.19(g); §1024.6)
export type TransactionType = "purchase" | "limited_cash_out" | "cash_out" | "construction" | "reverse";
export function toolkitRequirement(transaction_type: string, residential_1_4: boolean = true): { required: boolean; exemption_reason: ExemptionReason | null; edition: string } {
  if (transaction_type === "reverse") return { required: false, exemption_reason: "reverse_only", edition: TOOLKIT_EDITION };
  if (transaction_type !== "purchase" || !residential_1_4) return { required: false, exemption_reason: "refinance_no_toolkit", edition: TOOLKIT_EDITION };
  return { required: true, exemption_reason: null, edition: TOOLKIT_EDITION };
}
/** English always; Spanish as a courtesy copy when the interview was in Spanish (binding documents stay English). */
export const toolkitEditions = (interview_language: string | null | undefined): readonly ("en" | "es")[] => (String(interview_language ?? "en").toLowerCase().startsWith("es") ? ["en", "es"] : ["en"]);

// ============================================================ rule 6: score notices (FCRA §609(g); Reg V §1022.74(d), §1022.75(c))
export const FCRA_609G_NOTICE_TEXT = "NOTICE TO THE HOME LOAN APPLICANT: In connection with your application for a home loan, the lender must disclose to you the score that a consumer reporting agency distributed to users and the lender used in connection with your home loan, and the key factors affecting your credit scores. The credit score is a computer generated summary calculated at the time of the request and based on information that a consumer reporting agency or lender has on file. The scores are based on data about your credit history and payment patterns. Credit scores are important because they are used to assist the lender in determining whether you will obtain a loan. They may also be used to determine what interest rate you may be offered on the mortgage. Credit scores can change over time, depending on your conduct, how your credit history and payment patterns change, and how credit scoring technologies change. Because the score is based on information in your credit history, it is very important that you review the credit-related information that is being furnished to make sure it is accurate. Credit records may vary from one company to another. If you have questions about your credit score or the credit information that is furnished to you, contact the lender or the consumer reporting agency. The lender has no part in the score determination and cannot explain to you how the score is determined, but it may be able to answer questions concerning the information contained in your credit report. If the lender has provided the address of the consumer reporting agency, and you have questions about the information contained in your credit report, contact the consumer reporting agency at the address and telephone number provided. If you have questions about the scoring, contact the consumer reporting agency at the address and telephone number provided. The consumer reporting agency plays no part in the decision to take any action on the loan application and is unable to provide you with specific reasons for the decision on a loan application. If you have questions concerning the terms of the loan, contact the lender.";
export const H3_ELEMENTS = {
  A: "A consumer report (or credit report) is a record of your credit history. It includes information about whether you pay your bills on time and how much you owe to creditors.",
  B: "A credit score is a number that takes into account information in a consumer report.",
  C: "Your credit score can affect whether you can obtain credit and what the cost of that credit will be.",
  D: "Your credit score and the key factors that adversely affected it, the range of possible scores, the date the score was created and the consumer reporting agency that provided it are shown on this notice (15 U.S.C. 1681g(g)).",
  E: "How your score compares to the scores of other consumers is shown as a distribution of scores under the same model.",
  F: "You are encouraged to verify the accuracy of the information contained in your consumer report and to check it for errors.",
  G: "Under Federal law, you have the right to obtain a free copy of your consumer report directly from the consumer reporting agency.",
  H: "You can obtain a free copy of your consumer report once a year from each of the nationwide consumer reporting agencies at www.annualcreditreport.com or by calling 1-877-322-8228.",
  I: "For more information about consumer reports and credit scores, visit the Consumer Financial Protection Bureau at www.consumerfinance.gov/learnmore.",
} as const;
export const CRA_CONTACTS: Record<string, string> = { EFX: "Equifax, P.O. Box 740241, Atlanta, GA 30374, 1-800-685-1111", EXP: "Experian, P.O. Box 2002, Allen, TX 75013, 1-888-397-3742", TU: "TransUnion, P.O. Box 1000, Chester, PA 19016, 1-800-916-8800" };
export interface ScorePayload { readonly cra: string; readonly cra_contact?: string; readonly model: string; readonly score: number; readonly range_low: number; readonly range_high: number; readonly date: PlainDate; readonly key_factors: readonly string[]; readonly inquiries_factor: boolean; readonly representative: boolean; readonly distribution?: readonly { label: string; pct: number }[] | null; }
export interface CreditReportReceived { readonly application_id: string; readonly application_borrower_id: string; readonly borrower_name: string; readonly credit_report_id: string; readonly received_at: string; readonly scores: readonly ScorePayload[]; }
export interface ScoreDisclosure { readonly score_disclosure_id: string; readonly application_id: string; readonly application_borrower_id: string; readonly borrower_name: string; readonly credit_report_id: string; readonly scores: readonly (ScorePayload & { cra_contact: string })[]; readonly score_used: ScorePayload | null; readonly rendered_document_id: string; readonly disclosure_id: string | null; delivered_at: string | null; mailed_at: string | null; readonly retention_class: "regb_25m"; }
export const MAX_KEY_FACTORS = 4;
/** One document per borrower: every score obtained for that borrower (≤ 4 key factors each, 5 when inquiries are one), the representative score flagged — never another borrower's data. */
export function scoreDisclosureFor(r: CreditReportReceived): ScoreDisclosure {
  nonEmpty(r.application_id, "application_id"); nonEmpty(r.application_borrower_id, "application_borrower_id"); nonEmpty(r.credit_report_id, "credit_report_id");
  if (!r.scores.length) throw new RangeError(`no score for borrower ${r.application_borrower_id} — record exempt{no_score}, no §609(g)/H-3 notice`);
  const scores = r.scores.map((s) => {
    const max = MAX_KEY_FACTORS + (s.inquiries_factor ? 1 : 0);
    if (s.key_factors.length > max) throw new RangeError(`${s.cra} ${s.model}: ${s.key_factors.length} key factors exceed the §609(f)(1)(C) maximum of ${max}`);
    if (s.score < s.range_low || s.score > s.range_high) throw new RangeError(`${s.cra} score ${s.score} is outside the model range ${s.range_low}–${s.range_high}`);
    return { ...s, cra_contact: s.cra_contact ?? CRA_CONTACTS[s.cra] ?? nonEmpty(s.cra_contact, `CRA contact for ${s.cra}`) };
  });
  const reps = scores.filter((s) => s.representative); if (reps.length > 1) throw new RangeError("exactly one score is the representative/applicable score");
  return { score_disclosure_id: randomUUID(), application_id: r.application_id, application_borrower_id: r.application_borrower_id, borrower_name: r.borrower_name, credit_report_id: r.credit_report_id, scores, score_used: reps[0] ?? null, rendered_document_id: `DOC-SCORE-${r.application_borrower_id}-${r.credit_report_id}`, disclosure_id: null, delivered_at: null, mailed_at: null, retention_class: "regb_25m" };
}
/** The §609(g) + H-3 document payload (NTC_FCRA_609G_CREDIT_SCORE / NTC_REGV_1022_74_RBP_EXCEPTION rendered on/with it). */
export function scoreDisclosurePayload(d: ScoreDisclosure, lender: { name: string; nmlsr_id: string; address: string }): Record<string, unknown> {
  const used = d.score_used ?? d.scores[0]!;
  return { borrower_name: d.borrower_name, application_borrower_id: d.application_borrower_id, lender_name: lender.name, lender_nmlsr_id: lender.nmlsr_id, lender_address: lender.address, notice_text: FCRA_609G_NOTICE_TEXT,
    scores: d.scores.map((s) => ({ cra: s.cra, cra_contact: s.cra_contact, model: s.model, score: s.score, range: `${s.range_low}-${s.range_high}`, date: s.date, key_factors: [...s.key_factors], key_factor_count: s.key_factors.length, inquiries_factor: s.inquiries_factor, representative: s.representative })),
    score_used: used.score, score_used_cra: used.cra, score_used_model: used.model, score_used_range: `${used.range_low}-${used.range_high}`, score_used_date: used.date,
    h3_a: H3_ELEMENTS.A, h3_b: H3_ELEMENTS.B, h3_c: H3_ELEMENTS.C, h3_d: H3_ELEMENTS.D, h3_e: H3_ELEMENTS.E, h3_f: H3_ELEMENTS.F, h3_g: H3_ELEMENTS.G, h3_h: H3_ELEMENTS.H, h3_i: H3_ELEMENTS.I,
    distribution_bars: used.distribution ? used.distribution.map((b) => ({ label: b.label, pct: b.pct })) : [], distribution_bar_count: used.distribution?.length ?? 0,
    distribution_statement: used.distribution ? "" : `Your score of ${used.score} on the ${used.range_low}–${used.range_high} ${used.model} scale ranks above approximately ${Math.round(100 * (used.score - used.range_low) / (used.range_high - used.range_low))} percent of consumers scored under this model (statement provided because the consumer reporting agency supplied no distribution data).` };
}
export interface ScoreGateFacts { readonly scored_borrowers: readonly string[]; readonly covered_borrowers: readonly string[]; }
/** REGV_1022_74D_SCORE_NOTICE_CONSUMMATION_GATE: open when every borrower with a score has a delivered or mailed notice. */
export function scoreNoticeGate(f: ScoreGateFacts): { open: boolean; reason?: string } {
  const missing = f.scored_borrowers.filter((b) => !f.covered_borrowers.includes(b));
  return missing.length ? { open: false, reason: `§1022.74(d)(3): score notice not delivered before consummation for borrower(s) ${missing.join(", ")}` } : { open: true };
}

// ============================================================ rule 7: ARM program disclosure (§1026.19(b)(2)) and the CHARM booklet (§1026.19(b)(1))
export const SOFR_INDEX_TEXT = "30-day Average SOFR as published by the Federal Reserve Bank of New York";
export const SOFR_SOURCE_TEXT = "Federal Reserve Bank of New York, https://www.newyorkfed.org/markets/reference-rates/sofr-averages-and-index";
export const ARM_LOOKBACK_DAYS = 45;
export const ARM_ROUNDING = "nearest one-eighth of one percent";
export const ARM_ILLUSTRATION_LOAN_CENTS: Cents = 1_000_000n;   // $10,000 (§1026.19(b)(2)(viii))
export interface ArmProgram { readonly fnma_plan_number: "4926" | "4927" | "4928" | "4929"; readonly label: string; readonly initial_fixed_months: number; readonly adjustment_months: 6; readonly caps: { readonly first: string; readonly subsequent: string; readonly lifetime: string }; }
export const ARM_PLANS: Record<string, ArmProgram> = {
  "4926": { fnma_plan_number: "4926", label: "3/6 SOFR", initial_fixed_months: 36, adjustment_months: 6, caps: { first: "2", subsequent: "1", lifetime: "5" } },
  "4927": { fnma_plan_number: "4927", label: "5/6 SOFR", initial_fixed_months: 60, adjustment_months: 6, caps: { first: "2", subsequent: "1", lifetime: "5" } },
  "4928": { fnma_plan_number: "4928", label: "7/6 SOFR", initial_fixed_months: 84, adjustment_months: 6, caps: { first: "5", subsequent: "1", lifetime: "5" } },
  "4929": { fnma_plan_number: "4929", label: "10/6 SOFR", initial_fixed_months: 120, adjustment_months: 6, caps: { first: "5", subsequent: "1", lifetime: "5" } },
};
export function armPlan(fnma_plan_number: string): ArmProgram { const p = ARM_PLANS[fnma_plan_number]; if (!p) throw new RangeError(`no Fannie Mae SOFR ARM plan ${fnma_plan_number} (4926/4927/4928/4929)`); return p; }
export interface ArmIllustration { readonly fnma_plan_number: string; readonly as_of: string; readonly loan_cents: Cents; readonly term_months: number; readonly initial_rate_pct: string; readonly initial_payment_cents: Cents; readonly max_rate_pct: string; readonly max_payment_cents: Cents; readonly months_to_max_rate: number; readonly balance_at_max_cents: Cents; readonly rate_path: readonly { from_month: number; rate_pct: string; payment_cents: Cents }[]; }
const pctAdd = (a: string, b: string): string => Decimal.parse(a).add(Decimal.parse(b)).toFixed(3);
/** (viii)(B): the $10,000 loan at the plan's initial rate as of the identified month, the maximum rate and payment assuming the maximum periodic increases (first cap, then subsequent caps, to the lifetime cap); payments re-amortize on the then-remaining balance over the remaining term. */
export function armIllustration(fnma_plan_number: string, initial_rate_pct: string, as_of: string, term_months = 360): ArmIllustration {
  const plan = armPlan(fnma_plan_number); if (!/^\d{4}-\d{2}$/.test(as_of)) throw new RangeError("as_of must be YYYY-MM (identified month and year)");
  const max_rate_pct = pctAdd(initial_rate_pct, plan.caps.lifetime);
  const initial_payment_cents = levelPayment(ARM_ILLUSTRATION_LOAN_CENTS, ratePercent(initial_rate_pct), term_months);
  let bal = ARM_ILLUSTRATION_LOAN_CENTS, rate = initial_rate_pct, payment = initial_payment_cents, changes = 0, months_to_max = 0;
  const rate_path: { from_month: number; rate_pct: string; payment_cents: Cents }[] = [{ from_month: 1, rate_pct: rate, payment_cents: payment }];
  let max_payment_cents = payment, balance_at_max = bal;
  for (let m = 1; m <= term_months; m++) {
    if (m > plan.initial_fixed_months && (m - plan.initial_fixed_months - 1) % plan.adjustment_months === 0 && Decimal.parse(rate).cmp(Decimal.parse(max_rate_pct)) < 0) {
      const cap = changes === 0 ? plan.caps.first : plan.caps.subsequent; changes++;
      const next = pctAdd(rate, cap); rate = Decimal.parse(next).cmp(Decimal.parse(max_rate_pct)) > 0 ? max_rate_pct : next;
      payment = levelPayment(bal, ratePercent(rate), term_months - m + 1);
      rate_path.push({ from_month: m, rate_pct: rate, payment_cents: payment });
      if (rate === max_rate_pct && months_to_max === 0) { months_to_max = m - 1; max_payment_cents = payment; balance_at_max = bal; }
    }
    const i = monthlyInterest(bal, ratePercent(rate)); bal = bal - (payment - i); if (bal < 0n) bal = 0n;
  }
  return { fnma_plan_number, as_of, loan_cents: ARM_ILLUSTRATION_LOAN_CENTS, term_months, initial_rate_pct, initial_payment_cents, max_rate_pct, max_payment_cents, months_to_max_rate: months_to_max, balance_at_max_cents: balance_at_max, rate_path };
}
export interface ArmProgramDisclosure { readonly fnma_plan_number: string; readonly label: string; readonly template_version: string; readonly index: string; readonly index_source: string; readonly lookback_days: number; readonly caps: ArmProgram["caps"]; readonly rounding: string; readonly illustration: ArmIllustration; readonly content_items: readonly { item: string; text: string }[]; readonly consumer_specific_rate: null; }
/** The twelve §1026.19(b)(2)(i)–(xii) content items for one plan — program-level information only, never a consumer-specific rate (SAFE Act App. A (b)(2)(i)). */
export function armProgramDisclosure(fnma_plan_number: string, illustration: ArmIllustration, o: { discounted?: boolean } = {}): ArmProgramDisclosure {
  const p = armPlan(fnma_plan_number); const c = p.caps; const ill = illustration; const yrs = p.initial_fixed_months / 12;
  const content_items = [
    { item: "i", text: "The interest rate and your monthly payment can change during the life of the loan; the loan term does not change." },
    { item: "ii", text: `Index: ${SOFR_INDEX_TEXT}. Source of information about the index: ${SOFR_SOURCE_TEXT}.` },
    { item: "iii", text: `Your new interest rate is the index value most recently available ${ARM_LOOKBACK_DAYS} days before the interest change date plus the margin, rounded to the ${ARM_ROUNDING}, subject to the caps below; your payment is then recalculated to repay the remaining balance over the remaining term.` },
    { item: "iv", text: "Ask us about the current margin value and the current interest rate for this program." },
    { item: "v", text: o.discounted ? "The initial interest rate is discounted; ask us about the amount of the interest rate discount." : "The initial interest rate may be discounted or may include a premium; if it is discounted, ask us about the amount of the discount." },
    { item: "vi", text: `The interest rate is fixed for the first ${yrs} years (${p.initial_fixed_months} months) and can change every ${p.adjustment_months} months after that; the payment changes with each rate change.` },
    { item: "vii", text: `Caps: the first change is limited to ${c.first} percentage points, each later change to ${c.subsequent} percentage point(s), and the rate can never be more than ${c.lifetime} percentage points above the initial rate (lifetime cap applies to increases only). No negative amortization; no interest rate carryover; the outstanding balance never increases.` },
    { item: "viii", text: `Illustration on a $10,000 loan originated at the initial rate of ${ill.initial_rate_pct}% as of ${ill.as_of}: initial monthly principal and interest ${fmt(ill.initial_payment_cents)}; maximum interest rate ${ill.max_rate_pct}%, which could be reached after ${ill.months_to_max_rate} months, with a maximum monthly payment of ${fmt(ill.max_payment_cents)}. The periodic payment may increase or decrease substantially depending on changes in the rate.` },
    { item: "ix", text: "To estimate your payment for the amount you want to borrow, divide your loan amount by $10,000 and multiply by the payments shown in the illustration." },
    { item: "x", text: "This loan program does not contain a demand feature." },
    { item: "xi", text: "Before the first payment at a new rate we will send a notice showing the new and old rates and payments, the index value and margin used, the date the new payment is due and how your loan balance is affected; the first-adjustment notice arrives 210 to 240 days before the first new payment and later notices 60 to 120 days before each new payment (12 CFR 1026.20(c) and (d))." },
    { item: "xii", text: "Disclosure forms are available for our other variable-rate loan programs (3/6, 5/6, 7/6 and 10/6 SOFR)." },
  ];
  return { fnma_plan_number, label: p.label, template_version: ARM_PROGRAM_TEMPLATE_VERSION, index: SOFR_INDEX_TEXT, index_source: SOFR_SOURCE_TEXT, lookback_days: ARM_LOOKBACK_DAYS, caps: c, rounding: ARM_ROUNDING, illustration: ill, content_items, consumer_specific_rate: null };
}
function fmt(c: Cents): string { const neg = c < 0n; const a = neg ? -c : c; const d = a / 100n, r = a % 100n; return `${neg ? "-" : ""}$${d.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${r.toString().padStart(2, "0")}`; }
export const formatCentsUsd = fmt;
export type ArmChannel = "electronic" | "telephone" | "in_person";
/** 21.1's intake channels mapped to the §1026.19(b) channel vocabulary (`electronic` = web/chat app; `telephone` = voice). */
export function armChannelFrom(intakeChannel: string): ArmChannel { switch (intakeChannel) { case "voice": case "telephone": return "telephone"; case "in_person": case "human_agent": return "in_person"; default: return "electronic"; } }
export interface ArmGateFacts { readonly arm_interest_recorded: boolean; readonly charm_out_at?: string | null; readonly program_out_at?: string | null; readonly fnma_plan_number?: string | null; }
/** REGZ_1026_19B_ARM_DISCLOSURE_GATE: closed from the first expression of interest until both the CHARM booklet and the program disclosure for that plan are delivered (or placed in the mail). */
export function armDisclosureGate(f: ArmGateFacts): { open: boolean; reason?: string } {
  if (!f.arm_interest_recorded) return { open: true };
  const missing = [...(f.charm_out_at ? [] : ["NTC_REGZ_1026_19B_CHARM"]), ...(f.program_out_at ? [] : [`NTC_REGZ_1026_19B_ARM_PROGRAM{${f.fnma_plan_number ?? "plan"}}`])];
  return missing.length ? { open: false, reason: `§1026.19(b): ${missing.join(" and ")} not yet delivered — no application form, non-refundable fee or ARM Loan Estimate before delivery` } : { open: true };
}

// ============================================================ rule 8: AfBA (12 U.S.C. 2602(7)–(8); §1024.15)
export type AffiliateRelation = "affiliate" | "ownership_gt_1pct" | "associate";
export interface AffiliateRelationship { readonly id?: string; readonly owner_party_id: string; readonly provider_party_id: string; readonly provider_name: string; readonly relationship: AffiliateRelation; readonly ownership_pct: string | null; readonly services: readonly string[]; readonly charge_range: Readonly<Record<string, { low_cents: Cents; high_cents: Cents }>>; readonly effective_from: PlainDate; readonly effective_to?: PlainDate | null; }
export const REQUIRED_USE_SERVICES: readonly string[] = ["attorney", "credit_reporting_agency", "appraiser"];
/** `afba_required = ∃ affiliate_relationships(owner ∈ {partner, SM} ∪ associates, provider)` effective on the referral date; > 1 % ownership counts (§2602(7)(A)). */
export function afbaRelationship(rels: readonly AffiliateRelationship[], referringPartyIds: readonly string[], providerPartyId: string, on: PlainDate): AffiliateRelationship | null {
  return rels.find((r) => referringPartyIds.includes(r.owner_party_id) && r.provider_party_id === providerPartyId && r.effective_from <= on && (!r.effective_to || r.effective_to >= on)
    && (r.relationship !== "ownership_gt_1pct" || (r.ownership_pct !== null && Decimal.parse(r.ownership_pct).cmp(Decimal.ONE) > 0))) ?? null;
}
/** §1024.15(b)(2): required use only of an attorney, credit reporting agency or real estate appraiser. */
export function validateRequiredUse(service: string, required_use: boolean): void {
  if (required_use && !REQUIRED_USE_SERVICES.includes(service)) throw new RangeError(`§1024.15(b)(2): required use of an affiliated ${service} provider is not permitted (only ${REQUIRED_USE_SERVICES.join("/")})`);
}
/** The provider list (21.2) marks every affiliated provider so the tolerance engine treats its charges as zero-tolerance. */
export function markAffiliates(providers: readonly Provider[], rels: readonly AffiliateRelationship[], ownerPartyIds: readonly string[], on: PlainDate): Provider[] {
  return providers.map((p) => ({ ...p, affiliate: p.affiliate || afbaRelationship(rels, ownerPartyIds, p.party_id, on) !== null }));
}
export interface AfbaGateFacts { readonly afba_required: boolean; readonly disclosure_out_at?: string | null; readonly referred_at: string; readonly required_provider?: boolean; readonly application_received_at?: string | null; }
/** REGX_1024_15_AFBA_REFERRAL_GATE: open when the Appendix D statement went out no later than the referral (or the application, for a required provider). */
export function afbaReferralGate(f: AfbaGateFacts): { open: boolean; reason?: string } {
  if (!f.afba_required) return { open: true };
  if (!f.disclosure_out_at) return { open: false, reason: "§1024.15(b)(1): the Affiliated Business Arrangement Disclosure Statement has not been provided" };
  const bound = f.required_provider && f.application_received_at ? f.application_received_at : f.referred_at;
  return Date.parse(f.disclosure_out_at) <= Date.parse(bound) ? { open: true } : { open: false, reason: `§1024.15(b)(1): the AfBA statement (${f.disclosure_out_at}) must be provided no later than the ${f.required_provider ? "time of loan application" : "time of the referral"} (${bound})` };
}
export interface Referral { readonly referral_id: string; readonly application_id: string; readonly referring_party_id: string; readonly provider_party_id: string; readonly provider_name: string; readonly service: string; readonly referred_at: string; readonly required_use: boolean; readonly afba_required: boolean; afba_disclosure_id: string | null; readonly source_process: string; recorded: boolean; }
export function afbaStatementPayload(rel: AffiliateRelationship, p: { referring_party_name: string; applicant_name: string; service: string; on: PlainDate; lender_name: string }): Record<string, unknown> {
  const cr = rel.charge_range[p.service] ?? Object.values(rel.charge_range)[0] ?? { low_cents: 0n, high_cents: 0n };
  const nature = rel.relationship === "ownership_gt_1pct" ? `${p.referring_party_name} has a ${rel.ownership_pct}% ownership interest in ${rel.provider_name}` : rel.relationship === "affiliate" ? `${rel.provider_name} is an affiliate of ${p.referring_party_name}` : `an associate of ${p.referring_party_name} has a financial relationship with ${rel.provider_name}`;
  return { ...p, provider_name: rel.provider_name, relationship: rel.relationship, ownership_pct: rel.ownership_pct ?? "", nature_of_relationship: nature, charge_low_cents: cr.low_cents, charge_high_cents: cr.high_cents, referring_party_name: p.referring_party_name, required_use: REQUIRED_USE_SERVICES.includes(p.service) };
}

// ============================================================ rule 9: privacy (§1016.4; §1016.9)
export const ORAL_DELIVERY_REASON = "12 CFR 1016.9(d): a privacy notice may not be provided solely by orally explaining it, in person or over the telephone";

// ============================================================ rule 10: state matrix (jurisdiction_rules.early_disclosures; 31.1 maintains, 21.3 executes)
export type StateTrigger = "pre_application" | "at_application" | "written_application_3bd" | "before_any_fee" | "language_negotiated";
export type StateAcknowledgment = "none" | "signature_or_confirm" | "written_ack";
export type Confidence = "verified" | "partially_verified" | "unverified";
export interface StateEarlyDisclosureRule { readonly state: string; readonly rule_code: string; readonly trigger: StateTrigger; readonly armed_on: "application.started" | "application.received" | "application.trid_received"; readonly applies_by: "property_state"; readonly notice_code: string; readonly acknowledgment: StateAcknowledgment; readonly blocking: boolean; readonly timer_code: string; readonly blocks: readonly ("application.received" | "impose_fee")[]; readonly languages?: readonly string[]; readonly confidence: Confidence; readonly asset_ref: string; }
export const STATE_EARLY_DISCLOSURES: readonly StateEarlyDisclosureRule[] = [
  { state: "NY", rule_code: "NY_3NYCRR_38_3", armed_on: "application.started", trigger: "pre_application", applies_by: "property_state", notice_code: "NTC_NY_3NYCRR_38_3_PREAPP_DISCLOSURE", acknowledgment: "signature_or_confirm", blocking: true, timer_code: "NY_3NYCRR_38_3_PREAPP_DISCLOSURE_GATE", blocks: ["application.received", "impose_fee"], confidence: "partially_verified", asset_ref: "3 NYCRR 38.3 pre-application disclosure" },
  { state: "NJ", rule_code: "NJ_3_1_16_3", armed_on: "application.started", trigger: "before_any_fee", applies_by: "property_state", notice_code: "NTC_NJ_3_1_16_3_APPLICATION_DISCLOSURE", acknowledgment: "written_ack", blocking: true, timer_code: "NJ_3_1_16_3_FEE_DISCLOSURE_GATE", blocks: ["impose_fee"], confidence: "partially_verified", asset_ref: "N.J.A.C. 3:1-16.3 application disclosure" },
  { state: "MA", rule_code: "MA_184_17B", armed_on: "application.received", trigger: "at_application", applies_by: "property_state", notice_code: "NTC_MA_MGL_184_17B_ATTORNEY_STATEMENT", acknowledgment: "none", blocking: false, timer_code: "MA_MGL_184_17B_ATTORNEY_STATEMENT_AT_APPLICATION", blocks: [], confidence: "verified", asset_ref: "M.G.L. c. 184 §17B statements (2-point-larger type)" },
  { state: "TX", rule_code: "TX_7TAC_57_200", armed_on: "application.received", trigger: "at_application", applies_by: "property_state", notice_code: "NTC_TX_7TAC_57_200_SML_NOTICE", acknowledgment: "none", blocking: false, timer_code: "TX_7TAC_57_200_SML_NOTICE_AT_APPLICATION", blocks: [], confidence: "partially_verified", asset_ref: "SML prescribed form (sml.texas.gov)" },
  { state: "CA", rule_code: "CA_21CCR_7114", armed_on: "application.received", trigger: "at_application", applies_by: "property_state", notice_code: "NTC_CA_21CCR_7114_FAIR_LENDING_NOTICE", acknowledgment: "signature_or_confirm", blocking: false, timer_code: "CA_21CCR_7114_FAIR_LENDING_NOTICE_AT_APPLICATION", blocks: [], confidence: "partially_verified", asset_ref: "21 CCR §7114 Fair Lending Notice (DFPI)" },
  { state: "CA", rule_code: "CA_CIV_1632_5", armed_on: "application.trid_received", trigger: "language_negotiated", applies_by: "property_state", notice_code: "NTC_CA_CIV_1632_5_TRANSLATED_LE", acknowledgment: "none", blocking: false, timer_code: "CA_CIV_1632_5_TRANSLATED_LE_3BD", blocks: [], languages: ["es", "zh", "tl", "vi", "ko"], confidence: "partially_verified", asset_ref: "DFPI translated Loan Estimate forms" },
  { state: "AZ", rule_code: "AZ_ARS_6_946C", armed_on: "application.received", trigger: "before_any_fee", applies_by: "property_state", notice_code: "NTC_AZ_ARS_6_946C_FEE_AGREEMENT", acknowledgment: "signature_or_confirm", blocking: true, timer_code: "AZ_ARS_6_946C_FEE_AGREEMENT_GATE", blocks: ["impose_fee"], confidence: "verified", asset_ref: "A.R.S. §6-946(C) written fee agreement" },
  { state: "FL", rule_code: "FL_69B_124_013", armed_on: "application.started", trigger: "pre_application", applies_by: "property_state", notice_code: "NTC_FL_69B_124_013_ANTI_COERCION", acknowledgment: "signature_or_confirm", blocking: true, timer_code: "FL_69B_124_013_ANTI_COERCION_AT_APPLICATION", blocks: ["application.received", "impose_fee"], confidence: "verified", asset_ref: "Fla. Admin. Code R. 69B-124.013 statement of anti-coercion" },
];
/** States reviewed with no early-disclosure duty identified (worked example 2: Ohio → `state_not_applicable`). */
export const STATES_NO_EARLY_DISCLOSURE: Readonly<Record<string, Confidence>> = { OH: "partially_verified" };
export const TRANSLATED_LE_LANGUAGES: readonly string[] = ["es", "zh", "tl", "vi", "ko"];
export const languageCode = (interview_language: string | null | undefined): string => String(interview_language ?? "en").toLowerCase().slice(0, 2);
export interface StateMatrixResult { readonly state: string | null; readonly rows: readonly StateEarlyDisclosureRule[]; readonly pre_application_gates: readonly StateEarlyDisclosureRule[]; readonly confidence: Confidence; readonly federal_only: boolean; }
/** `applies_by='property_state'`; unlisted states default to "federal notices only" flagged `unverified` for compliance-sentinel's weekly report. */
export function evaluateStateMatrix(i: { property_state: string | null | undefined; interview_language?: string | null; rules?: readonly StateEarlyDisclosureRule[] }): StateMatrixResult {
  const state = i.property_state ? i.property_state.toUpperCase() : null;
  const rules = (i.rules ?? STATE_EARLY_DISCLOSURES).filter((r) => r.state === state && (!r.languages || r.languages.includes(languageCode(i.interview_language))));
  const known = (i.rules ?? STATE_EARLY_DISCLOSURES).some((r) => r.state === state) || (state !== null && state in STATES_NO_EARLY_DISCLOSURE);
  const confidence: Confidence = !state ? "unverified" : rules.length ? (rules.every((r) => r.confidence === "verified") ? "verified" : "partially_verified") : known ? STATES_NO_EARLY_DISCLOSURE[state] ?? "partially_verified" : "unverified";
  return { state, rows: rules, pre_application_gates: rules.filter((r) => r.trigger === "pre_application" || (r.blocking && r.trigger === "before_any_fee" && r.blocks.includes("application.received"))), confidence, federal_only: rules.length === 0 };
}
export interface StateGateFacts { readonly property_state?: string | null; readonly acknowledged_at?: string | null; readonly state: string; readonly rule_code: string; }
/** NY/NJ/AZ/FL gates: open for any other property state; otherwise only once the borrower's acknowledgment (e-signature, confirm button or signed copy) exists. */
export function stateAcknowledgmentGate(f: StateGateFacts): { open: boolean; reason?: string } {
  if ((f.property_state ?? "").toUpperCase() !== f.state) return { open: true };
  return f.acknowledged_at ? { open: true } : { open: false, reason: `${f.rule_code}: the ${f.state} disclosure has not been acknowledged by the borrower — the application cannot be taken and no fee may be imposed until it is` };
}

// ============================================================ rule 11: SDS (§1024.33(a) — reverse mortgages only)
export const SDS_SCOPE = "reverse_only";

// ============================================================ the companion plan (state machine, timers, evidence)
export interface CompanionRow {
  readonly disclosure_id: string; readonly application_id: string; readonly application_borrower_id: string | null; readonly kind: CompanionKind; readonly rule_code: string; readonly notice_code: string | null; readonly timer_code: string | null;
  readonly anchor_event: string; readonly anchor_at: string; readonly due_at: string | null; readonly calendar_code: "creditor"; readonly required: boolean; readonly exemption_reason: ExemptionReason | null;
  status: CompanionStatus; satisfied_by_disclosure_id: string | null; asset_version: string | null; language_edition: string | null; readonly acknowledgment_required: boolean; acknowledged_at: string | null; acknowledgment_evidence_id: string | null;
  generated_at: string | null; data_snapshot_id: string | null; rendered_document_id: string | null; delivery_channel: DeliveryChannel | null; delivered_at: string | null; mailed_at: string | null; mailing_proof_id: string | null; esign_consent_id: string | null; received_at: string | null;
  standalone_required: boolean; standalone_issue_by: string | null; oral_explanation_at: string | null; cancelled_reason: string | null; superseded_by_id: string | null; le_version: number | null; readonly retention_class: RetentionClass; readonly references: Record<string, unknown>;
}
export interface EarlyDisclosurePackage { readonly package_id: string; readonly application_id: string; readonly assembled_at: string; items: { disclosure_id: string; kind: CompanionKind; rule_code: string; required: boolean; satisfied_by: string | null }[]; status: "assembling" | "delivered" | "complete"; le_disclosure_id: string | null; delivered_at: string | null; }
export interface Borrower { readonly id: string; readonly name: string; readonly current_address_zip5?: string | null; readonly current_address_country?: string | null; readonly mailing_address_zip5?: string | null; readonly primary?: boolean; }
export interface PlanInput {
  readonly application_id: string; readonly application_received_at: string; readonly transaction_type: string; readonly property_state?: string | null; readonly property_zip5?: string | null; readonly interview_language?: string | null;
  readonly borrowers: readonly Borrower[]; readonly first_lien_dwelling?: boolean; readonly le_servicing_intent?: "service"; readonly arm_interest?: boolean; readonly privacy_edition?: string;
}
export class CompanionRefused extends Error { readonly code: string; readonly reason: string; constructor(code: string, reason: string) { super(`${code}: ${reason}`); this.name = "CompanionRefused"; this.code = code; this.reason = reason; } }
export class CompanionGateClosed extends Error { readonly code: string; readonly reason: string; constructor(code: string, reason: string) { super(`${code}: ${reason}`); this.name = "CompanionGateClosed"; this.code = code; this.reason = reason; } }
interface EscalationOpener { open(input: { kind: "sev1" | "sev2" | "sev3" | "human_agent" | "licensed_specialist" | "officer"; applicationId?: string; severity?: string; ownerRole?: string; payload?: Record<string, unknown> }, by: Actor): { id: string }; }
interface TimerOps { byCode(code: string): readonly { id: string; code: string; status: string; applicationId?: string; subject: { kind: string; id: string } }[]; cancel(id: string, reason: string, actor?: Actor): void; }
export interface CompanionServiceDeps { readonly events: EventStore; readonly clock: Clock; readonly escalations?: EscalationOpener; readonly calendar?: CreditorCalendarSpec; readonly timers?: TimerOps; readonly affiliate_relationships?: readonly AffiliateRelationship[]; readonly referring_party_ids?: readonly string[]; }
interface AppState {
  application_received_at: string | null; trid_received_at: string | null; transaction_type: string | null; property_state: string | null; property_zip5: string | null; interview_language: string | null; borrowers: Borrower[];
  le: LeOut | null; arm: { fnma_plan_number: string; channel: ArmChannel; recorded_at: string; gate_opened_at: string | null } | null; scores: Map<string, ScoreDisclosure>; referrals: Referral[]; fee_gate_checks: CompanionFeeGateCheck[]; package: EarlyDisclosurePackage | null; started_at: string | null;
}
export interface CompanionFeeGateCheck { readonly check_id: string; readonly application_id: string; readonly command: string; readonly fee_kind: string | null; readonly amount_cents: Cents | null; readonly checked_at: string; readonly gates: readonly { code: string; result: "open" | "closed" | "not_applicable"; reason: string | null }[]; readonly result: "open" | "closed"; }
const GATE_CODES = ["REGZ_1026_19B_ARM_DISCLOSURE_GATE", "REGV_1022_74D_SCORE_NOTICE_CONSUMMATION_GATE", "REGX_1024_15_AFBA_REFERRAL_GATE", "NY_3NYCRR_38_3_PREAPP_DISCLOSURE_GATE", "NJ_3_1_16_3_FEE_DISCLOSURE_GATE", "AZ_ARS_6_946C_FEE_AGREEMENT_GATE", "FL_69B_124_013_ANTI_COERCION_AT_APPLICATION"] as const;
export type CompanionGateCode = (typeof GATE_CODES)[number];
export const FEE_GATE_CODES: readonly CompanionGateCode[] = ["REGZ_1026_19B_ARM_DISCLOSURE_GATE", "NY_3NYCRR_38_3_PREAPP_DISCLOSURE_GATE", "NJ_3_1_16_3_FEE_DISCLOSURE_GATE", "AZ_ARS_6_946C_FEE_AGREEMENT_GATE", "FL_69B_124_013_ANTI_COERCION_AT_APPLICATION"];
export const APPLICATION_RECEIVED_GATE_CODES: readonly CompanionGateCode[] = ["NY_3NYCRR_38_3_PREAPP_DISCLOSURE_GATE", "FL_69B_124_013_ANTI_COERCION_AT_APPLICATION"];

export class CompanionDisclosureService {
  private readonly events: EventStore; private readonly clock: Clock; private readonly esc: EscalationOpener; readonly calendar: CreditorCalendarSpec; private readonly timers: TimerOps | null;
  private readonly rels: readonly AffiliateRelationship[]; private readonly referringParties: readonly string[];
  private readonly rows = new Map<string, CompanionRow>();
  private readonly apps = new Map<string, AppState>();
  readonly counseling_lists: CounselingList[] = [];
  constructor(deps: CompanionServiceDeps) {
    this.events = deps.events; this.clock = deps.clock; this.calendar = deps.calendar ?? PHOENIX_CREDITOR; this.timers = deps.timers ?? null; this.rels = deps.affiliate_relationships ?? []; this.referringParties = deps.referring_party_ids ?? ["partner", "sm"];
    this.esc = deps.escalations ?? { open: (input, by) => { const id = `ESC-${this.events.all().length + 1}`; this.events.append({ type: "escalation.created", applicationId: input.applicationId ?? "", actor: by, payload: { escalation_id: id, kind: input.kind, owner_role: input.ownerRole ?? input.kind, severity: input.severity ?? null, ...(input.payload ?? {}) } }); return { id }; } };
  }
  private append(type: string, applicationId: string, payload: Record<string, unknown>, occurredAt?: string, actor: Actor = AGENT): DomainEvent {
    return this.events.append({ type, applicationId, aggregate: { kind: "application", id: applicationId }, actor, payload: { application_id: applicationId, ...payload }, ...(occurredAt ? { occurredAt } : {}) });
  }
  private app(applicationId: string): AppState {
    let a = this.apps.get(applicationId);
    if (!a) { a = { application_received_at: null, trid_received_at: null, transaction_type: null, property_state: null, property_zip5: null, interview_language: null, borrowers: [], le: null, arm: null, scores: new Map(), referrals: [], fee_gate_checks: [], package: null, started_at: null }; this.apps.set(applicationId, a); }
    return a;
  }
  get(disclosureId: string): CompanionRow { const r = this.rows.get(disclosureId); if (!r) throw new RangeError(`no companion disclosure ${disclosureId}`); return r; }
  rowsFor(applicationId: string): readonly CompanionRow[] { return [...this.rows.values()].filter((r) => r.application_id === applicationId); }
  find(applicationId: string, q: { kind?: CompanionKind; rule_code?: string; application_borrower_id?: string | null; le_version?: number; open_only?: boolean }): CompanionRow | undefined {
    return this.rowsFor(applicationId).filter((r) => (!q.kind || r.kind === q.kind) && (!q.rule_code || r.rule_code === q.rule_code) && (q.application_borrower_id === undefined || r.application_borrower_id === q.application_borrower_id) && (q.le_version === undefined || r.le_version === q.le_version) && (!q.open_only || !TERMINAL_STATUSES.includes(r.status))).at(-1);
  }
  package(applicationId: string): EarlyDisclosurePackage { const p = this.app(applicationId).package; if (!p) throw new RangeError(`no companion package for ${applicationId} — planCompanionPackage not run`); return p; }
  referrals(applicationId: string): readonly Referral[] { return this.app(applicationId).referrals; }
  feeGateChecks(applicationId: string): readonly CompanionFeeGateCheck[] { return this.app(applicationId).fee_gate_checks; }
  scoreDisclosures(applicationId: string): readonly ScoreDisclosure[] { return [...this.app(applicationId).scores.values()]; }

  private newRow(i: { application_id: string; kind: CompanionKind; rule_code: string; notice_code: string | null; timer_code: string | null; anchor_event: string; anchor_at: string; business_days: number | null; required: boolean; exemption_reason?: ExemptionReason | null; application_borrower_id?: string | null; acknowledgment_required?: boolean; asset_version?: string | null; language_edition?: string | null; retention_class?: RetentionClass; references?: Record<string, unknown>; le_version?: number | null; standalone_issue_by?: string | null; id_suffix?: string | null }): CompanionRow {
    const due = i.business_days === null ? null : companionDueAt(i.anchor_at, i.business_days, this.calendar).due_at;
    const row: CompanionRow = { disclosure_id: `${i.kind}:${i.rule_code}-${i.application_id}${i.application_borrower_id ? `-${i.application_borrower_id}` : ""}${i.le_version ? `-v${i.le_version}` : ""}${i.id_suffix ? `-${i.id_suffix}` : ""}`, application_id: i.application_id, application_borrower_id: i.application_borrower_id ?? null, kind: i.kind, rule_code: i.rule_code, notice_code: i.notice_code, timer_code: i.timer_code,
      anchor_event: i.anchor_event, anchor_at: i.anchor_at, due_at: due, calendar_code: "creditor", required: i.required, exemption_reason: i.exemption_reason ?? null, status: i.required ? "planned" : "exempt", satisfied_by_disclosure_id: null, asset_version: i.asset_version ?? null, language_edition: i.language_edition ?? null,
      acknowledgment_required: i.acknowledgment_required ?? false, acknowledged_at: null, acknowledgment_evidence_id: null, generated_at: null, data_snapshot_id: null, rendered_document_id: null, delivery_channel: null, delivered_at: null, mailed_at: null, mailing_proof_id: null, esign_consent_id: null, received_at: null,
      standalone_required: false, standalone_issue_by: i.standalone_issue_by ?? null, oral_explanation_at: null, cancelled_reason: null, superseded_by_id: null, le_version: i.le_version ?? null, retention_class: i.retention_class ?? "fnma_loan_file_life_plus_4y", references: i.references ?? {} };
    const existing = this.rows.get(row.disclosure_id);
    if (existing && !TERMINAL_STATUSES.includes(existing.status)) return existing;
    if (existing) { existing.superseded_by_id = row.disclosure_id; this.rows.delete(row.disclosure_id); this.rows.set(`${existing.disclosure_id}#${this.rows.size}`, existing); }   // a superseded/exempt row keeps its history under a re-keyed id; the live row is appended last so `find` (last match) sees it
    this.rows.set(row.disclosure_id, row);
    if (!row.required) this.append("disclosure.companion.exempt", row.application_id, { disclosure_id: row.disclosure_id, kind: row.kind, rule_code: row.rule_code, reason: row.exemption_reason }, row.anchor_at);
    const pkg = this.app(i.application_id).package; if (pkg) { pkg.items = pkg.items.filter((x) => x.disclosure_id !== row.disclosure_id); pkg.items.push({ disclosure_id: row.disclosure_id, kind: row.kind, rule_code: row.rule_code, required: row.required, satisfied_by: null }); }
    return row;
  }

  /** `application.started` (21.1) / `lead.qualified` (20.3): the pre-application state gates (NY, NJ, FL) are rows created closed before the 1003 interview. */
  onApplicationStarted(applicationId: string, s: { at: string; property_state?: string | null; interview_language?: string | null }): { rows: CompanionRow[]; matrix: StateMatrixResult } {
    nonEmpty(applicationId, "application_id"); isoOrThrow(s.at, "at");
    const a = this.app(applicationId); a.started_at = s.at; a.property_state = s.property_state ?? a.property_state; a.interview_language = s.interview_language ?? a.interview_language;
    const matrix = evaluateStateMatrix({ property_state: a.property_state, interview_language: a.interview_language });
    const rows = matrix.rows.filter((r) => r.armed_on === "application.started").map((r) => this.stateRow(applicationId, r, "application.started", s.at));
    return { rows, matrix };
  }
  private stateRow(applicationId: string, r: StateEarlyDisclosureRule, anchor_event: string, anchor_at: string, le_version: number | null = null): CompanionRow {
    const a = this.app(applicationId);
    return this.newRow({ application_id: applicationId, kind: `state:${r.state}`, rule_code: r.rule_code, notice_code: r.notice_code, timer_code: r.timer_code, anchor_event, anchor_at, business_days: r.trigger === "language_negotiated" ? (le_version && le_version > 1 ? 0 : 3) : r.blocking ? null : 0, required: true, acknowledgment_required: r.acknowledgment !== "none",
      language_edition: r.trigger === "language_negotiated" ? languageCode(a.interview_language) : "en", asset_version: r.asset_ref, references: { state: r.state, trigger: r.trigger, blocks: [...r.blocks], confidence: r.confidence, acknowledgment: r.acknowledgment, blocking: r.blocking }, le_version });
  }
  /** Rule 2/rules 3–11: on `application.received` every rule is evaluated — required rows with `due_at`, exempt rows with their reason, the SDS `exempt{reverse_only}` row, the at-application state notices and the AZ gate. */
  planCompanionPackage(i: PlanInput): { package: EarlyDisclosurePackage; rows: CompanionRow[]; matrix: StateMatrixResult } {
    nonEmpty(i.application_id, "application_id"); isoOrThrow(i.application_received_at, "application_received_at"); nonEmpty(i.transaction_type, "transaction_type");
    if (!i.borrowers.length) throw new RangeError("at least one borrower is required");
    const a = this.app(i.application_id); const at = i.application_received_at;
    a.application_received_at = at; a.transaction_type = i.transaction_type; a.property_state = i.property_state ?? a.property_state; a.property_zip5 = i.property_zip5 ?? a.property_zip5; a.interview_language = i.interview_language ?? a.interview_language; a.borrowers = [...i.borrowers];
    const pkg: EarlyDisclosurePackage = a.package ?? { package_id: `PKG-${i.application_id}`, application_id: i.application_id, assembled_at: at, items: [], status: "assembling", le_disclosure_id: null, delivered_at: null }; a.package = pkg;
    for (const r of this.rowsFor(i.application_id)) if (!pkg.items.some((x) => x.disclosure_id === r.disclosure_id)) pkg.items.push({ disclosure_id: r.disclosure_id, kind: r.kind, rule_code: r.rule_code, required: r.required, satisfied_by: null });
    const reverse = i.transaction_type === "reverse"; const base = { application_id: i.application_id, anchor_event: "application.received", anchor_at: at };
    const rows: CompanionRow[] = [];
    rows.push(this.newRow({ ...base, kind: "hcl", rule_code: RULE_CODES.hcl, notice_code: NOTICE_CODES.hcl!, timer_code: TIMER_CODES.hcl, business_days: 3, required: !reverse, exemption_reason: reverse ? "reverse_only" : null, retention_class: "regz_general_2y" }));
    rows.push(this.newRow({ ...base, kind: "regb_appraisal_notice", rule_code: RULE_CODES.regb, notice_code: NOTICE_CODES.regb_appraisal_notice!, timer_code: TIMER_CODES.regb, business_days: 3, required: i.first_lien_dwelling !== false, exemption_reason: i.first_lien_dwelling === false ? "state_not_applicable" : null, retention_class: "regb_25m", standalone_issue_by: standaloneNoticeBy(companionDueAt(at, 3, this.calendar).due_at) }));
    rows.push(this.newRow({ ...base, kind: "privacy", rule_code: RULE_CODES.privacy, notice_code: NOTICE_CODES.privacy!, timer_code: TIMER_CODES.privacy, business_days: 3, required: true, acknowledgment_required: true, asset_version: i.privacy_edition ?? PRIVACY_EDITION }));
    rows.push(this.newRow({ ...base, kind: "afba", rule_code: RULE_CODES.afba, notice_code: NOTICE_CODES.afba!, timer_code: null, business_days: null, required: false, exemption_reason: "no_affiliate_referral", retention_class: "respa_afba_5y", references: { inventory: this.rels.length } }));
    if (!a.arm) rows.push(this.newRow({ ...base, kind: "arm_program", rule_code: RULE_CODES.arm, notice_code: NOTICE_CODES.arm_program!, timer_code: null, business_days: null, required: false, exemption_reason: "fixed_rate", retention_class: "regz_general_2y" }));
    rows.push(this.newRow({ ...base, kind: "sds", rule_code: RULE_CODES.sds, notice_code: NOTICE_CODES.sds!, timer_code: null, business_days: null, required: reverse, exemption_reason: reverse ? null : "reverse_only", references: { scope: SDS_SCOPE, le_servicing_intent: i.le_servicing_intent ?? "service", servicing_statement: "LE §1026.37(m)(6): We intend to service your loan (21.2)" } }));
    const matrix = evaluateStateMatrix({ property_state: a.property_state, interview_language: a.interview_language });
    for (const r of matrix.rows) if (r.armed_on === "application.received" || (r.armed_on === "application.started" && !this.find(i.application_id, { rule_code: r.rule_code }))) rows.push(this.stateRow(i.application_id, r, r.armed_on === "application.started" ? "application.started" : "application.received", at));
    if (matrix.federal_only && matrix.state) rows.push(this.newRow({ ...base, kind: `state:${matrix.state}`, rule_code: `${matrix.state}_EARLY_DISCLOSURES`, notice_code: null, timer_code: null, business_days: null, required: false, exemption_reason: "state_not_applicable", references: { confidence: matrix.confidence } }));
    if (matrix.confidence === "unverified") this.esc.open({ kind: "sev3", applicationId: i.application_id, severity: "3", ownerRole: "compliance", payload: { reason: "jurisdiction_rules.early_disclosures: state not cleared by 31.1", state: matrix.state } }, AGENT);
    this.append("disclosure.companion.planned", i.application_id, { package_id: pkg.package_id, rules: pkg.items.map((x) => ({ rule_code: x.rule_code, required: x.required })), application_received_at: at, state: matrix.state, state_confidence: matrix.confidence }, at);
    return { package: pkg, rows, matrix };
  }
  /** `application.trid_received` (21.1): the Toolkit (purchase only, §1026.19(g)(1)(iii)) and CA §1632.5 translated LE anchor on `trid_application_date`. */
  onTridReceived(applicationId: string, t: { trid_received_at: string; transaction_type?: string; interview_language?: string | null; property_state?: string | null; residential_1_4?: boolean }): { toolkit: CompanionRow; translated_le: CompanionRow | null } {
    const a = this.app(applicationId); isoOrThrow(t.trid_received_at, "trid_received_at"); a.trid_received_at = t.trid_received_at;
    a.transaction_type = t.transaction_type ?? a.transaction_type; a.interview_language = t.interview_language ?? a.interview_language; a.property_state = t.property_state ?? a.property_state;
    const req = toolkitRequirement(nonEmpty(a.transaction_type, "transaction_type"), t.residential_1_4 ?? true);
    const toolkit = this.newRow({ application_id: applicationId, kind: "toolkit", rule_code: RULE_CODES.toolkit, notice_code: NOTICE_CODES.toolkit!, timer_code: req.required ? TIMER_CODES.toolkit : null, anchor_event: "application.trid_received", anchor_at: t.trid_received_at, business_days: req.required ? 3 : null, required: req.required, exemption_reason: req.exemption_reason, asset_version: req.edition, language_edition: toolkitEditions(a.interview_language).join("+"), retention_class: "regz_general_2y" });
    const ca = evaluateStateMatrix({ property_state: a.property_state, interview_language: a.interview_language }).rows.find((r) => r.trigger === "language_negotiated");
    const translated_le = ca ? this.stateRow(applicationId, ca, "application.trid_received", t.trid_received_at, 1) : null;
    return { toolkit, translated_le };
  }
  /** 21.5 hook: each revised LE gets a matching translated form the same day (Civ. Code §1632.5 "updated versions on material change"). */
  onLeRevised(applicationId: string, r: { le_version: number; at: string }): CompanionRow | null {
    const a = this.app(applicationId); const ca = evaluateStateMatrix({ property_state: a.property_state, interview_language: a.interview_language }).rows.find((x) => x.trigger === "language_negotiated");
    if (!ca || r.le_version < 2) return null;
    return this.stateRow(applicationId, ca, "disclosure.le.revised", r.at, r.le_version);
  }
  /** Rule 3: generate (or regenerate — the prior list is `superseded`) the counseling list from the primary applicant's zip. */
  generateCounselingList(applicationId: string, g: { hud: HudSnapshot; at: string; borrower_id?: string | null }): { list: CounselingList; row: CompanionRow } {
    const a = this.app(applicationId); const row = this.find(applicationId, { kind: "hcl" }); if (!row) throw new RangeError(`no counseling-list row for ${applicationId} — plan first`);
    if (!row.required) throw new CompanionRefused("NOT_REQUIRED", `counseling list exempt (${row.exemption_reason})`);
    const b = (g.borrower_id ? a.borrowers.find((x) => x.id === g.borrower_id) : undefined) ?? a.borrowers.find((x) => x.primary) ?? a.borrowers[0]; if (!b) throw new RangeError("no borrower for the counseling list");
    const zip = counselingZip(b, a.property_zip5);
    const list = generateCounselingList({ application_id: applicationId, application_borrower_id: b.id, zip_used: zip.zip_used, zip_source: zip.zip_source, hud: g.hud, generated_at: g.at, disclosure_id: row.disclosure_id });
    const prior = this.counseling_lists.find((l) => l.application_id === applicationId && !l.superseded_by_list_id); if (prior) prior.superseded_by_list_id = list.list_id;
    this.counseling_lists.push(list);
    row.status = "generated"; row.generated_at = g.at; row.data_snapshot_id = list.list_id; row.rendered_document_id = `DOC-HCL-${list.list_id}`;
    this.append("counseling_list.generated", applicationId, { list_id: list.list_id, disclosure_id: row.disclosure_id, zip_used: list.zip_used, zip_source: list.zip_source, hud_snapshot_at: list.hud_snapshot_at, agency_count: list.agencies.length, superseded_list_id: prior?.list_id ?? null }, g.at);
    return { list, row };
  }
  counselingList(applicationId: string): CounselingList | undefined { return this.counseling_lists.find((l) => l.application_id === applicationId && !l.superseded_by_list_id); }
  /** Rule 7: `application.arm_interest.recorded{fnma_plan_number, channel}` — the ARM program and CHARM rows, gate created closed; the telephone path also arms the 3-BD outer bound. */
  recordArmInterest(applicationId: string, r: { fnma_plan_number: string; channel: ArmChannel | string; at: string; initial_rate_pct?: string; illustration_as_of?: string }): { program: CompanionRow; charm: CompanionRow; disclosure: ArmProgramDisclosure } {
    const a = this.app(applicationId); const plan = armPlan(r.fnma_plan_number); isoOrThrow(r.at, "at");
    const channel = (["electronic", "telephone", "in_person"] as const).includes(r.channel as ArmChannel) ? (r.channel as ArmChannel) : armChannelFrom(r.channel);
    a.arm = a.arm ?? { fnma_plan_number: plan.fnma_plan_number, channel, recorded_at: r.at, gate_opened_at: null };
    const exempt = this.find(applicationId, { kind: "arm_program", rule_code: RULE_CODES.arm }); if (exempt && !exempt.required) exempt.status = "superseded";
    const ill = armIllustration(plan.fnma_plan_number, r.initial_rate_pct ?? "5.875", r.illustration_as_of ?? "2026-10"); const disclosure = armProgramDisclosure(plan.fnma_plan_number, ill);
    const base = { application_id: applicationId, anchor_event: "application.arm_interest.recorded", anchor_at: r.at, required: true, retention_class: "regz_general_2y" as const, business_days: channel === "telephone" ? 3 : null };
    const program = this.newRow({ ...base, kind: "arm_program", rule_code: RULE_CODES.arm, notice_code: NOTICE_CODES.arm_program!, timer_code: TIMER_CODES.arm_gate, asset_version: disclosure.template_version, references: { fnma_plan_number: plan.fnma_plan_number, label: plan.label, channel, illustration_as_of: ill.as_of }, le_version: null });
    const charm = this.newRow({ ...base, kind: "charm", rule_code: RULE_CODES.arm, notice_code: NOTICE_CODES.charm!, timer_code: TIMER_CODES.arm_gate, asset_version: CHARM_EDITION, language_edition: toolkitEditions(a.interview_language).join("+"), references: { fnma_plan_number: plan.fnma_plan_number, channel } });
    program.data_snapshot_id = `ARM-ILL-${plan.fnma_plan_number}-${ill.as_of}`;
    return { program, charm, disclosure };
  }
  armGateFacts(applicationId: string): ArmGateFacts {
    const a = this.app(applicationId); if (!a.arm) return { arm_interest_recorded: false };
    const out = (k: CompanionKind) => { const r = this.find(applicationId, { kind: k, rule_code: RULE_CODES.arm }); return r && r.required ? r.delivered_at ?? r.mailed_at ?? null : null; };
    return { arm_interest_recorded: true, charm_out_at: out("charm"), program_out_at: out("arm_program"), fnma_plan_number: a.arm.fnma_plan_number };
  }
  /** 22.2's `credit.report.received` (bridged here until the credit adapter lands): one score row per scored borrower; no score → `exempt{no_score}`. */
  ingestCreditReport(r: CreditReportReceived): { event: DomainEvent; disclosure: ScoreDisclosure | null; rows: CompanionRow[] } {
    const a = this.app(r.application_id); isoOrThrow(r.received_at, "received_at"); nonEmpty(r.application_borrower_id, "application_borrower_id");
    if (!a.borrowers.some((b) => b.id === r.application_borrower_id)) a.borrowers.push({ id: r.application_borrower_id, name: r.borrower_name });
    const event = this.append("credit.report.received", r.application_id, { application_borrower_id: r.application_borrower_id, credit_report_id: r.credit_report_id, received_at: r.received_at, score_count: r.scores.length, scores: r.scores.map((s) => ({ cra: s.cra, model: s.model, score: s.score, representative: s.representative })), source: "origination" }, r.received_at, { kind: "agent", id: "verification" });
    const base = { application_id: r.application_id, application_borrower_id: r.application_borrower_id, anchor_event: "credit.report.received", anchor_at: r.received_at, retention_class: "regb_25m" as const };
    if (!r.scores.length) return { event, disclosure: null, rows: [this.newRow({ ...base, kind: "credit_score_notice", rule_code: RULE_CODES.fcra, notice_code: NOTICE_CODES.credit_score_notice!, timer_code: null, business_days: null, required: false, exemption_reason: "no_score" })] };
    const disclosure = scoreDisclosureFor(r); a.scores.set(r.application_borrower_id, disclosure);
    const score = this.newRow({ ...base, kind: "credit_score_notice", rule_code: RULE_CODES.fcra, notice_code: NOTICE_CODES.credit_score_notice!, timer_code: TIMER_CODES.fcra, business_days: 1, required: true, references: { credit_report_id: r.credit_report_id, score_disclosure_id: disclosure.score_disclosure_id } });
    const rbp = this.newRow({ ...base, kind: "rbp_notice", rule_code: RULE_CODES.regv, notice_code: NOTICE_CODES.rbp_notice!, timer_code: TIMER_CODES.score_gate, business_days: null, required: true, references: { credit_report_id: r.credit_report_id, rides_with: score.disclosure_id, form: "H-3" } });
    score.status = "generated"; rbp.status = "generated"; score.generated_at = r.received_at; rbp.generated_at = r.received_at; score.rendered_document_id = disclosure.rendered_document_id; rbp.rendered_document_id = disclosure.rendered_document_id;
    (disclosure as { disclosure_id: string | null }).disclosure_id = score.disclosure_id;
    return { event, disclosure, rows: [score, rbp] };
  }
  renderScoreDisclosure(applicationId: string, borrowerId: string, lender: { name: string; nmlsr_id: string; address: string }): Record<string, unknown> {
    const d = this.app(applicationId).scores.get(borrowerId); if (!d) throw new RangeError(`no score disclosure for borrower ${borrowerId} on ${applicationId}`);
    if (d.application_borrower_id !== borrowerId) throw new RangeError("a score notice never carries another borrower's data (§1022.75(c))");
    return scoreDisclosurePayload(d, lender);   // built from this borrower's report alone (§1022.75(c))
  }
  scoreGateFacts(applicationId: string): ScoreGateFacts {
    const a = this.app(applicationId);
    return { scored_borrowers: [...a.scores.keys()], covered_borrowers: [...a.scores.values()].filter((d) => d.delivered_at || d.mailed_at).map((d) => d.application_borrower_id) };
  }
  /** 23.4's `compliance.hpml.determined{stage, is_hpml}` (bridged): a non-QM HPML gets the (c)(5) row — satisfied at creation by a prior Reg B row in `satisfied_by_le`/`delivered`, else the standalone notice issues the same day. */
  ingestHpmlDetermination(applicationId: string, h: { is_hpml: boolean; at: string; stage?: string }): { event: DomainEvent; row: CompanionRow | null } {
    isoOrThrow(h.at, "at");
    const event = this.append("compliance.hpml.determined", applicationId, { stage: h.stage ?? "rate_set", is_hpml: h.is_hpml, determined_at: h.at, source: "origination" }, h.at, { kind: "agent", id: "compliance-tester" });
    if (!h.is_hpml) return { event, row: null };
    const row = this.newRow({ application_id: applicationId, kind: "regb_appraisal_notice", rule_code: RULE_CODES.hpml, notice_code: NOTICE_CODES.regb_appraisal_notice!, timer_code: TIMER_CODES.hpml, anchor_event: "compliance.hpml.determined", anchor_at: h.at, business_days: 3, required: true, retention_class: "regb_25m", references: { stage: h.stage ?? "rate_set" } });
    const prior = this.find(applicationId, { rule_code: RULE_CODES.regb });
    if (prior && (prior.status === "satisfied_by_le" || prior.status === "delivered" || prior.status === "mailed" || prior.status === "received")) {
      row.status = "satisfied_by_le"; row.satisfied_by_disclosure_id = prior.satisfied_by_disclosure_id ?? prior.disclosure_id; this.resolveItem(applicationId, row, prior.status === "satisfied_by_le" ? "le" : "prior_notice");
      this.append("disclosure.companion.satisfied_by_le", applicationId, { disclosure_id: row.disclosure_id, rule_code: row.rule_code, le_disclosure_id: row.satisfied_by_disclosure_id, basis: "§1026.35(c)(5)(i): compliance with §1002.14(a)(2) satisfies" }, h.at);
      this.append("disclosure.companion.issued", applicationId, { disclosure_id: row.disclosure_id, kind: row.kind, rule_code: row.rule_code, via: "le", channel: null }, h.at);
    } else { row.standalone_required = true; row.standalone_issue_by = companionDueAt(h.at, 0, this.calendar).due_at; }
    return { event, row };
  }
  /** Rule 4: the initial LE delivered or mailed on/before the Reg B `due_at` is the appraisal notice; the package rides the LE run. */
  markSatisfiedByLE(applicationId: string, le: LeOut): { regb: CompanionRow; satisfied_by_le: boolean; le_out: string | null } {
    const a = this.app(applicationId); a.le = le; const pkg = a.package; if (pkg) { pkg.le_disclosure_id = le.disclosure_id; }
    const regb = this.find(applicationId, { rule_code: RULE_CODES.regb }); if (!regb) throw new RangeError(`no Reg B appraisal-notice row for ${applicationId}`);
    const s = regBSatisfaction(le, regb.due_at!);
    if (s.satisfied_by_le && !TERMINAL_STATUSES.includes(regb.status) && regb.status !== "delivered" && regb.status !== "mailed") {
      regb.status = "satisfied_by_le"; regb.satisfied_by_disclosure_id = s.satisfied_by_disclosure_id; this.resolveItem(applicationId, regb, "le");
      this.append("disclosure.companion.satisfied_by_le", applicationId, { disclosure_id: regb.disclosure_id, rule_code: regb.rule_code, le_disclosure_id: le.disclosure_id, le_out: s.le_out, due_at: regb.due_at }, s.le_out!);
      this.append("disclosure.companion.issued", applicationId, { disclosure_id: regb.disclosure_id, kind: regb.kind, rule_code: regb.rule_code, via: "le", channel: null, le_disclosure_id: le.disclosure_id }, s.le_out!);
    }
    return { regb, satisfied_by_le: s.satisfied_by_le, le_out: s.le_out };
  }
  /** Sweep at `due_at − 4h`: with no LE out, the standalone C-9 notice must issue now (edge case "Property TBD purchase"). */
  standaloneRegBNoticeDue(applicationId: string, nowIso: string): { due: boolean; issue_by: string | null; row: CompanionRow | null } {
    const regb = this.find(applicationId, { rule_code: RULE_CODES.regb }); if (!regb || TERMINAL_STATUSES.includes(regb.status) || regb.delivered_at || regb.mailed_at) return { due: false, issue_by: regb?.standalone_issue_by ?? null, row: regb ?? null };
    const a = this.app(applicationId); const s = a.le ? regBSatisfaction(a.le, regb.due_at!) : { satisfied_by_le: false };
    const due = !s.satisfied_by_le && Date.parse(nowIso) >= Date.parse(regb.standalone_issue_by!);
    if (due) regb.standalone_required = true;
    return { due, issue_by: regb.standalone_issue_by, row: regb };
  }
  /** Rule 8: any provider-selection step (21.2, 24.1, 24.4, 24.5, 24.6) requests the referral here; an affiliated provider's referral is refused until the Appendix D statement is out no later than the referral. */
  requestReferral(applicationId: string, r: { referring_party_id: string; provider_party_id: string; provider_name: string; service: string; at: string; source_process: string; required_use?: boolean }): { referral: Referral; gate: { open: boolean; reason?: string }; afba_row: CompanionRow | null } {
    const a = this.app(applicationId); isoOrThrow(r.at, "at"); nonEmpty(r.service, "service"); nonEmpty(r.provider_party_id, "provider_party_id");
    validateRequiredUse(r.service, r.required_use === true);
    const rel = afbaRelationship(this.rels, [...this.referringParties, r.referring_party_id], r.provider_party_id, civilDate(r.at, this.calendar.time_zone));
    const referral: Referral = { referral_id: `REF-${applicationId}-${a.referrals.length + 1}`, application_id: applicationId, referring_party_id: r.referring_party_id, provider_party_id: r.provider_party_id, provider_name: r.provider_name, service: r.service, referred_at: r.at, required_use: r.required_use === true, afba_required: rel !== null, afba_disclosure_id: null, source_process: r.source_process, recorded: false };
    a.referrals.push(referral);
    this.append("referral.requested", applicationId, { referral_id: referral.referral_id, provider_party_id: r.provider_party_id, provider_name: r.provider_name, service: r.service, afba_required: referral.afba_required, referring_party_id: r.referring_party_id, source_process: r.source_process, required_use: referral.required_use }, r.at, { kind: "agent", id: r.source_process === "21.2" ? "disclosure" : "title-closing" });
    let afba_row: CompanionRow | null = null;
    if (rel) {
      const exempt = this.find(applicationId, { kind: "afba" }); if (exempt && !exempt.required) exempt.status = "superseded";
      afba_row = this.find(applicationId, { kind: "afba", open_only: true }) ?? null;
      if (!afba_row || afba_row.references.provider_party_id !== r.provider_party_id) afba_row = this.newRow({ application_id: applicationId, kind: "afba", rule_code: RULE_CODES.afba, notice_code: NOTICE_CODES.afba!, timer_code: TIMER_CODES.afba_gate, anchor_event: "referral.requested", anchor_at: r.at, business_days: null, required: true, retention_class: "respa_afba_5y", references: { provider_party_id: r.provider_party_id, provider_name: rel.provider_name, relationship: rel.relationship, ownership_pct: rel.ownership_pct, service: r.service, referral_id: referral.referral_id, separate_document: true }, id_suffix: r.provider_party_id });
      referral.afba_disclosure_id = afba_row.disclosure_id;
    }
    const gate = afbaReferralGate({ afba_required: referral.afba_required, disclosure_out_at: afba_row ? afba_row.delivered_at ?? afba_row.mailed_at ?? null : null, referred_at: r.at, required_provider: referral.required_use, application_received_at: a.application_received_at });
    if (gate.open) { referral.recorded = true; this.append("referral.recorded", applicationId, { referral_id: referral.referral_id, provider_party_id: r.provider_party_id, service: r.service, afba_required: referral.afba_required, afba_gate: referral.afba_required ? "open" : "not_required", afba_disclosure_id: referral.afba_disclosure_id }, r.at); }
    else { this.esc.open({ kind: "sev2", applicationId, severity: "2", ownerRole: "compliance", payload: { code: TIMER_CODES.afba_gate, referral_id: referral.referral_id, provider: r.provider_name, reason: gate.reason } }, AGENT); }
    return { referral, gate, afba_row };
  }
  affiliatesMarked(providers: readonly Provider[], on: PlainDate): Provider[] { return markAffiliates(providers, this.rels, this.referringParties, on); }

  private resolveItem(applicationId: string, row: CompanionRow, via: string): void {
    const pkg = this.app(applicationId).package; if (!pkg) return;
    const it = pkg.items.find((x) => x.disclosure_id === row.disclosure_id); if (it) it.satisfied_by = via;
    if (pkg.items.filter((x) => x.required).every((x) => { const r = this.rows.get(x.disclosure_id); return r && (TERMINAL_STATUSES.includes(r.status) || r.status === "delivered" || r.status === "mailed"); })) pkg.status = pkg.status === "assembling" ? "delivered" : pkg.status;
    if (pkg.items.filter((x) => x.required).every((x) => { const r = this.rows.get(x.disclosure_id); return r && TERMINAL_STATUSES.includes(r.status); })) pkg.status = "complete";
  }
  private locate(applicationId: string, d: { disclosure_id?: string; kind?: CompanionKind; rule_code?: string; application_borrower_id?: string | null; le_version?: number }): CompanionRow {
    if (d.disclosure_id) return this.get(d.disclosure_id);
    const r = this.find(applicationId, { ...(d.kind ? { kind: d.kind } : {}), ...(d.rule_code ? { rule_code: d.rule_code } : {}), ...(d.application_borrower_id !== undefined ? { application_borrower_id: d.application_borrower_id } : {}), ...(d.le_version !== undefined ? { le_version: d.le_version } : {}) });
    if (!r) throw new RangeError(`no companion row ${d.kind ?? d.rule_code ?? "?"} for ${applicationId}`);
    return r;
  }
  /** Deliver (in person / e-sign portal / e-mail under consent) or place in the mail (vendor proof). Guards: never electronically without consent; never orally for the privacy notice; never a stale or short counseling list; never a Toolkit/CHARM other than the current edition; never an SDS on a forward loan; never an exempt row. */
  deliver(applicationId: string, d: { disclosure_id?: string; kind?: CompanionKind; rule_code?: string; application_borrower_id?: string | null; le_version?: number; channel: CompanionChannel; at?: string; consent?: EsignConsent | null; mailing_proof_id?: string | null; asset_version?: string | null; rendered_document_id?: string | null; with_le_disclosure_id?: string | null }): CompanionRow {
    const row = this.locate(applicationId, d); const at = d.at ?? this.clock.now(); const a = this.app(applicationId);
    const refuse = (code: string, reason: string): never => { this.append("disclosure.companion.delivery.refused", applicationId, { disclosure_id: row.disclosure_id, kind: row.kind, rule_code: row.rule_code, channel: d.channel, code, reason }, at); throw new CompanionRefused(code, reason); };
    if (row.kind === "sds") refuse("SDS_NEVER_ISSUED", "NTC_REGX_1024_33A_SDS is reverse-mortgage-only (§1024.33(a)); the LE's servicing statement (§1026.37(m)(6)) is the forward-loan disclosure");
    if (!row.required || row.status === "exempt") refuse("NOT_REQUIRED", `${row.rule_code} is exempt (${row.exemption_reason})`);
    if (TERMINAL_STATUSES.includes(row.status) || row.delivered_at || row.mailed_at) refuse("ALREADY_TERMINAL", `${row.disclosure_id} is ${row.status}`);
    if (d.channel === "oral") { row.oral_explanation_at = at; refuse("ORAL_NOT_DELIVERY", row.kind === "privacy" ? ORAL_DELIVERY_REASON : "an oral explanation is not delivery of a written disclosure"); }
    if (!DELIVERY_CHANNELS.includes(d.channel as DeliveryChannel)) refuse("CHANNEL", `channel ${d.channel} is not one of ${DELIVERY_CHANNELS.join("/")}`);
    const channel = d.channel as DeliveryChannel;
    if (isElectronic(channel)) { const c = consentValidFor(d.consent, at); if (!c.ok) refuse("NO_ESIGN_CONSENT", `${c.reason} — print the package the same day`); }
    if (channel === "mail" && !d.mailing_proof_id) refuse("NO_MAILING_PROOF", "a mailed disclosure needs the print vendor's mailing-date evidence");
    if (row.kind === "hcl") {
      const list = this.counselingList(applicationId); if (!list || list.list_id !== row.data_snapshot_id) refuse("NO_LIST", "the counseling list has not been generated");
      if (list!.agencies.length < HCL_AGENCY_COUNT) refuse("SHORT_LIST", `the list has ${list!.agencies.length} agencies; ten are required`);
      const f = counselingListFreshness(list!.hud_snapshot_at, at, this.calendar.time_zone); if (!f.fresh) { row.status = "planned"; refuse("STALE_COUNSELING_LIST", `§1024.20(a)(1): the HUD data was obtained ${f.age_days} calendar days before delivery (limit ${HCL_MAX_AGE_DAYS}) — regenerate the list`); }
    }
    if (row.kind === "toolkit" && (d.asset_version ?? row.asset_version) !== TOOLKIT_EDITION) refuse("TOOLKIT_EDITION", `the Toolkit edition in force is ${TOOLKIT_EDITION} (§1026.19(g)(2): no other alteration)`);
    if (row.kind === "charm" && (d.asset_version ?? row.asset_version) !== CHARM_EDITION) refuse("CHARM_EDITION", `the Consumer Handbook on Adjustable-Rate Mortgages edition in force is ${CHARM_EDITION}`);
    if (row.kind === "afba" && d.with_le_disclosure_id) refuse("AFBA_SEPARATE_DOCUMENT", "§1024.15(b)(1): the AfBA statement is a separate piece of paper / separate document");
    row.delivery_channel = channel; row.esign_consent_id = isElectronic(channel) ? d.consent!.id : null; row.rendered_document_id = d.rendered_document_id ?? row.rendered_document_id ?? `DOC-${row.disclosure_id}`; if (d.asset_version) row.asset_version = d.asset_version;
    const common = { disclosure_id: row.disclosure_id, kind: row.kind, rule_code: row.rule_code, application_borrower_id: row.application_borrower_id, asset_version: row.asset_version, language_edition: row.language_edition, with_le_disclosure_id: d.with_le_disclosure_id ?? null };
    if (channel === "mail") { row.mailed_at = at; row.mailing_proof_id = d.mailing_proof_id ?? null; row.status = "mailed"; this.append("disclosure.companion.mailed", applicationId, { ...common, mailing_proof_id: d.mailing_proof_id, mailed_at: at }, at); }
    else { row.delivered_at = at; row.status = "delivered"; this.append("disclosure.companion.delivered", applicationId, { ...common, channel: channel, delivered_at: at, esign_consent_id: row.esign_consent_id }, at); }
    this.append("disclosure.companion.issued", applicationId, { ...common, via: channel === "mail" ? "mailed" : "delivered", channel: channel, in_person: isInPerson(channel) }, at);
    this.resolveItem(applicationId, row, channel === "mail" ? "mailed" : "delivered");
    if (isInPerson(channel)) { row.received_at = at; row.status = "received"; this.append("disclosure.companion.received", applicationId, { ...common, evidence: "in_person", received_at: at }, at); }
    // kind-specific events the timers and downstream processes consume
    if (row.kind === "privacy") this.append("privacy.initial_notice.delivered", applicationId, { disclosure_id: row.disclosure_id, channel: channel, edition: row.asset_version, joint: a.borrowers.length > 1, acknowledgment_as_step: channel === "esign_portal" }, at);
    if (row.kind.startsWith("state:")) this.append("state_notice.delivered", applicationId, { disclosure_id: row.disclosure_id, code: row.rule_code, state: row.kind.slice(6), notice_code: row.notice_code, channel: channel, le_version: row.le_version, language_edition: row.language_edition, evidence_retained: true }, at);
    if (row.kind === "credit_score_notice") {
      const disc = a.scores.get(row.application_borrower_id!); if (disc) { if (channel === "mail") disc.mailed_at = at; else disc.delivered_at = at; }
      const rbp = this.find(applicationId, { kind: "rbp_notice", application_borrower_id: row.application_borrower_id, open_only: true }); if (rbp) { rbp.status = row.status; rbp.delivery_channel = channel; rbp.delivered_at = row.delivered_at; rbp.mailed_at = row.mailed_at; rbp.rendered_document_id = row.rendered_document_id; this.resolveItem(applicationId, rbp, "delivered_with_609g"); }
      const g = scoreNoticeGate(this.scoreGateFacts(applicationId));
      this.append("score_disclosure.delivered", applicationId, { disclosure_id: row.disclosure_id, application_borrower_id: row.application_borrower_id, channel: channel, all_borrowers_covered: g.open, h3_included: true }, at);
    }
    if (row.kind === "afba") { const ref = a.referrals.find((x) => x.afba_disclosure_id === row.disclosure_id); this.append("afba.disclosure.delivered", applicationId, { disclosure_id: row.disclosure_id, referral_id: ref?.referral_id ?? row.references.referral_id ?? null, provider_party_id: row.references.provider_party_id ?? null, channel: channel, separate_document: true }, at); }
    if (row.kind === "arm_program" || row.kind === "charm") {
      const g = armDisclosureGate(this.armGateFacts(applicationId));
      if (g.open && a.arm && !a.arm.gate_opened_at) { a.arm.gate_opened_at = at; this.append("arm.disclosures.delivered", applicationId, { fnma_plan_number: a.arm.fnma_plan_number, channel: channel, via: channel === "mail" ? "mailed" : "delivered", charm_edition: CHARM_EDITION, gate_opened_at: at }, at); }
    }
    return row;
  }
  /** Receipt evidence tied to the authenticated borrower (portal view, acknowledgement reply, e-signature). */
  recordReceipt(applicationId: string, r: { disclosure_id?: string; kind?: CompanionKind; rule_code?: string; application_borrower_id?: string | null; at: string; borrower_id: string; evidence: "authenticated_view" | "acknowledgement" | "esignature" | "courier" }): CompanionRow {
    const row = this.locate(applicationId, r); nonEmpty(r.borrower_id, "borrower_id"); isoOrThrow(r.at, "at");
    if (!row.delivered_at && !row.mailed_at) throw new CompanionRefused("NOT_ISSUED", `${row.disclosure_id} has not been delivered or mailed`);
    if (Date.parse(r.at) < Date.parse(row.delivered_at ?? row.mailed_at!)) throw new RangeError(`receipt evidence ${r.at} precedes delivery`);
    if (row.received_at) return row;
    row.received_at = r.at; if (row.status === "delivered" || row.status === "mailed") row.status = "received";
    this.append("disclosure.companion.received", applicationId, { disclosure_id: row.disclosure_id, kind: row.kind, rule_code: row.rule_code, evidence: r.evidence, borrower_id: r.borrower_id, received_at: r.at }, r.at);
    this.resolveItem(applicationId, row, "received");
    return row;
  }
  /** Acknowledgment where the rule requires one (state signature / confirm button / signed copy; privacy "acknowledge as a step"): opens the state gates. */
  recordAcknowledgment(applicationId: string, k: { disclosure_id?: string; kind?: CompanionKind; rule_code?: string; application_borrower_id?: string | null; at: string; borrower_id: string; method: "esignature" | "confirm_button" | "signed_copy" | "portal_step"; evidence_id: string }): CompanionRow {
    const row = this.locate(applicationId, k); nonEmpty(k.borrower_id, "borrower_id"); nonEmpty(k.evidence_id, "evidence_id"); isoOrThrow(k.at, "at");
    if (!row.delivered_at && !row.mailed_at) throw new CompanionRefused("NOT_ISSUED", `${row.disclosure_id} has not been delivered or mailed — nothing to acknowledge`);
    if (row.acknowledged_at) return row;
    row.acknowledged_at = k.at; row.acknowledgment_evidence_id = k.evidence_id; row.received_at = row.received_at ?? k.at; row.status = "acknowledged";
    this.append("disclosure.companion.acknowledged", applicationId, { disclosure_id: row.disclosure_id, kind: row.kind, rule_code: row.rule_code, method: k.method, borrower_id: k.borrower_id, evidence_id: k.evidence_id, acknowledged_at: k.at }, k.at);
    if (row.kind.startsWith("state:")) this.append("state_notice.acknowledged", applicationId, { disclosure_id: row.disclosure_id, code: row.rule_code, state: row.kind.slice(6), method: k.method, borrower_id: k.borrower_id, evidence_id: k.evidence_id }, k.at);
    this.resolveItem(applicationId, row, "acknowledged");
    return row;
  }
  /** `decision.issued{denial}` / `application.withdrawn` before `due_at`: the Toolkit clock is cancelled (§1026.19(g)(1)(i)); the counseling list, Reg B and privacy notices still go out. */
  onDecisionIssued(applicationId: string, d: { outcome: "denial" | "withdrawal"; at: string }): { cancelled: CompanionRow[] } {
    isoOrThrow(d.at, "at"); const reason = d.outcome === "denial" ? "denied_within_period" : "withdrawn"; const cancelled: CompanionRow[] = [];
    for (const row of this.rowsFor(applicationId)) {
      if (row.kind !== "toolkit" || !row.required || TERMINAL_STATUSES.includes(row.status) || row.delivered_at || row.mailed_at) continue;
      if (row.due_at && Date.parse(d.at) < Date.parse(row.due_at)) { row.status = "cancelled"; row.cancelled_reason = reason; cancelled.push(row); this.resolveItem(applicationId, row, reason); this.cancelTimers(applicationId, row.timer_code!, reason, d.at); }
    }
    return { cancelled };
  }
  private cancelTimers(applicationId: string, code: string, reason: string, at: string): void {
    if (this.timers) for (const t of this.timers.byCode(code)) if ((t.applicationId ?? t.subject.id) === applicationId && (t.status === "armed" || t.status === "breached")) this.timers.cancel(t.id, reason, AGENT);
    this.append("timer.cancel.requested", applicationId, { code, reason }, at);
  }
  /** State gates that do not apply to this application's property state are cancelled on the engine (they arm on the bare `application.started`/`.received` event). */
  cancelInapplicableStateGates(applicationId: string): string[] {
    const a = this.app(applicationId); const out: string[] = [];
    for (const r of STATE_EARLY_DISCLOSURES) if (r.blocking && r.state !== (a.property_state ?? "").toUpperCase()) { if (this.timers) for (const t of this.timers.byCode(r.timer_code)) if ((t.applicationId ?? t.subject.id) === applicationId && t.status === "armed") { this.timers.cancel(t.id, "state_not_applicable", AGENT); out.push(r.timer_code); } }
    return out;
  }
  gateFacts(applicationId: string, code: CompanionGateCode): Record<string, unknown> {
    const a = this.app(applicationId);
    switch (code) {
      case "REGZ_1026_19B_ARM_DISCLOSURE_GATE": return { ...this.armGateFacts(applicationId) };
      case "REGV_1022_74D_SCORE_NOTICE_CONSUMMATION_GATE": return { ...this.scoreGateFacts(applicationId) };
      case "REGX_1024_15_AFBA_REFERRAL_GATE": { const ref = a.referrals.filter((x) => x.afba_required).at(-1); const row = ref?.afba_disclosure_id ? this.rows.get(ref.afba_disclosure_id) : undefined; return { afba_required: ref?.afba_required ?? false, disclosure_out_at: row ? row.delivered_at ?? row.mailed_at ?? null : null, referred_at: ref?.referred_at ?? this.clock.now(), required_provider: ref?.required_use ?? false, application_received_at: a.application_received_at }; }
      default: { const rule = STATE_EARLY_DISCLOSURES.find((r) => r.timer_code === code)!; const row = this.find(applicationId, { rule_code: rule.rule_code }); return { property_state: a.property_state, state: rule.state, rule_code: rule.rule_code, acknowledged_at: row?.acknowledged_at ?? null }; }
    }
  }
  evaluateGate(applicationId: string, code: CompanionGateCode): { open: boolean; reason?: string } {
    const f = this.gateFacts(applicationId, code);
    switch (code) {
      case "REGZ_1026_19B_ARM_DISCLOSURE_GATE": return armDisclosureGate(f as unknown as ArmGateFacts);
      case "REGV_1022_74D_SCORE_NOTICE_CONSUMMATION_GATE": return scoreNoticeGate(f as unknown as ScoreGateFacts);
      case "REGX_1024_15_AFBA_REFERRAL_GATE": return afbaReferralGate(f as unknown as AfbaGateFacts);
      default: return stateAcknowledgmentGate(f as unknown as StateGateFacts);
    }
  }
  /** `assertGateOpen(application_id, code)` for 21.1 (`application.received`, ARM 1003 sections), 21.2 (`issueLE` for ARM products), 21.4 (`impose_fee`), 24.x (referrals) and 25.2/26.x (consummation): a refusal on the score-notice gate is a sev-1 escalation. */
  assertGateOpen(applicationId: string, code: CompanionGateCode, command: string = code): void {
    const g = this.evaluateGate(applicationId, code); if (g.open) return;
    const sev = code === "REGV_1022_74D_SCORE_NOTICE_CONSUMMATION_GATE" ? "1" : "2";
    this.esc.open({ kind: sev === "1" ? "sev1" : "sev2", applicationId, severity: sev, ownerRole: "compliance", payload: { code, command, reason: g.reason } }, AGENT);
    this.append("gate.refused", applicationId, { code, command, reason: g.reason, severity: Number(sev) });
    throw new CompanionGateClosed(code, `${g.reason} (command ${command} refused)`);
  }
  /** 21.4's `fee_gate_checks` consults the ARM/NY/NJ/AZ/FL gates on every `impose_fee` (and 21.1 the NY/FL gates on `application.received`); every check is recorded, refusals included. */
  checkCommandGates(applicationId: string, command: "impose_fee" | "application.received" | "render_arm_1003_section" | "issueLE", o: { fee_kind?: string | null; amount_cents?: Cents | null; at?: string } = {}): CompanionFeeGateCheck {
    const at = o.at ?? this.clock.now(); const codes = command === "impose_fee" ? FEE_GATE_CODES : command === "application.received" ? APPLICATION_RECEIVED_GATE_CODES : (["REGZ_1026_19B_ARM_DISCLOSURE_GATE"] as const);
    const a = this.app(applicationId);
    const gates = codes.map((code) => { const state = STATE_EARLY_DISCLOSURES.find((r) => r.timer_code === code); const applicable = state ? state.state === (a.property_state ?? "").toUpperCase() : code !== "REGZ_1026_19B_ARM_DISCLOSURE_GATE" || a.arm !== null; if (!applicable) return { code, result: "not_applicable" as const, reason: null }; const g = this.evaluateGate(applicationId, code); return { code, result: g.open ? ("open" as const) : ("closed" as const), reason: g.reason ?? null }; });
    const check: CompanionFeeGateCheck = { check_id: randomUUID(), application_id: applicationId, command, fee_kind: o.fee_kind ?? null, amount_cents: o.amount_cents ?? null, checked_at: at, gates, result: gates.every((g) => g.result !== "closed") ? "open" : "closed" };
    a.fee_gate_checks.push(check);
    if (check.result === "closed") { const first = gates.find((g) => g.result === "closed")!; this.append("gate.refused", applicationId, { code: first.code, command, fee_kind: o.fee_kind ?? null, amount_cents: o.amount_cents ?? null, reason: first.reason, check_id: check.check_id }, at); throw new CompanionGateClosed(first.code, `${first.reason} (command ${command} refused)`); }
    return check;
  }
  /** compliance-sentinel scan: a privacy notice explained only orally (§1016.9(d)) with no written/electronic delivery is a sev-2 finding; the row is not `delivered`. */
  sentinelScan(applicationId: string, nowIso: string): { findings: { code: string; disclosure_id: string; severity: 2; reason: string; escalation_id: string }[] } {
    const findings: { code: string; disclosure_id: string; severity: 2; reason: string; escalation_id: string }[] = [];
    for (const row of this.rowsFor(applicationId)) {
      if (row.kind === "privacy" && row.oral_explanation_at && !row.delivered_at && !row.mailed_at) {
        const e = this.esc.open({ kind: "sev2", applicationId, severity: "2", ownerRole: "compliance", payload: { code: "GLBA_1016_9D_ORAL_ONLY", disclosure_id: row.disclosure_id, oral_explanation_at: row.oral_explanation_at, reason: ORAL_DELIVERY_REASON, scanned_at: nowIso } }, { kind: "agent", id: "compliance-sentinel" });
        findings.push({ code: "GLBA_1016_9D_ORAL_ONLY", disclosure_id: row.disclosure_id, severity: 2, reason: ORAL_DELIVERY_REASON, escalation_id: e.id });
      }
    }
    return { findings };
  }
  /** Breach of a companion clock (timer table "breach action"): sev 1 → compliance-sentinel + partner officer with an incident record; sev 2 → compliance-sentinel; sev 3 for the privacy policy clock. */
  onTimerBreached(applicationId: string, code: string, nowIso: string): { severity: 1 | 2 | 3; escalated_to: readonly string[]; incident_id: string | null } {
    const sev: 1 | 2 | 3 = ["REGX_1024_20_HCL_3BD", "REGZ_1026_19G_TOOLKIT_3BD", "REGB_1002_14_APPRAISAL_NOTICE_3BD", "REGZ_1026_19B_ARM_DISCLOSURE_3BD", "CA_CIV_1632_5_TRANSLATED_LE_3BD"].includes(code) ? 1 : code === "SM_O23_PRIVACY_INITIAL_3BD" ? 3 : 2;
    const escalated_to = sev === 1 ? ["compliance-sentinel", "officer"] : ["compliance-sentinel"];
    const incident_id = sev === 1 ? `INC-${code}-${applicationId}` : null;
    this.esc.open({ kind: sev === 1 ? "sev1" : sev === 2 ? "sev2" : "sev3", applicationId, severity: String(sev), ownerRole: sev === 1 ? "officer" : "compliance", payload: { code, incident_id, escalated_to, breached_at: nowIso, deliver_immediately: true } }, AGENT);
    if (incident_id) this.append("compliance.incident.opened", applicationId, { incident_id, code, severity: 1, escalated_to, breached_at: nowIso, root_cause_required: true }, nowIso);
    return { severity: sev, escalated_to, incident_id };
  }
  /** The decision record the `disclosure` agent writes (spec 21.3 AI agent design). */
  decisionRecord(applicationId: string, run: { model_version: string; prompt_version: string; rationale: string; confidence?: number }): Record<string, unknown> {
    const a = this.app(applicationId); const pkg = a.package; const list = this.counselingList(applicationId); const matrix = evaluateStateMatrix({ property_state: a.property_state, interview_language: a.interview_language });
    return { application_id: applicationId, package_id: pkg?.package_id ?? null,
      rules: this.rowsFor(applicationId).map((r) => ({ rule_code: r.rule_code, kind: r.kind, required: r.required, exemption_reason: r.exemption_reason, anchor_event: r.anchor_event, anchor_at: r.anchor_at, due_at: r.due_at, calendar: r.calendar_code, status: r.status, satisfied_by: r.satisfied_by_disclosure_id, delivered_at: r.delivered_at, mailed_at: r.mailed_at, receipt_evidence: r.received_at, acknowledged_at: r.acknowledged_at, asset_version: r.asset_version, language_edition: r.language_edition })),
      counseling_list: list ? { zip_used: list.zip_used, zip_source: list.zip_source, hud_snapshot_at: list.hud_snapshot_at, agency_count: list.agencies.length } : null,
      score_disclosures: [...a.scores.values()].map((d) => ({ borrower: d.application_borrower_id, report_id: d.credit_report_id, scores_count: d.scores.length, delivered_at: d.delivered_at })),
      arm: a.arm ? { plan: a.arm.fnma_plan_number, channel: a.arm.channel, gate_opened_at: a.arm.gate_opened_at } : null,
      afba: { referrals_evaluated: a.referrals.length, disclosures_issued: this.rowsFor(applicationId).filter((r) => r.kind === "afba" && (r.delivered_at || r.mailed_at)).length },
      state_matrix: { state: matrix.state, rows: matrix.rows.map((r) => r.rule_code), confidence: matrix.confidence },
      rule_set_versions: RULE_SETS, model_version: run.model_version, prompt_version: run.prompt_version, rationale: run.rationale, confidence: run.confidence ?? null };
  }
}
