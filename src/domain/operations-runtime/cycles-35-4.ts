/**
 * §35.4 — what this process supplies to 35.3's registry (35.3 rule 2: "A cycle owned by … 35.4 is registered here with its
 * runner name; that process supplies the runner"; 35.4 discrepancy 6: `ledger_period_close`, `form_496a_monthly` and
 * `star_monthly` are rows of 35.3's table with this process as runner owner, and cycles.ts names 35.4 as `owner_process` of
 * `investor_period_close` and `form_496_monthly` too). Each is a `pass` runner (35.3 D5): the owning section's own command
 * through close-35-4/runners.ts CLOSE_RUNNERS as the owner's actor, un-nested, then 35.3's bookkeeping unit of work
 * (service.ts runClaimed). runners.ts attaches them to RUNNERS; the close chain (close-35-4/plan.ts, ports.ts) plans the
 * steps as these cycles' jobs and 35.3's executor runs them.
 *
 *   ledger_period_close     6.3's month-end cut-off per custodial account (`timer.*{op: close_period}` → `ledger.period.closed`;
 *                           a clearing account has no cut-off of 6.3's — the unit is `skipped`)
 *   investor_period_close   5.1's BD2 close (`closeReportingPeriod` → `investor_reporting_periods.closed{checklist_complete}`)
 *   form_496_monthly        6.3's Form 496 per (P&I account × remittance type) from the chain's own figures once the close
 *                           period exists (the statement of record — else the custodial bank port's prior-day statement, the
 *                           FAKE in every build stage — the in-transit register, 6.3's composition rows, the cashbook; rule 7's
 *                           officer record → complete, else drafted for 6.3's own review); 35.3's interim unit
 *                           (runners.ts form496MonthlyRunner) for a period the chain has not opened (35.3-T6)
 *   form_496a_monthly       6.4's Form 496A per T&I account when `form496a.generate` is on the bus; the FAKE neighbour's
 *                           stand-in receipt where it is not (nonprod with the FAKE reviewers on — close-35-4/fake-neighbours.ts);
 *                           else `runner_missing` (dead on the first claim, labelled — 35.3 edge case 3)
 *   star_monthly            18.3's compute → `star.metrics.computed{as_of_month}` as qc-audit
 *
 * A unit's ids and dates are 35.3's selectors' (`custodial_accounts`, `pi_accounts_by_remittance`, `ti_accounts`, `period`);
 * a P&I unit's remittance type is resolved to the chain's own unit (close-35-4/open.ts piUnits — the type 6.3 booked the
 * period's components under) so the figures and the officer's record are the attestation's. The modules are dereferenced at
 * run time only: runners.ts → this file → close-35-4 → ports.ts → service.ts → runners.ts is an import cycle.
 */
import type { NamedRunner, UnitContext } from "./cycles.ts";
import * as close from "./close-35-4/runners.ts";
import * as fakes from "./close-35-4/fake-neighbours.ts";
import { closePorts } from "./close-35-4/ports.ts";
import { periodByKey, stepOf } from "./close-35-4/store.ts";
import { piUnits } from "./close-35-4/open.ts";

const unitOf = (unit: UnitContext, extra: Record<string, unknown> = {}): { unit_id: string; period_key: string; input: Record<string, unknown> } =>
  ({ unit_id: unit.unit_id, period_key: unit.period_key, input: { ...unit.input, period_end: unit.period_end, as_of_date: unit.as_of_date, ...(typeof unit.input["kind"] === "string" ? { account_kind: unit.input["kind"] } : {}), ...extra } });
const asOutcome = (r: close.RunnerOutcome): { outcome: string; detail?: string } => ({ outcome: r.outcome, ...(r.detail ? { detail: r.detail } : {}) });
const closeRunner = (code: string, name: string): NamedRunner => ({ name, runner: { mode: "pass", run: async (rt, unit) => asOutcome(await close.CLOSE_RUNNERS[code]!(rt, unitOf(unit), rt.clock.now())) } });

export const ledgerPeriodCloseRunner: NamedRunner = closeRunner("ledger_period_close", "closeLedgerPeriodCloseRunner");
export const investorPeriodCloseRunner: NamedRunner = closeRunner("investor_period_close", "closeInvestorPeriodCloseRunner");
export const starMonthlyRunner: NamedRunner = closeRunner("star_monthly", "closeStarMonthlyRunner");

export const form496aMonthlyRunner: NamedRunner = { name: "closeForm496aMonthlyRunner", runner: { mode: "pass", run: async (rt, unit) => {
  if (rt.tool("6.4", "form496a.generate")) return asOutcome(await close.CLOSE_RUNNERS["form_496a_monthly"]!(rt, unitOf(unit), rt.clock.now()));
  const fake = (await fakes.fakeNeighbourRunners(rt))["form_496a_monthly"];
  if (!fake) throw new Error("runner_missing: 6.4's form496a.generate is not on the bus (spec/registry/agents.json's 6.4 row is empty — src/app/tools/section06.ts) and no FAKE neighbour stands in on this runtime");
  return asOutcome(await fake(rt, unitOf(unit), rt.clock.now()));
} } };

/** 6.3's Form 496 unit: the chain's own figures for a period the close has opened, else 35.3's interim unit (`interim`). */
export const form496MonthlyRunnerOf = (interim: NamedRunner): NamedRunner => ({ name: "closeForm496MonthlyRunner", runner: { mode: "pass", run: async (rt, unit) => {
  const servicer = await closePorts(rt).servicer.servicerNumber(rt.db);
  const period = /^\d{4}-\d{2}$/.test(unit.period_key) ? await periodByKey(rt.db, "month", unit.period_key, servicer) : undefined;
  if (!period || !(await stepOf(rt.db, period.id, "form496"))) {
    if (interim.runner.mode !== "pass") throw new Error("pass_runner_in_command: the interim Form 496 unit is a pass runner");
    return interim.runner.run(rt, unit);
  }
  const account = String(unit.input["custodial_account_id"] ?? unit.unit_id.split(":")[0] ?? ""); const jobType = typeof unit.input["remittance_type"] === "string" ? unit.input["remittance_type"] : null;
  const units = await piUnits(rt.db, period.period);
  const own = units.find((u) => u.custodial_account_id === account && u.remittance_type === jobType) ?? units.find((u) => u.custodial_account_id === account);
  return asOutcome(await close.CLOSE_RUNNERS["form_496_monthly"]!(rt, unitOf(unit, { custodial_account_id: account, remittance_type: own?.remittance_type ?? jobType ?? "S/S" }), rt.clock.now()));
} } });
