// 17.2 RESPA goodbye notice
// spec/sections/17-servicing-transfer-out/17-2-respa-goodbye-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { SYSTEM, type Actor } from "../../kernel/events/types.ts";
import { MemoryEventStore, FixedClock } from "../../kernel/events/store.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { loadRegistry } from "../../kernel/timers/registry.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { applyTransferTimerOverrides } from "./timers.ts";
import { REQUIRED_CONTENT } from "./respa.ts";
import { planNoticeRun, noticeRunMailed, escalateBreach } from "./inbound.ts";
import { goodbyeTiming, planGoodbyeRun, verifyTransfereeBlock, releaseTransferOutRun, contentPresentFromPayload, contactCenterReady, misdirectedPayment, receiveMisdirectedPayment, disposeMisdirectedPayment, forwardingFile, recordForwardFileAck, autodraftStop, stopAutodrafts, postTransferDebitRefund, shortYearStatement, planShortYearRun, shortYearRunMailed, correctiveNotice, cancelTransferOut, changeTransferOutDate, completeSkipTrace, borrowerRoutingWindow, postTransferSweep, relyOnExceptionB3ii, finalStatementGate, statementCycleGate, GOODBYE_RUN_TIMERS, EXCEPTION_B3II_SUPERSEDED_TIMERS } from "./ops-17-2.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { TOOLS_17_2 } from "../../app/tools/section17-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const CASHIERING: Actor = { kind: "agent", id: "cashiering" };
const TRANSFER: Actor = { kind: "agent", id: "transfer" };
const TRANSFEREE = { name: "Newco Servicing LLC", remittance_address: "PO Box 500, Newtown PA 19001", tollfree: "(800) 555-0200" };
const BATCH = { kind: "transfer_batch", id: "B-out" };
const noticeInput = (id: string, present: readonly string[]) => ({ id, content_present: present, address_valid: true });
/** A live engine over the registry with the section overrides, arming the §1.3/§1.6 rows §17.2 shares. */
function live(startIso: string, processes: string[] = ["1.3", "17.2"]) {
  const clock = new FixedClock(startIso); const events = new MemoryEventStore(clock);
  const registry = loadRegistry(); applyTransferTimerOverrides(registry); const engine = new TimerEngine(registry, events, { processes });
  return { clock, events, registry, engine };
}
const approveOut = (events: MemoryEventStore, transferDate: string, effective: string, extra: Record<string, unknown> = {}) =>
  events.append({ type: "transfer.batch.approved", aggregate: BATCH, actor: SYSTEM, payload: { direction: "out", batch_id: "B-out", transfer_date: transferDate, respa_effective_date: effective, notice_mode: "separate", ...extra } });
/** The 17.2 tools on the command bus over a live engine (the section overrides, processes 1.3 + 17.2) and, when a registry is given, the Notice Registry. */
function bus(startIso: string, noticeRegistry: Parameters<typeof publishAuthored>[0] | null = null) {
  const clock = new FixedClock(startIso); const events = new MemoryEventStore(clock); const registry = loadRegistry(); applyTransferTimerOverrides(registry);
  const engine = new TimerEngine(registry, events, { processes: ["1.3", "17.2"] }); const decisions: DecisionInput[] = [];
  const ctx: UowContext = { loanId: "L-1", events, ledger: new MemoryLedger(), timers: engine, clock, decide: (d) => { decisions.push({ loanId: "L-1", ...d }); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {}, ...(noticeRegistry ? { notices: new NoticeService({ registry: noticeRegistry, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }) } : {}) };
  const agents = new AgentRegistry(); const escalates = loadAgentsFile().processes.find((p) => p.process === "17.2")!.escalates_to;
  const cmds = new Map(TOOLS_17_2.map((d) => { const cmd = toolCommand(d, rt, escalates); agents.registerTool(d.agent, cmd.name); return [d.name, cmd] as const; })); const commandBus = new CommandBus(agents);
  const run = (name: string, actor: Actor, input: Record<string, unknown>) => commandBus.execute(cmds.get(name)!, actor, input, ctx);
  const refusedWith = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof CommandRefused && e.code === code, `expected refusal ${code}`);
  return { clock, events, registry, engine, rt, run, refusedWith, decisions };
}

test("17.2-T1: Given T = Dec 1, 2026 and separate notices, when the goodbye run is mailed Nov 16, 2026, then `REGX_1024_33B3_GOODBYE_15` is satisfied; mailed Nov 17 → breached with `officer` escalation.", () => {
  const t = goodbyeTiming(D("2026-12-01"), true); assert.equal(t.respa_effective_date, "2026-12-01"); assert.equal(t.goodbye_due, "2026-11-16");
  const plan = planGoodbyeRun({ batch_id: "B-out", type: "sub_to_sub", transfer_date: D("2026-12-01"), installments_due_on_1st: true, notice_mode: "separate", unchanged: { payee: false, address: false, account: true, amount: true }, officer: null });
  assert.equal(plan.run!.kind, "goodbye"); assert.equal(plan.run!.template, "NTC_REGX_1024_33B_GOODBYE_MS2"); assert.equal(plan.run!.timer, "REGX_1024_33B3_GOODBYE_15"); assert.equal(plan.run!.due, "2026-11-16");
  const arm = () => { const l = live("2026-10-20T15:00:00.000Z"); approveOut(l.events, "2026-12-01", "2026-12-01"); const goodbye = l.engine.byCode("REGX_1024_33B3_GOODBYE_15")[0]!; assert.equal(goodbye.status, "armed"); assert.equal(goodbye.dueDate, "2026-11-16"); assert.deepEqual(goodbye.subject, BATCH); return { ...l, goodbye, run: planNoticeRun({ batch_id: "B-out", respa_effective_date: D("2026-12-01"), loan_ids: ["L-1", "L-2"] }, "goodbye") }; };
  // mailed Mon Nov 16 (proof of mailing for every loan on the frozen list) → satisfied; the run-level event is the one that satisfies
  const a = arm(); assert.equal(a.run.template, "NTC_REGX_1024_33B_GOODBYE_MS2"); assert.equal(a.run.due_at, "2026-11-16");
  a.clock.set("2026-11-16T20:00:00.000Z");
  const partial = noticeRunMailed(a.events, a.run, [{ loan_id: "L-1", proof_of_mailing_id: "pom-1", mailed_on: D("2026-11-16") }]);
  assert.equal(partial.every_loan, false); assert.equal(a.goodbye.status, "armed", "one loan's proof is not 'for every loan on the frozen list'");
  const full = noticeRunMailed(a.events, a.run, [{ loan_id: "L-2", proof_of_mailing_id: "pom-2", mailed_on: D("2026-11-16") }]);
  assert.equal(full.every_loan, true); assert.equal(full.run_event!.payload.template, "NTC_REGX_1024_33B_GOODBYE_MS2"); assert.equal(full.run_event!.payload.every_loan, true);
  assert.equal(a.goodbye.status, "satisfied"); assert.equal(a.goodbye.satisfiedByEventId, full.run_event!.id);
  assert.equal(a.engine.evaluate("2026-11-17T12:00:00.000Z").filter((x) => x.def.code === "REGX_1024_33B3_GOODBYE_15").length, 0);
  assert.ok(a.events.ofType("notice.transfer.goodbye.sent").length === 2);
  // mailed Tue Nov 17: the deadline (Nov 16, end of day) passed → breached, sev 1 → `officer`; the late mailing closes it as satisfied_late
  const b = arm();
  const breaches = b.engine.evaluate("2026-11-17T12:00:00.000Z").filter((x) => x.def.code === "REGX_1024_33B3_GOODBYE_15");
  assert.equal(breaches.length, 1); assert.equal(b.goodbye.status, "breached"); assert.equal(breaches[0]!.severity, 1); assert.ok(breaches[0]!.escalateTo.includes("officer"));
  const opened: { kind: string; batchId?: string; severity?: string; payload?: Record<string, unknown> }[] = [];
  const esc = escalateBreach({ open: (input) => { opened.push(input); return { id: "esc-1", ownerRole: "officer", kind: input.kind }; } }, breaches[0]!);
  assert.equal(esc.kind, "officer"); assert.equal(esc.timer_code, "REGX_1024_33B3_GOODBYE_15"); assert.equal(opened[0]!.batchId, "B-out"); assert.equal(opened[0]!.severity, "sev-1"); assert.match(String(opened[0]!.payload!.breach), /officer/);
  b.clock.set("2026-11-17T20:00:00.000Z");
  noticeRunMailed(b.events, b.run, [{ loan_id: "L-1", proof_of_mailing_id: "pom-1", mailed_on: D("2026-11-17") }, { loan_id: "L-2", proof_of_mailing_id: "pom-2", mailed_on: D("2026-11-17") }]);
  assert.equal(b.goodbye.status, "satisfied_late");
  assert.ok(b.events.ofType("timer.satisfied").some((e) => e.payload.code === "REGX_1024_33B3_GOODBYE_15" && e.payload.late === true));
});
test("17.2-T2: Given T = Nov 2, 2026 with installments due on the 1st, then `respa_effective_date` = Nov 1 and the goodbye deadline is Oct 17 (run scheduled Oct 16).", () => {
  // Sun Nov 1 is not a Fannie Mae business day and the installment is due on the 1st → decision 1: the effective date is the 1st
  const t = goodbyeTiming(D("2026-11-02"), true);
  assert.equal(t.respa_effective_date, "2026-11-01"); assert.equal(t.goodbye_due, "2026-10-17"); assert.equal(t.run_scheduled_on, "2026-10-16");
  assert.equal(t.transferor_stops, "2026-10-31"); assert.equal(t.transferee_starts, "2026-11-01"); assert.equal(t.window_end, "2026-12-30"); assert.equal(t.transferee_data_due, "2026-10-12");
  const plan = planGoodbyeRun({ batch_id: "B-nov", type: "sub_to_master", transfer_date: D("2026-11-02"), installments_due_on_1st: true, notice_mode: "separate", unchanged: { payee: false, address: false, account: true, amount: true }, officer: null });
  assert.equal(plan.run!.respa_effective_date, "2026-11-01"); assert.equal(plan.run!.due, "2026-10-17"); assert.equal(plan.run!.scheduled_on, "2026-10-16"); assert.equal(plan.run!.deadline_rule, "§1024.33(b)(3)(i) −15");
  // the engine computes the same deadline from the approval's `respa_effective_date`
  const l = live("2026-09-20T15:00:00.000Z"); approveOut(l.events, "2026-11-02", "2026-11-01");
  assert.equal(l.engine.byCode("REGX_1024_33B3_GOODBYE_15")[0]!.dueDate, "2026-10-17"); assert.equal(l.engine.byCode("SM_XFER_OUT_TRANSFEREE_NOTICE_DATA_T20")[0]!.dueDate, "2026-10-12");
  // installments not due on the 1st → no override: effective Nov 2, goodbye by Sun Oct 18, still released Fri Oct 16
  const plain = goodbyeTiming(D("2026-11-02"), false); assert.equal(plain.respa_effective_date, "2026-11-02"); assert.equal(plain.goodbye_due, "2026-10-18"); assert.equal(plain.run_scheduled_on, "2026-10-16");
  // Tue Dec 1, 2026 is a business day → no override even with installments due on the 1st
  assert.equal(goodbyeTiming(D("2026-12-01"), true).respa_effective_date, "2026-12-01");
});
test("17.2-T3: Given a rendered notice missing the transferee's toll-free number, then release is refused.", async () => {
  const withoutTollfree = REQUIRED_CONTENT.filter((c) => c !== "transferee_tollfree");
  const base = { run_id: "run-B-out-goodbye", status: "qc_passed" as const, kind: "goodbye" as const, transferee_block_verified: true, contact_center_ready: true, loan_list_frozen: true, officer_authorization: OFFICER };
  const r = releaseTransferOutRun({ ...base, notices: [noticeInput("N-1", withoutTollfree), noticeInput("N-2", REQUIRED_CONTENT)] });
  assert.equal(r.ok, false); assert.equal(r.released_status, null);
  assert.deepEqual(r.required_content_missing, { "N-1": ["transferee_tollfree"] }); assert.deepEqual(r.refusals, ["N-1: missing transferee_tollfree"]);
  assert.equal(r.escalation!.kind, "officer"); assert.match(r.escalation!.reason, /1024\.33\(b\)\(4\)\(ii\)/); assert.match(r.escalation!.reason, /partner/);
  // the same omission on the transferee's data block fails T-20 verification, so no `transferee.notice_data.verified` is emitted
  const v = verifyTransfereeBlock({ name: TRANSFEREE.name, address: "1 Newco Plaza, Newtown PA 19001", remittance_address: TRANSFEREE.remittance_address, tollfree: null, payment_start_date: D("2026-12-01"), optional_insurance_statement: "none" }, D("2026-12-01"));
  assert.equal(v.ok, false); assert.deepEqual(v.missing, ["tollfree"]); assert.equal(v.event, null);
  // the registry's own machine check on the goodbye MS-2 blocks on rule b4-ii-transferee-tollfree; the content markers are read from the rendered notice, not asserted
  const reg = buildRegistry(); publishAuthored(reg); const tv = reg.activeVersion("NTC_REGX_1024_33B_GOODBYE_MS2", D("2026-11-16"))!;
  const complete = { ...tv.samplePayload, transferor_name: "Supermortgage", transferor_tollfree: "(800) 555-0100", transferor_address: "PO Box 1, Testville TX 75001", transferee_name: TRANSFEREE.name, transferee_tollfree: TRANSFEREE.tollfree, transferee_address: "1 Newco Plaza, Newtown PA 19001", transferee_remittance_address: TRANSFEREE.remittance_address, effective_date: "2026-12-01", transferor_stop_date: "2026-11-30", transferee_start_date: "2026-12-01" };
  assert.equal(evaluateChecklist(tv, complete, render(tv.source, complete)).passed, true);
  assert.deepEqual([...contentPresentFromPayload(complete, render(tv.source, complete).text)].sort(), [...REQUIRED_CONTENT].sort());
  const missing = { ...complete, transferee_tollfree: "" }; const c = evaluateChecklist(tv, missing, render(tv.source, missing));
  assert.equal(c.passed, false); assert.ok(c.blocking.some((b) => b.rule_id === "b4-ii-transferee-tollfree")); assert.ok(c.blocking.every((b) => /transferee|contacts/.test(b.rule_id)), c.blocking.map((b) => b.rule_id).join(","));
  assert.ok(!contentPresentFromPayload(missing, render(tv.source, missing).text).includes("transferee_tollfree"));
  assert.ok(!contentPresentFromPayload(complete, null).includes("ms2_60_day_sentence"), "the template-fixed sentences are read from the rendered text only");
  // with every required item present, the four release requirements and the officer's authorization, a qc_passed run releases
  const ok = releaseTransferOutRun({ ...base, notices: [noticeInput("N-1", REQUIRED_CONTENT), noticeInput("N-2", REQUIRED_CONTENT)] });
  assert.equal(ok.ok, true); assert.equal(ok.released_status, "released_to_vendor"); assert.equal(ok.escalation, null);
  // state machine: a `rendered` run has not passed QC and does not release; (a)–(d): each missing requirement refuses on its own
  assert.match(releaseTransferOutRun({ ...base, status: "rendered", notices: [noticeInput("N-2", REQUIRED_CONTENT)] }).refusals[0]!, /run is rendered: only a qc_passed run releases/);
  assert.match(releaseTransferOutRun({ ...base, transferee_block_verified: false, notices: [noticeInput("N-2", REQUIRED_CONTENT)] }).refusals[0]!, /SM_XFER_OUT_TRANSFEREE_NOTICE_DATA_T20/);
  assert.match(releaseTransferOutRun({ ...base, contact_center_ready: false, notices: [noticeInput("N-2", REQUIRED_CONTENT)] }).refusals[0]!, /SM_TOLLFREE_LIVE_GATE/);
  assert.match(releaseTransferOutRun({ ...base, loan_list_frozen: false, notices: [noticeInput("N-2", REQUIRED_CONTENT)] }).refusals[0]!, /frozen list/);
  assert.match(releaseTransferOutRun({ ...base, officer_authorization: null, notices: [noticeInput("N-2", REQUIRED_CONTENT)] }).refusals[0]!, /officer's authorization/);
  assert.match(releaseTransferOutRun({ ...base, notices: [] }).refusals[0]!, /no rendered notices/);

  // ---- through the bus: the `transfer` agent cannot release by asserting anything — every requirement is read from the store, the Notice Registry and the event log
  const b = bus("2026-11-10T15:00:00.000Z", reg); const { events, rt, run, refusedWith, clock } = b;
  // the run's loans are 17.1's attested frozen list on file, never the caller's loan_ids (nothing attested yet → no loans, and release will refuse)
  const planned = (await run("planNoticeRun", TRANSFER, { batch_id: "B-out", type: "sub_to_sub", transfer_date: "2026-12-01", installments_due_on_1st: true, unchanged: { payee: false, address: false, account: true, amount: true }, loan_ids: ["L-1"] })).output as { frozen_list: unknown };
  assert.equal(planned.frozen_list, null); assert.equal(rt.store.get("transfer_notice_runs", "run-B-out-goodbye")!.data.status, "planned"); assert.deepEqual(rt.store.get("transfer_notice_runs", "run-B-out-goodbye")!.data.loan_ids, []);
  // no decision id at all → the bus refuses the agent before the handler runs
  await refusedWith(run("releaseToVendor", TRANSFER, { run_id: "run-B-out-goodbye", transferee_block_verified: true, contact_center_ready: true, loan_list_frozen: true }), "RELEASE_NEEDS_OFFICER");
  // a made-up decision id and asserted flags: nothing on file → refused on every requirement, and the run stays planned
  const forged = (await run("releaseToVendor", TRANSFER, { run_id: "run-B-out-goodbye", officer_approval_decision_id: "dec-forged", transferee_block_verified: true, contact_center_ready: true, loan_list_frozen: true, notices: [{ id: "N-1", content_present: REQUIRED_CONTENT, address_valid: true }] })).output as { ok: boolean; refusals: string[] };
  assert.equal(forged.ok, false);
  for (const re of [/run is planned/, /no rendered notices/, /transferee notice block not verified/, /SM_TOLLFREE_LIVE_GATE closed/, /frozen list missing/, /dec-forged is not on file/]) assert.ok(forged.refusals.some((x) => re.test(x)), `${re} in ${forged.refusals.join(" | ")}`);
  assert.equal(rt.store.get("transfer_notice_runs", "run-B-out-goodbye")!.data.status, "planned"); assert.equal(rt.escalations.opened.at(-1)!.kind, "officer");
  // the real requirements: verified transferee block, contact_center.ready facts (SM_TOLLFREE_LIVE_GATE), the attested frozen list on file (L-1 and L-2), QC passed, the officer's decision naming the run
  await run("verifyTransfereeBlock", TRANSFER, { batch_id: "B-out", block: { name: TRANSFEREE.name, address: "1 Newco Plaza, Newtown PA 19001", remittance_address: TRANSFEREE.remittance_address, tollfree: TRANSFEREE.tollfree, payment_start_date: "2026-12-01", optional_insurance_statement: "none" }, respa_effective_date: "2026-12-01" });
  assert.equal(rt.store.get("transfer_batches", "B-out")!.data.transferee_block_verified, true); assert.equal(events.ofType("transferee.notice_data.verified").length, 1);
  assert.equal(contactCenterReady(events, "B-out", { toll_free_live: true, ivr_ai_disclosure_verified: false }, D("2026-11-12")).ready, false);
  assert.equal(contactCenterReady(events, "B-out", { toll_free_live: true, ivr_ai_disclosure_verified: true, tollfree: "(800) 555-0100" }, D("2026-11-12")).ready, true);
  events.append({ type: "transfer.loan_list.attested", aggregate: BATCH, actor: OFFICER, payload: { batch_id: "B-out", version: 2, loan_count: 2 } });
  rt.store.put("transfer_batch_loan_list_versions", "B-out-v2", { batch_id: "B-out", version: 2, loans: ["L-1", "L-2"], attested: true, attested_by: "u-officer" }, OFFICER, clock.now());   // what 17.1 reconcileQxDownload{attest} stores
  rt.store.put("transfer_notice_runs", "run-B-out-goodbye", { status: "qc_passed" }, SYSTEM, clock.now());
  await run("writeDecision", OFFICER, { id: "dec-release-1", action: "release_to_vendor", run_id: "run-B-out-goodbye", loans: ["L-1", "L-2"], rationale: "checklist and address validation reviewed; release authorized" });
  assert.equal(rt.store.get("agent_decisions", "dec-release-1")!.updatedBy, "human:u-officer"); assert.equal(b.decisions.at(-1)!.approvedRole, "officer");
  // recipients come from the loan's parties of record, never the caller; content markers come from the rendered notice the Notice Registry holds, never the caller
  await refusedWith(run("validateAddress", TRANSFER, { notice_id: "N-x", loan_id: "L-1", parties: [{ party_id: "P-1", role: "borrower", address: "1 Test St, Testville TX 75001" }] }), "ADDRESS_OF_RECORD_ONLY");
  await assert.rejects(run("validateAddress", TRANSFER, { notice_id: "N-x", loan_id: "L-1" }), (e: unknown) => e instanceof RangeError && /no parties of record for loan L-1/.test((e as Error).message));
  for (const [loan, party, address] of [["L-1", "P-1", "1 Test St, Testville TX 75001"], ["L-2", "P-2", "2 Test St, Testville TX 75001"]] as const) rt.store.put("loan_parties", `${loan}:${party}`, { loan_id: loan, party_id: party, role: "borrower", address }, SYSTEM, clock.now());
  await refusedWith(run("runContentChecklist", TRANSFER, { notice_id: "N-x", run_id: "run-B-out-goodbye", present: REQUIRED_CONTENT }), "CONTENT_FROM_RENDERED_NOTICE_ONLY");
  await refusedWith(run("runContentChecklist", TRANSFER, { notice_id: "N-x", run_id: "run-B-out-goodbye", payload: complete, rendered_text: render(tv.source, complete).text }), "CONTENT_FROM_RENDERED_NOTICE_ONLY");
  await assert.rejects(run("runContentChecklist", TRANSFER, { notice_id: "N-x", run_id: "run-B-out-goodbye" }), (e: unknown) => e instanceof RangeError && /no notice N-x/.test((e as Error).message));
  const renderFor = async (loanId: string, partyId: string, payload: Record<string, unknown>) => (await run("renderNotice", TRANSFER, { template_code: "NTC_REGX_1024_33B_GOODBYE_MS2", loan_id: loanId, recipients: [{ partyId, name: "A. Borrower", mailingAddress: `${loanId === "L-1" ? 1 : 2} Test St, Testville TX 75001` }], payload, as_of: "2026-11-10" })).output as { id: string; status: string };
  await refusedWith(run("renderNotice", TRANSFER, { template_code: "NTC_REGX_1024_33B_HELLO_MS2", loan_id: "L-1", recipients: [], payload: complete, as_of: "2026-11-10" }), "TEMPLATE_FAMILY_17_2");
  const n1 = await renderFor("L-1", "P-1", missing); assert.equal(n1.status, "held");   // the registry checklist holds the notice without the transferee's toll-free number
  const c1 = (await run("runContentChecklist", TRANSFER, { notice_id: n1.id, run_id: "run-B-out-goodbye" })).output as { ok: boolean; missing: string[]; registry_checklist_passed: boolean; loan_id: string };
  assert.equal(c1.ok, false); assert.deepEqual(c1.missing, ["transferee_tollfree"]); assert.equal(c1.registry_checklist_passed, false); assert.equal(c1.loan_id, "L-1");
  assert.deepEqual(rt.store.get("transfer_notices", n1.id)!.data.missing, ["transferee_tollfree"]); assert.equal(rt.store.get("transfer_notices", n1.id)!.data.source, "notice_service");
  const a1 = (await run("validateAddress", TRANSFER, { notice_id: n1.id, loan_id: "L-1" })).output as { address_valid: boolean; recipients: { party_id: string; via: string }[] };
  assert.equal(a1.address_valid, true); assert.deepEqual(a1.recipients, [{ party_id: "P-1", address: "1 Test St, Testville TX 75001", via: "own_address" }]);
  const refused = (await run("releaseToVendor", TRANSFER, { run_id: "run-B-out-goodbye", officer_approval_decision_id: "dec-release-1" })).output as { ok: boolean; refusals: string[]; required_content_missing: Record<string, string[]>; frozen_uncovered: string[] };
  assert.equal(refused.ok, false); assert.deepEqual(refused.required_content_missing, { [n1.id]: ["transferee_tollfree"] });
  assert.ok(refused.refusals.includes(`${n1.id}: missing transferee_tollfree`), refused.refusals.join(" | ")); assert.ok(refused.refusals.some((x) => x === `${n1.id} is held by the Notice Registry checklist and cannot be mailed`));
  assert.deepEqual(refused.frozen_uncovered, ["L-1", "L-2"]);   // L-1's notice fails the content check and L-2 has none: neither frozen loan is covered
  assert.match(String(rt.escalations.opened.at(-1)!.payload.reason), /1024\.33\(b\)\(4\)\(ii\)/); assert.equal(rt.store.get("transfer_notice_runs", "run-B-out-goodbye")!.data.status, "qc_passed");
  // the toll-free number supplied → L-1's re-rendered notice passes (it supersedes the held one on the run); L-2, on the frozen list, still has no notice → refused for the frozen list alone
  clock.set("2026-11-10T16:00:00.000Z"); const n1b = await renderFor("L-1", "P-1", complete); assert.equal(n1b.status, "rendered");
  await run("runContentChecklist", TRANSFER, { notice_id: n1b.id, run_id: "run-B-out-goodbye" }); await run("validateAddress", TRANSFER, { notice_id: n1b.id, loan_id: "L-1" });
  const partial = (await run("releaseToVendor", TRANSFER, { run_id: "run-B-out-goodbye", officer_approval_decision_id: "dec-release-1" })).output as { ok: boolean; refusals: string[]; frozen_uncovered: string[] };
  assert.equal(partial.ok, false); assert.deepEqual(partial.frozen_uncovered, ["L-2"]); assert.deepEqual(partial.refusals, ["frozen list: no checked, address-validated notice on the run for L-2 (notice.mailed must cover every loan on the frozen list)"]);
  const n2 = await renderFor("L-2", "P-2", { ...complete, account_last4: "5678" }); assert.equal(n2.status, "rendered");
  await run("runContentChecklist", TRANSFER, { notice_id: n2.id, run_id: "run-B-out-goodbye" });
  assert.deepEqual(((await run("releaseToVendor", TRANSFER, { run_id: "run-B-out-goodbye", officer_approval_decision_id: "dec-release-1" })).output as { refusals: string[] }).refusals, [`${n2.id}: address not validated`, "frozen list: no checked, address-validated notice on the run for L-2 (notice.mailed must cover every loan on the frozen list)"], "L-2's notice is checked but its address is not validated yet");
  await run("validateAddress", TRANSFER, { notice_id: n2.id, loan_id: "L-2" });
  const released = (await run("releaseToVendor", TRANSFER, { run_id: "run-B-out-goodbye", officer_approval_decision_id: "dec-release-1" })).output as { ok: boolean; released_status: string | null; frozen_uncovered: string[]; facts: { frozen_loan_count: number } };
  assert.equal(released.ok, true); assert.equal(released.released_status, "released_to_vendor"); assert.deepEqual(released.frozen_uncovered, []); assert.equal(released.facts.frozen_loan_count, 2);
  const row = rt.store.get("transfer_notice_runs", "run-B-out-goodbye")!.data; assert.equal(row.status, "released_to_vendor"); assert.equal(row.released_notice_count, 2); assert.deepEqual(row.loan_ids, ["L-1", "L-2"]); assert.equal(row.frozen_list_version, 2);
  assert.equal(events.ofType("transfer_notice_run.released").length, 1); assert.equal(events.ofType("transfer_notice_run.released")[0]!.payload.loan_count, 2);
  // an agent-written "decision" is not an officer authorization
  await run("writeDecision", TRANSFER, { id: "dec-agent", action: "release_to_vendor", run_id: "run-B-out-goodbye", rationale: "self-approval" });
  rt.store.put("transfer_notice_runs", "run-B-out-goodbye", { status: "qc_passed" }, SYSTEM, clock.now());
  const self = (await run("releaseToVendor", TRANSFER, { run_id: "run-B-out-goodbye", officer_approval_decision_id: "dec-agent" })).output as { ok: boolean; refusals: string[] };
  assert.equal(self.ok, false); assert.ok(self.refusals.some((x) => /not written by an officer \(agent:transfer\)/.test(x)));
});
test("17.2-T4: Given a check received Dec 14, 2026 on a loan due Dec 1 (grace 15), then `protected=true`, the forwarding file of Dec 15 carries receipt date Dec 14, and `SM_1024_33C2_FORWARD_PROMPT_1` is satisfied.", () => {
  const l = live("2026-12-14T15:00:00.000Z");
  const input = { payment_id: "P-1", loan_id: "L-1", received_on: D("2026-12-14"), due_date: D("2026-12-01"), grace_days: 15, respa_effective_date: D("2026-12-01"), amount_cents: 161_603n, instrument: "check" as const, forwardable: true, transferee: TRANSFEREE };
  const { classification: r, receipt_event } = receiveMisdirectedPayment(l.events, input, CASHIERING);
  assert.equal(r.protected, true); assert.equal(r.credited_as_of, "2026-12-14"); assert.equal(r.day_of_window, 14); assert.equal(r.window_end, "2027-01-29");
  assert.equal(r.forward_by, "2026-12-15"); assert.equal(r.forwarding_file_on, "2026-12-15"); assert.equal(r.receipt_date_in_file, "2026-12-14"); assert.equal(r.business_days_since_receipt, 1); assert.equal(r.prompt, true);
  assert.equal(receipt_event.type, "payment.received"); assert.deepEqual(receipt_event.payload.loan, { status: "transferred_out" }); assert.equal(receipt_event.payload.received_at, "2026-12-14");
  // the receipt arms the +1 servicer-business-day "promptly" clock on the loan, anchored on `received_at`
  const timer = l.engine.byCode("SM_1024_33C2_FORWARD_PROMPT_1")[0]!;
  assert.equal(timer.status, "armed"); assert.equal(timer.anchorDate, "2026-12-14"); assert.equal(timer.dueDate, "2026-12-15"); assert.equal(timer.loanId, "L-1");
  // money: clearing sub-account, never the transferred loan's ledger
  assert.deepEqual(r.ledger.on_receipt.map((x) => [x.account, x.side, x.amount_cents]), [["custodial_pi_cash:transfer_out_clearing", "debit", 161_603n], ["due_to_transferee", "credit", 161_603n]]);
  assert.equal(r.posted_to_loan_ledger, false); assert.ok(l.events.ofType("payment.misdirected.received").length === 1);
  // the Dec 15 forwarding file carries the Dec 14 receipt date so the transferee posts as of Dec 14 without a late charge
  const file = forwardingFile("B-out", D("2026-12-15"), [{ payment_id: "P-1", loan_id: "L-1", borrower: "A. Borrower", received_on: r.credited_as_of, amount_cents: 161_603n, instrument: "check", image_reference: "img-1", protected: r.protected, forwarding_file_on: r.forwarding_file_on }]);
  assert.equal(file.file_date, "2026-12-15"); assert.equal(file.rows.length, 1); assert.equal(file.rows[0]!.receipt_date, "2026-12-14"); assert.equal(file.rows[0]!.protected, true); assert.equal(file.wire_total_cents, 161_603n);
  assert.equal(forwardingFile("B-out", D("2026-12-16"), [{ payment_id: "P-1", loan_id: "L-1", borrower: "A. Borrower", received_on: r.credited_as_of, amount_cents: 161_603n, instrument: "check", image_reference: null, protected: true, forwarding_file_on: r.forwarding_file_on }]).rows.length, 0);
  // wired with the Dec 15 file → `misdirected_payment.forwarded` satisfies the clock
  l.clock.set("2026-12-15T15:00:00.000Z");
  const disposed = disposeMisdirectedPayment(l.events, r, { loan_id: "L-1", forward_reference: file.file_id }, CASHIERING);
  assert.equal(disposed.type, "misdirected_payment.forwarded"); assert.equal(disposed.payload.disposition, "forwarded"); assert.equal(disposed.payload.receipt_date, "2026-12-14");
  assert.equal(timer.status, "satisfied"); assert.equal(timer.satisfiedByEventId, disposed.id); assert.equal(l.engine.evaluate("2026-12-16T12:00:00.000Z").length, 0);
  assert.deepEqual(l.events.all().filter((e) => e.type.startsWith("payment.misdirected.")).map((e) => e.type), ["payment.misdirected.received", "payment.misdirected.forwarded"]);
  // the transferee's acknowledgment of the file (SM_XFER_OUT_FORWARD_FILE_DAILY)
  const ack = recordForwardFileAck(l.events, "B-out", file.file_id, D("2026-12-15")); assert.equal(ack.type, "transferee.forward_file.acked"); assert.equal(ack.payload.file_id, "fwd-B-out-2026-12-15");
  // the pure classifier agrees
  assert.equal(misdirectedPayment(input).protected, true);
});
test("17.2-T5: Given a check received Dec 20, then `protected=false` and it is still forwarded by Dec 21.", () => {
  // Sun Dec 20 is past the Dec 16 grace date (due Dec 1 + 15) → not protected; "promptly" = next servicer business day, Mon Dec 21
  const input = { payment_id: "P-2", loan_id: "L-1", received_on: D("2026-12-20"), due_date: D("2026-12-01"), grace_days: 15, respa_effective_date: D("2026-12-01"), amount_cents: 161_603n, instrument: "check" as const, forwardable: true, transferee: TRANSFEREE };
  const r = misdirectedPayment(input);
  assert.equal(r.protected, false); assert.equal(r.day_of_window, 20); assert.equal(r.disposition, "forwarded"); assert.equal(r.forward_by, "2026-12-21"); assert.equal(r.forwarding_file_on, "2026-12-21"); assert.equal(r.receipt_date_in_file, "2026-12-20");
  assert.equal(r.business_days_since_receipt, 1); assert.equal(r.prompt, true); assert.equal(r.return_notice, null);
  // on the engine: received Sunday, due Monday; forwarded Monday → satisfied; left over Monday → breached, sev 2 → cashiering
  const l = live("2026-12-20T15:00:00.000Z"); const { classification } = receiveMisdirectedPayment(l.events, input, CASHIERING);
  const timer = l.engine.byCode("SM_1024_33C2_FORWARD_PROMPT_1")[0]!; assert.equal(timer.dueDate, "2026-12-21");
  l.clock.set("2026-12-21T15:00:00.000Z"); disposeMisdirectedPayment(l.events, classification, { loan_id: "L-1", forward_reference: "wire-1221" }, CASHIERING);
  assert.equal(timer.status, "satisfied"); assert.equal(l.engine.evaluate("2026-12-22T12:00:00.000Z").length, 0);
  const late = live("2026-12-20T15:00:00.000Z"); receiveMisdirectedPayment(late.events, input, CASHIERING);
  const breach = late.engine.evaluate("2026-12-22T12:00:00.000Z").find((b) => b.def.code === "SM_1024_33C2_FORWARD_PROMPT_1")!;
  assert.equal(breach.severity, 2); assert.ok(breach.escalateTo.includes("cashiering"));
  // forwarded two business days after receipt is not "promptly"
  assert.equal(misdirectedPayment({ ...input, disposed_on: D("2026-12-22") }).prompt, false);
  // day 61 (Sat Jan 30, 2027): forwarded, not protected, by Mon Feb 1
  const d61 = misdirectedPayment({ ...input, received_on: D("2027-01-30"), due_date: D("2027-01-01") });
  assert.equal(d61.day_of_window, 61); assert.equal(d61.protected, false); assert.equal(d61.disposition, "forwarded"); assert.equal(d61.forward_by, "2027-02-01");
});
test("17.2-T6: Given a payment returned to the payor, then `NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN` exists naming the transferee.", () => {
  const input = { payment_id: "P-9", loan_id: "L-1", received_on: D("2026-12-14"), due_date: D("2026-12-01"), grace_days: 15, respa_effective_date: D("2026-12-01"), amount_cents: 161_603n, instrument: "check" as const, transferee: TRANSFEREE };
  const decision = { id: "dec-17.2-return-P-9", by: OFFICER };
  const r = misdirectedPayment({ ...input, forwardable: false, forward_block_reason: "the check is stale-dated and cannot be negotiated or forwarded", officer_decision: decision, disposed_on: D("2026-12-15") });
  assert.equal(r.disposition, "returned_to_payor"); assert.equal(r.forwarding_file_on, null); assert.equal(r.satisfies, "misdirected_payment.returned"); assert.equal(r.block, null);
  assert.equal(r.return_notice!.template, "NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN"); assert.equal(r.return_notice!.payload.transferee_name, "Newco Servicing LLC");
  assert.equal(r.return_notice!.payload.received_on, "2026-12-14"); assert.equal(r.return_notice!.payload.protected, true); assert.equal(r.return_notice!.payload.officer_approval_decision_id, "dec-17.2-return-P-9"); assert.equal(r.return_notice!.payload.business_days_since_receipt, 1);
  assert.equal(r.escalation!.kind, "officer"); assert.deepEqual(r.events, ["payment.misdirected.received", "payment.misdirected.returned"]); assert.equal(r.posted_to_loan_ledger, false);
  // the registry row exists, renders naming the transferee as the proper recipient (§1024.33(c)(2)(ii)) and passes its checklist
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN", D("2026-12-15"))!;
  const payload = { ...v.samplePayload, ...r.return_notice!.payload }; const out = render(v.source, payload);
  assert.match(out.text, /The proper recipient of your payment is Newco Servicing LLC\. Send your payment to Newco Servicing LLC at PO Box 500, Newtown PA 19001/);
  assert.match(out.text, /received your check of \$1,616\.03/); assert.match(out.text, /may not be treated by Newco Servicing LLC as late for any purpose, and no late fee may be imposed/);
  assert.equal(evaluateChecklist(v, payload, out).passed, true);
  const anonymous = { ...payload, transferee_name: "" }; const c = evaluateChecklist(v, anonymous, render(v.source, anonymous));
  assert.equal(c.passed, false); assert.ok(c.blocking.some((b) => b.rule_id === "c2-proper-recipient")); assert.ok(c.blocking.some((b) => b.rule_id === "transferee-named"));
  assert.equal(reg.template("NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN").channelPolicy, "mail_only"); assert.equal(reg.template("NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN").ownerSection, "17.2");
  // the checklist's timeliness and officer-decision rules bite on real values: returned Dec 17 (3 business days) fails `promptly`; no officer decision fails `officer-decision`
  const slow = misdirectedPayment({ ...input, forwardable: false, officer_decision: decision, disposed_on: D("2026-12-17") });
  assert.equal(slow.return_notice!.payload.business_days_since_receipt, 3); assert.ok(evaluateChecklist(v, { ...v.samplePayload, ...slow.return_notice!.payload }, render(v.source, { ...v.samplePayload, ...slow.return_notice!.payload })).blocking.some((b) => b.rule_id === "promptly"));
  const noDecision = misdirectedPayment({ ...input, forwardable: false }); assert.match(noDecision.block!, /officer decision/); assert.equal(noDecision.return_notice!.payload.officer_approval_decision_id, null);
  assert.ok(evaluateChecklist(v, { ...v.samplePayload, ...noDecision.return_notice!.payload }, render(v.source, { ...v.samplePayload, ...noDecision.return_notice!.payload })).blocking.some((b) => b.rule_id === "officer-decision"));
  const analystDecision = misdirectedPayment({ ...input, forwardable: false, officer_decision: { id: "dec-x", by: { kind: "human", id: "u-analyst", role: "ops_analyst" } } }); assert.match(analystDecision.block!, /officer/);
  // on the engine: the return with its notice satisfies the forward-or-return clock; a return without the notice, or without the decision, is refused
  const l = live("2026-12-14T15:00:00.000Z"); const { classification } = receiveMisdirectedPayment(l.events, { ...input, forwardable: false, forward_block_reason: "stale-dated", officer_decision: decision }, CASHIERING);
  const timer = l.engine.byCode("SM_1024_33C2_FORWARD_PROMPT_1")[0]!; l.clock.set("2026-12-15T15:00:00.000Z");
  assert.throws(() => disposeMisdirectedPayment(l.events, classification, { loan_id: "L-1" }, CASHIERING), (e: unknown) => e instanceof RangeError && /notice id/.test((e as Error).message));
  assert.throws(() => disposeMisdirectedPayment(l.events, noDecision, { loan_id: "L-1", return_notice_id: "ntc-1" }, CASHIERING), (e: unknown) => e instanceof RangeError && /officer decision/.test((e as Error).message));
  const returned = disposeMisdirectedPayment(l.events, classification, { loan_id: "L-1", return_notice_id: "ntc-1" }, CASHIERING);
  assert.equal(returned.type, "misdirected_payment.returned"); assert.equal(returned.payload.disposition, "returned_to_payor"); assert.equal(returned.payload.return_notice_id, "ntc-1"); assert.equal(timer.status, "satisfied");
  // forwarding is the default disposition
  const f = misdirectedPayment({ ...input, forwardable: true }); assert.equal(f.disposition, "forwarded"); assert.equal(f.return_notice, null); assert.equal(f.escalation, null);
});
test("17.2-T7: Given an escrowed loan transferred Dec 1, 2026, when the short-year statement is mailed Jan 29, 2027, then `REGX_1024_17I4_TRANSFEROR_SHORT_YEAR_60` is satisfied; Feb 1 → breached.", () => {
  const s = shortYearStatement(D("2026-12-01"), D("2026-05-31"), true);
  assert.deepEqual([s.covers_from, s.covers_through, s.due, s.mailed_by, s.escrow_interest_through], ["2026-06-01", "2026-11-30", "2027-01-30", "2027-01-29", "2026-11-30"]);
  const arm = () => {
    const l = live("2026-12-01T15:00:00.000Z", ["1.3", "1.6", "17.2"]);
    l.events.append({ type: "transfer.batch.cutover_completed", aggregate: BATCH, actor: SYSTEM, payload: { batch_id: "B-out", transfer_date: "2026-12-01", respa_effective_date: "2026-12-01", escrowed_count: 1 } });
    const timer = l.engine.byCode("REGX_1024_17I4_TRANSFEROR_SHORT_YEAR_60")[0]!; assert.equal(timer.status, "armed"); assert.equal(timer.dueDate, "2027-01-30"); assert.deepEqual(timer.subject, BATCH);
    const run = planShortYearRun({ batch_id: "B-out", respa_effective_date: D("2026-12-01"), loans: [{ loan_id: "L-1", escrowed: true, last_annual_statement_on: D("2026-05-31"), interest_on_escrow_state: true }, { loan_id: "L-2", escrowed: false, last_annual_statement_on: D("2026-05-31"), interest_on_escrow_state: false }] });
    assert.equal(run.loans.length, 1); assert.deepEqual(run.skipped_not_escrowed, ["L-2"]); assert.equal(run.template, "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR"); assert.equal(run.due, "2027-01-30"); assert.equal(run.mailed_by, "2027-01-29");
    assert.deepEqual([run.loans[0]!.covers_from, run.loans[0]!.covers_through, run.loans[0]!.escrow_interest_through], ["2026-06-01", "2026-11-30", "2026-11-30"]);
    return { ...l, timer, run };
  };
  // mailed Fri Jan 29, 2027 (the last vendor day before the Saturday deadline) → satisfied
  const a = arm(); a.clock.set("2027-01-29T20:00:00.000Z");
  const m = shortYearRunMailed(a.events, a.run, [{ loan_id: "L-1", proof_of_mailing_id: "pom-sy-1", mailed_on: D("2027-01-29") }]);
  assert.equal(m.every_loan, true); assert.equal(m.run_event!.payload.template, "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR"); assert.equal(a.run.status, "mailed");
  assert.equal(a.timer.status, "satisfied"); assert.equal(a.timer.satisfiedByEventId, m.run_event!.id); assert.equal(a.engine.evaluate("2027-02-01T12:00:00.000Z").filter((x) => x.def.code === "REGX_1024_17I4_TRANSFEROR_SHORT_YEAR_60").length, 0);
  assert.equal(a.events.ofType("notice.escrow.short_year.sent").length, 1); assert.equal(a.events.ofType("notice.mailed").filter((e) => e.loanId === "L-1").length, 1);
  // mailed Mon Feb 1: day 62 — breached at the Jan 30 deadline, then satisfied_late
  const b = arm();
  const breach = b.engine.evaluate("2027-02-01T12:00:00.000Z").find((x) => x.def.code === "REGX_1024_17I4_TRANSFEROR_SHORT_YEAR_60")!;
  assert.ok(breach); assert.equal(b.timer.status, "breached"); assert.equal(breach.instance.dueDate, "2027-01-30");
  b.clock.set("2027-02-01T20:00:00.000Z"); shortYearRunMailed(b.events, b.run, [{ loan_id: "L-1", proof_of_mailing_id: "pom-sy-1", mailed_on: D("2027-02-01") }]);
  assert.equal(b.timer.status, "satisfied_late");
  // no interest-on-escrow state → no accrued-interest line
  assert.equal(shortYearStatement(D("2026-12-01"), D("2026-05-31"), false).escrow_interest_through, null);
});
test("17.2-T8: Given a scheduled ACH debit with settlement date Dec 1, then it is cancelled by Nov 25 (T-3 BD) and no debit settles on/after T.", () => {
  const debits = [{ id: "d-nov", loan_id: "L-1", settlement_date: D("2026-11-02"), amount_cents: 161_603n }, { id: "d-dec", loan_id: "L-1", settlement_date: D("2026-12-01"), amount_cents: 161_603n }, { id: "d-jan", loan_id: "L-2", settlement_date: D("2027-01-04"), amount_cents: 98_000n }];
  const plan = autodraftStop(D("2026-12-01"), debits);
  // T−3 servicer business days from Tue Dec 1: Mon Nov 30, Fri Nov 27, Wed Nov 25 (Thu Nov 26 is Thanksgiving)
  assert.equal(plan.cancel_by, "2026-11-25"); assert.deepEqual(plan.cancel, ["d-dec", "d-jan"]); assert.deepEqual(plan.keep, ["d-nov"]); assert.equal(plan.last_supermortgage_debit, "2026-11-02"); assert.deepEqual(plan.settled_on_or_after_t, []);
  // on the engine: the approval arms SM_XFER_OUT_AUTODRAFT_STOP_T0 at T; the cancellation on Nov 25 for every drafted loan satisfies it
  const l = live("2026-10-20T15:00:00.000Z"); approveOut(l.events, "2026-12-01", "2026-12-01");
  const timer = l.engine.byCode("SM_XFER_OUT_AUTODRAFT_STOP_T0")[0]!; assert.equal(timer.status, "armed"); assert.equal(timer.dueDate, "2026-12-01");
  l.clock.set("2026-11-25T15:00:00.000Z");
  const s = stopAutodrafts(l.events, "B-out", D("2026-12-01"), debits, D("2026-11-25"), CASHIERING);
  assert.equal(s.late, false); assert.equal(s.loan_events.length, 2); assert.deepEqual(s.loan_events.map((e) => e.loanId), ["L-1", "L-2"]); assert.equal(s.batch_event.payload.every_loan, true); assert.deepEqual(s.batch_event.payload.cancelled, ["d-dec", "d-jan"]);
  assert.equal(timer.status, "satisfied"); assert.equal(timer.satisfiedByEventId, s.batch_event.id); assert.deepEqual(s.refund_events, []); assert.equal(l.engine.evaluate("2026-12-02T12:00:00.000Z").filter((x) => x.def.code === "SM_XFER_OUT_AUTODRAFT_STOP_T0").length, 0);
  // no debit settles on/after T: every cancelled debit has no settlement, so nothing is owed back
  assert.equal(debits.filter((d) => d.settlement_date >= D("2026-12-01")).every((d) => plan.cancel.includes(d.id)), true);
  // the missed-Nacha-window edge case: a debit that still settles on T is refunded within 1 business day (Wed Dec 2), reported in the forwarding file, QA finding
  const missed = autodraftStop(D("2026-12-01"), [{ id: "d-dec", loan_id: "L-1", settlement_date: D("2026-12-01"), settled_on: D("2026-12-01"), amount_cents: 161_603n }]);
  assert.deepEqual(missed.settled_on_or_after_t, [{ id: "d-dec", loan_id: "L-1", settled_on: "2026-12-01", amount_cents: 161_603n, refund_by: "2026-12-02", report_in_forwarding_file: true, qa_finding: true }]);
  assert.deepEqual(postTransferDebitRefund(D("2026-12-01")), { refund_by: "2026-12-02", report_in_forwarding_file: true, qa_finding: true });
  const m = live("2026-12-01T15:00:00.000Z"); const late = stopAutodrafts(m.events, "B-out", D("2026-12-01"), [{ id: "d-dec", loan_id: "L-1", settlement_date: D("2026-12-01"), settled_on: D("2026-12-01"), amount_cents: 161_603n }], D("2026-12-01"), CASHIERING);
  assert.equal(late.late, true); assert.equal(late.refund_events.length, 1); assert.equal(late.refund_events[0]!.type, "autodraft.debit.refund_due"); assert.equal(late.refund_events[0]!.payload.refund_by, "2026-12-02");
  const file = forwardingFile("B-out", D("2026-12-02"), [], [{ debit_id: "d-dec", loan_id: "L-1", settled_on: D("2026-12-01"), amount_cents: 161_603n, refund_by: D("2026-12-02") }]);
  assert.equal(file.refunds.length, 1); assert.equal(file.refunds[0]!.refund_by, "2026-12-02");
});
test("17.2-T9: Given a `master_change_sub_retained` batch, then no goodbye run exists and the exclusion record is present.", async () => {
  const same = { payee: true, address: true, account: true, amount: true };
  const mc = { batch_id: "B-mc", type: "master_change_sub_retained" as const, transfer_date: D("2026-12-01"), installments_due_on_1st: true, notice_mode: "separate" as const, unchanged: same };
  const r = planGoodbyeRun({ ...mc, officer: OFFICER });
  assert.equal(r.run, null); assert.equal(r.block, null);
  assert.deepEqual(r.exclusion_record, { batch_id: "B-mc", basis: "§1024.33(b)(2)(i)(C): master servicer change, subservicer retained, nothing borrower-facing changes", approved_by: "u-officer", rule: "§1024.33(b)(2)" });
  // the exclusion is an officer record, never silence
  const noOfficer = planGoodbyeRun({ ...mc, officer: null }); assert.equal(noOfficer.run, null); assert.equal(noOfficer.exclusion_record, null); assert.match(noOfficer.block!, /officer sign-off/);
  // a master change that moves the payment address, or a sale with a payee change, gets a goodbye run on the −15 clock
  const moved = planGoodbyeRun({ ...mc, unchanged: { ...same, address: false }, officer: OFFICER }); assert.equal(moved.exclusion_record, null); assert.equal(moved.run!.kind, "goodbye");
  const sale = planGoodbyeRun({ ...mc, batch_id: "B-sale", type: "servicing_sale", unchanged: { ...same, payee: false }, officer: null });
  assert.deepEqual(sale.run, { batch_id: "B-sale", kind: "goodbye", status: "planned", template: "NTC_REGX_1024_33B_GOODBYE_MS2", respa_effective_date: "2026-12-01", due: "2026-11-16", scheduled_on: "2026-11-16", deadline_rule: "§1024.33(b)(3)(i) −15", timer: "REGX_1024_33B3_GOODBYE_15" });
  assert.equal(planGoodbyeRun({ ...mc, batch_id: "B-comb", type: "sub_to_sub", notice_mode: "combined", officer: null }).run!.timer, "REGX_1024_33B3_COMBINED_15");
  // the (b)(3)(ii) 30-day exception: only a fnma_directed for-cause termination, and only with the officer's confirmation of the basis
  const exc = { ...mc, batch_id: "B-fc", type: "fnma_directed" as const, unchanged: { ...same, payee: false }, officer: null, exception_basis: "termination_for_cause" as const };
  assert.match(planGoodbyeRun(exc).block!, /officer confirmation/);
  const relied = planGoodbyeRun({ ...exc, exception_confirmed_by: OFFICER }); assert.equal(relied.run!.timer, "REGX_1024_33B3_EXCEPTION_30"); assert.equal(relied.run!.due, "2026-12-31"); assert.equal(relied.run!.deadline_rule, "§1024.33(b)(3)(ii) +30");
  assert.match(planGoodbyeRun({ ...exc, type: "sub_to_sub", exception_confirmed_by: OFFICER }).block!, /only Section 17 case is a fnma_directed for-cause termination/);
  assert.match(planGoodbyeRun({ ...exc, exception_basis: "bankruptcy", exception_confirmed_by: OFFICER }).block!, /only Section 17 case/);

  // ---- through the bus: the exclusion and the exception are officer records on file (writeDecision by the officer, naming the batch), never an actor the agent names
  const b = bus("2026-10-20T15:00:00.000Z"); const { events, engine, rt, run, refusedWith } = b;
  const mcIn = { batch_id: "B-mc", type: "master_change_sub_retained", transfer_date: "2026-12-01", installments_due_on_1st: true, unchanged: same };
  // an actor object on the input is refused outright — including an "officer" whose id is the agent's own
  await refusedWith(run("planNoticeRun", TRANSFER, { ...mcIn, officer: { kind: "human", id: "transfer", role: "officer" } }), "OFFICER_IS_NOT_AN_INPUT");
  await refusedWith(run("planNoticeRun", TRANSFER, mcIn), "EXCLUSION_NEEDS_OFFICER");
  // a decision id that is not on file, one the agent wrote itself, or one naming another batch authorizes nothing: no exclusion record, officer escalation
  const notOnFile = (await run("planNoticeRun", TRANSFER, { ...mcIn, exclusion_decision_id: "dec-forged" })).output as { run: unknown; exclusion_record: unknown; block: string; officer_decision_problems: string[] };
  assert.equal(notOnFile.run, null); assert.equal(notOnFile.exclusion_record, null); assert.match(notOnFile.block, /officer sign-off/); assert.match(notOnFile.officer_decision_problems[0]!, /decision dec-forged is not on file/);
  assert.equal(rt.store.get("transfer_notice_exclusions", "excl-B-mc"), undefined); assert.equal(rt.escalations.opened.at(-1)!.kind, "officer"); assert.equal(events.ofType("transfer.notice.excluded").length, 0);
  await run("writeDecision", TRANSFER, { id: "dec-self", action: "exclusion_b2", batch_id: "B-mc", rationale: "self-approval" });
  const selfWritten = (await run("planNoticeRun", TRANSFER, { ...mcIn, exclusion_decision_id: "dec-self" })).output as { exclusion_record: unknown; officer_decision_problems: string[] };
  assert.equal(selfWritten.exclusion_record, null); assert.match(selfWritten.officer_decision_problems[0]!, /not written by an officer \(agent:transfer\)/);
  await run("writeDecision", OFFICER, { id: "dec-excl-1", action: "exclusion_1024_33_b2", batch_id: "B-mc", rationale: "no change in payee, address, account or amount verified" });
  const otherBatch = (await run("planNoticeRun", TRANSFER, { ...mcIn, batch_id: "B-mc2", exclusion_decision_id: "dec-excl-1" })).output as { exclusion_record: unknown; officer_decision_problems: string[] };
  assert.equal(otherBatch.exclusion_record, null); assert.match(otherBatch.officer_decision_problems[0]!, /does not name batch B-mc2/);
  await run("writeDecision", OFFICER, { id: "dec-release-x", action: "release_to_vendor", batch_id: "B-mc", rationale: "wrong action" });
  assert.match(((await run("planNoticeRun", TRANSFER, { ...mcIn, exclusion_decision_id: "dec-release-x" })).output as { officer_decision_problems: string[] }).officer_decision_problems[0]!, /not a \(b\)\(2\) exclusion authorization/);
  // the officer's own decision row naming the batch → the exclusion record names the officer who wrote it (the store's updatedBy), stored and evented; no goodbye run exists
  const excluded = (await run("planNoticeRun", TRANSFER, { ...mcIn, exclusion_decision_id: "dec-excl-1" })).output as { run: unknown; exclusion_record: { approved_by: string; rule: string }; officer_decision_problems: string[] };
  assert.equal(excluded.run, null); assert.equal(excluded.exclusion_record.approved_by, "u-officer"); assert.equal(excluded.exclusion_record.rule, "§1024.33(b)(2)"); assert.deepEqual(excluded.officer_decision_problems, []);
  assert.equal(rt.store.get("transfer_notice_exclusions", "excl-B-mc")!.data.approved_by, "u-officer"); assert.equal(rt.store.get("transfer_notice_exclusions", "excl-B-mc")!.data.decision_id, "dec-excl-1");
  assert.equal(events.ofType("transfer.notice.excluded").at(-1)!.payload.decision_id, "dec-excl-1"); assert.equal(rt.store.get("transfer_notice_runs", "run-B-mc-goodbye"), undefined);
  // the officer calling directly is the officer
  assert.equal(((await run("planNoticeRun", OFFICER, { ...mcIn, batch_id: "B-mc3" })).output as { exclusion_record: { approved_by: string } }).exclusion_record.approved_by, "u-officer");
  // ---- (b)(3)(ii) on the live engine: the unconditional approval arms the −15 clock next to the +30; relying on the exception (the officer's decision on file) cancels the −15 clock and its T−20 milestone with reason exception_b3ii and keeps the +30
  events.append({ type: "transfer.batch.approved", aggregate: { kind: "transfer_batch", id: "B-fc" }, actor: SYSTEM, payload: { direction: "out", batch_id: "B-fc", type: "fnma_directed", exception_basis: "termination_for_cause", transfer_date: "2026-12-01", respa_effective_date: "2026-12-01", notice_mode: "separate" } });
  const on = (code: string) => engine.byCode(code).find((t) => t.subject.id === "B-fc")!;
  const goodbye = on("REGX_1024_33B3_GOODBYE_15"), exc30 = on("REGX_1024_33B3_EXCEPTION_30"), t20 = on("SM_XFER_OUT_TRANSFEREE_NOTICE_DATA_T20");
  assert.equal(goodbye.dueDate, "2026-11-16"); assert.equal(exc30.dueDate, "2026-12-31"); assert.equal(t20.dueDate, "2026-11-11");
  const fcIn = { batch_id: "B-fc", type: "fnma_directed", transfer_date: "2026-12-01", installments_due_on_1st: true, unchanged: { ...same, payee: false }, exception_basis: "termination_for_cause" };
  await refusedWith(run("planNoticeRun", TRANSFER, { ...fcIn, exception_confirmed_by: { kind: "human", id: "transfer", role: "officer" } }), "OFFICER_IS_NOT_AN_INPUT");
  await refusedWith(run("planNoticeRun", TRANSFER, fcIn), "EXCEPTION_30_NEEDS_OFFICER");
  await refusedWith(run("planNoticeRun", TRANSFER, { ...fcIn, type: "sub_to_sub", exception_decision_id: "dec-any" }), "EXCEPTION_30_FNMA_DIRECTED_ONLY");
  const unconfirmed = (await run("planNoticeRun", TRANSFER, { ...fcIn, exception_decision_id: "dec-forged" })).output as { run: unknown; block: string; timers_cancelled: unknown[] };
  assert.equal(unconfirmed.run, null); assert.match(unconfirmed.block, /officer confirmation/); assert.deepEqual(unconfirmed.timers_cancelled, []); assert.equal(goodbye.status, "armed");
  assert.throws(() => relyOnExceptionB3ii(engine, events, { batch_id: "B-fc", basis: "termination_for_cause", confirmed_by: TRANSFER }, TRANSFER), RangeError); assert.equal(goodbye.status, "armed");
  await run("writeDecision", OFFICER, { id: "dec-exc-1", action: "exception_1024_33_b3ii_termination_for_cause", batch_id: "B-fc", rationale: "Fannie Mae for-cause termination notice on file; basis confirmed" });
  const reliedRun = (await run("planNoticeRun", TRANSFER, { ...fcIn, exception_decision_id: "dec-exc-1" })).output as { run: { timer: string; due: string; deadline_rule: string }; timers_cancelled: { code: string; reason: string }[] };
  assert.equal(reliedRun.run.timer, "REGX_1024_33B3_EXCEPTION_30"); assert.equal(reliedRun.run.due, "2026-12-31"); assert.equal(reliedRun.run.deadline_rule, "§1024.33(b)(3)(ii) +30");
  assert.deepEqual(reliedRun.timers_cancelled.map((c) => c.code).sort(), ["REGX_1024_33B3_GOODBYE_15", "SM_XFER_OUT_TRANSFEREE_NOTICE_DATA_T20"]); assert.ok(reliedRun.timers_cancelled.every((c) => c.reason === "exception_b3ii"));
  assert.equal(goodbye.status, "cancelled"); assert.equal(goodbye.cancelledReason, "exception_b3ii"); assert.equal(t20.status, "cancelled"); assert.equal(exc30.status, "armed");
  assert.equal(events.ofType("transfer.notice.exception_relied").at(-1)!.payload.decision_id, "dec-exc-1"); assert.equal(events.ofType("transfer.notice.exception_relied").at(-1)!.payload.confirmed_by, "u-officer");
  assert.ok(events.ofType("timer.cancelled").some((e) => e.payload.code === "REGX_1024_33B3_GOODBYE_15" && e.payload.reason === "exception_b3ii"));
  const superseded: readonly string[] = EXCEPTION_B3II_SUPERSEDED_TIMERS;
  assert.equal(engine.evaluate("2026-11-17T12:00:00.000Z").filter((x) => x.instance.subject.id === "B-fc" && superseded.includes(x.def.code)).length, 0, "no −15 breach on T−14 when (b)(3)(ii) applies");
  assert.equal(engine.evaluate("2027-01-01T12:00:00.000Z").find((x) => x.def.code === "REGX_1024_33B3_EXCEPTION_30")!.severity, 1);
});
test("17.2-T10: Given the transfer is cancelled Nov 20 after mailing, then a corrective notice is mailed by Nov 27 and the goodbye timer is cancelled with reason `transfer_cancelled`.", () => {
  const l = live("2026-10-20T15:00:00.000Z"); approveOut(l.events, "2026-12-01", "2026-12-01");
  const goodbye = l.engine.byCode("REGX_1024_33B3_GOODBYE_15")[0]!; assert.equal(goodbye.status, "armed"); assert.equal(goodbye.dueDate, "2026-11-16");
  l.clock.set("2026-11-20T15:00:00.000Z");   // goodbye run mailed Nov 16; the transfer is cancelled Fri Nov 20
  const r = cancelTransferOut(l.engine, l.events, { batch_id: "B-out", cancelled_on: D("2026-11-20"), goodbye_mailed_on: D("2026-11-16"), original_effective_date: D("2026-12-01") }, OFFICER);
  assert.equal(goodbye.status, "cancelled"); assert.equal(goodbye.cancelledReason, "transfer_cancelled");
  assert.ok(r.cancelled.some((c) => c.code === "REGX_1024_33B3_GOODBYE_15" && c.reason === "transfer_cancelled"));
  assert.ok(l.events.ofType("timer.cancelled").some((e) => e.payload.code === "REGX_1024_33B3_GOODBYE_15" && e.payload.reason === "transfer_cancelled"));
  for (const t of l.engine.forSubject("transfer_batch", "B-out")) if ((GOODBYE_RUN_TIMERS as readonly string[]).includes(t.code)) assert.equal(t.status, "cancelled", t.code);
  assert.equal(r.corrective.required, true); assert.equal(r.corrective.template, "NTC_REGX_1024_33B_CORRECTIVE"); assert.equal(r.corrective.escalation.kind, "officer");
  // Nov 20 is before the T−3 BD draft cancellation (Nov 25): the drafts are still in place and the notice says so
  assert.equal(r.corrective.ach_cancel_by, "2026-11-25"); assert.equal(r.corrective.drafts_cancelled, false);
  // +5 servicer business days from Fri Nov 20 skips Thanksgiving (Thu Nov 26): Mon Nov 30 — the spec's "Nov 27" counted Thanksgiving as a business day
  assert.equal(r.corrective.corrective_due, "2026-11-30");
  const corr = l.engine.byCode("SM_XFER_OUT_CORRECTIVE_NOTICE_5")[0]!; assert.equal(corr.status, "armed"); assert.equal(corr.dueDate, r.corrective.corrective_due); assert.equal(corr.armedByEventId, r.cancellation_event_id);
  // mailing the corrective notice satisfies the timer
  l.clock.set("2026-11-30T15:00:00.000Z");
  l.events.append({ type: "notice.mailed", aggregate: BATCH, actor: SYSTEM, payload: { template: "NTC_REGX_1024_33B_CORRECTIVE" } });
  assert.equal(corr.status, "satisfied");
  // nothing mailed yet → no corrective notice is owed and no corrective clock is armed
  const quiet = live("2026-10-20T15:00:00.000Z"); approveOut(quiet.events, "2026-12-01", "2026-12-01"); quiet.clock.set("2026-11-10T15:00:00.000Z");
  const q = cancelTransferOut(quiet.engine, quiet.events, { batch_id: "B-out", cancelled_on: D("2026-11-10"), goodbye_mailed_on: null, original_effective_date: D("2026-12-01") }, OFFICER);
  assert.equal(q.corrective.required, false); assert.equal(quiet.engine.byCode("SM_XFER_OUT_CORRECTIVE_NOTICE_5").length, 0); assert.equal(quiet.engine.byCode("REGX_1024_33B3_GOODBYE_15")[0]!.status, "cancelled");
  // the corrective notice itself: cancellation wording, disregard instruction, payments stay with Supermortgage; the checklist refuses one mailed late
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_REGX_1024_33B_CORRECTIVE", D("2026-11-30"))!;
  const out = render(v.source, v.samplePayload); assert.match(out.text, /Please disregard that notice: the transfer has been cancelled/); assert.match(out.text, /Continue to send your payments to Supermortgage at PO Box 7/); assert.match(out.text, /automatic payment drafts you have with us continue unchanged/);
  assert.equal(evaluateChecklist(v, v.samplePayload, out).passed, true); assert.equal(reg.template("NTC_REGX_1024_33B_CORRECTIVE").channelPolicy, "mail_only");
  const late = { ...v.samplePayload, business_days_since_event: 6 }; assert.ok(evaluateChecklist(v, late, render(v.source, late)).blocking.some((b) => b.rule_id === "timely"));
  // cancelled Fri Nov 27, after the T−3 BD draft cancellation: the notice must not say the drafts continue unchanged
  const afterDrafts = correctiveNotice({ event: "transfer_cancelled", event_on: D("2026-11-27"), goodbye_mailed_on: D("2026-11-16"), original_effective_date: D("2026-12-01") });
  assert.equal(afterDrafts.drafts_cancelled, true);
  const cancelledDrafts = { ...v.samplePayload, event_date: "2026-11-27", drafts_cancelled: true }; const cd = render(v.source, cancelledDrafts);
  assert.match(cd.text, /automatic payment drafts for payments due on or after December 1, 2026 were cancelled in preparation for the transfer/); assert.doesNotMatch(cd.text, /continue unchanged/); assert.equal(evaluateChecklist(v, cancelledDrafts, cd).passed, true);
  assert.ok(evaluateChecklist(v, { ...v.samplePayload, drafts_cancelled: true }, out).blocking.some((b) => b.rule_id === "drafts-cancelled-status"), "a render that still says 'continue unchanged' fails when the drafts were cancelled");
  // a date change instead: new T = Mon Jan 4, 2027 (Jan 1 is a holiday) with installments due on the 1st → new respa_effective_date Jan 1 → new goodbye ≥15 days before: Dec 17, 2026
  const dc = live("2026-10-20T15:00:00.000Z"); approveOut(dc.events, "2026-12-01", "2026-12-01"); dc.clock.set("2026-11-20T15:00:00.000Z");
  const moved = changeTransferOutDate(dc.engine, dc.events, { batch_id: "B-out", changed_on: D("2026-11-20"), goodbye_mailed_on: D("2026-11-16"), original_effective_date: D("2026-12-01"), new_transfer_date: D("2027-01-04"), installments_due_on_1st: true }, OFFICER);
  assert.equal(moved.corrective.new_respa_effective_date, "2027-01-01"); assert.equal(moved.corrective.new_goodbye_due, "2026-12-17"); assert.deepEqual(moved.corrective.timer_cancellations.map((c) => c.reason), ["transfer_date_changed", "transfer_date_changed", "transfer_date_changed", "transfer_date_changed"]);
  assert.equal(dc.engine.byCode("REGX_1024_33B3_GOODBYE_15")[0]!.cancelledReason, "transfer_date_changed"); assert.ok(moved.cancelled.some((c) => c.code === "SM_XFER_OUT_AUTODRAFT_STOP_T0"));
  const corr2 = dc.engine.byCode("SM_XFER_OUT_CORRECTIVE_NOTICE_5")[0]!; assert.equal(corr2.status, "armed"); assert.equal(corr2.dueDate, "2026-11-30"); assert.equal(corr2.armedByEventId, moved.change_event_id);
  // the re-approval with the new dates re-issues the goodbye clock: Dec 17
  approveOut(dc.events, "2027-01-04", "2027-01-01"); assert.equal(dc.engine.byCode("REGX_1024_33B3_GOODBYE_15").at(-1)!.dueDate, "2026-12-17");
  const changed = { ...v.samplePayload, cancelled: false, date_changed: true, new_effective_date: "2027-01-01", new_goodbye_days_before_effective: 15 }; const co = render(v.source, changed);
  assert.match(co.text, /now expected to be effective January 1, 2027/); assert.match(co.text, /not less than 15 days before the new effective date/); assert.equal(evaluateChecklist(v, changed, co).passed, true);
  assert.ok(evaluateChecklist(v, { ...changed, new_goodbye_days_before_effective: 14 }, co).blocking.some((b) => b.rule_id === "new-goodbye-15"));
  assert.ok(evaluateChecklist(v, changed, { ...co, text: co.text.replace("not less than 15 days", "soon") }).blocking.some((b) => b.rule_id === "new-notice-promise"), "the promise is checked on the rendered text");
});

test("17.2 worked figures: T = Tue Dec 1, 2026 → goodbye by Mon Nov 16, 2026; window Dec 1, 2026 – Jan 29, 2027; short-year statement by Sat Jan 30, 2027 → mailed by Fri Jan 29, 2027; T = Mon Nov 2, 2026 with payments due on the 1st → respa_effective_date Sun Nov 1 → goodbye by Sat Oct 17 → run released Fri Oct 16, 2026; window Nov 1 – Dec 30, 2026; check received Dec 14 (due Dec 1, grace 15) → protected, Dec 15 forwarding file; Dec 20 → not protected, forwarded Dec 21; Jan 30, 2027 (day 61) → forwarded, not protected; ACH cancelled by Nov 25 (T−3 BD); routing days 1–90", () => {
  const dec = goodbyeTiming(D("2026-12-01"), true);
  assert.deepEqual([dec.respa_effective_date, dec.goodbye_due, dec.run_scheduled_on, dec.transferee_data_due, dec.scripts_live_by, dec.transferor_stops, dec.transferee_starts, dec.window_end], ["2026-12-01", "2026-11-16", "2026-11-16", "2026-11-11", "2026-11-16", "2026-11-30", "2026-12-01", "2027-01-29"]);
  assert.deepEqual([dec.short_year_due, dec.short_year_mailed_by, dec.ach_cancel_by, dec.support_window_end], ["2027-01-30", "2027-01-29", "2026-11-25", "2027-03-01"]);
  const nov = goodbyeTiming(D("2026-11-02"), true);
  assert.deepEqual([nov.respa_effective_date, nov.goodbye_due, nov.run_scheduled_on, nov.transferor_stops, nov.transferee_starts, nov.window_end], ["2026-11-01", "2026-10-17", "2026-10-16", "2026-10-31", "2026-11-01", "2026-12-30"]);
  assert.equal(goodbyeTiming(D("2026-11-02"), false).respa_effective_date, "2026-11-02");
  const pay = { payment_id: "P-1", loan_id: "L-1", due_date: D("2026-12-01"), grace_days: 15, respa_effective_date: D("2026-12-01"), amount_cents: 161_603n, instrument: "check" as const, forwardable: true, transferee: TRANSFEREE };
  const d14 = misdirectedPayment({ ...pay, received_on: D("2026-12-14") });
  assert.equal(d14.protected, true); assert.equal(d14.credited_as_of, "2026-12-14"); assert.equal(d14.forwarding_file_on, "2026-12-15"); assert.equal(d14.receipt_date_in_file, "2026-12-14"); assert.equal(d14.day_of_window, 14); assert.equal(d14.satisfies, "misdirected_payment.forwarded");
  assert.deepEqual(d14.ledger.on_receipt.map((l) => [l.account, l.side, l.amount_cents]), [["custodial_pi_cash:transfer_out_clearing", "debit", 161_603n], ["due_to_transferee", "credit", 161_603n]]);
  assert.deepEqual(d14.ledger.on_disposition.map((l) => [l.account, l.side, l.amount_cents]), [["due_to_transferee", "debit", 161_603n], ["custodial_pi_cash:transfer_out_clearing", "credit", 161_603n]]);
  const d20 = misdirectedPayment({ ...pay, received_on: D("2026-12-20") }); assert.equal(d20.protected, false); assert.equal(d20.disposition, "forwarded"); assert.equal(d20.forwarding_file_on, "2026-12-21");
  const d61 = misdirectedPayment({ ...pay, received_on: D("2027-01-30"), due_date: D("2027-01-01") }); assert.equal(d61.day_of_window, 61); assert.equal(d61.window_end, "2027-01-29"); assert.equal(d61.protected, false); assert.equal(d61.disposition, "forwarded"); assert.equal(d61.forward_by, "2027-02-01");
  const ach = autodraftStop(D("2026-12-01"), [{ id: "d-nov", settlement_date: D("2026-11-02") }, { id: "d-dec", settlement_date: D("2026-12-01") }, { id: "d-jan", settlement_date: D("2027-01-04") }]);
  assert.equal(ach.cancel_by, "2026-11-25"); assert.deepEqual(ach.cancel, ["d-dec", "d-jan"]); assert.deepEqual(ach.keep, ["d-nov"]); assert.equal(ach.last_supermortgage_debit, "2026-11-02"); assert.equal(ach.satisfies, "autodraft.schedule.terminated");
  assert.deepEqual(postTransferDebitRefund(D("2026-12-01")), { refund_by: "2026-12-02", report_in_forwarding_file: true, qa_finding: true });
  const sy = shortYearStatement(D("2026-12-01"), D("2026-05-31"), true);
  assert.deepEqual([sy.covers_from, sy.covers_through, sy.due, sy.mailed_by, sy.escrow_interest_through, sy.template], ["2026-06-01", "2026-11-30", "2027-01-30", "2027-01-29", "2026-11-30", "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR"]);
  assert.equal(shortYearStatement(D("2026-12-01"), D("2026-05-31"), false).escrow_interest_through, null);
  // borrower-comms routing: scripts live from T−15 (Nov 16), Supermortgage accepts payments through T−1, days 1–90 route with the transferee's details, day 91 refers only
  const w = borrowerRoutingWindow(D("2026-12-01"), D("2027-01-15")); assert.equal(w.day, 45); assert.equal(w.phase, "active"); assert.equal(w.script_version, "transfer_out.v1"); assert.equal(w.closes_on, "2027-03-01"); assert.equal(w.close_event, "transfer.support_window.closed"); assert.equal(w.outbound_allowed, false); assert.equal(w.accepts_payments, false);
  assert.deepEqual([borrowerRoutingWindow(D("2026-12-01"), D("2026-11-15")).phase, borrowerRoutingWindow(D("2026-12-01"), D("2026-11-16")).phase, borrowerRoutingWindow(D("2026-12-01"), D("2026-12-01")).phase, borrowerRoutingWindow(D("2026-12-01"), D("2027-03-01")).phase, borrowerRoutingWindow(D("2026-12-01"), D("2027-03-02")).phase], ["not_started", "pre_transfer", "pre_transfer", "active", "refer_only"]);
  assert.deepEqual([borrowerRoutingWindow(D("2026-12-01"), D("2026-11-16")).scripts_live, borrowerRoutingWindow(D("2026-12-01"), D("2026-11-30")).accepts_payments, borrowerRoutingWindow(D("2026-12-01"), D("2026-12-01")).accepts_payments, borrowerRoutingWindow(D("2026-12-01"), D("2026-12-01")).scripts_live], [true, true, false, true]);
  // the post-transfer sweeps: day 61 (Sat Jan 30, 2027) closes the 60-day protection window; day 91 (Tue Mar 2, 2027) closes the support window and the daily forwarding-file recurrence
  const l = live("2026-12-01T15:00:00.000Z");
  l.events.append({ type: "transfer.batch.cutover_completed", aggregate: BATCH, actor: SYSTEM, payload: { batch_id: "B-out", transfer_date: "2026-12-01", respa_effective_date: "2026-12-01" } });
  const protection = l.engine.byCode("REGX_1024_33C1_LATE_FEE_PROTECTION_60")[0]!, routing = l.engine.byCode("SM_XFER_OUT_BORROWER_ROUTING_90")[0]!, daily = l.engine.byCode("SM_XFER_OUT_FORWARD_FILE_DAILY")[0]!;
  // the protection window instance closes on its expiry day (day 61, Sat Jan 30 — the §1.3 section override `window [+1, +60]`); the last protected receipt date is Jan 29 (misdirectedPayment.window_end)
  assert.equal(protection.dueDate, "2027-01-30"); assert.equal(routing.dueDate, "2027-03-01"); assert.equal(daily.dueDate, "2026-12-02");
  // the daily forwarding file on the live engine: the transferee's ack of the Dec 2 file is the row's satisfying event — it satisfies the Dec 2 instance and the recurrence re-arms for Thu Dec 3; an ack of a file the platform never built is refused
  assert.throws(() => recordForwardFileAck(l.events, "B-out", "fwd-B-other-2026-12-02", D("2026-12-02")), RangeError);
  const ack1 = recordForwardFileAck(l.events, "B-out", forwardingFile("B-out", D("2026-12-02"), []).file_id, D("2026-12-02"));
  assert.equal(ack1.type, "transferee.forward_file.acked"); assert.equal(eventMatches(l.registry.get("SM_XFER_OUT_FORWARD_FILE_DAILY")!.satisfiedPattern!, ack1), true);
  assert.equal(daily.status, "satisfied"); assert.equal(daily.satisfiedByEventId, ack1.id);
  assert.ok(l.events.ofType("timer.satisfied").some((e) => e.payload.code === "SM_XFER_OUT_FORWARD_FILE_DAILY" && e.payload.timer_id === daily.id && e.payload.late === false));
  const dec3 = l.engine.byCode("SM_XFER_OUT_FORWARD_FILE_DAILY").filter((t) => t.status === "armed"); assert.equal(dec3.length, 1); assert.equal(dec3[0]!.dueDate, "2026-12-03"); assert.deepEqual(dec3[0]!.subject, BATCH); assert.equal(dec3[0]!.armedByEventId, ack1.id);
  // Dec 3's file is not acked by end of Dec 3 → sev 3 breach; the ack on Fri Dec 4 closes it satisfied_late and the recurrence re-arms for Mon Dec 7 (+1 servicer BD)
  const b3 = l.engine.evaluate("2026-12-04T12:00:00.000Z").find((x) => x.def.code === "SM_XFER_OUT_FORWARD_FILE_DAILY")!;
  assert.equal(b3.instance.id, dec3[0]!.id); assert.equal(b3.severity, 3); assert.equal(dec3[0]!.status, "breached");
  const ack2 = recordForwardFileAck(l.events, "B-out", "fwd-B-out-2026-12-03", D("2026-12-04"));
  assert.equal(dec3[0]!.status, "satisfied_late"); assert.equal(dec3[0]!.satisfiedByEventId, ack2.id);
  const dec7 = l.engine.byCode("SM_XFER_OUT_FORWARD_FILE_DAILY").filter((t) => t.status === "armed"); assert.equal(dec7.length, 1); assert.equal(dec7[0]!.dueDate, "2026-12-07");
  const batch = { batch_id: "B-out", transfer_date: D("2026-12-01"), respa_effective_date: D("2026-12-01") };
  const nothing = postTransferSweep(l.engine, l.events, batch, D("2027-01-29")); assert.equal(nothing.protection_window_expired, null); assert.equal(nothing.support_window_closed, null);
  const day61 = postTransferSweep(l.engine, l.events, batch, D("2027-01-30")); assert.equal(day61.protection_window_expired!.payload.day, 61); assert.equal(protection.status, "satisfied"); assert.equal(day61.support_window_closed, null);
  assert.equal(postTransferSweep(l.engine, l.events, batch, D("2027-01-31")).protection_window_expired, null, "emitted once");
  assert.equal(postTransferSweep(l.engine, l.events, batch, D("2027-03-01")).support_window_closed, null, "day 90 is still in the window");
  const day91 = postTransferSweep(l.engine, l.events, batch, D("2027-03-02"));
  assert.equal(day91.support_window_closed!.payload.closes_on, "2027-03-01"); assert.equal(day91.support_window_closed!.payload.day, 91);
  // the close event is the row's satisfying event; the two recurrences are closed on the engine with the reason (a recurring row satisfied on the live engine would be re-armed by its own event)
  assert.equal(eventMatches(l.registry.get("SM_XFER_OUT_BORROWER_ROUTING_90")!.satisfiedPattern!, day91.support_window_closed!), true);
  assert.deepEqual(day91.recurrences_closed.map((c) => c.code).sort(), ["SM_XFER_OUT_BORROWER_ROUTING_90", "SM_XFER_OUT_FORWARD_FILE_DAILY"]);
  assert.equal(routing.status, "cancelled"); assert.equal(routing.cancelledReason, "support_window_closed"); assert.equal(dec7[0]!.status, "cancelled"); assert.equal(dec7[0]!.cancelledReason, "support_window_closed");
  assert.equal(postTransferSweep(l.engine, l.events, batch, D("2027-03-03")).support_window_closed, null, "emitted once");
  // after the window closed an ack records the event but nothing is armed for it: the recurrence does not come back
  recordForwardFileAck(l.events, "B-out", "fwd-B-out-2027-03-02", D("2027-03-02")); assert.equal(l.engine.byCode("SM_XFER_OUT_FORWARD_FILE_DAILY").filter((t) => t.status === "armed" || t.status === "breached").length, 0);
  // skip trace on a returned goodbye notice: due +5 servicer BD; the vendor's result closes it, with the original proof of mailing preserved
  const st = live("2026-11-20T15:00:00.000Z");
  st.events.append({ type: "mail.returned", loanId: "L-1", actor: SYSTEM, payload: { notice_id: "N-1", template: "NTC_REGX_1024_33B_GOODBYE_MS2", returned_at: "2026-11-20", original_proof_of_mailing_id: "pom-1" } });
  const skip = st.engine.byCode("FNMA_A2_7_03_RETURNED_NOTICE_SKIP_TRACE_5")[0]!; assert.equal(skip.dueDate, "2026-11-30");
  assert.throws(() => completeSkipTrace(st.events, { notice_id: "N-1", loan_id: "L-1", result: "remailed", completed_on: D("2026-11-24"), original_proof_of_mailing_id: "pom-1" }), RangeError);
  const done = completeSkipTrace(st.events, { notice_id: "N-1", loan_id: "L-1", result: "remailed", new_address: "2 Forward Ln, Testville TX 75002", completed_on: D("2026-11-24"), original_proof_of_mailing_id: "pom-1" });
  assert.equal(done.payload.original_proof_of_mailing_id, "pom-1"); assert.equal(skip.status, "satisfied"); assert.equal(st.events.ofType("notice.remailed").length, 1);
});

test("17.2 final-statement gate: `statement.cycle.opened` arms SM_XFER_OUT_FINAL_STATEMENT_GATE with its evaluator, and the generator's check refuses a cycle whose due date is on/after transfer_date (7.1-T15: the last statement covers the cycle ending before T)", () => {
  const l = live("2026-11-02T15:00:00.000Z");
  l.events.append({ type: "statement.cycle.opened", loanId: "L-1", actor: SYSTEM, payload: { cycle_id: "C-2026-12", cycle_due_date: "2026-12-01", transfer_date: "2026-12-01" } });
  const gate = l.engine.byCode("SM_XFER_OUT_FINAL_STATEMENT_GATE")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:17.2.noStatementForCyclesOnOrAfterTransfer"); assert.equal(gate.dueAt, undefined);
  const refused = statementCycleGate(l.events, { loan_id: "L-1", batch_id: "B-out", cycle_id: "C-2026-12", cycle_due_date: D("2026-12-01"), transfer_date: D("2026-12-01"), on: D("2026-11-02") });
  assert.equal(refused.statement_allowed, false); assert.match(refused.reason!, /no statement for cycles with due dates ≥ transfer_date/); assert.equal(refused.code, "SM_XFER_OUT_FINAL_STATEMENT_GATE");
  assert.equal(refused.event!.type, "statement.generation.refused"); assert.equal(refused.event!.loanId, "L-1"); assert.equal(refused.event!.payload.code, "SM_XFER_OUT_FINAL_STATEMENT_GATE"); assert.equal(refused.event!.payload.cycle_id, "C-2026-12");
  const last = statementCycleGate(l.events, { loan_id: "L-1", cycle_id: "C-2026-11", cycle_due_date: D("2026-11-01"), transfer_date: D("2026-12-01") });
  assert.equal(last.statement_allowed, true); assert.equal(last.last_supermortgage_cycle, true); assert.equal(last.event, null);
  const earlier = finalStatementGate({ cycle_due_date: D("2026-10-01"), transfer_date: D("2026-12-01") }); assert.equal(earlier.statement_allowed, true); assert.equal(earlier.last_supermortgage_cycle, false);
  assert.equal(finalStatementGate({ cycle_due_date: D("2027-01-01"), transfer_date: D("2026-12-01") }).statement_allowed, false);
  assert.equal(l.events.ofType("statement.generation.refused").length, 1);
});
