// 19.4 Fair lending data elements
// spec/sections/19-data-security-recordkeeping/19-4-fair-lending-data-elements.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { rateTest, ccpaDeletionResponse } from "./fairlending.ts";
import {
  boardingFlException, ciRestrictedSchemaCheck, restrictedAccessCheck, fnmaQuery, materialFindingReview, monthlyMonitorRun, type FlRow,
  flIntake, transferorConfirmation, scheduleTransferOutExport, deliverTransferOutExport, completeMonitorRun, reportRow, closeFairServicingReview,
  runBiasSuite, deployGate, scanAgentRunInputs, registerAiSystem, recordAiSystemChange, completeImpactAssessment, assumptionUpdate, privacyRequestResponse,
  scifLanguageOf, BIAS_TEST_KINDS, type MonitorMetric,
} from "./ops-19-4.ts";

const REG = loadOverriddenRegistry();
/** The overridden registry's 19.4 timers over an in-memory event store: they arm and close on the events ops-19-4 appends. */
function harness(nowIso: string): { clock: FixedClock; events: MemoryEventStore; timers: TimerEngine } {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  return { clock, events, timers: new TimerEngine(REG, events, { processes: ["19.4"] }) };
}
const OFFICER: Actor = { kind: "human", id: "u-cco", role: "officer" };
const FIVE = ["ethnicity", "race", "sex", "age_at_application", "preferred_language"] as const;
const FULL = { ethnicity_codes: [2], race_codes: [5], sex_code: 1, dob: D("1980-01-01"), application_date: D("2024-01-15"), scif_language: "English" } as const;
/** The spec's worked example (rule 8): Hispanic-or-Latino 155/250 vs comparison 639/900, adjusted OR 0.71. */
const WORKED: MonitorMetric = { metric: "LM_MOD_APPROVAL_RATE", dimension: "ethnicity:hispanic_or_latino", test: { group_n: 250, group_events: 155, comparison_n: 900, comparison_events: 639, adjusted_or: 0.71 } };
const RUN = { period_start: D("2027-01-01"), period_end: D("2027-03-31"), ai_off: false } as const;

test('19.4-T1: Given a loan with note date 2023-03-01 boarded with URLA ethnicity 1/11, race 5, sex 2, DOB 1988-06-15, application date 2023-02-10 and SCIF "Spanish," then the FL row is `validated` with `age_at_application` = 34 and `preferred_language` = spanish, and `borrowers.preferred_language` = spanish (source scif).', () => {
  const h = harness("2026-10-01T14:00:00.000Z");
  const r = flIntake(h.events, { loan_id: "L-T1", borrower_seq: 1, note_date: D("2023-03-01"), boarded_on: D("2026-10-01"), source: "urla_1003", ethnicity_codes: [1, 11], race_codes: [5], sex_code: 2, dob: D("1988-06-15"), application_date: D("2023-02-10"), scif_language: "Spanish" });
  assert.equal(r.in_scope, true); assert.equal(r.row!.status, "validated"); assert.equal(r.row!.source, "urla_1003");
  assert.equal(r.row!.age_at_application, 34); assert.equal(r.row!.age_basis, "dob");   // 35th birthday 2023-06-15 falls after the 2023-02-10 application
  assert.equal(r.row!.preferred_language, "spanish"); assert.deepEqual(r.row!.ethnicity_codes, [1, 11]); assert.deepEqual(r.row!.race_codes, [5]); assert.equal(r.row!.sex_code, 2);
  assert.deepEqual(r.missing, []); assert.deepEqual(r.unmapped, []); assert.equal(r.exception, null); assert.equal(r.followup_timer, null);
  assert.deepEqual(r.borrower_preferred_language, { value: "spanish", source: "scif" });
  assert.deepEqual(r.events.map((e) => e.type), ["fl.record.received", "borrower.preferred_language.seeded", "fl.record.validated"]);
  assert.equal(r.events[0]!.payload.note_date, "2023-03-01"); assert.equal(r.events[0]!.payload.boarded_at, "2026-10-01");
  assert.deepEqual(r.events[1]!.payload, { loan_id: "L-T1", borrower_seq: 1, preferred_language: "spanish", preferred_language_source: "scif" });
  assert.equal(r.events[2]!.payload.status, "validated"); assert.equal(r.events[2]!.payload.age_at_application, 34);
  // the boarding gate arms on the intake (note_date ≥ 2023-03-01) and its evaluator opens on the validated row
  const gate = h.timers.byCode("FNMA_A2101_FL_DATA_QUERYABLE_AT_BOARDING");
  assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "armed"); assert.equal(gate[0]!.loanId, "L-T1"); assert.equal(gate[0]!.note, "evaluator:19.4.fairLendingRowPresent");
  assert.ok(eventMatches(REG.get("FNMA_A2101_FL_DATA_QUERYABLE_AT_BOARDING")!.triggerPattern!, r.events[0]!));
  assert.deepEqual(r.gate, { timer: "FNMA_A2101_FL_DATA_QUERYABLE_AT_BOARDING", evaluated: true, facts: { fl_row_status: "validated", not_obtained_evidence_id: null } });
  assert.deepEqual(evaluateGate("19.4.fairLendingRowPresent", r.gate!.facts), { open: true });
  assert.equal(evaluateGate("19.4.fairLendingRowPresent", { fl_row_status: "incomplete", not_obtained_evidence_id: null }).open, false);
  // Form 1103 answers: the listed languages, "Other", the decline option, no SCIF
  assert.equal(scifLanguageOf("Tagalog"), "tagalog"); assert.equal(scifLanguageOf("Arabic"), "other"); assert.equal(scifLanguageOf("I do not wish to respond"), "not_provided"); assert.equal(scifLanguageOf(null), "not_obtained");
  assert.throws(() => flIntake(h.events, { loan_id: "", borrower_seq: 1, note_date: D("2023-03-01"), boarded_on: D("2026-10-01"), source: "urla_1003" }), RangeError);
});
test("19.4-T2: Given a loan with note date 2023-02-28, then no FL row exists and the boarding gate is not evaluated.", () => {
  const h = harness("2026-10-01T14:00:00.000Z");
  const r = flIntake(h.events, { loan_id: "L-T2", borrower_seq: 1, note_date: D("2023-02-28"), boarded_on: D("2026-10-01"), source: "urla_1003", ...FULL });
  assert.equal(r.in_scope, false); assert.equal(r.row, null); assert.equal(r.gate, null); assert.deepEqual(r.events, []); assert.equal(r.exception, null); assert.equal(r.followup_timer, null);
  assert.equal(r.borrower_preferred_language, null);
  assert.deepEqual(h.events.all(), []);                                                    // no fl.* event, nothing for the engine to arm
  assert.equal(h.timers.byCode("FNMA_A2101_FL_DATA_QUERYABLE_AT_BOARDING").length, 0); assert.equal(h.timers.all().length, 0);
  assert.equal(boardingFlException({ note_date: D("2023-02-28"), boarded_on: D("2026-10-01"), elements: {} }).row.status, "out_of_scope");
  // the next day is the first in-scope note date
  const next = flIntake(h.events, { loan_id: "L-T2b", borrower_seq: 1, note_date: D("2023-03-01"), boarded_on: D("2026-10-01"), source: "urla_1003", ...FULL });
  assert.equal(next.in_scope, true); assert.equal(next.row!.status, "validated"); assert.equal(h.timers.byCode("FNMA_A2101_FL_DATA_QUERYABLE_AT_BOARDING").length, 1);
});
test("19.4-T3: Given an in-scope loan whose tape lacks all five elements, then boarding completes with an open exception, `SM_BOARD_FL_DATA_FOLLOWUP_30` is due 30 days later, and after transferor confirmation the row is `not_obtained` with evidence.", () => {
  const open = boardingFlException({ note_date: D("2024-05-10"), boarded_on: D("2026-10-01"), elements: {} });
  assert.equal(open.in_scope, true); assert.deepEqual(open.missing, [...FIVE]); assert.equal(open.boarding_completes, true);
  assert.deepEqual(open.exception, { kind: "boarding", code: "FL_DATA_MISSING", open: true }); assert.equal(open.followup_timer, "SM_BOARD_FL_DATA_FOLLOWUP_30"); assert.equal(open.followup_due, "2026-10-31"); assert.equal(open.row.status, "incomplete");
  const confirmed = boardingFlException({ note_date: D("2024-05-10"), boarded_on: D("2026-10-01"), elements: {}, transferor_confirmation: { on: D("2026-10-20"), evidence_document_id: "doc-transferor-1" } });
  assert.deepEqual(confirmed.row, { status: "not_obtained", source: "not_obtained", evidence_document_id: "doc-transferor-1" }); assert.equal(confirmed.exception!.open, false);
  assert.equal(boardingFlException({ note_date: D("2022-12-01"), boarded_on: D("2026-10-01"), elements: {} }).row.status, "out_of_scope");
  // through the enclave intake and the timer engine: followup_needed arms the 30-day clock, the confirmation closes it
  const h = harness("2026-10-01T14:00:00.000Z");
  const r = flIntake(h.events, { loan_id: "L-T3", borrower_seq: 1, note_date: D("2024-05-10"), boarded_on: D("2026-10-01"), source: "transferor_tape" });
  assert.equal(r.row!.status, "incomplete"); assert.deepEqual(r.missing, [...FIVE]); assert.equal(r.boarding_completes, true); assert.deepEqual(r.exception, { kind: "boarding", code: "FL_DATA_MISSING", open: true });
  assert.equal(r.followup_timer, "SM_BOARD_FL_DATA_FOLLOWUP_30"); assert.equal(r.followup_due, "2026-10-31"); assert.equal(r.row!.preferred_language, "not_obtained");
  assert.deepEqual(r.events.map((e) => e.type), ["fl.record.received", "fl.record.followup_needed"]); assert.equal(r.events[1]!.payload.boarded_at, "2026-10-01");
  const fu = h.timers.byCode("SM_BOARD_FL_DATA_FOLLOWUP_30"); assert.equal(fu.length, 1); assert.equal(fu[0]!.anchorDate, "2026-10-01"); assert.equal(fu[0]!.dueDate, "2026-10-31"); assert.equal(fu[0]!.status, "armed");
  assert.equal(evaluateGate("19.4.fairLendingRowPresent", r.gate!.facts).open, false);       // the boarding gate stays closed while the row is incomplete
  h.clock.set("2026-10-20T14:00:00.000Z");
  const c = transferorConfirmation(h.events, { loan_id: "L-T3", borrower_seq: 1, note_date: D("2024-05-10"), boarded_on: D("2026-10-01"), confirmed_on: D("2026-10-20"), evidence_document_id: "doc-transferor-1", missing: r.missing, transferor_id: "SVC-A" });
  assert.deepEqual(c.row, { status: "not_obtained", source: "not_obtained", evidence_document_id: "doc-transferor-1", version: 1 }); assert.equal(c.exception.open, false); assert.equal(c.late, false); assert.equal(c.f111_gap_logged, true);
  assert.deepEqual(c.events.map((e) => e.type), ["fl.record.not_obtained", "fl.record.validated", "transferor.f111_gap.logged"]); assert.equal(c.events[1]!.payload.status, "not_obtained");
  assert.equal(fu[0]!.status, "satisfied"); assert.equal(fu[0]!.satisfiedByEventId, c.events[1]!.id);
  assert.deepEqual(evaluateGate("19.4.fairLendingRowPresent", c.gate_facts), { open: true });
  assert.throws(() => transferorConfirmation(h.events, { loan_id: "L-T3", borrower_seq: 1, note_date: D("2024-05-10"), boarded_on: D("2026-10-01"), confirmed_on: D("2026-10-20"), evidence_document_id: "", missing: r.missing }), RangeError);
  // no confirmation by day 30 → sev-2 to the transfer agent
  const h2 = harness("2026-10-01T14:00:00.000Z");
  flIntake(h2.events, { loan_id: "L-T3b", borrower_seq: 1, note_date: D("2024-05-10"), boarded_on: D("2026-10-01"), source: "transferor_tape", ethnicity_codes: [99] });   // an unknown enumeration maps to not_obtained with a follow-up (rule 4)
  const b = h2.timers.evaluate("2026-11-01T12:00:00.000Z"); assert.equal(b.length, 1); assert.equal(b[0]!.instance.code, "SM_BOARD_FL_DATA_FOLLOWUP_30"); assert.equal(b[0]!.severity, 2); assert.deepEqual([...b[0]!.escalateTo], ["transfer"]);
});
test("19.4-T4: Given any agent tool, API route or job outside `packages/fl-enclave` references `restricted_fl`, then the CI check fails the build.", () => {
  const bad = ciRestrictedSchemaCheck([{ path: "packages/fl-enclave/monitor.ts", content: "select * from restricted_fl.fair_lending_data" }, { path: "src/app/tools/section12.ts", content: "const q = 'restricted_fl.fair_lending_data';" }, { path: "jobs/nightly.ts", content: "-- restricted_fl" }]);
  assert.equal(bad.passed, false); assert.deepEqual(bad.violations, [{ path: "src/app/tools/section12.ts", line: 1 }, { path: "jobs/nightly.ts", line: 1 }]);
  assert.equal(ciRestrictedSchemaCheck([{ path: "packages/fl-enclave/monitor.ts", content: "restricted_fl" }, { path: "src/domain/lossmit/ops.ts", content: "no schema here" }]).passed, true);
});
test("19.4-T5: Given a SELECT on `restricted_fl.fair_lending_data` by a principal other than `fl_analytics`, then it is denied and a SIEM alert fires within 5 minutes.", () => {
  const at = zonedEpochMs(D("2026-10-05"), "09:00", "America/New_York");
  const denied = restrictedAccessCheck({ principal: "svc-lossmit", role: "app_rw", schema: "restricted_fl", table: "fair_lending_data", statement: "SELECT", at_ms: at });
  assert.equal(denied.allowed, false); assert.match(denied.denial!, /only fl_analytics/); assert.deepEqual(denied.siem_alert, { severity: "sev1", rule: "FL_UNEXPECTED_PRINCIPAL", fire_by_ms: at + 300_000 }); assert.equal(denied.audit_log.object, "restricted_fl.fair_lending_data");
  assert.equal(restrictedAccessCheck({ principal: "analyst-1", role: "fl_analytics", schema: "restricted_fl", table: "fair_lending_data", statement: "SELECT", at_ms: at }).allowed, true);
  assert.equal(restrictedAccessCheck({ principal: "analyst-1", role: "fl_analytics", schema: "restricted_fl", table: "fair_lending_data", statement: "UPDATE", at_ms: at }).allowed, false);
});
test("19.4-T6: Given a Fannie Mae query for loans with note dates 2024-01-01..2024-12-31 in TX, then the approved query returns per-loan elements within one business day, logged with `purpose_code = fnma_query` and a `records_requests` id.", () => {
  const rows: FlRow[] = [
    { loan_id: "L-1", borrower_seq: 1, note_date: D("2024-03-15"), state: "TX", elements: { ethnicity: [2], race: [5], sex: "female", age_at_application: 41, preferred_language: "english" }, status: "validated" },
    { loan_id: "L-2", borrower_seq: 1, note_date: D("2024-11-02"), state: "TX", elements: {}, status: "not_obtained" },
    { loan_id: "L-3", borrower_seq: 1, note_date: D("2025-01-10"), state: "TX", elements: { ethnicity: [1], race: [5], sex: "male", age_at_application: 30, preferred_language: "spanish" }, status: "validated" },
    { loan_id: "L-4", borrower_seq: 1, note_date: D("2024-06-01"), state: "CA", elements: { ethnicity: [2], race: [3], sex: "male", age_at_application: 52, preferred_language: "english" }, status: "validated" },
  ];
  const q = fnmaQuery({ request_id: "rr-2026-0142", approved_by: "compliance-officer", note_date_from: D("2024-01-01"), note_date_to: D("2024-12-31"), state: "TX", received_on: D("2026-10-09"), rows });
  assert.equal(q.allowed, true); assert.equal(q.due_by, "2026-10-13");   // one servicer business day: Fri Oct 9 → Tue Oct 13 (Columbus Day 10-12)
  assert.deepEqual(q.results.map((r) => [r.loan_id, r.elements === "not_obtained" ? "not_obtained" : "elements"]), [["L-1", "elements"], ["L-2", "not_obtained"]]);
  assert.deepEqual(q.access_log, { purpose_code: "fnma_query", records_request_id: "rr-2026-0142", approved_by: "compliance-officer", row_count: 2 });
  assert.equal(fnmaQuery({ request_id: "rr-x", approved_by: null, note_date_from: D("2024-01-01"), note_date_to: D("2024-12-31"), state: "TX", received_on: D("2026-10-09"), rows }).allowed, false);
});
test("19.4-T7: Given a transfer-out scheduled 2027-04-01, then the FL export is delivered by 2027-03-25 (target) and `FNMA_F111_FL_DATA_TRANSFER_OUT_T0` breaches if no acknowledgement exists by 2027-04-01.", () => {
  const rows: FlRow[] = [
    { loan_id: "L-1", borrower_seq: 1, note_date: D("2024-03-15"), state: "TX", elements: { ethnicity: [2], race: [5], sex: "2", age_at_application: 41, preferred_language: "english" }, status: "validated" },
    { loan_id: "L-2", borrower_seq: 1, note_date: D("2024-11-02"), state: "TX", elements: {}, status: "not_obtained" },
    { loan_id: "L-0", borrower_seq: 1, note_date: D("2022-01-10"), state: "TX", elements: {}, status: "out_of_scope" },
  ];
  const h = harness("2027-03-01T14:00:00.000Z");
  const s = scheduleTransferOutExport(h.events, { transfer_id: "TX-2027-04", transfer_date: D("2027-04-01"), loan_ids: ["L-1", "L-2", "L-0"], transferee_id: "SVC-B" });
  assert.equal(s.target_delivery_date, "2027-03-25");   // Thu 2027-04-01 − 5 servicer business days = Thu 2027-03-25 (no holidays in the window)
  assert.equal(s.breach_if_no_ack_by, "2027-04-01"); assert.equal(s.timer, "FNMA_F111_FL_DATA_TRANSFER_OUT_T0"); assert.equal(s.loan_count, 3);
  const def = REG.get("FNMA_F111_FL_DATA_TRANSFER_OUT_T0")!; assert.ok(eventMatches(def.triggerPattern!, s.event));
  const t = h.timers.byCode("FNMA_F111_FL_DATA_TRANSFER_OUT_T0"); assert.equal(t.length, 1); assert.equal(t[0]!.anchorDate, "2027-04-01"); assert.equal(t[0]!.dueDate, "2027-04-01"); assert.deepEqual(t[0]!.subject, { kind: "transfer_batch", id: "TX-2027-04" });
  // the file goes out on target — but without the transferee's manifest ack nothing satisfies the clock
  h.clock.set("2027-03-25T14:00:00.000Z");
  const d = deliverTransferOutExport(h.events, { transfer_id: "TX-2027-04", transfer_date: D("2027-04-01"), delivered_on: D("2027-03-25"), rows, manifest_hash: "sha256:9f1c", transferee_ack: null });
  assert.equal(d.on_target, true); assert.equal(d.delivered, false); assert.deepEqual(d.events.map((e) => e.type), ["fl.export.produced"]);
  assert.deepEqual(d.file.map((f) => [f.loan_id, f.elements === "not_obtained" ? "not_obtained" : "elements", f.evidence_basis !== null]), [["L-1", "elements", false], ["L-2", "not_obtained", true]]);   // out-of-scope L-0 has no row
  assert.deepEqual(d.access_log, { purpose_code: "transfer_out_export", request_id: "TX-2027-04", row_count: 2 });
  assert.equal(t[0]!.status, "armed"); assert.deepEqual(h.timers.evaluate("2027-04-01T12:00:00.000Z"), []);
  const b = h.timers.evaluate("2027-04-02T12:00:00.000Z"); assert.equal(b.length, 1); assert.equal(b[0]!.instance.code, "FNMA_F111_FL_DATA_TRANSFER_OUT_T0"); assert.equal(b[0]!.severity, 1); assert.deepEqual([...b[0]!.escalateTo], ["transfer", "officer"]);
  const late = deliverTransferOutExport(h.events, { transfer_id: "TX-2027-04", transfer_date: D("2027-04-01"), delivered_on: D("2027-03-25"), rows, manifest_hash: "sha256:9f1c", transferee_ack: { acked_on: D("2027-04-02"), by: "SVC-B" } });
  assert.equal(late.delivered, true); assert.ok(eventMatches(def.satisfiedPattern!, late.events[1]!)); assert.equal(t[0]!.status, "satisfied_late");
  // acknowledged manifest by T−0 → satisfied in time
  const h2 = harness("2027-03-01T14:00:00.000Z");
  scheduleTransferOutExport(h2.events, { transfer_id: "TX-2027-04", transfer_date: D("2027-04-01"), loan_ids: ["L-1", "L-2"] });
  h2.clock.set("2027-03-26T14:00:00.000Z");
  deliverTransferOutExport(h2.events, { transfer_id: "TX-2027-04", transfer_date: D("2027-04-01"), delivered_on: D("2027-03-25"), rows, manifest_hash: "sha256:9f1c", transferee_ack: { acked_on: D("2027-03-26"), by: "SVC-B" } });
  assert.equal(h2.timers.byCode("FNMA_F111_FL_DATA_TRANSFER_OUT_T0")[0]!.status, "satisfied"); assert.deepEqual(h2.timers.evaluate("2027-04-02T12:00:00.000Z"), []);
  assert.throws(() => scheduleTransferOutExport(h.events, { transfer_id: "TX-x", transfer_date: D("2027-04-01"), loan_ids: [] }), RangeError);
  assert.throws(() => deliverTransferOutExport(h.events, { transfer_id: "TX-x", transfer_date: D("2027-04-01"), delivered_on: D("2027-03-25"), rows: [], manifest_hash: "h", transferee_ack: null }), RangeError);
});
test("19.4-T8: Given the worked-example inputs (155/250 vs 639/900), then AIR = 0.873, z = −2.72, p ≈ 0.0065, flag `significant`, and with adjusted OR 0.71 and a 9-pp gap the flag is `material` with a review due in 30 days.", () => {
  const raw = rateTest({ group_n: 250, group_events: 155, comparison_n: 900, comparison_events: 639 });
  assert.equal(raw.group_rate.toFixed(3), "0.620"); assert.equal(raw.comparison_rate.toFixed(3), "0.710");
  assert.equal(raw.air, 0.873); assert.equal(raw.screen, false);                                     // 0.620/0.710 passes the four-fifths screen
  assert.equal(raw.z, -2.72); assert.ok(Math.abs(raw.p - 0.0065) < 0.0005); assert.equal(raw.significant, true); assert.equal(raw.suppressed, false);
  // the spec's arithmetic: pooled p = 794/1,150 = 0.6904; SE = √(0.6904 × 0.3096 × (1/250 + 1/900)) = 0.03305; z = −0.090/0.03305
  assert.equal((794 / 1150).toFixed(4), "0.6904");
  const se = Math.sqrt(0.6904 * 0.3096 * (1 / 250 + 1 / 900)); assert.equal(se.toFixed(5), "0.03305"); assert.equal(((0.620 - 0.710) / se).toFixed(2), "-2.72");
  const adj = rateTest({ group_n: 250, group_events: 155, comparison_n: 900, comparison_events: 639, adjusted_or: 0.71 });
  assert.equal(Math.round((adj.comparison_rate - adj.group_rate) * 100), 9);                         // raw gap 9 pp ≥ 5
  assert.equal(adj.material, true); assert.equal(adj.review_due_days, 30);
  // the run records the material result and opens the 30-day review clock (SM_FAIR_SERVICING_REVIEW_30D)
  const h = harness("2027-04-10T14:00:00.000Z");
  const run = completeMonitorRun(h.events, { ...RUN, period: "2027-Q1", run_on: D("2027-04-10"), kind: "regression", controls: ["delinquency_depth", "mtmltv", "state", "ai_vs_human_path"], metrics: [WORKED] });
  assert.deepEqual(run.material, ["LM_MOD_APPROVAL_RATE:ethnicity:hispanic_or_latino"]); assert.equal(run.report_rows[0]!.flag, "material"); assert.equal(run.report_rows[0]!.air, 0.873); assert.equal(run.report_rows[0]!.z, -2.72);
  assert.equal(run.flagged.length, 1); assert.equal(run.flagged[0]!.type, "fair_servicing_result.flagged"); assert.equal(run.flagged[0]!.payload.material, true); assert.equal(run.flagged[0]!.payload.flagged_at, "2027-04-10"); assert.equal(run.flagged[0]!.payload.review_due, "2027-05-10");
  assert.ok(eventMatches(REG.get("SM_FAIR_SERVICING_REVIEW_30D")!.triggerPattern!, run.flagged[0]!));
  const rv = h.timers.byCode("SM_FAIR_SERVICING_REVIEW_30D"); assert.equal(rv.length, 1); assert.equal(rv[0]!.anchorDate, "2027-04-10"); assert.equal(rv[0]!.dueDate, "2027-05-10"); assert.equal(rv[0]!.status, "armed");
  // a significant-but-not-material result (adjusted OR inside 0.80–1.25) opens no review
  const sig = completeMonitorRun(h.events, { ...RUN, period: "2027-Q1b", run_on: D("2027-04-10"), kind: "monthly", metrics: [{ ...WORKED, test: { ...WORKED.test, adjusted_or: 0.95 } }] });
  assert.equal(sig.report_rows[0]!.flag, "significant"); assert.equal(sig.flagged.length, 0); assert.equal(h.timers.byCode("SM_FAIR_SERVICING_REVIEW_30D").length, 1);
});
test("19.4-T9: Given a group with n = 8, then the result is `suppressed` and no rate is displayed.", () => {
  const small: MonitorMetric = { metric: "FEE_LATE_CHARGE_RATE", dimension: "race:native_hawaiian_or_other_pacific_islander", test: { group_n: 8, group_events: 3, comparison_n: 900, comparison_events: 639 } };
  const r = rateTest(small.test); assert.equal(r.suppressed, true); assert.equal(r.material, false); assert.equal(r.significant, false);
  const row = reportRow(small, r);
  assert.deepEqual(row, { metric: "FEE_LATE_CHARGE_RATE", dimension: "race:native_hawaiian_or_other_pacific_islander", flag: "suppressed", n_group: 8, n_comparison: 900, rate_group: null, rate_comparison: null, air: null, z: null, p: null });
  // in a run: reported as suppressed, no flag event, no review clock
  const h = harness("2026-10-10T14:00:00.000Z");
  const run = completeMonitorRun(h.events, { ...RUN, period: "2026-09", run_on: D("2026-10-10"), kind: "monthly", metrics: [small] });
  assert.equal(run.report_rows[0]!.flag, "suppressed"); assert.equal(run.report_rows[0]!.rate_group, null); assert.deepEqual(run.material, []); assert.equal(run.flagged.length, 0);
  assert.equal(h.timers.byCode("SM_FAIR_SERVICING_REVIEW_30D").length, 0);
  // n ≥ 10 displays its rate (n < 30 is pooled before testing, rule 7)
  const pooled: MonitorMetric = { ...small, test: { ...small.test, group_n: 25, group_events: 10 } };
  const pr = reportRow(pooled, rateTest(pooled.test)); assert.equal(pr.flag, "none"); assert.equal(pr.rate_group, 0.4); assert.equal(rateTest(pooled.test).pooled, true);
});
test("19.4-T10: Given a `lossmit-underwriter` prompt-version change, then deploy is blocked until all four bias tests pass; given a counterfactual flip rate of 1.4%, then the gate stays closed.", () => {
  const h = harness("2026-10-05T14:00:00.000Z");
  registerAiSystem(h.events, { system_id: "lossmit-underwriter", name: "Loss-mit underwriter", tier: "T1_consequential", registered_on: D("2026-06-01"), decision_domain: "workout eligibility" });
  const ch = recordAiSystemChange(h.events, { system_id: "lossmit-underwriter", tier: "T1_consequential", change_kind: "prompt_version", substantial: false, changed_on: D("2026-10-05"), prompt_version: "p-2026.10" });
  assert.equal(ch.deploy_gate, "SM_AI_BIAS_TEST_PRE_DEPLOY"); assert.equal(ch.impact_assessment_due, null); assert.equal(ch.event.payload.risk_tier, "high_consequential");
  assert.ok(eventMatches(REG.get("SM_AI_BIAS_TEST_PRE_DEPLOY")!.triggerPattern!, ch.event));
  const gate = h.timers.byCode("SM_AI_BIAS_TEST_PRE_DEPLOY"); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "armed"); assert.equal(gate[0]!.note, "evaluator:19.4.allFourBiasTestsPass"); assert.equal(gate[0]!.dueAt, undefined);
  assert.equal(deployGate(h.events, "lossmit-underwriter").open, false);
  const base = { ai_system_id: "lossmit-underwriter", model_version: "m-3", prompt_version: "p-2026.10", scope: "pre_deploy" as const, ran_on: D("2026-10-05"), dataset_id: "cf-set-v4", dataset_cases: 500 };
  const flip = runBiasSuite(h.events, { ...base, tests: { leakage_clean: true, counterfactual_flip_rate: 0.014, directional_shift: false, outcome_parity_ok: true, explanation_consistent: true } });
  assert.equal(flip.pass, false); assert.deepEqual(flip.failures, ["counterfactual_perturbation"]); assert.deepEqual(flip.deploy, { gate: "SM_AI_BIAS_TEST_PRE_DEPLOY", blocked: true });
  assert.deepEqual(flip.events.map((e) => e.type), ["ai.bias_tests.completed", "ai_system.deploy_blocked"]); assert.deepEqual(flip.events[1]!.payload.escalate_to, ["engineering_owner", "officer"]);
  assert.match(deployGate(h.events, "lossmit-underwriter").reason!, /counterfactual_perturbation/);
  const three = runBiasSuite(h.events, { ...base, tests: { leakage_clean: false, counterfactual_flip_rate: 0.004, directional_shift: false, outcome_parity_ok: true, explanation_consistent: true } });
  assert.deepEqual(three.failures, ["attribute_leakage"]); assert.deepEqual(three.passed_tests, ["counterfactual_perturbation", "outcome_parity", "explanation_consistency"]); assert.equal(deployGate(h.events, "lossmit-underwriter").open, false);
  const pass = runBiasSuite(h.events, { ...base, tests: { leakage_clean: true, counterfactual_flip_rate: 0.004, directional_shift: false, outcome_parity_ok: true, explanation_consistent: true } });
  assert.equal(pass.pass, true); assert.deepEqual(pass.passed_tests, [...BIAS_TEST_KINDS]); assert.deepEqual(pass.deploy, { gate: "SM_AI_BIAS_TEST_PRE_DEPLOY", blocked: false }); assert.equal(pass.events.length, 1);
  assert.deepEqual(deployGate(h.events, "lossmit-underwriter"), { open: true, reason: null, gate: "SM_AI_BIAS_TEST_PRE_DEPLOY" });
  // the next prompt-version change closes the gate again until its own suite passes
  recordAiSystemChange(h.events, { system_id: "lossmit-underwriter", tier: "T1_consequential", change_kind: "prompt_version", substantial: false, changed_on: D("2026-10-05"), prompt_version: "p-2026.11" });
  assert.equal(deployGate(h.events, "lossmit-underwriter").open, false); assert.equal(h.timers.byCode("SM_AI_BIAS_TEST_PRE_DEPLOY").length, 2);
  assert.throws(() => runBiasSuite(h.events, { ...base, dataset_cases: 499, tests: { leakage_clean: true, counterfactual_flip_rate: 0, directional_shift: false, outcome_parity_ok: true, explanation_consistent: true } }), RangeError);
});
test("19.4-T11: Given an `agent_runs.inputs` payload containing `race_codes`, then the leakage test fails, the run is quarantined and a sev-1 review opens.", () => {
  const h = harness("2026-10-06T14:00:00.000Z");
  const r = scanAgentRunInputs(h.events, { run_id: "run-77", ai_system_id: "lossmit-underwriter", inputs: { loan_token: "tok-1", state: "TX", mtmltv: 0.92, race_codes: [5] }, at: D("2026-10-06") });
  assert.deepEqual(r.leakage, { clean: false, fields: ["race_codes"], action: "quarantine_sev1" }); assert.equal(r.quarantined, true);
  assert.deepEqual(r.review, { severity: "sev1", kind: "attribute_leakage", opened: true, escalate_to: ["officer"] });
  assert.deepEqual(r.events.map((e) => e.type), ["ai.bias_test.attribute_leakage", "agent_run.quarantined", "fair_servicing_review.opened"]);
  assert.equal(r.events[0]!.payload.pass, false); assert.deepEqual(r.events[1]!.payload.fields, ["race_codes"]); assert.equal(r.events[2]!.payload.severity, "sev1"); assert.deepEqual(r.events[2]!.payload.escalate_to, ["officer"]);
  const clean = scanAgentRunInputs(h.events, { run_id: "run-78", ai_system_id: "lossmit-underwriter", inputs: { loan_token: "tok-1", state: "TX", mtmltv: 0.92 }, at: D("2026-10-06") });
  assert.equal(clean.quarantined, false); assert.equal(clean.review, null); assert.deepEqual(clean.events.map((e) => e.type), ["ai.bias_test.attribute_leakage"]); assert.equal(clean.events[0]!.payload.pass, true);
  assert.throws(() => scanAgentRunInputs(h.events, { run_id: "", ai_system_id: "x", inputs: {}, at: D("2026-10-06") }), RangeError);
});
test("19.4-T12: Given an assumption completed 2027-05-01 with lawful §1002.13 monitoring data for the new borrower, then a new FL version with `updated_reason = assumption` is written; without such data, the record is unchanged and annotated.", () => {
  const h = harness("2027-05-01T14:00:00.000Z");
  const withData = assumptionUpdate(h.events, { loan_id: "L-T12", completed_on: D("2027-05-01"), assuming_borrower_seq: 2, current_version: 1, monitoring_data: { lawfully_collected_1002_13: true, elements: { ethnicity: [2], race: [3], sex: "1", age_at_application: 45, preferred_language: "english" } } });
  assert.deepEqual([withData.outcome, withData.version, withData.updated_reason], ["new_version_assumption", 2, "assumption"]);
  assert.equal(withData.event.type, "fl.record.version_written"); assert.equal(withData.event.payload.updated_reason, "assumption"); assert.equal(withData.event.payload.version, 2); assert.equal(withData.event.payload.collected_at, "2027-05-01"); assert.equal(withData.event.payload.borrower_seq, 2);
  const without = assumptionUpdate(h.events, { loan_id: "L-T12b", completed_on: D("2027-05-01"), assuming_borrower_seq: 2, current_version: 1, monitoring_data: null });
  assert.deepEqual([without.outcome, without.version, without.updated_reason], ["unchanged_annotated", 1, null]);
  assert.equal(without.event.type, "fl.record.annotated"); assert.equal(without.event.payload.solicited, false); assert.match(String(without.event.payload.annotation), /2027-05-01 .*origination record unchanged/);
  // information that was not collected under §1002.13 (e.g. observed by an agent) never becomes a version either
  const observed = assumptionUpdate(h.events, { loan_id: "L-T12c", completed_on: D("2027-05-01"), assuming_borrower_seq: 2, current_version: 3, monitoring_data: { lawfully_collected_1002_13: false, elements: { ethnicity: [1] } } });
  assert.equal(observed.outcome, "unchanged_annotated"); assert.equal(observed.version, 3);
  assert.equal(h.events.ofType("fl.record.version_written").length, 1); assert.equal(h.events.ofType("fl.record.annotated").length, 2);
});
test("19.4-T13: Given a CCPA deletion request from a borrower, then the response cites the GLBA exemption and no FL or loan record is deleted.", () => {
  const h = harness("2026-10-07T14:00:00.000Z");
  flIntake(h.events, { loan_id: "L-T13", borrower_seq: 1, note_date: D("2024-02-01"), boarded_on: D("2026-10-01"), source: "urla_1003", ...FULL });
  const before = h.events.all().length;
  const r = privacyRequestResponse(h.events, { request_id: "ccpa-2026-17", loan_id: "L-T13", kind: "deletion", received_on: D("2026-10-07"), state: "CA" });
  assert.equal(r.deleted, false); assert.equal(r.basis, "GLBA_exemption"); assert.match(r.citation, /1798\.145\(e\)/); assert.match(r.respond_under, /Reg P \/ GLBA/);
  assert.deepEqual(r.records_retained, ["restricted_fl.fair_lending_data", "loan record"]);
  assert.equal(r.event.type, "privacy.request.responded"); assert.equal(r.event.payload.deleted, false); assert.equal(r.event.payload.request_id, "ccpa-2026-17");
  assert.equal(h.events.all().length, before + 1);                                                       // the response is the only thing written
  assert.deepEqual(h.events.all().filter((e) => /delet|purg|dispos|erase/.test(e.type)), []); assert.equal(h.events.ofType("fl.record.validated").length, 1);
  assert.deepEqual(ccpaDeletionResponse(), { deleted: false, basis: "GLBA_exemption" });
  assert.throws(() => privacyRequestResponse(h.events, { request_id: "", loan_id: "L-T13", kind: "access", received_on: D("2026-10-07"), state: "CA" }), RangeError);
});
test("19.4-T14: Given a `material` finding not reviewed within 30 days, then a sev-1 `officer` escalation exists and the finding appears in the board report.", () => {
  const r = materialFindingReview({ finding_id: "F-2026Q3-mod-approval", flagged_on: D("2026-10-10"), reviewed_on: null, today: D("2026-11-12") });
  assert.equal(r.due, "2026-11-09"); assert.equal(r.breached, true); assert.equal(r.escalation!.kind, "officer"); assert.equal(r.escalation!.severity, "sev1"); assert.deepEqual(r.board_report_entry, { finding_id: "F-2026Q3-mod-approval", status: "review_overdue" });
  assert.equal(materialFindingReview({ finding_id: "F", flagged_on: D("2026-10-10"), reviewed_on: D("2026-11-05"), today: D("2026-11-12") }).breached, false);
  // through the engine: the material flag arms SM_FAIR_SERVICING_REVIEW_30D (due 2026-11-09); unreviewed, it breaches sev-1 → officer
  const h = harness("2026-10-10T14:00:00.000Z");
  const run = completeMonitorRun(h.events, { ...RUN, period: "2026-09", run_on: D("2026-10-10"), kind: "monthly", metrics: [WORKED] });
  const rv = h.timers.byCode("SM_FAIR_SERVICING_REVIEW_30D"); assert.equal(rv.length, 1); assert.equal(rv[0]!.dueDate, "2026-11-09");
  assert.deepEqual(h.timers.evaluate("2026-11-09T12:00:00.000Z"), []);
  const b = h.timers.evaluate("2026-11-12T12:00:00.000Z"); assert.equal(b.length, 1); assert.equal(b[0]!.instance.code, "SM_FAIR_SERVICING_REVIEW_30D"); assert.equal(b[0]!.severity, 1); assert.deepEqual([...b[0]!.escalateTo], ["officer"]);
  assert.equal(h.events.ofType("timer.breached")[0]!.payload.code, "SM_FAIR_SERVICING_REVIEW_30D");
  const resultId = run.flagged[0]!.payload.result_id as string;
  assert.deepEqual(materialFindingReview({ finding_id: resultId, flagged_on: D("2026-10-10"), reviewed_on: null, today: D("2026-11-12") }).board_report_entry, { finding_id: resultId, status: "review_overdue" });
  // only the officer closes it, and only with corrective action or a documented legitimate justification (rule 10)
  assert.throws(() => closeFairServicingReview(h.events, { run_id: run.run_id, result_id: resultId, reviewer: { kind: "human", id: "u-analyst", role: "ops_analyst" }, closed_on: D("2026-11-12"), root_cause: "x", corrective_actions: ["y"] }), RangeError);
  assert.throws(() => closeFairServicingReview(h.events, { run_id: run.run_id, result_id: resultId, reviewer: OFFICER, closed_on: D("2026-11-12"), root_cause: "x", corrective_actions: [], legitimate_justification: null }), RangeError);
  const closed = closeFairServicingReview(h.events, { run_id: run.run_id, result_id: resultId, reviewer: OFFICER, closed_on: D("2026-11-12"), root_cause: "lower document-completion rates for Spanish-preferred borrowers", corrective_actions: ["in-language document checklists", "interpreter follow-up (Section 4)", "re-measure next quarter"] });
  assert.equal(closed.outcome, "corrective_action"); assert.ok(eventMatches(REG.get("SM_FAIR_SERVICING_REVIEW_30D")!.satisfiedPattern!, closed.event)); assert.equal(rv[0]!.status, "satisfied_late");
});
test("19.4-T15: Given a Colorado high-risk system substantially modified 2026-11-01, then an impact assessment is due 2027-01-30.", () => {
  const h = harness("2026-06-01T14:00:00.000Z");
  const reg = registerAiSystem(h.events, { system_id: "default-collections", name: "Default collections prioritization / fee waiver", tier: "T1_consequential", registered_on: D("2026-06-01") });
  assert.equal(reg.high_consequential, true); assert.equal(reg.impact_assessment_due, "2027-06-01"); assert.equal(reg.event.payload.high_consequential, true);
  assert.ok(eventMatches(REG.get("CO_AI_ACT_IMPACT_ASSESSMENT_365")!.triggerPattern!, reg.event));
  const annual = h.timers.byCode("CO_AI_ACT_IMPACT_ASSESSMENT_365"); assert.equal(annual.length, 1); assert.equal(annual[0]!.dueDate, "2027-06-01");
  registerAiSystem(h.events, { system_id: "borrower-faq", name: "FAQ assistant", tier: "T2_borrower_facing", registered_on: D("2026-06-01") });
  assert.equal(h.timers.byCode("CO_AI_ACT_IMPACT_ASSESSMENT_365").length, 1);                          // not a consequential-decision system
  h.clock.set("2026-11-01T15:00:00.000Z");
  const ch = recordAiSystemChange(h.events, { system_id: "default-collections", tier: "T1_consequential", change_kind: "decision_scope", substantial: true, changed_on: D("2026-11-01"), model_version: "m-4" });
  assert.equal(ch.impact_assessment_due, "2027-01-30");                                                // 2026-11-01 + 90 calendar days: 29 (Nov) + 31 (Dec) + 30 (Jan)
  assert.ok(eventMatches(REG.get("CO_AI_ACT_IMPACT_ASSESSMENT_MOD_90D")!.triggerPattern!, ch.event));
  const mod = h.timers.byCode("CO_AI_ACT_IMPACT_ASSESSMENT_MOD_90D"); assert.equal(mod.length, 1); assert.equal(mod[0]!.anchorDate, "2026-11-01"); assert.equal(mod[0]!.dueDate, "2027-01-30"); assert.equal(mod[0]!.status, "armed");
  recordAiSystemChange(h.events, { system_id: "default-collections", tier: "T1_consequential", change_kind: "prompt_version", substantial: false, changed_on: D("2026-11-15"), prompt_version: "p-2026.11" });
  assert.equal(h.timers.byCode("CO_AI_ACT_IMPACT_ASSESSMENT_MOD_90D").length, 1);                       // a non-substantial change arms no modification assessment
  // an annual-kind assessment does not close the modification clock; the modification assessment does, and re-anchors the annual one
  h.clock.set("2027-01-15T15:00:00.000Z");
  completeImpactAssessment(h.events, { system_id: "default-collections", kind: "annual", document_id: "DOC_AI_IMPACT_ASSESSMENT_default-collections-2027", completed_on: D("2027-01-15") });
  assert.equal(mod[0]!.status, "armed"); assert.equal(annual[0]!.status, "satisfied"); assert.equal(h.timers.byCode("CO_AI_ACT_IMPACT_ASSESSMENT_365")[1]!.anchorDate, "2027-01-15");
  const done = completeImpactAssessment(h.events, { system_id: "default-collections", kind: "modification", document_id: "DOC_AI_IMPACT_ASSESSMENT_default-collections-m4", completed_on: D("2027-01-15") });
  assert.equal(done.next_due_at, "2028-01-15"); assert.ok(eventMatches(REG.get("CO_AI_ACT_IMPACT_ASSESSMENT_MOD_90D")!.satisfiedPattern!, done.event)); assert.equal(mod[0]!.status, "satisfied");
  assert.equal(h.timers.byCode("CO_AI_ACT_IMPACT_ASSESSMENT_365").at(-1)!.dueDate, "2028-01-15");     // "last assessment" anchor
  assert.deepEqual(h.timers.evaluate("2027-01-31T12:00:00.000Z"), []);
  // unassessed by 2027-01-30 → sev-2
  const h2 = harness("2026-11-01T15:00:00.000Z");
  recordAiSystemChange(h2.events, { system_id: "default-collections", tier: "T1_consequential", change_kind: "decision_scope", substantial: true, changed_on: D("2026-11-01") });
  const b = h2.timers.evaluate("2027-01-31T12:00:00.000Z"); assert.equal(b.length, 1); assert.equal(b[0]!.instance.code, "CO_AI_ACT_IMPACT_ASSESSMENT_MOD_90D"); assert.equal(b[0]!.severity, 2);
  assert.throws(() => completeImpactAssessment(h.events, { system_id: "default-collections", kind: "annual", document_id: "", completed_on: D("2027-01-15") }), RangeError);
});
test("19.4-T16: Given AI off, then analysts can run the monthly monitor from the enclave with identical outputs (deterministic computation) and timers.", () => {
  const metrics = [{ metric: "modification_approval_rate", dimension: "ethnicity:hispanic_or_latino", test: { group_n: 250, group_events: 155, comparison_n: 900, comparison_events: 639 } }, { metric: "fee_waiver_rate", dimension: "sex:female", test: { group_n: 400, group_events: 120, comparison_n: 600, comparison_events: 186 } }];
  const withAi = monthlyMonitorRun({ period: "2026-09", run_on: D("2026-10-10"), ai_off: false, metrics });
  const aiOff = monthlyMonitorRun({ period: "2026-09", run_on: D("2026-10-10"), ai_off: true, metrics: [...metrics].reverse() });
  assert.equal(aiOff.output_hash, withAi.output_hash); assert.deepEqual(aiOff.results, withAi.results); assert.deepEqual(aiOff.timers, withAi.timers); assert.deepEqual(aiOff.material, withAi.material);
  assert.equal(withAi.results[1]!.result.air.toFixed(3), "0.873"); assert.ok(withAi.timers.some((t) => t.code === "SM_FAIR_SERVICING_MONITOR_MONTHLY"));
});

test("19.4 timers: the monthly monitor, quarterly regression and quarterly production bias tests arm on their schedules and close on the enclave's run events", () => {
  const h = harness("2026-09-30T20:00:00.000Z");
  h.events.append({ type: "period.quarter_end", actor: SYSTEM, payload: { period: "2026-Q3", date: "2026-09-30" } });
  const reg = h.timers.byCode("SM_FAIR_SERVICING_REGRESSION_QUARTERLY"); assert.equal(reg.length, 1); assert.equal(reg[0]!.dueDate, "2026-10-20");   // quarter end + 20 days
  const bias = h.timers.byCode("SM_AI_BIAS_TEST_QUARTERLY_90"); assert.equal(bias.length, 1); assert.equal(bias[0]!.dueDate, "2026-12-30");
  h.clock.set("2026-10-10T14:00:00.000Z");
  h.events.append({ type: "schedule.tick", actor: SYSTEM, payload: { cadence: "monthly", day: 10, job: "fair-servicing-monitor", date: "2026-10-10" } });
  const monthly = h.timers.byCode("SM_FAIR_SERVICING_MONITOR_MONTHLY"); assert.equal(monthly.length, 1); assert.equal(monthly[0]!.dueDate, "2026-11-10");
  // a monthly run closes the monthly clock (and re-arms it) but not the regression one
  const m = completeMonitorRun(h.events, { ...RUN, period: "2026-09", run_on: D("2026-10-10"), kind: "monthly", metrics: [WORKED] });
  assert.equal(m.completed.payload.controls, false); assert.equal(monthly[0]!.status, "satisfied"); assert.equal(h.timers.byCode("SM_FAIR_SERVICING_MONITOR_MONTHLY").length, 2); assert.equal(reg[0]!.status, "armed");
  assert.throws(() => completeMonitorRun(h.events, { ...RUN, period: "2026-Q3", run_on: D("2026-10-15"), kind: "regression", metrics: [WORKED] }), RangeError);   // a regression run needs its controls
  const q = completeMonitorRun(h.events, { ...RUN, period: "2026-Q3", run_on: D("2026-10-15"), kind: "regression", controls: ["delinquency_depth", "mtmltv", "state"], metrics: [WORKED] });
  assert.equal(q.completed.payload.controls, true); assert.ok(eventMatches(REG.get("SM_FAIR_SERVICING_REGRESSION_QUARTERLY")!.satisfiedPattern!, q.completed)); assert.equal(reg[0]!.status, "satisfied");
  // a pre-deploy suite does not count as the quarterly production tests; a production run does
  const tests = { leakage_clean: true, counterfactual_flip_rate: 0.002, directional_shift: false, outcome_parity_ok: true, explanation_consistent: true };
  runBiasSuite(h.events, { ai_system_id: "cashiering", model_version: "m-1", prompt_version: "p-1", scope: "pre_deploy", ran_on: D("2026-10-15"), dataset_id: "cf-1", tests });
  assert.equal(bias[0]!.status, "armed");
  const prod = runBiasSuite(h.events, { ai_system_id: "cashiering", model_version: "m-1", prompt_version: "p-1", scope: "production", ran_on: D("2026-10-15"), dataset_id: "cf-1", tests });
  assert.equal(prod.events[0]!.payload.cadence, "quarterly"); assert.ok(eventMatches(REG.get("SM_AI_BIAS_TEST_QUARTERLY_90")!.satisfiedPattern!, prod.events[0]!)); assert.equal(bias[0]!.status, "satisfied");
  // a failed production suite opens a sev-1 review
  const failed = runBiasSuite(h.events, { ai_system_id: "cashiering", model_version: "m-1", prompt_version: "p-1", scope: "production", ran_on: D("2026-10-15"), dataset_id: "cf-1", tests: { ...tests, explanation_consistent: false } });
  assert.deepEqual(failed.review, { severity: "sev1", opened: true }); assert.equal(failed.events[1]!.type, "fair_servicing_review.opened");
  assert.throws(() => completeMonitorRun(h.events, { ...RUN, period: "x", run_on: D("2026-10-10"), kind: "monthly", metrics: [] }), RangeError);
});
