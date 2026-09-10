/**
 * Gate evaluators. 109 registry rows are condition-shaped ("gate opens when
 * every remittance type has an active P&I account", "max 7 counted calls in
 * trailing 7 days") and their section overrides name an `evaluator:<process>.<fn>`
 * instead of a clock. This module is the one place those refs resolve: each
 * evaluator is a pure predicate over a typed facts bag and returns whether
 * the gate is open (or the rule satisfied) and why not. Command handlers
 * assert them at the boundary; the timer engine records the ref on the
 * armed instance; tests prove every ref the overrides name is registered.
 */
import { daysBetween, addDays, type PlainDate } from "../kernel/calendar/date.ts";

export interface GateResult { readonly open: boolean; readonly reason?: string; }
export type Facts = Record<string, unknown>;
export type Evaluator = (f: Facts) => GateResult;

const ok: GateResult = { open: true };
const no = (reason: string): GateResult => ({ open: false, reason });
const b = (f: Facts, k: string): boolean => f[k] === true;
const n = (f: Facts, k: string): number => Number(f[k] ?? NaN);
const c = (f: Facts, k: string): bigint => (typeof f[k] === "bigint" ? (f[k] as bigint) : BigInt(String(f[k] ?? "0")));
const s = (f: Facts, k: string): string => String(f[k] ?? "");
const arr = <T>(f: Facts, k: string): T[] => (Array.isArray(f[k]) ? (f[k] as T[]) : []);
const every = (f: Facts, keys: readonly string[], what: string): GateResult => { const missing = keys.filter((k) => !b(f, k)); return missing.length ? no(`${what}: ${missing.join(", ")} not satisfied`) : ok; };
const atMost = (v: number, max: number, what: string): GateResult => (v <= max ? ok : no(`${what}: ${v} > ${max}`));
const atLeast = (v: number, min: number, what: string): GateResult => (v >= min ? ok : no(`${what}: ${v} < ${min}`));
/** Trailing-window counter: timestamps (ISO) within `days` before `now`. */
const within = (f: Facts, k: string, days: number, now: string): number => arr<string>(f, k).filter((t) => Date.parse(now) - Date.parse(t) < days * 86_400_000 && Date.parse(t) <= Date.parse(now)).length;

export const EVALUATORS: Record<string, Evaluator> = {
  // ---- §1 transfers in
  "1.2.form101Present": (f) => (s(f, "form101_document_id") ? ok : no("Form 101 not on file for this partner (A2-1-07)")),
  "1.2.forms1013And1014Executed": (f) => every(f, ["form_1013_executed", "form_1014_executed"], "CBAM-executed custodial forms"),
  "1.2.form2017ValidForCustodian": (f) => (b(f, "form_2017_valid") && s(f, "form_2017_custodian") === s(f, "transferee_custodian") ? ok : no("no valid Form 2017 for the transferee custodian")),
  "1.2.transferDateIsFirstFannieBusinessDay": (f) => (s(f, "transfer_date") === s(f, "first_fannie_business_day_of_month") ? ok : no(`transfer_date ${s(f, "transfer_date")} is not the first fannie_et business day (${s(f, "first_fannie_business_day_of_month")})`)),
  "1.3.tollFreeAndIvrDisclosureLive": (f) => every(f, ["toll_free_live", "ivr_ai_disclosure_verified"], "contact center readiness"),
  "1.4.custodyRecordPresent": (f) => (s(f, "custodian_id") || s(f, "evault_reference") ? ok : no("no custodian and no eVault reference (HF-018)")),
  "1.5.mersInvestorIsFannieMae": (f) => (s(f, "mers_investor_org_id") === "1000010" && s(f, "mers_note_owner_org_id") === "1000010" ? ok : no("MERS investor/note owner is not Fannie Mae Org ID 1000010 (W-016)")),
  "1.6.loanReconciledBeforeBoard": (f) => (s(f, "recon_status") === "reconciled" ? ok : no(`loan is ${s(f, "recon_status") || "unreconciled"}; boardLoan needs reconciled`)),
  // ---- §2 cashiering
  "2.1.noPostingBacklog": (f) => atMost(n(f, "items_received_or_identified_on_or_before_gate_date"), 0, "posting backlog"),
  "2.2.statementSuspenseDisclosure": (f) => (c(f, "suspense_unapplied_cents") <= 0n || (b(f, "d3_amount_shown") && b(f, "d5_instructions_shown")) ? ok : no("statement must carry the (d)(3) unapplied amount and (d)(5) instructions while suspense > 0")),
  "2.3.settlementWithinGrace": (f) => (s(f, "settlement_date") <= addDays(s(f, "due_date") as PlainDate, n(f, "grace_days") || 15) ? ok : no("settlement date is after due date + grace")),
  "2.3.reinitiationLimit": (f) => atMost(n(f, "reinitiations_within_180_days"), 2, "R01/R09 reinitiations in 180 days (Nacha)"),
  "2.3.accountValidated": (f) => (/^validated_/.test(s(f, "validation_status")) ? ok : no(`validation_status ${s(f, "validation_status") || "none"} — WEB/TEL debits need validated_*`)),
  "2.4.dueInstallmentsFirst": (f) => (c(f, "unpaid_installments_cents") === 0n || b(f, "installments_satisfied_by_funds") ? ok : no("curtailment funds must satisfy due installments first (C-1.2-01)")),
  "2.4.nibOrder": (f) => { const amt = c(f, "amount_cents"), ib = c(f, "interest_bearing_upb_cents"); const expect = amt < ib ? "ib_only" : "nib_then_ib"; return s(f, "allocation_order") === expect ? ok : no(`amount ${amt < ib ? "<" : "≥"} IB UPB requires ${expect}`); },
  "2.4.reapplyEligible": (f) => every(f, ["current_before_curtailment", "within_reapply_window", "no_intervening_delinquency", "borrower_requested_in_writing"], "C-1.2-01 reapplication conditions"),
  "2.4.routeToPayoff": (f) => (c(f, "amount_cents") >= c(f, "interest_bearing_upb_cents") + c(f, "nib_cents") ? no("amount ≥ IB UPB + NIB → route to payoff (16.1/16.2)") : ok),
  "2.5.acceptConformingContractorPayment": (f) => (b(f, "conforming") && b(f, "sufficient") && b(f, "timely") ? ok : no("only a conforming, sufficient, timely contractor payment is accepted as such")),
  "2.5.biweeklyInterest": (f) => (s(f, "interest_basis") === "upb×rate×14/365" ? ok : no("biweekly interest basis must be UPB × rate × 14 ÷ 365 (rule 5; day count UNVERIFIED)")),
  "2.6.lateChargesExcludedFromCapitalization": (f) => (c(f, "late_charges_in_capitalization_cents") === 0n ? ok : no("capitalized amount includes late charges (F-1-27)")),
  "2.7.scraLateChargeWaiver": (f) => (b(f, "scra_reduced_rate_period_active") ? no("no late-charge collection during the SCRA reduced-rate period; assessed amounts waived") : ok),
  "2.7.onlyOnePerInstallment": (f) => atMost(n(f, "late_charges_for_installment_not_reversed"), 0, "late charges already assessed for this installment"),
  "2.7.noPyramiding": (f) => (b(f, "periodic_payment_credited_by_grace_end") && b(f, "only_shortfall_is_prior_fees") ? no("§1026.36(c)(2): payment credited in full by grace end; shortfall is prior fees only") : ok),
  "2.7.courtesyWaiverLimit": (f) => atMost(n(f, "courtesy_waivers_rolling_12m"), 0, "courtesy waivers already granted in the rolling 12 months (max 1)"),
  // ---- §3 escrow
  "3.6.workoutSpread60": (f) => (n(f, "plan_months") === 60 || (n(f, "plan_months") >= 12 && b(f, "borrower_election_evidenced")) ? ok : no("workout shortage spread is 60 months unless a ≥12-month borrower election is evidenced")),
  "3.6.shortageMinSpread": (f) => (c(f, "shortage_cents") < c(f, "one_month_escrow_cents") || n(f, "plan_months") >= 12 ? ok : no("shortage ≥ one month requires plan.months ≥ 12 (§1024.17(f)(3))")),
  "3.6.deficiencyMinInstallments": (f) => atLeast(n(f, "plan_months"), 2, "deficiency repayment installments (§1024.17(f)(4))"),
  "3.8.floodEscrowMandatory": (f) => (b(f, "flood_escrow_mandatory") && b(f, "has_flood_line") ? no("flood escrow is mandatory (12 CFR 22.5); waiver refused") : ok),
  "3.8.miMonthlyEscrowRequired": (f) => (b(f, "borrower_paid_mi_monthly") ? no("monthly borrower-paid MI requires escrow (B-1-01)") : ok),
  "3.8.escrowEstablishedOrExceptionDocumented": (f) => (b(f, "escrow_established") || b(f, "exception_documented") ? ok : no("escrow not established and no documented exception before the trial offer")),
  "3.8.hpmlLtvAndCurrent": (f) => (n(f, "ltv_bps") < 8000 && n(f, "regx_days_delinquent") === 0 ? ok : no("HPML waiver needs UPB < 80% of original value and a current loan (§1026.35(b)(3)(ii))")),
  "3.8.illinoisTerminationRight": (f) => every(f, ["balance_at_or_below_65pct_by_timely_payments", "not_in_default", "not_government_insured", "hpml_rules_satisfied"], "765 ILCS 910/5 termination right"),
  // ---- §5–§7
  "5.7.managementActionRecorded": (f) => (s(f, "management_action_code") && s(f, "evidence_event_id") ? ok : no("delinquency requires a management action code with an evidence event id (D2-4-01)")),
  "6.1.activeAccountsForEveryRemittanceType": (f) => { const missing = arr<string>(f, "remittance_types").filter((t) => !arr<string>(f, "active_pi_account_types").includes(t) || !arr<string>(f, "active_ti_account_types").includes(t)); return missing.length ? no(`no active P&I + T&I account for ${missing.join(", ")}`) : ok; },
  "6.4.form496aReviewedWithZeroOrExplainedVariance": (f) => (["under_review", "approved", "submitted"].includes(s(f, "form_496a_status")) && (c(f, "attestation_variance_cents") === 0n || b(f, "variance_explained")) ? ok : no("Form 496A must be under review or later with a zero or explained variance")),
  "7.2.dualCalculationMatches": (f) => (c(f, "engine_a_payment_cents") === c(f, "engine_b_payment_cents") && s(f, "engine_a_rate") === s(f, "engine_b_rate") ? ok : no("second engine result differs (rate/payment must match to the cent)")),
  "7.3.indexRecentEnoughForEstimate": (f) => atMost(n(f, "index_age_business_days"), 15, "index age in business days at disclosure (§1026.20(d))"),
  "7.3.separateDocumentEnforced": (f) => (b(f, "separate_document") ? ok : no("§1026.20(d) notice must be its own document")),
  "7.4.esignConsentActiveForEveryRecipient": (f) => { const lacking = arr<{ party_id: string; consent_active: boolean; covers_class: boolean }>(f, "recipients").filter((r) => !r.consent_active || !r.covers_class); return lacking.length ? no(`no active consent covering the class for ${lacking.map((r) => r.party_id).join(", ")}`) : ok; },
  "7.4.irsEstatementConsentActive": (f) => (b(f, "irs_estatement_consent_active") ? ok : no("electronic 1098 needs an active irs_estatement consent")),
  "7.6.payoffStatementAccuracy": (f) => every(f, ["calc_version_current", "no_pending_items_older_than_cutoff", "arm_adjustment_reflected"], "payoff statement accuracy gate"),
  // ---- §9 insurance
  "9.2.firstNoticeAndReminderSent": (f) => every(f, ["first_notice_sent", "reminder_sent"], "LPI purchase (B-6-01) needs both notices"),
  "9.2.escrowedAdvanceBeforeForcePlacement": (f) => (b(f, "escrowed") && n(f, "regx_days_delinquent") <= 30 ? no("escrowed and ≤30 days delinquent: advance/renew under §1024.17(k)(5), never force-place") : ok),
  "9.4.promptChargeAllowed": (f) => (b(f, "lpi_prompt_charge_prohibited") ? no("jurisdiction prohibits a prompt gap charge") : ok),
  // ---- §11 early intervention
  "11.1.variedAttemptTimes": (f) => (n(f, "evening_or_weekend_attempts_3_cycles") >= 1 && n(f, "distinct_daypart_slots_3_cycles") >= 2 ? ok : no("A4-2.1-04: ≥1 evening/weekend attempt and ≥2 daypart slots per 3 cycles")),
  "11.1.callCap7in7": (f) => atMost(within(f, "counted_call_attempts_at", 7, s(f, "now")) + 1, 7, "Reg F §1006.14(b) counted calls in 7 days including this one"),
  "11.1.quietHours": (f) => { const t = s(f, "consumer_local_time"); const mode = s(f, "mode"); const end = mode === "voice" ? "20:30" : mode === "sms" || mode === "email" ? "20:00" : "21:00"; return t >= "08:00" && t <= end ? ok : no(`outside ${mode || "contact"} window 08:00–${end} consumer-local`); },
  "11.1.tcpaConsentUnrevoked": (f) => (b(f, s(f, "mode") === "sms" ? "tcpa_sms_consent_active" : "tcpa_voice_consent_active") ? ok : no("no unrevoked TCPA consent for this channel (47 CFR 64.1200(a)(1))")),
  "11.1.landlineAi3in30": (f) => atMost(within(f, "ai_voice_attempts_at", 30, s(f, "now")) + 1, 3, "AI-voice attempts to a landline in 30 days without written consent"),
  "11.2.delinquentAtLeast30OrImminentDefault": (f) => (n(f, "regx_days_delinquent") >= 30 || b(f, "imminent_default_requested") ? ok : no("no solicitation before 30 days delinquent absent an imminent-default request (D2-1-01)")),
  "11.2.checklistComplete": (f) => (b(f, "checklist_passed") ? ok : no("early-intervention notice checklist has failing items")),
  "11.3.cessationOnQrpc": (f) => (["qrpc_workout", "qrpc_no_interest"].includes(s(f, "plan_status")) ? ok : no("plan must be ceased{qrpc_workout|qrpc_no_interest} once QRPC is established")),
  "11.3.promiseWithin30Days": (f) => atMost(daysBetween(s(f, "recorded_on") as PlainDate, s(f, "due_on") as PlainDate), 30, "promise-to-pay days (D2-2-02)"),
  "11.3.qrpcReasonPresent": (f) => (s(f, "reason_type") ? ok : no("QRPC event requires a reason type (LL-2026-05)")),
  "11.3.licensedNegotiator": (f) => (!b(f, "mlo_licensing_for_lossmit") || b(f, "licensed_specialist_on_call") ? ok : no("jurisdiction requires a licensed specialist to discuss modification terms")),
  "11.3.thirdPartyAuthorized": (f) => (b(f, "authorization_valid_unexpired") || b(f, "in_call_consent_recorded") ? ok : no("no valid authorization or recorded in-call consent for the third party")),
  "11.4.disclosureFragmentPresent": (f) => (b(f, "disclosure_fragment_present") ? ok : no("§1006.18(e) disclosure fragment missing")),
  "11.4.limitedContentMessageOnly": (f) => (s(f, "voicemail_template") === "limited_content" ? ok : no("voicemail on a debt-collector loan must use the limited-content message")),
  "11.4.noOvershadowing": (f) => (!b(f, "demand_inconsistent_with_dispute_rights") && !b(f, "pay_within_shorter_than_period") ? ok : no("communication overshadows validation rights (§1006.38(b))")),
  "11.4.esignConsentForValidation": (f) => (b(f, "esign_consent_regf_validation") ? ok : no("electronic validation notice needs E-SIGN consent for class regf_validation")),
  "11.4.workplaceProhibited": (f) => (b(f, "workplace_flag") && b(f, "employer_prohibits") ? no("workplace contact prohibited by the employer (§1006.6(b)(3))") : ok),
  "11.4.reassignedNumberCheckFresh": (f) => (n(f, "days_since_rnd_check") <= 60 || n(f, "days_since_consumer_texted_from_number") <= 60 ? ok : no("RND check older than 60 days and no recent consumer text")),
  "11.4.optOutPresent": (f) => (b(f, "opt_out_statement_present") && !b(f, "opt_out_fee") ? ok : no("email/SMS must carry a no-fee opt-out (§1006.6(e))")),
  "11.5.preDecisionNoticeDelivered": (f) => (b(f, "pre_decision_notice_delivered") ? ok : no("Colorado AI Act pre-decision notice not delivered")),
  "11.5.cashReserveBelow25000": (f) => (c(f, "cash_reserves_cents") < 2_500_000n || (b(f, "pcs_over_50_miles") && s(f, "track") === "liquidation") ? ok : no("cash reserves ≥ $25,000 (D2-1-01) — not imminent default")),
  "11.5.delinquentUnder60": (f) => (n(f, "regx_days_delinquent") < 60 ? ok : no("imminent-default evaluation requires < 60 days delinquent")),
  "11.5.ficoFresh": (f) => atMost(daysBetween(s(f, "fico_date") as PlainDate, s(f, "evaluation_date") as PlainDate), 90, "FICO age in days"),
  // ---- §12 loss mitigation
  "12.3.reviewerIndependent": (f) => (s(f, "reviewer_id") !== s(f, "evaluator_id") && s(f, "reviewer_run_id") !== s(f, "evaluator_run_id") ? ok : no("appeal reviewer must be independent of the evaluator (§1024.41(h)(3))")),
  "12.4.incrementMax3Months": (f) => atMost(n(f, "term_months"), 3, "forbearance increment months (D2-3.2-01)"),
  "12.4.termEndBeforeLastScheduledPayment": (f) => (s(f, "term_end") <= s(f, "last_scheduled_payment_date") ? ok : no("MBS forbearance term end is after the last scheduled payment date")),
  "12.4.cumulativeMax12Months": (f) => atMost(n(f, "cumulative_months") + n(f, "term_months"), 12, "cumulative forbearance months (LL-2026-01)"),
  "12.4.projectedDelinquencyMax12Months": (f) => atMost(n(f, "projected_months_delinquent_at_term_end"), 12, "projected delinquency at term end (LL-2026-01)"),
  "12.5.californiaLateFeeBar": (f) => (b(f, "late_fee_assessment_requested") ? no("Cal. Civ. Code §2924.11(d): no late fees while under evaluation/plan") : ok),
  "12.5.combinedMax36Months": (f) => atMost(n(f, "combined_months"), 36, "combined forbearance+repayment months (D2-3.2-01)"),
  "12.5.brpRequiredWhenLongOrDeep": (f) => (n(f, "fnma_days_delinquent") > 90 || n(f, "term_months") > 6 ? (b(f, "brp_complete") ? ok : no("BRP required: > 90 days delinquent or term > 6 months (D2-3.2-02)")) : ok),
  "12.5.paymentCap150": (f) => (c(f, "expected_total_cents") * 2n <= c(f, "contractual_cents") * 3n ? ok : no("expected total exceeds 1.5 × contractual (D2-3.2-02)")),
  "12.5.termMax12UnlessFnmaApproval": (f) => (n(f, "term_months") <= 12 || s(f, "fnma_approval_id") ? ok : no("term > 12 months needs a Fannie Mae approval id (D2-3.2-02)")),
  "12.6.escrowAnalysisWithin30Days": (f) => atMost(n(f, "days_since_escrow_analysis"), 30, "escrow analysis age before deferral offer (policy)"),
  "12.6.contractualPaymentInSolicitationMonth": (f) => (b(f, "full_contractual_payment_received_in_month") ? ok : no("full contractual payment not received in the solicitation/processing month (D2-3.2-04)")),
  "12.6.eligibilityCriteria4to11": (f) => { const m = n(f, "months_delinquent"); const issues: string[] = []; if (m < 2 || m > 6) issues.push(`delinquency ${m} months not in 2–6`); if (n(f, "seasoning_months") < 12) issues.push("seasoning < 12"); if (n(f, "months_since_prior_deferral") < 12) issues.push("prior deferral < 12 months ago"); if (n(f, "cumulative_deferred_months") + m > 12) issues.push("cumulative > 12"); if (n(f, "months_to_maturity") <= 36) issues.push("maturity ≤ 36 months"); return issues.length ? no(`D2-3.2-04 criteria: ${issues.join("; ")}`) : ok; },
  "12.7.contractualPaymentInSolicitationMonth": (f) => (b(f, "full_contractual_payment_received_in_month") ? ok : no("full contractual payment not received in the solicitation/processing month (D2-3.2-05)")),
  "12.7.disasterEligibility": (f) => { const m = n(f, "months_delinquent"); const issues: string[] = []; if (!b(f, "fema_disaster_basis")) issues.push("no FEMA registry basis"); if (!b(f, "current_or_under_2_months_at_disaster") && !b(f, "fnma_approval")) issues.push("not current/<2 months at disaster"); if (m < 1 || m > 12) issues.push(`delinquency ${m} months not in 1–12`); if (b(f, "prior_same_event_deferral")) issues.push("prior deferral for the same event"); if (n(f, "months_to_maturity") <= 36) issues.push("maturity ≤ 36 months"); if (b(f, "conflicting_arrangement")) issues.push("conflicting arrangement"); return issues.length ? no(`D2-3.2-05: ${issues.join("; ")}`) : ok; },
  "12.8.noSaleWithinSolicitationWindow": (f) => { const win = s(f, "foreclosure_type") === "judicial" ? 60 : 30; const d = f["days_to_sale"]; return d === null || d === undefined || Number(d) > win ? ok : no(`scheduled sale within ${win} days (${s(f, "foreclosure_type")})`); },
  "12.9.listedFiveConsecutiveDays": (f) => atLeast(n(f, "consecutive_days_listed"), 5, "consecutive MLS days incl. Sat+Sun (D2-3.3-01)"),
  "12.9.miWrittenAgreement": (f) => (!b(f, "mi_non_delegated") || b(f, "mi_written_agreement_received") ? ok : no("non-delegated MI needs the insurer's written agreement")),
  // ---- §13 foreclosure
  "13.2.saleAtLeast7DaysAfterMafNotice": (f) => atLeast(daysBetween(s(f, "maf_notified_on") as PlainDate, s(f, "sale_date") as PlainDate), 7, "days from MAF notice to sale (E-3.2-07)"),
  "13.4.breachLetterAndSolicitationExpired": (f) => every(f, ["breach_letter_expired", "solicitation_deadline_expired"], "E-3.2-01 preconditions"),
  "13.4.maCitationSearchCompleted": (f) => (b(f, "ma_lead_paint_citation_search_completed") ? ok : no("MA lead-paint citation search not completed (F-1-08)")),
  "13.4.dmdcCertificateFresh": (f) => atMost(n(f, "dmdc_certificate_age_days"), 30, "DMDC certificate age at referral"),
  "13.6.firmRetainedAndCurrent": (f) => every(f, ["firm_retained_for_state", "lra_executed", "training_done", "eo_unexpired"], "A4-2-01 firm retention"),
  "13.6.fannieMaePriorApproval": (f) => (s(f, "fnma_approval_document_id") ? ok : no("post-sale matter transfer needs Fannie Mae prior approval (E-1.1-01)")),
  "13.7.fannieMaePriorWrittenApproval": (f) => (s(f, "fnma_written_approval_document_id") ? ok : no("removal/appeal needs Fannie Mae prior written approval (E-1.3-01)")),
  "13.8.affidavitOnFreshCertificates": (f) => (n(f, "certificate_age_days") <= 30 && s(f, "executed_by_role") === "signing_officer" && b(f, "filed") ? ok : no("SCRA affidavit needs ≤30-day certificates, a signing_officer execution and filing")),
  // ---- §14–§19
  "14.2.rule3002_1NoticesCeaseAfterRelief": (f) => (b(f, "relief_order_entered") && b(f, "rule_3002_1_notices_scheduled") ? no("Rule 3002.1 notices must cease after relief from stay") : ok),
  "15.2.refundCreditLinePresent": (f) => (b(f, "hazard_refund_expected") && !(b(f, "credit_line_present") || b(f, "refusal_comment_present")) ? no("final claim must credit the hazard refund or carry a refusal comment (E-4.4-02)") : ok),
  "15.3.premiumPaidThroughLiquidationMonth": (f) => (s(f, "premium_paid_through") >= s(f, "liquidation_month") ? ok : no("MI premium not paid through the liquidation month")),
  "16.1.goodThroughWithin30Days": (f) => atMost(daysBetween(s(f, "receipt_date") as PlainDate, s(f, "good_through") as PlainDate), 30, "good-through days from receipt"),
  "16.1.wireInstructionsVerified": (f) => (s(f, "wire_instruction_version") === s(f, "vault_active_version") && s(f, "verification_token") ? ok : no("wire instructions must be the vault's active version with a minted verification token")),
  "16.3.lpoaRecordedForState": (f) => (s(f, "lpoa_status") === "recorded" ? ok : no(`LPOA is ${s(f, "lpoa_status") || "not recorded"} for the state`)),
  "16.3.penaltyNeverPassedThrough": (f) => (["borrower", "fnma_claim"].includes(s(f, "penalty_charge_target")) ? no("release penalties never map to borrower or Fannie Mae claims") : ok),
  "16.4.allCountiesRecorded": (f) => { const bad = arr<{ county: string; status: string }>(f, "release_tasks").filter((t) => !["recorded", "third_party_recorded"].includes(t.status)); return bad.length ? no(`not recorded in ${bad.map((t) => t.county).join(", ")}`) : ok; },
  "17.2.noStatementForCyclesOnOrAfterTransfer": (f) => (s(f, "cycle_due_date") >= s(f, "transfer_date") ? no("no statement for cycles with due dates ≥ transfer_date (7.1)") : ok),
  "17.3.noInvestorEventsOnOrAfterTransferDate": (f) => (s(f, "activity_date") >= s(f, "transfer_date") ? no("investor events with activity dates ≥ T may not be created for transferred loans") : ok),
  "17.4.noTransferOutCancellationBeforeTransferDate": (f) => (s(f, "cancel_reason") === "transfer_out" && s(f, "today") < s(f, "transfer_date") ? no("§1024.41(k): timers on listed loans may not be cancelled for transfer_out before the transfer date") : ok),
  "17.4.retainedCaseOwnership": (f) => (s(f, "case_owner") === "supermortgage" ? ok : no("cases opened before T remain Supermortgage's; 4.1/4.2 clocks unchanged")),
  "18.7.servicesAtLeastOneFannieMaeLoan": (f) => atLeast(n(f, "fnma_loans_serviced_dec31"), 1, "Fannie Mae loans serviced as of Dec 31 (A4-1-01)"),
  "19.3.evalSuitePassedAndInventoryUpdated": (f) => every(f, ["eval_suite_passed", "inventory_updated"], "AI system deploy gate"),
  "19.4.allFourBiasTestsPass": (f) => { const missing = ["disparate_treatment", "disparate_impact", "proxy", "outcome_parity"].filter((k) => !arr<string>(f, "passed_tests").includes(k)); return missing.length ? no(`bias tests not passed: ${missing.join(", ")}`) : ok; },
  "19.4.fairLendingRowPresent": (f) => (["validated", "not_obtained"].includes(s(f, "fl_row_status")) && (s(f, "fl_row_status") !== "not_obtained" || s(f, "not_obtained_evidence_id")) ? ok : no("FL row must be validated, or not_obtained with evidence, for note_date ≥ 2023-03-01")),
};

export class UnknownEvaluator extends Error { constructor(ref: string) { super(`no evaluator registered for ${ref}`); this.name = "UnknownEvaluator"; } }
export function evaluateGate(ref: string, facts: Facts): GateResult {
  const fn = EVALUATORS[ref.replace(/^evaluator:/, "")];
  if (!fn) throw new UnknownEvaluator(ref);
  return fn(facts);
}
export class GateClosed extends Error { readonly ref: string; readonly reason: string; constructor(ref: string, reason: string) { super(`${ref}: ${reason}`); this.name = "GateClosed"; this.ref = ref; this.reason = reason; } }
/** Assert a gate at a command boundary. */
export function assertGate(ref: string, facts: Facts): void { const r = evaluateGate(ref, facts); if (!r.open) throw new GateClosed(ref, r.reason ?? "closed"); }
