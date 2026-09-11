/**
 * §30.2 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 30.2 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * Rows that need no re-spelling (src/domain/orig-boarding/ops-30-2.ts emits them as the registry spells them):
 * `SM_ORIG_BOARD_T1BD` (`loan.funded` → `loan.boarded`), `SM_ORIG_BOARD_EXCEPTION_SLA_1BD`
 * (`loan.boarding_exception.raised{severity=hard}` → `.resolved`), `SM_ORIG_FIRST_STATEMENT_LEAD_15` (`loan.boarded`,
 * anchor `first_payment_date`, −15 calendar days → 7.1's `statement.sent`), `SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE`
 * (`loan.boarded` −5 `business_days_servicer` → `loan.active`). Reference rows owned elsewhere are satisfied by their
 * owner's emission: `SM_O64_FIRST_PAYMENT_LETTER_5BD` (25.4; `notice.sent{template=NTC_SM_FIRST_PAYMENT_LETTER}` is
 * what `sendFirstPaymentLetter` appends), `MERS_PROC_MOM_REGISTER_7` (26.4; `mers.min.registered` is appended by
 * `recordMersAcknowledgment`), `REGX_1024_17G_INITIAL_STMT_45` (3.1), `LL_2026_05_ESCROW_SETUP_ORIG_PURCHASE_BD1` (30.1),
 * `ESIGN_7001C_CONSENT_GATE` (7.4).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_30_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Rule 2 warnings: "all OW-* resolved/waived" is the one event the service appends when the last open warning clears (clearWarning / waive / recordMersAcknowledgment / recordVendorActivation).
  o("SM_ORIG_WARNING_CLEAR_10BD", { satisfied: "`loan.boarding.warnings_cleared`", anchorField: "boarded_at",
    why: "§30.2 timer table: trigger '`loan.boarding.warnings_open`', anchor `boarded_at`, +10 `business_days_servicer`, satisfied by 'all `OW-*` resolved/waived' — OriginationBoardingService emits `loan.boarding_warning.resolved{rule_code}` per warning and `loan.boarding.warnings_cleared{boarded_at}` once none is open (state machine: boarded_with_warnings —(warnings cleared or waived with reason)→ active); breach sev-3, weekly aging on the Sentinel report." });
  // FNMA_B2_1_5_FIRST_PAYMENT_2M: 26.3 owns the code (its trigger is `funding.requested`); 30.2 re-asserts the same
  // C2-2-01 rule as the OB-006 validation, never as a second trigger on the shared code (one code, one trigger).

}
