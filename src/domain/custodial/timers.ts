/**
 * Registry overrides for Section 6 (custodial accounts) timers whose spec
 * rows are prose. Each override cites the row it encodes.
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
  o("FNMA_F120_SA_FUNDS_AVAILABLE_20TH", { trigger: "`period.opened{remittance_type=sa}`", offset: "CD20 (preceding fannie_et BD), 00:01 ET", why: "§6.3 timer table: monthly schedule (S/A) — funds available 00:01 on the 20th (or preceding `business_days_fannie_et`)." });
  o("FNMA_F120_SS_FUNDS_AVAILABLE_18TH", { trigger: "`period.opened{remittance_type=ss}`", offset: "CD18 (preceding fannie_et BD), 00:01 ET", why: "§6.3 timer table: monthly schedule (S/S) — funds available 00:01 on the 18th (or preceding `business_days_fannie_et`)." });
  o("FNMA_LL202605_AA_PREDRAFT_COVERAGE_1BD", { anchorField: "draft_date", offset: "−1 business_days_fannie_et, 15:00 ET", why: "§6.3 timer table: A/A pre-draft notification → coverage confirmed draft date − 1 `business_days_fannie_et`, 15:00 ET." });
  o("SM_RECON_DAILY_CLOSE_5PM", { trigger: "`schedule.tick{cadence=daily_business_servicer}`", offset: "same day, 17:00 local", why: "§6.3 timer table: each servicer business day 17:00 local — daily reconciliation completed." });
  o("SM_RECON_DAILY_FEED_10AM", { trigger: "`schedule.tick{cadence=daily_business_servicer}`", offset: "same day, 10:00 local", why: "§6.3 timer table: each servicer business day 10:00 local — statement received for every active account." });
  o("SM_RECON_ITEM_AGE_90_FUND_OR_CLEAR", { trigger: "`reconciliation_item.opened{kind=cash_shortfall}`", why: "§6.3 timer table: cash-shortfall items funded or cleared within 90 calendar days (policy adopting the Freddie Mac benchmark)." });
  // ---- 6.4 Form 496/496A ---------------------------------------------------
  o("FNMA_LL202605_ESCROW_ATTEST_BD2_M2", { anchorField: "window_close_on", offset: "0, 17:00 ET", why: "§6.4 timer table: window opens BD3 of M+1, closes BD2 of M+2 (`business_days_fannie_et`) (LL-2026-05)." });
  o("SM_F496A_BEFORE_ATTESTATION_GATE", { evaluator: "6.4.form496aReviewedWithZeroOrExplainedVariance", why: "§6.4 timer table: opens when the period's 496A is `under_review` or later with `attestation_variance` = 0 or explained." });
  // ---- 6.5 suspense register -----------------------------------------------
  o("SM_SUSPENSE_REGISTER_WEEKLY", { trigger: "`schedule.tick{cadence=weekly, weekday=monday, at=06:00}`", why: "§6.5 timer table: Monday 06:00 local weekly suspense register review." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("SM_RECON_ITEM_AGE_60", { trigger: "`reconciliation_item.opened`", why: "§6.3 timer table: 'same' as SM_RECON_ITEM_AGE_30 → `reconciliation_item.opened`; 60 calendar days." });
  o("SM_UNIDENTIFIED_RETURN_60", { trigger: "`suspense.item.created{category=unidentified}`", why: "§6.5 timer table: 'same' as SM_UNIDENTIFIED_RESEARCH_30 → `suspense.item.created` (unidentified_*); return at 60 calendar days." });
}
