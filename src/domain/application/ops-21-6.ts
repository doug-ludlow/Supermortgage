/**
 * §21.6 Application-status decisions — the pure rules of the `underwriter` agent over the decision file of an
 * `applications` aggregate (migration 0068: decisions, adverse_actions, noias, withdrawals, hmda_records). One small
 * function per rule / T-id; every function validates, returns a new copy of the file and appends its event with
 * `applicationId` (origination timers arm only on origination context — src/kernel/timers/engine.ts).
 *
 * Events (subject = the application):
 *   application.completion.checked{outstanding, outstanding_items, checkpoint_day, application_date, completed_application_at}   [arms REGB_1002_9_NOIA at the day-20 checkpoint]
 *   decision.recommended{kind∈{denial, counteroffer, incomplete}, decision_id, recommended_on, sla_due_on}   [arms SM_UNDERWRITING_REVIEWER_SLA_2BD; opens the `underwriting_reviewer` escalation]
 *   decision.reviewed{outcome∈{approved, returned}, kind, decided_on, after_conditional_approval, co_admt_applies, reviewer_id}   [satisfies the SLA; arms SM_ADVERSE_NOTICE_5BD / CO_SB26_189_1704_ADVERSE_EXPLANATION_30]
 *   decision.issued{kind, decided_on, sent_on, consequential, combined_notice}   [the Reg B notification of action taken — satisfies REGB_1002_9_DECISION_30 / REGB_1002_9_NOIA; kind=counteroffer arms REGB_1002_9_COUNTEROFFER_90]
 *   notice.adverse_action.sent{notice_ids, sent_on, combined_notice} · noia.sent{sent_on, designated_period_days, response_due_on, written} · noia.responded{responded_on}
 *   application.closed_incomplete{closed_on} · application.withdrawn{express, received_on, channel} · counteroffer.accepted · counteroffer.expired
 *   counteroffer.resolved{outcome∈{accepted, combined_notice_sent, adverse_action_sent}}   [satisfies REGB_1002_9_COUNTEROFFER_90 — comment 9(a)(1)-6 for the C-4 path]
 *   co_admt.explanation.sent · co_admt.human_review.requested/completed · co_admt.correction.requested/completed · co_admt.preuse_notice.delivered
 *   hmda.action_taken.recorded{action_taken, action_taken_date, denial_reasons} · decision.clock.breached{incident_id} · explanation.discouragement.blocked{findings}
 */
import { type PlainDate, addDays, addYears, daysBetween, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor } from "../../kernel/calendar/business.ts";
import { toIso, wallClock, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { EscalationService, Escalation } from "../../app/escalations.ts";
import { CRA_CONTACTS } from "./ops-21-3.ts";

export const UNDERWRITER_AGENT: Actor = { kind: "agent", id: "underwriter" };
export const COMPLIANCE_SENTINEL: Actor = { kind: "agent", id: "compliance-sentinel" };
export const RULE_SET_VERSION_21_6 = "regb.2026+regc.hmda.2026+co.sb26_189+fnma.du.12.1";
export const NOTICE_CODES_21_6 = { adverse_action: "NTC_REGB_1002_9_ADVERSE_ACTION", counteroffer: "NTC_REGB_1002_9_COUNTEROFFER", noia: "NTC_REGB_1002_9_NOIA", co_admt: "NTC_CO_SB26_189_ADMT_NOTICE" } as const;
/** §1002.9(a)(1)(i): 30 days after receiving a completed application — the conservative anchor is the Reg B application date (rule 1). */
export const REGB_DECISION_DAYS = 30;
/** §1002.9(a)(1)(iv): 90 days after notifying the applicant of a counteroffer. */
export const REGB_COUNTEROFFER_DAYS = 90;
/** Policy: a counteroffer expires by its own terms after 15 calendar days (comment 9(a)(1)-5 requires no period). */
export const COUNTEROFFER_DEFAULT_EXPIRY_DAYS = 15;
/** §1002.9(c)(2): "a reasonable period of time" — default 14, never below 10 (policy). */
export const NOIA_DEFAULT_PERIOD_DAYS = 14;
export const NOIA_MIN_PERIOD_DAYS = 10;
/** Rule 1 / guardrails: the reviewer queue is re-prioritised and the partner `officer` alerted at `decision_due − 3 days`. */
export const DECISION_AT_RISK_DAYS = 3;
export const REVIEWER_SLA_BUSINESS_DAYS = 2;
export const ADVERSE_NOTICE_POLICY_BUSINESS_DAYS = 5;
export const NOIA_CHECKPOINT_DAY = 20;
/** SB 26-189 Section 5(3): applies to consequential decisions made on or after Jan 1, 2027 (`rule_sets.co.sb26_189.effective_from`). */
export const CO_SB26_189_EFFECTIVE_FROM = plainDate("2027-01-01");
export const CO_EXPLANATION_DAYS = 30;
export const CO_HUMAN_REVIEW_DAYS = 30;
export const CO_RECORDS_YEARS = 3;
/** 12 CFR 1002.9(b)(1) ECOA notice (post-July 21, 2026 text — §1002.9 was not amended). */
export const ECOA_NOTICE_TEXT = "The Federal Equal Credit Opportunity Act prohibits creditors from discriminating against credit applicants on the basis of race, color, religion, national origin, sex, marital status, age (provided the applicant has the capacity to enter into a binding contract); because all or part of the applicant's income derives from any public assistance program; or because the applicant has in good faith exercised any right under the Consumer Credit Protection Act.";
/** Appendix A item 9 (retailers, finance companies and all other creditors): a non-bank partner names the FTC; item 1 for banks over $10 billion. */
export const FEDERAL_AGENCY_BLOCKS = {
  ftc: { name: "Federal Trade Commission", address: "Consumer Response Center, 600 Pennsylvania Avenue NW, Washington, DC 20580" },
  cfpb: { name: "Bureau of Consumer Financial Protection", address: "1700 G Street NW, Washington, DC 20552" },
} as const;
export type FederalAgency = keyof typeof FEDERAL_AGENCY_BLOCKS;
export const FCRA_NO_DECISION_STATEMENT = "The consumer reporting agency did not make the decision to take the adverse action and is unable to provide you the specific reasons why the adverse action was taken.";
export const FCRA_FREE_REPORT_STATEMENT = "You have the right to obtain a free copy of your consumer report from the consumer reporting agency named above within 60 days of receiving this notice.";
export const FCRA_DISPUTE_STATEMENT = "You have the right to dispute with the consumer reporting agency the accuracy or completeness of any information in your consumer report.";
export const FCRA_MAX_KEY_FACTORS = 4;
export const FCRA_MAX_KEY_FACTORS_WITH_INQUIRIES = 5;
export const SCORE_RANGE_LOW = 300;
export const SCORE_RANGE_HIGH = 850;
export const SCORE_MODEL_LABELS: Record<string, string> = { classic_fico: "Classic FICO", vantagescore_4: "VantageScore 4.0" };

// ============================================================ reason taxonomy (rule_sets.ecoa_reasons; comments 9(b)(2)-1 to -9)
export type ReasonSource = "rules" | "judgmental" | "credit_report" | "valuation" | "verification" | "mi";
export interface ReasonDef { readonly statement_text: string; readonly hmda_denial_code: number; readonly free_text?: true }
export const ECOA_REASONS: Record<string, ReasonDef> = {
  dti_excessive: { statement_text: "Excessive obligations in relation to income", hmda_denial_code: 1 },
  income_insufficient: { statement_text: "Income insufficient for amount of credit requested", hmda_denial_code: 1 },
  income_unverifiable: { statement_text: "Unable to verify income", hmda_denial_code: 6 },
  employment_unverifiable: { statement_text: "Unable to verify employment", hmda_denial_code: 6 },
  employment_length: { statement_text: "Length of employment", hmda_denial_code: 2 },
  credit_delinquent: { statement_text: "Delinquent past or present credit obligations with others", hmda_denial_code: 3 },
  credit_bankruptcy: { statement_text: "Bankruptcy", hmda_denial_code: 3 },
  credit_foreclosure: { statement_text: "Foreclosure or repossession", hmda_denial_code: 3 },
  credit_no_file: { statement_text: "No credit file", hmda_denial_code: 3 },
  credit_limited: { statement_text: "Limited credit experience", hmda_denial_code: 3 },
  collateral_value: { statement_text: "Value or type of collateral not sufficient", hmda_denial_code: 4 },
  collateral_condition: { statement_text: "Property condition does not meet requirements", hmda_denial_code: 4 },
  collateral_ineligible_project: { statement_text: "Condominium/PUD project not eligible", hmda_denial_code: 4 },
  cash_insufficient: { statement_text: "Insufficient funds for down payment, closing costs, or reserves", hmda_denial_code: 5 },
  assets_unverifiable: { statement_text: "Unable to verify assets or source of funds", hmda_denial_code: 6 },
  mi_denied: { statement_text: "Mortgage insurance denied", hmda_denial_code: 8 },
  incomplete: { statement_text: "Credit application incomplete", hmda_denial_code: 7 },
  residency_status: { statement_text: "Residency/eligibility requirements not met", hmda_denial_code: 9 },
  identity_unverified: { statement_text: "Unable to verify identity", hmda_denial_code: 6 },
  misrepresentation: { statement_text: "Misrepresentation in application", hmda_denial_code: 6 },
  other_specific: { statement_text: "", hmda_denial_code: 9, free_text: true },
};
/** Partner rule ids → taxonomy codes (23.3's `decision_factors[].rule_id`); a factor may also carry `reason_code` itself. */
export const RULE_REASON_MAP: Record<string, string> = {
  dti_max_50: "dti_excessive", dti_max_45: "dti_excessive", dti_max: "dti_excessive", income_min: "income_insufficient", income_verified: "income_unverifiable", employment_verified: "employment_unverifiable",
  employment_history_2y: "employment_length", credit_delinquent: "credit_delinquent", mortgage_lates_12m: "credit_delinquent", bankruptcy_seasoning: "credit_bankruptcy", foreclosure_seasoning: "credit_foreclosure",
  credit_file_present: "credit_no_file", tradelines_min: "credit_limited", ltv_max: "collateral_value", appraisal_value: "collateral_value", property_condition: "collateral_condition", project_eligible: "collateral_ineligible_project",
  funds_to_close: "cash_insufficient", reserves_min: "cash_insufficient", assets_verified: "assets_unverifiable", mi_approved: "mi_denied", ofac_clear: "identity_unverified", identity_verified: "identity_unverified", fraud_clear: "misrepresentation",
  legal_presence: "residency_status", loan_amount_limit: "other_specific",
};
/** Never a reason (§1002.9(b)(2); B3-2-11; §1002.4(b)): a DU recommendation, an internal-standards or score-cutoff statement, or any prohibited-basis word. */
export const PROHIBITED_REASON_PATTERNS: readonly RegExp[] = [/refer with caution/i, /approve\/?ineligible/i, /internal (standards|policies)/i, /(qualifying|minimum) score|score cutoff|did not meet (the |our )?(score|cutoff)/i, /\b(race|color|religion|national origin|sex|gender|marital status|age|public assistance)\b/i, /\bDU\b|desktop underwriter/i];
export const PROHIBITED_BASIS_LEXICON: readonly RegExp[] = [/\b(race|racial|color|religion|religious|national origin|immigrant|immigrants|sex|gender|marital status|married|single mother|divorced|age|elderly|older|public assistance|welfare|food stamps|disability)\b/i, /\b(people|applicants|borrowers|folks|families) (like you|of your kind|from your (area|neighborhood|community|zip))\b/i, /\b(your (area|neighborhood|community|zip code|part of town))\b/i];
/** §1002.4(b) discouragement: a statement a reasonable person would read as predicting denial or worse terms for a group or place. */
export const DISCOURAGEMENT_PATTERNS: readonly RegExp[] = [/\b(usually|typically|rarely|generally|never|seldom|don'?t|do not|won'?t) (don'?t |do not )?(qualify|get approved|approve)/i, /\b(not (worth|a good idea) (to )?apply)/i, /\bwouldn'?t bother applying\b/i];

// ============================================================ the decision file (decisions, adverse_actions, noias, withdrawals, hmda_records)
export type DecisionKind = "conditional_approval" | "approval" | "counteroffer" | "denial" | "incomplete" | "withdrawal" | "file_closed_incomplete" | "approved_not_accepted";
export const DECISION_KINDS: readonly DecisionKind[] = ["conditional_approval", "approval", "counteroffer", "denial", "incomplete", "withdrawal", "file_closed_incomplete", "approved_not_accepted"];
export type Disposition = "open" | "conditional_approval" | "approved" | "counteroffer_pending" | "counteroffer_accepted" | "denied" | "withdrawn" | "closed_incomplete" | "approved_not_accepted" | "originated" | "incomplete_noia_sent";
export const TERMINAL_DISPOSITIONS: readonly Disposition[] = ["originated", "denied", "withdrawn", "closed_incomplete", "approved_not_accepted"];
export type BasisComponent = "rules" | "judgmental" | "combined" | "automatic_denial_factor";
export type AdverseKind = "denial" | "denial_incomplete" | "counteroffer_not_accepted" | "denial_after_counteroffer" | "counteroffer";
export type DuRecommendation = "approve_eligible" | "approve_ineligible" | "refer_with_caution" | "out_of_scope" | "error";
export interface DecisionFactor {
  readonly rule_id: string; readonly description: string; readonly threshold: string | null; readonly observed: string | null; readonly applicant_ids: readonly string[]; readonly evidence_document_ids: readonly string[]; readonly failed: boolean;
  readonly reason_code?: string; readonly source?: ReasonSource; readonly automatic?: boolean; readonly materiality?: number; readonly other_text?: string;
}
export interface PrincipalReason { readonly reason_code: string; readonly statement_text: string; readonly factor_ref: string; readonly source: ReasonSource; readonly hmda_denial_code: number; readonly automatic: boolean; readonly materiality: number; }
export interface CraContact { readonly name: string; readonly address: string; readonly phone: string; readonly toll_free: string; }
export interface FcraBlock {
  readonly applicant_id: string; readonly used_consumer_report: true; readonly cra: readonly CraContact[]; readonly no_score: boolean; readonly score: number | null; readonly score_range_low: number; readonly score_range_high: number;
  readonly key_factors: readonly string[]; readonly key_factor_count: number; readonly inquiries_key_factor: boolean; readonly score_date: PlainDate | null; readonly score_provider: string | null; readonly model: string | null; readonly bureau: string | null;
  readonly no_decision_statement: string; readonly free_report_statement: string; readonly dispute_statement: string;
}
export interface CounterofferTerms { readonly loan_amount_cents: Cents; readonly note_rate: string; readonly product_code: string; readonly ltv: string; readonly conditions: readonly string[]; readonly expires_on: PlainDate; }
export interface CoAdmt {
  readonly applies: boolean; readonly pre_use_notice_id: string | null; readonly explanation_due_on: PlainDate | null; readonly explanation_notice_id: string | null; readonly explanation_sent_at: string | null;
  readonly human_review_requested_at: string | null; readonly human_review_due_on: PlainDate | null; readonly human_review_reviewer_id: string | null; readonly human_review_completed_at: string | null; readonly human_review_outcome: string | null;
  readonly correction_requested_at: string | null; readonly correction_completed_at: string | null;
}
export interface DecisionRow {
  readonly decision_id: string; readonly application_id: string; readonly kind: DecisionKind; readonly recommended_at: string; readonly decided_at: string | null; readonly basis_component: BasisComponent; readonly decision_factors: readonly DecisionFactor[];
  readonly counteroffer_terms: CounterofferTerms | null; readonly combined_notice: boolean; readonly reviewer_escalation_id: string | null; readonly reviewer_id: string | null; readonly reviewer_decided_at: string | null; readonly reviewer_outcome: "approved" | "returned" | null; readonly reviewer_sla_due_on: PlainDate | null;
  readonly notice_id: string | null; readonly sent_at: string | null; readonly hmda_action_taken: number | null; readonly hmda_action_taken_date: PlainDate | null; readonly after_conditional_approval: boolean; readonly du_recommendation: DuRecommendation | null; readonly data_sufficient: boolean;
}
export interface AdverseActionRow {
  readonly adverse_action_id: string; readonly application_id: string; readonly decision_id: string; readonly kind: AdverseKind; readonly principal_reasons: readonly PrincipalReason[]; readonly per_applicant: readonly { applicant_id: string; notice_id: string | null; fcra_block: FcraBlock | null; delivery: string | null }[];
  readonly federal_agency_block: { name: string; address: string }; readonly state_overlays: readonly string[]; readonly co_admt: CoAdmt | null; readonly reviewer_escalation_id: string | null; readonly approved_by_reviewer_at: string | null; readonly approving_reviewer_id: string | null; readonly sent_at: string | null; readonly retention_class: readonly string[];
}
export interface NoiaRow { readonly noia_id: string; readonly application_id: string; readonly decision_id: string; readonly items_needed: readonly { item: string; description: string }[]; readonly designated_period_days: number; readonly sent_at: string | null; readonly sent_on: PlainDate | null; readonly response_due_on: PlainDate | null; readonly oral_request_at: string | null; readonly responded_at: string | null; readonly closed_at: string | null; }
export interface WithdrawalRow { readonly withdrawal_id: string; readonly application_id: string; readonly received_at: string; readonly received_on: PlainDate; readonly channel: string; readonly statement_text: string; readonly evidence_document_id: string | null; readonly express: boolean; readonly after_decision: boolean; }
export interface HmdaFields { readonly action_taken: number; readonly action_taken_date: PlainDate; readonly denial_reasons: readonly number[]; readonly denial_reason_other_text: string | null; readonly basis: string; }
export interface Applicant { readonly id: string; readonly name: string; readonly mailing_address: string; readonly email?: string; readonly esign_consent: boolean; readonly primary: boolean; readonly state?: string | null; }
export interface OpenCondition { readonly condition_id: string; readonly kind: "customary_closing" | "creditworthiness"; readonly description: string; }
export const CUSTOMARY_CLOSING_CONDITIONS: readonly string[] = ["clear_title", "survey", "termite_inspection", "subordination_agreement", "settlement_statement"];
export const CREDITWORTHINESS_CONDITIONS: readonly string[] = ["counteroffer_terms", "dti", "ltv", "pmi_determination", "appraisal", "income_verification", "asset_verification", "employment_verification"];
export type RegularlyObtainedItem = "credit_report" | "income_verification" | "asset_verification" | "employment_verification" | "valuation" | "title_commitment" | "mi_decision" | "du_findings";
export const REGULARLY_OBTAINED_ITEMS: readonly RegularlyObtainedItem[] = ["credit_report", "income_verification", "asset_verification", "employment_verification", "valuation", "title_commitment", "mi_decision", "du_findings"];
export interface DecisionFile {
  readonly application_id: string; readonly partner_name: string; readonly partner_address: string; readonly federal_agency: FederalAgency; readonly creditor_time_zone: string;
  readonly application_date: PlainDate; readonly decision_due_on: PlainDate; readonly decision_due_at: string; readonly completed_application_at: string | null; readonly disposition: Disposition;
  readonly property_state: string; readonly consumer_state: string | null; readonly applicants: readonly Applicant[]; readonly items_received: Partial<Record<RegularlyObtainedItem, string>>; readonly items_required: readonly RegularlyObtainedItem[];
  readonly admt_materially_influenced: boolean; readonly decisions: readonly DecisionRow[]; readonly adverse_actions: readonly AdverseActionRow[]; readonly noias: readonly NoiaRow[]; readonly withdrawals: readonly WithdrawalRow[]; readonly hmda: HmdaFields | null;
  readonly conditional_approval: { approved_on: PlainDate; expires_on: PlainDate; open_conditions: readonly OpenCondition[] } | null; readonly last_borrower_activity_at: string | null; readonly lock_id: string | null;
  readonly original_terms: { loan_amount_cents: Cents; note_rate: string; product_code: string; ltv: string } | null; readonly retention_classes: readonly string[];
}
export interface NewDecisionFileInput { readonly application_id: string; readonly partner_name: string; readonly partner_address: string; readonly federal_agency?: FederalAgency; readonly creditor_time_zone: string; readonly application_date: string; readonly property_state: string; readonly consumer_state?: string | null; readonly applicants: readonly Applicant[]; readonly items_required?: readonly RegularlyObtainedItem[]; readonly admt_materially_influenced?: boolean; readonly lock_id?: string | null; readonly original_terms?: DecisionFile["original_terms"]; }

const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const isoInstant = (v: unknown, what: string): string => { const s = nonEmpty(v, what); if (Number.isNaN(Date.parse(s))) throw new RangeError(`${what} ${JSON.stringify(v)} is not an ISO instant`); return s; };
/** The creditor's civil date of an instant (Reg B dates are the creditor's calendar dates). */
export const civilDate = (iso: string, tz: string): PlainDate => wallClock(Date.parse(iso), tz).date;
const emit = (events: EventStore, file: DecisionFile, type: string, payload: Record<string, unknown>, at: string, actor: Actor = UNDERWRITER_AGENT): DomainEvent =>
  events.append({ type, applicationId: file.application_id, aggregate: { kind: "application", id: file.application_id }, actor, occurredAt: at, payload: { application_id: file.application_id, ...payload } });
const withDecision = (file: DecisionFile, d: DecisionRow): DecisionFile => ({ ...file, decisions: file.decisions.some((x) => x.decision_id === d.decision_id) ? file.decisions.map((x) => (x.decision_id === d.decision_id ? d : x)) : [...file.decisions, d] });
const withAdverse = (file: DecisionFile, a: AdverseActionRow): DecisionFile => ({ ...file, adverse_actions: file.adverse_actions.some((x) => x.adverse_action_id === a.adverse_action_id) ? file.adverse_actions.map((x) => (x.adverse_action_id === a.adverse_action_id ? a : x)) : [...file.adverse_actions, a] });
const withNoia = (file: DecisionFile, n: NoiaRow): DecisionFile => ({ ...file, noias: file.noias.some((x) => x.noia_id === n.noia_id) ? file.noias.map((x) => (x.noia_id === n.noia_id ? n : x)) : [...file.noias, n] });
export const decisionOf = (file: DecisionFile, decision_id: string): DecisionRow => { const d = file.decisions.find((x) => x.decision_id === decision_id); if (!d) throw new RangeError(`no decision ${decision_id} on application ${file.application_id}`); return d; };
export const adverseOf = (file: DecisionFile, decision_id: string): AdverseActionRow | null => file.adverse_actions.find((a) => a.decision_id === decision_id) ?? null;
const assertNotTerminal = (file: DecisionFile): void => { if (TERMINAL_DISPOSITIONS.includes(file.disposition)) throw new RangeError(`application ${file.application_id} already has its one terminal disposition (${file.disposition})`); };

// ============================================================ rule 1: clocks
/** `decision_due = application_date + 30 calendar days`, end of day in the creditor's time zone (fixture: Mon Oct 5 → Wed Nov 4, 2026 23:59 MST; purchase Oct 19 → Nov 18). */
export function decisionClock(applicationDate: PlainDate, tz: string): { decision_due_on: PlainDate; decision_due_at: string; at_risk_on: PlainDate } {
  const decision_due_on = addDays(applicationDate, REGB_DECISION_DAYS);
  return { decision_due_on, decision_due_at: toIso(zonedEpochMs(decision_due_on, "23:59", tz)), at_risk_on: addDays(decision_due_on, -DECISION_AT_RISK_DAYS) };
}
export function newDecisionFile(i: NewDecisionFileInput): DecisionFile {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.partner_name, "partner_name"); nonEmpty(i.partner_address, "partner_address"); nonEmpty(i.creditor_time_zone, "creditor_time_zone");
  if (!i.applicants.length) throw new RangeError("a decision file needs at least one applicant (§1002.9(f): the primary applicant receives the notice)");
  const application_date = plainDate(i.application_date); const clock = decisionClock(application_date, i.creditor_time_zone);
  return { application_id: i.application_id, partner_name: i.partner_name, partner_address: i.partner_address, federal_agency: i.federal_agency ?? "ftc", creditor_time_zone: i.creditor_time_zone, application_date, decision_due_on: clock.decision_due_on, decision_due_at: clock.decision_due_at,
    completed_application_at: null, disposition: "open", property_state: i.property_state, consumer_state: i.consumer_state ?? null, applicants: i.applicants.some((a) => a.primary) ? i.applicants : i.applicants.map((a, n) => ({ ...a, primary: n === 0 })),
    items_received: {}, items_required: i.items_required ?? REGULARLY_OBTAINED_ITEMS, admt_materially_influenced: i.admt_materially_influenced ?? true, decisions: [], adverse_actions: [], noias: [], withdrawals: [], hmda: null, conditional_approval: null, last_borrower_activity_at: null,
    lock_id: i.lock_id ?? null, original_terms: i.original_terms ?? null, retention_classes: ["regb_25m", "hmda_3y", "fnma_loan_file_life_plus_4y"] };
}
/** Legal completion (§1002.2(f)): `completed_application_at` = the receipt of the last regularly-obtained item; the conservative clock still binds (never later). Emits the checkpoint fact that arms `REGB_1002_9_NOIA` from day 20. */
export function computeCompletion(events: EventStore, file: DecisionFile, i: { received?: Partial<Record<RegularlyObtainedItem, string>>; as_of: string }): { file: DecisionFile; outstanding: readonly RegularlyObtainedItem[]; completed_application_at: string | null; checkpoint_day: number; event: DomainEvent } {
  const at = isoInstant(i.as_of, "as_of");
  const items_received = { ...file.items_received, ...(i.received ?? {}) };
  for (const [k, v] of Object.entries(items_received)) { if (!REGULARLY_OBTAINED_ITEMS.includes(k as RegularlyObtainedItem)) throw new RangeError(`${k} is not a regularly-obtained item`); isoInstant(v, k); }
  const outstanding = file.items_required.filter((k) => !items_received[k]);
  const completed_application_at = outstanding.length ? null : Object.values(items_received).reduce((m, v) => (v > m ? v : m), "");
  const checkpoint_day = daysBetween(file.application_date, civilDate(at, file.creditor_time_zone));
  const next: DecisionFile = { ...file, items_received, completed_application_at: completed_application_at || null };
  const event = emit(events, next, "application.completion.checked", { outstanding: outstanding.length > 0, outstanding_items: outstanding, checkpoint_day, application_date: file.application_date, completed_application_at: next.completed_application_at, decision_due_on: file.decision_due_on, binding_clock: "conservative" }, at);
  return { file: next, outstanding, completed_application_at: next.completed_application_at, checkpoint_day, event };
}
export interface ClockStatus { readonly decision_due_on: PlainDate; readonly decision_due_at: string; readonly at_risk_on: PlainDate; readonly days_remaining: number; readonly status: "open" | "at_risk" | "breached" | "notified"; readonly notified_on: PlainDate | null; readonly counteroffer_due_on: PlainDate | null; readonly co_explanation_due_on: PlainDate | null; readonly binding_clock: "conservative"; }
/** The clocks of the decision record: the conservative 30-day clock, the 90-day counteroffer clock and the Colorado explanation clock. */
export function trackDecisionClock(file: DecisionFile, nowIso: string): ClockStatus {
  const today = civilDate(isoInstant(nowIso, "now"), file.creditor_time_zone);
  const notified = file.decisions.find((d) => d.sent_at && ["denial", "counteroffer", "incomplete", "approval", "conditional_approval"].includes(d.kind)) ?? file.decisions.find((d) => d.kind === "withdrawal" || d.kind === "file_closed_incomplete");
  const notified_on = notified ? civilDate(notified.sent_at ?? notified.decided_at ?? notified.recommended_at, file.creditor_time_zone) : null;
  const at_risk_on = addDays(file.decision_due_on, -DECISION_AT_RISK_DAYS);
  const status: ClockStatus["status"] = notified_on ? "notified" : Date.parse(nowIso) > Date.parse(file.decision_due_at) ? "breached" : today >= at_risk_on ? "at_risk" : "open";
  const co = file.decisions.find((d) => d.kind === "counteroffer" && d.sent_at);
  const aa = file.adverse_actions.find((a) => a.co_admt?.applies);
  return { decision_due_on: file.decision_due_on, decision_due_at: file.decision_due_at, at_risk_on, days_remaining: daysBetween(today, file.decision_due_on), status, notified_on, counteroffer_due_on: co ? addDays(civilDate(co.sent_at!, file.creditor_time_zone), REGB_COUNTEROFFER_DAYS) : null, co_explanation_due_on: aa?.co_admt?.explanation_due_on ?? null, binding_clock: "conservative" };
}
/** Breach of REGB_1002_9_DECISION_30 (T1): sev 1 to `compliance-sentinel` and the partner `officer`, an incident record with QC self-identification; the notice still issues immediately. */
export function onDecisionClockBreached(events: EventStore, escalations: EscalationService, file: DecisionFile, nowIso: string): { incident_id: string; escalation: Escalation; escalated_to: readonly string[]; event: DomainEvent } {
  const at = isoInstant(nowIso, "now"); const incident_id = `INC-REGB30-${file.application_id}`; const escalated_to = ["compliance-sentinel", "officer"] as const;
  const escalation = escalations.open({ kind: "sev1", ownerRole: "officer", applicationId: file.application_id, severity: "1", payload: { code: "REGB_1002_9_DECISION_30", incident_id, decision_due_on: file.decision_due_on, escalated_to: [...escalated_to], qc_self_identification: true, root_cause_required: true } }, COMPLIANCE_SENTINEL);
  const event = emit(events, file, "decision.clock.breached", { code: "REGB_1002_9_DECISION_30", incident_id, escalation_id: escalation.id, decision_due_on: file.decision_due_on, escalated_to: [...escalated_to], qc_self_identification: true }, at, COMPLIANCE_SENTINEL);
  return { incident_id, escalation, escalated_to, event };
}
/** SM_UNDERWRITING_REVIEWER_SLA_2BD: +2 creditor business days, capped so `decision_due − 3` is never passed (worked example: Fri Oct 23 → Tue Oct 27; cap Nov 1 not binding). */
export function reviewerSlaDue(recommendedOn: PlainDate, decisionDueOn: PlainDate): { sla_due_on: PlainDate; cap_on: PlainDate; capped: boolean } {
  const uncapped = addBusinessDays(recommendedOn, REVIEWER_SLA_BUSINESS_DAYS, creditor); const cap_on = addDays(decisionDueOn, -DECISION_AT_RISK_DAYS);
  return { sla_due_on: uncapped <= cap_on ? uncapped : cap_on, cap_on, capped: uncapped > cap_on };
}
/** SM_ADVERSE_NOTICE_5BD (policy): a denial after a prior conditional approval → notice within 5 creditor business days of the decision. */
export const adverseNoticePolicyDue = (decidedOn: PlainDate): PlainDate => addBusinessDays(decidedOn, ADVERSE_NOTICE_POLICY_BUSINESS_DAYS, creditor);

// ============================================================ rules 3–4: disposition and principal reasons (comments 9(b)(2)-1 to -9)
export const reasonCodeOf = (f: DecisionFactor): string | null => f.reason_code ?? RULE_REASON_MAP[f.rule_id] ?? (ECOA_REASONS[f.rule_id] ? f.rule_id : null);
const numeric = (s: string | null): number | null => { if (s === null) return null; const n = Number(String(s).replace(/[%$,\s]/g, "")); return Number.isFinite(n) ? n : null; };
/** Materiality (comment 9(b)(2)-5 method 1 analogue for rules): distance of the observed value beyond the threshold, relative to the threshold; automatic factors rank first. */
export function factorMateriality(f: DecisionFactor): number {
  if (f.automatic) return Number.POSITIVE_INFINITY;
  if (typeof f.materiality === "number") return f.materiality;
  const o = numeric(f.observed), t = numeric(f.threshold);
  return o !== null && t !== null && t !== 0 ? Math.abs((o - t) / t) : 0;
}
export function assertReasonText(text: string): void { for (const p of PROHIBITED_REASON_PATTERNS) if (p.test(text)) throw new RangeError(`"${text}" is not a permissible reason (§1002.9(b)(2); B3-2-11; §1002.4(b)): matches ${p}`); }
/** Rule 3: the failed factors, ordered by materiality, at most four, every principal factor included, automatic factors always disclosed, text only from the taxonomy (`other_specific` needs reviewer sign-off). */
export function selectPrincipalReasons(factors: readonly DecisionFactor[], o: { max?: number; reviewer_signed_other_text?: boolean } = {}): PrincipalReason[] {
  const max = o.max ?? 4; if (max < 1 || max > 4) throw new RangeError("comment 9(b)(2)-1: at most four reasons are disclosed");
  const failed = factors.filter((f) => f.failed);
  if (!failed.length) throw new RangeError("no failed factor: an adverse action needs at least one principal reason that is a failed factor in decision_factors");
  const reasons = failed.map((f): PrincipalReason => {
    const code = reasonCodeOf(f); if (!code || !ECOA_REASONS[code]) throw new RangeError(`factor ${f.rule_id} maps to no taxonomy reason (rule_sets.ecoa_reasons)`);
    const def = ECOA_REASONS[code]!;
    let statement_text = def.statement_text;
    if (def.free_text) { if (!o.reviewer_signed_other_text) throw new RangeError("other_specific free text needs underwriting_reviewer sign-off"); statement_text = nonEmpty(f.other_text, "other_text"); if (statement_text.length > 255) throw new RangeError("HMDA code 9 text is at most 255 characters"); }
    assertReasonText(statement_text); assertReasonText(f.description);
    return { reason_code: code, statement_text, factor_ref: f.rule_id, source: f.source ?? "rules", hmda_denial_code: def.hmda_denial_code, automatic: f.automatic === true, materiality: factorMateriality(f) };
  }).sort((a, b) => b.materiality - a.materiality);
  const dedup = reasons.filter((r, n) => reasons.findIndex((x) => x.reason_code === r.reason_code) === n);
  const automatic = dedup.filter((r) => r.automatic), rest = dedup.filter((r) => !r.automatic);
  return [...automatic, ...rest].slice(0, Math.max(max, automatic.length));
}
/** HMDA denial reasons (§1003.4(a)(16)): the principal reasons' codes, deduplicated, at most four; code 9 carries ≤ 255 characters of text. */
export function hmdaDenialReasons(reasons: readonly PrincipalReason[]): { codes: number[]; other_text: string | null } {
  const codes = [...new Set(reasons.map((r) => r.hmda_denial_code))].slice(0, 4);
  const other = reasons.find((r) => r.hmda_denial_code === 9);
  return { codes, other_text: other ? other.statement_text.slice(0, 255) : null };
}
export interface RecommendInput { readonly decision_id: string; readonly factors: readonly DecisionFactor[]; readonly du_recommendation?: DuRecommendation | null; readonly data_verified_and_resubmitted?: boolean; readonly counteroffer_terms?: CounterofferTerms | null; readonly missing_items?: readonly { item: string; description: string }[]; readonly at: string; readonly basis_component?: BasisComponent; readonly data_sufficient?: boolean; }
/** Rule 4 / state machine: the disposition follows the rules component's factor results (never the DU message): failed factors → denial (or the counteroffer the agent proposes); missing items → NOIA; otherwise approval / conditional approval. Adverse kinds open the `underwriting_reviewer` escalation. */
export function recommendDisposition(events: EventStore, escalations: EscalationService, file: DecisionFile, i: RecommendInput): { file: DecisionFile; decision: DecisionRow; kind: DecisionKind; escalation: Escalation | null; sla_due_on: PlainDate | null; event: DomainEvent } {
  assertNotTerminal(file); const at = isoInstant(i.at, "at"); nonEmpty(i.decision_id, "decision_id");
  if (file.decisions.some((d) => d.decision_id === i.decision_id)) throw new RangeError(`decision ${i.decision_id} already exists`);
  if (i.du_recommendation === "refer_with_caution" && !i.data_verified_and_resubmitted) throw new RangeError("B3-2-07: a Refer with Caution is first checked for data accuracy and resubmitted; only a recommendation that stands is decided on the actual factors");
  const failed = i.factors.filter((f) => f.failed); const missing = i.missing_items ?? [];
  const kind: DecisionKind = i.counteroffer_terms ? "counteroffer" : failed.length ? "denial" : missing.length ? "incomplete" : file.completed_application_at && !file.conditional_approval?.open_conditions.some((c) => c.kind === "creditworthiness") ? "approval" : "conditional_approval";
  if (kind === "counteroffer" && !failed.length) throw new RangeError("a counteroffer is adverse action on the requested terms: it needs the failed factor that makes those terms unavailable (§1002.2(c)(1)(i))");
  for (const f of i.factors) assertReasonText(f.description);
  const basis: BasisComponent = i.basis_component ?? (failed.some((f) => f.automatic) ? "automatic_denial_factor" : failed.some((f) => f.source === "judgmental") ? (failed.every((f) => f.source === "judgmental") ? "judgmental" : "combined") : "rules");
  const adverse = kind === "denial" || kind === "counteroffer" || kind === "incomplete";
  const recommended_on = civilDate(at, file.creditor_time_zone); const sla = adverse ? reviewerSlaDue(recommended_on, file.decision_due_on) : null;
  let escalation: Escalation | null = null;
  if (adverse) escalation = escalations.open({ kind: "underwriting_reviewer", applicationId: file.application_id, payload: { decision_id: i.decision_id, kind, factors: i.factors, proposed_reasons: kind === "incomplete" ? [] : selectPrincipalReasons(i.factors, { reviewer_signed_other_text: true }).map((r) => r.statement_text), missing_items: missing, sla_due_on: sla!.sla_due_on, decision_due_on: file.decision_due_on, fair_lending_flags: [] } }, UNDERWRITER_AGENT);
  const decided_at = adverse ? null : at;
  const decision: DecisionRow = { decision_id: i.decision_id, application_id: file.application_id, kind, recommended_at: at, decided_at, basis_component: basis, decision_factors: i.factors, counteroffer_terms: i.counteroffer_terms ?? null, combined_notice: false, reviewer_escalation_id: escalation?.id ?? null, reviewer_id: null, reviewer_decided_at: null, reviewer_outcome: null,
    reviewer_sla_due_on: sla?.sla_due_on ?? null, notice_id: null, sent_at: decided_at, hmda_action_taken: null, hmda_action_taken_date: null, after_conditional_approval: file.disposition === "conditional_approval", du_recommendation: i.du_recommendation ?? null, data_sufficient: i.data_sufficient ?? failed.length > 0 };
  let next = withDecision(file, decision);
  let event: DomainEvent;
  if (adverse) event = emit(events, next, "decision.recommended", { decision_id: i.decision_id, kind, recommended_on, recommended_at: at, sla_due_on: sla!.sla_due_on, escalation_id: escalation!.id, basis_component: basis, factor_count: i.factors.length, failed_factors: failed.map((f) => f.rule_id) }, at);
  else {   // approvals need no human (automation class b): the decision is taken and notified by 23.3's approval letter at once
    next = { ...next, disposition: kind === "approval" ? "approved" : "conditional_approval" };
    event = emit(events, next, "decision.issued", { decision_id: i.decision_id, kind, decided_on: recommended_on, decided_at: at, sent_on: recommended_on, consequential: true, combined_notice: false, co_admt_applies: coDutiesApply(file, recommended_on) }, at);
  }
  return { file: next, decision, kind, escalation, sla_due_on: sla?.sla_due_on ?? null, event };
}
/** T9 / rule 8: silence is never a withdrawal — an incomplete file with no NOIA must get the written NOIA by day 30, or a denial for incompleteness only where the data are insufficient for a decision (comments 9(a)(1)-3/-4). */
export function silenceAssessment(file: DecisionFile, asOfIso: string): { days_silent: number; withdrawal_permitted: false; noia_sent: boolean; required_action: "send_noia" | "decide"; send_noia_by: PlainDate; deny_for_incompleteness_allowed: boolean } {
  const today = civilDate(isoInstant(asOfIso, "as_of"), file.creditor_time_zone);
  const last = file.last_borrower_activity_at ? civilDate(file.last_borrower_activity_at, file.creditor_time_zone) : file.application_date;
  const noia_sent = file.noias.some((n) => n.sent_at);
  const data_sufficient = file.completed_application_at !== null;
  return { days_silent: daysBetween(last, today), withdrawal_permitted: false, noia_sent, required_action: noia_sent || data_sufficient ? "decide" : "send_noia", send_noia_by: file.decision_due_on, deny_for_incompleteness_allowed: !data_sufficient };
}

// ============================================================ reviewer approval (guard: every denial, counteroffer and NOIA)
/** The `underwriting_reviewer`'s own act: approve or return the recommended disposition; `decided_at` is the approval instant (the action is taken then). */
export function reviewDecision(events: EventStore, escalations: EscalationService, file: DecisionFile, i: { decision_id: string; outcome: "approved" | "returned"; reviewer: Actor; at: string; changes?: readonly { field: string; from: unknown; to: unknown; rationale: string }[]; notes?: string | null }): { file: DecisionFile; decision: DecisionRow; event: DomainEvent } {
  const at = isoInstant(i.at, "at"); const d = decisionOf(file, i.decision_id);
  if (i.reviewer.kind !== "human" || i.reviewer.role !== "underwriting_reviewer") throw new RangeError("only an underwriting_reviewer (a named individual under the partner's delegated authority) decides a denial, counteroffer or NOIA");
  if (!d.reviewer_escalation_id) throw new RangeError(`decision ${d.decision_id} (${d.kind}) has no reviewer escalation to decide`);
  if (d.reviewer_decided_at) throw new RangeError(`decision ${d.decision_id} was already reviewed at ${d.reviewer_decided_at}`);
  escalations.complete(d.reviewer_escalation_id, i.reviewer);
  const decided_on = civilDate(at, file.creditor_time_zone);
  const decision: DecisionRow = { ...d, reviewer_id: i.reviewer.id, reviewer_decided_at: at, reviewer_outcome: i.outcome, decided_at: i.outcome === "approved" ? at : null };
  const next = withDecision(file, decision);
  const event = emit(events, next, "decision.reviewed", { decision_id: d.decision_id, outcome: i.outcome, kind: d.kind, reviewer_id: i.reviewer.id, decided_on, decided_at: at, after_conditional_approval: d.after_conditional_approval, co_admt_applies: i.outcome === "approved" && d.kind !== "incomplete" && coDutiesApply(file, decided_on), consequential: d.kind !== "incomplete", changes: i.changes ?? [], notes: i.notes ?? null }, at, i.reviewer);
  return { file: next, decision, event };
}

// ============================================================ rule 5: FCRA block per applicant (15 U.S.C. 1681m(a); 1681g(f))
export interface ScoreInput { readonly borrower_id: string; readonly score_model: string; readonly scores: readonly { repository: string; bureau: string; score: number | null; model_version: string; key_factors: readonly string[]; inquiries_key_factor: boolean }[]; readonly applicable_score: number | null; readonly range: { min: number; max: number }; readonly date: PlainDate; }
const parseContact = (s: string): CraContact => { const parts = s.split(", "); const phone = parts[parts.length - 1]!; return { name: parts[0]!, address: parts.slice(1, -1).join(", "), phone, toll_free: phone }; };
/** The three nationwide CRAs' contact blocks (21.3's CRA_CONTACTS — one vocabulary for score notices and adverse-action notices). */
export const CRA_CONTACT_BLOCKS: readonly CraContact[] = ["EFX", "EXP", "TU"].map((k) => parseContact(CRA_CONTACTS[k]!));
/** One block per applicant from 22.2's `scoreDisclosurePayloads` shape: only that applicant's representative score (B3-5.1-02), its range, ≤ 4 key factors (5 with inquiries), score date and model/provider; every CRA that furnished a report. */
export function assembleFcraBlock(p: ScoreInput): FcraBlock {
  nonEmpty(p.borrower_id, "borrower_id");
  const used = p.scores.find((s) => s.score !== null && s.score === p.applicable_score) ?? null;
  const no_score = p.applicable_score === null || !used;
  const cap = used?.inquiries_key_factor ? FCRA_MAX_KEY_FACTORS_WITH_INQUIRIES : FCRA_MAX_KEY_FACTORS;
  const key_factors = used ? [...used.key_factors].slice(0, cap) : [];
  const label = SCORE_MODEL_LABELS[p.score_model] ?? p.score_model;
  return { applicant_id: p.borrower_id, used_consumer_report: true, cra: p.scores.map((s) => CRA_CONTACT_BLOCKS.find((c) => c.name === s.bureau) ?? { name: s.bureau, address: "", phone: "", toll_free: "" }), no_score, score: no_score ? null : p.applicable_score, score_range_low: p.range.min, score_range_high: p.range.max,
    key_factors, key_factor_count: key_factors.length, inquiries_key_factor: used?.inquiries_key_factor === true, score_date: no_score ? null : p.date, score_provider: used ? `${label} — ${used.model_version}` : null, model: used ? used.model_version : null, bureau: used ? used.bureau : null,
    no_decision_statement: FCRA_NO_DECISION_STATEMENT, free_report_statement: FCRA_FREE_REPORT_STATEMENT, dispute_statement: FCRA_DISPUTE_STATEMENT };
}

// ============================================================ rule 7: state overlays (Colorado SB 26-189) and the federal agency block
export const coDutiesApply = (file: Pick<DecisionFile, "property_state" | "consumer_state" | "admt_materially_influenced">, decidedOn: PlainDate, effectiveFrom: PlainDate = CO_SB26_189_EFFECTIVE_FROM): boolean =>
  (file.property_state === "CO" || file.consumer_state === "CO") && file.admt_materially_influenced && decidedOn >= effectiveFrom;
export const coExplanationDue = (decidedOn: PlainDate): PlainDate => addDays(decidedOn, CO_EXPLANATION_DAYS);
export interface StateOverlays { readonly federal_agency: { name: string; address: string }; readonly colorado_consumer: boolean; readonly co_duties_apply: boolean; readonly co_admt: CoAdmt | null; readonly admt_role_description: string; readonly human_review_instructions: string; readonly correction_instructions: string; readonly additional_information_instructions: string; readonly overlays: readonly string[]; }
/** The notice content beyond Reg B/FCRA: the FTC (or CFPB) block and, for a Colorado consumer, the ADMT explanation (6-1-1704(3)), human-review and correction routes (6-1-1705) — the uniform template carries the human-review statement by policy even before 2027-01-01; the duties (timer) apply only on/after. */
export function assembleStateOverlays(file: DecisionFile, decidedOn: PlainDate, o: { preuse_notice_id?: string | null } = {}): StateOverlays {
  const colorado_consumer = file.property_state === "CO" || file.consumer_state === "CO";
  const co_duties_apply = coDutiesApply(file, decidedOn);
  const co_admt: CoAdmt | null = colorado_consumer ? { applies: co_duties_apply, pre_use_notice_id: o.preuse_notice_id ?? null, explanation_due_on: co_duties_apply ? coExplanationDue(decidedOn) : null, explanation_notice_id: null, explanation_sent_at: null, human_review_requested_at: null, human_review_due_on: null, human_review_reviewer_id: null, human_review_completed_at: null, human_review_outcome: null, correction_requested_at: null, correction_completed_at: null } : null;
  return { federal_agency: FEDERAL_AGENCY_BLOCKS[file.federal_agency], colorado_consumer, co_duties_apply, co_admt,
    admt_role_description: `An automated underwriting system evaluated your application against ${file.partner_name}'s credit standards; a licensed underwriter reviewed and approved the decision.`,
    human_review_instructions: `You may request meaningful human review and reconsideration of this decision by a different underwriter: write to ${file.partner_name}, ${file.partner_address}, or reply through your application portal.`,
    correction_instructions: "You may ask us to correct any factually incorrect or materially inaccurate personal data used in this decision; we will re-verify the data and re-decide your application if it changes.",
    additional_information_instructions: `You may request additional information about this decision, including the specific reasons, within 60 days of this notice from ${file.partner_name}.`,
    overlays: colorado_consumer ? ["co.sb26_189"] : [] };
}
/** 20.3/21.1 assert the pre-use gate at the point of interaction; the template and the gate are owned here — the delivery event closes `CO_SB26_189_1704_PREUSE_NOTICE_GATE`. */
export function recordPreuseNoticeDelivered(events: EventStore, i: { application_id: string; notice_id: string; delivered_at: string; state: string; public_notice_url: string }, actor: Actor = UNDERWRITER_AGENT): DomainEvent {
  const at = isoInstant(i.delivered_at, "delivered_at"); nonEmpty(i.notice_id, "notice_id");
  return events.append({ type: "co_admt.preuse_notice.delivered", applicationId: i.application_id, aggregate: { kind: "application", id: i.application_id }, actor, occurredAt: at, payload: { application_id: i.application_id, notice_id: i.notice_id, template: NOTICE_CODES_21_6.co_admt, variant: "pre_use", state: i.state, public_notice_url: i.public_notice_url, delivered_on: civilDate(at, "America/Denver") } });
}
/** CO_SB26_189_1704_PREUSE_NOTICE_GATE facts: open unless a Colorado consumer interacts on/after the effective date without the pre-use notice delivered. */
export function coPreuseNoticeGate(f: Record<string, unknown>): { open: boolean; reason?: string } {
  const co = f.property_state === "CO" || f.consumer_state === "CO"; const on = typeof f.interaction_on === "string" ? f.interaction_on : "";
  if (!co || !on || on < String(f.effective_from ?? CO_SB26_189_EFFECTIVE_FROM)) return { open: true };
  return f.preuse_notice_delivered === true ? { open: true } : { open: false, reason: "6-1-1704: the clear and conspicuous pre-use notice must be delivered before any ADMT-influenced eligibility/pricing output for a Colorado consumer" };
}
/** CO_SB26_189_1703_RECORDS_3Y facts: disposal of `co_admt_3y` records opens 3 years after `decided_on` and never under a legal hold. */
export function coRecordsRetentionElapsed(f: Record<string, unknown>): { open: boolean; reason?: string } {
  if (f.legal_hold === true) return { open: false, reason: "legal hold" };
  if (typeof f.decided_on !== "string" || typeof f.as_of !== "string") return { open: false, reason: "decided_on and as_of are required" };
  const floor = addYears(plainDate(f.decided_on), CO_RECORDS_YEARS);
  return f.as_of >= floor ? { open: true } : { open: false, reason: `6-1-1703: records retained until ${floor} (not less than three years after the consequential decision)` };
}

// ============================================================ §1002.4(b): the LLM's borrower-facing explanation passes a discouragement and prohibited-basis check before send
export function discouragementCheck(text: string): { blocked: boolean; findings: readonly { pattern: string; match: string; kind: "discouragement" | "prohibited_basis" }[] } {
  const findings: { pattern: string; match: string; kind: "discouragement" | "prohibited_basis" }[] = [];
  for (const p of DISCOURAGEMENT_PATTERNS) { const m = p.exec(text); if (m) findings.push({ pattern: String(p), match: m[0], kind: "discouragement" }); }
  for (const p of PROHIBITED_BASIS_LEXICON) { const m = p.exec(text); if (m) findings.push({ pattern: String(p), match: m[0], kind: "prohibited_basis" }); }
  return { blocked: findings.length > 0, findings };
}
/** T12: a blocked explanation never reaches the borrower; it routes to `compliance-sentinel` (sev 1) — the taxonomy notice text is unaffected. */
export function blockDiscouragingExplanation(events: EventStore, escalations: EscalationService, file: DecisionFile, i: { decision_id: string; text: string; at: string; prompt_version?: string | null }): { blocked: boolean; findings: ReturnType<typeof discouragementCheck>["findings"]; escalation: Escalation | null; event: DomainEvent | null } {
  const at = isoInstant(i.at, "at"); const check = discouragementCheck(i.text);
  if (!check.blocked) return { blocked: false, findings: [], escalation: null, event: null };
  const escalation = escalations.open({ kind: "sev1", ownerRole: "compliance", applicationId: file.application_id, severity: "1", payload: { reason: "discouragement_or_prohibited_basis", citation: "12 CFR 1002.4(b)", decision_id: i.decision_id, findings: check.findings, prompt_version: i.prompt_version ?? null, notice_text_affected: false } }, COMPLIANCE_SENTINEL);
  const event = emit(events, file, "explanation.discouragement.blocked", { decision_id: i.decision_id, findings: check.findings, escalation_id: escalation.id, routed_to: "compliance-sentinel", notice_text_affected: false }, at, COMPLIANCE_SENTINEL);
  return { blocked: true, findings: check.findings, escalation, event };
}

// ============================================================ rule 2: disposition → HMDA action taken (§1003.4(a)(8); comments 4(a)(8)(i)-3 to -13, (ii)-1 to -6)
export type HmdaCase = { kind: "denial"; notice_sent_on: PlainDate; reasons: readonly PrincipalReason[] } | { kind: "counteroffer_not_accepted"; combined_notice: boolean; expires_on: PlainDate; adverse_notice_sent_on: PlainDate | null; reasons: readonly PrincipalReason[] }
  | { kind: "withdrawal"; express: boolean; received_on: PlainDate; after_decision: boolean } | { kind: "closed_incomplete"; closed_on: PlainDate } | { kind: "conditional_approval_fallout"; open_conditions: readonly OpenCondition[]; approval_expires_on: PlainDate; express_withdrawal: boolean; withdrawal_on: PlainDate | null; reasons: readonly PrincipalReason[] }
  | { kind: "originated"; consummated_on: PlainDate } | { kind: "rescinded_after_closing"; rescinded_on: PlainDate } | { kind: "approved_not_accepted"; approval_expires_on: PlainDate };
export function hmdaActionFor(c: HmdaCase): HmdaFields {
  const none = { denial_reasons: [] as number[], denial_reason_other_text: null };
  const denial = (date: PlainDate, reasons: readonly PrincipalReason[], basis: string): HmdaFields => { const r = hmdaDenialReasons(reasons); return { action_taken: 3, action_taken_date: date, denial_reasons: r.codes, denial_reason_other_text: r.other_text, basis }; };
  switch (c.kind) {
    case "denial": return denial(c.notice_sent_on, c.reasons, "denied: date = notice sent (policy; comment 4(a)(8)(ii)-1)");
    case "counteroffer_not_accepted": {
      if (!c.combined_notice && !c.adverse_notice_sent_on) throw new RangeError("a counteroffer without the combined C-4 notice needs the adverse action notice date (comment 9(a)(1)-6)");
      return denial(c.combined_notice ? c.expires_on : c.adverse_notice_sent_on!, c.reasons, c.combined_notice ? "denied on the original terms: combined C-4 notice; date = counteroffer expiry (comment 4(a)(8)(i)-9)" : "denied on the original terms: date = adverse action notice (comment 4(a)(8)(i)-9)");
    }
    case "withdrawal":
      if (!c.express) throw new RangeError("HMDA code 4 requires an express withdrawal (comment 4(a)(8)(i)-5); silence is never a withdrawal");
      if (c.after_decision) throw new RangeError("a withdrawal after the credit decision is still that decision (comment 4(a)(8)(i)-4): report the decision, not code 4");
      return { action_taken: 4, action_taken_date: c.received_on, ...none, basis: "withdrawn by applicant: express withdrawal before a credit decision; date = received (comment 4(a)(8)(ii)-3)" };
    case "closed_incomplete": return { action_taken: 5, action_taken_date: c.closed_on, ...none, basis: "file closed for incompleteness: §1002.9(c)(2) notice sent, no response within the period; date = closure (comment 4(a)(8)(i)-6)" };
    case "conditional_approval_fallout": {
      const cw = c.open_conditions.filter((x) => x.kind === "creditworthiness");
      if (cw.length && c.express_withdrawal) return { action_taken: 4, action_taken_date: c.withdrawal_on ?? c.approval_expires_on, ...none, basis: "withdrawn: express withdrawal before creditworthiness conditions were satisfied (comment 4(a)(8)(i)-13)" };
      if (cw.length) return denial(c.approval_expires_on, c.reasons, `denied: unmet underwriting/creditworthiness conditions ${cw.map((x) => x.condition_id).join(", ")} (comment 4(a)(8)(i)-13)`);
      return { action_taken: 2, action_taken_date: c.approval_expires_on, ...none, basis: "approved but not accepted: only customary commitment/closing conditions unmet; date = approval expiration (policy; comment 4(a)(8)(ii)-4)" };
    }
    case "originated": return { action_taken: 1, action_taken_date: c.consummated_on, ...none, basis: "loan originated: consummation date (28.3 finalises)" };
    case "rescinded_after_closing": return { action_taken: 2, action_taken_date: c.rescinded_on, ...none, basis: "approved but not accepted: rescinded after closing before submission (comment 4(a)(8)(i)-10)" };
    case "approved_not_accepted": return { action_taken: 2, action_taken_date: c.approval_expires_on, ...none, basis: "approved but not accepted: approval/commitment expired unconsummated; date = approval expiration (policy)" };
  }
}
/** Every terminal state writes the HMDA fields in the same transaction; code 4 never without `withdrawals.express=true`. */
export function recordHmdaAction(events: EventStore, file: DecisionFile, fields: HmdaFields, at: string, decision_id: string | null): { file: DecisionFile; event: DomainEvent } {
  isoInstant(at, "at");
  if (file.hmda) throw new RangeError(`application ${file.application_id} already reports action ${file.hmda.action_taken} on ${file.hmda.action_taken_date}: exactly one action code per terminal application`);
  if (fields.action_taken === 4 && !file.withdrawals.some((w) => w.express)) throw new RangeError("HMDA code 4 requires a withdrawals row with express=true");
  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(fields.action_taken)) throw new RangeError(`HMDA action taken ${fields.action_taken} is not a FIG 2026 code`);
  if (fields.action_taken === 3 && !fields.denial_reasons.length) throw new RangeError("§1003.4(a)(16): a denial reports its principal reasons");
  const decisions = decision_id ? file.decisions.map((d) => (d.decision_id === decision_id ? { ...d, hmda_action_taken: fields.action_taken, hmda_action_taken_date: fields.action_taken_date } : d)) : file.decisions;
  const next: DecisionFile = { ...file, hmda: fields, decisions };
  return { file: next, event: emit(events, next, "hmda.action_taken.recorded", { action_taken: fields.action_taken, action_taken_date: fields.action_taken_date, denial_reasons: fields.denial_reasons, denial_reason_other_text: fields.denial_reason_other_text, basis: fields.basis, decision_id }, at) };
}

// ============================================================ notices: adverse action (C-1/C-3), counteroffer (C-4), NOIA (C-6) — rules 3, 5, 6, 7
export interface NoticePayloadInput { readonly decision_id: string; readonly notice_date: PlainDate; readonly fcra_blocks: readonly FcraBlock[]; readonly reviewer_signed_other_text?: boolean; readonly action_statement?: string; }
const reasonsLc = (reasons: readonly PrincipalReason[]): string => reasons.map((r) => r.statement_text).join(" | ").toLowerCase();
/** Per-applicant payload of `NTC_REGB_1002_9_ADVERSE_ACTION`: identical ECOA content for every applicant, the FCRA block individualised (never another applicant's score). */
export function adverseNoticePayloads(file: DecisionFile, i: NoticePayloadInput): { applicant_id: string; payload: Record<string, unknown> }[] {
  const d = decisionOf(file, i.decision_id); const decided_on = civilDate(d.decided_at ?? d.recommended_at, file.creditor_time_zone);
  const reasons = selectPrincipalReasons(d.decision_factors, { ...(i.reviewer_signed_other_text !== undefined ? { reviewer_signed_other_text: i.reviewer_signed_other_text } : {}) });
  const overlays = assembleStateOverlays(file, decided_on);
  return file.applicants.map((a) => {
    const fcra = i.fcra_blocks.find((b) => b.applicant_id === a.id) ?? null;
    if (i.fcra_blocks.some((b) => b.applicant_id !== a.id && fcra && b.score !== null && b.score === fcra.score && b.applicant_id === fcra.applicant_id)) throw new RangeError("one FCRA block per applicant");
    return { applicant_id: a.id, payload: { creditor_name: file.partner_name, creditor_address: file.partner_address, applicant_name: a.name, application_id: file.application_id, notice_date: i.notice_date, decided_on,
      action_statement: i.action_statement ?? (d.kind === "counteroffer" ? "We are unable to offer you credit on the terms you requested." : "Your application for credit has been denied."),
      principal_reasons: reasons.map((r) => ({ statement_text: r.statement_text, reason_code: r.reason_code, hmda_denial_code: r.hmda_denial_code })), reasons_count: reasons.length, reasons_text_lc: reasonsLc(reasons), statement_of_reasons_provided: true,
      federal_agency_name: overlays.federal_agency.name, federal_agency_address: overlays.federal_agency.address, ecoa_notice: ECOA_NOTICE_TEXT,
      fcra: fcra ? { ...fcra, cra: fcra.cra.map((c) => ({ ...c })), key_factors: [...fcra.key_factors] } : null, uses_consumer_report: fcra !== null,
      colorado_consumer: overlays.colorado_consumer, co_admt: overlays.colorado_consumer ? { role_description: overlays.admt_role_description, human_review_instructions: overlays.human_review_instructions, correction_instructions: overlays.correction_instructions, additional_information_instructions: overlays.additional_information_instructions, duties_apply: overlays.co_duties_apply, explanation_due_on: overlays.co_admt?.explanation_due_on ?? null } : null,
      human_review_statement: overlays.human_review_instructions, mlo_nmlsr_id_required: false, retention_class: "regb_25m" } };
  });
}
/** `NTC_REGB_1002_9_COUNTEROFFER` (C-4 combined): the counteroffer terms and expiry plus the adverse-action content on the original terms (reasons, ECOA notice, agency, FCRA block when the report was used). */
export function counterofferNoticePayload(file: DecisionFile, i: NoticePayloadInput & { combined_notice: boolean; acceptance_instructions?: string }): Record<string, unknown> {
  const d = decisionOf(file, i.decision_id); if (d.kind !== "counteroffer" || !d.counteroffer_terms) throw new RangeError(`decision ${d.decision_id} is not a counteroffer`);
  const primary = file.applicants.find((a) => a.primary) ?? file.applicants[0]!;
  const base = adverseNoticePayloads(file, { ...i, action_statement: "We are unable to offer you credit on the terms you requested, but we can offer you credit on the following terms." }).find((p) => p.applicant_id === primary.id)!.payload;
  const t = d.counteroffer_terms; const original = file.original_terms;
  return { ...base, combined_notice: i.combined_notice, counteroffer: { loan_amount_cents: t.loan_amount_cents, note_rate: t.note_rate, product_code: t.product_code, ltv: t.ltv, conditions: [...t.conditions], expires_on: t.expires_on },
    original_terms: original ? { loan_amount_cents: original.loan_amount_cents, note_rate: original.note_rate, product_code: original.product_code, ltv: original.ltv } : null, acceptance_instructions: i.acceptance_instructions ?? "To accept, sign the acceptance electronically in your application portal or return the signed acceptance to us before the expiration date.",
    adverse_action_on_original_terms: i.combined_notice, principal_reasons: i.combined_notice ? base.principal_reasons : [], reasons_count: i.combined_notice ? base.reasons_count : 0 };
}
/** `NTC_REGB_1002_9_NOIA` (C-6): the information needed, the designated period and the no-further-consideration statement (§1002.9(c)(2)). */
export function noiaNoticePayload(file: DecisionFile, noia: NoiaRow, sentOn: PlainDate): Record<string, unknown> {
  const primary = file.applicants.find((a) => a.primary) ?? file.applicants[0]!;
  if (!noia.items_needed.length) throw new RangeError("an NOIA specifies the information needed (§1002.9(c)(2))");
  return { creditor_name: file.partner_name, creditor_address: file.partner_address, applicant_name: primary.name, application_id: file.application_id, notice_date: sentOn, items_needed: noia.items_needed.map((x) => ({ item: x.item, description: x.description })), items_count: noia.items_needed.length,
    designated_period_days: noia.designated_period_days, response_due_on: addDays(sentOn, noia.designated_period_days), oral_request_made: noia.oral_request_at !== null, contact_instructions: `Send the information to ${file.partner_name}, ${file.partner_address}, or upload it in your application portal.`, retention_class: "regb_25m" };
}

// ============================================================ delivery (T3): refused without the reviewer's decision; `approved_by_reviewer_at` precedes `sent_at`
export interface DeliverInput { readonly decision_id: string; readonly sent_at: string; readonly notice_ids: Readonly<Record<string, string>>; readonly fcra_blocks: readonly FcraBlock[]; readonly combined_notice?: boolean; readonly co_explanation_embedded?: boolean; readonly delivery_channel?: string; readonly reviewer_signed_other_text?: boolean; readonly expires_on?: PlainDate | null; }
const assertReviewed = (d: DecisionRow): void => {
  if (d.kind !== "denial" && d.kind !== "counteroffer" && d.kind !== "incomplete") return;
  if (!d.reviewer_decided_at || d.reviewer_outcome !== "approved") throw new RangeError(`REVIEWER_REQUIRED: ${d.kind} ${d.decision_id} has no underwriting_reviewer approval (reviewer_decided_at is null) — the notice cannot issue`);
};
/** The adverse action / combined counteroffer notice(s) go out (per applicant); the decision is thereby issued (Reg B notification), HMDA is written for a denial, the Colorado explanation is satisfied when embedded, the 90-day clock is armed for a counteroffer (and closed at once by a C-4 combined notice — comment 9(a)(1)-6). */
export function deliverAdverseNotice(events: EventStore, file: DecisionFile, i: DeliverInput): { file: DecisionFile; adverse_action: AdverseActionRow; decision: DecisionRow; events: DomainEvent[]; regb_notice_required: true } {
  assertNotTerminal(file); const sent_at = isoInstant(i.sent_at, "sent_at"); const d = decisionOf(file, i.decision_id); assertReviewed(d);
  if (d.kind !== "denial" && d.kind !== "counteroffer") throw new RangeError(`decision ${d.decision_id} is a ${d.kind}: deliverAdverseNotice sends denial and counteroffer notices (NOIAs go through deliverNoia)`);
  if (Date.parse(sent_at) < Date.parse(d.reviewer_decided_at!)) throw new RangeError("sent_at precedes the reviewer's approval");
  const primary = file.applicants.find((a) => a.primary) ?? file.applicants[0]!;
  if (d.kind === "denial") { for (const a of file.applicants) if (!i.notice_ids[a.id]) throw new RangeError(`no rendered notice for applicant ${a.id} (FCRA duties run to each consumer)`); }
  else if (!i.notice_ids[primary.id]) throw new RangeError(`no rendered counteroffer notice for the primary applicant ${primary.id} (§1002.9(f))`);
  const decided_on = civilDate(d.decided_at!, file.creditor_time_zone); const sent_on = civilDate(sent_at, file.creditor_time_zone);
  const reasons = selectPrincipalReasons(d.decision_factors, { ...(i.reviewer_signed_other_text !== undefined ? { reviewer_signed_other_text: i.reviewer_signed_other_text } : {}) });
  const overlays = assembleStateOverlays(file, decided_on);
  const combined = d.kind === "counteroffer" && i.combined_notice === true;
  const co_admt = overlays.co_admt ? { ...overlays.co_admt, ...(overlays.co_duties_apply && i.co_explanation_embedded !== false ? { explanation_notice_id: i.notice_ids[primary.id]!, explanation_sent_at: sent_at } : {}) } : null;
  const aa: AdverseActionRow = { adverse_action_id: `AA-${d.decision_id}`, application_id: file.application_id, decision_id: d.decision_id, kind: d.kind === "counteroffer" ? "counteroffer" : d.after_conditional_approval ? "denial" : d.data_sufficient ? "denial" : "denial_incomplete", principal_reasons: reasons,
    per_applicant: file.applicants.map((a) => ({ applicant_id: a.id, notice_id: i.notice_ids[a.id] ?? null, fcra_block: i.fcra_blocks.find((b) => b.applicant_id === a.id) ?? null, delivery: i.delivery_channel ?? (a.esign_consent ? "e-delivery" : "first_class_mail") })),
    federal_agency_block: overlays.federal_agency, state_overlays: overlays.overlays, co_admt, reviewer_escalation_id: d.reviewer_escalation_id, approved_by_reviewer_at: d.reviewer_decided_at, approving_reviewer_id: d.reviewer_id, sent_at, retention_class: ["regb_25m", ...(overlays.colorado_consumer ? ["co_admt_3y"] : []), "fnma_loan_file_life_plus_4y"] };
  const expires_on = d.kind === "counteroffer" ? (i.expires_on ?? d.counteroffer_terms?.expires_on ?? addDays(sent_on, COUNTEROFFER_DEFAULT_EXPIRY_DAYS)) : null;
  const decision: DecisionRow = { ...d, notice_id: i.notice_ids[primary.id]!, sent_at, combined_notice: combined, counteroffer_terms: d.counteroffer_terms && expires_on ? { ...d.counteroffer_terms, expires_on } : d.counteroffer_terms };
  let next = withAdverse(withDecision({ ...file, disposition: d.kind === "counteroffer" ? "counteroffer_pending" : "denied" }, decision), aa);
  const out: DomainEvent[] = [];
  out.push(emit(events, next, "notice.adverse_action.sent", { decision_id: d.decision_id, kind: aa.kind, notice_ids: { ...i.notice_ids }, sent_on, sent_at, combined_notice: combined, approved_by_reviewer_at: aa.approved_by_reviewer_at, reasons: reasons.map((r) => r.reason_code), federal_agency: overlays.federal_agency.name }, sent_at));
  out.push(emit(events, next, "decision.issued", { decision_id: d.decision_id, kind: d.kind, decided_on, decided_at: d.decided_at, sent_on, sent_at, consequential: true, combined_notice: combined, co_admt_applies: overlays.co_duties_apply, expires_on, adverse_notice_due_on: d.kind === "counteroffer" ? addDays(sent_on, REGB_COUNTEROFFER_DAYS) : null }, sent_at));
  if (co_admt?.explanation_sent_at) out.push(emit(events, next, "co_admt.explanation.sent", { decision_id: d.decision_id, adverse_action_id: aa.adverse_action_id, embedded: true, explanation_due_on: co_admt.explanation_due_on, sent_on, notice_id: co_admt.explanation_notice_id }, sent_at));
  if (combined) out.push(emit(events, next, "counteroffer.resolved", { decision_id: d.decision_id, outcome: "combined_notice_sent", sent_on, expires_on, why: "comment 9(a)(1)-6: a combined counteroffer and adverse action notice needs no second notice" }, sent_at));
  if (d.kind === "denial") { const h = recordHmdaAction(events, next, hmdaActionFor({ kind: "denial", notice_sent_on: sent_on, reasons }), sent_at, d.decision_id); next = h.file; out.push(h.event); }
  const done = decisionOf(next, d.decision_id);
  return { file: next, adverse_action: adverseOf(next, d.decision_id)!, decision: done, events: out, regb_notice_required: true };
}
/** The written NOIA (C-6) goes out: `response_due_on = sent_on + designated_period_days` (T5: Tue Oct 27 + 14 → Tue Nov 10, 2026); an oral request alone never satisfies the clock (comment 9(c)(3)-1). */
export function deliverNoia(events: EventStore, file: DecisionFile, i: { decision_id: string; noia_id: string; sent_at: string; notice_id: string; items_needed: readonly { item: string; description: string }[]; designated_period_days?: number; oral_request_at?: string | null }): { file: DecisionFile; noia: NoiaRow; events: DomainEvent[] } {
  assertNotTerminal(file); const sent_at = isoInstant(i.sent_at, "sent_at"); const d = decisionOf(file, i.decision_id); if (d.kind !== "incomplete") throw new RangeError(`decision ${d.decision_id} is a ${d.kind}, not an NOIA`); assertReviewed(d);
  const days = i.designated_period_days ?? NOIA_DEFAULT_PERIOD_DAYS; if (!Number.isInteger(days) || days < NOIA_MIN_PERIOD_DAYS) throw new RangeError(`§1002.9(c)(2) designated period must be a reasonable period: policy minimum ${NOIA_MIN_PERIOD_DAYS} days`);
  if (!i.items_needed.length) throw new RangeError("the NOIA specifies the information needed");
  const sent_on = civilDate(sent_at, file.creditor_time_zone); const response_due_on = addDays(sent_on, days);
  const noia: NoiaRow = { noia_id: i.noia_id, application_id: file.application_id, decision_id: d.decision_id, items_needed: i.items_needed, designated_period_days: days, sent_at, sent_on, response_due_on, oral_request_at: i.oral_request_at ?? null, responded_at: null, closed_at: null };
  const next = withNoia(withDecision({ ...file, disposition: "incomplete_noia_sent" }, { ...d, notice_id: i.notice_id, sent_at }), noia);
  const out = [emit(events, next, "noia.sent", { decision_id: d.decision_id, noia_id: noia.noia_id, notice_id: i.notice_id, sent_on, sent_at, designated_period_days: days, response_due_on, written: true, items: i.items_needed.map((x) => x.item) }, sent_at),
    emit(events, next, "decision.issued", { decision_id: d.decision_id, kind: "incomplete", decided_on: civilDate(d.decided_at!, file.creditor_time_zone), decided_at: d.decided_at, sent_on, sent_at, consequential: false, combined_notice: false, co_admt_applies: false }, sent_at)];
  return { file: next, noia, events: out };
}
/** The applicant supplies the requested information within the period: the decision clock resumes, re-anchored to `responded_on + 30` but never later than the conservative clock (rule 1). */
export function respondNoia(events: EventStore, file: DecisionFile, i: { noia_id: string; responded_at: string; all_items: boolean }): { file: DecisionFile; noia: NoiaRow; decision_due_on: PlainDate; event: DomainEvent } {
  const at = isoInstant(i.responded_at, "responded_at"); const n = file.noias.find((x) => x.noia_id === i.noia_id); if (!n || !n.sent_on) throw new RangeError(`no sent NOIA ${i.noia_id}`);
  if (n.closed_at) throw new RangeError(`NOIA ${i.noia_id} is closed: information after the designated period requires a new application at the creditor's option (comment 9(c)(2)-1; policy: reopen within 30 days of closure without pricing/eligibility change)`);
  if (!i.all_items) throw new RangeError("the clock resumes only when every requested item is supplied");
  const responded_on = civilDate(at, file.creditor_time_zone); const reanchored = addDays(responded_on, REGB_DECISION_DAYS);
  const decision_due_on = reanchored < file.decision_due_on ? reanchored : file.decision_due_on;
  const noia: NoiaRow = { ...n, responded_at: at };
  const next = withNoia({ ...file, disposition: "open", decision_due_on, decision_due_at: toIso(zonedEpochMs(decision_due_on, "23:59", file.creditor_time_zone)), last_borrower_activity_at: at }, noia);
  return { file: next, noia, decision_due_on, event: emit(events, next, "noia.responded", { noia_id: n.noia_id, responded_on, responded_at: at, all_items: true, decision_due_on, reanchored_due_on: reanchored, conservative_due_on: file.decision_due_on }, at) };
}
/** No response within the designated period: the file closes for incompleteness the day after `response_due_on` (T5: Wed Nov 11, 2026), HMDA code 5 with the closure date, no further Reg B notice (§1002.9(c)(2)). */
export function closeIncomplete(events: EventStore, file: DecisionFile, i: { noia_id: string; as_of: string }): { file: DecisionFile; closed_on: PlainDate; hmda: HmdaFields; regb_notice_required: false; events: DomainEvent[] } {
  assertNotTerminal(file); const at = isoInstant(i.as_of, "as_of"); const n = file.noias.find((x) => x.noia_id === i.noia_id); if (!n || !n.response_due_on) throw new RangeError(`no sent NOIA ${i.noia_id}`);
  if (n.responded_at) throw new RangeError(`NOIA ${i.noia_id} was answered on ${n.responded_at}: decide the application instead`);
  const closed_on = civilDate(at, file.creditor_time_zone); if (closed_on <= n.response_due_on) throw new RangeError(`the designated period runs through ${n.response_due_on}; the file closes on or after ${addDays(n.response_due_on, 1)}`);
  const hmda = hmdaActionFor({ kind: "closed_incomplete", closed_on });
  const decision: DecisionRow = { ...decisionOf(file, n.decision_id), kind: "file_closed_incomplete", decided_at: at, sent_at: at };
  const closedDecision: DecisionRow = { ...decision, decision_id: `${n.decision_id}-closed` };
  let next = withNoia(withDecision({ ...file, disposition: "closed_incomplete" }, closedDecision), { ...n, closed_at: at });
  const out = [emit(events, next, "application.closed_incomplete", { noia_id: n.noia_id, closed_on, response_due_on: n.response_due_on, regb_notice_required: false, courtesy_letter: true, lock_cancellation_reason: "borrower_withdrawal" }, at),
    emit(events, next, "decision.issued", { decision_id: closedDecision.decision_id, kind: "file_closed_incomplete", decided_on: closed_on, decided_at: at, sent_on: closed_on, sent_at: at, consequential: false, combined_notice: false, co_admt_applies: false }, at)];
  const h = recordHmdaAction(events, next, hmda, at, closedDecision.decision_id); next = h.file; out.push(h.event);
  return { file: next, closed_on, hmda, regb_notice_required: false, events: out };
}

// ============================================================ counteroffers (rule 1/2; comments 9(a)(1)-5/-6; 4(a)(8)(i)-9)
export const counterofferClock = (sentOn: PlainDate, expiresOn: PlainDate | null): { adverse_notice_due_on: PlainDate; policy_send_on: PlainDate; expires_on: PlainDate } => { const expires_on = expiresOn ?? addDays(sentOn, COUNTEROFFER_DEFAULT_EXPIRY_DAYS); return { adverse_notice_due_on: addDays(sentOn, REGB_COUNTEROFFER_DAYS), policy_send_on: expires_on < addDays(sentOn, REGB_COUNTEROFFER_DAYS) ? expires_on : addDays(sentOn, REGB_COUNTEROFFER_DAYS), expires_on }; };
/** Express acceptance (e-signature or use): the application proceeds on the new terms; 21.4 re-cuts the lock (`renegotiation`), 21.5 issues the revised LE, 29.1 updates the commitment. */
export function acceptCounteroffer(events: EventStore, file: DecisionFile, i: { decision_id: string; accepted_at: string; method: string }): { file: DecisionFile; events: DomainEvent[] } {
  const at = isoInstant(i.accepted_at, "accepted_at"); const d = decisionOf(file, i.decision_id); if (d.kind !== "counteroffer" || !d.sent_at) throw new RangeError(`decision ${d.decision_id} is not a sent counteroffer`);
  if (file.disposition !== "counteroffer_pending") throw new RangeError(`counteroffer ${d.decision_id} is no longer pending (${file.disposition})`);
  const accepted_on = civilDate(at, file.creditor_time_zone); if (d.counteroffer_terms && accepted_on > d.counteroffer_terms.expires_on) throw new RangeError(`the counteroffer expired ${d.counteroffer_terms.expires_on}`);
  const next: DecisionFile = { ...file, disposition: "counteroffer_accepted", original_terms: d.counteroffer_terms ? { loan_amount_cents: d.counteroffer_terms.loan_amount_cents, note_rate: d.counteroffer_terms.note_rate, product_code: d.counteroffer_terms.product_code, ltv: d.counteroffer_terms.ltv } : file.original_terms };
  return { file: next, events: [emit(events, next, "counteroffer.accepted", { decision_id: d.decision_id, accepted_on, method: i.method, terms: d.counteroffer_terms, downstream: ["21.4 lock renegotiation", "21.5 revised LE (basis C)", "29.1 commitment update"] }, at),
    emit(events, next, "counteroffer.resolved", { decision_id: d.decision_id, outcome: "accepted", accepted_on }, at)] };
}
/** No express acceptance by the counteroffer's own expiry: with the combined C-4 notice nothing further is sent and HMDA code 3 is recorded on the original terms with the expiry date (T6); without it the adverse action notice must issue (policy: at the expiry; legal: sent_on + 90 — T7). */
export function expireCounteroffer(events: EventStore, file: DecisionFile, i: { decision_id: string; as_of: string }): { file: DecisionFile; second_notice_required: boolean; adverse_notice_due_on: PlainDate; policy_send_on: PlainDate; hmda: HmdaFields | null; events: DomainEvent[] } {
  const at = isoInstant(i.as_of, "as_of"); const d = decisionOf(file, i.decision_id); if (d.kind !== "counteroffer" || !d.sent_at || !d.counteroffer_terms) throw new RangeError(`decision ${d.decision_id} is not a sent counteroffer`);
  if (file.disposition !== "counteroffer_pending") throw new RangeError(`counteroffer ${d.decision_id} is no longer pending (${file.disposition})`);
  const sent_on = civilDate(d.sent_at, file.creditor_time_zone); const clock = counterofferClock(sent_on, d.counteroffer_terms.expires_on); const today = civilDate(at, file.creditor_time_zone);
  if (today < clock.expires_on) throw new RangeError(`the counteroffer is open until ${clock.expires_on}`);
  const aa = adverseOf(file, d.decision_id)!;
  let next: DecisionFile = file; const out: DomainEvent[] = [];
  out.push(emit(events, next, "counteroffer.expired", { decision_id: d.decision_id, expires_on: clock.expires_on, combined_notice: d.combined_notice, second_notice_required: !d.combined_notice, adverse_notice_due_on: clock.adverse_notice_due_on, policy_send_on: clock.policy_send_on }, at));
  if (d.combined_notice) {
    const hmda = hmdaActionFor({ kind: "counteroffer_not_accepted", combined_notice: true, expires_on: clock.expires_on, adverse_notice_sent_on: null, reasons: aa.principal_reasons });
    next = withAdverse({ ...next, disposition: "denied" }, { ...aa, kind: "counteroffer_not_accepted" });
    const h = recordHmdaAction(events, next, hmda, at, d.decision_id); next = h.file; out.push(h.event);
    return { file: next, second_notice_required: false, adverse_notice_due_on: clock.adverse_notice_due_on, policy_send_on: clock.policy_send_on, hmda, events: out };
  }
  return { file: next, second_notice_required: true, adverse_notice_due_on: clock.adverse_notice_due_on, policy_send_on: clock.policy_send_on, hmda: null, events: out };
}
/** The adverse action notice after an expired counteroffer that was not combined (T7): HMDA code 3 on the original terms with the notice date; the 90-day clock is satisfied by this notice. */
export function deliverAdverseAfterCounteroffer(events: EventStore, file: DecisionFile, i: { decision_id: string; sent_at: string; notice_ids: Readonly<Record<string, string>> }): { file: DecisionFile; hmda: HmdaFields; events: DomainEvent[] } {
  const sent_at = isoInstant(i.sent_at, "sent_at"); const d = decisionOf(file, i.decision_id); const aa = adverseOf(file, i.decision_id); if (d.kind !== "counteroffer" || !aa || d.combined_notice) throw new RangeError("only an expired counteroffer without the combined notice takes a second (adverse action) notice");
  if (!events.all().some((e) => e.type === "counteroffer.expired" && (e.payload as { decision_id?: string }).decision_id === d.decision_id)) throw new RangeError("the counteroffer has not expired");
  const sent_on = civilDate(sent_at, file.creditor_time_zone); const clock = counterofferClock(civilDate(d.sent_at!, file.creditor_time_zone), d.counteroffer_terms?.expires_on ?? null);
  if (sent_on > clock.adverse_notice_due_on) throw new RangeError(`§1002.9(a)(1)(iv): the adverse action notice was due by ${clock.adverse_notice_due_on}`);
  const hmda = hmdaActionFor({ kind: "counteroffer_not_accepted", combined_notice: false, expires_on: clock.expires_on, adverse_notice_sent_on: sent_on, reasons: aa.principal_reasons });
  let next = withAdverse({ ...file, disposition: "denied" }, { ...aa, kind: "denial_after_counteroffer", sent_at, per_applicant: aa.per_applicant.map((p) => ({ ...p, notice_id: i.notice_ids[p.applicant_id] ?? p.notice_id })) });
  const out = [emit(events, next, "notice.adverse_action.sent", { decision_id: d.decision_id, kind: "denial_after_counteroffer", notice_ids: { ...i.notice_ids }, sent_on, sent_at, combined_notice: false, approved_by_reviewer_at: aa.approved_by_reviewer_at, reasons: aa.principal_reasons.map((r) => r.reason_code), federal_agency: aa.federal_agency_block.name }, sent_at),
    emit(events, next, "counteroffer.resolved", { decision_id: d.decision_id, outcome: "adverse_action_sent", sent_on }, sent_at)];
  const h = recordHmdaAction(events, next, hmda, sent_at, d.decision_id); next = h.file; out.push(h.event);
  return { file: next, hmda, events: out };
}

// ============================================================ rule 8: withdrawals (express only) and conditional-approval fallout (comment 4(a)(8)(i)-13)
export const EXPRESS_WITHDRAWAL_PATTERNS: readonly RegExp[] = [/going with another lender/i, /\bwithdraw/i, /cancel (my|the|this) application/i, /no longer (want|wish|interested)/i, /(don'?t|do not) (want to )?(proceed|continue|go forward)/i, /found (a )?(better|another) (loan|lender|rate)/i];
export const isExpressWithdrawal = (statement: string): boolean => EXPRESS_WITHDRAWAL_PATTERNS.some((p) => p.test(statement));
/** An express withdrawal captured verbatim (any channel) before a credit decision: `withdrawals.express=true`, HMDA code 4 with the received date, no Reg B notice; 21.4 cancels the lock as `borrower_withdrawal`. Silence is never a withdrawal. */
export function recordWithdrawal(events: EventStore, file: DecisionFile, i: { withdrawal_id: string; statement_text: string; channel: string; received_at: string; evidence_document_id?: string | null }): { file: DecisionFile; withdrawal: WithdrawalRow; hmda: HmdaFields; regb_notice_required: false; lock_cancellation_reason: "borrower_withdrawal"; events: DomainEvent[] } {
  assertNotTerminal(file); const at = isoInstant(i.received_at, "received_at"); const statement_text = nonEmpty(i.statement_text, "statement_text (the borrower's words, verbatim)");
  const express = isExpressWithdrawal(statement_text); if (!express) throw new RangeError(`"${statement_text}" is not an express withdrawal: silence or ambiguity is never recorded as a withdrawal (comment 4(a)(8)(i)-5; rule 8)`);
  const after_decision = file.decisions.some((d) => d.decided_at && (d.kind === "denial" || d.kind === "counteroffer"));
  if (after_decision) throw new RangeError("a withdrawal after the credit decision but before the notice is still that decision (comment 4(a)(8)(i)-4): send the adverse action notice");
  const received_on = civilDate(at, file.creditor_time_zone);
  const withdrawal: WithdrawalRow = { withdrawal_id: i.withdrawal_id, application_id: file.application_id, received_at: at, received_on, channel: i.channel, statement_text, evidence_document_id: i.evidence_document_id ?? null, express, after_decision };
  const creditworthinessMet = file.conditional_approval !== null && !file.conditional_approval.open_conditions.some((c) => c.kind === "creditworthiness");
  const hmda = creditworthinessMet ? hmdaActionFor({ kind: "conditional_approval_fallout", open_conditions: file.conditional_approval!.open_conditions, approval_expires_on: file.conditional_approval!.expires_on, express_withdrawal: true, withdrawal_on: received_on, reasons: [] }) : hmdaActionFor({ kind: "withdrawal", express, received_on, after_decision });
  const decision: DecisionRow = { decision_id: `D-${i.withdrawal_id}`, application_id: file.application_id, kind: hmda.action_taken === 2 ? "approved_not_accepted" : "withdrawal", recommended_at: at, decided_at: at, basis_component: "rules", decision_factors: [], counteroffer_terms: null, combined_notice: false, reviewer_escalation_id: null, reviewer_id: null, reviewer_decided_at: null, reviewer_outcome: null, reviewer_sla_due_on: null, notice_id: null, sent_at: at, hmda_action_taken: null, hmda_action_taken_date: null, after_conditional_approval: file.disposition === "conditional_approval", du_recommendation: null, data_sufficient: false };
  let next = withDecision({ ...file, withdrawals: [...file.withdrawals, withdrawal], disposition: hmda.action_taken === 2 ? "approved_not_accepted" : "withdrawn" }, decision);
  const out = [emit(events, next, "application.withdrawn", { withdrawal_id: withdrawal.withdrawal_id, express, received_on, channel: i.channel, statement_text, after_decision, regb_notice_required: false, lock_cancellation_reason: "borrower_withdrawal" }, at),
    emit(events, next, "decision.issued", { decision_id: decision.decision_id, kind: decision.kind, decided_on: received_on, decided_at: at, sent_on: received_on, sent_at: at, consequential: false, combined_notice: false, co_admt_applies: false }, at)];
  const h = recordHmdaAction(events, next, hmda, at, decision.decision_id); next = h.file; out.push(h.event);
  return { file: next, withdrawal, hmda, regb_notice_required: false, lock_cancellation_reason: "borrower_withdrawal", events: out };
}
/** A conditional approval (23.3) on the file: conditions are classified customary-closing vs creditworthiness (comment 4(a)(8)(i)-13). */
export function recordConditionalApproval(file: DecisionFile, i: { approved_on: string; expires_on: string; open_conditions: readonly { condition_id: string; description: string; kind?: "customary_closing" | "creditworthiness" }[] }): DecisionFile {
  const open_conditions = i.open_conditions.map((c) => ({ condition_id: c.condition_id, description: c.description, kind: c.kind ?? (CUSTOMARY_CLOSING_CONDITIONS.includes(c.condition_id) ? "customary_closing" : CREDITWORTHINESS_CONDITIONS.includes(c.condition_id) ? "creditworthiness" : "creditworthiness") as OpenCondition["kind"] }));
  return { ...file, disposition: open_conditions.some((c) => c.kind === "creditworthiness") ? "conditional_approval" : "approved", conditional_approval: { approved_on: plainDate(i.approved_on), expires_on: plainDate(i.expires_on), open_conditions } };
}
/** T13: the approval falls out (borrower cancels, seller cannot deliver, commitment expires): only customary closing conditions open → HMDA 2 with the approval expiration date; a creditworthiness condition open → 3 (or 4 on an express withdrawal). */
export function conditionalApprovalFallout(events: EventStore, file: DecisionFile, i: { as_of: string; reason: string; express_withdrawal?: boolean; withdrawal_statement?: string | null; reasons?: readonly PrincipalReason[] }): { file: DecisionFile; hmda: HmdaFields; events: DomainEvent[] } {
  assertNotTerminal(file); const at = isoInstant(i.as_of, "as_of"); if (!file.conditional_approval) throw new RangeError("no conditional approval on the file");
  const express = i.express_withdrawal === true && !!i.withdrawal_statement && isExpressWithdrawal(i.withdrawal_statement);
  const hmda = hmdaActionFor({ kind: "conditional_approval_fallout", open_conditions: file.conditional_approval.open_conditions, approval_expires_on: file.conditional_approval.expires_on, express_withdrawal: express, withdrawal_on: express ? civilDate(at, file.creditor_time_zone) : null, reasons: i.reasons ?? [] });
  const kind: DecisionKind = hmda.action_taken === 2 ? "approved_not_accepted" : hmda.action_taken === 4 ? "withdrawal" : "denial";
  const decision: DecisionRow = { decision_id: `D-FALLOUT-${file.application_id}`, application_id: file.application_id, kind, recommended_at: at, decided_at: at, basis_component: "rules", decision_factors: [], counteroffer_terms: null, combined_notice: false, reviewer_escalation_id: null, reviewer_id: null, reviewer_decided_at: null, reviewer_outcome: null, reviewer_sla_due_on: null, notice_id: null, sent_at: at, hmda_action_taken: null, hmda_action_taken_date: null, after_conditional_approval: true, du_recommendation: null, data_sufficient: true };
  const withdrawals = express ? [...file.withdrawals, { withdrawal_id: `W-FALLOUT-${file.application_id}`, application_id: file.application_id, received_at: at, received_on: civilDate(at, file.creditor_time_zone), channel: "any", statement_text: i.withdrawal_statement!, evidence_document_id: null, express: true, after_decision: false }] : file.withdrawals;
  let next = withDecision({ ...file, withdrawals, disposition: hmda.action_taken === 2 ? "approved_not_accepted" : hmda.action_taken === 4 ? "withdrawn" : "denied" }, decision);
  const out = [emit(events, next, "decision.issued", { decision_id: decision.decision_id, kind, decided_on: civilDate(at, file.creditor_time_zone), decided_at: at, sent_on: civilDate(at, file.creditor_time_zone), sent_at: at, consequential: kind === "denial", combined_notice: false, co_admt_applies: false, reason: i.reason, open_conditions: file.conditional_approval.open_conditions.map((c) => c.condition_id) }, at)];
  const h = recordHmdaAction(events, next, hmda, at, decision.decision_id); next = h.file; out.push(h.event);
  return { file: next, hmda, events: out };
}

// ============================================================ Colorado human review / correction (6-1-1705) and the standalone explanation
export function requestHumanReview(events: EventStore, file: DecisionFile, i: { decision_id: string; requested_at: string; kind: "human_review" | "correction"; request_text?: string | null }): { file: DecisionFile; due_on: PlainDate; event: DomainEvent } {
  const at = isoInstant(i.requested_at, "requested_at"); const aa = adverseOf(file, i.decision_id); if (!aa?.co_admt) throw new RangeError(`no Colorado ADMT record on decision ${i.decision_id}`);
  const requested_on = civilDate(at, file.creditor_time_zone); const due_on = addDays(requested_on, CO_HUMAN_REVIEW_DAYS);
  const co_admt: CoAdmt = i.kind === "human_review" ? { ...aa.co_admt, human_review_requested_at: at, human_review_due_on: due_on } : { ...aa.co_admt, correction_requested_at: at, human_review_due_on: due_on };
  const next = withAdverse(file, { ...aa, co_admt });
  return { file: next, due_on, event: emit(events, next, i.kind === "human_review" ? "co_admt.human_review.requested" : "co_admt.correction.requested", { decision_id: i.decision_id, adverse_action_id: aa.adverse_action_id, requested_on, request_date: requested_on, due_on, request_text: i.request_text ?? null, first_reviewer_id: aa.approving_reviewer_id }, at) };
}
/** Meaningful human review by an `underwriting_reviewer` different from the one who approved the decision; a correction that changes the data triggers re-verification and re-decision. */
export function completeHumanReview(events: EventStore, file: DecisionFile, i: { decision_id: string; kind: "human_review" | "correction"; reviewer: Actor; completed_at: string; outcome: string; data_changed?: boolean }): { file: DecisionFile; event: DomainEvent; redecision_required: boolean } {
  const at = isoInstant(i.completed_at, "completed_at"); const aa = adverseOf(file, i.decision_id); if (!aa?.co_admt) throw new RangeError(`no Colorado ADMT record on decision ${i.decision_id}`);
  if (i.reviewer.kind !== "human" || i.reviewer.role !== "underwriting_reviewer") throw new RangeError("Colorado human review is performed by an underwriting_reviewer");
  if (i.reviewer.id === aa.approving_reviewer_id) throw new RangeError(`reviewer ${i.reviewer.id} approved the decision: the human review is performed by a different reviewer (rule 7)`);
  if (i.kind === "human_review" && !aa.co_admt.human_review_requested_at) throw new RangeError("no human review was requested");
  if (i.kind === "correction" && !aa.co_admt.correction_requested_at) throw new RangeError("no correction was requested");
  const co_admt: CoAdmt = i.kind === "human_review" ? { ...aa.co_admt, human_review_reviewer_id: i.reviewer.id, human_review_completed_at: at, human_review_outcome: nonEmpty(i.outcome, "outcome (a written outcome)") } : { ...aa.co_admt, correction_completed_at: at, human_review_reviewer_id: i.reviewer.id };
  const next = withAdverse(file, { ...aa, co_admt });
  const redecision_required = i.kind === "correction" && i.data_changed === true;
  return { file: next, redecision_required, event: emit(events, next, i.kind === "human_review" ? "co_admt.human_review.completed" : "co_admt.correction.completed", { decision_id: i.decision_id, adverse_action_id: aa.adverse_action_id, reviewer_id: i.reviewer.id, first_reviewer_id: aa.approving_reviewer_id, completed_on: civilDate(at, file.creditor_time_zone), outcome: i.outcome, written_outcome: true, due_on: aa.co_admt.human_review_due_on, redecision_required }, at, i.reviewer) };
}
/** Standalone `NTC_CO_SB26_189_ADMT_NOTICE{adverse_outcome_explanation}` when the explanation was not embedded in the adverse action notice. */
export function sendAdmtExplanation(events: EventStore, file: DecisionFile, i: { decision_id: string; notice_id: string; sent_at: string }): { file: DecisionFile; event: DomainEvent } {
  const at = isoInstant(i.sent_at, "sent_at"); const aa = adverseOf(file, i.decision_id); if (!aa?.co_admt?.applies) throw new RangeError(`no Colorado ADMT duty on decision ${i.decision_id}`);
  const next = withAdverse(file, { ...aa, co_admt: { ...aa.co_admt, explanation_notice_id: i.notice_id, explanation_sent_at: at } });
  return { file: next, event: emit(events, next, "co_admt.explanation.sent", { decision_id: i.decision_id, adverse_action_id: aa.adverse_action_id, embedded: false, explanation_due_on: aa.co_admt.explanation_due_on, sent_on: civilDate(at, file.creditor_time_zone), notice_id: i.notice_id, late: aa.co_admt.explanation_due_on ? civilDate(at, file.creditor_time_zone) > aa.co_admt.explanation_due_on : false }, at) };
}

// ============================================================ worked-example arithmetic (purchase fixture: appraisal $445,000 against a $457,780 contract)
/** LTV as a percentage string with one decimal (e.g. 412,000 / 445,000 → "92.6"); the loan amount at a target LTV (90 % of $445,000 → $400,500). */
export function ltvPercent(loanCents: Cents, valueCents: Cents): string { if (valueCents <= 0n) throw new RangeError("value must be positive"); const tenths = divRound(loanCents * 1000n, valueCents); return `${tenths / 10n}.${tenths % 10n}`; }
export function loanAmountAtLtv(valueCents: Cents, ltvPct: number): Cents { return divRound(valueCents * BigInt(Math.round(ltvPct * 100)), 10_000n); }
export function valueNeededForLtv(loanCents: Cents, ltvPct: number): Cents { return divRound(loanCents * 10_000n, BigInt(Math.round(ltvPct * 100)), "CEIL"); }
/** The agent's decision record (`agent_decisions`): every clock, the factors, reasons, HMDA fields and the reviewer's trail. */
export function decisionRecord(file: DecisionFile, decision_id: string, extra: { rationale: string; confidence: number; model_version: string; prompt_version: string }): Record<string, unknown> {
  const d = decisionOf(file, decision_id); const aa = adverseOf(file, decision_id);
  return { decision_id, application_id: file.application_id, disposition: file.disposition, basis_component: d.basis_component, decision_factors: d.decision_factors, principal_reasons: aa?.principal_reasons ?? [], hmda: file.hmda ? { code: file.hmda.action_taken, date: file.hmda.action_taken_date, denial_codes: file.hmda.denial_reasons } : null,
    fcra_blocks: aa?.per_applicant.map((p) => p.fcra_block) ?? [], state_overlays: aa?.state_overlays ?? [], clocks: { decision_due_at: file.decision_due_at, counteroffer_due_at: d.kind === "counteroffer" && d.sent_at ? addDays(civilDate(d.sent_at, file.creditor_time_zone), REGB_COUNTEROFFER_DAYS) : null, co_explanation_due_at: aa?.co_admt?.explanation_due_on ?? null },
    reviewer: { escalation_id: d.reviewer_escalation_id, reviewer_id: d.reviewer_id, decided_at: d.reviewer_decided_at, changes: [] }, rationale: extra.rationale, model_version: extra.model_version, prompt_version: extra.prompt_version, confidence: extra.confidence, rule_set_version: RULE_SET_VERSION_21_6 };
}
