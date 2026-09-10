// 11.1 Live contact
// spec/sections/11-early-intervention-collections/11-1-live-contact.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../../kernel/events/index.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { requestDial, ingestInboundSms, preDialGate, attemptRequestedEvent, liveContactOf, bankruptcyResumeRecord } from "./ops-11-1.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { SECTION_11_TOOLS } from "../../app/tools/section11.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { openWindow, installmentPaid, reinstateOnReversal, seedWindowsAtBoarding, applyContact, sweep, liveDueMs, liveSatisfiedEvent } from "./windows.ts";
import { newPlan, openPlanIfDue, recordAttempt, planState, ALL_CHECKS_PASS } from "./plan.ts";
import { applyFifo, regxDaysDelinquent } from "../boarding/delinquency.ts";
import { lateChargeAmount } from "../cashiering/latecharges.ts";
import { counterRun, delinquencySnapshot, rollingDelinquency, voicemailOnlyDetermination, petitionOverlay, inboundLiveContact, dischargedWindow, applyOngoingLossmit, selectChannel, smsRevocation, quietHoursCheck, regfRunningCounts, regfDialCheck, postConversationGate, nextOutboundDue, preSaleStop, promiseFollowUp, aiQrpcWithFlagOff, humanTransferRequest, boardingCallTaskDue, regxApplicability, recordingDisclosureCheck, noticeActionAfterReversal, delinquencyMilestone, type CallAttempt, type LedgerFacts } from "./ops.ts";
import { eiEngine, atEt, noonEt } from "./spec-harness.ts";

/** `<pid>-T<n>: <text>` as spec/registry/manifest.json spells it (the strict audit's unit). */
const MANIFEST_TID = (pid: string, n: number): string => { const m = JSON.parse(readFileSync(new URL("../../../spec/registry/manifest.json", import.meta.url), "utf8")) as { process: string; tids: { n: number; text: string }[] }[]; return `${pid}-T${n}: ${m.find((x) => x.process === pid)!.tids.find((x) => x.n === n)!.text}`; };
const P = 200000n;
const FACTS: LedgerFacts = { installments: [{ due_date: D("2026-11-01"), amount_cents: P, pi_cents: 165000n, escrow_cents: 35000n }, { due_date: D("2026-12-01"), amount_cents: P, pi_cents: 165000n, escrow_cents: 35000n }], receipts: [{ received_on: D("2026-11-20"), amount_cents: 120000n }, { received_on: D("2026-12-10"), amount_cents: 120000n }], late_charge_pct: "5", late_charge_cap_cents: null, grace_days: 15 };

function uow(loanId = "L-11"): UowContext { const clock = new FixedClock("2026-11-21T15:00:00.000Z"); const events = new MemoryEventStore(clock); return { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: () => {} }; }
function runtime(ctx: UowContext): ToolRuntime { return { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} }; }
const tool = (process: string, name: string) => SECTION_11_TOOLS.find((t) => t.process === process && t.name === name)!;

test("11.1-T1: Given P due 2026-11-01 unpaid and TZ America/Chicago, when the counter runs 2026-11-02 00:05, then window(2026-11-01) exists with `live_due_at` 2026-12-07 23:59 CT and `notice_due_at` 2026-12-16.", () => {
  const r = counterRun(D("2026-11-01"), D("2026-11-02"));
  assert.equal(r.regx_days_delinquent, 1);
  assert.equal(r.window.live_due_at, D("2026-12-07")); assert.equal(r.window.notice_due_at, D("2026-12-16"));
  assert.equal(r.window.live, "open"); assert.equal(r.window.notice, "open"); assert.equal(r.window.principal_residence, true);
  assert.equal(toIso(liveDueMs(r.window, "America/Chicago")), toIso(zonedEpochMs(D("2026-12-07"), "23:59", "America/Chicago")));
  assert.equal(r.events[0]!.type, "loan.delinquency.window_opened"); assert.equal(r.events[0]!.payload.due_date, D("2026-11-01")); assert.equal(r.events[0]!.payload.live_status, "open"); assert.equal(r.events[0]!.payload.notice_status, "open");
  assert.equal(r.events[1]!.type, "loan.delinquency.started"); assert.equal(r.events[1]!.payload.day, 1);   // day 1 of the delinquency (FNMA_D2202_OUTBOUND_START_36 trigger)
  // the registry: the counter's window_opened arms the Reg X live-contact clock at due_date + 36, 23:59 ET (loan-local pending the per-loan zone), and only for a principal residence
  const h = eiEngine(); for (const e of r.events) h.emit(e.type, e.payload, atEt("2026-11-02", "00:05"));
  assert.equal(h.armed("REGX_1024_39A_LIVE_CONTACT_36").length, 1); assert.equal(h.armed("REGX_1024_39A_LIVE_CONTACT_36")[0]!.dueDate, D("2026-12-07")); assert.equal(h.armed("REGX_1024_39A_LIVE_CONTACT_36_WARN_28")[0]!.dueDate, D("2026-11-29"));
  assert.equal(h.armed("FNMA_D2202_OUTBOUND_START_36")[0]!.dueDate, D("2026-12-07"));
});
test("11.1-T2: Given the FIFO example in rule 3, when $1,200 arrives 2026-11-20 and $1,200 on 2026-12-10, then the Nov 1 installment is paid as of 2026-12-10, window(Nov 1).live is unaffected (past due date), window(Nov 1).notice = `cancelled_paid`, and `regx_days_delinquent` on 2026-12-11 = 10.", () => {
  const w = openWindow(D("2026-11-01"), { principal_residence: true });
  const fifo = applyFifo(FACTS.installments, FACTS.receipts);
  assert.equal(fifo.installments[0]!.satisfied_on, D("2026-12-10")); assert.equal(fifo.installments[1]!.satisfied_on, null); assert.equal(fifo.unapplied_cents, 40000n);
  installmentPaid(w, fifo.installments[0]!.satisfied_on!);
  assert.equal(w.live, "open");                       // the duty stood: payment came after Dec 7
  assert.equal(w.notice, "cancelled_paid"); assert.equal(w.cancel_reason, "paid_before_45");
  assert.equal(regxDaysDelinquent(fifo.installments, D("2026-12-11")), 10);
  const snap = delinquencySnapshot(FACTS, D("2026-12-11"));
  assert.equal(snap.regx_days_delinquent, 10); assert.equal(snap.earliest_unpaid_due, D("2026-12-01")); assert.equal(snap.unapplied_cents, 40000n);
  assert.equal(delinquencySnapshot(FACTS, D("2026-12-09")).unapplied_cents, 120000n);   // the first $1,200 sits in suspense (a + U < P)
  const w2 = openWindow(D("2026-12-01"), { principal_residence: true }); assert.equal(w2.live_due_at, D("2027-01-06")); assert.equal(w2.notice_due_at, D("2027-01-15"));
  const w3 = openWindow(D("2026-11-01"), { principal_residence: true }); installmentPaid(w3, D("2026-12-05")); assert.equal(w3.live, "cancelled_paid"); assert.equal(w3.notice, "cancelled_paid");
});
test("11.1-T3: Given payments always made on the following due date (rolling 30), then no `REGX_1024_39A_LIVE_CONTACT_36` timer ever breaches and every window shows `cancelled_paid`; the Fannie Mae plan opens each month at day 17 (policy) and closes `ceased{resolved}` when the installment is paid, with no `FNMA_D2202_*` breach.", () => {
  const r = rollingDelinquency({ loan_id: "L-11", due_dates: [D("2027-01-01"), D("2027-02-01"), D("2027-03-01"), D("2027-04-01")] });
  assert.equal(r.windows.length, 4);
  assert.ok(r.windows.every((w) => w.live === "cancelled_paid" && w.notice === "cancelled_paid" && w.cancel_reason === "paid_before_36"));
  assert.deepEqual(r.regx_breaches, []);
  assert.deepEqual(r.plan.episodes.map((e) => e.opened_on), [D("2027-01-18"), D("2027-02-18"), D("2027-03-18"), D("2027-04-18")]);   // day 17 of each month
  assert.deepEqual(r.plan.episodes.map((e) => e.closed_on), [D("2027-02-01"), D("2027-03-01"), D("2027-04-01"), D("2027-05-01")]);   // closed when the installment is paid
  assert.equal(r.plan_history.filter((h) => h.endsWith("ceased{resolved}")).length, 4);
  assert.equal(planState(r.plan), "ceased{resolved}");
  assert.deepEqual(r.fnma_breaches, []);
  assert.ok(r.events.some((e) => e.type === "contact.plan.ceased" && e.payload.reason === "resolved"));
  assert.ok(r.plan.attempts.every((a) => a.mode === "ai_voice" && !a.live_contact));
  // the registry, driven by the same events: each window's REGX_1024_39A_LIVE_CONTACT_36 is cancelled `paid_before_36` by the
  // 2.1 `payment.applied{installment_due_date, credited_as_of}` on the next due date, and every plan cease cancels the
  // FNMA_D2202_* clocks through its `cancel_timers` — no breach anywhere through 2027-05-08
  const h = eiEngine();
  const dues = [D("2027-01-01"), D("2027-02-01"), D("2027-03-01"), D("2027-04-01")];
  const planEvents = [...r.events].sort((a, b) => String(a.payload.on) < String(b.payload.on) ? -1 : 1);
  for (let k = 0; k < dues.length; k++) {
    const due = dues[k]!; const paidOn = k + 1 < dues.length ? dues[k + 1]! : D("2027-05-01");
    const opened = counterRun(due, D(`${due.slice(0, 8)}02`)); for (const e of opened.events) h.emit(e.type, e.payload, atEt(`${due.slice(0, 8)}02`, "00:05"));
    for (const e of planEvents.filter((e) => String(e.payload.on) > due && String(e.payload.on) <= paidOn)) h.emit(e.type, e.payload, noonEt(String(e.payload.on)));
    h.emit("payment.applied", { installment_due_date: due, credited_as_of: paidOn, allocation_outcome: "applied" }, noonEt(paidOn));
  }
  assert.equal(h.byCode("REGX_1024_39A_LIVE_CONTACT_36").length, 4); assert.ok(h.byCode("REGX_1024_39A_LIVE_CONTACT_36").every((t) => t.status === "cancelled" && t.cancelledReason === "paid_before_36"));
  assert.ok(h.byCode("FNMA_D2202_OUTBOUND_EVERY_7").length >= 4 && h.byCode("FNMA_D2202_OUTBOUND_EVERY_7").every((t) => t.status === "satisfied" || (t.status === "cancelled" && /contact\.plan\.ceased\{resolved\}/.test(t.cancelledReason ?? ""))));
  assert.deepEqual(h.breachCodes(atEt("2027-05-08", "00:05")).filter((c) => /^REGX_1024_39A|^FNMA_D2202/.test(c)), []);
  // the reviewer's probe: window_opened{due_date} then payment.applied on the next due date, evaluated the day after day 36 → no breach
  const p = eiEngine(); p.emit("loan.delinquency.window_opened", { due_date: "2027-01-01", principal_residence: true }, atEt("2027-01-02", "00:05")); p.emit("payment.applied", { installment_due_date: "2027-01-01", credited_as_of: "2027-02-01" }, noonEt("2027-02-01"));
  assert.deepEqual(p.breachCodes(atEt("2027-02-07", "00:05")), []); assert.equal(p.byCode("REGX_1024_39A_LIVE_CONTACT_36")[0]!.status, "cancelled");
});
test("11.1-T4: Given Jan 1, Feb 1 and Mar 1 unpaid, when a live AI contact (flag on) occurs Feb 5, then windows Jan 1 and Feb 1 are `satisfied_live` and window Mar 1 remains open until Apr 6.", () => {
  const ws = [D("2027-01-01"), D("2027-02-01"), D("2027-03-01")].map((d) => openWindow(d, { principal_residence: true }));
  const hit = applyContact(ws, D("2027-02-05"), "live", "ai_voice_flag", "ct-feb5");
  assert.deepEqual(hit.map((w) => w.due_date), [D("2027-01-01"), D("2027-02-01")]);
  assert.equal(ws[0]!.live, "satisfied_live"); assert.equal(ws[1]!.live, "satisfied_live"); assert.equal(ws[0]!.live_basis, "ai_voice_flag"); assert.equal(ws[0]!.live_satisfied_by_contact_id, "ct-feb5");
  assert.equal(ws[2]!.live, "open"); assert.equal(ws[2]!.live_due_at, D("2027-04-06"));
  assert.equal(sweep(ws, D("2027-04-06")).filter((w) => w.live === "breached").length, 0); assert.equal(ws[2]!.live, "open");
  sweep(ws, D("2027-04-07")); assert.equal(ws[2]!.live, "breached");
});
test("11.1-T5: Given the borrower calls in on day 20 and completes a verified conversation, then the window is `satisfied_live` with `basis=borrower_initiated` and the Fannie Mae plan records an inbound contact.", () => {
  const ws = [openWindow(D("2026-11-01"), { principal_residence: true })];
  const r = inboundLiveContact(ws, D("2026-11-21"));
  assert.equal(r.satisfied.length, 1); assert.equal(ws[0]!.live, "satisfied_live"); assert.equal(ws[0]!.live_basis, "borrower_initiated"); assert.equal(r.basis, "borrower_initiated");
  assert.deepEqual(r.plan_record, { type: "contact.inbound.received", direction: "inbound", on: D("2026-11-21") });
});
test("11.1-T6: Given only voicemails were left, when day 36 passes, then `live_contact=false` on each and the window is `satisfied_good_faith` only if rule 6 minimums are met; otherwise `breached` and an `officer` escalation exists.", () => {
  const met = voicemailOnlyDetermination(openWindow(D("2026-11-01"), { principal_residence: true }), {
    voicemails: [{ contact_id: "c1", on: D("2026-11-20"), number_id: "n1", daypart: "morning" }, { contact_id: "c2", on: D("2026-11-24"), number_id: "n1", daypart: "evening" }, { contact_id: "c3", on: D("2026-11-21"), number_id: "n2", daypart: "afternoon" }, { contact_id: "c4", on: D("2026-11-28"), number_id: "n2", daypart: "weekend" }],
    written: [{ contact_id: "c5", on: D("2026-11-29"), channel: "letter", notice_id: "ntc-contact-request-1" }], known_good_numbers: ["n1", "n2"], determined_on: D("2026-12-08"), consecutive_payments_behind: 1 });
  assert.ok(met.contacts.every((c) => c.live_contact === false && c.outcome === "voicemail_left"));
  assert.equal(met.window_live, "satisfied_good_faith"); assert.equal(met.escalation, null); assert.deepEqual([...met.shortfalls], []);
  assert.deepEqual([...met.record!.attempts], ["c1", "c2", "c3", "c4", "c5"]); assert.deepEqual([...met.record!.written_encouragement_notice_ids], ["ntc-contact-request-1"]);
  assert.match(met.record!.reasonableness_rationale, /comment 39\(a\)-3: 4 telephone attempt\(s\) across 4 day\(s\) and 1 written/);
  const short = voicemailOnlyDetermination(openWindow(D("2026-11-01"), { principal_residence: true }), { voicemails: [{ contact_id: "c1", on: D("2026-11-20"), number_id: "n1", daypart: "morning" }], written: [], known_good_numbers: ["n1"], determined_on: D("2026-12-08") });
  assert.equal(short.window_live, "breached"); assert.equal(short.record, null);
  assert.deepEqual(short.escalation, { role: "officer", severity: 1, timer: "REGX_1024_39A_LIVE_CONTACT_36", task: "immediate_human_call" });
  assert.ok(short.shortfalls.some((s) => /number n1: 1 attempt/.test(s)) && short.shortfalls.some((s) => /no written or electronic/.test(s)));
  // before day 36 the shortfalls are reported and the window stays open (never self-certified; the planner still has time)
  const early = voicemailOnlyDetermination(openWindow(D("2026-11-01"), { principal_residence: true }), { voicemails: [{ contact_id: "c1", on: D("2026-11-20"), number_id: "n1" }], written: [], known_good_numbers: ["n1"], determined_on: D("2026-12-06") });
  assert.equal(early.window_live, "open"); assert.equal(early.escalation, null); assert.ok(early.shortfalls.length >= 1); assert.deepEqual([...early.events], []);
  // the registry: the rule-6 determination at live_due_at − 1 emits `good_faith_efforts.determined` and the canonical
  // `regx.ei_window.live.satisfied{basis=good_faith_efforts.determined}` — the second alternative in the timer row's
  // satisfied column — which closes REGX_1024_39A_LIVE_CONTACT_36 before day 36; without it the clock breaches sev-1 → officer
  const onTime = voicemailOnlyDetermination(openWindow(D("2026-11-01"), { principal_residence: true }), { voicemails: [{ contact_id: "c1", on: D("2026-11-20"), number_id: "n1", daypart: "morning" }, { contact_id: "c2", on: D("2026-11-24"), number_id: "n1", daypart: "evening" }], written: [{ contact_id: "c5", on: D("2026-11-29"), channel: "letter", notice_id: "ntc-contact-request-1" }], known_good_numbers: ["n1"], determined_on: D("2026-12-06") });
  assert.deepEqual(onTime.events.map((e) => e.type), ["good_faith_efforts.determined", "regx.ei_window.live.satisfied"]); assert.equal(onTime.events[1]!.payload.basis, "good_faith_efforts.determined");
  const ok = eiEngine(); for (const e of counterRun(D("2026-11-01"), D("2026-11-02")).events) ok.emit(e.type, e.payload, atEt("2026-11-02", "00:05")); for (const e of onTime.events) ok.emit(e.type, e.payload, noonEt("2026-12-06"));
  assert.equal(ok.byCode("REGX_1024_39A_LIVE_CONTACT_36")[0]!.status, "satisfied"); assert.deepEqual(ok.breachCodes(atEt("2026-12-08", "00:05")).filter((c) => c.startsWith("REGX_1024_39A")), []);
  const breached = eiEngine(); for (const e of counterRun(D("2026-11-01"), D("2026-11-02")).events) breached.emit(e.type, e.payload, atEt("2026-11-02", "00:05"));
  const b = breached.engine.evaluate(atEt("2026-12-08", "00:05")).find((x) => x.instance.code === "REGX_1024_39A_LIVE_CONTACT_36")!; assert.equal(b.severity, 1); assert.ok(b.escalateTo.includes("officer"));
});
test("11.1-T7: Given a Chapter 13 petition on day 20, then window `exempt_bk`, plan `suspended{bankruptcy}`, and no outbound attempt is dialable (command refused).", async () => {
  const windows = [openWindow(D("2026-11-01"), { principal_residence: true })];
  const plan = newPlan("L-11"); openPlanIfDue(plan, 17, D("2026-11-18"), { due_date: D("2026-11-01") }); recordAttempt(plan, { contact_id: "c1", on: D("2026-11-18"), mode: "ai_voice", outcome: "no_answer", live_contact: false });
  const r = petitionOverlay({ windows, plan, petition_on: D("2026-11-21"), chapter: 13 });
  assert.equal(windows[0]!.live, "exempt_bk"); assert.equal(windows[0]!.notice, "bk_modified_required"); assert.equal(r.windows_exempted.length, 1);
  assert.equal(r.plan_status, "suspended{bankruptcy}"); assert.ok(r.events.some((e) => e.type === "contact.plan.suspended" && e.payload.reason === "bankruptcy"));
  assert.equal(r.dial.allowed, false); assert.equal(r.dial.refused_by, "PLAN_NOT_ACTIVE"); assert.match(r.dial.reason!, /suspended\{bankruptcy\}/);
  assert.throws(() => recordAttempt(plan, { contact_id: "c2", on: D("2026-11-22"), mode: "ai_voice", outcome: "no_answer", live_contact: false }), /suspended\{bankruptcy\}/);
  // the registry: the petition cancels the live-contact clock (`exempt_bk`, §1024.39(c)(1)(i)) and the plan's suspension cancels
  // the D2-2-02 cadence clocks through `cancel_timers`; the delinquent borrower's petition opens the once-per-case modified notice
  const h = eiEngine(); for (const e of counterRun(D("2026-11-01"), D("2026-11-02")).events) h.emit(e.type, e.payload, atEt("2026-11-02", "00:05"));
  h.emit("contact.attempted", { contact_id: "c1", direction: "outbound", mode: "ai_voice", outcome: "no_answer", on: "2026-11-18" }, noonEt("2026-11-18"));
  assert.equal(h.armed("FNMA_D2202_OUTBOUND_EVERY_7").length, 1); assert.equal(h.armed("FNMA_D2202_OUTBOUND_START_36").length, 0);   // the first attempt satisfied START_36
  h.emit("bankruptcy.petition.filed", { chapter: "13", petition_date: "2026-11-21", fnma_delinquency_days: 20 }, noonEt("2026-11-21"));
  for (const e of r.events) h.emit(e.type, e.payload, noonEt("2026-11-21"));
  assert.equal(h.byCode("REGX_1024_39A_LIVE_CONTACT_36")[0]!.status, "cancelled"); assert.equal(h.byCode("REGX_1024_39A_LIVE_CONTACT_36")[0]!.cancelledReason, "exempt_bk");
  assert.ok(h.byCode("FNMA_D2202_OUTBOUND_EVERY_7").every((t) => t.status === "cancelled" && /contact\.plan\.suspended\{bankruptcy\}/.test(t.cancelledReason ?? "")));
  assert.deepEqual(h.breachCodes(atEt("2026-12-08", "00:05")).filter((c) => /^REGX_1024_39A|^FNMA_D2202/.test(c)), []);
  assert.ok(r.events.some((e) => e.type === "regx.ei_notice.bk_modified_required" && e.payload.basis === "petition_while_delinquent")); assert.equal(h.armed("REGX_1024_39C_BK_MODIFIED_NOTICE_45")[0]!.dueDate, D("2027-01-05"));
  // the command bus refuses the outbound attempt: the bankruptcy pre-dial check fails
  const ctx = uow(); const agents = new AgentRegistry(); const cmd = toolCommand(tool("11.3", "contact.log"), runtime(ctx), ["human_agent"]); agents.registerTool("borrower-comms", cmd.name);
  const bus = new CommandBus(agents); const comms: Actor = { kind: "agent", id: "borrower-comms" };
  await assert.rejects(bus.execute(cmd, comms, { loan_id: "L-11", mode: "ai_voice", direction: "outbound", outcome: "no_answer", pre_dial_checks: { ...ALL_CHECKS_PASS, bk_flag: false } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "PRE_DIAL_CHECKS_REQUIRED");
  assert.ok(ctx.events.all().some((e) => e.type === "command.refused" && e.payload.code === "PRE_DIAL_CHECKS_REQUIRED"));
  assert.ok(!ctx.events.all().some((e) => e.type === "contact.attempted"));
});
test("11.1-T8: Given a Chapter 7 discharge, then no window ever reopens for (a) after the case closes, even on new delinquency; a later partial payment triggers the 11.2 notice path only.", () => {
  const a = dischargedWindow(D("2027-06-01"), { payment_after_petition: false });
  assert.equal(a.live, "exempt_discharge"); assert.equal(a.notice, "exempt_discharge");
  const b = dischargedWindow(D("2027-07-01"), { payment_after_petition: true });
  assert.equal(b.live, "exempt_discharge"); assert.equal(b.notice, "open");
});
test("11.1-T9: Given `lossmit.ongoing_contact` active from day 30 to day 70, then windows maturing in that span are `satisfied_ongoing_lossmit`; after cure and re-delinquency, new windows require fresh efforts.", () => {
  const day0 = D("2026-11-01");
  const ws = [openWindow(D("2026-11-01"), { principal_residence: true }), openWindow(D("2026-12-01"), { principal_residence: true })];
  const hit = applyOngoingLossmit(ws, D("2026-12-01"), D("2027-01-10"));   // day 30 → day 70 of the Nov 1 delinquency
  assert.equal(hit.length, 2); assert.ok(ws.every((w) => w.live === "satisfied_ongoing_lossmit"));
  const fresh = openWindow(D("2027-03-01"), { principal_residence: true }); assert.equal(applyOngoingLossmit([fresh], D("2026-12-01"), D("2027-01-10")).length, 0); assert.equal(fresh.live, "open");
  assert.equal(day0, "2026-11-01");
  // the registry: the §1024.41 ongoing-contact safe harbor (comment 39(a)-6) is the third alternative in the satisfied column —
  // the canonical `regx.ei_window.live.satisfied{basis=lossmit.ongoing_contact}` closes each window's clock while the state is active
  const h = eiEngine(); for (const e of counterRun(D("2026-11-01"), D("2026-11-02")).events) h.emit(e.type, e.payload, atEt("2026-11-02", "00:05"));
  const nov = liveSatisfiedEvent([ws[0]!], "lossmit.ongoing_contact", D("2026-12-01")); h.emit(nov.type, nov.payload, noonEt("2026-12-01"));
  for (const e of counterRun(D("2026-12-01"), D("2026-12-02"), { first_delinquency: false }).events) h.emit(e.type, e.payload, atEt("2026-12-02", "00:05"));
  const dec = liveSatisfiedEvent([ws[1]!], "lossmit.ongoing_contact", D("2026-12-02")); h.emit(dec.type, dec.payload, noonEt("2026-12-02"));   // the nightly job re-applies the active state to the newly opened window
  assert.ok(h.byCode("REGX_1024_39A_LIVE_CONTACT_36").length === 2 && h.byCode("REGX_1024_39A_LIVE_CONTACT_36").every((t) => t.status === "satisfied"));
  assert.deepEqual(h.breachCodes(atEt("2027-01-07", "00:05")).filter((c) => c.startsWith("REGX_1024_39A")), []);
  for (const e of counterRun(D("2027-03-01"), D("2027-03-02")).events) h.emit(e.type, e.payload, atEt("2027-03-02", "00:05"));   // after cure and re-delinquency: fresh efforts required
  assert.equal(h.armed("REGX_1024_39A_LIVE_CONTACT_36").length, 1); assert.ok(h.breachCodes(atEt("2027-04-07", "00:05")).includes("REGX_1024_39A_LIVE_CONTACT_36"));
});
test("11.1-T10: Given a mobile number with no `tcpa_voice` consent, when the planner selects a channel, then AI voice is refused (`TCPA_64_1200_A1_CELL_CONSENT_GATE`) and a human manual-dial task is created.", () => {
  const r = selectChannel({ line_type: "mobile", tcpa_voice_consent: false });
  assert.equal(r.ai_voice, false); assert.equal(r.refused_by, "TCPA_64_1200_A1_CELL_CONSENT_GATE"); assert.equal(r.task, "human_manual_dial"); assert.equal(r.route, "human_manual_dial");
  assert.equal(selectChannel({ line_type: "mobile", tcpa_voice_consent: true }).ai_voice, true);
  // the registry: the planner's dial request (ops-11-1.ts requestDial) records `contact.attempt.requested{mode=ai_voice, line_type=mobile}` —
  // the trigger of TCPA_64_1200_A1_CELL_CONSENT_GATE — carrying the consent facts; the gate arms as an evaluator instance,
  // `11.1.tcpaConsentUnrevoked` refuses on the event's own facts, the request is refused and routed to a human manual dial, nothing is attempted
  const h = eiEngine(); const plan = newPlan("L-11"); openPlanIfDue(plan, 17, D("2026-11-18"), { due_date: D("2026-11-01") });
  const facts = { loan_id: "L-11", mode: "ai_voice" as const, dial_at: toIso(zonedEpochMs(D("2026-11-18"), "10:00", "America/Chicago")), number_id: "pn-1", person: "B", line_type: "mobile" as const, tcpa_voice_consent_active: false, fdcpa_debt_collector: false, time_zones: ["America/Chicago"] };
  const req = requestDial(h.events, SYSTEM, plan, facts);
  assert.equal(req.allowed, false); assert.deepEqual([...req.refused_by], ["TCPA_64_1200_A1_CELL_CONSENT_GATE"]); assert.equal(req.route, "human_manual_dial"); assert.equal(req.checks.consent, false); assert.equal(req.checks.quiet_hours, true);
  assert.equal(req.request.type, "contact.attempt.requested"); assert.equal(req.request.payload.line_type, "mobile"); assert.equal(req.request.payload.mode, "ai_voice"); assert.equal(req.request.payload.tcpa_voice_consent_active, false); assert.equal(req.request.payload.allowed, false);
  assert.equal(req.refusal!.type, "contact.attempt.refused"); assert.deepEqual(req.refusal!.payload.refused_by, ["TCPA_64_1200_A1_CELL_CONSENT_GATE"]);
  const gate = h.armed("TCPA_64_1200_A1_CELL_CONSENT_GATE"); assert.equal(gate.length, 1); assert.equal(gate[0]!.note, "evaluator:11.1.tcpaConsentUnrevoked"); assert.equal(gate[0]!.armedByEventId, req.request.id);
  assert.equal(evaluateGate("11.1.tcpaConsentUnrevoked", req.request.payload).open, false);
  assert.ok(!h.events.all().some((e) => e.type === "contact.attempted"));
  // an SMS to the same number without `tcpa_sms` consent is the same gate; with unrevoked consent the AI voice passes and no human task is created
  const sms = requestDial(h.events, SYSTEM, plan, { ...facts, mode: "sms" }); assert.equal(sms.allowed, false); assert.deepEqual([...sms.refused_by], ["TCPA_64_1200_A1_CELL_CONSENT_GATE"]); assert.equal(h.armed("TCPA_64_1200_A1_CELL_CONSENT_GATE").length, 2);
  const ok = requestDial(h.events, SYSTEM, plan, { ...facts, tcpa_voice_consent_active: true }); assert.equal(ok.allowed, true); assert.equal(ok.route, "ai_voice"); assert.equal(ok.refusal, null); assert.equal(evaluateGate("11.1.tcpaConsentUnrevoked", ok.request.payload).open, true);
  // a landline is outside the cell-consent gate (47 CFR 64.1200(a)(1)(iii) is cellular): the request arms nothing here
  requestDial(h.events, SYSTEM, plan, { ...facts, line_type: "landline" }); assert.equal(h.armed("TCPA_64_1200_A1_CELL_CONSENT_GATE").length, 3);
  assert.throws(() => preDialGate({ ...facts, dial_at: "not-a-time" }), RangeError);
});
test('11.1-T11: Given an inbound SMS "STOP", then `consent.revoked` is committed within 1 minute, all AI voice/SMS to that number are blocked, one confirmation text is sent within 5 minutes, and `TCPA_64_1200_A10_REVOCATION_HONOR_10BD` is satisfied immediately.', () => {
  const t0 = zonedEpochMs(D("2026-12-11"), "10:00", "America/Chicago");
  const r = smsRevocation({ received_at_ms: t0, text: "STOP", received_on: D("2026-12-11") });
  assert.equal(r.revoked, true); assert.equal(r.committed_by_ms, t0 + 60_000); assert.deepEqual(r.blocked, ["ai_voice", "sms"]);
  assert.deepEqual(r.confirmation_text, { count: 1, send_by_ms: t0 + 300_000 });
  assert.equal(r.timer.code, "TCPA_64_1200_A10_REVOCATION_HONOR_10BD"); assert.equal(r.timer.status, "satisfied"); assert.equal(r.timer.satisfied_at_ms, t0);
  assert.deepEqual(r.events.map((e) => e.type), ["consent.revoked", "consent.revocation.honored"]);
  assert.equal(smsRevocation({ received_at_ms: t0, text: "thanks", received_on: D("2026-12-11") }).revoked, false);
  // the ingestion handler (ops-11-1.ts ingestInboundSms): the carrier's inbound record is validated and the consent-ledger events are appended
  // in one unit of work — `consent.revoked` (the registry arms TCPA_64_1200_A10_REVOCATION_HONOR_10BD: receipt Fri 2026-12-11 + 10 federal
  // business days, 12-25 a holiday → due 2026-12-28) and `consent.revocation.honored` at the same instant (satisfied immediately, latency 0)
  const h = eiEngine({ now: toIso(t0) });
  const sms = { loan_id: "L-11", phone_number_id: "pn-1", party_id: "B", received_at: toIso(t0) };
  const ing = ingestInboundSms(h.events, SYSTEM, { ...sms, text: "STOP" });
  assert.equal(ing.revoked, true); assert.equal(ing.keyword, "STOP"); assert.equal(ing.committed_by, toIso(t0 + 60_000)); assert.deepEqual([...ing.blocked], ["ai_voice", "sms"]);
  assert.deepEqual(ing.confirmation, { count: 1, send_by: toIso(t0 + 300_000) }); assert.equal(ing.legal_due, D("2026-12-28"));
  assert.deepEqual(ing.events.map((e) => e.type), ["contact.inbound.sms_received", "consent.revoked", "consent.revocation.honored", "sms.confirmation.queued"]);
  assert.equal(ing.events[1]!.payload.phone_number_id, "pn-1"); assert.equal(ing.events[1]!.payload.method, "sms_keyword"); assert.equal(ing.events[2]!.payload.latency_ms, 0); assert.equal(ing.events[3]!.payload.count, 1);
  const t = h.byCode("TCPA_64_1200_A10_REVOCATION_HONOR_10BD"); assert.equal(t.length, 1); assert.equal(t[0]!.anchorDate, D("2026-12-11")); assert.equal(t[0]!.dueDate, D("2026-12-28"));
  assert.equal(t[0]!.status, "satisfied"); assert.equal(t[0]!.satisfiedAt, toIso(t0)); assert.equal(t[0]!.satisfiedByEventId, ing.events[2]!.id);
  assert.deepEqual(h.breachCodes(atEt("2026-12-29", "00:05")).filter((c) => c.startsWith("TCPA")), []);
  // blocked at commit: the next AI-voice / SMS dial request to that number is refused by the cell-consent gate and routed to a human manual dial
  const dial = { loan_id: "L-11", mode: "ai_voice" as const, dial_at: toIso(t0 + 3_600_000), number_id: "pn-1", person: "B", line_type: "mobile" as const, tcpa_voice_consent_active: false, tcpa_sms_consent_active: false, fdcpa_debt_collector: false, time_zones: ["America/Chicago"] };
  const voice = requestDial(h.events, SYSTEM, null, dial); assert.equal(voice.allowed, false); assert.deepEqual([...voice.refused_by], ["TCPA_64_1200_A1_CELL_CONSENT_GATE"]); assert.equal(voice.route, "human_manual_dial");
  const text = requestDial(h.events, SYSTEM, null, { ...dial, mode: "sms" }); assert.equal(text.allowed, false); assert.deepEqual([...text.refused_by], ["TCPA_64_1200_A1_CELL_CONSENT_GATE"]);
  assert.equal(h.armed("TCPA_64_1200_A1_CELL_CONSENT_GATE").length, 2); assert.equal(evaluateGate("11.1.tcpaConsentUnrevoked", text.request.payload).open, false);
  const human = requestDial(h.events, SYSTEM, null, { ...dial, mode: "human_voice" }); assert.equal(human.allowed, true);   // mail and the human manual dial (no ATDS, no artificial voice) continue
  // a non-revoking text is logged and revokes nothing; a malformed record is refused before anything is appended
  const other = ingestInboundSms(h.events, SYSTEM, { ...sms, text: "thanks" }); assert.equal(other.revoked, false); assert.equal(other.confirmation, null); assert.deepEqual(other.events.map((e) => e.type), ["contact.inbound.sms_received"]);
  assert.equal(h.byCode("TCPA_64_1200_A10_REVOCATION_HONOR_10BD").length, 1);
  assert.throws(() => ingestInboundSms(h.events, SYSTEM, { ...sms, phone_number_id: "", text: "STOP" }), RangeError); assert.throws(() => ingestInboundSms(h.events, SYSTEM, { ...sms, text: "  " }), RangeError);
});
test("11.1-T12: Given property in America/New_York and area code in America/Los_Angeles, when dialing at 20:45 ET, then the call is refused (17:45 PT is allowed but 20:45 ET exceeds the 20:30 voice policy); at 11:00 ET (08:00 PT) it is refused for PT; at 12:00 ET it is permitted.", () => {
  const tz = ["America/New_York", "America/Los_Angeles"];
  const a = quietHoursCheck({ dial_at_ms: zonedEpochMs(D("2026-12-09"), "20:45", "America/New_York"), time_zones: tz, mode: "voice" });
  assert.equal(a.permitted, false); assert.deepEqual(a.refused_for, [{ tz: "America/New_York", local: "20:45" }]);
  const b = quietHoursCheck({ dial_at_ms: zonedEpochMs(D("2026-12-09"), "11:00", "America/New_York"), time_zones: tz, mode: "voice" });
  assert.equal(b.permitted, false); assert.deepEqual(b.refused_for, [{ tz: "America/Los_Angeles", local: "08:00" }]);
  assert.equal(quietHoursCheck({ dial_at_ms: zonedEpochMs(D("2026-12-09"), "12:00", "America/New_York"), time_zones: tz, mode: "voice" }).permitted, true);
  // the registry instance (REGF_1006_6B1_QUIET_HOURS, evaluator `11.1.quietHours`): the 11.1 dial request carries every candidate zone's local time
  // and the dialer mode (ai_voice → the 20:30 voice policy), and the evaluator reads them all — the armed instance's own facts give the gate's verdict
  const facts = { loan_id: "L-11", mode: "ai_voice" as const, fdcpa_debt_collector: true, line_type: "mobile" as const, tcpa_voice_consent_active: true, time_zones: tz };
  const h = eiEngine();
  const late = requestDial(h.events, SYSTEM, null, { ...facts, dial_at: toIso(zonedEpochMs(D("2026-12-09"), "20:45", "America/New_York")) });
  assert.equal(late.allowed, false); assert.deepEqual([...late.refused_by], ["REGF_1006_6B1_QUIET_HOURS"]);
  const inst = h.armed("REGF_1006_6B1_QUIET_HOURS"); assert.equal(inst.length, 1); assert.equal(inst[0]!.note, "evaluator:11.1.quietHours"); assert.equal(inst[0]!.armedByEventId, late.request.id);
  assert.equal(evaluateGate("11.1.quietHours", late.request.payload).open, false); assert.match(String(evaluateGate("11.1.quietHours", late.request.payload).reason), /20:45/);
  const early = requestDial(h.events, SYSTEM, null, { ...facts, dial_at: toIso(zonedEpochMs(D("2026-12-09"), "11:00", "America/New_York")) });
  assert.equal(early.allowed, false); assert.equal(evaluateGate("11.1.quietHours", early.request.payload).open, false); assert.match(String(evaluateGate("11.1.quietHours", early.request.payload).reason), /08:00/);
  const okReq = requestDial(h.events, SYSTEM, null, { ...facts, dial_at: toIso(zonedEpochMs(D("2026-12-09"), "12:00", "America/New_York")) });
  assert.equal(okReq.allowed, true); assert.equal(evaluateGate("11.1.quietHours", okReq.request.payload).open, true); assert.equal(h.armed("REGF_1006_6B1_QUIET_HOURS").length, 3);
  // a human dial is the same voice policy; SMS/email close at 20:00 in every zone; a letter has no send time; no candidate zone is not permitted (rule 8)
  assert.equal(evaluateGate("11.1.quietHours", { mode: "human_voice", consumer_local_times: [{ tz: "America/New_York", time: "20:45" }] }).open, false);
  assert.equal(evaluateGate("11.1.quietHours", { mode: "sms", consumer_local_times: [{ tz: "America/New_York", time: "20:15" }, { tz: "America/Los_Angeles", time: "17:15" }] }).open, false);
  assert.equal(evaluateGate("11.1.quietHours", { mode: "email", consumer_local_time: "19:59" }).open, true);
  assert.equal(evaluateGate("11.1.quietHours", { mode: "letter", consumer_local_times: [] }).open, true);
  assert.equal(evaluateGate("11.1.quietHours", { mode: "ai_voice", consumer_local_times: [] }).open, false);
});
test("11.1-T13: Given the Reg F scenario in rule 10, then counts are B=1,2,2,2,3,4 and C=1 in order; the 12-15 callback is `regf_exclusion=consent_within_7d`; an attempted 8th counted call to B within 7 days is refused.", () => {
  const ET = "America/New_York"; const at = (d: string, t: string) => zonedEpochMs(D(d), t, ET);
  const attempts: CallAttempt[] = [
    { at_ms: at("2026-12-07", "09:05"), person: "B", outcome: "no_answer" }, { at_ms: at("2026-12-08", "18:40"), person: "B", outcome: "voicemail_lcm_left" },
    { at_ms: at("2026-12-09", "12:10"), person: "B", outcome: "busy_or_failed" }, { at_ms: at("2026-12-09", "12:15"), person: "C", outcome: "no_answer" },
    { at_ms: at("2026-12-10", "08:30"), person: "B", outcome: "no_answer" }, { at_ms: at("2026-12-11", "18:05"), person: "B", outcome: "conversation" },
  ];
  assert.deepEqual(regfRunningCounts(attempts, "B"), [1, 2, 2, 2, 3, 4]); assert.deepEqual(regfRunningCounts(attempts, "C"), [0, 0, 0, 1, 1, 1]);
  const cb = regfDialCheck(attempts, "B", at("2026-12-15", "18:00"), { callback_consent_at_ms: at("2026-12-11", "18:05") });
  assert.equal(cb.allowed, true); assert.equal(cb.regf_exclusion, "consent_within_7d");
  const seven: CallAttempt[] = Array.from({ length: 7 }, (_, k) => ({ at_ms: at("2026-12-07", "09:00") + k * 3_600_000, person: "B", outcome: "no_answer" }));
  const eighth = regfDialCheck(seven, "B", at("2026-12-08", "09:00"));
  assert.equal(eighth.allowed, false); assert.equal(eighth.refused_by, "REGF_1006_14_CALL_CAP_7IN7"); assert.equal(eighth.count_after, 8);
  // the registry: on the debt-collector loan the 8th dial request within 7 days records `contact.attempt.requested{direction=outbound,
  // channel=voice, fdcpa_debt_collector_flag=true}` — the trigger of REGF_1006_14_CALL_CAP_7IN7 — carrying the seven counted attempts;
  // the gate arms as an evaluator instance, `11.1.callCap7in7` refuses on the event's own facts, the request is refused, nothing is attempted
  const h = eiEngine();
  const dc = { loan_id: "L-11", mode: "ai_voice" as const, dial_at: toIso(at("2026-12-08", "09:00")), person: "B", number_id: "pn-1", line_type: "mobile" as const, tcpa_voice_consent_active: true, fdcpa_debt_collector: true, time_zones: [ET], counted_call_attempts_at: seven.map((a) => toIso(a.at_ms)) };
  const req = requestDial(h.events, SYSTEM, null, dc);
  assert.equal(req.allowed, false); assert.deepEqual([...req.refused_by], ["REGF_1006_14_CALL_CAP_7IN7"]); assert.equal(req.gate.detail.regf_count_after, 8); assert.equal(req.checks.regf_count, false);
  assert.equal(req.request.payload.channel, "voice"); assert.equal(req.request.payload.fdcpa_debt_collector_flag, true); assert.deepEqual(req.request.payload.counted_call_attempts_at, seven.map((a) => toIso(a.at_ms)));
  assert.equal(h.armed("REGF_1006_14_CALL_CAP_7IN7").length, 1); assert.equal(h.armed("REGF_1006_14_CALL_CAP_7IN7")[0]!.note, "evaluator:11.1.callCap7in7"); assert.equal(h.armed("REGF_1006_14_CALL_CAP_7IN7")[0]!.armedByEventId, req.request.id);
  assert.equal(evaluateGate("11.1.callCap7in7", req.request.payload).open, false);
  assert.ok(!h.events.all().some((e) => e.type === "contact.attempted")); assert.equal(h.events.all().filter((e) => e.type === "contact.attempt.refused").length, 1);
  // rule 9: counted "by AI or human" — the human dialer's request is the same `channel=voice` trigger; the 7th (six prior) is permitted
  const human = requestDial(h.events, SYSTEM, null, { ...dc, mode: "human_voice" }); assert.equal(human.allowed, false); assert.equal(h.armed("REGF_1006_14_CALL_CAP_7IN7").length, 2);
  const seventh = requestDial(h.events, SYSTEM, null, { ...dc, counted_call_attempts_at: seven.slice(0, 6).map((a) => toIso(a.at_ms)) }); assert.equal(seventh.allowed, true); assert.equal(seventh.gate.detail.regf_count_after, 7); assert.equal(evaluateGate("11.1.callCap7in7", seventh.request.payload).open, true);
  // the 12-15 callback the borrower asked for on 12-11: permitted, `regf_exclusion=consent_within_7d`, and outside the post-conversation cooling-off
  const cb2 = requestDial(h.events, SYSTEM, null, { ...dc, dial_at: toIso(at("2026-12-15", "18:00")), counted_call_attempts_at: attempts.filter((a) => a.person === "B").map((a) => toIso(a.at_ms)), days_since_conversation: 4, callback_consent_within_7d: true });
  assert.equal(cb2.allowed, true); assert.equal(cb2.gate.detail.regf_exclusion, "consent_within_7d"); assert.equal(cb2.checks.post_conversation, true);
  // a non-debt-collector loan takes the policy cap (5 per 7 days, 11.1-Q5) and never arms the Reg F gate
  const armedDc = h.armed("REGF_1006_14_CALL_CAP_7IN7").length; assert.equal(armedDc, 4);   // every DC voice request (8th, human 8th, 7th, callback) is a trigger
  const ndc = requestDial(h.events, SYSTEM, null, { ...dc, fdcpa_debt_collector: false, counted_call_attempts_at: seven.slice(0, 5).map((a) => toIso(a.at_ms)) }); assert.equal(ndc.allowed, false); assert.equal(ndc.gate.detail.cap, 5); assert.equal(ndc.request.payload.fdcpa_debt_collector_flag, false); assert.equal(h.armed("REGF_1006_14_CALL_CAP_7IN7").length, armedDc);
});
test("11.1-T14: Given a conversation on 12-11 with no callback consent, when a dial to B is requested 12-16, then refused by `REGF_1006_14_POST_CONVERSATION_7`; permitted 12-18.", () => {
  const r = postConversationGate(D("2026-12-11"), D("2026-12-16"));
  assert.equal(r.allowed, false); assert.equal(r.refused_by, "REGF_1006_14_POST_CONVERSATION_7"); assert.equal(r.permitted_from, D("2026-12-18"));
  assert.equal(postConversationGate(D("2026-12-11"), D("2026-12-18")).allowed, true);
  assert.equal(postConversationGate(D("2026-12-11"), D("2026-12-15"), { callback_consent: true }).allowed, true);
});
test("11.1-T15: Given last attempt Thu 2026-11-19 and the servicer closed Thu 11-26 (Thanksgiving), then `FNMA_D2202_OUTBOUND_EVERY_7` due 11-26 shifts to Fri 11-27.", () => {
  const r = nextOutboundDue(D("2026-11-19"));
  assert.equal(r.nominal, D("2026-11-26")); assert.equal(r.due, D("2026-11-27")); assert.equal(r.shifted, true);
  assert.equal(nextOutboundDue(D("2026-11-10")).due, D("2026-11-17"));
});
test("11.1-T16: Given a judicial sale scheduled 2027-06-15, then outbound attempts are refused from 2027-04-16; given `contact_required_through_sale` for the state, then permitted with a logged basis.", () => {
  const r = preSaleStop({ sale_date: D("2027-06-15"), judicial: true });
  assert.equal(r.stop_from, D("2027-04-16")); assert.equal(r.gate, "FNMA_D2202_CEASE_PRE_SALE_60J");
  assert.deepEqual(r.attemptAllowed(D("2027-04-16")), { allowed: false, refused_by: "FNMA_D2202_CEASE_PRE_SALE_60J", logged_basis: null });
  assert.equal(r.attemptAllowed(D("2027-04-15")).allowed, true);
  const req = preSaleStop({ sale_date: D("2027-06-15"), judicial: true, contact_required_through_sale: true }).attemptAllowed(D("2027-05-01"));
  assert.equal(req.allowed, true); assert.equal(req.logged_basis, "jurisdiction_rules.contact_required_through_sale");
  assert.equal(preSaleStop({ sale_date: D("2027-06-15"), judicial: false }).stop_from, D("2027-05-16"));
});
test("11.1-T17: Given a promise to pay by 2026-12-28 recorded 12-11, then the plan is `ceased{ptp_pending}`; when no covering payment exists at 12-29 00:05, then `promise_to_pay.broken` and the plan resumes the same day.", () => {
  const base = { promised_cents: 416500n, due_on: D("2026-12-28"), recorded_on: D("2026-12-11"), total_delinquent_cents: 416500n };
  const pending = promiseFollowUp({ ...base, covering_payment_cents: null, check_on: D("2026-12-20") });
  assert.equal(pending.plan_after_promise, "ceased{ptp_pending}"); assert.equal(pending.check.event, null);
  const broken = promiseFollowUp({ ...base, covering_payment_cents: null, check_on: D("2026-12-29") });
  assert.equal(broken.check.event, "promise_to_pay.broken"); assert.equal(broken.check.plan, "active"); assert.equal(broken.check.resumed_on, D("2026-12-29"));
  assert.deepEqual(broken.events.map((e) => e.type), ["borrower.promise_to_pay.broken"]); assert.equal(broken.events[0]!.payload.resume_trigger, "promise_broken");
  assert.equal(promiseFollowUp({ ...base, covering_payment_cents: 416500n, check_on: D("2026-12-29") }).check.event, "promise_to_pay.kept");
  // the registry: FNMA_D2202_PTP_FOLLOWUP_30 anchors on the promise date `due_on` (offset 0) — armed by the 11.3 promise.record
  // event on 12-11, it is not due at 12-12; it stands through 12-28 23:59 and the 00:05 check on 12-29 finds it unpaid
  // (`resume cadence (not a breach)`: no severity); a covering payment.applied on 12-27 satisfies it instead
  const h = eiEngine(); h.emit("borrower.promise_to_pay.recorded", { promise_id: "ptp-1", plan: "ceased{ptp_pending}", recorded_on: "2026-12-11", due_on: "2026-12-28", amount_cents: 416500n, covers: "full" }, noonEt("2026-12-11"));
  const t = h.armed("FNMA_D2202_PTP_FOLLOWUP_30")[0]!; assert.equal(t.anchorDate, D("2026-12-28")); assert.equal(t.dueDate, D("2026-12-28"));
  assert.deepEqual(h.breachCodes(atEt("2026-12-12", "00:05")), []); assert.deepEqual(h.breachCodes(atEt("2026-12-28", "23:58")), []);
  const b = h.engine.evaluate(atEt("2026-12-29", "00:05")).find((x) => x.instance.code === "FNMA_D2202_PTP_FOLLOWUP_30")!; assert.equal(b.severity, null); assert.match(b.breachText, /resume cadence \(not a breach\)/);
  const kept = eiEngine(); kept.emit("borrower.promise_to_pay.recorded", { promise_id: "ptp-1", recorded_on: "2026-12-11", due_on: "2026-12-28" }, noonEt("2026-12-11")); kept.emit("payment.applied", { installment_due_date: "2026-11-01", credited_as_of: "2026-12-27" }, noonEt("2026-12-27"));
  assert.equal(kept.byCode("FNMA_D2202_PTP_FOLLOWUP_30")[0]!.status, "satisfied"); assert.deepEqual(kept.breachCodes(atEt("2026-12-29", "00:05")), []);
});
test("11.1-T18: Given `live_contact.ai_voice_counts=false` for state XX, when the AI completes a QRPC dialog on day 22, then `live_contact=false`, `SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD` is due day 31, and a human-verified join on the same call sets a second `contacts` row with `live_contact=true`.", () => {
  const off = aiQrpcWithFlagOff({ due_date: D("2026-11-01"), ai_conversation_on: D("2026-11-23"), human_join: false });
  assert.deepEqual(off.contacts, [{ mode: "ai_voice", live_contact: false, live_contact_basis: "ai_voice_flag_off" }]);
  assert.deepEqual(off.fallback_timer, { code: "SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD", due: D("2026-12-02") }); assert.equal(off.window_live, "open");
  const join = aiQrpcWithFlagOff({ due_date: D("2026-11-01"), ai_conversation_on: D("2026-11-23"), human_join: true });
  assert.equal(join.contacts.length, 2); assert.equal(join.contacts[1]!.live_contact, true); assert.equal(join.contacts[1]!.mode, "human_voice"); assert.equal(join.window_live, "satisfied_live");
  // the registry: the flag-off window emits `regx.ei_window.human_fallback.required{reason=ai_voice_counts_false}` (the counter
  // job's event when the flag is off for the loan), which arms SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD due live_due_at − 5 = day 31;
  // the human-verified join's `contact.attempted{mode=human_voice}` satisfies it
  assert.equal(off.events[0]!.type, "regx.ei_window.human_fallback.required"); assert.equal(off.events[0]!.payload.reason, "ai_voice_counts_false");
  const h = eiEngine(); for (const e of counterRun(D("2026-11-01"), D("2026-11-02"), { ai_voice_counts: false }).events) h.emit(e.type, e.payload, atEt("2026-11-02", "00:05"));
  assert.equal(h.armed("SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD")[0]!.dueDate, D("2026-12-02")); assert.ok(h.breachCodes(atEt("2026-12-03", "00:05")).includes("SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD"));
  const joined = eiEngine(); for (const e of counterRun(D("2026-11-01"), D("2026-11-02"), { ai_voice_counts: false }).events) joined.emit(e.type, e.payload, atEt("2026-11-02", "00:05")); for (const e of join.events) joined.emit(e.type, e.payload, noonEt("2026-11-23"));
  assert.equal(joined.byCode("SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD")[0]!.status, "satisfied");
});
// The T19 text carries all three quote characters ("…", the apostrophe in "call's", the backticks), so no JS literal can spell it without an
// escape; the verbatim spelling rides in the call as a comment (the 6.4-T5 precedent) and the test asserts its own name against the manifest.
test("11.1-T19: Given the borrower says \"I want a person,\" then a warm transfer starts within 10 s, `human_transfer_requested=true`, and the call's live-contact status is determined by the human leg.", async (t) => {
  assert.equal(t.name, MANIFEST_TID("11.1", 19));   // the node:test title is byte-identical to spec/registry/manifest.json
  const t0 = 1_700_000_000_000;
  const r = humanTransferRequest({ utterance: "I want a person", requested_at_ms: t0 });
  assert.equal(r.warm_transfer, true); assert.equal(r.start_by_ms, t0 + 10_000); assert.equal(r.human_transfer_requested, true); assert.equal(r.live_contact_determined_by, "human_leg");
  assert.equal(humanTransferRequest({ utterance: "yes that works", requested_at_ms: t0 }).warm_transfer, false);
  // on the bus: the 11.3 `human.transfer` tool starts the warm transfer (`contact.human_transfer.started{start_within_s=10}`); the AI leg is
  // logged `human_transferred` with `live_contact=false`, and only the human leg's `contacts` row — `mode=human_voice` — carries the live-contact
  // basis (`contact.live.established{basis=human_voice}`), so the call's status is the human leg's
  const ctx = uow(); const agents = new AgentRegistry(); const rt = runtime(ctx);
  const transfer = toolCommand(tool("11.3", "human.transfer"), rt, ["human_agent"]); const log = toolCommand(tool("11.3", "contact.log"), rt, ["human_agent"]);
  agents.registerTool("borrower-comms", transfer.name); agents.registerTool("borrower-comms", log.name);
  const bus = new CommandBus(agents); const comms: Actor = { kind: "agent", id: "borrower-comms" };
  await bus.execute(transfer, comms, { loan_id: "L-11", reason: "borrower asked for a person", human_transfer_requested: true }, ctx);
  const started = ctx.events.all().find((e) => e.type === "contact.human_transfer.started")!; assert.equal(started.payload.start_within_s, 10); assert.equal(started.payload.target, "human_agent");
  const dial = { loan_id: "L-11", direction: "outbound", party_id: "B", phone_number_id: "pn-1", pre_dial_checks: ALL_CHECKS_PASS };
  const ai = (await bus.execute(log, comms, { ...dial, mode: "ai_voice", outcome: "human_transferred", live_contact: false, human_transfer_requested: true }, ctx)).output as Record<string, unknown>;
  const human = (await bus.execute(log, comms, { ...dial, mode: "human_voice", outcome: "conversation", live_contact: true }, ctx)).output as Record<string, unknown>;
  assert.equal(ai.live_contact, false); assert.equal(ai.live_contact_basis, null); assert.equal(human.live_contact, true); assert.equal(human.live_contact_basis, "human_voice");
  const logged = ctx.events.all().filter((e) => e.type === "contact.logged"); assert.equal(logged.length, 2); assert.equal(logged[0]!.payload.mode, "ai_voice"); assert.equal(logged[1]!.payload.mode, "human_voice");
  const live = ctx.events.all().filter((e) => e.type === "contact.live.established"); assert.equal(live.length, 1); assert.equal(live[0]!.payload.basis, "human_voice"); assert.equal(live[0]!.payload.contact_id, logged[1]!.payload.id);
  assert.equal(ctx.events.all().filter((e) => e.type === "contact.attempt.requested").length, 2);   // both legs are recorded dial requests (11.1 gate trigger)
});
test("11.1-T20: Given transfer-in on 2026-10-01 with earliest unpaid due 2026-08-01 (61 days), then window(Aug 1) is `breached_at_boarding`, window(Sep 1) live due 2026-10-07, and a human call task is due 2026-10-03.", () => {
  const ws = seedWindowsAtBoarding([D("2026-08-01"), D("2026-09-01")], D("2026-10-01"));
  assert.equal(ws[0]!.live, "breached_at_boarding"); assert.equal(ws[0]!.notice, "breached_at_boarding");
  assert.equal(ws[1]!.live, "open"); assert.equal(ws[1]!.live_due_at, D("2026-10-07"));
  assert.equal(boardingCallTaskDue(D("2026-10-01")), D("2026-10-03"));
});
test("11.1-T21: Given a landline with no written consent, when a 4th AI-voice call in 30 days is requested, then refused and routed to human dial.", () => {
  const r = selectChannel({ line_type: "landline", tcpa_voice_consent: false, written_consent: false, ai_voice_attempts_30d: 3 });
  assert.equal(r.ai_voice, false); assert.equal(r.refused_by, "TCPA_64_1200_A3_LANDLINE_AI_3IN30"); assert.equal(r.route, "human_manual_dial");
  assert.equal(selectChannel({ line_type: "landline", tcpa_voice_consent: false, written_consent: false, ai_voice_attempts_30d: 2 }).ai_voice, true);
  assert.equal(selectChannel({ line_type: "landline", tcpa_voice_consent: false, written_consent: true, ai_voice_attempts_30d: 9 }).ai_voice, true);
  // the registry: the 4th AI-voice request to the landline records `contact.attempt.requested{mode=ai_voice, line_type=landline, written_consent=false}` —
  // the trigger of TCPA_64_1200_A3_LANDLINE_AI_3IN30 — carrying the three prior AI-voice attempts to the number; the gate arms as an evaluator
  // instance, `11.1.landlineAi3in30` refuses on the event's own facts, the request is refused and routed to a human dial
  const h = eiEngine(); const at = (d: string, t: string) => toIso(zonedEpochMs(D(d), t, "America/Chicago"));
  const prior = [at("2026-11-20", "10:00"), at("2026-11-27", "15:00"), at("2026-12-04", "18:30")];
  const land = { loan_id: "L-11", mode: "ai_voice" as const, dial_at: at("2026-12-10", "11:00"), number_id: "pn-land", person: "B", line_type: "landline" as const, written_consent: false, fdcpa_debt_collector: false, time_zones: ["America/Chicago"], ai_voice_attempts_at: prior };
  const fourth = requestDial(h.events, SYSTEM, null, land);
  assert.equal(fourth.allowed, false); assert.deepEqual([...fourth.refused_by], ["TCPA_64_1200_A3_LANDLINE_AI_3IN30"]); assert.equal(fourth.route, "human_manual_dial"); assert.equal(fourth.checks.consent, false);
  assert.equal(fourth.request.payload.line_type, "landline"); assert.equal(fourth.request.payload.written_consent, false); assert.deepEqual(fourth.request.payload.ai_voice_attempts_at, prior);
  assert.equal(h.armed("TCPA_64_1200_A3_LANDLINE_AI_3IN30").length, 1); assert.equal(h.armed("TCPA_64_1200_A3_LANDLINE_AI_3IN30")[0]!.note, "evaluator:11.1.landlineAi3in30"); assert.equal(h.armed("TCPA_64_1200_A3_LANDLINE_AI_3IN30")[0]!.armedByEventId, fourth.request.id);
  assert.equal(evaluateGate("11.1.landlineAi3in30", fourth.request.payload).open, false);
  assert.ok(!h.events.all().some((e) => e.type === "contact.attempted"));
  // the 3rd attempt (two prior) is permitted; the human dial is unrestricted; with written consent the AI voice is unlimited and the gate never arms (rule 7)
  const third = requestDial(h.events, SYSTEM, null, { ...land, ai_voice_attempts_at: prior.slice(0, 2) }); assert.equal(third.allowed, true); assert.equal(evaluateGate("11.1.landlineAi3in30", third.request.payload).open, true);
  assert.equal(requestDial(h.events, SYSTEM, null, { ...land, mode: "human_voice" }).allowed, true);
  const written = requestDial(h.events, SYSTEM, null, { ...land, written_consent: true }); assert.equal(written.allowed, true); assert.equal(written.request.payload.written_consent, true);
  assert.equal(h.armed("TCPA_64_1200_A3_LANDLINE_AI_3IN30").length, 2);   // the 4th and the 3rd requests without written consent; not the human dial, not the written-consent request
  // an attempt older than 30 days drops out of the trailing window
  const aged = requestDial(h.events, SYSTEM, null, { ...land, ai_voice_attempts_at: [at("2026-11-09", "10:00"), ...prior.slice(1)] }); assert.equal(aged.allowed, true);
  const ev = attemptRequestedEvent(land); assert.equal(ev.type, "contact.attempt.requested"); assert.equal(ev.payload.direction, "outbound"); assert.equal(ev.payload.channel, "voice");
});
test("11.1-T22: Given an investment property, then no Reg X window is created (`not_applicable`) but `FNMA_D2202_OUTBOUND_START_36` and the 7-day cadence run.", () => {
  const r = regxApplicability({ principal_residence: false, due_date: D("2026-11-01") });
  assert.equal(r.regx_window, "not_applicable"); assert.equal(r.fnma.start.code, "FNMA_D2202_OUTBOUND_START_36"); assert.equal(r.fnma.start.due, D("2026-12-07")); assert.equal(r.fnma.cadence_every_days, 7);
  const w = openWindow(D("2026-11-01"), { principal_residence: false }); assert.equal(w.live, "not_applicable"); assert.equal(w.notice, "not_applicable");
  assert.equal(regxApplicability({ principal_residence: true, due_date: D("2026-11-01") }).regx_window, "applies");
  // the registry: the counter job's events for an investment property arm no Reg X clock (`principal_residence=false`) while
  // `loan.delinquency.started` arms FNMA_D2202_OUTBOUND_START_36 (all loans) due 2026-12-07 and the first outbound attempt satisfies it
  const h = eiEngine(); for (const e of counterRun(D("2026-11-01"), D("2026-11-02"), { principal_residence: false }).events) h.emit(e.type, e.payload, atEt("2026-11-02", "00:05"));
  assert.equal(h.byCode("REGX_1024_39A_LIVE_CONTACT_36").length, 0); assert.equal(h.byCode("REGX_1024_39B_WRITTEN_NOTICE_45").length, 0);
  assert.equal(h.armed("FNMA_D2202_OUTBOUND_START_36")[0]!.dueDate, D("2026-12-07"));
  h.emit("contact.attempted", { contact_id: "c1", direction: "outbound", mode: "ai_voice", outcome: "no_answer", on: "2026-11-18" }, noonEt("2026-11-18"));
  assert.equal(h.byCode("FNMA_D2202_OUTBOUND_START_36")[0]!.status, "satisfied"); assert.equal(h.armed("FNMA_D2202_OUTBOUND_EVERY_7")[0]!.dueDate, D("2026-11-25"));   // the 7-day cadence runs
  // day 210: the milestone event continues the cadence every 7 days (policy = Guide "authorized")
  const m = delinquencyMilestone({ today: D("2027-05-30"), earliest_unpaid_due: D("2026-11-01") }); assert.equal(m.milestone, 210); h.emit(m.events[0]!.type, m.events[0]!.payload, noonEt("2027-05-30"));
  assert.equal(h.armed("FNMA_D2202_CONTINUE_AFTER_210")[0]!.dueDate, D("2027-06-06"));
});
test("11.1-T23: Given a two-party-consent state, then the recording disclosure is present in the first 15 s of every recorded call transcript (automated check, 100 %).", () => {
  const ok = recordingDisclosureCheck({ two_party_state: true, transcript: [{ t_s: 3, text: "I'm an automated assistant for Supermortgage. This call is recorded." }, { t_s: 20, text: "How can I help?" }] });
  assert.equal(ok.compliant, true); assert.equal(ok.present_within_15s, true);
  const late = recordingDisclosureCheck({ two_party_state: true, transcript: [{ t_s: 3, text: "Hello" }, { t_s: 22, text: "This call is recorded." }] });
  assert.equal(late.compliant, false);
  assert.equal(recordingDisclosureCheck({ two_party_state: false, transcript: [{ t_s: 3, text: "Hello" }] }).compliant, true);
});
test("11.1-T24: Given `payment.reversed` (NSF) on 2026-12-15 for the Dec 10 application, then installment Nov 1 reopens, window(Nov 1) notice leg is reinstated with `cancel_reason` cleared and `notice_due_at` unchanged (2026-12-16), and 11.2 issues the notice by 12-16 if not already sent.", () => {
  const w = openWindow(D("2026-11-01"), { principal_residence: true });
  installmentPaid(w, D("2026-12-10")); assert.equal(w.notice, "cancelled_paid"); assert.equal(w.cancel_reason, "paid_before_45");
  const r = reinstateOnReversal(w);
  assert.equal(r.notice_reinstated, true); assert.equal(r.live_reinstated, false); assert.equal(w.notice, "open"); assert.equal(w.cancel_reason, null); assert.equal(w.notice_due_at, D("2026-12-16"));
  assert.deepEqual(noticeActionAfterReversal(w, false), { notice_due_at: D("2026-12-16"), action: "issue_by_due" });
  assert.equal(noticeActionAfterReversal(w, true).action, "none_already_sent");
});

test("11.1 worked figures: P $2,000.00 = $1,650.00 + $350.00; two $1,200.00 partials → $2,400.00 suspense applies $2,000.00 and leaves $400.00; late charge $82.50 (5% of P&I); past due $4,165.00; promise $4,000.00", () => {
  // rule 3 — the FIFO projection (2.1/2.2) is the counter's and the conversation's only source
  const nov = FACTS.installments[0]!; assert.equal(nov.pi_cents + nov.escrow_cents, nov.amount_cents); assert.equal(nov.amount_cents, 200000n); assert.equal(nov.pi_cents, 165000n); assert.equal(nov.escrow_cents, 35000n);
  const before = delinquencySnapshot(FACTS, D("2026-12-09")); assert.equal(before.unapplied_cents, 120000n); assert.equal(before.past_due_cents, 400000n);   // $1,200.00 in suspense; Nov 1 + Dec 1 past due
  const after = delinquencySnapshot(FACTS, D("2026-12-11"));
  const applied = after.applied[0]!; assert.equal(applied.satisfied_on, D("2026-12-10")); assert.equal(applied.paid_cents, 200000n);
  assert.equal(after.unapplied_cents, 40000n); assert.equal(applied.paid_cents + after.unapplied_cents, 240000n);   // $2,400.00 suspense ≥ P → $2,000.00 applied, $400.00 unapplied
  assert.equal(after.past_due_cents, 200000n); assert.equal(after.regx_days_delinquent, 10);
  // rule 13 — the late charge is the 2.x fee engine's figure: 5 % of P&I
  assert.equal(lateChargeAmount(165000n, "5", null), 8250n);
  const twoUnpaid: LedgerFacts = { ...FACTS, receipts: [] };
  const call = delinquencySnapshot(twoUnpaid, D("2026-12-17"));
  assert.deepEqual(call.late_charges.map((l) => l.amount_cents), [8250n, 8250n]); assert.equal(call.past_due_cents, 400000n); assert.equal(call.total_delinquent_cents, 416500n); assert.equal(call.stated, "$4,165.00 as of 2026-12-17");
  // Spec 11.3 rule 3 dates the $4,165.00 quote 2026-12-11; the 2.x grace rule assesses the Dec 1 late charge on Dec 17, so on 12-11 the ledger reads $4,082.50 (calendar-correct) — both late charges exist from 12-17.
  assert.equal(delinquencySnapshot(twoUnpaid, D("2026-12-11")).total_delinquent_cents, 408250n);
  // rule 10 — the promise of $4,000.00 is less than the $4,165.00 owed: partial, the cadence continues
  assert.ok(400000n < call.total_delinquent_cents);
});

// ---- 11.1 rules the T-ids exercise through the bus/ingestion paths (not T-ids themselves) ----------------------------

test("11.1 live contact is decided by the outcome, never by the caller's flag alone (comment 39(a)-2; design item 2)", async () => {
  assert.throws(() => liveContactOf({ direction: "outbound", mode: "ai_voice", outcome: "no_answer", live_contact: true }), RangeError);
  assert.throws(() => liveContactOf({ direction: "outbound", mode: "ai_voice", outcome: "answered_unverified", live_contact: true }), RangeError);   // a one-way script with no borrower response
  assert.throws(() => liveContactOf({ direction: "outbound", mode: "ai_voice", outcome: "human_transferred", live_contact: true }), RangeError);    // the human leg decides (T19)
  assert.deepEqual(liveContactOf({ direction: "outbound", mode: "ai_voice", outcome: "voicemail_left", live_contact: false }), { live: false, basis: null });
  assert.deepEqual(liveContactOf({ direction: "outbound", mode: "ai_voice", outcome: "answered_verified", live_contact: true }), { live: true, basis: "ai_voice_flag" });
  assert.deepEqual(liveContactOf({ direction: "outbound", mode: "human_voice", outcome: "conversation", live_contact: true }), { live: true, basis: "human_voice" });
  assert.deepEqual(liveContactOf({ direction: "inbound", mode: "human_voice", outcome: "conversation", live_contact: true }), { live: true, basis: "borrower_initiated" });
  assert.deepEqual(liveContactOf({ direction: "outbound", mode: "human_voice", outcome: "qrpc", live_contact: true, party_id: "agent" }), { live: true, basis: "authorized_agent" });   // comment 39(a)-5
  // on the bus (11.3 contact.log): the flag on a no-answer AI dial is refused before anything is appended; a verified answer establishes live contact
  const ctx = uow(); const agents = new AgentRegistry(); const rt = runtime(ctx);
  const log = toolCommand(tool("11.3", "contact.log"), rt, ["human_agent"]); agents.registerTool("borrower-comms", log.name);
  const bus = new CommandBus(agents); const comms: Actor = { kind: "agent", id: "borrower-comms" };
  const dial = { loan_id: "L-11", direction: "outbound", party_id: "B", phone_number_id: "pn-1", pre_dial_checks: ALL_CHECKS_PASS };
  await assert.rejects(bus.execute(log, comms, { ...dial, mode: "ai_voice", outcome: "no_answer", live_contact: true }, ctx), (e: unknown) => e instanceof RangeError && /spoken outcome/.test(e.message));
  assert.equal(ctx.events.all().length, 0);
  const ok = (await bus.execute(log, comms, { ...dial, mode: "ai_voice", outcome: "answered_verified", live_contact: true }, ctx)).output as Record<string, unknown>;
  assert.equal(ok.live_contact, true); assert.equal(ok.live_contact_basis, "ai_voice_flag");
  assert.equal(ctx.events.all().filter((e) => e.type === "contact.live.established").length, 1); assert.equal(ctx.events.all().filter((e) => e.type === "regx.ei_window.live.satisfied").length, 1);
});

test("11.1 windows re-open from the next payment due date after a dismissal/closure/reaffirmation (§1024.39(c)(2)(i); REGX_1024_39A_RESUME_AFTER_BK_NEXT_DUE)", () => {
  // 14.3's rule-6 decision on the bus (src/app/tools/section14-3.ts → ops-14-3.ts earlyInterventionEvaluation): dismissed 2027-05-03 → resume from 2027-06-01;
  // the 11.1 ingestion hook (ops-11-1.ts attachBankruptcyResumeHooks_11_1, wired by spec-harness.ts) re-opens the windows `after_bk_resume=true`
  const h = eiEngine();
  const decision = h.emit("bankruptcy.early_intervention.evaluated", { trigger: "resume", required: true, timer: "REGX_1024_39C2_RESUME_GATE", status: "dismissed", event_on: "2027-05-03", resume_from_due_date: "2027-06-01", due_dates: ["2027-06-01", "2027-07-01"], case_id: "bk-1" }, noonEt("2027-05-03"));
  const resumed = h.events.all().filter((e) => e.type === "regx.ei_windows.resume_after_bk"); assert.equal(resumed.length, 1);
  assert.equal(resumed[0]!.payload.next_due_date, "2027-06-01"); assert.equal(resumed[0]!.payload.bankruptcy_event, "dismissed"); assert.equal(resumed[0]!.causationId, decision.id); assert.equal(resumed[0]!.loanId, "L-11");
  const opened = h.events.all().filter((e) => e.type === "loan.delinquency.window_opened"); assert.deepEqual(opened.map((e) => e.payload.due_date), ["2027-06-01", "2027-07-01"]); assert.ok(opened.every((e) => e.payload.after_bk_resume === true && e.payload.live_status === "open"));
  const gate = h.byCode("REGX_1024_39A_RESUME_AFTER_BK_NEXT_DUE"); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "satisfied"); assert.equal(gate[0]!.dueDate, D("2027-06-01")); assert.equal(gate[0]!.armedByEventId, resumed[0]!.id);
  // the resumed windows arm their own clocks: live by +36 (2027-07-07 / 2027-08-06), the 11.2 notice by +45
  assert.deepEqual(h.armed("REGX_1024_39A_LIVE_CONTACT_36").map((t) => t.dueDate), [D("2027-07-07"), D("2027-08-06")]);
  assert.deepEqual(h.armed("REGX_1024_39B_WRITTEN_NOTICE_45").map((t) => t.dueDate), [D("2027-07-16"), D("2027-08-15")]);
  // a discharge without reaffirmation: 14.3 publishes `required=false` — nothing re-opens (§1024.39(c)(2)(ii); 11.1-T8)
  h.emit("bankruptcy.early_intervention.evaluated", { trigger: "resume", required: false, timer: null, status: "closed", event_on: "2027-05-03", resume_from_due_date: "2027-06-01" }, noonEt("2027-05-04"));
  assert.equal(h.events.all().filter((e) => e.type === "regx.ei_windows.resume_after_bk").length, 1);
  // a malformed decision (resume date not after the event) is rejected on the record and re-opens nothing
  h.emit("bankruptcy.early_intervention.evaluated", { trigger: "resume", required: true, status: "dismissed", event_on: "2027-05-03", resume_from_due_date: "2027-05-01" }, noonEt("2027-05-04"));
  const rejected = h.events.all().filter((e) => e.type === "regx.ei_windows.resume_after_bk.rejected"); assert.equal(rejected.length, 1); assert.match(String(rejected[0]!.payload.reason), /must follow/);
  assert.equal(h.byCode("REGX_1024_39A_RESUME_AFTER_BK_NEXT_DUE").length, 1); assert.equal(h.events.all().filter((e) => e.type === "loan.delinquency.window_opened").length, 2);
  assert.throws(() => bankruptcyResumeRecord("L-11", { status: "discharged", event_on: "2027-05-03", resume_from_due_date: "2027-06-01" }), RangeError);
  assert.throws(() => bankruptcyResumeRecord(undefined, { status: "dismissed", event_on: "2027-05-03", resume_from_due_date: "2027-06-01" }), RangeError);
  assert.throws(() => bankruptcyResumeRecord("L-11", { status: "reaffirmed", event_on: "2027-05-03", resume_from_due_date: "2027-06-31" }), RangeError);
});
