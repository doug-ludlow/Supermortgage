// 15.3 MI claim filing
// spec/sections/15-reo-claims-expense-reimbursement/15-3-mi-claim-filing.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 15.3-T1 — implemented in src/domain/reo/reo.test.ts
test("15.3-T2: Given the same loan insured by a non-participant, then `direct_file_due_at` = Nov 4, 2027 (30 days), the Claim for Loss package is generated with payee = Fannie Mae, and follow-ups recur weekly after filing.", { todo: true });
// 15.3-T3 — implemented in src/domain/reo/reo.test.ts
// 15.3-T4 — implemented in src/domain/reo/reo.test.ts
// 15.3-T5 — implemented in src/domain/reo/reo.test.ts
// 15.3-T6 — implemented in src/domain/reo/reo.test.ts
// 15.3-T7 — implemented in src/domain/reo/reo.test.ts
// 15.3-T8 — implemented in src/domain/reo/reo.test.ts
// 15.3-T9 — implemented in src/domain/reo/reo.test.ts
// 15.3-T10 — implemented in src/domain/reo/reo.test.ts
// 15.3-T11 — implemented in src/domain/reo/reo.test.ts
test("15.3-T12: Given interest accrual reaches 30 months on an unresolved judicial foreclosure, then an `officer` briefing is generated with the cap date and projected uninsured interest.", { todo: true });
