// 10.3 Final termination @ midpoint
// spec/sections/10-pmi-administration/10-3-final-termination-midpoint.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { ratePercent, levelPayment } from "../../kernel/money/cents.ts";
import { buildSchedule, scheduledDateForPct, midpoint } from "./schedule.ts";
import { rule78Applies, isCurrent, notCurrentGrounds, becameCurrentOn, legacyBoardingTermination, pendingTriggerDate } from "./termination.ts";
import { installmentLedger, WORKED_LOAN } from "./fixtures.ts";
import { midpointSweepCheck, sweepTermination } from "./ops.ts";
import { midpointPreviewCheck, midpointPreviewDue } from "./ops-10-3.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { harness } from "./spec-harness.ts";

/** The 1-unit worked loan on the bus (first payment 2024-05-01, 360 months → `midpoint_termination_date` 2039-05-01). */
const WORKED = (loan_id: string) => ({ loan_id, original_value_cents: WORKED_LOAN.original_value_cents, upb_cents: WORKED_LOAN.upb_cents, annual_rate_pct: WORKED_LOAN.rate_pct, term_months: WORKED_LOAN.term_months, first_due: "2024-05-01" });

const OV = WORKED_LOAN.original_value_cents;
/** The 2-unit worked loan: first payment 2021-04-01, 360 months; every installment due on or before `through` is paid on the mapped date (default on time). */
const twoUnit = (paid: Record<string, string>) => installmentLedger(200, paid, D("2036-04-01"), D("2021-04-01"));

test("10.3-T1: Given the IO 10/20 loan, then `midpoint_termination_date=2039-05-01` and `pending_trigger_date=2039-05-01` (78% date 2040-04-01 is later).", () => {
  const io = buildSchedule({ upb_cents: 38000000n, annual_rate: ratePercent("6.5"), term_months: 240, io_months: 120, first_due: D("2024-05-01") });
  assert.equal(io.pi_cents, 283318n); assert.equal(io.rows[119]!.upb_after_cents, 38000000n);
  const d78 = scheduledDateForPct(io, OV, 78)!.due_date; assert.equal(d78, D("2040-04-01"));
  const m = midpoint(D("2024-05-01"), 360);
  assert.deepEqual(m, { amortization_start: D("2024-04-01"), midpoint_date: D("2039-04-01"), midpoint_termination_date: D("2039-05-01") });
  assert.equal(pendingTriggerDate(d78, m.midpoint_termination_date, true), D("2039-05-01"));
});
test("10.3-T2: Given the 2-unit loan current on 2036-04-01, then `mi.terminated` effective 2036-04-01, LAR 89 code 53 action date `040136`, notice by 2036-05-01, refund by 2036-05-16.", () => {
  assert.equal(midpoint(D("2021-04-01"), 360).midpoint_termination_date, D("2036-04-01"));
  assert.equal(rule78Applies({ consummation: D("2021-03-10"), units: 2, occupancy_at_origination: "principal" }), false);
  const r = sweepTermination({ loan_id: "L-2U", installments: twoUnit({}), scheduled_date: D("2036-04-01"), kind: "automatic_midpoint" });
  assert.equal(r.result.status, "terminated"); const a = r.actions!;
  assert.equal(a.event, "mi.terminated"); assert.equal(a.effective, D("2036-04-01")); assert.deepEqual([a.lar89.code, a.lar89.action_date, a.lar89.line], ["53", "040136", "89 0 L-2U 53 040136"]);
  assert.equal(a.insurer_message.reason, "FNMA_midpoint");
  assert.deepEqual(a.timers.find((t) => t.code === "HPA_4904A_TERMINATION_NOTICE_30")!.due, D("2036-05-01")); assert.deepEqual(a.timers.find((t) => t.code === "HPA_4902F1_REFUND_45")!.due, D("2036-05-16"));
  assert.equal(r.not_current_notice, null);
});
test("10.3-T3: Given the 2-unit loan with the February 2036 installment paid late on 2036-03-05 and the March 2036 installment paid 2036-03-28, when the sweep evaluates `is_current(2036-04-01)` (test month = March 2036; every installment due on or before 2036-03-01 must be paid by 2036-03-31), then the loan is current, termination is effective 2036-04-01 and no not-current notice is sent. Given instead the March installment paid 2036-04-09, then `deferred_not_current`, not-current notice by 2036-05-01, cure 2036-04-09 and termination effective 2036-05-01.", () => {
  const ok = twoUnit({ "2036-02-01": "2036-03-05", "2036-03-01": "2036-03-28" });
  assert.equal(isCurrent(ok, D("2036-04-01")), true); assert.deepEqual(notCurrentGrounds(ok, D("2036-04-01")), []);
  const r = sweepTermination({ loan_id: "L-2U", installments: ok, scheduled_date: D("2036-04-01"), kind: "automatic_midpoint" });
  assert.equal(r.result.status, "terminated"); assert.equal(r.actions!.effective, D("2036-04-01")); assert.equal(r.actions!.lar89.action_date, "040136"); assert.equal(r.not_current_notice, null);
  const late = twoUnit({ "2036-02-01": "2036-03-05", "2036-03-01": "2036-04-09" });
  assert.equal(isCurrent(late, D("2036-04-01")), false); assert.deepEqual(notCurrentGrounds(late, D("2036-04-01")), [D("2036-03-01")]);
  const r2 = sweepTermination({ loan_id: "L-2U", installments: late, scheduled_date: D("2036-04-01"), kind: "automatic_midpoint" });
  assert.equal(r2.result.status, "deferred_not_current");
  assert.equal(r2.not_current_notice!.code, "NTC_HPA_4904B_AUTO_NOT_CURRENT"); assert.equal(r2.not_current_notice!.send_by, D("2036-05-01")); assert.match(r2.not_current_notice!.grounds_text, /^the March 2036 payment was not received by 2036-03-31$/);
  assert.equal(becameCurrentOn(late, D("2036-04-01")), D("2036-04-09")); assert.equal(r2.result.status === "deferred_not_current" && r2.result.cure_on, D("2036-04-09")); assert.equal(r2.actions!.effective, D("2036-05-01"));
});
test("10.3-T4: Given the Flex Mod effective 2029-02-01 with a 480-month term, then `midpoint_termination_date=2049-02-01` and `midpoint_basis='modification'`.", () => {
  const mod = buildSchedule({ upb_cents: 32000000n, annual_rate: ratePercent("6.5"), term_months: 480, first_due: D("2029-02-01"), forborne_principal_cents: 5000000n }, "modification");
  assert.equal(mod.kind, "modification"); assert.equal(mod.rows.length, 480); assert.equal(mod.rows[0]!.due_date, D("2029-02-01"));
  const m = midpoint(mod.rows[0]!.due_date, mod.rows.length);   // the modified amortization period (10.3 R3) — basis = the `modification` schedule version
  assert.equal(m.amortization_start, D("2029-01-01")); assert.equal(m.midpoint_date, D("2049-01-01")); assert.equal(m.midpoint_termination_date, D("2049-02-01"));
  assert.notEqual(midpoint(D("2024-05-01"), 360).midpoint_termination_date, m.midpoint_termination_date, "the consummation-basis midpoint no longer governs");
});
test("10.3-T5: Given a boarded 1998 loan with active MI and current status, then termination on the boarding date, `officer` restitution escalation, and a Sentinel exception.", () => {
  const m = midpoint(D("1999-01-01"), 360);
  assert.deepEqual(m, { amortization_start: D("1998-12-01"), midpoint_date: D("2013-12-01"), midpoint_termination_date: D("2014-01-01") });
  assert.equal(rule78Applies({ consummation: D("1998-11-15"), units: 1, occupancy_at_origination: "principal" }), false);
  const r = legacyBoardingTermination(m.midpoint_termination_date, D("2026-10-01"), true, true);
  assert.deepEqual(r, { terminate_on: D("2026-10-01"), escalate_officer: true, sentinel_exception: "self-identified HPA exception (prior servicer period)", restitution_review: true });
  assert.equal(legacyBoardingTermination(m.midpoint_termination_date, D("2026-10-01"), true, false), null);
  assert.equal(legacyBoardingTermination(D("2030-01-01"), D("2026-10-01"), true, true), null);
});
test("10.3-T6: Given a 15-year loan (first payment 2024-05-01), then midpoint = payment 90 due 2031-10-01 → `midpoint_termination_date=2031-11-01`; the 78% date is compared and the earlier date is the trigger.", () => {
  const s15 = buildSchedule({ upb_cents: 38000000n, annual_rate: ratePercent("6.5"), term_months: 180, first_due: D("2024-05-01") });
  assert.equal(s15.rows[89]!.n, 90); assert.equal(s15.rows[89]!.due_date, D("2031-10-01"));
  const m = midpoint(D("2024-05-01"), 180);
  assert.equal(m.midpoint_date, D("2031-10-01")); assert.equal(m.midpoint_termination_date, D("2031-11-01"));
  const d78 = scheduledDateForPct(s15, OV, 78)!.due_date;
  assert.ok(d78 < m.midpoint_termination_date, `78% date ${d78} comes first on a 15-year schedule`);
  assert.equal(pendingTriggerDate(d78, m.midpoint_termination_date, true), d78);
  assert.equal(pendingTriggerDate(d78, m.midpoint_termination_date, false), m.midpoint_termination_date);   // midpoint-only property
  assert.equal(midpoint(D("2024-05-01"), 181).midpoint_termination_date, D("2031-12-01"));   // odd term: floor + 15 days → following month
});
test("10.3-T7: Given the midpoint termination date passes without a sweep decision, then `HPA_4902C_MIDPOINT_TERMINATE_0` breaches and `officer` sev-1 opens.", async () => {
  const r = midpointSweepCheck({ midpoint_termination_date: D("2039-05-01"), decided_on: null, today: D("2039-05-02") });
  assert.equal(r.timer, "HPA_4902C_MIDPOINT_TERMINATE_0"); assert.equal(r.status, "breached"); assert.deepEqual(r.escalation, { role: "officer", severity: 1 });
  assert.equal(midpointSweepCheck({ midpoint_termination_date: D("2039-05-01"), decided_on: null, today: D("2039-05-01") }).status, "open");
  assert.equal(midpointSweepCheck({ midpoint_termination_date: D("2039-05-01"), decided_on: D("2039-05-01"), today: D("2039-05-02") }).status, "satisfied");
  // On the engine: the schedule arms the 0-day clock on `midpoint_termination_date` 2039-05-01; no sweep decision by the 2039-05-02 evaluation → breached, `officer` sev-1.
  const h = harness("2039-04-01T05:30:00.000Z", "L-3t7");
  await h.run("10.2", "pmi.schedule.rebuild", WORKED("L-3t7"));
  const clock = h.latest("HPA_4902C_MIDPOINT_TERMINATE_0"); assert.equal(clock.anchorDate, D("2039-05-01")); assert.equal(clock.dueDate, D("2039-05-01")); assert.equal(clock.status, "armed");
  assert.deepEqual(h.timers.evaluate("2039-05-01T04:00:00.000Z").map((b) => b.instance.code).filter((c) => c === "HPA_4902C_MIDPOINT_TERMINATE_0"), [], "not yet due on the termination date itself");
  const breach = h.timers.evaluate("2039-05-02T05:30:00.000Z").find((b) => b.instance.code === "HPA_4902C_MIDPOINT_TERMINATE_0");
  assert.ok(breach, "HPA_4902C_MIDPOINT_TERMINATE_0 breaches once the midpoint termination date has passed without a decision");
  assert.equal(breach.severity, 1); assert.deepEqual([...breach.escalateTo], ["officer"]); assert.equal(h.latest("HPA_4902C_MIDPOINT_TERMINATE_0").status, "breached");
  assert.equal(h.events.ofType("timer.breached").filter((e) => e.payload.code === "HPA_4902C_MIDPOINT_TERMINATE_0").length, 1);
});

test("10.3 worked figure: IO 10/20 amortizing P&I $2,833.18", () => { assert.equal(levelPayment(38000000n, ratePercent("6.5"), 240), 283318n); });

test("10.3 SM_MI_MIDPOINT_PREVIEW_90: `mi.schedule.updated` arms the preview 90 days before `midpoint_termination_date`; an incomplete preview queues to the `pmi` agent and leaves the clock open; `mi.midpoint.preview.completed` closes it", async () => {
  // Pure check: the worked loan's preview is due 2039-01-31; the insurer channel missing → incomplete (schedule, original value present)
  assert.equal(midpointPreviewDue(D("2039-05-01")), D("2039-01-31"));
  const base = { midpoint_termination_date: D("2039-05-01"), midpoint_basis: "consummation" as const, schedule_id: "S-1", amortization_start: D("2024-04-01"), amortization_term_months: 360, note_term_months: 360, note_document_hash: "sha256:note", modification_document_hash: null, original_value_cents: OV, insurer_certificate: "CERT-1", insurer: "MGIC", refund_payee: "borrower", refund_estimate_cents: null };
  const pure = midpointPreviewCheck(base); assert.equal(pure.complete, true); assert.deepEqual(pure.missing, []); assert.equal(pure.officer_review, false);
  const noIns = midpointPreviewCheck({ ...base, insurer_certificate: null }); assert.equal(noIns.complete, false); assert.deepEqual(noIns.missing, ["insurer_channel"]); assert.equal(noIns.officer_review, false);
  const badTerm = midpointPreviewCheck({ ...base, note_term_months: 84 }); assert.deepEqual(badTerm.missing, ["note_consistent"]); assert.equal(badTerm.officer_review, true, "a term the note does not support goes to the officer, not guessed");
  // On the bus: the schedule version arms SM_MI_MIDPOINT_PREVIEW_90 anchored 2039-05-01, due 2039-01-31
  const h = harness("2038-12-01T15:00:00.000Z", "L-3pv");
  const def = loadOverriddenRegistry().get("SM_MI_MIDPOINT_PREVIEW_90")!;
  await h.run("10.2", "pmi.schedule.rebuild", WORKED("L-3pv"));
  const armed = h.latest("SM_MI_MIDPOINT_PREVIEW_90"); assert.equal(armed.anchorDate, D("2039-05-01")); assert.equal(armed.dueDate, D("2039-01-31")); assert.equal(armed.status, "armed");
  assert.ok(eventMatches(def.triggerPattern!, h.events.ofType("mi.schedule.updated")[0]!));
  // 1) the pmi agent's preview finds no evidenced original value and no insurer certificate on the policy → `mi.midpoint.preview.incomplete`, queued to `pmi`, clock still armed
  const inc = (await h.run("10.2", "pmi.terminate", { op: "midpoint_preview", loan_id: "L-3pv", amortization_start: "2024-04-01", note_term_months: 360, note_document_hash: "sha256:note", insurer: "MGIC" })) as { complete: boolean; missing: string[]; preview_due: string; queue_id: string | null; officer_escalation_id: string | null };
  assert.equal(inc.complete, false); assert.deepEqual(inc.missing, ["original_value", "insurer_channel"]); assert.equal(inc.preview_due, D("2039-01-31")); assert.equal(inc.officer_escalation_id, null);
  const q = h.escalations.opened.find((e) => e.id === inc.queue_id)!; assert.equal(q.kind, "human_agent"); assert.equal(q.ownerRole, "pmi"); assert.equal(q.payload.timer, "SM_MI_MIDPOINT_PREVIEW_90");
  assert.equal(h.events.ofType("mi.midpoint.preview.incomplete").length, 1); assert.equal(h.events.ofType("mi.midpoint.preview.completed").length, 0);
  assert.equal(h.latest("SM_MI_MIDPOINT_PREVIEW_90").status, "armed"); assert.equal(h.rt.store.get("mi_policies", "L-3pv")!.data.midpoint_preview_status, "incomplete");
  // 2) the original value evidenced and the certificate confirmed → `mi.midpoint.preview.completed` closes the clock on the engine and matches the registry's satisfied pattern
  const done = (await h.run("10.2", "pmi.terminate", { op: "midpoint_preview", loan_id: "L-3pv", amortization_start: "2024-04-01", note_term_months: 360, note_document_hash: "sha256:note", insurer: "MGIC", certificate: "CERT-1", original_value_cents: OV, refund_estimate_cents: "12345" })) as { complete: boolean; missing: string[]; queue_id: string | null; event_id: string };
  assert.equal(done.complete, true); assert.deepEqual(done.missing, []); assert.equal(done.queue_id, null);
  const ev = h.events.ofType("mi.midpoint.preview.completed")[0]!; assert.equal(ev.id, done.event_id);
  assert.ok(eventMatches(def.satisfiedPattern!, ev));
  assert.deepEqual([ev.payload.midpoint_termination_date, ev.payload.midpoint_basis, ev.payload.amortization_term_months, ev.payload.preview_due, ev.payload.original_value_cents, ev.payload.refund_estimate_cents], [D("2039-05-01"), "consummation", 360, D("2039-01-31"), OV, 12345n]);
  assert.deepEqual(ev.payload.insurer_channel, { certificate: "CERT-1", insurer: "MGIC" });
  assert.equal(h.latest("SM_MI_MIDPOINT_PREVIEW_90").status, "satisfied"); assert.equal(h.latest("SM_MI_MIDPOINT_PREVIEW_90").satisfiedByEventId, ev.id);
  assert.equal(h.rt.store.get("mi_policies", "L-3pv")!.data.midpoint_preview_status, "completed"); assert.equal(h.rt.store.get("mi_policies", "L-3pv")!.data.midpoint_termination_date, D("2039-05-01"));
  // 3) an LPMI schedule arms no preview (4905(b)); a policy never previewed breaches on 2039-01-31 → the engine's breach names the `pmi` queue
  const l = harness("2038-12-01T15:00:00.000Z", "L-3lp");
  await l.run("10.2", "pmi.schedule.rebuild", { ...WORKED("L-3lp"), premium_plan: "lpmi" });
  assert.equal(l.timer("SM_MI_MIDPOINT_PREVIEW_90").length, 0);
  const b = harness("2038-12-01T15:00:00.000Z", "L-3br");
  await b.run("10.2", "pmi.schedule.rebuild", WORKED("L-3br"));
  const breach = b.timers.evaluate("2039-02-01T05:30:00.000Z").find((x) => x.instance.code === "SM_MI_MIDPOINT_PREVIEW_90");
  assert.ok(breach); assert.match(breach.breachText, /pmi/); assert.equal(b.latest("SM_MI_MIDPOINT_PREVIEW_90").status, "breached");
  // an empty input is refused
  await assert.rejects(b.run("10.2", "pmi.terminate", { op: "midpoint_preview" }), /loan_id is required/);
});
