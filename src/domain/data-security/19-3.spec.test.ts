// 19.3 Fannie Mae data/tech-provider requirements
// spec/sections/19-data-security-recordkeeping/19-3-fannie-mae-data-tech-provider-requirements.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { fannieEt } from "../../kernel/calendar/business.ts";
import { subservicingTermination, integrationDrift, vendorReassessment, deployGate, form582ThirdPartyPackage, classifyContractEvent, thresholdSnapshot, clauseEntry, clauseChecklist, requiredClauses, vendorTransition, contractExpiryWarnings, changeNoticeSent, assertGateOpen, GateClosed, fnmaAdapterCall, withForm101Gate, Form101Inactive, form101Status, fnmaRequestDue, fnmaRequestReceived, subservicingArrangementEffective, subservicingArrangementTerminated, dataReturnDirectedByTermination, integrationDriftDetected, integrationDriftSweep, integrationComplianceRestored, vendorIncidentReported, vendorIncidentNoticeReceived, aiPolicyApproved, aiPolicyReviewed, signatureReferencesNotice, type Form101Row } from "./ops-19-3.ts";
import { earliestCutover, cutoverAllowed, contractCopiesDue, transitionPlanDue, disclosureResponseDue, reassessment } from "./vendors.ts";
import { form629Clocks } from "../transfers/batch.ts";
import { form582Clocks } from "../qc-audit/form582.ts";
import { evaluateGate, assertGate, GateClosed as GateClosedApp } from "../../app/evaluators.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { NoticeService, type Notice } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { TOOLS_19_3 } from "../../app/tools/section19-3.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";

const AGENT: Actor = { kind: "agent", id: "security-records" };
const OFFICER: Actor = { kind: "human", id: "officer-1", role: "officer" };
const ATTORNEY: Actor = { kind: "human", id: "atty-1", role: "attorney" };
const OPERATOR: Actor = { kind: "human", id: "op-1", role: "fnma_portal_operator" };
const reg = buildRegistry(); publishAuthored(reg);
type Out = Record<string, unknown>;
type Harness = { bus: CommandBus; clock: FixedClock; ctx: UowContext & { decisions: DecisionInput[] }; rt: ToolRuntime; run: (name: string, input: Record<string, unknown>, actor?: Actor) => Promise<Out> };
/** A one-process bus over the 19.3 tools: the overridden registry's 19.3 timers arm and close on the events the tools append. */
function bus19_3(nowIso: string): Harness {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["19.3"] });
  const ctx = { loanId: "", events, ledger: new MemoryLedger(), timers, clock, decide: (d: DecisionInput) => { decisions.push(d); }, decisions } as UowContext & { decisions: DecisionInput[] };
  const notices = new NoticeService({ registry: reg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {}, notices };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const escalates = loadAgentsFile().processes.find((p) => p.process === "19.3")!.escalates_to;
  const cmds = new Map(TOOLS_19_3.map((d) => { const c = toolCommand(d, rt, escalates); agents.registerTool(d.agent, c.name); return [d.name, c] as const; }));
  return { bus, clock, ctx, rt, run: (name, input, actor = AGENT) => bus.execute(cmds.get(name)!, actor, input, ctx).then((r) => r.output as Out) };
}
/** Clause rows as `contracts.extractClauses` takes them — every code `present` with its evidence excerpt (rule 6 guardrail). */
const clauseRows = (codes: readonly string[]): Record<string, unknown>[] => codes.map((c) => ({ clause_code: c, status: "present", evidence_excerpt: `executed contract clause ${c}`, citation: "A2-1-01 / A2-1-07 / Technology Guide / Supplement / LL-2026-04" }));
const refused = (code: string) => (e: unknown): boolean => e instanceof CommandRefused && e.code === code;

test("19.3-T1: Given partner counts 19,990 on Jan 1–Aug 2 and 20,300 on Aug 3, 2027, then `a2101_regime_active` = true for 2027 from Aug 3 and stays true through Dec 31 even if the count later falls to 18,000.", async () => {
  const counts = [{ on: D("2027-01-01"), count: 19990 }, { on: D("2027-08-02"), count: 19990 }, { on: D("2027-08-03"), count: 20300 }, { on: D("2027-11-01"), count: 18000 }];
  assert.equal(thresholdSnapshot({ entity: "partner", counts_this_year: counts, as_of: D("2027-08-02"), previous_active: false }).a2101_regime_active, false);
  const aug3 = thresholdSnapshot({ entity: "partner", counts_this_year: counts, as_of: D("2027-08-03"), previous_active: false });
  assert.equal(aug3.a2101_regime_active, true); assert.equal(aug3.changed, true); assert.equal(aug3.year_max, 20300); assert.match(aug3.basis, /2027 max 20300 ≥ 20000/);
  const dec31 = thresholdSnapshot({ entity: "partner", counts_this_year: counts, as_of: D("2027-12-31"), previous_active: true });
  assert.equal(dec31.a2101_regime_active, true); assert.equal(dec31.loan_count, 18000); assert.equal(dec31.year_max, 20300); assert.equal(dec31.changed, false);   // sticky for the rest of the calendar year
  assert.equal(thresholdSnapshot({ entity: "partner", counts_this_year: [...counts, { on: D("2028-01-01"), count: 18000 }], as_of: D("2028-01-15"), previous_active: true }).a2101_regime_active, false);   // re-tested each January 1
  // the daily monitor on the bus: the prior status is read from the stored snapshot and the crossing is logged with its count basis
  const h = bus19_3("2027-08-02T11:00:00.000Z");
  assert.equal((await h.run("portfolio.count", { entity: "partner", as_of: "2027-08-02", loan_count: 19990 })).a2101_regime_active, false);
  h.clock.set("2027-08-03T11:00:00.000Z");
  const d2 = await h.run("portfolio.count", { entity: "partner", as_of: "2027-08-03", loan_count: 20300 });
  assert.equal(d2.a2101_regime_active, true); assert.equal(d2.changed, true); assert.equal(d2.previous_active, false);
  const crossed = h.ctx.events.ofType("threshold.a2101.crossed"); assert.equal(crossed.length, 1); assert.match(String(crossed[0]!.payload.basis), /partner: 20300 loans owned and\/or serviced on 2027-08-03; 2027 max 20300 ≥ 20000/);
  h.clock.set("2027-11-01T11:00:00.000Z");
  const d3 = await h.run("portfolio.count", { entity: "partner", as_of: "2027-11-01", loan_count: 18000 });
  assert.equal(d3.a2101_regime_active, true); assert.equal(d3.changed, false); assert.equal(d3.year_max, 20300);
  assert.equal(h.ctx.events.ofType("threshold.a2101.crossed").length, 1); assert.equal(h.ctx.events.ofType("portfolio_threshold_snapshot.written").length, 3);
  await assert.rejects(h.run("portfolio.count", { entity: "partner", as_of: "2027-11-02" }), refused("THRESHOLD_CHANGE_LOGGED_WITH_BASIS"));
});
test("19.3-T2: Given a change notice sent 2026-11-02, then `earliest_cutover_at` = 2027-05-01 and a cutover command dated 2027-04-01 is rejected by `assertGateOpen`.", async () => {
  assert.equal(earliestCutover(D("2026-11-02")), "2027-05-01"); assert.equal(cutoverAllowed(D("2026-11-02"), D("2027-04-01")), false);
  assert.deepEqual(changeNoticeSent({ notice_sent_at: D("2026-11-02"), planned_cutover_at: D("2027-04-01") }), { earliest_cutover_at: "2027-05-01", planned_cutover_blocked: true, status: "notice_sent" });
  assert.throws(() => assertGateOpen({ action: "tech_provider.change.cutover", notice_sent_at: D("2026-11-02"), cutover_on: D("2027-04-01") }), (e: unknown) => e instanceof GateClosed && e.opens_on === "2027-05-01" && e.escalation.kind === "sev1");
  assert.equal(assertGateOpen({ action: "tech_provider.change.cutover", notice_sent_at: D("2026-11-02"), cutover_on: D("2027-05-01") }).earliest_cutover_at, "2027-05-01");
  assert.equal(evaluateGate("19.3.cutoverGateOpen", { notice_sent_at: "2026-11-02", cutover_on: "2027-04-01" }).open, false);
  assert.equal(evaluateGate("19.3.cutoverGateOpen", { notice_sent_at: "2026-11-02", cutover_on: "2027-05-01" }).open, true);
  assert.match(evaluateGate("19.3.cutoverGateOpen", { cutover_on: "2027-05-01" }).reason!, /no 180-day written notice/);
  // on the bus: the officer records the notice (arms the gate), a 2027-04-01 cutover command is rejected and raises sev-1, the agent may never run one, and 2027-05-01 executes and closes the gate
  const h = bus19_3("2026-11-02T15:00:00.000Z");
  const rec = await h.run("fnma_notices.recordSent", { kind: "a2101_change_180", entity: "partner", document_id: "doc-change-notice", sent_by: "officer-1", sent_at: "2026-11-02", tech_provider_change_id: "tpc-1", planned_cutover_at: "2027-04-01", provider_from: "Supermortgage Servicing LLC", provider_to: "NextServ Platform Inc.", recorded_by_officer: true }, OFFICER);
  const life = rec.lifecycle as Out; assert.equal(life.earliest_cutover_at, "2027-05-01"); assert.equal(life.planned_cutover_blocked, true); assert.equal(life.status, "notice_sent");
  const gate = h.ctx.timers.byCode("FNMA_A2101_TECH_PROVIDER_CHANGE_NOTICE_180"); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "armed"); assert.equal(gate[0]!.anchorDate, "2026-11-02"); assert.match(gate[0]!.note ?? "", /19\.3\.cutoverGateOpen/);
  assert.equal(h.ctx.timers.byCode("SM_A2101_CHANGE_NOTICE_DRAFT_5BD").length, 0);   // the notice, not the intent, was recorded
  // the replacement provider is a Tier 1 critical provider (rule 2: payment processing, remitting, reporting): onboarding assessment, SOC 2 / BCP evidence and the officer's approval on the stored checklist; going live is the cutover
  await h.run("contracts.extractClauses", { contract_id: "c-nextserv", kind: "vendor_msa", executed_at: "2026-10-15", expires_at: "2030-10-14", clauses: clauseRows(requiredClauses({ ai_provider: false })) });
  await h.run("vendors.setStatus", { vendor_id: "v-nextserv", status: "due_diligence", tier: 1, contract_id: "c-nextserv" });
  await h.run("vendors.assess", { vendor_id: "v-nextserv", kind: "onboarding", completed_at: "2026-10-20", approved_by: "officer-1" }, OFFICER);
  await assert.rejects(h.run("vendors.setStatus", { vendor_id: "v-nextserv", status: "approved", soc2_period_end: "2026-06-30", bcp_evidence_document_id: "doc-bcp-nextserv" }, AGENT), refused("TIER1_ACTIVATION_OFFICER"));   // the record's tier governs, not the caller's omission of it
  assert.equal((await h.run("vendors.setStatus", { vendor_id: "v-nextserv", status: "approved", soc2_period_end: "2026-06-30", soc2_report_document_id: "doc-soc2-nextserv", bcp_evidence_document_id: "doc-bcp-nextserv", officer_approval: true }, OFFICER)).allowed, true);
  assert.equal(h.rt.store.get("vendors", "v-nextserv")!.data.tier, "1_critical");
  h.clock.set("2027-04-01T15:00:00.000Z");
  await assert.rejects(h.run("vendors.setStatus", { vendor_id: "v-nextserv", status: "active", tech_provider_change_id: "tpc-1", cutover_on: "2027-04-01" }, OFFICER), (e: unknown) => e instanceof GateClosed && e.opens_on === "2027-05-01" && /before the earliest permissible cutover 2027-05-01/.test(e.message));
  assert.ok(h.rt.escalations.opened.some((e) => e.kind === "sev1" && e.payload.gate === "FNMA_A2101_TECH_PROVIDER_CHANGE_NOTICE_180"));
  assert.equal(h.ctx.events.ofType("tech_provider.change.cutover_refused").length, 1); assert.equal(h.rt.store.get("vendors", "v-nextserv")!.data.status, "approved");
  await assert.rejects(h.run("vendors.setStatus", { vendor_id: "v-nextserv", status: "active", tech_provider_change_id: "tpc-1", cutover_on: "2027-05-01" }, AGENT), refused("AGENT_CANNOT_EXECUTE_CUTOVER"));
  h.clock.set("2027-05-01T15:00:00.000Z");
  const live = await h.run("vendors.setStatus", { vendor_id: "v-nextserv", status: "active", tech_provider_change_id: "tpc-1", cutover_on: "2027-05-01" }, OFFICER);
  assert.equal(live.allowed, true); assert.equal((live.cutover as Out).earliest_cutover_at, "2027-05-01");
  assert.equal(h.ctx.timers.byCode("FNMA_A2101_TECH_PROVIDER_CHANGE_NOTICE_180")[0]!.status, "satisfied");
  assert.equal(h.rt.store.get("tech_provider_changes", "tpc-1")!.data.status, "cutover"); assert.equal(h.ctx.events.ofType("tech_provider.change.cutover").length, 1);
});
test("19.3-T3: Given a default notice sent to the partner on Fri 2026-11-20, then `FNMA_A2101_CONTRACT_COPIES_5BD` is due Mon 2026-11-30 EOD ET; a copy sent Dec 1 breaches sev-1.", async () => {
  const nod = classifyContractEvent({ kind: "default_notice", direction: "sent_to_servicer", occurred_on: D("2026-11-20"), contract_kind: "tech_provider_addendum" });
  assert.equal(nod.copies_required, true); assert.equal(nod.copies_due, "2026-11-30"); assert.equal(contractCopiesDue(D("2026-11-20")), "2026-11-30");
  assert.equal(fannieEt.isBusinessDay(D("2026-11-26")), false);   // Mon 23, Tue 24, Wed 25, [Thu 26 Thanksgiving], Fri 27, Mon 30
  assert.equal(nod.fnma_notice_required, true); assert.equal(nod.event_notice_due, "2026-11-30");   // the partner's own 5-BD notice is due the same day ("default to notify")
  assert.equal(nod.ambiguous, true); assert.equal(nod.attorney_confirm_by, "2026-11-30"); assert.deepEqual(nod.notices_required, ["a2101_event_5bd", "a2101_copies_5bd"]);
  // on the bus: drafting the cover records the event and arms the copies clock to Mon 2026-11-30 end of day ET; a copy recorded Dec 1 is late → sev-1 → officer
  const h = bus19_3("2026-11-20T20:00:00.000Z");
  const cp = reg.activeVersion("NTC_FNMA_A2101_CONTRACT_COPIES_5BD", D("2026-09-01"))!;
  const out = await h.run("notices.draft", { template_code: "NTC_FNMA_A2101_CONTRACT_COPIES_5BD", notice_date: "2026-11-25", contract_event: { id: "ce-nod", contract_id: "c-partner", kind: "default_notice", direction: "sent_to_servicer", occurred_on: "2026-11-20", contract_kind: "tech_provider_addendum" }, payload: cp.samplePayload });
  assert.equal((out.clocks as Out).copies_due, "2026-11-30"); assert.equal((out.draft as Notice).checklist.passed, true); assert.equal((out.draft as Notice).payload.business_days_after, 3);
  const kinds = (out.escalations as { kind: string }[]).map((e) => e.kind); assert.ok(kinds.includes("officer") && kinds.includes("attorney"));
  const copies = h.ctx.timers.byCode("FNMA_A2101_CONTRACT_COPIES_5BD"); assert.equal(copies.length, 1); assert.equal(copies[0]!.dueDate, "2026-11-30"); assert.equal(copies[0]!.anchorDate, "2026-11-20");
  assert.equal(new Date(copies[0]!.dueAt!).toISOString(), "2026-12-01T04:59:00.000Z");   // end of day ET on Mon 2026-11-30
  const own = h.ctx.timers.byCode("FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD"); assert.equal(own.length, 1); assert.equal(own[0]!.dueDate, "2026-11-30");
  assert.equal(h.ctx.timers.evaluate("2026-12-01T04:30:00.000Z").length, 0);   // still Nov 30, 23:30 ET
  const b = h.ctx.timers.evaluate("2026-12-01T05:00:00.000Z").find((x) => x.def.code === "FNMA_A2101_CONTRACT_COPIES_5BD")!;   // Dec 1, 00:00 ET
  assert.equal(b.severity, 1); assert.deepEqual(b.escalateTo, ["officer"]); assert.equal(b.instance.status, "breached");
  h.clock.set("2026-12-01T15:00:00.000Z");
  const sent = { kind: "a2101_copies_5bd", entity: "partner", document_id: "doc-copies-cover", sent_by: "officer-1", sent_at: "2026-12-01", contract_event_id: "ce-nod", recorded_by_officer: true };
  await assert.rejects(h.run("fnma_notices.recordSent", sent, OFFICER), refused("COPIES_NOTICE_NEEDS_COPY"));   // "with the copy attached"
  await h.run("fnma_notices.recordSent", { ...sent, copy_document_id: "doc-nod-2026-11-20" }, OFFICER);
  assert.equal(h.ctx.timers.byCode("FNMA_A2101_CONTRACT_COPIES_5BD")[0]!.status, "satisfied_late");
  assert.equal(h.rt.store.get("contract_events", "ce-nod")!.data.copies_notice_id, "fnma-notice-1");
  // the agent cannot record a Fannie Mae notice as sent: no signature → refused; a made-up signature id → refused
  await assert.rejects(h.run("fnma_notices.recordSent", { kind: "a2101_event_5bd", entity: "partner", document_id: "doc-x", sent_by: "officer-1", contract_event_id: "ce-nod" }, AGENT), refused("FNMA_NOTICE_SENT_BY_OFFICER"));
  await assert.rejects(h.run("fnma_notices.recordSent", { kind: "a2101_event_5bd", entity: "partner", document_id: "doc-x", sent_by: "officer-1", contract_event_id: "ce-nod", officer_signature_event_id: "not-an-event" }, AGENT), (e: unknown) => e instanceof RangeError && /officer_signature_event_id/.test(e.message));
  // the signature must be *for this notice*: an unrelated officer act (a vendor assessment) proves nothing; the officer's completed work item for the event notice does
  await h.run("vendors.setStatus", { vendor_id: "v-x", status: "due_diligence", tier: 2 });
  await h.run("vendors.assess", { vendor_id: "v-x", kind: "onboarding", completed_at: "2026-11-30" }, OFFICER);
  const unrelated = h.ctx.events.ofType("vendor_assessment.completed").at(-1)!; assert.equal(unrelated.actor.role, "officer");
  await assert.rejects(h.run("fnma_notices.recordSent", { kind: "a2101_event_5bd", entity: "partner", document_id: "doc-event-nod", sent_by: "officer-1", contract_event_id: "ce-nod", officer_signature_event_id: unrelated.id }, AGENT), (e: unknown) => e instanceof RangeError && /for this notice/.test(e.message));
  assert.equal(signatureReferencesNotice({ document_id: "doc-event-nod", contract_event_id: "ce-nod", request_id: null, authorization_id: null, tech_provider_change_id: null }, unrelated.payload), false);
  const item = h.rt.escalations.opened.find((e) => e.kind === "officer" && e.payload.contract_event_id === "ce-nod")!;
  h.rt.escalations.complete(item.id, OFFICER, "doc-event-nod");
  const signed = h.ctx.events.ofType("escalation.completed").at(-1)!;
  const viaItem = await h.run("fnma_notices.recordSent", { kind: "a2101_event_5bd", entity: "partner", document_id: "doc-event-nod", sent_by: "officer-1", sent_at: "2026-11-30", contract_event_id: "ce-nod", officer_signature_event_id: signed.id }, AGENT);
  assert.equal(viaItem.kind, "a2101_event_5bd"); assert.equal(viaItem.officer_signature_event_id, signed.id); assert.equal(h.ctx.timers.byCode("FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD")[0]!.status, "satisfied_late");
});
test("19.3-T4: Given a termination notice occurring Wed 2026-12-23, then the 5-BD notice is due Thu 2026-12-31.", async () => {
  const term = classifyContractEvent({ kind: "termination", direction: "sent_by_provider", occurred_on: D("2026-12-23"), contract_kind: "tech_provider_addendum" });
  assert.equal(term.event_notice_due, "2026-12-31"); assert.equal(term.copies_required, false); assert.deepEqual(term.notices_required, ["a2101_event_5bd"]); assert.equal(term.ambiguous, false);
  assert.equal(fannieEt.isBusinessDay(D("2026-12-25")), false);   // BD1 Thu 24, [Fri 25 Christmas], BD2 Mon 28, BD3 Tue 29, BD4 Wed 30, BD5 Thu 31
  const toServicer = classifyContractEvent({ kind: "termination", direction: "sent_to_servicer", occurred_on: D("2026-12-23"), contract_kind: "tech_provider_addendum" });
  assert.deepEqual(toServicer.notices_required, ["a2101_event_5bd", "a2101_copies_5bd"]); assert.equal(toServicer.copies_due, "2026-12-31");
  // Supermortgage's own critical providers (cloud, AI model provider …) are technology contracts through the critical-function flag, whatever the contract kind
  const cloud = classifyContractEvent({ kind: "breach_notice", direction: "sent_by_servicer", occurred_on: D("2026-12-23"), contract_kind: "vendor_msa", critical_servicing_function: true });
  assert.equal(cloud.fnma_notice_required, true); assert.equal(cloud.event_notice_due, "2026-12-31");
  assert.equal(classifyContractEvent({ kind: "breach_notice", direction: "sent_by_servicer", occurred_on: D("2026-12-23"), contract_kind: "vendor_msa" }).fnma_notice_required, false);
  // on the bus: the 5-BD clock arms from the recorded event and closes on the officer's recorded notice
  const h = bus19_3("2026-12-23T20:00:00.000Z");
  const ev = reg.activeVersion("NTC_FNMA_A2101_CONTRACT_EVENT_5BD", D("2026-09-01"))!;
  const out = await h.run("notices.draft", { template_code: "NTC_FNMA_A2101_CONTRACT_EVENT_5BD", notice_date: "2026-12-30", contract_event: { id: "ce-term", contract_id: "c-partner", kind: "termination", direction: "sent_by_provider", occurred_on: "2026-12-23", contract_kind: "tech_provider_addendum" }, payload: ev.samplePayload });
  assert.equal((out.draft as Notice).checklist.passed, true); assert.equal((out.draft as Notice).payload.business_days_after, 4);
  const inst = h.ctx.timers.byCode("FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD"); assert.equal(inst.length, 1); assert.equal(inst[0]!.dueDate, "2026-12-31"); assert.equal(inst[0]!.anchorDate, "2026-12-23");
  assert.equal(h.ctx.timers.byCode("FNMA_A2101_CONTRACT_COPIES_5BD").length, 0);
  assert.equal(h.rt.store.get("contract_events", "ce-term")!.data.fnma_notice_required, true);
  h.clock.set("2026-12-30T15:00:00.000Z");
  await h.run("fnma_notices.recordSent", { kind: "a2101_event_5bd", entity: "partner", document_id: "doc-event-notice", sent_by: "officer-1", sent_at: "2026-12-30", contract_event_id: "ce-term", recorded_by_officer: true }, OFFICER);
  assert.equal(h.ctx.timers.byCode("FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD")[0]!.status, "satisfied");
  assert.equal(h.rt.store.get("contract_events", "ce-term")!.data.fnma_notice_id, "fnma-notice-1");
});
test("19.3-T5: Given Fannie Mae requests the transition plan on 2027-01-12, then the plan is due 2027-01-27 (10 Fannie Mae BD; MLK Day Jan 18 excluded).", async () => {
  assert.equal(transitionPlanDue(D("2027-01-12")), "2027-01-27"); assert.equal(fannieEt.isBusinessDay(D("2027-01-18")), false);   // 13, 14, 15, [18 MLK], 19, 20, 21, 22, 25, 26, 27
  const r = fnmaRequestReceived({ request_id: "req-plan", kind: "transition_plan", received_on: D("2027-01-12") });
  assert.equal(r.row.due_at, "2027-01-27"); assert.equal(r.row.timer, "FNMA_A2101_TRANSITION_PLAN_ON_REQUEST_10BD"); assert.equal(r.event.payload.transition_plan, true); assert.equal(r.escalation.kind, "officer"); assert.equal(r.directed, null);
  assert.equal(fnmaRequestDue("supplement_program", D("2027-01-12")).due, "2027-01-27"); assert.equal(fnmaRequestDue("data_return", D("2027-01-12")).due, "2027-02-11");
  const h = bus19_3("2027-01-12T15:00:00.000Z");
  const out = await h.run("notices.draft", { template_code: "DOC_TRANSITION_PLAN", request_kind: "transition_plan", request_received_on: "2027-01-12", request_id: "req-plan", payload: { steps: ["data export (17.3/19.1)", "custodial handover (Section 6)", "MERS Subservicer updates", "Form 101 changes", "borrower communications", "parallel run", "rollback", "continuity of the original provider"] } });
  assert.equal((out.request as Out).due_at, "2027-01-27"); assert.ok((out.escalations as { kind: string }[]).some((e) => e.kind === "officer"));
  const t = h.ctx.timers.byCode("FNMA_A2101_TRANSITION_PLAN_ON_REQUEST_10BD"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2027-01-27"); assert.equal(t[0]!.anchorDate, "2027-01-12");
  assert.equal(h.rt.store.get("fnma_information_requests", "req-plan")!.data.due_at, "2027-01-27");
  h.clock.set("2027-01-26T15:00:00.000Z");
  await h.run("fnma_notices.recordSent", { kind: "transition_plan", entity: "partner", document_id: "doc-transition-plan-v1", sent_by: "officer-1", request_id: "req-plan", recorded_by_officer: true }, OFFICER);
  assert.equal(h.ctx.timers.byCode("FNMA_A2101_TRANSITION_PLAN_ON_REQUEST_10BD")[0]!.status, "satisfied");
  assert.equal(h.rt.store.get("fnma_information_requests", "req-plan")!.data.responded_at, "2027-01-26T15:00:00.000Z");
});
test("19.3-T6: Given a proposed Tier 1 vendor whose contract lacks `A2101_FNMA_OWNERSHIP_FILES_DATA`, then the vendor cannot reach `approved` and an `attorney` task exists.", async () => {
  const required = requiredClauses({ ai_provider: false });
  assert.ok(["A2101_COPIES_5BD", "A2101_FNMA_OWNERSHIP_FILES_DATA", "A2101_COOPERATE_TRANSFER_FEES"].every((c) => required.includes(c)));   // the three A2-1-01 clauses
  const clauses = Object.fromEntries(required.filter((c) => c !== "A2101_FNMA_OWNERSHIP_FILES_DATA").map((c) => [c, "present" as const]));
  const g = clauseChecklist(clauses, { ai_provider: false, attorney_signoff: false, officer_approval: true });
  assert.equal(g.allowed, false); assert.deepEqual(g.missing, ["A2101_FNMA_OWNERSHIP_FILES_DATA"]); assert.deepEqual(g.tasks, ["attorney"]);
  const base = { from: "due_diligence" as const, to: "approved" as const, tier: 1 as const, ai_ml_used: false, offshore: false, onboarding_assessment_completed: true, clauses, attorney_signoff: false, officer_approval: true, soc2_period_end: D("2026-06-30"), bcp_evidence: true, ai_systems_linked: false, ll2026_04_attestation: false, data_return_certified: false, credentials_revoked: false, as_of: D("2026-11-02") };
  const t = vendorTransition(base); assert.equal(t.allowed, false); assert.ok(t.blockers.some((b) => /missing A2101_FNMA_OWNERSHIP_FILES_DATA/.test(b))); assert.ok(t.escalations.some((e) => e.kind === "attorney"));
  assert.equal(vendorTransition({ ...base, clauses: { ...clauses, A2101_FNMA_OWNERSHIP_FILES_DATA: "present" } }).allowed, true);
  assert.equal(vendorTransition({ ...base, clauses: { ...clauses, A2101_FNMA_OWNERSHIP_FILES_DATA: "present" }, officer_approval: false }).allowed, false);   // Tier 1 approval needs an officer
  // on the bus: the stored checklist (never a self-asserted map) blocks `approved`, the attorney's task is opened, and the agent cannot activate a Tier 1 vendor at all
  const h = bus19_3("2026-11-02T15:00:00.000Z");
  await h.run("contracts.extractClauses", { contract_id: "c-cloud", kind: "vendor_msa", executed_at: "2026-10-01", expires_at: "2029-09-30", clauses: clauseRows(required.filter((c) => c !== "A2101_FNMA_OWNERSHIP_FILES_DATA")) });
  await h.run("vendors.setStatus", { vendor_id: "v-cloud", status: "due_diligence", tier: 1, contract_id: "c-cloud" });
  await assert.rejects(h.run("vendors.assess", { vendor_id: "v-cloud", kind: "onboarding", completed_at: "2026-10-15", approved_by: "officer-1" }, AGENT), refused("TIER1_ASSESSMENT_APPROVED_BY_OFFICER"));   // the record is Tier 1 whether or not the caller says so
  await h.run("vendors.assess", { vendor_id: "v-cloud", kind: "onboarding", tier: 1, completed_at: "2026-10-15", approved_by: "officer-1" }, OFFICER);
  const evidence = { tier: 1, soc2_period_end: "2026-06-30", bcp_evidence: true, officer_approval: true };
  await assert.rejects(h.run("vendors.setStatus", { vendor_id: "v-cloud", status: "approved", ...evidence }, AGENT), refused("TIER1_ACTIVATION_OFFICER"));
  await assert.rejects(h.run("vendors.setStatus", { vendor_id: "v-cloud", status: "approved", soc2_period_end: "2026-06-30", bcp_evidence_document_id: "doc-bcp-cloud" }, AGENT), refused("TIER1_ACTIVATION_OFFICER"));   // omitting `tier` changes nothing: the record is Tier 1
  await assert.rejects(h.run("vendors.setStatus", { vendor_id: "v-cloud", status: "approved", tier: 3, soc2_period_end: "2026-06-30" }, AGENT), refused("TIER_IS_THE_RECORDS"));   // nor does re-tiering it
  await assert.rejects(h.run("vendors.setStatus", { vendor_id: "v-cloud", status: "active", from: "approved", ...evidence }, OFFICER), (e: unknown) => e instanceof RangeError && /stale from: vendor v-cloud is due_diligence/.test(e.message));   // the state is the record's, never the caller's
  const blocked = await h.run("vendors.setStatus", { vendor_id: "v-cloud", status: "approved", ...evidence }, OFFICER);
  assert.equal(blocked.allowed, false); assert.ok((blocked.blockers as string[]).some((b) => /missing A2101_FNMA_OWNERSHIP_FILES_DATA/.test(b)));
  assert.ok((blocked.escalations as { kind: string }[]).some((e) => e.kind === "attorney")); assert.ok(h.rt.escalations.opened.some((e) => e.kind === "attorney" && e.ownerRole === "attorney" && e.payload.vendor_id === "v-cloud"));
  assert.equal(h.rt.store.get("vendors", "v-cloud")!.data.status, "due_diligence");
  assert.deepEqual((await h.run("contracts.checklist", { contract_id: "c-cloud" })).missing, ["A2101_FNMA_OWNERSHIP_FILES_DATA"]);
  // the clause is `present` only with its evidence excerpt; then the officer's approval goes through and the reassessment clock anchors on the onboarding assessment
  await assert.rejects(h.run("contracts.extractClauses", { contract_id: "c-cloud", clauses: [{ clause_code: "A2101_FNMA_OWNERSHIP_FILES_DATA", status: "present" }] }), refused("CLAUSE_PRESENT_NEEDS_EVIDENCE"));
  await h.run("contracts.extractClauses", { contract_id: "c-cloud", clauses: [{ clause_code: "A2101_FNMA_OWNERSHIP_FILES_DATA", status: "present", evidence_excerpt: "§12.1 Provider acknowledges Fannie Mae's ownership interest in the Fannie Mae mortgage loans (including all associated files and data)" }] });
  assert.equal((await h.run("vendors.setStatus", { vendor_id: "v-cloud", status: "approved", ...evidence }, OFFICER)).allowed, true);
  assert.equal(h.ctx.events.ofType("vendor.approved")[0]!.payload.reassessment_due, "2027-10-15");
  assert.equal(h.ctx.timers.byCode("FNMA_SUPP_VENDOR_REASSESSMENT")[0]!.dueDate, "2027-10-15");
});
test("19.3-T7: Given an AI provider contract where `NO_TRAINING_ON_DATA` = deviation, then activation is blocked until attorney sign-off and officer approval are both recorded.", async () => {
  const dev = { ...Object.fromEntries(requiredClauses({ ai_provider: true }).map((c) => [c, "present" as const])), NO_TRAINING_ON_DATA: "deviation" as const };
  const opts = { ai_provider: true };
  assert.equal(clauseChecklist(dev, { ...opts, attorney_signoff: false, officer_approval: false }).allowed, false); assert.deepEqual(clauseChecklist(dev, { ...opts, attorney_signoff: false, officer_approval: false }).tasks, ["attorney", "officer"]);
  assert.equal(clauseChecklist(dev, { ...opts, attorney_signoff: true, officer_approval: false }).allowed, false); assert.equal(clauseChecklist(dev, { ...opts, attorney_signoff: false, officer_approval: true }).allowed, false);
  assert.equal(clauseChecklist(dev, { ...opts, attorney_signoff: true, officer_approval: true }).allowed, true); assert.deepEqual(clauseChecklist(dev, { ...opts, attorney_signoff: true, officer_approval: true }).deviations, ["NO_TRAINING_ON_DATA"]);
  assert.equal(clauseEntry({ clause_code: "NO_TRAINING_ON_DATA", status: "deviation", evidence_excerpt: "§7.2 provider may train on de-identified prompts", reviewed_by: null }).escalation?.kind, "attorney");
  // on the bus: the AI model provider (Tier 1, ai_ml_used) — refused until the attorney's review is on the deviation row AND the officer's approval is recorded
  const h = bus19_3("2026-11-02T15:00:00.000Z");
  const rows = clauseRows(requiredClauses({ ai_provider: true })).map((r) => (r.clause_code === "NO_TRAINING_ON_DATA" ? { ...r, status: "deviation", evidence_excerpt: "§7.2 provider may train on de-identified prompts" } : r));
  assert.ok(((await h.run("contracts.extractClauses", { contract_id: "c-modelco", kind: "vendor_msa", executed_at: "2026-10-01", expires_at: "2028-09-30", clauses: rows })).escalations as { kind: string }[]).some((e) => e.kind === "attorney"));
  await h.run("vendors.setStatus", { vendor_id: "v-modelco", status: "due_diligence", tier: 1, contract_id: "c-modelco", ai_ml_used: true });
  await h.run("vendors.assess", { vendor_id: "v-modelco", kind: "onboarding", tier: 1, completed_at: "2026-10-15", approved_by: "officer-1" }, OFFICER);
  // the `ai_systems` linkage is the inventory's (the agents that run on this model provider), the attestation and SOC 2 / BCP evidence are documents on the vendor record
  await h.run("ai_systems.upsert", { id: "lossmit-underwriter", name: "lossmit-underwriter", vendor_id: "v-modelco", prompt_version: "prompt-2026.10.1", model_version: "model-2026-09", eval_pass: { prompt_version: "prompt-2026.10.1", model_version: "model-2026-09", passed_at: "2026-10-01T12:00:00Z" } });
  const ev = { tier: 1, ai_ml_used: true, ll2026_04_attestation_document_id: "doc-ll2026-04-attestation-modelco", soc2_period_end: "2026-06-30", soc2_report_document_id: "doc-soc2-modelco", bcp_evidence_document_id: "doc-bcp-modelco" };
  const a = await h.run("vendors.setStatus", { vendor_id: "v-modelco", status: "approved", ...ev, officer_approval: true }, OFFICER);   // officer approval alone
  assert.equal(a.allowed, false); assert.ok((a.blockers as string[]).some((b) => /deviations NO_TRAINING_ON_DATA \(attorney sign-off missing/.test(b)));
  await assert.rejects(h.run("contracts.extractClauses", { contract_id: "c-modelco", clauses: [{ clause_code: "NO_TRAINING_ON_DATA", status: "deviation", evidence_excerpt: "§7.2", reviewed_by: "atty-1" }] }, AGENT), refused("CLAUSE_REVIEW_IS_ATTORNEYS"));   // the agent cannot self-assert the review
  await h.run("contracts.extractClauses", { contract_id: "c-modelco", clauses: [{ clause_code: "NO_TRAINING_ON_DATA", status: "deviation", evidence_excerpt: "§7.2 provider may train on de-identified prompts", reviewed_by: "atty-1" }] }, ATTORNEY);
  const b = await h.run("vendors.setStatus", { vendor_id: "v-modelco", status: "approved", ...ev }, OFFICER);   // attorney sign-off alone
  assert.equal(b.allowed, false); assert.ok((b.blockers as string[]).some((x) => /attorney sign-off recorded, officer approval missing/.test(x)));
  assert.equal((await h.run("vendors.setStatus", { vendor_id: "v-modelco", status: "approved", ...ev, officer_approval: true }, OFFICER)).allowed, true);   // both recorded
  const rec = h.rt.store.get("vendors", "v-modelco")!.data; assert.equal(rec.officer_approved_by, "officer-1"); assert.equal(rec.soc2_report_document_id, "doc-soc2-modelco"); assert.equal(rec.bcp_evidence_document_id, "doc-bcp-modelco"); assert.equal(rec.ll2026_04_attestation_document_id, "doc-ll2026-04-attestation-modelco"); assert.equal(rec.ai_systems_linked, true);
  assert.equal((await h.run("vendors.setStatus", { vendor_id: "v-modelco", status: "active" }, OFFICER)).allowed, true);   // the recorded approval and evidence carry to activation — nothing is re-asserted
  assert.equal(h.rt.store.get("vendors", "v-modelco")!.data.status, "active");
});
test("19.3-T8: Given a Form 101 not yet acknowledged, then every Fannie Mae adapter call under the partner's servicer number is refused with `form101_inactive`.", async () => {
  const unacked: Form101Row = { id: "form101-partner", servicer_numbers: ["12345-000-1"], applications: ["SMDU", "AMN", "CRS"], executed_at: "2026-09-15", submitted_at: "2026-09-16T14:00:00.000Z", fnma_ack_at: null };
  assert.equal(form101Status(unacked), "submitted");
  const r = fnmaAdapterCall({ authorizations: [unacked], servicer_number: "12345-000-1", application: "SMDU" });
  assert.equal(r.allowed, false); assert.equal(r.reason, "form101_inactive"); assert.equal(r.form101_status, "submitted");
  assert.equal(fnmaAdapterCall({ authorizations: [], servicer_number: "12345-000-1" }).form101_status, "none");
  // every call through the partner-scoped port is refused until Fannie Mae's acknowledgement is on file; termination closes it again
  const calls: string[] = []; const port = { createCase: async (n: string) => { calls.push(`createCase:${n}`); return { id: "case-1" }; }, reportTppPayment: async () => { calls.push("reportTppPayment"); return { acked: true }; } };
  let auths: Form101Row[] = [unacked];
  const gated = withForm101Gate(port, { servicer_number: "12345-000-1", application: "SMDU", authorizations: () => auths });
  assert.throws(() => gated.createCase("1234567890"), (e: unknown) => e instanceof Form101Inactive && e.reason === "form101_inactive" && e.method === "createCase" && /form101_inactive: Form 101 for servicer number 12345-000-1 \/ SMDU is submitted/.test(e.message));
  assert.throws(() => gated.reportTppPayment(), (e: unknown) => e instanceof Form101Inactive); assert.deepEqual(calls, []);
  auths = [{ ...unacked, fnma_ack_at: "2026-09-20T15:00:00.000Z" }]; assert.equal(form101Status(auths[0]!), "active");
  await gated.createCase("1234567890"); assert.deepEqual(calls, ["createCase:1234567890"]);
  assert.equal(fnmaAdapterCall({ authorizations: [{ ...auths[0]!, termination_submitted_at: "2027-07-01T15:00:00.000Z" }], servicer_number: "12345-000-1" }).allowed, false);
  assert.equal(fnmaAdapterCall({ authorizations: auths, servicer_number: "99999-000-9" }).form101_status, "none");   // not the partner's number on the form
  // the gate evaluator the Fannie Mae adapters assert (FNMA_A2107_FORM101_INCEPTION_GATE); Fannie Mae's acknowledgement is what opens it
  assert.match(evaluateGate("19.3.form101Active", { form101_status: "submitted" }).reason!, /^form101_inactive/);
  assert.equal(evaluateGate("19.3.form101Active", { form101_status: "acknowledged" }).open, true); assert.equal(evaluateGate("19.3.form101Active", { fnma_ack_at: "2026-09-20T15:00:00.000Z" }).open, true);
  assert.equal(evaluateGate("19.3.form101Active", { fnma_ack_at: "2026-09-20T15:00:00.000Z", termination_submitted_at: "2027-07-01" }).open, false);
  assert.throws(() => assertGate("19.3.form101Active", { submitted_at: "2026-09-16" }), (e: unknown) => e instanceof GateClosedApp && /form101_inactive/.test(e.reason));
  // on the bus: the executed subservicing agreement makes the arrangement effective and arms the gate on its Form 101 (`subservicing.arrangement.effective`); the officer's submission record leaves it closed; Fannie Mae's acknowledgement (`form101.acknowledged`) opens it
  const h = bus19_3("2026-09-15T15:00:00.000Z");
  const shape = subservicingArrangementEffective({ contract_id: "c-ssa-partner", entity: "partner", effective_from: D("2026-09-15"), authorization_id: null, servicer_numbers: ["12345-000-1"] });
  assert.equal(shape.authorization_id, "form101-partner"); assert.deepEqual(shape.event.aggregate, { kind: "data_access_authorizations", id: "form101-partner" }); assert.equal(shape.event.occurredAt, "2026-09-15T12:00:00.000Z");
  const ing = await h.run("contracts.extractClauses", { contract_id: "c-ssa-partner", kind: "subservicing_agreement", entity: "partner", executed_at: "2026-09-15", effective_from: "2026-09-15", expires_at: "2031-09-14", authorization_id: "form101-partner", servicer_numbers: ["12345-000-1"], clauses: clauseRows(requiredClauses({ ai_provider: false, contract_kind: "subservicing_agreement" })) });
  assert.equal((ing.arrangement as Out).gate, "FNMA_A2107_FORM101_INCEPTION_GATE"); assert.equal((ing.arrangement as Out).form101_status, "drafted");
  const gate = h.ctx.timers.byCode("FNMA_A2107_FORM101_INCEPTION_GATE"); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "armed"); assert.deepEqual(gate[0]!.subject, { kind: "data_access_authorizations", id: "form101-partner" }); assert.match(gate[0]!.note ?? "", /19\.3\.form101Active/);
  const eff = h.ctx.events.ofType("subservicing.arrangement.effective"); assert.equal(eff.length, 1); assert.equal(eff[0]!.payload.effective_from, "2026-09-15"); assert.equal(eff[0]!.payload.contract_id, "c-ssa-partner");
  h.clock.set("2026-09-16T15:00:00.000Z");
  await h.run("fnma_notices.recordSent", { kind: "form101", entity: "partner", document_id: "doc-form101", sent_by: "officer-1", channel: "email:Technology_Registration@fanniemae.com", authorization_id: "form101-partner", servicer_numbers: ["12345-000-1"], applications: ["SMDU", "AMN", "CRS"], recorded_by_officer: true }, OFFICER);
  const rows = (): Form101Row[] => h.rt.store.list("data_access_authorizations").map((x) => ({ ...(x.data as unknown as Form101Row), id: x.id }));
  assert.equal(fnmaAdapterCall({ authorizations: rows(), servicer_number: "12345-000-1", application: "SMDU" }).reason, "form101_inactive");
  assert.equal(h.ctx.events.ofType("form101.submitted").length, 1); assert.equal(h.ctx.events.ofType("form101.acknowledged").length, 0);
  assert.equal(h.ctx.timers.byCode("FNMA_A2107_FORM101_INCEPTION_GATE")[0]!.status, "armed");   // submitted is not acknowledged: still closed
  h.clock.set("2026-09-20T15:00:00.000Z");
  await h.run("fnma_notices.recordSent", { id: "fnma-notice-form101-ack", kind: "form101", entity: "partner", document_id: "doc-form101", sent_by: "officer-1", authorization_id: "form101-partner", acknowledgement_document_id: "doc-fnma-ack", recorded_by_officer: true }, OFFICER);
  assert.equal(h.ctx.events.ofType("form101.acknowledged").length, 1);
  assert.equal(h.ctx.timers.byCode("FNMA_A2107_FORM101_INCEPTION_GATE")[0]!.status, "satisfied");
  assert.equal(fnmaAdapterCall({ authorizations: rows(), servicer_number: "12345-000-1", application: "SMDU" }).allowed, true);
});
test("19.3-T9: Given the partner terminates the arrangement effective 2027-06-30 (Wed), then the Form 101 termination is due 2027-07-08 (July 5 observed holiday excluded) and 17.x/Form 629 tasks are created.", async () => {
  const r = subservicingTermination({ effective_on: D("2027-06-30") });
  // Thu Jul 1, Fri Jul 2, [Mon Jul 5: Independence Day observed — Jul 4, 2027 is a Sunday], Tue 6, Wed 7, Thu 8
  assert.equal(r.form101_termination_due, "2027-07-08"); assert.equal(fannieEt.isBusinessDay(D("2027-07-05")), false);
  const kinds = r.tasks.map((t) => t.kind);
  assert.ok(kinds.includes("form101_termination") && kinds.includes("section17_transfer_out_checklist") && kinds.includes("form629_transfer_approval"));
  assert.equal(r.tasks.find((t) => t.kind === "form101_termination")!.owner, "officer"); assert.equal(r.tasks.find((t) => t.kind === "form101_termination")!.due, "2027-07-08");
  assert.equal(r.transfer_date, "2027-07-01");   // first Fannie Mae business day after the termination takes effect (A2-7-03)
  const f629 = r.tasks.find((t) => t.kind === "form629_transfer_approval")!; assert.equal(f629.due, "2027-06-01"); assert.equal(f629.process, "17.1"); assert.equal(f629.owner, "fnma_portal_operator");
  assert.equal(r.tasks.find((t) => t.kind === "section17_transfer_out_checklist")!.process, "17.3");
  assert.equal(r.data_return_cert_due, "2027-07-30");   // FNMA_TECHGUIDE_TERMINATION_RETURN_DESTROY_30D
  // full service continues until cutover: a mid-month termination transfers on the first business day of the *following* month, never before the termination
  const mid = subservicingTermination({ effective_on: D("2027-06-15") }); assert.equal(mid.transfer_date, "2027-07-01"); assert.equal(mid.form629_due, "2027-06-01"); assert.ok(mid.transfer_date > "2027-06-15");
  assert.equal(subservicingTermination({ effective_on: D("2027-07-03") }).transfer_date, "2027-08-02");   // Aug 1, 2027 is a Sunday
  const shape = subservicingArrangementTerminated({ contract_id: "c-ssa-partner", contract_event_id: "ce-partner-term", entity: "partner", occurred_on: D("2027-03-31"), effective_on: D("2027-06-30"), authorization_id: null });
  assert.equal(shape.form101_termination_due, "2027-07-08"); assert.equal(shape.event.payload.termination_effective_on, "2027-06-30"); assert.deepEqual(shape.event.aggregate, { kind: "data_access_authorizations", id: "form101-partner" });
  assert.throws(() => subservicingArrangementTerminated({ contract_id: null, contract_event_id: "x", entity: "partner", occurred_on: D("2027-06-30"), effective_on: D("2027-03-31"), authorization_id: null }), RangeError);
  // on the bus: the partner's termination notice (occurring Wed 2027-03-31, effective Wed 2027-06-30) is recorded as a contract event under the subservicing agreement: the A2-1-01 5-BD event notice runs from the occurrence, the Form 101 termination clock from the effective date (`subservicing.arrangement.terminated{termination_effective_on}`)
  const h = bus19_3("2027-03-31T15:00:00.000Z");
  const ev5 = reg.activeVersion("NTC_FNMA_A2101_CONTRACT_EVENT_5BD", D("2026-09-01"))!;
  const out = await h.run("notices.draft", { template_code: "NTC_FNMA_A2101_CONTRACT_EVENT_5BD", notice_date: "2027-04-06", contract_event: { id: "ce-partner-term", contract_id: "c-ssa-partner", kind: "termination", direction: "sent_by_servicer", occurred_on: "2027-03-31", effective_on: "2027-06-30", contract_kind: "subservicing_agreement", entity: "partner", authorization_id: "form101-partner" }, payload: ev5.samplePayload });
  assert.deepEqual(out.arrangement, { authorization_id: "form101-partner", termination_effective_on: "2027-06-30", form101_termination_due: "2027-07-08", timer: "FNMA_A2107_FORM101_TERMINATION_5BD" });
  assert.equal((out.draft as Notice).payload.due_on, "2027-04-07"); assert.equal((out.draft as Notice).payload.business_days_after, 4); assert.equal((out.draft as Notice).checklist.passed, true);   // Thu Apr 1, Fri 2, Mon 5, Tue 6, Wed 7
  assert.equal(h.ctx.timers.byCode("FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD")[0]!.dueDate, "2027-04-07");
  const t5 = h.ctx.timers.byCode("FNMA_A2107_FORM101_TERMINATION_5BD"); assert.equal(t5.length, 1); assert.equal(t5[0]!.anchorDate, "2027-06-30"); assert.equal(t5[0]!.dueDate, "2027-07-08"); assert.deepEqual(t5[0]!.subject, { kind: "data_access_authorizations", id: "form101-partner" });
  const term0 = h.ctx.events.ofType("subservicing.arrangement.terminated"); assert.equal(term0.length, 1); assert.equal(term0[0]!.payload.termination_effective_on, "2027-06-30"); assert.equal(term0[0]!.payload.form101_termination_due, "2027-07-08");
  assert.equal(h.rt.store.get("data_access_authorizations", "form101-partner")!.data.form101_termination_due, "2027-07-08");
  assert.deepEqual(h.ctx.timers.evaluate("2027-07-08T04:00:00.000Z").map((b) => b.instance.code).filter((c) => c !== "FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD"), []);   // still Jul 7 for the Form 101 clock (the drafted A2-1-01 notice is never sent in this test, so its own 5-BD clock has lapsed)
  h.clock.set("2027-07-07T15:00:00.000Z");
  const rec = await h.run("fnma_notices.recordSent", { kind: "form101_termination", entity: "partner", document_id: "doc-form101-termination", sent_by: "officer-1", authorization_id: "form101-partner", recorded_by_officer: true }, OFFICER);   // terminated_at defaults to the arrangement's effective termination date
  assert.equal(h.ctx.timers.byCode("FNMA_A2107_FORM101_TERMINATION_5BD")[0]!.status, "satisfied");
  // the termination record opens the 17.x transfer-out checklist, the Form 629 (30-day) portal task and the data-return certification task
  const term = (rec.lifecycle as Out).termination as { transfer_date: string; form629_due: string; tasks: { task: string; process: string; due: string; owner_role: string }[] };
  assert.equal(term.transfer_date, "2027-07-01"); assert.equal(term.form629_due, "2027-06-01");
  assert.deepEqual(term.tasks.map((t) => [t.task, t.process, t.due, t.owner_role]), [["section17_transfer_out_checklist", "17.3", "2027-07-01", "transfers"], ["form629_transfer_approval", "17.1", "2027-06-01", "fnma_portal_operator"], ["data_return_destroy_certification", "19.3", "2027-07-30", "officer"]]);
  assert.ok(h.rt.escalations.opened.some((e) => e.kind === "human_portal_task" && e.ownerRole === "fnma_portal_operator" && e.payload.task === "form629_transfer_approval"));
  assert.ok(h.rt.escalations.opened.some((e) => e.kind === "officer" && e.payload.task === "data_return_destroy_certification" && e.payload.due === "2027-07-30"));
  assert.equal(h.rt.store.get("data_access_authorizations", "form101-partner")!.data.terminated_at, "2027-06-30");
  assert.equal(fnmaAdapterCall({ authorizations: [{ ...(h.rt.store.get("data_access_authorizations", "form101-partner")!.data as unknown as Form101Row), servicer_numbers: ["12345-000-1"] }], servicer_number: "12345-000-1" }).form101_status, "terminated");
  const rd = h.ctx.timers.byCode("FNMA_TECHGUIDE_TERMINATION_RETURN_DESTROY_30D"); assert.equal(rd.length, 1); assert.equal(rd[0]!.anchorDate, "2027-06-30"); assert.equal(rd[0]!.dueDate, "2027-07-30");
  h.clock.set("2027-07-28T15:00:00.000Z");
  await h.run("fnma_notices.recordSent", { kind: "data_return_cert", entity: "supermortgage", document_id: "doc-cert-data-return", sent_by: "officer-1", authorization_id: "form101-partner", recorded_by_officer: true }, OFFICER);
  assert.equal(h.ctx.timers.byCode("FNMA_TECHGUIDE_TERMINATION_RETURN_DESTROY_30D")[0]!.status, "satisfied"); assert.equal(h.ctx.events.ofType("data_return.certified")[0]!.payload.certified_by_role, "officer");
  // Supermortgage's own SSA termination (Technology Guide) directs the return/destruction of Fannie Mae Data: `fnma.data_return.directed{source=ssa_terminated}` arms the 30-day clock on the contract; the officer's certification closes it
  assert.equal(dataReturnDirectedByTermination({ contract_kind: "vendor_msa", contract_id: "c-x", effective_on: D("2027-07-31") }), null);
  assert.equal(dataReturnDirectedByTermination({ contract_kind: "integration_agreement", contract_id: "c-tsp", effective_on: D("2027-07-31") })!.payload.source, "schedule_terminated");
  await h.run("contracts.extractClauses", { contract_id: "c-ssa-sm", kind: "ssa", entity: "supermortgage", executed_at: "2026-06-01", effective_from: "2026-06-01", expires_at: "2029-05-31", clauses: clauseRows(["NO_SCRAPING_FNMA"]) });
  await h.run("notices.draft", { template_code: "CERT_DATA_RETURN_DESTROY", contract_event: { id: "ce-ssa-term", contract_id: "c-ssa-sm", kind: "termination", direction: "sent_by_provider", occurred_on: "2027-07-01", effective_on: "2027-07-31", contract_kind: "ssa", entity: "supermortgage" } });
  const ssa = h.ctx.events.ofType("fnma.data_return.directed").find((e) => e.payload.source === "ssa_terminated")!; assert.equal(ssa.payload.termination_date, "2027-07-31"); assert.equal(ssa.payload.certify_by, "2027-08-30");
  const rd2 = () => h.ctx.timers.byCode("FNMA_TECHGUIDE_TERMINATION_RETURN_DESTROY_30D").find((t) => t.subject.kind === "counterparty_contracts" && t.subject.id === "c-ssa-sm")!;
  assert.equal(rd2().anchorDate, "2027-07-31"); assert.equal(rd2().dueDate, "2027-08-30");
  assert.equal(h.ctx.timers.byCode("FNMA_A2101_CONTRACT_EVENT_NOTICE_5BD").length, 1);   // the SSA is Supermortgage's own Fannie Mae licence, not a third-party technology contract: no A2-1-01 clock
  h.clock.set("2027-08-20T15:00:00.000Z");
  await h.run("fnma_notices.recordSent", { kind: "data_return_cert", entity: "supermortgage", document_id: "doc-cert-ssa", sent_by: "officer-1", contract_id: "c-ssa-sm", recorded_by_officer: true }, OFFICER);
  assert.equal(rd2().status, "satisfied");
});
test("19.3-T10: Given a Fannie Mae LL-2026-04 disclosure request received 2026-10-05, then the response package (types, purposes, safeguards, inventory export) is due 2026-10-12 and an `officer` task exists.", async () => {
  // Spec says 2026-10-12, but Mon 2026-10-12 is Columbus Day on the Fannie Mae ET calendar → Tue 6, Wed 7, Thu 8, Fri 9, [Mon 12], Tue 2026-10-13 (docs/AUDIT-NOTES.md)
  assert.equal(fannieEt.isBusinessDay(D("2026-10-12")), false);
  const r = fnmaRequestDue("ll2026_04_disclosure", D("2026-10-05")); assert.equal(r.due, "2026-10-13"); assert.equal(disclosureResponseDue(D("2026-10-05")), "2026-10-13");
  assert.equal(r.timer, "FNMA_LL2026_04_DISCLOSURE_PROMPT_5BD"); assert.equal(r.escalation.kind, "officer");
  const h = bus19_3("2026-10-05T15:00:00.000Z");
  const ll = reg.activeVersion("NTC_FNMA_LL2026_04_DISCLOSURE", D("2026-09-01"))!;
  // the inventory export counts the `ai_systems` rows and the response due date is the rule's — neither is the caller's number
  for (const [id, purpose] of [["lossmit-underwriter", "loss mitigation eligibility and offer preparation (12.x)"], ["security-records", "records, vendor and contract custody (19.x)"]]) await h.run("ai_systems.upsert", { id, name: id, purpose, prompt_version: "prompt-2026.09", model_version: "model-2026-09", eval_pass: { prompt_version: "prompt-2026.09", model_version: "model-2026-09", passed_at: "2026-09-30T12:00:00Z" } });
  const out = await h.run("notices.draft", { template_code: "NTC_FNMA_LL2026_04_DISCLOSURE", notice_date: "2026-10-09", request_kind: "ll2026_04_disclosure", request_received_on: "2026-10-05", request_id: "req-ll", payload: { ...ll.samplePayload, due_on: "2026-10-12", inventory_count: 12, ai_type_count: 9 } });
  assert.equal((out.request as Out).due_at, "2026-10-13");
  assert.equal((out.draft as Notice).payload.due_on, "2026-10-13"); assert.equal((out.draft as Notice).payload.inventory_count, 2); assert.equal((out.draft as Notice).payload.ai_type_count, 3);
  assert.ok((out.escalations as { kind: string; owner_role: string }[]).some((e) => e.kind === "officer" && e.owner_role === "officer"));
  assert.ok(h.rt.escalations.opened.some((e) => e.kind === "officer" && e.payload.request_id === "req-ll" && /signed by the officer/.test(String(e.payload.reason))));
  const t = h.ctx.timers.byCode("FNMA_LL2026_04_DISCLOSURE_PROMPT_5BD"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-10-13"); assert.equal(t[0]!.anchorDate, "2026-10-05");
  const draft = out.draft as Notice; assert.equal(draft.checklist.passed, true); assert.equal(draft.payload.business_days_after, 4);
  assert.match(draft.rendered.text, /1\. Types of AI\/ML used: .+2\. Purpose and manner of use, by agent: .+3\. Safeguards implemented to mitigate risks: .+inventory export: doc-ai-inventory-2026-10-09 \(2 systems/); assert.match(draft.rendered.text, /response due October 13, 2026/);
  assert.equal(h.rt.store.get("fnma_information_requests", "req-ll")!.data.due_at, "2026-10-13");
  h.clock.set("2026-10-09T20:00:00.000Z");
  await h.run("fnma_notices.recordSent", { kind: "ll2026_04_disclosure", entity: "supermortgage", document_id: "doc-ll-response", sent_by: "officer-1", request_id: "req-ll", recorded_by_officer: true }, OFFICER);
  assert.equal(h.ctx.timers.byCode("FNMA_LL2026_04_DISCLOSURE_PROMPT_5BD")[0]!.status, "satisfied");
  assert.equal(h.rt.store.get("fnma_information_requests", "req-ll")!.data.responded_at, "2026-10-09T20:00:00.000Z");
});
test("19.3-T11: Given an integration schema drift detected 2026-10-01 not restored by 2027-01-29, then the interface is disabled on day 120 and a sev-1 is raised.", async () => {
  const drift = integrationDrift({ detected_on: D("2026-10-01"), restored_on: null, as_of: D("2027-01-29") });
  assert.equal(drift.disable_on, "2027-01-29"); assert.equal(drift.day, 120); assert.equal(drift.interface_disabled, true); assert.equal(drift.escalation?.kind, "sev1"); assert.equal(drift.escalation?.at, "2027-01-29");
  assert.equal(integrationDrift({ detected_on: D("2026-10-01"), restored_on: null, as_of: D("2027-01-28") }).interface_disabled, false);
  const restored = integrationDrift({ detected_on: D("2026-10-01"), restored_on: D("2027-01-15"), as_of: D("2027-01-29") }); assert.equal(restored.interface_disabled, false); assert.equal(restored.escalation, null);
  const det0 = integrationDriftDetected({ interface: "lsdu-b2b", detected_on: D("2026-10-01"), expected_spec_version: "LAR96 v3.2", actual_spec_version: "LAR96 v3.1", current: null });
  assert.equal(det0.disable_on, "2027-01-29"); assert.equal(det0.event!.payload.detected_at, "2026-10-01"); assert.equal(det0.row.status, "noncompliant"); assert.equal(det0.task!.due, "2027-01-29");
  assert.equal(integrationDriftDetected({ ...det0, interface: "lsdu-b2b", detected_on: D("2026-10-02"), expected_spec_version: null, actual_spec_version: null, current: det0.row }).already_open, true);
  assert.deepEqual(integrationDriftSweep([det0.row], D("2027-01-28")), []); const swept = integrationDriftSweep([det0.row], D("2027-01-29")); assert.equal(swept.length, 1); assert.equal(swept[0]!.row.status, "disabled"); assert.equal(swept[0]!.event.payload.day, 120); assert.equal(swept[0]!.escalation.kind, "sev1");
  assert.throws(() => integrationComplianceRestored({ row: det0.row, interface: "lsdu-b2b", restored_on: D("2027-02-03"), evidence_document_id: null }), /evidence_document_id/);
  assert.equal(integrationComplianceRestored({ row: swept[0]!.row, interface: "lsdu-b2b", restored_on: D("2027-02-03"), evidence_document_id: "doc-x" }).late, true);
  // on the bus: the compliance-sentinel's detection (`portal_task.create{task=integration_compliance}`) arms the 120-day clock and opens the Technology Manager task; `timers.read` reports the interface disabled on day 120; the daily monitor writes the disablement (sev-1); the engine breaches at sev-1; the operator's completion evidence restores compliance, late
  const h = bus19_3("2026-10-01T15:00:00.000Z");
  const det = await h.run("portal_task.create", { task: "integration_compliance", interface: "lsdu-b2b", detected_on: "2026-10-01", expected_spec_version: "LAR96 v3.2", actual_spec_version: "LAR96 v3.1" });
  assert.equal(det.disable_on, "2027-01-29"); assert.equal(det.kind, "human_portal_task"); assert.equal(det.ownerRole, "fnma_portal_operator"); assert.equal((det.interface as Out).status, "noncompliant"); assert.equal((det.payload as Out).portal, "technology_manager");
  const detected = h.ctx.events.ofType("integration.noncompliance.detected"); assert.equal(detected.length, 1); assert.equal(detected[0]!.payload.detected_at, "2026-10-01"); assert.match(String(detected[0]!.payload.drift), /expected LAR96 v3.2, interface running LAR96 v3.1/);
  const inst = h.ctx.timers.byCode("FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120"); assert.equal(inst.length, 1); assert.equal(inst[0]!.dueDate, "2027-01-29"); assert.equal(inst[0]!.anchorDate, "2026-10-01"); assert.deepEqual(inst[0]!.subject, { kind: "integration_interfaces", id: "lsdu-b2b" });
  assert.equal((await h.run("portal_task.create", { task: "integration_compliance", interface: "lsdu-b2b", detected_on: "2026-10-02" })).already_open, true);   // one open drift per interface
  assert.equal(h.ctx.events.ofType("integration.noncompliance.detected").length, 1);
  const read = (asOf: string) => h.run("timers.read", { subject_kind: "integration_interfaces", subject_id: "lsdu-b2b", as_of: asOf }).then((x) => (x as unknown as { code: string; drift?: ReturnType<typeof integrationDrift> }[]).find((t) => t.code === "FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120")!);
  assert.equal((await read("2027-01-28")).drift!.interface_disabled, false);
  const day120 = await read("2027-01-29"); assert.equal(day120.drift!.interface_disabled, true); assert.equal(day120.drift!.day, 120); assert.equal(day120.drift!.escalation?.kind, "sev1");
  h.clock.set("2027-01-28T11:00:00.000Z");
  assert.deepEqual((await h.run("portfolio.count", { entity: "supermortgage", as_of: "2027-01-28", loan_count: 24000 })).integration_interfaces_disabled, []);   // day 119: still transferring
  h.clock.set("2027-01-29T11:00:00.000Z");
  assert.deepEqual((await h.run("portfolio.count", { entity: "supermortgage", as_of: "2027-01-29", loan_count: 24000 })).integration_interfaces_disabled, [{ interface: "lsdu-b2b", disabled_on: "2027-01-29", day: 120 }]);
  assert.equal(h.rt.store.get("integration_interfaces", "lsdu-b2b")!.data.status, "disabled"); assert.equal(h.ctx.events.ofType("integration.interface.disabled").length, 1);
  assert.ok(h.rt.escalations.opened.some((e) => e.kind === "sev1" && e.payload.interface === "lsdu-b2b" && /disabled on day 120/.test(String(e.payload.reason))));
  const b = h.ctx.timers.evaluate("2027-01-30T05:00:00.000Z").find((x) => x.def.code === "FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120")!; assert.equal(b.severity, 1); assert.match(b.breachText, /interface auto-disabled at day 120/);
  await assert.rejects(h.run("portal_task.create", { task: "integration_compliance", op: "complete", interface: "lsdu-b2b", restored_on: "2027-02-03", evidence_document_id: "doc-lar96-v32-conformance" }, AGENT), refused("INTEGRATION_RESTORED_BY_OPERATOR"));
  h.clock.set("2027-02-03T15:00:00.000Z");
  const fixed = await h.run("portal_task.create", { task: "integration_compliance", op: "complete", interface: "lsdu-b2b", restored_on: "2027-02-03", evidence_document_id: "doc-lar96-v32-conformance" }, OPERATOR);
  assert.equal(fixed.late, true); assert.equal(fixed.day, 125); assert.equal((fixed.interface as Out).status, "compliant");
  const rs = h.ctx.events.ofType("integration.compliance.restored"); assert.equal(rs.length, 1); assert.equal(rs[0]!.payload.was_disabled, true); assert.equal(rs[0]!.payload.restored_at, "2027-02-03");
  assert.equal(h.ctx.timers.byCode("FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120")[0]!.status, "satisfied_late");
  assert.ok(h.rt.escalations.opened.some((e) => e.kind === "human_portal_task" && e.payload.interface === "lsdu-b2b" && e.status === "completed" && e.evidenceDocumentId === "doc-lar96-v32-conformance"));
  const def = loadOverriddenRegistry().get("FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120")!; assert.ok(eventMatches(def.triggerPattern!, detected[0]!)); assert.ok(eventMatches(def.satisfiedPattern!, rs[0]!));
});
test("19.3-T12: Given a Tier 1 vendor assessed 2026-03-01, then reassessment is due 2027-03-01 and an `officer` escalation exists at 2027-04-30 if incomplete.", async () => {
  const r = vendorReassessment({ tier: 1, assessed_on: D("2026-03-01"), completed_on: null, as_of: D("2027-04-30") });
  assert.equal(r.due, "2027-03-01"); assert.equal(r.officer_escalation_on, "2027-04-30"); assert.equal(r.overdue_days, 60); assert.equal(r.escalation?.kind, "officer"); assert.equal(r.escalation?.at, "2027-04-30");
  assert.deepEqual(reassessment(1, D("2026-03-01")), { due: D("2027-03-01"), escalate_on: D("2027-04-30") });
  assert.equal(vendorReassessment({ tier: 1, assessed_on: D("2026-03-01"), completed_on: null, as_of: D("2027-04-29") }).escalation?.kind, "sev2");
  assert.equal(vendorReassessment({ tier: 1, assessed_on: D("2026-03-01"), completed_on: null, as_of: D("2027-02-28") }).escalation, null);
  assert.equal(vendorReassessment({ tier: 1, assessed_on: D("2026-03-01"), completed_on: D("2027-02-20"), as_of: D("2027-04-30") }).escalation, null);
  assert.equal(vendorReassessment({ tier: 2, assessed_on: D("2026-03-01"), completed_on: null, as_of: D("2027-04-30") }).due, "2028-02-29");   // Tier 2: 730 days (2028 is a leap year)
  // on the bus: `vendor.approved` arms the recurring clock on the onboarding assessment's due date; the breach is sev-2 → officer, and `timers.read` carries the day-60 officer escalation
  const h = bus19_3("2026-03-01T15:00:00.000Z");
  await h.run("contracts.extractClauses", { contract_id: "c-lockbox", kind: "vendor_msa", executed_at: "2026-02-01", expires_at: "2029-01-31", clauses: clauseRows(requiredClauses({ ai_provider: false })) });
  await h.run("vendors.setStatus", { vendor_id: "v-lockbox", status: "due_diligence", tier: 1, contract_id: "c-lockbox" });
  await h.run("vendors.assess", { vendor_id: "v-lockbox", kind: "onboarding", tier: 1, completed_at: "2026-03-01", approved_by: "officer-1" }, OFFICER);
  assert.equal((await h.run("vendors.setStatus", { vendor_id: "v-lockbox", status: "approved", tier: 1, soc2_period_end: "2025-12-31", bcp_evidence: true, officer_approval: true }, OFFICER)).allowed, true);
  const inst = h.ctx.timers.byCode("FNMA_SUPP_VENDOR_REASSESSMENT"); assert.equal(inst.length, 1); assert.equal(inst[0]!.dueDate, "2027-03-01"); assert.equal(inst[0]!.anchorDate, "2027-03-01");
  const b = h.ctx.timers.evaluate("2027-03-02T05:00:00.000Z").find((x) => x.def.code === "FNMA_SUPP_VENDOR_REASSESSMENT")!; assert.equal(b.severity, 2); assert.deepEqual(b.escalateTo, ["officer"]);
  const read = await h.run("timers.read", { subject_kind: "vendors", subject_id: "v-lockbox", as_of: "2027-04-30" }) as unknown as { code: string; reassessment?: ReturnType<typeof vendorReassessment> }[];
  const row = read.find((t) => t.code === "FNMA_SUPP_VENDOR_REASSESSMENT")!; assert.equal(row.reassessment!.escalation?.kind, "officer"); assert.equal(row.reassessment!.escalation?.at, "2027-04-30"); assert.equal(row.reassessment!.overdue_days, 60);
  h.clock.set("2027-05-10T15:00:00.000Z");
  await h.run("vendors.assess", { vendor_id: "v-lockbox", kind: "annual", tier: 1, completed_at: "2027-05-10", approved_by: "officer-1" }, OFFICER);
  const after = h.ctx.timers.byCode("FNMA_SUPP_VENDOR_REASSESSMENT"); assert.equal(after[0]!.status, "satisfied_late"); assert.equal(after.length, 2); assert.equal(after[1]!.dueDate, reassessment(1, D("2027-05-10")).due);   // recurring: re-armed from the completed assessment
});
test("19.3-T13: Given a deploy of `lossmit-underwriter` with a new prompt version and no eval-suite pass, then the deploy gate blocks and the `ai_systems` row is not updated.", async () => {
  const base = { name: "lossmit-underwriter", prompt_version: "prompt-2026.10.2", model_version: "model-2026-09", current: { prompt_version: "prompt-2026.10.1", model_version: "model-2026-09" } };
  const g = deployGate({ ...base, eval_pass: null });
  assert.equal(g.changed, true); assert.equal(g.allowed, false); assert.equal(g.ai_systems_row_updated, false); assert.equal(g.gate, "SM_AI_SYSTEM_EVAL_BEFORE_DEPLOY"); assert.match(g.reason!, /lossmit-underwriter.*prompt-2026\.10\.2/);
  // a pass recorded for the previous prompt version does not open the gate; a pass for the new version does
  assert.equal(deployGate({ ...base, eval_pass: { prompt_version: "prompt-2026.10.1", model_version: "model-2026-09", passed_at: "2026-10-01T12:00:00Z" } }).ai_systems_row_updated, false);
  assert.equal(deployGate({ ...base, eval_pass: { prompt_version: "prompt-2026.10.2", model_version: "model-2026-09", passed_at: "2026-10-20T12:00:00Z" } }).ai_systems_row_updated, true);
  assert.equal(deployGate({ ...base, prompt_version: "prompt-2026.10.1", eval_pass: null }).changed, false);
  assert.equal(evaluateGate("19.3.evalSuitePassedAndInventoryUpdated", { eval_suite_passed: false, inventory_updated: false }).open, false);
  assert.equal(evaluateGate("19.3.evalSuitePassedAndInventoryUpdated", { eval_suite_passed: true, inventory_updated: true }).open, true);
  // on the bus: the inventory row keeps the deployed versions; the blocked deploy leaves it untouched and is logged
  const h = bus19_3("2026-10-01T15:00:00.000Z");
  const first = { id: "lossmit-underwriter", name: "lossmit-underwriter", purpose: "loss mitigation eligibility and offer preparation (12.x)", risk_tier: "high_consequential", owner: "Chief Servicing Officer", model_version: "model-2026-09" };
  await h.run("ai_systems.upsert", { ...first, prompt_version: "prompt-2026.10.1", eval_pass: { prompt_version: "prompt-2026.10.1", model_version: "model-2026-09", passed_at: "2026-10-01T12:00:00Z" } });
  h.clock.set("2026-10-20T15:00:00.000Z");
  const blocked = await h.run("ai_systems.upsert", { ...first, prompt_version: "prompt-2026.10.2" });
  assert.equal(blocked.allowed, false); assert.equal(blocked.ai_systems_row_updated, false); assert.equal((blocked.row as Out).prompt_version, "prompt-2026.10.1");
  assert.equal(h.rt.store.get("ai_systems", "lossmit-underwriter")!.data.prompt_version, "prompt-2026.10.1"); assert.equal(h.ctx.events.ofType("ai_system.deploy_blocked").length, 1); assert.equal(h.ctx.events.ofType("ai_system.changed").length, 0);
  await assert.rejects(h.run("ai_systems.upsert", { ...first, prompt_version: "prompt-2026.10.2", deploy: true }), refused("EVAL_SUITE_BEFORE_DEPLOY"));
  const ok = await h.run("ai_systems.upsert", { ...first, prompt_version: "prompt-2026.10.2", deploy: true, eval_pass: { prompt_version: "prompt-2026.10.2", model_version: "model-2026-09", passed_at: "2026-10-20T12:00:00Z" } });
  assert.equal(ok.ai_systems_row_updated, true); assert.equal((ok.row as Out).prompt_version, "prompt-2026.10.2"); assert.equal(h.ctx.events.ofType("ai_system.changed").length, 1);
});
test("19.3-T14: Given the Form 582 due date 2027-03-31, then the third-party package is delivered to 18.4 by 2027-03-01 with the Supplement attestation attached.", async () => {
  const contractors = [{ name: "CloudCo", function: "SoR hosting (cloud infrastructure)", critical: true, data_classes: ["fnma_data", "npi"], country: "US" }, { name: "ModelCo", function: "AI model provider", critical: true, data_classes: ["fnma_data"], country: "US" }];
  const input = { form582_due: D("2027-03-31"), contractors, subservicing_confirmed: true, supplement_attestation_document_id: "doc-supp-attestation-2027", ll2026_04_summary_document_id: "doc-ll2026-04-summary-2027", delivered_on: D("2027-03-01") };
  const p = form582ThirdPartyPackage(input);
  assert.equal(p.deliver_by, "2027-03-01"); assert.equal(p.complete, true); assert.equal(p.on_time, true); assert.equal(p.contents.supplement_attestation_document_id, "doc-supp-attestation-2027"); assert.equal(p.contents.contractors.length, 2); assert.equal(p.escalation, null);
  const noAttestation = form582ThirdPartyPackage({ ...input, supplement_attestation_document_id: null });
  assert.equal(noAttestation.complete, false); assert.deepEqual(noAttestation.missing, ["supplement_attestation"]); assert.equal(noAttestation.escalation?.kind, "sev2");
  assert.equal(form582ThirdPartyPackage({ ...input, delivered_on: D("2027-03-02") }).on_time, false);
  assert.equal(form582Clocks(D("2026-12-31")).due, "2027-03-31");   // 18.4's own clock: FYE + 90
  // on the bus: the fiscal year-end arms the package clock at FYE + 60 = Form 582 due − 30; the hand-off to 18.4 closes it, and an attestation-less package is refused
  const h = bus19_3("2026-12-31T15:00:00.000Z");
  h.ctx.events.append({ type: "period.fiscal_year_end", actor: SYSTEM, occurredAt: "2026-12-31T12:00:00.000Z", payload: { entity: "supermortgage", fiscal_year_end: "2026-12-31", form582_due: "2027-03-31" } });
  const inst = h.ctx.timers.byCode("FNMA_582_THIRD_PARTY_PACKAGE_30D"); assert.equal(inst.length, 1); assert.equal(inst[0]!.dueDate, "2027-03-01");
  h.clock.set("2027-03-01T15:00:00.000Z");
  const pkg = { form582_due: "2027-03-31", contractors, subservicing_confirmed: true, ll2026_04_summary_document_id: "doc-ll2026-04-summary-2027" };
  await assert.rejects(h.run("portal_task.create", { task: "form_582_upload", package: pkg }), (e: unknown) => e instanceof RangeError && /incomplete: supplement_attestation/.test(e.message));
  await assert.rejects(h.run("portal_task.create", { task: "form_582_upload" }), refused("PORTAL_TASK_NEEDS_PACKAGE"));
  const task = await h.run("portal_task.create", { task: "form_582_upload", package: { ...pkg, supplement_attestation_document_id: "doc-supp-attestation-2027" } });
  assert.equal(task.kind, "human_portal_task"); assert.equal(task.ownerRole, "fnma_portal_operator"); assert.equal((task.package as Out).on_time, true);
  const delivered = h.ctx.events.ofType("form582.third_party_package.delivered"); assert.equal(delivered.length, 1); assert.equal(delivered[0]!.payload.supplement_attestation_document_id, "doc-supp-attestation-2027"); assert.equal(delivered[0]!.payload.deliver_by, "2027-03-01");
  assert.equal(h.ctx.timers.byCode("FNMA_582_THIRD_PARTY_PACKAGE_30D")[0]!.status, "satisfied");
});

test("19.3 SM_VENDOR_INCIDENT_NOTICE_SLA: a vendor incident with awareness 2026-11-02 22:00Z arms the 24 h clock to 2026-11-03 22:00Z; the vendor's notice at 21:30Z closes it (sla_met); a notice 30 h after awareness on a second incident breaches, is a logged SLA breach and triggers a reassessment", async () => {
  const r = vendorIncidentReported({ vendor_id: "v-cloud", security_incident_id: "inc-1", vendor_aware_at: "2026-11-02T22:00:00Z", reported_at: "2026-11-02T23:00:00Z", sla_hours: null });
  assert.equal(r.row.sla_hours, 24); assert.equal(r.row.notice_due_at, "2026-11-03T22:00:00.000Z"); assert.equal(r.event.occurredAt, "2026-11-02T22:00:00.000Z"); assert.deepEqual(r.event.aggregate, { kind: "vendors", id: "v-cloud" });
  assert.throws(() => vendorIncidentReported({ vendor_id: "v-cloud", security_incident_id: "inc-1", vendor_aware_at: "2026-11-02T22:00:00Z", reported_at: "2026-11-02T21:00:00Z", sla_hours: null }), /precedes the vendor's awareness/);
  const n = vendorIncidentNoticeReceived({ row: r.row, notice_received_at: "2026-11-03T21:30:00Z", document_id: "doc-vendor-notice-1" });
  assert.equal(n.sla_met, true); assert.equal(n.hours_to_notice, 23.5); assert.equal(n.breach, null); assert.equal(n.reassessment, null);
  const late = vendorIncidentNoticeReceived({ row: r.row, notice_received_at: "2026-11-04T04:00:00Z", document_id: null });
  assert.equal(late.sla_met, false); assert.equal(late.hours_to_notice, 30); assert.equal(late.breach?.payload.clause, "INCIDENT_NOTICE_24H"); assert.equal(late.reassessment?.payload.kind, "triggered"); assert.equal(late.reassessment?.payload.due, "2026-11-04");
  assert.equal(vendorIncidentReported({ vendor_id: "v-cloud", security_incident_id: "inc-1", vendor_aware_at: "2026-11-02T22:00:00Z", reported_at: "2026-11-02T23:00:00Z", sla_hours: 4 }).row.notice_due_at, "2026-11-03T02:00:00.000Z");   // a tighter contractual SLA
  // on the bus: `vendors.assess{op=incident}` arms the registry clock at awareness + 24 h; `{op=incident_notice}` closes it
  const h = bus19_3("2026-11-02T23:00:00.000Z");
  await h.run("vendors.setStatus", { vendor_id: "v-cloud", status: "due_diligence", tier: 1 });
  const report = { op: "incident", vendor_id: "v-cloud", security_incident_id: "inc-1", vendor_aware_at: "2026-11-02T22:00:00Z", reported_at: "2026-11-02T23:00:00Z" };
  assert.equal((await h.run("vendors.assess", report)).timer, "SM_VENDOR_INCIDENT_NOTICE_SLA");
  const t = h.ctx.timers.byCode("SM_VENDOR_INCIDENT_NOTICE_SLA"); assert.equal(t.length, 1); assert.equal(new Date(t[0]!.dueAt!).toISOString(), "2026-11-03T22:00:00.000Z"); assert.equal(t[0]!.anchorDate, "2026-11-02"); assert.deepEqual(t[0]!.subject, { kind: "vendors", id: "v-cloud" });
  assert.equal((await h.run("vendors.assess", report)).idempotent, true); assert.equal(h.ctx.timers.byCode("SM_VENDOR_INCIDENT_NOTICE_SLA").length, 1);
  h.clock.set("2026-11-03T21:30:00.000Z");
  const got = await h.run("vendors.assess", { op: "incident_notice", vendor_id: "v-cloud", security_incident_id: "inc-1", notice_received_at: "2026-11-03T21:30:00Z", document_id: "doc-vendor-notice-1" });
  assert.equal(got.sla_met, true); assert.equal(got.breach_logged, false); assert.equal(h.ctx.timers.byCode("SM_VENDOR_INCIDENT_NOTICE_SLA")[0]!.status, "satisfied");
  assert.equal(h.rt.store.get("vendor_incidents", "v-cloud:inc-1")!.data.sla_met, true);
  // a second incident whose notice arrives 30 h after awareness: breached at 24 h, satisfied late, the breach logged, the vendor's reassessment triggered
  h.clock.set("2026-12-01T10:00:00.000Z");
  await h.run("vendors.assess", { op: "incident", vendor_id: "v-cloud", security_incident_id: "inc-2", vendor_aware_at: "2026-12-01T08:00:00Z", reported_at: "2026-12-01T10:00:00Z" });
  const second = h.ctx.timers.byCode("SM_VENDOR_INCIDENT_NOTICE_SLA")[1]!; assert.equal(new Date(second.dueAt!).toISOString(), "2026-12-02T08:00:00.000Z");
  assert.equal(h.ctx.timers.evaluate("2026-12-02T09:00:00.000Z").find((b) => b.def.code === "SM_VENDOR_INCIDENT_NOTICE_SLA")!.instance.id, second.id);
  h.clock.set("2026-12-02T14:00:00.000Z");
  const miss = await h.run("vendors.assess", { op: "incident_notice", vendor_id: "v-cloud", security_incident_id: "inc-2", notice_received_at: "2026-12-02T14:00:00Z" });
  assert.equal(miss.sla_met, false); assert.equal(miss.hours_to_notice, 30); assert.equal(miss.breach_logged, true); assert.equal(miss.reassessment_triggered, true);
  assert.equal(second.status, "satisfied_late"); assert.equal(h.ctx.events.ofType("vendor.sla_breach.logged").length, 1); assert.equal(h.ctx.events.ofType("vendor.assessment.due")[0]!.payload.kind, "triggered");
  assert.equal(h.rt.store.get("vendors", "v-cloud")!.data.next_assessment_due, "2026-12-02"); assert.equal(h.rt.store.get("vendors", "v-cloud")!.data.sla_breaches, 1);
  const def = loadOverriddenRegistry().get("SM_VENDOR_INCIDENT_NOTICE_SLA")!; assert.ok(eventMatches(def.triggerPattern!, h.ctx.events.ofType("vendor.incident.reported")[0]!)); assert.ok(eventMatches(def.satisfiedPattern!, h.ctx.events.ofType("vendor.incident.notice_received")[0]!));
});
test("19.3 FNMA_LL2026_04_POLICY_REVIEW_365: the owner's approval of AI-GOV-001 on 2026-08-20 arms the annual review to 2027-08-20; the agent can neither approve nor review; the owner's signed review on 2027-08-10 closes it and re-arms to 2028-08-10; a missed cycle breaches sev-2 → officer", async () => {
  const r = aiPolicyApproved({ policy_code: "AI-GOV-001", version: "2026.1", owner: "Chief Information Security Officer", approved_on: D("2026-08-20"), approved_by: OFFICER, document_id: "doc-ai-gov-001-2026", current: null });
  assert.equal(r.next_review_due, "2027-08-20"); assert.equal(r.event.payload.approved_on, "2026-08-20"); assert.equal(r.row.status, "approved"); assert.deepEqual(r.event.aggregate, { kind: "ai_policy_documents", id: "AI-GOV-001" });
  assert.throws(() => aiPolicyApproved({ policy_code: "AI-GOV-001", version: "2026.1", owner: "CISO", approved_on: D("2026-08-20"), approved_by: AGENT, document_id: null, current: null }), /designated owner/);
  const rv = aiPolicyReviewed({ row: r.row, policy_code: "AI-GOV-001", reviewed_on: D("2027-08-10"), reviewer: OFFICER, document_id: "doc-ai-gov-001-review-2027" });
  assert.equal(rv.late, false); assert.equal(rv.next_review_due, "2028-08-10"); assert.equal(rv.event.payload.signed_by_owner, true); assert.equal(rv.row.status, "reviewed");
  assert.equal(aiPolicyReviewed({ row: r.row, policy_code: "AI-GOV-001", reviewed_on: D("2027-09-01"), reviewer: OFFICER, document_id: null }).late, true);
  assert.throws(() => aiPolicyReviewed({ row: r.row, policy_code: "AI-GOV-001", reviewed_on: D("2027-08-10"), reviewer: ATTORNEY, document_id: null }), /designated owner/);
  assert.throws(() => aiPolicyReviewed({ row: null, policy_code: "AI-GOV-002", reviewed_on: D("2027-08-10"), reviewer: OFFICER, document_id: null }), /no approved version/);
  // on the bus: `ai_systems.upsert{policy}` is the owner's (officer) act; the approval arms the recurring clock, the review closes and re-arms it
  const h = bus19_3("2026-08-20T15:00:00.000Z");
  const policy = { code: "AI-GOV-001", version: "2026.1", owner: "Chief Information Security Officer", approved_on: "2026-08-20", document_id: "doc-ai-gov-001-2026" };
  await assert.rejects(h.run("ai_systems.upsert", { policy }, AGENT), refused("AI_POLICY_IS_THE_OWNERS"));
  const ap = await h.run("ai_systems.upsert", { policy }, OFFICER); assert.equal(ap.status, "approved"); assert.equal(ap.next_review_due, "2027-08-20"); assert.equal(ap.approved_by, "officer-1");
  const t = h.ctx.timers.byCode("FNMA_LL2026_04_POLICY_REVIEW_365"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2027-08-20"); assert.equal(t[0]!.anchorDate, "2026-08-20"); assert.deepEqual(t[0]!.subject, { kind: "ai_policy_documents", id: "AI-GOV-001" });
  await assert.rejects(h.run("ai_systems.upsert", { policy: { code: "AI-GOV-001", reviewed_on: "2027-08-10" } }, AGENT), refused("AI_POLICY_IS_THE_OWNERS"));
  h.clock.set("2027-08-10T15:00:00.000Z");
  const rev = await h.run("ai_systems.upsert", { policy: { code: "AI-GOV-001", reviewed_on: "2027-08-10", document_id: "doc-ai-gov-001-review-2027" } }, OFFICER);
  assert.equal(rev.late, false); assert.equal(rev.review_clock_closed, 1); assert.equal(rev.status, "reviewed"); assert.equal(rev.reviewed_by, "officer-1"); assert.equal(rev.next_review_due, "2028-08-10");
  const after = h.ctx.timers.byCode("FNMA_LL2026_04_POLICY_REVIEW_365"); assert.equal(after.length, 2); assert.equal(after[0]!.status, "satisfied"); assert.equal(after[1]!.status, "armed"); assert.equal(after[1]!.dueDate, "2028-08-10");
  const def = loadOverriddenRegistry().get("FNMA_LL2026_04_POLICY_REVIEW_365")!; assert.ok(eventMatches(def.triggerPattern!, h.ctx.events.ofType("ai.policy.approved")[0]!)); assert.ok(eventMatches(def.satisfiedPattern!, h.ctx.events.ofType("ai_policy.reviewed")[0]!));
  const b = h.ctx.timers.evaluate("2028-08-11T05:00:00.000Z").find((x) => x.def.code === "FNMA_LL2026_04_POLICY_REVIEW_365")!; assert.equal(b.instance.id, after[1]!.id); assert.equal(b.severity, 2); assert.deepEqual(b.escalateTo, ["officer"]);
});

test("19.3 worked examples: 180-day gate 2026-11-02 → 2027-05-01 (2027-04-01 blocked; Form 629 by 2027-04-01 for a May 1 transfer); 5-BD copies Fri 2026-11-20 → Mon 2026-11-30 (Thanksgiving skipped); termination Wed 2026-12-23 → Thu 2026-12-31 (Christmas skipped); the four Fannie Mae templates pass their checklists", () => {
  assert.equal(earliestCutover(D("2026-11-02")), "2027-05-01"); assert.equal(cutoverAllowed(D("2026-11-02"), D("2027-04-01")), false); assert.ok(cutoverAllowed(D("2026-11-02"), D("2027-05-01")));
  assert.equal(form629Clocks("sub_to_sub", D("2027-05-01")).deadline, "2027-04-01");
  // worked example 5: the notice of the partner's non-payment is a "notice of default … sent to the servicer" — copies AND the partner's own 5-BD notice land Mon 2026-11-30; counsel confirms the characterization within the window
  const nod = classifyContractEvent({ kind: "default_notice", direction: "sent_to_servicer", occurred_on: D("2026-11-20"), contract_kind: "tech_provider_addendum" });
  assert.equal(nod.copies_required, true); assert.equal(nod.copies_due, "2026-11-30"); assert.equal(nod.fnma_notice_required, true); assert.equal(nod.event_notice_due, "2026-11-30"); assert.deepEqual(nod.notices_required, ["a2101_event_5bd", "a2101_copies_5bd"]); assert.equal(nod.attorney_confirm_by, "2026-11-30");
  const term = classifyContractEvent({ kind: "termination", direction: "sent_by_provider", occurred_on: D("2026-12-23"), contract_kind: "tech_provider_addendum" });
  assert.equal(term.event_notice_due, "2026-12-31"); assert.equal(term.copies_required, false); assert.deepEqual(term.notices_required, ["a2101_event_5bd"]); assert.equal(term.attorney_confirm_by, null);
  // rule 1: threshold crossed mid-year is sticky through Dec 31 and logged with the count basis
  const counts = [{ on: D("2027-01-01"), count: 19990 }, { on: D("2027-08-03"), count: 20300 }, { on: D("2027-11-01"), count: 18000 }];
  const snap = thresholdSnapshot({ entity: "partner", counts_this_year: counts, as_of: D("2027-11-01"), previous_active: true });
  assert.equal(snap.a2101_regime_active, true); assert.equal(snap.year_max, 20300); assert.equal(snap.loan_count, 18000); assert.equal(snap.changed, false); assert.match(snap.basis, /20300 ≥ 20000/);
  assert.equal(thresholdSnapshot({ entity: "partner", counts_this_year: counts, as_of: D("2027-08-03"), previous_active: false }).changed, true);
  // guardrail: a clause is present only with an evidence excerpt; a deviation opens the attorney task
  assert.match(clauseEntry({ clause_code: "A2101_COPIES_5BD", status: "present", evidence_excerpt: "", reviewed_by: null }).refusal!, /evidence excerpt/);
  assert.equal(clauseEntry({ clause_code: "NO_TRAINING_ON_DATA", status: "deviation", evidence_excerpt: "§7.2", reviewed_by: null }).escalation?.kind, "attorney");
  // rule 6: the spec's mandatory set — the three A2-1-01 clauses, the A2-1-07 rescission acknowledgment for the subservicing agreement, and the AI-provider clauses
  assert.deepEqual(requiredClauses({ ai_provider: false }).slice(0, 3), ["A2101_COPIES_5BD", "A2101_FNMA_OWNERSHIP_FILES_DATA", "A2101_COOPERATE_TRANSFER_FEES"]);
  assert.ok(requiredClauses({ ai_provider: false, contract_kind: "subservicing_agreement" }).includes("A2107_RESCISSION_ACK")); assert.ok(!requiredClauses({ ai_provider: false, contract_kind: "vendor_msa" }).includes("A2107_RESCISSION_ACK"));
  assert.ok(requiredClauses({ ai_provider: true }).includes("NO_TRAINING_ON_DATA") && requiredClauses({ ai_provider: true }).includes("ZERO_RETENTION"));
  const legacy = Object.fromEntries(["A2101_COPIES_5BD", "A2101_FNMA_OWNERSHIP_FILES_DATA", "A2101_COOPERATE_TRANSFER_FEES", "SUPPLEMENT_FLOWDOWN_NO_LESS_PROTECTIVE", "LL2026_04_GOVERNANCE", "INCIDENT_NOTICE_24H", "AUDIT_RIGHTS", "DATA_USE_LIMITED_TG3", "A2101_TERMINATION_RETURN_DESTROY", "RECORDS_RETURN_5BD", "US_ONLY_PROCESSING", "SUBPROCESSOR_NOTICE", "NO_UI_SCRAPING"].map((c) => [c, "present" as const]));
  assert.equal(clauseChecklist(legacy, { ai_provider: false, attorney_signoff: false, officer_approval: false }).allowed, true);   // ./vendors.ts code names are aliases of the spec's codes
  assert.deepEqual(clauseChecklist({ ...legacy, A2101_COPIES_5BD: "n_a" }, { ai_provider: false, attorney_signoff: false, officer_approval: false }).missing, ["A2101_COPIES_5BD"]);   // a required clause cannot be n_a
  // state machine: a Tier 1 vendor cannot reach approved without the officer, and terminated needs the certification
  const full = Object.fromEntries(requiredClauses({ ai_provider: false }).map((c) => [c, "present" as const]));
  const t1 = { from: "due_diligence" as const, to: "approved" as const, tier: 1 as const, ai_ml_used: false, offshore: false, onboarding_assessment_completed: true, clauses: full, attorney_signoff: false, officer_approval: false, soc2_period_end: D("2026-06-30"), bcp_evidence: true, ai_systems_linked: false, ll2026_04_attestation: false, data_return_certified: false, credentials_revoked: false, as_of: D("2026-11-02") };
  const blocked = vendorTransition(t1); assert.equal(blocked.allowed, false); assert.ok(blocked.escalations.some((e) => e.kind === "officer"));
  assert.equal(vendorTransition({ ...t1, officer_approval: true }).allowed, true);
  assert.equal(vendorTransition({ ...t1, from: "offboarding", to: "terminated", officer_approval: true }).allowed, false); assert.equal(vendorTransition({ ...t1, from: "offboarding", to: "terminated", officer_approval: true, data_return_certified: true, credentials_revoked: true }).allowed, true);
  assert.deepEqual(contractExpiryWarnings(D("2027-06-30")).map((w) => [w.at, w.severity]), [["2027-01-01", "sev3"], ["2027-04-01", "sev2"], ["2027-05-31", "sev1"]]);
  // the four Fannie Mae templates render from the spec's worked examples and pass their checklists; the clocks are enforced by the checklist
  for (const code of ["NTC_FNMA_A2101_TECH_PROVIDER_CHANGE_180", "NTC_FNMA_A2101_CONTRACT_EVENT_5BD", "NTC_FNMA_A2101_CONTRACT_COPIES_5BD", "NTC_FNMA_LL2026_04_DISCLOSURE"]) {
    const v = reg.activeVersion(code, D("2026-09-01"))!; assert.ok(v, code); assert.equal(evaluateChecklist(v, v.samplePayload, render(v.source, v.samplePayload)).passed, true, code); assert.equal(reg.template(code).channelPolicy, "electronic_ok_without_esign");
  }
  const ev = reg.activeVersion("NTC_FNMA_A2101_CONTRACT_EVENT_5BD", D("2026-09-01"))!;
  assert.match(render(ev.source, ev.samplePayload).text, /termination, breach, or impairment of rights by servicer or the technology provider of or under such contract/);
  const late = { ...ev.samplePayload, business_days_after: 6 }; assert.equal(evaluateChecklist(ev, late, render(ev.source, late)).passed, false);
  const ch = reg.activeVersion("NTC_FNMA_A2101_TECH_PROVIDER_CHANGE_180", D("2026-09-01"))!;
  const short = { ...ch.samplePayload, planned_cutover: "2027-04-01", days_notice: 150 }; assert.ok(evaluateChecklist(ch, short, render(ch.source, short)).blocking.some((b) => b.rule_id === "notice-period"));
  const cp = reg.activeVersion("NTC_FNMA_A2101_CONTRACT_COPIES_5BD", D("2026-09-01"))!;
  const noCopy = { ...cp.samplePayload, copy_document_id: "" }; assert.equal(evaluateChecklist(cp, noCopy, render(cp.source, noCopy)).passed, false);
  const ll = reg.activeVersion("NTC_FNMA_LL2026_04_DISCLOSURE", D("2026-09-01"))!;
  assert.match(render(ll.source, ll.samplePayload).text, /types of AI\/ML used, the purpose and manner for such use, the safeguards implemented to mitigate risks/);
  assert.match(render(ll.source, ll.samplePayload).text, /lossmit-underwriter — purpose: loss mitigation/);
});
