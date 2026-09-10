// 13.5 Allowable timeframes / compensatory fees
// spec/sections/13-foreclosure/13-5-allowable-timeframes-compensatory-fees.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The T-ids run through the platform path: the pure calculators (./timeframes.ts), the §13.5 tracker
// (./ops-13-5.ts TimeframeTracker — the code path that appends the events the 13.5 timer rows name) and a
// TimerEngine over the overridden registry, so every timer a T-id names is armed by the tracker's trigger event
// and satisfied (or breached, then acted on by `onBreach`) by the event the tracker appends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { exhibitVersionFor, timeframeWarning, rescissionExposure, contestedCredits, billReceived, methodDeviation } from "./ops.ts";
import { exposure, exposureCents, allowable, allowableDays, creditedDays, exhibitFor, EXHIBIT_2025_06_18, RESCISSION_EXPOSURE_CENTS, type ExhibitVersion } from "./timeframes.ts";
import { TimeframeTracker, loadedExhibits, TRACKING, CREDITS, BILLS, EXHIBIT_ID, TRACKER_ACTOR } from "./ops-13-5.ts";
import { cents } from "../../kernel/money/cents.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { TimerEngine, type Breach } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EntityStore } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EVALUATORS } from "../../app/evaluators.ts";

// ---- harness: the tracker over an in-memory store + event store, a TimerEngine over the overridden registry (13.3's referral rows and the 13.5 rows arm)
const OFFICER: Actor = { kind: "human", id: "officer-1", role: "officer" };
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const store = new EntityStore();
  const registry = loadOverriddenRegistry(); const timers = new TimerEngine(registry, events, { processes: ["13.3", "13.5"] });
  const escalations = new EscalationService(events, clock);
  const tracker = new TimeframeTracker({ events, store, escalations, clock });
  const def = (code: string) => { const d = registry.get(code); if (!d) throw new Error(`no timer ${code}`); return d; };
  const inst = (code: string) => { const i = timers.byCode(code); assert.equal(i.length, 1, `${code} armed once`); return i[0]!; };
  return { clock, events, store, timers, escalations, tracker, registry, def, inst };
}
/** The NJ worked example's referral (rule 4): LPI due May 1, 2024; UPB $310,000 at 5.50%; the two delay-credit rows (Ch.13 code 67, contested code 33) already acknowledged as timely. */
function njReferral(h: ReturnType<typeof harness>, opts: { loan?: string; case?: string; credits?: boolean; sentAt?: string } = {}) {
  const loan = opts.loan ?? "L-NJ"; const cid = opts.case ?? "C-NJ";
  if (opts.credits !== false) {
    h.store.put(CREDITS, `${cid}-bk13`, { case_id: cid, loan_id: loan, category: "bk13", status_code_reported: "67", begin_on: "2025-09-03", end_on: "2026-01-21", reported_timely: true }, TRACKER_ACTOR, h.clock.now());
    h.store.put(CREDITS, `${cid}-contested`, { case_id: cid, loan_id: loan, category: "contested", status_code_reported: "33", begin_on: "2026-03-02", end_on: "2026-04-11", reported_timely: true }, TRACKER_ACTOR, h.clock.now());
  }
  return h.tracker.referralSent({ loan_id: loan, case_id: cid, state: "NJ", lpi_due_date: "2024-05-01", sent_at: opts.sentAt ?? "2024-09-16T14:00:00Z", firm_id: "firm-nj", upb_cents: cents("310000"), ptr_pct: "5.50" });
}
const payloadStr = (e: DomainEvent, k: string) => String((e.payload as Record<string, unknown>)[k]);
/** The 13.5 rows among a pass's breaches (13.3's referral rows — referral date recorded, firm ack — arm on the same event and breach on their own clocks). */
const due135 = (breaches: readonly Breach[]) => breaches.filter((b) => b.def.process === "13.5");

test("13.5-T1: Given F-2-03 Example 1 inputs, Then exposure = $3,461.64; Example 2 ⇒ $0 and status `closed_within`.", () => {
  // F-2-03 Example 1 (Florida): UPB $100,000, PTR 4.75%, LPI Feb. 1, 2023, sale Oct. 14, 2025 → 986 days vs 720 allowable, no delays → 266 excess → $3,461.64
  assert.equal(allowableDays("FL"), 720);
  const ex1 = exposure({ lpi_due: D("2023-02-01"), sale_on: D("2025-10-14"), allowable: allowableDays("FL"), delays: [], upb_cents: cents("100000"), ptr_pct: "4.75" });
  assert.equal(ex1.actual_days, 986); assert.equal(ex1.credited_days, 0); assert.equal(ex1.excess_days, 266); assert.equal(ex1.exposure_cents, cents("3461.64")); assert.equal(ex1.status, "closed_over");
  // F-2-03 Example 2 (Colorado): UPB $200,000, PTR 5.25%, LPI Oct. 1, 2024, sale Dec. 2, 2025 → 427 days vs 540 + 30 allowable delay → 143 days ahead → no fee
  assert.equal(allowableDays("CO"), 540);
  const ex2 = exposure({ lpi_due: D("2024-10-01"), sale_on: D("2025-12-02"), allowable: allowableDays("CO"), delays: [{ category: "contested", from: D("2025-03-01"), to: D("2025-03-31"), reported_timely: true }], upb_cents: cents("200000"), ptr_pct: "5.25" });
  assert.equal(ex2.actual_days, 427); assert.equal(ex2.credited_days, 30); assert.equal(ex2.allowable_days + ex2.credited_days - ex2.actual_days, 143); assert.equal(ex2.excess_days, 0); assert.equal(ex2.exposure_cents, 0n); assert.equal(ex2.status, "closed_within");
  // The platform path: both examples through the tracker (referral → sale held under the 06.18.25 exhibit), the sale closing FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE.
  const h = harness("2025-12-03T15:00:00Z");
  h.tracker.referralSent({ loan_id: "L-FL", case_id: "C-FL", state: "FL", lpi_due_date: "2023-02-01", sent_at: "2023-08-01T12:00:00Z", upb_cents: cents("100000"), ptr_pct: "4.75" });
  const fl = h.tracker.saleHeld({ loan_id: "L-FL", sale_on: "2025-10-14", source: "firm", reference: "FL-sale-1" });
  assert.equal(fl.tracking.data.status, "closed_over"); assert.equal(fl.tracking.data.exposure_cents, "346164"); assert.equal(fl.tracking.data.excess_days, 266); assert.equal(fl.tracking.data.actual_days, 986); assert.equal(fl.tracking.data.exhibit_version, "2025-06-18");
  assert.equal(h.events.ofType("fc.timeframe.exceeded").filter((e) => e.loanId === "L-FL").length, 1);
  h.store.put(CREDITS, "C-CO-contested", { case_id: "C-CO", loan_id: "L-CO", category: "contested", status_code_reported: "33", begin_on: "2025-03-01", end_on: "2025-03-31", reported_timely: true }, TRACKER_ACTOR, h.clock.now());
  h.tracker.referralSent({ loan_id: "L-CO", case_id: "C-CO", state: "CO", lpi_due_date: "2024-10-01", sent_at: "2025-02-15T12:00:00Z", upb_cents: cents("200000"), ptr_pct: "5.25" });
  const co = h.tracker.saleHeld({ loan_id: "L-CO", sale_on: "2025-12-02", source: "dra" });
  assert.equal(co.tracking.data.status, "closed_within"); assert.equal(co.tracking.data.exposure_cents, "0"); assert.equal(co.tracking.data.excess_days, 0); assert.equal(co.tracking.data.credited_delay_days, 30);
  assert.equal(h.events.ofType("fc.timeframe.exceeded").filter((e) => e.loanId === "L-CO").length, 0);
  for (const loan of ["L-FL", "L-CO"]) { const t = h.timers.byCode("FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE").find((i) => i.loanId === loan)!; assert.ok(t, `${loan} clock armed on the referral`); assert.equal(t.status, "satisfied", `${loan}: foreclosure.sale.held closes the clock`); }
});
test("13.5-T2: Given the NJ worked example, Then credited = 165, excess = 18, exposure = $840.82; if the Ch.13 code 67 was not accepted for two months, credit at risk flagged and exposure shown both ways.", () => {
  const nj = { lpi_due: D("2024-05-01"), sale_on: D("2027-01-19"), allowable: allowableDays("NJ"), upb_cents: cents("310000"), ptr_pct: "5.50" };
  const bk13 = { category: "bk13" as const, from: D("2025-09-03"), to: D("2026-01-21"), status_code_reported: "67" }; const contested = { category: "contested" as const, from: D("2026-03-02"), to: D("2026-04-11"), reported_timely: true, status_code_reported: "33" };
  const earned = exposure({ ...nj, delays: [{ ...bk13, reported_timely: true }, contested] });
  assert.equal(nj.allowable, 810); assert.deepEqual([earned.actual_days, earned.credited_days, earned.excess_days, earned.exposure_cents, earned.status], [993, 165, 18, cents("840.82"), "closed_over"]);
  assert.deepEqual(earned.credits.map((c) => [c.category, c.actual, c.cap, c.credited, c.at_risk]), [["bk13", 140, 125, 125, false], ["contested", 40, 90, 40, false]]); assert.equal(earned.at_risk_days, 0); assert.equal(earned.exposure_if_at_risk_credited_cents, earned.exposure_cents);
  // code 67 not accepted for two months: the Ch.13 credit is at risk — exposure shown both ways
  const atRisk = exposure({ ...nj, delays: [{ ...bk13, reported_timely: false }, contested] });
  assert.equal(atRisk.credited_days, 40); assert.equal(atRisk.at_risk_days, 125); assert.equal(atRisk.credits[0]!.at_risk, true); assert.match(atRisk.notes[0]!, /credit at risk/);
  assert.equal(atRisk.excess_days, 143); assert.equal(atRisk.exposure_cents, exposureCents(cents("310000"), "5.50", 143)); assert.equal(atRisk.exposure_cents, cents("6679.86"));
  assert.equal(atRisk.excess_days_if_at_risk_credited, 18); assert.equal(atRisk.exposure_if_at_risk_credited_cents, cents("840.82"));
  assert.equal(creditedDays({ ...bk13, reported_timely: false }).at_risk, true);
  // The tracker: the 5.4 rejection of code 67 for two of the Ch.13 months marks the credit `reported_timely=false` (`fc.delay_credit.at_risk`); the sale then shows the exposure both ways on `comp_fee.exposure.updated`.
  const h = harness("2027-01-20T15:00:00Z"); njReferral(h);
  for (const period of ["2025-10", "2025-11"]) { const r = h.tracker.statusCodeAcknowledged({ loan_id: "L-NJ", period, status_code: "67", accepted: false, ack_id: `ack-${period}` }); assert.equal(r.events[0]!.type, "fc.delay_credit.at_risk"); assert.equal(r.credits[0]!.data.reported_timely, false); }
  const sale = h.tracker.saleHeld({ loan_id: "L-NJ", sale_on: "2027-01-19", source: "dra" });
  assert.equal(sale.exposure!.credited_days, 40); assert.equal(sale.exposure!.at_risk_days, 125); assert.equal(sale.exposure!.exposure_cents, cents("6679.86")); assert.equal(sale.exposure!.exposure_if_at_risk_credited_cents, cents("840.82"));
  const upd = h.events.ofType("comp_fee.exposure.updated").at(-1)!; assert.equal(payloadStr(upd, "exposure_cents"), "667986"); assert.equal(payloadStr(upd, "exposure_if_at_risk_credited_cents"), "84082"); assert.equal(payloadStr(upd, "at_risk_days"), "125");
});
test("13.5-T3: Given a NYC property, Then allowable = 2,190; a Westchester property ⇒ 1,740.", () => {
  assert.equal(allowableDays("NY", "Kings"), 2190); assert.equal(allowableDays("NY", "Westchester"), 1740); assert.equal(allowableDays("NY"), 1740);
  const nyc = allowable("NY", "Bronx"); assert.equal(nyc.days, 2190); assert.equal(nyc.nyc, true); assert.equal(nyc.method, "judicial"); assert.equal(nyc.exhibit_version, "2025-06-18");
  assert.throws(() => allowableDays("ZZ"), /not in the loaded allowable-timeframe exhibit/, "unlisted jurisdictions are never defaulted");
  assert.throws(() => allowableDays("NJ", null, D("2025-06-30")), /no allowable-timeframe exhibit is loaded for a sale on 2025-06-30/);
  // The tracker (rule 8: `properties.county` ∈ the five boroughs): the referral event carries the NYC flag and the 2,190-day allowance; Westchester 1,740. The clock ends 2,190 / 1,740 days after the LPI due date.
  const h = harness("2026-09-10T15:00:00Z");
  const q = h.tracker.referralSent({ loan_id: "L-NYC", case_id: "C-NYC", state: "NY", county: "Queens", lpi_due_date: "2025-01-01", sent_at: "2025-06-02T12:00:00Z" });
  assert.equal(q.tracking.data.allowable_days, 2190); assert.equal(q.tracking.data.nyc, true); assert.equal(payloadStr(q.event, "allowable_days"), "2190"); assert.equal(q.tracking.data.allowable_timeframe_ends_on, addDays(D("2025-01-01"), 2190)); assert.equal(q.tracking.data.allowable_timeframe_ends_on, "2030-12-31");   // 2,190 days from Jan. 1, 2025 (2028 is a leap year)
  const w = h.tracker.referralSent({ loan_id: "L-WC", case_id: "C-WC", state: "NY", county: "Westchester", lpi_due_date: "2025-01-01", sent_at: "2025-06-02T12:00:00Z" });
  assert.equal(w.tracking.data.allowable_days, 1740); assert.equal(w.tracking.data.nyc, false); assert.equal(w.tracking.data.allowable_timeframe_ends_on, "2029-10-07");
  assert.equal(h.timers.byCode("FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE").find((i) => i.loanId === "L-NYC")!.dueDate, "2030-12-31"); assert.equal(h.timers.byCode("FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE").find((i) => i.loanId === "L-WC")!.dueDate, "2029-10-07");
});
test("13.5-T4: Given a sale on June 30, 2025 in a state whose days changed on July 1, 2025, Then the prior exhibit version applies; July 1 ⇒ new version.", () => {
  const versions = [{ version: "2024-07", effective_on: D("2024-07-01"), days: 780 }, { version: "2025-07", effective_on: D("2025-07-01"), days: 810 }];
  assert.deepEqual(exhibitVersionFor(versions, D("2025-06-30")), { version: "2024-07", days: 780 }); assert.deepEqual(exhibitVersionFor(versions, D("2025-07-01")), { version: "2025-07", days: 810 });
  // The platform path (`allowable`/`exhibitFor`, used by fc.timeframe.get) selects by `effective_sales_on_or_after` over the loaded exhibit versions: the retained prior version (a fixture — the spec quotes only the 06.18.25 figures) applies to a June 30, 2025 sale, the 06.18.25 exhibit from July 1, 2025.
  const prior: ExhibitVersion = { exhibit_version: "2024-07-01", effective_sales_on_or_after: D("2024-07-01"), allowable_days: { NJ: { days: 780, method: "judicial" } } };
  const loaded = [prior, EXHIBIT_2025_06_18];
  assert.equal(exhibitFor(D("2025-06-30"), loaded).exhibit_version, "2024-07-01"); assert.equal(exhibitFor(D("2025-07-01"), loaded).exhibit_version, "2025-06-18");
  assert.deepEqual(allowable("NJ", null, D("2025-06-30"), loaded), { days: 780, method: "judicial", exhibit_version: "2024-07-01", nyc: false }); assert.deepEqual(allowable("NJ", null, D("2025-07-01"), loaded), { days: 810, method: "judicial", exhibit_version: "2025-06-18", nyc: false });
  assert.throws(() => allowable("NJ", null, D("2025-06-30")), /no allowable-timeframe exhibit is loaded for a sale on 2025-06-30/, "with only the 06.18.25 exhibit loaded a pre-July-2025 sale is refused, never defaulted");
  // Operational prerequisite: the prior version retained in `jurisdiction_rules.foreclosure.allowable_days` is what the tracker (and fc.timeframe.get) loads; two NJ cases, one sold June 30 and one July 1, 2025, close under different versions.
  const h = harness("2025-07-02T15:00:00Z");
  h.store.put("jurisdiction_rules", "fc-allowable-2024-07-01", { rule: "foreclosure.allowable_days", exhibit_version: "2024-07-01", effective_sales_on_or_after: "2024-07-01", allowable_days: { NJ: { days: 780, method: "judicial" } } }, TRACKER_ACTOR, h.clock.now());
  assert.deepEqual(loadedExhibits(h.store).map((e) => [e.exhibit_version, e.effective_sales_on_or_after]), [["2024-07-01", "2024-07-01"], ["2025-06-18", "2025-07-01"]]);
  for (const [loan, saleOn] of [["L-JUN", "2025-06-30"], ["L-JUL", "2025-07-01"]] as const) h.tracker.referralSent({ loan_id: loan, case_id: `C-${loan}`, state: "NJ", lpi_due_date: "2022-11-01", sent_at: "2023-04-03T12:00:00Z", upb_cents: cents("250000"), ptr_pct: "4.00" }), h.tracker.saleHeld({ loan_id: loan, sale_on: saleOn, source: "firm" });
  const jun = h.store.get(TRACKING, "C-L-JUN")!.data, jul = h.store.get(TRACKING, "C-L-JUL")!.data;
  assert.equal(jun.exhibit_version, "2024-07-01"); assert.equal(jun.allowable_days, 780); assert.equal(jul.exhibit_version, "2025-06-18"); assert.equal(jul.allowable_days, 810);
  // Nov 1, 2022 → June 30, 2025 = 972 days: 192 over the prior 780; July 1 = 973 days: 163 over the new 810 (the version in force on the sale date applies).
  assert.equal(jun.actual_days, 972); assert.equal(jun.excess_days, 192); assert.equal(jul.actual_days, 973); assert.equal(jul.excess_days, 163);
  assert.equal(payloadStr(h.events.ofType("foreclosure.sale.held").find((e) => e.loanId === "L-JUN")!, "exhibit_version"), "2024-07-01"); assert.equal(payloadStr(h.events.ofType("foreclosure.sale.held").find((e) => e.loanId === "L-JUL")!, "exhibit_version"), "2025-06-18");
});
test("13.5-T5: Given elapsed days reach 70% of (allowable + credits), Then `at_risk` event and a firm status demand instruction.", () => {
  const r = timeframeWarning({ lpi_due: D("2024-05-01"), today: D("2026-03-17"), allowable: 810, credited: 165 });
  assert.equal(r.threshold, 683); assert.equal(r.elapsed, 685); assert.equal(r.at_risk, true); assert.equal(r.event, "foreclosure.timeframe.at_risk"); assert.equal(r.instruction!.kind, "STATUS_DEMAND"); assert.equal(r.instruction!.to, "firm");
  assert.equal(timeframeWarning({ lpi_due: D("2024-05-01"), today: D("2026-03-10"), allowable: 810, credited: 165 }).at_risk, false);
  // The tracker + TimerEngine: the NJ referral arms FNMA_E3215_TIMEFRAME_WARNING_70 on `allowable_timeframe_warning_on` = LPI + ceil(0.7 × (810 + 165)) = May 1, 2024 + 683 = March 15, 2026 (and the state clock on LPI + 975 = Jan. 1, 2027).
  const h = harness("2026-03-10T15:00:00Z"); const ref = njReferral(h);
  assert.equal(payloadStr(ref.event, "allowable_timeframe_warning_on"), "2026-03-15"); assert.equal(payloadStr(ref.event, "allowable_timeframe_ends_on"), "2027-01-01"); assert.equal(payloadStr(ref.event, "credited_delay_days"), "165");
  const warn = h.inst("FNMA_E3215_TIMEFRAME_WARNING_70"); assert.equal(warn.status, "armed"); assert.equal(warn.dueDate, "2026-03-15"); assert.equal(h.inst("FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE").dueDate, "2027-01-01");
  assert.equal(due135(h.timers.evaluate("2026-03-10T15:00:00Z")).length, 0, "nothing breaches before the 70% mark"); assert.equal(h.tracker.review("L-NJ", D("2026-03-10")).at_risk, false); assert.equal(h.events.ofType("foreclosure.timeframe.at_risk").length, 0);
  // March 17, 2026: 685 days elapsed ≥ 683 — the warning breaches; the breach action appends the at_risk event and sends the firm a STATUS_DEMAND instruction (13.6), due 2 servicer business days later.
  h.clock.set("2026-03-17T15:00:00Z"); const breaches = due135(h.timers.evaluate("2026-03-17T15:00:00Z")); assert.deepEqual(breaches.map((b) => b.instance.code), ["FNMA_E3215_TIMEFRAME_WARNING_70"]);
  const acted = h.tracker.onBreach({ code: "FNMA_E3215_TIMEFRAME_WARNING_70", loanId: "L-NJ", at: "2026-03-17" });
  assert.deepEqual(acted.map((e) => e.type), ["foreclosure.timeframe.at_risk", "attorney.instruction.sent"]);
  assert.equal(payloadStr(acted[0]!, "elapsed_days"), "685"); assert.equal(payloadStr(acted[0]!, "threshold_days"), "683"); assert.equal(payloadStr(acted[0]!, "credited_delay_days"), "165");
  assert.equal(payloadStr(acted[1]!, "kind"), "STATUS_DEMAND"); assert.equal(payloadStr(acted[1]!, "due_on"), "2026-03-19");
  assert.equal(h.store.get(TRACKING, "C-NJ")!.data.status, "at_risk_70pct"); const ai = h.store.list("attorney_instructions")[0]!.data; assert.equal(ai.kind, "STATUS_DEMAND"); assert.equal(ai.firm_id, "firm-nj"); assert.equal(ai.due_on, "2026-03-19");
  assert.equal(h.tracker.onBreach({ code: "FNMA_E3215_TIMEFRAME_WARNING_70", loanId: "L-NJ", at: "2026-03-18" }).length, 0, "idempotent per case");
  // The sale on Jan. 19, 2027 closes both clocks late (993 days; 18 excess → $840.82; `fc.timeframe.exceeded{excess_days=18}`).
  h.clock.set("2027-01-20T15:00:00Z"); const sale = h.tracker.saleHeld({ loan_id: "L-NJ", sale_on: "2027-01-19", source: "dra" });
  assert.equal(sale.exposure!.exposure_cents, cents("840.82")); assert.equal(payloadStr(h.events.ofType("fc.timeframe.exceeded").at(-1)!, "excess_days"), "18");
  assert.equal(warn.status, "satisfied_late"); assert.equal(h.inst("FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE").status, "satisfied");
  assert.ok(eventMatches(h.def("FNMA_E3215_TIMEFRAME_WARNING_70").satisfiedPattern!, sale.events[0]!));
});
test("13.5-T6: Given a rescinded sale due to a missed DMDC check, Then $1,000 + costs exposure and root cause `servicer:scra`.", () => {
  const r = rescissionExposure({ cause: "missed_dmdc_check", third_party_costs_cents: 62_500n });
  assert.equal(r.exposure_cents, 162_500n); assert.equal(r.root_cause, "servicer:scra"); assert.equal(r.servicer_error, true);
  assert.equal(rescissionExposure({ cause: "firm_error", third_party_costs_cents: 62_500n }).exposure_cents, 0n);
  // The tracker + TimerEngine: `foreclosure.sale.rescinded{cause=servicer_error}` arms FNMA_A14202_RESCISSION_FEE_EXPOSURE, which the booking `comp_fee_exposure.booked{kind=rescission}` ($1,000 + $625.00 third-party costs) satisfies the same day; the clock reopens to `tracking` and continues to the new sale.
  const h = harness("2027-01-20T15:00:00Z"); njReferral(h); h.tracker.saleHeld({ loan_id: "L-NJ", sale_on: "2027-01-19", source: "dra" });
  h.clock.set("2027-02-10T15:00:00Z");
  const res = h.tracker.saleRescinded({ loan_id: "L-NJ", rescinded_on: "2027-02-10", reason: "missed_dmdc_check", third_party_costs_cents: 62_500n, source: "attorney_network" });
  assert.equal(res.exposure_cents, RESCISSION_EXPOSURE_CENTS + 62_500n); assert.equal(res.exposure_cents, 162_500n); assert.equal(res.root_cause, "servicer:scra");
  assert.deepEqual(res.events.map((e) => e.type), ["foreclosure.sale.rescinded", "comp_fee_exposure.booked", "comp_fee.exposure.updated"]);
  assert.equal(payloadStr(res.events[0]!, "cause"), "servicer_error"); assert.equal(payloadStr(res.events[1]!, "kind"), "rescission"); assert.equal(payloadStr(res.events[1]!, "exposure_cents"), "162500"); assert.equal(payloadStr(res.events[1]!, "admin_fee_cents"), "100000"); assert.equal(payloadStr(res.events[1]!, "root_cause"), "servicer:scra");
  assert.ok(eventMatches(h.def("FNMA_A14202_RESCISSION_FEE_EXPOSURE").triggerPattern!, res.events[0]!)); assert.ok(eventMatches(h.def("FNMA_A14202_RESCISSION_FEE_EXPOSURE").satisfiedPattern!, res.events[1]!));
  const fee = h.inst("FNMA_A14202_RESCISSION_FEE_EXPOSURE"); assert.equal(fee.status, "satisfied"); assert.equal(fee.satisfiedByEventId, res.events[1]!.id);
  assert.equal(res.tracking.data.status, "tracking"); assert.equal(res.tracking.data.sale_held_at, null); assert.equal(res.tracking.data.rescission_exposure_cents, "162500"); assert.equal(res.tracking.data.rescission_root_cause, "servicer:scra");
  assert.ok(h.escalations.opened.some((e) => e.kind === "sev2" && e.payload.root_cause === "servicer:scra"), "sev 2 → foreclosure-ops root cause");
  // A firm-caused rescission books nothing (allocation: firm) and does not arm the fee row.
  const h2 = harness("2027-01-20T15:00:00Z"); njReferral(h2); h2.tracker.saleHeld({ loan_id: "L-NJ", sale_on: "2027-01-19", source: "dra" }); h2.clock.set("2027-02-10T15:00:00Z");
  const firm = h2.tracker.saleRescinded({ loan_id: "L-NJ", rescinded_on: "2027-02-10", reason: "firm_error", third_party_costs_cents: 62_500n, source: "firm" });
  assert.equal(firm.exposure_cents, 0n); assert.equal(payloadStr(firm.events[0]!, "cause"), "firm_error"); assert.equal(h2.timers.byCode("FNMA_A14202_RESCISSION_FEE_EXPOSURE").length, 0);
  assert.throws(() => h2.tracker.saleRescinded({ loan_id: "L-NJ", rescinded_on: "2027-02-11", reason: "missed_dmdc_check", third_party_costs_cents: -1n, source: "firm" }), RangeError);
});
test(`13.5-T7: Given a second contested period, Then no additional credit and a note for "reasonable explanation."`, () => {
  const r = contestedCredits([{ category: "contested", from: D("2026-03-02"), to: D("2026-04-11"), reported_timely: true }, { category: "contested", from: D("2026-06-01"), to: D("2026-07-01"), reported_timely: true }]);
  assert.equal(r.credited, 40); assert.equal(r.notes.length, 1); assert.match(r.notes[0]!, /reasonable explanation/);
  // The tracker: a second contested row (code 33, acknowledged) on the NJ case earns nothing — credited stays 165, the sale's exposure stays $840.82, and the note goes into the rebuttal file (`exposure.notes`).
  const h = harness("2027-01-20T15:00:00Z"); njReferral(h);
  h.store.put(CREDITS, "C-NJ-contested-2", { case_id: "C-NJ", loan_id: "L-NJ", category: "contested", status_code_reported: "33", begin_on: "2026-06-01", end_on: "2026-07-01", reported_timely: true }, TRACKER_ACTOR, h.clock.now());
  const p = h.tracker.project("L-NJ", D("2026-08-01")); assert.equal(p.exposure!.credited_days, 165); assert.deepEqual(p.exposure!.credits.map((c) => [c.category, c.actual, c.credited]), [["bk13", 140, 125], ["contested", 40, 40], ["contested", 30, 0]]);
  assert.equal(p.exposure!.notes.filter((n) => /reasonable explanation/.test(n)).length, 1); assert.match(p.exposure!.notes.find((n) => /second contested/.test(n))!, /no additional credit/);
  const sale = h.tracker.saleHeld({ loan_id: "L-NJ", sale_on: "2027-01-19", source: "dra" }); assert.equal(sale.exposure!.credited_days, 165); assert.equal(sale.exposure!.excess_days, 18); assert.equal(sale.exposure!.exposure_cents, cents("840.82"));
});
test("13.5-T8: Given a bill received, Then `SM_COMP_FEE_BILL_REBUTTAL_30` starts, package drafted, `officer` escalation.", () => {
  const r = billReceived({ received_on: D("2027-03-01"), bill_cents: 84_082n, exposure_cents: 84_082n });
  assert.equal(r.timer, "SM_COMP_FEE_BILL_REBUTTAL_30"); assert.equal(r.due, "2027-03-31"); assert.equal(r.package.drafted, true); assert.equal(r.package.variance_cents, 0n); assert.equal(r.escalation.kind, "officer");
  // The tracker + TimerEngine: the Connect bill (18 days on $310,000 at 5.50% = $840.82, received March 1, 2027) is validated, appended as `comp_fee_bill.received{received_on}`, which arms SM_COMP_FEE_BILL_REBUTTAL_30 on the receipt date: +30 calendar days = March 31, 2027.
  const h = harness("2027-01-20T15:00:00Z"); njReferral(h); h.tracker.saleHeld({ loan_id: "L-NJ", sale_on: "2027-01-19", source: "dra" }); h.clock.set("2027-03-02T15:00:00Z");
  const bill = h.tracker.ingestCompFeeBill({ bill_id: "bill-1", period: "2027-02", fnma_reference: "CF-2027-02-0001", loan_id: "L-NJ", days_billed: 18, upb_cents: cents("310000"), ptr: "5.50", amount_cents: cents("840.82"), received_at: "2027-03-01" });
  assert.equal(bill.rebuttal_due_on, "2027-03-31"); assert.equal(bill.variance_cents, 0n); assert.equal(bill.exposure_variance_cents, 0n);
  assert.equal(bill.event.type, "comp_fee_bill.received"); assert.equal(payloadStr(bill.event, "received_on"), "2027-03-01"); assert.ok(eventMatches(h.def("SM_COMP_FEE_BILL_REBUTTAL_30").triggerPattern!, bill.event));
  const clock = h.inst("SM_COMP_FEE_BILL_REBUTTAL_30"); assert.equal(clock.status, "armed"); assert.equal(clock.anchorDate, "2027-03-01"); assert.equal(clock.dueDate, "2027-03-31");
  assert.equal(bill.package.data.status, "drafted"); assert.equal(bill.package.data.purpose, "comp_fee_rebuttal"); assert.deepEqual(bill.package.data.document_ids, ["timeline", "status_code_history_with_acknowledgments", "delay_credit_evidence", "fc_timeframe_tracking:C-NJ"]);
  const esc = h.escalations.opened.find((e) => e.kind === "officer")!; assert.ok(esc, "officer escalation"); assert.equal(esc.payload.bill_id, "bill-1"); assert.equal(esc.payload.rebuttal_due_on, "2027-03-31");
  assert.equal(h.store.get(BILLS, "bill-1")!.data.rebuttal_status, "pending");
  assert.throws(() => h.tracker.ingestCompFeeBill({ bill_id: "bill-1", period: "2027-02", loan_id: "L-NJ", days_billed: 18, upb_cents: cents("310000"), ptr: "5.50", amount_cents: cents("840.82"), received_at: "2027-03-01" }), /already received/);
  assert.throws(() => h.tracker.ingestCompFeeBills([]), RangeError);
  // Only the officer resolves the bill: acceptance appends `comp_fee_bill.resolved{result=accepted}`, which satisfies the clock; an agent's acceptance is refused.
  assert.throws(() => h.tracker.acceptBill({ bill_id: "bill-1", by: TRACKER_ACTOR }), /officer decision/); assert.equal(clock.status, "armed");
  h.clock.set("2027-03-20T15:00:00Z"); const acc = h.tracker.acceptBill({ bill_id: "bill-1", by: OFFICER, allocation: "supermortgage" });
  assert.equal(acc.event.type, "comp_fee_bill.resolved"); assert.equal(payloadStr(acc.event, "result"), "accepted"); assert.ok(eventMatches(h.def("SM_COMP_FEE_BILL_REBUTTAL_30").satisfiedPattern!, acc.event));
  assert.equal(clock.status, "satisfied"); assert.equal(clock.satisfiedByEventId, acc.event.id); assert.equal(acc.bill.data.rebuttal_status, "accepted"); assert.equal(acc.bill.data.accepted_by, "human:officer-1");
  // Unanswered by March 31 the clock breaches to the officer.
  const h2 = harness("2027-03-02T15:00:00Z"); njReferral(h2); h2.tracker.ingestCompFeeBill({ bill_id: "bill-2", period: "2027-02", loan_id: "L-NJ", days_billed: 18, upb_cents: cents("310000"), ptr: "5.50", amount_cents: cents("840.82"), received_at: "2027-03-01" });
  const rebuttal = (bs: readonly Breach[]) => bs.filter((x) => x.instance.code === "SM_COMP_FEE_BILL_REBUTTAL_30");   // the E-3.2-15 clocks of this late-referral fixture are already past due
  assert.equal(rebuttal(h2.timers.evaluate("2027-03-31T12:00:00Z")).length, 0, "March 31 is the last day"); const late = rebuttal(h2.timers.evaluate("2027-04-01T12:00:00Z")); assert.equal(late.length, 1); assert.ok(late[0]!.escalateTo.includes("officer"));
});
test("13.5-T9: Given a non-preferred method proposed without Form 20 approval, Then `FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE` refuses first-notice authorization.", () => {
  const r = methodDeviation({ preferred_method: false }); assert.equal(r.allowed, false); assert.equal(r.gate, "FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE"); assert.match(r.refusal!, /Form 20/);
  assert.equal(methodDeviation({ preferred_method: false, form20_approval_id: "F20-1" }).allowed, true); assert.equal(methodDeviation({ preferred_method: true }).allowed, true);
  // The tracker + TimerEngine: the firm proposes non-judicial in NJ (exhibit: judicial, 810) — `firm.method_deviation.proposed` arms the gate, whose evaluator `13.5.methodDeviationApproved` keeps first-notice authorization closed until a Form 20 approval; exposure stays on the preferred method's days.
  const h = harness("2026-09-10T15:00:00Z"); njReferral(h);
  const p = h.tracker.firmMethodProposal({ loan_id: "L-NJ", case_id: "C-NJ", proposed_method: "non_judicial", firm_id: "firm-nj" });
  assert.equal(p.deviation, true); assert.equal(p.preferred_method, "judicial"); assert.equal(p.allowed, false); assert.match(p.refusal!, /first_notice\.authorize refused.*Form 20.*FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE/);
  assert.equal(p.event!.type, "firm.method_deviation.proposed"); assert.equal(payloadStr(p.event!, "form20_approval_id"), "null"); assert.equal(payloadStr(p.event!, "exposure_basis"), "preferred method (judicial, 810 days)");
  const gate = h.inst("FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE"); assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:13.5.methodDeviationApproved"); assert.equal(gate.dueDate, undefined, "a not_before gate has no due date — it opens on the approval");
  const fc = h.store.get("foreclosure_cases", "C-NJ")!.data; assert.equal(fc.method_deviation, true); assert.equal(fc.form20_approval_id, null);
  const closed = EVALUATORS["13.5.methodDeviationApproved"]!({ preferred_method: fc.method_deviation !== true, form20_approval_id: String(fc.form20_approval_id ?? "") }); assert.equal(closed.open, false); assert.match(closed.reason!, /Form 20/);
  assert.ok(h.escalations.opened.some((e) => e.kind === "attorney" && e.payload.gate === "FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE"), "attorney escalation: Form 20 to Regional Counsel before initiation");
  assert.equal(h.store.get(TRACKING, "C-NJ")!.data.allowable_days, 810, "exposure computed on the preferred figure (rule 6)");
  // With Regional Counsel's Form 20 approval (13.7) the gate opens; the preferred method never arms it.
  const ok = h.tracker.firmMethodProposal({ loan_id: "L-NJ", case_id: "C-NJ", proposed_method: "non_judicial", form20_approval_id: "F20-1" }); assert.equal(ok.allowed, true); assert.equal(ok.refusal, null);
  assert.equal(EVALUATORS["13.5.methodDeviationApproved"]!({ preferred_method: false, form20_approval_id: "F20-1" }).open, true);
  const h2 = harness("2026-09-10T15:00:00Z"); njReferral(h2); const pref = h2.tracker.firmMethodProposal({ loan_id: "L-NJ", case_id: "C-NJ", proposed_method: "judicial" }); assert.equal(pref.deviation, false); assert.equal(pref.event, null); assert.equal(h2.timers.byCode("FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE").length, 0);
  assert.throws(() => h2.tracker.firmMethodProposal({ loan_id: "L-NJ", proposed_method: "strict_foreclosure" }), RangeError);
});

test("13.5 worked figures: NJ 810 allowable, LPI 2024-05-01 → sale 2027-01-19 = 993 days; credits 125 + 40 = 165; excess 18; UPB $310,000 at 5.50% → per-diem $46.71 → exposure $840.82", () => {
  const r = exposure({ lpi_due: D("2024-05-01"), sale_on: D("2027-01-19"), allowable: 810, delays: [{ category: "bk13", from: D("2025-09-03"), to: D("2026-01-21"), reported_timely: true }, { category: "contested", from: D("2026-03-02"), to: D("2026-04-11"), reported_timely: true }], upb_cents: 31000000n, ptr_pct: "5.50" });
  assert.equal(r.actual_days, 993); assert.equal(r.credited_days, 165); assert.equal(r.excess_days, 18); assert.equal(r.exposure_cents, 84082n);
  assert.equal((31000000n * 550n + 365n * 5000n) / (365n * 10000n), 4671n);   // per-diem $46.71 (half-up)
});

test("13.5 timers: FNMA_F121_STATUS_CODE_TIMELY_BD2 arms on the month-end status change (BD2) and its breach marks the credit reported_timely=false; SM_EXHIBIT_WATCH_MONTHLY arms on the monthly tick and the sentinel's exhibit.checked satisfies and re-arms it", () => {
  // Month-end review: code 67 first reported for 2025-09 (prior period none) → `period.month_end{foreclosure_status_changed=true, period_end=2025-09-30}` → due BD2 = Thursday Oct. 2, 2025 17:00 ET.
  const h = harness("2025-09-30T23:00:00Z"); njReferral(h);
  h.store.put(CREDITS, "C-NJ-bk13", { case_id: "C-NJ", loan_id: "L-NJ", category: "bk13", status_code_reported: "67", begin_on: "2025-09-03", end_on: null, reported_timely: false }, TRACKER_ACTOR, h.clock.now());
  h.store.put("delinquency_status_history", "L-NJ-2025-09", { loan_id: "L-NJ", period: "2025-09", status_code: "67" }, TRACKER_ACTOR, h.clock.now());
  const me = h.tracker.monthEndStatusReview({ period_end: "2025-09-30" }); assert.equal(me.changed.length, 1); assert.equal(payloadStr(me.changed[0]!, "foreclosure_status_changed"), "true"); assert.equal(payloadStr(me.changed[0]!, "status_code"), "67");
  assert.ok(eventMatches(h.def("FNMA_F121_STATUS_CODE_TIMELY_BD2").triggerPattern!, me.changed[0]!));
  const bd2 = h.inst("FNMA_F121_STATUS_CODE_TIMELY_BD2"); assert.equal(bd2.anchorDate, "2025-09-30"); assert.equal(bd2.dueDate, "2025-10-02");
  assert.equal(due135(h.timers.evaluate("2025-10-02T20:00:00Z")).length, 0, "17:00 ET on BD2 has not passed"); assert.deepEqual(due135(h.timers.evaluate("2025-10-02T21:01:00Z")).map((b) => b.instance.code), ["FNMA_F121_STATUS_CODE_TIMELY_BD2"]);
  const marked = h.tracker.onBreach({ code: "FNMA_F121_STATUS_CODE_TIMELY_BD2", loanId: "L-NJ", at: "2025-10-02", payload: { period: "2025-09" } });
  assert.deepEqual(marked.map((e) => e.type), ["fc.delay_credit.at_risk"]); assert.equal(h.store.get(CREDITS, "C-NJ-bk13")!.data.reported_timely, false);
  assert.throws(() => h.tracker.monthEndStatusReview({ period_end: "2025-09-29" }), /not a month end/);
  // The accepted 5.4 status event (ops-5-1 acceptEvent spells it `investor_events.accepted{family=delinquency}`) is what satisfies the BD2 row; the tracker's acknowledgment path marks the credit timely.
  assert.deepEqual(h.def("FNMA_F121_STATUS_CODE_TIMELY_BD2").satisfiedPattern, { type: "investor_events.accepted", conditions: [{ field: "family", op: "=", value: "delinquency" }], raw: "investor_events.accepted{family=delinquency}" });
  const ack = h.tracker.statusCodeAcknowledged({ loan_id: "L-NJ", period: "2025-09", status_code: "67", accepted: true, ack_id: "ack-1" }); assert.equal(ack.events[0]!.type, "fc.delay_credit.closed"); assert.equal(h.store.get(CREDITS, "C-NJ-bk13")!.data.reported_timely, true);
  // Exhibit watch: the monthly tick arms the recurring row; the sentinel's fetch appends `exhibit.checked{exhibit=allowable_timeframes}` (hash unchanged → nothing to load; changed → rules re-versioning task).
  h.events.append({ type: "schedule.tick", actor: TRACKER_ACTOR, payload: { cadence: "monthly", weekday: "wednesday", ordinal: 2, on: "2025-10-08" } });
  const watch = h.inst("SM_EXHIBIT_WATCH_MONTHLY"); assert.equal(watch.status, "armed");
  const c1 = h.tracker.checkExhibit({ hash: "a".repeat(64), fetched_at: "2025-10-08" }); assert.equal(c1.changed, false); assert.equal(payloadStr(c1.event, "exhibit"), EXHIBIT_ID); assert.equal(payloadStr(c1.event, "current_version"), "2025-06-18");
  assert.ok(eventMatches(h.def("SM_EXHIBIT_WATCH_MONTHLY").satisfiedPattern!, c1.event)); assert.equal(watch.status, "satisfied"); assert.equal(h.timers.byCode("SM_EXHIBIT_WATCH_MONTHLY").length, 2, "recurring: re-armed by the satisfying check");
  const c2 = h.tracker.checkExhibit({ hash: "b".repeat(64), fetched_at: "2025-11-12", exhibit_version_seen: "2025-11-01" }); assert.equal(c2.changed, true); assert.equal(h.events.ofType("exhibit.changed").length, 1); assert.equal(h.store.get("exhibit_watch", EXHIBIT_ID)!.data.pending_version, "2025-11-01");
  assert.equal(h.tracker.checkExhibit({ failed: true, error: "HTTP 503", fetched_at: "2025-12-10" }).changed, null); assert.equal(h.store.get("exhibit_watch", EXHIBIT_ID)!.data.hash, "b".repeat(64), "a fetch failure keeps the current version");
  assert.throws(() => h.tracker.checkExhibit({ hash: "not-hex", fetched_at: "2025-12-10" }), RangeError);
});
