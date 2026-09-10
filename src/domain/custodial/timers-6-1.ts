/**
 * §6.1 timer overrides (process-owned; the §6 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 6.1 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. Every event named here is appended by a function in ./ops-6-1.ts (or, for the
 * inbound 1.2 batch and the escalation lifecycle, by src/domain/transfers/inbound.ts and src/app/escalations.ts).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_6_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("FNMA_F103_FORM1013_IN_EFFECT_GATE", { trigger: "`custodial.account.planned{kind=pi}`",
    why: "§6.1 timer table: trigger `custodial.account.planned` — Form 1013 is the P&I Letter of Authorization (F-1-03), so the gate arms on the P&I accounts `planCustodialAccounts` plans (`custodial.account.planned{kind}`); the T&I account's Form 1014 gate is 6.2's `{kind=ti}` row. Opens on `custodial.form.in_effect{kind=1013}` (markFormInEffect: executed-document hash required, any mismatch reopens the portal task — 6.1-T7); `initiateDeposit` refuses `custodial.deposit.initiated` while it is armed (6.1-T4)." });
  o("FNMA_A2107_CUSTODIAL_EVIDENCE_BEFORE_629_GATE", { trigger: "`transfer.batch.proposed{type∈{master_to_sub, sub_to_sub, servicing_sale_with_sub}}`", evaluator: "6.1.activeAccountsForEveryRemittanceType",
    why: "§6.1 timer table: trigger `transfer_in.case.opened` (1.2) — 1.2 spells its intake `transfer.batch.proposed{type}` (src/domain/transfers/inbound.ts proposeBatch; the same inbound batch types as 1.2's Form 629 clocks); opens when every remittance type in the transfer file has an `active` P&I account and an `active` T&I account (A2-1-07) — evaluated on `custodialEvidenceFacts`; blocks `transfer.form629.package_ready`, escalation `officer`, high." });
  o("SM_CBAM_TASK_SLA_3BD", { trigger: "`escalation.created{kind=human_portal_task, task=cbam_form}`", satisfied: "`escalation.completed{kind=human_portal_task}`",
    why: "§6.1 timer table: trigger `escalation.created` (human_portal_task CBAM) — only the CBAM portal task `prepareCbamPackage` opens with `task=cbam_form`, never the `officer` DocuSign/negotiation escalations of the same process; satisfied by `custodial.form.sent_for_signature`, which `sendFormForSignature` appends in the same act as it completes that task — the timer's subject is the task (the `escalation.created` aggregate), whose completion the platform spells `escalation.completed` (as 1.2's SM_PORTAL_TASK_FORM629_SLA_2 does); breach re-escalates to `officer`." });
  o("SM_CBAM_SIGNATURE_PENDING_5BD", { anchorField: "sent_at",
    why: "§6.1 timer table: anchor `sent_at` — carried on `custodial.form.sent_for_signature` (sendFormForSignature, the operator's Generate & Send record); 5 business_days_servicer to `custodial.form.fully_signed` (ingestCbamFormStatus 'Fully Signed', both DocuSign timestamps); the agent chases the depository rep, `officer` at 10 BD; a declined DocuSign cancels it with a reason (declineForm, 6.1-T8)." });
  o("FNMA_A4102_DEPOSITORY_INELIGIBLE_NOTIFY_3BD", { anchorField: "detected_on",
    why: "§6.1 timer table: anchor 'detection date' — `detected_on` on `custodial.depository.ineligible_detected` (checkDepositoryRatings, rule 1 per account use); 3 business_days_fannie_et, 17:00 America/New_York to `custodial.depository.fnma_notified` (email.send to custodial_account@fanniemae.com + CBAM note, partner copied) — 6.1-T5: Thu 2026-10-15 → Tue 2026-10-20 17:00 ET." });
  o("FNMA_A4102_RATING_MONITOR_RECUR", { anchorField: "activated_on",
    why: "§6.1 timer table: anchor 'activation' — `activated_on` on `custodial.account.activated` (activateAccount: form in_effect ∧ debit whitelist ∧ statement feed ∧ title); monthly (S&P/Moody's; the IDC/KBRA quarterly leg's cadence is UNVERIFIED), re-armed by each `custodial.depository.rating_checked` — checkDepositoryRatings emits one per active account at the depository, evaluated for that account's use." });
  o("FNMA_C1101_LOCKBOX_DEPOSIT_2BD", { anchorField: "received_on",
    why: "§6.1 timer table: anchor 'lockbox receipt date' — `received_on` on `lockbox.batch.received` (ingestLockboxBatch, the lockbox agent's validated batch); 2 business_days_servicer to `custodial.deposit.confirmed` (confirmCustodialDeposit, the custodial bank credit matched to the batch) — 6.1-T6: Fri 2026-11-06 → Tue 2026-11-10 on the servicer calendar." });
  o("FNMA_A4102_CLEARING_TO_CUSTODIAL_1BD", { anchorField: "credited_on",
    why: "§6.1 timer table: anchor 'bank credit date in clearing' — `credited_on` on `custodial.clearing.credited` (ingestClearingCredit, a credit landing in the titled clearing account); 1 business_days_servicer to `custodial.clearing.swept` (sweepClearingToCustodial, rule 4: Σ(P + I_gross) − servicing_fee − late_charges_retained) — A4-1-02: recorded in the custodial account within one business day including any period in a clearing or general-ledger account." });
}
