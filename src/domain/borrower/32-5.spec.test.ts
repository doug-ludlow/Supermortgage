// 32.5 Verification, needs list, conditions, second borrower
// spec/sections/32-borrower-experience/32-5-verification-needs-list-conditions-second-borrower.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("32.5-T1: Given a DU verification message opens a `conditions` row, then within `SM_DU_CONDITIONS_SLA_4H` it appears in Needed-from-you with owner *you* and a verb-first label.", { todo: true });
test("32.5-T2: Given an `UploadCard{paystub}` receives a W-2, then the item stays `waiting_borrower` and the card shows the mismatch copy with the detected class.", { todo: true });
test("32.5-T3: Given a paystub dated 40 days before the application date, then the freshness copy renders the 30-day rule and the request stays open.", { todo: true });
test("32.5-T4: Given the closing date moves from Nov 6 to Dec 15, 2026 and an asset statement would exceed 4 months at the new note date, then `SM_DOC_EXPIRY_WARN_14` shows in Dates and a re-request is created on expiry with the reason text.", { todo: true });
test("32.5-T5: Given the pre-closing credit refresh finds a new tradeline, then a `ConfirmCard` renders naming creditor and open date and nothing about the decision; a yes adds `application_liabilities` and triggers DU resubmission per 23.1 tolerances.", { todo: true });
test("32.5-T6: Given a large deposit of $9,000 against $8,200 monthly qualifying income, then an `ExplanationCard` is created for that deposit only.", { todo: true });
test("32.5-T7: Given a co-borrower invite, then a `credit.authorize` for the invitee is refused until `joint_intent` is affirmed by that invitee (`SM_O21_JOINT_INTENT_GATE`).", { todo: true });
test("32.5-T8: Given a non-borrowing spouse party, then no `ProfileCard`, `DemographicsCard`, income or liability card is ever created for that party.", { todo: true });
test("32.5-T9: Given borrower A has active E-SIGN and borrower B does not, then the LE is electronic to A (`DocumentCard`) and mailed to B; the Record shows both statuses; the LE timer is satisfied by the mailing to B.", { todo: true });
test("32.5-T10: Given a human agent is engaged, when the agent attempts to resolve a `ConsentCard` on the borrower's behalf, then the API refuses (`party_id` mismatch).", { todo: true });
test("32.5-T11: Given zero `owner=you` items, then the Record shows the nothing-needed state and the status strip count is 0.", { todo: true });
