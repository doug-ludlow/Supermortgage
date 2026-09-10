/**
 * §6.3 timer overrides (process-owned; the §6 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 6.3 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. Every event named here is appended by a function in ./ops-6-3.ts (through the 6.3
 * tools in src/app/tools/section06.ts + section6-3.ts) or, for the inbound Fannie Mae period/notification/Schedule 3
 * events, by 5.1/5.2's ops (src/domain/investor/ops-5-1.ts, ops-5-2.ts).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_6_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("SM_RECON_DAILY_FEED_10AM", { satisfied: "`custodial.statement.received{all_active_accounts=true}`",
    why: "§6.3 timer table: satisfied by `custodial.statement.received` for every active account — receiveStatement (ops-6-3, `bank.read_statement`) stamps `all_active_accounts` once the prior-day file of every active P&I account for the as-of date has passed rule 1's control totals; the 10:00 local recurring row is armed by the scheduler's `schedule.tick{cadence=daily_business_servicer}` (dailyTick); a missing file opens `statement_missing` at the daily close." });
  o("SM_RECON_ITEM_AGE_60", { anchorField: "first_seen_on",
    why: "§6.3 timer table: anchor 'same' as SM_RECON_ITEM_AGE_30 → `first_seen_on` on `reconciliation_item.opened` (classifyResiduals / closeDailyReconciliation / receiveStatement); 60 calendar_days to `reconciliation_item.resolved{status∈{cleared, posted, funded}}` (`ledger.post_reclass`), `officer` high." });
  o("SM_RECON_ITEM_AGE_90_FUND_OR_CLEAR", { anchorField: "first_seen_on",
    why: "§6.3 timer table: anchor 'same' → `first_seen_on`; trigger 'same (cash-shortfall items only)' → `reconciliation_item.opened{kind=cash_shortfall}`, which closeDailyReconciliation opens when cash in bank < cashbook after in-transit items are validated (rule 5); 90 calendar_days (policy adopting the Freddie Mac benchmark) to `funded` or `cleared`." });
  o("FNMA_F120_SS_FUNDS_AVAILABLE_18TH", { anchorField: "period_start", satisfied: "`custodial.draft.coverage_confirmed{remittance_type=ss}`",
    why: "§6.3 timer table: 'monthly schedule (S/S accounts)' — openRemittancePeriod (the P&I `close_period` act) appends `period.opened{remittance_type=ss, period_start}` for the month in which Fannie Mae drafts the closed month's activity; CD18 rolled back to the preceding `business_days_fannie_et`, 00:01 ET (6.3-T9: Sat 2026-07-18 → Fri 2026-07-17 00:01 ET); satisfied by `custodial.draft.coverage_confirmed` for that S/S account (confirmDraftCoverage from the intraday available balance, `bank.read_statement` camt.052)." });
  o("FNMA_F120_SA_FUNDS_AVAILABLE_20TH", { anchorField: "period_start",
    why: "§6.3 timer table: 'monthly schedule (S/A accounts)' — `period.opened{remittance_type=sa, period_start}` from openRemittancePeriod; CD20 (preceding Fannie Mae BD), 00:01 ET; satisfied 'same' → `custodial.draft.coverage_confirmed{remittance_type=sa}`." });
  o("FNMA_LL202605_AA_PREDRAFT_COVERAGE_1BD", { trigger: "`fnma.draft_notification.received{kind=predraft}`", satisfied: "`custodial.draft.coverage_confirmed{remittance_type=aa}`",
    why: "§6.3 timer table: trigger `fnma.draft_notification.received` (A/A pre-draft) — 5.2's ingestDraftNotification spells the LL-2026-05 pre-draft `kind=predraft` (FAQ Q17: notification no later than the next BD, draft two BD after the event) with `draft_date` as the anchor; due draft date − 1 `business_days_fannie_et` 15:00 ET; satisfied 'same' → `custodial.draft.coverage_confirmed{remittance_type=aa}` on the notification's period subject (confirmDraftCoverage), breach `officer` critical with the corporate funding command auto-prepared." });
  o("FNMA_IRM102_SURPLUS_UNEXPLAINED_90", { anchorField: "first_seen_on",
    why: "§6.3 timer table: anchor 'identification' → `first_seen_on` on 5.2's `fnma.shortage_surplus.surplus_identified` (schedule3, Form 472 basis); 90 calendar_days to `fnma.shortage_surplus.explained` — explainShortageSurplus, appended by a documented `ledger.post_reclass{surplus_id}` (root cause + evidence, never a plug); breach `officer` (IRM §1-02: Fannie Mae may zero out the surplus)." });
  o("SM_FNMA_CONNECT_REMIT_DETAIL_PULL_2BD", { trigger: "`investor_reporting_periods.closed`", anchorField: "bd2_following",
    why: "§6.3 inputs: `fnma.reporting_period.closed` (BD2 17:00 ET) is the platform's `investor_reporting_periods.closed{bd2_following}` (5.1 rule 10 / 5.2 period close on the `period` subject); anchor BD2 → `bd2_following`; 2 `business_days_fannie_et` to `fnma.remittance_detail.report_received` — ingestRemittanceDetailReport (`documents.write{kind=fnma_remittance_pi_detail}`, the Connect 'Remittance Principal and Interest Detail Report' that is Form 496 line 9's source, hashed and recorded as `fnma_receivable_source_document_id`); breach re-escalates `fnma_portal_operator` → `officer`." });
}
