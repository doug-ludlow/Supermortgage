// 11.5 Imminent default evaluation
// spec/sections/11-early-intervention-collections/11-5-imminent-default-evaluation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 11.5-T1 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.5-T2 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.5-T3 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.5-T4 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.5-T5 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.5-T6 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.5-T7: Given a current borrower declined by SMDU on 2026-10-21 with no counteroffer, then a Form 182/Reg B combined notice is due 2026-11-19 (earlier of 11-19 and 11-20) and issues only after `lossmit_reviewer` approval.", { todo: true });
test("11.5-T8: Given a counteroffer accepted on day 10 of the 14-day window, then `FNMA_D2101_FORM182_ADVERSE_30` is cancelled.", { todo: true });
test("11.5-T9: Given a borrower 12 days delinquent who has not asked for help, then any Form 745/BSP send is refused by `FNMA_D2101_NO_SOLICIT_LT30`; given the borrower asks \"what help is there?\" on a call, then the BSP is permitted with the request logged.", { todo: true });
test("11.5-T10: Given income documents dated 95 days before completeness, then the BRP is incomplete and the 12.1 missing-items notice lists them.", { todo: true });
test("11.5-T11: Given a Colorado loan with an AI-influenced ineligible result, then the pre-decision notice precedes the determination, the explanation lists the failed tests, and the appeal channel is offered.", { todo: true });
test("11.5-T12: Given SMDU B2B unavailable for 5 hours, then a `human_portal_task` with the full package is created and completed within 1 Fannie Mae BD, and the decision PDF is attached to the evaluation.", { todo: true });
test("11.5-T13: Given AI mode off, then the deterministic evaluation job produces the same test matrix for examples A and B (golden-file comparison) and the reviewer/notice steps are unchanged.", { todo: true });
test("11.5-T14: Given a Chapter 13 debtor, then bankruptcy schedules \u226490 days old substitute for Form 710 and communications go through counsel.", { todo: true });
