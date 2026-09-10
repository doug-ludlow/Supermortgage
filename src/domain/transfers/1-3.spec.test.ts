// 1.3 RESPA transfer notices (goodbye/hello)
// spec/sections/01-boarding-servicing-transfer-in/1-3-respa-transfer-notices-goodbye-hello.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { releaseGate, returnedMail, noticeRecipients, masterServicerOnlyExclusion } from "./inbound.ts";
import { contentCheck, REQUIRED_CONTENT } from "./respa.ts";
const OFFICER = { kind: "human" as const, id: "u-officer", role: "officer" };

// 1.3-T1 — implemented in src/domain/transfers/transfers.test.ts
// 1.3-T2 — implemented in src/domain/transfers/transfers.test.ts
// 1.3-T3 — implemented in src/domain/transfers/transfers.test.ts
test("1.3-T4: Given a rendered notice missing the transferor's toll-free number, then the run cannot be released.", () => {
  const missing = contentCheck(REQUIRED_CONTENT.filter((c) => c !== "transferor_tollfree")).missing;
  assert.deepEqual(missing, ["transferor_tollfree"]);
  const g = releaseGate({ status: "rendered", kind: "hello", transferor_authorization_on_file: true, notices: [{ id: "N-1", checklist_missing: missing, address_valid: true }, { id: "N-2", checklist_missing: [], address_valid: true }] });
  assert.equal(g.ok, false); assert.deepEqual(g.reasons, ["N-1: missing transferor_tollfree"]);
  assert.equal(releaseGate({ status: "qc_passed", kind: "hello", transferor_authorization_on_file: true, notices: [{ id: "N-2", checklist_missing: [], address_valid: true }] }).ok, true);
  assert.match(releaseGate({ status: "qc_passed", kind: "goodbye", transferor_authorization_on_file: false, notices: [] }).reasons[0]!, /transferor's written authorization/);
});
// 1.3-T5 — implemented in src/domain/transfers/transfers.test.ts
// 1.3-T6 — implemented in src/domain/transfers/transfers.test.ts
// 1.3-T7 — implemented in src/domain/transfers/transfers.test.ts
test("1.3-T8: Given a returned hello notice, then a skip-trace order exists within 5 servicer business days and the original proof of mailing remains linked.", () => {
  const r = returnedMail({ id: "N-hello-7", proof_of_mailing_id: "pom-7" }, D("2026-10-20"));
  assert.equal(r.skip_trace_due, "2026-10-27");                                // 5 servicer business days
  assert.equal(r.original_proof_of_mailing_id, "pom-7"); assert.equal(r.still_satisfies_1024_33, true);
});
test("1.3-T9: Given an ACP-enrolled borrower, then the notice is addressed to the ACP substitute address only.", () => {
  const rs = noticeRecipients([{ party_id: "B1", role: "borrower", address: "1 Real St", acp_enrolled: true, acp_substitute_address: "PO Box 9999 ACP" }, { party_id: "B2", role: "borrower", address: "2 Other St" }, { party_id: "S1", role: "successor_in_interest", address: "3 Heir St", sii_confirmed: false }]);
  assert.deepEqual(rs, [{ party_id: "B1", address: "PO Box 9999 ACP", via: "acp_substitute" }, { party_id: "B2", address: "2 Other St", via: "own_address" }]);
  assert.ok(!JSON.stringify(rs).includes("1 Real St"));
  assert.throws(() => noticeRecipients([{ party_id: "B3", role: "borrower", address: "x", acp_enrolled: true, acp_substitute_address: null }]), /no substitute address/);
});
test("1.3-T10: Given a master-servicer-only change with identical payee/address/account/amount, then no notices are generated and an `officer` approval record documents the exclusion.", () => {
  const same = { payee: true, address: true, account: true, amount: true };
  assert.equal(masterServicerOnlyExclusion(same, null).block, "suppression needs an officer sign-off verifying no payee/address/account/amount change");
  const r = masterServicerOnlyExclusion(same, OFFICER);
  assert.equal(r.notices_required, false); assert.equal(r.exclusion_record!.approved_by, "u-officer"); assert.match(r.exclusion_record!.basis, /1024\.33\(b\)\(2\)\(i\)\(C\)/);
  assert.equal(masterServicerOnlyExclusion({ ...same, address: false }, OFFICER).notices_required, true);
});
