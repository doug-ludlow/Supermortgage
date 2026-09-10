// 12.3 Appeal handling
// spec/sections/12-loss-mitigation/12-3-appeal-handling.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 12.3-T1 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.3-T2: (independence) assignment of the original approving reviewer is refused with a logged reason; assignment of an uninvolved supervisor is accepted.", { todo: true });
test("12.3-T3: (late appeal) appeal received 2026-11-20 \u2192 ineligible notice; new pay stubs reviewed as new information; foreclosure holds released only after reviewer confirmation.", { todo: true });
test("12.3-T4", { todo: true });
// 12.3-T5 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.3-T6 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.3-T7 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.3-T8: (before first filing) loan 100 days delinquent, no filing, denial \u2192 appeal available even though a hypothetical sale date is unknown.", { todo: true });
// 12.3-T9 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.3-T10: (breach) decision not provided by day 30 \u2192 `officer` sev-1, borrower notified of status, holds maintained.", { todo: true });
