// 13.9 SCRA 6% interest cap
// spec/sections/13-foreclosure/13-9-scra-6-interest-cap.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 13.9-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.9-T2 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.9-T3 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.9-T4 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.9-T5: Given a portfolio loan, Then Form 1022 emailed by BD9 of the following month with the reduction; MBS loan \u21d2 upload by CD15; both tracked with acks.", { todo: true });
test("13.9-T6: Given late charges of $81.86 assessed May\u2013Aug. 2026, Then waived/refunded with the recalculation; 2.7 gate blocks new ones.", { todo: true });
test("13.9-T7: Given the borrower elects refund, Then Dr `scra_overpayment_payable` 1,528.30 / Cr cash; election recorded; statement shows the refund transaction.", { todo: true });
test("13.9-T8: Given no election in 30 days, Then the default election (decision 13.9-3) applies and the borrower is told.", { todo: true });
test("13.9-T9: Given the borrower asserts service but DMDC returns N and no orders, Then no denial without `attorney` review; a request for orders is sent.", { todo: true });
test("13.9-T10: Given a request 200 days after release with verified service, Then the cap is applied retroactively for the service period + tail (policy) and Form 1022 sent.", { todo: true });
// 13.9-T11 — implemented in src/domain/foreclosure/foreclosure.test.ts
