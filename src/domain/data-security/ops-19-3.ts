/**
 * §19.3 Fannie Mae data/tech-provider requirements — one small pure function per rule / T-id
 * (spec/sections/19-data-security-recordkeeping/19-3-fannie-mae-data-tech-provider-requirements.md).
 * The calendar arithmetic already in ./vendors.ts is reused; this module adds the rule shapes the
 * T-ids and the tools need (termination tasks, drift disablement, reassessment escalation, deploy gate,
 * Form 582 package, threshold snapshot, contract-event classification, the spec's mandatory clause set,
 * the Form 101 adapter gate, the 180-day cutover gate and the vendor state machine), plus the event shapes the
 * five input clocks arm and close on: the arrangement's inception/termination (A2-1-07), Technology Guide integration
 * drift (120-day rule), the vendor incident-notice SLA and the LL-2026-04 policy approval/annual review.
 *
 * Shared-calculator defects worked around here (reported in the build notes, ./vendors.ts is read-only):
 *  - `MANDATORY_CLAUSES` in ./vendors.ts omits two of "the three A2-1-01 clauses" (`A2101_COPIES_5BD`,
 *    `A2101_COOPERATE_TRANSFER_FEES`) and uses code names the spec's data model does not — `requiredClauses`
 *    below is the spec's set (rule 6; `contract_clauses.clause_code`), with the old names accepted as aliases.
 */
import { type PlainDate, addDays, addMonths, addYears, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import { form629Clocks, firstFannieBusinessDay } from "../transfers/batch.ts";
import { A2101_THRESHOLD, reassessment, schemaDriftDisableOn, contractCopiesDue, form101TerminationDue, earliestCutover, type ClauseState } from "./vendors.ts";

// ---------------------------------------------------------------- shared shapes
export type Escalation = { readonly kind: "officer" | "attorney" | "fnma_portal_operator" | "human_portal_task" | "sev1" | "sev2" | "sev3"; readonly reason: string; readonly at?: PlainDate };
export type Task = { readonly kind: string; readonly owner: string; readonly due: PlainDate | null; readonly process: string; readonly reason: string };

// ---------------------------------------------------------------- T9 — partner terminates the arrangement
/**
 * A2-1-07: Form 101 re-executed "at termination" → `FNMA_A2107_FORM101_TERMINATION_5BD` (+5 fannie_et BD, policy);
 * "Supermortgage's own exit" edge case: Section 17 transfer-out + Form 629 (30 days for subservicing transfers),
 * data return/destruction certification +30 calendar days (`FNMA_TECHGUIDE_TERMINATION_RETURN_DESTROY_30D`).
 * Service continues in full until cutover, so the transfer lands on the first Fannie Mae business day of a month
 * (A2-7-03) strictly after the termination takes effect — never before it.
 */
export function subservicingTermination(input: { readonly effective_on: PlainDate; readonly transfer_type?: "sub_to_master" | "sub_to_sub" }): {
  readonly form101_termination_due: PlainDate; readonly transfer_date: PlainDate; readonly form629_due: PlainDate; readonly data_return_cert_due: PlainDate; readonly tasks: readonly Task[];
} {
  const form101_termination_due = form101TerminationDue(input.effective_on, fannieEt);
  const dayAfter = addDays(input.effective_on, 1);
  let transfer_date = firstFannieBusinessDay(dayAfter);
  if (transfer_date < dayAfter) transfer_date = firstFannieBusinessDay(addMonths(dayAfter, 1));   // the month's first business day is already past → next month
  const form629_due = form629Clocks(input.transfer_type ?? "sub_to_master", transfer_date).deadline;
  const data_return_cert_due = addDays(input.effective_on, 30);
  const tasks: Task[] = [
    { kind: "form101_termination", owner: "officer", due: form101_termination_due, process: "19.3", reason: "A2-1-07: Form 101 submitted again at termination (FNMA_A2107_FORM101_TERMINATION_5BD)" },
    { kind: "section17_transfer_out_checklist", owner: "transfers", due: transfer_date, process: "17.3", reason: "Section 17 transfer-out checklist for the partner's replacement of Supermortgage; full service continues until cutover" },
    { kind: "form629_transfer_approval", owner: "fnma_portal_operator", due: form629_due, process: "17.1", reason: "Form 629: 30-day lead for a subservicing transfer" },
    { kind: "data_return_destroy_certification", owner: "officer", due: data_return_cert_due, process: "19.3", reason: "Technology Guide: return or destroy Confidential Information; officer certifies (FNMA_TECHGUIDE_TERMINATION_RETURN_DESTROY_30D)" },
  ];
  return { form101_termination_due, transfer_date, form629_due, data_return_cert_due, tasks };
}

// ---------------------------------------------------------------- T11 — integration drift
/** Technology Guide: "must not transfer data via an Integration Interface if the Integration Interface is out of compliance for more than 120 days". */
export function integrationDrift(input: { readonly detected_on: PlainDate; readonly restored_on: PlainDate | null; readonly as_of: PlainDate }): {
  readonly disable_on: PlainDate; readonly day: number; readonly interface_disabled: boolean; readonly escalation: Escalation | null;
} {
  const disable_on = schemaDriftDisableOn(input.detected_on);
  const restored = input.restored_on !== null && input.restored_on <= disable_on;
  const day = daysBetween(input.detected_on, input.as_of);
  const disabled = !restored && input.as_of >= disable_on;
  return { disable_on, day, interface_disabled: disabled, escalation: disabled ? { kind: "sev1", reason: `integration interface out of compliance for ${day} days; disabled on day 120 (Technology Guide)`, at: disable_on } : null };
}

// ---------------------------------------------------------------- T12 — vendor reassessment cadence
/** Rule 8 / `FNMA_SUPP_VENDOR_REASSESSMENT`: Tier 1: 365 days; Tier 2: 730; Tier 3: 1095; Tier 1 overdue > 60 days → `officer`. */
export function vendorReassessment(input: { readonly tier: 1 | 2 | 3; readonly assessed_on: PlainDate; readonly completed_on: PlainDate | null; readonly as_of: PlainDate }): {
  readonly due: PlainDate; readonly officer_escalation_on: PlainDate; readonly overdue_days: number; readonly escalation: Escalation | null;
} {
  const { due, escalate_on } = reassessment(input.tier, input.assessed_on);
  const complete = input.completed_on !== null && input.completed_on <= input.as_of;
  const overdue_days = complete ? 0 : Math.max(0, daysBetween(due, input.as_of));
  let escalation: Escalation | null = null;
  if (!complete && input.as_of >= due) escalation = input.tier === 1 && input.as_of >= escalate_on ? { kind: "officer", reason: `Tier 1 reassessment overdue ${overdue_days} days (> 60)`, at: escalate_on } : { kind: "sev2", reason: `reassessment overdue ${overdue_days} days`, at: due };
  return { due, officer_escalation_on: escalate_on, overdue_days, escalation };
}

// ---------------------------------------------------------------- T13 — AI system deploy gate
/** `SM_AI_SYSTEM_EVAL_BEFORE_DEPLOY`: a changed prompt/model version needs an eval-suite pass for that version before the `ai_systems` row is updated. */
export function deployGate(input: {
  readonly name: string; readonly prompt_version: string; readonly model_version: string;
  readonly current: { readonly prompt_version: string; readonly model_version: string } | null;
  readonly eval_pass: { readonly prompt_version: string; readonly model_version: string; readonly passed_at: string } | null;
}): { readonly allowed: boolean; readonly changed: boolean; readonly ai_systems_row_updated: boolean; readonly gate: "SM_AI_SYSTEM_EVAL_BEFORE_DEPLOY"; readonly reason: string | null } {
  const changed = input.current === null || input.current.prompt_version !== input.prompt_version || input.current.model_version !== input.model_version;
  const evalOk = input.eval_pass !== null && input.eval_pass.prompt_version === input.prompt_version && input.eval_pass.model_version === input.model_version;
  const allowed = !changed || evalOk;
  return { allowed, changed, ai_systems_row_updated: allowed, gate: "SM_AI_SYSTEM_EVAL_BEFORE_DEPLOY", reason: allowed ? null : `deploy of ${input.name} blocked: no eval-suite pass for prompt ${input.prompt_version} / model ${input.model_version}` };
}

// ---------------------------------------------------------------- T14 — Form 582 third-party package
export type ContractorRow = { readonly name: string; readonly function: string; readonly critical: boolean; readonly data_classes: readonly string[]; readonly country: string };
/** Rule 9 / `FNMA_582_THIRD_PARTY_PACKAGE_30D`: package to 18.4 by Form 582 due − 30 days (= FYE + 60) with the Supplement attestation attached. */
export function form582ThirdPartyPackage(input: {
  readonly form582_due: PlainDate; readonly contractors: readonly ContractorRow[]; readonly subservicing_confirmed: boolean;
  readonly supplement_attestation_document_id: string | null; readonly ll2026_04_summary_document_id: string | null; readonly delivered_on?: PlainDate | null;
}): { readonly deliver_by: PlainDate; readonly complete: boolean; readonly missing: readonly string[]; readonly on_time: boolean | null; readonly contents: { readonly contractors: readonly ContractorRow[]; readonly subservicing_confirmation: boolean; readonly supplement_attestation_document_id: string | null; readonly ll2026_04_program_summary_document_id: string | null }; readonly escalation: Escalation | null } {
  const deliver_by = addDays(input.form582_due, -30);
  const missing: string[] = [];
  if (input.contractors.length === 0) missing.push("contractors_list");
  if (!input.subservicing_confirmed) missing.push("subservicing_confirmation");
  if (!input.supplement_attestation_document_id) missing.push("supplement_attestation");
  if (!input.ll2026_04_summary_document_id) missing.push("ll2026_04_program_summary");
  const delivered = input.delivered_on ?? null;
  const on_time = delivered === null ? null : delivered <= deliver_by;
  const complete = missing.length === 0;
  return { deliver_by, complete, missing, on_time, contents: { contractors: input.contractors, subservicing_confirmation: input.subservicing_confirmed, supplement_attestation_document_id: input.supplement_attestation_document_id, ll2026_04_program_summary_document_id: input.ll2026_04_summary_document_id },
    escalation: !complete || on_time === false ? { kind: "sev2", reason: !complete ? `Form 582 package incomplete: ${missing.join(", ")}` : `Form 582 package delivered after ${deliver_by}`, at: deliver_by } : null };
}

// ---------------------------------------------------------------- Rule 1 — threshold snapshot (portfolio.count)
export function thresholdSnapshot(input: { readonly entity: "partner" | "supermortgage"; readonly counts_this_year: readonly { on: PlainDate; count: number }[]; readonly as_of: PlainDate; readonly previous_active: boolean | null }): {
  readonly entity: string; readonly as_of: PlainDate; readonly loan_count: number; readonly calendar_year: number; readonly year_max: number; readonly a2101_regime_active: boolean; readonly changed: boolean; readonly basis: string;
} {
  const year = input.as_of.slice(0, 4);
  const inYear = input.counts_this_year.filter((c) => c.on <= input.as_of && c.on.slice(0, 4) === year);
  const latest = inYear.reduce<{ on: PlainDate; count: number } | null>((a, c) => (a === null || c.on >= a.on ? c : a), null);
  const year_max = inYear.reduce((m, c) => Math.max(m, c.count), 0);
  const active = year_max >= A2101_THRESHOLD;
  return { entity: input.entity, as_of: input.as_of, loan_count: latest?.count ?? 0, calendar_year: Number(year), year_max, a2101_regime_active: active, changed: input.previous_active !== null && input.previous_active !== active,
    basis: `${input.entity}: ${latest?.count ?? 0} loans owned and/or serviced on ${input.as_of}; ${year} max ${year_max} ${active ? "≥" : "<"} ${A2101_THRESHOLD} (A2-1-01 "at any time during a calendar year")` };
}

// ---------------------------------------------------------------- Rule 5 — contract-event classification
export type ContractEventKind = "termination" | "default_notice" | "breach_notice" | "non_performance_notice" | "impairment_notice" | "breach" | "impairment";
export type ContractEventDirection = "sent_to_servicer" | "sent_by_servicer" | "sent_by_provider";
/** A2-1-01 contract clause: copies of "any termination, notice of default, breach or non-performance or any notice of impairment of rights, in each case sent to the servicer". */
export const COPY_KINDS: readonly ContractEventKind[] = ["termination", "default_notice", "breach_notice", "non_performance_notice", "impairment_notice"];
/** "is a cure notice a 'notice of default'?": default to notify; `attorney` confirms within the 5-BD window. */
export const AMBIGUOUS_KINDS: readonly ContractEventKind[] = ["default_notice", "non_performance_notice"];
/** Contract kinds that are technology-provider contracts for critical servicing functions by definition (the partner's provider is Supermortgage). */
export const TECH_CONTRACT_KINDS: readonly string[] = ["tech_provider_addendum", "tech_provider", "subservicing_agreement", "integration_agreement"];
/**
 * Which A2-1-01 clocks a contract event starts, and when they land (5 fannie_et BD, end of day ET).
 * The servicer's own 5-BD notice attaches to every "termination, breach, or impairment of rights by servicer or the
 * technology provider" under a contract for critical servicing functions — including the partner's own breach
 * (non-payment) and the ambiguous notices, which default to notify; the copies clock attaches in parallel to any of the
 * five notice kinds sent *to* the servicer. A vendor MSA with one of Supermortgage's own critical providers (cloud, AI
 * model provider, payment rails, print/mail, telephony) is a technology contract through `critical_servicing_function`.
 */
export function classifyContractEvent(input: { readonly kind: ContractEventKind; readonly direction: ContractEventDirection; readonly occurred_on: PlainDate; readonly contract_kind: string; readonly critical_servicing_function?: boolean | null }): {
  readonly tech_contract: boolean; readonly fnma_notice_required: boolean; readonly copies_required: boolean; readonly event_notice_due: PlainDate | null; readonly copies_due: PlainDate | null; readonly notices_required: readonly string[]; readonly ambiguous: boolean; readonly attorney_confirm_by: PlainDate | null; readonly basis: string;
} {
  const tech = TECH_CONTRACT_KINDS.includes(input.contract_kind) || input.critical_servicing_function === true;
  const ambiguous = AMBIGUOUS_KINDS.includes(input.kind);
  const fnma_notice_required = tech;   // rule 5 + edge cases: every qualifying event, and "default to notify" for the ambiguous ones
  const copies_required = tech && input.direction === "sent_to_servicer" && COPY_KINDS.includes(input.kind);
  const due = contractCopiesDue(input.occurred_on);
  const notices_required = [...(fnma_notice_required ? ["a2101_event_5bd"] : []), ...(copies_required ? ["a2101_copies_5bd"] : [])];
  const basis = !tech ? `${input.contract_kind} is not a technology-provider contract for critical servicing functions (critical_servicing_function=false): no A2-1-01 clock`
    : `${input.kind} ${input.direction} on ${input.occurred_on} under ${input.contract_kind}${input.critical_servicing_function === true ? " (critical servicing function)" : ""}: 5-BD notice due ${due}${copies_required ? `; copies of the notice sent to the servicer due ${due}` : ""}${ambiguous ? "; ambiguous kind — default to notify, attorney confirms within the window" : ""} (A2-1-01)`;
  return { tech_contract: tech, fnma_notice_required, copies_required, event_notice_due: fnma_notice_required ? due : null, copies_due: copies_required ? due : null, notices_required, ambiguous, attorney_confirm_by: tech && ambiguous ? due : null, basis };
}

// ---------------------------------------------------------------- Rule 6 — the mandatory clause set and clause evidence
/** "the three A2-1-01 clauses" — the Guide's literal contract requirements. */
export const A2101_CLAUSES = ["A2101_COPIES_5BD", "A2101_FNMA_OWNERSHIP_FILES_DATA", "A2101_COOPERATE_TRANSFER_FEES"] as const;
/** Rule 6 for every technology/vendor contract (codes from the spec data model, `contract_clauses.clause_code`). */
export const COMMON_MANDATORY_CLAUSES = [...A2101_CLAUSES, "SUPP_FLOWDOWN", "LL2026_04_GOVERNANCE", "INCIDENT_NOTICE_24H", "AUDIT_RIGHTS_FNMA", "DATA_USE_LIMITED_TG3", "DATA_RETURN_DESTROY_CERT", "RECORDS_RETURN_5BD", "US_PROCESSING", "SUBPROCESSOR_NOTICE", "NO_SCRAPING_FNMA"] as const;
/** Rule 6 "(subservicing agreement)": A2-1-07 rescission acknowledgment and the 180-day exit/transition commitment. */
export const SUBSERVICING_CLAUSES = ["A2107_RESCISSION_ACK", "EXIT_TRANSITION_180"] as const;
/** Rule 6 "for AI providers". */
export const AI_PROVIDER_CLAUSES_19_3 = ["NO_TRAINING_ON_DATA", "ZERO_RETENTION", "NO_HUMAN_REVIEW_WITHOUT_NOTICE", "MODEL_VERSION_CHANGE_NOTICE", "ASSURANCE_REPORTS", "FNMA_DISCLOSURE_COOPERATION"] as const;
/** Older code names (./vendors.ts) accepted as aliases of the spec's codes. */
const CLAUSE_ALIASES: Readonly<Record<string, string>> = { A2101_FNMA_ACCESS_AUDIT: "AUDIT_RIGHTS_FNMA", AUDIT_RIGHTS: "AUDIT_RIGHTS_FNMA", A2101_TERMINATION_RETURN_DESTROY: "DATA_RETURN_DESTROY_CERT", SUPPLEMENT_FLOWDOWN_NO_LESS_PROTECTIVE: "SUPP_FLOWDOWN", US_ONLY_PROCESSING: "US_PROCESSING", NO_UI_SCRAPING: "NO_SCRAPING_FNMA", LIMITED_RETENTION_30D: "ZERO_RETENTION" };
export const canonicalClause = (code: string): string => CLAUSE_ALIASES[code] ?? code;
export type ChecklistOptions = { readonly ai_provider: boolean; readonly contract_kind?: string | null; readonly attorney_signoff: boolean; readonly officer_approval: boolean };
export function requiredClauses(opts: { readonly ai_provider: boolean; readonly contract_kind?: string | null }): readonly string[] {
  const sub = opts.contract_kind === "subservicing_agreement" || opts.contract_kind === "tech_provider_addendum";
  return [...COMMON_MANDATORY_CLAUSES, ...(sub ? SUBSERVICING_CLAUSES : []), ...(opts.ai_provider ? AI_PROVIDER_CLAUSES_19_3 : [])];
}
/** Guardrail: a clause is `present` only with an evidence excerpt; a deviation is the attorney's to sign off. */
export function clauseEntry(input: { readonly clause_code: string; readonly status: ClauseState | "n_a"; readonly evidence_excerpt: string | null; readonly reviewed_by: string | null }): { readonly ok: boolean; readonly refusal: string | null; readonly escalation: Escalation | null } {
  if (input.status === "present" && !(input.evidence_excerpt ?? "").trim()) return { ok: false, refusal: `cannot mark ${input.clause_code} present without an evidence excerpt`, escalation: null };
  if (input.status === "deviation") return { ok: true, refusal: null, escalation: { kind: "attorney", reason: `${input.clause_code} deviation needs attorney sign-off` } };
  return { ok: true, refusal: null, escalation: null };
}
/** Rule 6: checklist must be `present` or `deviation` with attorney sign-off (and, for activation, officer approval) before `active`. */
export function clauseChecklist(clauses: Readonly<Record<string, ClauseState | "n_a">>, opts: ChecklistOptions): { readonly allowed: boolean; readonly missing: readonly string[]; readonly deviations: readonly string[]; readonly tasks: readonly string[]; readonly required: readonly string[] } {
  const required = requiredClauses(opts);
  const state: Record<string, ClauseState | "n_a"> = {};
  for (const [code, st] of Object.entries(clauses)) state[canonicalClause(code)] = st;
  const missing = required.filter((c) => (state[c] ?? "missing") === "missing" || state[c] === "n_a");
  const deviations = required.filter((c) => state[c] === "deviation");
  const tasks: string[] = [];
  if (missing.length > 0 || (deviations.length > 0 && !opts.attorney_signoff)) tasks.push("attorney");
  if (deviations.length > 0 && !opts.officer_approval) tasks.push("officer");
  return { allowed: missing.length === 0 && (deviations.length === 0 || (opts.attorney_signoff && opts.officer_approval)), missing, deviations, tasks, required };
}

// ---------------------------------------------------------------- state machine — vendors
export type VendorStatus = "proposed" | "due_diligence" | "approved" | "active" | "remediation" | "offboarding" | "terminated";
const VENDOR_EDGES: Readonly<Record<VendorStatus, readonly VendorStatus[]>> = { proposed: ["due_diligence"], due_diligence: ["approved", "proposed"], approved: ["active"], active: ["remediation", "offboarding"], remediation: ["active", "offboarding"], offboarding: ["terminated"], terminated: [] };
export function vendorTransition(input: {
  readonly from: VendorStatus; readonly to: VendorStatus; readonly tier: 1 | 2 | 3; readonly ai_ml_used: boolean; readonly offshore: boolean; readonly contract_kind?: string | null;
  readonly onboarding_assessment_completed: boolean; readonly clauses: Readonly<Record<string, ClauseState | "n_a">>; readonly attorney_signoff: boolean; readonly officer_approval: boolean;
  readonly soc2_period_end: PlainDate | null; readonly bcp_evidence: boolean; readonly ai_systems_linked: boolean; readonly ll2026_04_attestation: boolean;
  readonly data_return_certified: boolean; readonly credentials_revoked: boolean; readonly as_of: PlainDate;
}): { readonly allowed: boolean; readonly blockers: readonly string[]; readonly escalations: readonly Escalation[] } {
  const blockers: string[] = []; const escalations: Escalation[] = [];
  if (!VENDOR_EDGES[input.from].includes(input.to)) blockers.push(`no transition ${input.from} → ${input.to}`);
  if (input.to === "approved" || input.to === "active") {
    const gate = clauseChecklist(input.clauses, { ai_provider: input.ai_ml_used, contract_kind: input.contract_kind ?? null, attorney_signoff: input.attorney_signoff, officer_approval: input.officer_approval });
    if (!gate.allowed) {
      blockers.push(`clauses: missing ${gate.missing.join(", ") || "none"}; deviations ${gate.deviations.join(", ") || "none"}${gate.deviations.length ? ` (attorney sign-off ${input.attorney_signoff ? "recorded" : "missing"}, officer approval ${input.officer_approval ? "recorded" : "missing"})` : ""}`);
      if (gate.tasks.includes("attorney")) escalations.push({ kind: "attorney", reason: gate.missing.length ? `mandatory clause missing: ${gate.missing.join(", ")}` : `clause deviation needs attorney sign-off: ${gate.deviations.join(", ")}` });
      if (gate.tasks.includes("officer")) escalations.push({ kind: "officer", reason: `clause deviation needs officer approval: ${gate.deviations.join(", ")}` });
    }
    if (input.tier === 1) {
      if (!input.onboarding_assessment_completed) blockers.push("Tier 1 needs a completed onboarding assessment");
      if (input.soc2_period_end === null || daysBetween(input.soc2_period_end, input.as_of) > 365) blockers.push("SOC 2 / pen-test evidence must be ≤ 12 months old");
      if (!input.bcp_evidence) blockers.push("BCP evidence required");
      if (!input.officer_approval) { blockers.push("Tier 1 approval needs an officer"); escalations.push({ kind: "officer", reason: "Tier 1 vendor approval" }); }
    }
    if (input.ai_ml_used && (!input.ai_systems_linked || !input.ll2026_04_attestation)) { blockers.push("AI vendor needs ai_systems linkage and an LL-2026-04 governance attestation"); escalations.push({ kind: "officer", reason: "ai_ml_used without attestation" }); }
    if (input.offshore) { blockers.push("offshore services need an audit plan and officer approval (default: none permitted)"); escalations.push({ kind: "officer", reason: "offshore = true" }); }
  }
  if (input.to === "terminated") {
    if (!input.data_return_certified) blockers.push("terminated requires data return/destruction certification");
    if (!input.credentials_revoked) blockers.push("terminated requires credential revocation");
    if (input.tier === 1) escalations.push({ kind: "officer", reason: "Tier 1 vendor termination" });
  }
  return { allowed: blockers.length === 0, blockers, escalations };
}

// ---------------------------------------------------------------- T2 — the 180-day technology-provider change gate
export class GateClosed extends Error {
  readonly gate: "FNMA_A2101_TECH_PROVIDER_CHANGE_NOTICE_180"; readonly action: string; readonly opens_on: PlainDate | null; readonly escalation: Escalation;
  constructor(action: string, opensOn: PlainDate | null, why: string) { super(`FNMA_A2101_TECH_PROVIDER_CHANGE_NOTICE_180: ${action} refused — ${why}`); this.name = "GateClosed"; this.gate = "FNMA_A2101_TECH_PROVIDER_CHANGE_NOTICE_180"; this.action = action; this.opens_on = opensOn; this.escalation = { kind: "sev1", reason: `cutover attempted early: ${why}` }; }
}
/** Worked example 4: notice sent 2026-11-02 → earliest permissible cutover = 2026-11-02 + 180 days = Sat 2027-05-01. */
export function changeNoticeSent(input: { readonly notice_sent_at: PlainDate; readonly planned_cutover_at: PlainDate | null }): { readonly earliest_cutover_at: PlainDate; readonly planned_cutover_blocked: boolean; readonly status: "notice_sent" } {
  const earliest_cutover_at = earliestCutover(input.notice_sent_at);
  return { earliest_cutover_at, planned_cutover_blocked: input.planned_cutover_at !== null && input.planned_cutover_at < earliest_cutover_at, status: "notice_sent" };
}
export function cutoverGate(input: { readonly notice_sent_at: PlainDate | null; readonly cutover_on: PlainDate }): { readonly open: boolean; readonly earliest_cutover_at: PlainDate | null; readonly reason: string | null } {
  if (input.notice_sent_at === null) return { open: false, earliest_cutover_at: null, reason: "no 180-day written notice of intent to change the technology provider has been sent to Fannie Mae (A2-1-01)" };
  const earliest = earliestCutover(input.notice_sent_at);
  return input.cutover_on >= earliest ? { open: true, earliest_cutover_at: earliest, reason: null } : { open: false, earliest_cutover_at: earliest, reason: `cutover ${input.cutover_on} is before the earliest permissible cutover ${earliest} (notice sent ${input.notice_sent_at} + 180 calendar days; A2-1-01)` };
}
/** `assertGateOpen(FNMA_A2101_TECH_PROVIDER_CHANGE_NOTICE_180)`: a cutover command before notice + 180 days is rejected and raises sev-1. Throws `GateClosed`. */
export function assertGateOpen(input: { readonly action: "tech_provider.change.cutover"; readonly notice_sent_at: PlainDate | null; readonly cutover_on: PlainDate }): { readonly allowed: true; readonly gate: "FNMA_A2101_TECH_PROVIDER_CHANGE_NOTICE_180"; readonly earliest_cutover_at: PlainDate; readonly event: "tech_provider.change.cutover" } {
  const g = cutoverGate(input);
  if (!g.open) throw new GateClosed(input.action, g.earliest_cutover_at, g.reason ?? "closed");
  return { allowed: true, gate: "FNMA_A2101_TECH_PROVIDER_CHANGE_NOTICE_180", earliest_cutover_at: g.earliest_cutover_at!, event: "tech_provider.change.cutover" };
}

// ---------------------------------------------------------------- T8 — Form 101 (data access authorization) and the adapter gate
export type Form101Row = { readonly id?: string; readonly servicer_numbers: readonly string[]; readonly applications?: readonly string[]; readonly executed_at?: string | null; readonly submitted_at?: string | null; readonly fnma_ack_at: string | null; readonly terminated_at?: string | null; readonly termination_submitted_at?: string | null };
export type Form101Status = "drafted" | "executed" | "submitted" | "acknowledged" | "active" | "termination_submitted" | "terminated";
/** Form 101 state machine: `drafted → executed → submitted → acknowledged → active → termination_submitted → terminated` (Fannie Mae's acknowledgement is what opens adapter access). */
export function form101Status(row: Form101Row): Form101Status {
  if (row.terminated_at) return "terminated";
  if (row.termination_submitted_at) return "termination_submitted";
  if (row.fnma_ack_at) return "active";
  if (row.submitted_at) return "submitted";
  if (row.executed_at) return "executed";
  return "drafted";
}
export type AdapterCallResult = { readonly allowed: true; readonly reason: null; readonly form101_status: "active" | "acknowledged"; readonly authorization_id: string | null } | { readonly allowed: false; readonly reason: "form101_inactive"; readonly form101_status: Form101Status | "none"; readonly refusal: string };
/** Every Fannie Mae adapter call under the partner's servicer number is refused with `form101_inactive` until Fannie Mae has acknowledged the Form 101 that lists that number (and the application). */
export function fnmaAdapterCall(input: { readonly authorizations: readonly Form101Row[]; readonly servicer_number: string; readonly application?: string | null }): AdapterCallResult {
  const rows = input.authorizations.filter((r) => r.servicer_numbers.includes(input.servicer_number) && (!input.application || !r.applications || r.applications.length === 0 || r.applications.includes(input.application)));
  const live = rows.find((r) => form101Status(r) === "active");
  if (live) return { allowed: true, reason: null, form101_status: "active", authorization_id: live.id ?? null };
  const status: Form101Status | "none" = rows.length ? form101Status(rows[rows.length - 1]!) : "none";
  return { allowed: false, reason: "form101_inactive", form101_status: status, refusal: `form101_inactive: Form 101 for servicer number ${input.servicer_number}${input.application ? ` / ${input.application}` : ""} is ${status === "none" ? "not on file" : status} — Fannie Mae acknowledgement required before any application access under the partner's servicer numbers (A2-1-07; Form TR101)` };
}
export class Form101Inactive extends Error { readonly reason = "form101_inactive" as const; readonly method: string; readonly servicer_number: string; constructor(method: string, servicerNumber: string, refusal: string) { super(`${method} refused: ${refusal}`); this.name = "Form101Inactive"; this.method = method; this.servicer_number = servicerNumber; } }
/** Wrap a Fannie Mae port bound to the partner's servicer number: every method call is refused with `form101_inactive` while the Form 101 is not active (T8; `FNMA_A2107_FORM101_INCEPTION_GATE`). */
export function withForm101Gate<T extends object>(port: T, scope: { readonly servicer_number: string; readonly application?: string | null; readonly authorizations: () => readonly Form101Row[] }): T {
  return new Proxy(port, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]): unknown => {
        const r = fnmaAdapterCall({ authorizations: scope.authorizations(), servicer_number: scope.servicer_number, application: scope.application ?? null });
        if (!r.allowed) throw new Form101Inactive(String(prop), scope.servicer_number, r.refusal);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

// ---------------------------------------------------------------- Fannie Mae information requests (LL-2026-04 / Supplement / transition plan / data return)
export type FnmaRequestKind = "transition_plan" | "ll2026_04_disclosure" | "supplement_program" | "audit" | "data_return";
export function fnmaRequestDue(kind: FnmaRequestKind, receivedOn: PlainDate): { readonly due: PlainDate; readonly timer: string; readonly escalation: Escalation } {
  switch (kind) {
    case "transition_plan": return { due: addBusinessDays(receivedOn, 10, fannieEt), timer: "FNMA_A2101_TRANSITION_PLAN_ON_REQUEST_10BD", escalation: { kind: "officer", reason: "transition plan signed and sent by the officer" } };
    case "ll2026_04_disclosure": return { due: addBusinessDays(receivedOn, 5, fannieEt), timer: "FNMA_LL2026_04_DISCLOSURE_PROMPT_5BD", escalation: { kind: "officer", reason: "LL-2026-04 disclosure response (types, purposes, safeguards, inventory export) signed by the officer" } };
    case "data_return": return { due: addDays(receivedOn, 30), timer: "FNMA_TECHGUIDE_TERMINATION_RETURN_DESTROY_30D", escalation: { kind: "officer", reason: "data return/destruction certified by an officer" } };
    default: return { due: addBusinessDays(receivedOn, 10, fannieEt), timer: "FNMA_SUPP_PROGRAM_REQUEST_10BD", escalation: { kind: "officer", reason: "Supplement/audit response signed by the officer" } };
  }
}
/** The `fnma_information_requests` row and the `fnma.request.received{kind}` event that arms the request's clock (T5, T10). */
export function fnmaRequestReceived(input: { readonly request_id: string; readonly kind: FnmaRequestKind; readonly received_on: PlainDate }): {
  readonly row: { readonly id: string; readonly kind: FnmaRequestKind; readonly received_at: PlainDate; readonly due_at: PlainDate; readonly responded_at: null; readonly timer: string };
  readonly event: { readonly type: "fnma.request.received"; readonly payload: { readonly kind: FnmaRequestKind; readonly request_id: string; readonly received_at: PlainDate; readonly due_at: PlainDate; readonly transition_plan: boolean } };
  readonly directed: { readonly type: "fnma.data_return.directed"; readonly payload: { readonly source: "fnma_request"; readonly request_id: string; readonly termination_date: PlainDate } } | null;
  readonly escalation: Escalation;
} {
  const d = fnmaRequestDue(input.kind, input.received_on);
  return {
    row: { id: input.request_id, kind: input.kind, received_at: input.received_on, due_at: d.due, responded_at: null, timer: d.timer },
    event: { type: "fnma.request.received", payload: { kind: input.kind, request_id: input.request_id, received_at: input.received_on, due_at: d.due, transition_plan: input.kind === "transition_plan" } },
    directed: input.kind === "data_return" ? { type: "fnma.data_return.directed", payload: { source: "fnma_request", request_id: input.request_id, termination_date: input.received_on } } : null,
    escalation: d.escalation,
  };
}

// ---------------------------------------------------------------- contract expiry warnings (SM_CONTRACT_EXPIRY_WARNING_180)
/** Anchor `expires_at − 180 / −90 / −30 days` → sev-3/2/1; the registry row is armed at the −180 leg from `counterparty_contracts.expires_at`. */
export function contractExpiryWarnings(expiresOn: PlainDate): readonly { at: PlainDate; days_before: 180 | 90 | 30; severity: "sev3" | "sev2" | "sev1" }[] {
  return [{ at: addDays(expiresOn, -180), days_before: 180, severity: "sev3" }, { at: addDays(expiresOn, -90), days_before: 90, severity: "sev2" }, { at: addDays(expiresOn, -30), days_before: 30, severity: "sev1" }];
}

// ---------------------------------------------------------------- A2-1-07 — the subservicing arrangement's inception and termination
export type ArrangementEntity = "partner" | "supermortgage";
export type ActorLike = { readonly kind: string; readonly id: string; readonly role?: string | undefined };
/** Contract kinds whose termination is the termination of the subservicing arrangement itself (Form 101 "again at termination"). */
export const ARRANGEMENT_CONTRACT_KINDS: readonly string[] = ["subservicing_agreement", "tech_provider_addendum"];
/** Supermortgage's own Fannie Mae technology contracts (Technology Manager SSA, TSP Integration Agreement schedule): termination directs the return/destruction of Fannie Mae Data. */
export const OWN_FNMA_CONTRACT_KINDS: readonly string[] = ["ssa", "integration_agreement"];
export const form101AuthorizationId = (entity: string, given: string | null): string => given || `form101-${entity}`;
/**
 * The executed subservicing agreement (+ technology-provider addendum) makes the arrangement effective: A2-1-07 requires
 * Form 101 "at inception", so `FNMA_A2107_FORM101_INCEPTION_GATE` arms on the Form 101 authorization the arrangement
 * needs and stays closed (`form101_inactive`) until Fannie Mae's acknowledgement (`form101.acknowledged`, T8).
 */
export function subservicingArrangementEffective(input: { readonly contract_id: string; readonly entity: ArrangementEntity; readonly effective_from: PlainDate; readonly authorization_id: string | null; readonly servicer_numbers: readonly string[] }): {
  readonly authorization_id: string; readonly gate: "FNMA_A2107_FORM101_INCEPTION_GATE";
  readonly event: { readonly type: "subservicing.arrangement.effective"; readonly aggregate: { readonly kind: "data_access_authorizations"; readonly id: string }; readonly occurredAt: string; readonly payload: { readonly contract_id: string; readonly entity: ArrangementEntity; readonly effective_from: PlainDate; readonly authorization_id: string; readonly servicer_numbers: readonly string[]; readonly gate: "FNMA_A2107_FORM101_INCEPTION_GATE" } };
} {
  const authorization_id = form101AuthorizationId(input.entity, input.authorization_id);
  return { authorization_id, gate: "FNMA_A2107_FORM101_INCEPTION_GATE", event: { type: "subservicing.arrangement.effective", aggregate: { kind: "data_access_authorizations", id: authorization_id }, occurredAt: `${input.effective_from}T12:00:00.000Z`, payload: { contract_id: input.contract_id, entity: input.entity, effective_from: input.effective_from, authorization_id, servicer_numbers: input.servicer_numbers, gate: "FNMA_A2107_FORM101_INCEPTION_GATE" } } };
}
/**
 * A termination under the subservicing agreement / technology-provider addendum terminates the arrangement (T9; edge case
 * "Supermortgage's own exit"): `FNMA_A2107_FORM101_TERMINATION_5BD` runs +5 fannie_et BD from the termination's *effective*
 * date (`termination_effective_on`, the registry's "termination date"), not from the notice's occurrence.
 */
export function subservicingArrangementTerminated(input: { readonly contract_id: string | null; readonly contract_event_id: string; readonly entity: ArrangementEntity; readonly occurred_on: PlainDate; readonly effective_on: PlainDate; readonly authorization_id: string | null }): {
  readonly authorization_id: string; readonly form101_termination_due: PlainDate;
  readonly event: { readonly type: "subservicing.arrangement.terminated"; readonly aggregate: { readonly kind: "data_access_authorizations"; readonly id: string }; readonly occurredAt: string; readonly payload: { readonly entity: ArrangementEntity; readonly contract_id: string | null; readonly contract_event_id: string; readonly occurred_on: PlainDate; readonly termination_effective_on: PlainDate; readonly form101_termination_due: PlainDate; readonly timer: "FNMA_A2107_FORM101_TERMINATION_5BD" } };
} {
  if (input.effective_on < input.occurred_on) throw new RangeError(`termination effective ${input.effective_on} precedes the notice's occurrence ${input.occurred_on}`);
  const authorization_id = form101AuthorizationId(input.entity, input.authorization_id);
  const form101_termination_due = form101TerminationDue(input.effective_on, fannieEt);
  return { authorization_id, form101_termination_due, event: { type: "subservicing.arrangement.terminated", aggregate: { kind: "data_access_authorizations", id: authorization_id }, occurredAt: `${input.occurred_on}T12:00:00.000Z`, payload: { entity: input.entity, contract_id: input.contract_id, contract_event_id: input.contract_event_id, occurred_on: input.occurred_on, termination_effective_on: input.effective_on, form101_termination_due, timer: "FNMA_A2107_FORM101_TERMINATION_5BD" } } };
}
/** Technology Guide termination clause on Supermortgage's own SSA / TSP schedule: `ssa.terminated` / `schedule.terminated` read as `fnma.data_return.directed{source}` (+30 calendar days, officer certifies). */
export function dataReturnDirectedByTermination(input: { readonly contract_kind: string; readonly contract_id: string | null; readonly effective_on: PlainDate }): {
  readonly type: "fnma.data_return.directed"; readonly aggregate: { readonly kind: "counterparty_contracts"; readonly id: string }; readonly occurredAt: string;
  readonly payload: { readonly source: "ssa_terminated" | "schedule_terminated"; readonly termination_date: PlainDate; readonly contract_id: string | null; readonly certify_by: PlainDate; readonly timer: "FNMA_TECHGUIDE_TERMINATION_RETURN_DESTROY_30D" };
} | null {
  if (!OWN_FNMA_CONTRACT_KINDS.includes(input.contract_kind)) return null;
  const source = input.contract_kind === "ssa" ? "ssa_terminated" : "schedule_terminated";
  return { type: "fnma.data_return.directed", aggregate: { kind: "counterparty_contracts", id: input.contract_id ?? input.contract_kind }, occurredAt: `${input.effective_on}T12:00:00.000Z`, payload: { source, termination_date: input.effective_on, contract_id: input.contract_id, certify_by: addDays(input.effective_on, 30), timer: "FNMA_TECHGUIDE_TERMINATION_RETURN_DESTROY_30D" } };
}

// ---------------------------------------------------------------- Technology Guide — integration interface compliance (FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120)
export type IntegrationDrift = { readonly expected_spec_version: string | null; readonly actual_spec_version: string | null; readonly description: string };
export type IntegrationInterfaceRow = {
  readonly id: string; readonly status: "compliant" | "noncompliant" | "disabled"; readonly detected_on: PlainDate | null; readonly disable_on: PlainDate | null;
  readonly disabled_on: PlainDate | null; readonly restored_on: PlainDate | null; readonly drift: IntegrationDrift | null; readonly evidence_document_id: string | null;
};
/**
 * Schema/version drift on a Fannie Mae Integration Interface (Technology Guide §5.7: build to spec, stay within one version;
 * "must not transfer data via an Integration Interface if the Integration Interface is out of compliance for more than 120
 * days"): the detection arms the 120-day clock (`integration.noncompliance.detected{detected_at}`) and opens the Technology
 * Manager task to restore compliance. Idempotent: an open drift on the same interface is not re-detected.
 */
export function integrationDriftDetected(input: { readonly interface: string; readonly detected_on: PlainDate; readonly expected_spec_version: string | null; readonly actual_spec_version: string | null; readonly description?: string | null; readonly current: IntegrationInterfaceRow | null }): {
  readonly row: IntegrationInterfaceRow; readonly already_open: boolean; readonly disable_on: PlainDate;
  readonly event: { readonly type: "integration.noncompliance.detected"; readonly aggregate: { readonly kind: "integration_interfaces"; readonly id: string }; readonly occurredAt: string; readonly payload: { readonly interface: string; readonly detected_at: PlainDate; readonly disable_on: PlainDate; readonly expected_spec_version: string | null; readonly actual_spec_version: string | null; readonly drift: string; readonly timer: "FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120" } } | null;
  readonly task: { readonly kind: "human_portal_task"; readonly owner_role: "fnma_portal_operator"; readonly portal: "technology_manager"; readonly due: PlainDate; readonly reason: string } | null;
} {
  if (!input.interface.trim()) throw new RangeError("interface is required");
  const cur = input.current;
  if (cur && cur.status !== "compliant" && cur.restored_on === null) return { row: cur, already_open: true, disable_on: cur.disable_on ?? schemaDriftDisableOn(cur.detected_on ?? input.detected_on), event: null, task: null };
  const disable_on = schemaDriftDisableOn(input.detected_on);
  const description = (input.description ?? "").trim() || `spec/version drift: expected ${input.expected_spec_version ?? "current spec"}, interface running ${input.actual_spec_version ?? "an unknown version"}`;
  const drift: IntegrationDrift = { expected_spec_version: input.expected_spec_version, actual_spec_version: input.actual_spec_version, description };
  const row: IntegrationInterfaceRow = { id: input.interface, status: "noncompliant", detected_on: input.detected_on, disable_on, disabled_on: null, restored_on: null, drift, evidence_document_id: null };
  return { row, already_open: false, disable_on,
    event: { type: "integration.noncompliance.detected", aggregate: { kind: "integration_interfaces", id: input.interface }, occurredAt: `${input.detected_on}T12:00:00.000Z`, payload: { interface: input.interface, detected_at: input.detected_on, disable_on, expected_spec_version: input.expected_spec_version, actual_spec_version: input.actual_spec_version, drift: description, timer: "FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120" } },
    task: { kind: "human_portal_task", owner_role: "fnma_portal_operator", portal: "technology_manager", due: disable_on, reason: `Technology Guide: ${input.interface} out of compliance (${description}); restore within 120 days or the interface is disabled on ${disable_on}` } };
}
/** The compliance-sentinel's daily sweep: every interface still out of compliance on day 120 is disabled (written, not merely read) and a sev-1 raised. */
export function integrationDriftSweep(rows: readonly IntegrationInterfaceRow[], asOf: PlainDate): readonly {
  readonly row: IntegrationInterfaceRow; readonly escalation: Escalation;
  readonly event: { readonly type: "integration.interface.disabled"; readonly aggregate: { readonly kind: "integration_interfaces"; readonly id: string }; readonly occurredAt: string; readonly payload: { readonly interface: string; readonly detected_at: PlainDate; readonly disabled_on: PlainDate; readonly day: number; readonly reason: string } };
}[] {
  const out = [];
  for (const r of rows) {
    if (r.status !== "noncompliant" || r.detected_on === null) continue;
    const d = integrationDrift({ detected_on: r.detected_on, restored_on: r.restored_on, as_of: asOf });
    if (!d.interface_disabled || !d.escalation) continue;
    const row: IntegrationInterfaceRow = { ...r, status: "disabled", disabled_on: d.disable_on };
    out.push({ row, escalation: d.escalation, event: { type: "integration.interface.disabled" as const, aggregate: { kind: "integration_interfaces" as const, id: r.id }, occurredAt: `${d.disable_on}T12:00:00.000Z`, payload: { interface: r.id, detected_at: r.detected_on, disabled_on: d.disable_on, day: daysBetween(r.detected_on, d.disable_on), reason: d.escalation.reason } } });
  }
  return out;
}
/** The operator's completion evidence restores compliance: `integration.compliance.restored` closes the clock (late when after day 120; a disabled interface is re-enabled only now). */
export function integrationComplianceRestored(input: { readonly row: IntegrationInterfaceRow | null; readonly interface: string; readonly restored_on: PlainDate; readonly evidence_document_id: string | null }): {
  readonly row: IntegrationInterfaceRow; readonly late: boolean; readonly day: number;
  readonly event: { readonly type: "integration.compliance.restored"; readonly aggregate: { readonly kind: "integration_interfaces"; readonly id: string }; readonly occurredAt: string; readonly payload: { readonly interface: string; readonly restored_at: PlainDate; readonly detected_at: PlainDate; readonly day: number; readonly late: boolean; readonly was_disabled: boolean; readonly evidence_document_id: string } };
} {
  const cur = input.row;
  if (!cur || cur.status === "compliant" || cur.detected_on === null) throw new RangeError(`no open non-compliance on interface ${input.interface}`);
  if (!input.evidence_document_id) throw new RangeError("evidence_document_id is required: the restored interface's conformance evidence (Technology Guide §5.7)");
  if (input.restored_on < cur.detected_on) throw new RangeError(`restored ${input.restored_on} precedes the detection ${cur.detected_on}`);
  const day = daysBetween(cur.detected_on, input.restored_on);
  const row: IntegrationInterfaceRow = { ...cur, status: "compliant", restored_on: input.restored_on, evidence_document_id: input.evidence_document_id };
  return { row, late: day > 120, day, event: { type: "integration.compliance.restored", aggregate: { kind: "integration_interfaces", id: cur.id }, occurredAt: `${input.restored_on}T12:00:00.000Z`, payload: { interface: cur.id, restored_at: input.restored_on, detected_at: cur.detected_on, day, late: day > 120, was_disabled: cur.status === "disabled", evidence_document_id: input.evidence_document_id } } };
}

// ---------------------------------------------------------------- vendor incident-notice SLA (SM_VENDOR_INCIDENT_NOTICE_SLA; rule 6 INCIDENT_NOTICE_24H)
export const DEFAULT_INCIDENT_NOTICE_SLA_HOURS = 24;
export type VendorIncidentRow = {
  readonly id: string; readonly vendor_id: string; readonly security_incident_id: string; readonly vendor_aware_at: string; readonly reported_at: string; readonly sla_hours: number; readonly notice_due_at: string;
  readonly notice_received_at: string | null; readonly notice_document_id: string | null; readonly sla_met: boolean | null; readonly hours_to_notice: number | null;
};
const isoInstant = (s: string, what: string): string => { const ms = Date.parse(s); if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || Number.isNaN(ms)) throw new RangeError(`${what} must be an ISO timestamp`); return new Date(ms).toISOString(); };
/**
 * A vendor incident reported to Supermortgage (19.2 incident linked to the vendor): the contractual notice SLA (24 h default,
 * mandatory clause INCIDENT_NOTICE_24H so Supermortgage can meet its own 36 h Form 101 clock) runs from the vendor's
 * awareness as reported — the `vendor.incident.reported` event occurs *at* `vendor_aware_at`, so the registry's +24 h
 * clock lands at awareness + SLA.
 */
export function vendorIncidentReported(input: { readonly vendor_id: string; readonly security_incident_id: string; readonly vendor_aware_at: string; readonly reported_at: string; readonly sla_hours: number | null }): {
  readonly row: VendorIncidentRow;
  readonly event: { readonly type: "vendor.incident.reported"; readonly aggregate: { readonly kind: "vendors"; readonly id: string }; readonly occurredAt: string; readonly payload: { readonly vendor_id: string; readonly security_incident_id: string; readonly incident_id: string; readonly vendor_aware_at: string; readonly reported_at: string; readonly sla_hours: number; readonly notice_due_at: string; readonly timer: "SM_VENDOR_INCIDENT_NOTICE_SLA" } };
} {
  if (!input.vendor_id) throw new RangeError("vendor_id is required"); if (!input.security_incident_id) throw new RangeError("security_incident_id is required (19.2 incident)");
  const aware = isoInstant(input.vendor_aware_at, "vendor_aware_at"); const reported = isoInstant(input.reported_at, "reported_at");
  if (Date.parse(reported) < Date.parse(aware)) throw new RangeError(`reported_at ${reported} precedes the vendor's awareness ${aware}`);
  const sla_hours = input.sla_hours ?? DEFAULT_INCIDENT_NOTICE_SLA_HOURS; if (!(sla_hours > 0)) throw new RangeError("sla_hours must be positive");
  const notice_due_at = new Date(Date.parse(aware) + sla_hours * 3_600_000).toISOString();
  const row: VendorIncidentRow = { id: `${input.vendor_id}:${input.security_incident_id}`, vendor_id: input.vendor_id, security_incident_id: input.security_incident_id, vendor_aware_at: aware, reported_at: reported, sla_hours, notice_due_at, notice_received_at: null, notice_document_id: null, sla_met: null, hours_to_notice: null };
  return { row, event: { type: "vendor.incident.reported", aggregate: { kind: "vendors", id: input.vendor_id }, occurredAt: aware, payload: { vendor_id: input.vendor_id, security_incident_id: input.security_incident_id, incident_id: input.security_incident_id, vendor_aware_at: aware, reported_at: reported, sla_hours, notice_due_at, timer: "SM_VENDOR_INCIDENT_NOTICE_SLA" } } };
}
/** "notice received": the vendor's written incident notice, measured against the SLA; a miss is logged as a vendor SLA breach and feeds a triggered reassessment. */
export function vendorIncidentNoticeReceived(input: { readonly row: VendorIncidentRow; readonly notice_received_at: string; readonly document_id: string | null }): {
  readonly row: VendorIncidentRow; readonly sla_met: boolean; readonly hours_to_notice: number;
  readonly event: { readonly type: "vendor.incident.notice_received"; readonly aggregate: { readonly kind: "vendors"; readonly id: string }; readonly occurredAt: string; readonly payload: { readonly vendor_id: string; readonly security_incident_id: string; readonly received_at: string; readonly sla_met: boolean; readonly sla_hours: number; readonly hours_to_notice: number; readonly notice_document_id: string | null } };
  readonly breach: { readonly type: "vendor.sla_breach.logged"; readonly payload: { readonly vendor_id: string; readonly security_incident_id: string; readonly sla_hours: number; readonly hours_to_notice: number; readonly clause: "INCIDENT_NOTICE_24H" } } | null;
  readonly reassessment: { readonly type: "vendor.assessment.due"; readonly payload: { readonly vendor_id: string; readonly kind: "triggered"; readonly reason: string; readonly due: PlainDate } } | null;
} {
  const r = input.row; if (r.notice_received_at) throw new RangeError(`vendor incident ${r.id}: notice already received ${r.notice_received_at}`);
  const received = isoInstant(input.notice_received_at, "notice_received_at");
  if (Date.parse(received) < Date.parse(r.vendor_aware_at)) throw new RangeError(`notice_received_at ${received} precedes the vendor's awareness ${r.vendor_aware_at}`);
  const hours_to_notice = Math.round(((Date.parse(received) - Date.parse(r.vendor_aware_at)) / 3_600_000) * 100) / 100;
  const sla_met = hours_to_notice <= r.sla_hours;
  const row: VendorIncidentRow = { ...r, notice_received_at: received, notice_document_id: input.document_id, sla_met, hours_to_notice };
  const receivedOn = received.slice(0, 10) as PlainDate;
  return { row, sla_met, hours_to_notice,
    event: { type: "vendor.incident.notice_received", aggregate: { kind: "vendors", id: r.vendor_id }, occurredAt: received, payload: { vendor_id: r.vendor_id, security_incident_id: r.security_incident_id, received_at: received, sla_met, sla_hours: r.sla_hours, hours_to_notice, notice_document_id: input.document_id } },
    breach: sla_met ? null : { type: "vendor.sla_breach.logged", payload: { vendor_id: r.vendor_id, security_incident_id: r.security_incident_id, sla_hours: r.sla_hours, hours_to_notice, clause: "INCIDENT_NOTICE_24H" } },
    reassessment: sla_met ? null : { type: "vendor.assessment.due", payload: { vendor_id: r.vendor_id, kind: "triggered", reason: `incident notice ${hours_to_notice} h after awareness exceeds the ${r.sla_hours} h SLA`, due: receivedOn } } };
}

// ---------------------------------------------------------------- LL-2026-04 — AI governance policy approval and annual review (FNMA_LL2026_04_POLICY_REVIEW_365)
export type AiPolicyRow = { readonly code: string; readonly version: string; readonly owner: string; readonly document_id: string | null; readonly approved_at: PlainDate | null; readonly approved_by: string | null; readonly reviewed_at: PlainDate | null; readonly reviewed_by: string | null; readonly next_review_due: PlainDate | null; readonly status: "draft" | "approved" | "reviewed" };
const isOfficer = (a: ActorLike): boolean => a.kind === "human" && a.role === "officer";
/** LL-2026-04: written AI/ML policies approved with designated owner(s); the approval starts the annual review clock (`ai.policy.approved`, +1 year). */
export function aiPolicyApproved(input: { readonly policy_code: string; readonly version: string; readonly owner: string; readonly approved_on: PlainDate; readonly approved_by: ActorLike; readonly document_id: string | null; readonly current: AiPolicyRow | null }): {
  readonly row: AiPolicyRow; readonly next_review_due: PlainDate;
  readonly event: { readonly type: "ai.policy.approved"; readonly aggregate: { readonly kind: "ai_policy_documents"; readonly id: string }; readonly occurredAt: string; readonly payload: { readonly policy_code: string; readonly version: string; readonly owner: string; readonly approved_on: PlainDate; readonly approved_at: PlainDate; readonly approved_by: string; readonly document_id: string | null; readonly next_review_due: PlainDate; readonly timer: "FNMA_LL2026_04_POLICY_REVIEW_365" } };
} {
  if (!input.policy_code || !input.version) throw new RangeError("policy_code and version are required"); if (!input.owner.trim()) throw new RangeError("owner is required: LL-2026-04 designated owner(s)");
  if (!isOfficer(input.approved_by)) throw new RangeError("LL-2026-04: the designated owner (officer) approves the AI/ML policy");
  if (input.current && input.current.version === input.version && input.current.status !== "draft") throw new RangeError(`${input.policy_code} v${input.version} is already ${input.current.status}`);
  const next_review_due = addYears(input.approved_on, 1);
  const row: AiPolicyRow = { code: input.policy_code, version: input.version, owner: input.owner, document_id: input.document_id, approved_at: input.approved_on, approved_by: input.approved_by.id, reviewed_at: null, reviewed_by: null, next_review_due, status: "approved" };
  return { row, next_review_due, event: { type: "ai.policy.approved", aggregate: { kind: "ai_policy_documents", id: input.policy_code }, occurredAt: `${input.approved_on}T12:00:00.000Z`, payload: { policy_code: input.policy_code, version: input.version, owner: input.owner, approved_on: input.approved_on, approved_at: input.approved_on, approved_by: input.approved_by.id, document_id: input.document_id, next_review_due, timer: "FNMA_LL2026_04_POLICY_REVIEW_365" } } };
}
/** "`ai_policy.reviewed` (owner)": the designated owner's annual review record (DOC_AI_GOVERNANCE_POLICY); the next review is due a year after this one. */
export function aiPolicyReviewed(input: { readonly row: AiPolicyRow | null; readonly policy_code: string; readonly reviewed_on: PlainDate; readonly reviewer: ActorLike; readonly document_id: string | null }): {
  readonly row: AiPolicyRow; readonly late: boolean; readonly next_review_due: PlainDate;
  readonly event: { readonly type: "ai_policy.reviewed"; readonly aggregate: { readonly kind: "ai_policy_documents"; readonly id: string }; readonly occurredAt: string; readonly payload: { readonly policy_code: string; readonly version: string; readonly owner: string; readonly reviewed_on: PlainDate; readonly reviewed_at: PlainDate; readonly reviewed_by: string; readonly signed_by_owner: true; readonly late: boolean; readonly review_document_id: string | null; readonly next_review_due: PlainDate } };
} {
  const cur = input.row; if (!cur || cur.status === "draft" || cur.approved_at === null) throw new RangeError(`${input.policy_code} has no approved version to review`);
  if (!isOfficer(input.reviewer)) throw new RangeError("LL-2026-04: the designated owner (officer) reviews and signs the policy at least annually");
  if (input.reviewed_on < cur.approved_at) throw new RangeError(`review ${input.reviewed_on} precedes the approval ${cur.approved_at}`);
  const due = cur.next_review_due ?? addYears(cur.approved_at, 1); const late = input.reviewed_on > due; const next_review_due = addYears(input.reviewed_on, 1);
  const row: AiPolicyRow = { ...cur, reviewed_at: input.reviewed_on, reviewed_by: input.reviewer.id, next_review_due, status: "reviewed", document_id: input.document_id ?? cur.document_id };
  return { row, late, next_review_due, event: { type: "ai_policy.reviewed", aggregate: { kind: "ai_policy_documents", id: cur.code }, occurredAt: `${input.reviewed_on}T12:00:00.000Z`, payload: { policy_code: cur.code, version: cur.version, owner: cur.owner, reviewed_on: input.reviewed_on, reviewed_at: input.reviewed_on, reviewed_by: input.reviewer.id, signed_by_owner: true, late, review_document_id: input.document_id, next_review_due } } };
}

// ---------------------------------------------------------------- the officer's signature behind a recorded Fannie Mae notice
export type NoticeRefs = { readonly document_id: string; readonly contract_event_id: string | null; readonly request_id: string | null; readonly authorization_id: string | null; readonly tech_provider_change_id: string | null };
/**
 * Guardrail "the agent cannot send a Fannie Mae notice": when the agent records a notice as sent it must cite the officer's
 * signature *for that notice* — an officer event, or the officer's completed work item, that names the same document,
 * contract event, request, Form 101 authorization or provider change (an unrelated officer act proves nothing).
 */
export function signatureReferencesNotice(refs: NoticeRefs, payload: Record<string, unknown>, evidenceDocumentId: string | null = null): boolean {
  if (evidenceDocumentId && evidenceDocumentId === refs.document_id) return true;
  const pairs: [string, string | null][] = [["document_id", refs.document_id], ["evidence_document_id", refs.document_id], ["contract_event_id", refs.contract_event_id], ["request_id", refs.request_id], ["authorization_id", refs.authorization_id], ["tech_provider_change_id", refs.tech_provider_change_id], ["change_id", refs.tech_provider_change_id]];
  return pairs.some(([k, v]) => !!v && String(payload[k] ?? "") === v);
}
