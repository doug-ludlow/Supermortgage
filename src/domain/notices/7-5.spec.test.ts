// 7.5 GLBA privacy notice
// spec/sections/07-compliance-notices-disclosures/7-5-glba-privacy-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { newConsent, verify } from "./esign.ts";
import { privacyPortalPosting, otherImportantInformation, annualNoticeAfterTermination, privacyCopyOnRequest } from "./ops.ts";

// 7.5-T1 — implemented in src/domain/notices/notices.test.ts
// 7.5-T2 — implemented in src/domain/notices/notices.test.ts
// 7.5-T3 — implemented in src/domain/notices/notices.test.ts
// 7.5-T4 — implemented in src/domain/notices/notices.test.ts
// 7.5-T5 — implemented in src/domain/notices/notices.test.ts
test("7.5-T6: Given a borrower with `privacy_notices` e-consent, then the initial notice is posted with a required acknowledgment and the acknowledgment timestamp is stored; given no acknowledgment within 30 days, then a paper copy is mailed.", () => {
  const posted = privacyPortalPosting({ posted_on: D("2026-11-10"), acknowledged_at: "2026-11-11T09:00:00Z", today: D("2026-12-15") });
  assert.equal(posted.acknowledgment_required, true); assert.equal(posted.acknowledged_at, "2026-11-11T09:00:00Z"); assert.equal(posted.mail_paper, false);
  const unack = privacyPortalPosting({ posted_on: D("2026-11-10"), acknowledged_at: null, today: D("2026-12-10") });
  assert.equal(unack.paper_fallback_on, "2026-12-10"); assert.equal(unack.mail_paper, true);
  assert.equal(privacyPortalPosting({ posted_on: D("2026-11-10"), acknowledged_at: null, today: D("2026-12-09") }).mail_paper, false);
});
test("7.5-T7: Given a California property, then the notice's \"Other important information\" carries the CalFIPA line only if the sharing profile requires it; the CCPA is not cited.", () => {
  assert.deepEqual(otherImportantInformation({ state: "CA", sharing_profile: "exceptions_only" }), { lines: [], cites_ccpa: false });
  const broader = otherImportantInformation({ state: "CA", sharing_profile: "broader" });
  assert.equal(broader.lines.length, 1); assert.match(broader.lines[0]!, /California Financial Information Privacy Act/); assert.doesNotMatch(broader.lines[0]!, /CCPA|Consumer Privacy Act/); assert.equal(broader.cites_ccpa, false);
});
test("7.5-T8: Given payoff on 2027-03-10, then no annual notice is generated for 2027 and the party status is `terminated`.", () => {
  assert.deepEqual(annualNoticeAfterTermination({ terminated_on: D("2027-03-10"), notice_year: 2027 }), { annual_notice: false, party_status: "terminated" });
});
test("7.5-T9: Given a borrower requests a copy by chat, then a copy is sent within 5 business days by the borrower's consented channel.", () => {
  const c = newConsent("A", ["privacy_notices"], "v1.3", D("2026-10-02"), "portal"); if ("error" in c) throw new Error(c.error); verify(c, true, true, D("2026-10-02"));
  const r = privacyCopyOnRequest({ requested_on: D("2026-10-14"), consent: c });
  assert.equal(r.send_by, "2026-10-21"); assert.equal(r.channel, "electronic"); assert.equal(r.kind, "on_request");
  assert.equal(privacyCopyOnRequest({ requested_on: D("2026-10-14"), consent: null }).channel, "mail");
});
