// 10.2 Automatic termination @78% LTV
// spec/sections/10-pmi-administration/10-2-automatic-termination-78-ltv.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { ratePercent, levelPayment } from "../../kernel/money/cents.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { buildSchedule, armResetVersion, thresholdCents, scheduledDateForPct, midpoint } from "./schedule.ts";
import { rule78Applies, automaticTermination, lpmiOptionsNoticeDue, pendingTriggerDate } from "./termination.ts";
import { installmentLedger, WORKED_LOAN } from "./fixtures.ts";
import { ET, sweepTermination, sweepMissedCheck, lar89AckStatus, statementMiGuard, nyPremiumGate } from "./ops.ts";
import { cureDetected, lar89ReportingFields, ltvSnapshot, parseLar89Feedback } from "./ops-10-2.ts";
import { harness, BORROWER, PROCESSES_10 } from "./spec-harness.ts";

const OV = WORKED_LOAN.original_value_cents;
const TERMS = { loan_id: "L-2", original_value_cents: OV, upb_cents: 38000000n, annual_rate_pct: "5.5", term_months: 360, first_due: "2024-05-01" };
/** The worked loan (10.1: $380,000 at 6.50%, first due 2024-05-01): the initial schedule reaches 78% ($312,000.00) with payment 135 due 2035-07-01. */
const WORKED = (loan_id: string) => ({ loan_id, original_value_cents: OV, upb_cents: WORKED_LOAN.upb_cents, annual_rate_pct: WORKED_LOAN.rate_pct, term_months: WORKED_LOAN.term_months, first_due: "2024-05-01" });
const SWEEP_0030 = "2035-07-01T05:30:00.000Z";                    // the nightly sweep, 00:30 loan-calendar time (CDT)
const WITH_51 = [...PROCESSES_10, "5.1"];                         // Section 5.1's FNMA_IRM_LAR89_PERIOD_END is armed by §10's `mi.terminated`
const CURRENT_ON_0701 = () => installmentLedger(140, { "2035-06-01": "2035-06-12" }, D("2035-07-01"));
const CLOSE_0802 = zonedEpochMs(D("2035-08-02"), "17:00", ET);   // BD2 Aug 2035 17:00 ET — the July 2035 period close (R6)
type Sweep = { result: { status: string; cure_on?: string | null }; actions: { effective: string; lar89: { action_date: string } } | null; not_current_notice: { installments: string[]; grounds_text: string } | null };

test("10.2-T1: Given the worked loan current on 2035-07-01, when the sweep runs 2035-07-01 00:30, then `mi.terminated` effective 2035-07-01, LAR 89 `…89 0 <loan> 53 070135`, insurer message queued, escrow interim analysis requested, timers `HPA_4904A_TERMINATION_NOTICE_30` (due 2035-07-31) and `HPA_4902F1_REFUND_45` (due 2035-08-15) started.", async () => {
  const r = sweepTermination({ loan_id: "1234567890", installments: CURRENT_ON_0701(), scheduled_date: D("2035-07-01") });
  assert.equal(r.result.status, "terminated"); const a = r.actions!;
  assert.equal(a.event, "mi.terminated"); assert.equal(a.effective, D("2035-07-01"));
  assert.equal(a.lar89.line, "89 0 1234567890 53 070135");
  assert.equal(a.insurer_message.queued, true); assert.equal(a.escrow_interim_analysis.requested, true);
  assert.deepEqual(a.timers.find((t) => t.code === "HPA_4904A_TERMINATION_NOTICE_30"), { code: "HPA_4904A_TERMINATION_NOTICE_30", due: D("2035-07-31") });
  assert.deepEqual(a.timers.find((t) => t.code === "HPA_4902F1_REFUND_45"), { code: "HPA_4902F1_REFUND_45", due: D("2035-08-15") });
  // On the bus: the schedule arms the 0-day clock on 2035-07-01; the 00:30 sweep terminates, the canonical event carries the LAR 89 code and the 5.1 period-end anchor, and the R-F clocks start on the engine.
  const h = harness(SWEEP_0030, "L-21", WITH_51);
  const v = (await h.run("10.2", "pmi.schedule.rebuild", WORKED("L-21"))) as { derived_78_date: string };
  assert.equal(v.derived_78_date, D("2035-07-01")); assert.equal(h.latest("HPA_4902B_AUTO_TERMINATE_0").dueDate, D("2035-07-01"));
  const out = (await h.run("10.2", "pmi.terminate", { loan_id: "L-21", scheduled_date: "2035-07-01", installments: CURRENT_ON_0701(), escrowed: true })) as Sweep;
  assert.equal(out.result.status, "terminated"); assert.equal(out.actions!.lar89.action_date, "070135");
  const term = h.events.ofType("mi.terminated")[0]!;
  assert.deepEqual([term.payload.effective, term.payload.lar89_action_code, term.payload.lar89_action_date, term.payload.period_end_date], [D("2035-07-01"), "53", "070135", D("2035-07-31")]);
  assert.equal(h.latest("HPA_4902B_AUTO_TERMINATE_0").status, "satisfied");
  assert.equal(h.latest("HPA_4904A_TERMINATION_NOTICE_30").dueDate, D("2035-07-31")); assert.equal(h.latest("HPA_4902F1_REFUND_45").dueDate, D("2035-08-15"));
  assert.equal(h.latest("HPA_4902E_STOP_PREMIUM_30").dueDate, D("2035-07-31")); assert.equal(h.latest("MI_INSURER_CANCEL_NOTICE_45").anchorDate, D("2035-07-01"));
  assert.equal(h.latest("SM_MI_LAR89_INTERNAL_TARGET_NEXTBD_2000").dueDate, D("2035-07-02"));
  const pe = h.latest("FNMA_IRM_LAR89_PERIOD_END"); assert.equal(pe.anchorDate, D("2035-07-31")); assert.equal(pe.dueDate, D("2035-08-02")); assert.equal(toIso(pe.dueAt!), toIso(CLOSE_0802));
  assert.equal(h.rt.store.get("mi_terminations", "L-21-2035-07-01")!.data.lar89_action_code, "53"); assert.equal(h.rt.store.get("mi_policies", "L-21")!.data.terminated_on, D("2035-07-01"));
  // the LAR 89 queued to fnma-lsdu the next business day meets the policy target
  h.clock.set("2035-07-02T14:00:00.000Z");
  await h.run("10.2", "investor_events.emit", { loan_id: "L-21", event_type: "mi_discontinuance", action_code: "53", action_date: "070135" });
  assert.equal(h.latest("SM_MI_LAR89_INTERNAL_TARGET_NEXTBD_2000").status, "satisfied");
});
test("10.2-T2: Given the June 2035 installment unpaid on 2035-06-30, then status `deferred_not_current`, `NTC_HPA_4904B_AUTO_NOT_CURRENT` sent by 2035-07-31; when June and July are paid 2035-07-20, then termination effective 2035-08-01.", async () => {
  const r = sweepTermination({ loan_id: "L1", installments: installmentLedger(140, { "2035-06-01": "2035-07-20", "2035-07-01": "2035-07-20" }, D("2035-07-01")), scheduled_date: D("2035-07-01") });
  assert.equal(r.result.status, "deferred_not_current");
  assert.equal(r.not_current_notice!.code, "NTC_HPA_4904B_AUTO_NOT_CURRENT"); assert.equal(r.not_current_notice!.send_by, D("2035-07-31")); assert.deepEqual(r.not_current_notice!.installments, [D("2035-06-01")]);
  assert.equal(r.result.status === "deferred_not_current" && r.result.cure_on, D("2035-07-20")); assert.equal(r.actions!.effective, D("2035-08-01")); assert.equal(r.actions!.lar89.action_date, "080135");
  assert.deepEqual(cureDetected(installmentLedger(140, { "2035-06-01": "2035-07-20", "2035-07-01": "2035-07-20" }, D("2035-07-20")), D("2035-07-01")), { became_current_on: D("2035-07-20"), effective_on: D("2035-08-01") });
  // On the bus: the 2035-07-01 sweep defers (June unpaid at 2035-06-30), the not-current notice closes its 30-day clock, and the 2035-07-20 review
  // (payments applied) emits `loan.became_current` → HPA_4902B2_CURE_TERMINATE_1ST anchored 2035-07-20, due 2035-08-01, closed by `mi.terminated` effective 2035-08-01.
  const h = harness(SWEEP_0030, "L-22");
  await h.run("10.2", "pmi.schedule.rebuild", WORKED("L-22"));
  const sweep = (await h.run("10.2", "pmi.terminate", { loan_id: "L-22", scheduled_date: "2035-07-01", installments: installmentLedger(140, { "2035-06-01": null, "2035-07-01": null }, D("2035-07-01")) })) as Sweep;
  assert.equal(sweep.result.status, "deferred_not_current"); assert.equal(sweep.actions, null); assert.deepEqual(sweep.not_current_notice!.installments, [D("2035-06-01")]);
  assert.equal(h.rt.store.get("mi_policies", "L-22")!.data.auto_status, "deferred_not_current"); assert.equal(h.latest("HPA_4902B_AUTO_TERMINATE_0").status, "satisfied");
  const nc = h.latest("HPA_4904B2B_AUTO_NOT_CURRENT_NOTICE_30"); assert.equal(nc.anchorDate, D("2035-07-01")); assert.equal(nc.dueDate, D("2035-07-31"));
  assert.equal(h.timer("HPA_4902B2_CURE_TERMINATE_1ST").length, 0, "no cure clock until the borrower becomes current"); assert.equal(h.events.ofType("loan.became_current").length, 0);
  h.clock.set("2035-07-05T15:00:00.000Z");
  const n = (await h.run("10.2", "notices.*", { template_code: "NTC_HPA_4904B_AUTO_NOT_CURRENT", loan_id: "L-22", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4904B_AUTO_NOT_CURRENT"), notice_date: "2035-07-05", scheduled_termination_on: "2035-07-01", grounds_text: sweep.not_current_notice!.grounds_text } })) as { status: string; rendered: { text: string } };
  assert.equal(n.status, "sent"); assert.match(n.rendered.text, /because the June 2035 payment was not received by 2035-06-30/);
  assert.equal(nc.status, "satisfied"); assert.ok(nc.satisfiedAt!.slice(0, 10) <= "2035-07-31");
  h.clock.set("2035-07-20T20:00:00.000Z");
  h.raise("payment.applied", { received_on: "2035-07-20", installments_satisfied: ["2035-06-01", "2035-07-01"] });
  const review = (await h.run("10.2", "pmi.terminate", { loan_id: "L-22", scheduled_date: "2035-07-01", installments: installmentLedger(140, { "2035-06-01": "2035-07-20", "2035-07-01": "2035-07-20" }, D("2035-07-20")) })) as Sweep;
  assert.equal(review.result.cure_on, D("2035-07-20")); assert.equal(review.actions!.effective, D("2035-08-01")); assert.equal(review.actions!.lar89.action_date, "080135");
  const cure = h.events.ofType("loan.became_current"); assert.equal(cure.length, 1);
  assert.deepEqual([cure[0]!.payload.became_current_on, cure[0]!.payload.effective_on, cure[0]!.payload.mi_auto_status, cure[0]!.payload.scheduled_date], [D("2035-07-20"), D("2035-08-01"), "deferred_not_current", D("2035-07-01")]);
  const term = h.events.ofType("mi.terminated")[0]!; assert.equal(term.payload.effective, D("2035-08-01")); assert.equal(term.payload.lar89_action_date, "080135"); assert.ok(cure[0]!.sequence < term.sequence, "the cure is evented before the termination");
  const ct = h.latest("HPA_4902B2_CURE_TERMINATE_1ST"); assert.equal(ct.anchorDate, D("2035-07-20")); assert.equal(ct.dueDate, D("2035-08-01")); assert.equal(ct.status, "satisfied"); assert.equal(ct.satisfiedByEventId, term.id);
  const p = h.rt.store.get("mi_policies", "L-22")!.data; assert.deepEqual([p.auto_status, p.became_current_on, p.terminated_on, p.lar89_action_code], ["terminated", D("2035-07-20"), D("2035-08-01"), "53"]);
  assert.equal(h.latest("HPA_4904A_TERMINATION_NOTICE_30").dueDate, D("2035-08-31")); assert.equal(h.latest("HPA_4902F1_REFUND_45").dueDate, D("2035-09-15"));
  assert.equal(h.rt.store.get("mi_terminations", "L-22-2035-08-01")!.data.became_current_on, D("2035-07-20"));
});
test("10.2-T3: Given July paid 2035-08-03 (Scenario C), then effective 2035-09-01 and the not-current notice referenced the June installment only.", async () => {
  const r = sweepTermination({ loan_id: "L1", installments: installmentLedger(140, { "2035-06-01": "2035-07-08", "2035-07-01": "2035-08-03" }, D("2035-08-01")), scheduled_date: D("2035-07-01") });
  assert.equal(r.actions!.effective, D("2035-09-01"));
  assert.deepEqual(r.not_current_notice!.installments, [D("2035-06-01")]); assert.match(r.not_current_notice!.grounds_text, /^the June 2035 payment was not received by 2035-06-30$/);
  // On the bus: the 2035-07-08 review (June paid, July still open) cures nothing; the 2035-08-03 review detects the cure → clock due 2035-09-01, termination effective 2035-09-01.
  const h = harness(SWEEP_0030, "L-23");
  await h.run("10.2", "pmi.schedule.rebuild", WORKED("L-23"));
  const sweep = (await h.run("10.2", "pmi.terminate", { loan_id: "L-23", scheduled_date: "2035-07-01", installments: installmentLedger(140, { "2035-06-01": null, "2035-07-01": null }, D("2035-07-01")) })) as Sweep;
  assert.deepEqual(sweep.not_current_notice!.installments, [D("2035-06-01")]);
  h.clock.set("2035-07-08T20:00:00.000Z");
  const r1 = (await h.run("10.2", "pmi.terminate", { loan_id: "L-23", scheduled_date: "2035-07-01", installments: installmentLedger(140, { "2035-06-01": "2035-07-08", "2035-07-01": null }, D("2035-07-08")) })) as Sweep;
  assert.equal(r1.result.status, "deferred_not_current"); assert.equal(r1.result.cure_on, null); assert.equal(r1.actions, null);
  assert.equal(h.events.ofType("loan.became_current").length, 0); assert.equal(h.timer("HPA_4902B2_CURE_TERMINATE_1ST").length, 0);
  h.clock.set("2035-08-03T20:00:00.000Z");
  const r2 = (await h.run("10.2", "pmi.terminate", { loan_id: "L-23", scheduled_date: "2035-07-01", installments: installmentLedger(140, { "2035-06-01": "2035-07-08", "2035-07-01": "2035-08-03" }, D("2035-08-03")) })) as Sweep;
  assert.equal(r2.result.cure_on, D("2035-08-03")); assert.equal(r2.actions!.effective, D("2035-09-01"));
  const ct = h.latest("HPA_4902B2_CURE_TERMINATE_1ST"); assert.equal(ct.anchorDate, D("2035-08-03")); assert.equal(ct.dueDate, D("2035-09-01")); assert.equal(ct.status, "satisfied");
  assert.equal(h.events.ofType("mi.terminated")[0]!.payload.lar89_action_date, "090135");
  assert.deepEqual(h.events.ofType("mi.auto.deferred_not_current").map((e) => e.payload.grounds), [[D("2035-06-01")]], "the not-current notice grounds name June only");
});
test("10.2-T4: Given the ARM reset at payment 61 to 7.50%, when `loan_terms.rate_changed` posts, then a `arm_reset` schedule version with `derived_78_date=2035-09-01` supersedes 2034-07-01 and the change is evented.", async () => {
  const arm = buildSchedule({ upb_cents: 38000000n, annual_rate: ratePercent("5.5"), term_months: 360, first_due: D("2024-05-01") });
  assert.equal(arm.pi_cents, 215760n); assert.equal(scheduledDateForPct(arm, OV, 78)!.due_date, D("2034-07-01")); assert.equal(arm.rows[59]!.upb_after_cents, 35135017n);
  const reset = armResetVersion(arm, 61, ratePercent("7.5"), 300);
  assert.equal(reset.pi_cents, 259645n); assert.deepEqual([reset.kind, scheduledDateForPct(reset, OV, 78)!.n, scheduledDateForPct(reset, OV, 78)!.due_date], ["arm_reset", 137, D("2035-09-01")]);
  // on the bus: the initial version, then the reset version from `loan_terms.rate_changed` — each evented and each re-arming the 0-day clock on its own 78% date
  const h = harness("2024-05-01T12:00:00.000Z", "L-2");
  const v1 = (await h.run("10.2", "pmi.schedule.rebuild", TERMS)) as { basis: string; derived_78_date: string };
  assert.equal(v1.basis, "initial"); assert.equal(v1.derived_78_date, D("2034-07-01")); assert.equal(h.latest("HPA_4902B_AUTO_TERMINATE_0").dueDate, D("2034-07-01"));
  h.clock.set("2029-05-01T12:00:00.000Z");
  h.raise("loan_terms.rate_changed", { change_n: 61, new_rate_pct: "7.5", effective_on: "2029-05-01" });
  const v2 = (await h.run("10.2", "pmi.schedule.rebuild", { loan_id: "L-2", original_value_cents: OV, prior_version: TERMS, change_n: 61, new_rate_pct: "7.5", remaining_term: 300 })) as { basis: string; derived_78_date: string; schedule_id: string };
  assert.equal(v2.basis, "arm_reset"); assert.equal(v2.derived_78_date, D("2035-09-01"));
  const evs = h.events.ofType("mi.schedule.updated");
  assert.deepEqual(evs.map((e) => [e.payload.basis, e.payload.scheduled_78_date]), [["initial", D("2034-07-01")], ["arm_reset", D("2035-09-01")]]);
  assert.deepEqual(h.timer("HPA_4902B_AUTO_TERMINATE_0").map((t) => t.dueDate), [D("2034-07-01"), D("2035-09-01")]);
  assert.equal(h.rt.store.list("mi_schedules").length, 2); assert.equal(h.rt.store.get("mi_schedules", v2.schedule_id)!.data.derived_78_date, D("2035-09-01"));
});
test("10.2-T5: Given a 2-unit principal residence, then `auto_status='not_applicable_midpoint_only'` and no 78% termination at the scheduled date.", async () => {
  const applicability = { consummation: D("2021-03-10"), units: 2, occupancy_at_origination: "principal" as const };
  assert.equal(rule78Applies(applicability), false);
  assert.equal(automaticTermination(installmentLedger(140), D("2035-07-01"), false).status, "not_applicable_midpoint_only");
  const h = harness("2035-07-01T05:30:00.000Z", "L-25");
  await h.run("10.2", "pmi.schedule.rebuild", { ...TERMS, loan_id: "L-25", applicability });
  assert.equal(h.timer("HPA_4902B_AUTO_TERMINATE_0").length, 0, "no 78% clock for a midpoint-only property"); assert.equal(h.latest("HPA_4902C_MIDPOINT_TERMINATE_0").dueDate, D("2039-05-01"));
  const r = (await h.run("10.2", "pmi.terminate", { loan_id: "L-25", scheduled_date: "2035-07-01", installments: installmentLedger(140, {}, D("2035-07-01")), applicability })) as { result: { status: string }; actions: unknown };
  assert.equal(r.result.status, "not_applicable_midpoint_only"); assert.equal(r.actions, null);
  assert.equal(h.events.ofType("mi.terminated").length, 0); assert.equal(h.events.ofType("mi.coverage.ended").length, 0);
  assert.equal(h.rt.store.get("mi_policies", "L-25")!.data.auto_status, "not_applicable_midpoint_only");
});
test("10.2-T6: Given the sweep did not run (job failure) on the scheduled date, then `HPA_4902B_AUTO_TERMINATE_0` breaches next sweep and `officer` sev-1 opens with the affected loan list.", async () => {
  const r = sweepMissedCheck({ policies: [{ loan_id: "A", scheduled_date: D("2035-07-01"), auto_status: "pending" }, { loan_id: "B", scheduled_date: D("2035-07-01"), auto_status: "pending" }, { loan_id: "C", scheduled_date: D("2035-07-01"), auto_status: "terminated" }], last_sweep_on: D("2035-06-30"), today: D("2035-07-02") });
  assert.equal(r.breached, true); assert.equal(r.timer, "HPA_4902B_AUTO_TERMINATE_0"); assert.equal(r.job_failure, true);
  assert.deepEqual(r.escalation, { role: "officer", severity: 1, affected_loans: ["A", "B"] });
  assert.equal(sweepMissedCheck({ policies: [{ loan_id: "C", scheduled_date: D("2035-07-01"), auto_status: "terminated" }], last_sweep_on: D("2035-07-01"), today: D("2035-07-02") }).breached, false);
  // On the engine: three schedules arm the 0-day clock on 2035-07-01; only C was swept. At the next sweep (2035-07-02 00:30) A's and B's clocks breach
  // sev-1 to the officer, and the sweep's self-check opens the officer item with the affected loan list from the store.
  const h = harness("2035-06-01T05:30:00.000Z", "L-26");
  for (const id of ["A", "B", "C"]) await h.run("10.2", "pmi.schedule.rebuild", WORKED(id));
  h.clock.set(SWEEP_0030);
  await h.run("10.2", "pmi.terminate", { loan_id: "C", scheduled_date: "2035-07-01", installments: CURRENT_ON_0701() });
  const clock = (id: string) => h.timers.byCode("HPA_4902B_AUTO_TERMINATE_0").filter((t) => t.loanId === id).at(-1)!;
  assert.equal(clock("C").status, "satisfied"); assert.deepEqual([clock("A").dueDate, clock("A").status, clock("B").status], [D("2035-07-01"), "armed", "armed"]);
  assert.equal(h.timers.evaluate(h.clock.now()).length, 0, "nothing is overdue on the scheduled date itself");
  h.clock.set("2035-07-02T05:30:00.000Z");
  const breaches = h.timers.evaluate(h.clock.now()).filter((b) => b.def.code === "HPA_4902B_AUTO_TERMINATE_0");
  assert.deepEqual(breaches.map((b) => [b.instance.loanId, b.severity, [...b.escalateTo]]).sort(), [["A", 1, ["officer"]], ["B", 1, ["officer"]]]);
  assert.deepEqual([clock("A").status, clock("B").status, clock("C").status], ["breached", "breached", "satisfied"]);
  const chk = (await h.run("10.2", "pmi.terminate", { op: "missed_sweep", last_sweep_on: "2035-06-30", today: "2035-07-02" })) as { breached: boolean; job_failure: boolean; escalation: { affected_loans: string[] }; escalation_id: string };
  assert.equal(chk.breached, true); assert.equal(chk.job_failure, true); assert.deepEqual(chk.escalation.affected_loans, ["A", "B"]);
  const esc = h.escalations.opened.find((e) => e.id === chk.escalation_id)!;
  assert.deepEqual([esc.kind, esc.ownerRole, esc.severity, esc.payload.timer, esc.payload.affected_loans], ["officer", "officer", "1", "HPA_4902B_AUTO_TERMINATE_0", ["A", "B"]]);
  assert.deepEqual(h.events.ofType("mi.sweep.missed")[0]!.payload.affected_loans, ["A", "B"]);
});
test("10.2-T7: Given the effective date 2035-07-01 and LAR 89 not acked by BD2 Aug 2035 15:00 ET, then timer breach and a `human_portal_task` for single-LAR entry.", async () => {
  const at1500 = zonedEpochMs(D("2035-08-02"), "15:00", ET);
  const r = lar89AckStatus({ effective: D("2035-07-01"), acked_at_ms: null, now_ms: at1500 });
  assert.equal(r.clocks.period_close_on, D("2035-08-02")); assert.equal(toIso(r.clocks.bulk_cutoff_ms), toIso(at1500)); assert.equal(toIso(r.clocks.period_close_ms), toIso(zonedEpochMs(D("2035-08-02"), "17:00", ET)));
  assert.equal(r.status, "bulk_channel_closed"); assert.equal(r.timer_breached, "SM_MI_LAR89_INTERNAL_TARGET_NEXTBD_2000");
  assert.deepEqual(r.human_portal_task, { kind: "single_lar_entry", owner_role: "fnma_portal_operator", by_ms: r.clocks.period_close_ms });
  assert.equal(lar89AckStatus({ effective: D("2035-07-01"), acked_at_ms: zonedEpochMs(D("2035-07-02"), "19:00", ET), now_ms: at1500 }).status, "acked");
  assert.equal(lar89AckStatus({ effective: D("2035-07-01"), acked_at_ms: null, now_ms: zonedEpochMs(D("2035-08-02"), "17:01", ET) }).status, "breached");
  // On the engine (5.1's FNMA_IRM_LAR89_PERIOD_END armed by `mi.terminated`): the LAR 89 queued 2035-07-02 is never acked. At the 15:00 ET bulk cutoff the period is
  // still open (R6: the deadline is the 17:00 ET close) — the ack check opens the single-LAR-entry portal task once; at 17:01 the period-end clock breaches sev-2.
  const h = harness(SWEEP_0030, "L-27", WITH_51);
  await h.run("10.2", "pmi.terminate", { loan_id: "L-27", scheduled_date: "2035-07-01", installments: CURRENT_ON_0701() });
  const pe = h.latest("FNMA_IRM_LAR89_PERIOD_END"); assert.equal(toIso(pe.dueAt!), toIso(CLOSE_0802)); assert.equal(pe.status, "armed");
  const it = h.latest("SM_MI_LAR89_INTERNAL_TARGET_NEXTBD_2000"); assert.equal(it.dueDate, D("2035-07-02"));
  h.clock.set("2035-07-02T14:00:00.000Z");
  await h.run("10.2", "investor_events.emit", { loan_id: "L-27", event_type: "mi_discontinuance", action_code: "53", action_date: "070135" });
  assert.equal(it.status, "satisfied");
  h.clock.set(toIso(at1500));
  assert.equal(h.timers.evaluate(h.clock.now()).some((b) => b.def.code === "FNMA_IRM_LAR89_PERIOD_END"), false, "the July 2035 period closes at 17:00 ET, not at the bulk cutoff");
  const st = (await h.run("10.2", "investor_events.emit", { op: "lar89_status", loan_id: "L-27" })) as { status: string; timer_breached: string | null; portal_task_id: string | null };
  assert.equal(st.status, "bulk_channel_closed"); assert.equal(st.timer_breached, "SM_MI_LAR89_INTERNAL_TARGET_NEXTBD_2000");
  const task = h.escalations.opened.find((e) => e.id === st.portal_task_id)!;
  assert.deepEqual([task.kind, task.ownerRole, task.loanId, task.payload.task, task.payload.record, task.payload.by], ["human_portal_task", "fnma_portal_operator", "L-27", "single_lar_entry", "LAR 89", toIso(CLOSE_0802)]);
  assert.equal(((await h.run("10.2", "investor_events.emit", { op: "lar89_status", loan_id: "L-27" })) as { portal_task_id: string | null }).portal_task_id, null, "one portal task per termination");
  assert.equal(h.events.ofType("investor_events.portal_entry.required").length, 2);
  h.clock.set(toIso(zonedEpochMs(D("2035-08-02"), "17:01", ET)));
  const b = h.timers.evaluate(h.clock.now()).find((x) => x.def.code === "FNMA_IRM_LAR89_PERIOD_END")!;
  assert.equal(b.severity, 2); assert.equal(b.instance.loanId, "L-27"); assert.equal(pe.status, "breached");
  const late = (await h.run("10.2", "investor_events.emit", { op: "lar89_status", loan_id: "L-27" })) as { status: string; timer_breached: string | null; officer_escalation_id: string | null };
  assert.equal(late.status, "breached"); assert.equal(late.timer_breached, "FNMA_IRM_LAR89_PERIOD_END");
  const off = h.escalations.opened.find((e) => e.id === late.officer_escalation_id)!; assert.equal(off.kind, "officer"); assert.equal(off.severity, "2"); assert.equal(off.payload.timer, "FNMA_IRM_LAR89_PERIOD_END");
});
test("10.2-T8: Given a periodic statement generated for the 2035-08-01 installment still including the MI escrow component, then the statement command is blocked by `HPA_4902E_STOP_PREMIUM_30` and an alert opens.", async () => {
  const r = statementMiGuard({ installment_due: D("2035-08-01"), effective: D("2035-07-01"), includes_mi: true });
  assert.equal(r.blocked, true); assert.equal(r.gate, "HPA_4902E_STOP_PREMIUM_30"); assert.equal(r.premium_stop_by, D("2035-07-31")); assert.deepEqual(r.alert, { role: "officer", severity: 1 });
  assert.equal(statementMiGuard({ installment_due: D("2035-08-01"), effective: D("2035-07-01"), includes_mi: false }).blocked, false);
  assert.equal(statementMiGuard({ installment_due: D("2035-07-01"), effective: D("2035-07-01"), includes_mi: true }).blocked, false);
  // On the engine: the termination arms the must-stop-by gate (anchor 2035-07-01, stop by 2035-07-31); the R-F2 statement check blocks the 2035-08-01 statement with MI
  // and opens the officer sev-1 alert; the interim analysis closes the MI line (the gate is satisfied) and the statement without MI passes.
  const h = harness(SWEEP_0030, "L-28");
  await h.run("10.2", "pmi.terminate", { loan_id: "L-28", scheduled_date: "2035-07-01", installments: CURRENT_ON_0701(), escrowed: true });
  const gate = h.latest("HPA_4902E_STOP_PREMIUM_30"); assert.equal(gate.anchorDate, D("2035-07-01")); assert.equal(gate.dueDate, D("2035-07-31")); assert.equal(gate.status, "armed");
  h.clock.set("2035-07-25T12:00:00.000Z");
  type Check = { blocked: boolean; gate: string; premium_stop_by: string | null; alert_id: string | null; gate_status: string | null };
  const blocked = (await h.run("10.2", "pmi.terminate", { op: "statement_check", loan_id: "L-28", installment_due: "2035-08-01", includes_mi: true })) as Check;
  assert.deepEqual([blocked.blocked, blocked.gate, blocked.premium_stop_by, blocked.gate_status], [true, "HPA_4902E_STOP_PREMIUM_30", D("2035-07-31"), "armed"]);
  const alert = h.escalations.opened.find((e) => e.id === blocked.alert_id)!;
  assert.deepEqual([alert.kind, alert.severity, alert.loanId, alert.payload.alert, alert.payload.gate, alert.payload.installment_due], ["officer", "1", "L-28", "statement blocked", "HPA_4902E_STOP_PREMIUM_30", D("2035-08-01")]);
  assert.equal(h.events.ofType("statement.blocked").length, 1);
  assert.equal(((await h.run("10.2", "pmi.terminate", { op: "statement_check", loan_id: "L-28", installment_due: "2035-07-01", includes_mi: true })) as Check).blocked, false, "the installment due on E may still carry the component");
  assert.equal(((await h.run("10.2", "pmi.terminate", { op: "statement_check", loan_id: "L-29x", installment_due: "2035-08-01", includes_mi: true })) as Check).blocked, false, "no coverage end on the loan: nothing to block");
  await h.run("10.2", "escrow.interim_analysis.request", { loan_id: "L-28", effective_on: "2035-07-01", mi_line_balance_cents: 13000n, monthly_mi_deposit_cents: 13000n, old_payment_cents: 283186n, analysis_on: "2035-07-10" });
  assert.equal(gate.status, "satisfied");
  const ok = (await h.run("10.2", "pmi.terminate", { op: "statement_check", loan_id: "L-28", installment_due: "2035-08-01", includes_mi: false })) as Check;
  assert.equal(ok.blocked, false); assert.equal(ok.alert_id, null); assert.equal(ok.gate_status, "satisfied");
  assert.equal(h.events.ofType("statement.blocked").length, 1);
});
test("10.2-T9: Given an LPMI loan with `lpmi_equiv_termination_date=2035-07-01`, then `NTC_HPA_4905C2_LPMI_OPTIONS` is sent by 2035-07-31 and no cancellation occurs.", async () => {
  assert.equal(lpmiOptionsNoticeDue(D("2035-07-01")), D("2035-07-31"));
  const h = harness("2035-07-01T05:30:00.000Z", "L-29");
  const r = (await h.run("10.2", "pmi.terminate", { loan_id: "L-29", scheduled_date: "2035-07-01", premium_plan: "lpmi", installments: installmentLedger(140, {}, D("2035-07-01")) })) as { lpmi: boolean; cancellation: boolean; notice: string; due: string; lar89: unknown; refund: unknown };
  assert.deepEqual(r, { lpmi: true, cancellation: false, notice: "NTC_HPA_4905C2_LPMI_OPTIONS", due: D("2035-07-31"), lar89: null, refund: null });
  const t = h.latest("HPA_4905C2_LPMI_OPTIONS_NOTICE_30"); assert.equal(t.dueDate, D("2035-07-31")); assert.equal(t.anchorDate, D("2035-07-01"));
  assert.equal(h.events.ofType("mi.terminated").length, 0); assert.equal(h.events.ofType("mi.coverage.ended").length, 0); assert.equal(h.timer("HPA_4902F1_REFUND_45").length, 0);
  h.clock.set("2035-07-10T15:00:00.000Z");
  const n = (await h.run("10.2", "notices.*", { template_code: "NTC_HPA_4905C2_LPMI_OPTIONS", loan_id: "L-29", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4905C2_LPMI_OPTIONS"), notice_date: "2035-07-10", equivalent_termination_on: "2035-07-01" } })) as { status: string; rendered: { text: string } };
  assert.equal(n.status, "sent"); assert.match(n.rendered.text, /may wish to review financing options that could eliminate the requirement for private mortgage insurance/);
  assert.equal(t.status, "satisfied"); assert.ok(t.satisfiedAt!.slice(0, 10) <= "2035-07-31");
});
test("10.2-T10: Given the Flex Mod example, then `scheduled_78_date=2047-03-01` on the `modification` schedule and the midpoint recomputed to 2049-02-01.", () => {
  const mod = buildSchedule({ upb_cents: 32000000n, annual_rate: ratePercent("6.5"), term_months: 480, first_due: D("2029-02-01"), forborne_principal_cents: 5000000n }, "modification");
  assert.equal(mod.kind, "modification"); assert.equal(mod.pi_cents, 187346n); assert.equal(mod.forborne_principal_cents, 5000000n);
  assert.deepEqual([scheduledDateForPct(mod, OV, 78)!.n, scheduledDateForPct(mod, OV, 78)!.due_date], [218, D("2047-03-01")]);
  const m = midpoint(D("2029-02-01"), 480);
  assert.equal(m.midpoint_date, D("2049-01-01")); assert.equal(m.midpoint_termination_date, D("2049-02-01"));
  assert.equal(pendingTriggerDate(D("2047-03-01"), m.midpoint_termination_date, true), D("2047-03-01"));   // the 78% date controls
});
test("10.2-T11: Given a NY loan whose actual UPB falls to 74.9% of original appraised value while its payment history fails the 30-day test, then the NY gate stops MI charges to the borrower and an `officer` escalation records the corporate premium carry.", async () => {
  const r = nyPremiumGate({ state: "NY", upb_cents: 30709000n, original_appraised_value_cents: 41000000n, history_ok: false });
  assert.equal(r.ltv_bps, 7490); assert.equal(r.gate_open, true); assert.equal(r.stop_borrower_premium, true); assert.equal(r.premium_borne_by, "servicer_corporate");
  assert.deepEqual(r.escalation, { role: "officer", record: "corporate premium carry" }); assert.equal(r.reevaluate, "monthly_10_1");
  assert.equal(nyPremiumGate({ state: "TX", upb_cents: 30709000n, original_appraised_value_cents: 41000000n, history_ok: false }).gate_open, false);
  assert.equal(nyPremiumGate({ state: "NY", upb_cents: 31000000n, original_appraised_value_cents: 41000000n, history_ok: false }).gate_open, false);
  assert.equal(ltvSnapshot({ state: "NY", upb_cents: 30709000n, original_appraised_value_cents: 41000000n, snapshot_date: D("2035-03-01") }).ny_stop_reached, true);
  assert.throws(() => ltvSnapshot({ state: "NY", upb_cents: 30709000n, original_appraised_value_cents: 0n, snapshot_date: D("2035-03-01") }), RangeError);
  // On the bus: the nightly snapshot `mi.ltv_snapshot{state=NY, ltv_bps=7490}` arms NY_INS_6503D_STOP_PREMIUM_75 on the snapshot date and the same run resolves it —
  // the borrower's premium stops, the servicer carries it (officer record "corporate premium carry"), 10.1 re-evaluates monthly (10.2-Q2). TX, or NY above 75%, arms nothing.
  const h = harness("2035-03-02T05:30:00.000Z", "L-211");
  type Snap = { ltv_bps: number; gate_open: boolean; stop_borrower_premium: boolean; premium_borne_by: string; escalation_id: string | null; next: string | null };
  const s = (await h.run("10.2", "pmi.terminate", { op: "ltv_snapshot", loan_id: "L-211", state: "NY", upb_cents: 30709000n, original_appraised_value_cents: 41000000n, snapshot_date: "2035-03-01", history_ok: false })) as Snap;
  assert.deepEqual([s.ltv_bps, s.gate_open, s.stop_borrower_premium, s.premium_borne_by], [7490, true, true, "servicer_corporate"]);
  const snap = h.events.ofType("mi.ltv_snapshot")[0]!; assert.deepEqual([snap.payload.state, snap.payload.ltv_bps, snap.payload.snapshot_date, snap.payload.ny_stop_reached], ["NY", 7490, D("2035-03-01"), true]);
  const g = h.latest("NY_INS_6503D_STOP_PREMIUM_75"); assert.equal(g.anchorDate, D("2035-03-01")); assert.equal(g.status, "satisfied");
  const resolved = h.events.ofType("mi.ny_premium_gate.resolved")[0]!; assert.equal(resolved.payload.outcome, "premium_borne_by_servicer"); assert.equal(g.satisfiedByEventId, resolved.id);
  assert.equal(h.events.ofType("mi.premium.borne_by_servicer")[0]!.payload.premium_borne_by, "servicer_corporate");
  const esc = h.escalations.opened.find((e) => e.id === s.escalation_id)!;
  assert.deepEqual([esc.kind, esc.ownerRole, esc.loanId, esc.payload.record, esc.payload.rule, esc.payload.reevaluate], ["officer", "officer", "L-211", "corporate premium carry", "N.Y. Ins. Law §6503(d)", "monthly_10_1"]);
  assert.equal(h.rt.store.get("mi_policies", "L-211")!.data.premium_borne_by, "servicer_corporate"); assert.match(s.next!, /10\.1 evaluation monthly/);
  const gates = (id: string) => h.timers.byCode("NY_INS_6503D_STOP_PREMIUM_75").filter((t) => t.loanId === id).length;
  await h.run("10.2", "pmi.terminate", { op: "ltv_snapshot", loan_id: "L-212", state: "TX", upb_cents: 30709000n, original_appraised_value_cents: 41000000n, snapshot_date: "2035-03-01", history_ok: false });
  await h.run("10.2", "pmi.terminate", { op: "ltv_snapshot", loan_id: "L-213", state: "NY", upb_cents: 31000000n, original_appraised_value_cents: 41000000n, snapshot_date: "2035-03-01", history_ok: false });
  assert.deepEqual([gates("L-211"), gates("L-212"), gates("L-213"), h.events.ofType("mi.ltv_snapshot").length, h.events.ofType("mi.ny_premium_gate.resolved").length], [1, 0, 0, 3, 1]);
  // Fannie Mae criteria met at the snapshot: the gate opens and 10.1 terminates (the gate resolves on `mi.coverage.ended`) — no corporate carry
  const ok = (await h.run("10.2", "pmi.terminate", { op: "ltv_snapshot", loan_id: "L-214", state: "NY", upb_cents: 30709000n, original_appraised_value_cents: 41000000n, snapshot_date: "2035-03-01", history_ok: true, fnma_eligible: true })) as Snap;
  assert.deepEqual([ok.premium_borne_by, ok.escalation_id, gates("L-214")], ["none_terminated", null, 1]); assert.match(ok.next!, /pmi\.\* cancel/);
});

test("10.2 HPA_4902B2_CURE_TERMINATE_1ST arms only on the cure of a deferred policy (`loan.became_current{mi_auto_status=deferred_not_current}`, anchor `became_current_on`), and breaches sev-1 to the officer when the first of the next month passes without `mi.terminated`", () => {
  const reg = loadOverriddenRegistry(); const def = reg.get("HPA_4902B2_CURE_TERMINATE_1ST")!;
  const h = harness("2035-07-20T20:00:00.000Z", "L-2c");
  const sda = h.raise("loan.became_current", { became_current_on: "2035-07-20", sda_active: true });          // §5.4's cure on a loan with no deferred MI
  assert.equal(eventMatches(def.triggerPattern!, sda), false); assert.equal(h.timer("HPA_4902B2_CURE_TERMINATE_1ST").length, 0);
  const cure = h.raise("loan.became_current", { became_current_on: "2035-07-20", mi_auto_status: "deferred_not_current", scheduled_date: "2035-07-01" });
  assert.equal(eventMatches(def.triggerPattern!, cure), true);
  const t = h.latest("HPA_4902B2_CURE_TERMINATE_1ST"); assert.equal(t.anchorDate, D("2035-07-20")); assert.equal(t.dueDate, D("2035-08-01"));
  assert.equal(h.timers.evaluate("2035-08-01T12:00:00.000Z").length, 0, "due through the end of 2035-08-01");
  const b = h.timers.evaluate("2035-08-02T05:30:00.000Z").find((x) => x.def.code === "HPA_4902B2_CURE_TERMINATE_1ST")!;
  assert.equal(b.severity, 1); assert.deepEqual([...b.escalateTo], ["officer"]); assert.equal(t.status, "breached");
  // a late termination still closes the clock (satisfied_late) — the borrower's effective date is unchanged
  const term = h.raise("mi.terminated", { effective: "2035-08-01", lar89_action_code: "53", period_end_date: "2035-08-31" });
  assert.equal(eventMatches(def.satisfiedPattern!, term), true); assert.equal(t.status, "satisfied_late");
});
test("10.2 FNMA_IRM_LAR89_PERIOD_END (5.1): `mi.terminated` arms the period-end clock on `period_end_date`; Fannie Mae's LSDU feedback for the queued LAR 89 closes it (`investor_events.accepted{event_type=mi.discontinuance}`); a reject opens the single-LAR-entry task and, for 'MI not on file', the data-alignment case with the termination standing", async () => {
  const def = loadOverriddenRegistry().get("FNMA_IRM_LAR89_PERIOD_END")!; assert.equal(def.process, "5.1");
  assert.deepEqual(lar89ReportingFields(D("2035-07-01"), "53"), { lar89_action_code: "53", period_end_date: D("2035-07-31"), lar89_action_date: "070135" });
  const h = harness(SWEEP_0030, "L-289", WITH_51);
  await h.run("10.2", "pmi.terminate", { loan_id: "L-289", scheduled_date: "2035-07-01", installments: CURRENT_ON_0701() });
  const term = h.events.ofType("mi.terminated")[0]!;
  assert.equal(eventMatches(def.triggerPattern!, term), true);
  assert.equal(eventMatches(def.triggerPattern!, h.events.ofType("mi.coverage.ended")[0]!), false, "only the canonical event carries the LAR 89 code — one clock per termination");
  assert.equal(h.timer("FNMA_IRM_LAR89_PERIOD_END").length, 1); assert.equal(h.latest("FNMA_IRM_LAR89_PERIOD_END").anchorDate, D("2035-07-31"));
  const feedback = (f: Record<string, unknown>) => h.run("10.2", "investor_events.emit", { op: "lsdu_feedback", loan_id: "L-289", feedback: { record: "89", action_code: "53", action_date: "070135", status: "accepted", ...f } });
  await assert.rejects(feedback({}), /no queued LAR 89 53 070135 on L-289/);
  h.clock.set("2035-07-02T14:00:00.000Z");
  await h.run("10.2", "investor_events.emit", { loan_id: "L-289", event_type: "mi_discontinuance", action_code: "53", action_date: "070135" });
  for (const bad of [{ record: "96" }, { action_code: "55" }, { action_date: "7/1/35" }, { action_date: "130135" }, { status: "maybe" }, { action_code: "54" }]) await assert.rejects(feedback(bad), RangeError);
  assert.throws(() => parseLar89Feedback(null, h.clock.now()), RangeError); assert.throws(() => parseLar89Feedback({ record: "89", action_code: "53", action_date: "070135", status: "accepted", received_at: "yesterday" }, h.clock.now()), RangeError);
  assert.equal(h.events.ofType("investor_events.accepted").length, 0); assert.equal(h.latest("FNMA_IRM_LAR89_PERIOD_END").status, "armed");
  h.clock.set("2035-07-03T13:00:00.000Z");
  const acc = (await feedback({ received_at: "2035-07-03T13:00:00.000Z", fnma_loan_number: "1234567890" })) as { status: string; event_id: string; queued_event_id: string; portal_task_id: string | null; data_alignment_case_id: string | null };
  assert.deepEqual([acc.status, acc.portal_task_id, acc.data_alignment_case_id], ["accepted", null, null]);
  const ev = h.events.ofType("investor_events.accepted")[0]!;
  assert.deepEqual([ev.id, ev.payload.event_type, ev.payload.family, ev.payload.legacy_record, ev.payload.action_code, ev.payload.action_date, ev.payload.queued_event_id, ev.payload.fnma_response_parsed], [acc.event_id, "mi.discontinuance", "mi", 89, "53", "070135", acc.queued_event_id, true]);
  assert.equal(eventMatches(def.satisfiedPattern!, ev), true);
  const pe = h.latest("FNMA_IRM_LAR89_PERIOD_END"); assert.equal(pe.status, "satisfied"); assert.equal(pe.satisfiedByEventId, ev.id); assert.equal(pe.satisfiedAt, "2035-07-03T13:00:00.000Z");
  assert.equal(h.rt.store.get("investor_events", acc.queued_event_id)!.data.status, "accepted");
  assert.equal(((await h.run("10.2", "investor_events.emit", { op: "lar89_status", loan_id: "L-289" })) as { status: string }).status, "acked");
  // a hard reject: the termination stands (HPA); single-LAR entry by the period close and the data-alignment case
  const h2 = harness(SWEEP_0030, "L-290", WITH_51);
  await h2.run("10.2", "pmi.terminate", { loan_id: "L-290", scheduled_date: "2035-07-01", installments: CURRENT_ON_0701() });
  await h2.run("10.2", "investor_events.emit", { loan_id: "L-290", event_type: "mi_discontinuance", action_code: "53", action_date: "070135" });
  h2.clock.set("2035-07-03T13:00:00.000Z");
  const rej = (await h2.run("10.2", "investor_events.emit", { op: "lsdu_feedback", loan_id: "L-290", feedback: { record: "89", action_code: "53", action_date: "070135", status: "rejected", reason: "MI not on file" } })) as { status: string; portal_task_id: string; data_alignment_case_id: string };
  assert.equal(rej.status, "rejected"); assert.equal(h2.events.ofType("investor_events.rejected")[0]!.payload.reason, "MI not on file");
  const task = h2.escalations.opened.find((e) => e.id === rej.portal_task_id)!; assert.deepEqual([task.kind, task.ownerRole, task.payload.task, task.payload.by], ["human_portal_task", "fnma_portal_operator", "single_lar_entry", toIso(CLOSE_0802)]);
  const dc = h2.escalations.opened.find((e) => e.id === rej.data_alignment_case_id)!; assert.deepEqual([dc.ownerRole, dc.payload.case, dc.payload.termination_stands], ["investor-reporting", "data_alignment", true]);
  assert.equal(h2.latest("FNMA_IRM_LAR89_PERIOD_END").status, "armed"); assert.equal(h2.rt.store.get("mi_policies", "L-290")!.data.status, "terminated"); assert.equal(h2.events.ofType("investor_events.accepted").length, 0);
  const soft = (await h2.run("10.2", "investor_events.emit", { op: "lsdu_feedback", loan_id: "L-290", feedback: { record: "89", action_code: "53", action_date: "070135", status: "rejected", reason: "duplicate event" } })) as { data_alignment_case_id: string | null };
  assert.equal(soft.data_alignment_case_id, null, "only 'MI not on file' opens the data-alignment case");
});
test("10.2 SM_MI_ORIGINAL_VALUE_MISSING_60: a policy boarded without an evidenced original value opens the 60-day clock (anchor `boarded_at`) and the boarding escalation MI_ORIGINAL_VALUE_MISSING; the evidence-backed `mi.original_value.set` closes it; `loan.boarded` alone, or a policy boarded with a value, arms nothing; the breach goes to the officer sev-2", async () => {
  const h = harness("2026-10-01T15:00:00.000Z", "L-2ov");
  h.raise("loan.boarded", { loan_id: "L-2ov", boarded_at: "2026-10-01T15:00:00.000Z", min: null, mers_eligible: false, escrowed: true });   // §1.1's event carries no MI fields
  assert.equal(h.timer("SM_MI_ORIGINAL_VALUE_MISSING_60").length, 0, "boarding alone arms nothing — the MI boarding check decides");
  const board = (i: Record<string, unknown>) => h.run("10.2", "pmi.schedule.rebuild", { op: "board", boarded_at: "2026-10-01", premium_plan: "bpmi_monthly", upb_cents: 38000000n, annual_rate_pct: "6.5", term_months: 360, first_due: "2024-05-01", ...i });
  const r = (await board({ loan_id: "L-2ov", original_value_cents: null })) as { schedule_id: null; reason: string; escalation: string; escalation_id: string; sla_due: string; timer: string };
  assert.deepEqual([r.schedule_id, r.reason, r.escalation, r.sla_due, r.timer], [null, "ORIGINAL_VALUE_MISSING", "MI_ORIGINAL_VALUE_MISSING", D("2026-11-30"), "SM_MI_ORIGINAL_VALUE_MISSING_60"]);
  const t = h.latest("SM_MI_ORIGINAL_VALUE_MISSING_60"); assert.equal(t.anchorDate, D("2026-10-01")); assert.equal(t.dueDate, D("2026-11-30")); assert.equal(t.status, "armed");
  const esc = h.escalations.opened.find((e) => e.id === r.escalation_id)!; assert.deepEqual([esc.ownerRole, esc.payload.escalation, esc.payload.sla_days, esc.payload.sla_due], ["boarding", "MI_ORIGINAL_VALUE_MISSING", 60, D("2026-11-30")]);
  assert.equal(h.events.ofType("mi.schedule.updated").length, 0, "no 78% projection without the original value"); assert.equal(h.rt.store.get("mi_policies", "L-2ov")!.data.original_value_cents, null);
  h.clock.set("2026-10-20T15:00:00.000Z");
  await h.run("10.1", "pmi.*", { op: "set_original_value", loan_id: "L-2ov", original_value_cents: 40000000n, evidence_document_id: "doc-cd-2ov" });
  assert.equal(t.status, "satisfied"); assert.equal(h.rt.store.get("mi_policies", "L-2ov")!.data.original_value_cents, 40000000n);
  const ok = (await board({ loan_id: "L-2ok", original_value_cents: 40000000n })) as { derived_78_date: string };
  assert.equal(ok.derived_78_date, D("2035-07-01")); assert.equal(h.timers.byCode("SM_MI_ORIGINAL_VALUE_MISSING_60").filter((x) => x.loanId === "L-2ok").length, 0);
  const b = h.timers.evaluate("2026-12-01T05:00:00.000Z"); assert.equal(b.filter((x) => x.def.code === "SM_MI_ORIGINAL_VALUE_MISSING_60").length, 0, "the satisfied clock never breaches");
  const h2 = harness("2026-10-01T15:00:00.000Z", "L-2late");
  await h2.run("10.2", "pmi.schedule.rebuild", { op: "board", loan_id: "L-2late", boarded_at: "2026-10-01", premium_plan: "bpmi_monthly", original_value_cents: "" });
  const late = h2.timers.evaluate("2026-12-01T05:00:00.000Z").find((x) => x.def.code === "SM_MI_ORIGINAL_VALUE_MISSING_60")!;
  assert.equal(late.severity, 2); assert.deepEqual([...late.escalateTo], ["officer"]);
});

test("10.2 worked figures: 78% threshold $312,000.00; ARM 5.50% P&I $2,157.60, scheduled balance $351,350.17 at the reset, 7.50% P&I $2,596.45; Flex Mod P&I $1,873.46", () => {
  assert.equal(thresholdCents(40000000n, 78), 31200000n);
  const s55 = buildSchedule({ upb_cents: 38000000n, annual_rate: ratePercent("5.5"), term_months: 360, first_due: D("2024-05-01") });
  assert.equal(s55.pi_cents, 215760n); assert.equal(s55.rows[59]!.upb_after_cents, 35135017n);
  assert.equal(armResetVersion(s55, 61, ratePercent("7.5"), 300).pi_cents, 259645n);
  assert.equal(levelPayment(32000000n, ratePercent("6.5"), 480), 187346n);
});
