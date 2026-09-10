// 18.4 Form 582 Lender Record Information
// spec/sections/18-qc-audit-regulatory-reporting/18-4-form-582-lender-record-information.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 18.4-T1 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.4-T2 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.4-T3 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.4-T4 — implemented in src/domain/qc-audit/qc-audit.test.ts
// 18.4-T5 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.4-T6: Given a state consent order received, then a written notice is drafted and escalated the same day and the timer is satisfied only by sent evidence.", { todo: true });
// 18.4-T7 — implemented in src/domain/qc-audit/qc-audit.test.ts
test("18.4-T8: Given Supermortgage's own Form 582 cycle, then the subservicing screen answers \"subservice for others = YES\" listing the partner's servicer number and FYE loan count/UPB reconciled to Section 5 position data.", { todo: true });
