/**
 * §9.2 timer overrides (process-owned; the §9 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 9.2 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * The events are appended by src/domain/insurance/ops-9-2.ts (Fpi92Service): `fpi.case.opened{escrowed, k5_blocked,
 * track, opened_at}`, `fpi.first_notice.sent{first_notice_mailed_at}`, `fpi.reminder.sent{reminder_mailed_at}`,
 * `fpi.evidence_window.evaluated`, `fpi.charge.assessed`; the Notice Registry (src/notices/service.ts) appends
 * `notice.production{template, production_at}` and `notice.mailed{template, mailed_at}`.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

const MS3_FAMILY = "template∈{INS_FPI_FIRST_MS3A, INS_FPI_REMINDER_NOINFO_MS3B, INS_FPI_REMINDER_INSUFF_MS3C, INS_FPI_RENEWAL_MS3D}";

export function applySatisfiedOverrides_9_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Registry trigger "`fpi.case.opened` (not k5-blocked)": the parenthetical is a payload condition; the SLA is the MS-3(A) clock, so it runs on the Reg X hazard track only (the flood track's 3-BD clock is 9.6's INS_FLOOD_NOTICE_SLA_3BD).
  o("INS_FPI_FIRST_NOTICE_SLA_3BD", { trigger: "`fpi.case.opened{k5_blocked=false, track=regx_hazard}`", anchorField: "opened_at",
    why: "§9.2 timer table: `fpi.case.opened` (not k5-blocked), anchor opened_at, +3 business_days_servicer → `fpi.first_notice.sent`; breach sev-2 (collateral unprotected longer). State machine: `opened` → `k5_blocked` (no notice) | `first_notice_pending`; track `fdpa_flood` sends the 9.6 flood notice, never an MS-3(A) (9.2-T9)." });
  // Registry "satisfied: gate opens; `fpi.charge.assessed` must be ≥ this date" — the not-before gate closes on the charge it governs; anchored on the proof-of-mailing date carried by `fpi.first_notice.sent`.
  o("REGX_1024_37C_FPI_FIRST_NOTICE_45", { satisfied: "`fpi.charge.assessed`", anchorField: "first_notice_mailed_at",
    why: "§1024.37(c)(1)(i): a written notice 'at least 45 days before' assessing any premium charge or fee; 9.2 rule 6: earliest charge = max(t0 + 45, t1 + 15) where t0 is the date placed in the mail (calendar days; a gate opening on a weekend opens that day). The charge command is refused before the open date (9.2-T1) and `fpi.charge.assessed` closes the gate (9.2-T2)." });
  o("REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30", { satisfied: "`fpi.reminder.sent`", anchorField: "first_notice_mailed_at",
    why: "§1024.37(d)(1): the reminder is delivered or mailed 'at least 30 days after' the first notice; 9.2 timer table: `fpi.reminder.sent` on/after t0 + 30 — the reminder command is refused before the open date (9.3-T1)." });
  o("REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15", { satisfied: "`fpi.charge.assessed`", anchorField: "reminder_mailed_at",
    why: "§1024.37(c)(1)(ii)–(iii): the reminder plus the 15-day period from its mailing before any charge; 9.2 timer table 'gate opens' — closed by the `fpi.charge.assessed` it governs, anchored on the reminder's proof-of-mailing date (`reminder_mailed_at`)." });
  o("REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15", { satisfied: "`fpi.evidence_window.evaluated`", anchorField: "reminder_mailed_at",
    why: "§1024.37(c)(1)(iii): by the end of the 15-day period beginning on the date the reminder was mailed the servicer must not have received evidence of continuous coverage; 9.2 timer table: 'evidence evaluation recorded at window end' (evidence received on day 15 counts — 9.2-T8); sev-2 if the evaluation is missing." });
  // (d)(5): the production window is a §1024.37 notice rule — arm it on the MS-3 family only (the Notice Registry emits `notice.production`/`notice.mailed` for every template on the platform).
  o("REGX_1024_37D5_NOTICE_PRODUCTION_5BD", { trigger: `\`notice.production{${MS3_FAMILY}}\``, anchorField: "production_at", satisfied: `\`notice.mailed{${MS3_FAMILY}}\``,
    why: "§9.2 timer table: 'notice put into production' → mailed within 5 business_days_federal (comment 37(d)(5)-1: the notice must reflect the evidence on hand within a reasonable time — 5 federal business days — before mailing); a notice produced earlier is regenerated with current evidence (9.2-T7: produced 2026-10-01, mailed 2026-10-09 = 6 federal business days → regenerate; produced 2026-10-05 → allowed). Scoped to the MS-3(A)/(B)/(C)/(D) templates the Notice Registry names on `notice.production`/`notice.mailed`." });
}
