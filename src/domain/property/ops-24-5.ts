/**
 * §24.5 Hazard, flood and other property insurance at origination — the `title-closing` agent's pure rules over the
 * servicing engines (9.1 src/domain/insurance/hazard.ts, 9.6 src/domain/insurance/flood.ts; rule set
 * `fnma.insurance.2026-08` shared with 9.1). One small function per rule / T-id; every state change appends the
 * event the 24.5 timers and the downstream processes (25.2 CD figures, 26.1/26.3 gates, 29.3 SFC 180, 30.2 OB-010,
 * 30.3 escrow lines, 30.4 vendor activations, servicing 9.1/9.6 at boarding) consume. bigint cents; PlainDate; the
 * creditor and Reg Z specific-business-day calendars from src/kernel/calendar/business.ts.
 *
 * Events (applicationId on every one — the origination context the timer engine requires; timer in brackets):
 *   flood.determination.ordered{application_id, property_id, address_hash, lol, ordered_on, sfhdf_form_version}
 *   flood.determination.received{application_id, determination_id, zone, sfha, in_sfha, sfc_180, status,
 *     community_participating, determination_date, lol_purchased, notice_required, special_feature_codes}
 *       [arms FDPA_4104A_FLOOD_NOTICE_GATE / SM_FLOOD_NOTICE_DELIVER_1BD when in_sfha=true; satisfies
 *        SM_FLOOD_DETERMINATION_ORDER_1BD]
 *   application.ineligible.determined{basis=collateral, reason_code, source=24.5}   (non-participating community / CBRS-OPA)
 *   flood.notice.delivered{application_id, channel, delivered_at, effective_receipt_date, days_before_consummation,
 *     reasonable_period_ok}                                                       [satisfies SM_FLOOD_NOTICE_DELIVER_1BD,
 *                                                                                  FDPA_4104A_FLOOD_NOTICE_GATE]
 *   flood.notice.acknowledged{application_id, acknowledged_at, method, short_period_reason}
 *   insurance.requirement.computed{application_id, requirement_id, computed_on, …}  [arms SM_INSURANCE_EVIDENCE_REQUEST_3BD]
 *   insurance.evidence.requested{application_id, kinds, to, requested_on}           [satisfies SM_INSURANCE_EVIDENCE_REQUEST_3BD]
 *   insurance.evidence.received{application_id, kind, evidence_id, confirmation_required}
 *   insurance.evidence.confirmed{application_id, policy_id, confirmed_via}
 *   insurance.policy.verified{application_id, policy_id, policy_kind=hazard|unit_owner|flood, stage=origination}
 *                                                                                  [satisfies FNMA_B7_3_02_HAZARD_EVIDENCE_GATE]
 *   flood.coverage.verified{application_id, policy_id, amount_cents, required_cents, effective}
 *                                                                                  [satisfies FNMA_B7_3_06_FLOOD_COVERAGE_GATE]
 *   project.insurance.verified{application_id, master_policy_id, ho6_policy_id}   [satisfies FNMA_B7_3_03_PROJECT_INSURANCE_GATE]
 *   insurance.deficiency.opened{application_id, deficiency_id, kind, stage=origination, condition=ptf}
 *   insurance.deficiency.cleared{application_id, deficiency_id, resolution}
 *   insurance.escrow_lines.seeded{application_id, lines}                           (30.3 reads the seeds)
 *   flood.lol.enrolled{application_id, loan_id, certificate_id, lol_purchased=true, contract_linked}
 *                                                                                  [satisfies FDPA_4012A_LOL_ENROLLED_GATE]
 */
import { type PlainDate, addDays, daysBetween, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor, regzSpecific } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { evaluateAdequacy, confirmationRequired, MAX_DEDUCTIBLE_PCT, UNIT_DEDUCTIBLE_FLOOR, MASTER_PER_UNIT_DEDUCTIBLE_MAX, REQUIRED_PERILS, type HazardPolicy, type CarrierRating, type CoverageBasis, type CoverageForm, type Deficiency as ServicingDeficiency } from "../insurance/hazard.ts";
import { NFIP_BUILDING_MAX, NFIP_MAX_DEDUCTIBLE, floodRequiredAmount, rcbap, privatePolicyAcceptable, type RcbapResult } from "../insurance/flood.ts";
import { RULE_SET_9_1 } from "../insurance/ops-9-1.ts";

// ============================================================ constants and configuration
export const TITLE_CLOSING: Actor = { kind: "agent", id: "title-closing" };
/** The adequacy rule set is 9.1's — one engine for origination and servicing. */
export const RULE_SET_INSURANCE = RULE_SET_9_1;
export const RULE_SET_FDPA = "fdpa.4012a";
export const RULE_SET_NFIP = "nfip.44cfr61.2026";
export const NOTICE_TEMPLATE = "NTC_FDPA_4104A_FLOOD_NOTICE";
/** Interagency Q&A (87 FR 32826) Notice 3: "The Agencies generally regard 10 days as a 'reasonable time' interval." */
export const NOTICE_REASONABLE_PERIOD_DAYS = 10;
/** Mailbox rule for a mailed notice: +3 `business_days_regz_specific` (12 CFR 1026.19(e)(1)(iv) presumption, applied by policy). */
export const MAILBOX_RULE_BUSINESS_DAYS = 3;
/** LL-2026-03: master / unit-owner changes mandatory for applications on/after July 1, 2026. */
export const MASTER_HO6_MANDATORY_FROM: PlainDate = "2026-07-01" as PlainDate;
/** 44 CFR 61.6: single-family building $250,000 (9.6's NFIP_BUILDING_MAX); other residential $500,000. */
export const NFIP_OTHER_RESIDENTIAL_MAX: Cents = 50_000_000n;
/** B7-4-01 general liability floor; B7-4-02 fidelity waivers (≤ 20 units, ≤ $5,000 need). */
export const LIABILITY_MIN_CENTS: Cents = 100_000_000n;
export const FIDELITY_WAIVER_MAX_UNITS = 20;
export const FIDELITY_WAIVER_MAX_NEED_CENTS: Cents = 500_000n;
/** B7-3-02 / 9.1 hazard.ts: 5% per required peril; B7-3-04: HO-6 deductible ≤ max(5%, $2,500); B7-3-03: $50,000 per unit. */
export const HAZARD_DEDUCTIBLE_MAX_PCT = MAX_DEDUCTIBLE_PCT;
export const HO6_DEDUCTIBLE_FLOOR = UNIT_DEDUCTIBLE_FLOOR;
export const MASTER_PER_UNIT_DEDUCTIBLE_MAX_CENTS = MASTER_PER_UNIT_DEDUCTIBLE_MAX;
/** Officer follow-up SLA for B7-3-05 "contact Fannie Mae" peril questions and rating exceptions; external-party follow-ups. */
export const OFFICER_SLA_BUSINESS_DAYS = 2;
export const EXTERNAL_FOLLOWUP_BUSINESS_DAYS = 2;
/** SFC 180 "No Flood Insurance — Not a Special Flood Hazard Area" (B7-3-06; 29.3 maps it). */
export const SFC_NO_FLOOD_NOT_SFHA = "180";

/**
 * FEMA SFHDF FF-206-FY-21-116, OMB 1660-0040, approval expires 2026-09-30 (00a-fed §10) — the form version and its
 * acceptance after expiry are CONFIGURATION (`sfhdf.form_version`, `sfhdf.form_version_accepted`), never code: a vendor
 * SFHDF on the expired form after Sept 30, 2026 is accepted only while FEMA/OMB has extended or re-approved it
 * (`form_version_accepted=true`, the platform default while the extension stands); otherwise the determination is re-ordered.
 */
export interface SfhdfConfig { readonly form_version: string; readonly omb_control: string; readonly omb_expires: PlainDate; readonly form_version_accepted: boolean; }
export const SFHDF_CONFIG_DEFAULT: SfhdfConfig = { form_version: "FF-206-FY-21-116", omb_control: "1660-0040", omb_expires: "2026-09-30" as PlainDate, form_version_accepted: true };
export function sfhdfFormAccepted(formVersion: string, receivedOn: PlainDate, cfg: SfhdfConfig = SFHDF_CONFIG_DEFAULT): { accepted: boolean; omb_expired_at_receipt: boolean; reason: string | null } {
  const expired = receivedOn > cfg.omb_expires;
  if (formVersion !== cfg.form_version) return { accepted: false, omb_expired_at_receipt: expired, reason: `SFHDF form ${formVersion} is not the configured ${cfg.form_version}` };
  if (expired && !cfg.form_version_accepted) return { accepted: false, omb_expired_at_receipt: true, reason: `SFHDF ${cfg.form_version} OMB approval expired ${cfg.omb_expires} and no extension is configured — re-order` };
  return { accepted: true, omb_expired_at_receipt: expired, reason: null };
}

const CREDITOR_TZ = "America/Phoenix";
export const civilDate = (iso: string, tz = CREDITOR_TZ): PlainDate => wallClock(Date.parse(iso), tz).date;
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const nonNeg = (v: Cents, what: string): Cents => { if (typeof v !== "bigint" || v < 0n) throw new RangeError(`${what} must be a non-negative bigint cents amount`); return v; };
const S = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());
let seq = 0;
const newId = (prefix: string): string => `${prefix}-${(++seq).toString(36)}`;
const minCents = (...xs: Cents[]): Cents => xs.reduce((a, b) => (b < a ? b : a));
const maxCents = (...xs: Cents[]): Cents => xs.reduce((a, b) => (b > a ? b : a));

type Emit = (events: EventStore, applicationId: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor, loanId?: string | null) => DomainEvent;
const emit: Emit = (events, applicationId, type, payload, at, actor, loanId) =>
  events.append({ type, applicationId, ...(loanId ? { loanId } : {}), aggregate: { kind: "application", id: applicationId }, actor, occurredAt: at, payload: { application_id: applicationId, source: "origination", ...payload } });

// ============================================================ flood determination (SFHDF) — rules 1, 4; T4, T9, T10
export type StructureKind = "principal" | "residential_detached" | "non_residential_detached";
export interface SfhdfStructure { readonly kind: StructureKind; readonly in_sfha: boolean; readonly zone?: string | null; readonly description?: string | null; }
export type CommunityStatus = "regular" | "emergency" | "suspended" | "non_participating";
/** The vendor's `determination_result` (MISMO 2.4/3.x) as the `flood` adapter returns it. */
export interface SfhdfResult {
  readonly certificate_id: string; readonly zone: string; readonly map_panel: string; readonly map_date: PlainDate | null;
  readonly community_number: string; readonly community_name?: string | null; readonly community_participating: boolean; readonly program_status?: CommunityStatus | null;
  readonly cbrs_opa?: boolean; readonly structures?: readonly SfhdfStructure[]; readonly lol_purchased: boolean;
  readonly sfhdf_form_version: string; readonly sfhdf_document_id?: string | null; readonly vendor_ref?: string | null; readonly determination_basis?: "vendor" | "manual_review";
}
/** B7-3-06: SFHA zones begin with "A" or "V". */
export const isSfhaZone = (zone: string): boolean => /^[AV]/i.test(zone.trim());
export type FloodStatus = "ordered" | "received" | "not_required" | "notice_due" | "notice_delivered" | "coverage_pending" | "coverage_verified" | "ineligible" | "withdrawn";
export interface ParsedSfhdf {
  readonly zone: string; readonly zone_is_sfha: boolean; readonly structures: readonly SfhdfStructure[];
  /** Any principal or residential detached security structure in the SFHA → coverage required (B7-3-06). */
  readonly in_sfha: boolean; readonly residential_structure_in_sfha: boolean; readonly non_residential_detached_only: boolean;
  readonly community_participating: boolean; readonly cbrs_opa: boolean;
  readonly status: "not_required" | "notice_due" | "ineligible"; readonly sfc_180: boolean; readonly notice_required: boolean;
  readonly special_feature_codes: readonly string[]; readonly ineligible_reason: string | null;
  readonly form: ReturnType<typeof sfhdfFormAccepted>;
}
/** The SFHDF read into the 24.5 outcome: SFHA flag per structure, SFC 180 only when no residential structure is in an SFHA, non-participating community / CBRS-OPA → ineligible (24.5-Q2 default). */
export function parseSfhdf(r: SfhdfResult, receivedOn: PlainDate, cfg: SfhdfConfig = SFHDF_CONFIG_DEFAULT): ParsedSfhdf {
  nonEmpty(r.certificate_id, "certificate_id"); nonEmpty(r.zone, "zone"); nonEmpty(r.community_number, "community_number");
  const zoneSfha = isSfhaZone(r.zone);
  const structures: readonly SfhdfStructure[] = r.structures && r.structures.length ? r.structures : [{ kind: "principal", in_sfha: zoneSfha, zone: r.zone }];
  const residential = structures.some((s) => s.kind !== "non_residential_detached" && s.in_sfha);
  const anyInSfha = structures.some((s) => s.in_sfha);
  const cbrs = r.cbrs_opa === true;
  const form = sfhdfFormAccepted(r.sfhdf_form_version, receivedOn, cfg);
  let status: ParsedSfhdf["status"] = residential ? "notice_due" : "not_required";
  let ineligible_reason: string | null = null;
  if (residential && !r.community_participating) { status = "ineligible"; ineligible_reason = "collateral_flood_nonparticipating_community"; }
  else if (residential && cbrs) { status = "ineligible"; ineligible_reason = "collateral_flood_cbrs_opa"; }
  const sfc_180 = !residential;
  return { zone: r.zone, zone_is_sfha: zoneSfha, structures, in_sfha: residential, residential_structure_in_sfha: residential, non_residential_detached_only: anyInSfha && !residential,
    community_participating: r.community_participating, cbrs_opa: cbrs, status, sfc_180, notice_required: residential, special_feature_codes: sfc_180 ? [SFC_NO_FLOOD_NOT_SFHA] : [], ineligible_reason, form };
}

export interface FloodDeterminationRecord {
  readonly determination_id: string; readonly application_id: string; readonly property_id: string; readonly loan_id: string | null;
  readonly status: FloodStatus; readonly ordered_at: string; readonly received_at: string | null; readonly determination_date: PlainDate | null;
  readonly certificate_id: string | null; readonly vendor_ref: string | null; readonly determination_basis: "vendor" | "manual_review";
  readonly zone: string | null; readonly sfha: boolean; readonly in_sfha: boolean; readonly structures: readonly SfhdfStructure[]; readonly multiple_structures: boolean;
  readonly community_number: string | null; readonly community_participating: boolean | null; readonly cbrs_opa: boolean; readonly map_panel: string | null; readonly map_date: PlainDate | null;
  readonly lol_purchased: boolean; readonly lol_certificate_id: string | null; readonly lol_contract_linked: boolean;
  readonly sfhdf_form_version: string; readonly sfhdf_form_accepted: boolean | null; readonly sfhdf_document_id: string | null;
  readonly sfc_180: boolean; readonly notice_required: boolean;
  readonly notice_delivered_at: string | null; readonly notice_document_id: string | null; readonly notice_delivery_channel: NoticeChannel | null; readonly notice_effective_receipt_date: PlainDate | null;
  readonly notice_acknowledged_at: string | null; readonly notice_reasonable_period_days: number | null; readonly notice_short_period_reason: string | null;
  readonly ineligible_reason: string | null; readonly coverage_required: boolean; readonly required_amount_cents: Cents | null;
}
export interface OrderFloodInput { readonly application_id: string; readonly property_id: string; readonly address_hash: string; readonly ordered_at: string; readonly lol?: boolean; readonly fee_gate_result?: string | null; readonly sfhdf_form_version?: string; readonly vendor_id?: string | null; }
/** Rule "Inputs": the SFHDF is ordered with the title order (property identified), life-of-loan always, after 21.4's fee gate (`order_flood`) has opened; idempotent by (application_id, address_hash) is the adapter's concern. */
export function orderFloodDetermination(events: EventStore, i: OrderFloodInput, actor: Actor = TITLE_CLOSING, cfg: SfhdfConfig = SFHDF_CONFIG_DEFAULT): { record: FloodDeterminationRecord; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.property_id, "property_id"); nonEmpty(i.address_hash, "address_hash"); nonEmpty(i.ordered_at, "ordered_at");
  if (i.fee_gate_result !== undefined && i.fee_gate_result !== null && i.fee_gate_result !== "open" && !i.fee_gate_result.startsWith("exempt")) throw new RangeError(`21.4 fee gate for order_flood is ${i.fee_gate_result}: the determination cannot be ordered before intent to proceed and the fee receipt`);
  if (i.lol === false) throw new RangeError("the SFHDF is always ordered with life-of-loan monitoring (42 U.S.C. 4012a(b)(3); B7-3-06; 9.6)");
  const record: FloodDeterminationRecord = { determination_id: newId("fd"), application_id: i.application_id, property_id: i.property_id, loan_id: null, status: "ordered", ordered_at: i.ordered_at, received_at: null, determination_date: null, certificate_id: null, vendor_ref: null, determination_basis: "vendor",
    zone: null, sfha: false, in_sfha: false, structures: [], multiple_structures: false, community_number: null, community_participating: null, cbrs_opa: false, map_panel: null, map_date: null, lol_purchased: true, lol_certificate_id: null, lol_contract_linked: false,
    sfhdf_form_version: i.sfhdf_form_version ?? cfg.form_version, sfhdf_form_accepted: null, sfhdf_document_id: null, sfc_180: false, notice_required: false, notice_delivered_at: null, notice_document_id: null, notice_delivery_channel: null, notice_effective_receipt_date: null,
    notice_acknowledged_at: null, notice_reasonable_period_days: null, notice_short_period_reason: null, ineligible_reason: null, coverage_required: false, required_amount_cents: null };
  const event = emit(events, i.application_id, "flood.determination.ordered", { determination_id: record.determination_id, property_id: i.property_id, address_hash: i.address_hash, lol: true, ordered_at: i.ordered_at, ordered_on: civilDate(i.ordered_at), sfhdf_form_version: record.sfhdf_form_version, vendor_id: i.vendor_id ?? null, fee_gate_result: i.fee_gate_result ?? null }, i.ordered_at, actor);
  return { record, event };
}
export interface CollateralStop { readonly basis: "collateral"; readonly reason_code: string; readonly statement_text: string; readonly hmda_denial_code: 4; readonly notify: readonly ["23.1", "21.6"]; }
/** 24.5 edge: adverse-action reasons for a flood-ineligible property cite the collateral, never the borrower (21.6's `collateral_*` family). */
export function collateralStop(reason: string): CollateralStop {
  const text = reason === "collateral_flood_cbrs_opa" ? "Property in a Coastal Barrier Resources System / Otherwise Protected Area — flood insurance unavailable" : "Property in a Special Flood Hazard Area in a community that does not participate in the National Flood Insurance Program";
  return { basis: "collateral", reason_code: reason, statement_text: text, hmda_denial_code: 4, notify: ["23.1", "21.6"] };
}
/** The vendor's determination received: parses the SFHDF, sets the flood status, emits `flood.determination.received{in_sfha}` (the SFHA rows arm from it) and, for a non-participating community, stops the loan with a collateral reason. */
export function receiveFloodDetermination(events: EventStore, rec: FloodDeterminationRecord, r: SfhdfResult, receivedAt: string, actor: Actor = TITLE_CLOSING, cfg: SfhdfConfig = SFHDF_CONFIG_DEFAULT): { record: FloodDeterminationRecord; parsed: ParsedSfhdf; event: DomainEvent; stop: CollateralStop | null; stop_event: DomainEvent | null } {
  nonEmpty(receivedAt, "received_at");
  const on = civilDate(receivedAt);
  const parsed = parseSfhdf(r, on, cfg);
  if (!parsed.form.accepted) throw new RangeError(parsed.form.reason ?? "SFHDF form version not accepted");
  const record: FloodDeterminationRecord = { ...rec, status: parsed.status, received_at: receivedAt, determination_date: on, certificate_id: r.certificate_id, vendor_ref: r.vendor_ref ?? null, determination_basis: r.determination_basis ?? "vendor",
    zone: r.zone, sfha: parsed.zone_is_sfha, in_sfha: parsed.in_sfha, structures: parsed.structures, multiple_structures: parsed.structures.length > 1, community_number: r.community_number, community_participating: r.community_participating, cbrs_opa: parsed.cbrs_opa, map_panel: r.map_panel, map_date: r.map_date,
    lol_purchased: r.lol_purchased, lol_certificate_id: r.lol_purchased ? r.certificate_id : null, sfhdf_form_version: r.sfhdf_form_version, sfhdf_form_accepted: true, sfhdf_document_id: r.sfhdf_document_id ?? null, sfc_180: parsed.sfc_180, notice_required: parsed.notice_required,
    ineligible_reason: parsed.ineligible_reason, coverage_required: parsed.in_sfha };
  const event = emit(events, rec.application_id, "flood.determination.received", { determination_id: record.determination_id, property_id: record.property_id, certificate_id: r.certificate_id, vendor_ref: record.vendor_ref, determination_date: on, received_at: receivedAt, zone: r.zone, sfha: parsed.zone_is_sfha, in_sfha: parsed.in_sfha,
    residential_structure_in_sfha: parsed.residential_structure_in_sfha, multiple_structures: record.multiple_structures, structures: parsed.structures, community_number: r.community_number, community_participating: r.community_participating, participating: r.community_participating, program_status: r.program_status ?? null, cbrs_opa: parsed.cbrs_opa,
    status: parsed.status, sfc_180: parsed.sfc_180, special_feature_codes: parsed.special_feature_codes, notice_required: parsed.notice_required, lol: r.lol_purchased, lol_purchased: r.lol_purchased, sfhdf_form_version: r.sfhdf_form_version, sfhdf_omb_expired_at_receipt: parsed.form.omb_expired_at_receipt, sfhdf_document_id: record.sfhdf_document_id,
    coverage_required: parsed.in_sfha, determination_basis: record.determination_basis, ineligible_reason: parsed.ineligible_reason, retention: "fdpa_life_of_loan" }, receivedAt, actor);
  let stop: CollateralStop | null = null, stop_event: DomainEvent | null = null;
  if (parsed.status === "ineligible" && parsed.ineligible_reason) {
    stop = collateralStop(parsed.ineligible_reason);
    stop_event = emit(events, rec.application_id, "application.ineligible.determined", { determination_id: record.determination_id, basis: stop.basis, reason_code: stop.reason_code, statement_text: stop.statement_text, hmda_denial_code: stop.hmda_denial_code, notify: stop.notify, source_process: "24.5", officer_escalation: parsed.ineligible_reason === "collateral_flood_cbrs_opa" }, receivedAt, actor);
  }
  return { record, parsed, event, stop, stop_event };
}
/** 29.3's delivery data from the determination: SFC 180 only when no residential structure is in an SFHA (guardrail). */
export function deliveryFloodData(rec: FloodDeterminationRecord): { special_feature_codes: readonly string[]; flood_zone: string | null; sfha: boolean; flood_certificate_id: string | null; lol: boolean } {
  if (rec.sfc_180 && rec.in_sfha) throw new RangeError("SFC 180 can never be set when a residential structure is in an SFHA (24.5 guardrail)");
  return { special_feature_codes: rec.sfc_180 ? [SFC_NO_FLOOD_NOT_SFHA] : [], flood_zone: rec.zone, sfha: rec.in_sfha, flood_certificate_id: rec.certificate_id, lol: rec.lol_purchased };
}

// ============================================================ flood notice timing — rule 5; T4
export type NoticeChannel = "esign" | "portal" | "mail";
/** Effective receipt: e-sign confirmed → that day; portal/e-mail without confirmation and mail → +3 `business_days_regz_specific` (mailbox rule). */
export function noticeEffectiveReceipt(i: { readonly delivered_on: PlainDate; readonly channel: NoticeChannel; readonly esign_confirmed_on?: PlainDate | null }): { effective_receipt_date: PlainDate; basis: "esign_confirmed" | "mailbox_rule_3_regz_specific" } {
  if (i.channel !== "mail" && i.esign_confirmed_on) return { effective_receipt_date: i.esign_confirmed_on, basis: "esign_confirmed" };
  return { effective_receipt_date: addBusinessDays(i.delivered_on, MAILBOX_RULE_BUSINESS_DAYS, regzSpecific), basis: "mailbox_rule_3_regz_specific" };
}
/** Rule 5: the earliest consummation a receipt date supports (receipt + 10 calendar days). */
export const earliestConsummationAfterNotice = (effectiveReceipt: PlainDate): PlainDate => addDays(effectiveReceipt, NOTICE_REASONABLE_PERIOD_DAYS);
export interface FloodNoticeGateFacts {
  readonly in_sfha: boolean; readonly consummation_date: PlainDate | null; readonly effective_receipt_date: PlainDate | null;
  readonly short_period_reason?: string | null; readonly acknowledged_on?: PlainDate | null; readonly acknowledged_before_signing?: boolean;
  readonly purchase_contract_signed_after_determination_without_notice?: boolean;
}
export interface FloodNoticeGateResult { readonly open: boolean; readonly reason?: string; readonly days_before_consummation: number | null; readonly path: "not_applicable" | "standard" | "short_period" | "blocked"; readonly earliest_consummation: PlainDate | null; }
/** FDPA_4104A_FLOOD_NOTICE_GATE: consummation ≥ effective receipt + 10 calendar days; shorter only with a recorded reason and the borrower's acknowledgment before signing (24.5-Q1 default; never for a purchase contract signed after the determination without the notice). Re-evaluated whenever the closing date moves. */
export function floodNoticeGate(f: FloodNoticeGateFacts): FloodNoticeGateResult {
  if (!f.in_sfha) return { open: true, days_before_consummation: null, path: "not_applicable", earliest_consummation: null };
  if (!f.effective_receipt_date) return { open: false, reason: "flood notice (NTC_FDPA_4104A_FLOOD_NOTICE) not delivered on an SFHA loan", days_before_consummation: null, path: "blocked", earliest_consummation: null };
  const earliest = earliestConsummationAfterNotice(f.effective_receipt_date);
  if (!f.consummation_date) return { open: false, reason: `consummation date not scheduled; earliest supported by the notice is ${earliest}`, days_before_consummation: null, path: "blocked", earliest_consummation: earliest };
  const days = daysBetween(f.effective_receipt_date, f.consummation_date);
  if (days >= NOTICE_REASONABLE_PERIOD_DAYS) return { open: true, days_before_consummation: days, path: "standard", earliest_consummation: earliest };
  if (f.purchase_contract_signed_after_determination_without_notice) return { open: false, reason: `notice received ${days} days before consummation and the purchase contract was signed after the determination without it — no short-period path (24.5-Q1)`, days_before_consummation: days, path: "blocked", earliest_consummation: earliest };
  const ack = !!f.acknowledged_on && f.acknowledged_on <= f.consummation_date && f.acknowledged_before_signing !== false;
  if (f.short_period_reason && f.short_period_reason.trim() && ack) return { open: true, days_before_consummation: days, path: "short_period", earliest_consummation: earliest };
  return { open: false, reason: `flood notice received ${days} days before consummation (< ${NOTICE_REASONABLE_PERIOD_DAYS}); move consummation to ≥ ${earliest} or record notice_short_period_reason and the borrower's acknowledgment before signing`, days_before_consummation: days, path: "blocked", earliest_consummation: earliest };
}
export interface DeliverNoticeInput { readonly delivered_at: string; readonly channel: NoticeChannel; readonly notice_document_id: string; readonly notice_id?: string | null; readonly esign_confirmed_at?: string | null; readonly scheduled_consummation_date?: PlainDate | null; readonly esign_consent_scope?: string | null; }
/** The notice delivered (e-delivery under E-SIGN consent scope `flood_notice`, else mail with the mailbox rule): never skipped on an SFHA loan; emits `flood.notice.delivered` with the effective receipt and the days before the scheduled consummation. */
export function deliverFloodNotice(events: EventStore, rec: FloodDeterminationRecord, i: DeliverNoticeInput, actor: Actor = TITLE_CLOSING): { record: FloodDeterminationRecord; event: DomainEvent; effective_receipt_date: PlainDate; gate: FloodNoticeGateResult } {
  nonEmpty(i.delivered_at, "delivered_at"); nonEmpty(i.notice_document_id, "notice_document_id");
  if (!rec.in_sfha) throw new RangeError("the flood notice is delivered on SFHA loans; this determination is not in an SFHA (T9: no notice)");
  if (i.channel !== "mail" && i.esign_consent_scope !== undefined && i.esign_consent_scope !== null && i.esign_consent_scope !== "flood_notice") throw new RangeError(`e-delivery of the flood notice needs E-SIGN consent scope flood_notice (got ${i.esign_consent_scope})`);
  const delivered_on = civilDate(i.delivered_at);
  const r = noticeEffectiveReceipt({ delivered_on, channel: i.channel, esign_confirmed_on: i.esign_confirmed_at ? civilDate(i.esign_confirmed_at) : null });
  const first = rec.notice_delivered_at ?? i.delivered_at;   // the baseline `notice_delivered_at` is the FIRST delivery
  const firstReceipt = rec.notice_effective_receipt_date ?? r.effective_receipt_date;
  const gate = floodNoticeGate({ in_sfha: true, consummation_date: i.scheduled_consummation_date ?? null, effective_receipt_date: firstReceipt });
  const record: FloodDeterminationRecord = { ...rec, status: rec.status === "notice_due" ? "notice_delivered" : rec.status, notice_delivered_at: first, notice_document_id: rec.notice_document_id ?? i.notice_document_id, notice_delivery_channel: rec.notice_delivery_channel ?? i.channel, notice_effective_receipt_date: firstReceipt, notice_reasonable_period_days: gate.days_before_consummation };
  const event = emit(events, rec.application_id, "flood.notice.delivered", { determination_id: rec.determination_id, template: NOTICE_TEMPLATE, notice_id: i.notice_id ?? null, notice_document_id: i.notice_document_id, channel: i.channel, delivered_at: i.delivered_at, delivered_on, effective_receipt_date: r.effective_receipt_date, receipt_basis: r.basis,
    first_delivered_at: first, scheduled_consummation_date: i.scheduled_consummation_date ?? null, days_before_consummation: gate.days_before_consummation, reasonable_period_ok: gate.open, earliest_consummation: gate.earliest_consummation, acknowledged: false, esign_consent_scope: i.channel === "mail" ? null : "flood_notice" }, i.delivered_at, actor);
  return { record, event, effective_receipt_date: r.effective_receipt_date, gate };
}
/** The borrower's acknowledgment (e-sign / wet / portal); with a short-period reason it records the 24.5-Q1 path. */
export function acknowledgeFloodNotice(events: EventStore, rec: FloodDeterminationRecord, i: { readonly acknowledged_at: string; readonly method: "esign" | "wet" | "portal"; readonly short_period_reason?: string | null; readonly before_signing?: boolean }, actor: Actor = TITLE_CLOSING): { record: FloodDeterminationRecord; event: DomainEvent } {
  nonEmpty(i.acknowledged_at, "acknowledged_at");
  if (!rec.notice_delivered_at) throw new RangeError("the notice must be delivered before it can be acknowledged");
  const record: FloodDeterminationRecord = { ...rec, notice_acknowledged_at: i.acknowledged_at, notice_short_period_reason: i.short_period_reason ?? rec.notice_short_period_reason,
    ...(rec.notice_delivery_channel !== "mail" && rec.notice_effective_receipt_date && civilDate(i.acknowledged_at) < rec.notice_effective_receipt_date ? { notice_effective_receipt_date: civilDate(i.acknowledged_at) } : {}) };
  const event = emit(events, rec.application_id, "flood.notice.acknowledged", { determination_id: rec.determination_id, template: NOTICE_TEMPLATE, acknowledged_at: i.acknowledged_at, acknowledged_on: civilDate(i.acknowledged_at), method: i.method, short_period_reason: i.short_period_reason ?? null, before_signing: i.before_signing ?? true, effective_receipt_date: record.notice_effective_receipt_date }, i.acknowledged_at, actor);
  return { record, event };
}

// ============================================================ carrier rating and mortgagee clause — B7-3-01 / B7-3-08; T8, T12
export type RatingAgency = CarrierRating["agency"];
/** B7-3-01: AM Best ≥ B, Demotech ≥ A (A'', A', A), KBRA ≥ BBB, S&P ≥ BBB — "only required to meet the rating category requirement for one of the rating agencies". */
export function ratingMeets(r: CarrierRating): boolean {
  const g = r.grade.toUpperCase().replace(/\s/g, "");
  switch (r.agency) {
    case "am_best": return /^(A\+\+|A\+|A|A-|B\+\+|B\+|B)$/.test(g);
    case "demotech": return /^A['"′″]*$/.test(g);
    case "sp": case "kroll": return /^(AAA|AA|A|BBB)[+-]?$/.test(g);
    default: return false;
  }
}
export interface RatingRelief { readonly fair_plan?: boolean; readonly fair_plan_only_coverage_available?: boolean; readonly mortgage_impairment_relief?: boolean; }
export interface RatingTest { readonly pass: boolean; readonly met_by: readonly RatingAgency[]; readonly basis: "rating" | "fair_plan" | "mortgage_impairment" | null; readonly deficiency: "rating_fail" | null; readonly officer_acknowledgment_required: boolean; }
/** T12: one agency suffices; an unrated/under-rated carrier fails unless the policy is a FAIR-plan (only coverage available; officer acknowledgment) or SM's mortgage-impairment policy applies. */
export function carrierRatingTest(ratings: readonly CarrierRating[], relief: RatingRelief = {}): RatingTest {
  const met = ratings.filter(ratingMeets).map((r) => r.agency);
  if (met.length) return { pass: true, met_by: met, basis: "rating", deficiency: null, officer_acknowledgment_required: false };
  if (relief.mortgage_impairment_relief) return { pass: true, met_by: [], basis: "mortgage_impairment", deficiency: null, officer_acknowledgment_required: false };
  if (relief.fair_plan && relief.fair_plan_only_coverage_available !== false) return { pass: true, met_by: [], basis: "fair_plan", deficiency: null, officer_acknowledgment_required: true };
  return { pass: false, met_by: [], basis: null, deficiency: "rating_fail", officer_acknowledgment_required: false };
}
export interface MortgageeClauseCheck { readonly partner_named: boolean; readonly successors_assigns_phrase: boolean; readonly servicer_address: boolean; readonly mers_absent: boolean; readonly atima_present: boolean; readonly fannie_mae_form: boolean; readonly pass: boolean; readonly standard_clause: string; }
export const STANDARD_MORTGAGEE_CLAUSE = (partnerLegalName: string, smAddress = "P.O. Box 7900, Phoenix AZ 85011 · insurance@supermortgage.example") => `${partnerLegalName}, its successors and/or assigns, c/o Supermortgage, ${smAddress}`;
/** Rule 7 / B7-3-08: PASS iff the clause names the partner + "its successors and/or assigns" (ISAOA) with the SM servicing address (c/o Supermortgage) — or "Fannie Mae, in care of Supermortgage …" — and MERS is absent; the ATIMA tail is accepted, not required. */
export function checkMortgageeClause(text: string, partner: { readonly legal_name: string; readonly aliases?: readonly string[] }): MortgageeClauseCheck {
  const t = nonEmpty(text, "mortgagee clause text").replace(/\s+/g, " ");
  const names = [partner.legal_name, ...(partner.aliases ?? []), "[Partner]"].filter((n) => n && n.trim());
  const partner_named = names.some((n) => t.toLowerCase().includes(n.toLowerCase()));
  const successors = /its successors and\/?or assigns|its successors and assigns|ISAOA/i.test(t);
  const servicer = /c\/o\s+Supermortgage|in care of\s+Supermortgage/i.test(t);
  const mers_absent = !/\bMERS\b|Mortgage Electronic Registration Systems/i.test(t);
  const atima = /as their interests? may appear|ATIMA/i.test(t);
  const fannie = /Fannie Mae,?\s+in care of\s+Supermortgage/i.test(t);
  const pass = mers_absent && servicer && (fannie || (partner_named && successors));
  return { partner_named, successors_assigns_phrase: successors, servicer_address: servicer, mers_absent, atima_present: atima, fannie_mae_form: fannie, pass, standard_clause: STANDARD_MORTGAGEE_CLAUSE(partner.legal_name) };
}

// ============================================================ insurance requirements — rule 1; T5
export type ProjectType = "detached" | "condo" | "coop" | "attached_pud";
export type ComputedFrom = "du_findings" | "project_review" | "flood_determination";
export interface RequirementInput {
  readonly application_id: string; readonly computed_from: ComputedFrom; readonly computed_at: string;
  readonly property: { readonly units: number; readonly project_type: ProjectType; readonly project_waiver_of_review?: boolean; readonly project_units_total?: number | null; readonly legal_docs_place_duty_on_unit_owners?: boolean; readonly master_covers_interior?: boolean | null; readonly master_per_unit_deductible_cents?: Cents | null; readonly ho6_restoration_estimate_cents?: Cents | null; readonly state_fidelity_statute?: boolean; };
  readonly hazard: { readonly coverage_dwelling_cents: Cents; readonly excludes_wind?: boolean };
  readonly flood: { readonly in_sfha: boolean; readonly rcv_improvements_cents: Cents | null; readonly note_amount_cents: Cents } | null;
  readonly fidelity?: { readonly three_month_assessments_cents?: Cents | null; readonly funds_in_custody_max_cents?: Cents | null; readonly financial_controls?: boolean } | null;
}
export interface InsuranceRequirement {
  readonly requirement_id: string; readonly application_id: string; readonly computed_from: ComputedFrom; readonly computed_at: string; readonly computed_on: PlainDate; readonly rule_set: string;
  readonly hazard_required: true; readonly wind_separate_required: boolean; readonly required_perils: readonly string[]; readonly basis_required: "replacement_cost"; readonly required_deductible_max_pct: "5.0000";
  readonly hazard_deductible_max_cents: Cents; readonly master_policy_required: boolean; readonly master_per_unit_deductible_max_cents: Cents;
  readonly ho6_required: boolean; readonly ho6_min_amount_cents: Cents | null; readonly ho6_deductible_max_cents: Cents | null;
  readonly flood_required: boolean; readonly nfip_max_cents: Cents; readonly flood_required_amount_cents: Cents | null; readonly flood_deductible_max_cents: Cents | null;
  readonly liability_required: boolean; readonly liability_min_cents: Cents | null; readonly fidelity_required: boolean; readonly fidelity_min_cents: Cents | null;
}
/** 5% of the dwelling coverage, in cents (rounded down — the comparison itself is unrounded, rule 2). */
export const hazardDeductibleMax = (coverage: Cents): Cents => HAZARD_DEDUCTIBLE_MAX_PCT.mul(Decimal.fromBigInt(nonNeg(coverage, "coverage_dwelling_cents"))).toScaledInt(0, "DOWN");
/** 44 CFR 61.6: $250,000 single-family building; "other residential" $500,000 for 2–4 units ([PARTIALLY VERIFIED]); RCBAP $250,000 × units. */
export const nfipBuildingMax = (units: number): Cents => (units <= 1 ? NFIP_BUILDING_MAX : NFIP_OTHER_RESIDENTIAL_MAX);
/** Rule 4: `flood_required_amount_cents = min(RCV, NFIP max, note amount)`; deductible ≤ the NFIP maximum option ($10,000). */
export function floodRequirement(i: { readonly rcv_improvements_cents: Cents; readonly note_amount_cents: Cents; readonly units?: number }): { flood_required_amount_cents: Cents; flood_deductible_max_cents: Cents; nfip_max_cents: Cents } {
  const units = i.units ?? 1;
  const nfip = nfipBuildingMax(units);
  const required = units <= 1 ? floodRequiredAmount(nonNeg(i.rcv_improvements_cents, "rcv_improvements_cents"), nonNeg(i.note_amount_cents, "note_amount_cents")) : minCents(i.rcv_improvements_cents, nfip, i.note_amount_cents);
  return { flood_required_amount_cents: required, flood_deductible_max_cents: NFIP_MAX_DEDUCTIBLE, nfip_max_cents: nfip };
}
/** B7-3-04 amounts: HO-6 ≥ max(restoration of uncovered interior/improvements, per-unit deductible); deductible ≤ max(5% × HO-6 coverage, $2,500). */
export function ho6Requirement(i: { readonly per_unit_deductible_cents: Cents | null; readonly restoration_estimate_cents: Cents | null; readonly master_covers_interior: boolean }): { ho6_required: boolean; ho6_min_amount_cents: Cents | null; ho6_deductible_max_cents: Cents | null } {
  const required = i.per_unit_deductible_cents !== null || !i.master_covers_interior;
  if (!required) return { ho6_required: false, ho6_min_amount_cents: null, ho6_deductible_max_cents: null };
  const min = maxCents(i.restoration_estimate_cents ?? 0n, i.per_unit_deductible_cents ?? 0n);
  return { ho6_required: true, ho6_min_amount_cents: min, ho6_deductible_max_cents: ho6DeductibleMax(min) };
}
export const ho6DeductibleMax = (ho6Coverage: Cents): Cents => maxCents(HAZARD_DEDUCTIBLE_MAX_PCT.mul(Decimal.fromBigInt(ho6Coverage)).toScaledInt(0, "DOWN"), HO6_DEDUCTIBLE_FLOOR);
/** Rule 1 — the requirement record 9.1 owns, computed at DU findings / project review / flood determination; emits `insurance.requirement.computed` (SM_INSURANCE_EVIDENCE_REQUEST_3BD arms from it). */
export function computeInsuranceRequirements(events: EventStore, i: RequirementInput, actor: Actor = TITLE_CLOSING): { requirement: InsuranceRequirement; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.computed_at, "computed_at");
  if (!Number.isInteger(i.property.units) || i.property.units < 1 || i.property.units > 4) throw new RangeError(`units must be 1–4 (got ${String(i.property.units)})`);
  const project = i.property.project_type !== "detached";
  const masterRequired = project && !i.property.legal_docs_place_duty_on_unit_owners;
  const ho6 = masterRequired ? ho6Requirement({ per_unit_deductible_cents: i.property.master_per_unit_deductible_cents ?? null, restoration_estimate_cents: i.property.ho6_restoration_estimate_cents ?? null, master_covers_interior: i.property.master_covers_interior ?? true }) : { ho6_required: project, ho6_min_amount_cents: project ? i.property.ho6_restoration_estimate_cents ?? null : null, ho6_deductible_max_cents: project && i.property.ho6_restoration_estimate_cents ? ho6DeductibleMax(i.property.ho6_restoration_estimate_cents) : null };
  const floodReq = i.flood?.in_sfha ? floodRequirement({ rcv_improvements_cents: i.flood.rcv_improvements_cents ?? i.hazard.coverage_dwelling_cents, note_amount_cents: i.flood.note_amount_cents, units: i.property.units }) : null;
  const condoCoop = i.property.project_type === "condo" || i.property.project_type === "coop";
  const liability = condoCoop && !i.property.project_waiver_of_review;
  const units = i.property.project_units_total ?? 0;
  const fid = i.fidelity ?? null;
  const fidelityMin = fid ? (fid.financial_controls !== false && fid.three_month_assessments_cents !== undefined && fid.three_month_assessments_cents !== null ? fid.three_month_assessments_cents : fid.funds_in_custody_max_cents ?? fid.three_month_assessments_cents ?? null) : null;
  const fidelity = liability && units > FIDELITY_WAIVER_MAX_UNITS && (fidelityMin === null || fidelityMin > FIDELITY_WAIVER_MAX_NEED_CENTS);
  const requirement: InsuranceRequirement = { requirement_id: newId("ir"), application_id: i.application_id, computed_from: i.computed_from, computed_at: i.computed_at, computed_on: civilDate(i.computed_at), rule_set: RULE_SET_INSURANCE,
    hazard_required: true, wind_separate_required: i.hazard.excludes_wind === true, required_perils: REQUIRED_PERILS, basis_required: "replacement_cost", required_deductible_max_pct: "5.0000", hazard_deductible_max_cents: hazardDeductibleMax(i.hazard.coverage_dwelling_cents),
    master_policy_required: masterRequired, master_per_unit_deductible_max_cents: MASTER_PER_UNIT_DEDUCTIBLE_MAX_CENTS, ...ho6,
    flood_required: floodReq !== null, nfip_max_cents: nfipBuildingMax(i.property.units), flood_required_amount_cents: floodReq?.flood_required_amount_cents ?? null, flood_deductible_max_cents: floodReq?.flood_deductible_max_cents ?? null,
    liability_required: liability, liability_min_cents: liability ? LIABILITY_MIN_CENTS : null, fidelity_required: fidelity, fidelity_min_cents: fidelity ? (fidelityMin ?? null) : null };
  const event = emit(events, i.application_id, "insurance.requirement.computed", { requirement_id: requirement.requirement_id, computed_from: i.computed_from, computed_at: i.computed_at, computed_on: requirement.computed_on, rule_set: requirement.rule_set, hazard_required: true, wind_separate_required: requirement.wind_separate_required,
    hazard_deductible_max_cents: S(requirement.hazard_deductible_max_cents), master_policy_required: masterRequired, ho6_required: requirement.ho6_required, ho6_min_amount_cents: S(requirement.ho6_min_amount_cents), ho6_deductible_max_cents: S(requirement.ho6_deductible_max_cents), flood_required: requirement.flood_required,
    flood_required_amount_cents: S(requirement.flood_required_amount_cents), flood_deductible_max_cents: S(requirement.flood_deductible_max_cents), liability_required: liability, fidelity_required: fidelity, fidelity_min_cents: S(requirement.fidelity_min_cents), evidence_request_due_on: addBusinessDays(requirement.computed_on, 3, creditor) }, i.computed_at, actor);
  return { requirement, event };
}

// ============================================================ evidence — B7-3-07; rule 9
export type EvidenceKind = "declarations" | "binder" | "certificate" | "policy" | "electronic_verification" | "master_certificate" | "rcbap_declarations" | "flood_declarations" | "ho6_declarations" | "liability_certificate" | "fidelity_certificate";
export type EvidenceRecipient = "borrower_agent" | "carrier" | "hoa_management" | "borrower";
/** The evidence request to the borrower's agent / carrier / HOA (automation disclosed; external follow-up every 2 creditor business days) — satisfies SM_INSURANCE_EVIDENCE_REQUEST_3BD. */
export function requestEvidence(events: EventStore, req: { readonly application_id: string; readonly requirement_id: string }, i: { readonly requested_at: string; readonly to: EvidenceRecipient; readonly kinds: readonly EvidenceKind[]; readonly channel?: "email" | "portal" | "vendor" | "phone"; readonly language?: string | null }, actor: Actor = TITLE_CLOSING): { event: DomainEvent; followup_due_on: PlainDate; on_time_deadline: PlainDate } {
  nonEmpty(i.requested_at, "requested_at"); if (!i.kinds.length) throw new RangeError("at least one evidence kind is requested");
  const on = civilDate(i.requested_at);
  const event = emit(events, req.application_id, "insurance.evidence.requested", { requirement_id: req.requirement_id, requested_at: i.requested_at, requested_on: on, to: i.to, kinds: i.kinds, channel: i.channel ?? "email", automation_disclosed: true, language: i.language ?? "en", followup_due_on: addBusinessDays(on, EXTERNAL_FOLLOWUP_BUSINESS_DAYS, creditor) }, i.requested_at, actor);
  return { event, followup_due_on: addBusinessDays(on, EXTERNAL_FOLLOWUP_BUSINESS_DAYS, creditor), on_time_deadline: addBusinessDays(on, 3, creditor) };
}
export type ExtractionConfidence = Parameters<typeof confirmationRequired>[0];
export interface EvidenceIntake { readonly evidence_id: string; readonly application_id: string; readonly kind: EvidenceKind; readonly document_id: string; readonly received_at: string; readonly fields: Record<string, unknown>; readonly confidence: ExtractionConfidence; readonly confirmation_required: readonly string[]; readonly status: "extracted" | "needs_carrier_confirmation" | "confirmed"; readonly retention: "fnma_loan_file_life_plus_4y"; }
/** Evidence extracted with field-level confidence (9.1's rule 4: carrier/agent confirmation when any critical field < 0.90 — never assumed). */
export function receiveEvidence(events: EventStore, i: { readonly application_id: string; readonly kind: EvidenceKind; readonly document_id: string; readonly received_at: string; readonly fields: Record<string, unknown>; readonly confidence: ExtractionConfidence; readonly policy_id?: string | null }, actor: Actor = TITLE_CLOSING): { evidence: EvidenceIntake; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.document_id, "document_id"); nonEmpty(i.received_at, "received_at");
  const needs = confirmationRequired(i.confidence);
  const evidence: EvidenceIntake = { evidence_id: newId("ev"), application_id: i.application_id, kind: i.kind, document_id: i.document_id, received_at: i.received_at, fields: i.fields, confidence: i.confidence, confirmation_required: needs, status: needs.length ? "needs_carrier_confirmation" : "extracted", retention: "fnma_loan_file_life_plus_4y" };
  const event = emit(events, i.application_id, "insurance.evidence.received", { evidence_id: evidence.evidence_id, kind: i.kind, document_id: i.document_id, received_at: i.received_at, receipt: civilDate(i.received_at), policy_id: i.policy_id ?? null, confirmation_required: needs, status: evidence.status, fields: Object.keys(i.fields) }, i.received_at, actor);
  return { evidence, event };
}
/** Carrier / agent confirmation of the low-confidence fields (AI voice or e-mail, disclosed) — the evidence becomes `confirmed`. */
export function confirmWithCarrier(events: EventStore, ev: EvidenceIntake, i: { readonly confirmed_at: string; readonly confirmed_via: "carrier_api" | "agent_call" | "vendor" | "email"; readonly fields_confirmed: readonly string[]; readonly contact?: string | null }, actor: Actor = TITLE_CLOSING): { evidence: EvidenceIntake; event: DomainEvent } {
  nonEmpty(i.confirmed_at, "confirmed_at");
  const outstanding = ev.confirmation_required.filter((f) => !i.fields_confirmed.includes(f));
  if (outstanding.length) throw new RangeError(`fields still unconfirmed: ${outstanding.join(", ")} (never assumed — 24.5 edge case)`);
  const evidence: EvidenceIntake = { ...ev, status: "confirmed" };
  const event = emit(events, ev.application_id, "insurance.evidence.confirmed", { evidence_id: ev.evidence_id, kind: ev.kind, confirmed_at: i.confirmed_at, confirmed_via: i.confirmed_via, fields_confirmed: i.fields_confirmed, contact: i.contact ?? null, automation_disclosed: true }, i.confirmed_at, actor);
  return { evidence, event };
}

// ============================================================ hazard adequacy — rule 2 (9.1's engine); T1, T2, T3, T8, T12
export type OrigDeficiencyKind = "flood_none" | "flood_insufficient" | "flood_deductible" | "deductible_excess" | "acv_dwelling" | "perils_gap" | "rating_fail" | "mortgagee_clause" | "named_insured" | "master_lapse" | "unit_policy_missing" | "effective_date" | "premium_unpaid" | "nfip_not_applied_paid_at_closing" | "private_flood_terms" | "master_rcv_undocumented" | "master_coverage_short" | "master_form" | "ho6_insufficient" | "ho6_deductible_excess" | "liability_missing" | "fidelity_missing";
export type TestOutcome = "PASS" | "FAIL" | "N/A";
export interface OrigHazardPolicy {
  readonly policy_id: string; readonly policy_kind: "hazard" | "unit_owner" | "wind"; readonly policy_number?: string | null; readonly carrier?: string | null;
  readonly coverage_dwelling_cents: Cents; readonly coverage_basis: CoverageBasis; readonly roof_basis?: "rc" | "acv" | "unknown"; readonly coverage_form: CoverageForm; readonly perils_present?: readonly string[];
  readonly deductible_cents: Cents; readonly per_peril_deductibles?: readonly { readonly peril: string; readonly cents?: Cents; readonly pct?: string }[];
  readonly ratings: readonly CarrierRating[]; readonly fair_plan?: boolean; readonly fair_plan_only_coverage_available?: boolean; readonly mortgage_impairment_relief?: boolean;
  readonly mortgagee_clause_text: string; readonly named_insureds: readonly string[]; readonly excludes_wind?: boolean;
  readonly effective_date: PlainDate; readonly expiration_date: PlainDate; readonly first_year_premium_cents: Cents; readonly premium_paid_at_closing?: boolean; readonly premium_on_cd?: boolean; readonly premium_paid_through?: PlainDate | null; readonly policy_in_force?: boolean;
  readonly evidence_kind: EvidenceKind; readonly evidence_document_id: string; readonly cancellation_notice_to_mortgagee?: boolean;
}
export interface AdequacyOutcome {
  readonly pass: boolean; readonly deficiencies: readonly OrigDeficiencyKind[]; readonly tests: Record<string, TestOutcome>; readonly deductible_pct: string; readonly hazard_deductible_max_cents: Cents;
  readonly mortgagee_clause_check: MortgageeClauseCheck; readonly rating: RatingTest; readonly rule_set: string;
}
const mapServicingDeficiency = (d: ServicingDeficiency): OrigDeficiencyKind | null => d === "coverage_basis" ? "acv_dwelling" : d === "coverage_form" ? "perils_gap" : d === "carrier_rating" ? "rating_fail" : d === "deductible_excess" || d === "mortgagee_clause" || d === "named_insured" || d === "master_lapse" || d === "unit_policy_missing" ? d : null;
/** Rule 2 (`fnma.insurance.2026-08`, the same engine as 9.1): replacement-cost basis (roof may be ACV), Special form or all eight perils, every deductible ≤ 5% (unrounded), one rating agency, mortgagee clause, named insureds = title holders. No amount test (retired by LL-2026-03). */
export function evaluateHazardAdequacy(p: OrigHazardPolicy, ctx: { readonly title_holders: readonly string[]; readonly partner: { readonly legal_name: string; readonly aliases?: readonly string[] } }): AdequacyOutcome {
  nonNeg(p.coverage_dwelling_cents, "coverage_dwelling_cents"); nonNeg(p.deductible_cents, "deductible_cents");
  if (p.coverage_dwelling_cents === 0n) throw new RangeError("coverage_dwelling_cents must be positive");
  const clause = checkMortgageeClause(p.mortgagee_clause_text, ctx.partner);
  const rating = carrierRatingTest(p.ratings, { fair_plan: p.fair_plan ?? false, fair_plan_only_coverage_available: p.fair_plan_only_coverage_available ?? true, mortgage_impairment_relief: p.mortgage_impairment_relief ?? false });
  const hp: HazardPolicy = { coverage_dwelling_cents: p.coverage_dwelling_cents, coverage_basis: p.coverage_basis, roof_basis: p.roof_basis === "acv" ? "acv" : "replacement_cost", coverage_form: p.coverage_form, ...(p.perils_present ? { perils_present: p.perils_present } : {}), deductible_cents: p.deductible_cents, per_peril_deductibles: p.per_peril_deductibles ?? [],
    ratings: p.ratings, rating_exception: rating.basis === "fair_plan" ? "state_plan" : rating.basis === "mortgage_impairment" ? "mortgage_impairment" : null, mortgagee_clause: { names_partner_isaoa: clause.fannie_mae_form || (clause.partner_named && clause.successors_assigns_phrase), co_servicer: clause.servicer_address, names_mers: !clause.mers_absent }, named_insureds: p.named_insureds, excludes_wind: p.excludes_wind ?? false, unit_owner: p.policy_kind === "unit_owner" };
  const a = evaluateAdequacy(hp, ctx.title_holders);
  const defs = [...new Set(a.deficiencies.map(mapServicingDeficiency).filter((d): d is OrigDeficiencyKind => d !== null))];
  const perPerilFail = (p.per_peril_deductibles ?? []).some((pp) => (pp.pct !== undefined ? Decimal.parse(pp.pct).div(Decimal.fromInt(100)) : Decimal.ratio(pp.cents ?? 0n, p.coverage_dwelling_cents)).cmp(HAZARD_DEDUCTIBLE_MAX_PCT) > 0);
  const policyDedFail = p.deductible_cents > maxCents(hazardDeductibleMax(p.coverage_dwelling_cents), p.policy_kind === "unit_owner" ? HO6_DEDUCTIBLE_FLOOR : 0n);
  const t = (ok: boolean): TestOutcome => (ok ? "PASS" : "FAIL");
  const tests: Record<string, TestOutcome> = { coverage_basis_replacement_cost: t(!defs.includes("acv_dwelling")), coverage_form_special_or_perils: t(!defs.includes("perils_gap")), policy_deductible_le_5pct: t(!policyDedFail), per_peril_deductibles_le_5pct: (p.per_peril_deductibles ?? []).length ? t(!perPerilFail) : "N/A",
    carrier_rating_one_agency: t(rating.pass), mortgagee_clause: t(clause.pass), named_insured_matches_title: t(!defs.includes("named_insured")), roof_basis: "PASS" };
  return { pass: defs.length === 0, deficiencies: defs, tests, deductible_pct: a.deductible_pct, hazard_deductible_max_cents: hazardDeductibleMax(p.coverage_dwelling_cents), mortgagee_clause_check: clause, rating, rule_set: RULE_SET_INSURANCE };
}
export type PolicyStatus = "pending_verification" | "verified" | "deficient";
/** The `insurance_policies` row (9.1 owns; origination adds evidence_kind, premium_paid_at_closing, first_year_premium_cents, origination_verified_at, origination_adequacy, mortgagee_clause_check, named_insured_matches_title, fair_plan, mortgage_impairment_relief) — 30.3 reads policy_number / kind / first_year_premium_cents / premium_paid_through. */
export interface OrigPolicyRow {
  readonly policy_id: string; readonly application_id: string; readonly loan_id: string | null; readonly policy_kind: OrigHazardPolicy["policy_kind"] | "flood" | "master_condo" | "master_pud" | "master_coop" | "rcbap"; readonly kind: "hazard" | "flood" | "ho6" | "master" | "rcbap"; readonly policy_number: string | null; readonly carrier: string | null;
  readonly status: PolicyStatus; readonly effective_date: PlainDate | null; readonly expiration_date: PlainDate | null; readonly coverage_dwelling_cents: Cents | null; readonly deductible_cents: Cents | null; readonly deductible_pct: string | null;
  readonly evidence_kind: EvidenceKind; readonly evidence_document_id: string; readonly premium_paid_at_closing: boolean; readonly premium_paid_through: PlainDate | null; readonly first_year_premium_cents: Cents;
  readonly origination_verified_at: string | null; readonly origination_adequacy: Record<string, TestOutcome> | null; readonly mortgagee_clause_check: Pick<MortgageeClauseCheck, "partner_named" | "successors_assigns_phrase" | "servicer_address" | "mers_absent"> | null; readonly mortgagee_clause_status: "valid" | "invalid";
  readonly named_insured_matches_title: boolean | null; readonly fair_plan: boolean; readonly mortgage_impairment_relief: boolean; readonly deficiencies: readonly OrigDeficiencyKind[]; readonly rule_set: string; readonly source: "eoi_document"; readonly stage: "origination";
}
export interface VerifyHazardInput { readonly application_id: string; readonly policy: OrigHazardPolicy; readonly title_holders: readonly string[]; readonly partner: { readonly legal_name: string; readonly aliases?: readonly string[] }; readonly evidence_confirmed: boolean; readonly transaction_type: "purchase" | "refinance"; readonly disbursement_date?: PlainDate | null; readonly verified_at: string; }
/** Rule 2 + Q4 (SM policy): effective on/before disbursement; purchases with the first-year premium paid at closing or on the CD; refinances with the policy in force (≥ 30 days remaining). `verified` only on PASS with confirmed evidence (9.1 guardrail); FAIL → deficiency rows (rule 9). */
export function verifyHazardPolicy(events: EventStore, i: VerifyHazardInput, actor: Actor = TITLE_CLOSING): { row: OrigPolicyRow; adequacy: AdequacyOutcome; status: PolicyStatus; deficiencies: readonly OrigDeficiencyKind[]; events: readonly DomainEvent[] } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.verified_at, "verified_at");
  const a = evaluateHazardAdequacy(i.policy, { title_holders: i.title_holders, partner: i.partner });
  const defs: OrigDeficiencyKind[] = [...a.deficiencies];
  const disb = i.disbursement_date ?? null;
  if (disb && i.policy.effective_date > disb) defs.push("effective_date");
  if (i.transaction_type === "purchase" ? !(i.policy.premium_paid_at_closing || i.policy.premium_on_cd) : !(i.policy.policy_in_force ?? true) || (disb !== null && daysBetween(disb, i.policy.expiration_date) < 30)) defs.push("premium_unpaid");
  const status: PolicyStatus = defs.length ? "deficient" : i.evidence_confirmed ? "verified" : "pending_verification";
  const out: DomainEvent[] = [];
  const row: OrigPolicyRow = { policy_id: i.policy.policy_id, application_id: i.application_id, loan_id: null, policy_kind: i.policy.policy_kind, kind: i.policy.policy_kind === "unit_owner" ? "ho6" : "hazard", policy_number: i.policy.policy_number ?? null, carrier: i.policy.carrier ?? null, status, effective_date: i.policy.effective_date, expiration_date: i.policy.expiration_date,
    coverage_dwelling_cents: i.policy.coverage_dwelling_cents, deductible_cents: i.policy.deductible_cents, deductible_pct: a.deductible_pct, evidence_kind: i.policy.evidence_kind, evidence_document_id: i.policy.evidence_document_id, premium_paid_at_closing: i.policy.premium_paid_at_closing ?? false, premium_paid_through: i.policy.premium_paid_through ?? (i.policy.premium_paid_at_closing ? i.policy.expiration_date : null), first_year_premium_cents: i.policy.first_year_premium_cents,
    origination_verified_at: status === "verified" ? i.verified_at : null, origination_adequacy: a.tests, mortgagee_clause_check: { partner_named: a.mortgagee_clause_check.partner_named, successors_assigns_phrase: a.mortgagee_clause_check.successors_assigns_phrase, servicer_address: a.mortgagee_clause_check.servicer_address, mers_absent: a.mortgagee_clause_check.mers_absent }, mortgagee_clause_status: a.mortgagee_clause_check.pass ? "valid" : "invalid",
    named_insured_matches_title: a.tests.named_insured_matches_title === "PASS", fair_plan: i.policy.fair_plan ?? false, mortgage_impairment_relief: i.policy.mortgage_impairment_relief ?? false, deficiencies: defs, rule_set: RULE_SET_INSURANCE, source: "eoi_document", stage: "origination" };
  if (status === "verified") out.push(emit(events, i.application_id, "insurance.policy.verified", { policy_id: row.policy_id, policy_kind: row.policy_kind, kind: row.kind, evidence_document_id: row.evidence_document_id, verified_at: i.verified_at, origination_verified_at: i.verified_at, effective_date: row.effective_date, expiration_date: row.expiration_date, coverage_dwelling_cents: S(row.coverage_dwelling_cents), deductible_pct: row.deductible_pct, hazard_deductible_max_cents: S(a.hazard_deductible_max_cents),
    first_year_premium_cents: S(row.first_year_premium_cents), premium_paid_at_closing: row.premium_paid_at_closing, premium_paid_through: row.premium_paid_through, mortgagee_clause_partner_isaoa_co_sm: a.mortgagee_clause_check.pass, rating_basis: a.rating.basis, rule_set: RULE_SET_INSURANCE, stage: "origination", status: "verified", tests: a.tests }, i.verified_at, actor));
  else for (const kind of defs) out.push(openDeficiency(events, { application_id: i.application_id, policy_id: row.policy_id, kind, opened_at: i.verified_at, basis: { test: kind, evidence_document_id: row.evidence_document_id } }, actor).event);
  return { row, adequacy: a, status, deficiencies: defs, events: out };
}

// ============================================================ deficiencies — rule 9
export interface DeficiencyRow { readonly deficiency_id: string; readonly application_id: string; readonly policy_id: string | null; readonly kind: OrigDeficiencyKind; readonly stage: "origination"; readonly detected_at: string; readonly basis_evidence: Record<string, unknown>; readonly condition: "ptf" | "ptd"; readonly resolved_at: string | null; readonly resolution: "cured" | "waived_by_policy" | "withdrawn" | null; }
export function openDeficiency(events: EventStore, i: { readonly application_id: string; readonly policy_id?: string | null; readonly kind: OrigDeficiencyKind; readonly opened_at: string; readonly basis?: Record<string, unknown>; readonly condition?: "ptf" | "ptd" }, actor: Actor = TITLE_CLOSING): { row: DeficiencyRow; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.kind, "kind"); nonEmpty(i.opened_at, "opened_at");
  const row: DeficiencyRow = { deficiency_id: newId("idf"), application_id: i.application_id, policy_id: i.policy_id ?? null, kind: i.kind, stage: "origination", detected_at: i.opened_at, basis_evidence: i.basis ?? {}, condition: i.condition ?? "ptf", resolved_at: null, resolution: null };
  const event = emit(events, i.application_id, "insurance.deficiency.opened", { deficiency_id: row.deficiency_id, policy_id: row.policy_id, kind: i.kind, stage: "origination", condition: row.condition, detected_at: i.opened_at, basis_evidence: row.basis_evidence, cure_request_to: "borrower_agent_or_carrier", followup_business_days_creditor: EXTERNAL_FOLLOWUP_BUSINESS_DAYS }, i.opened_at, actor);
  return { row, event };
}
/** Only `cured`, `waived_by_policy` (FAIR plan / state cap — officer acknowledgment) or `withdrawn`. */
export function clearDeficiency(events: EventStore, row: DeficiencyRow, i: { readonly resolved_at: string; readonly resolution: "cured" | "waived_by_policy" | "withdrawn"; readonly evidence_document_id?: string | null; readonly officer_acknowledged_by?: string | null }, actor: Actor = TITLE_CLOSING): { row: DeficiencyRow; event: DomainEvent } {
  nonEmpty(i.resolved_at, "resolved_at");
  if (row.resolved_at) throw new RangeError(`deficiency ${row.deficiency_id} already resolved ${row.resolved_at}`);
  if (i.resolution === "waived_by_policy" && !(i.officer_acknowledged_by || (actor.kind === "human" && actor.role === "officer"))) throw new RangeError("waived_by_policy (FAIR plan / state cap) needs the partner officer's acknowledgment");
  if (i.resolution === "cured" && !i.evidence_document_id) throw new RangeError("cured needs the corrected evidence document");
  const next: DeficiencyRow = { ...row, resolved_at: i.resolved_at, resolution: i.resolution };
  const event = emit(events, row.application_id, "insurance.deficiency.cleared", { deficiency_id: row.deficiency_id, policy_id: row.policy_id, kind: row.kind, stage: "origination", resolved_at: i.resolved_at, resolution: i.resolution, evidence_document_id: i.evidence_document_id ?? null, officer_acknowledged_by: i.officer_acknowledged_by ?? null }, i.resolved_at, actor);
  return { row: next, event };
}

// ============================================================ flood coverage — rules 4, 6; T5, T6
export interface FloodPolicyEvidence {
  readonly policy_id: string; readonly policy_number?: string | null; readonly nfip: boolean; readonly carrier?: string | null; readonly building_coverage_cents: Cents; readonly deductible_cents: Cents;
  readonly applied_on: PlainDate | null; readonly premium_paid_on: PlainDate | null; readonly effective_date: PlainDate | null; readonly expiration_date?: PlainDate | null; readonly mortgagee_clause_text: string;
  readonly ratings?: readonly CarrierRating[]; readonly compliance_aid_statement?: boolean; readonly b7_elements_verified?: boolean; readonly cancellation_clause_45_days?: boolean; readonly mortgagee_endorsement_for_refinance?: boolean;
  readonly annual_premium_cents?: Cents | null; readonly evidence_kind: EvidenceKind; readonly evidence_document_id: string;
}
export interface FloodAdequacy { readonly pass: boolean; readonly deficiencies: readonly OrigDeficiencyKind[]; readonly tests: Record<string, TestOutcome>; readonly required_cents: Cents; readonly deductible_max_cents: Cents; readonly mortgagee_clause_check: MortgageeClauseCheck; }
/** B7-3-06 + 44 CFR 61.11: amount ≥ required, deductible ≤ NFIP max, an NFIP policy applied for and paid at or before closing (a refinance's existing policy with the mortgagee endorsement), a private policy with SFIP-equivalent terms and a rated insurer, mortgagee clause valid. */
export function evaluateFloodPolicy(p: FloodPolicyEvidence, req: { readonly flood_required_amount_cents: Cents; readonly flood_deductible_max_cents: Cents }, ctx: { readonly closing_date: PlainDate; readonly partner: { readonly legal_name: string; readonly aliases?: readonly string[] }; readonly transaction_type?: "purchase" | "refinance" }): FloodAdequacy {
  nonNeg(p.building_coverage_cents, "building_coverage_cents"); nonNeg(p.deductible_cents, "deductible_cents");
  const defs: OrigDeficiencyKind[] = [];
  const t = (ok: boolean): TestOutcome => (ok ? "PASS" : "FAIL");
  const amountOk = p.building_coverage_cents >= req.flood_required_amount_cents; if (!amountOk) defs.push("flood_insufficient");
  const dedOk = p.deductible_cents <= req.flood_deductible_max_cents; if (!dedOk) defs.push("flood_deductible");
  const existing = ctx.transaction_type === "refinance" && p.effective_date !== null && p.effective_date < ctx.closing_date;
  const appliedPaid = existing ? p.mortgagee_endorsement_for_refinance === true : p.applied_on !== null && p.premium_paid_on !== null && p.applied_on <= ctx.closing_date && p.premium_paid_on <= ctx.closing_date;
  if (!appliedPaid) defs.push("nfip_not_applied_paid_at_closing");
  const effOk = p.effective_date === null ? appliedPaid : p.effective_date <= ctx.closing_date; if (!effOk && !defs.includes("nfip_not_applied_paid_at_closing")) defs.push("effective_date");
  let privateOk: TestOutcome = "N/A";
  if (!p.nfip) { const r = privatePolicyAcceptable({ compliance_aid_statement: p.compliance_aid_statement ?? false, b7_elements_verified: p.b7_elements_verified ?? false, cancellation_clause_45_days: p.cancellation_clause_45_days ?? false, insurer_rating_ok: carrierRatingTest(p.ratings ?? []).pass }); privateOk = t(r.accepted); if (!r.accepted) defs.push(r.reason === "insurer_rating" ? "rating_fail" : "private_flood_terms"); }
  const clause = checkMortgageeClause(p.mortgagee_clause_text, ctx.partner); if (!clause.pass) defs.push("mortgagee_clause");
  const tests: Record<string, TestOutcome> = { amount_ge_required: t(amountOk), deductible_le_nfip_max: t(dedOk), applied_and_paid_at_or_before_closing: t(appliedPaid), effective_at_closing: t(effOk), private_policy_sfip_equivalent: privateOk, mortgagee_clause: t(clause.pass) };
  return { pass: defs.length === 0, deficiencies: [...new Set(defs)], tests, required_cents: req.flood_required_amount_cents, deductible_max_cents: req.flood_deductible_max_cents, mortgagee_clause_check: clause };
}
/** `flood.coverage.verified` when the policy passes (FNMA_B7_3_06_FLOOD_COVERAGE_GATE); otherwise the deficiency rows. */
export function verifyFloodCoverage(events: EventStore, rec: FloodDeterminationRecord, p: FloodPolicyEvidence, req: { readonly flood_required_amount_cents: Cents; readonly flood_deductible_max_cents: Cents }, ctx: { readonly closing_date: PlainDate; readonly partner: { readonly legal_name: string; readonly aliases?: readonly string[] }; readonly transaction_type?: "purchase" | "refinance"; readonly verified_at: string }, actor: Actor = TITLE_CLOSING): { record: FloodDeterminationRecord; row: OrigPolicyRow; adequacy: FloodAdequacy; events: readonly DomainEvent[] } {
  if (!rec.in_sfha) throw new RangeError("flood coverage is verified on SFHA loans only");
  const a = evaluateFloodPolicy(p, req, ctx);
  const status: PolicyStatus = a.pass ? "verified" : "deficient";
  const row: OrigPolicyRow = { policy_id: p.policy_id, application_id: rec.application_id, loan_id: null, policy_kind: "flood", kind: "flood", policy_number: p.policy_number ?? null, carrier: p.carrier ?? (p.nfip ? "NFIP" : null), status, effective_date: p.effective_date ?? ctx.closing_date, expiration_date: p.expiration_date ?? null, coverage_dwelling_cents: p.building_coverage_cents, deductible_cents: p.deductible_cents, deductible_pct: null,
    evidence_kind: p.evidence_kind, evidence_document_id: p.evidence_document_id, premium_paid_at_closing: p.premium_paid_on !== null && p.premium_paid_on <= ctx.closing_date, premium_paid_through: p.expiration_date ?? null, first_year_premium_cents: p.annual_premium_cents ?? 0n, origination_verified_at: a.pass ? ctx.verified_at : null, origination_adequacy: a.tests,
    mortgagee_clause_check: { partner_named: a.mortgagee_clause_check.partner_named, successors_assigns_phrase: a.mortgagee_clause_check.successors_assigns_phrase, servicer_address: a.mortgagee_clause_check.servicer_address, mers_absent: a.mortgagee_clause_check.mers_absent }, mortgagee_clause_status: a.mortgagee_clause_check.pass ? "valid" : "invalid", named_insured_matches_title: null, fair_plan: false, mortgage_impairment_relief: false, deficiencies: a.deficiencies, rule_set: RULE_SET_NFIP, source: "eoi_document", stage: "origination" };
  const out: DomainEvent[] = [];
  const record: FloodDeterminationRecord = { ...rec, status: a.pass ? "coverage_verified" : "coverage_pending", required_amount_cents: req.flood_required_amount_cents };
  if (a.pass) {
    out.push(emit(events, rec.application_id, "flood.coverage.verified", { determination_id: rec.determination_id, source: "origination_evidence", policy_id: p.policy_id, nfip: p.nfip, amount_cents: S(p.building_coverage_cents), required_cents: S(req.flood_required_amount_cents), deductible_cents: S(p.deductible_cents), effective: row.effective_date, as_of: ctx.verified_at, applied_on: p.applied_on, premium_paid_on: p.premium_paid_on, tests: a.tests }, ctx.verified_at, actor));
    out.push(emit(events, rec.application_id, "insurance.policy.verified", { policy_id: p.policy_id, policy_kind: "flood", kind: "flood", verified_at: ctx.verified_at, origination_verified_at: ctx.verified_at, effective_date: row.effective_date, expiration_date: row.expiration_date, coverage_dwelling_cents: S(p.building_coverage_cents), first_year_premium_cents: S(row.first_year_premium_cents), premium_paid_at_closing: row.premium_paid_at_closing, premium_paid_through: row.premium_paid_through, rule_set: RULE_SET_NFIP, stage: "origination", status: "verified" }, ctx.verified_at, actor));
  } else for (const kind of a.deficiencies) out.push(openDeficiency(events, { application_id: rec.application_id, policy_id: p.policy_id, kind, opened_at: ctx.verified_at, basis: { test: kind, evidence_document_id: p.evidence_document_id, required_cents: S(req.flood_required_amount_cents) } }, actor).event);
  return { record, row, adequacy: a, events: out };
}
export interface RcbapInput { readonly units: number; readonly rcv_building_cents: Cents; readonly rcbap_coverage_cents: Cents; readonly unit_rcv_share_cents?: Cents | null; readonly unit_upb_cents: Cents; readonly supplemental_unit_policy_cents?: Cents | null; }
export interface RcbapEvaluation extends RcbapResult { readonly building_pass: boolean; readonly unit_pass: boolean; readonly supplemental_required_cents: Cents; readonly deficiency: "flood_insufficient" | null; readonly eighty_pct_rcv_cents: Cents; readonly nfip_units_max_cents: Cents; }
/** Rule 4 (9.6's rcbap): building ≥ min(80% RCV, $250,000 × units); per-unit allocation vs the unit's own min(unit RCV share, $250,000, UPB) → supplemental unit policy for the shortfall. */
export function evaluateRcbap(i: RcbapInput): RcbapEvaluation {
  if (!Number.isInteger(i.units) || i.units < 1) throw new RangeError("units must be a positive integer");
  const unitRcv = i.unit_rcv_share_cents ?? i.rcv_building_cents / BigInt(i.units);
  const r = rcbap(i.units, nonNeg(i.rcv_building_cents, "rcv_building_cents"), nonNeg(i.rcbap_coverage_cents, "rcbap_coverage_cents"), unitRcv, nonNeg(i.unit_upb_cents, "unit_upb_cents"));
  const building_pass = i.rcbap_coverage_cents >= r.required_rcbap_cents;
  const unit_pass = building_pass && (i.supplemental_unit_policy_cents ?? 0n) >= r.supplement_cents;
  return { ...r, building_pass, unit_pass, supplemental_required_cents: r.supplement_cents, deficiency: unit_pass ? null : "flood_insufficient", eighty_pct_rcv_cents: (i.rcv_building_cents * 80n) / 100n, nfip_units_max_cents: NFIP_BUILDING_MAX * BigInt(i.units) };
}

// ============================================================ project (master / HO-6 / liability / fidelity) — rule 3; T7
export type RcvDocumentation = "guaranteed_rc" | "extended_rc" | "insurer_rcv_estimate" | "insurance_risk_appraisal" | "insurer_statement";
export interface ProjectInsuranceInput {
  readonly application_id: string; readonly application_date: PlainDate; readonly project_type: Exclude<ProjectType, "detached">; readonly units_total: number; readonly waiver_of_review?: boolean;
  readonly master: { readonly policy_id: string; readonly rcv_cents: Cents; readonly coverage_cents: Cents; readonly rcv_documentation: RcvDocumentation | null; readonly coverage_form: "special" | "broad" | "basic"; readonly deductible_cents: Cents; readonly per_unit_deductible_cents: Cents | null; readonly covers_interior: boolean; readonly condo_association_form_endorsed?: boolean; readonly evidence_document_id: string; readonly effective_date?: PlainDate | null; readonly expiration_date?: PlainDate | null };
  readonly ho6: { readonly policy_id: string; readonly coverage_cents: Cents; readonly deductible_cents: Cents; readonly restoration_estimate_cents: Cents | null; readonly evidence_document_id: string } | null;
  readonly liability: { readonly coverage_cents: Cents; readonly separation_of_insureds: boolean; readonly evidence_document_id: string } | null;
  readonly fidelity: { readonly coverage_cents: Cents; readonly evidence_document_id: string; readonly management_agent_policy_only?: boolean } | null;
  readonly fidelity_need_cents?: Cents | null; readonly state_fidelity_statute?: boolean;
}
export interface ProjectInsuranceOutcome {
  readonly pass: boolean; readonly deficiencies: readonly OrigDeficiencyKind[]; readonly tests: Record<string, TestOutcome>; readonly mandatory_rules_apply: boolean;
  readonly master_deductible_max_cents: Cents; readonly master_per_unit_deductible_max_cents: Cents; readonly ho6_required: boolean; readonly ho6_min_amount_cents: Cents | null; readonly ho6_deductible_max_cents: Cents | null; readonly liability_required: boolean; readonly fidelity_required: boolean;
}
/** Rule 3 — master 100% RCV by one of five documentation options, Special (≥ commercial Broad) perils, deductible ≤ 5% and ≤ $50,000 per unit; HO-6 when the master has a per-unit deductible or excludes interior/improvements; liability ≥ $1M with severability; fidelity unless waived. Mandatory for applications on/after July 1, 2026 (SM applies it to every application). */
export function evaluateProjectInsurance(i: ProjectInsuranceInput): ProjectInsuranceOutcome {
  const defs: OrigDeficiencyKind[] = [];
  const t = (ok: boolean): TestOutcome => (ok ? "PASS" : "FAIL");
  const m = i.master;
  const rcvDocumented = m.rcv_documentation !== null; if (!rcvDocumented) defs.push("master_rcv_undocumented");
  const coverageOk = m.coverage_cents >= m.rcv_cents; if (!coverageOk) defs.push("master_coverage_short");
  const formOk = m.coverage_form === "special" || m.coverage_form === "broad"; if (!formOk) defs.push("master_form");
  const masterDedMax = HAZARD_DEDUCTIBLE_MAX_PCT.mul(Decimal.fromBigInt(m.coverage_cents)).toScaledInt(0, "DOWN");
  const dedOk = m.deductible_cents <= masterDedMax; if (!dedOk) defs.push("deductible_excess");
  const perUnitOk = m.per_unit_deductible_cents === null || m.per_unit_deductible_cents <= MASTER_PER_UNIT_DEDUCTIBLE_MAX_CENTS; if (!perUnitOk) defs.push("master_lapse");
  const ho6 = ho6Requirement({ per_unit_deductible_cents: m.per_unit_deductible_cents, restoration_estimate_cents: i.ho6?.restoration_estimate_cents ?? null, master_covers_interior: m.covers_interior });
  let ho6Amount: TestOutcome = "N/A", ho6Ded: TestOutcome = "N/A";
  if (ho6.ho6_required) {
    if (!i.ho6) { defs.push("unit_policy_missing"); ho6Amount = "FAIL"; ho6Ded = "FAIL"; }
    else { const amtOk = i.ho6.coverage_cents >= (ho6.ho6_min_amount_cents ?? 0n); ho6Amount = t(amtOk); if (!amtOk) defs.push("ho6_insufficient"); const dOk = i.ho6.deductible_cents <= ho6DeductibleMax(i.ho6.coverage_cents); ho6Ded = t(dOk); if (!dOk) defs.push("ho6_deductible_excess"); }
  }
  const condoCoop = i.project_type === "condo" || i.project_type === "coop";
  const liabilityRequired = condoCoop && !i.waiver_of_review;
  const liabOk = !liabilityRequired || (i.liability !== null && i.liability.coverage_cents >= LIABILITY_MIN_CENTS && i.liability.separation_of_insureds); if (!liabOk) defs.push("liability_missing");
  const need = i.fidelity_need_cents ?? null;
  const fidelityRequired = liabilityRequired && i.units_total > FIDELITY_WAIVER_MAX_UNITS && (need === null || need > FIDELITY_WAIVER_MAX_NEED_CENTS);
  const fidOk = !fidelityRequired || i.state_fidelity_statute === true || (i.fidelity !== null && !i.fidelity.management_agent_policy_only && (need === null || i.fidelity.coverage_cents >= need)); if (!fidOk) defs.push("fidelity_missing");
  const tests: Record<string, TestOutcome> = { master_rcv_documented: t(rcvDocumented), master_coverage_100pct_rcv: t(coverageOk), master_form_special_or_broad: t(formOk), master_deductible_le_5pct: t(dedOk), master_per_unit_deductible_le_50000: t(perUnitOk), ho6_amount: ho6Amount, ho6_deductible_le_max_5pct_2500: ho6Ded, liability_b7_4_01: liabilityRequired ? t(liabOk) : "N/A", fidelity_b7_4_02: fidelityRequired ? t(fidOk) : "N/A" };
  return { pass: defs.length === 0, deficiencies: [...new Set(defs)], tests, mandatory_rules_apply: i.application_date >= MASTER_HO6_MANDATORY_FROM, master_deductible_max_cents: masterDedMax, master_per_unit_deductible_max_cents: MASTER_PER_UNIT_DEDUCTIBLE_MAX_CENTS, ...ho6, liability_required: liabilityRequired, fidelity_required: fidelityRequired };
}
/** `project.insurance.verified` on PASS (FNMA_B7_3_03_PROJECT_INSURANCE_GATE); deficiencies otherwise. */
export function verifyProjectInsurance(events: EventStore, i: ProjectInsuranceInput, verifiedAt: string, actor: Actor = TITLE_CLOSING): { outcome: ProjectInsuranceOutcome; events: readonly DomainEvent[] } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(verifiedAt, "verified_at");
  const o = evaluateProjectInsurance(i);
  const out: DomainEvent[] = [];
  if (o.pass) out.push(emit(events, i.application_id, "project.insurance.verified", { master_policy_id: i.master.policy_id, ho6_policy_id: i.ho6?.policy_id ?? null, verified_at: verifiedAt, project_type: i.project_type, mandatory_rules_apply: o.mandatory_rules_apply, master_coverage_cents: S(i.master.coverage_cents), master_rcv_cents: S(i.master.rcv_cents), per_unit_deductible_cents: S(i.master.per_unit_deductible_cents), ho6_required: o.ho6_required, ho6_min_amount_cents: S(o.ho6_min_amount_cents), ho6_deductible_max_cents: S(o.ho6_deductible_max_cents), liability_required: o.liability_required, fidelity_required: o.fidelity_required, tests: o.tests, rule_set: RULE_SET_INSURANCE }, verifiedAt, actor));
  else for (const kind of o.deficiencies) out.push(openDeficiency(events, { application_id: i.application_id, policy_id: kind.startsWith("ho6") || kind === "unit_policy_missing" ? i.ho6?.policy_id ?? null : i.master.policy_id, kind, opened_at: verifiedAt, basis: { test: kind, evidence_document_id: i.master.evidence_document_id } }, actor).event);
  return { outcome: o, events: out };
}

// ============================================================ escrow implications — rule 8; T11 (30.3 consumes)
export type EscrowLineKind = "hazard" | "flood" | "ho6";
export interface EscrowLineSeed { readonly line_kind: EscrowLineKind; readonly policy_id: string; readonly policy_number: string | null; readonly annual_premium_cents: Cents; readonly monthly_cents: Cents; readonly next_due_on: PlainDate | null; readonly paid_at_closing: boolean; readonly active: boolean; readonly waivable: boolean; readonly waived: boolean; readonly basis: string; }
export interface EscrowSeedInput {
  readonly application_id: string; readonly escrowed: boolean; readonly hpml: boolean; readonly regulated_lending_institution: boolean; readonly in_sfha: boolean; readonly borrower_flood_escrow_election?: "escrow" | "waive" | null; readonly master_blanket_covers_unit?: boolean;
  readonly hazard: { readonly policy_id: string; readonly policy_number?: string | null; readonly annual_premium_cents: Cents; readonly premium_paid_through: PlainDate | null; readonly paid_at_closing: boolean } | null;
  readonly flood: { readonly policy_id: string; readonly policy_number?: string | null; readonly annual_premium_cents: Cents; readonly premium_paid_through: PlainDate | null; readonly paid_at_closing: boolean } | null;
  readonly ho6: { readonly policy_id: string; readonly policy_number?: string | null; readonly annual_premium_cents: Cents; readonly premium_paid_through: PlainDate | null; readonly paid_at_closing: boolean } | null;
}
/** Annual premium ÷ 12, rounded to cents (30.3's aggregate accounting governs the final deposit). */
export const monthlyEscrowCents = (annual: Cents): Cents => Decimal.ratio(nonNeg(annual, "annual_premium_cents"), 12n).toScaledInt(0, "HALF_UP");
/** Rule 8: escrowed → hazard, flood and (where the master does not cover) HO-6 lines with next due dates; non-escrowed → the flood line is waivable unless the partner is a regulated lending institution (12 CFR 22.5) or the loan is an HPML (§1026.35(b)); premiums paid at closing are CD prepaids. */
export function seedEscrowLines(events: EventStore, i: EscrowSeedInput, seededAt: string, actor: Actor = TITLE_CLOSING): { lines: readonly EscrowLineSeed[]; escrow_established: boolean; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(seededAt, "seeded_at");
  const active = i.escrowed || i.hpml;
  const lines: EscrowLineSeed[] = [];
  const line = (kind: EscrowLineKind, p: NonNullable<EscrowSeedInput["hazard"]>, waivable: boolean, waived: boolean, basis: string): EscrowLineSeed => ({ line_kind: kind, policy_id: p.policy_id, policy_number: p.policy_number ?? null, annual_premium_cents: p.annual_premium_cents, monthly_cents: monthlyEscrowCents(p.annual_premium_cents), next_due_on: p.premium_paid_through, paid_at_closing: p.paid_at_closing, active: active && !waived, waivable, waived, basis });
  if (i.hazard) lines.push(line("hazard", i.hazard, !i.hpml, !active, i.hpml ? "§1026.35(b)(1): HPML escrow for creditor-required insurance" : "B2-1.5-04: waivable by the lender's written policy"));
  if (i.in_sfha && i.flood) {
    const waivable = !i.hpml && !i.regulated_lending_institution;
    const waived = !i.escrowed && !i.hpml && (i.regulated_lending_institution ? false : i.borrower_flood_escrow_election !== "escrow");
    lines.push(line("flood", i.flood, waivable, waived, i.regulated_lending_institution ? "42 U.S.C. 4012a(d) / 12 CFR 22.5: regulated lending institution — flood premiums escrowed (3.8 FLOOD_12CFR22_5_ESCROW_GATE)" : i.hpml ? "§1026.35(b)(1): HPML escrow" : "24.5-Q3: SM policy — flood line waivable only by the borrower's written election (non-HPML; partner not a regulated lending institution)"));
  }
  if (i.ho6 && !i.master_blanket_covers_unit) lines.push(line("ho6", i.ho6, !i.hpml, !active, "B2-1.5-04: no escrow required when the project's blanket policy covers the unit"));
  const event = emit(events, i.application_id, "insurance.escrow_lines.seeded", { seeded_at: seededAt, escrowed: i.escrowed, hpml: i.hpml, regulated_lending_institution: i.regulated_lending_institution, in_sfha: i.in_sfha, lines: lines.map((l) => ({ ...l, annual_premium_cents: S(l.annual_premium_cents), monthly_cents: S(l.monthly_cents) })), consumer: "30.3" }, seededAt, actor);
  return { lines, escrow_established: active, event };
}

// ============================================================ gates (evaluators-24-5.ts keys) — timers table
export interface GateOutcome { readonly open: boolean; readonly reason?: string; }
const closed = (reason: string): GateOutcome => ({ open: false, reason });
const OPEN: GateOutcome = { open: true };
/** FNMA_B7_3_06_FLOOD_COVERAGE_GATE (`consummate`, SFHA loans): `flood.coverage.verified` on file — amount, deductible, applied/paid at or before closing, mortgagee clause. */
export function floodCoverageGate(f: { readonly in_sfha: boolean; readonly flood_status?: string | null; readonly flood_coverage_verified?: boolean; readonly open_flood_deficiencies?: readonly string[] }): GateOutcome {
  if (!f.in_sfha) return OPEN;
  if (f.flood_status === "ineligible") return closed("property ineligible: non-participating community / CBRS-OPA (B7-3-06)");
  if (f.open_flood_deficiencies?.length) return closed(`flood deficiencies open: ${f.open_flood_deficiencies.join(", ")}`);
  return f.flood_coverage_verified === true || f.flood_status === "coverage_verified" ? OPEN : closed("flood coverage not verified (NFIP/private evidence with amount ≥ required, deductible ≤ NFIP max, applied and paid at or before closing, valid mortgagee clause)");
}
/** FNMA_B7_3_02_HAZARD_EVIDENCE_GATE (`disburse`): hazard `verified` under fnma.insurance.2026-08, effective ≤ disbursement, first-year premium paid / on the CD (purchase) or in force (refinance). */
export function hazardEvidenceGate(f: { readonly hazard_status?: string | null; readonly effective_date?: PlainDate | null; readonly disbursement_date?: PlainDate | null; readonly transaction_type?: string | null; readonly premium_paid_at_closing?: boolean; readonly premium_on_cd?: boolean; readonly policy_in_force?: boolean; readonly rule_set?: string | null }): GateOutcome {
  if (f.hazard_status !== "verified") return closed(`hazard policy is ${f.hazard_status ?? "missing"}, not verified (${RULE_SET_INSURANCE})`);
  if (f.rule_set && f.rule_set !== RULE_SET_INSURANCE) return closed(`hazard policy verified under ${f.rule_set}, not ${RULE_SET_INSURANCE}`);
  if (f.effective_date && f.disbursement_date && f.effective_date > f.disbursement_date) return closed(`hazard policy effective ${f.effective_date} after disbursement ${f.disbursement_date}`);
  if (f.transaction_type === "purchase" && !(f.premium_paid_at_closing || f.premium_on_cd)) return closed("first-year hazard premium not paid or collected on the CD (purchase)");
  if (f.transaction_type === "refinance" && f.policy_in_force === false) return closed("hazard policy not in force (refinance)");
  return OPEN;
}
/** FNMA_B7_3_03_PROJECT_INSURANCE_GATE (`disburse`, condo/co-op/attached PUD): `project.insurance.verified` — master, HO-6 when required, liability and fidelity unless waived. */
export function projectInsuranceGate(f: { readonly project_type?: string | null; readonly project_insurance_verified?: boolean; readonly open_project_deficiencies?: readonly string[] }): GateOutcome {
  if (!f.project_type || f.project_type === "detached") return OPEN;
  if (f.open_project_deficiencies?.length) return closed(`project insurance deficiencies open: ${f.open_project_deficiencies.join(", ")}`);
  return f.project_insurance_verified === true ? OPEN : closed("project insurance not verified (master 100% RCV, Special/Broad, 5% and $50,000 per-unit deductibles, HO-6, liability, fidelity)");
}
/** FDPA_4012A_LOL_ENROLLED_GATE (boarding, 30.4): `lol_purchased=true` and the vendor contract linked to the loan id — else boarding warning W-007. */
export function lolEnrolledGate(f: { readonly lol_purchased?: boolean; readonly lol_contract_linked?: boolean; readonly loan_id?: string | null; readonly determination_present?: boolean }): GateOutcome {
  if (f.determination_present === false) return closed("no flood determination on file (W-007)");
  if (f.lol_purchased !== true) return closed("life-of-loan monitoring not purchased with the SFHDF (W-007)");
  if (f.lol_contract_linked !== true || !f.loan_id) return closed("life-of-loan contract not linked to the servicing loan id (W-007)");
  return OPEN;
}

// ============================================================ hand-off at funding — 9.1 / 9.6 rows; FDPA_4012A_LOL_ENROLLED_GATE
export interface HandOffInput { readonly application_id: string; readonly loan_id: string; readonly funded_at: string; readonly determination: FloodDeterminationRecord; readonly policies: readonly OrigPolicyRow[]; readonly lol_contract_linked: boolean; readonly vendor_party_id?: string | null; }
export interface ServicingFloodRow { readonly loan_id: string; readonly property_id: string; readonly vendor_ref: string | null; readonly determination_date: PlainDate; readonly sfhdf_document_id: string | null; readonly zone: string | null; readonly sfha: boolean; readonly cbrs_opa: boolean; readonly community_number: string | null; readonly participating: boolean | null; readonly map_panel: string | null; readonly map_date: PlainDate | null; readonly lol: boolean; readonly multiple_structures: boolean; readonly structures: readonly SfhdfStructure[]; readonly determination_type: "boarding"; readonly coverage_required: boolean; readonly required_amount_cents: Cents | null; readonly application_id: string; readonly lol_certificate_id: string | null; readonly sfc_180: boolean; readonly origination_status: FloodStatus; }
/** At `loan.funded`: the verified origination rows become 9.1 `insurance_policies` (status verified) and the 9.6 `flood_determinations` row (LOL linked → `flood.lol.enrolled{lol_purchased=true}`, the gate's satisfier; else boarding warning W-007 for 30.2). */
export function handOffToServicing(events: EventStore, i: HandOffInput, actor: Actor = TITLE_CLOSING): { flood_row: ServicingFloodRow; policy_rows: readonly OrigPolicyRow[]; gate: GateOutcome; event: DomainEvent | null; warning: "W-007" | null } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.loan_id, "loan_id"); nonEmpty(i.funded_at, "funded_at");
  const d = i.determination;
  if (!d.determination_date) throw new RangeError("the flood determination was never received — nothing to hand off");
  const gate = lolEnrolledGate({ lol_purchased: d.lol_purchased, lol_contract_linked: i.lol_contract_linked, loan_id: i.loan_id, determination_present: true });
  const flood_row: ServicingFloodRow = { loan_id: i.loan_id, property_id: d.property_id, vendor_ref: d.vendor_ref, determination_date: d.determination_date, sfhdf_document_id: d.sfhdf_document_id, zone: d.zone, sfha: d.in_sfha, cbrs_opa: d.cbrs_opa, community_number: d.community_number, participating: d.community_participating, map_panel: d.map_panel, map_date: d.map_date, lol: d.lol_purchased, multiple_structures: d.multiple_structures, structures: d.structures, determination_type: "boarding", coverage_required: d.coverage_required, required_amount_cents: d.required_amount_cents, application_id: i.application_id, lol_certificate_id: d.lol_certificate_id, sfc_180: d.sfc_180, origination_status: d.status };
  const policy_rows = i.policies.filter((p) => p.status === "verified").map((p) => ({ ...p, loan_id: i.loan_id }));
  const event = gate.open ? emit(events, i.application_id, "flood.lol.enrolled", { loan_id: i.loan_id, determination_id: d.determination_id, certificate_id: d.lol_certificate_id, lol_purchased: true, contract_linked: true, funded_at: i.funded_at, vendor_party_id: i.vendor_party_id ?? null, seeded: ["flood_determinations", "insurance_policies"], policies: policy_rows.map((p) => p.policy_id) }, i.funded_at, actor, i.loan_id) : null;
  return { flood_row, policy_rows, gate, event, warning: gate.open ? null : "W-007" };
}

// ============================================================ decision record — AI agent design
export interface DecisionRecord { readonly application_id: string; readonly determination: Record<string, unknown> | null; readonly notice: Record<string, unknown> | null; readonly requirements: Record<string, unknown> | null; readonly evidence: readonly { kind: string; document_id: string; extraction_confidence: ExtractionConfidence }[]; readonly adequacy_results: Record<string, unknown>; readonly deficiencies: readonly string[]; readonly gates: Record<string, GateOutcome>; readonly rationale: string; readonly rule_set_version: string; readonly model_version: string; readonly prompt_version: string; readonly confidence: number; }
export function writeDecision(i: { readonly application_id: string; readonly determination: FloodDeterminationRecord | null; readonly requirement: InsuranceRequirement | null; readonly evidence: readonly EvidenceIntake[]; readonly policies: readonly OrigPolicyRow[]; readonly deficiencies: readonly DeficiencyRow[]; readonly gates: Record<string, GateOutcome>; readonly model_version: string; readonly prompt_version: string; readonly confidence?: number; readonly rationale?: string }): DecisionRecord {
  nonEmpty(i.application_id, "application_id");
  const d = i.determination;
  const open = i.deficiencies.filter((x) => !x.resolved_at).map((x) => x.kind);
  const rationale = i.rationale ?? [d ? `flood: zone ${d.zone ?? "?"} (${d.in_sfha ? "SFHA" : "not SFHA"}; ${d.sfc_180 ? "SFC 180" : d.status})` : "flood: not ordered", d?.notice_delivered_at ? `notice delivered ${d.notice_delivered_at} (${d.notice_delivery_channel}), ${d.notice_reasonable_period_days ?? "?"} days before consummation` : "notice: n/a", `policies: ${i.policies.map((p) => `${p.kind}=${p.status}`).join(", ") || "none"}`, open.length ? `open deficiencies: ${open.join(", ")}` : "no open deficiencies", `gates: ${Object.entries(i.gates).map(([k, v]) => `${k}=${v.open ? "open" : "closed"}`).join(", ")}`].join("; ");
  return { application_id: i.application_id, determination: d ? { zone: d.zone, sfha: d.in_sfha, community: d.community_number, form_version: d.sfhdf_form_version, vendor_ref: d.vendor_ref, sfc_180: d.sfc_180, status: d.status } : null,
    notice: d?.notice_delivered_at ? { delivered_at: d.notice_delivered_at, channel: d.notice_delivery_channel, receipt_date: d.notice_effective_receipt_date, days_before_consummation: d.notice_reasonable_period_days, acknowledged_at: d.notice_acknowledged_at, short_period_reason: d.notice_short_period_reason } : null,
    requirements: i.requirement ? { requirement_id: i.requirement.requirement_id, hazard_deductible_max_cents: S(i.requirement.hazard_deductible_max_cents), flood_required_amount_cents: S(i.requirement.flood_required_amount_cents), flood_deductible_max_cents: S(i.requirement.flood_deductible_max_cents), ho6_required: i.requirement.ho6_required, master_policy_required: i.requirement.master_policy_required } : null,
    evidence: i.evidence.map((e) => ({ kind: e.kind, document_id: e.document_id, extraction_confidence: e.confidence })), adequacy_results: Object.fromEntries(i.policies.map((p) => [p.policy_id, { status: p.status, tests: p.origination_adequacy, deficiencies: p.deficiencies }])), deficiencies: open, gates: i.gates, rationale,
    rule_set_version: `${RULE_SET_INSURANCE} / ${RULE_SET_FDPA} / ${RULE_SET_NFIP}`, model_version: i.model_version, prompt_version: i.prompt_version, confidence: i.confidence ?? 0.97 };
}

/** The notice payload (NTC_FDPA_4104A_FLOOD_NOTICE) from the determination and the application facts — borrower-facing text comes only from the template. */
export function floodNoticePayload(d: FloodDeterminationRecord, i: { readonly notice_date: PlainDate; readonly partner_name: string; readonly borrower_names: readonly string[]; readonly property_address: string; readonly loan_number_last4: string; readonly escrow_required: boolean; readonly escrow_statement_applies: boolean; readonly contact_phone: string; readonly scheduled_consummation_date?: PlainDate | null; readonly language?: string }): Record<string, unknown> {
  if (!d.in_sfha) throw new RangeError("the flood notice is rendered for SFHA determinations only");
  return { notice_date: i.notice_date, partner_name: i.partner_name, borrower_names: [...i.borrower_names], property_address: i.property_address, loan_number_last4: i.loan_number_last4, flood_zone: d.zone, community_number: d.community_number, community_participating: d.community_participating === true, map_panel: d.map_panel, sfhdf_form_version: d.sfhdf_form_version, in_sfha: true,
    escrow_statement_applies: i.escrow_statement_applies, escrow_required: i.escrow_required, contact_phone: i.contact_phone, scheduled_consummation_date: i.scheduled_consummation_date ?? null, earliest_consummation: earliestConsummationAfterNotice(i.notice_date), reasonable_period_days: NOTICE_REASONABLE_PERIOD_DAYS, language: i.language ?? "en", acknowledgment_required: true };
}
export { plainDate };
