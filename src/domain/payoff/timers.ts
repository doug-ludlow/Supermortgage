/**
 * Registry overrides for Section 16 (payoff, lien release, MERS) timers whose
 * spec rows are prose. Statutory deadlines that vary by state are computed
 * anchors resolved from `jurisdiction_rules`.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";
import { applySatisfiedOverrides_16_1 } from "./timers-16-1.ts";
import { applySatisfiedOverrides_16_2 } from "./timers-16-2.ts";
import { applySatisfiedOverrides_16_3 } from "./timers-16-3.ts";
import { applySatisfiedOverrides_16_4 } from "./timers-16-4.ts";

export function applyPayoffTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 16.1 payoff statements ---------------------------------------------
  o("FL_701_04_CORRECTED_ESTOPPEL_CUTOFF", { trigger: "`payoff.statement.updated{state=FL}`", anchorField: "payment_date", offset: "−1 business_days_servicer, 15:00 local", why: "§16.1 timer table: corrected letter must be *received* by 3 p.m. at least 1 BD before the payment date to supersede (Fla. Stat. 701.04)." });
  o("FNMA_A42107_NIB_MATURITY_NOTICE_180_150", { trigger: "`loan.maturity.approaching{days_before=180, nib=true}`", anchorField: "maturity_date", offset: "between −180 and −150 calendar_days", why: "§16.1 timer table: NIB loans — balance notice window 180→150 CD before maturity/projected payoff (A4-2.1-07)." });
  o("FNMA_A42107_NIB_MATURITY_NOTICE_75_60", { trigger: "`loan.maturity.approaching{days_before=75, nib=true, contact=false}`", anchorField: "maturity_date", offset: "between −75 and −60 calendar_days", why: "§16.1 timer table: no contact by maturity − 75 → second notice window 75→60 CD before (A4-2.1-07)." });
  o("SM_PAYOFF_GOOD_THROUGH_MAX_30", { trigger: "`payoff.request.received`", evaluator: "16.1.goodThroughWithin30Days", why: "§16.1 timer table: good-through ≤ receipt + 30 CD (MA: statement validity ≥ 30 CD)." });
  o("SM_PAYOFF_THIRD_PARTY_AUTH_1BD", { trigger: "`payoff.request.received{requester=third_party}`", why: "§16.1 timer table: third-party request → verified or authorization request sent within +1 BD." });
  o("SM_PAYOFF_WIRE_VERIFY_GATE", { trigger: "`notice.render_requested{template=NTC_REGZ_1026_36C3_PAYOFF_STATEMENT}`", evaluator: "16.1.wireInstructionsVerified", why: "§16.1 timer table: wire instruction version = active vault version; verification token minted." });
  o("STATE_PAYOFF_STMT_DEADLINE", { anchorField: "statutory_statement_due", offset: "0", why: "§16.1 timer table: per `jurisdiction_rules.payoff.deadline_days`/`deadline_calendar` (CA 21 CD, FL 10 CD, NY 30 CD, NC 10 CD, MA 5 BD, TX 7 BD, CT rule) — computed by `16.1.statutoryStatementDue`." });
  // ---- 16.2 payoff processing ---------------------------------------------
  o("FNMA_F120_PAYOFF_SA_CD20", { trigger: "`loan.paid_in_full{remittance_type=sa}`", offset: "20th of the following month (preceding fannie_et BD)", why: "§16.2 timer table: S/A payoff → draft matched on the 20th of the following month (preceding BD) (F-1-20)." });
  o("FNMA_F120_PAYOFF_SS_CD18", { trigger: "`loan.paid_in_full{remittance_type=ss}`", offset: "18th of the following month (preceding fannie_et BD)", why: "§16.2 timer table: S/S payoff → 18th of following month (RPM date / MBS Express BD4 variants via `remittance_due_on` in 5.6) (F-1-20)." });
  o("SM_PAYOFF_CREDIT_REPORT_NEXT_CYCLE", { offset: "first day of next month, 00:05 ET", why: "§16.2 timer table: `loan.paid_in_full` → status 13 furnished in the next Metro 2 cycle." });
  o("SM_PAYOFF_SHORTAGE_CURE_5BD", { trigger: "`payoff.shortage.demand_sent`", why: "§16.2 timer table: demand sent → shortage cured/absorbed decision within +5 BD." });
  o("SM_PAYOFF_TAX_AUTHORITY_NOTIFY_5BD", { trigger: "`loan.paid_in_full{escrowed=true}`", why: "§16.2 timer table: escrowed or tax-service loan paid in full → tax-service delete + authority notice within +5 BD; `loan.paid_in_full{tax_service=true}` arms the same code." });
  // ---- 16.3 lien release ---------------------------------------------------
  o("CA_CC2941_TRUSTEE_RECORD_21", { trigger: "`lien_release.delivered_to_trustee{state=CA}`", why: "§16.3 timer table: delivery to trustee → reconveyance recorded within +21 calendar days (Cal. Civ. Code §2941)." });
  o("FNMA_A2104_SEND_FOR_EXECUTION_2BD", { trigger: "`lien_release.prepared{signatory_path=fnma_execution}`", anchorField: "prepared_at", why: "§16.3 timer table: task with `signatory_path=fnma_execution` prepared → sent to SF CPM Documents within +2 BD (A2-1-04)." });
  o("NY_RPAPL1921_NOTE_RETURN_45", { trigger: "`payoff.note_return.requested{state=NY}`", why: "§16.3 timer table: borrower/designee request for note and mortgage → originals delivered within +45 calendar days (NY RPAPL §1921)." });
  o("SM_FNMA_EXECUTION_RETURN_15BD", { trigger: "`lien_release.sent_for_execution{path=fnma}`", anchorField: "sent_at", why: "§16.3 timer table: sent to SF CPM → executed document returned within +15 BD (turnaround UNVERIFIED)." });
  o("SM_LPOA_RECORDED_GATE", { trigger: "`lien_release.execution_requested{path=lpoa}`", evaluator: "16.3.lpoaRecordedForState", why: "§16.3 timer table: `lpoas.status=recorded` for the state before execution under LPOA." });
  o("SM_RELEASE_PENALTY_NONPASS_GATE", { trigger: "`fee.posting_requested{kind∈{release_penalty, late_release_penalty}}`", evaluator: "16.3.penaltyNeverPassedThrough", why: "§16.3 timer table: penalty accounts never map to borrower or Fannie Mae claims." });
  o("STATE_LIEN_RELEASE_DEADLINE", { anchorField: "statutory_release_due", offset: "0", why: "§16.3 timer table: per `jurisdiction_rules.release.deadline_days` (calendar days; no weekend roll-forward) from payoff date — computed by `16.3.statutoryReleaseDue`." });
  // ---- 16.4 MERS -----------------------------------------------------------
  o("SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE", { trigger: "`mers.deactivation.requested`", evaluator: "16.4.allCountiesRecorded", why: "§16.4 timer table: `release_tasks.status ∈ {recorded, third_party_recorded}` for all counties before deactivation submit." });
  // per-process satisfaction overrides (§16.x), applied last so they win the merge
  applySatisfiedOverrides_16_1(reg); applySatisfiedOverrides_16_2(reg); applySatisfiedOverrides_16_3(reg); applySatisfiedOverrides_16_4(reg);
}
