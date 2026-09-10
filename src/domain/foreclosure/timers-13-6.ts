/**
 * §13.6 timer overrides (process-owned; the §13 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 13.6 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The events named here are appended by src/app/tools/section13-6.ts from the records
 * src/domain/foreclosure/ops-13-6.ts builds (payload field names below are theirs).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_13_6(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("FNMA_A4201_FORM200_RESPONSE_15BD", { anchorField: "submitted_on", why: "§13.6 timer table: anchor 'submission' — form200.submitted{submitted_on} is the Form 200 submission date (A4-2.2-01 'Within 15 business days following the submission of Form 200')." });
  o("SM_DRA_RECONCILE_DAILY", { offset: "+1 business_days_servicer, 07:00 ET", satisfied: "`dra.snapshot.imported`", why: "§13.6 timer table: daily business-day DRA import at 07:00 ET, satisfied by `dra.snapshot.imported` — the import tool arms the first instance on the global subject (no scheduler tick exists on the bus) and each import re-arms the recurring row for the next business day." });
  o("FNMA_A4202_FIRM_ESCALATION_2BD", { anchorField: "due", offset: "0 calendar_days", why: "§13.6 timer table: 'within two business days of discovery (or sooner if circumstances warrant)' — the row carries its own `due` (discovered_on + 2 servicer BD; the discovery date itself for a data breach, A4-2.2-02), so the engine anchors on it with offset 0. Original: " +  "§13.6 timer table: anchor 'discovery' — attorney_escalation.discovered{discovered_on} (A4-2.2-02 'Within two business days of discovery')." });
  o("SM_INVOICE_REVIEW_10BD", { anchorField: "received_on", why: "§13.6 timer table: anchor 'receipt' — firm.invoice.received{received_on}." });
  o("SM_INVOICE_PAY_30", { anchorField: "approved_on", why: "§13.6 timer table: anchor 'approval' — firm.invoice.approved{approved_on}; the rules engine's review result is the approval (E-5-02)." });
  o("FNMA_F105_EXPENSE_CLAIM_60", { anchorField: "milestone_on", why: "§13.6 timer table: anchor 'milestone' — claim.milestone.reached{kind, milestone_on} (sale/reinstatement/payoff/workout; 15.2)." });
  o("FNMA_A4201_RECORDS_7Y", { anchorField: "decided_on", why: "§13.6 timer table: anchor 'decision' — firm.selection.decided{decision, decided_on}; A4-2.2-04 'seven years after the decision'." });
  o("SM_DRA_EVENT_EXPECTED_2BD", { trigger: "`attorney.instruction.acknowledged{dra_reportable=true}`", why: "§13.6 rule 6: expected DRA events are derived from internal milestones/instructions with a DRA counterpart (referral received; first legal; sale scheduled; sale postponed; sale held; bankruptcy filed/relief) — an acknowledged instruction with no DRA event (e.g. STATUS_DEMAND) arms nothing." });
}
