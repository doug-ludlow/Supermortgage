/**
 * §12.8 Fannie Mae Flex Modification — the lifecycle service over the pure calculators (flexmod.ts: waterfall, trial
 * count/schedule, month-end rule; ops.ts: solicitation window, MBS gate, document clocks, conversion ledger, incentive,
 * binding conditions, Form 3179 change rule, MIR lookup, three-prior-mods denial). Every `FlexModService` method
 * validates its input against the `modifications` record and appends the events the 12.8 timer rows (timers-12-8.ts)
 * are armed and satisfied by; the inbound-integration handlers (SMDU reclassification / close / TPP-payment ack,
 * e-sign completion, e-recording receipt, custodian confirmation, the 5.x loan-data-change ack) validate the vendor
 * record against the modification's state before appending the platform event. Cashiering (2.6) owns the trial
 * ledger — `lossmit.trial.started`, `trial_payment.received/satisfied`, `lossmit.trial.completed/failed` — so this
 * service subscribes to those and derives the 12.8 milestones (first payment = acceptance, penultimate payment met,
 * final payment cleared, `tpp_completed{mbs}`, final due month ended) from them. Money is bigint cents; dates are
 * PlainDate; state changes are new record versions plus events, never edits of history.
 *
 * Event vocabulary (producer 12.8):
 *   solicitation_packages.send_requested{kind=flex_mod, foreclosure_type, days_to_sale}   the solicitation command (sale-proximity gate)
 *   lossmit.flex_solicitation.window_opened{basis, day_90_date|day_60_date, brp_complete, sale_proximate, step_rate_adjusted_within_12m, solicit_by}
 *   lossmit.evaluation.started{option=flex_mod, criteria}  lossmit.evaluation.decided{outcome∈{tpp_offer, denied}, decided_on}
 *   smdu.case.submit_requested{kind=tpp, valuation_as_of, valuation_age_days}  smdu.case.submitted{workout=flex_mod_tpp}
 *   lossmit.tpp.offered{notice_sent_on, first_trial_due_date, effective_date}  lossmit.trial.schedule_created{due_dates}
 *   lossmit.trial.first_payment_received{payment_date, acceptance_items_missing}  lossmit.offer.acceptance_items.received
 *   lossmit.trial.penultimate_payment_met{final_trial_month_start}  lossmit.tpp.completed{mbs}  trial_plan_schedule.final_due_month_ended{final_due_month_end}
 *   lossmit.agreement.sent{form=3179, effective_date}  esign.completed{form=3179}  lossmit.agreement.executed_copy_received{form=3179, received_on}
 *   lossmit.modification.execution_ready{borrower_executed, final_trial_payment_cleared, reclass_pending, effective_date}
 *   smdu.case.reclassified  lossmit.modification.redated  lossmit.agreement.servicer_executed{form=3179, officer_signature_date, effective_date}
 *   ledger.posted{rule_ref=12.8.capitalization}  lossmit.modification.effective  investor.event.accepted{kind=loan_data_change}
 *   erecording.recorded_document.received{received_on}  custodian.delivery.confirmed{document}  smdu.tpp_payment.acked  smdu.case.closed
 *   lossmit.modification.completed
 */
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { type PlainDate, addDays, addMonths, daysBetween, endOfMonth, parts, ymd } from "../../kernel/calendar/date.ts";
import type { Ledger } from "../../kernel/ledger/ledger.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { waterfall, trialCount, trialSchedule, type WaterfallInputs, type WaterfallResult } from "./flexmod.ts";
import { streamlinedSolicitationWindow, mbsExecutionGate, bindingConditions, form3179Changes, flexIncentive, mirLookup, postConversionLedger, flexEligibilityDenial } from "./ops.ts";

export const FLEXMOD_ACTOR: Actor = { kind: "agent", id: "lossmit-underwriter" };
export const RULE_SET_VERSION = "fnma.flexmod.2025-08";
export const TPP_OFFER_TEMPLATE = "NTC_FNMA_D23206_TPP_OFFER";
export const SOLICITATION_TEMPLATE = "NTC_FNMA_D23206_SOLICIT_STREAMLINED";
export const FORM_3179 = "DOC_FNMA_FORM_3179";

export type ModStatus = "evaluating" | "denied" | "eligible" | "tpp_offered" | "tpp_active" | "tpp_completed" | "tpp_failed" | "docs_out" | "borrower_executed" | "reclass_pending" | "servicer_executed" | "booked" | "effective" | "recorded" | "custodian_delivered" | "completed" | "cancelled";
export type SolicitationBasis = "streamlined_90" | "step_rate_60" | "post_forbearance" | "post_repayment" | "post_deferral";
export type ModBasis = "brp" | "streamlined" | "post_plan" | "disaster";
export interface Valuation { readonly method: string; readonly value_cents: Cents; readonly as_of: PlainDate; readonly confidence: "reliable" | "unreliable" | null; readonly source_doc?: string | null; }
export interface MirVersion { readonly effective: PlainDate; readonly rate_pct: string; }
export interface ModTerms { readonly rate_pct: string; readonly term_months: number; readonly ib_upb_cents: Cents; readonly forborne_cents: Cents; readonly new_pi_cents: Cents; readonly effective_date: PlainDate; readonly maturity_date: PlainDate; readonly capitalization_date: PlainDate; }
export interface TrialPlan { readonly months: 3 | 4; readonly due_dates: readonly PlainDate[]; readonly first_due: PlainDate; readonly trial_pi_cents: Cents; readonly trial_escrow_cents: Cents; readonly trial_total_cents: Cents; readonly effective: PlainDate; readonly capitalization_date: PlainDate; readonly form_3179_by: PlainDate; readonly incentive_deadline: PlainDate; readonly processing_month: boolean; }
/** The `modifications` row (12.8 data model) as the service versions it. */
export interface FlexModification {
  readonly id: string; readonly loan_id: string; readonly case_id: string; readonly program: "flex_mod"; readonly basis: ModBasis; readonly status: ModStatus;
  readonly evaluation_date: PlainDate; readonly delinquent_31_plus: boolean; readonly imminent_default: boolean; readonly disaster: boolean; readonly mbs: boolean; readonly recording_required: boolean;
  readonly valuation: Valuation | null; readonly mod_interest_rate_version: MirVersion | null; readonly waterfall_inputs: WaterfallInputs | null; readonly waterfall: WaterfallResult | null; readonly terms: ModTerms | null; readonly exhaustion_offer: boolean;
  readonly trial: TrialPlan | null; readonly smdu_tpp_case_id: string | null; readonly smdu_close_case_id: string | null;
  readonly acceptance_items_required: readonly string[]; readonly acceptance_items_received: readonly string[];
  readonly reclassified_at: PlainDate | null; readonly form_3179_document_id: string | null; readonly form_3179_sent_at: PlainDate | null; readonly borrower_executed_at: PlainDate | null; readonly executed_copy_received_at: PlainDate | null;
  readonly servicer_executed_at: PlainDate | null; readonly officer_signature_date: PlainDate | null; readonly recorded_at: PlainDate | null; readonly recorded_original_received_at: PlainDate | null; readonly custodian_delivered_at: PlainDate | null; readonly custodian_deliveries: readonly { document: string; on: PlainDate }[];
  readonly final_trial_payment_cleared_at: PlainDate | null; readonly execution_ready_event_id: string | null; readonly booked_set_id: string | null; readonly loan_terms_version: string | null;
  readonly effective_event_id: string | null; readonly completed_at: PlainDate | null; readonly completed_event_id: string | null; readonly incentive_claim_id: string | null;
  readonly prior_modifications: number; readonly last_trial_failed_on: PlainDate | null; readonly denial: { criterion: string; reason_code: string } | null;
}

export type EscalationKind = "officer" | "signing_officer" | "lossmit_reviewer" | "human_portal_task" | "attorney";
export interface EscalationSink { open(input: { kind: EscalationKind; loanId?: string; payload?: Record<string, unknown>; severity?: string }, by: Actor): unknown; }
export interface NoticeRecipient { readonly partyId: string; readonly name: string; readonly mailingAddress: string | null; }
export interface NoticeSender { render(input: { templateCode: string; loanId?: string; recipients: readonly NoticeRecipient[]; payload: Record<string, unknown>; asOf: PlainDate }): { id: string; status: string }; send(id: string): Promise<{ id: string; status: string }>; }
export interface SmduLike { createCase(fnmaLoanNumber: string, program: string, data: Record<string, unknown>): Promise<{ caseId: string }>; }
export interface FlexModDeps { readonly events: EventStore; readonly clock: { now(): string }; readonly actor?: Actor; readonly ledger?: Ledger; readonly escalations?: EscalationSink; readonly notices?: NoticeSender; readonly smdu?: SmduLike; /** subscribe to cashiering's trial events (default true) */ readonly subscribe?: boolean; }
export interface NoticeInput { readonly recipients: readonly NoticeRecipient[]; readonly payload: Record<string, unknown>; }

type Payload = Record<string, unknown>;
const str = (c: Cents): string => c.toString();
const monthStart = (d: PlainDate): PlainDate => { const { y, m } = parts(d); return ymd(y, m, 1); };
const rateBps = (pct: string): number => Math.round(Number(pct) * 100);
const num = (v: unknown): number => Number(v ?? NaN);

export class FlexModService {
  private readonly events: EventStore;
  private readonly clock: { now(): string };
  private readonly actor: Actor;
  private readonly deps: FlexModDeps;
  private readonly mods = new Map<string, FlexModification>();
  private readonly versions: FlexModification[] = [];

  constructor(deps: FlexModDeps) {
    this.deps = deps; this.events = deps.events; this.clock = deps.clock; this.actor = deps.actor ?? FLEXMOD_ACTOR;
    if (deps.subscribe !== false) {
      // 2.6 owns the trial ledger; 12.8 derives its milestones from cashiering's events (rule 6; C-1.1-02).
      this.events.subscribe("trial_payment.received", (e) => this.onTrialPaymentReceived(e));
      this.events.subscribe("trial_payment.satisfied", (e) => this.onTrialPaymentSatisfied(e));
      this.events.subscribe("lossmit.trial.completed", (e) => this.onTrialCompleted(e));
      this.events.subscribe("lossmit.trial.failed", (e) => this.onTrialFailed(e));
    }
  }

  // ---- record access ------------------------------------------------------------------------
  get(loanId: string): FlexModification | null { return this.mods.get(loanId) ?? null; }
  require(loanId: string): FlexModification { const m = this.mods.get(loanId); if (!m) throw new RangeError(`no Flex Modification for loan ${loanId}`); return m; }
  history(loanId: string): readonly FlexModification[] { return this.versions.filter((m) => m.loan_id === loanId); }
  private put(m: FlexModification): FlexModification { this.mods.set(m.loan_id, m); this.versions.push(m); return m; }
  private patch(loanId: string, p: Partial<FlexModification>): FlexModification { return this.put({ ...this.require(loanId), ...p }); }
  private today(): PlainDate { return this.clock.now().slice(0, 10) as PlainDate; }
  private emit(type: string, loanId: string, payload: Payload, causationId?: string): DomainEvent {
    return this.events.append({ type, loanId, actor: this.actor, payload, ...(causationId ? { causationId } : {}) });
  }
  private escalate(kind: EscalationKind, loanId: string, payload: Payload, severity?: string): void {
    this.deps.escalations?.open({ kind, loanId, payload, ...(severity ? { severity } : {}) }, this.actor);
  }

  // ---- solicitation without a BRP (D2-3.2-06; timers FNMA_D23206_FLEX_SOLICIT_90_105 / _STEP_60_75 / _SOLICIT_SALE_PROXIMITY_GATE / _NO_NEW_TRIAL_12M)
  /**
   * The solicitation command: refused (BRP path) when a sale is scheduled within 60 (judicial) / 30 (non-judicial)
   * calendar days, when a complete BRP is on file (12.2 evaluates it), or within 12 months of a failed Flex Mod trial.
   * Otherwise opens the window — day 90 → by day 105 (`solicit_by` = day-90 date + 15), step-rate → by day 75 — and,
   * when a notice sender is wired, renders and sends `NTC_FNMA_D23206_SOLICIT_STREAMLINED` through the Notice Registry.
   */
  async solicit(i: { loan_id: string; basis: SolicitationBasis; day_reached_on: PlainDate; fnma_day: number; brp_complete: boolean; sale_on: PlainDate | null; judicial: boolean; step_rate_adjusted_within_12m?: boolean; last_trial_failed_on?: PlainDate | null; notice?: NoticeInput | null }): Promise<{ allowed: boolean; refusal: string | null; solicit_by: PlainDate | null; notice_id: string | null }> {
    const today = this.today(); const days = i.sale_on ? daysBetween(today, i.sale_on) : null;
    const cmd = this.emit("solicitation_packages.send_requested", i.loan_id, { kind: "flex_mod", basis: i.basis, foreclosure_type: i.judicial ? "judicial" : "non_judicial", days_to_sale: days, sale_on: i.sale_on, brp_complete: i.brp_complete, requested_on: today });
    const win = streamlinedSolicitationWindow({ day90_on: i.day_reached_on, brp_complete: i.brp_complete, sale_on: i.sale_on, judicial: i.judicial });
    let refusal = win.allowed ? null : win.refusal;
    if (!refusal && i.last_trial_failed_on && daysBetween(i.last_trial_failed_on, today) < 365) refusal = `solicitation refused: a Flex Mod trial failed on ${i.last_trial_failed_on} — no new trial within 12 months (FNMA_D23206_NO_NEW_TRIAL_12M)`;
    if (refusal) { this.emit("solicitation_packages.send_refused", i.loan_id, { kind: "flex_mod", basis: i.basis, reason: refusal, route: i.brp_complete ? "12.2_evaluation" : "brp_path" }, cmd.id); return { allowed: false, refusal, solicit_by: null, notice_id: null }; }
    const step = i.basis === "step_rate_60";
    if (step && i.step_rate_adjusted_within_12m !== true) throw new RangeError("a days 60–75 solicitation requires a step-rate adjustment within 12 months (D2-3.2-06)");
    this.emit("lossmit.flex_solicitation.window_opened", i.loan_id, { basis: i.basis, fnma_day: i.fnma_day, ...(step ? { day_60_date: i.day_reached_on } : { day_90_date: i.day_reached_on }), brp_complete: false, sale_proximate: false, step_rate_adjusted_within_12m: i.step_rate_adjusted_within_12m === true, solicit_by: win.solicit_by, template: SOLICITATION_TEMPLATE }, cmd.id);
    let noticeId: string | null = null;
    if (i.notice && this.deps.notices) { const n = this.deps.notices.render({ templateCode: SOLICITATION_TEMPLATE, loanId: i.loan_id, recipients: i.notice.recipients, payload: { sale_within_window: false, ...i.notice.payload }, asOf: today }); const sent = await this.deps.notices.send(n.id); noticeId = sent.id; }
    return { allowed: true, refusal: null, solicit_by: win.solicit_by, notice_id: noticeId };
  }

  // ---- evaluation (F-1-27 waterfall; D2-3.2-06 criteria; timers FNMA_D2205_EVAL_NOTICE_TPP_5, FNMA_F127_VALUATION_MAX_AGE_90)
  /**
   * Runs the eligibility criteria and the waterfall for one loan and records the decision. The MIR in effect on the
   * evaluation date governs (rule 1; edge case "MIR changes"): no rate for the date → the waterfall refuses to run and
   * `officer` is alerted (T12). Three prior modifications → denial with the specific Fannie Mae criterion, reviewer
   * approval and appeal rights (T11); a P&I-rule failure → denial `INV_FNMA_F127_PI_RULE` to the reviewer (rule 9).
   * An eligible loan emits `lossmit.evaluation.decided{outcome=tpp_offer}` — the 5-day Evaluation Notice clock.
   */
  evaluate(i: { loan_id: string; case_id: string; basis: ModBasis; evaluation_on: PlainDate; inputs: Omit<WaterfallInputs, "mir_pct">; mir_table: readonly MirVersion[]; valuation: Valuation; imminent_default?: boolean; disaster?: boolean; mbs: boolean; recording_required: boolean; prior_modifications: number; last_trial_failed_on?: PlainDate | null; tier?: "ge_90" | "lt_90" | "le_37"; first_filing_made?: boolean; reviewer_approval_id?: string | null; acceptance_items_required?: readonly string[] }): FlexModification {
    const started = this.emit("lossmit.evaluation.started", i.loan_id, { option: "flex_mod", criteria: i.disaster ? "disaster" : "standard", evaluation_on: i.evaluation_on, case_id: i.case_id });
    const base: FlexModification = { id: `mod-${i.loan_id}-${i.evaluation_on}`, loan_id: i.loan_id, case_id: i.case_id, program: "flex_mod", basis: i.basis, status: "evaluating", evaluation_date: i.evaluation_on, delinquent_31_plus: i.inputs.delinquent_31_plus, imminent_default: i.imminent_default === true, disaster: i.disaster === true, mbs: i.mbs, recording_required: i.recording_required,
      valuation: i.valuation, mod_interest_rate_version: null, waterfall_inputs: null, waterfall: null, terms: null, exhaustion_offer: false, trial: null, smdu_tpp_case_id: null, smdu_close_case_id: null, acceptance_items_required: i.acceptance_items_required ?? [], acceptance_items_received: [],
      reclassified_at: null, form_3179_document_id: null, form_3179_sent_at: null, borrower_executed_at: null, executed_copy_received_at: null, servicer_executed_at: null, officer_signature_date: null, recorded_at: null, recorded_original_received_at: null, custodian_delivered_at: null, custodian_deliveries: [],
      final_trial_payment_cleared_at: null, execution_ready_event_id: null, booked_set_id: null, loan_terms_version: null, effective_event_id: null, completed_at: null, completed_event_id: null, incentive_claim_id: null, prior_modifications: i.prior_modifications, last_trial_failed_on: i.last_trial_failed_on ?? null, denial: null };
    this.put(base);
    const deny = (criterion: string, reason_code: string, extra: Payload = {}): FlexModification => {
      this.emit("lossmit.evaluation.decided", i.loan_id, { evaluation_id: base.id, outcome: "denied", option: "flex_mod", decided_on: i.evaluation_on, reason_code, criterion, investor_name: "Fannie Mae", reviewer_required: true, appeal_rights: true, ...extra }, started.id);
      this.escalate("lossmit_reviewer", i.loan_id, { determination: "denied", reason_code, criterion });
      return this.patch(i.loan_id, { status: "denied", denial: { criterion, reason_code } });
    };
    // 12-month bar after a failed trial (FNMA_D23206_NO_NEW_TRIAL_12M) and the three-prior-mods criterion (D2-3.2-06)
    if (i.last_trial_failed_on && daysBetween(i.last_trial_failed_on, i.evaluation_on) < 365) return deny(`no failed Flex Modification Trial Period Plan within the last 12 months (failed ${i.last_trial_failed_on})`, "FNMA_D23206_TRIAL_FAILED_12M");
    const three = flexEligibilityDenial({ prior_modifications: i.prior_modifications, reviewer_approval_id: i.reviewer_approval_id ?? null, tier: i.tier ?? "ge_90", first_filing_made: i.first_filing_made === true });
    if (three.denied) return deny(three.criterion, "FNMA_D23206_THREE_PRIOR_MODS", { reviewer_approval_id: i.reviewer_approval_id ?? null });
    // MIR in effect on the evaluation date (rule 1); no rate → refuse to run, officer alert (T12)
    const mir = mirLookup(i.mir_table, i.evaluation_on);
    if (mir.refusal || !mir.rate_pct || !mir.effective) { this.escalate("officer", i.loan_id, { reason: mir.escalation?.reason ?? mir.refusal ?? "no Modification Interest Rate", evaluation_on: i.evaluation_on }, "sev2"); this.emit("lossmit.evaluation.refused", i.loan_id, { reason: mir.refusal, evaluation_on: i.evaluation_on }, started.id); throw new RangeError(mir.refusal ?? "no Modification Interest Rate for the evaluation date"); }
    const inputs: WaterfallInputs = { ...i.inputs, mir_pct: mir.rate_pct };
    const w = waterfall(inputs);
    const mirVersion: MirVersion = { effective: mir.effective, rate_pct: mir.rate_pct };
    if (!w.eligible) { this.patch(i.loan_id, { mod_interest_rate_version: mirVersion, waterfall_inputs: inputs, waterfall: w }); return deny("the modified principal and interest payment must be less than (current or less than 31 days delinquent) or less than or equal to (31 or more days delinquent) the pre-modification payment when the waterfall steps are exhausted", w.reason ?? "INV_FNMA_F127_PI_RULE", { pi_cents: str(w.pi_cents), pre_mod_pi_cents: str(i.inputs.pre_mod_pi_cents) }); }
    const rec = this.patch(i.loan_id, { status: "eligible", mod_interest_rate_version: mirVersion, waterfall_inputs: inputs, waterfall: w, exhaustion_offer: w.pi_cents > w.target_pi_cents });
    this.emit("lossmit.evaluation.decided", i.loan_id, { evaluation_id: base.id, outcome: "tpp_offer", option: "flex_mod", decided_on: i.evaluation_on, tier: i.tier ?? null, basis: i.basis, exhaustion_offer: rec.exhaustion_offer, mir_version: mirVersion, terms: { rate_pct: w.rate_pct, term_months: w.term_months, ib_upb_cents: str(w.ib_upb_cents), forborne_cents: str(w.forborne_cents), pi_cents: str(w.pi_cents) } }, started.id);
    return rec;
  }

  /** TPP case submission to SMDU (F-1-22) — gated on a valuation ≤90 days old at evaluation (FNMA_F127_VALUATION_MAX_AGE_90; breach: order a new valuation). */
  async submitTppCase(i: { loan_id: string; partner_servicer_number: string; fnma_loan_number?: string }): Promise<{ case_id: string | null; valuation_age_days: number }> {
    const m = this.require(i.loan_id); if (!m.valuation) throw new RangeError("no valuation on the modification");
    if (!i.partner_servicer_number) throw new RangeError("every SMDU submission carries the partner servicer number (12.2 guardrail)");
    const age = daysBetween(m.valuation.as_of, m.evaluation_date);
    const req = this.emit("smdu.case.submit_requested", i.loan_id, { kind: "tpp", workout: "flex_mod_tpp", valuation_as_of: m.valuation.as_of, valuation_age_days: age, valuation_method: m.valuation.method, evaluation_on: m.evaluation_date });
    if (age > 90 || m.valuation.confidence === "unreliable") { this.emit("valuation.reorder_required", i.loan_id, { reason: age > 90 ? `valuation as of ${m.valuation.as_of} is ${age} days old at evaluation (> 90; F-1-27)` : "AVM confidence unreliable — BPO/appraisal required (F-1-27)", kind: age > 90 ? "any" : "bpo_or_appraisal" }, req.id); throw new RangeError(`FNMA_F127_VALUATION_MAX_AGE_90: order a new valuation (as of ${m.valuation.as_of}, ${age} days old; confidence ${m.valuation.confidence ?? "n/a"})`); }
    const created = this.deps.smdu ? await this.deps.smdu.createCase(i.fnma_loan_number ?? i.loan_id, "FLEX_MOD_TPP", { waterfall: m.waterfall, valuation: m.valuation, mir_version: m.mod_interest_rate_version, delinquent_31_plus: m.delinquent_31_plus }) : null;
    const caseId = created?.caseId ?? `SMDU-TPP-${i.loan_id}`;
    this.emit("smdu.case.submitted", i.loan_id, { workout: "flex_mod_tpp", case_id: caseId, submitted_on: this.today(), partner_servicer_number: i.partner_servicer_number, valuation_id: m.valuation.source_doc ?? null }, req.id);
    this.patch(i.loan_id, { smdu_tpp_case_id: caseId });
    return { case_id: caseId, valuation_age_days: age };
  }

  // ---- the offer (D2-3.2-06; timers FNMA_B101_ESCROW_ESTABLISH_BEFORE_TRIAL, FNMA_D23206_TPP_FIRST_DUE_15TH_RULE, FNMA_D2205_EVAL_NOTICE_TPP_5)
  /**
   * Sends the Evaluation Notice (`NTC_FNMA_D23206_TPP_OFFER`) through the Notice Registry and records the trial plan:
   * 3 months (31+ days delinquent) or 4 (current / <31), first payment the 1st of the next month when the notice goes
   * out on or before the 15th, else the month after next; trial payment = estimated modified P&I + escrow (+ 60-month
   * shortage); effective the 1st of the month after the trial (or the second month under a written processing-month
   * policy). No TPP offer without a fresh valuation and a completed escrow analysis (guardrail; B-1-01).
   */
  async offerTpp(i: { loan_id: string; notice_sent_on: PlainDate; ti_monthly_cents: Cents; shortage_monthly_cents: Cents; escrow_analysis_on: PlainDate | null; escrow_established: boolean; processing_month?: boolean; notice?: NoticeInput | null }): Promise<{ trial: TrialPlan; notice_id: string | null }> {
    const m = this.require(i.loan_id);
    if (m.status !== "eligible" || !m.waterfall) throw new RangeError(`loan ${i.loan_id} is not an eligible Flex Modification (status ${m.status})`);
    if (!m.valuation || daysBetween(m.valuation.as_of, m.evaluation_date) > 90) throw new RangeError("FRESH_VALUATION: no TPP offer without a valuation ≤90 days old at evaluation (12.8 guardrail; F-1-27)");
    if (!i.escrow_analysis_on) throw new RangeError("FRESH_VALUATION: no TPP offer without an escrow analysis (12.8 guardrail; B-1-01)");
    const count = trialCount(m.delinquent_31_plus);
    const s = trialSchedule(i.notice_sent_on, count, i.ti_monthly_cents, i.shortage_monthly_cents, m.waterfall.pi_cents, i.processing_month === true);
    const trial: TrialPlan = { months: count, due_dates: s.due_dates, first_due: s.due_dates[0]!, trial_pi_cents: m.waterfall.pi_cents, trial_escrow_cents: i.ti_monthly_cents + i.shortage_monthly_cents, trial_total_cents: s.trial_payment_cents, effective: s.effective, capitalization_date: addMonths(s.effective, -1), form_3179_by: s.form_3179_by, incentive_deadline: s.incentive_deadline, processing_month: i.processing_month === true };
    const terms: ModTerms = { rate_pct: m.waterfall.rate_pct, term_months: m.waterfall.term_months, ib_upb_cents: m.waterfall.ib_upb_cents, forborne_cents: m.waterfall.forborne_cents, new_pi_cents: m.waterfall.pi_cents, effective_date: s.effective, maturity_date: addMonths(s.effective, m.waterfall.term_months - 1), capitalization_date: trial.capitalization_date };
    let noticeId: string | null = null;
    if (i.notice && this.deps.notices) {
      const n = this.deps.notices.render({ templateCode: TPP_OFFER_TEMPLATE, loanId: i.loan_id, recipients: i.notice.recipients, payload: { trial_count: count, trial_payment_cents: trial.trial_total_cents, pi_cents: trial.trial_pi_cents, escrow_cents: trial.trial_escrow_cents, due_dates: trial.due_dates, first_due: trial.first_due, effective: trial.effective, rate_pct: terms.rate_pct, term_months: terms.term_months, ib_upb_cents: terms.ib_upb_cents, forborne_cents: terms.forborne_cents, escrow_established: i.escrow_established, waterfall: { rate_pct: terms.rate_pct, term_months: terms.term_months, ib_upb_cents: terms.ib_upb_cents, forborne_cents: terms.forborne_cents, pi_cents: terms.new_pi_cents, trial_payment_cents: trial.trial_total_cents }, ...i.notice.payload }, asOf: i.notice_sent_on });
      const sent = await this.deps.notices.send(n.id); if (sent.status !== "sent") throw new RangeError(`Evaluation Notice ${n.id} not sent (${sent.status})`); noticeId = sent.id;
    }
    this.patch(i.loan_id, { status: "tpp_offered", trial, terms });
    this.emit("lossmit.tpp.offered", i.loan_id, { modification_id: m.id, template: TPP_OFFER_TEMPLATE, notice_id: noticeId, notice_sent_on: i.notice_sent_on, first_trial_due_date: trial.first_due, trial_months: count, trial_payment_cents: str(trial.trial_total_cents), effective_date: trial.effective, capitalization_date: trial.capitalization_date, escrow_established: i.escrow_established, escrow_analysis_on: i.escrow_analysis_on, processing_month: trial.processing_month });
    return { trial, notice_id: noticeId };
  }

  /** The trial schedule handed to cashiering (2.6 `startTrial`): one row per trial month — satisfies the 15th-rule row. */
  createTrialSchedule(loanId: string): { case_id: string; loan_id: string; months: { due_on: PlainDate; amount_cents: Cents }[]; effective: PlainDate } {
    const m = this.require(loanId); if (!m.trial) throw new RangeError("no trial plan offered");
    const months = m.trial.due_dates.map((d) => ({ due_on: d, amount_cents: m.trial!.trial_total_cents }));
    this.emit("lossmit.trial.schedule_created", loanId, { modification_id: m.id, case_id: m.case_id, first_due_date: m.trial.first_due, due_dates: m.trial.due_dates, months: m.trial.months, trial_payment_cents: str(m.trial.trial_total_cents), effective_date: m.trial.effective, capitalization_date: m.trial.capitalization_date });
    return { case_id: m.case_id, loan_id: loanId, months, effective: m.trial.effective };
  }

  /** Other acceptance items (§1024.41(e)(2)(ii)) arrive after the first trial payment — satisfies REGX_1024_41E2II_TRIAL_OTHER_REQS_REASONABLE once none are outstanding. */
  recordAcceptanceItems(loanId: string, items: readonly string[], receivedOn: PlainDate): { missing: string[] } {
    const m = this.require(loanId); const got = [...new Set([...m.acceptance_items_received, ...items])]; const missing = m.acceptance_items_required.filter((x) => !got.includes(x));
    this.patch(loanId, { acceptance_items_received: got });
    if (missing.length === 0) this.emit("lossmit.offer.acceptance_items.received", loanId, { modification_id: m.id, items: got, received_on: receivedOn });
    return { missing };
  }

  // ---- cashiering's trial events (2.6) → 12.8 milestones ------------------------------------------------------------
  private modFor(e: DomainEvent): FlexModification | null { const m = e.loanId ? this.mods.get(e.loanId) : null; if (!m || !m.trial) return null; const caseId = e.payload.case_id; return caseId === undefined || caseId === m.case_id ? m : null; }
  /** First trial payment = acceptance (D2-2-05); other acceptance items missing → the 14-day reasonable-period clock. */
  private onTrialPaymentReceived(e: DomainEvent): void {
    const m = this.modFor(e); if (!m || num(e.payload.trial_number) !== 1 || m.status !== "tpp_offered") return;
    const missing = m.acceptance_items_required.filter((x) => !m.acceptance_items_received.includes(x));
    this.patch(m.loan_id, { status: "tpp_active" });
    this.emit("lossmit.trial.first_payment_received", m.loan_id, { modification_id: m.id, case_id: m.case_id, payment_date: e.payload.received_on, acceptance: true, acceptance_items_missing: missing.length > 0, other_acceptance_items_missing: missing.length > 0, missing_items: missing }, e.id);
  }
  /** Penultimate month met → Form 3179 by the 1st of the final trial month; final month met → the payment side of servicer-execution readiness. */
  private onTrialPaymentSatisfied(e: DomainEvent): void {
    const m = this.modFor(e); if (!m) return; const n = num(e.payload.trial_number); const t = m.trial!;
    if (n === t.months - 1) { const finalStart = monthStart(t.due_dates[t.months - 1]!); this.emit("lossmit.trial.penultimate_payment_met", m.loan_id, { modification_id: m.id, case_id: m.case_id, trial_number: n, met_on: e.payload.received_on, final_trial_month_start: finalStart, final_due_date: t.due_dates[t.months - 1], effective_date: m.terms?.effective_date ?? t.effective, form_3179_by: finalStart }, e.id); }
    if (n === t.months) { const on = (e.payload.received_on as PlainDate | undefined) ?? this.today(); this.patch(m.loan_id, { final_trial_payment_cleared_at: on }); this.maybeExecutionReady(m.loan_id, e.id); }
  }
  /** All trial payments received by month-end → `tpp_completed{mbs}` (the MBS reclassification gate) and the incentive clock anchored on the final due month's end. */
  private onTrialCompleted(e: DomainEvent): void {
    const m = this.modFor(e); if (!m) return; const t = m.trial!; const finalDue = t.due_dates[t.months - 1]!;
    this.patch(m.loan_id, { status: m.mbs && !m.reclassified_at ? "reclass_pending" : m.form_3179_sent_at ? "docs_out" : "tpp_completed", final_trial_payment_cleared_at: m.final_trial_payment_cleared_at ?? finalDue });
    this.emit("lossmit.tpp.completed", m.loan_id, { modification_id: m.id, case_id: m.case_id, mbs: m.mbs, reclassified: m.reclassified_at !== null, effective_date: m.terms?.effective_date ?? t.effective, completed_on: this.today() }, e.id);
    this.emit("trial_plan_schedule.final_due_month_ended", m.loan_id, { modification_id: m.id, case_id: m.case_id, final_due_date: finalDue, final_due_month_end: endOfMonth(finalDue), incentive_deadline: t.incentive_deadline }, e.id);
    this.maybeExecutionReady(m.loan_id, e.id);
  }
  private onTrialFailed(e: DomainEvent): void {
    const m = this.modFor(e); if (!m) return;
    this.patch(m.loan_id, { status: "tpp_failed", last_trial_failed_on: (e.payload.failed_on as PlainDate | undefined) ?? this.today() });
    this.escalate("lossmit_reviewer", m.loan_id, { determination: "trial_failed", failed_on: e.payload.failed_on, notice: "NTC_FNMA_D23206_TPP_FAILED", no_new_trial_until: addMonths((e.payload.failed_on as PlainDate | undefined) ?? this.today(), 12) });
  }

  // ---- documents (F-1-27; timers SM_FORM3179_SEND_BY_LAST_TRIAL_MONTH_1, FNMA_D23206_FORM3179_*_EXECUTE_BEFORE_EFFECTIVE, FNMA_F127_CUSTODIAN_25)
  /** Form 3179 leaves on the template with catalog riders only (guardrail); `lossmit.agreement.sent{form=3179}` is the borrower-execution clock's trigger and the send-by row's satisfier. */
  sendForm3179(i: { loan_id: string; document_id: string; sent_on: PlainDate; riders?: readonly string[]; free_text_edits?: readonly string[]; channel?: "esign" | "mail" }): { effective_date: PlainDate; sent_on: PlainDate } {
    const m = this.require(i.loan_id); if (!m.terms || !m.trial) throw new RangeError("no trial plan / terms to document");
    if (!["tpp_active", "tpp_completed", "reclass_pending"].includes(m.status)) throw new RangeError(`Form 3179 is sent during or after a performing trial, not in status ${m.status}`);
    const chk = form3179Changes({ template: FORM_3179, riders: i.riders ?? [], ...(i.free_text_edits ? { free_text_edits: i.free_text_edits } : {}) }); if (!chk.allowed) throw new RangeError(`FORM_3179_TEMPLATE_ONLY: ${chk.refusal}`);
    this.patch(i.loan_id, { status: m.status === "tpp_completed" ? "docs_out" : m.status, form_3179_document_id: i.document_id, form_3179_sent_at: i.sent_on });
    this.emit("esign.sent", i.loan_id, { document_id: i.document_id, document: FORM_3179, channel: i.channel ?? "esign" });
    this.emit("lossmit.agreement.sent", i.loan_id, { form: "3179", document: FORM_3179, document_id: i.document_id, modification_id: m.id, channel: i.channel ?? "esign", sent_on: i.sent_on, effective_date: m.terms.effective_date, riders: i.riders ?? [], on_time: i.sent_on <= m.trial.form_3179_by });
    return { effective_date: m.terms.effective_date, sent_on: i.sent_on };
  }
  /** Inbound e-sign completion (vendor envelope): validated against the Form 3179 document sent, then the borrower-execution milestone. */
  esignCompleted(r: { loan_id: string; document_id: string; signed_on: PlainDate; envelope_id: string; audit_trail_id?: string | null }): FlexModification {
    const m = this.require(r.loan_id);
    if (!m.form_3179_document_id || m.form_3179_document_id !== r.document_id) throw new RangeError(`e-sign envelope ${r.envelope_id} is for document ${r.document_id}, not the Form 3179 sent (${m.form_3179_document_id ?? "none"})`);
    if (!m.form_3179_sent_at || r.signed_on < m.form_3179_sent_at) throw new RangeError(`signature date ${r.signed_on} precedes the Form 3179 send date ${m.form_3179_sent_at ?? "n/a"}`);
    const ev = this.emit("esign.completed", r.loan_id, { form: "3179", document: FORM_3179, document_id: r.document_id, signed_on: r.signed_on, envelope_id: r.envelope_id, audit_trail_id: r.audit_trail_id ?? null });
    return this.borrowerExecuted({ loan_id: r.loan_id, executed_on: r.signed_on, received_on: r.signed_on, basis: "esign" }, ev.id);
  }
  /** The executed agreement back from the borrower (e-sign or scanned mail return): the 25-day custodian clock runs from receipt (recorded: certified copy; unrecorded: original). */
  borrowerExecuted(i: { loan_id: string; executed_on: PlainDate; received_on: PlainDate; basis: "esign" | "scan" }, causationId?: string): FlexModification {
    const m = this.require(i.loan_id); if (!m.form_3179_sent_at) throw new RangeError("Form 3179 has not been sent");
    const rec = this.patch(i.loan_id, { borrower_executed_at: i.executed_on, executed_copy_received_at: i.received_on });
    this.emit("lossmit.agreement.executed_copy_received", i.loan_id, { form: "3179", document: FORM_3179, modification_id: m.id, executed_on: i.executed_on, received_on: i.received_on, basis: i.basis, custodian_document: m.recording_required ? "certified_copy" : "executed_original", recording_required: m.recording_required }, causationId);
    this.maybeExecutionReady(i.loan_id, causationId);
    return rec;
  }
  /** Servicer execution waits for (1) the borrower's executed agreement, (2) the final trial payment cleared and (3) reclassification for an MBS loan — one readiness event once all hold. */
  private maybeExecutionReady(loanId: string, causationId?: string): void {
    const m = this.require(loanId); if (m.execution_ready_event_id || !m.terms) return;
    const ready = m.borrower_executed_at !== null && m.final_trial_payment_cleared_at !== null && (!m.mbs || m.reclassified_at !== null);
    if (!ready) return;
    const ev = this.emit("lossmit.modification.execution_ready", loanId, { modification_id: m.id, borrower_executed: true, final_trial_payment_cleared: true, reclass_pending: false, mbs: m.mbs, effective_date: m.terms.effective_date, execute_by: addDays(m.terms.effective_date, -1) }, causationId);
    this.patch(loanId, { status: "borrower_executed", execution_ready_event_id: ev.id });
  }
  /** Inbound SMDU reclassification (A1-3-06 / D2-3.1-02): the MBS gate's satisfier; a reclassification on or after the effective date re-dates the modification to the next month. */
  smduReclassified(r: { loan_id: string; case_id: string; reclassified_on: PlainDate }): FlexModification {
    const m = this.require(r.loan_id); if (!m.mbs) throw new RangeError(`loan ${r.loan_id} is not an MBS loan — no reclassification expected`);
    if (m.smdu_tpp_case_id && r.case_id !== m.smdu_tpp_case_id) throw new RangeError(`SMDU case ${r.case_id} is not this modification's TPP case ${m.smdu_tpp_case_id}`);
    const ev = this.emit("smdu.case.reclassified", r.loan_id, { case_id: r.case_id, modification_id: m.id, reclassified_on: r.reclassified_on });
    let terms = m.terms;
    if (terms) { const g = mbsExecutionGate({ mbs: true, reclassified_on: r.reclassified_on, effective: terms.effective_date }); if (g.redated) { terms = { ...terms, effective_date: g.effective, capitalization_date: addMonths(g.effective, -1), maturity_date: addMonths(g.effective, terms.term_months - 1) }; this.emit("lossmit.modification.redated", r.loan_id, { modification_id: m.id, from: m.terms!.effective_date, to: g.effective, reason: "MBS reclassification after the effective date (processing-month policy)" }, ev.id); } }
    const rec = this.patch(r.loan_id, { reclassified_at: r.reclassified_on, terms, status: m.status === "reclass_pending" ? (m.borrower_executed_at ? "borrower_executed" : "tpp_completed") : m.status });
    this.maybeExecutionReady(r.loan_id, ev.id);
    return rec;
  }
  /** `signing_officer` executes and dates Form 3179 for the servicer/MERS (Officer Signature Date) — only once the three binding conditions hold and, for MBS, after reclassification. */
  servicerExecute(i: { loan_id: string; actor: Actor; officer_signature_date: PlainDate }): { effective_date: PlainDate; capitalization_date: PlainDate } {
    const m = this.require(i.loan_id); if (!m.terms) throw new RangeError("no terms to execute");
    if (i.actor.role !== "signing_officer") throw new RangeError("SIGNING_OFFICER_EXECUTES: Form 3179 is executed for the servicer/MERS by signing_officer (12.8 escalations)");
    const gate = mbsExecutionGate({ mbs: m.mbs, reclassified_on: m.reclassified_at, effective: m.terms.effective_date }); if (!gate.execution_allowed) throw new RangeError(gate.refusal!);
    const bind = bindingConditions({ tpp_completed: m.final_trial_payment_cleared_at !== null && ["tpp_completed", "docs_out", "borrower_executed"].includes(m.status), borrower_executed_on: m.borrower_executed_at, servicer_executed_on: i.officer_signature_date, servicer_role: "signing_officer" }); if (!bind.binding) throw new RangeError(`BINDING_CONDITIONS: ${bind.refusal}`);
    this.patch(i.loan_id, { status: "servicer_executed", servicer_executed_at: i.officer_signature_date, officer_signature_date: i.officer_signature_date });
    this.emit("lossmit.agreement.servicer_executed", i.loan_id, { form: "3179", document: FORM_3179, modification_id: m.id, officer_signature_date: i.officer_signature_date, executed_by_role: "signing_officer", executed_by: i.actor.id, effective_date: m.terms.effective_date, capitalization_date: m.terms.capitalization_date, mbs: m.mbs });
    return { effective_date: m.terms.effective_date, capitalization_date: m.terms.capitalization_date };
  }

  // ---- conversion (rule 7; timers FNMA_F127_CAPITALIZATION_DATE, FNMA_IRM_MOD_LOAN_DATA_CHANGE)
  /** Books the conversion through the kernel ledger on the capitalization date (effective − 1 month): the balanced set under `rule_ref 12.8.capitalization`, late charges waived, terms versioned. */
  bookConversion(i: { loan_id: string; inputs?: WaterfallInputs; late_charges_cents: Cents }): ReturnType<typeof postConversionLedger> & { loan_terms_version: string } {
    const m = this.require(i.loan_id); if (!this.deps.ledger) throw new RangeError("no ledger wired for the conversion posting");
    if (m.status !== "servicer_executed" || !m.terms || !m.waterfall_inputs) throw new RangeError(`conversion is booked after servicer execution (status ${m.status})`);
    const inputs = i.inputs ?? m.waterfall_inputs;
    const posted = postConversionLedger({ ledger: this.deps.ledger, events: this.events, actor: this.actor, now: this.clock.now() }, { ...inputs, loan_id: i.loan_id, late_charges_cents: i.late_charges_cents, effective: m.terms.effective_date, loan_data_change_acked: false, capitalization_on: m.terms.capitalization_date });
    const version = `${i.loan_id}@${m.terms.effective_date}`;
    const w = posted.conversion.loan_terms_version;
    this.patch(i.loan_id, { status: "booked", booked_set_id: posted.set.id, loan_terms_version: version, terms: { ...m.terms, rate_pct: w.rate_pct, term_months: w.term_months, ib_upb_cents: w.ib_upb_cents, forborne_cents: posted.conversion.forborne_principal_cents } });
    this.emit("loan_terms.versioned", i.loan_id, { version, effective_date: m.terms.effective_date, rate_pct: w.rate_pct, term_months: w.term_months, ib_upb_cents: str(w.ib_upb_cents), forborne_principal_nib_cents: str(posted.conversion.forborne_principal_cents), late_charges_waived_cents: str(posted.conversion.late_charges_waived_cents), next_due: posted.conversion.next_due, delinquency_reset: true });
    return { ...posted, loan_terms_version: version };
  }
  /** The effective date arrives: the canonical `lossmit.modification.effective` (once per modification) — the ledger/servicing moment that starts the 5.x loan-data-change clock. */
  modificationEffective(i: { loan_id: string; today: PlainDate; prior_terms_version?: string }): DomainEvent {
    const m = this.require(i.loan_id); if (!m.terms) throw new RangeError("no terms");
    if (m.effective_event_id) throw new RangeError(`lossmit.modification.effective already emitted for ${m.id} (${m.effective_event_id})`);
    if (m.status !== "booked") throw new RangeError(`the modification goes effective only once booked after servicer execution (status ${m.status})`);
    if (i.today < m.terms.effective_date) throw new RangeError(`effective date ${m.terms.effective_date} has not arrived (${i.today})`);
    const ev = this.emit("lossmit.modification.effective", i.loan_id, { loan_id: i.loan_id, modification_id: m.id, effective_date: m.terms.effective_date, rate_bps: rateBps(m.terms.rate_pct), term_months: m.terms.term_months, ib_upb_cents: str(m.terms.ib_upb_cents), forborne_cents: str(m.terms.forborne_cents), new_pi_cents: str(m.terms.new_pi_cents), maturity_date: m.terms.maturity_date, prior_terms_version: i.prior_terms_version ?? null, new_terms_version: m.loan_terms_version, mbs: m.mbs });
    this.emit("investor.loan_data_change.reported", i.loan_id, { modification_id: m.id, kind: "loan_data_change", lar: "83", effective_date: m.terms.effective_date, rate_bps: rateBps(m.terms.rate_pct), term_months: m.terms.term_months, nib_cents: str(m.terms.forborne_cents) }, ev.id);
    this.patch(i.loan_id, { status: "effective", effective_event_id: ev.id });
    return ev;
  }
  /** Inbound 5.x acknowledgement of the loan-data change (LAR 83): validated against the effective event before it satisfies `FNMA_IRM_MOD_LOAN_DATA_CHANGE`. */
  investorAckReceived(r: { loan_id: string; kind: string; accepted_on: PlainDate; reference?: string | null }): DomainEvent {
    const m = this.require(r.loan_id); if (r.kind !== "loan_data_change") throw new RangeError(`investor ack kind ${r.kind} is not a loan-data change`);
    if (!m.effective_event_id) throw new RangeError("no lossmit.modification.effective on this modification — nothing to acknowledge");
    return this.emit("investor.event.accepted", r.loan_id, { kind: "loan_data_change", modification_id: m.id, accepted_on: r.accepted_on, effective_date: m.terms?.effective_date ?? null, reference: r.reference ?? null }, m.effective_event_id);
  }

  // ---- recording and custody (F-1-27; timers FNMA_F127_RECORDED_ORIGINAL_5BD, FNMA_F127_CUSTODIAN_25)
  /** Inbound e-recording receipt: the recorded document back from the recorder starts the 5-business-day original-to-custodian clock. */
  erecordingReceived(r: { loan_id: string; document_id: string; recorded_on: PlainDate; received_on: PlainDate; instrument_number?: string | null }): DomainEvent {
    const m = this.require(r.loan_id); if (!m.recording_required) throw new RangeError(`loan ${r.loan_id}: recording not required for this modification`);
    if (m.form_3179_document_id !== r.document_id) throw new RangeError(`recorded document ${r.document_id} is not the executed Form 3179 (${m.form_3179_document_id ?? "none"})`);
    if (!m.servicer_executed_at || r.recorded_on < m.servicer_executed_at) throw new RangeError("a recording date before servicer execution is not this agreement's");
    this.patch(r.loan_id, { status: m.status === "effective" || m.status === "booked" ? "recorded" : m.status, recorded_at: r.recorded_on, recorded_original_received_at: r.received_on });
    return this.emit("erecording.recorded_document.received", r.loan_id, { document_id: r.document_id, document: FORM_3179, modification_id: m.id, recorded_on: r.recorded_on, received_on: r.received_on, instrument_number: r.instrument_number ?? null });
  }
  /** Inbound custodian confirmation: which copy the custodian confirms must match the modification's state (F-1-27: recorded → certified copy then the original; unrecorded → the fully executed original). */
  custodianDeliveryConfirmed(r: { loan_id: string; document: "certified_copy" | "recorded_original" | "executed_original"; confirmed_on: PlainDate; receipt_id: string }): DomainEvent {
    const m = this.require(r.loan_id);
    if (!m.executed_copy_received_at) throw new RangeError("nothing to deliver: the executed agreement has not come back from the borrower");
    if (r.document === "certified_copy" && !m.recording_required) throw new RangeError("a certified copy is delivered only for a recorded agreement (F-1-27)");
    if (r.document === "executed_original" && m.recording_required) throw new RangeError("a recorded agreement goes to the custodian as a certified copy, then the recorded original (F-1-27)");
    if (r.document === "recorded_original" && !m.recorded_original_received_at) throw new RangeError("the recorded original has not been received from the recorder");
    const deliveries = [...m.custodian_deliveries, { document: r.document, on: r.confirmed_on }];
    const complete = m.recording_required ? deliveries.some((d) => d.document === "recorded_original") : deliveries.some((d) => d.document === "executed_original");
    this.patch(r.loan_id, { custodian_deliveries: deliveries, custodian_delivered_at: complete ? r.confirmed_on : m.custodian_delivered_at, status: complete && ["effective", "recorded"].includes(m.status) ? "custodian_delivered" : m.status });
    return this.emit("custodian.delivery.confirmed", r.loan_id, { document: r.document, modification_id: m.id, confirmed_on: r.confirmed_on, receipt_id: r.receipt_id, complete });
  }

  // ---- SMDU reporting and the incentive (F-1-22, F-2-02; timers FNMA_F122_TPP_PAYMENT_REPORT, FNMA_F202_FLEX_CLOSE_2M)
  /** Inbound SMDU acknowledgement of a TPP_PAYMENT report (satisfies the 1-BD "upon receipt" reporting clock). */
  smduTppPaymentAcked(r: { loan_id: string; case_id: string; trial_number: number; acked_on: PlainDate }): DomainEvent {
    const m = this.require(r.loan_id); if (m.smdu_tpp_case_id && r.case_id !== m.smdu_tpp_case_id) throw new RangeError(`SMDU case ${r.case_id} is not this modification's TPP case ${m.smdu_tpp_case_id}`);
    if (!m.trial || r.trial_number < 1 || r.trial_number > m.trial.months) throw new RangeError(`trial payment ${r.trial_number} is outside the ${m.trial?.months ?? 0}-month plan`);
    return this.emit("smdu.tpp_payment.acked", r.loan_id, { case_id: r.case_id, modification_id: m.id, trial_number: r.trial_number, acked_on: r.acked_on });
  }
  /** Inbound SMDU close (MOD_CLOSING with the Officer Signature Date): satisfies the close clock and decides the $1,000 incentive (two months from the last day of the final trial month; later → no claim, sev-3). */
  smduCaseClosed(r: { loan_id: string; case_id: string; closed_on: PlainDate; officer_signature_date: PlainDate }): { event: DomainEvent; incentive: ReturnType<typeof flexIncentive> } {
    const m = this.require(r.loan_id); if (!m.trial) throw new RangeError("no trial plan");
    if (!m.officer_signature_date || r.officer_signature_date !== m.officer_signature_date) throw new RangeError(`SMDU close carries Officer Signature Date ${r.officer_signature_date}; the executed agreement is dated ${m.officer_signature_date ?? "not yet"}`);
    const inc = flexIncentive({ final_trial_due_on: m.trial.due_dates[m.trial.months - 1]!, smdu_closed_on: r.closed_on });
    const event = this.emit("smdu.case.closed", r.loan_id, { case_id: r.case_id, modification_id: m.id, closed_on: r.closed_on, officer_signature_date: r.officer_signature_date, incentive_deadline: inc.deadline, incentive_claim_cents: str(inc.claim_cents) });
    const claimId = inc.claimed ? `inc-${m.id}` : null;
    if (inc.claimed) this.emit("investor.incentive.claim_prepared", r.loan_id, { modification_id: m.id, claim_id: claimId, kind: "incentive", workout: "flex_mod", amount_cents: str(inc.claim_cents), closed_on: r.closed_on }, event.id);
    else if (inc.escalation) this.escalate("officer", r.loan_id, { reason: inc.escalation.reason, closed_on: r.closed_on, deadline: inc.deadline }, inc.escalation.severity);
    this.patch(r.loan_id, { smdu_close_case_id: r.case_id, incentive_claim_id: claimId });
    return { event, incentive: inc };
  }
  /** The file is complete — executed by both parties, recorded where required, at the custodian, booked and effective: the second canonical event, once. */
  modificationCompleted(i: { loan_id: string; completed_on: PlainDate }): DomainEvent {
    const m = this.require(i.loan_id); if (m.completed_event_id) throw new RangeError(`lossmit.modification.completed already emitted for ${m.id}`);
    const missing = [!m.effective_event_id && "not effective", !m.borrower_executed_at && "borrower execution", !m.servicer_executed_at && "servicer execution", m.recording_required && !m.recorded_at && "recording", !m.custodian_delivered_at && "custodian delivery"].filter(Boolean);
    if (missing.length) throw new RangeError(`modification not complete: ${missing.join(", ")}`);
    const ev = this.emit("lossmit.modification.completed", i.loan_id, { loan_id: i.loan_id, modification_id: m.id, effective_date: m.terms!.effective_date, rate_bps: rateBps(m.terms!.rate_pct), term_months: m.terms!.term_months, ib_upb_cents: str(m.terms!.ib_upb_cents), forborne_cents: str(m.terms!.forborne_cents), new_pi_cents: str(m.terms!.new_pi_cents), maturity_date: m.terms!.maturity_date, mbs: m.mbs, completed_at: i.completed_on, borrower_executed_at: m.borrower_executed_at, servicer_executed_at: m.servicer_executed_at, recorded_at: m.recorded_at, custodian_delivered_at: m.custodian_delivered_at, incentive_claim_id: m.incentive_claim_id }, m.effective_event_id!);
    this.patch(i.loan_id, { status: "completed", completed_at: i.completed_on, completed_event_id: ev.id });
    return ev;
  }
}
