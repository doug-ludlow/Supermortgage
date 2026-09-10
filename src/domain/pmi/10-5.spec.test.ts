// 10.5 Unearned premium refund
// spec/sections/10-pmi-administration/10-5-unearned-premium-refund.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 10.5-T1 — implemented in src/domain/pmi/pmi.test.ts
// 10.5-T2 — implemented in src/domain/pmi/pmi.test.ts
// 10.5-T3 — implemented in src/domain/pmi/pmi.test.ts
test("10.5-T4: Given the escrow MI line balance $950.00 at E, then an interim analysis completes within 10 BD, the surplus is refunded within 30 days of the analysis, and the new payment excludes the $190.00 MI deposit effective 2031-09-01.", { todo: true });
// 10.5-T5 — implemented in src/domain/pmi/pmi.test.ts
// 10.5-T6 — implemented in src/domain/pmi/pmi.test.ts
// 10.5-T7 — implemented in src/domain/pmi/pmi.test.ts
// 10.5-T8 — implemented in src/domain/pmi/pmi.test.ts
test("10.5-T9: Given Dec. 2, 2026 or later, then the refund deposit and disbursement generate escrow events accepted before 03:00 ET the next business day.", { todo: true });
test("10.5-T10: Given an insurer rescission notice received 2027-03-03, then LAR 89 action code 54 with action date 030327 is reported and a Fannie Mae notification is made within 30 days; the borrower refund leg is held for `officer` decision.", { todo: true });
