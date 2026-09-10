// 4.4 Successor in interest
// spec/sections/04-customer-service-borrower-communications/4-4-successor-in-interest.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
void cents;
import { redactions } from "./rfi.ts";
import { postConfirmationRights, siiTimers, assumptionExecuted, documentDescription, fraudSignals } from "./ops.ts";
import { SYSTEM } from "../../kernel/events/index.ts";
import * as SII from "./successor.ts";
import { siiPolicyDue } from "./cases.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { harness, CASE_AGENT, OFFICER, refusedWith } from "./test-harness.ts";
void SYSTEM;
const notices = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };
const sent = (h: ReturnType<typeof harness>, template: string, caseId: string, extra: Record<string, unknown> = {}) => h.events.append({ type: "notice.sent", loanId: "L-1", actor: CASE_AGENT, payload: { template, case_id: caseId, notice_id: `n-${template}-${caseId}`, ...extra } });

test("4.4-T1: Given the 2026-10-01 call scenario, then docs letter by 2026-10-08, confirmation by 2026-11-03 after documents on 2026-10-20, and the acknowledgment notice in the same mailing.", async () => {
  assert.deepEqual(SII.timeline(D("2026-10-01"), D("2026-10-20")), { documents_letter_due: "2026-10-08", confirmation_due: "2026-11-03" });
  const h = harness("2026-10-01T15:00:00.000Z");
  const opened = (await h.run("4.4", "sii.open", CASE_AGENT, { case_id: "sii-1", notice_source: "call", transfer_type: "death_relative", notice_date: "2026-10-01", transferor_borrower_id: "b-mother" })).output as { facilitate_due: string };
  assert.equal(opened.facilitate_due, "2026-10-05"); assert.equal(h.timer("REGX_1024_38B1VI_SII_FACILITATE_2")[0]!.dueDate, "2026-10-05");
  await assert.rejects(h.run("4.4", "sii.potential_successor.identify", CASE_AGENT, { case_id: "sii-9", party_id: "p-x" }), refusedWith("CASE_NOT_FOUND"));
  await h.run("4.4", "sii.facilitate", CASE_AGENT, { case_id: "sii-1", mode: "call", to: "daughter" }, "2026-10-02T15:00:00.000Z");
  assert.equal(h.timer("REGX_1024_38B1VI_SII_FACILITATE_2")[0]!.status, "satisfied");
  const ident = (await h.run("4.4", "sii.potential_successor.identify", CASE_AGENT, { case_id: "sii-1", party_id: "p-daughter", identified_on: "2026-10-01" })).output as { docs_description_due: string };
  assert.equal(ident.docs_description_due, "2026-10-08"); assert.equal(h.timer("REGX_1024_38B1VI_SII_DOCS_DESC_5")[0]!.dueDate, "2026-10-08");
  await h.run("4.4", "sii.documents.request", CASE_AGENT, { case_id: "sii-1", transfer_type: "death_relative", documents: ["death_certificate", "recorded_deed", "letters_testamentary", "will"] }, "2026-10-06T15:00:00.000Z");
  sent(h, "NTC_REGX_38B1VI_SII_CONFIRMED", "sii-1"); assert.equal(h.timer("REGX_1024_38B1VI_SII_DOCS_DESC_5")[0]!.status, "armed");      // only the document-description letter satisfies
  sent(h, "NTC_REGX_38B1VI_SII_DOCS", "sii-1"); assert.equal(h.timer("REGX_1024_38B1VI_SII_DOCS_DESC_5")[0]!.status, "satisfied");
  const recv = (await h.run("4.4", "sii.documents.receive", CASE_AGENT, { case_id: "sii-1", received_on: "2026-10-20", documents: ["death_certificate", "recorded_deed", "letters_testamentary", "will"], vesting_established: true }, "2026-10-20T15:00:00.000Z")).output as { sufficient: boolean; determination_due: string };
  assert.deepEqual([recv.sufficient, recv.determination_due], [true, "2026-11-03"]);
  assert.equal(h.timer("REGX_1024_38B1VI_SII_CONFIRM_10")[0]!.dueDate, "2026-11-03"); assert.equal(h.timer("REGX_1024_38B1VI_SII_ADDL_DOCS_5").length, 0);
  h.clock.set("2026-11-03T15:00:00.000Z");
  const r = (await h.run("4.4", "sii.determine", CASE_AGENT, { case_id: "sii-1", determination: "confirmed", transfer_type: "death_relative", party_id: "p-daughter" })).output as { notice: string; obligor: boolean };
  assert.deepEqual(r, { determination: "confirmed", notice: "NTC_REGX_38B1VI_SII_CONFIRMED", obligor: false } as unknown as typeof r); assert.equal(h.rt.store.get("parties", "p-daughter")!.data.role, "confirmed_successor");
  assert.equal(h.timer("REGX_1024_38B1VI_SII_CONFIRM_10")[0]!.status, "satisfied"); assert.equal(h.timer("REGX_1024_32C_SII_ACK_NOTICE_SAME_DAY")[0]!.dueDate, "2026-11-03");   // the §1024.32(c) notice goes in the same mailing
  assert.equal(h.timer("FNMA_D1_4_1_02_INTERESTED_PARTY_NOTIFY_10")[0]!.dueDate, "2026-11-18");                                                                            // 10 servicer BD from Tue 11-03 (Veterans Day closed)
  sent(h, "NTC_REGX_38B1VI_SII_CONFIRMED", "sii-1", { mailing: "confirmation" }); assert.equal(h.timer("REGX_1024_32C_SII_ACK_NOTICE_SAME_DAY")[0]!.status, "armed");     // the confirmation letter alone is not the (c) notice
  sent(h, "NTC_REGX_32C_SII_ACK", "sii-1", { mailing: "confirmation" });
  assert.equal(h.timer("REGX_1024_32C_SII_ACK_NOTICE_SAME_DAY")[0]!.status, "satisfied"); assert.equal(h.timer("REGX_1024_32C_SII_DISCLOSURE_HOLD")[0]!.status, "armed");
  await h.run("4.4", "sii.interested_parties.notify", CASE_AGENT, { case_id: "sii-1", parties: ["hazard_insurer", "tax_authority", "mi_company"] }, "2026-11-05T15:00:00.000Z");
  assert.equal(h.timer("FNMA_D1_4_1_02_INTERESTED_PARTY_NOTIFY_10")[0]!.status, "satisfied");
  await h.run("4.4", "sii.acknowledgment.return", CASE_AGENT, { case_id: "sii-1", elected_notices: true }, "2026-11-20T15:00:00.000Z");
  assert.equal(h.timer("REGX_1024_32C_SII_DISCLOSURE_HOLD")[0]!.status, "satisfied"); assert.equal(h.rt.store.get("sii_cases", "sii-1")!.data.ack_status, "returned");
});
test("4.4-T2: Given a joint-tenancy survivor providing a death certificate and the recorded deed, then no probate documents are requested and confirmation issues.", async () => {
  assert.deepEqual(SII.DOCUMENT_MATRIX.joint_tenancy_survivor, ["death_certificate", "recorded_deed"]); assert.ok(!SII.DOCUMENT_MATRIX.joint_tenancy_survivor.some((d) => /letters|will|probate|court/.test(d)));
  assert.deepEqual(SII.requiredDocuments("joint_tenancy_survivor", ["recorded_deed"]), ["death_certificate"]); assert.deepEqual(SII.requiredDocuments("joint_tenancy_survivor", ["death_certificate", "recorded_deed"]), []);
  const r = SII.evaluateDocuments("joint_tenancy_survivor", ["death_certificate", "recorded_deed"], true, D("2026-10-20"));
  assert.deepEqual(r, { determination: "confirmed", still_required: [], notice: "NTC_REGX_38B1VI_SII_CONFIRMED", notice_due: "2026-11-03", denial: false });
  const h = harness();
  await h.run("4.4", "sii.open", CASE_AGENT, { case_id: "sii-2", notice_source: "letter", transfer_type: "joint_tenancy_survivor" });
  await assert.rejects(h.run("4.4", "sii.documents.request", CASE_AGENT, { case_id: "sii-2", transfer_type: "joint_tenancy_survivor", documents: ["death_certificate", "recorded_deed", "letters_testamentary"] }), refusedWith("OUTSIDE_MATRIX_ROW"));
  await h.run("4.4", "sii.documents.request", CASE_AGENT, { case_id: "sii-2", transfer_type: "joint_tenancy_survivor", documents: ["death_certificate", "recorded_deed"] });
  const recv = (await h.run("4.4", "sii.documents.receive", CASE_AGENT, { case_id: "sii-2", documents: ["death_certificate", "recorded_deed"], vesting_established: true }, "2026-10-20T15:00:00.000Z")).output as { sufficient: boolean; still_required: string[] };
  assert.deepEqual([recv.sufficient, recv.still_required], [true, []]);
  const c = (await h.run("4.4", "sii.determine", CASE_AGENT, { case_id: "sii-2", determination: "confirmed", transfer_type: "joint_tenancy_survivor" })).output as { notice: string }; assert.equal(c.notice, "NTC_REGX_38B1VI_SII_CONFIRMED");
});
test("4.4-T3: Given a divorce decree and separation agreement awarding the home to the non-borrower spouse, then confirmation without requiring a deed (comment -3).", async () => {
  assert.deepEqual(SII.DOCUMENT_MATRIX.divorce, ["divorce_decree", "separation_agreement"]); assert.ok(!SII.requiredDocuments("divorce", []).includes("recorded_deed"));
  assert.equal(SII.determine("divorce", ["divorce_decree", "separation_agreement"], true), "confirmed");
  const h = harness();
  await h.run("4.4", "sii.open", CASE_AGENT, { case_id: "sii-3", notice_source: "letter", transfer_type: "divorce" });
  await assert.rejects(h.run("4.4", "sii.documents.request", CASE_AGENT, { case_id: "sii-3", transfer_type: "divorce", documents: ["divorce_decree", "separation_agreement", "recorded_deed"] }), refusedWith("OUTSIDE_MATRIX_ROW"));
  await assert.rejects(h.run("4.4", "sii.determine", CASE_AGENT, { case_id: "sii-3", determination: "confirmed", transfer_type: "divorce", party_id: "p-spouse", obligor: true }), refusedWith("CONFIRMED_NOT_OBLIGOR"));
  const r = (await h.run("4.4", "sii.determine", CASE_AGENT, { case_id: "sii-3", determination: "confirmed", transfer_type: "divorce", party_id: "p-spouse" })).output as { notice: string; obligor: boolean };
  assert.equal(r.notice, "NTC_REGX_38B1VI_SII_CONFIRMED"); assert.equal(r.obligor, false); assert.equal(h.events.ofType("case.sii.confirmed")[0]!.payload.non_obligor, true); assert.equal(h.rt.store.get("parties", "p-spouse")!.data.obligor, false);
});
test("4.4-T4: Given documents that do not establish vesting (will, no letters, probate pending), then `additional_documents_required` with specific items within 5 federal BD, not a denial.", async () => {
  const r = SII.evaluateDocuments("death_relative", ["death_certificate", "recorded_deed", "will"], false, D("2026-10-20"));
  assert.deepEqual(r, { determination: "additional_documents_required", still_required: ["letters_testamentary"], notice: "NTC_REGX_38B1VI_SII_ADDL_DOCS", notice_due: "2026-10-27", denial: false });
  assert.deepEqual(SII.evaluateDocuments("death_relative", ["death_certificate", "recorded_deed", "will", "letters_testamentary"], false, D("2026-10-20")).still_required, ["court_order_or_letters_establishing_vesting"]);   // comment -4: specify what more is required
  const h = harness("2026-10-20T15:00:00.000Z");
  await h.run("4.4", "sii.open", CASE_AGENT, { case_id: "sii-4", notice_source: "letter", transfer_type: "death_relative", notice_date: "2026-10-01" });
  const recv = (await h.run("4.4", "sii.documents.receive", CASE_AGENT, { case_id: "sii-4", received_on: "2026-10-20", documents: ["death_certificate", "recorded_deed", "will"], vesting_established: false })).output as { sufficient: boolean; still_required: string[]; addl_docs_due: string; notice: string };
  assert.deepEqual([recv.sufficient, recv.still_required, recv.addl_docs_due, recv.notice], [false, ["letters_testamentary"], "2026-10-27", "NTC_REGX_38B1VI_SII_ADDL_DOCS"]);
  assert.equal(h.timer("REGX_1024_38B1VI_SII_ADDL_DOCS_5")[0]!.dueDate, "2026-10-27"); assert.equal(h.timer("REGX_1024_38B1VI_SII_CONFIRM_10").length, 0);
  const d = (await h.run("4.4", "sii.determine", CASE_AGENT, { case_id: "sii-4", determination: "additional_documents_required", transfer_type: "death_relative" })).output as { notice: string };
  assert.equal(d.notice, "NTC_REGX_38B1VI_SII_ADDL_DOCS"); assert.equal(h.events.ofType("case.sii.confirmed").length, 0);
  const v = notices().activeVersion("NTC_REGX_38B1VI_SII_ADDL_DOCS", D("2026-10-27"))!; const rr = render(v.source, v.samplePayload);
  assert.match(rr.text, /we still need: letters testamentary — because the will alone does not vest title before probate in Texas/); assert.equal(evaluateChecklist(v, v.samplePayload, rr).passed, true);
  sent(h, "NTC_REGX_38B1VI_SII_DOCS", "sii-4"); assert.equal(h.timer("REGX_1024_38B1VI_SII_ADDL_DOCS_5")[0]!.status, "armed");
  sent(h, "NTC_REGX_38B1VI_SII_ADDL_DOCS", "sii-4"); assert.equal(h.timer("REGX_1024_38B1VI_SII_ADDL_DOCS_5")[0]!.status, "satisfied");
});
test("4.4-T5: Given a buyer under an arm's-length sale claiming successor status, then `not_successor` with `officer` approval, the reason letter, and an NoE pathway statement; the D1-4.1-02 assumption path is offered separately if applicable.", async () => {
  assert.equal(SII.determine("arms_length_sale", [], true), "not_successor"); assert.equal(SII.evaluateDocuments("arms_length_sale", ["recorded_deed"], true, D("2026-10-20")).denial, true);
  const h = harness();
  await h.run("4.4", "sii.open", CASE_AGENT, { case_id: "sii-5", notice_source: "letter", transfer_type: "arms_length_sale" });
  const reason = "the transfer was an arm's-length sale to an unrelated buyer, which is not one of the five transfer types in §1024.31";
  await assert.rejects(h.run("4.4", "sii.determine", CASE_AGENT, { case_id: "sii-5", determination: "not_successor", transfer_type: "arms_length_sale", reason }), refusedWith("NOT_SUCCESSOR_NEEDS_OFFICER"));
  await assert.rejects(h.run("4.4", "sii.determine", CASE_AGENT, { case_id: "sii-5", determination: "not_successor", transfer_type: "arms_length_sale", reason, officer_approval_id: "appr-1" }), refusedWith("NOT_SUCCESSOR_NEEDS_OFFICER"));   // an id no officer recorded
  await assert.rejects(h.run("4.4", "sii.determine", OFFICER, { case_id: "sii-5", determination: "not_successor", transfer_type: "arms_length_sale", reason: "no assumption of the loan was signed" }), refusedWith("DENY_FOR_NO_ASSUMPTION"));
  await h.approve(OFFICER, { approval_id: "appr-1", case_id: "sii-5", scope: "sii.determine", rationale: reason });
  await assert.rejects(h.run("4.4", "sii.determine", CASE_AGENT, { case_id: "sii-5x", determination: "not_successor", reason, officer_approval_id: "appr-1" }), refusedWith("NOT_SUCCESSOR_NEEDS_OFFICER"));   // the approval binds to sii-5
  const r = (await h.run("4.4", "sii.determine", CASE_AGENT, { case_id: "sii-5", determination: "not_successor", transfer_type: "arms_length_sale", reason, officer_approval_id: "appr-1" })).output as { notice: string };
  assert.equal(r.notice, "NTC_REGX_38B1VI_SII_NOT_SUCCESSOR"); assert.equal(h.rt.store.get("sii_cases", "sii-5")!.data.officer_approval_id, "appr-1"); assert.equal(h.events.ofType("case.sii.confirmed").length, 0);
  assert.equal(h.events.ofType("case.approval.recorded")[0]!.actor.role, "officer");
  const reg = notices(); const v = reg.activeVersion("NTC_REGX_38B1VI_SII_NOT_SUCCESSOR", D("2026-11-03"))!; const rr = render(v.source, v.samplePayload);
  assert.match(rr.text, /we cannot confirm you as a successor in interest because the transfer was an arm's-length sale to an unrelated buyer/); assert.match(rr.text, /you may send a notice of error to PO Box 2/); assert.equal(evaluateChecklist(v, v.samplePayload, rr).passed, true);
  const unsigned = { ...v.samplePayload, officer_signoff: false }; assert.ok(evaluateChecklist(v, unsigned, render(v.source, unsigned)).blocking.some((b) => b.rule_id === "officer"));
  const offer = reg.activeVersion("NTC_FNMA_D1_4_1_02_ASSUMPTION_OFFER", D("2026-11-03"))!; const or = render(offer.source, offer.samplePayload);
  assert.match(or.text, /Servicing Guide D1-4.1-02/); assert.match(or.text, /declining does not affect your rights/); assert.equal(evaluateChecklist(offer, offer.samplePayload, or).passed, true);
});
test("4.4-T6: Given confirmation and no returned acknowledgment, then periodic/escrow statements and EI notices to the successor are held while an RFI from the successor is answered on the 4.2 clock and a payoff request is answered within the Reg Z window (16.1).", () => {
  const r = postConfirmationRights({ confirmed_on: D("2026-11-03"), ack_returned_on: null, rfi_received_on: D("2026-11-05"), payoff_requested_on: D("2026-11-05") });
  assert.equal(r.statements_ei_escrow, "held"); assert.equal(r.rfi_response_due, "2026-12-21");   // 30 federal BD (Veterans Day, Thanksgiving excluded)
  assert.equal(r.payoff_due, "2026-11-17");                                                        // Reg Z §1026.36(c)(3): 7 business days from Thu 11-05 (Veterans Day 11-11 closed) → Tue 11-17
  assert.deepEqual(r.rights, { noe_rfi_payoff: true, statements_and_ei: false, obligor: false }); assert.equal(r.escrow_statement_addressee, false);
});
test("4.4-T7: Given the acknowledgment is returned, then statements start on the next cycle and the escrow annual statement includes the successor as addressee.", () => {
  const r = postConfirmationRights({ confirmed_on: D("2026-11-03"), ack_returned_on: D("2026-11-20") });
  assert.equal(r.statements_ei_escrow, "next_cycle"); assert.equal(r.escrow_statement_addressee, true); assert.equal(r.rights.statements_and_ei, true);
});
test("4.4-T8: Given a potential successor submits a loss-mit application, then all SII policy timers halve and `lossmit_reviewer` sees the pending-confirmation flag; upon confirmation the 12.1 application is treated as received on the confirmation date.", async () => {
  const t = siiTimers({ identified_on: D("2026-10-01"), lossmit_pending: true, confirmed_on: D("2026-11-03") });
  assert.deepEqual(t, { docs_description_due: "2026-10-05", facilitate_due: "2026-10-02", reviewer_flag: "sii_pending_confirmation", application_received_date: "2026-11-03" });
  assert.equal(siiTimers({ identified_on: D("2026-10-01"), lossmit_pending: false }).docs_description_due, "2026-10-08");
  assert.deepEqual(siiPolicyDue(D("2026-10-20"), true), { facilitate_due: "2026-10-21", docs_description_due: "2026-10-22", determination_due: "2026-10-27", addl_docs_due: "2026-10-22" });
  const h = harness("2026-10-01T15:00:00.000Z");
  await h.run("4.4", "sii.open", CASE_AGENT, { case_id: "sii-8", notice_source: "lossmit_application", transfer_type: "death_relative", notice_date: "2026-10-01" });
  const lm = (await h.run("4.4", "sii.lossmit.pending", CASE_AGENT, { case_id: "sii-8", application_id: "lm-8" })).output as { reviewer_flag: string };
  assert.equal(lm.reviewer_flag, "sii_pending_confirmation"); assert.equal(h.rt.escalations.opened[0]!.kind, "lossmit_reviewer"); assert.equal(h.rt.escalations.opened[0]!.payload.flag, "sii_pending_confirmation");
  assert.equal(h.timer("REGX_1024_38B1VI_SII_LOSSMIT_INTERFERENCE")[0]!.status, "armed");
  const ident = (await h.run("4.4", "sii.potential_successor.identify", CASE_AGENT, { case_id: "sii-8", party_id: "p-son", identified_on: "2026-10-01" })).output as { docs_description_due: string; lossmit_pending: boolean };
  assert.deepEqual([ident.docs_description_due, ident.lossmit_pending], ["2026-10-05", true]); assert.equal(h.timer("REGX_1024_38B1VI_SII_DOCS_DESC_5")[0]!.dueDate, "2026-10-05");   // 2 federal BD, not 5
  await assert.rejects(h.run("4.4", "sii.documents.request", CASE_AGENT, { case_id: "sii-8", transfer_type: "death_relative", documents: ["death_certificate", "recorded_deed"], expedited: false }), refusedWith("EXPEDITE_WHEN_LOSSMIT_PENDING"));
  const req = (await h.run("4.4", "sii.documents.request", CASE_AGENT, { case_id: "sii-8", transfer_type: "death_relative", documents: ["death_certificate", "recorded_deed"] })).output as { expedited: boolean };
  assert.equal(req.expedited, true);                                                                                               // the record's pending flag expedites, whatever the caller says
  const recv = (await h.run("4.4", "sii.documents.receive", CASE_AGENT, { case_id: "sii-8", received_on: "2026-10-20", documents: ["death_certificate", "recorded_deed", "letters_testamentary", "will"], vesting_established: true }, "2026-10-20T15:00:00.000Z")).output as { determination_due: string };
  assert.equal(recv.determination_due, "2026-10-27"); assert.equal(h.timer("REGX_1024_38B1VI_SII_CONFIRM_10")[0]!.dueDate, "2026-10-27");                                                 // 5 federal BD, not 10
  const c = (await h.run("4.4", "sii.determine", CASE_AGENT, { case_id: "sii-8", determination: "confirmed", party_id: "p-son" }, "2026-10-27T15:00:00.000Z")).output as { lossmit_application_received_on: string };
  assert.equal(c.lossmit_application_received_on, "2026-10-27"); assert.equal(h.events.ofType("case.sii.confirmed")[0]!.payload.lossmit_application_received_on, "2026-10-27");             // 4.4-Q3: received on the confirmation date
  assert.equal(h.timer("REGX_1024_38B1VI_SII_LOSSMIT_INTERFERENCE")[0]!.status, "satisfied"); assert.equal(h.timer("REGX_1024_38B1VI_SII_CONFIRM_10")[0]!.status, "satisfied");
});
test("4.4-T9: Given a confirmed successor requests the payment history, then the response omits the deceased borrower's SSN and contact data (4.2-T6 linkage).", () => {
  assert.deepEqual(redactions("confirmed_successor"), ["other_borrowers.location_contact", "other_borrowers.personal_financial"]);
  const history = { payments: [{ on: "2026-08-01", amount_cents: 219_257n }], deceased_borrower: { ssn: "***-**-1234", phone: "(555) 010-0000" } };
  const omit = redactions("confirmed_successor"); const redacted = { ...history, deceased_borrower: omit.includes("other_borrowers.location_contact") ? undefined : history.deceased_borrower };
  assert.equal(redacted.deceased_borrower, undefined); assert.equal(redacted.payments.length, 1);
});
test("4.4-T10: Given an assumption is executed, then the `signing_officer` signature record exists, interested parties are notified within 10 servicer BD, MI approval is on file where MI exists, and the loan-data change (if any) is reported per 5.x.", async () => {
  const ok = assumptionExecuted({ executed_on: D("2026-12-01"), signing_officer_id: "so-1", mi_exists: true, mi_approval_on_file: true, terms_changed: false });
  assert.deepEqual(ok, { ok: true, problems: [], notify_interested_parties_by: "2026-12-15", loan_data_change: false });
  assert.deepEqual(assumptionExecuted({ executed_on: D("2026-12-01"), signing_officer_id: null, mi_exists: true, mi_approval_on_file: false, terms_changed: true }).problems, ["signing_officer signature record missing", "MI company approval not on file"]);
  const h = harness("2026-12-01T15:00:00.000Z");
  await h.run("4.4", "sii.open", CASE_AGENT, { case_id: "sii-10", notice_source: "letter", transfer_type: "death_relative" });
  await assert.rejects(h.run("4.4", "sii.interested_parties.notify", CASE_AGENT, { case_id: "sii-10", parties: [] }), refusedWith("INTERESTED_PARTIES"));
  const n = (await h.run("4.4", "sii.due_on_transfer.notify", CASE_AGENT, { case_id: "sii-10", basis: "junior lien foreclosure; enforceability doubtful" })).output as { wait_until: string };
  assert.equal(n.wait_until, "2027-01-30"); assert.equal(h.timer("FNMA_D1_4_1_02_FNMA_LEGAL_60")[0]!.dueDate, "2027-01-30");
  await assert.rejects(h.run("4.4", "sii.due_on_transfer.resolve", CASE_AGENT, { case_id: "sii-10", outcome: "maybe" }), refusedWith("FNMA_LEGAL_OUTCOME"));
  await h.run("4.4", "sii.due_on_transfer.resolve", CASE_AGENT, { case_id: "sii-10", outcome: "non_objection" }, "2027-01-10T15:00:00.000Z");
  assert.equal(h.timer("FNMA_D1_4_1_02_FNMA_LEGAL_60")[0]!.status, "satisfied");
});
test("4.4-T11: Given a state with a counsel-unreviewed matrix row, then the (i)(2) examples letter is used and the case is flagged `matrix_gap` for counsel.", () => {
  const r = documentDescription(null);
  assert.equal(r.letter, "i2_examples"); assert.equal(r.flag, "matrix_gap"); assert.equal(r.questions.length, 3);
  assert.deepEqual(documentDescription(["death certificate", "recorded deed"]), { letter: "matrix", documents: ["death certificate", "recorded deed"], flag: null, questions: [] });
});
test("4.4-T12: (fraud) Given a quitclaim from a 90-year-old borrower to an unrelated party filed last week, then `officer`/`attorney` escalation and no confirmation.", async () => {
  const r = fraudSignals({ instrument: "quitclaim", grantor_age: 90, grantee_related: false, recorded_days_ago: 7 });
  assert.deepEqual(r.escalate, ["officer", "attorney"]); assert.equal(r.confirm, false); assert.deepEqual(r.signals, ["fresh quitclaim to an unrelated party", "elderly grantor"]);
  assert.equal(fraudSignals({ instrument: "warranty_deed", grantee_related: true, recorded_days_ago: 400 }).confirm, true);
  const h = harness();
  await h.run("4.4", "sii.open", CASE_AGENT, { case_id: "sii-12", notice_source: "recorder_alert", transfer_type: "spouse_or_child_transfer" });
  const s = (await h.run("4.4", "sii.fraud.screen", CASE_AGENT, { case_id: "sii-12", instrument: "quitclaim", grantor_age: 90, grantee_related: false, recorded_days_ago: 7 })).output as { escalate: string[]; escalation_ids: string[] };
  assert.deepEqual(s.escalate, ["officer", "attorney"]); assert.deepEqual(h.rt.escalations.opened.map((e) => e.kind), ["officer", "attorney"]); assert.equal(s.escalation_ids.length, 2);
  assert.equal(h.events.ofType("case.sii.fraud_flagged").length, 1); assert.equal(h.rt.store.get("sii_cases", "sii-12")!.data.fraud_flagged, true);
  await assert.rejects(h.run("4.4", "sii.determine", CASE_AGENT, { case_id: "sii-12", determination: "confirmed", party_id: "p-stranger" }), refusedWith("FRAUD_FLAGGED_NEEDS_OFFICER"));   // no confirmation on a fraud-flagged file
  await assert.rejects(h.run("4.4", "sii.determine", CASE_AGENT, { case_id: "sii-12", determination: "confirmed", party_id: "p-stranger", officer_approval_id: "invented" }), refusedWith("FRAUD_FLAGGED_NEEDS_OFFICER"));
  assert.equal(h.events.ofType("case.sii.confirmed").length, 0);
});
