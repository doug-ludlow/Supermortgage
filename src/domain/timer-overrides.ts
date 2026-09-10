/**
 * Applies every section's registry overrides to a `TimerRegistry`. The spec
 * registry (spec/registry/timers.json) is never edited: rows whose offset or
 * trigger columns are prose get a cited override in the owning section's
 * `timers.ts`, and this module is the one place that wires them all in.
 */
import type { TimerRegistry } from "../kernel/timers/registry.ts";
import { loadRegistry } from "../kernel/timers/registry.ts";
import { applyBoardingTimerOverrides } from "./boarding/timers.ts";
import { applyTransferTimerOverrides } from "./transfers/timers.ts";
import { applyCashieringTimerOverrides } from "./cashiering/timers.ts";
import { applyEscrowTimerOverrides } from "./escrow/timers.ts";
import { applyServicingRequestTimerOverrides } from "./servicing-requests/timers.ts";
import { applyInvestorTimerOverrides } from "./investor/timers.ts";
import { applyCustodialTimerOverrides } from "./custodial/timers.ts";
import { applyNoticeTimerOverrides } from "./notices/timers.ts";
import { applyCreditReportingTimerOverrides } from "./credit-reporting/timers.ts";
import { applyInsuranceTimerOverrides } from "./insurance/timers.ts";
import { applyPmiTimerOverrides } from "./pmi/timers.ts";
import { applyEarlyInterventionTimerOverrides } from "./early-intervention/timers.ts";
import { applyLossmitTimerOverrides } from "./lossmit/timers.ts";
import { applyForeclosureTimerOverrides } from "./foreclosure/timers.ts";
import { applyBankruptcyTimerOverrides } from "./bankruptcy/timers.ts";
import { applyReoTimerOverrides } from "./reo/timers.ts";
import { applyPayoffTimerOverrides } from "./payoff/timers.ts";
import { applyQcAuditTimerOverrides } from "./qc-audit/timers.ts";
import { applyDataSecurityTimerOverrides } from "./data-security/timers.ts";

export const SECTION_OVERRIDES: ReadonlyArray<readonly [section: string, apply: (reg: TimerRegistry) => void]> = [
  ["1.1", applyBoardingTimerOverrides],
  ["1.2–1.7, 17", applyTransferTimerOverrides],
  ["2", applyCashieringTimerOverrides],
  ["3", applyEscrowTimerOverrides],
  ["4", applyServicingRequestTimerOverrides],
  ["5", applyInvestorTimerOverrides],
  ["6", applyCustodialTimerOverrides],
  ["7", applyNoticeTimerOverrides],
  ["8", applyCreditReportingTimerOverrides],
  ["9", applyInsuranceTimerOverrides],
  ["10", applyPmiTimerOverrides],
  ["11", applyEarlyInterventionTimerOverrides],
  ["12", applyLossmitTimerOverrides],
  ["13", applyForeclosureTimerOverrides],
  ["14", applyBankruptcyTimerOverrides],
  ["15", applyReoTimerOverrides],
  ["16", applyPayoffTimerOverrides],
  ["18", applyQcAuditTimerOverrides],
  ["19", applyDataSecurityTimerOverrides],
];

export function applyAllTimerOverrides(reg: TimerRegistry): TimerRegistry {
  for (const [, apply] of SECTION_OVERRIDES) apply(reg);
  return reg;
}

/** A fresh registry with every section override applied — what services should load. */
export function loadOverriddenRegistry(): TimerRegistry {
  return applyAllTimerOverrides(loadRegistry());
}
