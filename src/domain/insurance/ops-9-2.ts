/**
 * §9.2 Force-placed insurance — first notice: the case service over the pure calculators in fpi.ts / ops.ts.
 * It owns the `fpi_cases` state machine (opened → k5_blocked | first_notice_pending → first_notice_sent →
 * reminder_sent → evidence_window → chargeable → lpi_bound → charged; closed_*) and is the one code path that
 * appends the §1024.37 clock events the registry arms and satisfies on:
 *
 *   `fpi.case.opened{escrowed, k5_blocked, track, opened_at}`   ← insurance.lapse_detected (9.1) / openCase
 *   `fpi.first_notice.sent{first_notice_mailed_at}`            ← print-mail proof of mailing (notice.mailed{template=INS_FPI_FIRST_MS3A})
 *   `fpi.reminder.sent{reminder_mailed_at}`                     ← proof of mailing of MS-3(B)/(C) (9.3)
 *   `fpi.evidence_window.evaluated{outcome}`                    ← evaluateEvidenceWindow at t1 + 15 (§1024.37(c)(1)(iii))
 *   `fpi.lpi_bound`                                             ← vendor `lpi_bound` inbound (recordLpiBound)
 *   `fpi.charge.assessed{amount_cents, period_start, period_end}` ← assessCharge (closes both not-before gates)
 *   `fpi.case.closed{closed_reason}`                            ← evidence in the window, k5 advance, payoff/transfer/REO/charge-off
 *
 * Guardrails are code, not prompt (§9.2 agent design): no notice without a recorded basis; no charge before
 * max(t0 + 45, t1 + 15); no placement before both notices (B-6-01) or on a (k)(5)-blocked escrowed loan; no
 * affiliate carrier and no fee on top of the bona fide premium; every cost figure traced to a quote/rate table;
 * first-class mail only ((f)); a notice produced > 5 federal business days before mailing is regenerated
 * (comment 37(d)(5)-1). bigint cents; PlainDate on the mailing-date anchors; nothing here mutates an event.
 */
import { type PlainDate, addDays, plainDate as D } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { TimerEngine } from "../../kernel/timers/engine.ts";
import type { Ledger, EntrySet } from "../../kernel/ledger/ledger.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { fpiClocks, reminderAllowed, chargeDecision, productionWindowOk, lpiCoverage, premiumQuote, reasonableBasis, type BasisKind, type InsuranceType, type FpiTrack, type FpiClocks, type PremiumQuote, type EscrowGuard } from "./fpi.ts";
import { lapseDetected, placementConfig, firstNoticeVariant } from "./ops.ts";
import { dailyRate } from "./refund.ts";
import type { Deficiency } from "./hazard.ts";

export const INSURANCE_AGENT: Actor = { kind: "agent", id: "insurance-property" };
export const MS3A = "INS_FPI_FIRST_MS3A";
export const REMINDER_TEMPLATES: Readonly<Record<"b_no_info" | "c_insufficient", string>> = { b_no_info: "INS_FPI_REMINDER_NOINFO_MS3B", c_insufficient: "INS_FPI_REMINDER_INSUFF_MS3C" };
/** The 9.2 clocks a closed case cancels (gates with no due date would otherwise stay armed for life). */
export const FPI_92_TIMERS: readonly string[] = ["INS_FPI_FIRST_NOTICE_SLA_3BD", "REGX_1024_37C_FPI_FIRST_NOTICE_45", "REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30", "REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15", "REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15", "REGX_1024_17K5_LPI_PURCHASE_GATE", "FNMA_B601_LPI_AFTER_ATTEMPTS"];

export type LapseKind = "expired" | "cancelled" | "nonrenewed" | "insufficient_coverage" | "perils_gap";
export type K5Gate = "n/a" | "blocked_advance" | "open_inability";
export type FpiCaseStatus = "opened" | "k5_blocked" | "first_notice_pending" | "flood_notice_pending" | "first_notice_sent" | "reminder_sent" | "evidence_window" | "chargeable" | "lpi_bound" | "charged"
  | "closed_evidence" | "closed_k5_advance" | "closed_servicer_pays" | "closed_paid_off" | "closed_transferred" | "closed_reo" | "closed_charged_off" | "closed_error";
export type ClosedReason = "closed_evidence" | "k5_advance" | "servicer_pays" | "paid_off" | "transferred" | "reo" | "charged_off" | "error";
export interface BasisRecord { readonly kind: BasisKind; readonly evidence_id: string; readonly deficiency?: Deficiency; readonly summary?: string; }
export interface EvidenceRecord { readonly received_on: PlainDate; readonly continuous_coverage: boolean; readonly evidence_id?: string; }
/** `fpi_cases` row (1:1 with `cases`, `case_type='fpi'`). */
export interface FpiCase {
  readonly case_id: string; readonly loan_id: string; readonly deficiency_id: string | null; readonly kind: LapseKind;
  readonly insurance_type: InsuranceType; readonly track: FpiTrack; readonly escrowed: boolean; readonly regx_days_delinquent: number; readonly guard: EscrowGuard; readonly k5_gate: K5Gate;
  readonly state: string | null; readonly opened_at: PlainDate; readonly lapse_start: PlainDate;
  basis: BasisRecord | null; basis_summary: string | null;
  first_notice_id: string | null; first_notice_mailed_at: PlainDate | null; reminder_notice_id: string | null; reminder_mailed_at: PlainDate | null; reminder_variant: "b_no_info" | "c_insufficient" | null;
  evidence_window_end: PlainDate | null; earliest_charge_date: PlainDate | null; evidence: EvidenceRecord | null;
  lpi_placement_id: string | null; placement_request_id: string | null; annual_premium_cents: Cents | null; premium_is_estimate: boolean | null; estimate_basis: string | null; renewal_cycle: number;
  status: FpiCaseStatus; closed_reason: ClosedReason | null;
}
/** `lpi_placements` row. */
export interface LpiPlacement {
  readonly id: string; readonly fpi_case_id: string; readonly carrier_party_id: string; readonly coverage_amount_cents: Cents; readonly coverage_method: string; readonly deductible_cents: Cents;
  readonly effective_date: PlainDate; readonly expiration_date: PlainDate; readonly premium_cents: Cents; readonly premium_is_estimate: boolean; readonly bound_at: string; readonly vendor_ref: string; status: "requested" | "bound" | "billed" | "charged";
}
/** `lpi_charges` row. */
export interface LpiCharge { readonly id: string; readonly fpi_case_id: string; readonly placement_id: string; readonly period_start: PlainDate; readonly period_end: PlainDate; readonly amount_cents: Cents; readonly assessed_at: string; readonly ledger_entry_id: string | null; readonly disbursement_id: string | null; borrower_paid_cents: Cents; }

export interface OpenCaseInput {
  readonly loan_id: string; readonly case_id?: string; readonly kind: LapseKind; readonly insurance_type: InsuranceType; readonly fdpa_required: boolean;
  readonly escrowed: boolean; readonly regx_days_delinquent: number; readonly cancellation_reason: "nonpayment" | "underwriting" | "other" | null; readonly vacant?: boolean;
  readonly lapse_start: PlainDate; readonly opened_on: PlainDate; readonly basis?: BasisRecord | null; readonly deficiency_id?: string | null; readonly state?: string | null;
}
export interface MailingRecord { readonly case_id: string; readonly notice_id: string; readonly mailed_at: PlainDate; readonly produced_at: PlainDate; readonly mail_class: "first_class" | "certified" | "standard" | string; readonly proof_of_mailing_id: string; }
export interface CoverageInput { readonly last_known_cents: Cents | null; readonly rcv_cents: Cents; readonly upb_cents: Cents; readonly state_cap_cents?: Cents | null; readonly vacant?: boolean; }
export interface VendorConfig { readonly vendor_id: string; readonly whitelist: readonly string[]; readonly affiliate: boolean; readonly fees: readonly { kind: string; cents: Cents }[]; readonly carrier_party_id?: string; }
export interface QuoteInput { readonly carrier_quote_cents: Cents | null; readonly table_rate_pct: string; readonly rate_table_version?: string; }
export interface PlacementRequest { readonly request_id: string; readonly case_id: string; readonly loan_id: string; readonly coverage_cents: Cents; readonly coverage_method: string; readonly deductible_cents: Cents; readonly effective: PlainDate; readonly expiration: PlainDate; readonly quote: PremiumQuote; readonly idempotency_key: string; }
export interface LpiBoundInbound { readonly request_id: string; readonly policy_number: string; readonly premium_cents: Cents; readonly effective: PlainDate; readonly expiration?: PlainDate; readonly vendor_ref?: string; readonly fees_cents?: Cents; readonly bound_at?: string; }
export interface JurisdictionRule { readonly state: string; readonly hazard_amount_cap_rule?: "rcv" | null; readonly lpi_state_regulation?: { readonly name: string; readonly verified: boolean } | null; readonly lpi_prompt_charge_prohibited?: boolean; }
export interface Fpi92Deps {
  readonly events: EventStore; readonly clock: { now(): string };
  readonly timers?: TimerEngine; readonly ledger?: Ledger; readonly actor?: Actor;
  /** `jurisdiction_rules` lookup (CA amount cap; NY Reg 202 [UNVERIFIED] → attorney). */
  readonly jurisdiction?: (state: string) => JurisdictionRule | undefined;
  /** T&I custodial account for escrowed (k)(5) placements — the 3.7 disbursement rail. */
  readonly custodial?: { readonly ti: string };
}

const civilDate = (v: unknown): PlainDate | null => typeof v !== "string" ? null : /^\d{4}-\d{2}-\d{2}$/.test(v) ? D(v) : /^\d{4}-\d{2}-\d{2}T/.test(v) ? wallClock(Date.parse(v), "America/New_York").date : null;
const STATUS_PHRASE: Record<LapseKind, "expired" | "provides insufficient coverage"> = { expired: "expired", cancelled: "expired", nonrenewed: "expired", insufficient_coverage: "provides insufficient coverage", perils_gap: "provides insufficient coverage" };
const CLOSED_STATUS: Record<ClosedReason, FpiCaseStatus> = { closed_evidence: "closed_evidence", k5_advance: "closed_k5_advance", servicer_pays: "closed_servicer_pays", paid_off: "closed_paid_off", transferred: "closed_transferred", reo: "closed_reo", charged_off: "closed_charged_off", error: "closed_error" };
const isClosed = (c: FpiCase): boolean => c.status.startsWith("closed_");

export class Fpi92Service {
  private readonly deps: Fpi92Deps;
  private readonly cases = new Map<string, FpiCase>();
  private readonly placements = new Map<string, LpiPlacement>();
  private readonly requests = new Map<string, PlacementRequest>();
  readonly charges: LpiCharge[] = [];
  constructor(deps: Fpi92Deps) { this.deps = deps; }

  get(caseId: string): FpiCase { const c = this.cases.get(caseId); if (!c) throw new RangeError(`no fpi case ${caseId}`); return c; }
  all(): readonly FpiCase[] { return [...this.cases.values()]; }
  /** The open FPI case on a loan (at most one per loan/cycle). */
  openFor(loanId: string): FpiCase | undefined { return this.all().find((c) => c.loan_id === loanId && !isClosed(c)); }
  placement(id: string): LpiPlacement { const p = this.placements.get(id); if (!p) throw new RangeError(`no lpi placement ${id}`); return p; }
  clocks(c: FpiCase): FpiClocks | null { return c.first_notice_mailed_at ? fpiClocks(c.first_notice_mailed_at, c.reminder_mailed_at) : null; }

  private emit(type: string, c: { loan_id: string; case_id: string }, payload: Record<string, unknown>, causationId?: string): DomainEvent {
    return this.deps.events.append({ type, loanId: c.loan_id, aggregate: { kind: "fpi_case", id: c.case_id }, actor: this.deps.actor ?? INSURANCE_AGENT, ...(causationId ? { causationId } : {}), payload: { case_id: c.case_id, loan_id: c.loan_id, ...payload } });
  }

  // ---- open (state machine `opened` → `k5_blocked` | `first_notice_pending`; 9.2-T3/T4/T9) ---------------------------
  /**
   * `insurance.lapse_detected` (9.1) opens the case with the guards evaluated at open: escrowed? > 30 days overdue?
   * inability documented (3.7 / §1024.17(k)(5))? flood (→ 9.6 track)? wind-only gap (`insurance_type='wind'`)?
   * An escrowed loan ≤ 30 days overdue never sees FPI (the servicer pays/advances under (k)(1)–(2)); escrowed and
   * > 30 without inability is `k5_blocked` — 3.7 advances the premium and the case closes `k5_advance`, no notice.
   */
  openCase(i: OpenCaseInput, causationId?: string): FpiCase {
    if (this.openFor(i.loan_id)) throw new RangeError(`loan ${i.loan_id} already has an open FPI case`);
    if (i.basis && !reasonableBasis(i.basis.kind, i.basis.deficiency)) throw new RangeError(`${i.basis.kind}: not a reasonable basis for force-placement (9.2 rule 1: deductible-excess, rating and mortgagee-clause deficiencies are not LPI triggers)`);
    const o = lapseDetected({ escrowed: i.escrowed, regx_days_delinquent: i.regx_days_delinquent, cancellation_reason: i.cancellation_reason, ...(i.vacant !== undefined ? { vacant: i.vacant } : {}), insurance_type: i.insurance_type, fdpa_required: i.fdpa_required, opened_on: i.opened_on });
    const c: FpiCase = {
      case_id: i.case_id ?? `fpi-${i.loan_id}-${i.opened_on}`, loan_id: i.loan_id, deficiency_id: i.deficiency_id ?? null, kind: i.kind, insurance_type: i.insurance_type, track: o.track, escrowed: i.escrowed, regx_days_delinquent: i.regx_days_delinquent,
      guard: o.guard, k5_gate: o.k5_gate, state: i.state ?? null, opened_at: i.opened_on, lapse_start: i.lapse_start, basis: i.basis ?? null, basis_summary: i.basis ? `${i.basis.kind}:${i.basis.evidence_id}` : null,
      first_notice_id: null, first_notice_mailed_at: null, reminder_notice_id: null, reminder_mailed_at: null, reminder_variant: null, evidence_window_end: null, earliest_charge_date: null, evidence: null,
      lpi_placement_id: null, placement_request_id: null, annual_premium_cents: null, premium_is_estimate: null, estimate_basis: null, renewal_cycle: 0, status: o.case_status, closed_reason: null,
    };
    this.cases.set(c.case_id, c);
    const k5_blocked = o.case_status === "k5_blocked";
    // Every guard result is on the event: the (k)(5) gate arms on `escrowed=true`, the 3-BD notice SLA only when the case is not k5-blocked and on the Reg X track.
    this.emit("fpi.case.opened", c, { kind: i.kind, insurance_type: i.insurance_type, track: o.track, escrowed: i.escrowed, regx_days_delinquent: i.regx_days_delinquent, cancellation_reason: i.cancellation_reason, vacant: i.vacant ?? false, guard: o.guard, k5_gate: o.k5_gate, k5_blocked,
      opened_at: i.opened_on, lapse_start: i.lapse_start, first_notice: o.first_notice, status: o.case_status, basis_kind: i.basis?.kind ?? null, basis_evidence_id: i.basis?.evidence_id ?? null }, causationId);
    if (k5_blocked) {
      this.emit("fpi.case.k5_blocked", c, { reason: "§1024.17(k)(5): escrowed and > 30 days overdue without inability to disburse — the premium is advanced (3.7), no force-placement", premium: o.premium });
      this.emit("escrow.advance.requested", c, { line: "hazard", reason: "regx_1024_17_k5_advance", regx_days_delinquent: i.regx_days_delinquent });
      this.close(c, "k5_advance");
    } else if (o.case_status === "closed_servicer_pays") {
      this.emit("escrow.advance.requested", c, { line: "hazard", reason: "regx_1024_17_k1_k2_renewal", regx_days_delinquent: i.regx_days_delinquent });
      this.close(c, "servicer_pays");
    }
    return c;
  }

  /** Rule 1: the reasonable basis is recorded before any notice; only LPI-curable findings qualify. */
  recordBasis(caseId: string, basis: BasisRecord): FpiCase {
    const c = this.get(caseId);
    if (!reasonableBasis(basis.kind, basis.deficiency)) throw new RangeError(`${basis.kind}: not a reasonable basis for force-placement (9.2 rule 1)`);
    c.basis = basis; c.basis_summary = basis.summary ?? `${basis.kind}:${basis.evidence_id}`;
    this.emit("fpi.basis.recorded", c, { basis_kind: basis.kind, basis_evidence_id: basis.evidence_id, summary: c.basis_summary });
    return c;
  }

  // ---- first notice (rule 5; 9.2-T5/T6/T7) ----------------------------------------------------------------------------
  /** Rule 5 content assembly for the MS-3(A) — refused without a recorded basis, on the flood track, or off the `first_notice_pending` state. */
  composeFirstNotice(caseId: string, facts: { borrower_name: string; borrower_address: string; property_address: string; account_last4: string; notice_date: PlainDate; servicer_phone: string; servicer_address: string; insurance_email: string; additional_information?: boolean; estimated_annual_premium_cents?: Cents | null }): { template: typeof MS3A; payload: Record<string, unknown>; insurance_type: "hazard" | "windstorm"; vC_statement: string | null } {
    const c = this.get(caseId);
    if (c.track === "fdpa_flood") throw new RangeError("no MS-3(A) on the fdpa_flood track — the FDPA 45-day flood notice runs under 9.6 (9.2-T9)");
    if (c.status !== "first_notice_pending") throw new RangeError(`case ${caseId} is ${c.status}: the first notice is composed only in first_notice_pending`);
    if (!c.basis) throw new RangeError("no notice without a recorded reasonable basis (9.2 guardrail; rule 1)");
    const v = firstNoticeVariant(STATUS_PHRASE[c.kind] === "expired" ? "expired" : "insufficient", c.insurance_type);
    const type_statement = c.insurance_type === "wind" ? "The type of insurance for which we do not have evidence is windstorm coverage, which your loan requires in addition to your homeowners policy." : null;
    const payload: Record<string, unknown> = { ...facts, notice_date: facts.notice_date, insurance_type: v.insurance_type, status_phrase: STATUS_PHRASE[c.kind], coverage_event_date: c.lapse_start, type_statement, purchase_phrase: v.purchase_phrase,
      additional_information: facts.additional_information ?? false, estimated_annual_premium_cents: facts.estimated_annual_premium_cents ?? null, mail_class: "first_class", account_last4: facts.account_last4 };
    return { template: MS3A, payload, insurance_type: v.insurance_type, vC_statement: type_statement };
  }

  private checkMailing(m: MailingRecord, what: string): void {
    if (m.mail_class !== "first_class" && m.mail_class !== "certified") throw new RangeError(`${what}: §1024.37(f) requires a class of mail not less than first-class (got ${m.mail_class})`);
    if (!productionWindowOk(m.produced_at, m.mailed_at)) throw new RangeError(`REGX_1024_37D5_NOTICE_PRODUCTION_5BD: ${what} produced ${m.produced_at} and mailed ${m.mailed_at} — more than 5 federal business days; regenerate with current evidence (comment 37(d)(5)-1)`);
  }

  /** Proof of mailing of the MS-3(A) → t0 = the date placed in the mail; the 30- and 45-day clocks anchor here (rule 6; 9.2-T1/T7). */
  recordFirstNoticeMailed(m: MailingRecord, causationId?: string): FpiClocks {
    const c = this.get(m.case_id);
    if (c.status !== "first_notice_pending") throw new RangeError(`case ${c.case_id} is ${c.status}: a first notice can be recorded only once, in first_notice_pending`);
    if (!c.basis) throw new RangeError("no notice without a recorded reasonable basis (9.2 guardrail; rule 1)");
    this.checkMailing(m, "first notice");
    const clocks = fpiClocks(m.mailed_at, null);
    c.first_notice_id = m.notice_id; c.first_notice_mailed_at = m.mailed_at; c.earliest_charge_date = clocks.earliest_charge; c.status = "first_notice_sent";
    this.emit("fpi.first_notice.sent", c, { notice_id: m.notice_id, template: MS3A, first_notice_mailed_at: m.mailed_at, produced_at: m.produced_at, mail_class: m.mail_class, proof_of_mailing_id: m.proof_of_mailing_id, reminder_not_before: clocks.reminder_not_before, earliest_charge_date: clocks.earliest_charge }, causationId);
    return clocks;
  }

  // ---- reminder (9.3 mails it; 9.2 owns the clocks) --------------------------------------------------------------------
  /** Proof of mailing of the MS-3(B)/(C) → t1; refused before t0 + 30 (`REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30`). */
  recordReminderMailed(m: MailingRecord & { readonly variant: "b_no_info" | "c_insufficient" }, causationId?: string): FpiClocks {
    const c = this.get(m.case_id);
    const t0 = c.first_notice_mailed_at;
    if (!t0 || c.status !== "first_notice_sent") throw new RangeError(`case ${c.case_id} is ${c.status}: the reminder follows a mailed first notice`);
    if (!reminderAllowed(fpiClocks(t0, null), m.mailed_at)) throw new RangeError(`REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30 open until ${fpiClocks(t0, null).reminder_not_before}: reminder command refused (§1024.37(d)(1))`);
    this.checkMailing(m, "reminder");
    const clocks = fpiClocks(t0, m.mailed_at);
    c.reminder_notice_id = m.notice_id; c.reminder_mailed_at = m.mailed_at; c.reminder_variant = m.variant; c.evidence_window_end = clocks.evidence_window_end; c.earliest_charge_date = clocks.earliest_charge; c.status = "evidence_window";
    this.emit("fpi.reminder.sent", c, { notice_id: m.notice_id, template: REMINDER_TEMPLATES[m.variant], variant: m.variant, reminder_mailed_at: m.mailed_at, produced_at: m.produced_at, mail_class: m.mail_class, proof_of_mailing_id: m.proof_of_mailing_id, evidence_window_end: clocks.evidence_window_end, earliest_charge_date: clocks.earliest_charge }, causationId);
    return clocks;
  }

  // ---- evidence window (§1024.37(c)(1)(iii); rule 6; 9.2-T8) ----------------------------------------------------------
  /** Evidence received during the cycle: continuous compliant coverage from the lapse closes the case (day 15 counts); a later start leaves a gap the charge is limited to. */
  recordEvidence(caseId: string, e: EvidenceRecord): FpiCase {
    const c = this.get(caseId);
    if (isClosed(c)) throw new RangeError(`case ${caseId} is ${c.status}`);
    c.evidence = e;
    this.emit("fpi.evidence.received", c, { received_on: e.received_on, continuous_coverage: e.continuous_coverage, evidence_id: e.evidence_id ?? null });
    return c;
  }
  /**
   * The evaluation the 15-day row waits for: recorded at the window end (or when evidence arrives). Continuous coverage
   * evidenced on or before t1 + 15 → no charge, `closed_evidence`; nothing → `chargeable` once max(t0 + 45, t1 + 15) has arrived.
   */
  evaluateEvidenceWindow(caseId: string, evaluatedOn: PlainDate, evidence?: EvidenceRecord | null): { outcome: "continuous_coverage" | "late_evidence" | "gap_remains" | "no_evidence"; chargeable: boolean; window_end: PlainDate; case: FpiCase } {
    const c = this.get(caseId);
    if (evidence) this.recordEvidence(caseId, evidence);
    const clocks = this.clocks(c);
    if (!clocks || clocks.t1 === null || !c.evidence_window_end) throw new RangeError(`case ${caseId}: the evidence window opens with the reminder (status ${c.status})`);
    const e = c.evidence;
    const inWindow = e !== null && e.received_on <= clocks.evidence_window_end;
    // Continuous coverage evidenced after the window does not stop the cycle: the charge proceeds and 9.5 cancels/refunds under §1024.37(g).
    const outcome = e && e.continuous_coverage ? (inWindow ? "continuous_coverage" : "late_evidence") : e ? "gap_remains" : "no_evidence";
    const chargeable = outcome !== "continuous_coverage" && evaluatedOn >= clocks.earliest_charge;
    this.emit("fpi.evidence_window.evaluated", c, { evaluated_on: evaluatedOn, window_end: clocks.evidence_window_end, outcome, evidence_received_on: e?.received_on ?? null, continuous_coverage: e?.continuous_coverage ?? null, chargeable, earliest_charge_date: clocks.earliest_charge });
    if (outcome === "continuous_coverage") this.close(c, "closed_evidence");
    else if (chargeable && c.status === "evidence_window") { c.status = "chargeable"; this.emit("fpi.case.chargeable", c, { chargeable_on: evaluatedOn, earliest_charge_date: clocks.earliest_charge }); }
    return { outcome, chargeable, window_end: clocks.evidence_window_end, case: c };
  }

  // ---- placement (rule 4; B-6-01; 9.2-T10/T11) -------------------------------------------------------------------------
  /** Rule 4 coverage: min(last known if within ±15% of RCV else RCV, state cap); CA caps at replacement cost; deductible per the B-6-01 tier. */
  coverage(caseId: string, cov: CoverageInput): { coverage_cents: Cents; deductible_cents: Cents; basis: string; state_cap_cents: Cents | null } {
    const c = this.get(caseId);
    const rule = c.state ? this.deps.jurisdiction?.(c.state) : undefined;
    const capped = c.state === "CA" || rule?.hazard_amount_cap_rule === "rcv";
    const state_cap = capped ? (cov.state_cap_cents ?? cov.rcv_cents) : (cov.state_cap_cents ?? null);
    const r = lpiCoverage({ last_known_cents: cov.last_known_cents, rcv_cents: cov.rcv_cents, upb_cents: cov.upb_cents, state_cap_cents: state_cap, ...(cov.vacant !== undefined ? { vacant: cov.vacant } : {}) });
    return { ...r, state_cap_cents: state_cap };
  }
  /**
   * Outbound `lpi_placement_request` (idempotency key = case + cycle) at cycle end (9.2-Q2 default), effective retroactive to
   * the lapse (comment 37(c)(1)(i)-1). Refused: vendor not whitelisted / affiliate / any fee beyond the premium (B-6-01,
   * §1024.37(h)); before both notices exist (`FNMA_B601_LPI_AFTER_ATTEMPTS`); on a (k)(5)-blocked escrowed loan
   * (`REGX_1024_17K5_LPI_PURCHASE_GATE`); before the charge gates open or when continuous coverage was evidenced.
   */
  requestPlacement(caseId: string, on: PlainDate, cov: CoverageInput, vendor: VendorConfig, quote: QuoteInput): PlacementRequest {
    const c = this.get(caseId);
    if (isClosed(c)) throw new RangeError(`case ${caseId} is ${c.status}: no placement`);
    const screen = placementConfig(vendor);
    if (!screen.accepted) throw new RangeError(`placement configuration rejected: ${screen.rejected.join("; ")}`);
    if (c.k5_gate === "blocked_advance") throw new RangeError("REGX_1024_17K5_LPI_PURCHASE_GATE: escrowed and > 30 days overdue without inability to disburse — placement refused (§1024.17(k)(5))");
    if (!c.first_notice_mailed_at || !c.reminder_mailed_at) throw new RangeError("FNMA_B601_LPI_AFTER_ATTEMPTS: placement refused — LPI only after the first notice and the reminder have been mailed (B-6-01 'unsuccessful attempts')");
    const rule = c.state ? this.deps.jurisdiction?.(c.state) : undefined;
    if (rule?.lpi_state_regulation && !rule.lpi_state_regulation.verified) throw new RangeError(`${rule.lpi_state_regulation.name}: state LPI rule not yet verified — attorney review before placement (9.2 prerequisites)`);
    const d = chargeDecision(this.clocks(c)!, on, c.evidence?.continuous_coverage ? c.evidence.received_on : null, c.lapse_start);
    if (!d.allowed) throw new RangeError(`placement refused: ${d.reason}`);
    const cv = this.coverage(caseId, cov);
    const q = premiumQuote(quote.carrier_quote_cents, cv.coverage_cents, quote.table_rate_pct);
    const req: PlacementRequest = { request_id: `lpr-${c.case_id}-${c.renewal_cycle}`, case_id: c.case_id, loan_id: c.loan_id, coverage_cents: cv.coverage_cents, coverage_method: cv.basis, deductible_cents: cv.deductible_cents, effective: d.effective, expiration: d.expiration, quote: q, idempotency_key: `${c.case_id}+${c.renewal_cycle}` };
    this.requests.set(req.request_id, req);
    c.placement_request_id = req.request_id; c.annual_premium_cents = q.annual_premium_cents; c.premium_is_estimate = q.is_estimate; c.estimate_basis = q.is_estimate ? `${q.basis} ${quote.rate_table_version ?? "current"}` : q.basis;
    this.emit("fpi.placement.requested", c, { request_id: req.request_id, idempotency_key: req.idempotency_key, vendor_id: vendor.vendor_id, coverage_cents: cv.coverage_cents, coverage_method: cv.basis, deductible_cents: cv.deductible_cents, effective: d.effective, expiration: d.expiration, premium_cents: q.annual_premium_cents, premium_is_estimate: q.is_estimate, estimate_basis: c.estimate_basis, state_cap_cents: cv.state_cap_cents });
    return req;
  }
  /** Inbound `lpi_bound` {policy no., premium, effective}: validated against the request, then the placement is on the books (advance posted for a non-escrowed loan — rule 7). */
  recordLpiBound(inbound: LpiBoundInbound, causationId?: string): { placement: LpiPlacement; ledger: EntrySet | null } {
    const req = this.requests.get(inbound.request_id); if (!req) throw new RangeError(`no placement request ${inbound.request_id}`);
    const c = this.get(req.case_id);
    if (isClosed(c)) throw new RangeError(`case ${c.case_id} is ${c.status}: binding refused`);
    if (inbound.effective !== req.effective) throw new RangeError(`lpi_bound effective ${inbound.effective} ≠ requested ${req.effective} (retroactive to the lapse — comment 37(c)(1)(i)-1)`);
    if (inbound.premium_cents <= 0n) throw new RangeError("lpi_bound premium must be positive");
    if ((inbound.fees_cents ?? 0n) !== 0n) throw new RangeError("lpi_bound carries fees beyond the premium: B-6-01 commission/incentive exclusion; §1024.37(h) bona fide premium only");
    const bound_at = inbound.bound_at ?? this.deps.clock.now();
    const p: LpiPlacement = { id: `lpi-${req.request_id}`, fpi_case_id: c.case_id, carrier_party_id: inbound.vendor_ref ?? "lpi-carrier", coverage_amount_cents: req.coverage_cents, coverage_method: req.coverage_method, deductible_cents: req.deductible_cents,
      effective_date: inbound.effective, expiration_date: inbound.expiration ?? req.expiration, premium_cents: inbound.premium_cents, premium_is_estimate: false, bound_at, vendor_ref: inbound.policy_number, status: "bound" };
    this.placements.set(p.id, p);
    c.lpi_placement_id = p.id; c.annual_premium_cents = p.premium_cents; c.premium_is_estimate = false; c.estimate_basis = `carrier_bound ${inbound.policy_number}`; c.status = "lpi_bound";
    // Rule 7 — non-escrowed: at binding Dr corporate_advance (loan) / Cr corporate cash (vendor premium paid). Escrowed (k)(5) inability: the `lpi_premium` disbursement is 3.7's (Dr escrow / Cr custodial_ti_cash).
    let set: EntrySet | null = null;
    if (this.deps.ledger) {
      set = c.escrowed
        ? this.deps.ledger.post({ effectiveDate: D(bound_at.slice(0, 10)), description: `LPI premium disbursement (escrowed, §1024.17(k)(5) inability) ${p.id}`, lines: [{ account: { scope: "loan", loanId: c.loan_id, account: "escrow" }, amountCents: p.premium_cents, ruleRef: "9.2 rule 7 / 3.7 lpi_premium" }, { account: { scope: "custodial", custodialAccountId: this.deps.custodial?.ti ?? "C-TI", account: "custodial_ti_cash" }, amountCents: -p.premium_cents, ruleRef: "9.2 rule 7 / 3.7 lpi_premium" }] }, bound_at)
        : this.deps.ledger.post({ effectiveDate: D(bound_at.slice(0, 10)), description: `LPI premium advanced at binding ${p.id}`, lines: [{ account: { scope: "loan", loanId: c.loan_id, account: "corporate_advance" }, amountCents: p.premium_cents, ruleRef: "9.2 rule 7" }, { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -p.premium_cents, ruleRef: "9.2 rule 7" }] }, bound_at);
    }
    this.emit("fpi.lpi_bound", c, { placement_id: p.id, request_id: req.request_id, policy_number: inbound.policy_number, effective: p.effective_date, expiration: p.expiration_date, coverage_cents: p.coverage_amount_cents, deductible_cents: p.deductible_cents, premium_cents: p.premium_cents, bound_at, ledger_set_id: set?.id ?? null, rail: c.escrowed ? "escrow_disbursement_3_7" : "corporate_advance" }, causationId);
    if (c.escrowed) this.emit("escrow.disbursement.requested", c, { disbursement_kind: "lpi_premium", amount_cents: p.premium_cents, placement_id: p.id, followed_by: "interim_escrow_analysis" });
    return { placement: p, ledger: set };
  }

  // ---- charge (rule 6/7; 9.2-T1/T2) -----------------------------------------------------------------------------------
  /** Whether the charge command is allowed on `on` — the gate the not-before rows and the agent guardrail share. */
  chargeAllowed(caseId: string, on: PlainDate): ReturnType<typeof chargeDecision> {
    const c = this.get(caseId);
    if (c.status === "closed_evidence") return { allowed: false, reason: "closed_evidence" };
    if (isClosed(c)) return { allowed: false, reason: c.status };
    const clocks = this.clocks(c);
    if (!clocks) return { allowed: false, reason: "FIRST_NOTICE_NOT_MAILED" };
    return chargeDecision(clocks, on, c.evidence?.continuous_coverage ? c.evidence.received_on : null, c.lapse_start);
  }
  /**
   * Assess the borrower charge: refused before max(t0 + 45, t1 + 15) (`REGX_1024_37C_FPI_FIRST_NOTICE_45` /
   * `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15`), after continuous coverage was evidenced in the window, or without a bound
   * policy. Covers lapse_start → placement expiration (retroactive), less any period the borrower proved was covered.
   */
  assessCharge(caseId: string, on: PlainDate, opts: { covered_from?: PlainDate | null } = {}): { charge: LpiCharge; daily_rate: Decimal; event: DomainEvent } {
    const c = this.get(caseId);
    const d = this.chargeAllowed(caseId, on);
    if (!d.allowed) throw new RangeError(`charge command refused: ${d.reason}`);
    if (!c.lpi_placement_id) throw new RangeError("the borrower charge waits for a bound policy (9.2 integrations: vendor bind failure/outage)");
    const p = this.placement(c.lpi_placement_id);
    const term = { effective: p.effective_date, expiration: p.expiration_date, premium_cents: p.premium_cents };
    const rate = dailyRate(term);
    const period_end = opts.covered_from && opts.covered_from < p.expiration_date ? opts.covered_from : p.expiration_date;
    const days = Math.round((Date.parse(period_end) - Date.parse(p.effective_date)) / 86_400_000);
    const amount = period_end === p.expiration_date ? p.premium_cents : rate.mul(Decimal.fromInt(days)).toScaledInt(0, "HALF_UP");
    const charge: LpiCharge = { id: `lpc-${c.case_id}-${c.renewal_cycle}`, fpi_case_id: c.case_id, placement_id: p.id, period_start: p.effective_date, period_end: addDays(period_end, -1), amount_cents: amount, assessed_at: this.deps.clock.now(), ledger_entry_id: null, disbursement_id: null, borrower_paid_cents: 0n };
    this.charges.push(charge); p.status = "charged"; c.status = "charged";
    const event = this.emit("fpi.charge.assessed", c, { charge_id: charge.id, placement_id: p.id, amount_cents: amount, period_start: charge.period_start, period_end: charge.period_end, assessed_on: on, daily_rate_cents: rate.toFixed(6), earliest_charge_date: c.earliest_charge_date, statement_line: "Lender-placed insurance premium", rail: c.escrowed ? "escrow_disbursement_3_7" : "corporate_advance_receivable" });
    if (c.escrowed) this.emit("escrow.analysis.requested", c, { kind: "interim", reason: "lpi_premium_disbursed", amount_cents: amount });
    return { charge, daily_rate: rate, event };
  }

  // ---- close ------------------------------------------------------------------------------------------------------------
  closeCase(caseId: string, reason: Exclude<ClosedReason, "closed_evidence" | "k5_advance" | "servicer_pays">, causationId?: string): FpiCase { const c = this.get(caseId); if (isClosed(c)) return c; return this.close(c, reason, causationId); }
  private close(c: FpiCase, reason: ClosedReason, causationId?: string): FpiCase {
    c.status = CLOSED_STATUS[reason]; c.closed_reason = reason;
    this.emit("fpi.case.closed", c, { closed_reason: reason, charged: this.charges.some((x) => x.fpi_case_id === c.case_id), status: c.status }, causationId);
    if (this.deps.timers) for (const t of this.deps.timers.open()) if (t.loanId === c.loan_id && FPI_92_TIMERS.includes(t.code)) this.deps.timers.cancel(t.id, `fpi case ${c.case_id} ${c.status}`, this.deps.actor ?? INSURANCE_AGENT);
    return c;
  }
}

// ---- reactors: the inbound events that drive the case ----------------------------------------------------------------
/**
 * Wire the service to the event log: `insurance.lapse_detected` (9.1) opens the case; the print-mail proof of mailing
 * (`notice.mailed` on an MS-3(A) or MS-3(B)/(C)) records t0 / t1 from the mailing date and the production date the
 * Notice Registry recorded for the same notice; payoff / transfer-out / REO / charge-off close the case. Returns the unsubscribe.
 */
export function fpiReactors_9_2(svc: Fpi92Service, events: EventStore): () => void {
  const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
  const mailing = (e: DomainEvent, c: FpiCase): MailingRecord => {
    const noticeId = String(p(e).notice_id ?? e.aggregate?.id ?? "");
    const production = events.all().find((x) => x.type === "notice.production" && x.aggregate?.id === noticeId && (x.payload as { attempt_no?: unknown }).attempt_no === p(e).attempt_no);
    const mailed_at = civilDate(p(e).mailed_at) ?? civilDate(e.occurredAt)!;
    return { case_id: c.case_id, notice_id: noticeId, mailed_at, produced_at: civilDate(production?.payload.production_at) ?? mailed_at, mail_class: String(p(e).mail_class ?? "first_class"), proof_of_mailing_id: String(p(e).proof_of_mailing_id ?? "") };
  };
  // An inbound record the service refuses (stale production, wrong mail class, a second first notice, a basis that is not one) is
  // recorded as a rejection on the loan, never thrown back into the Notice Registry's or 9.1's transaction.
  const guarded = (what: string, fn: (e: DomainEvent) => void) => (e: DomainEvent): void => {
    try { fn(e); } catch (err) { events.append({ type: "fpi.inbound.rejected", ...(e.loanId ? { loanId: e.loanId } : {}), ...(e.aggregate ? { aggregate: e.aggregate } : {}), actor: INSURANCE_AGENT, causationId: e.id, payload: { inbound: what, source_event: e.type, reason: (err as Error).message } }); }
  };
  const offs = [
    events.subscribe("insurance.lapse_detected", guarded("lapse_detected", (e) => {
      const f = p(e); const loanId = e.loanId ?? String(f.loan_id ?? ""); if (!loanId || svc.openFor(loanId)) return;
      const kind = String(f.kind ?? "expired") as LapseKind;
      const basisEvidence = typeof f.basis_evidence === "string" ? f.basis_evidence : typeof f.basis_evidence_id === "string" ? f.basis_evidence_id : null;
      const basisKind = (typeof f.basis_kind === "string" ? f.basis_kind : kind === "cancelled" ? "carrier_cancellation" : kind === "nonrenewed" ? "carrier_nonrenewal" : kind === "expired" ? "vendor_expiration_no_renewal" : "insufficient_coverage") as BasisKind;
      svc.openCase({ loan_id: loanId, kind, insurance_type: (String(f.insurance_type ?? "hazard") as InsuranceType), fdpa_required: f.fdpa_required === true, escrowed: f.escrowed === true, regx_days_delinquent: Number(f.regx_days_delinquent ?? 0),
        cancellation_reason: (f.cancellation_reason as OpenCaseInput["cancellation_reason"] | undefined) ?? null, vacant: f.vacant === true, lapse_start: civilDate(f.lapse_start) ?? civilDate(f.expiration_date) ?? civilDate(e.occurredAt)!, opened_on: civilDate(f.detected_on) ?? civilDate(e.occurredAt)!,
        basis: basisEvidence ? { kind: basisKind, evidence_id: basisEvidence, ...(f.deficiency !== undefined ? { deficiency: f.deficiency as Deficiency } : {}) } : null, deficiency_id: typeof f.deficiency_id === "string" ? f.deficiency_id : null, state: typeof f.state === "string" ? f.state : null }, e.id);
    })),
    events.subscribe(`notice.mailed{template=${MS3A}}`, guarded("first_notice_proof_of_mailing", (e) => { const c = e.loanId ? svc.openFor(e.loanId) : undefined; if (c) svc.recordFirstNoticeMailed(mailing(e, c), e.id); })),
    events.subscribe(`notice.mailed{template∈{${REMINDER_TEMPLATES.b_no_info}, ${REMINDER_TEMPLATES.c_insufficient}}}`, guarded("reminder_proof_of_mailing", (e) => { const c = e.loanId ? svc.openFor(e.loanId) : undefined; if (c) svc.recordReminderMailed({ ...mailing(e, c), variant: p(e).template === REMINDER_TEMPLATES.c_insufficient ? "c_insufficient" : "b_no_info" }, e.id); })),
    ...([["loan.paid_in_full", "paid_off"], ["servicing.transfer_out.effective", "transferred"], ["reo.acquired", "reo"], ["loan.charged_off", "charged_off"]] as const).map(([type, reason]) =>
      events.subscribe(type, guarded(type, (e) => { const c = e.loanId ? svc.openFor(e.loanId) : undefined; if (c) svc.closeCase(c.case_id, reason, e.id); }))),
  ];
  return () => { for (const off of offs) off(); };
}
