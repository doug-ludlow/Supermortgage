// 12.9 Short sale / Mortgage Release (DIL)
// spec/sections/12-loss-mitigation/12-9-short-sale-mortgage-release-dil.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { shortSaleIntake, delegationRouting, settlementReview, dilExitOption, liquidationHolds, militaryIndulgence, dilCase, shortSaleClosingClock } from "./ops.ts";
import { relocation, netProceeds, contribution, negotiated, listingRule, listingRuleMet, shortSaleClocks, dilClocks, deedTiming, incentive } from "./liquidation.ts";
import { recordValuationReceived, recordClosingFundsReceived, recordInspectionReport, disburseRelocation, recordNodRescinded, recordForeclosureSaleScheduled, attachSaleScheduleListener, projectLiquidationCase, LIQUIDATION_ACTOR } from "./ops-12-9.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { NoticeService } from "../../notices/service.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { CommandBus, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput, type ToolDef } from "../../app/tools.ts";
import { SECTION_12_TOOLS } from "../../app/tools/section12.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { FakeFnmaSmdu } from "../../infra/integrations/fnma.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { FakeErecording } from "../../infra/integrations/legal.ts";

const AGENT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const REG = loadOverriddenRegistry();
const satisfies = (code: string, e: DomainEvent): boolean => eventMatches(REG.get(code)!.satisfiedPattern!, e);
const triggers = (code: string, e: DomainEvent): boolean => eventMatches(REG.get(code)!.triggerPattern!, e);
const toolKey = (process: string, name: string): string => `${process} ${name}`;
/** The §12 bus alone (the 12-8 pattern): 12.9's tools bound to their agent without importing every other section's tools. */
function bindSection12(rt: ToolRuntime, agents: AgentRegistry, defs: readonly ToolDef[] = SECTION_12_TOOLS): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of defs) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); out.set(toolKey(d.process, d.name), cmd); }
  return out;
}
/** The 12.9 lifecycle on the event store: the `liquidation.case.*` tool (transitions + ops-12-9 inbound ops), the Notice Registry for the ack/decision letters and the TimerEngine arming the 12.9 rows. */
function liquidationHarness(loanId: string, nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["12.9"] });
  const uow: UowContext = { loanId, events, ledger: new MemoryLedger(), timers, clock, decide: () => {} };
  const noticeReg = buildRegistry(); publishAuthored(noticeReg);
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }), ports: { smdu: new FakeFnmaSmdu(), printMail: new FakePrintMail(), edelivery: new FakeEdelivery(), erecording: new FakeErecording() } };
  const agents = new AgentRegistry(); const cmds = bindSection12(rt, agents); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("12.9", name))!, AGENT, { loan_id: loanId, ...input }, uow)).output as Record<string, unknown>;
  const rejects = (name: string, input: ToolInput, re: RegExp) => assert.rejects(bus.execute(cmds.get(toolKey("12.9", name))!, AGENT, { loan_id: loanId, ...input }, uow), re);
  const notice = (code: string, extra: Record<string, unknown> = {}) => run("notice.render_send", { template_code: code, recipients: [{ partyId: "b1", name: "Borrower", mailingAddress: "1 Test St, Testville TX 75001" }], payload: { ...noticeReg.activeVersion(code, D(clock.now().slice(0, 10)))!.samplePayload, ...extra } });
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code);
  const emitted = (type: string) => events.all().filter((e) => e.type === type);
  const env = { events, actor: LIQUIDATION_ACTOR, now: clock.now() };
  return { clock, events, timers, rt, run, rejects, notice, at, timer, emitted, env: () => ({ ...env, now: clock.now() }) };
}

test("12.9-T1: Given a complete BRP and an initial offer received 2026-10-05 (loan 8 months delinquent), when processed, then the acknowledgment is sent by 2026-10-12 (5 BD), the valuation is ordered on eligibility, and the approval/counter/decline is sent by 2026-11-04 (30 days).", async () => {
  const r = shortSaleIntake({ offer_received_on: D("2026-10-05"), brp_complete: true, months_delinquent: 8 });
  assert.equal(r.eligible, true); assert.equal(r.ack_notice, "NTC_FNMA_D23301_SS_OFFER_ACK"); assert.equal(r.valuation_ordered, true);
  // D2-3.3-01 tiering (12.9 rule 1): 8 months → 90 days–18 months, complete BRP required unless a listed exception applies; >18 months and Chapter 7 discharge need no BRP; current/<90 days needs the BRP and, under 60 days, imminent default with a qualifying hardship.
  assert.equal(r.tier, "d90_18m"); assert.equal(r.brp_required, true); assert.equal(r.exception_applied, null); assert.equal(r.imminent_default_required, false);
  const noBrp = shortSaleIntake({ offer_received_on: D("2026-10-05"), brp_complete: false, months_delinquent: 8 }); assert.equal(noBrp.eligible, false); assert.equal(noBrp.valuation_ordered, false); assert.match(noBrp.refusal!, /requires a complete BRP/);
  const fico = shortSaleIntake({ offer_received_on: D("2026-10-05"), brp_complete: false, months_delinquent: 8, exceptions: ["fico_le_620"] }); assert.equal(fico.eligible, true); assert.equal(fico.brp_required, false); assert.equal(fico.exception_applied, "fico_le_620");
  assert.equal(shortSaleIntake({ offer_received_on: D("2026-10-05"), brp_complete: false, months_delinquent: 20 }).tier, "gt_18m"); assert.equal(shortSaleIntake({ offer_received_on: D("2026-10-05"), brp_complete: false, months_delinquent: 20 }).eligible, true);
  assert.deepEqual([shortSaleIntake({ offer_received_on: D("2026-10-05"), brp_complete: false, months_delinquent: 2, chapter7_discharged: true }).tier, shortSaleIntake({ offer_received_on: D("2026-10-05"), brp_complete: false, months_delinquent: 2, chapter7_discharged: true }).eligible], ["ch7_discharge", true]);
  const current = shortSaleIntake({ offer_received_on: D("2026-10-05"), brp_complete: true, months_delinquent: 0, days_delinquent: 0 }); assert.equal(current.tier, "lt_90"); assert.equal(current.imminent_default_required, true); assert.equal(current.eligible, false); assert.match(current.refusal!, /imminent default/);
  assert.equal(shortSaleIntake({ offer_received_on: D("2026-10-05"), brp_complete: true, months_delinquent: 0, days_delinquent: 0, imminent_default: true, qualifying_hardship: true }).eligible, true);
  assert.equal(shortSaleIntake({ offer_received_on: D("2026-10-05"), brp_complete: true, months_delinquent: 2, days_delinquent: 65 }).eligible, true);   // 60–89 days: BRP suffices
  assert.throws(() => shortSaleIntake({ offer_received_on: D("2026-10-05"), brp_complete: false, months_delinquent: 8, exceptions: ["low_fico"] }), /unknown D2-3.3-01 BRP exception/);
  // 5 servicer business days from 2026-10-05 skip Columbus Day (2026-10-12) → 2026-10-13 (the spec's 10-12 counts the holiday; see docs/AUDIT-NOTES.md)
  assert.equal(r.ack_by, "2026-10-13"); assert.equal(r.decision_by, "2026-11-04"); assert.deepEqual(r.decision_notices, ["NTC_FNMA_D23301_SS_APPROVAL", "NTC_FNMA_D23301_SS_COUNTER", "NTC_FNMA_D23301_SS_DECLINE"]);
  // The same file on the bus: the offer arms the 5-BD ack and 30-day decision clocks, the valuation order arms F-1-14's 10-day SLA, and the real events satisfy each.
  const h = liquidationHarness("L-129-T1", "2026-10-05T15:00:00.000Z");
  await h.run("liquidation.case.*", { id: "liq-T1", kind: "short_sale", status: "listing", state: "TX" });
  await h.run("liquidation.case.*", { id: "liq-T1", op: "offer_received", received_on: "2026-10-05", brp_complete_on: "2026-10-01", price_cents: 27_500_000n, mls_active_date: "2026-09-26" });
  const offer = h.emitted("liquidation.offer.received")[0]!; assert.equal(offer.payload.initial, true); assert.equal(offer.payload.brp_complete, true); assert.equal(offer.payload.later_of_brp_and_offer, "2026-10-05");
  const ack = h.timer("FNMA_D23301_SS_OFFER_ACK_5BD")[0]!; assert.equal(ack.status, "armed"); assert.equal(ack.anchorDate, "2026-10-05"); assert.equal(ack.dueDate, "2026-10-13");
  const decision = h.timer("FNMA_D23301_SS_DECISION_30")[0]!; assert.equal(decision.status, "armed"); assert.equal(decision.anchorDate, "2026-10-05"); assert.equal(decision.dueDate, "2026-11-04");
  await h.run("valuation.order/get", { id: "val-T1", kind: "bpo" });
  const ordered = h.emitted("valuation.ordered")[0]!; assert.equal(ordered.payload.valuation_id, "val-T1"); assert.equal(triggers("FNMA_F114_SS_VALUATION_10", ordered), true);
  const sla = h.timer("FNMA_F114_SS_VALUATION_10")[0]!; assert.equal(sla.status, "armed"); assert.equal(sla.anchorDate, "2026-10-05"); assert.equal(sla.dueDate, "2026-10-15");
  h.at("2026-10-09T15:00:00.000Z"); await h.notice("NTC_FNMA_D23301_SS_OFFER_ACK", { offer_on: "2026-10-05", decision_by: "2026-11-04" });
  const sent = h.emitted("notice.sent"); assert.equal(sent.length, 1); assert.equal(sent[0]!.payload.template, "NTC_FNMA_D23301_SS_OFFER_ACK"); assert.equal(satisfies("FNMA_D23301_SS_OFFER_ACK_5BD", sent[0]!), true);
  assert.equal(ack.status, "satisfied"); assert.equal(decision.status, "armed");
  // The SMDU/BPO result must answer the order (F-1-14) — an unknown valuation id is refused; the matched result satisfies the SLA row on day 7.
  h.at("2026-10-12T15:00:00.000Z");
  await h.rejects("liquidation.case.*", { id: "liq-T1", op: "valuation_received", valuation_id: "val-unknown", method: "bpo", value_cents: 27_500_000n, as_of: "2026-10-10" }, /was not ordered/);
  await h.rejects("liquidation.case.*", { id: "liq-T1", op: "valuation_received", valuation_id: "val-T1", method: "bpo", value_cents: 0n, as_of: "2026-10-10" }, /value must be positive/);
  const got = await h.run("liquidation.case.*", { id: "liq-T1", op: "valuation_received", valuation_id: "val-T1", method: "bpo", value_cents: 27_500_000n, as_of: "2026-10-10" });
  assert.equal(got.event_type, "valuation.received"); assert.equal(got.order_to_receipt_days, 7); assert.equal(got.sla_met, true); assert.equal(got.ordered_on, "2026-10-05");
  const received = h.emitted("valuation.received")[0]!; assert.deepEqual([received.payload.valuation_id, received.payload.value_cents, received.payload.as_of, received.payload.received_on], ["val-T1", "27500000", "2026-10-10", "2026-10-12"]);
  assert.equal(satisfies("FNMA_F114_SS_VALUATION_10", received), true); assert.equal(sla.status, "satisfied");
  // The decision letter on day 30 satisfies the 30-day row (D2-3.3-01) — on time, not late.
  h.at("2026-11-04T15:00:00.000Z"); await h.run("liquidation.case.*", { id: "liq-T1", status: "approved", smdu_decision_id: "smdu-T1", valuation_date: "2026-10-10" });
  await h.notice("NTC_FNMA_D23301_SS_APPROVAL");
  assert.equal(h.emitted("notice.sent").length, 2); assert.equal(satisfies("FNMA_D23301_SS_DECISION_30", h.emitted("notice.sent")[1]!), true); assert.equal(decision.status, "satisfied");
  assert.equal(h.timer("FNMA_D23301_SS_CLOSE_60")[0]!.dueDate, "2027-01-03");
});
test("12.9-T2: (contribution) reserves $18,400, PITI $2,100 → request $8,400; negotiated $5,000 within policy; relocation not payable; Fannie Mae approval path when the borrower refuses.", async () => {
  const c = contribution(1_840_000n, 210_000n, 4_100_000n); assert.equal(c.evaluated, true); assert.equal(c.required, true); assert.equal(c.request_cents, 840_000n); assert.match(c.basis, /reserves > \$10,000/);
  assert.equal(negotiated(c.request_cents, 500_000n), "accepted"); assert.equal(negotiated(c.request_cents, 400_000n), "fnma_referral"); assert.equal(negotiated(c.request_cents, 0n), "fnma_referral");
  assert.equal(relocation(c.required, 0n), 0n); assert.equal(relocation(false, 0n), 750_000n);
  // D2-3.3-01 triggers: reserves >$10,000 *or* housing ratio ≤40%; below both, the borrower is not asked; exclusions (no complete BRP, PCS, prohibited by law) are not evaluated at all.
  const waived = contribution(200_000n, 10_000n, 4_100_000n, { housing_ratio_pct: "35.00" }); assert.equal(waived.required, false); assert.equal(waived.request_cents, 0n); assert.match(waived.basis, /< \$500 → waived/);   // max(20% × $2,000, 4 × $100) = $400 < $500 → waived
  const ratio = contribution(200_000n, 210_000n, 4_100_000n, { housing_ratio_pct: "38.50" }); assert.equal(ratio.required, true); assert.equal(ratio.request_cents, 840_000n); assert.match(ratio.basis, /housing ratio 38.50% ≤ 40%/);
  const neither = contribution(200_000n, 210_000n, 4_100_000n, { housing_ratio_pct: "45.00" }); assert.equal(neither.evaluated, true); assert.equal(neither.required, false); assert.equal(relocation(neither.required, 0n), 750_000n);
  assert.deepEqual([contribution(1_840_000n, 210_000n, 4_100_000n, { brp_complete: false }).evaluated, contribution(1_840_000n, 210_000n, 4_100_000n, { pcs_servicemember: true }).evaluated, contribution(1_840_000n, 210_000n, 4_100_000n, { prohibited_by_law: true }).evaluated], [false, false, false]);
  assert.equal(contribution(1_840_000n, 210_000n, 500_000n).request_cents, 500_000n);   // capped at the deficiency
  // The approval letter refuses relocation alongside a contribution.
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_FNMA_D23301_SS_APPROVAL", D("2026-10-28"))!;
  const both = { ...v.samplePayload, contribution_cents: 500_000n, relocation_cents: 750_000n }; assert.equal(evaluateChecklist(v, both, render(v.source, both)).blocking.some((b) => b.rule_id === "relocation-not-with-contribution"), true);
  // The disbursement itself: on the worked case (contribution required, $5,000 negotiated) the closing agent's relocation line is refused; Fannie Mae's approval id lifts the bar; the paid amount is the calculator's.
  const h = liquidationHarness("L-129-T2", "2026-11-04T15:00:00.000Z");
  const tool = await h.run("contribution.compute", { reserves_cents: 1_840_000n, piti_cents: 210_000n, deficiency_cents: 4_100_000n, brp_complete: true, offer_cents: 500_000n }); assert.equal(tool.request_cents, 840_000n); assert.equal(tool.negotiated, "accepted");
  await h.run("liquidation.case.*", { id: "liq-T2", kind: "short_sale", status: "approved", smdu_decision_id: "smdu-T2", contribution_required: true });
  await h.rejects("liquidation.case.*", { id: "liq-T2", op: "relocation_disbursed", payer: "closing_agent" }, /NO_RELOCATION_WITH_CONTRIBUTION/);
  assert.equal(h.emitted("relocation.disbursed").length, 0);
  const paid = await h.run("liquidation.case.*", { id: "liq-T2", op: "relocation_disbursed", payer: "closing_agent", fnma_approval_id: "FNMA-APR-T2", third_party_assistance_cents: 100_000n });
  assert.equal(paid.amount_cents, 650_000n); assert.equal(paid.event_type, "relocation.disbursed");
  const ev = h.emitted("relocation.disbursed")[0]!; assert.deepEqual([ev.payload.amount_cents, ev.payload.payer, ev.payload.fnma_approval_id, ev.payload.third_party_assistance_cents], ["650000", "closing_agent", "FNMA-APR-T2", "100000"]);
  assert.equal(satisfies("FNMA_D23302_DIL_RELOCATION_30", ev), true);
  await h.rejects("liquidation.case.*", { id: "liq-T2", op: "relocation_disbursed", payer: "closing_agent", fnma_approval_id: "FNMA-APR-T2" }, /already disbursed/);
});
test("12.9-T3: (reserves >$50,000) case routed non-delegated with the assets field populated; no delegated approval issued.", () => {
  const r = delegationRouting({ reserves_cents: 5_500_000n, net_proceeds_within_parameters: true });
  assert.equal(r.route, "non_delegated"); assert.equal(r.assets_field_cents, 5_500_000n); assert.equal(r.delegated_approval_allowed, false); assert.match(r.reasons[0]!, /\$50,000/);
  assert.equal(delegationRouting({ reserves_cents: 4_000_000n, net_proceeds_within_parameters: true }).route, "delegated");
});
test("12.9-T4: (listing rule) MLS active 4 days → offer held; 5 days incl. weekend → review proceeds.", () => {
  assert.equal(listingRuleMet(D("2026-10-05"), D("2026-10-08")), false);   // Mon–Thu: 4 days
  assert.deepEqual(listingRule(D("2026-10-07"), D("2026-10-11")), { consecutive_days: 5, includes_saturday: true, includes_sunday: true, met: true });   // Wed–Sun
  assert.deepEqual(listingRule(D("2026-10-05"), D("2026-10-09")), { consecutive_days: 5, includes_saturday: false, includes_sunday: false, met: false });   // Mon–Fri: 5 days but no weekend → held
  assert.equal(listingRuleMet(D("2026-10-09"), D("2026-10-13")), true);   // Fri–Tue
  // The same rule as the `FNMA_D23301_SS_LISTING_MLS_5D` gate evaluator (12.9.listedFiveConsecutiveDays): the four-day listing closes the gate (offer held), the weekend-spanning five-day listing opens it.
  const held = listingRule(D("2026-10-05"), D("2026-10-08")); const gateHeld = evaluateGate("12.9.listedFiveConsecutiveDays", { consecutive_days_listed: held.consecutive_days, includes_saturday: held.includes_saturday, includes_sunday: held.includes_sunday });
  assert.equal(gateHeld.open, false); assert.match(gateHeld.reason!, /4 consecutive days/);
  const ok = listingRule(D("2026-10-07"), D("2026-10-11")); assert.equal(evaluateGate("12.9.listedFiveConsecutiveDays", { consecutive_days_listed: ok.consecutive_days, includes_saturday: ok.includes_saturday, includes_sunday: ok.includes_sunday }).open, true);
  const noWeekend = listingRule(D("2026-10-05"), D("2026-10-09")); assert.equal(evaluateGate("12.9.listedFiveConsecutiveDays", { consecutive_days_listed: noWeekend.consecutive_days, includes_saturday: noWeekend.includes_saturday, includes_sunday: noWeekend.includes_sunday }).open, false);
});
test("12.9-T5: (closing clock) approval 2026-11-04 → close by 2027-01-03; funds 2027-01-10 without extension → approval expired, case re-evaluated.", async () => {
  assert.equal(shortSaleClocks(D("2026-10-05"), D("2026-11-04")).close_by, "2027-01-03");
  const open = shortSaleClosingClock({ approved_on: D("2026-11-04") }); assert.equal(open.close_by, "2027-01-03"); assert.equal(open.status, "open"); assert.equal(open.timer, "FNMA_D23301_SS_CLOSE_60");
  const expired = shortSaleClosingClock({ approved_on: D("2026-11-04"), funds_received_on: D("2027-01-10") });
  assert.equal(expired.status, "expired"); assert.equal(expired.approval_expired, true); assert.equal(expired.next, "re_evaluate"); assert.match(expired.refusal!, /approval expired; re-evaluate/);
  assert.equal(shortSaleClosingClock({ approved_on: D("2026-11-04"), funds_received_on: D("2027-01-10"), fnma_extension_id: "FNMA-EXT-1" }).status, "closed");
  assert.equal(shortSaleClosingClock({ approved_on: D("2026-11-04"), funds_received_on: D("2027-01-03") }).status, "closed");
  // On the bus: the approval arms `FNMA_D23301_SS_CLOSE_60` (due 2027-01-03); funds on 2027-01-10 without an extension record the receipt, breach-then-satisfy the row late, and move the case to `expired{next=re_evaluate}`.
  const h = liquidationHarness("L-129-T5", "2026-11-04T15:00:00.000Z");
  await h.rejects("liquidation.case.*", { id: "liq-T5", status: "approved" }, /APPROVAL_FROM_SMDU_ONLY/);   // no approval outside SMDU's decision / Fannie Mae approval (12.9 guardrail)
  await h.run("liquidation.case.*", { id: "liq-T5", kind: "short_sale", status: "listing" });
  await h.rejects("liquidation.case.*", { id: "liq-T5", op: "funds_received", amount_cents: 24_500_000n, received_on: "2026-11-04" }, /not approved/);
  await h.run("liquidation.case.*", { id: "liq-T5", status: "approved", smdu_decision_id: "smdu-T5" });
  const approved = h.emitted("liquidation.case.status_changed").at(-1)!; assert.equal(triggers("FNMA_D23301_SS_CLOSE_60", approved), true);
  const close = h.timer("FNMA_D23301_SS_CLOSE_60")[0]!; assert.equal(close.status, "armed"); assert.equal(close.anchorDate, "2026-11-04"); assert.equal(close.dueDate, "2027-01-03");
  assert.equal(h.timer("FNMA_E3401_SS_APPROVED_HOLD_60")[0]!.dueDate, "2027-01-03");
  h.at("2027-01-10T15:00:00.000Z"); assert.deepEqual(h.timers.evaluate("2027-01-10T15:00:00.000Z").map((b) => b.instance.code).sort(), ["FNMA_D23301_SS_CLOSE_60", "FNMA_E3401_SS_APPROVED_HOLD_60"]); assert.equal(close.status, "breached");
  const late = await h.run("liquidation.case.*", { id: "liq-T5", op: "funds_received", amount_cents: 24_500_000n, received_on: "2027-01-10", reference: "WIRE-0110" });
  assert.equal(late.status, "expired"); assert.equal(late.approval_expired, true); assert.equal(late.next, "re_evaluate"); assert.equal(late.close_by, "2027-01-03"); assert.match(late.refusal as string, /approval expired; re-evaluate/);
  const funds = h.emitted("closing.funds.received")[0]!; assert.deepEqual([funds.payload.case_id, funds.payload.amount_cents, funds.payload.received_on, funds.payload.close_by, funds.payload.within_window, funds.payload.approval_expired], ["liq-T5", "24500000", "2027-01-10", "2027-01-03", false, true]);
  assert.equal(satisfies("FNMA_D23301_SS_CLOSE_60", funds), true); assert.equal(close.status, "satisfied_late");
  const exp = h.emitted("liquidation.case.status_changed").at(-1)!; assert.deepEqual([exp.payload.status, exp.payload.previous_status, exp.payload.next, exp.payload.status_on], ["expired", "approved", "re_evaluate", "2027-01-10"]);
  assert.equal(projectLiquidationCase(h.events, "L-129-T5")!.status, "expired");
  // Funds on the last day of the window (or later under a Fannie Mae extension) close without expiring anything.
  const g = liquidationHarness("L-129-T5b", "2026-11-04T15:00:00.000Z");
  await g.run("liquidation.case.*", { id: "liq-T5b", kind: "short_sale", status: "approved", smdu_decision_id: "smdu-T5b" });
  g.at("2027-01-03T15:00:00.000Z"); const onTime = await g.run("liquidation.case.*", { id: "liq-T5b", op: "funds_received", amount_cents: 24_500_000n, received_on: "2027-01-03" });
  assert.equal(onTime.status, "closed"); assert.equal(onTime.approval_expired, false); assert.equal(g.timer("FNMA_D23301_SS_CLOSE_60")[0]!.status, "satisfied"); assert.equal(g.emitted("liquidation.case.status_changed").length, 1);
  const x = liquidationHarness("L-129-T5c", "2026-11-04T15:00:00.000Z");
  await x.run("liquidation.case.*", { id: "liq-T5c", kind: "short_sale", status: "approved", smdu_decision_id: "smdu-T5c" });
  x.at("2027-01-10T15:00:00.000Z"); assert.equal((await x.run("liquidation.case.*", { id: "liq-T5c", op: "funds_received", amount_cents: 24_500_000n, received_on: "2027-01-10", fnma_extension_id: "FNMA-EXT-1" })).status, "closed"); assert.equal(x.emitted("liquidation.case.status_changed").length, 1);
});
test("12.9-T6: (settlement review) CD shows a $2,000 payment to the borrower beyond the $7,500 incentive → funding blocked; fraud review.", () => {
  const r = settlementReview({ cd_lines: [{ payee: "borrower", role: "borrower", cents: 750_000n, purpose: "relocation assistance" }, { payee: "borrower", role: "borrower", cents: 200_000n, purpose: "seller credit" }, { payee: "agent", role: "agent", cents: 1_650_000n, purpose: "commission" }], relocation_cents: 750_000n });
  assert.equal(r.borrower_total_cents, 950_000n); assert.equal(r.excess_cents, 200_000n); assert.equal(r.funding_blocked, true); assert.equal(r.escalation!.kind, "fraud_officer"); assert.equal(r.finding, "undisclosed borrower payment on the CD");
  assert.equal(settlementReview({ cd_lines: [{ payee: "borrower", role: "borrower", cents: 750_000n, purpose: "relocation" }], relocation_cents: 750_000n }).funding_blocked, false);
});
test("12.9-T7: (DIL window) acceptance 2026-10-15 → documents due 2026-12-14; weekly updates extend to 2027-01-13; inspection ordered ≤2026-12-14 when no interior BPO ≤90 days exists.", async () => {
  assert.deepEqual(dilClocks(D("2026-10-15")), { documents_by: "2026-12-14", extended_by: "2027-01-13" });
  const r = dilCase({ acceptance_on: D("2026-10-15"), exit_option: "immediate", interior_bpo_within_90_days: false, updates: [D("2026-12-14"), D("2026-12-21"), D("2026-12-28")] });
  assert.equal(r.docs_deadline, "2026-12-14"); assert.equal(r.docs_extended_deadline, "2027-01-13"); assert.equal(r.weekly_updates_required_from, "2026-12-14"); assert.equal(r.weekly_cadence_ok, true); assert.equal(r.inspection_order_by, "2026-12-14");
  assert.equal(dilCase({ acceptance_on: D("2026-10-15"), exit_option: "immediate", interior_bpo_within_90_days: true }).inspection_order_by, null);
  assert.equal(dilCase({ acceptance_on: D("2026-10-15"), exit_option: "immediate", updates: [D("2026-12-14"), D("2026-12-23")] }).weekly_cadence_ok, false);
  // On the bus: acceptance without a fresh interior BPO arms the 60-day document and inspection rows (both due 2026-12-14); the vendor's report satisfies the inspection row; the extension past day 60 arms the 7-day update row, which each logged update satisfies and re-arms out to 2027-01-13.
  const h = liquidationHarness("L-129-T7", "2026-10-15T15:00:00.000Z");
  await h.run("liquidation.case.*", { id: "liq-T7", kind: "dil", status: "accepted", interior_bpo_within_90_days: false, transition: false });
  const accepted = h.emitted("liquidation.case.status_changed")[0]!; assert.equal(triggers("FNMA_D23302_DIL_INSPECTION_60", accepted), true); assert.equal(triggers("FNMA_D23302_DIL_DOCS_60", accepted), true);
  const docs = h.timer("FNMA_D23302_DIL_DOCS_60")[0]!; assert.equal(docs.anchorDate, "2026-10-15"); assert.equal(docs.dueDate, "2026-12-14");
  const insp = h.timer("FNMA_D23302_DIL_INSPECTION_60")[0]!; assert.equal(insp.status, "armed"); assert.equal(insp.dueDate, "2026-12-14");
  assert.equal(h.timer("FNMA_E3401_SS_APPROVED_HOLD_60")[0]!.dueDate, "2026-12-14");   // DIL acceptance → 60-day hold on the next legal action (E-3.4-01)
  await h.rejects("liquidation.case.*", { id: "liq-T7", op: "inspection_received", report_doc_id: "doc-insp-T7", received_on: "2026-10-01", interior: true, vacant: true, secure: true, broom_swept: true }, /before acceptance/);
  h.at("2026-12-10T15:00:00.000Z"); const rep = await h.run("liquidation.case.*", { id: "liq-T7", op: "inspection_received", report_doc_id: "doc-insp-T7", received_on: "2026-12-10", interior: true, vacant: true, secure: true, broom_swept: false, hazards: ["debris"], personal_property_value_cents: 60_000n });
  assert.deepEqual([rep.event_type, rep.due_by, rep.late, rep.vacant_secure_confirmed, rep.remediation_required, rep.personal_property_fnma_approval_required], ["inspection.report.received", "2026-12-14", false, true, true, true]);
  const report = h.emitted("inspection.report.received")[0]!; assert.deepEqual([report.payload.case_id, report.payload.report_doc_id, report.payload.received_on, report.payload.vacant, report.payload.secure, report.payload.hazards], ["liq-T7", "doc-insp-T7", "2026-12-10", true, true, ["debris"]]);
  assert.equal(satisfies("FNMA_D23302_DIL_INSPECTION_60", report), true); assert.equal(insp.status, "satisfied"); assert.equal(docs.status, "armed");
  h.at("2026-12-14T15:00:00.000Z"); await h.run("liquidation.case.*", { id: "liq-T7", status: "documenting_extended" });
  const weekly = h.timer("FNMA_D23302_DIL_WEEKLY_UPDATE_7"); assert.equal(weekly.length, 1); assert.equal(weekly[0]!.dueDate, "2026-12-21");
  h.at("2026-12-21T15:00:00.000Z"); await h.run("liquidation.case.*", { id: "liq-T7", op: "weekly_update", update: "title vendor: lien payoff letters in hand" });
  assert.equal(h.emitted("liquidation.dil.weekly_update.logged").length, 1); assert.equal(weekly[0]!.status, "satisfied"); assert.equal(h.timer("FNMA_D23302_DIL_WEEKLY_UPDATE_7").length, 2); assert.equal(h.timer("FNMA_D23302_DIL_WEEKLY_UPDATE_7")[1]!.dueDate, "2026-12-28");
  h.at("2027-01-13T15:00:00.000Z"); await h.run("liquidation.case.*", { id: "liq-T7", status: "documents_complete" }); assert.equal(docs.status, "satisfied");
  // A prior interior BPO ≤90 days old means no inspection row is armed at all (D2-3.3-02).
  const g = liquidationHarness("L-129-T7b", "2026-10-15T15:00:00.000Z");
  await g.run("liquidation.case.*", { id: "liq-T7b", kind: "dil", status: "accepted", interior_bpo_within_90_days: true, transition: false });
  assert.equal(g.timer("FNMA_D23302_DIL_INSPECTION_60").length, 0); assert.equal(g.timer("FNMA_D23302_DIL_DOCS_60").length, 1);
});
test("12.9-T8: (deed timing) sale 2026-12-01; executed deed received 2026-11-05 (26 days before) → Fannie Mae prior approval required; received 2026-10-30 → allowed; recordation submitted within 5 BD; lien release within 30 BD after inspection confirms vacancy.", async () => {
  assert.equal(deedTiming(D("2026-11-05"), D("2026-12-01")), "fnma_prior_approval"); assert.equal(deedTiming(D("2026-10-30"), D("2026-12-01")), "allowed");
  const r = dilCase({ acceptance_on: D("2026-10-15"), exit_option: "immediate", deed_accepted_on: D("2026-10-30"), vacancy_confirmed_on: D("2026-11-10") });
  assert.equal(r.deed_recordation_submit_by, "2026-11-06");   // 5 servicer BD after acceptance of the executed deed (FNMA_D23302_DIL_DEED_RECORD_5BD)
  assert.equal(r.lien_release_due, "2026-12-24");            // 30 servicer BD after the later of acceptance and the vacancy/security inspection (FNMA_D23302_DIL_LIEN_RELEASE_30BD; Thanksgiving skipped)
  assert.equal(dilCase({ acceptance_on: D("2026-10-15"), exit_option: "immediate" }).lien_release_due, null);
  // Loan A on the bus: the 13.x sale date (2026-12-01) is re-stated for the open Mortgage Release with `dil_case_open` and the 30-day deed cut-off (2026-11-01); the deed accepted 2026-11-05 satisfies the gate late and needs Fannie Mae's prior approval.
  const a = liquidationHarness("L-129-T8a", "2026-10-20T15:00:00.000Z");
  const none = await a.run("liquidation.case.*", { op: "sale_scheduled", sale_date: "2026-12-01" }); assert.equal(none.dil_case_open, false); assert.equal(a.timer("FNMA_D23302_DIL_DEED_BEFORE_SALE_30").length, 0);   // no DIL case → nothing to gate
  await a.run("liquidation.case.*", { id: "liq-T8a", kind: "dil", status: "accepted", interior_bpo_within_90_days: true, transition: false });
  const sched = await a.run("liquidation.case.*", { op: "sale_scheduled", sale_date: "2026-12-01", source: "foreclosure_timelines (13.x)" });
  assert.deepEqual([sched.event_type, sched.dil_case_open, sched.deed_cutoff, sched.deed_timing, sched.fnma_prior_approval_required], ["foreclosure.sale_scheduled", true, "2026-11-01", null, false]);
  const saleEv = a.emitted("foreclosure.sale_scheduled")[1]!; assert.deepEqual([saleEv.payload.sale_date, saleEv.payload.dil_case_open, saleEv.payload.case_id, saleEv.payload.deed_cutoff], ["2026-12-01", true, "liq-T8a", "2026-11-01"]);
  assert.equal(triggers("FNMA_D23302_DIL_DEED_BEFORE_SALE_30", saleEv), true); assert.equal(triggers("FNMA_D23302_DIL_DEED_BEFORE_SALE_30", a.emitted("foreclosure.sale_scheduled")[0]!), false);
  const gate = a.timer("FNMA_D23302_DIL_DEED_BEFORE_SALE_30")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2026-12-01"); assert.equal(gate.dueDate, "2026-11-01");
  await a.rejects("liquidation.case.*", { id: "liq-T8a", status: "deed_received" }, /DEED_NEEDS_TITLE_AND_INSPECTION/);   // no deed acceptance without title verification and inspection (12.9 guardrail)
  a.at("2026-11-05T15:00:00.000Z"); assert.equal(a.timers.evaluate("2026-11-05T15:00:00.000Z").some((b) => b.instance.code === "FNMA_D23302_DIL_DEED_BEFORE_SALE_30"), true);
  await a.run("liquidation.case.*", { id: "liq-T8a", status: "deed_received", title_verified: true, inspection_done: true, transition: false });
  assert.equal(satisfies("FNMA_D23302_DIL_DEED_BEFORE_SALE_30", a.emitted("liquidation.case.status_changed").at(-1)!), true); assert.equal(gate.status, "satisfied_late");
  const after = await a.run("liquidation.case.*", { op: "sale_scheduled", sale_date: "2026-12-01" }); assert.equal(after.deed_timing, "fnma_prior_approval"); assert.equal(after.fnma_prior_approval_required, true);
  assert.equal(projectLiquidationCase(a.events, "L-129-T8a")!.deed_received_on, "2026-11-05");
  // The platform's own `foreclosure.sale.scheduled{sale_at}` (13.x/15.x) reaches the same handler through the listener.
  const off = attachSaleScheduleListener(a.env()); a.events.append({ type: "foreclosure.sale.scheduled", loanId: "L-129-T8a", actor: AGENT, payload: { sale_at: "2026-12-15" } }); off();
  const restated = a.emitted("foreclosure.sale_scheduled").at(-1)!; assert.deepEqual([restated.payload.sale_date, restated.payload.dil_case_open, restated.payload.deed_timing], ["2026-12-15", true, "allowed"]); assert.match(restated.payload.source as string, /^foreclosure\.sale\.scheduled/);
  // Loan B: the deed accepted 2026-10-30 satisfies the gate on time; its acceptance arms the 5-BD recordation row (due 2026-11-06, satisfied by `erecording.submitted`) and the 30-day relocation row (due 2026-11-29, satisfied by the disbursement); the vacancy/security confirmation on 2026-11-10 arms the 30-BD lien-release row (due 2026-12-24).
  const b = liquidationHarness("L-129-T8b", "2026-10-15T15:00:00.000Z");
  await b.run("liquidation.case.*", { id: "liq-T8b", kind: "dil", status: "accepted", interior_bpo_within_90_days: true, transition: false });
  await b.run("liquidation.case.*", { op: "sale_scheduled", sale_date: "2026-12-01" }); const gateB = b.timer("FNMA_D23302_DIL_DEED_BEFORE_SALE_30")[0]!; assert.equal(gateB.dueDate, "2026-11-01");
  b.at("2026-10-30T15:00:00.000Z"); await b.run("liquidation.case.*", { id: "liq-T8b", status: "deed_received", title_verified: true, inspection_done: true, transition: false });
  assert.equal(gateB.status, "satisfied"); assert.equal((await b.run("liquidation.case.*", { op: "sale_scheduled", sale_date: "2026-12-01" })).deed_timing, "allowed");
  const rec = b.timer("FNMA_D23302_DIL_DEED_RECORD_5BD")[0]!; assert.equal(rec.anchorDate, "2026-10-30"); assert.equal(rec.dueDate, "2026-11-06");
  const reloc = b.timer("FNMA_D23302_DIL_RELOCATION_30")[0]!; assert.equal(reloc.anchorDate, "2026-10-30"); assert.equal(reloc.dueDate, "2026-11-29");
  assert.equal(b.timer("FNMA_D23302_DIL_LIEN_RELEASE_30BD").length, 0);   // vacancy/security not yet confirmed
  b.at("2026-11-04T15:00:00.000Z"); const pkg = await (b.rt.ports.erecording as FakeErecording).createPackage({ releaseTaskId: "deed-T8b", attempt: 1, county: "Dallas", state: "TX", documentSha256: "sha-deed-T8b" }, b.clock.now());
  await b.run("erecording.submit", { document_id: "deed-T8b", package_id: pkg.packageId, officer_signature_date: "2026-11-04" }); assert.equal(b.emitted("erecording.submitted").length, 1); assert.equal(rec.status, "satisfied");
  b.at("2026-11-20T15:00:00.000Z"); const paid = await b.run("liquidation.case.*", { id: "liq-T8b", op: "relocation_disbursed", payer: "servicer", disbursed_on: "2026-11-20", remediation_estimate_cents: 50_000n });
  assert.deepEqual([paid.amount_cents, paid.due_by, paid.late], [700_000n, "2026-11-29", false]); assert.equal(reloc.status, "satisfied");
  const rp = b.emitted("relocation.disbursed")[0]!; assert.deepEqual([rp.payload.kind, rp.payload.amount_cents, rp.payload.remediation_estimate_cents, rp.payload.due_by], ["dil", "700000", "50000", "2026-11-29"]);
  b.at("2026-11-10T15:00:00.000Z"); const insp = await b.run("liquidation.case.*", { id: "liq-T8b", op: "inspection_received", report_doc_id: "doc-insp-T8b", received_on: "2026-11-10", interior: true, vacant: true, secure: true, broom_swept: true }); assert.equal(insp.vacant_secure_confirmed, true);
  await b.run("liquidation.case.*", { id: "liq-T8b", status: "deed_received", title_verified: true, inspection_done: true, vacant_secure_confirmed: true, transition: false });
  const lien = b.timer("FNMA_D23302_DIL_LIEN_RELEASE_30BD")[0]!; assert.equal(lien.status, "armed"); assert.equal(lien.anchorDate, "2026-11-10"); assert.equal(lien.dueDate, "2026-12-24");
});
test("12.9-T9: (lease option) borrower in active Chapter 13 → 12-month lease refused; 3-month transition allowed (principal residence).", () => {
  const lease = dilExitOption("12_month", true, true); assert.equal(lease.allowed, false); assert.match(lease.refusal!, /Chapter 13/);
  assert.equal(dilExitOption("3_month", true, true).allowed, true); assert.equal(dilExitOption("3_month", false, false).allowed, false); assert.equal(dilExitOption("12_month", false, true).allowed, true);
});
test("12.9-T10: (holds) during the listing period 13.x motion for judgment is refused (41(g)(3)-1); after approval, sale refused for 60 days; CA loan → NOD rescission task within 5 BD.", async () => {
  const listing = liquidationHolds({ phase: "listing", today: D("2026-10-20"), requested: "motion_for_judgment" }); assert.equal(listing.allowed, false); assert.match(listing.refusal!, /41\(g\)\(3\)-1/);
  const approved = liquidationHolds({ phase: "approved", approved_on: D("2026-10-28"), state: "CA", today: D("2026-12-01"), requested: "sale" }); assert.equal(approved.allowed, false); assert.equal(approved.hold_until, "2026-12-27"); assert.equal(approved.ca_rescission_task_by, "2026-11-04");
  assert.equal(liquidationHolds({ phase: "approved", approved_on: D("2026-10-28"), state: "TX", today: D("2026-12-27"), requested: "sale" }).allowed, true);
  // On the bus: the CA approval with proof of funds arms `CA_CIV_2924_11C_RESCIND_NOD` (5 servicer BD → 2026-11-04) and the 60-day E-3.4-01 hold (→ 2026-12-27); counsel's recorded rescission satisfies the first.
  const h = liquidationHarness("L-129-T10", "2026-10-20T15:00:00.000Z");
  await h.run("liquidation.case.*", { id: "liq-T10", kind: "short_sale", status: "listing", state: "CA" });
  const hold = await h.run("liquidation.case.*", { op: "hold_check", phase: "listing", requested: "motion_for_judgment" }); assert.equal(hold.allowed, false); assert.match(hold.refusal as string, /41\(g\)\(3\)-1/);
  await h.rejects("liquidation.case.*", { id: "liq-T10", op: "nod_rescinded", instrument_no: "2026-0123456" }, /approved short sale with proof of funds/);
  h.at("2026-10-28T15:00:00.000Z"); await h.run("liquidation.case.*", { id: "liq-T10", status: "approved", smdu_decision_id: "smdu-T10", proof_of_funds: true });
  const approvedEv = h.emitted("liquidation.case.status_changed").at(-1)!; assert.deepEqual([approvedEv.payload.state, approvedEv.payload.proof_of_funds, approvedEv.payload.status_on], ["CA", true, "2026-10-28"]); assert.equal(triggers("CA_CIV_2924_11C_RESCIND_NOD", approvedEv), true);
  const rescind = h.timer("CA_CIV_2924_11C_RESCIND_NOD")[0]!; assert.equal(rescind.status, "armed"); assert.equal(rescind.anchorDate, "2026-10-28"); assert.equal(rescind.dueDate, "2026-11-04");
  const e3401 = h.timer("FNMA_E3401_SS_APPROVED_HOLD_60")[0]!; assert.equal(e3401.dueDate, "2026-12-27");
  const saleHold = await h.run("liquidation.case.*", { op: "hold_check", phase: "approved", approved_on: "2026-10-28", state: "CA", requested: "sale" }); assert.equal(saleHold.allowed, false); assert.equal(saleHold.ca_rescission_task_by, "2026-11-04");
  h.at("2026-11-02T15:00:00.000Z"); const done = await h.run("liquidation.case.*", { id: "liq-T10", op: "nod_rescinded", instrument_no: "2026-0123456", county: "Los Angeles", recorded_on: "2026-11-02" });
  assert.deepEqual([done.event_type, done.due_by, done.late], ["foreclosure.nod.rescinded", "2026-11-04", false]);
  const nod = h.emitted("foreclosure.nod.rescinded")[0]!; assert.deepEqual([nod.payload.case_id, nod.payload.recorded_on, nod.payload.instrument_no, nod.payload.rule_citation], ["liq-T10", "2026-11-02", "2026-0123456", "Cal. Civ. Code §2924.11(c)"]);
  assert.equal(satisfies("CA_CIV_2924_11C_RESCIND_NOD", nod), true); assert.equal(rescind.status, "satisfied"); assert.equal(e3401.status, "armed");
  // A Texas approval arms no rescission row, and the op refuses it.
  const g = liquidationHarness("L-129-T10b", "2026-10-28T15:00:00.000Z");
  await g.run("liquidation.case.*", { id: "liq-T10b", kind: "short_sale", status: "approved", smdu_decision_id: "smdu-T10b", proof_of_funds: true, state: "TX" });
  assert.equal(g.timer("CA_CIV_2924_11C_RESCIND_NOD").length, 0); await g.rejects("liquidation.case.*", { id: "liq-T10b", op: "nod_rescinded", instrument_no: "X" }, /California/);
});
test("12.9-T11: (incentive tiers) 200 days delinquent at closing → $2,500; 250 → $1,500; 320 → $750.", () => {
  assert.deepEqual([incentive(200), incentive(250), incentive(320)], [250_000n, 150_000n, 75_000n]);
  assert.deepEqual([incentive(210), incentive(211), incentive(300), incentive(301)], [250_000n, 150_000n, 150_000n, 75_000n]);   // tier boundaries ≤210 / 211–300 / >300 (F-2-02)
});
test("12.9-T12: (Military Indulgence) DMDC-verified active duty with pre-service loan → indulgence case, 6% cap applied retroactively (13.9), late charges after call-up waived, status 32, quarterly contact timer.", () => {
  const r = militaryIndulgence({ dmdc_verified: true, loan_originated_on: D("2021-10-01"), service_started_on: D("2026-08-01"), note_rate_pct: "6.500", late_charges_after_callup_cents: 12_642n });
  assert.equal(r.case_opened, true); assert.equal(r.rate_cap_pct, "6.000"); assert.equal(r.cap_applies, true); assert.equal(r.retroactive_from, "2026-08-01"); assert.equal(r.late_charges_waived_cents, 12_642n); assert.equal(r.status_code, "32");
  // D2-3.4-01's "contact at least every three months" has no row in the timer registry (12.9's list omits it): the cadence is stated without a registry code.
  assert.deepEqual(r.quarterly_contact, { basis: "D2-3.4-01: contact at least every three months", every_days: 90, first_contact_by: "2026-10-30", registry_timer: null });
  assert.equal(militaryIndulgence({ dmdc_verified: false, loan_originated_on: D("2021-10-01"), service_started_on: D("2026-08-01"), note_rate_pct: "6.500", late_charges_after_callup_cents: 0n }).case_opened, false);
  assert.equal(militaryIndulgence({ dmdc_verified: true, loan_originated_on: D("2026-09-01"), service_started_on: D("2026-08-01"), note_rate_pct: "6.500", late_charges_after_callup_cents: 0n }).case_opened, false);
});

test("12.9 worked figures: relocation $7,500.00 less third-party assistance; reserves over $50,000.00 route non-delegated", () => {
  assert.equal(relocation(false, 0n), 750000n); assert.equal(relocation(true, 0n), 0n); assert.equal(relocation(false, 100000n), 650000n); assert.equal(delegationRouting({ reserves_cents: 5000001n, net_proceeds_within_parameters: true }).route, "non_delegated");
  const np = netProceeds(27500000n, { commission: 1650000n, prorations: 0n, transfer_taxes: 0n, title_settlement: 0n, seller_attorney: 0n, hoa_past_due: 0n, subordinate_liens: 600000n, relocation: 750000n });
  assert.equal(np.net_cents, 24500000n); assert.equal(np.commission_ok, true); assert.equal(np.subordinate_ok, true);
  assert.equal(netProceeds(27500000n, { commission: 1650001n, prorations: 0n, transfer_taxes: 0n, title_settlement: 0n, seller_attorney: 0n, hoa_past_due: 0n, subordinate_liens: 600001n, relocation: 0n }).commission_ok, false);
});

test("12.9 ops-12-9 validates inbound records against the case's event stream directly (no bus): no case → refused; short-sale proceeds on a DIL → refused; DIL inspection on a short sale → refused; valuation as_of after receipt → refused", () => {
  const clock = new FixedClock("2026-10-20T15:00:00.000Z"); const events = new MemoryEventStore(clock); const env = { events, actor: LIQUIDATION_ACTOR, now: clock.now() };
  assert.throws(() => recordClosingFundsReceived(env, { loan_id: "L-none", amount_cents: 1n }), /no liquidation case/);
  assert.throws(() => recordForeclosureSaleScheduled(env, { loan_id: "", sale_date: D("2026-12-01") }), /loan_id is required/);
  events.append({ type: "liquidation.case.status_changed", loanId: "L-x", actor: AGENT, payload: { case_id: "liq-x", kind: "dil", status: "accepted", status_on: "2026-10-15", transition: false } });
  assert.throws(() => recordClosingFundsReceived(env, { loan_id: "L-x", amount_cents: 100n }), /Mortgage Release/);
  assert.throws(() => disburseRelocation(env, { loan_id: "L-x", payer: "servicer" }), /after the executed deed is accepted/);
  assert.throws(() => recordNodRescinded(env, { loan_id: "L-x", instrument_no: "1" }), /California/);
  events.append({ type: "liquidation.case.status_changed", loanId: "L-y", actor: AGENT, payload: { case_id: "liq-y", kind: "short_sale", status: "approved", status_on: "2026-10-20", state: "CA", proof_of_funds: true } });
  assert.throws(() => recordInspectionReport(env, { loan_id: "L-y", report_doc_id: "d", interior: true, vacant: true, secure: true, broom_swept: true }), /short sale/);
  assert.throws(() => disburseRelocation(env, { loan_id: "L-y", payer: "servicer" }), /closing agent/);
  events.append({ type: "valuation.ordered", loanId: "L-y", actor: AGENT, payload: { valuation_id: "v1", kind: "bpo" } });
  assert.throws(() => recordValuationReceived(env, { loan_id: "L-y", valuation_id: "v1", method: "bpo", value_cents: 1n, as_of: D("2026-10-25") }), /after receipt/);
  const late = recordValuationReceived({ ...env, now: "2026-11-05T15:00:00.000Z" }, { loan_id: "L-y", valuation_id: "v1", method: "bpo", value_cents: 27_500_000n, as_of: D("2026-10-25") }); assert.equal(late.order_to_receipt_days, 16); assert.equal(late.sla_met, false);
  const view = projectLiquidationCase(events, "L-y")!; assert.equal(view.valuations[0]!.received_on, "2026-11-05"); assert.equal(view.approved_on, "2026-10-20"); assert.equal(view.proof_of_funds, true);
});
