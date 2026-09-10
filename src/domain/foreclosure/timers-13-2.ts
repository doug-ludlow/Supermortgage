/**
 * §13.2 timer overrides (process-owned; the §13 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 13.2 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_13_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // E-3.2-06 firm notification: the platform records a firm acknowledgment as `attorney.instruction.acknowledged{kind}` (13.2 Integrations; `attorney.instruction.status{op=acknowledge}`), never `attorney_instructions.acknowledged`; the trigger stays `lossmit.agreement.executed` — appended by `ingestExecutedAgreement` (ops-13-2.ts) when the executed agreement returns through the e-sign/document channel.
  o("FNMA_E3206_WORKOUT_NOTIFY_FIRM_2BD", { satisfied: "`attorney.instruction.acknowledged{kind∈{WORKOUT_AGREED, REINSTATED}}`", why: "§13.2 timer table: `lossmit.agreement.executed` / `loan.reinstated` → +2 business_days_servicer → '`attorney_instructions.acknowledged{kind=WORKOUT_AGREED/REINSTATED}`' (E-3.2-06: notify the firm 'within two business days after either a workout arrangement has been agreed to, or the mortgage loan is fully reinstated')." });
  // E-3.4-01 45-day short-sale marketing window: 12.9's one event vocabulary spells `shortsale.marketing.started` as the short-sale case entering `listing` (12.9 State machine: `eligible` → `listing` (agent referral; MLS ≥5 days) → `offer_received` …), anchored on the transition date.
  o("FNMA_E3401_SHORTSALE_MARKETING_45", { trigger: "`liquidation.case.status_changed{kind=short_sale, status=listing}`", anchorField: "status_on", offset: "+45 calendar_days", why: "§13.2 timer table: `shortsale.marketing.started` → +45 calendar_days (E-3.4-01 'the 45-day short-sale marketing period'); the 12.9 `liquidation.case.*` handler emits `liquidation.case.status_changed{case_id, kind, status, status_on}` on every transition — `status=listing` is the marketing start." });
  // §1024.41(h)(1) appeal window: 13.2's trigger is 'denial sent' — the 12.x (c)(1)(ii) denial notice `notice.sent{template=NTC_REGX_41C1_DENIAL}` (the spelling 12.3's CA/NY appeal-window rows use); satisfied by the 13.2 (g)(1) exit determination `lossmit.appeal_window.closed{outcome}` (`appealWindowSweep`, ops-13-2.ts). NOTE: this row is shared with 1.7 (boarding a loan with an unexpired transferor window); the registry keys one pattern per code, so 1.7's `loan.boarded{appeal_window_unexpired=true}` arming is superseded here until boarding emits that field.
  o("REGX_1024_41H_APPEAL_WINDOW_14", { trigger: "`notice.sent{template=NTC_REGX_41C1_DENIAL}`", anchorField: "sent_at", offset: "+14 calendar_days", satisfied: "`lossmit.appeal_window.closed{outcome∈{appeal_received, expired}}`", why: "§13.2 timer table: 'denial sent / appeal received' → +14 calendar_days → 'expiry / decision' (§1024.41(h)(1): 'the borrower has not requested an appeal within the applicable time period', (g)(1))." });
}
