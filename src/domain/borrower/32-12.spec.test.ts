// 32.12 Exits
// spec/sections/32-borrower-experience/32-12-exits.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("32.12-T1: Given a typed payoff request, then `NTC_REGZ_36C3_PAYOFF_STMT` renders within 7 servicer business days with the components, good-through date and the positive-confirmation text; a rate change before funds → `NTC_PAYOFF_UPDATED_STMT`.", { todo: true });
test("32.12-T2: Given funds $300 short of the good-through figure, then `NTC_PAYOFF_SHORTAGE_DEMAND` renders; cured → `paid_in_full`; uncured at day 30 → funds applied per the note and the loan stays open with a `StatusCard` explaining.", { todo: true });
test("32.12-T3: Given `paid_in_full` on Mar 3, then the escrow refund is scheduled by Mar 23 (`REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD`), autopay is `terminated`, and rate-watch is `void`.", { todo: true });
test("32.12-T4: Given a California trustee-path release, then the `NTC_LIEN_RELEASE_RECORDED` copy explains the reconveyance path and Dates shows the state deadline.", { todo: true });
test("32.12-T5: Given a goodbye notice mailed Sep 16 for an Oct 1 transfer, then `REGX_1024_33B3_COMBINED_15` is satisfied, the badge and Dates update, and autopay shows its end date (1.3 T1).", { todo: true });
test("32.12-T6: Given a payment received by Supermortgage on Oct 14 after an Oct 1 transfer, then the Thread states the payment is forwarded and protected; on day 61+ the protection text is absent.", { todo: true });
test("32.12-T7: Given a confirmed successor who declined borrower notices, then no statements are sent to them, but an RFI they submit is acknowledged and answered on the 4.2 clocks.", { todo: true });
test("32.12-T8: Given `closed`, then the Record is read-only, documents remain downloadable, and a new typed question still creates a case.", { todo: true });
