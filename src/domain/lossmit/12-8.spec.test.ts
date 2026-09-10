// 12.8 Fannie Mae Flex Modification
// spec/sections/12-loss-mitigation/12-8-fannie-mae-flex-modification.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 12.8-T1 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.8-T2 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.8-T3 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.8-T4 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.8-T5 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.8-T6: (solicitation window) day 90 on 2026-11-02 with no BRP \u2192 solicitation by 2026-11-17; a non-judicial sale scheduled 2026-11-25 \u2192 solicitation refused.", { todo: true });
test("12.8-T7: (MBS) MBS loan \u2192 servicer execution blocked until `smdu.case.reclassified`; effective date re-dated if needed.", { todo: true });
test("12.8-T8: (documents) Form 3179 sent 2026-12-01; borrower e-signs 2026-12-10; `signing_officer` executes 2026-12-28; recording required \u2192 certified copy of the executed agreement to the custodian by 2027-01-04 (25 days from 2026-12-10), e-recorded 2027-01-05, original to the custodian within 5 BD of receipt from the recorder; an unrecorded agreement instead goes as the fully executed original by 2027-01-04.", { todo: true });
test("12.8-T9: (conversion ledger) capitalization entries balance; late charges $505.68 waived; NIB $35,483.32 in `forborne_principal`; loan terms versioned effective 2027-01-01; delinquency reset; loan-data change acked.", { todo: true });
test("12.8-T10: (incentive) SMDU close by 2027-02-28 \u2192 $1,000 claimed; close on 2027-03-02 \u2192 no claim, sev-3 logged.", { todo: true });
test("12.8-T11: (three prior mods) denial with the specific Fannie Mae criterion; reviewer approval; appeal rights.", { todo: true });
test("12.8-T12: (MIR feed) MIR table lacks a rate for the evaluation date \u2192 waterfall refuses to run; `officer` alert.", { todo: true });
