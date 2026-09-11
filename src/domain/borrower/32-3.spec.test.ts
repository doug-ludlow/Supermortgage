// 32.3 Entry and the five-minute qualification
// spec/sections/32-borrower-experience/32-3-entry-and-the-five-minute-qualification.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("32.3-T1: Given a new web session, when the first assistant message renders, then it contains the automation disclosure and `lead.disclosure.delivered` is logged before any other assistant content; same for voice (spoken) and SMS (first outbound).", { todo: true });
test("32.3-T2: Given the borrower types \"are you a real person?\", then the reply is the 20.3 T11 script and a second `lead.disclosure.delivered` row exists.", { todo: true });
test("32.3-T3: Given `sessions.level = L1`, when the client requests `borrower_record` for an application with personal terms, then `numbers` is omitted and cards requiring L2+ are not created.", { todo: true });
test("32.3-T4: Given L1 only, when `credit.authorize{hard_pull}` is called, then the API returns `{gate: SM_IDENTITY_IAL2_GATE}` and no `credit_authorizations` row is written.", { todo: true });
test("32.3-T5: Given Stripe extracted \"Jane Q. Public, 1990-04-01, 14 Elm St\", when the borrower taps Edit on the address and confirms \"22 Elm St\", then `application_borrowers.current_address = \"22 Elm St\"` with `source = borrower`, and name/DOB carry `source = stripe_identity`, all with `confirmed_at`.", { todo: true });
test("32.3-T6: Given an in-app voice call, when the borrower says \"yes, e-delivery is fine\", then no `consents{kind=esign}` row becomes `active`; the assistant sends the E-SIGN invitation link (20.3 T8).", { todo: true });
test("32.3-T7: Given `consents{esign}` is `consented_pending_verification` when the LE is approved, then `disclosure.le.mailed` fires, the Record shows *Mailed*, and no `DocumentCard` for the LE is created until `active` and a re-delivery is made.", { todo: true });
test("32.3-T8: Given the borrower confirms the property address, then `trid_items.property_address.present = true` and `application.trid_received` has not fired.", { todo: true });
test("32.3-T9: Given two borrowers with different score models, then the UI shows the neutral re-run message and no scores; DU association is refused until re-ordered (23.1 T11).", { todo: true });
test("32.3-T10: Given `credit.report.received` at 09:00 Tuesday, then `NTC_FCRA_609G_CREDIT_SCORE` is delivered by end of Wednesday (`FCRA_609G_SCORE_NOTICE_1BD`).", { todo: true });
test("32.3-T11: Given Truv returns $8,200 monthly base, when the borrower confirms, then `application_income` has `amount_cents = 820000, source = payroll_connection, confirmed_at set` and `trid_items.income.present = true`; given the borrower instead types $8,000, then `source = borrower`.", { todo: true });
test("32.3-T12: Given a DU validation report with `close_by_date`, then the date exists in `verifications` and nowhere in any client payload.", { todo: true });
test("32.3-T13: Given the Profile card, when the borrower taps Confirm without choosing citizenship, then the card refuses and the field is not written.", { todo: true });
test("32.3-T14: Given \"None of these apply\", then thirteen `declarations` values are `false` and `evidence.list_version_hash` is set.", { todo: true });
test("32.3-T15: Given `applications.status = started` is not yet reached, when a client posts `application.answerDemographics`, then the API refuses (20.3 T12).", { todo: true });
test("32.3-T16: Given the borrower selects \"I do not wish to provide\" for ethnicity, then `applicant_demographics.ethnicity = declined` and `collection_method = internet`.", { todo: true });
test("32.3-T17: Given income confirmed at 10:02, SSN authorization at 10:03, address at 10:04, value at 10:05 and loan amount at 10:06 (ET), then `trid_application_date = 10:06` and `REGZ_1026_19E1_LE_3BD.due_at` is end of the third creditor business day after.", { todo: true });
test("32.3-T18: Given the AVM card is shown and the borrower edits to $600,000, then `property_value_estimate.present = true` with `source = borrower`; given no action, then `present = false`.", { todo: true });
test("32.3-T19: Given any `du.findings.received`, then no field of the findings appears in `/v1/borrower/*` responses (contract test on serializers).", { todo: true });
test("32.3-T20: Given findings at 14:00, then a `ChecklistCard` with materialized conditions exists by 18:00 the same creditor business day (`SM_DU_CONDITIONS_SLA_4H`).", { todo: true });
test("32.3-T21: Given `origination.ai_mlo_intake = assisted` and `terms.presentation.requested` at 08:50, then no personal rate renders before `mlo.review.completed{approved}`; the `StatusCard` shows `due_at = 09:50` (20.3 T7).", { todo: true });
test("32.3-T22: Given active E-SIGN scoped to `origination_disclosures`, when the LE is approved, then the `DocumentCard` renders and `disclosure.le.delivered{channel=esign_portal}` is logged; **Confirm receipt** writes `received_at` and `receipt_evidence = esign_confirmed`.", { todo: true });
test("32.3-T23: Given the borrower taps Proceed before the LE's effective receipt date, then `intent_records.valid = false`, the fee gate stays closed, and the assistant explains the order.", { todo: true });
test("32.3-T24: Given no valid intent, then no lock `ComparisonCard` is created; `lock.request` returns the gate error.", { todo: true });
test("32.3-T25: Given `lock.executed` on Monday, then a revised LE `DocumentCard` exists by Thursday (`REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD`) and Numbers show `le_v2`.", { todo: true });
test("32.3-T26: Given a preapproval request with `property = TBD`, then `application.received` fires, `application.trid_received` does not, and `REGB_1002_9_DECISION_30` runs.", { todo: true });
test("32.3-T27: Given a preapproval letter is issued, then it names `partner.legal_name`, `mlo.name`/NMLSR ID, `valid_until`, the general conditions, and contains no occurrence of \"guarantee\".", { todo: true });
test("32.3-T28: Given a preapproved borrower sends a listing at a different price, then the payment estimate uses the approved quote id; if `SM_QUOTE_VALIDITY_GATE` is closed, the new rate renders only after `mlo.review.completed{approved}` (`assisted`).", { todo: true });
test("32.3-T29: Given a contract is uploaded, then extracted fields are written with `source = document_extraction` and `confirmed_at null` until Confirm; `application.trid_received` fires only after the address confirmation.", { todo: true });
test("32.3-T30: Given SMS reply \"yes that's my income\" to a pending income `ConfirmCard`, then the card stays pending and the assistant replies with the deep link (32.1 §6.4).", { todo: true });
