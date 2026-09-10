/**
 * §12.4 Forbearance plan — operating rules over the plan calculators (./plans.ts, ./ops.ts) and the event vocabulary
 * every 12.4 timer row arms on and is satisfied by (spec/sections/12-loss-mitigation/12-4-forbearance-plan.md). The
 * `workout_plan.*` / `contacts.*` / `exception_request.prepare` / `fnma.status_code.report` / `fees.suppress` handlers
 * in src/app/tools/section12.ts route their 12.4 ops through src/app/tools/section12-4.ts, which is a thin shell
 * over these:
 *   - `createForbearanceTerm` — the term guards (increment ≤3, cumulative ≤12 from `initial_start_date`, projected
 *     delinquency ≤12, MBS maturity, combined ≤36 with a repayment component, the Reg X basis past six forborne
 *     payments) → `workout_plan.term.create{term_months, cumulative_months, projected_months_delinquent_at_term_end,
 *     term_end, last_scheduled_payment_date, mbs, forbearance_component, combined_months}` (the four 12.4 gate rows and
 *     `FNMA_D23201_FORB_COMBINED_36M` arm on it) and `workout_plan.activated{kind=forbearance, term_end}` (the −30-day
 *     outreach, expiry-disposition and performance-hold rows);
 *   - `buildSchedule` → one `workout_plan_schedule.due_date{due_date, expected_amount_cents, payment_mode=reduced}` per
 *     reduced-payment month (`FNMA_D23201_FORB_REDUCED_PAYMENT_EOM`, last calendar day of the month), `applyScheduledPayment`
 *     → `workout_plan_schedule.met{payment_mode=reduced}` when the 2.x `payment.received` covers the expected amount,
 *     `monthEndScheduleCheck` → the mitigating-circumstances check and `workout_plan.payment.missed` (termination review;
 *     `REGX_1024_41B1_DILIGENCE_RESUME` resumes diligence the same day);
 *   - `expirySweep` → `workout_plan.expiry_approaching{days_before=30}` (`FNMA_D23201_FORB_PREEXPIRY_CADENCE`, every 3
 *     days until QRPC — `contact.qrpc.established`, 11.3's spelling — or expiry); `qrpcOnOutreach` + `preExpiryPrescreen`
 *     (rule 4: the 12.2 hierarchy pre-screen the same day QRPC is achieved);
 *   - `monthEndStatus` → `workout_plan.month_end{plan_kind=forbearance, workout_plan_active=true, period_end}` per active
 *     plan (`FNMA_F121_STATUS_09_BD2`: status 09 by BD2, F-1-21), or the SMDU forbearance case once `smdu.plan_cases=on`
 *     (T10); `ingestStatusCodeAck` — the 5.x acknowledgement of the F-1-21 line, validated → `investor.event.accepted{status_code}`;
 *   - `prepareExceptionPackage` / `submitExceptionRequest` → `fnma_exception_request.submitted{submitted_on}`
 *     (`FNMA_LL202601_FORB_EXCEPTION_RESPONSE`, 10 `business_days_fannie_et` policy follow-up) / `recordExceptionDecision`
 *     — Fannie Mae's written decision validated → `fnma_exception_request.decided{decision}`.
 * Every event carries `loanId`, so the engine keys satisfaction on the loan (src/kernel/timers/engine.ts `sameSubject`) —
 * except the reduced-payment schedule rows, whose subject is the row `{kind: "workout_plan_schedule", id: "<plan>:<due_date>"}`
 * so each month's clock is satisfied by that month's receipt only (the 5.2 per-cycle pattern).
 */
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { type PlainDate, addDays, addMonths, endOfMonth, parts, ymd, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { forbearanceTerm, forbearanceTermDates, preExpiryOutreachStart, FB_INCREMENT_MAX } from "./plans.ts";
import { forbearanceBasisGate, reducedPaymentMiss, planCaseRouting, type RegxBasis } from "./ops.ts";

export interface Emitter { readonly events: EventStore; readonly actor: Actor; readonly now: string; }
const today = (em: Emitter): PlainDate => plainDate(em.now.slice(0, 10));
const isoDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const period = (d: PlainDate): string => d.slice(0, 7);

// ───────────────────────────── term guards (rule 1 / rule 2; timer table gates) ─────────────────────────────
export type TermApprover = "agent" | "reviewer" | "fnma_exception";
export interface TermRequest {
  readonly loan_id: string; readonly plan_id: string; readonly term_no: number;
  /** `requested_months`: the request offer construction caps (rule 1); `term_months`: an explicit term the command must create or be refused (gate rows). */
  readonly requested_months: number; readonly term_months?: number; readonly cumulative_months: number; readonly months_delinquent_at_start: number;
  readonly start_on: PlainDate; readonly initial_start_date: PlainDate;
  /** MBS loan: the term must not extend beyond the last scheduled payment date (D2-3.2-01). */
  readonly mbs?: boolean; readonly last_scheduled_payment_date?: PlainDate | null;
  /** Months of a repayment component offered with the forbearance (rule 7: one plan, two components, ≤36 combined). */
  readonly repayment_component_months?: number;
  readonly regx_basis?: RegxBasis | null;
  /** A recorded `fnma_exception_requests.decision=approved` lifts the 12-month cumulative / 12-months-delinquent caps only. */
  readonly exception_approved?: boolean; readonly exception_request_id?: string | null;
  readonly disaster?: boolean;
}
export interface TermComputation { readonly requested: number; readonly cap_increment: number; readonly cap_cumulative: number; readonly cap_delinquency: number; readonly mbs_cap: number | null; readonly cap_combined: number; readonly chosen: number; readonly capped_by: readonly string[]; readonly exception_required: boolean; }
/** Whole months from `start_on` whose month-end stays ≤ the last scheduled payment date (T8: maturity 2027-02-01 from 2027-01-01 → 1). */
export function mbsMonthsToMaturity(startOn: PlainDate, lastScheduledPayment: PlainDate): number {
  let m = 0; while (m < 12 && endOfMonth(addMonths(startOn, m)) <= lastScheduledPayment) m++;
  return m;
}
/** Rule 1: term = min(3, requested, months to the 12-month cumulative cap, months to the 12-months-delinquent cap, MBS remaining term, combined-36 room). */
export function termComputation(i: Pick<TermRequest, "requested_months" | "cumulative_months" | "months_delinquent_at_start" | "start_on" | "last_scheduled_payment_date" | "repayment_component_months" | "mbs">): TermComputation {
  const mbsCap = i.mbs && i.last_scheduled_payment_date ? mbsMonthsToMaturity(i.start_on, i.last_scheduled_payment_date) : null;
  const combined = i.cumulative_months + (i.repayment_component_months ?? 0);
  const t = forbearanceTerm({ requested_months: i.requested_months, cumulative_months: i.cumulative_months, months_delinquent_at_start: i.months_delinquent_at_start, mbs_months_to_maturity: mbsCap, combined_months: combined });
  return { requested: i.requested_months, cap_increment: FB_INCREMENT_MAX, cap_cumulative: 12 - i.cumulative_months, cap_delinquency: 12 - i.months_delinquent_at_start, mbs_cap: mbsCap, cap_combined: 36 - combined, chosen: t.months, capped_by: t.capped_by, exception_required: t.exception_required };
}
const EXCEPTION_CAPS = new Set(["cumulative_12", "delinquency_12"]);
export interface CreatedTerm { readonly plan_id: string; readonly term_no: number; readonly months: number; readonly term_start: PlainDate; readonly term_end: PlainDate; readonly computation: TermComputation; readonly regx_short_term: boolean; readonly regx_basis: RegxBasis | null; readonly approved_by: TermApprover; readonly cumulative_months_after: number; readonly projected_months_delinquent_at_term_end: number; readonly preexpiry_outreach_begin_by: PlainDate; readonly events: readonly DomainEvent[]; }
/**
 * Creates one forbearance term (initial or extension). Refuses (RangeError) a term breaching any gate: an increment over
 * three months, the cumulative-12 / delinquent-12 caps without an approved exception request, the MBS maturity, the
 * combined-36 guard, or a term past the sixth forborne payment without a recorded Reg X basis (T2, T3, T8).
 */
export function createForbearanceTerm(em: Emitter, i: TermRequest): CreatedTerm {
  const requested = i.term_months ?? i.requested_months;
  if (!(requested >= 1)) throw new RangeError("term_months / requested_months must be ≥1");
  if (requested > FB_INCREMENT_MAX) throw new RangeError(`FNMA_D23201_FORB_INCREMENT_MAX_3M: a ${requested}-month term exceeds the 3-month increment (D2-3.2-01 / LL-2026-01) — command refused`);
  const c = termComputation({ ...i, requested_months: requested });
  let approvedBy: TermApprover = "agent"; let months = c.chosen;
  // An explicit `term_months` is a command to create that term: refused when it breaches a gate (T2). A bare `requested_months` goes through offer construction and is capped (rule 1; T8).
  if (i.term_months !== undefined && i.term_months > c.chosen) {
    const caps = c.capped_by.length ? c.capped_by : ["requested"];
    if (i.exception_approved && caps.every((k) => EXCEPTION_CAPS.has(k))) { months = i.term_months; approvedBy = "fnma_exception"; }
    else if (caps.every((k) => EXCEPTION_CAPS.has(k))) throw new RangeError(`FNMA_LL202601_FORB_${caps.includes("delinquency_12") ? "DELQ_12M" : "CUMULATIVE_12M"}: a ${i.term_months}-month term breaches ${caps.join("+")} (engine offers ${c.chosen}; cumulative ${i.cumulative_months}, ${i.months_delinquent_at_start} months delinquent at start → ${i.months_delinquent_at_start + i.term_months} at term end) — refused without Fannie Mae's prior written approval via the Forbearance Exception Request Template (LL-2026-01)`);
    else throw new RangeError(`${caps.includes("mbs_maturity") ? "FNMA_D23201_FORB_MBS_MATURITY" : "FNMA_D23201_FORB_COMBINED_36M"}: a ${i.term_months}-month term breaches ${caps.join("+")} (engine offers ${c.chosen}) — command refused (D2-3.2-01)`);
  }
  if (months < 1) throw new RangeError(`no forbearance term is available within the caps (cumulative ${i.cumulative_months}, ${i.months_delinquent_at_start} months delinquent) — Forbearance Exception Request Template required (LL-2026-01)`);
  const basis = forbearanceBasisGate({ forborne_months_before: i.cumulative_months, term_months: months, regx_basis: i.regx_basis ?? null });
  if (!basis.allowed) throw new RangeError(basis.refusal!);
  const dates = forbearanceTermDates(i.start_on, months);
  const projected = i.months_delinquent_at_start + months;
  const out: DomainEvent[] = [];
  out.push(em.events.append({ type: "workout_plan.term.create", loanId: i.loan_id, actor: em.actor, payload: { plan_id: i.plan_id, term_no: i.term_no, kind: "forbearance", term_months: months, requested_months: c.requested, cumulative_months: i.cumulative_months, cumulative_months_after: i.cumulative_months + months, initial_start_date: i.initial_start_date, months_delinquent_at_start: i.months_delinquent_at_start, projected_months_delinquent_at_term_end: projected, term_start: dates.start, term_end: dates.end, mbs: i.mbs === true, last_scheduled_payment_date: i.last_scheduled_payment_date ?? null, forbearance_component: true, repayment_component_months: i.repayment_component_months ?? 0, combined_months: i.cumulative_months + months + (i.repayment_component_months ?? 0), capped_by: [...c.capped_by], approved_by: approvedBy, exception_request_id: i.exception_request_id ?? null, regx_short_term: basis.regx_short_term, regx_basis: i.regx_basis ?? null } }));
  out.push(em.events.append({ type: "workout_plan.activated", loanId: i.loan_id, actor: em.actor, payload: { plan_id: i.plan_id, kind: "forbearance", term_no: i.term_no, term_start: dates.start, term_end: dates.end, regx_short_term: basis.regx_short_term, regx_basis: i.regx_basis ?? null, disaster: i.disaster === true } }));
  return { plan_id: i.plan_id, term_no: i.term_no, months, term_start: dates.start, term_end: dates.end, computation: c, regx_short_term: basis.regx_short_term, regx_basis: i.regx_basis ?? null, approved_by: approvedBy, cumulative_months_after: i.cumulative_months + months, projected_months_delinquent_at_term_end: projected, preexpiry_outreach_begin_by: preExpiryOutreachStart(dates.end), events: out };
}

// ───────────────────────────── reduced-payment schedule (rule 1; T7) ─────────────────────────────
export type ScheduleStatus = "due" | "met" | "missed" | "excused";
export const scheduleSubject = (planId: string, due: PlainDate): { kind: "workout_plan_schedule"; id: string } => ({ kind: "workout_plan_schedule", id: `${planId}:${due}` });
export interface ScheduleRow { readonly plan_id: string; readonly due_date: PlainDate; readonly expected_amount_cents: Cents; readonly received_amount_cents: Cents; readonly received_at: string | null; readonly status: ScheduleStatus; readonly month_end: PlainDate; }
/** One row per month of the term: due on the first, expected = the reduced amount (0 when suspended); reduced rows arm the month-end clock. */
export function buildSchedule(em: Emitter, i: { loan_id: string; plan_id: string; term_start: PlainDate; term_end: PlainDate; payment_mode: "suspended" | "reduced"; reduced_amount_cents?: Cents | null }): { rows: ScheduleRow[]; events: DomainEvent[] } {
  if (i.term_end < i.term_start) throw new RangeError("term_end before term_start");
  const expected = i.payment_mode === "reduced" ? (i.reduced_amount_cents ?? 0n) : 0n;
  if (i.payment_mode === "reduced" && expected <= 0n) throw new RangeError("a reduced-payment plan needs reduced_amount_cents > 0 (the borrower's stated affordable amount, whole dollars)");
  const { y, m } = parts(i.term_start); const rows: ScheduleRow[] = []; const events: DomainEvent[] = [];
  for (let d = ymd(y, m, 1); d <= i.term_end; d = addMonths(d, 1)) {
    const row: ScheduleRow = { plan_id: i.plan_id, due_date: d, expected_amount_cents: expected, received_amount_cents: 0n, received_at: null, status: "due", month_end: endOfMonth(d) };
    rows.push(row);
    // Subject = the schedule row (`{kind: "workout_plan_schedule", id: "<plan>:<due_date>"}`, no loanId): each month's clock is satisfied by that month's receipt only — the engine keys satisfaction on the subject (src/kernel/timers/engine.ts `sameSubject`), as 5.2 does per remittance cycle.
    if (i.payment_mode === "reduced") events.push(em.events.append({ type: "workout_plan_schedule.due_date", aggregate: scheduleSubject(i.plan_id, d), actor: em.actor, payload: { loan_id: i.loan_id, plan_id: i.plan_id, due_date: d, month_end: row.month_end, expected_amount_cents: expected.toString(), payment_mode: "reduced", application: "suspense/unapplied" } }));
  }
  return { rows, events };
}
/** A 2.x `payment.received` applied to the schedule row: met once the cumulative receipt covers the expected amount (funds to `suspense/unapplied` per rule 1). */
export function applyScheduledPayment(em: Emitter, i: { loan_id: string; row: ScheduleRow; amount_cents: Cents; payment_id: string; received_at: string }): { row: ScheduleRow; event: DomainEvent | null } {
  if (i.amount_cents <= 0n) throw new RangeError("amount_cents must be > 0");
  if (i.row.status !== "due") throw new RangeError(`schedule row ${i.row.due_date} is ${i.row.status}`);
  const received = i.row.received_amount_cents + i.amount_cents; const met = received >= i.row.expected_amount_cents;
  const row: ScheduleRow = { ...i.row, received_amount_cents: received, received_at: i.received_at, status: met ? "met" : "due" };
  const event = met ? em.events.append({ type: "workout_plan_schedule.met", loanId: i.loan_id, aggregate: scheduleSubject(row.plan_id, row.due_date), actor: em.actor, payload: { plan_id: row.plan_id, due_date: row.due_date, payment_mode: "reduced", expected_amount_cents: row.expected_amount_cents.toString(), received_amount_cents: received.toString(), payment_id: i.payment_id, received_at: i.received_at, application: "suspense/unapplied" } }) : null;
  return { row, event };
}
export interface MissResult { readonly row: ScheduleRow; readonly missed: boolean; readonly excused: boolean; readonly termination_review: boolean; readonly termination_notice: "NTC_FNMA_D23201_FORB_TERMINATION" | null; readonly late_charges_from: PlainDate | null; readonly event: DomainEvent | null; }
/** Month-end: a reduced payment still short → the mitigating-circumstances check is logged; excused rows stay in the plan, the rest emit `workout_plan.payment.missed` (termination review; late charges from the default date only). */
export function monthEndScheduleCheck(em: Emitter, i: { loan_id: string; plan_start: PlainDate; rows: readonly ScheduleRow[]; as_of: PlainDate; mitigating_circumstances: boolean; mitigating_check_id: string }): MissResult[] {
  if (!i.mitigating_check_id) throw new RangeError("mitigating_check_id is required — the mitigating-circumstances check is logged before any termination review (12.4 guardrail)");
  const out: MissResult[] = [];
  for (const row of i.rows) {
    if (row.status !== "due" || row.month_end > i.as_of) continue;
    const r = reducedPaymentMiss({ due_on: row.due_date, received_cents: row.received_amount_cents, reduced_payment_cents: row.expected_amount_cents, mitigating_circumstances: i.mitigating_circumstances, plan_start: i.plan_start });
    if (!r.missed) { out.push({ row: { ...row, status: "met" }, missed: false, excused: false, termination_review: false, termination_notice: null, late_charges_from: null, event: null }); continue; }
    if (!r.terminated) { out.push({ row: { ...row, status: "excused" }, missed: true, excused: true, termination_review: false, termination_notice: null, late_charges_from: null, event: null }); continue; }
    const event = em.events.append({ type: "workout_plan.payment.missed", loanId: i.loan_id, actor: em.actor, payload: { plan_id: row.plan_id, due_date: row.due_date, month_end: row.month_end, expected_amount_cents: row.expected_amount_cents.toString(), received_amount_cents: row.received_amount_cents.toString(), mitigating_check: r.mitigating_check, mitigating_check_id: i.mitigating_check_id, mitigating_circumstances: false, termination_review: true, termination_notice: r.termination_notice, late_charges_from: r.late_charges_from, late_charges_before_default_cents: "0", diligence_resumes_on: i.as_of } });
    out.push({ row: { ...row, status: "missed" }, missed: true, excused: false, termination_review: true, termination_notice: r.termination_notice, late_charges_from: r.late_charges_from, event });
  }
  return out;
}

// ───────────────────────────── pre-expiry outreach (D2-3.2-01; rule 4; T4) ─────────────────────────────
export interface ActivePlan { readonly plan_id: string; readonly status: string; readonly term_start: PlainDate; readonly term_end: PlainDate; readonly kind?: string; }
/** From term_end −30 through term_end, each active plan gets one `workout_plan.expiry_approaching{days_before=30}` (the 3-day cadence row arms on it). */
export function expirySweep(em: Emitter, i: { loan_id: string; plans: readonly ActivePlan[]; as_of: PlainDate; already_flagged: ReadonlySet<string> }): DomainEvent[] {
  const out: DomainEvent[] = [];
  for (const p of i.plans) {
    if (p.status !== "active" || (p.kind ?? "forbearance") !== "forbearance") continue;
    const beginBy = preExpiryOutreachStart(p.term_end); const key = `${p.plan_id}:${p.term_end}`;
    if (i.as_of < beginBy || i.as_of > p.term_end || i.already_flagged.has(key)) continue;
    out.push(em.events.append({ type: "workout_plan.expiry_approaching", loanId: i.loan_id, actor: em.actor, payload: { plan_id: p.plan_id, term_end: p.term_end, days_before: 30, begin_by: beginBy, cadence_days: 3, as_of: i.as_of, purpose: "forb_preexpiry" } }));
  }
  return out;
}
export type PrescreenResult = "reinstatement" | "repayment_plan" | "payment_deferral" | "flex_mod" | "extension" | "exception_required";
export interface PrescreenFacts { readonly hardship_resolved: boolean; readonly can_reinstate?: boolean; readonly can_afford_repayment?: boolean; readonly months_delinquent: number; readonly deferral_eligible?: boolean | null; readonly cumulative_months: number; readonly months_delinquent_at_next_start: number; readonly requested_months?: number; readonly start_on?: PlainDate | null; readonly last_scheduled_payment_date?: PlainDate | null; readonly mbs?: boolean; }
/** Rule 4: resolved + can reinstate → reinstatement; resolved + affordable plan → repayment (12.5); resolved otherwise → deferral (12.6) at 2–6 months delinquent, else Flex Mod (12.8); unresolved → extension within the caps (else the exception template). */
export function preExpiryPrescreen(f: PrescreenFacts): { result: PrescreenResult; next_process: "12.4" | "12.5" | "12.6" | "12.8" | "2.x"; extension_months: number | null; computation: TermComputation | null } {
  if (f.hardship_resolved) {
    if (f.can_reinstate) return { result: "reinstatement", next_process: "2.x", extension_months: null, computation: null };
    if (f.can_afford_repayment) return { result: "repayment_plan", next_process: "12.5", extension_months: null, computation: null };
    const deferral = f.deferral_eligible !== false && f.months_delinquent >= 2 && f.months_delinquent <= 6;
    return deferral ? { result: "payment_deferral", next_process: "12.6", extension_months: null, computation: null } : { result: "flex_mod", next_process: "12.8", extension_months: null, computation: null };
  }
  const c = termComputation({ requested_months: f.requested_months ?? FB_INCREMENT_MAX, cumulative_months: f.cumulative_months, months_delinquent_at_start: f.months_delinquent_at_next_start, start_on: f.start_on ?? plainDate("2000-01-01"), last_scheduled_payment_date: f.last_scheduled_payment_date ?? null, mbs: f.mbs === true });
  return c.chosen >= 1 ? { result: "extension", next_process: "12.4", extension_months: c.chosen, computation: c } : { result: "exception_required", next_process: "12.4", extension_months: 0, computation: c };
}
/** QRPC achieved on a pre-expiry contact: `contact.qrpc.established` (11.3's spelling; ends the cadence) and the same-day hierarchy pre-screen → `workout_plan.prescreen.completed{on}`. */
export function qrpcOnOutreach(em: Emitter, i: { loan_id: string; plan_id: string; contact_id: string; purpose: string; intent: string; brp_needed: boolean; facts: PrescreenFacts }): { qrpc_event: DomainEvent; prescreen: ReturnType<typeof preExpiryPrescreen> & { on: PlainDate }; prescreen_event: DomainEvent } {
  const on = today(em);
  const qrpc = em.events.append({ type: "contact.qrpc.established", loanId: i.loan_id, actor: em.actor, payload: { contact_id: i.contact_id, plan_id: i.plan_id, purpose: i.purpose, hardship_resolved: i.facts.hardship_resolved, intent: i.intent, brp_needed: i.brp_needed, plan_status: "active", achieved_at: em.now, achieved_on: on } });
  const pre = preExpiryPrescreen(i.facts);
  const ev = em.events.append({ type: "workout_plan.prescreen.completed", loanId: i.loan_id, actor: em.actor, payload: { plan_id: i.plan_id, on, qrpc_contact_id: i.contact_id, result: pre.result, next_process: pre.next_process, extension_months: pre.extension_months } });
  return { qrpc_event: qrpc, prescreen: { ...pre, on }, prescreen_event: ev };
}

// ───────────────────────────── reporting: status 09 at BD2 (F-1-21) / SMDU case (T1, T10) ─────────────────────────────
export interface MonthEndStatusRow { readonly plan_id: string; readonly period: string; readonly period_end: PlainDate; readonly status_code: "09" | null; readonly report_by: PlainDate | null; readonly smdu_case_created: boolean; readonly event: DomainEvent | null; }
export function monthEndStatus(em: Emitter, i: { loan_id: string; plans: readonly ActivePlan[]; period_end: PlainDate; smdu_plan_cases: "on" | "off"; smdu_cases_existing: ReadonlySet<string> }): MonthEndStatusRow[] {
  if (i.period_end !== endOfMonth(i.period_end)) throw new RangeError(`period_end ${i.period_end} is not a month end`);
  const out: MonthEndStatusRow[] = [];
  for (const p of i.plans) {
    if (p.status !== "active" || (p.kind ?? "forbearance") !== "forbearance" || p.term_start > i.period_end || p.term_end < i.period_end) continue;
    const routing = planCaseRouting({ smdu_plan_cases: i.smdu_plan_cases, plan_kind: "forbearance" });
    if (routing.legacy_status_code_emitted === "09") {
      const reportBy = addBusinessDays(i.period_end, 2, fannieEt);
      const event = em.events.append({ type: "workout_plan.month_end", loanId: i.loan_id, actor: em.actor, payload: { plan_id: p.plan_id, plan_kind: "forbearance", workout_plan_active: true, period: period(i.period_end), period_end: i.period_end, status_code: "09", report_by: reportBy, file: "f121_legacy" } });
      out.push({ plan_id: p.plan_id, period: period(i.period_end), period_end: i.period_end, status_code: "09", report_by: reportBy, smdu_case_created: false, event });
    } else {
      const created = !i.smdu_cases_existing.has(p.plan_id);
      const event = created ? em.events.append({ type: "smdu.plan_case.created", loanId: i.loan_id, actor: em.actor, payload: { plan_id: p.plan_id, workout: "forbearance", period: period(i.period_end), legacy_status_code_emitted: null } }) : null;
      out.push({ plan_id: p.plan_id, period: period(i.period_end), period_end: i.period_end, status_code: null, report_by: null, smdu_case_created: created, event });
    }
  }
  return out;
}
export interface StatusCodeAck { readonly loan_id: string; readonly period: string; readonly status_code: string; readonly accepted: boolean; readonly ack_id: string; readonly source: "lsdu" | "se" | "f121_file"; readonly accepted_on: PlainDate; readonly reason_code?: string | null; readonly message?: string | null; }
/** Validates the inbound 5.x acknowledgement of a delinquency-status line (F-1-21) before it becomes a fact. */
export function validateStatusCodeAck(r: Record<string, unknown>): StatusCodeAck {
  const s = (k: string): string => { const v = r[k]; if (typeof v !== "string" || v === "") throw new RangeError(`status code ack: ${k} is required`); return v; };
  const loan = s("loan_id"), period = s("period"), code = s("status_code"), ackId = s("ack_id"), source = s("source");
  if (!/^\d{4}-\d{2}$/.test(period)) throw new RangeError("status code ack: period must be YYYY-MM");
  if (!/^\d{2}$/.test(code)) throw new RangeError("status code ack: status_code is a two-digit F-1-21 code");
  if (source !== "lsdu" && source !== "se" && source !== "f121_file") throw new RangeError("status code ack: source must be lsdu, se or f121_file");
  if (typeof r.accepted !== "boolean") throw new RangeError("status code ack: accepted must be true or false");
  const on = r.accepted_on; if (!isoDate(on)) throw new RangeError("status code ack: accepted_on must be YYYY-MM-DD");
  return { loan_id: loan, period, status_code: code, accepted: r.accepted, ack_id: ackId, source, accepted_on: plainDate(on), reason_code: typeof r.reason_code === "string" ? r.reason_code : null, message: typeof r.message === "string" ? r.message : null };
}
export function ingestStatusCodeAck(em: Emitter, a: StatusCodeAck): DomainEvent {
  return em.events.append({ type: a.accepted ? "investor.event.accepted" : "investor.event.rejected", loanId: a.loan_id, actor: em.actor, payload: { event_type: "delinquency_status", status_code: a.status_code, period: a.period, source: a.source, ack_id: a.ack_id, accepted_on: a.accepted_on, reason_code: a.reason_code ?? null, message: a.message ?? null } });
}

// ───────────────────────────── Forbearance Exception Request Template (LL-2026-01; T2) ─────────────────────────────
export interface ExceptionPackage { readonly kind: "forbearance_extension"; readonly loan: Record<string, unknown>; readonly hardship: string; readonly delinquency_projection: { readonly months_delinquent_at_start: number; readonly at_requested_term_end: number; readonly cap: 12 }; readonly prior_terms: readonly { term_no: number; term_start: PlainDate; term_end: PlainDate; months: number }[]; readonly computation: TermComputation; readonly recommendation: string; }
/** The package the agent prepares for `officer` / `fnma_portal_operator`: loan data, hardship, delinquency projection, prior terms, recommendation. Refuses a request the caps already allow (no exception needed). */
export function prepareExceptionPackage(i: { loan: Record<string, unknown>; hardship: string; requested_months: number; cumulative_months: number; months_delinquent_at_start: number; start_on: PlainDate; prior_terms: readonly { term_no: number; term_start: PlainDate; term_end: PlainDate; months: number }[]; last_scheduled_payment_date?: PlainDate | null; mbs?: boolean; recommendation?: string }): ExceptionPackage {
  if (!(i.requested_months >= 1)) throw new RangeError("requested_months must be ≥1");
  const c = termComputation({ requested_months: i.requested_months, cumulative_months: i.cumulative_months, months_delinquent_at_start: i.months_delinquent_at_start, start_on: i.start_on, last_scheduled_payment_date: i.last_scheduled_payment_date ?? null, mbs: i.mbs === true });
  if (!c.exception_required) throw new RangeError(`a ${i.requested_months}-month term is within the caps (engine offers ${c.chosen}) — no Forbearance Exception Request is needed`);
  if (!c.capped_by.every((k) => EXCEPTION_CAPS.has(k))) throw new RangeError(`the ${c.capped_by.join("+")} guard is not subject to the exception template (D2-3.2-01)`);
  return { kind: "forbearance_extension", loan: i.loan, hardship: i.hardship, delinquency_projection: { months_delinquent_at_start: i.months_delinquent_at_start, at_requested_term_end: i.months_delinquent_at_start + i.requested_months, cap: 12 }, prior_terms: [...i.prior_terms], computation: c, recommendation: i.recommendation ?? `request ${i.requested_months} months (engine cap ${c.chosen}; ${c.capped_by.join(", ")})` };
}
export function submitExceptionRequest(em: Emitter, i: { loan_id: string; exception_request_id: string; channel: string; package_document_id: string; requested_months: number; submitted_on?: PlainDate | null }): { submitted_on: PlainDate; follow_up_by: PlainDate; event: DomainEvent } {
  if (!i.channel) throw new RangeError("channel (email/portal per current Fannie Mae instruction) is required");
  if (!i.package_document_id) throw new RangeError("package_document_id (the completed Forbearance Exception Request Template) is required");
  const on = i.submitted_on ?? today(em);
  const event = em.events.append({ type: "fnma_exception_request.submitted", loanId: i.loan_id, actor: em.actor, payload: { exception_request_id: i.exception_request_id, kind: "forbearance_extension", channel: i.channel, package_document_id: i.package_document_id, requested_months: i.requested_months, submitted_on: on, submitted_at: em.now } });
  return { submitted_on: on, follow_up_by: addBusinessDays(on, 10, fannieEt), event };
}
export interface ExceptionDecision { readonly exception_request_id: string; readonly decision: "approved" | "denied"; readonly decided_on: PlainDate; readonly evidence_document_id: string; readonly approved_months: number | null; }
/** Fannie Mae's written decision (email/portal evidence) validated before it lifts a cap. */
export function validateExceptionDecision(r: Record<string, unknown>): ExceptionDecision {
  const id = r.exception_request_id ?? r.id; if (typeof id !== "string" || !id) throw new RangeError("exception decision: exception_request_id is required");
  if (r.decision !== "approved" && r.decision !== "denied") throw new RangeError("exception decision: decision must be approved or denied");
  if (!isoDate(r.decided_on)) throw new RangeError("exception decision: decided_on must be YYYY-MM-DD");
  if (typeof r.evidence_document_id !== "string" || !r.evidence_document_id) throw new RangeError("exception decision: evidence_document_id (Fannie Mae's written approval) is required");
  const months = r.approved_months === undefined || r.approved_months === null ? null : Number(r.approved_months);
  if (months !== null && !(months >= 1)) throw new RangeError("exception decision: approved_months must be ≥1");
  return { exception_request_id: id, decision: r.decision, decided_on: plainDate(r.decided_on), evidence_document_id: r.evidence_document_id, approved_months: months };
}
export function recordExceptionDecision(em: Emitter, loanId: string, d: ExceptionDecision): DomainEvent {
  return em.events.append({ type: "fnma_exception_request.decided", loanId, actor: em.actor, payload: { exception_request_id: d.exception_request_id, kind: "forbearance_extension", decision: d.decision, decided_on: d.decided_on, evidence_document_id: d.evidence_document_id, approved_months: d.approved_months } });
}
/** T7 / rule 3: the suppression ends the day before the default date — late charges accrue from the default date only, never for plan months. */
export function liftLateChargeSuppression(i: { suppressed_from: PlainDate; late_charges_from: PlainDate }): { suppressed_from: PlainDate; suppressed_to: PlainDate; late_charges_from: PlainDate; retroactive_assessment: false } {
  if (i.late_charges_from <= i.suppressed_from) throw new RangeError(`late_charges_from ${i.late_charges_from} is not after the suppression start ${i.suppressed_from}`);
  return { suppressed_from: i.suppressed_from, suppressed_to: addDays(i.late_charges_from, -1), late_charges_from: i.late_charges_from, retroactive_assessment: false };
}
