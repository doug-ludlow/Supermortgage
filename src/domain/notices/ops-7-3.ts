/**
 * §7.3 process ops — the ARM initial (§1026.20(d)) adjustment notice as the code paths that append the loan events
 * the 7.3 registry rows arm on and close on. The engines (arm.ts) and the pure rules (ops.ts: `initialNoticeIndexHold`,
 * `transferInInitialNotice`, `stateHfaContact`, `correctedInitialNotice`, `composeEnvelope`) stay pure; this module
 * reads the boarded `loan_terms` / `arm_schedule` (7.2, ops-7-2), the `arm_index_captures` and the event log, runs them,
 * and records what happened. bigint cents; PlainDate; the LLM never computes rates or payments.
 *
 *   - `openInitialFileCheck`        the 7.3 handler for `loan.boarded` (spec inputs: "inside/after the window → immediate
 *                                   assessment"): an ARM within 300 days of its first new payment appends
 *                                   `arm.initial_notice.file_check_opened{boarded_on, within_300_days=true}` — arms
 *                                   SM_ARM_INITIAL_FILE_CHECK_T0 (+5 business_days_servicer from the boarding date).
 *   - `determineInitialNoticeStatus` rule 1 + edge "Boarded after T−210": `exempt_short_term` (≤ 1-year term) /
 *                                   `originator_duty` (first adjusted payment ≤ 210 days from consummation; the file's
 *                                   `arm_initial_disclosure_consummation` document) / `transferor_evidenced` (an attached
 *                                   transferor (d) notice — the agent guardrail) / `late` (boarded after T−210 with no
 *                                   evidence: send within 5 business days, breach attributable to the transferor) /
 *                                   `scheduled`. Appends `arm.initial_notice.status_determined{status}` (closes the file
 *                                   check) and the spec's specific event; the closing ones carry `satisfies_timer=true`.
 *   - `openInitialNoticeWindow`     rule 2: `arm.initial_notice.window_opened` at `first_new_payment_due − 240` (closes
 *                                   the −240 gate; the −210 deadline runs from the schedule row).
 *   - `requestInitialNoticeRender`  rule 3: the latest index on/before the disclosure date, its age in servicer business
 *                                   days, the estimate (engine A on the F-1-01 expected UPB and remaining term) →
 *                                   `arm.initial_notice.render_requested{index_age_business_days}` (arms the 15-business-
 *                                   day recency gate, whose evaluator this function asserts) → `…render_held` or
 *                                   `…estimated` + an `arm_initial_estimates` row.
 *   - `sendInitialNotice`           rules 2/4/5: window check (blocked before T−240; a send after T−210 is the sev-1
 *                                   breach, recorded and still sent), `notice.render_requested{template, separate_document}`
 *                                   (the separate-document gate, asserted here), content assembly (schedule sentence,
 *                                   index/source, caps/floor, balance/term, no prepayment penalty, toll-free number, the
 *                                   four alternatives, CFPB/HUD/state HFA), the Notice Registry render → checklist → send
 *                                   (`notice.sent{template=NTC_REGZ_20D_ARM_INITIAL}`), then `arm.initial_notice.sent
 *                                   {satisfies_timer=true}`; refuses a duplicate on a transferor-evidenced / originator /
 *                                   exempt loan.
 *   - `correctInitialNoticeTerms`   rule 6 / T9: `loan.terms.corrected` after a send → a corrected (d) notice when still
 *                                   ≥ 210 days out (re-estimate, `corrected=true`), otherwise the (c) notice carries the
 *                                   correct figures and the discrepancy is documented.
 *   - `cancelInitialNotice`         edge "Loan pays off/transfers before the first change date: cancel with reason".
 */
import type { DomainEvent } from "../../kernel/events/index.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Recipient, ChannelContext } from "../../notices/channel.ts";
import { newRate, newPayment, initialNoticeWindow, sendCheck, indexDate, selectIndex, type IndexObs } from "./arm.ts";
import { initialNoticeIndexHold, transferInInitialNotice, stateHfaContact, correctedInitialNotice } from "./ops.ts";
import { type OpsDeps, type NoticeSender, type ServicerContact, type ArmTerms, type ArmScheduleRow, type IndexSource, loadTerms, rowId, indexObservations, expectedUpbAt, remainingTermAt, INDEX_DESCRIPTIONS, RULE_SET_VERSION } from "./ops-7-2.ts";
import { EVALUATORS_7_3 } from "./evaluators-7-3.ts";

export const TEMPLATE_D = "NTC_REGZ_20D_ARM_INITIAL" as const;
export const TIMERS_7_3 = { not_before: "REGZ_1026_20D_INITIAL_NOTICE_NOT_BEFORE_240", deadline: "REGZ_1026_20D_INITIAL_NOTICE_210", index_recency: "REGZ_1026_20D_ESTIMATE_INDEX_15BD", file_check: "SM_ARM_INITIAL_FILE_CHECK_T0", separate_document: "SM_ARM_INITIAL_SEPARATE_DOC_GATE" } as const;
export const EVALUATORS = { index_recency: "7.3.indexRecentEnoughForEstimate", separate_document: "7.3.separateDocumentEnforced" } as const;
/** Rule 4 (xi): the CFPB and HUD contacts are fixed; the state HFA comes from `jurisdiction_rules.hfa_contact`. */
export const COUNSELING = { cfpb_url: "consumerfinance.gov", hud_phone: "(800) 569-4287" } as const;
/** Edge "Boarded after T−210": the boarded loan sends within 5 servicer business days; the file check runs on the same clock. */
export const FILE_CHECK_BUSINESS_DAYS = 5;
/** Timer row: "`loan.boarded` (ARM within 300 days of first new payment due)". */
export const FILE_CHECK_HORIZON_DAYS = 300;

/** The Notice Registry service as 7.3 needs it (src/notices/service.ts NoticeService, structurally): the (d) notice's `separate_document` flag comes from the template record. */
export interface NoticeSender7_3 extends NoticeSender { template(code: string): { readonly separateDocument: boolean }; }

export type InitialNoticeStatus = "scheduled" | "window_open" | "estimated" | "held" | "sent" | "awaiting_actual" | "originator_duty" | "exempt_short_term" | "transferor_evidenced" | "late" | "cancelled";
export type InitialBasis = "estimate" | "actual";
export interface TransferorBreachRecord { readonly attributable_to: "transferor"; readonly window_deadline: PlainDate; readonly boarded_on: PlainDate; readonly days_after_deadline: number; readonly claim: "17.3/1.7 transferor claim"; }
/** Data model: the 7.3 fields of the `arm_schedule` initial row and the process state kept beside it (`arm_initial_notices`). */
export interface InitialNoticeState {
  readonly loan_id: string; readonly status: InitialNoticeStatus; readonly first_new_payment_due: PlainDate; readonly change_date: PlainDate;
  readonly initial_notice_window_open: PlainDate; readonly initial_notice_due_by: PlainDate; readonly send_target: PlainDate;
  readonly boarded_on: PlainDate | null; readonly determine_by: PlainDate | null; readonly determined_on: PlainDate | null;
  readonly send_by: PlainDate | null; readonly evidence_document_id: string | null; readonly breach_record: TransferorBreachRecord | null;
  readonly initial_notice_id: string | null; readonly initial_notice_basis: InitialBasis | null; readonly sent_on: PlainDate | null; readonly cancelled_reason: string | null;
  /** Rule 3 hold reason while the recency gate is closed (null once a fresh index is captured). */
  readonly render_hold: string | null;
}
export interface InitialEstimate {
  readonly loan_id: string; readonly disclosure_date: PlainDate; readonly index_effective_date: PlainDate; readonly index_value: string; readonly index_capture_id: string; readonly index_source: IndexSource;
  readonly est_rate_pct: string; readonly unrounded_pct: string; readonly est_pi_cents: Cents; readonly expected_upb_cents: Cents; readonly remaining_term_months: number; readonly is_estimate: boolean; readonly notice_id: string | null; readonly terms_version: number;
}

// ---- helpers -------------------------------------------------------------------------------------------------------
const today = (deps: OpsDeps): PlainDate => wallClock(Date.parse(deps.now), "America/New_York").date;
const put = (deps: OpsDeps, kind: string, id: string, data: Record<string, unknown>): void => { deps.store.put(kind, id, data, deps.actor, deps.now); };
const append = (deps: OpsDeps, type: string, loanId: string, payload: Record<string, unknown>, causationId?: string): DomainEvent =>
  deps.events.append({ type, loanId, actor: deps.actor, payload, ...(causationId ? { causationId } : {}) });
const scheduleSentence = (n: number): string => (n === 1 ? "every month thereafter" : n === 6 ? "every six months thereafter" : n === 12 ? "every twelve months thereafter" : `every ${n} months thereafter`);
/** The (d) row: the schedule's first change (`initial = true`, built by ops-7-2 `boardArmTerms`). */
export function initialRow(deps: OpsDeps, loanId: string): ArmScheduleRow {
  const r = deps.store.list("arm_schedule", (d) => d.loan_id === loanId && d.initial === true).map((x) => x.data as unknown as ArmScheduleRow)[0];
  if (!r) throw new RangeError(`no initial arm_schedule row for ${loanId} — board the ARM terms first (7.2)`);
  return r;
}
export function loadState(deps: OpsDeps, loanId: string): InitialNoticeState {
  const s = deps.store.get("arm_initial_notices", loanId)?.data as InitialNoticeState | undefined;
  if (s) return s;
  const terms = loadTerms(deps, loanId); const row = initialRow(deps, loanId); const w = initialNoticeWindow(row.first_new_payment_due, terms.consummation_date, terms.term_months);
  return { loan_id: loanId, status: "scheduled", first_new_payment_due: row.first_new_payment_due, change_date: row.change_date, initial_notice_window_open: w.not_before, initial_notice_due_by: w.deadline, send_target: w.send_target,
    boarded_on: null, determine_by: null, determined_on: null, send_by: null, evidence_document_id: null, breach_record: null, initial_notice_id: null, initial_notice_basis: null, sent_on: null, cancelled_reason: null, render_hold: null };
}
const saveState = (deps: OpsDeps, s: InitialNoticeState): void => {
  put(deps, "arm_initial_notices", s.loan_id, { ...s, ...(s.breach_record ? { breach_record: { ...s.breach_record } } : {}) });
  const row = initialRow(deps, s.loan_id);
  put(deps, "arm_schedule", rowId(s.loan_id, row.change_date), { ...row, initial_notice_window_open: s.initial_notice_window_open, initial_notice_due_by: s.initial_notice_due_by, initial_notice_id: s.initial_notice_id, initial_notice_basis: s.initial_notice_basis, initial_notice_status: s.status });
};
const NOT_DUE: readonly InitialNoticeStatus[] = ["exempt_short_term", "originator_duty", "transferor_evidenced", "cancelled"];
const notDueReason = (s: InitialNoticeState): string => s.status === "transferor_evidenced" ? `the transferor's (d) notice is in the file (${s.evidence_document_id}) — no duplicate is sent (7.3-T4)` : s.status === "originator_duty" ? "the (d) disclosure was the originator's duty at consummation (rule 1)" : s.status === "exempt_short_term" ? "terms of one year or less are exempt (§1026.20(d)(1)(ii))" : `cancelled: ${s.cancelled_reason}`;
const latestEstimate = (deps: OpsDeps, loanId: string): InitialEstimate | undefined =>
  deps.store.list("arm_initial_estimates", (d) => d.loan_id === loanId).map((r) => r.data as unknown as InitialEstimate).sort((a, b) => (a.disclosure_date < b.disclosure_date ? 1 : a.disclosure_date > b.disclosure_date ? -1 : 0))[0];
const estimateId = (loanId: string, disclosure: PlainDate, n: number): string => `${loanId}:${disclosure}:${n}`;

// ---- boarding: the file check ---------------------------------------------------------------------------------------
export interface FileCheckResult { readonly applicable: boolean; readonly within_300_days: boolean; readonly days_to_first_new_payment: number | null; readonly determine_by: PlainDate | null; readonly timer: typeof TIMERS_7_3.file_check | null; readonly event: DomainEvent | null; }
/** `loan.boarded` → is this an ARM whose first new payment is within 300 days? Then the status must be determined within 5 servicer business days (SM_ARM_INITIAL_FILE_CHECK_T0). */
export function openInitialFileCheck(deps: OpsDeps, f: { loan_id: string; boarded_on?: PlainDate }): FileCheckResult {
  if (!f.loan_id) throw new RangeError("openInitialFileCheck: loan_id is required");
  const terms = deps.store.get("loan_terms", f.loan_id)?.data;
  if (!terms || terms.product !== "ARM") return { applicable: false, within_300_days: false, days_to_first_new_payment: null, determine_by: null, timer: null, event: null };
  const boarded_on = f.boarded_on ?? today(deps); const row = initialRow(deps, f.loan_id);
  const days = daysBetween(boarded_on, row.first_new_payment_due);
  const within_300_days = days >= 0 && days <= FILE_CHECK_HORIZON_DAYS;
  const determine_by = within_300_days ? addBusinessDays(boarded_on, FILE_CHECK_BUSINESS_DAYS, servicer) : null;
  const event = append(deps, "arm.initial_notice.file_check_opened", f.loan_id, { boarded_on, first_new_payment_due: row.first_new_payment_due, change_date: row.change_date, days_to_first_new_payment: days, within_300_days, determine_by, timer: within_300_days ? TIMERS_7_3.file_check : null });
  const s = loadState(deps, f.loan_id); saveState(deps, { ...s, boarded_on, determine_by });
  return { applicable: true, within_300_days, days_to_first_new_payment: days, determine_by, timer: within_300_days ? TIMERS_7_3.file_check : null, event };
}

// ---- status determination -------------------------------------------------------------------------------------------
export interface DetermineInput { readonly loan_id: string; readonly on?: PlainDate; readonly transferor_evidence: { readonly document_id: string; readonly dated: PlainDate } | null; readonly consummation_disclosure_document_id?: string | null; }
export interface DetermineResult { readonly status: InitialNoticeStatus; readonly send_by: PlainDate | null; readonly duplicate: false; readonly breach_record: TransferorBreachRecord | null; readonly evidence_document_id: string | null; readonly window: { readonly not_before: PlainDate; readonly deadline: PlainDate }; readonly events: DomainEvent[]; readonly satisfies_deadline: boolean; }
/**
 * Rule 1 + edge "Boarded after T−210 with no transferor evidence". The "transferor sent it" determination requires an
 * attached document (agent guardrail); a late boarding without one sends within 5 business days and records the breach
 * attributable to the transferor (17.x/1.7 claim). Appends `arm.initial_notice.status_determined` and the specific event.
 */
export function determineInitialNoticeStatus(deps: OpsDeps, f: DetermineInput): DetermineResult {
  const terms = loadTerms(deps, f.loan_id); const row = initialRow(deps, f.loan_id); const state = loadState(deps, f.loan_id);
  if (state.status === "cancelled") throw new RangeError(`${f.loan_id}: the (d) notice was cancelled (${state.cancelled_reason})`);
  const on = f.on ?? today(deps); const boarded_on = state.boarded_on ?? on;
  if (f.transferor_evidence !== null) {
    if (!f.transferor_evidence.document_id) throw new RangeError("transferor_evidenced requires the transferor's (d) notice as an attached document (7.3 guardrail)");
    if (f.transferor_evidence.dated > on) throw new RangeError(`transferor evidence dated ${f.transferor_evidence.dated} is after ${on}`);
  }
  const w = initialNoticeWindow(row.first_new_payment_due, terms.consummation_date, terms.term_months);
  const tr = transferInInitialNotice({ boarded_on, first_new_payment_due: row.first_new_payment_due, consummation: terms.consummation_date, term_months: terms.term_months, transferor_evidence: f.transferor_evidence });
  const events: DomainEvent[] = [];
  const base = { boarded_on, determined_on: on, first_new_payment_due: row.first_new_payment_due, change_date: row.change_date, window_open: w.not_before, due_by: w.deadline, send_target: w.send_target };
  let status: InitialNoticeStatus; let send_by: PlainDate | null = null; let breach_record: TransferorBreachRecord | null = null; let evidence_document_id: string | null = null; let satisfies_deadline = false;
  let specific: { type: string; payload: Record<string, unknown> };
  if (w.status === "exempt_short_term") {
    status = "exempt_short_term"; satisfies_deadline = true;
    specific = { type: "arm.initial_notice.exempt_short_term", payload: { term_months: terms.term_months, cite: "12 CFR 1026.20(d)(1)(ii)", satisfies_timer: true } };
  } else if (f.transferor_evidence !== null) {
    status = "transferor_evidenced"; evidence_document_id = f.transferor_evidence.document_id; satisfies_deadline = true;
    const transferor_late = f.transferor_evidence.dated > w.deadline;
    if (transferor_late) breach_record = { attributable_to: "transferor", window_deadline: w.deadline, boarded_on, days_after_deadline: daysBetween(w.deadline, f.transferor_evidence.dated), claim: "17.3/1.7 transferor claim" };
    specific = { type: "arm.initial_notice.transferor_evidenced", payload: { evidence_document_id: evidence_document_id, dated: f.transferor_evidence.dated, transferor_late, duplicate_suppressed: true, satisfies_timer: true } };
  } else if (w.status === "originator_duty") {
    status = "originator_duty"; evidence_document_id = f.consummation_disclosure_document_id ?? null; satisfies_deadline = evidence_document_id !== null;
    specific = { type: "arm.initial_notice.originator_duty", payload: { consummation_date: terms.consummation_date, days_consummation_to_first_new_payment: daysBetween(terms.consummation_date, row.first_new_payment_due), document_kind: "arm_initial_disclosure_consummation", evidence_document_id, consummation_disclosure_verified: evidence_document_id !== null, ...(evidence_document_id !== null ? { satisfies_timer: true } : { hold: "verify the consummation (d) disclosure in the file (rule 1)" }) } };
  } else if (tr.status === "send_now") {
    status = "late"; send_by = tr.send_by; breach_record = { attributable_to: "transferor", window_deadline: w.deadline, boarded_on, days_after_deadline: daysBetween(w.deadline, boarded_on), claim: "17.3/1.7 transferor claim" };
    put(deps, "transferor_breach_records", `${f.loan_id}:arm_initial_notice`, { loan_id: f.loan_id, kind: "arm_initial_notice_late", ...breach_record, recorded_on: on });
    specific = { type: "arm.initial_notice.late", payload: { send_by, breach_record: { ...breach_record }, breach_source: "transferor", timer: TIMERS_7_3.deadline } };
  } else {
    status = on >= w.not_before ? "window_open" : "scheduled"; send_by = w.deadline;
    specific = { type: "arm.initial_notice.scheduled", payload: { send_by, send_target: w.send_target } };
  }
  const determined = append(deps, "arm.initial_notice.status_determined", f.loan_id, { status, ...base, send_by, evidence_document_id, breach_record: breach_record ? { ...breach_record } : null, timer: TIMERS_7_3.file_check });
  events.push(determined, append(deps, specific.type, f.loan_id, { ...specific.payload, status, ...base }, determined.id));
  saveState(deps, { ...state, status, boarded_on, determined_on: on, send_by, evidence_document_id, breach_record });
  return { status, send_by, duplicate: false, breach_record, evidence_document_id, window: { not_before: w.not_before, deadline: w.deadline }, events, satisfies_deadline };
}

// ---- the window -----------------------------------------------------------------------------------------------------
/** Rule 2: the −240 gate opens with `arm.initial_notice.window_opened{kind=d}` (the schedule's daily sweep; §1026.20(d)(2) "no more than 240 days"). */
export function openInitialNoticeWindow(deps: OpsDeps, loanId: string, on?: PlainDate): { opened: boolean; already_open: boolean; opens_on: PlainDate; deadline: PlainDate; reason: string | null; event: DomainEvent | null } {
  const terms = loadTerms(deps, loanId); const row = initialRow(deps, loanId); const state = loadState(deps, loanId); const d = on ?? today(deps);
  const w = initialNoticeWindow(row.first_new_payment_due, terms.consummation_date, terms.term_months);
  if (NOT_DUE.includes(state.status)) return { opened: false, already_open: false, opens_on: w.not_before, deadline: w.deadline, reason: notDueReason(state), event: null };
  if (d < w.not_before) return { opened: false, already_open: false, opens_on: w.not_before, deadline: w.deadline, reason: `${TIMERS_7_3.not_before}: the window opens ${w.not_before} (first new payment ${row.first_new_payment_due} − 240)`, event: null };
  const prior = deps.events.byLoan(loanId).find((e) => e.type === w.window_opened_event.type);
  if (prior) return { opened: true, already_open: true, opens_on: w.not_before, deadline: w.deadline, reason: null, event: prior };
  const event = append(deps, w.window_opened_event.type, loanId, { ...w.window_opened_event.payload, change_date: row.change_date, send_target: w.send_target, opened_on: d, timer: TIMERS_7_3.not_before });
  if (state.status === "scheduled") saveState(deps, { ...state, status: "window_open" });
  return { opened: true, already_open: false, opens_on: w.not_before, deadline: w.deadline, reason: null, event };
}

// ---- the estimate ---------------------------------------------------------------------------------------------------
export interface RenderRequestResult { readonly hold: boolean; readonly reason: string | null; readonly disclosure_date: PlainDate; readonly index: (IndexObs & { capture_id: string; source: IndexSource }) | null; readonly index_age_business_days: number | null; readonly basis: InitialBasis; readonly estimate: InitialEstimate | null; readonly timer: typeof TIMERS_7_3.index_recency; readonly evaluator: typeof EVALUATORS.index_recency; readonly event: DomainEvent; readonly held_event: DomainEvent | null; }
/**
 * Rule 3: the latest `index_value` with `effective_date` on/before the disclosure date must be within 15 servicer
 * business days (the recency gate's evaluator decides; T3: 16 business days → hold until a fresh value is captured).
 * `est_rate = cap_and_floor(round_to_eighth(index + margin))` (engine A, first change), the payment on the F-1-01
 * expected UPB at the change date over the remaining term from `first_new_payment_due`. If the note's index date has
 * already passed at render (look-back ≥ 210 days) the figures are `actual`.
 */
export function requestInitialNoticeRender(deps: OpsDeps, f: { loan_id: string; disclosure_date?: PlainDate }): RenderRequestResult {
  const terms = loadTerms(deps, f.loan_id); const row = initialRow(deps, f.loan_id); const state = loadState(deps, f.loan_id);
  if (NOT_DUE.includes(state.status)) throw new RangeError(`${f.loan_id}: no (d) notice is due — ${notDueReason(state)}`);
  const disclosure_date = f.disclosure_date ?? today(deps);
  const noteIndexDate = indexDate(row.change_date, terms.lookback_days);
  const basis: InitialBasis = noteIndexDate <= disclosure_date ? "actual" : "estimate";
  const obs = indexObservations(deps, terms.index_type);
  const latest = selectIndex(obs, basis === "actual" ? noteIndexDate : disclosure_date) as (IndexObs & { capture_id: string; source: IndexSource }) | null;
  const age = latest ? initialNoticeIndexHold({ latest, disclosure_date }).business_days_old : null;
  const facts = { disclosure_date, index_type: terms.index_type, index_effective_date: latest?.effective_date ?? null, index_value: latest?.value ?? null, index_capture_id: latest?.capture_id ?? null, index_age_business_days: age, basis, note_index_date: noteIndexDate, timer: TIMERS_7_3.index_recency, evaluator: EVALUATORS.index_recency };
  // an `actual` basis uses the note's own index date; the 15-business-day recency rule is the estimate rule ((d)(2))
  const gate = basis === "actual" && latest ? { open: true as const } : EVALUATORS_7_3[EVALUATORS.index_recency]!(facts);
  const event = append(deps, "arm.initial_notice.render_requested", f.loan_id, { ...facts, hold: !gate.open, gate_open: gate.open, gate_reason: gate.open ? null : gate.reason ?? null });
  if (!gate.open || !latest) {
    const reason = latest ? `latest index publication is ${age} business days old (> 15); hold until a fresh value is captured` : "no index publication on or before the disclosure date; hold until a value is captured";
    const held_event = append(deps, "arm.initial_notice.render_held", f.loan_id, { disclosure_date, reason, index_age_business_days: age, index_effective_date: latest?.effective_date ?? null, breach_action: "hold; refresh index", timer: TIMERS_7_3.index_recency }, event.id);
    saveState(deps, { ...state, status: state.status === "scheduled" || state.status === "window_open" || state.status === "estimated" ? "held" : state.status, render_hold: reason });
    return { hold: true, reason, disclosure_date, index: latest, index_age_business_days: age, basis, estimate: null, timer: TIMERS_7_3.index_recency, evaluator: EVALUATORS.index_recency, event, held_event };
  }
  const expected_upb_cents = expectedUpbAt(terms, row.change_date); const remaining_term_months = remainingTermAt(terms, row.first_new_payment_due);
  const r = newRate({ index_pct: latest.value, margin_pct: terms.margin_pct, prior_rate_pct: terms.current_rate_pct, initial_note_rate_pct: terms.initial_note_rate_pct, initial_cap_pct: terms.initial_cap_pct, periodic_cap_pct: terms.periodic_cap_pct, lifetime_cap_pct: terms.lifetime_cap_pct, first_change: true, rounding: terms.rounding_rule === "nearest_eighth_half_up" ? "half_up" : "half_down" });
  const interest_only = terms.interest_only_until !== null && row.first_new_payment_due <= terms.interest_only_until;
  const est_pi_cents = newPayment(expected_upb_cents, r.new_rate_pct, remaining_term_months, interest_only);
  const n = deps.store.list("arm_initial_estimates", (d) => d.loan_id === f.loan_id).length + 1;
  const estimate: InitialEstimate = { loan_id: f.loan_id, disclosure_date, index_effective_date: latest.effective_date, index_value: latest.value, index_capture_id: latest.capture_id, index_source: latest.source, est_rate_pct: r.new_rate_pct, unrounded_pct: r.unrounded_pct, est_pi_cents, expected_upb_cents, remaining_term_months, is_estimate: basis === "estimate", notice_id: null, terms_version: terms.version };
  put(deps, "arm_initial_estimates", estimateId(f.loan_id, disclosure_date, n), { ...estimate });
  append(deps, "arm.initial_notice.estimated", f.loan_id, { disclosure_date, index_effective_date: latest.effective_date, index_value: latest.value, est_rate_pct: r.new_rate_pct, unrounded_pct: r.unrounded_pct, bound: r.bound, est_pi_cents, expected_upb_cents, remaining_term_months, is_estimate: basis === "estimate", basis, labeled: basis === "estimate" ? "estimate" : "actual", terms_version: terms.version }, event.id);
  saveState(deps, { ...state, status: state.status === "scheduled" || state.status === "window_open" || state.status === "held" ? "estimated" : state.status, initial_notice_basis: basis, render_hold: null });
  return { hold: false, reason: null, disclosure_date, index: latest, index_age_business_days: age, basis, estimate, timer: TIMERS_7_3.index_recency, evaluator: EVALUATORS.index_recency, event, held_event: null };
}

// ---- the send -------------------------------------------------------------------------------------------------------
export interface HfaRules { readonly [state: string]: { readonly hfa_name: string; readonly hfa_phone: string }; }
export interface SendInitialInput { readonly loan_id: string; readonly recipients: readonly Recipient[]; readonly contact: ServicerContact; readonly property_state: string; readonly hfa_rules: HfaRules; readonly send_on?: PlainDate; readonly channel_context?: ChannelContext; readonly consent_id?: string | null; readonly corrected?: { readonly supersedes_notice_id: string; readonly notice_date: PlainDate; readonly field: string } | null; }
export interface SendInitialResult {
  readonly template: typeof TEMPLATE_D; readonly notice_id: string; readonly sent_on: PlainDate; readonly disclosure_date: PlainDate; readonly basis: InitialBasis; readonly late: boolean; readonly breach: { timer: string; severity: 1; days_late: number } | null; readonly breach_attributable_to: "transferor" | "servicer" | null;
  readonly channel: "electronic" | "mail"; readonly days_before_first_payment: number; readonly separate_document: true; readonly payload: Record<string, unknown>; readonly decision_record: Record<string, unknown>; readonly render_requested_event: DomainEvent; readonly event: DomainEvent; readonly text: string | null;
}
/** Rule 4 (ii)–(xi) content assembly from the boarded terms, the estimate and `jurisdiction_rules` — every figure from the engines. */
export function initialNoticePayload(terms: ArmTerms, row: ArmScheduleRow, est: InitialEstimate, f: { sent_on: PlainDate; contact: ServicerContact; property_state: string; hfa_rules: HfaRules; late_notice: boolean; breach_attributable_to: "transferor" | "servicer" | null; corrected: SendInitialInput["corrected"]; index_age_business_days: number }): Record<string, unknown> {
  const hfa = stateHfaContact(f.property_state, f.hfa_rules); const desc = INDEX_DESCRIPTIONS[terms.index_type];
  return {
    disclosure_date: est.disclosure_date, change_date: row.change_date, first_new_payment_due: row.first_new_payment_due, schedule_sentence: scheduleSentence(terms.adjustment_period_months),
    is_estimate: est.is_estimate, basis: est.is_estimate ? "estimate" : "actual", estimated_rate_pct: est.est_rate_pct, unrounded_pct: est.unrounded_pct, index_name: desc.name, index_date: est.index_effective_date, index_source: desc.source, index_value: est.index_value, margin_pct: terms.margin_pct,
    estimated_payment_cents: est.est_pi_cents, current_payment_cents: terms.current_pi_cents, current_rate_pct: terms.current_rate_pct,
    first_cap_pct: terms.initial_cap_pct, periodic_cap_pct: terms.periodic_cap_pct, lifetime_cap_pct: Decimal.parse(terms.initial_note_rate_pct).add(Decimal.parse(terms.lifetime_cap_pct)).toFixed(3), floor_pct: terms.margin_pct,
    expected_upb_cents: est.expected_upb_cents, remaining_term_months: est.remaining_term_months, prepayment_penalty: false, toll_free: f.contact.servicer_phone, cfpb_url: COUNSELING.cfpb_url, hud_phone: COUNSELING.hud_phone, state_hfa_contact: `${hfa.hfa_name} ${hfa.hfa_phone}`, property_state: f.property_state,
    index_age_business_days: f.index_age_business_days, days_before_first_payment: daysBetween(f.sent_on, row.first_new_payment_due), late_notice: f.late_notice, breach_attributable_to: f.breach_attributable_to,
    corrected: f.corrected != null, corrected_notice_date: f.corrected?.notice_date ?? null, corrected_field: f.corrected?.field ?? null, ...f.contact,
  };
}
/**
 * Rules 2/4/5 + edge cases. Blocked before T−240 (the gate; `sendCheck`); a send after T−210 is the sev-1 breach (recorded,
 * the notice still goes — a late boarding's breach belongs to the transferor, otherwise to the servicer). The separate-
 * document gate is asserted on `notice.render_requested{template, separate_document}`; delivery goes through the Notice
 * Registry only (`notice.sent{template=NTC_REGZ_20D_ARM_INITIAL}`), then `arm.initial_notice.sent{satisfies_timer=true}`.
 */
export async function sendInitialNotice(deps: OpsDeps, notices: NoticeSender7_3, input: SendInitialInput): Promise<SendInitialResult> {
  const loanId = input.loan_id; const terms = loadTerms(deps, loanId); const row = initialRow(deps, loanId); const state = loadState(deps, loanId);
  if (!input.recipients.length) throw new RangeError("recipients are required (the borrower(s) and any confirmed successor in interest)");
  if (NOT_DUE.includes(state.status)) throw new RangeError(`${loanId}: no (d) notice is sent — ${notDueReason(state)}`);
  if (state.render_hold !== null) throw new RangeError(`${TIMERS_7_3.index_recency}: rendering is held — ${state.render_hold} (hold; refresh index, rule 3)`);
  if ((state.status === "sent" || state.status === "awaiting_actual") && !input.corrected) throw new RangeError(`${loanId}: the (d) notice was already sent (${state.initial_notice_id}); a change of terms goes through correctInitialNoticeTerms (rule 6)`);
  const est = latestEstimate(deps, loanId);
  if (!est || est.notice_id !== null) throw new RangeError(`${loanId}: no unsent estimate — run requestInitialNoticeRender first (rule 3)`);
  const sendOn = input.send_on ?? today(deps);
  const w = initialNoticeWindow(row.first_new_payment_due, terms.consummation_date, terms.term_months);
  let late = false; let breach: SendInitialResult["breach"] = null; let breach_attributable_to: SendInitialResult["breach_attributable_to"] = null;
  if (state.status === "late") {
    late = true; breach_attributable_to = "transferor"; breach = { timer: TIMERS_7_3.deadline, severity: 1, days_late: daysBetween(w.deadline, sendOn) };
    if (state.send_by && sendOn > state.send_by) breach_attributable_to = "servicer";   // the 5-business-day send-now clock missed too
  } else {
    const opened = openInitialNoticeWindow(deps, loanId, sendOn);
    const check = sendCheck(sendOn, w, { gate: TIMERS_7_3.not_before, deadline: TIMERS_7_3.deadline });
    if (!check.allowed || !opened.opened) throw new RangeError(`${check.blocked_by ?? TIMERS_7_3.not_before}: send blocked before ${w.not_before} (§1026.20(d)(2): no more than 240 days before the first payment at the adjusted level)`);
    if (check.breach) { late = true; breach = check.breach; breach_attributable_to = "servicer"; }
  }
  // SM_ARM_INITIAL_SEPARATE_DOC_GATE on the render request (own PDF; own first page; may share an envelope)
  const separate_document = notices.template(TEMPLATE_D).separateDocument;
  const renderFacts = { template: TEMPLATE_D, separate_document, notice_kind: "d", timer: TIMERS_7_3.separate_document, evaluator: EVALUATORS.separate_document, disclosure_date: est.disclosure_date, send_on: sendOn };
  const gate = EVALUATORS_7_3[EVALUATORS.separate_document]!(renderFacts);
  const render_requested_event = append(deps, "notice.render_requested", loanId, { ...renderFacts, gate_open: gate.open, gate_reason: gate.open ? null : gate.reason ?? null });
  if (!gate.open) throw new RangeError(`${TIMERS_7_3.separate_document}: ${gate.reason}`);
  const payload = initialNoticePayload(terms, row, est, { sent_on: sendOn, contact: input.contact, property_state: input.property_state, hfa_rules: input.hfa_rules, late_notice: late, breach_attributable_to, corrected: input.corrected ?? null, index_age_business_days: initialNoticeIndexHold({ latest: { effective_date: est.index_effective_date, value: est.index_value }, disclosure_date: est.disclosure_date }).business_days_old });
  const n = notices.render({ templateCode: TEMPLATE_D, loanId, recipients: input.recipients, payload, asOf: sendOn });
  if (n.status === "held") throw new RangeError(`${TEMPLATE_D} for ${loanId} is held: ${n.heldReason ?? "checklist"}`);
  const sent = await notices.send(n.id, input.channel_context ?? {});
  const channels = (sent.channelDecision ?? []).map((d) => d.channel);
  if (channels.length && channels.every((c) => c.startsWith("sms"))) throw new RangeError("ARM notices are never SMS-only (7.3 outputs: channel esign_or_mail, class arm_notices)");
  const channel: "electronic" | "mail" = channels.some((c) => c.startsWith("mail")) ? "mail" : "electronic";
  const noticeSent = [...deps.events.byLoan(loanId)].reverse().find((e) => e.type === "notice.sent" && e.payload.notice_id === n.id);
  const days_before_first_payment = daysBetween(sendOn, row.first_new_payment_due);
  const estKey = deps.store.list("arm_initial_estimates", (d) => d.loan_id === loanId && d.disclosure_date === est.disclosure_date && d.notice_id === null)[0]?.id;
  if (estKey) put(deps, "arm_initial_estimates", estKey, { ...est, notice_id: n.id });
  const decision_record = { loan_id: loanId, disclosure_date: est.disclosure_date, index_effective_date: est.index_effective_date, index_value: est.index_value, est_rate: est.est_rate_pct, est_pi: est.est_pi_cents, basis: est.is_estimate ? "estimate" : "actual", window: { open: w.not_before, deadline: w.deadline }, sent_at: deps.now, channel, consent_id: input.consent_id ?? null, evidence_document_id: state.evidence_document_id, late, breach, breach_attributable_to, corrected: input.corrected ?? null, versions: { loan_terms: terms.version, template: n.templateVersion ?? null }, rule_set_version: RULE_SET_VERSION };
  const event = append(deps, "arm.initial_notice.sent", loanId, { notice_id: n.id, template: TEMPLATE_D, sent_on: sendOn, disclosure_date: est.disclosure_date, basis: est.is_estimate ? "estimate" : "actual", is_estimate: est.is_estimate, channel, separate_document, late, breach_timer: breach ? breach.timer : null, days_late: breach ? breach.days_late : 0, breach_attributable_to, days_before_first_payment, corrected: input.corrected != null, supersedes_notice_id: input.corrected?.supersedes_notice_id ?? null, est_rate_pct: est.est_rate_pct, est_pi_cents: est.est_pi_cents, satisfies_timer: true }, noticeSent?.id);
  saveState(deps, { ...state, status: est.is_estimate ? "awaiting_actual" : "sent", initial_notice_id: n.id, initial_notice_basis: est.is_estimate ? "estimate" : "actual", sent_on: state.sent_on ?? sendOn });
  return { template: TEMPLATE_D, notice_id: n.id, sent_on: sendOn, disclosure_date: est.disclosure_date, basis: est.is_estimate ? "estimate" : "actual", late, breach, breach_attributable_to, channel, days_before_first_payment, separate_document: true, payload, decision_record, render_requested_event, event, text: (n as { rendered?: { text: string } }).rendered?.text ?? null };
}

// ---- corrections and cancellation ----------------------------------------------------------------------------------
export interface CorrectionInput extends Omit<SendInitialInput, "send_on" | "corrected"> { readonly corrected_on: PlainDate; readonly changes: { readonly margin_pct?: string; readonly first_change_date?: PlainDate; readonly initial_cap_pct?: string; readonly lifetime_cap_pct?: string }; readonly send_on?: PlainDate; }
export interface CorrectionResult { readonly action: "send_corrected_d_notice" | "rely_on_c_notice" | "reschedule"; readonly send_by: PlainDate | null; readonly days_out: number; readonly terms_version: number; readonly corrected_event: DomainEvent; readonly notice: SendInitialResult | null; readonly discrepancy_event: DomainEvent | null; }
/**
 * Rule 6 / T9: `loan.terms.corrected` (e.g. wrong margin) after a send → a corrected (d) notice if still ≥ 210 days out
 * (re-estimated on the corrected terms; `corrected=true`, names the notice it replaces); otherwise the (c) notice will
 * carry the correct figures and the discrepancy is documented. A corrected first change date before any send simply
 * reschedules (spec inputs: "`loan.terms.corrected` (boarding error on first change date) → reschedule").
 */
export async function correctInitialNoticeTerms(deps: OpsDeps, notices: NoticeSender7_3, input: CorrectionInput): Promise<CorrectionResult> {
  const loanId = input.loan_id; const terms = loadTerms(deps, loanId); const row = initialRow(deps, loanId); const state = loadState(deps, loanId);
  const fields = Object.entries(input.changes).filter(([, v]) => v !== undefined);
  if (!fields.length) throw new RangeError("correctInitialNoticeTerms: at least one corrected term is required");
  const next: ArmTerms = { ...terms, ...(input.changes.margin_pct !== undefined ? { margin_pct: input.changes.margin_pct } : {}), ...(input.changes.initial_cap_pct !== undefined ? { initial_cap_pct: input.changes.initial_cap_pct } : {}), ...(input.changes.lifetime_cap_pct !== undefined ? { lifetime_cap_pct: input.changes.lifetime_cap_pct } : {}), ...(input.changes.first_change_date !== undefined ? { first_change_date: input.changes.first_change_date } : {}), version: terms.version + 1 };
  put(deps, "loan_terms", loanId, { ...next, schedule_basis: { ...next.schedule_basis } });
  const corrected_event = append(deps, "loan.terms.corrected", loanId, { corrected_on: input.corrected_on, fields: fields.map(([k, v]) => ({ field: k, from: (terms as unknown as Record<string, unknown>)[k] ?? null, to: v })), version: next.version, notice_sent: state.initial_notice_id });
  const days_out = daysBetween(input.corrected_on, row.first_new_payment_due);
  if (!state.sent_on || !state.initial_notice_id) {
    append(deps, "arm.initial_notice.rescheduled", loanId, { corrected_on: input.corrected_on, version: next.version }, corrected_event.id);
    return { action: "reschedule", send_by: state.send_by, days_out, terms_version: next.version, corrected_event, notice: null, discrepancy_event: null };
  }
  const d = correctedInitialNotice({ sent_on: state.sent_on, corrected_on: input.corrected_on, first_new_payment_due: row.first_new_payment_due });
  if (d.action === "rely_on_c_notice") {
    const discrepancy_event = append(deps, "arm.initial_notice.discrepancy_documented", loanId, { corrected_on: input.corrected_on, days_out, notice_id: state.initial_notice_id, fields: fields.map(([k]) => k), resolution: "the (c) notice (7.2) carries the correct figures; the (d) discrepancy is documented" }, corrected_event.id);
    return { action: d.action, send_by: null, days_out, terms_version: next.version, corrected_event, notice: null, discrepancy_event };
  }
  const sendOn = input.send_on ?? input.corrected_on;
  const rr = requestInitialNoticeRender(deps, { loan_id: loanId, disclosure_date: sendOn });
  if (rr.hold) throw new RangeError(`${TIMERS_7_3.index_recency}: corrected (d) notice held — ${rr.reason}`);
  const field = fields.map(([k, v]) => `${k.replace(/_pct$/, "").replace(/_/g, " ")} ${String((terms as unknown as Record<string, unknown>)[k])}${k.endsWith("_pct") ? "%" : ""} → ${String(v)}${k.endsWith("_pct") ? "%" : ""}`).join("; ");
  const notice = await sendInitialNotice(deps, notices, { loan_id: loanId, recipients: input.recipients, contact: input.contact, property_state: input.property_state, hfa_rules: input.hfa_rules, send_on: sendOn, ...(input.channel_context ? { channel_context: input.channel_context } : {}), consent_id: input.consent_id ?? null, corrected: { supersedes_notice_id: state.initial_notice_id, notice_date: state.sent_on, field } });
  return { action: d.action, send_by: d.send_by, days_out, terms_version: next.version, corrected_event, notice, discrepancy_event: null };
}
/** Edge "Loan pays off/transfers before the first change date": cancel with reason. */
export function cancelInitialNotice(deps: OpsDeps, f: { loan_id: string; reason: "paid_off" | "transferred_out" | "modified" | string; on?: PlainDate }): { status: "cancelled"; event: DomainEvent } {
  if (!f.reason) throw new RangeError("cancelInitialNotice: a reason is required");
  const state = loadState(deps, f.loan_id);
  const event = append(deps, "arm.initial_notice.cancelled", f.loan_id, { reason: f.reason, on: f.on ?? today(deps), prior_status: state.status, notice_id: state.initial_notice_id });
  saveState(deps, { ...state, status: "cancelled", cancelled_reason: f.reason });
  return { status: "cancelled", event };
}
/** Timer row REGZ_1026_20D_INITIAL_NOTICE_210: the (d) deadline is `first_new_payment_due − 210`; the send target is window open + 5 (decision 1). */
export const initialNoticeDates = (firstNewPaymentDue: PlainDate): { window_open: PlainDate; send_target: PlainDate; deadline: PlainDate } => ({ window_open: addDays(firstNewPaymentDue, -240), send_target: addDays(firstNewPaymentDue, -235), deadline: addDays(firstNewPaymentDue, -210) });
