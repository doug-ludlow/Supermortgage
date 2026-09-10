// 6.2 Establish T&I custodial account (Form 1014)
// spec/sections/06-custodial-account-management/6-2-establish-t-i-custodial-account-form-1014.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 6.2-T1 — implemented in src/domain/custodial/custodial.test.ts
// 6.2-T2 — implemented in src/domain/custodial/custodial.test.ts
// 6.2-T3 — implemented in src/domain/custodial/custodial.test.ts
test("6.2-T4: Given no disposition by day 30, then breach \u2192 `officer` medium and the amount appears as an aged \"Other\" item on Form 496A.", { todo: true });
// 6.2-T5 — implemented in src/domain/custodial/custodial.test.ts
test("6.2-T6: Given a debit on the T&I statement with no `disbursements` match within 1 BD, then exception `unmatched_debit` opens with severity high and the bank's positive-pay exception list is pulled.", { todo: true });
