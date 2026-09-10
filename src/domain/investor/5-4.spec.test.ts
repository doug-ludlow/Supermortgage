// 5.4 Stop Delinquency Advance handling
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-4-stop-delinquency-advance-handling.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 5.4-T1 — implemented in src/domain/investor/investor.test.ts
// 5.4-T2 — implemented in src/domain/investor/investor.test.ts
// 5.4-T3 — implemented in src/domain/investor/investor.test.ts
test("5.4-T4: Given a completed payment deferral on an SDA loan, then all `advances` rows move to `reimbursed_by_fnma` within two cycles or an IRR package is escalated.", { todo: true });
test("5.4-T5: Given a regular servicing option S/S loan six consecutive months delinquent, then no SDA is predicted, advances continue, and the deselection decision task is created on CD11 and due CD15.", { todo: true });
test("5.4-T6: Given Fannie Mae's report shows Stop Advance for a loan we predicted as three months delinquent, then a sev-2 variance opens comparing LPI dates and the 5.1 reporting history.", { todo: true });
test("5.4-T7: Given month-end Form 496 preparation, then Section II line 12 equals \u03a3 Fannie Mae-reported outstanding P&I receivables for SDA loans with the standard explanation.", { todo: true });
test("5.4-T8: Given a payoff of an SDA loan, then the payoff remittance includes Fannie Mae's outstanding P&I receivable and the servicer's advances are recovered from the payoff proceeds/borrower per the payoff calculator.", { todo: true });
