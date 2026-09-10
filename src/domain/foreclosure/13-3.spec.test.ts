// 13.3 Foreclosure referral
// spec/sections/13-foreclosure/13-3-foreclosure-referral.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("13.3-T1: Given a principal residence, gates open on day 121 and review outcome `refer`, When `foreclosure.refer`, Then package sent with manifest hashes, `referral_sent_at` recorded, status 43 queued, firm ack timer 2 BD.", { todo: true });
test("13.3-T2: Given a non-principal residence at day 118 with review complete, Then referral must occur by day 120; if a complete BRP arrives day 119, E-3.2-04 postponement recorded and the deadline suspended.", { todo: true });
test("13.3-T3: Given MERS mortgagee and a pre-recordation state, When the assignment is unrecorded, Then `first_notice.authorize` refused; recorded \u21d2 allowed on the first day all gates open.", { todo: true });
test("13.3-T4: Given NY, Then `NTC_STATE_PREFC_NY_1304` renders with \u22655 county agencies, certified + first-class mail evidence, \u00a71306 filing within 3 BD; first notice refused before day 90.", { todo: true });
// 13.3-T5 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.3-T6 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.3-T7 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.3-T8: Given the firm requests a document, When 3 BD pass without response, Then sev-1 escalation and comp-fee exposure flagged.", { todo: true });
test("13.3-T9: Given a bankruptcy filed after referral, Then firm notified within 1 BD, case `on_hold_bankruptcy`, referral-back on relief to the same firm.", { todo: true });
test("13.3-T10: Given the reserve price expires before the rescheduled sale and no refresh is available in time, Then basis falls back to total indebtedness and the decision record explains why.", { todo: true });
test("13.3-T11: Given the pre-sale inspection reports major uninsured fire damage, Then no bid is issued and a Servicing Representative contact task is created.", { todo: true });
test("13.3-T12: Given a transfer-in of a case with `first_notice_filed_at` evidenced, Then no state pre-foreclosure notice is re-sent and 13.5 uses the transferor's LPI date.", { todo: true });
