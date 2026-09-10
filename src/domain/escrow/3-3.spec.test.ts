// 3.3 Annual escrow account statement
// spec/sections/03-escrow-administration/3-3-annual-escrow-account-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("3.3-T1: Given computation year ending 2027-06-30 and analysis approved 2027-05-18, when rendered, then the statement includes items (i)\u2013(viii), the prior projection attachment, and is sent by 2027-07-30.", { todo: true });
test("3.3-T2: Given the analysis is approved 2027-07-25, when rendered, then history uses actuals for May/June and the timer is still satisfied if sent by 2027-07-30.", { todo: true });
test("3.3-T3: Given `regx_days_delinquent = 45` at analysis, then status = `exempt_hold` with reason `delinquent_30`, no statement is mailed, `NTC_REGX_1024_17F_SHORTAGE` is sent if a shortage exists, and the (f)(5) timer is satisfied.", { todo: true });
test("3.3-T4: Given exemption ended 2027-09-10 by reinstatement, then `REGX_1024_17I2_POST_EXEMPTION_HISTORY_90` due 2027-12-09 and the history covers from the last statement.", { todo: true });
test("3.3-T5: Given shortage \u2265 one month, then the statement body contains no lump-sum wording; the insert (if enabled) is a separate document flagged optional.", { todo: true });
test("3.3-T6: Given transfer-out effective 2027-03-01, then the annual timer is cancelled and `REGX_1024_17I4_SHORT_YEAR_TRANSFER_60` is due 2027-04-30.", { todo: true });
test("3.3-T7: Given payoff funds received 2027-02-10, then short-year payoff statement due 2027-04-11 and it shows the refund disposition.", { todo: true });
test("3.3-T8: Given a due date 2027-07-30 (Friday) vs 2027-08-01 (Sunday) scenarios, then no business-day roll is applied; the send target is \u2265 5 BD earlier.", { todo: true });
test("3.3-T9: Given actual December tax $760 vs projected $700, then item (viii) lists the county-tax variance and the low-balance difference.", { todo: true });
test("3.3-T10: Given a Utah property, then the calendar-year supplemental statement is sent by March 1 unless the annual statement already covers Jan\u2013Dec.", { todo: true });
test("3.3-T11: Given an open Chapter 13 case and flag `bk_suppress=off`, then the statement is produced with the BK legend and a 3002.1 package is created when the payment changes.", { todo: true });
test("3.3-T12: Given the print vendor is down on the send date, then the in-house fallback mails and evidence is stored.", { todo: true });
