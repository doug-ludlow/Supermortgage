// 32.6 Decision, property, title, insurance, MI, clear to close
// spec/sections/32-borrower-experience/32-6-decision-property-title-insurance-mi-clear-to-close.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("32.6-T1: Given `decision.issued{conditional_approval}`, then `NTC_REGB_1002_9_APPROVAL` renders, Dates shows `valid_until`, and Needed-from-you equals the `waiting_borrower` conditions.", { todo: true });
test("32.6-T2: Given a lender-initiated loan-amount reduction, then a counteroffer notice and `ComparisonCard` exist, `REGB_1002_9_COUNTEROFFER_90` appears in Dates, and no adverse-action notice exists while the window is open.", { todo: true });
test("32.6-T3: Given `decision.issued{denial}`, then the payload contains the specific reasons from the template and no DU recommendation string; the Record is read-only.", { todo: true });
test("32.6-T4: Given value acceptance offered at the final DU submission, then Property shows \"No appraisal needed\" and no `ScheduleCard{appraisal_access}` exists.", { todo: true });
test("32.6-T5: Given an appraisal accepted Wed Nov 4, 2026 with consummation Fri Nov 6, then the copy `DocumentCard` was delivered ≥ 3 business days earlier or a `copy_waived` record ≥ 3 BD before consummation exists; otherwise `consummate` is refused.", { todo: true });
test("32.6-T6: Given a purchase appraisal below price, then the `ChoiceCard` offers renegotiate / cash / cancel and a chosen \"cash\" writes the new down payment as `source=borrower` and triggers DU resubmission.", { todo: true });
test("32.6-T7: Given `project_reviews.status = pending_docs`, then SQ-08 cards exist and the item is owner *you* only for documents the HOA sends to the borrower; otherwise owner *third party*.", { todo: true });
test("32.6-T8: Given a hazard policy with a 7% deductible, then `deficient` renders a deficiency card naming the deductible only.", { todo: true });
test("32.6-T9: Given `in_sfha = true`, then `NTC_FDPA_4104A_FLOOD_NOTICE` is delivered with `requires_ack` ≥ 10 days before the scheduled closing, and no closing slot renders before `flood.notice.delivered`.", { todo: true });
test("32.6-T10: Given LTV 92%, then the MI `ComparisonCard` shows four plans with cancellation rules; `mi.selectPlan{lpmi}` produces a revised LE with a higher rate and no MI line.", { todo: true });
test("32.6-T11: Given `ctc_checklists.passed = true`, then the badge is \"Clear to close\" and the closing `ScheduleCard` waits for `earliest_consummation_date`.", { todo: true });
test("32.6-T12: Given `SM_QC_PREFUNDING_HOLD`, then the Thread copy is `ctc.final_review` and contains no \"QC\".", { todo: true });
