// 13.6 Default-related law-firm management
// spec/sections/13-foreclosure/13-6-default-related-law-firm-management.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Each T-id runs twice: through the pure calculators (./firms.ts, ./ops.ts) and through the process's tools on the bus
// (`attorney.message.send` / `invoice.review` / `dra.snapshot.import` ops from src/app/tools/section13-6.ts) with a
// TimerEngine over the 13.6 (and 13.3 firm-ack) registry rows — section + process overrides — so the timers the T-id
// names arm on the events the handlers append and are satisfied by them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { assertGate, GateClosed } from "../../app/evaluators.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { SECTION_13_TOOLS } from "../../app/tools/section13.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { suspensionGate, draPostponementCheck, feeApproval, scorecardReview, firmDueDiligence, firmRetention, firmEscalation, matterTransferGate } from "./ops.ts";
import { reviewInvoice, feeEarned, eoTierOk, eoTierFor, form200Expectation, transferNoticeGate, milestonePct, MILESTONES } from "./firms.ts";
import { reconcileDra, selectionRecordsReleased, REVIEW_ELEMENTS, transferLane } from "./ops-13-6.ts";

const LOAN = "L-136";
const AGENT: Actor = { kind: "agent", id: "foreclosure-ops" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const PORTAL_OP: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };
const registry = loadOverriddenRegistry();
type Tool = "attorney.message.send" | "invoice.review" | "dra.snapshot.import" | "firm.get" | "fee_schedule.get";

/** The §13 tools on the bus, an event store the TimerEngine (13.6 rows + 13.3's FNMA_E3205_FIRM_ACK_2BD) listens to, and a movable clock. */
function harness(now: string, loanId = LOAN) {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(registry, events, { processes: ["13.6", "13.3"] });
  const ledger = new MemoryLedger();
  const ctx: UowContext = { loanId, events, ledger, timers, clock, decide: () => {} };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, SECTION_13_TOOLS); const bus = new CommandBus(agents);
  const run = async <T = Record<string, unknown>>(tool: Tool, input: ToolInput, actor: Actor = AGENT, at?: string): Promise<T> => {
    if (at) clock.set(at); return (await bus.execute(cmds.get(toolKey("13.6", tool))!, actor, { loan_id: loanId, ...input }, ctx, at ? { now: at } : {})).output as T;
  };
  const last = (code: string) => { const all = timers.byCode(code); assert.ok(all.length, `${code} armed`); return all[all.length - 1]!; };
  const inst = (code: string, subjectId: string) => { const t = timers.byCode(code).find((x) => x.subject.id === subjectId); assert.ok(t, `${code} armed for ${subjectId}`); return t!; };
  const emitted = (type: string) => events.ofType(type);
  const row = (kind: string, id: string) => rt.store.get(kind, id)?.data ?? null;
  return { clock, events, timers, ledger, rt, run, last, inst, emitted, row };
}
const refused = (code: string) => (e: unknown) => e instanceof CommandRefused && e.code === code;
const gateClosed = (code: string) => (e: unknown) => e instanceof GateClosed && e.ref === code;
const noon = (d: string) => `${d}T16:00:00.000Z`;   // noon ET
/** A firm through candidate → due diligence (Tier I $1M/$3M) → Form 200 (officer) → No Objection → training → LRA → retained, on the dates of 13.6-T2. */
async function retainedFirm(h: ReturnType<typeof harness>, firmId = "firm-A", state = "FL") {
  await h.run("attorney.message.send", { kind: "firm_candidate", firm_id: firmId, legal_name: `${firmId} Default Law PA`, offices: ["Miami FL"] }, AGENT, noon("2026-09-01"));
  await h.run("attorney.message.send", { kind: "eo_policy", firm_id: firmId, annual_foreclosures: 1_200, per_occurrence_cents: 100_000_000n, aggregate_cents: 300_000_000n, expires_on: "2027-06-30", certificate_document_id: "doc-eo-1" }, AGENT, noon("2026-09-01"));
  await h.run("attorney.message.send", { kind: "due_diligence", firm_id: firmId, annual_foreclosures: 1_200, eo_per_occurrence_cents: 100_000_000n, eo_aggregate_cents: 300_000_000n, eo_expires_on: "2027-06-30", qualifying_attorneys: 2 }, AGENT, noon("2026-09-08"));
  await h.run("attorney.message.send", { kind: "form200_submit", firm_id: firmId, state, package_document_id: "doc-f200" }, OFFICER, noon("2026-09-10"));
  await h.run("attorney.message.send", { kind: "form200_response", firm_id: firmId, state, response: "no_objection" }, PORTAL_OP, noon("2026-09-28"));
  await h.run("attorney.message.send", { kind: "training_completed", firm_id: firmId, state }, AGENT, noon("2026-10-05"));
  await h.run("attorney.message.send", { kind: "lra_executed", firm_id: firmId, state, document_id: "doc-lra" }, AGENT, noon("2026-10-06"));
  return h.run("attorney.message.send", { kind: "retain", firm_id: firmId, state }, OFFICER, noon("2026-10-07"));
}
const elements = () => Object.fromEntries(REVIEW_ELEMENTS.map((e) => [e, { result: "pass", evidence_document_id: `doc-${e}` }]));

test("13.6-T1: Given a candidate firm with Tier I E&O of $1M/$2M, Then due diligence fails the aggregate minimum; with $1M/$3M passes; Form 200 package generated for `officer` signature.", async () => {
  const fail = firmDueDiligence({ annual_foreclosures: 1_200, eo_per_occurrence_cents: 100_000_000n, eo_aggregate_cents: 200_000_000n });
  assert.equal(fail.tier, 1); assert.equal(fail.passed, false); assert.equal(fail.failing.length, 1); assert.match(fail.failing[0]!, /aggregate 200000000 < Tier 1 minimum 300000000/); assert.equal(fail.form200_package, null);
  const pass = firmDueDiligence({ annual_foreclosures: 1_200, eo_per_occurrence_cents: 100_000_000n, eo_aggregate_cents: 300_000_000n });
  assert.equal(pass.passed, true); assert.deepEqual(pass.form200_package, { for_signature_by: "officer", certifies: "F-2-04 minimum requirements", status: "form200_pending" });
  assert.equal(eoTierOk(1, 100_000_000n, 200_000_000n), false); assert.equal(eoTierOk(1, 100_000_000n, 300_000_000n), true);
  assert.equal(eoTierFor(4_499), 1); assert.equal(eoTierFor(4_500), 2); assert.equal(eoTierFor(20_000), 3);
  assert.equal(eoTierOk(2, 500_000_000n, 500_000_000n), true); assert.equal(eoTierOk(2, 100_000_000n, 300_000_000n), false); assert.equal(eoTierOk(3, 800_000_000n, 800_000_000n), true); assert.equal(eoTierOk(3, 500_000_000n, 500_000_000n), false);

  // On the bus: the $1M/$2M file rejects the firm — the rejection is a selection decision kept 7 years (FNMA_A4201_RECORDS_7Y
  // armed from decided_on 2026-09-08 → 2033-09-08) and the firm is informed; the $1M/$3M file yields the officer's package.
  const h = harness(noon("2026-09-08"));
  await h.run("attorney.message.send", { kind: "firm_candidate", firm_id: "firm-X", legal_name: "X Default Law PA" });
  const rejected = await h.run<{ passed: boolean; tier: number; failing: string[]; status: string; form200_package: unknown }>("attorney.message.send", { kind: "due_diligence", firm_id: "firm-X", annual_foreclosures: 1_200, eo_per_occurrence_cents: 100_000_000n, eo_aggregate_cents: 200_000_000n, qualifying_attorneys: 2 });
  assert.equal(rejected.passed, false); assert.equal(rejected.tier, 1); assert.equal(rejected.status, "rejected"); assert.equal(rejected.form200_package, null);
  const decided = h.emitted("firm.selection.decided")[0]!; assert.equal(decided.payload.decision, "rejected"); assert.equal(decided.payload.inform_firm, true); assert.equal(decided.payload.retain_until, "2033-09-08");
  const records = h.last("FNMA_A4201_RECORDS_7Y"); assert.equal(records.anchorDate, "2026-09-08"); assert.equal(records.dueDate, "2033-09-08"); assert.equal(records.status, "armed"); assert.deepEqual(records.subject, { kind: "attorney_firm", id: "firm-X" });
  await assert.rejects(h.run("attorney.message.send", { kind: "form200_submit", firm_id: "firm-X", state: "FL", package_document_id: "doc-f200-x" }, OFFICER), /due diligence has not passed F-2-04/);
  // release before 7 years is refused; on 2033-09-08 the release closes the retention clock
  assert.throws(() => selectionRecordsReleased({ firm_id: "firm-X", decided_on: D("2026-09-08"), decision: "rejected", released_on: D("2033-09-07"), legal_hold: false }), /retained until 2033-09-08 — 1 days remain/);
  await assert.rejects(h.run("attorney.message.send", { kind: "records_release", firm_id: "firm-X" }, AGENT, noon("2030-01-02")), /retained until 2033-09-08/);
  await h.run("attorney.message.send", { kind: "records_release", firm_id: "firm-X" }, AGENT, noon("2033-09-08"));
  assert.equal(h.emitted("records.retention.released")[0]!.payload.kind, "firm_selection"); assert.equal(h.last("FNMA_A4201_RECORDS_7Y").status, "satisfied");

  await h.run("attorney.message.send", { kind: "firm_candidate", firm_id: "firm-A", legal_name: "A Default Law PA" }, AGENT, noon("2026-09-08"));
  const passed = await h.run<{ passed: boolean; form200_package: { for_signature_by: string; status: string } }>("attorney.message.send", { kind: "due_diligence", firm_id: "firm-A", annual_foreclosures: 1_200, eo_per_occurrence_cents: 100_000_000n, eo_aggregate_cents: 300_000_000n, eo_expires_on: "2027-06-30", qualifying_attorneys: 2 });
  assert.equal(passed.passed, true); assert.deepEqual(passed.form200_package, { for_signature_by: "officer", certifies: "F-2-04 minimum requirements", status: "form200_pending" });
  // the certification is the officer's: the agent cannot submit the Form 200
  await assert.rejects(h.run("attorney.message.send", { kind: "form200_submit", firm_id: "firm-A", state: "FL", package_document_id: "doc-f200" }), refused("FORM200_OFFICER_SUBMITS"));
  await assert.rejects(h.run("attorney.message.send", { kind: "message", firm_id: "firm-A", subject: "Form 200 certification", form200_certification: true }), refused("FORM200_OFFICER_CERTIFIES"));
  await assert.rejects(h.run("attorney.message.send", { kind: "message", firm_id: "firm-A", subject: "referral", require_vendor: true, required_vendor: "SM Title LLC" }), refused("NO_SERVICER_SPECIFIED_VENDORS"));
});
test('13.6-T2: Given Form 200 submitted Sept. 10, 2026, Then a 15-BD expectation timer ends Oct. 1, 2026 (fannie_et calendar); "No Objection" + training + LRA ⇒ `retained`; a referral to a non-retained firm is refused.', async () => {
  const pending = firmRetention({ form200_submitted_on: D("2026-09-10"), response: null });
  assert.equal(pending.expectation_due, "2026-10-01"); assert.equal(pending.timer, "FNMA_A4201_FORM200_RESPONSE_15BD"); assert.equal(pending.status, "form200_pending"); assert.equal(pending.referral_allowed, false); assert.match(pending.refusal!, /FNMA_A4201_RETAINED_FIRM_GATE/);
  assert.equal(form200Expectation(D("2026-09-10")), "2026-10-01");
  assert.equal(firmRetention({ form200_submitted_on: D("2026-09-10"), response: "no_objection" }).status, "no_objection");
  const retained = firmRetention({ form200_submitted_on: D("2026-09-10"), response: "no_objection", training_completed_on: D("2026-10-05"), lra_executed_on: D("2026-10-06"), eo_expires_on: D("2027-06-30"), today: D("2026-10-07") });
  assert.equal(retained.status, "retained"); assert.equal(retained.referral_allowed, true); assert.equal(retained.refusal, null);
  assert.equal(firmRetention({ form200_submitted_on: D("2026-09-10"), response: "objection" }).status, "rejected");

  // On the bus: Form 200 submitted Thu 2026-09-10 arms FNMA_A4201_FORM200_RESPONSE_15BD, 15 fannie_et business days → Thu 2026-10-01.
  const h = harness(noon("2026-09-01"));
  await h.run("attorney.message.send", { kind: "firm_candidate", firm_id: "firm-A", legal_name: "A Default Law PA" });
  await h.run("attorney.message.send", { kind: "eo_policy", firm_id: "firm-A", annual_foreclosures: 1_200, per_occurrence_cents: 100_000_000n, aggregate_cents: 300_000_000n, expires_on: "2027-06-30", certificate_document_id: "doc-eo-1" });
  const eo = h.last("SM_FIRM_EO_EXPIRY_30"); assert.equal(eo.anchorDate, "2027-06-30"); assert.equal(eo.dueDate, "2027-05-31"); assert.equal(eo.status, "armed");
  await h.run("attorney.message.send", { kind: "due_diligence", firm_id: "firm-A", annual_foreclosures: 1_200, eo_per_occurrence_cents: 100_000_000n, eo_aggregate_cents: 300_000_000n, eo_expires_on: "2027-06-30", qualifying_attorneys: 2 }, AGENT, noon("2026-09-08"));
  // a referral before retention is refused by FNMA_A4201_RETAINED_FIRM_GATE (evaluator 13.6.firmRetainedAndCurrent over attorney_retentions)
  await assert.rejects(h.run("attorney.message.send", { kind: "refer", firm_id: "firm-A", state: "FL", matter_id: "M-0", case_id: "C-1" }, AGENT, noon("2026-09-09")), gateClosed("FNMA_A4201_RETAINED_FIRM_GATE"));
  const refusal0 = h.emitted("foreclosure.gate.refused")[0]!; assert.equal(refusal0.payload.code, "FNMA_A4201_RETAINED_FIRM_GATE"); assert.match(String(refusal0.payload.reason), /firm_retained_for_state, lra_executed, training_done not satisfied/); assert.equal(h.row("attorney_matters", "M-0"), null);
  assert.equal(h.last("FNMA_A4201_RETAINED_FIRM_GATE").note, "evaluator:13.6.firmRetainedAndCurrent");
  const sub = await h.run<{ expectation_due: string; status: string }>("attorney.message.send", { kind: "form200_submit", firm_id: "firm-A", state: "FL", package_document_id: "doc-f200" }, OFFICER, noon("2026-09-10"));
  assert.equal(sub.expectation_due, "2026-10-01"); assert.equal(sub.status, "form200_pending");
  const f200 = h.last("FNMA_A4201_FORM200_RESPONSE_15BD"); assert.equal(f200.anchorDate, "2026-09-10"); assert.equal(f200.dueDate, "2026-10-01"); assert.equal(f200.status, "armed"); assert.deepEqual(f200.subject, { kind: "attorney_retention", id: "firm-A:FL" });
  assert.equal(h.emitted("form200.submitted")[0]!.payload.certified_by, "human:u-officer (officer)");
  // Fannie Mae's determination is recorded by the portal operator (the agent never records one it did not receive)
  await assert.rejects(h.run("attorney.message.send", { kind: "form200_response", firm_id: "firm-A", state: "FL", response: "no_objection" }, AGENT, noon("2026-09-28")), refused("FNMA_DETERMINATION_RECORDED_BY_HUMAN"));
  const resp = await h.run<{ on_time: boolean; status: string }>("attorney.message.send", { kind: "form200_response", firm_id: "firm-A", state: "FL", response: "no_objection" }, PORTAL_OP, noon("2026-09-28"));
  assert.equal(resp.on_time, true); assert.equal(resp.status, "no_objection"); assert.equal(h.last("FNMA_A4201_FORM200_RESPONSE_15BD").status, "satisfied");
  // No Objection alone does not retain: training (10-05) + LRA (10-06) ⇒ the officer retains on 10-07
  await assert.rejects(h.run("attorney.message.send", { kind: "retain", firm_id: "firm-A", state: "FL" }, OFFICER, noon("2026-10-01")), /status no_objection \(No Objection \+ training \+ LRA required/);
  await h.run("attorney.message.send", { kind: "training_completed", firm_id: "firm-A", state: "FL" }, AGENT, noon("2026-10-05"));
  await h.run("attorney.message.send", { kind: "lra_executed", firm_id: "firm-A", state: "FL", document_id: "doc-lra" }, AGENT, noon("2026-10-06"));
  await assert.rejects(h.run("attorney.message.send", { kind: "retain", firm_id: "firm-A", state: "FL" }, AGENT, noon("2026-10-07")), refused("OFFICER_RETAINS"));
  const ret = await h.run<{ status: string; retained_from: string; review_due: string }>("attorney.message.send", { kind: "retain", firm_id: "firm-A", state: "FL" }, OFFICER, noon("2026-10-07"));
  assert.equal(ret.status, "retained"); assert.equal(ret.retained_from, "2026-10-07"); assert.equal(ret.review_due, "2027-10-07");
  const annual = h.last("SM_FIRM_REVIEW_ANNUAL"); assert.equal(annual.anchorDate, "2026-10-07"); assert.equal(annual.dueDate, "2027-10-07"); assert.equal(annual.status, "armed");
  assert.equal(h.last("FNMA_A4201_RECORDS_7Y").dueDate, "2033-10-07");
  // the referral to the retained firm passes the gate; the firm's ACK within 2 BD closes FNMA_E3205_FIRM_ACK_2BD (13.3) on the referral
  const m = await h.run<{ status: string; ack_due: string; facts: Record<string, boolean> }>("attorney.message.send", { kind: "refer", firm_id: "firm-A", state: "FL", matter_id: "M-1", case_id: "C-1" }, AGENT, noon("2026-10-08"));
  assert.equal(m.status, "referred"); assert.equal(m.ack_due, "2026-10-13"); assert.deepEqual(m.facts, { firm_retained_for_state: true, lra_executed: true, training_done: true, eo_unexpired: true });
  h.events.append({ type: "foreclosure.referral.sent", loanId: LOAN, actor: AGENT, payload: { firm_id: "firm-A", matter_id: "M-1", sent_at: "2026-10-08" } });   // 13.3's referral package
  const ack = h.last("FNMA_E3205_FIRM_ACK_2BD"); assert.equal(ack.dueDate, "2026-10-13"); assert.equal(ack.status, "armed");
  await h.run("attorney.message.send", { kind: "firm_ack", matter_id: "M-1", seq: 1 }, AGENT, noon("2026-10-09"));
  assert.equal(h.last("FNMA_E3205_FIRM_ACK_2BD").status, "satisfied"); assert.equal(h.row("attorney_matters", "M-1")!.status, "acknowledged");
  // a referral to a firm not retained for the state (firm-B, no Form 200) is refused
  await h.run("attorney.message.send", { kind: "firm_candidate", firm_id: "firm-B", legal_name: "B Default Law PA" });
  await assert.rejects(h.run("attorney.message.send", { kind: "refer", firm_id: "firm-B", state: "FL", matter_id: "M-2", case_id: "C-2" }), gateClosed("FNMA_A4201_RETAINED_FIRM_GATE")); assert.equal(h.emitted("foreclosure.gate.refused").at(-1)!.payload.firm_id, "firm-B");
  // E&O renewal evidence closes the expiry clock and re-arms it on the new certificate
  await h.run("attorney.message.send", { kind: "eo_policy", firm_id: "firm-A", annual_foreclosures: 1_200, per_occurrence_cents: 100_000_000n, aggregate_cents: 300_000_000n, expires_on: "2028-06-30", certificate_document_id: "doc-eo-2" }, AGENT, noon("2027-06-01"));
  assert.equal(h.timers.byCode("SM_FIRM_EO_EXPIRY_30")[0]!.status, "satisfied"); assert.equal(h.last("SM_FIRM_EO_EXPIRY_30").dueDate, "2028-05-31");
  assert.throws(() => assertGate("13.6.firmRetainedAndCurrent", { firm_retained_for_state: true, lra_executed: true, training_done: true, eo_unexpired: false }), gateClosed("13.6.firmRetainedAndCurrent"));
});
test("13.6-T3: Given the non-judicial invoice example (A = $2,250; 65% paid), Then approve $450.00 fee, $450.75 costs, reject courier $22.00, and the review record cites E-5-04/-05.", async () => {
  const r = reviewInvoice({ method: "non_judicial", milestone: "first_legal", allowable_cents: 225_000n, previously_paid_cents: 146_250n, costs: [{ kind: "recording", cents: 3_800n, receipt: true }, { kind: "publication", cents: 41_275n, receipt: true }, { kind: "courier", cents: 2_200n, receipt: true }] });
  assert.equal(r.fee_pct, 85); assert.equal(r.fee_earned_cents, 191_250n); assert.equal(r.fee_approved_cents, 45_000n); assert.equal(r.costs_approved_cents, 45_075n); assert.deepEqual(r.rejected, [{ kind: "courier", cents: 2_200n, reason: "overhead" }]);
  assert.ok(r.cites.includes("E-5-04") && r.cites.includes("E-5-05"));
  assert.deepEqual(reviewInvoice({ method: "non_judicial", milestone: "title_reviewed", allowable_cents: 225_000n, previously_paid_cents: 0n, costs: [] }).fee_approved_cents, 146_250n);
  const unknown = reviewInvoice({ method: "non_judicial", milestone: "judgment", allowable_cents: 225_000n, previously_paid_cents: 0n, costs: [], fee_invoiced_cents: 100_000n }); assert.equal(unknown.fee_approved_cents, 0n); assert.equal(unknown.rejected[0]!.kind, "fee_milestone"); assert.match(unknown.rejected[0]!.reason, /not on the E-5-05 non_judicial milestone schedule/);

  // On the bus: the fee basis is the FL/non-judicial schedule (A = $2,250.00) and the matter's paid history ($1,462.50 at
  // title reviewed 65%), never the caller's figures. Receipt Mon 2026-10-12 arms SM_INVOICE_REVIEW_10BD (+10 servicer BD → 10-26);
  // the review's approval arms SM_INVOICE_PAY_30 (+30 days); the AP payment books the corporate advance and closes it.
  const h = harness(noon("2026-09-01")); await retainedFirm(h);
  h.rt.store.put("attorney_fee_schedules", "fs-FL-nj", { state: "FL", method: "non_judicial", allowable_fee_cents: 225_000n, milestones: MILESTONES.non_judicial, exhibit_version: "2026-A", effective_from: "2026-01-01" }, AGENT, h.clock.now());
  await h.run("attorney.message.send", { kind: "refer", firm_id: "firm-A", state: "FL", matter_id: "M-1", case_id: "C-1" }, AGENT, noon("2026-10-08"));
  h.rt.store.put("attorney_invoices", "inv-0", { matter_id: "M-1", loan_id: LOAN, firm_id: "firm-A", status: "paid", fee_approved_cents: 146_250n, milestone: "title_reviewed" }, AGENT, h.clock.now());
  const rec = await h.run<{ review_due: string; status: string }>("invoice.review", { op: "received", invoice_id: "inv-1", matter_id: "M-1", period: "2026-10", lines: [{ kind: "fee_milestone", milestone_code: "first_legal", pct: 85, amount_cents: 45_000n }, { kind: "cost", amount_cents: 3_800n, description: "recording" }, { kind: "cost", amount_cents: 41_275n, description: "publication" }, { kind: "cost", amount_cents: 2_200n, description: "courier" }] }, AGENT, noon("2026-10-12"));
  assert.equal(rec.status, "received"); assert.equal(rec.review_due, "2026-10-26");
  const review10 = h.last("SM_INVOICE_REVIEW_10BD"); assert.equal(review10.anchorDate, "2026-10-12"); assert.equal(review10.dueDate, "2026-10-26"); assert.deepEqual(review10.subject, { kind: "attorney_invoice", id: "inv-1" });
  await assert.rejects(h.run("invoice.review", { invoice_id: "inv-1", matter_id: "M-1", state: "FL", method: "non_judicial", milestone: "first_legal", allowable_cents: 300_000n }), refused("NO_MODEL_FEE_BASIS"));
  await assert.rejects(h.run("invoice.review", { invoice_id: "inv-1", matter_id: "M-1", state: "FL", method: "non_judicial", milestone: "first_legal", approve_rejected: true }), refused("NO_APPROVE_REJECTED_LINE"));
  const out = await h.run<{ fee_pct: number; fee_earned_cents: bigint; fee_approved_cents: bigint; costs_approved_cents: bigint; rejected: { kind: string; cents: bigint; reason: string }[]; cites: string[]; review_result: string; previously_paid_cents: bigint; allowable_cents: bigint; approved_cents: bigint; pay_by: string }>("invoice.review", { invoice_id: "inv-1", matter_id: "M-1", state: "FL", method: "non_judicial", milestone: "first_legal", costs: [{ kind: "recording", cents: 3_800n, receipt: true }, { kind: "publication", cents: 41_275n, receipt: true }, { kind: "courier", cents: 2_200n, receipt: true }] }, AGENT, noon("2026-10-14"));
  assert.equal(out.allowable_cents, 225_000n); assert.equal(out.previously_paid_cents, 146_250n); assert.equal(out.fee_pct, 85); assert.equal(out.fee_earned_cents, 191_250n); assert.equal(out.fee_approved_cents, 45_000n); assert.equal(out.costs_approved_cents, 45_075n);
  assert.deepEqual(out.rejected, [{ kind: "courier", cents: 2_200n, reason: "overhead" }]); assert.deepEqual(out.cites, ["E-5-04", "E-5-05"]); assert.equal(out.review_result, "partially_approved"); assert.equal(out.approved_cents, 90_075n); assert.equal(out.pay_by, "2026-11-13");
  assert.equal(h.last("SM_INVOICE_REVIEW_10BD").status, "satisfied");
  const pay30 = h.last("SM_INVOICE_PAY_30"); assert.equal(pay30.anchorDate, "2026-10-14"); assert.equal(pay30.dueDate, "2026-11-13"); assert.equal(pay30.status, "armed");
  await assert.rejects(h.run("invoice.review", { op: "pay", invoice_id: "inv-1", payment_ref: "ACH-1", paid_cents: 92_275n }, AGENT, noon("2026-10-20")), /payment 92275 ≠ approved 90075/);
  const paid = await h.run<{ status: string; paid_amount_cents: bigint; claimable_cents: bigint; advance: { claim_eligible_cents: bigint; tech_fee_cents: bigint; borrower_chargeable_cents: bigint } }>("invoice.review", { op: "pay", invoice_id: "inv-1", payment_ref: "ACH-1" }, AGENT, noon("2026-10-20"));
  assert.equal(paid.status, "paid"); assert.equal(paid.paid_amount_cents, 90_075n); assert.equal(paid.claimable_cents, 90_075n); assert.deepEqual(paid.advance, { loan_id: LOAN, claim_eligible_cents: 90_075n, tech_fee_cents: 0n, borrower_chargeable_cents: 90_075n });
  assert.equal(h.last("SM_INVOICE_PAY_30").status, "satisfied"); assert.equal(h.emitted("firm.invoice.paid")[0]!.payload.rail, "nacha_ccd");
  const set = h.ledger.sets().at(-1)!; assert.equal(set.lines.length, 2); assert.equal(set.lines[0]!.amountCents, 90_075n); assert.equal(set.lines[0]!.account.account, "corporate_advance"); assert.equal(set.lines[1]!.amountCents, -90_075n); assert.equal(set.lines[0]!.ruleRef, "13.6.E-5-05.pay_firm");
  // the sale held and confirmed on 2026-12-01 is the claim milestone: P360 claim within 60 days (FNMA_F105_EXPENSE_CLAIM_60 → 2027-01-30), filed by the portal operator
  await assert.rejects(h.run("attorney.message.send", { kind: "matter_completed", matter_id: "M-1", outcome: "sale" }, AGENT, noon("2026-12-01")), /post-sale confirmation\/ratification is completed \(E-5-04\)/);
  const done = await h.run<{ claim_due: string }>("attorney.message.send", { kind: "matter_completed", matter_id: "M-1", outcome: "sale", confirmation_completed: true }, AGENT, noon("2026-12-01"));
  assert.equal(done.claim_due, "2027-01-30"); const claim = h.last("FNMA_F105_EXPENSE_CLAIM_60"); assert.equal(claim.anchorDate, "2026-12-01"); assert.equal(claim.dueDate, "2027-01-30"); assert.equal(claim.status, "armed");
  await assert.rejects(h.run("attorney.message.send", { kind: "claim_filed", matter_id: "M-1", claim_id: "P360-1" }, AGENT, noon("2027-01-15")), refused("FNMA_DETERMINATION_RECORDED_BY_HUMAN"));
  const filed = await h.run<{ on_time: boolean; claim_id: string }>("attorney.message.send", { kind: "claim_filed", matter_id: "M-1", claim_id: "P360-1" }, PORTAL_OP, noon("2027-01-15"));
  assert.equal(filed.on_time, true); assert.equal(h.last("FNMA_F105_EXPENSE_CLAIM_60").status, "satisfied"); assert.equal(h.row("attorney_invoices", "inv-1")!.status, "claimed"); assert.equal(h.emitted("claim.filed")[0]!.payload.claimable_cents, 90_075n);
});
test("13.6-T4: Given a bar complaint discovered Monday, Then escalation email sent by Wednesday (2 BD) with POCs; decision record and message id stored.", async () => {
  const r = firmEscalation({ firm_id: "firm-1", category: "bar_complaint", discovered_on: D("2026-09-14"), pocs: ["J. Partner (firm)", "A. Analyst (Supermortgage)"], sent_on: D("2026-09-16") });   // Monday → Wednesday
  assert.equal(r.due, "2026-09-16"); assert.equal(r.timer, "FNMA_A4202_FIRM_ESCALATION_2BD"); assert.equal(r.channel, "email:loanservicing@fanniemae.com"); assert.equal(r.on_time, true); assert.equal(r.pocs.length, 2);
  assert.equal(r.message_id, "msg-firm-1-bar_complaint-2026-09-14"); assert.deepEqual(r.record.decision, { action: "escalate", rule_results: ["A4-2.2-02 within two business days of discovery"] }); assert.equal(r.record.sent_to_fnma_at, "2026-09-16"); assert.equal(r.refusal, null);
  assert.equal(firmEscalation({ firm_id: "firm-1", category: "data_breach", discovered_on: D("2026-09-14"), pocs: ["J. Partner"] }).due, "2026-09-14");
  assert.match(firmEscalation({ firm_id: "firm-1", category: "bar_complaint", discovered_on: D("2026-09-14"), pocs: [] }).refusal!, /points of contact/);

  // On the bus: discovery Mon 2026-09-14 arms FNMA_A4202_FIRM_ESCALATION_2BD (+2 servicer BD → Wed 09-16); the tracked email to
  // loanservicing@fanniemae.com with POCs satisfies it and the row keeps the message id and the decision record.
  const h = harness(noon("2026-09-14"));
  await h.run("attorney.message.send", { kind: "firm_candidate", firm_id: "firm-1", legal_name: "Firm One PA" });
  const disc = await h.run<{ due: string; channel: string; status: string; message_id: string | null }>("attorney.message.send", { kind: "escalation_discovered", firm_id: "firm-1", escalation_id: "esc-1", category: "bar_complaint", discovered_on: "2026-09-14", pocs: ["J. Partner (firm)", "A. Analyst (Supermortgage)"] });
  assert.equal(disc.due, "2026-09-16"); assert.equal(disc.channel, "email:loanservicing@fanniemae.com"); assert.equal(disc.status, "open"); assert.equal(disc.message_id, null);
  const t = h.last("FNMA_A4202_FIRM_ESCALATION_2BD"); assert.equal(t.anchorDate, "2026-09-16", "anchored on the row's computed due (discovery Mon 09-14 + 2 servicer BD)"); assert.equal(t.dueDate, "2026-09-16"); assert.equal(t.status, "armed"); assert.deepEqual(t.subject, { kind: "attorney_escalation", id: "esc-1" });
  // a discovery without points of contact cannot be sent
  await h.run("attorney.message.send", { kind: "escalation_discovered", firm_id: "firm-1", escalation_id: "esc-2", category: "sanction", discovered_on: "2026-09-14", pocs: [] });
  await assert.rejects(h.run("attorney.message.send", { kind: "escalation_sent", escalation_id: "esc-2" }, AGENT, noon("2026-09-15")), /must name points of contact/);
  const sent = await h.run<{ message_id: string; sent_to_fnma_at: string; on_time: boolean; status: string; decision: { action: string; rule_results: string[]; outcome: string; message_id: string } }>("attorney.message.send", { kind: "escalation_sent", escalation_id: "esc-1", message_id: "<20260916.1@sm.example>" }, AGENT, noon("2026-09-16"));
  assert.equal(sent.on_time, true); assert.equal(sent.sent_to_fnma_at, "2026-09-16"); assert.equal(sent.status, "sent"); assert.equal(sent.message_id, "<20260916.1@sm.example>");
  assert.deepEqual(sent.decision, { action: "escalate", rule_results: ["A4-2.2-02 within two business days of discovery"], outcome: "sent", message_id: "<20260916.1@sm.example>" });
  const e = h.emitted("firm.escalation.sent")[0]!; assert.equal(e.payload.to, "loanservicing"); assert.equal(e.payload.email, "loanservicing@fanniemae.com"); assert.deepEqual(e.payload.pocs, ["J. Partner (firm)", "A. Analyst (Supermortgage)"]); assert.equal(e.payload.message_id, "<20260916.1@sm.example>");
  assert.ok(eventMatches(registry.get("FNMA_A4202_FIRM_ESCALATION_2BD")!.satisfiedPattern!, e)); assert.equal(h.inst("FNMA_A4202_FIRM_ESCALATION_2BD", "esc-1").status, "satisfied"); assert.equal(h.inst("FNMA_A4202_FIRM_ESCALATION_2BD", "esc-2").status, "armed");
  assert.equal(h.row("attorney_escalations", "esc-1")!.message_id, "<20260916.1@sm.example>");
  // a data breach is same-day ("or sooner if circumstances warrant"); sent the next day it is late
  await h.run("attorney.message.send", { kind: "escalation_discovered", firm_id: "firm-1", escalation_id: "esc-3", category: "data_breach", discovered_on: "2026-09-21", pocs: ["CISO"] }, AGENT, noon("2026-09-21"));
  assert.equal(h.last("FNMA_A4202_FIRM_ESCALATION_2BD").dueDate, "2026-09-21");
  assert.equal(h.timers.evaluate("2026-09-22T12:00:00.000Z").map((b) => b.instance.code).includes("FNMA_A4202_FIRM_ESCALATION_2BD"), true);
  const late = await h.run<{ on_time: boolean }>("attorney.message.send", { kind: "escalation_sent", escalation_id: "esc-3" }, AGENT, noon("2026-09-22")); assert.equal(late.on_time, false); assert.equal(h.last("FNMA_A4202_FIRM_ESCALATION_2BD").status, "satisfied_late");
});
test("13.6-T5: Given a proposed suspension, Then implementation blocked until 5 BD after Fannie Mae notice with plan.", async () => {
  const blocked = suspensionGate({ proposed_on: D("2026-08-03"), fnma_notified_on: D("2026-08-03"), plan_attached: true, implement_on: D("2026-08-07") }); assert.equal(blocked.earliest, "2026-08-10"); assert.equal(blocked.allowed, false);
  assert.equal(suspensionGate({ proposed_on: D("2026-08-03"), fnma_notified_on: D("2026-08-03"), plan_attached: true, implement_on: D("2026-08-10") }).allowed, true);
  assert.match(suspensionGate({ proposed_on: D("2026-08-03"), fnma_notified_on: null, plan_attached: false, implement_on: D("2026-08-20") }).refusal!, /notified with the transition plan/);

  // On the bus: the proposal (Mon 2026-08-03) arms FNMA_A4204_SUSPENSION_NOTICE_5BD and escalates to the officer with the package;
  // implementation is refused until Fannie Mae has been notified with the plan and 5 servicer BD have run (→ Mon 08-10).
  const h = harness(noon("2026-08-03"));
  await h.run("attorney.message.send", { kind: "firm_candidate", firm_id: "firm-A", legal_name: "A Default Law PA" });
  const prop = await h.run<{ escalation_ids: string[]; gate: string }>("attorney.message.send", { kind: "suspension_proposed", firm_id: "firm-A", reason: "capacity: staffing ratios breached twice", package_document_id: "doc-susp-pkg" });
  assert.equal(prop.escalation_ids.length, 1); assert.equal(prop.gate, "FNMA_A4204_SUSPENSION_NOTICE_5BD"); assert.equal(h.emitted("escalation.created")[0]!.payload.kind, "officer");
  const g = h.last("FNMA_A4204_SUSPENSION_NOTICE_5BD"); assert.equal(g.anchorDate, "2026-08-03"); assert.equal(g.dueDate, "2026-08-10"); assert.equal(g.status, "armed"); assert.deepEqual(g.subject, { kind: "attorney_firm", id: "firm-A" });
  await assert.rejects(h.run("attorney.message.send", { kind: "suspension_implement", firm_id: "firm-A" }, AGENT, noon("2026-08-07")), refused("OFFICER_IMPLEMENTS_SUSPENSION"));
  await assert.rejects(h.run("attorney.message.send", { kind: "suspension_implement", firm_id: "firm-A" }, OFFICER, noon("2026-08-07")), gateClosed("FNMA_A4204_SUSPENSION_NOTICE_5BD"));
  assert.match(String(h.emitted("foreclosure.gate.refused")[0]!.payload.reason), /notified with the transition plan first/);
  // the notice without a plan is not a notice
  await assert.rejects(h.run("attorney.message.send", { kind: "fnma_notified", firm_id: "firm-A", notice_kind: "firm_suspension" }, AGENT, noon("2026-08-03")), /needs the implementation plan/);
  const n = await h.run<{ earliest_implementation: string }>("attorney.message.send", { kind: "fnma_notified", firm_id: "firm-A", notice_kind: "firm_suspension", plan_document_id: "doc-plan", message_id: "<n1@sm>" }, AGENT, noon("2026-08-03"));
  assert.equal(n.earliest_implementation, "2026-08-10");
  const notified = h.emitted("fnma.notified")[0]!; assert.equal(notified.payload.kind, "firm_suspension"); assert.equal(notified.payload.plan_attached, "true"); assert.ok(eventMatches(registry.get("FNMA_A4204_SUSPENSION_NOTICE_5BD")!.satisfiedPattern!, notified));
  assert.equal(h.last("FNMA_A4204_SUSPENSION_NOTICE_5BD").status, "satisfied");
  await assert.rejects(h.run("attorney.message.send", { kind: "suspension_implement", firm_id: "firm-A" }, OFFICER, noon("2026-08-07")), gateClosed("FNMA_A4204_SUSPENSION_NOTICE_5BD"));
  assert.match(String(h.emitted("foreclosure.gate.refused")[1]!.payload.reason), /blocked until 2026-08-10/);
  const done = await h.run<{ status: string; allowed: boolean; earliest: string }>("attorney.message.send", { kind: "suspension_implement", firm_id: "firm-A" }, OFFICER, noon("2026-08-10"));
  assert.equal(done.status, "suspended"); assert.equal(done.allowed, true); assert.equal(done.earliest, "2026-08-10"); assert.equal(h.emitted("firm.suspended")[0]!.payload.referrals_stopped, true);
  assert.equal(h.emitted("firm.selection.decided").at(-1)!.payload.decision, "suspended"); assert.equal(h.last("FNMA_A4201_RECORDS_7Y").dueDate, "2033-08-10");
});
test("13.6-T6: Given the 30th transfer in 6 months from Firm A to Firm B in Florida, Then the 5-BD notice gate blocks the transfer until notified.", async () => {
  const blocked = matterTransferGate({ state: "FL", from_firm: "A", to_firm: "B", transfers_in_6m_including_this: 30, transfer_on: D("2026-10-01") });
  assert.equal(blocked.notice_required, true); assert.equal(blocked.gate, "FNMA_E1101_BULK_TRANSFER_NOTICE_5BD"); assert.equal(blocked.allowed, false); assert.match(blocked.refusal!, /30th in 6 months — blocked until Fannie Mae is notified/);
  const notified = matterTransferGate({ state: "FL", from_firm: "A", to_firm: "B", transfers_in_6m_including_this: 30, fnma_notified_on: D("2026-09-24"), transfer_on: D("2026-10-01") }); assert.equal(notified.earliest, "2026-10-01"); assert.equal(notified.allowed, true);
  assert.equal(matterTransferGate({ state: "FL", from_firm: "A", to_firm: "B", transfers_in_6m_including_this: 30, fnma_notified_on: D("2026-09-24"), transfer_on: D("2026-09-30") }).allowed, false);
  assert.equal(matterTransferGate({ state: "FL", from_firm: "A", to_firm: "B", transfers_in_6m_including_this: 29, transfer_on: D("2026-10-01") }).allowed, true); assert.equal(transferNoticeGate(30), true); assert.equal(transferNoticeGate(29), false);
  assert.equal(matterTransferGate({ state: "FL", from_firm: "A", to_firm: "B", transfers_in_6m_including_this: 1, transfer_on: D("2026-10-01"), post_sale: true }).gate, "FNMA_E1101_POST_SALE_TRANSFER_APPROVAL_GATE");

  // On the bus: 29 A→B Florida transfers since April sit on attorney_matters; the 30th request (Thu 2026-09-24) arms
  // FNMA_E1101_BULK_TRANSFER_NOTICE_5BD on the lane; the transfer is refused until fnma.notified{kind=bulk_matter_transfer}
  // and 5 servicer BD have run (09-24 → 10-01).
  const h = harness(noon("2026-09-01")); await retainedFirm(h, "firm-A", "FL"); const lane = transferLane("firm-A", "firm-B", "FL");
  await h.run("attorney.message.send", { kind: "firm_candidate", firm_id: "firm-B", legal_name: "B Default Law PA" });
  for (let n = 1; n <= 29; n++) h.rt.store.put("attorney_matters", `M-old-${n}`, { loan_id: `L-old-${n}`, firm_id: "firm-A", state: "FL", kind: "foreclosure", status: "transferred", transfer_lane: lane, transfer_requested_on: n <= 3 ? "2026-03-15" : "2026-05-15" }, AGENT, h.clock.now());   // 3 fall outside the 6-month window
  for (let n = 1; n <= 3; n++) h.rt.store.put("attorney_matters", `M-apr-${n}`, { loan_id: `L-apr-${n}`, firm_id: "firm-A", state: "FL", kind: "foreclosure", status: "transferred", transfer_lane: lane, transfer_requested_on: "2026-04-20" }, AGENT, h.clock.now());
  await h.run("attorney.message.send", { kind: "refer", firm_id: "firm-A", state: "FL", matter_id: "M-30", case_id: "C-30" }, AGENT, noon("2026-10-08"));
  const req = await h.run<{ lane: string; transfers_in_6m: number; bulk_threshold_reached: boolean; post_sale: boolean; gate: string; escalation_ids: string[] }>("attorney.message.send", { kind: "matter_transfer_requested", matter_id: "M-30", to_firm: "firm-B", reason: "capacity" }, AGENT, noon("2026-09-24"));
  assert.equal(req.lane, "firm-A>firm-B:FL"); assert.equal(req.transfers_in_6m, 30); assert.equal(req.bulk_threshold_reached, true); assert.equal(req.post_sale, false); assert.equal(req.gate, "FNMA_E1101_BULK_TRANSFER_NOTICE_5BD"); assert.equal(req.escalation_ids.length, 1);
  const g = h.last("FNMA_E1101_BULK_TRANSFER_NOTICE_5BD"); assert.equal(g.status, "armed"); assert.deepEqual(g.subject, { kind: "firm_transfer_lane", id: "firm-A>firm-B:FL" });
  await assert.rejects(h.run("attorney.message.send", { kind: "matter_transfer", matter_id: "M-30", new_matter_id: "M-30b" }, AGENT, noon("2026-10-01")), gateClosed("FNMA_E1101_BULK_TRANSFER_NOTICE_5BD"));
  assert.match(String(h.emitted("foreclosure.gate.refused")[0]!.payload.reason), /30th in 6 months — blocked until Fannie Mae is notified 5 BD ahead/);
  await h.run("attorney.message.send", { kind: "fnma_notified", firm_id: "firm-A", notice_kind: "bulk_matter_transfer", lane: "firm-A>firm-B:FL", message_id: "<bulk@sm>" }, AGENT, noon("2026-09-24"));
  assert.equal(h.last("FNMA_E1101_BULK_TRANSFER_NOTICE_5BD").status, "satisfied"); assert.equal(h.emitted("fnma.notified")[0]!.payload.earliest_implementation, "2026-10-01");
  await assert.rejects(h.run("attorney.message.send", { kind: "matter_transfer", matter_id: "M-30", new_matter_id: "M-30b" }, AGENT, noon("2026-09-30")), gateClosed("FNMA_E1101_BULK_TRANSFER_NOTICE_5BD"));
  const t = await h.run<{ status: string; new_matter_id: string; transfer: { transferee_fee_cap_cents: bigint | null; transfer_fees_to_fnma_or_borrower_cents: bigint } }>("attorney.message.send", { kind: "matter_transfer", matter_id: "M-30", new_matter_id: "M-30b" }, AGENT, noon("2026-10-01"));
  assert.equal(t.status, "transferred"); assert.equal(t.new_matter_id, "M-30b"); assert.equal(t.transfer.transfer_fees_to_fnma_or_borrower_cents, 0n); assert.equal(h.row("attorney_matters", "M-30b")!.firm_id, "firm-B"); assert.equal(h.row("attorney_matters", "M-30b")!.transferred_from_matter_id, "M-30");
  assert.equal(h.emitted("matter.transferred")[0]!.payload.lane, "firm-A>firm-B:FL");
  // the 31st needs no new notice inside the window; a post-sale transfer is a different gate: Fannie Mae's prior approval (officer-recorded)
  await h.run("attorney.message.send", { kind: "refer", firm_id: "firm-A", state: "FL", matter_id: "M-31", case_id: "C-31" }, AGENT, noon("2026-10-08"));
  h.rt.store.put("attorney_matters", "M-31", { sale_held: true }, AGENT, h.clock.now());
  const ps = await h.run<{ gate: string; post_sale: boolean }>("attorney.message.send", { kind: "matter_transfer_requested", matter_id: "M-31", to_firm: "firm-B", reason: "eviction counsel" }, AGENT, noon("2026-10-09"));
  assert.equal(ps.gate, "FNMA_E1101_POST_SALE_TRANSFER_APPROVAL_GATE"); assert.equal(ps.post_sale, true); assert.equal(h.last("FNMA_E1101_POST_SALE_TRANSFER_APPROVAL_GATE").note, "evaluator:13.6.fannieMaePriorApproval");
  await assert.rejects(h.run("attorney.message.send", { kind: "matter_transfer", matter_id: "M-31", new_matter_id: "M-31b" }, AGENT, noon("2026-10-12")), gateClosed("13.6.fannieMaePriorApproval"));
  await assert.rejects(h.run("attorney.message.send", { kind: "transfer_approval", matter_id: "M-31", document_id: "doc-fnma-ok" }, AGENT, noon("2026-10-12")), refused("TRANSFER_APPROVAL_RECORDED_BY_OFFICER"));
  await h.run("attorney.message.send", { kind: "transfer_approval", matter_id: "M-31", document_id: "doc-fnma-ok" }, OFFICER, noon("2026-10-12"));
  assert.equal((await h.run<{ status: string }>("attorney.message.send", { kind: "matter_transfer", matter_id: "M-31", new_matter_id: "M-31b" }, AGENT, noon("2026-10-13"))).status, "transferred");
});
test('13.6-T7: Given a `POSTPONE_SALE` instruction acknowledged but no DRA "sale postponed" event after 2 BD, Then exception raised, firm call task, and 13.5 credit marked "DRA unverified."', async () => {
  const r = draPostponementCheck({ acknowledged_on: D("2026-10-21"), dra_event_on: null, today: D("2026-10-26") });
  assert.equal(r.expected_by, "2026-10-23"); assert.equal(r.exception, true); assert.equal(r.firm_call_task, true); assert.equal(r.credit_status, "DRA unverified");
  assert.equal(draPostponementCheck({ acknowledged_on: D("2026-10-21"), dra_event_on: D("2026-10-22"), today: D("2026-10-26") }).credit_status, "verified");
  const recon = reconcileDra({ expectations: [{ matter_id: "M-1", loan_id: LOAN, instruction: "POSTPONE_SALE", expected_event: "sale postponed", event_date: D("2026-10-21"), expected_by: D("2026-10-23"), matched_on: null }], dra_rows: [], today: D("2026-10-26") });
  assert.equal(recon.exceptions.length, 1); assert.equal(recon.exceptions[0]!.reason, "missing"); assert.equal(recon.events[0]!.type, "dra.exception.raised"); assert.equal(recon.events[0]!.payload.credit_status, "DRA unverified"); assert.equal(recon.escalations[0]!.escalation.kind, "human_agent");
  assert.equal(reconcileDra({ expectations: recon.exceptions.length ? [{ matter_id: "M-1", loan_id: LOAN, instruction: "POSTPONE_SALE", expected_event: "sale postponed", event_date: D("2026-10-21"), expected_by: D("2026-10-23"), matched_on: null }] : [], dra_rows: [{ loan_id: LOAN, event_name: "sale postponed", event_date: D("2026-10-22"), entered_by_firm: "firm-A" }], today: D("2026-10-26") }).matched[0]!.difference_days, 1);

  // On the bus: the firm's ACK of POSTPONE_SALE on Wed 2026-10-21 arms SM_DRA_EVENT_EXPECTED_2BD (+2 servicer BD → Fri 10-23); the
  // portal operator's export on Mon 10-26 shows no "sale postponed" ⇒ dra.exception.raised, the human_agent firm-call task and the
  // loan's 13.5 credit flagged "DRA unverified"; a later export carrying the event (dated 10-22) matches and resolves it.
  const h = harness(noon("2026-09-01")); await retainedFirm(h);
  await h.run("attorney.message.send", { kind: "refer", firm_id: "firm-A", state: "FL", matter_id: "M-1", case_id: "C-1" }, AGENT, noon("2026-10-08"));
  h.rt.store.put("fc_delay_credits", "cr-1", { loan_id: LOAN, case_id: "C-1", category: "bankruptcy", begin_on: "2026-10-01", reported_timely: true }, AGENT, h.clock.now());
  const noDra = await h.run<{ expected_dra_event: string | null; timer: string | null }>("attorney.message.send", { kind: "instruction_ack", matter_id: "M-1", instruction: "STATUS_DEMAND" }, AGENT, noon("2026-10-20"));
  assert.equal(noDra.expected_dra_event, null); assert.equal(noDra.timer, null); assert.equal(h.timers.byCode("SM_DRA_EVENT_EXPECTED_2BD").length, 0, "an instruction with no DRA counterpart arms nothing");
  const ack = await h.run<{ expected_dra_event: string; expected_by: string; timer: string }>("attorney.message.send", { kind: "instruction_ack", matter_id: "M-1", instruction: "POSTPONE_SALE", seq: 7 }, AGENT, noon("2026-10-21"));
  assert.equal(ack.expected_dra_event, "sale postponed"); assert.equal(ack.expected_by, "2026-10-23"); assert.equal(ack.timer, "SM_DRA_EVENT_EXPECTED_2BD");
  const t = h.last("SM_DRA_EVENT_EXPECTED_2BD"); assert.equal(t.anchorDate, "2026-10-21"); assert.equal(t.dueDate, "2026-10-23"); assert.equal(t.status, "armed"); assert.deepEqual(t.subject, { kind: "loan", id: LOAN });
  // Fri 10-23: the export still inside the window raises nothing
  const early = await h.run<{ reconciliation: { matched: number; exceptions: string[] } }>("dra.snapshot.import", { firm_id: "firm-A", as_of: "2026-10-23", rows: [{ loan_id: LOAN, event_name: "referral received", event_date: "2026-10-08", entered_by_firm: "firm-A" }] }, PORTAL_OP, noon("2026-10-23"));
  assert.deepEqual(early.reconciliation, { matched: 0, exceptions: [], escalation_ids: [] });
  assert.equal(h.timers.evaluate("2026-10-24T04:00:00.000Z")[0]!.instance.code, "SM_DRA_EVENT_EXPECTED_2BD");
  const imp = await h.run<{ row_count: number; reconciliation: { matched: number; exceptions: string[]; escalation_ids: string[] } }>("dra.snapshot.import", { firm_id: "firm-A", as_of: "2026-10-26", rows: [{ loan_id: LOAN, event_name: "referral received", event_date: "2026-10-08", entered_by_firm: "firm-A" }] }, PORTAL_OP, noon("2026-10-26"));
  assert.equal(imp.row_count, 1); assert.deepEqual(imp.reconciliation.exceptions, ["M-1:sale postponed:2026-10-23"]); assert.equal(imp.reconciliation.escalation_ids.length, 1);
  const ex = h.row("dra_reconciliation_exceptions", "M-1:sale postponed:2026-10-23")!; assert.equal(ex.found, false); assert.equal(ex.reason, "missing"); assert.equal(ex.credit_status, "DRA unverified"); assert.equal(ex.resolved_at, null);
  const task = h.emitted("escalation.created").at(-1)!; assert.equal(task.payload.kind, "human_agent"); assert.equal(task.payload.task, "firm_call"); assert.equal(task.payload.credit_status, "DRA unverified"); assert.match(String(task.payload.reason), /call the firm/);
  assert.equal(h.row("fc_delay_credits", "cr-1")!.dra_status, "DRA unverified"); assert.equal(h.row("fc_delay_credits", "cr-1")!.dra_verified, false);
  assert.equal(h.emitted("dra.exception.raised")[0]!.payload.expected_event, "sale postponed"); assert.equal(h.emitted("dra.snapshot.imported").length, 2); assert.equal(h.last("SM_DRA_RECONCILE_DAILY" + "").status, "armed", "the daily import re-arms the recurring row");
  // the same open exception is not raised twice by the next export; the event entered on 10-22 matches (±1 day) and resolves it
  await h.run("dra.snapshot.import", { firm_id: "firm-A", as_of: "2026-10-27", rows: [] }, PORTAL_OP, noon("2026-10-27")); assert.equal(h.emitted("dra.exception.raised").length, 1);
  const fixed = await h.run<{ reconciliation: { matched: number } }>("dra.snapshot.import", { firm_id: "firm-A", as_of: "2026-10-28", rows: [{ loan_id: LOAN, event_name: "Sale Postponed", event_date: "2026-10-22", entered_by_firm: "firm-A" }] }, PORTAL_OP, noon("2026-10-28"));
  assert.equal(fixed.reconciliation.matched, 1); assert.equal(h.emitted("dra.event.matched")[0]!.payload.difference_days, 1); assert.equal(h.last("SM_DRA_EVENT_EXPECTED_2BD").status, "satisfied_late"); assert.ok(h.row("dra_reconciliation_exceptions", "M-1:sale postponed:2026-10-23")!.resolved_at); assert.equal(h.emitted("dra.exception.resolved").length, 1);
});
test('13.6-T8: Given a matter completed through confirmation, Then 100% fee approved; before confirmation the 95% cap holds ("cannot be considered to be earned until ... confirmation").', async () => {
  const done = feeApproval({ method: "non_judicial", milestone: "confirmation", allowable_cents: 225_000n }); assert.equal(done.pct, 100); assert.equal(done.approved_cents, 225_000n); assert.equal(done.note, null);
  const held = feeApproval({ method: "non_judicial", milestone: "sale_held", allowable_cents: 225_000n }); assert.equal(held.pct, 95); assert.equal(held.approved_cents, 213_750n); assert.match(held.note!, /cannot be considered to be earned until/);
  // E-5-05 schedule: sale held / documents recorded is the 100% step in both methods; E-5-04 holds it at the prior 95% step until post-sale confirmation/ratification completes (or where none is required)
  assert.equal(milestonePct("judicial", "sale_held"), 100); assert.equal(milestonePct("non_judicial", "sale_held"), 100); assert.equal(MILESTONES.judicial.bid_confirmed, 95); assert.equal(MILESTONES.non_judicial.sale_package, 95);
  assert.equal(feeApproval({ method: "judicial", milestone: "sale_held", allowable_cents: 225_000n, confirmation: "completed" }).pct, 100); assert.equal(feeApproval({ method: "non_judicial", milestone: "sale_held", allowable_cents: 225_000n, confirmation: "not_required" }).approved_cents, 225_000n);
  assert.deepEqual(Object.values(MILESTONES.judicial), [30, 40, 50, 60, 70, 80, 90, 95, 100]); assert.deepEqual(Object.values(MILESTONES.non_judicial), [30, 65, 75, 85, 95, 100]);

  // On the bus: the firm's "sale held" invoice before confirmation is capped at 95% of A ($2,137.50); once the matter is completed
  // through confirmation the review approves the remaining 5% ($112.50) — 100% in total, never prorated between milestones.
  const h = harness(noon("2026-09-01")); await retainedFirm(h);
  h.rt.store.put("attorney_fee_schedules", "fs-FL-nj", { state: "FL", method: "non_judicial", allowable_fee_cents: 225_000n, milestones: MILESTONES.non_judicial, exhibit_version: "2026-A", effective_from: "2026-01-01" }, AGENT, h.clock.now());
  await h.run("attorney.message.send", { kind: "refer", firm_id: "firm-A", state: "FL", matter_id: "M-1", case_id: "C-1" }, AGENT, noon("2026-10-08"));
  await h.run("invoice.review", { op: "received", invoice_id: "inv-sale", matter_id: "M-1", lines: [{ kind: "fee_milestone", milestone_code: "sale_held", amount_cents: 225_000n }] }, AGENT, noon("2026-12-02"));
  const capped = await h.run<{ fee_pct: number; fee_approved_cents: bigint; review_result: string }>("invoice.review", { invoice_id: "inv-sale", matter_id: "M-1", state: "FL", method: "non_judicial", milestone: "sale_held", fee_invoiced_cents: 225_000n }, AGENT, noon("2026-12-03"));
  assert.equal(capped.fee_pct, 95); assert.equal(capped.fee_approved_cents, 213_750n); assert.equal(capped.review_result, "partially_approved");
  assert.match(String(h.row("attorney_invoices", "inv-sale")!.rejected && (h.row("attorney_invoices", "inv-sale")!.rejected as { reason: string }[])[0]!.reason), /exceeds the 95% cumulative schedule at sale_held/);
  await h.run("invoice.review", { op: "pay", invoice_id: "inv-sale", payment_ref: "ACH-9" }, AGENT, noon("2026-12-10"));
  await h.run("attorney.message.send", { kind: "matter_completed", matter_id: "M-1", outcome: "sale", confirmation_completed: true }, AGENT, noon("2027-01-05"));
  await h.run("invoice.review", { op: "received", invoice_id: "inv-final", matter_id: "M-1", lines: [{ kind: "fee_milestone", milestone_code: "sale_held", amount_cents: 11_250n }] }, AGENT, noon("2027-01-06"));
  const full = await h.run<{ fee_pct: number; fee_earned_cents: bigint; previously_paid_cents: bigint; fee_approved_cents: bigint; review_result: string }>("invoice.review", { invoice_id: "inv-final", matter_id: "M-1", state: "FL", method: "non_judicial", milestone: "sale_held", confirmation: "completed", fee_invoiced_cents: 11_250n }, AGENT, noon("2027-01-07"));
  assert.equal(full.fee_pct, 100); assert.equal(full.fee_earned_cents, 225_000n); assert.equal(full.previously_paid_cents, 213_750n); assert.equal(full.fee_approved_cents, 11_250n); assert.equal(full.review_result, "approved");
  assert.equal(h.emitted("firm.invoice.approved").map((e) => e.payload.approved_cents as bigint).reduce((a, b) => a + b, 0n), 225_000n);
});
test("13.6-T9: Given technology fees invoiced $30 for one loan, Then $25 cap applied, $5 rejected, none charged to the borrower.", async () => {
  const r = reviewInvoice({ method: "judicial", milestone: "service_complete", allowable_cents: 225_000n, previously_paid_cents: 0n, costs: [], tech_fee_cents: 3_000n });
  assert.equal(r.tech_fee_approved_cents, 2_500n); assert.deepEqual(r.rejected, [{ kind: "technology_fee", cents: 500n, reason: "$25 cap" }]); assert.equal(r.borrower_chargeable_tech_fee_cents, 0n); assert.ok(r.cites.includes("E-5-06"));
  assert.equal(reviewInvoice({ method: "judicial", milestone: "service_complete", allowable_cents: 225_000n, previously_paid_cents: 0n, costs: [], tech_fee_cents: 2_500n }).rejected.length, 0);

  // On the bus: the $30.00 technology fee is approved at $25.00, $5.00 rejected, the borrower-chargeable technology fee is $0 and the
  // payment books the $25.00 as a corporate advance {tech_fee} — separate from the borrower-chargeable fee/cost advance.
  const h = harness(noon("2026-09-01")); await retainedFirm(h, "firm-A", "IL");
  h.rt.store.put("attorney_fee_schedules", "fs-IL-j", { state: "IL", method: "judicial", allowable_fee_cents: 225_000n, milestones: MILESTONES.judicial, exhibit_version: "2026-A", effective_from: "2026-01-01" }, AGENT, h.clock.now());
  await h.run("attorney.message.send", { kind: "refer", firm_id: "firm-A", state: "IL", matter_id: "M-9", case_id: "C-9" }, AGENT, noon("2026-10-08"));
  await h.run("invoice.review", { op: "received", invoice_id: "inv-9", matter_id: "M-9", lines: [{ kind: "fee_milestone", milestone_code: "service_complete", amount_cents: 157_500n }, { kind: "tech_fee", amount_cents: 3_000n }] }, AGENT, noon("2026-11-02"));
  const out = await h.run<{ tech_fee_approved_cents: bigint; borrower_chargeable_tech_fee_cents: bigint; borrower_chargeable_cents: bigint; rejected: { kind: string; cents: bigint; reason: string }[]; cites: string[]; approved_cents: bigint }>("invoice.review", { invoice_id: "inv-9", matter_id: "M-9", state: "IL", method: "judicial", milestone: "service_complete", tech_fee_cents: 3_000n }, AGENT, noon("2026-11-03"));
  assert.equal(out.tech_fee_approved_cents, 2_500n); assert.deepEqual(out.rejected, [{ kind: "technology_fee", cents: 500n, reason: "$25 cap" }]); assert.equal(out.borrower_chargeable_tech_fee_cents, 0n); assert.equal(out.borrower_chargeable_cents, 157_500n); assert.ok(out.cites.includes("E-5-06")); assert.equal(out.approved_cents, 160_000n);
  const paid = await h.run<{ advance: { claim_eligible_cents: bigint; tech_fee_cents: bigint; borrower_chargeable_cents: bigint } }>("invoice.review", { op: "pay", invoice_id: "inv-9", payment_ref: "ACH-9" }, AGENT, noon("2026-11-10"));
  assert.deepEqual(paid.advance, { loan_id: LOAN, claim_eligible_cents: 157_500n, tech_fee_cents: 2_500n, borrower_chargeable_cents: 157_500n });
  const set = h.ledger.sets().at(-1)!; assert.equal(set.lines.length, 3); assert.equal(set.lines[1]!.amountCents, 2_500n); assert.equal(set.lines[1]!.ruleRef, "13.6.E-5-06.tech_fee"); assert.match(set.lines[1]!.memo!, /never borrower-chargeable/); assert.equal(set.lines[2]!.amountCents, -160_000n);
  assert.equal(h.last("SM_INVOICE_PAY_30").status, "satisfied");
});
test("13.6-T10: Given a firm scorecard in the bottom band two months running, Then risk-triggered review scheduled and `officer` informed.", async () => {
  const r = scorecardReview([{ month: "2026-07", band: "middle" }, { month: "2026-08", band: "bottom" }, { month: "2026-09", band: "bottom" }]);
  assert.equal(r.trigger, true); assert.deepEqual(r.review, { kind: "risk_triggered", scheduled: true }); assert.equal(r.escalation!.kind, "officer");
  assert.equal(scorecardReview([{ month: "2026-08", band: "bottom" }, { month: "2026-09", band: "middle" }]).trigger, false);

  // On the bus: the August scorecard (bottom) triggers nothing; September's second bottom month schedules the risk-triggered review
  // (firm.review.scheduled, attorney_reviews row) and informs the officer; the completed review (all fifteen A4-2.2-02 elements
  // evidenced) satisfies SM_FIRM_REVIEW_ANNUAL, which re-arms for the next cycle.
  const h = harness(noon("2026-09-01")); await retainedFirm(h);
  const aug = await h.run<{ review_triggered: boolean; escalation_ids: string[] }>("attorney.message.send", { kind: "scorecard", firm_id: "firm-A", state: "FL", month: "2026-08", band: "bottom", metrics: { ack_timeliness: 0.71 } }, AGENT, noon("2026-11-03"));
  assert.equal(aug.review_triggered, false); assert.deepEqual(aug.escalation_ids, []);
  const sep = await h.run<{ review_triggered: boolean; review: { kind: string; scheduled: boolean } | null; escalation_ids: string[] }>("attorney.message.send", { kind: "scorecard", firm_id: "firm-A", state: "FL", month: "2026-09", band: "bottom", metrics: { ack_timeliness: 0.65 } }, AGENT, noon("2026-11-03"));
  assert.equal(sep.review_triggered, true); assert.deepEqual(sep.review, { kind: "risk_triggered", scheduled: true }); assert.equal(sep.escalation_ids.length, 1);
  const inform = h.emitted("escalation.created").at(-1)!; assert.equal(inform.payload.kind, "officer"); assert.equal(inform.payload.severity, "sev3"); assert.match(String(inform.payload.reason), /bottom band for 2026-08 and 2026-09/);
  const sched = h.emitted("firm.review.scheduled")[0]!; assert.equal(sched.payload.kind, "risk_triggered"); assert.equal(sched.payload.scheduled_for, "2026-11-18");   // 10 servicer BD from Tue 11-03 (Veterans Day 11-11 skipped) assert.equal(h.row("attorney_reviews", "firm-A:risk:2026-09")!.kind, "risk_triggered");
  // the review cannot complete without all fifteen elements evidenced; with them it closes the annual clock and re-arms it
  await assert.rejects(h.run("attorney.message.send", { kind: "review_completed", firm_id: "firm-A", review_id: "rev-1", review_kind: "risk_triggered", elements: { eligibility: { result: "pass", evidence_document_id: "doc-1" } }, findings: [] }, AGENT, noon("2026-11-17")), /must evidence all fifteen A4-2.2-02 elements; missing: retention_agreement/);
  await assert.rejects(h.run("attorney.message.send", { kind: "review_completed", firm_id: "firm-A", review_id: "rev-1", review_kind: "risk_triggered", elements: elements(), findings: ["staffing ratio above policy"] }, AGENT, noon("2026-11-17")), /needs a remediation plan/);
  const annualBefore = h.last("SM_FIRM_REVIEW_ANNUAL"); assert.equal(annualBefore.dueDate, "2027-10-07"); assert.equal(annualBefore.status, "armed");
  const done = await h.run<{ next_review_due: string; findings: string[] }>("attorney.message.send", { kind: "review_completed", firm_id: "firm-A", review_id: "rev-1", review_kind: "risk_triggered", elements: elements(), findings: ["staffing ratio above policy"], remediation_plan_document_id: "doc-rem" }, AGENT, noon("2026-11-17"));
  assert.equal(done.next_review_due, "2027-05-17"); assert.deepEqual(done.findings, ["staffing ratio above policy"]);
  assert.equal(h.timers.byCode("SM_FIRM_REVIEW_ANNUAL")[0]!.status, "satisfied"); assert.equal(h.timers.byCode("SM_FIRM_REVIEW_ANNUAL").length, 2); assert.equal(h.last("SM_FIRM_REVIEW_ANNUAL").status, "armed");
  assert.deepEqual(h.emitted("firm.review.completed")[0]!.payload.findings, ["staffing ratio above policy"]);
});

test("13.6 worked figures: allowable A = $2,250.00; first legal 85% → $1,912.50 earned; 65% paid ($1,462.50) → approve $450.00; recording $38.00 and publication $412.75 approved; courier $22.00 rejected", () => {
  assert.equal(feeEarned("non_judicial", "first_legal", 225000n), 191250n); assert.equal((225000n * 65n) / 100n, 146250n);
  const r = reviewInvoice({ method: "non_judicial", milestone: "first_legal", allowable_cents: 225000n, previously_paid_cents: 146250n, costs: [{ kind: "recording", cents: 3800n, receipt: true }, { kind: "publication", cents: 41275n, receipt: true }, { kind: "courier", cents: 2200n, receipt: true }] });
  assert.equal(r.fee_approved_cents, 45000n); assert.equal(r.costs_approved_cents, 45075n); assert.deepEqual(r.rejected.map((x) => [x.kind, x.cents]), [["courier", 2200n]]);
});
