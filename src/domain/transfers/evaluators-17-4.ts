/**
 * §17.4 gate evaluators, keyed "17.4.<name>". Every key must be named by an
 * `evaluator:` override in timers-17-4.ts and vice versa (src/app/app.test.ts checks both).
 * 17.4's two gates — `17.4.noTransferOutCancellationBeforeTransferDate` (REGX_1024_41_TRANSFEROR_CONTINUES_GATE) and
 * `17.4.retainedCaseOwnership` (SM_NOE_RFI_OPEN_RETAINED) — live in src/app/evaluators.ts, named by the section-level
 * overrides in ./timers.ts and kept by timers-17-4.ts. SM_SMDU_CASE_HANDOFF_T0 is a deadline (anchor `transfer_date`,
 * offset 0, sev 1 → fnma_portal_operator), not a gate: its condition is measured by `smduHandoff` (ops-17-4.ts) and
 * satisfied by the `smdu.case.status_reported{handoff_current=true}` event, so it carries no evaluator here.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_17_4: Record<string, Evaluator> = {};
export const kit_17_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
