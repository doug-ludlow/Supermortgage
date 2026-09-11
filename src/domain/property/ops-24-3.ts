/**
 * §24.3 Property and project eligibility — property types and B2-3 tests, condo/PUD project review under the
 * post-Aug 3, 2026 methods (Full Review with CPM, PERS, FHA, waiver; `limited_legacy` only for applications before
 * that date), deferred-maintenance / special-assessment rules, manufactured housing (B5-2), ADUs, condition and
 * quality ratings (B4-1.3-06), postponed improvements / escrow holdbacks (B4-1.2-05). Small pure functions, one per
 * rule / T-id, plus the event recorders that arm and close the 24.3 timers. Bigint cents, PlainDate arithmetic,
 * erasable TypeScript only.
 *
 * Every rule-set date (Aug 3, 2026; Jan 4, 2027; Nov 1, 2026) is DATA in the versioned rule set
 * `fnma.selling.2026-09-02` (FNMA_SELLING_2026_09_02.switches) — resolveRules(application_date) applies the dated
 * switches and the decision record carries `rule_set_version` with the switches that fired.
 *
 * Seams (reused, never re-implemented):
 *   24.2 (src/domain/property/ops-24-2.ts) owns the appraisal versions: this file reads the condition / quality
 *        ratings and "subject to" flag from `valuation.received` (24.1) / `valuation.review.completed` (24.2) payloads
 *        (readValuationRatings) — never a second appraisal record.
 *   30.2 (src/domain/orig-boarding/ops-30-2.ts) posts the opening ledger at funding through the loan sub-account
 *        `holdback_escrow` (openingLedgerLines: Dr custodial_ti_prepurchase_cash / Cr holdback_escrow); this file
 *        supplies `holdback_escrow_cents`, funds the escrow with the same accounts (fundHoldback) and releases the
 *        final draw against it (releaseFinalDraw) — prepurchaseTiCash / holdbackEscrowAccount below.
 *   23.1 consumes the project messages (DU findings) and the ADU rent fact; 29.3 the Project Type Code / CPM IDs / SFC 859.
 *
 * Events (every one carries `applicationId` + payload.application_id so the origination timers arm — engine.ts isOriginationContext):
 *   property.eligibility.completed{result, property_class, subject_to, condition_rating}   [arms FNMA_B4_1_2_05_COMPLETION_BEFORE_DELIVERY_GATE (subject_to=true), SM_MH_LABEL_VERIFICATION_GATE (property_class ∈ {mh, mh_advantage})]
 *   property.repair.required{item, safety_related, path}                                   [arms FNMA_B4_1_3_06_SAFETY_REPAIR_BEFORE_SALE_GATE (safety_related=true)]
 *   property.repair.completed{item, safety_related, evidence_kind}                         [satisfies FNMA_B4_1_3_06_SAFETY_REPAIR_BEFORE_SALE_GATE (safety_related=true)]
 *   property.completion.accepted{evidence_kind, resulting_condition_rating}                [satisfies FNMA_B4_1_2_05_COMPLETION_BEFORE_DELIVERY_GATE]
 *   project.review.started{review_type, reviewed_at, lookback_from}                        [arms FNMA_B4_2_1_03_INSPECTION_LOOKBACK_3Y]
 *   project.docs.requested{documents} / project.docs.received{docs_as_of}                  [the latter arms SM_PROJECT_DOCS_AGE_120]
 *   project.inspection.reviewed{all_in_window, reviewed, unreviewed}                       [satisfies FNMA_B4_2_1_03_INSPECTION_LOOKBACK_3Y (all_in_window=true)]
 *   project.reserve_study.used{study_date} / project.reserve_study.accepted{in_window}     [arm / satisfy FNMA_B4_2_2_01_RESERVE_STUDY_AGE_3Y]
 *   project.review.completed{project_status, established, new, reviewed_at, expires_at, review_type, project_type_code, docs_fresh, result}
 *                                            [arms FNMA_B4_2_1_01_PROJECT_REVIEW_ESTABLISHED_1Y ({established}) / _NEW_180 ({new}); satisfies SM_PROJECT_DOCS_AGE_120 (docs_fresh=true)]
 *   project.review.expired{expires_at}       project.ineligible.determined{reason, reasons}
 *   project.cpm.status.recorded{cpm_status, cpm_project_id, cpm_certification_id, cpm_cert_expires_on, note_date, recorded_by}   [arms FNMA_B4_2_1_01_CPM_CERT_VALID_GATE]
 *   holdback.established{holdback_id, note_date, escrow_cents, completion_due_on}          [arms FNMA_B4_1_2_05_HOLDBACK_COMPLETION_180 from note_date]
 *   holdback.completed{holdback_id, completed_at, evidence_kind}                           [satisfies _HOLDBACK_COMPLETION_180; arms SM_HOLDBACK_FINAL_DRAW_5BD from completed_at]
 *   holdback.released{holdback_id, released_at, amount_cents}                              [satisfies SM_HOLDBACK_FINAL_DRAW_5BD]
 *   holdback.overdue{holdback_id, completion_due_on, overdue_on}                            [+ officer escalation (sev 1); 28.4 self-report assessment]
 *   mh.verification.completed{result, special_feature_codes}                              [satisfies SM_MH_LABEL_VERIFICATION_GATE (result=eligible)]
 * Consumed: closing.consummated (26.1; satisfies the two project-validity deadlines and the CPM gate), valuation.received (24.1), valuation.review.completed (24.2).
 */
import { randomUUID } from "node:crypto";
import { type PlainDate, addDays, addYears, daysBetween, plainDate, min as minDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { AccountRef, EntrySet, Ledger, LineInput, LoanAccount } from "../../kernel/ledger/ledger.ts";
import { prepurchaseTiCash } from "../orig-boarding/ops-30-2.ts";

export const AGENT_24_3: Actor = { kind: "agent", id: "valuation" };
export const RULE_SET_VERSION = "fnma.selling.2026-09-02";
export const SFC_MH_ADVANTAGE = "859";

// ============================================================ rule set with dated switches (data, never constants in the rules)
export interface DatedSwitch { readonly key: string; readonly effective_from: PlainDate; readonly value: string | number | boolean; readonly prior: string | number | boolean; readonly citation: string; }
export interface ProjectRuleSet {
  readonly version: string;
  readonly switches: readonly DatedSwitch[];
  readonly constants: {
    readonly delinquency_60_max_bp: number; readonly commercial_max_bp: number; readonly single_entity_max_bp_21_plus: number; readonly single_entity_max_units_5_to_20: number;
    readonly presale_min_bp_new: number; readonly established_conveyed_min_bp: number; readonly unfunded_repair_per_unit_cents: Cents; readonly litigation_reserve_exception_bp: number;
    readonly docs_age_max_days: number; readonly inspection_lookback_years: number; readonly reserve_study_max_age_years: number;
    readonly established_validity_years: number; readonly new_validity_days: number; readonly waiver_max_units: number; readonly fnma_to_fnma_lcor_max_ltv_bp: number;
    readonly holdback_completion_days: number; readonly holdback_escrow_bp: number; readonly final_draw_business_days: number;
    readonly lease_term_margin_years: number; readonly hud_code_from: PlainDate; readonly adu_rent_net_bp: number; readonly adu_rent_income_cap_bp: number; readonly lien_priority_months_max: number;
  };
}
/** Selling Guide edition Sept 2, 2026 with LL-2026-03 / SEL-2026-07 / SEL-2026-08 dated switches. */
export const FNMA_SELLING_2026_09_02: ProjectRuleSet = {
  version: RULE_SET_VERSION,
  switches: [
    { key: "limited_review_retired", effective_from: plainDate("2026-08-03"), value: true, prior: false, citation: "Project Standards FAQs (August 2026): 'Loans with application dates on or after August 3, 2026, are not eligible for sale to Fannie Mae under the Limited Review process.'" },
    { key: "reserve_min_bp", effective_from: plainDate("2027-01-04"), value: 1500, prior: 1000, citation: "LL-2026-03 (03/18/2026): reserves 'from a minimum of 10% to a minimum of 15% of the annual budgeted income assessment' for Full Review applications on/after Jan 4, 2027" },
    { key: "reserve_study_baseline_prohibited", effective_from: plainDate("2026-08-03"), value: true, prior: false, citation: "Project Standards FAQs (August 2026): 'lenders will not be able to utilize the baseline funding methodology… for loans with application dates on or after August 3, 2026. Additionally, the highest recommendation must be used.'" },
    { key: "adu_rental_rules_mandatory", effective_from: plainDate("2026-11-01"), value: true, prior: false, citation: "B3-3.8-02 (09/02/2026; mandatory for applications on/after Nov 1, 2026 per SEL-2026-08)" },
  ],
  constants: {
    delinquency_60_max_bp: 1500, commercial_max_bp: 3500, single_entity_max_bp_21_plus: 2000, single_entity_max_units_5_to_20: 2,
    presale_min_bp_new: 5000, established_conveyed_min_bp: 9000, unfunded_repair_per_unit_cents: 1_000_000n, litigation_reserve_exception_bp: 1000,
    docs_age_max_days: 120, inspection_lookback_years: 3, reserve_study_max_age_years: 3,
    established_validity_years: 1, new_validity_days: 180, waiver_max_units: 10, fnma_to_fnma_lcor_max_ltv_bp: 8000,
    holdback_completion_days: 180, holdback_escrow_bp: 12000, final_draw_business_days: 5,
    lease_term_margin_years: 5, hud_code_from: plainDate("1976-06-15"), adu_rent_net_bp: 7500, adu_rent_income_cap_bp: 3000, lien_priority_months_max: 6,
  },
};
export interface ResolvedRules {
  readonly version: string; readonly application_date: PlainDate;
  readonly limited_review_allowed: boolean; readonly reserve_min_bp: number; readonly reserve_study_baseline_allowed: boolean; readonly adu_rental_rules_mandatory: boolean;
  readonly switches_applied: readonly { key: string; value: string | number | boolean; effective_from: PlainDate; citation: string }[];
  /** `fnma.selling.2026-09-02[reserve_min_bp=1500@2027-01-04, …]` — the dated switches shown (Audit and evidence). */
  readonly rule_set_version: string;
  readonly constants: ProjectRuleSet["constants"];
}
const switchValue = (rs: ProjectRuleSet, key: string, on: PlainDate): { value: string | number | boolean; fired: DatedSwitch | null } => {
  const sw = rs.switches.find((s) => s.key === key); if (!sw) throw new RangeError(`rule set ${rs.version} has no switch ${key}`);
  return on >= sw.effective_from ? { value: sw.value, fired: sw } : { value: sw.prior, fired: null };
};
/** Apply the dated switches to an application date (the switch keys off `applications.application_date`, never the note date). */
export function resolveRules(applicationDate: PlainDate, rs: ProjectRuleSet = FNMA_SELLING_2026_09_02): ResolvedRules {
  const lr = switchValue(rs, "limited_review_retired", applicationDate), rm = switchValue(rs, "reserve_min_bp", applicationDate), bl = switchValue(rs, "reserve_study_baseline_prohibited", applicationDate), adu = switchValue(rs, "adu_rental_rules_mandatory", applicationDate);
  const fired = [lr, rm, bl, adu].flatMap((x) => (x.fired ? [{ key: x.fired.key, value: x.fired.value, effective_from: x.fired.effective_from, citation: x.fired.citation }] : []));
  return { version: rs.version, application_date: applicationDate, limited_review_allowed: lr.value !== true, reserve_min_bp: Number(rm.value), reserve_study_baseline_allowed: bl.value !== true, adu_rental_rules_mandatory: adu.value === true,
    switches_applied: fired, rule_set_version: fired.length ? `${rs.version}[${fired.map((f) => `${f.key}=${String(f.value)}@${f.effective_from}`).join(", ")}]` : rs.version, constants: rs.constants };
}

// ============================================================ shared helpers
export type Outcome = "pass" | "fail" | "n/a";
export interface Check { readonly rule: string; readonly citation: string; readonly inputs: Record<string, unknown>; readonly outcome: Outcome; readonly reason?: string; readonly evidence_document_ids?: readonly string[]; }
export type Result = "eligible" | "eligible_with_conditions" | "ineligible";
const check = (rule: string, citation: string, inputs: Record<string, unknown>, ok: boolean | null, reason?: string): Check => ({ rule, citation, inputs, outcome: ok === null ? "n/a" : ok ? "pass" : "fail", ...(reason && ok === false ? { reason } : {}) });
export const civilDate = (iso: string): PlainDate => plainDate(iso.slice(0, 10));
/** ceil(n / d) for non-negative bigint. */
export const ceilDiv = (n: bigint, d: bigint): bigint => (n + d - 1n) / d;
/** basis points (1/100 of a percent) of `part` over `whole`, rounded half up; `bp10k` = ten-thousandths (0.1042 → 1042). */
export function ratioBp(part: bigint, whole: bigint): number { if (whole <= 0n) throw new RangeError("ratio denominator must be > 0"); return Number((part * 20_000n + whole) / (2n * whole)); }
const emit = (events: EventStore, applicationId: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor = AGENT_24_3, loanId?: string | null): DomainEvent =>
  events.append({ type, applicationId, ...(loanId ? { loanId } : {}), aggregate: { kind: "application", id: applicationId }, actor, occurredAt: at, payload: { application_id: applicationId, ...payload } });
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const forApp = (events: EventStore, applicationId: string, type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === applicationId || p(e).application_id === applicationId).sort((a, b) => a.sequence - b.sequence);

// ============================================================ R1 — property classification and B2-3 tests
export type PropertyClass = "sfr" | "pud_unit" | "condo_unit" | "detached_condo_unit" | "two_to_four" | "mh" | "mh_advantage" | "mixed_use" | "leasehold" | "multi_parcel";
export type ZoningStatus = "legal" | "legal_nonconforming" | "illegal" | "none";
export type IneligibleType = "vacant_land" | "farm_ranch" | "condotel" | "co_op_hotel" | "houseboat" | "boat_slip" | "timeshare" | "boarding_house" | "bed_and_breakfast";
export interface AduFacts { readonly count: number; readonly kitchen: { cabinets: boolean; countertop: boolean; sink_running_water: boolean; stove_or_hookup: boolean }; readonly permitted: boolean; readonly insurance_claim_confirmed?: boolean; readonly appraisal_analyzed?: boolean; }
export interface ParcelFacts { readonly count: number; readonly each_conveyed_entirely: boolean; readonly adjoining_or_road_separated: boolean; readonly same_basic_zoning: boolean; readonly one_dwelling: boolean; readonly first_lien_on_each: boolean; }
export interface MixedUseFacts { readonly one_unit_principal_residence: boolean; readonly borrower_owns_and_operates: boolean; readonly primarily_residential: boolean; readonly marketability_unaffected: boolean; }
export interface LeaseholdFacts { readonly lease_expiry: PlainDate; readonly recorded: boolean; readonly assignable_unlimited: boolean; readonly lender_cure_rights_30d: boolean; }
export interface SolarFacts { readonly ownership: "owned" | "leased_ppa" | "financed_ucc_fixture" | "personal_property"; readonly third_party_loss_payee?: boolean; readonly alternate_power_source?: boolean; readonly ucc_subordinated?: boolean; readonly pace_financed?: boolean; }
export interface PropertyFacts {
  readonly units: number; readonly property_type: "sfr" | "condo" | "pud" | "2_4_unit" | "manufactured";
  readonly detached?: boolean; readonly mh_advantage?: boolean; readonly residential_in_nature?: boolean; readonly year_round_occupancy?: boolean; readonly location_eligible?: boolean;
  readonly highest_and_best_use?: boolean; readonly ineligible_type?: IneligibleType | null;
  readonly zoning_status?: ZoningStatus; readonly nonconforming_adverse_effect_analyzed?: boolean; readonly setback_prevents_rebuild?: boolean; readonly environmental_hazard_addressed?: boolean | null;
  readonly adu?: AduFacts | null; readonly parcels?: ParcelFacts | null; readonly mixed_use?: MixedUseFacts | null; readonly leasehold?: LeaseholdFacts | null; readonly loan_maturity_date?: PlainDate | null;
  readonly solar?: SolarFacts | null; readonly pace_lien?: boolean; readonly pace_paid_at_closing?: boolean; readonly hawaiian_lava_zone?: number | null; readonly disaster_flag?: boolean; readonly post_disaster_inspection_clear?: boolean | null;
}
export function classifyProperty(f: PropertyFacts): PropertyClass {
  if (f.property_type === "manufactured") return f.mh_advantage ? "mh_advantage" : "mh";
  if (f.leasehold) return "leasehold";
  if ((f.parcels?.count ?? 1) > 1) return "multi_parcel";
  if (f.mixed_use) return "mixed_use";
  if (f.property_type === "condo") return f.detached ? "detached_condo_unit" : "condo_unit";
  if (f.property_type === "pud") return "pud_unit";
  if (f.units >= 2 || f.property_type === "2_4_unit") return "two_to_four";
  return "sfr"; // "A one-unit property with an accessory dwelling unit (ADU) is defined as a one-unit property" (B2-3-01)
}
/** B2-3-03: "The lease must have an unexpired term that exceeds the maturity date of the loan by five (5) years or more." */
export function leaseTermTest(leaseExpiry: PlainDate, loanMaturity: PlainDate, marginYears: number = FNMA_SELLING_2026_09_02.constants.lease_term_margin_years): { pass: boolean; required_through: PlainDate; margin_years: number } {
  const required_through = addYears(loanMaturity, marginYears);
  return { pass: leaseExpiry >= required_through, required_through, margin_years: marginYears };
}
/** B3-3.8-02: ADU rent — purchase / limited cash-out only; 75% of the lease; capped at 30% of total qualifying income (22.3 / 23.1 consume). */
export function aduRentUsable(i: { transaction_type: "purchase" | "limited_cash_out" | "cash_out"; adu_permitted: boolean; adu_eligible?: boolean; lease_cents: Cents; total_qualifying_income_cents: Cents; form_1007_or_1025?: boolean; lease_executed?: boolean }, c = FNMA_SELLING_2026_09_02.constants): { usable: boolean; net_rent_cents: Cents; cap_cents: Cents; usable_cents: Cents; reason: string } {
  const net_rent_cents = (i.lease_cents * BigInt(c.adu_rent_net_bp)) / 10_000n;
  const cap_cents = (i.total_qualifying_income_cents * BigInt(c.adu_rent_income_cap_bp)) / 10_000n;
  if (i.transaction_type === "cash_out") return { usable: false, net_rent_cents, cap_cents, usable_cents: 0n, reason: "B3-3.8-02: 'Purchase or limited cash-out refinance transactions only.'" };
  if (!(i.adu_eligible ?? i.adu_permitted)) return { usable: false, net_rent_cents, cap_cents, usable_cents: 0n, reason: "ADU not eligible (unpermitted without the insurance-claim confirmation and appraisal analysis)" };
  if (i.form_1007_or_1025 === false) return { usable: false, net_rent_cents, cap_cents, usable_cents: 0n, reason: "B3-3.8-02: Form 1007 / Form 1025 required" };
  const usable_cents = net_rent_cents < cap_cents ? net_rent_cents : cap_cents;
  return { usable: true, net_rent_cents, cap_cents, usable_cents, reason: `min(75% × lease = ${net_rent_cents}, 30% × total qualifying income = ${cap_cents})` };
}
export function runPropertyChecks(f: PropertyFacts, rules: ResolvedRules): Check[] {
  const out: Check[] = [];
  out.push(check("units_1_to_4", "B2-3-01: 'one to four units'", { units: f.units }, f.units >= 1 && f.units <= 4, `${f.units} units`));
  out.push(check("residential_in_nature", "B2-3-01: 'residential in nature as defined by the characteristics of the property and surrounding market area'", { residential_in_nature: f.residential_in_nature ?? true }, f.residential_in_nature ?? true));
  out.push(check("year_round_occupancy", "B2-3-01: properties not suitable for year-round occupancy are ineligible", { year_round_occupancy: f.year_round_occupancy ?? true }, f.year_round_occupancy ?? true));
  out.push(check("location", "B2-3-01: 'the United States (including the District of Columbia), Puerto Rico, the U.S. Virgin Islands, or Guam'", { location_eligible: f.location_eligible ?? true }, f.location_eligible ?? true));
  out.push(check("highest_and_best_use", "B4-1.3-04: 'the highest and best use of the site as improved'", { highest_and_best_use: f.highest_and_best_use ?? true }, f.highest_and_best_use ?? true));
  out.push(check("no_ineligible_type", "B2-3-01: vacant land, farms or ranches, condo/co-op hotels, houseboats, boat slips, timeshares, boarding houses, bed and breakfasts", { ineligible_type: f.ineligible_type ?? null }, !f.ineligible_type, `ineligible property type: ${f.ineligible_type}`));
  const z = f.zoning_status ?? "legal";
  out.push(check("zoning", "B4-1.3-04 Site Section: legal, legal non-conforming (with adverse-effect analysis) or no zoning; illegal uses are ineligible", { zoning_status: z, adverse_effect_analyzed: f.nonconforming_adverse_effect_analyzed ?? null },
    z === "illegal" ? false : z === "legal_nonconforming" ? f.nonconforming_adverse_effect_analyzed === true : true, z === "illegal" ? "illegal use under the zoning regulations" : "legal non-conforming use without the appraisal's adverse-effect analysis"));
  out.push(check("coastal_setback", "B4-1.3-04: coastal tideland or wetland setback lines preventing reconstruction are ineligible", { setback_prevents_rebuild: f.setback_prevents_rebuild ?? false }, !(f.setback_prevents_rebuild ?? false), "setback line prevents reconstruction"));
  out.push(check("environmental_hazard", "B4-1.3-04: market resistance because of environmental hazards must be addressed in the appraisal", { addressed: f.environmental_hazard_addressed ?? null }, f.environmental_hazard_addressed === undefined || f.environmental_hazard_addressed === null ? null : f.environmental_hazard_addressed, "environmental hazard effect on value and marketability not addressed"));
  if (f.adu) {
    const k = f.adu.kitchen;
    out.push(check("adu_count", "B2-3-04: 'Only one ADU is permitted on the parcel of the primary one-unit dwelling. ADUs are not permitted with a two- to four-unit dwelling.'", { count: f.adu.count, units: f.units }, f.adu.count <= 1 && f.units === 1, f.units !== 1 ? "ADU with a two- to four-unit dwelling" : "more than one ADU"));
    out.push(check("adu_kitchen", "B2-3-04: kitchen minimum 'cabinets; a countertop; a sink with running water; and a stove or stove hookup'", { ...k }, k.cabinets && k.countertop && k.sink_running_water && k.stove_or_hookup, "ADU kitchen below the minimum"));
    out.push(check("adu_zoning", "B2-3-04: an ADU that violates zoning keeps the property eligible if the lender confirms it will not jeopardize insurance claims and appraisal requirements are met", { permitted: f.adu.permitted, insurance_claim_confirmed: f.adu.insurance_claim_confirmed ?? null, appraisal_analyzed: f.adu.appraisal_analyzed ?? null },
      f.adu.permitted || (f.adu.insurance_claim_confirmed === true && f.adu.appraisal_analyzed === true), "unpermitted ADU without the insurance-claim confirmation and appraisal analysis"));
  }
  if (f.parcels && f.parcels.count > 1) {
    const pr = f.parcels;
    out.push(check("multiple_parcels", "B2-3-04: each parcel conveyed in its entirety; adjoining (or road-separated with a documented non-buildable exception); same basic zoning; one dwelling; first lien on each", { ...pr }, pr.each_conveyed_entirely && pr.adjoining_or_road_separated && pr.same_basic_zoning && pr.one_dwelling && pr.first_lien_on_each,
      !pr.same_basic_zoning ? "parcels do not have the same basic zoning" : "multiple-parcel conditions not met"));
  }
  if (f.mixed_use) { const m = f.mixed_use; out.push(check("mixed_use", "B2-3-04: one-unit principal residence; borrower owns and operates the business; primarily residential; marketability not adversely impacted", { ...m }, m.one_unit_principal_residence && m.borrower_owns_and_operates && m.primarily_residential && m.marketability_unaffected, "mixed-use conditions not met")); }
  if (f.leasehold) {
    const l = f.leasehold; const term = f.loan_maturity_date ? leaseTermTest(l.lease_expiry, f.loan_maturity_date, rules.constants.lease_term_margin_years) : null;
    out.push(check("leasehold_term", "B2-3-03: 'The lease must have an unexpired term that exceeds the maturity date of the loan by five (5) years or more.'", { lease_expiry: l.lease_expiry, loan_maturity_date: f.loan_maturity_date ?? null, required_through: term?.required_through ?? null }, term ? term.pass : null, "lease term ends less than five years after loan maturity"));
    out.push(check("leasehold_clauses", "B2-3-03: recorded; assignable an unlimited number of times; lender notice and ≥ 30 days to cure / take over / foreclose", { recorded: l.recorded, assignable_unlimited: l.assignable_unlimited, lender_cure_rights_30d: l.lender_cure_rights_30d }, l.recorded && l.assignable_unlimited && l.lender_cure_rights_30d, "leasehold clauses missing"));
  }
  if (f.solar) {
    const s = f.solar;
    out.push(check("solar", "B2-3-04: leased/PPA panels — alternate power source, third party not a loss payee; financed with a senior UCC fixture filing — subordinated; PACE paid before or at closing", { ...s },
      s.ownership === "owned" || s.ownership === "personal_property" ? true : s.ownership === "leased_ppa" ? (s.alternate_power_source ?? true) && !(s.third_party_loss_payee ?? false) : (s.ucc_subordinated ?? false), s.ownership === "leased_ppa" ? "solar lease/PPA: third party named as loss payee or no alternate power source" : "financed solar: UCC fixture filing not subordinated"));
  }
  out.push(check("pace", "B2-3-04: 'not eligible for delivery to Fannie Mae if the PACE loan is not paid in full prior to or at closing'", { pace_lien: f.pace_lien ?? false, pace_paid_at_closing: f.pace_paid_at_closing ?? null }, !(f.pace_lien ?? false) || f.pace_paid_at_closing === true, "PACE lien not paid at or before closing"));
  out.push(check("hawaiian_lava_zone", "B2-3-04: Hawaiian lava zones 1 and 2 ineligible", { zone: f.hawaiian_lava_zone ?? null }, !(f.hawaiian_lava_zone === 1 || f.hawaiian_lava_zone === 2), `lava zone ${f.hawaiian_lava_zone}`));
  out.push(check("disaster", "B2-3-05 [UNVERIFIED — platform default]: post-disaster exterior inspection; reported damage repaired before sale", { disaster_flag: f.disaster_flag ?? false, inspection_clear: f.post_disaster_inspection_clear ?? null }, !(f.disaster_flag ?? false) ? null : f.post_disaster_inspection_clear === true, "post-disaster inspection outstanding"));
  return out;
}

// ============================================================ R2 — condition / quality routing (B4-1.3-05 / -06)
export type ConditionRating = "C1" | "C2" | "C3" | "C4" | "C5" | "C6";
export type QualityRating = "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "Q6";
export type RepairPath = "complete_before_sale" | "holdback" | "none";
export interface Deficiency { readonly item: string; readonly safety_related: boolean; readonly estimate_cents?: Cents | null; readonly in_sales_contract?: boolean; readonly delay_reason?: string | null; readonly occupancy_permit_affected?: boolean; readonly kind?: "infestation" | "dampness" | "settlement" | "other"; readonly corrected_evidence?: boolean; readonly professional_report_no_threat?: boolean; }
export interface Repair { readonly item: string; readonly safety_related: boolean; readonly estimate_cents: Cents | null; readonly path: RepairPath; readonly reason: string; }
export interface CompletionFacts { readonly subject_to_appraisal_received: boolean; readonly completion_evidence_accepted: boolean; readonly resulting_condition_rating: ConditionRating | null; }
export interface ConditionRoute { readonly result: Result; readonly repairs: readonly Repair[]; readonly subject_to_required: boolean; readonly reasons: readonly string[]; readonly citation: string; }
const ratingNo = (r: string | null | undefined): number => (r ? Number(r.slice(1)) : NaN);
/** R2: C1–C4 pass; C5 as-is unless a safety/soundness/structural item; C6 ineligible until repaired to ≥ C5 with a completion report; Q6 → safety items repaired. */
export function routeCondition(i: { condition_rating: ConditionRating | null; quality_rating?: QualityRating | null; as_is_or_subject_to?: "as_is" | "subject_to" | null; deficiencies?: readonly Deficiency[]; completion?: CompletionFacts | null }): ConditionRoute {
  const defs = i.deficiencies ?? [];
  const repairs = planRepairs(defs, { subject_to: i.as_is_or_subject_to === "subject_to" });
  const reasons: string[] = [];
  const safety = defs.filter((d) => d.safety_related);
  const c = ratingNo(i.condition_rating);
  const repairedToC5 = !!i.completion && i.completion.subject_to_appraisal_received && i.completion.completion_evidence_accepted && ratingNo(i.completion.resulting_condition_rating) <= 5;
  let result: Result = "eligible";
  if (c === 6 && !repairedToC5) { result = "ineligible"; reasons.push("B4-1.3-06: 'Loans secured by properties with a condition rating of C6 are not eligible for sale to Fannie Mae' until the deficiencies are repaired to at least C5 with a 'subject to' appraisal and completion evidence"); }
  else if (safety.length && !(i.completion?.completion_evidence_accepted ?? false)) { result = "eligible_with_conditions"; reasons.push(`B4-1.3-06: ${safety.length} deficiency(ies) impacting safety, soundness or structural integrity must be repaired prior to sale (minimum resulting rating C5)`); }
  if (i.quality_rating === "Q6" && !safety.length) reasons.push("B4-1.3-06: Q6 'eligible for sale to Fannie Mae provided any items affecting safety, soundness, or structural integrity are repaired' — none identified");
  for (const d of defs) if ((d.kind === "infestation" || d.kind === "dampness" || d.kind === "settlement") && !(d.corrected_evidence || d.professional_report_no_threat)) { if (result === "eligible") result = "eligible_with_conditions"; reasons.push(`B4-1.3-06: ${d.kind} requires satisfactory evidence of correction or a professionally prepared report`); }
  if (result === "eligible" && repairs.some((r) => r.path === "holdback")) result = "eligible_with_conditions";
  return { result, repairs, subject_to_required: safety.length > 0 || c === 6 || i.as_is_or_subject_to === "subject_to", reasons, citation: "B4-1.3-06 (06/04/2025); B4-1.3-05 (06/04/2025); B4-1.2-05 (12/10/2025)" };
}
/** Safety items → complete before sale (never a holdback); contract items delayed for a valid reason without occupancy-permit effect → holdback; other "subject to" items → complete before sale. */
export function planRepairs(defs: readonly Deficiency[], o: { subject_to?: boolean } = {}): Repair[] {
  return defs.map((d) => {
    const est = d.estimate_cents ?? null;
    if (d.safety_related) return { item: d.item, safety_related: true, estimate_cents: est, path: "complete_before_sale", reason: "B4-1.3-05: 'any issues affecting the safety, soundness, or structural integrity are repaired before delivery' — cannot be postponed" };
    const postponable = (d.in_sales_contract ?? false) && !!d.delay_reason && !(d.occupancy_permit_affected ?? false);
    if (postponable) return { item: d.item, safety_related: false, estimate_cents: est, path: "holdback", reason: `B4-1.2-05: contract item postponed for a valid reason (${d.delay_reason}); occupancy permit unaffected` };
    if (o.subject_to) return { item: d.item, safety_related: false, estimate_cents: est, path: "complete_before_sale", reason: "B4-1.2-05: 'subject to' item that is not an eligible postponed improvement — completion evidence before delivery" };
    return { item: d.item, safety_related: false, estimate_cents: est, path: "none", reason: "minor deferred maintenance not affecting safety, soundness or structural integrity — no completion required" };
  });
}
export class HoldbackRefused extends Error { readonly code: string; constructor(code: string, msg: string) { super(`${code}: ${msg}`); this.name = "HoldbackRefused"; this.code = code; } }
/** Guardrail: a safety-related item can never enter a holdback (never waive a safety-related repair). */
export function assertHoldbackEligible(items: readonly Deficiency[]): void {
  const bad = items.filter((d) => d.safety_related || (d.occupancy_permit_affected ?? false) || !(d.in_sales_contract ?? false) || !d.delay_reason);
  if (bad.length) throw new HoldbackRefused("SAFETY_ITEM_NOT_POSTPONABLE", `${bad.map((d) => d.item).join(", ")}: safety/soundness items, items affecting the occupancy permit and non-contract items must be completed before sale (B4-1.2-05; B4-1.3-05)`);
}

// ============================================================ R3 — holdback arithmetic, funding, completion, release, overdue sweep
export type HoldbackStatus = "established" | "in_progress" | "completed" | "released" | "overdue";
export type CompletionEvidenceKind = "form_1004d" | "uad36_completion_report" | "form_1004d_virtual" | "attestation_letter_with_evidence" | "professional_inspection_report";
export interface EscrowHoldback {
  readonly holdback_id: string; readonly application_id: string; readonly loan_id: string | null; readonly kind: "postponed_new_construction" | "postponed_existing_minor"; readonly items: readonly Deficiency[];
  readonly estimate_cents: Cents; readonly fixed_price_contract: boolean; readonly contract_cents: Cents | null; readonly escrow_cents: Cents; readonly custodial_account_id: string | null; readonly funded_at: string | null;
  readonly note_date: PlainDate; readonly completion_due_on: PlainDate; readonly completion_evidence_kind: CompletionEvidenceKind | null; readonly completion_document_id: string | null; readonly completed_at: string | null; readonly final_draw_released_at: string | null;
  readonly status: HoldbackStatus; readonly rule_set_version: string;
}
/** `escrow_cents = fixed_price_contract ? contract_cents : ceil(estimate × 1.20)`; `completion_due_on = note_date + 180 calendar days`. */
export function computeHoldback(i: { estimate_cents: Cents; fixed_price_contract: boolean; contract_cents?: Cents | null; note_date: PlainDate }, c = FNMA_SELLING_2026_09_02.constants): { escrow_cents: Cents; completion_due_on: PlainDate; basis: string } {
  if (i.estimate_cents <= 0n) throw new RangeError("estimate_cents must be > 0");
  if (i.fixed_price_contract) { if (!i.contract_cents || i.contract_cents <= 0n) throw new RangeError("a guaranteed fixed-price contract needs contract_cents"); return { escrow_cents: i.contract_cents, completion_due_on: addDays(i.note_date, c.holdback_completion_days), basis: "B4-1.2-05: 'full amount of the contract price' under a guaranteed fixed-price contract" }; }
  return { escrow_cents: ceilDiv(i.estimate_cents * BigInt(c.holdback_escrow_bp), 10_000n), completion_due_on: addDays(i.note_date, c.holdback_completion_days), basis: "B4-1.2-05: 'Funds equal to 120% of the estimated cost for completing the improvements'" };
}
export function establishHoldback(events: EventStore, i: { application_id: string; loan_id?: string | null; kind: EscrowHoldback["kind"]; items: readonly Deficiency[]; estimate_cents: Cents; fixed_price_contract: boolean; contract_cents?: Cents | null; note_date: PlainDate; custodial_account_id?: string | null; funded_at?: string | null; rules?: ResolvedRules }, at: string, actor: Actor = AGENT_24_3): { holdback: EscrowHoldback; event: DomainEvent } {
  assertHoldbackEligible(i.items);
  const calc = computeHoldback(i, i.rules?.constants ?? FNMA_SELLING_2026_09_02.constants);
  const holdback: EscrowHoldback = { holdback_id: randomUUID(), application_id: i.application_id, loan_id: i.loan_id ?? null, kind: i.kind, items: i.items, estimate_cents: i.estimate_cents, fixed_price_contract: i.fixed_price_contract, contract_cents: i.contract_cents ?? null, escrow_cents: calc.escrow_cents,
    custodial_account_id: i.custodial_account_id ?? null, funded_at: i.funded_at ?? null, note_date: i.note_date, completion_due_on: calc.completion_due_on, completion_evidence_kind: null, completion_document_id: null, completed_at: null, final_draw_released_at: null, status: "established", rule_set_version: i.rules?.rule_set_version ?? RULE_SET_VERSION };
  const event = emit(events, i.application_id, "holdback.established", { holdback_id: holdback.holdback_id, kind: holdback.kind, note_date: holdback.note_date, estimate_cents: holdback.estimate_cents, escrow_cents: holdback.escrow_cents, completion_due_on: holdback.completion_due_on, items: holdback.items.map((d) => d.item), basis: calc.basis }, at, actor, holdback.loan_id);
  return { holdback, event };
}
/** 30.2's loan sub-account (baseline §5) — the same AccountRef openingLedgerLines uses. */
export const holdbackEscrowAccount = (loanId: string): AccountRef => ({ scope: "loan", loanId, account: "holdback_escrow" });
/** Funding (26.3): Dr custodial_ti_prepurchase_cash / Cr holdback_escrow — mirrors 30.2:opening:holdback_cash / holdback_escrow. */
export function holdbackFundingLines(loanId: string, prepurchaseTiAccountId: string, escrowCents: Cents): LineInput[] {
  if (escrowCents <= 0n) throw new RangeError("holdback escrow must be > 0");
  return [{ account: prepurchaseTiCash(prepurchaseTiAccountId), amountCents: escrowCents, ruleRef: "24.3:holdback:fund_cash", memo: "seller/borrower funds deposited to the custodial holdback account at closing" },
    { account: holdbackEscrowAccount(loanId), amountCents: -escrowCents, ruleRef: "24.3:holdback:escrow_liability", memo: "B4-1.2-05 postponed-improvement escrow" }];
}
export function fundHoldback(ledger: Ledger, h: EscrowHoldback, loanId: string, prepurchaseTiAccountId: string, effectiveDate: PlainDate, at: string, sourceEventId?: string): EntrySet {
  return ledger.post({ effectiveDate, description: `24.3 holdback ${h.holdback_id} funded (${h.escrow_cents} cents)`, lines: holdbackFundingLines(loanId, prepurchaseTiAccountId, h.escrow_cents), ...(sourceEventId ? { sourceEventId } : {}) }, at);
}
export interface CompletionEvidence { readonly kind: CompletionEvidenceKind; readonly document_id: string; readonly received_at: string; readonly exhibits_geocoded?: boolean; readonly exhibits_metadata?: boolean; readonly resulting_condition_rating?: ConditionRating | null; }
/** B4-1.2-05: Form 1004D / UAD 3.6 Completion Report, or an alternative whose exhibits carry metadata and the subject's geocode. */
export function completionEvidenceAcceptable(ev: CompletionEvidence): { accepted: boolean; reason: string } {
  if (ev.kind === "form_1004d" || ev.kind === "uad36_completion_report") return { accepted: true, reason: "Form 1004D / UAD 3.6 Completion Report" };
  const ok = (ev.exhibits_geocoded ?? false) && (ev.exhibits_metadata ?? false);
  return { accepted: ok, reason: ok ? `${ev.kind} with visually verifiable exhibits carrying metadata and the subject's geocode` : `${ev.kind} requires 'visually verifiable exhibits' with 'metadata and geocode for the subject property'` };
}
export function acceptCompletionEvidence(events: EventStore, h: EscrowHoldback, ev: CompletionEvidence, at: string, actor: Actor = AGENT_24_3): { holdback: EscrowHoldback; event: DomainEvent; final_draw_due_on: PlainDate } {
  if (h.status === "completed" || h.status === "released") throw new HoldbackRefused("ALREADY_COMPLETED", `holdback ${h.holdback_id} is ${h.status}`);
  const a = completionEvidenceAcceptable(ev); if (!a.accepted) throw new HoldbackRefused("EVIDENCE_NOT_ACCEPTABLE", a.reason);
  const holdback: EscrowHoldback = { ...h, completion_evidence_kind: ev.kind, completion_document_id: ev.document_id, completed_at: ev.received_at, status: "completed" };
  const final_draw_due_on = finalDrawDueOn(civilDate(ev.received_at));
  const event = emit(events, h.application_id, "holdback.completed", { holdback_id: h.holdback_id, completed_at: ev.received_at, evidence_kind: ev.kind, completion_document_id: ev.document_id, final_draw_due_on, late: civilDate(ev.received_at) > h.completion_due_on }, at, actor, h.loan_id);
  return { holdback, event, final_draw_due_on };
}
export const finalDrawDueOn = (completedOn: PlainDate, n: number = FNMA_SELLING_2026_09_02.constants.final_draw_business_days): PlainDate => addBusinessDays(completedOn, n, servicer);
/** Release of the final draw only after accepted completion evidence (guardrail: never release holdback funds without accepted evidence). */
export function releaseFinalDraw(events: EventStore, h: EscrowHoldback, i: { released_at: string; loan_id?: string | null; ledger?: Ledger | null; prepurchase_ti_account_id?: string | null }, actor: Actor = AGENT_24_3): { holdback: EscrowHoldback; event: DomainEvent; entry_set: EntrySet | null } {
  if (h.status !== "completed" || !h.completion_document_id) throw new HoldbackRefused("RELEASE_WITHOUT_EVIDENCE", `holdback ${h.holdback_id} has no accepted completion evidence (status ${h.status})`);
  const loanId = i.loan_id ?? h.loan_id;
  let entry_set: EntrySet | null = null;
  if (i.ledger && loanId && i.prepurchase_ti_account_id) entry_set = i.ledger.post({ effectiveDate: civilDate(i.released_at), description: `24.3 holdback ${h.holdback_id} final draw released`, lines: [
    { account: holdbackEscrowAccount(loanId), amountCents: h.escrow_cents, ruleRef: "24.3:holdback:release_escrow" }, { account: prepurchaseTiCash(i.prepurchase_ti_account_id), amountCents: -h.escrow_cents, ruleRef: "24.3:holdback:release_cash", memo: "final draw to the contractor/borrower after accepted completion evidence" }] }, i.released_at);
  const holdback: EscrowHoldback = { ...h, loan_id: loanId ?? null, final_draw_released_at: i.released_at, status: "released" };
  const event = emit(events, h.application_id, "holdback.released", { holdback_id: h.holdback_id, released_at: i.released_at, amount_cents: h.escrow_cents, entry_set_id: entry_set?.id ?? null }, i.released_at, actor, loanId);
  return { holdback, event, entry_set };
}
export interface EscalationOpener { open(input: { kind: "officer"; applicationId?: string; loanId?: string; severity?: string; payload?: Record<string, unknown> }, by: Actor): { id: string }; }
/** Day-180 sweep: `holdback.overdue` on completion_due_on + 1 with a sev-1 `officer` escalation and the 28.4 self-report assessment flag. */
export function sweepHoldbacks(events: EventStore, escalations: EscalationOpener | null, holdbacks: readonly EscrowHoldback[], today: PlainDate, at: string, actor: Actor = AGENT_24_3): { overdue: EscrowHoldback[]; events: DomainEvent[]; escalation_ids: string[] } {
  const overdue: EscrowHoldback[] = [], out: DomainEvent[] = [], escalation_ids: string[] = [];
  for (const h of holdbacks) {
    if (h.status !== "established" && h.status !== "in_progress") continue;
    if (today <= h.completion_due_on) continue;
    const next: EscrowHoldback = { ...h, status: "overdue" }; overdue.push(next);
    out.push(emit(events, h.application_id, "holdback.overdue", { holdback_id: h.holdback_id, completion_due_on: h.completion_due_on, overdue_on: today, days_overdue: daysBetween(h.completion_due_on, today), escrow_cents: h.escrow_cents, qc_self_report_assessment: "28.4", severity: 1 }, at, actor, h.loan_id));
    if (escalations) escalation_ids.push(escalations.open({ kind: "officer", applicationId: h.application_id, ...(h.loan_id ? { loanId: h.loan_id } : {}), severity: "sev1", payload: { reason: "holdback_overdue", holdback_id: h.holdback_id, completion_due_on: h.completion_due_on, breach: "sev 1 → officer; QC self-report assessment (28.4)" } }, actor).id);
  }
  return { overdue, events: out, escalation_ids };
}

// ============================================================ R4 — project review (B4-2.1-01/-02/-03, B4-2.2-01/-02, B4-2.3-01)
export type ProjectType = "condo" | "pud" | "mh_condo" | "mh_pud";
export type ProjectStatus = "new" | "established";
export type ReviewType = "full_cpm" | "full_no_cpm" | "pers" | "fha" | "waived" | "pud_waived" | "limited_legacy";
export type ProjectReviewState = "not_required" | "pending_docs" | "in_review" | "cpm_entry_pending" | "certified" | "waived" | "ineligible" | "expired";
export type ProjectTypeCode = "E" | "F" | "R" | "S" | "T" | "U" | "V";
export type CpmStatus = "approved_by_fnma" | "lender_certified" | "unavailable" | "not_found";
export interface SpecialAssessment { readonly purpose: string; readonly approved_on: PlainDate | null; readonly planned_or_executing: "planned" | "approved" | "executing"; readonly original_cents: Cents; readonly remaining_cents: Cents; readonly per_unit_cents: Cents; readonly paid_in_full_by: PlainDate | null; readonly related_to_critical_repair: boolean; readonly remediated?: boolean; readonly delinquency_pct_bp?: number; readonly monthly_installment_cents?: Cents; readonly likely_for_critical_repair?: boolean; }
export interface InspectionReport { readonly date: PlainDate; readonly kind: string; readonly findings: string; readonly critical?: boolean | null; readonly reviewed: boolean; readonly document_id?: string; }
export interface Litigation { readonly description: string; readonly safety_or_habitability: boolean; readonly non_monetary?: boolean; readonly claim_cents?: Cents; }
export interface ReserveStudy { readonly date: PlainDate; readonly highest_recommended_cents: Cents; readonly method: "component" | "threshold" | "baseline" | "other"; readonly highest_recommended_budgeted: boolean; }
export interface ProjectFacts {
  readonly project_type: ProjectType; readonly project_name?: string; readonly project_id?: string | null;
  readonly unit_detached?: boolean; readonly units_total: number; readonly units_conveyed?: number; readonly complete?: boolean; readonly hoa_control_transferred?: boolean; readonly part_of_master_association?: boolean;
  readonly fnma_to_fnma_lcor?: boolean; readonly ltv_bp?: number | null; readonly requested_review_type?: ReviewType | null; readonly developer_control?: boolean;
  readonly ineligible_characteristics?: { condotel?: boolean; timeshare_or_segmented?: boolean; houseboat?: boolean; continuing_care?: boolean; mandatory_rental_pooling?: boolean; terminating_or_insolvent?: boolean };
  readonly litigation?: readonly Litigation[]; readonly single_entity_max_units?: number; readonly commercial_pct_bp?: number; readonly delinquent_60_units?: number; readonly presale_conveyed_or_contract_pct_bp?: number | null; readonly one_phase_per_building?: boolean;
  readonly special_assessments?: readonly SpecialAssessment[]; readonly inspection_reports?: readonly InspectionReport[]; readonly unfunded_repairs_per_unit_cents?: Cents; readonly evacuation_order?: boolean; readonly regulatory_action?: boolean;
  readonly annual_assessment_income_cents?: Cents; readonly reserve_allocation_cents?: Cents; readonly reserve_study?: ReserveStudy | null;
  readonly questionnaire_date?: PlainDate | null; readonly budget_date?: PlainDate | null; readonly questionnaire_kind?: "form_1076_2016_addendum_2021" | "equivalent" | null; readonly deferred_maintenance_evidence?: boolean;
  readonly lien_priority_months?: number | null; readonly cpm?: { status: CpmStatus; expires_on: PlainDate | null } | null;
}
export interface ReviewSelection { readonly review_type: ReviewType; readonly project_type_code: ProjectTypeCode; readonly reason: string; readonly critical_repair_review_required: boolean; readonly cpm_required: boolean; }
/** B4-2.1-01 established: ≥ 90% conveyed, 100% complete, HOA control transferred. */
export function projectStatus(f: ProjectFacts, c = FNMA_SELLING_2026_09_02.constants): ProjectStatus {
  const conveyedBp = f.units_total > 0 ? ratioBp(BigInt(f.units_conveyed ?? 0), BigInt(f.units_total)) : 0;
  return conveyedBp >= c.established_conveyed_min_bp && (f.complete ?? false) && (f.hoa_control_transferred ?? false) ? "established" : "new";
}
const codeFor = (rt: ReviewType, status: ProjectStatus, f: ProjectFacts): ProjectTypeCode => rt === "waived" ? "V" : rt === "pud_waived" ? (f.developer_control ? "F" : "E") : rt === "pers" ? "T" : rt === "fha" ? "U" : status === "new" ? "R" : "S";
/** B4-2.1-02 waiver tests, the master-association exception (FAQs) and the Aug 3, 2026 retirement of Limited Review. */
export function selectReviewType(f: ProjectFacts, rules: ResolvedRules): ReviewSelection {
  const status = projectStatus(f, rules.constants), c = rules.constants;
  const mh = f.project_type === "mh_condo" || f.project_type === "mh_pud";
  if (f.requested_review_type === "limited_legacy") {
    if (!rules.limited_review_allowed) return { review_type: "full_cpm", project_type_code: codeFor("full_cpm", status, f), reason: `limited_legacy not allowed: ${FNMA_SELLING_2026_09_02.switches[0]!.citation}`, critical_repair_review_required: true, cpm_required: true };
    return { review_type: "limited_legacy", project_type_code: codeFor("full_cpm", status, f), reason: `application_date ${rules.application_date} < 2026-08-03 — Limited Review (archived LTV limits) still permitted`, critical_repair_review_required: true, cpm_required: false };
  }
  if (f.requested_review_type === "pers" || f.requested_review_type === "fha") return { review_type: f.requested_review_type, project_type_code: codeFor(f.requested_review_type, status, f), reason: f.requested_review_type === "pers" ? "B4-2.2-04 PERS (officer submission)" : "B4-2.2-03 FHA-approved project", critical_repair_review_required: false, cpm_required: false };
  if (f.project_type === "pud" || f.project_type === "mh_pud") {
    if (f.project_type === "mh_pud") return { review_type: "full_no_cpm", project_type_code: codeFor("full_no_cpm", status, f), reason: "B4-2.1-02: waiver 'except for PUD projects consisting of manufactured homes' — reviewed subject to B5-5.2", critical_repair_review_required: true, cpm_required: false };
    return { review_type: "pud_waived", project_type_code: codeFor("pud_waived", status, f), reason: "B4-2.3-01 PUD: automatic nonseverable HOA membership, mandatory assessments, HOA-owned common property — review waived", critical_repair_review_required: false, cpm_required: false };
  }
  const waived = (reason: string, critical = false): ReviewSelection => ({ review_type: "waived", project_type_code: "V", reason, critical_repair_review_required: critical, cpm_required: false });
  if (f.unit_detached) return waived("B4-2.1-02: detached unit — 'completely detached from other condo units in the project'");
  if (f.units_total >= 2 && f.units_total <= 4) return waived("B4-2.1-02: 'Project review is waived for new and established condo projects' of two to four units");
  if (f.units_total >= 5 && f.units_total <= c.waiver_max_units) {
    if (f.part_of_master_association) return { review_type: mh ? "full_no_cpm" : "full_cpm", project_type_code: codeFor("full_cpm", status, f), reason: "FAQs: 'For a 5-to-10 unit attached condo project that is part of a Master Association, the project must be reviewed under the Full Review process.'", critical_repair_review_required: true, cpm_required: !mh };
    return waived("B4-2.1-02 / LL-2026-03: 'Unit in a five- to ten-unit condo project that is not part of a larger development or master association' — waiver; B2-3 and ineligible-characteristics checks still run");
  }
  if ((f.fnma_to_fnma_lcor ?? false) && (f.ltv_bp ?? 10_001) <= c.fnma_to_fnma_lcor_max_ltv_bp) return waived("B4-2.1-02: Fannie Mae-to-Fannie Mae limited cash-out refinance 'with a maximum loan-to-value ratio of 80%'", f.units_total >= 11);
  return { review_type: mh ? "full_no_cpm" : "full_cpm", project_type_code: codeFor("full_cpm", status, f), reason: mh ? "B4-2.2-01: CPM 'except for projects containing manufactured homes'" : "B4-2.2-01: lenders 'must use CPM to assist in their Full Review of a condo project'", critical_repair_review_required: true, cpm_required: !mh };
}
/** B4-2.2-01: reserve_pct = annual budgeted replacement reserve allocation ÷ annual budgeted assessment income (4 places). */
export function reservePct(allocationCents: Cents, incomeCents: Cents): { reserve_pct: number; bp10k: number } { const bp10k = ratioBp(allocationCents, incomeCents); return { reserve_pct: bp10k / 10_000, bp10k }; }
export function requiredReserveCents(incomeCents: Cents, minBp: number): Cents { return ceilDiv(incomeCents * BigInt(minBp), 10_000n); }
const CRITICAL_WORDS = /\b(mold|water intrusion|active leak|potentially damaging leak|leaks? into|structural (?:failure|deficien|damage)|advanced (?:physical )?deterioration|evacuation|failed (?:mandatory )?inspection|unsafe|collapse)\b/i;
/** B4-2.1-03 critical repairs: mold / water intrusion / damaging leaks, advanced deterioration, failed mandatory inspections, system failure within a year. */
export function classifyInspection(r: InspectionReport): { critical: boolean; basis: string } {
  if (r.critical === true) return { critical: true, basis: "report flagged critical" };
  if (r.critical === false) return { critical: false, basis: "report flagged not critical" };
  // Negated findings ("no active leaks, no water intrusion, no structural findings") are not critical (R4 Branch A).
  const m = CRITICAL_WORDS.exec(r.findings.replace(/\bno\s+(?:active\s+|potentially\s+damaging\s+)?(?:leaks?|water\s+intrusions?|mold|structural\s+\w+|evacuation\s+\w+|unsafe\s+\w+)\b/gi, ""));
  return m ? { critical: true, basis: `B4-2.1-03: '${m[0]}' — 'any mold, water intrusions or potentially damaging leaks to the project's building(s)' is a critical repair` } : { critical: false, basis: "routine / normal capital replacement" };
}
export function inspectionLookbackWindow(reviewedOn: PlainDate, years: number = FNMA_SELLING_2026_09_02.constants.inspection_lookback_years): { from: PlainDate; to: PlainDate } { return { from: addYears(reviewedOn, -years), to: reviewedOn }; }
export const inspectionsInWindow = (reports: readonly InspectionReport[], reviewedOn: PlainDate, years?: number): InspectionReport[] => { const w = inspectionLookbackWindow(reviewedOn, years); return reports.filter((r) => r.date >= w.from && r.date <= w.to); };
export const SA_CRITICAL_REASON = "special assessment associated with unremediated critical repair";
export interface ProjectTestResult { readonly tests: readonly Check[]; readonly result: Result; readonly ineligible_reasons: readonly string[]; readonly critical_repairs: readonly { source: string; finding: string }[]; readonly reserve: { reserve_pct: number; required_cents: Cents; min_bp: number; via_reserve_study: boolean } | null; readonly docs_as_of: PlainDate | null; readonly docs_fresh: boolean | null; readonly unreviewed_inspections: number; readonly citations: readonly string[]; }
/** Every B4-2.1-03 / B4-2.2-01 / -02 test with the dated rule set applied (reviewedOn = the lender's project review date). */
export function runProjectTests(f: ProjectFacts, rules: ResolvedRules, reviewedOn: PlainDate, sel: ReviewSelection = selectReviewType(f, rules)): ProjectTestResult {
  const c = rules.constants, tests: Check[] = [], reasons: string[] = [], citations = new Set<string>();
  const status = projectStatus(f, c);
  const ic = f.ineligible_characteristics ?? {};
  const icHit = [ic.condotel && "condo hotel or motel", ic.timeshare_or_segmented && "timeshare or segmented ownership", ic.houseboat && "houseboat project", ic.continuing_care && "continuing care community", ic.mandatory_rental_pooling && "mandatory rental pooling", ic.terminating_or_insolvent && "terminating or in insolvency proceedings"].filter((x): x is string => !!x);
  tests.push(check("ineligible_characteristics", "B4-2.1-03 Ineligible Projects; B4-2.1-02 basic requirements still apply to waived projects", { hits: icHit }, icHit.length === 0, `ineligible project characteristic: ${icHit.join(", ")}`));
  tests.push(check("lien_priority", "B4-2.1-01: 'No more than six months of regular common expense assessments may have priority over Fannie Mae's mortgage lien' (jurisdiction_rules.condo_lien_priority)", { months: f.lien_priority_months ?? null }, f.lien_priority_months === undefined || f.lien_priority_months === null ? null : f.lien_priority_months <= c.lien_priority_months_max, "state super-lien exceeds six months — legal review"));
  if (sel.review_type === "waived" && !sel.critical_repair_review_required || sel.review_type === "pud_waived" || sel.review_type === "fha" || sel.review_type === "pers") {
    const failed = tests.filter((t) => t.outcome === "fail"); for (const t of failed) reasons.push(t.reason ?? t.rule);
    return { tests, result: failed.length ? "ineligible" : "eligible", ineligible_reasons: reasons, critical_repairs: [], reserve: null, docs_as_of: null, docs_fresh: null, unreviewed_inspections: 0, citations: ["B4-2.1-02 (08/05/2026)", "B4-2.1-03 (08/05/2026)"] };
  }
  // --- full review (with or without CPM), limited_legacy, and the waived-but-critical-repair-review cases
  citations.add("B4-2.1-03 (08/05/2026)"); citations.add("B4-2.2-01 (08/05/2026)");
  const lit = f.litigation ?? [];
  const litBad = lit.filter((l) => l.safety_or_habitability && !(l.non_monetary ?? false) && !(l.claim_cents !== undefined && f.reserve_allocation_cents !== undefined && l.claim_cents * 10_000n <= f.reserve_allocation_cents * BigInt(c.litigation_reserve_exception_bp)));
  tests.push(check("litigation", "B4-2.1-03: litigation 'relating to safety, structural soundness, habitability, or functional use' (minor exceptions: non-monetary; claims ≤ 10% of funded reserves)", { count: lit.length, disqualifying: litBad.length }, litBad.length === 0, "construction-defect / safety litigation without the minor-litigation exception"));
  const seMax = f.units_total >= 21 ? Math.floor((f.units_total * c.single_entity_max_bp_21_plus) / 10_000) : c.single_entity_max_units_5_to_20;
  tests.push(check("single_entity", "B4-2.1-03: 5–10 units: 2 units; 11–20 units: 2 units; 21 or more units: 20%", { single_entity_max_units: f.single_entity_max_units ?? 0, limit_units: seMax, pct_bp: f.units_total ? ratioBp(BigInt(f.single_entity_max_units ?? 0), BigInt(f.units_total)) : 0 }, (f.single_entity_max_units ?? 0) <= seMax, "single-entity ownership above the limit"));
  tests.push(check("commercial_space", "B4-2.1-03: commercial space 'No more than 35%'", { commercial_pct_bp: f.commercial_pct_bp ?? 0 }, (f.commercial_pct_bp ?? 0) <= c.commercial_max_bp, "commercial space above 35%"));
  const delqBp = f.units_total ? ratioBp(BigInt(f.delinquent_60_units ?? 0), BigInt(f.units_total)) : 0;
  tests.push(check("delinquency_60", "B4-2.2-01: 'No more than 15% of the total units in a project are 60 days or more past due on common expense assessments.'", { delinquent_60_units: f.delinquent_60_units ?? 0, units_total: f.units_total, pct_bp: delqBp }, delqBp <= c.delinquency_60_max_bp, "regular-assessment delinquency above 15%"));
  if (status === "new") {
    citations.add("B4-2.2-02 (08/05/2026)");
    tests.push(check("presale", "B4-2.2-02: 'At least 50% of the total units in the project or subject legal phase must have been conveyed or be under contract for sale to principal residence or second home purchasers.'", { presale_pct_bp: f.presale_conveyed_or_contract_pct_bp ?? null }, (f.presale_conveyed_or_contract_pct_bp ?? 0) >= c.presale_min_bp_new, "presale below 50%"));
    tests.push(check("legal_phase", "B4-2.2-02: 'There may not be more than one legal phase per building.'", { one_phase_per_building: f.one_phase_per_building ?? true }, f.one_phase_per_building ?? true));
  }
  // --- inspections in the 3-year look-back (guardrail: never eligible with an unreviewed in-window report)
  const inWindow = inspectionsInWindow(f.inspection_reports ?? [], reviewedOn, c.inspection_lookback_years);
  const unreviewed = inWindow.filter((r) => !r.reviewed);
  tests.push(check("inspection_lookback", "B4-2.1-03: 'If a structural and/or mechanical inspection was completed within 3 years of the lender's project review date, the lender must obtain and review the inspection report'", { in_window: inWindow.length, unreviewed: unreviewed.length, window: inspectionLookbackWindow(reviewedOn, c.inspection_lookback_years) }, unreviewed.length === 0, "in-window inspection report not yet reviewed — review cannot complete"));
  const critical: { source: string; finding: string }[] = [];
  for (const r of inWindow.filter((r) => r.reviewed)) { const k = classifyInspection(r); if (k.critical) critical.push({ source: `${r.kind} ${r.date}`, finding: k.basis }); }
  if ((f.unfunded_repairs_per_unit_cents ?? 0n) > c.unfunded_repair_per_unit_cents) critical.push({ source: "budget", finding: "B4-2.1-03: 'any unfunded repairs costing more than $10,000 per unit that should be undertaken within the next 12 months'" });
  tests.push(check("critical_repairs", "B4-2.1-03: 'The report cannot indicate that any critical repairs are needed, no evacuation orders are in effect, and no regulatory actions are required'", { critical: critical.map((x) => x.finding), evacuation_order: f.evacuation_order ?? false, regulatory_action: f.regulatory_action ?? false }, critical.length === 0 && !(f.evacuation_order ?? false) && !(f.regulatory_action ?? false), "critical repairs needed, evacuation order in effect or regulatory action required — 'Project is ineligible until the required repairs have been completed and documented accordingly.'"));
  // --- special assessments (each reviewed for purpose / approval / amounts / payoff date; tied to an unremediated critical repair → ineligible)
  for (const sa of f.special_assessments ?? []) {
    const tied = sa.related_to_critical_repair || (sa.likely_for_critical_repair ?? false) || (critical.length > 0 && /roof|leak|water|structur|mold|habitab|safety/i.test(sa.purpose));
    const routine = !tied;
    tests.push(check(`special_assessment:${sa.purpose}`, "B4-2.1-03: purpose, approval, planned/executing, original and remaining amount, payoff date; 'If the special assessment is associated with a critical repair and the issue is not remediated, the project is ineligible'; FAQs: routine capital replacements 'funded … through special assessments that are within guidelines' are not critical",
      { purpose: sa.purpose, approved_on: sa.approved_on, planned_or_executing: sa.planned_or_executing, original_cents: sa.original_cents, remaining_cents: sa.remaining_cents, per_unit_cents: sa.per_unit_cents, paid_in_full_by: sa.paid_in_full_by, related_to_critical_repair: tied, remediated: sa.remediated ?? false, per_unit_unfunded_test: `${sa.per_unit_cents} < ${c.unfunded_repair_per_unit_cents} and funded`, routine },
      routine || (sa.remediated ?? false), SA_CRITICAL_REASON));
    if (sa.delinquency_pct_bp !== undefined) tests.push(check(`special_assessment_delinquency:${sa.purpose}`, "FAQs: special-assessment delinquency computed separately from the 15% regular-assessment test (recorded)", { delinquency_pct_bp: sa.delinquency_pct_bp }, true));
  }
  // --- reserves with the dated minimum (10% → 15% for Full Review applications on/after Jan 4, 2027) and the ≤ 3-year reserve-study exception
  let reserve: ProjectTestResult["reserve"] = null;
  if (f.annual_assessment_income_cents !== undefined && f.reserve_allocation_cents !== undefined) {
    const rp = reservePct(f.reserve_allocation_cents, f.annual_assessment_income_cents);
    const required = requiredReserveCents(f.annual_assessment_income_cents, rules.reserve_min_bp);
    const meets = f.reserve_allocation_cents * 10_000n >= f.annual_assessment_income_cents * BigInt(rules.reserve_min_bp);
    const study = f.reserve_study ?? null;
    const studyInWindow = !!study && daysBetween(study.date, reviewedOn) >= 0 && study.date >= addYears(reviewedOn, -c.reserve_study_max_age_years);
    const studyMethodOk = !!study && (study.method !== "baseline" || rules.reserve_study_baseline_allowed);
    const viaStudy = !meets && !!study && studyInWindow && studyMethodOk && study.highest_recommended_budgeted && f.reserve_allocation_cents >= study.highest_recommended_cents;
    const minSwitch = rules.switches_applied.find((s) => s.key === "reserve_min_bp");
    reserve = { reserve_pct: rp.reserve_pct, required_cents: required, min_bp: rules.reserve_min_bp, via_reserve_study: viaStudy };
    tests.push(check("reserves", `B4-2.2-01: replacement reserves 'at least 10% of the budget'; 'Special assessments cannot be used in lieu of the 10% budget reserve allocation.'${minSwitch ? `; ${minSwitch.citation}` : ""}`,
      { annual_assessment_income_cents: f.annual_assessment_income_cents, reserve_allocation_cents: f.reserve_allocation_cents, reserve_pct: rp.reserve_pct, minimum_bp: rules.reserve_min_bp, required_allocation_cents: required, reserve_study: study ? { date: study.date, method: study.method, in_window: studyInWindow, highest_recommended_cents: study.highest_recommended_cents, budgeted: study.highest_recommended_budgeted } : null, switch: minSwitch ? `${minSwitch.key}=${String(minSwitch.value)}@${minSwitch.effective_from}` : null },
      meets || viaStudy, `reserves ${(rp.bp10k / 100).toFixed(2)}% < ${rules.reserve_min_bp / 100}% minimum (${required} cents required)${minSwitch ? ` — ${minSwitch.citation.split(":")[0]}` : ""}${study && !studyInWindow ? "; reserve study older than three years" : study && !studyMethodOk ? "; baseline funding methodology not permitted" : study ? "" : "; no reserve study"}`));
    if (minSwitch) citations.add("LL-2026-03 (03/18/2026)");
  }
  // --- document age (24.3-Q1 policy: questionnaire / budget ≤ 120 calendar days at review)
  const docDates = [f.questionnaire_date, f.budget_date].filter((d): d is PlainDate => !!d);
  const docs_as_of = docDates.length ? docDates.reduce((a, b) => (b < a ? b : a)) : null;
  const docs_fresh = docs_as_of ? daysBetween(docs_as_of, reviewedOn) <= c.docs_age_max_days : null;
  tests.push(check("docs_age", "SM_PROJECT_DOCS_AGE_120 (24.3-Q1 policy; Fannie Mae states four months for PERS only): questionnaire / budget ≤ 120 calendar days old at review", { docs_as_of, reviewed_on: reviewedOn, age_days: docs_as_of ? daysBetween(docs_as_of, reviewedOn) : null }, docs_fresh, "project documents older than 120 days — request refresh"));
  tests.push(check("deferred_maintenance_evidence", "FAQs: 'Use of Form 1076 is optional; however, lenders are responsible for obtaining documentation to support the review for deferred maintenance and special assessments if Form 1076 is not used.'", { questionnaire_kind: f.questionnaire_kind ?? null, evidence: f.deferred_maintenance_evidence ?? (f.questionnaire_kind === "form_1076_2016_addendum_2021") }, (f.deferred_maintenance_evidence ?? (f.questionnaire_kind === "form_1076_2016_addendum_2021")) || f.questionnaire_kind === "equivalent", "deferred-maintenance evidence cannot be obtained — the project cannot be certified"));
  // --- CPM status (operator snapshot): 'Unavailable' → ineligible regardless of the lender's own analysis
  if (f.cpm) tests.push(check("cpm_status", "B4-2.1-03: 'Loans secured by units in projects with a status of Unavailable in Condo Project Manager (CPM)…are ineligible for purchase.'", { cpm_status: f.cpm.status, expires_on: f.cpm.expires_on }, f.cpm.status !== "unavailable", "CPM status Unavailable"));
  const failed = tests.filter((t) => t.outcome === "fail");
  for (const t of failed) if (t.reason && !reasons.includes(t.reason)) reasons.push(t.reason);
  // Guardrail: a special assessment tied to a safety/habitability repair is never routine — it leads the reasons (T3's `project.ineligible.determined{reason}`).
  reasons.sort((a, b) => (a === SA_CRITICAL_REASON ? -1 : b === SA_CRITICAL_REASON ? 1 : 0));
  const hardFail = failed.some((t) => t.rule !== "docs_age" && t.rule !== "inspection_lookback" && t.rule !== "lien_priority");
  const result: Result = hardFail ? "ineligible" : failed.length ? "eligible_with_conditions" : "eligible";
  return { tests, result, ineligible_reasons: hardFail ? reasons : [], critical_repairs: critical, reserve, docs_as_of, docs_fresh, unreviewed_inspections: unreviewed.length, citations: [...citations] };
}
export function projectExpiry(status: ProjectStatus, reviewedOn: PlainDate, cpmCertExpiresOn: PlainDate | null, c = FNMA_SELLING_2026_09_02.constants): PlainDate {
  const base = status === "established" ? addYears(reviewedOn, c.established_validity_years) : addDays(reviewedOn, c.new_validity_days);
  return cpmCertExpiresOn ? minDate(base, cpmCertExpiresOn) : base;
}
export interface ProjectReview {
  readonly project_review_id: string; readonly application_id: string; readonly project_id: string | null; readonly project_name: string | null; readonly project_type: ProjectType; readonly project_status: ProjectStatus; readonly review_type: ReviewType; readonly status: ProjectReviewState;
  readonly application_date: PlainDate; readonly units_total: number; readonly units_conveyed: number | null; readonly reserve_pct: number | null; readonly special_assessments: readonly SpecialAssessment[]; readonly critical_repairs: readonly { source: string; finding: string }[]; readonly inspection_reports: readonly InspectionReport[];
  readonly docs_as_of: PlainDate | null; readonly cpm_project_id: string | null; readonly cpm_phase_id: string | null; readonly cpm_certification_id: string | null; readonly cpm_status: CpmStatus | null; readonly cpm_recorded_by: string | null; readonly cpm_cert_expires_on: PlainDate | null;
  readonly project_type_code: ProjectTypeCode; readonly tests: readonly Check[]; readonly rule_set_version: string; readonly reviewed_at: string | null; readonly expires_at: PlainDate | null; readonly result: Result | null; readonly ineligible_reasons: readonly string[]; readonly citations: readonly string[];
}
export function startProjectReview(events: EventStore, i: { application_id: string; facts: ProjectFacts; rules: ResolvedRules; started_at: string; project_review_id?: string }, actor: Actor = AGENT_24_3): { review: ProjectReview; selection: ReviewSelection; event: DomainEvent | null } {
  const sel = selectReviewType(i.facts, i.rules);
  const reviewedOn = civilDate(i.started_at);
  const status = projectStatus(i.facts, i.rules.constants);
  const needsReview = sel.review_type !== "pud_waived" && !(sel.review_type === "waived" && !sel.critical_repair_review_required);
  const review: ProjectReview = { project_review_id: i.project_review_id ?? randomUUID(), application_id: i.application_id, project_id: i.facts.project_id ?? null, project_name: i.facts.project_name ?? null, project_type: i.facts.project_type, project_status: status, review_type: sel.review_type, status: needsReview ? "in_review" : "not_required",
    application_date: i.rules.application_date, units_total: i.facts.units_total, units_conveyed: i.facts.units_conveyed ?? null, reserve_pct: null, special_assessments: i.facts.special_assessments ?? [], critical_repairs: [], inspection_reports: i.facts.inspection_reports ?? [], docs_as_of: null,
    cpm_project_id: null, cpm_phase_id: null, cpm_certification_id: null, cpm_status: i.facts.cpm?.status ?? null, cpm_recorded_by: null, cpm_cert_expires_on: i.facts.cpm?.expires_on ?? null, project_type_code: sel.project_type_code, tests: [], rule_set_version: i.rules.rule_set_version, reviewed_at: null, expires_at: null, result: null, ineligible_reasons: [], citations: [] };
  const event = needsReview ? emit(events, i.application_id, "project.review.started", { project_review_id: review.project_review_id, review_type: sel.review_type, project_status: status, reviewed_at: reviewedOn, lookback_from: inspectionLookbackWindow(reviewedOn, i.rules.constants.inspection_lookback_years).from, reason: sel.reason }, i.started_at, actor) : null;
  return { review, selection: sel, event };
}
/** Run the tests; a waived / ineligible / no-CPM review completes now; a CPM-required review moves to `cpm_entry_pending` (the operator's recordCpmStatus completes it). */
export function runProjectEligibility(events: EventStore, review: ProjectReview, facts: ProjectFacts, rules: ResolvedRules, at: string, actor: Actor = AGENT_24_3): { review: ProjectReview; tests: ProjectTestResult; selection: ReviewSelection; events: DomainEvent[] } {
  const sel = selectReviewType(facts, rules);
  const reviewedOn = civilDate(at);
  const t = runProjectTests(facts, rules, reviewedOn, sel);
  const out: DomainEvent[] = [];
  const inWindow = inspectionsInWindow(facts.inspection_reports ?? [], reviewedOn, rules.constants.inspection_lookback_years);
  if (inWindow.length) out.push(emit(events, review.application_id, "project.inspection.reviewed", { project_review_id: review.project_review_id, all_in_window: t.unreviewed_inspections === 0, reviewed: inWindow.length - t.unreviewed_inspections, unreviewed: t.unreviewed_inspections, critical: t.critical_repairs.map((c) => c.finding) }, at, actor));
  if (facts.reserve_study && t.reserve && !(facts.reserve_allocation_cents! * 10_000n >= facts.annual_assessment_income_cents! * BigInt(rules.reserve_min_bp))) {
    out.push(emit(events, review.application_id, "project.reserve_study.used", { project_review_id: review.project_review_id, study_date: facts.reserve_study.date, method: facts.reserve_study.method, highest_recommended_cents: facts.reserve_study.highest_recommended_cents }, at, actor));
    out.push(emit(events, review.application_id, "project.reserve_study.accepted", { project_review_id: review.project_review_id, study_date: facts.reserve_study.date, in_window: t.reserve.via_reserve_study, accepted: t.reserve.via_reserve_study }, at, actor));
  }
  let next: ProjectReview = { ...review, project_status: projectStatus(facts, rules.constants), review_type: sel.review_type, project_type_code: sel.project_type_code, reserve_pct: t.reserve?.reserve_pct ?? null, special_assessments: facts.special_assessments ?? [], critical_repairs: t.critical_repairs, inspection_reports: facts.inspection_reports ?? [], docs_as_of: t.docs_as_of, tests: t.tests, rule_set_version: rules.rule_set_version, result: t.result, ineligible_reasons: t.ineligible_reasons, citations: t.citations, cpm_status: facts.cpm?.status ?? review.cpm_status, cpm_cert_expires_on: facts.cpm?.expires_on ?? review.cpm_cert_expires_on };
  if (t.result === "ineligible") {
    next = { ...next, status: "ineligible", reviewed_at: at, expires_at: null };
    out.push(emit(events, review.application_id, "project.ineligible.determined", { project_review_id: review.project_review_id, reason: t.ineligible_reasons[0] ?? "ineligible", reasons: t.ineligible_reasons, review_type: sel.review_type, critical_repairs: t.critical_repairs.map((c) => c.finding), rule_set_version: rules.rule_set_version }, at, actor));
    return { review: next, tests: t, selection: sel, events: out };
  }
  if (t.unreviewed_inspections > 0) return { review: { ...next, status: "in_review" }, tests: t, selection: sel, events: out }; // review cannot complete
  if (sel.cpm_required && next.cpm_status !== "lender_certified" && next.cpm_status !== "approved_by_fnma") return { review: { ...next, status: "cpm_entry_pending" }, tests: t, selection: sel, events: out };
  const done = completeProjectReview(events, next, at, actor);
  return { review: done.review, tests: t, selection: sel, events: [...out, done.event] };
}
/** `project.review.completed{established|new, reviewed_at, expires_at}` — the two validity deadlines arm from reviewed_at; SM_PROJECT_DOCS_AGE_120 closes on docs_fresh. */
export function completeProjectReview(events: EventStore, review: ProjectReview, at: string, actor: Actor = AGENT_24_3): { review: ProjectReview; event: DomainEvent } {
  const reviewedOn = civilDate(at);
  const expires_at = projectExpiry(review.project_status, reviewedOn, review.cpm_cert_expires_on);
  const docs_fresh = review.tests.find((t) => t.rule === "docs_age")?.outcome !== "fail";
  const status: ProjectReviewState = review.review_type === "waived" || review.review_type === "pud_waived" ? "waived" : "certified";
  const next: ProjectReview = { ...review, status, reviewed_at: at, expires_at, result: review.result ?? "eligible" };
  const event = emit(events, review.application_id, "project.review.completed", { project_review_id: review.project_review_id, project_status: review.project_status, established: review.project_status === "established", new: review.project_status === "new", reviewed_at: reviewedOn, expires_at, review_type: review.review_type, project_type_code: review.project_type_code, cpm_project_id: review.cpm_project_id, cpm_phase_id: review.cpm_phase_id, docs_fresh, result: next.result, reserve_pct: review.reserve_pct, rule_set_version: review.rule_set_version }, at, actor);
  return { review: next, event };
}
export interface CpmSnapshot { readonly cpm_status: CpmStatus; readonly cpm_project_id?: string | null; readonly cpm_phase_id?: string | null; readonly cpm_certification_id?: string | null; readonly cpm_cert_expires_on?: PlainDate | null; readonly note_date?: PlainDate | null; readonly comments?: string | null; }
export class CpmRefused extends Error { readonly code: string; constructor(code: string, msg: string) { super(`${code}: ${msg}`); this.name = "CpmRefused"; this.code = code; } }
/** The CPM record keyed by the fnma_portal_operator (UI-only; the agent never keys CPM). Unavailable → ineligible regardless of the lender's analysis; certified → the review completes. */
export function recordCpmStatus(events: EventStore, review: ProjectReview, s: CpmSnapshot, operator: Actor, at: string): { review: ProjectReview; events: DomainEvent[] } {
  if (operator.kind !== "human" || operator.role !== "fnma_portal_operator") throw new CpmRefused("CPM_NEVER_KEYED_BY_AGENT", "CPM entries are recorded by the fnma_portal_operator (UI-only; Consolidated Technology Guide) — never by the agent");
  const out: DomainEvent[] = [];
  const base: ProjectReview = { ...review, cpm_status: s.cpm_status, cpm_project_id: s.cpm_project_id ?? review.cpm_project_id, cpm_phase_id: s.cpm_phase_id ?? review.cpm_phase_id, cpm_certification_id: s.cpm_certification_id ?? review.cpm_certification_id, cpm_cert_expires_on: s.cpm_cert_expires_on ?? review.cpm_cert_expires_on, cpm_recorded_by: `${operator.kind}:${operator.id}` };
  out.push(emit(events, review.application_id, "project.cpm.status.recorded", { project_review_id: review.project_review_id, cpm_status: s.cpm_status, cpm_project_id: base.cpm_project_id, cpm_phase_id: base.cpm_phase_id, cpm_certification_id: base.cpm_certification_id, cpm_cert_expires_on: base.cpm_cert_expires_on, note_date: s.note_date ?? null, recorded_by: base.cpm_recorded_by, comments: s.comments ?? null }, at, operator));
  if (s.cpm_status === "unavailable") {
    const reason = "CPM status Unavailable — B4-2.1-03: ineligible for purchase regardless of the lender's own analysis; officer may request PERS";
    out.push(emit(events, review.application_id, "project.ineligible.determined", { project_review_id: review.project_review_id, reason, reasons: [reason], review_type: review.review_type, cpm_status: "unavailable" }, at, operator));
    return { review: { ...base, status: "ineligible", result: "ineligible", ineligible_reasons: [reason], tests: [...review.tests, check("cpm_status", "B4-2.1-03: CPM 'Unavailable' projects are ineligible for purchase", { cpm_status: "unavailable" }, false, reason)] }, events: out };
  }
  if (review.status === "cpm_entry_pending" && (s.cpm_status === "lender_certified" || s.cpm_status === "approved_by_fnma")) {
    const done = completeProjectReview(events, { ...base, tests: [...review.tests, check("cpm_status", "B4-2.1-01: 'Required to deliver the CPM ID number' (ULDD SID 39 / 49.2); CPM 'Must be valid (unexpired) as of the note date'", { cpm_status: s.cpm_status, cpm_project_id: base.cpm_project_id, cpm_cert_expires_on: base.cpm_cert_expires_on }, true)] }, at, operator);
    return { review: done.review, events: [...out, done.event] };
  }
  return { review: base, events: out };
}
/** B4-2.1-01 validity at the note date (deadline rows) — `project.review.expired` when the note date passes expires_at. */
export function checkProjectValidity(events: EventStore, review: ProjectReview, noteDate: PlainDate, at: string, actor: Actor = AGENT_24_3): { valid: boolean; reason: string; review: ProjectReview; event: DomainEvent | null } {
  if (review.status === "not_required" || review.status === "waived") return { valid: true, reason: "project review not required / waived", review, event: null };
  if (review.status !== "certified" || !review.expires_at) return { valid: false, reason: `project review ${review.status}`, review, event: null };
  if (noteDate <= review.expires_at) return { valid: true, reason: `valid through ${review.expires_at}`, review, event: null };
  const next: ProjectReview = { ...review, status: "expired" };
  return { valid: false, reason: `project review expired ${review.expires_at} (note date ${noteDate})`, review: next, event: emit(events, review.application_id, "project.review.expired", { project_review_id: review.project_review_id, expires_at: review.expires_at, note_date: noteDate, project_status: review.project_status }, at, actor) };
}
/** The AI-prepared CPM certification sheet: every CPM field with its source-document reference; keyed by the operator, never submitted by the agent. */
export function prepareCpmSheet(review: ProjectReview, facts: ProjectFacts, refs: Record<string, string> = {}): { fields: { field: string; value: unknown; source_document_ref: string | null }[]; ui_only: true; operator_role: "fnma_portal_operator"; sla: "+1 business_days_creditor" } {
  const src = (k: string) => refs[k] ?? null;
  const fields = [
    { field: "project_name", value: review.project_name, source_document_ref: src("questionnaire") }, { field: "project_type", value: review.project_type, source_document_ref: src("questionnaire") }, { field: "project_status", value: review.project_status, source_document_ref: src("questionnaire") },
    { field: "units_total", value: facts.units_total, source_document_ref: src("questionnaire") }, { field: "units_conveyed", value: facts.units_conveyed ?? null, source_document_ref: src("questionnaire") }, { field: "hoa_control_transferred", value: facts.hoa_control_transferred ?? null, source_document_ref: src("questionnaire") },
    { field: "delinquent_60_units", value: facts.delinquent_60_units ?? 0, source_document_ref: src("questionnaire") }, { field: "single_entity_max_units", value: facts.single_entity_max_units ?? 0, source_document_ref: src("questionnaire") }, { field: "commercial_pct_bp", value: facts.commercial_pct_bp ?? 0, source_document_ref: src("questionnaire") },
    { field: "annual_assessment_income_cents", value: facts.annual_assessment_income_cents ?? null, source_document_ref: src("budget") }, { field: "reserve_allocation_cents", value: facts.reserve_allocation_cents ?? null, source_document_ref: src("budget") }, { field: "reserve_pct", value: review.reserve_pct, source_document_ref: src("budget") },
    { field: "special_assessments", value: facts.special_assessments ?? [], source_document_ref: src("questionnaire") }, { field: "critical_repairs", value: review.critical_repairs, source_document_ref: src("inspection") }, { field: "litigation", value: facts.litigation ?? [], source_document_ref: src("litigation") },
    { field: "insurance_review_ref", value: src("insurance"), source_document_ref: src("insurance") }, { field: "project_type_code", value: review.project_type_code, source_document_ref: null },
  ];
  return { fields, ui_only: true, operator_role: "fnma_portal_operator", sla: "+1 business_days_creditor" };
}
export interface ProjectDoc { readonly kind: "questionnaire" | "budget" | "reserve_study" | "inspection_report" | "insurance" | "litigation" | "ccrs" | "management_letter" | "minutes"; readonly document_id: string; readonly dated: PlainDate; }
export function requestProjectDocs(events: EventStore, applicationId: string, docs: readonly ProjectDoc["kind"][], at: string, o: { hoa_contact?: string | null; channel?: "email" | "portal" | "vendor"; actor?: Actor } = {}): DomainEvent {
  if (!docs.length) throw new RangeError("name at least one project document to request");
  return emit(events, applicationId, "project.docs.requested", { documents: docs, hoa_contact: o.hoa_contact ?? null, channel: o.channel ?? "email", form_1076_optional: true }, at, o.actor ?? AGENT_24_3);
}
export function receiveProjectDocs(events: EventStore, applicationId: string, docs: readonly ProjectDoc[], at: string, actor: Actor = AGENT_24_3): { docs_as_of: PlainDate; event: DomainEvent } {
  if (!docs.length) throw new RangeError("no documents received");
  const docs_as_of = docs.map((d) => d.dated).reduce((a, b) => (b < a ? b : a));
  return { docs_as_of, event: emit(events, applicationId, "project.docs.received", { documents: docs.map((d) => ({ kind: d.kind, document_id: d.document_id, dated: d.dated })), docs_as_of }, at, actor) };
}

// ============================================================ gates (evaluators-24-3.ts) and the consummate guard
export interface GateResult { readonly open: boolean; readonly reason?: string; }
const closed = (reason: string): GateResult => ({ open: false, reason });
/** FNMA_B4_2_1_01_CPM_CERT_VALID_GATE: certification unexpired at the note date; status ≠ Unavailable. */
export function cpmCertValidGate(f: { cpm_status?: string | null; cpm_cert_expires_on?: string | null; note_date?: string | null; cpm_required?: boolean }): GateResult {
  if (f.cpm_required === false) return { open: true };
  if (f.cpm_status === "unavailable") return closed("CPM status Unavailable — ineligible for purchase (B4-2.1-03)");
  if (f.cpm_status !== "lender_certified" && f.cpm_status !== "approved_by_fnma") return closed(`CPM certification not recorded (status ${f.cpm_status ?? "none"}) — operator re-certification`);
  if (f.cpm_cert_expires_on && f.note_date && f.cpm_cert_expires_on < f.note_date) return closed(`CPM certification expired ${f.cpm_cert_expires_on} before the note date ${f.note_date}`);
  return { open: true };
}
/** SM_PROJECT_DOCS_AGE_120: questionnaire / budget ≤ 120 calendar days old at review. */
export function projectDocsAgeGate(f: { docs_as_of?: string | null; reviewed_on?: string | null; max_days?: number }): GateResult {
  if (!f.docs_as_of || !f.reviewed_on) return closed("project documents not received");
  const age = daysBetween(plainDate(f.docs_as_of), plainDate(f.reviewed_on)); const max = f.max_days ?? FNMA_SELLING_2026_09_02.constants.docs_age_max_days;
  return age <= max ? { open: true } : closed(`project documents ${age} days old > ${max} — request refresh`);
}
/** FNMA_B4_2_1_03_INSPECTION_LOOKBACK_3Y: every inspection dated within three years of the review date reviewed. */
export function inspectionLookbackGate(f: { inspection_reports?: readonly InspectionReport[]; reviewed_on?: string | null }): GateResult {
  if (!f.reviewed_on) return closed("no review date");
  const un = inspectionsInWindow(f.inspection_reports ?? [], plainDate(f.reviewed_on)).filter((r) => !r.reviewed);
  return un.length ? closed(`${un.length} in-window inspection report(s) not reviewed — review cannot complete`) : { open: true };
}
/** FNMA_B4_2_2_01_RESERVE_STUDY_AGE_3Y: the reserve-study exception is available only with a study ≤ 3 years old (and never the baseline method for apps ≥ Aug 3, 2026). */
export function reserveStudyAgeGate(f: { study_date?: string | null; reviewed_on?: string | null; method?: string | null; application_date?: string | null }): GateResult {
  if (!f.study_date || !f.reviewed_on) return closed("no reserve study — reserve exception unavailable");
  const rules = resolveRules(plainDate(f.application_date ?? f.reviewed_on));
  if (f.method === "baseline" && !rules.reserve_study_baseline_allowed) return closed("baseline funding methodology not permitted for applications on/after 2026-08-03 — the highest recommended allocation must be budgeted");
  return plainDate(f.study_date) >= addYears(plainDate(f.reviewed_on), -rules.constants.reserve_study_max_age_years) ? { open: true } : closed(`reserve study ${f.study_date} older than three years at ${f.reviewed_on}`);
}
/** FNMA_B4_1_3_06_SAFETY_REPAIR_BEFORE_SALE_GATE: every safety-related repair completed with accepted evidence (holdback-ineligible items). */
export function safetyRepairBeforeSaleGate(f: { repairs?: readonly { item: string; safety_related: boolean; completed?: boolean; evidence_accepted?: boolean }[] }): GateResult {
  const open = (f.repairs ?? []).filter((r) => r.safety_related && !(r.completed && (r.evidence_accepted ?? true)));
  return open.length ? closed(`safety/soundness repair(s) not completed before sale: ${open.map((r) => r.item).join(", ")} (B4-1.3-05/-06)`) : { open: true };
}
/** FNMA_B4_1_2_05_COMPLETION_BEFORE_DELIVERY_GATE: completion evidence for every "subject to" item that is not an eligible postponed improvement. */
export function completionBeforeDeliveryGate(f: { subject_to?: boolean; repairs?: readonly { item: string; path: string; completed?: boolean; evidence_accepted?: boolean }[]; completion_evidence_accepted?: boolean }): GateResult {
  if (!(f.subject_to ?? false)) return { open: true };
  const pending = (f.repairs ?? []).filter((r) => r.path === "complete_before_sale" && !(r.completed && (r.evidence_accepted ?? true)));
  if (pending.length) return closed(`completion evidence (Form 1004D / UAD 3.6 Completion Report or alternative) outstanding for: ${pending.map((r) => r.item).join(", ")} — delivery blocked (29.4)`);
  if (!(f.repairs ?? []).length && !(f.completion_evidence_accepted ?? false)) return closed("'subject to' appraisal without accepted completion evidence — delivery blocked (29.4)");
  return { open: true };
}
/** SM_MH_LABEL_VERIFICATION_GATE: HUD label / data plate reported or a verification letter, plus real-property evidence. */
export function mhLabelVerificationGate(f: { hud_label_numbers?: readonly string[]; data_plate_document_id?: string | null; label_verification_letter_document_id?: string | null; real_property_evidence_document_id?: string | null; mh_result?: string | null }): GateResult {
  if (f.mh_result === "eligible") return { open: true };
  const labels = (f.hud_label_numbers ?? []).length > 0 && !!f.data_plate_document_id;
  if (!labels && !f.label_verification_letter_document_id) return closed("HUD Certification Label / Data Plate not reported and no verification letter on file (B5-2-02)");
  if (!f.real_property_evidence_document_id) return closed("no real-property evidence (affidavit of affixture / title surrender)");
  return { open: true };
}
/** `consummate` guard: property result ≠ ineligible, project review valid at the note date, safety repairs completed or scheduled before delivery. */
export function consummateGate(f: { property_result?: Result | null; project_review?: ProjectReview | null; note_date: PlainDate; repairs?: readonly Repair[]; safety_repairs_completed?: boolean; safety_repairs_scheduled_before_delivery?: boolean }): GateResult {
  if (f.property_result === "ineligible") return closed("property_eligibility_reviews.result = ineligible");
  const pr = f.project_review;
  if (pr) {
    if (pr.status === "ineligible" || pr.result === "ineligible") return closed(`project ineligible: ${pr.ineligible_reasons[0] ?? "see project_reviews.ineligible_reasons"}`);
    if (pr.status !== "not_required" && pr.status !== "waived") { if (pr.status !== "certified" || !pr.expires_at) return closed(`project review ${pr.status} — not valid at the note date`); if (pr.expires_at < f.note_date) return closed(`project review expired ${pr.expires_at} before the note date ${f.note_date}`); }
    const cpm = cpmCertValidGate({ cpm_status: pr.cpm_status, cpm_cert_expires_on: pr.cpm_cert_expires_on, note_date: f.note_date, cpm_required: pr.review_type === "full_cpm" }); if (!cpm.open) return cpm;
  }
  const safety = (f.repairs ?? []).filter((r) => r.safety_related);
  if (safety.length && !(f.safety_repairs_completed ?? false) && !(f.safety_repairs_scheduled_before_delivery ?? false)) return closed(`safety-related repair(s) neither completed nor scheduled before delivery: ${safety.map((r) => r.item).join(", ")}`);
  return { open: true };
}

// ============================================================ R6 — manufactured housing (B5-2-02 / B5-2-03)
export interface MhFacts { readonly hud_label_numbers: readonly string[]; readonly data_plate_document_id: string | null; readonly label_verification_letter_document_id?: string | null; readonly built_on: PlainDate | null; readonly width: "single" | "multi"; readonly occupancy: "primary" | "second_home" | "investment"; readonly real_property_evidence_document_id: string | null; readonly foundation_cert_document_id?: string | null; readonly borrower_owns_land?: boolean; readonly leasehold_in_approved_project?: boolean; readonly mh_advantage: boolean; readonly mh_advantage_sticker_verified?: boolean; readonly choicehome_label?: boolean; readonly site_built_features_verified?: boolean; readonly alta_7?: boolean; readonly du_underwritten?: boolean; readonly lien_position?: number; readonly amortization?: "fixed" | "arm_7_10" | "arm_other" | "interest_only"; readonly valuation_method?: string | null; }
export interface MhVerification { readonly verification_id: string; readonly application_id: string; readonly hud_label_numbers: readonly string[]; readonly data_plate_document_id: string | null; readonly label_verification_letter_document_id: string | null; readonly built_on: PlainDate | null; readonly width: "single" | "multi"; readonly real_property_evidence_document_id: string | null; readonly foundation_cert_document_id: string | null; readonly mh_advantage: boolean; readonly mh_advantage_sticker_verified: boolean; readonly choicehome_label: boolean; readonly alta_7: boolean; readonly special_feature_codes: readonly string[]; readonly checks: readonly Check[]; readonly result: Result; readonly ineligible_reasons: readonly string[]; readonly verified_at: string; readonly rule_set_version: string; }
export function verifyMhFacts(f: MhFacts, rules: ResolvedRules = resolveRules(plainDate("2026-09-02"))): { checks: Check[]; result: Result; special_feature_codes: string[]; ineligible_reasons: string[] } {
  const c = rules.constants, checks: Check[] = [];
  const labels = f.hud_label_numbers.length > 0 && !!f.data_plate_document_id;
  checks.push(check("hud_labels", "B5-2-02: 'The appraiser must report the HUD Data Plate and HUD Certification Label information'; if missing 'the lender must obtain a HUD Certification Label verification letter'", { labels: f.hud_label_numbers, data_plate: f.data_plate_document_id, letter: f.label_verification_letter_document_id ?? null }, labels || !!f.label_verification_letter_document_id, "labels not reported and no verification letter"));
  checks.push(check("hud_code_date", "B5-2-02: home 'built on or after June 15, 1976' to the HUD Code", { built_on: f.built_on, hud_code_from: c.hud_code_from }, !!f.built_on && f.built_on >= c.hud_code_from, `built ${f.built_on ?? "unknown"} — before the HUD Code (${c.hud_code_from})`));
  checks.push(check("real_property", "B5-2-02: 'both the manufactured home and the land must be legally classified as real property under applicable state law' (affidavit of affixture / title surrender; jurisdiction_rules.mh_titling)", { evidence: f.real_property_evidence_document_id }, !!f.real_property_evidence_document_id, "no real-property evidence"));
  checks.push(check("foundation", "B5-2-02: permanent foundation 'installed per manufacturer specifications or engineer certification'", { cert: f.foundation_cert_document_id ?? null }, f.foundation_cert_document_id === undefined ? null : !!f.foundation_cert_document_id, "no foundation certification"));
  checks.push(check("land_ownership", "B5-2-02: 'The borrower must own the land' (or a leasehold in a Fannie Mae-approved condo/PUD/co-op project)", { owns: f.borrower_owns_land ?? true, leasehold_in_approved_project: f.leasehold_in_approved_project ?? false }, (f.borrower_owns_land ?? true) || (f.leasehold_in_approved_project ?? false), "MH on leased land outside an approved project"));
  checks.push(check("width_occupancy", "B5-2-02: 'principal residences (single- and multi-width)', 'second home dwellings (multi-width only)'", { width: f.width, occupancy: f.occupancy }, f.occupancy === "primary" ? true : f.occupancy === "second_home" ? f.width === "multi" : false, f.occupancy === "investment" ? "investment MH not eligible" : "second home requires multi-width"));
  checks.push(check("lien_and_amortization", "B5-2-02: 'first-lien mortgages only'; fully amortizing fixed-rate or 7/10-year initial-fixed ARMs", { lien_position: f.lien_position ?? 1, amortization: f.amortization ?? "fixed" }, (f.lien_position ?? 1) === 1 && ((f.amortization ?? "fixed") === "fixed" || f.amortization === "arm_7_10"), "not a first lien or an ineligible amortization"));
  checks.push(check("du_required", "B5-2-02: 'must be underwritten through DU'", { du_underwritten: f.du_underwritten ?? true }, f.du_underwritten ?? true, "manual underwriting not permitted"));
  checks.push(check("valuation_method", "24.1: value acceptance, VA+PD, desktop and hybrid unavailable for manufactured homes (Form 1004C)", { method: f.valuation_method ?? null }, !f.valuation_method || f.valuation_method === "traditional", `${f.valuation_method} not available for MH`));
  const advantage = f.mh_advantage && ((f.mh_advantage_sticker_verified ?? false) || (f.choicehome_label ?? false)) && (f.site_built_features_verified ?? true);
  if (f.mh_advantage) checks.push(check("mh_advantage", "B5-2-03: the appraiser verifies 'The MH Advantage Sticker' 'affixed by the manufacturer' and the site-built features; CHOICEHome label equivalent (SEL-2025-07) → SFC 859", { sticker_verified: f.mh_advantage_sticker_verified ?? false, choicehome_label: f.choicehome_label ?? false, site_built_features_verified: f.site_built_features_verified ?? true }, advantage, "MH Advantage sticker not verified — standard MH LTVs"));
  const failed = checks.filter((t) => t.outcome === "fail" && t.rule !== "mh_advantage");
  const reasons = failed.map((t) => t.reason ?? t.rule);
  return { checks, result: failed.length ? "ineligible" : "eligible", special_feature_codes: advantage ? [SFC_MH_ADVANTAGE] : [], ineligible_reasons: reasons };
}
export function verifyMh(events: EventStore, applicationId: string, f: MhFacts, at: string, rules: ResolvedRules = resolveRules(civilDate(at)), actor: Actor = AGENT_24_3): { verification: MhVerification; event: DomainEvent } {
  const v = verifyMhFacts(f, rules);
  const verification: MhVerification = { verification_id: randomUUID(), application_id: applicationId, hud_label_numbers: f.hud_label_numbers, data_plate_document_id: f.data_plate_document_id, label_verification_letter_document_id: f.label_verification_letter_document_id ?? null, built_on: f.built_on, width: f.width, real_property_evidence_document_id: f.real_property_evidence_document_id, foundation_cert_document_id: f.foundation_cert_document_id ?? null,
    mh_advantage: f.mh_advantage, mh_advantage_sticker_verified: f.mh_advantage_sticker_verified ?? false, choicehome_label: f.choicehome_label ?? false, alta_7: f.alta_7 ?? false, special_feature_codes: v.special_feature_codes, checks: v.checks, result: v.result, ineligible_reasons: v.ineligible_reasons, verified_at: at, rule_set_version: rules.rule_set_version };
  const event = emit(events, applicationId, "mh.verification.completed", { verification_id: verification.verification_id, result: v.result, special_feature_codes: v.special_feature_codes, mh_advantage: advantageOf(verification), reasons: v.ineligible_reasons, alta_7_required: true }, at, actor);
  return { verification, event };
}
const advantageOf = (v: MhVerification): boolean => v.special_feature_codes.includes(SFC_MH_ADVANTAGE);

// ============================================================ property eligibility review (R1 + R2 composed) and the appraisal seam
export interface ValuationRatings { readonly condition_rating: ConditionRating | null; readonly quality_rating: QualityRating | null; readonly as_is_or_subject_to: "as_is" | "subject_to" | null; readonly valuation_id: string | null; readonly deficiencies: readonly Deficiency[]; }
/** 24.1's `valuation.received` / 24.2's `valuation.review.completed` payloads carry the UAD ratings (never a second appraisal record). */
export function readValuationRatings(events: EventStore, applicationId: string): ValuationRatings | null {
  const es = [...forApp(events, applicationId, "valuation.received"), ...forApp(events, applicationId, "valuation.review.completed")].sort((a, b) => a.sequence - b.sequence);
  const last = es.at(-1); if (!last) return null;
  const pl = p(last);
  const subj = pl.as_is_or_subject_to ?? (pl.subject_to === true ? "subject_to" : pl.subject_to === false ? "as_is" : null);
  return { condition_rating: (pl.condition_rating as ConditionRating | undefined) ?? null, quality_rating: (pl.quality_rating as QualityRating | undefined) ?? null, as_is_or_subject_to: (subj as ValuationRatings["as_is_or_subject_to"]) ?? null, valuation_id: (pl.valuation_id as string | undefined) ?? (pl.appraisal_id as string | undefined) ?? (pl.order_id as string | undefined) ?? null, deficiencies: Array.isArray(pl.deficiencies) ? (pl.deficiencies as Deficiency[]) : [] };
}
export interface PropertyEligibilityReview {
  readonly review_id: string; readonly application_id: string; readonly reviewed_at: string; readonly rule_set_version: string; readonly checks: readonly Check[]; readonly property_class: PropertyClass; readonly adu_present: boolean; readonly adu_permitted: boolean | null; readonly adu_rent_usable: boolean;
  readonly zoning_status: ZoningStatus | null; readonly condition_rating: ConditionRating | null; readonly quality_rating: QualityRating | null; readonly as_is_or_subject_to: "as_is" | "subject_to" | null; readonly repairs: readonly Repair[]; readonly solar: SolarFacts | null; readonly pace_lien: boolean; readonly disaster_flag: boolean;
  readonly result: Result; readonly ineligible_reasons: readonly string[]; readonly valuation_id: string | null; readonly condition_route: ConditionRoute | null;
}
export function runPropertyEligibility(events: EventStore, i: { application_id: string; facts: PropertyFacts; ratings?: ValuationRatings | null; transaction_type?: "purchase" | "limited_cash_out" | "cash_out"; completion?: CompletionFacts | null; rules: ResolvedRules }, at: string, actor: Actor = AGENT_24_3): { review: PropertyEligibilityReview; events: DomainEvent[] } {
  const checks = runPropertyChecks(i.facts, i.rules);
  const ratings = i.ratings === undefined ? readValuationRatings(events, i.application_id) : i.ratings;
  const route = ratings ? routeCondition({ condition_rating: ratings.condition_rating, quality_rating: ratings.quality_rating, as_is_or_subject_to: ratings.as_is_or_subject_to, deficiencies: ratings.deficiencies, completion: i.completion ?? null }) : null;
  const failed = checks.filter((c) => c.outcome === "fail");
  const reasons = [...failed.map((c) => c.reason ?? c.rule), ...(route?.result === "ineligible" ? route.reasons : [])];
  const result: Result = failed.length || route?.result === "ineligible" ? "ineligible" : route?.result === "eligible_with_conditions" ? "eligible_with_conditions" : "eligible";
  const adu = i.facts.adu ?? null;
  const aduEligible = !!adu && checks.filter((c) => c.rule.startsWith("adu_")).every((c) => c.outcome !== "fail");
  const review: PropertyEligibilityReview = { review_id: randomUUID(), application_id: i.application_id, reviewed_at: at, rule_set_version: i.rules.rule_set_version, checks: route ? [...checks, check("condition_route", route.citation, { condition_rating: ratings?.condition_rating, quality_rating: ratings?.quality_rating, repairs: route.repairs.length }, route.result !== "ineligible", route.reasons[0])] : checks,
    property_class: classifyProperty(i.facts), adu_present: !!adu, adu_permitted: adu ? adu.permitted : null, adu_rent_usable: aduEligible && (i.transaction_type ?? "purchase") !== "cash_out", zoning_status: i.facts.zoning_status ?? null, condition_rating: ratings?.condition_rating ?? null, quality_rating: ratings?.quality_rating ?? null, as_is_or_subject_to: ratings?.as_is_or_subject_to ?? null,
    repairs: route?.repairs ?? [], solar: i.facts.solar ?? null, pace_lien: i.facts.pace_lien ?? false, disaster_flag: i.facts.disaster_flag ?? false, result, ineligible_reasons: reasons, valuation_id: ratings?.valuation_id ?? null, condition_route: route };
  const out: DomainEvent[] = [];
  for (const r of review.repairs) if (r.path !== "none") out.push(emit(events, i.application_id, "property.repair.required", { review_id: review.review_id, item: r.item, safety_related: r.safety_related, path: r.path, estimate_cents: r.estimate_cents, reason: r.reason }, at, actor));
  out.push(emit(events, i.application_id, "property.eligibility.completed", { review_id: review.review_id, result, property_class: review.property_class, subject_to: route?.subject_to_required ?? review.as_is_or_subject_to === "subject_to", condition_rating: review.condition_rating, quality_rating: review.quality_rating, adu_rent_usable: review.adu_rent_usable, repairs: review.repairs.map((r) => ({ item: r.item, safety_related: r.safety_related, path: r.path })), reasons, rule_set_version: i.rules.rule_set_version }, at, actor));
  return { review, events: out };
}
/** A completed repair (Completion Report / alternative accepted): `property.repair.completed{safety_related}` and `property.completion.accepted` (the two delivery gates). */
export function acceptRepairCompletion(events: EventStore, i: { application_id: string; item: string; safety_related: boolean; evidence: CompletionEvidence; loan_id?: string | null }, at: string, actor: Actor = { kind: "external", id: "appraiser", role: "appraiser" }): { accepted: boolean; events: DomainEvent[]; reason: string } {
  const a = completionEvidenceAcceptable(i.evidence); if (!a.accepted) return { accepted: false, events: [], reason: a.reason };
  const e1 = emit(events, i.application_id, "property.repair.completed", { item: i.item, safety_related: i.safety_related, evidence_kind: i.evidence.kind, completion_document_id: i.evidence.document_id, received_at: i.evidence.received_at }, at, actor, i.loan_id);
  const e2 = emit(events, i.application_id, "property.completion.accepted", { item: i.item, evidence_kind: i.evidence.kind, completion_document_id: i.evidence.document_id, resulting_condition_rating: i.evidence.resulting_condition_rating ?? null, accepted_at: at }, at, actor, i.loan_id);
  return { accepted: true, events: [e1, e2], reason: a.reason };
}

// ============================================================ decision record (AI agent design)
export interface EligibilityDecision { readonly application_id: string; readonly property_class: PropertyClass | null; readonly checks: readonly Check[]; readonly condition_route: string | null; readonly repairs: readonly Repair[]; readonly holdback: { estimate_cents: Cents; escrow_cents: Cents; completion_due_on: PlainDate } | null; readonly project: { status: ProjectReviewState; review_type: ReviewType; tests: readonly Check[]; reserve_pct: number | null; special_assessments: readonly SpecialAssessment[]; critical_repairs: readonly { source: string; finding: string }[]; cpm: { status: CpmStatus | null; project_id: string | null; certification_id: string | null; expires_on: PlainDate | null }; project_type_code: ProjectTypeCode; expires_at: PlainDate | null } | null; readonly rule_set_version: string; readonly model_version: string; readonly prompt_version: string; readonly rationale: string; readonly confidence: number; readonly citations: readonly string[]; }
export function writeDecision(i: { application_id: string; property?: PropertyEligibilityReview | null; project?: ProjectReview | null; holdback?: EscrowHoldback | null; rules: ResolvedRules; model_version?: string; prompt_version?: string; confidence?: number; rationale?: string }): EligibilityDecision {
  const citations = new Set<string>(["B2-3-01 (09/03/2025)", "B4-1.3-06 (06/04/2025)"]);
  for (const c of i.project?.citations ?? []) citations.add(c);
  for (const s of i.rules.switches_applied) citations.add(s.citation.split(":")[0]!.trim());
  const parts: string[] = [];
  if (i.property) parts.push(`property ${i.property.property_class}: ${i.property.result}${i.property.ineligible_reasons.length ? ` (${i.property.ineligible_reasons.join("; ")})` : ""}`);
  if (i.project) parts.push(`project ${i.project.review_type} ${i.project.status}${i.project.reserve_pct !== null ? ` reserves ${(i.project.reserve_pct * 100).toFixed(2)}%` : ""}${i.project.ineligible_reasons.length ? ` — ${i.project.ineligible_reasons.join("; ")}` : ""}`);
  if (i.holdback) parts.push(`holdback ${i.holdback.escrow_cents} cents due ${i.holdback.completion_due_on}`);
  return { application_id: i.application_id, property_class: i.property?.property_class ?? null, checks: i.property?.checks ?? [], condition_route: i.property?.condition_route ? i.property.condition_route.result : null, repairs: i.property?.repairs ?? [],
    holdback: i.holdback ? { estimate_cents: i.holdback.estimate_cents, escrow_cents: i.holdback.escrow_cents, completion_due_on: i.holdback.completion_due_on } : null,
    project: i.project ? { status: i.project.status, review_type: i.project.review_type, tests: i.project.tests, reserve_pct: i.project.reserve_pct, special_assessments: i.project.special_assessments, critical_repairs: i.project.critical_repairs, cpm: { status: i.project.cpm_status, project_id: i.project.cpm_project_id, certification_id: i.project.cpm_certification_id, expires_on: i.project.cpm_cert_expires_on }, project_type_code: i.project.project_type_code, expires_at: i.project.expires_at } : null,
    rule_set_version: i.rules.rule_set_version, model_version: i.model_version ?? "unversioned", prompt_version: i.prompt_version ?? "unversioned", rationale: i.rationale ?? parts.join(" | "), confidence: i.confidence ?? 1, citations: [...citations] };
}
