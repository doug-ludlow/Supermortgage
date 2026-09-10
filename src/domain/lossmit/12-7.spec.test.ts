// 12.7 Disaster Payment Deferral
// spec/sections/12-loss-mitigation/12-7-disaster-payment-deferral.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("12.7-T1: Given a FEMA IA county, incident 2026-05-10, loan current at incident, disaster forbearance 2026-06-01..2026-11-30 without QRPC, when the plan expires, then the solicitation is sent by 2026-12-15 and, on acceptance 2026-12-20, the case is entered by 2026-12-31 (or processing month January under policy).", { todo: true });
// 12.7-T2 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.7-T3: (12-month rule) 12 months delinquent at evaluation \u2192 contractual payment required before completion.", { todo: true });
// 12.7-T4 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.7-T5: (same event) second disaster deferral request for the same `disaster_event_id` \u2192 refused; a new event \u2192 allowed.", { todo: true });
test("12.7-T6: (routing) ineligible (13 months delinquent) \u2192 Flex Mod disaster-criteria evaluation started within 5 BD.", { todo: true });
test("12.7-T7: (foreclosure gate) pre-referral review completed 2026-12-01 on a disaster loan \u2192 referral refused until Fannie Mae approval; submission by 2026-12-06.", { todo: true });
// 12.7-T8 — implemented in src/domain/lossmit/lossmit.test.ts
