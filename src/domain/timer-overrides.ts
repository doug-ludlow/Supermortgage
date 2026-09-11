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
// ---- §1–§13 process-owned files (scaffolded by tools/workflows/wire.py)
import { applySatisfiedOverrides_1_1 } from "./boarding/timers-1-1.ts";
import { applySatisfiedOverrides_1_2 } from "./transfers/timers-1-2.ts";
import { applySatisfiedOverrides_1_3 } from "./transfers/timers-1-3.ts";
import { applySatisfiedOverrides_1_4 } from "./transfers/timers-1-4.ts";
import { applySatisfiedOverrides_1_5 } from "./transfers/timers-1-5.ts";
import { applySatisfiedOverrides_1_6 } from "./transfers/timers-1-6.ts";
import { applySatisfiedOverrides_1_7 } from "./transfers/timers-1-7.ts";
import { applySatisfiedOverrides_2_1 } from "./cashiering/timers-2-1.ts";
import { applySatisfiedOverrides_2_2 } from "./cashiering/timers-2-2.ts";
import { applySatisfiedOverrides_2_3 } from "./cashiering/timers-2-3.ts";
import { applySatisfiedOverrides_2_4 } from "./cashiering/timers-2-4.ts";
import { applySatisfiedOverrides_2_5 } from "./cashiering/timers-2-5.ts";
import { applySatisfiedOverrides_2_6 } from "./cashiering/timers-2-6.ts";
import { applySatisfiedOverrides_2_7 } from "./cashiering/timers-2-7.ts";
import { applySatisfiedOverrides_3_1 } from "./escrow/timers-3-1.ts";
import { applySatisfiedOverrides_3_2 } from "./escrow/timers-3-2.ts";
import { applySatisfiedOverrides_3_3 } from "./escrow/timers-3-3.ts";
import { applySatisfiedOverrides_3_4 } from "./escrow/timers-3-4.ts";
import { applySatisfiedOverrides_3_5 } from "./escrow/timers-3-5.ts";
import { applySatisfiedOverrides_3_6 } from "./escrow/timers-3-6.ts";
import { applySatisfiedOverrides_3_7 } from "./escrow/timers-3-7.ts";
import { applySatisfiedOverrides_3_8 } from "./escrow/timers-3-8.ts";
import { applySatisfiedOverrides_3_9 } from "./escrow/timers-3-9.ts";
import { applySatisfiedOverrides_4_1 } from "./servicing-requests/timers-4-1.ts";
import { applySatisfiedOverrides_4_2 } from "./servicing-requests/timers-4-2.ts";
import { applySatisfiedOverrides_4_3 } from "./servicing-requests/timers-4-3.ts";
import { applySatisfiedOverrides_4_4 } from "./servicing-requests/timers-4-4.ts";
import { applySatisfiedOverrides_4_5 } from "./servicing-requests/timers-4-5.ts";
import { applySatisfiedOverrides_5_1 } from "./investor/timers-5-1.ts";
import { applySatisfiedOverrides_5_2 } from "./investor/timers-5-2.ts";
import { applySatisfiedOverrides_5_3 } from "./investor/timers-5-3.ts";
import { applySatisfiedOverrides_5_4 } from "./investor/timers-5-4.ts";
import { applySatisfiedOverrides_5_5 } from "./investor/timers-5-5.ts";
import { applySatisfiedOverrides_5_6 } from "./investor/timers-5-6.ts";
import { applySatisfiedOverrides_5_7 } from "./investor/timers-5-7.ts";
import { applySatisfiedOverrides_6_1 } from "./custodial/timers-6-1.ts";
import { applySatisfiedOverrides_6_2 } from "./custodial/timers-6-2.ts";
import { applySatisfiedOverrides_6_3 } from "./custodial/timers-6-3.ts";
import { applySatisfiedOverrides_6_4 } from "./custodial/timers-6-4.ts";
import { applySatisfiedOverrides_6_5 } from "./custodial/timers-6-5.ts";
import { applySatisfiedOverrides_7_1 } from "./notices/timers-7-1.ts";
import { applySatisfiedOverrides_7_2 } from "./notices/timers-7-2.ts";
import { applySatisfiedOverrides_7_3 } from "./notices/timers-7-3.ts";
import { applySatisfiedOverrides_7_4 } from "./notices/timers-7-4.ts";
import { applySatisfiedOverrides_7_5 } from "./notices/timers-7-5.ts";
import { applySatisfiedOverrides_7_6 } from "./notices/timers-7-6.ts";
import { applySatisfiedOverrides_8_1 } from "./credit-reporting/timers-8-1.ts";
import { applySatisfiedOverrides_8_2 } from "./credit-reporting/timers-8-2.ts";
import { applySatisfiedOverrides_8_3 } from "./credit-reporting/timers-8-3.ts";
import { applySatisfiedOverrides_9_1 } from "./insurance/timers-9-1.ts";
import { applySatisfiedOverrides_9_2 } from "./insurance/timers-9-2.ts";
import { applySatisfiedOverrides_9_3 } from "./insurance/timers-9-3.ts";
import { applySatisfiedOverrides_9_4 } from "./insurance/timers-9-4.ts";
import { applySatisfiedOverrides_9_5 } from "./insurance/timers-9-5.ts";
import { applySatisfiedOverrides_9_6 } from "./insurance/timers-9-6.ts";
import { applySatisfiedOverrides_9_7 } from "./insurance/timers-9-7.ts";
import { applySatisfiedOverrides_9_8 } from "./insurance/timers-9-8.ts";
import { applySatisfiedOverrides_9_9 } from "./insurance/timers-9-9.ts";
import { applySatisfiedOverrides_10_1 } from "./pmi/timers-10-1.ts";
import { applySatisfiedOverrides_10_2 } from "./pmi/timers-10-2.ts";
import { applySatisfiedOverrides_10_3 } from "./pmi/timers-10-3.ts";
import { applySatisfiedOverrides_10_4 } from "./pmi/timers-10-4.ts";
import { applySatisfiedOverrides_10_5 } from "./pmi/timers-10-5.ts";
import { applySatisfiedOverrides_10_6 } from "./pmi/timers-10-6.ts";
import { applySatisfiedOverrides_11_1 } from "./early-intervention/timers-11-1.ts";
import { applySatisfiedOverrides_11_2 } from "./early-intervention/timers-11-2.ts";
import { applySatisfiedOverrides_11_3 } from "./early-intervention/timers-11-3.ts";
import { applySatisfiedOverrides_11_4 } from "./early-intervention/timers-11-4.ts";
import { applySatisfiedOverrides_11_5 } from "./early-intervention/timers-11-5.ts";
import { applySatisfiedOverrides_12_1 } from "./lossmit/timers-12-1.ts";
import { applySatisfiedOverrides_12_2 } from "./lossmit/timers-12-2.ts";
import { applySatisfiedOverrides_12_3 } from "./lossmit/timers-12-3.ts";
import { applySatisfiedOverrides_12_4 } from "./lossmit/timers-12-4.ts";
import { applySatisfiedOverrides_12_5 } from "./lossmit/timers-12-5.ts";
import { applySatisfiedOverrides_12_6 } from "./lossmit/timers-12-6.ts";
import { applySatisfiedOverrides_12_7 } from "./lossmit/timers-12-7.ts";
import { applySatisfiedOverrides_12_8 } from "./lossmit/timers-12-8.ts";
import { applySatisfiedOverrides_12_9 } from "./lossmit/timers-12-9.ts";
import { applySatisfiedOverrides_13_1 } from "./foreclosure/timers-13-1.ts";
import { applySatisfiedOverrides_13_2 } from "./foreclosure/timers-13-2.ts";
import { applySatisfiedOverrides_13_3 } from "./foreclosure/timers-13-3.ts";
import { applySatisfiedOverrides_13_4 } from "./foreclosure/timers-13-4.ts";
import { applySatisfiedOverrides_13_5 } from "./foreclosure/timers-13-5.ts";
import { applySatisfiedOverrides_13_6 } from "./foreclosure/timers-13-6.ts";
import { applySatisfiedOverrides_13_7 } from "./foreclosure/timers-13-7.ts";
import { applySatisfiedOverrides_13_8 } from "./foreclosure/timers-13-8.ts";
import { applySatisfiedOverrides_13_9 } from "./foreclosure/timers-13-9.ts";
// ---- §20–§31 process-owned files (scaffolded by tools/workflows/wire_orig.py)
import { applySatisfiedOverrides_20_1 } from "./leads-pricing/timers-20-1.ts";
import { applySatisfiedOverrides_20_2 } from "./leads-pricing/timers-20-2.ts";
import { applySatisfiedOverrides_20_3 } from "./leads-pricing/timers-20-3.ts";
import { applySatisfiedOverrides_20_4 } from "./leads-pricing/timers-20-4.ts";
import { applySatisfiedOverrides_21_1 } from "./application/timers-21-1.ts";
import { applySatisfiedOverrides_21_2 } from "./application/timers-21-2.ts";
import { applySatisfiedOverrides_21_3 } from "./application/timers-21-3.ts";
import { applySatisfiedOverrides_21_4 } from "./application/timers-21-4.ts";
import { applySatisfiedOverrides_21_5 } from "./application/timers-21-5.ts";
import { applySatisfiedOverrides_21_6 } from "./application/timers-21-6.ts";
import { applySatisfiedOverrides_22_1 } from "./verification/timers-22-1.ts";
import { applySatisfiedOverrides_22_2 } from "./verification/timers-22-2.ts";
import { applySatisfiedOverrides_22_3 } from "./verification/timers-22-3.ts";
import { applySatisfiedOverrides_22_4 } from "./verification/timers-22-4.ts";
import { applySatisfiedOverrides_22_5 } from "./verification/timers-22-5.ts";
import { applySatisfiedOverrides_22_6 } from "./verification/timers-22-6.ts";
import { applySatisfiedOverrides_23_1 } from "./underwriting/timers-23-1.ts";
import { applySatisfiedOverrides_23_2 } from "./underwriting/timers-23-2.ts";
import { applySatisfiedOverrides_23_3 } from "./underwriting/timers-23-3.ts";
import { applySatisfiedOverrides_23_4 } from "./underwriting/timers-23-4.ts";
import { applySatisfiedOverrides_24_1 } from "./property/timers-24-1.ts";
import { applySatisfiedOverrides_24_2 } from "./property/timers-24-2.ts";
import { applySatisfiedOverrides_24_3 } from "./property/timers-24-3.ts";
import { applySatisfiedOverrides_24_4 } from "./property/timers-24-4.ts";
import { applySatisfiedOverrides_24_5 } from "./property/timers-24-5.ts";
import { applySatisfiedOverrides_24_6 } from "./property/timers-24-6.ts";
import { applySatisfiedOverrides_25_1 } from "./compliance-disclosures/timers-25-1.ts";
import { applySatisfiedOverrides_25_2 } from "./compliance-disclosures/timers-25-2.ts";
import { applySatisfiedOverrides_25_3 } from "./compliance-disclosures/timers-25-3.ts";
import { applySatisfiedOverrides_25_4 } from "./compliance-disclosures/timers-25-4.ts";
import { applySatisfiedOverrides_26_1 } from "./closing/timers-26-1.ts";
import { applySatisfiedOverrides_26_2 } from "./closing/timers-26-2.ts";
import { applySatisfiedOverrides_26_3 } from "./closing/timers-26-3.ts";
import { applySatisfiedOverrides_26_4 } from "./closing/timers-26-4.ts";
import { applySatisfiedOverrides_27_1 } from "./warehouse/timers-27-1.ts";
import { applySatisfiedOverrides_27_2 } from "./warehouse/timers-27-2.ts";
import { applySatisfiedOverrides_28_1 } from "./qc-hmda/timers-28-1.ts";
import { applySatisfiedOverrides_28_2 } from "./qc-hmda/timers-28-2.ts";
import { applySatisfiedOverrides_28_3 } from "./qc-hmda/timers-28-3.ts";
import { applySatisfiedOverrides_28_4 } from "./qc-hmda/timers-28-4.ts";
import { applySatisfiedOverrides_29_1 } from "./secondary/timers-29-1.ts";
import { applySatisfiedOverrides_29_2 } from "./secondary/timers-29-2.ts";
import { applySatisfiedOverrides_29_3 } from "./secondary/timers-29-3.ts";
import { applySatisfiedOverrides_29_4 } from "./secondary/timers-29-4.ts";
import { applySatisfiedOverrides_30_1 } from "./orig-boarding/timers-30-1.ts";
import { applySatisfiedOverrides_30_2 } from "./orig-boarding/timers-30-2.ts";
import { applySatisfiedOverrides_30_3 } from "./orig-boarding/timers-30-3.ts";
import { applySatisfiedOverrides_30_4 } from "./orig-boarding/timers-30-4.ts";
import { applySatisfiedOverrides_31_1 } from "./governance/timers-31-1.ts";
import { applySatisfiedOverrides_31_2 } from "./governance/timers-31-2.ts";
import { applySatisfiedOverrides_31_3 } from "./governance/timers-31-3.ts";
// ---- §32 process-owned files (scaffolded by tools/workflows/wire_orig.py)
import { applySatisfiedOverrides_32_1 } from "./borrower/timers-32-1.ts";
import { applySatisfiedOverrides_32_2 } from "./borrower/timers-32-2.ts";
import { applySatisfiedOverrides_32_3 } from "./borrower/timers-32-3.ts";
import { applySatisfiedOverrides_32_4 } from "./borrower/timers-32-4.ts";
import { applySatisfiedOverrides_32_5 } from "./borrower/timers-32-5.ts";
import { applySatisfiedOverrides_32_6 } from "./borrower/timers-32-6.ts";
import { applySatisfiedOverrides_32_7 } from "./borrower/timers-32-7.ts";
import { applySatisfiedOverrides_32_8 } from "./borrower/timers-32-8.ts";
import { applySatisfiedOverrides_32_9 } from "./borrower/timers-32-9.ts";
import { applySatisfiedOverrides_32_10 } from "./borrower/timers-32-10.ts";
import { applySatisfiedOverrides_32_11 } from "./borrower/timers-32-11.ts";
import { applySatisfiedOverrides_32_12 } from "./borrower/timers-32-12.ts";
import { applySatisfiedOverrides_32_13 } from "./borrower/timers-32-13.ts";

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

/** §1–§13 process-owned overrides (src/domain/<dir>/timers-<n>-<k>.ts), applied after every section's so they win the merge. */
export const PROCESS_OVERRIDES: ReadonlyArray<(reg: TimerRegistry) => void> = [applySatisfiedOverrides_1_1, applySatisfiedOverrides_1_2, applySatisfiedOverrides_1_3, applySatisfiedOverrides_1_4, applySatisfiedOverrides_1_5, applySatisfiedOverrides_1_6, applySatisfiedOverrides_1_7, applySatisfiedOverrides_2_1, applySatisfiedOverrides_2_2, applySatisfiedOverrides_2_3, applySatisfiedOverrides_2_4, applySatisfiedOverrides_2_5, applySatisfiedOverrides_2_6, applySatisfiedOverrides_2_7, applySatisfiedOverrides_3_1, applySatisfiedOverrides_3_2, applySatisfiedOverrides_3_3, applySatisfiedOverrides_3_4, applySatisfiedOverrides_3_5, applySatisfiedOverrides_3_6, applySatisfiedOverrides_3_7, applySatisfiedOverrides_3_8, applySatisfiedOverrides_3_9, applySatisfiedOverrides_4_1, applySatisfiedOverrides_4_2, applySatisfiedOverrides_4_3, applySatisfiedOverrides_4_4, applySatisfiedOverrides_4_5, applySatisfiedOverrides_5_1, applySatisfiedOverrides_5_2, applySatisfiedOverrides_5_3, applySatisfiedOverrides_5_4, applySatisfiedOverrides_5_5, applySatisfiedOverrides_5_6, applySatisfiedOverrides_5_7, applySatisfiedOverrides_6_1, applySatisfiedOverrides_6_2, applySatisfiedOverrides_6_3, applySatisfiedOverrides_6_4, applySatisfiedOverrides_6_5, applySatisfiedOverrides_7_1, applySatisfiedOverrides_7_2, applySatisfiedOverrides_7_3, applySatisfiedOverrides_7_4, applySatisfiedOverrides_7_5, applySatisfiedOverrides_7_6, applySatisfiedOverrides_8_1, applySatisfiedOverrides_8_2, applySatisfiedOverrides_8_3, applySatisfiedOverrides_9_1, applySatisfiedOverrides_9_2, applySatisfiedOverrides_9_3, applySatisfiedOverrides_9_4, applySatisfiedOverrides_9_5, applySatisfiedOverrides_9_6, applySatisfiedOverrides_9_7, applySatisfiedOverrides_9_8, applySatisfiedOverrides_9_9, applySatisfiedOverrides_10_1, applySatisfiedOverrides_10_2, applySatisfiedOverrides_10_3, applySatisfiedOverrides_10_4, applySatisfiedOverrides_10_5, applySatisfiedOverrides_10_6, applySatisfiedOverrides_11_1, applySatisfiedOverrides_11_2, applySatisfiedOverrides_11_3, applySatisfiedOverrides_11_4, applySatisfiedOverrides_11_5, applySatisfiedOverrides_12_1, applySatisfiedOverrides_12_2, applySatisfiedOverrides_12_3, applySatisfiedOverrides_12_4, applySatisfiedOverrides_12_5, applySatisfiedOverrides_12_6, applySatisfiedOverrides_12_7, applySatisfiedOverrides_12_8, applySatisfiedOverrides_12_9, applySatisfiedOverrides_13_1, applySatisfiedOverrides_13_2, applySatisfiedOverrides_13_3, applySatisfiedOverrides_13_4, applySatisfiedOverrides_13_5, applySatisfiedOverrides_13_6, applySatisfiedOverrides_13_7, applySatisfiedOverrides_13_8, applySatisfiedOverrides_13_9,
  applySatisfiedOverrides_20_1, applySatisfiedOverrides_20_2, applySatisfiedOverrides_20_3, applySatisfiedOverrides_20_4, applySatisfiedOverrides_21_1, applySatisfiedOverrides_21_2, applySatisfiedOverrides_21_3, applySatisfiedOverrides_21_4, applySatisfiedOverrides_21_5, applySatisfiedOverrides_21_6, applySatisfiedOverrides_22_1, applySatisfiedOverrides_22_2, applySatisfiedOverrides_22_3, applySatisfiedOverrides_22_4, applySatisfiedOverrides_22_5, applySatisfiedOverrides_22_6, applySatisfiedOverrides_23_1, applySatisfiedOverrides_23_2, applySatisfiedOverrides_23_3, applySatisfiedOverrides_23_4, applySatisfiedOverrides_24_1, applySatisfiedOverrides_24_2, applySatisfiedOverrides_24_3, applySatisfiedOverrides_24_4, applySatisfiedOverrides_24_5, applySatisfiedOverrides_24_6, applySatisfiedOverrides_25_1, applySatisfiedOverrides_25_2, applySatisfiedOverrides_25_3, applySatisfiedOverrides_25_4, applySatisfiedOverrides_26_1, applySatisfiedOverrides_26_2, applySatisfiedOverrides_26_3, applySatisfiedOverrides_26_4, applySatisfiedOverrides_27_1, applySatisfiedOverrides_27_2, applySatisfiedOverrides_28_1, applySatisfiedOverrides_28_2, applySatisfiedOverrides_28_3, applySatisfiedOverrides_28_4, applySatisfiedOverrides_29_1, applySatisfiedOverrides_29_2, applySatisfiedOverrides_29_3, applySatisfiedOverrides_29_4, applySatisfiedOverrides_30_1, applySatisfiedOverrides_30_2, applySatisfiedOverrides_30_3, applySatisfiedOverrides_30_4, applySatisfiedOverrides_31_1, applySatisfiedOverrides_31_2, applySatisfiedOverrides_31_3,
  applySatisfiedOverrides_32_1, applySatisfiedOverrides_32_2, applySatisfiedOverrides_32_3, applySatisfiedOverrides_32_4, applySatisfiedOverrides_32_5, applySatisfiedOverrides_32_6, applySatisfiedOverrides_32_7, applySatisfiedOverrides_32_8, applySatisfiedOverrides_32_9, applySatisfiedOverrides_32_10, applySatisfiedOverrides_32_11, applySatisfiedOverrides_32_12, applySatisfiedOverrides_32_13];

export function applyAllTimerOverrides(reg: TimerRegistry): TimerRegistry {
  for (const [, apply] of SECTION_OVERRIDES) apply(reg);
  for (const apply of PROCESS_OVERRIDES) apply(reg);
  return reg;
}

/** A fresh registry with every section override applied — what services should load. */
export function loadOverriddenRegistry(): TimerRegistry {
  return applyAllTimerOverrides(loadRegistry());
}
