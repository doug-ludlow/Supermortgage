// 12.4 Forbearance plan
// spec/sections/12-loss-mitigation/12-4-forbearance-plan.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 12.4-T1 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.4-T2 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.4-T3 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.4-T4: (pre-expiry) outreach begins by 2026-12-01 for a 2026-12-31 term end and continues at least every 3 days; QRPC on 2026-12-10 \u2192 hierarchy pre-screen executed the same day.", { todo: true });
test("12.4-T5: (no QRPC at expiry) deferral-eligible (4 months delinquent) \u2192 post-forbearance deferral solicitation by 2027-01-15; if deferral-ineligible \u2192 Flex Mod solicitation by 2027-01-15.", { todo: true });
test("12.4-T6: (disaster) FEMA IA area, current at disaster, 1 month delinquent \u2192 3-month plan without QRPC; QRPC attempts logged every \u22647 days.", { todo: true });
test("12.4-T7: (reduced payment miss) reduced payment not received by month-end \u2192 mitigating-circumstances check; termination notice; late charges from the default date only.", { todo: true });
// 12.4-T8 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.4-T9: (holds) 13.3 referral command refused while the plan is active; allowed 1 BD after `terminated{failed_terms}` (subject to 13.1).", { todo: true });
test("12.4-T10: (Q1 2027 flag) with `smdu.plan_cases=on`, the plan creates an SMDU forbearance case and stops emitting code 09 in the legacy file.", { todo: true });
