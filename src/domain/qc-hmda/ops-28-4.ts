/**
 * §28.4 operating rules — fraud cases (the shared `cases{case_type='fraud'}` row with the 28.4 payload), triage and the
 * SAR "initial detection" anchor, the SAR lifecycle (draft → officer decision → officer filing → acknowledgement →
 * continuing-activity cycle) inside the `sar_confidentiality_acl` compartment, OFAC hits / blocked property / rejected
 * transactions and the ORS reports, the Fannie Mae A3-4-03 self-report, FCRA §609(e) victim record requests, the
 * §1029.210 program pillars (risk assessment, independent test, training, program review), the 16 CFR 681 board
 * report, exclusion-list screening of counterparties, the 21.6 adverse-action interplay and the `fraud-risk` agent's
 * decision record. One small function per rule / T-id. Reuses 22.6 (src/domain/verification/ops-22-6.ts) for the SAR
 * deadline arithmetic, the OFAC 10-business-day clock, the fraud hold overlay (`placeHold` sets the `fraud_hold` state
 * `assertNoFraudHold` reads in 23.1/25.2/26.x/27.x), the SAR-term scrubber and the demographic-input guard, and 21.6
 * (ops-21-6.ts ECOA_REASONS) for the denial reason taxonomy. Vendor ports are 22.6's (identity_vendor, cbsv,
 * ofac_screener, fraud_tool, mers) — none are added here.
 *
 * Events (every one carries origination context — applicationId / payload.application_id, or `source: "origination"`
 * for a post-purchase case — so the 28.4 clocks arm; the timer each arms/satisfies is in brackets):
 *   fraud.case.opened{case_id, opened_at, production_hold, signals, scheme_hypotheses}          [arms SM_FRAUD_TRIAGE_SLA_10; production_hold=true arms SM_FRAUD_PRODUCTION_HOLD]
 *   fraud.case.triaged{triage_status, rationale, within_sla, officer_reviewed}                   [satisfies SM_FRAUD_TRIAGE_SLA_10]
 *   fraud.suspicious.determined{initial_detection_at, subject_identified, requires_immediate_attention}   [arms BSA_1029_320_SAR_30 / _60_NO_SUBJECT / _IMMEDIATE_LE_NOTICE]
 *   fraud.hold.placed / fraud.hold.released (22.6's names)                                         [SM_FRAUD_PRODUCTION_HOLD]
 *   law_enforcement.notified{agency, method}                                                       [satisfies BSA_1029_320_IMMEDIATE_LE_NOTICE]
 *   sar.drafted{sar_id, due_on, officer_decision_due_on}                                           [arms SM_BSA_OFFICER_SAR_DECISION_SLA_5]
 *   sar.officer_decision{decision}                                                                 [satisfies it]
 *   sar.filed{sar_id, filed_on, continuing_activity_of, retention_until}                          [satisfies BSA_1029_320_SAR_30 / _60_NO_SUBJECT; arms 31.3's BSA_1029_320C_SAR_RETENTION_5Y]
 *   sar.acknowledged{bsa_id, filed_on, activity_continues}                                        [activity_continues=true arms BSA_1029_320_SAR_CONTINUING_120]
 *   sar.rejected{validation_errors}  ·  sar.continuing_review.scheduled{review_due_on, continuing_due_on}
 *   sar.continuing_review.concluded{outcome∈{filed, no_file}}                                     [satisfies BSA_1029_320_SAR_CONTINUING_120]
 *   sar.access.denied{actor, reason}  ·  sar.subpoena.received{response=decline_to_produce}
 *   ofac.hit.recorded{hit_id, match_score}  ·  ofac.hit.dispositioned{disposition}
 *   ofac.property.blocked{blocked_date, report_due_on}  ·  ofac.transaction.rejected{rejection_date, report_due_on}   [OFAC_501_603_BLOCKED_REPORT_10BD / OFAC_501_604_REJECTED_REPORT_10BD / _ANNUAL_BLOCKED_0930]
 *   ofac.property.unblocked{unblocked_on, report_due_on}                                           [arms OFAC_501_603_UNBLOCKING_REPORT_10BD]
 *   ofac.report.submitted{kind, ors_reference, submitted_on}                                       [satisfies the OFAC report rows by kind]
 *   ofac.list.refreshed{rescreen_complete}  ·  ofac.list.refresh.failed                            [satisfies SM_OFAC_LIST_REFRESH_DAILY]
 *   fnma.fraud.reasonable_basis{reasonable_basis_at, delivered_or_committed, due_on}               [arms FNMA_A3_4_03_FRAUD_SELF_REPORT_30]
 *   fnma.fraud.report.approved  ·  fnma.fraud.report.submitted{reference, submitted_on, late}      [satisfies it]
 *   identity_theft.request.received{verified, received_on, due_on}                                 [arms FCRA_609E_VICTIM_RECORDS_30]
 *   identity_theft.request.fulfilled{outcome∈{records_provided, declined_e5}}                      [satisfies it]
 *   schedule.tick{cadence, job, source=origination}                                                [arms the annual / daily program rows]
 *   bsa.independent_test.completed{independent_of_officer}  ·  bsa.independent_test.rejected  ·  bsa.training.completed{all_appropriate_persons}
 *   bsa.program.reviewed{senior_management_approved, board_approved}  ·  bsa.program.version_bumped  ·  red_flags.board_report.issued
 *   counterparty.screened{blocked, list_versions}  ·  fraud.flag_rate.reported{period, by_channel, by_product}   (→ 31.2)
 */
import { randomUUID, createHash } from "node:crypto";
import { type PlainDate, addDays, addYears, plainDate, parts, ymd } from "../../kernel/calendar/date.ts";
import { addBusinessDays, nextBusinessDay, rollBack, creditor, federal, type Calendar } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { EntrySetInput } from "../../kernel/ledger/ledger.ts";
import type { GateResult } from "../../app/evaluator-kit.ts";
import {
  ScreeningRefused, SAR_THRESHOLD_CENTS, SAR_TERM_PATTERNS, HOLD_BLOCKED_COMMANDS, assertNoDemographicInputs, assertNoSarTerms, scrubSarTerms, sarDeadlines, selfReportDue, ofacReportDue, ofacRecordsRetainedUntil,
  placeHold, type FraudHold,
} from "../verification/ops-22-6.ts";
import { ECOA_REASONS } from "../application/ops-21-6.ts";

export const RULE_SET_VERSION = "28.4/2026-09-10";
/** The rule sets the decision record cites (AI agent design). */
export const RULE_SET_VERSIONS = { bsa: "bsa.1029", ofac: "ofac.501", fnma: "fnma.selling.2026-09-02", fcra: "fcra.681" } as const;
const AGENT: Actor = { kind: "agent", id: "fraud-risk" };
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const civil = (iso: string, cal: Calendar = creditor): PlainDate => wallClock(Date.parse(iso), cal.timeZone).date;
const isHumanRole = (a: Actor, roles: readonly string[]): boolean => a.kind === "human" && !!a.role && roles.includes(a.role);
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export { ScreeningRefused };

/** Case context: an application before funding, the loan after (both ids during the hand-off); post-purchase cases still arm the 28.4 clocks (`source: origination`). */
export interface CaseRef { readonly case_id: string; readonly application_id: string | null; readonly loan_id: string | null; }
const emitFor = (events: EventStore, ref: CaseRef, type: string, payload: Record<string, unknown>, at: string, actor: Actor): DomainEvent =>
  events.append({ type, ...(ref.application_id ? { applicationId: ref.application_id } : {}), ...(ref.loan_id ? { loanId: ref.loan_id } : {}), aggregate: ref.application_id ? { kind: "application", id: ref.application_id } : { kind: "case", id: ref.case_id }, actor, occurredAt: at,
    payload: { case_id: ref.case_id, ...(ref.application_id ? { application_id: ref.application_id } : {}), ...(ref.loan_id ? { loan_id: ref.loan_id } : {}), source: "origination", origination_process: "28.4", ...payload } });

// ============================================================ R1 — case threshold and signals
export type SchemeHypothesis = "identity_theft" | "synthetic_identity" | "income_fabrication" | "asset_fabrication" | "occupancy_misrep" | "undisclosed_debt" | "straw_buyer" | "appraisal_fraud" | "title_wire_fraud" | "employment_fabrication" | "document_forgery" | "money_laundering" | "structuring" | "sanctions_nexus" | "elder_exploitation" | "other";
export const SCHEME_HYPOTHESES: readonly SchemeHypothesis[] = ["identity_theft", "synthetic_identity", "income_fabrication", "asset_fabrication", "occupancy_misrep", "undisclosed_debt", "straw_buyer", "appraisal_fraud", "title_wire_fraud", "employment_fabrication", "document_forgery", "money_laundering", "structuring", "sanctions_nexus", "elder_exploitation", "other"];
export interface Signal { readonly source_process: string; readonly signal_code: string; readonly evidence_refs: readonly string[]; readonly score: number; }
/** Policy case threshold on the weighted signal score (calibrated by 31.2). */
export const CASE_THRESHOLD = 60;
/** Signals that open a case regardless of score (rule 1). */
export const AUTO_CASE_SIGNALS: readonly string[] = ["identity_failed", "ofac_potential_match", "qc_fraud_misrepresentation", "tip"];
export function aggregateSignals(signals: readonly Signal[], threshold: number = CASE_THRESHOLD): { score: number; opens_case: boolean; reasons: string[] } {
  for (const s of signals) if (!(s.score >= 0 && s.score <= 100)) throw new RangeError(`signal ${s.signal_code} score ${s.score} is outside 0..100`);
  const score = Math.min(100, signals.reduce((a, s) => a + s.score, 0));
  const reasons: string[] = [];
  if (score >= threshold) reasons.push(`weighted score ${score} ≥ threshold ${threshold}`);
  for (const s of signals) if (AUTO_CASE_SIGNALS.includes(s.signal_code)) reasons.push(`${s.signal_code} (${s.source_process}) opens a case on its own`);
  return { score, opens_case: reasons.length > 0, reasons };
}
/** Upstream events → signals: the intake table of the "Inputs and triggers" paragraph (28.1/28.2 QC referrals, 26.3 wire fraud, 22.x screening, 22.2 alerts, 29.4 breach notice, 22.6 hand-offs). */
export const SIGNAL_INTAKE: Readonly<Record<string, { signal_code: string; score: number; hypotheses: readonly SchemeHypothesis[] }>> = {
  "qc.fraud_referral.requested": { signal_code: "qc_fraud_misrepresentation", score: 70, hypotheses: ["document_forgery"] },
  "qc.fraud.referred": { signal_code: "qc_fraud_misrepresentation", score: 70, hypotheses: ["occupancy_misrep"] },
  "funding.fraud_case.requested": { signal_code: "wire_fraud_indicators", score: 60, hypotheses: ["title_wire_fraud"] },
  "document.integrity.failed": { signal_code: "document_integrity_fail", score: 40, hypotheses: ["document_forgery"] },
  "identity.failed": { signal_code: "identity_failed", score: 80, hypotheses: ["identity_theft", "synthetic_identity"] },
  "ofac.potential_match": { signal_code: "ofac_potential_match", score: 50, hypotheses: ["sanctions_nexus"] },
  "credit.fraud_alert.detected": { signal_code: "cra_fraud_alert", score: 25, hypotheses: ["identity_theft"] },
  "fraud_tool.report.received": { signal_code: "fraud_tool_alert", score: 30, hypotheses: ["employment_fabrication"] },
  "occupancy.assessed": { signal_code: "occupancy_contradiction", score: 30, hypotheses: ["occupancy_misrep"] },
  "fnma.breach.notified": { signal_code: "tip", score: 50, hypotheses: ["title_wire_fraud"] },
  "red_flag.detected": { signal_code: "red_flag", score: 20, hypotheses: ["identity_theft"] },
  "fraud.suspicious.determined": { signal_code: "investigation_concluded_suspicious", score: 100, hypotheses: ["other"] },
};
export function signalFromEvent(e: DomainEvent): Signal | null {
  const row = SIGNAL_INTAKE[e.type]; if (!row) return null;
  const p = e.payload as Record<string, unknown>;
  const refs = [e.id, ...(typeof p.document_id === "string" ? [p.document_id] : []), ...(typeof p.finding_id === "string" ? [p.finding_id] : []), ...(typeof p.review_id === "string" ? [p.review_id] : []), ...(typeof p.investigation_id === "string" ? [p.investigation_id] : [])];
  return { source_process: sourceProcessOf(e.type), signal_code: row.signal_code, evidence_refs: refs, score: row.score };
}
const sourceProcessOf = (type: string): string => (type.startsWith("qc.fraud_referral") ? "28.1" : type === "qc.fraud.referred" ? "28.2" : type.startsWith("funding.") ? "26.3" : type.startsWith("document.integrity") ? "22.1" : type.startsWith("credit.") ? "22.2" : type.startsWith("fnma.breach") ? "29.4" : "22.6");

// ============================================================ the case (shared cases{case_type='fraud'} + 28.4 payload)
export type TriageStatus = "open" | "under_review" | "suspicious_determined" | "not_suspicious" | "closed";
export const TRIAGE_SLA_DAYS = 10;
export const RETENTION_CLASSES: readonly string[] = ["bsa_sar_5y", "fnma_loan_file_life_plus_4y"];
export interface InvestigationStep { readonly tool: string; readonly source: string; readonly result: string; readonly evidence_refs: readonly string[]; readonly at: string; }
export interface FraudCase extends CaseRef {
  readonly partner_id: string; readonly opened_at: string; readonly opened_on: PlainDate; readonly opened_by: string;
  readonly signals: readonly Signal[]; readonly scheme_hypotheses: readonly SchemeHypothesis[]; readonly subjects: readonly { party_id: string; role: string }[];
  readonly amount_cents: bigint; readonly triage_status: TriageStatus; readonly triage_due_on: PlainDate;
  readonly initial_detection_at: PlainDate | null; readonly subject_identified: boolean | null; readonly requires_immediate_attention: boolean;
  readonly law_enforcement_notified_at: string | null; readonly fnma_reasonable_basis_at: PlainDate | null; readonly production_hold: boolean; readonly hold: FraudHold | null;
  readonly decision_reasons_for_no_sar: string | null; readonly triage_rationale: string | null; readonly closed_at: string | null; readonly steps: readonly InvestigationStep[];
  readonly retention_classes: readonly string[];
}
export function triageDue(opened_on: PlainDate): PlainDate { return addDays(opened_on, TRIAGE_SLA_DAYS); }
export interface OpenCaseInput { readonly application_id?: string | null; readonly loan_id?: string | null; readonly partner_id: string; readonly opened_by: string; readonly signals: readonly Signal[]; readonly scheme_hypotheses: readonly SchemeHypothesis[]; readonly subjects?: readonly { party_id: string; role: string }[]; readonly amount_cents: bigint; readonly application_open: boolean; readonly at: string; readonly case_id?: string | null; }
/** Rule 1: the case opens (signals over the threshold, or an auto-case signal, or a tip); on an open application the production hold overlays 22.6's `fraud_hold` (SM_FRAUD_PRODUCTION_HOLD). */
export function openFraudCase(events: EventStore, i: OpenCaseInput, actor: Actor = AGENT): { fraud_case: FraudCase; events: DomainEvent[]; aggregate: ReturnType<typeof aggregateSignals> } {
  nonEmpty(i.partner_id, "partner_id"); nonEmpty(i.opened_by, "opened_by");
  if (!i.application_id && !i.loan_id) throw new RangeError("a fraud case needs an application_id or a loan_id");
  if (i.amount_cents < 0n) throw new RangeError("amount_cents must be ≥ 0");
  for (const h of i.scheme_hypotheses) if (!SCHEME_HYPOTHESES.includes(h)) throw new RangeError(`unknown scheme hypothesis ${h}`);
  const aggregate = aggregateSignals(i.signals);
  if (!aggregate.opens_case) throw new ScreeningRefused("BELOW_CASE_THRESHOLD", "28.4 rule 1 (signals below the case threshold are retained for pattern analysis; no case)", `weighted score ${aggregate.score} < ${CASE_THRESHOLD} and no auto-case signal`);
  const ref: CaseRef = { case_id: i.case_id ?? randomUUID(), application_id: i.application_id ?? null, loan_id: i.loan_id ?? null };
  const opened_on = civil(i.at);
  const out: DomainEvent[] = [];
  let hold: FraudHold | null = null;
  const production_hold = i.application_open && !!ref.application_id;
  const fraud_case: FraudCase = { ...ref, partner_id: i.partner_id, opened_at: i.at, opened_on, opened_by: i.opened_by, signals: i.signals, scheme_hypotheses: i.scheme_hypotheses, subjects: i.subjects ?? [], amount_cents: i.amount_cents, triage_status: "open", triage_due_on: triageDue(opened_on),
    initial_detection_at: null, subject_identified: null, requires_immediate_attention: false, law_enforcement_notified_at: null, fnma_reasonable_basis_at: null, production_hold, hold: null, decision_reasons_for_no_sar: null, triage_rationale: null, closed_at: null, steps: [], retention_classes: RETENTION_CLASSES };
  out.push(emitFor(events, ref, "fraud.case.opened", { partner_id: i.partner_id, opened_at: i.at, opened_on, opened_by: i.opened_by, signals: i.signals, scheme_hypotheses: i.scheme_hypotheses, amount_cents: String(i.amount_cents), score: aggregate.score, production_hold, triage_due_on: fraud_case.triage_due_on, case_type: "fraud" }, i.at, actor));
  if (production_hold) { const h = applyProductionHold(events, fraud_case, i.at, actor); hold = h.hold; out.push(h.event); }
  return { fraud_case: { ...fraud_case, hold }, events: out, aggregate };
}
/** Commands the production hold blocks (23.3/25.2/26.3/29.3 assert): 22.6's list plus `disburse` and `submitDelivery`. */
export const PRODUCTION_HOLD_BLOCKS: readonly string[] = [...HOLD_BLOCKED_COMMANDS, "disburse", "submitDelivery"];
/** SM_FRAUD_PRODUCTION_HOLD: 22.6's `placeHold` writes the `fraud_hold` overlay `assertNoFraudHold` reads; the case id ties it to the case. */
export function applyProductionHold(events: EventStore, c: FraudCase, at: string, actor: Actor = AGENT): { hold: FraudHold; event: DomainEvent } {
  if (!c.application_id) throw new ScreeningRefused("HOLD_NEEDS_OPEN_APPLICATION", "28.4 rule 1: a case on an open application applies SM_FRAUD_PRODUCTION_HOLD", "no open application on this case (a closed loan goes to servicing/QC follow-up)");
  return placeHold(events, { application_id: c.application_id, reason: "investigation_open", case_id: c.case_id, at, detail: { blocks: PRODUCTION_HOLD_BLOCKS, process: "28.4" } }, actor);
}
export function assertNoProductionHold(c: Pick<FraudCase, "production_hold" | "triage_status"> | null | undefined, command: string): void {
  if (c?.production_hold && PRODUCTION_HOLD_BLOCKS.includes(command)) throw new ScreeningRefused("FRAUD_HOLD", "28.4 SM_FRAUD_PRODUCTION_HOLD: blocks issueCD, consummate, disburse, submitDelivery", `${command} is blocked by the open fraud case (${c.triage_status})`);
}
/** `fraud.hold.released` (22.6's name): on `not_suspicious`, or when a decision path is chosen for a suspicious case. */
export function releaseProductionHold(events: EventStore, c: FraudCase, i: { rationale: string; at: string; path: "not_suspicious" | "decision_path_chosen" }, actor: Actor = AGENT): { fraud_case: FraudCase; event: DomainEvent } {
  nonEmpty(i.rationale, "rationale");
  if (!c.production_hold) throw new RangeError(`case ${c.case_id} has no production hold`);
  if (i.path === "decision_path_chosen" && c.triage_status !== "suspicious_determined") throw new ScreeningRefused("HOLD_RELEASE_NEEDS_TRIAGE", "28.4 timer table: released by `not_suspicious`, or a decision path chosen for a suspicious case", `case is ${c.triage_status}`);
  if (i.path === "not_suspicious" && c.triage_status !== "not_suspicious") throw new ScreeningRefused("HOLD_RELEASE_NEEDS_TRIAGE", "28.4 timer table: released by `not_suspicious`, or a decision path chosen for a suspicious case", `case is ${c.triage_status}`);
  const event = emitFor(events, c, "fraud.hold.released", { reason: "investigation_open", released_by: `${actor.kind}:${actor.id}${actor.role ? ` (${actor.role})` : ""}`, path: i.path, rationale: i.rationale, blocks: PRODUCTION_HOLD_BLOCKS }, i.at, actor);
  return { fraud_case: { ...c, production_hold: false, hold: null }, event };
}
/** Investigation steps (reexamineDocuments, orderIndependentVerification, screenParty, interviewBorrower …) with evidence refs — the decision record's `investigation_steps`. */
export function recordStep(events: EventStore, c: FraudCase, s: Omit<InvestigationStep, "at"> & { at: string }, actor: Actor = AGENT): { fraud_case: FraudCase; event: DomainEvent } {
  nonEmpty(s.tool, "tool"); nonEmpty(s.source, "source"); nonEmpty(s.result, "result");
  if (!s.evidence_refs.length) throw new RangeError("an investigation step carries evidence_refs");
  if (c.triage_status === "closed") throw new RangeError(`case ${c.case_id} is closed`);
  const step: InvestigationStep = { tool: s.tool, source: s.source, result: s.result, evidence_refs: s.evidence_refs, at: s.at };
  const event = emitFor(events, c, "fraud.case.step.recorded", { ...step }, s.at, actor);
  return { fraud_case: { ...c, triage_status: c.triage_status === "open" ? "under_review" : c.triage_status, steps: [...c.steps, step] }, event };
}
/** Interviews go through the app/voice with an automation disclosure, framed as verification questions — never an accusation, never a word that reveals an investigation or a SAR (T7 scan). */
export const INTERVIEW_DISCLOSURE = "This is an automated verification conversation; you may ask to speak with a person at any time.";
export function interviewQuestionAllowed(question: string): { allowed: boolean; findings: string[] } {
  const scan = scanForSarTerms(question);
  const accusatory = /\b(fraud|forged|fake|lying|lie|fabricat)/i.exec(question)?.[0];
  return { allowed: scan.clean && !accusatory, findings: [...scan.findings, ...(accusatory ? [accusatory] : [])] };
}
export function buildTimeline(c: FraudCase, extra: readonly { at: string; what: string; evidence_refs?: readonly string[] }[] = []): { at: string; what: string; evidence_refs: readonly string[] }[] {
  const rows = [{ at: c.opened_at, what: "fraud.case.opened", evidence_refs: c.signals.flatMap((s) => s.evidence_refs) }, ...c.steps.map((s) => ({ at: s.at, what: `${s.tool}: ${s.result}`, evidence_refs: s.evidence_refs })), ...extra.map((e) => ({ at: e.at, what: e.what, evidence_refs: e.evidence_refs ?? [] }))];
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}
export function assessScheme(signals: readonly Signal[], steps: readonly InvestigationStep[] = []): { hypotheses: SchemeHypothesis[]; support: Record<string, number> } {
  const support: Record<string, number> = {};
  for (const s of signals) for (const h of Object.values(SIGNAL_INTAKE).find((r) => r.signal_code === s.signal_code)?.hypotheses ?? []) support[h] = (support[h] ?? 0) + s.score;
  for (const st of steps) for (const h of SCHEME_HYPOTHESES) if (st.result.toLowerCase().includes(h.replace(/_/g, " ")) || st.result.toLowerCase().includes(h)) support[h] = (support[h] ?? 0) + 25;
  const hypotheses = (Object.entries(support).sort((a, b) => b[1] - a[1]).map(([h]) => h) as SchemeHypothesis[]);
  return { hypotheses: hypotheses.length ? hypotheses : ["other"], support };
}
/** Rule 3 — the $5,000 test: the funds or assets involved (loan amount for origination fraud; the transaction amount for AML). */
export function computeAmount(i: { kind: "origination" | "aml"; loan_amount_cents?: bigint | null; transaction_amount_cents?: bigint | null; subject_identified?: boolean; activity_is_crime?: boolean }): { amount_cents: bigint; sar_mandatory: boolean; sar_voluntary_policy: boolean } {
  const amount_cents = i.kind === "origination" ? (i.loan_amount_cents ?? 0n) : (i.transaction_amount_cents ?? 0n);
  if (amount_cents < 0n) throw new RangeError("amount must be ≥ 0");
  const sar_mandatory = amount_cents >= SAR_THRESHOLD_CENTS;
  return { amount_cents, sar_mandatory, sar_voluntary_policy: !sar_mandatory && (i.subject_identified ?? false) && (i.activity_is_crime ?? false) };
}

// ============================================================ R2 / R4 — triage, "initial detection" and the SAR clocks
export interface TriageInput { readonly decision: "suspicious_determined" | "not_suspicious"; readonly rationale: string; readonly at: string; readonly subject_identified?: boolean; readonly requires_immediate_attention?: boolean; readonly officer_review?: { escalation_id: string; officer_id: string; at: string } | null; readonly facts_first_assembled_on?: PlainDate | null; readonly fnma_reasonable_basis?: boolean; }
/** T2 policy: once a subject is identified on the 60-day track the SAR is filed by the next business day, and never after the outer limit. */
export function subjectIdentifiedFileBy(identified_on: PlainDate, outer_limit_on: PlainDate, cal: Calendar = creditor): PlainDate { const next = nextBusinessDay(identified_on, cal); return next < outer_limit_on ? next : outer_limit_on; }
/**
 * Rule 2: the agent's recommendation becomes `suspicious_determined` only with the bsa_officer's review (the officer may set it directly);
 * `initial_detection_at` = the determination date, or the earlier date the facts were first assembled when the officer says they were
 * already conclusive (the conservative anchor — worked example 1: determined Oct 21, anchored Oct 19); immutable once set.
 */
export function recordTriage(events: EventStore, c: FraudCase, i: TriageInput, actor: Actor = AGENT): { fraud_case: FraudCase; events: DomainEvent[]; sar: ReturnType<typeof sarDeadlines> | null; within_sla: boolean } {
  nonEmpty(i.rationale, "rationale");
  if (c.triage_status === "suspicious_determined" || c.triage_status === "not_suspicious" || c.triage_status === "closed") throw new RangeError(`case ${c.case_id} is already ${c.triage_status}`);
  if (c.initial_detection_at) throw new ScreeningRefused("INITIAL_DETECTION_IMMUTABLE", "28.4 state machine: `initial_detection_at` is immutable once set", `already ${c.initial_detection_at}`);
  const officer = isHumanRole(actor, ["bsa_officer"]);
  if (i.decision === "suspicious_determined" && !officer && !i.officer_review) throw new ScreeningRefused("TRIAGE_NEEDS_OFFICER_REVIEW", "28.4 guardrail: never sets `initial_detection_at` without officer review", "suspicious_determined requires the bsa_officer's review (escalation) or the officer's own act");
  if (i.decision === "suspicious_determined" && i.subject_identified === undefined) throw new RangeError("subject_identified is required on suspicious_determined");
  const on = civil(i.at); const within_sla = on <= c.triage_due_on;
  const out: DomainEvent[] = [emitFor(events, c, "fraud.case.triaged", { triage_status: i.decision, rationale: i.rationale, triaged_on: on, within_sla, officer_reviewed: officer || !!i.officer_review, reviewed_by: officer ? actor.id : i.officer_review?.officer_id ?? null }, i.at, actor)];
  if (i.decision === "not_suspicious") {
    const fraud_case: FraudCase = { ...c, triage_status: "not_suspicious", triage_rationale: i.rationale, decision_reasons_for_no_sar: i.rationale };
    return { fraud_case, events: out, sar: null, within_sla };
  }
  const anchor = i.facts_first_assembled_on && i.facts_first_assembled_on < on ? i.facts_first_assembled_on : on;
  const subject_identified = i.subject_identified === true;
  const sar = sarDeadlines(anchor, subject_identified);
  const requires_immediate_attention = i.requires_immediate_attention === true;
  const fnma_reasonable_basis_at = i.fnma_reasonable_basis ? on : null;
  const fraud_case: FraudCase = { ...c, triage_status: "suspicious_determined", triage_rationale: i.rationale, initial_detection_at: anchor, subject_identified, requires_immediate_attention, fnma_reasonable_basis_at };
  out.push(emitFor(events, c, "fraud.suspicious.determined", { initial_detection_at: anchor, determined_on: on, subject_identified, requires_immediate_attention, amount_cents: String(c.amount_cents), filing_due_on: sar.filing_due_on, outer_limit_on: sar.outer_limit_on, policy_file_by: sar.policy_file_by, scheme_hypotheses: c.scheme_hypotheses }, i.at, actor));
  return { fraud_case, events: out, sar, within_sla };
}
/** §1029.320(b)(3) last sentence: immediate telephone notice for matters requiring immediate attention — the bsa_officer, or the agent with the officer paged simultaneously. */
export function notifyLawEnforcement(events: EventStore, c: FraudCase, i: { agency: string; method: "telephone"; at: string; officer_paged?: boolean }, actor: Actor): { fraud_case: FraudCase; event: DomainEvent } {
  nonEmpty(i.agency, "agency");
  if (!isHumanRole(actor, ["bsa_officer"]) && !(c.requires_immediate_attention && i.officer_paged)) throw new ScreeningRefused("LE_CONTACT_NEEDS_OFFICER", "28.4 guardrail: never contacts law enforcement without the officer except the immediate-attention protocol (officer paged simultaneously)", "law enforcement is notified by the bsa_officer, or by the agent under the immediate-attention protocol with the officer paged");
  const event = emitFor(events, c, "law_enforcement.notified", { agency: i.agency, method: i.method, notified_at: i.at, notified_by: `${actor.kind}:${actor.id}`, officer_paged: i.officer_paged ?? false }, i.at, actor);
  return { fraud_case: { ...c, law_enforcement_notified_at: i.at }, event };
}
/** `closed` requires a sar_decisions row (file or no_file with rationale) — the last guard of the state machine. */
export function closeCase(events: EventStore, c: FraudCase, i: { sar_decision: SarDecision | null; at: string; outcome: string }, actor: Actor = AGENT): { fraud_case: FraudCase; event: DomainEvent } {
  if (c.triage_status !== "suspicious_determined" && c.triage_status !== "not_suspicious") throw new RangeError(`case ${c.case_id} is ${c.triage_status}; triage first`);
  if (!i.sar_decision || i.sar_decision.case_id !== c.case_id) throw new ScreeningRefused("CLOSE_NEEDS_SAR_DECISION", "28.4 state machine: `closed` requires `sar_decisions` present (file or no_file with rationale)", "no sar_decisions row for this case");
  const event = emitFor(events, c, "fraud.case.closed", { outcome: i.outcome, sar_decision: i.sar_decision.decision, decision_id: i.sar_decision.decision_id, closed_at: i.at }, i.at, actor);
  return { fraud_case: { ...c, triage_status: "closed", closed_at: i.at, production_hold: false, hold: null }, event };
}

// ============================================================ the SAR (sars / sar_decisions; sar_confidentiality_acl)
export type SarStatus = "draft" | "officer_review" | "approved" | "filed" | "acknowledged" | "rejected" | "no_file";
export type SarFiler = "partner" | "sm" | "joint";
export type FilingChannel = "discrete" | "batch_xml" | "sdtm";
export const SAR_RETENTION_YEARS = 5;
export const OFFICER_DECISION_SLA_DAYS = 5;
export const OFFICER_DECISION_BUFFER_DAYS = 3;
export const CONTINUING_REVIEW_DAYS = 90;
export const CONTINUING_FILING_DAYS = 120;
export const NARRATIVE_ELEMENTS = ["who", "what", "when", "where", "why", "how"] as const;
export interface Sar {
  readonly sar_id: string; readonly case_id: string; readonly application_id: string | null; readonly loan_id: string | null; readonly filer: SarFiler; readonly filing_org_ein_ref: string;
  readonly subjects: readonly Record<string, unknown>[]; readonly activity: Record<string, unknown>; readonly narrative_document_id: string; readonly narrative_hash: string; readonly narrative_officer_edited: boolean;
  readonly supporting_documents: readonly string[]; readonly due_on: PlainDate; readonly outer_limit_on: PlainDate; readonly officer_decision_due_on: PlainDate; readonly continuing_activity_of: string | null;
  readonly drafted_at: string; readonly filed_at: string | null; readonly filed_on: PlainDate | null; readonly bsa_id: string | null; readonly filing_channel: FilingChannel; readonly officer_id: string | null;
  readonly officer_decision: "file" | "no_file" | null; readonly officer_decided_at: string | null; readonly status: SarStatus; readonly retention_until: PlainDate | null; readonly acl: "sar_confidentiality_acl"; readonly amended_from_bsa_id: string | null;
}
export interface SarDecision { readonly decision_id: string; readonly case_id: string; readonly sar_id: string | null; readonly decision: "file" | "no_file" | "continuing_review"; readonly rationale: string; readonly decided_by: string; readonly decided_at: string; readonly review_period_days: number | null; readonly next_review_due_at: PlainDate | null; }
/** SM_BSA_OFFICER_SAR_DECISION_SLA_5: +5 calendar days from the draft, and never past the SAR deadline − 3 days. */
export function officerDecisionDue(drafted_on: PlainDate, sar_due_on: PlainDate): PlainDate { const sla = addDays(drafted_on, OFFICER_DECISION_SLA_DAYS); const cap = addDays(sar_due_on, -OFFICER_DECISION_BUFFER_DAYS); return sla < cap ? sla : cap; }
export function sarRetentionUntil(filed_on: PlainDate): PlainDate { return addYears(filed_on, SAR_RETENTION_YEARS); }
/** The narrative is drafted from the case record (who/what/when/where/why/how, §1029.320(b)(2)); only its document id and hash leave the compartment. */
export function draftNarrative(c: FraudCase, elements: Partial<Record<(typeof NARRATIVE_ELEMENTS)[number], string>>): { narrative_hash: string; missing_elements: string[]; elements: Record<string, string> } {
  const missing = NARRATIVE_ELEMENTS.filter((k) => !elements[k] || !elements[k]!.trim());
  const filled = Object.fromEntries(NARRATIVE_ELEMENTS.filter((k) => !missing.includes(k)).map((k) => [k, elements[k]!]));
  return { narrative_hash: sha256(JSON.stringify({ case_id: c.case_id, ...filled })), missing_elements: [...missing], elements: filled };
}
export interface DraftSarInput { readonly filer: SarFiler; readonly filing_org_ein_ref: string; readonly subjects: readonly Record<string, unknown>[]; readonly activity: Record<string, unknown>; readonly narrative_document_id: string; readonly narrative_hash: string; readonly supporting_documents: readonly string[]; readonly filing_channel?: FilingChannel; readonly continuing_activity_of?: Sar | null; readonly at: string; }
/** `sar.drafted` (arms SM_BSA_OFFICER_SAR_DECISION_SLA_5); due 30/60 days from `initial_detection_at`, or prior `filed_on` + 120 for continuing activity. */
export function draftSar(events: EventStore, c: FraudCase, i: DraftSarInput, actor: Actor = AGENT): { sar: Sar; event: DomainEvent; escalation: { kind: "bsa_officer"; payload: Record<string, unknown> } } {
  nonEmpty(i.filing_org_ein_ref, "filing_org_ein_ref"); nonEmpty(i.narrative_document_id, "narrative_document_id"); nonEmpty(i.narrative_hash, "narrative_hash");
  if (c.triage_status !== "suspicious_determined" || !c.initial_detection_at) throw new ScreeningRefused("SAR_NEEDS_DETERMINATION", "28.4 state machine: SAR drafting starts at `suspicious_determined`", `case ${c.case_id} is ${c.triage_status}`);
  if (i.continuing_activity_of && i.continuing_activity_of.status !== "acknowledged") throw new RangeError("a continuing-activity SAR follows an acknowledged SAR");
  const prior = i.continuing_activity_of ?? null;
  const dl = sarDeadlines(c.initial_detection_at, c.subject_identified === true);
  const due_on = prior?.filed_on ? addDays(prior.filed_on, CONTINUING_FILING_DAYS) : dl.filing_due_on;
  const drafted_on = civil(i.at);
  const sar: Sar = { sar_id: randomUUID(), case_id: c.case_id, application_id: c.application_id, loan_id: c.loan_id, filer: i.filer, filing_org_ein_ref: i.filing_org_ein_ref, subjects: i.subjects, activity: i.activity, narrative_document_id: i.narrative_document_id, narrative_hash: i.narrative_hash, narrative_officer_edited: false,
    supporting_documents: i.supporting_documents, due_on, outer_limit_on: prior ? due_on : dl.outer_limit_on, officer_decision_due_on: officerDecisionDue(drafted_on, due_on), continuing_activity_of: prior?.sar_id ?? null, drafted_at: i.at, filed_at: null, filed_on: null, bsa_id: null, filing_channel: i.filing_channel ?? "discrete", officer_id: null, officer_decision: null, officer_decided_at: null, status: "officer_review", retention_until: null, acl: "sar_confidentiality_acl", amended_from_bsa_id: null };
  const event = emitFor(events, c, "sar.drafted", { sar_id: sar.sar_id, filer: sar.filer, due_on, officer_decision_due_on: sar.officer_decision_due_on, drafted_at: i.at, narrative_hash: i.narrative_hash, continuing_activity_of: sar.continuing_activity_of, acl: sar.acl }, i.at, actor);
  return { sar, event, escalation: { kind: "bsa_officer", payload: { sar_id: sar.sar_id, case_id: c.case_id, due_on, officer_decision_due_on: sar.officer_decision_due_on } } };
}
/** The bsa_officer's decision (file / no_file) inside SM_BSA_OFFICER_SAR_DECISION_SLA_5; `file` requires the officer-edited narrative; every no_file carries its rationale in sar_decisions. */
export function officerSarDecision(events: EventStore, c: FraudCase, sar: Sar, i: { decision: "file" | "no_file"; rationale: string; narrative_edited?: boolean; at: string }, actor: Actor): { sar: Sar; decision: SarDecision; events: DomainEvent[] } {
  nonEmpty(i.rationale, "rationale");
  if (!isHumanRole(actor, ["bsa_officer"])) throw new ScreeningRefused("SAR_DECISION_IS_BSA_OFFICER_ACT", "28.4 automation class: the bsa_officer decides and files the SAR; nothing is filed without the human decision", `${actor.kind}:${actor.id} cannot decide a SAR`);
  if (sar.status !== "officer_review" && sar.status !== "draft" && sar.status !== "rejected") throw new RangeError(`SAR ${sar.sar_id} is ${sar.status}`);
  if (i.decision === "file" && !i.narrative_edited) throw new ScreeningRefused("NARRATIVE_NOT_OFFICER_EDITED", "28.4 guardrail: every narrative is officer-edited before filing", "the officer edits and approves the narrative before filing");
  const on = civil(i.at);
  const decision: SarDecision = { decision_id: randomUUID(), case_id: c.case_id, sar_id: sar.sar_id, decision: i.decision, rationale: i.rationale, decided_by: actor.id, decided_at: i.at, review_period_days: null, next_review_due_at: null };
  const next: Sar = { ...sar, status: i.decision === "file" ? "approved" : "no_file", officer_id: actor.id, officer_decision: i.decision, officer_decided_at: i.at, narrative_officer_edited: i.narrative_edited === true };
  const out = [emitFor(events, c, "sar.officer_decision", { sar_id: sar.sar_id, decision: i.decision, decided_at: i.at, decided_on: on, within_sla: on <= sar.officer_decision_due_on, decision_id: decision.decision_id, continuing_activity_of: sar.continuing_activity_of }, i.at, actor)];
  if (i.decision === "no_file" && sar.continuing_activity_of) out.push(emitFor(events, c, "sar.continuing_review.concluded", { sar_id: sar.sar_id, prior_sar_id: sar.continuing_activity_of, outcome: "no_file", decision_id: decision.decision_id }, i.at, actor));
  return { sar: next, decision, events: out };
}
/** `sar.filed` — the officer's act (discrete: the officer submits; batch: the officer's approval is the filing decision). Late → a late-filing memo in the SAR file; retention = filed_on + 5 years (`bsa_sar_5y`). */
export function fileSar(events: EventStore, c: FraudCase, sar: Sar, i: { at: string; filing_channel?: FilingChannel; amended_from_bsa_id?: string | null }, actor: Actor): { sar: Sar; events: DomainEvent[]; late: boolean; late_filing_memo_required: boolean } {
  if (!isHumanRole(actor, ["bsa_officer"])) throw new ScreeningRefused("SAR_FILING_IS_BSA_OFFICER_ACT", "28.4 guardrail: never files a SAR, OFAC report or Fannie Mae report (human acts only); timer table: `sar.filed` (officer act)", `${actor.kind}:${actor.id} cannot file a SAR`);
  if (sar.status !== "approved" && sar.status !== "rejected") throw new ScreeningRefused("SAR_NOT_APPROVED", "28.4 state machine: officer_review → approved → filed", `SAR ${sar.sar_id} is ${sar.status}`);
  if (sar.officer_decision !== "file") throw new RangeError("the officer decision is not `file`");
  const filed_on = civil(i.at); const late = filed_on > sar.due_on;
  const retention_until = sarRetentionUntil(filed_on);
  const next: Sar = { ...sar, status: "filed", filed_at: i.at, filed_on, filing_channel: i.filing_channel ?? sar.filing_channel, retention_until, amended_from_bsa_id: i.amended_from_bsa_id ?? sar.amended_from_bsa_id };
  const out = [emitFor(events, c, "sar.filed", { sar_id: sar.sar_id, filed_at: i.at, filed_on, due_on: sar.due_on, late, filing_channel: next.filing_channel, filer: sar.filer, continuing_activity_of: sar.continuing_activity_of, amended_from_bsa_id: next.amended_from_bsa_id, retention_until, retention_class: "bsa_sar_5y", officer_act: true, filed_by: actor.id }, i.at, actor)];
  if (sar.continuing_activity_of) out.push(emitFor(events, c, "sar.continuing_review.concluded", { sar_id: sar.sar_id, prior_sar_id: sar.continuing_activity_of, outcome: "filed", filed_on }, i.at, actor));
  return { sar: next, events: out, late, late_filing_memo_required: late };
}
/** BSA E-Filing acknowledgement (BSA ID) or validation rejection (correct and re-file the same day; the original deadline governs). */
export function acknowledgeSar(events: EventStore, c: FraudCase, sar: Sar, i: { bsa_id: string; activity_continues: boolean; at: string }, actor: Actor): { sar: Sar; event: DomainEvent } {
  nonEmpty(i.bsa_id, "bsa_id");
  if (sar.status !== "filed" || !sar.filed_on) throw new RangeError(`SAR ${sar.sar_id} is ${sar.status}, not filed`);
  const next: Sar = { ...sar, status: "acknowledged", bsa_id: i.bsa_id };
  const event = emitFor(events, c, "sar.acknowledged", { sar_id: sar.sar_id, bsa_id: i.bsa_id, filed_on: sar.filed_on, filed_at: sar.filed_at, activity_continues: i.activity_continues, acknowledged_at: i.at }, i.at, actor);
  return { sar: next, event };
}
export function rejectSar(events: EventStore, c: FraudCase, sar: Sar, i: { validation_errors: readonly string[]; at: string }, actor: Actor): { sar: Sar; event: DomainEvent; refile_by: PlainDate } {
  if (sar.status !== "filed") throw new RangeError(`SAR ${sar.sar_id} is ${sar.status}, not filed`);
  const on = civil(i.at);
  const event = emitFor(events, c, "sar.rejected", { sar_id: sar.sar_id, validation_errors: i.validation_errors, rejected_on: on, refile_by: on, original_due_on: sar.due_on }, i.at, actor);
  return { sar: { ...sar, status: "rejected", filed_at: null, filed_on: null, retention_until: null }, event, refile_by: on };
}
/** Continuing activity (policy — FinCEN SAR FAQ Oct 9, 2025): 90-day review from `filed_on`, continuing SAR due +120 (BSA_1029_320_SAR_CONTINUING_120). */
export function continuingReviewDates(filed_on: PlainDate): { review_due_on: PlainDate; continuing_due_on: PlainDate } { return { review_due_on: addDays(filed_on, CONTINUING_REVIEW_DAYS), continuing_due_on: addDays(filed_on, CONTINUING_FILING_DAYS) }; }
export function scheduleContinuingReview(events: EventStore, c: FraudCase, sar: Sar, i: { at: string; rationale?: string }, actor: Actor = AGENT): { decision: SarDecision; event: DomainEvent; review_due_on: PlainDate; continuing_due_on: PlainDate } {
  if (sar.status !== "acknowledged" || !sar.filed_on) throw new ScreeningRefused("CONTINUING_REVIEW_NEEDS_ACKNOWLEDGED_SAR", "28.4 state machine: acknowledged → continuing_review.scheduled", `SAR ${sar.sar_id} is ${sar.status}`);
  const d = continuingReviewDates(sar.filed_on);
  const decision: SarDecision = { decision_id: randomUUID(), case_id: c.case_id, sar_id: sar.sar_id, decision: "continuing_review", rationale: i.rationale ?? "activity continues after filing; 90-day review scheduled (policy)", decided_by: `${actor.kind}:${actor.id}`, decided_at: i.at, review_period_days: CONTINUING_REVIEW_DAYS, next_review_due_at: d.review_due_on };
  const event = emitFor(events, c, "sar.continuing_review.scheduled", { sar_id: sar.sar_id, filed_on: sar.filed_on, review_due_on: d.review_due_on, continuing_due_on: d.continuing_due_on, review_period_days: CONTINUING_REVIEW_DAYS, decision_id: decision.decision_id }, i.at, actor);
  return { decision, event, ...d };
}
/** Subject identified after a 60-day-track filing with unknown subject: amended SAR within 30 days of identification (policy), referencing the prior BSA ID. */
export function amendedSarDue(identified_on: PlainDate): PlainDate { return addDays(identified_on, 30); }

// ---- R9 — confidentiality boundary
export const SAR_COMPARTMENT_ROLES: readonly string[] = ["bsa_officer"];
export interface SarAccessContext { readonly filing_orgs: readonly ("partner" | "sm")[]; readonly actor_org: "partner" | "sm" | "other"; readonly joint_filing?: boolean; readonly same_corporate_structure?: boolean; }
/** Only the filing organization's bsa_officer(s) and the fraud-risk agent's SAR-preparation identity read the compartment; the other organization only under a joint filing or one corporate structure. */
export function sarAccessAllowed(actor: Actor, ctx: SarAccessContext): { allowed: boolean; reason: string } {
  if (actor.kind === "agent") return actor.id === "fraud-risk" ? { allowed: true, reason: "fraud-risk SAR-preparation identity" } : { allowed: false, reason: `agent ${actor.id} is outside sar_confidentiality_acl` };
  if (!isHumanRole(actor, SAR_COMPARTMENT_ROLES)) return { allowed: false, reason: `${actor.role ?? actor.kind} is outside sar_confidentiality_acl (only bsa_officer roles of the filing organization)` };
  if (ctx.actor_org === "other") return { allowed: false, reason: "outside both organizations" };
  if (ctx.filing_orgs.includes(ctx.actor_org) || ctx.joint_filing || ctx.same_corporate_structure) return { allowed: true, reason: "bsa_officer of the filing organization" };
  return { allowed: false, reason: "the other organization's staff without a joint filing (§1029.320(d))" };
}
export function querySars(events: EventStore, actor: Actor, ctx: SarAccessContext, sars: readonly Sar[], at: string): Sar[] {
  const a = sarAccessAllowed(actor, ctx);
  if (!a.allowed) {
    events.append({ type: "sar.access.denied", aggregate: { kind: "sar_compartment", id: "sar_confidentiality_acl" }, actor, occurredAt: at, payload: { actor: `${actor.kind}:${actor.id}${actor.role ? ` (${actor.role})` : ""}`, actor_org: ctx.actor_org, reason: a.reason, logged: true, source: "origination" } });
    throw new ScreeningRefused("SAR_ACCESS_DENIED", "31 CFR 1029.320(d); 28.4 rule 9 (sar_confidentiality_acl)", a.reason);
  }
  return [...sars];
}
/** A subpoena for SAR material: "decline to produce" and notify FinCEN (§1029.320(d)) — a task for the bsa_officer and counsel. */
export function subpoenaForSarMaterial(events: EventStore, i: { subpoena_id: string; issuer: string; received_at: string }, actor: Actor): { response: "decline to produce"; tasks: { kind: "bsa_officer"; task: "notify_fincen"; payload: Record<string, unknown> }[]; event: DomainEvent } {
  nonEmpty(i.subpoena_id, "subpoena_id"); nonEmpty(i.issuer, "issuer");
  const event = events.append({ type: "sar.subpoena.received", aggregate: { kind: "sar_compartment", id: "sar_confidentiality_acl" }, actor, occurredAt: i.received_at, payload: { subpoena_id: i.subpoena_id, issuer: i.issuer, response: "decline_to_produce", fincen_notification_task: "bsa_officer", counsel: true, source: "origination" } });
  return { response: "decline to produce", tasks: [{ kind: "bsa_officer", task: "notify_fincen", payload: { subpoena_id: i.subpoena_id, issuer: i.issuer, citation: "31 CFR 1029.320(d)", with: "counsel" } }], event };
}
/** The §1029.320(c) arithmetic behind 31.3's disposal gate BSA_1029_320C_SAR_RETENTION_5Y (evaluators-31-3.ts owns the registry key): opens 5 years from filing (unless a legal hold). */
export function sarRetentionGate(f: Record<string, unknown>): GateResult {
  if (f.legal_hold === true) return { open: false, reason: "legal hold on the SAR file" };
  const filed = typeof f.filed_on === "string" ? f.filed_on : null; const today = typeof f.today === "string" ? f.today : null;
  if (!filed || !today) return { open: false, reason: "filed_on and today are required (§1029.320(c): five years from the date of filing)" };
  const until = sarRetentionUntil(plainDate(filed));
  return today >= until ? { open: true } : { open: false, reason: `SAR retained until ${until} (§1029.320(c))` };
}

// ============================================================ R6 — OFAC hits, blocked property, rejected transactions, reports
export type OfacList = "sdn" | "non_sdn_consolidated";
export type HitDisposition = "potential" | "false_positive" | "confirmed_match";
export type OfacReportKind = "blocked_initial" | "unblocking" | "rejected_transaction" | "annual_blocked";
/** Match scores at or above this need the bsa_officer to clear as a false positive (policy: documented threshold). */
export const OFAC_AUTO_CLEAR_MAX_SCORE = 85;
export const OFAC_RETENTION_YEARS = 10;
export interface OfacHit {
  readonly hit_id: string; readonly screening_id: string; readonly party_id: string; readonly application_id: string | null; readonly loan_id: string | null; readonly list: OfacList; readonly entry_uid: string; readonly match_score: number; readonly match_fields: readonly string[];
  readonly disposition: HitDisposition; readonly dispositioned_by: string | null; readonly dispositioned_at: string | null; readonly analysis: string | null;
  readonly blocked_property: { description: string; value_cents: bigint; blocked_on: PlainDate; location: string; account_ref: string } | null; readonly rejected_transaction: { description: string; value_cents: bigint; rejected_on: PlainDate; counterparties: readonly string[] } | null;
  readonly unblocked_on: PlainDate | null; readonly retention_until: PlainDate | null;
}
const hitRef = (h: Pick<OfacHit, "hit_id" | "application_id" | "loan_id">): CaseRef => ({ case_id: h.hit_id, application_id: h.application_id, loan_id: h.loan_id });
export function recordOfacHit(events: EventStore, i: { screening_id: string; party_id: string; application_id?: string | null; loan_id?: string | null; list: OfacList; entry_uid: string; match_score: number; match_fields: readonly string[]; at: string }, actor: Actor = AGENT): { hit: OfacHit; event: DomainEvent } {
  nonEmpty(i.screening_id, "screening_id"); nonEmpty(i.party_id, "party_id"); nonEmpty(i.entry_uid, "entry_uid");
  if (!(i.match_score >= 0 && i.match_score <= 100)) throw new RangeError("match_score is 0..100");
  const hit: OfacHit = { hit_id: randomUUID(), screening_id: i.screening_id, party_id: i.party_id, application_id: i.application_id ?? null, loan_id: i.loan_id ?? null, list: i.list, entry_uid: i.entry_uid, match_score: i.match_score, match_fields: i.match_fields, disposition: "potential", dispositioned_by: null, dispositioned_at: null, analysis: null, blocked_property: null, rejected_transaction: null, unblocked_on: null, retention_until: null };
  const event = emitFor(events, hitRef(hit), "ofac.hit.recorded", { hit_id: hit.hit_id, screening_id: i.screening_id, party_id: i.party_id, list: i.list, entry_uid: i.entry_uid, match_score: i.match_score, match_fields: i.match_fields, disposition: "potential" }, i.at, actor);
  return { hit, event };
}
export interface DispositionInput { readonly disposition: "false_positive" | "confirmed_match"; readonly analysis: string; readonly at: string; readonly blocked_property?: { description: string; value_cents: bigint; location: string; account_ref: string } | null; readonly rejected_transaction?: { description: string; value_cents: bigint; counterparties: readonly string[] } | null; }
/** `false_positive` needs a written analysis (the bsa_officer above the auto-clear score); `confirmed_match` is the bsa_officer's and yields a blocked payment (`ofac.property.blocked`) or a refused wire (`ofac.transaction.rejected`) — 22.6's event names and anchor fields. */
export function dispositionOfacHit(events: EventStore, hit: OfacHit, i: DispositionInput, actor: Actor = AGENT): { hit: OfacHit; events: DomainEvent[]; report_due_on: PlainDate | null; report_kind: OfacReportKind | null; ledger: EntrySetInput | null } {
  nonEmpty(i.analysis, "analysis");
  if (hit.disposition !== "potential") throw new RangeError(`hit ${hit.hit_id} is already ${hit.disposition}`);
  const officer = isHumanRole(actor, ["bsa_officer"]);
  if (i.disposition === "false_positive" && hit.match_score >= OFAC_AUTO_CLEAR_MAX_SCORE && !officer) throw new ScreeningRefused("OFAC_CLEAR_NEEDS_BSA_OFFICER", "28.4 state machine: `bsa_officer` for scores above the auto-clear threshold", `score ${hit.match_score} ≥ ${OFAC_AUTO_CLEAR_MAX_SCORE}`);
  if (i.disposition === "confirmed_match" && !officer) throw new ScreeningRefused("OFAC_CONFIRM_NEEDS_BSA_OFFICER", "28.4 AI design: OFAC dispositions above threshold and all confirmed matches are the bsa_officer's", "a confirmed match is the bsa_officer's determination");
  const by = `${actor.kind}:${actor.id}`; const on = civil(i.at, federal);
  const ref = hitRef(hit);
  if (i.disposition === "false_positive") {
    const next: OfacHit = { ...hit, disposition: "false_positive", dispositioned_by: by, dispositioned_at: i.at, analysis: i.analysis, retention_until: ofacRecordsRetainedUntil(on) };
    return { hit: next, events: [emitFor(events, ref, "ofac.hit.dispositioned", { hit_id: hit.hit_id, party_id: hit.party_id, disposition: "false_positive", match_score: hit.match_score, analysis_recorded: true, retention_class: "ofac_records_10y" }, i.at, actor)], report_due_on: null, report_kind: null, ledger: null };
  }
  if (!i.blocked_property && !i.rejected_transaction) throw new RangeError("a confirmed match is a blocked property (funds held) or a rejected transaction (wire refused)");
  const out: DomainEvent[] = [emitFor(events, ref, "ofac.hit.dispositioned", { hit_id: hit.hit_id, party_id: hit.party_id, disposition: "confirmed_match", match_score: hit.match_score, analysis_recorded: true, retention_class: "ofac_records_10y" }, i.at, actor)];
  const report_due_on = ofacReportDue(on);
  if (i.blocked_property) {
    const bp = { ...i.blocked_property, blocked_on: on };
    const next: OfacHit = { ...hit, disposition: "confirmed_match", dispositioned_by: by, dispositioned_at: i.at, analysis: i.analysis, blocked_property: bp, retention_until: null };
    out.push(emitFor(events, ref, "ofac.property.blocked", { hit_id: hit.hit_id, screening_id: hit.screening_id, party_id: hit.party_id, blocked_on: on, blocked_date: on, value_cents: String(bp.value_cents), description: bp.description, location: bp.location, account_ref: bp.account_ref, report_due_on, retention_class: "ofac_records_10y", retention_until: null }, i.at, actor));
    return { hit: next, events: out, report_due_on, report_kind: "blocked_initial", ledger: blockedFundsPosting({ value_cents: bp.value_cents, effective_on: on, account_ref: bp.account_ref, hit_id: hit.hit_id }) };
  }
  const rt = { ...i.rejected_transaction!, rejected_on: on };
  const next: OfacHit = { ...hit, disposition: "confirmed_match", dispositioned_by: by, dispositioned_at: i.at, analysis: i.analysis, rejected_transaction: rt, retention_until: ofacRecordsRetainedUntil(on) };
  out.push(emitFor(events, ref, "ofac.transaction.rejected", { hit_id: hit.hit_id, screening_id: hit.screening_id, party_id: hit.party_id, rejected_on: on, rejection_date: on, value_cents: String(rt.value_cents), description: rt.description, counterparties: rt.counterparties, report_due_on, retention_class: "ofac_records_10y", retention_until: next.retention_until }, i.at, actor));
  return { hit: next, events: out, report_due_on, report_kind: "rejected_transaction", ledger: null };
}
/**
 * Ledger (Outputs): the blocked payment leaves the settlement flow for the blocked interest-bearing account (rule 6; §501.603).
 * The kernel ledger's account list has no `blocked_property_liability` account, so the movement is booked between the two
 * custodial cash accounts (settlement flow → blocked account) with the liability named on the rule_ref / memo — a balanced set.
 */
export const SETTLEMENT_FLOW_ACCOUNT = "settlement-flow";
export function blockedFundsPosting(i: { value_cents: bigint; effective_on: PlainDate; account_ref: string; hit_id: string; settlement_account?: string }): EntrySetInput {
  if (i.value_cents <= 0n) throw new RangeError("blocked funds must be positive");
  const ruleRef = "28.4 rule 6; 31 CFR 501.603 (blocked interest-bearing account; blocked_property_liability)";
  return { effectiveDate: i.effective_on, description: `OFAC blocked payment ${i.hit_id} → blocked account ${i.account_ref}`, lines: [
    { account: { scope: "custodial", custodialAccountId: i.account_ref, account: "clearing_cash" }, amountCents: i.value_cents, ruleRef, memo: "blocked_property_asset (interest-bearing blocked account)" },
    { account: { scope: "custodial", custodialAccountId: i.settlement_account ?? SETTLEMENT_FLOW_ACCOUNT, account: "clearing_cash" }, amountCents: -i.value_cents, ruleRef, memo: "blocked_property_liability: funds designated for the blocked payee held out of the settlement flow" },
  ] };
}
/** §501.603(b)(3): unblocking (licence or delisting) starts the 10-business-day unblocking report clock; the 10-year retention runs from this date. */
export function unblockProperty(events: EventStore, hit: OfacHit, i: { unblocked_on: PlainDate; authority: string; at: string }, actor: Actor): { hit: OfacHit; event: DomainEvent; report_due_on: PlainDate } {
  if (!isHumanRole(actor, ["bsa_officer"])) throw new ScreeningRefused("UNBLOCK_NEEDS_BSA_OFFICER", "28.4 state machine: unblocking report if licensed/unblocked — the bsa_officer records it", "unblocking is recorded by the bsa_officer");
  if (!hit.blocked_property || hit.unblocked_on) throw new RangeError(`hit ${hit.hit_id} holds no blocked property (or is already unblocked)`);
  nonEmpty(i.authority, "authority");
  const report_due_on = ofacReportDue(i.unblocked_on);
  const event = emitFor(events, hitRef(hit), "ofac.property.unblocked", { hit_id: hit.hit_id, party_id: hit.party_id, unblocked_on: i.unblocked_on, authority: i.authority, report_due_on }, i.at, actor);
  return { hit: { ...hit, unblocked_on: i.unblocked_on }, event, report_due_on };
}
export function annualBlockedReportDue(as_of: PlainDate): PlainDate { const { y } = parts(as_of); const sept30 = ymd(y, 9, 30); return as_of <= ymd(y, 6, 30) ? sept30 : ymd(y + 1, 9, 30); }
export function annualReportRequired(hit: OfacHit, june30: PlainDate): boolean { return !!hit.blocked_property && hit.blocked_property.blocked_on <= june30 && (!hit.unblocked_on || hit.unblocked_on > june30); }
export interface OfacReport { readonly report_id: string; readonly hit_id: string; readonly kind: OfacReportKind; readonly due_on: PlainDate; readonly submitted_at: string; readonly submitted_on: PlainDate; readonly ors_reference: string; readonly content_document_id: string; readonly officer_id: string; readonly retention_until: PlainDate; readonly late: boolean; }
/** `ofac.report.submitted{kind}` through ORS by the bsa_officer; the unblocking report is the only act that sets the blocked record's `retention_until` (§501.601: blocked + 10 years after unblocking). */
export function submitOfacReport(events: EventStore, hit: OfacHit, i: { kind: OfacReportKind; ors_reference: string; content_document_id: string; at: string; due_on?: PlainDate | null }, actor: Actor): { report: OfacReport; hit: OfacHit; event: DomainEvent } {
  if (!isHumanRole(actor, ["bsa_officer"])) throw new ScreeningRefused("OFAC_REPORT_IS_BSA_OFFICER_ACT", "28.4 guardrail: never files a SAR, OFAC report or Fannie Mae report (human acts only)", `${actor.kind}:${actor.id} cannot submit an OFAC report`);
  nonEmpty(i.ors_reference, "ors_reference"); nonEmpty(i.content_document_id, "content_document_id");
  if (hit.disposition !== "confirmed_match") throw new RangeError(`hit ${hit.hit_id} is ${hit.disposition}; only confirmed matches are reported`);
  const submitted_on = civil(i.at, federal);
  let due_on: PlainDate;
  if (i.due_on) due_on = i.due_on;
  else if (i.kind === "blocked_initial") { if (!hit.blocked_property) throw new RangeError("no blocked property"); due_on = ofacReportDue(hit.blocked_property.blocked_on); }
  else if (i.kind === "rejected_transaction") { if (!hit.rejected_transaction) throw new RangeError("no rejected transaction"); due_on = ofacReportDue(hit.rejected_transaction.rejected_on); }
  else if (i.kind === "unblocking") { if (!hit.unblocked_on) throw new RangeError("property is not unblocked"); due_on = ofacReportDue(hit.unblocked_on); }
  else { if (!hit.blocked_property) throw new RangeError("no blocked property"); due_on = annualBlockedReportDue(submitted_on); }
  const hitRetention = i.kind === "unblocking" && hit.unblocked_on ? ofacRecordsRetainedUntil(hit.unblocked_on) : hit.retention_until;
  const report: OfacReport = { report_id: randomUUID(), hit_id: hit.hit_id, kind: i.kind, due_on, submitted_at: i.at, submitted_on, ors_reference: i.ors_reference, content_document_id: i.content_document_id, officer_id: actor.id, retention_until: addYears(submitted_on, OFAC_RETENTION_YEARS), late: submitted_on > due_on };
  const next: OfacHit = { ...hit, retention_until: hitRetention };
  const event = emitFor(events, hitRef(hit), "ofac.report.submitted", { report_id: report.report_id, hit_id: hit.hit_id, kind: i.kind, ors_reference: i.ors_reference, submitted_on, due_on, late: report.late, retention_until: hitRetention, records_retention_class: "ofac_records_10y", channel: "OFAC Reporting System (ORS)" }, i.at, actor);
  return { report, hit: next, event };
}
/** The §501.601 arithmetic behind 31.3's disposal gate OFAC_501_601_RETENTION_10Y (evaluators-31-3.ts owns the registry key): 10 years from the transaction; blocked property: closed until unblocked, then 10 years from the unblocking date. */
export function ofacRetentionGate(f: Record<string, unknown>): GateResult {
  const today = typeof f.today === "string" ? f.today : null; if (!today) return { open: false, reason: "today is required" };
  if (f.record_kind === "blocked_property") {
    const unblocked = typeof f.unblocked_on === "string" ? f.unblocked_on : null;
    if (!unblocked) return { open: false, reason: "blocked property: retained for as long as it stays blocked plus 10 years after the unblocking date (§501.601)" };
    const until = ofacRecordsRetainedUntil(plainDate(unblocked)); return today >= until ? { open: true } : { open: false, reason: `retained until ${until} (unblocked ${unblocked} + 10 years)` };
  }
  const tx = typeof f.transaction_on === "string" ? f.transaction_on : null; if (!tx) return { open: false, reason: "transaction_on is required" };
  const until = ofacRecordsRetainedUntil(plainDate(tx)); return today >= until ? { open: true } : { open: false, reason: `retained until ${until} (§501.601: 10 years after the transaction)` };
}
// ---- the funding gate and the daily list refresh
export interface ScreenFact { readonly party_id: string; readonly screened_on: PlainDate; readonly result: "clear" | "false_positive" | "potential" | "confirmed_match"; readonly list_refreshed?: boolean; }
export const FUNDING_SCREEN_MAX_AGE_DAYS = 1;
/**
 * SM_OFAC_CLEAR_BEFORE_FUNDING_GATE: open iff every party and payee has a screen dated within 1 calendar day of the disbursement
 * with no `potential` / `confirmed_match`. A failed daily list refresh (`refresh_failed_dates` ∋ disbursement_on) keeps the gate
 * closed for every disbursement that day until a successful screen dated that day (`list_refreshed = true`) exists; the funder
 * cannot bypass it (`bypass` / `funder_override` close it).
 */
export function ofacClearBeforeFundingGate(f: Record<string, unknown>): GateResult {
  if (f.bypass === true || f.funder_override === true) return { open: false, reason: "the funder cannot bypass SM_OFAC_CLEAR_BEFORE_FUNDING_GATE" };
  const on = typeof f.disbursement_on === "string" ? f.disbursement_on : null; if (!on) return { open: false, reason: "disbursement_on is required" };
  const parties = Array.isArray(f.parties) ? (f.parties as string[]) : []; const screens = Array.isArray(f.screens) ? (f.screens as ScreenFact[]) : [];
  const failedToday = Array.isArray(f.refresh_failed_dates) && (f.refresh_failed_dates as string[]).includes(on);
  if (!parties.length) return { open: false, reason: "no parties/payees listed for the disbursement" };
  const closed: string[] = [];
  for (const p of parties) {
    const fresh = screens.filter((s) => s.party_id === p && s.screened_on <= on && addDays(s.screened_on, FUNDING_SCREEN_MAX_AGE_DAYS) >= on && (!failedToday || (s.screened_on === on && s.list_refreshed === true)));
    if (!fresh.length) { closed.push(failedToday ? `${p}: the ${on} list refresh failed — no successful screen dated ${on}` : `${p}: no screen dated within ${FUNDING_SCREEN_MAX_AGE_DAYS} day of ${on}`); continue; }
    const bad = fresh.find((s) => s.result === "potential" || s.result === "confirmed_match"); if (bad) closed.push(`${p}: ${bad.result} on ${bad.screened_on}`);
  }
  return closed.length ? { open: false, reason: `OFAC clear-before-funding gate closed — ${closed.join("; ")}` } : { open: true };
}
export function assertOfacGateOpen(f: Record<string, unknown>, command: string): void { const g = ofacClearBeforeFundingGate(f); if (!g.open) throw new ScreeningRefused("SM_OFAC_CLEAR_BEFORE_FUNDING_GATE", "28.4 timer table: `assertGateOpen` before `disburse` and before any outbound wire", `${command}: ${g.reason}`); }
export const OFAC_REFRESH_TIME_ET = "05:00";
/** The daily 05:00 ET SLS refresh + re-screen of every open application/party: `ofac.list.refreshed{rescreen_complete}` (satisfies SM_OFAC_LIST_REFRESH_DAILY) or `ofac.list.refresh.failed` (the funding gate stays closed for the day). */
export function ofacListRefresh(events: EventStore, i: { owner: string; date: PlainDate; succeeded: boolean; list_versions?: Record<string, string>; open_applications?: number; parties_rescreened?: number; error?: string | null; at: string }, actor: Actor = { kind: "system", id: "ofac-sls-refresh" }): DomainEvent {
  const base = { aggregate: { kind: "bsa_program", id: i.owner }, actor, occurredAt: i.at };
  if (!i.succeeded) return events.append({ ...base, type: "ofac.list.refresh.failed", payload: { owner: i.owner, date: i.date, error: i.error ?? "SLS download failed", funding_gate: "closed until a successful screen dated within 1 day exists", source: "origination" } });
  return events.append({ ...base, type: "ofac.list.refreshed", payload: { owner: i.owner, date: i.date, list_versions: i.list_versions ?? {}, open_applications: i.open_applications ?? 0, parties_rescreened: i.parties_rescreened ?? 0, rescreen_complete: true, source: "origination" } });
}

// ============================================================ R5 — Fannie Mae A3-4-03 report
export type FnmaReportChannel = "lqc_self_report" | "suspected_fraud_form" | "phone";
export interface FnmaFraudReport { readonly report_id: string; readonly case_id: string; readonly application_id: string | null; readonly loan_id: string | null; readonly fnma_loan_number: string | null; readonly channel: FnmaReportChannel; readonly reasonable_basis_on: PlainDate; readonly due_on: PlainDate; readonly submit_by_policy: PlainDate; readonly approved_by_officer_at: string | null; readonly approved_by: string | null; readonly submitted_at: string | null; readonly submitted_on: PlainDate | null; readonly reference: string | null; readonly synopsis_document_id: string; readonly documents: readonly string[]; readonly status: "draft" | "approved" | "submitted"; readonly late: boolean; }
/** Q4: LQC self-report for delivered/committed loans; the Suspected Mortgage Fraud Report form for third-party schemes at the partner's election; no A3-4-03 duty for a never-delivered loan otherwise. */
export function fnmaReportChannel(i: { delivered_or_committed: boolean; third_party_scheme: boolean; partner_elects: boolean }): FnmaReportChannel | null {
  if (i.delivered_or_committed) return "lqc_self_report";
  if (i.third_party_scheme && i.partner_elects) return "suspected_fraud_form";
  return null;
}
/** Policy: submitted by the last creditor business day on or before the due date (Fri Dec 25, 2026 → Thu Dec 24). */
export function fnmaSubmitByPolicy(due_on: PlainDate, cal: Calendar = creditor): PlainDate { return rollBack(due_on, cal); }
export function openFnmaFraudReport(events: EventStore, c: FraudCase, i: { reasonable_basis_on: PlainDate; delivered_or_committed: boolean; third_party_scheme?: boolean; partner_elects?: boolean; fnma_loan_number?: string | null; synopsis_document_id: string; documents: readonly string[]; at: string }, actor: Actor = AGENT): { report: FnmaFraudReport | null; fraud_case: FraudCase; events: DomainEvent[]; escalation: { kind: "officer"; payload: Record<string, unknown> } | null } {
  nonEmpty(i.synopsis_document_id, "synopsis_document_id");
  if (c.triage_status !== "suspicious_determined") throw new ScreeningRefused("FNMA_REPORT_NEEDS_REASONABLE_BASIS", "A3-4-03: due diligence first — the reasonable basis is the triage determination reviewed by the officer", `case ${c.case_id} is ${c.triage_status}`);
  const channel = fnmaReportChannel({ delivered_or_committed: i.delivered_or_committed, third_party_scheme: i.third_party_scheme ?? false, partner_elects: i.partner_elects ?? false });
  const due_on = selfReportDue(i.reasonable_basis_on);
  const fraud_case: FraudCase = { ...c, fnma_reasonable_basis_at: i.reasonable_basis_on };
  const out = [emitFor(events, c, "fnma.fraud.reasonable_basis", { reasonable_basis_at: i.reasonable_basis_on, delivered_or_committed: i.delivered_or_committed, due_on, channel, fnma_loan_number: i.fnma_loan_number ?? null }, i.at, actor)];
  if (!channel) return { report: null, fraud_case, events: out, escalation: null };
  if (channel === "lqc_self_report" && !i.fnma_loan_number) throw new RangeError("the LQC self-report requires a Fannie Mae loan number");
  const report: FnmaFraudReport = { report_id: randomUUID(), case_id: c.case_id, application_id: c.application_id, loan_id: c.loan_id, fnma_loan_number: i.fnma_loan_number ?? null, channel, reasonable_basis_on: i.reasonable_basis_on, due_on, submit_by_policy: fnmaSubmitByPolicy(due_on), approved_by_officer_at: null, approved_by: null, submitted_at: null, submitted_on: null, reference: null, synopsis_document_id: i.synopsis_document_id, documents: i.documents, status: "draft", late: false };
  out.push(emitFor(events, c, "fnma.fraud.report.drafted", { report_id: report.report_id, channel, due_on, submit_by_policy: report.submit_by_policy, sar_material_excluded: true }, i.at, actor));
  return { report, fraud_case, events: out, escalation: { kind: "officer", payload: { report_id: report.report_id, case_id: c.case_id, channel, due_on, submit_by_policy: report.submit_by_policy } } };
}
export function approveFnmaReport(events: EventStore, c: FraudCase, r: FnmaFraudReport, i: { at: string }, actor: Actor): { report: FnmaFraudReport; event: DomainEvent } {
  if (!isHumanRole(actor, ["officer"])) throw new ScreeningRefused("FNMA_REPORT_NEEDS_PARTNER_OFFICER", "28.4 rule 5: the partner `officer` approves the Fannie Mae report", `${actor.kind}:${actor.id} cannot approve`);
  if (r.status !== "draft") throw new RangeError(`report ${r.report_id} is ${r.status}`);
  const event = emitFor(events, c, "fnma.fraud.report.approved", { report_id: r.report_id, approved_by: actor.id, approved_at: i.at }, i.at, actor);
  return { report: { ...r, status: "approved", approved_by_officer_at: i.at, approved_by: actor.id }, event };
}
/** `fnma.fraud.report.submitted` by the fnma_portal_operator after the officer's approval (LQC is portal-only); the LQC reference is stored; after `due_on` it is a breach. */
export function submitFnmaReport(events: EventStore, c: FraudCase, r: FnmaFraudReport, i: { reference: string; at: string }, actor: Actor): { report: FnmaFraudReport; event: DomainEvent; late: boolean } {
  if (!isHumanRole(actor, ["fnma_portal_operator"])) throw new ScreeningRefused("FNMA_SUBMISSION_IS_OPERATOR_ACT", "28.4 timer table: LQC self-report by the `fnma_portal_operator` after partner `officer` approval", `${actor.kind}:${actor.id} cannot submit to Loan Quality Connect`);
  if (r.status !== "approved") throw new ScreeningRefused("FNMA_REPORT_NOT_APPROVED", "28.4 rule 5: the partner officer approves before the operator submits", `report ${r.report_id} is ${r.status}`);
  nonEmpty(i.reference, "reference");
  const submitted_on = civil(i.at); const late = submitted_on > r.due_on;
  const event = emitFor(events, c, "fnma.fraud.report.submitted", { report_id: r.report_id, channel: r.channel, reference: i.reference, submitted_on, due_on: r.due_on, late, fnma_loan_number: r.fnma_loan_number, submitted_by: actor.id }, i.at, actor);
  return { report: { ...r, status: "submitted", submitted_at: i.at, submitted_on, reference: i.reference, late }, event, late };
}

// ============================================================ R7 — FCRA §609(e) victim record requests
export type ClaimProof = "police_report" | "ftc_affidavit" | "none";
export type DeclineGround = "identity_not_verified" | "request_based_on_misrepresentation" | "information_would_be_used_in_furtherance_of_crime" | "otherwise_prohibited_by_law";
export const VICTIM_RECORDS_DAYS = 30;
export interface IdentityTheftRequest { readonly request_id: string; readonly requester: "victim" | "law_enforcement"; readonly application_id: string | null; readonly loan_id: string | null; readonly received_on: PlainDate; readonly verified: boolean; readonly identity_proof: string | null; readonly claim_proof: ClaimProof; readonly due_on: PlainDate; readonly records_provided_at: string | null; readonly declined_reason: DeclineGround | null; readonly document_ids: readonly string[]; readonly charge_cents: bigint; readonly status: "received" | "records_provided" | "declined"; }
export function receiveIdentityTheftRequest(events: EventStore, i: { requester: "victim" | "law_enforcement"; application_id?: string | null; loan_id?: string | null; received_on: PlainDate; identity_proof: string | null; claim_proof: ClaimProof; at: string }, actor: Actor = AGENT): { request: IdentityTheftRequest; event: DomainEvent } {
  const verified = !!i.identity_proof && i.claim_proof !== "none";
  const request: IdentityTheftRequest = { request_id: randomUUID(), requester: i.requester, application_id: i.application_id ?? null, loan_id: i.loan_id ?? null, received_on: i.received_on, verified, identity_proof: i.identity_proof, claim_proof: i.claim_proof, due_on: addDays(i.received_on, VICTIM_RECORDS_DAYS), records_provided_at: null, declined_reason: null, document_ids: [], charge_cents: 0n, status: "received" };
  const event = emitFor(events, { case_id: request.request_id, application_id: request.application_id, loan_id: request.loan_id }, "identity_theft.request.received", { request_id: request.request_id, requester: i.requester, received_on: i.received_on, verified, claim_proof: i.claim_proof, due_on: request.due_on }, i.at, actor);
  return { request, event };
}
/** §609(e)(1): application and business transaction records within 30 days, without charge; or a documented (e)(5) decline. */
export function fulfilIdentityTheftRequest(events: EventStore, r: IdentityTheftRequest, i: { outcome: "records_provided" | "declined_e5"; document_ids?: readonly string[]; declined_reason?: DeclineGround | null; charge_cents?: bigint; at: string }, actor: Actor = AGENT): { request: IdentityTheftRequest; event: DomainEvent; on_time: boolean } {
  if (r.status !== "received") throw new RangeError(`request ${r.request_id} is ${r.status}`);
  if (!r.verified) throw new ScreeningRefused("VICTIM_REQUEST_NOT_VERIFIED", "15 U.S.C. 1681g(e)(2)-(3): identity verification and proof of the claim (police report or FTC affidavit) precede disclosure", "verify identity and the claim first");
  const on = civil(i.at); const charge = i.charge_cents ?? 0n;
  if (i.outcome === "records_provided") {
    if (charge !== 0n) throw new ScreeningRefused("VICTIM_RECORDS_WITHOUT_CHARGE", "15 U.S.C. 1681g(e)(1): records are provided \"without charge\"", `charge ${charge} cents is not permitted`);
    if (!i.document_ids?.length) throw new RangeError("document_ids of the application and transaction records are required");
    const request: IdentityTheftRequest = { ...r, status: "records_provided", records_provided_at: i.at, document_ids: i.document_ids, charge_cents: 0n };
    const event = emitFor(events, { case_id: r.request_id, application_id: r.application_id, loan_id: r.loan_id }, "identity_theft.request.fulfilled", { request_id: r.request_id, outcome: "records_provided", provided_on: on, due_on: r.due_on, on_time: on <= r.due_on, without_charge: true, document_ids: i.document_ids }, i.at, actor);
    return { request, event, on_time: on <= r.due_on };
  }
  if (!i.declined_reason) throw new ScreeningRefused("DECLINE_NEEDS_E5_GROUND", "15 U.S.C. 1681g(e)(5): a decline is documented with its statutory ground", "declined_reason is required");
  const request: IdentityTheftRequest = { ...r, status: "declined", declined_reason: i.declined_reason };
  const event = emitFor(events, { case_id: r.request_id, application_id: r.application_id, loan_id: r.loan_id }, "identity_theft.request.fulfilled", { request_id: r.request_id, outcome: "declined_e5", declined_reason: i.declined_reason, declined_on: on, due_on: r.due_on, on_time: on <= r.due_on, citation: "15 U.S.C. 1681g(e)(5)" }, i.at, actor);
  return { request, event, on_time: on <= r.due_on };
}

// ============================================================ R10 — the §1029.210 program, Red Flags board report, exclusion lists
export interface BsaProgram { readonly program_id: string; readonly owner: "partner" | "sm"; readonly version: string; readonly compliance_date: PlainDate | null; readonly approved_by_senior_management_at: PlainDate | null; readonly board_approved_at: PlainDate | null; readonly risk_assessment_document_id: string | null; readonly risk_assessment_date: PlainDate | null; readonly compliance_officer_id: string; readonly training: readonly { person: string; course: string; completed_at: PlainDate }[]; readonly independent_tests: readonly { tester: string; independent_of_officer: true; period: string; report_document_id: string; findings: readonly string[]; remediation_due: PlainDate | null }[]; readonly red_flags_itpp_document_id: string | null; readonly red_flags_board_report_at: PlainDate | null; readonly next_review_due_on: PlainDate | null; }
export const PROGRAM_JOBS = ["bsa_independent_test", "bsa_training", "bsa_program_review", "itpp_board_report", "ofac_list_refresh"] as const;
export type ProgramJob = (typeof PROGRAM_JOBS)[number];
/** The scheduler's tick for a program row (annual pillars; the daily OFAC refresh) — carries `source: origination` so the 28.4 rows arm. */
export function programScheduleTick(events: EventStore, i: { owner: string; job: ProgramJob; date: PlainDate; at: string }, actor: Actor = { kind: "system", id: "scheduler" }): DomainEvent {
  const cadence = i.job === "ofac_list_refresh" ? "daily" : "annual";
  return events.append({ type: "schedule.tick", aggregate: { kind: "bsa_program", id: i.owner }, actor, occurredAt: i.at, payload: { cadence, job: i.job, date: i.date, at: cadence === "daily" ? OFAC_REFRESH_TIME_ET : "06:00", tz: "America/New_York", owner: i.owner, source: "origination" } });
}
const programEmit = (events: EventStore, p: BsaProgram, type: string, payload: Record<string, unknown>, at: string, actor: Actor): DomainEvent => events.append({ type, aggregate: { kind: "bsa_program", id: p.owner }, actor, occurredAt: at, payload: { program_id: p.program_id, owner: p.owner, version: p.version, source: "origination", ...payload } });
/** §1029.210(b)(4): "by any officer or employee … other than the person designated" — a test by the compliance officer is rejected and the annual row stays unsatisfied (T11). */
export function recordIndependentTest(events: EventStore, p: BsaProgram, i: { tester_id: string; tester: string; period: string; report_document_id: string; findings: readonly string[]; remediation_due?: PlainDate | null; at: string }, actor: Actor = AGENT): { program: BsaProgram; accepted: boolean; independent_of_officer: boolean; event: DomainEvent } {
  nonEmpty(i.tester_id, "tester_id"); nonEmpty(i.report_document_id, "report_document_id"); nonEmpty(i.period, "period");
  const independent_of_officer = i.tester_id !== p.compliance_officer_id;
  if (!independent_of_officer) {
    const event = programEmit(events, p, "bsa.independent_test.rejected", { tester_id: i.tester_id, period: i.period, independent_of_officer: false, reason: "31 CFR 1029.210(b)(4): the compliance officer cannot perform the independent test" }, i.at, actor);
    return { program: p, accepted: false, independent_of_officer: false, event };
  }
  const rec = { tester: i.tester, independent_of_officer: true as const, period: i.period, report_document_id: i.report_document_id, findings: i.findings, remediation_due: i.remediation_due ?? null };
  const event = programEmit(events, p, "bsa.independent_test.completed", { tester_id: i.tester_id, tester: i.tester, period: i.period, independent_of_officer: true, findings: i.findings.length, remediation_due: rec.remediation_due, report_document_id: i.report_document_id }, i.at, actor);
  return { program: { ...p, independent_tests: [...p.independent_tests, rec] }, accepted: true, independent_of_officer: true, event };
}
/** "Appropriate persons" for training: everyone listed by the program (bsa_officer, fnma_portal_operator, QC, funding staff, developers of the fraud-risk agent) with a completion within 12 months. */
export function recordTraining(events: EventStore, p: BsaProgram, i: { appropriate_persons: readonly string[]; completions: readonly { person: string; course: string; completed_at: PlainDate }[]; as_of: PlainDate; at: string }, actor: Actor = AGENT): { program: BsaProgram; all_appropriate_persons: boolean; missing: string[]; event: DomainEvent } {
  const training = [...p.training, ...i.completions];
  const missing = i.appropriate_persons.filter((person) => !training.some((t) => t.person === person && addYears(t.completed_at, 1) > i.as_of));
  const all_appropriate_persons = missing.length === 0;
  const event = programEmit(events, p, "bsa.training.completed", { all_appropriate_persons, missing, completions: i.completions.length, as_of: i.as_of }, i.at, actor);
  return { program: { ...p, training }, all_appropriate_persons, missing, event };
}
export function riskAssessmentCurrent(p: Pick<BsaProgram, "risk_assessment_date">, as_of: PlainDate): boolean { return !!p.risk_assessment_date && addYears(p.risk_assessment_date, 1) > as_of; }
/** Annual program review with the risk-assessment refresh and senior-management (and board) approval — NPRM-ready. */
export function reviewProgram(events: EventStore, p: BsaProgram, i: { version: string; risk_assessment_document_id: string; risk_assessment_date: PlainDate; approved_by_senior_management_at: PlainDate; board_approved_at?: PlainDate | null; at: string }, actor: Actor): { program: BsaProgram; event: DomainEvent } {
  if (!isHumanRole(actor, ["officer"])) throw new ScreeningRefused("PROGRAM_APPROVAL_IS_OFFICER_ACT", "31 CFR 1029.210(a): the program must be approved by senior management — the partner `officer` / SM management", `${actor.kind}:${actor.id} cannot approve the program`);
  nonEmpty(i.version, "version"); nonEmpty(i.risk_assessment_document_id, "risk_assessment_document_id");
  const reviewed_on = civil(i.at);
  const program: BsaProgram = { ...p, version: i.version, risk_assessment_document_id: i.risk_assessment_document_id, risk_assessment_date: i.risk_assessment_date, approved_by_senior_management_at: i.approved_by_senior_management_at, board_approved_at: i.board_approved_at ?? p.board_approved_at, next_review_due_on: addYears(reviewed_on, 1) };
  const event = programEmit(events, program, "bsa.program.reviewed", { senior_management_approved: true, board_approved: !!program.board_approved_at, risk_assessment_date: i.risk_assessment_date, risk_assessment_within_12m: riskAssessmentCurrent(program, reviewed_on), next_review_due_on: program.next_review_due_on }, i.at, actor);
  return { program, event };
}
/** T14 / edge case: the April 10, 2026 NPRM finalized with a compliance date → only `version` and `compliance_date` change; the risk assessment (≤ 12 months old) and board approval are already there. */
export function bumpProgramForFinalRule(p: BsaProgram, i: { compliance_date: PlainDate; version: string; as_of: PlainDate }): { program: BsaProgram; changed_fields: string[]; ready: boolean; gaps: string[] } {
  const gaps: string[] = [];
  if (!riskAssessmentCurrent(p, i.as_of)) gaps.push("risk assessment not dated within 12 months");
  if (!p.board_approved_at) gaps.push("no board approval");
  const program: BsaProgram = { ...p, version: i.version, compliance_date: i.compliance_date };
  const changed_fields = (Object.keys(program) as (keyof BsaProgram)[]).filter((k) => program[k] !== p[k]).map(String);
  return { program, changed_fields, ready: gaps.length === 0, gaps };
}
export const BOARD_REPORT_ELEMENTS = ["effectiveness", "service_provider_oversight", "significant_incidents", "recommendations"] as const;
/** 16 CFR 681 Appendix A §VI: the annual board report — effectiveness, service-provider oversight (SM's controls), significant incidents, recommendations. */
export function issueBoardReport(events: EventStore, p: BsaProgram, i: { period: string; content: Partial<Record<(typeof BOARD_REPORT_ELEMENTS)[number], string>>; report_document_id: string; at: string }, actor: Actor): { program: BsaProgram; event: DomainEvent; missing_elements: string[] } {
  nonEmpty(i.report_document_id, "report_document_id");
  const missing = BOARD_REPORT_ELEMENTS.filter((k) => !i.content[k]);
  if (missing.length) throw new ScreeningRefused("BOARD_REPORT_INCOMPLETE", "16 CFR 681 App. A §VI(b): the report addresses effectiveness, service provider arrangements, significant incidents and recommendations", `missing ${missing.join(", ")}`);
  const on = civil(i.at);
  const event = programEmit(events, p, "red_flags.board_report.issued", { period: i.period, report_document_id: i.report_document_id, elements: BOARD_REPORT_ELEMENTS, issued_on: on }, i.at, actor);
  return { program: { ...p, red_flags_board_report_at: on }, event, missing_elements: [] };
}
export type ExclusionList = "fhfa_scp" | "gsa_sam" | "hud_ldp";
export const EXCLUSION_LISTS: readonly ExclusionList[] = ["fhfa_scp", "gsa_sam", "hud_ldp"];
export interface CounterpartyScreening { readonly screening_id: string; readonly party_id: string; readonly party_kind: string; readonly screened_on: PlainDate; readonly list_versions: Record<ExclusionList, string>; readonly hits: readonly { list: ExclusionList; entry: string }[]; readonly blocked: boolean; readonly case_signal: Signal | null; }
/** A3-4-03: FHFA SCP / GSA SAM (EPL) / HUD LDP at onboarding of every appraiser, PDC vendor, settlement agent, closing attorney, notary vendor, employee/contractor (and monthly); a hit blocks the onboarding and opens the case path. */
export function screenCounterparty(events: EventStore, i: { party_id: string; party_kind: string; list_versions: Record<ExclusionList, string>; hits: readonly { list: ExclusionList; entry: string }[]; application_id?: string | null; at: string }, actor: Actor = AGENT): { screening: CounterpartyScreening; event: DomainEvent; red_flag: { category: "vendor_alert"; red_flag_code: string } | null } {
  nonEmpty(i.party_id, "party_id"); nonEmpty(i.party_kind, "party_kind");
  for (const l of EXCLUSION_LISTS) nonEmpty(i.list_versions[l], `list_versions.${l}`);
  const blocked = i.hits.length > 0; const screened_on = civil(i.at);
  const case_signal: Signal | null = blocked ? { source_process: "28.4", signal_code: "exclusion_list_hit", evidence_refs: i.hits.map((h) => `${h.list}:${h.entry}`), score: 100 } : null;
  const screening: CounterpartyScreening = { screening_id: randomUUID(), party_id: i.party_id, party_kind: i.party_kind, screened_on, list_versions: i.list_versions, hits: i.hits, blocked, case_signal };
  const event = events.append({ type: "counterparty.screened", ...(i.application_id ? { applicationId: i.application_id } : {}), aggregate: { kind: "counterparty", id: i.party_id }, actor, occurredAt: i.at, payload: { screening_id: screening.screening_id, party_id: i.party_id, party_kind: i.party_kind, lists: EXCLUSION_LISTS, list_versions: i.list_versions, hits: i.hits, blocked, onboarding: blocked ? "blocked" : "cleared", citation: "A3-4-03", source: "origination" } });
  return { screening, event, red_flag: blocked ? { category: "vendor_alert", red_flag_code: "EXCLUSION_LIST_HIT" } : null };
}

// ============================================================ R8 — adverse action interplay (21.6 taxonomy; no SAR words)
export const NOTICE_SCAN_PATTERNS: readonly RegExp[] = [...SAR_TERM_PATTERNS, /\bsuspicious\b/i, /\binvestigation\b/i, /\bFinCEN\b/i, /\bSAR\b/];
export function scanForSarTerms(text: string): { clean: boolean; findings: string[] } { const findings = [...new Set(NOTICE_SCAN_PATTERNS.map((p) => p.exec(text)?.[0] ?? null).filter((m): m is string => m !== null))]; return { clean: !findings.length, findings }; }
export const SCHEME_TO_REASON: Readonly<Partial<Record<SchemeHypothesis, string>>> = { income_fabrication: "income_unverifiable", employment_fabrication: "employment_unverifiable", identity_theft: "identity_unverified", synthetic_identity: "identity_unverified", asset_fabrication: "assets_unverifiable", document_forgery: "income_unverifiable" };
/** A fraud-driven denial uses only the 21.6 taxonomy (comment 9(b)(2)-8 automatic-denial factors) — never text that reveals a SAR or an investigation; the rendered reasons are scanned (T7). */
export function denialReasonsForCase(c: Pick<FraudCase, "scheme_hypotheses">): { reasons: { code: string; statement_text: string; hmda_denial_code: number }[]; scan: { clean: boolean; findings: string[] } } {
  const codes = [...new Set(c.scheme_hypotheses.map((h) => SCHEME_TO_REASON[h]).filter((x): x is string => !!x))];
  if (!codes.length) codes.push("identity_unverified");
  const reasons = codes.map((code) => { const r = ECOA_REASONS[code]; if (!r) throw new RangeError(`no 21.6 reason ${code}`); return { code, statement_text: r.statement_text, hmda_denial_code: r.hmda_denial_code }; });
  const text = reasons.map((r) => r.statement_text).join(" / ");
  assertNoSarTerms(text);
  return { reasons, scan: scanForSarTerms(text) };
}

// ============================================================ AI agent design — the decision record and 31.2 monitoring
export interface FraudRiskDecision { readonly case_id: string; readonly signals: readonly Signal[]; readonly investigation_steps: readonly InvestigationStep[]; readonly scheme_assessment: ReturnType<typeof assessScheme>; readonly amount_cents: bigint; readonly triage_recommendation: "suspicious_determined" | "not_suspicious"; readonly rationale: string; readonly confidence: number; readonly officer_review: { escalation_id: string; decision: string; at: string } | null; readonly sar: { drafted_at: string; narrative_hash: string } | null; readonly timers: readonly string[]; readonly rule_set_versions: typeof RULE_SET_VERSIONS; readonly model_version: string; readonly prompt_version: string; readonly inputs_hash: string; readonly inputs: Record<string, unknown>; readonly reads: readonly string[]; }
export function fraudRiskDecisionRecord(i: Omit<FraudRiskDecision, "rule_set_versions" | "inputs_hash"> & { rule_set_versions?: typeof RULE_SET_VERSIONS; inputs_hash?: string }): FraudRiskDecision {
  nonEmpty(i.case_id, "case_id"); nonEmpty(i.rationale, "rationale"); nonEmpty(i.model_version, "model_version"); nonEmpty(i.prompt_version, "prompt_version");
  if (!(i.confidence >= 0 && i.confidence <= 1)) throw new RangeError("confidence must be within [0, 1]");
  if (!i.investigation_steps.length || i.investigation_steps.some((s) => !s.evidence_refs.length)) throw new ScreeningRefused("DECISION_NEEDS_EVIDENCE", "28.4 AI design: investigation_steps:[{tool, source, result, evidence_refs}]", "every investigation step carries evidence refs");
  if (!i.officer_review) throw new ScreeningRefused("DECISION_NEEDS_OFFICER_REVIEW", "28.4 AI design: the decision record carries the officer review", "officer_review is required");
  assertNoDemographicInputs(Object.keys(i.inputs));
  const demographic = i.reads.filter((r) => /applicant_demographics/i.test(r));
  if (demographic.length) throw new ScreeningRefused("NO_DEMOGRAPHIC_READS", "28.4 guardrail: never uses `applicant_demographics`", `reads ${demographic.join(", ")}`);
  const rule_set_versions = i.rule_set_versions ?? RULE_SET_VERSIONS;
  for (const k of Object.keys(RULE_SET_VERSIONS) as (keyof typeof RULE_SET_VERSIONS)[]) if (rule_set_versions[k] !== RULE_SET_VERSIONS[k]) throw new RangeError(`rule_set_versions.${k} must be ${RULE_SET_VERSIONS[k]}`);
  return { ...i, rule_set_versions, inputs_hash: i.inputs_hash ?? sha256(JSON.stringify(i.inputs, (_k, v) => (typeof v === "bigint" ? String(v) : v))) };
}
/** Monthly fraud-flag rate by channel and product for 31.2 (fair-lending review of flag rates; never joined to demographics here). */
export function monthlyFraudFlagRate(events: EventStore, i: { period: string; applications: readonly { application_id: string; channel: string; product: string; flagged: boolean }[]; at: string }, actor: Actor = AGENT): { by_channel: Record<string, { flagged: number; total: number; rate_bps: number }>; by_product: Record<string, { flagged: number; total: number; rate_bps: number }>; event: DomainEvent } {
  const tally = (key: "channel" | "product") => { const out: Record<string, { flagged: number; total: number; rate_bps: number }> = {}; for (const a of i.applications) { const k = a[key]; const row = (out[k] ??= { flagged: 0, total: 0, rate_bps: 0 }); row.total++; if (a.flagged) row.flagged++; } for (const row of Object.values(out)) row.rate_bps = row.total ? Math.round((row.flagged * 10_000) / row.total) : 0; return out; };
  const by_channel = tally("channel"), by_product = tally("product");
  const event = events.append({ type: "fraud.flag_rate.reported", aggregate: { kind: "fraud_program", id: "28.4" }, actor, occurredAt: i.at, payload: { period: i.period, by_channel, by_product, consumer: "31.2", demographic_joins: false, source: "origination" } });
  return { by_channel, by_product, event };
}
export const scrub = scrubSarTerms;
export { addBusinessDays, federal };
