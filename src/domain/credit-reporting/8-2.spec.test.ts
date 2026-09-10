// 8.2 Dispute handling (e-OSCAR / ACDV)
// spec/sections/08-credit-reporting/8-2-dispute-handling-e-oscar-acdv.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 8.2-T1 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T2 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T3 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T4 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T5 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T6 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T7 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T8 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T9 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
test("8.2-T10: (oral dispute) Given a borrower says on an AI voice call that \"my credit report shows me late in March and I wasn't,\" then a direct-dispute case opens, XB applies, and the results letter goes out within 30 days.", { todo: true });
// 8.2-T11 — implemented in src/infra/integrations/integrations.test.ts
// 8.2-T12 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
test("8.2-T13: (NoE linkage) Given a letter alleging a misapplied payment and a wrong credit report, then both an NoE case (4.1) and a direct dispute exist, the corrections are shared, and both letters meet their clocks.", { todo: true });
test("8.2-T14: (AUD is not in-cycle) Given an AUD sent on 2027-09-25, then the 2027-09-30 cycle still carries the corrected values (no reliance on the AUD alone).", { todo: true });
