// 13.5 Allowable timeframes / compensatory fees
// spec/sections/13-foreclosure/13-5-allowable-timeframes-compensatory-fees.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 13.5-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.5-T2 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.5-T3 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.5-T4: Given a sale on June 30, 2025 in a state whose days changed on July 1, 2025, Then the prior exhibit version applies; July 1 \u21d2 new version.", { todo: true });
test("13.5-T5: Given elapsed days reach 70% of (allowable + credits), Then `at_risk` event and a firm status demand instruction.", { todo: true });
test("13.5-T6: Given a rescinded sale due to a missed DMDC check, Then $1,000 + costs exposure and root cause `servicer:scra`.", { todo: true });
test("13.5-T7: Given a second contested period, Then no additional credit and a note for \"reasonable explanation.\"", { todo: true });
test("13.5-T8: Given a bill received, Then `SM_COMP_FEE_BILL_REBUTTAL_30` starts, package drafted, `officer` escalation.", { todo: true });
test("13.5-T9: Given a non-preferred method proposed without Form 20 approval, Then `FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE` refuses first-notice authorization.", { todo: true });
