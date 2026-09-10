// 5.3 Reporting liquidations (payoff/foreclosure/short sale)
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-3-reporting-liquidations-payoff-foreclosure-short-sale.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { larDeadlineMs } from "./period.ts";
import { zoned } from "./lar.ts";
import { ET, ssPayoffInterest, postCloseRemovalError, reconcileDra, reogramConfirmation, projectLiquidationEvent, removalConfidenceHold, tpsProceeds } from "./ops.ts";

// 5.3-T1 — implemented in src/domain/investor/investor.test.ts
test("5.3-T2: Given a payoff processed Mon Nov 2, 2026 (BD1), then the AC 60 deadline is Tue Nov 3 17:00 ET and, for an S/S loan, no full-month interest is charged if reported by BD2.", () => {
  const processed = zonedEpochMs(D("2026-11-02"), "15:10", ET);
  assert.equal(toIso(larDeadlineMs(processed, true)), toIso(zonedEpochMs(D("2026-11-03"), "17:00", ET)));
  const onTime = ssPayoffInterest({ scheduled_upb_cents: 24908861n, ptr: "6.000", processed_at_ms: processed, reported_at_ms: zonedEpochMs(D("2026-11-03"), "12:00", ET) });
  assert.equal(onTime.waived, true); assert.equal(onTime.charged_cents, 0n); assert.equal(onTime.full_month_cents, 124544n);
  const late = ssPayoffInterest({ scheduled_upb_cents: 24908861n, ptr: "6.000", processed_at_ms: processed, reported_at_ms: zonedEpochMs(D("2026-11-04"), "09:00", ET) });
  assert.equal(late.waived, false); assert.equal(late.charged_cents, 124544n);
});
// 5.3-T3 — implemented in src/domain/investor/investor.test.ts
// 5.3-T4 — implemented in src/domain/investor/investor.test.ts
// 5.3-T5 — implemented in src/domain/investor/investor.test.ts
test("5.3-T6: Given the AC 60 was accepted in the October period and the wire is reversed Nov 4, 2026 (after Nov 3 BD2 close), then no correction is projected, `fnma_liquidated_in_error` is set, the amount due is computed for remittance and an `officer` escalation and `qc_finding` case open.", () => {
  const r = postCloseRemovalError({ accepted_period: "2026-10", discovered_at_ms: zonedEpochMs(D("2026-11-04"), "10:00", ET), reported_principal_cents: 24908861n, reported_interest_cents: 124544n });
  assert.equal(r.after_close, true); assert.equal(r.correction_projected, false); assert.equal(r.fnma_liquidated_in_error, true);
  assert.equal(r.amount_due_cents, 25033405n); assert.equal(r.escalation, "officer"); assert.equal(r.case, "qc_finding");
  const inside = postCloseRemovalError({ accepted_period: "2026-10", discovered_at_ms: zonedEpochMs(D("2026-11-03"), "16:00", ET), reported_principal_cents: 24908861n, reported_interest_cents: 124544n });
  assert.equal(inside.correction_projected, true); assert.equal(inside.case, null);
});
test("5.3-T7: Given a DRA \"Foreclosure Sale Held\" event from the firm feed dated Oct 14 with no matching `foreclosure.sale.held` in our system by Oct 15, then a sev-1 escalation fires and the REOgram confirmation task is pre-created due Oct 16.", () => {
  const r = reconcileDra({ dra: [{ type: "sale_held", date: D("2026-10-14") }], ours: [], as_of: D("2026-10-15") });
  assert.equal(r.sev1.length, 1); assert.equal(r.sev1[0]!.milestone.date, "2026-10-14"); assert.equal(r.sev1[0]!.reogram_task_due, "2026-10-16");
  assert.equal(reconcileDra({ dra: [{ type: "sale_held", date: D("2026-10-14") }], ours: [{ type: "sale_held", date: D("2026-10-14") }], as_of: D("2026-10-15") }).sev1.length, 0);
});
test("5.3-T8: Given a REOgram notice received Wed Nov 25, 2026 17:30 ET, then the confirmation task is due Mon Nov 30 (next `fannie_et` BD after Fannie Mae holidays Nov 26\u201327), with a warning at 70%.", () => {
  const received = zonedEpochMs(D("2026-11-25"), "17:30", ET);
  const t = reogramConfirmation(received);
  assert.equal(t.due_on, "2026-11-30"); assert.equal(toIso(t.due_ms), toIso(zonedEpochMs(D("2026-11-30"), "17:00", ET))); assert.equal(t.role, "fnma_portal_operator");
  assert.equal(t.warning_at_ms, received + Math.round((t.due_ms - received) * 0.7)); assert.ok(t.warning_at_ms > received && t.warning_at_ms < t.due_ms);
});
test("5.3-T9: Given `removal.liquidation.third_party.mode = event` in CIT, then the P360 liquidation event JSON is produced in `api-clve` and diffed against the production LAR 71.", () => {
  const p = projectLiquidationEvent({ mode: "event", kind: "third_party_sale", insured: "none", principal_cents: 24908861n, interest_cents: 124544n, legal_date: D("2026-10-14"), fnma_loan_number: "1234567890", cit: true });
  assert.equal(p.env, "api-clve"); assert.equal(p.lar.action_code, "71"); assert.equal(p.lar.action_date, "101426");
  assert.equal(p.p360_event!["Liquidation Event Type"], "Third-Party Sale"); assert.equal(p.p360_event!["Principal Amount"], "249088.61");
  assert.deepEqual(p.diff, []);
  assert.equal(projectLiquidationEvent({ mode: "legacy", kind: "third_party_sale", insured: "none", principal_cents: 24908861n, interest_cents: 124544n, legal_date: D("2026-10-14"), fnma_loan_number: "1234567890", cit: false }).p360_event, null);
});
test("5.3-T10: Given the agent's confidence on insured status is 0.7, then the removal is held, a `human_agent` review is requested at deadline \u2212 4h, and the timer still breaches if unresolved (evidence retained).", () => {
  const deadline = zonedEpochMs(D("2026-10-16"), "20:00", ET);
  const h = removalConfidenceHold({ confidence: 0.7, deadline_ms: deadline, candidates: ["70", "72"], evidence: ["mi-cert-1", "sale-deed-1"] });
  assert.equal(h.held, true); assert.equal(h.review!.role, "human_agent"); assert.equal(toIso(h.review!.request_at_ms), toIso(zonedEpochMs(D("2026-10-16"), "16:00", ET)));
  assert.equal(h.breaches_if_unresolved, true); assert.deepEqual(h.evidence_retained, ["mi-cert-1", "sale-deed-1"]);
  assert.equal(removalConfidenceHold({ confidence: 0.95, deadline_ms: deadline, candidates: ["71"], evidence: [] }).held, false);
});

test("5.3 worked example: third-party bid $210,000.00 → CRS 311 by Fri Oct 16 16:00 ET, settles Mon Oct 19, all to Fannie Mae; LAR 96 code 71 with zone-signed interest $1,245.44 and principal $249,088.61", () => {
  const p = tpsProceeds({ bid_cents: 21000000n, received_on: D("2026-10-15"), scheduled_upb_cents: 24908861n, ptr: "6.000", lpi_due: D("2026-03-01"), sale_on: D("2026-10-14"), settlement_on: D("2026-10-19") });
  assert.equal(p.crs_code, "311"); assert.equal(p.amount_cents, 21000000n); assert.equal(toIso(p.instruct_by_ms), toIso(zonedEpochMs(D("2026-10-16"), "16:00", ET))); assert.equal(p.settles_on, "2026-10-19");
  assert.ok(p.indebtedness_cents > 21000000n); assert.equal(p.to_fnma_cents, 21000000n); assert.equal(p.surplus_cents, 0n); assert.equal(p.tps_case, true);
  assert.equal(zoned(124544n), "0000012454D"); assert.equal(zoned(24908861n), "0002490886A");   // IRM zone-sign overpunch on the last digit (5.1-T1 convention)
});
