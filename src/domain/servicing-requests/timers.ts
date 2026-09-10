/**
 * Registry overrides for Section 4 (servicing requests) timers whose spec
 * rows are prose. Each override cites the row it encodes.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyServicingRequestTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 4.1 notices of error -----------------------------------------------
  o("NY_419_6_NOE_FC_RESPONSE_15BD", { trigger: "`case.noe.opened{state=NY, foreclosure_assertion=true}`", anchorField: "noe_fc_response_due", offset: "0",
    why: "§4.1 timer table: 'as FC timer'; due = min(15 `business_days_servicer`, sale − 1) computed by `4.1.noeForeclosureDue` (3 NYCRR 419.6)." });
  o("REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30", { anchorField: "noe_fc_response_due", offset: "0",
    why: "§4.1 timer table: min(30 `business_days_federal`, `foreclosure_sale_date − 1 calendar day`), recomputed on `foreclosure.sale.rescheduled` (§1024.35(e)(3)(i)(C))." });
  o("REGX_1024_35F2_FC_GOODFAITH_RESPONSE", { trigger: "`case.noe.opened{foreclosure_assertion=true, days_before_sale<=7}`", anchorField: "foreclosure_sale_at", offset: "0",
    why: "§4.1 timer table: NOE (b9/b10) received ≤7 calendar days before sale → good-faith response before sale date/time (§1024.35(f)(2))." });
  // ---- 4.2 requests for information ---------------------------------------
  o("NY_419_6_RFI_DOCS_15BD", { trigger: "`case.rfi.opened{state=NY, kind=document_request}`", why: "§4.2 timer table: document requests +15 `business_days_servicer` (3 NYCRR 419.6)." });
  o("NY_419_6_RFI_OWNER_10D", { trigger: "`case.rfi.opened{state=NY, kind=owner_identity}`", why: "§4.2 timer table: 'as owner timer'; 419.6 says '10 days' → 10 calendar days from receipt." });
  // ---- 4.3 continuity of contact ------------------------------------------
  o("FNMA_A4_2_1_04_CHAT_5MIN", { trigger: "`chat.session.started`", why: "§4.3 timer table: chat session start → first response within 5 minutes (A4-2.1-04)." });
  o("REGX_1024_40A1_CONTACT_ASSIGN_45", { trigger: "`loan.delinquency.started{principal_residence=true}`", offset: "+44 calendar_days, 23:59 loan-local",
    why: "§4.3 timer table: day 45 = day-1 date + 44 `calendar_days` (23:59 loan-local) (§1024.40(a)(1))." });
  // ---- 4.5 complaints ------------------------------------------------------
  o("CFPB_CONSUMER_FEEDBACK_60", { trigger: "`regulator.complaint.responded{portal=cfpb}`", why: "§4.5 timer table: portal response → consumer feedback window 60 calendar days." });
  o("CFPB_PORTAL_FINAL_60", { trigger: "`regulator.complaint.responded{portal=cfpb, status=in_progress}`", anchorField: "received_at",
    why: "§4.5 timer table: when 'in progress' used, final portal response 60 calendar days from `received_at`." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("SM_RFI_SII_DOCS_TARGET_5", { trigger: "`case.rfi.opened{is_potential_successor_request=true}`", why: "§4.2 timer table: 'same' as REGX_1024_36I_SII_RFI_RESPONSE_30 → `case.rfi.opened{is_potential_successor_request}`; 5 federal BD target." });
  o("FNMA_A4_2_1_04_CALL_METRICS_MONTHLY", { trigger: "`period.month_end`", why: "§4.3 timer table: month-end → monthly call metrics (A4-2.1-04)." });
  o("REGX_1024_32C_SII_DISCLOSURE_HOLD", { trigger: "`notice.sent{template=NTC_REGX_32C_SII_ACK}`", offset: "until case.sii.confirmed", why: "§4.4 timer table: acknowledgment sent → disclosure hold until acknowledgment returned or assumption (§1024.32(c))." });
  o("NY_419_6_COMPLAINT_RESPONSE_30BD", { trigger: "`case.complaint.opened{state=NY}`", anchorField: "ny_response_due", offset: "0", why: "§4.5 timer table: 'same' as NY_419_6_COMPLAINT_ACK_5BD; 30 / 15 (or before sale) / 7 / +7 `business_days_servicer` by category — computed by `4.5.nyComplaintResponseDue` (3 NYCRR 419.6)." });

  // ---- satisfaction: rows whose `satisfied` column is prose get the event the domain emits ----------
  o("REGX_1024_35E_FC_NOE_OPEN", { satisfied: "`case.noe.responded`", why: "§4.1 timer table: gate until `case.noe.responded` (b9/b10)." });
  o("REGX_1024_35F2_FC_GOODFAITH_RESPONSE", { satisfied: "`case.noe.goodfaith_responded`", why: "§4.1 timer table: `contact` with any mode + `case.noe.goodfaith_responded`." });
  o("REGX_1024_35I_CREDIT_SUPPRESS_60", { satisfied: "`credit_reporting.suppression.expired`", why: "§4.1 timer table: 'expiry' of the 60-day suppression (8.1 emits it)." });
  o("SM_RFI_SII_DOCS_TARGET_5", { satisfied: "`notice.sent{template=NTC_REGX_36I_SII_DOCS}`", why: "§4.2 timer table: 'same' as REGX_1024_36I_SII_RFI_RESPONSE_30 — the §1024.36(i) document-description notice." });
  o("NY_419_6_RFI_OWNER_10D", { satisfied: "`notice.sent{template=NTC_REGX_36A2_OWNER_IDENTITY}`", why: "§4.2 timer table: 'same' as the owner timer — the owner-identity answer." });
  o("NY_419_6_RFI_DOCS_15BD", { satisfied: "`notice.sent{template=NTC_REGX_36D_RESPONSE}`", why: "§4.2 timer table: 'documents sent'." });
  o("SM_RFI_INTERNAL_TARGET_7", { satisfied: "`case.rfi.responded`", why: "§4.2 timer table: 'responded' (policy target)." });
  o("REGX_1024_40A2_AVAILABILITY_UNTIL_RELEASE", { satisfied: "`continuity.availability.checked{staffed=true}`", why: "§4.3 timer table: daily check that an active team with staffed hours is reachable; recurring." });
  o("REGX_1024_40A3_LIVE_RESPONSE_1BD", { satisfied: "`contact.logged{live_contact=true, by_assigned_personnel=true}`", why: "§4.3 timer table: `contact` with `live_contact=true` by assigned personnel." });
  o("CA_CIV_2923_7_SPOC_UNTIL_EXHAUSTED_OR_CURRENT", { satisfied: "`continuity.ca_spoc.released{reason∈{options_exhausted, current}}`", why: "§4.3 timer table: 'release' when options are exhausted or the account is current (Cal. Civ. Code 2923.7)." });
  o("FNMA_A4_2_1_04_EMAIL_48H", { satisfied: "`communication.outbound.sent{channel=email, reply=true}`", why: "§4.3/4.5 timer table: 'reply sent' within 48 hours (A4-2.1-04)." });
  o("FNMA_A4_2_1_04_CHAT_5MIN", { satisfied: "`chat.first_response.sent`", why: "§4.3 timer table: 'first response' within 5 minutes." });
  o("FNMA_A4_2_1_04_CALL_METRICS_MONTHLY", { satisfied: "`report.produced{report=a4_2_1_04_call_metrics}`", why: "§4.3 timer table: the monthly metrics report (ASA ≤ 60s, blockage ≤ 1%, abandonment ≤ 5%)." });
  o("REGX_1024_38B1VI_SII_FACILITATE_2", { satisfied: "`contact.logged{purpose=sii_facilitate}`", why: "§4.4 timer table: outreach `contact` or letter to the known contact/estate." });
  o("FNMA_D1_4_1_02_INTERESTED_PARTY_NOTIFY_10", { satisfied: "`sii.interested_parties.notified`", why: "§4.4 timer table: insurer/tax/MI/HOA notifications logged." });
  o("FNMA_D1_4_1_02_FNMA_LEGAL_60", { satisfied: "`fnma.due_on_transfer.resolved{outcome∈{non_objection, expired}}`", why: "§4.4 timer table: Fannie Mae non-objection or expiry." });
  o("SM_COMPLAINT_ACK_1BD", { satisfied: "`case.complaint.acknowledged`", why: "§4.5 timer table: acknowledgment by any channel (written for written complaints)." });
  o("CFPB_PORTAL_RESPONSE_15", { satisfied: "`regulator.complaint.responded{portal=cfpb}`", why: "§4.5 timer table: portal response submitted (closed or in progress)." });
  o("CFPB_PORTAL_FINAL_60", { satisfied: "`regulator.complaint.responded{portal=cfpb, status=closed}`", why: "§4.5 timer table: final portal response." });
  o("NY_419_6_COMPLAINT_ACK_5BD", { satisfied: "`notice.sent{template=NTC_COMPLAINT_ACK}`", why: "§4.5 timer table: written acknowledgment (NY 419.6)." });
  o("NY_419_6_COMPLAINT_RESPONSE_30BD", { satisfied: "`notice.sent{template=NTC_COMPLAINT_RESPONSE}`", why: "§4.5 timer table: written response." });
  o("TX_50A6_CURE_60", { satisfied: "`complaint.tx_50a6.cured`", why: "§4.5 timer table: cure executed + Form 20 escalation logged." });
  o("FNMA_REFERRAL_RESPONSE_5BD", { satisfied: "`investor.referral.responded`", why: "§4.5 timer table: response to Fannie Mae." });
  o("SM_UDAAP_REVIEW_10BD", { satisfied: "`udaap_review.closed{outcome∈{finding, no_finding}}`", why: "§4.5 timer table: finding/no-finding record." });
  o("SM_POPULATION_REMEDIATION_60", { satisfied: "`population_remediation.executed`", why: "§4.5 timer table: remediation executed." });
  o("CFPB_CONSUMER_FEEDBACK_60", { satisfied: "`regulator.consumer_feedback.window_closed`", why: "§4.5 timer table: informational 60-day consumer feedback window after the portal response." });
}
