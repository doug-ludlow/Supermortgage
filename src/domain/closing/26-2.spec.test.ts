// 26.2 eClosing execution (RON, IPEN, hybrid, wet), eNote signing, eVault custody, MERS eRegistry registration, eRecording, and paper-note handling
// spec/sections/26-closing-execution-documents-eclosing-ron-funding-and-post-cl/26-2-eclosing-execution-ron-ipen-hybrid-wet-enote-signing-evault.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("26.2-T1: Given an eNote tamper-sealed Fri Nov 6, 2026 14:41 MST, when `registration_due_at` is computed, then it is Mon Nov 9, 2026 23:59 ET; registration accepted at 14:46 MST satisfies `MERS_PROC_ENOTE_REGISTER_1BD`; an acceptance at Tue Nov 10 00:30 ET breaches it.", { todo: true });
test("26.2-T2: Given a tamper seal at Wed Nov 25, 2026 16:10 EST (day before Thanksgiving), then `registration_due_at` = Fri Nov 27, 2026 23:59 ET (Thu Nov 26 excluded).", { todo: true });
test("26.2-T3: Given a Texas 50(a)(6) closing, when `decideClosingType` runs, then `closing_type=wet`, `SM_O72_RON_STATE_AUTH_GATE` reports `product_excluded`, and the location must be a lender/attorney/title-company office.", { todo: true });
test("26.2-T4: Given a Georgia property, then RON is refused with reason `state_not_on_fnma_list` unless a counsel confirmation record exists.", { todo: true });
test("26.2-T5: Given a borrower who fails KBA twice within the session in Texas, then the session status is `failed{identity}` and no retake is offered with the same notary for 24 hours; a wet/IPEN reschedule is proposed.", { todo: true });
test("26.2-T6: Given the eVault copy hash \u2260 the platform seal hash, then `SM_O72_ENOTE_LOCATION_GATE` stays closed and no Registration XML is sent.", { todo: true });
test("26.2-T7: Given a warehouse advance requested on an eNote loan before `enote.secured_party.set`, then the advance is refused with reason `secured_party_missing`.", { todo: true });
test("26.2-T8: Given the fixture RON session, when the audit trail has not arrived by the funding request on Thu Nov 12, then `funding.authorize` is refused until `closing.audit_trail.received`.", { todo: true });
test("26.2-T9: Given a deed of trust notarized Fri Nov 6 in a dry state under the record-after-signing default, then `SM_O72_ERECORD_SUBMIT_1BD` is satisfied by a submission on Mon Nov 9 and breached on Tue Nov 10.", { todo: true });
test("26.2-T10: Given an eRecording rejection on Mon Nov 9 10:30 for a missing cover sheet, then a corrected submission accepted by Wed Nov 11 close satisfies `SM_O72_RECORDING_REJECT_CURE_2BD` (Veterans Day is not a creditor business day \u2014 the due date is Thu Nov 12); a paper fallback dispatched instead starts `SM_O72_PAPER_FALLBACK_5BD`.", { todo: true });
test("26.2-T11: Given a wet-signed paper note on Wed Nov 18, then a courier scan by Thu Nov 19 satisfies `SM_O72_PAPER_NOTE_HANDOFF_1BD` and `custody_records.chain` shows settlement_agent \u2192 courier with the tracking reference.", { todo: true });
test("26.2-T12: Given the same session signs the eNote at 23:58 local and the deed of trust at 00:04 the next day, then `consummation_at` and the note date remain the first day and 25.3's period is anchored there; an eNote signed after midnight triggers a re-draw.", { todo: true });
test("26.2-T13: Given an executed set with a handwritten change to the interest rate on a paper note, then `reviewExecution` fails with `instrument_altered`, funding is blocked, and a re-draw is scheduled.", { todo: true });
test("26.2-T14: Given a RON closing delivered to Fannie Mae, then the ULDD carries `remote_notarization_indicator=true` and `enote_indicator=true`, and the audit trail is in the electronic loan file handed to servicing.", { todo: true });
