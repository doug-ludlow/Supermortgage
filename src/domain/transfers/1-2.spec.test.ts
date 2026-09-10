// 1.2 Servicing transfer approval from Fannie Mae
// spec/sections/01-boarding-servicing-transfer-in/1-2-servicing-transfer-approval-from-fannie-mae.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { batchTransitionBlock, portalTaskStatus, parseConsentNotice, withdrawFromList, attestationSatisfies, attestList, type LoanListLoan, type LoanListVersion } from "./inbound.ts";
const OFFICER = { kind: "human" as const, id: "u-officer", role: "officer" };
const PACKAGE = { form629_document_id: "doc-629", loan_list_version: 1, custodian_matrix_document_id: "doc-matrix", dq_precheck_passed: true };

// 1.2-T1 — implemented in src/domain/transfers/transfers.test.ts
// 1.2-T2 — implemented in src/domain/transfers/transfers.test.ts
// 1.2-T3 — implemented in src/domain/transfers/transfers.test.ts
test("1.2-T4: Given no Form 101 evidence for a first batch, then the batch cannot reach `package_ready`.", () => {
  assert.match(batchTransitionBlock("proposed", "package_ready", { ...PACKAGE, first_batch_for_partner: true, form101_document_id: null })!, /FNMA_A2_1_07_FORM101_INCEPTION/);
  assert.equal(batchTransitionBlock("proposed", "package_ready", { ...PACKAGE, first_batch_for_partner: true, form101_document_id: "doc-101" }), null);
  assert.equal(batchTransitionBlock("proposed", "package_ready", { ...PACKAGE, first_batch_for_partner: false }), null);   // a later batch needs no new Form 101
});
test("1.2-T5: Given the portal task is not completed within 2 servicer business days, then an `officer` escalation is created and the batch report shows the breach.", () => {
  const s = portalTaskStatus(D("2026-09-24"), D("2026-09-28"));            // Thu → due Mon Sep 28
  assert.equal(s.due, "2026-09-28"); assert.equal(s.breached, false); assert.equal(s.escalation, null);
  const late = portalTaskStatus(D("2026-09-24"), D("2026-09-29"));
  assert.deepEqual([late.breached, late.escalation], [true, "officer"]);
  assert.equal(batchTransitionBlock("package_ready", "submitted", { portal_completion_record_id: null }), "submitted requires a fnma_portal_operator completion record");
});
test("1.2-T6: Given a consent notice with conditions, when parsed, then `approved` is blocked until an `officer` confirms the parsed D-Code and conditions.", () => {
  const parsed = parseConsentNotice("Fannie Mae approves the servicing transfer effective 2026-10-01, D-Code D12, subject to delivery of custodial documents to Custodian X; provided that Form 2017 is executed.");
  assert.equal(parsed.outcome, "approved"); assert.equal(parsed.d_code, "D12"); assert.equal(parsed.effective_date, "2026-10-01");
  assert.equal(parsed.conditions.length, 2); assert.equal(parsed.officer_confirmation_required, true);
  assert.match(batchTransitionBlock("submitted", "approved", { consent_document_hash: "sha256:abc", consent_conditions: parsed.conditions })!, /officer must confirm/);
  assert.equal(batchTransitionBlock("submitted", "approved", { consent_document_hash: "sha256:abc", consent_conditions: parsed.conditions, officer_confirmed_conditions: true }), null);
  assert.equal(parseConsentNotice("Request denied.").outcome, "denied");
});
test("1.2-T7: Given a loan on the approved list that pays off Sept. 20, 2026, then it is `withdrawn`, a new loan-list version is created, and the CD25 attestation timer is satisfied only by an attested version.", () => {
  const loans: LoanListLoan[] = [{ fnma_loan_number: "1000000001", status: "listed" }, { fnma_loan_number: "1000000002", status: "listed" }];
  const v1: LoanListVersion = { version: 1, loans: loans.map((l) => l.fnma_loan_number), attested: true, attested_by: "u-officer", created_on: D("2026-09-01") };
  const v2 = withdrawFromList([v1], loans, "1000000002", "paid_off", D("2026-09-20"));
  assert.equal(loans[1]!.status, "withdrawn"); assert.equal(loans[1]!.withdrawn_reason, "paid_off");
  assert.deepEqual([v2.version, v2.loans, v2.attested], [2, ["1000000001"], false]);
  assert.equal(attestationSatisfies(v2), false);                              // FNMA_QX_LOAN_LIST_FREEZE_CD25 stays open
  assert.throws(() => attestList(v2, { kind: "agent", id: "transfer" }), /officer act/);
  assert.equal(attestationSatisfies(attestList(v2, OFFICER)), true);
});
