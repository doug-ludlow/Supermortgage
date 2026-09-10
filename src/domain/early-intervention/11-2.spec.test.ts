// 11.2 Written early intervention notice
// spec/sections/11-early-intervention-collections/11-2-written-early-intervention-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { SECTION_11_TOOLS } from "../../app/tools/section11.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { openWindow, installmentPaid, noticeProvided, sweep, noticeCycle, nextNoticeDue, printHandoffDue, bkModifiedNoticeDue, transfereeFirstNoticeDue, variantFor, applyBankruptcyPetition, cycleEndReview, resumeAfterBankruptcy } from "./windows.ts";
import { eiRenderGate, eiChannel, day45Solicitation, bspAfterQrpc, noticeLegApplicability, dcLoanEiNotice, printFailover, dischargedWindow, counterRun, petitionOverlay, transfereeBoarding, postPetitionPayment, delinquencyMilestone } from "./ops.ts";
import { newPlan, openPlanIfDue } from "./plan.ts";
import { applyEarlyInterventionTimerOverrides } from "./timers.ts";
import { eiEngine, atEt, noonEt } from "./spec-harness.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { NoticeService, type Notice } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { eventMatches } from "../../kernel/events/index.ts";
import { writtenNoticeRequest } from "./ops-11-2.ts";

function uow(loanId = "L-11"): UowContext { const clock = new FixedClock("2027-03-01T15:00:00.000Z"); const events = new MemoryEventStore(clock); return { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: () => {} }; }
function runtime(ctx: UowContext): ToolRuntime { return { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} }; }
const tool = (process: string, name: string) => SECTION_11_TOOLS.find((t) => t.process === process && t.name === name)!;

test("11.2-T1: Given due 2026-11-01 unpaid, then `notice_due_at` = 2026-12-16 and the print hand-off task is due 2026-12-14.", () => {
  const w = openWindow(D("2026-11-01"), { principal_residence: true });
  assert.equal(w.notice, "open"); assert.equal(w.notice_due_at, D("2026-12-16")); assert.equal(printHandoffDue(w.notice_due_at), D("2026-12-14"));
  // the registry: the counter's window_opened arms REGX_1024_39B_WRITTEN_NOTICE_45 due 12-16; only an EI-variant `notice.sent`
  // discharges it — the D2-2-03 payment reminder on 11-20 leaves it armed — and the standard notice on 12-14 also opens the 180-day repeat clock
  const h = eiEngine(); for (const e of counterRun(D("2026-11-01"), D("2026-11-02")).events) h.emit(e.type, e.payload, atEt("2026-11-02", "00:05"));
  assert.equal(h.armed("REGX_1024_39B_WRITTEN_NOTICE_45")[0]!.dueDate, D("2026-12-16"));
  h.emit("notice.sent", { notice_id: "n-reminder", template: "NTC_FNMA_D2_2_03_PAYMENT_REMINDER", sent_at: noonEt("2026-11-20") }, noonEt("2026-11-20"));
  assert.equal(h.byCode("REGX_1024_39B_WRITTEN_NOTICE_45")[0]!.status, "armed"); assert.equal(h.byCode("REGX_1024_39B_NOTICE_180_REPEAT").length, 0);
  h.emit("notice.sent", { notice_id: "n-ei-1", template: "NTC_REGX_39B_EARLY_INTERVENTION", sent_at: noonEt("2026-12-14") }, noonEt("2026-12-14"));
  assert.equal(h.byCode("REGX_1024_39B_WRITTEN_NOTICE_45")[0]!.status, "satisfied"); assert.equal(h.armed("REGX_1024_39B_NOTICE_180_REPEAT")[0]!.dueDate, D("2027-06-12"));
  assert.deepEqual(h.breachCodes(atEt("2026-12-17", "00:05")).filter((c) => c.startsWith("REGX_1024_39B")), []);
});
test("11.2-T2: Given the installment is paid 2026-12-10, then the leg is `cancelled_paid` and no notice is sent; given it is paid 2026-12-17, then the notice must already have been provided by 12-16.", () => {
  const paidEarly = openWindow(D("2026-11-01"), { principal_residence: true });
  installmentPaid(paidEarly, D("2026-12-10"));
  assert.equal(paidEarly.notice, "cancelled_paid"); assert.equal(paidEarly.cancel_reason, "paid_before_45");
  assert.deepEqual(noticeProvided(paidEarly, D("2026-12-14"), "ntc-1", "standard"), { satisfied: false, provided_late: false }); assert.equal(paidEarly.notice, "cancelled_paid"); assert.equal(paidEarly.notice_id, undefined);   // no notice is sent
  // paid 12-17: the leg is not cancelled (payment after day 45) — the notice had to be provided by 12-16
  const paidLate = openWindow(D("2026-11-01"), { principal_residence: true });
  installmentPaid(paidLate, D("2026-12-17")); assert.equal(paidLate.notice, "open");
  assert.deepEqual(noticeProvided(paidLate, D("2026-12-16"), "ntc-2", "standard"), { satisfied: true, provided_late: false }); assert.equal(paidLate.notice, "sent"); assert.equal(paidLate.notice_id, "ntc-2");
  const missed = openWindow(D("2026-11-01"), { principal_residence: true }); installmentPaid(missed, D("2026-12-17"));
  assert.ok(sweep([missed], D("2026-12-17")).includes(missed)); assert.equal(missed.notice, "breached");   // not provided by 12-16 → the notice leg is breached (the live leg breached on 12-08)
  assert.equal(noticeProvided(missed, D("2026-12-17"), "ntc-3", "standard").provided_late, true);
});
test("11.2-T3: Given a notice provided 2026-12-14 and the Dec 1 installment also unpaid, then window(Dec 1).notice = `satisfied_by_prior_180` citing the cycle.", () => {
  const c = noticeCycle(D("2026-12-14"), "standard", "cyc-1"); assert.equal(c.cycle_end_at, D("2027-06-12"));
  const w = openWindow(D("2026-12-01"), { principal_residence: true, active_cycle: c });
  assert.equal(w.notice, "satisfied_by_prior_180"); assert.equal(w.covering_cycle_id, "cyc-1"); assert.equal(w.notice_due_at, D("2027-01-15"));
  assert.equal(openWindow(D("2026-12-01"), { principal_residence: true }).notice, "open");
  // the registry: a window created inside the active cycle carries `notice_status=satisfied_by_prior_180` and arms no day-45 clock (the live leg still does)
  const h = eiEngine(); const r = counterRun(D("2026-12-01"), D("2026-12-02"), { active_cycle: c, first_delinquency: false }); assert.equal(r.events[0]!.payload.notice_status, "satisfied_by_prior_180"); assert.equal(r.events[0]!.payload.covering_cycle_id, "cyc-1");
  for (const e of r.events) h.emit(e.type, e.payload, atEt("2026-12-02", "00:05"));
  assert.equal(h.byCode("REGX_1024_39B_WRITTEN_NOTICE_45").length, 0); assert.equal(h.armed("REGX_1024_39A_LIVE_CONTACT_36").length, 1);
});
test("11.2-T4: Given ≥45 days delinquent on 2027-06-12, then the repeat notice is provided by 2027-06-12 (scheduled 06-10); given the borrower is 20 days delinquent on 2027-06-12 with June 1 unpaid, then the repeat is due 2027-07-16 and moves earlier if a later installment becomes the earliest unpaid.", () => {
  const c = noticeCycle(D("2026-12-14"), "standard", "cyc-1");
  assert.deepEqual(nextNoticeDue(c, 60, D("2026-11-01")), { due_on: D("2027-06-12"), scheduled_on: D("2027-06-10") });
  const twenty = nextNoticeDue(c, 20, D("2027-06-01")); assert.equal(twenty.due_on, D("2027-07-16")); assert.equal(twenty.scheduled_on, D("2027-07-14"));
  // recomputed nightly from the earliest unpaid due date: May 1 unpaid moves the repeat earlier (06-15), July 1 later (08-15)
  assert.equal(nextNoticeDue(c, 42, D("2027-05-01")).due_on, D("2027-06-15"));
  assert.equal(nextNoticeDue(c, 11, D("2027-07-01")).due_on, D("2027-08-15"));
  // the registry: the standard notice on 12-14 arms REGX_1024_39B_NOTICE_180_REPEAT due 2027-06-12; the nightly cycle-end review
  // keeps it when ≥45 days delinquent on 06-12 (it breaches sev-1 on 06-13 with no repeat sent) …
  const atEnd = eiEngine(); atEnd.emit("notice.sent", { notice_id: "n-ei-1", template: "NTC_REGX_39B_EARLY_INTERVENTION", sent_at: noonEt("2026-12-14") }, noonEt("2026-12-14"));
  assert.equal(atEnd.armed("REGX_1024_39B_NOTICE_180_REPEAT")[0]!.dueDate, D("2027-06-12"));
  assert.equal(cycleEndReview(c, { today: D("2027-06-10"), regx_days_delinquent: 58, earliest_unpaid_due: D("2026-11-01") }).reviewed, false);   // before cycle end: no decision, only next_required_by
  const keep = cycleEndReview(c, { today: D("2027-06-12"), regx_days_delinquent: 60, earliest_unpaid_due: D("2026-11-01") }); assert.equal(keep.repeat_required, true); assert.equal(keep.next_required_by, D("2027-06-12")); assert.equal(keep.scheduled_on, D("2027-06-10"));
  for (const e of keep.events) atEnd.emit(e.type, e.payload, atEt("2027-06-12", "00:05"));
  assert.equal(atEnd.byCode("REGX_1024_39B_NOTICE_180_REPEAT")[0]!.status, "armed"); assert.ok(atEnd.breachCodes(atEt("2027-06-13", "00:05")).includes("REGX_1024_39B_NOTICE_180_REPEAT"));
  // … and moves the duty to the June 1 window (due 07-16, its own REGX_1024_39B_WRITTEN_NOTICE_45) when 20 days delinquent on 06-12
  const lt45 = eiEngine(); lt45.emit("notice.sent", { notice_id: "n-ei-1", template: "NTC_REGX_39B_EARLY_INTERVENTION", sent_at: noonEt("2026-12-14") }, noonEt("2026-12-14"));
  const june = counterRun(D("2027-06-01"), D("2027-06-02"), { active_cycle: c }); assert.equal(june.window.notice, "open");   // D+45 = 07-16 lies beyond the cycle end: not covered
  for (const e of june.events) lt45.emit(e.type, e.payload, atEt("2027-06-02", "00:05"));
  const defer = cycleEndReview(c, { today: D("2027-06-12"), regx_days_delinquent: 11, earliest_unpaid_due: D("2027-06-01") }); assert.equal(defer.repeat_required, false); assert.equal(defer.next_required_by, D("2027-07-16"));
  for (const e of defer.events) lt45.emit(e.type, e.payload, atEt("2027-06-12", "00:05"));
  assert.equal(lt45.byCode("REGX_1024_39B_NOTICE_180_REPEAT")[0]!.status, "cancelled"); assert.equal(lt45.byCode("REGX_1024_39B_NOTICE_180_REPEAT")[0]!.cancelledReason, "lt45_at_cycle_end");
  assert.equal(lt45.armed("REGX_1024_39B_WRITTEN_NOTICE_45")[0]!.dueDate, D("2027-07-16")); assert.deepEqual(lt45.breachCodes(atEt("2027-07-16", "23:58")).filter((x) => x.startsWith("REGX_1024_39B")), []);
  assert.ok(lt45.breachCodes(atEt("2027-07-17", "00:05")).includes("REGX_1024_39B_WRITTEN_NOTICE_45"));
});
test("11.2-T5: Given a DC loan with a cease notice and the fdcpa variant provided 2026-12-14, then the repeat is due 2027-06-22 when ≥45 days delinquent at 2027-06-12.", () => {
  assert.equal(variantFor({ bk_active: false, debt_collector: true, cease_active: true }), "fdcpa");
  const f = noticeCycle(D("2026-12-14"), "fdcpa", "cyc-2"); assert.equal(f.cycle_end_at, D("2027-06-22"));
  assert.deepEqual(nextNoticeDue(f, 60, null), { due_on: D("2027-06-22"), scheduled_on: D("2027-06-20") });
  assert.equal(nextNoticeDue(f, 20, D("2027-06-01")).due_on, D("2027-07-16"));   // the "<45" branch: later of +190 and due + 45
  assert.equal(nextNoticeDue(f, 20, D("2027-04-01")).due_on, D("2027-06-22"));
  // the registry: the fdcpa-variant `notice.sent` on 12-14 arms REGX_1024_39D_FDCPA_NOTICE_190 anchored on the send date, due
  // 2027-06-22 (190 days) — not the day after the send; the next fdcpa-variant notice satisfies it, a standard one does not
  const h = eiEngine(); h.emit("notice.sent", { notice_id: "n-ei-fdcpa", template: "NTC_REGX_39D_EARLY_INTERVENTION_FDCPA", sent_at: noonEt("2026-12-14") }, noonEt("2026-12-14"));
  const t = h.armed("REGX_1024_39D_FDCPA_NOTICE_190")[0]!; assert.equal(t.anchorDate, D("2026-12-14")); assert.equal(t.dueDate, D("2027-06-22"));
  assert.deepEqual(h.breachCodes(atEt("2026-12-15", "00:05")), []); assert.deepEqual(h.breachCodes(atEt("2027-06-22", "23:58")), []);
  assert.ok(h.breachCodes(atEt("2027-06-23", "00:05")).includes("REGX_1024_39D_FDCPA_NOTICE_190"));
  const next = eiEngine(); next.emit("notice.sent", { notice_id: "n1", template: "NTC_REGX_39D_EARLY_INTERVENTION_FDCPA" }, noonEt("2026-12-14")); next.emit("notice.sent", { notice_id: "n2", template: "NTC_REGX_39D_EARLY_INTERVENTION_FDCPA" }, noonEt("2027-06-20"));
  assert.equal(next.byCode("REGX_1024_39D_FDCPA_NOTICE_190")[0]!.status, "satisfied"); assert.equal(next.armed("REGX_1024_39D_FDCPA_NOTICE_190")[0]!.dueDate, D("2027-12-27"));
});
test("11.2-T6: Given a Ch. 13 petition 2027-01-20 while delinquent, then a `bk` notice is due 2027-03-06, contains no payment request (checklist), is addressed c/o counsel named on the petition, and a second `bk` notice for the same case is refused; reopening 2027-06-10 creates no new timer.", async () => {
  assert.equal(bkModifiedNoticeDue(D("2027-01-20"), false), D("2027-03-06"));
  const ws = [openWindow(D("2026-11-01"), { principal_residence: true }), openWindow(D("2026-12-01"), { principal_residence: true }), openWindow(D("2027-01-01"), { principal_residence: true })];
  ws[0]!.notice = "sent";
  applyBankruptcyPetition(ws); assert.ok(ws.every((w) => w.live === "exempt_bk")); assert.equal(ws[1]!.notice, "bk_modified_required"); assert.equal(ws[2]!.notice, "bk_modified_required");
  assert.equal(variantFor({ bk_active: true, debt_collector: false, cease_active: false }), "bk");
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGX_39C_EARLY_INTERVENTION_BK", D("2027-03-06"))!;
  const rendered = render(v.source, v.samplePayload); const check = evaluateChecklist(v, v.samplePayload, rendered);
  assert.equal(check.passed, true);
  assert.equal(check.results.find((r) => r.rule_id === "no-payment-request")!.passed, true); assert.doesNotMatch(rendered.text, /amount due|please pay|you must pay/i);
  assert.equal(check.results.find((r) => r.rule_id === "counsel")!.passed, true); assert.match(rendered.text, /c\/o your bankruptcy counsel, A\. Counsel, Esq\., as listed on the petition in case 27-10001/);
  assert.match(rendered.text, /Call us today to learn more about your options/);   // MS-4(A) encouragement survives in the modified variant
  const proSe = { ...v.samplePayload, counsel_name: null }; assert.equal(evaluateChecklist(v, proSe, render(v.source, proSe)).passed, true);   // pro se debtor: notice to the borrower directly
  // the registry: the petition overlay on a delinquent loan emits `regx.ei_notice.bk_modified_required{anchor_on=petition_date}`,
  // arming REGX_1024_39C_BK_MODIFIED_NOTICE_45 due 2027-03-06 — the bk-variant `notice.sent` satisfies it; the standard-variant
  // day-45 clock of the open windows is cancelled (the modified notice governs, "regardless of" the 180-day limitation)
  const h = eiEngine(); for (const due of ["2026-12-01", "2027-01-01"]) for (const e of counterRun(D(due), D(`${due.slice(0, 8)}02`), { first_delinquency: false }).events) h.emit(e.type, e.payload, atEt(`${due.slice(0, 8)}02`, "00:05"));
  const plan = newPlan("L-11"); openPlanIfDue(plan, 40, D("2027-01-10"));
  const overlay = petitionOverlay({ windows: [openWindow(D("2026-12-01"), { principal_residence: true }), openWindow(D("2027-01-01"), { principal_residence: true })], plan, petition_on: D("2027-01-20"), chapter: 13, bk_case_id: "27-10001" });
  h.emit("bankruptcy.petition.filed", { chapter: "13", petition_date: "2027-01-20", case_number_full: "27-10001", fnma_delinquency_days: 80 }, noonEt("2027-01-20")); for (const e of overlay.events) h.emit(e.type, e.payload, noonEt("2027-01-20"));
  const bk = h.armed("REGX_1024_39C_BK_MODIFIED_NOTICE_45"); assert.equal(bk.length, 1); assert.equal(bk[0]!.anchorDate, D("2027-01-20")); assert.equal(bk[0]!.dueDate, D("2027-03-06"));
  assert.ok(h.byCode("REGX_1024_39B_WRITTEN_NOTICE_45").every((t) => t.status === "cancelled" && t.cancelledReason === "bk_modified_required"));
  h.emit("notice.sent", { notice_id: "n-bk", template: "NTC_REGX_39C_EARLY_INTERVENTION_BK", sent_at: noonEt("2027-03-01") }, noonEt("2027-03-01"));
  assert.equal(h.byCode("REGX_1024_39C_BK_MODIFIED_NOTICE_45")[0]!.status, "satisfied"); assert.deepEqual(h.breachCodes(atEt("2027-03-07", "00:05")).filter((c) => c.startsWith("REGX_1024_39")), []);
  // a current borrower's petition (no open notice leg; `fnma_delinquency_days=0`) arms nothing — the timer row reads "while regx_days_delinquent ≥ 1"
  const current = eiEngine(); const curPlan = newPlan("L-11");
  const none = petitionOverlay({ windows: [], plan: curPlan, petition_on: D("2027-01-20"), chapter: 13, bk_case_id: "27-10002" }); assert.ok(!none.events.some((e) => e.type === "regx.ei_notice.bk_modified_required"));
  current.emit("bankruptcy.petition.filed", { chapter: "13", petition_date: "2027-01-20", case_number_full: "27-10002", fnma_delinquency_days: 0 }, noonEt("2027-01-20")); for (const e of none.events) current.emit(e.type, e.payload, noonEt("2027-01-20"));
  assert.equal(current.byCode("REGX_1024_39C_BK_MODIFIED_NOTICE_45").length, 0);
  // … until the first delinquency during the case (anchor: the due date, §1024.31)
  for (const e of counterRun(D("2027-03-01"), D("2027-03-02"), { bankruptcy: "active", bk_case_id: "27-10002", petition_date: D("2027-01-20") }).events) current.emit(e.type, e.payload, atEt("2027-03-02", "00:05"));
  assert.equal(current.armed("REGX_1024_39C_BK_MODIFIED_NOTICE_45")[0]!.dueDate, D("2027-04-15")); assert.equal(current.byCode("REGX_1024_39A_LIVE_CONTACT_36").length, 0);   // (a) is exempt during the case
  // a second bk notice for the same case is refused at the command boundary — from the store's `ei_notice_cycles`, not a caller flag
  const ctx = uow(); const rt = runtime(ctx); const agents = new AgentRegistry(); const cmd = toolCommand(tool("11.2", "notice.render"), rt, ["officer"]); agents.registerTool("default-collections", cmd.name);
  const bus = new CommandBus(agents); const dc: Actor = { kind: "agent", id: "default-collections" };
  rt.store.put("ei_notice_cycles", "cycle-n-bk", { loan_id: "L-11", notice_id: "n-bk", template: "NTC_REGX_39C_EARLY_INTERVENTION_BK", variant: "bk", provided_at: "2027-03-01", bk_case_id: "27-10001", status: "active" }, dc, ctx.clock.now());
  await assert.rejects(bus.execute(cmd, dc, { template_code: "NTC_REGX_39C_EARLY_INTERVENTION_BK", variant: "bk", bk_case_id: "27-10001" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "BK_ONCE_PER_CASE");
  assert.ok(ctx.events.all().some((e) => e.type === "command.refused" && e.payload.code === "BK_ONCE_PER_CASE" && /case 27-10001/.test(String(e.payload.reason))));
  await assert.rejects(bus.execute(cmd, dc, { template_code: "NTC_REGX_39C_EARLY_INTERVENTION_BK", variant: "bk", bk_notice_sent_for_case: true, bk_case_id: "27-10001" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "BK_ONCE_PER_CASE");
  assert.equal(evaluateGate("11.2.onceBkNoticePerCase", { bk_notice_sent_for_case: true }).open, false);
  // reopening 2027-06-10 is the same case (comment 39(c)(2)-1): no new REGX_1024_39C_BK_MODIFIED_NOTICE_45
  assert.equal(bkModifiedNoticeDue(D("2027-06-10"), true), null); assert.equal(h.byCode("REGX_1024_39C_BK_MODIFIED_NOTICE_45").length, 1);
  // dismissal 2027-05-03 → the §11 reaction anchors the resume gate on the next due date (06-01) and the resumed windows satisfy it
  const dismissed = resumeAfterBankruptcy(D("2027-05-03"), [D("2026-12-01"), D("2027-01-01"), D("2027-06-01"), D("2027-07-01")], { bankruptcy_event: "dismissed" }); assert.equal(dismissed.resume_from, D("2027-06-01"));
  h.emit("bankruptcy.status.changed", { to: "dismissed" }, noonEt("2027-05-03")); h.emit(dismissed.events[0]!.type, dismissed.events[0]!.payload, noonEt("2027-05-03"));
  assert.equal(h.armed("REGX_1024_39C_RESUME_NEXT_DUE")[0]!.anchorDate, D("2027-06-01")); assert.equal(h.armed("REGX_1024_39A_RESUME_AFTER_BK_NEXT_DUE")[0]!.dueDate, D("2027-06-01"));
  for (const e of dismissed.events.slice(1)) h.emit(e.type, e.payload, atEt("2027-06-02", "00:05"));
  assert.equal(h.byCode("REGX_1024_39C_RESUME_NEXT_DUE")[0]!.status, "satisfied"); assert.equal(h.byCode("REGX_1024_39A_RESUME_AFTER_BK_NEXT_DUE")[0]!.status, "satisfied");
});
test("11.2-T7: Given a Ch. 7 discharge and no post-petition payment, then no notice is ever due; given a $500 payment applied after the petition date, then the next window's notice leg is `open`.", () => {
  const petition = D("2027-01-20");
  const none = dischargedWindow(D("2027-06-01"), { payment_after_petition: false });
  assert.equal(none.live, "exempt_discharge"); assert.equal(none.notice, "exempt_discharge"); assert.equal(sweep([none], D("2027-12-31")).length, 0);   // never due
  const receipts = [{ received_on: D("2027-05-01"), amount_cents: 50000n }];
  const rearmed = receipts.some((r) => r.received_on >= petition && r.amount_cents > 0n);
  const next = dischargedWindow(D("2027-06-01"), { payment_after_petition: rearmed });
  assert.equal(next.notice, "open"); assert.equal(next.live, "exempt_discharge");   // (a) never resumes; (b) re-arms
  const registry = loadRegistry(); applyEarlyInterventionTimerOverrides(registry);
  const t = registry.get("REGX_1024_39C2II_DISCHARGE_PAYMENT_REARM")!;
  assert.equal(t.triggerPattern!.type, "bankruptcy.status.changed"); assert.deepEqual(t.triggerPattern!.conditions, [{ field: "to", op: "=", value: "discharged" }]);   // 14.x emits the discharge this way
  assert.equal(t.satisfiedPattern!.type, "regx.ei_windows.discharge_rearmed"); assert.equal(t.offsetParsed.kind, "until");
  // the registry: the 14.x discharge arms the re-arm rule and cancels the open legs (`exempt_discharge`); only a payment received
  // on/after the petition date re-arms (b) — the §11 reaction makes the cross-field test and emits the satisfier
  const h = eiEngine(); for (const e of counterRun(D("2027-03-01"), D("2027-03-02")).events) h.emit(e.type, e.payload, atEt("2027-03-02", "00:05"));
  h.emit("bankruptcy.status.changed", { to: "discharged", chapter: "7", mode: "discharge_injunction" }, noonEt("2027-04-15"));
  assert.equal(h.armed("REGX_1024_39C2II_DISCHARGE_PAYMENT_REARM").length, 1); assert.equal(h.byCode("REGX_1024_39A_LIVE_CONTACT_36")[0]!.cancelledReason, "exempt_discharge"); assert.equal(h.byCode("REGX_1024_39B_WRITTEN_NOTICE_45")[0]!.cancelledReason, "exempt_discharge");
  const before = postPetitionPayment({ petition_date: petition, discharged: true, payment: { id: "p-0", received_on: D("2027-01-10"), amount_cents: 50000n } }); assert.equal(before.rearmed, false); assert.deepEqual(before.events, []);
  const after = postPetitionPayment({ petition_date: petition, discharged: true, payment: { id: "p-1", received_on: D("2027-05-01"), amount_cents: 50000n } }); assert.equal(after.rearmed, true);
  for (const e of after.events) h.emit(e.type, e.payload, noonEt("2027-05-01"));
  assert.equal(h.byCode("REGX_1024_39C2II_DISCHARGE_PAYMENT_REARM")[0]!.status, "satisfied");
});
test("11.2-T8: Given transfer-in on 2026-04-12 with the transferor's notice dated 2026-04-10 and May 1 unpaid, then the first notice is due 2026-06-15.", () => {
  const transferOn = D("2026-04-12"), transferorNoticeOn = D("2026-04-10");
  const within45 = transferorNoticeOn <= transferOn && transferorNoticeOn >= D("2026-02-26");
  assert.equal(within45, true);
  const w = openWindow(D("2026-05-01"), { principal_residence: true, transferor_notice_within_45: within45 });
  assert.equal(w.notice, "deferred_transferee"); assert.equal(transfereeFirstNoticeDue(D("2026-05-01")), D("2026-06-15"));
  assert.equal(openWindow(D("2026-05-01"), { principal_residence: true, transferor_notice_within_45: false }).notice, "open");
  // the registry: the §11 transfer-in overlay makes the "transferor notice ≥ transfer_date − 45" test from the boarding data and emits
  // `regx.ei_transferee.deferred{first_post_transfer_due_date}` — REGX_1024_39B_TRANSFEREE_45_AFTER_FIRST_DUE arms due 2026-06-15,
  // the deferred window arms no day-45 clock of its own, and an EI-variant `notice.sent` satisfies it
  const b = transfereeBoarding({ transfer_date: transferOn, transferor_ei_notice_sent_at: transferorNoticeOn, first_post_transfer_due_date: D("2026-05-01") });
  assert.equal(b.deferred, true); assert.equal(b.first_notice_due, D("2026-06-15")); assert.equal(b.events[0]!.type, "regx.ei_transferee.deferred");
  const h = eiEngine(); for (const e of b.events) h.emit(e.type, e.payload, noonEt("2026-04-12")); for (const e of counterRun(D("2026-05-01"), D("2026-05-02"), { transferor_notice_within_45: true }).events) h.emit(e.type, e.payload, atEt("2026-05-02", "00:05"));
  assert.equal(h.armed("REGX_1024_39B_TRANSFEREE_45_AFTER_FIRST_DUE")[0]!.dueDate, D("2026-06-15")); assert.equal(h.byCode("REGX_1024_39B_WRITTEN_NOTICE_45").length, 0);
  h.emit("notice.sent", { notice_id: "n-ei-1", template: "NTC_REGX_39B_EARLY_INTERVENTION", sent_at: noonEt("2026-06-10") }, noonEt("2026-06-10")); assert.equal(h.byCode("REGX_1024_39B_TRANSFEREE_45_AFTER_FIRST_DUE")[0]!.status, "satisfied");
  assert.equal(transfereeBoarding({ transfer_date: transferOn, transferor_ei_notice_sent_at: D("2026-02-01"), first_post_transfer_due_date: D("2026-05-01") }).deferred, false);   // older than 45 days: the transferee's own windows govern
});
test("11.2-T9: Given the assigned-contact block is missing at render, then the send is refused, auto-assignment runs (4.3) and the re-render passes.", async () => {
  const refused = eiRenderGate({ assigned_contact_block_present: false, exclusive_address_present: true });
  assert.equal(refused.send_allowed, false); assert.equal(refused.action, "auto_assign_4_3"); assert.deepEqual(refused.failing, ["continuity_block_present"]);
  const ok = eiRenderGate({ assigned_contact_block_present: true, exclusive_address_present: true });
  assert.equal(ok.send_allowed, true); assert.equal(ok.action, null);
  // the request step (ops-11-2.ts): an EI-variant render whose payload lacks team_name/team_phone, with no active 4.3 episode, is a refused request
  const noticeReg = buildRegistry(); publishAuthored(noticeReg);
  const { team_name: _tn, team_phone: _tp, ...noBlock } = noticeReg.activeVersion("NTC_REGX_39B_EARLY_INTERVENTION", D("2026-12-10"))!.samplePayload as Record<string, unknown>;
  const req = writtenNoticeRequest({ template: "NTC_REGX_39B_EARLY_INTERVENTION", payload: noBlock, active_assignment: null, requested_on: D("2026-12-10") });
  assert.equal(req.ei_variant, "standard"); assert.equal(req.block_source, null); assert.equal(req.gate.action, "auto_assign_4_3"); assert.equal(req.event!.type, "notice.early_intervention_written.requested"); assert.equal(req.event!.payload.assigned_contact_block_present, false);
  const fromEpisode = writtenNoticeRequest({ template: "NTC_REGX_39B_EARLY_INTERVENTION", payload: noBlock, active_assignment: { team_name: "Team 7", direct_number: "(800) 555-0199" }, requested_on: D("2026-12-10") });
  assert.equal(fromEpisode.block_source, "assignment"); assert.equal(fromEpisode.gate.send_allowed, true); assert.equal(fromEpisode.payload.team_phone, "(800) 555-0199");
  assert.equal(writtenNoticeRequest({ template: "NTC_FNMA_D2_2_03_PAYMENT_REMINDER", payload: noBlock, active_assignment: null, requested_on: D("2026-12-10") }).event, null);   // not an EI variant: no request, no gate
  // through the bus, on the registry: the 11.2 notice.render tool appends the request — the trigger of the 4.3 gate REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE — and refuses the send with its code
  const clock = new FixedClock("2026-12-10T15:00:00.000Z"); const events = new MemoryEventStore(clock);
  const registry = loadRegistry(); applyEarlyInterventionTimerOverrides(registry);
  const engine = new TimerEngine(registry, events, { processes: ["4.3", "11.2"] });
  const ctx: UowContext = { loanId: "L-11", events, ledger: new MemoryLedger(), timers: engine, clock, decide: () => {} };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }) };
  const agents = new AgentRegistry(); const cmd = toolCommand(tool("11.2", "notice.render"), rt, ["officer"]); agents.registerTool("default-collections", cmd.name); const bus = new CommandBus(agents); const dc: Actor = { kind: "agent", id: "default-collections" };
  const recipients = [{ partyId: "p-1", name: "Pat Borrower", mailingAddress: "1 Test St, Testville TX 75001" }];
  await assert.rejects(bus.execute(cmd, dc, { template_code: "NTC_REGX_39B_EARLY_INTERVENTION", payload: noBlock, recipients }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE");
  const requested = events.all().filter((e) => e.type === "notice.early_intervention_written.requested"); assert.equal(requested.length, 1);
  assert.equal(requested[0]!.payload.template, "NTC_REGX_39B_EARLY_INTERVENTION"); assert.equal(requested[0]!.payload.variant, "standard"); assert.equal(requested[0]!.payload.assigned_contact_block_present, false); assert.equal(requested[0]!.payload.action, "auto_assign_4_3");
  const gateDef = registry.get("REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE")!; assert.ok(eventMatches(gateDef.triggerPattern!, requested[0]!));
  const gate = engine.byCode("REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE"); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "armed"); assert.equal(gate[0]!.loanId, "L-11");
  assert.ok(!events.all().some((e) => e.type === "notice.rendered" || e.type === "notice.held")); assert.ok(events.all().some((e) => e.type === "command.refused" && e.payload.code === "REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE"));
  // auto-assignment runs (4.3): the re-render names the default team → ensureContinuityAssignment emits `continuity.assigned` (the gate's satisfier; day-45 assignment_due_at 12-16 from the 11-01 due) and the notice carries the block
  const TEAM = { team_name: "Home Retention Team 4", named_human_first_name: "Dana", title: "Senior Loan Counselor", direct_number: "(800) 555-0199", hours: "8 a.m.–8 p.m. Central, Monday–Friday" };
  const out = await bus.execute(cmd, dc, { template_code: "NTC_REGX_39B_EARLY_INTERVENTION", payload: noBlock, recipients, default_team: TEAM, due_unpaid: "2026-11-01", principal_residence: true }, ctx);
  const assigned = events.all().filter((e) => e.type === "continuity.assigned"); assert.equal(assigned.length, 1);
  assert.equal(assigned[0]!.payload.auto_assigned, true); assert.equal(assigned[0]!.payload.trigger, "ei_notice"); assert.equal(assigned[0]!.payload.assigned_on, "2026-12-10"); assert.equal(assigned[0]!.payload.direct_number, "(800) 555-0199");
  assert.ok(eventMatches(gateDef.satisfiedPattern!, assigned[0]!)); assert.ok(engine.byCode("REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE").length >= 1); assert.ok(engine.byCode("REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE").every((t) => t.status === "satisfied"));
  const n = out.output as Notice; assert.equal(n.status, "rendered"); assert.equal(n.checklist.passed, true); assert.ok(n.rendered.text.includes("Call your assigned team directly at (800) 555-0199"));   // (b)(2)(ii): the assigned personnel's number
  const ep = rt.store.get("continuity_episodes", "ep-L-11")!.data; assert.equal(ep.status, "assigned"); assert.equal(ep.assignment_due_at, "2026-12-16"); assert.equal(ep.auto_assigned_by, "ei_notice");
  // a later render finds the assignment on the store: the block is carried from the episode and nothing re-assigns
  const again = await bus.execute(cmd, dc, { template_code: "NTC_REGX_39B_EARLY_INTERVENTION", payload: noBlock, recipients }, ctx);
  assert.equal((again.output as Notice).status, "rendered"); assert.ok((again.output as Notice).rendered.text.includes("(800) 555-0199"));
  assert.equal(events.all().filter((e) => e.type === "continuity.assigned").length, 1); assert.equal(events.all().filter((e) => e.type === "notice.early_intervention_written.requested").at(-1)!.payload.block_source, "assignment");
});
test("11.2-T10: Given no `esign` consent for `regx_ei`, then the channel is mail; given consent and an email bounce, then mail is generated the same day.", () => {
  assert.deepEqual(eiChannel({ esign_consent_regx_ei: false }), { channel: "mail", mail_generated_on: null });
  assert.deepEqual(eiChannel({ esign_consent_regx_ei: true, bounced_on: D("2026-12-14") }), { channel: "mail", mail_generated_on: D("2026-12-14") });
  assert.equal(eiChannel({ esign_consent_regx_ei: true }).channel, "electronic");
});
test("11.2-T11: Given no QRPC by day 45, then a BSP (745 + 710) is sent with the EI notice in the same envelope, `hope_hotline_present=true`, and a `Borrower Solicitation Package` action event exists.", () => {
  const p = day45Solicitation({ qrpc_established: false, resolved: false, regx_days: 45 })!;
  assert.equal(p.kind, "bsp"); assert.deepEqual([...p.contents], ["form_745", "form_710", "document_checklist", "return_envelope", "portal_upload_link"]);
  assert.equal(p.same_envelope_with_ei, true); assert.equal(p.hope_hotline_present, true); assert.equal(p.fnma_action_event, "Borrower Solicitation Package");
  assert.equal(day45Solicitation({ qrpc_established: true, resolved: false, regx_days: 45 }), null);
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_FNMA_D2204_SOLICITATION_PACKAGE", D("2026-12-16"))!;
  assert.ok(render(v.source, v.samplePayload).text.includes("1-888-995-HOPE"));
  // the registry: the counter job's `loan.delinquency.day_reached{day=45, qrpc_established=false, resolved=false}` arms
  // FNMA_D2204_SOLICITATION_45 due the same day; `solicitation_package.sent` satisfies it; with QRPC achieved nothing arms
  const m = delinquencyMilestone({ today: D("2026-12-16"), earliest_unpaid_due: D("2026-11-01"), qrpc_established: false, resolved: false }); assert.equal(m.milestone, 45);
  const h = eiEngine(); for (const e of m.events) h.emit(e.type, e.payload, atEt("2026-12-16", "00:05"));
  assert.equal(h.armed("FNMA_D2204_SOLICITATION_45")[0]!.dueDate, D("2026-12-16"));
  h.emit("solicitation_package.sent", { notice_id: "n-bsp", kind: "bsp", trigger: "day45_no_qrpc", fnma_action: "Borrower Solicitation Package" }, noonEt("2026-12-16")); assert.equal(h.byCode("FNMA_D2204_SOLICITATION_45")[0]!.status, "satisfied");
  const q = eiEngine(); for (const e of delinquencyMilestone({ today: D("2026-12-16"), earliest_unpaid_due: D("2026-11-01"), qrpc_established: true }).events) q.emit(e.type, e.payload, atEt("2026-12-16", "00:05")); assert.equal(q.byCode("FNMA_D2204_SOLICITATION_45").length, 0);
});
test("11.2-T12: Given QRPC on day 30 with no resolution and no prior BSP, then a BSP is sent within 3 servicer BD; given a prior BSP exists, then none is sent and the decision cites it.", async () => {
  const r = bspAfterQrpc({ qrpc_on: D("2026-12-01"), prior_bsp_id: null });
  assert.equal(r.send, true); assert.equal(r.due, D("2026-12-04"));
  const prior = bspAfterQrpc({ qrpc_on: D("2026-12-01"), prior_bsp_id: "bsp-1" });
  assert.equal(prior.send, false); assert.equal(prior.decision_cites, "bsp-1");
  // the registry: the 11.3 qrpc.capture event `contact.qrpc.established{resolution_status=none, prior_bsp_id is null}` arms
  // FNMA_D2204_BSP_AFTER_QRPC_3BD due 3 servicer business days after the QRPC date; a prior BSP on the store arms nothing
  const h = eiEngine(); h.emit("contact.qrpc.established", { qrpc_id: "q1", contact_id: "ct-1", resolution_status: "none", plan_status: "active", prior_bsp_id: null, achieved_at: noonEt("2026-12-01") }, noonEt("2026-12-01"));
  assert.equal(h.armed("FNMA_D2204_BSP_AFTER_QRPC_3BD")[0]!.dueDate, D("2026-12-04"));
  h.emit("solicitation_package.sent", { notice_id: "n-bsp", kind: "bsp", trigger: "qrpc_no_resolution" }, noonEt("2026-12-03")); assert.equal(h.byCode("FNMA_D2204_BSP_AFTER_QRPC_3BD")[0]!.status, "satisfied");
  const p = eiEngine(); p.emit("contact.qrpc.established", { qrpc_id: "q2", contact_id: "ct-2", resolution_status: "none", prior_bsp_id: "bsp-1", achieved_at: noonEt("2026-12-01") }, noonEt("2026-12-01")); assert.equal(p.byCode("FNMA_D2204_BSP_AFTER_QRPC_3BD").length, 0);
  const w = eiEngine(); w.emit("contact.qrpc.established", { qrpc_id: "q3", contact_id: "ct-3", resolution_status: "workout_in_progress", prior_bsp_id: null }, noonEt("2026-12-01")); assert.equal(w.byCode("FNMA_D2204_BSP_AFTER_QRPC_3BD").length, 0);
  // through the bus: qrpc.capture reads `prior_bsp_id` from the store's `solicitation_packages` (a print.request of the BSP writes it)
  const ctx = uow(); const rt = runtime(ctx); const agents = new AgentRegistry(); const cmd = toolCommand(tool("11.3", "qrpc.capture"), rt, ["human_agent", "lossmit_reviewer"]); agents.registerTool("borrower-comms", cmd.name); const bus = new CommandBus(agents); const comms: Actor = { kind: "agent", id: "borrower-comms" };
  const conv = { verified_party: "borrower", reason_primary: "unemployment", hardship_nature: "temporary", occupancy_status: "borrower_occupied_principal", ability_to_pay: { commitment_kind: "brp_submission" }, options_explained: ["repayment plan"], commitment_kind: "brp_submission", payment_importance_emphasized: true };
  const elements = { reason: { value: "unemployment", evidence_span: "00:41-00:52" }, occupancy: { value: "principal", evidence_span: "01:10-01:15" }, ability_to_pay: { value: "can_pay_partial", evidence_span: "02:02-02:20" }, options: { value: ["repayment plan"], evidence_span: "02:30-03:05" }, commitment: { value: "brp_submission", evidence_span: "03:10-03:25" } };
  await bus.execute(cmd, comms, { loan_id: "L-11", contact_id: "ct-q", ai_voice_counts: true, conversation: conv, elements }, ctx);
  assert.equal(ctx.events.all().find((e) => e.type === "contact.qrpc.established")!.payload.prior_bsp_id, null);
  rt.store.put("solicitation_packages", "bsp-1", { loan_id: "L-11", kind: "bsp", sent_at: "2026-11-20T15:00:00.000Z" }, comms, ctx.clock.now());
  const ctx2 = uow(); await bus.execute(cmd, comms, { loan_id: "L-11", contact_id: "ct-q2", id: "qrpc-2", ai_voice_counts: true, conversation: conv, elements }, ctx2);
  assert.equal(ctx2.events.all().find((e) => e.type === "contact.qrpc.established")!.payload.prior_bsp_id, "bsp-1");
});
test("11.2-T13: Given an investment property, then no Reg X notice leg exists but `FNMA_D2204_SOLICITATION_45` runs.", () => {
  const r = noticeLegApplicability({ principal_residence: false, due_date: D("2026-11-01") });
  assert.equal(r.regx_notice_leg, "not_applicable"); assert.deepEqual(r.fnma_solicitation_45, { code: "FNMA_D2204_SOLICITATION_45", due: D("2026-12-16") });
  assert.equal(noticeLegApplicability({ principal_residence: true, due_date: D("2026-11-01") }).regx_notice_leg, "open");
});
test("11.2-T14: Given a DC loan inside its Reg F validation period, then the EI notice carries the §1006.18(e) disclosure and no language demanding payment within the validation period (overshadowing check).", () => {
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGX_39D_EARLY_INTERVENTION_FDCPA", D("2026-12-14"))!;
  const text = render(v.source, v.samplePayload).text;
  const r = dcLoanEiNotice({ text, validation_end: D("2026-11-08"), ref_date: D("2026-10-20"), in_validation_period: true });
  assert.equal(r.fragment_present, true); assert.deepEqual([...r.overshadow_issues], []); assert.equal(r.accepted, true);
  const bad = dcLoanEiNotice({ text: text + " You must pay within 10 days.", validation_end: D("2026-11-08"), ref_date: D("2026-10-20"), in_validation_period: true });
  assert.equal(bad.accepted, false);
});
test("11.2-T15: Given the print vendor fails on 2026-12-14, then the secondary vendor mails on 12-15 and the timer is satisfied; given both fail through 12-16, then a breach with `officer` escalation is recorded and the notice mails 12-17.", () => {
  const ok = printFailover({ primary_failed_on: D("2026-12-14"), secondary_available: true, notice_due: D("2026-12-16") });
  assert.equal(ok.mailed_on, D("2026-12-15")); assert.equal(ok.vendor, "secondary"); assert.equal(ok.timer_satisfied, true); assert.equal(ok.breached, false);
  const both = printFailover({ primary_failed_on: D("2026-12-14"), secondary_available: false, notice_due: D("2026-12-16"), recovered_on: D("2026-12-17") });
  assert.equal(both.mailed_on, D("2026-12-17")); assert.equal(both.breached, true); assert.deepEqual(both.escalation, { role: "officer" });
});
