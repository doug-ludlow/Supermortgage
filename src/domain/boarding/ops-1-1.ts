/**
 * §1.1 process operations that sit beside the BoardingService: what the `timer-sweep` does with a breached 1.1 timer
 * (the registry's breach column, per code) and the Bulletin 2020-02 post-transfer monitoring report the
 * SM_BOARD_POST_TRANSFER_MONITOR_180 clock exists for. Every action here is an event on the store plus, where the
 * breach column names a role, the role's escalation (src/app/escalations.ts) — never a remembered flag.
 *
 * Breach column, 1.1 timer table:
 *   SM_BOARD_FIRST_CYCLE            "sev 1 escalation; loan enters manual boarding; payment intake for the loan falls back to suspense (2.2)"
 *   SM_BOARD_EXCEPTION_SLA_2        "sev 2 → `officer` if money field"
 *   SM_BOARD_POST_TRANSFER_MONITOR_180 "Bulletin 2020-02 4–6-month monitoring report to `officer`"
 *   SM_BOARD_PRELIM_TAPE_14 / SM_BOARD_FINAL_TAPE_1 / LL_2026_05_… / MERS_PROC_… — the role in the column (escalateBreach)
 */
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { Breach, TimerEngine } from "../../kernel/timers/engine.ts";
import { type PlainDate, plainDate, parts } from "../../kernel/calendar/date.ts";
import { escalateBreach } from "../transfers/inbound.ts";
import { BOARDING_AGENT, type BoardingService, type BatchLoan } from "./service.ts";
import type { BoardingStatus } from "./machine.ts";

/** What escalateBreach needs (EscalationService or its Postgres-backed twin). */
export type EscalationOpener = Parameters<typeof escalateBreach>[0];

export interface BoardingOpsDeps { readonly events: EventStore; readonly esc: EscalationOpener; readonly svc: BoardingService; readonly timers?: TimerEngine; }

export interface BreachOutcome {
  readonly code: string;
  readonly escalation: { id: string; ownerRole: string; kind: string } | null;
  /** SM_BOARD_FIRST_CYCLE: the loan is now on the manual-boarding queue and its payments post to suspense until `loan.boarded`. */
  readonly manual_boarding: { batch_loan_id: string; payment_fallback: "suspense"; event_id: string } | null;
  readonly report: PostTransferMonitoringReport | null;
}

/**
 * The `timer-sweep`'s action for one breached 1.1 timer. Returns what was opened; throws on a breach that is not a 1.1 code.
 */
export function handleBoardingBreach(deps: BoardingOpsDeps, breach: Breach, by: Actor = BOARDING_AGENT): BreachOutcome {
  const code = breach.def.code;
  if (breach.def.process !== "1.1") throw new RangeError(`${code} is a ${breach.def.process} timer, not a 1.1 one`);
  const loanId = breach.instance.loanId;
  const batchId = breach.instance.subject.kind === "transfer_batch" ? breach.instance.subject.id : loanId ? deps.svc.batchLoan(loanId).batch_id : undefined;
  switch (code) {
    case "SM_BOARD_FIRST_CYCLE": {
      // "sev 1 escalation; loan enters manual boarding; payment intake for the loan falls back to suspense (2.2)"
      const bl = deps.svc.batchLoan(loanId!);
      const e = escalateBreach(deps.esc, breach, by, { ...(batchId ? { batchId } : {}) });
      const ev = deps.events.append({ type: "loan.boarding.manual_required", loanId: bl.id, aggregate: { kind: "transfer_batch", id: bl.batch_id }, actor: by,
        payload: { batch_loan_id: bl.id, transferor_loan_number: bl.staged.transferor_loan_number, fnma_loan_number: bl.staged.fnma_loan_number, timer_code: code, first_cycle_due: bl.first_cycle_due,
          boarding_status: bl.status, open_hard_failures: deps.svc.openHardFailures(bl).map((v) => v.code), escalation_id: e.id, payment_fallback: "suspense", reason: breach.breachText } });
      return { code, escalation: e, manual_boarding: { batch_loan_id: bl.id, payment_fallback: "suspense", event_id: ev.id }, report: null };
    }
    case "SM_BOARD_EXCEPTION_SLA_2": {
      // "sev 2 → `officer` if money field": a money-field failure past its SLA is the officer's (waiver or transferor escalation); a
      // non-money one stays a boarding work item (sev 3, ops analyst) — the agent may still correct it.
      const bl = deps.svc.batchLoan(loanId!);
      const open = deps.svc.openHardFailures(bl);
      const money = open.filter((v) => v.money_field).map((v) => v.code);
      if (money.length) {
        const e = escalateBreach(deps.esc, breach, by, { ...(batchId ? { batchId } : {}) });
        deps.events.append({ type: "loan.boarding_exception.escalated", loanId: bl.id, aggregate: { kind: "transfer_batch", id: bl.batch_id }, actor: by, payload: { batch_loan_id: bl.id, timer_code: code, escalation_id: e.id, owner_role: e.ownerRole, money_fields: money, open_hard_failures: open.map((v) => v.code) } });
        return { code, escalation: e, manual_boarding: null, report: null };
      }
      const e = deps.esc.open({ kind: "sev3", loanId: bl.id, ...(batchId ? { batchId } : {}), severity: "sev-3", slaTimerId: breach.instance.id,
        payload: { timer_code: code, timer_id: breach.instance.id, due_date: breach.instance.dueDate ?? null, breached_at: breach.instance.breachedAt ?? null, breach: breach.breachText, open_hard_failures: open.map((v) => v.code), money_fields: [] } }, by);
      return { code, escalation: { id: e.id, ownerRole: e.ownerRole, kind: e.kind }, manual_boarding: null, report: null };
    }
    case "SM_BOARD_POST_TRANSFER_MONITOR_180": {
      // "Bulletin 2020-02 4–6-month monitoring report to `officer`": the six-month de-brief goes to the officer with the escalation.
      const asOf = plainDate((breach.instance.breachedAt ?? breach.instance.armedAt).slice(0, 10));
      const report = postTransferMonitoringReport(deps, batchId!, asOf, by);
      const e = escalateBreach(deps.esc, breach, by, { batchId: batchId! });
      deps.events.append({ type: "transfer.post_transfer_monitoring.debrief", aggregate: { kind: "transfer_batch", id: batchId! }, actor: by, payload: { batch_id: batchId, escalation_id: e.id, owner_role: e.ownerRole, report_event_id: report.event_id, months_since_transfer: report.months_since_transfer } });
      return { code, escalation: e, manual_boarding: null, report };
    }
    default: {
      // SM_BOARD_PRELIM_TAPE_14 / SM_BOARD_FINAL_TAPE_1 / LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1 / MERS_PROC_REGISTER_UNREGISTERED_7: the role the column names.
      const e = escalateBreach(deps.esc, breach, by, { ...(batchId ? { batchId } : {}) });
      return { code, escalation: e, manual_boarding: null, report: null };
    }
  }
}

export interface PostTransferMonitoringReport {
  readonly batch_id: string; readonly as_of: PlainDate; readonly transfer_date: PlainDate; readonly months_since_transfer: number;
  readonly loans: Record<BoardingStatus, number>;
  readonly open_hard: Record<string, number>; readonly open_warnings: Record<string, number>;
  readonly breached_timers: { code: string; loan_id: string | null; due_date: PlainDate | null; status: string }[];
  readonly event_id: string;
}

/** Whole months from `from` to `to` (calendar arithmetic on the civil dates). */
export function monthsBetween(from: PlainDate, to: PlainDate): number {
  const a = parts(from), b = parts(to);
  const m = (b.y - a.y) * 12 + (b.m - a.m);
  return b.d < a.d ? m - 1 : m;
}

/**
 * Bulletin 2020-02 post-transfer monitoring (4–6 months): the monthly report on the batch — loans by boarding status, open
 * DQ failures by rule, the 1.1 timers that breached — appended as `transfer.post_transfer_monitoring.reported{month_n}`.
 */
export function postTransferMonitoringReport(deps: BoardingOpsDeps, batchId: string, asOf: PlainDate, by: Actor = BOARDING_AGENT): PostTransferMonitoringReport {
  const b = deps.svc.batch(batchId);
  if (asOf < b.transfer_date) throw new RangeError(`post-transfer monitoring for ${batchId} starts at the transfer date ${b.transfer_date}, not ${asOf}`);
  const card = deps.svc.scorecard(batchId);
  const loans = deps.svc.batchLoans(batchId);
  const ids = new Set(loans.map((l) => l.id));
  const breached = (deps.timers?.all() ?? []).filter((t) => (t.status === "breached" || t.status === "satisfied_late") && ((t.loanId && ids.has(t.loanId)) || (t.subject.kind === "transfer_batch" && t.subject.id === batchId)))
    .map((t) => ({ code: t.code, loan_id: t.loanId ?? null, due_date: t.dueDate ?? null, status: t.status }));
  const months = monthsBetween(b.transfer_date, asOf);
  const ev: DomainEvent = deps.events.append({ type: "transfer.post_transfer_monitoring.reported", aggregate: { kind: "transfer_batch", id: batchId }, actor: by,
    payload: { batch_id: batchId, as_of: asOf, transfer_date: b.transfer_date, month_n: months, loans: card.loans, open_hard: card.hard, open_warnings: card.warning, breached_timers: breached, basis: "CFPB Bulletin 2020-02 post-transfer monitoring (4–6 months)" } });
  return { batch_id: batchId, as_of: asOf, transfer_date: b.transfer_date, months_since_transfer: months, loans: card.loans, open_hard: card.hard, open_warnings: card.warning, breached_timers: breached, event_id: ev.id };
}

/** Loans of a batch still on the manual-boarding queue: a `loan.boarding.manual_required` with no later `loan.boarded`. */
export function manualBoardingQueue(events: EventStore, svc: BoardingService, batchId: string): BatchLoan[] {
  const required = new Set(events.all().filter((e) => e.type === "loan.boarding.manual_required" && e.aggregate?.id === batchId).map((e) => e.loanId!));
  return svc.batchLoans(batchId).filter((l) => required.has(l.id) && l.status !== "boarded" && l.status !== "reconciled" && l.status !== "active");
}
