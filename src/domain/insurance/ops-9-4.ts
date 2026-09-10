/**
 * §9.4 Force-placed renewal notice — the renewal service over the pure calculators in fpi.ts. It owns the
 * `fpi_renewals` state machine (`charged` (9.2) → `renewal_scheduled` (A − 60) → `renewal_notice_sent` (t2) →
 * `renewal_chargeable` (t2 + 45, no compliant evidence) → `renewal_charged` (on/after A, never before t2 + 45) →
 * loops to `renewal_scheduled` for the next term; evidence at any point → 9.5; a post-expiration gap →
 * `prompt_gap_charge` where not prohibited) and is the one code path that appends the §1024.37(e) clock events the
 * registry arms and satisfies on:
 *
 *   `fpi.renewal.scheduled{origin, anniversary_on, next_notice_anniversary_on}`  ← fpi.charge.assessed (9.2) / the prior renewal charged
 *   `fpi.anniversary.approaching{days_before=60, anniversary_on}`                ← the A − 60 job (openRenewalWindow / sweep)
 *   `fpi.renewal.coverage_reviewed{coverage_cents, deductible_cents}`            ← reviewCoverage (B-2-01 over-insurance review)
 *   `fpi.renewal.quoted{quoted_premium_cents, premium_is_estimate}`              ← carrier `lpi_renewal_quote` inbound
 *   `fpi.renewal_notice.sent{renewal_notice_mailed_at, next_notice_anniversary_on}` ← proof of mailing of the MS-3(D) (notice.mailed{template=INS_FPI_RENEWAL_MS3D})
 *   `fpi.renewal.bound`                                                          ← carrier `lpi_renewal_bound` inbound (coverage renews on A regardless)
 *   `fpi.renewal.chargeable` / `fpi.renewal.charged{amount_cents, charged_on}`  ← assessRenewalCharge (closes the 45-day gate)
 *   `fpi.gap.evidenced{gap_days, lpi_prompt_charge_prohibited}`                  ← recordGapEvidence (evidence of a post-expiration gap)
 *   `fpi.renewal.gap_charge{action}`                                             ← decideGapCharge (prompt charge, or a new 9.2 cycle via insurance.lapse_detected)
 *   `fpi.renewal.closed{closed_reason}`                                          ← evidence (9.5), payoff / transfer / REO / charge-off
 *
 * Guardrails are code, not prompt (§9.4 agent design): one MS-3(D) per anniversary ((e)(5)); no renewal charge before
 * max(A, t2 + 45) ((e)(1)(i)); gap charges only where `jurisdiction_rules.lpi_prompt_charge_prohibited=false`
 * ((e)(1)(iii)); every cost figure traced to a renewal quote or the rate table; first-class mail only ((f)).
 * bigint cents; PlainDate on the anniversary and mailing-date anchors; nothing here mutates an event.
 */
import { type PlainDate, addDays, addYears, daysBetween, plainDate as D } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { TimerEngine } from "../../kernel/timers/engine.ts";
import type { Ledger, EntrySet } from "../../kernel/ledger/ledger.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { lpiCoverage, premiumQuote, renewalClocks, renewalChargeAllowed, renewalNoticeAllowed, gapChargeDecision, productionWindowOk, type PremiumQuote, type RenewalClocks, type BasisKind } from "./fpi.ts";
import { dailyRate, type LpiTerm } from "./refund.ts";
import { INSURANCE_AGENT, type CoverageInput, type MailingRecord, type QuoteInput, type JurisdictionRule } from "./ops-9-2.ts";

export const MS3D = "INS_FPI_RENEWAL_MS3D";
/** The 9.4 clocks a closed renewal cancels (the evaluator-backed gap flag and the recurring annual row have no natural end). */
export const FPI_94_TIMERS: readonly string[] = ["REGX_1024_37E5_FPI_RENEWAL_NOTICE_ANNUAL", "REGX_1024_37E_FPI_RENEWAL_NOTICE_45", "REGX_1024_37E1III_GAP_PROMPT_CHARGE", "INS_FPI_RENEWAL_COVERAGE_REVIEW_60"];
/** Coverage-review trigger: the carrier renewal-quote feed and the B-2-01 review run at A − 60 (9.4 inputs). */
export const RENEWAL_WINDOW_DAYS = 60;

export type RenewalStatus = "scheduled" | "notice_sent" | "chargeable" | "charged" | "closed_evidence" | "closed_other";
export type RenewalOrigin = "fpi_charge" | "prior_renewal";
export type GapAction = "prompt_charge" | "new_cycle";
/** `fpi_renewals` row (+ the review/quote columns the notice and the charge trace to). */
export interface FpiRenewal {
  readonly id: string; readonly fpi_case_id: string; readonly loan_id: string; readonly placement_id: string; readonly renewal_cycle: number; readonly origin: RenewalOrigin;
  readonly anniversary_date: PlainDate; readonly notice_target: PlainDate; readonly review_on: PlainDate;
  readonly prior_term: LpiTerm; readonly prior_coverage_cents: Cents; readonly prior_deductible_cents: Cents;
  coverage_cents: Cents | null; deductible_cents: Cents | null; coverage_basis: string | null; reviewed_on: PlainDate | null;
  quoted_premium_cents: Cents | null; premium_is_estimate: boolean | null; estimate_basis: string | null;
  notice_id: string | null; notice_mailed_at: PlainDate | null; earliest_renewal_charge_date: PlainDate | null; charge_on: PlainDate | null;
  renewal_placement_id: string | null; renewal_term: LpiTerm | null; charged_on: PlainDate | null; charge_id: string | null;
  status: RenewalStatus; closed_reason: string | null;
}
/** `lpi_placements` row for a renewal term (linked `previous_placement_id`). */
export interface RenewalPlacement { readonly id: string; readonly fpi_case_id: string; readonly previous_placement_id: string; readonly coverage_amount_cents: Cents; readonly deductible_cents: Cents; readonly effective_date: PlainDate; readonly expiration_date: PlainDate; readonly premium_cents: Cents; readonly vendor_ref: string; readonly bound_at: string; status: "bound" | "charged"; }
export interface ScheduleRenewalInput {
  readonly case_id: string; readonly loan_id: string; readonly placement_id: string; readonly placement_effective: PlainDate; readonly placement_expiration?: PlainDate; readonly premium_cents: Cents;
  readonly coverage_cents: Cents; readonly deductible_cents: Cents; readonly state?: string | null; readonly escrowed?: boolean; readonly renewal_cycle?: number; readonly origin?: RenewalOrigin; readonly scheduled_on: PlainDate;
}
export interface RenewalBoundInbound { readonly renewal_id: string; readonly policy_number: string; readonly premium_cents: Cents; readonly effective: PlainDate; readonly expiration?: PlainDate; readonly vendor_ref?: string; readonly fees_cents?: Cents; readonly bound_at?: string; }
export interface GapEvidenceInput {
  readonly case_id: string; readonly gap_start: PlainDate; readonly gap_end: PlainDate; readonly evidence_id: string; readonly received_on: PlainDate;
  /** The lapse kind / basis a new 9.2 cycle would open on where the prompt charge is prohibited (rule 4). */
  readonly basis_kind?: BasisKind; readonly lapse_kind?: "expired" | "cancelled" | "nonrenewed";
  /** Explicit jurisdiction answer (overrides the `jurisdiction_rules` lookup). */
  readonly lpi_prompt_charge_prohibited?: boolean;
}
export interface GapDecision { readonly action: GapAction; readonly gap_days: number; readonly amount_cents: Cents | null; readonly daily_rate: Decimal; readonly prohibited: boolean; readonly event: DomainEvent; }
export interface Fpi94Deps {
  readonly events: EventStore; readonly clock: { now(): string };
  readonly timers?: TimerEngine; readonly ledger?: Ledger; readonly actor?: Actor;
  /** `jurisdiction_rules` lookup — `lpi_prompt_charge_prohibited` [UNVERIFIED] decides rule 4. */
  readonly jurisdiction?: (state: string) => JurisdictionRule | undefined;
}

const civilDate = (v: unknown): PlainDate | null => typeof v !== "string" ? null : /^\d{4}-\d{2}-\d{2}$/.test(v) ? D(v) : /^\d{4}-\d{2}-\d{2}T/.test(v) ? wallClock(Date.parse(v), "America/New_York").date : null;
const isClosed = (r: FpiRenewal): boolean => r.status.startsWith("closed_");
/** A cycle still running (a charged cycle is complete — the loop has scheduled the next). */
const isActive = (r: FpiRenewal): boolean => r.status === "scheduled" || r.status === "notice_sent" || r.status === "chargeable";
interface CaseFacts { readonly fpi_case_id: string; readonly loan_id: string; readonly state: string | null; readonly escrowed: boolean; last_renewal_term: LpiTerm | null; last_expiration: PlainDate; last_notice: { mailed: PlainDate; anniversary: PlainDate } | null; }

export class Fpi94Service {
  private readonly deps: Fpi94Deps;
  private readonly renewals = new Map<string, FpiRenewal>();
  private readonly placements = new Map<string, RenewalPlacement>();
  private readonly cases = new Map<string, CaseFacts>();
  constructor(deps: Fpi94Deps) { this.deps = deps; }

  get(renewalId: string): FpiRenewal { const r = this.renewals.get(renewalId); if (!r) throw new RangeError(`no fpi renewal ${renewalId}`); return r; }
  all(): readonly FpiRenewal[] { return [...this.renewals.values()]; }
  /** The open renewal on a case (at most one per case at a time — the loop schedules the next only when this one is charged). */
  openFor(caseId: string): FpiRenewal | undefined { return this.all().find((r) => r.fpi_case_id === caseId && isActive(r)); }
  openForLoan(loanId: string): FpiRenewal | undefined { return this.all().find((r) => r.loan_id === loanId && isActive(r)); }
  placement(id: string): RenewalPlacement { const p = this.placements.get(id); if (!p) throw new RangeError(`no renewal placement ${id}`); return p; }
  clocks(r: FpiRenewal): RenewalClocks { return renewalClocks(r.prior_term.effective, r.notice_mailed_at); }

  private emit(type: string, r: { loan_id: string; fpi_case_id: string }, payload: Record<string, unknown>, causationId?: string): DomainEvent {
    return this.deps.events.append({ type, loanId: r.loan_id, aggregate: { kind: "fpi_case", id: r.fpi_case_id }, actor: this.deps.actor ?? INSURANCE_AGENT, ...(causationId ? { causationId } : {}), payload: { case_id: r.fpi_case_id, loan_id: r.loan_id, ...payload } });
  }

  // ---- schedule (`charged` → `renewal_scheduled`; inputs: fpi.charge.assessed → A = effective + 1 year) ----------------
  /**
   * Schedule the renewal cycle for the term ending at anniversary A = `lpi_placements.effective_date + 1 year`: the
   * MS-3(D) targets A − 60 (window A − 60 … A − 45) and the B-2-01 coverage review runs at A − 60. `origin=fpi_charge`
   * (the 9.2 charge) arms the recurring annual row; a `prior_renewal` origin does not re-arm it — the row re-armed
   * itself for A + 1 year when the prior MS-3(D) was mailed (§1024.37(e)(5): before each anniversary, once a year).
   */
  scheduleRenewal(i: ScheduleRenewalInput, causationId?: string): FpiRenewal {
    if (this.openFor(i.case_id)) throw new RangeError(`case ${i.case_id} already has an open renewal cycle`);
    if (i.premium_cents <= 0n) throw new RangeError("the prior term premium must be positive");
    const cycle = i.renewal_cycle ?? 1, origin = i.origin ?? "fpi_charge";
    const clocks = renewalClocks(i.placement_effective, null);
    const prior_term: LpiTerm = { effective: i.placement_effective, expiration: i.placement_expiration ?? clocks.anniversary, premium_cents: i.premium_cents };
    const r: FpiRenewal = {
      id: `fpr-${i.case_id}-${cycle}`, fpi_case_id: i.case_id, loan_id: i.loan_id, placement_id: i.placement_id, renewal_cycle: cycle, origin, anniversary_date: clocks.anniversary, notice_target: clocks.notice_target, review_on: addDays(clocks.anniversary, -RENEWAL_WINDOW_DAYS),
      prior_term, prior_coverage_cents: i.coverage_cents, prior_deductible_cents: i.deductible_cents,
      coverage_cents: null, deductible_cents: null, coverage_basis: null, reviewed_on: null, quoted_premium_cents: null, premium_is_estimate: null, estimate_basis: null,
      notice_id: null, notice_mailed_at: null, earliest_renewal_charge_date: null, charge_on: null, renewal_placement_id: null, renewal_term: null, charged_on: null, charge_id: null, status: "scheduled", closed_reason: null,
    };
    this.renewals.set(r.id, r);
    const facts = this.cases.get(i.case_id) ?? { fpi_case_id: i.case_id, loan_id: i.loan_id, state: i.state ?? null, escrowed: i.escrowed ?? false, last_renewal_term: null, last_expiration: prior_term.expiration, last_notice: null };
    facts.last_expiration = prior_term.expiration;
    this.cases.set(i.case_id, facts);
    // `next_notice_anniversary_on` = the anniversary the pending MS-3(D) precedes: A here; A + 1 year on `fpi.renewal_notice.sent` (the recurring row's re-arm anchor).
    this.emit("fpi.renewal.scheduled", r, { renewal_id: r.id, origin, renewal_cycle: cycle, placement_id: i.placement_id, anniversary_on: clocks.anniversary, next_notice_anniversary_on: clocks.anniversary, notice_target: clocks.notice_target, notice_mail_by: addDays(clocks.anniversary, -45), review_on: r.review_on, scheduled_on: i.scheduled_on, prior_premium_cents: i.premium_cents, prior_coverage_cents: i.coverage_cents, status: r.status }, causationId);
    return r;
  }

  /** The A − 60 job: `fpi.anniversary.approaching{days_before=60}` arms the B-2-01 coverage review (`INS_FPI_RENEWAL_COVERAGE_REVIEW_60`) and calls the carrier renewal-quote feed. Refused before A − 60. */
  openRenewalWindow(renewalId: string, on: PlainDate): DomainEvent {
    const r = this.get(renewalId);
    if (isClosed(r)) throw new RangeError(`renewal ${renewalId} is ${r.status}`);
    if (on < r.review_on) throw new RangeError(`renewal window opens ${r.review_on} (A − ${RENEWAL_WINDOW_DAYS}); ${on} is too early`);
    return this.emit("fpi.anniversary.approaching", r, { renewal_id: r.id, days_before: RENEWAL_WINDOW_DAYS, anniversary_on: r.anniversary_date, review_on: r.review_on, notice_target: r.notice_target, opened_on: on, quote_feed: "insurance-tracking/lpi lpi_renewal_quote" });
  }
  /** The daily renewal job (AI-off: deterministic): every scheduled renewal whose A − 60 has arrived and whose window is not yet open. */
  sweep(on: PlainDate): DomainEvent[] {
    const opened = new Set(this.deps.events.ofType("fpi.anniversary.approaching").map((e) => String(e.payload.renewal_id)));
    return this.all().filter((r) => r.status === "scheduled" && on >= r.review_on && !opened.has(r.id)).map((r) => this.openRenewalWindow(r.id, on));
  }

  // ---- coverage review (rule 3; B-2-01; 9.4-T5) ----------------------------------------------------------------------
  /** Rule 3: re-run 9.2 rule 4 (RCV estimate, occupancy, state cap) at A − 60; a downward adjustment reduces the borrower's cost (B-2-01 over-insurance). The rationale is the decision record. */
  reviewCoverage(renewalId: string, cov: CoverageInput, on: PlainDate): { coverage_cents: Cents; deductible_cents: Cents; basis: string; adjustment: "down" | "up" | "none"; rationale: string; event: DomainEvent } {
    const r = this.get(renewalId);
    if (isClosed(r)) throw new RangeError(`renewal ${renewalId} is ${r.status}: no coverage review`);
    if (r.status !== "scheduled" && r.status !== "notice_sent") throw new RangeError(`renewal ${renewalId} is ${r.status}: the coverage review precedes the renewal request`);
    const facts = this.cases.get(r.fpi_case_id);
    const rule = facts?.state ? this.deps.jurisdiction?.(facts.state) : undefined;
    const capped = facts?.state === "CA" || rule?.hazard_amount_cap_rule === "rcv";
    const state_cap = capped ? (cov.state_cap_cents ?? cov.rcv_cents) : (cov.state_cap_cents ?? null);
    const c = lpiCoverage({ last_known_cents: cov.last_known_cents, rcv_cents: cov.rcv_cents, upb_cents: cov.upb_cents, state_cap_cents: state_cap, ...(cov.vacant !== undefined ? { vacant: cov.vacant } : {}) });
    const adjustment = c.coverage_cents < r.prior_coverage_cents ? "down" : c.coverage_cents > r.prior_coverage_cents ? "up" : "none";
    const rationale = `B-2-01 review at A − ${RENEWAL_WINDOW_DAYS}: RCV ${cov.rcv_cents}, UPB ${cov.upb_cents}, last known ${cov.last_known_cents ?? "none"}${state_cap !== null ? `, state cap ${state_cap}` : ""} → ${c.basis}: coverage ${c.coverage_cents} (${adjustment} from ${r.prior_coverage_cents}), deductible ${c.deductible_cents}`;
    r.coverage_cents = c.coverage_cents; r.deductible_cents = c.deductible_cents; r.coverage_basis = c.basis; r.reviewed_on = on;
    const event = this.emit("fpi.renewal.coverage_reviewed", r, { renewal_id: r.id, anniversary_on: r.anniversary_date, reviewed_on: on, coverage_cents: c.coverage_cents, deductible_cents: c.deductible_cents, basis: c.basis, previous_coverage_cents: r.prior_coverage_cents, previous_deductible_cents: r.prior_deductible_cents, adjustment, rcv_cents: cov.rcv_cents, upb_cents: cov.upb_cents, state_cap_cents: state_cap, rationale });
    return { ...c, adjustment, rationale, event };
  }

  /** Carrier `lpi_renewal_quote` (A − 60) → the premium figure on the notice (rule 5: quote, else the rate-table estimate on the reviewed coverage). */
  recordRenewalQuote(renewalId: string, q: QuoteInput, on: PlainDate): PremiumQuote {
    const r = this.get(renewalId);
    if (isClosed(r)) throw new RangeError(`renewal ${renewalId} is ${r.status}: no quote`);
    if (r.coverage_cents === null) throw new RangeError("the renewal quote follows the B-2-01 coverage review (rule 3: the request reflects the reviewed amount)");
    if (q.carrier_quote_cents !== null && q.carrier_quote_cents <= 0n) throw new RangeError("lpi_renewal_quote premium must be positive");
    const quote = premiumQuote(q.carrier_quote_cents, r.coverage_cents, q.table_rate_pct);
    r.quoted_premium_cents = quote.annual_premium_cents; r.premium_is_estimate = quote.is_estimate; r.estimate_basis = quote.is_estimate ? `${quote.basis} ${q.rate_table_version ?? "current"}` : quote.basis;
    // The renewal daily rate (rule 4 gap charges, 9.5 refunds) is the quoted term until the carrier binds it.
    const facts = this.cases.get(r.fpi_case_id)!; facts.last_renewal_term = { effective: r.anniversary_date, expiration: addYears(r.anniversary_date, 1), premium_cents: quote.annual_premium_cents };
    this.emit("fpi.renewal.quoted", r, { renewal_id: r.id, anniversary_on: r.anniversary_date, quoted_on: on, coverage_cents: r.coverage_cents, quoted_premium_cents: quote.annual_premium_cents, premium_is_estimate: quote.is_estimate, estimate_basis: r.estimate_basis });
    return quote;
  }

  // ---- notice (rules 1, 2, 5; (e)(2)/(e)(5); 9.4-T1/T3) ---------------------------------------------------------------
  /** Whether an MS-3(D) may go for this renewal's anniversary on `on` — (e)(5): one per anniversary, never twice within 365 days for the same anniversary. */
  noticeAllowed(renewalId: string, on: PlainDate): { allowed: boolean; reason: string | null } {
    const r = this.get(renewalId);
    if (isClosed(r)) return { allowed: false, reason: r.status };
    if (r.notice_mailed_at) return { allowed: false, reason: `REGX_1024_37E5_FPI_RENEWAL_NOTICE_ANNUAL: an MS-3(D) for the ${r.anniversary_date} anniversary was mailed ${r.notice_mailed_at} — one notice per year (§1024.37(e)(5))` };
    const last = this.cases.get(r.fpi_case_id)?.last_notice ?? null;
    if (!renewalNoticeAllowed(last, r.anniversary_date, on)) return { allowed: false, reason: `REGX_1024_37E5_FPI_RENEWAL_NOTICE_ANNUAL: an MS-3(D) for the ${r.anniversary_date} anniversary was mailed ${last!.mailed}, ${daysBetween(last!.mailed, on)} days ago — one notice per year (§1024.37(e)(5))` };
    return { allowed: true, reason: null };
  }
  /** (e)(2) content assembly for the MS-3(D): refused twice for one anniversary ((e)(5)) or without a renewal quote (rule 5: the cost as an annual premium or an identified estimate). */
  composeRenewalNotice(renewalId: string, facts: { borrower_name: string; borrower_address: string; property_address: string; account_last4: string; notice_date: PlainDate; servicer_phone: string; servicer_address: string; insurance_email: string; additional_information?: boolean }): { template: typeof MS3D; payload: Record<string, unknown> } {
    const r = this.get(renewalId);
    const a = this.noticeAllowed(renewalId, facts.notice_date);
    if (!a.allowed) throw new RangeError(`MS-3(D) refused: ${a.reason}`);
    if (r.quoted_premium_cents === null) throw new RangeError("no MS-3(D) without the renewal quote — §1024.37(e)(2)(vii)(C): the cost stated as an annual premium (or an identified estimate — rule 5)");
    const last = this.cases.get(r.fpi_case_id)?.last_notice ?? null;
    const payload: Record<string, unknown> = { ...facts, notice_date: facts.notice_date, insurance_type: "hazard", placement_effective: r.prior_term.effective, anniversary: r.anniversary_date, expired: facts.notice_date >= r.prior_term.expiration,
      annual_premium_cents: r.quoted_premium_cents, premium_is_estimate: r.premium_is_estimate === true, estimate_basis_present: r.estimate_basis !== null, coverage_cents: r.coverage_cents,
      days_before_anniversary: daysBetween(facts.notice_date, r.anniversary_date), days_since_last_renewal_notice: last ? daysBetween(last.mailed, facts.notice_date) : 9999, additional_information: facts.additional_information ?? false, mail_class: "first_class", account_last4: facts.account_last4 };
    return { template: MS3D, payload };
  }
  /** Proof of mailing of the MS-3(D) → t2; the 45-day gate anchors here and the charge date becomes max(A, t2 + 45) (rule 2; 9.4-T1/T2). Refused for a second notice on the same anniversary (9.4-T3). */
  recordRenewalNoticeMailed(m: MailingRecord, causationId?: string): RenewalClocks {
    const r = this.openFor(m.case_id) ?? [...this.renewals.values()].find((x) => x.fpi_case_id === m.case_id && x.notice_id === m.notice_id);
    if (!r) throw new RangeError(`no open renewal cycle on case ${m.case_id}`);
    const a = this.noticeAllowed(r.id, m.mailed_at);
    if (!a.allowed) throw new RangeError(`MS-3(D) refused: ${a.reason}`);
    if (r.status !== "scheduled") throw new RangeError(`renewal ${r.id} is ${r.status}: the MS-3(D) is recorded once, from scheduled`);
    if (m.mail_class !== "first_class" && m.mail_class !== "certified") throw new RangeError(`renewal notice: §1024.37(f) requires a class of mail not less than first-class (got ${m.mail_class})`);
    if (!productionWindowOk(m.produced_at, m.mailed_at)) throw new RangeError(`REGX_1024_37D5_NOTICE_PRODUCTION_5BD: renewal notice produced ${m.produced_at} and mailed ${m.mailed_at} — more than 5 federal business days; regenerate with current evidence (comment 37(d)(5)-1)`);
    const clocks = renewalClocks(r.prior_term.effective, m.mailed_at);
    r.notice_id = m.notice_id; r.notice_mailed_at = m.mailed_at; r.earliest_renewal_charge_date = clocks.chargeable; r.charge_on = clocks.charge_on; r.status = "notice_sent";
    const facts = this.cases.get(r.fpi_case_id)!; facts.last_notice = { mailed: m.mailed_at, anniversary: r.anniversary_date };
    const slipped = m.mailed_at > addDays(r.anniversary_date, -45);
    // `next_notice_anniversary_on` re-arms the recurring annual row for the next anniversary ((e)(5): before each anniversary of the purchase).
    this.emit("fpi.renewal_notice.sent", r, { renewal_id: r.id, notice_id: m.notice_id, template: MS3D, renewal_notice_mailed_at: m.mailed_at, produced_at: m.produced_at, mail_class: m.mail_class, proof_of_mailing_id: m.proof_of_mailing_id,
      anniversary_on: r.anniversary_date, next_notice_anniversary_on: addYears(r.anniversary_date, 1), earliest_renewal_charge_date: clocks.chargeable, charge_on: clocks.charge_on, days_before_anniversary: daysBetween(m.mailed_at, r.anniversary_date), slipped, servicer_carries_days: slipped ? daysBetween(r.anniversary_date, clocks.charge_on!) : 0 }, causationId);
    return clocks;
  }

  // ---- binding (carrier `lpi_renewal_bound`: coverage renews on A regardless of the notice — rule 2) ---------------------
  recordRenewalBound(inbound: RenewalBoundInbound, causationId?: string): RenewalPlacement {
    const r = this.get(inbound.renewal_id);
    if (isClosed(r)) throw new RangeError(`renewal ${r.id} is ${r.status}: binding refused`);
    if (r.renewal_placement_id) throw new RangeError(`renewal ${r.id} is already bound (${r.renewal_placement_id})`);
    if (inbound.effective !== r.anniversary_date) throw new RangeError(`lpi_renewal_bound effective ${inbound.effective} ≠ anniversary ${r.anniversary_date} (coverage renews on A — 9.4 rule 2)`);
    if (inbound.premium_cents <= 0n) throw new RangeError("lpi_renewal_bound premium must be positive");
    if ((inbound.fees_cents ?? 0n) !== 0n) throw new RangeError("lpi_renewal_bound carries fees beyond the premium: B-6-01 no-commission rule; §1024.37(h) bona fide premium only");
    const bound_at = inbound.bound_at ?? this.deps.clock.now();
    const p: RenewalPlacement = { id: `lpi-${r.id}`, fpi_case_id: r.fpi_case_id, previous_placement_id: r.placement_id, coverage_amount_cents: r.coverage_cents ?? r.prior_coverage_cents, deductible_cents: r.deductible_cents ?? r.prior_deductible_cents,
      effective_date: inbound.effective, expiration_date: inbound.expiration ?? addYears(r.anniversary_date, 1), premium_cents: inbound.premium_cents, vendor_ref: inbound.policy_number, bound_at, status: "bound" };
    this.placements.set(p.id, p);
    r.renewal_placement_id = p.id; r.renewal_term = { effective: p.effective_date, expiration: p.expiration_date, premium_cents: p.premium_cents };
    const facts = this.cases.get(r.fpi_case_id)!; facts.last_renewal_term = r.renewal_term; facts.last_expiration = p.expiration_date;
    this.emit("fpi.renewal.bound", r, { renewal_id: r.id, placement_id: p.id, previous_placement_id: r.placement_id, policy_number: inbound.policy_number, effective: p.effective_date, expiration: p.expiration_date, coverage_cents: p.coverage_amount_cents, deductible_cents: p.deductible_cents, premium_cents: p.premium_cents, bound_at, charge_on: r.charge_on, chargeable: r.charge_on !== null && bound_at.slice(0, 10) >= r.charge_on }, causationId);
    return p;
  }

  // ---- charge (rule 2; (e)(1)(i); 9.4-T1/T2) ---------------------------------------------------------------------------
  /** Whether the renewal charge command is allowed on `on` — the gate `REGX_1024_37E_FPI_RENEWAL_NOTICE_45` and the agent guardrail share. */
  chargeAllowed(renewalId: string, on: PlainDate): { allowed: boolean; reason: string | null } {
    const r = this.get(renewalId);
    if (isClosed(r)) return { allowed: false, reason: r.status };
    if (r.status === "charged") return { allowed: false, reason: "already charged" };
    return renewalChargeAllowed(this.clocks(r), on);
  }
  /**
   * Assess the renewal charge: refused before max(A, t2 + 45) (`REGX_1024_37E_FPI_RENEWAL_NOTICE_45`), without a mailed
   * MS-3(D) (`RENEWAL_NOTICE_NOT_MAILED`) or without the bound renewal term; posts as 9.2 rule 7, emits
   * `fpi.renewal.charged` (closing the gate) and loops the cycle: the next term is scheduled with `origin=prior_renewal`.
   */
  assessRenewalCharge(renewalId: string, on: PlainDate): { renewal: FpiRenewal; amount_cents: Cents; daily_rate: Decimal; ledger: EntrySet | null; event: DomainEvent; next: FpiRenewal } {
    const r = this.get(renewalId);
    const d = this.chargeAllowed(renewalId, on);
    if (!d.allowed) throw new RangeError(`renewal charge command refused: ${d.reason}`);
    if (!r.renewal_placement_id || !r.renewal_term) throw new RangeError("the renewal charge waits for the bound renewal term (carrier lpi_renewal_bound)");
    const p = this.placement(r.renewal_placement_id);
    const rate = dailyRate(r.renewal_term);
    if (r.status === "notice_sent") { r.status = "chargeable"; this.emit("fpi.renewal.chargeable", r, { renewal_id: r.id, chargeable_on: on, earliest_renewal_charge_date: r.earliest_renewal_charge_date, charge_on: r.charge_on, anniversary_on: r.anniversary_date }); }
    const facts = this.cases.get(r.fpi_case_id)!;
    const now = this.deps.clock.now();
    let set: EntrySet | null = null;
    if (this.deps.ledger) {
      set = facts.escrowed
        ? this.deps.ledger.post({ effectiveDate: on, description: `LPI renewal premium disbursement (escrowed) ${p.id}`, lines: [{ account: { scope: "loan", loanId: r.loan_id, account: "escrow" }, amountCents: p.premium_cents, ruleRef: "9.4 outputs / 9.2 rule 7 / 3.7 lpi_premium" }, { account: { scope: "custodial", custodialAccountId: "C-TI", account: "custodial_ti_cash" }, amountCents: -p.premium_cents, ruleRef: "9.4 outputs / 9.2 rule 7 / 3.7 lpi_premium" }] }, now)
        : this.deps.ledger.post({ effectiveDate: on, description: `LPI renewal premium advanced ${p.id}`, lines: [{ account: { scope: "loan", loanId: r.loan_id, account: "corporate_advance" }, amountCents: p.premium_cents, ruleRef: "9.4 outputs / 9.2 rule 7" }, { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -p.premium_cents, ruleRef: "9.4 outputs / 9.2 rule 7" }] }, now);
    }
    r.status = "charged"; r.charged_on = on; r.charge_id = `lpc-${r.id}`; p.status = "charged";
    const event = this.emit("fpi.renewal.charged", r, { renewal_id: r.id, charge_id: r.charge_id, placement_id: p.id, amount_cents: p.premium_cents, charged_on: on, period_start: p.effective_date, period_end: addDays(p.expiration_date, -1), anniversary_on: r.anniversary_date,
      renewal_notice_mailed_at: r.notice_mailed_at, earliest_renewal_charge_date: r.earliest_renewal_charge_date, charge_on: r.charge_on, daily_rate_cents: rate.toFixed(6), ledger_set_id: set?.id ?? null, statement_line: "Lender-placed insurance renewal premium", rail: facts.escrowed ? "escrow_disbursement_3_7" : "corporate_advance_receivable" });
    if (facts.escrowed) this.emit("escrow.disbursement.requested", r, { disbursement_kind: "lpi_premium", amount_cents: p.premium_cents, placement_id: p.id, renewal_id: r.id, followed_by: "interim_escrow_analysis" });
    const next = this.scheduleRenewal({ case_id: r.fpi_case_id, loan_id: r.loan_id, placement_id: p.id, placement_effective: p.effective_date, placement_expiration: p.expiration_date, premium_cents: p.premium_cents, coverage_cents: p.coverage_amount_cents, deductible_cents: p.deductible_cents, state: facts.state, escrowed: facts.escrowed, renewal_cycle: r.renewal_cycle + 1, origin: "prior_renewal", scheduled_on: on }, event.id);
    return { renewal: r, amount_cents: p.premium_cents, daily_rate: rate, ledger: set, event, next };
  }

  // ---- post-expiration gap (rule 4; (e)(1)(iii); 9.4-T4) ---------------------------------------------------------------
  /**
   * Evidence that the borrower lacked coverage for a period after the prior LPI expired (comment 37(e)(1)(iii)-1) —
   * validated (a positive period on/after the expiration, a jurisdiction answer on file) and appended as
   * `fpi.gap.evidenced` with the `lpi_prompt_charge_prohibited` flag the policy row `REGX_1024_37E1III_GAP_PROMPT_CHARGE`
   * evaluates; `decideGapCharge` records the decision either way.
   */
  recordGapEvidence(i: GapEvidenceInput): { event: DomainEvent; gap_days: number; prohibited: boolean } {
    const facts = this.cases.get(i.case_id);
    if (!facts) throw new RangeError(`no renewal history on case ${i.case_id}`);
    const gap_days = daysBetween(i.gap_start, i.gap_end);
    if (gap_days <= 0) throw new RangeError(`gap ${i.gap_start} → ${i.gap_end} is not a positive period`);
    if (i.gap_start < facts.last_expiration) throw new RangeError(`gap starting ${i.gap_start} precedes the LPI expiration ${facts.last_expiration}: a period the LPI covered is a 9.5 overlap, not an (e)(1)(iii) gap`);
    const rule = facts.state ? this.deps.jurisdiction?.(facts.state) : undefined;
    const prohibited = i.lpi_prompt_charge_prohibited ?? rule?.lpi_prompt_charge_prohibited;
    if (prohibited === undefined) throw new RangeError(`jurisdiction_rules.lpi_prompt_charge_prohibited is not populated for ${facts.state ?? "an unknown state"} [UNVERIFIED] — attorney review before any prompt charge (§1024.37(e)(1)(iii) 'if not prohibited by State or other applicable law')`);
    const term = facts.last_renewal_term;
    const event = this.emit("fpi.gap.evidenced", facts, { evidence_id: i.evidence_id, received_on: i.received_on, gap_start: i.gap_start, gap_end: i.gap_end, gap_days, lpi_expiration: facts.last_expiration, state: facts.state, lpi_prompt_charge_prohibited: prohibited,
      renewal_daily_rate_cents: term ? dailyRate(term).toFixed(6) : null, basis_kind: i.basis_kind ?? "carrier_cancellation", lapse_kind: i.lapse_kind ?? "cancelled" });
    return { event, gap_days, prohibited };
  }
  /** Rule 4: prompt charge for the gap at the renewal daily rate where permitted (the flag row closes on the charge); otherwise a new 9.2 cycle opens (`insurance.lapse_detected`). The decision is recorded either way. */
  decideGapCharge(gapEventId: string, on: PlainDate): GapDecision {
    const g = this.deps.events.all().find((e) => e.id === gapEventId && e.type === "fpi.gap.evidenced");
    if (!g) throw new RangeError(`no fpi.gap.evidenced ${gapEventId}`);
    const f = g.payload as Record<string, unknown>;
    const facts = this.cases.get(String(f.case_id))!;
    if (!facts.last_renewal_term) throw new RangeError("the gap charge is priced at the renewal daily rate — no renewal term on the case (rule 4)");
    const rate = dailyRate(facts.last_renewal_term);
    const gap_days = Number(f.gap_days), prohibited = f.lpi_prompt_charge_prohibited === true;
    const d = gapChargeDecision(gap_days, rate, prohibited);
    const amount = d.action === "prompt_charge" ? d.cents : null;
    let set: EntrySet | null = null;
    if (amount !== null && this.deps.ledger)
      set = this.deps.ledger.post({ effectiveDate: on, description: `LPI post-expiration gap charge ${f.gap_start} → ${f.gap_end} (${gap_days} days)`, lines: [{ account: { scope: "loan", loanId: facts.loan_id, account: "corporate_advance" }, amountCents: amount, ruleRef: "9.4 rule 4 / §1024.37(e)(1)(iii)" }, { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -amount, ruleRef: "9.4 rule 4 / §1024.37(e)(1)(iii)" }] }, this.deps.clock.now());
    const decision = d.action === "prompt_charge"
      ? `§1024.37(e)(1)(iii) prompt charge: ${gap_days} days × ${rate.toFixed(6)} c/day = ${amount} cents; state ${facts.state ?? "?"} does not prohibit (jurisdiction_rules.lpi_prompt_charge_prohibited=false)`
      : `§1024.37(e)(1)(iii) prompt charge prohibited in ${facts.state ?? "?"} (jurisdiction_rules.lpi_prompt_charge_prohibited=true): a new 9.2 cycle opens with a fresh 45-day notice`;
    const event = this.emit("fpi.renewal.gap_charge", facts, { gap_event_id: g.id, evidence_id: f.evidence_id, action: d.action, gap_days, gap_start: f.gap_start, gap_end: f.gap_end, daily_rate_cents: rate.toFixed(6), amount_cents: amount, lpi_prompt_charge_prohibited: prohibited, decided_on: on, decision, ledger_set_id: set?.id ?? null }, g.id);
    if (d.action === "new_cycle")
      this.deps.events.append({ type: "insurance.lapse_detected", loanId: facts.loan_id, actor: this.deps.actor ?? INSURANCE_AGENT, causationId: event.id, payload: { loan_id: facts.loan_id, kind: String(f.lapse_kind ?? "cancelled"), insurance_type: "hazard", fdpa_required: false, escrowed: facts.escrowed, regx_days_delinquent: 0, cancellation_reason: "other",
        lapse_start: f.gap_start, detected_on: on, basis_kind: String(f.basis_kind ?? "carrier_cancellation"), basis_evidence_id: f.evidence_id, state: facts.state, source: "9.4 rule 4: prompt gap charge prohibited → new 9.2 cycle" } });
    if (this.deps.timers) for (const t of this.deps.timers.open()) if (t.loanId === facts.loan_id && t.code === "REGX_1024_37E1III_GAP_PROMPT_CHARGE" && t.armedByEventId === g.id) this.deps.timers.cancel(t.id, decision, this.deps.actor ?? INSURANCE_AGENT);
    return { action: d.action, gap_days, amount_cents: amount, daily_rate: rate, prohibited, event };
  }

  // ---- close (edge cases: evidence mid-term → 9.5 cancels the cycle; payoff / transfer / REO cancel the renewal) ---------
  closeRenewal(renewalId: string, reason: "closed_evidence" | "closed_other", why: string, causationId?: string): FpiRenewal {
    const r = this.get(renewalId);
    if (isClosed(r)) return r;
    r.status = reason; r.closed_reason = why;
    this.emit("fpi.renewal.closed", r, { renewal_id: r.id, closed_reason: reason, why, anniversary_on: r.anniversary_date, charged: r.charged_on !== null, status: r.status }, causationId);
    if (this.deps.timers) for (const t of this.deps.timers.open()) if (t.loanId === r.loan_id && FPI_94_TIMERS.includes(t.code)) this.deps.timers.cancel(t.id, `renewal ${r.id} ${reason}: ${why}`, this.deps.actor ?? INSURANCE_AGENT);
    return r;
  }
}

// ---- reactors: the inbound events that drive the renewal cycle -------------------------------------------------------
/**
 * Wire the service to the event log: `fpi.charge.assessed` (9.2) schedules the first renewal cycle from the bound
 * placement (`fpi.lpi_bound` on the same loan carries coverage, deductible and term); the print-mail proof of mailing
 * of an MS-3(D) records t2; `fpi.case.closed` (9.5 evidence, payoff, transfer, REO, charge-off) and the loan-level
 * terminations cancel the renewal. Returns the unsubscribe.
 */
export function fpiReactors_9_4(svc: Fpi94Service, events: EventStore): () => void {
  const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
  const guarded = (what: string, fn: (e: DomainEvent) => void) => (e: DomainEvent): void => {
    try { fn(e); } catch (err) { events.append({ type: "fpi.inbound.rejected", ...(e.loanId ? { loanId: e.loanId } : {}), ...(e.aggregate ? { aggregate: e.aggregate } : {}), actor: INSURANCE_AGENT, causationId: e.id, payload: { inbound: what, source_event: e.type, reason: (err as Error).message } }); }
  };
  const offs = [
    events.subscribe("fpi.charge.assessed", guarded("fpi_charge_assessed", (e) => {
      const f = p(e); const caseId = String(f.case_id ?? e.aggregate?.id ?? ""); const loanId = e.loanId ?? String(f.loan_id ?? "");
      if (!caseId || !loanId || svc.openFor(caseId)) return;
      const bound = events.all().filter((x) => x.type === "fpi.lpi_bound" && x.loanId === loanId && (x.payload as { placement_id?: unknown }).placement_id === f.placement_id).at(-1);
      const opened = events.all().find((x) => x.type === "fpi.case.opened" && x.loanId === loanId && (x.payload as { case_id?: unknown }).case_id === caseId);
      const b = (bound?.payload ?? {}) as Record<string, unknown>;
      const effective = civilDate(b.effective) ?? civilDate(f.period_start); if (!effective) throw new RangeError("fpi.charge.assessed without a placement effective date");
      svc.scheduleRenewal({ case_id: caseId, loan_id: loanId, placement_id: String(f.placement_id ?? ""), placement_effective: effective, ...(civilDate(b.expiration) ? { placement_expiration: civilDate(b.expiration)! } : {}), premium_cents: BigInt(String(b.premium_cents ?? f.amount_cents ?? 0)),
        coverage_cents: BigInt(String(b.coverage_cents ?? 0)), deductible_cents: BigInt(String(b.deductible_cents ?? 0)), state: typeof opened?.payload.state === "string" ? opened.payload.state : null, escrowed: f.rail === "escrow_disbursement_3_7", origin: "fpi_charge", scheduled_on: civilDate(f.assessed_on) ?? civilDate(e.occurredAt)! }, e.id);
    })),
    events.subscribe(`notice.mailed{template=${MS3D}}`, guarded("renewal_notice_proof_of_mailing", (e) => {
      const r = e.loanId ? svc.openForLoan(e.loanId) : undefined; if (!r) return;
      const noticeId = String(p(e).notice_id ?? e.aggregate?.id ?? "");
      const production = events.all().find((x) => x.type === "notice.production" && x.aggregate?.id === noticeId && (x.payload as { attempt_no?: unknown }).attempt_no === p(e).attempt_no);
      const mailed_at = civilDate(p(e).mailed_at) ?? civilDate(e.occurredAt)!;
      svc.recordRenewalNoticeMailed({ case_id: r.fpi_case_id, notice_id: noticeId, mailed_at, produced_at: civilDate(production?.payload.production_at) ?? mailed_at, mail_class: String(p(e).mail_class ?? "first_class"), proof_of_mailing_id: String(p(e).proof_of_mailing_id ?? "") }, e.id);
    })),
    events.subscribe("fpi.case.closed", guarded("fpi_case_closed", (e) => { const r = e.loanId ? svc.openForLoan(e.loanId) : undefined; if (r) svc.closeRenewal(r.id, p(e).closed_reason === "closed_evidence" ? "closed_evidence" : "closed_other", `fpi case ${String(p(e).closed_reason)}`, e.id); })),
    ...([["loan.paid_in_full", "paid off — LPI cancelled at payoff (9.5 refund logic)"], ["servicing.transfer_out.effective", "transferred"], ["reo.acquired", "REO"], ["loan.charged_off", "charged off"]] as const).map(([type, why]) =>
      events.subscribe(type, guarded(type, (e) => { const r = e.loanId ? svc.openForLoan(e.loanId) : undefined; if (r) svc.closeRenewal(r.id, "closed_other", why, e.id); }))),
  ];
  return () => { for (const off of offs) off(); };
}
