// 32.8 Servicing: loan home, payments, autopay, statements, escrow
// spec/sections/32-borrower-experience/32-8-servicing-loan-home-payments-autopay-statements-escrow.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("32.8-T1: Given due Oct 1 with 15-day grace, then the badge is \"Payment due\" Oct 1–15 with the grace end shown, \"Past due\" from Oct 16 with the assessed late charge, and \"Current\" on posting.", { todo: true });
test("32.8-T2: Given a `PaymentCard` submitted without a fresh L1 code in the last 10 minutes, then the API refuses and the card requests the code.", { todo: true });
test("32.8-T3: Given a payment of $1,000 against a $2,400 installment, then the Thread shows *held*, the remaining $1,400 and the 30-day rule; `suspense_items.open` exists; a request for refund resolves to `refunded`.", { todo: true });
test("32.8-T4: Given `ach.return.received{R01}`, then `AUTODRAFT-RETURN-v1` renders, one retry is scheduled in 3–5 banking days, and a second R01 moves the enrollment to `suspended_returns` with a re-activation `ChoiceCard`.", { todo: true });
test("32.8-T5: Given an autopay `ConsentCard`, then it contains every 2.x rule-1 element and the optional statement; `authorized` is never set from voice.", { todo: true });
test("32.8-T6: Given an escrow analysis raising the payment on Jan 1, then `AUTODRAFT-AMOUNT-CHANGE-v1` is sent ≥ 10 days before the Jan draft unless the escrow statement stated the exact amount and date.", { todo: true });
test("32.8-T7: Given a hard bounce on the statement availability e-mail, then a paper statement is mailed the same day, consent is `suspect`, and a re-verification card appears.", { todo: true });
test("32.8-T8: Given a shortage of $600, then the `ChoiceCard` shows +$50/month or $600 now; choosing spread creates a 12-installment plan and no lump-sum insert is rendered afterwards.", { todo: true });
test("32.8-T9: Given a surplus of $75 on a current loan, then a refund is scheduled and `NTC_SM_ESCROW_SURPLUS_REFUND` renders; given $40, then `credited_to_payments`.", { todo: true });
test("32.8-T10: Given an HPML loan consummated Nov 6, 2026, then `escrow.requestWaiver` before Nov 6, 2031 is refused with the escrow-period copy (23.4-T5).", { todo: true });
test("32.8-T11: Given no `irs_estatement` consent, then the 1098 shows *Mailed* and the December `ConsentCard` was offered.", { todo: true });
