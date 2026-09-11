/**
 * §24.1 operating rules — valuation method selection and ordering (value acceptance, value acceptance + property
 * data, hybrid, desktop, traditional), appraiser independence (AIR / Reg Z §1026.42), and property data collection.
 * Small pure functions, one per rule / T-id, plus the event-appending steps the `valuation` agent's tools call.
 * Bigint cents, PlainDate arithmetic (calendar months per the spec's "same calendar day, clamped to month-end"
 * decision), erasable TypeScript only. The AMC and the Property Data API are ports with in-process fakes.
 *
 * Events (all carry `applicationId` + payload.application_id so the origination timers arm — engine.ts isOriginationContext):
 *   valuation.method.selected{method, offer_type, form_code, uad_version, selected_at, selected_on, exclusions_fired, conversion?}
 *                                            [arms SM_VALUATION_ORDER_SLA_1BD (method≠value_acceptance); FNMA_B4_1_4_11_PDC_API_SUBMIT_GATE (method=value_acceptance_pd)]
 *   valuation.ordered{order_id, ordered_at, ordered_on, channel, uad_version, first_ucdp_submission_on}
 *                                            [satisfies SM_VALUATION_ORDER_SLA_1BD; arms _ASSIGN_SLA_2BD, _REPORT_SLA_10CD, FNMA_UAD_3_6_REQUIRED_GATE, SM_AMC_REGISTRATION_GATE (channel=amc)]
 *   valuation.amc.verified{amc_registration_id}  [satisfies SM_AMC_REGISTRATION_GATE — the verified `amc_registrations` row snapshot]
 *   valuation.assigned{order_id, assigned_at, assigned_on, appraiser_party_id}  [satisfies _ASSIGN_SLA_2BD; arms _INSPECT_SLA_7CD, SM_APPRAISER_LICENSE_GATE]
 *   valuation.appraiser.verified{license_state, license_expires_on, asc_registry_checked_on}  [satisfies SM_APPRAISER_LICENSE_GATE — the `appraiser_panel` verification snapshot]
 *   valuation.inspection.scheduled / valuation.inspection.completed{inspected_on}  [the latter satisfies _INSPECT_SLA_7CD]
 *   valuation.received{order_id, effective_date, assignment_type, declined, uad_version, age_4m_update_after, age_12m_expires_on, transferred_from_lender}
 *                                            [satisfies _REPORT_SLA_10CD, FNMA_UAD_3_6_REQUIRED_GATE (uad_version=3.6), FNMA_B4_1_2_04_APPRAISAL_UPDATE_4M (assignment_type=appraisal_update, declined=false);
 *                                             arms FNMA_B4_1_2_04_APPRAISAL_12M and _UPDATE_4M from effective_date; closes 24.1 and opens 24.2]
 *   valuation.report.rejected{reference=FNM0391|wrong_lender_client} + valuation.engagement.reissued{reason}
 *   valuation.order.cancelled{reason}, valuation.order.reassigned{new_order_id, reason}, valuation.offer.lost{prior_offer_type}, valuation.offer.expired, valuation.update.ordered
 *   pdc.ordered, pdc.collected, pdc.safety_issue.flagged, pdc.submitted, pdc.accepted{property_data_id_fnma, accepted_on}, pdc.rejected
 *   air.guardrail.blocked{order_id, violations}  (T7 audit row), air.contact.logged, air.misconduct.suspected{determination_at} (officer determination; arms REGZ_1026_42G_MISCONDUCT_REFERRAL_30), air.misconduct.referred
 * Consumed: du.findings.received{value_acceptance_offer, du_submission_id, messages} (23.1; arms FNMA_B4_1_4_10_VALUE_ACCEPTANCE_OFFER_4M from offer_issued_at),
 *   intent.to_proceed.received (21.4, through checkFeeGate), closing.consummated (26.2; satisfies the offer-age and appraisal-age rows).
 */
import { randomUUID } from "node:crypto";
import { type PlainDate, addDays, addMonths, daysBetween, plainDate } from "../../kernel/calendar/date.ts";
import { type Calendar, creditor } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { AccountRef, CorporateAccount, EntrySet, Ledger } from "../../kernel/ledger/ledger.ts";
import { checkFeeGate, type FeeGateCheck, type IntentRecord } from "../application/ops-21-4.ts";

export const VALUATION_AGENT: Actor = { kind: "agent", id: "valuation" };
export const CREDITOR_TZ = "America/Phoenix";
export const RULE_SET_VERSION = "fnma.selling.2026-09-02";
export const UAD_RULE_SET = "fnma.uad.3.6";
/** Open question 3 (default): engage UAD 3.6 for every order placed on/after Sept 8, 2026; mandatory for new UCDP submissions on/after Nov 2, 2026 (FNM0391); UAD 2.6 revisions through May 3, 2027. */
export const UAD_3_6_ENGAGE_FROM = plainDate("2026-09-08");
export const UAD_3_6_UCDP_MANDATE = plainDate("2026-11-02");
export const UAD_2_6_RETIREMENT = plainDate("2027-05-03");
export const FNM0391 = "FNM0391";
export const OFFER_LIFE_MONTHS = 4;               // B4-1.4-10: "not more than four months old on the date of the note"
export const APPRAISAL_UPDATE_AFTER_MONTHS = 4;   // B4-1.2-04: more than four months → appraisal update
export const APPRAISAL_MAX_AGE_MONTHS = 12;       // B4-1.2-04: "appraised within the 12 months prior to the date of the note"
export const PDC_VALIDITY_MONTHS = 12;            // B4-1.4-11: collection valid 12 months from the collection date
export const COLLECTOR_BACKGROUND_CHECK_MONTHS = 12; // B4-1.4-11: "vetted through an annual background check"
export const ASC_CHECK_MAX_AGE_DAYS = 30;         // SM_APPRAISER_LICENSE_GATE: ASC check ≤ 30 calendar days old
export const MISCONDUCT_REFERRAL_DAYS = 30;       // REGZ_1026_42G_MISCONDUCT_REFERRAL_30 (policy value)
export const VALUE_ACCEPTANCE_PRICE_CAP_CENTS: Cents = 100_000_000n; // $1,000,000 purchase price / estimated value → VA ineligible
export const SFC_VALUE_ACCEPTANCE = "801";
export const SFC_VALUE_ACCEPTANCE_PD = "774";

export type OfferType = "value_acceptance" | "value_acceptance_pd" | "none";
export type ValuationMethod = "value_acceptance" | "value_acceptance_pd" | "hybrid" | "desktop" | "traditional";
export const METHOD_PREFERENCE: readonly ValuationMethod[] = ["value_acceptance", "value_acceptance_pd", "hybrid", "desktop", "traditional"];
export type FormCode = "1004" | "1073" | "1025" | "1004C" | "1004_desktop" | "1004_hybrid" | "1073_hybrid" | "1004D" | "urar_uad36" | "update_uad36" | "completion_uad36";
export type UadVersion = "2.6" | "3.6";
export type AssignmentType = "traditional" | "desktop" | "hybrid" | "pdc_only" | "appraisal_update" | "completion_report" | "second_appraisal_hpml" | "field_review";
export type OrderStatus = "method_pending" | "fee_gate_wait" | "ready_to_order" | "ordered" | "assigned" | "inspection_scheduled" | "inspected" | "report_received" | "cancelled" | "reassigned" | "expired" | "update_required"
  | "offer_recorded" | "offer_exercised" | "offer_lost" | "pdc_ordered" | "pdc_collected" | "pdc_submitted" | "pdc_accepted" | "converted_to_hybrid" | "converted_to_traditional";
export type FeePaidBy = "sm" | "borrower" | "seller" | "other";
export type OrderChannel = "amc" | "panel";
export type LicenseType = "licensed" | "certified_residential" | "certified_general";

export class ValuationRefused extends Error {
  readonly code: string; readonly citation: string;
  constructor(code: string, citation: string, reason: string) { super(`${code}: ${reason}`); this.name = "ValuationRefused"; this.code = code; this.citation = citation; }
}
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const isoOrThrow = (v: unknown, what: string): string => { const s = nonEmpty(v, what); if (Number.isNaN(Date.parse(s))) throw new RangeError(`${what} must be an ISO instant`); return s; };
/** The creditor's civil date of an instant (the SLA anchors: "same business day" is the creditor's day). */
export const civilDate = (iso: string, tz: string = CREDITOR_TZ): PlainDate => wallClock(Date.parse(iso), tz).date;
const emit = (events: EventStore, applicationId: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor = VALUATION_AGENT): DomainEvent =>
  events.append({ type, applicationId, aggregate: { kind: "application", id: applicationId }, actor, occurredAt: at, payload: { application_id: applicationId, ...payload } });
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const forApp = (events: EventStore, applicationId: string, type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === applicationId || p(e).application_id === applicationId).sort((a, b) => a.sequence - b.sequence);

// ============================================================ AIR §4.1.1 restricted parties (never order, never contact the appraiser)
/** SM's `intake`/`pricing` agents and the `mlo_of_record` are AIR "restricted parties" (blueprint nuance; AIR §4.1.1: production staff, commissioned originators, their reports). */
export const RESTRICTED_PARTY_AGENTS = ["intake", "pricing"] as const;
export const RESTRICTED_PARTY_ROLES = ["mlo_of_record", "loan_officer", "mortgage_broker", "real_estate_agent", "production"] as const;
export function isRestrictedParty(actor: Actor): boolean {
  if (actor.kind === "agent") return (RESTRICTED_PARTY_AGENTS as readonly string[]).includes(actor.id);
  if (actor.kind === "human") return !!actor.role && (RESTRICTED_PARTY_ROLES as readonly string[]).includes(actor.role);
  return false;
}
export function assertNotRestrictedParty(actor: Actor, what: string): void {
  if (isRestrictedParty(actor)) throw new ValuationRefused("AIR_4_1_1_RESTRICTED_PARTY", "AIR §4.1/§4.1.1; SEL-2023-07", `${what}: ${actor.kind}:${actor.id}${actor.role ? ` (${actor.role})` : ""} is a restricted party (production/commissioned staff have no involvement in the appraisal function)`);
}

// ============================================================ R1 — method selection (DU sets the menu)
export interface MethodFacts {
  readonly offer_type: OfferType;
  readonly du_recommendation?: string | null;
  readonly hybrid_offered?: boolean;            // DU message "DU offers hybrid appraisals"
  readonly desktop_offered?: boolean;           // DU message: Form 1004 Desktop option
  readonly transaction_type: "purchase" | "limited_cash_out" | "cash_out";
  readonly occupancy: "primary" | "second_home" | "investment";
  readonly units: number;
  readonly property_type: "sfr" | "condo" | "pud" | "2_4_unit" | "manufactured" | "co_op";
  readonly ltv_bps: number;
  readonly homeready?: boolean;
  readonly hpml_non_exempt?: boolean;           // 23.4: HPML not exempt under §1026.35(c)(2) → interior physical visit
  readonly flip_test_fires?: boolean;           // 24.2 flip test → second traditional by a different appraiser
  readonly known_condition_issue?: boolean;     // any inspection/repair/disaster document classified
  readonly appraisal_obtained?: boolean;        // "may not exercise a value acceptance offer if an appraisal is obtained"
  readonly pdc_on_file?: boolean;
  readonly pdc_safety_issue?: boolean;          // B4-1.4-11 lender representation cannot be made
  readonly manually_underwritten?: boolean;
  readonly rental_income_qualifying?: boolean;  // investment qualifying with rental income → VA+PD ineligible
  readonly ordered_on: PlainDate;               // engagement date (UAD version)
}
export interface Exclusion { readonly method: ValuationMethod; readonly reason: string; readonly citation: string; }
export interface MethodSelection {
  readonly method: ValuationMethod; readonly assignment_type: AssignmentType | null; readonly form_code: FormCode | null; readonly uad_version: UadVersion;
  readonly exclusions: readonly Exclusion[]; readonly second_appraisal_required: boolean; readonly rule_set_version: string; readonly rationale: string;
}
/** UAD version engaged for an order placed on `orderedOn` (default decision: 3.6 from Sept 8, 2026). */
export const uadVersionForEngagement = (orderedOn: PlainDate): UadVersion => (orderedOn >= UAD_3_6_ENGAGE_FROM ? "3.6" : "2.6");
/** UAD 3.6 is mandatory when the report's first UCDP submission falls on/after Nov 2, 2026 (FNM0391). */
export const uad36RequiredForSubmission = (firstUcdpSubmissionOn: PlainDate): boolean => firstUcdpSubmissionOn >= UAD_3_6_UCDP_MANDATE;
export function formCodeFor(method: ValuationMethod, f: Pick<MethodFacts, "units" | "property_type">, uad: UadVersion): FormCode | null {
  switch (method) {
    case "value_acceptance": case "value_acceptance_pd": return null;
    case "desktop": return "1004_desktop";
    case "hybrid": return f.property_type === "condo" ? "1073_hybrid" : "1004_hybrid";
    case "traditional":
      if (uad === "3.6") return "urar_uad36";                       // redesigned URAR: one dynamic form (B4-1.2-01 / UAD 3.6 Policy Supplement)
      if (f.units >= 2) return "1025"; if (f.property_type === "manufactured") return "1004C"; if (f.property_type === "condo") return "1073"; return "1004";
  }
}
const assignmentFor = (m: ValuationMethod): AssignmentType | null => (m === "traditional" ? "traditional" : m === "desktop" ? "desktop" : m === "hybrid" ? "hybrid" : m === "value_acceptance_pd" ? "pdc_only" : null);
/** Exclusion reasons per method, in check order (the first reason is the headline one; T2 expects "refinance" for desktop on a refinance). */
export function exclusionsFor(method: ValuationMethod, f: MethodFacts): Exclusion[] {
  const x = (reason: string, citation: string): Exclusion => ({ method, reason, citation });
  const out: Exclusion[] = [];
  const interior = f.hpml_non_exempt === true;
  switch (method) {
    case "value_acceptance":
      if (f.offer_type !== "value_acceptance") out.push(x(f.offer_type === "none" ? "no DU value acceptance offer" : "DU offered value acceptance + property data, not value acceptance", "B4-1.4-10"));
      if (f.appraisal_obtained) out.push(x("an appraisal is obtained for the transaction", "B4-1.4-10: may not exercise a value acceptance offer if an appraisal is obtained"));
      if (f.known_condition_issue) out.push(x("known condition issue", "B4-1.4-10 / R1 known_condition_issue"));
      if (interior) out.push(x("HPML requires an interior physical visit", "12 CFR 1026.35(c)(3)"));
      if (f.manually_underwritten) out.push(x("manually underwritten loan", "B4-1.4-10"));
      if (f.du_recommendation && /ineligible/i.test(f.du_recommendation)) out.push(x("DU Ineligible recommendation", "B4-1.4-10"));
      break;
    case "value_acceptance_pd":
      if (f.offer_type !== "value_acceptance_pd") out.push(x("no DU value acceptance + property data offer", "B4-1.4-11"));
      if (f.appraisal_obtained) out.push(x("an appraisal is obtained for the transaction", "B4-1.4-10"));
      if (f.known_condition_issue) out.push(x("known condition issue", "B4-1.4-11 lender representation"));
      if (f.pdc_safety_issue) out.push(x("property data collection reports a safety, soundness, or structural integrity issue", "B4-1.4-11: the lender represents the property does not have safety, soundness, or structural integrity issues"));
      if (interior) out.push(x("HPML requires an interior physical visit", "12 CFR 1026.35(c)(3)"));
      if (f.occupancy === "investment" && f.rental_income_qualifying) out.push(x("investment property qualifying with rental income", "B4-1.4-11"));
      if (f.manually_underwritten) out.push(x("manually underwritten loan", "B4-1.4-11"));
      break;
    case "hybrid":
      if (!f.hybrid_offered) out.push(x("DU did not offer hybrid appraisals", "B4-1.2-03: requires the DU message \"DU offers hybrid appraisals\""));
      if (f.units !== 1) out.push(x("not a one-unit property", "B4-1.2-03"));
      if (f.property_type === "manufactured" || f.property_type === "co_op") out.push(x("manufactured home or co-op", "B4-1.2-03"));
      if (interior) out.push(x("HPML requires an interior physical visit", "12 CFR 1026.35(c)(3)"));
      break;
    case "desktop":
      if (f.transaction_type !== "purchase") out.push(x("refinance", "B4-1.2-02: purchase transactions only; all refinances ineligible"));
      if (f.occupancy !== "primary") out.push(x("not a principal residence", "B4-1.2-02"));
      if (f.units !== 1) out.push(x("not a one-unit property", "B4-1.2-02"));
      if (f.ltv_bps > 9000) out.push(x("LTV above 90%", "B4-1.2-02"));
      if (f.property_type === "condo" || f.property_type === "manufactured" || f.property_type === "co_op") out.push(x("condo, co-op or manufactured home", "B4-1.2-02"));
      if (f.homeready) out.push(x("HomeReady", "B4-1.2-02"));
      if (!f.desktop_offered) out.push(x("DU did not offer Form 1004 Desktop", "B4-1.2-02"));
      if (interior) out.push(x("HPML requires an interior physical visit", "12 CFR 1026.35(c)(3)"));
      break;
    case "traditional": break;
  }
  return out;
}
/** R1: the menu of methods is set by DU; preference value_acceptance → value_acceptance_pd → hybrid → desktop → traditional; the first method with no exclusion wins. The LTV product-page table is never consulted. */
export function selectMethod(f: MethodFacts): MethodSelection {
  if (!Number.isInteger(f.units) || f.units < 1 || f.units > 4) throw new RangeError(`units ${f.units} must be 1–4`);
  if (!Number.isFinite(f.ltv_bps) || f.ltv_bps < 0) throw new RangeError("ltv_bps is required");
  const uad = uadVersionForEngagement(f.ordered_on);
  const exclusions: Exclusion[] = [];
  let chosen: ValuationMethod = "traditional";
  for (const m of METHOD_PREFERENCE) {
    const ex = exclusionsFor(m, f);
    if (ex.length === 0) { chosen = m; break; }
    exclusions.push(...ex);
  }
  const second = f.hpml_non_exempt === true && f.flip_test_fires === true && chosen === "traditional";
  const rationale = `R1: offer_type=${f.offer_type}; ${chosen} selected (${exclusions.length} exclusions: ${exclusions.map((e) => `${e.method}:${e.reason}`).join("; ") || "none"})${second ? "; HPML flip → second traditional appraisal by a different appraiser" : ""}`;
  return { method: chosen, assignment_type: assignmentFor(chosen), form_code: formCodeFor(chosen, f, uad), uad_version: uad, exclusions, second_appraisal_required: second, rule_set_version: RULE_SET_VERSION, rationale };
}

/** The `agent_decisions` record 24.1 writes per order (AI agent design). */
export interface ValuationDecision {
  readonly application_id: string; readonly order_id: string | null; readonly offer_type: OfferType; readonly du_submission_id: string | null; readonly exclusions_fired: readonly Exclusion[];
  readonly method: ValuationMethod; readonly form_code: FormCode | null; readonly uad_version: UadVersion; readonly vendor: string | null; readonly fee_quote_cents: Cents | null; readonly benchmark_row_id: string | null;
  readonly fee_test: string | null; readonly license_check: string | null; readonly amc_check: string | null; readonly rule_set_version: string; readonly model_version: string; readonly prompt_version: string; readonly rationale: string; readonly confidence: number; readonly citations: readonly string[];
}
export function decisionRecord(sel: MethodSelection, i: { application_id: string; order_id?: string | null; offer_type: OfferType; du_submission_id?: string | null; vendor?: string | null; fee_quote_cents?: Cents | null; benchmark_row_id?: string | null; fee_test?: string | null; license_check?: string | null; amc_check?: string | null; model_version?: string; prompt_version?: string; confidence?: number; extra_rationale?: string; citations?: readonly string[] }): ValuationDecision {
  return { application_id: i.application_id, order_id: i.order_id ?? null, offer_type: i.offer_type, du_submission_id: i.du_submission_id ?? null, exclusions_fired: sel.exclusions, method: sel.method, form_code: sel.form_code, uad_version: sel.uad_version,
    vendor: i.vendor ?? null, fee_quote_cents: i.fee_quote_cents ?? null, benchmark_row_id: i.benchmark_row_id ?? null, fee_test: i.fee_test ?? null, license_check: i.license_check ?? null, amc_check: i.amc_check ?? null,
    rule_set_version: sel.rule_set_version, model_version: i.model_version ?? "valuation-2026.09", prompt_version: i.prompt_version ?? "24.1-r1-v1", rationale: i.extra_rationale ? `${sel.rationale}; ${i.extra_rationale}` : sel.rationale, confidence: i.confidence ?? 0.99,
    citations: [...new Set([...sel.exclusions.map((e) => e.citation), ...(i.citations ?? [])])] };
}
/** Emits `valuation.method.selected` (arms SM_VALUATION_ORDER_SLA_1BD when method ≠ value_acceptance; FNMA_B4_1_4_11_PDC_API_SUBMIT_GATE when value_acceptance_pd). */
export function recordMethodSelection(events: EventStore, applicationId: string, sel: MethodSelection, at: string, o: { offer_type: OfferType; du_submission_id?: string | null; conversion?: "converted_to_hybrid" | "converted_to_traditional" | null; pdc_id?: string | null; time_zone?: string; actor?: Actor } = { offer_type: "none" }): DomainEvent {
  nonEmpty(applicationId, "application_id"); isoOrThrow(at, "selected_at");
  return emit(events, applicationId, "valuation.method.selected", { method: sel.method, offer_type: o.offer_type, form_code: sel.form_code, uad_version: sel.uad_version, assignment_type: sel.assignment_type, selected_at: at, selected_on: civilDate(at, o.time_zone ?? CREDITOR_TZ),
    exclusions_fired: sel.exclusions.map((e) => `${e.method}:${e.reason}`), second_appraisal_required: sel.second_appraisal_required, du_submission_id: o.du_submission_id ?? null, conversion: o.conversion ?? null, pdc_id: o.pdc_id ?? null, rule_set_version: sel.rule_set_version }, at, o.actor ?? VALUATION_AGENT);
}

// ============================================================ DU offer (23.1's du.findings.received consumed; offer loss)
export interface DuOffer { readonly offer_type: OfferType; readonly du_submission_id: string | null; readonly offer_issued_at: PlainDate | null; readonly hybrid_offered: boolean; readonly desktop_offered: boolean; readonly recommendation: string | null; readonly event_id: string | null; readonly submission_number: number | null; }
const HYBRID_MSG = /DU offers hybrid appraisals/i, DESKTOP_MSG = /Form 1004 Desktop/i;
/** The latest DU findings for the application: `value_acceptance_offer` ∈ {value_acceptance, value_acceptance_pd, none} plus the hybrid / desktop messages. The agent never computes eligibility from the LTV table — it only reads the offer. */
export function readDuOffer(events: EventStore, applicationId: string): DuOffer {
  const e = forApp(events, applicationId, "du.findings.received").at(-1);
  if (!e) return { offer_type: "none", du_submission_id: null, offer_issued_at: null, hybrid_offered: false, desktop_offered: false, recommendation: null, event_id: null, submission_number: null };
  const pl = p(e); const raw = String(pl.value_acceptance_offer ?? "none");
  if (raw !== "value_acceptance" && raw !== "value_acceptance_pd" && raw !== "none") throw new RangeError(`value_acceptance_offer ${JSON.stringify(raw)} is not one of value_acceptance/value_acceptance_pd/none`);
  const msgs = Array.isArray(pl.messages) ? (pl.messages as unknown[]).map(String) : Array.isArray(pl.du_messages) ? (pl.du_messages as unknown[]).map(String) : [];
  const issued = typeof pl.offer_issued_at === "string" ? pl.offer_issued_at : typeof pl.received_at === "string" ? pl.received_at : e.occurredAt;
  return { offer_type: raw, du_submission_id: typeof pl.du_submission_id === "string" ? pl.du_submission_id : null, offer_issued_at: raw === "none" ? null : /^\d{4}-\d{2}-\d{2}$/.test(issued) ? plainDate(issued) : civilDate(issued, "America/New_York"),
    hybrid_offered: pl.hybrid_offered === true || msgs.some((m) => HYBRID_MSG.test(m)), desktop_offered: pl.desktop_offered === true || msgs.some((m) => DESKTOP_MSG.test(m)), recommendation: typeof pl.recommendation === "string" ? pl.recommendation : null, event_id: e.id, submission_number: typeof pl.submission_number === "number" ? pl.submission_number : null };
}
/** A resubmission whose findings drop a prior value-acceptance offer: appends `valuation.offer.lost` (the agent re-runs R1 in the same run). Returns null when nothing was lost. */
export function detectOfferLoss(events: EventStore, applicationId: string, at: string, actor: Actor = VALUATION_AGENT): DomainEvent | null {
  const rows = forApp(events, applicationId, "du.findings.received");
  if (rows.length < 2) return null;
  const latest = String(p(rows.at(-1)!).value_acceptance_offer ?? "none");
  const priorOffer = rows.slice(0, -1).map((e) => String(p(e).value_acceptance_offer ?? "none")).filter((o) => o !== "none").at(-1);
  if (!priorOffer || latest !== "none") return null;
  if (forApp(events, applicationId, "valuation.offer.lost").some((e) => p(e).du_findings_event_id === rows.at(-1)!.id)) return null;
  return emit(events, applicationId, "valuation.offer.lost", { prior_offer_type: priorOffer, du_submission_id: p(rows.at(-1)!).du_submission_id ?? null, du_findings_event_id: rows.at(-1)!.id, lost_at: at, lost_on: civilDate(at) }, at, actor);
}

// ============================================================ R6 — offer age (four months to the note date)
/** `offer_expires_on = add_months(offer_issued_at, 4)`: Oct 19, 2026 → Feb 19, 2027; Oct 31, 2026 → Feb 28, 2027 (clamped). */
export const offerExpiresOn = (offerIssuedOn: PlainDate): PlainDate => addMonths(offerIssuedOn, OFFER_LIFE_MONTHS);
/** FNMA_B4_1_4_10_VALUE_ACCEPTANCE_OFFER_4M at `consummate`: `note_date ≤ offer_expires_on`. */
export function offerAgeGate(offerIssuedOn: PlainDate, noteDate: PlainDate): { open: boolean; expires_on: PlainDate; reason?: string } {
  const expires_on = offerExpiresOn(offerIssuedOn);
  return noteDate <= expires_on ? { open: true, expires_on } : { open: false, expires_on, reason: `B4-1.4-10: the value acceptance offer (${offerIssuedOn}) is more than four months old on the note date ${noteDate} (expired ${expires_on}); resubmit DU for a fresh offer or order an appraisal` };
}

// ============================================================ B4-1.2-04 — appraisal age (12 months; update after 4 months)
export interface AppraisalAgeDates { readonly age_4m_update_after: PlainDate; readonly age_12m_expires_on: PlainDate; }
export const appraisalAgeDates = (effectiveDate: PlainDate): AppraisalAgeDates => ({ age_4m_update_after: addMonths(effectiveDate, APPRAISAL_UPDATE_AFTER_MONTHS), age_12m_expires_on: addMonths(effectiveDate, APPRAISAL_MAX_AGE_MONTHS) });
export type AppraisalAgeStatus = "current" | "update_required" | "expired";
/** Age of the original report against the note date: ≤ 4 months → current; > 4 and < 12 → update (dated within the four months before the note date); ≥ 12 → new appraisal (spec's strict rule; S4 in the verification report). */
export function appraisalAgeStatus(effectiveDate: PlainDate, noteDate: PlainDate): { status: AppraisalAgeStatus; update_window: { from: PlainDate; to: PlainDate } | null; dates: AppraisalAgeDates; reason: string } {
  if (noteDate < effectiveDate) throw new RangeError(`note_date ${noteDate} precedes the effective date ${effectiveDate}`);
  const dates = appraisalAgeDates(effectiveDate);
  if (noteDate >= dates.age_12m_expires_on) return { status: "expired", update_window: null, dates, reason: `B4-1.2-04: effective date ${effectiveDate} is 12 months or more from the note date ${noteDate} — a new appraisal report is required` };
  if (noteDate > dates.age_4m_update_after) return { status: "update_required", update_window: { from: addMonths(noteDate, -APPRAISAL_UPDATE_AFTER_MONTHS), to: noteDate }, dates, reason: `B4-1.2-04: effective date ${effectiveDate} is more than four months from the note date ${noteDate} — an appraisal update dated within the four months before the note date is required` };
  return { status: "current", update_window: null, dates, reason: `B4-1.2-04: ${daysBetween(effectiveDate, noteDate)} calendar days between the effective date and the note date (≤ 4 months) — no update` };
}
/** FNMA_B4_1_2_04_APPRAISAL_12M gate on `consummate`: effective date + 12 months must be > note date. */
export function appraisalAge12mGate(effectiveDate: PlainDate, noteDate: PlainDate): { open: boolean; expires_on: PlainDate; reason?: string } {
  const expires_on = appraisalAgeDates(effectiveDate).age_12m_expires_on;
  return noteDate < expires_on ? { open: true, expires_on } : { open: false, expires_on, reason: `B4-1.2-04: appraisal effective ${effectiveDate} is not within the 12 months prior to the note date ${noteDate} (expires ${expires_on}) — new appraisal required` };
}
export interface AppraisalUpdate { readonly effective_date: PlainDate; readonly declined: boolean; readonly report_document_id: string; }
/** FNMA_B4_1_2_04_APPRAISAL_UPDATE_4M at `consummate`: blocks until an update dated inside the four-month window before the note date says "not declined"; "declined" forces `method_pending` (new appraisal). */
export function evaluateAppraisalUpdate(originalEffectiveDate: PlainDate, noteDate: PlainDate, update: AppraisalUpdate | null): { open: boolean; next_status: "consummate" | "update_required" | "method_pending"; window: { from: PlainDate; to: PlainDate } | null; reason: string } {
  const age = appraisalAgeStatus(originalEffectiveDate, noteDate);
  if (age.status === "expired") return { open: false, next_status: "method_pending", window: null, reason: age.reason };
  if (age.status === "current") return { open: true, next_status: "consummate", window: null, reason: age.reason };
  const w = age.update_window!;
  if (!update) return { open: false, next_status: "update_required", window: w, reason: `${age.reason}; no update received (window ${w.from} – ${w.to})` };
  if (update.declined) return { open: false, next_status: "method_pending", window: w, reason: `B4-1.2-04: the appraiser indicates the property value has declined — the lender must obtain a new appraisal (update ${update.report_document_id} dated ${update.effective_date})` };
  if (update.effective_date < w.from || update.effective_date > w.to) return { open: false, next_status: "update_required", window: w, reason: `B4-1.2-04: the appraisal update must occur within four months prior to the note date (update dated ${update.effective_date}; window ${w.from} – ${w.to})` };
  return { open: true, next_status: "consummate", window: w, reason: `B4-1.2-04: update ${update.report_document_id} dated ${update.effective_date} inside ${w.from} – ${w.to}, value not declined` };
}

// ============================================================ R2 — the fee gate (21.4's REGZ_1026_19E2_INTENT_FEE_GATE, consumed) and ordering policy
export type FeeGateCommand = "order_appraisal" | "order_pdc";
export interface OrderFeeGateFacts {
  readonly application_id: string; readonly command: FeeGateCommand; readonly fee_paid_by: FeePaidBy; readonly amount_cents: Cents; readonly checked_at: string;
  readonly le_effective_receipt_date: PlainDate | null; readonly intent: IntentRecord | null; readonly fee_item_id?: string | null; readonly order_before_itp?: boolean; readonly time_zone?: string;
}
export interface OrderFeeGateResult { readonly legally_engaged: boolean; readonly check: FeeGateCheck | null; readonly evidence_id: string; readonly tolerance_class: "zero" | "not_a_consumer_charge"; }
/**
 * R2: borrower-paid → the charge is Section B "Services You Cannot Shop For", `tolerance_class = zero`, and the order is refused until ITP
 * (21.4's checkFeeGate records the attempt as a `fee_gate_checks` row, refusals included). SM-borne → no fee is imposed on the consumer,
 * the (e)(2)(i)(A) gate is not legally engaged, but `valuation.order_before_itp=false` still requires a documented intent in force.
 */
export function assertFeeGate(events: EventStore, f: OrderFeeGateFacts, actor: Actor = VALUATION_AGENT): OrderFeeGateResult {
  nonEmpty(f.application_id, "application_id"); isoOrThrow(f.checked_at, "checked_at");
  if (f.command !== "order_appraisal" && f.command !== "order_pdc") throw new RangeError(`command ${JSON.stringify(f.command)} is not order_appraisal/order_pdc`);
  if (f.fee_paid_by === "borrower") {
    const r = checkFeeGate(events, { application_id: f.application_id, command: f.command, fee_kind: f.command === "order_pdc" ? "property_data_collection" : "appraisal", amount_cents: f.amount_cents, checked_at: f.checked_at, le_effective_receipt_date: f.le_effective_receipt_date, intent: f.intent, fee_item_id: f.fee_item_id ?? null, actor: `${actor.kind}:${actor.id}`, time_zone: f.time_zone ?? CREDITOR_TZ }, actor);
    if (!r.open) throw new ValuationRefused("REGZ_1026_19E2_INTENT_FEE_GATE", "12 CFR 1026.19(e)(2)(i)(A); 21.4 rule 1", `${f.command} refused: fee gate closed (${r.check.result}) — a borrower-paid appraisal fee cannot be imposed before the Loan Estimate is received and intent to proceed is documented`);
    return { legally_engaged: true, check: r.check, evidence_id: r.check.check_id, tolerance_class: "zero" };
  }
  const intentInForce = f.intent !== null && f.intent.valid && Date.parse(f.intent.received_at) <= Date.parse(f.checked_at) && (f.intent.withdrawn_at === null || Date.parse(f.intent.withdrawn_at) > Date.parse(f.checked_at));
  if (!intentInForce && f.order_before_itp !== true) throw new ValuationRefused("SM_VALUATION_ORDER_BEFORE_ITP", "24.1 R2: feature flag valuation.order_before_itp=false", `${f.command} refused: SM-borne cost is not incurred before a documented intent to proceed (no intent in force at ${f.checked_at})`);
  return { legally_engaged: false, check: null, evidence_id: f.intent?.intent_id ?? "flag:valuation.order_before_itp", tolerance_class: "not_a_consumer_charge" };
}

// ============================================================ R3 — customary and reasonable fee (§1026.42(f))
export const F2_ADJUSTMENT_REASONS = ["property_type", "scope", "turnaround", "qualifications", "experience", "quality"] as const;
export interface FeeBenchmark { readonly benchmark_id: string; readonly state: string; readonly county_fips: string; readonly form_code: string; readonly assignment_type: AssignmentType; readonly median_fee_cents: Cents; readonly p25_fee_cents: Cents; readonly p75_fee_cents: Cents; readonly source: "third_party_survey_1026_42f3" | "market_data_1026_42f2"; readonly as_of: PlainDate; }
export interface FeeQuote { readonly gross_cents: Cents; readonly appraiser_share_cents: Cents; readonly amc_share_cents?: Cents | null; readonly adjustment_reason?: string | null; }
export interface FeeTest { readonly pass: boolean; readonly tested_cents: Cents; readonly p25_fee_cents: Cents; readonly p75_fee_cents: Cents; readonly benchmark_id: string; readonly adjustment_reason: string | null; readonly held_for_requote: boolean; readonly fee_item_current_amount_cents: Cents; readonly reason: string; }
/** The appraiser share (not the AMC gross) must satisfy p25 ≤ share ≤ p75, or carry a §1026.42(f)(2) adjustment reason; otherwise the order is held for a vendor re-quote. `fee_items.appraisal_fee.current_amount_cents` = the gross. */
export function benchmarkFee(q: FeeQuote, b: FeeBenchmark): FeeTest {
  if (q.gross_cents <= 0n || q.appraiser_share_cents <= 0n) throw new RangeError("gross_cents and appraiser_share_cents must be positive");
  if (q.amc_share_cents !== undefined && q.amc_share_cents !== null && q.appraiser_share_cents + q.amc_share_cents !== q.gross_cents) throw new RangeError(`appraiser share ${q.appraiser_share_cents} + AMC share ${q.amc_share_cents} ≠ gross ${q.gross_cents}`);
  if (q.appraiser_share_cents > q.gross_cents) throw new RangeError("appraiser share exceeds the gross quote");
  if (b.p25_fee_cents > b.p75_fee_cents || b.p25_fee_cents <= 0n) throw new RangeError("benchmark p25/p75 malformed");
  const reason = q.adjustment_reason ?? null;
  if (reason !== null && !(F2_ADJUSTMENT_REASONS as readonly string[]).includes(reason)) throw new RangeError(`adjustment_reason ${JSON.stringify(reason)} is not a §1026.42(f)(2) factor (${F2_ADJUSTMENT_REASONS.join("/")})`);
  const inBand = q.appraiser_share_cents >= b.p25_fee_cents && q.appraiser_share_cents <= b.p75_fee_cents;
  const pass = inBand || reason !== null;
  return { pass, tested_cents: q.appraiser_share_cents, p25_fee_cents: b.p25_fee_cents, p75_fee_cents: b.p75_fee_cents, benchmark_id: b.benchmark_id, adjustment_reason: reason, held_for_requote: !pass, fee_item_current_amount_cents: q.gross_cents,
    reason: inBand ? `§1026.42(f)(1): appraiser share ${q.appraiser_share_cents} ∈ [${b.p25_fee_cents}, ${b.p75_fee_cents}] (${b.source} ${b.as_of})` : reason ? `§1026.42(f)(2): appraiser share ${q.appraiser_share_cents} outside [${b.p25_fee_cents}, ${b.p75_fee_cents}] with adjustment reason ${reason}` : `§1026.42(f)(1): appraiser share ${q.appraiser_share_cents} outside [${b.p25_fee_cents}, ${b.p75_fee_cents}] with no (f)(2) adjustment reason — held for vendor re-quote` };
}

// ============================================================ AIR §1.2 / §1026.42(c) — outbound payload allowlist (T7)
export const ORDER_PAYLOAD_ALLOWLIST = ["order_id", "idempotency_key", "application_reference", "address", "legal_description", "unit_count", "units", "property_type", "occupancy", "transaction_type", "access_contact", "purchase_contract_document_ids", "amendment_document_ids", "hoa_contact", "pdc_document_id", "pdc_id", "scope", "form_code", "uad_version", "assignment_type", "turn_time_days", "lender_client_name", "engagement_terms", "fee_cents", "air_clauses", "pdcir_clauses"] as const;
export const ORDER_PAYLOAD_FORBIDDEN = ["estimated_value", "loan_amount", "value", "value_range", "target_value", "needed_value", "desired_value", "anticipated_value", "du_estimated_value", "target_ltv", "ltv", "comparables", "comps", "purchase_price", "sales_price", "appraised_value", "minimum_value"] as const;
export interface PayloadValidation { readonly ok: boolean; readonly violations: readonly string[]; readonly unknown_keys: readonly string[]; }
/** Schema validation before transmission: only the allowlisted keys may appear at any depth; any value/loan-amount key (or an unknown key) rejects the payload. */
export function validateOrderPayload(payload: Record<string, unknown>): PayloadValidation {
  const violations: string[] = [], unknown: string[] = [];
  const walk = (o: unknown, path: string, top: boolean): void => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      if ((ORDER_PAYLOAD_FORBIDDEN as readonly string[]).includes(k) || /(^|_)(value|ltv|loan_amount|comparable)s?(_|$)/.test(k) && !/document/.test(k)) violations.push(here);
      else if (top && !(ORDER_PAYLOAD_ALLOWLIST as readonly string[]).includes(k)) unknown.push(here);
      walk(v, here, false);
    }
  };
  walk(payload, "", true);
  return { ok: violations.length === 0 && unknown.length === 0, violations, unknown_keys: unknown };
}
/** Guardrail at the service boundary: a payload carrying value information is refused before transmission and `air.guardrail.blocked` is written as the audit row. */
export function guardOrderPayload(events: EventStore, applicationId: string, orderId: string, payload: Record<string, unknown>, at: string, actor: Actor = VALUATION_AGENT): PayloadValidation {
  const v = validateOrderPayload(payload);
  if (!v.ok) {
    emit(events, applicationId, "air.guardrail.blocked", { order_id: orderId, violations: [...v.violations], unknown_keys: [...v.unknown_keys], actor: `${actor.kind}:${actor.id}`, actor_is_restricted_party: isRestrictedParty(actor), rule: "AIR §1.2; 12 CFR 1026.42(c)(1); order-payload allowlist", blocked_at: at }, at, actor);
    throw new ValuationRefused("AIR_1_2_VALUE_INFORMATION", "AIR §1.2; 12 CFR 1026.42(c)(1)", `outbound order payload rejected before transmission: ${[...v.violations.map((x) => `${x} (value information)`), ...v.unknown_keys.map((x) => `${x} (not on the allowlist)`)].join(", ")}`);
  }
  return v;
}

// ============================================================ Appraiser license (SM_APPRAISER_LICENSE_GATE) and AMC registration (SM_AMC_REGISTRATION_GATE)
export interface AppraiserFacts { readonly party_id: string; readonly license_state: string; readonly license_type: LicenseType; readonly license_number: string; readonly license_expires_on: PlainDate; readonly asc_registry_status: "active" | "inactive" | "revoked" | "suspended" | "unknown"; readonly asc_registry_checked_on: PlainDate; readonly panel_status?: "active" | "suspended" | "removed"; readonly disciplinary_history?: readonly string[]; readonly amc_party_id?: string | null; }
/** License active in the subject-property state on the assignment date; ASC National Registry check ≤ 30 calendar days old and active; panel status active. */
export function appraiserLicenseGate(a: AppraiserFacts, propertyState: string, on: PlainDate): { open: boolean; reason?: string } {
  if (a.license_state.toUpperCase() !== propertyState.toUpperCase()) return { open: false, reason: `B4-1.1-03: appraiser ${a.party_id} is licensed in ${a.license_state}, not the subject-property state ${propertyState}` };
  if (a.license_expires_on < on) return { open: false, reason: `B4-1.1-03: ${a.license_state} ${a.license_type} license ${a.license_number} expired ${a.license_expires_on} (assignment ${on})` };
  if (a.asc_registry_status !== "active") return { open: false, reason: `ASC National Registry status ${a.asc_registry_status} for ${a.party_id}` };
  const age = daysBetween(a.asc_registry_checked_on, on);
  if (age < 0 || age > ASC_CHECK_MAX_AGE_DAYS) return { open: false, reason: `ASC registry check dated ${a.asc_registry_checked_on} is ${age} days old (> ${ASC_CHECK_MAX_AGE_DAYS})` };
  if ((a.panel_status ?? "active") !== "active") return { open: false, reason: `appraiser_panel status ${a.panel_status}` };
  return { open: true };
}
export interface AmcRegistration { readonly amc_registration_id: string; readonly amc_party_id: string; readonly state: string; readonly registration_number: string; readonly expires_on: PlainDate; readonly asc_amc_registry_status: "active" | "inactive" | "unknown"; readonly verified_at: string; }
/** `amc_registrations.state = property state`, unexpired, ASC AMC registry active (12 U.S.C. 3353(a)/(d)). */
export function amcRegistrationGate(r: AmcRegistration | null, propertyState: string, on: PlainDate): { open: boolean; reason?: string } {
  if (!r) return { open: false, reason: `12 U.S.C. 3353(d): no amc_registrations row for ${propertyState} — use a registered AMC or the direct panel` };
  if (r.state.toUpperCase() !== propertyState.toUpperCase()) return { open: false, reason: `AMC ${r.amc_party_id} registration ${r.registration_number} is for ${r.state}, not ${propertyState}` };
  if (r.expires_on < on) return { open: false, reason: `AMC ${r.amc_party_id} ${r.state} registration ${r.registration_number} expired ${r.expires_on}` };
  if (r.asc_amc_registry_status !== "active") return { open: false, reason: `ASC AMC registry status ${r.asc_amc_registry_status} for ${r.amc_party_id}` };
  return { open: true };
}

// ============================================================ Vendor selection (rotation by geo-competency and turn-time, never by prior values)
export interface VendorCandidate { readonly party_id: string; readonly kind: OrderChannel; readonly states: readonly string[]; readonly counties?: readonly string[]; readonly property_types?: readonly string[]; readonly avg_turn_time_days: number; readonly last_assigned_at: string | null; readonly status: "active" | "suspended" | "removed"; readonly exclusion_reason?: string | null; }
export function selectVendor(cands: readonly VendorCandidate[], f: { state: string; county?: string | null; property_type: string; channel?: OrderChannel | null }): { vendor: VendorCandidate; ranked: readonly string[] } {
  if (!cands.length) throw new RangeError("no vendor candidates");
  for (const c of cands) if (c.exclusion_reason && /value|low|high|conservative/i.test(c.exclusion_reason)) throw new ValuationRefused("AIR_1_2_VALUE_BASED_EXCLUSION", "AIR §1.2; 12 CFR 1026.42(c)(1)", `vendor ${c.party_id} carries a value-based exclusion (${c.exclusion_reason}) — vendors are never excluded for their values`);
  const eligible = cands.filter((c) => c.status === "active" && (!f.channel || c.kind === f.channel) && c.states.map((s) => s.toUpperCase()).includes(f.state.toUpperCase()) && (!c.counties || !f.county || c.counties.includes(f.county)) && (!c.property_types || c.property_types.includes(f.property_type)));
  if (!eligible.length) throw new RangeError(`no active vendor with geo-competency for ${f.state}${f.county ? `/${f.county}` : ""} ${f.property_type}`);
  const ranked = [...eligible].sort((a, b) => a.avg_turn_time_days - b.avg_turn_time_days || (a.last_assigned_at === null ? -1 : b.last_assigned_at === null ? 1 : Date.parse(a.last_assigned_at) - Date.parse(b.last_assigned_at)) || a.party_id.localeCompare(b.party_id));
  return { vendor: ranked[0]!, ranked: ranked.map((c) => c.party_id) };
}

// ============================================================ Orders (valuation_orders) — place, assign, inspect, receive
export interface ValuationOrder {
  readonly order_id: string; readonly application_id: string; readonly status: OrderStatus; readonly assignment_type: AssignmentType; readonly method: ValuationMethod; readonly form_code: FormCode | null; readonly uad_version: UadVersion;
  readonly du_submission_id: string | null; readonly offer_type: OfferType; readonly offer_issued_at: PlainDate | null; readonly offer_expires_on: PlainDate | null;
  readonly ordered_by_agent_run_id: string | null; readonly fee_gate_evidence_id: string | null; readonly fee_quote_cents: Cents | null; readonly fee_invoice_cents: Cents | null; readonly fee_paid_by: FeePaidBy; readonly fee_benchmark_id: string | null;
  readonly channel: OrderChannel; readonly vendor_party_id: string; readonly amc_registration_id: string | null;
  readonly appraiser_party_id: string | null; readonly appraiser_license_state: string | null; readonly appraiser_license_number: string | null; readonly appraiser_license_type: LicenseType | null; readonly appraiser_license_expires_on: PlainDate | null; readonly asc_registry_checked_at: PlainDate | null;
  readonly pdc_id: string | null; readonly property_state: string; readonly first_ucdp_submission_on: PlainDate | null;
  readonly ordered_at: string | null; readonly assigned_at: string | null; readonly inspection_scheduled_at: string | null; readonly inspection_completed_at: string | null; readonly received_at: string | null;
  readonly report_document_id: string | null; readonly effective_date: PlainDate | null; readonly age_12m_expires_on: PlainDate | null; readonly age_4m_update_after: PlainDate | null;
  readonly cancel_reason: string | null; readonly reassigned_from_order_id: string | null; readonly parent_order_id: string | null; readonly transferred_from_lender: boolean; readonly transfer_air_attestation_document_id: string | null; readonly vendor_order_id: string | null;
  readonly time_zone: string;
}
export interface AmcPort { createOrder(payload: Record<string, unknown>): { vendor_order_id: string }; cancelOrder(vendorOrderId: string, reason: string): void; addDocument(vendorOrderId: string, documentId: string, kind: string): void; getStatus(vendorOrderId: string): { status: string }; }
/** In-process AMC adapter (idempotent on `idempotency_key` = order_id; the payload it receives has already passed the AIR allowlist). */
export class FakeAmc implements AmcPort {
  readonly orders = new Map<string, { vendor_order_id: string; payload: Record<string, unknown>; status: string; documents: { documentId: string; kind: string }[] }>();
  createOrder(payload: Record<string, unknown>): { vendor_order_id: string } {
    const key = String(payload.idempotency_key ?? payload.order_id ?? "");
    if (!key) throw new RangeError("idempotency_key is required");
    const existing = this.orders.get(key); if (existing) return { vendor_order_id: existing.vendor_order_id };
    const v = { vendor_order_id: `AMC-${this.orders.size + 1}`, payload, status: "ordered", documents: [] }; this.orders.set(key, v); return { vendor_order_id: v.vendor_order_id };
  }
  cancelOrder(vendorOrderId: string, reason: string): void { for (const o of this.orders.values()) if (o.vendor_order_id === vendorOrderId) o.status = `cancelled:${reason}`; }
  addDocument(vendorOrderId: string, documentId: string, kind: string): void { for (const o of this.orders.values()) if (o.vendor_order_id === vendorOrderId) o.documents.push({ documentId, kind }); }
  getStatus(vendorOrderId: string): { status: string } { for (const o of this.orders.values()) if (o.vendor_order_id === vendorOrderId) return { status: o.status }; throw new RangeError(`no vendor order ${vendorOrderId}`); }
}
export interface PlaceOrderInput {
  readonly application_id: string; readonly selection: MethodSelection; readonly offer: DuOffer; readonly ordered_at: string; readonly property_state: string; readonly channel: OrderChannel; readonly vendor_party_id: string;
  readonly fee_paid_by: FeePaidBy; readonly fee_quote_cents: Cents; readonly fee_test: FeeTest; readonly fee_gate: { le_effective_receipt_date: PlainDate | null; intent: IntentRecord | null; order_before_itp?: boolean; fee_item_id?: string | null };
  readonly amc_registration?: AmcRegistration | null; readonly order_payload: Record<string, unknown>; readonly amc?: AmcPort | null; readonly pdc_id?: string | null; readonly first_ucdp_submission_on?: PlainDate | null;
  readonly application_status?: string; readonly assignment_type?: AssignmentType; readonly parent_order_id?: string | null; readonly reassigned_from_order_id?: string | null; readonly agent_run_id?: string | null; readonly time_zone?: string;
}
/**
 * `placeOrder`: restricted-party check → application not withdrawn/denied → fee gate (R2) → fee benchmark held? → AMC registration gate (AMC path) → AIR payload allowlist →
 * `valuation.ordered` (satisfies SM_VALUATION_ORDER_SLA_1BD; arms the assign/report SLAs, FNMA_UAD_3_6_REQUIRED_GATE and SM_AMC_REGISTRATION_GATE) then `valuation.amc.verified` (the gate's satisfying snapshot).
 */
export function placeOrder(events: EventStore, i: PlaceOrderInput, actor: Actor = VALUATION_AGENT): { order: ValuationOrder; event: DomainEvent; fee_gate: OrderFeeGateResult } {
  nonEmpty(i.application_id, "application_id"); isoOrThrow(i.ordered_at, "ordered_at"); nonEmpty(i.property_state, "property_state"); nonEmpty(i.vendor_party_id, "vendor_party_id");
  assertNotRestrictedParty(actor, "placeOrder");
  if (i.application_status === "withdrawn" || i.application_status === "denied") throw new ValuationRefused("SM_VALUATION_APPLICATION_CLOSED", "24.1 state machine guards", `no order while applications.status = ${i.application_status}`);
  if (i.selection.method === "value_acceptance") throw new ValuationRefused("FNMA_B4_1_4_10_NO_APPRAISAL", "B4-1.4-10", "value acceptance is exercised without an appraisal; nothing to order");
  const tz = i.time_zone ?? CREDITOR_TZ; const on = civilDate(i.ordered_at, tz);
  const command: FeeGateCommand = i.selection.method === "value_acceptance_pd" ? "order_pdc" : "order_appraisal";
  const fee_gate = assertFeeGate(events, { application_id: i.application_id, command, fee_paid_by: i.fee_paid_by, amount_cents: i.fee_quote_cents, checked_at: i.ordered_at, le_effective_receipt_date: i.fee_gate.le_effective_receipt_date, intent: i.fee_gate.intent, fee_item_id: i.fee_gate.fee_item_id ?? null, ...(i.fee_gate.order_before_itp !== undefined ? { order_before_itp: i.fee_gate.order_before_itp } : {}), time_zone: tz }, actor);
  if (i.fee_test.held_for_requote) throw new ValuationRefused("REGZ_1026_42F_FEE_BENCHMARK", "12 CFR 1026.42(f)(1)–(2)", `order held for vendor re-quote: ${i.fee_test.reason}`);
  let amc_registration_id: string | null = null;
  if (i.channel === "amc") {
    const g = amcRegistrationGate(i.amc_registration ?? null, i.property_state, on);
    if (!g.open) throw new ValuationRefused("SM_AMC_REGISTRATION_GATE", "12 U.S.C. 3353; 24.1 timer table", g.reason!);
    amc_registration_id = i.amc_registration!.amc_registration_id;
  }
  const order_id = randomUUID();
  guardOrderPayload(events, i.application_id, order_id, i.order_payload, i.ordered_at, actor);
  const vendor_order_id = i.amc ? i.amc.createOrder({ ...i.order_payload, order_id, idempotency_key: order_id }).vendor_order_id : null;
  const assignment_type = i.assignment_type ?? i.selection.assignment_type ?? "traditional";
  const order: ValuationOrder = { order_id, application_id: i.application_id, status: "ordered", assignment_type, method: i.selection.method, form_code: i.selection.form_code, uad_version: i.selection.uad_version,
    du_submission_id: i.offer.du_submission_id, offer_type: i.offer.offer_type, offer_issued_at: i.offer.offer_issued_at, offer_expires_on: i.offer.offer_issued_at ? offerExpiresOn(i.offer.offer_issued_at) : null,
    ordered_by_agent_run_id: i.agent_run_id ?? null, fee_gate_evidence_id: fee_gate.evidence_id, fee_quote_cents: i.fee_quote_cents, fee_invoice_cents: null, fee_paid_by: i.fee_paid_by, fee_benchmark_id: i.fee_test.benchmark_id,
    channel: i.channel, vendor_party_id: i.vendor_party_id, amc_registration_id, appraiser_party_id: null, appraiser_license_state: null, appraiser_license_number: null, appraiser_license_type: null, appraiser_license_expires_on: null, asc_registry_checked_at: null,
    pdc_id: i.pdc_id ?? null, property_state: i.property_state.toUpperCase(), first_ucdp_submission_on: i.first_ucdp_submission_on ?? null, ordered_at: i.ordered_at, assigned_at: null, inspection_scheduled_at: null, inspection_completed_at: null, received_at: null,
    report_document_id: null, effective_date: null, age_12m_expires_on: null, age_4m_update_after: null, cancel_reason: null, reassigned_from_order_id: i.reassigned_from_order_id ?? null, parent_order_id: i.parent_order_id ?? null, transferred_from_lender: false, transfer_air_attestation_document_id: null, vendor_order_id, time_zone: tz };
  const event = emit(events, i.application_id, "valuation.ordered", { order_id, ordered_at: i.ordered_at, ordered_on: on, assignment_type, method: order.method, form_code: order.form_code, uad_version: order.uad_version, channel: i.channel, vendor_party_id: i.vendor_party_id, fee_quote_cents: String(i.fee_quote_cents), fee_paid_by: i.fee_paid_by,
    fee_gate_evidence_id: fee_gate.evidence_id, first_ucdp_submission_on: order.first_ucdp_submission_on, pdc_id: order.pdc_id, vendor_order_id, payload_hash: payloadHash(i.order_payload), reassigned_from_order_id: order.reassigned_from_order_id }, i.ordered_at, actor);
  if (i.channel === "amc") emit(events, i.application_id, "valuation.amc.verified", { order_id, amc_registration_id, amc_party_id: i.amc_registration!.amc_party_id, state: i.amc_registration!.state, registration_number: i.amc_registration!.registration_number, expires_on: i.amc_registration!.expires_on, verified_at: i.amc_registration!.verified_at }, i.ordered_at, actor);
  return { order, event, fee_gate };
}
/** Stable hash of the outbound payload (audit: "engagement letter and payload hash (proving no value information was sent)"). */
export function payloadHash(payload: Record<string, unknown>): string {
  const s = JSON.stringify(payload, Object.keys(payload).sort()); let h = 0x811c9dc5;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `fnv1a:${h.toString(16).padStart(8, "0")}:${s.length}`;
}

/** `assignAppraiser`: SM_APPRAISER_LICENSE_GATE blocks the assignment (order reassigned, linked by `reassigned_from_order_id`) or `valuation.assigned` then the `appraiser_panel` verification snapshot (`valuation.appraiser.verified`). */
export function assignAppraiser(events: EventStore, order: ValuationOrder, a: AppraiserFacts, assignedAt: string, actor: Actor = { kind: "external", id: "amc" }): { order: ValuationOrder; gate: { open: boolean; reason?: string }; event: DomainEvent; reassigned: boolean } {
  isoOrThrow(assignedAt, "assigned_at");
  if (order.status !== "ordered") throw new RangeError(`order ${order.order_id} is ${order.status}, not ordered`);
  const on = civilDate(assignedAt, order.time_zone);
  const gate = appraiserLicenseGate(a, order.property_state, on);
  if (!gate.open) {
    const new_order_id = randomUUID();
    const event = emit(events, order.application_id, "valuation.order.reassigned", { order_id: order.order_id, new_order_id, reason: "SM_APPRAISER_LICENSE_GATE", detail: gate.reason, appraiser_party_id: a.party_id, reassigned_at: assignedAt }, assignedAt, actor);
    return { order: { ...order, order_id: new_order_id, reassigned_from_order_id: order.order_id, status: "ordered" }, gate, event, reassigned: true };
  }
  const next: ValuationOrder = { ...order, status: "assigned", assigned_at: assignedAt, appraiser_party_id: a.party_id, appraiser_license_state: a.license_state, appraiser_license_number: a.license_number, appraiser_license_type: a.license_type, appraiser_license_expires_on: a.license_expires_on, asc_registry_checked_at: a.asc_registry_checked_on };
  const event = emit(events, order.application_id, "valuation.assigned", { order_id: order.order_id, assigned_at: assignedAt, assigned_on: on, appraiser_party_id: a.party_id, appraiser_license_state: a.license_state, appraiser_license_type: a.license_type, appraiser_license_number: a.license_number, pdc_id: order.pdc_id, pdc_shared_at_engagement: order.pdc_id !== null }, assignedAt, actor);
  emit(events, order.application_id, "valuation.appraiser.verified", { order_id: order.order_id, appraiser_party_id: a.party_id, license_state: a.license_state, license_type: a.license_type, license_number: a.license_number, license_expires_on: a.license_expires_on, asc_registry_status: a.asc_registry_status, asc_registry_checked_on: a.asc_registry_checked_on, verified_on: on }, assignedAt, VALUATION_AGENT);
  return { order: next, gate, event, reassigned: false };
}
export function scheduleInspection(events: EventStore, order: ValuationOrder, scheduledAt: string, scheduledFor: string, actor: Actor = VALUATION_AGENT): { order: ValuationOrder; event: DomainEvent } {
  isoOrThrow(scheduledAt, "scheduled_at"); isoOrThrow(scheduledFor, "scheduled_for");
  if (order.status !== "assigned") throw new RangeError(`order ${order.order_id} is ${order.status}, not assigned`);
  const event = emit(events, order.application_id, "valuation.inspection.scheduled", { order_id: order.order_id, scheduled_at: scheduledAt, scheduled_for: scheduledFor, content: "scheduling only — the valuation agent never discusses value with the borrower" }, scheduledAt, actor);
  return { order: { ...order, status: "inspection_scheduled", inspection_scheduled_at: scheduledFor }, event };
}
/** `valuation.inspection.completed` (satisfies SM_VALUATION_INSPECT_SLA_7CD). */
export function completeInspection(events: EventStore, order: ValuationOrder, completedAt: string, actor: Actor = { kind: "external", id: "amc" }): { order: ValuationOrder; event: DomainEvent } {
  isoOrThrow(completedAt, "completed_at");
  if (order.status !== "assigned" && order.status !== "inspection_scheduled") throw new RangeError(`order ${order.order_id} is ${order.status}`);
  const event = emit(events, order.application_id, "valuation.inspection.completed", { order_id: order.order_id, inspection_completed_at: completedAt, inspected_on: civilDate(completedAt, order.time_zone) }, completedAt, actor);
  return { order: { ...order, status: "inspected", inspection_completed_at: completedAt }, event };
}

export const THIRD_PARTY_COSTS: AccountRef = { scope: "corporate", account: "third_party_costs" as CorporateAccount };
export const ACCOUNTS_PAYABLE_VENDOR: AccountRef = { scope: "corporate", account: "accounts_payable_vendor" as CorporateAccount };
export const ORIGINATION_FEES_RECEIVABLE: AccountRef = { scope: "corporate", account: "origination_fees_receivable" as CorporateAccount };
export interface ReportDelivery { readonly report_document_id: string; readonly uad_version: UadVersion; readonly effective_date: PlainDate; readonly received_at: string; readonly assignment_type?: AssignmentType; readonly declined?: boolean; readonly lender_client_name?: string | null; readonly partner_name?: string | null; readonly fee_invoice_cents?: Cents | null; readonly delivered_by?: "vendor" | "borrower" | "seller" | "agent" | "other_lender"; }
export interface ReceiptResult { readonly accepted: boolean; readonly order: ValuationOrder; readonly event: DomainEvent; readonly reference: string | null; readonly reengagement: DomainEvent | null; readonly ledger_set: EntrySet | null; readonly dates: AppraisalAgeDates | null; }
/**
 * `receiveReport`: a UAD 2.6 file for an engagement that requires UAD 3.6 (engaged 3.6, or first UCDP submission on/after Nov 2, 2026) is rejected with FNM0391 and re-engaged; a report addressed to the wrong
 * lender/client is returned; a report from the borrower/seller/agent is never accepted (B4-1.1-03). Otherwise `valuation.received` (closes 24.1, opens 24.2; arms the 12-month and 4-month age rows from
 * `effective_date`; `assignment_type`/`declined` satisfy FNMA_B4_1_2_04_APPRAISAL_UPDATE_4M for an update) and the SM-borne fee posts `third_party_costs` / `accounts_payable_vendor`.
 */
export function receiveReport(events: EventStore, order: ValuationOrder, r: ReportDelivery, ledger: Ledger | null = null, actor: Actor = { kind: "external", id: "amc" }): ReceiptResult {
  nonEmpty(r.report_document_id, "report_document_id"); isoOrThrow(r.received_at, "received_at"); plainDate(r.effective_date);
  if (r.delivered_by === "borrower" || r.delivered_by === "seller" || r.delivered_by === "agent") throw new ValuationRefused("FNMA_B4_1_1_03_INTERESTED_PARTY", "B4-1.1-03", `appraisals ordered or received by the ${r.delivered_by} or other interested parties are never used`);
  const uadRequired = order.uad_version === "3.6" || (order.first_ucdp_submission_on !== null && uad36RequiredForSubmission(order.first_ucdp_submission_on));
  const reject = (reference: string, detail: string): ReceiptResult => {
    const event = emit(events, order.application_id, "valuation.report.rejected", { order_id: order.order_id, report_document_id: r.report_document_id, reference, detail, uad_version_received: r.uad_version, uad_version_required: uadRequired ? "3.6" : order.uad_version, rejected_at: r.received_at }, r.received_at, actor);
    const reengagement = emit(events, order.application_id, "valuation.engagement.reissued", { order_id: order.order_id, reason: reference, detail, uad_version: "3.6", vendor_party_id: order.vendor_party_id, reissued_at: r.received_at }, r.received_at, VALUATION_AGENT);
    return { accepted: false, order, event, reference, reengagement, ledger_set: null, dates: null };
  };
  if (uadRequired && r.uad_version !== "3.6") return reject(FNM0391, `This appraisal report was submitted in UAD 2.6 format and is not accepted. As of November 2, 2026, all new UCDP submissions must be in UAD 3.6 format (order ${order.order_id} engaged UAD ${order.uad_version}${order.first_ucdp_submission_on ? `, first UCDP submission ${order.first_ucdp_submission_on}` : ""})`);
  if (r.partner_name && r.lender_client_name && r.lender_client_name.trim().toLowerCase() !== r.partner_name.trim().toLowerCase()) return reject("wrong_lender_client", `report names ${r.lender_client_name} as lender/client; the partner (${r.partner_name}) must be the lender/client for reuse and Reg B copies`);
  const assignment_type = r.assignment_type ?? order.assignment_type; const declined = r.declined === true;
  const dates = appraisalAgeDates(r.effective_date);
  const next: ValuationOrder = { ...order, status: "report_received", received_at: r.received_at, report_document_id: r.report_document_id, effective_date: r.effective_date, age_4m_update_after: dates.age_4m_update_after, age_12m_expires_on: dates.age_12m_expires_on, fee_invoice_cents: r.fee_invoice_cents ?? order.fee_quote_cents, uad_version: r.uad_version };
  const event = emit(events, order.application_id, "valuation.received", { order_id: order.order_id, report_document_id: r.report_document_id, effective_date: r.effective_date, assignment_type, declined, uad_version: r.uad_version, form_code: order.form_code, method: order.method,
    age_4m_update_after: dates.age_4m_update_after, age_12m_expires_on: dates.age_12m_expires_on, received_at: r.received_at, received_on: civilDate(r.received_at, order.time_zone), transferred_from_lender: order.transferred_from_lender, appraiser_party_id: order.appraiser_party_id, appraiser_license_number: order.appraiser_license_number,
    fee_invoice_cents: next.fee_invoice_cents === null ? null : String(next.fee_invoice_cents), fee_paid_by: order.fee_paid_by, parent_order_id: order.parent_order_id, opens: "24.2" }, r.received_at, actor);
  let ledger_set: EntrySet | null = null;
  if (ledger && next.fee_invoice_cents !== null && next.fee_invoice_cents > 0n) ledger_set = postValuationCost(ledger, next, r.received_at, event.id);
  return { accepted: true, order: next, event, reference: null, reengagement: null, ledger_set, dates };
}
/** Ledger on `valuation.received`: SM-borne → `third_party_costs` debit / `accounts_payable_vendor` credit; borrower-paid → `origination_fees_receivable` debit / vendor payable credit. Balanced set with rule_ref. */
export function postValuationCost(ledger: Ledger, order: ValuationOrder, at: string, sourceEventId?: string): EntrySet {
  const amount = order.fee_invoice_cents ?? order.fee_quote_cents;
  if (amount === null || amount <= 0n) throw new RangeError("fee_invoice_cents is required to post the valuation cost");
  const debit = order.fee_paid_by === "borrower" ? ORIGINATION_FEES_RECEIVABLE : THIRD_PARTY_COSTS;
  return ledger.post({ effectiveDate: civilDate(at, order.time_zone), description: `valuation order ${order.order_id} ${order.assignment_type} ${order.form_code ?? ""} fee (${order.fee_paid_by === "borrower" ? "borrower-paid, zero tolerance" : "SM-borne; CD Paid by Others (L)"})`, ...(sourceEventId ? { sourceEventId } : {}),
    lines: [{ account: debit, amountCents: amount, ruleRef: `24.1 outputs: ${order.fee_paid_by === "borrower" ? "origination_fees_receivable when borrower-paid" : "third_party_costs debit on valuation.received (SM-borne)"}` }, { account: ACCOUNTS_PAYABLE_VENDOR, amountCents: -amount, ruleRef: "24.1 outputs: accounts_payable_vendor credit on valuation.received" }] }, at);
}
export function cancelOrder(events: EventStore, order: ValuationOrder, reason: string, at: string, amc: AmcPort | null = null, actor: Actor = VALUATION_AGENT): { order: ValuationOrder; event: DomainEvent } {
  nonEmpty(reason, "cancel_reason"); isoOrThrow(at, "cancelled_at");
  if (order.status === "cancelled") throw new RangeError(`order ${order.order_id} is already cancelled`);
  if (amc && order.vendor_order_id && order.status !== "report_received") amc.cancelOrder(order.vendor_order_id, reason);   // a received report is superseded (declined update → new appraisal), not recalled from the vendor
  const event = emit(events, order.application_id, "valuation.order.cancelled", { order_id: order.order_id, reason, cancelled_at: at, vendor_order_id: order.vendor_order_id }, at, actor);
  return { order: { ...order, status: "cancelled", cancel_reason: reason }, event };
}
/** Closing slipped past the 4-month mark: a child `appraisal_update` order (UAD 3.6 Restricted Appraisal Update Report; 1004D under 2.6) — `valuation.update.ordered`. */
export function orderAppraisalUpdate(events: EventStore, parent: ValuationOrder, orderedAt: string, noteDate: PlainDate, actor: Actor = VALUATION_AGENT): { order: ValuationOrder; event: DomainEvent; window: { from: PlainDate; to: PlainDate } } {
  isoOrThrow(orderedAt, "ordered_at");
  if (parent.effective_date === null) throw new RangeError(`order ${parent.order_id} has no effective_date to update`);
  const age = appraisalAgeStatus(parent.effective_date, noteDate);
  if (age.status !== "update_required") throw new ValuationRefused("FNMA_B4_1_2_04_UPDATE_NOT_APPLICABLE", "B4-1.2-04", age.reason);
  const uad = uadVersionForEngagement(civilDate(orderedAt, parent.time_zone));
  const child: ValuationOrder = { ...parent, order_id: randomUUID(), status: "ordered", assignment_type: "appraisal_update", form_code: uad === "3.6" ? "update_uad36" : "1004D", uad_version: uad, parent_order_id: parent.order_id, ordered_at: orderedAt, assigned_at: null, inspection_scheduled_at: null, inspection_completed_at: null, received_at: null, report_document_id: null, effective_date: null, age_12m_expires_on: null, age_4m_update_after: null, fee_invoice_cents: null };
  const event = emit(events, parent.application_id, "valuation.update.ordered", { order_id: child.order_id, parent_order_id: parent.order_id, ordered_at: orderedAt, ordered_on: civilDate(orderedAt, parent.time_zone), form_code: child.form_code, uad_version: uad, original_effective_date: parent.effective_date, note_date: noteDate, window_from: age.update_window!.from, window_to: age.update_window!.to, scope: "exterior inspection and current market data — has the property declined in value" }, orderedAt, actor);
  return { order: child, event, window: age.update_window! };
}
/** The update report received: `valuation.received{assignment_type=appraisal_update, declined}`; "declined" cancels the original (new appraisal required → `method_pending`). */
export function receiveAppraisalUpdate(events: EventStore, parent: ValuationOrder, child: ValuationOrder, u: AppraisalUpdate & { received_at: string }, noteDate: PlainDate, actor: Actor = { kind: "external", id: "amc" }): { evaluation: ReturnType<typeof evaluateAppraisalUpdate>; receipt: ReceiptResult; parent: ValuationOrder } {
  const receipt = receiveReport(events, child, { report_document_id: u.report_document_id, uad_version: child.uad_version, effective_date: u.effective_date, received_at: u.received_at, assignment_type: "appraisal_update", declined: u.declined }, null, actor);
  const evaluation = evaluateAppraisalUpdate(parent.effective_date!, noteDate, u);
  if (evaluation.next_status === "method_pending") {
    const c = cancelOrder(events, parent, "appraisal_update_declined_new_appraisal_required", u.received_at, null, VALUATION_AGENT);
    return { evaluation, receipt, parent: { ...c.order, status: "method_pending" } };
  }
  return { evaluation, receipt, parent: evaluation.open ? { ...parent, status: "report_received" } : { ...parent, status: "update_required" } };
}

// ============================================================ Property data collection (B4-1.4-11; PDCIR)
export interface PropertyDataCollection {
  readonly pdc_id: string; readonly application_id: string; readonly valuation_order_id: string | null; readonly vendor_party_id: string; readonly collector_party_id: string; readonly collector_background_check_on: PlainDate; readonly collector_training_evidence_id: string; readonly pdcir_attestation_id: string;
  readonly ordered_at: string; readonly collected_at: string | null; readonly upd_version: string | null; readonly floor_plan_document_id: string | null; readonly image_document_ids: readonly string[]; readonly safety_issue_flag: boolean; readonly safety_issue_notes: string | null;
  readonly property_data_id_fnma: string | null; readonly submitted_at: string | null; readonly accepted_on: PlainDate | null; readonly submission_status: "pending" | "accepted" | "rejected"; readonly rejection_messages: readonly string[]; readonly status: OrderStatus;
}
export interface PdcCollectorFacts { readonly vendor_party_id: string; readonly collector_party_id: string; readonly collector_background_check_on: PlainDate; readonly collector_training_evidence_id: string; readonly pdcir_attestation_id: string; }
/** `pdc.ordered`: a trained and vetted collector (annual background check < 12 months old; training evidence; PDCIR attestation on file). */
export function orderPdc(events: EventStore, applicationId: string, c: PdcCollectorFacts, orderedAt: string, feeGate: OrderFeeGateResult, valuationOrderId: string | null = null, actor: Actor = VALUATION_AGENT): { pdc: PropertyDataCollection; event: DomainEvent } {
  nonEmpty(applicationId, "application_id"); isoOrThrow(orderedAt, "ordered_at"); nonEmpty(c.collector_party_id, "collector_party_id"); nonEmpty(c.collector_training_evidence_id, "collector_training_evidence_id"); nonEmpty(c.pdcir_attestation_id, "pdcir_attestation_id");
  assertNotRestrictedParty(actor, "orderPdc");
  const on = civilDate(orderedAt);
  if (addMonths(c.collector_background_check_on, COLLECTOR_BACKGROUND_CHECK_MONTHS) <= on) throw new ValuationRefused("FNMA_B4_1_4_11_COLLECTOR_VETTING", "B4-1.4-11: vetted through an annual background check", `collector ${c.collector_party_id} background check ${c.collector_background_check_on} is 12 months or older on ${on}`);
  const pdc: PropertyDataCollection = { pdc_id: randomUUID(), application_id: applicationId, valuation_order_id: valuationOrderId, ...c, ordered_at: orderedAt, collected_at: null, upd_version: null, floor_plan_document_id: null, image_document_ids: [], safety_issue_flag: false, safety_issue_notes: null, property_data_id_fnma: null, submitted_at: null, accepted_on: null, submission_status: "pending", rejection_messages: [], status: "pdc_ordered" };
  const event = emit(events, applicationId, "pdc.ordered", { pdc_id: pdc.pdc_id, vendor_party_id: c.vendor_party_id, collector_party_id: c.collector_party_id, collector_background_check_on: c.collector_background_check_on, pdcir_attestation_id: c.pdcir_attestation_id, ordered_at: orderedAt, ordered_on: on, fee_gate_evidence_id: feeGate.evidence_id }, orderedAt, actor);
  return { pdc, event };
}
export interface PdcCollected { readonly collected_at: string; readonly upd_version: string; readonly floor_plan_document_id: string; readonly image_document_ids: readonly string[]; readonly safety_issue_flag: boolean; readonly safety_issue_notes?: string | null; readonly interior_observed: boolean; readonly exterior_observed: boolean; readonly ansi_floor_plan: boolean; }
/** `pdc.collected` (UPD; ANSI floor plan; interior + exterior); a safety flag adds `pdc.safety_issue.flagged`. */
export function recordPdcCollection(events: EventStore, pdc: PropertyDataCollection, c: PdcCollected, actor: Actor = { kind: "external", id: "property_data_collector" }): { pdc: PropertyDataCollection; event: DomainEvent; safety_event: DomainEvent | null } {
  isoOrThrow(c.collected_at, "collected_at"); nonEmpty(c.upd_version, "upd_version"); nonEmpty(c.floor_plan_document_id, "floor_plan_document_id");
  if (!c.interior_observed || !c.exterior_observed) throw new ValuationRefused("FNMA_B4_1_4_11_SCOPE", "B4-1.4-11", "the collection consists of a visual observation of the interior and exterior areas of the subject property");
  if (!c.ansi_floor_plan) throw new ValuationRefused("FNMA_B4_1_4_11_ANSI", "B4-1.4-11", "photos and a floor plan conforming to the ANSI Standard are required");
  if (!c.image_document_ids.length) throw new RangeError("image_document_ids is required");
  const next: PropertyDataCollection = { ...pdc, collected_at: c.collected_at, upd_version: c.upd_version, floor_plan_document_id: c.floor_plan_document_id, image_document_ids: [...c.image_document_ids], safety_issue_flag: c.safety_issue_flag, safety_issue_notes: c.safety_issue_notes ?? null, status: "pdc_collected" };
  const event = emit(events, pdc.application_id, "pdc.collected", { pdc_id: pdc.pdc_id, collected_at: c.collected_at, collected_on: civilDate(c.collected_at), upd_version: c.upd_version, floor_plan_document_id: c.floor_plan_document_id, image_count: c.image_document_ids.length, safety_issue_flag: c.safety_issue_flag, valid_until: addMonths(civilDate(c.collected_at), PDC_VALIDITY_MONTHS) }, c.collected_at, actor);
  const safety_event = c.safety_issue_flag ? emit(events, pdc.application_id, "pdc.safety_issue.flagged", { pdc_id: pdc.pdc_id, notes: c.safety_issue_notes ?? null, flagged_at: c.collected_at, rule: "B4-1.4-11 lender representation: the property does not have safety, soundness, or structural integrity issues" }, c.collected_at, actor) : null;
  return { pdc: next, event, safety_event };
}
export interface PropertyDataPort { submit(upd: { pdc_id: string; application_id: string; upd_version: string; floor_plan_document_id: string; image_document_ids: readonly string[] }): { status: "accepted" | "rejected"; property_data_id: string | null; messages: readonly string[] }; }
/** In-process Property Data API (Developer Portal REST, partner-scoped System ID): returns a Property Data ID unless told to reject. */
export class FakePropertyDataApi implements PropertyDataPort {
  readonly submissions: { pdc_id: string; property_data_id: string | null; status: string }[] = [];
  private readonly rejectWith: readonly string[];
  constructor(rejectWith: readonly string[] = []) { this.rejectWith = rejectWith; }
  submit(upd: { pdc_id: string; application_id: string; upd_version: string; floor_plan_document_id: string; image_document_ids: readonly string[] }): { status: "accepted" | "rejected"; property_data_id: string | null; messages: readonly string[] } {
    if (!upd.floor_plan_document_id || !upd.image_document_ids.length) return { status: "rejected", property_data_id: null, messages: ["UPD: floor plan and images are required"] };
    if (this.rejectWith.length) { this.submissions.push({ pdc_id: upd.pdc_id, property_data_id: null, status: "rejected" }); return { status: "rejected", property_data_id: null, messages: this.rejectWith }; }
    const id = `PDID-${String(this.submissions.length + 1).padStart(6, "0")}`; this.submissions.push({ pdc_id: upd.pdc_id, property_data_id: id, status: "accepted" });
    return { status: "accepted", property_data_id: id, messages: [] };
  }
}
/** `pdc.submitted` then `pdc.accepted{property_data_id_fnma}` (satisfies FNMA_B4_1_4_11_PDC_API_SUBMIT_GATE) or `pdc.rejected{messages}`. Submission must precede the note date. */
export function submitPropertyData(events: EventStore, pdc: PropertyDataCollection, api: PropertyDataPort, submittedAt: string, actor: Actor = VALUATION_AGENT): { pdc: PropertyDataCollection; submitted: DomainEvent; outcome: DomainEvent } {
  isoOrThrow(submittedAt, "submitted_at");
  if (pdc.status !== "pdc_collected" && pdc.submission_status !== "rejected") throw new RangeError(`pdc ${pdc.pdc_id} is ${pdc.status}, not collected`);
  if (pdc.safety_issue_flag) throw new ValuationRefused("FNMA_B4_1_4_11_SAFETY_ISSUE", "B4-1.4-11 lender representation", `pdc ${pdc.pdc_id} reports a safety issue — VA+PD cannot be exercised; convert the method`);
  const submitted = emit(events, pdc.application_id, "pdc.submitted", { pdc_id: pdc.pdc_id, submitted_at: submittedAt, upd_version: pdc.upd_version }, submittedAt, actor);
  const r = api.submit({ pdc_id: pdc.pdc_id, application_id: pdc.application_id, upd_version: pdc.upd_version ?? "", floor_plan_document_id: pdc.floor_plan_document_id ?? "", image_document_ids: pdc.image_document_ids });
  if (r.status === "accepted" && r.property_data_id) {
    const accepted_on = civilDate(submittedAt, "America/New_York");
    const outcome = emit(events, pdc.application_id, "pdc.accepted", { pdc_id: pdc.pdc_id, property_data_id_fnma: r.property_data_id, accepted_on, accepted_at: submittedAt, sfc: SFC_VALUE_ACCEPTANCE_PD }, submittedAt, { kind: "external", id: "fnma" });
    return { pdc: { ...pdc, submitted_at: submittedAt, property_data_id_fnma: r.property_data_id, accepted_on, submission_status: "accepted", rejection_messages: [], status: "pdc_accepted" }, submitted, outcome };
  }
  const outcome = emit(events, pdc.application_id, "pdc.rejected", { pdc_id: pdc.pdc_id, messages: [...r.messages], rejected_at: submittedAt }, submittedAt, { kind: "external", id: "fnma" });
  return { pdc: { ...pdc, submitted_at: submittedAt, submission_status: "rejected", rejection_messages: [...r.messages], status: "pdc_submitted" }, submitted, outcome };
}
/** FNMA_B4_1_4_11_PDC_API_SUBMIT_GATE at `consummate`: the Property Data ID must be held before the note date (and the collection < 12 months old). */
export function pdcSubmitGate(f: { property_data_id_fnma: string | null; accepted_on: PlainDate | null; collected_on?: PlainDate | null; note_date: PlainDate }): { open: boolean; reason?: string } {
  if (!f.property_data_id_fnma || !f.accepted_on) return { open: false, reason: "B4-1.4-11: the property data collection is submitted to the Property Data API prior to the note date — no Property Data ID held" };
  if (f.accepted_on >= f.note_date) return { open: false, reason: `B4-1.4-11: Property Data ID ${f.property_data_id_fnma} accepted ${f.accepted_on} is not prior to the note date ${f.note_date}` };
  if (f.collected_on && addMonths(f.collected_on, PDC_VALIDITY_MONTHS) <= f.note_date) return { open: false, reason: `B4-1.4-11: collection dated ${f.collected_on} is not valid on the note date ${f.note_date} (12 months)` };
  return { open: true };
}
/** A safety flag (or offer loss with a PDC on file): VA+PD is blocked; R1 re-runs; the PDC is shared with the appraiser at engagement (B4-1.2-03); the conversion and the lender-representation rule are recorded. */
export function convertOnSafetyIssue(events: EventStore, applicationId: string, pdc: PropertyDataCollection, facts: Omit<MethodFacts, "pdc_on_file" | "pdc_safety_issue" | "offer_type">, at: string, offer: DuOffer, actor: Actor = VALUATION_AGENT): { selection: MethodSelection; conversion: "converted_to_hybrid" | "converted_to_traditional"; event: DomainEvent; decision: ValuationDecision; pdc_shared: boolean } {
  if (!pdc.safety_issue_flag) throw new RangeError(`pdc ${pdc.pdc_id} carries no safety issue`);
  const selection = selectMethod({ ...facts, offer_type: offer.offer_type, pdc_on_file: true, pdc_safety_issue: true });
  if (selection.method === "value_acceptance" || selection.method === "value_acceptance_pd") throw new RangeError("R1 must not select a value-acceptance method with a safety issue");
  const conversion = selection.method === "hybrid" ? "converted_to_hybrid" : "converted_to_traditional";
  const citation = "B4-1.4-11: the lender represents the property does not have safety, soundness, or structural integrity issues; a collection reporting one cannot support value acceptance + property data";
  const event = recordMethodSelection(events, applicationId, selection, at, { offer_type: offer.offer_type, du_submission_id: offer.du_submission_id, conversion, pdc_id: pdc.pdc_id, actor });
  const decision = decisionRecord(selection, { application_id: applicationId, offer_type: offer.offer_type, du_submission_id: offer.du_submission_id, extra_rationale: `${conversion}: PDC ${pdc.pdc_id} (${pdc.safety_issue_notes ?? "safety issue"}) shared with the appraiser at engagement`, citations: [citation, "B4-1.2-03: the lender must share the property data collection with the appraiser at the time of engagement"] });
  return { selection, conversion, event, decision, pdc_shared: selection.method === "hybrid" };
}
/** ULDD data points for 29.3: SFC 801 (value acceptance) or 774 (VA+PD) with the Property Data ID; form/UAD version and appraiser license for appraisals. */
export function deliveryData(o: { method: ValuationMethod; form_code?: FormCode | null; uad_version?: UadVersion | null; appraiser_license_number?: string | null; appraiser_license_state?: string | null }, pdc: PropertyDataCollection | null): { special_feature_codes: readonly string[]; property_data_id_fnma: string | null; appraisal_form: FormCode | null; uad_version: UadVersion | null; appraiser_license: string | null } {
  if (o.method === "value_acceptance_pd" && (!pdc || !pdc.property_data_id_fnma)) throw new ValuationRefused("FNMA_B4_1_4_11_PDC_API_SUBMIT_GATE", "B4-1.4-11", "delivery of value acceptance + property data needs the Property Data ID");
  return { special_feature_codes: o.method === "value_acceptance" ? [SFC_VALUE_ACCEPTANCE] : o.method === "value_acceptance_pd" ? [SFC_VALUE_ACCEPTANCE_PD] : [], property_data_id_fnma: pdc?.property_data_id_fnma ?? null, appraisal_form: o.form_code ?? null, uad_version: o.uad_version ?? null, appraiser_license: o.appraiser_license_number ? `${o.appraiser_license_state ?? ""}:${o.appraiser_license_number}` : null };
}

// ============================================================ R7 — transfer-in from another lender (AIR §6)
export interface TransferIn { readonly application_id: string; readonly report_document_id: string; readonly effective_date: PlainDate; readonly note_date: PlainDate; readonly air_attestation_document_id: string | null; readonly original_lender_client_name: string; readonly uad_version: UadVersion; readonly received_at: string; readonly property_state: string; readonly form_code?: FormCode | null; }
/** Accepted only with the partner's AIR attestation, < 12 months old at the note date, the original lender/client kept as-is; `transferred_from_lender = true` and a UCDP resubmission under the partner (24.2) is required. */
export function acceptTransferredReport(events: EventStore, t: TransferIn, actor: Actor = VALUATION_AGENT): { order: ValuationOrder; event: DomainEvent; ucdp_resubmission_required: true; review_process: "24.2" } {
  nonEmpty(t.application_id, "application_id"); nonEmpty(t.report_document_id, "report_document_id"); nonEmpty(t.original_lender_client_name, "original_lender_client_name"); isoOrThrow(t.received_at, "received_at");
  if (!t.air_attestation_document_id) throw new ValuationRefused("AIR_6_ATTESTATION", "AIR §6", "a transferred appraisal needs the Seller's AIR attestation covering the original engagement");
  const age = appraisalAge12mGate(t.effective_date, t.note_date);
  if (!age.open) throw new ValuationRefused("FNMA_B4_1_2_04_APPRAISAL_12M", "B4-1.2-04; AIR §6", age.reason!);
  const dates = appraisalAgeDates(t.effective_date);
  const order: ValuationOrder = { order_id: randomUUID(), application_id: t.application_id, status: "report_received", assignment_type: "traditional", method: "traditional", form_code: t.form_code ?? (t.uad_version === "3.6" ? "urar_uad36" : "1004"), uad_version: t.uad_version, du_submission_id: null, offer_type: "none", offer_issued_at: null, offer_expires_on: null,
    ordered_by_agent_run_id: null, fee_gate_evidence_id: null, fee_quote_cents: null, fee_invoice_cents: null, fee_paid_by: "other", fee_benchmark_id: null, channel: "panel", vendor_party_id: t.original_lender_client_name, amc_registration_id: null, appraiser_party_id: null, appraiser_license_state: null, appraiser_license_number: null, appraiser_license_type: null, appraiser_license_expires_on: null, asc_registry_checked_at: null,
    pdc_id: null, property_state: t.property_state.toUpperCase(), first_ucdp_submission_on: civilDate(t.received_at), ordered_at: null, assigned_at: null, inspection_scheduled_at: null, inspection_completed_at: null, received_at: t.received_at, report_document_id: t.report_document_id, effective_date: t.effective_date, age_12m_expires_on: dates.age_12m_expires_on, age_4m_update_after: dates.age_4m_update_after,
    cancel_reason: null, reassigned_from_order_id: null, parent_order_id: null, transferred_from_lender: true, transfer_air_attestation_document_id: t.air_attestation_document_id, vendor_order_id: null, time_zone: CREDITOR_TZ };
  const event = emit(events, t.application_id, "valuation.received", { order_id: order.order_id, report_document_id: t.report_document_id, effective_date: t.effective_date, assignment_type: "traditional", declined: false, uad_version: t.uad_version, form_code: order.form_code, method: "traditional", age_4m_update_after: dates.age_4m_update_after, age_12m_expires_on: dates.age_12m_expires_on,
    received_at: t.received_at, received_on: civilDate(t.received_at), transferred_from_lender: true, transfer_air_attestation_document_id: t.air_attestation_document_id, original_lender_client_name: t.original_lender_client_name, ucdp_resubmission_required: true, ucdp_note: "UCDP does not allow a lender to reuse a Document File ID created from another lender's submission — resubmit under the partner", opens: "24.2", appraiser_party_id: null, appraiser_license_number: null, fee_invoice_cents: null, fee_paid_by: "other", parent_order_id: null }, t.received_at, actor);
  return { order, event, ucdp_resubmission_required: true, review_process: "24.2" };
}

// ============================================================ AIR contact log and §1026.42(g) misconduct referral
export interface ContactLogInput { readonly application_id: string; readonly valuation_order_id: string | null; readonly direction: "outbound" | "inbound"; readonly counterparty_role: "appraiser" | "amc" | "pdc" | "borrower" | "agent"; readonly channel: string; readonly content: string; readonly at: string; readonly payload_document_id?: string | null; }
export const VALUE_REQUEST_PATTERN = /what (value|number) (do you|are you) (need|looking for)|value (you )?need|target value|needed value|come in at/i;
/** Every contact is logged with the actor and its restricted-party status (must be false — enforced, not only logged); a "what value do you need?" is answered by the scripted refusal and counted on the vendor's AIR score. */
export function logContact(events: EventStore, c: ContactLogInput, actor: Actor = VALUATION_AGENT): { event: DomainEvent; scripted_refusal: string | null; content_hash: string } {
  nonEmpty(c.application_id, "application_id"); nonEmpty(c.content, "content"); isoOrThrow(c.at, "at");
  assertNotRestrictedParty(actor, "logContact");
  const value_request = c.direction === "inbound" && VALUE_REQUEST_PATTERN.test(c.content);
  const scripted_refusal = value_request ? "Under the Appraiser Independence Requirements and 12 CFR 1026.42(c) we cannot provide an anticipated, estimated or desired value, a value range or a loan amount. Please develop your opinion of value independently." : null;
  const content_hash = payloadHash({ content: c.content, direction: c.direction, at: c.at });
  const event = emit(events, c.application_id, "air.contact.logged", { valuation_order_id: c.valuation_order_id, direction: c.direction, counterparty_role: c.counterparty_role, actor: `${actor.kind}:${actor.id}`, actor_is_restricted_party: false, channel: c.channel, content_hash, payload_document_id: c.payload_document_id ?? null, value_request_refused: value_request, at: c.at }, c.at, actor);
  return { event, scripted_refusal, content_hash };
}
/** The `officer` determination that a reportable USPAP/ethics failure is reasonably believed (starts REGZ_1026_42G_MISCONDUCT_REFERRAL_30 from `determination_at`). */
export function suspectMisconduct(events: EventStore, i: { application_id: string; valuation_order_id: string | null; appraiser_party_id: string; basis: string; determination_at: string }, officer: Actor): { event: DomainEvent; referral_due_on: PlainDate } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.basis, "basis"); isoOrThrow(i.determination_at, "determination_at");
  if (officer.kind !== "human" || officer.role !== "officer") throw new ValuationRefused("REGZ_1026_42G_OFFICER_DETERMINATION", "12 CFR 1026.42(g); AIR §7; 24.1 escalations", "the misconduct determination is made by the partner officer, never by the agent alone");
  const referral_due_on = addDays(civilDate(i.determination_at), MISCONDUCT_REFERRAL_DAYS);
  const event = emit(events, i.application_id, "air.misconduct.suspected", { valuation_order_id: i.valuation_order_id, appraiser_party_id: i.appraiser_party_id, basis: i.basis, determination_at: i.determination_at, determined_by: `${officer.kind}:${officer.id}`, referral_due_on, material: true }, i.determination_at, officer);
  return { event, referral_due_on };
}
export function referMisconduct(events: EventStore, i: { application_id: string; valuation_order_id: string | null; appraiser_party_id: string; agency: string; referred_at: string; referral_document_id: string }, actor: Actor): DomainEvent {
  nonEmpty(i.agency, "agency"); nonEmpty(i.referral_document_id, "referral_document_id"); isoOrThrow(i.referred_at, "referred_at");
  if (actor.kind !== "human" || actor.role !== "officer") throw new ValuationRefused("REGZ_1026_42G_OFFICER_REFERRAL", "12 CFR 1026.42(g); AIR §7", "the referral to the state appraiser certifying and licensing agency is signed by the officer");
  return emit(events, i.application_id, "air.misconduct.referred", { valuation_order_id: i.valuation_order_id, appraiser_party_id: i.appraiser_party_id, agency: i.agency, referred_at: i.referred_at, referral_document_id: i.referral_document_id }, i.referred_at, actor);
}
/** Same-business-day placement test (R1 end-to-end behaviour; T11): the order's creditor civil date equals the selection's, or is the next business day when the selection came after hours. */
export function sameBusinessDay(selectedAt: string, orderedAt: string, cal: Calendar = creditor, tz: string = CREDITOR_TZ): boolean {
  const s = civilDate(selectedAt, tz), o = civilDate(orderedAt, tz);
  return s === o && cal.isBusinessDay(o);
}
