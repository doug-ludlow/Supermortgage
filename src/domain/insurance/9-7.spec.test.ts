// 9.7 Loss draft / insurance claim handling
// spec/sections/09-insurance-property-protection/9-7-loss-draft-insurance-claim-handling.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
// The Given/When/Then runs through the 9.7 tools (src/app/tools/section09.ts) and ops (./ops-9-7.ts) with the
// TimerEngine armed on the overridden registry, so every clock the T-id names is armed by the event the process emits
// and closed by the event the process emits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, dayOfWeek, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, fannieEt } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, parseEventPattern, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { lossDraftTrack, initialRelease, progressReleaseCurrent, progressReleaseDelinquent, releaseLimit, workoutEvaluationRequired, custodialInterest, contentsReleaseDue, form176Due, reogramRemitDue, supplementalWireDue, thirdPartyReleaseAllowed, remoteInspectionAcceptable, notRebuildableDisposition } from "./lossdraft.ts";
import { ET, lossDraftEscrowEvent } from "./ops.ts";
import { fileProofOfLoss, recordRepairDecision, requestDraw, recordRepairInspection, ingestShortSaleClosing, portalTaskCompleted, completeClaim, depositProceeds, type LossDraftCtx } from "./ops-9-7.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { CommandContext } from "../../app/commands.ts";
import { SECTION_09_TOOLS } from "../../app/tools/section09.ts";

const BASE = { total_cents: 6000000n, upb_cents: 24000000n, accrued_interest_cents: 100000n, advances_cents: 0n };
const AGENT: Actor = { kind: "agent", id: "insurance-property" };
const OPERATOR: Actor = { kind: "human", id: "op-1", role: "fnma_portal_operator" };
const OFFICER: Actor = { kind: "human", id: "off-1", role: "officer" };
const PORTAL: Actor = { kind: "external", id: "borrower-portal" };
const VENDOR: Actor = { kind: "external", id: "inspection-vendor" };
type Out = Record<string, any>;
const tool = (name: string) => SECTION_09_TOOLS.find((t) => t.process === "9.7" && t.name === name)!;
/** One loan, one clock, one event store, the 9.7 timers armed on it, and the tools/ops bound to that store. */
function harness(nowIso: string, loanId = "L-1") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["9.7"] });
  const rt: ToolRuntime = { store: new EntityStore(), ports: {}, escalations: new EscalationService(events, clock), services: {} };
  const ctx = (actor: Actor = AGENT) => ({ actor, now: clock.now(), loanId, events } as unknown as CommandContext);
  const run = async (name: string, input: Record<string, unknown>, actor: Actor = AGENT): Promise<Out> => (await tool(name).handler(input, ctx(actor), rt)) as Out;
  const refusals = (name: string, input: Record<string, unknown>, actor: Actor = AGENT): string[] => (tool(name).guardrails ?? []).map((g) => [g.code, g.refuse(input, ctx(actor))] as const).filter(([, r]) => r !== undefined).map(([c]) => c);
  const ops = (actor: Actor = AGENT): LossDraftCtx => ({ events, actor, loanId, now: clock.now() });
  const timer = (code: string) => timers.byCode(code).at(-1)!;
  const last = (type: string) => events.ofType(type).at(-1)!;
  return { clock, events, timers, rt, run, refusals, ops, timer, last };
}

test("9.7-T1: Given $60,000 proceeds on a current loan with UPB $240,000 Then initial release $40,000; no final inspection required; remote photos accepted if authenticated.", async () => {
  const h = harness("2027-03-01T15:00:00.000Z");                                                                 // Monday
  const opened = await h.run("openClaim", { loan_id: "L-1", id: "C-1", policy_id: "POL-1", loss_date: "2027-02-20", loss_cause: "wind", fnma_days_delinquent: 0 });
  assert.equal(opened.track, "current_lt31"); assert.equal(opened.workout_evaluation_required, false); assert.equal(opened.uninsured, false);
  assert.equal(lossDraftTrack({ fnma_days_delinquent: 0, abandoned: false, fc_sale_scheduled: false, rebuildable: "unknown" }), "current_lt31");
  // B-5-01 proof of loss: armed by the claim report on loss_date + 60 (policy default), closed by the borrower's filing
  const pol = h.timer("FNMA_B501_PROOF_OF_LOSS_POLICY"); assert.equal(pol.anchorDate, "2027-02-20"); assert.equal(pol.dueDate, addDays(D("2027-02-20"), 60)); assert.equal(pol.dueDate, "2027-04-21"); assert.equal(opened.proof_of_loss_due, "2027-04-21");
  // deposit with repair intent known → initial release within 5 servicer business days (policy); no contents designation → no 2-BD clock
  h.clock.set("2027-03-02T15:00:00.000Z");
  const dep = await h.run("depositInstrument", { claim_id: "C-1", instrument_id: "CHK-1", amount_cents: 6000000n, repair_intent_known: true });
  assert.equal(dep.initial_release_due, addBusinessDays(D("2027-03-02"), 5, servicer)); assert.equal(dep.initial_release_due, "2027-03-09"); assert.equal(dep.contents_release_due, null);
  const init5 = h.timer("INS_CLAIM_INITIAL_RELEASE_5BD"); assert.equal(init5.dueDate, "2027-03-09"); assert.equal(init5.status, "armed");
  assert.equal(h.timers.byCode("INS_CLAIM_CONTENTS_RELEASE_2BD").length, 0);
  // rule 2: max($40,000, 33% = $19,800, excess 0) = $40,000; receipts required (> $40,000 total); no final inspection
  const cur = initialRelease({ ...BASE, track: "current_lt31" });
  assert.equal(cur.cents, 4000000n); assert.equal(cur.final_inspection_required, false); assert.equal(cur.receipts_required, true); assert.equal(cur.max_progress_cents, null);
  assert.deepEqual((await h.run("computeReleaseSchedule", { ...BASE, track: "current_lt31" })).initial, cur);
  const probe = { claim_id: "C-1", kind: "initial", track: "current_lt31", ...BASE, amount_cents: 4000000n, released_so_far_cents: 0n, inspected: false, final_inspection: false };
  assert.deepEqual(h.refusals("releaseFunds", probe), []);
  assert.deepEqual(h.refusals("releaseFunds", { ...probe, amount_cents: 4000001n }), ["RELEASE_WITHIN_FORMULA"]);          // $40,000.01 exceeds the formula
  h.clock.set("2027-03-04T15:00:00.000Z");
  const rel = await h.run("releaseFunds", probe);
  assert.equal(rel.released_cents, 4000000n); assert.equal(rel.kind, "initial");
  assert.equal(init5.status, "satisfied"); assert.equal(init5.satisfiedAt, "2027-03-04T15:00:00.000Z");
  assert.deepEqual(h.last("claim.funds.released").payload, { claim_id: "C-1", kind: "initial", amount_cents: 4000000n, payee_kind: "borrower", basis: "initial (current_lt31)", inspection_id: null, released_on: "2027-03-04" });
  // remainder $20,000 by inspected completion (70% → $14,000 now); the last release is the remainder with no final inspection required
  assert.equal(progressReleaseCurrent(6000000n, 4000000n, 4000000n, "0.70"), 1400000n);
  assert.deepEqual(h.refusals("releaseFunds", { ...probe, kind: "progress", amount_cents: 1400000n, released_so_far_cents: 4000000n, pct_complete: "0.70" }), []);
  assert.deepEqual(h.refusals("releaseFunds", { ...probe, kind: "progress", amount_cents: 1400001n, released_so_far_cents: 4000000n, pct_complete: "0.70" }), ["RELEASE_WITHIN_FORMULA"]);
  assert.equal(releaseLimit({ kind: "final", release: { ...BASE, track: "current_lt31" }, released_so_far_cents: 5400000n, inspected: false, final_inspection: false }).cents, 600000n);
  assert.deepEqual(h.refusals("releaseFunds", { ...probe, kind: "final", amount_cents: 600000n, released_so_far_cents: 5400000n }), []);
  // rule 10: remote photos accepted only when authenticated (app-captured + GPS + timestamp + hash); a gallery upload falls back to a vendor inspection
  assert.equal(remoteInspectionAcceptable({ app_captured: true, gps: true, timestamp: true, hash: true }), true);
  assert.deepEqual(await h.run("verifyRemoteInspection", { media: { app_captured: true, gps: true, timestamp: true, hash: true } }), { acceptable: true, fallback: null });
  assert.deepEqual(await h.run("verifyRemoteInspection", { media: { app_captured: false, gps: true, timestamp: true, hash: true } }), { acceptable: false, fallback: "order a vendor inspection ($60 cap)" });
  const remote = recordRepairInspection(h.ops(PORTAL), { claim_id: "C-1", inspection_id: "RI-1", type: "remote_photo", pct_complete: "0.70", inspected_on: D("2027-03-20"), cost_cents: 0n, delinquent: false, required_for_release: true, authenticity: { app_captured: true, gps: true, timestamp: true, hash: true } });
  assert.equal(remote.accepted, true); assert.equal(h.last("claim.inspection.completed").payload.pct_complete, "0.70");
  assert.equal(recordRepairInspection(h.ops(PORTAL), { claim_id: "C-1", inspection_id: "RI-2", type: "remote_photo", pct_complete: "1", inspected_on: D("2027-03-25"), cost_cents: 0n, delinquent: false, required_for_release: true, authenticity: { app_captured: false, gps: true, timestamp: true, hash: true } }).accepted, false);
  assert.equal(h.last("claim.inspection.rejected").payload.fallback, "order a vendor inspection");
  // the borrower's proof of loss (portal upload) closes the policy clock
  fileProofOfLoss(h.ops(PORTAL), { claim_id: "C-1", filed_by: "borrower", filed_on: D("2027-03-05"), carrier_claim_no: "CLM-77" });
  assert.equal(pol.status, "satisfied");
});
test("9.7-T2: Given the same loan 45 days delinquent Then initial $10,000; increments ≤ $15,000 after inspections; final inspection gate before the last release; workout evaluation case opened.", async () => {
  const h = harness("2027-03-01T15:00:00.000Z");
  const opened = await h.run("openClaim", { loan_id: "L-1", id: "C-2", policy_id: "POL-1", loss_date: "2027-02-20", loss_cause: "fire", fnma_days_delinquent: 45 });
  const track = lossDraftTrack({ fnma_days_delinquent: 45, abandoned: false, fc_sale_scheduled: false, rebuildable: "unknown" });
  assert.equal(track, "delinquent_31plus"); assert.equal(opened.track, track); assert.equal(workoutEvaluationRequired(track), true); assert.equal(opened.workout_evaluation_required, true);
  // D2-3.1-01 workout evaluation case opened (12.x) for the ≥ 31-day-delinquent track
  const wo = await h.run("openWorkoutEvaluation", { loan_id: "L-1", claim_id: "C-2", track });
  assert.equal(h.rt.store.get("cases", wo.id)!.data.case_type, "lossmit_evaluation"); assert.equal(h.rt.store.get("cases", wo.id)!.data.trigger, "loss_draft_delinquent_track");
  assert.deepEqual(h.last("claim.workout_evaluation.opened").payload, { case_id: wo.id, claim_id: "C-2", track, basis: "D2-3.1-01 via B-5-01 (≥ 31 days delinquent, abandoned or FC-scheduled)" });
  // rule 2 (delinquent): total > $5,000 → initial = min(25% = $15,000, max($10,000, excess 0)) = $10,000; increments ≤ $15,000; final inspection required
  const del = initialRelease({ ...BASE, track });
  assert.equal(del.cents, 1000000n); assert.equal(del.final_inspection_required, true); assert.equal(del.max_progress_cents, 1500000n);
  await h.run("depositInstrument", { claim_id: "C-2", instrument_id: "CHK-2", amount_cents: 6000000n, repair_intent_known: true });
  const probe = { claim_id: "C-2", kind: "initial", track, ...BASE, amount_cents: 1000000n, released_so_far_cents: 0n, inspected: false, final_inspection: false };
  assert.deepEqual(h.refusals("releaseFunds", probe), []);
  assert.deepEqual(h.refusals("releaseFunds", { ...probe, amount_cents: 1000001n }), ["RELEASE_WITHIN_FORMULA"]);
  await h.run("releaseFunds", probe);
  assert.equal(h.timer("INS_CLAIM_INITIAL_RELEASE_5BD").status, "satisfied");
  // progress: only after an inspection, each ≤ $15,000
  assert.equal(progressReleaseDelinquent(6000000n, 1000000n, true, false).cents, 1500000n);
  assert.equal(progressReleaseDelinquent(6000000n, 1000000n, false, false).refused, "INSPECTION_REQUIRED");
  assert.deepEqual(h.refusals("releaseFunds", { ...probe, kind: "progress", amount_cents: 1500000n, released_so_far_cents: 1000000n, inspected: true }), []);
  assert.deepEqual(h.refusals("releaseFunds", { ...probe, kind: "progress", amount_cents: 1600000n, released_so_far_cents: 1000000n, inspected: true }), ["RELEASE_WITHIN_FORMULA"]);   // > $15,000 increment
  assert.deepEqual(h.refusals("releaseFunds", { ...probe, kind: "progress", amount_cents: 1500000n, released_so_far_cents: 1000000n, inspected: false }), ["RELEASE_WITHIN_FORMULA", "INSPECTION_REQUIRED"]);
  // a draw request opens the 3-BD inspection-order clock; ordering the repair inspection closes it
  const draw = requestDraw(h.ops(PORTAL), { claim_id: "C-2", requested_on: D("2027-03-10"), amount_cents: 1500000n, source: "portal" });
  assert.equal(draw.inspection_order_due, "2027-03-15");
  const ord = h.timer("INS_CLAIM_INSPECTION_ORDER_3BD"); assert.equal(ord.anchorDate, "2027-03-10"); assert.equal(ord.dueDate, "2027-03-15"); assert.equal(ord.status, "armed");
  h.clock.set("2027-03-11T15:00:00.000Z");
  assert.deepEqual(await h.run("orderRepairInspection", { loan_id: "L-1" }), { ordered: true, cap_cents: 6000n });
  assert.equal(ord.status, "satisfied");
  // final inspection gate before the last release: 15,000 / 15,000 / 15,000 then the last $5,000 only after the final inspection
  assert.equal(progressReleaseDelinquent(6000000n, 5500000n, true, false).refused, "FINAL_INSPECTION_REQUIRED");
  assert.equal(progressReleaseDelinquent(6000000n, 5500000n, true, true).cents, 500000n);
  assert.equal(releaseLimit({ kind: "final", release: { ...BASE, track }, released_so_far_cents: 1000000n, inspected: false, final_inspection: false }).refused, "INSPECTION_REQUIRED");
  assert.equal(releaseLimit({ kind: "final", release: { ...BASE, track }, released_so_far_cents: 1000000n, inspected: true, final_inspection: false }).refused, "FINAL_INSPECTION_REQUIRED");
  const fin = { ...probe, kind: "final", amount_cents: 500000n, released_so_far_cents: 5500000n, inspected: true };
  assert.deepEqual(h.refusals("releaseFunds", { ...fin, final_inspection: false }), ["RELEASE_WITHIN_FORMULA", "INSPECTION_REQUIRED"]);
  assert.deepEqual(h.refusals("releaseFunds", { ...fin, final_inspection: true }), []);
  assert.deepEqual(h.refusals("releaseFunds", { ...fin, amount_cents: 5000000n, released_so_far_cents: 1000000n, inspected: false, final_inspection: false }), ["RELEASE_WITHIN_FORMULA", "INSPECTION_REQUIRED"]);
  // a sized release without the formula inputs is refused outright (it cannot be checked against B-5-01)
  assert.deepEqual(h.refusals("releaseFunds", { claim_id: "C-2", kind: "initial", track, amount_cents: 9999999n }), ["FORMULA_INPUTS_REQUIRED"]);
});
test("9.7-T3: Given $4,500 proceeds on a 60-day delinquent loan Then single lump sum.", async () => {
  const track = lossDraftTrack({ fnma_days_delinquent: 60, abandoned: false, fc_sale_scheduled: false, rebuildable: "unknown" });
  const r = initialRelease({ ...BASE, total_cents: 450000n, track });
  assert.equal(r.cents, 450000n); assert.equal(r.final_inspection_required, false); assert.equal(r.max_progress_cents, null); assert.equal(r.receipts_required, false);
  const h = harness("2027-03-01T15:00:00.000Z");
  const sched = await h.run("computeReleaseSchedule", { ...BASE, total_cents: 450000n, track });
  assert.deepEqual(sched.initial, r); assert.equal(sched.workout_evaluation_required, true);
  assert.deepEqual(h.refusals("releaseFunds", { claim_id: "C-3", kind: "initial", track, ...BASE, total_cents: 450000n, amount_cents: 450000n, released_so_far_cents: 0n, inspected: false, final_inspection: false }), []);
  assert.equal(initialRelease({ ...BASE, total_cents: 500100n, track: "delinquent_31plus" }).cents, 125025n);   // $5,001 → 25% initial
});
test("9.7-T4: Given a check with $8,000 contents designation deposited Monday Then contents released by Wednesday.", async () => {
  assert.equal(dayOfWeek(D("2027-03-08")), 1);
  assert.equal(contentsReleaseDue(D("2027-03-08")), "2027-03-10");
  const h = harness("2027-03-08T15:00:00.000Z");                                                                 // Monday
  const dep = await h.run("depositInstrument", { claim_id: "C-4", instrument_id: "CHK-4", amount_cents: 6000000n, contents_ale_cents: 800000n });
  assert.equal(dep.contents_release_due, "2027-03-10"); assert.equal(dep.contents_ale_cents, 800000n);
  const t = h.timer("INS_CLAIM_CONTENTS_RELEASE_2BD"); assert.equal(t.anchorDate, "2027-03-08"); assert.equal(t.dueDate, "2027-03-10"); assert.equal(t.status, "armed");
  assert.equal(h.last("claim.proceeds.deposited").payload.contents_ale_cents, 800000n);
  // no formula cap on contents/ALE; released Tuesday → the clock closes on the release the process emits
  assert.equal(releaseLimit({ kind: "contents_ale", release: { ...BASE, track: "delinquent_31plus" }, released_so_far_cents: 0n, inspected: false, final_inspection: false }).cents, null);
  h.clock.set("2027-03-09T15:00:00.000Z");
  assert.deepEqual(h.refusals("releaseFunds", { claim_id: "C-4", kind: "contents_ale", amount_cents: 800000n }), []);
  await h.run("releaseFunds", { claim_id: "C-4", kind: "contents_ale", amount_cents: 800000n });
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedAt, "2027-03-09T15:00:00.000Z");
  // not released by Wednesday → sev-2 breach on Thursday
  const late = harness("2027-03-08T15:00:00.000Z");
  await late.run("depositInstrument", { claim_id: "C-4b", instrument_id: "CHK-4b", amount_cents: 6000000n, contents_ale_cents: 800000n });
  assert.equal(late.timers.evaluate("2027-03-11T05:00:00.000Z").map((b) => [b.instance.code, b.severity]).find(([c]) => c === "INS_CLAIM_CONTENTS_RELEASE_2BD")![1], 2);
  // a deposit with no contents designation arms no 2-BD clock; a designation above the check amount is refused
  const none = harness("2027-03-08T15:00:00.000Z");
  await none.run("depositInstrument", { claim_id: "C-4c", instrument_id: "CHK-4c", amount_cents: 6000000n });
  assert.equal(none.timers.byCode("INS_CLAIM_CONTENTS_RELEASE_2BD").length, 0);
  assert.throws(() => depositProceeds(none.ops(), { claim_id: "C-4c", instrument_id: "CHK-4d", amount_cents: 500000n, contents_ale_cents: 800000n }), RangeError);
});
test("9.7-T5: Given an abandoned property with damage learned on 2027-03-08 Then Form 176 package sent by 2027-03-15 (5 servicer business days).", async () => {
  assert.equal(form176Due(D("2027-03-08")), "2027-03-15");
  assert.equal(lossDraftTrack({ fnma_days_delinquent: 45, abandoned: true, fc_sale_scheduled: false, rebuildable: "unknown" }), "abandoned_or_fc_sale");
  const h = harness("2027-03-08T15:00:00.000Z");
  const opened = await h.run("openClaim", { loan_id: "L-1", id: "C-5", policy_id: "POL-1", loss_date: "2027-03-06", loss_cause: "vandalism", fnma_days_delinquent: 45, abandoned: true, learned_on: "2027-03-08" });
  assert.equal(opened.track, "abandoned_or_fc_sale"); assert.equal(opened.property_status, "abandoned"); assert.equal(opened.form176_due, "2027-03-15"); assert.equal(opened.form176_cause, "damage_learned");
  const t = h.timer("FNMA_B501_FORM176_ABANDONED_5BD"); assert.equal(t.anchorDate, "2027-03-08"); assert.equal(t.dueDate, "2027-03-15"); assert.equal(t.status, "armed");
  // the agent prepares the package; only the fnma_portal_operator submits it
  const pkg = await h.run("prepareForm176", { loan_id: "L-1", claim_id: "C-5", learned_on: "2027-03-08" });
  assert.equal(pkg.due, "2027-03-15"); assert.equal(pkg.send_by, "fnma_portal_operator"); assert.equal(pkg.status, "draft");
  assert.deepEqual(h.refusals("prepareForm176", { submit: true }), ["PORTAL_OPERATOR_SENDS"]);
  assert.deepEqual(h.refusals("prepareForm176", { submit: true }, OPERATOR), []);
  assert.equal(t.status, "armed");
  h.clock.set("2027-03-12T15:00:00.000Z");
  const sent = await h.run("prepareForm176", { loan_id: "L-1", claim_id: "C-5", learned_on: "2027-03-08", package_id: pkg.id, submit: true, reason: "abandoned_intends_to_repair" }, OPERATOR);
  assert.equal(sent.status, "sent"); assert.equal(sent.sent_on, "2027-03-12"); assert.equal(sent.sent_by, "human:op-1");
  assert.equal(t.status, "satisfied"); assert.equal(h.last("claim.form176.sent").payload.package_id, pkg.id);
  // the later decision not to repair is the second trigger of the same clock, from the day it is learned
  const dec = recordRepairDecision(h.ops(PORTAL), { claim_id: "C-5", property_status: "abandoned", intends_to_repair: false, learned_on: D("2027-03-12") });
  assert.equal(dec.form176_due, "2027-03-19");
  const t2 = h.timer("FNMA_B501_FORM176_ABANDONED_5BD"); assert.notEqual(t2.id, t.id); assert.equal(t2.dueDate, "2027-03-19"); assert.equal(t2.status, "armed");
  assert.equal(recordRepairDecision(h.ops(PORTAL), { claim_id: "C-5", property_status: "occupied", intends_to_repair: false, learned_on: D("2027-03-12") }).form176_required, false);
  // not sent by 2027-03-15 → sev-1
  const late = harness("2027-03-08T15:00:00.000Z");
  await late.run("openClaim", { loan_id: "L-1", id: "C-5b", policy_id: "POL-1", fnma_days_delinquent: 45, fc_sale_scheduled: true, learned_on: "2027-03-08" });
  assert.equal(late.timers.evaluate("2027-03-16T05:00:00.000Z").find((b) => b.instance.code === "FNMA_B501_FORM176_ABANDONED_5BD")!.severity, 1);
});
test("9.7-T6: Given REOgram confirmed 2027-05-03 with $12,000 held Then code-332 remittance by 2027-06-02; a $3,000 supplemental check received 2027-06-10 → wired within 10 fannie_et business days.", async () => {
  assert.equal(reogramRemitDue(D("2027-05-03")), "2027-06-02");
  assert.equal(supplementalWireDue(D("2027-06-10")), addBusinessDays(D("2027-06-10"), 10, fannieEt)); assert.equal(supplementalWireDue(D("2027-06-10")), "2027-06-25");   // Juneteenth observed Fri 06-18 skipped
  const h = harness("2027-05-03T15:00:00.000Z");
  // 15.1's REOgram confirmation (its own event shape) arms the 30-day remittance clock on the confirmation date
  h.events.append({ type: "reogram.confirmed", loanId: "L-1", aggregate: { kind: "reogram_confirmations", id: "rc-1" }, actor: SYSTEM, payload: { confirmed_at: "2027-05-03T14:00:00.000Z", confirm_due_at: "2027-05-04T21:00:00.000Z", late_days: 0, evidence_document_id: "doc-1", p360_case_id: "P-1" } });
  const t30 = h.timer("FNMA_B501_REMIT_PROCEEDS_REOGRAM_30"); assert.equal(t30.anchorDate, "2027-05-03"); assert.equal(t30.dueDate, "2027-06-02"); assert.equal(t30.status, "armed");
  h.clock.set("2027-05-20T15:00:00.000Z");
  const r = await h.run("remitProceeds332", { claim_id: "C-6", amount_cents: 1200000n, reogram_confirmed_on: "2027-05-03" });
  assert.equal(r.crs_code, "332"); assert.equal(r.due, "2027-06-02"); assert.equal(r.method, "crs_draft"); assert.equal(r.amount_cents, 1200000n);
  assert.equal(t30.status, "satisfied"); assert.equal(h.last("remittances.instructed").payload.crs_code, "332");
  assert.deepEqual(h.refusals("remitProceeds332", { net_servicer_fees: true }), ["NO_NETTING_332"]);
  // the $3,000 supplemental check received 2027-06-10 (after the REOgram) → wire within 10 fannie_et BD of receipt
  h.clock.set("2027-06-11T18:00:00.000Z");
  const dep = await h.run("depositInstrument", { claim_id: "C-6", instrument_id: "CHK-6b", amount_cents: 300000n, reogram_confirmed: true, received_on: "2027-06-10" });
  assert.equal(dep.wire_due, "2027-06-25");
  const t10 = h.timer("FNMA_B501_WIRE_POSTREOGRAM_PROCEEDS_10BD"); assert.equal(t10.anchorDate, "2027-06-10"); assert.equal(t10.dueDate, "2027-06-25"); assert.equal(t10.status, "armed");
  h.clock.set("2027-06-14T15:00:00.000Z");
  const w = await h.run("remitProceeds332", { claim_id: "C-6", amount_cents: 300000n, reogram_confirmed_on: "2027-05-03", received_on: "2027-06-10" });
  assert.equal(w.method, "wire"); assert.equal(w.due, "2027-06-25"); assert.equal(w.crs_code, "332");
  assert.equal(t10.status, "satisfied");
  assert.deepEqual(h.last("claim.proceeds.wired").payload, { claim_id: "C-6", amount_cents: 300000n, received_on: "2027-06-10", wired_on: "2027-06-14", due: "2027-06-25", crs_code: "332" });
  // a deposit before the REOgram arms no wire clock
  assert.equal(h.timers.byCode("FNMA_B501_WIRE_POSTREOGRAM_PROCEEDS_10BD").length, 1);
});
test("9.7-T7: Given $20,000 held 60 days at 4.00% Then $131.51 interest paid at completion.", () => {
  assert.equal(custodialInterest(2000000n, "4.00", 60), 13151n);                                       // 20,000 × 0.04 × 60/365 = 131.5068
  assert.equal(custodialInterest(2000000n, "4.00", 0), 0n);
  const h = harness("2027-05-01T15:00:00.000Z");
  const done = completeClaim(h.ops(), { claim_id: "C-7", held_cents: 2000000n, rate_pct: "4.00", days_held: 60 });
  assert.equal(done.interest_cents, 13151n); assert.equal(done.surplus_cents, 0n);
  const paid = h.events.ofType("claim.funds.released").map((e) => e.payload);
  assert.equal(paid.length, 1); assert.equal(paid[0]!.kind, "interest_payout"); assert.equal(paid[0]!.amount_cents, 13151n);
  assert.deepEqual(h.last("insurance.claim.completed").payload, { claim_id: "C-7", interest_paid_cents: 13151n, surplus_cents: 0n, completed_on: "2027-05-01" });
});
test("9.7-T8: Given a public adjuster invoice Then release refused until a recorded Fannie Mae approval exists.", async () => {
  assert.equal(thirdPartyReleaseAllowed(false), false); assert.equal(thirdPartyReleaseAllowed(true), true);
  const h = harness("2027-03-08T15:00:00.000Z");
  assert.deepEqual(h.refusals("releaseFunds", { kind: "other", amount_cents: 250000n, payee_kind: "third_party" }), ["THIRD_PARTY_NEEDS_FNMA_APPROVAL"]);
  assert.deepEqual(h.refusals("releaseFunds", { kind: "other", amount_cents: 250000n, payee_kind: "third_party", fnma_approval_recorded: true }), []);
  // the approval request is a Form 176 package (rule 8), prepared by the agent and sent by the portal operator
  const pkg = await h.run("prepareForm176", { loan_id: "L-1", claim_id: "C-8", learned_on: "2027-03-08", reason: "public_adjuster_fee" });
  assert.equal(pkg.reason, "public_adjuster_fee"); assert.equal(pkg.send_by, "fnma_portal_operator");
  assert.deepEqual(h.refusals("prepareForm176", { submit: true, reason: "public_adjuster_fee" }), ["PORTAL_OPERATOR_SENDS"]);
  assert.equal(h.events.ofType("claim.funds.released").length, 0);
});
test("9.7-T9: Given the property cannot be rebuilt (condemnation letter) Then all proceeds applied to UPB as a curtailment; investor event emitted; payoff path if proceeds ≥ payoff.", async () => {
  assert.equal(lossDraftTrack({ fnma_days_delinquent: 0, abandoned: false, fc_sale_scheduled: false, rebuildable: "no" }), "not_rebuildable");
  assert.deepEqual(notRebuildableDisposition(6000000n, 24100000n), { curtailment_cents: 6000000n, payoff: false });
  assert.deepEqual(notRebuildableDisposition(26000000n, 24100000n), { curtailment_cents: 24100000n, payoff: true });
  assert.equal(releaseLimit({ kind: "initial", release: { ...BASE, track: "not_rebuildable" }, released_so_far_cents: 0n, inspected: false, final_inspection: false }).refused, "NOT_REBUILDABLE_APPLY_TO_UPB");
  const h = harness("2027-03-08T15:00:00.000Z");
  const opened = await h.run("openClaim", { loan_id: "L-1", id: "C-9", policy_id: "POL-1", loss_date: "2027-02-20", loss_cause: "fire", fnma_days_delinquent: 0, rebuildable: "no" });
  assert.equal(opened.track, "not_rebuildable");
  assert.deepEqual(h.refusals("releaseFunds", { claim_id: "C-9", kind: "initial", track: "not_rebuildable", ...BASE, amount_cents: 100n, released_so_far_cents: 0n, inspected: false, final_inspection: false }), ["RELEASE_WITHIN_FORMULA"]);
  const d = await h.run("applyToUpb", { proceeds_cents: 6000000n, payoff_cents: 24100000n });
  assert.deepEqual(d, { curtailment_cents: 6000000n, payoff: false });
  assert.deepEqual(h.last("payment.curtailment").payload, { amount_cents: 6000000n, source: "loss_draft_not_rebuildable" });    // curtailment → investor event (2.x/5.x)
  assert.deepEqual(await h.run("applyToUpb", { proceeds_cents: 26000000n, payoff_cents: 24100000n }), { curtailment_cents: 24100000n, payoff: true });   // proceeds ≥ payoff → payoff path (16.x)
});
test("9.7-T10: Given a loss-draft deposit on 2026-12-15 Then an escrow event with category loss_draft is accepted by 03:00 ET 2026-12-16.", async () => {
  const e = lossDraftEscrowEvent({ deposited_at_ms: zonedEpochMs(D("2026-12-15"), "14:00", ET), amount_cents: 6000000n, loan_id: "L-1" });
  assert.equal(e.event.escrow_category, "loss_draft"); assert.equal(e.event.type, "escrow.deposit");
  assert.equal(toIso(e.submit_by_ms), toIso(zonedEpochMs(D("2026-12-16"), "03:00", ET)));
  // the deposit tool emits that escrow event (rule 12) alongside the custody event
  const h = harness(toIso(zonedEpochMs(D("2026-12-15"), "14:00", ET)));
  const dep = await h.run("depositInstrument", { claim_id: "C-10", instrument_id: "CHK-10", amount_cents: 6000000n });
  assert.equal(dep.deposited_on, "2026-12-15"); assert.equal(dep.account, "custodial_ti_loss_draft");
  assert.deepEqual(dep.escrow_event, { type: "escrow.deposit", escrow_category: "loss_draft", amount_cents: 6000000n, submit_by: "2026-12-16T08:00:00.000Z" });
  const ev = h.last("escrow.deposit");
  assert.equal(ev.payload.escrow_category, "loss_draft"); assert.equal(ev.payload.amount_cents, 6000000n); assert.equal(ev.payload.submit_by, toIso(zonedEpochMs(D("2026-12-16"), "03:00", ET)));
  assert.equal(h.events.ofType("claim.proceeds.deposited").length, 1);
});

test("9.7 worked example: $60,000.00 proceeds on a $240,000.00 UPB with $1,000.00 interest → current initial $40,000.00 then $20,000.00 by inspection; delinquent initial $10,000.00 then ≤ $15,000.00 increments; $131.51 custodial interest", () => {
  const cur = initialRelease({ total_cents: 6000000n, upb_cents: 24000000n, accrued_interest_cents: 100000n, advances_cents: 0n, track: "current_lt31" });
  assert.equal(cur.cents, 4000000n); assert.equal(6000000n - 4000000n, 2000000n); assert.equal(progressReleaseCurrent(6000000n, 4000000n, 4000000n, "0.70"), 1400000n);
  const del = initialRelease({ total_cents: 6000000n, upb_cents: 24000000n, accrued_interest_cents: 100000n, advances_cents: 0n, track: "delinquent_31plus" });
  assert.equal(del.cents, 1000000n); assert.equal(del.max_progress_cents, 1500000n); assert.equal(progressReleaseDelinquent(6000000n, 1000000n, true, false).cents, 1500000n);
  assert.equal(custodialInterest(2000000n, "4.00", 60), 13151n);
});
test("9.7 timers: F-1-05 repair-inspection cost on a current loan → 15.2 claim within 365 days; a delinquent loan's cost arms nothing", () => {
  const h = harness("2027-03-20T15:00:00.000Z");
  const r = recordRepairInspection(h.ops(VENDOR), { claim_id: "C-1", inspection_id: "RI-3", type: "progress", pct_complete: "0.50", inspected_on: D("2027-03-20"), cost_cents: 6000n, delinquent: false, required_for_release: true });
  assert.deepEqual(r, { accepted: true, reason: null, reimbursable: true, claim_cents: 6000n, claim_by: "2028-03-19" });   // 2027-03-20 + 365 (2028 is a leap year)
  assert.deepEqual(h.last("property.inspection.cost_incurred").payload, { claim_id: "C-1", inspection_id: "RI-3", kind: "repair", cost_cents: 6000n, claim_cents: 6000n, incurred_on: "2027-03-20", delinquent: false, reimbursable: true, claim_by: "2028-03-19" });
  const t = h.timer("FNMA_F105_INSURED_LOSS_INSPECT_CLAIM_365"); assert.equal(t.anchorDate, "2027-03-20"); assert.equal(t.dueDate, "2028-03-19"); assert.equal(t.status, "armed");
  // 15.2's submission event (its own shape) closes it
  h.clock.set("2027-06-30T15:00:00.000Z");
  h.events.append({ type: "expense_claim.status_changed", loanId: "L-1", aggregate: { kind: "expense_claims", id: "EC-1" }, actor: SYSTEM, payload: { claim_id: "EC-1", kind: "final", interim: false, milestone_kind: "reo", channel: "bulk_upload", submitted_on: "2027-06-30", status: "submitted" } });
  assert.equal(t.status, "satisfied");
  assert.equal(recordRepairInspection(h.ops(VENDOR), { claim_id: "C-2", inspection_id: "RI-4", type: "progress", pct_complete: "0.25", inspected_on: D("2027-03-20"), cost_cents: 6000n, delinquent: true, required_for_release: true }).reimbursable, false);
  assert.equal(h.timers.byCode("FNMA_F105_INSURED_LOSS_INSPECT_CLAIM_365").length, 1);
  assert.equal(recordRepairInspection(h.ops(VENDOR), { claim_id: "C-1", inspection_id: "RI-5", type: "final", pct_complete: "1", inspected_on: D("2027-04-20"), cost_cents: 9000n, delinquent: false, required_for_release: true }).claim_cents, 6000n);   // $60 cap
  assert.throws(() => recordRepairInspection(h.ops(VENDOR), { claim_id: "C-1", inspection_id: "RI-6", type: "final", pct_complete: "1.5", inspected_on: D("2027-04-20"), cost_cents: 0n, delinquent: false, required_for_release: false }), RangeError);
});
test("9.7 timers: D1-3-01 — a disaster-tied claim on a loan in pre-referral review arms the 5-day approval clock; the Fannie Mae submission must carry this claim's date, status and disbursements", async () => {
  const h = harness("2027-03-08T15:00:00.000Z");
  const opened = await h.run("openClaim", { loan_id: "L-1", id: "C-D", policy_id: "POL-1", loss_date: "2027-03-05", loss_cause: "flood", fnma_days_delinquent: 120, disaster_event_id: "DR-4999", foreclosure_prereferral: true });
  assert.equal(opened.disaster_fc_approval_due, "2027-03-13");
  assert.deepEqual(h.last("disaster.impact.determined").payload, { claim_id: "C-D", disaster_event_id: "DR-4999", foreclosure_prereferral: true, determined_on: "2027-03-08", damage: "insured_loss", loss_cause: "flood", claim_reported_on: "2027-03-08" });
  const t = h.timer("FNMA_D1301_DISASTER_FC_APPROVAL_5"); assert.equal(t.anchorDate, "2027-03-08"); assert.equal(t.dueDate, "2027-03-13"); assert.equal(t.status, "armed");
  // an incomplete submission (no claim status) is refused and appends nothing
  const before = h.events.all().length;
  assert.throws(() => portalTaskCompleted(h.ops(OPERATOR), { task: "disaster_fc_approval", submission_id: "S-1", completed_on: D("2027-03-11"), claim: { claim_id: "C-D", claim_reported_on: D("2027-03-08"), claim_status: "", expected_cents: 6000000n, received_cents: 0n, disbursed_cents: 0n } }), RangeError);
  assert.equal(h.events.all().length, before); assert.equal(t.status, "armed");
  h.clock.set("2027-03-11T15:00:00.000Z");
  portalTaskCompleted(h.ops(OPERATOR), { task: "disaster_fc_approval", submission_id: "S-1", completed_on: D("2027-03-11"), claim: { claim_id: "C-D", claim_reported_on: D("2027-03-08"), claim_status: "awaiting_proceeds", expected_cents: 6000000n, received_cents: 0n, disbursed_cents: 0n } });
  assert.equal(t.status, "satisfied");
  assert.deepEqual(h.last("fnma.disaster_fc_approval.submitted").payload, { claim_id: "C-D", submission_id: "S-1", submitted_on: "2027-03-11", claim_reported_on: "2027-03-08", claim_status: "awaiting_proceeds", expected_cents: 6000000n, received_cents: 0n, disbursed_cents: 0n, submitted_by: "human:op-1" });
  // a disaster-tied claim outside the pre-referral review arms no approval clock (the section's trigger condition)
  await h.run("openClaim", { loan_id: "L-1", id: "C-D2", policy_id: "POL-1", loss_date: "2027-03-05", loss_cause: "flood", fnma_days_delinquent: 0, disaster_event_id: "DR-4999" });
  assert.equal(h.timers.byCode("FNMA_D1301_DISASTER_FC_APPROVAL_5").length, 1);
});
test("9.7 timers: short-sale closing → the held proceeds are remitted at closing (CRS 332); every claim action resets the 90-day stale clock", async () => {
  const h = harness("2027-04-15T15:00:00.000Z");
  const closing = ingestShortSaleClosing(h.ops({ kind: "external", id: "closing-agent" }), { claim_id: "C-S", closed_on: D("2027-04-15"), held_proceeds_cents: 1200000n, settlement_statement_id: "HUD-1" });
  assert.equal(closing.remit_due, "2027-04-15");
  const t = h.timer("FNMA_B501_REMIT_SHORTSALE_332_0"); assert.equal(t.anchorDate, "2027-04-15"); assert.equal(t.dueDate, "2027-04-15"); assert.equal(t.status, "armed");
  const r = await h.run("remitProceeds332", { claim_id: "C-S", amount_cents: 1200000n, shortsale_closed_on: "2027-04-15" });
  assert.equal(r.due, "2027-04-15"); assert.equal(r.method, "crs_draft");
  assert.equal(t.status, "satisfied");
  assert.equal(eventMatches(parseEventPattern("`remittances.instructed{crs_code=332}`")!, h.last("remittances.instructed")), true);
  await assert.rejects(h.run("remitProceeds332", { claim_id: "C-S", amount_cents: 1200000n }), RangeError);
  // INS_CLAIM_STALE_90: armed by the claim report, satisfied and re-armed by the next activity
  const s = harness("2027-03-01T15:00:00.000Z");
  await s.run("openClaim", { loan_id: "L-1", id: "C-ST", policy_id: "POL-1", loss_date: "2027-02-20", fnma_days_delinquent: 0 });
  const first = s.timer("INS_CLAIM_STALE_90"); assert.equal(first.dueDate, "2027-05-30"); assert.equal(first.status, "armed");
  s.clock.set("2027-03-11T15:00:00.000Z");
  await s.run("depositInstrument", { claim_id: "C-ST", instrument_id: "CHK-ST", amount_cents: 6000000n });
  assert.equal(first.status, "satisfied");
  const next = s.timer("INS_CLAIM_STALE_90"); assert.notEqual(next.id, first.id); assert.equal(next.dueDate, "2027-06-09"); assert.equal(next.status, "armed");
});
test("9.7 guardrails: officer co-approval at $100,000 per release (open decision 2); servicer expenses never netted; the LPOA endorsement is a signing-officer act", async () => {
  const h = harness("2027-03-08T15:00:00.000Z");
  assert.deepEqual(h.refusals("releaseFunds", { claim_id: "C-G", kind: "contents_ale", amount_cents: 10000000n }), ["OFFICER_COAPPROVAL_100K"]);
  assert.deepEqual(h.refusals("releaseFunds", { claim_id: "C-G", kind: "contents_ale", amount_cents: 9999999n }), []);
  assert.deepEqual(h.refusals("releaseFunds", { claim_id: "C-G", kind: "contents_ale", amount_cents: 10000000n, officer_approval_id: "APP-1" }), []);
  assert.deepEqual(h.refusals("releaseFunds", { claim_id: "C-G", kind: "contents_ale", amount_cents: 10000000n }, OFFICER), []);
  assert.deepEqual(h.refusals("releaseFunds", { claim_id: "C-G", kind: "contents_ale", amount_cents: 100n, net_servicer_expenses: true }), ["NO_NETTING"]);
  assert.deepEqual(h.refusals("requestEndorsement", { instrument_id: "CHK-G", amount_cents: 6000000n, endorse: true }), ["LPOA_SIGNING_OFFICER"]);
  assert.deepEqual(await h.run("requestEndorsement", { instrument_id: "CHK-G", amount_cents: 6000000n }), { borrower_endorses_first: true, servicer_endorsement: "signing_officer under the LPOA", dual_control: true });
  await assert.rejects(h.run("depositInstrument", { claim_id: "C-G", instrument_id: "CHK-G", amount_cents: 0n }), RangeError);
});
