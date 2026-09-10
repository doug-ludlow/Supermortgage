/**
 * §3.7 timer overrides (process-owned; the §3 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 3.7 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The emitters are src/domain/escrow/ops-3-7.ts (through the 3.7 tools in
 * src/app/tools/section3-7.ts and the p37 block of section03.ts); src/kernel/events/match.ts compares conditions as
 * exact strings on payload fields, so every conditioned field below is one those emitters write.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_3_7(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Row: trigger "`escrow.bill.received` (escrowed loan, borrower ≤ 30 days overdue)", anchor "`penalty_date` (else due_date)". receiveBill writes `escrowed`, `regx_days_delinquent` and `penalty_date` (= penalty date, else due date) on the bill event.
  o("REGX_1024_17K_DISBURSE_BEFORE_PENALTY_0", { trigger: "`escrow.bill.received{escrowed=true, regx_days_delinquent<=30}`", anchorField: "penalty_date",
    why: "§3.7 timer table: `escrow.bill.received` (escrowed loan, borrower ≤ 30 days overdue) → `penalty_date` (else due_date) + 0 calendar days (§1024.17(k)(1)); satisfied by `disbursement.sent{lead_honored=true}` (section override)." });
  // Row: trigger "`escrow.bill.received` (any escrowed loan regardless of delinquency; also non-escrowed advance decisions)" — the escrowed condition only; a non-escrowed advance decision arrives as a bill on the loan the advance pays (rule 9) and arms the same row.
  o("FNMA_B101_DISBURSE_BEFORE_PENALTY_0", { trigger: "`escrow.bill.received{escrowed=true}`", anchorField: "penalty_date",
    why: "§3.7 timer table: `escrow.bill.received` (any escrowed loan regardless of delinquency) → `penalty_date` + 0 (B-1-01 'before any applicable penalty or termination date'); satisfied by `disbursement.sent{lead_honored=true}`." });
  // Row: trigger "`escrow.bill.received` with discount"; satisfied "`disbursement.released` by discount date when funds available" — the platform's release fact is `escrow.disbursement.released` (3.7 outputs: `escrow.disbursement.released/sent/confirmed/…`); releaseDisbursement writes `discount_captured` (rule 2: captured only when funds are available without an advance), so a release that lost the discount breaches the warning (breach column: "discount loss logged").
  o("FNMA_B101_DISCOUNT_CAPTURE_WARN", { trigger: "`escrow.bill.received{discount_date is not null}`", satisfied: "`escrow.disbursement.released{discount_captured=true}`", anchorField: "discount_date",
    why: "§3.7 timer table: bill with discount → `discount_date` − lead (section override: −10 servicer BD); satisfied by `disbursement.released` by the discount date when funds available — releaseDisbursement's `escrow.disbursement.released{discount_captured=true}` (B-1-01 'maximum discounts … whenever funds are available')." });
  // Row: trigger "`escrow.line` projected installment", anchor "projected due_date" — the 3.7 input is "`escrow.line.created` (boarding/analysis) → expected-bill timers"; projectLine writes `projected_due_on`.
  o("ESC_EXPECTED_BILL_MISSING_30", { trigger: "`escrow.line.created`", anchorField: "projected_due_on",
    why: "§3.7 inputs: `escrow.line.created` (boarding/analysis) → expected-bill timers; timer table: projected installment due_date − 30 calendar days without a bill; satisfied by `escrow.bill.received`." });
  // Row: anchor "reject date"; satisfied "`disbursement.scheduled` (re-planned)" — ingestRailStatus writes `rejected_on` (on a return too: same clock), replanRejected writes `replanned=true` so a fresh schedule of another bill never closes the re-plan clock.
  o("ESC_PAYEE_REJECT_REPLAN_2BD", { anchorField: "rejected_on", satisfied: "`disbursement.scheduled{replanned=true}`",
    why: "§3.7 timer table: `disbursement.rejected/returned` → reject date + 2 business_days_servicer; satisfied by `disbursement.scheduled` (re-planned) — rule 8: a reject must be re-planned within 2 BD (T12: by ACH direct)." });
  // Row: anchor "D" = the processed date of the `ledger_entries` set posted to `escrow`; postEscrowActivity writes `processed_on` (servicer processing day, ET) and `account=escrow`.
  o("FNMA_LL2026_05_ESCROW_EVENT_0300ET", { anchorField: "processed_on",
    why: "§3.7 timer table: `ledger_entries` posted to `escrow` (processed date D) → next `fannie_et` business day 03:00 America/New_York (LL-2026-05 'no later than 3:00 a.m. eastern time on the next business day'); satisfied by `escrow.event.accepted` (status accepted / accepted_warning)." });
  // Row: trigger "month end", anchor "BD2 of next month 17:00 ET" — the §5.1 `period.month_end` fact carries `period_end` (last calendar day); +2 fannie_et BD at 17:00 ET is BD2 of the next month.
  o("FNMA_LL2026_05_ESCROW_PERIOD_CLOSE_BD2_1700ET", { anchorField: "period_end",
    why: "§3.7 timer table: month end → BD2 of next month 17:00 ET (`fannie_et`), offset 0 — anchored on the month-end fact's `period_end` so that + 2 fannie_et BD 17:00 ET is BD2; satisfied by `escrow.period.closed{all_accepted=true}` (closeEscrowPeriod: every period event accepted)." });
  // Row: trigger "`escrow.attestation.package_ready` (BD3)", anchor "BD2 of the following month (`fannie_et`)", offset 0 — readyAttestationPackage writes `sla_on` = BD2 of the month after the package month (attestationSchedule).
  o("FNMA_LL2026_05_ESCROW_ATTEST_BD2", { anchorField: "sla_on",
    why: "§3.7 timer table: `escrow.attestation.package_ready` (BD3) → BD2 of the following month (`fannie_et`) + 0 (FAQ Q51: window 'Opens on Business Day 3 (BD3)', 'Closes on Business Day 2 (BD2) of the following month'); satisfied by `escrow.attestation.submitted` (human_portal_task complete)." });
  // Row: trigger "feature flag `investor_reporting.escrow_events` on", anchor "configured cutover date (≤ 2026-12-01)" — enableEscrowEventReporting writes `cutover_on`.
  o("FNMA_LL2026_05_ESCROW_SETUP_CUTOVER", { anchorField: "cutover_on",
    why: "§3.7 timer table: feature flag `investor_reporting.escrow_events` on → configured cutover date (≤ 2026-12-01) + 0; satisfied by Setup events accepted for 100% of escrowed loans — recordSetupAcks's `escrow.setup_events.accepted{pct=100}` (LL-2026-05 Escrow Setup for 'all existing active and inactive mortgage loans with an escrow balance')." });
  // Row: trigger "`disbursement.confirmed` (tax, IL property)", anchor "paid date" — ingestRailStatus writes `kind`, `state` (from the bill) and `paid_on`.
  o("STATE_IL_765ILCS910_15_TAX_PAID_NOTICE_45BD", { trigger: "`disbursement.confirmed{kind=tax, state=IL}`", anchorField: "paid_on",
    why: "§3.7 timer table: `disbursement.confirmed` (tax, IL property) → paid date + 45 business_days_servicer (765 ILCS 910/15 'within 45 business days after the tax payment'); satisfied by `notice.sent{template=NTC_IL_765_910_15_TAX_PAID}` (section override)." });
  // Row: anchor "detection" — flagNonEscrowDelinquency writes `found_on` (the tax service report date).
  o("ESC_NONESCROW_TAX_DELINQ_FOLLOWUP_30", { anchorField: "found_on",
    why: "§3.7 timer table: `escrow.nonescrow.tax_delinquent` → detection (`found_on`) + 30 calendar days; satisfied by `escrow.nonescrow.tax_delinquency.resolved{outcome∈{proof_of_payment, advance_and_revocation}}` (section override; rule 9: borrower proof of payment, or advance + waiver revocation (3.8))." });
}
