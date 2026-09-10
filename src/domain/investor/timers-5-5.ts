/**
 * §5.5 timer overrides (process-owned; the §5 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 5.5 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. `registry.override` re-derives `anchorField` from the raw anchor column, so a row whose
 * trigger is restated here restates its computed anchor and offset too.
 *
 * Subjects (src/kernel/timers/engine.ts `sameSubject`): a clock armed by a period-level event is only satisfied by an
 * event carrying the same aggregate. 5.1's `openReportingPeriod` opens the servicer's reporting period once with
 * `investor_reporting_periods.opened{status=open}` on `{kind: period, id: <servicer>:<period>}` (5.2's per-cycle opens
 * carry `remittance_type`/`cycle` and no `status`), so the two period clocks here are armed on that subject and 5.5's
 * bill parse, bill reconciliation and CD7 funding carry it (`gfeePeriodSubject` in ./ops-5-5.ts).
 *
 * What 5.5 actually emits (src/domain/investor/ops-5-5.ts, through src/app/tools/section5-5.ts):
 * - `gfee.bill.parsed{draft_type=mbs_gfee, period, servicer_number}` on the period (`parseGfeeBill`, the bill parsed into
 *   `draft_notifications`); `gfee_relief.reconciled` per relief loan and `gfee_relief.bill_reconciled{all_reconciled}` on
 *   the period (`reconcileReliefToBill`); `gfee_relief_status.predicted` once at four consecutive months
 *   (`predictGfeeRelief`), `gfee_relief_status.active{fnma_start_date}` only from Fannie Mae's bill (`activateGfeeRelief`);
 * - `remittances.funded{kind=gfee, initiator=fnma}` on the period when the CD7 draft is funded through the T−1 16:00 ET
 *   funding check (`fundGfeeDraft`);
 * - `gfee.recovery.expected{gfee_relief_active=true, contractual=true, accepted_on}` (`expectGfeeRecovery`, on 5.1's
 *   `investor_events.accepted{event_type=payment.contractual}` row on the loan), `gfee.recovery.matched{kind}`
 *   (`matchGfeeRecoveryDebit`);
 * - `gfee_relief_status.exited{reason, exited_on, period_end, resume_draft_on}` (`recordGfeeReliefExit`, "current" from
 *   the loan's `loan.became_current` fact); `remittances.funded{kind=gfee, remittance_type=ss}` with the loan id when the
 *   resumed g-fee draft is funded through 5.2's funding check (`resumeGfeeDraft` → ops-5-2 `fundDraft`).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_5_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- period clocks: the servicer's reporting period opens (5.1) → the g-fee bill by CD5 12:00 ET, the CD7 draft funded by T−1 16:00 ET
  o("FNMA_F120_GFEE_BILL_RETRIEVE_CD5", { trigger: "`investor_reporting_periods.opened{status=open}`", anchorField: "gfee_bill_due_on", offset: "0, 12:00 ET", satisfied: "`gfee.bill.parsed{draft_type=mbs_gfee}`",
    why: "§5.5 timer table: 'period open' (anchor 'CD5 12:00 ET') → 'bill parsed into `draft_notifications`'. The period open is 5.1's `investor_reporting_periods.opened{status=open}` on the servicer's period subject (`periodAnchors.gfee_bill_due_on` = CD5 of the following month, preceding fannie_et BD); F-1-20: the servicer must 'retrieve the electronic draft notice (or \"bill\") from Fannie Mae's website'. `parseGfeeBill` parses the bill into a `draft_notifications` row with `draft_type = mbs_gfee` (data model) and records `gfee.bill.parsed{draft_type=mbs_gfee}` on the same period subject." });
  o("FNMA_F120_GFEE_DRAFT_CD7", { trigger: "`investor_reporting_periods.opened{status=open}`", anchorField: "gfee_draft_on", offset: "−1 business_days_fannie_et, 16:00 ET", satisfied: "`remittances.funded{kind=gfee}`",
    why: "§5.5 timer table: 'period open' (anchor 'CD7 (preceding `fannie_et` BD)', offset 'funding check −1 BD 16:00 ET') → 'g-fee `remittances.funded`'. The period open is 5.1's `investor_reporting_periods.opened{status=open}` on the servicer's period subject (`periodAnchors.gfee_draft_on` = `gfeeDraft().draft_on`: 5.5-T1 Fri Nov 6, 2026 → Thu Nov 5 16:00 ET; 5.5-T6 Jan 7, 2027 → Wed Jan 6 16:00 ET). `fundGfeeDraft` funds the CD7 draft through the funding check and records `remittances.funded{kind=gfee, initiator=fnma}` on the same period subject (F-1-20: fees 'available to Fannie Mae on the seventh calendar day of the month, or on the preceding business day')." });
  o("FNMA_F120_GFEE_RELIEF_RECONCILE_BILL", { trigger: "`gfee.bill.parsed{draft_type=mbs_gfee}`", offset: "same day", satisfied: "`gfee_relief.bill_reconciled{all_reconciled=true}`",
    why: "§5.5 timer table: 'bill parsed' (anchor 'parse time', offset 'same BD') → 'every predicted/active relief loan reconciled to the bill'. `gfee.bill.parsed{draft_type=mbs_gfee}` arms the clock on the bill's period subject; `reconcileReliefToBill` reconciles every loan whose history says predicted/active to the parsed bill (rule 3: 'authoritative when the bill omits/zeros the loan'; Agents paragraph: officer 'if a relief loan reappears on the bill without a contractual payment') and records `gfee_relief.bill_reconciled{all_reconciled}` on the same subject — true only when every relief loan is explained." });
  // ---- rule 4: contractual payment on a relief loan → Fannie Mae recovery, then servicer retention, matched within 2 bill cycles (CD7)
  o("SM_GFEE_RECOVERY_MATCH_2_CYCLES", { trigger: "`gfee.recovery.expected{gfee_relief_active=true, contractual=true}`", anchorField: "accepted_on",
    why: "§5.5 timer table: 'contractual payment on a relief loan' (anchor 'LAR acceptance', offset '2 bill cycles') → 'Fannie Mae recovery then servicer retention matched'. 5.1's `investor_events.accepted` (src/domain/investor/ops-5-1.ts `acceptEvent`) carries no `gfee_relief_active`/`contractual` — relief is a 5.5 fact; 5.5 takes that accepted row (`event_type=payment.contractual`, on the loan) for a loan whose history says predicted/active and sets the recovery expectation (rule 4: 'for each full contractual payment reported during relief, Fannie Mae drafts the g-fee associated with that payment … first against `outstanding_fnma_gfee`'; once that is zero the servicer retains) as `gfee.recovery.expected{gfee_relief_active=true, contractual=true, accepted_on}` — the acceptance date anchors the two CD7 bill cycles (the §5 offset '7th of the month after next (preceding fannie_et BD)'). `gfee.recovery.matched{kind∈{fnma_recovery, servicer_retention}}` is posted per matched component by `matchGfeeRecoveryDebit`." });
  // ---- exit (current): the loan becomes current → the g-fee is back on the next CD7 bill, funded through the funding check
  o("FNMA_F120_GFEE_RESUME_ON_CURRENT", { trigger: "`gfee_relief_status.exited{reason=current}`", anchorField: "period_end",
    why: "§5.5 timer table: 'loan becomes current' (anchor 'period end', offset 'next CD7') → 'g-fee funded'. The platform's `loan.became_current` (§10.2's cure fact) carries no `gfee_relief_active` — relief is a 5.5 fact; `recordGfeeReliefExit` records the exit only from that fact on a loan whose history says predicted/active, as `gfee_relief_status.exited{reason=current, became_current_on, period_end, resume_draft_on}` (rule 5: 'current → resume from the next CD7 bill'; F-1-20: 'the servicer must resume remitting guaranty fees … beginning with the applicable draft date'), whose `period_end` anchors the §5 offset '7th of the following month (preceding fannie_et BD)'. The funded fact is `remittances.funded{kind=gfee}` on the loan (`resumeGfeeDraft` → ops-5-2 `fundDraft` with `kind=gfee`)." });
}
