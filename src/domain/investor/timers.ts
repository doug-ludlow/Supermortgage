/**
 * Registry overrides for Section 5 (investor reporting) timers whose spec
 * rows are prose or whose grammar columns cannot carry the spec's condition.
 *
 * Event vocabulary the rows resolve against (emitters: §2 cashiering for
 * `investor_events.created`; the §5 tools in src/app/tools/section05.ts for
 * the satisfaction events; the period scheduler for
 * `investor_reporting_periods.opened/closed` and `period.month_end`, whose
 * payload is `periodAnchors()` from ./period.ts):
 *   - `investor_events.created{family, mode, processed_at}` → `.submitted` → `.accepted{event_type, family}`
 *     / `.resolved{status}`; `investor_event_exceptions.detected{family, period_end}` (`exceptionDetectedEvent`).
 *   - `investor_reporting_periods.opened{period_start, period_end, ss_draft_on, sa_draft_on, gfee_draft_on, pool_draft_on,
 *     gfee_bill_due_on, following_month_start}` / `.closed{checklist_complete}`; `period.month_end` = last calendar day.
 * Computed anchors (`anchorField`) stand in for the min()/"CDn of the following month − 1 BD" shapes the offset grammar
 * cannot express; the domain clocks in ./period.ts and ./ops.ts are the authority the anchors are computed with.
 *
 * Known grammar limit (documented in docs/audit): the removal clock "next BD 20:00 ET, **17:00 ET if that day is BD2**"
 * is one code with two wall times. The engine rows carry the general next-BD 20:00 ET rule; the BD2 17:00 ET tightening is
 * enforced by `FNMA_IRM_PERIOD_CLOSE_BD2_1700` (rule 10 checklist item iii, `periodCloseChecklist`) and by the domain clock
 * `larDeadlineMs(processed_at, true)` that every removal projection stamps on its event as `due_at`.
 */
import type { TimerRegistry, TimerOverride } from "../../kernel/timers/registry.ts";

export function applyInvestorTimerOverrides(reg: TimerRegistry): void {
  // `registry.override` re-derives `anchorField` from the raw anchor column on every call, so a code whose trigger/anchor
  // and satisfaction are declared in two places would lose its computed anchor. Overrides are accumulated per code and
  // applied once, so every clause below survives.
  const pending = new Map<string, TimerOverride>();
  const o = (code: string, ov: TimerOverride): void => { const prev = pending.get(code) ?? {}; const why = [prev.why, ov.why].filter(Boolean).join(" · "); pending.set(code, { ...prev, ...ov, ...(why ? { why } : {}) }); };
  // ---- 5.1 LAR / events ----------------------------------------------------
  o("FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000", { trigger: "`investor_events.created{family!=removal}`", anchorField: "processed_at", offset: "next business_days_fannie_et at 20:00 ET",
    why: "§5.1 timer table: `investor_events.created` (family payment/nonpayment — every non-removal family) → next business day 20:00 America/New_York (`business_days_fannie_et`, 1) after `processed_at` (C-4.3-01)." });
  o("FNMA_IRM_LAR_IRED_CD22_2000", { trigger: "`investor_reporting_periods.opened`", anchorField: "period_start", offset: "CD22 (preceding fannie_et BD), 20:00 ET",
    why: "§5.1 timer table: `investor_reporting_periods.opened` → calendar day 22 of the period month (preceding BD if not BD) 20:00 ET — the IRED floor 'regardless of whether a payment was received' (IRM p. 11); the anchor is the period's first day." });
  o("FNMA_IRM_REMOVAL_NEXTBD_2000", { trigger: "`investor_events.created{family=removal}`", anchorField: "processed_at", offset: "next business_days_fannie_et at 20:00 ET",
    why: "§5.1 timer table: `investor_events.created` (family removal) → next `fannie_et` BD 20:00 ET after `processed_at`; the '17:00 ET if that day is BD2' tightening is carried by FNMA_IRM_PERIOD_CLOSE_BD2_1700 checklist (iii) and `larDeadlineMs` (grammar limit, see header)." });
  o("FNMA_IRM_REMOVAL_CORRECTION_BD2_1700", { trigger: "`investor_event_exceptions.detected{family=removal}`", anchorField: "period_end", offset: "BD2 17:00 ET",
    why: "§5.1/5.3/5.6 timer tables: exception on a removal event → correction by BD2 17:00 ET of the month following the activity period; anchor = the period's last calendar day (`period_end` on the exception event, `exceptionDetectedEvent`), + 2 `fannie_et` BDs." });
  o("FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000", { trigger: "`investor_event_exceptions.detected{family!=removal}`", anchorField: "period_end", offset: "BD1 20:00 ET",
    why: "§5.1 timer table: exception on a non-removal event (every family but `removal` — the data model has no 'nonremoval' family) → correction by BD1 20:00 ET of the following month, anchored on the period's last calendar day." });
  o("FNMA_IRM_BULK_CUTOFF_BD2_1500", { trigger: "`investor_reporting_periods.opened`", anchorField: "period_end", offset: "BD2 15:00 ET",
    why: "§5.1 timer table: period close job — bulk B2B/LSDU upload cutoff BD2 15:00 ET of the following month (Investor Reporting Manual), armed when the period opens." });
  o("FNMA_IRM_PERIOD_CLOSE_BD2_1700", { trigger: "`investor_reporting_periods.opened`", anchorField: "period_end", offset: "BD2 17:00 ET", satisfied: "`investor_reporting_periods.closed{checklist_complete=true}`",
    why: "§5.1 timer table: period → close BD2 17:00 ET (Investor Reporting Manual); satisfied by `investor_reporting_periods.closed` with the rule 10 checklist complete (`periodCloseChecklist`), including (iii) every removal processed on/before BD1 reported by the BD2 17:00 ET clock." });
  o("FNMA_IRM_LAR83_5BD_2000", { trigger: "`loan_terms.*`", anchorField: "calculation_date", offset: "+5 business_days_fannie_et, 20:00 ET", satisfied: "`investor_events.submitted{event_type=rate_payment.change}`",
    why: "§5.1 timer table: `loan_terms.rate_changed` scheduled (also `loan_terms.payment_changed` / `.converted_to_fixed`, and §2.4's `loan_terms.activated` re-amortization — every loan-terms change reports a LAR 83) → 5 `business_days_fannie_et` 20:00 ET after the scheduled interest-rate calculation date (rate effective date − look-back), carried as `calculation_date`; satisfied when the `rate_payment.change` event is submitted." });
  o("FNMA_IRM_LAR89_PERIOD_END", { trigger: "`mi.*{lar89_action_code present}`", anchorField: "period_end_date", offset: "BD2 17:00 ET", satisfied: "`investor_events.accepted{event_type=mi.discontinuance}`",
    why: "§5.1 timer table: `mi.cancelled`/`mi.terminated` (both carry the LAR 89 action code 51/52 or 53/54 — the matcher has no alternation, so the family wildcard is narrowed by the code) → LAR 89 by the last reporting day of the period containing the effective date = BD2 17:00 ET of the following month (`lar89DueMs`); anchor `period_end_date` = last calendar day of the effective month; satisfied when the `mi.discontinuance` event is accepted." });
  o("FNMA_IRM_TT32_15CD", { trigger: "`transfer_out.approved`", anchorField: "transfer_date", offset: "−15 calendar_days", satisfied: "`investor_events.accepted{event_type=transfer.servicing}`",
    why: "§5.1 timer table: `transfer_out.approved` (17.1, payload `transfer_date`) → TT 32 due 15 calendar days before the transfer effective date (`tt32DueOn`); satisfied when the `transfer.servicing` event is accepted." });
  o("FNMA_IRM_DEFERRAL_LAR_BEFORE_EOM_1BD", { trigger: "`lossmit.deferral.approved`", anchorField: "processing_month_end", offset: "−1 business_days_fannie_et",
    why: "§5.1 timer table: `lossmit.deferral.approved` → the contractual-payment LAR accepted at least 1 `business_days_fannie_et` before the last day of the processing month (IRM 4-01, `deferralLarDeadlineOn`); anchor `processing_month_end` on the approval event." });
  o("FNMA_LL202605_EVENT_NEXTBD_0300", { trigger: "`investor_events.created{mode=event}`", anchorField: "processed_at", offset: "next business_days_fannie_et at 03:00 ET", satisfied: "`investor_events.submitted`",
    why: "§5.1 timer table: `investor_events.created` where mode=event (any family, including §2.4's curtailment events) → next `fannie_et` BD 03:00 ET after `processed_at` (LL-2026-05)." });
  o("FNMA_LL202605_NOPAYMENT_CD22", { trigger: "`investor_reporting_periods.opened`", anchorField: "period_start", offset: "CD22 (preceding fannie_et BD), 23:59 ET", satisfied: "`investor_events.accepted{event_type=payment.none}`",
    why: "§5.1 timer table: period → no-payment events by CD22 (preceding BD) 23:59 ET (LL-2026-05); satisfied when the `payment.none` event is accepted." });
  o("FNMA_LL202605_PERIOD_CLOSE_BD2_1700", { trigger: "`investor_reporting_periods.opened`", anchorField: "period_end", offset: "BD2 17:00 ET", why: "§5.1 timer table: period → close BD2 17:00 ET (LL-2026-05)." });
  o("FNMA_LL202605_ESCROW_ATTEST_BD2", { trigger: "`investor_reporting_periods.closed{escrow_events=true}`", anchorField: "attestation_window_close_on", offset: "0, 17:00 ET",
    why: "§5.1 timer table: period (escrow) — BD3 opens; due BD2 of following month 17:00 ET (LL-2026-05)." });
  // ---- 5.2 remittances -----------------------------------------------------
  o("FNMA_CRS_INSTRUCTION_T1_2000", { trigger: "`crs.instruction.needed`", anchorField: "effective_date", offset: "−1 business_days_fannie_et, 20:00 ET", why: "§5.2 timer table: new/changed bank instruction → CRS instruction −1 BD 20:00 ET before effective date." });
  o("FNMA_CRS_REQUEST_1600", { anchorField: "settlement_date", offset: "−1 business_days_fannie_et, 16:00 ET", why: "§5.2 timer table: `crs_batches.prepared` → CRS upload by settlement date −1 BD 16:00 ET." });
  o("FNMA_F120_AA_BD1_PRIOR_MONTH", { trigger: "`period.month_end{aa_collections_unremitted=true}`", offset: "BD1 16:00 ET of the following month", why: "§5.2 timer table: A/A collection on last work day not remitted → instruct by BD1 16:00 ET (F-1-20, `bd1CatchUpMs`)." });
  o("FNMA_F120_AA_DETAILED_48H", { trigger: "`investor_events.accepted{reporting=detailed, remittance_type=aa}`", anchorField: "accepted_at", why: "§5.2 timer table: detailed-reporting LAR accepted → draft observed within 48 hours (F-1-20)." });
  o("FNMA_F120_AA_MONTHLY_MIN", { trigger: "`investor_reporting_periods.opened{remittance_type=aa}`", anchorField: "period_start", offset: "last business day of month, 16:00 ET (fannie_et)", why: "§5.2 timer table: period open (A/A < $2,500) → instruct by last BD of the period month 16:00 ET." });
  o("FNMA_F120_AA_REMIT_2500_SAMEDAY", { trigger: "`custodial.aa_sweep{net_collections_cents>250000}`", offset: "same day, 16:00 ET", why: "§5.2 timer table: A/A collections net of servicing fees > $2,500 at the 15:00 ET sweep → same-day CRS request by 16:00 ET (settles next BD; `aaSweepBatch`)." });
  o("FNMA_F120_DRAFT_NOTICE_BD3", { trigger: "`investor_reporting_periods.closed`", anchorField: "period_end", offset: "BD3 12:00 ET", why: "§5.2 timer table: period close → draft notifications received & reconciled by BD3 12:00 ET of the following month (anchor = period end + 3 `fannie_et` BDs)." });
  o("FNMA_F120_MBSX_UNSCHED_BD4", { trigger: "`payment.received{unscheduled_principal=true, remittance_type=mbs_express}`", anchorField: "following_month_start", offset: "BD4", why: "§5.2 timer table: unscheduled principal collected (MBS Express) → funded BD4 of the month after collection." });
  o("FNMA_F120_PAYOFF_AA_IMMEDIATE", { trigger: "`payoff.funds.cleared{remittance_type=aa, amount_cents>250000}`", offset: "next business_days_fannie_et at 16:00 ET", why: "§5.2 timer table: A/A payoff funds > $2,500 → same/next BD CRS request (code 001)." });
  o("FNMA_F120_RPM_DRAFT_DESIGNATED", { trigger: "`investor_reporting_periods.opened{remittance_type=rpm}`", anchorField: "designated_draft_date", offset: "−1 business_days_fannie_et, 16:00 ET", why: "§5.2 timer table: period open (RPM pools) → funding check −1 BD 16:00 before the designated date (preceding BD)." });
  o("FNMA_F120_SA_DRAFT_CD20", { trigger: "`investor_reporting_periods.opened{remittance_type=sa}`", anchorField: "sa_draft_on", offset: "−1 business_days_fannie_et, 16:00 ET", why: "§5.2 timer table: period open (S/A) → draft CD20 of the following month (preceding BD, `periodAnchors.sa_draft_on`); the deadline is the funding check −1 BD 16:00 ET." });
  o("FNMA_F120_SETTLEMENT_NEXT_REMIT_DATE", { anchorField: "next_remittance_date", offset: "0", why: "§5.2 timer table: `settlement.received` → instructed by next month's remittance date (computed anchor)." });
  o("FNMA_F120_SS_6TH_POOL_CD5", { trigger: "`investor_reporting_periods.opened{remittance_type=ss, pool_draft_day=6}`", anchorField: "pool_draft_on", offset: "−1 business_days_fannie_et, 16:00 ET", why: "§5.2 timer table: period open (6th-day pools) → funded by CD5 = the BD before the CD6 draft (`periodAnchors.pool_draft_on`), 16:00 ET funding check." });
  o("FNMA_F120_SS_DRAFT_CD18", { trigger: "`investor_reporting_periods.opened{remittance_type=ss}`", anchorField: "ss_draft_on", offset: "−1 business_days_fannie_et, 16:00 ET", why: "§5.2 timer table: period open (S/S standard/portfolio) → draft CD18 of the following month (preceding `fannie_et` BD, `periodAnchors.ss_draft_on`); the deadline is the funding check −1 BD 16:00 ET (5.2-T1: Nov 18 draft → Tue Nov 17 16:00 ET)." });
  o("FNMA_F120_SHORTSALE_PROCEEDS_2BD", { offset: "+2 business_days_fannie_et, 16:00 ET", why: "§5.2 timer table: `shortsale.proceeds.received` → CRS 357/324 within 2 `business_days_fannie_et` of receipt (hard cap 3 BD after the sale), breaching at the 16:00 ET CRS cut-off (5.2-T11)." });
  o("FNMA_F120_TPS_PROCEEDS_NEXT_REMIT", { offset: "next business_days_fannie_et at 16:00 ET", why: "§5.2 timer table: `tps.proceeds.received` → CRS 311/351 instructed by 16:00 ET the next `fannie_et` BD (5.3 worked example); the row's bare 'BD' would otherwise resolve to the servicer calendar." });
  o("FNMA_IRM_SHORTAGE_IMMEDIATE", { trigger: "`fnma.shortage_surplus.shortage_confirmed{reconciled=false}`", why: "§5.2 timer table: unreconciled shortage detected → CRS remittance instructed within 1 BD." });
  o("FNMA_IRM_SURPLUS_RESOLVE_90", { trigger: "`fnma.shortage_surplus.surplus_identified`", anchorField: "first_seen_on", why: "§5.2 timer table: surplus first appears (`first_seen_on`, else the event date) → explained/reconciled within 90 calendar days (`surplusResolveDueOn`; 5.2-T10 Sept 3 → Dec 2, 2026)." });
  o("FNMA_LL202605_AA_AUTODRAFT_2BD", { trigger: "`investor_events.accepted{remittance_type=aa, phase=autodraft}`", offset: "+2 business_days_fannie_et", why: "§5.2 timer table: payment event accepted (auto-draft phase) → funded 2 BD; funding check +1 BD 16:00 ET (LL-2026-05, `aaAutoDraftSchedule`)." });
  o("FNMA_LL202605_PREDRAFT_REVIEW_1BD", { trigger: "`fnma.draft_notification.received{kind=predraft}`", offset: "same day, 15:00 ET", why: "§5.2 timer table: pre-draft notification received → reviewed/variance filed same BD 15:00 ET." });
  o("SM_CUSTODIAL_FUNDING_T1_1600", { trigger: "`remittance.draft.scheduled`", anchorField: "draft_date", offset: "−1 business_days_fannie_et, 16:00 ET", why: "§5.2 timer table: any draft date → custodial balance ≥ expected drafts by −1 BD 16:00 ET." });
  // ---- 5.3 liquidations ----------------------------------------------------
  o("FNMA_E4101_REOGRAM_CONFIRM_1BD", { trigger: "`reogram.created`", why: "§5.3 timer table: REOgram case created (P360 notice / AC 70-72 acceptance / DRA sale event) → confirm within 1 `business_days_fannie_et` (E-4.1-01)." });
  o("FNMA_IRM_PAYOFF_AC60_NEXTBD_2000", { anchorField: "processed_at", offset: "next business_days_fannie_et at 20:00 ET", satisfied: "`investor_events.submitted{event_type=removal.payoff}`",
    why: "§5.3 timer table: `payoff.funds.cleared` processed → LAR 60 next `fannie_et` BD 20:00 ET (17:00 if BD2 — carried by the period-close checklist (iii) and `larDeadlineMs`); satisfied when the `removal.payoff` investor event is submitted." });
  o("FNMA_IRM_LIQ_AC70_72_NEXTBD_2000", { trigger: "`liquidation_facts.processed`", anchorField: "processed_at", offset: "next business_days_fannie_et at 20:00 ET", satisfied: "`investor_events.submitted{event_type∈{removal.liquidation.uninsured, removal.liquidation.third_party, removal.liquidation.insured}}`",
    why: "§5.3 timer table: liquidation fact processed → LAR 70/71/72 next BD 20:00 ET (17:00 if BD2 — period-close checklist (iii) / `larDeadlineMs`); satisfied when a `removal.liquidation.*` investor event is submitted." });
  o("FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD", { trigger: "`liquidation_facts.processed`", anchorField: "processed_at", offset: "next business_days_fannie_et at 03:00 ET", why: "§5.3 timer table: foreclosure/liquidation event processed → P360 event next BD (03:00 ET event standard)." });
  o("FNMA_P360_REOGRAM_EXCEPTION_3BD", { trigger: "`reogram.exception.raised`", why: "§5.3 timer table: REOgram exception raised → resolved within 3 BD." });
  o("SM_LIQ_CODE_CHANGE_CPM_2BD", { trigger: "`liquidation.code_change.needed`", why: "§5.3 timer table: code change needed after close → CPM notification within 2 BD." });
  // ---- 5.4 delinquency advances / SDA --------------------------------------
  o("FNMA_A1306_RECLASS_SELECTION_6M", { trigger: "`investor_reporting_periods.closed{regular_servicing_option=true, consecutive_months_delinquent>=6}`", why: "§5.4 timer table: regular servicing option loan six consecutive months delinquent at period end → reclass purchase advice expected (A1-3-06)." });
  o("FNMA_C301_SDA_PREDICT_EOM", { trigger: "`period.month_end`", offset: "last day of month, 23:59 ET", why: "§5.4 timer table: period end → `sda_status.predicted` set/cleared by last calendar day 23:59 ET (C-3-01)." });
  o("FNMA_F120_SDA_EXIT_RESUME_DRAFT", { trigger: "`loan.became_current{sda_active=true}`", offset: "18th of the following month (preceding fannie_et BD)", why: "§5.4 timer table: loan becomes current → scheduled P&I funded at next draft date (CD18)." });
  o("FNMA_F120_SDA_STATUS_RECONCILE_BD3", { trigger: "`fnma.connect.report.available{report=sda_status}`", offset: "BD3 12:00 ET", why: "§5.4 timer table: BD3 report available → every predicted/active loan reconciled by BD3 12:00 ET." });
  o("FNMA_F125_RECLASS_DESELECT_CD15", { trigger: "`fnma.connect.report.available{report=eligible_for_deselection}`", offset: "CD15", why: "§5.4 timer table: Eligible for Deselection report (~CD11) → deselection decision by CD15 (F-1-25)." });
  o("FNMA_IRM_SDA_CONTRACTUAL_LAR_NEXTBD_2000", { trigger: "`payment.applied{sda_active=true, contractual=true}`", offset: "next business_days_fannie_et at 20:00 ET", why: "§5.4 timer table: full contractual payment applied on an SDA loan → LAR next BD 20:00 ET (5.1 clock)." });
  o("SM_SDA_RECOVERY_MATCH_2_CYCLES", { trigger: "`investor_events.accepted{sda_active=true, contractual=true}`", offset: "18th of the month after next (preceding fannie_et BD)", why: "§5.4 timer table: contractual payment reported on SDA loan → recovery adjustment matched within 2 draft cycles (CD18 drafts)." });
  o("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES", { trigger: "`sda_status.exited`", offset: "18th of the month after next (preceding fannie_et BD)", why: "§5.4 timer table: exit by reclass/deferral/liquidation → `advances.status = reimbursed_by_fnma` within 2 draft cycles." });
  // ---- 5.5 guaranty fees ---------------------------------------------------
  o("FNMA_F120_GFEE_BILL_RETRIEVE_CD5", { trigger: "`investor_reporting_periods.opened`", anchorField: "gfee_bill_due_on", offset: "0, 12:00 ET", why: "§5.5 timer table: period open → g-fee bill parsed by CD5 12:00 ET of the following month (`periodAnchors.gfee_bill_due_on`)." });
  o("FNMA_F120_GFEE_DRAFT_CD7", { trigger: "`investor_reporting_periods.opened`", anchorField: "gfee_draft_on", offset: "−1 business_days_fannie_et, 16:00 ET",
    why: "§5.5 timer table: period open → g-fee draft CD7 of the following month (preceding `fannie_et` BD, `periodAnchors.gfee_draft_on` = `gfeeDraft().draft_on`); the deadline is the funding check −1 BD 16:00 ET (5.5-T1: Fri Nov 6 draft → Thu Nov 5 16:00 ET; 5.5-T6: Jan 7 → Wed Jan 6 16:00 ET)." });
  o("FNMA_F120_GFEE_RELIEF_RECONCILE_BILL", { trigger: "`gfee.bill.parsed`", offset: "same day", why: "§5.5 timer table: bill parsed → every predicted/active relief loan reconciled the same BD." });
  o("FNMA_F120_GFEE_RESUME_ON_CURRENT", { trigger: "`loan.became_current{gfee_relief_active=true}`", offset: "7th of the following month (preceding fannie_et BD)", why: "§5.5 timer table: loan becomes current → g-fee funded at next CD7." });
  o("SM_GFEE_RECOVERY_MATCH_2_CYCLES", { trigger: "`investor_events.accepted{gfee_relief_active=true, contractual=true}`", offset: "7th of the month after next (preceding fannie_et BD)", why: "§5.5 timer table: contractual payment on a relief loan → recovery/retention matched within 2 bill cycles (CD7)." });
  // ---- 5.6 repurchases -----------------------------------------------------
  o("FNMA_A1302_APPEAL1_60", { trigger: "`repurchase.demand.received`", why: "§5.6 timer table: demand received → first appeal filed or decision not to appeal within 60 calendar days (A1-3-02)." });
  o("FNMA_A1302_APPEAL2_15", { trigger: "`repurchase.appeal.denied{stage=1}`", why: "§5.6 timer table: first-appeal denial → second appeal within 15 calendar days (A1-3-02)." });
  o("FNMA_A1302_DOCS_30", { trigger: "`repurchase.file_review.selected`", why: "§5.6 timer table: file selected for review → documents within 30 calendar days (A1-3-02)." });
  o("FNMA_A1302_IMPASSE_30", { trigger: "`repurchase.stage.entered`", anchorField: "stage_deadline_on", offset: "0", why: "§5.6 timer table: stage entered → 30/30/15/15 calendar days by stage; the stage's own deadline is the computed anchor (`stage_deadline_on` from stageDeadline in ops-5-6.ts; see timers-5-6.ts)." });
  o("FNMA_A1302_REPURCHASE_PAY_60", { trigger: "`repurchase.demand.received`", why: "§5.6 timer table: demand received → funded within 60 calendar days (active loans: next scheduled remittance after day 60)." });
  o("FNMA_F120_REPURCHASE_PROCEEDS_BY_TYPE", { trigger: "`investor_events.accepted{event_type=removal.repurchase}`", anchorField: "remittance_due_on", offset: "0", why: "§5.6 timer table: proceeds due by remittance type — S/S CD18 / MBS Express BD4 / S/A CD20 / A/A immediate (CRS 001 by 16:00 ET); computed by repurchaseProceedsDue in ops-5-6.ts (timers-5-6.ts re-triggers the row on `repurchase.proceeds.scheduled{remittance_due_on}`)." });
  o("FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000", { trigger: "`repurchase.processed`", anchorField: "processed_at", offset: "next business_days_fannie_et at 20:00 ET",
    why: "§5.6 timer table: repurchase processed → LAR 65/67 next `fannie_et` BD 20:00 ET (17:00 if BD2 — period-close checklist (iii) / `larDeadlineMs`, which `projectLar65` stamps as `due_ms`)." });
  o("SM_REPURCHASE_OWNERSHIP_UPDATE_10BD", { trigger: "`repurchase.proceeds.matched`", why: "§5.6 timer table: proceeds matched → MERS TOB/TOS + custodian release + `investor` field updated within 10 BD." });
  // ---- 5.7 delinquency reporting -------------------------------------------
  o("FNMA_F121_AW_ONE_MONTH", { trigger: "`delinquency_report_lines.submitted{status_code=AW}`", offset: "+1 months", satisfied: "`delinquency_report_lines.submitted{status_code!=AW}`",
    why: "§5.7/11.3 timer tables: AW reported for a loan (per-line submission event from `submitAmnFile`) → must not be repeated in the next period; satisfied by that loan's next line carrying any other code (F-1-21: AW 'must only be reported for one month')." });
  o("FNMA_F121_DQ_CORRECT_CD10", { trigger: "`delinquency_reports.exception_parsed`", offset: "CD10 (preceding fannie_et BD), 17:00 ET", why: "§5.7 timer table: exception report parsed → corrections transmitted and accepted by CD10 17:00 ET, the preceding business day when CD10 is not one (5.7-T5: Sat Oct 10 → Fri Oct 9, 2026)." });
  o("FNMA_F121_DQ_REPORT_BD2", { trigger: "`period.month_end`", offset: "BD2 17:00 ET of the following month", why: "§5.7 timer table: period end → delinquency report by BD2 17:00 ET (`fannie_et`) (F-1-21)." });
  o("FNMA_F121_DQ_SNAPSHOT_EOM", { trigger: "`period.month_end`", offset: "last day of month, 23:59 ET", why: "§5.7 timer table: month end → snapshot built as of last calendar day 23:59 ET." });
  o("FNMA_LL202605_DQ_EVENT_NEXTBD_0300", { trigger: "`delinquency.action.processed`", offset: "next business_days_fannie_et at 03:00 ET", why: "§5.7 timer table: delinquency action processed → event submitted next BD 03:00 ET (LL-2026-05)." });
  o("FNMA_LL202605_DQ_PMT_REMINDER_CD23", { trigger: "`period.month_end{periods_delinquent=1}`", offset: "CD23 of the following month", why: "§5.7 timer table: 1 period delinquent → Payment Reminder Notice event accepted by CD23." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("FNMA_A14201_COMPFEE_WATCH", { trigger: "`period.month_end`", offset: "monthly", why: "§5.1 timer table: monthly compensatory-fee watch (A1-4.2-01)." });
  o("SM_DRA_RECONCILE_7CD", { trigger: "`schedule.tick{cadence=weekly, weekday=monday, at=09:00}`", why: "§5.3 timer table: weekly, Monday 09:00 ET DRA reconciliation." });
  o("FNMA_F121_DQ_EXCEPTIONS_BD4", { trigger: "`period.month_end`", offset: "BD4 12:00 ET", why: "§5.7 timer table: BD4 12:00 ET delinquency exceptions (F-1-21)." });
  o("FNMA_F121_DQ_FINAL_CD11", { trigger: "`period.month_end`", offset: "CD11 of the following month, 12:00 ET", why: "§5.7 timer table: CD11 12:00 ET final delinquency report (F-1-21)." });
  o("FNMA_D2401_DQ_MGMT_ACTION_GATE", { trigger: "`delinquency_reports.snapshot_built`", evaluator: "5.7.managementActionRecorded", why: "§5.7 timer table: snapshot → every loan with a management action in the month is in the file even if current (D2-4-01)." });
  o("SM_DQ_SMDU_DRA_CONSISTENCY_BD1", { trigger: "`period.month_end`", offset: "BD1 12:00 ET", why: "§5.7 timer table: BD1 12:00 ET SMDU/DRA consistency check." });
  // ---- satisfaction events (spec "Satisfied by" prose → event patterns) ----
  // 5.1
  o("FNMA_A14201_COMPFEE_WATCH", { satisfied: "`report.produced{report=compfee_watch}`", why: "§5.1 timer table: informational monthly watch — the compensatory-fee instance count report (A1-4.2-01 ladder)." });
  o("FNMA_IRM_BULK_CUTOFF_BD2_1500", { satisfied: "`investor_batches.bulk_channel.closed`", why: "§5.1 timer table: after the BD2 15:00 ET cutoff the adapter switches the bulk channel off (remaining items → `lsdu_single`)." });
  o("FNMA_IRM_DEFERRAL_LAR_BEFORE_EOM_1BD", { satisfied: "`investor_events.accepted{event_type=payment.contractual, deferral_pending=true}`", why: "§5.1 timer table: 'contractual-payment LAR accepted' (IRM 4-01)." });
  o("FNMA_IRM_LAR_IRED_CD22_2000", { satisfied: "`investor_events.accepted{family∈{payment, nonpayment}}`", why: "§5.1 timer table: 'any accepted `payment.*` event in period or `payment.none` submitted' — an accepted event of the payment family or the accepted `payment.none` (family nonpayment); a submitted-but-rejected LAR does not clear the IRED floor, and the breach action auto-submits `payment.none`." });
  o("FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000", { satisfied: "`investor_events.resolved{status∈{superseded, accepted}}`", why: "§5.1 timer table: `superseded`/`accepted`." });
  o("FNMA_IRM_REJECT_TRIAGE_4H", { satisfied: "`investor_event_exceptions.triaged`", why: "§5.1 timer table: 'triage decision recorded' (rule 9)." });
  o("FNMA_IRM_REMOVAL_CORRECTION_BD2_1700", { satisfied: "`investor_events.resolved{status=superseded, family=removal}`", why: "§5.1/5.3/5.6/16.2 timer tables: the superseding removal event accepted (`superseded`)." });
  o("FNMA_IRM_REMOVAL_NEXTBD_2000", { satisfied: "`investor_events.submitted{family=removal}`", why: "§5.1 timer table: `submitted`." });
  o("FNMA_LL202605_ESCROW_ATTEST_BD2", { satisfied: "`human_portal_task.completed{task=escrow_attestation}`", why: "§5.1 timer table: `human_portal_task` completed with attestation evidence (LL-2026-05)." });
  o("FNMA_LL202605_PERIOD_CLOSE_BD2_1700", { satisfied: "`investor_reporting_periods.closed`", why: "§5.1 timer table: 'period closed'." });
  // 5.2
  o("FNMA_CRS_INSTRUCTION_T1_2000", { satisfied: "`crs.instruction.confirmed`", why: "§5.2 timer table: 'CRS instruction confirmed'." });
  o("FNMA_CRS_REQUEST_1600", { satisfied: "`crs_batches.upload_confirmed`", why: "§5.2 timer table: 'CRS upload confirmed' (operator screenshot)." });
  o("FNMA_F120_AA_BD1_PRIOR_MONTH", { satisfied: "`remittances.instructed{remittance_type=aa}`", why: "§5.2 timer table: `instructed`." });
  o("FNMA_F120_AA_DETAILED_48H", { satisfied: "`remittances.drafted{reporting=detailed}`", why: "§5.2 timer table: `drafted` observed." });
  o("FNMA_F120_AA_MONTHLY_MIN", { satisfied: "`remittances.instructed{remittance_type=aa}`", why: "§5.2 timer table: `instructed`." });
  o("FNMA_F120_AA_REMIT_2500_SAMEDAY", { satisfied: "`remittances.instructed{crs_code=001}`", why: "§5.2 timer table: `instructed` (CRS code 001 same day)." });
  o("FNMA_F120_DRAFT_NOTICE_BD3", { satisfied: "`fnma.draft_notification.reconciled`", why: "§5.2 timer table: `draft_notifications` received & reconciled." });
  o("FNMA_F120_MBSX_UNSCHED_BD4", { satisfied: "`remittances.funded{remittance_type=mbs_express}`", why: "§5.2 timer table: `funded`." });
  o("FNMA_F120_PAYOFF_AA_IMMEDIATE", { satisfied: "`payoff.remittance.instructed`", why: "§5.2/16.2 timer tables: `instructed` / `payoff.remittance.instructed` (CRS 001)." });
  o("FNMA_F120_RPM_DRAFT_DESIGNATED", { satisfied: "`remittances.funded{remittance_type=rpm}`", why: "§5.2 timer table: `funded`." });
  o("FNMA_F120_SA_DRAFT_CD20", { satisfied: "`remittances.funded{remittance_type=sa}`", why: "§5.2 timer table: `funded`." });
  o("FNMA_F120_SETTLEMENT_NEXT_REMIT_DATE", { satisfied: "`remittances.instructed{kind=settlement}`", why: "§5.2 timer table: 'instructed'." });
  o("FNMA_F120_SHORTSALE_PROCEEDS_2BD", { satisfied: "`remittances.instructed{crs_code∈{357, 324}}`", why: "§5.2/5.3 timer tables: 'CRS 357/324 instructed'." });
  o("FNMA_F120_SS_6TH_POOL_CD5", { satisfied: "`remittances.funded{remittance_type=ss, pool_draft_day=6}`", why: "§5.2 timer table: `funded`." });
  o("FNMA_F120_SS_DRAFT_CD18", { satisfied: "`remittances.funded{remittance_type=ss}`", why: "§5.2 timer table: `remittances.funded` for all S/S codes (the T−1 16:00 ET funding check, `fundDraft`/`advanceTransfer`)." });
  o("FNMA_F120_TPS_PROCEEDS_NEXT_REMIT", { satisfied: "`remittances.instructed{crs_code∈{311, 351}}`", why: "§5.2 timer table: 'instructed' (CRS 311/351)." });
  o("FNMA_IRM_SHORTAGE_IMMEDIATE", { satisfied: "`remittances.instructed{crs_code=001, reason=shortage}`", why: "§5.2 timer table: 'CRS remittance instructed' (rule 9)." });
  o("FNMA_IRM_SURPLUS_RESOLVE_90", { satisfied: "`fnma.shortage_surplus.resolved{kind=surplus}`", why: "§5.2 timer table: 'surplus explained/reconciled' (Form 472 Schedule 3, `form472Schedule3`)." });
  o("FNMA_LL202605_AA_AUTODRAFT_2BD", { satisfied: "`remittances.funded{remittance_type=aa}`", why: "§5.2 timer table: `funded` (LL-2026-05 auto-draft)." });
  o("FNMA_LL202605_PREDRAFT_REVIEW_1BD", { satisfied: "`fnma.draft_notification.reviewed`", why: "§5.2 timer table: 'reviewed/variance filed'." });
  o("SM_CUSTODIAL_FUNDING_T1_1600", { satisfied: "`custodial.funding.verified{covered=true}`", why: "§5.2 timer table: 'custodial balance ≥ expected drafts' — the T−1 16:00 ET funding check records the verification (rule 7)." });
  // 5.3
  o("FNMA_E4101_REOGRAM_CONFIRM_1BD", { satisfied: "`reogram.confirmed`", why: "§5.3/12.9/13.3/15.1 timer tables: `human_portal_task` completed with the P360 confirmation → `reogram.confirmed`." });
  o("FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD", { satisfied: "`p360.liquidation_event.accepted`", why: "§5.3 timer table: 'P360 liquidation event accepted'." });
  o("FNMA_P360_REOGRAM_EXCEPTION_3BD", { satisfied: "`reogram.exception.resolved`", why: "§5.3 timer table: 'exception resolved'." });
  o("SM_DRA_RECONCILE_7CD", { satisfied: "`dra.reconciliation.recorded`", why: "§5.3 timer table: 'reconciliation run recorded' (rule 7, weekly; `reconcileDra`)." });
  o("SM_LIQ_CODE_CHANGE_CPM_2BD", { satisfied: "`cpm.notification.sent`", why: "§5.3 timer table: 'CPM notification sent (human)' — sent by `fnma_portal_operator`/`officer`." });
  o("SM_PAYOFF_GOODFUNDS_GATE", { satisfied: "`payoff.funds.cleared`", why: "§5.3/16.2 timer tables: the gate holds 'until `payoff.funds.cleared`' — AC 60 is projected only from that event (rule 6)." });
  // 5.4
  o("FNMA_A1306_RECLASS_SELECTION_6M", { satisfied: "`fnma.purchase_advice.received{kind=reclass}`", why: "§5.4 timer table: 'reclass purchase advice received' (A1-3-06)." });
  o("FNMA_F120_SDA_EXIT_RESUME_DRAFT", { satisfied: "`remittances.funded{remittance_type=ss, sda_resumed=true}`", why: "§5.4 timer table: 'scheduled P&I funded' at the next CD18 draft." });
  o("FNMA_F120_SDA_FUNDING_HOLD", { satisfied: "`sda_status.exited`", why: "§5.4/15.4 timer tables: the hold blocks advance funding while `sda_status.active`; it lifts on exit (rule 5)." });
  o("FNMA_F120_SDA_STATUS_RECONCILE_BD3", { satisfied: "`sda_status.reconciled`", why: "§5.4 timer table: 'every predicted/active loan reconciled to Fannie Mae's status' (`rollForwardReceivables`)." });
  o("FNMA_F125_RECLASS_DESELECT_CD15", { satisfied: "`reclass.deselection.decided`", why: "§5.4/5.7 timer tables: 'deselection decision recorded' (`human_portal_task` if deselecting)." });
  o("FNMA_IRM_SDA_CONTRACTUAL_LAR_NEXTBD_2000", { satisfied: "`investor_events.accepted{event_type=payment.contractual, sda_active=true}`", why: "§5.4 timer table: 'contractual-payment event accepted with updated LPI'." });
  o("SM_SDA_RECOVERY_MATCH_2_CYCLES", { satisfied: "`sda.adjustment.matched{kind∈{fnma_recovery, servicer_retention}}`", why: "§5.4 timer table: 'recovery adjustment matched (Fannie Mae recovery, then servicer retention)' (`matchAdjustments`)." });
  o("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES", { satisfied: "`advances.reimbursed_by_fnma{all_outstanding=true}`", why: "§5.4/15.4 timer tables: '`advances.status = reimbursed_by_fnma` for all outstanding' (`matchAdjustments`)." });
  // 5.5
  o("FNMA_F120_GFEE_BILL_RETRIEVE_CD5", { satisfied: "`gfee.bill.parsed`", why: "§5.5 timer table: 'bill parsed into `draft_notifications`' (`parseGfeeBill`)." });
  o("FNMA_F120_GFEE_RELIEF_RECONCILE_BILL", { satisfied: "`gfee_relief.reconciled`", why: "§5.5 timer table: 'every predicted/active relief loan reconciled to the bill' (`reconcileRelief`)." });
  o("FNMA_F120_GFEE_DRAFT_CD7", { satisfied: "`remittances.funded{kind=gfee}`", why: "§5.5 timer table: g-fee `remittances.funded` (`fundDraft`)." });
  o("FNMA_F120_GFEE_RESUME_ON_CURRENT", { satisfied: "`remittances.funded{kind=gfee}`", why: "§5.5 timer table: 'g-fee funded' at the next CD7." });
  o("SM_GFEE_RECOVERY_MATCH_2_CYCLES", { satisfied: "`gfee.recovery.matched{kind∈{fnma_recovery, servicer_retention}}`", why: "§5.5 timer table: 'Fannie Mae recovery then servicer retention matched' (rule 4, `matchDebit`)." });
  // 5.6
  o("FNMA_A1302_APPEAL1_60", { satisfied: "`repurchase.appeal.decided{stage=1, outcome∈{filed, not_appealed}}`", why: "§5.6 timer table: 'appeal filed or decision not to appeal recorded' (A1-3-02)." });
  o("FNMA_A1302_APPEAL2_15", { satisfied: "`repurchase.appeal.decided{stage=2, outcome∈{filed, waived}}`", why: "§5.6 timer table: 'second appeal filed / waived'." });
  o("FNMA_A1302_DOCS_30", { satisfied: "`repurchase.documents.submitted`", why: "§5.6 timer table: 'documents submitted'." });
  o("FNMA_A1302_IMPASSE_30", { satisfied: "`repurchase.stage.action_recorded`", why: "§5.6 timer table: 'next-stage action recorded' (30/30/15/15 ladder)." });
  o("FNMA_A1302_REPURCHASE_PAY_60", { satisfied: "`remittances.funded{kind=repurchase}`", why: "§5.6 timer table: `funded`." });
  o("FNMA_F120_REPURCHASE_PROCEEDS_BY_TYPE", { satisfied: "`remittances.funded{kind=repurchase}`", why: "§5.6 timer table: `remittances.funded`/`instructed` for the repurchase proceeds." });
  o("FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000", { satisfied: "`investor_events.submitted{action_code∈{65, 67}}`", why: "§5.6 timer table: 'LAR 65/67 submitted'." });
  o("SM_REPURCHASE_OWNERSHIP_UPDATE_10BD", { satisfied: "`repurchase.ownership.updated`", why: "§5.6 timer table: 'MERS TOB/TOS + custodian release + loan `investor` field updated'." });
  // 5.7
  o("FNMA_F121_DQ_CORRECT_CD10", { satisfied: "`delinquency_reports.corrections_accepted`", why: "§5.7 timer table: 'corrections transmitted and accepted'." });
  o("FNMA_F121_DQ_EXCEPTIONS_BD4", { satisfied: "`delinquency_reports.exception_parsed`", why: "§5.7 timer table: 'exception report parsed' (`parseExceptionReport`)." });
  o("FNMA_F121_DQ_FINAL_CD11", { satisfied: "`delinquency_reports.final_reconciled`", why: "§5.7 timer table: 'final report reconciled'." });
  o("FNMA_F121_DQ_REPORT_BD2", { satisfied: "`delinquency_reports.submitted`", why: "§5.7 timer table: `delinquency_reports.submitted` with ack (`submitAmnFile`)." });
  o("FNMA_F121_DQ_SNAPSHOT_EOM", { satisfied: "`delinquency_reports.snapshot_built`", why: "§5.7 timer table: 'snapshot built' (`buildDqSnapshot`)." });
  o("FNMA_LL202605_DQ_EVENT_NEXTBD_0300", { satisfied: "`delinquency_events.submitted`", why: "§5.7 timer table: 'event submitted' (LL-2026-05, `submitDqEvent`)." });
  o("FNMA_LL202605_DQ_PMT_REMINDER_CD23", { satisfied: "`delinquency_events.accepted{servicer_action_type=payment_reminder_notice}`", why: "§5.7 timer table: 'Payment Reminder Notice event accepted'." });
  o("SM_DQ_SMDU_DRA_CONSISTENCY_BD1", { satisfied: "`delinquency_reports.consistency_checked{errors=0}`", why: "§5.7 timer table: 'AMN codes consistent with SMDU (workouts) and DRA/P360 (sale/REO) statuses' (rule 7, `checkConsistency`)." });
  for (const [code, ov] of pending) reg.override(code, ov);
}
