/**
 * §17.1 timer overrides: for every 17.1 registry row whose "Satisfied by" or
 * anchor column is prose, a `reg.override(code, { satisfied | evaluator, trigger?, offset?, anchorField?, why })`
 * (see src/domain/foreclosure/timers.ts applyForeclosureSatisfiedOverrides for the pattern).
 * Called from this section's timers.ts after the section-level overrides. Every
 * event and anchor field named here is emitted by ops-17-1.ts (proposeBatch,
 * transitionTransferOut, recordNotice, attestLoanList, submitLoanListVersion,
 * fnmaProcessingConfirmation, submitForm101Termination, partnerAccessRevocation,
 * form582TerminationReflected) through the 17.1 tools in src/app/tools/section17-1.ts;
 * the Form 629 portal task's `escalation.created{kind=human_portal_task, task=form629}`
 * is the EscalationService's (createPortalTask opens it; ops-17-1.ts form629PortalTaskOpened
 * ingests it for the SLA anchor).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_17_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Note: registry.override() re-derives `anchorField` from the raw anchor text, so every override here names its anchor field
  // explicitly (an override without one would drop the field a §1.2/section-level override set).
  // ---- Form 629 clocks: the codes are shared with §1.2 (inbound); the trigger is the union of both rows' batch types.
  o("FNMA_A2_7_03_FORM629_SUBSERVICING_30", { anchorField: "transfer_date", trigger: "`transfer.batch.proposed{type∈{master_to_sub, sub_to_sub, sub_to_master}}`",
    why: "§17.1 timer table: `transfer.batch.proposed{direction=out, type∈sub_to_sub,sub_to_master}` (30-day subservicing rule) joined with §1.2's `master_to_sub`; anchor `transfer_date` −30 CD." });
  o("FNMA_A2_7_03_FORM629_SERVICING_60", { anchorField: "form629_anchor_date", trigger: "`transfer.batch.proposed{type∈{servicing_sale_with_sub, servicing_sale, fnma_directed, master_change_sub_retained}}`",
    why: "§17.1 timer table: `transfer.batch.proposed{direction=out, type∈servicing_sale,fnma_directed,master_change_sub_retained}` joined with §1.2's `servicing_sale_with_sub`; anchor = earlier of `sale_date`,`transfer_date` carried as `form629_anchor_date` (ops-17-1.ts proposeBatch)." });
  // ---- Quick Exchange cadence: CD10/CD20 are anchored on computed dates of the month before `transfer_date`, carried on `transfer.batch.approved`
  //      (ops-17-1.ts transitionTransferOut → quickExchangeCadenceOut), offset 0 (same day).
  o("FNMA_QX_LOAN_LIST_ADDS_CD10", { anchorField: "loan_list_adds_by", satisfied: "`transfer.loan_list.version_submitted{adds>0}`",
    why: "§17.1 timer table: anchor '10th calendar day of the month before `transfer_date`' — `transfer.batch.approved` carries it as `loan_list_adds_by`; satisfied by the last `transfer.loan_list.version_submitted{adds>0}` (ops-17-1.ts submitLoanListVersion)." });
  o("SM_QX_RECONCILIATION_CD20", { anchorField: "loan_list_reconciliation_by", satisfied: "`transfer.loan_list.reconciled{zero_differences=true}`",
    why: "§17.1 timer table: anchor 'CD20 of the month before `transfer_date`' carried as `loan_list_reconciliation_by`; `transfer.loan_list.reconciled` (download vs system of record, zero differences) — ops-17-1.ts reconcileQxDownload emits it only at zero differences." });
  o("FNMA_QX_LOAN_LIST_FREEZE_CD25", { anchorField: "loan_list_freeze_on", satisfied: "`transfer.loan_list.attested`",
    why: "§17.1 timer table: `transfer.loan_list.attested` (Quick Exchange \"Agree\" evidence) — ops-17-1.ts attestLoanList after the attestation gate; anchor `loan_list_freeze_on` (§1.2 override) = CD25 or the prior Fannie Mae business day." });
  o("FNMA_QX_PROCESSING_BD3", { anchorField: "fnma_processing_on", satisfied: "`fnma.transfer.processed`",
    why: "§17.1 timer table: anchor '3rd `business_days_fannie_et` of the transfer month' carried as `fnma_processing_on` on `transfer.batch.cutover_completed`; `fnma.transfer.processed` (Fannie Mae Connect report shows the transferee servicer on BD3 — ops-17-1.ts fnmaProcessingConfirmation)." });
  // ---- Termination rows (A2-1-07, A1-2-01, A1-2-02, A2-1-01)
  o("FNMA_A2_1_07_FORM101_TERMINATION_5BD", { anchorField: "transfer_date", satisfied: "`transfer.form101_termination.submitted`",
    why: "§17.1 timer table: `transfer.form101_termination.submitted` (e-mail to Technology_Registration@fanniemae.com evidence) — ops-17-1.ts submitForm101Termination by the partner officer." });
  o("FNMA_A2_1_07_FORM582_TERMINATION_REFLECTED", { anchorField: "partner_next_form582_due_on", satisfied: "`form582.submitted{subservicer_removed=true}`",
    why: "§17.1 timer table: `form582.submitted{subservicer_removed}` (18.4) — the partner's Form 582 filing (18.4 `filing.submitted{form=form_582}`, on the partner's fiscal-year subject) is ingested by ops-17-1.ts form582TerminationReflected, which validates it and emits `form582.submitted{subservicer_removed}` on the closed batch (the timer's subject; A2-1-07 'the master servicer must confirm its existing subservicing arrangements when it submits … Form 582'); anchor = partner's next Form 582 due date carried as `partner_next_form582_due_on` on `transfer.batch.closed`." });
  // The notice is a partner-level fact (aggregate `partner`), so the satisfying batch event is its partner-scoped companion
  // `partner.transfer_batch.proposed` that proposeBatch emits alongside `transfer.batch.proposed` (the engine satisfies within one subject).
  o("FNMA_A1_2_02_SALE_ARRANGEMENT_90", { anchorField: "notice_on", satisfied: "`partner.transfer_batch.proposed{type=servicing_sale}`",
    why: "§17.1 timer table: anchor 'notice date' carried as `notice_on` on `fnma.termination_notice.received{without_cause}` (ops-17-1.ts recordNotice); satisfied by `transfer.batch.proposed{type=servicing_sale}` with the Fannie Mae approval request (A1-2-02 90-day sale window: the proposal is what files the Form 629 — FNMA_A2_7_03_FORM629_SERVICING_60 arms on the same event) — emitted on the partner subject as `partner.transfer_batch.proposed` (proposeBatch requires `partner_id` for every termination basis)." });
  o("FNMA_A1_2_02_TRANSFER_AFTER_APPROVAL_60", { anchorField: "approval_on",
    why: "§17.1 timer table: anchor 'approval date' carried as `approval_on` on `transfer.batch.approved{termination_basis=fnma_without_cause}`; +60 CD; satisfied by `transfer.batch.cutover_completed`." });
  // A1-2-01: "effective on the last business day of the third month following the month in which the notice is given".
  // The anchor is computed by ops-17-1.ts voluntaryTerminationEffective() and carried on `partner.termination_notice.sent`;
  // "all batches `cutover`" is the moment the partner's last batch cuts over (transitionTransferOut emits the cutover of the
  // last batch with `last_batch_for_partner=true`, the same fact FORM101_TERMINATION_5BD and ACCESS_REVOCATION_5BD key on).
  o("FNMA_A1_2_01_VOLUNTARY_TERMINATION_EFFECTIVE", { anchorField: "voluntary_termination_effective_on", satisfied: "`partner.transfer_batch.cutover_completed{last_batch_for_partner=true}`",
    why: "§17.1 timer table: anchor = last `business_days_fannie_et` of the 3rd month after the notice month (A1-2-01), satisfied by 'all batches `cutover`' — the last batch's `transfer.batch.cutover_completed{last batch for this partner}`, emitted on the partner subject as `partner.transfer_batch.cutover_completed`." });
  // A2-1-01 applies to portfolios ≥20,000 loans: `transfer.batch.proposed` states `supermortgage_is_tech_provider` as the fact it is and carries the
  // ≥20,000-loan applicability separately as `tech_provider_notice_required` (ops-17-1.ts proposeBatch), so the row arms on the latter.
  o("FNMA_A2_1_01_TECH_PROVIDER_NOTICE_180", { anchorField: "transfer_date", trigger: "`transfer.batch.proposed{tech_provider_notice_required=true}`",
    why: "§17.1 timer table: kind 'deadline (partner duty, monitored; ≥20,000 loans)', trigger `transfer.batch.proposed{supermortgage_is_tech_provider=true}` — A2-1-01 (research/00b Part B(b)): 'For portfolios ≥20,000 loans, 180 days' prior written notice to Fannie Mae of a change of third-party technology provider'; the proposal carries the applicability as `tech_provider_notice_required`; anchor `transfer_date` −180 CD." });
  o("FNMA_A2_1_01_CONTRACT_NOTICE_5BD", { anchorField: "notice_on",
    why: "§17.1 timer table: anchor 'notice date' carried as `notice_on` on `contract.termination_notice.received/sent` (ops-17-1.ts recordNotice); +5 servicer BD (A2-1-01)." });
}
