// 10.4 Annual PMI disclosure
// spec/sections/10-pmi-administration/10-4-annual-pmi-disclosure.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 10.4-T1 — implemented in src/domain/pmi/pmi.test.ts
test("10.4-T2: Given no disclosure sent by 2027-03-15 23:59, then `HPA_4903A3_ANNUAL_DISCLOSURE_12M` breaches, a standalone notice is auto-sent and an `officer` sev-2 escalation opens.", { todo: true });
test("10.4-T3: Given a pre-1999 loan, then the legacy template is used and the checklist verifies the \"with the consent of the mortgagee or in accordance with applicable State law\" sentence.", { todo: true });
test("10.4-T4: Given an LPMI loan, then no annual disclosure is scheduled and the `HPA_4905C2_LPMI_OPTIONS_NOTICE_30` timer exists instead.", { todo: true });
test("10.4-T5: Given an MN property, then the rendered PDF's body font size is \u2265 12 pt (template metadata check) and contains the statutory sentence; given CA, the notice is attached to every \u00a72954.2 statement in \u2265 10 pt bold.", { todo: true });
test("10.4-T6: Given `esign` consent revoked on 2027-02-18, then the 2027-02-20 disclosure is mailed, not e-delivered.", { todo: true });
test("10.4-T7: Given MI terminated 2027-02-19, then the PMI page is suppressed at release and the termination notice is sent within 30 days.", { todo: true });
// 10.4-T8 — implemented in src/domain/pmi/pmi.test.ts
test("10.4-T9: Given an ARM reset that moved the 78% date, then the next disclosure shows the new date and the prior disclosure record retains the old projection.", { todo: true });
