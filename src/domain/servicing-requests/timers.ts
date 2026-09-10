/**
 * Registry overrides for Section 4 (servicing requests) timers whose spec
 * rows are prose. Each override cites the row it encodes. One `o()` call per
 * code: `TimerRegistry.override` rebuilds the parsed def from the raw columns,
 * so computed anchors are given as the raw `anchor` column (not `anchorField`)
 * and trigger/anchor/offset/satisfied for a code are merged into a single call —
 * a later satisfied-only call would otherwise reset the anchor to the
 * registry's `receipt_date`/`received` column.
 *
 * Satisfaction is template-qualified: a row the spec satisfies by "`notice.sent`
 * (`NTC_X`)" is satisfied only by `notice.sent{template=NTC_X}` — the Notice
 * Registry emits `template` on every `notice.sent` — never by any notice on the
 * loan. Rows the spec satisfies per assertion/item ("for the b6 assertion",
 * "(owner item)") match the qualifiers `case.noe.responded` / `case.rfi.responded`
 * carry (cases.noeRespondedPayload / rfiRespondedPayload): `payoff_assertion`,
 * `std_assertion`, `foreclosure_assertion`, `owner_identity_item`, `std_item`,
 * `complete`.
 *
 * Payload contract (src/domain/servicing-requests/cases.ts): `case.noe.opened`
 * carries the per-profile qualifiers `payoff_assertion` / `foreclosure_assertion`
 * / `fc_response_assertion` (a b9/b10 assertion on the sale-or-30 clock) /
 * `goodfaith_assertion` (a b9/b10 assertion on the §1024.35(f)(2) path) /
 * `std_assertion` / `payment_related` / `ack_required`, `days_before_sale`, and
 * the computed anchors `noe_fc_response_due` (noe.noeForeclosureDue),
 * `ny_noe_fc_response_due` (ops.nyNoeDeadline) and `foreclosure_sale_date`;
 * `case.rfi.opened` carries `owner_identity_item` / `std_item` /
 * `document_request_item` / `is_potential_successor_request` and the computed
 * `sii_docs_due`; the SII events carry the halved-when-`lossmit_pending` policy
 * anchors `facilitate_due` / `docs_description_due` / `determination_due` /
 * `addl_docs_due` (cases.siiPolicyDue); `case.complaint.opened` carries `state`,
 * `received`, `received_at` and `ny_response_due` (complaints.nyDeadlines).
 *
 * The "+15 on `case.noe.extended`" / "+15 on `case.rfi.extended`" offsets of the
 * 30-day response rows are applied by the extend commands (tools/section04
 * reanchorDeadline): the open instance is closed as extended and a new one is
 * armed on the event's `federal_new_due`, so the timer history shows both dates.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyServicingRequestTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 4.1 notices of error -----------------------------------------------
  // Profile-specific rows: the registry's trigger prose ("with any `b6` assertion", "(b9/b10)", "with profile `std_30`",
  // "(any payment-related assertion)") is a qualifier the column grammar drops, so every NoE armed every profile clock.
  o("REGX_1024_35D_NOE_ACK_5", { trigger: "`case.noe.opened{ack_required=true}`", satisfied: "`notice.sent{template∈{NTC_REGX_35D_ACK, NTC_REGX_35F1_EARLY_CORRECTION, NTC_REGX_35G2_EXCEPTION}}`",
    why: "§4.1 timer table: `case.noe.opened` → 5 `business_days_federal`; §1024.35(f)(2): (d) does not apply to a (b)(9)/(10) notice received ≤7 days before the sale (4.1-T5 'no ack timer'), so the payload's `ack_required` is false only on that path. Satisfied by the ack itself (`NTC_REGX_35D_ACK`) or, per the row's 'or `case.noe.early_corrected` or `case.noe.exception_noticed`', by the (f)(1) early-correction letter or the (g)(2) exception notice that constitutes those events; the early-correction command also cancels it with reason `early_correction` (4.1-T11)." });
  o("REGX_1024_35E_NOE_RESPONSE_30", { trigger: "`case.noe.opened{std_assertion=true}`", satisfied: "`case.noe.responded{std_assertion=true}`",
    why: "§4.1 timer table: `case.noe.opened` with profile `std_30` — only a std_30 assertion carries the 30-federal-BD clock (§1024.35(e)(3)(i)(C)); satisfied by the response covering a std_30 assertion (rule 3: profiles are per assertion). '+15 on `case.noe.extended`': the extend command re-anchors the open instance on `federal_new_due`." });
  o("REGX_1024_35E_NOE_EXT_NOTICE_BEFORE_30", { trigger: "`case.noe.opened{std_assertion=true}`", satisfied: "`notice.sent{template=NTC_REGX_35E_EXTENSION}`",
    why: "§4.1 timer table: `case.noe.opened` (`std_30`) — the extension notice gate exists only for the extendable profile (§1024.35(e)(3)(ii)); satisfied by `notice.sent` (`NTC_REGX_35E_EXTENSION`) only." });
  o("REGX_1024_35E_NOE_PAYOFF_RESPONSE_7", { trigger: "`case.noe.opened{payoff_assertion=true}`", satisfied: "`case.noe.responded{payoff_assertion=true}`",
    why: "§4.1 timer table: `case.noe.opened` with any `b6` assertion → 7 `business_days_federal` (§1024.35(e)(3)(i)(A)); satisfied by '`case.noe.responded` for the b6 assertion'." });
  o("REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30", { trigger: "`case.noe.opened{fc_response_assertion=true}`", anchor: "`noe_fc_response_due`", offset: "0", satisfied: "`case.noe.responded{foreclosure_assertion=true}`",
    why: "§4.1 timer table: `case.noe.opened` with any `b9`/`b10` assertion on the (e) clock; due = min(30 `business_days_federal`, `foreclosure_sale_date − 1 calendar day`) computed by noe.noeForeclosureDue into the payload field `noe_fc_response_due` (case.noe.open command), recomputed on `foreclosure.sale.rescheduled` (case.noe.sale.reschedule re-anchors the open instance) (§1024.35(e)(3)(i)(B); comment 35(e)(3)(i)-1). §1024.35(f)(2): (e) does not apply to a (b)(9)/(10) notice received ≤7 days before the sale, so `fc_response_assertion` is false on the good-faith path." });
  o("REGX_1024_35E_FC_NOE_OPEN", { trigger: "`case.noe.opened{foreclosure_assertion=true}`", satisfied: "`case.noe.responded{foreclosure_assertion=true}`",
    why: "§4.1 timer table: `case.noe.opened` (b9/b10) → gate until `case.noe.responded` for the foreclosure assertion; `foreclosure.sale.conduct` / `foreclosure.judgment.motion` assert it open (tools/section04 FC_NOE_OPEN_GATE); block + attorney escalation." });
  o("REGX_1024_35F2_FC_GOODFAITH_RESPONSE", { trigger: "`case.noe.opened{goodfaith_assertion=true}`", anchor: "`foreclosure_sale_date`", offset: "−1 calendar_days", satisfied: "`case.noe.goodfaith_responded`",
    why: "§4.1 timer table: NoE (b9/b10) received ≤7 calendar days before sale (profile `fc_within_7_days_goodfaith`) → good-faith response before the sale date/time; anchored on the sale date, due the day before (end of day ET) — never later than the sale (§1024.35(f)(2)); satisfied by the logged `contact` + `case.noe.goodfaith_responded`." });
  o("REGX_1024_35E4_NOE_DOCS_15", { anchor: "`requested_on`", satisfied: "`notice.sent{template∈{NTC_REGX_35E4_DOCS, NTC_REGX_35E4_WITHHELD}}`",
    why: "§4.1 timer table: `case.noe.document_copies.requested` (case.noe.documents.request command) → 15 `business_days_federal` from the request date; satisfied by the copies or the written withholding notice (§1024.35(e)(4))." });
  o("REGX_1024_35F1_NOE_EARLY_CORRECTION_5", { satisfied: "`notice.sent{template=NTC_REGX_35F1_EARLY_CORRECTION}`",
    why: "§4.1 timer table: `case.noe.early_correction.started` (case.noe.early_correction.start command; payload `receipt_date`) → 5 `business_days_federal` from receipt; satisfied by the (f)(1) letter; on breach the std path continues (the ack/response clocks were never cancelled)." });
  o("REGX_1024_35G2_NOE_EXCEPTION_NOTICE_5", { anchor: "`determination_date`", satisfied: "`notice.sent{template=NTC_REGX_35G2_EXCEPTION}`",
    why: "§4.1 timer table: `case.noe.exception_determined` (payload `determination_date`) → 5 `business_days_federal` from the determination; satisfied by the (g)(2) notice (§1024.35(g)(2))." });
  o("REGX_1024_35I_CREDIT_SUPPRESS_60", { trigger: "`case.noe.opened{payment_related=true}`", satisfied: "`credit_reporting.suppression.expired`",
    why: "§4.1 timer table: `case.noe.opened` (any payment-related assertion: b1–b3, b5, b11) → 60 `calendar_days`; satisfied by 'expiry' — ops.expireCreditSuppressions emits `credit_reporting.suppression.expired` when `ends_at` passes (§1024.35(i)(1))." });
  o("NY_419_6_NOE_FC_RESPONSE_15BD", { trigger: "`case.noe.opened{state=NY, fc_response_assertion=true}`", anchor: "`ny_noe_fc_response_due`", offset: "0", satisfied: "`case.noe.responded{foreclosure_assertion=true}`",
    why: "§4.1 timer table: 'as FC timer' (NY loans); due = min(15 `business_days_servicer`, sale − 1) computed by ops.nyNoeDeadline into the payload field `ny_noe_fc_response_due` (3 NYCRR 419.6)." });
  o("NY_419_6_NOE_EXTENSION_7BD", { trigger: "`case.noe.extended{state=NY}`", anchor: "`original_due`", satisfied: "`case.noe.responded{std_assertion=true}`",
    why: "§4.1 timer table: `case.noe.extended` on a NY loan → original due +7 `business_days_servicer` instead of +15 (3 NYCRR 419.6); the case.noe.extend command emits `original_due`; satisfied by the response covering the extended std_30 assertion." });
  o("SM_NOE_INTERNAL_TARGET_10", { trigger: "`case.noe.opened{ack_required=true}`", satisfied: "`case.noe.responded{complete=true}`",
    why: "§4.1 timer table: policy target 10 `business_days_federal` from receipt; not armed on the §1024.35(f)(2) good-faith path where (d)/(e) do not apply; satisfied when every assertion has been responded to." });
  // ---- 4.2 requests for information ---------------------------------------
  o("REGX_1024_36C_RFI_ACK_5", { satisfied: "`notice.sent{template∈{NTC_REGX_36C_ACK, NTC_REGX_36E_EARLY, NTC_REGX_36F2_EXCEPTION, NTC_REGX_36I_SII_DOCS}}`",
    why: "§4.2 timer table: `case.rfi.opened` → 5 `business_days_federal`; satisfied by `notice.sent` (`NTC_REGX_36C_ACK`) 'or early response or exception notice' — and per the 4.4 row 'ack or the docs notice itself (early response, §1024.36(e))'. The early-response command also cancels it with reason `early_response` (4.2-T11)." });
  o("REGX_1024_36D_RFI_OWNER_10", { trigger: "`case.rfi.opened{owner_identity_item=true}`", satisfied: "`case.rfi.responded{owner_identity_item=true}`",
    why: "§4.2 timer table: `case.rfi.opened` with an `owner_identity` item → 10 `business_days_federal` (§1024.36(d)(2)(i)(A)); satisfied by '`case.rfi.responded` (owner item)'." });
  o("REGX_1024_36D_RFI_RESPONSE_30", { trigger: "`case.rfi.opened{std_item=true}`", satisfied: "`case.rfi.responded{std_item=true}`",
    why: "§4.2 timer table: `case.rfi.opened` (`std_30`) — a letter with only an owner-identity item carries no 30-day clock; satisfied by the response covering a std_30 item. '+15 on `case.rfi.extended`': the extend command re-anchors the open instance on `federal_new_due`." });
  o("REGX_1024_36D_RFI_EXT_NOTICE_BEFORE_30", { trigger: "`case.rfi.opened{std_item=true}`", satisfied: "`notice.sent{template=NTC_REGX_36D_EXTENSION}`",
    why: "§4.2 timer table: `case.rfi.opened` (`std_30`) → extension notice before day 30 (§1024.36(d)(2)(ii)); satisfied by `notice.sent` (`NTC_REGX_36D_EXTENSION`) only." });
  o("REGX_1024_36E_RFI_EARLY_RESPONSE_5", { satisfied: "`notice.sent{template=NTC_REGX_36E_EARLY}`",
    why: "§4.2 timer table: `case.rfi.early_response.started` (rfi.early_response.start command; payload `receipt_date`) → 5 `business_days_federal` from receipt; satisfied by the §1024.36(e) letter; on breach the std path continues." });
  o("REGX_1024_36F2_RFI_EXCEPTION_NOTICE_5", { anchor: "`determination_date`", satisfied: "`notice.sent{template=NTC_REGX_36F2_EXCEPTION}`",
    why: "§4.2 timer table: `case.rfi.exception_determined` (payload `determination_date`) → 5 `business_days_federal` from the determination; satisfied by the (f)(2) notice." });
  o("REGX_1024_36I_SII_RFI_RESPONSE_30", { trigger: "`case.rfi.opened{is_potential_successor_request=true}`", anchor: "`sii_docs_due`", offset: "0", satisfied: "`notice.sent{template=NTC_REGX_36I_SII_DOCS}`",
    why: "§4.2 timer table: `case.rfi.opened` with `is_potential_successor_request` → the §1024.36(i) document description within 30 `business_days_federal` (10 if the request also asks owner identity), computed by cases.rfiOpenedPayload into `sii_docs_due`; satisfied by `notice.sent` (`NTC_REGX_36I_SII_DOCS`)." });
  o("SM_RFI_SII_DOCS_TARGET_5", { trigger: "`case.rfi.opened{is_potential_successor_request=true}`", satisfied: "`notice.sent{template=NTC_REGX_36I_SII_DOCS}`", why: "§4.2 timer table: 'same' as REGX_1024_36I_SII_RFI_RESPONSE_30 → `case.rfi.opened{is_potential_successor_request}`; 5 federal BD policy target; satisfied by the §1024.36(i) document-description notice." });
  o("NY_419_6_RFI_OWNER_10D", { trigger: "`case.rfi.opened{state=NY, owner_identity_item=true}`", satisfied: "`notice.sent{template=NTC_REGX_36A2_OWNER_IDENTITY}`", why: "§4.2 timer table: 'as owner timer' (NY); 419.6 says '10 days' → 10 calendar days from receipt; satisfied by the owner-identity answer." });
  o("NY_419_6_RFI_DOCS_15BD", { trigger: "`case.rfi.opened{state=NY, document_request_item=true}`", satisfied: "`notice.sent{template=NTC_REGX_36D_RESPONSE}`", why: "§4.2 timer table: document requests (NY) +15 `business_days_servicer`; satisfied by 'documents sent' (3 NYCRR 419.6)." });
  o("SM_RFI_INTERNAL_TARGET_7", { satisfied: "`case.rfi.responded{complete=true}`", why: "§4.2 timer table: 'responded' (policy target) — every item answered." });
  // ---- 4.3 continuity of contact ------------------------------------------
  o("FNMA_A4_2_1_04_CHAT_5MIN", { trigger: "`chat.session.started`", satisfied: "`chat.first_response.sent`", why: "§4.3 timer table: chat session start → first response within 5 minutes (A4-2.1-04)." });
  o("REGX_1024_40A1_CONTACT_ASSIGN_45", { trigger: "`loan.delinquency.started{principal_residence=true}`", offset: "+44 calendar_days, 23:59 loan-local",
    why: "§4.3 timer table: day 45 = day-1 date + 44 `calendar_days` (23:59 loan-local); principal-residence loans only (§1024.40(a)(1); §1024.30(c)(2)); satisfied by `continuity.assigned` (continuity.assign command / the 11.2 auto-assign)." });
  o("CA_CIV_2923_7_SPOC_ASSIGN_PROMPT", { trigger: "`lossmit.assistance.requested{state=CA, s2924_15=true}`", satisfied: "`continuity.ca_spoc_assigned{direct_means_sent=true}`",
    why: "§4.3 timer table: `lossmit.assistance.requested` (CA, §2924.15 loan) → SPOC within 2 `business_days_servicer` (Cal. Civ. Code §2923.7(a)); satisfied by '`continuity.ca_spoc_assigned` with a direct means of communication sent' (continuity.ca_spoc.assign command)." });
  o("REGX_1024_40A2_AVAILABILITY_UNTIL_RELEASE", { satisfied: "`continuity.availability.checked{staffed=true}`", why: "§4.3 timer table: daily check that an active team with staffed hours is reachable (continuity.availability.check command); recurring." });
  o("REGX_1024_40A3_LIVE_RESPONSE_1BD", { satisfied: "`contact.logged{live_contact=true, by_assigned_personnel=true}`", why: "§4.3 timer table: `contact` with `live_contact=true` by assigned personnel (contact.log tool)." });
  o("CA_CIV_2923_7_SPOC_UNTIL_EXHAUSTED_OR_CURRENT", { satisfied: "`continuity.ca_spoc.released{reason∈{options_exhausted, current}}`", why: "§4.3 timer table: 'release' when options are exhausted or the account is current (Cal. Civ. Code 2923.7(c)); continuity.ca_spoc.release refuses any other reason." });
  o("FNMA_A4_2_1_04_EMAIL_48H", { trigger: "`communication.inbound.received{channel=email}`", satisfied: "`communication.outbound.sent{channel=email, reply=true}`", why: "§4.3/4.5 timer table: inbound email → 'reply sent' within 48 hours (A4-2.1-04)." });
  o("FNMA_A4_2_1_04_CALL_METRICS_MONTHLY", { trigger: "`period.month_end`", satisfied: "`report.produced{report=a4_2_1_04_call_metrics}`", why: "§4.3 timer table: month-end → the monthly metrics report (ASA ≤ 60s, blockage ≤ 1%, abandonment ≤ 5%) (A4-2.1-04)." });
  // ---- 4.4 successor in interest ------------------------------------------
  o("REGX_1024_38B1VI_SII_FACILITATE_2", { anchor: "`facilitate_due`", offset: "0", satisfied: "`contact.logged{purpose=sii_facilitate}`",
    why: "§4.4 timer table: `case.sii.opened` (death/transfer notice; sii.open command) → outreach `contact` or letter to the known contact/estate within 2 `business_days_federal` of the notice date — 1 when `lossmit_pending` (state machine: the flag shortens every policy timer; comment 38(b)(1)(vi)-5), computed into `facilitate_due`; satisfied by the sii.facilitate contact." });
  o("REGX_1024_38B1VI_SII_DOCS_DESC_5", { anchor: "`docs_description_due`", offset: "0", satisfied: "`notice.sent{template∈{NTC_REGX_38B1VI_SII_DOCS, NTC_REGX_36I_SII_DOCS}}`",
    why: "§4.4 timer table: `case.sii.potential_successor.identified` (sii.potential_successor.identify command; rfi.open on a §1024.36(i) request) → 5 `business_days_federal` (2 if `lossmit_pending`) from the identification date, computed into `docs_description_due` (4.4-T8); satisfied by `notice.sent` (`NTC_REGX_38B1VI_SII_DOCS`, or the §1024.36(i) `NTC_REGX_36I_SII_DOCS` answer on the written-request path — 'the docs notice itself')." });
  o("REGX_1024_38B1VI_SII_CONFIRM_10", { trigger: "`case.sii.documents.received{sufficient=true}`", anchor: "`determination_due`", offset: "0",
    why: "§4.4 timer table: `case.sii.documents.received` (all required; sii.documents.receive command) → determination within 10 `business_days_federal` (5 if `lossmit_pending`) of the receipt date, computed into `determination_due`; satisfied by `case.sii.determined`." });
  o("REGX_1024_38B1VI_SII_ADDL_DOCS_5", { trigger: "`case.sii.documents.received{sufficient=false}`", anchor: "`addl_docs_due`", offset: "0", satisfied: "`notice.sent{template=NTC_REGX_38B1VI_SII_ADDL_DOCS}`",
    why: "§4.4 timer table: `case.sii.documents.received` (insufficient) → the additional-documents letter within 5 `business_days_federal` (2 if `lossmit_pending` — every policy timer halves), computed into `addl_docs_due`; satisfied by `notice.sent` (`NTC_REGX_38B1VI_SII_ADDL_DOCS`)." });
  o("REGX_1024_38B1VI_SII_LOSSMIT_INTERFERENCE", { trigger: "`lossmit.application.received{potential_successor=true}`",
    why: "§4.4 timer table: `lossmit.application.received` from a potential successor (sii.lossmit.pending command) → gate until `case.sii.determined`; a borrower's own 12.1 intake (4.3 lossmit.intake.start) does not open it." });
  o("REGX_1024_32C_SII_ACK_NOTICE_SAME_DAY", { trigger: "`case.sii.confirmed{non_obligor=true}`", satisfied: "`notice.sent{template=NTC_REGX_32C_SII_ACK}`",
    why: "§4.4 timer table: `case.sii.confirmed` (non-obligor successor) → the §1024.32(c) notice in the same mailing as the confirmation; satisfied by `notice.sent` (`NTC_REGX_32C_SII_ACK`) only." });
  o("REGX_1024_32C_SII_DISCLOSURE_HOLD", { trigger: "`notice.sent{template=NTC_REGX_32C_SII_ACK}`", offset: "until `case.sii.acknowledgment.returned`",
    why: "§4.4 timer table: acknowledgment notice sent → statements/escrow/EI notices held until the acknowledgment is returned or the successor assumes (§1024.32(c)(2)); satisfied by `case.sii.acknowledgment.returned` (sii.acknowledgment.return; the sii.assumption.execute path emits it with `via=assumption`). NoE/RFI/payoff are never held." });
  o("FNMA_D1_4_1_02_INTERESTED_PARTY_NOTIFY_10", { satisfied: "`sii.interested_parties.notified`", why: "§4.4 timer table: insurer/tax/MI/HOA notifications logged (sii.interested_parties.notify command)." });
  o("FNMA_D1_4_1_02_FNMA_LEGAL_60", { anchor: "`notice_date`", satisfied: "`fnma.due_on_transfer.resolved{outcome∈{non_objection, expired}}`", why: "§4.4 timer table: `due_on_transfer.unenforceable.notified` (sii.due_on_transfer.notify; payload `notice_date`) → Fannie Mae non-objection or expiry within 60 `calendar_days` (sii.due_on_transfer.resolve)." });
  // ---- 4.5 complaints ------------------------------------------------------
  o("SM_COMPLAINT_ACK_1BD", { satisfied: "`case.complaint.acknowledged`", why: "§4.5 timer table: acknowledgment by any channel (written for written complaints) — the complaint.acknowledge command, which refuses an oral acknowledgment of a written complaint." });
  o("CFPB_PORTAL_RESPONSE_15", { trigger: "`regulator.complaint.received{portal=cfpb}`", satisfied: "`regulator.complaint.responded{portal=cfpb}`", why: "§4.5 timer table: `regulator.complaint.received` (CFPB) → portal response submitted (closed or in progress) within 15 `calendar_days`." });
  o("CFPB_PORTAL_FINAL_60", { trigger: "`regulator.complaint.responded{portal=cfpb, status=in_progress}`", anchor: "`received_at`", satisfied: "`regulator.complaint.responded{portal=cfpb, status=closed}`",
    why: "§4.5 timer table: when 'in progress' is used, the final portal response is due 60 `calendar_days` from `received_at` (carried on the response event)." });
  o("CFPB_CONSUMER_FEEDBACK_60", { trigger: "`regulator.complaint.responded{portal=cfpb}`", satisfied: "`regulator.consumer_feedback.window_closed`",
    why: "§4.5 timer table: portal response → informational 60-calendar-day consumer feedback window; ops.closeConsumerFeedbackWindows emits `regulator.consumer_feedback.window_closed` when it lapses (satisfied '—')." });
  o("NY_419_6_COMPLAINT_ACK_5BD", { trigger: "`case.complaint.opened{state=NY}`", satisfied: "`notice.sent{template=NTC_COMPLAINT_ACK}`", why: "§4.5 timer table: `case.complaint.opened` (NY loan) → written acknowledgment within 5 `business_days_servicer` (3 NYCRR 419.6)." });
  o("NY_419_6_COMPLAINT_RESPONSE_30BD", { trigger: "`case.complaint.opened{state=NY}`", anchor: "`ny_response_due`", offset: "0", satisfied: "`notice.sent{template=NTC_COMPLAINT_RESPONSE}`",
    why: "§4.5 timer table: 'same' trigger as NY_419_6_COMPLAINT_ACK_5BD; 30 / 15 (or before sale) / 7 / +7 `business_days_servicer` by category, computed by complaints.nyDeadlines into the payload field `ny_response_due` (complaint.open command); satisfied by the written response (3 NYCRR 419.6)." });
  o("TX_50A6_CURE_60", { anchor: "`notice_date`", satisfied: "`complaint.tx_50a6.cured{form_20_logged=true}`",
    why: "§4.5 timer table: `complaint.tx_50a6_defect.alleged` (complaint.open detection / complaint.tx_50a6.escalate; payload `notice_date`) → 60 `calendar_days` from the notice date (Tex. Const. art. XVI §50(a)(6)(Q)(x)); satisfied by 'cure executed + Form 20 escalation logged' (complaint.tx_50a6.cure)." });
  o("FNMA_REFERRAL_RESPONSE_5BD", { satisfied: "`investor.referral.responded`", why: "§4.5 timer table: `investor.referral.received` (complaint.open with source `fannie_mae_referral`; payload `received`) → response to Fannie Mae within 5 `business_days_fannie_et` (investor.referral.respond command)." });
  o("SM_UDAAP_REVIEW_10BD", { satisfied: "`udaap_review.closed{outcome∈{finding, no_finding}}`", why: "§4.5 timer table: finding/no-finding record (udaap_review.close command)." });
  o("SM_POPULATION_REMEDIATION_60", { trigger: "`udaap_review.finding{systemic=true}`", satisfied: "`population_remediation.executed`", why: "§4.5 timer table: `udaap_review.finding` (systemic; emitted by udaap_review.close) → remediation executed within 60 `calendar_days` of the finding date." });
}
