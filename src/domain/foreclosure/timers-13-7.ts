/**
 * §13.7 timer overrides (process-owned; the §13 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 13.7 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. Every event named here is built by src/domain/foreclosure/ops-13-7.ts and appended by
 * the `litigation.classify` / `attorney.message.send` handlers in src/app/tools/section13-7.ts (bound for 13.7 by
 * src/app/tools/section13.ts).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_13_7(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Registry row: trigger "`litigation.notice.received` classified non-routine (non-exception)", satisfied
  // "`form20_submissions.submitted`". The platform spells the submission `form20.submitted` (13.7 Outputs:
  // "`form20.prepared/submitted/responded`"); the notice event carries `classification` and `exception_category`
  // (13.7 Inputs / data model). Rule 1: "when in doubt, file Form 20 — over-reporting has no penalty", so an
  // `attorney_confirmation_required` classification runs the same clock until the attorney confirms "routine"
  // (the confirm op cancels it); a standing/MERS/HAMP matter reports only on its trigger (E-1.3-02 exception ⇒
  // FNMA_E1302_FORM20_EXCEPTION_TRIGGER, not this row).
  o("FNMA_E1302_FORM20_2BD", { trigger: "`litigation.notice.received{classification∈{non_routine, attorney_confirmation_required}, exception_category=none}`", anchorField: "notice_received_at", satisfied: "`form20.submitted`",
    why: "§13.7 timer table: `litigation.notice.received` classified non-routine (non-exception) → notice_received_at +2 business_days_servicer → `form20_submissions.submitted` (E-1.3-02 'within two business days of the servicer receiving notice of the litigation'); rule 3: notice received = earliest of service/firm notice/docket alert; the platform appends `form20.submitted` (Outputs)." });
  // Registry row (columns shifted by the `{summary_judgment|briefing|trial}` cell): anchor "trigger date", offset
  // "+2 business_days_servicer (policy: same clock)". `litigation.trigger{matter, event, trigger_on}` is the
  // detected trigger (rule 2); 13.7-T2 "Form 20 within 2 BD".
  o("FNMA_E1302_FORM20_EXCEPTION_TRIGGER", { anchorField: "trigger_on", offset: "+2 business_days_servicer",
    why: "§13.7 timer table: `litigation.trigger{summary_judgment|briefing|trial}` for standing/MERS/HAMP matters | trigger date | +2 business_days_servicer (policy: same clock) | Form 20 submitted (E-1.3-02 exception categories; rule 2: 'the 2-BD clock runs from the trigger')." });
  // Anchor column "notice" = the notice_received_at the event carries (rule 3); same day (F-1-08 "immediately").
  o("FNMA_F108_ENV_LITIGATION_FORM20_0", { anchorField: "notice_received_at",
    why: "§13.7 timer table: `litigation.notice.received{environmental}` | notice | same day ('immediately') | Form 20 submitted (F-1-08: for environmental litigation 'immediately' submit Form 20 to Legal)." });
  // Registry row: "`environmental.hazard.confirmed{lead_paint}` on a referred loan | referral date | +30 calendar_days".
  // The confirmation event carries `kind`, `referred`, `referral_on` and `units`; F-1-08 limits the notification to
  // 1–4 unit properties.
  o("FNMA_F108_LEAD_PAINT_NOTIFY_30", { trigger: "`environmental.hazard.confirmed{kind=lead_paint, referred=true, units∈{1, 2, 3, 4}}`", anchorField: "referral_on",
    why: "§13.7 timer table: `environmental.hazard.confirmed{lead_paint}` on a referred loan | referral date | +30 calendar_days | Servicing Representative notification with value, debt, children<8, documentation (F-1-08: 'for lead-based-paint citations or violations on 1–4 unit properties, submit the notification within 30 days after referral'); 13.7-T4." });
  // Anchor column "confirmation" = `confirmed_on` on the confirmation event (rule 5).
  o("SM_ENV_SERVICING_REP_REPORT_2BD", { anchorField: "confirmed_on",
    why: "§13.7 timer table: `environmental.hazard.confirmed` | confirmation | +2 business_days_servicer | report sent (policy; F-1-08 'report hazard information to the Fannie Mae Servicing Representative'); 13.7-T3 'Servicing Representative report within 2 BD'." });
  // Anchor column "submission" = `submitted_on` on `form20.submitted` (the quatro filing, or the outage email to Legal).
  o("SM_FORM20_RESPONSE_FOLLOWUP_10BD", { anchorField: "submitted_on",
    why: "§13.7 timer table: Form 20 submitted | submission | +10 business_days_fannie_et | Fannie Mae direction recorded (`form20.responded`; policy follow-up via Legal email)." });
}
