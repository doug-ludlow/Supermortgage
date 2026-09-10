/**
 * §7.5 timer overrides (process-owned; the §7 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 7.5 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Event vocabulary (src/domain/notices/ops-7-5.ts): `privacy.initial_due{reason, anchor_date}` (both initial-notice
 * triggers), `privacy.initial_sent{sent_on}` (+ the revised send's annual-clock restart), `privacy.annual_exception.applied`
 * / `privacy.annual_sent` (both `outcome`), `privacy_policy.changed{new_sharing, exception_lost, change_date}`,
 * `privacy.revised_notice.sent` → `privacy.revised_notice.optout_window_elapsed`, `privacy_notice.copy_requested
 * {requested_on}` → `notice.sent{kind=on_request}`, `partner.privacy_attestation.received`.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_7_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("REGP_1016_4A1_INITIAL_NOTICE_REASONABLE_30", { trigger: "`privacy.initial_due`", anchorField: "anchor_date",
    why: "§7.5 timer table: trigger '`transfer_in.msr_acquired_by_partner` / `sii.assumption.confirmed`', anchor 'acquisition (transfer) date / assumption date' — two triggers and two anchors the one-pattern grammar cannot carry (the raw row armed only on the transfer event, never on an assumption). The process records the state transition `privacy.initial_due{reason∈{msr_acquisition, assumption}, anchor_date}` for both (state machine: no_notice_due → initial_due 'MSR acquisition or assumption'; outputs: loan_events `privacy.initial_due/sent`; ops-7-5.privacyInitialNoticeDue appends the inbound event and then this one), so the 30-day clock arms on either path from the spec's anchor (§1016.4(a)(1), (e)(2)(i); 7.5-T1: effective 2026-11-02 → due 2026-12-02)." });
  o("REGP_1016_5A_ANNUAL_NOTICE_12M", { anchorField: "sent_on", satisfied: "`privacy.annual*{outcome∈{exception_applied, annual_sent}}`",
    why: "§7.5 timer table: anchor 'last notice date' (`sent_on` on `privacy.initial_sent` — also carried by the revised notice's annual-clock restart, §1016.5(e)(2)(i)); satisfied by '`notice.sent` (`NTC_REGP_1016_5_ANNUAL`) or `privacy.annual_exception.applied` with attestation evidence' — both are the process's rule-4 determinations `privacy.annual_sent` / `privacy.annual_exception.applied` (ops-7-5.sendAnnualPrivacyNotice / applyAnnualCycle), which carry `outcome`. The bare family pattern `privacy.annual*` also matched the spec's Jan 2 input 'Annual: `privacy.annual_cycle.opened` (Jan 2) → exception determination', which must never close the clock (§1016.5(a), (e); 7.5-T3)." });
  o("REGP_1016_5E2II_ANNUAL_AFTER_CHANGE_100", { trigger: "`privacy_policy.changed{exception_lost=true, new_sharing=false}`", anchorField: "change_date",
    why: "§7.5 timer table: trigger '`privacy_policy.changed` (exception lost; no revised notice required)', anchor 'change date' — rule 5: a change that starts new sharing takes the §1016.8 revised-notice path whose send restarts the annual clock (§1016.5(e)(2)(i)), so only a change that ends the exception without a revised notice starts the 100-day clock (§1016.5(e)(2)(ii); 7.5-T5: 2027-06-15 → 2027-09-23). ops-7-5.recordPolicyChange emits both flags and `change_date`." });
  o("SM_PRIVACY_COPY_ON_REQUEST_5BD", { anchorField: "requested_on", satisfied: "`notice.sent{kind=on_request, template∈{NTC_REGP_1016_4_INITIAL, NTC_REGP_1016_5_ANNUAL, NTC_REGP_1016_8_REVISED}}`",
    why: "§7.5 timer table: anchor 'request receipt' (`requested_on` on `privacy_notice.copy_requested`), '+5 business_days_servicer', satisfied by `notice.sent` — the requested copy itself: data model `privacy_notice_deliveries.kind` ∈ {initial, annual, revised, courtesy, on_request}; an initial, annual or revised mailing that happens to fall in the window is not the copy the borrower asked for (ops-7-5.sendPrivacyCopy emits `kind=on_request` with the current notice's template; 7.5-T9: requested 2026-10-14 → by 2026-10-21)." });
}
