// 6.4 T&I custodial reconciliation (Form 496A)
// spec/sections/06-custodial-account-management/6-4-t-i-custodial-reconciliation-form-496a.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 6.4-T1 — implemented in src/domain/custodial/custodial.test.ts
// 6.4-T2 — implemented in src/domain/custodial/custodial.test.ts
// 6.4-T3 — implemented in src/domain/custodial/custodial.test.ts
// 6.4-T4 — implemented in src/domain/custodial/custodial.test.ts
// 6.4-T5 — implemented in src/domain/custodial/custodial.test.ts
// 6.4-T6 — implemented in src/domain/custodial/custodial.test.ts
test("6.4-T7: Given a paid check on the bank's paid file with no matching issued record, then critical exception, `fraud` case, bank claim within 1 BD.", { todo: true });
test("6.4-T8: Given the 45-day deadline for 2026-09-30 \u2192 internal `due_at` 2026-11-13 17:00; on-time and breach behaviours as 6.3-T3.", { todo: true });
