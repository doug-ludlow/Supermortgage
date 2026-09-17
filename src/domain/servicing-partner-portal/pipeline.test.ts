// 36.4 rules 2–4 — the pure stage projection (src/domain/servicing-partner-portal/pipeline.ts): the furthest row in the declared order,
// a stage with no row omitted, the terminal names as stored, one item per member (the newest motion) with the history whole, and the
// one arithmetic (calendar days in America/New_York). No database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPLICATION_TERMINAL_STAGES, PIPELINE_STAGES, TERMINAL_STAGES, daysInStage, isInFlightStage, isTerminalStage, pipelineOf, type ApplicationMotion, type OpportunityMotion } from "./pipeline.ts";

const T = (d: string): string => `${d}T12:00:00.000Z`;
const opp = (o: Partial<OpportunityMotion> & { opportunity_id: string; status: string }): OpportunityMotion => ({ offered_at: null, engaged_at: null, declined_at: null, expired_at: null, application_id: null, ...o });
const app = (a: Partial<ApplicationMotion> & { application_id: string; opened_at: string }): ApplicationMotion => ({ opportunity_id: null, readiness_missing: null, du_at: null, disclosures_at: null, closing_at: null, boarded: null, disposition: null, ...a });

test("36.4 rule 1: a member enters the feed on offered, never before — offer_ready, suppressed and detected rows answer no stage", () => {
  for (const status of ["detected", "suppressed", "offer_ready"]) assert.deepEqual(pipelineOf({ opportunities: [opp({ opportunity_id: "o1", status })], applications: [] }), { stages: [], current: null, motions: 0 }, status);
  assert.deepEqual(pipelineOf({ opportunities: [], applications: [] }), { stages: [], current: null, motions: 0 });
  const offered = pipelineOf({ opportunities: [opp({ opportunity_id: "o1", status: "offered", offered_at: T("2026-09-15") })], applications: [] });
  assert.deepEqual(offered, { stages: [{ stage: "offered", entered_at: T("2026-09-15"), opportunity_id: "o1" }], current: { stage: "offered", entered_at: T("2026-09-15"), opportunity_id: "o1" }, motions: 1 });
});

test("36.4 rule 2: the furthest row in the declared order is current; every stage reached is on the strip in time order; missing rides on readiness", () => {
  const o = opp({ opportunity_id: "o1", status: "converted", offered_at: T("2026-09-15"), engaged_at: T("2026-09-16"), application_id: "a1" });
  const a = app({ application_id: "a1", opened_at: T("2026-09-16"), readiness_missing: ["identity", "ssn", "income"] });
  const r = pipelineOf({ opportunities: [o], applications: [a] });
  assert.deepEqual(r.stages.map((s) => s.stage), ["offered", "engaged", "readiness"]); assert.equal(r.current?.stage, "readiness"); assert.deepEqual(r.current?.missing, ["identity", "ssn", "income"]); assert.equal(r.current?.application_id, "a1"); assert.equal(r.current?.opportunity_id, "o1");
  // the LE lands before the DU run (discrepancy 2): disclosures is current, du recorded when it lands, the strip in time order
  const le = pipelineOf({ opportunities: [o], applications: [{ ...a, disclosures_at: T("2026-09-18") }] });
  assert.equal(le.current?.stage, "disclosures");
  const du = pipelineOf({ opportunities: [o], applications: [{ ...a, disclosures_at: T("2026-09-18"), du_at: T("2026-09-20") }] });
  assert.equal(du.current?.stage, "disclosures", "the current stage never steps back"); assert.deepEqual(du.stages.map((s) => s.stage), ["offered", "engaged", "readiness", "disclosures", "du"]);
  // closing, then boarded with the new loan named (rule 7)
  const boarded = pipelineOf({ opportunities: [o], applications: [{ ...a, du_at: T("2026-09-20"), disclosures_at: T("2026-09-21"), closing_at: T("2026-11-10"), boarded: { loan_id: "new-1", boarded_at: T("2026-11-12"), status: "active" } }] });
  assert.deepEqual(boarded.stages.map((s) => s.stage), ["offered", "engaged", "readiness", "du", "disclosures", "closing", "boarded"]);
  assert.deepEqual(boarded.current, { stage: "boarded", entered_at: T("2026-11-12"), application_id: "a1", opportunity_id: "o1", new_loan: { loan_id: "new-1", status: "active" } });
  assert.equal(pipelineOf({ opportunities: [o], applications: [{ ...a, boarded: { loan_id: "new-1", boarded_at: T("2026-11-12"), status: "staged" } }] }).current?.stage, "readiness", "a staged loan is not boarded yet (loans.status = active is the row)");
  assert.deepEqual([...PIPELINE_STAGES], ["offered", "engaged", "readiness", "du", "disclosures", "closing", "boarded"]);
});

test("36.4 rule 2: the terminal stages by their stored names end the motion — expired and declined from 20.1, 21.6's dispositions from the application", () => {
  const expired = pipelineOf({ opportunities: [opp({ opportunity_id: "o1", status: "expired", offered_at: T("2026-09-15"), expired_at: T("2026-10-16") })], applications: [] });
  assert.deepEqual(expired.stages.map((s) => s.stage), ["offered", "expired"]); assert.equal(expired.current?.stage, "expired"); assert.equal(expired.current?.entered_at, T("2026-10-16"));
  const declined = pipelineOf({ opportunities: [opp({ opportunity_id: "o1", status: "declined", offered_at: T("2026-09-15"), engaged_at: T("2026-09-16"), declined_at: T("2026-09-17") })], applications: [] });
  assert.deepEqual(declined.stages.map((s) => s.stage), ["offered", "engaged", "declined"]); assert.equal(declined.current?.stage, "declined");
  for (const stage of APPLICATION_TERMINAL_STAGES) {
    const r = pipelineOf({ opportunities: [opp({ opportunity_id: "o1", status: "converted", offered_at: T("2026-09-15"), engaged_at: T("2026-09-16"), application_id: "a1" })], applications: [app({ application_id: "a1", opened_at: T("2026-09-16"), du_at: T("2026-09-20"), disposition: { stage, at: T("2026-09-25") } })] });
    assert.equal(r.current?.stage, stage, stage); assert.equal(r.stages.at(-1)?.stage, stage);
  }
  assert.deepEqual([...TERMINAL_STAGES], ["expired", "declined", "withdrawn", "denied", "closed_incomplete", "approved_not_accepted"]);
  assert.ok(TERMINAL_STAGES.every(isTerminalStage)); assert.ok(!isTerminalStage("boarded"));
  assert.deepEqual(["offered", "engaged", "readiness", "du", "disclosures", "closing"].map(isInFlightStage), [true, true, true, true, true, true]); assert.equal(isInFlightStage("boarded"), false); assert.equal(isInFlightStage("expired"), false);
  // an expiry with no event instant is not a stage (never assumed from the calendar)
  assert.deepEqual(pipelineOf({ opportunities: [opp({ opportunity_id: "o1", status: "expired", offered_at: T("2026-09-15") })], applications: [] }).stages.map((s) => s.stage), ["offered"]);
});

test("36.4 rule 3: one item per member — the newest motion — and the detail keeps the earlier motion's entries, terminal included", () => {
  const first = opp({ opportunity_id: "o1", status: "expired", offered_at: T("2026-09-15"), expired_at: "2026-10-16T11:05:00.000Z" });
  const second = opp({ opportunity_id: "o2", status: "offered", offered_at: "2026-10-16T11:20:00.000Z" });
  const r = pipelineOf({ opportunities: [second, first], applications: [] });
  assert.deepEqual(r.stages.map((s) => [s.stage, s.opportunity_id]), [["offered", "o1"], ["expired", "o1"], ["offered", "o2"]]);
  assert.deepEqual(r.current, { stage: "offered", entered_at: "2026-10-16T11:20:00.000Z", opportunity_id: "o2" }); assert.equal(r.motions, 2);
  // an application that opened without an opportunity on record is its own motion (the borrower-request path); matched by opportunity_id when the opened event names one
  const alone = pipelineOf({ opportunities: [], applications: [app({ application_id: "a9", opened_at: T("2026-09-20"), readiness_missing: [] })] });
  assert.equal(alone.current?.stage, "readiness"); assert.equal(alone.motions, 1);
  const byName = pipelineOf({ opportunities: [opp({ opportunity_id: "o1", status: "converted", offered_at: T("2026-09-15"), engaged_at: T("2026-09-16") })], applications: [app({ application_id: "a1", opportunity_id: "o1", opened_at: T("2026-09-16") })] });
  assert.equal(byName.motions, 1); assert.deepEqual(byName.stages.map((s) => s.stage), ["offered", "engaged", "readiness"]);
});

test("36.4 rule 4: days_in_stage counts calendar days in America/New_York from the date entered to the day of the read — 0 on the day entered", () => {
  assert.equal(daysInStage("2026-09-15T11:05:00.000Z", "2026-09-15T23:00:00.000Z"), 0);
  assert.equal(daysInStage("2026-09-15T11:05:00.000Z", "2026-09-16T04:00:00.000Z"), 1, "00:00 ET on the 16th is the next calendar day");
  assert.equal(daysInStage("2026-09-15T11:05:00.000Z", "2026-09-16T03:30:00.000Z"), 0, "23:30 ET on the 15th is still the day entered");
  assert.equal(daysInStage("2026-09-15T11:05:00.000Z", "2026-10-16T11:05:00.000Z"), 31);
  assert.equal(daysInStage("2026-09-15T11:05:00.000Z", "2026-09-14T11:05:00.000Z"), 0, "never negative");
});
