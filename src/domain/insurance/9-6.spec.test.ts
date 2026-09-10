// 9.6 Flood insurance / mandatory purchase
// spec/sections/09-insurance-property-protection/9-6-flood-insurance-mandatory-purchase.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 9.6-T1 — implemented in src/domain/insurance/insurance.test.ts
// 9.6-T2 — implemented in src/domain/insurance/insurance.test.ts
// 9.6-T3 — implemented in src/domain/insurance/insurance.test.ts
// 9.6-T4 — implemented in src/domain/insurance/insurance.test.ts
// 9.6-T5 — implemented in src/domain/insurance/insurance.test.ts
test("9.6-T6: Given a LOMA letter Then requirement cleared, LPI cancelled effective the letter date, refund of any borrower-paid overlap, `INS_FLOOD_REMOVED_NOTICE` sent.", { todo: true });
test("9.6-T7: Given a hazard lapse and flood lapse on the same day Then MS-3(A) and the flood 45-day notice are mailed as separate documents in one transmittal; timers independent.", { todo: true });
test("9.6-T8: Given no vendor heartbeat for 36 days Then sev-2 and a re-order queue for pending alerts.", { todo: true });
// 9.6-T9 — implemented in src/domain/insurance/insurance.test.ts
