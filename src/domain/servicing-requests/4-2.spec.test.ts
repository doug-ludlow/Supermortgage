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

// 4.2-T1 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.2-T2 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.2-T3 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.2-T4 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.2-T5: Given a request for call recordings from 14 months ago within retention, then audio files are provided (secure message if consented, else mailed media/transcript per policy) within 30 days.", () => {
  const r = recordingsResponse({ requested_on: D("2026-09-04"), call_on: D("2025-07-10"), retention_months: 60, esign_consented: true });
  assert.deepEqual(r, { available: true, format: "audio_secure_message", response_due: "2026-10-20" });
  assert.equal(recordingsResponse({ requested_on: D("2026-09-04"), call_on: D("2025-07-10"), retention_months: 60, esign_consented: false }).format, "mailed_media_or_transcript");
});
// 4.2-T6 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.2-T7: Given a potential successor's letter naming the deceased borrower, then `NTC_REGX_36I_SII_DOCS` is sent within 5 federal BD (policy) and no later than 30; an `sii` case opens (4.4); no account information is disclosed.", () => {
  // 30 federal BD from 2026-10-02 excluding Columbus Day and Veterans Day is 2026-11-17 (the spec's hand-count of 11-13 is short by two days; flagged for the audit).
  assert.deepEqual(potentialSuccessorRfi(D("2026-10-02")), { notice: "NTC_REGX_36I_SII_DOCS", target_on: "2026-10-09", latest_on: "2026-11-17", opens_case: "sii", account_information_disclosed: false });
});
test("4.2-T8: Given a request identical to one answered 3 months ago for the same period, then duplicative exception; for a new period, answered.", () => {
  assert.equal(duplicativeRfi({ prior_answered_on: D("2026-06-04"), prior_period: "2025", period: "2025", received_on: D("2026-09-04") }), "duplicative");
  assert.equal(duplicativeRfi({ prior_answered_on: D("2026-06-04"), prior_period: "2025", period: "2026", received_on: D("2026-09-04") }), null);
  assert.equal(R.exception({ asks_for: "records", answered_same_item_within_12m: true, received_on: D("2026-09-04") }), "duplicative");
});
test("4.2-T9: Given a discharge 13 months before receipt, then untimely notice within 5 federal BD.", () => {
  assert.deepEqual(untimelyRfi({ discharge_or_transfer_on: D("2025-08-04"), received_on: D("2026-09-04") }), { exception: "untimely", notice_due: "2026-09-14" });
  assert.equal(untimelyRfi({ discharge_or_transfer_on: D("2025-10-04"), received_on: D("2026-09-04") }).exception, null);
});
test("4.2-T10: Given the custodian copy request takes 12 BD, then the case uses the extension and responds within 45 total days; the extension notice cites the custodian retrieval.", () => {
  const r = custodianExtension(D("2026-09-04"), 12);
  assert.equal(r.extension_used, true); assert.equal(r.extension_notice_by, "2026-10-20"); assert.equal(r.response_due, "2026-11-10"); assert.equal(r.reason, "document custodian retrieval");
  assert.equal(custodianExtension(D("2026-09-04"), 5).extension_used, false);
});
test("4.2-T11: (early response) Given a simple escrow-statement copy request answered on day 3, then the ack timer cancels with reason `early_response`.", () => {
  assert.deepEqual(earlyResponse(D("2026-09-04"), D("2026-09-09")), { qualifies: true, cancel_reason: "early_response", notice: "NTC_REGX_36E_EARLY" });
  assert.equal(earlyResponse(D("2026-09-04"), D("2026-09-15")).qualifies, false);
});
// 4.2-T12 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.2-T13: (privilege) Given a request for \"your legal analysis of my foreclosure,\" then the item routes to `attorney` for a privilege determination and the withholding notice issues within the clock.", () => {
  const r = privilegeRouting("your legal analysis of my foreclosure", D("2026-09-04"));
  assert.deepEqual(r, { route: "attorney", notice: "NTC_REGX_36F2_EXCEPTION", basis: "confidential_privileged", due_on: "2026-10-20" });
  assert.equal(privilegeRouting("my payment history", D("2026-09-04")).route, "case_agent");
});
