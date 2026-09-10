// 9.2 Force-placed insurance — first notice
// spec/sections/09-insurance-property-protection/9-2-force-placed-insurance-first-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 9.2-T1 — implemented in src/domain/insurance/insurance.test.ts
// 9.2-T2 — implemented in src/domain/insurance/insurance.test.ts
// 9.2-T3 — implemented in src/domain/insurance/insurance.test.ts
// 9.2-T4 — implemented in src/domain/insurance/insurance.test.ts
test("9.2-T5: Given a notice rendered with an extra marketing paragraph When checklist runs Then render fails ((c)(4)).", { todo: true });
test("9.2-T6: Given a windstorm-only gap When notice composed Then [Insurance Type]=\"windstorm\" and (v)(C) statement present.", { todo: true });
test("9.2-T7: Given a notice produced 2026-10-01 and mailed 2026-10-09 (6 federal business days later; 2026-10-12 is Columbus Day but after) When mailing Then regeneration required per (d)(5) rule; produced 2026-10-05 \u2192 allowed.", { todo: true });
// 9.2-T8 — implemented in src/domain/insurance/insurance.test.ts
test("9.2-T9: Given flood required by FDPA lapses When case opened Then track `fdpa_flood`, no MS-3A.", { todo: true });
test("9.2-T10: Given LPI vendor offers a \"servicer expense reimbursement\" fee When placement configured Then rejected (B-6-01 commission exclusion).", { todo: true });
// 9.2-T11 — implemented in src/domain/insurance/insurance.test.ts
