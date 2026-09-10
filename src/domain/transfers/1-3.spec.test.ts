// 1.3 RESPA transfer notices (goodbye/hello)
// spec/sections/01-boarding-servicing-transfer-in/1-3-respa-transfer-notices-goodbye-hello.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../../kernel/events/index.ts";
import { loadRegistry, TimerEngine } from "../../kernel/timers/index.ts";
import { cents } from "../../kernel/money/cents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { applyTransferTimerOverrides } from "./timers.ts";
import { applyFifo, regxDaysDelinquent } from "../boarding/delinquency.ts";
import { releaseGate, returnedMail, noticeRecipients, masterServicerOnlyExclusion, approvedPayload, cutoverPayload, planNoticeRun, noticeRunMailed, escalateBreach, orderSkipTrace, MS2_TEMPLATE } from "./inbound.ts";
import { contentCheck, REQUIRED_CONTENT, noticeDates, runScheduledOn, protectedPayment } from "./respa.ts";
import { lateChargeReceivable } from "./reconciliation.ts";
const OFFICER = { kind: "human" as const, id: "u-officer", role: "officer" };
const AGENT: Actor = { kind: "agent", id: "transfer" };
const BATCH = { batch_id: "B1", type: "master_to_sub" as const, transfer_date: D("2026-10-01"), loan_count: 2 };
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const registry = loadRegistry(); applyTransferTimerOverrides(registry);
  return { clock, events, timers: new TimerEngine(registry, events, { processes: ["1.3"] }), esc: new EscalationService(events, clock) };
}
const proofs = (on: string, loans: string[]) => loans.map((loan_id) => ({ loan_id, proof_of_mailing_id: `pom-${loan_id}`, mailed_on: D(on) }));

test("1.3-T1: Given effective date Oct. 1, 2026 and combined mode, when the run is mailed Sept. 16, 2026, then `REGX_1024_33B3_COMBINED_15` is satisfied; mailed Sept. 17 → breached.", () => {
  const approve = (h: ReturnType<typeof harness>) => h.events.append({ type: "transfer.batch.approved", aggregate: { kind: "transfer_batch", id: "B1" }, actor: OFFICER, payload: approvedPayload({ ...BATCH, notice_mode: "combined" }, { d_code: "D12", fnma_consent_document_id: "doc-c", consent_document_hash: "sha256:c" }) });
  // on time: mailed Sept 16 (the goodbye clock the transferor owes is satisfied by the same combined run)
  const a = harness("2026-08-25T14:00:00.000Z"); approve(a);
  const combined = a.timers.byCode("REGX_1024_33B3_COMBINED_15")[0]!, goodbye = a.timers.byCode("REGX_1024_33B3_GOODBYE_15")[0]!;
  assert.equal(combined.dueDate, "2026-09-16"); assert.equal(combined.anchorDate, "2026-10-01"); assert.equal(goodbye.dueDate, "2026-09-16");
  const run = planNoticeRun({ batch_id: "B1", respa_effective_date: D("2026-10-01"), loan_ids: ["L1", "L2"] }, "combined");
  assert.equal(run.template, MS2_TEMPLATE.combined); assert.equal(run.due_at, "2026-09-16");
  a.clock.set("2026-09-16T18:00:00.000Z");
  const partial = noticeRunMailed(a.events, run, proofs("2026-09-16", ["L1"]));
  assert.deepEqual([partial.every_loan, combined.status], [false, "armed"], "one loan mailed does not satisfy the batch's clock");
  const full = noticeRunMailed(a.events, run, proofs("2026-09-16", ["L2"]));
  assert.deepEqual([full.every_loan, full.mailed_count, combined.status, goodbye.status], [true, 2, "satisfied", "satisfied"]);
  assert.equal(full.run_event!.payload.every_loan, true); assert.equal(a.events.ofType("notice.mailed").length, 3);   // 2 per-loan proofs + the run-level event
  // late: nothing mailed by end of Sept 16 → breached on Sept 17; the Sept 17 mailing closes it late
  const b = harness("2026-08-25T14:00:00.000Z"); approve(b);
  const late = b.timers.byCode("REGX_1024_33B3_COMBINED_15")[0]!;
  assert.equal(b.timers.evaluate("2026-09-17T03:00:00.000Z").length, 0, "still Sept 16 in Eastern Time");
  const breaches = b.timers.evaluate("2026-09-17T14:00:00.000Z");
  assert.ok(breaches.some((x) => x.def.code === "REGX_1024_33B3_COMBINED_15")); assert.equal(late.status, "breached"); assert.equal(breaches.find((x) => x.def.code === "REGX_1024_33B3_COMBINED_15")!.severity, 1);
  b.clock.set("2026-09-17T18:00:00.000Z");
  noticeRunMailed(b.events, planNoticeRun({ batch_id: "B1", respa_effective_date: D("2026-10-01"), loan_ids: ["L1", "L2"] }, "combined"), proofs("2026-09-17", ["L1", "L2"]));
  assert.equal(late.status, "satisfied_late");
});
test("1.3-T2: Given separate mode and cutover Oct. 1, 2026, when hello notices are mailed Oct. 16, 2026, then `REGX_1024_33B3_HELLO_15` is satisfied; Oct. 17 → breached with `officer` escalation.", () => {
  const cutover = (h: ReturnType<typeof harness>) => h.events.append({ type: "transfer.batch.cutover_completed", aggregate: { kind: "transfer_batch", id: "B1" }, actor: SYSTEM, payload: cutoverPayload({ ...BATCH, notice_mode: "separate" }) });
  const a = harness("2026-10-01T14:00:00.000Z"); cutover(a);
  const hello = a.timers.byCode("REGX_1024_33B3_HELLO_15")[0]!; assert.equal(hello.dueDate, "2026-10-16");
  assert.equal(a.timers.byCode("REGX_1024_33B3_COMBINED_15").length, 0, "separate mode: no combined clock");
  const run = planNoticeRun({ batch_id: "B1", respa_effective_date: D("2026-10-01"), loan_ids: ["L1", "L2"] }, "hello"); assert.equal(run.template, MS2_TEMPLATE.hello);
  a.clock.set("2026-10-16T18:00:00.000Z"); noticeRunMailed(a.events, run, proofs("2026-10-16", ["L1", "L2"]));
  assert.equal(hello.status, "satisfied");
  const b = harness("2026-10-01T14:00:00.000Z"); cutover(b);
  const lateHello = b.timers.byCode("REGX_1024_33B3_HELLO_15")[0]!;
  const breaches = b.timers.evaluate("2026-10-17T14:00:00.000Z");
  const breach = breaches.find((x) => x.def.code === "REGX_1024_33B3_HELLO_15")!;
  assert.equal(lateHello.status, "breached"); assert.equal(breach.severity, 1); assert.ok(breach.escalateTo.includes("officer"));
  const e = escalateBreach(b.esc, breach, AGENT);
  assert.deepEqual([e.ownerRole, e.kind, e.timer_code], ["officer", "officer", "REGX_1024_33B3_HELLO_15"]);
  assert.equal(b.esc.opened[0]!.batchId, "B1"); assert.ok(b.events.ofType("escalation.created").some((x) => x.payload.owner_role === "officer"));
  b.clock.set("2026-10-17T18:00:00.000Z"); noticeRunMailed(b.events, planNoticeRun({ batch_id: "B1", respa_effective_date: D("2026-10-01"), loan_ids: ["L1", "L2"] }, "hello"), proofs("2026-10-17", ["L1", "L2"]));
  assert.equal(lateHello.status, "satisfied_late");
});
test("1.3-T3: Given effective date Nov. 2, 2026, then goodbye due Oct. 18 (Sunday) and the run is scheduled Oct. 16.", () => {
  const n = noticeDates(D("2026-11-02"));
  assert.equal(n.goodbye_due, "2026-10-18"); assert.equal(runScheduledOn(n.goodbye_due), "2026-10-16");   // Sunday → the vendor's last collection, Friday
  assert.deepEqual([n.hello_due, n.window_end, n.transferor_stops, n.transferee_starts], ["2026-11-17", "2026-12-31", "2026-11-01", "2026-11-02"]);
  const run = planNoticeRun({ batch_id: "B1", respa_effective_date: D("2026-11-02"), loan_ids: ["L1"] }, "goodbye");
  assert.equal(run.due_at, "2026-10-18"); assert.equal(runScheduledOn(run.due_at), "2026-10-16"); assert.equal(run.template, MS2_TEMPLATE.goodbye);
});
test("1.3-T4: Given a rendered notice missing the transferor's toll-free number, then the run cannot be released.", () => {
  const missing = contentCheck(REQUIRED_CONTENT.filter((c) => c !== "transferor_tollfree")).missing;
  assert.deepEqual(missing, ["transferor_tollfree"]);
  const g = releaseGate({ status: "rendered", kind: "hello", transferor_authorization_on_file: true, notices: [{ id: "N-1", checklist_missing: missing, address_valid: true }, { id: "N-2", checklist_missing: [], address_valid: true }] });
  assert.equal(g.ok, false); assert.deepEqual(g.reasons, ["N-1: missing transferor_tollfree"]);
  assert.equal(releaseGate({ status: "qc_passed", kind: "hello", transferor_authorization_on_file: true, notices: [{ id: "N-2", checklist_missing: [], address_valid: true }] }).ok, true);
  assert.match(releaseGate({ status: "qc_passed", kind: "goodbye", transferor_authorization_on_file: false, notices: [] }).reasons[0]!, /transferor's written authorization/);
});
test("1.3-T5: Given a payment due Oct. 1 with 15-day grace received by the transferor Oct. 14 and by Supermortgage Oct. 20, then it posts as of Oct. 14 with no late charge and no delinquency day count.", () => {
  const p = protectedPayment(D("2026-10-14"), D("2026-10-01"), 15, D("2026-10-01"));
  assert.deepEqual(p, { protected: true, credited_as_of: "2026-10-14" });
  // posted with effective_date = transferor receipt: the Oct 1 installment is satisfied Oct 14 → 0 days delinquent on Oct 20; within grace → no late charge (2.7)
  const applied = applyFifo([{ due_date: D("2026-10-01"), amount_cents: cents("2028.53") }], [{ received_on: p.credited_as_of, amount_cents: cents("2028.53") }]);
  assert.equal(applied.installments[0]!.satisfied_on, "2026-10-14");
  assert.equal(regxDaysDelinquent(applied.installments, D("2026-10-20")), 0);
  assert.ok(p.credited_as_of <= addDays(D("2026-10-01"), 15), "received within the 15-day grace: late-charge assessment refused");
});
test("1.3-T6: Given the same payment received by the transferor Oct. 20, then `protected=false` and 2.7 late-charge rules apply.", () => {
  const p = protectedPayment(D("2026-10-20"), D("2026-10-01"), 15, D("2026-10-01"));
  assert.equal(p.protected, false); assert.equal(p.credited_as_of, "2026-10-20");
  assert.ok(D("2026-10-20") > addDays(D("2026-10-01"), 15), "after the last protected receipt date Oct 16");
  assert.equal(lateChargeReceivable(cents("1616.03"), "4"), 6_464n);                                     // 2.7: 4% of P&I, round half-up → $64.64 unless waived
});
test("1.3-T7: Given a payment received by the transferor Nov. 30, 2026 (day 61), then `protected=false`.", () => {
  // Day 1 = Oct 1 → day 60 = Nov 29 (window_end); Nov 30 is day 61. The due date is Dec 1 so the grace period alone would still protect it — only the window rule discriminates.
  assert.equal(noticeDates(D("2026-10-01")).window_end, "2026-11-29");
  assert.equal(protectedPayment(D("2026-11-30"), D("2026-12-01"), 15, D("2026-10-01")).protected, false);
  assert.equal(protectedPayment(D("2026-11-29"), D("2026-12-01"), 15, D("2026-10-01")).protected, true);   // day 60, same due date and grace
  assert.equal(protectedPayment(D("2026-11-30"), D("2026-12-01"), 15, D("2026-12-01")).protected, false);   // before the effective date: not in the window either
});
test("1.3-T8: Given a returned hello notice, then a skip-trace order exists within 5 servicer business days and the original proof of mailing remains linked.", () => {
  const r = returnedMail({ id: "N-hello-7", proof_of_mailing_id: "pom-7" }, D("2026-10-20"));
  assert.equal(r.skip_trace_due, "2026-10-27");                                // 5 servicer business days
  assert.equal(r.original_proof_of_mailing_id, "pom-7"); assert.equal(r.still_satisfies_1024_33, true);
  const { clock, events, timers } = harness("2026-10-20T14:00:00.000Z");
  const o = orderSkipTrace(events, { id: "N-hello-7", loan_id: "L-7", template: MS2_TEMPLATE.hello, proof_of_mailing_id: "pom-7" }, D("2026-10-20"));
  assert.deepEqual([o.order.status, o.order.due, o.order.original_proof_of_mailing_id, o.order.notice_id], ["ordered", "2026-10-27", "pom-7", "N-hello-7"]);
  const t = timers.byCode("FNMA_A2_7_03_RETURNED_NOTICE_SKIP_TRACE_5"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-10-27");   // `mail.returned{template∈RESPA}` armed it
  assert.equal(events.ofType("notice.skip_trace.ordered").length, 1); assert.equal(timers.evaluate("2026-10-27T20:00:00.000Z").length, 0);
  clock.set("2026-10-26T14:00:00.000Z"); events.append({ type: "skiptrace.completed", loanId: "L-7", actor: { kind: "external", id: "skip-trace-vendor" }, payload: { notice_id: "N-hello-7", new_address_found: true, result: "remailed", original_proof_of_mailing_id: "pom-7" } });   // remail (or documented undeliverable) with the original proof still linked
  assert.equal(t[0]!.status, "satisfied");
});
test("1.3-T9: Given an ACP-enrolled borrower, then the notice is addressed to the ACP substitute address only.", () => {
  const rs = noticeRecipients([{ party_id: "B1", role: "borrower", address: "1 Real St", acp_enrolled: true, acp_substitute_address: "PO Box 9999 ACP" }, { party_id: "B2", role: "borrower", address: "2 Other St" }, { party_id: "S1", role: "successor_in_interest", address: "3 Heir St", sii_confirmed: false }]);
  assert.deepEqual(rs, [{ party_id: "B1", address: "PO Box 9999 ACP", via: "acp_substitute" }, { party_id: "B2", address: "2 Other St", via: "own_address" }]);
  assert.ok(!JSON.stringify(rs).includes("1 Real St"));
  assert.throws(() => noticeRecipients([{ party_id: "B3", role: "borrower", address: "x", acp_enrolled: true, acp_substitute_address: null }]), /no substitute address/);
});
test("1.3-T10: Given a master-servicer-only change with identical payee/address/account/amount, then no notices are generated and an `officer` approval record documents the exclusion.", () => {
  const same = { payee: true, address: true, account: true, amount: true };
  assert.equal(masterServicerOnlyExclusion(same, null).block, "suppression needs an officer sign-off verifying no payee/address/account/amount change");
  const r = masterServicerOnlyExclusion(same, OFFICER);
  assert.equal(r.notices_required, false); assert.equal(r.exclusion_record!.approved_by, "u-officer"); assert.match(r.exclusion_record!.basis, /1024\.33\(b\)\(2\)\(i\)\(C\)/);
  assert.equal(masterServicerOnlyExclusion({ ...same, address: false }, OFFICER).notices_required, true);
});
