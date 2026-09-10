/**
 * §13.2 Dual-tracking restriction — the event-emitting code paths of the process (the pure calculators stay in
 * ./ops.ts: `dualTrackHoldOpen`, `holdExitAndCertification`, `pendingMotion`, `performingHold`, …).
 *
 * - `recordSaleInstruction` — the 13.2 Outputs a counsel instruction produces on the platform: `CERTIFY_SALE` ⇒
 *   `foreclosure.sale.certified` (E-3.3-02 certification, window [sale − 15, sale − 7]; closes
 *   `FNMA_E3302_SALE_CERT_WINDOW_7_15`), `POSTPONE_SALE` ⇒ `foreclosure.sale.postpone_instructed` (and the open
 *   certification-window timer is cancelled — the sale it certified is no longer the sale), `WORKOUT_AGREED` /
 *   `REINSTATED` ⇒ `foreclosure.workout.firm_notified` (E-3.2-06, `FNMA_E3206_WORKOUT_NOTIFY_FIRM_2BD`).
 * - `ingestExecutedAgreement` — ingestion of the executed loss-mitigation agreement returned through the e-sign /
 *   document channel (12.x `lossmit.agreement.sent{channel=esign}` goes out; the executed copy comes back here):
 *   validates the record and appends `lossmit.agreement.executed` — the trigger of `FNMA_E3206_WORKOUT_NOTIFY_FIRM_2BD`
 *   ("notify the firm within two business days after … a workout arrangement has been agreed to", E-3.2-06).
 * - `ingestMafApproval` — ingestion of a mortgage-assistance-fund approval notice (E-3.2-07 / D2-3.1-05): validates
 *   the record, appends `maf.approval.received{notified_at}` (trigger of `FNMA_E3207_MAF_NOTICE_7`) and computes
 *   whether the sale is ≥7 days after the notice so that a postponement may be instructed.
 * - `appealWindowSweep` — the (g)(1) exit determination: "the borrower has not requested an appeal within the
 *   applicable time period" — `lossmit.appeal_window.closed{outcome=expired}` 14 calendar days after the denial with
 *   appeal rights (§1024.41(h)(1)), `{outcome=appeal_received}` when 12.x/1.7 recorded `lossmit.appeal.received`, and
 *   the immediate `foreclosure.hold.closed{reason=ineligible_notice_no_appeal}` when the appeal process is not
 *   applicable (tier < 90). Run on the 13.2 tool path before the §1024.41(g) gate is asserted.
 */
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { type PlainDate, plainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { certificationWindow } from "./gates.ts";

/** §1024.41(h)(1): 14 calendar days to appeal a denial (application received ≥90 days before a sale). */
export const APPEAL_WINDOW_DAYS = 14;
/** E-3.2-06: notify the firm within two servicer business days of a workout agreed / full reinstatement. */
export const WORKOUT_FIRM_NOTIFY_BD = 2;
/** E-3.2-07: a mortgage-assistance-fund approval notified ≥7 days before the sale permits a postponement. */
export const MAF_NOTICE_MIN_DAYS = 7;
/** E-3.3-02 sale certification letter (13.2 Outputs). */
export const SALE_CERT_DOCUMENT = "DOC_FC_SALE_CERT_E3302";

const isoDate = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? plainDate(v.slice(0, 10)) : null);

// ---- counsel instruction outputs ----------------------------------------------------------------------------------
export interface TimerCanceller { forSubject(kind: string, id: string): readonly { readonly id: string; readonly code: string; readonly status: string }[]; cancel(id: string, reason: string, actor?: Actor): void; }
export interface SaleInstructionInput {
  readonly loan_id: string; readonly instruction_id: string; readonly kind: string; readonly today: PlainDate;
  /** The case's scheduled sale, when one is known (13.6 milestone `foreclosure.sale.scheduled{sale_at}`). */
  readonly sale_at: PlainDate | null;
  /** `POSTPONE_SALE{until}` (13.2 Integrations). */
  readonly until?: PlainDate | null;
  readonly firm_id?: string | null;
}
export interface SaleInstructionOutcome { readonly event: DomainEvent | null; readonly in_window: boolean | null; readonly window: { opens: PlainDate; closes: PlainDate } | null; readonly cancelled_timer_ids: string[] }
/** Appends the 13.2 output event a counsel instruction produces (see the module note); other kinds append nothing. */
export function recordSaleInstruction(events: EventStore, actor: Actor, i: SaleInstructionInput, timers?: TimerCanceller): SaleInstructionOutcome {
  const window = i.sale_at ? certificationWindow(i.sale_at) : null;
  const inWindow = window ? i.today >= window.opens && i.today <= window.closes : null;
  const base = { instruction_id: i.instruction_id, firm_id: i.firm_id ?? null, sale_at: i.sale_at, instructed_on: i.today };
  if (i.kind === "CERTIFY_SALE") {
    const event = events.append({ type: "foreclosure.sale.certified", loanId: i.loan_id, actor, payload: { ...base, certified_on: i.today, document: SALE_CERT_DOCUMENT, window_opens_on: window?.opens ?? null, window_closes_on: window?.closes ?? null, in_window: inWindow, cite: "Servicing Guide E-3.3-02" } });
    return { event, in_window: inWindow, window, cancelled_timer_ids: [] };
  }
  if (i.kind === "POSTPONE_SALE" || i.kind === "CANCEL_SALE") {
    const cancelled: string[] = [];
    // The sale the certification window was measuring is postponed/cancelled: the E-3.3-02 clock is over for it (a
    // rescheduled sale arms a fresh window from `foreclosure.sale.rescheduled{sale_at}`).
    if (timers) for (const t of timers.forSubject("loan", i.loan_id)) if (t.code === "FNMA_E3302_SALE_CERT_WINDOW_7_15" && (t.status === "armed" || t.status === "breached")) { timers.cancel(t.id, `${i.kind} instructed ${i.today} (E-3.3-02: no certification while a workout is active)`, actor); cancelled.push(t.id); }
    const event = events.append({ type: i.kind === "POSTPONE_SALE" ? "foreclosure.sale.postpone_instructed" : "foreclosure.sale.cancel_instructed", loanId: i.loan_id, actor, payload: { ...base, until: i.until ?? null, in_window: inWindow, cite: "Servicing Guide E-3.3-02; 12 CFR 1024.41(g) comment 41(g)-3" } });
    return { event, in_window: inWindow, window, cancelled_timer_ids: cancelled };
  }
  if (i.kind === "WORKOUT_AGREED" || i.kind === "REINSTATED") {
    const event = events.append({ type: "foreclosure.workout.firm_notified", loanId: i.loan_id, actor, payload: { ...base, kind: i.kind, notified_on: i.today, cite: "Servicing Guide E-3.2-06" } });
    return { event, in_window: inWindow, window, cancelled_timer_ids: [] };
  }
  return { event: null, in_window: inWindow, window, cancelled_timer_ids: [] };
}

// ---- executed workout agreement (E-3.2-06) -------------------------------------------------------------------------
export type AgreementKind = "modification" | "trial_period_plan" | "repayment_plan" | "forbearance" | "payment_deferral" | "short_sale" | "mortgage_release";
export const AGREEMENT_KINDS: readonly AgreementKind[] = ["modification", "trial_period_plan", "repayment_plan", "forbearance", "payment_deferral", "short_sale", "mortgage_release"];
export interface ExecutedAgreementRecord {
  readonly loan_id: string; readonly agreement_id: string; readonly kind: AgreementKind | string;
  /** The date the arrangement was agreed (the later of the borrower's and the servicer's execution). */
  readonly executed_on: PlainDate | string;
  readonly channel?: "esign" | "mail" | "in_person" | string; readonly document_id?: string | null; readonly case_id?: string | null;
}
export interface ExecutedAgreementIngestion { readonly event: DomainEvent; readonly executed_on: PlainDate; readonly firm_notify_by: PlainDate; readonly timer: "FNMA_E3206_WORKOUT_NOTIFY_FIRM_2BD"; readonly instruction: { kind: "WORKOUT_AGREED"; to: "firm"; due: PlainDate } }
/** Validates the executed-agreement record and appends `lossmit.agreement.executed` (arms FNMA_E3206_WORKOUT_NOTIFY_FIRM_2BD). */
export function ingestExecutedAgreement(events: EventStore, actor: Actor, r: ExecutedAgreementRecord): ExecutedAgreementIngestion {
  if (!r.loan_id) throw new RangeError("loan_id is required");
  if (!r.agreement_id) throw new RangeError("agreement_id is required");
  if (!AGREEMENT_KINDS.includes(r.kind as AgreementKind)) throw new RangeError(`agreement kind ${String(r.kind)} is not one of ${AGREEMENT_KINDS.join(", ")}`);
  const executedOn = isoDate(r.executed_on); if (!executedOn) throw new RangeError("executed_on must be a date");
  const due = addBusinessDays(executedOn, WORKOUT_FIRM_NOTIFY_BD, servicer);
  const event = events.append({ type: "lossmit.agreement.executed", loanId: r.loan_id, ...(r.case_id ? { aggregate: { kind: "case", id: r.case_id } } : {}), actor,
    payload: { agreement_id: r.agreement_id, kind: r.kind, executed_on: executedOn, channel: r.channel ?? "esign", document_id: r.document_id ?? null, firm_notify_by: due, cite: "Servicing Guide E-3.2-06" } });
  return { event, executed_on: executedOn, firm_notify_by: due, timer: "FNMA_E3206_WORKOUT_NOTIFY_FIRM_2BD", instruction: { kind: "WORKOUT_AGREED", to: "firm", due } };
}

// ---- mortgage assistance fund approval (E-3.2-07) ------------------------------------------------------------------
export interface MafApprovalRecord {
  readonly loan_id: string; readonly program: string; readonly approval_id: string;
  readonly approved_on: PlainDate | string;
  /** When the servicer was notified (the anchor of FNMA_E3207_MAF_NOTICE_7). */
  readonly notified_at: string;
  readonly amount_cents?: bigint | null;
  /** The scheduled sale, when one is known. */
  readonly sale_at?: PlainDate | string | null;
}
export interface MafApprovalIngestion { readonly event: DomainEvent; readonly notified_on: PlainDate; readonly days_before_sale: number | null; readonly postponement_permitted: boolean; readonly timer: "FNMA_E3207_MAF_NOTICE_7"; readonly instruction: { kind: "POSTPONE_SALE"; to: "firm"; due: PlainDate } | null; readonly hold_kind: "fnma_maf_7" | null }
/** Validates the MAF approval record and appends `maf.approval.received{notified_at}`; a sale ≥7 days after the notice permits the postponement (evaluator `13.2.saleAtLeast7DaysAfterMafNotice`). */
export function ingestMafApproval(events: EventStore, actor: Actor, r: MafApprovalRecord): MafApprovalIngestion {
  if (!r.loan_id) throw new RangeError("loan_id is required");
  if (!r.program) throw new RangeError("program is required");
  if (!r.approval_id) throw new RangeError("approval_id is required");
  const approvedOn = isoDate(r.approved_on); if (!approvedOn) throw new RangeError("approved_on must be a date");
  const notifiedOn = isoDate(r.notified_at); if (!notifiedOn || Number.isNaN(Date.parse(r.notified_at))) throw new RangeError("notified_at must be an ISO date or timestamp");
  if (r.amount_cents !== undefined && r.amount_cents !== null && r.amount_cents < 0n) throw new RangeError("amount_cents must not be negative");
  const saleAt = r.sale_at ? isoDate(r.sale_at) : null;
  const days = saleAt ? daysBetween(notifiedOn, saleAt) : null;
  const permitted = days !== null && days >= MAF_NOTICE_MIN_DAYS;
  const event = events.append({ type: "maf.approval.received", loanId: r.loan_id, actor,
    payload: { approval_id: r.approval_id, program: r.program, approved_on: approvedOn, notified_at: r.notified_at, maf_notified_on: notifiedOn, amount_cents: r.amount_cents === undefined || r.amount_cents === null ? null : r.amount_cents.toString(), sale_at: saleAt, sale_date: saleAt, days_before_sale: days, postponement_permitted: permitted, cite: "Servicing Guide E-3.2-07 / D2-3.1-05" } });
  return { event, notified_on: notifiedOn, days_before_sale: days, postponement_permitted: permitted, timer: "FNMA_E3207_MAF_NOTICE_7", instruction: permitted ? { kind: "POSTPONE_SALE", to: "firm", due: addBusinessDays(notifiedOn, 1, servicer) } : null, hold_kind: permitted ? "fnma_maf_7" : null };
}

// ---- (g)(1) exit: the appeal window ---------------------------------------------------------------------------------
export interface AppealWindowApplication {
  readonly id: string;
  /** The (c)(1)(ii) denial: `lossmit.determination.sent` date (12.x row column `determination_sent_on` / `denial_sent_on`). */
  readonly determination_sent_on: PlainDate | string | null;
  /** §1024.41(h)(1): appeal rights only when the complete application was received ≥90 days before a sale (tier `g_full_90`). */
  readonly appeal_available: boolean | null;
  readonly appeal_received_on?: PlainDate | string | null;
  readonly exit?: string | null;
}
export type AppealWindowOutcome = "appeal_received" | "expired" | "not_applicable";
export interface AppealWindowClosure { readonly application_id: string; readonly outcome: AppealWindowOutcome; readonly closed_on: PlainDate; readonly window_closes_on: PlainDate | null; readonly exit: "ineligible_notice_no_appeal" | null; readonly event: DomainEvent }
/**
 * Closes the appeal window for each denied application (idempotent — a window already closed on the event log is
 * skipped): an appeal on file ⇒ `lossmit.appeal_window.closed{outcome=appeal_received}` (hold_appeal continues until
 * 12.x decides); no appeal by denial + 14 calendar days ⇒ `{outcome=expired}` and the (g)(1) exit
 * `ineligible_notice_no_appeal`; no appeal right ⇒ the hold closes on the denial date (13.2-T2).
 */
export function appealWindowSweep(events: EventStore, actor: Actor, i: { loan_id: string; today: PlainDate; applications: readonly AppealWindowApplication[] }): { closed: AppealWindowClosure[] } {
  const already = new Set(events.ofType("lossmit.appeal_window.closed").filter((e) => e.loanId === i.loan_id).map((e) => String(e.payload.application_id)));
  const closedHolds = new Set(events.ofType("foreclosure.hold.closed").filter((e) => e.loanId === i.loan_id && e.payload.reason === "ineligible_notice_no_appeal").map((e) => String(e.payload.application_id)));
  const appealsOnLog = events.ofType("lossmit.appeal.received").filter((e) => e.loanId === i.loan_id);
  const closed: AppealWindowClosure[] = [];
  for (const a of i.applications) {
    const sent = isoDate(a.determination_sent_on); if (!sent || a.exit) continue;
    if (a.appeal_available === false) {
      if (closedHolds.has(a.id)) continue;
      const event = events.append({ type: "foreclosure.hold.closed", loanId: i.loan_id, actor, payload: { kind: "regx_g_dual_track", application_id: a.id, reason: "ineligible_notice_no_appeal", closed_on: sent, cite: "12 CFR 1024.41(g)(1): ineligible notice sent and the appeal process is not applicable" } });
      closed.push({ application_id: a.id, outcome: "not_applicable", closed_on: sent, window_closes_on: null, exit: "ineligible_notice_no_appeal", event });
      continue;
    }
    if (a.appeal_available !== true || already.has(a.id)) continue;
    const windowCloses = addDays(sent, APPEAL_WINDOW_DAYS);
    const appealOn = isoDate(a.appeal_received_on) ?? appealsOnLog.map((e) => isoDate(e.payload.appeal_received_at) ?? isoDate(e.occurredAt)).find((d) => d !== null) ?? null;
    if (appealOn && appealOn <= windowCloses) {
      const event = events.append({ type: "lossmit.appeal_window.closed", loanId: i.loan_id, actor, payload: { application_id: a.id, outcome: "appeal_received", appeal_received_on: appealOn, window_closes_on: windowCloses, closed_on: appealOn, cite: "12 CFR 1024.41(h)(1)" } });
      closed.push({ application_id: a.id, outcome: "appeal_received", closed_on: appealOn, window_closes_on: windowCloses, exit: null, event });
    } else if (i.today > windowCloses) {
      const event = events.append({ type: "lossmit.appeal_window.closed", loanId: i.loan_id, actor, payload: { application_id: a.id, outcome: "expired", window_closes_on: windowCloses, closed_on: addDays(windowCloses, 1), cite: "12 CFR 1024.41(g)(1): no appeal requested within the applicable time period" } });
      events.append({ type: "foreclosure.hold.closed", loanId: i.loan_id, actor, causationId: event.id, payload: { kind: "regx_g_dual_track", application_id: a.id, reason: "appeal_window_expired", closed_on: addDays(windowCloses, 1), cite: "12 CFR 1024.41(g)(1)" } });
      closed.push({ application_id: a.id, outcome: "expired", closed_on: addDays(windowCloses, 1), window_closes_on: windowCloses, exit: "ineligible_notice_no_appeal", event });
    }
  }
  return { closed };
}
/** The 12.x application row's appeal-window facts (column spellings the 12.x tools write). */
export function appealWindowFacts(id: string, d: Record<string, unknown>): AppealWindowApplication {
  return { id, determination_sent_on: isoDate(d.determination_sent_on) ?? isoDate(d.denial_sent_on) ?? isoDate(d.determination_sent_at), appeal_available: typeof d.appeal_available === "boolean" ? d.appeal_available : null, appeal_received_on: isoDate(d.appeal_received_on) ?? isoDate(d.appeal_received_at), exit: typeof d.exit === "string" && d.exit ? d.exit : null };
}
