/**
 * §18.5 Mortgage fraud reporting — process rules layered over the calculators in
 * ./fraud.ts (scores, clocks) and ./ops.ts (reportDraftGate, breachSelfReportTrigger,
 * fraudFlagFairness): the rule-1 payoff-wire detector and case open with protective
 * actions and the human call-back task (T1), the filing outcome and LQC-reference
 * requirement behind FNMA_A3403_FRAUD_REPORT_30 (T2), the due-diligence breach routed
 * to the fraud officer from the engine's own breach (T3), the OFAC clock-hours notice
 * (T4), the law-firm co-filing on Fannie Mae's calendar (T5), the agent's determination
 * proposal, the role checks behind every human act and the rule-5 self-report content
 * standard (T6), both A3-2-01 60-day self-report legs and the event that arms the timer
 * (T7), the time-boxed protective hold as the `loans.fraud_hold` row/events and the
 * payoff gate 16.x consults (T8), dual control and the covered-loss carrier clock (T9),
 * the quarterly red-flag fairness review routed via counsel (T10), the law-enforcement
 * referral decision trigger, the two partner-notice legs, the Section 19 incident notice
 * 18.5 co-files, and the event shapes the timer rows are satisfied by.
 * Pure functions; bigint cents; PlainDate strings.
 */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, servicer, fannieEt } from "../../kernel/calendar/business.ts";
import { wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import type { EventInput } from "../../kernel/events/types.ts";
import { reportDraftGate, breachSelfReportTrigger, fraudFlagFairness, type QcEscalation } from "./ops.ts";
import { FLAG_SCORES, caseScore, priority, protectiveActions, protectiveHoldExpires, assignmentAllowed, ofacEmailDueMs, lawFirmFraudNoticeDue } from "./fraud.ts";
import { incidentNoticeSent } from "../data-security/ops-19-2.ts";

export type Determination = "reasonable_basis" | "unfounded" | "inconclusive";
export type SubjectKind = "borrower" | "third_party" | "employee" | "vendor" | "law_firm" | "unknown";
/** `fraud_reports.channel`. */
export type ReportChannel = "lqc_self_report" | "ethics_email_ofac" | "fraud_tip_form" | "fraud_hotline" | "fnma_legal_email" | "law_enforcement" | "state_regulator" | "carrier";
type Emitted<P extends Record<string, unknown>> = EventInput<P> & { readonly payload: P };
const QC_AUDIT_AGENT = { kind: "agent", id: "qc-audit" } as const;
const ET = "America/New_York";
const caseAggregate = (case_id: string) => ({ kind: "fraud_case", id: case_id });
const loanRef = (loan_id: string | null | undefined) => (loan_id ? { loanId: loan_id } : {});

// ============================================================ human acts (guardrail)
/**
 * Guardrail: "determinations, external reports and referrals are human acts (`officer:fraud_officer`, `officer`,
 * `attorney`)" — role-checked, never presence-checked: an id string alone is not an act. Rule 7 routes a determination
 * the fraud officer cannot take (they are a subject) to the deputy/board designee (T9), so those two roles may
 * determine as well; the agent (`qc-audit`), analysts and portal operators never do.
 */
export const DETERMINATION_ROLES: readonly string[] = ["officer:fraud_officer", "officer:deputy_fraud_officer", "board_designee"];
/** Escalations: "`officer` (sign Fannie Mae/OFAC/carrier reports — report package)". */
export const REPORT_SIGNING_ROLE = "officer";
/** Escalations: "`attorney` (law enforcement/regulator/privilege — memo with exposure and evidence)". */
export const REFERRAL_ROLE = "attorney";
export function determinationActor(role: string): { allowed: boolean; refusal: string | null; actor_role: "fraud_officer" | "officer" | null } {
  if (!DETERMINATION_ROLES.includes(role)) return { allowed: false, refusal: `determination by ${role || "(no role)"} refused: a determination is the officer:fraud_officer's act (deputy/board designee under rule 7), never the agent's or an analyst's — determinations are human acts (§18.5 guardrail; A3-4-03 "reasonable basis")`, actor_role: null };
  return { allowed: true, refusal: null, actor_role: role === "board_designee" ? "officer" : "fraud_officer" };
}
export function reportSigner(role: string): { allowed: boolean; refusal: string | null } {
  return role === REPORT_SIGNING_ROLE ? { allowed: true, refusal: null } : { allowed: false, refusal: `report signature by ${role || "(no role)"} refused: external reports are signed by the officer — human acts (§18.5 guardrail; escalations "officer (sign Fannie Mae/OFAC/carrier reports)")` };
}

/** Spec "Decision record": `{case_id, flags[], score, hypotheses[], evidence_refs[], recommended_determination, confidence, model_version, prompt_version}`. */
export interface FraudDecisionRecord {
  readonly case_id: string; readonly flags: readonly string[]; readonly score: number; readonly hypotheses: readonly string[]; readonly evidence_refs: readonly string[];
  readonly recommended_determination: Determination; readonly confidence: number; readonly model_version: string; readonly prompt_version: string;
}
/** `fraud_cases.determination` / `determined_by_officer_id` / `determination_at` — the fraud officer's recorded act, with the role that recorded it. */
export interface OfficerDetermination { readonly determination: Determination; readonly determined_by_officer_id: string; readonly determined_by_role: string; readonly determined_at: PlainDate; }

export interface DeterminationProposal {
  /** `fraud_cases.status` after the proposal: the agent's memo never moves the case past `investigating`; an officer's `inconclusive` keeps it there too. */
  readonly case_status: "investigating" | "determined" | "unfounded_closed";
  /** The recorded determination — the officer's or none; never the agent's recommendation. */
  readonly determination: Determination | null; readonly determined_by: string | null;
  readonly report_draft_allowed: boolean; readonly refusal: string | null; readonly next_step: "officer:fraud_officer determination" | "draft_for_officer_signature" | "close_unfounded" | "further_diligence";
  readonly escalation: QcEscalation | null; readonly package: "FRAUD-FILE-v1" | "FRAUD-FNMA-SR-v1" | null;
  /** FNMA_A3403_FRAUD_REPORT_30 clocks, armed only by the officer's `reasonable_basis` determination (rule 4). */
  readonly fnma_report_due: PlainDate | null; readonly internal_target: PlainDate | null;
  /** SM_FRAUD_PARTNER_NOTIFY_1BD second leg ("again at determination"). */
  readonly partner_notice_due: PlainDate | null;
  readonly memo: { readonly case_id: string; readonly recommended_determination: Determination; readonly confidence: number; readonly model_version: string; readonly prompt_version: string; readonly evidence_refs: readonly string[] };
}

/**
 * Rule 3 / guardrails: "a determination is by the `officer:fraud_officer`, never the agent" — the agent's
 * recommendation, whatever its confidence, is a determination memo escalated with the investigation file
 * (`FRAUD-FILE-v1`); only a determination recorded by a determination role unlocks `draft_for_officer_signature`
 * (a "determination" recorded under any other role — the agent's own id, an analyst — is no determination).
 * State machine: `reasonable_basis` → `determined` (report drafted); `unfounded` → `unfounded_closed` (with
 * rationale); `inconclusive` is neither reportable nor an unfounded close — the case stays `investigating`
 * for further diligence and a later determination.
 */
export function agentDeterminationProposal(i: { record: FraudDecisionRecord; officer_determination: OfficerDetermination | null; cal?: Calendar }): DeterminationProposal {
  const cal = i.cal ?? servicer;
  const r = i.record;
  const memo = { case_id: r.case_id, recommended_determination: r.recommended_determination, confidence: r.confidence, model_version: r.model_version, prompt_version: r.prompt_version, evidence_refs: r.evidence_refs };
  const role = i.officer_determination ? determinationActor(i.officer_determination.determined_by_role) : null;
  const od = role?.allowed ? i.officer_determination : null;
  const gate = reportDraftGate({ agent_recommendation: { determination: r.recommended_determination, confidence: r.confidence }, officer_determination: od });
  if (!od) {
    return {
      case_status: "investigating", determination: null, determined_by: null,
      report_draft_allowed: false, refusal: role && !role.allowed ? `${role.refusal}; ${gate.refusal}` : gate.refusal, next_step: gate.next_step,
      escalation: { kind: "fraud_officer", reason: `determination memo for case ${r.case_id}: agent recommends ${r.recommended_determination} at confidence ${r.confidence} (${r.model_version}/${r.prompt_version}) — the determination is the fraud officer's act (A3-4-03 "reasonable basis")` },
      package: "FRAUD-FILE-v1", fnma_report_due: null, internal_target: null, partner_notice_due: null, memo,
    };
  }
  const rb = od.determination === "reasonable_basis";
  if (od.determination === "inconclusive") {
    // ops.ts reportDraftGate routes every non-reasonable_basis determination to `close_unfounded`; the spec closes only `unfounded` (with rationale).
    return {
      case_status: "investigating", determination: "inconclusive", determined_by: od.determined_by_officer_id,
      report_draft_allowed: false, refusal: `determination inconclusive: no Fannie Mae report and no unfounded close — further diligence, then a fresh officer:fraud_officer determination`, next_step: "further_diligence",
      escalation: { kind: "fraud_officer", reason: `case ${r.case_id} determined inconclusive ${od.determined_at}: further diligence (independent verification, preserved originals, written "reasonable basis" analysis) before re-determination` },
      package: null, fnma_report_due: null, internal_target: null, partner_notice_due: addBusinessDays(od.determined_at, 1, cal), memo,
    };
  }
  return {
    case_status: rb ? "determined" : "unfounded_closed",
    determination: od.determination, determined_by: od.determined_by_officer_id,
    report_draft_allowed: gate.allowed, refusal: gate.refusal, next_step: gate.next_step,
    escalation: rb ? { kind: "officer", reason: `sign FRAUD-FNMA-SR-v1 for case ${r.case_id} (LQC self-report due ${addDays(od.determined_at, 30)}; internal target ${addDays(od.determined_at, 20)})`, due: addDays(od.determined_at, 20) } : null,
    package: rb ? "FRAUD-FNMA-SR-v1" : null,
    fnma_report_due: rb ? addDays(od.determined_at, 30) : null, internal_target: rb ? addDays(od.determined_at, 20) : null,
    partner_notice_due: addBusinessDays(od.determined_at, 1, cal), memo,
  };
}

// ============================================================ rule 5 report content (FRAUD-FNMA-SR-v1)
/** Rule 5: "loan identifiers (Fannie Mae/servicer numbers), parties, scheme description, timeline, evidence list with hashes, loss/exposure (cents), actions taken, law-enforcement status, contact person". */
export const FNMA_SELF_REPORT_ELEMENTS = ["loan_identifiers", "parties", "scheme_description", "timeline", "evidence", "exposure_cents", "actions_taken", "law_enforcement_status", "contact_person"] as const;
export type SelfReportElement = (typeof FNMA_SELF_REPORT_ELEMENTS)[number];
export type LawEnforcementStatus = "not_referred" | "referral_pending_attorney" | "referred" | "declined_with_reason" | "on_hold_at_agency_request";
export interface SelfReportContent {
  readonly loan_identifiers: readonly { fnma_loan_number: string; servicer_loan_number: string }[];
  readonly parties: readonly { role: string; name: string }[];
  readonly scheme_description: string;
  readonly timeline: readonly { on: PlainDate; what: string }[];
  /** "evidence list with hashes" — every item carries its sha256. */
  readonly evidence: readonly { document_id: string; sha256: string }[];
  readonly exposure_cents: bigint;
  readonly actions_taken: readonly string[];
  readonly law_enforcement_status: LawEnforcementStatus;
  readonly contact_person: string;
}
const SHA256 = /^(sha256:)?[0-9a-f]{64}$/i;
/**
 * The Fannie Mae self-report package (`FRAUD-FNMA-SR-v1`, LQC self-report) is drafted for the officer's signature only
 * behind the officer's `reasonable_basis` determination (T6) and only when every rule-5 element is present — an
 * evidence item without its hash, an empty timeline or a missing contact person is a package that is not ready for
 * signature. The submitter is the partner's LQC submitter / `fnma_portal_operator`; the signer is the officer.
 */
export function fnmaSelfReportPackage(i: { case_id: string; officer_determination: OfficerDetermination | null; agent_recommendation?: { determination: Determination; confidence: number } | null; content: Partial<SelfReportContent> }): { template: "FRAUD-FNMA-SR-v1"; channel: "lqc_self_report"; allowed: boolean; refusal: string | null; missing: SelfReportElement[]; ready_for_signature: boolean; content: SelfReportContent | null; signer: "officer"; submitter: "fnma_portal_operator" } {
  const base = { template: "FRAUD-FNMA-SR-v1" as const, channel: "lqc_self_report" as const, signer: "officer" as const, submitter: "fnma_portal_operator" as const };
  const role = i.officer_determination ? determinationActor(i.officer_determination.determined_by_role) : null;
  const od = role?.allowed ? i.officer_determination : null;
  const gate = reportDraftGate({ agent_recommendation: i.agent_recommendation ?? null, officer_determination: od });
  if (!gate.allowed) return { ...base, allowed: false, refusal: role && !role.allowed ? `${role.refusal}; ${gate.refusal}` : gate.refusal, missing: [...FNMA_SELF_REPORT_ELEMENTS], ready_for_signature: false, content: null };
  const c = i.content;
  const missing: SelfReportElement[] = [];
  if (!c.loan_identifiers?.length || c.loan_identifiers.some((l) => !l.fnma_loan_number || !l.servicer_loan_number)) missing.push("loan_identifiers");
  if (!c.parties?.length || c.parties.some((p) => !p.role || !p.name)) missing.push("parties");
  if (!c.scheme_description?.trim()) missing.push("scheme_description");
  if (!c.timeline?.length || c.timeline.some((t) => !t.on || !t.what)) missing.push("timeline");
  if (!c.evidence?.length || c.evidence.some((e) => !e.document_id || !SHA256.test(e.sha256 ?? ""))) missing.push("evidence");
  if (typeof c.exposure_cents !== "bigint" || c.exposure_cents < 0n) missing.push("exposure_cents");
  if (!c.actions_taken?.length) missing.push("actions_taken");
  if (!c.law_enforcement_status) missing.push("law_enforcement_status");
  if (!c.contact_person?.trim()) missing.push("contact_person");
  if (missing.length) return { ...base, allowed: true, refusal: `FRAUD-FNMA-SR-v1 for case ${i.case_id} is not ready for signature: rule-5 content missing ${missing.join(", ")}`, missing, ready_for_signature: false, content: null };
  return { ...base, allowed: true, refusal: null, missing: [], ready_for_signature: true, content: c as SelfReportContent };
}

// ============================================================ rule 1 detection + case open (T1)
export interface RedFlag { readonly flag_code: string; readonly score: number; readonly detector: string; readonly detected_on: PlainDate; readonly source_event: string; readonly loan_id: string | null; readonly detail: Record<string, unknown>; }
export const PAYOFF_WIRE_CHANGE_WINDOW_DAYS = 10;
/**
 * Rule 1: "payoff wire instructions changed within 10 days of a payoff request and not confirmed by call-back to a
 * number on file → `PAYOFF_WIRE_CHANGE` score 90". The source event is 16.x `payoff.wire_instructions.changed`.
 */
export function payoffWireChangeFlag(i: { loan_id: string; payoff_requested_on: PlainDate; wire_changed_on: PlainDate; callback_verified: boolean; detected_on?: PlainDate }): { flag: RedFlag | null; days_between: number; within_window: boolean; reason: string } {
  const days = Math.abs(daysBetween(i.wire_changed_on, i.payoff_requested_on));
  const within = days <= PAYOFF_WIRE_CHANGE_WINDOW_DAYS;
  if (!within) return { flag: null, days_between: days, within_window: false, reason: `wire change ${days} days from the payoff request is outside the ${PAYOFF_WIRE_CHANGE_WINDOW_DAYS}-day window` };
  if (i.callback_verified) return { flag: null, days_between: days, within_window: true, reason: "wire change confirmed by call-back to a number on file" };
  return {
    flag: { flag_code: "PAYOFF_WIRE_CHANGE", score: FLAG_SCORES.PAYOFF_WIRE_CHANGE!, detector: "RULE_PAYOFF_WIRE_CHANGE_10D_v1", detected_on: i.detected_on ?? i.payoff_requested_on, source_event: "payoff.wire_instructions.changed", loan_id: i.loan_id, detail: { payoff_requested_on: i.payoff_requested_on, wire_changed_on: i.wire_changed_on, days_between: days, callback_verified: false } },
    days_between: days, within_window: true, reason: `wire instructions changed ${days} days from the payoff request without a verified call-back`,
  };
}

export const PROTECTIVE_HOLD_DAYS = 30;
export type ProtectiveActionCode = "hold_payoff_disbursement" | "short_sale_human_review" | "id_verified_authentication" | "suspend_credit_reporting" | "freeze_vendor_payments";
export interface ProtectiveAction { readonly action: ProtectiveActionCode; readonly placed_on: PlainDate; readonly expires_on: PlainDate; readonly reason: string; readonly reversible: true; readonly renewable_by: "officer:fraud_officer"; }
export interface FraudCaseOpened {
  readonly case_id: string; readonly status: "flagged"; readonly score: number; readonly priority: "P1" | "P2" | "P3"; readonly flags: readonly string[]; readonly opened_on: PlainDate;
  /** Rule 2 automatic, reversible protective actions — each time-boxed (guardrail: auto-expire in 30 days unless renewed by the officer). */
  readonly protective_actions: readonly ProtectiveAction[];
  /** The `loans.fraud_hold` row (0050) written for a payoff hold, and the `loan.fraud_hold.set` event 16.x reads (payoffDisbursementGate). */
  readonly loan_fraud_hold: FraudHoldRow | null;
  readonly loan_fraud_hold_event: Emitted<FraudHoldEventPayload> | null;
  /** Identity-verification call-backs are human acts (`human_agent`); the agent drafts the script and never places the call. */
  readonly tasks: readonly { kind: "callback_verification"; assigned_to: "human_agent"; agent_may_call: false; numbers: "numbers_of_record"; script_drafted_by: "qc-audit" }[];
  readonly escalations: readonly QcEscalation[];
  readonly partner_notice: { required: boolean; timer: "SM_FRAUD_PARTNER_NOTIFY_1BD"; due: PlainDate | null };
  readonly timers: readonly { code: "SM_FRAUD_TRIAGE_2BD" | "SM_FRAUD_DUE_DILIGENCE_15" | "SM_FRAUD_PARTNER_NOTIFY_1BD"; due: PlainDate }[];
  /** `fraud.case.opened` — arms the triage, diligence and (score ≥ 60) partner-notice rows. */
  readonly event: Emitted<{ case_id: string; score: number; priority: "P1" | "P2" | "P3"; opened_at: PlainDate; flags: readonly string[]; loan_id: string | null; partner_notice_leg?: "open" }>;
}
/**
 * Rule 1 aggregation (`caseScore`, `priority`) + rule 2 protective actions + the T1 shape: a P1 case opens, the payoff
 * disbursement is held (30-day time box, written as `loans.fraud_hold`), the partner is notified within 1 BD, and a
 * call-back task goes to a human agent.
 */
/**
 * Rule 1 aggregation over the red-flag rows themselves — "max(flag scores) + 10 × (count of distinct flags − 1), capped at
 * 100" — so a catalog flag the shared calculator's FLAG_SCORES table does not list (OFAC_MATCH, IDENTITY_THEFT, …) scores
 * by the row's own `score` instead of 0; for the four rule-1 examples it equals fraud.ts caseScore(codes).
 */
export function aggregateCaseScore(flags: readonly RedFlag[]): number {
  if (flags.length === 0) return 0;
  const best = new Map<string, number>();
  for (const f of flags) best.set(f.flag_code, Math.max(best.get(f.flag_code) ?? 0, f.score));
  return Math.min(100, Math.max(...best.values()) + 10 * (best.size - 1));
}
export function openFraudCase(i: { case_id: string; loan_id: string | null; flags: readonly RedFlag[]; opened_on: PlainDate; cal?: Calendar }): FraudCaseOpened {
  const cal = i.cal ?? servicer;
  const codes = i.flags.map((f) => f.flag_code);
  const score = Math.max(caseScore(codes), aggregateCaseScore(i.flags)); const pri = priority(score);
  const actions = protectiveActions(codes);
  const expires_on = addDays(i.opened_on, PROTECTIVE_HOLD_DAYS);
  const protective: ProtectiveAction[] = [];
  if (actions.includes("hold_payoff_disbursement")) protective.push({ action: "hold_payoff_disbursement", placed_on: i.opened_on, expires_on, reason: "PAYOFF_WIRE_CHANGE: payoff disbursement held pending verified call-back (16.x)", reversible: true, renewable_by: "officer:fraud_officer" });
  if (actions.includes("short_sale_human_review")) protective.push({ action: "short_sale_human_review", placed_on: i.opened_on, expires_on, reason: "NONARMS_SHORT_SALE: short-sale approval routed to human review", reversible: true, renewable_by: "officer:fraud_officer" });
  const payoffHold = protective.find((p) => p.action === "hold_payoff_disbursement") ?? null;
  const hold = payoffHold && i.loan_id ? protectiveHold({ loan_id: i.loan_id, case_id: i.case_id, action: "hold_payoff_disbursement", placed_on: i.opened_on, reason: payoffHold.reason, renewals: [], today: i.opened_on }) : null;
  const tasks: FraudCaseOpened["tasks"] = actions.includes("callback_task_human") ? [{ kind: "callback_verification", assigned_to: "human_agent", agent_may_call: false, numbers: "numbers_of_record", script_drafted_by: "qc-audit" }] : [];
  const escalations: QcEscalation[] = [];
  if (tasks.length) escalations.push({ kind: "human_agent", reason: `call-back verification for case ${i.case_id}: confirm the wire-instruction change with the borrower/closing agent at a number of record (the agent never contacts suspected perpetrators)`, due: addBusinessDays(i.opened_on, 1, cal) });
  if (pri === "P1") escalations.push({ kind: "fraud_officer", severity: "sev2", reason: `P1 case ${i.case_id} (score ${score}): same-day investigation and immediate protective actions`, due: i.opened_on });
  const partnerDue = score >= 60 ? addBusinessDays(i.opened_on, 1, cal) : null;
  const timers: FraudCaseOpened["timers"] = [{ code: "SM_FRAUD_TRIAGE_2BD", due: addBusinessDays(i.opened_on, 2, cal) }, { code: "SM_FRAUD_DUE_DILIGENCE_15", due: addDays(i.opened_on, 15) }, ...(partnerDue ? [{ code: "SM_FRAUD_PARTNER_NOTIFY_1BD" as const, due: partnerDue }] : [])];
  return {
    case_id: i.case_id, status: "flagged", score, priority: pri, flags: codes, opened_on: i.opened_on, protective_actions: protective,
    loan_fraud_hold: hold?.loan_row ?? null, loan_fraud_hold_event: hold?.event ?? null, tasks, escalations,
    partner_notice: { required: partnerDue !== null, timer: "SM_FRAUD_PARTNER_NOTIFY_1BD", due: partnerDue }, timers,
    event: { type: "fraud.case.opened", actor: QC_AUDIT_AGENT, ...loanRef(i.loan_id), aggregate: caseAggregate(i.case_id), payload: { case_id: i.case_id, score, priority: pri, opened_at: i.opened_on, flags: codes, loan_id: i.loan_id, ...(partnerDue ? { partner_notice_leg: "open" as const } : {}) } },
  };
}

/** Guardrail: "the agent never contacts suspected perpetrators"; identity-verification call-backs are executed by humans (`borrower-comms` / `human_agent`). */
export function contactGuard(i: { actor_kind: "agent" | "human"; target: "suspected_perpetrator" | "borrower_victim" | "number_of_record" | "partner" | "fnma" }): { allowed: boolean; refusal: string | null; route: "human_agent" | null } {
  if (i.actor_kind === "human") return { allowed: true, refusal: null, route: null };
  if (i.target === "suspected_perpetrator") return { allowed: false, refusal: "refused: the agent never contacts suspected perpetrators (§18.5 guardrail)", route: "human_agent" };
  if (i.target === "borrower_victim" || i.target === "number_of_record") return { allowed: false, refusal: `refused: ${i.target === "borrower_victim" ? "victim assistance" : "call-back verification"} is a human act — the agent drafts the script, a human agent places the call`, route: "human_agent" };
  return { allowed: true, refusal: null, route: null };
}

/** SM_FRAUD_TRIAGE_2BD is satisfied by `fraud.case.status_changed{status=triaged}` — the `flagged → triaged (score/priority)` transition. */
export function caseStatusChangedEvent(i: { case_id: string; loan_id: string | null; status: "triaged" | "investigating" | "determined" | "reported" | "remediating" | "closed" | "unfounded_closed" | "merged" | "on_hold_law_enforcement"; score?: number; priority?: "P1" | "P2" | "P3"; rationale?: string | null }): Emitted<{ case_id: string; status: string; score: number | null; priority: string | null; rationale: string | null }> {
  return { type: "fraud.case.status_changed", actor: QC_AUDIT_AGENT, ...loanRef(i.loan_id), aggregate: caseAggregate(i.case_id), payload: { case_id: i.case_id, status: i.status, score: i.score ?? null, priority: i.priority ?? null, rationale: i.rationale ?? null } };
}

/** SM_FRAUD_PARTNER_NOTIFY_1BD is satisfied by `partner.notified{kind=fraud_case, evidence_document_id present}` — an evidenced notice only. */
export function fraudPartnerNotifiedEvent(i: { case_id: string; loan_id: string | null; leg: "open" | "determination"; evidence_document_id: string | null; notified_on: PlainDate | null }): Emitted<{ kind: "fraud_case"; case_id: string; leg: "open" | "determination"; evidence_document_id: string; notified_on: PlainDate }> | null {
  if (!i.evidence_document_id || i.notified_on === null) return null;
  return { type: "partner.notified", actor: QC_AUDIT_AGENT, ...loanRef(i.loan_id), aggregate: caseAggregate(i.case_id), payload: { kind: "fraud_case", case_id: i.case_id, leg: i.leg, evidence_document_id: i.evidence_document_id, notified_on: i.notified_on } };
}

// ============================================================ protective hold time box (T8)
export interface HoldRenewal { readonly renewed_on: PlainDate; readonly renewed_by_role: "officer:fraud_officer" | "officer" | "qc-audit" | "ops_analyst"; readonly officer_id: string | null; readonly rationale: string | null; }
/** The `loans.fraud_hold` columns (db/migrations/0050): the loan-level protective flag "with reason and expiry". */
export interface FraudHoldRow { readonly loan_id: string; readonly fraud_hold: boolean; readonly fraud_hold_reason: string | null; readonly fraud_hold_expires_on: PlainDate | null; readonly fraud_hold_case_id: string | null; }
export interface FraudHoldEventPayload extends Record<string, unknown> { readonly loan_id: string; readonly case_id: string | null; readonly action: ProtectiveActionCode; readonly fraud_hold: boolean; readonly reason: string | null; readonly expires_on: PlainDate | null; readonly released_by: "auto_expiry" | null; }
/**
 * Guardrail: "protective actions are time-boxed (auto-expire in 30 days unless renewed by the officer) to avoid harming
 * innocent borrowers" — `loans.fraud_hold` with reason and expiry; a renewal by anyone but the officer is refused and
 * does not extend the hold; on the expiry date the hold is released and the payoff proceeds. The result carries the
 * `loans` row to write and the `loan.fraud_hold.set` / `loan.fraud_hold.released` event 16.x consumes through
 * payoffDisbursementGate.
 */
export function protectiveHold(i: { loan_id: string; case_id?: string | null; action: ProtectiveActionCode; placed_on: PlainDate; reason: string; renewals: readonly HoldRenewal[]; today: PlainDate }): { time_box_days: 30; expires_on: PlainDate; active: boolean; released_by: "auto_expiry" | null; payoff_disbursement: "held" | "proceeds"; accepted_renewals: HoldRenewal[]; refused_renewals: { renewal: HoldRenewal; refusal: string }[]; loan_flag: { fraud_hold: boolean; reason: string | null; expires_on: PlainDate | null }; loan_row: FraudHoldRow; event: Emitted<FraudHoldEventPayload> } {
  const accepted: HoldRenewal[] = []; const refused: { renewal: HoldRenewal; refusal: string }[] = [];
  for (const r of i.renewals) {
    if ((r.renewed_by_role === "officer:fraud_officer" || r.renewed_by_role === "officer") && r.officer_id && r.rationale) accepted.push(r);
    else refused.push({ renewal: r, refusal: `renewal refused: a protective hold is renewed only by the officer with a rationale (${r.renewed_by_role} on ${r.renewed_on})` });
  }
  const last = accepted.length ? accepted[accepted.length - 1]!.renewed_on : null;
  const expires_on = protectiveHoldExpires(i.placed_on, last);
  const active = i.today < expires_on;
  const payoffHold = i.action === "hold_payoff_disbursement";
  const case_id = i.case_id ?? null;
  const loan_row: FraudHoldRow = { loan_id: i.loan_id, fraud_hold: active, fraud_hold_reason: active ? i.reason : null, fraud_hold_expires_on: active ? expires_on : null, fraud_hold_case_id: active ? case_id : null };
  return {
    time_box_days: PROTECTIVE_HOLD_DAYS, expires_on, active, released_by: active ? null : "auto_expiry",
    payoff_disbursement: payoffHold && active ? "held" : "proceeds",
    accepted_renewals: accepted, refused_renewals: refused,
    loan_flag: { fraud_hold: active, reason: active ? i.reason : null, expires_on: active ? expires_on : null },
    loan_row,
    event: { type: active ? "loan.fraud_hold.set" : "loan.fraud_hold.released", actor: QC_AUDIT_AGENT, loanId: i.loan_id, ...(case_id ? { aggregate: caseAggregate(case_id) } : {}), payload: { loan_id: i.loan_id, case_id, action: i.action, fraud_hold: active, reason: loan_row.fraud_hold_reason, expires_on: loan_row.fraud_hold_expires_on, released_by: active ? null : "auto_expiry" } },
  };
}
/**
 * The gate 16.x consults before releasing payoff proceeds: a live `loans.fraud_hold` (today before the expiry) holds the
 * disbursement; an expired or absent hold lets the payoff proceed (T8) — the flag is read from the loan row, never from
 * the caller's say-so, and an expiry that has passed proceeds even if the row was not yet cleared.
 */
export function payoffDisbursementGate(i: { loan: Pick<FraudHoldRow, "fraud_hold" | "fraud_hold_reason" | "fraud_hold_expires_on">; today: PlainDate }): { gate: "SM_FRAUD_PAYOFF_HOLD"; open: boolean; payoff_disbursement: "held" | "proceeds"; reason: string | null; expires_on: PlainDate | null } {
  const live = i.loan.fraud_hold && i.loan.fraud_hold_expires_on !== null && i.today < i.loan.fraud_hold_expires_on;
  return { gate: "SM_FRAUD_PAYOFF_HOLD", open: !live, payoff_disbursement: live ? "held" : "proceeds", reason: live ? `payoff disbursement held: ${i.loan.fraud_hold_reason ?? "loans.fraud_hold"} (expires ${i.loan.fraud_hold_expires_on})` : null, expires_on: live ? i.loan.fraud_hold_expires_on : null };
}

// ============================================================ dual control (T9, rule 7)
/**
 * Rule 7: "dual control — the QC officer cannot investigate a case in which they are a subject; the board/partner is
 * notified of any employee-dishonesty determination; screening lists re-run." A refused assignment routes to the deputy
 * fraud officer, else the board designee.
 */
export function caseAssignment(i: { case_id: string; subject_kind: SubjectKind; officer_id: string; subjects: readonly string[]; deputy_designee: string | null }): { allowed: boolean; refusal: string | null; assigned_to: string; routed_to: "deputy_or_board_designee" | null; route_chain: readonly ["deputy_fraud_officer", "board_designee"]; escalation: QcEscalation | null; rescreen_required: boolean } {
  const chain = ["deputy_fraud_officer", "board_designee"] as const;
  if (assignmentAllowed(i.officer_id, i.subjects)) return { allowed: true, refusal: null, assigned_to: i.officer_id, routed_to: null, route_chain: chain, escalation: null, rescreen_required: i.subject_kind === "employee" || i.subject_kind === "vendor" };
  const designee = i.deputy_designee ?? "board_designee";
  return {
    allowed: false, refusal: `assignment refused: ${i.officer_id} is a subject of ${i.subject_kind} case ${i.case_id} (dual control, rule 7) — routed to the deputy/board designee ${designee}`,
    assigned_to: designee, routed_to: "deputy_or_board_designee", route_chain: chain,
    escalation: { kind: "officer", severity: "sev2", reason: `dual control: fraud officer ${i.officer_id} is a subject of case ${i.case_id}; ${i.deputy_designee ? `deputy ${i.deputy_designee}` : "the board designee"} takes the determination` },
    rescreen_required: true,
  };
}
/**
 * SM_FRAUD_CARRIER_NOTICE_IMMEDIATE: "employee dishonesty / covered loss discovered" → `fraud.covered_loss.discovered`
 * (payload `discovered_on`) arms the 1-business-day carrier clock; "carrier notice evidenced" is the officer-signed carrier
 * claim package recorded in `fraud_reports` with channel `carrier` (fraudReportFiledEvent). A3-5-04 fidelity/E&O
 * event; the policy's "immediate"/"as soon as practicable" terms are UNVERIFIED per policy.
 */
export function coveredLossDiscoveredEvent(i: { case_id: string; loan_id: string | null; discovered_on: PlainDate; loss_kind: "employee_dishonesty" | "covered_loss"; exposure_cents: bigint; cal?: Calendar }): { timer: "SM_FRAUD_CARRIER_NOTICE_IMMEDIATE"; due: PlainDate; satisfied_by: "`fraud.report.filed{channel=carrier}`"; escalation: QcEscalation; event: Emitted<{ case_id: string; loan_id: string | null; discovered_on: PlainDate; loss_kind: "employee_dishonesty" | "covered_loss"; exposure_cents: bigint }> } {
  const due = addBusinessDays(i.discovered_on, 1, i.cal ?? servicer);
  return {
    timer: "SM_FRAUD_CARRIER_NOTICE_IMMEDIATE", due, satisfied_by: "`fraud.report.filed{channel=carrier}`",
    escalation: { kind: "officer", severity: "sev1", reason: `sign the carrier claim notice for case ${i.case_id}: ${i.loss_kind.replace("_", " ")} discovered ${i.discovered_on}, exposure ${i.exposure_cents}¢ — due ${due} (fidelity bond/E&O event, A3-5-04; policy "immediate" terms UNVERIFIED)`, due },
    event: { type: "fraud.covered_loss.discovered", actor: QC_AUDIT_AGENT, ...loanRef(i.loan_id), aggregate: caseAggregate(i.case_id), payload: { case_id: i.case_id, loan_id: i.loan_id, discovered_on: i.discovered_on, loss_kind: i.loss_kind, exposure_cents: i.exposure_cents } },
  };
}
/** Rule 7 second half: an employee-dishonesty determination notifies the board and the partner, re-runs the screening lists and discovers the covered loss for the carrier clock. */
export function employeeDishonestyFollowUp(i: { case_id: string; loan_id: string | null; subject_kind: SubjectKind; determination: Determination; determined_at: PlainDate; exposure_cents: bigint; cal?: Calendar }): { board_partner_notice: boolean; rescreen: boolean; carrier_notice: boolean; carrier: ReturnType<typeof coveredLossDiscoveredEvent> | null } {
  const hit = i.subject_kind === "employee" && i.determination === "reasonable_basis";
  return { board_partner_notice: hit, rescreen: hit, carrier_notice: hit, carrier: hit ? coveredLossDiscoveredEvent({ case_id: i.case_id, loan_id: i.loan_id, discovered_on: i.determined_at, loss_kind: "employee_dishonesty", exposure_cents: i.exposure_cents, ...(i.cal ? { cal: i.cal } : {}) }) : null };
}

// ============================================================ determination + filing (T2, T3)
/**
 * `fraud.determination.recorded` — the officer's act; null when there is no recorded officer determination (the agent's
 * memo is not one, and neither is a "determination" recorded under a non-determination role). Arms
 * FNMA_A3403_FRAUD_REPORT_30 (`reasonable_basis=true`, anchor `determination_at`), SM_FRAUD_LE_REFERRAL_DECISION_10BD
 * (`le_referral_candidate=true`) and the partner-notice determination leg.
 */
export function determinationRecordedEvent(i: { case_id: string; loan_id: string | null; officer: OfficerDetermination | null; exposure_cents: bigint; flags: readonly string[]; subject_kind?: SubjectKind; scheme_code?: string | null }): Emitted<{ case_id: string; determination: Determination; reasonable_basis: boolean; le_referral_candidate: boolean; determination_at: PlainDate; determined_by_officer_id: string; determined_by_role: string; exposure_cents: bigint; scheme_code: string | null; partner_notice_leg: "determination" }> | null {
  if (!i.officer) return null;
  const role = determinationActor(i.officer.determined_by_role);
  if (!role.allowed || !role.actor_role) return null;
  const le = leReferralDecision({ determination: i.officer.determination, determined_at: i.officer.determined_at, exposure_cents: i.exposure_cents, flags: i.flags, ...(i.subject_kind ? { subject_kind: i.subject_kind } : {}), ...(i.scheme_code ? { scheme_code: i.scheme_code } : {}) });
  return { type: "fraud.determination.recorded", actor: { kind: "human", id: i.officer.determined_by_officer_id, role: role.actor_role }, ...loanRef(i.loan_id), aggregate: caseAggregate(i.case_id), payload: { case_id: i.case_id, determination: i.officer.determination, reasonable_basis: le.arms.reasonable_basis, le_referral_candidate: le.arms.le_referral_candidate, determination_at: i.officer.determined_at, determined_by_officer_id: i.officer.determined_by_officer_id, determined_by_role: i.officer.determined_by_role, exposure_cents: i.exposure_cents, scheme_code: i.scheme_code ?? null, partner_notice_leg: "determination" } };
}

/** SM_FRAUD_DUE_DILIGENCE_15: no determination by day 15 breaches sev-2 to the fraud officer ("protects the 30-day window"). */
export function diligenceBreach(i: { case_id: string; opened_on: PlainDate; determination_on: PlainDate | null; today: PlainDate }): { timer: "SM_FRAUD_DUE_DILIGENCE_15"; due: PlainDate; breached: boolean; escalation: QcEscalation | null } {
  const due = addDays(i.opened_on, 15);
  const breached = i.determination_on === null ? i.today > due : i.determination_on > due;
  return { timer: "SM_FRAUD_DUE_DILIGENCE_15", due, breached, escalation: breached ? { kind: "fraud_officer", severity: "sev2", reason: `SM_FRAUD_DUE_DILIGENCE_15 breached for case ${i.case_id}: no determination by ${due} (15 days from the ${i.opened_on} red flag) — record the determination now; the diligence timer protects the 30-day A3-4-03 window`, due } : null };
}

/**
 * The roles an 18.5 breach column names, read from the registry row itself: the kernel's role parser only reads
 * bare backticked tokens, so a colon-qualified `officer:fraud_officer` leaves `escalateTo` empty — this reads it.
 */
export function breachRoles(def: { breach: string; severity: { escalateTo: readonly string[] } }): string[] {
  const roles = new Set<string>(def.severity.escalateTo);
  for (const m of def.breach.matchAll(/`officer:([a-z][a-z0-9_]*)`/g)) roles.add(m[1]!);
  return [...roles];
}
/**
 * Routes the engine's own breach of an 18.5 row to the role its breach column names (T3: `SM_FRAUD_DUE_DILIGENCE_15`
 * "breaches to the fraud officer"; FNMA_A3403_FRAUD_REPORT_30 "sev-1 → officer + partner"; OFAC/law-firm/carrier
 * sev-1 → officer; the referral decision sev-2 → attorney). Consumes the TimerEngine `Breach` (def, severity,
 * escalateTo, breachText) so the routing is derived from what the engine breached, not re-derived from dates.
 */
export function breachEscalation(b: { def: { code: string; breach: string; severity: { escalateTo: readonly string[] } }; severity: 1 | 2 | 3 | 4 | null; breachText: string }, i: { case_id: string; due: PlainDate }): QcEscalation & { roles: string[]; partner_notice: boolean } {
  const roles = breachRoles(b.def);
  const kind: QcEscalation["kind"] = roles.includes("fraud_officer") ? "fraud_officer" : roles.includes("attorney") || b.def.code === "SM_FRAUD_LE_REFERRAL_DECISION_10BD" ? "attorney" : "officer";
  const severity = (`sev${b.severity ?? 2}`) as "sev1" | "sev2" | "sev3" | "sev4";
  return { kind, severity, reason: `${b.def.code} breached for case ${i.case_id} (due ${i.due}): ${b.breachText}`, due: i.due, roles, partner_notice: /partner/i.test(b.breachText) };
}

/**
 * `fraud.report.filed{channel}` — an external report is a human act: the officer signs (role-checked) and the sent
 * evidence is kept (`fraud_reports.signed_by_officer_id`, `evidence`). An LQC self-report carries its
 * `lqc_reference`; without it the filing does not satisfy FNMA_A3403_FRAUD_REPORT_30 ("with LQC reference").
 */
export function fraudReportFiledEvent(i: { case_id: string; loan_id: string | null; channel: ReportChannel; signed_by_officer_id: string | null; signed_by_role: string; evidence_document_id: string | null; sent_on: PlainDate; lqc_reference?: string | null; kind?: "case_report" | "breach_self_report"; subject?: { kind: string; id: string } }): Emitted<{ case_id: string; channel: ReportChannel; kind: "case_report" | "breach_self_report"; signed_by_officer_id: string; signed_by_role: "officer"; evidence_document_id: string; sent_on: PlainDate; lqc_reference?: string }> | null {
  if (!i.signed_by_officer_id || !i.evidence_document_id || !reportSigner(i.signed_by_role).allowed) return null;
  return { type: "fraud.report.filed", actor: { kind: "human", id: i.signed_by_officer_id, role: REPORT_SIGNING_ROLE }, ...loanRef(i.loan_id), aggregate: i.subject ?? caseAggregate(i.case_id), payload: { case_id: i.case_id, channel: i.channel, kind: i.kind ?? "case_report", signed_by_officer_id: i.signed_by_officer_id, signed_by_role: "officer", evidence_document_id: i.evidence_document_id, sent_on: i.sent_on, ...(i.lqc_reference ? { lqc_reference: i.lqc_reference } : {}) } };
}

/** FNMA_A3403_FRAUD_REPORT_30 outcome for a filing: due day 30, internal target day 20; a filing after the due date is recorded as breached (`satisfied_late`). */
export function reportFilingOutcome(i: { case_id: string; determination_at: PlainDate; filed_on: PlainDate | null; lqc_reference: string | null; today?: PlainDate }): { timer: "FNMA_A3403_FRAUD_REPORT_30"; due: PlainDate; internal_target: PlainDate; breached: boolean; status: "open" | "breached" | "satisfied" | "satisfied_late"; satisfies_timer: boolean; refusal: string | null; escalations: QcEscalation[] } {
  const due = addDays(i.determination_at, 30); const target = addDays(i.determination_at, 20);
  const filed = i.filed_on !== null && i.lqc_reference !== null && i.lqc_reference !== "";
  const refusal = i.filed_on !== null && !filed ? `filing on ${i.filed_on} does not satisfy FNMA_A3403_FRAUD_REPORT_30: no LQC reference captured` : null;
  const asOf = i.filed_on ?? i.today ?? i.determination_at;
  const breached = asOf > due;
  const status = filed ? (breached ? "satisfied_late" : "satisfied") : breached ? "breached" : "open";
  const escalations: QcEscalation[] = breached ? [{ kind: "officer", severity: "sev1", reason: `FNMA_A3403_FRAUD_REPORT_30 breached for case ${i.case_id}: LQC self-report due ${due}${i.filed_on ? `, filed ${i.filed_on}` : ", not filed"} — notify the partner` }] : [];
  return { timer: "FNMA_A3403_FRAUD_REPORT_30", due, internal_target: target, breached, status, satisfies_timer: filed, refusal, escalations };
}

// ============================================================ OFAC (T4) and law firm (T5)
/** A3-2-01: "within 24 hours" of a valid sanctions-list match — clock hours from the confirmation timestamp (weekends count); Ethics email content per rule 5. */
export function ofacEthicsNotice(i: { case_id: string; confirmed_at: string; borrower_name: string; fnma_loan_number: string; servicer_contact: string }): { timer: "FNMA_A3201_OFAC_MATCH_24H"; due_at: string; due_et: { date: PlainDate; hour: number; minute: number }; clock_hours: 24; counts_weekend: true; channel: "ethics_email_ofac"; template: "FRAUD-OFAC-24H-v1"; recipient: "fnma_ethics_division"; content: { borrower_name: string; fnma_loan_number: string; servicer_contact: string }; escalation: QcEscalation; blocking: "per 31 CFR 501 (Section 19)" } {
  const dueMs = ofacEmailDueMs(Date.parse(i.confirmed_at));
  const w = wallClock(dueMs, ET);
  return { timer: "FNMA_A3201_OFAC_MATCH_24H", due_at: toIso(dueMs), due_et: { date: w.date, hour: w.hour, minute: w.minute }, clock_hours: 24, counts_weekend: true, channel: "ethics_email_ofac", template: "FRAUD-OFAC-24H-v1", recipient: "fnma_ethics_division", content: { borrower_name: i.borrower_name, fnma_loan_number: i.fnma_loan_number, servicer_contact: i.servicer_contact }, escalation: { kind: "officer", severity: "sev1", reason: `sign the OFAC Ethics email for case ${i.case_id} by ${w.date} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")} ET (24 clock hours from confirmation)`, due: w.date }, blocking: "per 31 CFR 501 (Section 19)" };
}

// ============================================================ OFAC match ingestion (T4): screening_results → `ofac.match.confirmed`
/** The OFAC lists the Section 19 screening feed carries ("OFAC SDN/consolidated lists"); SAM/LDP/SCP hits are `SCREENING_HIT`, not an OFAC match. */
export const OFAC_LISTS: readonly string[] = ["OFAC_SDN", "OFAC_CONSOLIDATED"];
/** `screening_results.disposition` (Section 19): a hit is `potential` until a human clears it or confirms it as a valid match. */
export type ScreeningDisposition = "potential" | "confirmed" | "false_positive" | "cleared";
/** A `screening_results` row (Section 19: subject, list, match score, disposition) as the screening adapter delivers it. */
export interface ScreeningResult {
  readonly screening_result_id: string; readonly subject: { kind: "borrower" | "party" | "payee" | "vendor" | "employee"; id: string; name: string };
  readonly list: string; readonly match_score: number; readonly disposition: ScreeningDisposition;
  /** The confirmation timestamp (ISO instant) — the anchor of FNMA_A3201_OFAC_MATCH_24H; null until a human confirms the match. */
  readonly confirmed_at: string | null; readonly confirmed_by_id: string | null;
  readonly loan_id: string | null; readonly fnma_loan_number: string | null;
}
/**
 * Rule 1 catalog entry the shared calculator (fraud.ts FLAG_SCORES) does not carry: a valid sanctions-list match is P1 on
 * its own — same-day, immediate protective action (blocking per 31 CFR 501, Section 19) and the 24-hour Ethics notice —
 * so the platform standard scores `OFAC_MATCH` at the cap (100). The spec's flag catalog names OFAC_MATCH without a score.
 */
export const OFAC_MATCH_FLAG_SCORE = 100;
export interface OfacMatchConfirmedPayload extends Record<string, unknown> {
  readonly case_id: string; readonly loan_id: string | null; readonly screening_result_id: string; readonly subject_kind: ScreeningResult["subject"]["kind"]; readonly subject_id: string; readonly subject_name: string;
  readonly list: string; readonly match_score: number; readonly confirmed_at: string; readonly confirmed_by_id: string; readonly fnma_loan_number: string | null; readonly flag_code: "OFAC_MATCH";
}
/**
 * Ingestion of an inbound Section 19 screening result: only a *confirmed* match on an OFAC list is a "valid sanctions-list
 * match" (A3-2-01) — a `potential` hit still under review, a cleared/false-positive one, or a SAM/LDP/SCP hit is no OFAC
 * match and arms nothing. Validates the record (list, disposition, a parseable confirmation timestamp, a score in [0, 1],
 * a named subject) and returns the `ofac.match.confirmed` event — `occurredAt` is the confirmation timestamp, the row's
 * anchor — with the `OFAC_MATCH` red flag (score 100) and the 24-clock-hour due instant (ofacEmailDueMs).
 */
export function ofacMatchConfirmedEvent(i: { result: ScreeningResult; case_id: string }): { event: Emitted<OfacMatchConfirmedPayload> | null; flag: RedFlag | null; due_at: string | null; refusal: string | null } {
  const r = i.result;
  const no = (why: string) => ({ event: null, flag: null, due_at: null, refusal: `screening result ${r.screening_result_id || "(no id)"} is no confirmed OFAC match: ${why}` });
  if (!r.screening_result_id) return no("no screening_result_id");
  if (!OFAC_LISTS.includes(r.list)) return no(`list ${r.list || "(none)"} is not an OFAC list (${OFAC_LISTS.join("/")}); SAM/LDP/SCP hits are SCREENING_HIT`);
  if (r.disposition !== "confirmed") return no(`disposition ${r.disposition || "(none)"} — only a confirmed (valid) match starts the 24-hour A3-2-01 clock`);
  if (!r.confirmed_at || Number.isNaN(Date.parse(r.confirmed_at))) return no("no parseable confirmation timestamp (the anchor of FNMA_A3201_OFAC_MATCH_24H)");
  if (!r.confirmed_by_id) return no("a confirmation is a human disposition — no confirmed_by_id");
  if (!(typeof r.match_score === "number" && r.match_score >= 0 && r.match_score <= 1)) return no(`match_score ${String(r.match_score)} is not in [0, 1]`);
  if (!r.subject?.id || !r.subject.name) return no("no screened subject (id and name)");
  const confirmedMs = Date.parse(r.confirmed_at);
  const confirmed_at = toIso(confirmedMs);
  const detected_on = wallClock(confirmedMs, ET).date;
  return {
    event: { type: "ofac.match.confirmed", actor: QC_AUDIT_AGENT, ...loanRef(r.loan_id), aggregate: caseAggregate(i.case_id), occurredAt: confirmed_at, payload: { case_id: i.case_id, loan_id: r.loan_id, screening_result_id: r.screening_result_id, subject_kind: r.subject.kind, subject_id: r.subject.id, subject_name: r.subject.name, list: r.list, match_score: r.match_score, confirmed_at, confirmed_by_id: r.confirmed_by_id, fnma_loan_number: r.fnma_loan_number, flag_code: "OFAC_MATCH" } },
    flag: { flag_code: "OFAC_MATCH", score: OFAC_MATCH_FLAG_SCORE, detector: "SCREENING_OFAC_CONFIRMED_v1", detected_on, source_event: "ofac.match.confirmed", loan_id: r.loan_id, detail: { screening_result_id: r.screening_result_id, list: r.list, match_score: r.match_score, confirmed_at, subject_kind: r.subject.kind, subject_id: r.subject.id } },
    due_at: toIso(ofacEmailDueMs(confirmedMs)), refusal: null,
  };
}

/**
 * A4-2.2-02: "actual or alleged fraud" by a law firm → Fannie Mae Legal within two business days of discovery (Section 13
 * owns; 18.5 co-files `FRAUD-LAWFIRM-2BD-v1`). A Fannie Mae deadline counts on Fannie Mae's calendar (`fannieEt`, as
 * fraud.ts lawFirmFraudNoticeDue defaults) — a servicer-only closure never extends it, so no servicer calendar is taken.
 */
export function lawFirmFraudEscalation(i: { case_id: string; firm_id: string; discovered_on: PlainDate }): { timer: "FNMA_A4222_LAWFIRM_FRAUD_2BD"; due: PlainDate; calendar: "business_days_fannie_et"; channel: "fnma_legal_email"; template: "FRAUD-LAWFIRM-2BD-v1"; co_owner: "13"; escalation: QcEscalation; arms: Emitted<{ case_id: string; firm_id: string; discovered_on: PlainDate }> } {
  const due = lawFirmFraudNoticeDue(i.discovered_on, fannieEt);
  return { timer: "FNMA_A4222_LAWFIRM_FRAUD_2BD", due, calendar: "business_days_fannie_et", channel: "fnma_legal_email", template: "FRAUD-LAWFIRM-2BD-v1", co_owner: "13", escalation: { kind: "officer", severity: "sev1", reason: `sign the Fannie Mae Legal email (FRAUD-LAWFIRM-2BD-v1) for firm ${i.firm_id}, case ${i.case_id}: alleged law-firm fraud discovered ${i.discovered_on}, due ${due} (A4-2.2-02, two business days)`, due }, arms: { type: "lawfirm.fraud.alleged", actor: QC_AUDIT_AGENT, aggregate: caseAggregate(i.case_id), payload: { case_id: i.case_id, firm_id: i.firm_id, discovered_on: i.discovered_on } } };
}

/** SM_FRAUD_LE_REFERRAL_DECISION_10BD is satisfied by `fraud.le_referral.decided{decision∈{refer, not_refer}}` — the attorney's recorded decision, with a reason when not referring. */
export function leReferralDecidedEvent(i: { case_id: string; loan_id: string | null; decision: "refer" | "not_refer"; decided_by_role: "attorney" | string; attorney_id: string; reason: string | null; decided_on: PlainDate }): Emitted<{ case_id: string; decision: "refer" | "not_refer"; attorney_id: string; reason: string | null; decided_on: PlainDate }> | null {
  if (i.decided_by_role !== REFERRAL_ROLE) return null;
  if (i.decision === "not_refer" && !i.reason) return null;
  return { type: "fraud.le_referral.decided", actor: { kind: "human", id: i.attorney_id, role: "attorney" }, ...loanRef(i.loan_id), aggregate: caseAggregate(i.case_id), payload: { case_id: i.case_id, decision: i.decision, attorney_id: i.attorney_id, reason: i.reason, decided_on: i.decided_on } };
}

/**
 * FNMA_ISBR_CYBER_INCIDENT_36H (Section 19 owns; 18.5 co-files when fraud rides on a BEC) is satisfied by Section 19's own
 * event for the notice to privacy_office@fanniemae.com: `incident.notice.sent{recipient=fannie_mae_supplement}` (19.2
 * `incident_notices.recipient`, NTC_FNMA_INCIDENT_36H) — built here through 19.2's incidentNoticeSent so the shape can
 * never drift, with the fraud case linked. An officer's act (19.2: every regulatory notice is sent by an officer).
 */
export function cyberIncidentNoticeEvent(i: { incident_id: string; case_id: string | null; sent_at: string | null; sent_by_role: string; sent_by_id?: string; evidence_document_id: string | null; bec_payoff_diversion: boolean }): { event: Emitted<Record<string, unknown> & { recipient: "fannie_mae_supplement"; incident_id: string; case_id: string | null; bec_payoff_diversion: boolean }> | null; row: Record<string, unknown> | null; refusal: string | null } {
  if (!i.sent_at || !i.evidence_document_id) return { event: null, row: null, refusal: `incident ${i.incident_id}: an unevidenced or unsent notice is no notice to privacy_office@fanniemae.com (FNMA_ISBR_CYBER_INCIDENT_36H)` };
  const s = incidentNoticeSent({ incident_id: i.incident_id, recipient: "fannie_mae_supplement", template_code: "NTC_FNMA_INCIDENT_36H", sent_ms: Date.parse(i.sent_at), sent_by_role: i.sent_by_role, channel: "email", evidence_document_id: i.evidence_document_id, kind: "incident_notice" });
  if (s.refusal) return { event: null, row: null, refusal: s.refusal };
  return { event: { type: s.event.type, occurredAt: s.event.occurredAt, aggregate: s.event.aggregate, actor: { kind: "human", id: i.sent_by_id ?? "officer", role: "officer" }, payload: { ...s.event.payload, recipient: "fannie_mae_supplement", incident_id: i.incident_id, case_id: i.case_id, bec_payoff_diversion: i.bec_payoff_diversion } }, row: { ...s.row, fraud_case_id: i.case_id, bec_payoff_diversion: i.bec_payoff_diversion }, refusal: null };
}

// ============================================================ A3-2-01 self-reports (T7)
export type SelfReportBasis = "count_over_500" | "pct_over_1" | "repurchase_risk_not_remediable_60";
export interface SelfReportClock {
  readonly required: boolean; readonly basis: SelfReportBasis | null; readonly timer: "FNMA_A3201_BREACH_SELF_REPORT_60";
  /** Later of quarter-end and discovery (QC-finding leg) or the determination (repurchase-risk leg). */
  readonly anchor: PlainDate | null; readonly due: PlainDate | null; readonly channel: "lqc_self_report";
  /** The event this process emits to arm the registry row (its `self_report_anchor_on` is the computed anchor). */
  readonly arms: { readonly type: "fraud.self_report.required"; readonly basis: SelfReportBasis; readonly self_report_anchor_on: PlainDate } | null;
  readonly satisfied_by: "`fraud.report.filed{channel=lqc_self_report, kind=breach_self_report}`";
}
/**
 * A3-2-01 self-reports, both legs: a validated QC finding whose population exceeds 500 loans or 1% of prior-year
 * deliveries "within 60 days" of quarter-end or discovery, whichever is later; and a repurchase-risk breach not
 * remediable within 60 days, "within 60 days" of the determination. Both file through the LQC self-report.
 */
export function breachSelfReportClock(i:
  | { kind: "qc_finding"; affected_count: number; prior_year_deliveries: number; breach_quarter_end: PlainDate; discovered_on: PlainDate; validated_on: PlainDate }
  | { kind: "repurchase_risk_breach"; determined_on: PlainDate }): SelfReportClock {
  const satisfied_by = "`fraud.report.filed{channel=lqc_self_report, kind=breach_self_report}`" as const;
  if (i.kind === "repurchase_risk_breach") {
    return { required: true, basis: "repurchase_risk_not_remediable_60", timer: "FNMA_A3201_BREACH_SELF_REPORT_60", anchor: i.determined_on, due: addDays(i.determined_on, 60), channel: "lqc_self_report", arms: { type: "fraud.self_report.required", basis: "repurchase_risk_not_remediable_60", self_report_anchor_on: i.determined_on }, satisfied_by };
  }
  const t = breachSelfReportTrigger({ affected_count: i.affected_count, prior_year_deliveries: i.prior_year_deliveries, breach_quarter_end: i.breach_quarter_end, discovered_on: i.discovered_on, validated_on: i.validated_on });
  return { required: t.required, basis: t.basis, timer: t.timer, anchor: t.anchor, due: t.due, channel: t.channel, arms: t.basis && t.anchor ? { type: "fraud.self_report.required", basis: t.basis, self_report_anchor_on: t.anchor } : null, satisfied_by };
}
/**
 * The registry grammar carries one trigger per row, and the spec's trigger is two events joined by "or" with a
 * population-or-percentage predicate — so this process listens to both (`qc.finding.validated` from 18.1 and
 * `repurchase_risk_breach.determined`), computes the clock, and publishes `fraud.self_report.required` with the
 * computed anchor; the registry row arms on that. Null when the population is under both A3-2-01 thresholds.
 */
export function selfReportRequiredEvent(i:
  | { source: "qc.finding.validated"; finding_id: string; population: number; prior_year_deliveries: number; quarter_end: PlainDate; discovered_on: PlainDate; validated_on: PlainDate }
  | { source: "repurchase_risk_breach.determined"; breach_id: string; determined_on: PlainDate }): Emitted<{ basis: SelfReportBasis; self_report_anchor_on: PlainDate; due: PlainDate; source: string; source_id: string; channel: "lqc_self_report" }> | null {
  const clock = i.source === "qc.finding.validated"
    ? breachSelfReportClock({ kind: "qc_finding", affected_count: i.population, prior_year_deliveries: i.prior_year_deliveries, breach_quarter_end: i.quarter_end, discovered_on: i.discovered_on, validated_on: i.validated_on })
    : breachSelfReportClock({ kind: "repurchase_risk_breach", determined_on: i.determined_on });
  if (!clock.arms || !clock.due) return null;
  const id = i.source === "qc.finding.validated" ? i.finding_id : i.breach_id;
  return { type: "fraud.self_report.required", actor: QC_AUDIT_AGENT, aggregate: { kind: "self_report", id }, payload: { basis: clock.arms.basis, self_report_anchor_on: clock.arms.self_report_anchor_on, due: clock.due, source: i.source, source_id: id, channel: "lqc_self_report" } };
}

// ============================================================ fairness (T10)
export interface FlagRateByClass { readonly class: string; readonly flag_rate: number; readonly reference: boolean; }
export interface FlagFairnessFinding {
  readonly kind: "rule_review"; readonly scope: "fraud_red_flag_rules"; readonly route: "attorney"; readonly privileged: true; readonly quarter: string;
  readonly protected_class: string; readonly protected_flag_rate: number; readonly reference_flag_rate: number; readonly ratio: number; readonly escalation: QcEscalation;
}
/**
 * Guardrail: "fairness monitoring of red-flag rates by protected class (18.1 fairness suite) because fraud flags can
 * delay relief" — each protected class's quarterly flag rate against the reference class; an adverse-impact ratio
 * below 0.80 opens a privileged rule-review finding routed via counsel (`attorney`), never a borrower-level action.
 */
export function quarterlyFlagFairnessReview(i: { quarter: string; rates: readonly FlagRateByClass[] }): { quarter: string; reference_flag_rate: number; results: { class: string; flag_rate: number; ratio: number; finding: boolean }[]; findings: FlagFairnessFinding[]; finding_opened: boolean; route: "attorney" | null } {
  const ref = i.rates.find((r) => r.reference);
  if (!ref) throw new RangeError("quarterly fairness stats need a reference class");
  const results: { class: string; flag_rate: number; ratio: number; finding: boolean }[] = []; const findings: FlagFairnessFinding[] = [];
  for (const r of i.rates) {
    if (r.reference) continue;
    const f = fraudFlagFairness({ quarter: i.quarter, reference_flag_rate: ref.flag_rate, protected_flag_rate: r.flag_rate });
    results.push({ class: r.class, flag_rate: r.flag_rate, ratio: f.ratio, finding: f.finding !== null });
    if (f.finding) findings.push({ ...f.finding, protected_class: r.class, protected_flag_rate: r.flag_rate, reference_flag_rate: ref.flag_rate, ratio: f.ratio, escalation: { kind: "attorney", reason: `rule review (privileged): ${i.quarter} red-flag rate ${(r.flag_rate * 100).toFixed(1)}% for ${r.class} vs ${(ref.flag_rate * 100).toFixed(1)}% reference — adverse-impact ratio ${f.ratio} < 0.80` } });
  }
  return { quarter: i.quarter, reference_flag_rate: ref.flag_rate, results, findings, finding_opened: findings.length > 0, route: findings.length > 0 ? "attorney" : null };
}

// ============================================================ law-enforcement referral, partner legs
/** Timer table: `reasonable_basis` determination "with loss/exposure > $25,000 or identity theft/employee dishonesty". */
export const LE_REFERRAL_EXPOSURE_THRESHOLD_CENTS = 2_500_000n;
/**
 * The two scheme prongs are the determined scheme (`fraud_cases.scheme_code`), not a red flag: `identity_theft` (or the
 * 8.3-sourced `IDENTITY_THEFT` flag from `credit.identity_theft.reported`) and `employee_dishonesty` (or an employee
 * subject with a reasonable-basis determination). An `IDENTITY_MISMATCH` or a vendor `SCREENING_HIT` (the GSA/HUD LDP/
 * FHFA SCP hit — rule 2 "freeze vendor payments on screening hits") is neither and arms nothing by itself.
 */
export const LE_REFERRAL_SCHEMES: readonly string[] = ["identity_theft", "employee_dishonesty"];
export const IDENTITY_THEFT_FLAG = "IDENTITY_THEFT";
/** SM_FRAUD_LE_REFERRAL_DECISION_10BD: the `attorney` records refer / not-refer (with reason) within 10 business days of the determination. */
export function leReferralDecision(i: { determination: Determination; determined_at: PlainDate; exposure_cents: bigint; flags: readonly string[]; subject_kind?: SubjectKind; scheme_code?: string; cal?: Calendar }): { required: boolean; reason: "exposure_over_25000" | "identity_theft" | "employee_dishonesty" | null; timer: "SM_FRAUD_LE_REFERRAL_DECISION_10BD"; due: PlainDate | null; decided_by: "attorney"; arms: { type: "fraud.determination.recorded"; reasonable_basis: boolean; le_referral_candidate: boolean; determination_at: PlainDate } } {
  const rb = i.determination === "reasonable_basis";
  const identityTheft = i.scheme_code === "identity_theft" || i.flags.includes(IDENTITY_THEFT_FLAG);
  const employeeDishonesty = i.scheme_code === "employee_dishonesty" || i.subject_kind === "employee";
  const reason = !rb ? null : i.exposure_cents > LE_REFERRAL_EXPOSURE_THRESHOLD_CENTS ? "exposure_over_25000" : identityTheft ? "identity_theft" : employeeDishonesty ? "employee_dishonesty" : null;
  const required = reason !== null;
  return { required, reason, timer: "SM_FRAUD_LE_REFERRAL_DECISION_10BD", due: required ? addBusinessDays(i.determined_at, 10, i.cal ?? servicer) : null, decided_by: "attorney", arms: { type: "fraud.determination.recorded", reasonable_basis: rb, le_referral_candidate: required, determination_at: i.determined_at } };
}

/** SM_FRAUD_PARTNER_NOTIFY_1BD: armed by `fraud.case.opened` with score ≥ 60 (P1/P2) and again at the determination; each leg is 1 business day. */
export function partnerNoticeLegs(i: { opened_on: PlainDate; score: number; determined_on: PlainDate | null; cal?: Calendar }): { legs: { at: "open" | "determination"; anchor: PlainDate; due: PlainDate }[]; priority: "P1" | "P2" | "P3" } {
  const cal = i.cal ?? servicer; const legs: { at: "open" | "determination"; anchor: PlainDate; due: PlainDate }[] = [];
  if (i.score >= 60) legs.push({ at: "open", anchor: i.opened_on, due: addBusinessDays(i.opened_on, 1, cal) });
  if (i.determined_on !== null) legs.push({ at: "determination", anchor: i.determined_on, due: addBusinessDays(i.determined_on, 1, cal) });
  return { legs, priority: priority(i.score) };
}
