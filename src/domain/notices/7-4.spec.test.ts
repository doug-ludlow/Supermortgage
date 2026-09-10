// 7.4 E-SIGN consent for e-delivery
// spec/sections/07-compliance-notices-disclosures/7-4-e-sign-consent-for-e-delivery.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { newConsent, verify } from "./esign.ts";
import { tcpaStop, transferInEstatementFlag, consentExamRecord } from "./ops.ts";

// 7.4-T1 — implemented in src/domain/notices/notices.test.ts
// 7.4-T2 — implemented in src/domain/notices/notices.test.ts
// 7.4-T3 — implemented in src/domain/notices/notices.test.ts
// 7.4-T4 — implemented in src/domain/notices/notices.test.ts
// 7.4-T5 — implemented in src/domain/notices/notices.test.ts
// 7.4-T6 — implemented in src/domain/notices/notices.test.ts
test("7.4-T7: Given a `tcpa_sms` STOP reply, then the number is suppressed immediately and the revocation is applied to all lists within 1 business day (\u2264 10 BD).", () => {
  const s = tcpaStop({ number: "+15125550123", reply: "STOP", received_on: D("2026-10-14") });
  assert.equal(s.revocation, true); assert.equal(s.suppressed_immediately, true); assert.equal(s.apply_to_all_lists_by, "2026-10-15"); assert.equal(s.outside_bound, "2026-10-28"); assert.equal(s.recognized_from, "keyword");
  assert.equal(tcpaStop({ number: "+15125550123", reply: "please don't text me anymore", received_on: D("2026-10-14") }).recognized_from, "free_text");
  assert.equal(tcpaStop({ number: "+15125550123", reply: "thanks, got it", received_on: D("2026-10-14") }).revocation, false);
});
test("7.4-T8: Given a transfer-in file with `estatement_flag=Y` and no evidence, then the loan boards with mail delivery and an invitation is included with the hello notice.", () => {
  assert.deepEqual(transferInEstatementFlag({ estatement_flag: "Y", evidence: null }), { delivery: "mail", consent_status: null, invitation_with_hello: true });
  assert.equal(transferInEstatementFlag({ estatement_flag: "Y", evidence: { checkbox_text: "I agree to e-statements", demonstration_proof_id: "proof-1" } }).consent_status, "evidence_only");
});
// 7.4-T9 — implemented in src/notices/notices.test.ts
// 7.4-T10 — implemented in src/notices/notices.test.ts
test("7.4-T11: Given a consent record, when queried for exam, then the disclosure text version, hash, timestamps, IP/user-agent and verification proof are reproducible (7001(d)).", () => {
  const c = newConsent("A", ["periodic_statements", "arm_notices"], "v1.3", D("2026-10-02"), "portal"); if ("error" in c) throw new Error(c.error); verify(c, true, true, D("2026-10-02"));
  const r = consentExamRecord(c, { disclosure_version: "v1.3", disclosure_hash: "sha256:7f3a", consented_at: "2026-10-02T14:14:00Z", verification_link_opened_at: "2026-10-02T14:20:00Z", token_entered_at: "2026-10-02T14:21:00Z", ip: "203.0.113.7", user_agent: "Mozilla/5.0", token_ok: true });
  assert.equal(r.reproducible, true); assert.deepEqual(r.missing, []); assert.equal(r.fields.disclosure_hash, "sha256:7f3a"); assert.equal(r.fields.verification.token_ok, true); assert.equal(r.fields.ip, "203.0.113.7");
  assert.deepEqual(consentExamRecord(c, { disclosure_version: "v1.3", disclosure_hash: "", consented_at: "2026-10-02T14:14:00Z", verification_link_opened_at: null, token_entered_at: null, ip: "", user_agent: "x", token_ok: false }).missing, ["disclosure_hash", "ip", "verification_proof"]);
});
