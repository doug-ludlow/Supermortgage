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
}
