/**
 * §9.4 timer overrides (process-owned; the §9 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 9.4 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * The events are appended by src/domain/insurance/ops-9-4.ts (Fpi94Service): `fpi.renewal.scheduled{origin,
 * anniversary_on, next_notice_anniversary_on}`, `fpi.anniversary.approaching{days_before, anniversary_on}`,
 * `fpi.renewal.coverage_reviewed`, `fpi.renewal_notice.sent{renewal_notice_mailed_at, next_notice_anniversary_on}`,
 * `fpi.renewal.charged`, `fpi.gap.evidenced{lpi_prompt_charge_prohibited}`; the 9.2 `fpi.charge.assessed` that starts
 * the cycle is appended by ops-9-2.ts and consumed by the 9.4 reactor.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_9_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Registry trigger "`fpi.charge.assessed` / prior renewal": the 9.2 charge carries no anniversary, so the row arms on the
  // `renewal_scheduled` state the charge reactor appends (anniversary A on the payload); the "prior renewal" half is the
  // recurring re-arm — `fpi.renewal_notice.sent` satisfies the row and re-arms it on `next_notice_anniversary_on` = A + 1 year,
  // so the next-term `fpi.renewal.scheduled{origin=prior_renewal}` must not arm a second instance.
  o("REGX_1024_37E5_FPI_RENEWAL_NOTICE_ANNUAL", { trigger: "`fpi.renewal.scheduled{origin=fpi_charge}`", anchorField: "next_notice_anniversary_on", offset: "−45 calendar_days", satisfied: "`fpi.renewal_notice.sent`",
    why: "§9.4 inputs: '`fpi.charge.assessed` → schedule the renewal cycle: anniversary A = `lpi_placements.effective_date` + 1 year; renewal notice target mailing at A − 60 days (window A − 60 … A − 45)'; timer table: recurring deadline, trigger `fpi.charge.assessed` / prior renewal, anchor A, 'mail by A − 45 calendar_days (target A − 60)', satisfied by `fpi.renewal_notice.sent`; §1024.37(e)(5): the notice goes 'before each anniversary of the servicer's purchase' but 'need not [be provided] more than once a year'; state machine: `charged` (9.2) → `renewal_scheduled` → … → `renewal_charged` 'loops to `renewal_scheduled` for the next term'. Breach sev-1: the charge date slips to mailed + 45 (9.4-T2); coverage itself continues." });
  // Registry anchor "t2" = the MS-3(D) proof-of-mailing date carried by `fpi.renewal_notice.sent`; the section override already closes the gate on `fpi.renewal.charged`.
  o("REGX_1024_37E_FPI_RENEWAL_NOTICE_45", { anchorField: "renewal_notice_mailed_at",
    why: "§1024.37(e)(1)(i): the written notice 'at least 45 days before assessing' any renewal premium charge; 9.4 rule 2: 'renewal charge date = max(A, t2 + 45)' where t2 is the mailing date (9.4-T1: mailed 2027-08-02 → chargeable 2027-09-16; 9.4-T2: mailed 2027-09-10 → charge 2027-10-25). The charge command is refused before the open date and `fpi.renewal.charged` closes the gate." });
  // Registry trigger "evidence of a post-expiration gap" = `fpi.gap.evidenced` (section override), evaluator 9.4.promptChargeAllowed over `lpi_prompt_charge_prohibited` on the same event.
  o("REGX_1024_37E1III_GAP_PROMPT_CHARGE", { trigger: "`fpi.gap.evidenced`", evaluator: "9.4.promptChargeAllowed", anchorField: "received_on",
    why: "§1024.37(e)(1)(iii): 'if not prohibited by State or other applicable law' the servicer 'may promptly assess' the charge for a period after the prior LPI expired for which it later receives evidence the borrower lacked coverage (comment 37(e)(1)(iii)-1); 9.4 rule 4: prompt charge at the renewal daily rate where `jurisdiction_rules.lpi_prompt_charge_prohibited=false`, otherwise a new 9.2 cycle — 'Decision recorded either way' (9.4-T4). Satisfied by 'charge or documented waiver': the flag row is closed with the recorded decision (`fpi.renewal.gap_charge`)." });
  // Registry trigger "A − 60" = the renewal window opening the A − 60 job appends; anchor A on the payload, offset −60 calendar days → due the same day (policy; sev-3).
  o("INS_FPI_RENEWAL_COVERAGE_REVIEW_60", { trigger: "`fpi.anniversary.approaching{days_before=60}`", anchorField: "anniversary_on", satisfied: "`fpi.renewal.coverage_reviewed`",
    why: "§9.4 inputs: 'Coverage review trigger: occupancy/valuation changes (B-2-01 over-insurance) at A − 60'; timer table: deadline (policy; B-2-01), trigger A − 60, anchor A, −60 calendar_days, satisfied by `fpi.renewal.coverage_reviewed`, breach sev-3; rule 3: 're-run 9.2 rule 4 (RCV estimate, occupancy, state cap) and adjust the renewal request; downward adjustments reduce the borrower's cost' (9.4-T5)." });
}
