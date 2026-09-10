// 3.5 Surplus refund
// spec/sections/03-escrow-administration/3-5-surplus-refund.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("3.5-T1: Given surplus $143.32, current borrower, as_of 2027-05-16, then timer due 2027-06-15 and a check is issued with ledger entries balanced.", { todo: true });
test("3.5-T2: Given surplus exactly $50.00, then refund is mandatory; given $49.99, then credit path.", { todo: true });
test("3.5-T3: Given `regx_days_delinquent=31` at analysis, then status `retained`, no timer; on reinstatement an interim analysis re-decides.", { todo: true });
test("3.5-T4: Given payoff posted Thu 2027-02-11, then due date = 2027-03-12 (Presidents' Day excluded).", { todo: true });
test("3.5-T5: Given payoff posted Fri 2027-12-24 (Christmas observed 12/24? \u2014 federal holiday 12/25 falls on Saturday, observed Fri 12/24), then day count starts Mon 12/27 and excludes 2028-01-17 (MLK); due date computed by the calendar service equals the hand-count.", { todo: true });
test("3.5-T6: Given borrower oral consent (recorded call) to credit $612.40 to a new same-servicer loan settling 2027-03-01, then no check is issued and the inter-loan ledger transfer posts on settlement.", { todo: true });
test("3.5-T7: Given a check returned undeliverable on day 25, then address verification and reissue occur before day 30 or the breach is logged with evidence of attempts.", { todo: true });
test("3.5-T8: Given a check uncashed at 180 days, then outreach notice is sent and the state escheat timer starts.", { todo: true });
test("3.5-T9: Given refund $30,000 (large overfunded account), then `officer` dual approval is required before issuance and the 30-day timer still governs.", { todo: true });
test("3.5-T10: Given a Fannie Mae escrow disbursement event rejected for balance mismatch, then the event is corrected and resubmitted before 3:00 a.m. ET next BD (3.7).", { todo: true });
