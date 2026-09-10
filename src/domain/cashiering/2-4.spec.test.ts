// 2.4 Additional principal / unscheduled payments
// spec/sections/02-payment-processing-cashiering/2-4-additional-principal-unscheduled-payments.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 2.4-T1 — implemented in src/domain/cashiering/section2.test.ts
// 2.4-T2 — implemented in src/domain/cashiering/section2.test.ts
// 2.4-T3 — implemented in src/domain/cashiering/section2.test.ts
// 2.4-T4 — implemented in src/domain/cashiering/section2.test.ts
// 2.4-T5 — implemented in src/domain/cashiering/section2.test.ts
// 2.4-T6 — implemented in src/domain/cashiering/section2.test.ts
// 2.4-T7 — implemented in src/domain/cashiering/section2.test.ts
test("2.4-T8: Given an autodraft borrower re-amortized effective 2026-12-01, when `REAMORT-EFFECTIVE-v1` is sent 2026-11-10, then the Reg E 10-day notice timer is satisfied and the December draft uses the new amount.", { todo: true });
test("2.4-T9: Given a curtailment check returned NSF after posting, when reversed, then UPB/LPI restore, the investor reversal references the curtailment event, and the October interest is recomputed on the restored balance.", { todo: true });
// 2.4-T10 — implemented in src/domain/cashiering/section2.test.ts
