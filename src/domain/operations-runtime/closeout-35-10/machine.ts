/**
 * §35.10 State machine — the closeout's step order and its off-path transitions as pure functions over the row and the
 * events folded since `last_event_sequence`. Nothing here reads a figure: the machine decides which owning command runs next;
 * the commands are the owners' (16.1, 16.2, 16.3, 24.4, 3.5, 30.3, 33.1, 26.3, 2.1).
 */
import type { DomainEvent } from "../../../kernel/events/index.ts";
import type { CloseoutMode, CloseoutRow, CloseoutStep, PriorStatus } from "./types.ts";
import { STEP_ORDER } from "./types.ts";

/** Rule 1: the mode is the prior loan's status, read once. */
export function modeFor(status: string): { mode: CloseoutMode; prior_status: PriorStatus } | { cancel: "prior_not_retirable"; status: string } {
  if (status === "active") return { mode: "serviced_same_servicer", prior_status: "active" };
  if (status === "monitored") return { mode: "monitored_partner", prior_status: "monitored" };
  return { cancel: "prior_not_retirable", status };
}
export const stepIndex = (s: CloseoutStep): number => STEP_ORDER.indexOf(s);
export const before = (a: CloseoutStep, b: CloseoutStep): boolean => stepIndex(a) < stepIndex(b);
/** The events that unwind a closeout before `settling` (Inputs and triggers; 26.3's `funding.cancelled`, 25.3's `rescission.exercised`, 21.x's withdrawal, 23.3's final adverse event). */
export const UNWIND_EVENTS: ReadonlySet<string> = new Set(["rescission.exercised", "funding.cancelled", "application.withdrawn", "adverse_decision.handed_off", "orchestration.unwind"]);
export const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const at = (e: DomainEvent | null | undefined): string | null => e?.id ?? null;

export interface Folded {
  readonly scheduled: DomainEvent | null;        // closing.scheduled (26.2)
  readonly resynced: DomainEvent | null;         // funding.date.resynced (26.3), the latest
  readonly funded: DomainEvent | null;           // loan.funded (26.3, application-scoped)
  readonly confirmed: DomainEvent | null;        // funding.disbursement.confirmed{evidence_document_id}
  readonly paidInFull: DomainEvent | null;       // loan.paid_in_full (16.2, the prior loan)
  readonly staged: DomainEvent | null;           // loan.staged (30.2) — names the new loan
  readonly recorded: DomainEvent | null;         // lien_release.recorded (16.3)
  readonly reversed: DomainEvent | null;         // payoff.reversed (16.2)
  readonly unwind: DomainEvent | null;           // the first unwind trigger
  readonly partnerConfirmed: DomainEvent | null; // partner_book.retirement.confirmed
  readonly disposeVariance: DomainEvent | null;  // 16.2 disposeVariance ran (payoff.shortage.resolved)
}
/** Fold the closeout's own subject: the prior loan's events and the application's, newest state per kind. */
export function fold(events: readonly DomainEvent[], c: Pick<CloseoutRow, "prior_loan_id" | "application_id">): Folded {
  const mine = events.filter((e) => e.loanId === c.prior_loan_id || e.applicationId === c.application_id);
  const last = (type: string, where: (e: DomainEvent) => boolean = () => true): DomainEvent | null => [...mine].reverse().find((e) => e.type === type && where(e)) ?? null;
  const first = (where: (e: DomainEvent) => boolean): DomainEvent | null => mine.find(where) ?? null;
  const app = (e: DomainEvent) => e.applicationId === c.application_id;
  const prior = (e: DomainEvent) => e.loanId === c.prior_loan_id;
  return {
    scheduled: last("closing.scheduled", app), resynced: last("funding.date.resynced", app), funded: last("loan.funded", app), confirmed: last("funding.disbursement.confirmed", app),
    paidInFull: last("loan.paid_in_full", prior), staged: last("loan.staged", app), recorded: last("lien_release.recorded", prior), reversed: last("payoff.reversed", prior),
    unwind: first((e) => app(e) && UNWIND_EVENTS.has(e.type)), partnerConfirmed: last("partner_book.retirement.confirmed", prior), disposeVariance: last("payoff.shortage.resolved", prior),
  };
}
export type Next =
  | { readonly kind: "run"; readonly tool: "closeout.quote" | "closeout.settle" | "closeout.escrow" | "closeout.retire" | "closeout.lien_release" | "closeout.notify_partner" | "closeout.confirm_partner"; readonly trigger: string | null; readonly reason: string }
  | { readonly kind: "unwind"; readonly trigger: string; readonly reason: string }
  | { readonly kind: "reverse"; readonly trigger: string }
  | { readonly kind: "wait"; readonly waiting_on: string | null; readonly reason: string };
/** What the pass runs next for an open closeout (rule 10; the state machine). `held` rows wait for closeout.resume or the condition to clear. */
/** `refundDue`: null when no refund is elected or it issued; false while 3.5's 5-BD in-flight hold runs; true once the gate is open and the refund has not issued. */
export function next(c: CloseoutRow, f: Folded, opts: { newLoanLinked: boolean; goodThroughCovers: boolean | null; disposed: boolean; refundDue?: boolean | null }): Next {
  if (c.status === "held") return { kind: "wait", waiting_on: c.waiting_on, reason: `held{${c.hold_reason ?? "manual"}}` };
  if (f.unwind && before(c.step, "settling")) return { kind: "unwind", trigger: f.unwind.id, reason: f.unwind.type };
  if (f.reversed && !before(c.step, "settled") && c.step !== "settling" && c.settlement_id) return { kind: "reverse", trigger: f.reversed.id };
  switch (c.step) {
    case "opened": case "awaiting_schedule":
      if (f.scheduled) return { kind: "run", tool: "closeout.quote", trigger: f.scheduled.id, reason: "closing.scheduled: the projected disbursement date is known" };
      if (f.funded) return { kind: "run", tool: "closeout.quote", trigger: f.funded.id, reason: "loan.funded with no closing schedule on the record (the fund bridge's direct path): the disbursement date is the funding date" };
      return { kind: "wait", waiting_on: "26.2", reason: "the application's own pipeline (closing.scheduled)" };
    case "quoted":
      // a disbursement past the quote's good-through (26.3's resync, or the funding itself landing later) re-runs the quote before anything settles (rule 2: the figure at the disbursement date is 16.1's / 24.4's, never a stale one)
      if (opts.goodThroughCovers === false) return { kind: "run", tool: "closeout.quote", trigger: (f.resynced ?? f.funded)?.id ?? null, reason: `${f.resynced ? "funding.date.resynced" : "the disbursement date"} past good-through: the quote re-runs` };
      if (f.funded && f.confirmed) return { kind: "run", tool: "closeout.settle", trigger: f.funded.id, reason: "loan.funded + funding.disbursement.confirmed" };
      return { kind: "wait", waiting_on: "rescission_window", reason: "35.6 owns the wait to loan.funded" };
    case "settling":
      if (c.mode === "serviced_same_servicer" && c.funds_id && !f.paidInFull && !opts.disposed) return { kind: "wait", waiting_on: "officer", reason: "16.2 found a variance nobody disposed (disposeVariance is the officer's)" };
      // after an officer's reversal (16.2 rule 6) the returned funds are gone: the settlement waits on the officer (new funds, or closeout.resume), never a second transfer on its own
      if (f.reversed && !c.funds_id && !c.settlement_id && c.waiting_on === "officer") return { kind: "wait", waiting_on: "officer", reason: "payoff.reversed: the officer decides how the settlement resumes" };
      return { kind: "run", tool: "closeout.settle", trigger: at(f.funded), reason: "settle the prior loan from the settlement statement's payoff line" };
    case "settled": return { kind: "run", tool: "closeout.escrow", trigger: at(f.paidInFull ?? f.confirmed), reason: "dispose the escrow as the borrower elected" };
    case "escrow_disposed": return { kind: "run", tool: "closeout.retire", trigger: at(f.paidInFull ?? f.confirmed), reason: "retire the prior loan on the owner's settlement event" };
    case "retired": return c.mode === "serviced_same_servicer" ? { kind: "run", tool: "closeout.lien_release", trigger: at(f.paidInFull), reason: "open 16.3's release" } : { kind: "run", tool: "closeout.notify_partner", trigger: null, reason: "tell the partner the same day" };
    case "released_or_confirmed":
      if (c.mode === "serviced_same_servicer") return f.recorded ? { kind: "run", tool: "closeout.lien_release", trigger: f.recorded.id, reason: "lien_release.recorded moves the closeout on" } : { kind: "wait", waiting_on: c.waiting_on ?? "signing_officer", reason: "16.3's clocks own the release" };
      return f.partnerConfirmed ? { kind: "run", tool: "closeout.confirm_partner", trigger: f.partnerConfirmed.id, reason: "the partner confirmed" } : { kind: "run", tool: "closeout.confirm_partner", trigger: null, reason: "read the partner's tape" };
    case "linked":
      if (opts.refundDue === true) return { kind: "run", tool: "closeout.escrow", trigger: null, reason: "the 5-BD in-flight hold elapsed: 3.5's refund issues, then the closeout completes" };
      if (opts.refundDue === false) return { kind: "wait", waiting_on: "3.5", reason: "3.5's 5-BD in-flight hold before the escrow refund" };
      return { kind: "run", tool: "closeout.retire", trigger: null, reason: "every step done: complete" };
    default: return { kind: "wait", waiting_on: c.waiting_on, reason: `step ${c.step}` };
  }
}
/** Three failures on one step → held{attempts} (rule 10). */
export const MAX_ATTEMPTS = 3;
