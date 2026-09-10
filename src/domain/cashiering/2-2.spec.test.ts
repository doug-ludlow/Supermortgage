// 2.2 Partial payment / suspense handling
// spec/sections/02-payment-processing-cashiering/2-2-partial-payment-suspense-handling.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 2.2-T1 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T2 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T3 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T4 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T5 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T6 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T7 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T8 — implemented in src/domain/cashiering/section2.test.ts
// 2.2-T9 — implemented in src/domain/cashiering/section2.test.ts
test("2.2-T10: Given any period end with \u03a3 unapplied > 0, when 7.1 renders the statement, then the (d)(3) amount and (d)(5) instruction text are present (template checklist passes).", { todo: true });
test("2.2-T11: Given the same check image resubmitted, when ingested, then the second item is rejected as a duplicate and an exception is logged.", { todo: true });
