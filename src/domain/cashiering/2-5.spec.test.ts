// 2.5 Biweekly third-party payments
// spec/sections/02-payment-processing-cashiering/2-5-biweekly-third-party-payments.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 2.5-T1 — implemented in src/domain/cashiering/section2.test.ts
// 2.5-T2 — implemented in src/domain/cashiering/section2.test.ts
// 2.5-T3 — implemented in src/domain/cashiering/section2.test.ts
test("2.5-T4: Given a contractor remittance settling 2026-10-20 for the 2026-10-01 installment, when 2.7 runs 2026-10-17, then a late charge is assessed and `THIRDPARTY-BIWEEKLY-INFO-v1` context is referenced in any borrower explanation.", { todo: true });
// 2.5-T5 — implemented in src/domain/cashiering/section2.test.ts
// 2.5-T6 — implemented in src/domain/cashiering/section2.test.ts
test("2.5-T7: Given a borrower asks the voice agent about a contractor's program, when answered, then the transcript shows the non-endorsement statement and the free in-house option.", { todo: true });
