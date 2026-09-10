// 2.1 Accept & post periodic payment (P&I + escrow)
// spec/sections/02-payment-processing-cashiering/2-1-accept-post-periodic-payment-p-i-escrow.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 2.1-T1 — implemented in src/domain/cashiering/cashiering.test.ts
// 2.1-T2 — implemented in src/domain/cashiering/cashiering.test.ts
// 2.1-T3 — implemented in src/domain/cashiering/cashiering.test.ts
// 2.1-T4 — implemented in src/domain/cashiering/cashiering.test.ts
// 2.1-T5 — implemented in src/domain/cashiering/cashiering.test.ts
// 2.1-T6 — implemented in src/domain/cashiering/cashiering.test.ts
test("2.1-T7: Given the posting sweep has an unposted item dated \u2264 Sep 16, when the 2.7 assessment job runs Sep 17, then it waits (gate) and no late charge is assessed until the item posts.", { todo: true });
// 2.1-T8 — implemented in src/domain/cashiering/cashiering.test.ts
// 2.1-T9 — implemented in src/domain/cashiering/cashiering.test.ts
test("2.1-T10: Given an S/S loan, when `payment.applied` fires, then 5.2's remittance calculation receives interest/principal figures equal to the allocation payload (no recomputation drift).", { todo: true });
test("2.1-T11: Given the AI path is disabled, when an ambiguous instruction arrives, then the item appears in the Posting Queue and the human command path enforces identical validators.", { todo: true });
