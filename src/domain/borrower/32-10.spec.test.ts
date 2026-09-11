// 32.10 Servicing: hardship and delinquency
// spec/sections/32-borrower-experience/32-10-servicing-hardship-and-delinquency.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("32.10-T1: Given a payment due Sep 1, 2026 unpaid, then live-contact attempts are logged by Oct 7 (day 36) using only channels with consent, the EI notice and continuity assignment exist by Oct 16 (day 45), and the `PersonCard` shows a reachable direct number (4.3 T1).", { todo: true });
test("32.10-T2: Given the borrower types \"I lost my job and can't pay next month\" while current, then a QRPC record and an 11.5 imminent-default evaluation exist, and a `lossmit_applications` row is `received` (evaluative information present) with the 5-day ack.", { todo: true });
test("32.10-T3: Given an incomplete application, then `NTC_REGX_41B2_ACK_INCOMPLETE` lists the missing items and the reasonable date, and the same items appear in Needed-from-you.", { todo: true });
test("32.10-T4: Given a complete application received 40 days before a scheduled sale, then the Thread shows the protection sentence and `REGX_1024_41G_DUAL_TRACK_GATE` blocks the sale internally.", { todo: true });
test("32.10-T5: Given an offer notice on Nov 2, then Dates shows the 14-day acceptance deadline; silence → `deemed_rejected` on Nov 17 with the copy that said so on Nov 2.", { todo: true });
test("32.10-T6: Given a Flex Mod TPP offer, then the first trial payment received by its due date moves the case to `tpp_active` without any other tap, and the `PaymentCard` default equals the trial amount.", { todo: true });
test("32.10-T7: Given a forbearance plan, then the Loan section shows the paused period; a request beyond 12 cumulative months is refused with the LL-2026-01 copy; expiry renders the exit `ComparisonCard`.", { todo: true });
test("32.10-T8: Given a denial, then `NTC_REGX_41C1_DENIAL` renders with specific reasons and the appeal link; an appeal on day 15 → `NTC_REGX_41H_APPEAL_INELIGIBLE`.", { todo: true });
test("32.10-T9: Given a bankruptcy notice, then the badge changes, outbound collection stops, the statement variant switches, and `NTC_BK_PAYMENT_INSTRUCTIONS` renders without collection language.", { todo: true });
test("32.10-T10: Given day 121 with no pending application and all state notices sent, then `NTC_SM_FC_REFERRAL_ADVICE` renders with the help-still-available paragraph and the reinstatement `ChoiceCard`.", { todo: true });
test("32.10-T11: Given a `cease_communication` request on an FDCPA-covered loan, then outbound collection messages stop within the 11.4 window and the Thread confirms with `NTC_REGF_1006_6C_CEASE_ACK`; inbound remains open.", { todo: true });
