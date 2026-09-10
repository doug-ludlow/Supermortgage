// 13.4 Prereferral review
// spec/sections/13-foreclosure/13-4-prereferral-review.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

// 13.4-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.4-T2: Given a principal residence with an offer response window open until day 125, Then outcome `hold_lossmit`; on expiry without acceptance, re-review \u2192 `refer` (no delay beyond expiry per E-3.2-01).", { todo: true });
test("13.4-T3: Given a complete BRP on day 119 for a non-principal residence, Then `postpone_e3204`; determination on day 140 (offer sent, 14-day window) \u2192 acceptance day 150 \u2192 first payment due Aug. 1 \u2192 referral held until Aug. 31 if unpaid; paid \u2192 held until breach.", { todo: true });
test("13.4-T4: Given a FEMA IA declaration and inspection damage, Then outcome `hold_disaster_approval`, request emailed within 5 days with all five content elements, gate closed until approval; approval \u2192 `refer`.", { todo: true });
test("13.4-T5: Given DMDC shows active duty, Then `hold_scra`; the referral command is refused even if all other items pass.", { todo: true });
test("13.4-T6: Given MA property without the lead-paint citation search, Then refused; with search evidence, passes.", { todo: true });
test("13.4-T7: Given an abandoned property (two vacant inspections, utilities off) on a non-principal residence at day 70, Then expedited outcome permitted at breach-letter expiry; on a principal residence the Reg X gate still blocks until day 121.", { todo: true });
test("13.4-T8: Given a model-evaluated occupancy item with confidence 0.7, Then `human_agent` verification task; review cannot complete until resolved.", { todo: true });
test("13.4-T9: Given a pending successor-in-interest request, Then `SII_STATUS` fails and the review holds.", { todo: true });
test("13.4-T10: Given a bankruptcy hit in the scrub, Then `hold_bankruptcy` and 14.x case opened.", { todo: true });
