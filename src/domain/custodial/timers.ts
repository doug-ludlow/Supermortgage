/**
 * Registry overrides for Section 6 (custodial accounts) timers whose spec
 * rows are prose, whose anchors are computed, or whose "Satisfied by" column
 * names a status rather than an event. Each override cites the row it
 * encodes; the events named here are the ones src/app/tools/section06.ts
 * emits (suspense.item.*, reconciliation_item.*, custodial.*).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyCustodialTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 6.1 P&I accounts ----------------------------------------------------
  o("FNMA_A2107_CUSTODIAL_EVIDENCE_BEFORE_629_GATE", { evaluator: "6.1.activeAccountsForEveryRemittanceType", why: "§6.1 timer table: opens when every remittance type in the transfer file has an `active` P&I account and an `active` T&I account (A2-1-07)." });
  o("FNMA_A4102_RATING_MONITOR_RECUR", { offset: "monthly", why: "§6.1 timer table: monthly (S&P/Moody's) and within 5 calendar days of each IDC/KBRA quarterly publication (cadence UNVERIFIED); quarterly leg armed by `custodial.rating_publication.received`." });
  o("FNMA_F103_FORM1013_IN_EFFECT_GATE", { offset: "until custodial.form.in_effect", why: "§6.1 timer table: opens on `custodial.form.in_effect` (Form 1013, F-1-03)." });
  // ---- 6.2 T&I accounts ----------------------------------------------------
  o("FNMA_F103_FORM1014_IN_EFFECT_GATE", { trigger: "`custodial.account.planned{kind=ti}`", offset: "until custodial.form.in_effect", why: "§6.2 timer table: opens on `custodial.form.in_effect` with matching remittance types (Form 1014, F-1-03)." });
  o("STATE_ESCROW_INTEREST_CREDIT_RECUR", { trigger: "`escrow.account.opened{interest_state=true}`", anchorField: "next_interest_credit_on", offset: "0", why: "§6.2 timer table: cadence per `jurisdiction_rules.escrow_interest.frequency` (annual/quarterly/at analysis) — computed anchor via `6.2.nextInterestCreditDate`." });
  // ---- 6.3 reconciliation --------------------------------------------------
  // Day 45 rolled back to the preceding servicer business day (6.3-T2: 2026-09-30 → Fri 2026-11-13, not Sat 11/14) is
  // outside the offset grammar (steps only roll forward), so the deadline is a computed anchor: `periodClosedEvent`
  // (6.3 ops) puts `recon_due_on` = form496Deadline(period_end).due_on and `recon_warning_on` (day 30) on
  // `ledger.period.closed`; the servicer's local time is ET.
  o("FNMA_F496_PI_RECON_45", { trigger: "`ledger.period.closed{account_kind=pi}`", anchorField: "recon_due_on", offset: "0, 17:00 ET", why: "§6.3 timer table: 45 calendar_days, 17:00 local; if day 45 is a non-business day the internal `due_at` is the preceding servicer business day; `warning_at` = day 30 — computed by `6.3 form496Deadline`, carried on `ledger.period.closed{recon_due_on, recon_warning_on}` per P&I account × remittance type." });
  o("SM_F496_DRAFT_BD10", { trigger: "`ledger.period.closed{account_kind=pi}`", anchorField: "period_end", why: "§6.3 timer table: anchor month-end → `period_end` on `ledger.period.closed`; 10 business_days_servicer to `custodial.reconciliation.drafted`." });
  o("FNMA_F120_SA_FUNDS_AVAILABLE_20TH", { trigger: "`period.opened{remittance_type=sa}`", offset: "CD20 (preceding fannie_et BD), 00:01 ET", why: "§6.3 timer table: monthly schedule (S/A) — funds available 00:01 on the 20th (or preceding `business_days_fannie_et`)." });
  o("FNMA_F120_SS_FUNDS_AVAILABLE_18TH", { trigger: "`period.opened{remittance_type=ss}`", offset: "CD18 (preceding fannie_et BD), 00:01 ET", why: "§6.3 timer table: monthly schedule (S/S) — funds available 00:01 on the 18th (or preceding `business_days_fannie_et`)." });
  o("FNMA_LL202605_AA_PREDRAFT_COVERAGE_1BD", { anchorField: "draft_date", offset: "−1 business_days_fannie_et, 15:00 ET", why: "§6.3 timer table: A/A pre-draft notification → coverage confirmed draft date − 1 `business_days_fannie_et`, 15:00 ET." });
  o("SM_RECON_DAILY_CLOSE_5PM", { trigger: "`schedule.tick{cadence=daily_business_servicer}`", offset: "same day, 17:00 local", why: "§6.3 timer table: each servicer business day 17:00 local — daily reconciliation completed." });
  o("SM_RECON_DAILY_FEED_10AM", { trigger: "`schedule.tick{cadence=daily_business_servicer}`", offset: "same day, 10:00 local", why: "§6.3 timer table: each servicer business day 10:00 local — statement received for every active account." });
  o("SM_RECON_ITEM_AGE_90_FUND_OR_CLEAR", { trigger: "`reconciliation_item.opened{kind=cash_shortfall}`", why: "§6.3 timer table: cash-shortfall items funded or cleared within 90 calendar days (policy adopting the Freddie Mac benchmark)." });
  // ---- 6.4 Form 496/496A ---------------------------------------------------
  o("FNMA_F496A_TI_RECON_45", { trigger: "`ledger.period.closed{account_kind∈{ti, ti_unapplied, ti_loss_draft, ti_buydown}}`", anchorField: "recon_due_on", offset: "0, 17:00 ET", why: "§6.4 timer table: 45 calendar_days, 17:00 local (preceding BD if non-business); `warning_at` day 30 — computed by `6.3 form496Deadline`, carried on `ledger.period.closed{recon_due_on}` per T&I account (6.4-T8: 2026-09-30 → 2026-11-13 17:00)." });
  o("SM_F496A_DRAFT_BD10", { trigger: "`ledger.period.closed{account_kind∈{ti, ti_unapplied, ti_loss_draft, ti_buydown}}`", anchorField: "period_end", why: "§6.4 timer table: anchor month-end → `period_end` on `ledger.period.closed`; 10 business_days_servicer to `custodial.reconciliation.drafted`." });
  o("FNMA_LL202605_ESCROW_ATTEST_BD2_M2", { anchorField: "window_close_on", offset: "0, 17:00 ET", why: "§6.4 timer table: window opens BD3 of M+1, closes BD2 of M+2 (`business_days_fannie_et`) (LL-2026-05)." });
  o("SM_F496A_BEFORE_ATTESTATION_GATE", { evaluator: "6.4.form496aReviewedWithZeroOrExplainedVariance", why: "§6.4 timer table: opens when the period's 496A is `under_review` or later with `attestation_variance` = 0 or explained." });
  // ---- 6.5 suspense register -----------------------------------------------
  o("SM_SUSPENSE_REGISTER_WEEKLY", { trigger: "`schedule.tick{cadence=weekly, weekday=monday, at=06:00}`", why: "§6.5 timer table: Monday 06:00 local weekly suspense register review." });
  // The trigger column's parentheticals ("reason partial_payment", "unidentified_*", "overpayment / post_payoff_receipt")
  // are conditions on `suspense_items.reason_code`, which `suspense.read/write` carries on `suspense.item.created`.
  o("FNMA_C1102_PARTIAL_BALANCE_30", { trigger: "`suspense.item.created{reason_code=partial_payment}`", why: "§6.5 timer table: `suspense.item.created` (reason partial_payment) — 30 calendar days from received_on to accumulation." });
  o("FNMA_C1102_50_RULE_COUNT_12M", { trigger: "`suspense.item.created{reason_code=partial_payment_50_rule}`", why: "§6.5 timer table: `suspense.item.created` (partial_payment_50_rule) — rolling 12-month counter, max 3 (C-1.1-02)." });
  o("SM_UNIDENTIFIED_RESEARCH_30", { trigger: "`suspense.item.created{reason_code∈{unidentified_loan, unidentified_payer}}`", why: "§6.5 timer table: `suspense.item.created` (unidentified_*) — research ≤ 30 calendar days." });
  o("SM_OVERPAYMENT_REFUND_10BD", { trigger: "`suspense.item.created{reason_code∈{overpayment, post_payoff_receipt}}`", why: "§6.5 timer table: `suspense.item.created` (overpayment / post_payoff_receipt with no due amounts) — refund within 10 business_days_servicer (policy)." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("SM_RECON_ITEM_AGE_60", { trigger: "`reconciliation_item.opened`", why: "§6.3 timer table: 'same' as SM_RECON_ITEM_AGE_30 → `reconciliation_item.opened`; 60 calendar days." });
  o("SM_UNIDENTIFIED_RETURN_60", { trigger: "`suspense.item.created{reason_code∈{unidentified_loan, unidentified_payer}}`", why: "§6.5 timer table: 'same' as SM_UNIDENTIFIED_RESEARCH_30 → `suspense.item.created` (unidentified_*); return at 60 calendar days." });
  // ---- satisfaction events (spec "Satisfied by" prose → event patterns) ----
  o("FNMA_F103_FORM1013_IN_EFFECT_GATE", { satisfied: "`custodial.form.in_effect{kind=1013}`", why: "§6.1 timer table: the gate opens on `custodial.form.in_effect` (Form 1013) — the executed-document verification (6.1-T7) emits it." });
  o("FNMA_F103_FORM1014_IN_EFFECT_GATE", { satisfied: "`custodial.form.in_effect{kind=1014}`", why: "§6.2 timer table: the gate opens on `custodial.form.in_effect` with matching remittance types (Form 1014)." });
  // 6.3 `ledger.post_reclass{reconciliation_item_id, item_status}` emits `reconciliation_item.resolved{status}` when a posting, clearing or funding resolves an item.
  o("SM_RECON_ITEM_AGE_30", { satisfied: "`reconciliation_item.resolved{status∈{cleared, posted, funded}}`", why: "§6.3 timer table: item `cleared`/`posted`/`funded` — emitted by `ledger.post_reclass` when it resolves the item." });
  o("SM_RECON_ITEM_AGE_60", { satisfied: "`reconciliation_item.resolved{status∈{cleared, posted, funded}}`", why: "§6.3 timer table: 'same' as SM_RECON_ITEM_AGE_30." });
  o("SM_RECON_ITEM_AGE_90_FUND_OR_CLEAR", { satisfied: "`reconciliation_item.resolved{status∈{funded, cleared}}`", why: "§6.3 timer table: `funded` or `cleared` (cash-shortfall items)." });
  o("FNMA_F120_SA_FUNDS_AVAILABLE_20TH", { satisfied: "`custodial.draft.coverage_confirmed{remittance_type=sa}`", why: "§6.3 timer table: 'same' as FNMA_F120_SS_FUNDS_AVAILABLE_18TH → `custodial.draft.coverage_confirmed` (F-1-20 S/A on the 20th)." });
  // 6.5 `suspense.read/write` emits `suspense.item.status_changed{status}` on every status change, `suspense.item.matched` when a loan is identified,
  // and `suspense.item.closed{status}` on a terminal status; `nacha.originate_credit`/`check.issue` move the item to `returned`.
  o("SM_SUSPENSE_TRIAGE_1BD", { satisfied: "`suspense.item.status_changed{status∈{matched_pending, applied, researching, contact_pending}}`", why: "§6.5 timer table: `suspense.item.matched` / `researching` / `contact_pending` — the triage outcome is the item's first status change." });
  o("SM_UNIDENTIFIED_RESEARCH_30", { satisfied: "`suspense.item.status_changed{status∈{matched_pending, applied, returned}}`", why: "§6.5 timer table: `suspense.item.matched` or `return_initiated` — a match or the return the rail tools initiate." });
  o("SM_UNIDENTIFIED_RETURN_60", { satisfied: "`suspense.item.status_changed{status=returned}`", why: "§6.5 timer table: `returned` (payer known) — otherwise the item moves to `escheat_pending` at breach." });
  o("SM_SUSPENSE_AGE_90_ESCALATE", { satisfied: "`suspense.item.closed{status∈{applied, returned, refunded, escheated, transferred, written_off, applied_to_oldest}}`", why: "§6.5 timer table: 'terminal status' (6.5 state machine terminals; `applied_to_oldest` is 2.5's outcome on the same register)." });
  o("SM_OVERPAYMENT_REFUND_10BD", { satisfied: "`suspense.item.closed{status∈{refunded, applied}}`", why: "§6.5/16.2 timer tables: `refunded` or `applied` (borrower elected curtailment)." });
  // 6.4 `positive_pay.read/void` emits `disbursement.closed{status}` (paid file → cleared, void instruction → voided) beside the literal `disbursement.cleared`/`disbursement.voided`.
  o("SM_STALE_CHECK_180", { satisfied: "`disbursement.closed{status∈{cleared, voided}}`", why: "§6.4 timer table: `disbursement.cleared` or `disbursement.voided` — one event type with the outcome (positive-pay paid file or the void instruction)." });
  o("SM_TI_OUTSTANDING_CHECK_90", { satisfied: "`disbursement.closed{status=cleared}`", why: "§6.4 timer table: `disbursement.cleared` — the positive-pay paid file clears the check." });
  o("STATE_UUPA_DUE_DILIGENCE_NOTICE_60_180", { anchorField: "filing_date", satisfied: "`notice.sent{template=UP-DUE-DILIGENCE-v1}`", why: "§6.5 timer table: `notice.sent` (`UP-DUE-DILIGENCE-v1`) — the Notice Registry's send event carries `template`." });
}
