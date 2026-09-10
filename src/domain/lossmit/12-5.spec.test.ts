// 12.5 Repayment plan
// spec/sections/12-loss-mitigation/12-5-repayment-plan.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 12.5-T1 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.5-T2: (BRP gate) loan 95 days delinquent \u2192 plan creation refused until the BRP is complete; 85 days + 6-month term \u2192 allowed on QRPC.", { todo: true });
test("12.5-T3: (>12 months) 14-month request \u2192 F-1-16 package generated; plan stays `extension_pending` until approval id recorded.", { todo: true });
test("12.5-T4: (late charges) charges during the plan are suppressed; at completion they are written off with reason; on failure in month 5, charges accrue from month 5 only.", { todo: true });
test("12.5-T5: (failure clock) payment missed at 2026-11-30 month-end, no QRPC, 4 months delinquent \u2192 deferral solicitation sent by 2026-12-15; if deferral-ineligible \u2192 Flex Mod solicitation by 2026-12-15.", { todo: true });
// 12.5-T6 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.5-T7: (CA) late fee assessment refused from the evaluation start date, not only from plan start.", { todo: true });
test("12.5-T8: (reporting) status 12 with effective date reported at BD2; completion date reported in the completion month; $500 incentive claimed when the start delinquency was \u226560 days.", { todo: true });
test("12.5-T9: (recast) escrow analysis raises PITI to $2,250 in month 3 \u2192 total $3,053.25 = 135.7% (still under cap) \u2192 no recast; a rise to $2,050 P&I-only edge case handled by the cap re-test.", { todo: true });
