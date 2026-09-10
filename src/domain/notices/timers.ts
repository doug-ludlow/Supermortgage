/**
 * Registry overrides for Section 7 (statements, notices, consent, privacy)
 * timers whose spec rows are prose. Each override cites the row it encodes.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyNoticeTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 7.1 periodic statements / 1098 -------------------------------------
  o("FNMA_D2_2_03_PAYMENT_REMINDER_20", { anchorField: "due_date", offset: "by the 20th, 23:59 local", why: "§7.1 timer table: `payment.cycle.unpaid_day16` → reminder due 20th calendar day 23:59 local of the unpaid due date's month (D2-2-03)." });
  o("IRS_1098_EFURNISH_ACCESS_1015", { offset: "Oct 15 following year", why: "§7.1 timer table: electronic 1098 must stay accessible through Oct 15 of the following year (IRS Pub. 1179)." });
  o("IRS_6050H_1098_FILE_0331", { offset: "Mar 31", why: "§7.1 timer table: `tax_year.closed` → e-file by Mar 31 (IRC §6050H)." });
  o("IRS_6050H_1098_FURNISH_0131", { offset: "Jan 31 (rolled to the next federal business day)", why: "§7.1 timer table: `tax_year.closed` → furnish by Jan 31 (IRC §6050H)." });
  // ---- 7.2 ARM adjustments -------------------------------------------------
  o("SM_ARM_DUAL_CALC_VERIFY_T0", { evaluator: "7.2.dualCalculationMatches", why: "§7.2 timer table: second engine result must match to the cent before `arm.adjustment.verified`." });
  // ---- 7.3 ARM notices -----------------------------------------------------
  o("REGZ_1026_20D_ESTIMATE_INDEX_15BD", { evaluator: "7.3.indexRecentEnoughForEstimate", why: "§7.3 timer table: index `effective_date` ≥ disclosure date − 15 `business_days_servicer` (§1026.20(d) estimate rule)." });
  o("SM_ARM_INITIAL_SEPARATE_DOC_GATE", { trigger: "`notice.render_requested{template=NTC_REGZ_1026_20D_ARM_INITIAL}`", evaluator: "7.3.separateDocumentEnforced", why: "§7.3 timer table: `notice_templates.separate_document = true` enforced by the composer (own PDF; own first page; may share envelope)." });
  // ---- 7.4 E-SIGN consent --------------------------------------------------
  o("ESIGN_7001C_CONSENT_GATE", { evaluator: "7.4.esignConsentActiveForEveryRecipient", why: "§7.4 timer table: requires `consents(kind=esign, scope ∋ class, status=active)` for every intended recipient (15 U.S.C. §7001(c))." });
  o("ESIGN_7001C1D_RECONSENT_GATE", { trigger: "`hw_sw_requirements.changed{material=true}`", offset: "until consent.esign.reconsented", why: "§7.4 timer table: material hardware/software change → all consents flagged `reconsent_required`; electronic delivery blocked until (C) re-demonstrated (§7001(c)(1)(D))." });
  o("IRS_1098_ECONSENT_GATE", { evaluator: "7.4.irsEstatementConsentActive", why: "§7.4 timer table: requires `consents(kind=irs_estatement, status=active)` (Treas. Reg. §1.6050H-2)." });
  // ---- 7.5 privacy ---------------------------------------------------------
  o("REGP_1016_8_REVISED_NOTICE_GATE", { trigger: "`privacy_policy.changed{new_sharing=true}`", offset: "until privacy.revised_notice.sent", why: "§7.5 timer table: no sharing under the new practice until the revised notice and any opt-out period are complete (§1016.8)." });
  o("SM_PARTNER_PRIVACY_ATTESTATION_0131", { trigger: "`period.year_end`", offset: "Jan 31", why: "§7.5 timer table: annual cycle — partner privacy attestation by Jan 31." });
  // ---- 7.6 payoff statements ----------------------------------------------
  o("SM_PAYOFF_STMT_ACCURACY_GATE", { trigger: "`notice.render_requested{template=NTC_REGZ_1026_36C3_PAYOFF_STATEMENT}`", evaluator: "7.6.payoffStatementAccuracy", why: "§7.6 timer table: 16.1 calc version current; no pending unposted payments/reversals older than the cut-off; ARM adjustment (7.2) effective before good-through reflected." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("SM_ARM_INDEX_CAPTURE_T45", { trigger: "`arm.schedule.row_created`", why: "§7.2 timer table: `arm_schedule` row → index capture at `change_date` − `lookback_days` (45)." });
  o("REGZ_1026_20C_ADJ_NOTICE_NOT_BEFORE_120", { trigger: "`arm.schedule.row_created`", why: "§7.2 timer table: `arm_schedule` row → not before `first_new_payment_due` − 120 (§1026.20(c))." });
  o("REGZ_1026_20C_ADJ_NOTICE_60", { trigger: "`arm.schedule.row_created`", why: "§7.2 timer table: `arm_schedule` row → notice by `first_new_payment_due` − 60 (§1026.20(c))." });
  o("REGZ_1026_20C_FREQ_ADJ_NOTICE_25", { trigger: "`arm.schedule.row_created{frequent_adjuster=true}`", why: "§7.2 timer table: `arm_schedule` row → notice by −25 for frequent adjusters (§1026.20(c)(2))." });
  o("REGZ_1026_20D_INITIAL_NOTICE_NOT_BEFORE_240", { trigger: "`arm.schedule.row_created{initial=true}`", why: "§7.3 timer table: `arm_schedule` (initial) → not before −240 (§1026.20(d))." });
  o("REGZ_1026_20D_INITIAL_NOTICE_210", { trigger: "`arm.schedule.row_created{initial=true}`", why: "§7.3 timer table: `arm_schedule` (initial) → deliver/mail by −210 (§1026.20(d))." });
}
