// 10.1 Borrower-requested cancellation @80% LTV
// spec/sections/10-pmi-administration/10-1-borrower-requested-cancellation-80-ltv.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 10.1-T1 — implemented in src/domain/pmi/pmi.test.ts
// 10.1-T2 — implemented in src/domain/pmi/pmi.test.ts
test("10.1-T3: Given a request received 2029-07-10 and no decision or notice by 2029-08-09 23:59 servicer time, then timer `breached`, `officer` sev-1 escalation, Sentinel report line.", { todo: true });
// 10.1-T4 — implemented in src/domain/pmi/pmi.test.ts
// 10.1-T5 — implemented in src/domain/pmi/pmi.test.ts
// 10.1-T6 — implemented in src/domain/pmi/pmi.test.ts
test("10.1-T7: Given an MN owner-occupied loan, request received 2026-09-01, then `MN_47_207_RESPONSE_30` due 2026-10-01 and the ack offers the MN current-value (80% of appraisal within 90 days) path.", { todo: true });
test("10.1-T8: Given SMDU 503 for 4 hours at case day 16, then a `human_portal_task` escalation opens with the prepared data set and the HPA timer unchanged.", { todo: true });
// 10.1-T9 — implemented in src/domain/pmi/pmi.test.ts
// 10.1-T10 — implemented in src/domain/pmi/pmi.test.ts
// 10.1-T11 — implemented in src/domain/pmi/pmi.test.ts
// 10.1-T12 — implemented in src/domain/pmi/pmi.test.ts
