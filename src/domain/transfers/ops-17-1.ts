/**
 * §17.1 operating rules over the §1.2/§17.1 calculators in batch.ts and the
 * loan-list mechanics in inbound.ts: the transfer-out state machine
 * (`proposeBatch` asserting FNMA_A2_7_03_TRANSFER_DATE_GATE, T2; every
 * `transfer.batch.*{direction=out}` transition with the spec's evidence guards),
 * the termination/notice intake (A1-2-01, A1-2-02, A1-4.1-02, A2-1-01), the CD20
 * Quick Exchange reconciliation and the attestation block it enforces (T4), the
 * loan-list versions (CD10 rule), the `master_change_sub_retained` goodbye
 * exclusion (T5), the payoff after CD25 attestation (T8), the Bulletin 2020-02
 * transfer plan, the Form 629 template validation, the Custodian Matrix
 * selection, the deadline table the `transfer` agent files (T1/T3/T6/T7), the
 * approval-letter parse, the Form 101 termination, the BD3 Connect confirmation,
 * the partner-scoped credential revocation, the termination-portfolio scope, the
 * partner notification (no borrower contact) and the decision record shape.
 * Inbound facts the timers key on are ingested here too: the EscalationService's
 * `escalation.created{kind=human_portal_task, task=form629}` (SM_PORTAL_TASK_FORM629_SLA_2,
 * `form629PortalTaskOpened`) and the partner's 18.4 Form 582 filing that no longer lists
 * Supermortgage (`form582TerminationReflected` → `form582.submitted{subservicer_removed}`).
 *
 * Two §1.2 calculators in batch.ts are wrong for transfer-out and are corrected
 * here rather than reused: `quickExchangeCadence` takes the month of
 * `transfer_date − 1` (the transfer month itself whenever the first Fannie Mae
 * business day is not the 1st, e.g. Nov 2, 2026) where the spec anchors
 * CD10/CD20/CD25 on the month *before* `transfer_date`; `form629Clocks` files
 * `fnma_directed` on the transfer date itself where the registry row puts it
 * under the 60-day servicing rule unless Fannie Mae's instructions govern.
 */
import { type PlainDate, addDays, addMonths, addYears, endOfMonth, parts, ymd } from "../../kernel/calendar/date.ts";
import { addBusinessDays, rollBack, fannieEt, servicer } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { fannieBusinessDay } from "../investor/period.ts";
import { type TransferType, firstFannieBusinessDay, transferDateGate, respaNoticeRequired, form101TerminationDue, saleArrangementDue, portalTaskEscalation } from "./batch.ts";
import { masterServicerOnlyExclusion, attestList, attestationSatisfies, type LoanListVersion } from "./inbound.ts";

export type TerminationBasis = "partner_instruction" | "fnma_without_cause" | "fnma_for_cause" | "partner_voluntary_termination" | "supermortgage_exit" | "sale";
export type OffboardingStatus = "listed" | "frozen" | "packaged" | "cutover" | "support_window" | "retained" | "withdrawn";
/** Quick Exchange request statuses (Servicing Transfers User Guide), mirrored on `transfer_batches.qx_status`. */
export const QX_STATUSES = ["New", "Pending Servicing Transfer Review", "Pending Servicing Transfer Analysis", "Pending Internal Sign Off", "Pending Final Approval", "Approval Letters Sent", "Denied", "Cancelled"] as const;
export type QxStatus = (typeof QX_STATUSES)[number];
/** Termination bases whose clocks live on the partner subject (A1-2-01, A1-2-02, A1-4.1-02) and whose portfolio scope is the partner's: a batch under them names its partner. */
export const PARTNER_SUBJECT_BASES: readonly TerminationBasis[] = ["fnma_without_cause", "fnma_for_cause", "partner_voluntary_termination", "supermortgage_exit"];
export const FNMA_SERVICING_TRANSFERS_MAILBOX = "servicing_transfers@fanniemae.com";
export const FNMA_TECHNOLOGY_REGISTRATION_MAILBOX = "Technology_Registration@fanniemae.com";
const isOfficer = (a: Actor | null | undefined): a is Actor => !!a && a.kind === "human" && a.role === "officer";
/** A domain event the tool layer appends verbatim (`ctx.events.append({ type, aggregate, actor, payload })`). */
export interface OutEvent { readonly type: string; readonly payload: Record<string, unknown>; /** Defaults to the batch aggregate; partner-scoped companions (`partner.transfer_batch.*`) name the partner so partner-level timers (A1-2-01, A1-2-02) can be satisfied on their own subject. */ readonly aggregate?: { readonly kind: string; readonly id: string }; }

// ============================================================ corrected §1.2 calculators (see the file comment)
/** Fannie Mae's termination/transfer instructions recorded on the batch (`fnma_directed`): the dates the letter names, else immediate effect from `received_on`. */
export interface FnmaInstruction { readonly received_on: PlainDate; readonly transfer_date?: PlainDate | null; readonly form629_by?: PlainDate | null; readonly loan_list_by?: PlainDate | null; readonly for_cause?: boolean; }
export type Form629Rule = "30_day_subservicing" | "60_day_servicing" | "fnma_instruction";
/** Form 629 clocks for transfer-out: 30 days (sub_to_sub/sub_to_master), 60 days from the earlier of sale/transfer date (servicing_sale, master_change_sub_retained, fnma_directed — registry row FNMA_A2_7_03_FORM629_SERVICING_60), or Fannie Mae's instruction when one governs. */
export function form629ClocksOut(type: TransferType, transferDate: PlainDate, saleDate?: PlainDate | null, instruction?: FnmaInstruction | null): { deadline: PlainDate; internal_buffer: PlainDate; anchor_date: PlainDate; rule: Form629Rule; liability_start: PlainDate } {
  const liability = saleDate && saleDate < transferDate ? saleDate : transferDate;
  if (type === "fnma_directed" && instruction) { const d = instruction.form629_by ?? instruction.received_on; return { deadline: d, internal_buffer: d, anchor_date: instruction.received_on, rule: "fnma_instruction", liability_start: liability }; }
  if (type === "servicing_sale" || type === "servicing_sale_with_sub" || type === "master_change_sub_retained" || type === "fnma_directed") { const d = addDays(liability, -60); return { deadline: d, internal_buffer: addDays(d, -7), anchor_date: liability, rule: "60_day_servicing", liability_start: liability }; }
  const d = addDays(transferDate, -30); return { deadline: d, internal_buffer: addDays(d, -7), anchor_date: transferDate, rule: "30_day_subservicing", liability_start: liability };
}
export interface QxCadence { readonly adds_by: PlainDate; readonly reconciliation_by: PlainDate; readonly attestation_by: PlainDate; readonly processing_on: PlainDate; readonly portal_task_on: PlainDate; readonly portal_task_sla_due: PlainDate; }
/** Quick Exchange cadence: CD10 additions, CD20 reconciliation, CD25 attestation (prior Fannie Mae business day if weekend/holiday) of the month before `transfer_date`; processing on BD3 of the transfer month; the Form 629 portal task the last servicer business day before the Form 629 deadline, its SLA +2 servicer business days from creation (SM_PORTAL_TASK_FORM629_SLA_2). */
export function quickExchangeCadenceOut(transferDate: PlainDate, form629Deadline?: PlainDate | null): QxCadence {
  const t = parts(transferDate);
  const { y, m } = parts(addMonths(ymd(t.y, t.m, 1), -1));
  const cd = (d: number) => ymd(y, m, d);
  const portalTaskOn = addBusinessDays(form629Deadline ?? addDays(transferDate, -30), -1, servicer);
  return { adds_by: cd(10), reconciliation_by: cd(20), attestation_by: rollBack(cd(25), fannieEt), processing_on: fannieBusinessDay(transferDate, 3), portal_task_on: portalTaskOn, portal_task_sla_due: portalTaskEscalation(portalTaskOn) };
}

// ============================================================ transfer-out state machine (`transfer_batches.status`, case_type='transfer_out')
export type TransferOutStatus = "proposed" | "plan_approved" | "package_ready" | "submitted" | "info_requested" | "approved" | "loan_list_frozen" | "notice_window" | "pre_cutover" | "cutover" | "post_transfer" | "retention" | "closed" | "denied" | "withdrawn" | "on_hold";
const NEXT_OUT: Record<TransferOutStatus, readonly TransferOutStatus[]> = {
  proposed: ["plan_approved", "withdrawn"], plan_approved: ["package_ready", "withdrawn"], package_ready: ["submitted", "withdrawn"],
  submitted: ["info_requested", "approved", "denied", "on_hold", "withdrawn"], info_requested: ["submitted", "denied", "withdrawn"],
  approved: ["loan_list_frozen", "on_hold", "withdrawn"], loan_list_frozen: ["notice_window", "on_hold"], notice_window: ["pre_cutover", "on_hold"], pre_cutover: ["cutover", "on_hold"],
  cutover: ["post_transfer"], post_transfer: ["retention"], retention: ["closed"], closed: [], denied: [], withdrawn: [],
  on_hold: ["submitted", "approved", "loan_list_frozen", "notice_window", "pre_cutover", "withdrawn"],
};
/** The event each transition emits (`transfer.batch.*{direction=out}`); cutover → post_transfer is `cutover_completed` (the fact the termination timers key on). */
export const TRANSFER_OUT_EVENT: Record<Exclude<TransferOutStatus, "proposed">, string> = {
  plan_approved: "transfer.batch.plan_approved", package_ready: "transfer.batch.package_ready", submitted: "transfer.batch.submitted", info_requested: "transfer.batch.info_requested", approved: "transfer.batch.approved",
  loan_list_frozen: "transfer.batch.loan_list_frozen", notice_window: "transfer.batch.notice_window", pre_cutover: "transfer.batch.pre_cutover", cutover: "transfer.batch.cutover", post_transfer: "transfer.batch.cutover_completed",
  retention: "transfer.batch.retention", closed: "transfer.batch.closed", denied: "transfer.batch.denied", withdrawn: "transfer.batch.withdrawn", on_hold: "transfer.batch.on_hold",
};
export interface TransferOutBatch {
  readonly batch_id: string; readonly partner_id: string | null; readonly case_type: "transfer_out"; readonly direction: "out"; readonly status: TransferOutStatus;
  readonly transfer_type: TransferType; readonly transfer_date: PlainDate; readonly sale_date: PlainDate | null; readonly termination_basis: TerminationBasis | null;
  readonly transferee_servicer_number: string | null; readonly loan_count: number; readonly first_batch_for_partner: boolean; readonly last_batch_for_partner: boolean; readonly supermortgage_is_tech_provider: boolean;
  readonly fnma_instruction: FnmaInstruction | null; readonly anchor_basis: "transfer_date" | "fnma_instruction";
  readonly form629_rule: Form629Rule; readonly form629_deadline: PlainDate; readonly form629_anchor_date: PlainDate; readonly liability_start_date: PlainDate;
  readonly qx_request_id: string | null; readonly qx_status: QxStatus | null; readonly d_code: string | null; readonly approval_on: PlainDate | null; readonly attested_at: PlainDate | null; readonly held_from: TransferOutStatus | null;
}
export interface ProposeInput {
  readonly batch_id: string; readonly partner_id?: string | null; readonly transfer_type: TransferType; readonly transfer_date: PlainDate; readonly sale_date?: PlainDate | null; readonly termination_basis?: TerminationBasis | null;
  readonly transferee_servicer_number?: string | null; readonly loan_count?: number; readonly first_batch_for_partner?: boolean; readonly last_batch_for_partner?: boolean; readonly supermortgage_is_tech_provider?: boolean;
  readonly fnma_instruction?: FnmaInstruction | null; readonly source: "partner_instruction" | "fnma_termination_notice" | "supermortgage_exit"; readonly proposed_on?: PlainDate | null;
}
/** `proposeBatch`: the transfer date must be the first `business_days_fannie_et` of the month (FNMA_A2_7_03_TRANSFER_DATE_GATE, command rejected — T2) unless Fannie Mae's instruction sets it; emits `transfer.batch.proposed{direction=out}` carrying every timer anchor. */
export function proposeBatch(i: ProposeInput): { batch: TransferOutBatch; event: OutEvent & { type: "transfer.batch.proposed" }; events: OutEvent[] } {
  if (i.transfer_type === "master_to_sub" || i.transfer_type === "custodian_only") throw new RangeError(`${i.transfer_type} is not a transfer-out type (§1.2 boards it)`);
  const instruction = i.transfer_type === "fnma_directed" ? (i.fnma_instruction ?? null) : null;
  const transferDate = instruction?.transfer_date ?? i.transfer_date;
  const gate = transferDateGate(transferDate);
  if (!gate.ok && !instruction) throw new RangeError(`FNMA_A2_7_03_TRANSFER_DATE_GATE: ${transferDate} is not the first Fannie Mae business day of the month (expected ${gate.expected}) — command rejected (A2-7-03)`);
  if (i.transferee_servicer_number && !/^\d{9}$/.test(i.transferee_servicer_number)) throw new RangeError("transferee servicer number must be 9 digits");
  if (!i.partner_id && (i.source === "fnma_termination_notice" || (i.termination_basis && PARTNER_SUBJECT_BASES.includes(i.termination_basis)))) throw new RangeError(`partner_id is required for a ${i.termination_basis ?? i.source} batch: the A1-2-01/A1-2-02 clocks and the termination-portfolio scope are the partner's`);
  const clocks = form629ClocksOut(i.transfer_type, transferDate, i.sale_date ?? null, instruction);
  const techNotice = (i.supermortgage_is_tech_provider ?? false) && (i.loan_count ?? 0) >= 20_000;   // A2-1-01: portfolios ≥20,000 loans
  const batch: TransferOutBatch = {
    batch_id: i.batch_id, partner_id: i.partner_id ?? null, case_type: "transfer_out", direction: "out", status: "proposed", transfer_type: i.transfer_type, transfer_date: transferDate, sale_date: i.sale_date ?? null, termination_basis: i.termination_basis ?? null,
    transferee_servicer_number: i.transferee_servicer_number ?? null, loan_count: i.loan_count ?? 0, first_batch_for_partner: i.first_batch_for_partner ?? false, last_batch_for_partner: i.last_batch_for_partner ?? false, supermortgage_is_tech_provider: i.supermortgage_is_tech_provider ?? false,
    fnma_instruction: instruction, anchor_basis: instruction ? "fnma_instruction" : "transfer_date", form629_rule: clocks.rule, form629_deadline: clocks.deadline, form629_anchor_date: clocks.anchor_date, liability_start_date: clocks.liability_start,
    qx_request_id: null, qx_status: null, d_code: null, approval_on: null, attested_at: null, held_from: null,
  };
  // the event states the facts as they are: who the technology provider is, and separately whether A2-1-01's ≥20,000-loan notice applies (FNMA_A2_1_01_TECH_PROVIDER_NOTICE_180 arms on `tech_provider_notice_required`)
  const payload = { ...batchFacts(batch), source: i.source, proposed_on: i.proposed_on ?? null, form629_deadline: clocks.deadline, form629_anchor_date: clocks.anchor_date, form629_rule: clocks.rule, liability_start_date: clocks.liability_start, supermortgage_is_tech_provider: batch.supermortgage_is_tech_provider, tech_provider_notice_required: techNotice, fnma_instruction: instruction };
  const event = { type: "transfer.batch.proposed" as const, payload };
  return { batch, event, events: [event, ...partnerCompanion(batch, "proposed", payload)] };
}
/** Partner-scoped companion of a batch event, for the timers whose subject is the partner (FNMA_A1_2_02_SALE_ARRANGEMENT_90 ← `partner.transfer_batch.proposed{type=servicing_sale}`, FNMA_A1_2_01_VOLUNTARY_TERMINATION_EFFECTIVE ← `partner.transfer_batch.cutover_completed{last_batch_for_partner=true}`). */
const PARTNER_COMPANION = { proposed: "partner.transfer_batch.proposed", cutover_completed: "partner.transfer_batch.cutover_completed" } as const;
function partnerCompanion(b: TransferOutBatch, fact: keyof typeof PARTNER_COMPANION, payload: Record<string, unknown>): OutEvent[] {
  return b.partner_id ? [{ type: PARTNER_COMPANION[fact], aggregate: { kind: "partner", id: b.partner_id }, payload: { ...payload, partner_id: b.partner_id } }] : [];
}
function batchFacts(b: TransferOutBatch): Record<string, unknown> {
  return { batch_id: b.batch_id, partner_id: b.partner_id, direction: "out", type: b.transfer_type, transfer_type: b.transfer_type, transfer_date: b.transfer_date, sale_date: b.sale_date, termination_basis: b.termination_basis, loan_count: b.loan_count, first_batch_for_partner: b.first_batch_for_partner, last_batch_for_partner: b.last_batch_for_partner, transferee_servicer_number: b.transferee_servicer_number, anchor_basis: b.anchor_basis, qx_status: b.qx_status };
}
export interface TransitionEvidence {
  readonly actor?: Actor | null;
  readonly form629_document_id?: string | null; readonly custodian_matrix_document_id?: string | null; readonly loan_list_version?: number | null; readonly subservicer_answer_recorded?: boolean; readonly special_notifications_listed?: boolean; readonly form101_termination_draft_document_id?: string | null;
  readonly portal_completion_record_id?: string | null; readonly qx_request_id?: string | null;
  readonly approval_letter_document_hash?: string | null; readonly d_code?: string | null; readonly consent_conditions?: readonly string[]; readonly officer_confirmed_conditions?: boolean;
  readonly attested_version?: LoanListVersion | null;
  readonly goodbye_run_status?: "planned" | "complete" | "excluded" | null; readonly preliminary_tape_acknowledged?: boolean;
  readonly final_tape_delivered?: boolean; readonly trial_balance_delivered?: boolean; readonly funds_wired?: boolean; readonly payment_holds_set?: boolean; readonly final_accounting_delivered?: boolean; readonly retention_window_ended?: boolean;
  readonly partner_decision_id?: string | null; readonly new_transfer_date?: PlainDate | null; readonly partner_next_form582_due_on?: PlainDate | null;
  /** Every transfer_out batch of the partner (the store's rows): `last_batch_for_partner` is measured from them at each transition, never remembered from the proposal. */
  readonly partner_batches?: readonly { readonly batch_id: string; readonly status: string }[];
  /** The Quick Exchange status the e-mail reports (validated against QX_STATUSES). */
  readonly qx_status?: QxStatus | null;
}
/** Why a transfer-out transition is refused, or null when the spec's guard is met. */
export function transferOutTransitionBlock(b: TransferOutBatch, to: TransferOutStatus, ev: TransitionEvidence, on: PlainDate): string | null {
  if (!NEXT_OUT[b.status].includes(to)) return `no transition ${b.status} → ${to}`;
  if (b.status === "on_hold" && to !== "withdrawn" && b.held_from !== to) return `on_hold resumes at ${b.held_from ?? "?"}, not ${to}`;
  if (ev.qx_status && !QX_STATUSES.includes(ev.qx_status)) return `"${String(ev.qx_status)}" is not a Quick Exchange status (${QX_STATUSES.join(" → ")})`;
  switch (to) {
    case "plan_approved": return isOfficer(ev.actor) ? null : "plan approval is a partner officer act (Bulletin 2020-02)";
    case "package_ready": {
      if (!b.fnma_instruction && !transferDateGate(b.transfer_date).ok) return "FNMA_A2_7_03_TRANSFER_DATE_GATE: transfer date is not the first Fannie Mae business day of the month";
      if (!ev.form629_document_id) return "Form 629 Excel not attached";
      if (!ev.custodian_matrix_document_id) return "Custodian Matrix not attached";
      if (!ev.loan_list_version) return "loan list missing";
      if (ev.subservicer_answer_recorded !== true) return "subservicer answer (\"Will a subservicer be used by the transferee?\") not recorded";
      if (ev.special_notifications_listed !== true) return "special notifications list (eMortgages, resale-restricted loans) missing";
      if (b.last_batch_for_partner && !ev.form101_termination_draft_document_id) return "Form 101 termination draft missing (last batch for the partner)";
      return null;
    }
    case "submitted": if (b.status === "package_ready" && !ev.portal_completion_record_id) return "submitted requires a portal completion record (fnma_portal_operator / partner user)"; if (b.status === "package_ready" && !(ev.qx_request_id ?? b.qx_request_id)) return "submitted requires the Quick Exchange request ID"; return null;
    case "approved": {
      if (b.status === "on_hold") return null;
      if (!isOfficer(ev.actor)) return "approved requires the partner officer's confirmation of the D-Code and acceptance of any conditions (the agent parses the letter; the officer confirms before `approved`)";
      if (!ev.approval_letter_document_hash) return "approved requires the approval-letter hash";
      if (!(ev.d_code ?? b.d_code)) return "approved requires the D-Code";
      if ((ev.consent_conditions?.length ?? 0) > 0 && ev.officer_confirmed_conditions !== true) return "consent carries conditions: the partner officer must accept them before approved";
      return null;
    }
    case "loan_list_frozen": return b.status === "on_hold" || (ev.attested_version && attestationSatisfies(ev.attested_version)) ? null : "loan_list_frozen requires the attestation evidence (Quick Exchange \"Agree\" by the partner officer)";
    case "notice_window": return b.status === "on_hold" || ev.goodbye_run_status ? null : "notice_window requires the 17.2 goodbye run (or the §1024.33(b)(2)(i)(C) exclusion record)";
    case "cutover": {
      if (on < b.transfer_date) return `servicing may not stop ${on}, before the approved transfer date ${b.transfer_date} (A2-7-03 unauthorized transfers are not recognized)`;
      if (!b.d_code) return "cutover requires Fannie Mae's approval (D-Code) on the batch";
      if (ev.goodbye_run_status !== "complete" && ev.goodbye_run_status !== "excluded") return "cutover requires the 17.2 goodbye run `complete`";
      if (ev.preliminary_tape_acknowledged !== true) return "cutover requires the 17.3 preliminary tape acknowledged";
      return null;
    }
    case "post_transfer": { const missing = (["final_tape_delivered", "trial_balance_delivered", "funds_wired", "payment_holds_set"] as const).filter((k) => ev[k] !== true); return missing.length ? `cutover incomplete: ${missing.join(", ")}` : null; }
    case "retention": return ev.final_accounting_delivered === true ? null : "retention requires the 30-day final accounting delivered (17.3)";
    case "closed": return ev.retention_window_ended === true || on >= addYears(b.transfer_date, 1) ? null : `closed requires the one-year NoE/RFI window to end (${addYears(b.transfer_date, 1)})`;
    case "denied": return ev.partner_decision_id ? null : "denied is terminal and requires the partner decision record";
    case "on_hold": { const d = ev.new_transfer_date; if (!d) return "on_hold requires the re-based transfer date (Fannie Mae's longer timeframe)"; if (d <= b.transfer_date) return `re-based transfer date ${d} must be later than ${b.transfer_date}`; return transferDateGate(d).ok ? null : `re-based transfer date ${d} is not a first Fannie Mae business day (expected ${transferDateGate(d).ok ? d : (transferDateGate(d) as { expected: PlainDate }).expected})`; }
    default: return null;
  }
}
/** Apply a transition; returns the batch and the `transfer.batch.*` events (on_hold also emits `transfer.batch.date_changed` so 17.2 re-issues its notices). Throws RangeError on a blocked transition. */
export function transitionTransferOut(b: TransferOutBatch, to: TransferOutStatus, ev: TransitionEvidence, on: PlainDate): { batch: TransferOutBatch; events: OutEvent[] } {
  const block = transferOutTransitionBlock(b, to, ev, on);
  if (block) throw new RangeError(block);
  const lastBatch = ev.partner_batches ? lastBatchForPartner(b, ev.partner_batches) : b.last_batch_for_partner;
  let next: TransferOutBatch = { ...b, status: to, held_from: to === "on_hold" ? b.status : null, last_batch_for_partner: lastBatch, qx_status: ev.qx_status ?? b.qx_status };
  const base = { ...batchFacts(next), status: b.status, from: b.status, to, on };
  const events: OutEvent[] = [];
  switch (to) {
    case "submitted": next = { ...next, qx_request_id: ev.qx_request_id ?? b.qx_request_id, qx_status: ev.qx_status ?? (b.status === "package_ready" ? "New" : b.qx_status) }; events.push({ type: TRANSFER_OUT_EVENT.submitted, payload: { ...base, qx_status: next.qx_status, qx_request_id: next.qx_request_id, portal_completion_record_id: ev.portal_completion_record_id ?? null } }); break;
    case "approved": {
      if (b.status === "on_hold") { events.push({ type: "transfer.batch.resumed", payload: { ...base } }); break; }
      const qx = quickExchangeCadenceOut(b.transfer_date, b.form629_deadline);
      next = { ...next, d_code: ev.d_code ?? b.d_code, approval_on: on, qx_status: "Approval Letters Sent" };
      events.push({ type: TRANSFER_OUT_EVENT.approved, payload: { ...base, qx_status: next.qx_status, approval_on: on, d_code: next.d_code, approval_letter_document_hash: ev.approval_letter_document_hash, consent_conditions: [...(ev.consent_conditions ?? [])], loan_list_adds_by: qx.adds_by, loan_list_reconciliation_by: qx.reconciliation_by, loan_list_freeze_on: qx.attestation_by, fnma_processing_on: qx.processing_on } });
      break;
    }
    case "loan_list_frozen": if (b.status === "on_hold") { events.push({ type: "transfer.batch.resumed", payload: { ...base } }); break; } next = { ...next, attested_at: on }; events.push({ type: TRANSFER_OUT_EVENT.loan_list_frozen, payload: { ...base, attested_version: ev.attested_version!.version, attested_by: ev.attested_version!.attested_by ?? null, attested_at: on } }); break;
    case "post_transfer": { const payload = { ...base, cutover_on: on, fnma_processing_on: quickExchangeCadenceOut(b.transfer_date, b.form629_deadline).processing_on, payment_window_end: addDays(b.transfer_date, 60), final_accounting_by: addDays(b.transfer_date, 30) }; events.push({ type: TRANSFER_OUT_EVENT.post_transfer, payload }, ...partnerCompanion(b, "cutover_completed", payload)); break; }
    case "closed": events.push({ type: TRANSFER_OUT_EVENT.closed, payload: { ...base, closed_on: on, partner_next_form582_due_on: ev.partner_next_form582_due_on ?? null } }); break;
    case "denied": next = { ...next, qx_status: "Denied" }; events.push({ type: TRANSFER_OUT_EVENT.denied, payload: { ...base, qx_status: next.qx_status, partner_decision_id: ev.partner_decision_id } }); break;
    case "withdrawn": next = { ...next, qx_status: b.qx_request_id ? "Cancelled" : b.qx_status }; events.push({ type: TRANSFER_OUT_EVENT.withdrawn, payload: { ...base, qx_status: next.qx_status } }); break;
    case "on_hold": next = { ...next, transfer_date: ev.new_transfer_date! }; events.push({ type: TRANSFER_OUT_EVENT.on_hold, payload: { ...base, held_from: b.status, new_transfer_date: ev.new_transfer_date, timers: "re-issued from the re-based transfer date" } }, { type: "transfer.batch.date_changed", payload: { ...base, original_transfer_date: b.transfer_date, new_transfer_date: ev.new_transfer_date } }); break;
    default: if (b.status === "on_hold") events.push({ type: "transfer.batch.resumed", payload: { ...base } }); else events.push({ type: TRANSFER_OUT_EVENT[to as Exclude<TransferOutStatus, "proposed">], payload: { ...base, ...(to === "plan_approved" ? { approved_by: ev.actor!.id } : {}) } });
  }
  return { batch: next, events };
}

// ============================================================ termination and contract notices (inputs (a)/(b)/(c); A1-2-01, A1-2-02, A1-4.1-02, A2-1-01)
export type NoticeKind = "fnma_termination_without_cause" | "fnma_termination_for_cause" | "partner_voluntary_termination" | "supermortgage_exit_notice" | "contract_termination_notice_received" | "contract_termination_notice_sent" | "fnma_contract_notice_sent" | "fnma_tech_provider_notice_sent";
export interface NoticeTask { readonly kind: "officer" | "attorney"; readonly owner_role: "officer" | "attorney"; readonly task: string; readonly due: PlainDate | null; }
/** `attorney` only when Fannie Mae terminates for cause and counsel review is requested by the partner; every other termination question is the partner `officer`'s. */
export function counselReviewAllowed(kind: NoticeKind | TerminationBasis | null | undefined, requestedByPartner: boolean): boolean {
  return requestedByPartner && (kind === "fnma_termination_for_cause" || kind === "fnma_for_cause");
}
/** A1-2-01: voluntary termination is effective "on the last business day of the third month following the month in which the notice is given" (`business_days_fannie_et`). */
export function voluntaryTerminationEffective(noticeOn: PlainDate): PlainDate {
  const { y, m } = parts(noticeOn);
  return rollBack(endOfMonth(addMonths(ymd(y, m, 1), 3)), fannieEt);
}
/** Records the notice that opens a transfer-out (or a partner duty the platform monitors) as the event the registry's timers trigger on, with the officer/attorney task the spec assigns. Notices are partner facts (aggregate `partner`); the technology-provider notice (A2-1-01) names the batch whose proposal armed FNMA_A2_1_01_TECH_PROVIDER_NOTICE_180 so it satisfies that batch's row. */
export function recordNotice(i: { partner_id: string; kind: NoticeKind; notice_on: PlainDate; document_id?: string | null; counsel_review_requested_by_partner?: boolean; loan_count?: number; batch_id?: string | null }): { events: OutEvent[]; tasks: NoticeTask[]; termination_fee: "recorded_never_computed" | "none_a1_4_1_02" | "none_a1_2_02_delinquency" | null; termination_effective_on: PlainDate | null } {
  const r = recordNoticeEvents(i);
  const aggregate = i.kind === "fnma_tech_provider_notice_sent" && i.batch_id ? { kind: "transfer_batch", id: i.batch_id } : { kind: "partner", id: i.partner_id };
  return { ...r, events: r.events.map((e) => ({ ...e, aggregate })) };
}
function recordNoticeEvents(i: { partner_id: string; kind: NoticeKind; notice_on: PlainDate; document_id?: string | null; counsel_review_requested_by_partner?: boolean; loan_count?: number }): { events: OutEvent[]; tasks: NoticeTask[]; termination_fee: "recorded_never_computed" | "none_a1_4_1_02" | "none_a1_2_02_delinquency" | null; termination_effective_on: PlainDate | null } {
  const doc = i.document_id ?? null;
  const officer = (task: string, due: PlainDate | null): NoticeTask => ({ kind: "officer", owner_role: "officer", task, due });
  switch (i.kind) {
    case "fnma_termination_without_cause": {
      const due = saleArrangementDue(i.notice_on);
      return { events: [{ type: "fnma.termination_notice.received", payload: { partner_id: i.partner_id, without_cause: true, for_cause: false, notice_on: i.notice_on, document_id: doc, sale_arrangement_due: due, if_no_sale: "fnma_transfers_servicing", termination_fee: "recorded_never_computed" } }],
        tasks: [officer("arrange_servicing_sale", due), officer("termination_fee_facts", due)], termination_fee: "recorded_never_computed", termination_effective_on: null };
    }
    case "fnma_termination_for_cause": {
      const tasks: NoticeTask[] = [officer("fnma_for_cause_instructions", i.notice_on)];
      if (counselReviewAllowed(i.kind, i.counsel_review_requested_by_partner ?? false)) tasks.push({ kind: "attorney", owner_role: "attorney", task: "counsel_review_a1_4_1_02", due: null });
      return { events: [{ type: "fnma.termination_notice.received", payload: { partner_id: i.partner_id, without_cause: false, for_cause: true, effective: "immediately", notice_on: i.notice_on, document_id: doc, termination_fee: "none_a1_4_1_02" } }], tasks, termination_fee: "none_a1_4_1_02", termination_effective_on: i.notice_on };
    }
    case "partner_voluntary_termination": {
      const eff = voluntaryTerminationEffective(i.notice_on);
      return { events: [{ type: "partner.termination_notice.sent", payload: { partner_id: i.partner_id, notice_on: i.notice_on, document_id: doc, voluntary_termination_effective_on: eff, scope: "all_loans", prior_liabilities_released: false, transfer_costs_borne_by: "partner" } }], tasks: [officer("confirm_voluntary_termination_scope", i.notice_on)], termination_fee: null, termination_effective_on: eff };
    }
    case "supermortgage_exit_notice": return { events: [{ type: "supermortgage.exit_notice.sent", payload: { partner_id: i.partner_id, notice_on: i.notice_on, document_id: doc, batch_type: "sub_to_master" } }], tasks: [officer("acknowledge_supermortgage_exit", null)], termination_fee: null, termination_effective_on: null };
    case "contract_termination_notice_received":
    case "contract_termination_notice_sent": {
      const due = addBusinessDays(i.notice_on, 5, servicer);
      return { events: [{ type: i.kind === "contract_termination_notice_received" ? "contract.termination_notice.received" : "contract.termination_notice.sent", payload: { partner_id: i.partner_id, notice_on: i.notice_on, document_id: doc, fnma_notice_due: due, portfolio_loans: i.loan_count ?? null } }], tasks: [officer("notify_fannie_mae_contract_termination_a2_1_01", due)], termination_fee: null, termination_effective_on: null };
    }
    case "fnma_contract_notice_sent": return { events: [{ type: "fnma.contract_notice.sent", payload: { partner_id: i.partner_id, notice_on: i.notice_on, document_id: doc } }], tasks: [], termination_fee: null, termination_effective_on: null };
    case "fnma_tech_provider_notice_sent": return { events: [{ type: "fnma.tech_provider_notice.sent", payload: { partner_id: i.partner_id, notice_on: i.notice_on, document_id: doc } }], tasks: [], termination_fee: null, termination_effective_on: null };
  }
}
/** FNMA_A1_2_01_VOLUNTARY_TERMINATION_EFFECTIVE is satisfied when every batch of the partner has cut over — the last batch's `transfer.batch.cutover_completed{last_batch_for_partner=true}`. */
export function allBatchesCutover(batches: readonly { status: string }[]): boolean {
  return batches.length > 0 && batches.every((b) => ["cutover", "post_transfer", "retention", "closed"].includes(b.status));
}
/** "All batches `cutover`" measured, not remembered: this batch is the partner's last when every other transfer_out batch of the partner has cut over (denied/withdrawn batches never cut over and do not count). */
export function lastBatchForPartner(b: { batch_id: string }, partnerBatches: readonly { batch_id: string; status: string }[]): boolean {
  const others = partnerBatches.filter((x) => x.batch_id !== b.batch_id && x.status !== "withdrawn" && x.status !== "denied");
  return allBatchesCutover([...others, { status: "cutover" }]);
}
/** A1-2-02 without-cause termination: the partner may arrange a sale within 90 days (an `officer` task), the transfer occurring 60 days after approval. */
export function withoutCauseTermination(i: { notice_on: PlainDate; approval_on?: PlainDate | null }): { sale_arrangement_due: PlainDate; officer_task: { kind: "officer"; task: "arrange_servicing_sale"; due: PlainDate }; transfer_after_approval_due: PlainDate | null; termination_fee: "recorded_never_computed" } {
  const due = saleArrangementDue(i.notice_on);
  return { sale_arrangement_due: due, officer_task: { kind: "officer", task: "arrange_servicing_sale", due }, transfer_after_approval_due: i.approval_on ? addDays(i.approval_on, 60) : null, termination_fee: "recorded_never_computed" };
}
/** Rule 17.1 portfolio scope on termination: every serviced loan including zero-fee loans, plus acquired properties not yet closed by Fannie Mae on a separate Form 629; loans awaiting only claim reimbursement are excluded with evidence. */
export function terminationPortfolioScope(i: { termination_basis: TerminationBasis; loans: readonly { id: string; kind: "loan" | "acquired_property"; active: boolean; servicing_fee_cents: Cents; fnma_records_closed?: boolean; awaiting_claim_reimbursement_only?: boolean }[] }): { applies: boolean; included: string[]; acquired_properties_separate_form629: string[]; excluded: { id: string; evidence: string }[] } {
  const applies = i.termination_basis === "fnma_without_cause" || i.termination_basis === "fnma_for_cause" || i.termination_basis === "partner_voluntary_termination" || i.termination_basis === "supermortgage_exit";
  const included: string[] = [], acquired: string[] = [], excluded: { id: string; evidence: string }[] = [];
  for (const l of i.loans) {
    if (!applies) { if (l.active && l.kind === "loan") included.push(l.id); continue; }
    if (l.kind === "loan") { if (l.active) included.push(l.id); else excluded.push({ id: l.id, evidence: "not an active serviced loan" }); continue; }
    if (l.fnma_records_closed) excluded.push({ id: l.id, evidence: "Fannie Mae notified that its records are closed (A2-7-03)" });
    else if (l.awaiting_claim_reimbursement_only) excluded.push({ id: l.id, evidence: "awaiting only a reimbursement claim payment (A2-7-03)" });
    else acquired.push(l.id);
  }
  return { applies, included, acquired_properties_separate_form629: acquired, excluded };
}
/** Edge case 17.1: Supermortgage may not stop servicing before the approved transfer date (A2-7-03 unauthorized transfers are not recognized; sanctions). */
export function servicingStopGate(i: { proposed_stop_on: PlainDate; transfer_date: PlainDate; fnma_approved: boolean }): { ok: boolean; refusal: string | null } {
  if (!i.fnma_approved) return { ok: false, refusal: "no Fannie Mae written consent on file: an unauthorized transfer will not be recognized (A2-7-03)" };
  if (i.proposed_stop_on < i.transfer_date) return { ok: false, refusal: `servicing may not stop ${i.proposed_stop_on}, before the approved transfer date ${i.transfer_date} (A2-7-03)` };
  return { ok: true, refusal: null };
}

// ============================================================ loan-list versions, CD20 reconciliation and the CD25 attestation (T4)
/** A new Form 629 list version: adds/deletes against the previous version; nothing may be added after CD10 (additions roll to a new batch/next month); after "Agree" no changes can be made. Emits `transfer.loan_list.version_submitted{adds, deletes}` (FNMA_QX_LOAN_LIST_ADDS_CD10). */
export function submitLoanListVersion(i: { previous: LoanListVersion | null; loans: readonly string[]; submitted_on: PlainDate; transfer_date: PlainDate; reason?: string | null }): { version: LoanListVersion; adds: string[]; deletes: string[]; adds_by: PlainDate; event: OutEvent & { type: "transfer.loan_list.version_submitted" } } {
  const prev = new Set(i.previous?.loans ?? []), cur = new Set(i.loans);
  const adds = [...cur].filter((n) => !prev.has(n)).sort(), deletes = [...prev].filter((n) => !cur.has(n)).sort();
  const addsBy = quickExchangeCadenceOut(i.transfer_date).adds_by;
  if (i.previous?.attested) throw new RangeError(`list version ${i.previous.version} is attested: after "Agree" no changes can be made in Quick Exchange`);
  if (adds.length && i.submitted_on > addsBy) throw new RangeError(`nothing may be added after CD10 ${addsBy}: ${adds.join(",")} roll to a new batch/next month`);
  const version: LoanListVersion = { version: (i.previous?.version ?? 0) + 1, loans: [...i.loans], attested: false, created_on: i.submitted_on, ...(i.reason ? { reason: i.reason } : {}) };
  return { version, adds, deletes, adds_by: addsBy, event: { type: "transfer.loan_list.version_submitted", payload: { version: version.version, adds: adds.length, deletes: deletes.length, added: adds, deleted: deletes, submitted_on: i.submitted_on, adds_by: addsBy, loan_count: i.loans.length } } };
}
export interface QxReconciliation {
  readonly version: number;
  readonly downloaded_on: PlainDate | null;
  readonly only_in_download: readonly string[];
  readonly only_in_system: readonly string[];
  readonly difference_count: number;
  readonly zero_differences: boolean;
  /** `transfer.loan_list.reconciled{zero_differences=true}` satisfies SM_QX_RECONCILIATION_CD20 only at zero differences. */
  readonly event: "transfer.loan_list.reconciled" | null;
}
/** Rule 17.1: the CD20 reconciliation compares the Quick Exchange download to `transfer_batch_loans` (the current list version) and must show zero differences before attestation. */
export function reconcileQxDownload(i: { download: readonly string[]; version: LoanListVersion; downloaded_on?: PlainDate | null }): QxReconciliation {
  const dl = new Set(i.download), sor = new Set(i.version.loans);
  const onlyDownload = [...dl].filter((n) => !sor.has(n)).sort();
  const onlySystem = [...sor].filter((n) => !dl.has(n)).sort();
  const count = onlyDownload.length + onlySystem.length;
  return { version: i.version.version, downloaded_on: i.downloaded_on ?? null, only_in_download: onlyDownload, only_in_system: onlySystem, difference_count: count, zero_differences: count === 0, event: count === 0 ? "transfer.loan_list.reconciled" : null };
}
/** Attestation ("Agree" in Quick Exchange) is blocked until a reconciliation of the version being attested shows zero differences. */
export function attestationGate(recon: QxReconciliation, version: LoanListVersion): { ok: boolean; timer: "FNMA_QX_LOAN_LIST_FREEZE_CD25"; block: string | null } {
  if (recon.version !== version.version) return { ok: false, timer: "FNMA_QX_LOAN_LIST_FREEZE_CD25", block: `reconciliation is of list version ${recon.version}, not version ${version.version}: reconcile the current version first` };
  if (!recon.zero_differences) return { ok: false, timer: "FNMA_QX_LOAN_LIST_FREEZE_CD25", block: `CD20 reconciliation shows ${recon.difference_count} difference(s) (download only: ${recon.only_in_download.join(",") || "-"}; system only: ${recon.only_in_system.join(",") || "-"}): attestation blocked until a new loan-list version resolves it` };
  return { ok: true, timer: "FNMA_QX_LOAN_LIST_FREEZE_CD25", block: null };
}
/** How each CD20 difference resolves: a system-only loan is a deletion (new list version); a download-only loan can be added only through CD10, after which Fannie Mae is queried (nothing may be added after CD10). */
export function qxDifferenceResolution(recon: QxReconciliation, today: PlainDate, addsBy: PlainDate): { fnma_loan_number: string; action: "delete_from_list" | "add_to_list" | "query_fannie_mae"; reason: string }[] {
  const out: { fnma_loan_number: string; action: "delete_from_list" | "add_to_list" | "query_fannie_mae"; reason: string }[] = [];
  for (const n of recon.only_in_system) out.push({ fnma_loan_number: n, action: "delete_from_list", reason: "on the system of record but not in the Quick Exchange download: withdraw it in a new list version" });
  for (const n of recon.only_in_download) out.push(today > addsBy ? { fnma_loan_number: n, action: "query_fannie_mae", reason: `in the Quick Exchange download but not on the system of record and today ${today} is after CD10 ${addsBy}: nothing may be added after CD10 — query ${FNMA_SERVICING_TRANSFERS_MAILBOX}` } : { fnma_loan_number: n, action: "add_to_list", reason: "in the Quick Exchange download but not on the system of record: add it in a new list version by CD10" });
  return out;
}
/** The partner `officer` clicks "Agree" only once the gate is open; the attested version emits `transfer.loan_list.attested` (FNMA_QX_LOAN_LIST_FREEZE_CD25) and, the list being final, `transfer.loan_list.finalized` (FNMA_IRM_TT32_TRANSFER_RECORD_15). */
export function attestLoanList(gate: ReturnType<typeof attestationGate>, version: LoanListVersion, officer: Actor, attestedOn?: PlainDate | null): LoanListVersion & { event: "transfer.loan_list.attested"; events: OutEvent[] } {
  if (!gate.ok) throw new RangeError(gate.block ?? "attestation blocked");
  const attested = attestList(version, officer);
  const payload = { version: attested.version, attested_by: attested.attested_by ?? officer.id, attested_on: attestedOn ?? null, loan_count: attested.loans.length, evidence: "Quick Exchange \"Agree\"" };
  return { ...attested, event: "transfer.loan_list.attested", events: [{ type: "transfer.loan_list.attested", payload }, { type: "transfer.loan_list.finalized", payload: { ...payload, superseded_tt32: true } }] };
}

// ============================================================ master_change_sub_retained (T5)
export interface GoodbyeRunPlan {
  readonly transfer_type: TransferType;
  readonly respa_notice_required: boolean;
  readonly goodbye_run: { kind: "goodbye"; status: "planned"; process: "17.2" } | null;
  readonly exclusion_record: { basis: string; approved_by: string; rule: "§1024.33(b)(2)(i)(C)" } | null;
  readonly block: string | null;
  readonly form629: { filed_by: "selling_master" | "partner" | "supermortgage"; rule: Form629Rule; deadline: PlainDate };
  readonly retained: { form101: "re_execute_with_new_master"; forms_1013_1014: "re_evidence_under_new_master"; mers: "tos_by_sellers"; custodial_accounts: "retained_open"; custodial_close_timer: null } | null;
}
/** Rule 17.1 batch-type mapping: `master_change_sub_retained` is the §1024.33(b)(2)(i)(C) case — no RESPA notice when payee, address, account number and payment amount are unchanged; the `officer` sign-off records the exclusion. */
export function goodbyeRunForBatch(i: { transfer_type: TransferType; transfer_date: PlainDate; sale_date?: PlainDate | null; unchanged: { payee: boolean; address: boolean; account: boolean; amount: boolean }; officer: Actor | null }): GoodbyeRunPlan {
  const clocks = form629ClocksOut(i.transfer_type, i.transfer_date, i.sale_date ?? null);
  const filedBy = i.transfer_type === "master_change_sub_retained" ? "selling_master" : i.transfer_type === "sub_to_master" ? "supermortgage" : "partner";
  const form629 = { filed_by: filedBy, rule: clocks.rule, deadline: clocks.deadline } as const;
  if (i.transfer_type !== "master_change_sub_retained") return { transfer_type: i.transfer_type, respa_notice_required: true, goodbye_run: { kind: "goodbye", status: "planned", process: "17.2" }, exclusion_record: null, block: null, form629, retained: null };
  const retained = { form101: "re_execute_with_new_master", forms_1013_1014: "re_evidence_under_new_master", mers: "tos_by_sellers", custodial_accounts: "retained_open", custodial_close_timer: null } as const;
  if (respaNoticeRequired(i.transfer_type, i.unchanged)) return { transfer_type: i.transfer_type, respa_notice_required: true, goodbye_run: { kind: "goodbye", status: "planned", process: "17.2" }, exclusion_record: null, block: null, form629, retained };
  const ex = masterServicerOnlyExclusion(i.unchanged, i.officer);
  return { transfer_type: i.transfer_type, respa_notice_required: false, goodbye_run: null, exclusion_record: ex.exclusion_record ? { ...ex.exclusion_record, rule: "§1024.33(b)(2)(i)(C)" } : null, block: ex.block, form629, retained };
}

// ============================================================ payoff after attestation (T8)
export interface PostAttestationWithdrawal {
  readonly fnma_loan_number: string;
  readonly offboarding_status: "withdrawn";
  readonly flag: "withdrawn_after_attestation" | "withdrawn";
  /** A withdrawal before "Agree" is an ordinary deletion in a new list version; after it Quick Exchange accepts no changes. */
  readonly new_list_version: boolean;
  readonly removal_report_by: PlainDate;
  readonly report_via: "5.3";
  readonly inform: typeof FNMA_SERVICING_TRANSFERS_MAILBOX;
  readonly fnma_processes_on: PlainDate;
  readonly moves_on_bd3_unless_fnma_removes: boolean;
  readonly transferee_tape_marker: { fnma_loan_number: string; marker: "withdrawn_after_attestation"; paid_off_on: PlainDate } | null;
  /** `transfer.loan.withdrawn{flag}` on the batch; after "Agree" the removal report (5.3, before BD2) is a portal-operator task and servicing_transfers@fanniemae.com is informed. */
  readonly event: OutEvent & { type: "transfer.loan.withdrawn" };
  readonly removal_task: { kind: "human_portal_task"; task: "fnma_removal_report_5_3"; due: PlainDate; inform: typeof FNMA_SERVICING_TRANSFERS_MAILBOX } | null;
}
/** Edge case 17.1: a payoff/repurchase after the CD25 attestation still moves on BD3 unless Fannie Mae removes it; Supermortgage reports the removal (5.3) by BD2, informs servicing_transfers@fanniemae.com and marks the loan on the final tape. */
export function payoffAfterAttestation(i: { fnma_loan_number: string; paid_off_on: PlainDate; attested_on: PlainDate | null; transfer_date: PlainDate; reason?: "paid_off" | "repurchased" | "foreclosed" }): PostAttestationWithdrawal {
  const after = i.attested_on !== null && i.paid_off_on > i.attested_on;
  const bd2 = fannieBusinessDay(i.transfer_date, 2), bd3 = fannieBusinessDay(i.transfer_date, 3);
  const flag = after ? "withdrawn_after_attestation" : "withdrawn";
  const event = { type: "transfer.loan.withdrawn" as const, payload: { fnma_loan_number: i.fnma_loan_number, flag, after_attestation: after, reason: i.reason ?? "paid_off", paid_off_on: i.paid_off_on, attested_on: i.attested_on, removal_report_by: bd2, report_via: "5.3", inform: FNMA_SERVICING_TRANSFERS_MAILBOX, fnma_processes_on: bd3, moves_on_bd3_unless_fnma_removes: after } };
  return { fnma_loan_number: i.fnma_loan_number, offboarding_status: "withdrawn", flag, new_list_version: !after, removal_report_by: bd2, report_via: "5.3", inform: FNMA_SERVICING_TRANSFERS_MAILBOX,
    fnma_processes_on: bd3, moves_on_bd3_unless_fnma_removes: after, transferee_tape_marker: after ? { fnma_loan_number: i.fnma_loan_number, marker: "withdrawn_after_attestation", paid_off_on: i.paid_off_on } : null,
    event, removal_task: after ? { kind: "human_portal_task", task: "fnma_removal_report_5_3", due: bd2, inform: FNMA_SERVICING_TRANSFERS_MAILBOX } : null };
}
/** The 17.3 final tape carries the marker for every post-attestation withdrawal. */
export function transfereeTapeRows(loans: readonly { fnma_loan_number: string; offboarding_status: OffboardingStatus }[], withdrawals: readonly PostAttestationWithdrawal[]): { fnma_loan_number: string; offboarding_status: OffboardingStatus; marker: "withdrawn_after_attestation" | null; paid_off_on: PlainDate | null }[] {
  const byLoan = new Map(withdrawals.filter((w) => w.transferee_tape_marker).map((w) => [w.fnma_loan_number, w.transferee_tape_marker!] as const));
  return loans.map((l) => { const m = byLoan.get(l.fnma_loan_number); return { fnma_loan_number: l.fnma_loan_number, offboarding_status: m ? "withdrawn" : l.offboarding_status, marker: m ? m.marker : null, paid_off_on: m ? m.paid_off_on : null }; });
}
/** BD3: the Fannie Mae Connect "Servicing Transfers Origination and Modification Data Report" shows every listed loan under the transferee servicer number → `fnma.transfer.processed` (FNMA_QX_PROCESSING_BD3). */
export function fnmaProcessingConfirmation(i: { transfer_date: PlainDate; report_as_of: PlainDate; transferee_servicer_number: string; expected: readonly string[]; rows: readonly { fnma_loan_number: string; servicer_number: string }[] }): { processing_on: PlainDate; on_or_after_bd3: boolean; confirmed: boolean; not_yet_transferred: string[]; missing_from_report: string[]; event: (OutEvent & { type: "fnma.transfer.processed" }) | null } {
  const bd3 = fannieBusinessDay(i.transfer_date, 3);
  const byLoan = new Map(i.rows.map((r) => [r.fnma_loan_number, r.servicer_number] as const));
  const missing = i.expected.filter((n) => !byLoan.has(n)), notYet = i.expected.filter((n) => byLoan.has(n) && byLoan.get(n) !== i.transferee_servicer_number);
  const onOrAfter = i.report_as_of >= bd3, confirmed = onOrAfter && missing.length === 0 && notYet.length === 0 && i.expected.length > 0;
  return { processing_on: bd3, on_or_after_bd3: onOrAfter, confirmed, not_yet_transferred: notYet, missing_from_report: missing, event: confirmed ? { type: "fnma.transfer.processed", payload: { transfer_date: i.transfer_date, processed_on: bd3, report_as_of: i.report_as_of, transferee_servicer_number: i.transferee_servicer_number, loan_count: i.expected.length } } : null };
}

// ============================================================ deadline table, plan, package
/** The Form 629 portal task the `transfer` agent files (createPortalTask): the EscalationService appends `escalation.created{kind=human_portal_task, task=form629, batch_id}` on the escalation subject — the event SM_PORTAL_TASK_FORM629_SLA_2 arms on. This ingests that event: the SLA anchor is the task's own `created_at` (the event instant on its Eastern civil date, the anchor the registry names) and the due date is +2 servicer business days; `escalation.completed` on the same subject (the operator's completion evidence) satisfies it. Null for any other escalation. */
export function form629PortalTaskOpened(e: { type: string; occurredAt: string; payload: Record<string, unknown> }): { timer: "SM_PORTAL_TASK_FORM629_SLA_2"; escalation_id: string; batch_id: string; created_at: PlainDate; sla_due: PlainDate; satisfied_by: "escalation.completed" } | null {
  const p = e.payload;
  if (e.type !== "escalation.created" || p.kind !== "human_portal_task" || p.task !== "form629") return null;
  if (typeof p.escalation_id !== "string" || typeof p.batch_id !== "string") throw new RangeError("a Form 629 portal task names its escalation_id and batch_id");
  const createdAt = wallClock(Date.parse(e.occurredAt), "America/New_York").date;
  return { timer: "SM_PORTAL_TASK_FORM629_SLA_2", escalation_id: p.escalation_id, batch_id: p.batch_id, created_at: createdAt, sla_due: portalTaskEscalation(createdAt), satisfied_by: "escalation.completed" };
}
export interface DeadlineRow { readonly code: string; readonly due: PlainDate; readonly kind: "deadline" | "not_before_gate"; readonly satisfied_by: string; readonly basis: string; }
export interface DeadlineInputs {
  readonly transfer_type: TransferType; readonly transfer_date: PlainDate; readonly sale_date?: PlainDate | null; readonly proposed_on?: PlainDate | null;
  readonly termination_basis?: TerminationBasis | null; readonly fnma_termination_notice_on?: PlainDate | null; readonly approval_on?: PlainDate | null; readonly partner_termination_notice_on?: PlainDate | null;
  readonly last_batch_for_partner?: boolean; readonly loan_count?: number; readonly supermortgage_is_tech_provider?: boolean; readonly contract_termination_notice_on?: PlainDate | null;
  /** `fnma_directed`: Fannie Mae's instruction (dates the letter names; `fnma_instruction_date` alone = immediate effect from that date). */
  readonly fnma_instruction?: FnmaInstruction | null; readonly fnma_instruction_date?: PlainDate | null;
}
/** Every 17.1 deadline for a batch, from the spec's inputs. `fnma_directed` for cause with immediate effect switches every pre-transfer anchor to Fannie Mae's instruction (the dates it names, else the day it was received); Fannie Mae still processes on BD3 and the termination rows still run +5 BD from the actual transfer date. */
export function computeDeadlines(i: DeadlineInputs): { transfer_date_gate: ReturnType<typeof transferDateGate>; transfer_date: PlainDate; anchor_basis: "transfer_date" | "fnma_instruction"; liability_start_date: PlainDate; portal_task_on: PlainDate; rows: DeadlineRow[] } {
  const instruction = i.transfer_type === "fnma_directed" ? (i.fnma_instruction ?? (i.fnma_instruction_date ? { received_on: i.fnma_instruction_date } : null)) : null;
  const transferDate = instruction?.transfer_date ?? i.transfer_date;
  const gate = transferDateGate(transferDate);
  const clocks = form629ClocksOut(i.transfer_type, transferDate, i.sale_date ?? null, instruction);
  const qx = quickExchangeCadenceOut(transferDate, clocks.deadline);
  const I = instruction?.received_on ?? null;
  const listBy = instruction ? (instruction.loan_list_by ?? I!) : null;
  const tag = instruction ? " [anchor: fnma_instruction — Fannie Mae's instructions override the cadence]" : "";
  const rows: DeadlineRow[] = [];
  const row = (code: string, due: PlainDate, satisfied_by: string, basis: string, kind: "deadline" | "not_before_gate" = "deadline") => rows.push({ code, due, kind, satisfied_by, basis: basis + tag });
  row("FNMA_A2_7_03_TRANSFER_DATE_GATE", instruction ? transferDate : firstFannieBusinessDay(transferDate), "assert in proposeBatch", instruction ? "transfer date set by Fannie Mae's instruction (A1-4.1-02)" : "transfer date = first business_days_fannie_et of the month (A2-7-03)", "not_before_gate");
  if (clocks.rule === "30_day_subservicing") row("FNMA_A2_7_03_FORM629_SUBSERVICING_30", clocks.deadline, "transfer.form629.submitted", "transfer_date − 30 calendar days (A2-7-03 subservicing)");
  else if (clocks.rule === "60_day_servicing") row("FNMA_A2_7_03_FORM629_SERVICING_60", clocks.deadline, "transfer.form629.submitted", "earlier of sale_date/transfer_date − 60 calendar days (A2-7-03 servicing)");
  else row("FNMA_A2_7_03_FORM629_SERVICING_60", clocks.deadline, "transfer.form629.submitted", "Fannie Mae instructions govern timing (fnma_directed)");
  row("SM_FORM629_INTERNAL_BUFFER_7", clocks.internal_buffer, "transfer.form629.submitted", "Form 629 deadline − 7 calendar days");
  const portalTaskOn = instruction ? I! : qx.portal_task_on;
  row("SM_PORTAL_TASK_FORM629_SLA_2", portalTaskEscalation(portalTaskOn), "escalation.completed", `portal task scheduled ${portalTaskOn} (last servicer business day before the Form 629 deadline); SLA = created_at + 2 servicer business days`);
  row("SM_TRANSFER_PLAN_APPROVED_T45", instruction ? I! : addDays(transferDate, -45), "transfer.plan.approved", "transfer_date − 45 calendar days (Bulletin 2020-02)");
  if (i.supermortgage_is_tech_provider && (i.loan_count ?? 0) >= 20_000) row("FNMA_A2_1_01_TECH_PROVIDER_NOTICE_180", instruction ? I! : addDays(transferDate, -180), "fnma.tech_provider_notice.sent", "≥20,000 loans: 180 days' prior written notice of a technology-provider change (A2-1-01)");
  row("FNMA_QX_LOAN_LIST_ADDS_CD10", listBy ?? qx.adds_by, "transfer.loan_list.version_submitted{adds>0}", "10th calendar day of the month before transfer_date (Quick Exchange)");
  row("SM_QX_RECONCILIATION_CD20", listBy ?? qx.reconciliation_by, "transfer.loan_list.reconciled{zero_differences=true}", "CD20 of the month before transfer_date: download vs system of record, zero differences");
  row("FNMA_QX_LOAN_LIST_FREEZE_CD25", listBy ?? qx.attestation_by, "transfer.loan_list.attested", "25th calendar day of the month before transfer_date (prior business day if weekend/holiday): Quick Exchange \"Agree\"");
  row("FNMA_IRM_TT32_TRANSFER_RECORD_15", listBy ?? addDays(transferDate, -15), "transfer.loan_list.finalized", "transfer_date − 15 calendar days (IRM 3-01; superseded by CD25 in practice)");
  row("FNMA_QX_PROCESSING_BD3", qx.processing_on, "fnma.transfer.processed", "3rd business_days_fannie_et of the transfer month", "not_before_gate");
  if (i.last_batch_for_partner) {
    row("FNMA_A2_1_07_FORM101_TERMINATION_5BD", form101TerminationDue(transferDate), "transfer.form101_termination.submitted", "transfer_date + 5 servicer BD (A2-1-07 'at termination'; policy day count)");
    row("SM_XFER_OUT_ACCESS_REVOCATION_5BD", addBusinessDays(transferDate, 5, servicer), "credentials.partner_scoped.revoked", "transfer_date + 5 servicer BD after final-period close");
  }
  if (i.fnma_termination_notice_on && i.termination_basis === "fnma_without_cause") row("FNMA_A1_2_02_SALE_ARRANGEMENT_90", saleArrangementDue(i.fnma_termination_notice_on), "transfer.batch.proposed{type=servicing_sale}", "notice date + 90 calendar days (A1-2-02)");
  if (i.approval_on && i.termination_basis === "fnma_without_cause") row("FNMA_A1_2_02_TRANSFER_AFTER_APPROVAL_60", addDays(i.approval_on, 60), "transfer.batch.cutover_completed", "approval date + 60 calendar days (A1-2-02)");
  if (i.partner_termination_notice_on) row("FNMA_A1_2_01_VOLUNTARY_TERMINATION_EFFECTIVE", voluntaryTerminationEffective(i.partner_termination_notice_on), "transfer.batch.cutover_completed{last_batch_for_partner=true}", "last business_days_fannie_et of the 3rd month after the notice month (A1-2-01)");
  if (i.contract_termination_notice_on) row("FNMA_A2_1_01_CONTRACT_NOTICE_5BD", addBusinessDays(i.contract_termination_notice_on, 5, servicer), "fnma.contract_notice.sent", "notice date + 5 servicer BD (A2-1-01)");
  return { transfer_date_gate: gate, transfer_date: transferDate, anchor_basis: instruction ? "fnma_instruction" : "transfer_date", liability_start_date: clocks.liability_start, portal_task_on: portalTaskOn, rows };
}
export const PLAN_ELEMENTS = ["communications", "testing", "milestones", "escalation"] as const;
/** Bulletin 2020-02 transfer plan: communications, testing, milestones and escalation, approved by the partner `officer` before Form 629 (SM_TRANSFER_PLAN_APPROVED_T45). */
export function transferPlan(i: { batch_id: string; transfer_type: TransferType; transfer_date: PlainDate; sale_date?: PlainDate | null; elements: Partial<Record<(typeof PLAN_ELEMENTS)[number], string>> }): { batch_id: string; status: "draft"; missing_elements: string[]; approval_required_by: "officer"; approve_by: PlainDate; milestones: DeadlineRow[]; event: "transfer.plan.prepared" } {
  const missing = PLAN_ELEMENTS.filter((e) => !i.elements[e]);
  return { batch_id: i.batch_id, status: "draft", missing_elements: [...missing], approval_required_by: "officer", approve_by: addDays(i.transfer_date, -45), milestones: computeDeadlines({ transfer_type: i.transfer_type, transfer_date: i.transfer_date, sale_date: i.sale_date ?? null }).rows, event: "transfer.plan.prepared" };
}
export function approvePlan(plan: ReturnType<typeof transferPlan>, actor: Actor | null): { status: "plan_approved"; approved_by: string; event: "transfer.plan.approved" } {
  if (plan.missing_elements.length) throw new RangeError(`plan is missing ${plan.missing_elements.join(", ")} (Bulletin 2020-02)`);
  if (!isOfficer(actor)) throw new RangeError("plan approval is a partner officer act");
  return { status: "plan_approved", approved_by: actor.id, event: "transfer.plan.approved" };
}
/** The one custodian name the spec quotes from the 29-row Custodian Matrix; the rest come from the matrix document on the batch. */
export const CUSTODIAN_MATRIX_ENOTE = "FNMAeNote";
export interface Form629Row { readonly transferor_servicer_number: string; readonly transferee_servicer_number: string; readonly fnma_loan_number: string; readonly upb_cents: Cents; readonly transferor_custodian: string; readonly transferee_custodian: string; readonly kind?: "loan" | "acquired_property"; readonly special_notification?: "emortgage" | "resale_restriction" | "shared_equity" | null; }
/** Servicing Transfers User Guide template: 9-digit servicer numbers, 10-digit loan numbers, UPB in dollars and cents, custodians exactly as in the Custodian Matrix; a separate Form 629 for acquired properties; first-business-day transfer date. */
export function form629Package(i: { transfer_type: TransferType; transfer_date: PlainDate; sale_date?: PlainDate | null; rows: readonly Form629Row[]; custodian_matrix: readonly string[]; transferee_uses_subservicer: boolean; transferee_subservicer_number?: string | null; fnma_instruction?: FnmaInstruction | null }): { ok: boolean; errors: string[]; loan_rows: number; acquired_property_rows: number; separate_forms: string[]; subservicer_question: { will_subservicer_be_used: boolean; subservicer_number: string | null }; special_notifications: { fnma_loan_number: string; kind: string }[]; deadline: PlainDate; event: "transfer.form629.prepared" } {
  const errors: string[] = [];
  const gate = transferDateGate(i.transfer_date); if (!gate.ok && !i.fnma_instruction) errors.push(`transfer date ${i.transfer_date} is not the first Fannie Mae business day of the month (expected ${gate.expected})`);
  const matrix = new Set([...i.custodian_matrix, CUSTODIAN_MATRIX_ENOTE]);   // eNotes always sit with FNMAeNote (User Guide: 29 custodians incl. "FNMAeNote")
  const seen = new Set<string>();
  for (const r of i.rows) {
    if (!/^\d{9}$/.test(r.transferor_servicer_number)) errors.push(`${r.fnma_loan_number}: transferor servicer number must be 9 digits`);
    if (!/^\d{9}$/.test(r.transferee_servicer_number)) errors.push(`${r.fnma_loan_number}: transferee servicer number must be 9 digits`);
    if (!/^\d{10}$/.test(r.fnma_loan_number)) errors.push(`${r.fnma_loan_number}: Fannie Mae loan number must be 10 digits`);
    if (r.upb_cents < 0n) errors.push(`${r.fnma_loan_number}: UPB must be a non-negative dollars-and-cents amount`);
    if (!matrix.has(r.transferor_custodian)) errors.push(`${r.fnma_loan_number}: transferor custodian "${r.transferor_custodian}" is not exactly as shown in the Custodian Matrix`);
    if (!matrix.has(r.transferee_custodian)) errors.push(`${r.fnma_loan_number}: transferee custodian "${r.transferee_custodian}" is not exactly as shown in the Custodian Matrix`);
    if (seen.has(r.fnma_loan_number)) errors.push(`${r.fnma_loan_number}: listed twice`); seen.add(r.fnma_loan_number);
  }
  if (i.transferee_uses_subservicer && !/^\d{9}$/.test(i.transferee_subservicer_number ?? "")) errors.push("transferee uses a subservicer: its 9-digit servicer number is required (A2-1-07)");
  const acquired = i.rows.filter((r) => r.kind === "acquired_property").length;
  return { ok: errors.length === 0, errors, loan_rows: i.rows.length - acquired, acquired_property_rows: acquired, separate_forms: acquired ? ["acquired_properties"] : [], subservicer_question: { will_subservicer_be_used: i.transferee_uses_subservicer, subservicer_number: i.transferee_uses_subservicer ? (i.transferee_subservicer_number ?? null) : null },
    special_notifications: i.rows.filter((r) => r.special_notification).map((r) => ({ fnma_loan_number: r.fnma_loan_number, kind: r.special_notification! })), deadline: form629ClocksOut(i.transfer_type, i.transfer_date, i.sale_date ?? null, i.fnma_instruction ?? null).deadline, event: "transfer.form629.prepared" };
}
/** Custodian Matrix selections: each loan's transferor/transferee custodian "exactly as shown"; eNotes always sit with FNMAeNote. */
export function custodianMatrixSelection(i: { loans: readonly { fnma_loan_number: string; enote: boolean; transferor_custodian: string; transferee_custodian: string }[]; matrix: readonly string[] }): { ok: boolean; errors: string[]; selections: { fnma_loan_number: string; transferor_custodian: string; transferee_custodian: string }[] } {
  const names = new Set([...i.matrix, CUSTODIAN_MATRIX_ENOTE]);
  const errors: string[] = [];
  const selections = i.loans.map((l) => {
    const from = l.enote ? CUSTODIAN_MATRIX_ENOTE : l.transferor_custodian, to = l.enote ? CUSTODIAN_MATRIX_ENOTE : l.transferee_custodian;
    if (!names.has(from)) errors.push(`${l.fnma_loan_number}: transferor custodian "${from}" not in the Custodian Matrix`);
    if (!names.has(to)) errors.push(`${l.fnma_loan_number}: transferee custodian "${to}" not in the Custodian Matrix`);
    return { fnma_loan_number: l.fnma_loan_number, transferor_custodian: from, transferee_custodian: to };
  });
  return { ok: errors.length === 0, errors, selections };
}
/** Loan-list integrity: active loans as of the package date; 10-digit numbers; no loan on two open batches; nothing added after CD10. */
export function validateLoanList(i: { loans: readonly { fnma_loan_number: string; active: boolean; other_open_batch_id?: string | null; added_on?: PlainDate | null }[]; transfer_date: PlainDate; package_date: PlainDate }): { ok: boolean; errors: string[]; refused_adds: string[]; adds_by: PlainDate; listed: string[] } {
  const addsBy = quickExchangeCadenceOut(i.transfer_date).adds_by;
  const errors: string[] = [], refused: string[] = [], listed: string[] = [];
  const seen = new Set<string>();
  for (const l of i.loans) {
    if (!/^\d{10}$/.test(l.fnma_loan_number)) errors.push(`${l.fnma_loan_number}: not a 10-digit Fannie Mae loan number`);
    if (!l.active) errors.push(`${l.fnma_loan_number}: not active as of ${i.package_date}`);
    if (l.other_open_batch_id) errors.push(`${l.fnma_loan_number}: already on open batch ${l.other_open_batch_id}`);
    if (seen.has(l.fnma_loan_number)) errors.push(`${l.fnma_loan_number}: duplicate`); seen.add(l.fnma_loan_number);
    if (l.added_on && l.added_on > addsBy) { refused.push(l.fnma_loan_number); errors.push(`${l.fnma_loan_number}: added ${l.added_on}, after CD10 ${addsBy} — rolls to a new batch/next month`); continue; }
    listed.push(l.fnma_loan_number);
  }
  return { ok: errors.length === 0, errors, refused_adds: refused, adds_by: addsBy, listed };
}
/** Approval letter (Quick Exchange e-mail): outcome, D-Code, effective date, conditions and loan count (comma-grouped counts such as "1,250 loans" included); the `officer` confirms before `approved`. */
export function parseApprovalLetter(text: string): { outcome: "approved" | "denied" | "on_hold" | "unclear"; d_code: string | null; effective_date: PlainDate | null; conditions: string[]; loan_count: number | null; officer_confirmation_required: true; next_status: "approved" | "denied" | "on_hold" | "info_requested" } {
  const denied = /\b(den(y|ied)|not approved|reject(ed)?)\b/i.test(text);
  const hold = /\b(longer timeframe|on hold|deferred)\b/i.test(text);
  const approved = /\b(approv(e[sd]?|al)|consent(s|ed)?)\b/i.test(text);
  const dCode = /\bD-?Code[:\s]+([A-Z]{1,2}\d{0,3})\b/i.exec(text)?.[1] ?? null;
  const date = /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
  const count = /(?<![\d,])(\d{1,3}(?:,\d{3})+|\d{1,7})\s+(?:mortgage\s+)?loans?\b/i.exec(text)?.[1];
  const conditions = [...text.matchAll(/(?:condition(?:ed)?(?: on|s?:)|provided that|subject to)\s+([^.;\n]+)/gi)].map((m) => m[1]!.trim());
  const outcome = denied ? "denied" : hold ? "on_hold" : approved ? "approved" : "unclear";
  return { outcome, d_code: dCode, effective_date: date as PlainDate | null, conditions, loan_count: count ? Number(count.replace(/,/g, "")) : null, officer_confirmation_required: true, next_status: outcome === "unclear" ? "info_requested" : outcome };
}
/** The approval letter moves the batch: `approved` (officer confirms the D-Code and accepts conditions; `transfer.form629.approved` + `transfer.batch.approved`), `denied` (partner decision; terminal), `on_hold` (re-based transfer date), or `info_requested` (a query to answer). */
export function applyFnmaOutcome(b: TransferOutBatch, parsed: ReturnType<typeof parseApprovalLetter>, i: { actor: Actor | null; on: PlainDate; approval_letter_document_hash?: string | null; partner_decision_id?: string | null; new_transfer_date?: PlainDate | null; conditions_accepted?: boolean }): { batch: TransferOutBatch; events: OutEvent[] } {
  if (parsed.next_status === "approved") {
    if (!isOfficer(i.actor)) throw new RangeError("the partner officer confirms the D-Code and accepts any conditions before `approved`");
    if (parsed.conditions.length && i.conditions_accepted !== true) throw new RangeError(`consent carries ${parsed.conditions.length} condition(s): the officer must accept them`);
    const t = transitionTransferOut(b, "approved", { actor: i.actor, approval_letter_document_hash: i.approval_letter_document_hash ?? null, d_code: parsed.d_code, consent_conditions: parsed.conditions, officer_confirmed_conditions: i.conditions_accepted ?? false }, i.on);
    return { batch: t.batch, events: [{ type: "transfer.form629.approved", payload: { batch_id: b.batch_id, d_code: parsed.d_code, effective_date: parsed.effective_date, conditions: parsed.conditions, loan_count: parsed.loan_count, confirmed_by: i.actor.id } }, ...t.events] };
  }
  if (parsed.next_status === "denied") { const t = transitionTransferOut(b, "denied", { actor: i.actor, partner_decision_id: i.partner_decision_id ?? null }, i.on); return { batch: t.batch, events: [{ type: "transfer.form629.denied", payload: { batch_id: b.batch_id, partner_decision_id: i.partner_decision_id ?? null } }, ...t.events] }; }
  if (parsed.next_status === "on_hold") return transitionTransferOut(b, "on_hold", { actor: i.actor, new_transfer_date: i.new_transfer_date ?? null }, i.on);
  const t = b.status === "submitted" ? transitionTransferOut(b, "info_requested", { actor: i.actor }, i.on) : { batch: b, events: [] as OutEvent[] };
  return { batch: t.batch, events: [{ type: "transfer.fnma_query.received", payload: { batch_id: b.batch_id, received_on: i.on } }, ...t.events] };
}
/** Form 101 termination (A2-1-07 "at … termination"): drafted by the agent, e-mailed by the partner `officer` to Technology_Registration@fanniemae.com within 5 servicer BD of the last cutover. */
export function form101TerminationDraft(i: { partner_servicer_number: string; last_cutover_on: PlainDate; batch_id: string }): { to: typeof FNMA_TECHNOLOGY_REGISTRATION_MAILBOX; form: "Form 101"; action: "termination"; partner_servicer_number: string; due: PlainDate; status: "draft_pending_officer"; sent_by: "officer"; satisfied_by: "transfer.form101_termination.submitted"; access_revocation_by: PlainDate } {
  if (!/^\d{9}$/.test(i.partner_servicer_number)) throw new RangeError("partner servicer number must be 9 digits");
  return { to: FNMA_TECHNOLOGY_REGISTRATION_MAILBOX, form: "Form 101", action: "termination", partner_servicer_number: i.partner_servicer_number, due: form101TerminationDue(i.last_cutover_on), status: "draft_pending_officer", sent_by: "officer", satisfied_by: "transfer.form101_termination.submitted", access_revocation_by: addBusinessDays(i.last_cutover_on, 5, servicer) };
}
/** The officer's e-mail to Technology_Registration@fanniemae.com (evidence document) is the `transfer.form101_termination.submitted` that satisfies FNMA_A2_1_07_FORM101_TERMINATION_5BD. */
export function submitForm101Termination(draft: ReturnType<typeof form101TerminationDraft>, i: { actor: Actor | null; evidence_document_id: string; submitted_on: PlainDate; batch_id: string }): { status: "submitted"; on_time: boolean; event: OutEvent & { type: "transfer.form101_termination.submitted" } } {
  if (!isOfficer(i.actor)) throw new RangeError("the Form 101 termination form is e-mailed by the partner officer");
  if (!i.evidence_document_id) throw new RangeError("the e-mail evidence document is required");
  return { status: "submitted", on_time: i.submitted_on <= draft.due, event: { type: "transfer.form101_termination.submitted", payload: { batch_id: i.batch_id, to: draft.to, partner_servicer_number: draft.partner_servicer_number, submitted_on: i.submitted_on, due: draft.due, evidence_document_id: i.evidence_document_id, submitted_by: i.actor.id } } };
}
/** The partner's Form 582 filing as 18.4 records it (`filing.submitted{form=form_582}` on the partner's fiscal year: ECRM confirmation captured, officer approval) together with the Subservicing screen's arrangements. */
export interface Form582FilingRecord { readonly form: "form_582"; readonly filing_id: string; readonly entity: "partner"; readonly period_end: PlainDate; readonly submitted_on: PlainDate; readonly ecrm_confirmation_document_id: string; readonly subservicing_arrangements: readonly { readonly subservicer_servicer_number: string; readonly status?: string }[]; readonly approved_by_officer_id?: string | null; }
/** A2-1-07: "the master servicer must confirm its existing subservicing arrangements when it submits the Lender Record Information (Form 582) each year" — after the partner's last batch has cut over, its next Form 582 (due FYE + 90 days, 18.4 rule 1) must no longer list Supermortgage as an active subservicer. Validates the 18.4 filing record and emits `form582.submitted{subservicer_removed}` on the batch whose close armed FNMA_A2_1_07_FORM582_TERMINATION_REFLECTED; `subservicer_removed=false` (Supermortgage still listed) is recorded too and leaves the timer armed for the partner officer (sev 3). */
export function form582TerminationReflected(i: { batch: TransferOutBatch; filing: Form582FilingRecord; supermortgage_servicer_number: string }): { batch_id: string; filing_id: string; subservicer_removed: boolean; still_listed: string[]; form582_due: PlainDate; on_time: boolean; event: OutEvent & { type: "form582.submitted" }; events: OutEvent[] } {
  const f = i.filing;
  if (f.form !== "form_582") throw new RangeError(`${String(f.form)} is not a Form 582 filing`);
  if (f.entity !== "partner") throw new RangeError("the Form 582 that reflects the termination is the partner's (the master servicer confirms its subservicing arrangements), not Supermortgage's");
  if (!f.filing_id || !f.ecrm_confirmation_document_id) throw new RangeError("18.4: a filing is submitted only with its ECRM confirmation document — filing_id and ecrm_confirmation_document_id are required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.period_end) || !/^\d{4}-\d{2}-\d{2}$/.test(f.submitted_on)) throw new RangeError("period_end and submitted_on must be dates");
  if (!/^\d{9}$/.test(i.supermortgage_servicer_number)) throw new RangeError("Supermortgage's Fannie Mae servicer number must be 9 digits");
  if (!Array.isArray(f.subservicing_arrangements)) throw new RangeError("the filing's subservicing arrangements (Form 582 Subservicing screen) are required");
  if (!i.batch.last_batch_for_partner) throw new RangeError(`batch ${i.batch.batch_id} is not the partner's last batch: the subservicing arrangement continues and the Form 582 confirmation is unchanged (A2-1-07)`);
  if (!["post_transfer", "retention", "closed"].includes(i.batch.status)) throw new RangeError(`batch ${i.batch.batch_id} has not cut over (${i.batch.status}): Supermortgage is still the subservicer the Form 582 must list`);
  const stillListed = f.subservicing_arrangements.filter((a) => a.subservicer_servicer_number === i.supermortgage_servicer_number && (a.status ?? "active") === "active").map((a) => a.subservicer_servicer_number);
  const removed = stillListed.length === 0;
  const due = addDays(f.period_end, 90);   // 18.4 rule 1: Form 582 due FYE + 90 calendar days, no business-day roll
  const payload = { batch_id: i.batch.batch_id, partner_id: i.batch.partner_id, form: f.form, filing_id: f.filing_id, entity: f.entity, period_end: f.period_end, submitted_on: f.submitted_on, ecrm_confirmation_document_id: f.ecrm_confirmation_document_id, approved_by_officer_id: f.approved_by_officer_id ?? null, subservicer_removed: removed, still_listed: stillListed, supermortgage_servicer_number: i.supermortgage_servicer_number, form582_due: due, on_time: f.submitted_on <= due };
  const event = { type: "form582.submitted" as const, payload };
  return { batch_id: i.batch.batch_id, filing_id: f.filing_id, subservicer_removed: removed, still_listed: stillListed, form582_due: due, on_time: f.submitted_on <= due, event, events: [event] };
}
/** Supermortgage disables the `fnma-*` adapters for the partner scope (partner CA removes Related-Party users and System IDs): `credentials.partner_scoped.revoked` satisfies SM_XFER_OUT_ACCESS_REVOCATION_5BD. */
export function partnerAccessRevocation(i: { partner_id: string; last_cutover_on: PlainDate; revoked_on: PlainDate; revocation_log_id: string; adapters: readonly string[]; related_party_users_removed: boolean }): { due: PlainDate; on_time: boolean; event: OutEvent & { type: "credentials.partner_scoped.revoked" } } {
  if (!i.revocation_log_id) throw new RangeError("the credential revocation log entry is required");
  const bad = i.adapters.filter((a) => !/^fnma-/.test(a)); if (bad.length) throw new RangeError(`only fnma-* adapters are partner-scoped: ${bad.join(",")}`);
  if (!i.related_party_users_removed) throw new RangeError("the partner Corporate Administrator removes Related-Party users and System IDs first (Technology Manager)");
  const due = addBusinessDays(i.last_cutover_on, 5, servicer);
  return { due, on_time: i.revoked_on <= due, event: { type: "credentials.partner_scoped.revoked", payload: { partner_id: i.partner_id, revoked_on: i.revoked_on, due, adapters: [...i.adapters], revocation_log_id: i.revocation_log_id } } };
}
/** Responses to Fannie Mae queries are drafts; any Fannie Mae correspondence is sent by the partner `officer`. */
export function fnmaResponseDraft(i: { batch_id: string; query: string; qx_request_id?: string | null }): { batch_id: string; to: typeof FNMA_SERVICING_TRANSFERS_MAILBOX; qx_request_id: string | null; status: "draft_pending_officer"; sent_by: "officer"; body: string } {
  if (!i.query.trim()) throw new RangeError("query text is required");
  return { batch_id: i.batch_id, to: FNMA_SERVICING_TRANSFERS_MAILBOX, qx_request_id: i.qx_request_id ?? null, status: "draft_pending_officer", sent_by: "officer", body: `Re: ${i.qx_request_id ?? i.batch_id} — ${i.query.trim()}` };
}
/** The officer sends the draft: `transfer.fnma_correspondence.sent`; an answered query returns the batch from `info_requested` to `submitted`. */
export function sendFnmaCorrespondence(draft: ReturnType<typeof fnmaResponseDraft>, i: { actor: Actor | null; sent_on: PlainDate; evidence_document_id?: string | null }): OutEvent & { type: "transfer.fnma_correspondence.sent" } {
  if (!isOfficer(i.actor)) throw new RangeError("any Fannie Mae correspondence is sent by the partner officer");
  return { type: "transfer.fnma_correspondence.sent", payload: { batch_id: draft.batch_id, to: draft.to, qx_request_id: draft.qx_request_id, sent_on: i.sent_on, sent_by: i.actor.id, evidence_document_id: i.evidence_document_id ?? null } };
}
/** Partner notifications only: "No borrower contact in 17.1". */
export function partnerNotification(i: { batch_id: string; subject: string; audience?: "partner" | "borrower" | null }): { batch_id: string; audience: "partner"; subject: string; event: "partner.notified" } {
  if (i.audience === "borrower") throw new RangeError("no borrower contact in 17.1 — borrower notices belong to 17.2");
  return { batch_id: i.batch_id, audience: "partner", subject: i.subject, event: "partner.notified" };
}
export const DECISION_FIELDS = ["batch_id", "direction", "transfer_type", "package_version", "checks_run", "deadline_table", "portal_task_ids", "rationale", "model_version", "rule_set_version"] as const;
/** Decision record: {batch_id, direction:'out', transfer_type, package_version, checks_run, deadline_table, portal_task_ids, rationale, model_version, rule_set_version}. */
export function decisionRecord(i: Record<string, unknown>): { ok: boolean; missing: string[]; record: Record<string, unknown> } {
  const missing = DECISION_FIELDS.filter((f) => i[f] === undefined || i[f] === null);
  if (i.direction !== undefined && i.direction !== "out") missing.push("direction");
  return { ok: missing.length === 0, missing: [...new Set(missing)], record: { ...i, direction: "out" } };
}
