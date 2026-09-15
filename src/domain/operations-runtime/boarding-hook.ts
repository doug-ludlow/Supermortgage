/**
 * §35.5 rules 1 and 9 at `loan.boarded`, on both boarding paths, in the boarding transaction:
 *
 *   onLoanBoardedProject(q, ctx, facts, deps)   the schedule (installments.ts projectBoarding) then the servicing configuration
 *                                               (servicing-config.ts projectServicingConfig): the two events on the boarding log
 *                                               (`installment.schedule.written`, `loan.servicing_config.written` — the two AT_BOARD_0 clocks),
 *                                               the two decisions prepared, the rows projected. A refusal (SCHEDULE_REQUIRED, CONFIG_REQUIRED)
 *                                               is a CommandRefused: the fund route rolls its unit of work back (409), a transfer batch rolls
 *                                               back whole (stricter than the spec's per-loan wording; recorded in the build plan §9 R6).
 *   onLoanBoardedPersist(q, decisions, p)       the typed rows in the same transaction, after the `loans` / `loan_terms` rows exist: the
 *                                               decisions (ids known to the rows), the run, the installments, the config row.
 *
 * Fund path: src/runtime/origination.ts fundApplication — project in the unit-of-work body after boardFundedApplication, persist in its
 * `commit` hook (the `before` hook wrote loans/loan_terms). Transfer path: src/runtime/transfers.ts boardTransferBatch — both inside the
 * batch's db.tx right after the loan_terms INSERT, against the batch's in-memory event store / engine (persisted with the batch).
 */
import type { Queryable } from "../../infra/db/client.ts";
import type { PgDecisionRepository } from "../../infra/db/decisions.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { projectBoarding, persistBoardingSchedule, type BoardingProjectionContext, type BoardingProjectionDeps, type BoardingScheduleFacts, type ProjectedSchedule } from "./installments.ts";
import { projectServicingConfig, persistProjectedConfig, type ProjectedConfig } from "./servicing-config.ts";

export interface BoardedLoanFacts extends BoardingScheduleFacts {
  /** properties.state — rule 9's jurisdiction and the state → time zone map. */
  readonly state: string | null;
  /** The note's late charge terms (loan_terms.late_charge_pct_bps ÷ 1000 as "5.000"; grace days). */
  readonly late_charge_pct: string;
  readonly late_charge_grace_days: number;
  /** The boarding date (the config row's effective_from; the profile in force that day). */
  readonly boarded_on: PlainDate;
}
export interface BoardingProjection { readonly schedule: ProjectedSchedule; readonly config: ProjectedConfig; }

export async function onLoanBoardedProject(q: Queryable, ctx: BoardingProjectionContext, f: BoardedLoanFacts, deps: BoardingProjectionDeps): Promise<BoardingProjection> {
  const schedule = projectBoarding(ctx, f, deps);
  const config = await projectServicingConfig(q, ctx, { loan_id: f.loan_id, state: f.state, late_charge_pct: f.late_charge_pct, late_charge_grace_days: f.late_charge_grace_days, effective_from: f.boarded_on }, deps);
  return { schedule, config };
}

export async function onLoanBoardedPersist(q: Queryable, decisions: PgDecisionRepository, p: BoardingProjection): Promise<{ terms_id: string | null }> {
  const { terms_id } = await persistBoardingSchedule(q, decisions, p.schedule);
  await persistProjectedConfig(q, decisions, p.config);
  return { terms_id };
}
