/**
 * §22.2 Credit report ordering, credit-score model and merge rules, analysis, freezes/disputes, inquiries and the
 * pre-closing refresh (undisclosed-debt monitoring) — the `verification` agent's credit rules as small pure functions
 * over the reseller adapter (a port defined here; src/infra wires the Xactus360-class adapter, tests use a fake).
 *
 * Events (subject = application; every payload carries `application_id` so src/kernel/timers/engine.ts arms the
 * §22.2 clocks — see timers-22-2.ts):
 *   credit.report.ordered{report_id, order_type, score_model, repositories_requested, client_order_id}
 *   credit.report.received{report_id, report_type, report_date, expires_at, score_model, borrower_ids, credit_reference_number, frozen_count}
 *     [arms FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M (evaluator gate), SM_CREDIT_EXPIRY_WARN_21 (anchor expires_at −21 days),
 *      SM_UDM_MONITOR_ACTIVE (daily); 21.3's FCRA_609G_SCORE_NOTICE_1BD arms on it too]
 *   credit.score.model.selected{score_model}                       (first hard pull; immutable for the loan — R11)
 *   credit.representative_score.computed{representative_score, representative_score_borrower_id, borrower_applicable_scores}
 *   credit.score_disclosure.prepared{borrower_id, …}               (one per borrower — only that borrower's data, §1022.75(c))
 *   credit.freeze.detected{borrower_id, repositories, frozen_count, blocks_du, borrower_notified_at}   [arms SM_CREDIT_FREEZE_FOLLOWUP_2]
 *   credit.freeze.lifted{borrower_id, repository, lifted_at, lift_window_start, lift_window_end}       [satisfies it]
 *   credit.report.superseded{superseded_report_id, by_report_id}   [satisfies SM_CREDIT_EXPIRY_WARN_21 — re-pull complete]
 *   credit.report.expired{report_id, expires_at, scheduled_note_date}
 *   credit.repull.scheduled{report_id, repull_by, scheduled_note_date}
 *   credit.fraud_alert.detected{borrower_id, repository, kind}     [22.6's FCRA_605A_H_ALERT_CONTACT_GATE arms on it]
 *   credit.dispute.detected{investigation_required, du_findings_received_at}  [arms SM_CREDIT_DISPUTE_RESOLUTION_5]
 *   credit.dispute.resolved{determination, documentation_ids}      [satisfies it]
 *   credit.inquiry.explained{inquiry_id, new_credit_obtained}
 *   credit.undisclosed_debt.found{source, monthly_payment_cents, disclosed_before_closing}   (22.5 / 23.1 consume)
 *   credit.udm.alert.received{alert_id, alert_type} · credit.udm.alert.resolved{alert_id, status} · credit.udm.heartbeat{vendor}
 *   credit.refresh.received{report_id, report_date, alerts_open}   (the pre-closing soft refresh; 23.1/23.3 consume)
 */
import { randomUUID } from "node:crypto";
import { type PlainDate, addMonths, addDays, addYears, parts } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor, type Calendar } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { formatCents, type Cents } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { evaluateGate, type GateResult } from "../../app/evaluators.ts";
import { SFC, type ScoreModel, type Occupancy } from "../leads-pricing/ops-20-4.ts";
import { evaluateFeeGate, type FeeGateResult } from "../application/ops-21-4.ts";

export type { ScoreModel, Occupancy };
export const AGENT: Actor = { kind: "agent", id: "verification" };
export const RULE_SET_VERSION = "fnma.selling.2026-09-02";
export const DU_RULE_SET_VERSION = "fnma.du.12.1";
export const LLPA_RULE_SET_VERSION = "fnma.llpa.2026-09-09";
export const CREDITOR_TZ = "America/Phoenix";
export const civilDate = (iso: string, tz = CREDITOR_TZ): PlainDate => wallClock(Date.parse(iso), tz).date;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(d: PlainDate): string { const p = parts(d); return `${MONTHS_SHORT[p.m - 1]} ${p.d}, ${p.y}`; }

export class CreditRefused extends Error {
  readonly code: string; readonly citation: string;
  constructor(code: string, citation: string, message: string) { super(message); this.name = "CreditRefused"; this.code = code; this.citation = citation; }
}
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const emit = (events: EventStore, applicationId: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor = AGENT): DomainEvent =>
  events.append({ type, applicationId, aggregate: { kind: "application", id: applicationId }, actor, occurredAt: at, payload: { application_id: applicationId, ...payload } });

// ============================================================ vocabulary (data model)
export type Repository = "efx" | "exp" | "tu";
export const REPOSITORIES: readonly Repository[] = ["efx", "exp", "tu"];
export const REPOSITORY_NAMES: Record<Repository, string> = { efx: "Equifax", exp: "Experian", tu: "TransUnion" };
/** Eligible score versions per bureau (B3-5.1-01, 04/22/2026; LL-2026-06): Classic FICO and VantageScore 4.0 — FICO 10T is not deliverable. */
export const SCORE_MODEL_CODES: Record<ScoreModel, Record<Repository, string>> = {
  classic_fico: { efx: "Equifax Beacon 5.0", exp: "Experian/Fair Isaac Risk Model V2", tu: "TransUnion FICO Risk Score, Classic 04" },
  vantagescore_4: { efx: "Equifax VantageScore 4.0", exp: "Experian VantageScore 4.0", tu: "TransUnion VantageScore 4.0" },
};
export const SCORE_MODELS: readonly ScoreModel[] = ["classic_fico", "vantagescore_4"];
export const SCORE_RANGE = { min: 300, max: 850 } as const;
export type ReportType = "tri_merge_infile" | "rmcr" | "soft_prequal" | "soft_refresh" | "udm_snapshot";
export type OrderType = "tri_merge" | "rmcr" | "soft_prequal" | "soft_refresh" | "udm_enroll";
export type ReportState = "ordered" | "received" | "parsed" | "usable" | "freeze_blocked" | "two_repository" | "no_score" | "error" | "du_reissued" | "relied_upon" | "superseded" | "expired";
export type PermissiblePurpose = "credit_transaction_604a3A" | "consumer_initiated_604a3F" | "account_review_604a3A";
export const HARD_PULL_ORDERS: readonly OrderType[] = ["tri_merge", "rmcr"];
export const ORDER_REPORT_TYPE: Record<OrderType, ReportType> = { tri_merge: "tri_merge_infile", rmcr: "rmcr", soft_prequal: "soft_prequal", soft_refresh: "soft_refresh", udm_enroll: "udm_snapshot" };

export interface BureauScore { readonly score: number | null; readonly model_version: string; readonly key_factors: readonly string[]; readonly inquiries_key_factor?: boolean; }
export interface BorrowerCredit { readonly borrower_id: string; readonly scores: Partial<Record<Repository, BureauScore>>; readonly returned: readonly Repository[]; readonly frozen: readonly Repository[]; readonly no_hit?: readonly Repository[]; }
export type FraudAlertKind = "initial" | "extended" | "active_duty";
export interface FraudAlert { readonly borrower_id: string; readonly repository: Repository; readonly kind: FraudAlertKind; readonly contact_phone?: string | null; }
export interface Inquiry { readonly borrower_id: string; readonly creditor_name: string; readonly inquiry_date: PlainDate; readonly repository: Repository; readonly subscriber_code?: string | null; readonly purpose?: string | null; }
export interface DisputedTradeline { readonly borrower_id: string; readonly creditor_name: string; readonly account_ref: string; readonly medical: boolean; readonly du_message_id?: string | null; }
export interface PublicRecord { readonly borrower_id: string; readonly kind: "judgment" | "lien" | "bankruptcy" | "foreclosure"; readonly status: "open" | "satisfied" | "discharged" | "dismissed"; readonly amount_cents: Cents; readonly date: PlainDate; }
export interface CollectionAccount { readonly borrower_id: string; readonly creditor_name: string; readonly kind: "collection" | "charge_off"; readonly balance_cents: Cents; readonly mortgage_related?: boolean; }
export interface MortgageTradeline { readonly borrower_id: string; readonly creditor_name: string; readonly worst_delinquency_days_at_last_report: number; readonly last_reported: PlainDate; }
export interface KnownTradeline { readonly borrower_id: string; readonly creditor_name: string; readonly account_ref: string; readonly liability_kind: string; readonly monthly_payment_cents: Cents; readonly balance_cents: Cents; }
export interface CraIdentity { readonly name: string; readonly address: string; readonly phone: string; }
export interface IdentityHeader { readonly borrower_id: string; readonly name: string; readonly ssn_last4: string; readonly address: string; }

/** The reseller's parsed response (MISMO 2.3.1 credit XML → this shape; the adapter does the XML). */
export interface CreditReportResponse {
  readonly credit_reference_number: string; readonly du_credit_provider_code: string | null; readonly reseller: string; readonly report_date: PlainDate; readonly received_at: string;
  readonly borrowers: readonly BorrowerCredit[]; readonly fraud_alerts?: readonly FraudAlert[]; readonly inquiries?: readonly Inquiry[]; readonly disputed_tradelines?: readonly DisputedTradeline[];
  readonly public_records?: readonly PublicRecord[]; readonly collections?: readonly CollectionAccount[]; readonly mortgage_tradelines?: readonly MortgageTradeline[]; readonly tradelines?: readonly KnownTradeline[];
  readonly identity_headers?: readonly IdentityHeader[]; readonly trended_data: boolean; readonly cra: CraIdentity; readonly fee_cents: Cents; readonly document_id?: string | null;
}
export interface CreditOrder {
  readonly client_order_id: string; readonly application_id: string; readonly order_type: OrderType; readonly borrower_ids: readonly string[]; readonly joint: boolean;
  readonly repositories: readonly Repository[]; readonly score_model: ScoreModel; readonly model_codes: Record<Repository, string>; readonly subscriber_code: string; readonly certification_ref: string;
  readonly permissible_purpose: PermissiblePurpose; readonly borrower_authorization_ref: string; readonly ordering_agent: string; readonly attempt: number;
}
/** The credit reseller port (tri-merge, soft pre-qualification, refresh, UDM enrolment). src/infra wires the adapter; tests use a fake. */
export interface CreditBureauPort { order(o: CreditOrder): Promise<CreditReportResponse>; }

export interface CreditReport {
  readonly report_id: string; readonly application_id: string; readonly report_type: ReportType; readonly reseller: string; readonly du_credit_provider_code: string | null; readonly credit_reference_number: string | null;
  readonly borrower_ids: readonly string[]; readonly repositories_requested: readonly Repository[]; readonly repositories_returned: readonly Repository[]; readonly frozen_repositories: readonly Repository[];
  readonly borrowers: readonly BorrowerCredit[]; readonly fraud_alerts: readonly FraudAlert[]; readonly score_model: ScoreModel;
  readonly borrower_applicable_scores: Record<string, number | null>; readonly representative_score: number | null; readonly representative_score_borrower_id: string | null; readonly no_score_borrowers: readonly string[];
  readonly key_factors: Record<string, Partial<Record<Repository, readonly string[]>>>; readonly inquiries_90d: readonly Inquiry[]; readonly disputed_tradelines: readonly DisputedTradeline[]; readonly public_records: readonly PublicRecord[];
  readonly collections: readonly CollectionAccount[]; readonly mortgage_tradelines: readonly MortgageTradeline[]; readonly tradelines: readonly KnownTradeline[]; readonly identity_headers: readonly IdentityHeader[]; readonly trended_data: boolean;
  readonly permissible_purpose: PermissiblePurpose; readonly certification_ref: string; readonly pulled_at: string; readonly report_date: PlainDate; readonly expires_at: PlainDate; readonly fee_cents: Cents; readonly fee_item_id: string | null;
  readonly document_id: string | null; readonly supersedes_report_id: string | null; readonly cra: CraIdentity; readonly state: ReportState; readonly state_reason: string | null; readonly fraud_alert_cleared: boolean;
}

// ============================================================ R1 — ordering (B3-5.2-01; FCRA §604(a)(3)(A)/(f); LL-2026-06; §1026.19(e)(2)(i)(B))
export interface OrderInput {
  readonly application_id: string; readonly borrower_ids: readonly string[]; readonly order_type: OrderType; readonly score_model: ScoreModel;
  /** `applications.score_model` (null before the first hard pull). */
  readonly app_score_model: ScoreModel | null;
  /** Per-bureau score-model request codes the caller wants on the order; must match `SCORE_MODEL_CODES[score_model]`. */
  readonly requested_model_codes?: Partial<Record<Repository, string>> | null;
  readonly repositories?: readonly Repository[]; readonly permissible_purpose: PermissiblePurpose | string; readonly certification_ref: string; readonly borrower_authorization_ref: string; readonly subscriber_code: string;
  readonly trid_received: boolean; readonly fee_handled: boolean; readonly joint_intent_facts?: Record<string, unknown> | null; readonly bi_merge_flag?: boolean; readonly ordering_agent: string; readonly attempt?: number;
}
const PURPOSE_FOR_ORDER: Record<OrderType, PermissiblePurpose> = { tri_merge: "credit_transaction_604a3A", rmcr: "credit_transaction_604a3A", soft_prequal: "consumer_initiated_604a3F", soft_refresh: "credit_transaction_604a3A", udm_enroll: "account_review_604a3A" };
/** Validates an order before transmission — every refusal is a `CreditRefused` with the rule's citation; nothing reaches the reseller on a refusal. */
export function validateOrder(i: OrderInput): CreditOrder {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.subscriber_code, "subscriber_code");
  if (!i.borrower_ids.length) throw new RangeError("at least one borrower_id is required");
  if (!(SCORE_MODELS as readonly string[]).includes(i.score_model)) throw new RangeError(`score_model ${JSON.stringify(i.score_model)} is not one of ${SCORE_MODELS.join("/")}`);
  if (!(Object.keys(ORDER_REPORT_TYPE) as string[]).includes(i.order_type)) throw new RangeError(`order_type ${JSON.stringify(i.order_type)} is not one of ${Object.keys(ORDER_REPORT_TYPE).join("/")}`);
  if (!i.permissible_purpose || !i.certification_ref || !i.borrower_authorization_ref)
    throw new CreditRefused("PERMISSIBLE_PURPOSE_REQUIRED", "15 U.S.C. 1681b(f); §1681e certification; 22.2 guardrail", "no pull without a recorded permissible purpose, the partner's §1681e certification reference and the borrower's authorization");
  if (i.permissible_purpose !== PURPOSE_FOR_ORDER[i.order_type])
    throw new CreditRefused("PERMISSIBLE_PURPOSE_MISMATCH", "15 U.S.C. 1681b(a)(3)(A)/(F)", `${i.order_type} orders carry permissible purpose ${PURPOSE_FOR_ORDER[i.order_type]}, not ${i.permissible_purpose}`);
  const hard = HARD_PULL_ORDERS.includes(i.order_type);
  if (hard && !(i.trid_received && i.fee_handled))
    throw new CreditRefused("SIX_ITEMS_AND_FEE_FIRST", "22.2 R1; 12 CFR 1026.19(e)(2)(i)(B); 21.4 REGZ_1026_19E2_INTENT_FEE_GATE", "no hard pull before the six TRID items exist and the credit-report fee handling is recorded");
  const repositories = i.repositories ?? REPOSITORIES;
  if (hard && (repositories.length < 3 || REPOSITORIES.some((r) => !repositories.includes(r))))
    throw new CreditRefused("NO_BI_MERGE", "B3-5.2-01 (three in-file merged report); credit.bi_merge = false (R11)", "a two-repository request is never made; a two-repository result is acceptable only under R4");
  if (i.bi_merge_flag === true) throw new CreditRefused("NO_BI_MERGE", "credit.bi_merge = false (baseline §9)", "bi-merge is not implemented (FHFA status as of 2026)");
  if (i.app_score_model !== null && i.app_score_model !== i.score_model)
    throw new CreditRefused("SCORE_MODEL_MISMATCH", "LL-2026-06: the same credit score model must be used for all borrowers on a single loan; 22.2 R11", `applications.score_model = ${i.app_score_model}; an order under ${i.score_model} is rejected before transmission`);
  const model_codes = SCORE_MODEL_CODES[i.score_model];
  for (const r of REPOSITORIES) {
    const want = i.requested_model_codes?.[r];
    if (want !== undefined && want !== null && want !== model_codes[r])
      throw new CreditRefused("SCORE_MODEL_MISMATCH", "LL-2026-06; B3-5.1-01 eligible score versions", `${REPOSITORY_NAMES[r]} request code ${JSON.stringify(want)} is not the ${i.score_model} version ${JSON.stringify(model_codes[r])}: rejected before transmission`);
  }
  const joint = i.borrower_ids.length > 1;
  if (joint && hard) {
    const g = evaluateGate("21.1.jointIntentGate", i.joint_intent_facts ?? {});
    if (!g.open) throw new CreditRefused("JOINT_INTENT_GATE_CLOSED", "12 CFR 1002.7(d); SM_O21_JOINT_INTENT_GATE (21.1)", g.reason ?? "joint intent not evidenced for every borrower");
  }
  const attempt = i.attempt ?? 1;
  return { client_order_id: `${i.application_id}:${[...i.borrower_ids].sort().join("+")}:${i.order_type}:${attempt}`, application_id: i.application_id, order_type: i.order_type, borrower_ids: [...i.borrower_ids], joint, repositories: [...repositories], score_model: i.score_model,
    model_codes: { ...model_codes }, subscriber_code: i.subscriber_code, certification_ref: i.certification_ref, permissible_purpose: i.permissible_purpose as PermissiblePurpose, borrower_authorization_ref: i.borrower_authorization_ref, ordering_agent: i.ordering_agent, attempt };
}

// ============================================================ R2 — applicable and representative score (B3-5.1-02)
/** Three scores → middle; two → lower; one → that score; none → null. */
export function applicableScore(scores: readonly (number | null | undefined)[]): number | null {
  const xs = scores.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  for (const x of xs) if (x < SCORE_RANGE.min || x > SCORE_RANGE.max) throw new RangeError(`score ${x} outside ${SCORE_RANGE.min}–${SCORE_RANGE.max}`);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0]!;
  if (xs.length === 2) return xs[0]!;
  return xs[Math.floor(xs.length / 2)]!;
}
export interface ScoreComputation { readonly borrower_applicable_scores: Record<string, number | null>; readonly representative_score: number | null; readonly representative_score_borrower_id: string | null; readonly no_score_borrowers: readonly string[]; readonly basis: string; }
/** Representative = the lowest applicable score over the borrowers who have one; a borrower without a score is left out (B3-5.1-02); nobody scored → null (lowest LLPA band, 20.4). */
export function computeScores(borrowers: readonly BorrowerCredit[]): ScoreComputation {
  const borrower_applicable_scores: Record<string, number | null> = {};
  const no_score_borrowers: string[] = [];
  let rep: number | null = null, repId: string | null = null;
  for (const b of borrowers) {
    const s = applicableScore(REPOSITORIES.map((r) => b.scores[r]?.score));
    borrower_applicable_scores[b.borrower_id] = s;
    if (s === null) { no_score_borrowers.push(b.borrower_id); continue; }
    if (rep === null || s < rep) { rep = s; repId = b.borrower_id; }
  }
  return { borrower_applicable_scores, representative_score: rep, representative_score_borrower_id: repId, no_score_borrowers,
    basis: rep === null ? "no borrower has a credit score: representative_score null, lowest LLPA band (B3-5.1-02; LLPA Matrix)" : `lowest applicable score across scored borrowers (B3-5.1-02): ${repId} ${rep}` };
}

// ============================================================ R3 — freshness (B1-1-03: four months on the note date)
export const CREDIT_REPORT_AGE_MONTHS = 4;
export const EXPIRY_WARN_DAYS = 21;
export const REPULL_LEAD_DAYS = 10;
export function expiresAt(report_date: PlainDate): PlainDate { return addMonths(report_date, CREDIT_REPORT_AGE_MONTHS); }
export function warnDate(expires_at: PlainDate): PlainDate { return addDays(expires_at, -EXPIRY_WARN_DAYS); }
/** The re-pull must land ≥ 10 calendar days before the scheduled note date (timer breach action). */
export function repullBy(scheduled_note_date: PlainDate): PlainDate { return addDays(scheduled_note_date, -REPULL_LEAD_DAYS); }
/** FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M: open iff `expires_at ≥ scheduled_note_date` (facts: report_date or expires_at, scheduled_note_date). */
export function creditReportExpiryGate(f: Record<string, unknown>): GateResult {
  const note = typeof f.scheduled_note_date === "string" && f.scheduled_note_date ? (f.scheduled_note_date as PlainDate) : null;
  if (!note) return { open: false, reason: "scheduled_note_date is unknown: the four-month test cannot run (B1-1-03)" };
  const exp = typeof f.expires_at === "string" && f.expires_at ? (f.expires_at as PlainDate) : typeof f.report_date === "string" && f.report_date ? expiresAt(f.report_date as PlainDate) : null;
  if (!exp) return { open: false, reason: "no credit report relied upon (report_date/expires_at missing)" };
  if (f.state === "superseded" || f.state === "expired") return { open: false, reason: `credit report is ${String(f.state)}` };
  return exp >= note ? { open: true } : { open: false, reason: `credit report expires ${exp} (report date + 4 months, B1-1-03) before the scheduled note date ${note}: new tri-merge under the same score_model, DU resubmission (23.1), pricing re-check (20.4)` };
}

// ============================================================ R4 — freezes (B3-5.1-01; FCRA §605A(i)) and report classification
export interface Classification { readonly state: ReportState; readonly reason: string; readonly blocked_borrowers: readonly string[]; readonly two_repository_borrowers: readonly string[]; readonly escalate_underwriting_reviewer: boolean; }
/** usable: every borrower has three repositories, or two with exactly one frozen (or a documented no-hit); freeze_blocked: any borrower frozen at ≥ 2; no_score: nobody scored; error: a borrower with < 2 repositories of data. */
export function classifyReport(r: { report_type: ReportType; repositories_requested: readonly Repository[]; borrowers: readonly BorrowerCredit[] }): Classification {
  const blocked: string[] = [], two: string[] = [], thin: string[] = [];
  for (const b of r.borrowers) {
    if (b.frozen.length >= 2) { blocked.push(b.borrower_id); continue; }
    const returned = b.returned.filter((x) => !b.frozen.includes(x));
    if (returned.length < 2) { thin.push(b.borrower_id); continue; }
    if (returned.length === 2) two.push(b.borrower_id);
  }
  if (blocked.length) return { state: "freeze_blocked", reason: `credit data frozen at two or more repositories for ${blocked.join(", ")}: not eligible until lifted (B3-5.1-01); submitDu refused`, blocked_borrowers: blocked, two_repository_borrowers: two, escalate_underwriting_reviewer: false };
  if (thin.length) return { state: "error", reason: `only one repository returned data for ${thin.join(", ")}: two are required (B3-5.2-02) — freeze workflow plus RMCR consideration`, blocked_borrowers: thin, two_repository_borrowers: two, escalate_underwriting_reviewer: true };
  const sc = computeScores(r.borrowers);
  if (sc.representative_score === null) return { state: "no_score", reason: "no borrower has a credit score: nontraditional path (23.2), 12-month asset report (22.4), lowest LLPA band", blocked_borrowers: [], two_repository_borrowers: two, escalate_underwriting_reviewer: false };
  if (r.repositories_requested.length < 3 && HARD_PULL_ORDERS.includes(r.report_type === "rmcr" ? "rmcr" : "tri_merge")) return { state: "error", reason: "a three in-file merged report must have been requested (B3-5.1-01)", blocked_borrowers: [], two_repository_borrowers: two, escalate_underwriting_reviewer: true };
  if (two.length) {
    const noHitOnly = r.borrowers.filter((b) => two.includes(b.borrower_id) && b.frozen.length === 0);
    if (noHitOnly.length) return { state: "two_repository", reason: `two repositories returned data for ${noHitOnly.map((b) => b.borrower_id).join(", ")} with no freeze: acceptable only with the reseller's no-hit evidence (B3-5.2-02; Q4)`, blocked_borrowers: [], two_repository_borrowers: two, escalate_underwriting_reviewer: false };
    return { state: "usable", reason: `two repositories with exactly one frozen for ${two.join(", ")}: acceptable on a requested tri-merge (B3-5.1-01); applicable score = lower of the two`, blocked_borrowers: [], two_repository_borrowers: two, escalate_underwriting_reviewer: false };
  }
  return { state: "usable", reason: "three repositories returned for every borrower", blocked_borrowers: [], two_repository_borrowers: [], escalate_underwriting_reviewer: false };
}

export type FreezeStatus = "open" | "lifted" | "re_pulled" | "borrower_declined" | "ineligible_two_or_more";
export interface FreezeAction {
  readonly action_id: string; readonly application_id: string; readonly borrower_id: string; readonly repository: Repository; readonly detected_at: string; readonly borrower_notified_at: string | null;
  readonly lift_requested_by_borrower_at: string | null; readonly lift_window_start: PlainDate | null; readonly lift_window_end: PlainDate | null; readonly re_pull_at: string | null; readonly status: FreezeStatus; readonly report_id: string;
}
export const LIFT_WINDOW_DAYS = 7;
/** Borrower-facing content for the needs-list item (22.1's NTC_SM_NEEDS_LIST): factual only — the price MAY change (never "will improve"), lift instructions per §605A(i), a re-pull is offered. */
export function freezeNotice(borrower_id: string, repositories: readonly Repository[], repull_on: PlainDate, blocks_du: boolean): Record<string, unknown> {
  const names = repositories.map((r) => REPOSITORY_NAMES[r]);
  return { template_code: "NTC_SM_NEEDS_LIST", borrower_id, items: names.map((n) => `lift the security freeze at ${n}`),
    statement: blocks_du ? `Your credit file is frozen at ${names.join(" and ")}. Fannie Mae requires credit data from at least two repositories; the loan cannot proceed until the freeze is lifted.` : `Your credit file is frozen at ${names.join(" and ")}. The report is acceptable with two repositories; lifting the freeze and re-pulling may change the price, which is based on the representative credit score under Fannie Mae's rule.`,
    lift_instructions: "Request a temporary removal from the bureau (1 hour by telephone or secure electronic means; 3 business days by mail — 15 U.S.C. 1681c-1(i)) for the period you specify.", suggested_lift_window: { start: repull_on, end: addDays(repull_on, LIFT_WINDOW_DAYS) }, offers: ["lift_freeze", "re_pull"],
    decline_consequence: "If you choose not to lift the freeze, the application is treated as incomplete for this item (15 U.S.C. 1681c-1(i)(3)(D)).", fcra_rights: "supplied by 21.3/21.6 templates", ai_disclosure: true };
}
/** One `credit.freeze.detected` per frozen borrower (any count ≥ 1) plus a freeze action row per frozen repository; `blocks_du` when frozen at two or more. */
export function detectFreezes(events: EventStore, report: CreditReport, at: string, actor: Actor = AGENT): { actions: FreezeAction[]; events: DomainEvent[]; blocks_du: boolean } {
  const actions: FreezeAction[] = [], out: DomainEvent[] = [];
  let blocks = false;
  for (const b of report.borrowers) {
    if (!b.frozen.length) continue;
    const blocks_du = b.frozen.length >= 2; blocks ||= blocks_du;
    const repull_on = civilDate(at);
    for (const repository of b.frozen) actions.push({ action_id: randomUUID(), application_id: report.application_id, borrower_id: b.borrower_id, repository, detected_at: at, borrower_notified_at: at, lift_requested_by_borrower_at: null, lift_window_start: null, lift_window_end: null, re_pull_at: null, status: blocks_du ? "ineligible_two_or_more" : "open", report_id: report.report_id });
    out.push(emit(events, report.application_id, "credit.freeze.detected", { report_id: report.report_id, borrower_id: b.borrower_id, repositories: [...b.frozen], frozen_count: b.frozen.length, blocks_du, borrower_notified_at: at, borrower_notice: freezeNotice(b.borrower_id, b.frozen, repull_on, blocks_du) }, at, actor));
  }
  return { actions, events: out, blocks_du: blocks };
}
export interface LiftInput { readonly lifted_at: string; readonly lift_window_start: PlainDate; readonly lift_window_end: PlainDate; readonly method: "electronic" | "telephone" | "mail"; }
/** The borrower's lift confirmation: `credit.freeze.lifted` satisfies SM_CREDIT_FREEZE_FOLLOWUP_2; the re-pull must fall inside the window. */
export function liftFreeze(events: EventStore, a: FreezeAction, l: LiftInput, actor: Actor = AGENT): { action: FreezeAction; event: DomainEvent } {
  if (a.status === "lifted" || a.status === "re_pulled") throw new RangeError(`freeze action ${a.action_id} already ${a.status}`);
  if (l.lift_window_end < l.lift_window_start) throw new RangeError("lift_window_end before lift_window_start");
  const action: FreezeAction = { ...a, status: "lifted", lift_requested_by_borrower_at: l.lifted_at, lift_window_start: l.lift_window_start, lift_window_end: l.lift_window_end };
  return { action, event: emit(events, a.application_id, "credit.freeze.lifted", { action_id: a.action_id, borrower_id: a.borrower_id, repository: a.repository, lifted_at: l.lifted_at, method: l.method, lift_window_start: l.lift_window_start, lift_window_end: l.lift_window_end }, l.lifted_at, actor) };
}
export function declineLift(events: EventStore, a: FreezeAction, at: string, actor: Actor = AGENT): { action: FreezeAction; event: DomainEvent; incompleteness_path: "21.6_NOIA" } {
  const action: FreezeAction = { ...a, status: "borrower_declined" };
  return { action, incompleteness_path: "21.6_NOIA", event: emit(events, a.application_id, "credit.freeze.declined", { action_id: a.action_id, borrower_id: a.borrower_id, repository: a.repository, noia_item: `lift the security freeze at ${REPOSITORY_NAMES[a.repository]}` }, at, actor) };
}
/** The re-pull replaces the earlier report: `credit.report.superseded` (satisfies SM_CREDIT_EXPIRY_WARN_21 — re-pull complete). */
export function supersedeReport(events: EventStore, old: CreditReport, by: CreditReport, at: string, actor: Actor = AGENT): { old: CreditReport; by: CreditReport; event: DomainEvent } {
  if (old.application_id !== by.application_id) throw new RangeError("reports belong to different applications");
  if (old.score_model !== by.score_model) throw new CreditRefused("SCORE_MODEL_CHANGE_NEEDS_DECISION", "22.2 R11 / guardrail: never change score_model mid-loan without a full re-pull and a written decision", "the superseding report is under a different score model");
  return { old: { ...old, state: "superseded" }, by: { ...by, supersedes_report_id: old.report_id }, event: emit(events, old.application_id, "credit.report.superseded", { superseded_report_id: old.report_id, by_report_id: by.report_id, by_report_date: by.report_date, by_expires_at: by.expires_at }, at, actor) };
}
/** submitDu (23.1) refuses on a freeze-blocked, error, soft or fraud-alert-uncleared report, or before `score_model` is set. */
export function assertDuSubmittable(report: CreditReport, app_score_model: ScoreModel | null): void {
  if (report.report_type === "soft_prequal") throw new CreditRefused("SOFT_REPORT_NOT_FOR_DU", "22.2 guardrail: never use a soft pre-qualification report for DU", "soft pre-qualification reports are never used for DU");
  if (app_score_model === null) throw new CreditRefused("SCORE_MODEL_UNSET", "22.2 R11: a DU casefile is created only after applications.score_model is set", "score_model is not set on the application");
  if (report.state === "freeze_blocked") throw new CreditRefused("FREEZE_BLOCKED", "B3-5.1-01: frozen at two or more repositories → not eligible whether underwritten manually or in DU", `report ${report.report_id} is freeze_blocked: ${report.state_reason ?? ""}`);
  if (report.state === "error" || report.state === "superseded" || report.state === "expired") throw new CreditRefused("REPORT_NOT_USABLE", "B3-5.2-01/-02", `report ${report.report_id} is ${report.state}`);
  if (report.fraud_alerts.length && !report.fraud_alert_cleared) throw new CreditRefused("FRAUD_ALERT_CONTACT_PENDING", "FCRA §605A(h); 22.6 FCRA_605A_H_ALERT_CONTACT_GATE", "fraud/active-duty alert: 22.6 contact step not completed");
}

// ============================================================ R5 — fraud alerts and identity mismatches (FCRA §605A(a)–(c),(h); 22.6)
export function detectFraudAlerts(events: EventStore, report: CreditReport, application_identities: readonly IdentityHeader[], at: string, actor: Actor = AGENT): { alerts: FraudAlert[]; mismatches: { borrower_id: string; fields: string[] }[]; events: DomainEvent[]; blocks_du: boolean; handoff: "fraud-risk" | null } {
  const out: DomainEvent[] = [];
  for (const a of report.fraud_alerts) out.push(emit(events, report.application_id, "credit.fraud_alert.detected", { report_id: report.report_id, borrower_id: a.borrower_id, repository: a.repository, kind: a.kind, contact_phone: a.contact_phone ?? null, contact_required_before: "decision.issued{approval} / submitDu" }, at, actor));
  const mismatches: { borrower_id: string; fields: string[] }[] = [];
  for (const h of report.identity_headers) {
    const app = application_identities.find((x) => x.borrower_id === h.borrower_id); if (!app) continue;
    const fields = (["name", "ssn_last4", "address"] as const).filter((k) => norm(h[k]) !== norm(app[k]));
    if (fields.length) { mismatches.push({ borrower_id: h.borrower_id, fields }); out.push(emit(events, report.application_id, "credit.identity_mismatch.detected", { report_id: report.report_id, borrower_id: h.borrower_id, fields }, at, actor)); }
  }
  const blocks = report.fraud_alerts.length > 0 || mismatches.length > 0;
  return { alerts: [...report.fraud_alerts], mismatches, events: out, blocks_du: blocks, handoff: blocks ? "fraud-risk" : null };
}
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

// ============================================================ R6 — disputed tradelines, collections, public records, mortgage lates (B3-5.3-09)
export const COLLECTIONS_SECOND_HOME_OR_2_4_UNIT_AGGREGATE_CENTS = 500_000n;
export const COLLECTIONS_INVESTMENT_INDIVIDUAL_CENTS = 25_000n;
export const COLLECTIONS_INVESTMENT_AGGREGATE_CENTS = 100_000n;
export interface Condition { readonly kind: "ptf_collections_payoff" | "ptf_public_record_payoff" | "dispute_documentation" | "du_ineligible_mortgage_delinquency"; readonly text: string; readonly amount_cents: Cents | null; readonly citation: string; readonly borrower_id?: string | null; readonly clear_by: "prior_to_or_at_closing" | "before_cd" | "before_du_final"; }
export interface OccupancyFacts { readonly occupancy: Occupancy; readonly units: number; }
/** One-unit principal residence: no payoff regardless of amount; 2–4 unit principal or second home: aggregate > $5,000; investment: individual ≥ $250 or aggregate > $1,000 (non-mortgage collections and charge-offs). */
export function collectionsCondition(o: OccupancyFacts, collections: readonly CollectionAccount[]): Condition | null {
  const eligible = collections.filter((c) => !c.mortgage_related);
  const total = eligible.reduce((s, c) => s + c.balance_cents, 0n);
  if (!eligible.length) return null;
  const ptf = (why: string): Condition => ({ kind: "ptf_collections_payoff", text: `pay ${formatCents(total)} in full prior to or at closing`, amount_cents: total, citation: `B3-5.3-09 (${why})`, clear_by: "prior_to_or_at_closing" });
  if (o.occupancy === "primary" && o.units === 1) return null;
  if (o.occupancy === "primary" || o.occupancy === "second_home") return total > COLLECTIONS_SECOND_HOME_OR_2_4_UNIT_AGGREGATE_CENTS ? ptf(`${o.occupancy === "second_home" ? "second home" : "2–4 unit principal residence"}: collections and non-mortgage charge-offs totaling more than $5,000`) : null;
  const individual = eligible.some((c) => c.balance_cents >= COLLECTIONS_INVESTMENT_INDIVIDUAL_CENTS);
  return individual || total > COLLECTIONS_INVESTMENT_AGGREGATE_CENTS ? ptf("investment property: individual accounts ≥ $250 or accounts totaling more than $1,000") : null;
}
export const MORTGAGE_DELINQUENCY_LOOKBACK_MONTHS = 12;
export const MORTGAGE_DELINQUENCY_INELIGIBLE_DAYS = 60;
/** A mortgage tradeline 60+ days past due at last report within the 12 months before the report date → DU Ineligible (flag early for 21.6's Reg B clock). */
export function mortgageDelinquencyIneligible(report_date: PlainDate, lines: readonly MortgageTradeline[]): MortgageTradeline[] {
  const floor = addMonths(report_date, -MORTGAGE_DELINQUENCY_LOOKBACK_MONTHS);
  return lines.filter((l) => l.worst_delinquency_days_at_last_report >= MORTGAGE_DELINQUENCY_INELIGIBLE_DAYS && l.last_reported >= floor && l.last_reported <= report_date);
}
export interface DuCreditMessage { readonly id: string; readonly kind: "disputed_tradeline" | "collections" | "public_record" | "mortgage_delinquency" | "authorized_user" | "undisclosed_liability_relief" | "other"; readonly text: string; readonly account_ref?: string | null; readonly borrower_id?: string | null; }
export interface DuMapping { readonly conditions: Condition[]; readonly disputes: { dispute_id: string; tradeline: DisputedTradeline; investigation_required: boolean; needs_list_item: string | null }[]; readonly du_ineligible: boolean; readonly relief_message_3941: boolean; readonly events: DomainEvent[]; readonly authorized_user_investigation_required: false; }
/** Maps DU credit messages to conditions, dispute items and flags; a disputed non-medical tradeline opens the borrower's documentation item and arms SM_CREDIT_DISPUTE_RESOLUTION_5 from `du_findings_received_at`. */
export function mapDuCreditMessages(events: EventStore, report: CreditReport, i: { occupancy: OccupancyFacts; du_messages: readonly DuCreditMessage[]; du_findings_received_at: string; du_recommendation?: string | null }, actor: Actor = AGENT): DuMapping {
  nonEmpty(i.du_findings_received_at, "du_findings_received_at");
  const conditions: Condition[] = [], disputes: DuMapping["disputes"] = [], out: DomainEvent[] = [];
  const approveWithDisputes = /^approve/i.test(i.du_recommendation ?? "") && !i.du_messages.some((m) => m.kind === "disputed_tradeline");
  for (const m of i.du_messages) {
    if (m.kind !== "disputed_tradeline" || approveWithDisputes) continue;
    for (const t of report.disputed_tradelines.filter((t) => (m.account_ref ? t.account_ref === m.account_ref : true) && (m.borrower_id ? t.borrower_id === m.borrower_id : true))) {
      const investigation_required = !t.medical;
      const dispute_id = randomUUID();
      disputes.push({ dispute_id, tradeline: t, investigation_required, needs_list_item: investigation_required ? `dispute documentation: ${t.creditor_name} (${t.account_ref})` : null });
      if (investigation_required) { conditions.push({ kind: "dispute_documentation", text: `documentation and a written determination for the disputed ${t.creditor_name} tradeline (responsible? accurate?)`, amount_cents: null, citation: "B3-5.3-09 DU disputed tradelines", borrower_id: t.borrower_id, clear_by: "before_cd" }); }
      out.push(emit(events, report.application_id, "credit.dispute.detected", { report_id: report.report_id, dispute_id, borrower_id: t.borrower_id, creditor_name: t.creditor_name, account_ref: t.account_ref, medical: t.medical, investigation_required, du_message_id: m.id, du_findings_received_at: i.du_findings_received_at }, i.du_findings_received_at, actor));
    }
  }
  const coll = collectionsCondition(i.occupancy, report.collections); if (coll) conditions.push(coll);
  for (const p of report.public_records.filter((p) => p.status === "open" && (p.kind === "judgment" || p.kind === "lien")))
    conditions.push({ kind: "ptf_public_record_payoff", text: `pay the open ${p.kind} of ${formatCents(p.amount_cents)} at or prior to closing (title clearance, 24.4)`, amount_cents: p.amount_cents, citation: "B3-5.3-09 judgments and liens", borrower_id: p.borrower_id, clear_by: "prior_to_or_at_closing" });
  const lates = mortgageDelinquencyIneligible(report.report_date, report.mortgage_tradelines);
  if (lates.length) conditions.push({ kind: "du_ineligible_mortgage_delinquency", text: `mortgage tradeline ${lates.map((l) => l.creditor_name).join(", ")} 60+ days past due within 12 months of the report date: DU Ineligible — 21.6 acts within Reg B's 30 days`, amount_cents: null, citation: "B3-5.3-09 mortgage delinquency", clear_by: "before_du_final" });
  return { conditions, disputes, du_ineligible: lates.length > 0 || i.du_messages.some((m) => m.kind === "mortgage_delinquency"), relief_message_3941: i.du_messages.some((m) => m.kind === "undisclosed_liability_relief" || /\b3941\b/.test(m.text)), events: out, authorized_user_investigation_required: false };
}
export type DisputeDetermination = "not_responsible" | "responsible_adverse_disproved" | "responsible_and_accurate";
export function resolveDispute(events: EventStore, i: { application_id: string; dispute_id: string; borrower_id: string; determination: DisputeDetermination; documentation_ids: readonly string[]; rationale: string; resolved_at: string }, actor: Actor = AGENT): { event: DomainEvent; eligible_as_du: boolean; escalate: "underwriting_reviewer" | null } {
  if (!i.documentation_ids.length) throw new RangeError("a dispute resolution needs documentation_ids (B3-5.3-09: document the investigation)");
  nonEmpty(i.rationale, "rationale");
  const eligible = i.determination !== "responsible_and_accurate";
  const event = emit(events, i.application_id, "credit.dispute.resolved", { dispute_id: i.dispute_id, borrower_id: i.borrower_id, determination: i.determination, documentation_ids: [...i.documentation_ids], eligible_as_du: eligible, rationale: i.rationale }, i.resolved_at, actor);
  return { event, eligible_as_du: eligible, escalate: eligible ? null : "underwriting_reviewer" };
}

// ============================================================ R7 — waiting periods (B3-5.3-07; B3-5.3-09 date basis)
export type DerogatoryKind = "chapter_7" | "chapter_11" | "chapter_13_discharge" | "chapter_13_dismissal" | "multiple_bankruptcy" | "foreclosure" | "deed_in_lieu" | "preforeclosure_sale" | "mortgage_charge_off";
export const WAITING_PERIOD_YEARS: Record<DerogatoryKind, { standard: number; extenuating: number }> = {
  chapter_7: { standard: 4, extenuating: 2 }, chapter_11: { standard: 4, extenuating: 2 }, chapter_13_discharge: { standard: 2, extenuating: 2 }, chapter_13_dismissal: { standard: 4, extenuating: 2 }, multiple_bankruptcy: { standard: 5, extenuating: 3 },
  foreclosure: { standard: 7, extenuating: 3 }, deed_in_lieu: { standard: 4, extenuating: 2 }, preforeclosure_sale: { standard: 4, extenuating: 2 }, mortgage_charge_off: { standard: 4, extenuating: 2 },
};
export interface WaitingPeriodResult { readonly kind: DerogatoryKind; readonly event_date: PlainDate; readonly years: number; readonly eligible_on: PlainDate; readonly du_test: { basis: "report_date"; date: PlainDate; passes: boolean }; readonly lender_test: { basis: "disbursement_date"; date: PlainDate; passes: boolean }; readonly eligible: boolean; readonly documented_basis: "du_report_date" | "lender_disbursement_date_confirmation" | null; readonly written_confirmation: string | null; readonly recommendation: string | null; }
/** `end = event_date + years`; DU tests the report date, the lender confirms with the disbursement date when DU's test fails (B3-5.3-09) — the confirmation is written into the file. */
export function waitingPeriod(i: { kind: DerogatoryKind; event_date: PlainDate; extenuating?: boolean; report_date: PlainDate; scheduled_disbursement_date: PlainDate }): WaitingPeriodResult {
  const w = WAITING_PERIOD_YEARS[i.kind]; if (!w) throw new RangeError(`unknown derogatory event kind ${JSON.stringify(i.kind)}`);
  const years = i.extenuating ? w.extenuating : w.standard;
  const eligible_on = addYears(i.event_date, years);
  const du = i.report_date >= eligible_on, lender = i.scheduled_disbursement_date >= eligible_on;
  const eligible = du || lender;
  const documented_basis = du ? "du_report_date" : lender ? "lender_disbursement_date_confirmation" : null;
  return { kind: i.kind, event_date: i.event_date, years, eligible_on, du_test: { basis: "report_date", date: i.report_date, passes: du }, lender_test: { basis: "disbursement_date", date: i.scheduled_disbursement_date, passes: lender }, eligible, documented_basis,
    written_confirmation: !du && lender ? `DU measured the ${i.kind.replace(/_/g, " ")} waiting period (${years} years from ${shortDate(i.event_date)}, ending ${shortDate(eligible_on)}) from the credit report date ${shortDate(i.report_date)} and recorded it as not met; the lender confirms per B3-5.3-09 that the scheduled disbursement date ${shortDate(i.scheduled_disbursement_date)} is on/after ${shortDate(eligible_on)}, so the waiting period is met.` : null,
    recommendation: eligible ? null : `not eligible: reschedule disbursement to ${shortDate(eligible_on)} or later (${daysShort(i.scheduled_disbursement_date, eligible_on)} short)` };
}
const daysShort = (a: PlainDate, b: PlainDate): string => { const n = Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000); return `${n} day${n === 1 ? "" : "s"}`; };

// ============================================================ R8 — inquiries (B3-5.3-04/-09) and B3-2-10 tolerance (23.1)
export const INQUIRY_LOOKBACK_DAYS = 90;
export interface InquiryItem { readonly inquiry_id: string; readonly application_id: string; readonly borrower_id: string; readonly creditor_name: string; readonly inquiry_date: PlainDate; readonly repository: Repository; readonly explanation: string | null; readonly new_credit_obtained: boolean | null; readonly new_liability_id: string | null; readonly explained_at: string | null; readonly evidence_document_id: string | null; readonly status: "open" | "explained"; }
/** Every inquiry in the 90 days before the report date that is not the partner's own pull or a known DU reissue opens an item. */
export function openInquiryItems(report: CreditReport, own: { subscriber_code: string; du_reissue_refs?: readonly string[] }): InquiryItem[] {
  const floor = addDays(report.report_date, -INQUIRY_LOOKBACK_DAYS);
  const reissue = new Set(own.du_reissue_refs ?? []);
  return report.inquiries_90d.filter((q) => q.inquiry_date >= floor && q.inquiry_date <= report.report_date && q.subscriber_code !== own.subscriber_code && !(q.subscriber_code && reissue.has(q.subscriber_code)) && !/^du reissue$/i.test(q.purpose ?? ""))
    .map((q) => ({ inquiry_id: randomUUID(), application_id: report.application_id, borrower_id: q.borrower_id, creditor_name: q.creditor_name, inquiry_date: q.inquiry_date, repository: q.repository, explanation: null, new_credit_obtained: null, new_liability_id: null, explained_at: null, evidence_document_id: null, status: "open" }));
}
export interface Liability { readonly liability_id: string; readonly application_id: string; readonly application_borrower_id: string; readonly liability_kind: string; readonly creditor_name: string; readonly monthly_payment_cents: Cents; readonly balance_cents: Cents; readonly paid_at_closing: boolean; readonly source: "credit_report" | "borrower_stated" | "reo" | "udm_alert" | "inquiry_review"; }
/** DTI in tenths of a percent (513,000 / 1,350,000 → 380 = 38.0 %), half-up on integer cents. */
export function dtiTenths(obligations_cents: Cents, qualifying_income_cents: Cents): number {
  if (qualifying_income_cents <= 0n) throw new RangeError("qualifying_income_cents must be positive");
  if (obligations_cents < 0n) throw new RangeError("obligations_cents must be ≥ 0");
  return Number((obligations_cents * 2000n + qualifying_income_cents) / (2n * qualifying_income_cents));
}
export const dtiText = (tenths: number): string => `${(tenths / 10).toFixed(1)}%`;
export const B3_2_10_DTI_CAP_TENTHS = 450;
export const B3_2_10_DTI_INCREASE_TENTHS = 30;
export interface ToleranceCheck { readonly previous_dti_tenths: number; readonly new_dti_tenths: number; readonly increase_tenths: number; readonly exceeds_45: boolean; readonly increase_3_points: boolean; readonly result: "resubmission required" | "no resubmission required"; readonly citation: "B3-2-10"; readonly final_submission_must_include_debt: true; }
/** 23.1's B3-2-10 resubmission tolerance for a DTI change: resubmit when the new DTI exceeds 45 % or rises 3 or more points; the liability is added to the file either way and the final submission reflects it. */
export function b3210ToleranceCheck(previous_dti_tenths: number, new_dti_tenths: number): ToleranceCheck {
  const increase = new_dti_tenths - previous_dti_tenths;
  const exceeds_45 = new_dti_tenths > B3_2_10_DTI_CAP_TENTHS, increase_3_points = increase >= B3_2_10_DTI_INCREASE_TENTHS;
  return { previous_dti_tenths, new_dti_tenths, increase_tenths: increase, exceeds_45, increase_3_points, result: exceeds_45 || increase_3_points ? "resubmission required" : "no resubmission required", citation: "B3-2-10", final_submission_must_include_debt: true };
}
export interface NewDebtImpact { readonly liability: Liability; readonly previous_obligations_cents: Cents; readonly new_obligations_cents: Cents; readonly previous_dti_tenths: number; readonly new_dti_tenths: number; readonly tolerance: ToleranceCheck; readonly dti_recalculation_for: "22.5"; readonly tolerance_check_for: "23.1"; }
/** Adds the disclosed debt to `application_liabilities`, recomputes DTI for 22.5 and runs 23.1's tolerance check. */
export function newDebtImpact(i: { application_id: string; borrower_id: string; creditor_name: string; liability_kind: string; monthly_payment_cents: Cents; balance_cents?: Cents; qualifying_income_cents: Cents; obligations_cents: Cents; source: Liability["source"] }): NewDebtImpact {
  if (i.monthly_payment_cents <= 0n) throw new RangeError("monthly_payment_cents must be positive");
  const liability: Liability = { liability_id: randomUUID(), application_id: i.application_id, application_borrower_id: i.borrower_id, liability_kind: i.liability_kind, creditor_name: i.creditor_name, monthly_payment_cents: i.monthly_payment_cents, balance_cents: i.balance_cents ?? 0n, paid_at_closing: false, source: i.source };
  const previous = dtiTenths(i.obligations_cents, i.qualifying_income_cents), next = dtiTenths(i.obligations_cents + i.monthly_payment_cents, i.qualifying_income_cents);
  return { liability, previous_obligations_cents: i.obligations_cents, new_obligations_cents: i.obligations_cents + i.monthly_payment_cents, previous_dti_tenths: previous, new_dti_tenths: next, tolerance: b3210ToleranceCheck(previous, next), dti_recalculation_for: "22.5", tolerance_check_for: "23.1" };
}
export interface ExplainInput { readonly explanation: string; readonly new_credit_obtained: boolean; readonly explained_at: string; readonly evidence_document_id?: string | null; readonly creditor_name?: string | null; readonly liability_kind?: string | null; readonly monthly_payment_cents?: Cents | null; readonly balance_cents?: Cents | null; readonly qualifying_income_cents?: Cents | null; readonly obligations_cents?: Cents | null; }
/** The borrower's structured answer; `new_credit_obtained` adds the liability (22.5), runs the tolerance check (23.1) and emits `credit.undisclosed_debt.found`. */
export function explainInquiry(events: EventStore, item: InquiryItem, x: ExplainInput, actor: Actor = AGENT): { item: InquiryItem; impact: NewDebtImpact | null; events: DomainEvent[] } {
  nonEmpty(x.explanation, "explanation");
  const out: DomainEvent[] = [];
  let impact: NewDebtImpact | null = null;
  if (x.new_credit_obtained) {
    if (x.monthly_payment_cents === undefined || x.monthly_payment_cents === null || x.qualifying_income_cents === undefined || x.qualifying_income_cents === null || x.obligations_cents === undefined || x.obligations_cents === null) throw new RangeError("new credit needs monthly_payment_cents, qualifying_income_cents and obligations_cents");
    impact = newDebtImpact({ application_id: item.application_id, borrower_id: item.borrower_id, creditor_name: x.creditor_name ?? item.creditor_name, liability_kind: x.liability_kind ?? "installment", monthly_payment_cents: x.monthly_payment_cents, ...(x.balance_cents !== undefined && x.balance_cents !== null ? { balance_cents: x.balance_cents } : {}), qualifying_income_cents: x.qualifying_income_cents, obligations_cents: x.obligations_cents, source: "inquiry_review" });
    out.push(emit(events, item.application_id, "credit.undisclosed_debt.found", { source: "inquiry_review", inquiry_id: item.inquiry_id, borrower_id: item.borrower_id, liability_id: impact.liability.liability_id, creditor_name: impact.liability.creditor_name, monthly_payment_cents: String(impact.liability.monthly_payment_cents), previous_dti_tenths: impact.previous_dti_tenths, new_dti_tenths: impact.new_dti_tenths, tolerance_result: impact.tolerance.result, disclosed_before_closing: true }, x.explained_at, actor));
  }
  const updated: InquiryItem = { ...item, explanation: x.explanation, new_credit_obtained: x.new_credit_obtained, new_liability_id: impact?.liability.liability_id ?? null, explained_at: x.explained_at, evidence_document_id: x.evidence_document_id ?? null, status: "explained" };
  out.unshift(emit(events, item.application_id, "credit.inquiry.explained", { inquiry_id: item.inquiry_id, borrower_id: item.borrower_id, creditor_name: item.creditor_name, inquiry_date: item.inquiry_date, new_credit_obtained: x.new_credit_obtained, new_liability_id: updated.new_liability_id }, x.explained_at, actor));
  return { item: updated, impact, events: out };
}

// ============================================================ R9 — undisclosed-debt monitoring and the pre-closing refresh (B3-6-01; A2-2-04; SM policy)
export type AlertSource = "udm_vendor" | "refresh_compare" | "inquiry_review";
export type AlertType = "new_tradeline" | "inquiry" | "secondary_reissue" | "bankruptcy" | "judgment" | "lien" | "collection" | "late_payment" | "balance_increase";
export type AlertStatus = "open" | "explained" | "verified_new_debt" | "false_positive" | "resolved";
export const ALERT_TYPES: readonly AlertType[] = ["new_tradeline", "inquiry", "secondary_reissue", "bankruptcy", "judgment", "lien", "collection", "late_payment", "balance_increase"];
export interface CreditAlert { readonly alert_id: string; readonly application_id: string; readonly borrower_id: string; readonly source: AlertSource; readonly alert_type: AlertType; readonly payload: Record<string, unknown>; readonly received_at: string; readonly status: AlertStatus; readonly resolution: Record<string, unknown> | null; readonly dti_impact_cents: Cents | null; }
export function receiveUdmAlert(events: EventStore, i: { application_id: string; borrower_id: string; alert_type: AlertType | string; payload?: Record<string, unknown>; received_at: string; vendor_alert_id?: string | null; source?: AlertSource }, actor: Actor = AGENT): { alert: CreditAlert; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.borrower_id, "borrower_id"); nonEmpty(i.received_at, "received_at");
  if (!(ALERT_TYPES as readonly string[]).includes(i.alert_type)) throw new RangeError(`alert_type ${JSON.stringify(i.alert_type)} is not one of ${ALERT_TYPES.join("/")}`);
  const alert: CreditAlert = { alert_id: i.vendor_alert_id ?? randomUUID(), application_id: i.application_id, borrower_id: i.borrower_id, source: i.source ?? "udm_vendor", alert_type: i.alert_type as AlertType, payload: i.payload ?? {}, received_at: i.received_at, status: "open", resolution: null, dti_impact_cents: null };
  return { alert, event: emit(events, i.application_id, "credit.udm.alert.received", { alert_id: alert.alert_id, borrower_id: alert.borrower_id, alert_type: alert.alert_type, source: alert.source, received_at: alert.received_at }, i.received_at, actor) };
}
/** A matched known tradeline / the partner's own reissue is a false positive. */
export function matchesKnownTradeline(alert: CreditAlert, known: readonly KnownTradeline[]): boolean {
  const c = norm(String(alert.payload.creditor_name ?? "")), ref = String(alert.payload.account_ref ?? "");
  return alert.alert_type === "secondary_reissue" || known.some((k) => k.borrower_id === alert.borrower_id && (ref ? k.account_ref === ref : c !== "" && norm(k.creditor_name) === c));
}
export interface TriageInput { readonly status: Exclude<AlertStatus, "open" | "resolved">; readonly triaged_at: string; readonly rationale: string; readonly explanation?: string | null; readonly evidence_document_id?: string | null; readonly monthly_payment_cents?: Cents | null; readonly balance_cents?: Cents | null; readonly liability_kind?: string | null; readonly creditor_name?: string | null; readonly qualifying_income_cents?: Cents | null; readonly obligations_cents?: Cents | null; }
export interface Triage { readonly alert: CreditAlert; readonly impact: NewDebtImpact | null; readonly events: DomainEvent[]; readonly relief_note: string | null; readonly next: { readonly dti_recalculation: "22.5" | null; readonly tolerance_evaluation: "23.1" | null; readonly resubmission_before_signing: boolean }; }
/** false_positive / explained close the alert; verified_new_debt adds the liability (22.5 recalculates), runs B3-2-10 (23.1) and notes for the A2-2-04 relief record that the debt was disclosed before closing. */
export function triageUdmAlert(events: EventStore, alert: CreditAlert, t: TriageInput, actor: Actor = AGENT): Triage {
  if (alert.status !== "open") throw new RangeError(`alert ${alert.alert_id} is already ${alert.status}`);
  nonEmpty(t.rationale, "rationale");
  const out: DomainEvent[] = [];
  let impact: NewDebtImpact | null = null, relief_note: string | null = null;
  if (t.status === "verified_new_debt") {
    if (t.monthly_payment_cents === undefined || t.monthly_payment_cents === null || t.qualifying_income_cents === undefined || t.qualifying_income_cents === null || t.obligations_cents === undefined || t.obligations_cents === null) throw new RangeError("verified_new_debt needs monthly_payment_cents, qualifying_income_cents and obligations_cents");
    impact = newDebtImpact({ application_id: alert.application_id, borrower_id: alert.borrower_id, creditor_name: t.creditor_name ?? String(alert.payload.creditor_name ?? "undisclosed creditor"), liability_kind: t.liability_kind ?? "installment", monthly_payment_cents: t.monthly_payment_cents, ...(t.balance_cents !== undefined && t.balance_cents !== null ? { balance_cents: t.balance_cents } : {}), qualifying_income_cents: t.qualifying_income_cents, obligations_cents: t.obligations_cents, source: "udm_alert" });
    relief_note = `Undisclosed non-mortgage debt (${impact.liability.creditor_name}, ${formatCents(impact.liability.monthly_payment_cents)}/month) was disclosed and verified before closing on ${shortDate(civilDate(t.triaged_at))} (UDM alert ${alert.alert_id} received ${shortDate(civilDate(alert.received_at))}); DTI recalculated per B3-6-01 and the final DU submission includes it — A2-2-04 relief (DU message 3941) requires closing by the credit report expiration date.`;
    out.push(emit(events, alert.application_id, "credit.undisclosed_debt.found", { source: "udm_alert", alert_id: alert.alert_id, borrower_id: alert.borrower_id, liability_id: impact.liability.liability_id, creditor_name: impact.liability.creditor_name, monthly_payment_cents: String(impact.liability.monthly_payment_cents), previous_dti_tenths: impact.previous_dti_tenths, new_dti_tenths: impact.new_dti_tenths, tolerance_result: impact.tolerance.result, disclosed_before_closing: true, relief_note }, t.triaged_at, actor));
  }
  const resolved: CreditAlert = { ...alert, status: t.status, dti_impact_cents: impact ? impact.liability.monthly_payment_cents : 0n, resolution: { status: t.status, rationale: t.rationale, explanation: t.explanation ?? null, evidence_document_id: t.evidence_document_id ?? null, liability_id: impact?.liability.liability_id ?? null, triaged_at: t.triaged_at, relief_note } };
  out.push(emit(events, alert.application_id, "credit.udm.alert.resolved", { alert_id: alert.alert_id, borrower_id: alert.borrower_id, alert_type: alert.alert_type, status: t.status, liability_id: impact?.liability.liability_id ?? null, dti_impact_cents: String(resolved.dti_impact_cents ?? 0n) }, t.triaged_at, actor));
  return { alert: resolved, impact, events: out, relief_note, next: { dti_recalculation: impact ? "22.5" : null, tolerance_evaluation: impact ? "23.1" : null, resubmission_before_signing: impact?.tolerance.result === "resubmission required" } };
}
/** The vendor's daily heartbeat (webhook ack or poll) keeps SM_UDM_MONITOR_ACTIVE satisfied; missing → the refresh substitutes. */
export function recordUdmHeartbeat(events: EventStore, i: { application_id: string; vendor: string; at: string; alerts_delivered: number }, actor: Actor = AGENT): DomainEvent {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.vendor, "vendor");
  return emit(events, i.application_id, "credit.udm.heartbeat", { vendor: i.vendor, alerts_delivered: i.alerts_delivered, heartbeat_at: i.at }, i.at, actor);
}
export const REFRESH_WINDOW_BUSINESS_DAYS = 3;
/** Earliest acceptable refresh date: three creditor business days before consummation (Fri Nov 6, 2026 → Tue Nov 3; Wed Nov 18 → Fri Nov 13). */
export function refreshWindowStart(scheduled_consummation_date: PlainDate, cal: Calendar = creditor): PlainDate { return addBusinessDays(scheduled_consummation_date, -REFRESH_WINDOW_BUSINESS_DAYS, cal); }
/** SM_CREDIT_REFRESH_PRECLOSE_GATE: a soft_refresh / udm_snapshot dated in [consummation − 3 creditor business days, consummation] with every alert resolved. */
export function refreshPrecloseGate(f: Record<string, unknown>): GateResult {
  const consummation = typeof f.scheduled_consummation_date === "string" && f.scheduled_consummation_date ? (f.scheduled_consummation_date as PlainDate) : null;
  if (!consummation) return { open: false, reason: "scheduled_consummation_date is unknown" };
  const date = typeof f.refresh_report_date === "string" && f.refresh_report_date ? (f.refresh_report_date as PlainDate) : null;
  const type = String(f.refresh_report_type ?? "soft_refresh");
  if (!date) return { open: false, reason: `no soft refresh / UDM snapshot on file: order the refresh (window opens ${refreshWindowStart(consummation)})` };
  if (type !== "soft_refresh" && type !== "udm_snapshot") return { open: false, reason: `refresh report type ${type} is not soft_refresh/udm_snapshot` };
  const start = refreshWindowStart(consummation);
  if (date < start) return { open: false, reason: `refresh dated ${date} is earlier than ${start} (3 business_days_creditor before consummation ${consummation}): order a new refresh` };
  if (date > consummation) return { open: false, reason: `refresh dated ${date} is after the scheduled consummation ${consummation}` };
  const alerts = Array.isArray(f.alerts) ? (f.alerts as { alert_id?: string; status?: string }[]) : [];
  const open = alerts.filter((a) => a.status !== "resolved" && a.status !== "false_positive" && a.status !== "explained");
  const verified = open.filter((a) => a.status === "verified_new_debt");
  if (verified.length) return { open: false, reason: `verified_new_debt unresolved (${verified.map((a) => a.alert_id ?? "?").join(", ")}): 22.5 recalculation and 23.1 resubmission before signing` };
  if (open.length) return { open: false, reason: `alerts not resolved: ${open.map((a) => a.alert_id ?? "?").join(", ")}` };
  return { open: true };
}
export function receiveRefresh(events: EventStore, i: { application_id: string; report_id: string; report_type: "soft_refresh" | "udm_snapshot"; report_date: PlainDate; received_at: string; alerts_open: number; new_tradelines: number; scheduled_consummation_date: PlainDate | null }, actor: Actor = AGENT): DomainEvent {
  return emit(events, i.application_id, "credit.refresh.received", { report_id: i.report_id, report_type: i.report_type, report_date: i.report_date, alerts_open: i.alerts_open, new_tradelines: i.new_tradelines, window_start: i.scheduled_consummation_date ? refreshWindowStart(i.scheduled_consummation_date) : null, scheduled_consummation_date: i.scheduled_consummation_date }, i.received_at, actor);
}

// ============================================================ R10 — score disclosures (FCRA §609(g); Reg V §1022.74/.75(c)) and the HMDA feed (§1003.4(a)(15))
export interface ScoreDisclosurePayload { readonly borrower_id: string; readonly score_model: ScoreModel; readonly scores: { repository: Repository; bureau: string; score: number | null; model_version: string; key_factors: readonly string[]; inquiries_key_factor: boolean }[]; readonly applicable_score: number | null; readonly range: { min: number; max: number }; readonly date: PlainDate; readonly cra: CraIdentity; readonly creditor_is_partner: true; readonly for_templates: readonly ["NTC_FCRA_609G_CREDIT_SCORE", "NTC_REGV_1022_74_RBP_EXCEPTION"]; }
/** One payload per borrower carrying only that borrower's scores and key factors (§1022.75(c)); the representative score is a loan fact, never shared here. */
export function scoreDisclosurePayloads(report: CreditReport): ScoreDisclosurePayload[] {
  return report.borrowers.map((b) => ({ borrower_id: b.borrower_id, score_model: report.score_model,
    scores: REPOSITORIES.filter((r) => b.scores[r] !== undefined).map((r) => ({ repository: r, bureau: REPOSITORY_NAMES[r], score: b.scores[r]!.score, model_version: b.scores[r]!.model_version, key_factors: [...b.scores[r]!.key_factors].slice(0, 4), inquiries_key_factor: b.scores[r]!.inquiries_key_factor === true })),
    applicable_score: report.borrower_applicable_scores[b.borrower_id] ?? null, range: { ...SCORE_RANGE }, date: report.report_date, cra: report.cra, creditor_is_partner: true, for_templates: ["NTC_FCRA_609G_CREDIT_SCORE", "NTC_REGV_1022_74_RBP_EXCEPTION"] }));
}
export function emitScoreDisclosureData(events: EventStore, report: CreditReport, at: string, actor: Actor = AGENT): { payloads: ScoreDisclosurePayload[]; events: DomainEvent[]; hmda: { score_model: ScoreModel; representative_score: number | null; applicant_scores: Record<string, number | null> } } {
  const payloads = scoreDisclosurePayloads(report);
  const out = payloads.map((p) => emit(events, report.application_id, "credit.score_disclosure.prepared", { report_id: report.report_id, borrower_id: p.borrower_id, score_model: p.score_model, scores: p.scores, applicable_score: p.applicable_score, range: p.range, date: p.date, cra: p.cra, for_templates: p.for_templates }, at, actor));
  return { payloads, events: out, hmda: { score_model: report.score_model, representative_score: report.representative_score, applicant_scores: { ...report.borrower_applicable_scores } } };
}

// ============================================================ R11 — model invariants (LL-2026-06; SFC 067)
export function sfcAssertion(score_model: ScoreModel, sfc_codes: readonly string[]): { ok: boolean; sfc_067_present: boolean; expected: boolean; reason: string } {
  const present = sfc_codes.includes(SFC.vantagescore_4), expected = score_model === "vantagescore_4";
  return { ok: present === expected, sfc_067_present: present, expected, reason: present === expected ? `SFC 067 ${present ? "present" : "absent"} — consistent with score_model ${score_model}` : `SFC 067 must be ${expected ? "present" : "absent"} for score_model ${score_model} (LL-2026-06); delivery build refused (29.3)` };
}
export function selectScoreModel(events: EventStore, i: { application_id: string; current: ScoreModel | null; requested: ScoreModel; at: string; written_decision_id?: string | null; full_repull_report_id?: string | null }, actor: Actor = AGENT): { score_model: ScoreModel; event: DomainEvent | null } {
  if (i.current === null) return { score_model: i.requested, event: emit(events, i.application_id, "credit.score.model.selected", { score_model: i.requested, basis: "first hard pull (credit.score_model_default)" }, i.at, actor) };
  if (i.current === i.requested) return { score_model: i.current, event: null };
  if (!i.written_decision_id || !i.full_repull_report_id) throw new CreditRefused("SCORE_MODEL_CHANGE_NEEDS_DECISION", "22.2 R11 / guardrail: never change score_model mid-loan without a full re-pull of every borrower and a written decision", `score_model ${i.current} → ${i.requested} refused`);
  return { score_model: i.requested, event: emit(events, i.application_id, "credit.score.model.selected", { score_model: i.requested, previous: i.current, written_decision_id: i.written_decision_id, full_repull_report_id: i.full_repull_report_id }, i.at, actor) };
}

// ============================================================ receive / parse (R1–R4 assembled) and the report life cycle
export function buildReport(order: CreditOrder, resp: CreditReportResponse, fee_item_id: string | null): CreditReport {
  const scores = computeScores(resp.borrowers);
  const key_factors: CreditReport["key_factors"] = {};
  for (const b of resp.borrowers) { key_factors[b.borrower_id] = {}; for (const r of REPOSITORIES) if (b.scores[r]) key_factors[b.borrower_id]![r] = [...b.scores[r]!.key_factors]; }
  const returned = [...new Set(resp.borrowers.flatMap((b) => b.returned))], frozen = [...new Set(resp.borrowers.flatMap((b) => b.frozen))];
  const floor = addDays(resp.report_date, -INQUIRY_LOOKBACK_DAYS);
  const report_type = ORDER_REPORT_TYPE[order.order_type];
  const base: CreditReport = { report_id: randomUUID(), application_id: order.application_id, report_type, reseller: resp.reseller, du_credit_provider_code: resp.du_credit_provider_code ?? null, credit_reference_number: resp.credit_reference_number,
    borrower_ids: [...order.borrower_ids], repositories_requested: [...order.repositories], repositories_returned: returned, frozen_repositories: frozen, borrowers: resp.borrowers.map((b) => ({ ...b, scores: { ...b.scores }, returned: [...b.returned], frozen: [...b.frozen] })), fraud_alerts: [...(resp.fraud_alerts ?? [])],
    score_model: order.score_model, ...scores, key_factors, inquiries_90d: (resp.inquiries ?? []).filter((q) => q.inquiry_date >= floor), disputed_tradelines: [...(resp.disputed_tradelines ?? [])], public_records: [...(resp.public_records ?? [])], collections: [...(resp.collections ?? [])],
    mortgage_tradelines: [...(resp.mortgage_tradelines ?? [])], tradelines: [...(resp.tradelines ?? [])], identity_headers: [...(resp.identity_headers ?? [])], trended_data: resp.trended_data, permissible_purpose: order.permissible_purpose, certification_ref: order.certification_ref, pulled_at: resp.received_at,
    report_date: resp.report_date, expires_at: expiresAt(resp.report_date), fee_cents: resp.fee_cents, fee_item_id, document_id: resp.document_id ?? null, supersedes_report_id: null, cra: resp.cra, state: "received", state_reason: null, fraud_alert_cleared: false };
  return base;
}
/** Order → reseller → `credit.report.ordered` + `credit.report.received` (state `received`); the first hard pull fixes `applications.score_model`. */
export async function placeOrder(events: EventStore, port: CreditBureauPort, order: CreditOrder, i: { at: string; app_score_model: ScoreModel | null; fee_item_id?: string | null; supersedes?: CreditReport | null }, actor: Actor = AGENT): Promise<{ report: CreditReport; ordered: DomainEvent; received: DomainEvent; score_model_event: DomainEvent | null; score_model: ScoreModel; superseded: CreditReport | null }> {
  const ordered = emit(events, order.application_id, "credit.report.ordered", { client_order_id: order.client_order_id, order_type: order.order_type, score_model: order.score_model, model_codes: order.model_codes, repositories_requested: order.repositories, borrower_ids: order.borrower_ids, joint: order.joint, permissible_purpose: order.permissible_purpose, certification_ref: order.certification_ref, subscriber_code: order.subscriber_code, ordering_agent: order.ordering_agent, attempt: order.attempt }, i.at, actor);
  const resp = await port.order(order);
  if (!resp.trended_data && HARD_PULL_ORDERS.includes(order.order_type)) throw new CreditRefused("TRENDED_DATA_REQUIRED", "B3-5.2-01: the version of the credit report received by DU must support trended credit data", "the reseller returned a report without trended data");
  let report = buildReport(order, resp, i.fee_item_id ?? null);
  // the supersession is recorded before the new report's `credit.report.received` so the old report's clocks (expiry gate, expiry warning) retire and only the new report arms fresh ones
  let superseded: CreditReport | null = null;
  if (i.supersedes) { const sup = supersedeReport(events, i.supersedes, report, resp.received_at, actor); report = sup.by; superseded = sup.old; }
  const hard = HARD_PULL_ORDERS.includes(order.order_type);
  const sel = hard ? selectScoreModel(events, { application_id: order.application_id, current: i.app_score_model, requested: order.score_model, at: resp.received_at }, actor) : { score_model: i.app_score_model ?? order.score_model, event: null };
  const received = emit(events, order.application_id, "credit.report.received", { report_id: report.report_id, report_type: report.report_type, report_date: report.report_date, expires_at: report.expires_at, score_model: report.score_model, borrower_ids: report.borrower_ids, credit_reference_number: report.credit_reference_number, du_credit_provider_code: report.du_credit_provider_code,
    repositories_returned: report.repositories_returned, frozen_count: report.frozen_repositories.length, trended_data: report.trended_data, representative_score: report.representative_score, permissible_purpose: report.permissible_purpose, certification_ref: report.certification_ref, cra: report.cra.name, pulled_at: report.pulled_at }, resp.received_at, actor);
  return { report, ordered, received, score_model_event: sel.event, score_model: sel.score_model, superseded };
}
/** parse: classify (R4) and stamp the state; `credit.representative_score.computed` carries the R2 result for 20.4/21.4 and HMDA. */
export function parseReport(events: EventStore, report: CreditReport, at: string, actor: Actor = AGENT): { report: CreditReport; classification: Classification; event: DomainEvent } {
  const c = classifyReport(report);
  const parsed: CreditReport = { ...report, state: c.state, state_reason: c.reason };
  const event = emit(events, report.application_id, "credit.representative_score.computed", { report_id: report.report_id, state: c.state, score_model: report.score_model, representative_score: report.representative_score, representative_score_borrower_id: report.representative_score_borrower_id, borrower_applicable_scores: report.borrower_applicable_scores, no_score_borrowers: report.no_score_borrowers, llpa_rule_set: LLPA_RULE_SET_VERSION }, at, actor);
  return { report: parsed, classification: c, event };
}
export function markExpired(events: EventStore, report: CreditReport, scheduled_note_date: PlainDate, at: string, actor: Actor = AGENT): { report: CreditReport; event: DomainEvent } {
  if (report.expires_at >= scheduled_note_date) throw new RangeError(`report ${report.report_id} expires ${report.expires_at}, on/after the note date ${scheduled_note_date}: not expired`);
  return { report: { ...report, state: "expired" }, event: emit(events, report.application_id, "credit.report.expired", { report_id: report.report_id, expires_at: report.expires_at, scheduled_note_date, breach_action: "new tri-merge under the same score_model; DU resubmission (23.1); pricing re-check (20.4)" }, at, actor) };
}
export interface RepullSchedule { readonly report_id: string; readonly expires_at: PlainDate; readonly scheduled_note_date: PlainDate; readonly warn_on: PlainDate; readonly repull_by: PlainDate; readonly gate_open: boolean; readonly event: DomainEvent; }
/** SM_CREDIT_EXPIRY_WARN_21 breach action: schedule the re-pull to land ≥ 10 calendar days before the scheduled note date (report Oct 5, 2026 → warn Jan 15, 2027; note Feb 8, 2027 → re-pull by Jan 29, 2027). */
export function scheduleRepull(events: EventStore, report: CreditReport, scheduled_note_date: PlainDate, at: string, actor: Actor = AGENT): RepullSchedule {
  const repull_by = repullBy(scheduled_note_date), warn_on = warnDate(report.expires_at);
  const gate = creditReportExpiryGate({ expires_at: report.expires_at, scheduled_note_date, state: report.state });
  const event = emit(events, report.application_id, "credit.repull.scheduled", { report_id: report.report_id, expires_at: report.expires_at, scheduled_note_date, warn_on, repull_by, gate_open: gate.open, score_model: report.score_model, reason: gate.reason ?? "closing confirmed before expires_at" }, at, actor);
  return { report_id: report.report_id, expires_at: report.expires_at, scheduled_note_date, warn_on, repull_by, gate_open: gate.open, event };
}

// ============================================================ gates asserted at command boundaries
export type CreditGateCode = "FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M" | "SM_CREDIT_REFRESH_PRECLOSE_GATE";
export const GATE_EVALUATOR: Record<CreditGateCode, string> = { FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M: "22.2.creditReportExpiry4m", SM_CREDIT_REFRESH_PRECLOSE_GATE: "22.2.refreshPrecloseGate" };
export class CreditGateClosed extends Error { readonly code: CreditGateCode; readonly reason: string; constructor(code: CreditGateCode, reason: string) { super(`${code}: ${reason}`); this.name = "CreditGateClosed"; this.code = code; this.reason = reason; } }
/** `assertGateOpen(code, facts)` before submitDuFinal (23.1), issueCD (25.2), consummate (25.3/26.1). */
export function assertGateOpen(code: CreditGateCode, facts: Record<string, unknown>): void {
  const ref = GATE_EVALUATOR[code]; if (!ref) throw new RangeError(`no credit gate ${String(code)}`);
  const r = evaluateGate(ref, facts); if (!r.open) throw new CreditGateClosed(code, r.reason ?? "closed");
}

// ============================================================ the credit-report fee (§1026.19(e)(2)(i)(B); §1026.37(f)(2)) — 21.4's gate reused
export interface FeeItemRow { readonly fee_item_id: string; readonly application_id: string; readonly fee_code: "credit_report"; readonly description: "Credit report"; readonly le_section: "B_cannot_shop"; readonly le_section_label: "Services You Cannot Shop For"; readonly mismo_fee_type: "CreditReport"; readonly provider_source: "creditor_selected_third_party"; readonly shoppable: false; readonly tolerance_class: "zero"; readonly current_amount_cents: Cents; readonly paid_by: "borrower" | "lender"; readonly paid_to: string; readonly estimate_source: "vendor_quote"; readonly estimate_source_ref: string; readonly estimated_at: PlainDate; readonly finance_charge: false; }
export interface FeeCharge { readonly permitted: boolean; readonly gate_result: FeeGateResult; readonly citation: string; readonly collected_cents: Cents; readonly fee_item: FeeItemRow | null; readonly ledger_account: "origination_fees_receivable" | "third_party_costs"; readonly reason: string; }
/** The only fee collectable before the LE / intent: `fee_kind=credit_report` up to the vendor invoice; the row lands in section B, zero tolerance. Any other fee on that date is refused by 21.4's gate. */
export function chargeCreditReportFee(i: { application_id: string; fee_kind: string; amount_cents: Cents; vendor_invoice_cents: Cents; charged_at: string; le_effective_receipt_date: PlainDate | null; intent_valid_at?: string | null; reseller: string; borrower_paid: boolean }): FeeCharge {
  const r = evaluateFeeGate({ application_id: i.application_id, command: i.fee_kind === "credit_report" ? "order_credit_report" : "impose_fee", fee_kind: i.fee_kind, amount_cents: i.amount_cents, checked_at: i.charged_at, le_effective_receipt_date: i.le_effective_receipt_date, intent: null, vendor_invoice_cents: i.vendor_invoice_cents, time_zone: CREDITOR_TZ });
  const permitted = r.result === "open" || r.result === "exempt_credit_report";
  const fee_item: FeeItemRow | null = permitted && i.fee_kind === "credit_report" ? { fee_item_id: randomUUID(), application_id: i.application_id, fee_code: "credit_report", description: "Credit report", le_section: "B_cannot_shop", le_section_label: "Services You Cannot Shop For", mismo_fee_type: "CreditReport", provider_source: "creditor_selected_third_party", shoppable: false, tolerance_class: "zero",
    current_amount_cents: r.collected_cents, paid_by: i.borrower_paid ? "borrower" : "lender", paid_to: i.reseller, estimate_source: "vendor_quote", estimate_source_ref: `${i.reseller} invoice ${formatCents(i.vendor_invoice_cents)}`, estimated_at: civilDate(i.charged_at), finance_charge: false } : null;
  return { permitted, gate_result: r.result, citation: r.result === "exempt_credit_report" ? "12 CFR 1026.19(e)(2)(i)(B); §1026.37(f)(2) Services You Cannot Shop For; §1026.19(e)(3)(i) zero tolerance" : "12 CFR 1026.19(e)(2)(i)(A); 21.4 REGZ_1026_19E2_INTENT_FEE_GATE", collected_cents: r.collected_cents, fee_item, ledger_account: i.borrower_paid ? "origination_fees_receivable" : "third_party_costs", reason: r.reason };
}

// ============================================================ decision record
export interface CreditDecisionRecord { readonly report_id: string; readonly order_inputs: Record<string, unknown>; readonly permissible_purpose: PermissiblePurpose; readonly certification_ref: string; readonly repositories_returned: readonly Repository[]; readonly frozen: readonly Repository[]; readonly scores: Record<string, Partial<Record<Repository, number | null>>>; readonly applicable_scores: Record<string, number | null>; readonly representative_score: number | null; readonly model: ScoreModel; readonly du_messages_mapped: number; readonly conditions_proposed: readonly string[]; readonly alerts_triaged: number; readonly rationale: string; readonly confidence: number; readonly rule_set_version: string; }
export function decisionRecord(report: CreditReport, extra: { du_messages_mapped?: number; conditions_proposed?: readonly string[]; alerts_triaged?: number; rationale: string; confidence: number; order_inputs?: Record<string, unknown> }): CreditDecisionRecord {
  const scores: CreditDecisionRecord["scores"] = {};
  for (const b of report.borrowers) { scores[b.borrower_id] = {}; for (const r of REPOSITORIES) if (b.scores[r]) scores[b.borrower_id]![r] = b.scores[r]!.score; }
  return { report_id: report.report_id, order_inputs: extra.order_inputs ?? { score_model: report.score_model, repositories_requested: report.repositories_requested, borrower_ids: report.borrower_ids }, permissible_purpose: report.permissible_purpose, certification_ref: report.certification_ref, repositories_returned: report.repositories_returned, frozen: report.frozen_repositories, scores,
    applicable_scores: { ...report.borrower_applicable_scores }, representative_score: report.representative_score, model: report.score_model, du_messages_mapped: extra.du_messages_mapped ?? 0, conditions_proposed: [...(extra.conditions_proposed ?? [])], alerts_triaged: extra.alerts_triaged ?? 0, rationale: extra.rationale, confidence: extra.confidence, rule_set_version: RULE_SET_VERSION };
}
