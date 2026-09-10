// 7.1 Periodic statement
// spec/sections/07-compliance-notices-disclosures/7-1-periodic-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { amountDue, lateFeeLine } from "./statement.ts";
import { newConsent, verify } from "./esign.ts";
import { tppStatement, bankruptcyStatementPlan, ceaseRequest, chargeOffSuspension, CHARGEOFF_TITLE, reminderDecision, checklistHold, availabilityEmailBounce, form1098Cycle, statementRecipients, transferOutStatements } from "./ops.ts";

// 7.1-T1 — implemented in src/domain/notices/notices.test.ts
// 7.1-T2 — implemented in src/domain/notices/notices.test.ts
// 7.1-T3 — implemented in src/domain/notices/notices.test.ts
test("7.1-T4: Given an active Flex Mod trial with TPP payment $2,100.00, then amount due = $2,100.00 and the explanation shows both $2,100.00 and the contractual $2,946.79; application per contract.", () => {
  const s = tppStatement({ tpp_payment_cents: 210000n, contractual_payment_cents: 294679n, past_due_cents: 294679n, late_charges_cents: 11671n, fees_cents: 0n, suspense_cents: 0n, regx_days: 46 });
  assert.equal(s.template, "NTC_REGZ_41_STMT_TPP"); assert.equal(s.amount_due_cents, 210000n);
  assert.deepEqual(s.explanation, { tpp_payment_cents: 210000n, contractual_payment_cents: 294679n }); assert.equal(s.application_basis, "contract"); assert.equal(s.delinquency_box, true);
});
test("7.1-T5: Given a Chapter 13 case opened Oct 5, then the Nov cycle may use the single-statement exemption and the Dec cycle renders `NTC_REGZ_41_STMT_BK12_13` with post-petition amount due and pre-petition arrearage figures and no late-fee language.", () => {
  const p = bankruptcyStatementPlan({ chapter: "13", petition_on: D("2026-10-05"), docket_reference: "PACER 26-12345", cycles: [{ due_date: D("2026-11-01"), statement_date: D("2026-10-17") }, { due_date: D("2026-12-01"), statement_date: D("2026-11-17") }], post_petition_due_cents: 294679n, prepetition_arrearage_cents: 589358n });
  assert.equal(p.cycles[0]!.treatment, "single_statement_exemption"); assert.equal(p.cycles[0]!.template, null);
  assert.equal(p.cycles[1]!.treatment, "bk_modified"); assert.equal(p.cycles[1]!.template, "NTC_REGZ_41_STMT_BK12_13"); assert.equal(p.cycles[1]!.amount_due_cents, 294679n); assert.equal(p.cycles[1]!.prepetition_arrearage_cents, 589358n);
  assert.equal(p.cycles[1]!.late_fee_language, false); assert.match(p.cycles[1]!.legend!, /informational purposes only/);
  assert.throws(() => bankruptcyStatementPlan({ chapter: "13", petition_on: D("2026-10-05"), docket_reference: null, cycles: [], post_petition_due_cents: 0n, prepetition_arrearage_cents: 0n }), /docket reference/);
});
test("7.1-T6: Given a written cease request received Oct 12 from the debtor's attorney, then `statement.cycle.exempt` is recorded with the image as evidence and no statement is sent for cycles after Oct 12; given a later written request for statements, then statements resume the next cycle.", () => {
  const cycles = [{ due_date: D("2026-10-01"), statement_date: D("2026-09-17") }, { due_date: D("2026-11-01"), statement_date: D("2026-10-17") }, { due_date: D("2026-12-01"), statement_date: D("2026-11-17") }, { due_date: D("2027-01-01"), statement_date: D("2026-12-17") }];
  const c = ceaseRequest({ received_on: D("2026-10-12"), evidence_document_id: "img-cease-1", cycles });
  assert.deepEqual(c.exemption, { event: "statement.cycle.exempt", effective_on: "2026-10-12", evidence_document_id: "img-cease-1" });
  assert.deepEqual(c.cycles.map((x) => x.send), [true, false, false, false]);
  const r = ceaseRequest({ received_on: D("2026-10-12"), evidence_document_id: "img-cease-1", cycles, resume_request_on: D("2026-11-20") });
  assert.deepEqual(r.cycles.map((x) => x.send), [true, false, false, true]);                       // resumes the next cycle after the written request
  assert.throws(() => ceaseRequest({ received_on: D("2026-10-12"), evidence_document_id: null, cycles }), /evidence document/);
});
test("7.1-T7: Given charge-off approved Nov 3, then `NTC_REGZ_41E6_CHARGEOFF_SUSPENSION` is sent by Dec 3 with the exact title and seven items; given a fee assessed Jan 10, then statements resume and the fee is reversed.", () => {
  const n = chargeOffSuspension({ approved_on: D("2026-11-03") });
  assert.equal(n.template, "NTC_REGZ_41E6_CHARGEOFF_SUSPENSION"); assert.equal(n.due_on, "2026-12-03"); assert.equal(n.title, CHARGEOFF_TITLE);
  assert.equal(n.title, "Suspension of Statements & Notice of Charge Off — Retain This Copy for Your Records"); assert.equal(n.items.length, 7); assert.equal(n.exemption_lapsed, false);
  const fee = chargeOffSuspension({ approved_on: D("2026-11-03"), fee_assessed_on: D("2027-01-10"), fee_cents: 2500n });
  assert.equal(fee.exemption_lapsed, true); assert.equal(fee.statements_resume, true); assert.equal(fee.fee_reversed_cents, 2500n);
});
test("7.1-T8: Given the October payment unpaid on Oct 17 and no forbearance, then the Oct 17 statement carries the D2-2-03 panel and `FNMA_D2_2_03_PAYMENT_REMINDER_20` is satisfied; given the statement is held, then a standalone reminder is sent by Oct 20.", () => {
  const sent = reminderDecision({ statement_date: D("2026-10-17"), month_payment_unpaid: true, forbearance_active: false, statement_held: false });
  assert.equal(sent.panel, true); assert.equal(sent.timer, "FNMA_D2_2_03_PAYMENT_REMINDER_20"); assert.equal(sent.satisfied_by, "statement.sent{reminder_panel=true}"); assert.equal(sent.standalone, null);
  const held = reminderDecision({ statement_date: D("2026-10-17"), month_payment_unpaid: true, forbearance_active: false, statement_held: true });
  assert.equal(held.panel, false); assert.deepEqual(held.standalone, { template: "NTC_FNMA_D2_2_03_PAYMENT_REMINDER", by: "2026-10-20" });
  assert.equal(reminderDecision({ statement_date: D("2026-10-17"), month_payment_unpaid: true, forbearance_active: true, statement_held: false }).satisfied_by, null);
});
// 7.1-T9 — implemented in src/domain/notices/notices.test.ts
// 7.1-T10 — implemented in src/domain/notices/notices.test.ts
test("7.1-T11: Given a checklist `block` failure (missing toll-free number), then the statement is held, cannot be sent, and an ops alert fires within 5 minutes.", () => {
  const h = checklistHold({ failures: [{ rule_id: "d6-tollfree", severity: "block" }], detected_at: "2026-10-17T06:00:00.000Z" });
  assert.equal(h.held, true); assert.equal(h.can_send, false); assert.deepEqual(h.blocking, ["d6-tollfree"]); assert.equal(h.ops_alert_by, "2026-10-17T06:05:00.000Z");
  assert.equal(checklistHold({ failures: [{ rule_id: "no-suspense-netting", severity: "warn" }], detected_at: "2026-10-17T06:00:00.000Z" }).can_send, true);
});
test("7.1-T12: Given e-delivery consent active and the availability email hard-bounces, then a paper statement is mailed within 1 business day and the consent is flagged `suspect`.", () => {
  const c = newConsent("A", ["periodic_statements"], "v1.3", D("2026-10-02"), "portal"); if ("error" in c) throw new Error(c.error);
  verify(c, true, true, D("2026-10-02")); assert.equal(c.status, "active");
  const b = availabilityEmailBounce({ consent: c, bounced_on: D("2026-12-03"), kind: "hard" });
  assert.equal(b.mail_paper_by, "2026-12-04"); assert.equal(b.consent_status, "suspect"); assert.equal(b.reverification_invite, true); assert.equal(b.timer, "SM_EMAIL_BOUNCE_SUSPECT_1BD");
});
test("7.1-T13: Given tax year 2026 interest received $23,412.55 and Jan 1 UPB $371,048.86, then the 1098 shows box 1 $23,412.55, box 2 $371,048.86, is furnished by Jan 31, 2027 and e-filed by Mar 31, 2027; given electronic furnishing, then it remains accessible through Oct 15, 2027.", () => {
  const f = form1098Cycle({ tax_year: 2026, interest_received_cents: 2341255n, upb_jan1_cents: 37104886n, electronic: true });
  assert.equal(f.box1_cents, 2341255n); assert.equal(f.box2_cents, 37104886n); assert.equal(f.furnish_by, "2027-01-31"); assert.equal(f.efile_by, "2027-03-31"); assert.equal(f.accessible_through, "2027-10-15"); assert.equal(f.template, "NTC_IRS_1098");
  assert.equal(form1098Cycle({ tax_year: 2026, interest_received_cents: 2341255n, upb_jan1_cents: 37104886n, electronic: false }).accessible_through, null);
});
test("7.1-T14: Given a confirmed successor without an executed acknowledgment, then no statement is addressed to the successor; given the acknowledgment executed, then the successor is added as a recipient on the next cycle.", () => {
  const before = statementRecipients({ borrower_of_record: "Bea Borrower", successor: { name: "Sam Successor", confirmed: true, acknowledgment_executed: false, assumed: false } });
  assert.deepEqual(before.recipients, ["Bea Borrower"]); assert.equal(before.successor_added_from, null);
  const after = statementRecipients({ borrower_of_record: "Bea Borrower", successor: { name: "Sam Successor", confirmed: true, acknowledgment_executed: true, assumed: false } });
  assert.deepEqual(after.recipients, ["Bea Borrower", "Sam Successor"]); assert.equal(after.successor_added_from, "next_cycle");
});
test("7.1-T15: Given transfer-out effective Dec 1, then no statement is generated for the Dec 1 cycle and the Nov statement references the goodbye notice.", () => {
  const t = transferOutStatements({ transfer_effective: D("2026-12-01"), cycles: [{ due_date: D("2026-11-01") }, { due_date: D("2026-12-01") }, { due_date: D("2027-01-01") }] });
  assert.deepEqual(t.cycles, [{ due_date: "2026-11-01", generate: true, goodbye_reference: true }, { due_date: "2026-12-01", generate: false, goodbye_reference: false }, { due_date: "2027-01-01", generate: false, goodbye_reference: false }]);
});

test("7.1 worked example: $400,000 at 5.750% (P&I $2,334.29, escrow $612.50, payment $2,946.79) → Oct statement $6,010.29, Nov statement $9,073.79 with $5,893.58 past due and $233.42 late charges, $6,127.00 to reinstate, $1,446.79 still needed after a $1,500.00 partial", () => {
  assert.equal(233429n + 61250n, 294679n); assert.equal(lateFeeLine(233429n, "5.000", null), 11671n);
  const oct = amountDue({ current_payment_cents: 294679n, past_due_cents: 294679n, late_charges_cents: 11671n, fees_cents: 0n, suspense_cents: 0n });
  assert.equal(oct.amount_due_cents, 601029n);
  const nov = amountDue({ current_payment_cents: 294679n, past_due_cents: 589358n, late_charges_cents: 23342n, fees_cents: 0n, suspense_cents: 150000n });
  assert.equal(nov.amount_due_cents, 907379n); assert.equal(589358n + 23342n, 612700n); assert.equal(nov.shortfall_to_complete_cents, 144679n); assert.equal(nov.suspense_disclosed_cents, 150000n);
});
