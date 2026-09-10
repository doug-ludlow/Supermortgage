/**
 * §7.2 process ops — the ARM adjustment cycle as the code paths that append the loan events the 7.2 registry rows
 * arm on and close on. Engine A (arm.ts) and engine B (arm-verify.ts) stay pure; this module reads the boarded
 * `loan_terms`, the `arm_schedule`, the `arm_index_captures` and the event log, runs the engines, and records what
 * happened. Wired by src/app/tools/section07.ts (`computeArmAdjustment` / `verifyArmAdjustment` on a loan) and by
 * the 7.2 spec tests through the TimerEngine.
 *
 *   - `boardArmTerms` / `scheduleNextChange` — `loan.boarded` with `loan_terms.product = ARM` → the `arm_schedule`
 *     (every change date to maturity) and `arm.schedule.row_created` for the next change, carrying the fields the
 *     7.2 clocks condition on: `change_date` (SM_ARM_INDEX_CAPTURE_T45), `first_new_payment_due` (the −120 gate and
 *     the −60 / −25 deadlines), `notice_kind` ∈ {c_60_120, c_25_120, c_first_25, fnma_only} (which deadline applies:
 *     §1026.20(c)(2) and the (c)(1)(ii) exemptions) and `initial` (7.3's (d) notice rows).
 *   - `captureIndex` — the `index-feed` ingestion: a NY Fed `refRates[]` row (`effectiveDate`, `type` "SOFRAI",
 *     `average30day`, `revisionIndicator`) or a fallback record (vendor feed / manual entry, dual control with
 *     evidence) → idempotent upsert keyed by (type, effective_date), revisions kept → `arm.index.captured`.
 *   - `calculateAdjustment` — rule 1–3: index at `change_date − lookback_days` ("most recent index figure available
 *     45 days before"), engine A, the F-1-01 expected UPB and remaining term → `arm_adjustments` (calculated) and
 *     `arm.adjustment.calculated{calculation_date}` (closes SM_ARM_INDEX_CAPTURE_T45; arms SM_ARM_DUAL_CALC_VERIFY_T0
 *     and FNMA_IRM_LAR83_RATE_CHANGE_BD5).
 *   - `verifyAdjustment` — engine B must agree to the cent: `arm.adjustment.verified` (closes the dual-calc gate),
 *     rule 7's `investor_events.projected{event_type=rate_payment_change}` for 5.1 and `payment.change.scheduled`
 *     for 14.2 (Rule 3002.1); a mismatch is `arm.adjustment.discrepancy` and an ops-review hold.
 *   - `openNoticeWindow` / `sendAdjustmentNotice` — the −120 gate opens with `arm.adjustment.notice_window_opened`;
 *     the notice goes through the Notice Registry (NoticeService renders, runs the checklist and sends —
 *     `notice.sent{template=…}` closes the deadline): the (c) notice, or C-2.1-02's rate/payment-change notice
 *     (rule 6; FDCPA §805(c) loans, decision 4). A late (c) notice defers the payment change one cycle (decision 5).
 *   - `makeEffective` — the change date: `loan_terms.version.activated`, `arm.adjustment.effective`, next row armed.
 *   - `scheduleBuydownSteps` / `sendBuydownStepNotice` — C-2.1-02 temporary buydowns (`buydown.step.scheduled`,
 *     `NTC_FNMA_C2_1_02_BUYDOWN_STEP_90` 90 days ahead).
 *   - `receiveArmInquiry` / `sendInterimResponse` / `resolveArmInquiry` / `confirmArmError` / `completeCorrection` —
 *     C-2.2-01 / C-2.2-03 / F-1-01: `arm.error.suspected{received_on}`, the 20-day response (`arm.inquiry.responded`),
 *     `arm.error.confirmed{confirmed_on}`, re-amortization, refund/credit, the correction notice, IRR-gated
 *     reporting and `arm.correction.completed{records_corrected, borrower_notified, irr_discussed}`.
 *   - `electConversion` / `sendConversionNotice` — F-1-01 conversion option (legacy plans only).
 *   - `ingestLar83Feedback` — Fannie Mae's LSDU feedback on the LAR 83 → `investor_events.accepted{event_type=
 *     rate_payment_change}` (closes FNMA_IRM_LAR83_RATE_CHANGE_BD5) or `investor_events.rejected` + the
 *     `fnma_portal_operator` single-LAR task.
 *   - `recordIndexFeedFailure` / `captureIndexFallback` — the NY Fed outage path (edge "Index unavailable"; T12).
 * bigint cents; PlainDate; the LLM never computes rates or payments — every figure here comes from the engines.
 */
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { type PlainDate, plainDate, addDays, addMonths, daysBetween, parts, ymd, daysInMonth } from "../../kernel/calendar/date.ts";
import { wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Recipient, ChannelContext } from "../../notices/channel.ts";
import { indexDate as indexDateOf, selectIndex, newRate, roundToEighth, computeArmAdjustment, newPayment, noticeWindow, sendCheck, armNoticeFigures, scheduledUpbAfter, type ArmAdjustmentInput, type ArmAdjustmentResult, type IndexObs, type RateBound } from "./arm.ts";
import { verifyArmAdjustment } from "./arm-verify.ts";
import { armNoticeSelection, buydownStepNotice, marginErrorCorrection, rateChangeInvestorEvent, fdcpaCeaseArmNotice, indexCaptureFallback, ch13PaymentChange } from "./ops.ts";

export const RULE_SET_VERSION = "regz.1026.20c.2013; fnma.svc.c2_1_02.2025-08; fnma.svc.c2_2_01.2014-11; fnma.svc.f1_01.2023-12; fnma.sel.b2_1_4_02.2025-12";

// ---- dependencies ----------------------------------------------------------------------------------------------
/** Versioned documents (src/app/tools.ts EntityStore, structurally). */
export interface CaseStore {
  get(kind: string, id: string): { readonly data: Record<string, unknown> } | undefined;
  list(kind: string, where?: (d: Record<string, unknown>) => boolean): readonly { readonly id: string; readonly data: Record<string, unknown> }[];
  put(kind: string, id: string, data: Record<string, unknown>, by: Actor, now: string): { readonly id: string; readonly data: Record<string, unknown> };
}
export interface OpsDeps { readonly events: EventStore; readonly store: CaseStore; readonly actor: Actor; readonly now: string; }
/** The escalation opener (src/app/escalations.ts EscalationService satisfies it structurally). */
export interface Escalator {
  open(input: { kind: "officer" | "human_portal_task" | "human_agent"; loanId?: string; ownerRole?: string; severity?: string; payload?: Record<string, unknown> }, by: Actor): { id: string };
}
/** The Notice Registry service (src/notices/service.ts NoticeService, structurally): render → checklist → send emits `notice.sent{template}`. */
export interface NoticeSender {
  render(input: { templateCode: string; loanId?: string; caseId?: string; recipients: readonly Recipient[]; payload: Record<string, unknown>; asOf: PlainDate }): { readonly id: string; readonly templateCode: string; readonly templateVersion?: string; status: string; heldReason?: string };
  send(id: string, ctx?: ChannelContext): Promise<{ readonly id: string; status: string; channelDecision?: readonly { readonly partyId: string; readonly channel: string }[] }>;
}
export interface ServicerContact { readonly servicer_phone: string; readonly servicer_address: string; readonly exclusive_address: string; }

export const TIMERS = {
  index_capture: "SM_ARM_INDEX_CAPTURE_T45", not_before: "REGZ_1026_20C_ADJ_NOTICE_NOT_BEFORE_120", deadline_60: "REGZ_1026_20C_ADJ_NOTICE_60", deadline_25: "REGZ_1026_20C_FREQ_ADJ_NOTICE_25", first_25: "REGZ_1026_20C_FIRST_ADJ_ESTIMATE_25",
  dual_calc: "SM_ARM_DUAL_CALC_VERIFY_T0", lar83: "FNMA_IRM_LAR83_RATE_CHANGE_BD5", buydown: "FNMA_C2_1_02_BUYDOWN_STEP_NOTICE_90", interim: "FNMA_C2_2_01_ARM_INQUIRY_INTERIM_20", correct: "FNMA_C2_2_01_ARM_ERROR_CORRECT_60", conversion: "FNMA_F1_01_CONVERSION_NOTICE_25",
} as const;
export const TEMPLATES = { regz_c: "NTC_REGZ_20C_ARM_ADJ", fnma_change: "NTC_FNMA_C2_1_02_RATE_CHANGE", buydown: "NTC_FNMA_C2_1_02_BUYDOWN_STEP_90", correction: "NTC_FNMA_C2_2_01_ARM_CORRECTION", interim: "NTC_ARM_INQUIRY_INTERIM_20" } as const;

// ---- small helpers ----------------------------------------------------------------------------------------------
const today = (deps: OpsDeps): PlainDate => wallClock(Date.parse(deps.now), "America/New_York").date;
const monthsBetween = (a: PlainDate, b: PlainDate): number => { const pa = parts(a), pb = parts(b); return (pb.y - pa.y) * 12 + (pb.m - pa.m); };
/** The first scheduled due date (day `dueDay`, clipped to the month) strictly after `d`: the payment "effective in the month following" (F-1-01). */
export function nextDueAfter(d: PlainDate, dueDay: number): PlainDate {
  const p = parts(d); const cand = ymd(p.y, p.m, Math.min(dueDay, daysInMonth(p.y, p.m)));
  if (cand > d) return cand;
  const n = parts(addMonths(ymd(p.y, p.m, 1), 1)); return ymd(n.y, n.m, Math.min(dueDay, daysInMonth(n.y, n.m)));
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const need = (r: Record<string, unknown>, k: string, what: string): unknown => { const v = r[k]; if (v === undefined || v === null || v === "") throw new RangeError(`${what}: ${k} is required`); return v; };
const pct = (v: unknown, k: string): string => { const s = String(v).trim(); if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new RangeError(`${k} is not a percentage with up to 8 decimals: ${JSON.stringify(v)}`); return s; };
const cents = (v: unknown, k: string): Cents => { if (typeof v === "bigint") return v; if ((typeof v === "string" || typeof v === "number") && /^-?\d+$/.test(String(v))) return BigInt(v); throw new RangeError(`${k} must be integer cents (bigint): ${JSON.stringify(v)}`); };
const date = (v: unknown, k: string): PlainDate => { if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new RangeError(`${k} is not an ISO date: ${JSON.stringify(v)}`); return plainDate(v); };
const int = (v: unknown, k: string, min = 0): number => { const n = Number(v); if (!Number.isInteger(n) || n < min) throw new RangeError(`${k} must be an integer ≥ ${min}: ${JSON.stringify(v)}`); return n; };
const rec = <T>(deps: OpsDeps, kind: string, id: string): T | undefined => deps.store.get(kind, id)?.data as T | undefined;
const put = (deps: OpsDeps, kind: string, id: string, data: Record<string, unknown>): void => { deps.store.put(kind, id, data, deps.actor, deps.now); };
const append = (deps: OpsDeps, type: string, loanId: string, payload: Record<string, unknown>, causationId?: string): DomainEvent =>
  deps.events.append({ type, loanId, actor: deps.actor, payload, ...(causationId ? { causationId } : {}) });
const scheduleSentence = (n: number): string => (n === 1 ? "every month thereafter" : n === 6 ? "every six months thereafter" : n === 12 ? "every twelve months thereafter" : `every ${n} months thereafter`);

// ---- loan terms (data model `loan_terms` ARM fields) --------------------------------------------------------------
export type IndexType = "SOFR_30D_AVG" | "TERM_SOFR_12M_PLUS_SPREAD" | "CMT_1Y" | "COFI" | "LIBOR_1Y_LEGACY";
export const INDEX_TYPES: readonly IndexType[] = ["SOFR_30D_AVG", "TERM_SOFR_12M_PLUS_SPREAD", "CMT_1Y", "COFI", "LIBOR_1Y_LEGACY"];
/** §1026.20(c)(2)(iii) index description and "a source of information about the index". */
export const INDEX_DESCRIPTIONS: Record<IndexType, { readonly name: string; readonly source: string; readonly url: string }> = {
  SOFR_30D_AVG: { name: "30-day Average SOFR", source: "the Federal Reserve Bank of New York (newyorkfed.org)", url: "https://markets.newyorkfed.org/api/rates/secured/sofrai/last/1.json" },
  TERM_SOFR_12M_PLUS_SPREAD: { name: "12-month CME Term SOFR plus the Regulation ZZ tenor spread adjustment", source: "CME Group (cmegroup.com) with the Board-selected spread adjustment", url: "https://www.cmegroup.com/market-data/cme-group-benchmark-administration/term-sofr.html" },
  CMT_1Y: { name: "1-year Treasury constant maturity (CMT)", source: "the Federal Reserve Board H.15 release (federalreserve.gov)", url: "https://www.federalreserve.gov/releases/h15/" },
  COFI: { name: "11th District Cost of Funds Index", source: "the Federal Home Loan Bank of San Francisco (fhlbsf.com)", url: "https://www.fhlbsf.com/" },
  LIBOR_1Y_LEGACY: { name: "1-year LIBOR (replaced under the LIBOR Act and Regulation ZZ)", source: "the replacement-index history on the loan", url: "" },
};
export type NoticeKind = "c_60_120" | "c_25_120" | "c_first_25" | "fnma_only";
export type RoundingRule = "nearest_eighth_half_down" | "nearest_eighth_half_up";
export interface ScheduleBasis { readonly upb_cents: Cents; readonly rate_pct: string; readonly pi_cents: Cents; readonly from_due_date: PlainDate; }
export interface ArmTerms {
  readonly loan_id: string; readonly product: "ARM"; readonly fnma_arm_plan: string | null;
  readonly index_type: IndexType; readonly index_source_url: string; readonly margin_pct: string; readonly lookback_days: number;
  readonly first_change_date: PlainDate; readonly adjustment_period_months: number;
  readonly initial_cap_pct: string; readonly periodic_cap_pct: string; readonly lifetime_cap_pct: string; readonly initial_note_rate_pct: string;
  readonly current_rate_pct: string; readonly current_pi_cents: Cents; readonly original_upb_cents: Cents;
  readonly first_payment_due: PlainDate; readonly maturity_date: PlainDate; readonly term_months: number; readonly consummation_date: PlainDate;
  readonly rounding_rule: RoundingRule; readonly interest_only_until: PlainDate | null;
  /** Legacy payment-cap plans whose payment adjusts on its own cycle (C-2.1-02: "separate notices are required for each change"). */
  readonly payment_change_period_months: number | null;
  readonly conversion_option: boolean;
  /** The §1026.20(d) disclosure at consummation was an estimate ((c)(1)(ii)(B); (c)(2)(iii)). */
  readonly initial_disclosure_estimate: boolean;
  readonly escrow_cents: Cents; readonly fdcpa_cease_on_file: boolean; readonly fdcpa_debt_collector: boolean;
  /** F-1-01 "expected UPB" basis: the balance owed before the payment due `from_due_date`, amortizing at `rate_pct` with payments of `pi_cents`. */
  readonly schedule_basis: ScheduleBasis; readonly version: number;
}
/** Validate boarded ARM terms (1.1 QC gate: "rejects ARMs with missing fields"); throws RangeError naming the field. */
export function parseArmTerms(raw: unknown): ArmTerms {
  if (!isRecord(raw)) throw new RangeError("loan_terms: a record is required");
  const what = "loan_terms";
  const product = String(need(raw, "product", what));
  if (product !== "ARM") throw new RangeError(`loan_terms: product ${product} is not ARM — no adjustment schedule`);
  const loan_id = String(need(raw, "loan_id", what));
  const index_type = String(raw.index_type ?? "SOFR_30D_AVG") as IndexType;
  if (!INDEX_TYPES.includes(index_type)) throw new RangeError(`loan_terms: index_type ${index_type} is not one of ${INDEX_TYPES.join(", ")}`);
  const first_payment_due = date(need(raw, "first_payment_due", what), "first_payment_due");
  const term_months = int(need(raw, "term_months", what), "term_months", 1);
  const initial_note_rate_pct = pct(need(raw, "initial_note_rate_pct", what), "initial_note_rate_pct");
  const current_pi_cents = cents(need(raw, "current_pi_cents", what), "current_pi_cents");
  const original_upb_cents = cents(need(raw, "original_upb_cents", what), "original_upb_cents");
  const adjustment_period_months = int(need(raw, "adjustment_period_months", what), "adjustment_period_months", 1);
  const rounding_rule = String(raw.rounding_rule ?? "nearest_eighth_half_down");
  if (rounding_rule !== "nearest_eighth_half_down" && rounding_rule !== "nearest_eighth_half_up") throw new RangeError(`loan_terms: rounding_rule ${rounding_rule} is not nearest_eighth_half_down/half_up`);
  const basisRaw = isRecord(raw.schedule_basis) ? raw.schedule_basis : null;
  const schedule_basis: ScheduleBasis = basisRaw
    ? { upb_cents: cents(need(basisRaw, "upb_cents", "schedule_basis"), "schedule_basis.upb_cents"), rate_pct: pct(need(basisRaw, "rate_pct", "schedule_basis"), "schedule_basis.rate_pct"), pi_cents: cents(need(basisRaw, "pi_cents", "schedule_basis"), "schedule_basis.pi_cents"), from_due_date: date(need(basisRaw, "from_due_date", "schedule_basis"), "schedule_basis.from_due_date") }
    : { upb_cents: original_upb_cents, rate_pct: initial_note_rate_pct, pi_cents: current_pi_cents, from_due_date: first_payment_due };
  return {
    loan_id, product: "ARM", fnma_arm_plan: raw.fnma_arm_plan === undefined || raw.fnma_arm_plan === null ? null : String(raw.fnma_arm_plan),
    index_type, index_source_url: typeof raw.index_source_url === "string" && raw.index_source_url ? raw.index_source_url : INDEX_DESCRIPTIONS[index_type].url,
    margin_pct: pct(need(raw, "margin_pct", what), "margin_pct"), lookback_days: int(raw.lookback_days ?? 45, "lookback_days", 1),
    first_change_date: date(need(raw, "first_change_date", what), "first_change_date"), adjustment_period_months,
    initial_cap_pct: pct(need(raw, "initial_cap_pct", what), "initial_cap_pct"), periodic_cap_pct: pct(need(raw, "periodic_cap_pct", what), "periodic_cap_pct"), lifetime_cap_pct: pct(need(raw, "lifetime_cap_pct", what), "lifetime_cap_pct"),
    initial_note_rate_pct, current_rate_pct: pct(raw.current_rate_pct ?? initial_note_rate_pct, "current_rate_pct"), current_pi_cents, original_upb_cents,
    first_payment_due, maturity_date: raw.maturity_date === undefined ? addMonths(first_payment_due, term_months - 1) : date(raw.maturity_date, "maturity_date"), term_months,
    consummation_date: date(need(raw, "consummation_date", what), "consummation_date"), rounding_rule,
    interest_only_until: raw.interest_only_until === undefined || raw.interest_only_until === null ? null : date(raw.interest_only_until, "interest_only_until"),
    payment_change_period_months: raw.payment_change_period_months === undefined || raw.payment_change_period_months === null ? null : int(raw.payment_change_period_months, "payment_change_period_months", 1),
    conversion_option: raw.conversion_option === true, initial_disclosure_estimate: raw.initial_disclosure_estimate === true,
    escrow_cents: raw.escrow_cents === undefined ? 0n : cents(raw.escrow_cents, "escrow_cents"), fdcpa_cease_on_file: raw.fdcpa_cease_on_file === true, fdcpa_debt_collector: raw.fdcpa_debt_collector === true,
    schedule_basis, version: raw.version === undefined ? 1 : int(raw.version, "version", 1),
  };
}
export function loadTerms(deps: OpsDeps, loanId: string): ArmTerms {
  const t = rec<Record<string, unknown>>(deps, "loan_terms", loanId);
  if (!t) throw new RangeError(`no loan_terms for ${loanId}`);
  return parseArmTerms(t);
}

// ---- schedule (data model `arm_schedule`) -------------------------------------------------------------------------
export type RowStatus = "scheduled" | "index_pending" | "calculated" | "verified" | "discrepancy" | "notice_sent" | "effective" | "reported" | "closed" | "cancelled";
export interface ArmScheduleRow {
  readonly loan_id: string; readonly change_date: PlainDate; readonly index_date: PlainDate; readonly first_new_payment_due: PlainDate;
  readonly notice_window_open: PlainDate | null; readonly notice_due_by: PlainDate; readonly notice_kind: NoticeKind;
  readonly initial: boolean; readonly frequent_adjuster: boolean; readonly status: RowStatus; readonly timers_armed: boolean;
}
export const rowId = (loanId: string, changeDate: PlainDate): string => `${loanId}:${changeDate}`;
/**
 * Which (c) timing row applies (§1026.20(c)(1)(ii), (c)(2)): terms of one year or less → exempt; the first adjustment
 * with the first adjusted payment due within 210 days of consummation and a non-estimated (d) → exempt; the first
 * adjustment within 60 days of consummation after an estimated (d) → 25 days as soon as practicable; adjustments every
 * 60 days or more frequently, or pre-2015-01-10 loans with a look-back under 45 days → 25–120; otherwise 60–120.
 * Exempt rows still get Fannie Mae's C-2.1-02 notice (`fnma_only`, decision 4).
 */
export function noticeKindFor(terms: Pick<ArmTerms, "term_months" | "consummation_date" | "initial_disclosure_estimate" | "adjustment_period_months" | "lookback_days">, initial: boolean, changeDate: PlainDate, firstNewPaymentDue: PlainDate): NoticeKind {
  if (terms.term_months <= 12) return "fnma_only";
  if (initial && daysBetween(terms.consummation_date, firstNewPaymentDue) <= 210 && !terms.initial_disclosure_estimate) return "fnma_only";
  if (initial && daysBetween(terms.consummation_date, changeDate) <= 60 && terms.initial_disclosure_estimate) return "c_first_25";
  if (terms.adjustment_period_months <= 2 || (terms.consummation_date < "2015-01-10" && terms.lookback_days < 45)) return "c_25_120";
  return "c_60_120";
}
/** Every change date from the first to maturity (spec input 1: "build `arm_schedule` (all change dates to maturity)"). */
export function buildSchedule(terms: ArmTerms): ArmScheduleRow[] {
  const rows: ArmScheduleRow[] = []; const dueDay = parts(terms.first_payment_due).d;
  for (let d = terms.first_change_date, i = 0; d < terms.maturity_date && i < 720; d = addMonths(terms.first_change_date, (i + 1) * terms.adjustment_period_months), i++) {
    const fnpd = nextDueAfter(d, dueDay); const kind = noticeKindFor(terms, i === 0, d, fnpd);
    rows.push({ loan_id: terms.loan_id, change_date: d, index_date: indexDateOf(d, terms.lookback_days), first_new_payment_due: fnpd,
      notice_window_open: kind === "c_60_120" || kind === "c_25_120" ? addDays(fnpd, -120) : null,
      notice_due_by: kind === "c_60_120" ? addDays(fnpd, -60) : kind === "fnma_only" ? addDays(d, -25) : addDays(fnpd, -25),
      notice_kind: kind, initial: i === 0, frequent_adjuster: kind === "c_25_120", status: "scheduled", timers_armed: false });
  }
  if (!rows.length) throw new RangeError(`no change date before maturity ${terms.maturity_date} (first change ${terms.first_change_date})`);
  return rows;
}
export function loadRow(deps: OpsDeps, loanId: string, changeDate: PlainDate): ArmScheduleRow {
  const r = rec<ArmScheduleRow>(deps, "arm_schedule", rowId(loanId, changeDate));
  if (!r) throw new RangeError(`no arm_schedule row for ${loanId} change date ${changeDate}`);
  return r;
}
const rowPayload = (r: ArmScheduleRow): Record<string, unknown> => ({ change_date: r.change_date, index_date: r.index_date, first_new_payment_due: r.first_new_payment_due, notice_window_open: r.notice_window_open, notice_due_by: r.notice_due_by, notice_kind: r.notice_kind, initial: r.initial, frequent_adjuster: r.frequent_adjuster, status: r.status });
/** Arm the clocks for the next change: `arm.schedule.row_created` for the earliest un-armed row on/after today (spec input 1: "schedule timers for the next change"). */
export function scheduleNextChange(deps: OpsDeps, loanId: string): { row: ArmScheduleRow; event: DomainEvent } | null {
  const t = today(deps);
  const next = deps.store.list("arm_schedule", (d) => d.loan_id === loanId && d.status === "scheduled" && d.timers_armed !== true && String(d.change_date) >= t)
    .map((r) => r.data as unknown as ArmScheduleRow).sort((a, b) => (a.change_date < b.change_date ? -1 : 1))[0];
  if (!next) return null;
  const row: ArmScheduleRow = { ...next, timers_armed: true, status: "index_pending" };
  put(deps, "arm_schedule", rowId(loanId, row.change_date), { ...row });
  const event = append(deps, "arm.schedule.row_created", loanId, { ...rowPayload(row), lookback_days: daysBetween(row.index_date, row.change_date), armed_on: t });
  return { row, event };
}
/** `loan.boarded` with `loan_terms.product = ARM`: store the terms, build the schedule, arm the next change. */
export function boardArmTerms(deps: OpsDeps, raw: unknown): { terms: ArmTerms; rows: ArmScheduleRow[]; armed: { row: ArmScheduleRow; event: DomainEvent } | null } {
  const terms = parseArmTerms(raw);
  put(deps, "loan_terms", terms.loan_id, { ...terms });
  const rows = buildSchedule(terms);
  for (const r of rows) if (!deps.store.get("arm_schedule", rowId(terms.loan_id, r.change_date))) put(deps, "arm_schedule", rowId(terms.loan_id, r.change_date), { ...r });
  append(deps, "arm.schedule.built", terms.loan_id, { rows: rows.length, first_change_date: terms.first_change_date, maturity_date: terms.maturity_date, fnma_arm_plan: terms.fnma_arm_plan, index_type: terms.index_type });
  return { terms, rows, armed: scheduleNextChange(deps, terms.loan_id) };
}

// ---- index feed (data model `arm_index_captures`) -----------------------------------------------------------------
export type IndexSource = "nyfed_api" | "frb_h15" | "vendor_feed" | "manual";
export interface IndexCapture {
  readonly capture_id: string; readonly index_type: IndexType; readonly effective_date: PlainDate; readonly value: string; readonly source: IndexSource;
  readonly revision_of: string | null; readonly revision_indicator: string | null; readonly dual_control: boolean; readonly evidence_ids: readonly string[]; readonly approvers: readonly string[]; readonly captured_at: string; readonly superseded_by: string | null;
}
const FIVE_DP = /^\d+(\.\d{1,5})?$/;
/** Parse an inbound index record: the NY Fed `refRates[]` shape (`effectiveDate`, `type` "SOFRAI", `average30day`, `revisionIndicator`) or the platform shape (`index_type`, `effective_date`, `value`, `source`, evidence). */
export function parseIndexRecord(raw: unknown): Omit<IndexCapture, "capture_id" | "revision_of" | "captured_at" | "superseded_by"> {
  if (!isRecord(raw)) throw new RangeError("index record: a record is required");
  if (raw.type === "SOFRAI" || raw.effectiveDate !== undefined) {
    if (raw.type !== "SOFRAI") throw new RangeError(`index record: type ${String(raw.type)} is not SOFRAI`);
    const value = String(need(raw, "average30day", "NY Fed record"));
    if (!FIVE_DP.test(value)) throw new RangeError(`NY Fed record: average30day ${JSON.stringify(raw.average30day)} is not a five-decimal value`);
    return { index_type: "SOFR_30D_AVG", effective_date: date(need(raw, "effectiveDate", "NY Fed record"), "effectiveDate"), value, source: "nyfed_api", revision_indicator: typeof raw.revisionIndicator === "string" && raw.revisionIndicator ? raw.revisionIndicator : null, dual_control: false, evidence_ids: [], approvers: [] };
  }
  const index_type = String(need(raw, "index_type", "index record")) as IndexType;
  if (!INDEX_TYPES.includes(index_type)) throw new RangeError(`index record: index_type ${index_type} is not one of ${INDEX_TYPES.join(", ")}`);
  const source = String(need(raw, "source", "index record")) as IndexSource;
  if (!["nyfed_api", "frb_h15", "vendor_feed", "manual"].includes(source)) throw new RangeError(`index record: source ${source} is not nyfed_api/frb_h15/vendor_feed/manual`);
  const value = String(need(raw, "value", "index record"));
  if (!FIVE_DP.test(value)) throw new RangeError(`index record: value ${JSON.stringify(raw.value)} is not a five-decimal value`);
  const evidence_ids = Array.isArray(raw.evidence_ids) ? raw.evidence_ids.map(String) : [];
  const approvers = [...new Set(Array.isArray(raw.approvers) ? raw.approvers.map(String) : [])];
  const fallback = source === "vendor_feed" || source === "manual";
  const dual_control = approvers.length >= 2 && evidence_ids.length > 0;
  if (fallback && !dual_control) throw new RangeError(`index record: a ${source} capture needs dual control — two distinct approvers (${approvers.length}) and evidence (${evidence_ids.length}) (7.2 index-feed prerequisite; T12)`);
  return { index_type, effective_date: date(need(raw, "effective_date", "index record"), "effective_date"), value, source, revision_indicator: typeof raw.revision_indicator === "string" && raw.revision_indicator ? raw.revision_indicator : null, dual_control, evidence_ids, approvers };
}
/** Idempotent upsert keyed by (type, effective_date); a different value for a captured date is a revision (`revision_of`), never an overwrite. */
export function captureIndex(deps: OpsDeps, raw: unknown): { capture: IndexCapture; event: DomainEvent | null; duplicate: boolean; revision: boolean } {
  const p = parseIndexRecord(raw);
  const current = deps.store.list("arm_index_captures", (d) => d.index_type === p.index_type && d.effective_date === p.effective_date && d.superseded_by === null).map((r) => r.data as unknown as IndexCapture)[0];
  if (current && current.value === p.value) return { capture: current, event: null, duplicate: true, revision: false };
  const n = deps.store.list("arm_index_captures", (d) => d.index_type === p.index_type && d.effective_date === p.effective_date).length + 1;
  const capture: IndexCapture = { ...p, capture_id: `${p.index_type}:${p.effective_date}:${n}`, revision_of: current ? current.capture_id : null, captured_at: deps.now, superseded_by: null };
  put(deps, "arm_index_captures", capture.capture_id, { ...capture, evidence_ids: [...capture.evidence_ids], approvers: [...capture.approvers] });
  if (current) put(deps, "arm_index_captures", current.capture_id, { ...current, superseded_by: capture.capture_id });
  const event = deps.events.append({ type: "arm.index.captured", actor: deps.actor, aggregate: { kind: "arm_index_capture", id: capture.capture_id }, payload: { capture_id: capture.capture_id, index_type: capture.index_type, effective_date: capture.effective_date, value: capture.value, source: capture.source, revision_of: capture.revision_of, revision_indicator: capture.revision_indicator, dual_control: capture.dual_control, evidence_ids: [...capture.evidence_ids], approvers: [...capture.approvers] } });
  return { capture, event, duplicate: false, revision: current !== undefined };
}
export function indexObservations(deps: OpsDeps, indexType: IndexType): (IndexObs & { readonly capture_id: string; readonly source: IndexSource })[] {
  return deps.store.list("arm_index_captures", (d) => d.index_type === indexType && d.superseded_by === null).map((r) => r.data as unknown as IndexCapture).map((c) => ({ effective_date: c.effective_date, value: c.value, capture_id: c.capture_id, source: c.source }));
}
/** NY Fed outage bookkeeping (edge "Index unavailable/delayed"): each failed daily capture is a loan-independent event; two failed days alert. */
export function recordIndexFeedFailure(deps: OpsDeps, f: { on: PlainDate; status: number; endpoint?: string }): { event: DomainEvent; failed_days: number; alert: boolean } {
  const status = int(f.status, "status", 100);
  const event = deps.events.append({ type: "arm.index.feed_failed", actor: deps.actor, aggregate: { kind: "index_feed", id: "nyfed" }, payload: { on: f.on, status, endpoint: f.endpoint ?? INDEX_DESCRIPTIONS.SOFR_30D_AVG.url } });
  const failed_days = new Set(feedFailures(deps).filter((x) => x.status >= 500).map((x) => x.on)).size;
  return { event, failed_days, alert: failed_days >= 2 };
}
const feedFailures = (deps: OpsDeps): { on: PlainDate; status: number }[] => deps.events.ofType("arm.index.feed_failed").map((e) => ({ on: plainDate(String(e.payload.on)), status: Number(e.payload.status) }));
/** The fallback capture: permitted only after the API has failed on two days, and only with dual-control evidence; the value is captured on the correct index date (T12). */
export function captureIndexFallback(deps: OpsDeps, f: { index_date: PlainDate; fallback: { source: "vendor_feed" | "manual"; value: string; effective_date: PlainDate; evidence_ids: readonly string[]; approvers: readonly string[]; index_type?: IndexType } }): { alert: boolean; decision: ReturnType<typeof indexCaptureFallback>; capture: IndexCapture; event: DomainEvent | null } {
  const decision = indexCaptureFallback({ index_date: f.index_date, api_failures: feedFailures(deps), fallback: { ...f.fallback } });
  if (!decision.alert) throw new RangeError(`index fallback refused: the NY Fed API has not failed on two days (failed days ${new Set(feedFailures(deps).filter((x) => x.status >= 500).map((x) => x.on)).size}) — use the API value`);
  if (decision.source !== "fallback") throw new RangeError("index fallback refused: dual control requires two distinct approvers, evidence, and an effective date on or before the index date (7.2 T12)");
  const c = captureIndex(deps, { index_type: f.fallback.index_type ?? "SOFR_30D_AVG", effective_date: f.fallback.effective_date, value: f.fallback.value, source: f.fallback.source, evidence_ids: [...f.fallback.evidence_ids], approvers: [...f.fallback.approvers] });
  return { alert: true, decision, capture: c.capture, event: c.event };
}

// ---- adjustment (data model `arm_adjustments`) --------------------------------------------------------------------
export type AdjustmentStatus = "calculated" | "discrepancy" | "verified" | "noticed" | "effective" | "reported" | "corrected" | "superseded";
export interface CapTest { readonly periodic_limit: readonly [string, string]; readonly lifetime_limit: string; readonly floor: string; readonly applied: RateBound; readonly foregone: "0"; }
export interface ArmAdjustment {
  readonly loan_id: string; readonly change_date: PlainDate; readonly index_date: PlainDate; readonly index_value: string; readonly index_publication_date: PlainDate; readonly index_capture_id: string; readonly index_source: IndexSource;
  readonly margin_pct: string; readonly unrounded_pct: string; readonly rounded_pct: string; readonly cap_test: CapTest; readonly new_rate_pct: string; readonly prior_rate_pct: string;
  readonly expected_upb_cents: Cents; readonly remaining_term_months: number; readonly new_pi_cents: Cents; readonly prior_pi_cents: Cents; readonly escrow_cents: Cents; readonly first_new_payment_due: PlainDate;
  readonly payment_change_deferred_to_payment_change_date: boolean; readonly midpoint_flag: boolean; readonly qc_sample: boolean; readonly calculation_date: PlainDate;
  readonly engine_input: ArmAdjustmentInput; readonly engine_a: ArmAdjustmentResult; readonly engine_b: (ArmAdjustmentResult & { agrees: boolean | null; discrepancy: string | null }) | null;
  readonly status: AdjustmentStatus; readonly verified_by: "engine_b" | "human" | null; readonly verified_on: PlainDate | null; readonly notice_id: string | null; readonly notice_template: string | null; readonly investor_event_id: string | null; readonly correction_of: string | null;
  readonly payment_change_deferred: boolean; readonly payment_effective_due: PlainDate;
}
export function loadAdjustment(deps: OpsDeps, loanId: string, changeDate: PlainDate): ArmAdjustment {
  const a = rec<ArmAdjustment>(deps, "arm_adjustments", rowId(loanId, changeDate));
  if (!a) throw new RangeError(`no arm_adjustments row for ${loanId} change date ${changeDate} — run computeArmAdjustment first`);
  return a;
}
/** F-1-01 / the note: "the unpaid principal that I am expected to owe at the Change Date" — scheduled balance after the payment due on the change date, all contractual payments through it assumed made. */
export function expectedUpbAt(terms: ArmTerms, changeDate: PlainDate): Cents {
  const b = terms.schedule_basis; const months = monthsBetween(b.from_due_date, changeDate) + 1;
  if (months < 0) throw new RangeError(`schedule basis ${b.from_due_date} is after the change date ${changeDate}`);
  if (terms.interest_only_until !== null && changeDate <= terms.interest_only_until) return b.upb_cents;
  return scheduledUpbAfter(b.upb_cents, b.rate_pct, b.pi_cents, months);
}
/** Rule 3: months from `first_new_payment_due` to maturity inclusive. */
export const remainingTermAt = (terms: ArmTerms, firstNewPaymentDue: PlainDate): number => monthsBetween(firstNewPaymentDue, terms.maturity_date) + 1;
const roundingOf = (t: ArmTerms): "half_down" | "half_up" => (t.rounding_rule === "nearest_eighth_half_up" ? "half_up" : "half_down");
/**
 * Rules 1–3: the index is the latest publication on/before `change_date − lookback_days`; engine A computes the rate
 * (round to the nearest 1/8, caps, floor) and the payment on the expected UPB over the remaining term; a legacy
 * payment-cap plan whose payment cycle does not fall on this change keeps the payment (rate-only change, C-2.1-02).
 */
export function calculateAdjustment(deps: OpsDeps, loanId: string, changeDate: PlainDate, opts: { calculation_date?: PlainDate } = {}): { adjustment: ArmAdjustment; event: DomainEvent } {
  const terms = loadTerms(deps, loanId); const row = loadRow(deps, loanId, changeDate);
  const existing = rec<ArmAdjustment>(deps, "arm_adjustments", rowId(loanId, changeDate));
  if (existing && existing.status !== "calculated" && existing.status !== "discrepancy") throw new RangeError(`adjustment ${changeDate} on ${loanId} is ${existing.status}; the note fixes the "available" index once verified (rule 1) — a correction goes through C-2.2-01`);
  const sel = selectIndex(indexObservations(deps, terms.index_type), row.index_date);
  if (!sel) throw new RangeError(`${TIMERS.index_capture}: no ${terms.index_type} publication on or before the index date ${row.index_date} (change date ${changeDate} − ${terms.lookback_days} days)`);
  const first_change = changeDate === terms.first_change_date;
  const expected_upb_cents = expectedUpbAt(terms, changeDate); const remaining_term_months = remainingTermAt(terms, row.first_new_payment_due);
  const interest_only = terms.interest_only_until !== null && row.first_new_payment_due <= terms.interest_only_until;
  const engine_input: ArmAdjustmentInput = { index_pct: sel.value, margin_pct: terms.margin_pct, prior_rate_pct: terms.current_rate_pct, initial_note_rate_pct: terms.initial_note_rate_pct, initial_cap_pct: terms.initial_cap_pct, periodic_cap_pct: terms.periodic_cap_pct, lifetime_cap_pct: terms.lifetime_cap_pct, first_change, rounding: roundingOf(terms), expected_upb_cents, remaining_term_months, interest_only };
  const a = computeArmAdjustment(engine_input); const r = newRate(engine_input);
  const unrounded = Decimal.parse(a.unrounded_pct); const rounded = roundToEighth(unrounded, roundingOf(terms)).rate.toFixed(3);
  const prior = Decimal.parse(terms.current_rate_pct); const cap = Decimal.parse(first_change ? terms.initial_cap_pct : terms.periodic_cap_pct);
  const cap_test: CapTest = { periodic_limit: [prior.sub(cap).toFixed(3), prior.add(cap).toFixed(3)], lifetime_limit: Decimal.parse(terms.initial_note_rate_pct).add(Decimal.parse(terms.lifetime_cap_pct)).toFixed(3), floor: terms.margin_pct, applied: a.bound, foregone: "0" };
  const paymentCycle = terms.payment_change_period_months !== null && monthsBetween(terms.first_change_date, changeDate) % terms.payment_change_period_months !== 0;
  const new_pi_cents = paymentCycle ? terms.current_pi_cents : a.new_pi_cents;
  const calculation_date = opts.calculation_date ?? today(deps);
  const adjustment: ArmAdjustment = {
    loan_id: loanId, change_date: changeDate, index_date: row.index_date, index_value: sel.value, index_publication_date: sel.effective_date, index_capture_id: sel.capture_id!, index_source: sel.source! as IndexSource,
    margin_pct: terms.margin_pct, unrounded_pct: a.unrounded_pct, rounded_pct: rounded, cap_test, new_rate_pct: a.new_rate_pct, prior_rate_pct: terms.current_rate_pct,
    expected_upb_cents, remaining_term_months, new_pi_cents, prior_pi_cents: terms.current_pi_cents, escrow_cents: terms.escrow_cents, first_new_payment_due: row.first_new_payment_due,
    payment_change_deferred_to_payment_change_date: paymentCycle, midpoint_flag: r.midpoint_flag, qc_sample: a.bound !== "none" || r.midpoint_flag, calculation_date,
    engine_input, engine_a: a, engine_b: null, status: "calculated", verified_by: null, verified_on: null, notice_id: null, notice_template: null, investor_event_id: null, correction_of: existing?.correction_of ?? null,
    payment_change_deferred: false, payment_effective_due: row.first_new_payment_due,
  };
  put(deps, "arm_adjustments", rowId(loanId, changeDate), { ...adjustment });
  put(deps, "arm_schedule", rowId(loanId, changeDate), { ...row, status: "calculated" });
  const event = append(deps, "arm.adjustment.calculated", loanId, {
    change_date: changeDate, index_date: row.index_date, calculation_date, index_value: sel.value, index_publication_date: sel.effective_date, index_capture_id: sel.capture_id!, index_source: sel.source! as IndexSource,
    margin_pct: terms.margin_pct, unrounded_pct: a.unrounded_pct, rounded_pct: rounded, cap_test: { ...cap_test, periodic_limit: [...cap_test.periodic_limit] }, new_rate_pct: a.new_rate_pct, prior_rate_pct: terms.current_rate_pct, bound: a.bound, midpoint_flag: r.midpoint_flag,
    expected_upb_cents, remaining_term_months, new_pi_cents, prior_pi_cents: terms.current_pi_cents, first_new_payment_due: row.first_new_payment_due, engine: "A", qc_sample: adjustment.qc_sample, payment_deferred_to_payment_change_date: paymentCycle,
  });
  return { adjustment, event };
}
/** Facts for the `7.2.dualCalculationMatches` gate (SM_ARM_DUAL_CALC_VERIFY_T0). */
export const dualCalcFacts = (a: ArmAdjustmentResult, b: ArmAdjustmentResult): { engine_a_payment_cents: Cents; engine_b_payment_cents: Cents; engine_a_rate: string; engine_b_rate: string } =>
  ({ engine_a_payment_cents: a.new_pi_cents, engine_b_payment_cents: b.new_pi_cents, engine_a_rate: a.new_rate_pct, engine_b_rate: b.new_rate_pct });
export interface VerifyResult { readonly agrees: boolean; readonly adjustment: ArmAdjustment; readonly event: DomainEvent; readonly investor_event: DomainEvent | null; readonly payment_change_event: DomainEvent | null; readonly lar83_due_at_ms: number | null; readonly escalation_id: string | null; readonly discrepancy: string | null; }
/**
 * Engine B (BigInt fixed-point) recomputes from the recorded inputs; both must agree to the cent before anything
 * renders. Agreement → `arm.adjustment.verified` (+ rule 7's investor event for 5.1 and 14.2's payment-change event);
 * a mismatch → `arm.adjustment.discrepancy`, the row holds, ops review.
 */
export function verifyAdjustment(deps: OpsDeps, loanId: string, changeDate: PlainDate, opts: { escalations?: Escalator; servicing_fee_pct?: string } = {}): VerifyResult {
  const adj = loadAdjustment(deps, loanId, changeDate);
  if (adj.status !== "calculated" && adj.status !== "discrepancy") throw new RangeError(`adjustment ${changeDate} on ${loanId} is ${adj.status}; nothing to verify`);
  const b = verifyArmAdjustment(adj.engine_input, adj.engine_a);
  const facts = dualCalcFacts(adj.engine_a, b);
  const row = loadRow(deps, loanId, changeDate);
  if (b.agrees !== true) {
    const held: ArmAdjustment = { ...adj, engine_b: b, status: "discrepancy" };
    put(deps, "arm_adjustments", rowId(loanId, changeDate), { ...held }); put(deps, "arm_schedule", rowId(loanId, changeDate), { ...row, status: "discrepancy" });
    const event = append(deps, "arm.adjustment.discrepancy", loanId, { change_date: changeDate, ...facts, discrepancy: b.discrepancy, hold: true, timer: TIMERS.dual_calc });
    const esc = opts.escalations?.open({ kind: "human_agent", loanId, ownerRole: "ops", severity: "sev2", payload: { queue: "arm_discrepancy", change_date: changeDate, ...facts, discrepancy: b.discrepancy } }, deps.actor) ?? null;
    return { agrees: false, adjustment: held, event, investor_event: null, payment_change_event: null, lar83_due_at_ms: null, escalation_id: esc ? esc.id : null, discrepancy: b.discrepancy };
  }
  const verified_on = today(deps);
  const verified: ArmAdjustment = { ...adj, engine_b: b, status: "verified", verified_by: "engine_b", verified_on };
  put(deps, "arm_adjustments", rowId(loanId, changeDate), { ...verified }); put(deps, "arm_schedule", rowId(loanId, changeDate), { ...row, status: "verified" });
  const event = append(deps, "arm.adjustment.verified", loanId, { change_date: changeDate, index_date: adj.index_date, calculation_date: adj.calculation_date, verified_on, verified_by: "engine_b", ...facts, new_rate_pct: adj.new_rate_pct, new_pi_cents: adj.new_pi_cents, prior_rate_pct: adj.prior_rate_pct, prior_pi_cents: adj.prior_pi_cents, first_new_payment_due: adj.first_new_payment_due, qc_sample: adj.qc_sample, timer: TIMERS.dual_calc });
  // rule 7: on `verified`, the `rate_payment_change` investor event → 5.1 (LAR 83 by 20:00 ET on the 5th Fannie Mae business day after the calculation date).
  const inv = rateChangeInvestorEvent({ verified_on, calculation_date: adj.calculation_date, first_new_payment_due: adj.first_new_payment_due, index_value: adj.index_value, new_rate_pct: adj.new_rate_pct, servicing_fee_pct: opts.servicing_fee_pct ?? "0.250", new_pi_cents: adj.new_pi_cents });
  const investor_event = append(deps, inv.event.type, loanId, { ...inv.event.payload, family: "rate_change", legacy_record: 83, change_date: changeDate, calculation_date: adj.calculation_date, lar83_due_at: toIso(inv.lar83_due_at_ms), timer: inv.lar83_timer }, event.id);
  put(deps, "arm_adjustments", rowId(loanId, changeDate), { ...verified, investor_event_id: investor_event.id });
  // edge "Bankruptcy": 14.2's Rule 3002.1(b) notice needs the payment change ≥ 21 days ahead — the engine emits it at verification (≥ 60 days ahead on time).
  const pc = ch13PaymentChange({ first_new_payment_due: adj.first_new_payment_due, verified_on });
  const payment_change_event = append(deps, pc.emit, loanId, { change_date: changeDate, first_new_payment_due: adj.first_new_payment_due, new_payment_cents: adj.new_pi_cents + adj.escrow_cents, new_pi_cents: adj.new_pi_cents, prior_pi_cents: adj.prior_pi_cents, new_rate_pct: adj.new_rate_pct, emit_by: pc.emit_by, emitted_on: pc.emitted_on, on_time: pc.on_time, rule_3002_1_file_by: pc.rule_3002_1_file_by, source: "7.2" }, event.id);
  return { agrees: true, adjustment: { ...verified, investor_event_id: investor_event.id }, event, investor_event, payment_change_event, lar83_due_at_ms: inv.lar83_due_at_ms, escalation_id: null, discrepancy: null };
}

// ---- notice window and the notice ---------------------------------------------------------------------------------
const gated = (k: NoticeKind): boolean => k === "c_60_120" || k === "c_25_120";
/** The row's (c) window: [−120, −60] (or −25) around `first_new_payment_due`; sendable from the index date. */
export function windowFor(deps: OpsDeps, loanId: string, row: ArmScheduleRow): ReturnType<typeof noticeWindow> {
  return noticeWindow(row.first_new_payment_due, row.change_date, loadTerms(deps, loanId).lookback_days, row.notice_kind !== "c_60_120");
}
/** The −120 not-before gate opens with `arm.adjustment.notice_window_opened{kind=c}` (the schedule's daily sweep; §1026.20(c)(2) "no more than 120 days"). */
export function openNoticeWindow(deps: OpsDeps, loanId: string, changeDate: PlainDate, on?: PlainDate): { opened: boolean; already_open: boolean; opens_on: PlainDate | null; deadline: PlainDate; event: DomainEvent | null } {
  const row = loadRow(deps, loanId, changeDate); const w = windowFor(deps, loanId, row); const d = on ?? today(deps);
  if (!gated(row.notice_kind)) return { opened: true, already_open: true, opens_on: null, deadline: row.notice_due_by, event: null };
  if (d < w.not_before) return { opened: false, already_open: false, opens_on: w.not_before, deadline: w.deadline, event: null };
  const prior = deps.events.byLoan(loanId).find((e) => e.type === w.window_opened_event.type && e.payload.change_date === changeDate);
  if (prior) return { opened: true, already_open: true, opens_on: w.not_before, deadline: w.deadline, event: prior };
  const event = append(deps, w.window_opened_event.type, loanId, { ...w.window_opened_event.payload, change_date: changeDate, sendable_from: w.sendable_from, opened_on: d, timer: TIMERS.not_before });
  return { opened: true, already_open: false, opens_on: w.not_before, deadline: w.deadline, event };
}
export interface SendNoticeInput { readonly loan_id: string; readonly change_date: PlainDate; readonly recipients: readonly Recipient[]; readonly contact: ServicerContact; readonly send_on?: PlainDate; readonly channel_context?: ChannelContext; readonly consent_id?: string | null; }
export interface ArmNoticeResult {
  readonly template: string | null; readonly notice_id: string | null; readonly sent_on: PlainDate; readonly regz_c_notice: boolean; readonly fnma_informational: boolean;
  readonly marked_as: "required_by_contract_information" | null; readonly decision_cite: string | null; readonly late: boolean; readonly breach: { timer: string; severity: 1; days_late: number } | null;
  readonly payment_change_deferred: boolean; readonly payment_effective_due: PlainDate; readonly channel: "electronic" | "mail" | null; readonly days_before_first_payment: number; readonly decision_record: Record<string, unknown>; readonly event: DomainEvent | null;
}
const deadlineTimer = (k: NoticeKind): string => (k === "c_60_120" ? TIMERS.deadline_60 : k === "c_25_120" ? TIMERS.deadline_25 : TIMERS.first_25);
/**
 * Rule 5 content assembly + rule 6 selection + decisions 1/3/4/5. The (c) notice `NTC_REGZ_20C_ARM_ADJ` when both
 * rate and payment change on a covered loan; otherwise (rate-only / payment-only, an exempt or FDCPA §805(c) loan)
 * Fannie Mae's `NTC_FNMA_C2_1_02_RATE_CHANGE` marked as contract-required information; no notice when nothing changes.
 * Refuses before verification (dual-engine gate) and before the −120 gate opens; a send after the deadline is
 * recorded as the breach and defers the payment change one cycle (decision 5) so the borrower is still noticed
 * 60+ days before the first payment at the adjusted level. Delivery goes through the Notice Registry only.
 */
export async function sendAdjustmentNotice(deps: OpsDeps, notices: NoticeSender, input: SendNoticeInput): Promise<ArmNoticeResult> {
  const { loan_id: loanId, change_date: changeDate } = input;
  const adj = loadAdjustment(deps, loanId, changeDate); const terms = loadTerms(deps, loanId); const row = loadRow(deps, loanId, changeDate);
  if (adj.status === "noticed" || adj.status === "effective" || adj.status === "reported") throw new RangeError(`adjustment ${changeDate} on ${loanId} was already noticed (${adj.notice_id})`);
  if (adj.status !== "verified") throw new RangeError(`${TIMERS.dual_calc}: adjustment ${changeDate} on ${loanId} is ${adj.status}, not verified — both engines must agree to the cent before a notice renders`);
  if (!input.recipients.length) throw new RangeError("recipients are required (the borrower(s) and any confirmed successor in interest)");
  const sendOn = input.send_on ?? today(deps);
  const rate_changed = adj.new_rate_pct !== adj.prior_rate_pct, payment_changed = adj.new_pi_cents !== adj.prior_pi_cents;
  const fd = fdcpaCeaseArmNotice({ fdcpa_cease_on_file: terms.fdcpa_cease_on_file, debt_collector: terms.fdcpa_debt_collector });
  const sel = armNoticeSelection({ rate_changed, payment_changed, change_date: changeDate });
  const regz = sel.regz_c_notice && row.notice_kind !== "fnma_only" && fd.regz_c_notice;
  const template: string | null = regz ? TEMPLATES.regz_c : sel.regz_c_notice || sel.fnma_notice ? TEMPLATES.fnma_change : null;
  const decision_cite = !fd.regz_c_notice ? fd.decision_cite : row.notice_kind === "fnma_only" ? "12 CFR 1026.20(c)(1)(ii)" : regz ? "12 CFR 1026.20(c)" : sel.fnma_notice ? "Fannie Mae Servicing Guide C-2.1-02 (7.2 rule 6)" : null;
  const base = { sent_on: sendOn, regz_c_notice: regz, fnma_informational: template === TEMPLATES.fnma_change, marked_as: !fd.regz_c_notice ? fd.marked_as : template === TEMPLATES.fnma_change ? ("required_by_contract_information" as const) : null, decision_cite };
  if (!template) return { ...base, template: null, notice_id: null, late: false, breach: null, payment_change_deferred: false, payment_effective_due: adj.first_new_payment_due, channel: null, days_before_first_payment: daysBetween(sendOn, adj.first_new_payment_due), decision_record: { loan_id: loanId, change_date: changeDate, notice: "none", reason: "neither the rate nor the payment changes (rule 6; feature arm.no_change_courtesy_notice off)" }, event: null };
  // window / breach (regz) or the ≥ 25-day policy (Fannie Mae-only)
  const w = windowFor(deps, loanId, row);
  let breach: ArmNoticeResult["breach"] = null; let late = false;
  if (regz) {
    const check = sendCheck(sendOn, { not_before: gated(row.notice_kind) ? w.not_before : sendOn, deadline: row.notice_kind === "c_60_120" ? w.deadline : addDays(adj.first_new_payment_due, -25) }, { gate: TIMERS.not_before, deadline: deadlineTimer(row.notice_kind) });
    if (!check.allowed) throw new RangeError(`${check.blocked_by}: send blocked before ${w.not_before} (§1026.20(c)(2): no more than 120 days before the first payment at the adjusted level)`);
    breach = check.breach; late = breach !== null;
  } else if (sel.send_by !== null && sendOn > sel.send_by) late = true;
  const payment_change_deferred = regz && late;
  const payment_effective_due = payment_change_deferred ? nextDueAfter(adj.first_new_payment_due, parts(terms.first_payment_due).d) : adj.first_new_payment_due;
  const days_before_first_payment = daysBetween(sendOn, payment_effective_due);
  const figures = armNoticeFigures({ current_pi_cents: adj.prior_pi_cents, new_pi_cents: adj.new_pi_cents, escrow_cents: adj.escrow_cents });
  const desc = INDEX_DESCRIPTIONS[terms.index_type];
  const payload: Record<string, unknown> = regz
    ? { change_date: changeDate, schedule_sentence: scheduleSentence(terms.adjustment_period_months), current_rate_pct: adj.prior_rate_pct, new_rate_pct: adj.new_rate_pct, current_pi_cents: adj.prior_pi_cents, new_pi_cents: adj.new_pi_cents, first_new_payment_due: payment_effective_due,
        interest_only: adj.engine_input.interest_only === true, new_principal_cents: 0n, new_interest_cents: adj.new_pi_cents, index_name: desc.name, index_source: desc.source, index_value: adj.index_value, index_date: adj.index_publication_date, margin_pct: adj.margin_pct,
        cap_this_change_pct: changeDate === terms.first_change_date ? terms.initial_cap_pct : terms.periodic_cap_pct, lifetime_cap_pct: adj.cap_test.lifetime_limit, floor_pct: adj.cap_test.floor, cap_applied: adj.cap_test.applied !== "none", uncapped_rate_pct: adj.rounded_pct,
        expected_upb_cents: adj.expected_upb_cents, remaining_term_months: adj.remaining_term_months, escrow_cents: adj.escrow_cents, total_payment_cents: figures.total_payment_cents, current_total_cents: figures.current_total_cents, next_change_date: addMonths(changeDate, terms.adjustment_period_months),
        days_before_first_payment, notice_kind: row.notice_kind, engines_agree: true, late_notice: late, payment_change_deferred, ...input.contact }
    : { effective_date: changeDate, rate_changed, payment_changed, current_rate_pct: adj.prior_rate_pct, new_rate_pct: adj.new_rate_pct, current_payment_cents: adj.prior_pi_cents, new_payment_cents: adj.new_pi_cents, first_new_payment_due: adj.first_new_payment_due, days_before_effective: daysBetween(sendOn, changeDate), required_by_contract: true, marked_as: base.marked_as, decision_cite, ...input.contact };
  const n = notices.render({ templateCode: template, loanId, recipients: input.recipients, payload, asOf: sendOn });
  if (n.status === "held") throw new RangeError(`${template} for ${loanId} ${changeDate} is held: ${n.heldReason ?? "checklist"}`);
  const sent = await notices.send(n.id, input.channel_context ?? {});
  const channels = (sent.channelDecision ?? []).map((d) => d.channel);
  if (channels.length && channels.every((c) => c.startsWith("sms"))) throw new RangeError("ARM notices are never SMS-only (7.2 outputs: channel esign_or_mail)");
  const channel: "electronic" | "mail" = channels.some((c) => c.startsWith("mail")) ? "mail" : "electronic";
  put(deps, "arm_adjustments", rowId(loanId, changeDate), { ...adj, status: "noticed", notice_id: n.id, notice_template: template, payment_change_deferred, payment_effective_due });
  put(deps, "arm_schedule", rowId(loanId, changeDate), { ...row, status: "notice_sent" });
  const decision_record = { loan_id: loanId, change_date: changeDate, index_date: adj.index_date, index_value: adj.index_value, publication_date: adj.index_publication_date, unrounded: adj.unrounded_pct, rounded: adj.rounded_pct, cap_test: adj.cap_test, new_rate: adj.new_rate_pct, expected_upb: adj.expected_upb_cents, remaining_term: adj.remaining_term_months, new_pi: adj.new_pi_cents,
    notice_window: { not_before: gated(row.notice_kind) ? w.not_before : null, deadline: row.notice_due_by }, sent_at: deps.now, consent_id: input.consent_id ?? null, channel, versions: { loan_terms: terms.version, template: n.templateVersion ?? null }, template, cite: decision_cite, marked_as: base.marked_as, late, payment_change_deferred, rule_set_version: RULE_SET_VERSION };
  const event = append(deps, "arm.adjustment.noticed", loanId, { change_date: changeDate, template, notice_id: n.id, sent_on: sendOn, channel, regz_c_notice: regz, marked_as: base.marked_as, decision_cite, late, breach_timer: breach ? breach.timer : null, days_late: breach ? breach.days_late : 0, payment_change_deferred, payment_effective_due, days_before_first_payment });
  return { ...base, template, notice_id: n.id, late, breach, payment_change_deferred, payment_effective_due, channel, days_before_first_payment, decision_record, event };
}
/** The change date: the new `loan_terms` version activates (2.1 accrues at the new rate; 7.1 shows it), the row is `effective`, and the next change is armed. A deferred payment change (decision 5) starts one cycle later; the servicer funds the shortage (C-2.1-01). */
export function makeEffective(deps: OpsDeps, loanId: string, changeDate: PlainDate, on?: PlainDate): { terms: ArmTerms; events: DomainEvent[]; next: { row: ArmScheduleRow; event: DomainEvent } | null; servicer_shortage_cents: Cents } {
  const adj = loadAdjustment(deps, loanId, changeDate); const terms = loadTerms(deps, loanId); const row = loadRow(deps, loanId, changeDate); const d = on ?? today(deps);
  if (d < changeDate) throw new RangeError(`change date ${changeDate} has not arrived (${d})`);
  if (adj.status !== "noticed" && adj.status !== "verified") throw new RangeError(`adjustment ${changeDate} on ${loanId} is ${adj.status}; a covered loan adjusts only after the notice (status noticed) or, with nothing to notice, after verification`);
  if (adj.status === "verified" && (adj.new_rate_pct !== adj.prior_rate_pct || adj.new_pi_cents !== adj.prior_pi_cents)) throw new RangeError(`adjustment ${changeDate} on ${loanId} changes the rate or payment but no notice was sent`);
  const servicer_shortage_cents = adj.payment_change_deferred ? adj.new_pi_cents - adj.prior_pi_cents : 0n;
  const next: ArmTerms = { ...terms, current_rate_pct: adj.new_rate_pct, current_pi_cents: adj.new_pi_cents, schedule_basis: { upb_cents: adj.expected_upb_cents, rate_pct: adj.new_rate_pct, pi_cents: adj.new_pi_cents, from_due_date: adj.first_new_payment_due }, version: terms.version + 1 };
  put(deps, "loan_terms", loanId, { ...next });
  const activated = append(deps, "loan_terms.version.activated", loanId, { version: next.version, effective_on: changeDate, rate_pct: next.current_rate_pct, pi_cents: next.current_pi_cents, payment_effective_due: adj.payment_effective_due, next_change_date: addMonths(changeDate, terms.adjustment_period_months), reason: "arm_adjustment" });
  const effective = append(deps, "arm.adjustment.effective", loanId, { change_date: changeDate, new_rate_pct: adj.new_rate_pct, new_pi_cents: adj.new_pi_cents, payment_effective_due: adj.payment_effective_due, payment_change_deferred: adj.payment_change_deferred, servicer_shortage_cents, loan_terms_version: next.version }, activated.id);
  put(deps, "arm_adjustments", rowId(loanId, changeDate), { ...adj, status: adj.investor_event_id && deps.events.byLoan(loanId).some((e) => e.type === "investor_events.accepted" && e.payload.projected_event_id === adj.investor_event_id) ? "reported" : "effective" });
  put(deps, "arm_schedule", rowId(loanId, changeDate), { ...row, status: "effective" });
  return { terms: next, events: [activated, effective], next: scheduleNextChange(deps, loanId), servicer_shortage_cents };
}

// ---- temporary buydowns (C-2.1-02) ----------------------------------------------------------------------------------
export interface BuydownStep { readonly step_date: PlainDate; readonly current_effective_rate_pct: string; readonly new_effective_rate_pct: string; readonly note_rate_pct: string; readonly current_pi_cents: Cents; readonly new_pi_cents: Cents; }
/** The 1.1 buydown schedule (2-1, 1-0…) validated and each step appended as `buydown.step.scheduled{step_date}` — the 90-day clock's trigger and anchor. */
export function scheduleBuydownSteps(deps: OpsDeps, loanId: string, raw: readonly unknown[]): { steps: BuydownStep[]; events: DomainEvent[] } {
  if (!Array.isArray(raw) || !raw.length) throw new RangeError("buydown schedule: at least one step is required");
  const steps: BuydownStep[] = raw.map((r, i) => {
    if (!isRecord(r)) throw new RangeError(`buydown step ${i + 1}: a record is required`);
    const s: BuydownStep = { step_date: date(need(r, "step_date", `buydown step ${i + 1}`), "step_date"), current_effective_rate_pct: pct(need(r, "current_effective_rate_pct", "buydown step"), "current_effective_rate_pct"), new_effective_rate_pct: pct(need(r, "new_effective_rate_pct", "buydown step"), "new_effective_rate_pct"), note_rate_pct: pct(need(r, "note_rate_pct", "buydown step"), "note_rate_pct"), current_pi_cents: cents(need(r, "current_pi_cents", "buydown step"), "current_pi_cents"), new_pi_cents: cents(need(r, "new_pi_cents", "buydown step"), "new_pi_cents") };
    if (Decimal.parse(s.new_effective_rate_pct).cmp(Decimal.parse(s.note_rate_pct)) > 0) throw new RangeError(`buydown step ${s.step_date}: the effective rate ${s.new_effective_rate_pct} exceeds the note rate ${s.note_rate_pct}`);
    if (Decimal.parse(s.new_effective_rate_pct).cmp(Decimal.parse(s.current_effective_rate_pct)) <= 0 || s.new_pi_cents <= s.current_pi_cents) throw new RangeError(`buydown step ${s.step_date}: a temporary buydown steps the rate and payment up (C-2.1-02 "pending interest rate increase")`);
    return s;
  });
  for (let i = 1; i < steps.length; i++) if (steps[i]!.step_date <= steps[i - 1]!.step_date) throw new RangeError("buydown schedule: step dates must ascend");
  const events = steps.map((s) => {
    const n = buydownStepNotice(s.step_date);
    put(deps, "buydown_steps", rowId(loanId, s.step_date), { loan_id: loanId, ...s, notice_send_by: n.send_by, status: "scheduled" });
    return append(deps, "buydown.step.scheduled", loanId, { step_date: s.step_date, payment_change_date: s.step_date, first_new_payment_due: s.step_date, current_effective_rate_pct: s.current_effective_rate_pct, new_effective_rate_pct: s.new_effective_rate_pct, note_rate_pct: s.note_rate_pct, current_pi_cents: s.current_pi_cents, new_pi_cents: s.new_pi_cents, notice_send_by: n.send_by, template: n.template, timer: n.timer });
  });
  return { steps, events };
}
/** `NTC_FNMA_C2_1_02_BUYDOWN_STEP_90` through the Notice Registry (the checklist enforces ≥ 90 days); `notice.sent{template=…}` closes the clock. */
export async function sendBuydownStepNotice(deps: OpsDeps, notices: NoticeSender, input: { loan_id: string; step_date: PlainDate; recipients: readonly Recipient[]; contact: ServicerContact; send_on?: PlainDate; channel_context?: ChannelContext }): Promise<{ template: string; notice_id: string; sent_on: PlainDate; send_by: PlainDate; late: boolean; days_before_change: number; event: DomainEvent }> {
  const s = rec<BuydownStep & { notice_send_by: PlainDate; status: string }>(deps, "buydown_steps", rowId(input.loan_id, input.step_date));
  if (!s) throw new RangeError(`no buydown step ${input.step_date} scheduled on ${input.loan_id}`);
  const sendOn = input.send_on ?? today(deps); const days_before_change = daysBetween(sendOn, s.step_date);
  const n = notices.render({ templateCode: TEMPLATES.buydown, loanId: input.loan_id, recipients: input.recipients, payload: { step_date: s.step_date, current_effective_rate_pct: s.current_effective_rate_pct, new_effective_rate_pct: s.new_effective_rate_pct, note_rate_pct: s.note_rate_pct, current_pi_cents: s.current_pi_cents, new_pi_cents: s.new_pi_cents, first_new_payment_due: s.step_date, days_before_change, ...input.contact }, asOf: sendOn });
  if (n.status === "held") throw new RangeError(`${TEMPLATES.buydown} for ${input.loan_id} ${s.step_date} is held: ${n.heldReason ?? "checklist"}`);
  await notices.send(n.id, input.channel_context ?? {});
  put(deps, "buydown_steps", rowId(input.loan_id, s.step_date), { ...s, status: "noticed", notice_id: n.id });
  const late = sendOn > s.notice_send_by;
  const event = append(deps, "buydown.step.noticed", input.loan_id, { step_date: s.step_date, notice_id: n.id, template: TEMPLATES.buydown, sent_on: sendOn, send_by: s.notice_send_by, late, days_before_change });
  return { template: TEMPLATES.buydown, notice_id: n.id, sent_on: sendOn, send_by: s.notice_send_by, late, days_before_change, event };
}

// ---- error suspicion, inquiry response, confirmation, correction (C-2.2-01 / C-2.2-03 / F-1-01) --------------------
export type InquirySource = "borrower_inquiry" | "qc_sample" | "index_revision" | "boarding_audit";
export const INQUIRY_SOURCES: readonly InquirySource[] = ["borrower_inquiry", "qc_sample", "index_revision", "boarding_audit"];
export interface ArmInquiry { readonly inquiry_id: string; readonly loan_id: string; readonly received_on: PlainDate; readonly source: InquirySource; readonly issue: string; readonly change_date: PlainDate | null; readonly interim_response_due: PlainDate; readonly status: "suspected" | "interim_sent" | "resolved"; readonly resolved_on: PlainDate | null; readonly outcome: "no_error" | "error_confirmed" | null; }
/** `arm.error.suspected{received_on}` — a borrower inquiry (via 4.2), a QC sample, an index revision or a boarding audit; the 20-day interim-response clock anchors on receipt. */
export function receiveArmInquiry(deps: OpsDeps, loanId: string, raw: { received_on?: PlainDate; source: InquirySource | string; issue: string; change_date?: PlainDate | null; inquiry_id?: string }): { inquiry: ArmInquiry; event: DomainEvent } {
  const source = String(raw.source) as InquirySource;
  if (!INQUIRY_SOURCES.includes(source)) throw new RangeError(`arm inquiry source ${source} is not one of ${INQUIRY_SOURCES.join(", ")}`);
  if (!raw.issue || !String(raw.issue).trim()) throw new RangeError("arm inquiry: issue is required");
  const received_on = raw.received_on ?? today(deps);
  const n = deps.store.list("arm_inquiries", (d) => d.loan_id === loanId).length + 1;
  const inquiry: ArmInquiry = { inquiry_id: raw.inquiry_id ?? `${loanId}:inq-${n}`, loan_id: loanId, received_on, source, issue: String(raw.issue).trim(), change_date: raw.change_date ?? null, interim_response_due: addDays(received_on, 20), status: "suspected", resolved_on: null, outcome: null };
  put(deps, "arm_inquiries", inquiry.inquiry_id, { ...inquiry });
  const event = append(deps, "arm.error.suspected", loanId, { inquiry_id: inquiry.inquiry_id, received_on, source, issue: inquiry.issue, change_date: inquiry.change_date, interim_response_due: inquiry.interim_response_due, timer: TIMERS.interim });
  return { inquiry, event };
}
const loadInquiry = (deps: OpsDeps, id: string): ArmInquiry => { const q = rec<ArmInquiry>(deps, "arm_inquiries", id); if (!q) throw new RangeError(`no arm inquiry ${id}`); return q; };
/** C-2.2-01: "send an interim response if a borrower inquiry cannot be resolved within 20 days" — `NTC_ARM_INQUIRY_INTERIM_20` through the registry (checklist: ≤ 20 days), recorded as the inquiry's response. */
export async function sendInterimResponse(deps: OpsDeps, notices: NoticeSender, input: { loan_id: string; inquiry_id: string; expected_resolution_date: PlainDate; recipients: readonly Recipient[]; contact: ServicerContact; send_on?: PlainDate; channel_context?: ChannelContext }): Promise<{ notice_id: string; sent_on: PlainDate; days_after_receipt: number; event: DomainEvent }> {
  const q = loadInquiry(deps, input.inquiry_id); if (q.loan_id !== input.loan_id) throw new RangeError(`inquiry ${q.inquiry_id} is on ${q.loan_id}, not ${input.loan_id}`);
  if (q.status === "resolved") throw new RangeError(`inquiry ${q.inquiry_id} was resolved on ${q.resolved_on}; no interim response`);
  const sendOn = input.send_on ?? today(deps); const days_after_receipt = daysBetween(q.received_on, sendOn);
  if (input.expected_resolution_date <= sendOn) throw new RangeError("expected_resolution_date must be after the interim response date");
  const n = notices.render({ templateCode: TEMPLATES.interim, loanId: q.loan_id, recipients: input.recipients, payload: { received_date: q.received_on, issue: q.issue, expected_resolution_date: input.expected_resolution_date, days_after_receipt, ...input.contact }, asOf: sendOn });
  if (n.status === "held") throw new RangeError(`${TEMPLATES.interim} for ${q.inquiry_id} is held: ${n.heldReason ?? "checklist"}`);
  await notices.send(n.id, input.channel_context ?? {});
  put(deps, "arm_inquiries", q.inquiry_id, { ...q, status: "interim_sent", interim_notice_id: n.id });
  const event = append(deps, "arm.inquiry.responded", q.loan_id, { inquiry_id: q.inquiry_id, response: "interim_notice", notice_id: n.id, template: TEMPLATES.interim, responded_on: sendOn, days_after_receipt, expected_resolution_date: input.expected_resolution_date, timer: TIMERS.interim });
  return { notice_id: n.id, sent_on: sendOn, days_after_receipt, event };
}
export interface ErrorConfirmation { readonly confirmed_on?: PlainDate; readonly first_erroneous_change_date: PlainDate; readonly booked_margin_pct: string; readonly correct_margin_pct: string; readonly inquiry_id?: string | null; readonly source?: InquirySource; }
/** `arm.error.confirmed{confirmed_on}` — the C-2.2-01 60-day correction clock anchors on the confirmation date. */
export function confirmArmError(deps: OpsDeps, loanId: string, c: ErrorConfirmation): { correction_id: string; event: DomainEvent; correct_by: PlainDate } {
  const booked = pct(c.booked_margin_pct, "booked_margin_pct"), correct = pct(c.correct_margin_pct, "correct_margin_pct");
  if (Decimal.parse(booked).cmp(Decimal.parse(correct)) === 0) throw new RangeError("the booked and correct margins are equal — no adjustment error to confirm");
  const first = date(c.first_erroneous_change_date, "first_erroneous_change_date"); const confirmed_on = c.confirmed_on ?? today(deps);
  const correction_id = `${loanId}:corr-${first}`; const correct_by = addDays(confirmed_on, 60);
  put(deps, "arm_corrections", correction_id, { correction_id, loan_id: loanId, detected_at: deps.now, confirmed_on, first_erroneous_change_date: first, booked_margin_pct: booked, correct_margin_pct: correct, inquiry_id: c.inquiry_id ?? null, source: c.source ?? "boarding_audit", correct_by, status: "confirmed", reamortization: null, net_effect_cents: null, remedy: null, borrower_election: null, irr_discussed_at: null, fnma_reported_at: null });
  const event = append(deps, "arm.error.confirmed", loanId, { correction_id, inquiry_id: c.inquiry_id ?? null, confirmed_on, first_erroneous_change_date: first, booked_margin_pct: booked, correct_margin_pct: correct, correct_by, timer: TIMERS.correct });
  return { correction_id, event, correct_by };
}
/** The inquiry's resolution within (or after) 20 days: `arm.correction.resolved` (the spec's event) and the response record that closes the interim clock; a confirmed error opens the correction. */
export function resolveArmInquiry(deps: OpsDeps, loanId: string, inquiryId: string, r: { resolved_on?: PlainDate; outcome: "no_error" | "error_confirmed"; confirmation?: Omit<ErrorConfirmation, "inquiry_id" | "confirmed_on"> }): { events: DomainEvent[]; correction_id: string | null; days_after_receipt: number; within_20_days: boolean } {
  const q = loadInquiry(deps, inquiryId); if (q.loan_id !== loanId) throw new RangeError(`inquiry ${inquiryId} is on ${q.loan_id}, not ${loanId}`);
  if (q.status === "resolved") throw new RangeError(`inquiry ${inquiryId} is already resolved`);
  if (r.outcome !== "no_error" && r.outcome !== "error_confirmed") throw new RangeError(`outcome ${String(r.outcome)} is not no_error/error_confirmed`);
  const resolved_on = r.resolved_on ?? today(deps); const days_after_receipt = daysBetween(q.received_on, resolved_on); const within_20_days = days_after_receipt <= 20;
  put(deps, "arm_inquiries", inquiryId, { ...q, status: "resolved", resolved_on, outcome: r.outcome });
  const resolved = append(deps, "arm.correction.resolved", loanId, { inquiry_id: inquiryId, resolved_on, outcome: r.outcome, days_after_receipt, within_20_days });
  const responded = append(deps, "arm.inquiry.responded", loanId, { inquiry_id: inquiryId, response: "resolved", responded_on: resolved_on, days_after_receipt, outcome: r.outcome, timer: TIMERS.interim }, resolved.id);
  if (r.outcome === "no_error") return { events: [resolved, responded], correction_id: null, days_after_receipt, within_20_days };
  if (!r.confirmation) throw new RangeError("error_confirmed needs the confirmation (first erroneous change date, booked and correct margins)");
  const c = confirmArmError(deps, loanId, { ...r.confirmation, confirmed_on: resolved_on, inquiry_id: inquiryId, source: q.source });
  return { events: [resolved, responded, c.event], correction_id: c.correction_id, days_after_receipt, within_20_days };
}
export interface CorrectionSegment { readonly correct_rate_pct: string; readonly booked_rate_pct: string; readonly months: number; readonly payment_cents: Cents; }
export interface CompleteCorrectionInput {
  readonly loan_id: string; readonly correction_id: string; readonly upb_at_first_change_cents: Cents; readonly segments: readonly CorrectionSegment[];
  readonly current: boolean; readonly advances: boolean; readonly irr_discussed_at: string | null; readonly borrower_election?: "refund" | "curtailment" | null;
  readonly recipients?: readonly Recipient[]; readonly contact?: ServicerContact; readonly completed_on?: PlainDate; readonly escalations?: Escalator; readonly channel_context?: ChannelContext;
}
export interface CorrectionResult {
  readonly completed: boolean; readonly missing: string[]; readonly reamortized_upb_cents: Cents; readonly actual_upb_cents: Cents; readonly net_effect_cents: Cents; readonly treatment: "cash_refund" | "credit_reallocation" | "absorbed";
  readonly refund_cents: Cents; readonly report_to_fnma: boolean; readonly notice_id: string | null; readonly remedy_event: DomainEvent | null; readonly investor_event: DomainEvent | null; readonly completed_event: DomainEvent | null; readonly correct_by: PlainDate; readonly within_60_days: boolean | null;
}
/**
 * Rule 8: re-amortize from the first erroneous change date at the correct rates with the actual payments; overcharge
 * > $1.00 combined → cash refund (borrower may elect curtailment treatment when current with no advances); otherwise
 * credit; an undercharge is absorbed (never collected, UPB unchanged; > $10,000 aggregate is an `officer` decision).
 * Records are corrected (new `loan_terms` version), the borrower is notified (`NTC_FNMA_C2_2_01_ARM_CORRECTION`) and
 * Fannie Mae is told only after the IRR discussion — `arm.correction.completed` carries all three flags.
 */
export async function completeCorrection(deps: OpsDeps, notices: NoticeSender | null, input: CompleteCorrectionInput): Promise<CorrectionResult> {
  const c = rec<Record<string, unknown>>(deps, "arm_corrections", input.correction_id);
  if (!c || c.loan_id !== input.loan_id) throw new RangeError(`no confirmed correction ${input.correction_id} on ${input.loan_id}`);
  if (c.status === "completed") throw new RangeError(`correction ${input.correction_id} is already complete`);
  if (!input.segments.length) throw new RangeError("correction: at least one re-amortization segment is required");
  const confirmed_on = plainDate(String(c.confirmed_on)); const first = plainDate(String(c.first_erroneous_change_date)); const correct_by = plainDate(String(c.correct_by));
  const terms = loadTerms(deps, input.loan_id);
  const m = marginErrorCorrection({ discovered_on: confirmed_on, confirmed_on, upb_at_first_change_cents: input.upb_at_first_change_cents, segments: input.segments, current: input.current, advances: input.advances, irr_discussed_at: input.irr_discussed_at });
  const completed_on = input.completed_on ?? today(deps);
  // records corrected: the correct margin on a new loan_terms version; the corrected schedule basis
  const months = input.segments.reduce((s, x) => s + x.months, 0); const last = input.segments[input.segments.length - 1]!;
  const nextDue = addMonths(nextDueAfter(first, parts(terms.first_payment_due).d), months);
  const corrected_pi_cents = newPayment(m.reamortized_upb_cents, last.correct_rate_pct, remainingTermAt(terms, nextDue));
  const recordsAlready = typeof c.records_corrected_at === "string" && c.records_corrected_at !== "";
  if (!recordsAlready) {
    const next: ArmTerms = { ...terms, margin_pct: String(c.correct_margin_pct), current_rate_pct: last.correct_rate_pct, current_pi_cents: corrected_pi_cents, schedule_basis: { upb_cents: m.reamortized_upb_cents, rate_pct: last.correct_rate_pct, pi_cents: corrected_pi_cents, from_due_date: nextDue }, version: terms.version + 1 };
    put(deps, "loan_terms", input.loan_id, { ...next });
    append(deps, "loan_terms.version.activated", input.loan_id, { version: next.version, effective_on: completed_on, rate_pct: next.current_rate_pct, pi_cents: next.current_pi_cents, margin_pct: next.margin_pct, reason: "arm_correction", correction_id: input.correction_id });
  }
  const records_corrected = true;
  // remedy (C-2.2-03) — issued once per correction; a second pass (e.g. after the IRR discussion) never refunds twice
  const refund_cents = m.treatment === "cash_refund" ? m.net_effect_cents : 0n;
  const remedy = m.treatment === "cash_refund" ? (input.borrower_election === "curtailment" ? "upb_reduction" : "cash_refund") : m.treatment === "credit_reallocation" ? "reallocation" : "none_undercharge";
  const REMEDY_EVENTS = ["arm.correction.refund_issued", "arm.correction.credit_applied"];
  const priorRemedy = deps.events.byLoan(input.loan_id).find((e) => REMEDY_EVENTS.includes(e.type) && e.payload.correction_id === input.correction_id);
  const remedy_event = priorRemedy ? null : m.treatment === "cash_refund"
    ? append(deps, "arm.correction.refund_issued", input.loan_id, { correction_id: input.correction_id, amount_cents: m.net_effect_cents, method: remedy, election_offered: input.current && !input.advances, borrower_election: input.borrower_election ?? null, basis: "C-2.2-03: combined overcharge above $1.00" })
    : m.treatment === "credit_reallocation"
      ? append(deps, "arm.correction.credit_applied", input.loan_id, { correction_id: input.correction_id, amount_cents: m.net_effect_cents, method: "reallocation", basis: "C-2.2-03: rate-only/payment-only error, delinquent loan or escrow advance" })
      : append(deps, "arm.correction.undercharge_absorbed", input.loan_id, { correction_id: input.correction_id, amount_cents: -m.net_effect_cents, basis: "C-2.2-01: an undercharge cannot be collected from the borrower nor offset in the UPB" });
  if (!priorRemedy && m.treatment === "absorbed" && -m.net_effect_cents > 1_000_000n) input.escalations?.open({ kind: "officer", loanId: input.loan_id, payload: { decision: "absorb_undercharge_above_threshold", amount_cents: -m.net_effect_cents, threshold_cents: 1_000_000n, correction_id: input.correction_id } }, deps.actor);
  // borrower notified — once
  const alreadyNotified = deps.events.byLoan(input.loan_id).some((e) => e.type === "notice.sent" && e.payload.template === TEMPLATES.correction && e.occurredAt >= `${confirmed_on}T00:00:00.000Z`);
  let notice_id: string | null = null;
  if (!alreadyNotified && notices && input.recipients?.length && input.contact) {
    const n = notices.render({ templateCode: TEMPLATES.correction, loanId: input.loan_id, recipients: input.recipients, payload: { first_erroneous_change_date: first, erroneous_rate_pct: input.segments[0]!.booked_rate_pct, correct_rate_pct: input.segments[0]!.correct_rate_pct, correct_margin_pct: String(c.correct_margin_pct), erroneous_margin_pct: String(c.booked_margin_pct), overcharge: m.net_effect_cents > 0n, cash_refund: m.treatment === "cash_refund", election_offered: m.treatment === "cash_refund" && input.current && !input.advances, net_effect_cents: m.net_effect_cents < 0n ? -m.net_effect_cents : m.net_effect_cents, corrected_upb_cents: m.reamortized_upb_cents, corrected_pi_cents, ...input.contact }, asOf: completed_on });
    if (n.status === "held") throw new RangeError(`${TEMPLATES.correction} for ${input.correction_id} is held: ${n.heldReason ?? "checklist"}`);
    await notices.send(n.id, input.channel_context ?? {}); notice_id = n.id;
  }
  const borrower_notified = notice_id !== null || deps.events.byLoan(input.loan_id).some((e) => e.type === "notice.sent" && e.payload.template === TEMPLATES.correction && e.occurredAt >= `${confirmed_on}T00:00:00.000Z`);
  // reported to Fannie Mae only after the IRR discussion (C-2.2-01)
  const irr_discussed = input.irr_discussed_at !== null && input.irr_discussed_at !== "";
  const investor_event = m.report_to_fnma && irr_discussed
    ? append(deps, "investor_events.projected", input.loan_id, { event_type: "rate_payment_change", family: "rate_change", legacy_record: 83, correction: true, correction_id: input.correction_id, irr_discussed_at: input.irr_discussed_at, first_erroneous_change_date: first, corrected_rate_pct: last.correct_rate_pct, corrected_upb_cents: m.reamortized_upb_cents, new_payment_cents: corrected_pi_cents, effective_with_payment_due: `${nextDue.slice(5, 7)}${nextDue.slice(2, 4)}` })
    : null;
  const missing = [...(!records_corrected ? ["records_corrected"] : []), ...(!borrower_notified ? ["borrower_notified"] : []), ...(!irr_discussed ? ["irr_discussed"] : [])];
  const completed = missing.length === 0; const within_60_days = completed ? completed_on <= correct_by : null;
  put(deps, "arm_corrections", input.correction_id, { ...c, status: completed ? "completed" : "in_progress", reamortization: { segments: input.segments.map((s) => ({ ...s })), reamortized_upb_cents: m.reamortized_upb_cents, actual_upb_cents: m.actual_upb_cents }, net_effect_cents: m.net_effect_cents, remedy, borrower_election: input.borrower_election ?? null, irr_discussed_at: input.irr_discussed_at, fnma_reported_at: investor_event ? deps.now : null, notice_id, missing, completed_on: completed ? completed_on : null });
  const completed_event = completed
    ? append(deps, "arm.correction.completed", input.loan_id, { correction_id: input.correction_id, records_corrected: true, borrower_notified: true, irr_discussed: true, irr_discussed_at: input.irr_discussed_at, net_effect_cents: m.net_effect_cents, remedy, refund_cents, notice_id, investor_event_id: investor_event ? investor_event.id : null, completed_on, correct_by, within_60_days, timer: TIMERS.correct })
    : null;
  return { completed, missing, reamortized_upb_cents: m.reamortized_upb_cents, actual_upb_cents: m.actual_upb_cents, net_effect_cents: m.net_effect_cents, treatment: m.treatment, refund_cents, report_to_fnma: investor_event !== null, notice_id, remedy_event, investor_event, completed_event, correct_by, within_60_days };
}

// ---- conversion option (F-1-01; legacy plans only) ------------------------------------------------------------------
export interface ConversionElection { readonly elected_on?: PlainDate; readonly conversion_effective_date: PlainDate; readonly fixed_rate_pct: string; readonly new_pi_cents?: Cents; }
/** `arm.conversion.elected{new_payment_effective_date}`: refused on Fannie Mae standard plans 4926–4929 (no conversion option — Standard ARM Plan Matrix); the remaining schedule is cancelled. */
export function electConversion(deps: OpsDeps, loanId: string, e: ConversionElection): { event: DomainEvent; new_payment_effective_date: PlainDate; notice_send_by: PlainDate; template: string; new_pi_cents: Cents; cancelled_rows: number } {
  const terms = loadTerms(deps, loanId);
  if (!terms.conversion_option) throw new RangeError(`loan ${loanId} has no conversion option${terms.fnma_arm_plan ? ` (Fannie Mae plan ${terms.fnma_arm_plan}: standard plans 4926–4929 provide none)` : ""}`);
  const fixed = pct(e.fixed_rate_pct, "fixed_rate_pct"); const eff = date(e.conversion_effective_date, "conversion_effective_date"); const elected_on = e.elected_on ?? today(deps);
  if (eff <= elected_on) throw new RangeError(`conversion effective date ${eff} must follow the election ${elected_on}`);
  const new_payment_effective_date = nextDueAfter(eff, parts(terms.first_payment_due).d);
  const new_pi_cents = e.new_pi_cents ?? newPayment(expectedUpbAt(terms, eff), fixed, remainingTermAt(terms, new_payment_effective_date));
  const rate_changes = fixed !== terms.current_rate_pct, payment_changes = new_pi_cents !== terms.current_pi_cents;
  const template = rate_changes && payment_changes ? TEMPLATES.regz_c : TEMPLATES.fnma_change;
  const notice_send_by = addDays(new_payment_effective_date, -25);
  let cancelled_rows = 0;
  for (const r of deps.store.list("arm_schedule", (d) => d.loan_id === loanId && d.status !== "effective" && d.status !== "cancelled" && String(d.change_date) >= eff)) { put(deps, "arm_schedule", r.id, { ...r.data, status: "cancelled", cancel_reason: "converted_fixed" }); cancelled_rows++; }
  put(deps, "arm_conversions", loanId, { loan_id: loanId, elected_on, conversion_effective_date: eff, new_payment_effective_date, fixed_rate_pct: fixed, prior_rate_pct: terms.current_rate_pct, new_pi_cents, prior_pi_cents: terms.current_pi_cents, rate_changes, payment_changes, template, notice_send_by, status: "elected" });
  const event = append(deps, "arm.conversion.elected", loanId, { elected_on, conversion_effective_date: eff, new_payment_effective_date, fixed_rate_pct: fixed, prior_rate_pct: terms.current_rate_pct, new_pi_cents, prior_pi_cents: terms.current_pi_cents, rate_changes, payment_changes, template, notice_send_by, cancelled_rows, timer: TIMERS.conversion });
  if (cancelled_rows) append(deps, "arm.schedule.cancelled", loanId, { reason: "converted_fixed", from: eff, rows: cancelled_rows }, event.id);
  return { event, new_payment_effective_date, notice_send_by, template, new_pi_cents, cancelled_rows };
}
/** The conversion notice 25 days before the new payment (F-1-01): the (c) notice when rate and payment both change (comment 20(c)-3), else C-2.1-02's notice. */
export async function sendConversionNotice(deps: OpsDeps, notices: NoticeSender, input: { loan_id: string; recipients: readonly Recipient[]; contact: ServicerContact; send_on?: PlainDate; channel_context?: ChannelContext }): Promise<{ template: string; notice_id: string; sent_on: PlainDate; send_by: PlainDate; late: boolean; event: DomainEvent }> {
  const cv = rec<Record<string, unknown>>(deps, "arm_conversions", input.loan_id);
  if (!cv || cv.status !== "elected") throw new RangeError(`no elected conversion on ${input.loan_id}`);
  const terms = loadTerms(deps, input.loan_id); const sendOn = input.send_on ?? today(deps);
  const eff = plainDate(String(cv.conversion_effective_date)), due = plainDate(String(cv.new_payment_effective_date)), sendBy = plainDate(String(cv.notice_send_by)); const template = String(cv.template);
  const newPi = cents(cv.new_pi_cents, "new_pi_cents"), priorPi = cents(cv.prior_pi_cents, "prior_pi_cents");
  const figures = armNoticeFigures({ current_pi_cents: priorPi, new_pi_cents: newPi, escrow_cents: terms.escrow_cents });
  const payload: Record<string, unknown> = template === TEMPLATES.regz_c
    ? { change_date: eff, schedule_sentence: "never — your rate is now fixed for the remaining term", current_rate_pct: String(cv.prior_rate_pct), new_rate_pct: String(cv.fixed_rate_pct), current_pi_cents: priorPi, new_pi_cents: newPi, first_new_payment_due: due, interest_only: false, index_name: "your note's conversion option (fixed rate, no index)", index_source: "the conversion clause of your note", index_value: String(cv.fixed_rate_pct), index_date: String(cv.elected_on), margin_pct: terms.margin_pct,
        cap_this_change_pct: terms.periodic_cap_pct, lifetime_cap_pct: Decimal.parse(terms.initial_note_rate_pct).add(Decimal.parse(terms.lifetime_cap_pct)).toFixed(3), floor_pct: terms.margin_pct, cap_applied: false, uncapped_rate_pct: String(cv.fixed_rate_pct), expected_upb_cents: expectedUpbAt(terms, eff), remaining_term_months: remainingTermAt(terms, due), escrow_cents: terms.escrow_cents, total_payment_cents: figures.total_payment_cents, current_total_cents: figures.current_total_cents, next_change_date: terms.maturity_date, days_before_first_payment: daysBetween(sendOn, due), notice_kind: "c_60_120", engines_agree: true, conversion: true, ...input.contact }
    : { effective_date: eff, rate_changed: cv.rate_changes === true, payment_changed: cv.payment_changes === true, current_rate_pct: String(cv.prior_rate_pct), new_rate_pct: String(cv.fixed_rate_pct), current_payment_cents: priorPi, new_payment_cents: newPi, first_new_payment_due: due, days_before_effective: daysBetween(sendOn, due), required_by_contract: true, conversion: true, ...input.contact };
  const n = notices.render({ templateCode: template, loanId: input.loan_id, recipients: input.recipients, payload, asOf: sendOn });
  if (n.status === "held") throw new RangeError(`${template} (conversion) for ${input.loan_id} is held: ${n.heldReason ?? "checklist"}`);
  await notices.send(n.id, input.channel_context ?? {});
  put(deps, "arm_conversions", input.loan_id, { ...cv, status: "noticed", notice_id: n.id });
  const late = sendOn > sendBy;
  const event = append(deps, "arm.conversion.noticed", input.loan_id, { template, notice_id: n.id, sent_on: sendOn, send_by: sendBy, late, new_payment_effective_date: due });
  return { template, notice_id: n.id, sent_on: sendOn, send_by: sendBy, late, event };
}

// ---- LAR 83 feedback (5.1 hand-off) ----------------------------------------------------------------------------------
export interface Lar83Feedback { readonly status: "accepted" | "rejected"; readonly effective_with_payment_due: string; readonly fnma_loan_number: string | null; readonly received_at: string; readonly reason: string | null; }
/** Parse Fannie Mae's LSDU feedback for a LAR 83 (record 83; `effective_with_payment_due` MMYY; accepted/rejected). */
export function parseLar83Feedback(raw: unknown, now: string): Lar83Feedback {
  if (!isRecord(raw)) throw new RangeError("LAR 83 feedback: a record is required");
  const record = String(raw.record ?? raw.legacy_record ?? "");
  if (record !== "83") throw new RangeError(`LAR 83 feedback: record ${record || "(missing)"} is not 83`);
  const status = String(raw.status ?? "");
  if (status !== "accepted" && status !== "rejected") throw new RangeError(`LSDU feedback status ${status || "(missing)"} is not accepted/rejected`);
  const eff = String(raw.effective_with_payment_due ?? raw.effective_mmyy ?? "");
  if (!/^(0[1-9]|1[0-2])\d{2}$/.test(eff)) throw new RangeError(`LAR 83 feedback: effective_with_payment_due ${eff || "(missing)"} is not MMYY`);
  const received_at = typeof raw.received_at === "string" && raw.received_at ? raw.received_at : now;
  if (Number.isNaN(Date.parse(received_at))) throw new RangeError(`LAR 83 feedback: received_at ${received_at} is not an instant`);
  return { status, effective_with_payment_due: eff, fnma_loan_number: typeof raw.fnma_loan_number === "string" && raw.fnma_loan_number ? raw.fnma_loan_number : null, received_at, reason: typeof raw.reason === "string" && raw.reason ? raw.reason : null };
}
/** Accepted → `investor_events.accepted{event_type=rate_payment_change}` (closes FNMA_IRM_LAR83_RATE_CHANGE_BD5); rejected → `investor_events.rejected` and the `fnma_portal_operator` single-LAR task (5.1 package) before the change date. */
export function ingestLar83Feedback(deps: OpsDeps, loanId: string, raw: unknown, escalations?: Escalator): { status: "accepted" | "rejected"; event: DomainEvent; projected_event_id: string; portal_task_id: string | null } {
  const f = parseLar83Feedback(raw, deps.now);
  const projected = deps.events.byLoan(loanId).filter((e) => e.type === "investor_events.projected" && e.payload.event_type === "rate_payment_change" && String(e.payload.effective_with_payment_due) === f.effective_with_payment_due).at(-1);
  if (!projected) throw new RangeError(`no projected rate_payment_change event effective ${f.effective_with_payment_due} on ${loanId} to reconcile the LSDU feedback against`);
  const common = { event_type: "rate_payment_change", family: "rate_change", legacy_record: 83, projected_event_id: projected.id, effective_with_payment_due: f.effective_with_payment_due, new_rate_pct: projected.payload.new_rate_pct, new_payment_cents: projected.payload.new_payment_cents, fnma_loan_number: f.fnma_loan_number, fnma_response_parsed: true };
  const changeDate = typeof projected.payload.change_date === "string" ? plainDate(projected.payload.change_date) : null;
  if (f.status === "accepted") {
    const event = deps.events.append({ type: "investor_events.accepted", loanId, actor: deps.actor, causationId: projected.id, occurredAt: f.received_at, payload: { ...common, accepted_at: f.received_at } });
    if (changeDate) { const adj = rec<ArmAdjustment>(deps, "arm_adjustments", rowId(loanId, changeDate)); if (adj && adj.status === "effective") put(deps, "arm_adjustments", rowId(loanId, changeDate), { ...adj, status: "reported" }); }
    return { status: "accepted", event, projected_event_id: projected.id, portal_task_id: null };
  }
  const event = deps.events.append({ type: "investor_events.rejected", loanId, actor: deps.actor, causationId: projected.id, occurredAt: f.received_at, payload: { ...common, rejected_at: f.received_at, reason: f.reason, resubmit_by: changeDate } });
  const task = escalations?.open({ kind: "human_portal_task", loanId, ownerRole: "fnma_portal_operator", payload: { task: "single_lar_entry", record: "LAR 83", reason: f.reason, effective_with_payment_due: f.effective_with_payment_due, new_rate_pct: common.new_rate_pct, new_payment_cents: common.new_payment_cents, resubmit_by: changeDate, note: "the loan still adjusts on the change date (the note governs); the investor mismatch is a 5.1 exception" } }, deps.actor) ?? null;
  return { status: "rejected", event, projected_event_id: projected.id, portal_task_id: task ? task.id : null };
}
