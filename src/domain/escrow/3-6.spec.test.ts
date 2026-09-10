// 3.6 Shortage repayment
// spec/sections/03-escrow-administration/3-6-shortage-repayment.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("3.6-T1: Given shortage $406.68 and base $138.33, then plan 12 \u00d7 $33.89, final $33.89, and `loan_terms` shows $172.22 from 2027-07-01 stepping to $138.33 on 2028-07-01.", { todo: true });
test("3.6-T2: Given shortage $100.00 (< one month), then options allow/30-day/12-month are available and the default plan is 12 \u00d7 $8.33 with final $8.37.", { todo: true });
test("3.6-T3: Given deficiency $150.00 with `regx_days_delinquent=0`, then plan 12 \u00d7 $12.50; given 2 installments configured, then 2 \u00d7 $75.00.", { todo: true });
test("3.6-T4: Given a workout analysis shortage $2,400 with no election, then 60 \u00d7 $40.00; with an evidenced 24-month election, 24 \u00d7 $100.00; with a 6-month election, the election is rejected (\u2265 12).", { todo: true });
test("3.6-T5: Given `instrument_shortage_max_months=12` and policy 24, then months = 12.", { todo: true });
test("3.6-T6: Given an unsolicited lump sum equal to remaining shortage, then plan `paid_lump`, interim analysis within 10 BD, short-year statement, and the payment steps down on the first due date \u2265 30 days after the statement.", { todo: true });
test("3.6-T7: Given an advance of $900 on a NH property, then the deficiency plan is \u2265 12 months at 0% and the statement carries the RSA 397-A:9 option text.", { todo: true });
test("3.6-T8: Given a servicer advance and `demandDeficiencyRepayment` called before the interim analysis, then the command is refused with gate `REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE`.", { todo: true });
test("3.6-T9: Given a second analysis mid-plan with collected $203.34, then the new shortage reflects the actual balance and the old plan is `superseded` without double counting.", { todo: true });
test("3.6-T10: Given the annual statement for a \u2265-one-month shortage, then the rendered text contains no lump-sum wording (validator check).", { todo: true });
