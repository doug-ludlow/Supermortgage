// 1.4 Document custody verification
// spec/sections/01-boarding-servicing-transfer-in/1-4-document-custody-verification.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM } from "../../kernel/events/index.ts";
import { loadRegistry, TimerEngine } from "../../kernel/timers/index.ts";
import { applyTransferTimerOverrides } from "./timers.ts";
import { enoteVerification, enotePayoffGate, recertForecast, SUPERMORTGAGE_ORG_ID } from "./inbound.ts";

// 1.4-T1 — implemented in src/domain/transfers/transfers.test.ts
// 1.4-T2 — implemented in src/domain/transfers/transfers.test.ts
// 1.4-T3 — implemented in src/domain/transfers/transfers.test.ts
// 1.4-T4 — implemented in src/domain/transfers/transfers.test.ts
// 1.4-T5 — implemented in src/domain/transfers/transfers.test.ts
test("1.4-T6: Given an eNote whose eRegistry Servicing Agent \u2260 Supermortgage Org ID on Oct. 1, then the timer breaches and the payoff command for that loan is blocked with reason `enote_servicing_agent_mismatch`.", () => {
  const clock = new FixedClock("2026-09-01T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const registry = loadRegistry(); applyTransferTimerOverrides(registry);
  const timers = new TimerEngine(registry, events, { processes: ["1.4"] });
  events.append({ type: "transfer.batch.approved", loanId: "L-enote", actor: SYSTEM, payload: { emortgage_count: 1, transfer_date: "2026-10-01" } });
  const t = timers.byCode("FNMA_F1_11_ENOTE_SERVICING_AGENT_T0"); assert.equal(t.length, 1);
  const v = enoteVerification({ controller: "FNMA", location: "FNMA eVault", servicing_agent: "1000456" });   // still the transferor
  assert.deepEqual(v, { ok: false, problems: ["enote_servicing_agent_mismatch"] });
  const breaches = timers.evaluate("2026-10-02T04:30:00.000Z");     // end of Oct 1 (ET) has passed
  assert.ok(breaches.some((b) => b.def.code === "FNMA_F1_11_ENOTE_SERVICING_AGENT_T0")); assert.equal(t[0]!.status, "breached");
  assert.deepEqual(enotePayoffGate({ enote: true, servicing_agent_verified: v.ok }), { ok: false, reason: "enote_servicing_agent_mismatch" });
  assert.equal(enoteVerification({ controller: "FNMA", location: "FNMA eVault", servicing_agent: SUPERMORTGAGE_ORG_ID }).ok, true);
  events.append({ type: "enote.eregistry.verified", loanId: "L-enote", actor: SYSTEM, payload: { servicing_agent: SUPERMORTGAGE_ORG_ID } });
  assert.equal(t[0]!.status, "satisfied_late");
});
test("1.4-T7: Given the agent's forecast shows 400 of 5,000 loans unrecertified at Feb. 15, 2027, then an extension request draft exists by Mar. 1, 2027 and an `officer` task is open.", () => {
  const f = recertForecast({ ted: D("2026-10-01"), code: "D", total: 5000, unrecertified_at_forecast: 400, forecast_date: D("2027-02-15") });
  assert.deepEqual([f.deadline, f.extension_request_by, f.at_risk, f.extension_draft_due, f.officer_task, f.pct_unrecertified], ["2027-04-01", "2027-03-17", true, "2027-03-01", "recert_extension", 8]);
  assert.equal(recertForecast({ ted: D("2026-10-01"), code: "D", total: 5000, unrecertified_at_forecast: 0, forecast_date: D("2027-02-15") }).officer_task, null);
});
// 1.4-T8 — implemented in src/domain/transfers/transfers.test.ts
// 1.4-T9 — implemented in src/domain/transfers/transfers.test.ts
