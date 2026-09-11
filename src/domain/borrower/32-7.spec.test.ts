// 32.7 CD, closing, rescission, funding, boarding
// spec/sections/32-borrower-experience/32-7-cd-closing-rescission-funding-boarding.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("32.7-T1: Given the CD e-mailed Mon Nov 2, 2026 without confirmation, then `deemed received` is Thu Nov 5 (specific business days) and `earliest_consummation_date` is Mon Nov 9; given confirmation Mon Nov 2, then `earliest_consummation_date` is Fri Nov 6 (25.2 fixture).", { todo: true });
test("32.7-T2: Given an APR increase beyond tolerance after CD delivery, then a superseding CD card renders with `cd.redisclosed_restart` and Dates recompute.", { todo: true });
test("32.7-T3: Given a co-borrower without active E-SIGN, then their CD is mailed and the `earliest_consummation_date` uses the later of the two receipt dates.", { todo: true });
test("32.7-T4: Given `SM_O72_RON_STATE_AUTH_GATE` closed for the property state, then the `ScheduleCard` offers `ipen|hybrid|wet` and never `ron`.", { todo: true });
test("32.7-T5: Given the borrower declines electronic records, then `closing_type = wet`, no eNote is built, and the Thread confirms the paper path.", { todo: true });
test("32.7-T6: Given `signed` on a primary-residence refinance by a different creditor, then the H-8 card renders with `requires_ack`, Dates shows midnight of the third specific business day, and `disburse` is refused before `expires_at` (`REGZ_1026_23_RESCISSION_3SBD_GATE`).", { todo: true });
test("32.7-T7: Given a purchase, then no rescission card or cancel window renders (`not_applicable`).", { todo: true });
test("32.7-T8: Given the borrower opens \"How to cancel\" and confirms, then `rescinded → unwinding`, `REGZ_1026_23D2_RESCISSION_REFUND_20` is created, and the Record is read-only with badge \"Cancelled\".", { todo: true });
test("32.7-T9: Given `fundings.status = held{reason=insurance_effective_date}`, then the borrower sees a single ask for the corrected effective date and no wire-status detail.", { todo: true });
test("32.7-T10: Given `loan.funded` on Thu Nov 12, 2026 for a refinance, then the funded message names the prior servicer, the 20-day refund clock, and a first payment date ≤ Jan 12, 2027 (`FNMA_B2_1_5_FIRST_PAYMENT_2M`).", { todo: true });
test("32.7-T11: Given `loan.boarded`, then `NTC_SM_FIRST_PAYMENT_LETTER` is sent within 5 servicer business days and the Record shows the servicing layout; the autopay `ConsentCard` includes every 2.x rule-1 element and the optional statement.", { todo: true });
test("32.7-T12: Given E6 consent scoped only `origination_disclosures`, then the first statement is paper and a servicing-scope `ConsentCard` is offered.", { todo: true });
test("32.7-T13: Given `loan.purchased`, then the `HandoffCard{fannie_mae_letter}` exists and, on the borrower's upload of the letter, `ownership_transfer_notices.evidenced` is set.", { todo: true });
