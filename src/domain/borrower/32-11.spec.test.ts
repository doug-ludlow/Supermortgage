// 32.11 Rate-watch and the re-refinance loop
// spec/sections/32-borrower-experience/32-11-rate-watch-and-the-re-refinance-loop.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("32.11-T1: Given `loan.purchased` on Nov 19, 2026, then no `OfferCard` exists before Mar 19, 2027 regardless of rates (`FNMA_C1_1_01_PREMIUM_RECAPTURE_120`); a borrower-initiated `refi.request` in that window produces `offer_ready` with the recapture acknowledgment internal only.", { todo: true });
test("32.11-T2: Given `offer_ready` and no marketing consent, then delivery is e-mail + in-app only; no `tcpa_voice` call or SMS is attempted; a human click-to-dial is permitted under the EBR (20.2 worked example 1).", { todo: true });
test("32.11-T3: Given the `OfferCard`, then it contains every field in §2 and no \"guarantee\"; the MLO attribution is present; the expiry equals `SM_REFI_OPPORTUNITY_EXPIRY_30.due_at`.", { todo: true });
test("32.11-T4: Given **Not now**, then `refi.opportunity.declined` and no proactive offer for 90 days; a typed \"can I refinance?\" on day 10 still yields `offer_ready`.", { todo: true });
test("32.11-T5: Given **Never**, then `consents{purpose=marketing}` is revoked, servicing informational consent remains, and the Rate-watch block stays passive.", { todo: true });
test("32.11-T6: Given **Yes**, then the compressed application asks income (fresh statement), hard-pull authorization, declarations and demographics again, and does not re-ask address (ConfirmCard from `servicing_record`) or identity documents; `application.trid_received` fires on the sixth confirmation.", { todo: true });
test("32.11-T7: Given the same-servicer funding, then the old loan reaches `paid_in_full` without a third-party wire, the escrow balance is `credited_to_new_loan`, and the Thread message says so; `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` is satisfied by the credit.", { todo: true });
test("32.11-T8: Given the partner was the original creditor and the new loan is rate/term, then the rescission state is whatever 25.3 computes and the UI renders no cancel window when `not_applicable`.", { todo: true });
test("32.11-T9: Given a standing connection consent revoked from the Loan section, then the next conversion creates `ConnectCard{truv_income}` again.", { todo: true });
test("32.11-T10: Given any Rate-watch copy, then it contains no reference to the investor and no future-terms promise (string tests on the copy library).", { todo: true });
