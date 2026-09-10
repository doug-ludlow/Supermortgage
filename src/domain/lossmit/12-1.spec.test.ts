// 12.1 Acknowledge loss-mit application
// spec/sections/12-loss-mitigation/12-1-acknowledge-loss-mit-application.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { facialCompletion, rfaFlow, aiOutageFallback, caPerDocumentAcks, nprmRfa, ackBreach } from "./ops.ts";
import { ackDue } from "./application.ts";

// 12.1-T1 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.1-T2 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.1-T3 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.1-T4: (facially complete) all listed items received 2026-10-01 \u2192 `facially_complete_at=2026-10-01`; verification finds a stale paystub \u2192 supplemental request 2026-10-02 with date \u22652026-10-09; `foreclosure_holds{kind=regx_f2_prefiling}` active throughout; borrower complies 2026-10-07 \u2192 `deemed_complete_date=2026-10-01`, `complete_at=2026-10-07`; (c)(3) notice by 2026-10-14.", () => {
  const items = ["form_710", "paystubs", "bank_statement", "hardship_letter"];
  const r = facialCompletion({ required_items: items, received: items.map((item) => ({ item, on: D("2026-10-01") })), verification: { stale_item: "paystubs", found_on: D("2026-10-02") }, borrower_complied_on: D("2026-10-07") });
  assert.equal(r.facially_complete_at, "2026-10-01"); assert.equal(r.supplemental_request!.on, "2026-10-02"); assert.ok(r.supplemental_request!.respond_by >= "2026-10-09");
  assert.deepEqual(r.holds.map((h) => [h.kind, h.active]), [["regx_f2_prefiling", true]]);
  assert.equal(r.deemed_complete_date, "2026-10-01"); assert.equal(r.complete_at, "2026-10-07");
  // 5 federal business days from 2026-10-07 skip Columbus Day (2026-10-12): the (c)(3) notice is due 2026-10-15 (the spec's 10-14 counts the holiday; see docs/AUDIT-NOTES.md).
  assert.equal(r.c3_notice_by, "2026-10-15");
  assert.equal(facialCompletion({ required_items: items, received: items.slice(1).map((item) => ({ item, on: D("2026-10-01") })) }).facially_complete_at, null);
});
// 12.1-T5 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.1-T6 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.1-T7 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.1-T8: (RFA only) call \"what programs do you have?\" with no financial info \u2192 `rfa_only`, no ack timer, CA SPOC assignment (4.3) and solicitation package sent; when the borrower later says \"my income dropped by half,\" application opens with that date.", () => {
  const r = rfaFlow({ utterance: "what programs do you have?", has_evaluative_info: false, confidence: 0.95, state: "CA", later: { utterance: "my income dropped by half", has_evaluative_info: true, on: D("2026-10-20") } });
  assert.equal(r.kind, "rfa_only"); assert.equal(r.ack_timer, null); assert.equal(r.spoc_assignment, true); assert.equal(r.solicitation_package_sent, true); assert.equal(r.application_opened_on, "2026-10-20");
  assert.equal(rfaFlow({ utterance: "what programs do you have?", has_evaluative_info: false, confidence: 0.6, state: "TX" }).kind, "application");
});
test("12.1-T9: (AI outage) document AI unavailable for 3 days \u2192 human checklist task completes the determination on day 4; ack on time; incident logged.", () => {
  const r = aiOutageFallback({ received_on: D("2026-10-01"), outage_started_on: D("2026-10-01"), outage_days: 3 });
  assert.equal(r.human_checklist_task, true); assert.equal(r.determination_on, "2026-10-04"); assert.equal(r.ack_due_on, ackDue(D("2026-10-01")).due_on); assert.equal(r.ack_on_time, true); assert.deepEqual(r.incident, { kind: "ai_outage", days: 3, logged: true });
});
test("12.1-T10: (CA per-document ack) each of three separate uploads on a CA loan receives an acknowledgment within 5 business days.", () => {
  const acks = caPerDocumentAcks("CA", [D("2026-10-01"), D("2026-10-05"), D("2026-10-08")]);
  assert.equal(acks.length, 3); assert.ok(acks.every((a) => a.code === "NTC_CA_2924_10_ACK"));
  assert.deepEqual(acks.map((a) => a.ack_by), ["2026-10-08", "2026-10-13", "2026-10-16"]);
  assert.equal(caPerDocumentAcks("TX", [D("2026-10-01")]).length, 0);
});
test("12.1-T11: (NPRM flag) with `2024nprm`, an oral RFA received 40 days before a sale opens a review cycle and sets a `foreclosure_holds{kind=lm_review_cycle}` hold; with `2013`, it does not.", () => {
  const on = nprmRfa({ regime: "2024nprm", rfa_on: D("2026-10-01"), sale_on: D("2026-11-10"), oral: true });
  assert.equal(on.review_cycle_opened, true); assert.equal(on.hold!.kind, "lm_review_cycle"); assert.equal(on.notice, "NTC_REGX_41_NPRM_RFA_RECEIVED"); assert.equal(on.days_before_sale, 40);
  const off = nprmRfa({ regime: "2013", rfa_on: D("2026-10-01"), sale_on: D("2026-11-10"), oral: true });
  assert.equal(off.review_cycle_opened, false); assert.equal(off.hold, null); assert.equal(off.notice, null);
});
test("12.1-T12: (breach) ack not produced by day 5 (simulated print failure) \u2192 escalation `officer` sev-1 created at 00:05 day 6, ack re-sent, NoE-risk flag set on the loan.", () => {
  const r = ackBreach({ received_on: D("2026-10-01"), produced: false });
  assert.equal(r.breached, true); assert.equal(r.escalation!.kind, "officer"); assert.equal(r.escalation!.severity, "sev1"); assert.equal(r.day6, "2026-10-09");
  assert.equal(r.escalation!.at_ms, zonedEpochMs(D("2026-10-09"), "00:05", "America/New_York")); assert.equal(r.ack_resent, true); assert.equal(r.noe_risk_flag, true);
  assert.equal(ackBreach({ received_on: D("2026-10-01"), produced: true }).breached, false);
});
