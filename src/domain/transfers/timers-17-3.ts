/**
 * §17.3 timer overrides: for every 17.3 registry row whose column the grammar cannot carry
 * (prose satisfaction, a computed anchor, "COB T−1", "next Metro 2 cycle") a
 * `reg.override(code, { satisfied | evaluator, trigger?, offset?, anchorField?, why })`
 * (see src/domain/foreclosure/timers.ts applyForeclosureSatisfiedOverrides for the pattern).
 * Called from this section's timers.ts after the section-level overrides.
 *
 * Codes the 17.3 table shares with §1.4 / §1.5 / §1.6 / §5.1: the registry holds ONE definition per
 * code (TimerRegistry.byCode) and an override cannot change the owning row's `process`, so the
 * transfer-out reading is merged into the code's single definition — a superset trigger where the
 * two rows key on the same event, a union satisfaction (`custody.shipment.*`, `enote.eregistry.*`)
 * where both directions report the same fact, and the 17.3 column outright for the three codes the
 * spec marks "(1.x; now owned)". The two "(5.1)" cross-references (FNMA_IRM_PERIOD_CLOSE_BD2_1700,
 * FNMA_LL202605_EVENT_NEXTBD_0300) keep the investor-reporting definitions: the final period is one
 * of 5.1's periods (ops-17-3 finalPeriodClose reproduces BD2 17:00 ET for 17.3-T5). The 1.4
 * participation-notes row is loan-level (`loan.boarded`), so planDeliverables{op=cutover} arms it
 * on the outbound cutover fact instead of re-triggering it here. Because the shared definitions keep
 * their owner's `process`, an engine filtered to ["17.3"] does not arm them — production arms every
 * process; tests include the owner's process id.
 *
 * The events named here are the ones src/app/tools/section17-3.ts emits (see its header):
 *   transfer.deliverables.planned{direction=out, transfer_date, fc_or_litigation, bk, emortgage_count, participation_pool, mi_insurers}
 *                                               planDeliverables on `transfer.batch.approved{direction=out}` — the loan-list counts the approval event lacks
 *   transfer.participation_notes.pending{participation_pool}, transfer.mi_transfer_notice.pending{mi}   planDeliverables{op=cutover}
 *   transfer.counterparty_notices.sent{group}   notifyCounterparty, when the last planned notice of a group is sent
 *   transfer.counterparties.notified            notifyCounterparty, when every planned notice due before T is sent
 *   transfer.counterparty_notices.acked{group}  notifyCounterparty{op=ack}, when every notice of a group is acknowledged
 *   transfer.cutover.frozen                     runOutboundDqGate{op=freeze}
 *   recon.transfer_out_wires.matched            runOutboundDqGate{op=match_wires}
 *   recon.shortage_surplus.resolved{outcome}    runOutboundDqGate{op=shortage_surplus} (with the spec's fnma.shortage_surplus_adjustment.requested / recon.final_period.no_adjustment)
 *   transfer.custodial_recon.acked{…}           runOutboundDqGate{op=custodial_window}
 *   transfer.custodial_account.disposed{…}      runOutboundDqGate{op=custodial_disposition}
 *   transfer.final_remittance.cleared{…}        runOutboundDqGate{op=final_draft_cleared}
 *   deliverable.acked{D08=true, every_account}  ingestTransfereeAck (D08 covering every custodial account)
 *   custody.form2009.handed_off / custody.transferee_exception.resolved / custody.shipment.confirmed / custody.transferor_notice.confirmed   ingestTransfereeAck{source=custodian}
 *   mers.txn.accepted{all_mins} / mers.tos.pending_received / mers.snapshot.verified{all_mins}   verifyMersSnapshot{op=ack | snapshot}
 *   enote.eregistry.updated{servicing_agent=transferee}   verifyERegistry
 *   transfer.support_window.expired             answerTransfereeRequest{op=window}, the day-91 sweep (audit trail; the window row itself is the 17.3.supportWindowOpen gate)
 *   transfer.archive.written{all_loans=true}    buildDebrief{op=archive}
 *   human_portal_task.completed{task=…}         the CBAM LOA-cancellation portal task (openPortalTask{op=complete} pattern, 15.1)
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_17_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- cutover freeze: "COB `transfer_date − 1`" is not a bare anchor field, so anchor on transfer_date and step back one calendar day (dueAt = end of that day ET)
  o("SM_XFER_OUT_CUTOVER_FREEZE_T1", { anchorField: "transfer_date", offset: "−1 calendar_days",
    why: "§17.3 timer table: not_before_gate on `transfer.batch.approved{direction=out}`, anchor 'COB `transfer_date − 1`', offset 0 — the freeze runs at COB T−1 after the last posting batch (business rule: 'freeze at COB Nov 30'); satisfied by `transfer.cutover.frozen` (runOutboundDqGate{op=freeze}); posting commands for listed loans are refused after it." });
  // ---- counterparties (F-1-11 third parties; A2-7-03 "servicing functions that involve third parties will continue uninterrupted")
  o("SM_XFER_OUT_COUNTERPARTIES_T1", { satisfied: "`transfer.counterparties.notified{all_due_before_transfer_sent=true}`",
    why: "§17.3 timer table: 'all `counterparty_notifications{due before T}` sent' — notifyCounterparty emits `transfer.counterparties.notified` once no notice of the planned population (notifyCounterparty{op=plan}) due before T is unsent (−1 servicer BD; sev 1 → officer)." });
  o("MI_MGIC_TRANSFER_NOTICE_60", { trigger: "`transfer.mi_transfer_notice.pending{mi=MGIC}`", anchorField: "transfer_date", satisfied: "`counterparty_notifications.acked{mi=MGIC}`",
    why: "§17.3 timer table: `transfer.batch.cutover_completed{mi=MGIC}`, anchor `transfer_date`, +60 calendar days ('policy: send at T−1'; MGIC Servicing Guide Mar 12, 2026: 'Notify us within 60 days of acquiring or selling servicing rights'), satisfied by `counterparty_notifications.acked{mi}` — MGIC's own acknowledgment. The cutover event 17.1 emits carries no insurer list; the insurers are a loan-list fact, so planDeliverables{op=cutover} emits one `transfer.mi_transfer_notice.pending{mi, transfer_date}` per MI insurer of the batch (ops-17-3 miTransferNotices) and the MGIC one arms this row on the same anchor. notifyCounterparty{op=ack} stamps `mi=<party_id>` on the MI acknowledgment, so only MGIC's ack (not Radian's or Enact's) closes it." });
  o("SM_XFER_OUT_MI_NOTICE_T1", { satisfied: "`transfer.counterparty_notices.sent{group=mi}`",
    why: "§17.3 timer table: 'MI notices sent (all insurers)' — the mi group of the planned population completes when every MI master-policy notice for the batch is sent (MGIC: certificate, borrower, selling servicer, new servicer name/address, new loan number, effective date)." });
  o("SM_XFER_OUT_INSURER_ENDORSEMENT_T1", { satisfied: "`transfer.counterparty_notices.sent{group=insurers}`",
    why: "§17.3 timer table: 'endorsement/billing-address requests sent to every hazard/flood/other carrier and the LPI carrier' — the insurers group (mortgagee clause ISAOA/ATIMA to the transferee)." });
  o("SM_XFER_OUT_VENDOR_NOTICE_T1", { satisfied: "`transfer.counterparty_notices.sent{group=vendors}`",
    why: "§17.3 timer table: 'tax/flood service, optional insurance, insurance tracker, preservation, bankruptcy monitor notified (continue/discontinue)' — the vendors group." });
  o("SM_XFER_OUT_TAXING_AUTHORITY_NOTICE_T1", { satisfied: "`transfer.counterparty_notices.sent{group=taxing_authorities}`",
    why: "§17.3 timer table: 'notices to taxing authorities, HOAs, leaseholders, lienholders, utilities (escrowed items)' — the taxing_authorities group (transferee name/address; sev 3)." });
  // The spec keys these two on `transfer.batch.approved{direction=out, fc_or_litigation>0}` / `{direction=out, bk>0}`; the approval event 17.1 emits
  // (ops-17-1.ts batchFacts) carries direction / type / transfer_date / loan_count but no population counts — those come from the attested loan list, which
  // 17.3 reads when it plans the deliverables on that approval (Inputs: "`transfer.batch.approved{direction=out}`, `transfer.loan_list.attested` (17.1) →
  // deliverable plan"). planDeliverables emits `transfer.deliverables.planned{direction=out, transfer_date, fc_or_litigation, bk, emortgage_count, …}`
  // (ops-17-3 batchPopulationFacts) on the batch, anchored on the same `transfer_date`, so the rows arm from the event that actually carries the condition.
  o("SM_XFER_OUT_LAW_FIRM_NOTICE_T1", { trigger: "`transfer.deliverables.planned{direction=out, fc_or_litigation>0}`", anchorField: "transfer_date", satisfied: "`transfer.counterparty_notices.sent{group=law_firms}`",
    why: "§17.3 timer table: `transfer.batch.approved{direction=out, fc_or_litigation>0}`, anchor `transfer_date`, −1 servicer BD — the count is a loan-list fact the approval event does not carry, so the row arms on 17.3's deliverable plan for that approval (`transfer.deliverables.planned{direction=out, fc_or_litigation>0}`, same transfer_date anchor); 'law firms notified; hold/transfer instructions per 17.4' — the law_firms group (A2-7-03 'notify any law firm involved in the management of foreclosure or other legal action'); the notice carries hold / proceed / substitute_counsel (attorney)." });
  o("SM_XFER_OUT_BK_TRUSTEE_NOTICE_T1", { trigger: "`transfer.deliverables.planned{direction=out, bk>0}`", anchorField: "transfer_date", satisfied: "`transfer.counterparty_notices.sent{group=bk_trustees}`",
    why: "§17.3 timer table: `transfer.batch.approved{direction=out, bk>0}`, anchor `transfer_date`, −1 servicer BD [UNVERIFIED — local practice] — as for the law-firm row, the bankruptcy count rides 17.3's deliverable plan (`transfer.deliverables.planned{direction=out, bk>0}`); 'trustee/debtor-counsel payment-address notices sent (14.x)' — the bk_trustees group." });
  // ---- deliverable acknowledgments whose row carries a condition beyond the D-code
  o("FNMA_F1_11_CUSTODIAL_RECON_5BD", { satisfied: "`deliverable.acked{D08=true, every_account=true}`",
    why: "§17.3 timer table: '`deliverable.acked{D08}` for every Supermortgage custodial account holding funds for the transferred population' — ingestTransfereeAck refuses a D08 ack that does not cover every listed custodial account and stamps `every_account=true` when it does (A2-1-07: the accounts are not transferred, their balances are)." });
  // ---- funds (custodial-recon acts run as runOutboundDqGate ops — agents.json lists only the transfer agent's tool strings for 17.3)
  o("FNMA_F1_11_SHORTAGE_SURPLUS_ADJ_30", { satisfied: "`recon.shortage_surplus.resolved{outcome∈{adjustment_requested, no_adjustment}}`",
    why: "§17.3 timer table: '`fnma.shortage_surplus_adjustment.requested` (partner officer e-mail to the IR representative) or `recon.final_period.no_adjustment`' — the engine keys on one pattern, so runOutboundDqGate{op=shortage_surplus} emits the spec's event for the branch taken and the closing `recon.shortage_surplus.resolved{outcome}`; unresolved shortages otherwise shift to the transferee (F-1-11)." });
  // ---- custody
  o("SM_XFER_OUT_FORM2009_HANDOFF_T0", { satisfied: "`custody.form2009.handed_off{recipient=transferee_custodian}`",
    why: "§17.3 timer table: 'executed Form 2009s for open non-liquidation releases delivered to the transferee custodian' by T (Document Transfers Job Aid v5); the custodian's 90-day report responsibility passes with them (ingestTransfereeAck{source=custodian, item.kind=form2009_handed_off})." });
  o("SM_XFER_OUT_RECERT_EXCEPTION_RESPONSE_10", { satisfied: "`custody.transferee_exception.resolved{outcome∈{cured, documented}}`",
    why: "§17.3 timer table: 'exception cured or documented' within +10 servicer BD of `custody.transferee_exception.received` (policy); allonges/assignments → signing_officer." });
  // shared with §1.4 — "(1.4; now owned)": the same duty seen from the transferor side; one definition per code
  o("FNMA_A2_7_03_TRANSFEROR_CUSTODIAN_NOTICE_30", { trigger: "`transfer.batch.approved`", anchorField: "transfer_date", offset: "+30 calendar_days", satisfied: "`custody.transferor_notice.confirmed`",
    why: "§17.3 timer table (1.4; now owned): `transfer.batch.approved{direction=out}`, anchor `transfer_date` (TED), +30 calendar days ('policy: send at approval'; A2-7-03 'advise the transferor document custodian … within 30 days of the transfer effective date'), satisfied by `custody.transferor_notice.confirmed` (custodian ack with D-Code, approval letter, trial balance — ingestTransfereeAck{source=custodian}). The §1.4 row keys the same duty on `transfer.batch.cutover_completed` with the same anchor and offset; arming both directions at approval tracks it from the earliest point without moving the due date (inbound approvals carry `transfer_date` too). The breach column stays the owning row's (sev 2 → transfer/officer); the outbound sev 1 → officer path is ops-17-3 / the deliverable plan." });
  o("FNMA_DTJA_DOCS_SHIPPED_30", { satisfied: "`custody.shipment.*`",
    why: "§17.3 timer table: '`custody.shipment.confirmed` (manifest + transferee custodian receipt)' within +30 CD of `custody.transferor_notice.confirmed`; the §1.4 row's `custody.shipment.received` is Supermortgage's own custodian receiving the transferor's shipment — the same shipment fact from the other side, so both types satisfy the one definition (no other `custody.shipment.*` event exists)." });
  o("FNMA_F1_11_PARTICIPATION_NOTES_30", { trigger: "`transfer.participation_notes.pending{participation_pool>0}`", anchorField: "transfer_date", satisfied: "`custody.shipment.*{participation_notes=true}`",
    why: "§17.3 timer table (1.4): trigger `transfer.batch.cutover_completed{participation_pool>0}`, anchor `transfer_date`, +30 CD, 'notes received by transferee custodian'. The cutover event 17.1 emits carries no participation count and the §1.4 row's trigger is loan-level (`loan.boarded{participation_pool=true, note_held_by_transferor=true}`), which neither boarding nor a transfer-out batch emits (tools/lint-emission.ts) — so the code arms on the cutover-time fact 17.3 emits from the loan list, `transfer.participation_notes.pending{participation_pool>0}` (planDeliverables{op=cutover}; ops-17-3 participationNotesHandoff), anchored on the same `transfer_date`. Satisfied by the shipment confirmation that carries the notes — `custody.shipment.confirmed{participation_notes=true}` (manifest + transferee custodian receipt, ingestTransfereeAck{source=custodian}); the §1.4 inbound `custody.shipment.received` shares the definition and satisfies it when it carries the same flag." });
  o("FNMA_F1_11_ENOTE_SERVICING_AGENT_T0", { offset: "−1 business_days_servicer", satisfied: "`enote.eregistry.*{servicing_agent∈{transferee, 1009999}}`",
    why: "§17.3 timer table (1.4; now owned): `transfer.batch.approved{direction=out, emortgage_count>0}` (the §1.4 trigger `transfer.batch.approved{emortgage_count>0}` matches an inbound approval, which carries the count; the outbound approval 17.1 emits does not, so planDeliverables arms this code on the batch from the loan list's eNote count — ctx.timers.arm, anchored on `transfer_date`), −1 business_days_servicer (F-1-11: eMortgage steps 'prior to the date of the transfer'), satisfied by `enote.eregistry.updated{servicing_agent=transferee}` + eDelivery copies + audit trails acked — verifyERegistry emits the loan-level event only with all three and the batch-level one once every eNote of the batch has it. The §1.4 inbound satisfaction `enote.eregistry.verified{servicing_agent=1009999}` (Supermortgage as the new Servicing Agent) shares the definition; neither direction emits the other's event." });
  // shared with §1.5 — "(1.5; partner submits / partner initiates)": superset triggers so the outbound batch types arm the same codes; satisfactions stay 1.5's (verifyMersSnapshot{op=ack} emits them)
  o("MERS_PROC_SUBSERVICER_MIN_UPDATE_T0", { trigger: "`transfer.batch.approved{type∈{master_to_sub, sub_to_sub, sub_to_master}}`",
    why: "§17.3 timer table (1.5; partner submits removal/replacement): `transfer.batch.approved{direction=out, type∈sub_to_sub,sub_to_master}` — the §1.5 row keys on master_to_sub/sub_to_sub; the union arms the code for every batch type whose MIN Subservicer field changes (Procedures Manual 24.2: a resigning Member removes its Org ID). Satisfied by the batch-level `mers.txn.accepted{txn_type=min_update_subservicer, all_mins=true}` (§1.5 override) that verifyMersSnapshot{op=ack} records for all MINs." });
  o("MERS_PROC_TOS_INITIATE_T0", { trigger: "`transfer.batch.approved{type∈{servicing_sale_with_sub, servicing_sale}}`",
    why: "§17.3 timer table (1.5; partner initiates): `transfer.batch.approved{direction=out, type=servicing_sale}` — the §1.5 row keys on servicing_sale_with_sub; the union arms the seller-initiated TOS for both. Satisfied by `mers.tos.pending_received` (§1.5): MERS's acceptance of the partner's TOS initiation (`mers.txn.accepted{tos_initiate}` per MIN) puts the TOS in pending status, which verifyMersSnapshot{op=ack} records on the batch." });
  // ---- final accounting — "(1.6; now owned)"
  o("FNMA_F1_11_FINAL_ACCOUNTING_30", { satisfied: "`transfer.final_accounting.*{received_on is not null}`",
    why: "§17.3 timer table (1.6; now owned): +30 calendar days from `transfer_date`, satisfied by `deliverable.acked{D31}` (final accounting incl. advances claimed, shortage/surplus, forwarded payments) — ingestTransfereeAck emits that event (it starts SM_ADVANCE_REIMBURSEMENT_RECEIVABLE_30 and SM_XFER_OUT_ARCHIVE_MANIFEST_10) together with `transfer.final_accounting.acked{received_on}`, the transferee's receipt of Supermortgage's accounting. The §1.6 row's `transfer.final_accounting.received{received_on}` is the transferor's accounting reaching Supermortgage (1.6-T6); both are 'the final accounting received' for the one definition the code can hold, and `transfer.final_accounting.delivered` (sendDeliverable, no received_on) does not close it." });
  // ---- custodial accounts (A2-1-07; Supermortgage is the account holder of record — balances move, accounts do not)
  o("SM_XFER_OUT_CUSTODIAL_CLOSE_60", { anchorField: "recon_acked_on", satisfied: "`transfer.custodial_account.disposed{outcome∈{closed, recon_certificate_filed}}`",
    why: "§17.3 timer table: trigger 'FNMA_F1_11_CUSTODIAL_RECON_5BD satisfied and the T+30 adjustment window closed with no open variance' = `transfer.custodial_recon.acked{adjustment_window_closed=true, open_variance=false}` (runOutboundDqGate{op=custodial_window}, anchored on the reconciliation ack date it carries); +60 CD; fully-vacated account → zero balance confirmed, Forms 1013/1014 withdrawn in CBAM (human_portal_task, partner countersignature), depository account closed, closure letter filed = `closed`; account retaining loans → post-transfer reconciliation certificate filed = `recon_certificate_filed` (runOutboundDqGate{op=custodial_disposition})." });
  o("SM_XFER_OUT_CUSTODIAL_ACCOUNT_CLOSE", { anchorField: "cleared_on", satisfied: "`human_portal_task.completed{task=cbam_loa_cancellation}`",
    why: "§17.3 timer table: 'final-period remittance draft cleared + final Form 496/496A (6.3/6.4) for the last batch' = `transfer.final_remittance.cleared{last_batch_for_partner=true}` (runOutboundDqGate{op=final_draft_cleared}, anchored on the clearing date it carries); 'CBAM LOA cancellation task completed (`human_portal_task`)' +10 servicer BD (6.1/6.2)." });
  // ---- credit reporting (8.1): the next Metro 2 cycle is the snapshot at 00:05 ET on the 1st of the following month (FNMA_C41_01_METRO2_SNAPSHOT_EOM cadence, as 8.3's next-cycle rows encode it)
  o("SM_XFER_OUT_CREDIT_FINAL_CYCLE", { anchorField: "transfer_date", offset: "first day of next month, 00:05 ET", satisfied: "`transfer.counterparty_notices.acked{group=credit_bureaus, kind=final_cycle}`",
    why: "§17.3 timer table: anchor 'next Metro 2 cycle (8.1)' after `transfer.batch.cutover_completed` — the cycle that carries status 05 with date closed = T is the first monthly snapshot after T (8.1: 00:05 ET on the 1st, as of the prior month end); 'final cycle with status 05 accepted by all bureaus' = every credit_bureau counterparty (kind final_cycle, account_status 05, date_closed = T) acknowledged — notifyCounterparty{op=ack} emits the group event when the last bureau accepts." });
  // ---- support window and tails
  o("SM_XFER_OUT_SUPPORT_WINDOW_90", { evaluator: "17.3.supportWindowOpen", satisfied: "—",
    why: "§17.3 timer table: recurring (window) days 1–90 after `transfer_date` (Mar 1, 2027 in the example) — a window, not a deadline: 'forwarding files, toll-free routing, transferee requests' are its obligations, measured by SM_XFER_OUT_FORWARD_FILE_DAILY / SM_XFER_OUT_BORROWER_ROUTING_90 (17.2) and SM_XFER_OUT_TRANSFEREE_REQUEST_5BD; inside the window requests are answered in 5 BD and files forwarded daily, after it on receipt and within 10 BD (decision 3). Encoded as the gate evaluator over {today, transfer_date} that answerTransfereeRequest consults (ops-17-3 supportWindow; the day-91 sweep emits `transfer.support_window.expired` for the audit trail). Not event-satisfied: the registry kind normalizes to `recurring`, and the kernel engine re-arms a recurring row on satisfaction while iterating its instances, so an event satisfaction of this row never terminates (src/kernel/timers/engine.ts onEvent)." });
  o("REGX_1024_35G_NOE_TAIL_1Y", { evaluator: "17.3.noeRfiWithinPostTransferTail",
    why: "§17.3 timer table: not_before_gate (window) — an NoE/RFI about Supermortgage's servicing received ≤ T + 1 year runs the 4.1/4.2 clocks; after T + 1 year → `untimely` determination with the §1024.35(g)(2)/§1024.36(f)(2) notice — condition-shaped, so an evaluator over {received_on, transfer_date}." });
  o("REGX_1024_38C1_RETENTION_1Y", { evaluator: "17.3.retentionFloorElapsed",
    why: "§17.3 timer table: not_before_gate — no purge before T + 1 year (§1024.38(c)(1)); `transfer_out_archive` retain_until (T + 7 years, decision 4) and any legal hold extend it — evaluator over {today, transfer_date, retain_until, legal_hold}." });
  // ---- archive
  o("SM_XFER_OUT_ARCHIVE_MANIFEST_10", { satisfied: "`transfer.archive.written{all_loans=true}`",
    why: "§17.3 timer table: '`transfer_out_archives` written for every loan' within +10 servicer BD of the D31 ack — buildDebrief{op=archive} emits `transfer.archive.written{all_loans=true}` when no listed loan lacks a manifest." });
}
