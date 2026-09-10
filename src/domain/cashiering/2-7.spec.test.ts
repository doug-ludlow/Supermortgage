// 2.7 Late charge assessment
// spec/sections/02-payment-processing-cashiering/2-7-late-charge-assessment.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 2.7-T1 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T2 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T3 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T4 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T5 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T6 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T7 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T8 — implemented in src/domain/cashiering/section2.test.ts
test("2.7-T9: Given a note with 4% and 10-day grace boarded in a state capping at 5%/15 days, then the loan's terms (4%/10) apply; given a note with 5%/15 in a state capping at 4%/\u2026 **[UNVERIFIED state]**, then boarding flags the conflict and the lower cap is applied.", { todo: true });
// 2.7-T10 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T11 — implemented in src/domain/cashiering/section2.test.ts
// 2.7-T12 — implemented in src/domain/cashiering/section2.test.ts
test("2.7-T13: Given late charges collected in September, when 5.1 builds the period's LAR/event, then `fees.collected` equals \u03a3 `collected_cents` for the period.", { todo: true });
