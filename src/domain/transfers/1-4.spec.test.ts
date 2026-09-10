// 1.4 Document custody verification
// spec/sections/01-boarding-servicing-transfer-in/1-4-document-custody-verification.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { loadRegistry, TimerEngine } from "../../kernel/timers/index.ts";
import { EscalationService } from "../../app/escalations.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { applyTransferTimerOverrides } from "./timers.ts";
import { BoardingService } from "../boarding/service.ts";
import { stagedLoan, batchContext, FakePositions } from "../boarding/fixtures.ts";
import { recertDeadline, custodyClocks, custodyOk, assignmentAction, form2009Overdue } from "./custody-mers.ts";
import { enoteVerification, enotePayoffGate, recertForecast, forecastRecertRisk, cutoverPayload, ingestCustodianFeedItem, missingDocsLiabilityWarning, escalateBreach, assignmentException, resolveCustodyException, form2009Report, SUPERMORTGAGE_ORG_ID } from "./inbound.ts";
import { openForm2009Release, returnForm2009Release, form2009Class, form2009ReportFromEvents, form2009ReleasesFromEvents, closeCustodyException, CustodyRoleDenied, resolutionNeedsSigningOfficer, FORM_2009_RETURN_DAYS } from "./ops-1-4.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { FakeCustodian } from "../../infra/integrations/custody.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
const SIGNING_OFFICER: Actor = { kind: "human", id: "u-signer", role: "signing_officer" };
const AGENT: Actor = { kind: "agent", id: "security-records" };
const BATCH = { batch_id: "B1", type: "master_to_sub" as const, transfer_date: D("2026-10-01"), code_type: "D" as const, loan_count: 5000 };
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const registry = loadRegistry(); applyTransferTimerOverrides(registry);
  return { clock, events, timers: new TimerEngine(registry, events, { processes: ["1.4"] }), esc: new EscalationService(events, clock) };
}
const cutover = (h: ReturnType<typeof harness>) => h.events.append({ type: "transfer.batch.cutover_completed", aggregate: { kind: "transfer_batch", id: "B1" }, actor: SYSTEM, payload: cutoverPayload(BATCH) });

test("1.4-T1: Given TED Oct. 1, 2026 (D-Code), then recert deadline = Apr. 1, 2027 and extension cutoff = Mar. 17, 2027.", () => {
  assert.deepEqual(recertDeadline(D("2026-10-01"), "D"), { deadline: "2027-04-01", extension_request_by: "2027-03-17" });
  assert.deepEqual(recertDeadline(D("2026-10-01"), "C"), { deadline: "2027-04-01", extension_request_by: "2027-03-17" });   // custodian-only change: same six months
  const h = harness("2026-10-01T14:00:00.000Z"); cutover(h);
  const six = h.timers.byCode("FNMA_DTJA_RECERT_COMPLETE_6M"); assert.equal(six.length, 1); assert.equal(six[0]!.dueDate, "2027-04-01"); assert.equal(six[0]!.anchorDate, "2026-10-01");
  assert.equal(h.timers.byCode("FNMA_DTJA_RECERT_ISALE_30").length, 0);
  h.clock.set("2027-03-20T14:00:00.000Z"); ingestCustodianFeedItem(h.events, "B1", { kind: "recert_complete_acked", acked_on: D("2027-03-20") });
  assert.equal(six[0]!.status, "satisfied");
});
test("1.4-T2: Given an I-Code transfer with TED Oct. 1, 2026, then recert deadline = Oct. 31, 2026.", () => {
  assert.equal(recertDeadline(D("2026-10-01"), "I").deadline, "2026-10-31"); assert.equal(recertDeadline(D("2026-10-01"), "I").extension_request_by, "2026-10-16");
  const h = harness("2026-10-01T14:00:00.000Z");
  h.events.append({ type: "transfer.batch.cutover_completed", aggregate: { kind: "transfer_batch", id: "B1" }, actor: SYSTEM, payload: cutoverPayload({ ...BATCH, code_type: "I" }) });
  const isale = h.timers.byCode("FNMA_DTJA_RECERT_ISALE_30"); assert.equal(isale.length, 1); assert.equal(isale[0]!.dueDate, "2026-10-31");
  assert.equal(h.timers.byCode("FNMA_DTJA_RECERT_COMPLETE_6M").length, 0, "an I-Code transfer carries the 30-day clock, not the six-month one");
});
test("1.4-T3: Given the trial balance is acked by the custodian Oct. 30, 2026, then `FNMA_DTJA_TRIAL_BALANCE_TO_CUSTODIAN_30` is satisfied; acked Nov. 1 → breached.", () => {
  assert.equal(custodyClocks(D("2026-10-01")).trial_balance_by, "2026-10-31");
  const a = harness("2026-10-01T14:00:00.000Z"); cutover(a);
  const tb = a.timers.byCode("FNMA_DTJA_TRIAL_BALANCE_TO_CUSTODIAN_30"); assert.equal(tb.length, 1); assert.equal(tb[0]!.dueDate, "2026-10-31");
  a.clock.set("2026-10-30T15:00:00.000Z");
  const ack = ingestCustodianFeedItem(a.events, "B1", { kind: "trial_balance_ack", receipt_id: "TB-1-2026-10-30", acked_on: D("2026-10-30") });
  assert.equal(ack.type, "custody.trial_balance.sent"); assert.equal(tb[0]!.status, "satisfied"); assert.equal(tb[0]!.satisfiedByEventId, ack.id);
  const b = harness("2026-10-01T14:00:00.000Z"); cutover(b);
  const late = b.timers.byCode("FNMA_DTJA_TRIAL_BALANCE_TO_CUSTODIAN_30")[0]!;
  assert.equal(b.timers.evaluate("2026-10-31T20:00:00.000Z").length, 0);
  const breaches = b.timers.evaluate("2026-11-01T14:00:00.000Z");
  const breach = breaches.find((x) => x.def.code === "FNMA_DTJA_TRIAL_BALANCE_TO_CUSTODIAN_30")!;
  assert.equal(late.status, "breached"); assert.equal(breach.severity, 1); assert.ok(breach.escalateTo.includes("officer"));
  assert.equal(escalateBreach(b.esc, breach, AGENT).ownerRole, "officer");
  b.clock.set("2026-11-01T15:00:00.000Z"); ingestCustodianFeedItem(b.events, "B1", { kind: "trial_balance_ack", receipt_id: "TB-1-2026-11-01", acked_on: D("2026-11-01") });
  assert.equal(late.status, "satisfied_late");
});
test("1.4-T4: Given documents received Oct. 15 and a custodian exception list dated Nov. 15, then `FNMA_DTJA_MISSING_DOCS_NOTICE_30` is breached (liability warning logged).", () => {
  const ck = custodyClocks(D("2026-10-01"), D("2026-10-15")); assert.deepEqual([ck.recert_start_by, ck.missing_docs_notice_by, ck.own_exception_review_by], ["2026-10-25", "2026-11-14", "2026-11-04"]);
  const h = harness("2026-10-15T15:00:00.000Z"); cutover(h);
  ingestCustodianFeedItem(h.events, "B1", { kind: "shipment_received", received_on: D("2026-10-15"), first: true, manifest_id: "MAN-1", document_count: 4990 });
  const missing = h.timers.byCode("FNMA_DTJA_MISSING_DOCS_NOTICE_30")[0]!, review = h.timers.byCode("SM_CUSTODY_EXCEPTION_REVIEW_20")[0]!, start = h.timers.byCode("FNMA_DTJA_RECERT_START_FILE_10")[0]!;
  assert.deepEqual([missing.dueDate, review.dueDate, start.dueDate], ["2026-11-14", "2026-11-04", "2026-10-25"]);
  assert.equal(h.timers.evaluate("2026-11-14T20:00:00.000Z").filter((b) => b.def.code === "FNMA_DTJA_MISSING_DOCS_NOTICE_30").length, 0);
  const breach = h.timers.evaluate("2026-11-15T14:00:00.000Z").find((b) => b.def.code === "FNMA_DTJA_MISSING_DOCS_NOTICE_30")!;
  assert.equal(missing.status, "breached"); assert.equal(breach.severity, 1); assert.match(breach.breachText, /liability shifts to transferee custodian/);
  const w = missingDocsLiabilityWarning(h.events, breach);
  assert.equal(w.batch_id, "B1"); assert.equal(w.due_date, "2026-11-14"); assert.match(w.warning, /responsible for any missing files/);
  assert.equal(h.events.ofType("custody.liability_warning.logged").length, 1);
  h.clock.set("2026-11-15T16:00:00.000Z");
  ingestCustodianFeedItem(h.events, "B1", { kind: "exceptions_notified", notified_on: D("2026-11-15"), exceptions: [{ fnma_loan_number: "4000000007", kind: "allonge_missing" }] });
  assert.equal(missing.status, "satisfied_late");
});
test("1.4-T5: Given a loan with no custodian and no eVault reference, then `HF-018` blocks boarding.", () => {
  assert.equal(custodyOk({ custodian: null, certification_status: null, enote_controller: null }), false);
  assert.equal(custodyOk({ custodian: null, certification_status: null, enote_controller: "FNMA" }), true);
  assert.equal(evaluateGate("1.4.custodyRecordPresent", { custodian_id: "", evault_reference: "" }).open, false);   // SM_CUSTODY_RECORD_GATE on `loan.staged`
  const clock = new FixedClock("2026-09-17T02:00:00.000Z"); const events = new MemoryEventStore(clock); const ext = new FakePositions();
  const svc = new BoardingService({ events, ledger: new MemoryLedger(), ext, clock, clearingAccountId: "CUST-CLEARING" }); svc.openBatch(batchContext({ transfer_date: D("2026-10-01") }));
  const loan = stagedLoan({ custody: null }); ext.agree(loan);
  const [bl] = svc.stage("B1", [loan]); svc.validate("B1");
  assert.equal(bl!.status, "exception"); assert.equal(bl!.validations.find((v) => v.code === "HF-018")!.result, "fail");
  clock.set("2026-10-01T14:00:00.000Z");
  assert.equal(svc.board("B1", { finalTapeReconciled: true }).boarded.length, 0); assert.equal(bl!.status, "exception");
});
test("1.4-T6: Given an eNote whose eRegistry Servicing Agent ≠ Supermortgage Org ID on Oct. 1, then the timer breaches and the payoff command for that loan is blocked with reason `enote_servicing_agent_mismatch`.", () => {
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
  // Agent design: "drafts extension requests 30 days ahead of the 15-day cutoff" → Mar 17 − 30 = Feb 15, 2027, which is "by Mar. 1, 2027".
  assert.deepEqual([f.deadline, f.extension_request_by, f.at_risk, f.extension_draft_due, f.officer_task, f.pct_unrecertified], ["2027-04-01", "2027-03-17", true, "2027-02-15", "recert_extension", 8]);
  assert.ok(f.extension_draft_due! <= "2027-03-01", "the draft exists by Mar. 1, 2027");
  assert.equal(recertForecast({ ted: D("2026-10-01"), code: "D", total: 5000, unrecertified_at_forecast: 0, forecast_date: D("2027-02-15") }).officer_task, null);
  // On the bus: the forecast emits `custody.recert.at_risk` (FNMA_DTJA_RECERT_EXTENSION_15 due Mar 17, anchored on the recert deadline) and opens the officer task.
  const h = harness("2027-02-15T14:00:00.000Z");
  const r = forecastRecertRisk(h.events, h.esc, "B1", { ted: D("2026-10-01"), code: "D", total: 5000, unrecertified_at_forecast: 400, forecast_date: D("2027-02-15") }, AGENT);
  assert.ok(r.officer_task_id); assert.equal(h.esc.opened[0]!.ownerRole, "officer"); assert.equal(h.esc.opened[0]!.payload.task, "recert_extension"); assert.equal(h.esc.opened[0]!.status, "open"); assert.equal(h.esc.opened[0]!.payload.draft_due, "2027-02-15");
  const ext = h.timers.byCode("FNMA_DTJA_RECERT_EXTENSION_15"); assert.equal(ext.length, 1); assert.equal(ext[0]!.dueDate, "2027-03-17"); assert.equal(ext[0]!.anchorDate, "2027-04-01");
  h.clock.set("2027-03-01T14:00:00.000Z"); ingestCustodianFeedItem(h.events, "B1", { kind: "extension_requested", requested_on: D("2027-03-01"), until: D("2027-06-01") });
  assert.equal(ext[0]!.status, "satisfied");
  assert.equal(forecastRecertRisk(h.events, h.esc, "B2", { ted: D("2026-10-01"), code: "D", total: 5000, unrecertified_at_forecast: 0, forecast_date: D("2027-02-15") }, AGENT).officer_task_id, null);
});
test("1.4-T8: Given a non-MERS loan with no recorded assignment to Fannie Mae, then a `custody_exceptions{assignment_missing}` row exists until the recorded image is received.", () => {
  assert.equal(assignmentAction({ mers_registered: true, assignment_to_fnma_recorded: false }), "min_update_only");
  assert.equal(assignmentAction({ mers_registered: false, assignment_to_fnma_recorded: true }), "none");
  assert.equal(assignmentAction({ mers_registered: false, assignment_to_fnma_recorded: false }), "record_assignment_to_transferee");
  const row = assignmentException({ loan_id: "L-8", mers_registered: false, assignment_to_fnma_recorded: false }, D("2026-10-01"))!;
  assert.deepEqual([row.kind, row.raised_by, row.raised_at, row.resolved_at, row.evidence_document_id], ["assignment_missing", "agent", "2026-10-01", null, null]);
  assert.equal(assignmentException({ loan_id: "L-9", mers_registered: true, assignment_to_fnma_recorded: false }, D("2026-10-01")), null);
  const resolved = resolveCustodyException(row, { document_id: "doc-recorded-assignment", received_on: D("2026-11-20"), resolution: "recorded assignment transferor → transferee received (F-1-11)" });
  assert.equal(resolved.resolved_at, "2026-11-20"); assert.equal(resolved.evidence_document_id, "doc-recorded-assignment"); assert.equal(row.resolved_at, null, "append-only: the original row is unchanged");
  // State machine: "`exception` resolution involving an assignment requires `signing_officer`" — the agent cannot close the row; the signing officer closes it with the recorded image, and the resolution is an event on the loan.
  const h = harness("2026-11-20T15:00:00.000Z");
  const evidence = { document_id: "doc-recorded-assignment", received_on: D("2026-11-20"), resolution: "recorded assignment transferor → transferee received (F-1-11)" };
  assert.equal(resolutionNeedsSigningOfficer("assignment_missing"), true); assert.equal(resolutionNeedsSigningOfficer("data_mismatch"), false);
  assert.throws(() => closeCustodyException(h.events, row, evidence, AGENT), (e: unknown) => e instanceof CustodyRoleDenied && e.required === "signing_officer");
  assert.throws(() => closeCustodyException(h.events, row, evidence, { kind: "human", id: "u-officer", role: "officer" }), CustodyRoleDenied);
  assert.equal(h.events.ofType("custody.exception.resolved").length, 0, "a refused resolution appends nothing");
  const closed = closeCustodyException(h.events, row, evidence, SIGNING_OFFICER);
  assert.equal(closed.resolved_at, "2026-11-20"); assert.equal(closed.event.type, "custody.exception.resolved"); assert.equal(closed.event.loanId, "L-8");
  assert.deepEqual([closed.event.payload.kind, closed.event.payload.evidence_document_id, closed.event.payload.resolved_by], ["assignment_missing", "doc-recorded-assignment", "human:u-signer"]);
  assert.throws(() => closeCustodyException(h.events, closed, evidence, SIGNING_OFFICER), RangeError, "already resolved");
});
test("1.4-T9: Given a Form 2009 release open 91 days for a non-liquidation reason, then `FNMA_RDC_FORM2009_90` fires and the release appears on the 90-day report.", () => {
  assert.equal(form2009Overdue(D("2026-07-01"), D("2026-09-30"), false), true); assert.equal(form2009Overdue(D("2026-07-01"), D("2026-09-29"), false), false);
  assert.equal(form2009Class("foreclosure_counsel"), "non_liquidation"); assert.equal(form2009Class("payoff"), "liquidation"); assert.throws(() => form2009Class("vacation"), RangeError);
  const h = harness("2026-07-01T14:00:00.000Z");
  // The release is opened by the agent (13.3 counsel request): `custody.release.opened{reason=non_liquidation}` on the loan arms the 90-day clock anchored on released_at.
  const rel = openForm2009Release(h.events, { loan_id: "L-2009", form_2009_id: "F2009-1", release_reason: "foreclosure_counsel", released_on: D("2026-07-01"), released_to: "FC counsel (13.6)" }, AGENT);
  assert.equal(rel.event.type, "custody.release.opened"); assert.equal(rel.reason, "non_liquidation"); assert.equal(rel.expected_return_at, "2026-09-29"); assert.equal(rel.note_location, "released_form_2009");
  const t = h.timers.byCode("FNMA_RDC_FORM2009_90"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-09-29"); assert.equal(t[0]!.anchorDate, "2026-07-01"); assert.deepEqual(t[0]!.subject, { kind: "loan", id: "L-2009" });
  assert.equal(h.timers.evaluate("2026-09-29T20:00:00.000Z").length, 0);
  const fired = h.timers.evaluate("2026-09-30T14:00:00.000Z"); assert.equal(fired.length, 1); assert.equal(fired[0]!.def.code, "FNMA_RDC_FORM2009_90"); assert.match(fired[0]!.breachText, /90-Day Non-Liquidation Report/);
  // A liquidation release (payoff, 16.x) never arms the clock.
  openForm2009Release(h.events, { loan_id: "L-paid", form_2009_id: "F2009-2", release_reason: "payoff", released_on: D("2026-06-01"), released_to: "payoff" }, AGENT);
  assert.equal(h.timers.byCode("FNMA_RDC_FORM2009_90").length, 1);
  const report = form2009Report([{ loan_id: "L-2009", released_at: D("2026-07-01"), reason: "foreclosure_counsel" }, { loan_id: "L-paid", released_at: D("2026-06-01"), reason: "payoff" }, { loan_id: "L-back", released_at: D("2026-06-01"), reason: "foreclosure_counsel", returned_at: D("2026-08-01") }], D("2026-09-30"));
  assert.deepEqual(report.rows, [{ loan_id: "L-2009", released_at: "2026-07-01", reason: "foreclosure_counsel", days_open: 91, due_back: "2026-09-29" }]);
  // The same report from the loan's events: the open non-liquidation release is on it, the payoff release is not.
  assert.deepEqual(form2009ReportFromEvents(h.events, D("2026-09-30")).rows, [{ loan_id: "L-2009", released_at: "2026-07-01", reason: "foreclosure_counsel", days_open: 91, due_back: "2026-09-29" }]);
  // Documents come back Oct 5 (custodian receipt): `custody.release.returned` satisfies the fired timer late; the engine's recurring re-arm is retired because a returned release leaves the report.
  h.clock.set("2026-10-05T15:00:00.000Z");
  const ret = returnForm2009Release(h.events, { loan_id: "L-2009", form_2009_id: "F2009-1", released_on: D("2026-07-01"), returned_on: D("2026-10-05"), custodian_receipt_id: "RCPT-77" }, undefined, h.timers);
  assert.equal(ret.event.type, "custody.release.returned"); assert.equal(ret.days_open, 96); assert.equal(ret.on_time, false); assert.equal(FORM_2009_RETURN_DAYS, 90);
  assert.equal(t[0]!.status, "satisfied_late"); assert.equal(t[0]!.satisfiedByEventId, ret.event.id);
  assert.ok(ret.retired_rearm_id); assert.equal(h.timers.byCode("FNMA_RDC_FORM2009_90").find((x) => x.id === ret.retired_rearm_id)!.status, "cancelled");
  assert.equal(h.timers.open().filter((x) => x.code === "FNMA_RDC_FORM2009_90").length, 0);
  assert.deepEqual(form2009ReportFromEvents(h.events, D("2026-10-06")).rows, []);
  assert.equal(form2009ReleasesFromEvents(h.events).find((r) => r.form_2009_id === "F2009-1")!.returned_at, "2026-10-05");
  assert.throws(() => returnForm2009Release(h.events, { loan_id: "L-2009", form_2009_id: "F2009-1", released_on: D("2026-07-01"), returned_on: D("2026-06-30"), custodian_receipt_id: "R" }), RangeError);
});

// The same Form 2009 path through the bus: `sendToCustodian{kind=form_2009_request}` opens the release (arms FNMA_RDC_FORM2009_90) and
// `ingestCustodianFeed{items:[form_2009_returned]}` returns it (satisfies the timer, retires the recurring re-arm via ctx.timers).
test("1.4 bus: sendToCustodian{kind=form_2009_request} arms FNMA_RDC_FORM2009_90 on the loan and ingestCustodianFeed{form_2009_returned} satisfies it", async () => {
  const clock = new FixedClock("2026-07-01T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const registry = loadRegistry(); applyTransferTimerOverrides(registry);
  const timers = new TimerEngine(registry, events, { processes: ["1.4"] });
  const ctx: UowContext = { loanId: "L-2009", events, ledger: new MemoryLedger(), timers, clock, decide: () => {} };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: { custodian: new FakeCustodian() } as ToolRuntime["ports"] };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents); const bus = new CommandBus(agents);
  const opened = (await bus.execute(cmds.get(toolKey("1.4", "sendToCustodian"))!, AGENT, { kind: "form_2009_request", loan_id: "L-2009", form_2009_id: "F2009-1", release_reason: "foreclosure_counsel", released_on: "2026-07-01", released_to: "FC counsel" }, ctx)).output as { reason: string; expected_return_at: string };
  assert.equal(opened.reason, "non_liquidation"); assert.equal(opened.expected_return_at, "2026-09-29");
  const t = timers.byCode("FNMA_RDC_FORM2009_90"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-09-29"); assert.equal(t[0]!.loanId, "L-2009");
  const openedEvent = events.ofType("custody.release.opened")[0]!; assert.equal(eventMatches(registry.get("FNMA_RDC_FORM2009_90")!.triggerPattern!, openedEvent), true);
  await assert.rejects(bus.execute(cmds.get(toolKey("1.4", "sendToCustodian"))!, AGENT, { kind: "form_2009_request", loan_id: "L-2009", form_2009_id: "", release_reason: "foreclosure_counsel", released_to: "x" }, ctx), RangeError);
  clock.set("2026-09-15T15:00:00.000Z");
  const fed = (await bus.execute(cmds.get(toolKey("1.4", "ingestCustodianFeed"))!, AGENT, { batch_id: "B1", items: [{ kind: "form_2009_returned", loan_id: "L-2009", form_2009_id: "F2009-1", released_on: "2026-07-01", returned_on: "2026-09-15", custodian_receipt_id: "RCPT-1" }] }, ctx)).output as { events: { type: string }[] };
  assert.deepEqual(fed.events.map((e) => e.type), ["custody.release.returned"]);
  assert.equal(t[0]!.status, "satisfied"); assert.equal(eventMatches(registry.get("FNMA_RDC_FORM2009_90")!.satisfiedPattern!, events.ofType("custody.release.returned")[0]!), true);
  assert.equal(timers.open().filter((x) => x.code === "FNMA_RDC_FORM2009_90").length, 0, "the recurring re-arm is retired on return");
  // openException: closing an assignment exception is a signing_officer act on the bus too.
  await assert.rejects(bus.execute(cmds.get(toolKey("1.4", "openException"))!, AGENT, { loan_id: "L-8", data: { kind: "assignment_missing", resolved_at: "2026-11-20", evidence_document_id: "doc-1" } }, ctx), CommandRefused);
  assert.equal(events.ofType("custody.exception.opened").length, 0);
  assert.ok(await bus.execute(cmds.get(toolKey("1.4", "openException"))!, AGENT, { loan_id: "L-8", data: { kind: "assignment_missing", raised_by: "agent", raised_at: "2026-10-01" } }, ctx));
});
