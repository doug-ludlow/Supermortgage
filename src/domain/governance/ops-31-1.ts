/**
 * §31.1 operating rules — licensing, approvals and the partner boundary: the `compliance-sentinel` (licensing persona)
 * runtime over the registries this process owns (`licenses`, `license_requirements` / `jurisdiction_rules.licensing`,
 * `mlo_roster`, `fnma_approvals`, `eligibility_inputs_origination`, `tpo_program_reviews`, `ai_intake_legal_positions`;
 * migration 0107). Small pure functions, one per rule / T-id; every emitter validates before it appends. Nothing here
 * contacts a borrower, posts to the ledger or files anything with NMLS, a state or Fannie Mae (humans file; the agent
 * prepares). The partner (lender of record) is a `parties` row; licences, NMLS/MLO records and approvals hang off it.
 *
 * Every 31.1 event carries `source: "origination"` (or an `applicationId`) so the origination-side rows arm under
 * src/kernel/timers/engine.ts isOriginationContext. Events (timer subject in brackets):
 *   licensing.gate.opened{gate, state?, product?}                                  [application, else gate aggregate]
 *   licensing.gate.blocked{gate, state, reason, command}                            [same]  — SM_LICENSE_STATE_GATE breach
 *   licensing.supervised_act.recorded{state, activity, person_id, supervising_mlo_of_record_id, basis}   (T2)
 *   license.applied · license.status.changed{from, to, holder_kind, jurisdiction, expires_at}   [license — arms SM_LICENSE_EXPIRY_WARN_90 on to=approved]
 *   license.renewal.window.opened{year, holder_kind, renewal_deadline, ce_deadline}   [license — arms NMLS_RENEWAL_1101_1231 / SAFE_1008_107_MLO_CE_8H_1231]
 *   license.renewal.requested · license.renewed{expires_at} · license.expired{expired_on} · license.reinstated · license.ce.completed{hours, …}
 *   mlo.roster.updated · mlo.sponsorship.changed · application.mlo_of_record.reassigned (21.1's name; reason nmls_inactive)
 *   jurisdiction.licensing.verified{state, verified_at} · jurisdiction.licensing.changed{state}   [jurisdiction]
 *   ai_intake.position.issued{state, issued_at}                                       [jurisdiction]
 *   fnma.approval.recorded{kind} · fnma.approval.status.changed{from, to} · tsp.certification.granted{product}
 *   integration.production_call.requested{product, adapter}                            [application] — FNMA_TSP_PRODUCTION_CERT_GATE trigger
 *   closing.enote_default.overridden{reason=emortgage_gate_closed}                     [application] (T7)
 *   quarter.closed{period, quarter_end} · eligibility.orig_inputs.computed{period} · eligibility.orig_inputs.delivered   [quarter]
 *   schedule.tick{cadence, job} · nmls.sync.completed · eligibility.origination_1b.reattested{year}
 *   tpo.financials.received · tpo.approval_file.opened · tpo.review.completed{kind}     [tpo_program sm | quarter]
 *   config.changed{key=origination.warehouse_legal_form, from, to}                     (T9 — 26.3 / 27.1 consume)
 *   org.change.recorded{material} — 18.4's event, built by its orgChangeRecorded (T13); referenced, never redefined.
 */
import { type PlainDate, plainDate as D, addDays, daysBetween, parts, ymd, endOfMonth } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { Escalation, EscalationService } from "../../app/escalations.ts";
import { orgChangeRecorded } from "../qc-audit/ops-18-4.ts";

export const SENTINEL: Actor = { kind: "agent", id: "compliance-sentinel" };
/** Stamped on every 31.1 payload: the origination-side timers arm only under origination context (engine isOriginationContext). */
const ORIG = { source: "origination" } as const;
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const civilDate = (iso: string): PlainDate => D(nonEmpty(iso, "at").slice(0, 10));
const yearOf = (d: PlainDate): number => parts(d).y;

/** A refusal this process makes: the gate/rule code, the citation and the reason (`escalation_id` when a task was opened). */
export class LicensingRefused extends Error {
  readonly code: string; readonly citation: string; readonly escalationId: string | null;
  constructor(code: string, citation: string, reason: string, escalationId: string | null = null) { super(`${code}: ${reason}`); this.name = "LicensingRefused"; this.code = code; this.citation = citation; this.escalationId = escalationId; }
}

// ============================================================ registries (data model)
export type HolderKind = "partner_company" | "partner_branch" | "partner_individual" | "sm_company" | "sm_branch" | "sm_individual";
export type ActivityScope = "lend" | "broker" | "service" | "processing_underwriting_entity" | "mlo_individual" | "processor_underwriter_individual" | "exempt_letter";
export type LicenseStatus = "planned" | "applied" | "pending" | "approved" | "approved_conditions" | "approved_inactive" | "renewal_requested" | "terminated_expired" | "terminated_surrendered" | "suspended" | "revoked" | "not_required" | "exempt";
export const LICENSE_STATUSES: readonly LicenseStatus[] = ["planned", "applied", "pending", "approved", "approved_conditions", "approved_inactive", "renewal_requested", "terminated_expired", "terminated_surrendered", "suspended", "revoked", "not_required", "exempt"];
/** Statuses the agent may only write from a Consumer Access/B2B record or an issued licence document (guardrail 1; T10). */
export const EVIDENCED_STATUSES: readonly LicenseStatus[] = ["approved", "approved_conditions", "approved_inactive", "exempt", "renewal_requested"];
export const GOOD_STANDING: readonly LicenseStatus[] = ["approved", "approved_conditions", "exempt"];
export interface License {
  readonly license_id: string; readonly holder_kind: HolderKind; readonly holder_ref: string; readonly nmls_id: string | null; readonly jurisdiction: string; readonly license_type_code: string;
  readonly authority_citation: string; readonly activity_scope: readonly ActivityScope[]; readonly status: LicenseStatus;
  readonly issued_at: PlainDate | null; readonly expires_at: PlainDate | null; readonly renewal_window_opens: PlainDate | null; readonly renewal_requested_at: PlainDate | null; readonly renewed_at: PlainDate | null; readonly reinstatement_deadline: PlainDate | null;
  readonly sponsor_license_id: string | null; readonly bond_amount_cents: bigint | null; readonly bond_expires_at: PlainDate | null; readonly qualifying_individual_id: string | null;
  readonly ce_completed_at: PlainDate | null; readonly ce_hours: number | null; readonly last_nmls_sync_at: string | null; readonly nmls_status_raw: string | null; readonly evidence_document_id: string | null; readonly notes: string | null;
}
export type LicenseInput = Pick<License, "license_id" | "holder_kind" | "holder_ref" | "jurisdiction" | "license_type_code" | "activity_scope"> & Partial<License>;
/** A licence row with the registry's defaults (status `planned`, no dates, no evidence). */
export function newLicense(i: LicenseInput): License {
  nonEmpty(i.license_id, "license_id"); nonEmpty(i.holder_ref, "holder_ref"); nonEmpty(i.license_type_code, "license_type_code");
  if (!/^[A-Z]{2}$/.test(i.jurisdiction)) throw new RangeError(`jurisdiction ${JSON.stringify(i.jurisdiction)} is not a two-letter state code`);
  if (!i.activity_scope.length) throw new RangeError("activity_scope needs at least one scope");
  const status = i.status ?? "planned";
  if (!LICENSE_STATUSES.includes(status)) throw new RangeError(`status ${status} is not a licenses.status`);
  return { nmls_id: null, authority_citation: "", issued_at: null, expires_at: null, renewal_window_opens: null, renewal_requested_at: null, renewed_at: null, reinstatement_deadline: null, sponsor_license_id: null, bond_amount_cents: null, bond_expires_at: null,
    qualifying_individual_id: null, ce_completed_at: null, ce_hours: null, last_nmls_sync_at: null, nmls_status_raw: null, evidence_document_id: null, notes: null, ...i, status };
}
export const isIndividual = (l: Pick<License, "holder_kind">): boolean => l.holder_kind === "partner_individual" || l.holder_kind === "sm_individual";
export const isPartner = (l: Pick<License, "holder_kind">): boolean => l.holder_kind.startsWith("partner_");
const inGoodStanding = (l: License, asOf: PlainDate): boolean => GOOD_STANDING.includes(l.status) && (l.expires_at === null || l.expires_at >= asOf) && (l.issued_at === null || l.issued_at <= asOf);

export type RequirementActivity = "lend" | "broker" | "service" | "processing_underwriting_entity" | "processor_underwriter_individual_independent" | "mlo_individual" | "solicitation_display";
export type RequirementKind = "license" | "registration" | "exemption_letter" | "declaration" | "none" | "unverified";
export type VerificationStatus = "verified" | "partially_verified" | "unverified";
export interface LicenseRequirement {
  readonly requirement_id: string; readonly jurisdiction: string; readonly activity: RequirementActivity; readonly applies_to: "partner" | "sm"; readonly requirement_kind: RequirementKind; readonly license_type_code: string | null;
  readonly citation: string; readonly quoted_text: string; readonly verification_status: VerificationStatus; readonly verified_at: PlainDate | null; readonly verified_by: string | null; readonly source_url: string | null; readonly effective_from: PlainDate; readonly superseded_by: string | null;
}
export type ProcessorLicenseRequired = "none" | "exemption_letter" | "registration" | "entity_license" | "unverified";
export type AiIntakePosition = "assisted_required" | "autonomous_permitted_by_written_position" | "unresolved";
export interface AiIntakeLegalPosition { readonly jurisdiction: string; readonly position: AiIntakePosition; readonly memo_document_id: string | null; readonly counsel: string; readonly issued_at: PlainDate; readonly review_due_at: PlainDate; }
/** `jurisdiction_rules.licensing` — the per-state projection other processes read (20.2/22.1/22.3/25.1 see `lender_license_types` and `processor_license_required` as top-level columns). */
export interface JurisdictionLicensing {
  readonly state: string; readonly lender_license_types: readonly string[]; readonly branch_license_required: boolean; readonly mlo_license_type: string | null; readonly processor_license_required: ProcessorLicenseRequired;
  readonly independent_processor_individual_license_required: boolean | null; readonly ai_intake_position: AiIntakePosition; readonly ai_intake_position_document_id: string | null; readonly lock_agreement_ref: string | null; readonly verification_status: VerificationStatus;
}
const PROCESSOR_KIND: Record<RequirementKind, ProcessorLicenseRequired> = { license: "entity_license", registration: "registration", exemption_letter: "exemption_letter", declaration: "none", none: "none", unverified: "unverified" };
const VERIFICATION_RANK: Record<VerificationStatus, number> = { verified: 2, partially_verified: 1, unverified: 0 };
/** Open question 4 default: `assisted_required` everywhere; `autonomous` only on a written state-specific memo reviewed annually (SM_O121_AI_POSITION_REVIEW_365 degrades a stale autonomous memo to `unresolved`). */
export function effectiveAiPosition(p: AiIntakeLegalPosition | null | undefined, asOf: PlainDate): AiIntakePosition {
  if (!p) return "assisted_required";
  if (p.position === "autonomous_permitted_by_written_position" && p.review_due_at < asOf) return "unresolved";
  return p.position;
}
/** Derive a state's `jurisdiction_rules.licensing` row from its current `license_requirements` rows and AI-intake position; a state with no rows is `unverified` and fail-closed (rule 1; §F "Other states"). */
export function deriveJurisdictionLicensing(state: string, rows: readonly LicenseRequirement[], position: AiIntakeLegalPosition | null, asOf: PlainDate): JurisdictionLicensing {
  const cur = rows.filter((r) => r.jurisdiction === state && r.superseded_by === null && r.effective_from <= asOf);
  const of = (applies_to: "partner" | "sm", activity: RequirementActivity) => cur.find((r) => r.applies_to === applies_to && r.activity === activity) ?? null;
  const lender = cur.filter((r) => r.applies_to === "partner" && (r.activity === "lend" || r.activity === "broker") && r.license_type_code);
  const mlo = of("partner", "mlo_individual"), entity = of("sm", "processing_underwriting_entity"), indiv = of("sm", "processor_underwriter_individual_independent");
  const verification: VerificationStatus = cur.length ? cur.reduce<VerificationStatus>((acc, r) => (VERIFICATION_RANK[r.verification_status] < VERIFICATION_RANK[acc] ? r.verification_status : acc), "verified") : "unverified";
  return { state, lender_license_types: lender.map((r) => r.license_type_code!), branch_license_required: cur.some((r) => r.activity === "solicitation_display" && r.requirement_kind === "license"), mlo_license_type: mlo?.license_type_code ?? null,
    processor_license_required: entity ? PROCESSOR_KIND[entity.requirement_kind] : "unverified", independent_processor_individual_license_required: indiv ? indiv.requirement_kind !== "none" && indiv.requirement_kind !== "unverified" : entity ? null : null,
    ai_intake_position: effectiveAiPosition(position, asOf), ai_intake_position_document_id: position?.memo_document_id ?? null, lock_agreement_ref: null, verification_status: verification };
}

export interface MloRosterMember {
  readonly mlo_id: string; readonly person_id: string; readonly name: string; readonly nmls_id: string; readonly employer: "partner" | "sm"; readonly sponsor_license_id: string | null; readonly state_licenses: readonly string[];
  readonly states_assignable: readonly string[]; readonly lo_comp_plan_id: string | null; readonly capacity_per_day: number; readonly status: "active" | "inactive" | "offboarded"; readonly assignable: boolean; readonly open_queue: number;
}
export type ApprovalEntity = "partner" | "sm";
export type ApprovalKind = "seller_servicer_approval" | "servicer_approval" | "emortgage_special_approval" | "tsp_integration_agreement" | "tsp_certification" | "tm_tsp_product_assignment" | "developer_portal_app" | "ucdp_lender_registration" | "ucdp_lender_agent_registration" | "loan_delivery_warehouse_org" | "pe_whole_loan_access" | "cpm_access" | "mers_membership" | "mers_eregistry_addendum" | "enote_warehouse_agreement" | "custodian_form_2017" | "related_party_designation";
export type ApprovalStatus = "planned" | "applied" | "testing" | "granted" | "active" | "conditions" | "suspended" | "revoked" | "expired";
export const TSP_PRODUCTS = ["du", "earlycheck", "ucdp", "ucd", "property_data", "pricing_committing", "purchase_advice", "ami_homeready", "appraisal_findings", "loan_lookup"] as const;
export type TspProduct = (typeof TSP_PRODUCTS)[number];
export interface FnmaApproval { readonly approval_id: string; readonly entity: ApprovalEntity; readonly kind: ApprovalKind; readonly product: TspProduct | null; readonly seller_servicer_number: string | null; readonly status: ApprovalStatus; readonly granted_at: PlainDate | null; readonly expires_at: PlainDate | null; readonly conditions: Record<string, unknown>; readonly evidence_document_id: string | null; readonly contact_ref: string | null; }
export type TpoReviewKind = "initial_approval" | "annual_financial_statements" | "quarterly_performance" | "licensing_reverification" | "qc_plan_review";
export interface TpoProgramReview { readonly review_id: string; readonly subject: "sm"; readonly kind: TpoReviewKind; readonly period_start: PlainDate; readonly period_end: PlainDate; readonly inputs: Record<string, unknown>; readonly findings: Record<string, unknown>; readonly rating: string | null; readonly completed_at: PlainDate | null; readonly approved_by: string | null; readonly document_id: string | null; }

// ============================================================ rule 1: state readiness (SM_LICENSE_STATE_GATE)
export type ReadinessReason = "partner_license_missing" | "branch_license_missing" | "no_assignable_mlo" | "sm_credential_missing" | "matrix_unverified" | "ai_position_unresolved";
export interface ReadinessFacts { readonly state: string; readonly as_of: PlainDate; readonly licenses: readonly License[]; readonly jurisdiction: JurisdictionLicensing; readonly roster: readonly MloRosterMember[]; readonly officer_risk_acceptance?: { readonly decision_id: string; readonly attorney_memo_document_id: string } | null; }
export interface Readiness { readonly state: string; readonly open: boolean; readonly predicates: { partner_company_ok: boolean; branch_ok: boolean; mlo_available: boolean; sm_processing_ok: boolean; matrix_ok: boolean; ai_position_ok: boolean }; readonly reason: ReadinessReason | null; readonly escalated_party: "partner" | "sm" | null; readonly evaluated_at: PlainDate; }
const PARTNER_REASONS: readonly ReadinessReason[] = ["partner_license_missing", "branch_license_missing", "no_assignable_mlo"];
/** `sm_processing_ok(S) = (processor_license_required(S) = none) ∨ (∃ licenses{holder_kind=sm_company, jurisdiction=S, activity_scope ∋ processing_underwriting_entity ∨ exempt_letter, status ∈ approved, exempt})`; `unverified` never opens (fail-closed). */
export function smProcessingOk(state: string, j: JurisdictionLicensing, licenses: readonly License[], asOf: PlainDate): boolean {
  if (j.processor_license_required === "none") return true;
  if (j.processor_license_required === "unverified") return false;
  return licenses.some((l) => l.holder_kind === "sm_company" && l.jurisdiction === state && (l.activity_scope.includes("processing_underwriting_entity") || l.activity_scope.includes("exempt_letter")) && inGoodStanding(l, asOf));
}
/** `open(S) = partner_company_ok ∧ branch_ok ∧ mlo_available ∧ sm_processing_ok ∧ matrix_ok ∧ ai_position_ok` (rule 1); the first failing predicate names the reason and which party's officer is escalated. */
export function stateReadiness(f: ReadinessFacts): Readiness {
  const S = f.state, j = f.jurisdiction;
  if (j.state !== S) throw new RangeError(`jurisdiction row is for ${j.state}, not ${S}`);
  const partnerLicensed = (type: string) => f.licenses.some((l) => l.holder_kind === "partner_company" && l.jurisdiction === S && l.license_type_code === type && inGoodStanding(l, f.as_of));
  const partner_company_ok = j.lender_license_types.length > 0 && j.lender_license_types.every(partnerLicensed);
  const branch_ok = !j.branch_license_required || f.licenses.some((l) => l.holder_kind === "partner_branch" && l.jurisdiction === S && inGoodStanding(l, f.as_of));
  const mlo_available = f.roster.some((m) => m.status === "active" && m.assignable && m.states_assignable.includes(S));
  const sm_processing_ok = smProcessingOk(S, j, f.licenses, f.as_of);
  const matrix_ok = j.verification_status !== "unverified" || (!!f.officer_risk_acceptance && j.processor_license_required !== "unverified");
  const ai_position_ok = j.ai_intake_position !== "unresolved";
  const predicates = { partner_company_ok, branch_ok, mlo_available, sm_processing_ok, matrix_ok, ai_position_ok };
  const reason: ReadinessReason | null = !matrix_ok ? "matrix_unverified" : !partner_company_ok ? "partner_license_missing" : !branch_ok ? "branch_license_missing" : !mlo_available ? "no_assignable_mlo" : !sm_processing_ok ? "sm_credential_missing" : !ai_position_ok ? "ai_position_unresolved" : null;
  return { state: S, open: reason === null, predicates, reason, escalated_party: reason === null ? null : PARTNER_REASONS.includes(reason) ? "partner" : "sm", evaluated_at: f.as_of };
}
const STATE_NAMES: Record<string, string> = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
export const stateName = (s: string): string => STATE_NAMES[s] ?? s;
/** The only borrower-facing statement a blocked state permits (rule 3): no licence detail, no reason, no adverse-action language. */
export const borrowerStateClosedMessage = (partnerName: string, state: string): string => `${partnerName} is not currently accepting applications for ${stateName(state)} properties through this channel.`;

export interface GateCommand { readonly command: string; readonly at: string; readonly application_id?: string | null; readonly lead_id?: string | null; readonly partner_name?: string; }
const gateSubject = (i: { application_id?: string | null }, agg: { kind: string; id: string }) => (i.application_id ? { applicationId: i.application_id } : { aggregate: agg });
/**
 * `assertGateOpen(SM_LICENSE_STATE_GATE)` at every command the timer row names (20.2 solicitation, 20.3 lead, 21.1 application
 * start / MLO assignment, `issueLE`, `lock`): open → `licensing.gate.opened`; closed → `licensing.gate.blocked{state, reason}`,
 * a sev 1 `officer` escalation (partner officer for a partner gap, SM officer for an SM credential/matrix gap) and the
 * command is refused; the borrower is told only that the partner does not lend in that state (T3). No quote, no application.
 */
export function assertStateGate(events: EventStore, i: GateCommand, f: ReadinessFacts, escalations?: EscalationService): { readiness: Readiness; event: DomainEvent } {
  nonEmpty(i.command, "command");
  const r = stateReadiness(f);
  const sub = gateSubject(i, { kind: "state_readiness", id: f.state });
  if (r.open) return { readiness: r, event: events.append({ type: "licensing.gate.opened", ...sub, actor: SENTINEL, occurredAt: i.at, payload: { ...ORIG, gate: "SM_LICENSE_STATE_GATE", state: f.state, command: i.command, predicates: r.predicates, application_id: i.application_id ?? null, lead_id: i.lead_id ?? null } }) };
  const escalation = escalations?.open({ kind: "officer", severity: "sev1", ...(i.application_id ? { applicationId: i.application_id } : {}), payload: { gate: "SM_LICENSE_STATE_GATE", state: f.state, reason: r.reason, escalated_party: r.escalated_party, command: i.command, lead_id: i.lead_id ?? null, predicates: r.predicates, task: r.reason === "matrix_unverified" ? "counsel verification of license_requirements" : "obtain the missing licence/credential" } }, SENTINEL) ?? null;
  const event = events.append({ type: "licensing.gate.blocked", ...sub, actor: SENTINEL, occurredAt: i.at, payload: { ...ORIG, gate: "SM_LICENSE_STATE_GATE", state: f.state, reason: r.reason, command: i.command, escalated_party: r.escalated_party, escalation_id: escalation?.id ?? null, application_id: i.application_id ?? null, lead_id: i.lead_id ?? null, predicates: r.predicates, borrower_message: borrowerStateClosedMessage(i.partner_name ?? "The lender", f.state), quote_created: false, application_created: false } });
  throw new LicensingRefused("SM_LICENSE_STATE_GATE", "31.1 rule 1 / rule 3 (state readiness; fail-closed matrix)", `${i.command} refused: ${f.state} readiness closed — ${r.reason}`, escalation?.id ?? null);
}

// ============================================================ human-touchpoint routing (rule 1, second sentence; T1 / T2)
export interface Person { readonly person_id: string; readonly employer: "partner" | "sm"; readonly name?: string; }
export type IndividualActivity = "processor_underwriter_individual" | "mlo_individual";
/** `isLicensedFor(person, S, activity)`: an approved individual licence row for S whose scope covers the activity (an MLO licence also covers processing/underwriting). */
export function isLicensedFor(person: Person, state: string, activity: IndividualActivity, licenses: readonly License[], asOf: PlainDate): boolean {
  return licenses.some((l) => l.holder_ref === person.person_id && isIndividual(l) && l.jurisdiction === state && inGoodStanding(l, asOf) && (l.activity_scope.includes(activity) || l.activity_scope.includes("mlo_individual")));
}
/** The escalation router's assignee filter: where the state licenses independent processors/underwriters, an SM human must hold the S licence, else be a partner employee; where SM works under an exemption letter/registration, SM employees act under the MLO of record's supervision. */
export function routeHumanTouchpoint(role: "underwriting_reviewer" | "licensed_specialist", state: string, candidates: readonly Person[], j: JurisdictionLicensing, licenses: readonly License[], asOf: PlainDate): { role: string; eligible: Person[]; rejected: { person_id: string; reason: string }[] } {
  const eligible: Person[] = [], rejected: { person_id: string; reason: string }[] = [];
  const smEntityOk = smProcessingOk(state, j, licenses, asOf);
  for (const p of candidates) {
    if (p.employer === "partner") { eligible.push(p); continue; }
    if (j.independent_processor_individual_license_required) { if (isLicensedFor(p, state, "processor_underwriter_individual", licenses, asOf)) eligible.push(p); else rejected.push({ person_id: p.person_id, reason: `no approved ${state} processor/underwriter or MLO licence (independent contractor — ${j.processor_license_required})` }); continue; }
    if (smEntityOk) eligible.push(p); else rejected.push({ person_id: p.person_id, reason: `SM holds no ${state} processing/underwriting credential (${j.processor_license_required})` });
  }
  return { role, eligible, rejected };
}
export interface SupervisedAct { readonly state: string; readonly activity: "condition_clearance" | "processing" | "underwriting" | "needs_list"; readonly person: Person; readonly application_id: string; readonly supervising_mlo_of_record_id: string; readonly at: string; }
/** T2 (Ohio, OAC 1301:8-7-32): under SM's letter of exemption an SM employee without an MLO licence may perform clerical/support duties — each act records the partner licensee who "assigns, authorizes, and monitors" it (the MLO of record). */
export function recordSupervisedAct(events: EventStore, a: SupervisedAct, j: JurisdictionLicensing, licenses: readonly License[]): { basis: "exemption_letter" | "registration" | "individual_license" | "partner_employee"; license_id: string | null; event: DomainEvent } {
  nonEmpty(a.application_id, "application_id"); nonEmpty(a.supervising_mlo_of_record_id, "supervising_mlo_of_record_id");
  const asOf = civilDate(a.at);
  let basis: "exemption_letter" | "registration" | "individual_license" | "partner_employee", license_id: string | null = null;
  if (a.person.employer === "partner") basis = "partner_employee";
  else if (j.independent_processor_individual_license_required) {
    const l = licenses.find((x) => x.holder_ref === a.person.person_id && x.jurisdiction === a.state && isIndividual(x) && inGoodStanding(x, asOf));
    if (!l) throw new LicensingRefused("SM_LICENSE_STATE_GATE", "31.1 rule 1 (human-touchpoint routing)", `${a.person.person_id} holds no approved ${a.state} individual licence`);
    basis = "individual_license"; license_id = l.license_id;
  } else {
    const l = licenses.find((x) => x.holder_kind === "sm_company" && x.jurisdiction === a.state && (x.activity_scope.includes("exempt_letter") || x.activity_scope.includes("processing_underwriting_entity")) && inGoodStanding(x, asOf));
    if (!l) throw new LicensingRefused("SM_LICENSE_STATE_GATE", "31.1 rule 1 (sm_processing_ok)", `SM holds no ${a.state} processing/underwriting credential`);
    basis = j.processor_license_required === "exemption_letter" ? "exemption_letter" : "registration"; license_id = l.license_id;
  }
  const event = events.append({ type: "licensing.supervised_act.recorded", applicationId: a.application_id, actor: SENTINEL, occurredAt: a.at, payload: { ...ORIG, state: a.state, activity: a.activity, person_id: a.person.person_id, employer: a.person.employer, supervising_mlo_of_record_id: a.supervising_mlo_of_record_id, basis, license_id, mlo_license_required: false } });
  return { basis, license_id, event };
}

// ============================================================ licence state machine (NMLS sync or documented evidence only)
export const LICENSE_TRANSITIONS: Readonly<Record<LicenseStatus, readonly LicenseStatus[]>> = {
  planned: ["applied", "not_required", "exempt"], applied: ["pending", "approved", "approved_conditions", "planned", "exempt"], pending: ["approved", "approved_conditions", "planned", "suspended"],
  approved: ["renewal_requested", "terminated_expired", "terminated_surrendered", "approved_conditions", "approved_inactive", "suspended", "revoked"], approved_conditions: ["approved", "renewal_requested", "terminated_expired", "terminated_surrendered", "suspended", "revoked"],
  approved_inactive: ["approved", "terminated_expired", "terminated_surrendered", "suspended", "revoked"], renewal_requested: ["approved", "approved_conditions", "terminated_expired", "suspended", "revoked"], terminated_expired: ["approved", "planned"],
  terminated_surrendered: ["planned"], suspended: ["planned", "approved", "revoked"], revoked: ["planned"], not_required: ["planned"], exempt: ["planned", "terminated_expired", "suspended", "revoked"],
};
export interface StatusChange { readonly to: LicenseStatus; readonly at: string; readonly evidence_document_id?: string | null; readonly nmls_status_raw?: string | null; readonly reason?: string | null; readonly expires_at?: PlainDate | null; readonly issued_at?: PlainDate | null; readonly regulator?: string | null; }
/** Guardrail 1 / T10: a licence never becomes `approved` (or any evidenced status) without a Consumer Access/B2B record or an issued licence document. */
export function assertLicenseEvidence(to: LicenseStatus, evidence: { evidence_document_id?: string | null; nmls_status_raw?: string | null }): void {
  if (EVIDENCED_STATUSES.includes(to) && !evidence.evidence_document_id && !evidence.nmls_status_raw) throw new LicensingRefused("LICENSE_APPROVAL_NEEDS_EVIDENCE", "31.1 guardrails: may never mark a license/approval approved without evidence (state machine: transitions only from NMLS sync or documented evidence)", `licenses.upsert{status=${to}} refused: no evidence document and no NMLS record`);
}
/**
 * A status transition made from an NMLS record or evidence; `license.status.changed{from, to, expires_at}` arms
 * SM_LICENSE_EXPIRY_WARN_90 on `to=approved`. `suspended`/`revoked` on a partner licence also records 18.4's
 * `org.change.recorded{material}` (rule 10; T13) so FNMA_A4102_ORG_CHANGE_5BD runs on the partner — referenced, never redefined.
 */
export function changeLicenseStatus(events: EventStore, l: License, c: StatusChange): { license: License; event: DomainEvent; org_change: DomainEvent | null } {
  if (!LICENSE_TRANSITIONS[l.status].includes(c.to)) throw new RangeError(`licence ${l.license_id}: ${l.status} → ${c.to} is not a transition of the 31.1 state machine`);
  assertLicenseEvidence(c.to, c);
  const on = civilDate(c.at);
  const license: License = { ...l, status: c.to, ...(c.expires_at !== undefined ? { expires_at: c.expires_at } : {}), ...(c.issued_at !== undefined ? { issued_at: c.issued_at } : {}), ...(c.evidence_document_id ? { evidence_document_id: c.evidence_document_id } : {}), ...(c.nmls_status_raw ? { nmls_status_raw: c.nmls_status_raw, last_nmls_sync_at: c.at } : {}) };
  const event = events.append({ type: "license.status.changed", aggregate: { kind: "license", id: l.license_id }, actor: SENTINEL, occurredAt: c.at, payload: { ...ORIG, license_id: l.license_id, from: l.status, to: c.to, holder_kind: l.holder_kind, holder_ref: l.holder_ref, jurisdiction: l.jurisdiction, license_type_code: l.license_type_code, expires_at: license.expires_at, evidence_document_id: license.evidence_document_id, nmls_status_raw: license.nmls_status_raw, reason: c.reason ?? null, regulator: c.regulator ?? null } });
  let org_change: DomainEvent | null = null;
  if ((c.to === "suspended" || c.to === "revoked") && isPartner(l)) {
    // A4-1-02: a licence suspension/revocation is a material adverse change in the partner's ability to do business; 18.4 classifies and clocks it.
    const oc = orgChangeRecorded({ entity: "partner", kind: "material_adverse_change", occurred_on: on, confidence: 1 });
    org_change = events.append({ ...oc.event, occurredAt: c.at, payload: { ...oc.event.payload, source_process: "31.1", license_id: l.license_id, jurisdiction: l.jurisdiction, license_type_code: l.license_type_code, license_status: c.to, regulator: c.regulator ?? null } });
  }
  return { license, event, org_change };
}
/** `licenses.upsert` (tool): a new row or a status change, both under the evidence guardrail; `license.applied` marks the NMLS filing evidence (planned → applied). */
export function upsertLicense(events: EventStore, existing: License | null, input: LicenseInput & { readonly at: string; readonly reason?: string | null }): { license: License; event: DomainEvent | null; org_change: DomainEvent | null } {
  if (!existing) {
    const l = newLicense(input);
    assertLicenseEvidence(l.status, l);
    const event = l.status === "applied" ? events.append({ type: "license.applied", aggregate: { kind: "license", id: l.license_id }, actor: SENTINEL, occurredAt: input.at, payload: { ...ORIG, license_id: l.license_id, holder_kind: l.holder_kind, jurisdiction: l.jurisdiction, license_type_code: l.license_type_code, evidence_document_id: l.evidence_document_id } }) : null;
    return { license: l, event, org_change: null };
  }
  const to = input.status ?? existing.status;
  if (to === existing.status) return { license: { ...existing, ...input, status: to }, event: null, org_change: null };
  const r = changeLicenseStatus(events, { ...existing, ...input, status: existing.status }, { to, at: input.at, evidence_document_id: input.evidence_document_id ?? null, nmls_status_raw: input.nmls_status_raw ?? null, reason: input.reason ?? null, ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}), ...(input.issued_at !== undefined ? { issued_at: input.issued_at } : {}) });
  return { license: r.license, event: r.event, org_change: r.org_change };
}

// ============================================================ NMLS renewal calendar (rule 4; §1008.107 CE)
export interface RenewalCalendar { readonly year: number; readonly window_opens: PlainDate; readonly deadline: PlainDate; readonly reinstatement_opens: PlainDate; readonly reinstatement_ends: PlainDate; readonly policy_ce_target: PlainDate; readonly next_expires_at: PlainDate; }
/** NMLS: window Nov 1 – Dec 31 (end of day ET); reinstatement Jan 1 – last day of February; policy CE/renewal target Dec 1; the renewed term expires Dec 31 next year. */
export function renewalCalendar(year: number): RenewalCalendar {
  return { year, window_opens: ymd(year, 11, 1), deadline: ymd(year, 12, 31), reinstatement_opens: ymd(year + 1, 1, 1), reinstatement_ends: endOfMonth(ymd(year + 1, 2, 1)), policy_ce_target: ymd(year, 12, 1), next_expires_at: ymd(year + 1, 12, 31) };
}
export const NMLS_ANNUAL_TYPE = /_MLO$|_MORTGAGE_BANKER$|_MORTGAGE_BROKER$|_RMLA_CERTIFICATE$|_EXEMPTION_LETTER$|_REGISTRATION$|_ENTITY$|_COMPANY$|_LOAN_PROCESSOR_UNDERWRITER$|_LOAN_ORIGINATOR_CONTRACT_PROCESSOR$/;
/** NMLS-managed licences renew on the uniform Dec 31 calendar; non-NMLS credentials carry their own `expires_at` (jurisdiction overrides). */
export const isNmlsAnnual = (l: License): boolean => l.nmls_id !== null && NMLS_ANNUAL_TYPE.test(l.license_type_code) && l.expires_at !== null && parts(l.expires_at).m === 12 && parts(l.expires_at).d === 31;
/** Nov 1: `license.renewal.window.opened` per renewable row — arms NMLS_RENEWAL_1101_1231 (Dec 31) and, for individuals, SAFE_1008_107_MLO_CE_8H_1231 (anchor `ce_deadline`). */
export function openRenewalWindow(events: EventStore, licenses: readonly License[], year: number, at: string): { licenses: License[]; events: DomainEvent[]; calendar: RenewalCalendar } {
  const cal = renewalCalendar(year);
  const out: DomainEvent[] = [];
  const next = licenses.map((l) => {
    if (!isNmlsAnnual(l) || !GOOD_STANDING.includes(l.status) || yearOf(l.expires_at!) !== year) return l;
    out.push(events.append({ type: "license.renewal.window.opened", aggregate: { kind: "license", id: l.license_id }, actor: SENTINEL, occurredAt: at, payload: { ...ORIG, license_id: l.license_id, holder_kind: l.holder_kind, holder_ref: l.holder_ref, jurisdiction: l.jurisdiction, year, window_opens: cal.window_opens, renewal_deadline: cal.deadline, ce_deadline: cal.deadline, policy_target: cal.policy_ce_target, reinstatement_ends: cal.reinstatement_ends, individual: isIndividual(l) } }));
    return { ...l, renewal_window_opens: cal.window_opens, reinstatement_deadline: cal.reinstatement_ends };
  });
  return { licenses: next, events: out, calendar: cal };
}
export interface CeCompletion { readonly completed_on: PlainDate; readonly federal_law_hours: number; readonly ethics_hours: number; readonly nontraditional_hours: number; readonly elective_hours?: number; readonly certificate_document_id: string; readonly at: string; }
export const CE_MINIMUM = { total: 8, federal_law: 3, ethics: 2, nontraditional: 2 } as const;
/** 12 CFR 1008.107: ≥ 8 NMLSR-approved hours — 3 federal law, 2 ethics, 2 nontraditional — credited in the year taken; `license.ce.completed{hours}` satisfies SAFE_1008_107_MLO_CE_8H_1231 and carries next year's `ce_deadline`. */
export function recordCeCompletion(events: EventStore, l: License, c: CeCompletion): { license: License; hours: number; event: DomainEvent } {
  if (!isIndividual(l)) throw new RangeError(`CE is recorded on individual licences, not ${l.holder_kind}`);
  nonEmpty(c.certificate_document_id, "certificate_document_id");
  if (c.federal_law_hours < CE_MINIMUM.federal_law || c.ethics_hours < CE_MINIMUM.ethics || c.nontraditional_hours < CE_MINIMUM.nontraditional) throw new RangeError(`CE ${c.federal_law_hours}/${c.ethics_hours}/${c.nontraditional_hours} is below the §1008.107 3/2/2 minimum`);
  const hours = c.federal_law_hours + c.ethics_hours + c.nontraditional_hours + (c.elective_hours ?? 0);
  if (hours < CE_MINIMUM.total) throw new RangeError(`CE ${hours} h is below the §1008.107 8-hour minimum`);
  const y = yearOf(c.completed_on);
  const event = events.append({ type: "license.ce.completed", aggregate: { kind: "license", id: l.license_id }, actor: SENTINEL, occurredAt: c.at, payload: { ...ORIG, license_id: l.license_id, holder_ref: l.holder_ref, hours, federal_law_hours: c.federal_law_hours, ethics_hours: c.ethics_hours, nontraditional_hours: c.nontraditional_hours, completed_on: c.completed_on, credited_year: y, ce_deadline: ymd(y + 1, 12, 31), certificate_document_id: c.certificate_document_id } });
  return { license: { ...l, ce_completed_at: c.completed_on, ce_hours: hours }, hours, event };
}
/** Renewal guard for individuals: ≥ 8 h CE credited in the renewal year (the year the request is made). */
export const ceCurrentForRenewal = (l: License, year: number): boolean => !isIndividual(l) || (l.ce_completed_at !== null && (l.ce_hours ?? 0) >= CE_MINIMUM.total && yearOf(l.ce_completed_at) === year);
/** A human (officer for a company, the MLO for an individual) submits the request in NMLS inside the window; the platform records it (SAFE breach: "renewal cannot be requested" without CE). */
export function requestRenewal(events: EventStore, l: License, r: { requested_on: PlainDate; by: Actor; confirmation_document_id: string; at: string }): { license: License; event: DomainEvent } {
  if (r.by.kind !== "human") throw new LicensingRefused("NMLS_FILING_IS_HUMAN", "31.1 guardrails: may never file anything with NMLS (humans file; the agent prepares)", "renewal requests are submitted in NMLS by the officer or the MLO");
  if (!GOOD_STANDING.includes(l.status)) throw new RangeError(`licence ${l.license_id} is ${l.status}; only an approved licence renews`);
  const cal = renewalCalendar(yearOf(l.expires_at ?? r.requested_on));
  if (r.requested_on < cal.window_opens || r.requested_on > cal.deadline) throw new LicensingRefused("NMLS_RENEWAL_1101_1231", "NMLS Annual Renewal Overview: the renewal period begins November 1 and ends December 31", `${r.requested_on} is outside the ${cal.year} renewal window ${cal.window_opens}–${cal.deadline}`);
  if (!ceCurrentForRenewal(l, cal.year)) throw new LicensingRefused("SAFE_1008_107_MLO_CE_8H_1231", "12 CFR 1008.107 (8 h CE before renewal)", `licence ${l.license_id}: CE for ${cal.year} not complete — renewal cannot be requested`);
  const next: License = { ...l, status: "renewal_requested", renewal_requested_at: r.requested_on, evidence_document_id: r.confirmation_document_id };
  const event = events.append({ type: "license.renewal.requested", aggregate: { kind: "license", id: l.license_id }, actor: r.by, occurredAt: r.at, payload: { ...ORIG, license_id: l.license_id, holder_kind: l.holder_kind, requested_on: r.requested_on, year: cal.year, deadline: cal.deadline, confirmation_document_id: r.confirmation_document_id } });
  return { license: next, event };
}
/** NMLS approves the renewal (status mirrored from the sync, backdated to the new term): `expires_at` = Dec 31 next year; `license.renewed` satisfies NMLS_RENEWAL_1101_1231 and `license.status.changed{to=approved}` re-arms the expiry warning. */
export function approveRenewal(events: EventStore, l: License, a: { approved_on: PlainDate; nmls_status_raw: string; at: string }): { license: License; events: DomainEvent[] } {
  if (l.status !== "renewal_requested") throw new RangeError(`licence ${l.license_id} is ${l.status}, not renewal_requested`);
  const cal = renewalCalendar(yearOf(l.expires_at ?? a.approved_on));
  const changed = changeLicenseStatus(events, l, { to: "approved", at: a.at, nmls_status_raw: a.nmls_status_raw, expires_at: cal.next_expires_at });
  const license: License = { ...changed.license, renewed_at: a.approved_on, renewal_requested_at: l.renewal_requested_at };
  const renewed = events.append({ type: "license.renewed", aggregate: { kind: "license", id: l.license_id }, actor: SENTINEL, occurredAt: a.at, payload: { ...ORIG, license_id: l.license_id, holder_kind: l.holder_kind, renewed_at: a.approved_on, expires_at: cal.next_expires_at, renewal_deadline: cal.next_expires_at, term_year: cal.year + 1 } });
  return { license, events: [changed.event, renewed] };
}
/** Jan 1: NMLS sets `terminated_expired` on every unrenewed row and the platform mirrors it — `license.expired` arms NMLS_REINSTATEMENT_0101_0228 (anchor `expired_on`, to the last day of February). */
export function expireUnrenewed(events: EventStore, licenses: readonly License[], on: PlainDate, at: string): { licenses: License[]; expired: License[]; events: DomainEvent[] } {
  const out: DomainEvent[] = [], expired: License[] = [];
  const next = licenses.map((l) => {
    if (!GOOD_STANDING.includes(l.status) || l.expires_at === null || l.expires_at >= on || !isNmlsAnnual(l)) return l;
    const deadline = renewalCalendar(yearOf(l.expires_at)).reinstatement_ends;
    const changed = changeLicenseStatus(events, l, { to: "terminated_expired", at, nmls_status_raw: "Terminated - Expired", reason: "renewal not requested by December 31" });
    out.push(changed.event, events.append({ type: "license.expired", aggregate: { kind: "license", id: l.license_id }, actor: SENTINEL, occurredAt: at, payload: { ...ORIG, license_id: l.license_id, holder_kind: l.holder_kind, holder_ref: l.holder_ref, jurisdiction: l.jurisdiction, expired_on: on, reinstatement_deadline: deadline } }));
    const e: License = { ...changed.license, reinstatement_deadline: deadline }; expired.push(e); return e;
  });
  return { licenses: next, expired, events: out };
}
/** Reinstatement (Jan 1 – last day of February) once CE is complete: `license.reinstated` satisfies NMLS_REINSTATEMENT_0101_0228 and the row is `approved` through Dec 31 of the reinstated year. */
export function reinstateLicense(events: EventStore, l: License, r: { reinstated_on: PlainDate; nmls_status_raw: string; at: string }): { license: License; events: DomainEvent[] } {
  if (l.status !== "terminated_expired") throw new RangeError(`licence ${l.license_id} is ${l.status}, not terminated_expired`);
  if (l.reinstatement_deadline && r.reinstated_on > l.reinstatement_deadline) throw new LicensingRefused("NMLS_REINSTATEMENT_0101_0228", "NMLS: reinstatement January 1 through the last day of February; afterwards a new application is required", `${r.reinstated_on} is after ${l.reinstatement_deadline} — re-application required`);
  if (isIndividual(l) && ((l.ce_hours ?? 0) < CE_MINIMUM.total || l.ce_completed_at === null)) throw new LicensingRefused("SAFE_1008_107_MLO_CE_8H_1231", "12 CFR 1008.107", `licence ${l.license_id}: CE not complete — cannot reinstate`);
  const expires_at = ymd(yearOf(r.reinstated_on), 12, 31);
  const changed = changeLicenseStatus(events, l, { to: "approved", at: r.at, nmls_status_raw: r.nmls_status_raw, expires_at });
  const reinstated = events.append({ type: "license.reinstated", aggregate: { kind: "license", id: l.license_id }, actor: SENTINEL, occurredAt: r.at, payload: { ...ORIG, license_id: l.license_id, holder_kind: l.holder_kind, holder_ref: l.holder_ref, reinstated_on: r.reinstated_on, expires_at } });
  return { license: { ...changed.license, renewed_at: r.reinstated_on }, events: [changed.event, reinstated] };
}

// ============================================================ MLO roster (derived nightly)
/** CE current for the renewal year: ≥ 8 h credited in the current or the prior year, or a licence issued this year (first-year licensees renew on next year's CE). */
export function ceCurrent(l: License, asOf: PlainDate): boolean {
  if (!isIndividual(l)) return true;
  if (l.issued_at !== null && yearOf(l.issued_at) === yearOf(asOf)) return true;
  return l.ce_completed_at !== null && (l.ce_hours ?? 0) >= CE_MINIMUM.total && yearOf(l.ce_completed_at) >= yearOf(asOf) - 1;
}
const sponsorshipActive = (l: License, licenses: readonly License[], asOf: PlainDate): boolean => { if (!l.sponsor_license_id) return false; const s = licenses.find((x) => x.license_id === l.sponsor_license_id); return !!s && inGoodStanding(s, asOf); };
/** Roster rule: `employer = sm` rows are assignable only where the sponsor is an SM lender/broker licence in that state **and** the state's written AI-intake position permits (default never — open question 5). */
export function smMloPermitted(member: MloRosterMember, state: string, j: JurisdictionLicensing, licenses: readonly License[], asOf: PlainDate): { permitted: boolean; refusal_codes: string[] } {
  const codes: string[] = [];
  if (member.employer !== "sm") return { permitted: true, refusal_codes: codes };
  codes.push("employer=sm");
  const sponsor = member.sponsor_license_id ? licenses.find((l) => l.license_id === member.sponsor_license_id) : undefined;
  const smSponsor = !!sponsor && sponsor.holder_kind === "sm_company" && sponsor.jurisdiction === state && (sponsor.activity_scope.includes("lend") || sponsor.activity_scope.includes("broker")) && inGoodStanding(sponsor, asOf);
  const smMlo = licenses.some((l) => l.holder_ref === member.person_id && l.holder_kind === "sm_individual" && l.jurisdiction === state && l.activity_scope.includes("mlo_individual") && inGoodStanding(l, asOf) && !!l.sponsor_license_id && l.sponsor_license_id === sponsor?.license_id);
  if (!smSponsor || !smMlo) codes.push(`no SM-sponsored ${state} MLO license`);
  if (j.ai_intake_position !== "autonomous_permitted_by_written_position") codes.push(`ai_intake_position = ${j.ai_intake_position}`);
  return { permitted: codes.length === 1, refusal_codes: codes };
}
/** Nightly derivation: `states_assignable` = licence `approved`, sponsorship active, CE current, no suspended/revoked; `assignable` = active with ≥ 1 state; SM employees per smMloPermitted. */
export function recomputeRoster(members: readonly MloRosterMember[], licenses: readonly License[], jurisdictions: readonly JurisdictionLicensing[], asOf: PlainDate): MloRosterMember[] {
  return members.map((m) => {
    const states = new Set<string>();
    for (const id of m.state_licenses) {
      const l = licenses.find((x) => x.license_id === id);
      if (!l || !isIndividual(l) || !l.activity_scope.includes("mlo_individual") || !inGoodStanding(l, asOf) || !sponsorshipActive(l, licenses, asOf) || !ceCurrent(l, asOf)) continue;
      const j = jurisdictions.find((x) => x.state === l.jurisdiction);
      if (m.employer === "sm" && !(j && smMloPermitted(m, l.jurisdiction, j, licenses, asOf).permitted)) continue;
      states.add(l.jurisdiction);
    }
    const states_assignable = [...states].sort();
    return { ...m, states_assignable, assignable: m.status === "active" && states_assignable.length > 0 };
  });
}
/** T12: an `mlo_of_record` proposal for a state — the roster refuses SM employees with the three reasons the spec names. */
export function proposeMloOfRecord(member: MloRosterMember, state: string, j: JurisdictionLicensing, licenses: readonly License[], asOf: PlainDate): { accepted: boolean; refusal_codes: string[] } {
  if (member.status !== "active") return { accepted: false, refusal_codes: [`roster status ${member.status}`] };
  const sm = smMloPermitted(member, state, j, licenses, asOf);
  if (!sm.permitted) return { accepted: false, refusal_codes: sm.refusal_codes };
  const licensed = member.state_licenses.some((id) => { const l = licenses.find((x) => x.license_id === id); return !!l && l.jurisdiction === state && inGoodStanding(l, asOf) && sponsorshipActive(l, licenses, asOf) && ceCurrent(l, asOf); });
  return licensed ? { accepted: true, refusal_codes: [] } : { accepted: false, refusal_codes: [`no approved, sponsored ${state} MLO license with current CE`] };
}
export interface InFlightApplication { readonly application_id: string; readonly state: string; readonly mlo_of_record_id: string; readonly delivered_disclosures: readonly { document_id: string; kind: string; nmlsr_id: string; delivered_at: string }[]; }
/** Rule 4 (Chen): an unassignable MLO's in-flight applications are reassigned overnight to assignable MLOs in the same states (21.1's `application.mlo_of_record.reassigned{reason=nmls_inactive}` on each, then `mlo.roster.updated`); delivered disclosures are never re-issued (§1026.36(g) attaches at issuance) — only *new* disclosures carry the new NMLSR ID. */
export function reassignInFlightApplications(events: EventStore, i: { from_mlo_id: string; applications: readonly InFlightApplication[]; roster: readonly MloRosterMember[]; at: string; reason?: "nmls_inactive" | "sla_breach" | "other" }): { reassignments: { application_id: string; state: string; from: string; to: string; nmlsr_id: string }[]; applications: InFlightApplication[]; events: DomainEvent[]; delivered_disclosures_unchanged: true } {
  const from = i.roster.find((m) => m.mlo_id === i.from_mlo_id);
  if (from && from.assignable) throw new RangeError(`${i.from_mlo_id} is still assignable — recompute the roster before reassigning`);
  const load = new Map(i.roster.map((m) => [m.mlo_id, m.open_queue] as const));
  const out: DomainEvent[] = [], reassignments: { application_id: string; state: string; from: string; to: string; nmlsr_id: string }[] = [];
  const applications = i.applications.map((a) => {
    if (a.mlo_of_record_id !== i.from_mlo_id) return a;
    const pick = i.roster.filter((m) => m.status === "active" && m.assignable && m.states_assignable.includes(a.state) && m.mlo_id !== i.from_mlo_id).sort((x, y) => (load.get(x.mlo_id)! - load.get(y.mlo_id)!) || x.mlo_id.localeCompare(y.mlo_id))[0];
    if (!pick) throw new LicensingRefused("SM_LICENSE_STATE_GATE", "31.1 rule 4 / rule 1 (mlo_available)", `no assignable MLO of record for ${a.state} to take ${a.application_id}`);
    load.set(pick.mlo_id, load.get(pick.mlo_id)! + 1);
    out.push(events.append({ type: "application.mlo_of_record.reassigned", applicationId: a.application_id, actor: SENTINEL, occurredAt: i.at, payload: { ...ORIG, application_id: a.application_id, previous_mlo_of_record_id: a.mlo_of_record_id, mlo_of_record_id: pick.mlo_id, nmlsr_id: pick.nmls_id, mlo_name: pick.name, reason: i.reason ?? "nmls_inactive", state: a.state, reassigned_at: i.at, delivered_disclosures_reissued: false, delivered_disclosure_ids: a.delivered_disclosures.map((d) => d.document_id) } }));
    reassignments.push({ application_id: a.application_id, state: a.state, from: a.mlo_of_record_id, to: pick.mlo_id, nmlsr_id: pick.nmls_id });
    return { ...a, mlo_of_record_id: pick.mlo_id, delivered_disclosures: a.delivered_disclosures };
  });
  out.push(events.append({ type: "mlo.roster.updated", aggregate: { kind: "mlo_roster", id: i.from_mlo_id }, actor: SENTINEL, occurredAt: i.at, payload: { ...ORIG, mlo_id: i.from_mlo_id, assignable: false, reassigned: reassignments.length, application_ids: reassignments.map((r) => r.application_id), reason: i.reason ?? "nmls_inactive" } }));
  return { reassignments, applications, events: out, delivered_disclosures_unchanged: true };
}
export function recordSponsorshipChange(events: EventStore, m: MloRosterMember, c: { sponsor_license_id: string | null; at: string; reason: string }): { member: MloRosterMember; event: DomainEvent } {
  const event = events.append({ type: "mlo.sponsorship.changed", aggregate: { kind: "mlo_roster", id: m.mlo_id }, actor: SENTINEL, occurredAt: c.at, payload: { ...ORIG, mlo_id: m.mlo_id, from: m.sponsor_license_id, to: c.sponsor_license_id, reason: c.reason } });
  return { member: { ...m, sponsor_license_id: c.sponsor_license_id }, event };
}

// ============================================================ nightly NMLS sync (SM_O121_NMLS_SYNC_DAILY)
export interface NmlsRecord { readonly nmls_id: string; readonly license_type_code: string; readonly jurisdiction: string; readonly status_raw: string; readonly expires_at: PlainDate | null; readonly sponsor_nmls_id?: string | null; }
/** Consumer Access/B2B status text → registry status; the stricter status wins over a portal action the sync cannot see (edge case "License data mismatch"). */
export function nmlsStatusToRegistry(raw: string): LicenseStatus | null {
  const s = raw.toLowerCase();
  if (/terminated.*expired|expired/.test(s)) return "terminated_expired";
  if (/terminated.*surrender|surrender/.test(s)) return "terminated_surrendered";
  if (/revok/.test(s)) return "revoked";
  if (/suspend/.test(s)) return "suspended";
  if (/approved.*inactive/.test(s)) return "approved_inactive";
  if (/approved.*condition/.test(s)) return "approved_conditions";
  if (/renewal.*request|renewal.*pending/.test(s)) return "renewal_requested";
  if (/^approved/.test(s)) return "approved";
  if (/pending/.test(s)) return "pending";
  return null;
}
export const NMLS_SYNC_STALE_DAYS = 3;
export const nmlsSyncStale = (lastSyncAt: string | null, now: string): boolean => lastSyncAt === null || daysBetween(civilDate(lastSyncAt), civilDate(now)) > NMLS_SYNC_STALE_DAYS;
export function nightlySyncTick(events: EventStore, i: { date: PlainDate; at: string }): DomainEvent {
  return events.append({ type: "schedule.tick", aggregate: { kind: "nmls_sync", id: "registry" }, actor: { kind: "system", id: "scheduler" }, occurredAt: i.at, payload: { ...ORIG, cadence: "daily", job: "nmls_sync", date: i.date, time: "02:00 ET" } });
}
/** The nightly pull: every row with an NMLS id is refreshed (`last_nmls_sync_at`, raw status, expiry); a changed status is mirrored through the state machine with the record as evidence; `nmls.sync.completed` satisfies the daily row. */
export function syncNmls(events: EventStore, licenses: readonly License[], records: readonly NmlsRecord[], i: { at: string }): { licenses: License[]; changed: DomainEvent[]; not_found: string[]; event: DomainEvent } {
  const changed: DomainEvent[] = [], not_found: string[] = [];
  const next = licenses.map((l) => {
    if (!l.nmls_id) return l;
    const rec = records.find((r) => r.nmls_id === l.nmls_id && r.jurisdiction === l.jurisdiction && r.license_type_code === l.license_type_code);
    if (!rec) { not_found.push(l.license_id); return l; }
    const mirrored = nmlsStatusToRegistry(rec.status_raw);
    let cur: License = { ...l, last_nmls_sync_at: i.at, nmls_status_raw: rec.status_raw, expires_at: rec.expires_at ?? l.expires_at };
    if (mirrored && mirrored !== l.status && LICENSE_TRANSITIONS[l.status].includes(mirrored)) { const r = changeLicenseStatus(events, cur, { to: mirrored, at: i.at, nmls_status_raw: rec.status_raw, expires_at: cur.expires_at }); cur = r.license; changed.push(r.event); if (r.org_change) changed.push(r.org_change); }
    return cur;
  });
  const event = events.append({ type: "nmls.sync.completed", aggregate: { kind: "nmls_sync", id: "registry" }, actor: SENTINEL, occurredAt: i.at, payload: { ...ORIG, synced_at: i.at, rows: next.filter((l) => l.nmls_id).length, changed: changed.length, not_found, feeds: "25.1 license_checks" } });
  return { licenses: next, changed, not_found, event };
}

// ============================================================ matrix (license_requirements) and AI-intake positions
export type MatrixDraft = Omit<LicenseRequirement, "verification_status" | "verified_at" | "verified_by" | "superseded_by"> & { readonly verification_status?: VerificationStatus };
/** `matrix.propose`: the agent drafts a row from statute text with its citation and quoted text — never `verified` (counsel does); a draft is `unverified` (fail-closed) until counsel verifies. */
export function proposeMatrixRow(events: EventStore, d: MatrixDraft, at: string): { row: LicenseRequirement; event: DomainEvent } {
  nonEmpty(d.requirement_id, "requirement_id"); nonEmpty(d.citation, "citation"); nonEmpty(d.quoted_text, "quoted_text");
  if (d.verification_status === "verified") throw new LicensingRefused("MATRIX_NEVER_VERIFIED_BY_AGENT", "31.1 guardrails: may never mark a matrix row verified", "matrix.propose drafts; counsel verifies");
  const row: LicenseRequirement = { ...d, verification_status: "unverified", verified_at: null, verified_by: null, superseded_by: null };
  const event = events.append({ type: "matrix.row.proposed", aggregate: { kind: "jurisdiction", id: d.jurisdiction }, actor: SENTINEL, occurredAt: at, payload: { ...ORIG, state: d.jurisdiction, requirement_id: d.requirement_id, activity: d.activity, applies_to: d.applies_to, requirement_kind: d.requirement_kind, citation: d.citation } });
  return { row, event };
}
/** Counsel's verification (`verified` / `partially_verified`): `jurisdiction.licensing.verified{state, verified_at}` arms and re-arms SM_O121_MATRIX_REVERIFY_365. */
export function verifyMatrixRow(events: EventStore, row: LicenseRequirement, v: { verified_on: PlainDate; by: Actor; status?: "verified" | "partially_verified"; memo_document_id: string; at: string }): { row: LicenseRequirement; event: DomainEvent } {
  if (v.by.kind !== "human" || !(v.by.role === "counsel" || v.by.role === "attorney")) throw new LicensingRefused("MATRIX_NEVER_VERIFIED_BY_AGENT", "31.1 guardrails: may never mark a matrix row verified — counsel does", `verification by ${v.by.kind}:${v.by.id} refused`);
  nonEmpty(v.memo_document_id, "memo_document_id");
  const status = v.status ?? "verified";
  const next: LicenseRequirement = { ...row, verification_status: status, verified_at: v.verified_on, verified_by: v.by.id };
  const event = events.append({ type: "jurisdiction.licensing.verified", aggregate: { kind: "jurisdiction", id: row.jurisdiction }, actor: v.by, occurredAt: v.at, payload: { ...ORIG, state: row.jurisdiction, requirement_id: row.requirement_id, activity: row.activity, verification_status: status, verified_at: v.verified_on, verified_by: v.by.id, memo_document_id: v.memo_document_id } });
  return { row: next, event };
}
/** T11: a state-page change detected by the sentinel degrades the state's verified rows to `partially_verified` and opens a counsel task; the state stays open (matrix_ok needs only ≠ unverified) and the processor rule is untouched until counsel decides. */
export function detectStatePageChange(events: EventStore, escalations: EscalationService, rows: readonly LicenseRequirement[], i: { state: string; detected_on: PlainDate; source_url: string; summary: string; at: string }): { rows: LicenseRequirement[]; degraded: string[]; escalation: Escalation; event: DomainEvent; processor_rule_changed: false } {
  const degraded: string[] = [];
  const next = rows.map((r) => { if (r.jurisdiction !== i.state || r.superseded_by !== null || r.verification_status !== "verified") return r; degraded.push(r.requirement_id); return { ...r, verification_status: "partially_verified" as const }; });
  const escalation = escalations.open({ kind: "attorney", ownerRole: "counsel", severity: "sev3", payload: { task: "verify license_requirements after a state page change", state: i.state, detected_on: i.detected_on, source_url: i.source_url, summary: i.summary, degraded } }, SENTINEL);
  const event = events.append({ type: "jurisdiction.licensing.changed", aggregate: { kind: "jurisdiction", id: i.state }, actor: SENTINEL, occurredAt: i.at, payload: { ...ORIG, state: i.state, detected_on: i.detected_on, source_url: i.source_url, degraded, to: "partially_verified", processor_rule_changed: false, escalation_id: escalation.id, gate_effect: "none — state stays open until counsel decides" } });
  return { rows: next, degraded, escalation, event, processor_rule_changed: false };
}
/** A written state-specific AI-intake position (counsel memo), reviewed annually (`ai_intake.position.issued{state, issued_at}` arms SM_O121_AI_POSITION_REVIEW_365). */
export function issueAiIntakePosition(events: EventStore, p: Omit<AiIntakeLegalPosition, "review_due_at"> & { readonly at: string; readonly by: Actor }): { position: AiIntakeLegalPosition; event: DomainEvent } {
  if (p.by.kind !== "human" || !(p.by.role === "counsel" || p.by.role === "attorney")) throw new LicensingRefused("AI_POSITION_IS_COUNSEL_ACT", "31.1 escalations: attorney — AI-intake positions", `a written legal position is issued by counsel, not ${p.by.kind}:${p.by.id}`);
  if (p.position === "autonomous_permitted_by_written_position" && !p.memo_document_id) throw new LicensingRefused("AUTONOMOUS_NEEDS_WRITTEN_POSITION", "open question 4: autonomous only on a written state-specific memo", `${p.jurisdiction}: no memo document`);
  const position: AiIntakeLegalPosition = { jurisdiction: p.jurisdiction, position: p.position, memo_document_id: p.memo_document_id, counsel: p.counsel, issued_at: p.issued_at, review_due_at: addDays(p.issued_at, 365) };
  const event = events.append({ type: "ai_intake.position.issued", aggregate: { kind: "jurisdiction", id: p.jurisdiction }, actor: p.by, occurredAt: p.at, payload: { ...ORIG, state: p.jurisdiction, position: p.position, issued_at: p.issued_at, review_due_at: position.review_due_at, memo_document_id: p.memo_document_id, counsel: p.counsel } });
  return { position, event };
}

// ============================================================ Fannie Mae approvals (eMortgage / TSP gates)
export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = { planned: ["applied"], applied: ["testing", "granted", "planned"], testing: ["granted", "applied"], granted: ["active", "conditions", "suspended", "revoked", "expired"], active: ["conditions", "suspended", "revoked", "expired"], conditions: ["active", "suspended", "revoked"], suspended: ["active", "revoked"], revoked: ["planned"], expired: ["planned", "applied"] };
const EVIDENCED_APPROVALS: readonly ApprovalStatus[] = ["granted", "active"];
/** Guardrail 1 (approvals): `granted`/`active` only from a Fannie Mae letter/e-mail, a certification confirmation or a Technology Manager screenshot. */
export function recordFnmaApproval(events: EventStore, a: Omit<FnmaApproval, "conditions" | "contact_ref" | "expires_at" | "seller_servicer_number"> & Partial<FnmaApproval>, at: string): { approval: FnmaApproval; events: DomainEvent[] } {
  nonEmpty(a.approval_id, "approval_id");
  if ((a.kind === "tsp_certification" || a.kind === "tm_tsp_product_assignment") && !a.product) throw new RangeError(`${a.kind} needs a product (${TSP_PRODUCTS.join("/")})`);
  if (a.product && !TSP_PRODUCTS.includes(a.product)) throw new RangeError(`product ${a.product} is not a TSP product`);
  if (EVIDENCED_APPROVALS.includes(a.status) && !a.evidence_document_id) throw new LicensingRefused("APPROVAL_GRANT_NEEDS_EVIDENCE", "31.1 guardrails: may never mark an approval granted without evidence", `approvals.upsert{${a.kind}${a.product ? `, ${a.product}` : ""}, status=${a.status}} refused: no evidence document`);
  if (EVIDENCED_APPROVALS.includes(a.status) && !a.granted_at) throw new RangeError(`${a.kind} ${a.status} needs granted_at`);
  const approval: FnmaApproval = { seller_servicer_number: null, expires_at: null, conditions: {}, contact_ref: null, ...a, product: a.product ?? null, granted_at: a.granted_at ?? null, evidence_document_id: a.evidence_document_id ?? null };
  const out: DomainEvent[] = [events.append({ type: "fnma.approval.recorded", aggregate: { kind: "fnma_approval", id: approval.approval_id }, actor: SENTINEL, occurredAt: at, payload: { ...ORIG, approval_id: approval.approval_id, entity: approval.entity, kind: approval.kind, product: approval.product, status: approval.status, granted_at: approval.granted_at, evidence_document_id: approval.evidence_document_id } })];
  if (approval.kind === "tsp_certification" && EVIDENCED_APPROVALS.includes(approval.status)) out.push(events.append({ type: "tsp.certification.granted", aggregate: { kind: "fnma_approval", id: approval.approval_id }, actor: SENTINEL, occurredAt: at, payload: { ...ORIG, product: approval.product, approval_id: approval.approval_id, granted_at: approval.granted_at, evidence_document_id: approval.evidence_document_id } }));
  return { approval, events: out };
}
export function changeFnmaApprovalStatus(events: EventStore, a: FnmaApproval, c: { to: ApprovalStatus; at: string; evidence_document_id?: string | null; granted_at?: PlainDate | null; conditions?: Record<string, unknown> }): { approval: FnmaApproval; events: DomainEvent[] } {
  if (!APPROVAL_TRANSITIONS[a.status].includes(c.to)) throw new RangeError(`approval ${a.approval_id}: ${a.status} → ${c.to} is not a transition`);
  const approval: FnmaApproval = { ...a, status: c.to, ...(c.granted_at ? { granted_at: c.granted_at } : {}), ...(c.evidence_document_id ? { evidence_document_id: c.evidence_document_id } : {}), ...(c.conditions ? { conditions: c.conditions } : {}) };
  if (EVIDENCED_APPROVALS.includes(c.to) && !approval.evidence_document_id) throw new LicensingRefused("APPROVAL_GRANT_NEEDS_EVIDENCE", "31.1 guardrails", `${a.kind} → ${c.to} without evidence`);
  const out: DomainEvent[] = [events.append({ type: "fnma.approval.status.changed", aggregate: { kind: "fnma_approval", id: a.approval_id }, actor: SENTINEL, occurredAt: c.at, payload: { ...ORIG, approval_id: a.approval_id, entity: a.entity, kind: a.kind, product: a.product, from: a.status, to: c.to, granted_at: approval.granted_at } })];
  if (a.kind === "tsp_certification" && EVIDENCED_APPROVALS.includes(c.to) && !EVIDENCED_APPROVALS.includes(a.status)) out.push(events.append({ type: "tsp.certification.granted", aggregate: { kind: "fnma_approval", id: a.approval_id }, actor: SENTINEL, occurredAt: c.at, payload: { ...ORIG, product: a.product, approval_id: a.approval_id, granted_at: approval.granted_at } }));
  return { approval, events: out };
}
const approvalLive = (a: FnmaApproval, asOf: PlainDate, statuses: readonly ApprovalStatus[] = ["granted", "active"]): boolean => statuses.includes(a.status) && (a.granted_at === null || a.granted_at <= asOf) && (a.expires_at === null || a.expires_at >= asOf);
/** FNMA_A2_1_01_EMORTGAGE_APPROVAL_GATE: partner eMortgage special approval granted/active **and** MERS eRegistry addendum for partner and SM **and** SM's eNote warehouse agreement, all as of the decision date. */
export function emortgageGate(approvals: readonly FnmaApproval[], asOf: PlainDate): { open: boolean; missing: string[] } {
  const has = (entity: ApprovalEntity, kind: ApprovalKind) => approvals.some((a) => a.entity === entity && a.kind === kind && approvalLive(a, asOf));
  const missing: string[] = [];
  if (!has("partner", "emortgage_special_approval")) missing.push("fnma_approvals{partner, emortgage_special_approval} not granted/active");
  if (!has("partner", "mers_eregistry_addendum")) missing.push("mers_eregistry_addendum (partner) not active");
  if (!has("sm", "mers_eregistry_addendum")) missing.push("mers_eregistry_addendum (sm) not active");
  if (!has("sm", "enote_warehouse_agreement")) missing.push("enote_warehouse_agreement (sm) not active");
  return { open: missing.length === 0, missing };
}
export type ClosingType = "ron" | "ipen" | "hybrid" | "wet";
/** Rule 8 / T7: `closing.enote_default = true` is honored only while the eMortgage gate is open for the partner; otherwise 26.2 schedules `hybrid` (paper note, eSigned ancillaries) and the default is overridden with reason `emortgage_gate_closed`. */
export function decideClosingNoteForm(events: EventStore, i: { application_id: string; closing_id: string; enote_default: boolean; requested_closing_type: ClosingType; scheduled_on: PlainDate; approvals: readonly FnmaApproval[]; at: string }): { closing_type: ClosingType; note_form: "enote" | "paper"; gate: ReturnType<typeof emortgageGate> | null; override: { field: "closing.enote_default"; from: true; to: false; reason: "emortgage_gate_closed" } | null; events: DomainEvent[] } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.closing_id, "closing_id");
  if (!i.enote_default || i.requested_closing_type === "wet") return { closing_type: i.requested_closing_type, note_form: "paper", gate: null, override: null, events: [] };
  const asOf = civilDate(i.at);
  const gate = emortgageGate(i.approvals, asOf);
  if (gate.open) return { closing_type: i.requested_closing_type, note_form: "enote", gate, override: null, events: [events.append({ type: "licensing.gate.opened", applicationId: i.application_id, actor: SENTINEL, occurredAt: i.at, payload: { ...ORIG, gate: "FNMA_A2_1_01_EMORTGAGE_APPROVAL_GATE", closing_id: i.closing_id, application_id: i.application_id, scheduled_on: i.scheduled_on, closing_type: i.requested_closing_type, enote: true } })] };
  const fallback: ClosingType = "hybrid";
  const blocked = events.append({ type: "licensing.gate.blocked", applicationId: i.application_id, actor: SENTINEL, occurredAt: i.at, payload: { ...ORIG, gate: "FNMA_A2_1_01_EMORTGAGE_APPROVAL_GATE", state: null, reason: "emortgage_gate_closed", command: "closing.schedule", closing_id: i.closing_id, application_id: i.application_id, missing: gate.missing, fallback_closing_type: fallback } });
  const overridden = events.append({ type: "closing.enote_default.overridden", applicationId: i.application_id, actor: SENTINEL, occurredAt: i.at, payload: { ...ORIG, application_id: i.application_id, closing_id: i.closing_id, field: "closing.enote_default", from: true, to: false, reason: "emortgage_gate_closed", closing_type: fallback, note_form: "paper", scheduled_on: i.scheduled_on, missing: gate.missing } });
  return { closing_type: fallback, note_form: "paper", gate, override: { field: "closing.enote_default", from: true, to: false, reason: "emortgage_gate_closed" }, events: [blocked, overridden] };
}
export interface Form101Fact { readonly status: "none" | "executed" | "acknowledged" | "active" | "terminated"; }
/** Rule 7: `FNMA_TSP_PRODUCTION_CERT_GATE(product)` opens when SM's `tsp_certification{product}` is granted, the partner's `tm_tsp_product_assignment{product}` is active and 19.3's Form 101 gate is open. Loan Delivery never opens a TSP gate (portal-only). */
export function tspProductionGate(product: TspProduct, approvals: readonly FnmaApproval[], form101: Form101Fact, asOf: PlainDate): { open: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!approvals.some((a) => a.entity === "sm" && a.kind === "tsp_certification" && a.product === product && approvalLive(a, asOf))) missing.push(`tsp_certification{${product}} not granted`);
  if (!approvals.some((a) => a.entity === "partner" && a.kind === "tm_tsp_product_assignment" && a.product === product && approvalLive(a, asOf, ["active"]))) missing.push(`tm_tsp_product_assignment{${product}} not active`);
  if (form101.status !== "acknowledged" && form101.status !== "active") missing.push("FNMA_A2107_FORM101_INCEPTION_GATE (19.3) closed");
  return { open: missing.length === 0, missing };
}
export interface ProductionCall { readonly product: TspProduct; readonly adapter: string; readonly application_id: string; readonly scope: "partner"; readonly environment: "production" | "integration"; readonly prepared_file_document_id: string | null; readonly ui_fallback: string | null; readonly at: string; }
/** T8: an adapter's production call under partner scope: `integration.production_call.requested{product}` arms the gate; closed → refused `tsp_gate_closed` and a `fnma_portal_operator` task carries the AI-prepared file to the UI fallback. */
export function requestProductionCall(events: EventStore, escalations: EscalationService, c: ProductionCall, f: { approvals: readonly FnmaApproval[]; form101: Form101Fact }): { allowed: true; gate: ReturnType<typeof tspProductionGate>; events: DomainEvent[] } {
  nonEmpty(c.application_id, "application_id"); nonEmpty(c.adapter, "adapter");
  if (!TSP_PRODUCTS.includes(c.product)) throw new RangeError(`product ${String(c.product)} is not a TSP product`);
  const requested = events.append({ type: "integration.production_call.requested", applicationId: c.application_id, actor: SENTINEL, occurredAt: c.at, payload: { ...ORIG, product: c.product, adapter: c.adapter, scope: c.scope, environment: c.environment, application_id: c.application_id } });
  if (c.environment !== "production") return { allowed: true, gate: { open: true, missing: [] }, events: [requested] };
  const gate = tspProductionGate(c.product, f.approvals, f.form101, civilDate(c.at));
  if (gate.open) return { allowed: true, gate, events: [requested, events.append({ type: "licensing.gate.opened", applicationId: c.application_id, actor: SENTINEL, occurredAt: c.at, payload: { ...ORIG, gate: "FNMA_TSP_PRODUCTION_CERT_GATE", product: c.product, adapter: c.adapter, application_id: c.application_id } })] };
  const escalation = escalations.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", applicationId: c.application_id, severity: "sev2", payload: { gate: "FNMA_TSP_PRODUCTION_CERT_GATE", product: c.product, adapter: c.adapter, prepared_file_document_id: c.prepared_file_document_id, ui_fallback: c.ui_fallback ?? `${c.product} UI under the partner's Technology Manager org`, missing: gate.missing } }, SENTINEL);
  events.append({ type: "licensing.gate.blocked", applicationId: c.application_id, actor: SENTINEL, occurredAt: c.at, payload: { ...ORIG, gate: "FNMA_TSP_PRODUCTION_CERT_GATE", state: null, reason: "tsp_gate_closed", command: `${c.adapter}.production_call`, product: c.product, application_id: c.application_id, missing: gate.missing, escalation_id: escalation.id } });
  throw new LicensingRefused("tsp_gate_closed", "31.1 rule 7 (FNMA_TSP_PRODUCTION_CERT_GATE); 00b-orig Part (b) UI fallback", `${c.adapter} production call for ${c.product} refused: ${gate.missing.join("; ")}`, escalation.id);
}

// ============================================================ warehouse legal form (§G; T9)
export const WAREHOUSE_LEGAL_FORMS = ["secured_loan_to_partner", "purchase_at_settlement"] as const;
export type WarehouseLegalForm = (typeof WAREHOUSE_LEGAL_FORMS)[number];
export const WAREHOUSE_LEGAL_FORM_KEY = "origination.warehouse_legal_form";
export const TABLE_FUNDING_CONSEQUENCES = ["SM becomes the RESPA lender (12 CFR 1024.2(b))", "the partner becomes a mortgage broker closing in its own name", "not a §1024.5(b)(7) secondary-market transfer", "§8 / AfBA analysis changes", "the Fannie Mae seller would deliver a loan it no longer owns at settlement (repurchase from SM needed)"] as const;
/** Form B (`purchase_at_settlement`) is prohibited by configuration without an `officer` + `attorney` decision record; the agent may never switch the form; a change is announced to 26.3/27.1 as `config.changed` with the table-funding consequences flagged. */
export function setWarehouseLegalForm(events: EventStore, i: { from: WarehouseLegalForm; to: WarehouseLegalForm; by: Actor; decision: { decision_id: string; roles: readonly string[] } | null; at: string }): { value: WarehouseLegalForm; event: DomainEvent } {
  if (!WAREHOUSE_LEGAL_FORMS.includes(i.to)) throw new RangeError(`${String(i.to)} is not a warehouse legal form`);
  if (i.by.kind !== "human") throw new LicensingRefused("WAREHOUSE_LEGAL_FORM_HUMAN_ONLY", "31.1 guardrails: may never switch origination.warehouse_legal_form", `${i.by.kind}:${i.by.id} cannot change ${WAREHOUSE_LEGAL_FORM_KEY}`);
  const roles = i.decision?.roles ?? [];
  if (i.to === "purchase_at_settlement" && !(i.decision?.decision_id && roles.includes("officer") && roles.includes("attorney"))) throw new LicensingRefused("table_funding_form_not_approved", "31.1 §G / 26.3 rule 9: Form B refused without an officer + attorney decision record (12 CFR 1024.2(b) table funding)", `${WAREHOUSE_LEGAL_FORM_KEY} = purchase_at_settlement rejected`);
  const event = events.append({ type: "config.changed", aggregate: { kind: "config", id: WAREHOUSE_LEGAL_FORM_KEY }, actor: i.by, occurredAt: i.at, payload: { ...ORIG, key: WAREHOUSE_LEGAL_FORM_KEY, from: i.from, to: i.to, decision_id: i.decision?.decision_id ?? null, decision_roles: [...roles], consumers: ["26.3", "27.1"], table_funding: i.to === "purchase_at_settlement", consequences: i.to === "purchase_at_settlement" ? [...TABLE_FUNDING_CONSEQUENCES] : [] } });
  return { value: i.to, event };
}

// ============================================================ origination eligibility inputs (rule 5; A4-1-01 / FHFA)
/** `amount_cents × bps / 10_000`, rounded half-up at each component. */
export function bpsOf(amountCents: bigint, bps: bigint): bigint { if (amountCents < 0n || bps < 0n) throw new RangeError("bpsOf takes non-negative inputs"); return (amountCents * bps + 5_000n) / 10_000n; }
/** `amount_cents × tenth_bps / 100_000` (3.5 bps = 35 tenth-bps), half-up. */
export function tenthBpsOf(amountCents: bigint, tenthBps: bigint): bigint { if (amountCents < 0n || tenthBps < 0n) throw new RangeError("tenthBpsOf takes non-negative inputs"); return (amountCents * tenthBps + 50_000n) / 100_000n; }
/** A decimal rate string ("0.30", "0.3000") as an exact scaled integer at `scale` places (numeric(5,4) → scale 4). */
export function scaledRate(s: string, scale = 4): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim()); if (!m) throw new RangeError(`rate ${JSON.stringify(s)} is not a decimal`);
  const frac = (m[2] ?? "").padEnd(scale, "0"); if (frac.length > scale) throw new RangeError(`rate ${s} has more than ${scale} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(scale) + BigInt(frac);
}
export const ORIGINATION_LIQUIDITY_THRESHOLD_CENTS = 1_000_000_000_00n;
export const ORIGINATION_LIQUIDITY_BPS = 50n;
export interface OrigInputs { readonly period: string; readonly quarter_end: PlainDate; readonly as_of?: PlainDate; readonly hfs_upb_cents: bigint; readonly irlc_pipeline_cents: bigint; readonly fallout_rate: string; readonly trailing_12m_originations_cents: bigint; readonly computed_at: string; }
export interface EligibilityInputsOrigination { readonly period: string; readonly as_of: PlainDate; readonly hfs_upb_cents: bigint; readonly irlc_pipeline_cents: bigint; readonly fallout_rate: string; readonly irlc_adjusted_cents: bigint; readonly origination_liquidity_base_cents: bigint; readonly trailing_12m_originations_cents: bigint; readonly origination_liquidity_applies: boolean; readonly origination_liquidity_required_cents: bigint; readonly computed_at: string; readonly due_to_18_3: PlainDate; readonly delivered_to_18_3_at: string | null; }
/** `irlc_adjusted = round-half-up(irlc × (1 − fallout))`; `base = hfs + irlc_adjusted`; applies when the trailing four quarters exceed $1 billion (A4-1-01 "greater than $1 billion … in the most recent four-quarter period"); `required = applies ? base × 50 bps : 0`; due to 18.3 five Fannie Mae ET business days after quarter-end. */
export function computeOrigInputs(events: EventStore, i: OrigInputs): { row: EligibilityInputsOrigination; event: DomainEvent } {
  nonEmpty(i.period, "period");
  for (const [k, v] of [["hfs_upb_cents", i.hfs_upb_cents], ["irlc_pipeline_cents", i.irlc_pipeline_cents], ["trailing_12m_originations_cents", i.trailing_12m_originations_cents]] as const) if (typeof v !== "bigint" || v < 0n) throw new RangeError(`${k} must be non-negative bigint cents`);
  const fallout = scaledRate(i.fallout_rate, 4); if (fallout > 10_000n) throw new RangeError(`fallout_rate ${i.fallout_rate} exceeds 1`);
  const irlc_adjusted_cents = (i.irlc_pipeline_cents * (10_000n - fallout) + 5_000n) / 10_000n;
  const base = i.hfs_upb_cents + irlc_adjusted_cents;
  const applies = i.trailing_12m_originations_cents > ORIGINATION_LIQUIDITY_THRESHOLD_CENTS;
  const required = applies ? bpsOf(base, ORIGINATION_LIQUIDITY_BPS) : 0n;
  const due_to_18_3 = addBusinessDays(i.quarter_end, 5, fannieEt);
  const row: EligibilityInputsOrigination = { period: i.period, as_of: i.as_of ?? i.quarter_end, hfs_upb_cents: i.hfs_upb_cents, irlc_pipeline_cents: i.irlc_pipeline_cents, fallout_rate: i.fallout_rate, irlc_adjusted_cents, origination_liquidity_base_cents: base, trailing_12m_originations_cents: i.trailing_12m_originations_cents, origination_liquidity_applies: applies, origination_liquidity_required_cents: required, computed_at: i.computed_at, due_to_18_3, delivered_to_18_3_at: null };
  const event = events.append({ type: "eligibility.orig_inputs.computed", aggregate: { kind: "quarter", id: i.period }, actor: SENTINEL, occurredAt: i.computed_at, payload: { ...ORIG, period: i.period, quarter_end: i.quarter_end, hfs_upb_cents: i.hfs_upb_cents, irlc_pipeline_cents: i.irlc_pipeline_cents, fallout_rate: i.fallout_rate, irlc_adjusted_cents, origination_liquidity_base_cents: base, trailing_12m_originations_cents: i.trailing_12m_originations_cents, origination_liquidity_applies: applies, origination_liquidity_required_cents: required, due_to_18_3, consumer: "18.3 FHFA_ELIG_QUARTERLY_TEST" } });
  return { row, event };
}
/** `quarter.closed{period, quarter_end}` — arms FNMA_A4_1_01_ORIG_LIQUIDITY_INPUTS_QBD5 (+5 Fannie Mae ET business days) and FNMA_A3_3_01_TPO_QUARTERLY_PERFORMANCE_90 (+30 days, policy). */
export function closeQuarter(events: EventStore, i: { period: string; quarter_end: PlainDate; at: string }): DomainEvent {
  if (!/^\d{4}Q[1-4]$/.test(i.period)) throw new RangeError(`period ${i.period} is not YYYYQn`);
  return events.append({ type: "quarter.closed", aggregate: { kind: "quarter", id: i.period }, actor: { kind: "system", id: "scheduler" }, occurredAt: i.at, payload: { ...ORIG, period: i.period, quarter_end: i.quarter_end } });
}
export function deliverOrigInputs(events: EventStore, row: EligibilityInputsOrigination, at: string): { row: EligibilityInputsOrigination; event: DomainEvent; on_time: boolean } {
  const on = civilDate(at);
  const event = events.append({ type: "eligibility.orig_inputs.delivered", aggregate: { kind: "quarter", id: row.period }, actor: SENTINEL, occurredAt: at, payload: { ...ORIG, period: row.period, to: "18.3", origination_liquidity_required_cents: row.origination_liquidity_required_cents, delivered_on: on, due: row.due_to_18_3, on_time: on <= row.due_to_18_3 } });
  return { row: { ...row, delivered_to_18_3_at: at }, event, on_time: on <= row.due_to_18_3 };
}
export function annualReconciliationTick(events: EventStore, i: { year: number; at: string }): DomainEvent {
  return events.append({ type: "schedule.tick", aggregate: { kind: "eligibility_year", id: String(i.year) }, actor: { kind: "system", id: "scheduler" }, occurredAt: i.at, payload: { ...ORIG, cadence: "annual", job: "origination_1b_reconciliation", date: ymd(i.year, 1, 1), year: i.year } });
}
/** Jan 31 reconciliation only (verification report item 2): the operative >$1B test is quarterly; the year's flag is re-attested from the trailing four quarters. */
export function reattestOrigination1B(events: EventStore, i: { year: number; trailing_12m_originations_cents: bigint; by: Actor; at: string }): { applies: boolean; event: DomainEvent } {
  const applies = i.trailing_12m_originations_cents > ORIGINATION_LIQUIDITY_THRESHOLD_CENTS;
  return { applies, event: events.append({ type: "eligibility.origination_1b.reattested", aggregate: { kind: "eligibility_year", id: String(i.year) }, actor: i.by, occurredAt: i.at, payload: { ...ORIG, year: i.year, trailing_12m_originations_cents: i.trailing_12m_originations_cents, applies, basis: "A4-1-01 most recent four-quarter period" } }) };
}
/** 18.3's whole test as the spec illustrates it (rule 5): net worth $2.5M + 25/35/25 bps; base liquidity 3.5 bps A/A (open question 7); total = base + origination component; capital ratio ≥ 6 %. Illustration only — 18.3 owns FHFA_ELIG_QUARTERLY_TEST. */
export function fhfaEligibilityIllustration(i: { fnma_freddie_upb_cents: bigint; gnma_upb_cents: bigint; other_upb_cents: bigint; origination_liquidity_required_cents: bigint; tangible_net_worth_cents: bigint; total_assets_cents: bigint }): { net_worth_required_cents: bigint; base_liquidity_required_cents: bigint; total_liquidity_required_cents: bigint; capital_ratio_pct: string; capital_ok: boolean } {
  const net_worth_required_cents = 2_500_000_00n + bpsOf(i.fnma_freddie_upb_cents, 25n) + bpsOf(i.gnma_upb_cents, 35n) + bpsOf(i.other_upb_cents, 25n);
  const base_liquidity_required_cents = tenthBpsOf(i.fnma_freddie_upb_cents, 35n) + bpsOf(i.gnma_upb_cents, 10n) + tenthBpsOf(i.other_upb_cents, 35n);
  const ratioBps = i.total_assets_cents > 0n ? (i.tangible_net_worth_cents * 10_000n + i.total_assets_cents / 2n) / i.total_assets_cents : 0n;
  const capital_ratio_pct = `${ratioBps / 100n}.${(ratioBps % 100n).toString().padStart(2, "0")}`;
  return { net_worth_required_cents, base_liquidity_required_cents, total_liquidity_required_cents: base_liquidity_required_cents + i.origination_liquidity_required_cents, capital_ratio_pct, capital_ok: ratioBps >= 600n };
}

// ============================================================ TPO program over SM (A3-3-01; rule 9)
export interface TpoCadence { readonly fiscal_year_end: PlainDate; readonly afs_due: PlainDate; readonly annual_review_due: PlainDate; readonly quarterly_package_due: PlainDate; readonly quarter_end: PlainDate; }
/** SM's AFS by FYE + 90 days (18.4's FNMA_A4102_AFS_FYE_90); the partner's annual review 30 days after (policy); the quarterly performance package quarter-end + 30 days (policy). */
export function tpoCadence(fiscal_year_end: PlainDate, quarter_end: PlainDate): TpoCadence {
  const afs_due = addDays(fiscal_year_end, 90);
  return { fiscal_year_end, afs_due, annual_review_due: addDays(afs_due, 30), quarterly_package_due: addDays(quarter_end, 30), quarter_end };
}
export function receiveTpoFinancials(events: EventStore, i: { fiscal_year_end: PlainDate; received_on: PlainDate; document_id: string; at: string }): DomainEvent {
  nonEmpty(i.document_id, "document_id");
  return events.append({ type: "tpo.financials.received", aggregate: { kind: "tpo_program", id: "sm" }, actor: SENTINEL, occurredAt: i.at, payload: { ...ORIG, subject: "sm", fiscal_year_end: i.fiscal_year_end, received_on: i.received_on, document_id: i.document_id, review_due: tpoCadence(i.fiscal_year_end, i.fiscal_year_end).annual_review_due } });
}
export function openTpoApprovalFile(events: EventStore, i: { opened_on: PlainDate; document_id: string; at: string }): DomainEvent {
  nonEmpty(i.document_id, "document_id");
  return events.append({ type: "tpo.approval_file.opened", aggregate: { kind: "tpo_program", id: "sm" }, actor: SENTINEL, occurredAt: i.at, payload: { ...ORIG, subject: "sm", opened_on: i.opened_on, document_id: i.document_id, program: "A3-3-01" } });
}
/** `tpo.review.completed{kind}` closes the matching A3-3-01 row; the annual financial-statement review needs the partner `officer`'s approval; quarterly reviews are keyed to the quarter, the rest to the SM program. */
export function completeTpoReview(events: EventStore, r: Omit<TpoProgramReview, "subject" | "completed_at" | "approved_by"> & { readonly period: string | null; readonly completed_on: PlainDate; readonly approved_by: Actor | null; readonly at: string }): { review: TpoProgramReview; event: DomainEvent } {
  nonEmpty(r.review_id, "review_id");
  if (r.kind === "annual_financial_statements" && !(r.approved_by && r.approved_by.kind === "human" && r.approved_by.role === "officer")) throw new LicensingRefused("TPO_ANNUAL_REVIEW_NEEDS_PARTNER_OFFICER", "A3-3-01 annual review of the third-party originator's financial statements — approved by the partner officer", `review ${r.review_id} lacks an officer approval`);
  if (r.kind === "quarterly_performance" && !r.period) throw new RangeError("a quarterly_performance review names its period (YYYYQn)");
  const review: TpoProgramReview = { review_id: r.review_id, subject: "sm", kind: r.kind, period_start: r.period_start, period_end: r.period_end, inputs: r.inputs, findings: r.findings, rating: r.rating, completed_at: r.completed_on, approved_by: r.approved_by?.id ?? null, document_id: r.document_id };
  const aggregate = r.kind === "quarterly_performance" ? { kind: "quarter", id: r.period! } : { kind: "tpo_program", id: "sm" };
  const event = events.append({ type: "tpo.review.completed", aggregate, actor: r.approved_by ?? SENTINEL, occurredAt: r.at, payload: { ...ORIG, review_id: r.review_id, subject: "sm", kind: r.kind, period: r.period, period_start: r.period_start, period_end: r.period_end, rating: r.rating, completed_on: r.completed_on, approved_by: review.approved_by, document_id: r.document_id } });
  return { review, event };
}

// ============================================================ packages and reports
export interface StateReadinessReport { readonly report: "RPT_STATE_READINESS"; readonly as_of: PlainDate; readonly states: readonly Readiness[]; readonly open: readonly string[]; readonly closed: readonly { state: string; reason: ReadinessReason | null }[]; }
export function stateReadinessReport(facts: readonly ReadinessFacts[]): StateReadinessReport {
  const states = facts.map(stateReadiness);
  return { report: "RPT_STATE_READINESS", as_of: facts[0]?.as_of ?? D("1970-01-01"), states, open: states.filter((s) => s.open).map((s) => s.state), closed: states.filter((s) => !s.open).map((s) => ({ state: s.state, reason: s.reason })) };
}
/** Seller-side Form 582 answers 31.1 hands 18.4 thirty days before the partner's Form 582 due date: states licensed, MLO count, technology/outsourcing providers, eMortgage status, origination volume. */
export function form582SellerSideAnswers(i: { licenses: readonly License[]; approvals: readonly FnmaApproval[]; roster: readonly MloRosterMember[]; origination_volume_cents: bigint; as_of: PlainDate; form582_due: PlainDate }): Record<string, unknown> {
  const states = [...new Set(i.licenses.filter((l) => l.holder_kind === "partner_company" && inGoodStanding(l, i.as_of)).map((l) => l.jurisdiction))].sort();
  const em = i.approvals.find((a) => a.entity === "partner" && a.kind === "emortgage_special_approval");
  return { package: "FORM582_SELLER_SIDE", as_of: i.as_of, deliver_by: addDays(i.form582_due, -30), states_licensed: states, mlo_count: i.roster.filter((m) => m.employer === "partner" && m.status === "active").length, technology_providers: ["Supermortgage (TSP; fulfillment; subservicer)"], third_party_originators: [], sfc_211_212: "none (31.1 §C position)", emortgage_status: em?.status ?? "planned", origination_volume_cents: i.origination_volume_cents };
}
export function tpoQuarterlyPackage(i: { period: string; prefunding_defect_rate_bps: number; post_closing_defect_rate_bps: number; epd_count: number; lqc_findings: number; sla_breaches: number; complaints: number; license_status_summary: Record<string, string> }): Record<string, unknown> {
  return { package: "TPO_QUARTERLY_PERFORMANCE", period: i.period, inputs: { prefunding_defect_rate_bps: i.prefunding_defect_rate_bps, post_closing_defect_rate_bps: i.post_closing_defect_rate_bps, epd_count: i.epd_count, lqc_findings: i.lqc_findings, sla_breaches: i.sla_breaches, complaints: i.complaints }, license_status_summary: i.license_status_summary, sources: ["28.1", "28.2", "29.4", "19.3", "13.x"] };
}
/** T13 second half: a state closes immediately when the partner's licence is suspended — every in-flight file there escalates to `officer` and the readiness change is recorded. */
export function closeStateForInFlight(events: EventStore, escalations: EscalationService, i: { state: string; reason: string; applications: readonly { application_id: string }[]; at: string }, f: ReadinessFacts): { readiness: Readiness; escalations: Escalation[]; event: DomainEvent } {
  const readiness = stateReadiness(f);
  if (readiness.open) throw new RangeError(`${i.state} readiness is still open — nothing to close`);
  const opened = i.applications.map((a) => escalations.open({ kind: "officer", severity: "sev1", applicationId: a.application_id, payload: { state: i.state, reason: i.reason, readiness_reason: readiness.reason, task: "in-flight file in a state whose partner licence is suspended/revoked: complete under a documented transition plan or withdraw" } }, SENTINEL));
  const event = events.append({ type: "licensing.readiness.changed", aggregate: { kind: "state_readiness", id: i.state }, actor: SENTINEL, occurredAt: i.at, payload: { ...ORIG, state: i.state, open: false, reason: i.reason, readiness_reason: readiness.reason, predicates: readiness.predicates, in_flight: i.applications.map((a) => a.application_id), escalation_ids: opened.map((e) => e.id) } });
  return { readiness, escalations: opened, event };
}
