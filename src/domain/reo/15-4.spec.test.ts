// 15.4 Delinquency advance reimbursement (Form 4828)
// spec/sections/15-reo-claims-expense-reimbursement/15-4-delinquency-advance-reimbursement-form-4828.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 15.4-T1 — implemented in src/domain/reo/reo.test.ts
// 15.4-T2 — implemented in src/domain/reo/reo.test.ts
// 15.4-T3 — implemented in src/domain/reo/reo.test.ts
// 15.4-T4 — implemented in src/domain/reo/reo.test.ts
test("15.4-T5: Given a reclass purchase advice dated Nov 3, 2027 for an SDA loan, then the reimbursement is matched on the PA and `sda_status` exits with reason `reclass`.", { todo: true });
// 15.4-T6 — implemented in src/domain/reo/reo.test.ts
// 15.4-T7 — implemented in src/domain/reo/reo.test.ts
test("15.4-T8: Given a payoff on an SDA loan (Fannie Mae receivable $8,860.00; our advances $5,904.58), then the payoff calculator includes Fannie Mae's receivable in the remittance, our $5,904.58 is recovered from the borrower's delinquent P&I on the payoff posting, and no reimbursement expectation is created.", { todo: true });
test("15.4-T9: Given a rescission approved Dec 1, 2027 after the $5,904.58 was reimbursed, then a reversing recovery is expected on the next Cash Adjustments report and the loan returns to `sda_active`.", { todo: true });
// 15.4-T10 — implemented in src/domain/reo/reo.test.ts
// 15.4-T11 — implemented in src/domain/reo/reo.test.ts
