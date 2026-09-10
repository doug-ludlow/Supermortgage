/**
 * §10.4 timer overrides (process-owned; the §10 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 10.4 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Event vocabulary (src/domain/pmi/ops-10-4.ts):
 *   `mi_policy.activated{policy_id, premium_plan, status, state, hpa_covered, consummation, boarded_at,
 *     last_annual_disclosure_on, annual_disclosure, disclosure_anchor_on, next_annual_disclosure_due, template}` — the
 *     boarded MI policy ingested (`activateMiPolicy`, from `loan.boarded`'s MI block / the `mi_policies` row).
 *   `mi.disclosure.due_approaching{timer_id, elapsed_pct, disclosure_due_on, compose_by}` — the scheduler's 70%-elapsed mark.
 *   `mi.disclosure.composed{disclosure_id, notice_id, template, included_with, send_on, …}` / `mi.disclosure.sent{…}`.
 *   `notice.sent{template}` — the Notice Registry's send event (src/notices/service.ts carries the code as `template`).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_10_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("HPA_4903A3_ANNUAL_DISCLOSURE_12M", { trigger: "`mi_policy.activated{annual_disclosure=true}`", anchorField: "disclosure_anchor_on", offset: "365 `calendar_days`",
    why: "§10.4 timer table: trigger '`mi_policy.activated` / `mi.disclosure.sent`', anchor 'last sent date (or boarding date)', offset '12 `months` (365 calendar days max)'; R1 '`send_annual = premium_plan ∈ BPMI plans ∧ status='active'`' and 4905(b) 'no annual statement is required for LPMI' — the policy ingestion appends `mi_policy.activated{annual_disclosure}` with `disclosure_anchor_on` = 'the later of the last disclosure sent (transferor's date if boarded) or boarding date'; R2 '`next_due = last_sent + 12 months` (never more than 365 days)' — the 365-day cap governs (12 months across a Feb. 29 would be 366). The `mi.disclosure.sent` leg is the recurring row's re-arm on its satisfying `notice.sent` (state machine: 'Cycle re-arms on `sent`')." });
  o("MN_47_207_ANNUAL_NOTICE_12M", { trigger: "`mi_policy.activated{annual_disclosure=true, state=MN}`", anchorField: "disclosure_anchor_on",
    why: "§10.4 timer table: kind 'jurisdiction override (MN)', trigger 'same as HPA timer', anchor 'same' — armed only for a Minnesota property with borrower-paid MI (Minn. Stat. §47.207 subd. 3); satisfied 'MN-variant notice sent' (section override `notice.sent{template=NTC_HPA_4903A3_ANNUAL_MN}`)." });
  o("SM_MI_FIRST_DISCLOSURE_POST_BOARDING_60", { trigger: "`mi_policy.activated{annual_disclosure=true, last_annual_disclosure_on is null}`", anchorField: "boarded_at",
    why: "§10.4 timer table: trigger '`loan.boarded` with MI and null last-sent date', anchor 'boarded_at' — §1.1's `loan.boarded` carries no MI fields; the boarded MI record (tape field `pmi_last_annual_disclosure_on`) is ingested by `activateMiPolicy` from the boarding event, so the 60-day policy clock arms on `mi_policy.activated` with a borrower-paid plan and a null last-sent date (10.4-T8)." });
  o("SM_MI_DISCLOSURE_COMPOSE_LEAD_30", { trigger: "`mi.disclosure.due_approaching{elapsed_pct>=70}`", anchorField: "disclosure_due_on", offset: "−30 calendar_days", satisfied: "`mi.disclosure.composed`",
    why: "§10.4 timer table: trigger 'recurring timer at 70% elapsed', offset '30 `calendar_days` before due', satisfied '`mi.disclosure.composed`' — the scheduler (`runDisclosureSweep`) marks the 12-month cycle at 70% elapsed with `mi.disclosure.due_approaching{elapsed_pct, disclosure_due_on}`; composition (`composeDisclosure`) appends `mi.disclosure.composed`." });
  o("CA_2954_6_NOTICE_WITH_STATEMENT", { trigger: "`escrow.statement.sent{statement_type=annual}`",
    why: "§10.4 timer table: trigger '`escrow.statement.sent` / annual statement sent' — Cal. Civ. Code §2954.6 rides 'each written statement required by Section 2954.2' (treated as the annual statement; §3.3's `escrow.statement.sent{statement_type}`), not a short-year or initial statement. Kind 'jurisdiction override (CA)': for a non-California property the ingestion hook (`attachDisclosureHooks_10_4`) cancels the instance the same day." });
}
