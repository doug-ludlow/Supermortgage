// 13.2 Dual-tracking restriction
// spec/sections/13-foreclosure/13-2-dual-tracking-restriction.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { holdExitAndCertification, pendingMotion, mnReferralGate, unacknowledgedPostponement, certificationDmdcCheck, rescissionAfterViolation, dualTrackHoldOpen, performingHold, protectionSnapshot } from "./ops.ts";
import { stepAllowed, certificationWindow, tierAtReceipt } from "./gates.ts";
import { appealWindowSweep, recordSaleInstruction, SALE_CERT_DOCUMENT } from "./ops-13-2.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { CommandBus } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { SECTION_13_TOOLS } from "../../app/tools/section13.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";

const AGENT: Actor = { kind: "agent", id: "foreclosure-ops" };
/** The 13.2 tools on the bus (the pattern of ./13-tools.test.ts): an in-memory store, event log and TimerEngine over the overridden registry. */
function harness(now: string, loanId = "L-132") {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock); const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["13.2"] });
  const ctx: UowContext = { loanId, events, ledger: new MemoryLedger(), timers, clock, decide: () => {} };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, SECTION_13_TOOLS); const bus = new CommandBus(agents);
  const run = (name: string, actor: Actor, input: Record<string, unknown>, at?: string) => bus.execute(cmds.get(toolKey("13.2", name))!, actor, input, ctx, at ? { now: at } : {});
  return { ctx, rt, run, events, timers, clock };
}

test("13.2-T1: Given first filing Aug. 1 and sale Nov. 3, When a complete application is received Sept. 25, Then hold `regx_g_dual_track` opens, tier `g_37_to_89`, instruction `HOLD_DISPOSITIVE` sent within 1 BD and acknowledged.", () => {
  const r = dualTrackHoldOpen({ first_notice_filed_on: D("2026-08-01"), sale_on: D("2026-11-03"), received_on: D("2026-09-25"), acknowledged_on: D("2026-09-28") });
  assert.equal(r.hold!.kind, "regx_g_dual_track"); assert.deepEqual(r.hold!.scope, ["judgment_motion", "sale_schedule", "sale_conduct"]); assert.equal(r.hold!.rule_citation, "12 CFR 1024.41(g)");
  assert.equal(r.tier.regx, "g_37_to_89"); assert.equal(r.tier.days_before_sale, 39); assert.equal(r.tier.acceptance_days, 7); assert.equal(r.tier.appeal, false);
  assert.deepEqual(r.instruction, { kind: "HOLD_DISPOSITIVE", to: "firm", due: "2026-09-28", sent: true }); assert.equal(r.timer, "REGX_1024_41G_INSTRUCT_COUNSEL_1BD"); assert.equal(r.acknowledged, true);
  assert.equal(dualTrackHoldOpen({ first_notice_filed_on: D("2026-08-01"), sale_on: D("2026-11-03"), received_on: D("2026-09-25"), acknowledged_on: D("2026-09-30") }).acknowledged, false);
  assert.equal(stepAllowed("judgment_motion", ["hold_evaluation"]), false); assert.equal(stepAllowed("service_of_process", ["hold_evaluation"]), true);
});
test(`13.2-T2: Given T1 and a determination "ineligible" sent Oct. 10 with no appeal right (tier <90), Then hold closes Oct. 10; certification permitted inside Oct. 19–27.`, () => {
  const r = holdExitAndCertification({ determination_sent_on: D("2026-10-10"), appeal_available: false, sale_on: D("2026-11-03"), certify_on: D("2026-10-20") });
  assert.equal(r.hold_closes_on, "2026-10-10"); assert.deepEqual(r.window, { opens: "2026-10-19", closes: "2026-10-27" }); assert.equal(r.certification_permitted, true);
  assert.equal(holdExitAndCertification({ determination_sent_on: D("2026-10-10"), appeal_available: false, sale_on: D("2026-11-03"), certify_on: D("2026-10-28") }).certification_permitted, false);
  assert.equal(holdExitAndCertification({ determination_sent_on: D("2026-10-10"), appeal_available: false, sale_on: D("2026-11-03"), certify_on: D("2026-10-18") }).certification_permitted, false);
  // with appeal rights (tier ≥90) the hold closes the day after the 14-day window — determination + 15, the same "window expiry" day as 13.1-T5 — or on an earlier denial
  const appeal = holdExitAndCertification({ determination_sent_on: D("2026-10-10"), appeal_available: true, sale_on: D("2026-11-03"), certify_on: D("2026-10-24") }); assert.equal(appeal.hold_closes_on, "2026-10-25"); assert.equal(appeal.certification_permitted, false);
  assert.equal(holdExitAndCertification({ determination_sent_on: D("2026-10-10"), appeal_available: true, sale_on: D("2026-11-03"), certify_on: D("2026-10-25") }).certification_permitted, true);
  assert.equal(holdExitAndCertification({ determination_sent_on: D("2026-10-10"), appeal_available: true, appeal_denied_on: D("2026-10-20"), sale_on: D("2026-11-03"), certify_on: D("2026-10-20") }).hold_closes_on, "2026-10-20");
  // On the platform: the sale scheduled Nov. 3 arms FNMA_E3302_SALE_CERT_WINDOW_7_15 (window opens sale − 15 = Oct. 19, closes sale − 7 = Oct. 27); the (g)(1) exit — ineligible notice, appeal process not applicable — closes the
  // hold on the event log dated Oct. 10 (`appealWindowSweep`, idempotent); the §1024.41(g) gate reads open on that exit; the CERTIFY_SALE instruction on Oct. 20 emits `foreclosure.sale.certified`, which satisfies the window timer.
  const clock = new FixedClock("2026-10-10T12:00:00.000Z"); const events = new MemoryEventStore(clock); const registry = loadOverriddenRegistry(); const timers = new TimerEngine(registry, events, { processes: ["13.2"] });
  events.append({ type: "foreclosure.sale.scheduled", loanId: "L-132", actor: AGENT, payload: { sale_at: "2026-11-03", source: "firm_message" } });
  const cert = timers.byCode("FNMA_E3302_SALE_CERT_WINDOW_7_15")[0]!; assert.equal(cert.status, "armed"); assert.equal(cert.anchorDate, "2026-11-03"); assert.equal(cert.dueDate, "2026-10-27"); assert.equal(cert.note, "window opens 2026-10-19");
  const app = { id: "app-1", determination_sent_on: D("2026-10-10"), appeal_available: false };
  const sweep = appealWindowSweep(events, AGENT, { loan_id: "L-132", today: D("2026-10-10"), applications: [app] });
  assert.equal(sweep.closed.length, 1); assert.equal(sweep.closed[0]!.outcome, "not_applicable"); assert.equal(sweep.closed[0]!.closed_on, "2026-10-10"); assert.equal(sweep.closed[0]!.exit, "ineligible_notice_no_appeal");
  const closed = events.ofType("foreclosure.hold.closed"); assert.equal(closed.length, 1); assert.equal(closed[0]!.payload.kind, "regx_g_dual_track"); assert.equal(closed[0]!.payload.closed_on, "2026-10-10"); assert.equal(closed[0]!.payload.reason, "ineligible_notice_no_appeal");
  assert.equal(appealWindowSweep(events, AGENT, { loan_id: "L-132", today: D("2026-10-11"), applications: [app] }).closed.length, 0, "a hold already closed on the log is not closed twice");
  assert.equal(evaluateGate("13.2.dualTrackGateOpen", { complete_app_after_first_notice: true, exit: "" }).open, false); assert.equal(evaluateGate("13.2.dualTrackGateOpen", { complete_app_after_first_notice: true, exit: "ineligible_notice_no_appeal" }).open, true);
  clock.set("2026-10-20T12:00:00.000Z");
  const out = recordSaleInstruction(events, AGENT, { loan_id: "L-132", instruction_id: "ai-cert-1", kind: "CERTIFY_SALE", today: D("2026-10-20"), sale_at: D("2026-11-03"), firm_id: "F-1" }, timers);
  assert.equal(out.in_window, true); assert.deepEqual(out.window, { opens: "2026-10-19", closes: "2026-10-27" }); assert.equal(out.event!.type, "foreclosure.sale.certified"); assert.equal(out.event!.payload.document, SALE_CERT_DOCUMENT); assert.equal(out.event!.payload.certified_on, "2026-10-20");
  assert.ok(eventMatches(registry.get("FNMA_E3302_SALE_CERT_WINDOW_7_15")!.satisfiedPattern!, out.event!)); assert.equal(cert.status, "satisfied"); assert.equal(cert.satisfiedByEventId, out.event!.id); assert.equal(cert.satisfiedAt, "2026-10-20T12:00:00.000Z");
  assert.equal(recordSaleInstruction(events, AGENT, { loan_id: "L-132", instruction_id: "ai-cert-2", kind: "CERTIFY_SALE", today: D("2026-10-28"), sale_at: D("2026-11-03") }).in_window, false, "Oct. 28 is outside the E-3.3-02 window");
});
test("13.2-T3: Given a complete application received Sept. 28 (36 days), Then no Reg X hold; Fannie Mae `fnma_15_to_37` expedited review due before Oct. 19; certification withheld until the determination is sent.", () => {
  const r = dualTrackHoldOpen({ first_notice_filed_on: D("2026-08-01"), sale_on: D("2026-11-03"), received_on: D("2026-09-28") });
  assert.equal(r.tier.days_before_sale, 36); assert.equal(r.tier.regx, "none"); assert.equal(r.tier.fnma, "fnma_15_to_37"); assert.equal(r.hold, null);
  assert.equal(r.fnma_hold!.kind, "fnma_e3401_evaluation"); assert.equal(r.expedited_review_due_before, "2026-10-19"); assert.equal(r.certification_withheld, true); assert.equal(r.instruction, null);
  assert.equal(dualTrackHoldOpen({ first_notice_filed_on: D("2026-08-01"), sale_on: D("2026-11-03"), received_on: D("2026-09-28"), determination_sent_on: D("2026-10-15") }).certification_withheld, false);
  assert.deepEqual(certificationWindow(D("2026-11-03")), { opens: "2026-10-19", closes: "2026-10-27" });
});
test("13.2-T4: Given a pending summary-judgment motion when the application arrives, Then `WITHDRAW_MOTION`/`REQUEST_CONTINUANCE` instruction issued; court rules anyway → compliance evidence = instruction + firm's filed request; no breach.", async () => {
  const r = pendingMotion({ application_received_on: D("2026-10-01"), motion_pending: true, firm_filed_request: true, court_ruled_anyway: true });
  assert.equal(r.instruction, "WITHDRAW_MOTION"); assert.deepEqual(r.compliance_evidence, ["instruction:WITHDRAW_MOTION", "firm_filed_request"]); assert.equal(r.breach, false);
  assert.equal(pendingMotion({ application_received_on: D("2026-10-01"), motion_pending: true, firm_filed_request: false, court_ruled_anyway: true }).breach, true);
  // On the bus (comment 41(g)-1/-3): the WITHDRAW_MOTION / REQUEST_CONTINUANCE instructions are Guide-mandated kinds `attorney.instruction.send` accepts without a hold check (they are not RESUME/CERTIFY_SALE), each leaves its
  // `attorney_instructions` row and `attorney.instruction.sent`; the firm's filed request comes back as the acknowledgment (`attorney.instruction.status{op=acknowledge}` with the evidence document) — the record that proves "reasonable steps".
  const h = harness("2026-10-01T15:00:00.000Z");
  const sent = await h.run("attorney.instruction.send", AGENT, { loan_id: "L-132", kind: "WITHDRAW_MOTION", firm_id: "F-1", id: "ai-withdraw-1" });
  const row = sent.output as { kind: string; status: string; ack_due_business_days: number; sent_at: string }; assert.equal(row.kind, "WITHDRAW_MOTION"); assert.equal(row.status, "sent"); assert.equal(row.ack_due_business_days, 1); assert.equal(row.sent_at, "2026-10-01T15:00:00.000Z");
  assert.equal(h.events.ofType("attorney.instruction.sent").filter((e) => e.payload.kind === "WITHDRAW_MOTION").length, 1);
  const cont = await h.run("attorney.instruction.send", AGENT, { loan_id: "L-132", kind: "REQUEST_CONTINUANCE", firm_id: "F-1", id: "ai-continuance-1" }); assert.equal((cont.output as { kind: string }).kind, "REQUEST_CONTINUANCE");
  const ack = await h.run("attorney.instruction.status", AGENT, { id: "ai-withdraw-1", op: "acknowledge", acknowledged_at: "2026-10-02T10:00:00.000Z", ack_by: "F-1:jdoe", evidence_document_id: "doc-filed-request-1" }, "2026-10-02T10:00:00.000Z");
  const acked = ack.output as { status: string; acknowledged_at: string; evidence_document_id: string }; assert.equal(acked.status, "acknowledged"); assert.equal(acked.acknowledged_at, "2026-10-02T10:00:00.000Z"); assert.equal(acked.evidence_document_id, "doc-filed-request-1");
  const ackEvt = h.events.ofType("attorney.instruction.acknowledged"); assert.equal(ackEvt.length, 1); assert.equal(ackEvt[0]!.payload.kind, "WITHDRAW_MOTION"); assert.equal(ackEvt[0]!.payload.instruction_id, "ai-withdraw-1");
  assert.equal(h.rt.store.get("attorney_instructions", "ai-withdraw-1")!.data.evidence_document_id, "doc-filed-request-1", "compliance evidence = instruction + the firm's filed request");
});
test("13.2-T5: Given an offer accepted and first trial payment received, Then `hold_performing` blocks sale until `lossmit.trial.failed`; failure on the last day of the month due reopens sale scheduling the next day.", () => {
  const open = performingHold({ accepted_on: D("2026-10-05"), first_payment_received_on: D("2026-11-01") });
  assert.equal(open.hold, "hold_performing"); assert.equal(open.kind, "fnma_trial_performing"); assert.deepEqual(open.blocks, ["first_notice", "judgment_motion", "sale_schedule", "sale_conduct"]); assert.equal(open.until, "lossmit.trial.failed"); assert.equal(open.closed_on, null);
  assert.equal(open.stepAllowedOn("sale_conduct", D("2027-01-15")), false); assert.equal(open.stepAllowedOn("sale_schedule", D("2027-06-01")), false); assert.equal(stepAllowed("sale_conduct", ["hold_performing"]), false); assert.equal(stepAllowed("first_notice", ["hold_performing"]), false);
  const failed = performingHold({ accepted_on: D("2026-10-05"), first_payment_received_on: D("2026-11-01"), trial_failed_on: D("2027-02-28") });   // failure on the last day of the month due
  assert.equal(failed.closed_on, "2027-02-28"); assert.equal(failed.sale_schedule_reopens_on, "2027-03-01"); assert.equal(failed.stepAllowedOn("sale_schedule", D("2027-02-28")), false); assert.equal(failed.stepAllowedOn("sale_schedule", D("2027-03-01")), true);
});
test("13.2-T6: Given MN property, application (incomplete) received before referral, Then `foreclosure.refer` refused while pending.", () => {
  const r = mnReferralGate({ state: "MN", application_status: "pending_incomplete" }); assert.equal(r.allowed, false); assert.match(r.refusal!, /582\.043/);
  assert.equal(mnReferralGate({ state: "MN", application_status: "closed" }).allowed, true); assert.equal(mnReferralGate({ state: "TX", application_status: "pending_incomplete" }).allowed, true);
});
test("13.2-T7: Given a `POSTPONE_SALE` instruction not acknowledged in 1 BD, Then `attorney` escalation and phone task created; DRA reconciliation flags absence of a postponement event after 2 BD.", () => {
  const r = unacknowledgedPostponement({ instruction_sent_on: D("2026-10-20"), acknowledged_on: null, dra_postponement_event_on: null, today: D("2026-10-23") });
  assert.equal(r.ack_due, "2026-10-21"); assert.equal(r.escalation!.kind, "attorney"); assert.equal(r.escalation!.severity, "sev1", "REGX_1024_41G_INSTRUCT_COUNSEL_1BD breach: sev 1 → attorney"); assert.equal(r.officer_informed, true, "officer informed"); assert.equal(r.phone_task, true); assert.equal(r.dra_expected_by, "2026-10-22"); assert.equal(r.dra_exception, true);
  const acked = unacknowledgedPostponement({ instruction_sent_on: D("2026-10-20"), acknowledged_on: D("2026-10-21"), dra_postponement_event_on: D("2026-10-22"), today: D("2026-10-23") }); assert.equal(acked.escalation, null); assert.equal(acked.officer_informed, false);
});
test("13.2-T8: Given no sale scheduled at receipt and a sale later set 40 days out, Then tier remains `g_full_90` with appeal rights and 14-day acceptance.", () => {
  const snap = protectionSnapshot({ received_on: D("2026-09-01"), sale_at_receipt: null, later_sale_on: D("2026-10-11") });
  assert.equal(snap.tier, "g_full_90"); assert.equal(snap.appeal, true); assert.equal(snap.acceptance_days, 14); assert.equal(snap.days_before_sale, null); assert.equal(snap.recomputed, false); assert.match(snap.note, /fixed as of receipt/);
  assert.equal(tierAtReceipt(D("2026-09-01"), null).regx, "g_full_90"); assert.equal(tierAtReceipt(D("2026-09-01"), D("2026-10-11")).regx, "g_37_to_89", "a later-scheduled sale 40 days out would be a lower tier — the snapshot is never recomputed");
});
test("13.2-T9: Given the certification window opens and the DMDC re-check shows active duty, Then certification withheld (13.8), postponement instructed.", () => {
  const r = certificationDmdcCheck({ sale_on: D("2026-11-03"), check_on: D("2026-10-20"), active_duty: true });
  assert.equal(r.in_window, true); assert.equal(r.certification, "withheld"); assert.equal(r.instruction, "POSTPONE_SALE"); assert.equal(r.violation_suspected, false);
  assert.equal(certificationDmdcCheck({ sale_on: D("2026-11-03"), check_on: D("2026-10-20"), active_duty: false }).instruction, "CERTIFY_SALE");
});
test("13.2-T10: Given rescission after a sale held in violation, Then 15.1 rescission flow and A1-4.2-02 fee exposure recorded.", () => {
  const r = rescissionAfterViolation({ sale_on: D("2026-11-03"), violation: "dual_tracking", third_party_costs_cents: 45_000n });
  assert.equal(r.flow, "15.1.rescission"); assert.equal(r.exposure_cents, 145_000n); assert.equal(r.root_cause, "servicer:dual_tracking"); assert.deepEqual(r.escalations.map((e) => e.kind), ["attorney", "officer"]);
});
