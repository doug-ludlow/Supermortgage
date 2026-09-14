// 23.7 Preflight: what DU rejects that the schema accepts, and the port contract for a real submission
// spec/sections/23-desktop-underwriter-and-the-credit-decision/23-7-preflight-and-the-du-port-contract.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("23.7-T1: Given each of the eighteen samples re-emitted (23.6-T1), when preflight runs, then every check passes and `SM_DU_PREFLIGHT_GATE` opens.", { todo: true });
test("23.7-T2: Given a document whose `RELATIONSHIP` names an `xlink:to` label not in the document, when preflight runs, then it is refused with `DU_PREFLIGHT_DANGLING_ARC` naming the arc — and the same document validates against the XSD chain.", { todo: true });
test("23.7-T3: Given a document with two containers labelled `ASSET_1`, then `DU_PREFLIGHT_DUPLICATE_LABEL`; given an arcrole URI not among the eleven, then `DU_PREFLIGHT_UNKNOWN_ARCROLE`; given `UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET`, then `DU_PREFLIGHT_DISPUTED_ARC` — each while the XSD chain validates the document.", { todo: true });
test("23.7-T4: Given a document with five `PARTY` containers each holding a borrower `ROLE`, when preflight runs, then `DU_PREFLIGHT_BORROWER_COUNT`; given none, then `DU_PREFLIGHT_NOTHING_TO_UNDERWRITE`.", { todo: true });
test("23.7-T5: Given a document whose `RELATIONSHIPS` container has been removed while `ASSET` containers remain, then `DU_PREFLIGHT_NO_GRAPH`.", { todo: true });
test("23.7-T6: Given two `ASSET` containers with the same institution, subtype and last4 owned by different borrowers on one application, then `DU_PREFLIGHT_DUPLICATE_ASSET` naming both labels.", { todo: true });
test("23.7-T7: Given `submission_number = 1` and an `AutomatedUnderwritingCaseIdentifier` present, then `DU_PREFLIGHT_CASEFILE_ID`; given `submission_number = 2` and the identifier absent or different from `applications.du_casefile_id`, then the same code.", { todo: true });
test("23.7-T8: Given the FAKE port receives a document that fails `xmllint` against the chain, then it answers `DuTransportError` with status 400 and records no submission.", { todo: true });
test("23.7-T9: Given the refinance fixture's first submission through the FAKE port, when the ack returns `du_casefile_id`, then `applications.du_casefile_id` holds it; when the second submission's ack returns the same value, then nothing changes; when it returns a different value, then an `escalation{fnma_portal_operator}` is opened with `DU_CASEFILE_ID_CONFLICT` and the column is unchanged.", { todo: true });
test("23.7-T10: Given a preflight refusal, when 23.1's `submit` is invoked for that document, then it is refused with the preflight code and no `du.submitted` event exists.", { todo: true });
test("23.7-T11: Given a wage income item whose `EmploymentIncomeIndicator` is true and which has no `CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER` arc, then `DU_PREFLIGHT_EMPLOYER_ARC` naming the income item's label.", { todo: true });
test("23.7-T12: Given a casefile whose `seller_number` is empty, then `DU_PREFLIGHT_CREDENTIALS` before any other check runs.", { todo: true });
