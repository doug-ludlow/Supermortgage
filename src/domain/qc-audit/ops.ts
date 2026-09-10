/**
 * §18 operating rules over the pure calculators (sampling, findings, mora,
 * star, form582, fraud, regab, networth): the AI-off cycle plan and the
 * engine-only rederive row of 18.1; the A2-4-01 review-file compilation with
 * its hash manifest, the remedy-demand hand-off to the 5.x appeal ladder and
 * the litigation hold that blocks purge jobs of 18.2; the transfer-in
 * exclusion window and the confidentiality filter on distribution of 18.3;
 * the same-day regulatory-action notice and the subservicing screen of 18.4;
 * the report-draft gate behind the fraud officer, the A3-2-01 breach
 * self-report clock and the red-flag fairness screen of 18.5; the 1122
 * exception list, the issuer-year evidence window and the
 * material-noncompliance notice of 18.6; and the stale-GL run of 18.7.
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays, addMonths, endOfMonth, parts } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, nextBusinessDay, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { sampleSize } from "./sampling.ts";
import { fairnessScreen } from "./findings.ts";
import { confidentialityFilter, includedInMetric, type Metric } from "./star.ts";
import { exceptionRemovable } from "./regab.ts";
import { glStale } from "./networth.ts";

export interface QcEscalation { readonly kind: "officer" | "attorney" | "human_agent" | "fnma_portal_operator" | "fraud_officer"; readonly severity?: "sev1" | "sev2" | "sev3" | "sev4"; readonly reason: string; readonly due?: PlainDate; }

// ============================================================ 18.1 QC-as-code
export interface RederiveRow { readonly rule_code: string; readonly subject_type: string; readonly subject_id: string; readonly result: "pass" | "fail"; readonly expected: Record<string, unknown>; readonly observed: Record<string, unknown>; readonly variance_cents: Cents; readonly reviewer_kind: "engine"; }
/** Rule A/C: a rederive test row — engine-only, pass when the independent re-derivation matches to the cent. */
export function rederiveTest(rule_code: string, subject_type: string, subject_id: string, expected: Cents, observed: Cents, detail: { expected?: Record<string, unknown>; observed?: Record<string, unknown> } = {}): RederiveRow {
  const variance = observed - expected;
  return { rule_code, subject_type, subject_id, result: variance === 0n ? "pass" : "fail", expected: { cents: expected, ...(detail.expected ?? {}) }, observed: { cents: observed, ...(detail.observed ?? {}) }, variance_cents: variance, reviewer_kind: "engine" };
}

export interface CyclePlan { readonly ai_off: boolean; readonly rederive_results: readonly { subject_id: string; result: "pass" | "fail"; variance_cents: Cents; reviewer_kind: "engine" }[]; readonly judgment: { readonly population_n: number; readonly n: number; readonly reviewer_kind: "human" | "llm"; readonly queue: "ops_console_qc_workbench" | "llm_judgment"; readonly human_review_below_confidence: 0.85 }; }
/** 18.1 AI-off path: census rederives are engine-only either way; judgment samples keep their n and route to the human workbench when the flag is set. */
export function cyclePlan(i: { ai_off: boolean; population_n: number; rederive: readonly { subject_id: string; expected: Cents; observed: Cents }[] }): CyclePlan {
  return {
    ai_off: i.ai_off,
    rederive_results: i.rederive.map((r) => ({ subject_id: r.subject_id, result: r.observed - r.expected === 0n ? "pass" : "fail", variance_cents: r.observed - r.expected, reviewer_kind: "engine" })),
    judgment: { population_n: i.population_n, n: sampleSize(i.population_n), reviewer_kind: i.ai_off ? "human" : "llm", queue: i.ai_off ? "ops_console_qc_workbench" : "llm_judgment", human_review_below_confidence: 0.85 },
  };
}

// ============================================================ 18.2 exams
export interface ReviewFileInput {
  readonly loan: { fnma_loan_number: string; servicer_loan_number: string; borrower_name: string; property_address: string; remittance_type: "A/A" | "S/A" | "S/S"; servicing_option: "special" | "shared_risk"; file_type: "servicing_review" };
  readonly contacts: readonly { on: PlainDate; mode: string; result: string; qrpc: boolean }[];
  readonly delinquency_notices: readonly { template_code: string; sent_on: PlainDate }[];
  readonly payment_history: readonly { on: PlainDate; amount_cents: Cents }[];
  readonly workouts: readonly { kind: string; decided_on: PlainDate; outcome: string; smdu_case_id?: string | null }[];
  readonly bankruptcy: { chapter: string; filed_on: PlainDate; events: readonly { on: PlainDate; event: string; pacer_ref?: string | null }[] } | null;
  readonly foreclosure: { referral_on: PlainDate; milestones: readonly { on: PlainDate; milestone: string }[]; allowable_days: number; elapsed_days: number; delay_communications: readonly string[] } | null;
  readonly expenses: readonly { advance_id: string; vendor: string; invoice_document_id: string; amount_cents: Cents }[];
  readonly timers: readonly { code: string; status: string; satisfied_by_event_id?: string | null; evidence_hash?: string | null }[];
}
export const REVIEW_FILE_SECTIONS = ["header", "collection_history", "workout_summary", "bankruptcy_log", "foreclosure_log", "expense_support", "inspections_plans_disclosures_settlements", "timer_appendix"] as const;
export interface ReviewFile { readonly sections: readonly { id: (typeof REVIEW_FILE_SECTIONS)[number]; present: boolean; rows: number }[]; readonly header: ReviewFileInput["loan"]; readonly foreclosure_log: { allowable_days: number; elapsed_days: number; within_timeframe: boolean; comparison: "E-3.2-15" } | null; readonly document: string; readonly manifest: { sha256: string; sections: string[]; pages: number; loan_header: string }; }
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() + "n" : x));
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** Rule 18.2-2: the single-PDF servicing review file in A2-4-01 order with a hash manifest stored on `exam_productions`. */
export function compileReviewFile(i: ReviewFileInput): ReviewFile {
  const fc = i.foreclosure ? { allowable_days: i.foreclosure.allowable_days, elapsed_days: i.foreclosure.elapsed_days, within_timeframe: i.foreclosure.elapsed_days <= i.foreclosure.allowable_days, comparison: "E-3.2-15" as const } : null;
  const body = {
    header: i.loan,
    collection_history: { contacts: i.contacts, delinquency_notices: i.delinquency_notices, payment_history: i.payment_history },
    workout_summary: i.workouts,
    bankruptcy_log: i.bankruptcy,
    foreclosure_log: i.foreclosure ? { ...i.foreclosure, ...fc } : null,
    expense_support: i.expenses,
    inspections_plans_disclosures_settlements: [],
    timer_appendix: i.timers,
  };
  const rows: Record<(typeof REVIEW_FILE_SECTIONS)[number], number> = {
    header: 1, collection_history: i.contacts.length + i.delinquency_notices.length + i.payment_history.length, workout_summary: i.workouts.length, bankruptcy_log: i.bankruptcy ? i.bankruptcy.events.length : 0,
    foreclosure_log: i.foreclosure ? i.foreclosure.milestones.length : 0, expense_support: i.expenses.length, inspections_plans_disclosures_settlements: 0, timer_appendix: i.timers.length,
  };
  const document = canonical(body);
  const sections = REVIEW_FILE_SECTIONS.map((id) => ({ id, present: id === "header" || id === "inspections_plans_disclosures_settlements" ? true : id === "bankruptcy_log" ? i.bankruptcy !== null : id === "foreclosure_log" ? i.foreclosure !== null : rows[id] > 0, rows: rows[id] }));
  const pages = Math.max(1, Math.ceil(document.length / 3000));
  return { sections, header: i.loan, foreclosure_log: fc, document, manifest: { sha256: sha256(document), sections: sections.filter((s) => s.present).map((s) => s.id), pages, loan_header: `${i.loan.fnma_loan_number}/${i.loan.servicer_loan_number}` } };
}
export function manifestMatches(manifest: ReviewFile["manifest"], storedDocument: string): boolean { return sha256(storedDocument) === manifest.sha256; }

/** Rule 18.2 (`exam.remedy_demand.received`): a remedy demand starts the 5.x A1-3-02 ladder at `FNMA_A1302_APPEAL1_60` and links the exam to the repurchase case. */
export function remedyDemandReceived(i: { exam_id: string; received_on: PlainDate; demand: { kind: "repurchase" | "make_whole" | "compensatory_fee"; fnma_loan_number: string; amount_cents: Cents }; repurchase_case_id: string }): { event: { type: "exam.remedy_demand.received"; exam_id: string; repurchase_case_id: string }; timer: { code: "FNMA_A1302_APPEAL1_60"; anchor: PlainDate; due: PlainDate; owner_process: "5.6" }; exam_link: { exam_id: string; repurchase_case_id: string; demand_kind: string; amount_cents: Cents }; exam_status: "disputed" } {
  return { event: { type: "exam.remedy_demand.received", exam_id: i.exam_id, repurchase_case_id: i.repurchase_case_id }, timer: { code: "FNMA_A1302_APPEAL1_60", anchor: i.received_on, due: addDays(i.received_on, 60), owner_process: "5.6" }, exam_link: { exam_id: i.exam_id, repurchase_case_id: i.repurchase_case_id, demand_kind: i.demand.kind, amount_cents: i.demand.amount_cents }, exam_status: "disputed" };
}

export interface LitigationHold { readonly code: "SM_EXAM_LITIGATION_HOLD"; readonly source: "subpoena" | "litigation_discovery"; readonly scope_loan_ids: readonly string[]; readonly received_on: PlainDate; readonly released_by_counsel_on: PlainDate | null; readonly active: boolean; }
/** Rule 18.2 `SM_EXAM_LITIGATION_HOLD`: a subpoena or discovery notice holds the scoped loans' records until counsel releases. */
export function litigationHold(i: { source: "subpoena" | "litigation_discovery"; scope_loan_ids: readonly string[]; received_on: PlainDate; released_by_counsel_on?: PlainDate | null }): LitigationHold {
  return { code: "SM_EXAM_LITIGATION_HOLD", source: i.source, scope_loan_ids: [...i.scope_loan_ids], received_on: i.received_on, released_by_counsel_on: i.released_by_counsel_on ?? null, active: !i.released_by_counsel_on };
}
/** A retention purge job: scoped loans under an active hold are refused (never purged), the rest proceed. */
export function purgeJob(i: { loan_ids: readonly string[]; holds: readonly LitigationHold[] }): { purged: string[]; blocked: { loan_id: string; hold_code: "SM_EXAM_LITIGATION_HOLD"; reason: string }[] } {
  const purged: string[] = []; const blocked: { loan_id: string; hold_code: "SM_EXAM_LITIGATION_HOLD"; reason: string }[] = [];
  for (const id of i.loan_ids) {
    const h = i.holds.find((x) => x.active && x.scope_loan_ids.includes(id));
    if (h) blocked.push({ loan_id: id, hold_code: "SM_EXAM_LITIGATION_HOLD", reason: `retention purge refused: ${h.source} hold received ${h.received_on} — released only by counsel` });
    else purged.push(id);
  }
  return { purged, blocked };
}

// ============================================================ 18.3 STAR
/** Common rule: a transferred-in loan is out of every metric but MOD6/PD6 for the two months after transfer. */
export function transferInExclusion(transferredIn: PlainDate, baseMonth: PlainDate): { base_month: string; excluded_from: Metric[]; included_in: Metric[]; window_ends_before: PlainDate } {
  const all: Metric[] = ["T60", "C60", "RET_EFF", "MOD6", "PD6", "BEYOND_TF"];
  const inc = all.filter((m) => includedInMetric(m, baseMonth, transferredIn, null));
  return { base_month: baseMonth.slice(0, 7), excluded_from: all.filter((m) => !inc.includes(m)), included_in: inc, window_ends_before: addMonths(transferredIn, 2) };
}
/** Guardrail: STAR results are confidential — vendor/marketing distribution is blocked; the partner only under the subservicing-agreement clause. */
export function distributionFilter(i: { audience: "vendor" | "marketing" | "partner" | "internal" | "fnma"; text: string; partner_confidentiality_clause?: boolean }): { blocked: boolean; reason: string | null; rule: "STAR_CONFIDENTIALITY" } {
  const mentions = confidentialityFilter(i.text) || /\bSTAR\s+(scorecard|results?|rank)/i.test(i.text);
  if (!mentions || i.audience === "internal" || i.audience === "fnma") return { blocked: false, reason: null, rule: "STAR_CONFIDENTIALITY" };
  if (i.audience === "partner") return i.partner_confidentiality_clause ? { blocked: false, reason: null, rule: "STAR_CONFIDENTIALITY" } : { blocked: true, reason: "partner sharing of STAR Scorecard results needs the subservicing-agreement confidentiality clause", rule: "STAR_CONFIDENTIALITY" };
  return { blocked: true, reason: `"a servicer may not disclose STAR Scorecard results to any third parties by any means" — ${i.audience} distribution refused`, rule: "STAR_CONFIDENTIALITY" };
}

// ============================================================ 18.4 Form 582 / corporate notices
/** Rule 18.4 A4-1-03 "immediate written notice": a regulatory action drafts the notice and escalates the same day; the 1-BD proxy timer is satisfied only by sent evidence. */
export function regulatoryActionReceived(i: { received_on: PlainDate; kind: "state_consent_order" | "cease_and_desist" | "regulator_management_role" | "fine" | "other"; regulator: string; entity: "supermortgage" | "partner"; cal?: Calendar }): { draft: { template: "ORG-CHG-NOTICE-v1"; kind: "regulatory_action_notice"; recipient: "fnma_customer_account_team"; drafted_on: PlainDate; regulator: string; action: string; citation: string }; escalations: QcEscalation[]; timer: { code: "FNMA_A4103_REGULATORY_ACTION_IMMEDIATE"; anchor: PlainDate; due: PlainDate; satisfied_by: string }; partner_notice: { code: "SM_PARTNER_NOTIFY_SUB_EVENT_1BD"; due: PlainDate } | null } {
  const cal = i.cal ?? servicer;
  return {
    draft: { template: "ORG-CHG-NOTICE-v1", kind: "regulatory_action_notice", recipient: "fnma_customer_account_team", drafted_on: i.received_on, regulator: i.regulator, action: i.kind, citation: "Selling Guide A4-1-03: immediate written notice of regulatory actions and of a regulator assuming a management role" },
    escalations: [{ kind: "officer", severity: "sev1", reason: `${i.kind} from ${i.regulator} received ${i.received_on} — sign the written notice today`, due: i.received_on }, { kind: "attorney", severity: "sev1", reason: "regulatory action: counsel review of the notice and any state-license reporting (Section 19)", due: i.received_on }],
    timer: { code: "FNMA_A4103_REGULATORY_ACTION_IMMEDIATE", anchor: i.received_on, due: addBusinessDays(i.received_on, 1, cal), satisfied_by: "regulatory.action.notice_sent{evidence_document_id present}" },
    partner_notice: i.entity === "supermortgage" ? { code: "SM_PARTNER_NOTIFY_SUB_EVENT_1BD", due: nextBusinessDay(i.received_on, cal) } : null,
  };
}
/** A drafted or "sent" notice without sent evidence never satisfies the timer. */
export function regulatoryNoticeSatisfies(e: { sent: boolean; evidence_document_id: string | null }): boolean { return e.sent && e.evidence_document_id !== null && e.evidence_document_id !== ""; }

export interface SubservicingArrangement { readonly master_entity: string; readonly sub_entity: string; readonly master_servicer_number: string; readonly sub_servicer_number: string; readonly loan_count: number; readonly upb_cents: Cents; readonly status: "active" | "terminated"; }
/** Rule 18.4-2: the Subservicing screen — Supermortgage answers "subservice for others = YES" listing each master with FYE loan count/UPB reconciled to the Section 5 position. */
export function subservicingScreen(i: { entity: "supermortgage" | "partner"; fye: PlainDate; arrangements: readonly SubservicingArrangement[]; section5_position: { loan_count: number; upb_cents: Cents }; subcontracts_servicing?: boolean }): { subservice_for_others: "YES" | "NO"; use_subservicer: "YES" | "NO"; listed: { servicer_number: string; entity: string; loan_count: number; upb_cents: Cents; as_of: PlainDate }[]; reconciled: boolean; variance: { loan_count: number; upb_cents: Cents }; verify_allowed: boolean; refusal: string | null } {
  const active = i.arrangements.filter((a) => a.status === "active");
  const asSub = active.filter((a) => a.sub_entity === i.entity);
  const asMaster = active.filter((a) => a.master_entity === i.entity);
  const listed = (i.entity === "supermortgage" ? asSub : asMaster).map((a) => ({ servicer_number: i.entity === "supermortgage" ? a.master_servicer_number : a.sub_servicer_number, entity: i.entity === "supermortgage" ? a.master_entity : a.sub_entity, loan_count: a.loan_count, upb_cents: a.upb_cents, as_of: i.fye }));
  const totalCount = listed.reduce((s, a) => s + a.loan_count, 0); const totalUpb = listed.reduce((s, a) => s + a.upb_cents, 0n);
  const variance = { loan_count: totalCount - i.section5_position.loan_count, upb_cents: totalUpb - i.section5_position.upb_cents };
  const reconciled = variance.loan_count === 0 && variance.upb_cents === 0n;
  return { subservice_for_others: asSub.length > 0 ? "YES" : "NO", use_subservicer: (i.entity === "partner" ? asMaster.length > 0 : Boolean(i.subcontracts_servicing)) ? "YES" : "NO", listed, reconciled, variance, verify_allowed: reconciled, refusal: reconciled ? null : `subservicing screen cannot be verified: FYE loan count/UPB differ from the Section 5 position by ${variance.loan_count} loans / ${variance.upb_cents}¢` };
}

// ============================================================ 18.5 fraud
/** Guardrail 18.5: a determination is the fraud officer's act — no report is drafted for signature on the agent's recommendation alone, whatever its confidence. */
export function reportDraftGate(i: { agent_recommendation: { determination: "reasonable_basis" | "unfounded" | "inconclusive"; confidence: number } | null; officer_determination: { determination: "reasonable_basis" | "unfounded" | "inconclusive"; determined_by_officer_id: string; determined_at: string } | null }): { allowed: boolean; refusal: string | null; next_step: "officer:fraud_officer determination" | "draft_for_officer_signature" | "close_unfounded" } {
  if (!i.officer_determination) return { allowed: false, refusal: `report draft refused: no recorded officer:fraud_officer determination${i.agent_recommendation ? ` (agent recommended ${i.agent_recommendation.determination} at confidence ${i.agent_recommendation.confidence})` : ""} — determinations are human acts (A3-4-03 "reasonable basis")`, next_step: "officer:fraud_officer determination" };
  return i.officer_determination.determination === "reasonable_basis" ? { allowed: true, refusal: null, next_step: "draft_for_officer_signature" } : { allowed: false, refusal: `determination ${i.officer_determination.determination}: no Fannie Mae report`, next_step: "close_unfounded" };
}
/** Rule A3-2-01: a validated finding over 500 loans or 1% of prior-year deliveries starts the 60-day LQC self-report clock from the later of quarter-end and discovery. */
export function breachSelfReportTrigger(i: { affected_count: number; prior_year_deliveries: number; breach_quarter_end: PlainDate; discovered_on: PlainDate; validated_on: PlainDate }): { required: boolean; basis: "count_over_500" | "pct_over_1" | null; timer: "FNMA_A3201_BREACH_SELF_REPORT_60"; anchor: PlainDate | null; due: PlainDate | null; channel: "lqc_self_report" } {
  const pct = i.prior_year_deliveries > 0 ? i.affected_count / i.prior_year_deliveries : 0;
  const basis = i.affected_count > 500 ? "count_over_500" : pct >= 0.01 ? "pct_over_1" : null;
  const anchor = basis ? (i.discovered_on > i.breach_quarter_end ? i.discovered_on : i.breach_quarter_end) : null;
  return { required: basis !== null, basis, timer: "FNMA_A3201_BREACH_SELF_REPORT_60", anchor, due: anchor ? addDays(anchor, 60) : null, channel: "lqc_self_report" };
}
/** Quarter-end of the quarter containing a date (the A3-2-01 "in a quarter" anchor). */
export function quarterEndOf(d: PlainDate): PlainDate { const m = parts(d).m; return endOfMonth(addMonths(d, 2 - ((m - 1) % 3))); }
/** Guardrail 18.5: red-flag rates by protected class run through the 18.1 fairness suite; an adverse-impact ratio < 0.80 opens a rule-review finding routed via counsel. */
export function fraudFlagFairness(i: { quarter: string; reference_flag_rate: number; protected_flag_rate: number }): { ratio: number; finding: { kind: "rule_review"; scope: "fraud_red_flag_rules"; route: "attorney"; privileged: true; quarter: string } | null } {
  const s = fairnessScreen(i.reference_flag_rate, i.protected_flag_rate);
  return { ratio: s.ratio, finding: s.finding ? { kind: "rule_review", scope: "fraud_red_flag_rules", route: "attorney", privileged: true, quarter: i.quarter } : null };
}

// ============================================================ 18.6 Reg AB
const criterionOf = (node: string): string | null => { const m = /1122\.d\.?(\d)\.?([ivx]+)$/i.exec(node.replace(/^regab\./, "")); return m ? `1122.d.${m[1]}.${m[2]!.toLowerCase()}` : null; };
export interface ControlException { readonly finding_id: string; readonly criterion: string; readonly severity: string; readonly description: string; readonly status: "open" | "dispositioned"; readonly officer_disposition: { officer_id: string; disposition: string } | null; }
/** Rule 18.6-3: every 18.1 finding tagged to a 1122(d) criterion is on the exception list until the officer dispositions it. */
export function exceptionList(i: { findings: readonly { id: string; severity: string; taxonomy_nodes: readonly string[]; description: string }[]; dispositions?: readonly { finding_id: string; officer_id: string; disposition: string }[] }): ControlException[] {
  const out: ControlException[] = [];
  for (const f of i.findings) for (const node of f.taxonomy_nodes) {
    const c = criterionOf(node); if (!c) continue;
    const d = i.dispositions?.find((x) => x.finding_id === f.id) ?? null;
    out.push({ finding_id: f.id, criterion: c, severity: f.severity, description: f.description, status: d ? "dispositioned" : "open", officer_disposition: d ? { officer_id: d.officer_id, disposition: d.disposition } : null });
  }
  return out;
}
export function removeException(i: { exception: ControlException; officer_disposition: { officer_id: string; rationale: string } | null }): { removed: boolean; refusal: string | null } {
  return exceptionRemovable(i.officer_disposition !== null && i.officer_disposition.rationale.length > 0) ? { removed: true, refusal: null } : { removed: false, refusal: `exception ${i.exception.finding_id} (${i.exception.criterion}) stays on the list until an officer disposition with rationale is recorded` };
}
/** Rule 18.6-4: `control_evidence.generate(period)` for any window — the issuer's PSA year, not Supermortgage's fiscal year. */
export function generateControlEvidence(i: { period_start: PlainDate; period_end: PlainDate; matrix: readonly { control_code: string; criterion: string }[]; evidence: readonly { control_code: string; occurred_on: PlainDate; document_id: string; exception?: boolean }[]; supermortgage_fye: PlainDate }): { period: { start: PlainDate; end: PlainDate }; fiscal_year_basis: "issuer_psa_period"; supermortgage_fye: PlainDate; rows: { control_code: string; criterion: string; evidence_document_ids: string[]; exceptions_count: number }[]; complete: boolean } {
  const inWindow = (d: PlainDate) => d >= i.period_start && d <= i.period_end;
  const rows = i.matrix.map((m) => { const ev = i.evidence.filter((e) => e.control_code === m.control_code && inWindow(e.occurred_on)); return { control_code: m.control_code, criterion: m.criterion, evidence_document_ids: ev.map((e) => e.document_id), exceptions_count: ev.filter((e) => e.exception).length }; });
  return { period: { start: i.period_start, end: i.period_end }, fiscal_year_basis: "issuer_psa_period", supermortgage_fye: i.supermortgage_fye, rows, complete: rows.every((r) => r.evidence_document_ids.length > 0) };
}
/** Rule 18.6-3: a material instance of noncompliance is disclosed in the assessment and to the partner within 1 BD. */
export function materialNoncompliance(i: { determined_on: PlainDate; criterion: string; description: string; determined_by_role: string; counsel_advice_document_id: string | null; cal?: Calendar }): { allowed: boolean; refusal: string | null; partner_notice: { code: "SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD"; due: PlainDate } | null; assessment_text: string | null; form_10k_disclosure: boolean } {
  if (i.determined_by_role !== "officer") return { allowed: false, refusal: "material noncompliance is determined by the officer on counsel's advice", partner_notice: null, assessment_text: null, form_10k_disclosure: false };
  const text = `Material instance of noncompliance with servicing criterion ${i.criterion} (17 CFR 229.1122(d)): ${i.description}. Determined ${i.determined_on}${i.counsel_advice_document_id ? ` on counsel's advice (${i.counsel_advice_document_id})` : ""}; remediation tracked as an 18.1 CAPA.`;
  return { allowed: true, refusal: null, partner_notice: { code: "SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD", due: addBusinessDays(i.determined_on, 1, i.cal ?? servicer) }, assessment_text: text, form_10k_disclosure: true };
}

// ============================================================ 18.7 eligibility
/** Integration rule 18.7: a missing GL close at BD5 computes on the prior close flagged `stale`; the quarterly certification waits for a fresh close. */
export function monthlyEligibilityRun(i: { period_end: PlainDate; bd5: PlainDate; today: PlainDate; gl_close: { period_end: PlainDate; received_on: PlainDate } | null; quarter_end: boolean }): { stale: boolean; computed_on: { basis: "fresh_close" | "prior_close"; period_end: PlainDate | null }; certification_allowed: boolean; refusal: string | null } {
  const fresh = i.gl_close !== null && i.gl_close.period_end === i.period_end && i.gl_close.received_on <= i.bd5;
  const stale = glStale(fresh);
  const blocked = stale && i.quarter_end;
  return { stale, computed_on: { basis: fresh ? "fresh_close" : "prior_close", period_end: i.gl_close?.period_end ?? null }, certification_allowed: !blocked, refusal: blocked ? `quarterly certification refused: GL close for ${i.period_end} not received by BD5 (${i.bd5}) — result is stale` : null };
}
