// 7.5 GLBA privacy notice
// spec/sections/07-compliance-notices-disclosures/7-5-glba-privacy-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 7.5-T1 — implemented in src/domain/notices/notices.test.ts
// 7.5-T2 — implemented in src/domain/notices/notices.test.ts
// 7.5-T3 — implemented in src/domain/notices/notices.test.ts
// 7.5-T4 — implemented in src/domain/notices/notices.test.ts
// 7.5-T5 — implemented in src/domain/notices/notices.test.ts
test("7.5-T6: Given a borrower with `privacy_notices` e-consent, then the initial notice is posted with a required acknowledgment and the acknowledgment timestamp is stored; given no acknowledgment within 30 days, then a paper copy is mailed.", { todo: true });
test("7.5-T7: Given a California property, then the notice's \"Other important information\" carries the CalFIPA line only if the sharing profile requires it; the CCPA is not cited.", { todo: true });
test("7.5-T8: Given payoff on 2027-03-10, then no annual notice is generated for 2027 and the party status is `terminated`.", { todo: true });
test("7.5-T9: Given a borrower requests a copy by chat, then a copy is sent within 5 business days by the borrower's consented channel.", { todo: true });
