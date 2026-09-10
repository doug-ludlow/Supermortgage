// 8.1 Furnish tradeline (Metro 2)
// spec/sections/08-credit-reporting/8-1-furnish-tradeline-metro-2.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 8.1-T1 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T2 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T3 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T4 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T5 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T6 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T7 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T8 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T9 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T10 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T11 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
test("8.1-T12: (ack/reject loop) Given Experian's Metric Report lists 12 rejected records for invalid MIN, then `metro2_ack_items` rows exist, the agent corrects the MIN from `loans`, resubmits/AUDs within 5 BD, and the items resolve.", { todo: true });
// 8.1-T13 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T14 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T15 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.1-T16 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
test("8.1-T17: (FDCPA gate) Given a loan boarded in default with no contact yet, then it is omitted from the cycle until a live contact or 14 days after a validation notice without undeliverability.", { todo: true });
test("8.1-T18: (four bureaus) Given any cycle, then exactly four files exist and Innovis is not skipped.", { todo: true });
// 8.1-T19 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
