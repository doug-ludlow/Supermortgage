// 3.9 State interest-on-escrow
// spec/sections/03-escrow-administration/3-9-state-interest-on-escrow.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("3.9-T1: Given a NY owner-occupied 2-family loan with Q3-2027 average daily balance $1,234.56, then $6.22 is credited on 2027-09-30 with ledger and event evidence.", { todo: true });
test("3.9-T2: Given a CT loan and the 2026 deposit index 0.49%, then the rate is 1.5% and $13.50 is credited on 2026-12-31 for an average $900 balance; payoff 2027-04-10 credits $3.70 before the refund.", { todo: true });
test("3.9-T3: Given a MN loan with origination LTV 85%, then `exempt` (ltv_gt_80); with 75% and first-of-month average $1,000, then $30.00 credited annually.", { todo: true });
test("3.9-T4: Given WI loans originated 1990-06-01, 2016-05-01 and 2019-03-01, then rates 5.25%, 0.17% (2026) and none respectively.", { todo: true });
test("3.9-T5: Given a RI loan with active PMI, then exempt; after PMI termination, accrual starts the next day.", { todo: true });
test("3.9-T6: Given a MA loan, then only the tax share of the balance accrues at the policy rate and the annual credit is posted at least once a year.", { todo: true });
test("3.9-T7: Given a VT loan with escrow imposed after the borrower failed to pay taxes last year, then exempt (escrow_imposed_for_default).", { todo: true });
test("3.9-T8: Given a NH loan, then the rate switches on Apr 1 and Oct 1 to the FDIC January/July savings rate observations.", { todo: true });
test("3.9-T9: Given a borrower with $24.88 total interest in 2027, then a 1099-INT is furnished by 2028-01-31 and e-filed by 2028-03-31; with $8.40, no form.", { todo: true });
test("3.9-T10: Given a rate observation missing on Jan 15 for MD, then accrual continues at the prior verified rate and a sev-2 escalation exists; on verification a true-up posts the difference.", { todo: true });
test("3.9-T11: Given a negative escrow balance for 20 days, then those days accrue $0.", { todo: true });
test("3.9-T12: Given an OR loan, then the rate changes on Jul 1 and Jan 1 from the May/Nov auction observations minus 100 bps, floored at 0.", { todo: true });
