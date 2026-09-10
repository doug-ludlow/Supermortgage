/**
 * §5.4 timer overrides (process-owned; the §5 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 5.4 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * What 5.4 actually emits (src/domain/investor/ops-5-4.ts, through src/app/tools/section5-4.ts):
 * - `sda_status.predicted{prediction=set}` per special-servicing S/S loan at four consecutive months and one
 *   `sda_status.predicted{scope=period}` on the period subject once every loan is set/cleared (`predictSdaEntries`);
 * - `fnma.connect.report.available{report, period_end}` on the report subject `{kind: fnma_report, id: report_id}`
 *   (`ingestConnectReport`) — the Remittance Detail – P&I (`report=sda_status`), Cash Adjustments and Eligible for
 *   Deselection reports; the deselection report also posts `reclass.deselection.eligible{posted_on, decide_by}` per loan;
 * - `fnma.connect.report.line{report, report_id, stop_advance_status, …}` per mapped loan on the P&I / Cash Adjustments reports;
 * - `sda_status.active{start_date}` only from Fannie Mae data, `sda.reconciled` per loan and
 *   `sda.reconciled{all_reconciled=true}` on the report subject (`reconcileSdaReport`, after coverage is verified);
 * - `advances.booked{kind=delinquency_pi, period, amount_cents, funded_from, drafted_at, status=outstanding}` per advance
 *   (`bookDelinquencyAdvances`, refused for an `active` loan);
 * - `sda.contractual_payment.applied{sda_active=true, contractual=true, processed_at}` (`recordSdaContractualPayment`),
 *   `sda.recovery.expected{sda_active=true, contractual=true, accepted_on}` (`expectSdaRecovery`, on 5.1's
 *   `investor_events.accepted{event_type=payment.contractual}`), `sda.adjustment.matched{kind}` (`matchRecoveryDraft`);
 * - `sda_status.exited{reason, exited_on, period_end}` (`recordSdaExit`); `remittances.funded{remittance_type=ss,
 *   kind=pi_scheduled, sda_resumed=true}` on the loan when the resumed draft passes the 5.2 funding check
 *   (`resumeScheduledDraft`); `advances.reimbursed_by_fnma{all_outstanding}` (`matchReimbursementCredits`);
 * - `reclass.selection.expected{servicing_option=regular, consecutive_months_delinquent}` (`predictSdaEntries`),
 *   `fnma.purchase_advice.received{kind=reclass}` (`ingestPurchaseAdvice`), `reclass.deselection.decided{decision}`
 *   (`recordDeselectionDecision`).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_5_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- period end → the prediction run over every special-servicing S/S loan (recurring: re-arms for the next period end)
  o("FNMA_C301_SDA_PREDICT_EOM", { anchorField: "next_period_end", satisfied: "`sda_status.predicted{scope=period}`",
    why: "§5.4 timer table: 'period end' (recurring, anchor 'last calendar day 23:59 ET', offset 0) → '`sda_status.predicted` set/cleared for every special-servicing S/S loan'. The trigger is 5.1's `period.month_end` on the servicer's period subject (ops-5-1 `periodAggregate`, `{kind: period, id: <servicer>:<period>}`); it carries no `next_period_end`, so the instance anchors on the month-end run's own ET date. The satisfying fact is the period-level `sda_status.predicted{scope=period}` `predictSdaEntries` posts on that subject after every predicted/active loan is covered (the per-loan `sda_status.predicted` rows are loan-scoped and carry no `scope`). Because the engine re-arms a recurring row from its satisfying event, that fact carries `next_period_end` (the next last calendar day), so the re-armed instance is due at the next period end rather than at the one just satisfied." });
  // ---- BD3 report → every predicted/active loan reconciled (the report-level fact on the report subject)
  o("FNMA_F120_SDA_STATUS_RECONCILE_BD3", { trigger: "`fnma.connect.report.available{report=sda_status}`", anchorField: "period_end", satisfied: "`sda.reconciled{all_reconciled=true}`",
    why: "§5.4 timer table: 'BD3 report available' → 'BD3 12:00 ET' → 'every predicted/active loan reconciled to Fannie Mae's status'. The Remittance Detail – P&I report (Inputs: 'BD3 draft notification and Remittance Detail – P&I report (5.2) carrying Stop Advance Status/Start/Expiration and outstanding receivables') is ingested on the report subject with the activity period's `period_end`, from which BD3 12:00 ET of the following month is the deadline; `reconcileSdaReport` verifies coverage (every loan the store shows predicted/active and every loan the report lists as Stop Advance), posts one `sda.reconciled` per loan and `sda.reconciled{all_reconciled=true}` on the report — spelled `sda.reconciled`, not `sda_status.reconciled`, because the data model's `sda_status.last_reconciled_report_id` update is not a status move and the `sda_status.*` history must keep `active` as the loan's last move for the funding gate; the per-loan rows never carry `all_reconciled`, so only the report-level fact satisfies." });
  // ---- rule 4: full contractual payments on an SDA loan → LAR by next BD 20:00 ET → Fannie Mae's recovery draft matched within 2 cycles
  o("FNMA_IRM_SDA_CONTRACTUAL_LAR_NEXTBD_2000", { trigger: "`sda.contractual_payment.applied{sda_active=true, contractual=true}`", anchorField: "processed_at", satisfied: "`investor_events.accepted{event_type=payment.contractual}`",
    why: "§5.4 timer table: 'full contractual payment(s) applied on an SDA loan' (anchor processed_at, next BD 20:00 ET on the 5.1 clock) → 'contractual-payment event accepted with updated LPI'. Cashiering's `payment.applied` cannot carry `sda_active` (a 5.4 fact): 5.4 validates the applied installments as full contractual payments on an active loan (Inputs: '`payment.applied` events that constitute one or more full contractual payments (Section 2 rule: partial funds sit in suspense until a full installment accrues)') and records `sda.contractual_payment.applied{sda_active=true, contractual=true, processed_at}`; 5.1's acceptance is `investor_events.accepted{event_type=payment.contractual}` on the loan (src/domain/investor/ops-5-1.ts `acceptEvent`), which carries no `sda_active` — the clock is loan-scoped and only armed for SDA loans, so the accepted contractual LAR on that loan is the satisfaction." });
  o("SM_SDA_RECOVERY_MATCH_2_CYCLES", { trigger: "`sda.recovery.expected{sda_active=true, contractual=true}`", anchorField: "accepted_on",
    why: "§5.4 timer table: 'contractual payment reported on SDA loan' (anchor acceptance, 2 draft cycles) → 'recovery adjustment matched (Fannie Mae recovery, then servicer retention)'. 5.1's `investor_events.accepted` carries no `sda_active`/`contractual`; 5.4 takes the accepted contractual LAR and sets the recovery expectation (rule 4: 'Fannie Mae then drafts recovery amounts equal to its outstanding receivable for those periods') as `sda.recovery.expected{sda_active=true, contractual=true, accepted_on}` — the acceptance date anchors the two CD18 cycles." });
  // ---- exit (a): the loan becomes current → drafts resume at the next CD18, funded through 5.2's funding check
  o("FNMA_F120_SDA_EXIT_RESUME_DRAFT", { trigger: "`sda_status.exited{reason=current}`", anchorField: "period_end", satisfied: "`remittances.funded{remittance_type=ss, kind=pi_scheduled, sda_resumed=true}`",
    why: "§5.4 timer table: 'loan becomes current' (anchor period end, next draft date CD18) → 'scheduled P&I funded' (rule 5(a): 'status removed; scheduled drafts resume from the month after'). The 5.4 record of the exit is `sda_status.exited{reason=current, period_end}` (state machine: 'exited (Fannie Mae removes status; reason recorded)'); the funded fact is `remittances.funded{remittance_type=ss, kind=pi_scheduled, sda_resumed=true}` posted on the loan by `resumeScheduledDraft` after the 5.2 T−1 16:00 ET funding check (`advanceTransfer`) runs for the loan's own scheduled P&I — loan-scoped, never on the remittance-cycle subject, so it cannot stand in for 5.2's whole-cycle FNMA_F120_SS_DRAFT_CD18 funding fact." });
  // ---- exits (b)/(c)/(e): Fannie Mae reimburses outstanding advances within two draft cycles of the exit
  o("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES", { trigger: "`sda_status.exited{reason∈{liquidation, reclass, deferral}}`", anchorField: "exited_on",
    why: "§5.4 timer table: 'exit by reclass/deferral/liquidation' (anchor 'exit event', 2 draft cycles) → '`advances.status = reimbursed_by_fnma` for all outstanding'. `recordSdaExit` posts `sda_status.exited{reason, exited_on, period_end}` for every F-1-20 exit; only a deferral ('Fannie Mae reimburses delinquency advances up to that point'), reclass ('Fannie Mae will reimburse the servicer for any outstanding delinquency advances') or liquidation ('Fannie Mae reimburses outstanding delinquency advances') exit arms the reimbursement clock — current, payoff and repurchase exits reimburse nothing (rule 5(a)/(d)) — and the two CD18 cycles run from `exited_on`, the exit event's own date, not from when it was recorded (5.4-T4: deferral Jul 20, 2027 → Fri Sep 17, 2027)." });
  // ---- regular servicing option: six consecutive months → reclass selection (A1-3-06); the deselection window (F-1-25)
  o("FNMA_A1306_RECLASS_SELECTION_6M", { trigger: "`reclass.selection.expected{servicing_option=regular, consecutive_months_delinquent>=6}`", anchorField: "period_end",
    why: "§5.4 timer table: 'regular servicing option loan six consecutive months delinquent' (anchor period end, informational) → 'reclass purchase advice received'. Rule 1: 'Regular servicing option S/S loans: advance until removal; expect Fannie Mae reclass selection at six consecutive months (A1-3-06)' — the period-end run (`predictSdaEntries`) records that expectation per loan as `reclass.selection.expected{servicing_option=regular, consecutive_months_delinquent, period_end}`; the period close itself carries no per-loan servicing option or month count." });
  o("FNMA_F125_RECLASS_DESELECT_CD15", { trigger: "`reclass.deselection.eligible`", anchorField: "posted_on",
    why: "§5.4 timer table: 'Eligible for Deselection report (~CD11)' (anchor CD11, by CD15) → 'deselection decision recorded (`human_portal_task` if deselecting)'; Reclassification interplay: 'the \"Eligible for Deselection\" report posts about CD11 and the servicer must act by the 15th'. The decision is per listed loan (5.4-T5: 'the deselection decision task is created on CD11 and due CD15'), so ingesting the report posts `reclass.deselection.eligible{posted_on, decide_by}` on each loan and the loan's `reclass.deselection.decided` satisfies it." });
}
