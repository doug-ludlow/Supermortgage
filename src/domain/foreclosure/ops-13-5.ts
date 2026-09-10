/**
 * §13.5 operating rules over the pure calculators in ./timeframes.ts — the foreclosure time-frame tracker
 * (`fc_timeframe_tracking`, `fc_delay_credits`, `comp_fee_bills`) that arms and satisfies the 13.5 timer rows
 * (timers-13-5.ts / ../timers.ts) by appending the events those rows name:
 *
 *   - `referralSent`        — 13.3's referral (`foreclosure.refer`) is recorded on the tracker; the
 *                             `foreclosure.referral.sent` event carries the 13.5-computed anchors
 *                             `allowable_timeframe_ends_on` (FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE) and
 *                             `allowable_timeframe_warning_on` (FNMA_E3215_TIMEFRAME_WARNING_70) — E-3.2-15.
 *   - `saleHeld`            — the firm's / DRA's sale record closes the clock: `foreclosure.sale.held`,
 *                             exposure computed under the exhibit in force on the sale date (LL-2025-01).
 *   - `saleRescinded`       — `foreclosure.sale.rescinded{cause=servicer_error}` books $1,000 + third-party
 *                             costs (`comp_fee_exposure.booked{kind=rescission}`, A1-4.2-02) and reopens the clock.
 *   - `monthEndStatusReview`— the monthly snapshot job (BD3): a foreclosure status-code change at month-end
 *                             appends `period.month_end{foreclosure_status_changed=true}` (F-1-21 BD2 clock).
 *   - `checkExhibit`        — the compliance-sentinel fetch of the exhibit: `exhibit.checked{exhibit=allowable_timeframes}`.
 *   - `firmMethodProposal`  — the firm's non-preferred method: `firm.method_deviation.proposed` (Form 20 gate).
 *   - `ingestCompFeeBill`   — a Fannie Mae Connect compensatory-fee bill: `comp_fee_bill.received` (30-day rebuttal
 *                             clock), rebuttal package drafted, `officer` escalation.
 *   - `onBreach`            — the breach actions of the timer table (at_risk + firm status demand; over_allowable +
 *                             root cause; credit marked `reported_timely=false`).
 *
 * Every inbound record is validated before an event is appended; exposure math is the calculator's (the model
 * cannot add credits — spec 13.5 guardrails).
 */
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { type PlainDate, plainDate, addDays, daysBetween, endOfMonth, parts, ymd, addMonths } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { EXHIBITS, allowable, creditDelays, exposure, projectedExposure, exposureCents, isDelayCategory, atRisk, RESCISSION_EXPOSURE_CENTS, type ExhibitVersion, type Delay, type Method, type AllowableRow } from "./timeframes.ts";
import { rescissionExposure, methodDeviation } from "./ops.ts";

type Row = Record<string, unknown>;
export interface TrackerRecord { readonly id: string; readonly data: Row }
/** The slice of src/app/tools.ts `EntityStore` the tracker needs (structural; the app's store satisfies it). */
export interface TrackerStore {
  get(kind: string, id: string): TrackerRecord | undefined;
  list(kind: string, where?: (d: Row) => boolean): readonly TrackerRecord[];
  put(kind: string, id: string, data: Row, by: Actor, now: string): TrackerRecord;
}
export interface TrackerEscalations { open(input: { kind: "officer" | "attorney" | "human_agent" | "sev2"; loanId?: string; severity?: string; payload?: Row }, by: Actor): unknown }
export interface TrackerDeps { readonly events: EventStore; readonly store: TrackerStore; readonly escalations?: TrackerEscalations; readonly clock: { now(): string }; readonly actor?: Actor; readonly exhibits?: readonly ExhibitVersion[] }

export const TRACKER_ACTOR: Actor = { kind: "agent", id: "foreclosure-ops" };
export const TRACKING = "fc_timeframe_tracking";
export const CREDITS = "fc_delay_credits";
export const BILLS = "comp_fee_bills";
export const STATUS_HISTORY = "delinquency_status_history";
export const EXHIBIT_WATCH = "exhibit_watch";
export const EXHIBIT_ID = "allowable_timeframes";
export type RescissionReason = "missed_dmdc_check" | "dual_tracking" | "bankruptcy_stay" | "firm_error";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^\d{4}-\d{2}$/;
const METHODS: readonly Method[] = ["judicial", "non_judicial"];

const isoDate = (v: unknown, field: string): PlainDate => { const s = typeof v === "string" ? v.slice(0, 10) : ""; if (!ISO_DATE.test(s)) throw new RangeError(`${field} must be an ISO date (got ${String(v)})`); return plainDate(s); };
const optDate = (v: unknown): PlainDate | null => (typeof v === "string" && ISO_DATE.test(v.slice(0, 10)) ? plainDate(v.slice(0, 10)) : null);
const toCents = (v: unknown): Cents | null => { if (typeof v === "bigint") return v; if (v === undefined || v === null || v === "") return null; try { return BigInt(String(v)); } catch { return null; } };
const nonEmpty = (v: unknown, field: string): string => { const s = typeof v === "string" ? v.trim() : ""; if (!s) throw new RangeError(`${field} is required`); return s; };
export const periodOf = (d: PlainDate): string => d.slice(0, 7);
const priorPeriod = (period: string): string => { const { y, m } = parts(plainDate(`${period}-01`)); return periodOf(addMonths(ymd(y, m, 1), -1)); };

/** Operational prerequisite: the exhibit in code plus every retained version loaded into `jurisdiction_rules.foreclosure.allowable_days` (`{exhibit_version, effective_sales_on_or_after, allowable_days}`) — the prior version stays loaded for sales before July 1, 2025; a row missing its version or effective date is refused, never defaulted. */
export function loadedExhibits(store: TrackerStore, builtIn: readonly ExhibitVersion[] = EXHIBITS): ExhibitVersion[] {
  const rows = store.list("jurisdiction_rules", (d) => d.rule === "foreclosure.allowable_days");
  const out = new Map<string, ExhibitVersion>(builtIn.map((e) => [e.exhibit_version, e]));
  for (const r of rows) {
    const version = nonEmpty(r.data.exhibit_version, `jurisdiction_rules ${r.id}: exhibit_version`);
    const effective = isoDate(r.data.effective_sales_on_or_after, `jurisdiction_rules ${r.id}: effective_sales_on_or_after`);
    const days = r.data.allowable_days; if (!days || typeof days !== "object") throw new RangeError(`jurisdiction_rules ${r.id}: allowable_days is required`);
    const table: Record<string, AllowableRow> = {};
    for (const [st, v] of Object.entries(days as Record<string, Row>)) {
      const n = Number(v.days); const method = String(v.method) as Method;
      if (!Number.isInteger(n) || n <= 0 || !METHODS.includes(method)) throw new RangeError(`jurisdiction_rules ${r.id}: ${st} needs integer days and a method (judicial|non_judicial)`);
      const nyc = v.nyc_days === undefined || v.nyc_days === null ? undefined : Number(v.nyc_days);
      table[st.toUpperCase()] = { days: n, method, ...(nyc !== undefined && Number.isInteger(nyc) ? { nyc_days: nyc } : {}) };
    }
    out.set(version, { exhibit_version: version, effective_sales_on_or_after: effective, allowable_days: table });
  }
  return [...out.values()].sort((a, b) => (a.effective_sales_on_or_after < b.effective_sales_on_or_after ? -1 : 1));
}

export interface ReferralInput { readonly loan_id: string; readonly case_id: string; readonly state: string; readonly county?: string | null; readonly lpi_due_date: string; readonly sent_at?: string; readonly firm_id?: string | null; readonly method_used?: Method | null; readonly upb_cents?: Cents | string | null; readonly ptr_pct?: string | null }
export interface SaleInput { readonly loan_id: string; readonly case_id?: string | null; readonly sale_on: string; readonly source: "dra" | "firm" | "attorney_network"; readonly reference?: string | null }
export interface RescissionInput extends Omit<SaleInput, "sale_on"> { readonly rescinded_on: string; readonly reason: RescissionReason; readonly third_party_costs_cents: Cents }
export interface ExhibitFetch { readonly hash: string; readonly fetched_at: string; readonly source_url?: string; readonly exhibit_version_seen?: string | null }
export interface MethodProposal { readonly loan_id: string; readonly case_id?: string | null; readonly proposed_method: string; readonly state?: string | null; readonly county?: string | null; readonly firm_id?: string | null; readonly form20_approval_id?: string | null }
export interface CompFeeBillRecord { readonly bill_id?: string | null; readonly period: string; readonly fnma_reference?: string | null; readonly loan_id: string; readonly days_billed: number | string; readonly upb_cents: Cents | string; readonly ptr: string; readonly amount_cents: Cents | string; readonly received_at: string; readonly allocation?: "supermortgage" | "partner" | "shared" | null }

export class TimeframeTracker {
  private readonly d: TrackerDeps; private readonly actor: Actor;
  constructor(deps: TrackerDeps) { this.d = deps; this.actor = deps.actor ?? TRACKER_ACTOR; }
  private now(): string { return this.d.clock.now(); }
  private today(): PlainDate { return plainDate(this.now().slice(0, 10)); }
  private exhibits(): readonly ExhibitVersion[] { return this.d.exhibits ?? loadedExhibits(this.d.store); }
  private emit(type: string, loanId: string | null, payload: Row, aggregate?: { kind: string; id: string }): DomainEvent {
    return this.d.events.append({ type, ...(loanId ? { loanId } : {}), ...(aggregate ? { aggregate } : {}), actor: this.actor, occurredAt: this.now(), payload });
  }
  private escalate(kind: "officer" | "attorney" | "human_agent" | "sev2", loanId: string | null, severity: string, payload: Row): void {
    this.d.escalations?.open({ kind, ...(loanId ? { loanId } : {}), severity, payload }, this.actor);
  }
  tracking(loanId: string, caseId?: string | null): TrackerRecord | null {
    return this.d.store.list(TRACKING, (d) => (caseId ? d.case_id === caseId : d.loan_id === loanId && !String(d.status ?? "").startsWith("closed")))[0] ?? this.d.store.list(TRACKING, (d) => d.loan_id === loanId).at(-1) ?? null;
  }
  /** The tracker's delay-credit rows as calculator inputs (rule 2: `reported_timely` from the 5.4 acknowledgment, never the caller). */
  delays(caseId: string, asOf: PlainDate): Delay[] {
    return this.d.store.list(CREDITS, (d) => d.case_id === caseId).map((r) => { const d = r.data; if (!isDelayCategory(d.category)) throw new RangeError(`${CREDITS} ${r.id}: ${String(d.category)} is not a comp_fee_delay_rules category`);
      return { id: r.id, category: d.category, from: isoDate(d.begin_on, `${CREDITS} ${r.id}: begin_on`), to: optDate(d.end_on) ?? asOf, reported_timely: d.reported_timely === true, ...(typeof d.status_code_reported === "string" ? { status_code_reported: d.status_code_reported } : {}) }; });
  }
  private anchors(lpi: PlainDate, allowableDays: number, credited: number): { allowable_timeframe_ends_on: PlainDate; allowable_timeframe_warning_on: PlainDate } {
    return { allowable_timeframe_ends_on: addDays(lpi, allowableDays + credited), allowable_timeframe_warning_on: addDays(lpi, Math.ceil(0.7 * (allowableDays + credited))) };
  }

  /** 13.3's referral starts tracking (E-3.2-15: the clock runs from the LPI due date, not the referral). The event carries the computed anchors the two E-3.2-15 timer rows anchor on. */
  referralSent(i: ReferralInput): { tracking: TrackerRecord; event: DomainEvent } {
    const loanId = nonEmpty(i.loan_id, "loan_id"); const caseId = nonEmpty(i.case_id, "case_id"); const state = nonEmpty(i.state, "state").toUpperCase();
    const lpi = isoDate(i.lpi_due_date, "lpi_due_date"); const sentAt = i.sent_at ?? this.now(); const sentOn = isoDate(sentAt, "sent_at");
    if (lpi >= sentOn) throw new RangeError(`lpi_due_date ${lpi} must precede the referral ${sentOn} (E-3.2-15: the clock runs from the LPI due date)`);
    if (i.method_used && !METHODS.includes(i.method_used)) throw new RangeError(`method_used ${String(i.method_used)} is not judicial|non_judicial`);
    const a = allowable(state, i.county ?? null, null, this.exhibits());
    const credited = creditDelays(this.delays(caseId, sentOn), { lpi_due: lpi }).credited_days;
    const anchors = this.anchors(lpi, a.days, credited);
    const upb = toCents(i.upb_cents); const ptr = i.ptr_pct ?? null;
    const tracking = this.d.store.put(TRACKING, caseId, { case_id: caseId, loan_id: loanId, state, county: i.county ?? null, nyc: a.nyc, method_used: i.method_used ?? a.method, method_preferred: a.method, method_deviation_form20_id: null,
      lpi_due_date: lpi, allowable_days: a.days, exhibit_version: a.exhibit_version, referral_sent_at: sentAt, firm_id: i.firm_id ?? null, sale_held_at: null, actual_days: null, credited_delay_days: credited, excess_days: 0, exposure_cents: null, exposure_as_of: null, status: "tracking",
      upb_cents: upb === null ? null : upb.toString(), ptr_pct: ptr, ...anchors }, this.actor, this.now());
    const event = this.emit("foreclosure.referral.sent", loanId, { case_id: caseId, firm_id: i.firm_id ?? null, referral_sent_at: sentAt, lpi_due_date: lpi, state, nyc: a.nyc, method_preferred: a.method, method_used: i.method_used ?? a.method, allowable_days: a.days, credited_delay_days: credited, exhibit_version: a.exhibit_version, ...anchors }, { kind: "case", id: caseId });
    if (upb === null || !ptr) this.escalate("human_agent", loanId, "sev3", { case_id: caseId, alert: "data_quality", reason: "missing UPB/PTR — exposure is null until 5.x boarding fields are present (13.5 Integrations: failure mode)" });
    return { tracking, event };
  }

  /** Rule 5 / state machine: an open case's projection as of a date (today or the firm's forecast). */
  project(loanId: string, asOf: PlainDate, caseId?: string | null): { tracking: TrackerRecord; exposure: ReturnType<typeof projectedExposure> | null; elapsed: number; threshold: number } {
    const t = this.tracking(loanId, caseId); if (!t) throw new RangeError(`no ${TRACKING} row for ${loanId}`);
    const lpi = isoDate(t.data.lpi_due_date, "lpi_due_date"); const delays = this.delays(String(t.data.case_id), asOf);
    const allowableDays = Number(t.data.allowable_days); const c = creditDelays(delays, { lpi_due: lpi });
    const upb = toCents(t.data.upb_cents); const ptr = typeof t.data.ptr_pct === "string" && t.data.ptr_pct ? t.data.ptr_pct : null;
    const e = upb === null || ptr === null ? null : projectedExposure({ lpi_due: lpi, as_of: asOf, allowable: allowableDays, delays, upb_cents: upb, ptr_pct: ptr });
    return { tracking: t, exposure: e, elapsed: daysBetween(lpi, asOf), threshold: Math.ceil(0.7 * (allowableDays + c.credited_days)) };
  }

  /** Timer table FNMA_E3215_TIMEFRAME_WARNING_70 breach / 13.5-T5: elapsed ≥ 70% of (allowable + credits) → `fc.timeframe.at_risk` (spec Outputs; spelled `foreclosure.timeframe.at_risk` here, as ops.ts `timeframeWarning`) and a firm status demand (13.6 monthly status demand on at_risk cases). Idempotent per case. */
  review(loanId: string, asOf: PlainDate = this.today(), caseId?: string | null): { status: string; at_risk: boolean; elapsed: number; threshold: number; instruction: TrackerRecord | null; events: DomainEvent[] } {
    const p = this.project(loanId, asOf, caseId); const t = p.tracking; const status = String(t.data.status);
    const credited = p.exposure?.credited_days ?? Number(t.data.credited_delay_days ?? 0); const allowableDays = Number(t.data.allowable_days);
    const risk = atRisk(p.elapsed, allowableDays, credited); const over = p.elapsed > allowableDays + credited;
    const events: DomainEvent[] = []; let instruction: TrackerRecord | null = null;
    if (status === "tracking" && risk) {
      const cid = String(t.data.case_id);
      this.d.store.put(TRACKING, cid, { status: over ? "over_allowable" : "at_risk_70pct", exposure_cents: p.exposure ? p.exposure.exposure_cents.toString() : null, exposure_as_of: asOf, credited_delay_days: credited }, this.actor, this.now());
      events.push(this.emit("foreclosure.timeframe.at_risk", loanId, { case_id: cid, elapsed_days: p.elapsed, threshold_days: p.threshold, allowable_days: allowableDays, credited_delay_days: credited, projected_exposure_cents: p.exposure ? p.exposure.exposure_cents.toString() : null }));
      const due = addBusinessDays(asOf, 2, servicer);
      instruction = this.d.store.put("attorney_instructions", `ai-${loanId}-STATUS_DEMAND-${this.now()}`, { loan_id: loanId, case_id: cid, kind: "STATUS_DEMAND", firm_id: t.data.firm_id ?? null, sent_at: this.now(), due_on: due, status: "sent", ack_due_business_days: 2, reason: `time frame at ${p.elapsed}/${allowableDays + credited} days (≥70%): firm status and forecast sale date required (E-3.2-15; 13.6)` }, this.actor, this.now());
      events.push(this.emit("attorney.instruction.sent", loanId, { instruction_id: instruction.id, kind: "STATUS_DEMAND", case_id: cid, due_on: due }));
    }
    if (over && String(this.tracking(loanId, caseId)?.data.status) !== "over_allowable") events.push(...this.exceeded(loanId, asOf, caseId));
    return { status: String(this.tracking(loanId, caseId)?.data.status ?? status), at_risk: risk, elapsed: p.elapsed, threshold: p.threshold, instruction, events };
  }
  /** FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE breach: `status=over_allowable`, `fc.timeframe.exceeded{excess_days}`, sev 2 → foreclosure-ops root cause (rule 7), `officer` monthly. */
  private exceeded(loanId: string, asOf: PlainDate, caseId?: string | null): DomainEvent[] {
    const p = this.project(loanId, asOf, caseId); const cid = String(p.tracking.data.case_id);
    const excess = p.exposure?.excess_days ?? Math.max(0, p.elapsed - Number(p.tracking.data.allowable_days) - Number(p.tracking.data.credited_delay_days ?? 0));
    this.d.store.put(TRACKING, cid, { status: "over_allowable", excess_days: excess, exposure_cents: p.exposure ? p.exposure.exposure_cents.toString() : null, exposure_as_of: asOf }, this.actor, this.now());
    const e = this.emit("fc.timeframe.exceeded", loanId, { case_id: cid, excess_days: excess, projected_exposure_cents: p.exposure ? p.exposure.exposure_cents.toString() : null, as_of: asOf });
    this.escalate("sev2", loanId, "sev2", { case_id: cid, excess_days: excess, action: "root_cause_classification", owner: "foreclosure-ops", report: "compliance_sentinel", review: "officer_monthly" });
    return [e];
  }

  /** The firm's / DRA's sale record ends the clock (`foreclosure.sale.held` satisfies both E-3.2-15 rows). Exposure under the exhibit in force on the sale date (rule "sale date on or after"); terminal `closed_within` / `closed_over`. */
  saleHeld(i: SaleInput): { tracking: TrackerRecord; exposure: ReturnType<typeof exposure> | null; events: DomainEvent[] } {
    const loanId = nonEmpty(i.loan_id, "loan_id"); const saleOn = isoDate(i.sale_on, "sale_on"); if (!["dra", "firm", "attorney_network"].includes(i.source)) throw new RangeError(`sale source ${String(i.source)} is not dra|firm|attorney_network`);
    const t = this.tracking(loanId, i.case_id); if (!t) throw new RangeError(`no ${TRACKING} row for ${loanId}: the referral must be recorded before a sale`);
    const cid = String(t.data.case_id); const lpi = isoDate(t.data.lpi_due_date, "lpi_due_date"); const referredOn = optDate(t.data.referral_sent_at);
    if (referredOn && saleOn < referredOn) throw new RangeError(`sale ${saleOn} precedes the referral ${referredOn}`);
    if (saleOn > this.today()) throw new RangeError(`sale ${saleOn} is in the future (a forecast sale date is a projection, not a sale held)`);
    const a = allowable(String(t.data.state), (t.data.county as string | null) ?? null, saleOn, this.exhibits());
    const delays = this.delays(cid, saleOn); const upb = toCents(t.data.upb_cents); const ptr = typeof t.data.ptr_pct === "string" && t.data.ptr_pct ? t.data.ptr_pct : null;
    const c = creditDelays(delays, { lpi_due: lpi }); const actual = daysBetween(lpi, saleOn);
    const e = upb === null || ptr === null ? null : exposure({ lpi_due: lpi, sale_on: saleOn, allowable: a.days, delays, upb_cents: upb, ptr_pct: ptr });
    const excess = e?.excess_days ?? Math.max(0, actual - a.days - c.credited_days); const status = excess > 0 ? "closed_over" : "closed_within";
    const tracking = this.d.store.put(TRACKING, cid, { sale_held_at: saleOn, actual_days: actual, allowable_days: a.days, exhibit_version: a.exhibit_version, credited_delay_days: c.credited_days, excess_days: excess, exposure_cents: e ? e.exposure_cents.toString() : null, exposure_as_of: saleOn, status, sale_source: i.source, sale_reference: i.reference ?? null }, this.actor, this.now());
    const events: DomainEvent[] = [this.emit("foreclosure.sale.held", loanId, { case_id: cid, sale_on: saleOn, source: i.source, reference: i.reference ?? null, actual_days: actual, allowable_days: a.days, exhibit_version: a.exhibit_version, credited_delay_days: c.credited_days, excess_days: excess, exposure_cents: e ? e.exposure_cents.toString() : null, status }, { kind: "case", id: cid })];
    events.push(this.emit("comp_fee.exposure.updated", loanId, { case_id: cid, exposure_cents: e ? e.exposure_cents.toString() : null, excess_days: excess, at_risk_days: e?.at_risk_days ?? c.at_risk_days, exposure_if_at_risk_credited_cents: e ? e.exposure_if_at_risk_credited_cents.toString() : null, as_of: saleOn, basis: "sale_held" }));
    if (excess > 0) { events.push(this.emit("fc.timeframe.exceeded", loanId, { case_id: cid, excess_days: excess, exposure_cents: e ? e.exposure_cents.toString() : null, as_of: saleOn })); this.escalate("sev2", loanId, "sev2", { case_id: cid, excess_days: excess, action: "root_cause_classification", owner: "foreclosure-ops" }); }
    if (e === null) this.escalate("human_agent", loanId, "sev3", { case_id: cid, alert: "data_quality", reason: "missing UPB/PTR — exposure null (13.5 Integrations: failure mode)" });
    return { tracking, exposure: e, events };
  }

  /** A1-4.2-02 / 13.5-T6: a sale rescinded for servicer error books $1,000 + third-party costs as exposure with the root cause (`servicer:scra` for a missed DMDC check); the clock reopens to `tracking` and continues to the new sale. A firm-error rescission books nothing (allocation: firm). */
  saleRescinded(i: RescissionInput): { tracking: TrackerRecord; exposure_cents: Cents; root_cause: string; events: DomainEvent[] } {
    const loanId = nonEmpty(i.loan_id, "loan_id"); const on = isoDate(i.rescinded_on, "rescinded_on");
    if (!["missed_dmdc_check", "dual_tracking", "bankruptcy_stay", "firm_error"].includes(i.reason)) throw new RangeError(`rescission reason ${String(i.reason)} is not a classified cause`);
    if (typeof i.third_party_costs_cents !== "bigint" || i.third_party_costs_cents < 0n) throw new RangeError("third_party_costs_cents must be non-negative bigint cents");
    const t = this.tracking(loanId, i.case_id); if (!t) throw new RangeError(`no ${TRACKING} row for ${loanId}`);
    const cid = String(t.data.case_id); const held = optDate(t.data.sale_held_at); if (!held) throw new RangeError(`no sale held on ${cid} to rescind`); if (on < held) throw new RangeError(`rescission ${on} precedes the sale ${held}`);
    const r = rescissionExposure({ cause: i.reason, third_party_costs_cents: i.third_party_costs_cents }); const cause = r.servicer_error ? "servicer_error" : "firm_error";
    const events: DomainEvent[] = [this.emit("foreclosure.sale.rescinded", loanId, { case_id: cid, rescinded_on: on, sale_on: held, cause, reason: i.reason, root_cause: r.root_cause, source: i.source, reference: i.reference ?? null }, { kind: "case", id: cid })];
    const prior = toCents(t.data.rescission_exposure_cents) ?? 0n;
    if (r.servicer_error) events.push(this.emit("comp_fee_exposure.booked", loanId, { case_id: cid, kind: "rescission", exposure_cents: r.exposure_cents.toString(), admin_fee_cents: RESCISSION_EXPOSURE_CENTS.toString(), third_party_costs_cents: i.third_party_costs_cents.toString(), root_cause: r.root_cause, reason: i.reason, allocation: "supermortgage", rule_ref: "A1-4.2-02" }, { kind: "case", id: cid }));
    const tracking = this.d.store.put(TRACKING, cid, { status: "tracking", sale_held_at: null, actual_days: null, excess_days: 0, rescinded_on: on, rescission_cause: cause, rescission_root_cause: r.root_cause, rescission_exposure_cents: (prior + r.exposure_cents).toString(), exposure_as_of: on }, this.actor, this.now());
    events.push(this.emit("comp_fee.exposure.updated", loanId, { case_id: cid, rescission_exposure_cents: (prior + r.exposure_cents).toString(), as_of: on, basis: "sale_rescinded" }));
    if (r.servicer_error) this.escalate("sev2", loanId, "sev2", { case_id: cid, action: "root_cause_classification", root_cause: r.root_cause, exposure_cents: r.exposure_cents.toString() }); else this.escalate("attorney", loanId, "sev3", { case_id: cid, action: "firm_caused_rescission", reason: i.reason });
    return { tracking, exposure_cents: r.exposure_cents, root_cause: r.root_cause, events };
  }

  /** Monthly snapshot job (BD3) over the open cases: a foreclosure status-code change at month-end (F-1-21 hierarchy: the code reported for the period differs from the prior period's) appends `period.month_end{foreclosure_status_changed=true}` anchored on `period_end` — the F-1-21 BD2 reporting clock the accepted 5.4 status event satisfies. Every open case also gets its exposure snapshot. */
  monthEndStatusReview(i: { period_end: string }): { period: string; changed: DomainEvent[]; snapshots: DomainEvent[] } {
    const periodEnd = isoDate(i.period_end, "period_end"); if (periodEnd !== endOfMonth(periodEnd)) throw new RangeError(`period_end ${periodEnd} is not a month end`);
    const period = periodOf(periodEnd); const prior = priorPeriod(period); const changed: DomainEvent[] = []; const snapshots: DomainEvent[] = [];
    for (const t of this.d.store.list(TRACKING, (d) => !String(d.status ?? "").startsWith("closed"))) {
      const loanId = String(t.data.loan_id); const cid = String(t.data.case_id);
      const hist = this.d.store.list(STATUS_HISTORY, (d) => d.loan_id === loanId);
      const codeFor = (p: string): string | null => { const r = hist.filter((h) => h.data.period === p).at(-1); return r ? String(r.data.status_code ?? r.data.status ?? "") || null : null; };
      const cur = codeFor(period), prev = codeFor(prior);
      if (cur !== null && cur !== prev) changed.push(this.emit("period.month_end", loanId, { period, period_end: periodEnd, case_id: cid, foreclosure_status_changed: true, status_code: cur, previous_status_code: prev, report_by: "BD2 17:00 ET (legacy) / 03:00 ET next BD (event mode, 2027)" }, { kind: "case", id: cid }));
      const p = this.project(loanId, periodEnd, cid);
      this.d.store.put(TRACKING, cid, { exposure_cents: p.exposure ? p.exposure.exposure_cents.toString() : null, exposure_as_of: periodEnd, credited_delay_days: p.exposure?.credited_days ?? Number(t.data.credited_delay_days ?? 0) }, this.actor, this.now());
      snapshots.push(this.emit("comp_fee.exposure.updated", loanId, { case_id: cid, period, exposure_cents: p.exposure ? p.exposure.exposure_cents.toString() : null, excess_days: p.exposure?.excess_days ?? null, at_risk_days: p.exposure?.at_risk_days ?? null, elapsed_days: p.elapsed, as_of: periodEnd, basis: "monthly_snapshot" }));
    }
    return { period, changed, snapshots };
  }

  /** 5.4 acknowledgment (`investor_events.accepted{family=delinquency}`) for a period marks the credits whose code was reported in that period `reported_timely=true`; the F-1-21 clock's breach marks them `false` (`fc.delay_credit.at_risk`). */
  statusCodeAcknowledged(i: { loan_id: string; period: string; status_code: string; accepted: boolean; ack_id?: string | null }): { credits: TrackerRecord[]; events: DomainEvent[] } {
    const loanId = nonEmpty(i.loan_id, "loan_id"); if (!PERIOD.test(i.period)) throw new RangeError(`period ${i.period} is not YYYY-MM`); const code = nonEmpty(i.status_code, "status_code");
    const t = this.tracking(loanId); const cid = t ? String(t.data.case_id) : null; const out: TrackerRecord[] = []; const events: DomainEvent[] = [];
    this.d.store.put(STATUS_HISTORY, `${loanId}-${i.period}`, { loan_id: loanId, period: i.period, status_code: code, accepted: i.accepted, ack_id: i.ack_id ?? null, acknowledged_at: this.now() }, this.actor, this.now());
    if (!cid) return { credits: out, events };
    for (const c of this.d.store.list(CREDITS, (d) => d.case_id === cid && d.status_code_reported === code)) {
      const from = isoDate(c.data.begin_on, "begin_on"); const to = optDate(c.data.end_on) ?? this.today(); const covers = periodOf(from) <= i.period && i.period <= periodOf(to); if (!covers) continue;
      out.push(this.d.store.put(CREDITS, c.id, { reported_timely: i.accepted, report_ack_id: i.ack_id ?? null }, this.actor, this.now()));
      events.push(this.emit(i.accepted ? "fc.delay_credit.closed" : "fc.delay_credit.at_risk", loanId, { credit_id: c.id, case_id: cid, period: i.period, status_code: code, reported_timely: i.accepted }));
    }
    return { credits: out, events };
  }

  /** SM_EXHIBIT_WATCH_MONTHLY: the compliance-sentinel fetch of the Foreclosure Time Frames exhibit (and LL feed) — `exhibit.checked{exhibit=allowable_timeframes}` with the hash comparison; a change opens the rules re-versioning task (new `exhibit_version` loaded, never auto-applied). A fetch failure keeps the current version and alerts. */
  checkExhibit(i: ExhibitFetch | { failed: true; error: string; fetched_at: string }): { changed: boolean | null; event: DomainEvent } {
    const at = isoDate(i.fetched_at, "fetched_at"); const current = this.d.store.get(EXHIBIT_WATCH, EXHIBIT_ID)?.data ?? null; const version = String(current?.exhibit_version ?? this.exhibits().at(-1)!.exhibit_version);
    if ("failed" in i) { this.escalate("human_agent", null, "sev3", { exhibit: EXHIBIT_ID, error: i.error, action: "keep current exhibit version; retry the fetch" }); return { changed: null, event: this.emit("exhibit.checked", null, { exhibit: EXHIBIT_ID, checked_on: at, fetch_failed: true, error: i.error, current_version: version, changed: null }) }; }
    const hash = nonEmpty(i.hash, "hash").toLowerCase(); if (!/^[0-9a-f]{16,128}$/.test(hash)) throw new RangeError("hash must be a hex digest");
    const changed = current?.hash !== undefined && current.hash !== null ? current.hash !== hash : false;
    this.d.store.put(EXHIBIT_WATCH, EXHIBIT_ID, { exhibit: EXHIBIT_ID, hash, exhibit_version: version, checked_on: at, source_url: i.source_url ?? null, changed, ...(changed ? { pending_version: i.exhibit_version_seen ?? null } : {}) }, this.actor, this.now());
    const event = this.emit("exhibit.checked", null, { exhibit: EXHIBIT_ID, checked_on: at, hash, previous_hash: current?.hash ?? null, changed, current_version: version, version_seen: i.exhibit_version_seen ?? null });
    if (changed) { this.emit("exhibit.changed", null, { exhibit: EXHIBIT_ID, current_version: version, version_seen: i.exhibit_version_seen ?? null, action: "load new exhibit_version into jurisdiction_rules.foreclosure.allowable_days and re-version comp_fee_delay_rules" }); this.escalate("human_agent", null, "sev2", { exhibit: EXHIBIT_ID, changed: true, version_seen: i.exhibit_version_seen ?? null, action: "new exhibit_version loaded, rules re-versioned (13.5 timer table)" }); }
    return { changed, event };
  }

  /** Rule 6 / 13.5-T9: the firm proposes a method; a non-preferred one (exhibit) is a deviation — `firm.method_deviation.proposed` arms FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE, and first-notice authorization is refused until the Form 20 approval (13.7). Exposure stays on the preferred method's days. */
  firmMethodProposal(i: MethodProposal): { deviation: boolean; preferred_method: Method; allowed: boolean; refusal: string | null; event: DomainEvent | null } {
    const loanId = nonEmpty(i.loan_id, "loan_id"); const method = nonEmpty(i.proposed_method, "proposed_method") as Method; if (!METHODS.includes(method)) throw new RangeError(`proposed_method ${method} is not judicial|non_judicial`);
    const t = this.tracking(loanId, i.case_id); const state = String(i.state ?? t?.data.state ?? ""); if (!state) throw new RangeError("state is required (fc_timeframe_tracking.state)");
    const a = allowable(state, i.county ?? (t?.data.county as string | null) ?? null, null, this.exhibits());
    if (method === a.method) { if (t) this.d.store.put(TRACKING, String(t.data.case_id), { method_used: method }, this.actor, this.now()); return { deviation: false, preferred_method: a.method, allowed: true, refusal: null, event: null }; }
    const cid = String(i.case_id ?? t?.data.case_id ?? loanId); const form20 = i.form20_approval_id ?? null;
    const fc = this.d.store.get("foreclosure_cases", cid)?.data ?? {};
    this.d.store.put("foreclosure_cases", cid, { ...fc, loan_id: loanId, method_deviation: true, proposed_method: method, method_preferred: a.method, form20_approval_id: form20, status: fc.status ?? "referred" }, this.actor, this.now());
    if (t) this.d.store.put(TRACKING, String(t.data.case_id), { method_used: method, method_deviation_form20_id: form20 }, this.actor, this.now());
    const event = this.emit("firm.method_deviation.proposed", loanId, { case_id: cid, firm_id: i.firm_id ?? null, method, preferred_method: a.method, state: state.toUpperCase(), form20_approval_id: form20, exposure_basis: `preferred method (${a.method}, ${a.days} days)` }, { kind: "case", id: cid });
    const m = methodDeviation({ preferred_method: false, form20_approval_id: form20 });
    if (!m.allowed) this.escalate("attorney", loanId, "sev3", { case_id: cid, gate: m.gate, action: "Form 20 to Regional Counsel before initiation (13.7)", method, preferred_method: a.method });
    return { deviation: true, preferred_method: a.method, allowed: m.allowed, refusal: m.refusal, event };
  }

  /** 13.5-T8: a compensatory-fee bill from Fannie Mae Connect is validated (period, loan, days, UPB, PTR, amount = UPB × PTR/365 × days), stored in `comp_fee_bills`, appended as `comp_fee_bill.received` (SM_COMP_FEE_BILL_REBUTTAL_30: +30 calendar days from receipt), the rebuttal package drafted and the `officer` escalated (bill acceptance or officer-signed rebuttal). */
  ingestCompFeeBill(b: CompFeeBillRecord): { bill: TrackerRecord; package: TrackerRecord; rebuttal_due_on: PlainDate; variance_cents: Cents; exposure_variance_cents: Cents | null; event: DomainEvent } {
    const loanId = nonEmpty(b.loan_id, "loan_id"); if (!PERIOD.test(String(b.period))) throw new RangeError(`period ${String(b.period)} is not YYYY-MM`);
    const days = Number(b.days_billed); if (!Number.isInteger(days) || days <= 0) throw new RangeError("days_billed must be a positive integer");
    const upb = toCents(b.upb_cents); if (upb === null || upb <= 0n) throw new RangeError("upb_cents must be positive bigint cents"); const ptr = nonEmpty(b.ptr, "ptr"); if (!/^\d+(\.\d+)?$/.test(ptr)) throw new RangeError(`ptr ${ptr} is not a decimal percentage`);
    const amount = toCents(b.amount_cents); if (amount === null || amount < 0n) throw new RangeError("amount_cents must be non-negative bigint cents");
    const receivedOn = isoDate(b.received_at, "received_at"); const allocation = b.allocation ?? "supermortgage"; if (!["supermortgage", "partner", "shared"].includes(allocation)) throw new RangeError(`allocation ${String(allocation)} is not supermortgage|partner|shared`);
    const billId = b.bill_id ?? `bill-${loanId}-${b.period}`; if (this.d.store.get(BILLS, billId)) throw new RangeError(`comp_fee_bills ${billId} already received (bills are append-only)`);
    const expected = exposureCents(upb, ptr, days); const variance = amount - expected;
    const t = this.tracking(loanId); const tracked = t ? toCents(t.data.exposure_cents) : null; const exposureVariance = tracked === null ? null : amount - tracked;
    const dueOn = addDays(receivedOn, 30);
    const bill = this.d.store.put(BILLS, billId, { bill_id: billId, period: b.period, fnma_reference: b.fnma_reference ?? null, loan_id: loanId, case_id: t ? t.data.case_id : null, days_billed: days, upb_cents: upb.toString(), ptr, amount_cents: amount.toString(), recomputed_cents: expected.toString(), variance_cents: variance.toString(), tracked_exposure_cents: tracked === null ? null : tracked.toString(), received_at: b.received_at, rebuttal_due_on: dueOn, rebuttal_status: "pending", rebuttal_document_id: null, allocation, paid_at: null }, this.actor, this.now());
    const event = this.emit("comp_fee_bill.received", loanId, { bill_id: billId, case_id: t ? t.data.case_id : null, period: b.period, fnma_reference: b.fnma_reference ?? null, days_billed: days, amount_cents: amount.toString(), recomputed_cents: expected.toString(), variance_cents: variance.toString(), received_on: receivedOn, receipt: receivedOn, rebuttal_due_on: dueOn, allocation }, { kind: "comp_fee_bill", id: billId });
    const pkg = this.d.store.put("document_bundles", `bundle-${billId}`, { loan_id: loanId, bill_id: billId, purpose: "comp_fee_rebuttal", status: "drafted", document_ids: ["timeline", "status_code_history_with_acknowledgments", "delay_credit_evidence", ...(t ? [`fc_timeframe_tracking:${String(t.data.case_id)}`] : [])], drafted_at: this.now(), variance_cents: variance.toString(), exposure_variance_cents: exposureVariance === null ? null : exposureVariance.toString() }, this.actor, this.now());
    this.escalate("officer", loanId, "sev2", { bill_id: billId, amount_cents: amount.toString(), recomputed_cents: expected.toString(), variance_cents: variance.toString(), tracked_exposure_cents: tracked === null ? null : tracked.toString(), rebuttal_due_on: dueOn, package_id: pkg.id, decision: "officer-signed rebuttal or bill acceptance by the rebuttal date (A1-4.2-02; SM_COMP_FEE_BILL_REBUTTAL_30)" });
    return { bill, package: pkg, rebuttal_due_on: dueOn, variance_cents: variance, exposure_variance_cents: exposureVariance, event };
  }
  /** A Connect pull of the bill file: every row ingested, refusals collected per row (a bad row never blocks the others). */
  ingestCompFeeBills(rows: readonly unknown[]): { received: string[]; refused: { row: number; reason: string }[] } {
    if (!rows.length) throw new RangeError("empty compensatory-fee bill file");
    const received: string[] = []; const refused: { row: number; reason: string }[] = [];
    rows.forEach((r, n) => { try { received.push(this.ingestCompFeeBill(r as CompFeeBillRecord).bill.id); } catch (e) { refused.push({ row: n, reason: (e as Error).message }); } });
    return { received, refused };
  }
  /** The officer accepts the bill (allocation per root cause): `comp_fee_bill.resolved{result=accepted}` closes the rebuttal clock; the rebuttal path is `documents.bundle{submit=true}` (section13.ts), which appends `comp_fee_bill.resolved{result=rebutted}`. */
  acceptBill(i: { bill_id: string; by: Actor; allocation?: "supermortgage" | "partner" | "shared" | null }): { bill: TrackerRecord; event: DomainEvent } {
    if (i.by.role !== "officer") throw new RangeError("bill acceptance is an officer decision (13.5 escalations: officer — bill acceptance/rebuttal; allocation disputes)");
    const rec = this.d.store.get(BILLS, nonEmpty(i.bill_id, "bill_id")); if (!rec) throw new RangeError(`no comp_fee_bills ${i.bill_id}`); if (rec.data.rebuttal_status !== "pending") throw new RangeError(`comp_fee_bills ${i.bill_id} is already ${String(rec.data.rebuttal_status)}`);
    const bill = this.d.store.put(BILLS, rec.id, { rebuttal_status: "accepted", accepted_at: this.now(), accepted_by: `${i.by.kind}:${i.by.id}`, allocation: i.allocation ?? rec.data.allocation }, i.by, this.now());
    const event = this.d.events.append({ type: "comp_fee_bill.resolved", loanId: String(rec.data.loan_id), aggregate: { kind: "comp_fee_bill", id: rec.id }, actor: i.by, occurredAt: this.now(), payload: { result: "accepted", bill_id: rec.id, amount_cents: rec.data.amount_cents, allocation: bill.data.allocation, ledger: "comp_fee_expense ↔ fnma_payable (on bill; 13.5 Outputs)" } });
    return { bill, event };
  }

  /** Breach actions of the 13.5 timer table, driven by the TimerEngine's `timer.breached` for a loan. */
  onBreach(b: { code: string; loanId?: string | null; at?: string | null; payload?: Row }): DomainEvent[] {
    const asOf = b.at ? isoDate(b.at, "at") : this.today(); const loanId = b.loanId ?? null;
    switch (b.code) {
      case "FNMA_E3215_TIMEFRAME_WARNING_70": return loanId ? this.review(loanId, asOf).events : [];
      case "FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE": { if (!loanId) return []; const t = this.tracking(loanId); if (!t || String(t.data.status).startsWith("closed")) return []; return this.exceeded(loanId, asOf); }
      case "FNMA_F121_STATUS_CODE_TIMELY_BD2": {
        if (!loanId) return []; const period = String(b.payload?.period ?? periodOf(addDays(asOf, -2))); const t = this.tracking(loanId); if (!t) return []; const cid = String(t.data.case_id); const out: DomainEvent[] = [];
        for (const c of this.d.store.list(CREDITS, (d) => d.case_id === cid && d.reported_timely !== true)) { const from = isoDate(c.data.begin_on, "begin_on"); const to = optDate(c.data.end_on) ?? asOf; if (!(periodOf(from) <= period && period <= periodOf(to))) continue;
          this.d.store.put(CREDITS, c.id, { reported_timely: false }, this.actor, this.now()); out.push(this.emit("fc.delay_credit.at_risk", loanId, { credit_id: c.id, case_id: cid, period, reported_timely: false, reason: "status code not accepted by BD2 (F-1-21); file a correction next period (CD10/CD11)" })); }
        return out;
      }
      default: return [];
    }
  }
}
