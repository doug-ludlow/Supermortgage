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

import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type GateResult, type Facts, type Evaluator } from "./evaluator-kit.ts";
export type { GateResult, Facts, Evaluator };
import { SECTION_14_EVALUATORS } from "../domain/bankruptcy/evaluators.ts";
import { SECTION_15_EVALUATORS } from "../domain/reo/evaluators.ts";
import { SECTION_16_EVALUATORS } from "../domain/payoff/evaluators.ts";
import { SECTION_17_EVALUATORS } from "../domain/transfers/evaluators.ts";
import { SECTION_18_EVALUATORS } from "../domain/qc-audit/evaluators.ts";
import { SECTION_19_EVALUATORS } from "../domain/data-security/evaluators.ts";
// ---- §1–§13 process-owned files (scaffolded by tools/workflows/wire.py)
import { EVALUATORS_1_1 } from "../domain/boarding/evaluators-1-1.ts";
import { EVALUATORS_1_2 } from "../domain/transfers/evaluators-1-2.ts";
import { EVALUATORS_1_3 } from "../domain/transfers/evaluators-1-3.ts";
import { EVALUATORS_1_4 } from "../domain/transfers/evaluators-1-4.ts";
import { EVALUATORS_1_5 } from "../domain/transfers/evaluators-1-5.ts";
import { EVALUATORS_1_6 } from "../domain/transfers/evaluators-1-6.ts";
import { EVALUATORS_1_7 } from "../domain/transfers/evaluators-1-7.ts";
import { EVALUATORS_2_1 } from "../domain/cashiering/evaluators-2-1.ts";
import { EVALUATORS_2_2 } from "../domain/cashiering/evaluators-2-2.ts";
import { EVALUATORS_2_3 } from "../domain/cashiering/evaluators-2-3.ts";
import { EVALUATORS_2_4 } from "../domain/cashiering/evaluators-2-4.ts";
import { EVALUATORS_2_5 } from "../domain/cashiering/evaluators-2-5.ts";
import { EVALUATORS_2_6 } from "../domain/cashiering/evaluators-2-6.ts";
import { EVALUATORS_2_7 } from "../domain/cashiering/evaluators-2-7.ts";
import { EVALUATORS_3_1 } from "../domain/escrow/evaluators-3-1.ts";
import { EVALUATORS_3_2 } from "../domain/escrow/evaluators-3-2.ts";
import { EVALUATORS_3_3 } from "../domain/escrow/evaluators-3-3.ts";
import { EVALUATORS_3_4 } from "../domain/escrow/evaluators-3-4.ts";
import { EVALUATORS_3_5 } from "../domain/escrow/evaluators-3-5.ts";
import { EVALUATORS_3_6 } from "../domain/escrow/evaluators-3-6.ts";
import { EVALUATORS_3_7 } from "../domain/escrow/evaluators-3-7.ts";
import { EVALUATORS_3_8 } from "../domain/escrow/evaluators-3-8.ts";
import { EVALUATORS_3_9 } from "../domain/escrow/evaluators-3-9.ts";
import { EVALUATORS_4_1 } from "../domain/servicing-requests/evaluators-4-1.ts";
import { EVALUATORS_4_2 } from "../domain/servicing-requests/evaluators-4-2.ts";
import { EVALUATORS_4_3 } from "../domain/servicing-requests/evaluators-4-3.ts";
import { EVALUATORS_4_4 } from "../domain/servicing-requests/evaluators-4-4.ts";
import { EVALUATORS_4_5 } from "../domain/servicing-requests/evaluators-4-5.ts";
import { EVALUATORS_5_1 } from "../domain/investor/evaluators-5-1.ts";
import { EVALUATORS_5_2 } from "../domain/investor/evaluators-5-2.ts";
import { EVALUATORS_5_3 } from "../domain/investor/evaluators-5-3.ts";
import { EVALUATORS_5_4 } from "../domain/investor/evaluators-5-4.ts";
import { EVALUATORS_5_5 } from "../domain/investor/evaluators-5-5.ts";
import { EVALUATORS_5_6 } from "../domain/investor/evaluators-5-6.ts";
import { EVALUATORS_5_7 } from "../domain/investor/evaluators-5-7.ts";
import { EVALUATORS_6_1 } from "../domain/custodial/evaluators-6-1.ts";
import { EVALUATORS_6_2 } from "../domain/custodial/evaluators-6-2.ts";
import { EVALUATORS_6_3 } from "../domain/custodial/evaluators-6-3.ts";
import { EVALUATORS_6_4 } from "../domain/custodial/evaluators-6-4.ts";
import { EVALUATORS_6_5 } from "../domain/custodial/evaluators-6-5.ts";
import { EVALUATORS_7_1 } from "../domain/notices/evaluators-7-1.ts";
import { EVALUATORS_7_2 } from "../domain/notices/evaluators-7-2.ts";
import { EVALUATORS_7_3 } from "../domain/notices/evaluators-7-3.ts";
import { EVALUATORS_7_4 } from "../domain/notices/evaluators-7-4.ts";
import { EVALUATORS_7_5 } from "../domain/notices/evaluators-7-5.ts";
import { EVALUATORS_7_6 } from "../domain/notices/evaluators-7-6.ts";
import { EVALUATORS_8_1 } from "../domain/credit-reporting/evaluators-8-1.ts";
import { EVALUATORS_8_2 } from "../domain/credit-reporting/evaluators-8-2.ts";
import { EVALUATORS_8_3 } from "../domain/credit-reporting/evaluators-8-3.ts";
import { EVALUATORS_9_1 } from "../domain/insurance/evaluators-9-1.ts";
import { EVALUATORS_9_2 } from "../domain/insurance/evaluators-9-2.ts";
import { EVALUATORS_9_3 } from "../domain/insurance/evaluators-9-3.ts";
import { EVALUATORS_9_4 } from "../domain/insurance/evaluators-9-4.ts";
import { EVALUATORS_9_5 } from "../domain/insurance/evaluators-9-5.ts";
import { EVALUATORS_9_6 } from "../domain/insurance/evaluators-9-6.ts";
import { EVALUATORS_9_7 } from "../domain/insurance/evaluators-9-7.ts";
import { EVALUATORS_9_8 } from "../domain/insurance/evaluators-9-8.ts";
import { EVALUATORS_9_9 } from "../domain/insurance/evaluators-9-9.ts";
import { EVALUATORS_10_1 } from "../domain/pmi/evaluators-10-1.ts";
import { EVALUATORS_10_2 } from "../domain/pmi/evaluators-10-2.ts";
import { EVALUATORS_10_3 } from "../domain/pmi/evaluators-10-3.ts";
import { EVALUATORS_10_4 } from "../domain/pmi/evaluators-10-4.ts";
import { EVALUATORS_10_5 } from "../domain/pmi/evaluators-10-5.ts";
import { EVALUATORS_10_6 } from "../domain/pmi/evaluators-10-6.ts";
import { EVALUATORS_11_1 } from "../domain/early-intervention/evaluators-11-1.ts";
import { EVALUATORS_11_2 } from "../domain/early-intervention/evaluators-11-2.ts";
import { EVALUATORS_11_3 } from "../domain/early-intervention/evaluators-11-3.ts";
import { EVALUATORS_11_4 } from "../domain/early-intervention/evaluators-11-4.ts";
import { EVALUATORS_11_5 } from "../domain/early-intervention/evaluators-11-5.ts";
import { EVALUATORS_12_1 } from "../domain/lossmit/evaluators-12-1.ts";
import { EVALUATORS_12_2 } from "../domain/lossmit/evaluators-12-2.ts";
import { EVALUATORS_12_3 } from "../domain/lossmit/evaluators-12-3.ts";
import { EVALUATORS_12_4 } from "../domain/lossmit/evaluators-12-4.ts";
import { EVALUATORS_12_5 } from "../domain/lossmit/evaluators-12-5.ts";
import { EVALUATORS_12_6 } from "../domain/lossmit/evaluators-12-6.ts";
import { EVALUATORS_12_7 } from "../domain/lossmit/evaluators-12-7.ts";
import { EVALUATORS_12_8 } from "../domain/lossmit/evaluators-12-8.ts";
import { EVALUATORS_12_9 } from "../domain/lossmit/evaluators-12-9.ts";
import { EVALUATORS_13_1 } from "../domain/foreclosure/evaluators-13-1.ts";
import { EVALUATORS_13_2 } from "../domain/foreclosure/evaluators-13-2.ts";
import { EVALUATORS_13_3 } from "../domain/foreclosure/evaluators-13-3.ts";
import { EVALUATORS_13_4 } from "../domain/foreclosure/evaluators-13-4.ts";
import { EVALUATORS_13_5 } from "../domain/foreclosure/evaluators-13-5.ts";
import { EVALUATORS_13_6 } from "../domain/foreclosure/evaluators-13-6.ts";
import { EVALUATORS_13_7 } from "../domain/foreclosure/evaluators-13-7.ts";
import { EVALUATORS_13_8 } from "../domain/foreclosure/evaluators-13-8.ts";
import { EVALUATORS_13_9 } from "../domain/foreclosure/evaluators-13-9.ts";
// ---- §20–§31 process-owned files (scaffolded by tools/workflows/wire_orig.py)
import { EVALUATORS_20_1 } from "../domain/leads-pricing/evaluators-20-1.ts";
import { EVALUATORS_20_2 } from "../domain/leads-pricing/evaluators-20-2.ts";
import { EVALUATORS_20_3 } from "../domain/leads-pricing/evaluators-20-3.ts";
import { EVALUATORS_20_4 } from "../domain/leads-pricing/evaluators-20-4.ts";
import { EVALUATORS_21_1 } from "../domain/application/evaluators-21-1.ts";
import { EVALUATORS_21_2 } from "../domain/application/evaluators-21-2.ts";
import { EVALUATORS_21_3 } from "../domain/application/evaluators-21-3.ts";
import { EVALUATORS_21_4 } from "../domain/application/evaluators-21-4.ts";
import { EVALUATORS_21_5 } from "../domain/application/evaluators-21-5.ts";
import { EVALUATORS_21_6 } from "../domain/application/evaluators-21-6.ts";
import { EVALUATORS_22_1 } from "../domain/verification/evaluators-22-1.ts";
import { EVALUATORS_22_2 } from "../domain/verification/evaluators-22-2.ts";
import { EVALUATORS_22_3 } from "../domain/verification/evaluators-22-3.ts";
import { EVALUATORS_22_4 } from "../domain/verification/evaluators-22-4.ts";
import { EVALUATORS_22_5 } from "../domain/verification/evaluators-22-5.ts";
import { EVALUATORS_22_6 } from "../domain/verification/evaluators-22-6.ts";
import { EVALUATORS_23_1 } from "../domain/underwriting/evaluators-23-1.ts";
import { EVALUATORS_23_2 } from "../domain/underwriting/evaluators-23-2.ts";
import { EVALUATORS_23_3 } from "../domain/underwriting/evaluators-23-3.ts";
import { EVALUATORS_23_4 } from "../domain/underwriting/evaluators-23-4.ts";
import { EVALUATORS_24_1 } from "../domain/property/evaluators-24-1.ts";
import { EVALUATORS_24_2 } from "../domain/property/evaluators-24-2.ts";
import { EVALUATORS_24_3 } from "../domain/property/evaluators-24-3.ts";
import { EVALUATORS_24_4 } from "../domain/property/evaluators-24-4.ts";
import { EVALUATORS_24_5 } from "../domain/property/evaluators-24-5.ts";
import { EVALUATORS_24_6 } from "../domain/property/evaluators-24-6.ts";
import { EVALUATORS_25_1 } from "../domain/compliance-disclosures/evaluators-25-1.ts";
import { EVALUATORS_25_2 } from "../domain/compliance-disclosures/evaluators-25-2.ts";
import { EVALUATORS_25_3 } from "../domain/compliance-disclosures/evaluators-25-3.ts";
import { EVALUATORS_25_4 } from "../domain/compliance-disclosures/evaluators-25-4.ts";
import { EVALUATORS_26_1 } from "../domain/closing/evaluators-26-1.ts";
import { EVALUATORS_26_2 } from "../domain/closing/evaluators-26-2.ts";
import { EVALUATORS_26_3 } from "../domain/closing/evaluators-26-3.ts";
import { EVALUATORS_26_4 } from "../domain/closing/evaluators-26-4.ts";
import { EVALUATORS_27_1 } from "../domain/warehouse/evaluators-27-1.ts";
import { EVALUATORS_27_2 } from "../domain/warehouse/evaluators-27-2.ts";
import { EVALUATORS_28_1 } from "../domain/qc-hmda/evaluators-28-1.ts";
import { EVALUATORS_28_2 } from "../domain/qc-hmda/evaluators-28-2.ts";
import { EVALUATORS_28_3 } from "../domain/qc-hmda/evaluators-28-3.ts";
import { EVALUATORS_28_4 } from "../domain/qc-hmda/evaluators-28-4.ts";
import { EVALUATORS_29_1 } from "../domain/secondary/evaluators-29-1.ts";
import { EVALUATORS_29_2 } from "../domain/secondary/evaluators-29-2.ts";
import { EVALUATORS_29_3 } from "../domain/secondary/evaluators-29-3.ts";
import { EVALUATORS_29_4 } from "../domain/secondary/evaluators-29-4.ts";
import { EVALUATORS_30_1 } from "../domain/orig-boarding/evaluators-30-1.ts";
import { EVALUATORS_30_2 } from "../domain/orig-boarding/evaluators-30-2.ts";
import { EVALUATORS_30_3 } from "../domain/orig-boarding/evaluators-30-3.ts";
import { EVALUATORS_30_4 } from "../domain/orig-boarding/evaluators-30-4.ts";
import { EVALUATORS_31_1 } from "../domain/governance/evaluators-31-1.ts";
import { EVALUATORS_31_2 } from "../domain/governance/evaluators-31-2.ts";
import { EVALUATORS_31_3 } from "../domain/governance/evaluators-31-3.ts";
// ---- §32 process-owned files (scaffolded by tools/workflows/wire_orig.py)
import { EVALUATORS_32_1 } from "../domain/borrower/evaluators-32-1.ts";
import { EVALUATORS_32_2 } from "../domain/borrower/evaluators-32-2.ts";
import { EVALUATORS_32_3 } from "../domain/borrower/evaluators-32-3.ts";
import { EVALUATORS_32_4 } from "../domain/borrower/evaluators-32-4.ts";
import { EVALUATORS_32_5 } from "../domain/borrower/evaluators-32-5.ts";
import { EVALUATORS_32_6 } from "../domain/borrower/evaluators-32-6.ts";
import { EVALUATORS_32_7 } from "../domain/borrower/evaluators-32-7.ts";
import { EVALUATORS_32_8 } from "../domain/borrower/evaluators-32-8.ts";
import { EVALUATORS_32_9 } from "../domain/borrower/evaluators-32-9.ts";
import { EVALUATORS_32_10 } from "../domain/borrower/evaluators-32-10.ts";
import { EVALUATORS_32_11 } from "../domain/borrower/evaluators-32-11.ts";
import { EVALUATORS_32_12 } from "../domain/borrower/evaluators-32-12.ts";
import { EVALUATORS_32_13 } from "../domain/borrower/evaluators-32-13.ts";

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
  "1.7.noFirstFilingBeforeReasonableDate": (f) => (s(f, "today") > s(f, "reasonable_date") ? ok : no(`no first notice/filing before the reasonable date ${s(f, "reasonable_date")} on the incomplete-application acknowledgment (§1024.41(k)(2))`)),
  "1.7.forbearanceCumulativeWithin12Months": (f) => (b(f, "fnma_exception_approved") || n(f, "cumulative_months") + n(f, "requested_months") <= 12 ? ok : no(`cumulative forbearance ${n(f, "cumulative_months")} + ${n(f, "requested_months")} > 12 months without Fannie Mae exception approval (LL-2026-01)`)),
  // ---- §3 escrow
  "3.2.newPaymentAtLeast30DaysAfterStatement": (f) => (["payoff", "transfer", "mi_termination"].includes(s(f, "reason")) || b(f, "payment_decreased") || s(f, "effective_on") >= addDays(s(f, "statement_sent_on") as PlainDate, 30) ? ok : no(`new escrow payment effective ${s(f, "effective_on")} is less than 30 days after the statement sent ${s(f, "statement_sent_on")} (3.2 R9; bypassed only for payoff, transfer, mi_termination or a decrease)`)),
  "3.4.cushionCap": (f) => (b(f, "cap_check_passed") ? ok : no("cushion exceeds 1/6 of annual disbursements (§1024.17(c)(5), (d)(2)(ii))")),
  "3.4.preaccrual": (f) => (b(f, "preaccrual_check_passed") ? ok : no("a projected disbursement precedes the bill's availability date or follows its penalty date (§1024.17(c)(6))")),
  "3.8.hpmlFiveYears": (f) => (!b(f, "hpml") || s(f, "today") >= addYears(s(f, "consummation_date") as PlainDate, 5) ? ok : no(`HPML escrow may not be cancelled before ${addYears(s(f, "consummation_date") as PlainDate, 5)} (§1026.35(b)(3))`)),
  // ---- §2 cashiering
  "2.1.noPostingBacklog": (f) => atMost(n(f, "items_received_or_identified_on_or_before_gate_date"), 0, "posting backlog"),
  "2.2.fiftyRuleCount": (f) => atMost(n(f, "partial_count_12m"), 2, "$50-rule applications already made in the trailing 12 months (C-1.1-02: max 3 — a fourth short payment is an ordinary partial)"),
  "2.2.statementSuspenseDisclosure": (f) => (c(f, "suspense_unapplied_cents") <= 0n || (b(f, "d3_amount_shown") && b(f, "d5_instructions_shown")) ? ok : no("statement must carry the (d)(3) unapplied amount and (d)(5) instructions while suspense > 0")),
  "2.3.settlementWithinGrace": (f) => (s(f, "settlement_date") <= addDays(s(f, "due_date") as PlainDate, n(f, "grace_days") || 15) ? ok : no("settlement date is after due date + grace")),
  "2.3.reinitiationLimit": (f) => atMost(n(f, "reinitiations_within_180_days"), 1, "prior R01/R09 reinitiations in 180 days (Nacha: at most two — a third attempt is refused)"),
  "2.3.accountValidated": (f) => (/^validated_/.test(s(f, "validation_status")) ? ok : no(`validation_status ${s(f, "validation_status") || "none"} — WEB/TEL debits need validated_*`)),
  "2.4.dueInstallmentsFirst": (f) => (c(f, "unpaid_installments_cents") === 0n || b(f, "installments_satisfied_by_funds") ? ok : no("curtailment funds must satisfy due installments first (C-1.2-01)")),
  "2.4.nibOrder": (f) => { const amt = c(f, "amount_cents"), ib = c(f, "interest_bearing_upb_cents"); const expect = amt < ib ? "ib_only" : "nib_then_ib"; return s(f, "allocation_order") === expect ? ok : no(`amount ${amt < ib ? "<" : "≥"} IB UPB requires ${expect}`); },
  "2.4.reapplyEligible": (f) => every(f, ["current_before_curtailment", "within_reapply_window", "no_intervening_delinquency", "borrower_requested_in_writing"], "C-1.2-01 reapplication conditions"),
  "2.4.routeToPayoff": (f) => (c(f, "amount_cents") >= c(f, "interest_bearing_upb_cents") + c(f, "nib_cents") ? no("amount ≥ IB UPB + NIB → route to payoff (16.1/16.2)") : ok),
  "2.6.lateChargesExcludedFromCapitalization": (f) => (c(f, "late_charges_in_capitalization_cents") === 0n ? ok : no("capitalized amount includes late charges (F-1-27)")),
  "2.7.graceGateOpen": (f) => (s(f, "run_on") > s(f, "grace_end_on") ? ok : no(`late-charge grace period runs through ${s(f, "grace_end_on")} (note ¶6(A))`)),
  "2.7.forbearanceNoAccrual": (f) => (!b(f, "forbearance_active") || (s(f, "defaulted_on") !== "" && s(f, "installment_due_date") >= s(f, "defaulted_on")) ? ok : no("forbearance plan active: no late-charge accrual (D2-3.2-01)")),
  "2.7.scraLateChargeWaiver": (f) => (b(f, "scra_reduced_rate_period_active") ? no("no late-charge collection during the SCRA reduced-rate period; assessed amounts waived") : ok),
  "2.7.onlyOnePerInstallment": (f) => atMost(n(f, "late_charges_for_installment_not_reversed"), 0, "late charges already assessed for this installment"),
  "2.7.noPyramiding": (f) => (b(f, "periodic_payment_credited_by_grace_end") && b(f, "only_shortfall_is_prior_fees") ? no("§1026.36(c)(2): payment credited in full by grace end; shortfall is prior fees only") : ok),
  "2.7.courtesyWaiverLimit": (f) => atMost(n(f, "courtesy_waivers_rolling_12m"), 0, "courtesy waivers already granted in the rolling 12 months (max 1)"),
  // ---- §3 escrow
  "3.8.floodEscrowMandatory": (f) => (b(f, "flood_escrow_mandatory") && b(f, "has_flood_line") ? no("flood escrow is mandatory (12 CFR 22.5); waiver refused") : ok),
  "3.8.miMonthlyEscrowRequired": (f) => (b(f, "borrower_paid_mi_monthly") ? no("monthly borrower-paid MI requires escrow (B-1-01)") : ok),
  "3.8.escrowEstablishedOrExceptionDocumented": (f) => (b(f, "escrow_established") || b(f, "exception_documented") ? ok : no("escrow not established and no documented exception before the trial offer")),
  "3.8.hpmlLtvAndCurrent": (f) => (n(f, "ltv_bps") < 8000 && n(f, "regx_days_delinquent") === 0 ? ok : no("HPML waiver needs UPB < 80% of original value and a current loan (§1026.35(b)(3)(ii))")),
  "3.8.illinoisTerminationRight": (f) => every(f, ["balance_at_or_below_65pct_by_timely_payments", "not_in_default", "not_government_insured", "hpml_rules_satisfied"], "765 ILCS 910/5 termination right"),
  // ---- §5–§7
  "5.7.managementActionRecorded": (f) => { const omitted = arr<string>(f, "loans_with_management_action").filter((l) => !arr<string>(f, "loans_in_file").includes(l)); return omitted.length ? no(`loans with a delinquency-management action in the month are missing from the file even though current: ${omitted.join(", ")} (D2-4-01)`) : ok; },
  "6.1.activeAccountsForEveryRemittanceType": (f) => { const missing = arr<string>(f, "remittance_types").filter((t) => !arr<string>(f, "active_pi_account_types").includes(t) || !arr<string>(f, "active_ti_account_types").includes(t)); return missing.length ? no(`no active P&I + T&I account for ${missing.join(", ")}`) : ok; },
  "6.4.form496aReviewedWithZeroOrExplainedVariance": (f) => (["under_review", "approved", "completed"].includes(s(f, "form_496a_status")) && (c(f, "attestation_variance_cents") === 0n || b(f, "variance_explained")) ? ok : no("Form 496A must be under review or later with a zero or explained variance")),
  "7.2.dualCalculationMatches": (f) => (c(f, "engine_a_payment_cents") === c(f, "engine_b_payment_cents") && s(f, "engine_a_rate") === s(f, "engine_b_rate") ? ok : no("second engine result differs (rate/payment must match to the cent)")),
  "7.4.esignConsentActiveForEveryRecipient": (f) => { const lacking = arr<{ party_id: string; consent_active: boolean; covers_class: boolean }>(f, "recipients").filter((r) => !r.consent_active || !r.covers_class); return lacking.length ? no(`no active consent covering the class for ${lacking.map((r) => r.party_id).join(", ")}`) : ok; },
  "7.4.irsEstatementConsentActive": (f) => (b(f, "irs_estatement_consent_active") ? ok : no("electronic 1098 needs an active irs_estatement consent")),
  "7.6.payoffStatementAccuracy": (f) => every(f, ["calc_version_current", "no_pending_items_older_than_cutoff", "arm_adjustment_reflected"], "payoff statement accuracy gate"),
  // ---- §9 insurance
  "9.2.firstNoticeAndReminderSent": (f) => every(f, ["first_notice_sent", "reminder_sent"], "LPI purchase (B-6-01) needs both notices"),
  "9.2.escrowedAdvanceBeforeForcePlacement": (f) => (!b(f, "escrowed") ? ok : n(f, "regx_days_delinquent") <= 30 ? no("escrowed and ≤30 days delinquent: pay/advance the renewal under §1024.17(k)(1)–(2), never force-place") : b(f, "vacant") || (s(f, "cancellation_reason") !== "" && s(f, "cancellation_reason") !== "nonpayment") ? ok : no("escrowed and >30 days delinquent: §1024.17(k)(5) permits LPI only with documented inability to disburse — cancellation for reasons other than nonpayment, or vacancy (comment 17(k)(5)(ii)(A)-1); advance the premium instead")),
  "9.4.promptChargeAllowed": (f) => (b(f, "lpi_prompt_charge_prohibited") ? no("jurisdiction prohibits a prompt gap charge") : ok),
  // ---- §11 early intervention
  "11.1.variedAttemptTimes": (f) => (n(f, "evening_or_weekend_attempts_3_cycles") >= 1 && n(f, "distinct_daypart_slots_3_cycles") >= 2 ? ok : no("A4-2.1-04: ≥1 evening/weekend attempt and ≥2 daypart slots per 3 cycles")),
  "11.1.callCap7in7": (f) => atMost(within(f, "counted_call_attempts_at", 7, s(f, "now")) + 1, 7, "Reg F §1006.14(b) counted calls in 7 days including this one"),
  "11.1.quietHours": (f) => { const m = s(f, "mode"); const ch = m === "sms" || m === "email" ? m : m === "letter" || m === "mail" ? "mail" : "voice"; if (ch === "mail") return ok; const end = ch === "voice" ? "20:30" : "20:00"; const times = arr<unknown>(f, "consumer_local_times").map((x) => (x !== null && typeof x === "object" ? String((x as { time?: unknown }).time ?? "") : String(x ?? ""))); const all = times.length ? times : [s(f, "consumer_local_time")]; const bad = all.filter((t) => !/^\d\d:\d\d$/.test(t) || !(t > "08:00" && t <= end)); return bad.length === 0 ? ok : no(`outside ${ch} window after 08:00 through ${end} in every candidate zone (rule 8: ${bad.join(", ") || "no consumer-local time"}; 11.1-T12: 08:00 is refused)`); },
  "11.1.tcpaConsentUnrevoked": (f) => (b(f, s(f, "mode") === "sms" ? "tcpa_sms_consent_active" : "tcpa_voice_consent_active") ? ok : no("no unrevoked TCPA consent for this channel (47 CFR 64.1200(a)(1))")),
  "11.1.landlineAi3in30": (f) => atMost(within(f, "ai_voice_attempts_at", 30, s(f, "now")) + 1, 3, "AI-voice attempts to a landline in 30 days without written consent"),
  "11.2.delinquentAtLeast30OrImminentDefault": (f) => (n(f, "regx_days_delinquent") >= 30 || b(f, "imminent_default_requested") ? ok : no("no solicitation before 30 days delinquent absent an imminent-default request (D2-1-01)")),
  "11.2.checklistComplete": (f) => (b(f, "checklist_passed") ? ok : no("early-intervention notice checklist has failing items")),
  "11.3.cessationOnQrpc": (f) => (["qrpc_workout", "qrpc_no_interest", "ptp_pending"].includes(s(f, "plan_status")) || (s(f, "plan_status") === "active" && ["promise_to_pay_partial", "callback_only", "refused"].includes(s(f, "commitment_kind"))) ? ok : no("plan must be ceased{qrpc_workout|qrpc_no_interest|ptp_pending} once QRPC is established, or stay active only on a partial/callback-only commitment (D2-2-02)")),
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
  "11.1.preSaleContactAllowed": (f) => (n(f, "days_until_sale") > (b(f, "judicial") ? 60 : 30) || b(f, "contact_required_through_sale") ? ok : no("outbound attempts stop 60 (judicial) / 30 (non-judicial) days before the sale (D2-2-02)")),
  "11.1.postConversationCooloff": (f) => (n(f, "days_since_conversation") >= 7 || b(f, "callback_consent_within_7d") ? ok : no("no call within 7 days after a conversation (Reg F §1006.14(b)(2)(ii))")),
  "11.2.onceBkNoticePerCase": (f) => (b(f, "bk_notice_sent_for_case") ? no("a second bankruptcy-modified notice for the same case is refused (comment 39(c)(2)-1)") : ok),
  "11.3.qrpcWithin30Days": (f) => (b(f, "occupied") && n(f, "days_since_qrpc") <= 30 ? ok : no("no QRPC in the last 30 days on an occupied property (D2-2-10)")),
  "11.5.incomeDocsFresh": (f) => atMost(n(f, "oldest_income_doc_age_days"), b(f, "disaster_impacted") ? 180 : 90, "income document age at completeness (D2-2-05)"),
  // ---- §12 loss mitigation
  "12.1.documentStale": (f) => { const max = b(f, "disaster") ? 180 : 90; const age = n(f, "document_age_days"); return age <= max ? ok : no(`income document is ${age} days old (> ${max}; ${b(f, "disaster") ? "disaster" : "standard"} staleness) — re-request`); },
  "12.8.valuationFresh90": (f) => atMost(n(f, "valuation_age_days"), 90, "valuation age at evaluation (F-1-27: ≤90 days)"),
  "12.8.noTrialFailureWithin12Months": (f) => (s(f, "last_trial_failed_on") === "" || daysBetween(s(f, "last_trial_failed_on") as PlainDate, s(f, "today") as PlainDate) >= 365 ? ok : no(`a trial failed on ${s(f, "last_trial_failed_on")} — no new trial within 12 months (D2-3.2-06)`)),
  "12.9.valuationFresh90": (f) => atMost(n(f, "valuation_age_days"), 90, "valuation age at approval (F-1-14: ≤90 days)"),
  "12.3.reviewerIndependent": (f) => (s(f, "reviewer_id") !== s(f, "evaluator_id") && s(f, "reviewer_run_id") !== s(f, "evaluator_run_id") && !arr<string>(f, "excluded_ids").includes(s(f, "reviewer_id")) ? ok : no("appeal reviewer must be independent of the evaluator, the original approving reviewer, anyone who edited reason codes and a directly involved supervisor (§1024.41(h)(3); 12.3 rule 4 excluded_ids)")),
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
  "12.9.listedFiveConsecutiveDays": (f) => (n(f, "consecutive_days_listed") >= 5 && b(f, "includes_saturday") && b(f, "includes_sunday") ? ok : no(`MLS listing: ${n(f, "consecutive_days_listed")} consecutive days, Saturday ${b(f, "includes_saturday")}, Sunday ${b(f, "includes_sunday")} — needs ≥5 consecutive calendar days including a Saturday and a Sunday (D2-3.3-01)`)),
  "12.9.miWrittenAgreement": (f) => (!b(f, "mi_non_delegated") || b(f, "mi_written_agreement_received") ? ok : no("non-delegated MI needs the insurer's written agreement")),
  // ---- §13 foreclosure
  "13.1.preFilingAppGateOpen": (f) => (!b(f, "complete_app_before_first_notice") || ["ineligible_no_appeal", "appeal_denied", "all_offers_rejected", "agreement_defaulted"].includes(s(f, "exit")) || b(f, "duplicative_41i") ? ok : no("§1024.41(f)(2): a complete application received before the first notice holds the first notice until an (f)(2)(i)–(iii) exit")),
  "13.1.disasterApprovalOnFile": (f) => (!b(f, "disaster_impacted") || s(f, "fnma_disaster_fc_approval_id") ? ok : no("D1-3-01: Fannie Mae prior written approval required before referral/first notice/judgment/sale on a disaster-impacted property")),
  "13.2.dualTrackGateOpen": (f) => (!b(f, "complete_app_after_first_notice") || ["ineligible_notice_no_appeal", "appeal_denied", "all_options_rejected", "trial_failed", "shortsale_window_ended"].includes(s(f, "exit")) ? ok : no("§1024.41(g): no judgment motion, sale scheduling or sale while a complete application received >37 days before sale is pending")),
  "13.2.mnDualTrackGateOpen": (f) => (s(f, "state") !== "MN" || !b(f, "application_pending") ? ok : no("Minn. Stat. §582.043: no referral while an application (complete or not) is pending")),
  "13.2.caDualTrackGateOpen": (f) => (s(f, "state") !== "CA" || !(b(f, "complete_first_lien_application_pending") && b(f, "owner_occupied")) ? ok : no("Cal. Civ. Code §2924.18: no NOD/NOS while a complete first-lien application is pending on an owner-occupied loan")),
  "13.5.methodDeviationApproved": (f) => (b(f, "preferred_method") || s(f, "form20_approval_id") ? ok : no("Allowable Foreclosure Attorney Fees Exhibit: a non-preferred method needs Regional Counsel approval via Form 20 (13.7)")),
  "13.7.environmentalDirectionToProceed": (f) => (!b(f, "environmental_hazard_confirmed") || s(f, "fnma_direction") === "proceed" ? ok : no("F-1-08: no foreclosure on an environmental hazard until Fannie Mae directs the servicer to proceed")),
  "13.7.pleadingDraftGivenInTime": (f) => atLeast(n(f, "business_days_before_deadline_when_given"), 5, "business days Fannie Mae had the draft before the filing deadline (E-1.3-01; policy 5 BD)"),
  "13.7.counselNotifiedOfWorkout": (f) => (!b(f, "litigated") || b(f, "counsel_acknowledged") ? ok : no("E-1.3-01: counsel must acknowledge notice of the workout offer before it leaves on a litigated loan")),
  "13.7.litigationHoldReleased": (f) => (!b(f, "litigation_hold") || ["proceed", "resolved"].includes(s(f, "fnma_direction")) ? ok : no("LITIGATION_HOLD: foreclosure steps wait for Fannie Mae direction or resolution")),
  "13.8.protectionGateOpen": (f) => (!b(f, "active_duty") && (s(f, "protection_ends_on") === "" || s(f, "today") > s(f, "protection_ends_on")) ? ok : b(f, "court_order_at_fnma_direction") || b(f, "section_3918_agreement_reviewed") ? ok : no("50 U.S.C. 3953(c): no sale/seizure during service or the 1-year tail absent a court order or a §3918 agreement")),
  "13.9.feesInsideCap": (f) => (c(f, "fee_cents") === 0n || b(f, "bona_fide_insurance") || b(f, "fee_forgiven_under_cap") ? ok : no("50 U.S.C. 3937(d): fees and charges during the cap count as interest — forgive or refund them")),
  "13.1.preForeclosureReviewPeriodElapsed": (f) => (n(f, "regx_days_delinquent") > 120 || b(f, "non_principal_residence") ? ok : no(`loan is ${n(f, "regx_days_delinquent")} days delinquent; no first notice/filing before day 121 (§1024.41(f)(1); the 1024.30(b) small-servicer exemption never applies — Fannie Mae is the assignee)`)),
  "13.2.trialPerformingNoSale": (f) => (!b(f, "trial_active") || b(f, "trial_defaulted") ? ok : no("borrower is performing under a trial period plan: no foreclosure sale or first notice (§1024.41(g); 2.6)")),
  "13.2.saleAtLeast7DaysAfterMafNotice": (f) => atLeast(daysBetween(s(f, "maf_notified_on") as PlainDate, s(f, "sale_date") as PlainDate), 7, "days from MAF notice to sale (E-3.2-07)"),
  "13.4.breachLetterAndSolicitationExpired": (f) => every(f, ["breach_letter_expired", "solicitation_deadline_expired"], "E-3.2-01 preconditions"),
  "13.4.maCitationSearchCompleted": (f) => (b(f, "ma_lead_paint_citation_search_completed") ? ok : no("MA lead-paint citation search not completed (F-1-08)")),
  "13.4.dmdcCertificateFresh": (f) => atMost(n(f, "dmdc_certificate_age_days"), 30, "DMDC certificate age at referral"),
  "13.6.firmRetainedAndCurrent": (f) => every(f, ["firm_retained_for_state", "lra_executed", "training_done", "eo_unexpired"], "A4-2-01 firm retention"),
  "13.6.fannieMaePriorApproval": (f) => (s(f, "fnma_approval_document_id") ? ok : no("post-sale matter transfer needs Fannie Mae prior approval (E-1.1-01)")),
  "13.7.fannieMaePriorWrittenApproval": (f) => (s(f, "fnma_written_approval_document_id") ? ok : no("removal/appeal needs Fannie Mae prior written approval (E-1.3-01)")),
  "13.8.affidavitOnFreshCertificates": (f) => (n(f, "certificate_age_days") <= 30 && s(f, "executed_by_role") === "signing_officer" && b(f, "filed") ? ok : no("SCRA affidavit needs ≤30-day certificates, a signing_officer execution and filing")),
  // ---- §14–§19
  "14.2.noB4MotionBeforeDueDate": (f) => (b(f, "b4_motion_docketed") ? no(`Rule 3002.1(b)(4) motion docketed ${s(f, "b4_motion_docketed_on")}: hold the payment at the old amount until the court's order`) : ok),
  "14.4.reaffirmationFinal": (f) => { const filed = s(f, "reaffirmation_filed_on"), disc = s(f, "discharge_on"); if (!filed) return no("no reaffirmation filed"); const a = addDays(filed as PlainDate, 60), d = disc ? addDays(disc as PlainDate, 60) : a; const fin = a > d ? a : d; return s(f, "today") > fin && !b(f, "rescinded") ? ok : no(`reaffirmation not final until ${fin} (§524(c)(4): later of 60 days after filing or discharge)`); },
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
  // ---- per-section maps (§14–§19 build their gates in src/domain/<section>/evaluators.ts)
  ...SECTION_14_EVALUATORS, ...SECTION_15_EVALUATORS, ...SECTION_16_EVALUATORS, ...SECTION_17_EVALUATORS, ...SECTION_18_EVALUATORS, ...SECTION_19_EVALUATORS,
  // ---- §1–§13 process-owned maps (spread last: a key here supersedes the inline definition above)
  ...EVALUATORS_1_1, ...EVALUATORS_1_2, ...EVALUATORS_1_3, ...EVALUATORS_1_4, ...EVALUATORS_1_5, ...EVALUATORS_1_6, ...EVALUATORS_1_7, ...EVALUATORS_2_1, ...EVALUATORS_2_2, ...EVALUATORS_2_3, ...EVALUATORS_2_4, ...EVALUATORS_2_5, ...EVALUATORS_2_6, ...EVALUATORS_2_7, ...EVALUATORS_3_1, ...EVALUATORS_3_2, ...EVALUATORS_3_3, ...EVALUATORS_3_4, ...EVALUATORS_3_5, ...EVALUATORS_3_6, ...EVALUATORS_3_7, ...EVALUATORS_3_8, ...EVALUATORS_3_9, ...EVALUATORS_4_1, ...EVALUATORS_4_2, ...EVALUATORS_4_3, ...EVALUATORS_4_4, ...EVALUATORS_4_5, ...EVALUATORS_5_1, ...EVALUATORS_5_2, ...EVALUATORS_5_3, ...EVALUATORS_5_4, ...EVALUATORS_5_5, ...EVALUATORS_5_6, ...EVALUATORS_5_7, ...EVALUATORS_6_1, ...EVALUATORS_6_2, ...EVALUATORS_6_3, ...EVALUATORS_6_4, ...EVALUATORS_6_5, ...EVALUATORS_7_1, ...EVALUATORS_7_2, ...EVALUATORS_7_3, ...EVALUATORS_7_4, ...EVALUATORS_7_5, ...EVALUATORS_7_6, ...EVALUATORS_8_1, ...EVALUATORS_8_2, ...EVALUATORS_8_3, ...EVALUATORS_9_1, ...EVALUATORS_9_2, ...EVALUATORS_9_3, ...EVALUATORS_9_4, ...EVALUATORS_9_5, ...EVALUATORS_9_6, ...EVALUATORS_9_7, ...EVALUATORS_9_8, ...EVALUATORS_9_9, ...EVALUATORS_10_1, ...EVALUATORS_10_2, ...EVALUATORS_10_3, ...EVALUATORS_10_4, ...EVALUATORS_10_5, ...EVALUATORS_10_6, ...EVALUATORS_11_1, ...EVALUATORS_11_2, ...EVALUATORS_11_3, ...EVALUATORS_11_4, ...EVALUATORS_11_5, ...EVALUATORS_12_1, ...EVALUATORS_12_2, ...EVALUATORS_12_3, ...EVALUATORS_12_4, ...EVALUATORS_12_5, ...EVALUATORS_12_6, ...EVALUATORS_12_7, ...EVALUATORS_12_8, ...EVALUATORS_12_9, ...EVALUATORS_13_1, ...EVALUATORS_13_2, ...EVALUATORS_13_3, ...EVALUATORS_13_4, ...EVALUATORS_13_5, ...EVALUATORS_13_6, ...EVALUATORS_13_7, ...EVALUATORS_13_8, ...EVALUATORS_13_9,
  ...EVALUATORS_20_1, ...EVALUATORS_20_2, ...EVALUATORS_20_3, ...EVALUATORS_20_4, ...EVALUATORS_21_1, ...EVALUATORS_21_2, ...EVALUATORS_21_3, ...EVALUATORS_21_4, ...EVALUATORS_21_5, ...EVALUATORS_21_6, ...EVALUATORS_22_1, ...EVALUATORS_22_2, ...EVALUATORS_22_3, ...EVALUATORS_22_4, ...EVALUATORS_22_5, ...EVALUATORS_22_6, ...EVALUATORS_23_1, ...EVALUATORS_23_2, ...EVALUATORS_23_3, ...EVALUATORS_23_4, ...EVALUATORS_24_1, ...EVALUATORS_24_2, ...EVALUATORS_24_3, ...EVALUATORS_24_4, ...EVALUATORS_24_5, ...EVALUATORS_24_6, ...EVALUATORS_25_1, ...EVALUATORS_25_2, ...EVALUATORS_25_3, ...EVALUATORS_25_4, ...EVALUATORS_26_1, ...EVALUATORS_26_2, ...EVALUATORS_26_3, ...EVALUATORS_26_4, ...EVALUATORS_27_1, ...EVALUATORS_27_2, ...EVALUATORS_28_1, ...EVALUATORS_28_2, ...EVALUATORS_28_3, ...EVALUATORS_28_4, ...EVALUATORS_29_1, ...EVALUATORS_29_2, ...EVALUATORS_29_3, ...EVALUATORS_29_4, ...EVALUATORS_30_1, ...EVALUATORS_30_2, ...EVALUATORS_30_3, ...EVALUATORS_30_4, ...EVALUATORS_31_1, ...EVALUATORS_31_2, ...EVALUATORS_31_3,
  ...EVALUATORS_32_1, ...EVALUATORS_32_2, ...EVALUATORS_32_3, ...EVALUATORS_32_4, ...EVALUATORS_32_5, ...EVALUATORS_32_6, ...EVALUATORS_32_7, ...EVALUATORS_32_8, ...EVALUATORS_32_9, ...EVALUATORS_32_10, ...EVALUATORS_32_11, ...EVALUATORS_32_12, ...EVALUATORS_32_13,
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
