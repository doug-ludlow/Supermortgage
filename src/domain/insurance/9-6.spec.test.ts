// 9.6 Flood insurance / mandatory purchase
// spec/sections/09-insurance-property-protection/9-6-flood-insurance-mandatory-purchase.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, dayOfWeek, addDays, addMonths } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { floodNoticeClocks, placementAllowed, bindFloodLpi, floodRequiredAmount, floodAdequate, privatePolicyAcceptable, rcbap, nfipEffectiveDate, fnmaEvidenceDue, fnmaEvidencePackage } from "./flood.ts";
import { cancellation, dailyRate, overlapPremium, type LpiTerm } from "./refund.ts";
import { lomaLetter, sameDayLapses, vendorHeartbeatCheck } from "./ops.ts";
import { receiveVendorMessage, recordDeterminationResult, evaluateFloodCoverage, sendFloodNotice45, recordFloodNoticeMailed, bindFloodLpiPlacement, requestFloodLpi, receiveFloodEvidence, evaluateFloodEvidence, terminateFloodLpi, payFloodRefund, applyLomaLetter, vendorHeartbeat, receiveFnmaEvidenceRequest, respondFnmaEvidenceRequest, activeFloodLpi, structuresToRequirement, type FloodDeps, type FloodEvidencePolicy } from "./ops-9-6.ts";
import { MemoryEventStore, FixedClock, eventMatches, parseEventPattern, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { FakeLpiTracking, FakeFlood } from "../../infra/integrations/property.ts";
import { SECTION_09_TOOLS } from "../../app/tools/section09.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { CommandContext } from "../../app/commands.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";

const AGENT: Actor = { kind: "agent", id: "insurance-property" };
const OPERATOR: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };
const SFHA = { principal_structure_in_sfha: true, detached_security_structure_in_sfha: false, cbrs_opa: false, participating_community: true };
const REMAP = { effective_date: D("2027-02-03"), old_zone: "X", new_zone: "AE", sfha_before: false, sfha_after: true };
const TERM: LpiTerm = { effective: D("2027-02-03"), expiration: D("2028-02-03"), premium_cents: 115000n };
const NFIP_DEC: FloodEvidencePolicy = { policy_number: "NFIP-77", nfip: true, insurer: "NFIP Direct", insurer_contact: "800-427-4661", building_coverage_cents: 24000000n, deductible_cents: 500000n, effective: D("2027-04-11"), expiration: D("2028-04-11") };
/** A live engine over the registry with every §9 override, arming the 9.6 rows and the 9.1/9.5-owned codes 9.6 shares. */
function live(startIso: string) {
  const clock = new FixedClock(startIso); const events = new MemoryEventStore(clock);
  const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["9.1", "9.5", "9.6"] });
  const deps: FloodDeps = { events, actor: AGENT };
  const timer = (code: string, n = 0) => engine.byCode(code)[n];
  return { clock, events, engine, deps, timer };
}
/** The worked-timeline remap (received 2027-02-04) and the deficiency (no policy on file) that opens the flood track. */
function remapIntoAe(l: ReturnType<typeof live>, loanId = "L-1") {
  const mc = receiveVendorMessage(l.deps, { kind: "map_change_notification", vendor_id: "cotality", certificate_id: "C-1", received_at: "2027-02-04T15:00:00.000Z", loan_id: loanId, map_change: REMAP });
  const cov = evaluateFloodCoverage(l.deps, { loan_id: loanId, as_of: D("2027-02-04"), structures: SFHA, rcv_cents: 31000000n, upb_cents: 24000000n, policy: null, remap_effective: D("2027-02-03") });
  return { mc, cov };
}
const mailedNotice = (l: ReturnType<typeof live>, loanId = "L-1", noticeId = "N-45") => { l.clock.set("2027-02-05T15:00:00.000Z"); return recordFloodNoticeMailed(l.deps, { loan_id: loanId, notice_id: noticeId, template: "INS_FLOOD_FPI_NOTICE_45", mailed_at: "2027-02-05T15:00:00.000Z", proof_of_mailing_id: "POM-45" }); };
const placeOn = (l: ReturnType<typeof live>, on: string, loanId = "L-1") => bindFloodLpiPlacement(l.deps, { loan_id: loanId, on: D(on), required_cents: 24000000n, premium_cents: 115000n, binding_id: "LPI-F1", lapse_date: null, remap_effective: D("2027-02-03"), escrowed: true });

test("9.6-T1: Given remap into AE effective 2027-02-03 and notice mailed 2027-02-05 When 2027-03-21 Then placement refused; 2027-03-22 allowed; Fannie 120-day timer satisfied on binding.", async () => {
  const c = floodNoticeClocks(D("2027-02-05"), D("2027-02-03"));
  assert.equal(c.borrower_deadline, "2027-03-22"); assert.equal(c.fannie_120, "2027-06-03");
  assert.equal(placementAllowed(c, D("2027-03-21"), false), false); assert.equal(placementAllowed(c, D("2027-03-22"), false), true);
  assert.equal(bindFloodLpi(c, D("2027-03-21"), false, D("2027-02-03")).bound, false);
  const b = bindFloodLpi(c, D("2027-03-22"), false, D("2027-02-03"));
  assert.equal(b.bound, true); assert.equal(b.effective, "2027-02-03"); assert.equal(b.fannie_120_satisfied, true);
  assert.equal(bindFloodLpi(c, D("2027-03-22"), true, D("2027-02-03")).bound, false);                   // sufficient evidence: no placement
  // Engine: the vendor's map-change notification (received 2027-02-04) arms the Fannie Mae 120-day row on the remap effective date and the NFIP 13-month window.
  const l = live("2027-02-04T15:00:00.000Z");
  const { mc, cov } = remapIntoAe(l);
  assert.equal(mc.direction, "into_sfha"); assert.equal(mc.fnma_deadline, "2027-06-03"); assert.equal(mc.nfip_one_day_until, "2028-03-03");
  const fnma = l.timer("FNMA_B301_FLOOD_REMAP_COVERAGE_120")!; assert.equal(fnma.status, "armed"); assert.equal(fnma.dueDate, "2027-06-03"); assert.equal(fnma.anchorDate, "2027-02-03");
  const nfip = l.timer("NFIP_44CFR6111_MAP_REVISION_1DAY_13M")!; assert.equal(nfip.status, "armed"); assert.equal(nfip.dueDate, "2028-03-03");
  assert.equal(cov.deficiency, "flood_none"); assert.equal(cov.required_cents, 24000000n);
  // 45-day notice mailed Fri 2027-02-05 (proof of mailing) → `flood.fpi.notice.sent` opens the not-before gate and the place-after-45 deadline on the 45th day.
  const sent = mailedNotice(l); assert.equal(sent.borrower_deadline, "2027-03-22"); assert.equal(sent.mailed_on, "2027-02-05");
  const gate = l.timer("FDPA_4012A_E_FLOOD_FPI_NOTICE_45")!, place = l.timer("FDPA_4012A_E2_FLOOD_PLACE_AFTER_45")!;
  assert.equal(gate.status, "armed"); assert.equal(gate.dueDate, "2027-03-22"); assert.equal(gate.anchorDate, "2027-02-05");
  assert.equal(place.status, "armed"); assert.equal(place.dueDate, "2027-03-22");
  // 2027-03-21: refused (no `flood.lpi.bound`); no placement before t0 + 45.
  l.clock.set("2027-03-21T15:00:00.000Z");
  const refused = placeOn(l, "2027-03-21"); assert.equal(refused.bound, false); assert.equal(refused.timer, "FDPA_4012A_E_FLOOD_FPI_NOTICE_45"); assert.match(refused.reason, /FDPA_4012A_E_FLOOD_FPI_NOTICE_45 open until 2027-03-22/);
  assert.equal(l.events.ofType("flood.lpi.bound").length, 0); assert.equal(l.events.ofType("flood.lpi.placement.refused").length, 1); assert.equal(fnma.status, "armed");
  // 2027-03-22: bound effective the remap date for the rule-2 amount; `flood.lpi.bound` + `flood.coverage.verified` satisfy the 120-day row, the deadline and the gate (on time — no breach on the 45th day).
  l.clock.set("2027-03-22T15:00:00.000Z"); assert.deepEqual(l.engine.evaluate("2027-03-22T15:00:00.000Z").map((b) => b.instance.code).filter((c) => c.startsWith("FDPA") || c.startsWith("FNMA")), [], "nothing on the flood chain breaches on the 45th day");
  const bound = placeOn(l, "2027-03-22"); assert.equal(bound.bound, true); if (!bound.bound) return;
  assert.equal(bound.effective, "2027-02-03"); assert.equal(bound.amount_cents, 24000000n); assert.equal(bound.fannie_120_satisfied, true); assert.equal(bound.fannie_deadline, "2027-06-03"); assert.deepEqual(bound.charge, { method: "escrow_disbursement", disbursement_kind: "flood", from: "2027-02-03" });
  assert.deepEqual(l.events.all().filter((e) => e.type.startsWith("flood.lpi.") || e.type === "flood.coverage.verified").map((e) => e.type), ["flood.lpi.placement.refused", "flood.lpi.bound", "flood.lpi.charged", "flood.coverage.verified"]);
  assert.equal(fnma.status, "satisfied"); assert.equal(place.status, "satisfied"); assert.equal(gate.status, "satisfied"); assert.equal(nfip.status, "satisfied");
  assert.equal(activeFloodLpi(l.deps, "L-1")!.binding_id, "LPI-F1");
  // Sufficient evidence confirmed after the notice → no placement even on day 45; the amount never exceeds the rule-2 minimum unless the borrower elects.
  const l2 = live("2027-02-04T15:00:00.000Z"); remapIntoAe(l2); mailedNotice(l2); l2.clock.set("2027-03-22T15:00:00.000Z");
  receiveFloodEvidence(l2.deps, { loan_id: "L-1", evidence_id: "ev-1", received_on: D("2027-03-10"), document: "declarations_page", policy: { ...NFIP_DEC, effective: D("2027-03-05"), expiration: D("2028-03-05") } });
  assert.equal(evaluateFloodEvidence(l2.deps, { loan_id: "L-1", evidence_id: "ev-1", evaluated_on: D("2027-03-11"), document: "declarations_page", policy: { ...NFIP_DEC, effective: D("2027-03-05"), expiration: D("2028-03-05") }, rcv_cents: 31000000n, upb_cents: 24000000n }).outcome, "confirmed");
  const r2 = placeOn(l2, "2027-03-22"); assert.equal(r2.bound, false); assert.equal(r2.timer, null); assert.match(r2.reason, /sufficient evidence/);
  assert.equal(l2.timer("FNMA_B301_FLOOD_REMAP_COVERAGE_120")!.status, "satisfied", "the borrower's confirmed coverage verifies the 120-day row");
  assert.throws(() => bindFloodLpiPlacement(l.deps, { loan_id: "L-9", on: D("2027-03-22"), required_cents: 24000000n, premium_cents: 115000n, binding_id: "LPI-X", lapse_date: null, remap_effective: null, escrowed: false }), /no INS_FLOOD_FPI_NOTICE_45 mailing on file/);
  assert.throws(() => bindFloodLpiPlacement(l.deps, { loan_id: "L-1", on: D("2027-03-22"), required_cents: 24000000n, amount_cents: 25000000n, premium_cents: 115000n, binding_id: "LPI-X", lapse_date: null, remap_effective: null, escrowed: false }), /never exceeds the rule-2 minimum/);
  // Through the `insurance-tracking/lpi` port: the same day-45 rule, the port's binding id and annual premium on `flood.lpi.bound`.
  const l3 = live("2027-02-04T15:00:00.000Z"); remapIntoAe(l3); mailedNotice(l3); const lpi = new FakeLpiTracking(); const d3: FloodDeps = { ...l3.deps, lpi };
  assert.equal((await requestFloodLpi(d3, { loan_id: "L-1", on: D("2027-03-21"), required_cents: 24000000n, lapse_date: null, remap_effective: D("2027-02-03"), escrowed: false, now: "2027-03-21T15:00:00.000Z" })).bound, false); assert.equal(lpi.bindings.size, 0);
  const viaPort = await requestFloodLpi(d3, { loan_id: "L-1", on: D("2027-03-22"), required_cents: 24000000n, lapse_date: null, remap_effective: D("2027-02-03"), escrowed: false, now: "2027-03-22T15:00:00.000Z" });
  assert.equal(viaPort.bound, true); if (!viaPort.bound) return; assert.equal(viaPort.binding_id, "LPI-B1"); assert.equal(viaPort.premium_cents, lpi.bindings.get("LPI-B1")!.annualPremiumCents); assert.equal(viaPort.charge.method, "corporate_advance");
  assert.equal(l3.timer("FNMA_B301_FLOOD_REMAP_COVERAGE_120")!.status, "satisfied");
});
test("9.6-T2: Given RCV $310,000, UPB $240,000 Then required $240,000; a $200,000 policy → `flood_insufficient` deficiency.", () => {
  assert.equal(floodRequiredAmount(31000000n, 24000000n), 24000000n);
  assert.deepEqual(floodAdequate(20000000n, 31000000n, 24000000n, 500000n), { ok: false, deficiency: "flood_insufficient" });
  assert.equal(floodAdequate(24000000n, 31000000n, 19950000n, 500000n).ok, true);                       // UPB amortized to $199,500: over-coverage is fine
  assert.equal(floodRequiredAmount(31000000n, 30000000n), 25000000n);                                    // NFIP building maximum caps the requirement
  // Engine: the $200,000 policy is a `flood_insufficient` deficiency that opens the fdpa_flood track; the 45-day notice is due 3 servicer business days after detection (Thu 2027-02-04 → Tue 2027-02-09) and the mailing satisfies the SLA.
  const l = live("2027-02-04T15:00:00.000Z");
  const r = evaluateFloodCoverage(l.deps, { loan_id: "L-1", as_of: D("2027-02-04"), structures: SFHA, rcv_cents: 31000000n, upb_cents: 24000000n, policy: { kind: "nfip", amount_cents: 20000000n, deductible_cents: 500000n, policy_id: "pol-1" } });
  assert.equal(r.required, true); assert.equal(r.deficiency, "flood_insufficient"); assert.equal(r.required_cents, 24000000n); if (r.deficiency === null) return;
  assert.equal(r.notice, "INS_FLOOD_FPI_NOTICE_45"); assert.equal(r.track, "fdpa_flood"); assert.equal(r.notice_due, "2027-02-09"); assert.equal(r.notice_due, addBusinessDays(D("2027-02-04"), 3, servicer));
  const det = l.events.ofType("flood.deficiency.detected")[0]!; assert.equal(det.loanId, "L-1");
  assert.equal(det.payload.deficiency, "flood_insufficient"); assert.equal(det.payload.required_cents, 24000000n); assert.equal(det.payload.policy_amount_cents, 20000000n); assert.equal(det.payload.detected_at, "2027-02-04");
  const sla = l.timer("INS_FLOOD_NOTICE_SLA_3BD")!; assert.equal(sla.status, "armed"); assert.equal(sla.dueDate, "2027-02-09"); assert.equal(sla.anchorDate, "2027-02-04");
  mailedNotice(l); assert.equal(sla.status, "satisfied");
  assert.ok(eventMatches(parseEventPattern("`flood.fpi.notice.sent{template=INS_FLOOD_FPI_NOTICE_45}`")!, l.events.ofType("flood.fpi.notice.sent")[0]!));
  // The $240,000 policy against the amortized $199,500 UPB verifies coverage (`flood.coverage.verified`, no deficiency event).
  const ok = evaluateFloodCoverage(l.deps, { loan_id: "L-2", as_of: D("2027-02-04"), structures: SFHA, rcv_cents: 31000000n, upb_cents: 19950000n, policy: { kind: "nfip", amount_cents: 24000000n, deductible_cents: 500000n } });
  assert.equal(ok.deficiency, null); assert.equal(ok.required_cents, 19950000n);
  assert.deepEqual(l.events.byLoan("L-2").map((e) => e.type), ["flood.coverage.verified"]);
  // A detached non-residential structure in the SFHA with the house outside → no coverage required (B7-3-06 table; edge case), reasoning recorded.
  const none = evaluateFloodCoverage(l.deps, { loan_id: "L-3", as_of: D("2027-02-04"), structures: structuresToRequirement([{ name: "house", in_sfha: false, residential: true, security: true, principal: true }, { name: "garage", in_sfha: true, residential: false, security: true, principal: false }], true, false), rcv_cents: 31000000n, upb_cents: 24000000n, policy: null });
  assert.equal(none.required, false); assert.deepEqual(l.events.byLoan("L-3").map((e) => e.type), ["flood.coverage.not_required"]);
  assert.throws(() => evaluateFloodCoverage(l.deps, { loan_id: "", as_of: D("2027-02-04"), structures: SFHA, rcv_cents: 31000000n, upb_cents: 24000000n, policy: null }), RangeError);
});
test("9.6-T3: Given a private policy with the compliance-aid statement and an AM Best A insurer Then accepted; without the statement and lacking the 45-day cancellation clause → rejected with reason.", () => {
  assert.deepEqual(privatePolicyAcceptable({ compliance_aid_statement: true, b7_elements_verified: false, cancellation_clause_45_days: false, insurer_rating_ok: true }), { accepted: true, reason: null });
  assert.equal(privatePolicyAcceptable({ compliance_aid_statement: false, b7_elements_verified: true, cancellation_clause_45_days: false, insurer_rating_ok: true }).reason, "missing_45_day_cancellation_clause");
  assert.equal(privatePolicyAcceptable({ compliance_aid_statement: true, b7_elements_verified: true, cancellation_clause_45_days: true, insurer_rating_ok: false }).reason, "insurer_rating");
  // Engine: evidence received Mon 2027-03-01 → evaluated within 2 servicer business days (Wed 2027-03-03); the evaluation event carries kind=flood and the outcome.
  const l = live("2027-03-01T15:00:00.000Z");
  const good: FloodEvidencePolicy = { policy_number: "PVT-1", nfip: false, insurer: "Private Flood Co (AM Best A)", building_coverage_cents: 24000000n, deductible_cents: 500000n, effective: D("2027-03-01"), expiration: D("2028-03-01"), compliance_aid_statement: true, b7_elements_verified: false, cancellation_clause_45_days: false, insurer_rating_ok: true };
  const rec = receiveFloodEvidence(l.deps, { loan_id: "L-1", evidence_id: "ev-1", received_on: D("2027-03-01"), document: "declarations_page", policy: good });
  assert.equal(rec.eval_due, "2027-03-03"); assert.equal(rec.fpi_active, false); assert.equal(rec.terminate_refund_by, null);
  const ev = l.timer("FLOOD_EVIDENCE_EVAL_2BD")!; assert.equal(ev.status, "armed"); assert.equal(ev.dueDate, "2027-03-03");
  assert.equal(l.timer("FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30"), undefined, "no LPI on the books: no 30-day termination clock");
  const accepted = evaluateFloodEvidence(l.deps, { loan_id: "L-1", evidence_id: "ev-1", evaluated_on: D("2027-03-02"), document: "declarations_page", policy: good, rcv_cents: 31000000n, upb_cents: 24000000n });
  assert.equal(accepted.outcome, "confirmed"); assert.equal(accepted.reason, null); assert.equal(ev.status, "satisfied");
  const e1 = l.events.byLoan("L-1").find((e) => e.type === "insurance.evidence.evaluated")!; assert.equal(e1.payload.kind, "flood"); assert.equal(e1.payload.outcome, "confirmed");
  assert.ok(l.events.byLoan("L-1").some((e) => e.type === "flood.coverage.verified" && e.payload.source === "borrower_evidence"));
  // Without the statement and lacking the 45-day cancellation clause → rejected with the reason, still within the same 2-BD clock.
  const bad: FloodEvidencePolicy = { ...good, policy_number: "PVT-2", compliance_aid_statement: false, b7_elements_verified: true, cancellation_clause_45_days: false };
  receiveFloodEvidence(l.deps, { loan_id: "L-2", evidence_id: "ev-2", received_on: D("2027-03-01"), document: "declarations_page", policy: bad });
  const rejected = evaluateFloodEvidence(l.deps, { loan_id: "L-2", evidence_id: "ev-2", evaluated_on: D("2027-03-02"), document: "declarations_page", policy: bad, rcv_cents: 31000000n, upb_cents: 24000000n });
  assert.equal(rejected.outcome, "rejected"); assert.equal(rejected.reason, "missing_45_day_cancellation_clause");
  const e2 = l.events.byLoan("L-2").find((e) => e.type === "insurance.evidence.evaluated")!; assert.equal(e2.payload.outcome, "rejected"); assert.equal(e2.payload.reason, "missing_45_day_cancellation_clause");
  assert.equal(l.engine.byCode("FLOOD_EVIDENCE_EVAL_2BD").find((t) => t.loanId === "L-2")!.status, "satisfied", "'confirmed/rejected' both close the evaluation clock");
  assert.equal(l.events.byLoan("L-2").filter((e) => e.type === "flood.coverage.verified").length, 0);
  // Rating failure and an under-amount policy are rejected with their reasons too; an empty evidence id is refused.
  assert.equal(evaluateFloodEvidence(l.deps, { loan_id: "L-3", evidence_id: "ev-3", evaluated_on: D("2027-03-02"), document: "declarations_page", policy: { ...good, insurer_rating_ok: false }, rcv_cents: 31000000n, upb_cents: 24000000n }).reason, "insurer_rating");
  assert.equal(evaluateFloodEvidence(l.deps, { loan_id: "L-3", evidence_id: "ev-4", evaluated_on: D("2027-03-02"), document: "declarations_page", policy: { ...good, building_coverage_cents: 20000000n }, rcv_cents: 31000000n, upb_cents: 24000000n }).reason, "flood_insufficient");
  assert.throws(() => receiveFloodEvidence(l.deps, { loan_id: "L-3", evidence_id: "", received_on: D("2027-03-01"), document: "declarations_page", policy: good }), RangeError);
});
test("9.6-T4: Given RCBAP $3,000,000 on a 20-unit building with RCV $6,000,000 and unit UPB $180,000 Then supplemental requirement $30,000.", () => {
  const r = rcbap(20, 600000000n, 300000000n, 30000000n, 18000000n);
  assert.equal(r.required_rcbap_cents, 480000000n); assert.equal(r.allocation_cents, 15000000n); assert.equal(r.unit_requirement_cents, 18000000n); assert.equal(r.supplement_cents, 3000000n);
  assert.equal(rcbap(20, 600000000n, 480000000n, 30000000n, 18000000n).supplement_cents, 0n);
});
test("9.6-T5: Given evidence received 2027-04-14 of coverage effective 2027-04-11 Then termination and refund of $938.90 by 2027-05-14.", () => {
  assert.equal(nfipEffectiveDate(D("2027-04-10"), D("2027-02-03")), "2027-04-11");                     // 1-day wait within 13 months of the revision
  assert.equal(nfipEffectiveDate(D("2028-04-10"), D("2027-02-03")), "2028-05-10");                     // outside the window: 30 days
  const r = cancellation({ terms: [TERM], borrower_coverage_start: D("2027-04-11"), borrower_coverage_end: null, evidence_received_on: D("2027-04-14"), borrower_paid_cents: 115000n, deadline_days: 30 });
  assert.equal(r.overlap_days, 298); assert.equal(r.removed_cents, 93890n); assert.equal(r.refund_cents, 93890n); assert.equal(r.cancellation_effective, "2027-04-11"); assert.equal(r.deadline, "2027-05-14");
  // Engine: the worked timeline — LPI bound 2027-03-22 (effective 2027-02-03, $1,150.00/yr); the dec page received Wed 2027-04-14 arms the 30-day termination/refund clock (due 2027-05-14) and the 2-BD evaluation clock (Fri 2027-04-16).
  const l = live("2027-02-04T15:00:00.000Z"); remapIntoAe(l); mailedNotice(l); l.clock.set("2027-03-22T15:00:00.000Z"); placeOn(l, "2027-03-22");
  l.clock.set("2027-04-14T15:00:00.000Z");
  const rec = receiveFloodEvidence(l.deps, { loan_id: "L-1", evidence_id: "ev-dec", received_on: D("2027-04-14"), document: "declarations_page", policy: NFIP_DEC });
  assert.equal(rec.fpi_active, true, "derived from `flood.lpi.bound` on the books"); assert.equal(rec.terminate_refund_by, "2027-05-14"); assert.equal(rec.eval_due, "2027-04-16");
  const received = l.events.ofType("insurance.evidence.received")[0]!; assert.equal(received.payload.kind, "flood"); assert.equal(received.payload.fpi_active, true);
  const e3 = l.timer("FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30")!; assert.equal(e3.status, "armed"); assert.equal(e3.dueDate, "2027-05-14"); assert.equal(e3.anchorDate, "2027-04-14");
  const ev = l.timer("FLOOD_EVIDENCE_EVAL_2BD")!; assert.equal(ev.dueDate, "2027-04-16");
  const evalr = evaluateFloodEvidence(l.deps, { loan_id: "L-1", evidence_id: "ev-dec", evaluated_on: D("2027-04-15"), document: "declarations_page", policy: NFIP_DEC, rcv_cents: 31000000n, upb_cents: 24000000n, remap_effective: D("2027-02-03"), purchased_on: D("2027-04-10") });
  assert.equal(evalr.outcome, "confirmed"); assert.equal(evalr.expected_effective, "2027-04-11"); assert.equal(evalr.effective_date_consistent, true); assert.equal(evalr.terminate_refund_by, "2027-05-14"); assert.equal(ev.status, "satisfied");
  // Termination effective 2027-04-11 on the servicer's books; overlap [2027-04-11, 2028-02-03) = 298 days → $938.90 removed and refunded.
  assert.throws(() => payFloodRefund(l.deps, { loan_id: "L-1", binding_id: "LPI-F1", refund_cents: 93890n, rail: "ach", paid_on: D("2027-05-04") }), /terminate LPI binding LPI-F1 before paying/);
  const t = terminateFloodLpi(l.deps, { loan_id: "L-1", binding_id: "LPI-F1", terms: [TERM], borrower_coverage_start: D("2027-04-11"), evidence_received_on: D("2027-04-14"), borrower_paid_cents: 115000n, reason: "borrower_evidence" });
  assert.equal(t.effective, "2027-04-11"); assert.equal(t.overlap_days, 298); assert.equal(t.removed_cents, 93890n); assert.equal(t.refund_cents, 93890n); assert.equal(t.deadline, "2027-05-14"); assert.equal(t.notice, "INS_FLOOD_TERMINATION_REFUND_CONFIRM");
  assert.deepEqual(l.events.byLoan("L-1").filter((e) => e.type === "flood.lpi.terminated" || e.type === "fpi.lpi.cancelled").map((e) => [e.type, e.payload.track, e.payload.effective]), [["flood.lpi.terminated", "fdpa_flood", "2027-04-11"], ["fpi.lpi.cancelled", "fdpa_flood", "2027-04-11"]]);
  assert.equal(activeFloodLpi(l.deps, "L-1"), null); assert.equal(e3.status, "armed", "termination alone does not close the clock: the refund must be paid");
  // The refund never goes below the calculator; paid by 2027-05-14 → `fpi.lpi.cancelled_and_refunded{track=fdpa_flood}` satisfies the 30-day row on time.
  assert.throws(() => payFloodRefund(l.deps, { loan_id: "L-1", binding_id: "LPI-F1", refund_cents: 90000n, rail: "ach", paid_on: D("2027-05-04") }), /below the calculator's 93890/);
  l.clock.set("2027-05-04T15:00:00.000Z");
  const paid = payFloodRefund(l.deps, { loan_id: "L-1", binding_id: "LPI-F1", refund_cents: 93890n, rail: "ach", paid_on: D("2027-05-04") });
  assert.equal(paid.on_time, true); assert.equal(paid.deadline, "2027-05-14"); assert.equal(paid.timer_satisfied, "FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30"); assert.equal(paid.notice, "INS_FLOOD_TERMINATION_REFUND_CONFIRM");
  const done = l.events.ofType("fpi.lpi.cancelled_and_refunded")[0]!; assert.equal(done.payload.track, "fdpa_flood"); assert.equal(done.payload.refund_cents, 93890n);
  assert.equal(e3.status, "satisfied"); assert.equal(e3.satisfiedByEventId, done.id);
  assert.deepEqual(l.events.ofType("flood.refund.paid").map((e) => e.payload.on_time), [true]);
  assert.throws(() => payFloodRefund(l.deps, { loan_id: "L-1", binding_id: "LPI-F1", refund_cents: 93890n, rail: "ach", paid_on: D("2027-05-05") }), /already paid/);
  // Paid after the 30th day: the row breaches sev-1 first and the refund closes it late.
  const late = live("2027-02-04T15:00:00.000Z"); remapIntoAe(late); mailedNotice(late); late.clock.set("2027-03-22T15:00:00.000Z"); placeOn(late, "2027-03-22"); late.clock.set("2027-04-14T15:00:00.000Z");
  receiveFloodEvidence(late.deps, { loan_id: "L-1", evidence_id: "ev-dec", received_on: D("2027-04-14"), document: "declarations_page", policy: NFIP_DEC });
  const breaches = late.engine.evaluate("2027-05-15T12:00:00.000Z"); const b = breaches.find((x) => x.instance.code === "FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30")!; assert.equal(b.severity, 1);
  terminateFloodLpi(late.deps, { loan_id: "L-1", binding_id: "LPI-F1", terms: [TERM], borrower_coverage_start: D("2027-04-11"), evidence_received_on: D("2027-04-14"), borrower_paid_cents: 115000n, reason: "borrower_evidence" });
  assert.equal(payFloodRefund(late.deps, { loan_id: "L-1", binding_id: "LPI-F1", refund_cents: 93890n, rail: "check", paid_on: D("2027-05-15") }).on_time, false);
  assert.equal(late.timer("FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30")!.status, "satisfied_late");
});
test("9.6-T6: Given a LOMA letter Then requirement cleared, LPI cancelled effective the letter date, refund of any borrower-paid overlap, `INS_FLOOD_REMOVED_NOTICE` sent.", () => {
  const r = lomaLetter({ letter_date: D("2027-05-10"), received_on: D("2027-05-12"), lpi: [TERM], borrower_paid_cents: 115000n });
  assert.equal(r.requirement, "cleared"); assert.equal(r.cancellation_effective, "2027-05-10"); assert.equal(r.notice, "INS_FLOOD_REMOVED_NOTICE"); assert.equal(r.file_letter, "B-3-01");
  assert.equal(r.refund.overlap_days, 269); assert.equal(r.refund.deadline, "2027-06-11"); assert.ok(r.refund.refund_cents > 0n);
  // Engine: the LOMA (received 2027-05-12) clears the requirement, terminates the LPI bound 2027-03-22 effective the letter date, and names the removed notice (a registered template).
  const l = live("2027-02-04T15:00:00.000Z"); remapIntoAe(l); mailedNotice(l); l.clock.set("2027-03-22T15:00:00.000Z"); placeOn(l, "2027-03-22"); l.clock.set("2027-05-12T15:00:00.000Z");
  const a = applyLomaLetter(l.deps, { loan_id: "L-1", letter_type: "LOMA", letter_date: D("2027-05-10"), received_on: D("2027-05-12"), document_id: "doc-loma", lpi: { binding_id: "LPI-F1", terms: [TERM] }, borrower_paid_cents: 115000n });
  assert.equal(a.requirement, "cleared"); assert.equal(a.cancellation_effective, "2027-05-10"); assert.equal(a.notice, "INS_FLOOD_REMOVED_NOTICE"); assert.equal(a.file_letter, "B-3-01");
  assert.equal(a.termination!.effective, "2027-05-10"); assert.equal(a.termination!.overlap_days, 269); assert.equal(a.termination!.refund_cents, a.refund.refund_cents); assert.equal(a.termination!.deadline, "2027-06-11"); assert.equal(a.termination!.notice, "INS_FLOOD_REMOVED_NOTICE");
  assert.deepEqual(l.events.byLoan("L-1").filter((e) => e.occurredAt >= "2027-05-12" && !e.type.startsWith("timer.")).map((e) => e.type), ["flood.loma.received", "flood.coverage.not_required", "flood.map_change.closed", "flood.lpi.terminated", "fpi.lpi.cancelled"]);
  const nr = l.events.byLoan("L-1").find((e) => e.type === "flood.coverage.not_required")!; assert.equal(nr.payload.reason, "loma_lomr"); assert.equal(nr.payload.effective, "2027-05-10"); assert.equal(nr.payload.notice, "INS_FLOOD_REMOVED_NOTICE");
  assert.equal(activeFloodLpi(l.deps, "L-1"), null);
  const reg = buildRegistry(); const t = reg.template("INS_FLOOD_REMOVED_NOTICE"); assert.equal(t.ownerSection, "9.6");
  // The refund of the borrower-paid overlap is paid on the 30-day clock and closes it (the borrower's own NFIP policy is theirs to keep — no requirement remains).
  const paid = payFloodRefund(l.deps, { loan_id: "L-1", binding_id: "LPI-F1", refund_cents: a.refund.refund_cents, rail: "ach", paid_on: D("2027-05-20") }); assert.equal(paid.on_time, true); assert.equal(paid.deadline, "2027-06-11");
  // A LOMA with no LPI on the books clears the requirement with nothing to cancel; a vendor-relayed LOMR is a vendor message (heartbeat) that records the letter for review.
  const l2 = live("2027-05-12T15:00:00.000Z"); const a2 = applyLomaLetter(l2.deps, { loan_id: "L-2", letter_type: "LOMR", letter_date: D("2027-05-10"), received_on: D("2027-05-12"), document_id: "doc-lomr", lpi: null, borrower_paid_cents: 0n });
  assert.equal(a2.termination, null); assert.equal(a2.refund.refund_cents, 0n); assert.deepEqual(l2.events.byLoan("L-2").map((e) => e.type), ["flood.loma.received", "flood.coverage.not_required", "flood.map_change.closed"]);
  const vm = receiveVendorMessage(l2.deps, { kind: "lomr_loma_received", vendor_id: "cotality", certificate_id: "C-2", received_at: "2027-05-12T16:00:00.000Z", loan_id: "L-3", loma: { letter_type: "LOMA", letter_date: D("2027-05-10"), document_id: "doc-3" } });
  assert.equal(vm.required_notice, "INS_FLOOD_REMOVED_NOTICE"); assert.equal(l2.timer("FLOOD_LOL_HEARTBEAT_35")!.dueDate, "2027-06-16");
});
test("9.6-T7: Given a hazard lapse and flood lapse on the same day Then MS-3(A) and the flood 45-day notice are mailed as separate documents in one transmittal; timers independent.", async () => {
  const r = sameDayLapses({ mailed_on: D("2026-10-05"), hazard_lapse: true, flood_lapse: true });
  assert.equal(r.documents.length, 2); assert.equal(r.transmittals, 1); assert.equal(r.timers_independent, true);
  assert.deepEqual(r.documents.map((d) => [d.template, d.separate_document, d.deadline]), [["INS_FPI_FIRST_MS3A", true, "2026-11-19"], ["INS_FLOOD_FPI_NOTICE_45", true, "2026-11-19"]]);
  // Notice Registry: the flood notice is a separate document that may share the MS-3(A) transmittal (RESPA §6(l)(4)); mailed through the registry, its proof of mailing (not the MS-3(A)'s) arms the flood clocks.
  const reg = buildRegistry(); publishAuthored(reg); const flood = reg.template("INS_FLOOD_FPI_NOTICE_45"); assert.equal(flood.separateDocument, true); assert.ok(flood.mayCombineWith.includes("INS_FPI_FIRST_MS3A"));
  const l = live("2026-10-05T14:00:00.000Z"); const pm = new FakePrintMail(); const svc = new NoticeService({ registry: reg, events: l.events, clock: l.clock, printMail: pm, edelivery: new FakeEdelivery() });
  const deps: FloodDeps = { ...l.deps, notices: svc };
  const sample = reg.activeVersion("INS_FLOOD_FPI_NOTICE_45", D("2026-10-05"))!.samplePayload;
  const B = { partyId: "B", name: "Borrower", mailingAddress: "1 Test St" };
  const sent = await sendFloodNotice45(deps, { loan_id: "L-1", recipients: [B], payload: { ...sample, notice_date: "2026-10-05", deadline: "2026-11-19", coverage_from: "2026-10-05" }, as_of: D("2026-10-05") });
  assert.equal(sent.notice.status, "sent"); assert.equal(sent.awaiting_proof_of_mailing, true); assert.equal(sent.sent, null); assert.equal(sent.notice.deliveries[0]!.channel, "mail_first_class");
  assert.equal(l.timer("FDPA_4012A_E_FLOOD_FPI_NOTICE_45"), undefined, "no clock before the proof of mailing");
  const ms3a = svc.render({ templateCode: "INS_FPI_FIRST_MS3A", loanId: "L-1", recipients: [B], payload: reg.activeVersion("INS_FPI_FIRST_MS3A", D("2026-10-05"))!.samplePayload, asOf: D("2026-10-05") }); await svc.send(ms3a.id);
  assert.throws(() => recordFloodNoticeMailed(deps, { loan_id: "L-1", notice_id: ms3a.id, mailed_at: "2026-10-05T18:00:00.000Z", proof_of_mailing_id: "POM-MS3A" }), /INS_FPI_FIRST_MS3A is not INS_FLOOD_FPI_NOTICE_45/);
  pm.runProduction("2026-10-05T18:00:00.000Z");
  const proof = recordFloodNoticeMailed(deps, { loan_id: "L-1", notice_id: sent.notice.id, mailed_at: "2026-10-05T18:00:00.000Z", proof_of_mailing_id: "POM-FLOOD" });
  assert.equal(proof.mailed_on, "2026-10-05"); assert.equal(proof.borrower_deadline, "2026-11-19"); assert.equal(sent.notice.status, "delivered");
  assert.deepEqual(l.events.all().filter((e) => e.type === "notice.mailed" || e.type === "flood.fpi.notice.sent").map((e) => [e.type, e.payload.template]), [["notice.mailed", "INS_FLOOD_FPI_NOTICE_45"], ["flood.fpi.notice.sent", "INS_FLOOD_FPI_NOTICE_45"]]);
  const gate = l.timer("FDPA_4012A_E_FLOOD_FPI_NOTICE_45")!; assert.equal(gate.dueDate, "2026-11-19"); assert.equal(l.timer("FDPA_4012A_E2_FLOOD_PLACE_AFTER_45")!.dueDate, "2026-11-19");
  assert.equal(l.engine.byCode("FDPA_4012A_E_FLOOD_FPI_NOTICE_45").length, 1, "the MS-3(A) transmittal armed nothing on the flood clocks");
  assert.throws(() => recordFloodNoticeMailed(deps, { loan_id: "L-1", notice_id: sent.notice.id, mailed_at: "2026-10-05T18:00:00.000Z", proof_of_mailing_id: "POM-FLOOD" }), /already on file/);
  // E-SIGN delivery: when the registry delivers electronically under an active consent, the send itself is the notification and the clocks still arm (an e-delivered notice never emits `notice.mailed`).
  const l2 = live("2026-10-05T14:00:00.000Z"); const svc2 = new NoticeService({ registry: reg, events: l2.events, clock: l2.clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const consented = { partyId: "B", name: "Borrower", mailingAddress: "1 Test St", email: "b@example.com", consent: { party_id: "B", status: "active" as const, classes: [flood.noticeClass], disclosure_version: "v1" } };
  const e = await sendFloodNotice45({ ...l2.deps, notices: svc2 }, { loan_id: "L-1", recipients: [consented as never], payload: { ...sample, notice_date: "2026-10-05", deadline: "2026-11-19", coverage_from: "2026-10-05" }, as_of: D("2026-10-05") });
  assert.equal(e.notice.deliveries[0]!.channel, "email_link"); assert.equal(e.awaiting_proof_of_mailing, false); assert.equal(e.sent!.mailed_on, "2026-10-05"); assert.equal(e.sent!.channel, "email_link");
  assert.equal(l2.timer("FDPA_4012A_E2_FLOOD_PLACE_AFTER_45")!.dueDate, "2026-11-19"); assert.equal(l2.events.ofType("notice.mailed").length, 0);
});
test("9.6-T8: Given no vendor heartbeat for 36 days Then sev-2 and a re-order queue for pending alerts.", () => {
  const r = vendorHeartbeatCheck({ last_message_on: D("2027-01-01"), today: D("2027-02-06"), pending_alerts: [{ loan_id: "L-1", certificate_id: "C-1" }] });
  assert.equal(r.severity, "sev2"); assert.deepEqual(r.reorder_queue, [{ loan_id: "L-1", certificate_id: "C-1", action: "manual_reorder" }]);
  assert.equal(vendorHeartbeatCheck({ last_message_on: D("2027-01-01"), today: D("2027-02-05"), pending_alerts: [] }).severity, "ok");
  // Engine: the vendor's last message (a community-status change on 2027-01-01) arms FLOOD_LOL_HEARTBEAT_35 on the vendor feed, due 2027-02-05; a duplicate (same certificate, kind, instant) is dropped.
  const l = live("2027-01-01T15:00:00.000Z");
  const msg = { kind: "community_status_change" as const, vendor_id: "cotality", certificate_id: "C-1", received_at: "2027-01-01T15:00:00.000Z", community: { community_number: "480287", status: "suspended" as const, effective_date: D("2027-01-01") } };
  const m = receiveVendorMessage(l.deps, msg); assert.equal(m.duplicate, false); assert.equal(m.heartbeat_due, "2027-02-05"); assert.equal(m.private_only, true);
  assert.equal(receiveVendorMessage(l.deps, msg).duplicate, true); assert.equal(l.events.ofType("flood.lol.message.received").length, 1);
  const hb = l.timer("FLOOD_LOL_HEARTBEAT_35")!; assert.equal(hb.status, "armed"); assert.equal(hb.dueDate, "2027-02-05"); assert.deepEqual(hb.subject, { kind: "flood_vendor", id: "cotality" });
  assert.equal(l.events.ofType("flood.community_status.changed")[0]!.payload.work_with_borrower_by, "2027-05-01", "non-participating community: private flood within 120 days (B-3-01)");
  // Day 36 with no message: the row breaches sev-2 (monitoring blind); the heartbeat check opens the re-order queue for every pending alert and the sev-2 escalation.
  assert.equal(l.engine.evaluate("2027-02-05T12:00:00.000Z").length, 0);
  const breaches = l.engine.evaluate("2027-02-06T12:00:00.000Z"); assert.equal(breaches.length, 1); assert.equal(breaches[0]!.instance.code, "FLOOD_LOL_HEARTBEAT_35"); assert.equal(breaches[0]!.severity, 2);
  const esc = new EscalationService(l.events, l.clock);
  const h = vendorHeartbeat({ ...l.deps, escalations: esc }, { vendor_id: "cotality", today: D("2027-02-06"), pending_alerts: [{ loan_id: "L-1", certificate_id: "C-1" }] });
  assert.equal(h.severity, "sev2"); assert.equal(h.last_message_on, "2027-01-01"); assert.equal(h.days_silent, 36); assert.deepEqual(h.reorder_queue, [{ loan_id: "L-1", certificate_id: "C-1", action: "manual_reorder" }]);
  assert.equal(l.events.ofType("flood.lol.heartbeat.missed")[0]!.payload.severity, "sev2"); assert.ok(l.events.all().some((e) => e.type.startsWith("escalation.") && e.payload.severity === "sev2"));
  // The next vendor message (a map change on 2027-02-06) closes the breached row late and arms the next 35-day window; a vendor with no message on file is refused.
  receiveVendorMessage(l.deps, { kind: "map_change_notification", vendor_id: "cotality", certificate_id: "C-1", received_at: "2027-02-06T15:00:00.000Z", loan_id: "L-1", map_change: { ...REMAP, effective_date: D("2027-02-05") } });
  assert.equal(hb.status, "satisfied_late"); assert.equal(l.timer("FLOOD_LOL_HEARTBEAT_35", 1)!.dueDate, "2027-03-13");
  assert.equal(vendorHeartbeat(l.deps, { vendor_id: "cotality", today: D("2027-02-07"), pending_alerts: [] }).severity, "ok");
  assert.throws(() => vendorHeartbeat(l.deps, { vendor_id: "lereta", today: D("2027-02-07"), pending_alerts: [] }), /no vendor message on file/);
  assert.throws(() => receiveVendorMessage(l.deps, { kind: "map_change_notification", vendor_id: "cotality", certificate_id: "", received_at: "2027-02-06T15:00:00.000Z", loan_id: "L-1", map_change: REMAP }), /certificate_id/);
});
test("9.6-T9: Given Fannie Mae requests flood evidence on a Monday Then response due 10 fannie_et business days later; package assembled by the agent.", () => {
  assert.equal(dayOfWeek(D("2027-03-01")), 1);
  assert.equal(fnmaEvidenceDue(D("2027-03-01")), "2027-03-15");
  const pkg = fnmaEvidencePackage(D("2027-03-01"), { policy_number: "NFIP-77", nfip: true, building_coverage_cents: 24000000n });
  assert.equal(pkg.due, "2027-03-15"); assert.equal(pkg.assembled_by, "insurance-property"); assert.equal(pkg.sent_by, "fnma_portal_operator");
  assert.ok(pkg.documents.some((d) => /NFIP declarations page NFIP-77/.test(d)) && pkg.documents.some((d) => /SFHDF/.test(d)));
  // Engine: `fnma.request.received{kind=flood_evidence}` on Mon 2027-03-01 arms FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD due Mon 2027-03-15; the agent cannot send the response (officer / fnma_portal_operator only); the operator's response satisfies it.
  const l = live("2027-03-01T15:00:00.000Z");
  const req = receiveFnmaEvidenceRequest(l.deps, { loan_id: "L-1", request_id: "R-1", requested_on: D("2027-03-01") });
  assert.equal(req.due, "2027-03-15"); assert.equal(req.assembled_by, "insurance-property"); assert.equal(req.sent_by, "fnma_portal_operator"); assert.equal(req.escalate_to, "officer");
  const t = l.timer("FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD")!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2027-03-15"); assert.equal(t.anchorDate, "2027-03-01");
  const policy = { policy_number: "NFIP-77", nfip: true, building_coverage_cents: 24000000n };
  assert.throws(() => respondFnmaEvidenceRequest(l.deps, { loan_id: "L-1", request_id: "R-1", requested_on: D("2027-03-01"), sent_on: D("2027-03-10"), by: AGENT, policy }), /fnma_portal_operator or officer/);
  assert.throws(() => respondFnmaEvidenceRequest(l.deps, { loan_id: "L-1", request_id: "R-9", requested_on: D("2027-03-01"), sent_on: D("2027-03-10"), by: OPERATOR, policy }), /no Fannie Mae request R-9/);
  assert.equal(t.status, "armed");
  const resp = respondFnmaEvidenceRequest(l.deps, { loan_id: "L-1", request_id: "R-1", requested_on: D("2027-03-01"), sent_on: D("2027-03-10"), by: OPERATOR, policy });
  assert.equal(resp.on_time, true); assert.equal(resp.sent_by, "fnma_portal_operator"); assert.ok(resp.documents.some((d) => /SFHDF/.test(d)));
  const ev = l.events.ofType("fnma.request.responded")[0]!; assert.equal(ev.payload.kind, "flood_evidence"); assert.equal(ev.actor, OPERATOR); assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, ev.id);
  // A request answered on the 11th business day breaches sev-1 first (→ officer) and closes late.
  const l2 = live("2027-03-01T15:00:00.000Z"); receiveFnmaEvidenceRequest(l2.deps, { loan_id: "L-1", request_id: "R-2", requested_on: D("2027-03-01") });
  const b = l2.engine.evaluate("2027-03-16T12:00:00.000Z").find((x) => x.instance.code === "FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD")!; assert.equal(b.severity, 1);
  // The registry keys the code to the 9.1 row (breach "sev-1"); the 9.6 row routes the breach to the officer (`sev-1 → officer`), which the ops result carries as the escalation route.
  assert.ok(loadOverriddenRegistry().forProcess("9.6").find((t) => t.code === "FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD")!.severity.escalateTo.includes("officer")); assert.equal(req.escalate_to, "officer");
  assert.equal(respondFnmaEvidenceRequest(l2.deps, { loan_id: "L-1", request_id: "R-2", requested_on: D("2027-03-01"), sent_on: D("2027-03-16"), by: OPERATOR, policy }).on_time, false);
  assert.equal(l2.timer("FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD")!.status, "satisfied_late");
});

test("9.6 worked timeline: $1,150.00 flood LPI premium over the 2027-02-03 term", () => {
  const term: LpiTerm = { effective: D("2027-02-03"), expiration: D("2028-02-03"), premium_cents: 115000n };
  assert.equal(dailyRate(term).toFixed(6), "315.068493");                                             // 115,000 ÷ 365
  assert.equal(overlapPremium(term, 298), 93890n);                                                     // 298 days → 93,890.4110 → $938.90
  assert.equal(overlapPremium(term, 365), 115000n);                                                    // the whole term refunds the whole premium
  assert.equal(addDays(D("2027-02-03"), 120), "2027-06-03"); assert.equal(addMonths(D("2027-02-03"), 13), "2028-03-03");
});

test("9.6 orderDetermination: the SFHDF the vendor returns is ingested as a life-of-loan message (determination received, coverage required, heartbeat armed); NFHL alone is refused", async () => {
  const l = live("2026-10-01T15:00:00.000Z"); const flood = new FakeFlood(); flood.zoneFor = () => ({ zone: "AE", sfha: true });
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(l.events, l.clock), services: {}, ports: { flood } };
  const ctx = { loanId: "L-1", events: l.events, ledger: new MemoryLedger(), timers: l.engine, clock: l.clock, decide: () => {}, actor: AGENT, now: l.clock.now() } as unknown as CommandContext;
  const tool = SECTION_09_TOOLS.find((t) => t.process === "9.6" && t.name === "orderDetermination")!;
  const out = (await tool.handler({ property_id: "P-1", address: "1 River Rd", structures: SFHA }, ctx, rt)) as { certificateId: string; coverage_required: boolean; heartbeat_due: string };
  assert.equal(out.certificateId, "SFHDF-1"); assert.equal(out.coverage_required, true); assert.equal(out.heartbeat_due, "2026-11-05");
  assert.deepEqual(l.events.all().filter((e) => e.type.startsWith("flood.")).map((e) => e.type), ["flood.determination.ordered", "flood.lol.message.received", "flood.determination.received", "flood.coverage.required"]);
  assert.equal(l.timer("FLOOD_LOL_HEARTBEAT_35")!.dueDate, "2026-11-05");
  assert.equal(tool.guardrails!.find((g) => g.code === "NO_NFHL_ONLY")!.refuse({ property_id: "P-1", address: "x", source: "nfhl_only" }, ctx) !== undefined, true);
  // computeFloodRequirement: a placement request with no notice date at all is refused (the case the guardrail exists for), as is one inside the 45 days.
  const cfr = SECTION_09_TOOLS.find((t) => t.process === "9.6" && t.name === "computeFloodRequirement")!; const g = cfr.guardrails!.find((x) => x.code === "NO_PLACEMENT_BEFORE_45")!;
  assert.ok(g.refuse({ rcv_cents: 31000000n, upb_cents: 24000000n, place: true, place_cents: 24000000n, today: "2027-02-06" }, ctx));
  assert.ok(g.refuse({ rcv_cents: 31000000n, upb_cents: 24000000n, place: true, place_cents: 24000000n, notice_mailed_on: "2027-02-05", today: "2027-03-21" }, ctx));
  assert.equal(g.refuse({ rcv_cents: 31000000n, upb_cents: 24000000n, place: true, place_cents: 24000000n, notice_mailed_on: "2027-02-05", today: "2027-03-22" }, ctx), undefined);
  // The determination result path is idempotent per certificate/instant and refuses an empty loan id.
  assert.equal(recordDeterminationResult(l.deps, { loan_id: "L-1", vendor_id: "flood", received_at: l.clock.now(), determination: flood.determinations.get("SFHDF-1")! }).duplicate, true);
  assert.throws(() => recordDeterminationResult(l.deps, { loan_id: "", vendor_id: "flood", received_at: l.clock.now(), determination: flood.determinations.get("SFHDF-1")! }), RangeError);
});
