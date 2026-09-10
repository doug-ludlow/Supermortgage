// 12.2 Complete-application evaluation
// spec/sections/12-loss-mitigation/12-2-complete-application-evaluation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 12.2-T1 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.2-T2 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.2-T3: (denial content) Flex Mod denied because \"loan has been modified three times previously\" \u2192 notice names Fannie Mae, quotes the criterion, states other criteria not evaluated; `lossmit_reviewer` approval recorded before mailing; mailing blocked without approval.", { todo: true });
// 12.2-T4 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.2-T5: (third-party delay) BPO outstanding at day 30 \u2192 delay notice plus all determinable results sent by day 30; on BPO receipt day 38, short-sale determination sent within 5 days; `foreclosure_holds{kind=lm_third_party_pending}` held throughout.", { todo: true });
test("12.2-T6: (current borrower, Fannie Mae declines) imminent-default case declined in SMDU \u2192 Form 182-based notice within 30 days; Reg B timer satisfied; counteroffer accepted \u2192 timers cancelled with reason.", { todo: true });
// 12.2-T7 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.2-T8: (appeal extends acceptance) appeal filed day 10 \u2192 original offer `accept_by` becomes appeal notice + 14.", { todo: true });
// 12.2-T9 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.2-T10: (CA) denial \u2192 `CA_CIV_2923_6E_NOD_NOS_HOLD_31`; 13.x NOD command refused on day 20; appeal window 30 days shown in notice.", { todo: true });
test("12.2-T11: (SMDU outage) B2B down 6 hours at day 24 \u2192 portal task filed with package; decision recorded from the operator's SMDU result; notice on time.", { todo: true });
test("12.2-T12: (counsel) hold set on a loan with a pending summary-judgment motion \u2192 instruction sent within 1 BD and acknowledged; a sale conducted anyway is detected by the 13.x sale-event reconciliation and raises a sev-1 NoE-risk incident.", { todo: true });
test("12.2-T13: (streamlined offer with open incomplete application) day-90 Flex Mod solicitation issued while an incomplete application is open \u2192 letter includes incomplete-application disclosures; diligence follow-ups continue; no (c)(1) clock started by the solicitation.", { todo: true });
