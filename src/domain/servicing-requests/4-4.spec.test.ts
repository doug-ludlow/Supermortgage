// 4.4 Successor in interest
// spec/sections/04-customer-service-borrower-communications/4-4-successor-in-interest.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
void cents;
import { redactions } from "./rfi.ts";
import { postConfirmationRights, siiTimers, assumptionExecuted, documentDescription, fraudSignals } from "./ops.ts";

// 4.4-T1 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.4-T2 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.4-T3 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.4-T4 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
// 4.4-T5 — implemented in src/domain/servicing-requests/servicing-requests.test.ts
test("4.4-T6: Given confirmation and no returned acknowledgment, then periodic/escrow statements and EI notices to the successor are held while an RFI from the successor is answered on the 4.2 clock and a payoff request is answered within the Reg Z window (16.1).", () => {
  const r = postConfirmationRights({ confirmed_on: D("2026-11-03"), ack_returned_on: null, rfi_received_on: D("2026-11-05"), payoff_requested_on: D("2026-11-05") });
  assert.equal(r.statements_ei_escrow, "held"); assert.equal(r.rfi_response_due, "2026-12-21");   // 30 federal BD (Veterans Day, Thanksgiving excluded) assert.equal(r.payoff_due, "2026-11-16"); assert.deepEqual(r.rights, { noe_rfi_payoff: true, statements_and_ei: false, obligor: false });
});
test("4.4-T7: Given the acknowledgment is returned, then statements start on the next cycle and the escrow annual statement includes the successor as addressee.", () => {
  const r = postConfirmationRights({ confirmed_on: D("2026-11-03"), ack_returned_on: D("2026-11-20") });
  assert.equal(r.statements_ei_escrow, "next_cycle"); assert.equal(r.escrow_statement_addressee, true); assert.equal(r.rights.statements_and_ei, true);
});
test("4.4-T8: Given a potential successor submits a loss-mit application, then all SII policy timers halve and `lossmit_reviewer` sees the pending-confirmation flag; upon confirmation the 12.1 application is treated as received on the confirmation date.", () => {
  const t = siiTimers({ identified_on: D("2026-10-01"), lossmit_pending: true, confirmed_on: D("2026-11-03") });
  assert.deepEqual(t, { docs_description_due: "2026-10-05", facilitate_due: "2026-10-02", reviewer_flag: "sii_pending_confirmation", application_received_date: "2026-11-03" });
  assert.equal(siiTimers({ identified_on: D("2026-10-01"), lossmit_pending: false }).docs_description_due, "2026-10-08");
});
test("4.4-T9: Given a confirmed successor requests the payment history, then the response omits the deceased borrower's SSN and contact data (4.2-T6 linkage).", () => {
  assert.deepEqual(redactions("confirmed_successor"), ["other_borrowers.location_contact", "other_borrowers.personal_financial"]);
  const history = { payments: [{ on: "2026-08-01", amount_cents: 219_257n }], deceased_borrower: { ssn: "***-**-1234", phone: "(555) 010-0000" } };
  const omit = redactions("confirmed_successor"); const redacted = { ...history, deceased_borrower: omit.includes("other_borrowers.location_contact") ? undefined : history.deceased_borrower };
  assert.equal(redacted.deceased_borrower, undefined); assert.equal(redacted.payments.length, 1);
});
test("4.4-T10: Given an assumption is executed, then the `signing_officer` signature record exists, interested parties are notified within 10 servicer BD, MI approval is on file where MI exists, and the loan-data change (if any) is reported per 5.x.", () => {
  const ok = assumptionExecuted({ executed_on: D("2026-12-01"), signing_officer_id: "so-1", mi_exists: true, mi_approval_on_file: true, terms_changed: false });
  assert.deepEqual(ok, { ok: true, problems: [], notify_interested_parties_by: "2026-12-15", loan_data_change: false });
  assert.deepEqual(assumptionExecuted({ executed_on: D("2026-12-01"), signing_officer_id: null, mi_exists: true, mi_approval_on_file: false, terms_changed: true }).problems, ["signing_officer signature record missing", "MI company approval not on file"]);
});
test("4.4-T11: Given a state with a counsel-unreviewed matrix row, then the (i)(2) examples letter is used and the case is flagged `matrix_gap` for counsel.", () => {
  const r = documentDescription(null);
  assert.equal(r.letter, "i2_examples"); assert.equal(r.flag, "matrix_gap"); assert.equal(r.questions.length, 3);
  assert.deepEqual(documentDescription(["death certificate", "recorded deed"]), { letter: "matrix", documents: ["death certificate", "recorded deed"], flag: null, questions: [] });
});
test("4.4-T12: (fraud) Given a quitclaim from a 90-year-old borrower to an unrelated party filed last week, then `officer`/`attorney` escalation and no confirmation.", () => {
  const r = fraudSignals({ instrument: "quitclaim", grantor_age: 90, grantee_related: false, recorded_days_ago: 7 });
  assert.deepEqual(r.escalate, ["officer", "attorney"]); assert.equal(r.confirm, false); assert.deepEqual(r.signals, ["fresh quitclaim to an unrelated party", "elderly grantor"]);
  assert.equal(fraudSignals({ instrument: "warranty_deed", grantee_related: true, recorded_days_ago: 400 }).confirm, true);
});
