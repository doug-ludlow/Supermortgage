/**
 * §18.4 operating rules beyond ops.ts (regulatoryActionReceived, regulatoryNoticeSatisfies and
 * subservicingScreen live there): the A3-5-02/03 insurance adequacy worksheet with its tier lines
 * (rule 3) and the corrected requirement it yields; the `officer_review` gate that an unresolved
 * consistency check or an inadequate policy blocks (rule 5 + guardrail); the A4-1-02 / A4-1-03 /
 * "immediate" materiality classification of org-change events with the confidence-0.9 officer
 * hand-off (rule 4 + guardrail) and the recorders that arm their clocks (`org.change.recorded`,
 * `org.change.planned`, `partner.reportable_event.occurred`, `corporate_insurance_policy.recorded`,
 * `regulatory.action.received`, `contract_event.occurred`, `tech_provider.change.intent_declared`,
 * `notice_template.published`, and the scheduler's `period.fiscal_year_end` tick that opens the annual
 * cycle on the entity's `fiscal_year` subject); the A4-1-03 breach action "change blocked in the
 * platform's own records" (platformRecordWrite refuses the org_registry / entity-profile write an open
 * gate covers until Fannie Mae's approval/acknowledgment or an officer waiver with rationale clears it);
 * the A3-5-01 expiry breach that flags the Form 582 cycle (18.4-T4); the `officer_review → submitted
 * (ECRM)` transition the agent cannot take and nobody can take without the ECRM confirmation (18.4-T7,
 * guardrail); the ECRM `human_portal_task`; the org-change / technology-provider notice state machine `detected →
 * classified → drafted → officer_approved → filed → acknowledged` as `regulatory_filings` rows of filing_type
 * org_change_notice / tech_provider_notice (noticeFilingOpen / noticeTransition: the officer approves, the sent evidence
 * files, Fannie Mae's acknowledgment closes) and the `late` flag when past `due_at` (lateFlag); the four corporate letter templates (F582-PKG-v1,
 * F582-PENDING-v1, ORG-CHG-NOTICE-v1, TECH-PROV-NOTICE-v1); and the evidenced satisfying events the
 * process emits for its timers, each on the subject its arming event used — a draft, or a "sent" without
 * an evidence pointer, never produces one (18.4-T6). The A2-1-01 5-BD breach clock is closed by the same
 * officer-recorded `fnma_notices.sent{kind=a2101_event_5bd}` that 19.3's `fnma_notices.recordSent` emits
 * on the `contract_events` subject, so one Fannie Mae notice closes both processes' clocks.
 *
 * Two form582.ts calculators are corrected here rather than used as they stand:
 *  - `insuranceRequirement` always applies the 15% deductible and never caps fidelity at $150M
 *    (A3-5-02: deductible ≤ the higher of 10% / $100,000 at or under $100M; cap $150M) → `requiredInsurance`.
 *  - `orgChangeClocks("immediate")` gives a same-day due date; the platform's proxy for A4-1-03
 *    "immediate written notice" is 1 business day (open decision 18.4-Q3; registry row) → `orgChangeDeadlines`.
 */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt, nextBusinessDay, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Actor, EventInput } from "../../kernel/events/types.ts";
import { type ChangeClass, form582Clocks, insuranceAdequate, orgChangeClocks } from "./form582.ts";
import { regulatoryActionReceived, regulatoryNoticeSatisfies, type QcEscalation } from "./ops.ts";

export type Entity = "supermortgage" | "partner";
type Emitted<P extends Record<string, unknown>> = EventInput<P> & { readonly payload: P };
const QC_AUDIT_AGENT = { kind: "agent", id: "qc-audit" } as const;

// ============================================================ rule 3: insurance adequacy worksheet (A3-5-02/03)
/** $300,000 minimum up to $100M; + 0.150% of the next $400M; + 0.125% of the next $500M; + 0.100% above $1B; cap $150M. */
export const FIDELITY_MINIMUM_CENTS: Cents = 30_000_000n;
export const FIDELITY_CAP_CENTS: Cents = 15_000_000_000n;
/** E&O equals the fidelity amount, capped at $10M (single-family only) / $30M (SF + multifamily). */
export const EO_CAP_SINGLE_FAMILY_CENTS: Cents = 1_000_000_000n;
export const EO_CAP_SF_MULTIFAMILY_CENTS: Cents = 3_000_000_000n;
const TIER_100M: Cents = 10_000_000_000n;
const TIER_500M: Cents = 50_000_000_000n;
const TIER_1B: Cents = 100_000_000_000n;
const pct = (amount: Cents, rate: string): Cents => Decimal.fromBigInt(amount).mul(Decimal.parse(rate)).toScaledInt(0, "HALF_UP");
const slice = (base: Cents, lo: Cents, hi: Cents | null): Cents => (base <= lo ? 0n : (hi !== null && base > hi ? hi : base) - lo);
const minC = (a: Cents, b: Cents): Cents => (a < b ? a : b);
const maxC = (a: Cents, b: Cents): Cents => (a > b ? a : b);

export interface InsuranceWorksheet {
  readonly basis_cents: Cents;
  readonly basis: "highest_monthly_servicing_upb" | "annual_originations_upb";
  /** The four lines of the A3-5-02 tier arithmetic, in order; they sum to `fidelity_uncapped_cents`. */
  readonly minimum_cents: Cents;
  readonly tier_next_400m_cents: Cents;
  readonly tier_next_500m_cents: Cents;
  readonly tier_above_1b_cents: Cents;
  readonly fidelity_uncapped_cents: Cents;
  readonly fidelity_cents: Cents;
  readonly eo_cap_cents: Cents;
  readonly eo_cents: Cents;
  /** Deductible ≤ the higher of 10% / $100,000 (basis ≤ $100M) or 15% (basis > $100M). */
  readonly deductible_rule: "15_pct" | "greater_of_10_pct_or_100000";
  readonly max_deductible_cents: Cents;
  readonly citation: "Selling Guide A3-5-02 (fidelity bond) / A3-5-03 (E&O)";
}
/** Rule 18.4-3: required coverage from the greater of annual originations UPB (zero for a pure servicer) and highest monthly servicing UPB including loans serviced for others. */
export function insuranceWorksheet(i: { highest_monthly_servicing_upb_cents: Cents; annual_originations_upb_cents?: Cents; multifamily?: boolean }): InsuranceWorksheet {
  const orig = i.annual_originations_upb_cents ?? 0n;
  const basis: InsuranceWorksheet["basis"] = i.highest_monthly_servicing_upb_cents >= orig ? "highest_monthly_servicing_upb" : "annual_originations_upb";
  const basis_cents = maxC(i.highest_monthly_servicing_upb_cents, orig);
  const minimum_cents = FIDELITY_MINIMUM_CENTS;
  const tier_next_400m_cents = pct(slice(basis_cents, TIER_100M, TIER_500M), "0.0015");
  const tier_next_500m_cents = pct(slice(basis_cents, TIER_500M, TIER_1B), "0.00125");
  const tier_above_1b_cents = pct(slice(basis_cents, TIER_1B, null), "0.0010");
  const fidelity_uncapped_cents = minimum_cents + tier_next_400m_cents + tier_next_500m_cents + tier_above_1b_cents;
  const fidelity_cents = minC(fidelity_uncapped_cents, FIDELITY_CAP_CENTS);
  const eo_cap_cents = i.multifamily === true ? EO_CAP_SF_MULTIFAMILY_CENTS : EO_CAP_SINGLE_FAMILY_CENTS;
  const eo_cents = minC(fidelity_cents, eo_cap_cents);
  const deductible_rule: InsuranceWorksheet["deductible_rule"] = basis_cents > TIER_100M ? "15_pct" : "greater_of_10_pct_or_100000";
  const max_deductible_cents = deductible_rule === "15_pct" ? pct(fidelity_cents, "0.15") : maxC(pct(fidelity_cents, "0.10"), 10_000_000n);
  return { basis_cents, basis, minimum_cents, tier_next_400m_cents, tier_next_500m_cents, tier_above_1b_cents, fidelity_uncapped_cents, fidelity_cents, eo_cap_cents, eo_cents, deductible_rule, max_deductible_cents, citation: "Selling Guide A3-5-02 (fidelity bond) / A3-5-03 (E&O)" };
}

export interface InsuranceRequired { readonly fidelity_cents: Cents; readonly eo_cents: Cents; readonly max_deductible_cents: Cents; }
/** The A3-5-02/03 requirement as the worksheet computes it — drop-in for form582.insuranceRequirement, which misses the $150M cap and the ≤ $100M deductible rule. */
export function requiredInsurance(highest_monthly_servicing_upb_cents: Cents, annual_originations_upb_cents: Cents = 0n, multifamily = false): InsuranceRequired {
  const w = insuranceWorksheet({ highest_monthly_servicing_upb_cents, annual_originations_upb_cents, multifamily });
  return { fidelity_cents: w.fidelity_cents, eo_cents: w.eo_cents, max_deductible_cents: w.max_deductible_cents };
}

// ============================================================ rule 5 + guardrail: officer_review gate
/** Rule 5's six checks, the Subservicing-screen reconciliation (rule 2) and the A3-5-01 loss-payee endorsement fidelity/E&O policies must carry (a separate condition from "insurance not expired"). */
export const CONSISTENCY_CHECKS = ["officers_match_resolutions", "vendors_match_adapters", "custodial_accounts_match_cbam", "licenses_match_nmls", "insurance_not_expired", "insurance_fnma_loss_payee", "qc_vendor_oversight_contact", "subservicing_matches_section5_position"] as const;
export interface ConsistencyCheck { readonly code: (typeof CONSISTENCY_CHECKS)[number]; readonly resolved: boolean; readonly detail?: string; }
export interface OfficerReviewGate { readonly allowed: boolean; readonly next_status: "officer_review" | null; readonly blocking: string[]; readonly refusal: string | null; }
/** Guardrail 18.4: any unresolved consistency check blocks `officer_review`; rule 3: a policy below the A3-5-02/03 requirement fails the adequacy check and blocks it too. */
export function officerReviewGate(i: { checks: readonly ConsistencyCheck[]; insurance: { policy_fidelity_cents: Cents; policy_eo_cents: Cents; required: InsuranceRequired } | null }): OfficerReviewGate {
  const blocking: string[] = i.checks.filter((c) => !c.resolved).map((c) => `consistency check ${c.code} unresolved${c.detail ? ` (${c.detail})` : ""}`);
  if (i.insurance !== null && !insuranceAdequate(i.insurance.policy_fidelity_cents, i.insurance.policy_eo_cents, i.insurance.required)) {
    if (i.insurance.policy_fidelity_cents < i.insurance.required.fidelity_cents) blocking.push(`insurance adequacy: fidelity ${i.insurance.policy_fidelity_cents}¢ < required ${i.insurance.required.fidelity_cents}¢ (A3-5-02)`);
    if (i.insurance.policy_eo_cents < i.insurance.required.eo_cents) blocking.push(`insurance adequacy: E&O ${i.insurance.policy_eo_cents}¢ < required ${i.insurance.required.eo_cents}¢ (A3-5-03)`);
  }
  const allowed = blocking.length === 0;
  return { allowed, next_status: allowed ? "officer_review" : null, blocking, refusal: allowed ? null : `officer_review blocked: ${blocking.join("; ")}` };
}

// ============================================================ rule 4 + guardrail: materiality classification
export type OrgChangeKind = "principal_officer" | "senior_management" | "owner_5pct" | "principal_address" | "legal_name" | "financial_position" | "merger_or_reorganization" | "asset_sale_or_purchase" | "legal_structure_or_charter" | "breach_of_agreement" | "material_adverse_change" | "regulatory_action" | "regulator_management_role";
/** A4-1-02: reported within five business days of the occurrence via Pending Actions + the Changes in Lender Organization mailbox. */
const A4102_PENDING_ACTIONS_5BD: ReadonlySet<OrgChangeKind> = new Set<OrgChangeKind>(["principal_officer", "owner_5pct", "breach_of_agreement", "material_adverse_change", "financial_position"]);
/** A4-1-03: prior approval and 60 days' advance written notice. */
const A4103_PRIOR_APPROVAL: ReadonlySet<OrgChangeKind> = new Set<OrgChangeKind>(["merger_or_reorganization", "asset_sale_or_purchase", "owner_5pct", "legal_structure_or_charter"]);
/** A4-1-03: 60 days' advance written notice for other major changes. */
const A4103_ADVANCE_NOTICE_60: ReadonlySet<OrgChangeKind> = new Set<OrgChangeKind>([...A4103_PRIOR_APPROVAL, "senior_management", "financial_position", "legal_name", "principal_address"]);
/** A4-1-03: "immediate written notice" of regulatory actions and of a regulator assuming a management role. */
const A4103_IMMEDIATE: ReadonlySet<OrgChangeKind> = new Set<OrgChangeKind>(["regulatory_action", "regulator_management_role"]);
/** Counsel is in the loop for the changes the Escalations paragraph names: regulatory actions and mergers (and the other prior-approval restructurings). */
const ATTORNEY_KINDS: ReadonlySet<OrgChangeKind> = new Set<OrgChangeKind>(["merger_or_reorganization", "asset_sale_or_purchase", "legal_structure_or_charter", "regulatory_action", "regulator_management_role"]);
export const ORG_CHANGE_CONFIDENCE_FLOOR = 0.9;
export const A4103_BREACH_TEXT = "Selling Guide A4-1-03: \"A seller/servicer's failure to provide adequate written notice of or obtain prior written approval … is a breach of the Lender Contract\"";

export interface OrgChangeClassification {
  readonly classes: ChangeClass[];
  readonly prior_approval_required: boolean;
  readonly decided_by: "agent" | "officer";
  readonly escalation: QcEscalation | null;
}
/** Rule 18.4-4: an event can sit in two lists (a new 5%+ owner needs prior approval and a 5-BD Pending Actions update after occurrence); guardrail: confidence < 0.9 → `officer` decides within the 5-BD window. */
export function classifyOrgChange(i: { kind: OrgChangeKind; confidence: number; occurred_on: PlainDate; cal?: Calendar }): OrgChangeClassification {
  const classes: ChangeClass[] = [];
  if (A4103_IMMEDIATE.has(i.kind)) classes.push("immediate");
  if (A4103_ADVANCE_NOTICE_60.has(i.kind)) classes.push("major_change_60d_advance");
  if (A4102_PENDING_ACTIONS_5BD.has(i.kind)) classes.push("pending_actions_5bd");
  const prior_approval_required = A4103_PRIOR_APPROVAL.has(i.kind);
  if (i.confidence >= ORG_CHANGE_CONFIDENCE_FLOOR) return { classes, prior_approval_required, decided_by: "agent", escalation: null };
  const window = orgChangeDeadlines("pending_actions_5bd", i.occurred_on, null, i.cal ?? fannieEt);
  return { classes, prior_approval_required, decided_by: "officer", escalation: { kind: "officer", severity: "sev2", reason: `org-change classification confidence ${i.confidence} < ${ORG_CHANGE_CONFIDENCE_FLOOR}: officer decides the A4-1-02/A4-1-03 list within the 5-BD window (due ${window.fnma_due})`, due: window.internal_target } };
}

export interface OrgChangeDeadlines { readonly fnma_due: PlainDate; readonly partner_due: PlainDate; readonly internal_target: PlainDate; readonly already_passed: boolean; readonly unit: "business_days_fannie_et" | "calendar_days" | "business_days_servicer"; }
/** form582.orgChangeClocks with the "immediate" class corrected to the 1-business-day proxy (18.4-Q3; FNMA_A4103_REGULATORY_ACTION_IMMEDIATE is `+1 business_days_servicer`); the partner clock is the next `business_days_servicer` day, as SM_PARTNER_NOTIFY_SUB_EVENT_1BD is. */
export function orgChangeDeadlines(cls: ChangeClass, recordedOn: PlainDate, effectiveOn: PlainDate | null, cal: Calendar = fannieEt): OrgChangeDeadlines {
  const partner_due = nextBusinessDay(recordedOn, servicer);
  if (cls === "immediate") { const due = addBusinessDays(recordedOn, 1, servicer); return { fnma_due: due, partner_due, internal_target: recordedOn, already_passed: false, unit: "business_days_servicer" }; }
  const c = orgChangeClocks(cls, recordedOn, effectiveOn, cal);
  return { fnma_due: c.fnma_due, partner_due, internal_target: c.internal_target, already_passed: c.already_passed, unit: cls === "pending_actions_5bd" ? "business_days_fannie_et" : "calendar_days" };
}

// ============================================================ org-change events recorded / planned (A4-1-02 / A4-1-03)
export interface PendingActionRow { readonly entity: Entity; readonly event_kind: OrgChangeKind; readonly occurred_at: PlainDate; readonly fnma_due_at: PlainDate; readonly form582_updated_at: null; readonly email_sent_at: null; readonly document_id: null; }
export interface OrgChangeRecorded {
  readonly classification: OrgChangeClassification;
  /** On the A4-1-02 list: the `org.change.recorded{material}` trigger arms FNMA_A4102_ORG_CHANGE_5BD. */
  readonly material: boolean;
  readonly timer: { readonly code: "FNMA_A4102_ORG_CHANGE_5BD"; readonly anchor: PlainDate; readonly unit: "business_days_fannie_et"; readonly business_days: PlainDate[]; readonly due: PlainDate; readonly internal_target: PlainDate } | null;
  readonly partner_notice: { readonly code: "SM_PARTNER_NOTIFY_SUB_EVENT_1BD"; readonly due: PlainDate } | null;
  /** A Supermortgage event the partner must report: `partner.reportable_event.occurred` arms SM_PARTNER_NOTIFY_SUB_EVENT_1BD on the same org_change subject the partner notice closes. */
  readonly partner_event: Emitted<{ event_kind: OrgChangeKind; source: "org_change"; occurred_at: PlainDate; entity: "supermortgage"; classes: ChangeClass[] }> | null;
  readonly pending_action: PendingActionRow | null;
  readonly draft: { readonly template: "F582-PENDING-v1"; readonly recipient: "changes_in_lender_organization_mailbox"; readonly drafted_on: PlainDate } | null;
  readonly event: Emitted<{ kind: OrgChangeKind; material: boolean; occurred_at: PlainDate; entity: Entity; confidence: number }>;
}
/** A4-1-02 (18.4-T2): a material change recorded on `occurred_on` is due in Pending Actions + the mailbox email within 5 `business_days_fannie_et`; the platform targets day 4; a Supermortgage event the partner must report is passed to the partner by the next business day. */
export function orgChangeRecorded(i: { entity: Entity; kind: OrgChangeKind; occurred_on: PlainDate; confidence: number; cal?: Calendar }): OrgChangeRecorded {
  const cal = i.cal ?? fannieEt;
  const classification = classifyOrgChange({ kind: i.kind, confidence: i.confidence, occurred_on: i.occurred_on, cal });
  const material = classification.classes.includes("pending_actions_5bd");
  const clocks = material ? orgChangeDeadlines("pending_actions_5bd", i.occurred_on, null, cal) : null;
  const business_days = [1, 2, 3, 4, 5].map((k) => addBusinessDays(i.occurred_on, k, cal));
  const id = `${i.entity}:${i.kind}:${i.occurred_on}`;
  const reportable = i.entity === "supermortgage" && classification.classes.length > 0;
  return {
    classification, material,
    timer: clocks ? { code: "FNMA_A4102_ORG_CHANGE_5BD", anchor: i.occurred_on, unit: "business_days_fannie_et", business_days, due: clocks.fnma_due, internal_target: clocks.internal_target } : null,
    partner_notice: reportable ? { code: "SM_PARTNER_NOTIFY_SUB_EVENT_1BD", due: nextBusinessDay(i.occurred_on, servicer) } : null,
    partner_event: reportable ? { type: "partner.reportable_event.occurred", actor: QC_AUDIT_AGENT, aggregate: { kind: "org_change", id }, payload: { event_kind: i.kind, source: "org_change", occurred_at: i.occurred_on, entity: "supermortgage", classes: classification.classes } } : null,
    pending_action: clocks ? { entity: i.entity, event_kind: i.kind, occurred_at: i.occurred_on, fnma_due_at: clocks.fnma_due, form582_updated_at: null, email_sent_at: null, document_id: null } : null,
    draft: clocks ? { template: "F582-PENDING-v1", recipient: "changes_in_lender_organization_mailbox", drafted_on: i.occurred_on } : null,
    event: { type: "org.change.recorded", actor: QC_AUDIT_AGENT, aggregate: { kind: "org_change", id }, payload: { kind: i.kind, material, occurred_at: i.occurred_on, entity: i.entity, confidence: i.confidence } },
  };
}

export interface MajorChangePlanned {
  readonly gate: { readonly code: "FNMA_A4103_MAJOR_CHANGE_ADVANCE_60"; readonly anchor: PlainDate; readonly notice_needed_by: PlainDate; readonly recorded_on: PlainDate; readonly already_passed: boolean; readonly days_late: number; readonly prior_approval_required: boolean; readonly blocked: boolean; readonly unblocked_by: typeof GATE_CLEARED_PATTERN };
  /** The open gate as platformRecordWrite consults it: the change stays blocked in the platform's own records until majorChangeGateCleared records the clearance. */
  readonly gate_record: MajorChangeGateRecord;
  readonly breach: string | null;
  readonly escalations: QcEscalation[];
  readonly draft: { readonly template: "ORG-CHG-NOTICE-v1"; readonly kind: "prior_approval_request" | "advance_notice"; readonly drafted_on: PlainDate; readonly recipient: "fnma_customer_account_team"; readonly citation: string };
  /** Edge case "Ownership change discovered late": the 5-BD Pending Actions update applies after occurrence as well. */
  readonly pending_actions_after_occurrence: { readonly code: "FNMA_A4102_ORG_CHANGE_5BD"; readonly anchor: PlainDate; readonly due: PlainDate } | null;
  readonly event: Emitted<{ major: true; kind: OrgChangeKind; planned_effective_date: PlainDate; recorded_on: PlainDate; prior_approval_required: boolean; ownership_pct_bps: number | null; entity: Entity }>;
}
/** A4-1-03 (18.4-T5): a planned major change needs written notice ≥ 60 calendar days before its effective date (prior approval where required); recorded inside the window, the gate shows the deadline already passed, the change stays blocked in the platform's own records, and `officer`/`attorney` are escalated. */
export function majorChangePlanned(i: { entity: Entity; kind: OrgChangeKind; planned_effective_on: PlainDate; recorded_on: PlainDate; ownership_pct_bps?: number | null; cal?: Calendar }): MajorChangePlanned {
  if (!A4103_ADVANCE_NOTICE_60.has(i.kind)) throw new RangeError(`${i.kind} is not an A4-1-03 major change`);
  const prior_approval_required = A4103_PRIOR_APPROVAL.has(i.kind);
  const notice_needed_by = addDays(i.planned_effective_on, -60);
  const already_passed = notice_needed_by < i.recorded_on;
  const days_late = already_passed ? daysBetween(notice_needed_by, i.recorded_on) : 0;
  const what = prior_approval_required ? "prior approval and 60 days' advance written notice" : "60 days' advance written notice";
  const escalations: QcEscalation[] = already_passed
    ? [
      { kind: "officer", severity: "sev1", reason: `${i.kind} effective ${i.planned_effective_on} recorded ${i.recorded_on}: the A4-1-03 notice was needed by ${notice_needed_by} (${days_late} days ago) — notify Fannie Mae immediately with an explanation; ${what} not given is a Lender Contract breach`, due: i.recorded_on },
      { kind: "attorney", severity: "sev1", reason: `A4-1-03 breach exposure on a ${i.kind}${prior_approval_required ? " requiring prior written approval" : ""}: counsel review of the late notice and the Lender Contract consequences`, due: i.recorded_on },
    ]
    : [
      { kind: "officer", severity: "sev2", reason: `${i.kind} effective ${i.planned_effective_on}: sign the ${prior_approval_required ? "prior-approval request" : "advance notice"} (ORG-CHG-NOTICE-v1) by ${notice_needed_by}`, due: notice_needed_by },
      ...(ATTORNEY_KINDS.has(i.kind) ? [{ kind: "attorney", severity: "sev3", reason: `counsel review of the ${i.kind} notice/approval package (A4-1-03)`, due: notice_needed_by } as QcEscalation] : []),
    ];
  const org_change_id = `${i.entity}:${i.kind}:${i.planned_effective_on}`;
  const gate_record: MajorChangeGateRecord = { org_change_id, entity: i.entity, kind: i.kind, planned_effective_date: i.planned_effective_on, notice_needed_by, prior_approval_required, cleared: null };
  return {
    gate: { code: "FNMA_A4103_MAJOR_CHANGE_ADVANCE_60", anchor: i.planned_effective_on, notice_needed_by, recorded_on: i.recorded_on, already_passed, days_late, prior_approval_required, blocked: gateBlocked(gate_record), unblocked_by: GATE_CLEARED_PATTERN },
    gate_record,
    breach: already_passed ? A4103_BREACH_TEXT : null,
    escalations,
    draft: { template: "ORG-CHG-NOTICE-v1", kind: prior_approval_required ? "prior_approval_request" : "advance_notice", drafted_on: i.recorded_on, recipient: "fnma_customer_account_team", citation: `Selling Guide A4-1-03: ${what}` },
    pending_actions_after_occurrence: A4102_PENDING_ACTIONS_5BD.has(i.kind) ? { code: "FNMA_A4102_ORG_CHANGE_5BD", anchor: i.planned_effective_on, due: addBusinessDays(i.planned_effective_on, 5, i.cal ?? fannieEt) } : null,
    event: { type: "org.change.planned", actor: QC_AUDIT_AGENT, aggregate: { kind: "org_change", id: org_change_id }, payload: { major: true, kind: i.kind, planned_effective_date: i.planned_effective_on, recorded_on: i.recorded_on, prior_approval_required, ownership_pct_bps: i.ownership_pct_bps ?? null, entity: i.entity } },
  };
}

// ============================================================ A4-1-03 breach action: change blocked in the platform's own records
export const GATE_CLEARED_PATTERN = "org_change.gate.cleared{by∈{fnma_approval, fnma_acknowledgment, officer_waiver}, document_id present, basis present}" as const;
export type GateClearedBy = "fnma_approval" | "fnma_acknowledgment" | "officer_waiver";
export interface GateClearance { readonly by: GateClearedBy; readonly document_id: string; readonly basis: string; readonly officer_id: string | null; readonly cleared_on: PlainDate; }
export interface MajorChangeGateRecord { readonly org_change_id: string; readonly entity: Entity; readonly kind: OrgChangeKind; readonly planned_effective_date: PlainDate; readonly notice_needed_by: PlainDate; readonly prior_approval_required: boolean; readonly cleared: GateClearance | null; }
/** The platform's own records an open gate covers: org_registry rows (owners ≥ 5%, officers, directors) and the entity profile (legal name, principal address, legal structure). */
export type PlatformRecordWrite =
  | { readonly record: "org_registry"; readonly role: "owner" | "officer" | "director"; readonly ownership_pct_bps?: number | null; readonly effective_from: PlainDate; readonly org_change_id?: string | null }
  | { readonly record: "entity_profile"; readonly field: "legal_name" | "principal_address" | "legal_structure" | "other"; readonly effective_from: PlainDate; readonly org_change_id?: string | null };
export const OWNER_5PCT_BPS = 500;
const gateBlocked = (g: MajorChangeGateRecord): boolean => g.cleared === null;
/** Which record writes an open gate of this kind covers (a write that names the gate's org_change_id is covered whatever its shape). */
function gateCovers(g: MajorChangeGateRecord, w: PlatformRecordWrite): boolean {
  if (w.org_change_id && w.org_change_id === g.org_change_id) return true;
  switch (g.kind) {
    case "owner_5pct": case "merger_or_reorganization": case "asset_sale_or_purchase": case "legal_structure_or_charter":
      return (w.record === "org_registry" && w.role === "owner" && (w.ownership_pct_bps ?? 0) >= OWNER_5PCT_BPS) || (w.record === "entity_profile" && w.field === "legal_structure");
    case "senior_management": return w.record === "org_registry" && (w.role === "officer" || w.role === "director");
    case "legal_name": return w.record === "entity_profile" && w.field === "legal_name";
    case "principal_address": return w.record === "entity_profile" && w.field === "principal_address";
    default: return false;
  }
}
/** Breach action of FNMA_A4103_MAJOR_CHANGE_ADVANCE_60: while a gate is open, the write that would make the change effective in the platform's own records is refused — until Fannie Mae's approval/acknowledgment is recorded or an `officer` waives with rationale (majorChangeGateCleared). */
export function platformRecordWrite(i: { entity: Entity; write: PlatformRecordWrite; gates: readonly MajorChangeGateRecord[] }): { allowed: boolean; refusal: string | null; blocked_by: MajorChangeGateRecord | null } {
  const blocking = i.gates.find((g) => g.entity === i.entity && gateBlocked(g) && gateCovers(g, i.write)) ?? null;
  if (!blocking) return { allowed: true, refusal: null, blocked_by: null };
  const what = i.write.record === "org_registry" ? `org_registry ${i.write.role} row effective ${i.write.effective_from}` : `entity_profile ${i.write.field} effective ${i.write.effective_from}`;
  return { allowed: false, blocked_by: blocking, refusal: `${what} blocked in the platform's own records: ${blocking.kind} planned ${blocking.planned_effective_date} (${blocking.prior_approval_required ? "prior approval and " : ""}60 days' advance written notice needed by ${blocking.notice_needed_by}) awaits Fannie Mae approval/acknowledgment or an officer waiver with rationale (FNMA_A4103_MAJOR_CHANGE_ADVANCE_60; Selling Guide A4-1-03)` };
}
/** Records the clearance from the evidenced `org_change.gate.cleared` event on the gate's own org_change (any other subject is a programming error). */
export function majorChangeGateCleared(g: MajorChangeGateRecord, ev: Emitted<{ by: string; document_id: string; basis: string; officer_id: string | null }> & { aggregate?: { kind: string; id: string } }, cleared_on: PlainDate): MajorChangeGateRecord {
  if (ev.type !== "org_change.gate.cleared" || ev.aggregate?.kind !== "org_change" || ev.aggregate.id !== g.org_change_id) throw new RangeError(`${ev.type} on ${ev.aggregate?.kind ?? "no subject"} ${ev.aggregate?.id ?? ""} does not clear gate ${g.org_change_id}`);
  return { ...g, cleared: { by: ev.payload.by as GateClearedBy, document_id: ev.payload.document_id, basis: ev.payload.basis, officer_id: ev.payload.officer_id, cleared_on } };
}

// ============================================================ A3-5-01 corporate policy expiry (18.4-T4)
export type CorporatePolicyKind = "fidelity" | "eo" | "cyber" | "other";
export interface CorporatePolicy { readonly policy_id: string; readonly entity: Entity; readonly kind: CorporatePolicyKind; readonly expires_on: PlainDate; readonly coverage_cents?: Cents; readonly fnma_loss_payee?: boolean; }
export const INSURANCE_EXPIRY_WARNING_DAYS = 30;
/** `corporate_insurance_policy.recorded` arms FNMA_A3501_INSURANCE_EXPIRY_30 on the policy (anchor `expires_on`, −30 calendar days); fidelity/E&O policies must name Fannie Mae as loss payee (A3-5-01). */
export function corporateInsurancePolicyRecorded(p: CorporatePolicy): { timer: { code: "FNMA_A3501_INSURANCE_EXPIRY_30"; anchor: PlainDate; due: PlainDate }; loss_payee_check: ConsistencyCheck | null; event: Emitted<{ policy_id: string; kind: CorporatePolicyKind; expires_on: PlainDate; entity: Entity; fnma_loss_payee: boolean }> } {
  const lossPayeeRequired = p.kind === "fidelity" || p.kind === "eo";
  return {
    timer: { code: "FNMA_A3501_INSURANCE_EXPIRY_30", anchor: p.expires_on, due: addDays(p.expires_on, -INSURANCE_EXPIRY_WARNING_DAYS) },
    loss_payee_check: lossPayeeRequired ? { code: "insurance_fnma_loss_payee", resolved: p.fnma_loss_payee === true, ...(p.fnma_loss_payee === true ? {} : { detail: `${p.kind} policy ${p.policy_id} lacks the Fannie Mae loss-payee endorsement (A3-5-01)` }) } : null,
    event: { type: "corporate_insurance_policy.recorded", actor: QC_AUDIT_AGENT, aggregate: { kind: "corporate_insurance_policy", id: p.policy_id }, payload: { policy_id: p.policy_id, kind: p.kind, expires_on: p.expires_on, entity: p.entity, fnma_loss_payee: p.fnma_loss_payee === true } },
  };
}

export interface PolicyRenewal { readonly policy_id: string; readonly renewal_effective_on: PlainDate; readonly recorded_on: PlainDate; readonly document_id: string | null; }
export interface InsuranceExpiryCheck {
  readonly timer: { readonly code: "FNMA_A3501_INSURANCE_EXPIRY_30"; readonly anchor: PlainDate; readonly due: PlainDate; readonly status: "armed" | "breached" | "satisfied" | "satisfied_late"; readonly due_today: boolean };
  readonly renewal: PolicyRenewal | null;
  readonly escalation: QcEscalation | null;
  /** The open Form 582 cycle is flagged: the Insurance Policies screen cannot be verified with an expired policy, so the check blocks `officer_review` until a renewal or emergency binder is evidenced. */
  readonly form582_cycle_flag: { readonly filing_id: string; readonly flag: "INSURANCE_EXPIRY_UNRENEWED"; readonly policy_id: string; readonly kind: CorporatePolicyKind; readonly expires_on: PlainDate; readonly verify_blocked: true; readonly consistency_check: ConsistencyCheck } | null;
}
/** 18.4-T4: a policy expiring on E with no evidenced, no-lapse renewal recorded by E − 30 breaches the expiry timer (sev-1) and flags the entity's open Form 582 cycle. "By E − 30" runs to the end of that day, as the engine's deadline does: on the anchor day the clock is due, from the next day it is breached, and a renewal recorded on the anchor day is on time. A renewal of another policy, an un-evidenced one, or one effective after E (a lapse) does not count. */
export function insuranceExpiryCheck(i: { policy: CorporatePolicy; renewals: readonly PolicyRenewal[]; as_of: PlainDate; form582_cycle: { filing_id: string; status: string } | null }): InsuranceExpiryCheck {
  const due = addDays(i.policy.expires_on, -INSURANCE_EXPIRY_WARNING_DAYS);
  const renewal = i.renewals.find((r) => r.policy_id === i.policy.policy_id && r.document_id !== null && r.document_id !== "" && r.renewal_effective_on <= i.policy.expires_on && r.recorded_on <= i.as_of) ?? null;
  const status: InsuranceExpiryCheck["timer"]["status"] = renewal ? (renewal.recorded_on <= due ? "satisfied" : "satisfied_late") : i.as_of > due ? "breached" : "armed";
  const breached = status === "breached";
  const detail = `${i.policy.kind} policy ${i.policy.policy_id} expires ${i.policy.expires_on}: no renewal recorded by ${due} (A3-5-01; Form 582 cannot verify with an expired policy)`;
  const cycleOpen = i.form582_cycle !== null && !["submitted", "accepted", "corrected"].includes(i.form582_cycle.status);
  return {
    timer: { code: "FNMA_A3501_INSURANCE_EXPIRY_30", anchor: i.policy.expires_on, due, status, due_today: status === "armed" && i.as_of === due },
    renewal,
    escalation: breached ? { kind: "officer", severity: "sev1", reason: `${detail} — obtain the renewal or an emergency binder before the Form 582 cycle can verify`, due: i.policy.expires_on } : null,
    form582_cycle_flag: breached && cycleOpen ? { filing_id: i.form582_cycle!.filing_id, flag: "INSURANCE_EXPIRY_UNRENEWED", policy_id: i.policy.policy_id, kind: i.policy.kind, expires_on: i.policy.expires_on, verify_blocked: true, consistency_check: { code: "insurance_not_expired", resolved: false, detail } } : null,
  };
}

// ============================================================ Form 582 state machine: officer_review → submitted (ECRM) (18.4-T7)
export const FORM582_STATES = ["open", "data_assembled", "registry_verified", "partner_delivered", "officer_review", "submitted", "accepted", "corrected"] as const;
export type FilingType = "form_582" | "afs";
export interface FilingRow { readonly id: string; readonly entity: Entity; readonly filing_type: FilingType; readonly period_end: PlainDate; readonly due_at: PlainDate; readonly status: string; readonly approved_by_officer_id: string | null; readonly package_document_id?: string | null; }
/** ECRM submitters per entity: `fnma_portal_operator` with FORM582_BUSINESS_ROLE at Supermortgage (18.4-Q1); the partner's own designated submitter — Supermortgage's operator never marks the partner's filing submitted. */
export const DESIGNATED_SUBMITTER_ROLES: Record<Entity, readonly string[]> = { supermortgage: ["fnma_portal_operator"], partner: ["partner_designated_submitter"] };
export const designatedSubmitter = (entity: Entity, actor: Actor): boolean => actor.kind === "human" && !!actor.role && DESIGNATED_SUBMITTER_ROLES[entity].includes(actor.role);
export type FilingRefusal = "AGENT_CANNOT_SUBMIT" | "NOT_DESIGNATED_SUBMITTER" | "ECRM_CONFIRMATION_REQUIRED" | "OFFICER_APPROVAL_REQUIRED" | "INVALID_TRANSITION" | "AFS_PACKAGE_REQUIRED";
export interface FilingSubmittedPayload extends Record<string, unknown> { readonly form: FilingType; readonly filing_id: string; readonly entity: Entity; readonly period_end: PlainDate; readonly ecrm_confirmation_document_id: string; readonly approved_by_officer_id: string | null; readonly submitted_by: string; readonly submitted_on: PlainDate; readonly late: boolean; }
export interface FilingSubmission {
  readonly allowed: boolean;
  readonly refusal_codes: FilingRefusal[];
  readonly refusal: string | null;
  /** The row's status after the attempt: unchanged on refusal. */
  readonly state: string;
  /** `late` flag when past `due_at`. */
  readonly late: boolean;
  readonly submission_evidence: string | null;
  readonly event: Emitted<FilingSubmittedPayload> | null;
}
/** Guardrail + 18.4-T7: the agent cannot certify or submit; the designated submitter marks the row `submitted` only with the ECRM confirmation document captured to `documents` and, for Form 582, the officer's approval record from `officer_review`. */
export function filingSubmit(i: { filing: FilingRow; actor: Actor; ecrm_confirmation_document_id: string | null; submitted_on: PlainDate }): FilingSubmission {
  const codes: FilingRefusal[] = [];
  const why: string[] = [];
  if (i.actor.kind !== "human") { codes.push("AGENT_CANNOT_SUBMIT"); why.push(`${i.actor.kind} ${i.actor.id} cannot mark a filing submitted — Form 582 is an officer certification and the ECRM submission is a human_portal_task of the designated submitter (baseline §8 item 3)`); }
  else if (!designatedSubmitter(i.filing.entity, i.actor)) { codes.push("NOT_DESIGNATED_SUBMITTER"); why.push(`${i.actor.role ?? "no role"} is not ${i.filing.entity}'s designated ECRM submitter (FORM582_BUSINESS_ROLE: ${DESIGNATED_SUBMITTER_ROLES[i.filing.entity].join("/")})`); }
  if (!i.ecrm_confirmation_document_id) { codes.push("ECRM_CONFIRMATION_REQUIRED"); why.push("no ECRM submission confirmation document captured"); }
  if (i.filing.filing_type === "form_582") {
    if (i.filing.status !== "officer_review") { codes.push("INVALID_TRANSITION"); why.push(`Form 582 moves to submitted only from officer_review (row is ${i.filing.status})`); }
    if (!i.filing.approved_by_officer_id) { codes.push("OFFICER_APPROVAL_REQUIRED"); why.push("no officer approval record attached (the officer certifies from the console after reviewing the diff)"); }
  } else if (!i.filing.package_document_id) { codes.push("AFS_PACKAGE_REQUIRED"); why.push("no audited financial statements package (independent public accountant's opinion) attached (A4-1-02)"); }
  if (codes.length > 0) return { allowed: false, refusal_codes: codes, refusal: `${i.filing.filing_type} ${i.filing.id} cannot be marked submitted: ${why.join("; ")}`, state: i.filing.status, late: false, submission_evidence: null, event: null };
  const late = lateFlag(i.filing.due_at, i.submitted_on, i.submitted_on);
  const ecrm = i.ecrm_confirmation_document_id!;
  return {
    allowed: true, refusal_codes: [], refusal: null, state: "submitted", late, submission_evidence: ecrm,
    event: { type: "filing.submitted", actor: i.actor, aggregate: { kind: "fiscal_year", id: `${i.filing.entity}:${i.filing.period_end}` }, payload: { form: i.filing.filing_type, filing_id: i.filing.id, entity: i.filing.entity, period_end: i.filing.period_end, ecrm_confirmation_document_id: ecrm, approved_by_officer_id: i.filing.approved_by_officer_id, submitted_by: i.actor.id, submitted_on: i.submitted_on, late } },
  };
}

/** Rule 6 / Integrations: the ECRM submission is a `human_portal_task` for the entity's designated submitter carrying the answer sheet, the evidence index and the officer approval id — never created without the approval. */
export function ecrmPortalTask(i: { filing: FilingRow; answer_sheet_document_id: string | null; evidence_index_document_id: string | null }): { allowed: boolean; refusal: string | null; task: { kind: "human_portal_task"; portal: "ECRM"; assignee_role: "fnma_portal_operator" | "partner_designated_submitter"; filing_id: string; approved_by_officer_id: string; answer_sheet_document_id: string; evidence_index_document_id: string; due_at: PlainDate; capture: "submission confirmation → documents" } | null } {
  if (i.filing.filing_type === "form_582" && (i.filing.status !== "officer_review" || !i.filing.approved_by_officer_id)) return { allowed: false, refusal: `ECRM portal task refused: ${i.filing.id} is ${i.filing.status}${i.filing.approved_by_officer_id ? "" : " without an officer approval record"} — the agent cannot certify`, task: null };
  if (!i.answer_sheet_document_id || !i.evidence_index_document_id) return { allowed: false, refusal: "ECRM portal task refused: answer sheet (F582-PKG-v1) and evidence index are required", task: null };
  return { allowed: true, refusal: null, task: { kind: "human_portal_task", portal: "ECRM", assignee_role: i.filing.entity === "supermortgage" ? "fnma_portal_operator" : "partner_designated_submitter", filing_id: i.filing.id, approved_by_officer_id: i.filing.approved_by_officer_id ?? "", answer_sheet_document_id: i.answer_sheet_document_id, evidence_index_document_id: i.evidence_index_document_id, due_at: i.filing.due_at, capture: "submission confirmation → documents" } };
}

// ============================================================ org-change / technology-provider notice state machine (regulatory_filings rows)
/** State machine (§18.4): `detected → classified → drafted → officer_approved → filed (Pending Actions + email) → acknowledged`. */
export const NOTICE_STATES = ["detected", "classified", "drafted", "officer_approved", "filed", "acknowledged"] as const;
export type NoticeState = (typeof NOTICE_STATES)[number];
export type NoticeFilingType = "org_change_notice" | "tech_provider_notice";
/** `regulatory_filings.status` values past which a row is closed for the `late` sweep: the Form 582/AFS rows' `submitted (ECRM) → accepted | corrected`, the notices' `filed → acknowledged`. */
export const FILING_CLOSED_STATES: readonly string[] = ["submitted", "accepted", "corrected", "filed", "acknowledged"];
/** State machine: "`late` flag when past `due_at`" — an open row is late from the day after due_at; a submitted/filed row when it was submitted past due_at (rule 1: no business-day roll). */
export const lateFlag = (due_at: PlainDate, submitted_on: PlainDate | null, as_of: PlainDate): boolean => (submitted_on ?? as_of) > due_at;
/**
 * A `regulatory_filings` row of filing_type org_change_notice / tech_provider_notice (Outputs: "`regulatory_filings` rows with
 * submission evidence" for the Pending Actions notices, the A4-1-03 advance-notice letters and the technology-provider notices),
 * keyed to the subject its clock is armed on (org_change, regulatory_action, contract_events, tech_provider_change).
 */
export interface NoticeFilingRow {
  readonly id: string; readonly entity: Entity; readonly filing_type: NoticeFilingType;
  readonly subject: { readonly kind: string; readonly id: string };
  readonly template: CorporateTemplate; readonly notice_kind: string;
  readonly period_end: null; readonly due_at: PlainDate; readonly status: NoticeState;
  /** The drafted letter, once rendered to `documents`. */
  readonly package_document_id: string | null;
  readonly approved_by_officer_id: string | null;
  readonly submitted_at: string | null;
  /** The sent-mail / Pending Actions evidence the `filed` step carries. */
  readonly submission_evidence: string | null;
  readonly acknowledgment_document_id: string | null;
  readonly late: boolean;
}
/** Opens the notice row at `detected` (officer decides the classification) or `classified`; the recorders step it to `drafted` when the same-day draft exists. */
export function noticeFilingOpen(i: { subject: { kind: string; id: string }; entity: Entity; filing_type: NoticeFilingType; template: CorporateTemplate; notice_kind: string; due_at: PlainDate; opened_on: PlainDate; status?: "detected" | "classified" }): NoticeFilingRow {
  return { id: `notice-${i.subject.id}`, entity: i.entity, filing_type: i.filing_type, subject: { kind: i.subject.kind, id: i.subject.id }, template: i.template, notice_kind: i.notice_kind, period_end: null, due_at: i.due_at, status: i.status ?? "classified", package_document_id: null, approved_by_officer_id: null, submitted_at: null, submission_evidence: null, acknowledgment_document_id: null, late: lateFlag(i.due_at, null, i.opened_on) };
}
export type NoticeRefusal = "NOTICE_INVALID_TRANSITION" | "NOTICE_OFFICER_APPROVES" | "NOTICE_NOT_OFFICER_APPROVED" | "NOTICE_FILED_EVIDENCE_REQUIRED" | "NOTICE_ACKNOWLEDGMENT_REQUIRED";
export interface NoticeStatusChangedPayload extends Record<string, unknown> { readonly filing_id: string; readonly filing_type: NoticeFilingType; readonly from: NoticeState; readonly to: NoticeState; readonly steps: NoticeState[]; readonly approved_by_officer_id: string | null; readonly submission_evidence: string | null; readonly late: boolean; }
export interface NoticeTransition {
  readonly allowed: boolean;
  readonly refusal_codes: NoticeRefusal[];
  readonly refusal: string | null;
  /** The row after the step — unchanged on refusal. */
  readonly row: NoticeFilingRow;
  /** The states passed through: one, or `officer_approved` then `filed` when the officer's own signed send is the approval. */
  readonly steps: NoticeState[];
  readonly event: Emitted<NoticeStatusChangedPayload> | null;
}
const isOfficer = (a: Actor): boolean => a.kind === "human" && a.role === "officer";
/**
 * One step of the notice state machine. `officer_approved` is the officer's act (guardrail: the agent cannot certify or submit);
 * `filed` needs the submission evidence (sent-mail evidence; for a Pending Actions notice both pointers) and the officer's prior
 * approval — except that the officer sending the signed notice is the approval, so the officer steps drafted → officer_approved →
 * filed in one act; `acknowledged` needs Fannie Mae's acknowledgment/approval document. A filed row is `late` when filed past due_at.
 */
export function noticeTransition(i: { row: NoticeFilingRow; to: NoticeState; actor: Actor; now: string; on: PlainDate; document_id?: string | null; submission_evidence?: string | null; acknowledgment_document_id?: string | null }): NoticeTransition {
  const from = NOTICE_STATES.indexOf(i.row.status), to = NOTICE_STATES.indexOf(i.to);
  const codes: NoticeRefusal[] = []; const why: string[] = [];
  const refuse = (c: NoticeRefusal, w: string): void => { codes.push(c); why.push(w); };
  const officerSend = i.to === "filed" && i.row.status === "drafted" && isOfficer(i.actor);
  if (to === -1) refuse("NOTICE_INVALID_TRANSITION", `${i.to} is not a notice state (${NOTICE_STATES.join(" → ")})`);
  else if (i.to === "filed" && i.row.status === "drafted") { if (!officerSend) refuse("NOTICE_NOT_OFFICER_APPROVED", `${i.row.filing_type} ${i.row.id} is drafted, not officer_approved — the officer approves the notice (or sends it, which is the approval); ${i.actor.kind} ${i.actor.id} cannot certify or submit`); }
  else if (to !== from + 1) refuse("NOTICE_INVALID_TRANSITION", `${i.row.filing_type} ${i.row.id}: ${i.row.status} → ${i.to} is not a step of ${NOTICE_STATES.join(" → ")}`);
  if (i.to === "officer_approved" && !isOfficer(i.actor)) refuse("NOTICE_OFFICER_APPROVES", `${i.actor.kind} ${i.actor.id} cannot approve the notice — the officer signs it (the agent cannot certify or submit)`);
  if (i.to === "filed" && !i.submission_evidence) refuse("NOTICE_FILED_EVIDENCE_REQUIRED", "filed only with the submission evidence (sent-mail evidence; Pending Actions update + email for an A4-1-02 notice)");
  if (i.to === "acknowledged" && !i.acknowledgment_document_id) refuse("NOTICE_ACKNOWLEDGMENT_REQUIRED", "acknowledged only with Fannie Mae's acknowledgment/approval document");
  if (codes.length > 0) return { allowed: false, refusal_codes: codes, refusal: `${i.row.filing_type} ${i.row.id} cannot move to ${i.to}: ${why.join("; ")}`, row: i.row, steps: [], event: null };
  const steps: NoticeState[] = officerSend ? ["officer_approved", "filed"] : [i.to];
  const approved_by_officer_id = i.to === "officer_approved" || officerSend ? i.actor.id : i.row.approved_by_officer_id;
  const row: NoticeFilingRow = {
    ...i.row, status: i.to, approved_by_officer_id,
    package_document_id: i.to === "drafted" && i.document_id ? i.document_id : i.row.package_document_id,
    ...(i.to === "filed" ? { submitted_at: i.now, submission_evidence: i.submission_evidence!, late: lateFlag(i.row.due_at, i.on, i.on) } : {}),
    ...(i.to === "acknowledged" ? { acknowledgment_document_id: i.acknowledgment_document_id! } : {}),
  };
  return { allowed: true, refusal_codes: [], refusal: null, row, steps, event: { type: "filing.status.changed", actor: i.actor, aggregate: { kind: i.row.subject.kind, id: i.row.subject.id }, payload: { filing_id: row.id, filing_type: row.filing_type, from: i.row.status, to: i.to, steps, approved_by_officer_id, submission_evidence: row.submission_evidence, late: row.late } } };
}

// ============================================================ annual cycle: the scheduler's FYE tick (Inputs: `filing.form582.cycle` opens FYE + 1 day)
const SCHEDULER = { kind: "system", id: "scheduler" } as const;
export type FiscalYearEndTick = Emitted<{ entity: Entity; fye: PlainDate; cycle: "form582"; form582_due: PlainDate; afs_due: PlainDate; partner_package_due: PlainDate | null; afs_target: PlainDate; auditor: string | null; afs_expected_at: PlainDate | null }> & { readonly aggregate: { readonly kind: "fiscal_year"; readonly id: string }; readonly occurredAt: string };
/** The `period.fiscal_year_end` tick for an entity's fiscal year, on the `fiscal_year` subject every 18.4 satisfying event for the cycle (filing.submitted, afs.received, partner.data_package.delivered) is emitted on; it occurs at FYE so the +90/+75/+60 clocks anchor there even though the cycle opens the next day. */
export function fiscalYearEndEvent(i: { entity: Entity; fye: PlainDate; auditor?: string | null; afs_expected_at?: PlainDate | null }): FiscalYearEndTick {
  const c = form582Clocks(i.fye);
  return { type: "period.fiscal_year_end", actor: SCHEDULER, aggregate: { kind: "fiscal_year", id: `${i.entity}:${i.fye}` }, occurredAt: `${i.fye}T17:00:00.000Z`, payload: { entity: i.entity, fye: i.fye, cycle: "form582", form582_due: c.due, afs_due: c.due, partner_package_due: i.entity === "partner" ? c.partner_package_due : null, afs_target: c.afs_target, auditor: i.auditor ?? null, afs_expected_at: i.afs_expected_at ?? null } };
}
export interface Form582CycleOpened { readonly opens_on: PlainDate; readonly clocks: ReturnType<typeof form582Clocks>; readonly filings: FilingRow[]; readonly fiscal_year: { entity: Entity; fye_date: PlainDate; auditor: string | null; afs_expected_at: PlainDate | null; afs_commitment_ok: boolean | null }; readonly event: FiscalYearEndTick; }
/** `filing.form582.cycle` / `filing.afs.cycle`: FYE + 1 day opens the entity's Form 582 and AFS `regulatory_filings` rows (`open`, due FYE + 90 — rule 1, no business-day roll) and emits the tick that arms the cycle's clocks; the auditor's AFS delivery commitment must sit ≥ 15 days before the Fannie Mae deadline (prerequisites). */
export function form582CycleOpen(i: { entity: Entity; fye: PlainDate; auditor?: string | null; afs_expected_at?: PlainDate | null }): Form582CycleOpened {
  const clocks = form582Clocks(i.fye);
  const event = fiscalYearEndEvent(i);
  const afs_expected_at = i.afs_expected_at ?? null;
  return {
    opens_on: addDays(i.fye, 1), clocks,
    filings: [
      { id: `f-582-${i.entity}-${i.fye}`, entity: i.entity, filing_type: "form_582", period_end: i.fye, due_at: clocks.due, status: "open", approved_by_officer_id: null, package_document_id: null },
      { id: `f-afs-${i.entity}-${i.fye}`, entity: i.entity, filing_type: "afs", period_end: i.fye, due_at: clocks.due, status: "open", approved_by_officer_id: null, package_document_id: null },
    ],
    fiscal_year: { entity: i.entity, fye_date: i.fye, auditor: i.auditor ?? null, afs_expected_at, afs_commitment_ok: afs_expected_at ? daysBetween(afs_expected_at, clocks.due) >= 15 : null },
    event,
  };
}

// ============================================================ corporate letter templates (Outputs and artifacts)
export type CorporateTemplate = "F582-PKG-v1" | "F582-PENDING-v1" | "ORG-CHG-NOTICE-v1" | "TECH-PROV-NOTICE-v1";
export interface CorporateLetter { readonly template: CorporateTemplate; readonly recipient: string; readonly subject: string; readonly body: string; readonly citation: string; readonly evidence_document_ids: string[]; }
export interface AnswerSheetScreen { readonly screen: string; readonly answers: readonly { question: string; answer: string; changed: boolean; evidence_document_id: string | null }[]; }
type LetterResult = { allowed: true; refusal: null; letter: CorporateLetter } | { allowed: false; refusal: string; letter: null };
const refuseLetter = (template: CorporateTemplate, why: string): LetterResult => ({ allowed: false, refusal: `${template} not rendered: ${why}`, letter: null });
const need = (d: Record<string, unknown>, ...keys: string[]): string[] => keys.filter((k) => d[k] === undefined || d[k] === null || d[k] === "");
const TECH_KIND_TEXT: Record<string, string> = { planned_change: "intends to change a critical technology provider and gives this notice 180 days before the change", termination: "gives notice within 5 business days of the termination of a technology contract", breach: "gives notice within 5 business days of a breach under a technology contract", impairment: "gives notice within 5 business days of an impairment under a technology contract" };
/** No borrower notices in 18.4: these are the corporate letters/packages the spec names, rendered from code templates with the Guide language they must carry; a changed Form 582 answer without an evidence pointer is not rendered (rule 2). */
export function renderCorporateLetter(template: CorporateTemplate, data: Record<string, unknown>): LetterResult {
  const s = (k: string): string => String(data[k] ?? "");
  switch (template) {
    case "F582-PKG-v1": {
      const missing = need(data, "entity", "fye", "due_at", "screens");
      if (missing.length) return refuseLetter(template, `missing ${missing.join(", ")}`);
      const screens = data.screens as readonly AnswerSheetScreen[];
      const unevidenced = screens.flatMap((sc) => sc.answers.filter((a) => a.changed && !a.evidence_document_id).map((a) => `${sc.screen}: ${a.question}`));
      if (unevidenced.length) return refuseLetter(template, `changed answers without an evidence pointer — ${unevidenced.join("; ")}`);
      const evidence = screens.flatMap((sc) => sc.answers.map((a) => a.evidence_document_id).filter((x): x is string => x !== null));
      const body = [`Form 582 Lender Record Information — ${s("entity")} — fiscal year ended ${s("fye")} — due ${s("due_at")} (A4-1-02: "no later than 90 days after the end of the seller/servicer's fiscal year").`,
        ...screens.map((sc) => `[${sc.screen}]\n` + sc.answers.map((a) => `  ${a.question}: ${a.answer}${a.changed ? ` (changed; evidence ${a.evidence_document_id})` : ""}`).join("\n")),
        `Evidence index: ${evidence.length ? evidence.join(", ") : "no changed answers"}.`, `Certification is the officer's act${data.approved_by_officer_id ? ` (approval ${s("approved_by_officer_id")})` : " — pending officer approval"}; submitted in ECRM by the designated submitter (FORM582_BUSINESS_ROLE).`].join("\n");
      return { allowed: true, refusal: null, letter: { template, recipient: "designated submitter (ECRM)", subject: `Form 582 answer sheet + evidence index — ${s("entity")} FYE ${s("fye")}`, body, citation: "Selling Guide A4-1-02; Form 582 FAQ (July 2026)", evidence_document_ids: evidence } };
    }
    case "F582-PENDING-v1": {
      const missing = need(data, "entity", "event_kind", "occurred_on", "description", "fnma_due_at");
      if (missing.length) return refuseLetter(template, `missing ${missing.join(", ")}`);
      const body = `${s("entity")} reports, via an update to the Pending Actions section in Form 582 and this email to the Changes in Lender Organization mailbox, the following change "within five business days of the occurrence" (Selling Guide A4-1-02): ${s("event_kind")} occurred ${s("occurred_on")} — ${s("description")}. Reporting deadline ${s("fnma_due_at")} (Fannie Mae business days).`;
      return { allowed: true, refusal: null, letter: { template, recipient: "Changes in Lender Organization mailbox", subject: `Pending Actions update — ${s("entity")} — ${s("event_kind")} ${s("occurred_on")}`, body, citation: "Selling Guide A4-1-02: material changes reported within five business days of the occurrence via Pending Actions and the Changes in Lender Organization mailbox", evidence_document_ids: [] } };
    }
    case "ORG-CHG-NOTICE-v1": {
      const missing = need(data, "entity", "kind", "description");
      if (missing.length) return refuseLetter(template, `missing ${missing.join(", ")}`);
      const immediate = s("kind") === "regulatory_action" || s("kind") === "regulator_management_role";
      if (!immediate && need(data, "planned_effective_on").length) return refuseLetter(template, "missing planned_effective_on");
      const prior = data.prior_approval_required === true;
      const body = immediate
        ? `${s("entity")} gives "immediate written notice" under Selling Guide A4-1-03 of a regulatory action${s("regulator") ? ` by ${s("regulator")}` : ""}: ${s("description")}.`
        : `${s("entity")} gives "60 days' advance written notice"${prior ? " and requests prior written approval" : ""} under Selling Guide A4-1-03 of a ${s("kind")} planned to take effect ${s("planned_effective_on")}: ${s("description")}.`;
      return { allowed: true, refusal: null, letter: { template, recipient: "Fannie Mae customer account team", subject: `${immediate ? "Immediate notice" : prior ? "Prior-approval request and advance notice" : "Advance notice"} — ${s("entity")} — ${s("kind")}`, body, citation: "Selling Guide A4-1-03, Report of Changes in the Seller/Servicer's Organization", evidence_document_ids: [] } };
    }
    case "TECH-PROV-NOTICE-v1": {
      const missing = need(data, "entity", "kind", "provider", "loan_count");
      if (missing.length) return refuseLetter(template, `missing ${missing.join(", ")}`);
      const kindText = TECH_KIND_TEXT[s("kind")];
      if (!kindText) return refuseLetter(template, `unknown kind ${s("kind")}`);
      if (s("kind") === "planned_change" && need(data, "planned_effective_on").length) return refuseLetter(template, "missing planned_effective_on");
      const body = `${s("entity")} (${s("loan_count")} loans serviced; Servicing Guide A2-1-01 applies at 20,000 or more) ${kindText}: provider ${s("provider")}${s("planned_effective_on") ? `, planned effective ${s("planned_effective_on")}` : ""}${s("description") ? ` — ${s("description")}` : ""}.`;
      return { allowed: true, refusal: null, letter: { template, recipient: "Fannie Mae customer account team", subject: `Technology provider notice — ${s("entity")} — ${s("kind")}`, body, citation: "Servicing Guide A2-1-01: 180 days' notice before changing a critical technology provider; notice within 5 business days of any termination, breach or impairment", evidence_document_ids: [] } };
    }
  }
}

// ============================================================ evidenced satisfying events
export interface NoticeEvidence { readonly sent: boolean; readonly evidence_document_id: string | null; }
const evidenced = (e: NoticeEvidence): e is NoticeEvidence & { evidence_document_id: string } => regulatoryNoticeSatisfies(e);

export type RegulatoryActionKind = Parameters<typeof regulatoryActionReceived>[0]["kind"];
export interface RegulatoryActionRecorded extends ReturnType<typeof regulatoryActionReceived> {
  readonly regulatory_action_id: string;
  /** Arms FNMA_A4103_REGULATORY_ACTION_IMMEDIATE (registry trigger `regulatory.action.received`) on the regulatory_action subject the sent notice closes. */
  readonly event: Emitted<{ regulatory_action_id: string; kind: RegulatoryActionKind; regulator: string; entity: Entity; received_on: PlainDate; occurred_at: PlainDate; document_id: string | null }>;
  /** A Supermortgage regulatory action is an event the partner must report: arms SM_PARTNER_NOTIFY_SUB_EVENT_1BD on the same subject. */
  readonly partner_event: Emitted<{ event_kind: RegulatoryActionKind; source: "regulatory_action"; occurred_at: PlainDate; entity: "supermortgage" }> | null;
}
/** Inputs: `regulatory.action.received` — ops.regulatoryActionReceived's same-day draft, escalations and clocks, plus the events that arm them (18.4-T6). */
export function recordRegulatoryAction(i: Parameters<typeof regulatoryActionReceived>[0] & { regulatory_action_id?: string | null; document_id?: string | null }): RegulatoryActionRecorded {
  const r = regulatoryActionReceived(i);
  const regulatory_action_id = i.regulatory_action_id ?? `${i.entity}:${i.kind}:${i.regulator}:${i.received_on}`;
  const aggregate = { kind: "regulatory_action", id: regulatory_action_id };
  return {
    ...r, regulatory_action_id,
    event: { type: "regulatory.action.received", actor: QC_AUDIT_AGENT, aggregate, payload: { regulatory_action_id, kind: i.kind, regulator: i.regulator, entity: i.entity, received_on: i.received_on, occurred_at: i.received_on, document_id: i.document_id ?? null } },
    partner_event: i.entity === "supermortgage" ? { type: "partner.reportable_event.occurred", actor: QC_AUDIT_AGENT, aggregate, payload: { event_kind: i.kind, source: "regulatory_action", occurred_at: i.received_on, entity: "supermortgage" } } : null,
  };
}

/** `FNMA_A4103_REGULATORY_ACTION_IMMEDIATE` is satisfied by `regulatory.action.notice_sent{evidence_document_id present}` on the regulatory_action subject that armed it — never by a draft or an un-evidenced "sent" (18.4-T6). */
export function regulatoryActionNoticeEvent(i: NoticeEvidence & { regulatory_action_id: string; sent_on: PlainDate | null; regulator: string; entity: Entity; sent_by?: string | null }): Emitted<{ regulatory_action_id: string; evidence_document_id: string; recipient: "fnma_customer_account_team"; sent_on: PlainDate; regulator: string; entity: string; sent_by: string | null }> | null {
  if (!evidenced(i) || i.sent_on === null) return null;
  return { type: "regulatory.action.notice_sent", actor: i.sent_by ? { kind: "human", id: i.sent_by, role: "officer" } : QC_AUDIT_AGENT, aggregate: { kind: "regulatory_action", id: i.regulatory_action_id }, payload: { regulatory_action_id: i.regulatory_action_id, evidence_document_id: i.evidence_document_id, recipient: "fnma_customer_account_team", sent_on: i.sent_on, regulator: i.regulator, entity: i.entity, sent_by: i.sent_by ?? null } };
}

/** `FNMA_A4102_ORG_CHANGE_5BD` is satisfied by `org_change.notice.filed{…}` on the same org_change only when the Pending Actions update AND the mailbox email are both evidenced. */
export function pendingActionsFiledEvent(i: { org_change_id: string; entity: Entity; event_kind: OrgChangeKind; form582_updated_at: string | null; pending_actions_document_id: string | null; email_sent_at: string | null; email_evidence_document_id: string | null }): Emitted<{ entity: string; event_kind: OrgChangeKind; pending_actions_document_id: string; email_evidence_document_id: string; form582_updated_at: string; email_sent_at: string }> | null {
  if (!i.form582_updated_at || !i.pending_actions_document_id || !i.email_sent_at || !i.email_evidence_document_id) return null;
  return { type: "org_change.notice.filed", actor: QC_AUDIT_AGENT, aggregate: { kind: "org_change", id: i.org_change_id }, payload: { entity: i.entity, event_kind: i.event_kind, pending_actions_document_id: i.pending_actions_document_id, email_evidence_document_id: i.email_evidence_document_id, form582_updated_at: i.form582_updated_at, email_sent_at: i.email_sent_at } };
}

/** `SM_PARTNER_NOTIFY_SUB_EVENT_1BD` is satisfied by `partner.notified{kind=reportable_event, evidence_document_id present}` on the subject of the `partner.reportable_event.occurred` that armed it (the org_change or regulatory_action). */
export function partnerNotifiedEvent(i: NoticeEvidence & { subject: { kind: string; id: string }; event_kind: string; notified_on: PlainDate | null }): Emitted<{ kind: "reportable_event"; event_kind: string; evidence_document_id: string; notified_on: PlainDate }> | null {
  if (!evidenced(i) || i.notified_on === null) return null;
  return { type: "partner.notified", actor: QC_AUDIT_AGENT, aggregate: { kind: i.subject.kind, id: i.subject.id }, payload: { kind: "reportable_event", event_kind: i.event_kind, evidence_document_id: i.evidence_document_id, notified_on: i.notified_on } };
}

/**
 * `FNMA_A4103_MAJOR_CHANGE_ADVANCE_60` clears on Fannie Mae approval/acknowledgment (the letter as `document_id`, its reference as `basis`) or an `officer` waiver (the signed waiver as `document_id`, the officer's rationale as `basis`, the officer as actor and `officer_id`).
 * The registry pattern demands `document_id present, basis present` beside `by`, so a bare `{by: officer_waiver}` never matches; the officer role itself is enforced here and by the tool's needsRole guardrail, which the pattern grammar cannot express.
 */
export function majorChangeGateClearedEvent(i: { org_change_id: string; by: GateClearedBy; document_id: string | null; officer_id?: string | null; rationale?: string | null; fnma_reference?: string | null }): Emitted<{ by: GateClearedBy; document_id: string; basis: string; officer_id: string | null; rationale: string | null; fnma_reference: string | null }> | null {
  if (!i.document_id) return null;
  if (i.by === "officer_waiver" && (!i.officer_id || !i.rationale)) return null;
  if (i.by !== "officer_waiver" && !i.fnma_reference) return null;
  const basis = i.by === "officer_waiver" ? i.rationale! : i.fnma_reference!;
  return { type: "org_change.gate.cleared", actor: i.by === "officer_waiver" ? { kind: "human", id: i.officer_id!, role: "officer" } : QC_AUDIT_AGENT, aggregate: { kind: "org_change", id: i.org_change_id }, payload: { by: i.by, document_id: i.document_id, basis, officer_id: i.officer_id ?? null, rationale: i.by === "officer_waiver" ? i.rationale! : null, fnma_reference: i.by === "officer_waiver" ? null : i.fnma_reference! } };
}

/** `FNMA_A3501_INSURANCE_EXPIRY_30` is satisfied by `corporate_insurance_policy.renewed{lapse=false, policy_id present}` on the expiring policy's own aggregate: a renewal effective after the prior expiry is recorded with `lapse=true` and does not satisfy it, and a renewal of another policy (a different subject) never reaches it. */
export function insuranceRenewalEvent(i: { policy_id: string; kind: CorporatePolicyKind; prior_expires_on: PlainDate; renewal_effective_on: PlainDate; renewal_document_id: string | null }): Emitted<{ policy_id: string; kind: string; prior_expires_on: PlainDate; renewal_effective_on: PlainDate; lapse: boolean; document_id: string }> | null {
  if (!i.renewal_document_id) return null;
  return { type: "corporate_insurance_policy.renewed", actor: QC_AUDIT_AGENT, aggregate: { kind: "corporate_insurance_policy", id: i.policy_id }, payload: { policy_id: i.policy_id, kind: i.kind, prior_expires_on: i.prior_expires_on, renewal_effective_on: i.renewal_effective_on, lapse: i.renewal_effective_on > i.prior_expires_on, document_id: i.renewal_document_id } };
}

/** `SM_FORM582_PARTNER_PACKAGE_FYE_60` is satisfied by `partner.data_package.delivered{filing_type=form_582, receipt_document_id present}` on the partner's fiscal-year subject — the SFTP/portal delivery with the partner's receipt acknowledgment, never the delivery alone. Filings, the AFS and this package share the `fiscal_year` aggregate the `period.fiscal_year_end` tick arms on. */
export function partnerDataPackageDeliveredEvent(i: { filing_id: string; fye: PlainDate; package_document_id: string | null; delivered_on: PlainDate | null; receipt_document_id: string | null }): Emitted<{ filing_type: "form_582"; filing_id: string; fye: PlainDate; package_document_id: string; delivered_on: PlainDate; receipt_document_id: string }> | null {
  if (!i.package_document_id || !i.delivered_on || !i.receipt_document_id) return null;
  return { type: "partner.data_package.delivered", actor: QC_AUDIT_AGENT, aggregate: { kind: "fiscal_year", id: `partner:${i.fye}` }, payload: { filing_type: "form_582", filing_id: i.filing_id, fye: i.fye, package_document_id: i.package_document_id, delivered_on: i.delivered_on, receipt_document_id: i.receipt_document_id } };
}

/** `SM_AFS_AUDITOR_DELIVERY_FYE_75` is satisfied by `afs.received{document_id present}` (the auditor's secure upload); with `audit_opinion=true` the same event satisfies 18.1's CSBS external-audit row. */
export function afsReceivedEvent(i: { entity: Entity; fye: PlainDate; auditor: string; document_id: string | null; audit_opinion: boolean; received_on: PlainDate }): Emitted<{ entity: Entity; fye: PlainDate; auditor: string; document_id: string; audit_opinion: boolean; received_on: PlainDate }> | null {
  if (!i.document_id) return null;
  return { type: "afs.received", actor: { kind: "external", id: i.auditor }, aggregate: { kind: "fiscal_year", id: `${i.entity}:${i.fye}` }, payload: { entity: i.entity, fye: i.fye, auditor: i.auditor, document_id: i.document_id, audit_opinion: i.audit_opinion, received_on: i.received_on } };
}

export type TechProviderEventKind = "planned_change" | "termination" | "breach" | "impairment";
export type TechContractEventKind = Exclude<TechProviderEventKind, "planned_change">;
export const A2101_LOAN_THRESHOLD = 20_000;
export interface TechProviderContractEvent {
  readonly contract_event_id: string;
  readonly applies: boolean;
  readonly timer: { readonly code: "FNMA_A2101_TECH_PROVIDER_BREACH_5BD"; readonly anchor: PlainDate; readonly due: PlainDate; readonly satisfied_by: "fnma_notices.sent{kind=a2101_event_5bd, document_id present}" };
  readonly draft: { readonly template: "TECH-PROV-NOTICE-v1"; readonly kind: TechContractEventKind; readonly drafted_on: PlainDate; readonly recipient: "fnma_customer_account_team" };
  readonly escalation: QcEscalation;
  /** The same `contract_event.occurred` shape 19.3's `notices.draft` records, on the `contract_events` subject: it arms this row and 19.3's FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD alike, and one officer-recorded notice closes both. */
  readonly event: Emitted<{ contract_event_id: string; contract_id: string; kind: TechContractEventKind; direction: "sent_to_servicer" | "sent_by_servicer" | "sent_by_provider"; occurred_on: PlainDate; occurred_at: PlainDate; contract_kind: "tech_provider"; critical_servicing_function: true; fnma_notice_required: true; entity: Entity; provider: string; loan_count: number; document_id: string | null }> & { readonly aggregate: { readonly kind: "contract_events"; readonly id: string } };
}
/** A2-1-01: a termination/breach/impairment notice under a technology contract (Supermortgage is the partner's technology provider; Supermortgage's own critical sub-providers count) → Fannie Mae notice within 5 business days, the same-day TECH-PROV-NOTICE-v1 draft for the officer. */
export function techProviderContractEvent(i: { contract_event_id?: string | null; contract_id: string; entity: Entity; provider: string; kind: TechContractEventKind; direction?: "sent_to_servicer" | "sent_by_servicer" | "sent_by_provider"; occurred_on: PlainDate; loan_count: number; document_id?: string | null; cal?: Calendar }): TechProviderContractEvent {
  const contract_event_id = i.contract_event_id ?? `ce-${i.contract_id}-${i.occurred_on}-${i.kind}`;
  const due = addBusinessDays(i.occurred_on, 5, i.cal ?? servicer);
  const direction = i.direction ?? "sent_to_servicer";
  return {
    contract_event_id, applies: i.loan_count >= A2101_LOAN_THRESHOLD,
    timer: { code: "FNMA_A2101_TECH_PROVIDER_BREACH_5BD", anchor: i.occurred_on, due, satisfied_by: "fnma_notices.sent{kind=a2101_event_5bd, document_id present}" },
    draft: { template: "TECH-PROV-NOTICE-v1", kind: i.kind, drafted_on: i.occurred_on, recipient: "fnma_customer_account_team" },
    escalation: { kind: "officer", severity: "sev1", reason: `${i.kind} under technology contract ${i.contract_id} (${i.provider}) on ${i.occurred_on}: sign and send the A2-1-01 notice to Fannie Mae by ${due} (5 business days)`, due },
    event: { type: "contract_event.occurred", actor: QC_AUDIT_AGENT, aggregate: { kind: "contract_events", id: contract_event_id }, occurredAt: `${i.occurred_on}T17:00:00.000Z`, payload: { contract_event_id, contract_id: i.contract_id, kind: i.kind, direction, occurred_on: i.occurred_on, occurred_at: i.occurred_on, contract_kind: "tech_provider", critical_servicing_function: true, fnma_notice_required: true, entity: i.entity, provider: i.provider, loan_count: i.loan_count, document_id: i.document_id ?? null } },
  };
}
export interface TechProviderChangeIntent {
  readonly change_id: string;
  readonly applies: boolean;
  readonly gate: { readonly code: "FNMA_A2101_TECH_PROVIDER_CHANGE_180"; readonly anchor: PlainDate; readonly notice_needed_by: PlainDate; readonly already_passed: boolean; readonly blocked: boolean };
  readonly escalation: QcEscalation | null;
  /** Arms FNMA_A2101_TECH_PROVIDER_CHANGE_180 (anchor `planned_effective_date`, −180 calendar days) on the change's subject; null below the 20,000-loan threshold where A2-1-01 does not apply. */
  readonly event: Emitted<{ change_id: string; entity: Entity; provider: string; planned_effective_date: PlainDate; declared_on: PlainDate; loan_count: number; applies: true }> | null;
}
/** A2-1-01: the partner plans to replace Supermortgage, or Supermortgage plans to replace a critical sub-provider — notice 180 calendar days before the change; the change is blocked until the notice is evidenced. */
export function techProviderChangeIntent(i: { change_id?: string | null; entity: Entity; provider: string; planned_effective_date: PlainDate; declared_on: PlainDate; loan_count: number }): TechProviderChangeIntent {
  const change_id = i.change_id ?? `${i.entity}:${i.provider}:${i.planned_effective_date}`;
  const applies = i.loan_count >= A2101_LOAN_THRESHOLD;
  const notice_needed_by = addDays(i.planned_effective_date, -180);
  const already_passed = applies && notice_needed_by < i.declared_on;
  return {
    change_id, applies,
    gate: { code: "FNMA_A2101_TECH_PROVIDER_CHANGE_180", anchor: i.planned_effective_date, notice_needed_by, already_passed, blocked: applies },
    escalation: !applies ? null : { kind: "officer", severity: already_passed ? "sev1" : "sev2", reason: `${i.entity} plans to replace technology provider ${i.provider} effective ${i.planned_effective_date}: A2-1-01 notice (TECH-PROV-NOTICE-v1) needed by ${notice_needed_by}${already_passed ? ` — already passed on ${i.declared_on}; the change stays blocked until the notice is evidenced` : ""}`, due: already_passed ? i.declared_on : notice_needed_by },
    event: applies ? { type: "tech_provider.change.intent_declared", actor: QC_AUDIT_AGENT, aggregate: { kind: "tech_provider_change", id: change_id }, payload: { change_id, entity: i.entity, provider: i.provider, planned_effective_date: i.planned_effective_date, declared_on: i.declared_on, loan_count: i.loan_count, applies: true } } : null,
  };
}
type TechNoticeInput = NoticeEvidence & { provider: string; loan_count: number; sent_on: PlainDate | null; sent_by: string; entity: Entity } & ({ kind: "planned_change"; change_id: string } | { kind: TechContractEventKind; contract_event_id: string });
export type TechNoticeSent = Emitted<{ kind: "planned_change"; change_id: string; event_kind: "planned_change"; provider: string; loan_count: number; applies: boolean; evidence_document_id: string; sent_on: PlainDate; sent_by: string; entity: Entity }>
  | Emitted<{ kind: "a2101_event_5bd"; a2101_event_5bd: true; entity: Entity; document_id: string; evidence_document_id: string; copy_document_id: null; sent_by: string; sent_on: PlainDate; contract_event_id: string; request_id: null; event_kind: TechContractEventKind; provider: string; loan_count: number; applies: boolean }>;
/**
 * A2-1-01, only with the sent TECH-PROV-NOTICE-v1 letter's evidence: `tech_provider.change.notice_sent{evidence_document_id present}` closes FNMA_A2101_TECH_PROVIDER_CHANGE_180 on the change's subject;
 * a termination/breach/impairment notice is recorded as `fnma_notices.sent{kind=a2101_event_5bd, document_id present}` on the `contract_events` subject — the very event 19.3's `fnma_notices.recordSent` emits — so it closes FNMA_A2101_TECH_PROVIDER_BREACH_5BD and 19.3's FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD together. The officer who signed and sent is the actor.
 */
export function techProviderNoticeEvent(i: TechNoticeInput): TechNoticeSent | null {
  if (!evidenced(i) || i.sent_on === null) return null;
  const officer = { kind: "human", id: i.sent_by, role: "officer" } as const;
  const applies = i.loan_count >= A2101_LOAN_THRESHOLD;
  if (i.kind === "planned_change") return { type: "tech_provider.change.notice_sent", actor: officer, aggregate: { kind: "tech_provider_change", id: i.change_id }, payload: { kind: "planned_change", change_id: i.change_id, event_kind: "planned_change", provider: i.provider, loan_count: i.loan_count, applies, evidence_document_id: i.evidence_document_id, sent_on: i.sent_on, sent_by: i.sent_by, entity: i.entity } };
  return { type: "fnma_notices.sent", actor: officer, aggregate: { kind: "contract_events", id: i.contract_event_id }, payload: { kind: "a2101_event_5bd", a2101_event_5bd: true, entity: i.entity, document_id: i.evidence_document_id, evidence_document_id: i.evidence_document_id, copy_document_id: null, sent_by: i.sent_by, sent_on: i.sent_on, contract_event_id: i.contract_event_id, request_id: null, event_kind: i.kind, provider: i.provider, loan_count: i.loan_count, applies } };
}

/** Companion certification (c): an adverse-action notice template version change arms FNMA_A42106_FORM183_ON_CHANGE (`notice_template.published{class=adverse_action}`) on the template's subject; the template is blocked until form183SubmittedEvent closes it. Other classes publish without the gate. */
export function noticeTemplatePublishedEvent(i: { template_code: string; template_version: number | string; notice_class: "adverse_action" | "other"; published_on: PlainDate }): { form183_required: boolean; gate: { code: "FNMA_A42106_FORM183_ON_CHANGE"; blocked_until: "form183.submitted"; template_code: string; template_version: string } | null; event: Emitted<{ class: "adverse_action" | "other"; template_code: string; template_version: string; published_on: PlainDate }> } {
  const template_version = String(i.template_version);
  if (!i.template_code || template_version === "") throw new RangeError("template_code and template_version are required");
  const form183_required = i.notice_class === "adverse_action";
  return {
    form183_required,
    gate: form183_required ? { code: "FNMA_A42106_FORM183_ON_CHANGE", blocked_until: "form183.submitted", template_code: i.template_code, template_version } : null,
    event: { type: "notice_template.published", actor: QC_AUDIT_AGENT, aggregate: { kind: "notice_template", id: i.template_code }, payload: { class: i.notice_class, template_code: i.template_code, template_version, published_on: i.published_on } },
  };
}

/** `FNMA_A42106_FORM183_ON_CHANGE` is satisfied by `form183.submitted{template_version present}` for the changed adverse-action template version, with the submission evidence. */
export function form183SubmittedEvent(i: { template_code: string; template_version: number | string | null; submission_evidence_document_id: string | null; submitted_on: PlainDate }): Emitted<{ template_code: string; template_version: string; evidence_document_id: string; submitted_on: PlainDate }> | null {
  if (i.template_version === null || i.template_version === "" || !i.submission_evidence_document_id) return null;
  return { type: "form183.submitted", actor: QC_AUDIT_AGENT, aggregate: { kind: "notice_template", id: i.template_code }, payload: { template_code: i.template_code, template_version: String(i.template_version), evidence_document_id: i.submission_evidence_document_id, submitted_on: i.submitted_on } };
}
