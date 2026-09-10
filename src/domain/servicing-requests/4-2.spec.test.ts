// 4.2 Request for Information (RFI)
// spec/sections/04-customer-service-borrower-communications/4-2-request-for-information-rfi.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
void cents;
import * as R from "./rfi.ts";
import { recordingsResponse, potentialSuccessorRfi, duplicativeRfi, untimelyRfi, custodianExtension, earlyResponse, privilegeRouting } from "./ops.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { harness, CASE_AGENT, ATTORNEY, refusedWith } from "./test-harness.ts";
import { federalDays } from "./clocks.ts";
const notices = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };
const sent = (h: ReturnType<typeof harness>, template: string, caseId: string) => h.events.append({ type: "notice.sent", loanId: "L-1", actor: CASE_AGENT, payload: { template, case_id: caseId, notice_id: `n-${template}-${caseId}` } });

test("4.2-T1: Given a letter received 2026-09-04 asking for the owner, then `NTC_REGX_36A2_OWNER_IDENTITY` is sent by 2026-09-21 with the exact A4-1-03 block for the loan's ownership type and the \"as of\" sentence.", async () => {
  const h = harness();
  await assert.rejects(h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-0", receipt_date: "2026-09-04", items: [] }), refusedWith("RFI_NEEDS_ITEM"));
  const p = (await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-1", receipt_date: "2026-09-04", items: [{ id: "i1", kind: "owner_identity", description: "who owns my loan" }] })).output as { items: { response_due: string }[] };
  assert.equal(p.items[0]!.response_due, "2026-09-21");
  assert.equal(h.timer("REGX_1024_36D_RFI_OWNER_10")[0]!.dueDate, "2026-09-21"); assert.equal(h.timer("REGX_1024_36C_RFI_ACK_5")[0]!.dueDate, "2026-09-14"); assert.equal(h.timer("REGX_1024_36D_RFI_RESPONSE_30").length, 0);
  h.clock.set("2026-09-09T15:00:00.000Z"); sent(h, "NTC_REGX_35D_ACK", "noe-x");
  assert.equal(h.timer("REGX_1024_36C_RFI_ACK_5")[0]!.status, "armed");                                                       // an NoE ack on the loan is not the RFI ack
  sent(h, "NTC_REGX_36C_ACK", "rfi-1"); assert.equal(h.timer("REGX_1024_36C_RFI_ACK_5")[0]!.status, "satisfied");
  const block = R.ownerIdentity("fnma_portfolio");
  assert.equal(block, "Fannie Mae, Midtown Center, 1100 15th Street NW, Washington, DC 20005, 1-800-2FANNIE (1-800-232-6643)");
  assert.equal(R.ownerIdentity("fnma_mbs_trust"), "Fannie Mae in its capacity as Trustee, Midtown Center, 1100 15th Street NW, Washington, DC 20005, 1-800-2FANNIE (1-800-232-6643)");
  assert.match(R.ownerIdentity("fnma_mbs_trust", true, "123456"), /Trustee \(trust identifier: Fannie Mae MBS pool 123456\), Midtown Center/); assert.equal(R.FNMA_OWNER_BLOCK.version, "A4-1-03 (12/20/2023)");
  const v = notices().activeVersion("NTC_REGX_36A2_OWNER_IDENTITY", D("2026-09-21"))!;
  const payload = { ...v.samplePayload, owner_block: block, owner_block_version: R.FNMA_OWNER_BLOCK.version, as_of: "2026-09-21" };
  const rendered = render(v.source, payload);
  assert.match(rendered.text, /The owner of your mortgage loan is Fannie Mae, Midtown Center, 1100 15th Street NW, Washington, DC 20005, 1-800-2FANNIE \(1-800-232-6643\)\. This is based on our review of our records as of September 21, 2026; the owner may change\./);
  assert.equal(evaluateChecklist(v, payload, rendered).passed, true);
  const bad = { ...payload, owner_block: "Fannie Mae, 3900 Wisconsin Avenue NW" }; assert.ok(evaluateChecklist(v, bad, render(v.source, bad)).blocking.some((b) => b.rule_id === "fannie-mae-block"));
  const stale = { ...payload, owner_block_version: "A4-1-03 (2019)" }; assert.ok(evaluateChecklist(v, stale, render(v.source, stale)).blocking.some((b) => b.rule_id === "block-version"));
  await assert.rejects(h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-1", item_ids: ["i1"], ownership: "fnma_portfolio", owner_block: block, template: "NTC_REGX_36A2_OWNER_IDENTITY" }), refusedWith("ITEMS_UNDETERMINED"));   // the item's determination comes first
  await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-1", item_id: "i1", determination: "provided" });
  await assert.rejects(h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-1", item_ids: ["i1"], ownership: "fnma_portfolio", owner_block: "Fannie Mae, 3900 Wisconsin Avenue NW", template: "NTC_REGX_36A2_OWNER_IDENTITY" }), refusedWith("OWNER_BLOCK_VERSIONED"));
  await h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-1", item_ids: ["i1"], ownership: "fnma_portfolio", owner_block: block, template: "NTC_REGX_36A2_OWNER_IDENTITY" }, "2026-09-21T15:00:00.000Z");
  assert.equal(h.timer("REGX_1024_36D_RFI_OWNER_10")[0]!.status, "satisfied"); assert.equal(h.events.ofType("case.rfi.responded")[0]!.payload.owner_block_version, R.FNMA_OWNER_BLOCK.version);
});
test("4.2-T2: Given the same letter also asks for a payment history since 2019, then the history item is due 2026-10-20 and the extension command before that date moves it to 2026-11-10 with an extension notice stating reasons.", async () => {
  const h = harness();
  const p = (await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-2", receipt_date: "2026-09-04", items: [{ id: "i1", kind: "owner_identity" }, { id: "i2", kind: "standard", description: "a complete payment history since 2019" }] })).output as { items: { id: string; response_due: string; extendable: boolean }[] };
  assert.deepEqual(p.items.map((i) => [i.id, i.response_due, i.extendable]), [["i1", "2026-09-21", false], ["i2", "2026-10-20", true]]);
  const original = h.timer("REGX_1024_36D_RFI_RESPONSE_30")[0]!; assert.equal(original.dueDate, "2026-10-20"); assert.equal(h.timer("REGX_1024_36D_RFI_EXT_NOTICE_BEFORE_30")[0]!.dueDate, "2026-10-20"); assert.equal(h.timer("REGX_1024_36D_RFI_OWNER_10")[0]!.dueDate, "2026-09-21");
  // the owner item answered on day 10 satisfies only the owner clock (rule 1: each item has its own profile)
  await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-2", item_id: "i1", determination: "provided" });
  await h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-2", item_ids: ["i1"], template: "NTC_REGX_36A2_OWNER_IDENTITY" }, "2026-09-18T15:00:00.000Z");
  assert.equal(h.timer("REGX_1024_36D_RFI_OWNER_10")[0]!.status, "satisfied"); assert.equal(original.status, "armed"); assert.equal(h.timer("SM_RFI_INTERNAL_TARGET_7")[0]!.status, "armed");
  await assert.rejects(h.run("4.2", "rfi.item.extend", CASE_AGENT, { case_id: "rfi-2", item_id: "i2" }, "2026-10-19T15:00:00.000Z"), refusedWith("EXTENSION_REASON"));
  const ext = (await h.run("4.2", "rfi.item.extend", CASE_AGENT, { case_id: "rfi-2", item_id: "i2", reason: "document custodian retrieval" }, "2026-10-19T15:00:00.000Z")).output as Record<string, unknown>;
  assert.deepEqual({ ...ext, response_timer_id: null }, { original_due: "2026-10-20", new_due: "2026-11-10", notice: "NTC_REGX_36D_EXTENSION", reason: "document custodian retrieval", response_timer_id: null });
  // the 30-day clock moved to 2026-11-10 (the original instance closed as extended) and does not breach on 10-22
  assert.equal(original.status, "cancelled"); assert.match(original.cancelledReason!, /extended \+15 business_days_federal/);
  const moved = h.timer("REGX_1024_36D_RFI_RESPONSE_30")[1]!; assert.equal(moved.id, ext.response_timer_id); assert.equal(moved.dueDate, "2026-11-10");
  assert.deepEqual(h.ctx.timers.evaluate("2026-10-22T12:00:00.000Z").map((b) => b.def.code).filter((c) => c === "REGX_1024_36D_RFI_RESPONSE_30"), []);
  sent(h, "NTC_REGX_36C_ACK", "rfi-2"); assert.equal(h.timer("REGX_1024_36D_RFI_EXT_NOTICE_BEFORE_30")[0]!.status, "breached");      // an ack is not the extension notice (the gate breached on 10-20)
  sent(h, "NTC_REGX_36D_EXTENSION", "rfi-2"); assert.equal(h.timer("REGX_1024_36D_RFI_EXT_NOTICE_BEFORE_30")[0]!.status, "satisfied_late");
  await assert.rejects(h.run("4.2", "rfi.item.extend", CASE_AGENT, { case_id: "rfi-2", item_id: "i2", reason: "late" }, "2026-10-21T15:00:00.000Z"), refusedWith("EXTENSION_LATE"));
  await assert.rejects(h.run("4.2", "rfi.item.extend", CASE_AGENT, { case_id: "rfi-2", item_id: "i2", reason: "again" }, "2026-10-19T16:00:00.000Z"), refusedWith("EXTENSION_ONCE"));
  const v = notices().activeVersion("NTC_REGX_36D_EXTENSION", D("2026-10-19"))!;
  const payload = { ...v.samplePayload, reason: "document custodian retrieval", new_due: "2026-11-10" }; const rr = render(v.source, payload);
  assert.match(rr.text, /Reason: document custodian retrieval\. We will respond by November 10, 2026/); assert.equal(evaluateChecklist(v, payload, rr).passed, true);
  const noReason = { ...payload, reason: "" }; assert.ok(evaluateChecklist(v, noReason, render(v.source, noReason)).blocking.some((b) => b.rule_id === "reason"));
  await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-2", item_id: "i2", determination: "provided" });
  await h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-2", item_ids: ["i2"], template: "NTC_REGX_36D_RESPONSE" }, "2026-11-05T15:00:00.000Z");
  assert.equal(moved.status, "satisfied"); assert.equal(h.timer("SM_RFI_INTERNAL_TARGET_7")[0]!.status, "satisfied_late");
});
test("4.2-T3: Given an extension attempted on an owner-identity item, then rejected `EXTENSION_NOT_PERMITTED`.", async () => {
  const h = harness();
  await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-3", receipt_date: "2026-09-04", items: [{ id: "i1", kind: "owner_identity" }] });
  await assert.rejects(h.run("4.2", "rfi.item.extend", CASE_AGENT, { case_id: "rfi-3", item_id: "i1", item_kind: "standard", reason: "checking LSDU" }, "2026-09-10T15:00:00.000Z"), refusedWith("EXTENSION_NOT_PERMITTED"));   // the item kind comes from the record, not the caller
  await assert.rejects(h.run("4.2", "rfi.item.extend", CASE_AGENT, { case_id: "rfi-3", item_id: "i9", reason: "x" }), refusedWith("ITEM_NOT_FOUND"));
  assert.deepEqual(R.extendItem(R.itemDeadlines("owner_identity", D("2026-09-04")), D("2026-09-10")), { error: "EXTENSION_NOT_PERMITTED" });
  assert.equal(h.events.ofType("case.rfi.extended").length, 0);
});
test("4.2-T4: Given a request for \"all Fannie Mae guidelines you used,\" then `exception_irrelevant` for the guidelines and the borrower's own evaluation results are provided; (f)(2) notice within 5 federal BD.", async () => {
  const h = harness();
  await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-4", receipt_date: "2026-09-04", items: [{ id: "g", kind: "standard", description: "all Fannie Mae guidelines you used" }, { id: "e", kind: "standard", description: "my own evaluation inputs and result" }] });
  assert.equal(R.exception({ asks_for: "investor_guidelines", received_on: D("2026-09-04") }), "irrelevant"); assert.equal(R.exception({ asks_for: "own_evaluation", received_on: D("2026-09-04") }), null);
  const g = (await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-4", item_id: "g", determination: "exception_irrelevant" }, "2026-09-09T15:00:00.000Z")).output as { exception_notice_due: string };
  assert.equal(g.exception_notice_due, "2026-09-16"); assert.equal(h.timer("REGX_1024_36F2_RFI_EXCEPTION_NOTICE_5")[0]!.dueDate, "2026-09-16");   // 5 federal BD after the 09-09 determination
  assert.equal(h.events.ofType("case.rfi.exception_determined")[0]!.payload.exception_basis, "irrelevant");
  await assert.rejects(h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-4", item_id: "e", determination: "exception_irrelevant" }), refusedWith("IRRELEVANT_OWN_RECORDS"));   // detected from the item's description on the record
  await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-4", item_id: "e", determination: "provided" });
  assert.equal(h.rt.store.get("case_request_items", "rfi-4:e")!.data.determination, "provided"); assert.equal(h.rt.store.get("case_request_items", "rfi-4:g")!.data.determination, "exception_irrelevant");
  sent(h, "NTC_REGX_36D_RESPONSE", "rfi-4"); assert.equal(h.timer("REGX_1024_36F2_RFI_EXCEPTION_NOTICE_5")[0]!.status, "armed");   // the response letter is not the (f)(2) notice
  sent(h, "NTC_REGX_36F2_EXCEPTION", "rfi-4"); assert.equal(h.timer("REGX_1024_36F2_RFI_EXCEPTION_NOTICE_5")[0]!.status, "satisfied");
});
test("4.2-T5: Given a request for call recordings from 14 months ago within retention, then audio files are provided (secure message if consented, else mailed media/transcript per policy) within 30 days.", async () => {
  const r = recordingsResponse({ requested_on: D("2026-09-04"), call_on: D("2025-07-10"), retention_months: 60, esign_consented: true });
  assert.deepEqual(r, { available: true, format: "audio_secure_message", response_due: "2026-10-20" });
  assert.equal(recordingsResponse({ requested_on: D("2026-09-04"), call_on: D("2025-07-10"), retention_months: 60, esign_consented: false }).format, "mailed_media_or_transcript");
  // a `not_available` answer needs the search log over the mandatory classes (online, offsite_reasonable), not a caller's flag
  const h = harness();
  await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-5", receipt_date: "2026-09-04", items: [{ id: "c", kind: "standard", description: "recordings of my calls in July 2025" }] });
  assert.deepEqual(R.searchLogComplete([{ system: "call_recordings", availability_class: "online", searched_at: "2026-09-08T14:00:00Z" }]).missing, ["offsite_reasonable"]);
  await assert.rejects(h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-5", item_id: "c", determination: "not_available", search_log_complete: true, search_log: [{ system: "call_recordings", availability_class: "online", searched_at: "2026-09-08T14:00:00Z" }] }), refusedWith("NOT_AVAILABLE_WITHOUT_SEARCH_LOG"));
  await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-5", item_id: "c", determination: "not_available", not_available_basis: "retention period: recordings are kept 5 years", search_log: [{ system: "call_recordings", availability_class: "online", searched_at: "2026-09-08T14:00:00Z" }, { system: "archive", availability_class: "offsite_reasonable", searched_at: "2026-09-09T14:00:00Z" }] });
  assert.equal(h.rt.store.get("case_request_items", "rfi-5:c")!.data.determination, "not_available");
});
test("4.2-T6: Given a confirmed successor requests the payment history, then the response omits the deceased borrower's SSN/contact/financial data but includes terms, status and history; redaction log present.", async () => {
  const { response, redaction_log } = R.redactForSuccessor({ loan_terms: { rate_pct: "6.500", maturity: "2051-08-01" }, status: "current", payment_history: [{ on: "2026-08-01", amount_cents: 219_257n }] }, { ssn: "***-**-1234", phone: "(555) 010-0000", address: "1 Test St", income_cents: 900_000n });
  assert.deepEqual(response.other_borrower, {}); assert.equal(response.status, "current"); assert.equal(response.loan_terms.rate_pct, "6.500"); assert.equal(response.payment_history.length, 1);
  assert.deepEqual(redaction_log, [{ field: "other_borrower.ssn", rule: "other_borrowers.personal_financial" }, { field: "other_borrower.phone", rule: "other_borrowers.location_contact" }, { field: "other_borrower.address", rule: "other_borrowers.location_contact" }, { field: "other_borrower.income_cents", rule: "other_borrowers.personal_financial" }]);
  assert.deepEqual(R.redactions("confirmed_successor"), ["other_borrowers.location_contact", "other_borrowers.personal_financial"]);
  const unredacted = { loan_terms: { rate_pct: "6.500" }, status: "current", payment_history: [{ on: "2026-08-01", amount_cents: 219_257n }], other_borrower: { ssn: "123-45-6789", phone: "(555) 010-0000", address: "1 Test St", income_cents: 900_000n } };
  assert.deepEqual(R.redactionCheck("confirmed_successor", unredacted).violations.map((v) => v.field), ["other_borrower.ssn", "other_borrower.phone", "other_borrower.address", "other_borrower.income_cents"]);
  assert.equal(R.redactionCheck("confirmed_successor", response).passed, true);
  const h = harness();
  await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-6", receipt_date: "2026-09-04", requester_role: "confirmed_successor", items: [{ id: "h", kind: "standard", description: "payment history" }] });
  await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-6", item_id: "h", determination: "provided" });
  await assert.rejects(h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-6", item_ids: ["h"], redaction_check_passed: true }), refusedWith("REDACTION_BEFORE_SEND"));                          // a flag is not a redaction check: the content goes through the detector
  await assert.rejects(h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-6", item_ids: ["h"], response_data: unredacted }), refusedWith("REDACTION_BEFORE_SEND"));                             // the deceased borrower's SSN/contact/income block the send
  await h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-6", item_ids: ["h"], response_data: response, redaction_log, template: "NTC_REGX_36D_RESPONSE" });
  assert.equal(h.events.ofType("case.rfi.responded").length, 1); assert.equal(h.events.ofType("case.rfi.responded")[0]!.payload.redaction_check_passed, true); assert.deepEqual(h.events.ofType("case.rfi.responded")[0]!.payload.redaction_log, redaction_log);
  assert.equal(h.timer("REGX_1024_36D_RFI_RESPONSE_30")[0]!.status, "satisfied");
});
test("4.2-T7: Given a potential successor's letter naming the deceased borrower, then `NTC_REGX_36I_SII_DOCS` is sent within 5 federal BD (policy) and no later than 30; an `sii` case opens (4.4); no account information is disclosed.", async () => {
  // 30 federal BD from 2026-10-02 excluding Columbus Day and Veterans Day is 2026-11-17 (the spec's hand-count of 11-13 is short by two days; flagged for the audit).
  assert.deepEqual(potentialSuccessorRfi(D("2026-10-02")), { notice: "NTC_REGX_36I_SII_DOCS", target_on: "2026-10-09", latest_on: "2026-11-17", opens_case: "sii", account_information_disclosed: false });
  const h = harness("2026-10-02T15:00:00.000Z");
  const p = (await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-7", receipt_date: "2026-10-02", is_potential_successor_request: true, transfer_type: "death_relative", party_id: "p-daughter", items: [{ id: "d", kind: "standard", description: "what do you need from me to be recognized after my mother's death" }] })).output as { sii_docs_due: string; sii_case_id: string; requester_role: string };
  assert.deepEqual([p.sii_docs_due, p.sii_case_id, p.requester_role], ["2026-11-17", "sii-rfi-7", "potential_successor"]);
  assert.equal(h.timer("REGX_1024_36I_SII_RFI_RESPONSE_30")[0]!.dueDate, "2026-11-17"); assert.equal(h.timer("SM_RFI_SII_DOCS_TARGET_5")[0]!.dueDate, "2026-10-09"); assert.equal(h.timer("REGX_1024_36C_RFI_ACK_5")[0]!.dueDate, "2026-10-09");
  assert.equal(h.rt.store.get("sii_cases", "sii-rfi-7")!.data.case_type, "sii"); assert.equal(h.events.ofType("case.sii.opened").length, 1);                                       // the 4.4 case opened
  assert.equal(h.timer("REGX_1024_38B1VI_SII_FACILITATE_2")[0]!.dueDate, "2026-10-06"); assert.equal(h.timer("REGX_1024_38B1VI_SII_DOCS_DESC_5")[0]!.dueDate, "2026-10-09");
  await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-7", item_id: "d", determination: "provided" });
  await assert.rejects(h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-7", item_ids: ["d"], template: "NTC_REGX_36I_SII_DOCS", account_information_included: true, response_data: { documents: ["death certificate"] } }), refusedWith("SII_NO_ACCOUNT_INFO"));
  await assert.rejects(h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-7", item_ids: ["d"], template: "NTC_REGX_36I_SII_DOCS", response_data: { documents: ["death certificate"], payment_history: [{ on: "2026-08-01", amount_cents: 219_257n }] } }), refusedWith("SII_NO_ACCOUNT_INFO"));   // the detector finds the account section
  await h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-7", item_ids: ["d"], template: "NTC_REGX_36I_SII_DOCS", response_data: { documents: ["death certificate", "recorded deed", "letters testamentary", "the will"], questions: ["How did the deceased hold title?"] } }, "2026-10-08T15:00:00.000Z");
  sent(h, "NTC_REGX_36D_RESPONSE", "rfi-7"); assert.equal(h.timer("REGX_1024_36I_SII_RFI_RESPONSE_30")[0]!.status, "armed");                                                       // only the (i) document description satisfies
  sent(h, "NTC_REGX_36I_SII_DOCS", "rfi-7");
  for (const c of ["REGX_1024_36I_SII_RFI_RESPONSE_30", "SM_RFI_SII_DOCS_TARGET_5", "REGX_1024_36C_RFI_ACK_5", "REGX_1024_38B1VI_SII_DOCS_DESC_5"]) assert.equal(h.timer(c)[0]!.status, "satisfied", c);   // the docs notice is the early response too
  // the (i)(2) examples path says a more individualized list is available with more information; no account information appears
  const v = notices().activeVersion("NTC_REGX_36I_SII_DOCS", D("2026-10-08"))!; const rr = render(v.source, v.samplePayload);
  assert.match(rr.text, /These are examples of the documents we typically accept; once you tell us more, we can send a list specific to your situation\./); assert.equal(evaluateChecklist(v, v.samplePayload, rr).passed, true);
  const noStatement = render(v.source.replace(/These are examples[^.]*\./, ""), v.samplePayload); assert.ok(evaluateChecklist(v, v.samplePayload, noStatement).blocking.some((b) => b.rule_id === "individualized-list"));
  const leak = { ...v.samplePayload, documents: ["death certificate", "your payment history shows a past due balance"] }; assert.ok(evaluateChecklist(v, leak, render(v.source, leak)).blocking.some((b) => b.rule_id === "no-account-info"));
});
test("4.2-T8: Given a request identical to one answered 3 months ago for the same period, then duplicative exception; for a new period, answered.", async () => {
  assert.equal(duplicativeRfi({ prior_answered_on: D("2026-06-04"), prior_period: "2025", period: "2025", received_on: D("2026-09-04") }), "duplicative");
  assert.equal(duplicativeRfi({ prior_answered_on: D("2026-06-04"), prior_period: "2025", period: "2026", received_on: D("2026-09-04") }), null);
  assert.equal(R.exception({ asks_for: "records", answered_same_item_within_12m: true, received_on: D("2026-09-04") }), "duplicative");
  // the prior case (answered 2026-06-04, payment history for 2025) and the new letter with the same item plus a new-period item
  const h = harness("2026-06-01T14:00:00.000Z");
  await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-8p", receipt_date: "2026-05-01", items: [{ id: "h25", kind: "standard", description: "payment history for 2025" }] });
  await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-8p", item_id: "h25", determination: "provided" });
  await h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-8p", item_ids: ["h25"], template: "NTC_REGX_36D_RESPONSE" }, "2026-06-04T15:00:00.000Z");
  const prior = h.events.ofType("case.rfi.responded").find((e) => e.payload.case_id === "rfi-8p")!; assert.equal(prior.occurredAt.slice(0, 10), "2026-06-04");
  await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-8", receipt_date: "2026-09-04", items: [{ id: "d", kind: "standard", description: "payment history for 2025" }, { id: "n", kind: "standard", description: "payment history for 2026" }] }, "2026-09-04T14:00:00.000Z");
  assert.equal(duplicativeRfi({ prior_answered_on: D(prior.occurredAt.slice(0, 10)), prior_period: "2025", period: "2025", received_on: D("2026-09-04") }), "duplicative");
  const dup = (await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-8", item_id: "d", determination: "exception_duplicative" })).output as { exception_notice_due: string };
  assert.equal(dup.exception_notice_due, "2026-09-14"); assert.equal(h.timer("REGX_1024_36F2_RFI_EXCEPTION_NOTICE_5")[0]!.dueDate, "2026-09-14");            // (f)(2) notice within 5 federal BD of the 09-04 determination (Labor Day excluded)
  assert.equal(h.events.ofType("case.rfi.exception_determined").at(-1)!.payload.exception_basis, "duplicative"); assert.equal(h.rt.store.get("case_request_items", "rfi-8:d")!.data.determination, "exception_duplicative");
  await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-8", item_id: "n", determination: "provided" });                                          // the new period is answered
  h.clock.set("2026-09-10T15:00:00.000Z"); sent(h, "NTC_REGX_36F2_EXCEPTION", "rfi-8"); assert.equal(h.timer("REGX_1024_36F2_RFI_EXCEPTION_NOTICE_5")[0]!.status, "satisfied");
  const resp = h.timer("REGX_1024_36D_RFI_RESPONSE_30").find((t) => t.status === "armed")!; assert.equal(resp.dueDate, "2026-10-20");
  await h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-8", item_ids: ["n"], template: "NTC_REGX_36D_RESPONSE" }, "2026-09-18T15:00:00.000Z");
  assert.equal(resp.status, "satisfied"); assert.equal(h.rt.store.get("case_request_items", "rfi-8:n")!.data.responded_on, "2026-09-18"); assert.equal(h.rt.store.get("case_request_items", "rfi-8:n")!.data.determination, "provided");
});
test("4.2-T9: Given a discharge 13 months before receipt, then untimely notice within 5 federal BD.", async () => {
  assert.deepEqual(untimelyRfi({ discharge_or_transfer_on: D("2025-08-04"), received_on: D("2026-09-04") }), { exception: "untimely", notice_due: "2026-09-14" });
  assert.equal(untimelyRfi({ discharge_or_transfer_on: D("2025-10-04"), received_on: D("2026-09-04") }).exception, null);
  assert.equal(R.exception({ asks_for: "records", received_on: D("2026-09-04"), transfer_out_or_discharge_on: D("2025-08-04") }), "untimely");
  const h = harness();
  await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-9", receipt_date: "2026-09-04", items: [{ id: "r", kind: "standard", description: "the servicing records for my loan discharged 2025-08-04" }] });
  const det = (await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-9", item_id: "r", determination: "exception_untimely" })).output as { exception_notice_due: string };
  assert.equal(det.exception_notice_due, "2026-09-14");                                                                                                          // 5 federal BD from Fri 09-04: 09-08 (Labor Day skipped) … 09-14
  const ex = h.timer("REGX_1024_36F2_RFI_EXCEPTION_NOTICE_5")[0]!; assert.equal(ex.dueDate, "2026-09-14"); assert.equal(ex.status, "armed");
  assert.equal(h.events.ofType("case.rfi.exception_determined")[0]!.payload.exception_basis, "untimely"); assert.equal(h.events.ofType("case.rfi.exception_determined")[0]!.payload.determination_date, "2026-09-04");
  const v = notices().activeVersion("NTC_REGX_36F2_EXCEPTION", D("2026-09-11"))!;
  const payload = { ...v.samplePayload, items: [{ n: 1, text: "the servicing records for my loan", basis: "untimely" }], provided: "nothing further — the request came more than one year after the discharge", business_days_after_determination: 5 };
  const rr = render(v.source, payload); assert.match(rr.text, /\(1\) the servicing records for my loan — untimely;/); assert.equal(evaluateChecklist(v, payload, rr).passed, true);
  const late = { ...payload, business_days_after_determination: 6 }; assert.ok(evaluateChecklist(v, late, render(v.source, late)).blocking.some((b) => b.rule_id === "timing-5"));
  sent(h, "NTC_REGX_36D_RESPONSE", "rfi-9"); assert.equal(ex.status, "armed");                                                                                     // a response letter is not the (f)(2) notice
  h.clock.set("2026-09-11T15:00:00.000Z"); sent(h, "NTC_REGX_36F2_EXCEPTION", "rfi-9");
  assert.equal(ex.status, "satisfied"); assert.equal(h.timer("REGX_1024_36C_RFI_ACK_5")[0]!.status, "satisfied");                                                  // the exception notice is the acknowledgment too (timer table)
  assert.deepEqual(h.ctx.timers.evaluate("2026-09-15T12:00:00.000Z").map((b) => b.def.code).filter((c) => c === "REGX_1024_36F2_RFI_EXCEPTION_NOTICE_5"), []);
});
test("4.2-T10: Given the custodian copy request takes 12 BD, then the case uses the extension and responds within 45 total days; the extension notice cites the custodian retrieval.", async () => {
  const r = custodianExtension(D("2026-09-04"), 12);
  assert.equal(r.extension_used, true); assert.equal(r.extension_notice_by, "2026-10-20"); assert.equal(r.response_due, "2026-11-10"); assert.equal(r.reason, "document custodian retrieval");
  assert.equal(custodianExtension(D("2026-09-04"), 5).extension_used, false);
  assert.equal(federalDays(D("2026-09-04"), 45), "2026-11-10");                                                                                                    // 30 + 15 federal BD (Labor Day, Columbus Day excluded)
  const h = harness();
  await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-10", receipt_date: "2026-09-04", items: [{ id: "note", kind: "standard", description: "a copy of my note (original held by the document custodian)" }] });
  const original = h.timer("REGX_1024_36D_RFI_RESPONSE_30")[0]!; assert.equal(original.dueDate, "2026-10-20"); assert.equal(h.timer("REGX_1024_36D_RFI_EXT_NOTICE_BEFORE_30")[0]!.dueDate, "2026-10-20");
  // the custodian's 12-BD retrieval (SLA 10) means the copy lands after day 30 cannot be met without the (d)(2)(ii) extension: extend before 10-20, citing the retrieval
  const ext = (await h.run("4.2", "rfi.item.extend", CASE_AGENT, { case_id: "rfi-10", item_id: "note", reason: `${r.reason} (custodian.request_copy: 12 business days)` }, "2026-09-22T15:00:00.000Z")).output as { original_due: string; new_due: string; notice: string; reason: string };
  assert.deepEqual([ext.original_due, ext.new_due, ext.notice], ["2026-10-20", "2026-11-10", "NTC_REGX_36D_EXTENSION"]); assert.match(ext.reason, /custodian retrieval/);
  assert.equal(original.status, "cancelled"); const moved = h.timer("REGX_1024_36D_RFI_RESPONSE_30")[1]!; assert.equal(moved.dueDate, r.response_due);
  assert.equal(h.rt.store.get("case_request_items", "rfi-10:note")!.data.response_due, "2026-11-10"); assert.match(String(h.rt.store.get("case_request_items", "rfi-10:note")!.data.extension_reason), /custodian/);
  const v = notices().activeVersion("NTC_REGX_36D_EXTENSION", D("2026-09-22"))!;
  const payload = { ...v.samplePayload, reason: ext.reason, new_due: ext.new_due, business_days_after_receipt: 12 }; const rr = render(v.source, payload);
  assert.match(rr.text, /Reason: document custodian retrieval \(custodian\.request_copy: 12 business days\)\. We will respond by November 10, 2026/); assert.equal(evaluateChecklist(v, payload, rr).passed, true);
  sent(h, "NTC_REGX_36D_EXTENSION", "rfi-10"); assert.equal(h.timer("REGX_1024_36D_RFI_EXT_NOTICE_BEFORE_30")[0]!.status, "satisfied");                            // notice before the original 30 days end
  await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-10", item_id: "note", determination: "provided" }, "2026-10-08T15:00:00.000Z");
  await h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-10", item_ids: ["note"], template: "NTC_REGX_36D_RESPONSE" }, "2026-11-09T15:00:00.000Z");        // day 44
  assert.equal(moved.status, "satisfied"); assert.deepEqual(h.ctx.timers.evaluate("2026-11-12T12:00:00.000Z").map((b) => b.def.code).filter((c) => c === "REGX_1024_36D_RFI_RESPONSE_30"), []);
});
test("4.2-T11: (early response) Given a simple escrow-statement copy request answered on day 3, then the ack timer cancels with reason `early_response`.", async () => {
  assert.deepEqual(earlyResponse(D("2026-09-04"), D("2026-09-09")), { qualifies: true, cancel_reason: "early_response", notice: "NTC_REGX_36E_EARLY" });
  assert.equal(earlyResponse(D("2026-09-04"), D("2026-09-15")).qualifies, false);
  const h = harness();
  await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-11", receipt_date: "2026-09-04", items: [{ id: "s", kind: "standard", description: "a copy of your last escrow statement" }] });
  const ack = h.timer("REGX_1024_36C_RFI_ACK_5")[0]!, resp = h.timer("REGX_1024_36D_RFI_RESPONSE_30")[0]!;
  const start = (await h.run("4.2", "rfi.early_response.start", CASE_AGENT, { case_id: "rfi-11" }, "2026-09-08T15:00:00.000Z")).output as { letter_due: string };
  assert.equal(start.letter_due, "2026-09-14"); assert.equal(h.timer("REGX_1024_36E_RFI_EARLY_RESPONSE_5")[0]!.dueDate, "2026-09-14");   // 5 federal BD from Fri 09-04 (Labor Day excluded)
  const er = (await h.run("4.2", "rfi.early_respond", CASE_AGENT, { case_id: "rfi-11", item_ids: ["s"] }, "2026-09-09T15:00:00.000Z")).output as { qualifies: boolean; cancel_reason: string; timers_cancelled: string[] };   // day 3
  assert.equal(er.qualifies, true); assert.equal(er.cancel_reason, "early_response"); assert.deepEqual(er.timers_cancelled, ["REGX_1024_36C_RFI_ACK_5"]); assert.equal(h.timer("SM_RFI_INTERNAL_TARGET_7")[0]!.status, "satisfied");
  assert.deepEqual([ack.status, ack.cancelledReason], ["cancelled", "early_response"]); assert.equal(resp.status, "satisfied");                                              // the early answer is the response
  sent(h, "NTC_REGX_36E_EARLY", "rfi-11"); assert.equal(h.timer("REGX_1024_36E_RFI_EARLY_RESPONSE_5")[0]!.status, "satisfied");
  const h2 = harness();
  await h2.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-11b", receipt_date: "2026-09-04", items: [{ id: "s", kind: "standard" }] });
  await assert.rejects(h2.run("4.2", "rfi.early_respond", CASE_AGENT, { case_id: "rfi-11b" }, "2026-09-15T15:00:00.000Z"), refusedWith("EARLY_RESPONSE_WINDOW"));        // after day 5 the std path applies
  assert.equal(h2.timer("REGX_1024_36C_RFI_ACK_5")[0]!.status, "armed");
});
test("4.2-T12: (NY) Given a NY loan, then owner identity is due in 10 calendar days if earlier than the federal 10-BD date, and the response carries the 419.6 disclosure block.", async () => {
  assert.equal(R.itemDeadlines("owner_identity", D("2026-09-04"), "NY").response_due, "2026-09-14"); assert.equal(R.itemDeadlines("owner_identity", D("2026-09-04")).response_due, "2026-09-21");
  const h = harness();
  await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-12", receipt_date: "2026-09-04", state: "NY", items: [{ id: "i1", kind: "owner_identity" }] });
  assert.equal(h.timer("NY_419_6_RFI_OWNER_10D")[0]!.dueDate, "2026-09-14"); assert.equal(h.timer("REGX_1024_36D_RFI_OWNER_10")[0]!.dueDate, "2026-09-21");
  const v = notices().activeVersion("NTC_REGX_36A2_OWNER_IDENTITY", D("2026-09-14"))!;
  const ny = { ...v.samplePayload, ny: true }; const rr = render(v.source, ny);
  assert.match(rr.text, /Under 3 NYCRR 419\.6 you may also contact the New York State Department of Financial Services Consumer Assistance Unit at \(800\) 342-3736\./); assert.equal(evaluateChecklist(v, ny, rr).passed, true);
  const stripped = render(v.source.replace(/\{\{#if ny\}\}[\s\S]*?\{\{\/if\}\}/, ""), ny); assert.ok(evaluateChecklist(v, ny, stripped).blocking.some((b) => b.rule_id === "ny-419-6"));
  assert.equal(evaluateChecklist(v, v.samplePayload, render(v.source, v.samplePayload)).results.find((r) => r.rule_id === "ny-419-6")!.skipped, true);   // non-NY: the rule does not apply
  h.clock.set("2026-09-14T15:00:00.000Z"); h.events.append({ type: "notice.sent", loanId: "L-1", actor: CASE_AGENT, payload: { template: "NTC_REGX_36A2_OWNER_IDENTITY", case_id: "rfi-12" } });
  assert.equal(h.timer("NY_419_6_RFI_OWNER_10D")[0]!.status, "satisfied");
});
test('4.2-T13: (privilege) Given a request for "your legal analysis of my foreclosure," then the item routes to `attorney` for a privilege determination and the withholding notice issues within the clock.', async () => {
  const r = privilegeRouting("your legal analysis of my foreclosure", D("2026-09-04"));
  assert.deepEqual(r, { route: "attorney", notice: "NTC_REGX_36F2_EXCEPTION", basis: "confidential_privileged", due_on: "2026-10-20" });
  assert.equal(privilegeRouting("my payment history", D("2026-09-04")).route, "case_agent");
  const h = harness();
  await h.run("4.2", "rfi.open", CASE_AGENT, { case_id: "rfi-13", receipt_date: "2026-09-04", items: [{ id: "legal", kind: "standard", description: "your legal analysis of my foreclosure" }, { id: "dates", kind: "standard", description: "the foreclosure milestone dates" }] });
  const routed = (await h.run("4.2", "rfi.item.route", CASE_AGENT, { case_id: "rfi-13", item_id: "legal" })).output as { route: string; basis: string | null; notice: string | null; due_on: string; escalation_id: string | null };
  assert.deepEqual([routed.route, routed.basis, routed.notice, routed.due_on], ["attorney", "confidential_privileged", "NTC_REGX_36F2_EXCEPTION", "2026-10-20"]);
  const esc = h.events.ofType("escalation.created").find((e) => e.payload.escalation_id === routed.escalation_id)!; assert.equal(esc.payload.kind, "attorney"); assert.equal(esc.payload.item_id, "legal");
  assert.equal(h.rt.store.get("case_request_items", "rfi-13:legal")!.data.routed_to, "attorney");
  assert.equal(((await h.run("4.2", "rfi.item.route", CASE_AGENT, { case_id: "rfi-13", item_id: "dates" })).output as { route: string }).route, "case_agent");
  await assert.rejects(h.run("4.2", "rfi.item.route", CASE_AGENT, { case_id: "rfi-13", item_id: "nope" }), refusedWith("ITEM_NOT_FOUND"));
  // the privilege call is counsel's: the case agent cannot withhold as privileged; the attorney determines it on 09-10
  await assert.rejects(h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-13", item_id: "legal", determination: "exception_confidential" }, "2026-09-10T15:00:00.000Z"), refusedWith("PRIVILEGE_NEEDS_ATTORNEY"));
  assert.equal(h.timer("REGX_1024_36F2_RFI_EXCEPTION_NOTICE_5").length, 0);
  const det = (await h.run("4.2", "rfi.item.determine", ATTORNEY, { case_id: "rfi-13", item_id: "legal", determination: "exception_confidential" }, "2026-09-10T15:00:00.000Z")).output as { exception_notice_due: string };
  assert.equal(det.exception_notice_due, "2026-09-17");                                                                                                          // 5 federal BD after the 09-10 determination
  const ex = h.timer("REGX_1024_36F2_RFI_EXCEPTION_NOTICE_5")[0]!; assert.equal(ex.dueDate, "2026-09-17"); assert.ok(ex.dueDate! < routed.due_on);              // the withholding notice falls inside the item's 30-day clock
  assert.equal(h.events.ofType("case.rfi.exception_determined")[0]!.payload.exception_basis, "confidential"); assert.equal(h.events.ofType("case.rfi.item.determined")[0]!.actor.role, "attorney");
  const v = notices().activeVersion("NTC_REGX_36F2_EXCEPTION", D("2026-09-16"))!;
  const payload = { ...v.samplePayload, items: [{ n: 1, text: "your legal analysis of my foreclosure", basis: "privileged" }], provided: "the foreclosure milestone dates", business_days_after_determination: 4 }; const rr = render(v.source, payload);
  assert.match(rr.text, /\(1\) your legal analysis of my foreclosure — privileged; We did provide: the foreclosure milestone dates\./); assert.equal(evaluateChecklist(v, payload, rr).passed, true);
  const noBasis = { ...payload, items: [{ n: 1, text: "your legal analysis of my foreclosure", basis: "" }] }; assert.ok(evaluateChecklist(v, noBasis, render(v.source, noBasis)).blocking.some((b) => b.rule_id === "basis-per-item"));
  h.clock.set("2026-09-16T15:00:00.000Z"); sent(h, "NTC_REGX_36F2_EXCEPTION", "rfi-13"); assert.equal(ex.status, "satisfied");
  await h.run("4.2", "rfi.item.determine", CASE_AGENT, { case_id: "rfi-13", item_id: "dates", determination: "provided" });
  await h.run("4.2", "rfi.respond", CASE_AGENT, { case_id: "rfi-13", item_ids: ["legal", "dates"], template: "NTC_REGX_36F2_EXCEPTION" }, "2026-09-16T16:00:00.000Z");
  assert.equal(h.timer("REGX_1024_36D_RFI_RESPONSE_30")[0]!.status, "satisfied"); assert.equal(h.events.ofType("case.rfi.responded")[0]!.payload.complete, true);
});
