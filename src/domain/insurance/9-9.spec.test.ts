// 9.9 Property preservation (vacant)
// spec/sections/09-insurance-property-protection/9-9-property-preservation-vacant.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
// Every T-id that names a clock runs the Given/When/Then through the 9.9 tools (src/app/tools/section09.ts → ops-9-9.ts)
// with a TimerEngine armed on the overridden registry, so each Matrix clock is armed by the event the process emits and
// closed by the event the process (or the 15.2 HomeTracker / claim pipeline it hands off to) emits.
import { addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { initialServicesDue, initialSecuringStatus, evaluateScope, itemDisposition, bidDue, reconsiderationDue, bidPackage, photosFresh, winterizationRequired, tarpDeadline, damageDisposition, registrationClocks } from "./preservation.ts";
import { vacantRegistration, preservationPlan, auditRequest } from "./ops.ts";
import { postingPlaced, conditionDiscovered, workCompleted, POSTING_MAX_DAYS_AFTER_FTV, type PreservationCtx } from "./ops-9-9.ts";
import { ingestHomeTrackerBid, bidReconsideration, milestoneReached } from "../reo/ops-15-2.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { CommandContext } from "../../app/commands.ts";
import { SECTION_09_TOOLS } from "../../app/tools/section09.ts";

const AGENT: Actor = { kind: "agent", id: "insurance-property" };
const VENDOR: Actor = { kind: "external", id: "field-services-vendor" };
const REO: Actor = { kind: "agent", id: "reo-claims" };
type Out = Record<string, any>;
const toolOf = (process: string, name: string) => SECTION_09_TOOLS.find((t) => t.process === process && t.name === name)!;
const tool = (name: string) => toolOf("9.9", name);
const CTX = { actor: AGENT, now: "2027-03-08T15:00:00.000Z", loanId: "L-1" } as unknown as CommandContext;
const refusals = (name: string, input: Record<string, unknown>): string[] => (tool(name).guardrails ?? []).map((g) => [g.code, g.refuse(input, CTX)] as const).filter(([, r]) => r !== undefined).map(([c]) => c);
const runtime = (): { events: MemoryEventStore; rt: ToolRuntime; ctx: CommandContext } => { const events = new MemoryEventStore(new FixedClock(CTX.now)); const rt: ToolRuntime = { store: new EntityStore(), ports: {}, escalations: new EscalationService(events, new FixedClock(CTX.now)), services: {} }; return { events, rt, ctx: { ...CTX, events } as unknown as CommandContext }; };
/** One loan, one (settable) clock, one event store, the 9.9 timers armed on it, and the tools/ops bound to that store. */
function harness(nowIso: string, loanId = "L-1") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const registry = loadOverriddenRegistry();
  const timers = new TimerEngine(registry, events, { processes: ["9.9"] });
  const rt: ToolRuntime = { store: new EntityStore(), ports: {}, escalations: new EscalationService(events, clock), services: {} };
  const ctx = (actor: Actor = AGENT) => ({ actor, now: clock.now(), loanId, events } as unknown as CommandContext);
  const run = async (name: string, input: Record<string, unknown>, actor: Actor = AGENT, process = "9.9"): Promise<Out> => (await toolOf(process, name).handler({ loan_id: loanId, ...input }, ctx(actor), rt)) as Out;
  const ops = (actor: Actor = AGENT): PreservationCtx => ({ events, actor, loanId, now: clock.now() });
  const timer = (code: string) => timers.byCode(code).at(-1)!;
  const last = (type: string) => events.ofType(type).at(-1)!;
  const at = (date: string) => clock.set(`${date}T15:00:00.000Z`);
  const def = (code: string) => registry.get(code)!;
  /** 9.8's certified vacancy (updateOccupancy → `property.vacancy_confirmed{ftv_date}`) opens this process. */
  const vacancy = (ftv: string, extra: Record<string, unknown> = {}) => run("updateOccupancy", { occupancy: "vacant", inspected_on: ftv, certification_signed: true, ftv_date: ftv, ...extra }, AGENT, "9.8");
  const PHOTOS = (before: string, after: string) => [{ stage: "before", taken_on: before }, { stage: "during", taken_on: after }, { stage: "after", taken_on: after }];
  return { clock, events, registry, timers, rt, run, ops, timer, last, at, def, vacancy, PHOTOS };
}
const SCOPE = [{ kind: "lock_change" as const, qty: 1, unit_cost_cents: 6000n }, { kind: "boarding" as const, qty: 2, unit_cost_cents: 18500n }, { kind: "yard_initial" as const, qty: 1, unit_cost_cents: 15000n }, { kind: "debris" as const, qty: 8, unit_cost_cents: 5000n, measure: 8 }, { kind: "winterization" as const, qty: 1, unit_cost_cents: 22000n }, { kind: "posting" as const, qty: 1, unit_cost_cents: 5000n }];

test("9.9-T1: Given FTV 2027-03-05 Then initial securing/services due 2027-03-19; a 2027-03-16 completion satisfies; 2027-03-20 breaches with reason required.", async () => {
  assert.equal(initialServicesDue(D("2027-03-05")), "2027-03-19");
  assert.deepEqual(initialSecuringStatus(D("2027-03-05"), D("2027-03-16")), { due: "2027-03-19", on_time: true, breach: null, reason_required: false });
  assert.deepEqual(initialSecuringStatus(D("2027-03-05"), D("2027-03-19")), { due: "2027-03-19", on_time: true, breach: null, reason_required: false });
  assert.deepEqual(initialSecuringStatus(D("2027-03-05"), D("2027-03-20")), { due: "2027-03-19", on_time: false, breach: "sev1", reason_required: true });
  // 9.8's certified vacancy (`property.vacancy_confirmed{ftv_date=2027-03-05}`) arms FNMA_PPM_INITIAL_SECURE_14 from FTV (2027-03-19) and the D2-2-10 carrier notice clock (5 servicer business days: Friday 03-05 → Friday 03-12)
  const h = harness("2027-03-05T15:00:00.000Z");
  await h.vacancy("2027-03-05");
  assert.equal(h.last("property.vacancy_confirmed").payload.ftv_date, "2027-03-05");
  assert.equal(h.timer("FNMA_PPM_INITIAL_SECURE_14").status, "armed"); assert.equal(h.timer("FNMA_PPM_INITIAL_SECURE_14").dueDate, "2027-03-19"); assert.equal(h.timer("FNMA_PPM_INITIAL_SECURE_14").anchorDate, "2027-03-05");
  assert.equal(h.timer("INS_VACANCY_CARRIER_NOTIFY_5BD").dueDate, addBusinessDays(D("2027-03-05"), 5, servicer)); assert.equal(h.timer("INS_VACANCY_CARRIER_NOTIFY_5BD").dueDate, "2027-03-12");
  // the vendor's vacancy posting (reviewCompletion op=posting → `preservation.posting.placed{expires_on}`): securing 7 days after the 03-12 expiry = 03-19, still ≤ FTV + 14; a posting expiring after FTV + 7 is refused because its 7 days would run past the 14
  h.at("2027-03-06");
  const posting = await h.run("reviewCompletion", { op: "posting", posted_on: "2027-03-06", expires_on: "2027-03-12", ftv_date: "2027-03-05", projected_securing_date: "2027-03-16", servicer_contact: "Supermortgage 800-555-0100 (24/7)", vendor_contact: "Vendor 800-555-0199 (24/7)", text: "This property is being maintained. For access or questions call 800-555-0100." }, VENDOR);
  assert.equal(posting.posted, true); assert.equal(posting.secure_by, "2027-03-19"); assert.equal(posting.initial_due, "2027-03-19");
  assert.equal(h.timer("FNMA_PPM_POST_NOTICE_SECURE_7").status, "armed"); assert.equal(h.timer("FNMA_PPM_POST_NOTICE_SECURE_7").anchorDate, "2027-03-12"); assert.equal(h.timer("FNMA_PPM_POST_NOTICE_SECURE_7").dueDate, "2027-03-19");
  assert.equal(addDays(D("2027-03-05"), POSTING_MAX_DAYS_AFTER_FTV), "2027-03-12");
  assert.throws(() => postingPlaced(h.ops(VENDOR), { posted_on: "2027-03-06", expires_on: "2027-03-13", ftv_date: "2027-03-05", projected_securing_date: "2027-03-16", servicer_contact: "x", vendor_contact: "y" }), RangeError);
  assert.throws(() => postingPlaced(h.ops(VENDOR), { posted_on: "2027-03-06", expires_on: "2027-03-12", ftv_date: "2027-03-05", projected_securing_date: "2027-03-20", servicer_contact: "x", vendor_contact: "y" }), RangeError);   // projected securing > FTV + 14
  assert.throws(() => postingPlaced(h.ops(VENDOR), { posted_on: "2027-03-06", expires_on: "2027-03-12", ftv_date: "2027-03-05", projected_securing_date: "2027-03-16", servicer_contact: "x", vendor_contact: "y", text: "You are in default and foreclosure is pending" }), RangeError);   // neutral postings only
  assert.equal(h.events.ofType("preservation.posting.placed").length, 1);
  await h.run("notifyCarrierVacancy", { vacancy_on: "2027-03-05" });
  assert.equal(h.timer("INS_VACANCY_CARRIER_NOTIFY_5BD").status, "satisfied");
  // the vendor's completion report on 2027-03-16 (before/during/after photos, haul-away evidence) → `preservation.work.completed{kind=initial_services}` + `preservation.initial.completed` close both securing clocks
  h.at("2027-03-16");
  const done = await h.run("reviewCompletion", { kind: "initial_services", completed_on: "2027-03-16", ftv_date: "2027-03-05", photos: h.PHOTOS("2027-03-08", "2027-03-16"), haul_away_evidence: true, cost_cents: 125000n, invoice_document_id: "inv-1" }, VENDOR);
  assert.equal(done.recorded, true); assert.deepEqual(done.initial, { due: "2027-03-19", on_time: true, breach: null, reason: null }); assert.equal(done.complete, true);
  assert.equal(h.last("preservation.initial.completed").payload.on_time, true); assert.equal(h.last("preservation.initial.completed").payload.ftv_date, "2027-03-05");
  assert.equal(h.last("preservation.work.completed").payload.kind, "initial_services"); assert.equal(h.last("preservation.work.completed").payload.cost_cents, 125000n);
  assert.equal(h.timer("FNMA_PPM_INITIAL_SECURE_14").status, "satisfied"); assert.equal(h.timer("FNMA_PPM_INITIAL_SECURE_14").satisfiedByEventId, h.last("preservation.initial.completed").id);
  assert.equal(h.timer("FNMA_PPM_POST_NOTICE_SECURE_7").status, "satisfied");
  assert.ok(eventMatches(h.def("FNMA_PPM_INITIAL_SECURE_14").satisfiedPattern!, h.last("preservation.initial.completed")));
  assert.ok(eventMatches(h.def("FNMA_PPM_POST_NOTICE_SECURE_7").satisfiedPattern!, h.last("preservation.initial.completed")));
  // 2027-03-20: the clock has breached sev-1; a completion report without the documented reason is refused and appends nothing; with the reason it closes the clock late
  const late = harness("2027-03-05T15:00:00.000Z"); await late.vacancy("2027-03-05"); late.at("2027-03-20");
  const breaches = late.timers.evaluate(late.clock.now());
  assert.equal(breaches.find((b) => b.instance.code === "FNMA_PPM_INITIAL_SECURE_14")!.severity, 1); assert.equal(late.timer("FNMA_PPM_INITIAL_SECURE_14").status, "breached");
  const report = { kind: "initial_services", completed_on: "2027-03-20", ftv_date: "2027-03-05", photos: late.PHOTOS("2027-03-08", "2027-03-20"), haul_away_evidence: true };
  await assert.rejects(late.run("reviewCompletion", report, VENDOR), (e: Error) => e instanceof RangeError && /reason/.test(e.message));
  assert.equal(late.events.ofType("preservation.initial.completed").length, 0); assert.equal(late.events.ofType("preservation.work.completed").length, 0);
  const lateDone = await late.run("reviewCompletion", { ...report, reason: "utility company delayed the water shut-off (documented)" }, VENDOR);
  assert.deepEqual(lateDone.initial, { due: "2027-03-19", on_time: false, breach: "sev1", reason: "utility company delayed the water shut-off (documented)" });
  assert.equal(late.timer("FNMA_PPM_INITIAL_SECURE_14").status, "satisfied_late"); assert.equal(late.last("preservation.initial.completed").payload.late, true);
});
test("9.9-T2: Given the worked scope Then total $1,250.00 all within allowables; no bid; work ordered same day.", async () => {
  const s = evaluateScope(SCOPE);
  assert.equal(s.total_cents, 125000n); assert.equal(s.prior_approval_required, false); assert.ok(s.items.every((i) => i.disposition === "within_allowable"));
  const { events, rt, ctx } = runtime();
  assert.deepEqual(refusals("orderWork", { loan_id: "L-1", items: SCOPE, vacancy_confirmed: true, entry_permitted: true }), []);
  const o = (await tool("orderWork").handler({ loan_id: "L-1", items: SCOPE }, ctx, rt)) as { ordered: boolean; total_cents: bigint; prior_approval_required: boolean; conditions: unknown[] };
  assert.deepEqual(o, { ordered: true, total_cents: 125000n, prior_approval_required: false, conditions: [] });
  const ordered = events.ofType("preservation.work.ordered")[0]!;
  assert.equal(ordered.occurredAt, CTX.now); assert.equal(ordered.payload.total_cents, 125000n); assert.equal(ordered.payload.kind, "initial_services");   // ordered the same day as the scope
  // buildInitialScope from the vacancy inspection's condition flags reproduces the worked scope: lock change $60, 2 × $185 clear boarding, yard $150, 8 CY × $50, wet winterization $220, posting $50
  const built = (await tool("buildInitialScope").handler({ loan_id: "L-1", condition_flags: ["lock_change", "broken_window", "broken_window", "lawn", "winterization"], debris_cy: 8, vacancy_confirmed: true, entry_permitted: true }, ctx, rt)) as { total_cents: bigint; prior_approval_required: boolean; work_items: unknown[] };
  assert.equal(built.total_cents, 125000n); assert.equal(built.prior_approval_required, false); assert.equal(built.work_items.length, 6);
  assert.deepEqual(refusals("buildInitialScope", { loan_id: "L-1", condition_flags: [], vacancy_confirmed: false, entry_permitted: true }), ["NO_ENTRY_WITHOUT_VACANCY"]);
});
test("9.9-T3: Given 25 CY debris discovered 2027-03-08 Then work stops at the allowable, bid due 2027-03-23, `human_portal_task` for HomeTracker created with photos ≤ 30 days old.", async () => {
  const item = { kind: "debris" as const, qty: 25, unit_cost_cents: 5000n, measure: 25 };
  assert.equal(itemDisposition(item).disposition, "stop_and_bid"); assert.equal(evaluateScope([item]).prior_approval_required, true);
  assert.equal(bidDue(D("2027-03-08")), "2027-03-23"); assert.equal(reconsiderationDue(D("2027-03-30")), "2027-04-06");
  assert.deepEqual(refusals("orderWork", { loan_id: "L-1", items: [item], vacancy_confirmed: true, entry_permitted: true }), ["NO_OVER_ALLOWABLE_WITHOUT_APPROVAL"]);   // work stops at the allowable
  const pkg = bidPackage(D("2027-03-08"), [D("2027-03-08")], D("2027-03-10"));
  assert.equal(pkg.due, "2027-03-23"); assert.equal(pkg.human_task, "human_portal_task"); assert.equal(pkg.owner_role, "fnma_portal_operator"); assert.equal(pkg.channel, "hometracker"); assert.equal(pkg.photos_fresh, true);
  assert.equal(photosFresh(D("2027-02-08"), D("2027-03-10")), true); assert.equal(photosFresh(D("2027-02-07"), D("2027-03-10")), false);
  // prepareBid records the over-allowable discovery (`preservation.condition.discovered{over_allowable=true, discovered_on=2027-03-08}` arms FNMA_PPM_OVER_ALLOWABLE_BID_15 due 2027-03-23) and opens the HomeTracker portal task
  const h = harness("2027-03-10T15:00:00.000Z");
  const bid = await h.run("prepareBid", { discovered_on: "2027-03-08", submitted_on: "2027-03-10", items: [item], photos: [{ stage: "before", taken_on: "2027-03-08" }] });
  assert.equal(bid.due, "2027-03-23"); assert.equal(bid.human_task_kind, "human_portal_task"); assert.equal(bid.owner_role, "fnma_portal_operator"); assert.equal(bid.photos_fresh, true); assert.deepEqual(bid.conditions, ["debris"]);
  assert.equal(h.rt.escalations.opened.length, 1); assert.equal(h.rt.escalations.opened[0]!.payload.portal, "HomeTracker");
  assert.equal(h.events.ofType("escalation.created").length, 1);
  const found = h.last("preservation.condition.discovered");
  assert.equal(found.payload.item, "debris"); assert.equal(found.payload.over_allowable, true); assert.equal(found.payload.disposition, "stop_and_bid"); assert.equal(found.payload.measure, 25); assert.equal(found.payload.bid_due, "2027-03-23");
  assert.equal(h.timer("FNMA_PPM_OVER_ALLOWABLE_BID_15").status, "armed"); assert.equal(h.timer("FNMA_PPM_OVER_ALLOWABLE_BID_15").anchorDate, "2027-03-08"); assert.equal(h.timer("FNMA_PPM_OVER_ALLOWABLE_BID_15").dueDate, "2027-03-23");
  assert.deepEqual(refusals("prepareBid", { loan_id: "L-1", discovered_on: "2027-03-08", submitted_on: "2027-03-23", photos: [{ taken_on: "2027-02-01" }] }), ["BID_PHOTOS_FRESH"]);
  assert.deepEqual(refusals("prepareBid", { loan_id: "L-1", discovered_on: "2027-03-08", photos: [{ taken_on: "2027-02-01" }] }), ["BID_PHOTOS_FRESH"]);   // no submitted_on: freshness judged today (2027-03-08 → 36 days old)
  assert.deepEqual(refusals("prepareBid", { loan_id: "L-1", discovered_on: "2027-03-08", photos: [{ taken_on: "2027-02-08" }] }), []);
  // the portal operator's HomeTracker submission (15.2 ingestHomeTrackerBid → `preservation.bid.submitted`) closes the 15-day clock; Fannie Mae's modified decision on 2027-03-30 (20 of 25 CY) arms the 7-day reconsideration due 2027-04-06
  h.at("2027-03-20");
  const ht = ingestHomeTrackerBid("L-1", { bid_id: "HT-1", advance_id: "adv-1", item: "debris", bid_cents: 125000n, cap_cents: 50000n, submitted_on: D("2027-03-20") });
  for (const e of ht.events) h.events.append({ type: e.type, loanId: "L-1", aggregate: { kind: "hometracker_bids", id: "HT-1" }, actor: REO, payload: e.payload });
  assert.equal(h.timer("FNMA_PPM_OVER_ALLOWABLE_BID_15").status, "satisfied");
  h.at("2027-03-30");
  const decided = ingestHomeTrackerBid("L-1", { bid_id: "HT-1", advance_id: "adv-1", item: "debris", bid_cents: 125000n, cap_cents: 50000n, submitted_on: D("2027-03-20"), outcome: "modified", approved_cents: 100000n, decided_on: D("2027-03-30") });
  h.events.append({ type: decided.events[1]!.type, loanId: "L-1", aggregate: { kind: "hometracker_bids", id: "HT-1" }, actor: REO, payload: decided.events[1]!.payload });
  assert.equal(h.timer("FNMA_PPM_BID_RECONSIDER_7").status, "armed"); assert.equal(h.timer("FNMA_PPM_BID_RECONSIDER_7").dueDate, "2027-04-06"); assert.equal(decided.reconsider_by, "2027-04-06");
  // with the approval record the 20 CY order is no longer refused; the remaining 5 CY reconsideration closes the 7-day clock
  assert.deepEqual(refusals("orderWork", { loan_id: "L-1", items: [item], fnma_approval_id: "HT-1", vacancy_confirmed: true, entry_permitted: true }), []);
  const rc = bidReconsideration("L-1", decided, D("2027-04-02"), ["photos", "revised scope"]);
  h.events.append({ type: rc.event.type, loanId: "L-1", actor: REO, payload: rc.event.payload });
  assert.equal(h.timer("FNMA_PPM_BID_RECONSIDER_7").status, "satisfied"); assert.equal(rc.late, false);
});
test("9.9-T4: Given 15 CY debris Then complete and BATF with before/after photos.", async () => {
  assert.equal(itemDisposition({ kind: "debris", qty: 15, unit_cost_cents: 5000n, measure: 15 }).disposition, "complete_and_batf");
  assert.equal(itemDisposition({ kind: "debris", qty: 10, unit_cost_cents: 5000n, measure: 10 }).disposition, "within_allowable");
  assert.deepEqual(refusals("orderWork", { loan_id: "L-1", items: [{ kind: "debris", qty: 15, unit_cost_cents: 5000n, measure: 15 }], vacancy_confirmed: true, entry_permitted: true }), []);   // BATF needs no prior approval
  assert.deepEqual(refusals("orderWork", { loan_id: "L-1", items: [{ kind: "debris", qty: 15, unit_cost_cents: 5000n, measure: 15 }] }), ["NO_ENTRY_WITHOUT_VACANCY"]);   // the order dispatches entry: confirmed vacancy + permitted entry first
  assert.deepEqual(refusals("orderWork", { loan_id: "L-1", items: [{ kind: "debris", qty: 2, unit_cost_cents: 5000n, measure: 2, materials: ["tires", "paint cans"] }], vacancy_confirmed: true, entry_permitted: true }), ["NO_HAZARDOUS_MATERIALS"]);   // Matrix: hazardous items excluded from debris
  const { rt, ctx } = runtime();
  const r = (await tool("reviewCompletion").handler({ photos: [{ stage: "before", taken_on: "2027-03-08" }, { stage: "during", taken_on: "2027-03-09" }, { stage: "after", taken_on: "2027-03-09" }], haul_away_evidence: true, submitted_on: "2027-03-10" }, ctx, rt)) as { complete: boolean; missing: string[]; fresh: boolean };
  assert.deepEqual(r, { complete: true, missing: [], fresh: true });
  assert.deepEqual(((await tool("reviewCompletion").handler({ photos: [{ stage: "before", taken_on: "2027-03-08" }], haul_away_evidence: true, submitted_on: "2027-03-10" }, ctx, rt)) as { missing: string[] }).missing, ["during", "after"]);
  // the discovery is complete-and-BATF (no bid clock: over_allowable=false arms nothing); the order goes out the same day and the vendor's completion carries batf=true with the before/during/after photos
  const h = harness("2027-03-08T15:00:00.000Z");
  const o = await h.run("orderWork", { kind: "ongoing", items: [{ kind: "debris", qty: 15, unit_cost_cents: 5000n, measure: 15 }], conditions: [{ item: "debris", discovered_on: "2027-03-08", measure: 15 }] });
  assert.equal(o.ordered, true); assert.equal(o.prior_approval_required, false); assert.equal(o.conditions[0].disposition, "complete_and_batf"); assert.equal(o.conditions[0].over_allowable, false); assert.equal(o.conditions[0].bid_due, "2027-03-23");   // BATF filed on the 15-day clock
  assert.equal(h.timers.byCode("FNMA_PPM_OVER_ALLOWABLE_BID_15").length, 0);
  h.at("2027-03-10");
  const done = await h.run("reviewCompletion", { kind: "ongoing", item: "debris", completed_on: "2027-03-09", batf: true, photos: h.PHOTOS("2027-03-08", "2027-03-09"), haul_away_evidence: true, cost_cents: 75000n }, VENDOR);
  assert.equal(done.recorded, true); assert.equal(done.batf, true); assert.equal(h.last("preservation.work.completed").payload.batf, true); assert.equal(h.last("preservation.work.completed").payload.item, "debris");
  await assert.rejects(h.run("reviewCompletion", { kind: "ongoing", item: "debris", completed_on: "2027-03-09", batf: true, photos: [{ stage: "before", taken_on: "2027-03-08" }, { stage: "after", taken_on: "2027-03-09" }], haul_away_evidence: true }, VENDOR), (e: Error) => e instanceof RangeError && /during photo missing/.test(e.message));
  await assert.rejects(h.run("reviewCompletion", { kind: "ongoing", item: "debris", completed_on: "2027-03-09", batf: true, photos: h.PHOTOS("2027-03-08", "2027-03-09"), haul_away_evidence: false }, VENDOR), (e: Error) => e instanceof RangeError && /haul-away/.test(e.message));
  assert.equal(h.events.ofType("preservation.work.completed").length, 1);
});
test("9.9-T5: Given grass at 40″ Then bid before work; at 20″ complete and BATF.", async () => {
  assert.equal(itemDisposition({ kind: "grass_cut", qty: 1, unit_cost_cents: 12000n, measure: 40 }).disposition, "stop_and_bid");
  assert.equal(itemDisposition({ kind: "grass_cut", qty: 1, unit_cost_cents: 12000n, measure: 20 }).disposition, "complete_and_batf");
  assert.equal(itemDisposition({ kind: "grass_cut", qty: 1, unit_cost_cents: 12000n, measure: 10 }).disposition, "within_allowable");
  // 40″ after the initial service: the discovery (`preservation.condition.discovered{item=grass_over_12in, over_allowable=true}`) arms FNMA_PPM_YARD_REBID_15 and the over-allowable clock, both due 15 days from discovery; the order is refused until Fannie Mae approves
  const h = harness("2027-05-03T15:00:00.000Z");
  const tall = await h.run("reviewCompletion", { op: "condition", item: "grass_over_12in", discovered_on: "2027-05-03", measure: 40, estimate_cents: 12000n, after_initial_securing: true, source: "vendor_field_report" }, VENDOR);
  assert.equal(tall.disposition, "stop_and_bid"); assert.equal(tall.over_allowable, true); assert.equal(tall.bid_due, "2027-05-18");
  assert.equal(h.timer("FNMA_PPM_YARD_REBID_15").status, "armed"); assert.equal(h.timer("FNMA_PPM_YARD_REBID_15").dueDate, "2027-05-18"); assert.equal(h.timer("FNMA_PPM_YARD_REBID_15").anchorDate, "2027-05-03");
  assert.equal(h.timer("FNMA_PPM_OVER_ALLOWABLE_BID_15").dueDate, "2027-05-18");
  assert.deepEqual(refusals("orderWork", { loan_id: "L-1", items: [{ kind: "grass_cut", qty: 1, unit_cost_cents: 12000n, measure: 40 }], vacancy_confirmed: true, entry_permitted: true }), ["NO_OVER_ALLOWABLE_WITHOUT_APPROVAL"]);
  const ht = ingestHomeTrackerBid("L-1", { bid_id: "HT-Y", advance_id: "adv-y", item: "yard", bid_cents: 12000n, cap_cents: 8000n, submitted_on: D("2027-05-10") });
  h.at("2027-05-10"); for (const e of ht.events) h.events.append({ type: e.type, loanId: "L-1", aggregate: { kind: "hometracker_bids", id: "HT-Y" }, actor: REO, payload: e.payload });
  assert.equal(h.timer("FNMA_PPM_YARD_REBID_15").status, "satisfied"); assert.equal(h.timer("FNMA_PPM_OVER_ALLOWABLE_BID_15").status, "satisfied");
  assert.ok(eventMatches(h.def("FNMA_PPM_YARD_REBID_15").satisfiedPattern!, h.last("preservation.bid.submitted")));
  // 20″: complete and BATF — no bid clock; the order is not refused and the vendor's completion carries batf=true
  const g = harness("2027-05-03T15:00:00.000Z");
  const mid = await g.run("orderWork", { kind: "ongoing", items: [{ kind: "grass_cut", qty: 1, unit_cost_cents: 8000n, measure: 20 }], conditions: [{ item: "grass_over_12in", discovered_on: "2027-05-03", measure: 20, estimate_cents: 8000n, after_initial_securing: true }] });
  assert.equal(mid.ordered, true); assert.equal(mid.conditions[0].disposition, "complete_and_batf"); assert.equal(mid.conditions[0].over_allowable, false);
  assert.equal(g.timers.byCode("FNMA_PPM_OVER_ALLOWABLE_BID_15").length, 0);
  assert.equal(g.timer("FNMA_PPM_YARD_REBID_15").status, "armed");   // the 12–36″ BATF is filed on the same 15-day clock ("bid submitted (or BATF filed for 12–36″)")
  g.at("2027-05-05");
  const cut = await g.run("reviewCompletion", { kind: "ongoing", item: "grass_cut", completed_on: "2027-05-04", batf: true, photos: g.PHOTOS("2027-05-03", "2027-05-04"), haul_away_evidence: true, cost_cents: 8000n }, VENDOR);
  assert.equal(cut.batf, true); assert.equal(g.last("preservation.work.completed").payload.item, "grass_cut");
  assert.throws(() => conditionDiscovered(g.ops(), { item: "grass_over_12in", discovered_on: "2027-05-03", measure: 10 }), RangeError);   // ≤ 12″ is within the allowable, not a grass_over_12in condition
});
test("9.9-T6: Given a property in Hawaii Then winterization not ordered; in Minnesota in July Then winterization ordered (year-round rule).", () => {
  assert.equal(winterizationRequired("HI"), false); assert.equal(winterizationRequired("PR"), false);
  assert.equal(winterizationRequired("MN"), true); assert.equal(winterizationRequired("TX"), true);        // no winterization season
});
test("9.9-T7: Given a city ordinance requiring vacant registration within 30 days and semi-annual renewal Then registration filed by the deadline, fee claimed at actual cost, renewal timer set.", async () => {
  const r = vacantRegistration({ trigger_on: D("2027-03-08"), rule: { within_days: 30, renewal_months: 6 }, fee_cents: 25000n });
  assert.equal(r.file_by, "2027-04-07");
  assert.equal(r.renew_on, "2027-10-07"); assert.equal(r.renewal_anchor, "filing_deadline");            // not yet filed: the ordinance period runs from the latest filing date
  assert.equal(r.fee_claim_cents, 25000n); assert.equal(r.fee_basis, "actual_cost"); assert.equal(r.fines_reimbursable, false);
  const filed = vacantRegistration({ trigger_on: D("2027-03-08"), rule: { within_days: 30, renewal_months: 6 }, fee_cents: 25000n, filed_on: D("2027-03-20") });
  assert.equal(filed.filed_on_time, true); assert.equal(filed.renew_on, "2027-09-20"); assert.equal(filed.renewal_anchor, "filed_at");   // JUR_VACANT_REGISTRATION_RENEWAL anchors on filed_at
  assert.equal(registrationClocks(D("2027-03-08"), { within_days: 30, renewal_months: null })!.renew_on, null);
  // fileRegistration records the filing (`preservation.registration.filed{filed_at, renew_on, fee_cents}`) — the fee at actual cost is the 15.2 claim line
  const { events, rt, ctx } = runtime();
  const out = (await tool("fileRegistration").handler({ loan_id: "L-1", trigger_on: "2027-03-08", rule: { within_days: 30, renewal_months: 6 }, fee_cents: 25000n, filed_on: "2027-03-20" }, ctx, rt)) as { filed_on_time: boolean; renew_on: string };
  assert.equal(out.filed_on_time, true); assert.equal(out.renew_on, "2027-09-20");
  const ev = events.ofType("preservation.registration.filed")[0]!;
  assert.equal(ev.payload.filed_at, "2027-03-20"); assert.equal(ev.payload.renew_on, "2027-09-20"); assert.equal(ev.payload.fee_cents, 25000n); assert.equal(ev.payload.file_by, "2027-04-07");
});
test("9.9-T8: Given a tarp installed 2027-04-01 Then permanent repair or re-bid required by 2027-05-31.", async () => {
  assert.equal(tarpDeadline(D("2027-04-01")), "2027-05-31");
  assert.equal(damageDisposition(125000n), "patch"); assert.equal(damageDisposition(125001n), "tarp_and_bid");
  // the vendor's tarp completion (`preservation.work.completed{item=roof_tarp, completed_on=2027-04-01}`) arms FNMA_PPM_ROOF_TARP_60 from the install date: 2027-05-31
  const h = harness("2027-04-02T15:00:00.000Z");
  const tarp = await h.run("reviewCompletion", { kind: "damage", item: "roof_tarp", completed_on: "2027-04-01", photos: h.PHOTOS("2027-03-30", "2027-04-01"), haul_away_evidence: true, cost_cents: 100000n }, VENDOR);
  assert.equal(tarp.tarp_repair_due, "2027-05-31"); assert.equal(h.last("preservation.work.completed").payload.tarp_repair_due, "2027-05-31");
  assert.equal(h.timer("FNMA_PPM_ROOF_TARP_60").status, "armed"); assert.equal(h.timer("FNMA_PPM_ROOF_TARP_60").anchorDate, "2027-04-01"); assert.equal(h.timer("FNMA_PPM_ROOF_TARP_60").dueDate, "2027-05-31");
  assert.ok(eventMatches(h.def("FNMA_PPM_ROOF_TARP_60").triggerPattern!, h.last("preservation.work.completed")));
  // no permanent repair by 2027-05-31 → sev-2 breach (re-tarp bid); the permanent repair completion closes it late
  h.at("2027-06-01");
  assert.equal(h.timers.evaluate(h.clock.now()).find((b) => b.instance.code === "FNMA_PPM_ROOF_TARP_60")!.severity, 2);
  await h.run("reviewCompletion", { kind: "damage", item: "roof_repair", completed_on: "2027-06-01", photos: h.PHOTOS("2027-05-28", "2027-06-01"), haul_away_evidence: true, cost_cents: 350000n }, VENDOR);
  assert.equal(h.timer("FNMA_PPM_ROOF_TARP_60").status, "satisfied_late");
  // a repair on time closes it cleanly
  const g = harness("2027-04-02T15:00:00.000Z");
  await g.run("reviewCompletion", { kind: "damage", item: "roof_tarp", completed_on: "2027-04-01", photos: g.PHOTOS("2027-03-30", "2027-04-01"), haul_away_evidence: true }, VENDOR);
  g.at("2027-05-10"); await g.run("reviewCompletion", { kind: "damage", item: "roof_repair", completed_on: "2027-05-10", photos: g.PHOTOS("2027-05-08", "2027-05-10"), haul_away_evidence: true }, VENDOR);
  assert.equal(g.timer("FNMA_PPM_ROOF_TARP_60").status, "satisfied"); assert.equal(g.timer("FNMA_PPM_ROOF_TARP_60").satisfiedByEventId, g.last("preservation.work.completed").id);
});
test('9.9-T9: Given a PFPIP loan with "Do insp and preserv" Then mode `pfpip`; no servicer securing order; program activity monitored; occupancy/claim/HOA updates sent.', async () => {
  const p = preservationPlan({ pfpip: true, permission: "Do insp and preserv", chapter13_active: false });
  assert.equal(p.mode, "pfpip"); assert.equal(p.servicer_securing_order, false); assert.equal(p.monitor_program, true); assert.deepEqual(p.updates, ["occupancy", "claim", "hoa", "stop_work"]);
  // openPreservation (9.8 hand-off) records the case in program mode; the vacancy on a PFPIP loan also reports the occupancy change to the program (`loan.status.reported_to_fnma{change=occupancy}`)
  const h = harness("2027-03-05T15:00:00.000Z");
  const c = await h.run("openPreservation", { pfpip: true, permission: "Do insp and preserv", chapter13_active: false }, AGENT, "9.8");
  assert.equal(c.mode, "pfpip"); assert.equal(h.rt.store.get("preservation_cases", "pp-L-1")!.data.mode, "pfpip");
  await h.vacancy("2027-03-05", { pfpip: true });
  assert.equal(h.last("loan.status.reported_to_fnma").payload.change, "occupancy"); assert.equal(h.last("loan.status.reported_to_fnma").payload.pfpip_enrolled, true);
  assert.equal(h.events.ofType("preservation.work.ordered").length, 0);   // no servicer securing order
  assert.equal(preservationPlan({ pfpip: true, permission: "Do curbside inspection and no preserv.", chapter13_active: false }).mode, "servicer");   // permission-restricted → servicer mode
});
test("9.9-T10: Given an active Chapter 13 case Then preservation suspended pending `attorney` guidance; PFPIP permissions restricted.", () => {
  const p = preservationPlan({ pfpip: true, permission: "Do insp and preserv", chapter13_active: true });
  assert.equal(p.mode, "suspended"); assert.equal(p.attorney_guidance_required, true); assert.equal(p.pfpip_permission, "Do curbside inspection and no preserv."); assert.equal(p.servicer_securing_order, false);
});
test("9.9-T11: Given a Fannie Mae audit request on 2027-05-03 Then documents delivered by 2027-05-10.", async () => {
  const r = auditRequest(D("2027-05-03"));
  assert.equal(r.documents_due, "2027-05-10"); assert.equal(r.calendar_deadline, "2027-05-10"); assert.equal(r.role, "officer");
  // the request logged by the Fannie Mae request intake (`fnma.request.received{kind=preservation_audit}`) arms FNMA_PPM_AUDIT_RESPONSE_7 for 2027-05-10 (sev-1 → officer); the officer's response closes it
  const h = harness("2027-05-03T15:00:00.000Z");
  h.events.append({ type: "fnma.request.received", loanId: "L-1", actor: { kind: "external", id: "fnma" }, payload: { kind: "preservation_audit", request: "2027-05-03", request_id: "AUD-1" } });
  assert.equal(h.timer("FNMA_PPM_AUDIT_RESPONSE_7").dueDate, "2027-05-10"); assert.deepEqual(h.def("FNMA_PPM_AUDIT_RESPONSE_7").severity, { level: 1, escalateTo: ["officer"] });
  h.at("2027-05-10"); h.events.append({ type: "fnma.request.responded", loanId: "L-1", actor: { kind: "human", id: "officer-1", role: "officer" }, payload: { kind: "preservation_audit", request_id: "AUD-1", documents: ["work orders", "photos", "invoices"] } });
  assert.equal(h.timer("FNMA_PPM_AUDIT_RESPONSE_7").status, "satisfied");
});

test("9.9 worked example: initial scope lock change, two boardings, yard, 8 CY debris, winterization and posting = $1,250.00 within allowables", () => {
  const s = evaluateScope([{ kind: "lock_change", qty: 1, unit_cost_cents: 6000n }, { kind: "boarding", qty: 2, unit_cost_cents: 18500n }, { kind: "yard_initial", qty: 1, unit_cost_cents: 15000n }, { kind: "debris", qty: 8, unit_cost_cents: 5000n, measure: 8 }, { kind: "winterization", qty: 1, unit_cost_cents: 22000n }, { kind: "posting", qty: 1, unit_cost_cents: 5000n }]);
  assert.equal(s.total_cents, 125000n); assert.equal(s.prior_approval_required, false);
});
test("9.9 FNMA_PPM_WINDOW_DOOR_REPAIR_3: an unsecured window/door discovered after initial securing is repaired or clear-boarded within 3 calendar days; one found before securing is part of the 14-day initial scope", async () => {
  const h = harness("2027-03-20T15:00:00.000Z");
  // before initial securing: no 3-day clock (the opening is secured within the 14 days)
  await h.run("orderWork", { items: [{ kind: "boarding", qty: 1, unit_cost_cents: 18500n }], conditions: [{ item: "unsecured_opening", discovered_on: "2027-03-08", after_initial_securing: false }] });
  assert.equal(h.timers.byCode("FNMA_PPM_WINDOW_DOOR_REPAIR_3").length, 0); assert.equal(h.last("preservation.condition.discovered").payload.repair_due, null);
  // after initial securing: discovery 2027-03-20 → repair due 2027-03-23
  const o = await h.run("orderWork", { kind: "ongoing", items: [{ kind: "boarding", qty: 1, unit_cost_cents: 18500n }], conditions: [{ item: "unsecured_opening", discovered_on: "2027-03-20", after_initial_securing: true, source: "inspection" }] });
  assert.equal(o.conditions[0].repair_due, "2027-03-23"); assert.equal(o.conditions[0].disposition, "within_allowable");
  assert.equal(h.timer("FNMA_PPM_WINDOW_DOOR_REPAIR_3").status, "armed"); assert.equal(h.timer("FNMA_PPM_WINDOW_DOOR_REPAIR_3").anchorDate, "2027-03-20"); assert.equal(h.timer("FNMA_PPM_WINDOW_DOOR_REPAIR_3").dueDate, "2027-03-23");
  assert.ok(eventMatches(h.def("FNMA_PPM_WINDOW_DOOR_REPAIR_3").triggerPattern!, h.last("preservation.condition.discovered")));
  h.at("2027-03-22");
  const fixed = await h.run("reviewCompletion", { kind: "ongoing", item: "unsecured_opening", completed_on: "2027-03-22", photos: h.PHOTOS("2027-03-20", "2027-03-22"), haul_away_evidence: true, cost_cents: 18500n }, VENDOR);
  assert.equal(fixed.item, "unsecured_opening"); assert.equal(h.timer("FNMA_PPM_WINDOW_DOOR_REPAIR_3").status, "satisfied");
  assert.ok(eventMatches(h.def("FNMA_PPM_WINDOW_DOOR_REPAIR_3").satisfiedPattern!, h.last("preservation.work.completed")));
  // a late repair breaches sev-2 first
  const late = harness("2027-03-20T15:00:00.000Z");
  conditionDiscovered(late.ops(VENDOR), { item: "unsecured_opening", discovered_on: "2027-03-20", after_initial_securing: true });
  late.at("2027-03-24"); assert.equal(late.timers.evaluate(late.clock.now()).find((b) => b.instance.code === "FNMA_PPM_WINDOW_DOOR_REPAIR_3")!.severity, 2);
  workCompleted(late.ops(VENDOR), { kind: "ongoing", item: "unsecured_opening", completed_on: "2027-03-24", photos: late.PHOTOS("2027-03-20", "2027-03-24"), haul_away_evidence: true });
  assert.equal(late.timer("FNMA_PPM_WINDOW_DOOR_REPAIR_3").status, "satisfied_late");
});
test("9.9 FNMA_F105_PRESERVATION_CLAIM_60: preservation costs are claimed through 15.2 within 60 calendar days of the milestone; the 15.2 filing closes the clock", async () => {
  // 15.2's milestone fact (reinstatement 2027-04-01) arms the clock from `milestone_date`, due 2027-05-31; the 15.2 filing (`expense_claim.status_changed{status=submitted}`, section15-2 submitClaim op=record_upload) closes it
  const h = harness("2027-04-01T15:00:00.000Z");
  const m = milestoneReached({ event_type: "loan.reinstated", loan_id: "L-1", milestone_date: D("2027-04-01"), mi_insured: false })!;
  h.events.append({ type: m.type, loanId: "L-1", actor: REO, payload: m.payload });
  const t = h.timer("FNMA_F105_PRESERVATION_CLAIM_60");
  assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2027-04-01"); assert.equal(t.dueDate, "2027-05-31");
  h.at("2027-05-20"); h.events.append({ type: "expense_claim.status_changed", loanId: "L-1", aggregate: { kind: "expense_claims", id: "ec-1" }, actor: REO, payload: { claim_id: "ec-1", status: "package_ready" } });
  assert.equal(h.timer("FNMA_F105_PRESERVATION_CLAIM_60").status, "armed");   // a package that is not yet uploaded is not a filing
  h.events.append({ type: "expense_claim.status_changed", loanId: "L-1", aggregate: { kind: "expense_claims", id: "ec-1" }, actor: REO, payload: { claim_id: "ec-1", status: "submitted", submitted_at: "2027-05-20", channel: "bulk_upload" } });
  assert.equal(h.timer("FNMA_F105_PRESERVATION_CLAIM_60").status, "satisfied");
  const late = harness("2027-04-01T15:00:00.000Z"); late.events.append({ type: m.type, loanId: "L-1", actor: REO, payload: m.payload });
  assert.equal(late.timers.evaluate("2027-06-01T05:00:00.000Z").find((b) => b.instance.code === "FNMA_F105_PRESERVATION_CLAIM_60")!.severity, 2);
});
