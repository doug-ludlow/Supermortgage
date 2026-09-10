// 7.3 ARM initial adjustment notice
// spec/sections/07-compliance-notices-disclosures/7-3-arm-initial-adjustment-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { newPayment } from "./arm.ts";
import { initialNoticeIndexHold, transferInInitialNotice, composeEnvelope, stateHfaContact, correctedInitialNotice, scheduledUpbAfter } from "./ops.ts";

// 7.3-T1 — implemented in src/domain/notices/notices.test.ts
// 7.3-T2 — implemented in src/domain/notices/notices.test.ts
test("7.3-T3: Given the latest index publication is 16 business days old, then rendering is held until a fresh value is captured.", () => {
  const h = initialNoticeIndexHold({ latest: { effective_date: D("2026-03-27"), value: "3.60" }, disclosure_date: D("2026-04-20") });
  assert.equal(h.business_days_old, 16); assert.equal(h.hold, true); assert.match(h.reason!, /hold until a fresh value/);
  assert.equal(initialNoticeIndexHold({ latest: { effective_date: D("2026-04-20"), value: "3.64381" }, disclosure_date: D("2026-04-20") }).hold, false);
});
test("7.3-T4: Given a loan boarded 2026-06-01 (T\u2212183) with a transferor (d) notice image dated 2026-04-15 in the file, then status = `transferor_evidenced` and no duplicate is sent.", () => {
  const r = transferInInitialNotice({ boarded_on: D("2026-06-01"), first_new_payment_due: D("2026-12-01"), consummation: D("2021-11-01"), term_months: 360, transferor_evidence: { document_id: "doc-transferor-d", dated: D("2026-04-15") } });
  assert.equal(r.status, "transferor_evidenced"); assert.equal(r.duplicate, false); assert.equal(r.send_by, null); assert.equal(r.evidence_document_id, "doc-transferor-d"); assert.equal(r.breach_record, null);
});
test("7.3-T5: Given the same boarding with no evidence, then the notice is sent within 5 business days and a transferor-breach record is created.", () => {
  const r = transferInInitialNotice({ boarded_on: D("2026-06-01"), first_new_payment_due: D("2026-12-01"), consummation: D("2021-11-01"), term_months: 360, transferor_evidence: null });
  assert.equal(r.status, "send_now"); assert.equal(r.send_by, "2026-06-08"); assert.deepEqual(r.breach_record, { attributable_to: "transferor", window_deadline: "2026-05-05" });
});
// 7.3-T6 — implemented in src/domain/notices/notices.test.ts
test("7.3-T7: Given the notice is co-mailed with the periodic statement, then it is a separate PDF with its own first page and the composer log shows two documents in one envelope.", () => {
  const e = composeEnvelope([{ template: "NTC_REGZ_41_STMT_STD", separate_document: false, pages: 2 }, { template: "NTC_REGZ_20D_ARM_INITIAL", separate_document: true, pages: 1 }]);
  assert.equal(e.envelope_count, 1); assert.equal(e.documents.length, 2); assert.equal(e.documents[1]!.own_pdf, true); assert.equal(e.documents[1]!.first_page, 3);
  assert.equal(e.composer_log, "2 documents in one envelope: NTC_REGZ_41_STMT_STD + NTC_REGZ_20D_ARM_INITIAL");
});
test("7.3-T8: Given a Texas property, then the (xi) block names the Texas state housing finance authority from `jurisdiction_rules`.", () => {
  const rules = { TX: { hfa_name: "Texas Department of Housing and Community Affairs", hfa_phone: "(800) 792-1119" }, CA: { hfa_name: "California Housing Finance Agency", hfa_phone: "(877) 922-5432" } };
  assert.deepEqual(stateHfaContact("TX", rules), rules.TX); assert.throws(() => stateHfaContact("ZZ", rules), /no state HFA contact/);
});
test("7.3-T9: Given the margin is corrected on 2026-04-28 after a 2026-04-21 send, then a corrected (d) notice is sent by 2026-05-05.", () => {
  const r = correctedInitialNotice({ sent_on: D("2026-04-21"), corrected_on: D("2026-04-28"), first_new_payment_due: D("2026-12-01") });
  assert.equal(r.action, "send_corrected_d_notice"); assert.equal(r.send_by, "2026-05-05"); assert.equal(r.days_out, 217);
  assert.equal(correctedInitialNotice({ sent_on: D("2026-04-21"), corrected_on: D("2026-06-01"), first_new_payment_due: D("2026-12-01") }).action, "rely_on_c_notice");
});

test("7.3 worked example: expected UPB $371,048.86 and current P&I $2,334.29 feed the (d) estimate ($2,476.44 estimated at 6.375%)", () => {
  assert.equal(scheduledUpbAfter(40000000n, "5.750", 233429n, 60), 37104886n); assert.equal(newPayment(37104886n, "6.375", 300), 247644n);
});
