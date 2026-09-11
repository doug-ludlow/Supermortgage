/**
 * §25.4 Other closing-time and immediate post-closing consumer notices — the closing-day notice run
 * (`composeClosingPackage`), the CD-escrow consistency check executed at package time, the escrow election / waiver
 * rule (B2-1.5-04 + HPML + the partner's written policy), the Utah 7-17-4 and California Civ. Code §2954 escrow
 * notices and their gates, the GLBA §1016.4 consummation gate, the post-closing run and the first-payment-letter
 * clocks (Reg E §1005.10(e)(1): autopay is never a condition), the §1026.39 ownership-transfer expectation (Fannie Mae
 * sends its own purchase letter; the platform records, evidences and only sends as a fallback), the RESPA
 * "payment address named at closing" design and its 1.3 combined MS-2 fallback, and the Form 1098 seeds handed to
 * servicing 7.1-A at boarding. Pure rule functions over bigint cents and PlainDate; every event carries the
 * origination key (`applicationId` + `application_id`, `source=origination`) so the 25.4 timers arm under
 * origination context (src/kernel/timers/engine.ts isOriginationContext).
 *
 * Reused, never redefined: 30.3's `packageLead` / `deliverStatementAtSettlement` (the initial escrow statement rides in
 * the package when the analysis is approved ≥ 1 creditor business day before consummation; 3.1's
 * `escrow.statement.sent{statement_type=initial, channel=closing_package}` closes both 25.4's policy target and 3.1's
 * 45-day row on day 0), 3.1's `verifyInitialStatementEvidence` (`satisfied_by_originator`), 25.2's
 * `runCdConsistencyChecks` (`CD_ESCROW_VS_O11_3`) and `CdReason` vocabulary, 30.4's `ownershipNoticeMayRender`,
 * 7.1-A's `form1098Cycle`, 1.3's combined MS-2 template code and `notice.mailed{template, every_loan=true}` satisfier.
 *
 * Events appended (timer subject in brackets):
 *   notice.closing_package.composed{run_id, status∈{gated, composing, exception}, items}   [application — satisfies
 *                                                       SM_O64_CLOSING_PACKAGE_NOTICES_GATE when status=gated]
 *   privacy.gate.evaluated{result∈{open, blocked}, missing_borrower_ids}                  [GLBA_1016_4_INITIAL_PRIVACY_GATE]
 *   escrow.state_notice.gate.evaluated{state∈{UT, CA}, code, result∈{open, blocked}}     [UT_7_17_4_… / CA_CIV_2954_… gates]
 *   escrow.statement.package_decision{decision∈{in_package, deferred}, timer}             (SM_O64_INITIAL_ESCROW_STMT_AT_SETTLEMENT record)
 *   escrow.election.recorded{election, state_notice_codes, elected_at}                    (30.3 consumes; 3.8 at boarding)
 *   notice.closing_package.delivered{run_id, items}
 *   notice.mailed{template=NTC_REGX_1024_33B_COMBINED_MS2, every_loan=true, delivered_at_settlement=true}   (1.3's satisfier, fallback only)
 *   first_payment_letter.due_computed{due_5bd, predue_20}
 *   notice.post_closing_run.completed{run_id, items}                                      [SM_O64_POST_CLOSING_NOTICE_RUN_2BD]
 *   ownership_transfer.notice.expected{covered_person, date_of_transfer, due_date, sender, evidence_due}
 *   ownership_transfer.notice.sent{template, sender, covered_person, sent_on}             [REGZ_1026_39_OWNERSHIP_NOTICE_30]
 *   ownership_transfer.notice.evidenced{evidence=borrower_report}                         [SM_O64_FNMA_1026_39_EVIDENCE_45]
 *   tax_reporting.seeds.handed_off{loan_id, seeds_hash}                                   [SM_O64_1098_SEEDS_AT_BOARDING_GATE]
 */
import { createHash } from "node:crypto";
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, type CalendarSet, defaultCalendars } from "../../kernel/calendar/business.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { packageLead, deliverStatementAtSettlement, INITIAL_STATEMENT_TEMPLATE, type InitialAnalysis30 } from "../orig-boarding/ops-30-3.ts";
import { ownershipNoticeMayRender } from "../orig-boarding/ops-30-4.ts";
import { runCdConsistencyChecks, type CdConsistencyCheck, type CdReason } from "./ops-25-2.ts";
import { MS2_TEMPLATE } from "../transfers/inbound.ts";
import { MODEL_B1 } from "../../notices/authored/section08.ts";
import { AUTOPAY_CONDITION_PATTERN } from "../../notices/authored/section25-4.ts";

export const RULE_SET_25_4 = "sm.closing_notices.2026-09" as const;
export const DISCLOSURE_AGENT: Actor = { kind: "agent", id: "disclosure" };
export const BOARDING_AGENT: Actor = { kind: "agent", id: "boarding" };
/** Notices this process owns (spec/registry/notices.json). */
export const NTC = {
  escrow_election: "NTC_SM_ESCROW_ELECTION", ut_reserve_options: "NTC_UT_7_17_4_RESERVE_OPTIONS", ca_impound_stmt: "NTC_CA_CIV_2954_IMPOUND_STMT",
  ownership_transfer: "NTC_REGZ_1026_39_OWNERSHIP_TRANSFER", first_payment_letter: "NTC_SM_FIRST_PAYMENT_LETTER",
  // referenced (other owners)
  privacy_initial: "NTC_GLBA_1016_4_PRIVACY_INITIAL", initial_escrow_stmt: INITIAL_STATEMENT_TEMPLATE, combined_ms2: MS2_TEMPLATE.combined, cd: "NTC_REGZ_1026_38_CD", hpa_fixed: "NTC_HPA_4903_INITIAL_FIXED", hpa_arm: "NTC_HPA_4903_INITIAL_ARM", flood: "NTC_FDPA_4104A_FLOOD_NOTICE", h8: "NTC_REGZ_1026_23_H8", h9: "NTC_REGZ_1026_23_H9", welcome: "NTC_SM_WELCOME_LETTER",
} as const;
export const TIMER = {
  package_gate: "SM_O64_CLOSING_PACKAGE_NOTICES_GATE", privacy_gate: "GLBA_1016_4_INITIAL_PRIVACY_GATE", escrow_stmt: "SM_O64_INITIAL_ESCROW_STMT_AT_SETTLEMENT", ut_gate: "UT_7_17_4_RESERVE_OPTIONS_NOTICE_GATE", ca_gate: "CA_CIV_2954_IMPOUND_STMT_GATE",
  letter_5bd: "SM_O64_FIRST_PAYMENT_LETTER_5BD", letter_predue_20: "SM_O64_FIRST_PAYMENT_LETTER_PREDUE_20", post_closing_run: "SM_O64_POST_CLOSING_NOTICE_RUN_2BD", ownership_30: "REGZ_1026_39_OWNERSHIP_NOTICE_30", fnma_evidence_45: "SM_O64_FNMA_1026_39_EVIDENCE_45", seeds_gate: "SM_O64_1098_SEEDS_AT_BOARDING_GATE",
  regx_17g_45: "REGX_1024_17G_INITIAL_STMT_45", combined_ms2_15: "REGX_1024_33B3_COMBINED_15",
} as const;

const need = (ok: unknown, msg: string): void => { if (!ok) throw new RangeError(msg); };
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const civil = (iso: string): PlainDate => plainDate(iso.slice(0, 10));
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))).digest("hex");
export interface OriginationKeys { readonly application_id: string; readonly loan_id?: string | null; }
const keys = (i: OriginationKeys): { applicationId: string; loanId?: string } => ({ applicationId: i.application_id, ...(i.loan_id ? { loanId: i.loan_id } : {}) });
const append = (events: EventStore, i: OriginationKeys, type: string, payload: Record<string, unknown>, actor: Actor = DISCLOSURE_AGENT, causationId?: string | null): DomainEvent =>
  events.append({ type, ...keys(i), actor, ...(causationId ? { causationId } : {}), payload: { application_id: i.application_id, ...(i.loan_id ? { loan_id: i.loan_id } : {}), source: "origination", rule_set: RULE_SET_25_4, ...payload } });
export const money = (c: Cents): string => { const neg = c < 0n; const v = neg ? -c : c; const d = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); return `${neg ? "-" : ""}$${d}.${(v % 100n).toString().padStart(2, "0")}`; };

// ============================================================ jurisdiction rules (31.1) — an unverified row is a hard block
export interface JurisdictionEscrowRule { readonly state: string; readonly kind: "escrow_election_notice" | "interest_on_escrow" | "post_closing_notices"; readonly notice_code: string | null; readonly verified_at: string | null; readonly statute: string; }
/** The rows verified today (spec: "state gates exist only where jurisdiction_rules.escrow_election_notice carries verified text (UT, CA today)"); IL/NY/MA/MN/WI/MD are loaded unverified. */
export const JURISDICTION_RULES_DEFAULT: readonly JurisdictionEscrowRule[] = [
  { state: "UT", kind: "escrow_election_notice", notice_code: NTC.ut_reserve_options, verified_at: "2026-09-10", statute: "Utah Code §7-17-4" },
  { state: "UT", kind: "interest_on_escrow", notice_code: null, verified_at: "2026-09-10", statute: "Utah Code §7-17-3" },
  { state: "CA", kind: "escrow_election_notice", notice_code: NTC.ca_impound_stmt, verified_at: "2026-09-10", statute: "Cal. Civ. Code §2954" },
  { state: "IL", kind: "escrow_election_notice", notice_code: null, verified_at: null, statute: "765 ILCS 910 [UNVERIFIED]" },
  { state: "NY", kind: "escrow_election_notice", notice_code: null, verified_at: null, statute: "N.Y. G.O.L. §5-601 [UNVERIFIED]" },
  { state: "MA", kind: "escrow_election_notice", notice_code: null, verified_at: null, statute: "M.G.L. c.183 §61 [UNVERIFIED]" },
  { state: "MN", kind: "escrow_election_notice", notice_code: null, verified_at: null, statute: "Minn. Stat. §47.20 subd. 9 [UNVERIFIED]" },
  { state: "WI", kind: "escrow_election_notice", notice_code: null, verified_at: null, statute: "Wis. Stat. §138.052(5) [UNVERIFIED]" },
  { state: "MD", kind: "escrow_election_notice", notice_code: null, verified_at: null, statute: "Md. Com. Law §12-109 [UNVERIFIED]" },
];
export interface JurisdictionRefusal { readonly code: "JURISDICTION_RULE_UNVERIFIED"; readonly reason: string; readonly state: string; readonly escalate_to: "officer"; readonly citation: string; }
/** A `jurisdiction_rules.escrow_election_notice` row for the property state without `verified_at` refuses the composer (31.1 verification required); no row at all (AZ, OH) means no state notice. */
export function checkJurisdiction(state: string, rules: readonly JurisdictionEscrowRule[] = JURISDICTION_RULES_DEFAULT): { ok: true; rule: JurisdictionEscrowRule | null } | { ok: false; refusal: JurisdictionRefusal } {
  need(typeof state === "string" && /^[A-Z]{2}$/.test(state), "property state must be a two-letter code");
  const rule = rules.find((r) => r.state === state && r.kind === "escrow_election_notice") ?? null;
  if (rule && !rule.verified_at) return { ok: false, refusal: { code: "JURISDICTION_RULE_UNVERIFIED", reason: `jurisdiction_rules.escrow_election_notice[${state}].verified_at = null`, state, escalate_to: "officer", citation: "25.4 edge cases: 'a jurisdiction_rules row without verified_at is a hard block' (31.1 verifies)" } };
  return { ok: true, rule };
}

// ============================================================ CD-escrow consistency (25.2's CD_ESCROW_VS_O11_3, executed here at package time)
export interface CdEscrowSection { readonly initial_escrow_payment_cents: Cents; readonly monthly_escrow_cents: Cents; readonly escrowed_costs_year1_cents: Cents; }
export interface CdEscrowConsistency { readonly check: CdConsistencyCheck; readonly result: "match" | "mismatch" | "n/a"; readonly blocks_gate: boolean; readonly gate: typeof TIMER.package_gate; readonly corrected_cd: { cd_reason: CdReason; process: "25.2"; citation: string } | null; readonly variances: readonly { field: string; cd_cents: Cents; analysis_cents: Cents }[]; }
/** Worked example 3: CD (l)(7) year-1 escrowed costs = Σ statement disbursements, monthly escrow = statement escrow portion, Section G initial deposit = statement starting balance. Any cent of variance blocks the package gate; the CD is corrected under (f)(2)(i) before consummation (no new waiting period — escrow amounts are not finance charges). */
export function runCdEscrowConsistency(i: { application_id: string; cd_version: number; cd: CdEscrowSection; analysis: Pick<InitialAnalysis30, "target_at_start_cents" | "base_payment_cents" | "escrowed_costs_year1_cents"> | null; now: string }): CdEscrowConsistency {
  const cdVal = { initial: i.cd.initial_escrow_payment_cents, monthly: i.cd.monthly_escrow_cents, year1: i.cd.escrowed_costs_year1_cents };
  const src = i.analysis ? { initial: i.analysis.target_at_start_cents, monthly: i.analysis.base_payment_cents, year1: i.analysis.escrowed_costs_year1_cents } : null;
  const checks = runCdConsistencyChecks({ application_id: i.application_id, cd_version: i.cd_version, cd: { CD_ESCROW_VS_O11_3: cdVal }, source: src ? { CD_ESCROW_VS_O11_3: src } : {}, now: i.now });
  const check = checks.find((c) => c.check_code === "CD_ESCROW_VS_O11_3")!;
  const variances = src ? (["initial", "monthly", "year1"] as const).filter((k) => cdVal[k] !== src[k]).map((k) => ({ field: k, cd_cents: cdVal[k], analysis_cents: src[k] })) : [];
  const mismatch = check.result === "mismatch";
  return { check, result: check.result, blocks_gate: mismatch, gate: TIMER.package_gate, variances,
    corrected_cd: mismatch ? { cd_reason: "pre_consummation_no_wait", process: "25.2", citation: "§1026.19(f)(2)(i): corrected CD at or before consummation; no new waiting period — the escrow figures change no APR, product or prepayment penalty" } : null };
}

// ============================================================ escrow election rule (`evaluateEscrowWaiver`)
export type EscrowElectionKind = "escrow_full" | "waived" | "partial_taxes_only" | "partial_insurance_only";
export type WaiverBlockReason = "hpml" | "bpmi" | "delinquent_tax_financed_refi" | "flood_required_escrow" | "state_prohibits" | "partner_policy_ltv" | "partner_policy_financial_ability" | "partner_policy_payment_history";
export interface WaiverPolicy { readonly version: string; readonly max_ltv_pct: number; readonly min_reserves_months_of_ti: number; readonly max_mortgage_lates_30_in_12m: number; }
/** The partner's written policy (B2-1.5-04: criteria beyond LTV — financial ability to handle the lump sums; payment history). */
export const PARTNER_WAIVER_POLICY: WaiverPolicy = { version: "partner.escrow_waiver.2026-09", max_ltv_pct: 80, min_reserves_months_of_ti: 2, max_mortgage_lates_30_in_12m: 0 };
export interface WaiverCriteria { readonly ltv_pct: number; readonly reserves_months_of_ti: number; readonly mortgage_lates_30_in_12m: number; readonly hpml: boolean; readonly bpmi: boolean; readonly delinquent_tax_financed_refi: boolean; readonly flood_required_escrow: boolean; readonly blanket_policy_unit: boolean; readonly state: string; readonly state_prohibits_waiver?: boolean; }
export interface WaiverEvaluation { readonly waivable: boolean; readonly reasons: readonly WaiverBlockReason[]; readonly reason: WaiverBlockReason | null; readonly election: EscrowElectionKind; readonly waiver_fee_cents: Cents; readonly waiver_policy_version: string; readonly waiver_criteria: WaiverCriteria; readonly state_notice_codes: readonly string[]; readonly interest_on_escrow_required: boolean; readonly citations: readonly string[]; }
/** `waivable = requested ∧ ¬hpml ∧ ¬bpmi ∧ ¬delinquent_tax_financed_refi ∧ ¬flood_required_escrow ∧ partner_policy(LTV, financial ability, payment history) ∧ ¬state_prohibits`; the default fee is 0 (no Fannie Mae escrow-waiver LLPA exists — discrepancy 3). */
export function evaluateEscrowWaiver(i: { election_requested: EscrowElectionKind; criteria: WaiverCriteria; policy?: WaiverPolicy; waiver_fee_cents?: Cents; jurisdiction_rules?: readonly JurisdictionEscrowRule[] }): WaiverEvaluation {
  const c = i.criteria; const pol = i.policy ?? PARTNER_WAIVER_POLICY; const rules = i.jurisdiction_rules ?? JURISDICTION_RULES_DEFAULT;
  need(Number.isFinite(c.ltv_pct) && c.ltv_pct > 0, "ltv_pct is required");
  const reasons: WaiverBlockReason[] = []; const cit: string[] = [];
  if (i.election_requested !== "escrow_full") {
    if (c.hpml) { reasons.push("hpml"); cit.push("§1026.35(b)(1): an HPML first lien must have an escrow account established before consummation (23.4)"); }
    if (c.bpmi) { reasons.push("bpmi"); cit.push("B2-1.5-04: lenders cannot waive an escrow account for the payment of premiums for borrower-purchased mortgage insurance"); }
    if (c.delinquent_tax_financed_refi) { reasons.push("delinquent_tax_financed_refi"); cit.push("B2-1.5-04 / B2-1.3-03: a refinance financing real estate taxes in the loan amount requires an escrow account"); }
    if (c.flood_required_escrow && !c.blanket_policy_unit) { reasons.push("flood_required_escrow"); cit.push("B2-1.5-04 'premiums for flood insurance' (policy)"); }
    if (c.state_prohibits_waiver) { reasons.push("state_prohibits"); cit.push("state law requires the account (jurisdiction_rules)"); }
    if (c.ltv_pct > pol.max_ltv_pct) { reasons.push("partner_policy_ltv"); cit.push(`partner policy ${pol.version}: LTV ${c.ltv_pct}% > ${pol.max_ltv_pct}%`); }
    if (c.reserves_months_of_ti < pol.min_reserves_months_of_ti) { reasons.push("partner_policy_financial_ability"); cit.push(`partner policy ${pol.version}: reserves ${c.reserves_months_of_ti} < ${pol.min_reserves_months_of_ti} months of T&I (B2-1.5-04 financial-ability test)`); }
    if (c.mortgage_lates_30_in_12m > pol.max_mortgage_lates_30_in_12m) { reasons.push("partner_policy_payment_history"); cit.push(`partner policy ${pol.version}: ${c.mortgage_lates_30_in_12m} × 30-day lates in 12 months`); }
  }
  const waivable = i.election_requested !== "escrow_full" && reasons.length === 0;
  const election: EscrowElectionKind = waivable ? i.election_requested : "escrow_full";
  const stateRule = rules.find((r) => r.state === c.state && r.kind === "escrow_election_notice" && r.verified_at && r.notice_code);
  const state_notice_codes = [NTC.escrow_election, ...(stateRule?.notice_code ? [stateRule.notice_code] : [])];
  return { waivable, reasons, reason: reasons[0] ?? null, election, waiver_fee_cents: i.waiver_fee_cents ?? 0n, waiver_policy_version: pol.version, waiver_criteria: c, state_notice_codes, interest_on_escrow_required: interestOnEscrowRequired(c.state, election, c.ltv_pct), citations: cit };
}
/** Utah 7-17-3(1)/(2): interest on a required reserve account, except while the loan exceeds 80% of appraised value (until paid down to 80%); no other fixture state carries a verified interest rule. */
export function interestOnEscrowRequired(state: string, election: EscrowElectionKind, ltvPct: number): boolean { return state === "UT" && election !== "waived" && ltvPct <= 80; }
export interface EscrowElection { readonly election_id: string; readonly application_id: string; readonly election: EscrowElectionKind; readonly waiver_policy_version: string; readonly waiver_criteria: WaiverCriteria; readonly waiver_fee_cents: Cents; readonly state_notice_codes: readonly string[]; readonly elected_at: string; readonly election_evidence_document_id: string | null; readonly interest_on_escrow_required: boolean; readonly recorded_by: string; readonly reasons: readonly WaiverBlockReason[]; }
export function recordEscrowElection(events: EventStore, i: OriginationKeys & { election_id: string; evaluation: WaiverEvaluation; elected_at: string; election_evidence_document_id?: string | null; agent_run_id: string; actor?: Actor }): { row: EscrowElection; event: DomainEvent } {
  need(!!i.election_id && !!i.agent_run_id && typeof i.elected_at === "string" && i.elected_at.length >= 10, "election_id, agent_run_id and elected_at are required");
  const e = i.evaluation;
  const row: EscrowElection = { election_id: i.election_id, application_id: i.application_id, election: e.election, waiver_policy_version: e.waiver_policy_version, waiver_criteria: e.waiver_criteria, waiver_fee_cents: e.waiver_fee_cents, state_notice_codes: e.state_notice_codes, elected_at: i.elected_at, election_evidence_document_id: i.election_evidence_document_id ?? null, interest_on_escrow_required: e.interest_on_escrow_required, recorded_by: i.agent_run_id, reasons: e.reasons };
  const event = append(events, i, "escrow.election.recorded", { election_id: row.election_id, election: row.election, requested_waiver: e.waivable || e.reasons.length > 0, waivable: e.waivable, reasons: [...e.reasons], waiver_policy_version: row.waiver_policy_version, waiver_fee_cents: row.waiver_fee_cents.toString(), state_notice_codes: [...row.state_notice_codes], elected_at: row.elected_at, elected_on: civil(row.elected_at), interest_on_escrow_required: row.interest_on_escrow_required, mi_flag: e.waiver_criteria.bpmi, hpml_flag: e.waiver_criteria.hpml }, i.actor ?? DISCLOSURE_AGENT);
  return { row, event };
}

// ============================================================ state escrow notices (Utah 7-17-4; California Civ. Code §2954) and their gates
export type StateNoticeKind = "state:UT_7_17_4" | "state:CA_CIV_2954";
export interface StateNoticeRender { readonly state: "UT" | "CA"; readonly code: string; readonly disclosure_kind: StateNoticeKind; readonly required: boolean; readonly basis: "statute" | "policy" | "not_applicable"; readonly account_may_be_required: boolean; readonly gate: typeof TIMER.ut_gate | typeof TIMER.ca_gate; readonly timing: "at_or_prior_to_closing" | "before_or_with_election"; readonly payload: Record<string, unknown>; readonly interest_on_escrow_required: boolean; }
export interface StateNoticeInput { readonly state: string; readonly election: EscrowElectionKind; readonly ltv_pct: number; readonly partner_name: string; readonly borrower_names: readonly string[]; readonly property_address: string; readonly loan_number: string; readonly single_family_owner_occupied?: boolean; readonly transaction_type?: "purchase" | "refinance"; readonly cltv_over_80?: boolean; }
/** California §2954(a)(1): the account may be required where the loan is ≥ 90% of the sale price/appraisal or the combined loans exceed 80%; otherwise the written statement is a condition of establishing the account on a single-family owner-occupied dwelling (delivered as policy even where required). */
export function ca2954Applies(i: { ltv_pct: number; single_family_owner_occupied: boolean; impound_elected: boolean; cltv_over_80?: boolean }): { required: boolean; basis: "statute" | "policy" | "not_applicable"; account_may_be_required: boolean } {
  const account_may_be_required = i.ltv_pct >= 90 || i.cltv_over_80 === true;
  if (!i.impound_elected || !i.single_family_owner_occupied) return { required: false, basis: "not_applicable", account_may_be_required };
  return { required: true, basis: account_may_be_required ? "policy" : "statute", account_may_be_required };
}
/** Renders the state notice payload for the property state (UT: both 7-17-4 options with the mandated statements; CA: the §2954 written statement) — the composer delivers it in the package. */
export function renderStateEscrowNotice(i: StateNoticeInput): StateNoticeRender | null {
  need(typeof i.state === "string" && /^[A-Z]{2}$/.test(i.state) && !!i.partner_name && i.borrower_names.length > 0, "state, partner_name and borrower_names are required");
  if (i.state === "UT") {
    const interest = interestOnEscrowRequired("UT", i.election, i.ltv_pct);
    return { state: "UT", code: NTC.ut_reserve_options, disclosure_kind: "state:UT_7_17_4", required: true, basis: "statute", account_may_be_required: false, gate: TIMER.ut_gate, timing: "at_or_prior_to_closing", interest_on_escrow_required: interest,
      payload: { partner_name: i.partner_name, borrower_names: [...i.borrower_names], property_address: i.property_address, loan_number: i.loan_number, ltv_pct: i.ltv_pct, election: i.election, elected_reserve_account: i.election !== "waived", interest_on_reserve: interest, interest_paid_from_ltv_pct: 80, reserve_required_by_lender: false, service_charge_cents: 0n } };
  }
  if (i.state === "CA") {
    const a = ca2954Applies({ ltv_pct: i.ltv_pct, single_family_owner_occupied: i.single_family_owner_occupied !== false, impound_elected: i.election !== "waived", ...(i.cltv_over_80 !== undefined ? { cltv_over_80: i.cltv_over_80 } : {}) });
    return { state: "CA", code: NTC.ca_impound_stmt, disclosure_kind: "state:CA_CIV_2954", required: a.required, basis: a.basis, account_may_be_required: a.account_may_be_required, gate: TIMER.ca_gate, timing: "before_or_with_election", interest_on_escrow_required: false,
      payload: { partner_name: i.partner_name, borrower_names: [...i.borrower_names], property_address: i.property_address, loan_number: i.loan_number, ltv_pct: i.ltv_pct, single_family_owner_occupied: i.single_family_owner_occupied !== false, account_may_be_required: a.account_may_be_required, required_as_condition: false, interest_paid: false, interest_statement: "No interest will be paid on the funds in the impound account (Civ. Code §2954.8 — servicing 3.x applies any statutory interest)." } };
  }
  return null;
}
export interface UtGateFacts { readonly notice_delivered_on?: PlainDate | string | null; readonly elected_at?: string | null; readonly consummation_at?: string | null; readonly property_state?: string; }
/** UT_7_17_4_RESERVE_OPTIONS_NOTICE_GATE: notice delivered at or prior to the closing AND the election captured at closing (`escrow_elections.elected_at ≤ consummation_at`). */
export function utReserveOptionsGate(f: UtGateFacts): { open: boolean; reason?: string } {
  if (f.property_state && f.property_state !== "UT") return { open: true };
  if (!f.consummation_at) return { open: false, reason: "consummation_at unknown" };
  const cons = civil(f.consummation_at);
  if (!f.notice_delivered_on) return { open: false, reason: `${NTC.ut_reserve_options} not delivered (7-17-4: 'at or prior to the closing of the loan')` };
  if (civil(String(f.notice_delivered_on)) > cons) return { open: false, reason: `${NTC.ut_reserve_options} delivered ${String(f.notice_delivered_on).slice(0, 10)} after the closing ${cons}` };
  if (!f.elected_at) return { open: false, reason: "escrow_elections.elected_at missing — 'the borrower shall select one of the options at the closing'" };
  if (f.elected_at > f.consummation_at) return { open: false, reason: `escrow_elections.elected_at ${f.elected_at} > consummation_at ${f.consummation_at}` };
  return { open: true };
}
export interface CaGateFacts { readonly required?: boolean; readonly statement_delivered_on?: PlainDate | string | null; readonly elected_at?: string | null; readonly property_state?: string; }
/** CA_CIV_2954_IMPOUND_STMT_GATE: the written statement delivered before or with the election whenever it is required. */
export function caImpoundStmtGate(f: CaGateFacts): { open: boolean; reason?: string } {
  if (f.property_state && f.property_state !== "CA") return { open: true };
  if (f.required === false) return { open: true };
  if (!f.statement_delivered_on) return { open: false, reason: `${NTC.ca_impound_stmt} not delivered (Civ. Code §2954: written statement that the account is not required as a condition and whether interest is paid)` };
  if (f.elected_at && civil(String(f.statement_delivered_on)) > civil(f.elected_at)) return { open: false, reason: `statement delivered ${String(f.statement_delivered_on).slice(0, 10)} after the election ${f.elected_at.slice(0, 10)}` };
  return { open: true };
}
export function recordStateNoticeGate(events: EventStore, i: OriginationKeys & { state: "UT" | "CA"; code: string; result: { open: boolean; reason?: string }; delivered_on?: PlainDate | null; elected_at?: string | null; actor?: Actor }): DomainEvent {
  return append(events, i, "escrow.state_notice.gate.evaluated", { state: i.state, code: i.code, disclosure_kind: i.state === "UT" ? "state:UT_7_17_4" : "state:CA_CIV_2954", gate: i.state === "UT" ? TIMER.ut_gate : TIMER.ca_gate, result: i.result.open ? "open" : "blocked", reason: i.result.reason ?? null, delivered_on: i.delivered_on ?? null, elected_at: i.elected_at ?? null }, i.actor ?? DISCLOSURE_AGENT);
}

// ============================================================ privacy gate (`checkPrivacyNotice`) — GLBA §1016.4(a)(1)
export interface BorrowerPrivacyFact { readonly borrower_id: string; readonly privacy_delivered_at: string | null; readonly customer: boolean; }
export interface PrivacyGateResult { readonly result: "open" | "blocked"; readonly missing_borrower_ids: readonly string[]; readonly insert_into_package: boolean; readonly citation: string; }
/** For each borrower (a GLBA "customer"; a non-borrower spouse is not): `∃ disclosures{kind=privacy, delivered_at ≤ consummation_at}`; absent → the composer inserts NTC_GLBA_1016_4_PRIVACY_INITIAL into the package ("not later than when you establish a customer relationship"). */
export function checkPrivacyNotice(borrowers: readonly BorrowerPrivacyFact[], consummationAt: string): PrivacyGateResult {
  need(Array.isArray(borrowers) && borrowers.length > 0, "at least one borrower is required"); need(typeof consummationAt === "string" && consummationAt.length >= 10, "consummation_at is required");
  const missing = borrowers.filter((b) => b.customer && !(b.privacy_delivered_at && b.privacy_delivered_at <= consummationAt)).map((b) => b.borrower_id);
  return { result: missing.length ? "blocked" : "open", missing_borrower_ids: missing, insert_into_package: missing.length > 0, citation: "12 CFR 1016.4(a)(1), (c)(3)(i); 21.3 delivers with the application package; 25.4-Q3: no separate SM initial notice" };
}
export function recordPrivacyGate(events: EventStore, i: OriginationKeys & { result: PrivacyGateResult; consummation_at: string; actor?: Actor }): DomainEvent {
  return append(events, i, "privacy.gate.evaluated", { gate: TIMER.privacy_gate, result: i.result.result, missing_borrower_ids: [...i.result.missing_borrower_ids], insert_into_package: i.result.insert_into_package, consummation_at: i.consummation_at, template: NTC.privacy_initial }, i.actor ?? DISCLOSURE_AGENT);
}

// ============================================================ closing package (`composeClosingPackage`)
export type PackageStatus = "composing" | "gated" | "delivered" | "evidenced" | "exception";
export type ReceiptEvidence = "esign_session" | "signed_manifest" | "in_person_acknowledgment" | "portal_acknowledged";
export interface PackageItem { readonly notice_code: string; readonly owner_process: string; readonly required: boolean; readonly in_package: boolean; readonly basis: string; readonly gate: string | null; readonly disclosure_kind: string | null; readonly rendered_document_id: string | null; readonly channel: "signing_session" | "paper_manifest" | "mail" | "edelivery" | null; readonly delivered_at: string | null; readonly receipt_evidence: ReceiptEvidence | null; readonly after_closing: string | null; readonly payload?: Record<string, unknown> | null; }
export interface ClosingNoticeRun { readonly run_id: string; readonly application_id: string; readonly loan_id: string | null; readonly kind: "closing_package" | "post_closing"; readonly composed_at: string; readonly cd_disclosure_id: string | null; readonly cd_version: number | null; readonly items: readonly PackageItem[]; readonly status: PackageStatus; readonly agent_run_id: string; readonly gates: Record<string, { open: boolean; reason?: string }>; readonly consistency: CdEscrowConsistency | null; readonly refusal: JurisdictionRefusal | null; readonly escrow_statement: { decision: "in_package" | "deferred" | "not_escrowed"; latest_approval_on: PlainDate | null; fallback_due_on: PlainDate | null } | null; readonly consummation_at: string; readonly property_state: string; }
export interface ComposeInput extends OriginationKeys {
  readonly run_id: string; readonly agent_run_id: string; readonly now: string; readonly consummation_at: string; readonly property_state: string; readonly transaction_type: "purchase" | "refinance"; readonly principal_dwelling_refinance?: boolean;
  readonly cd: { readonly disclosure_id: string; readonly cd_version: number; readonly status: string; readonly escrow: CdEscrowSection | null };
  readonly escrow_analysis: { readonly analysis: Pick<InitialAnalysis30, "analysis_id" | "target_at_start_cents" | "base_payment_cents" | "escrowed_costs_year1_cents">; readonly approved_on: PlainDate | null; readonly rendered_document_id?: string | null; readonly rendered_event_id?: string | null } | null;
  readonly escrow_election: EscrowElection | null; readonly borrowers: readonly BorrowerPrivacyFact[]; readonly hpa: { required: boolean; template: string } | null; readonly flood_ack_required?: boolean;
  readonly state_notice?: StateNoticeRender | null; readonly state_notice_delivered_on?: PlainDate | null; readonly jurisdiction_rules?: readonly JurisdictionEscrowRule[];
  readonly payment_address_named_at_closing?: boolean; readonly actor?: Actor;
}
const item = (o: Partial<PackageItem> & Pick<PackageItem, "notice_code" | "owner_process" | "required" | "in_package" | "basis">): PackageItem => ({ gate: null, disclosure_kind: null, rendered_document_id: null, channel: null, delivered_at: null, receipt_evidence: null, after_closing: null, payload: null, ...o });
/**
 * The closing-day notice run over the `consummation_ready` CD version, in the spec's table order. Refuses (status `exception`, escalation to
 * `officer`) on an unverified state row; blocks the gate on a CD-escrow mismatch; drops the initial escrow statement to 3.1's 45-day
 * path when 30.3's analysis was approved less than 1 creditor business day before consummation; inserts the privacy notice when a
 * borrower lacks 21.3's evidence; adds the state notices for UT/CA; adds 1.3's combined MS-2 only when the partner named its own payee address.
 */
export function composeClosingPackage(events: EventStore, i: ComposeInput): ClosingNoticeRun {
  need(!!i.run_id && !!i.agent_run_id && !!i.application_id, "run_id, agent_run_id and application_id are required");
  need(typeof i.consummation_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(i.consummation_at), "consummation_at (ISO) is required");
  need(!!i.cd && !!i.cd.disclosure_id && Number.isInteger(i.cd.cd_version), "the consummation_ready CD version (disclosure_id, cd_version) is required");
  const actor = i.actor ?? DISCLOSURE_AGENT; const consummationOn = civil(i.consummation_at);
  const base = { run_id: i.run_id, application_id: i.application_id, loan_id: i.loan_id ?? null, kind: "closing_package" as const, composed_at: i.now, cd_disclosure_id: i.cd.disclosure_id, cd_version: i.cd.cd_version, agent_run_id: i.agent_run_id, consummation_at: i.consummation_at, property_state: i.property_state };
  // 1. jurisdiction (31.1): an unverified escrow-notice row is a hard block
  const j = checkJurisdiction(i.property_state, i.jurisdiction_rules);
  if (!j.ok) {
    const run: ClosingNoticeRun = { ...base, items: [], status: "exception", gates: {}, consistency: null, refusal: j.refusal, escrow_statement: null };
    append(events, i, "notice.closing_package.composed", { run_id: run.run_id, status: "exception", refusal_code: j.refusal.code, reason: j.refusal.reason, escalate_to: j.refusal.escalate_to, cd_disclosure_id: i.cd.disclosure_id, items: [] }, actor);
    return run;
  }
  need(i.cd.status === "consummation_ready", `the package composes only from the consummation_ready CD version (status ${i.cd.status})`);
  const gates: Record<string, { open: boolean; reason?: string }> = {};
  const items: PackageItem[] = [];
  items.push(item({ notice_code: NTC.cd, owner_process: "25.2", required: true, in_package: true, basis: "final CD — signed acknowledgment copy (received ≥ 3 specific business days earlier)", gate: "REGZ_1026_19F1_CD_3SBD_GATE", disclosure_kind: "cd", rendered_document_id: i.cd.disclosure_id }));
  if (i.transaction_type === "refinance" && i.principal_dwelling_refinance !== false) items.push(item({ notice_code: NTC.h8, owner_process: "25.3", required: true, in_package: true, basis: "notice of right to cancel, 2 copies per consumer (§1026.23(b))", gate: "SM_O63_NOTICE_AT_SIGNING_GATE", disclosure_kind: "rescission_h8" }));
  if (i.hpa?.required) items.push(item({ notice_code: i.hpa.template, owner_process: "24.6", required: true, in_package: true, basis: "HPA §4903 initial disclosure + amortization schedule (BPMI)", gate: "HPA_4903_INITIAL_DISCLOSURE_GATE", disclosure_kind: "hpa_initial" }));
  if (i.flood_ack_required) items.push(item({ notice_code: NTC.flood, owner_process: "24.5", required: true, in_package: true, basis: "flood notice acknowledgment copy (notice delivered ≥ 10 days earlier)", gate: "FDPA_4104A_FLOOD_NOTICE_GATE", disclosure_kind: "flood_notice" }));
  // 2. CD-escrow consistency (executed here at package time) and the initial escrow statement decision
  let consistency: CdEscrowConsistency | null = null; let escrow_statement: ClosingNoticeRun["escrow_statement"] = null;
  if (i.cd.escrow && i.escrow_analysis) {
    consistency = runCdEscrowConsistency({ application_id: i.application_id, cd_version: i.cd.cd_version, cd: i.cd.escrow, analysis: i.escrow_analysis.analysis, now: i.now });
    const lead = i.escrow_analysis.approved_on ? packageLead(i.escrow_analysis.approved_on, consummationOn) : { in_package: false, latest_approval_on: null };
    const inPackage = lead.in_package && !consistency.blocks_gate;
    escrow_statement = { decision: inPackage ? "in_package" : "deferred", latest_approval_on: lead.latest_approval_on, fallback_due_on: inPackage ? null : addDays(consummationOn, 45) };
    items.push(item({ notice_code: NTC.initial_escrow_stmt, owner_process: "3.1", required: inPackage, in_package: inPackage, basis: inPackage ? `30.3 analysis ${i.escrow_analysis.analysis.analysis_id} approved ${i.escrow_analysis.approved_on} ≤ ${lead.latest_approval_on} (≥ 1 business_days_creditor before consummation)` : `deferred to 3.1's ${TIMER.regx_17g_45}: settlement + 45 calendar days = ${addDays(consummationOn, 45)}`, gate: TIMER.escrow_stmt, disclosure_kind: "initial_escrow_stmt", rendered_document_id: inPackage ? (i.escrow_analysis.rendered_document_id ?? null) : null, after_closing: inPackage ? null : `by ${addDays(consummationOn, 45)} (3.1)` }));
    append(events, i, "escrow.statement.package_decision", { timer: TIMER.escrow_stmt, decision: escrow_statement.decision, analysis_id: i.escrow_analysis.analysis.analysis_id, approved_on: i.escrow_analysis.approved_on, latest_approval_for_package_on: lead.latest_approval_on, consummation_on: consummationOn, fallback_timer: TIMER.regx_17g_45, fallback_due_on: escrow_statement.fallback_due_on, consistency: consistency.result }, actor);
  } else if (i.cd.escrow) { escrow_statement = { decision: "deferred", latest_approval_on: null, fallback_due_on: addDays(consummationOn, 45) }; }
  else escrow_statement = { decision: "not_escrowed", latest_approval_on: null, fallback_due_on: null };
  // 3. escrow election record and the state notices
  if (i.escrow_election) items.push(item({ notice_code: NTC.escrow_election, owner_process: "25.4", required: true, in_package: true, basis: `election ${i.escrow_election.election} (policy ${i.escrow_election.waiver_policy_version})`, disclosure_kind: "escrow_election" }));
  if (i.state_notice && i.state_notice.required) {
    items.push(item({ notice_code: i.state_notice.code, owner_process: "25.4", required: true, in_package: true, basis: `${i.state_notice.state}: ${i.state_notice.timing} (${i.state_notice.basis})`, gate: i.state_notice.gate, disclosure_kind: i.state_notice.disclosure_kind, payload: i.state_notice.payload, ...(i.state_notice_delivered_on ? { delivered_at: `${i.state_notice_delivered_on}T00:00:00.000Z` } : {}) }));
    const g = i.state_notice.state === "UT" ? utReserveOptionsGate({ notice_delivered_on: i.state_notice_delivered_on ?? null, elected_at: i.escrow_election?.elected_at ?? null, consummation_at: i.consummation_at }) : caImpoundStmtGate({ required: true, statement_delivered_on: i.state_notice_delivered_on ?? null, elected_at: i.escrow_election?.elected_at ?? null });
    gates[i.state_notice.gate] = g;
    recordStateNoticeGate(events, { ...i, state: i.state_notice.state, code: i.state_notice.code, result: g, delivered_on: i.state_notice_delivered_on ?? null, elected_at: i.escrow_election?.elected_at ?? null, actor });
  }
  // 4. privacy gate — insert 21.3's notice when a customer lacks evidence
  const privacy = checkPrivacyNotice(i.borrowers, i.consummation_at); gates[TIMER.privacy_gate] = privacy.result === "open" ? { open: true } : { open: false, reason: `privacy notice not evidenced for ${privacy.missing_borrower_ids.join(", ")}` };
  recordPrivacyGate(events, { ...i, result: privacy, consummation_at: i.consummation_at, actor });
  if (privacy.insert_into_package) items.push(item({ notice_code: NTC.privacy_initial, owner_process: "21.3", required: true, in_package: true, basis: `no delivery evidence for ${privacy.missing_borrower_ids.join(", ")} — §1016.4(a)(1) 'not later than when you establish a customer relationship'`, gate: TIMER.privacy_gate, disclosure_kind: "privacy" }));
  // 5. payment address: inherent in the note/CD; the 1.3 combined MS-2 only in the fallback
  const pa = paymentAddressAtClosing({ payee_named: i.payment_address_named_at_closing === false ? "partner_own_address" : "sm_as_servicer_for_partner" });
  if (pa.combined_ms2_required) items.push(item({ notice_code: NTC.combined_ms2, owner_process: "1.3", required: true, in_package: true, basis: pa.basis, gate: TIMER.combined_ms2_15, disclosure_kind: "servicing_transfer_combined", payload: { delivered_at_settlement: true } }));
  // 6. after-closing items (recorded, never in the package)
  items.push(item({ notice_code: NTC.first_payment_letter, owner_process: "30.2", required: false, in_package: false, basis: "figures fixed at funding", after_closing: `≤ 5 business_days_servicer after funding and ≥ 20 days before the first payment (${TIMER.letter_5bd} / ${TIMER.letter_predue_20})` }));
  items.push(item({ notice_code: NTC.welcome, owner_process: "30.2", required: false, in_package: false, basis: "welcome letter", after_closing: `with the post-closing run (${TIMER.post_closing_run})` }));
  items.push(item({ notice_code: NTC.ownership_transfer, owner_process: "25.4", required: false, in_package: false, basis: "Fannie Mae's own letter; fallback only", after_closing: `Fannie Mae, on or before purchase + 30 calendar days (${TIMER.ownership_30} expectation)` }));
  const blocked = Object.entries(gates).filter(([, g]) => !g.open).map(([k]) => k);
  const status: PackageStatus = consistency?.blocks_gate || blocked.length ? "composing" : "gated";
  gates[TIMER.package_gate] = status === "gated" ? { open: true } : { open: false, reason: consistency?.blocks_gate ? `CD_ESCROW_VS_O11_3 = mismatch (${consistency.variances.map((v) => `${v.field}: CD ${money(v.cd_cents)} vs analysis ${money(v.analysis_cents)}`).join("; ")}) — 25.2 corrected CD with cd_reason=${consistency.corrected_cd!.cd_reason}` : `gates closed: ${blocked.join(", ")}` };
  const run: ClosingNoticeRun = { ...base, items, status, gates, consistency, refusal: null, escrow_statement };
  append(events, i, "notice.closing_package.composed", { run_id: run.run_id, status, cd_disclosure_id: i.cd.disclosure_id, cd_version: i.cd.cd_version, consummation_on: consummationOn, items: items.map((x) => ({ notice_code: x.notice_code, owner_process: x.owner_process, required: x.required, in_package: x.in_package, gate: x.gate })), gate: TIMER.package_gate, gate_open: status === "gated", gate_reason: gates[TIMER.package_gate]!.reason ?? null, consistency: consistency?.result ?? null, corrected_cd_reason: consistency?.corrected_cd?.cd_reason ?? null, privacy_gate: privacy.result, escrow_statement: escrow_statement?.decision ?? null }, actor);
  return run;
}
export interface PackageGateFacts { readonly status?: string; readonly required_items_rendered?: boolean; readonly cd_status?: string; readonly consistency_result?: string; }
/** SM_O64_CLOSING_PACKAGE_NOTICES_GATE: every required item rendered from the consummation_ready CD version and the composer at `gated`. */
export function closingPackageGate(f: PackageGateFacts): { open: boolean; reason?: string } {
  if (f.cd_status && f.cd_status !== "consummation_ready") return { open: false, reason: `CD version is ${f.cd_status}, not consummation_ready` };
  if (f.consistency_result === "mismatch") return { open: false, reason: "CD_ESCROW_VS_O11_3 = mismatch — corrected CD required (25.2)" };
  if (f.required_items_rendered === false) return { open: false, reason: "a required item is not rendered" };
  if (f.status !== "gated" && f.status !== "delivered" && f.status !== "evidenced") return { open: false, reason: `closing_notice_runs.status = ${f.status ?? "none"} (needs gated)` };
  return { open: true };
}
/** Delivery through the signing session (26.2) or the settlement agent's paper package; nothing is marked delivered here — evidence does that. */
export function deliverPackage(events: EventStore, run: ClosingNoticeRun, d: { channel: "signing_session" | "paper_manifest"; session_id?: string | null; delivered_at: string; actor?: Actor }): ClosingNoticeRun {
  need(run.status === "gated", `only a gated package is delivered (status ${run.status}; ${TIMER.package_gate})`);
  need(typeof d.delivered_at === "string" && d.delivered_at.length >= 10, "delivered_at is required");
  const items = run.items.map((x) => (x.in_package ? { ...x, channel: d.channel } : x));
  const next: ClosingNoticeRun = { ...run, items, status: "delivered" };
  append(events, run, "notice.closing_package.delivered", { run_id: run.run_id, channel: d.channel, session_id: d.session_id ?? null, delivered_at: d.delivered_at, items: items.filter((x) => x.in_package).map((x) => x.notice_code), evidence_pending: true }, d.actor ?? DISCLOSURE_AGENT);
  return next;
}
export interface ManifestEntry { readonly notice_code: string; readonly delivered_at: string; readonly receipt_evidence: ReceiptEvidence; readonly document_id: string; readonly borrower_ids?: readonly string[]; }
export interface EvidenceResult { readonly run: ClosingNoticeRun; readonly escrow_account: { initial_statement_delivered_at: PlainDate; initial_statement_document_id: string; initial_statement_delivery_basis: "at_settlement" } | null; readonly escrow_statement_sent: DomainEvent | null; readonly privacy_gate: PrivacyGateResult | null; readonly combined_ms2: { timer: typeof TIMER.combined_ms2_15; satisfied_at_settlement: true; basis: string; event: DomainEvent } | null; readonly missing_required: readonly string[]; }
/**
 * Per-item receipt evidence from the signing-session audit trail or the signed paper manifest (guardrail: never marked delivered without it).
 * The escrow statement's evidence writes 3.1's `escrow.statement.sent{statement_type=initial, channel=closing_package}` through 30.3 (day-0
 * satisfaction of REGX_1024_17G_INITIAL_STMT_45) and `escrow_accounts.initial_statement_delivered_at = consummation date`; a privacy notice in
 * the package re-evaluates the GLBA gate; the combined MS-2 fallback records 1.3's `notice.mailed{template, every_loan=true}` at settlement.
 */
export function recordPackageEvidence(events: EventStore, run: ClosingNoticeRun, ev: { manifest: readonly ManifestEntry[]; manifest_document_id: string; borrowers?: readonly BorrowerPrivacyFact[]; actor?: Actor }): EvidenceResult {
  need(run.status === "delivered" || run.status === "evidenced", `evidence is recorded on a delivered package (status ${run.status})`);
  need(Array.isArray(ev.manifest) && ev.manifest.length > 0 && !!ev.manifest_document_id, "a signing-session or paper manifest with at least one entry is required (guardrail: never mark an item delivered without evidence)");
  for (const m of ev.manifest) need(!!m.document_id && !!m.receipt_evidence && typeof m.delivered_at === "string", `manifest entry ${m.notice_code} needs document_id, receipt_evidence and delivered_at`);
  const actor = ev.actor ?? DISCLOSURE_AGENT; const consummationOn = civil(run.consummation_at);
  const items = run.items.map((x) => { const m = ev.manifest.find((e) => e.notice_code === x.notice_code); return m && x.in_package ? { ...x, delivered_at: m.delivered_at, receipt_evidence: m.receipt_evidence, rendered_document_id: x.rendered_document_id ?? m.document_id } : x; });
  let escrow_account: EvidenceResult["escrow_account"] = null; let escrow_statement_sent: DomainEvent | null = null;
  const stmt = items.find((x) => x.notice_code === NTC.initial_escrow_stmt && x.in_package && x.delivered_at);
  if (stmt) {
    need(civil(stmt.delivered_at!) === consummationOn, `the statement in the package is delivered at settlement ${consummationOn}, not ${stmt.delivered_at}`);
    const d = deliverStatementAtSettlement(events, { application_id: run.application_id, loan_id: run.loan_id, settlement_date: consummationOn, in_package: true, actor: { kind: "agent", id: "escrow" } });
    escrow_statement_sent = d.sent; escrow_account = { initial_statement_delivered_at: consummationOn, initial_statement_document_id: stmt.rendered_document_id!, initial_statement_delivery_basis: "at_settlement" };
  }
  let privacy_gate: PrivacyGateResult | null = null;
  const priv = items.find((x) => x.notice_code === NTC.privacy_initial && x.in_package);
  if (priv && ev.borrowers) {
    // acknowledged at signing on the consummation date = delivered "not later than when you establish a customer relationship" (the signing session is the consummation)
    const ackAt = priv.delivered_at ? (civil(priv.delivered_at) === consummationOn && priv.delivered_at > run.consummation_at ? run.consummation_at : priv.delivered_at) : null;
    const acknowledged = ackAt ? ev.borrowers.map((b) => ({ ...b, privacy_delivered_at: b.privacy_delivered_at ?? ackAt })) : ev.borrowers;
    privacy_gate = checkPrivacyNotice(acknowledged, run.consummation_at); recordPrivacyGate(events, { ...run, result: privacy_gate, consummation_at: run.consummation_at, actor });
  }
  let combined_ms2: EvidenceResult["combined_ms2"] = null;
  const ms2 = items.find((x) => x.notice_code === NTC.combined_ms2 && x.in_package && x.delivered_at);
  if (ms2) {
    const e = append(events, run, "notice.mailed", { template: NTC.combined_ms2, every_loan: true, delivered_at_settlement: true, delivered_on: civil(ms2.delivered_at!), timer: TIMER.combined_ms2_15, basis: "§1024.33(b)(3)(iii): notices of transfer provided at settlement satisfy the timing requirements" }, actor);
    combined_ms2 = { timer: TIMER.combined_ms2_15, satisfied_at_settlement: true, basis: "§1024.33(b)(3)(iii)", event: e };
  }
  const missing_required = items.filter((x) => x.required && x.in_package && !x.receipt_evidence).map((x) => x.notice_code);
  const status: PackageStatus = missing_required.length ? "delivered" : "evidenced";
  const next: ClosingNoticeRun = { ...run, items, status, gates: { ...run.gates, ...(privacy_gate ? { [TIMER.privacy_gate]: privacy_gate.result === "open" ? { open: true } : { open: false, reason: `missing ${privacy_gate.missing_borrower_ids.join(", ")}` } } : {}) } };
  append(events, run, "notice.closing_package.evidenced", { run_id: run.run_id, status, manifest_document_id: ev.manifest_document_id, items: items.filter((x) => x.in_package).map((x) => ({ notice_code: x.notice_code, delivered_at: x.delivered_at, receipt_evidence: x.receipt_evidence, document_id: x.rendered_document_id })), missing_required, initial_statement_delivered_at: escrow_account?.initial_statement_delivered_at ?? null }, actor);
  return { run: next, escrow_account, escrow_statement_sent, privacy_gate, combined_ms2, missing_required };
}

// ============================================================ payment address at closing (RESPA §1024.33(b)) — T12
export function paymentAddressAtClosing(i: { payee_named: "sm_as_servicer_for_partner" | "partner_own_address" }): { payment_address_named_at_closing: boolean; combined_ms2_required: boolean; template: string | null; timer: typeof TIMER.combined_ms2_15 | null; basis: string } {
  if (i.payee_named === "sm_as_servicer_for_partner") return { payment_address_named_at_closing: true, combined_ms2_required: false, template: null, timer: null, basis: "note 'Place of Payment', CD contact page and first-payment letter all name 'Supermortgage, as servicer for [Partner]' — no §1024.33(b) transfer (25.4-Q4)" };
  return { payment_address_named_at_closing: false, combined_ms2_required: true, template: NTC.combined_ms2, timer: TIMER.combined_ms2_15, basis: "partner's own address named as payee at closing → servicing 1.3's combined MS-2 delivered at settlement (§1024.33(b)(3)(iii)); 60-day misdirected-payment protection armed by 1.3" };
}

// ============================================================ post-closing run and the first-payment letter clocks
export interface LetterDeadlines { readonly due_5bd: PlainDate; readonly predue_20: PlainDate; readonly post_closing_run_due: PlainDate; readonly send_no_later_than: PlainDate; readonly timers: { readonly [TIMER.letter_5bd]: PlainDate; readonly [TIMER.letter_predue_20]: PlainDate; readonly [TIMER.post_closing_run]: PlainDate }; }
/** SM_O64_FIRST_PAYMENT_LETTER_5BD = disbursement + 5 business_days_servicer; PREDUE_20 = first payment − 20 calendar days; POST_CLOSING_NOTICE_RUN_2BD = disbursement + 2 business_days_servicer (worked examples 1–2: Nov 19 / Dec 12 / Nov 16; purchase: Nov 27 with Thanksgiving excluded). */
export function firstPaymentLetterDeadlines(disbursementDate: PlainDate, firstPaymentDate: PlainDate, cals: CalendarSet = defaultCalendars): LetterDeadlines {
  need(isDate(disbursementDate) && isDate(firstPaymentDate), "disbursement_date and first_payment_date must be ISO dates");
  need(firstPaymentDate > disbursementDate, "the first payment date follows disbursement");
  const due_5bd = addBusinessDays(disbursementDate, 5, cals.business_days_servicer ?? servicer); const predue_20 = addDays(firstPaymentDate, -20); const run = addBusinessDays(disbursementDate, 2, cals.business_days_servicer ?? servicer);
  const send_no_later_than = due_5bd < predue_20 ? due_5bd : predue_20;
  return { due_5bd, predue_20, post_closing_run_due: run, send_no_later_than, timers: { [TIMER.letter_5bd]: due_5bd, [TIMER.letter_predue_20]: predue_20, [TIMER.post_closing_run]: run } };
}
export interface PostClosingRun extends Omit<ClosingNoticeRun, "kind" | "status" | "consistency" | "refusal" | "escrow_statement" | "gates" | "consummation_at" | "property_state" | "cd_version"> { readonly kind: "post_closing"; readonly scheduled_on: PlainDate; readonly deadlines: LetterDeadlines; readonly status: "scheduled" | "sent" | "evidenced"; }
/** At `loan.funded`: the run for funding + 2 servicer business days carrying the welcome letter, the first-payment letter, any state post-closing notice and the initial escrow statement when it was deferred. */
export function schedulePostClosingRun(events: EventStore, i: OriginationKeys & { run_id: string; agent_run_id: string; now: string; disbursement_date: PlainDate; first_payment_date: PlainDate; escrow_statement_deferred: boolean; state_post_closing_codes?: readonly string[]; cd_disclosure_id?: string | null; actor?: Actor; cals?: CalendarSet }): PostClosingRun {
  need(!!i.run_id && !!i.agent_run_id, "run_id and agent_run_id are required");
  const d = firstPaymentLetterDeadlines(i.disbursement_date, i.first_payment_date, i.cals);
  const items: PackageItem[] = [
    item({ notice_code: NTC.welcome, owner_process: "30.2", required: true, in_package: false, basis: "welcome letter", after_closing: d.post_closing_run_due }),
    item({ notice_code: NTC.first_payment_letter, owner_process: "30.2", required: true, in_package: false, basis: `first-payment letter — send by ${d.send_no_later_than} (${TIMER.letter_5bd} ${d.due_5bd}; ${TIMER.letter_predue_20} ${d.predue_20}); autopay enrollment offer optional, never a condition (§1005.10(e)(1))`, gate: TIMER.letter_5bd, after_closing: d.post_closing_run_due }),
    ...(i.state_post_closing_codes ?? []).map((c) => item({ notice_code: c, owner_process: "25.4", required: true, in_package: false, basis: "state post-closing notice (jurisdiction_rules.post_closing_notices)", after_closing: d.post_closing_run_due })),
    ...(i.escrow_statement_deferred ? [item({ notice_code: NTC.initial_escrow_stmt, owner_process: "3.1", required: true, in_package: false, basis: `initial escrow statement not delivered at settlement — 3.1's ${TIMER.regx_17g_45}`, after_closing: d.post_closing_run_due })] : []),
  ];
  const run: PostClosingRun = { run_id: i.run_id, application_id: i.application_id, loan_id: i.loan_id ?? null, kind: "post_closing", composed_at: i.now, cd_disclosure_id: i.cd_disclosure_id ?? null, items, status: "scheduled", agent_run_id: i.agent_run_id, scheduled_on: d.post_closing_run_due, deadlines: d };
  append(events, i, "first_payment_letter.due_computed", { disbursement_date: i.disbursement_date, first_payment_date: i.first_payment_date, due_5bd: d.due_5bd, predue_20: d.predue_20, send_no_later_than: d.send_no_later_than, timers: { ...d.timers }, template: NTC.first_payment_letter }, i.actor ?? DISCLOSURE_AGENT);
  append(events, i, "notice.post_closing_run.scheduled", { run_id: run.run_id, scheduled_on: run.scheduled_on, due_on: d.post_closing_run_due, timer: TIMER.post_closing_run, items: items.map((x) => x.notice_code) }, i.actor ?? DISCLOSURE_AGENT);
  return run;
}
/** The run's completion (every item sent with a mailing/e-delivery manifest) satisfies SM_O64_POST_CLOSING_NOTICE_RUN_2BD. */
export function completePostClosingRun(events: EventStore, run: PostClosingRun, c: { completed_on: PlainDate; sent: readonly { notice_code: string; sent_on: PlainDate; channel: "mail" | "edelivery"; manifest_id: string }[]; actor?: Actor }): PostClosingRun {
  need(isDate(c.completed_on) && Array.isArray(c.sent), "completed_on and sent[] are required");
  const missing = run.items.filter((x) => x.required && !c.sent.some((s) => s.notice_code === x.notice_code)).map((x) => x.notice_code);
  need(missing.length === 0, `post-closing run incomplete: ${missing.join(", ")} not sent (sev 3; retry)`);
  const items = run.items.map((x) => { const s = c.sent.find((e) => e.notice_code === x.notice_code); return s ? { ...x, delivered_at: `${s.sent_on}T00:00:00.000Z`, channel: s.channel, rendered_document_id: s.manifest_id } : x; });
  const next: PostClosingRun = { ...run, items, status: "sent" };
  append(events, run, "notice.post_closing_run.completed", { run_id: run.run_id, completed_on: c.completed_on, on_time: c.completed_on <= run.deadlines.post_closing_run_due, due_on: run.deadlines.post_closing_run_due, items: c.sent.map((s) => ({ notice_code: s.notice_code, sent_on: s.sent_on, channel: s.channel, manifest_id: s.manifest_id })) }, c.actor ?? DISCLOSURE_AGENT);
  return next;
}
/** Reg E §1005.10(e)(1): the first-payment letter's autopay offer may never pre-check enrollment or state that enrollment is required. */
export const AUTOPAY_CONDITION_TEXT = new RegExp(AUTOPAY_CONDITION_PATTERN, "i");
export interface LetterValidation { readonly passed: boolean; readonly violations: readonly { rule_id: string; citation: string; message: string }[]; }
export function validateFirstPaymentLetterAutopay(renderedText: string, payload: { autopay_prechecked?: boolean; autopay_required?: boolean }): LetterValidation {
  const v: { rule_id: string; citation: string; message: string }[] = [];
  if (payload.autopay_prechecked === true) v.push({ rule_id: "rege-1005-10e1-no-precheck", citation: "12 CFR 1005.10(b), (e)(1)", message: "autopay enrollment is pre-checked — a preauthorized transfer is authorized only by a writing signed or similarly authenticated by the consumer" });
  if (payload.autopay_required === true || AUTOPAY_CONDITION_TEXT.test(renderedText)) v.push({ rule_id: "rege-1005-10e1-no-condition", citation: "12 CFR 1005.10(e)(1)", message: "the letter states or implies that autopay enrollment is required — no person may condition an extension of credit on repayment by preauthorized electronic fund transfers" });
  if (!/optional/i.test(renderedText) || !/not a condition/i.test(renderedText)) v.push({ rule_id: "rege-1005-10e1-optional-stated", citation: "12 CFR 1005.10(e)(1); 25.4 first-payment letter content", message: "the autopay offer must state that enrollment is optional and not a condition of the loan" });
  return { passed: v.length === 0, violations: v };
}
export interface FirstPaymentLetterFigures { readonly pi_cents: Cents; readonly escrow_cents: Cents; readonly mi_cents: Cents; }
/** Worked example 3: statement total payment $3,402.62 + $525.00 = $3,927.62 = first-payment letter amount = note P&I + escrow (+ MI). */
export function firstPaymentLetterAmount(f: FirstPaymentLetterFigures): { total_cents: Cents; breakdown_sum_cents: Cents } { const total = f.pi_cents + f.escrow_cents + f.mi_cents; return { total_cents: total, breakdown_sum_cents: total }; }
/** The payload the authored NTC_SM_FIRST_PAYMENT_LETTER version renders (30.2's rule-9 checklist (a)–(m) runs over the rendered text; the B-1 sentence is 8.1's MODEL_B1 verbatim). */
export function firstPaymentLetterPayload(p: { servicer_name?: string; partner_name: string; servicing_loan_number: string; property_address: string; borrower_names: readonly string[]; first_payment_date: PlainDate; figures: FirstPaymentLetterFigures; remittance_address: string; portal_url: string; servicer_phone: string; contact_hours: string; automation_disclosure: string; late_charge_pct: string; late_charge_grace_days: number; escrow_summary: string; initial_escrow_statement_pointer: string; esign_invitation: boolean; privacy_reference: string; hud_cfpb_block: string; acp_or_successor_handling?: string | null; arm_first_change_date?: PlainDate | null; language_preference?: string | null; account_last4: string }): Record<string, unknown> {
  need(!!p.partner_name && !!p.servicing_loan_number && !!p.property_address && p.borrower_names.length > 0 && isDate(p.first_payment_date), "partner_name, servicing_loan_number, property_address, borrower_names and first_payment_date are required");
  const a = firstPaymentLetterAmount(p.figures);
  return { servicer_name: p.servicer_name ?? "Supermortgage", partner_name: p.partner_name, servicing_loan_number: p.servicing_loan_number, property_address: p.property_address, borrower_names: [...p.borrower_names], first_payment_date: p.first_payment_date,
    pi_cents: p.figures.pi_cents, escrow_cents: p.figures.escrow_cents, mi_cents: p.figures.mi_cents, has_mi: p.figures.mi_cents > 0n, total_cents: a.total_cents, breakdown_sum_cents: a.breakdown_sum_cents,
    remittance_address: p.remittance_address, payee_line: `Supermortgage, as servicer for ${p.partner_name}`, portal_url: p.portal_url, servicer_phone: p.servicer_phone, contact_hours: p.contact_hours, automation_disclosure: p.automation_disclosure, autopay_prechecked: false, autopay_required: false,
    late_charge_pct: p.late_charge_pct, late_charge_grace_days: p.late_charge_grace_days, escrow_summary: p.escrow_summary, initial_escrow_statement_pointer: p.initial_escrow_statement_pointer, not_a_transfer_notice: true, b1_text: MODEL_B1, esign_invitation: p.esign_invitation,
    privacy_reference: p.privacy_reference, hud_cfpb_block: p.hud_cfpb_block, acp_or_successor_handling: p.acp_or_successor_handling ?? null, arm_first_change_date: p.arm_first_change_date ?? null, language_preference: p.language_preference ?? null, account_last4: p.account_last4 };
}

// ============================================================ §1026.39 ownership transfer (`evaluateOwnershipTransfer`, `renderOwnershipNotice`)
export type CoveredPerson = "fannie_mae" | "sm_warehouse_assignee" | "other";
export type DateBasis = "acquirer_books" | "transferor_books";
export type OwnershipSender = "covered_person_direct" | "servicer_on_behalf";
export type OwnershipStatus = "not_applicable" | "expected" | "sent" | "evidenced" | "exception_c1" | "exception_c2" | "exception_c3" | "overdue_unconfirmed";
export interface OwnershipTransferNotice { readonly otn_id: string; readonly loan_id: string; readonly covered_person: CoveredPerson; readonly date_of_transfer: PlainDate; readonly date_basis: DateBasis; readonly due_date: PlainDate; readonly sender: OwnershipSender; readonly notice_id: string | null; readonly sent_at: string | null; readonly evidence_document_id: string | null; readonly status: OwnershipStatus; readonly evidence_due: PlainDate | null; readonly must_send: boolean; readonly send_scheduled_on: PlainDate | null; readonly rationale: string; }
export interface OwnershipInput extends OriginationKeys {
  readonly otn_id: string; readonly loan_id: string; readonly covered_person: CoveredPerson; readonly date_basis?: DateBasis;
  /** Fannie Mae: the purchase advice date (acquirer's books). SM assignee: the funding-date assignment. */
  readonly acquisition_date: PlainDate; readonly transferor_books_date?: PlainDate | null; readonly written_fnma_instruction_on_file?: boolean;
  /** For the assignee branch: the date the loan was sold on (exception (c)(1) when ≤ day 30), else null while unsold. */
  readonly sold_on?: PlainDate | null; readonly as_of: PlainDate; readonly repurchase_agreement?: boolean; readonly partial_interest_same_agent?: boolean; readonly warehouse_legal_form?: "secured_loan_to_partner" | "assignment_at_funding"; readonly actor?: Actor;
}
/** §1026.39(b)(1): "on or before the 30th calendar day following the date of transfer" — calendar days, no holiday or weekend adjustment (Nov 25 → Dec 25, Christmas Day). */
export const ownershipNoticeDueDate = (dateOfTransfer: PlainDate): PlainDate => addDays(dateOfTransfer, 30);
/** Fannie Mae writes its own purchase letter: the platform records the expectation, keeps servicer data accurate and evidences; it sends on Fannie Mae's behalf only with a written instruction on file; SM is a covered person only under an assignment structure (a security interest is not — comment 39(a)(1)-3.i). */
export function evaluateOwnershipTransfer(events: EventStore, i: OwnershipInput): { row: OwnershipTransferNotice; event: DomainEvent | null } {
  need(!!i.otn_id && !!i.loan_id && isDate(i.acquisition_date) && isDate(i.as_of), "otn_id, loan_id, acquisition_date and as_of are required");
  const basis: DateBasis = i.date_basis ?? "acquirer_books";
  need(basis === "acquirer_books" || isDate(i.transferor_books_date), "transferor_books basis needs the transferor's books-and-records date (§1026.39(b)(2))");
  const date_of_transfer = basis === "acquirer_books" ? i.acquisition_date : i.transferor_books_date!;
  const due_date = ownershipNoticeDueDate(date_of_transfer);
  const actor = i.actor ?? DISCLOSURE_AGENT;
  const base = { otn_id: i.otn_id, loan_id: i.loan_id, covered_person: i.covered_person, date_of_transfer, date_basis: basis, due_date, notice_id: null, sent_at: null, evidence_document_id: null };
  if (i.covered_person === "sm_warehouse_assignee") {
    if ((i.warehouse_legal_form ?? "assignment_at_funding") === "secured_loan_to_partner") {
      const row: OwnershipTransferNotice = { ...base, sender: "covered_person_direct", status: "not_applicable", evidence_due: null, must_send: false, send_scheduled_on: null, rationale: "SM holds a security interest, never legal title (origination.warehouse_legal_form = secured_loan_to_partner) — not a covered person (comment 39(a)(1)-3.i)" };
      return { row, event: null };
    }
    if (i.sold_on && i.sold_on <= due_date) {
      const row: OwnershipTransferNotice = { ...base, sender: "covered_person_direct", status: "exception_c1", evidence_due: null, must_send: false, send_scheduled_on: null, rationale: `§1026.39(c)(1): legal title transferred ${i.sold_on}, on or before the 30th calendar day (${due_date}) following the ${date_of_transfer} acquisition — no disclosure` };
      const event = append(events, i, "ownership_transfer.notice.expected", { otn_id: i.otn_id, covered_person: i.covered_person, date_of_transfer, date_basis: basis, due_date, sender: row.sender, status: row.status, exception: "(c)(1)", sold_on: i.sold_on }, actor);
      return { row, event };
    }
    const row: OwnershipTransferNotice = { ...base, sender: "covered_person_direct", status: "expected", evidence_due: null, must_send: true, send_scheduled_on: due_date, rationale: `SM acquired legal title at funding ${date_of_transfer} and the loan is unsold on ${i.as_of}: ${NTC.ownership_transfer} must be sent on or before ${due_date} (§1026.39(b)(1))` };
    const event = append(events, i, "ownership_transfer.notice.expected", { otn_id: i.otn_id, covered_person: i.covered_person, date_of_transfer, date_basis: basis, due_date, sender: row.sender, status: row.status, must_send: true, template: NTC.ownership_transfer, timer: TIMER.ownership_30 }, actor);
    return { row, event };
  }
  if (i.repurchase_agreement) { const row: OwnershipTransferNotice = { ...base, sender: "covered_person_direct", status: "exception_c2", evidence_due: null, must_send: false, send_scheduled_on: null, rationale: "§1026.39(c)(2): transfer in connection with a repurchase agreement" }; return { row, event: null }; }
  if (i.partial_interest_same_agent) { const row: OwnershipTransferNotice = { ...base, sender: "covered_person_direct", status: "exception_c3", evidence_due: null, must_send: false, send_scheduled_on: null, rationale: "§1026.39(c)(3): partial interest; the agent for rescission notices and payment issues does not change" }; return { row, event: null }; }
  const sender: OwnershipSender = i.written_fnma_instruction_on_file === true ? "servicer_on_behalf" : "covered_person_direct";
  const evidence_due = addDays(i.acquisition_date, 45);
  const send_scheduled_on = sender === "servicer_on_behalf" ? addBusinessDays(due_date, -1, servicer) : null;   // last business day before the due date; a Saturday mailing would also be lawful (calendar days)
  const row: OwnershipTransferNotice = { ...base, sender, status: "expected", evidence_due, must_send: sender === "servicer_on_behalf", send_scheduled_on,
    rationale: sender === "covered_person_direct" ? `Fannie Mae (covered person, legal title at purchase ${i.acquisition_date}) sends its own loan purchase letter on or before ${due_date}; the platform records the expectation, primes the portal explainer and evidences by ${evidence_due} (${TIMER.fnma_evidence_45})` : `written Fannie Mae instruction on file: SM sends ${NTC.ownership_transfer} on Fannie Mae's behalf on or before ${due_date} (scheduled ${send_scheduled_on})` };
  const event = append(events, i, "ownership_transfer.notice.expected", { otn_id: i.otn_id, covered_person: i.covered_person, date_of_transfer, date_basis: basis, purchase_date: i.acquisition_date, due_date, sender, status: "expected", evidence_due, must_send: row.must_send, send_scheduled_on, timer: TIMER.ownership_30, evidence_timer: TIMER.fnma_evidence_45, render_notice: false }, actor);
  return { row, event };
}
export interface CoveredPersonContact { readonly name: string; readonly address: string; readonly phone: string; readonly source: "fnma_written_instruction" | "sm_legal_entity" | "generated"; readonly email?: string | null; readonly web?: string | null; }
export interface OwnershipNoticeInput { readonly row: OwnershipTransferNotice; readonly covered_person_contact: CoveredPersonContact; readonly agent: { name: string; address: string; phone: string; email: string; portal_url: string; on_behalf_of: string }; readonly mers_registered: boolean; readonly county_recorder: string | null; readonly borrower_names: readonly string[]; readonly property_address: string; readonly loan_number: string; readonly written_fnma_instruction_on_file?: boolean; }
/** (d)(1)–(d)(5) payload for NTC_REGZ_1026_39_OWNERSHIP_TRANSFER; refused while the row is `expected` under Fannie Mae's own sending (30.4's rule), when SM would send in Fannie Mae's name without a written instruction, or when the covered person's contact details are not sourced. */
export function renderOwnershipNotice(i: OwnershipNoticeInput): { template: typeof NTC.ownership_transfer; payload: Record<string, unknown>; send_by: PlainDate } {
  const r = i.row;
  need(r.must_send, `no fallback notice: ${r.covered_person} / ${r.sender} / ${r.status} — ${r.rationale}`);
  if (r.covered_person === "fannie_mae") {
    need(r.sender === "servicer_on_behalf" && i.written_fnma_instruction_on_file === true, "never send a §1026.39 notice in Fannie Mae's name without a written Fannie Mae instruction on file");
    need(ownershipNoticeMayRender(r.sender === "servicer_on_behalf" ? "sent_by_sm" : "expected", r.sender), "30.4: never render the fallback template while the row is expected under Fannie Mae's own sending");
    need(i.covered_person_contact.source === "fnma_written_instruction", "never invent Fannie Mae contact details — (d)(1) data comes from Fannie Mae's instruction");
  } else need(i.covered_person_contact.source === "sm_legal_entity", "the assignee notice names SM's legal entity as the covered person");
  need(!!i.covered_person_contact.name && !!i.covered_person_contact.address && /\d{3}/.test(i.covered_person_contact.phone), "(d)(1): name, address and telephone number of the covered person");
  const recording_statement = i.mers_registered ? `The transfer of ownership of your loan has not been recorded in public records at the time this notice is provided.${i.county_recorder ? ` It may later be recorded with the ${i.county_recorder}.` : ""}` : `The transfer of ownership of your loan is or may be recorded in public records with the ${i.county_recorder ?? "county recorder"}.`;
  return { template: NTC.ownership_transfer, send_by: r.due_date, payload: {
    covered_person_name: i.covered_person_contact.name, covered_person_address: i.covered_person_contact.address, covered_person_phone: i.covered_person_contact.phone, covered_person_email: i.covered_person_contact.email ?? null, covered_person_web: i.covered_person_contact.web ?? null, date_of_transfer: r.date_of_transfer, date_basis: r.date_basis,
    agent_name: i.agent.name, agent_address: i.agent.address, agent_phone: i.agent.phone, agent_email: i.agent.email, agent_portal_url: i.agent.portal_url, agent_on_behalf_of: i.agent.on_behalf_of, mers_registered: i.mers_registered, recorded_in_public_records: !i.mers_registered, recording_statement, county_recorder: i.county_recorder,
    partial_payment_policy: "ii", partial_payment_text: "We may hold partial payments in a separate account until you pay the remainder of the payment and then apply the full payment to your loan.", sale_statement: "If this loan is sold, your new lender may have a different policy.",
    fnma_not_servicer: r.covered_person === "fannie_mae" ? "Fannie Mae is not your servicer; send all payments to Supermortgage." : null, borrower_names: [...i.borrower_names], property_address: i.property_address, loan_number: i.loan_number, sender: r.sender, covered_person: r.covered_person, days_to_due: 30 } };
}
export function sendOwnershipNotice(events: EventStore, i: OriginationKeys & { row: OwnershipTransferNotice; notice_id: string; sent_on: PlainDate; channel: "mail" | "edelivery"; esign_scope?: string | null; actor?: Actor }): { row: OwnershipTransferNotice; event: DomainEvent; on_time: boolean } {
  need(i.row.must_send, "the row does not call for a platform send");
  need(isDate(i.sent_on) && !!i.notice_id, "sent_on and notice_id are required");
  need(i.channel === "mail" || i.esign_scope === "servicing_notices", "electronic delivery only under an E-SIGN consent scoped to servicing_notices ((b)(1))");
  const on_time = i.sent_on <= i.row.due_date;
  const row: OwnershipTransferNotice = { ...i.row, notice_id: i.notice_id, sent_at: `${i.sent_on}T00:00:00.000Z`, status: "sent" };
  const event = append(events, i, "ownership_transfer.notice.sent", { otn_id: row.otn_id, template: NTC.ownership_transfer, notice_id: i.notice_id, sender: row.sender, covered_person: row.covered_person, sent_on: i.sent_on, due_date: row.due_date, on_time, channel: i.channel, addressed_to: "all borrowers jointly ((b)(3))" }, i.actor ?? DISCLOSURE_AGENT);
  return { row, event, on_time };
}
/** T14: a borrower call about "a letter from Fannie Mae" is expected evidence — recorded, explained, and a misdirected-payment case is opened only if a payment actually went to Fannie Mae (servicing 2.x). */
export function recordBorrowerReport(events: EventStore, i: OriginationKeys & { row: OwnershipTransferNotice; reported_on: PlainDate; channel: "call" | "portal" | "chat"; payment_sent_to_fnma: boolean; payment_details?: { amount_cents: Cents; sent_on: PlainDate } | null; actor?: Actor }): { row: OwnershipTransferNotice; event: DomainEvent; script: readonly string[]; misdirected_payment_case: { kind: "misdirected_payment"; owner_process: "2.x"; amount_cents: Cents; sent_on: PlainDate } | null; on_time: boolean } {
  need(isDate(i.reported_on), "reported_on is required");
  const on_time = i.row.evidence_due ? i.reported_on <= i.row.evidence_due : true;
  const row: OwnershipTransferNotice = { ...i.row, status: "evidenced", evidence_document_id: i.row.evidence_document_id ?? `borrower-report:${i.reported_on}` };
  const event = append(events, i, "ownership_transfer.notice.evidenced", { otn_id: row.otn_id, evidence: "borrower_report", kind: "borrower_report", channel: i.channel, evidenced_on: i.reported_on, due_date: i.row.due_date, evidence_due: i.row.evidence_due, on_time, status: "evidenced", payment_sent_to_fnma: i.payment_sent_to_fnma }, i.actor ?? DISCLOSURE_AGENT);
  const script = ["This interaction is automated; you can ask for a person at any time.", "The letter is expected: Fannie Mae bought your loan and is required to notify you. It is informational — no action is required.", "Nothing about your loan terms changes. Fannie Mae is not your servicer.", "Keep sending your payments to Supermortgage, as servicer for your lender, at the payment address on your note and first-payment letter."];
  const misdirected = i.payment_sent_to_fnma ? (() => { need(!!i.payment_details, "a payment sent to Fannie Mae needs amount_cents and sent_on for the 2.x misdirected-payment case"); return { kind: "misdirected_payment" as const, owner_process: "2.x" as const, amount_cents: i.payment_details!.amount_cents, sent_on: i.payment_details!.sent_on }; })() : null;
  return { row, event, script, misdirected_payment_case: misdirected, on_time };
}
/** Day 45 without evidence → `overdue_unconfirmed`; inquiry to Fannie Mae's account team; no consumer action. */
export function ownershipOverdue(row: OwnershipTransferNotice, asOf: PlainDate): OwnershipTransferNotice { return row.status === "expected" && row.evidence_due && asOf > row.evidence_due ? { ...row, status: "overdue_unconfirmed" } : row; }

// ============================================================ Form 1098 seeds (`tax_reporting_seeds` → servicing 7.1-A)
export interface TaxReportingSeeds { readonly loan_id: string; readonly origination_date: PlainDate; readonly principal_at_origination_cents: Cents; readonly prepaid_interest_cents: Cents; readonly prepaid_interest_period: { from: PlainDate; to: PlainDate; days: number }; readonly points_paid_cents: Cents; readonly points_seller_paid_cents: Cents; readonly points_refinance_excluded_cents: Cents; readonly mi_premiums_paid_at_closing_cents: Cents; readonly property_address_id: string; readonly payer_of_record_borrower_id: string; readonly acquisition_date: null; readonly source_cd_disclosure_id: string; readonly handed_off_at: string | null; readonly tax_year: number; readonly box1_candidate_cents: Cents; readonly box6_candidate_cents: Cents; readonly seeds_hash: string; }
/** rate% × principal × days / 365, rounded half-up at the end (spec: 19 days at $93.9726/day = $1,785.48; 12 days × $71.9589 = $863.51). */
export function prepaidInterestCents(principalCents: Cents, ratePct: string, days: number): Cents {
  need(typeof ratePct === "string" && /^\d+(\.\d+)?$/.test(ratePct) && Number.isInteger(days) && days >= 0, "ratePct (decimal string) and integer days are required");
  const [ip, fp = ""] = ratePct.split("."); const scale = 10n ** BigInt(fp.length); const rate = BigInt(ip + fp);
  const num = principalCents * rate * BigInt(days); const den = scale * 100n * 365n;
  return (2n * num + den) / (2n * den);
}
/** The unrounded per diem in dollars to four decimals (spec: $93.9726 / $71.9589) — the closing-year interest is rounded once, at the end, never per day (26.3's rounded per-diem convention is the funding figure, 25.1's the APR one). */
export const perDiemCentsUnrounded = (principalCents: Cents, ratePct: string): string => { const c = prepaidInterestCents(principalCents * 10000n, ratePct, 1) / 100n; return `${(c / 10000n).toString()}.${(c % 10000n).toString().padStart(4, "0")}`; };
/** Box 6 points: purchase of the payer's principal residence, designated as points on the CD, computed as a % of principal, borrower-paid (seller-paid treated as paid by the payer); refinance points are never Box 6 ("Do not report as points … For refinancing"). */
export function pointsSeed(i: { transaction_type: "purchase" | "refinance"; principal_cents: Cents; points_pct: string | null; borrower_paid_cents: Cents; seller_paid_cents?: Cents; designated_as_points_on_cd: boolean; principal_residence: boolean }): { points_paid_cents: Cents; points_seller_paid_cents: Cents; points_refinance_excluded_cents: Cents; box6_eligible: boolean; normalized_cd_label: string | null } {
  const seller = i.seller_paid_cents ?? 0n; const total = i.borrower_paid_cents + seller;
  if (i.transaction_type === "refinance") return { points_paid_cents: 0n, points_seller_paid_cents: 0n, points_refinance_excluded_cents: total, box6_eligible: false, normalized_cd_label: null };
  const pctOk = !!i.points_pct && /^\d+(\.\d+)?$/.test(i.points_pct) && prepaidInterestCents(i.principal_cents * 365n, i.points_pct, 1) === total;
  const eligible = i.designated_as_points_on_cd && i.principal_residence && pctOk && total > 0n;
  return { points_paid_cents: eligible ? total : 0n, points_seller_paid_cents: eligible ? seller : 0n, points_refinance_excluded_cents: 0n, box6_eligible: eligible, normalized_cd_label: eligible ? `Discount Points (${Number(i.points_pct).toFixed(3)}%)` : null };
}
export function seedTaxReporting(i: { loan_id: string; note_date: PlainDate; disbursement_date: PlainDate; first_period_end: PlainDate; principal_cents: Cents; note_rate_pct: string; prepaid_interest_cents?: Cents | null; points: Parameters<typeof pointsSeed>[0]; mi_premiums_paid_at_closing_cents: Cents; property_address_id: string; payer_of_record_borrower_id: string; source_cd_disclosure_id: string }): TaxReportingSeeds {
  need(!!i.loan_id && isDate(i.note_date) && isDate(i.disbursement_date) && isDate(i.first_period_end) && i.principal_cents > 0n && !!i.source_cd_disclosure_id && !!i.payer_of_record_borrower_id && !!i.property_address_id, "loan_id, note_date, disbursement_date, first_period_end, principal_cents, payer_of_record_borrower_id, property_address_id and source_cd_disclosure_id are required");
  const days = Math.round((Date.parse(i.first_period_end) - Date.parse(i.disbursement_date)) / 86_400_000) + 1;
  need(days >= 0 && days <= 62, `prepaid interest period ${i.disbursement_date}–${i.first_period_end} (${days} days) is not an odd-days period`);
  const prepaid = i.prepaid_interest_cents ?? prepaidInterestCents(i.principal_cents, i.note_rate_pct, days);
  const pts = pointsSeed(i.points);
  const seeds = { loan_id: i.loan_id, origination_date: i.note_date, principal_at_origination_cents: i.principal_cents, prepaid_interest_cents: prepaid, prepaid_interest_period: { from: i.disbursement_date, to: i.first_period_end, days }, points_paid_cents: pts.points_paid_cents, points_seller_paid_cents: pts.points_seller_paid_cents, points_refinance_excluded_cents: pts.points_refinance_excluded_cents,
    mi_premiums_paid_at_closing_cents: i.mi_premiums_paid_at_closing_cents, property_address_id: i.property_address_id, payer_of_record_borrower_id: i.payer_of_record_borrower_id, acquisition_date: null as null, source_cd_disclosure_id: i.source_cd_disclosure_id, handed_off_at: null, tax_year: Number(i.disbursement_date.slice(0, 4)), box1_candidate_cents: prepaid, box6_candidate_cents: pts.points_paid_cents };
  return { ...seeds, seeds_hash: sha(seeds) };
}
/** SM_O64_1098_SEEDS_AT_BOARDING_GATE: the complete row handed to 7.1-A at `loan.boarded` (`tax_reporting.seeds.handed_off`). */
export function handoffTaxReportingSeeds(events: EventStore, i: OriginationKeys & { seeds: TaxReportingSeeds; handed_off_at: string; actor?: Actor }): { seeds: TaxReportingSeeds; event: DomainEvent; gate_open: true } {
  need(typeof i.handed_off_at === "string" && i.handed_off_at.length >= 10, "handed_off_at is required");
  const s = i.seeds; need(!!s.loan_id && isDate(s.origination_date) && s.principal_at_origination_cents > 0n && s.acquisition_date === null && !!s.source_cd_disclosure_id, "tax_reporting_seeds row incomplete — the gate stays closed (boarding checklist item fails, 30.2)");
  const seeds: TaxReportingSeeds = { ...s, handed_off_at: i.handed_off_at };
  const event = append(events, { application_id: i.application_id, loan_id: s.loan_id }, "tax_reporting.seeds.handed_off", { loan_id: s.loan_id, origination_date: s.origination_date, principal_at_origination_cents: s.principal_at_origination_cents.toString(), prepaid_interest_cents: s.prepaid_interest_cents.toString(), points_paid_cents: s.points_paid_cents.toString(), mi_premiums_paid_at_closing_cents: s.mi_premiums_paid_at_closing_cents.toString(), acquisition_date: null, tax_year: s.tax_year, seeds_hash: s.seeds_hash, handed_off_at: i.handed_off_at, gate: TIMER.seeds_gate, consumer: "7.1-A" }, i.actor ?? BOARDING_AGENT);
  return { seeds, event, gate_open: true };
}

// ============================================================ decision record (`writeDecision`)
export function decisionRecord(i: { run_id: string; cd_disclosure_id: string | null; items: readonly PackageItem[]; gates: Record<string, { open: boolean; reason?: string }>; consistency: CdEscrowConsistency | null; escrow_election: EscrowElection | null; ownership_transfer: OwnershipTransferNotice | null; seeds: TaxReportingSeeds | null; rationale: string; model_version: string; prompt_version: string; confidence?: number }): Record<string, unknown> {
  need(!!i.run_id && !!i.rationale && !!i.model_version && !!i.prompt_version, "run_id, rationale, model_version and prompt_version are required");
  return { run_id: i.run_id, cd_disclosure_id: i.cd_disclosure_id, items: i.items.map((x) => ({ notice_code: x.notice_code, required: x.required, in_package: x.in_package, receipt_evidence: x.receipt_evidence })),
    gates: { glba: i.gates[TIMER.privacy_gate] ?? null, hpa: i.gates["HPA_4903_INITIAL_DISCLOSURE_GATE"] ?? null, flood: i.gates["FDPA_4104A_FLOOD_NOTICE_GATE"] ?? null, escrow_stmt: i.gates[TIMER.escrow_stmt] ?? null, state: [TIMER.ut_gate, TIMER.ca_gate].filter((g) => i.gates[g]).map((g) => ({ gate: g, ...i.gates[g]! })) },
    consistency_results: i.consistency ? { check_code: i.consistency.check.check_code, result: i.consistency.result, corrected_cd: i.consistency.corrected_cd } : null,
    escrow_election: i.escrow_election ? { election: i.escrow_election.election, policy: i.escrow_election.waiver_policy_version, reasons: i.escrow_election.reasons } : null,
    ownership_transfer: i.ownership_transfer ? { covered_person: i.ownership_transfer.covered_person, date_of_transfer: i.ownership_transfer.date_of_transfer, due_date: i.ownership_transfer.due_date, sender: i.ownership_transfer.sender, status: i.ownership_transfer.status } : null,
    seeds_hash: i.seeds?.seeds_hash ?? null, rationale: i.rationale, model_version: i.model_version, prompt_version: i.prompt_version, confidence: i.confidence ?? null, rule_set_version: RULE_SET_25_4 };
}
