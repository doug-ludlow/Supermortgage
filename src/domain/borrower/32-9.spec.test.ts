// 32.9 Servicing: insurance, PMI, ARM, life events, requests
// spec/sections/32-borrower-experience/32-9-servicing-insurance-pmi-arm-life-events-requests.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("32.9-T1: Given a policy `cancelled` on Mar 1, then the §1024.37(c) first notice renders no later than 3 federal BD (`INS_FPI_FIRST_NOTICE_SLA_3BD`), the reminder ≥ 30 days later, and no charge before max(t0+45, t1+15).", { todo: true });
test("32.9-T2: Given evidence of continuous coverage uploaded on day 50 after placement, then the LPI is cancelled and the refund posted within 15 days with `INS_FPI_CANCEL_REFUND_CONFIRM`.", { todo: true });
test("32.9-T3: Given a flood map change into an SFHA, then `INS_FLOOD_MAP_CHANGE_NOTICE` renders with the coverage rule and a 45-day placement date in Dates.", { todo: true });
test("32.9-T4: Given `pmi.requestCancellation` on a loan at 79% LTV by amortization with a clean 12-month history, then the case reaches `cancellation_issued` without a valuation and `NTC_HPA_4904A_CANCELLED` renders.", { todo: true });
test("32.9-T5: Given a value check is needed, then the fee `ChoiceCard` appears, `awaiting_fee` expires at 60 days, and withdrawal before an order refunds the fee.", { todo: true });
test("32.9-T6: Given an ARM with the first change on Jul 1, 2028, then `NTC_REGZ_20D_ARM_INITIAL` is sent between Nov 3 and Dec 3, 2027 and Numbers show the estimated payment.", { todo: true });
test("32.9-T7: Given a message \"my mother passed away, I'm her son\", then a 4.4 case opens, the sender becomes `potential_successor`, the documents card renders from the matrix, and no collection language appears in any message to them.", { todo: true });
test("32.9-T8: Given a typed message \"you charged me a late fee I don't owe\", then a `noe` case opens, `NTC_REGX_35D_ACK` is sent within 5 federal BD, credit-reporting suppression is set for 60 days, and the Thread shows the response date.", { todo: true });
test("32.9-T9: Given a spoken payoff request, then the quote is given live, no 7-BD clock starts, and the one-tap conversion starts it.", { todo: true });
test("32.9-T10: Given a typed payoff request Fri Nov 6, 2026, then `NTC_REGZ_36C3_PAYOFF_STMT` is sent by Tue Nov 17 (servicer business days; Veterans Day closed) with wire instructions carrying the positive-confirmation text.", { todo: true });
test("32.9-T11: Given a message that is both a complaint and an assertion of error, then both cases exist and the complaint cannot close before the NoE responds.", { todo: true });
