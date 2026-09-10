// 9.8 Property inspection (delinquent)
// spec/sections/09-insurance-property-protection/9-8-property-inspection-delinquent.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
// Every T-id runs the Given/When/Then through the 9.8 tools (src/app/tools/section09.ts → ops-9-8.ts) with a
// TimerEngine armed on the overridden registry, so each clock the T-id names is armed by the event the process emits
// and closed by the event the process emits — never by a hand-built event where the process has its own emitter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, dayOfWeek, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { fnmaDaysDelinquent, inspectionWindow, inspectionOrderAllowed, inspectionSuspended, nextInspectionWindow, preSaleInspection, inspectionMode, inspectionClaim, repairInspectionClaim, INSPECTION_CAPS, INSURED_LOSS_REPAIR_INSPECTION_CAP, servicerBackstopOrder, pfpipPermission, inspectionType, pfpipExceptionSubmitOn } from "./inspection.ts";
import { vacancyConfirmed, pfpipSubmission, PFPIP_MANDATORY_FIELDS } from "./ops.ts";
import { inspectionSweep, recordInspectionResult, suspectVacancy, pfpipChangeReported, inspectionClaimLines, type InspectionCtx } from "./ops-9-8.ts";
import { milestoneReached } from "../reo/ops-15-2.ts";
import { saleScheduled } from "../reo/ops-15-4.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { CommandContext } from "../../app/commands.ts";
import { SECTION_09_TOOLS } from "../../app/tools/section09.ts";

const AGENT: Actor = { kind: "agent", id: "insurance-property" };
const VENDOR: Actor = { kind: "external", id: "inspection-vendor" };
type Out = Record<string, any>;
const tool = (name: string) => SECTION_09_TOOLS.find((t) => t.process === "9.8" && t.name === name)!;
const CTX = { actor: AGENT, now: "2027-01-30T15:00:00.000Z", loanId: "L-1" } as unknown as CommandContext;
const refusals = (name: string, input: Record<string, unknown>): string[] => (tool(name).guardrails ?? []).map((g) => [g.code, g.refuse(input, CTX)] as const).filter(([, r]) => r !== undefined).map(([c]) => c);
const PKG = () => Object.fromEntries(PFPIP_MANDATORY_FIELDS.map((k) => [k, k === "stop_all_work" ? false : "value"]));
/** One loan, one (settable) clock, one event store, the 9.8 timers armed on it, and the tools/ops bound to that store. */
function harness(nowIso: string, loanId = "L-1") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const registry = loadOverriddenRegistry();
  const timers = new TimerEngine(registry, events, { processes: ["9.8"] });
  const rt: ToolRuntime = { store: new EntityStore(), ports: {}, escalations: new EscalationService(events, clock), services: {} };
  const ctx = (actor: Actor = AGENT) => ({ actor, now: clock.now(), loanId, events } as unknown as CommandContext);
  const run = async (name: string, input: Record<string, unknown>, actor: Actor = AGENT): Promise<Out> => (await tool(name).handler({ loan_id: loanId, ...input }, ctx(actor), rt)) as Out;
  const ops = (actor: Actor = AGENT): InspectionCtx => ({ events, actor, loanId, now: clock.now() });
  const timer = (code: string) => timers.byCode(code).at(-1)!;
  const last = (type: string) => events.ofType(type).at(-1)!;
  const at = (date: string) => clock.set(`${date}T15:00:00.000Z`);
  /** A vendor Form 30 result ingested through evaluateInspectionResult (the tool records it via ops-9-8 recordInspectionResult). */
  const complete = (id: string, completed_on: string, extra: Record<string, unknown> = {}) => run("evaluateInspectionResult", { result: { indicators: [], certification_signed: false, photos: 2 }, inspection_id: id, type: "exterior", purpose: "delinquency", completed_on, occupancy_result: "occupied_unknown", report_document_id: `form30-${id}`, cost_cents: 3000n, ...extra }, VENDOR);
  return { clock, events, registry, timers, rt, run, refusals, ops, timer, last, at, complete };
}

test("9.8-T1: Given due date 2026-11-01 unpaid When 2027-01-29 Then order refused; 2027-01-30 allowed; completion deadline 2027-03-01.", async () => {
  const w = inspectionWindow(D("2026-11-01"));
  assert.equal(w.order_allowed, "2027-01-30"); assert.equal(w.complete_by, "2027-03-01"); assert.equal(w.vacancy_exception_by, "2026-12-16");
  assert.equal(fnmaDaysDelinquent(D("2026-11-01"), D("2027-01-29")), 89); assert.equal(fnmaDaysDelinquent(D("2026-11-01"), D("2027-01-30")), 90);
  assert.equal(inspectionOrderAllowed("delinquency", 89).allowed, false); assert.equal(inspectionOrderAllowed("delinquency", 90).allowed, true);
  assert.equal(inspectionOrderAllowed("vacancy_confirmation", 12).allowed, true);                       // vacancy checks have no day-90 floor
  assert.equal(inspectionOrderAllowed("delinquency", NaN).allowed, false);                             // no day count → refused, never silently allowed
  const order = { loan_id: "L-1", type: "exterior", earliest_unpaid_due: "2026-11-01" };
  assert.deepEqual(refusals("orderInspection", { ...order, today: "2027-01-29" }), ["NO_ORDER_BEFORE_DAY90"]);
  assert.deepEqual(refusals("orderInspection", { ...order, today: "2027-01-30" }), []);
  assert.deepEqual(refusals("orderInspection", { loan_id: "L-1", type: "exterior", purpose: "pre_sale_35" }), ["NO_ORDER_BEFORE_DAY90"]);   // missing day count
  assert.deepEqual(refusals("orderInspection", { loan_id: "L-1", type: "exterior", purpose: "vacancy_confirmation" }), []);
  // the daily sweep (computeInspectionSchedule) on day 89: nothing armed; on day 90 it announces `delinquency.day90.reached` once and the D2-2-10 clocks arm from the earliest unpaid due date
  const h = harness("2027-01-29T15:00:00.000Z");
  const d89 = await h.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-01-29" });
  assert.equal(d89.day, 89); assert.equal(d89.state, "not_required"); assert.equal(d89.day90_reached, false); assert.equal(h.timers.all().length, 0);
  h.at("2027-01-30");
  const d90 = await h.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-01-30" });
  assert.equal(d90.day, 90); assert.equal(d90.state, "initial_due"); assert.equal(d90.day90_reached, true); assert.equal(d90.mode, "servicer");
  assert.equal(h.last("delinquency.day90.reached").payload.earliest_unpaid_due, "2026-11-01");
  assert.equal(h.timer("FNMA_D2210_INSPECT_ORDER_DAY90").dueDate, "2027-01-30"); assert.equal(h.timer("FNMA_D2210_INSPECT_ORDER_DAY90").status, "armed");
  assert.equal(h.timer("FNMA_D2210_INSPECT_COMPLETE_DAY120").dueDate, "2027-03-01"); assert.equal(h.timer("FNMA_D2210_INSPECT_COMPLETE_DAY120").status, "armed");
  await h.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-01-30" });                           // a second sweep the same day re-announces nothing
  assert.equal(h.events.ofType("delinquency.day90.reached").length, 1); assert.equal(h.timers.byCode("FNMA_D2210_INSPECT_COMPLETE_DAY120").length, 1);
  const o = await h.run("orderInspection", { type: "exterior", earliest_unpaid_due: "2026-11-01", today: "2027-01-30" });
  assert.equal(o.day, 90); assert.equal(h.timer("FNMA_D2210_INSPECT_ORDER_DAY90").status, "satisfied");
  assert.equal((await h.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-01-30" })).state, "initial_ordered");
  // completion by day 120: the vendor's result (Form 30 + photos) closes the day-120 clock; a result after 2027-03-01 would be late
  h.at("2027-02-15"); const r = await h.complete("insp-1", "2027-02-15");
  assert.equal(r.recorded, true); assert.equal(r.initial, true); assert.equal(h.timer("FNMA_D2210_INSPECT_COMPLETE_DAY120").status, "satisfied");
  assert.equal(h.last("property.inspection.completed").payload.completed_at, "2027-02-15");
  const late = harness("2027-01-30T15:00:00.000Z"); await late.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-01-30" });
  assert.equal(late.timers.evaluate("2027-03-02T05:00:00.000Z").find((b) => b.instance.code === "FNMA_D2210_INSPECT_COMPLETE_DAY120")!.severity, 1);   // sev-1 breach past day 120
});
test("9.8-T2: Given an occupied property with QRPC on 2027-02-10 When the recurring sweep runs on 2027-03-05 Then no inspection due (exception); QRPC ages past 30 days on 2027-03-13 → next inspection due within 20–35 days of the last.", async () => {
  const e = { occupied: true, last_qrpc_on: D("2027-02-10"), last_full_payment_on: null, performing_workout: false, performing_bk_plan: false };
  assert.equal(inspectionSuspended(e, D("2027-03-05")), true);
  assert.equal(inspectionSuspended(e, D("2027-03-12")), true); assert.equal(inspectionSuspended(e, D("2027-03-13")), false);   // day 31 after QRPC
  assert.equal(inspectionSuspended({ ...e, occupied: false }, D("2027-03-05")), false);                 // vacancy overrides every exception
  assert.deepEqual(nextInspectionWindow(D("2027-02-20")), { from: "2027-03-12", to: "2027-03-27" });
  // the loan's last (initial) inspection was completed 2027-02-20 → FNMA_D2210_INSPECT_RECUR_20_35 window 2027-03-12 … 2027-03-27 armed by that completion
  const h = harness("2027-01-30T15:00:00.000Z");
  await h.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-01-30" });
  h.at("2027-02-20"); await h.complete("insp-1", "2027-02-20");
  const recur = h.timer("FNMA_D2210_INSPECT_RECUR_20_35");
  assert.equal(recur.status, "armed"); assert.equal(recur.note, "window opens 2027-03-12"); assert.equal(recur.dueDate, "2027-03-27");
  h.at("2027-03-05");
  const s1 = await h.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-03-05", exception: { ...e, last_qrpc_on: "2027-02-10" } });
  assert.equal(s1.suspended, true); assert.equal(s1.state, "suspended_exception"); assert.equal(s1.next, null); assert.equal(s1.last_completed, "2027-02-20");
  h.at("2027-03-13");
  const s2 = await h.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-03-13", exception: { ...e, last_qrpc_on: "2027-02-10" } });
  assert.equal(s2.suspended, false); assert.equal(s2.state, "recurring"); assert.deepEqual(s2.next, { from: "2027-03-12", to: "2027-03-27" });
  // the next completion inside the window satisfies the row and re-arms it from its own completed_at (20–35 days again); no duplicate instance is armed
  h.at("2027-03-20"); const r2 = await h.complete("insp-2", "2027-03-20");
  assert.equal(r2.initial, false); assert.equal(recur.status, "satisfied");
  assert.equal(h.timers.byCode("FNMA_D2210_INSPECT_RECUR_20_35").length, 2);
  assert.equal(h.timer("FNMA_D2210_INSPECT_RECUR_20_35").note, "window opens 2027-04-09"); assert.equal(h.timer("FNMA_D2210_INSPECT_RECUR_20_35").dueDate, "2027-04-24");
  // sev-2 at day 36 when no inspection follows
  assert.equal(h.timers.evaluate("2027-04-25T05:00:00.000Z").find((b) => b.instance.code === "FNMA_D2210_INSPECT_RECUR_20_35")!.severity, 2);
});
test("9.8-T3: Given an inspection reports vacancy with a signed certification Then occupancy `vacant`, interior monthly schedule, carrier notified, 9.9 opened, PFPIP occupancy updated within 2 business days.", async () => {
  const v = vacancyConfirmed({ inspected_on: D("2027-02-10"), certification_signed: true, pfpip: true });
  assert.equal(v.occupancy, "vacant"); assert.deepEqual(v.interior_schedule, { from: "2027-03-02", to: "2027-03-17" });
  assert.equal(v.carrier_notify_by, "2027-02-18");   // 5 servicer BD (Presidents' Day closed)
  assert.equal(v.preservation_case, "opened");
  assert.equal(v.pfpip_update_by, "2027-02-12");     // 2 servicer BD
  assert.equal(vacancyConfirmed({ inspected_on: D("2027-02-10"), certification_signed: true, pfpip: false }).pfpip_update_by, null);
  assert.throws(() => vacancyConfirmed({ inspected_on: D("2027-02-10"), certification_signed: false, pfpip: true }), /signed certification/);
  assert.deepEqual(refusals("updateOccupancy", { loan_id: "L-1", occupancy: "vacant", inspected_on: "2027-02-10" }), ["VACANT_NEEDS_CERTIFICATION"]);
  // the vendor's result: two vacancy indicators + the inspector's signed certification → the tool classifies `vacant` and records the completed inspection
  const h = harness("2027-02-10T15:00:00.000Z");
  const r = await h.run("evaluateInspectionResult", { result: { indicators: ["utilities_off", "mail_piling"], certification_signed: true, photos: 4 }, inspection_id: "insp-v", type: "exterior", purpose: "delinquency", completed_on: "2027-02-10", occupancy_result: "vacant", report_document_id: "form30-v", cost_cents: 3000n, interior_entry_allowed: true }, VENDOR);
  assert.equal(r.occupancy, "vacant"); assert.equal(r.vacancy, "confirmed_certified"); assert.equal(r.type_next, "interior");
  assert.equal(h.last("property.inspection.completed").payload.certification_signed, true); assert.equal(h.events.ofType("property.vacancy_suspected").length, 0);
  // updateOccupancy: occupancy `vacant`, interior monthly clock from the certified inspection, PFPIP occupancy change to sync within 2 BD
  const u = await h.run("updateOccupancy", { occupancy: "vacant", inspected_on: "2027-02-10", certification_signed: true, pfpip: true, earliest_unpaid_due: "2026-11-01" });
  assert.equal(u.occupancy, "vacant"); assert.equal(h.rt.store.get("properties", "L-1")!.data.occupancy_status, "vacant");
  assert.equal(h.timer("FNMA_D2210_VACANT_INTERIOR_MONTHLY_35").dueDate, "2027-03-17"); assert.equal(h.timer("FNMA_D2210_VACANT_INTERIOR_MONTHLY_35").status, "armed");
  assert.equal(h.last("loan.status.reported_to_fnma").payload.change, "occupancy"); assert.equal(h.last("loan.status.reported_to_fnma").payload.pfpip_enrolled, true);
  assert.equal(h.timer("FNMA_P360_PFPIP_STATUS_SYNC_2BD").dueDate, "2027-02-12"); assert.equal(h.timer("FNMA_P360_PFPIP_STATUS_SYNC_2BD").status, "armed");
  assert.equal(h.timer("FNMA_P360_PFPIP_SUBMIT_EXCEPTION_DAY45").dueDate, "2027-02-10");                 // confirmed on day 101: the exception submission is due at once
  // carrier notified (9.1 rule 6 coverage review), 9.9 opened, PFPIP updated within the 2 business days
  const n = await h.run("notifyCarrierVacancy", { vacancy_on: "2027-02-10" }); assert.equal(n.notified, true); assert.equal(h.last("insurance.carrier.vacancy_notified").payload.vacancy_on, "2027-02-10");
  const p = await h.run("openPreservation", { pfpip: true, permission: "Do insp and preserv" }); assert.equal(p.status, "open"); assert.ok(h.rt.store.get("preservation_cases", "pp-L-1"));
  h.at("2027-02-12"); const up = await h.run("updatePfpip", { change: "occupancy", changed_on: "2027-02-10" });
  assert.equal(up.due, "2027-02-12"); assert.equal(h.timer("FNMA_P360_PFPIP_STATUS_SYNC_2BD").status, "satisfied");
  // interior monthly: an exterior result does not count; the interior inspection satisfies and re-arms ≤ 35 days from its own date
  h.at("2027-03-05"); await h.complete("insp-ext", "2027-03-05", { type: "exterior", purpose: "occupancy_check" });
  assert.equal(h.timer("FNMA_D2210_VACANT_INTERIOR_MONTHLY_35").status, "armed");
  h.at("2027-03-10"); await h.complete("insp-int", "2027-03-10", { type: "interior", purpose: "delinquency", occupancy_result: "vacant", result: { indicators: ["utilities_off", "no_furnishings"], certification_signed: true, photos: 6 } });
  assert.equal(h.timers.byCode("FNMA_D2210_VACANT_INTERIOR_MONTHLY_35")[0]!.status, "satisfied");
  assert.equal(h.timer("FNMA_D2210_VACANT_INTERIOR_MONTHLY_35").dueDate, "2027-04-14"); assert.equal(h.timer("FNMA_D2210_VACANT_INTERIOR_MONTHLY_35").status, "armed");
  // a vacancy finding without the signed certification is a suspicion (rule 5): confirmation inspection within 3 servicer business days
  const s = harness("2027-02-10T15:00:00.000Z");
  const sr = await s.run("evaluateInspectionResult", { result: { indicators: ["utilities_off", "mail_piling"], certification_signed: false, photos: 4 }, inspection_id: "insp-s", type: "exterior", purpose: "delinquency", completed_on: "2027-02-10", occupancy_result: "vacant", report_document_id: "form30-s", cost_cents: 3000n }, VENDOR);
  assert.equal(sr.occupancy, "vacancy_suspected"); assert.equal(sr.vacancy, "suspected_uncertified");
  assert.equal(s.last("property.vacancy_suspected").payload.source, "inspection_result");
  assert.equal(s.timer("FNMA_D2210_VACANCY_INSPECT_ASAP_3BD").dueDate, "2027-02-16");                     // Wed 02-10 + 3 servicer BD (Presidents' Day 02-15 closed)
  assert.equal(addBusinessDays(D("2027-02-10"), 3, servicer), "2027-02-16");
  const uo = await s.run("updateOccupancy", { occupancy: "vacancy_suspected", on: "2027-02-10", source: "returned_mail" });
  assert.equal(uo.confirm_by, "2027-02-16"); assert.equal(s.events.ofType("property.vacancy_suspected").length, 2); assert.equal(s.last("property.occupancy.updated").payload.occupancy, "vacancy_suspected");
  s.at("2027-02-12"); await s.complete("insp-vc", "2027-02-12", { purpose: "vacancy_confirmation", occupancy_result: "vacant", result: { indicators: ["utilities_off", "mail_piling"], certification_signed: true, photos: 5 } });
  assert.ok(s.timers.byCode("FNMA_D2210_VACANCY_INSPECT_ASAP_3BD").every((t) => t.status === "satisfied"));
  assert.throws(() => suspectVacancy(s.ops(), { suspected_on: D("2027-02-10"), source: "rumour" }), RangeError);
});
test("9.8-T4: Given a foreclosure sale on 2027-06-15 Then pre-sale inspection ordered by 2027-05-25 and completed within 2027-05-11 … 2027-06-14.", async () => {
  const p = preSaleInspection(D("2027-06-15"));
  assert.equal(p.order_by, "2027-05-25"); assert.equal(p.complete_by, "2027-06-08"); assert.equal(p.window_from, "2027-05-11"); assert.equal(p.window_to, "2027-06-14");
  // 13.x schedules the sale on the 15.4 rail (`foreclosure.sale.scheduled{sale_at}`) → FNMA_E3303_PRESALE_INSPECT_35 window sale − 35 … sale − 1
  const h = harness("2027-04-20T15:00:00.000Z");
  const sale = saleScheduled({ sale_on: D("2027-06-15"), servicing_option: "special", repurchase_or_reclass_accepted: false, advances: [] });
  h.events.append({ type: sale.event, loanId: "L-1", actor: { kind: "agent", id: "foreclosure" }, payload: sale.payload });
  const t = h.timer("FNMA_E3303_PRESALE_INSPECT_35");
  assert.equal(t.anchorDate, "2027-06-15"); assert.equal(t.note, "window opens 2027-05-11"); assert.equal(t.dueDate, "2027-06-14"); assert.equal(t.status, "armed");
  // a routine delinquency inspection inside the window is not the pre-sale inspection
  h.at("2027-05-20"); await h.complete("insp-r", "2027-05-20", { day: 200 });
  assert.equal(t.status, "armed");
  // ordered by sale − 21 (2027-05-25), completed by sale − 7 (2027-06-08): the pre_sale_35 result closes the window
  h.at("2027-05-25"); assert.deepEqual(h.refusals("orderInspection", { loan_id: "L-1", type: "exterior", purpose: "pre_sale_35", day: 205 }), []);
  const o = await h.run("orderInspection", { type: "exterior", purpose: "pre_sale_35", day: 205 }); assert.equal(o.ordered, true); assert.equal(h.last("property.inspection.ordered").payload.purpose, "pre_sale_35");
  h.at("2027-06-05"); const r = await h.complete("insp-ps", "2027-06-05", { purpose: "pre_sale_35", day: 216 });
  assert.equal(r.recorded, true); assert.equal(t.status, "satisfied"); assert.equal(h.last("property.inspection.completed").payload.purpose, "pre_sale_35");
  const def = h.registry.get("FNMA_E3303_PRESALE_INSPECT_35")!;
  assert.equal(eventMatches(def.satisfiedPattern!, h.last("property.inspection.completed")), true);
  assert.equal(eventMatches(def.satisfiedPattern!, h.events.ofType("property.inspection.completed")[0]!), false);
  // no pre-sale inspection by sale − 1 → sev-1 (bid instructions blocked, 13.x)
  const none = harness("2027-04-20T15:00:00.000Z"); none.events.append({ type: sale.event, loanId: "L-1", actor: { kind: "agent", id: "foreclosure" }, payload: sale.payload });
  assert.equal(none.timers.evaluate("2027-06-15T05:00:00.000Z").find((b) => b.instance.code === "FNMA_E3303_PRESALE_INSPECT_35")!.severity, 1);
});
test("9.8-T5: Given an eligible loan reaching day 90 on a Saturday Then PFPIP submission task due within 2 business days; package contains all mandatory fields.", async () => {
  const pkg = PKG();
  const r = pfpipSubmission({ earliest_unpaid_due: D("2026-11-01"), package: pkg });
  assert.equal(r.day90_on, "2027-01-30"); assert.equal(r.task_due, "2027-02-02"); assert.equal(r.complete, true); assert.deepEqual(r.missing_fields, []);
  const { hoa: _h, ...partial } = pkg; assert.deepEqual(pfpipSubmission({ earliest_unpaid_due: D("2026-11-01"), package: partial }).missing_fields, ["hoa"]);
  assert.equal(dayOfWeek(D("2027-01-30")), 6);                                                          // Saturday
  // the sweep on Saturday 2027-01-30 (eligible: conventional first lien, enrolled, not recourse) → mode pfpip; FNMA_P360_PFPIP_SUBMIT_DAY90 due Tuesday 2027-02-02
  const h = harness("2027-01-30T15:00:00.000Z");
  const s = await h.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-01-30", enrolled: true });
  assert.equal(s.mode, "pfpip"); assert.equal(s.day90_reached, true); assert.equal(h.last("delinquency.day90.reached").payload.pfpip_eligible, true); assert.equal(h.last("delinquency.day90.reached").payload.day90_on, "2027-01-30");
  assert.equal(h.timer("FNMA_P360_PFPIP_SUBMIT_DAY90").dueDate, "2027-02-02"); assert.equal(h.timer("FNMA_P360_PFPIP_SUBMIT_DAY90").status, "armed");
  assert.equal(h.timer("FNMA_D2210_INSPECT_ORDER_DAY90").dueDate, "2027-01-30");                        // the weekend does not move the day-90 order gate
  // an incomplete package is refused (nothing emitted); the complete package submits and closes the clock; reconciliation is then due monthly
  await assert.rejects(h.run("submitPfpip", { earliest_unpaid_due: "2026-11-01", data: partial }), /PFPIP package missing: hoa/);
  assert.equal(h.events.ofType("p360.pfpip.submitted").length, 0);
  h.at("2027-02-01"); const sub = await h.run("submitPfpip", { earliest_unpaid_due: "2026-11-01", data: pkg, method: "human_portal_task" });
  assert.equal(sub.task_due, "2027-02-02"); assert.equal(h.timer("FNMA_P360_PFPIP_SUBMIT_DAY90").status, "satisfied");
  assert.equal(h.timer("FNMA_P360_PFPIP_RECONCILE_MONTHLY").dueDate, "2027-03-01"); assert.equal(h.timer("FNMA_P360_PFPIP_RECONCILE_MONTHLY").status, "armed");
  // missed SLA: sev-2 after Tuesday
  const late = harness("2027-01-30T15:00:00.000Z"); await late.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-01-30", enrolled: true });
  assert.equal(late.timers.evaluate("2027-02-03T05:00:00.000Z").find((b) => b.instance.code === "FNMA_P360_PFPIP_SUBMIT_DAY90")!.severity, 2);
});
test("9.8-T6: Given a Lender-Risk (recourse) loan Then mode `servicer`, inspections ordered and claimed at caps.", async () => {
  assert.equal(inspectionMode({ conventional_first_lien: true, recourse: true, enrolled: true, fnma_rejected: false }), "servicer");
  assert.equal(inspectionMode({ conventional_first_lien: true, recourse: false, enrolled: true, fnma_rejected: false }), "pfpip");
  assert.deepEqual(inspectionClaim("servicer", "exterior", 5500n, D("2027-04-01")), { claim_cents: 3000n, due: D("2027-05-31") });   // F-1-05 exterior $30
  assert.deepEqual(inspectionClaim("servicer", "interior", 5500n, D("2027-04-01")), { claim_cents: 4500n, due: D("2027-05-31") });   // interior $45
  assert.equal(inspectionClaim("pfpip", "exterior", 5500n, D("2027-04-01")), null);                     // program inspections are Fannie Mae's cost
  // recourse + enrolled → still `servicer`: no PFPIP submission clock, the servicer orders from day 90 and completes by day 120
  const h = harness("2027-01-30T15:00:00.000Z");
  const s = await h.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-01-30", enrolled: true, recourse: true });
  assert.equal(s.mode, "servicer"); assert.equal(h.last("delinquency.day90.reached").payload.pfpip_eligible, false);
  assert.equal(h.timers.byCode("FNMA_P360_PFPIP_SUBMIT_DAY90").length, 0);                              // no PFPIP submission clock on a recourse loan
  assert.equal(h.timers.byCode("FNMA_D2210_INSPECT_COMPLETE_DAY120").length, 1);                          // D2-2-10 still applies: the servicer inspects
  assert.equal(h.last("delinquency.day90.reached").payload.mode, "servicer");
  await h.run("orderInspection", { type: "exterior", earliest_unpaid_due: "2026-11-01", today: "2027-01-30" });
  h.at("2027-02-20"); const r1 = await h.complete("insp-1", "2027-02-20", { cost_cents: 5500n });
  assert.equal(r1.reimbursable, true); assert.equal(r1.cap_cents, 3000n);
  h.at("2027-03-20"); const r2 = await h.complete("insp-2", "2027-03-20", { type: "interior", cost_cents: 5500n, occupancy_result: "vacant", result: { indicators: ["utilities_off", "no_furnishings"], certification_signed: true, photos: 3 } });
  assert.equal(r2.cap_cents, 4500n);
  const claim = inspectionClaimLines({ mode: "servicer", milestone_on: D("2027-04-01"), inspections: [{ inspection_id: "insp-1", type: "exterior", cost_cents: 5500n }, { inspection_id: "insp-2", type: "interior", cost_cents: 5500n }] });
  assert.deepEqual(claim.lines.map((l) => [l.inspection_id, l.claim_cents]), [["insp-1", 3000n], ["insp-2", 4500n]]); assert.equal(claim.total_claim_cents, 7500n); assert.equal(claim.file_by, "2027-05-31");
  assert.deepEqual(inspectionClaimLines({ mode: "pfpip", milestone_on: D("2027-04-01"), inspections: [{ inspection_id: "insp-p", type: "exterior", cost_cents: 3000n, ordered_by: "fnma_program" }] }).not_claimed, ["insp-p"]);
  assert.throws(() => inspectionClaimLines({ mode: "servicer", milestone_on: D("2027-04-01"), inspections: [] }), RangeError);
});
test(`9.8-T7: Given active bankruptcy Then curbside inspections with reason recorded; PFPIP permission "Do curbside inspection and no preserv."`, async () => {
  assert.equal(inspectionType({ vacant: false, interior_entry_allowed: false, legal_constraint_reason: "active bankruptcy (11 U.S.C. 362)" }), "curbside");
  assert.equal(pfpipPermission({ bankruptcy_active: true, preserve_allowed: true }), "Do curbside inspection and no preserv.");
  assert.equal(pfpipPermission({ bankruptcy_active: false, preserve_allowed: true }), "Do insp and preserv");
  assert.deepEqual(refusals("orderInspection", { loan_id: "L-1", type: "curbside", day: 95 }), ["CURBSIDE_NEEDS_REASON"]);
  assert.deepEqual(refusals("orderInspection", { loan_id: "L-1", type: "curbside", day: 95, legal_constraint_reason: "active bankruptcy" }), []);
  // the curbside order and its result both carry the recorded reason; a curbside result without one is refused before anything is appended
  const h = harness("2027-02-05T15:00:00.000Z");
  const o = await h.run("orderInspection", { type: "curbside", day: 96, legal_constraint_reason: "active bankruptcy (11 U.S.C. 362 automatic stay)" });
  assert.equal(o.type, "curbside"); assert.equal(o.instruction, "inspectors never discuss the debt");
  assert.throws(() => recordInspectionResult(h.ops(VENDOR), { inspection_id: "insp-c", type: "curbside", purpose: "delinquency", completed_on: "2027-02-05", occupancy_result: "occupied_unknown", certification_signed: false, report_document_id: "form30-c", photos: ["p1"], cost_cents: 3000n }), /legal-constraint\/danger reason/);
  assert.equal(h.events.ofType("property.inspection.completed").length, 0);
  const r = await h.complete("insp-c", "2027-02-05", { type: "curbside", legal_constraint_reason: "active bankruptcy (11 U.S.C. 362 automatic stay)" });
  assert.equal(r.type_next, "curbside"); assert.equal(h.last("property.inspection.completed").payload.legal_constraint_reason, "active bankruptcy (11 U.S.C. 362 automatic stay)");
  assert.equal(h.last("property.inspection.completed").payload.cap_cents, 3000n);                        // a curbside is reimbursed as exterior
  // PFPIP permission set to curbside / no preservation while the stay is in force
  const u = await h.run("updatePfpip", { change: "bankruptcy", changed_on: "2027-02-05", bankruptcy_active: true });
  assert.equal(u.permission, "Do curbside inspection and no preserv."); assert.equal(u.due, "2027-02-09");
  assert.equal((await h.run("updatePfpip", { change: "bankruptcy", changed_on: "2027-02-05", bankruptcy_active: false })).permission, "Do insp and preserv");
});
test("9.8-T8: Given Fannie Mae's Loan Search shows no inspection by day 110 on a PFPIP loan Then a servicer-ordered inspection is placed (9.8-Q2 default).", async () => {
  assert.equal(servicerBackstopOrder("pfpip", false, 110), true);
  assert.equal(servicerBackstopOrder("pfpip", false, 109), false);
  assert.equal(servicerBackstopOrder("pfpip", true, 115), false);
  assert.equal(servicerBackstopOrder("servicer", false, 110), false);                                    // servicer mode orders its own from day 90 anyway
  // sweep on a PFPIP loan: day 109 (2027-02-18) → no backstop; day 110 (2027-02-19) with no Fannie Mae inspection → order placed; Fannie Mae's data showing one → no order
  assert.equal(fnmaDaysDelinquent(D("2026-11-01"), D("2027-02-19")), 110);
  const h = harness("2027-02-18T15:00:00.000Z");
  const s109 = await h.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-02-18", enrolled: true });
  assert.equal(s109.mode, "pfpip"); assert.equal(s109.day, 109); assert.equal(s109.backstop_order, false);
  h.at("2027-02-19");
  const s110 = await h.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-02-19", enrolled: true });
  assert.equal(s110.day, 110); assert.equal(s110.backstop_order, true); assert.equal(s110.state, "initial_due");
  assert.deepEqual(h.refusals("orderInspection", { loan_id: "L-1", type: "exterior", earliest_unpaid_due: "2026-11-01", today: "2027-02-19" }), []);
  const o = await h.run("orderInspection", { type: "exterior", earliest_unpaid_due: "2026-11-01", today: "2027-02-19" });
  assert.equal(o.day, 110); assert.equal(h.timer("FNMA_D2210_INSPECT_ORDER_DAY90").status, "satisfied");
  const seen = await h.run("computeInspectionSchedule", { earliest_unpaid_due: "2026-11-01", today: "2027-02-19", enrolled: true, fnma_inspection_seen: true });
  assert.equal(seen.backstop_order, false); assert.equal(seen.state, "initial_ordered");
  assert.equal(inspectionSweep(h.ops(), { earliest_unpaid_due: D("2026-11-01"), today: D("2027-02-19"), mode: "servicer" }).backstop_order, false);
});
test("9.8-T9: Given inspection costs on a reinstated loan Then a 15.2 claim within 60 days of reinstatement at ≤ caps.", async () => {
  assert.deepEqual(inspectionClaim("servicer", "interior", 5000n, D("2027-04-01")), { claim_cents: 4500n, due: D("2027-05-31") });
  assert.deepEqual(inspectionClaim("servicer", "exterior", 2500n, D("2027-04-01")), { claim_cents: 2500n, due: D("2027-05-31") });   // actual cost below the cap
  assert.deepEqual(inspectionClaim("servicer", "curbside", 4000n, D("2027-04-01")), { claim_cents: 3000n, due: D("2027-05-31") });   // a curbside counts as exterior
  assert.equal(addDays(D("2027-04-01"), 60), "2027-05-31");
  const lines = inspectionClaimLines({ mode: "servicer", milestone_on: D("2027-04-01"), inspections: [{ inspection_id: "i1", type: "interior", cost_cents: 5000n }, { inspection_id: "i2", type: "exterior", cost_cents: 2500n }, { inspection_id: "i3", type: "curbside", cost_cents: 4000n }] });
  assert.deepEqual(lines.lines.map((l) => l.claim_cents), [4500n, 2500n, 3000n]); assert.equal(lines.total_claim_cents, 10_000n); assert.equal(lines.file_by, "2027-05-31");
  assert.ok(lines.lines.every((l) => l.claim_cents <= l.cap_cents));
  // 15.2's milestone fact (reinstatement 2027-04-01) arms FNMA_F105_INSPECTION_CLAIM_60 due 2027-05-31; the 15.2 filing (`expense_claim.status_changed{status=submitted}`) closes it
  const h = harness("2027-04-01T15:00:00.000Z");
  const m = milestoneReached({ event_type: "loan.reinstated", loan_id: "L-1", milestone_date: D("2027-04-01"), mi_insured: false })!;
  assert.equal(m.payload.kind, "reinstatement");
  h.events.append({ type: m.type, loanId: "L-1", actor: { kind: "agent", id: "reo-claims" }, payload: m.payload });
  const t = h.timer("FNMA_F105_INSPECTION_CLAIM_60");
  assert.equal(t.anchorDate, "2027-04-01"); assert.equal(t.dueDate, "2027-05-31"); assert.equal(t.status, "armed");
  h.at("2027-05-20"); h.events.append({ type: "expense_claim.status_changed", loanId: "L-1", aggregate: { kind: "expense_claims", id: "ec-1" }, actor: { kind: "agent", id: "reo-claims" }, payload: { claim_id: "ec-1", status: "package_ready" } });
  assert.equal(t.status, "armed");                                                                       // a package is not a filing
  h.events.append({ type: "expense_claim.status_changed", loanId: "L-1", aggregate: { kind: "expense_claims", id: "ec-1" }, actor: { kind: "agent", id: "reo-claims" }, payload: { claim_id: "ec-1", status: "submitted", submitted_at: "2027-05-20", channel: "api" } });
  assert.equal(t.status, "satisfied");
  // a milestone kind outside {reinstatement, workout, liquidation} arms nothing; past day 60 → sev-2 (cost forfeited)
  const none = harness("2027-04-01T15:00:00.000Z"); const pm = milestoneReached({ event_type: "payoff.funds.cleared", loan_id: "L-1", milestone_date: D("2027-04-01"), mi_insured: false })!;
  none.events.append({ type: pm.type, loanId: "L-1", actor: { kind: "agent", id: "reo-claims" }, payload: pm.payload }); assert.equal(none.timers.byCode("FNMA_F105_INSPECTION_CLAIM_60").length, 0);
  const late = harness("2027-04-01T15:00:00.000Z"); late.events.append({ type: m.type, loanId: "L-1", actor: { kind: "agent", id: "reo-claims" }, payload: m.payload });
  assert.equal(late.timers.evaluate("2027-06-01T05:00:00.000Z").find((b) => b.instance.code === "FNMA_F105_INSPECTION_CLAIM_60")!.severity, 2);
});

test("9.8 rule 7 / F-1-05 caps: interior $45, exterior $30 (curbside counts as exterior), insured-loss repair $60 per inspection", () => {
  assert.deepEqual(INSPECTION_CAPS, { curbside: 3000n, exterior: 3000n, interior: 4500n }); assert.equal(INSURED_LOSS_REPAIR_INSPECTION_CAP, 6000n);
  assert.deepEqual(repairInspectionClaim(7500n, D("2027-01-20"), false), { claim_cents: 6000n, due: D("2028-01-20") });   // current loan: claim within one year
  assert.equal(repairInspectionClaim(5500n, D("2027-01-20"), true).due, null);                            // delinquent: with the E-5-01 / 15.2 milestone claim
});

test("9.8 rule 1 / FNMA_P360_PFPIP_SUBMIT_EXCEPTION_DAY45: the vacancy exception is due at delinquency day 45 from the earliest unpaid due date, or at once when vacancy is confirmed later", async () => {
  assert.equal(pfpipExceptionSubmitOn(D("2026-11-01"), D("2026-12-01")), "2026-12-16");                 // day 45
  assert.equal(pfpipExceptionSubmitOn(D("2026-11-01"), D("2027-01-20")), "2027-01-20");                 // confirmed on day 80: due now, not day 125
  const h = harness("2027-01-20T15:00:00.000Z");
  const v = await h.run("updateOccupancy", { occupancy: "vacant", inspected_on: "2027-01-20", certification_signed: true, pfpip: true, earliest_unpaid_due: "2026-11-01" });
  assert.equal(v.pfpip_exception_submit_on, "2027-01-20");
  const inst = h.timer("FNMA_P360_PFPIP_SUBMIT_EXCEPTION_DAY45");
  assert.equal(inst.dueDate, "2027-01-20"); assert.equal(inst.status, "armed");
  await h.run("submitPfpip", { earliest_unpaid_due: "2026-11-01", exception: "vacancy", data: PKG() });
  assert.equal(h.events.ofType("p360.pfpip.submitted").length, 1); assert.equal(inst.status, "satisfied");   // the same event the day-90 row expects
  assert.equal(dayOfWeek(D("2027-01-30")), 6);                                                          // 9.8-T5: day 90 on a Saturday
});

test("9.8 rule 8 / PFPIP monthly reconciliation: every delta is a change the program record must follow within 2 business days (FNMA_P360_PFPIP_STATUS_SYNC_2BD → updatePfpip)", async () => {
  const h = harness("2027-03-05T15:00:00.000Z");
  const r = await h.run("reconcilePfpip", { platform: [{ loan_id: "L-1", status: "Delinquent" }, { loan_id: "L-2", status: "Current" }], fnma_report: [{ loan_id: "L-1", status: "Delinquent" }, { loan_id: "L-2", status: "Delinquent" }], reconciled_on: "2027-03-05" });
  assert.equal(r.in_sync, false); assert.deepEqual(r.deltas.map((d: Out) => d.loan_id), ["L-2"]); assert.equal(h.events.ofType("p360.pfpip.reconciled").length, 2);
  const changes = h.events.ofType("loan.status.reported_to_fnma"); assert.equal(changes.length, 1); assert.equal(changes[0]!.loanId, "L-2"); assert.equal(changes[0]!.payload.change, "reconciliation_delta");
  const t = h.timer("FNMA_P360_PFPIP_STATUS_SYNC_2BD"); assert.equal(t.loanId, "L-2"); assert.equal(t.dueDate, "2027-03-09"); assert.equal(t.status, "armed");
  await h.run("updatePfpip", { loan_id: "L-2", change: "reconciliation_delta", changed_on: "2027-03-05" });
  assert.equal(t.status, "satisfied");
  // a change on a loan outside the program arms nothing (pfpip_enrolled=false)
  const out = pfpipChangeReported(h.ops(), { change: "foreclosure", changed_on: D("2027-03-05"), pfpip_enrolled: false });
  assert.equal(out.update_by, null); assert.equal(h.timers.byCode("FNMA_P360_PFPIP_STATUS_SYNC_2BD").length, 1);
  assert.throws(() => pfpipChangeReported(h.ops(), { change: "weather", changed_on: D("2027-03-05"), pfpip_enrolled: true }), RangeError);
});
