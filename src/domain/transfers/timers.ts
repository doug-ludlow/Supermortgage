/**
 * Registry overrides for Sections 1.2–1.7 and 17 timers whose spec rows carry
 * conditions or computed anchors the column grammar cannot express. Each
 * override cites the row prose it encodes; condition-shaped gates name the
 * domain evaluator that asserts them.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";
import { applySatisfiedOverrides_17_1 } from "./timers-17-1.ts";
import { applySatisfiedOverrides_17_2 } from "./timers-17-2.ts";
import { applySatisfiedOverrides_17_3 } from "./timers-17-3.ts";
import { applySatisfiedOverrides_17_4 } from "./timers-17-4.ts";

export function applyTransferTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 1.2 transfer intake ------------------------------------------------
  o("FNMA_A2_1_07_FORM101_INCEPTION", { trigger: "`transfer.batch.proposed{first_batch_for_partner=true}`", evaluator: "1.2.form101Present",
    why: "§1.2 timer table: trigger `transfer.batch.proposed{first batch for this partner}`; gate = `form101_document_id` present (A2-1-07)." });
  o("FNMA_A2_1_07_FORMS_1013_1014_GATE", { trigger: "`transfer.batch.proposed{first_batch_for_partner=true}`", evaluator: "1.2.forms1013And1014Executed",
    why: "§1.2 timer table: 'same' trigger as FORM101_INCEPTION; gate = CBAM-executed Forms 1013/1014 evidence present (A2-1-07)." });
  o("FNMA_A2_7_03_FORM2017_GATE", { trigger: "`transfer.batch.proposed{first_batch_for_partner=true}`", evaluator: "1.2.form2017ValidForCustodian",
    why: "§1.2 timer table: 'same' trigger; gate = valid Form 2017 for transferee custodian (A2-7-03)." });
  o("FNMA_A2_7_03_TRANSFER_DATE_GATE", { evaluator: "1.2.transferDateIsFirstFannieBusinessDay",
    why: "§1.2 timer table: `transfer_date` must equal first `business_days_fannie_et` of month (A2-7-03); asserted in `proposeBatch`." });
  // ---- 1.3 RESPA notices ---------------------------------------------------
  o("REGX_1024_33C1_LATE_FEE_PROTECTION_60", { anchorField: "respa_effective_date", offset: "window [+1, +60] calendar_days",
    why: "§1.3 timer table: window days 1–60 (calendar) from `respa_effective_date`; expires day 61 (§1024.33(c)(1))." });
  o("SM_TOLLFREE_LIVE_GATE", { evaluator: "1.3.tollFreeAndIvrDisclosureLive",
    why: "§1.3 timer table: toll-free number and IVR/AI disclosure verified live before `transfer_notice_run.planned` proceeds." });
  // ---- 1.4 custody ---------------------------------------------------------
  o("SM_CUSTODY_RECORD_GATE", { evaluator: "1.4.custodyRecordPresent", why: "§1.4 timer table: custody record present on `loan.staged`; satisfied by `HF-018` pass." });
  // ---- 1.5 MERS ------------------------------------------------------------
  o("SM_MERS_INVESTOR_FNMA_CHECK", { trigger: "`loan.staged{min is not null}`", evaluator: "1.5.mersInvestorIsFannieMae",
    why: "§1.5 timer table: investor/note owner on MERS = Fannie Mae Org ID; satisfied by `W-016` pass." });
  // ---- 1.6 reconciliation --------------------------------------------------
  o("SM_RECON_LOAN_LEVEL_T0", { evaluator: "1.6.loanReconciledBeforeBoard", why: "§1.6 timer table: loan must be `reconciled` before `boardLoan` (T0 = `transfer_date`)." });
  // ---- 1.7 in-flight loss mitigation --------------------------------------
  o("REGX_1024_41B2_ACK_5_DEEMED_T0", { trigger: "`loan.boarded{lossmit_application_open=true, prior_1024_41_subject=false}`",
    why: "§1.7 timer table: `loan.boarded{application not previously subject to §1024.41}`; deemed receipt on `transfer_date` (+5 federal BD, §1024.41(k)(1))." });
  o("REGX_1024_41H_APPEAL_WINDOW_14", { trigger: "`loan.boarded{appeal_window_unexpired=true}`", anchorField: "transferor_denial_sent_on",
    why: "§1.7 timer table: `loan.boarded{denial with unexpired appeal window}`; anchor = transferor denial sent date (+14 CD, §1024.41(h))." });
  o("REGX_1024_41K2_NO_FIRST_FILING_GATE", { trigger: "`loan.boarded{lossmit_application_incomplete=true, reasonable_date is not null}`", anchorField: "transferor_reasonable_date",
    why: "§1.7 timer table: `loan.boarded{incomplete app with reasonable date}`; anchor `transferor_reasonable_date` (§1024.41(k)(2))." });
  o("REGX_1024_41K2_TRANSFEREE_ACK_10", { trigger: "`loan.boarded{lossmit_ack_unexpired=true, lossmit_ack_sent=false}`",
    why: "§1.7 timer table: `loan.boarded{lossmit ack unexpired & not sent}` (+10 federal BD from `transfer_date`, §1024.41(k)(2))." });
  o("REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE", { trigger: "`loan.boarded{lossmit_offer_pending=true}`", anchorField: "acceptance_deadline",
    why: "§1.7 timer table: `loan.boarded{offer pending}`; anchor = original `acceptance_deadline`, offset 0 (§1024.41(k)(5) unexpired balance)." });
  o("SM_SMDU_CASE_ACCESS_T0", { trigger: "`loan.boarded{lossmit_status∈{lossmit_in_process, trial_in_progress}}`",
    why: "§1.7 timer table: `loan.boarded{lossmit_in_process or trial_in_progress}`; SMDU case accessible on `transfer_date`." });
  // ---- 17.1 termination ----------------------------------------------------
  o("FNMA_A2_1_01_CONTRACT_NOTICE_5BD", { trigger: "`contract.termination_notice.*`", why: "§17.1 timer table: `contract.termination_notice.received/sent`; +5 servicer BD (A2-1-01)." });
  o("FNMA_A2_1_07_FORM101_TERMINATION_5BD", { trigger: "`transfer.batch.cutover_completed{last_batch_for_partner=true}`",
    why: "§17.1 timer table: `transfer.batch.cutover_completed{last batch for this partner}`; +5 servicer BD policy (A2-1-07 'at termination')." });
  o("FNMA_A2_1_07_FORM582_TERMINATION_REFLECTED", { trigger: "`transfer.batch.closed{last_batch_for_partner=true}`", anchorField: "partner_next_form582_due_on",
    why: "§17.1 timer table: `transfer.batch.closed{last batch}`; anchor = partner's next Form 582 due date (FYE + 90 days, 18.4)." });
  o("SM_XFER_OUT_ACCESS_REVOCATION_5BD", { trigger: "`transfer.batch.cutover_completed{last_batch_for_partner=true}`",
    why: "§17.1 timer table: `transfer.batch.cutover_completed{last batch}`; +5 servicer BD after final-period close." });
  // ---- 17.2 borrower communications ---------------------------------------
  o("SM_XFER_OUT_BORROWER_ROUTING_90", { offset: "window [+1, +90] calendar_days",
    why: "§17.2 timer table: days 1–90 after `transfer_date` borrower-comms routing scripts active; after day 90 calls referred to transferee only." });
  o("SM_XFER_OUT_CORRECTIVE_NOTICE_5", { trigger: "`transfer.batch.cancelled`", why: "§17.2 timer table: `transfer.batch.cancelled/date_changed` after goodbye mailed; +5 servicer BD (policy). `transfer.batch.date_changed` arms the same code." });
  o("SM_XFER_OUT_FINAL_STATEMENT_GATE", { evaluator: "17.2.noStatementForCyclesOnOrAfterTransfer", why: "§17.2 timer table: no statement for cycles with due dates ≥ `transfer_date` (7.1)." });
  o("SM_XFER_OUT_FORWARD_FILE_DAILY", { offset: "daily", why: "§17.2 timer table: forward file each servicer business day 17:00 local, daily through day 90 (support window)." });
  // ---- 17.3 deliverables ---------------------------------------------------
  o("FNMA_F1_11_TRIAL_BALANCE_T1", { anchorField: "transfer_date", offset: "+1 business_days_servicer",
    why: "§17.3 timer table: trial balance as of COB `transfer_date − 1`, delivered +1 servicer BD (F-1-11 D04)." });
  o("SM_XFER_OUT_CUSTODIAL_ACCOUNT_CLOSE", { trigger: "`transfer.final_remittance.cleared{last_batch_for_partner=true}`",
    why: "§17.3 timer table: final-period remittance draft cleared + final Form 496/496A (6.3/6.4) for the last batch; +10 servicer BD." });
  o("SM_XFER_OUT_POST_T_EVENT_GATE", { evaluator: "17.3.noInvestorEventsOnOrAfterTransferDate", why: "§17.3 timer table: no `investor_events` with activity dates ≥ T for listed loans." });
  // ---- 17.4 in-flight cases ------------------------------------------------
  o("FNMA_F1_27_TRIAL_PAYMENT_EOM", { trigger: "`case_handoffs.inventoried{trial_payment_due_before_transfer=true}`", anchorField: "trial_due_date", offset: "last day of that month",
    why: "§17.4 timer table: trial payment due before T; due last day of due month (F-1-27)." });
  o("REGX_1024_41_TRANSFEROR_CONTINUES_GATE", { evaluator: "17.4.noTransferOutCancellationBeforeTransferDate",
    why: "§17.4 timer table: no 12.x/13.x/14.x/4.x timer on a listed loan may be cancelled with reason `transfer_out` before `transfer_date` (§1024.41(k))." });
  o("SM_CLAIM_HANDOFF_T1", { trigger: "`case_handoffs.inventoried{case_kind∈{insurance_claim, mi_claim}}`", why: "§17.4 timer table: `case_handoffs.inventoried{insurance_claim or mi_claim open}`; −1 servicer BD before `transfer_date`." });
  o("SM_FC_SALE_WINDOW_HANDOFF", { trigger: "`case_handoffs.inventoried{case_kind=foreclosure, sale_within_45_days=true}`", why: "§17.4 timer table: `case_handoffs.inventoried{fc sale date ≤ T+45}`; −5 servicer BD." });
  o("SM_FPI_CYCLE_HANDOFF_T1", { trigger: "`case_handoffs.inventoried{case_kind=fpi_notice_cycle}`", why: "§17.4 timer table: `case_handoffs.inventoried{fpi notice cycle open}`; −1 servicer BD." });
  o("SM_LOSSMIT_HOLD_INSTRUCTIONS_T1", { trigger: "`case_handoffs.inventoried{case_kind=foreclosure}`", why: "§17.4 timer table: `case_handoffs.inventoried{fc_active or gates open}`; −1 servicer BD." });
  o("SM_NOE_RFI_OPEN_RETAINED", { trigger: "`case.opened{kind∈{noe, rfi, complaint}, before_transfer=true}`", evaluator: "17.4.retainedCaseOwnership",
    why: "§17.4 timer table: `case.noe/rfi/complaint.opened` before T — Supermortgage remains owner; 4.1/4.2 clocks unchanged." });
  o("SM_PAYOFF_REQUEST_OPEN_7BD", { trigger: "`payoff.request.received{before_transfer=true}`", why: "§17.4 timer table: payoff request received before T; +7 BD (Reg Z §1026.36(c)(3))." });
  o("SM_SII_PENDING_HANDOFF_T1", { trigger: "`case_handoffs.inventoried{case_kind=sii}`", why: "§17.4 timer table: `case_handoffs.inventoried{sii pending}`; −1 servicer BD." });
  // ---- satisfaction: rows whose `satisfied` column is prose get the event the domain emits ----------
  o("REGX_1024_33B3_EXCEPTION_30", { satisfied: "`notice.sent{template∈{NTC_REGX_1024_33B_HELLO_MS2, NTC_REGX_1024_33B_COMBINED_MS2}}`", why: "§1.3 timer table: 'notice mailed' — the §1024.33(b)(3) exception notice is the hello/combined MS-2 notice." });
  o("REGX_1024_33C1_LATE_FEE_PROTECTION_60", { satisfied: "`transfer.protection_window.expired`", why: "§1.3 timer table: 'expires day 61' — the day-61 sweep emits `transfer.protection_window.expired` for the batch." });
  o("FNMA_DTJA_RECERT_ISALE_30", { satisfied: "`custody.recert.completed{code_type=I}`", why: "§1.4 timer table: 'same' as the D-code recert — the custodian's Complete file acknowledgment." });
  o("FNMA_F1_11_ENOTE_SERVICING_AGENT_T0", { satisfied: "`enote.eregistry.verified{servicing_agent=1009999}`", why: "§1.4 timer table: `enote.eregistry.verified{servicing_agent=Supermortgage Org ID}` — Org ID 1009999 (inbound.ts SUPERMORTGAGE_ORG_ID)." });
  o("MERS_RULE7_LOCKOUT_WARNING_30", { satisfied: "`mers.lockout.remediated{penalties_paid=true}`", why: "§1.5 timer table: 'remediation + penalties paid'." });
  o("REGX_1024_41K2_TRANSFEREE_ACK_10", { satisfied: "`notice.sent{template∈{NTC_REGX_41B2_ACK_INCOMPLETE, NTC_REGX_41B2_ACK_COMPLETE}}`", why: "§1.7 / 12.1: the (k)(2) acknowledgment is the §1024.41(b)(2)(i)(B) notice pair; `notice.sent` carries `template`." });
  o("REGX_1024_41B2_ACK_5_DEEMED_T0", { satisfied: "`notice.sent{template∈{NTC_REGX_41B2_ACK_INCOMPLETE, NTC_REGX_41B2_ACK_COMPLETE}}`", why: "§1.7 timer table: 'acknowledgment sent (12.1)'." });
  o("REGX_1024_41K3_COMPLETE_APP_EVAL_30", { satisfied: "`notice.sent{template∈{NTC_REGX_41C1_OFFER, NTC_REGX_41C1_DENIAL}}`", why: "§1.7 timer table: the §1024.41(c)(1) determination pair (12.2)." });
  o("REGX_1024_41C1_EVAL_30_CARRYOVER", { satisfied: "`notice.sent{template∈{NTC_REGX_41C1_OFFER, NTC_REGX_41C1_DENIAL}}`", why: "§1.7 timer table: the §1024.41(c)(1) determination pair (12.2)." });
  o("REGX_1024_41K4_APPEAL_DETERMINATION_30", { satisfied: "`notice.sent{template∈{NTC_REGX_41H4_APPEAL_GRANTED, NTC_REGX_41H4_APPEAL_DENIED}}`", why: "§1.7 timer table: the §1024.41(h)(4) appeal determination pair (12.3)." });
  o("REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE", { satisfied: "`lossmit.offer.closed{outcome∈{accepted, rejected, expired}}`", why: "§1.7 timer table: `lossmit.offer.accepted/rejected` or expiry — one closing event with the outcome." });
  o("REGX_1024_41H_APPEAL_WINDOW_14", { satisfied: "`lossmit.appeal_window.closed{outcome∈{appeal_received, expired}}`", why: "§1.7 timer table: 'appeal received or expiry'." });
  o("REGX_1024_41K2_NO_FIRST_FILING_GATE", { evaluator: "1.7.noFirstFilingBeforeReasonableDate", why: "§1.7 timer table: `assertGateOpen` in `foreclosure.referral`/first-filing commands — condition-shaped, so an evaluator over {today, reasonable_date}." });
  o("FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M", { evaluator: "1.7.forbearanceCumulativeWithin12Months", why: "§1.7 timer table: `assertGateOpen` on forbearance extension — cumulative ≤ 12 months unless Fannie Mae approves an exception (LL-2026-01)." });
  // ---- pseudo-trigger rows (bare tokens copied from prose) ------------------
  o("MERS_ANNUAL_REPORT_1231", { trigger: "`period.year_end`", why: "§1.5 timer table: 'calendar' — MERS annual report anchored Dec 31 each year." });
  o("SM_XFER_OUT_CUSTODIAL_CLOSE_60", { trigger: "`transfer.custodial_recon.acked{adjustment_window_closed=true, open_variance=false}`", why: "§17.3 timer table: `FNMA_F1_11_CUSTODIAL_RECON_5BD` satisfied and the T+30 adjustment window closed with no open variance → +60 calendar days." });
  o("SM_XFER_OUT_VENDOR_NOTICE_T1", { trigger: "`transfer.batch.approved{direction=out}`", why: "§17.3 timer table: 'same' as SM_XFER_OUT_INSURER_ENDORSEMENT_T1 → `transfer.batch.approved{direction=out}`; −1 servicer BD." });
  o("SM_XFER_OUT_TAXING_AUTHORITY_NOTICE_T1", { trigger: "`transfer.batch.approved{direction=out}`", why: "§17.3 timer table: 'same' as SM_XFER_OUT_INSURER_ENDORSEMENT_T1; −1 servicer BD." });
  // per-process satisfaction overrides (§17.x), applied last so they win the merge
  applySatisfiedOverrides_17_1(reg); applySatisfiedOverrides_17_2(reg); applySatisfiedOverrides_17_3(reg); applySatisfiedOverrides_17_4(reg);
}
