/**
 * §28.1 — Prefunding quality control program: daily selection (random + risk triggers), full-file / component
 * reviews over D1-2-01's eight areas, reverifications under a QC purpose code, findings routed to the `qc_officer`,
 * release to production (23.3 reopens conditions), the prior-to-closing gate, closing-with-open-review breach,
 * monthly reporting (D1-1-03) and the officer-concurrence feedback loop (31.2). Pure rule functions, one per rule /
 * T-id; the bus tools in src/app/tools/section28-1.ts call them.
 * Spec: spec/sections/28-quality-control-hmda-and-fraud-aml-reporting/28-1-prefunding-quality-control-program-selection-review-scope-re.md
 *
 * Reused, never re-implemented: 18.x's `qc_findings` / `qc_reports` tables (origination columns added by ALTER in
 * 0099), 23.3's gate shape (`prefundingQcGate`, `prefundingReviewStatus`, `assertNoDemographics`), the creditor and
 * Reg Z specific calendars, the sha256 helper of 18.2.
 *
 * Events appended here (every application-scoped one carries `applicationId`; the program-level ones carry
 * `source: "origination"` so the 28.1 timers arm under origination context — src/kernel/timers/engine.ts):
 *   schedule.tick{cadence=daily, job=qc_prefunding_selection}      [arms SM_QC_PREFUNDING_SELECTION_DAILY]
 *   qc.sample.planned{period_month, random_target, actuals}         [satisfies SM_QC_PREFUNDING_SELECTION_DAILY]
 *   qc.hold.applied{kind=prefunding} · qc.hold.released              (the only hold events — 23.3 consumes them)
 *   qc.review.opened{kind=prefunding}                                [arms FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE]
 *   qc.review.selected{basis, selected_at}                          [arms SM_QC_PREFUNDING_REVIEW_SLA_2BD]
 *   qc.review.started · qc.review.completed{review_completed_at}     [the latter satisfies SM_QC_PREFUNDING_REVIEW_SLA_2BD]
 *   qc.reverification.requested{requested_at, attempt} · qc.reverification.received   [SM_QC_REVERIFICATION_RESPONSE_3BD]
 *   qc.finding.recorded · qc.review.routed_to_officer{routed_at}     [arms SM_QC_OFFICER_FINDING_SLA_1BD]
 *   qc.finding.officer_decided{decision∈{released, withdrawn}}       [satisfies SM_QC_OFFICER_FINDING_SLA_1BD]
 *   qc.finding.released{released_at}                                 [arms SM_QC_REBUTTAL_WINDOW_1BD]
 *   qc.finding.resolved{resolution} · qc.finding.rebutted · qc.finding.withdrawn · qc.finding.sustained · qc.finding.corrected
 *   qc.review.closed{outcome, defects_open}                          [satisfies FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE]
 *   qc.breach.closed_with_open_review · qc.fraud_referral.requested (28.4 openFraudCase) · qc.model_review.requested (31.2)
 *   qc.sample.completed{kind=prefunding, completion_date}            [arms FNMA_D1_1_03_PREFUNDING_REPORT_30]
 *   qc.report.issued{kind, issued_at}                                [arms SM_QC_REPORT_SIGNOFF_SLA_3BD; kind=qc_audit_annual satisfies FNMA_D1_1_01_QC_AUDIT_ANNUAL]
 *   qc.report.signed{kind}                                           [satisfies FNMA_D1_1_03_PREFUNDING_REPORT_30, SM_QC_REPORT_SIGNOFF_SLA_3BD]
 *   qc.corrective_action.opened                                      (compliance-sentinel tracks completion)
 */
import { createHash } from "node:crypto";
import type { EventStore, DomainEvent, Actor } from "../../kernel/events/index.ts";
import { plainDate as D, addDays, addMonths, endOfMonth, startOfMonth, daysBetween, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, rollBack, businessDaysBetween, creditor, regzSpecific, type Calendar } from "../../kernel/calendar/business.ts";
import { wallClock, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { EscalationService, Escalation } from "../../app/escalations.ts";
import { assertNoDemographics, prefundingQcGate, prefundingReviewStatus, type PrefundingReviewStatus, type GateResult } from "../underwriting/ops-23-3.ts";

// ============================================================ constants (spec "Business rules")
export const RULE_SETS_28_1 = { "fnma.selling": "2026-09-02", "fnma.qc.taxonomy": "v1", "fnma.qc.plan": "prefunding-2026-09" } as const;
export const RULE_SET_VERSION_28_1 = "fnma.selling.2026-09-02";
export const RETENTION_CLASS_QC = "fnma_qc_3y";
export const QC_AGENT_ID = "qc-audit";
export const QC_AGENT: Actor = { kind: "agent", id: QC_AGENT_ID };
export const SENTINEL = "compliance-sentinel";
export const RANDOM_TARGET_RATE_BPS = 500;           // 5% of forecast monthly closings (28.1-Q1)
export const RANDOM_TARGET_FLOOR = 10;
export const OFFICER_SAMPLE_RATE_DEFAULT = 0.10;     // D1-1-02 analogy (28.1-Q4)
export const CONCURRENCE_FLOOR = 0.90;               // rule 6: below 90% → 31.2 model review; sample doubles
export const TREND_MIN_LOANS = 3;                    // rule 7: same defect code in ≥ 3 loans …
export const TREND_MIN_SHARE = 0.10;                 // … or ≥ 10% of reviews
export const TREND_WINDOW_MONTHS = 3;                // D1-1-03 "defect trending for at least three months"
export const REVIEW_SLA_BD = 2, REVERIFICATION_RESPONSE_BD = 3, REVERIFICATION_ESCALATE_BD = 5, OFFICER_FINDING_SLA_BD = 1, REBUTTAL_WINDOW_BD = 1, REPORT_SIGNOFF_BD = 3;
export const REPORT_DUE_DAYS = 30;                   // D1-1-03 "within 30 days of completion"
export const INCOME_VARIANCE_TOLERANCE_BPS = 200;    // rule 4(c): > 2% of qualifying income
export const LARGE_DEPOSIT_PCT_OF_INCOME = 50;       // B3-4.2-02: deposit > 50% of monthly qualifying income
export const GIFT_FUNDS_TRIGGER_PCT = 50, DTI_TRIGGER_BPS = 4500, LTV_TRIGGER_X100 = 9500, CU_SCORE_TRIGGER = 2.5, VALUE_ACCEPTANCE_MAX_AGE_MONTHS = 4, VVOE_WINDOW_BD = 10;
export const POPULATION_CLOSING_WINDOW_DAYS = 10;    // rule 1: scheduled closing within 10 calendar days
export const SELECTION_TIME = "06:00";               // rule: 06:00 partner time zone

// ============================================================ data model (spec "Data model")
export type ReviewKind = "prefunding" | "post_closing_random" | "post_closing_discretionary" | "epd" | "fnma_lqc";
export type SelectionBasis = "random" | "risk_trigger" | "model_monitoring" | "channel_floor" | "fnma_request" | "discretionary_manual";
export type ReviewType = "full_file" | "component";
export const REVIEW_AREAS = ["aus_data", "ssn", "income", "employment_vvoe", "assets", "collateral", "mi", "occupancy", "compliance", "closing_docs", "fraud"] as const;
export type ReviewArea = (typeof REVIEW_AREAS)[number];
export const D1_2_01_AREAS: readonly ReviewArea[] = ["aus_data", "ssn", "income", "employment_vvoe", "assets", "collateral", "mi", "occupancy"];
export const ALWAYS_AREAS: readonly ReviewArea[] = ["aus_data", "ssn", "compliance", "fraud"];
export type ReviewStatus = "selected" | "in_review" | "awaiting_reverification" | "findings_drafted" | "officer_review" | "findings_released" | "rebuttal" | "closed" | "cancelled" | "unable_to_complete";
export const TERMINAL_STATUSES: readonly ReviewStatus[] = ["closed", "cancelled", "unable_to_complete"];
export type ReviewOutcome = "no_defect" | "defect_corrected" | "defect_uncorrected" | "cancelled" | "unable_to_complete";
export type FindingStatus = "draft" | "released" | "rebutted" | "corrected" | "sustained" | "withdrawn";
export type FindingCategory = "income_employment" | "assets" | "credit" | "liabilities" | "collateral" | "eligibility" | "data_integrity" | "legal_regulatory_compliance" | "insurance" | "closing_docs" | "identity_ssn" | "occupancy" | "fraud_misrepresentation";
export const FRAUD_FAMILY_CATEGORIES: readonly FindingCategory[] = ["fraud_misrepresentation", "identity_ssn", "occupancy"];
export type Resolution = "condition_reopened" | "decision_reversed" | "data_corrected" | "no_action_rebuttal_accepted" | "waived_by_officer";
export type QcPrefundingStatus = "not_selected" | "selected" | "in_review" | "hold" | "cleared" | "defect_open";
export type ReverificationKind = "ssn_cbsv" | "income_written" | "employment_verbal" | "employment_written" | "assets_written" | "tax_transcript" | "occupancy" | "appraisal_desk" | "appraisal_field" | "credit_refresh" | "title" | "mi" | "gift_donor" | "rent_landlord";
export type ReverificationResult = "match" | "variance" | "no_response" | "unable";
export type Severity = 1 | 2 | 3 | 4;
export interface EvidenceRef { readonly document_id: string; readonly page?: number | null; readonly extraction_id?: string | null; }

export interface QcReview {
  readonly review_id: string; readonly application_id: string; readonly loan_id: string | null; readonly partner_id: string;
  readonly kind: ReviewKind; readonly selection_basis: SelectionBasis; readonly selection_reason_codes: readonly string[]; readonly random_hit: boolean;
  readonly sample_plan_id: string; readonly review_type: ReviewType; readonly component_scope: readonly ReviewArea[];
  readonly status: ReviewStatus; readonly reviewer_agent_run_id: string | null; readonly qc_officer_id: string | null; readonly officer_signed_at: string | null;
  readonly selected_at: string; readonly due_at: PlainDate; readonly opened_at: string; readonly review_completed_at: string | null; readonly closed_at: string | null;
  readonly outcome: ReviewOutcome | null; readonly highest_severity: Severity | null;
  readonly production_hold_applied: boolean; readonly hold_id: string; readonly hold_released_at: string | null; readonly hold_released_by: string | null;
  readonly officer_sample: boolean; readonly finding_ids: readonly string[];
  readonly rule_set_version: string; readonly model_version: string | null; readonly prompt_version: string | null; readonly retention_class: typeof RETENTION_CLASS_QC;
}
export interface QcFinding {
  readonly finding_id: string; readonly review_id: string; readonly application_id: string;
  readonly category: FindingCategory; readonly sub_category: string; readonly defect_code: string; readonly severity: Severity; readonly description: string;
  readonly evidence_refs: readonly EvidenceRef[]; readonly observed_value: string | null; readonly expected_value: string | null;
  readonly guide_citation: string; readonly law_citation: string | null; readonly is_compliance: boolean;
  readonly status: FindingStatus; readonly recorded_at: string; readonly released_at: string | null;
  readonly rebuttal: { by_agent_run_id: string; text: string; evidence_refs: readonly EvidenceRef[]; at: string } | null;
  readonly resolution: Resolution | null; readonly resolution_ref: string | null; readonly resolved_at: string | null; readonly reviewed_by_qc_officer_at: string | null; readonly officer_decision: "released" | "withdrawn" | null;
}
export interface QcReverification {
  readonly reverification_id: string; readonly review_id: string; readonly application_id: string; readonly kind: ReverificationKind; readonly source: string;
  readonly requested_at: string; readonly request_dates: readonly PlainDate[]; readonly response_due_at: PlainDate; readonly escalate_at: PlainDate; readonly received_at: string | null;
  readonly result: ReverificationResult | null; readonly variance: Record<string, unknown> | null; readonly document_id: string | null; readonly purpose_code: "qc_prefunding" | "qc_post_closing"; readonly fee_cents: Cents;
  readonly officer_decision: "unable_to_complete" | "keep_hold" | null;
}
export interface Stratum { readonly key: string; readonly volume: number; }
export interface QcSamplePlan {
  readonly sample_plan_id: string; readonly partner_id: string; readonly kind: "prefunding" | "post_closing"; readonly period_month: PlainDate;
  readonly eligible_population: number; readonly forecast_closings: number; readonly random_target: number; readonly random_method: "uniform" | "stratified_channel";
  readonly strata: readonly { key: string; volume: number; quota: number }[]; readonly risk_trigger_set_version: string; readonly planned_at: string; readonly approved_by_qc_officer_at: string | null;
  readonly actuals: { selected: number; random_selected: number; reviewed: number; pct_of_eligible: number };
}
export interface CorrectiveActionPlan { readonly trend: string; readonly action: string; readonly owner: string; readonly expected_resolution: string; readonly due_date: PlainDate; readonly status: "open" | "completed"; readonly tracker: typeof SENTINEL; }
export interface QcReport {
  readonly report_id: string; readonly partner_id: string; readonly kind: "prefunding_monthly" | "qc_audit_annual"; readonly period: string; readonly sample_plan_id: string | null;
  readonly metrics: MonthlyMetrics | Record<string, unknown>; readonly trend: readonly MonthlyMetrics[]; readonly trend_window_months: number; readonly sample_description: string;
  readonly issued_at: string; readonly due_at: PlainDate | null; readonly issued_late: boolean; readonly signed_by_qc_officer_at: string | null; readonly acknowledged_by_management_at: string | null;
  readonly corrective_action_plans: readonly CorrectiveActionPlan[]; readonly content_document_id: string | null; readonly retention_class: typeof RETENTION_CLASS_QC;
}

export class QcRefused extends Error {
  readonly code: string; readonly citation: string;
  constructor(code: string, citation: string, why: string) { super(`28.1 refused [${code}]: ${why}`); this.name = "QcRefused"; this.code = code; this.citation = citation; }
}
const need = (ok: boolean, why: string): void => { if (!ok) throw new RangeError(why); };
const nonEmpty = (v: unknown, name: string): void => need(typeof v === "string" && v.length > 0, `${name} is required`);
const emit = (events: EventStore, application_id: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor): DomainEvent =>
  events.append({ type, applicationId: application_id, aggregate: { kind: "application", id: application_id }, actor, occurredAt: at, payload: { application_id, ...payload } });
const emitProgram = (events: EventStore, aggregate: { kind: string; id: string }, type: string, payload: Record<string, unknown>, at: string, actor: Actor): DomainEvent =>
  events.append({ type, aggregate, actor, occurredAt: at, payload: { source: "origination", ...payload } });
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const isQcAgent = (a: Actor): boolean => a.kind === "agent" && a.id === QC_AGENT_ID;
export const isQcOfficer = (a: Actor): boolean => a.kind === "human" && a.role === "qc_officer";
const isQcIdentity = (a: Actor): boolean => isQcAgent(a) || isQcOfficer(a);
const dateOf = (iso: string): PlainDate => D(iso.slice(0, 10));
const pct1 = (num: number, den: number): number => (den === 0 ? 0 : Math.round((num / den) * 1000) / 10);
const bps = (num: bigint, den: bigint): number => (den === 0n ? 0 : Number((num * 10000n) / den));

/** Independence is enforced by identity: a production agent or a human without the `qc_officer` role never writes QC records (D1-2-01; guardrails). Logged sev 2 to compliance-sentinel. */
export function assertQcIdentity(escalations: EscalationService | null, actor: Actor, command: string, application_id: string | null): void {
  if (isQcIdentity(actor)) return;
  escalations?.open({ kind: "sev2", ownerRole: "compliance_sentinel", ...(application_id ? { applicationId: application_id } : {}), severity: "sev2", payload: { route: SENTINEL, command, actor: `${actor.kind}:${actor.id}`, reason: "production identity attempted a QC record write", rule: "28.1 guardrails / D1-2-01 independence" } }, actor);
  throw new QcRefused("QC_IDENTITY_REQUIRED", "28.1 guardrails: independence is enforced by identity (`agent_id = qc-audit`), database roles and a deployment boundary; production agents never touch QC records", `${command} attempted by ${actor.kind}:${actor.id}`);
}
/** The mirror image: the QC identity never calls a production command (`clearCondition`, `openCondition`, `issueClearToClose`, …). Logged sev 2 to compliance-sentinel. */
export const PRODUCTION_COMMANDS = ["clearCondition", "openCondition", "waiveCondition", "issueClearToClose", "issueConditionalApproval", "authorizeFunding", "consummate", "issueCD"] as const;
export function assertNotProductionCommand(escalations: EscalationService | null, actor: Actor, command: string, application_id: string | null): void {
  if (!isQcIdentity(actor) || !(PRODUCTION_COMMANDS as readonly string[]).includes(command)) return;
  escalations?.open({ kind: "sev2", ownerRole: "compliance_sentinel", ...(application_id ? { applicationId: application_id } : {}), severity: "sev2", payload: { route: SENTINEL, command, actor: `${actor.kind}:${actor.id}`, reason: "QC identity attempted a production command", rule: "28.1 guardrails: never clears or opens a production condition directly" } }, actor);
  throw new QcRefused("QC_NEVER_CALLS_PRODUCTION", "28.1 guardrails / integrations: production reacts to `qc.finding.released` through 23.3 — QC never calls production commands", `${command} attempted by ${actor.kind}:${actor.id}`);
}

// ============================================================ rule 1 — population and eligibility
export interface PopulationCandidate {
  readonly application_id: string; readonly disposition: string; readonly ptd_cleared_at: string | null; readonly closing_scheduled_on: PlainDate | null;
  readonly already_selected: boolean; readonly withdrawn_or_denied?: boolean; readonly channel: string; readonly transaction_type: string; readonly occupancy: string;
}
export interface PopulationRow { readonly application_id: string; readonly reason: "ptd_cleared_24h" | "closing_within_10d"; readonly stratum: string; }
/** Every application at `ptd_cleared` in the last 24 hours or with a closing scheduled within 10 calendar days, never re-selected; denied/withdrawn leave the population. */
export function buildPopulation(candidates: readonly PopulationCandidate[], run_at: string): { population: PopulationRow[]; excluded: { application_id: string; why: string }[]; run_at: string } {
  const runMs = Date.parse(run_at); const today = dateOf(run_at);
  const population: PopulationRow[] = [], excluded: { application_id: string; why: string }[] = [];
  for (const c of candidates) {
    if (c.withdrawn_or_denied) { excluded.push({ application_id: c.application_id, why: "withdrawn_or_denied" }); continue; }
    if (!["conditional_approval", "approved"].includes(c.disposition)) { excluded.push({ application_id: c.application_id, why: `disposition ${c.disposition}` }); continue; }
    if (c.already_selected) { excluded.push({ application_id: c.application_id, why: "already_selected" }); continue; }
    const ptdRecent = c.ptd_cleared_at !== null && runMs - Date.parse(c.ptd_cleared_at) <= 86_400_000 && Date.parse(c.ptd_cleared_at) <= runMs;
    const closingSoon = c.closing_scheduled_on !== null && daysBetween(today, c.closing_scheduled_on) <= POPULATION_CLOSING_WINDOW_DAYS && daysBetween(today, c.closing_scheduled_on) >= 0;
    if (!ptdRecent && !closingSoon) { excluded.push({ application_id: c.application_id, why: "ptd_cleared not in last 24h and no closing within 10 days" }); continue; }
    population.push({ application_id: c.application_id, reason: ptdRecent ? "ptd_cleared_24h" : "closing_within_10d", stratum: stratumKey(c) });
  }
  return { population, excluded, run_at };
}
export const stratumKey = (c: { channel: string; transaction_type: string; occupancy: string }): string => `${c.channel}|${c.transaction_type}|${c.occupancy}`;

// ============================================================ rule 2 — sample design
/** `random_target = max(ceil(0.05 × forecast_closings_month), 10)` (28.1-Q1; no Guide minimum since SEL-2026-03). */
export function randomTarget(forecast_closings_month: number, imposed_floor = 0): number {
  need(Number.isInteger(forecast_closings_month) && forecast_closings_month >= 0, "forecast_closings_month must be a non-negative integer");
  return Math.max(Math.ceil((forecast_closings_month * RANDOM_TARGET_RATE_BPS) / 10000), RANDOM_TARGET_FLOOR, imposed_floor);
}
/** Proportional allocation across strata with at least one selection per stratum with volume ("selections from each of the lender's production channels"). */
export function allocateStrata(target: number, strata: readonly Stratum[]): { key: string; volume: number; quota: number }[] {
  const live = strata.filter((s) => s.volume > 0); const total = live.reduce((a, s) => a + s.volume, 0);
  if (!live.length || target <= 0) return strata.map((s) => ({ ...s, quota: 0 }));
  const raw = live.map((s) => ({ ...s, exact: (target * s.volume) / total }));
  const quotas = raw.map((s) => ({ key: s.key, volume: s.volume, quota: Math.max(1, Math.floor(s.exact)), rem: s.exact - Math.floor(s.exact) }));
  let left = target - quotas.reduce((a, q) => a + q.quota, 0);
  for (const q of [...quotas].sort((a, b) => b.rem - a.rem)) { if (left <= 0) break; q.quota += 1; left -= 1; }
  // the ≥ 1 floor can over-allocate a small target: take the excess back from the largest quotas (never below 1)
  while (left < 0) { const big = [...quotas].filter((q) => q.quota > 1).sort((a, b) => b.quota - a.quota)[0]; if (!big) break; big.quota -= 1; left += 1; }
  return strata.map((s) => { const q = quotas.find((x) => x.key === s.key); return { key: s.key, volume: s.volume, quota: q ? q.quota : 0 }; });
}
export interface PlanInput { readonly sample_plan_id?: string; readonly partner_id: string; readonly period_month: PlainDate; readonly eligible_population: number; readonly forecast_closings_month: number; readonly strata: readonly Stratum[]; readonly imposed_floor?: number; readonly at: string; readonly approved_by_qc_officer_at?: string | null; }
/** The monthly `qc_sample_plans` row (first calendar day of the month, from the prior month's eligible population and the current forecast). Emits `qc.sample.planned`. */
export function planSample(events: EventStore, i: PlanInput, actor: Actor = QC_AGENT): { plan: QcSamplePlan; event: DomainEvent } {
  nonEmpty(i.partner_id, "partner_id"); nonEmpty(i.period_month, "period_month"); nonEmpty(i.at, "at");
  const target = randomTarget(i.forecast_closings_month, i.imposed_floor ?? 0);
  const plan: QcSamplePlan = { sample_plan_id: i.sample_plan_id ?? `qcsp:${i.partner_id}:${i.period_month.slice(0, 7)}`, partner_id: i.partner_id, kind: "prefunding", period_month: startOfMonth(i.period_month), eligible_population: i.eligible_population, forecast_closings: i.forecast_closings_month,
    random_target: target, random_method: i.strata.length > 1 ? "stratified_channel" : "uniform", strata: allocateStrata(target, i.strata), risk_trigger_set_version: RULE_SETS_28_1["fnma.qc.plan"], planned_at: i.at, approved_by_qc_officer_at: i.approved_by_qc_officer_at ?? null, actuals: { selected: 0, random_selected: 0, reviewed: 0, pct_of_eligible: 0 } };
  const event = emitProgram(events, { kind: "qc_sample_plan", id: plan.sample_plan_id }, "qc.sample.planned", { sample_plan_id: plan.sample_plan_id, partner_id: plan.partner_id, kind: "prefunding", period_month: plan.period_month, random_target: target, eligible_population: plan.eligible_population, strata: plan.strata, actuals: plan.actuals }, i.at, actor);
  return { plan, event };
}
/** Acceptance probability of the daily draw: `random_target_remaining / expected_remaining_population` (7 / 96 → 0.073), so the target is met evenly through the month. */
export function acceptanceProbability(random_target_remaining: number, expected_remaining_population: number): number {
  if (random_target_remaining <= 0) return 0;
  if (expected_remaining_population <= 0) return 1;
  return Math.min(1, Math.round((random_target_remaining / expected_remaining_population) * 1000) / 1000);
}
/** Seeded uniform draw in [0, 1): an examiner regenerates it from the recorded seed and application id. */
export function seededUniform(seed: string, application_id: string): number { return parseInt(sha256(`${seed}:${application_id}`).slice(0, 8), 16) / 4294967296; }

export interface RiskFeatures {
  readonly du_red_flag_message?: boolean; readonly document_integrity_warning_unresolved?: boolean; readonly credit_alerts?: readonly string[];
  readonly self_employed_income_variance_bps?: number | null; readonly large_deposit_cleared_by_human_override?: boolean; readonly gift_funds_pct_of_funds_to_close?: number | null;
  readonly dti_bps?: number; readonly ltv_x100?: number; readonly transaction_type?: string; readonly occupancy?: string; readonly existing_primary_within_50_miles?: boolean;
  readonly property_type?: string; readonly non_arms_length?: boolean; readonly human_override_escalations?: number; readonly production_model_changed_within_90d?: boolean;
  readonly appraiser_first_seen_within_90d?: boolean; readonly settlement_agent_first_seen_within_90d?: boolean; readonly vantagescore_4_first_6_months?: boolean;
  readonly tx_50a6?: boolean; readonly ny_cema?: boolean; readonly temporary_buydown?: boolean; readonly community_seconds?: boolean;
}
export interface RiskTrigger { readonly code: string; readonly area: ReviewArea; readonly fraud_family: boolean; readonly basis: SelectionBasis; }
/** Rule 2's risk-trigger component — every hit is selected; fraud-family hits get a full-file review (rule 3). */
export function riskTriggers(f: RiskFeatures): RiskTrigger[] {
  const t: RiskTrigger[] = [];
  const add = (code: string, area: ReviewArea, fraud_family: boolean, basis: SelectionBasis = "risk_trigger") => t.push({ code, area, fraud_family, basis });
  if (f.du_red_flag_message) add("du_red_flag_message", "aus_data", true);
  if (f.document_integrity_warning_unresolved) add("document_integrity_warning", "fraud", true);
  for (const a of f.credit_alerts ?? []) add(`credit_alert:${a}`, "ssn", true);
  if ((f.self_employed_income_variance_bps ?? 0) > 500) add("self_employed_income_variance_gt_5pct", "income", false);
  if (f.large_deposit_cleared_by_human_override) add("large_deposit_human_override", "assets", true);
  if ((f.gift_funds_pct_of_funds_to_close ?? 0) > GIFT_FUNDS_TRIGGER_PCT) add("gift_funds_pct_gt_50", "assets", true);
  if ((f.dti_bps ?? 0) >= DTI_TRIGGER_BPS) add("dti_ge_45", "income", false);
  if ((f.ltv_x100 ?? 0) > LTV_TRIGGER_X100) add("ltv_gt_95", "collateral", false);
  if (f.transaction_type === "cash_out") add("cash_out", "assets", false);
  if ((f.occupancy === "second_home" || f.occupancy === "investment") && f.existing_primary_within_50_miles) add("occupancy_near_existing_primary", "occupancy", true);
  if (f.property_type && ["condo", "manufactured", "2_4_units"].includes(f.property_type)) add(`property_type:${f.property_type}`, "collateral", false);
  if (f.non_arms_length) add("non_arms_length", "fraud", true);
  if ((f.human_override_escalations ?? 0) >= 1) add("human_override_of_agent_decision", "compliance", false);
  if (f.production_model_changed_within_90d) add("model_monitoring_90d", "aus_data", false, "model_monitoring");
  if (f.appraiser_first_seen_within_90d) add("appraiser_first_seen_90d", "collateral", true);
  if (f.settlement_agent_first_seen_within_90d) add("settlement_agent_first_seen_90d", "closing_docs", true);
  if (f.vantagescore_4_first_6_months) add("vantagescore_4_first_6_months", "aus_data", false);
  if (f.tx_50a6) add("tx_50a6", "compliance", false);
  if (f.ny_cema) add("ny_cema", "compliance", false);
  if (f.temporary_buydown) add("temporary_buydown", "compliance", false);
  if (f.community_seconds) add("community_seconds", "compliance", false);
  return t;
}
/** Rule 3: random and fraud-family → full_file; other triggers → component scoped to the trigger areas plus `aus_data` and `ssn`. */
export function reviewScope(basis: SelectionBasis, triggers: readonly RiskTrigger[]): { review_type: ReviewType; component_scope: ReviewArea[] } {
  if (basis === "random" || triggers.some((t) => t.fraud_family)) return { review_type: "full_file", component_scope: [...REVIEW_AREAS] };
  const scope = new Set<ReviewArea>(["aus_data", "ssn", ...triggers.map((t) => t.area)]);
  return { review_type: "component", component_scope: REVIEW_AREAS.filter((a) => scope.has(a)) };
}

export interface SelectInput {
  readonly plan: QcSamplePlan; readonly application_id: string; readonly partner_id?: string; readonly features: RiskFeatures; readonly at: string;
  readonly random_target_remaining: number; readonly expected_remaining_population: number; readonly draw?: number; readonly seed?: string; readonly review_id?: string; readonly calendar?: Calendar; readonly manual_basis?: "fnma_request" | "discretionary_manual" | null;
}
export interface SelectResult { readonly selected: boolean; readonly basis: SelectionBasis | null; readonly probability: number; readonly draw: number; readonly random_hit: boolean; readonly triggers: RiskTrigger[]; readonly review: QcReview | null; readonly events: DomainEvent[]; readonly application_qc_status: QcPrefundingStatus; }
/**
 * The daily draw for one application: a trigger hit is `risk_trigger` (with `random_hit` when the draw also accepts, so random statistics stay unbiased); a
 * pure random accept is `random`. A selection creates the `qc_reviews{selected}` row with `production_hold_applied = true`, emits `qc.hold.applied{kind=prefunding}`,
 * `qc.review.opened{kind=prefunding}` (23.3 asserts the gate) and `qc.review.selected{basis}` (arms SM_QC_PREFUNDING_REVIEW_SLA_2BD, due +2 `business_days_creditor`).
 */
export function selectLoan(events: EventStore, i: SelectInput, actor: Actor = QC_AGENT): SelectResult {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.at, "at"); need(!!i.plan, "plan (planSample first)");
  assertNoDemographics(i.features, "features");
  const triggers = riskTriggers(i.features);
  const probability = acceptanceProbability(i.random_target_remaining, i.expected_remaining_population);
  const draw = i.draw ?? seededUniform(i.seed ?? i.plan.sample_plan_id, i.application_id);
  const random_hit = draw < probability;
  const basis: SelectionBasis | null = i.manual_basis ?? (triggers.length ? (triggers.every((t) => t.basis === "model_monitoring") ? "model_monitoring" : "risk_trigger") : random_hit ? "random" : null);
  if (basis === null) return { selected: false, basis: null, probability, draw, random_hit, triggers, review: null, events: [], application_qc_status: "not_selected" };
  const scope = reviewScope(basis, triggers);
  const cal = i.calendar ?? creditor; const selected_on = dateOf(i.at);
  const review_id = i.review_id ?? `qcr:${i.application_id}:${selected_on}`;
  const review: QcReview = { review_id, application_id: i.application_id, loan_id: null, partner_id: i.partner_id ?? i.plan.partner_id, kind: "prefunding", selection_basis: basis, selection_reason_codes: triggers.map((t) => t.code), random_hit,
    sample_plan_id: i.plan.sample_plan_id, review_type: scope.review_type, component_scope: scope.component_scope, status: "selected", reviewer_agent_run_id: null, qc_officer_id: null, officer_signed_at: null,
    selected_at: i.at, due_at: addBusinessDays(selected_on, REVIEW_SLA_BD, cal), opened_at: i.at, review_completed_at: null, closed_at: null, outcome: null, highest_severity: null,
    production_hold_applied: true, hold_id: `qch:${review_id}`, hold_released_at: null, hold_released_by: null, officer_sample: false, finding_ids: [], rule_set_version: RULE_SET_VERSION_28_1, model_version: null, prompt_version: null, retention_class: RETENTION_CLASS_QC };
  const out: DomainEvent[] = [];
  out.push(emit(events, i.application_id, "qc.hold.applied", { review_id, hold_id: review.hold_id, kind: "prefunding", reason: "selected_for_prefunding_qc", ctc_item: "CTC_QC_PREFUNDING", item_alias: "SM_QC_PREFUNDING_HOLD" }, i.at, actor));
  out.push(emit(events, i.application_id, "qc.review.opened", { review_id, kind: "prefunding", selected_on, review_type: review.review_type, gate: "FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE" }, i.at, actor));
  out.push(emit(events, i.application_id, "qc.review.selected", { review_id, basis, selection_reason_codes: review.selection_reason_codes, random_hit, review_type: review.review_type, component_scope: review.component_scope, selected_at: i.at, due_at: review.due_at, probability, draw: Math.round(draw * 1000) / 1000, sample_plan_id: i.plan.sample_plan_id }, i.at, actor));
  return { selected: true, basis, probability, draw, random_hit, triggers, review, events: out, application_qc_status: "hold" };
}
/** The end of a selection run: the plan's actuals are updated and `qc.sample.planned` re-emitted (satisfies SM_QC_PREFUNDING_SELECTION_DAILY; a missed run is the breach). */
export function recordSelectionRun(events: EventStore, plan: QcSamplePlan, i: { selected: number; random_selected: number; reviewed: number; at: string }, actor: Actor = QC_AGENT): { plan: QcSamplePlan; event: DomainEvent } {
  const actuals = { selected: plan.actuals.selected + i.selected, random_selected: plan.actuals.random_selected + i.random_selected, reviewed: plan.actuals.reviewed + i.reviewed, pct_of_eligible: pct1(plan.actuals.reviewed + i.reviewed, plan.eligible_population) };
  const next: QcSamplePlan = { ...plan, actuals };
  // subject = the partner's QC program, the subject the 06:00 `schedule.tick` armed SM_QC_PREFUNDING_SELECTION_DAILY on
  return { plan: next, event: emitProgram(events, { kind: "qc_program", id: plan.partner_id }, "qc.sample.planned", { sample_plan_id: plan.sample_plan_id, kind: "prefunding", period_month: plan.period_month, random_target: plan.random_target, actuals, run_completed_at: i.at }, i.at, actor) };
}
/** The 06:00 partner-time-zone scheduler tick that arms the daily selection row. */
export function dailySelectionTick(events: EventStore, i: { date: PlainDate; partner_id: string; time_zone: string }, actor: Actor = { kind: "system", id: "scheduler" }): DomainEvent {
  const at = new Date(zonedEpochMs(i.date, SELECTION_TIME, i.time_zone)).toISOString();
  return events.append({ type: "schedule.tick", aggregate: { kind: "qc_program", id: i.partner_id }, actor, occurredAt: at, payload: { cadence: "daily", at: SELECTION_TIME, tz: i.time_zone, job: "qc_prefunding_selection", date: i.date, source: "origination" } });
}
/** The Jan 15 (policy) tick for the annual QC-process audit (D1-1-01 "an audit process"; frequency unstated — 28.1-Q7). */
export function annualAuditTick(events: EventStore, i: { year: number; partner_id: string; time_zone: string }, actor: Actor = { kind: "system", id: "scheduler" }): DomainEvent {
  const date = D(`${i.year}-01-15`);
  return events.append({ type: "schedule.tick", aggregate: { kind: "qc_program", id: i.partner_id }, actor, occurredAt: new Date(zonedEpochMs(date, "06:00", i.time_zone)).toISOString(), payload: { cadence: "annual", at: "06:00", tz: i.time_zone, job: "qc_process_audit", date, source: "origination" } });
}

/** `applications.qc_prefunding_status` — denormalized for 23.3's CTC checklist. */
export function qcPrefundingStatus(review: QcReview | null, findings: readonly QcFinding[] = []): QcPrefundingStatus {
  if (!review) return "not_selected";
  const openDefect = findings.some((f) => f.review_id === review.review_id && f.severity <= 2 && ["released", "rebutted", "sustained"].includes(f.status));
  switch (review.status) {
    case "selected": return review.production_hold_applied ? "hold" : "selected";
    case "in_review": case "awaiting_reverification": case "findings_drafted": case "officer_review": return openDefect ? "defect_open" : "in_review";
    case "findings_released": case "rebuttal": return openDefect ? "defect_open" : "in_review";
    case "closed": return review.outcome === "defect_uncorrected" ? "defect_open" : "cleared";
    case "unable_to_complete": return "cleared";
    case "cancelled": return "not_selected";
  }
}
/** The gate as 28.1 states it, in 23.3's vocabulary: open iff `status ∈ {closed{no_defect, defect_corrected}, unable_to_complete}` (or no review). */
export function reviewGateStatus(review: QcReview | null, findings: readonly QcFinding[] = []): PrefundingReviewStatus | null {
  if (!review) return null;
  if (review.status === "unable_to_complete") return "unable_to_complete";
  if (review.status === "closed") return review.outcome === "no_defect" ? "closed_no_defect" : review.outcome === "defect_corrected" ? "closed_defect_corrected" : "defect_open";
  if (review.status === "cancelled") return null;
  return qcPrefundingStatus(review, findings) === "defect_open" ? "defect_open" : "open";
}
export function assertGateOpen(review: QcReview | null, findings: readonly QcFinding[] = [], command = "clear_to_close"): GateResult { return prefundingQcGate({ review_status: reviewGateStatus(review, findings), command }); }
export { prefundingReviewStatus };

// ============================================================ state machine — open / complete / close
export interface OpenReviewInput { readonly run: { run_id: string; model_version: string; prompt_version: string }; readonly reviewer: Actor; readonly application_agent_runs: readonly { agent_id: string; run_id?: string }[]; readonly at: string; }
/** `selected → in_review`: only the `qc-audit` identity (or a `qc_officer` on the manual path), and no `agent_runs` row on the reviewed application carries the QC deployment's identity (D1-2-01 "no involvement in the origination, processing or underwriting functions of the loan"). */
export function openReview(events: EventStore, escalations: EscalationService | null, review: QcReview, i: OpenReviewInput): { review: QcReview; event: DomainEvent } {
  need(review.status === "selected", `${review.review_id} is ${review.status}, not selected`); nonEmpty(i.at, "at"); nonEmpty(i.run?.run_id, "run.run_id");
  assertQcIdentity(escalations, i.reviewer, "openReview", review.application_id);
  const involved = i.application_agent_runs.filter((r) => r.agent_id === QC_AGENT_ID);
  if (involved.length) throw new QcRefused("REVIEWER_INVOLVED_IN_LOAN", "D1-2-01: prefunding QC is conducted by individuals with no involvement in the origination, processing or underwriting of the loan being reviewed", `${involved.length} agent_runs row(s) on ${review.application_id} carry the QC identity`);
  const next: QcReview = { ...review, status: "in_review", reviewer_agent_run_id: i.run.run_id, model_version: i.run.model_version, prompt_version: i.run.prompt_version };
  return { review: next, event: emit(events, review.application_id, "qc.review.started", { review_id: review.review_id, reviewer_agent_run_id: i.run.run_id, reviewer: `${i.reviewer.kind}:${i.reviewer.id}`, review_type: review.review_type, component_scope: review.component_scope }, i.at, i.reviewer) };
}
/** `review_completed_at` set (findings drafted or no defect) — satisfies SM_QC_PREFUNDING_REVIEW_SLA_2BD. Within SLA iff the completion date ≤ `due_at`. */
export function completeReview(events: EventStore, review: QcReview, findings: readonly QcFinding[], at: string, actor: Actor = QC_AGENT): { review: QcReview; within_sla: boolean; event: DomainEvent } {
  need(["in_review", "awaiting_reverification"].includes(review.status), `${review.review_id} is ${review.status}`);
  const mine = findings.filter((f) => f.review_id === review.review_id && f.status !== "withdrawn");
  const highest = mine.length ? (Math.min(...mine.map((f) => f.severity)) as Severity) : null;
  const next: QcReview = { ...review, status: "findings_drafted", review_completed_at: at, highest_severity: highest, finding_ids: mine.map((f) => f.finding_id) };
  const within_sla = dateOf(at) <= review.due_at;
  return { review: next, within_sla, event: emit(events, review.application_id, "qc.review.completed", { review_id: review.review_id, review_completed_at: at, findings: mine.length, highest_severity: highest, within_sla, due_at: review.due_at }, at, actor) };
}
export interface CloseInput { readonly outcome: ReviewOutcome; readonly at: string; readonly actor: Actor; readonly rationale?: string | null; }
/**
 * `closed{no_defect | defect_corrected}` releases the hold; `defect_uncorrected` keeps it (23.3 `decision.reopened` / 21.6); `unable_to_complete` only by the officer; `cancelled` on withdrawal/denial.
 * The agent alone may close `no_defect` only when no severity ≤ 2 finding exists and the review is not in the officer's sample (rule 5/6). A production identity is refused and logged (T6).
 */
export function closeReview(events: EventStore, escalations: EscalationService | null, review: QcReview, findings: readonly QcFinding[], i: CloseInput): { review: QcReview; events: DomainEvent[]; application_qc_status: QcPrefundingStatus } {
  nonEmpty(i.at, "at"); need(!TERMINAL_STATUSES.includes(review.status), `${review.review_id} is already ${review.status}`);
  assertQcIdentity(escalations, i.actor, "closeReview", review.application_id);
  const mine = findings.filter((f) => f.review_id === review.review_id);
  const openSev12 = mine.filter((f) => f.severity <= 2 && !["corrected", "withdrawn"].includes(f.status));
  const anySev12 = mine.filter((f) => f.severity <= 2 && f.status !== "withdrawn");
  const officer = isQcOfficer(i.actor);
  if (i.outcome === "no_defect") {
    if (anySev12.length) throw new QcRefused("NO_DEFECT_WITH_SEV12_FINDING", "28.1 rule 5: `hold_released` requires no open severity-1/2 finding — a review with a severity ≤ 2 finding closes `defect_corrected` or `defect_uncorrected`", anySev12.map((f) => f.finding_id).join(", "));
    if (review.officer_sample && !officer) throw new QcRefused("NO_DEFECT_IN_OFFICER_SAMPLE_NEEDS_OFFICER", "28.1 rule 6: the `qc_officer` reviews the sampled no-defect conclusions; the agent may close `no_defect` alone only outside the sample", review.review_id);
  }
  if (i.outcome === "defect_corrected" && openSev12.length) throw new QcRefused("DEFECTS_STILL_OPEN", "28.1 state machine: `closed{defect_corrected}` requires every severity-1/2 finding `corrected` (re-tested) or `withdrawn`", openSev12.map((f) => `${f.finding_id}:${f.status}`).join(", "));
  if (i.outcome === "defect_corrected" && !anySev12.length && !mine.some((f) => f.status === "corrected")) throw new QcRefused("NOTHING_CORRECTED", "28.1 state machine: `defect_corrected` follows a corrected finding; a clean review closes `no_defect`", review.review_id);
  if (i.outcome === "unable_to_complete" && !officer) throw new QcRefused("UNABLE_TO_COMPLETE_NEEDS_OFFICER", "28.1 state machine / 28.1-Q5: `unable_to_complete` — the hold is released only by the `qc_officer` who accepts the documentation of the attempt", `${i.actor.kind}:${i.actor.id}`);
  const releases = i.outcome === "no_defect" || i.outcome === "defect_corrected" || i.outcome === "unable_to_complete";
  const status: ReviewStatus = i.outcome === "cancelled" ? "cancelled" : i.outcome === "unable_to_complete" ? "unable_to_complete" : "closed";
  const highest = mine.filter((f) => f.status !== "withdrawn").length ? (Math.min(...mine.filter((f) => f.status !== "withdrawn").map((f) => f.severity)) as Severity) : null;
  const next: QcReview = { ...review, status, outcome: i.outcome, closed_at: i.at, review_completed_at: review.review_completed_at ?? i.at, highest_severity: highest, hold_released_at: releases ? i.at : review.hold_released_at, hold_released_by: releases ? `${i.actor.kind}:${i.actor.id}` : review.hold_released_by, ...(officer ? { qc_officer_id: i.actor.id, officer_signed_at: i.at } : {}) };
  const out: DomainEvent[] = [];
  out.push(emit(events, review.application_id, "qc.review.closed", { review_id: review.review_id, kind: review.kind, outcome: i.outcome, defects_open: i.outcome === "defect_uncorrected", highest_severity: highest, closed_at: i.at, hold_released: releases, closed_by: `${i.actor.kind}:${i.actor.id}`, rationale: i.rationale ?? null, gate: "FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE" }, i.at, i.actor));
  if (releases) out.push(emit(events, review.application_id, "qc.hold.released", { review_id: review.review_id, hold_id: review.hold_id, kind: "prefunding", outcome: i.outcome, released_by: `${i.actor.kind}:${i.actor.id}`, released_at: i.at, ctc_item: "CTC_QC_PREFUNDING" }, i.at, i.actor));
  return { review: next, events: out, application_qc_status: qcPrefundingStatus(next, findings) };
}
/** A closing consummated with the gate closed (bypass or wet-closing race): `qc.breach.closed_with_open_review` sev 1 → `qc_officer` + partner `officer`; the review continues as 28.2's post-closing discretionary review. */
export function consummatedWithOpenReview(events: EventStore, escalations: EscalationService, review: QcReview, i: { consummated_at: string; at: string }, actor: Actor = QC_AGENT): { breach: boolean; review: QcReview; escalations: Escalation[]; event: DomainEvent | null } {
  if (TERMINAL_STATUSES.includes(review.status) && review.outcome !== "defect_uncorrected") return { breach: false, review, escalations: [], event: null };
  const gate = assertGateOpen(review, [], "consummate");
  const payload = { review_id: review.review_id, status: review.status, gate: "FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE", blocking_codes: gate.blocking_codes, consummated_at: i.consummated_at, continues_as: "post_closing_discretionary", downstream: ["29.3 submitDelivery reads deliveryGateFacts", "28.2 discretionary sample"] };
  const e1 = escalations.open({ kind: "qc_officer", applicationId: review.application_id, severity: "sev1", payload }, actor);
  const e2 = escalations.open({ kind: "officer", applicationId: review.application_id, severity: "sev1", payload: { ...payload, audience: "partner officer" } }, actor);
  const next: QcReview = { ...review, kind: "post_closing_discretionary" };
  return { breach: true, review: next, escalations: [e1, e2], event: emit(events, review.application_id, "qc.breach.closed_with_open_review", { ...payload, severity: 1, escalation_ids: [e1.id, e2.id] }, i.at, actor) };
}
/** 29.3's delivery gate reads the sustained-finding state: a sustained (or still-open) severity-1 finding blocks `submitDelivery` until corrected. */
export function deliveryGateFacts(review: QcReview, findings: readonly QcFinding[]): { review_id: string; review_kind: ReviewKind; review_status: ReviewStatus; sustained_severity_1_open: boolean; open_finding_ids: string[]; blocks_submit_delivery: boolean } {
  const open = findings.filter((f) => f.review_id === review.review_id && f.severity === 1 && ["released", "rebutted", "sustained"].includes(f.status));
  return { review_id: review.review_id, review_kind: review.kind, review_status: review.status, sustained_severity_1_open: open.length > 0, open_finding_ids: open.map((f) => f.finding_id), blocks_submit_delivery: open.length > 0 };
}
/** Application withdrawn/denied during review → `cancelled`; the partial review is kept and counted as cancelled, not in the defect-rate denominator. */
export function cancelReview(events: EventStore, review: QcReview, i: { reason: "withdrawn" | "denied" | "expired"; at: string }, actor: Actor = QC_AGENT): { review: QcReview; event: DomainEvent } {
  need(!TERMINAL_STATUSES.includes(review.status), `${review.review_id} is ${review.status}`);
  const next: QcReview = { ...review, status: "cancelled", outcome: "cancelled", closed_at: i.at };
  return { review: next, event: emit(events, review.application_id, "qc.review.closed", { review_id: review.review_id, kind: review.kind, outcome: "cancelled", defects_open: false, reason: i.reason, closed_at: i.at, hold_released: false }, i.at, actor) };
}

// ============================================================ rule 4 — the full-file checklist (D1-2-01's eight areas, executable)
export interface ChecklistTest { readonly test_id: string; readonly area: ReviewArea; readonly observed: string; readonly expected: string; readonly result: "pass" | "fail" | "scheduled" | "na"; readonly evidence_refs: readonly EvidenceRef[]; readonly finding: FindingDraft | null; }
export interface FindingDraft { readonly category: FindingCategory; readonly sub_category: string; readonly severity: Severity; readonly description: string; readonly observed_value: string | null; readonly expected_value: string | null; readonly guide_citation: string; readonly law_citation?: string | null; readonly is_compliance?: boolean; readonly evidence_refs: readonly EvidenceRef[]; readonly data_correction?: Record<string, unknown> | null; }
export const money = (c: Cents): string => { const neg = c < 0n; const a = neg ? -c : c; const d = a / 100n, r = a % 100n; return `${neg ? "-" : ""}$${d.toLocaleString("en-US")}.${r.toString().padStart(2, "0")}`; };
/** Signed variance in basis points of the DU / underwriter figure: (recomputed − stated) / stated. */
export const varianceBps = (stated: Cents, recomputed: Cents): number => bps(recomputed - stated, stated);
/** One-decimal percent for the finding text (−6.4% on $14,850.00 → $13,900.00); display only — money stays bigint. */
export const variancePct = (stated: Cents, recomputed: Cents): string => { const v = Math.round(varianceBps(stated, recomputed) / 10) / 10; return `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toFixed(1)}%`; };

export interface DuInputsInput { readonly du_request: Record<string, string | number | bigint | boolean | null>; readonly recomputed: Record<string, string | number | bigint | boolean | null>; readonly evidence_refs: readonly EvidenceRef[]; readonly du_request_date?: PlainDate | null; readonly monthly_debts_cents?: Cents | null; }
/**
 * (a) `aus_data`: every DU input recomputed from the `application_*` tables and compared with the last `du_submissions` request payload. A difference outside
 * B3-2-10's tolerances → `data_integrity/du_input_variance` severity 1 (the DU limited waiver is at risk, A2-2-04); inside tolerance → severity 3 with a data correction.
 * Tolerance applied to `monthly_income_cents`: a decrease of ≤ 2% of qualifying income with no DTI crossing of 45%/50% is inside (rule 4(c)'s threshold layered on
 * B3-2-10); any larger decrease, or any non-money field difference (SSN, occupancy, property type, …), is outside. An increase is never a defect.
 */
export function recomputeDuInputs(i: DuInputsInput): { tests: ChecklistTest[]; findings: FindingDraft[]; fields_compared: number; all_match: boolean; income_variance: { du_cents: Cents; recomputed_cents: Cents; variance_cents: Cents; variance_pct: string } | null } {
  need(!!i.du_request && !!i.recomputed, "du_request and recomputed are required");
  const tests: ChecklistTest[] = [], findings: FindingDraft[] = [];
  let income_variance: { du_cents: Cents; recomputed_cents: Cents; variance_cents: Cents; variance_pct: string } | null = null;
  const keys = Object.keys(i.du_request);
  for (const k of keys) {
    const du = i.du_request[k] ?? null, rc = i.recomputed[k] ?? null;
    const same = typeof du === "bigint" || typeof rc === "bigint" ? BigInt(String(du ?? 0)) === BigInt(String(rc ?? 0)) : String(du) === String(rc);
    if (same) { tests.push({ test_id: `aus_data:${k}`, area: "aus_data", observed: String(rc), expected: String(du), result: "pass", evidence_refs: i.evidence_refs, finding: null }); continue; }
    if (/_cents$/.test(k) && du !== null && rc !== null) {
      const duC = BigInt(String(du)), rcC = BigInt(String(rc)); const v = varianceBps(duC, rcC);
      const isIncome = /income/.test(k);
      if (isIncome) income_variance = { du_cents: duC, recomputed_cents: rcC, variance_cents: rcC - duC, variance_pct: variancePct(duC, rcC) };
      const dtiCross = isIncome && i.monthly_debts_cents ? crosses(bps(i.monthly_debts_cents, duC), bps(i.monthly_debts_cents, rcC)) : false;
      const inside = v >= 0 ? true : -v <= INCOME_VARIANCE_TOLERANCE_BPS && !dtiCross;
      if (v > 0) { tests.push({ test_id: `aus_data:${k}`, area: "aus_data", observed: money(rcC), expected: money(duC), result: "pass", evidence_refs: i.evidence_refs, finding: null }); continue; }
      const f: FindingDraft = inside
        ? { category: "data_integrity", sub_category: "du_input_variance_in_tolerance", severity: 3, description: `${k} recomputed ${money(rcC)} vs DU request ${money(duC)} (${variancePct(duC, rcC)}) — inside B3-2-10 tolerance; data correction routed`, observed_value: money(rcC), expected_value: money(duC), guide_citation: "B3-2-10 (Accuracy of DU Data) · A3-4-02 (08/07/2018)", evidence_refs: i.evidence_refs, data_correction: { field: k, from: String(duC), to: String(rcC) } }
        : { category: "data_integrity", sub_category: "du_input_variance", severity: 1, description: `${k} recomputed ${money(rcC)} vs DU request${i.du_request_date ? ` of ${i.du_request_date}` : ""} ${money(duC)} (${variancePct(duC, rcC)}) — outside B3-2-10 tolerance; DU limited waiver at risk (A2-2-04); resubmit DU (23.1)`, observed_value: money(rcC), expected_value: money(duC), guide_citation: "B3-2-10 (Accuracy of DU Data) · A2-2-04 (04/01/2026) · A3-4-02 (08/07/2018)", evidence_refs: i.evidence_refs };
      findings.push(f); tests.push({ test_id: `aus_data:${k}`, area: "aus_data", observed: money(rcC), expected: money(duC), result: "fail", evidence_refs: i.evidence_refs, finding: f });
      continue;
    }
    const f: FindingDraft = { category: "data_integrity", sub_category: "du_input_variance", severity: 1, description: `${k}: DU request ${String(du)} vs recomputed ${String(rc)} — outside B3-2-10 tolerance`, observed_value: String(rc), expected_value: String(du), guide_citation: "B3-2-10 (Accuracy of DU Data) · A3-4-02 (08/07/2018)", evidence_refs: i.evidence_refs };
    findings.push(f); tests.push({ test_id: `aus_data:${k}`, area: "aus_data", observed: String(rc), expected: String(du), result: "fail", evidence_refs: i.evidence_refs, finding: f });
  }
  return { tests, findings, fields_compared: keys.length, all_match: findings.length === 0, income_variance };
}
const crosses = (beforeBps: number, afterBps: number): boolean => (beforeBps < 4500 && afterBps >= 4500) || (beforeBps < 5000 && afterBps >= 5000);

export interface Paystub { readonly document_id: string; readonly gross_period_cents: Cents; readonly pay_periods_per_year: number; readonly period_end: PlainDate; }
export interface IncomeInput { readonly paystubs: readonly Paystub[]; readonly w2_prior_year_cents?: Cents | null; readonly w2_document_id?: string | null; readonly underwriter_monthly_cents: Cents; readonly qualifying_income_cents?: Cents | null; readonly monthly_debts_cents?: Cents | null; readonly formula_id?: string; }
/** (c) `income`: independent recomputation from source documents with 22.3's formula ids; variance > 2% of qualifying income, or any DTI crossing 45%/50% → severity 2 (correctable) / 1 (DTI crosses 50%: ineligible). */
export function recomputeIncome(i: IncomeInput): { monthly_cents: Cents; annualized_cents: Cents; variance_cents: Cents; variance_bps: number; variance_pct: string; dti_before_bps: number | null; dti_after_bps: number | null; test: ChecklistTest; finding: FindingDraft | null; formula_id: string } {
  need(i.paystubs.length > 0, "at least one paystub"); need(typeof i.underwriter_monthly_cents === "bigint", "underwriter_monthly_cents (bigint)");
  const annualized = i.paystubs.reduce((a, p) => a + p.gross_period_cents * BigInt(p.pay_periods_per_year), 0n) / BigInt(i.paystubs.length);
  const monthly = annualized / 12n;
  const qualifying = i.qualifying_income_cents ?? i.underwriter_monthly_cents;
  const variance = monthly - i.underwriter_monthly_cents; const vb = bps(variance, qualifying);
  const dtiB = i.monthly_debts_cents ? bps(i.monthly_debts_cents, i.underwriter_monthly_cents) : null, dtiA = i.monthly_debts_cents ? bps(i.monthly_debts_cents, monthly) : null;
  const evidence: EvidenceRef[] = [...i.paystubs.map((p) => ({ document_id: p.document_id })), ...(i.w2_document_id ? [{ document_id: i.w2_document_id }] : [])];
  let finding: FindingDraft | null = null;
  const cross50 = dtiB !== null && dtiA !== null && dtiB < 5000 && dtiA >= 5000, cross45 = dtiB !== null && dtiA !== null && dtiB < 4500 && dtiA >= 4500;
  if (vb < -INCOME_VARIANCE_TOLERANCE_BPS || cross45 || cross50) finding = { category: "income_employment", sub_category: "calculation_variance", severity: cross50 ? 1 : 2, description: `qualifying income recomputed ${money(monthly)}/month vs underwriter ${money(i.underwriter_monthly_cents)} (${variancePct(i.underwriter_monthly_cents, monthly)})${cross50 ? "; DTI crosses 50%" : cross45 ? "; DTI crosses 45%" : ""}`, observed_value: money(monthly), expected_value: money(i.underwriter_monthly_cents), guide_citation: "B3-3.1-01 (General Income Information) · 22.3 formula " + (i.formula_id ?? "INC-W2-BASE-v1"), evidence_refs: evidence };
  const test: ChecklistTest = { test_id: "income:recompute", area: "income", observed: money(monthly), expected: money(i.underwriter_monthly_cents), result: finding ? "fail" : "pass", evidence_refs: evidence, finding };
  return { monthly_cents: monthly, annualized_cents: annualized, variance_cents: variance, variance_bps: vb, variance_pct: variancePct(i.underwriter_monthly_cents, monthly), dti_before_bps: dtiB, dti_after_bps: dtiA, test, finding, formula_id: i.formula_id ?? "INC-W2-BASE-v1" };
}
/** (d) `employment_vvoe`: a VVOE within B3-3.1-04's window (10 business days before the note date, 22.3 `FNMA_B3_3_1_04_VVOE_10BD`); when the note date is > 10 BD away the check is scheduled, not failed. */
export function checkVvoe(i: { vvoe_on: PlainDate | null; note_date: PlainDate; today: PlainDate; phone_independently_sourced?: boolean; document_id?: string | null; calendar?: Calendar }): { test: ChecklistTest; window_opens: PlainDate; business_days_before_note: number | null } {
  const cal = i.calendar ?? creditor; const window_opens = addBusinessDays(i.note_date, -VVOE_WINDOW_BD, cal);
  const bd = i.vvoe_on ? businessDaysBetween(i.vvoe_on, i.note_date, cal) : null;
  const inWindow = i.vvoe_on !== null && bd !== null && bd <= VVOE_WINDOW_BD && bd >= 0;
  const far = businessDaysBetween(i.today, i.note_date, cal) > VVOE_WINDOW_BD;
  const result: ChecklistTest["result"] = inWindow && i.phone_independently_sourced !== false ? "pass" : far ? "scheduled" : "fail";
  const finding: FindingDraft | null = result === "fail" ? { category: "income_employment", sub_category: "vvoe_missing_or_stale", severity: 2, description: `VVOE ${i.vvoe_on ?? "absent"} is not within 10 business days of the note date ${i.note_date}${i.phone_independently_sourced === false ? "; phone number not independently sourced" : ""}`, observed_value: i.vvoe_on, expected_value: `${window_opens} – ${i.note_date}`, guide_citation: "B3-3.1-04 (Employment Verification, 10 business days)", evidence_refs: i.document_id ? [{ document_id: i.document_id }] : [] } : null;
  return { test: { test_id: "employment_vvoe:window", area: "employment_vvoe", observed: i.vvoe_on ?? "absent", expected: `within ${window_opens} – ${i.note_date}`, result, evidence_refs: i.document_id ? [{ document_id: i.document_id }] : [], finding }, window_opens, business_days_before_note: bd };
}
export interface Deposit { readonly amount_cents: Cents; readonly on: PlainDate; readonly sourced: boolean; readonly source_evidence?: EvidenceRef | null; readonly note?: string | null; }
export interface GiftLetter { readonly amount_cents: Cents; readonly amount_stated: boolean; readonly no_repayment_stated: boolean; readonly donor_name: string | null; readonly donor_relationship: string | null; readonly donor_contact: string | null; readonly document_id: string; }
export interface AssetsInput { readonly funds_to_close_cents: Cents; readonly verified_assets_cents: Cents; readonly monthly_qualifying_income_cents: Cents; readonly deposits: readonly Deposit[]; readonly gift: GiftLetter | null; readonly integrity_checks_pass: boolean; readonly reserves_required_cents?: Cents | null; readonly evidence_refs: readonly EvidenceRef[]; }
/**
 * (e) `assets`: funds to close and reserves recomputed; every large deposit (> 50% of monthly qualifying income, B3-4.2-02) sourced; gift letter elements
 * present (B3-4.3-04); asset documents pass 22.1 integrity checks. Worked example 2: funds to close $45,320.55, gift $28,000 (62%), a $14,600 unsourced
 * deposit → available funds fall to $30,720.55, short by $14,600 → `assets/large_deposit_unsourced` severity 1; the incomplete gift letter → severity 2.
 */
export function recomputeAssets(i: AssetsInput): { tests: ChecklistTest[]; findings: FindingDraft[]; large_deposit_threshold_cents: Cents; unsourced_large_deposits_cents: Cents; available_excluding_unsourced_cents: Cents; shortfall_cents: Cents; gift_pct_of_funds_to_close: number | null; sufficient: boolean } {
  need(typeof i.funds_to_close_cents === "bigint" && typeof i.verified_assets_cents === "bigint", "funds_to_close_cents and verified_assets_cents (bigint)");
  const threshold = (i.monthly_qualifying_income_cents * BigInt(LARGE_DEPOSIT_PCT_OF_INCOME)) / 100n;
  const tests: ChecklistTest[] = [], findings: FindingDraft[] = [];
  const unsourced = i.deposits.filter((d) => d.amount_cents > threshold && !d.sourced);
  const unsourcedCents = unsourced.reduce((a, d) => a + d.amount_cents, 0n);
  const available = i.verified_assets_cents - unsourcedCents;
  const shortfall = available < i.funds_to_close_cents ? i.funds_to_close_cents - available : 0n;
  if (unsourced.length) {
    const f: FindingDraft = { category: "assets", sub_category: "large_deposit_unsourced", severity: shortfall > 0n ? 1 : 2, description: `${unsourced.length} deposit(s) over the ${money(threshold)} large-deposit threshold (50% of ${money(i.monthly_qualifying_income_cents)}) accepted without source documentation${unsourced[0]?.note ? ` ("${unsourced[0].note}")` : ""}; funds available excluding them ${money(available)} against funds to close ${money(i.funds_to_close_cents)}${shortfall > 0n ? ` — short by ${money(shortfall)}` : ""}`, observed_value: money(available), expected_value: money(i.funds_to_close_cents), guide_citation: "B3-4.2-02 (Depository Accounts — large deposits)", evidence_refs: [...i.evidence_refs, ...unsourced.map((d) => d.source_evidence).filter((e): e is EvidenceRef => !!e)] };
    findings.push(f); tests.push({ test_id: "assets:large_deposits", area: "assets", observed: `${unsourced.length} unsourced over ${money(threshold)}`, expected: "every large deposit sourced", result: "fail", evidence_refs: i.evidence_refs, finding: f });
  } else tests.push({ test_id: "assets:large_deposits", area: "assets", observed: `no deposit over ${money(threshold)} unsourced`, expected: "every large deposit sourced", result: "pass", evidence_refs: i.evidence_refs, finding: null });
  let gift_pct: number | null = null;
  if (i.gift) {
    gift_pct = i.funds_to_close_cents > 0n ? Math.round(Number((i.gift.amount_cents * 10000n) / i.funds_to_close_cents) / 100) : null;
    const missing = [!i.gift.amount_stated ? "amount" : null, !i.gift.no_repayment_stated ? "no repayment expected" : null, !i.gift.donor_name ? "donor name" : null, !i.gift.donor_relationship ? "donor relationship" : null, !i.gift.donor_contact ? "donor contact information" : null].filter((x): x is string => x !== null);
    if (missing.length) { const f: FindingDraft = { category: "assets", sub_category: "gift_letter_incomplete", severity: 2, description: `gift letter (${money(i.gift.amount_cents)}, ${gift_pct}% of funds to close) omits: ${missing.join(", ")}`, observed_value: `missing ${missing.join(", ")}`, expected_value: "B3-4.3-04 gift letter elements", guide_citation: "B3-4.3-04 (Personal Gifts — gift letter)", evidence_refs: [{ document_id: i.gift.document_id }] }; findings.push(f); tests.push({ test_id: "assets:gift_letter", area: "assets", observed: `missing ${missing.join(", ")}`, expected: "all B3-4.3-04 elements", result: "fail", evidence_refs: [{ document_id: i.gift.document_id }], finding: f }); }
    else tests.push({ test_id: "assets:gift_letter", area: "assets", observed: "complete", expected: "all B3-4.3-04 elements", result: "pass", evidence_refs: [{ document_id: i.gift.document_id }], finding: null });
  }
  const sufficient = available >= i.funds_to_close_cents + (i.reserves_required_cents ?? 0n);
  tests.push({ test_id: "assets:funds_to_close", area: "assets", observed: money(available), expected: `≥ ${money(i.funds_to_close_cents + (i.reserves_required_cents ?? 0n))}`, result: sufficient ? "pass" : "fail", evidence_refs: i.evidence_refs, finding: null });
  if (!i.integrity_checks_pass) { const f: FindingDraft = { category: "fraud_misrepresentation", sub_category: "asset_document_integrity", severity: 1, description: "an asset document failed 22.1 document_integrity_checks", observed_value: "warn|fail", expected_value: "pass", guide_citation: "A3-4-03 (12/10/2025)", evidence_refs: i.evidence_refs }; findings.push(f); tests.push({ test_id: "assets:document_integrity", area: "assets", observed: "fail", expected: "pass", result: "fail", evidence_refs: i.evidence_refs, finding: f }); }
  else tests.push({ test_id: "assets:document_integrity", area: "assets", observed: "pass", expected: "pass", result: "pass", evidence_refs: i.evidence_refs, finding: null });
  return { tests, findings, large_deposit_threshold_cents: threshold, unsourced_large_deposits_cents: unsourcedCents, available_excluding_unsourced_cents: available, shortfall_cents: shortfall, gift_pct_of_funds_to_close: gift_pct, sufficient };
}
export interface CollateralInput { readonly valuation_method: "value_acceptance" | "value_acceptance_plus_pd" | "appraisal" | "hybrid"; readonly offer_date?: PlainDate | null; readonly note_date: PlainDate; readonly cu_score?: number | null; readonly unreconciled_cu_messages?: number; readonly uad_3_6_required?: boolean; readonly uad_form?: string | null; readonly evidence_refs: readonly EvidenceRef[]; }
/** (f) `collateral`: appraisal/SSR/CU messages reconciled (24.2); a value-acceptance offer ≤ 4 months old on the note date (24.1); UAD 3.6 where required; CU > 2.5 with unreconciled messages → severity 2. */
export function checkCollateral(i: CollateralInput): { tests: ChecklistTest[]; findings: FindingDraft[]; offer_age_days: number | null; offer_expires_on: PlainDate | null } {
  const tests: ChecklistTest[] = [], findings: FindingDraft[] = [];
  let age: number | null = null, expires: PlainDate | null = null;
  if (i.valuation_method.startsWith("value_acceptance")) {
    need(!!i.offer_date, "offer_date for a value-acceptance loan");
    age = daysBetween(i.offer_date!, i.note_date); expires = addMonths(i.offer_date!, VALUE_ACCEPTANCE_MAX_AGE_MONTHS);
    const ok = i.note_date <= expires;
    const f: FindingDraft | null = ok ? null : { category: "collateral", sub_category: "value_acceptance_offer_expired", severity: 1, description: `value acceptance offer ${i.offer_date} is older than 4 months on the note date ${i.note_date}`, observed_value: `${age} days`, expected_value: "≤ 4 months", guide_citation: "B4-1.4-10 (Value Acceptance)", evidence_refs: i.evidence_refs };
    if (f) findings.push(f); tests.push({ test_id: "collateral:value_acceptance_age", area: "collateral", observed: `${age} days (offer ${i.offer_date})`, expected: `≤ 4 months (by ${expires})`, result: ok ? "pass" : "fail", evidence_refs: i.evidence_refs, finding: f });
  } else {
    const cu = i.cu_score ?? null; const unrec = i.unreconciled_cu_messages ?? 0;
    const bad = cu !== null && cu > CU_SCORE_TRIGGER && unrec > 0;
    const f: FindingDraft | null = bad ? { category: "collateral", sub_category: "cu_messages_unreconciled", severity: 2, description: `CU risk score ${cu} > 2.5 with ${unrec} unreconciled message(s)`, observed_value: `${cu} / ${unrec} unreconciled`, expected_value: "messages reconciled (24.2)", guide_citation: "B4-1.3-12 (Collateral Underwriter)", evidence_refs: i.evidence_refs } : null;
    if (f) findings.push(f); tests.push({ test_id: "collateral:cu_reconciled", area: "collateral", observed: `CU ${cu ?? "n/a"}, ${unrec} unreconciled`, expected: "CU ≤ 2.5 or every message reconciled", result: bad ? "fail" : "pass", evidence_refs: i.evidence_refs, finding: f });
    if (i.uad_3_6_required) { const ok = i.uad_form === "UAD_3_6"; const uf: FindingDraft | null = ok ? null : { category: "collateral", sub_category: "uad_form_version", severity: 2, description: `UAD 3.6 form required; ${i.uad_form ?? "none"} on file`, observed_value: i.uad_form ?? null, expected_value: "UAD_3_6", guide_citation: "B4-1.2-01 (Appraisal Report Forms, UAD 3.6)", evidence_refs: i.evidence_refs }; if (uf) findings.push(uf); tests.push({ test_id: "collateral:uad_form", area: "collateral", observed: i.uad_form ?? "none", expected: "UAD_3_6", result: ok ? "pass" : "fail", evidence_refs: i.evidence_refs, finding: uf }); }
  }
  return { tests, findings, offer_age_days: age, offer_expires_on: expires };
}
/** B7-1-02 standard coverage (fixed-rate, term > 20 years / ≤ 20 years); HomeReady > 20 years 90.01–97% → 25%. LTV ≤ 80% → none. */
export function requiredMiCoveragePct(ltv_x100: number, term_months: number, program: "standard" | "homeready" = "standard"): number {
  if (ltv_x100 <= 8000) return 0;
  const long = term_months > 240;
  if (program === "homeready" && long && ltv_x100 > 9000) return 25;
  if (ltv_x100 <= 8500) return long ? 12 : 6;
  if (ltv_x100 <= 9000) return long ? 25 : 12;
  if (ltv_x100 <= 9500) return long ? 30 : 25;
  return 35;
}
/** (g) `mi`: coverage percent equals B7-1-02 for the LTV/term; certificate issued (24.6). Under-coverage → severity 1 (ineligible); over-coverage → severity 3; certificate missing → severity 2. */
export function checkMi(i: { ltv_x100: number; term_months: number; coverage_pct: number | null; certificate_issued: boolean; program?: "standard" | "homeready"; evidence_refs: readonly EvidenceRef[] }): { required_pct: number; applicable: boolean; test: ChecklistTest; finding: FindingDraft | null } {
  const required = requiredMiCoveragePct(i.ltv_x100, i.term_months, i.program ?? "standard");
  if (required === 0) return { required_pct: 0, applicable: false, test: { test_id: "mi:coverage", area: "mi", observed: "n/a", expected: "n/a (LTV ≤ 80%)", result: "na", evidence_refs: i.evidence_refs, finding: null }, finding: null };
  let finding: FindingDraft | null = null;
  if (!i.certificate_issued) finding = { category: "insurance", sub_category: "mi_certificate_missing", severity: 2, description: `MI certificate not issued (LTV ${(i.ltv_x100 / 100).toFixed(2)}%)`, observed_value: "none", expected_value: `${required}% certificate`, guide_citation: "B7-1-02 (Mortgage Insurance Coverage Requirements)", evidence_refs: i.evidence_refs };
  else if ((i.coverage_pct ?? 0) < required) finding = { category: "insurance", sub_category: "mi_coverage_below_required", severity: 1, description: `MI coverage ${i.coverage_pct}% below the ${required}% B7-1-02 requires at ${(i.ltv_x100 / 100).toFixed(2)}% LTV`, observed_value: `${i.coverage_pct}%`, expected_value: `${required}%`, guide_citation: "B7-1-02 (Mortgage Insurance Coverage Requirements)", evidence_refs: i.evidence_refs };
  else if ((i.coverage_pct ?? 0) > required) finding = { category: "insurance", sub_category: "mi_coverage_above_required", severity: 3, description: `MI coverage ${i.coverage_pct}% exceeds the ${required}% required`, observed_value: `${i.coverage_pct}%`, expected_value: `${required}%`, guide_citation: "B7-1-02", evidence_refs: i.evidence_refs };
  return { required_pct: required, applicable: true, test: { test_id: "mi:coverage", area: "mi", observed: `${i.coverage_pct ?? "none"}%${i.certificate_issued ? "" : " (no certificate)"}`, expected: `${required}%`, result: finding ? "fail" : "pass", evidence_refs: i.evidence_refs, finding }, finding };
}
export interface OccupancyInput { readonly declared: "primary" | "second_home" | "investment"; readonly mailing_address_is_subject: boolean; readonly insurance_form: string | null; readonly other_reo_primary: boolean; readonly distance_to_work_miles?: number | null; readonly evidence_refs: readonly EvidenceRef[]; }
/** (h) `occupancy`: declared occupancy consistent with mailing address, insurance form (HO-3 owner-occupied vs DP-3 landlord), other REO and distance to work; a contradiction → `occupancy` finding severity 1 with a red-flag investigation (22.6) and a 28.4 referral request. */
export function assessOccupancy(i: OccupancyInput): { test: ChecklistTest; finding: FindingDraft | null; contradictions: string[]; red_flag_investigation: { route: "22.6"; kind: "occupancy" } | null } {
  const c: string[] = [];
  if (i.declared === "primary") {
    if (!i.mailing_address_is_subject) c.push("mailing address is not the subject property");
    if (i.insurance_form && /^DP/i.test(i.insurance_form)) c.push(`landlord policy form ${i.insurance_form} on a declared primary`);
    if (i.other_reo_primary) c.push("another REO is occupied as the primary");
    if ((i.distance_to_work_miles ?? 0) > 100) c.push(`${i.distance_to_work_miles} miles to work`);
  } else if (i.insurance_form && /^HO-3/i.test(i.insurance_form) && i.declared === "investment") c.push("owner-occupied HO-3 form on a declared investment property");
  const finding: FindingDraft | null = c.length ? { category: "occupancy", sub_category: "declared_occupancy_contradicted", severity: 1, description: `declared ${i.declared} contradicted: ${c.join("; ")}`, observed_value: c.join("; "), expected_value: `consistent ${i.declared} indicators`, guide_citation: "B2-1.1-01 (Occupancy Types) · A3-4-03 (12/10/2025)", evidence_refs: i.evidence_refs } : null;
  return { test: { test_id: "occupancy:consistency", area: "occupancy", observed: c.length ? c.join("; ") : `consistent ${i.declared}`, expected: `consistent ${i.declared}`, result: c.length ? "fail" : "pass", evidence_refs: i.evidence_refs, finding }, finding, contradictions: c, red_flag_investigation: c.length ? { route: "22.6", kind: "occupancy" } : null };
}
/** (b) `ssn`: SSA CBSV `match` for every borrower (22.6); absent → order under `purpose_code = qc_prefunding`. */
export function checkSsn(i: { borrowers: readonly { borrower_id: string; cbsv_result: "match" | "no_match" | null; cbsv_on?: PlainDate | null; document_id?: string | null }[] }): { tests: ChecklistTest[]; findings: FindingDraft[]; order_cbsv_for: string[] } {
  const tests: ChecklistTest[] = [], findings: FindingDraft[] = [], order: string[] = [];
  for (const b of i.borrowers) {
    const ev = b.document_id ? [{ document_id: b.document_id }] : [];
    if (b.cbsv_result === "match") tests.push({ test_id: `ssn:${b.borrower_id}`, area: "ssn", observed: `match${b.cbsv_on ? ` on ${b.cbsv_on}` : ""}`, expected: "match", result: "pass", evidence_refs: ev, finding: null });
    else if (b.cbsv_result === null) { order.push(b.borrower_id); tests.push({ test_id: `ssn:${b.borrower_id}`, area: "ssn", observed: "absent — CBSV ordered under qc_prefunding", expected: "match", result: "scheduled", evidence_refs: ev, finding: null }); }
    else { const f: FindingDraft = { category: "identity_ssn", sub_category: "cbsv_no_match", severity: 1, description: `SSA CBSV no_match for ${b.borrower_id}`, observed_value: "no_match", expected_value: "match", guide_citation: "B3-1-01 / A3-4-03 (identity)", evidence_refs: ev }; findings.push(f); tests.push({ test_id: `ssn:${b.borrower_id}`, area: "ssn", observed: "no_match", expected: "match", result: "fail", evidence_refs: ev, finding: f }); }
  }
  return { tests, findings, order_cbsv_for: order };
}
export interface ComplianceSnapshotInput { readonly compliance_tests_current: boolean; readonly trid_clocks_ok: boolean; readonly regb_decision_timer_satisfied: boolean; readonly ofac_rescreen_on: PlainDate | null; readonly today: PlainDate; readonly identity_result: "pass" | "fail" | null; readonly fraud_cases_open: number; readonly evidence_refs: readonly EvidenceRef[]; }
/** Always added: `compliance` (25.1 tests current; TRID clocks; Reg B decision date) and `fraud` (OFAC re-screen ≤ 30 days, identity result, open `fraud_cases`). */
export function runComplianceSnapshot(i: ComplianceSnapshotInput): { tests: ChecklistTest[]; findings: FindingDraft[] } {
  const tests: ChecklistTest[] = [], findings: FindingDraft[] = [];
  const t = (test_id: string, area: ReviewArea, ok: boolean, observed: string, expected: string, f: FindingDraft | null) => { if (f && !ok) findings.push(f); tests.push({ test_id, area, observed, expected, result: ok ? "pass" : "fail", evidence_refs: i.evidence_refs, finding: ok ? null : f }); };
  t("compliance:tests_current", "compliance", i.compliance_tests_current, String(i.compliance_tests_current), "25.1 tests current", { category: "legal_regulatory_compliance", sub_category: "compliance_tests_stale", severity: 2, description: "25.1 compliance tests are not current on the final terms", observed_value: "stale", expected_value: "current", guide_citation: "A3-2-01 (Compliance With Laws)", law_citation: "12 CFR 1026", is_compliance: true, evidence_refs: i.evidence_refs });
  t("compliance:trid_clocks", "compliance", i.trid_clocks_ok, String(i.trid_clocks_ok), "TRID clocks satisfied", { category: "legal_regulatory_compliance", sub_category: "trid_timing", severity: 1, description: "a TRID timing requirement is not satisfied", observed_value: "breach", expected_value: "satisfied", guide_citation: "A3-2-01", law_citation: "12 CFR 1026.19(e)/(f)", is_compliance: true, evidence_refs: i.evidence_refs });
  t("compliance:regb_decision", "compliance", i.regb_decision_timer_satisfied, String(i.regb_decision_timer_satisfied), "REGB_1002_9_DECISION_30 satisfied", { category: "legal_regulatory_compliance", sub_category: "regb_notice_timing", severity: 2, description: "Reg B §1002.9 decision notice not within 30 days", observed_value: "late", expected_value: "≤ 30 days", guide_citation: "A3-2-01", law_citation: "12 CFR 1002.9(a)(1)", is_compliance: true, evidence_refs: i.evidence_refs });
  const ofacFresh = i.ofac_rescreen_on !== null && daysBetween(i.ofac_rescreen_on, i.today) <= 30;
  t("fraud:ofac_rescreen", "fraud", ofacFresh, i.ofac_rescreen_on ?? "none", "re-screen within 30 days", { category: "legal_regulatory_compliance", sub_category: "ofac_rescreen_stale", severity: 2, description: "OFAC re-screen older than 30 days or absent", observed_value: i.ofac_rescreen_on, expected_value: "≤ 30 days", guide_citation: "A3-4-03 · 22.6", law_citation: "31 CFR 501", is_compliance: true, evidence_refs: i.evidence_refs });
  t("fraud:identity", "fraud", i.identity_result === "pass", i.identity_result ?? "none", "pass", { category: "identity_ssn", sub_category: "identity_screen", severity: 1, description: "identity screening not passed", observed_value: i.identity_result, expected_value: "pass", guide_citation: "A3-4-03 (12/10/2025)", evidence_refs: i.evidence_refs });
  t("fraud:open_cases", "fraud", i.fraud_cases_open === 0, String(i.fraud_cases_open), "0 open fraud_cases", { category: "fraud_misrepresentation", sub_category: "fraud_case_open", severity: 1, description: `${i.fraud_cases_open} open fraud_cases (28.4)`, observed_value: String(i.fraud_cases_open), expected_value: "0", guide_citation: "A3-4-03 (12/10/2025)", evidence_refs: i.evidence_refs });
  return { tests, findings };
}

// ============================================================ reverifications (rule 4(b), 28.1-Q6, T12)
export interface ReverificationInput { readonly kind: ReverificationKind; readonly source: string; readonly at: string; readonly fee_cents?: Cents; readonly reverification_id?: string; readonly calendar?: Calendar; readonly purpose_code?: "qc_prefunding" | "qc_post_closing"; }
/** A reverification under the QC purpose code: `qc.reverification.requested{requested_at}` arms SM_QC_REVERIFICATION_RESPONSE_3BD (+3 `business_days_creditor`); the review waits in `awaiting_reverification`. */
export function orderReverification(events: EventStore, review: QcReview, i: ReverificationInput, actor: Actor = QC_AGENT): { reverification: QcReverification; review: QcReview; event: DomainEvent } {
  nonEmpty(i.kind, "kind"); nonEmpty(i.source, "source"); nonEmpty(i.at, "at"); need(!TERMINAL_STATUSES.includes(review.status), `${review.review_id} is ${review.status}`);
  const cal = i.calendar ?? creditor; const on = dateOf(i.at);
  const rev: QcReverification = { reverification_id: i.reverification_id ?? `qcrv:${review.review_id}:${i.kind}:${on}`, review_id: review.review_id, application_id: review.application_id, kind: i.kind, source: i.source, requested_at: i.at, request_dates: [on], response_due_at: addBusinessDays(on, REVERIFICATION_RESPONSE_BD, cal), escalate_at: addBusinessDays(on, REVERIFICATION_ESCALATE_BD, cal), received_at: null, result: null, variance: null, document_id: null, purpose_code: i.purpose_code ?? "qc_prefunding", fee_cents: i.fee_cents ?? 0n, officer_decision: null };
  const next: QcReview = { ...review, status: "awaiting_reverification" };
  return { reverification: rev, review: next, event: emit(events, review.application_id, "qc.reverification.requested", { reverification_id: rev.reverification_id, review_id: review.review_id, kind: rev.kind, source: rev.source, requested_at: i.at, response_due_at: rev.response_due_at, purpose_code: rev.purpose_code, attempt: 1, fee_cents: String(rev.fee_cents), ledger: "third_party_costs (SM-borne)" }, i.at, actor) };
}
export function receiveReverification(events: EventStore, rev: QcReverification, i: { at: string; result: ReverificationResult; variance?: Record<string, unknown> | null; document_id?: string | null }, actor: Actor = QC_AGENT): { reverification: QcReverification; event: DomainEvent } {
  need(rev.received_at === null, `${rev.reverification_id} already received`);
  const next: QcReverification = { ...rev, received_at: i.at, result: i.result, variance: i.variance ?? null, document_id: i.document_id ?? null };
  return { reverification: next, event: emit(events, rev.application_id, "qc.reverification.received", { reverification_id: rev.reverification_id, review_id: rev.review_id, kind: rev.kind, result: i.result, received_at: i.at, variance: i.variance ?? null }, i.at, actor) };
}
/** No response by +3 BD → a second request is logged (both request dates on the file); by +5 BD the `qc_officer` decides `unable_to_complete` vs hold (D1-3-03 practice adopted). */
export function reverificationFollowUp(events: EventStore, escalations: EscalationService, rev: QcReverification, i: { today: PlainDate; at: string }, actor: Actor = QC_AGENT): { reverification: QcReverification; action: "none" | "second_request" | "officer_decision"; escalation: Escalation | null; event: DomainEvent | null } {
  if (rev.received_at !== null) return { reverification: rev, action: "none", escalation: null, event: null };
  if (i.today >= rev.escalate_at && rev.request_dates.length >= 2) {
    const escalation = escalations.open({ kind: "qc_officer", applicationId: rev.application_id, severity: "sev2", payload: { reverification_id: rev.reverification_id, review_id: rev.review_id, kind: rev.kind, source: rev.source, request_dates: rev.request_dates, options: ["unable_to_complete", "keep_hold"], alternatives: ["paystub + bank deposit pattern", "The Work Number"], rule: "28.1 timer SM_QC_REVERIFICATION_RESPONSE_3BD breach: at +5 BD `qc_officer` decides" } }, actor);
    return { reverification: rev, action: "officer_decision", escalation, event: emit(events, rev.application_id, "qc.reverification.escalated", { reverification_id: rev.reverification_id, review_id: rev.review_id, escalation_id: escalation.id, request_dates: rev.request_dates }, i.at, actor) };
  }
  if (i.today >= rev.response_due_at && rev.request_dates.length < 2) {
    const next: QcReverification = { ...rev, request_dates: [...rev.request_dates, i.today] };
    return { reverification: next, action: "second_request", escalation: null, event: emit(events, rev.application_id, "qc.reverification.requested", { reverification_id: rev.reverification_id, review_id: rev.review_id, kind: rev.kind, source: rev.source, requested_at: i.at, response_due_at: rev.escalate_at, purpose_code: rev.purpose_code, attempt: 2, request_dates: next.request_dates }, i.at, actor) };
  }
  return { reverification: rev, action: "none", escalation: null, event: null };
}
/** The officer's decision on a non-responding source: `unable_to_complete` closes the review (hold released by the officer); `keep_hold` keeps the review waiting. */
export function officerDecideReverification(events: EventStore, escalations: EscalationService | null, review: QcReview, findings: readonly QcFinding[], rev: QcReverification, i: { decision: "unable_to_complete" | "keep_hold"; officer: Actor; at: string; rationale: string }): { reverification: QcReverification; review: QcReview; events: DomainEvent[] } {
  if (!isQcOfficer(i.officer)) throw new QcRefused("REVERIFICATION_DECISION_NEEDS_OFFICER", "28.1 timer table: at +5 BD the `qc_officer` decides `unable_to_complete` vs hold; `unable_to_complete` only by the officer", `${i.officer.kind}:${i.officer.id}`);
  nonEmpty(i.rationale, "rationale");
  const next: QcReverification = { ...rev, officer_decision: i.decision, result: i.decision === "unable_to_complete" ? "unable" : "no_response" };
  const decided = emit(events, review.application_id, "qc.reverification.officer_decided", { reverification_id: rev.reverification_id, review_id: review.review_id, decision: i.decision, request_dates: rev.request_dates, rationale: i.rationale, officer_id: i.officer.id }, i.at, i.officer);
  if (i.decision === "keep_hold") return { reverification: next, review, events: [decided] };
  const closed = closeReview(events, escalations, review, findings, { outcome: "unable_to_complete", at: i.at, actor: i.officer, rationale: i.rationale });
  return { reverification: next, review: closed.review, events: [decided, ...closed.events] };
}

// ============================================================ findings (rule 5) — draft, officer review, release, rebuttal, resolution
export interface DraftFindingInput extends FindingDraft { readonly at: string; readonly finding_id?: string; }
/** A drafted finding carries evidence refs, observed/expected values and the Guide citation; a component review escalates to full-file on any severity ≤ 2 finding (rule 3). */
export function draftFinding(events: EventStore, review: QcReview, i: DraftFindingInput, actor: Actor = QC_AGENT): { finding: QcFinding; review: QcReview; event: DomainEvent } {
  nonEmpty(i.category, "category"); nonEmpty(i.sub_category, "sub_category"); nonEmpty(i.at, "at"); need([1, 2, 3, 4].includes(i.severity), "severity must be 1–4");
  need(i.evidence_refs.length > 0, "evidence_refs (at least one document reference)"); nonEmpty(i.guide_citation, "guide_citation");
  need(!TERMINAL_STATUSES.includes(review.status), `${review.review_id} is ${review.status}`);
  const finding: QcFinding = { finding_id: i.finding_id ?? `qcf:${review.review_id}:${review.finding_ids.length + 1}`, review_id: review.review_id, application_id: review.application_id, category: i.category, sub_category: i.sub_category, defect_code: `${i.category}/${i.sub_category}`, severity: i.severity, description: i.description,
    evidence_refs: [...i.evidence_refs], observed_value: i.observed_value, expected_value: i.expected_value, guide_citation: i.guide_citation, law_citation: i.law_citation ?? null, is_compliance: i.is_compliance ?? false, status: "draft", recorded_at: i.at, released_at: null, rebuttal: null, resolution: null, resolution_ref: null, resolved_at: null, reviewed_by_qc_officer_at: null, officer_decision: null };
  const escalates = review.review_type === "component" && i.severity <= 2;
  const next: QcReview = { ...review, finding_ids: [...review.finding_ids, finding.finding_id], highest_severity: review.highest_severity === null ? i.severity : (Math.min(review.highest_severity, i.severity) as Severity), ...(escalates ? { review_type: "full_file" as ReviewType, component_scope: [...REVIEW_AREAS] } : {}) };
  return { finding, review: next, event: emit(events, review.application_id, "qc.finding.recorded", { finding_id: finding.finding_id, review_id: review.review_id, defect_code: finding.defect_code, severity: finding.severity, evidence_refs: finding.evidence_refs, observed_value: finding.observed_value, expected_value: finding.expected_value, guide_citation: finding.guide_citation, is_compliance: finding.is_compliance, review_type_after: next.review_type, escalated_to_full_file: escalates }, i.at, actor) };
}
/** A fraud-family finding (identity, occupancy, fabricated documents) asks 28.4 to open a `fraud_cases` row (`openFraudCase`); further borrower contact stops. */
export function requestFraudReferral(events: EventStore, finding: QcFinding, at: string, actor: Actor = QC_AGENT): DomainEvent | null {
  if (!FRAUD_FAMILY_CATEGORIES.includes(finding.category)) return null;
  return emit(events, finding.application_id, "qc.fraud_referral.requested", { finding_id: finding.finding_id, review_id: finding.review_id, category: finding.category, defect_code: finding.defect_code, severity: finding.severity, consumer: "28.4 openFraudCase", borrower_contact: "stopped" }, at, actor);
}
/** Rule 6: every severity-1/2 finding goes to `officer_review` before release; plus the officer's random sample of no-defect conclusions. `qc.review.routed_to_officer{routed_at}` arms SM_QC_OFFICER_FINDING_SLA_1BD. */
export function routeToOfficer(events: EventStore, escalations: EscalationService, review: QcReview, findings: readonly QcFinding[], i: { at: string; officer_sample?: boolean; calendar?: Calendar }, actor: Actor = QC_AGENT): { required: boolean; review: QcReview; escalation: Escalation | null; event: DomainEvent | null; sla_due: PlainDate | null } {
  const mine = findings.filter((f) => f.review_id === review.review_id && f.status === "draft");
  const sev12 = mine.filter((f) => f.severity <= 2);
  const required = sev12.length > 0 || i.officer_sample === true;
  if (!required) return { required: false, review, escalation: null, event: null, sla_due: null };
  const sla_due = addBusinessDays(dateOf(i.at), OFFICER_FINDING_SLA_BD, i.calendar ?? creditor);
  const escalation = escalations.open({ kind: "qc_officer", applicationId: review.application_id, severity: sev12.some((f) => f.severity === 1) ? "sev1" : "sev2", payload: { review_id: review.review_id, finding_ids: sev12.map((f) => f.finding_id), officer_sample: i.officer_sample === true, sla: "SM_QC_OFFICER_FINDING_SLA_1BD", sla_due, decisions: ["released", "withdrawn"] } }, actor);
  const next: QcReview = { ...review, status: "officer_review", officer_sample: i.officer_sample === true || review.officer_sample };
  return { required: true, review: next, escalation, event: emit(events, review.application_id, "qc.review.routed_to_officer", { review_id: review.review_id, routed_at: i.at, finding_ids: sev12.map((f) => f.finding_id), officer_sample: i.officer_sample === true, escalation_id: escalation.id, sla_due }, i.at, actor), sla_due };
}
/** The officer's decision on a drafted finding (`released` clears it for release; `withdrawn` removes it with the rationale). Satisfies SM_QC_OFFICER_FINDING_SLA_1BD. */
export function officerDecideFinding(events: EventStore, finding: QcFinding, i: { decision: "released" | "withdrawn"; officer: Actor; at: string; rationale: string }): { finding: QcFinding; events: DomainEvent[] } {
  if (!isQcOfficer(i.officer)) throw new QcRefused("FINDING_DECISION_NEEDS_QC_OFFICER", "28.1 rule 6 / guardrails: the agent never self-approves a severity-1/2 finding; the `qc_officer` decides before release", `${i.officer.kind}:${i.officer.id}`);
  need(finding.status === "draft", `${finding.finding_id} is ${finding.status}`); nonEmpty(i.rationale, "rationale");
  const next: QcFinding = { ...finding, reviewed_by_qc_officer_at: i.at, officer_decision: i.decision, ...(i.decision === "withdrawn" ? { status: "withdrawn" as FindingStatus, resolution: "waived_by_officer" as Resolution, resolved_at: i.at } : {}) };
  const out = [emit(events, finding.application_id, "qc.finding.officer_decided", { finding_id: finding.finding_id, review_id: finding.review_id, decision: i.decision, severity: finding.severity, officer_id: i.officer.id, rationale: i.rationale, decided_at: i.at }, i.at, i.officer)];
  if (i.decision === "withdrawn") out.push(emit(events, finding.application_id, "qc.finding.withdrawn", { finding_id: finding.finding_id, review_id: finding.review_id, by: "qc_officer", rationale: i.rationale }, i.at, i.officer));
  return { finding: next, events: out };
}
/**
 * Release to production: every severity ≤ 2 finding must carry the officer's `released` decision (the agent never self-approves); `qc.finding.released` (with defect code,
 * evidence and citation) arms SM_QC_REBUTTAL_WINDOW_1BD; `qc.hold.applied{kind=prefunding, finding_ids}` tells 23.3 the review is `defect_open` — 23.3 reopens the
 * conditions (`reopenCondition` / `decision.reopened`) in the same transaction; `applications.qc_prefunding_status = defect_open`.
 */
export function releaseFindings(events: EventStore, escalations: EscalationService | null, review: QcReview, findings: readonly QcFinding[], i: { at: string; actor?: Actor }): { review: QcReview; findings: QcFinding[]; events: DomainEvent[]; application_qc_status: QcPrefundingStatus; gate: GateResult } {
  const actor = i.actor ?? QC_AGENT; nonEmpty(i.at, "at");
  assertQcIdentity(escalations, actor, "releaseFindings", review.application_id);
  const drafts = findings.filter((f) => f.review_id === review.review_id && f.status === "draft");
  need(drafts.length > 0, "no draft findings to release");
  const unapproved = drafts.filter((f) => f.severity <= 2 && f.officer_decision !== "released");
  if (unapproved.length) throw new QcRefused("SEV12_RELEASE_NEEDS_QC_OFFICER", "28.1 state machine: `findings_released` requires `officer_review` when min(severity) ≤ 2 — the agent never self-approves a severity-1/2 finding", unapproved.map((f) => `${f.finding_id} (sev ${f.severity})`).join(", "));
  const released: QcFinding[] = drafts.map((f) => ({ ...f, status: "released", released_at: i.at }));
  const out: DomainEvent[] = [];
  for (const f of released) out.push(emit(events, review.application_id, "qc.finding.released", { finding_id: f.finding_id, review_id: review.review_id, defect_code: f.defect_code, category: f.category, severity: f.severity, description: f.description, evidence_refs: f.evidence_refs, observed_value: f.observed_value, expected_value: f.expected_value, guide_citation: f.guide_citation, law_citation: f.law_citation, is_compliance: f.is_compliance, released_at: i.at, rebuttal_window: "SM_QC_REBUTTAL_WINDOW_1BD", production_hand_off: "23.3 reopenCondition / decision.reopened{cause=prefunding_qc_defect}" }, i.at, actor));
  const sev12 = released.filter((f) => f.severity <= 2);
  if (sev12.length) out.push(emit(events, review.application_id, "qc.hold.applied", { review_id: review.review_id, hold_id: review.hold_id, kind: "prefunding", reason: "findings_released", finding_ids: sev12.map((f) => f.finding_id), ctc_item: "CTC_QC_PREFUNDING", item_alias: "SM_QC_PREFUNDING_HOLD" }, i.at, actor));
  const next: QcReview = { ...review, status: "findings_released", highest_severity: (Math.min(...released.map((f) => f.severity), review.highest_severity ?? 4) as Severity) };
  const all = findings.map((f) => released.find((r) => r.finding_id === f.finding_id) ?? f);
  return { review: next, findings: released, events: out, application_qc_status: qcPrefundingStatus(next, all), gate: assertGateOpen(next, all) };
}
/** Production's reaction recorded on the finding (`condition_reopened{C-17}`, `decision_reversed`, `data_corrected{DU resubmission}`): satisfies SM_QC_REBUTTAL_WINDOW_1BD. The finding stays `released` until re-tested. */
export function recordFindingResolution(events: EventStore, finding: QcFinding, i: { resolution: Exclude<Resolution, "no_action_rebuttal_accepted" | "waived_by_officer">; resolution_ref: string; at: string }, actor: Actor = QC_AGENT): { finding: QcFinding; event: DomainEvent } {
  need(["released", "rebutted", "sustained"].includes(finding.status), `${finding.finding_id} is ${finding.status}`); nonEmpty(i.resolution_ref, "resolution_ref");
  const next: QcFinding = { ...finding, resolution: i.resolution, resolution_ref: i.resolution_ref };
  return { finding: next, event: emit(events, finding.application_id, "qc.finding.resolved", { finding_id: finding.finding_id, review_id: finding.review_id, resolution: i.resolution, resolution_ref: i.resolution_ref, defect_code: finding.defect_code, severity: finding.severity }, i.at, actor) };
}
/** The production agent / `underwriting_reviewer` rebuts with evidence inside the window: `qc.finding.rebutted`. */
export function recordRebuttal(events: EventStore, finding: QcFinding, i: { by_agent_run_id: string; text: string; evidence_refs: readonly EvidenceRef[]; at: string }, actor: Actor): { finding: QcFinding; event: DomainEvent } {
  need(finding.status === "released", `${finding.finding_id} is ${finding.status}, not released`); nonEmpty(i.text, "text");
  const next: QcFinding = { ...finding, status: "rebutted", rebuttal: { by_agent_run_id: i.by_agent_run_id, text: i.text, evidence_refs: [...i.evidence_refs], at: i.at } };
  return { finding: next, event: emit(events, finding.application_id, "qc.finding.rebutted", { finding_id: finding.finding_id, review_id: finding.review_id, by_agent_run_id: i.by_agent_run_id, evidence_refs: i.evidence_refs, rebutted_at: i.at }, i.at, actor) };
}
/** The QC agent evaluates a rebuttal: accepted → `withdrawn` with the rationale; otherwise `sustained`. A rebuttal that is itself a new document runs `document_integrity_checks` first. */
export function evaluateRebuttal(events: EventStore, finding: QcFinding, i: { accepted: boolean; rationale: string; at: string; new_document_integrity?: "pass" | "warn" | "fail" | null }, actor: Actor = QC_AGENT): { finding: QcFinding; event: DomainEvent } {
  need(finding.status === "rebutted", `${finding.finding_id} is ${finding.status}, not rebutted`); nonEmpty(i.rationale, "rationale");
  if (i.new_document_integrity !== undefined && i.new_document_integrity !== null && i.new_document_integrity !== "pass") throw new QcRefused("REBUTTAL_DOCUMENT_INTEGRITY_FIRST", "28.1 edge cases: if the rebuttal is itself a new document, `document_integrity_checks` run on it first", `integrity ${i.new_document_integrity}`);
  const next: QcFinding = i.accepted ? { ...finding, status: "withdrawn", resolution: "no_action_rebuttal_accepted", resolved_at: i.at } : { ...finding, status: "sustained" };
  return { finding: next, event: emit(events, finding.application_id, i.accepted ? "qc.finding.withdrawn" : "qc.finding.sustained", { finding_id: finding.finding_id, review_id: finding.review_id, rationale: i.rationale, by: "qc-audit" }, i.at, actor) };
}
/** Rebuttal window breach: the finding is sustained by default; the hold persists. */
export function rebuttalWindowExpired(events: EventStore, finding: QcFinding, at: string, actor: Actor = QC_AGENT): { finding: QcFinding; event: DomainEvent | null } {
  if (finding.status !== "released" || finding.resolution !== null) return { finding, event: null };
  return { finding: { ...finding, status: "sustained" }, event: emit(events, finding.application_id, "qc.finding.sustained", { finding_id: finding.finding_id, review_id: finding.review_id, by: "SM_QC_REBUTTAL_WINDOW_1BD breach", hold: "persists" }, at, actor) };
}
/** QC re-tests the corrected item (new evidence sourced by production): `corrected`. */
export function correctFinding(events: EventStore, finding: QcFinding, i: { retest_evidence_refs: readonly EvidenceRef[]; at: string; observed_value?: string | null }, actor: Actor = QC_AGENT): { finding: QcFinding; event: DomainEvent } {
  need(["released", "rebutted", "sustained"].includes(finding.status), `${finding.finding_id} is ${finding.status}`); need(i.retest_evidence_refs.length > 0, "retest_evidence_refs");
  const next: QcFinding = { ...finding, status: "corrected", resolved_at: i.at, resolution: finding.resolution ?? "data_corrected", evidence_refs: [...finding.evidence_refs, ...i.retest_evidence_refs], observed_value: i.observed_value === undefined ? finding.observed_value : i.observed_value };
  return { finding: next, event: emit(events, finding.application_id, "qc.finding.corrected", { finding_id: finding.finding_id, review_id: finding.review_id, defect_code: finding.defect_code, retest_evidence_refs: i.retest_evidence_refs, corrected_at: i.at }, i.at, actor) };
}
/** T7: a `data_integrity/du_input_variance` finding is corrected only by a DU resubmission (23.1) whose request payload carries the recomputed value. */
export function resolveByDuResubmission(events: EventStore, finding: QcFinding, i: { submission_id: string; resubmitted_monthly_income_cents: Cents; recomputed_monthly_income_cents: Cents; at: string }, actor: Actor = QC_AGENT): { finding: QcFinding; events: DomainEvent[] } {
  need(finding.defect_code === "data_integrity/du_input_variance", `${finding.finding_id} is ${finding.defect_code}`);
  if (i.resubmitted_monthly_income_cents !== i.recomputed_monthly_income_cents) throw new QcRefused("DU_RESUBMISSION_DOES_NOT_MATCH", "28.1 rule 4(a) / A3-4-02: all data entered into DU must be verifiable — the resubmission must carry the recomputed figure", `${money(i.resubmitted_monthly_income_cents)} ≠ ${money(i.recomputed_monthly_income_cents)}`);
  const r = recordFindingResolution(events, finding, { resolution: "data_corrected", resolution_ref: i.submission_id, at: i.at }, actor);
  const c = correctFinding(events, r.finding, { retest_evidence_refs: [{ document_id: i.submission_id, extraction_id: "du_request_payload" }], at: i.at, observed_value: money(i.resubmitted_monthly_income_cents) }, actor);
  return { finding: c.finding, events: [r.event, c.event] };
}

// ============================================================ Reg Z consummation arithmetic the corrected file must still satisfy (T5, 25.2's gate)
/** CD received (e-sign confirmation) on `received_on` → earliest consummation = +3 `business_days_regz_specific` (Saturdays count; Sundays and federal holidays do not). */
export function earliestConsummation(received_on: PlainDate): { earliest: PlainDate; counted: PlainDate[] } {
  const counted: PlainDate[] = []; let d = received_on;
  while (counted.length < 3) { d = addBusinessDays(d, 1, regzSpecific); counted.push(d); }
  return { earliest: counted[2]!, counted };
}

// ============================================================ rule 7/8 — metrics, trends, the monthly report, the officer-concurrence loop
export interface OfficerStats { readonly findings_reviewed: number; readonly findings_concurred: number; readonly no_defect_sampled: number; readonly no_defect_concurred: number; }
export interface MonthlyMetrics {
  readonly period: string; readonly eligible_population: number; readonly reviews_completed: number; readonly reviews_cancelled: number; readonly sample_pct: number;
  readonly random_selected: number; readonly risk_trigger_selected: number; readonly random_hits_in_triggers: number; readonly full_file: number; readonly component: number;
  readonly sustained_sev12_findings: number; readonly prefunding_defect_rate_pct: number; readonly by_defect_code: Record<string, number>; readonly by_category: Record<string, number>;
  readonly avg_selection_to_release_bd: number | null; readonly officer_concurrence_pct: number | null; readonly stratum_defect_rates: { random_pct: number; model_monitoring_pct: number };
  readonly trends: { defect_code: string; loans: number; share_pct: number }[]; readonly watch_list: { defect_code: string; loans: number }[];
}
export interface MetricsInput { readonly period_month: PlainDate; readonly eligible_population: number; readonly reviews: readonly QcReview[]; readonly findings: readonly QcFinding[]; readonly officer: OfficerStats | null; readonly calendar?: Calendar; }
/** D1-1-03 metrics: `prefunding_defect_rate_by_severity = findings(sev ≤ 2, sustained) / reviews_completed` (3 / 33 = 9.1%); `sample_pct = reviews_completed / eligible_population` (33 / 118 = 28.0%); trend = the same defect code in ≥ 3 loans or ≥ 10% of reviews. */
export function computeMetrics(i: MetricsInput): MonthlyMetrics {
  const period = i.period_month.slice(0, 7); const cal = i.calendar ?? creditor;
  const completed = i.reviews.filter((r) => r.status === "closed" || r.status === "unable_to_complete");
  const cancelled = i.reviews.filter((r) => r.status === "cancelled");
  const ids = new Set(completed.map((r) => r.review_id));
  const sustained = i.findings.filter((f) => ids.has(f.review_id) && f.severity <= 2 && f.status !== "withdrawn" && f.status !== "draft");
  const by = (k: (f: QcFinding) => string) => { const o: Record<string, number> = {}; for (const f of sustained) o[k(f)] = (o[k(f)] ?? 0) + 1; return o; };
  const loansByCode: Record<string, Set<string>> = {}; for (const f of sustained) (loansByCode[f.defect_code] ??= new Set()).add(f.application_id);
  const trends = Object.entries(loansByCode).map(([defect_code, s]) => ({ defect_code, loans: s.size, share_pct: pct1(s.size, completed.length) })).filter((t) => t.loans >= TREND_MIN_LOANS || (completed.length > 0 && t.loans / completed.length >= TREND_MIN_SHARE));
  const watch = Object.entries(loansByCode).map(([defect_code, s]) => ({ defect_code, loans: s.size })).filter((t) => t.loans >= 2 && !trends.some((x) => x.defect_code === t.defect_code));
  const releaseLags = i.findings.filter((f) => ids.has(f.review_id) && f.released_at).map((f) => { const r = completed.find((x) => x.review_id === f.review_id)!; return businessDaysBetween(dateOf(r.selected_at), dateOf(f.released_at!), cal); });
  const strat = (basis: SelectionBasis) => { const rs = completed.filter((r) => r.selection_basis === basis); const n = sustained.filter((f) => rs.some((r) => r.review_id === f.review_id)).length; return pct1(n, rs.length); };
  const officer = i.officer ? pct1(i.officer.findings_concurred + i.officer.no_defect_concurred, i.officer.findings_reviewed + i.officer.no_defect_sampled) : null;
  return { period, eligible_population: i.eligible_population, reviews_completed: completed.length, reviews_cancelled: cancelled.length, sample_pct: pct1(completed.length, i.eligible_population),
    random_selected: completed.filter((r) => r.selection_basis === "random").length, risk_trigger_selected: completed.filter((r) => r.selection_basis === "risk_trigger").length, random_hits_in_triggers: completed.filter((r) => r.selection_basis === "risk_trigger" && r.random_hit).length,
    full_file: completed.filter((r) => r.review_type === "full_file").length, component: completed.filter((r) => r.review_type === "component").length,
    sustained_sev12_findings: sustained.length, prefunding_defect_rate_pct: pct1(sustained.length, completed.length), by_defect_code: by((f) => f.defect_code), by_category: by((f) => f.category),
    avg_selection_to_release_bd: releaseLags.length ? Math.round((releaseLags.reduce((a, b) => a + b, 0) / releaseLags.length) * 10) / 10 : null, officer_concurrence_pct: officer,
    stratum_defect_rates: { random_pct: strat("random"), model_monitoring_pct: strat("model_monitoring") }, trends, watch_list: watch };
}
/** Rule 8: `completion_date` = the last review's `closed_at` date; `report_due = completion_date + 30 calendar days` (Fri Oct 30 → Sun Nov 29; Mon Nov 30 → Wed Dec 30); issued by policy on the last business day before the due date (Fri Nov 27). */
export function reportDue(completion_date: PlainDate, cal: Calendar = creditor): { due: PlainDate; issue_target: PlainDate } {
  const due = addDays(completion_date, REPORT_DUE_DAYS);
  return { due, issue_target: rollBack(addDays(due, -1), cal) };
}
/** All reviews of the period terminal → `qc.sample.completed{kind=prefunding, completion_date}` arms FNMA_D1_1_03_PREFUNDING_REPORT_30 (+30 calendar days). */
export function sampleCompletion(events: EventStore, plan: QcSamplePlan, reviews: readonly QcReview[], at: string, actor: Actor = QC_AGENT): { complete: boolean; completion_date: PlainDate | null; report_due: PlainDate | null; issue_target: PlainDate | null; event: DomainEvent | null } {
  const mine = reviews.filter((r) => r.sample_plan_id === plan.sample_plan_id);
  if (!mine.length || mine.some((r) => !TERMINAL_STATUSES.includes(r.status))) return { complete: false, completion_date: null, report_due: null, issue_target: null, event: null };
  const completion_date = mine.map((r) => dateOf(r.closed_at!)).reduce((a, b) => (b > a ? b : a));
  const d = reportDue(completion_date);
  return { complete: true, completion_date, report_due: d.due, issue_target: d.issue_target, event: emitProgram(events, { kind: "qc_sample_plan", id: plan.sample_plan_id }, "qc.sample.completed", { sample_plan_id: plan.sample_plan_id, kind: "prefunding", period_month: plan.period_month, completion_date, reviews: mine.length, report_due: d.due, issue_target: d.issue_target }, at, actor) };
}
/** Trend → a written corrective-action plan with owner, expected resolution and due date (D1-1-01); tracked to completion by compliance-sentinel. */
export function correctiveActionPlan(i: { defect_code: string; loans: number; action: string; owner: string; expected_resolution: string; due_date: PlainDate }): CorrectiveActionPlan {
  nonEmpty(i.action, "action"); nonEmpty(i.owner, "owner"); nonEmpty(i.expected_resolution, "expected_resolution"); nonEmpty(i.due_date, "due_date");
  return { trend: `${i.defect_code} in ${i.loans} loans`, action: i.action, owner: i.owner, expected_resolution: i.expected_resolution, due_date: i.due_date, status: "open", tracker: SENTINEL };
}
export interface ReportInput { readonly report_id?: string; readonly partner_id: string; readonly plan: QcSamplePlan; readonly current: MonthlyMetrics; readonly prior: readonly MonthlyMetrics[]; readonly corrective_action_plans: readonly CorrectiveActionPlan[]; readonly completion_date: PlainDate; readonly at: string; readonly content_document_id?: string | null; /** the program's first two months have no three-month history yet — the report says so instead of being refused */ readonly first_months_of_program?: boolean; }
/** The monthly prefunding report: three-month trend (D1-1-03), the sample description ("33 of 118 eligible; 28.0%"), consistent categories/severities, every trend with a corrective-action plan. `qc.report.issued{kind=prefunding_monthly, issued_at}` arms SM_QC_REPORT_SIGNOFF_SLA_3BD. */
export function draftMonthlyReport(events: EventStore, i: ReportInput, actor: Actor = QC_AGENT): { report: QcReport; events: DomainEvent[] } {
  nonEmpty(i.partner_id, "partner_id"); nonEmpty(i.at, "at"); need(!!i.current, "current metrics");
  const trend = [...i.prior, i.current].sort((a, b) => a.period.localeCompare(b.period)).slice(-TREND_WINDOW_MONTHS);
  if (trend.length < TREND_WINDOW_MONTHS && i.first_months_of_program !== true) throw new QcRefused("TREND_WINDOW_SHORT", "D1-1-03: prefunding reports include defect trending for at least three months", `${trend.length} month(s)`);
  const uncovered = i.current.trends.filter((t) => !i.corrective_action_plans.some((p) => p.trend.startsWith(t.defect_code)));
  if (uncovered.length) throw new QcRefused("TREND_NEEDS_CORRECTIVE_ACTION_PLAN", "D1-1-01: when trends are identified the lender must establish a written action plan with the expected resolution and the time frame", uncovered.map((t) => `${t.defect_code} (${t.loans} loans)`).join(", "));
  const { due } = reportDue(i.completion_date);
  const issued_on = dateOf(i.at);
  const report: QcReport = { report_id: i.report_id ?? `qcrp:${i.partner_id}:prefunding:${i.current.period}`, partner_id: i.partner_id, kind: "prefunding_monthly", period: i.current.period, sample_plan_id: i.plan.sample_plan_id, metrics: i.current, trend, trend_window_months: trend.length,
    sample_description: `${i.current.reviews_completed} of ${i.current.eligible_population} eligible loans reviewed (${i.current.sample_pct.toFixed(1)}%): random target ${i.plan.random_target} (${i.current.random_selected} random, ${i.current.risk_trigger_selected} risk-trigger of which ${i.current.random_hits_in_triggers} also random hits; ${i.current.full_file} full-file, ${i.current.component} component); criteria ${i.plan.risk_trigger_set_version}`,
    issued_at: i.at, due_at: due, issued_late: issued_on > due, signed_by_qc_officer_at: null, acknowledged_by_management_at: null, corrective_action_plans: [...i.corrective_action_plans], content_document_id: i.content_document_id ?? null, retention_class: RETENTION_CLASS_QC };
  const agg = { kind: "qc_sample_plan", id: i.plan.sample_plan_id };
  const out: DomainEvent[] = [emitProgram(events, agg, "qc.report.issued", { report_id: report.report_id, kind: "prefunding_monthly", period: report.period, partner_id: i.partner_id, sample_plan_id: i.plan.sample_plan_id, issued_at: i.at, due_at: due, late: report.issued_late, trend_window_months: report.trend_window_months, trend_periods: trend.map((t) => t.period), sample_description: report.sample_description, defect_rate_pct: i.current.prefunding_defect_rate_pct, corrective_action_plans: report.corrective_action_plans.length, audience: "partner management" }, i.at, actor)];
  for (const p of report.corrective_action_plans) out.push(emitProgram(events, agg, "qc.corrective_action.opened", { report_id: report.report_id, trend: p.trend, action: p.action, owner: p.owner, expected_resolution: p.expected_resolution, due_date: p.due_date, tracker: p.tracker, status: p.status }, i.at, actor));
  return { report, events: out };
}
/** The `qc_officer` signs the report (`qc.report.signed{kind}` satisfies FNMA_D1_1_03_PREFUNDING_REPORT_30 and SM_QC_REPORT_SIGNOFF_SLA_3BD); partner management acknowledges separately. */
export function signReport(events: EventStore, report: QcReport, i: { officer: Actor; at: string }): { report: QcReport; event: DomainEvent } {
  if (!isQcOfficer(i.officer)) throw new QcRefused("REPORT_SIGN_NEEDS_QC_OFFICER", "28.1 automation class (b): the `qc_officer` signs the monthly report", `${i.officer.kind}:${i.officer.id}`);
  need(report.signed_by_qc_officer_at === null, `${report.report_id} already signed`);
  const next: QcReport = { ...report, signed_by_qc_officer_at: i.at };
  return { report: next, event: emitProgram(events, { kind: "qc_sample_plan", id: report.sample_plan_id ?? report.partner_id }, "qc.report.signed", { report_id: report.report_id, kind: report.kind, period: report.period, signed_at: i.at, officer_id: i.officer.id, within_due: report.due_at === null || dateOf(i.at) <= report.due_at }, i.at, i.officer) };
}
export function acknowledgeReport(events: EventStore, report: QcReport, i: { officer: Actor; at: string }): { report: QcReport; event: DomainEvent } {
  if (!(i.officer.kind === "human" && i.officer.role === "officer")) throw new QcRefused("REPORT_ACK_NEEDS_PARTNER_OFFICER", "28.1 escalations: partner `officer` acknowledges the report", `${i.officer.kind}:${i.officer.id}`);
  const next: QcReport = { ...report, acknowledged_by_management_at: i.at };
  return { report: next, event: emitProgram(events, { kind: "qc_sample_plan", id: report.sample_plan_id ?? report.partner_id }, "qc.report.acknowledged", { report_id: report.report_id, kind: report.kind, acknowledged_at: i.at, officer_id: i.officer.id }, i.at, i.officer) };
}
/** Rule 6: officer concurrence below 90% in a month → 31.2 model review and the officer sample doubles for the following month (10% → 20%). */
export function officerConcurrenceReview(events: EventStore, escalations: EscalationService, i: { partner_id: string; period: string; officer: OfficerStats; current_sample_rate?: number; at: string }, actor: Actor = QC_AGENT): { concurrence_pct: number; below_floor: boolean; next_month_sample_rate: number; escalation: Escalation | null; event: DomainEvent | null } {
  const reviewed = i.officer.findings_reviewed + i.officer.no_defect_sampled; const concurred = i.officer.findings_concurred + i.officer.no_defect_concurred;
  const pct = pct1(concurred, reviewed); const rate = i.current_sample_rate ?? OFFICER_SAMPLE_RATE_DEFAULT;
  const below = reviewed > 0 && pct < CONCURRENCE_FLOOR * 100;
  if (!below) return { concurrence_pct: pct, below_floor: false, next_month_sample_rate: rate, escalation: null, event: null };
  const next_rate = Math.min(1, Math.round(rate * 2 * 100) / 100);
  const escalation = escalations.open({ kind: "sev2", ownerRole: "compliance", severity: "sev2", payload: { route: "31.2 model review", partner_id: i.partner_id, period: i.period, concurrence_pct: pct, floor_pct: CONCURRENCE_FLOOR * 100, next_month_officer_sample_rate: next_rate, agent: QC_AGENT_ID } }, actor);
  const event = emitProgram(events, { kind: "qc_program", id: i.partner_id }, "qc.model_review.requested", { consumer: "31.2", partner_id: i.partner_id, period: i.period, agent: QC_AGENT_ID, concurrence_pct: pct, floor_pct: CONCURRENCE_FLOOR * 100, next_month_officer_sample_rate: next_rate, escalation_id: escalation.id }, i.at, actor);
  return { concurrence_pct: pct, below_floor: true, next_month_sample_rate: next_rate, escalation, event };
}
/** The annual QC-process audit report distributed to partner management (`qc.report.issued{kind=qc_audit_annual}` satisfies FNMA_D1_1_01_QC_AUDIT_ANNUAL). */
export function issueAnnualAuditReport(events: EventStore, i: { partner_id: string; year: number; performed_by: "sm_internal_audit" | "third_party"; findings: readonly string[]; at: string; content_document_id?: string | null }, actor: Actor = QC_AGENT): { report: QcReport; event: DomainEvent } {
  const report: QcReport = { report_id: `qcrp:${i.partner_id}:audit:${i.year}`, partner_id: i.partner_id, kind: "qc_audit_annual", period: String(i.year), sample_plan_id: null, metrics: { performed_by: i.performed_by, findings: [...i.findings] }, trend: [], trend_window_months: 0, sample_description: "QC process audit (D1-1-01): policies, processes and procedures followed by QC staff; assessments recorded and applied consistently", issued_at: i.at, due_at: D(`${i.year + 1}-01-31`), issued_late: dateOf(i.at) > D(`${i.year + 1}-01-31`), signed_by_qc_officer_at: null, acknowledged_by_management_at: null, corrective_action_plans: [], content_document_id: i.content_document_id ?? null, retention_class: RETENTION_CLASS_QC };
  return { report, event: emitProgram(events, { kind: "qc_program", id: i.partner_id }, "qc.report.issued", { report_id: report.report_id, kind: "qc_audit_annual", period: report.period, partner_id: i.partner_id, issued_at: i.at, due_at: report.due_at, distributed_to: "partner management", performed_by: i.performed_by }, i.at, actor) };
}

// ============================================================ decision record (AI agent design; T13)
export interface DecisionRecord28_1 {
  readonly review_id: string; readonly application_id: string; readonly selection_basis: SelectionBasis; readonly reason_codes: readonly string[];
  readonly checklist: readonly { area: ReviewArea; tests: readonly { test_id: string; observed: string; expected: string; result: string; evidence_refs: readonly EvidenceRef[] }[] }[];
  readonly findings: readonly string[]; readonly reverifications: readonly string[]; readonly rule_set_versions: typeof RULE_SETS_28_1; readonly model_version: string; readonly prompt_version: string; readonly inputs_hash: string;
  readonly rationale: string; readonly confidence: number; readonly officer_review: { required: boolean; escalation_id: string | null; decision: string | null; at: string | null }; readonly outcome: ReviewOutcome | null; readonly evidence_hashes: readonly string[];
}
/** `agent_decisions` row for the review: rule-set versions, model/prompt versions, `inputs_hash`, per-test evidence refs — and nothing derived from `applicant_demographics` (assertNoDemographics over every input). */
export function decisionRecord28_1(review: QcReview, i: { tests: readonly ChecklistTest[]; findings: readonly QcFinding[]; reverifications: readonly QcReverification[]; inputs: Record<string, unknown>; rationale: string; confidence: number; officer_review?: DecisionRecord28_1["officer_review"] | null; model_version?: string | null; prompt_version?: string | null }): DecisionRecord28_1 {
  assertNoDemographics(i.inputs, "inputs"); assertNoDemographics(i.tests, "tests"); nonEmpty(i.rationale, "rationale");
  const areas = new Map<ReviewArea, ChecklistTest[]>(); for (const t of i.tests) areas.set(t.area, [...(areas.get(t.area) ?? []), t]);
  const evidence = [...new Set(i.tests.flatMap((t) => t.evidence_refs.map((e) => e.document_id)))].sort().map((d) => sha256(d));
  return { review_id: review.review_id, application_id: review.application_id, selection_basis: review.selection_basis, reason_codes: review.selection_reason_codes,
    checklist: [...areas].map(([area, tests]) => ({ area, tests: tests.map((t) => ({ test_id: t.test_id, observed: t.observed, expected: t.expected, result: t.result, evidence_refs: t.evidence_refs })) })),
    findings: i.findings.filter((f) => f.review_id === review.review_id).map((f) => f.finding_id), reverifications: i.reverifications.filter((r) => r.review_id === review.review_id).map((r) => r.reverification_id),
    rule_set_versions: RULE_SETS_28_1, model_version: i.model_version ?? review.model_version ?? "qc-audit-2026.09", prompt_version: i.prompt_version ?? review.prompt_version ?? "28.1-v1", inputs_hash: sha256(JSON.stringify(i.inputs, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))),
    rationale: i.rationale, confidence: i.confidence, officer_review: i.officer_review ?? { required: false, escalation_id: null, decision: null, at: null }, outcome: review.outcome, evidence_hashes: evidence };
}
/** The closing-date feature is not an input to the finding model (guardrail): strip it before scoring and refuse a suppression flag. */
export function findingModelInputs(i: Record<string, unknown>): Record<string, unknown> {
  if (i.suppress_finding === true || i.closing_date_pressure === true) throw new QcRefused("FINDING_SUPPRESSION", "28.1 guardrails: never suppress a finding on volume or closing-date pressure", "suppression flag set");
  const { closing_date: _c, closing_scheduled_on: _s, days_to_closing: _d, volume_pressure: _v, ...rest } = i; void _c; void _s; void _d; void _v;
  return rest;
}
export const wallDate = (iso: string, tz: string): PlainDate => wallClock(Date.parse(iso), tz).date;
export const endOfPeriod = (period_month: PlainDate): PlainDate => endOfMonth(period_month);
