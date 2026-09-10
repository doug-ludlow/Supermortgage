/**
 * §8.3 timer overrides (process-owned; the §8 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 8.3 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Event vocabulary (src/domain/credit-reporting/ops-8-3.ts OverlayRunner, reached through
 * `credit.suppression.create/release{op}` in src/app/tools/section08.ts):
 *   credit.noe_bar.expired{id, case_id, reason, is_qwr, ends_on, expired_on}   expireNoeBars (op=expire)
 *   borrower.deceased.confirmed{party_id, confirmation, evidence_kind, evidence_document_id}   confirmDeceased (op=confirm_deceased)
 *   metro2.snapshot.built{cycle_id, as_of, cii_applied, ecoa_x_applied, ecoa_x_party_ids}   OverlayRunner.build (per loan)
 *   credit.suppression.reviewed{id, reason, stale, docket_checked}   reviewSuppression (op=review) — also 14.4's docket-check review
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_8_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // "`case.noe.opened` flagged `is_qwr=true`" — the column grammar drops the flag; the 4.1 intake carries `is_qwr` on the
  // case (src/app/tools/section04.ts) and the row concerns only a qualified written request (12 U.S.C. §2605(e)(3):
  // "information regarding any overdue payment … relating to such period or qualified written request").
  // "Satisfied by: expiry" — the transmission-time sweep (OverlayRunner.expireNoeBars) expires the bar 60 calendar days
  // after `receipt_date` and appends `credit.noe_bar.expired{is_qwr=true}` for the QWR bar (a Reg X bar gets 4.1's
  // `credit_reporting.suppression.expired` on the same sweep, closing REGX_1024_35I_CREDIT_SUPPRESS_60).
  o("RESPA_2605E3_QWR_SUPPRESS_60", {
    trigger: "`case.noe.opened{is_qwr=true}`", anchorField: "receipt_date", satisfied: "`credit.noe_bar.expired{is_qwr=true}`",
    why: "§8.3 timer table: '`case.noe.opened` flagged `is_qwr=true`' → receipt_date + 60 `calendar_days`; 'Satisfied by: expiry' — ops-8-3.ts expireNoeBars appends `credit.noe_bar.expired{is_qwr}` when the 60 days have run (12 U.S.C. §2605(e)(3); rule 1: 'the projection is applied at transmission time').",
  });
  // "`borrower.deceased.confirmed` → confirmation → next cycle; snapshot carries ECOA X" — 4.4's confirmation record is
  // validated and appended by OverlayRunner.confirmDeceased with `confirmation` (the anchor date), and the cycle the
  // overlay engine builds for that month appends `metro2.snapshot.built{ecoa_x_applied=true}` for the loan (rule 6:
  // "ECOA `X` on that consumer's segment from the next cycle"; 8.3-T8: confirmed 2027-04-12 → the Apr-30 cycle).
  o("SM_CR_DECEASED_ECOA_X_NEXT_CYCLE", {
    trigger: "`borrower.deceased.confirmed`", anchorField: "confirmation", satisfied: "`metro2.snapshot.built{ecoa_x_applied=true}`",
    why: "§8.3 timer table: `borrower.deceased.confirmed` (anchor 'confirmation', offset 'next cycle' = the 1st-of-next-month snapshot) → 'snapshot carries ECOA X'; ops-8-3.ts confirmDeceased appends the trigger with `confirmation`, OverlayRunner.build appends `metro2.snapshot.built{ecoa_x_applied=true}` per loan after deceasedOverlay; breach: escalate `human_agent`.",
  });
}
