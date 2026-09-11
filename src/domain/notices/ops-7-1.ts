/**
 * §7.1 operating pipeline — the deterministic "Statement cycle run" the spec's AI-off path and the `disclosures`
 * agent both execute (7.1 "AI agent design": snapshot → variant → render/checklist → hold or channel → send → decision
 * record). spec/registry/agents.json names no bus tools for 7.1, so this service is the code path that appends every
 * event the 7.1 timer rows arm on or close with:
 *   - `statement.cycle.opened` (cycle scheduler, rule 1) → arms REGZ_1026_41B_STATEMENT_PROMPT_4 / SM_STATEMENT_GENERATE_T1;
 *   - `statement.rendered` | `statement.held` (render + checklist gate, T11);
 *   - `statement.sent` (+ `mailed_at` from the vendor manifest, or the e-delivery send) and the resolution event
 *     `statement.cycle.closed{outcome=sent}`; `statement.cycle.exempt` + `statement.cycle.closed{outcome=exempt}` only
 *     after the evidence guardrail ((e)(5)/(e)(6)/(g), T6);
 *   - `loan.charged_off{charged_off_on}` (charge-off approval ingestion) and the (e)(6) suspension notice (T7);
 *   - `delinquency.crossed_45{statement_due_by, coupon_book}` at the snapshot and the coupon-book (d)(8) notice;
 *   - `payment.reminder.sent{via∈{statement_panel, standalone_notice}}` (D2-2-03, T8) with cancellation of
 *     FNMA_D2_2_03_PAYMENT_REMINDER_20 on a full `payment.applied` / `forbearance.active`;
 *   - 7.1-A: `tax_year.closed` → `tax_form.1098.furnished{channel, tax_year_end}` → `tax_form.1098.filed{irs_accepted}`
 *     → `tax_form.1098.access_verified{available}` (T13);
 *   - `notice.returned` (NoticeService) → `address.research.completed` — statements continue meanwhile (guardrail).
 * Money is bigint cents in results; event payloads carry cents as decimal strings (JSON-safe, like 2.x).
 */
import { type PlainDate, addMonths, daysBetween } from "../../kernel/calendar/date.ts";
import { toIso } from "../../kernel/calendar/zoned.ts";
import type { EventStore, DomainEvent, Clock } from "../../kernel/events/index.ts";
import type { TimerEngine } from "../../kernel/timers/engine.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { DISCLOSURES_AGENT, type NoticeService, type Notice } from "../../notices/service.ts";
import type { Recipient, ChannelContext } from "../../notices/channel.ts";
import { cycle, delinquencyBox, chargeOffNoticeDue, form1098 } from "./statement.ts";
import { statementSuppressionRequest, chargeOffSuspension } from "./ops.ts";

export const STATEMENT_TEMPLATES = ["NTC_REGZ_41_STMT_STD", "NTC_REGZ_41_STMT_DELQ", "NTC_REGZ_41_STMT_TPP", "NTC_REGZ_41_STMT_BK7_11", "NTC_REGZ_41_STMT_BK12_13"] as const;
export type StatementTemplate = (typeof STATEMENT_TEMPLATES)[number];
/** `statement_cycles.variant` (7.1 data model). */
export type StatementVariant = "standard" | "delinquent" | "tpp" | "accelerated" | "bk_ch7_11" | "bk_ch12_13" | "coupon_book" | "exempt_bk" | "exempt_charged_off" | "suppressed_transfer";
export type ExemptReason = Parameters<typeof statementSuppressionRequest>[0]["reason"];
export const PAYMENT_REMINDER_TIMER = "FNMA_D2_2_03_PAYMENT_REMINDER_20";
const OPS_ALERT_MINUTES = 5;
const money = (c: Cents): string => c.toString();
const dayOfMonth = (d: PlainDate): number => Number(d.slice(8, 10));

export interface StatementCycleDeps {
  readonly events: EventStore;
  readonly clock: Clock;
  readonly notices: NoticeService;
  /** Needed only for the D2-2-03 cancellation rows (`paymentApplied` / `forbearanceActivated`). */
  readonly timers?: TimerEngine;
  /** `statements.coupon_books` (7.1 decision 1: default off). */
  readonly features?: { readonly coupon_books?: boolean };
}
export interface StatementCycleRow { readonly cycle_due_date: PlainDate; readonly courtesy_period_end: PlainDate; readonly statement_due_by: PlainDate; readonly vendor_file_by: PlainDate; readonly snapshot_at: string; readonly status: "scheduled"; readonly event_id: string; }
interface Pending { readonly loanId: string; readonly cycle: number; readonly cycle_due_date: PlainDate; readonly statement_date: PlainDate; readonly template: StatementTemplate; readonly variant: StatementVariant; readonly reminder_panel: boolean; readonly single_statement_exemption_used: boolean; }

export class StatementCycleService {
  private readonly d: StatementCycleDeps;
  private readonly pending = new Map<string, Pending>();
  constructor(deps: StatementCycleDeps) { this.d = deps; }
  private append(type: string, loanId: string, payload: Record<string, unknown>, causationId?: string): DomainEvent {
    return this.d.events.append({ type, loanId, actor: DISCLOSURES_AGENT, payload, ...(causationId ? { causationId } : {}) });
  }
  private of(noticeId: string): Pending { const p = this.pending.get(noticeId); if (!p) throw new RangeError(`no statement rendered as notice ${noticeId} (render first)`); return p; }
  /** Ordinal of the statement cycle on this loan: the caller's `cycle` (30.2 opens cycle 1 at boarding), else one past the statements already sent on the loan — `statement.sent{cycle=1}` is what 30.4's SM_FIRST_STATEMENT_RECONCILE_1BD triggers on. */
  private cycleOf(loanId: string, explicit: number | undefined): number {
    if (explicit !== undefined) { if (!Number.isInteger(explicit) || explicit < 1) throw new RangeError("cycle must be a positive integer"); return explicit; }
    return this.d.events.byLoan(loanId).filter((e) => e.type === "statement.sent").length + 1;
  }

  // ---------------------------------------------------------------- cycle: opened → rendered/held → sent | exempt
  /** Rule 1: the scheduler opens the next cycle the day after the previous cycle's courtesy period ends; the row carries `courtesy_period_end` (the anchor of both cycle timers), `statement_due_by` (+4, no business-day roll) and the vendor file date. */
  openCycle(loanId: string, f: { prior_due_date: PlainDate; late_charge_grace_days: number; loan_tz?: string }): StatementCycleRow {
    if (!loanId) throw new RangeError("loan_id is required");
    if (!Number.isInteger(f.late_charge_grace_days) || f.late_charge_grace_days < 0) throw new RangeError("late_charge_grace_days must be a non-negative integer (loan_terms, 2.7)");
    const c = cycle(f.prior_due_date, f.late_charge_grace_days, f.loan_tz);
    const row = { cycle_due_date: addMonths(f.prior_due_date, 1), courtesy_period_end: c.courtesy_period_end, statement_due_by: c.statement_due_by, vendor_file_by: c.vendor_file_by, snapshot_at: toIso(c.snapshot_at_ms), status: "scheduled" as const };
    const e = this.append("statement.cycle.opened", loanId, { ...row, prior_due_date: f.prior_due_date, late_charge_grace_days: f.late_charge_grace_days });
    return { ...row, event_id: e.id };
  }
  /** Render + checklist (guardrail: any `block` failure holds the statement; it cannot be sent and an ops alert fires within 5 minutes — T11). `statement.rendered` closes SM_STATEMENT_GENERATE_T1. */
  renderStatement(loanId: string, f: { cycle_due_date: PlainDate; statement_date: PlainDate; template: StatementTemplate; variant: StatementVariant; payload: Record<string, unknown>; recipients: readonly Recipient[]; reminder_panel: boolean; single_statement_exemption_used?: boolean; cycle?: number }): { notice: Notice; status: "rendered" | "held"; held_reason: string | null; ops_alert_by: string | null } {
    if (!STATEMENT_TEMPLATES.includes(f.template)) throw new RangeError(`${f.template} is not a periodic-statement template (${STATEMENT_TEMPLATES.join(", ")})`);
    const n = this.d.notices.render({ templateCode: f.template, loanId, recipients: f.recipients, payload: f.payload, asOf: f.statement_date });
    const base = { cycle: this.cycleOf(loanId, f.cycle), cycle_due_date: f.cycle_due_date, statement_date: f.statement_date, template: f.template, variant: f.variant, notice_id: n.id, reminder_panel: f.reminder_panel };
    this.pending.set(n.id, { loanId, ...base, single_statement_exemption_used: f.single_statement_exemption_used ?? false });
    if (n.status === "held") {
      const alertBy = new Date(Date.parse(n.producedAt) + OPS_ALERT_MINUTES * 60_000).toISOString();
      this.append("statement.held", loanId, { ...base, reason: n.heldReason ?? "held", blocking: n.checklist.blocking.map((b) => b.rule_id), ops_alert_by: alertBy });
      return { notice: n, status: "held", held_reason: n.heldReason ?? "held", ops_alert_by: alertBy };
    }
    this.append("statement.rendered", loanId, { ...base, template_version: n.templateVersion, payload_hash: n.payloadHash });
    return { notice: n, status: "rendered", held_reason: null, ops_alert_by: null };
  }
  /** decideChannel + send. Mail: `statement.sent` waits for the vendor manifest (`recordStatementMailed`, T1); e-delivery: the availability email / portal post is the send. Held statements are refused by NoticeService (NoticeHeld). */
  async sendStatement(noticeId: string, ctx: ChannelContext = {}): Promise<{ notice: Notice; sent: boolean; awaiting: "vendor_manifest" | null }> {
    const p = this.of(noticeId);
    const n = await this.d.notices.send(noticeId, ctx);
    if (n.status === "held") { this.append("statement.held", p.loanId, { cycle_due_date: p.cycle_due_date, notice_id: n.id, reason: n.heldReason ?? "held" }); return { notice: n, sent: false, awaiting: null }; }
    const live = (n.channelDecision ?? []).filter((c) => !c.held);
    if (live.some((c) => c.channel.startsWith("mail"))) return { notice: n, sent: false, awaiting: "vendor_manifest" };
    this.statementSent(p, n, { mailed_at: null, channel: "electronic", proof_of_mailing_id: null });
    return { notice: n, sent: true, awaiting: null };
  }
  /** Vendor manifest ingestion (proof of mailing): validates the manifest row, records `notice.mailed` and closes the cycle with `statement.sent{mailed_at}`. */
  recordStatementMailed(noticeId: string, f: { attempt_no: number; mailed_at: string; proof_of_mailing_id: string }): DomainEvent {
    const p = this.of(noticeId);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(f.mailed_at)) throw new RangeError("mailed_at must be the manifest's ISO instant");
    if (!f.proof_of_mailing_id) throw new RangeError("proof_of_mailing_id (manifest id) is required");
    this.d.notices.recordMailed(noticeId, f.attempt_no, f.mailed_at, f.proof_of_mailing_id);
    return this.statementSent(p, this.d.notices.get(noticeId), { mailed_at: f.mailed_at, channel: "mail", proof_of_mailing_id: f.proof_of_mailing_id });
  }
  private statementSent(p: Pending, n: Notice, via: { mailed_at: string | null; channel: "mail" | "electronic"; proof_of_mailing_id: string | null }): DomainEvent {
    this.pending.delete(n.id);
    // `cycle` (ordinal; 30.4's SM_FIRST_STATEMENT_RECONCILE_1BD triggers on cycle=1) and `sent_at` (its anchor: the manifest's mailing instant, else the e-delivery send).
    const sent = this.append("statement.sent", p.loanId, { cycle: p.cycle, cycle_due_date: p.cycle_due_date, statement_date: p.statement_date, variant: p.variant, template: p.template, notice_id: n.id, reminder_panel: p.reminder_panel, single_statement_exemption_used: p.single_statement_exemption_used, sent_at: via.mailed_at ?? n.sentAt ?? this.d.clock.now(), mailed_at: via.mailed_at, channel: via.channel, proof_of_mailing_id: via.proof_of_mailing_id });
    // REGZ_1026_41B_STATEMENT_PROMPT_4 closes on one resolution event for both "sent" and "exempt" (timers-7-1.ts).
    this.append("statement.cycle.closed", p.loanId, { cycle_due_date: p.cycle_due_date, outcome: "sent", notice_id: n.id, statement_date: p.statement_date, mailed_at: via.mailed_at }, sent.id);
    // D2-2-03 (rule 10): a statement carrying the reminder panel is the payment reminder; "dated ≤ 20th" is `on_time`.
    if (p.reminder_panel) this.append("payment.reminder.sent", p.loanId, { via: "statement_panel", sent_on: p.statement_date, on_time: dayOfMonth(p.statement_date) <= 20, notice_id: n.id }, sent.id);
    return sent;
  }
  /** (e)(5)/(e)(6)/(g) exemption for a cycle: refused for returned mail / FDCPA cease and without a linked evidence document (guardrail; T6); records `statement.cycle.exempt` and closes the cycle's prompt timer. */
  recordExempt(loanId: string, f: { cycle_due_date: PlainDate; reason: ExemptReason; evidence_document_id: string | null; effective_on: PlainDate; case_id?: string }): { exemption_basis: string; variant: StatementVariant | null; event_id: string } {
    const g = statementSuppressionRequest({ reason: f.reason, evidence_document_id: f.evidence_document_id });
    if (!g.allowed || !g.exemption_basis) throw new RangeError(g.refusal ?? "exemption refused");
    const variant: StatementVariant | null = f.reason === "bk_written_cease_request" ? "exempt_bk" : f.reason === "charged_off" ? "exempt_charged_off" : null;
    const e = this.append("statement.cycle.exempt", loanId, { cycle_due_date: f.cycle_due_date, reason: f.reason, exemption_basis: g.exemption_basis, evidence_document_id: f.evidence_document_id, effective_on: f.effective_on, variant, case_id: f.case_id ?? null });
    this.append("statement.cycle.closed", loanId, { cycle_due_date: f.cycle_due_date, outcome: "exempt", exemption_basis: g.exemption_basis, evidence_document_id: f.evidence_document_id, notice_id: null }, e.id);
    return { exemption_basis: g.exemption_basis, variant, event_id: e.id };
  }

  // ---------------------------------------------------------------- (e)(6) charge-off
  /** Charge-off approval ingestion (12.9/15.x decision): `loan.charged_off{charged_off_on}` arms REGZ_1026_41E6_CHARGEOFF_NOTICE_30; only with the approval document and the (e)(6)(i)(A) no-further-fees condition. */
  recordChargeOff(loanId: string, f: { charged_off_on: PlainDate; approval_document_id: string | null; no_further_fees_or_interest: boolean; balance_cents: Cents }): { notice_due_by: PlainDate; event_id: string } {
    if (!f.approval_document_id) throw new RangeError("a charge-off is recorded only with the approval document (7.1 guardrail: no exemption without linked evidence)");
    if (!f.no_further_fees_or_interest) throw new RangeError("§1026.41(e)(6)(i)(A): the exemption applies only when no further fees or interest will be charged");
    if (f.balance_cents < 0n) throw new RangeError("balance_cents must be ≥ 0");
    const due = chargeOffNoticeDue(f.charged_off_on);
    const e = this.append("loan.charged_off", loanId, { charged_off_on: f.charged_off_on, approval_document_id: f.approval_document_id, no_further_fees_or_interest: true, balance_cents: money(f.balance_cents), notice_due_by: due });
    return { notice_due_by: due, event_id: e.id };
  }
  /** `NTC_REGZ_41E6_CHARGEOFF_SUSPENSION` within 30 days (exact title, seven items — the template's own rules); `notice.sent{template=…}` closes the timer. */
  async sendChargeOffNotice(loanId: string, f: { charged_off_on: PlainDate; sent_on: PlainDate; recipients: readonly Recipient[]; payload: Record<string, unknown> }, ctx: ChannelContext = {}): Promise<Notice> {
    const n = this.d.notices.render({ templateCode: "NTC_REGZ_41E6_CHARGEOFF_SUSPENSION", loanId, recipients: f.recipients, payload: { ...f.payload, chargeoff_date: f.charged_off_on, days_after_chargeoff: daysBetween(f.charged_off_on, f.sent_on) }, asOf: f.sent_on });
    return this.d.notices.send(n.id, ctx);
  }
  /** (e)(6)(ii): a fee or interest charged after the notice lapses the exemption — statements resume, the fee is reversed (T7). */
  recordChargeOffFeeAssessed(loanId: string, f: { charged_off_on: PlainDate; fee_assessed_on: PlainDate; fee_cents: Cents }): ReturnType<typeof chargeOffSuspension> & { event_id: string } {
    const r = chargeOffSuspension({ approved_on: f.charged_off_on, fee_assessed_on: f.fee_assessed_on, fee_cents: f.fee_cents });
    const e = this.append("statement.exemption.lapsed", loanId, { basis: "§1026.41(e)(6)(ii)", fee_assessed_on: f.fee_assessed_on, fee_reversed_cents: money(r.fee_reversed_cents), statements_resume: r.statements_resume });
    return { ...r, event_id: e.id };
  }

  // ---------------------------------------------------------------- (d)(8) crossing and the coupon-book notice
  /** Snapshot-time delinquency measure (rule 4): the cycle in which `regx_days` first exceeds 45 records `delinquency.crossed_45`; `coupon_book` is true only for a coupon-book borrower with the feature on (REGZ_1026_41E3IV_COUPON_DELQ_NOTICE). */
  recordDelinquencyCrossing(loanId: string, f: { statement_date: PlainDate; earliest_unpaid_due: PlainDate | null; prior_regx_days: number; statement_due_by: PlainDate; coupon_book?: boolean }): ReturnType<typeof delinquencyBox> & { crossed: boolean; coupon_book: boolean; event_id: string | null } {
    if (f.prior_regx_days < 0) throw new RangeError("prior_regx_days must be ≥ 0");
    const box = delinquencyBox(f.statement_date, f.earliest_unpaid_due);
    const crossed = box.regx_days > 45 && f.prior_regx_days <= 45;
    const coupon = f.coupon_book === true && this.d.features?.coupon_books === true;
    const e = crossed ? this.append("delinquency.crossed_45", loanId, { statement_date: f.statement_date, first_unpaid_due: box.first_unpaid_due, began_on: box.began_on, regx_days: box.regx_days, statement_due_by: f.statement_due_by, coupon_book: coupon }) : null;
    return { ...box, crossed, coupon_book: coupon, event_id: e?.id ?? null };
  }
  /** §1026.41(e)(3)(iv): the written (d)(8) information for a coupon-book borrower more than 45 days delinquent — feature off by default, fixed-rate loans only. */
  async sendCouponDelinquencyNotice(loanId: string, f: { statement_date: PlainDate; arm_loan: boolean; recipients: readonly Recipient[]; payload: Record<string, unknown> }, ctx: ChannelContext = {}): Promise<Notice> {
    if (this.d.features?.coupon_books !== true) throw new RangeError("feature statements.coupon_books is off (7.1 decision 1: default off — one statement engine)");
    if (f.arm_loan) throw new RangeError("coupon books are available for fixed-rate loans only (§1026.41(e)(3); 7.1 edge: ARM loans excluded)");
    const n = this.d.notices.render({ templateCode: "NTC_REGZ_41E3IV_COUPON_DELQ_NOTICE", loanId, recipients: f.recipients, payload: { ...f.payload, statement_date: f.statement_date }, asOf: f.statement_date });
    return this.d.notices.send(n.id, ctx);
  }

  // ---------------------------------------------------------------- D2-2-03 payment reminder
  /** Held statement (rule 10): the standalone `NTC_FNMA_D2_2_03_PAYMENT_REMINDER` by the 20th; the resolution event closes FNMA_D2_2_03_PAYMENT_REMINDER_20. */
  async sendStandaloneReminder(loanId: string, f: { sent_on: PlainDate; recipients: readonly Recipient[]; payload: Record<string, unknown> }, ctx: ChannelContext = {}): Promise<Notice> {
    const day = dayOfMonth(f.sent_on);
    const n = this.d.notices.render({ templateCode: "NTC_FNMA_D2_2_03_PAYMENT_REMINDER", loanId, recipients: f.recipients, payload: { ...f.payload, day_of_month_sent: day }, asOf: f.sent_on });
    const sent = await this.d.notices.send(n.id, ctx);
    this.append("payment.reminder.sent", loanId, { via: "standalone_notice", sent_on: f.sent_on, on_time: day <= 20, notice_id: n.id });
    return sent;
  }
  /** Cancellation rows of FNMA_D2_2_03_PAYMENT_REMINDER_20: a full periodic payment applied for the month. */
  paymentApplied(loanId: string, f: { full_periodic_payment: boolean; due_date: PlainDate | null }): { cancelled: string[] } {
    if (!f.full_periodic_payment) return { cancelled: [] };
    return { cancelled: this.cancelReminder(loanId, `payment.applied: full periodic payment${f.due_date ? ` for ${f.due_date}` : ""}`) };
  }
  /** … or an active forbearance plan (D2-2-03 exclusion; 12.4). */
  forbearanceActivated(loanId: string, f: { plan_id: string | null }): { cancelled: string[] } { return { cancelled: this.cancelReminder(loanId, `forbearance.active${f.plan_id ? ` (${f.plan_id})` : ""}`) }; }
  private cancelReminder(loanId: string, reason: string): string[] {
    const t = this.d.timers; if (!t) throw new RangeError("the timer engine is not wired into this service (needed to cancel FNMA_D2_2_03_PAYMENT_REMINDER_20)");
    const open = t.byCode(PAYMENT_REMINDER_TIMER).filter((i) => i.loanId === loanId && (i.status === "armed" || i.status === "breached"));
    for (const i of open) t.cancel(i.id, reason, DISCLOSURES_AGENT);
    return open.map((i) => i.id);
  }
  /** Inbound wiring: `payment.applied{full_periodic_payment=true}` (2.2) and `forbearance.active` (12.4) cancel the open reminder timer. */
  subscribe(): () => void {
    const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
    const offs = [
      this.d.events.subscribe("payment.applied{full_periodic_payment=true}", (e) => { if (e.loanId) this.paymentApplied(e.loanId, { full_periodic_payment: true, due_date: typeof p(e).due_date === "string" ? (p(e).due_date as PlainDate) : null }); }),
      this.d.events.subscribe("forbearance.active", (e) => { if (e.loanId) this.forbearanceActivated(e.loanId, { plan_id: typeof p(e).plan_id === "string" ? (p(e).plan_id as string) : null }); }),
    ];
    return () => { for (const off of offs) off(); };
  }

  // ---------------------------------------------------------------- 7.1-A Form 1098
  /** Annual trigger (Jan 2, 00:05 ET): `tax_year.closed` per reportable loan arms IRS_6050H_1098_FURNISH_0131 (Jan 31) and IRS_6050H_1098_FILE_0331 (Mar 31). */
  closeTaxYear(f: { tax_year: number; reportable_loans: readonly string[] }): { tax_year_end: PlainDate; furnish_by: PlainDate; efile_by: PlainDate; loans: number } {
    if (!Number.isInteger(f.tax_year) || f.tax_year < 2000) throw new RangeError("tax_year must be a calendar year");
    if (f.reportable_loans.length === 0) throw new RangeError("tax_year.closed needs the reportable loans (every loan with interest received in the year)");
    const y = f.tax_year + 1;
    const row = { tax_year_end: `${f.tax_year}-12-31` as PlainDate, furnish_by: `${y}-01-31` as PlainDate, efile_by: `${y}-03-31` as PlainDate };
    for (const loanId of f.reportable_loans) this.append("tax_year.closed", loanId, { tax_year: f.tax_year, ...row });
    return { ...row, loans: f.reportable_loans.length };
  }
  /** Rule 11: boxes 1–2 from the ledger, the form through the Notice Registry (`NTC_IRS_1098`, class `irs_estatement`); `tax_form.1098.furnished{channel, tax_year_end}` closes the furnish timer and, when electronic, arms the Oct 15 access gate. */
  async furnish1098(loanId: string, f: { tax_year: number; interest_received_cents: Cents; points_cents?: Cents; gov_assistance_interest_cents?: Cents; upb_jan1_cents: Cents; furnished_on: PlainDate; recipients: readonly Recipient[]; payload: Record<string, unknown> }, ctx: ChannelContext = {}): Promise<{ notice: Notice; channel: "electronic" | "paper"; box1_cents: Cents; box2_cents: Cents; furnished_on: PlainDate; furnish_by: PlainDate; on_time: boolean; efile_by: PlainDate; accessible_through: PlainDate | null; file_with_irs: boolean; event: DomainEvent }> {
    if (f.interest_received_cents < 0n || f.upb_jan1_cents < 0n) throw new RangeError("interest and UPB must be ≥ 0");
    const b = form1098(f.interest_received_cents, f.points_cents ?? 0n, f.gov_assistance_interest_cents ?? 0n, f.upb_jan1_cents);
    const y = f.tax_year + 1;
    const furnishBy = `${y}-01-31` as PlainDate, efileBy = `${y}-03-31` as PlainDate;
    const fileWithIrs = b.box1_cents >= 60_000n;   // decision 5: furnish to every payer, file only ≥ $600
    const n = this.d.notices.render({ templateCode: "NTC_IRS_1098", loanId, recipients: f.recipients, payload: { ...f.payload, tax_year: f.tax_year, box1_cents: b.box1_cents, box1_cents_number: Number(b.box1_cents), box2_cents: b.box2_cents, box2_as_of: `${f.tax_year}-01-01`, furnish_by: furnishBy, filed_with_irs: fileWithIrs }, asOf: f.furnished_on });
    const sent = await this.d.notices.send(n.id, ctx);
    const channel: "electronic" | "paper" = (sent.channelDecision ?? []).some((c) => !c.held && !c.channel.startsWith("mail")) ? "electronic" : "paper";
    const accessibleThrough = channel === "electronic" ? (`${y}-10-15` as PlainDate) : null;   // Treas. Reg. §1.6050H-2: through Oct 15 of the year following the tax year
    const event = this.append("tax_form.1098.furnished", loanId, { tax_year: f.tax_year, tax_year_end: `${f.tax_year}-12-31`, channel, furnished_on: f.furnished_on, notice_id: n.id, box1_cents: money(b.box1_cents), box2_cents: money(b.box2_cents), file_with_irs: fileWithIrs, accessible_through: accessibleThrough });
    return { notice: sent, channel, box1_cents: b.box1_cents, box2_cents: b.box2_cents, furnished_on: f.furnished_on, furnish_by: furnishBy, on_time: f.furnished_on <= furnishBy, efile_by: efileBy, accessible_through: accessibleThrough, file_with_irs: fileWithIrs, event };
  }
  /** IRIS/FIRE acceptance-file ingestion: `tax_form.1098.filed{irs_accepted}` — only an accepted transmittal (with its receipt id) closes IRS_6050H_1098_FILE_0331; a rejection is resubmitted as a correction. */
  record1098Filed(loanId: string, f: { tax_year: number; filed_at: string; irs_receipt_id: string | null; irs_accepted: boolean; rejection_reason?: string | null }): DomainEvent {
    if (f.irs_accepted && !f.irs_receipt_id) throw new RangeError("an IRS acceptance carries the receipt id from the IRIS/FIRE acceptance file");
    if (!/^\d{4}-\d{2}-\d{2}T/.test(f.filed_at)) throw new RangeError("filed_at must be an ISO instant");
    return this.append("tax_form.1098.filed", loanId, { tax_year: f.tax_year, filed_at: f.filed_at, irs_receipt_id: f.irs_receipt_id, irs_accepted: f.irs_accepted, rejection_reason: f.rejection_reason ?? null });
  }
  /** Daily portal availability check for an electronically furnished form (IRS_1098_EFURNISH_ACCESS_1015): `tax_form.1098.access_verified{available}`. */
  verify1098Access(loanId: string, f: { tax_year: number; checked_on: PlainDate; available: boolean; accessible_through: PlainDate }): DomainEvent {
    return this.append("tax_form.1098.access_verified", loanId, { tax_year: f.tax_year, checked_on: f.checked_on, available: f.available, within_window: f.checked_on <= f.accessible_through });
  }

  // ---------------------------------------------------------------- returned mail
  /** Returned mail (state `returned → address_research → re_sent`): the research outcome closes SM_STATEMENT_RETURNED_MAIL_5; statements keep going to the address of record meanwhile (guardrail), and a verified move is routed to 4.x as `address.change.detected`. */
  completeAddressResearch(loanId: string, f: { notice_id: string; completed_on: PlainDate; outcome: "address_confirmed" | "new_address_verified" | "unresolved_continue_to_address_of_record"; new_address?: string | null; ncoa_reference?: string | null }): { event: DomainEvent; statements_suppressed: false; refusal: string } {
    if (!f.notice_id) throw new RangeError("notice_id of the returned piece is required");
    if (f.outcome === "new_address_verified" && !f.new_address) throw new RangeError("a verified move needs the new address");
    const event = this.append("address.research.completed", loanId, { notice_id: f.notice_id, completed_on: f.completed_on, outcome: f.outcome, new_address: f.new_address ?? null, ncoa_reference: f.ncoa_reference ?? null, statements_continue: true });
    if (f.outcome === "new_address_verified") this.append("address.change.detected", loanId, { source: "returned_mail_research", new_address: f.new_address, routed_to: "4.x verification" }, event.id);
    return { event, statements_suppressed: false, refusal: statementSuppressionRequest({ reason: "returned_mail", evidence_document_id: f.notice_id }).refusal ?? "" };
  }
}
