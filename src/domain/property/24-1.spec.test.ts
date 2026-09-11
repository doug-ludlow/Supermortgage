// 24.1 Valuation method selection and ordering (value acceptance, value acceptance + property data, hybrid, desktop, traditional), appraiser independence, and property data collection
// spec/sections/24-property-valuation-eligibility-title-hazard-flood-insurance/24-1-valuation-method-selection-and-ordering-value-acceptance-val.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor } from "../../kernel/calendar/business.ts";
import { toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { formatCents } from "../../kernel/money/cents.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_24_1 } from "../../app/tools/section24-1.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { recordIntent, type IntentRecord } from "../application/ops-21-4.ts";
import {
  FakeAmc, FakePropertyDataApi, ValuationRefused, acceptTransferredReport, appraisalAgeDates, appraisalAgeStatus, appraiserLicenseGate, assignAppraiser, benchmarkFee, completeInspection, convertOnSafetyIssue, decisionRecord, detectOfferLoss, evaluateAppraisalUpdate, guardOrderPayload,
  exclusionsFor, offerAgeGate, offerExpiresOn, orderAppraisalUpdate, orderPdc, pdcSubmitGate, placeOrder, readDuOffer, receiveAppraisalUpdate, receiveReport, recordMethodSelection, recordPdcCollection, sameBusinessDay, selectMethod, submitPropertyData, validateOrderPayload, deliveryData, uadVersionForEngagement,
  type AppraiserFacts, type FeeBenchmark, type MethodFacts, type PlaceOrderInput, type DuOffer, type AmcRegistration,
} from "./ops-24-1.ts";

const AGENT: Actor = { kind: "agent", id: "valuation" };
const AMC: Actor = { kind: "external", id: "amc" };
const REFI = { app: "app-refi-1", loan: "L-REFI-1", tz: "America/Phoenix", state: "AZ" };
const PURCH = { app: "app-purch-1", loan: "L-PURCH-1", tz: "America/New_York", state: "OH" };
/** Creditor time (Phoenix: MST all year, UTC−7) and Eastern time (Columbus OH fixture). */
const mst = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/Phoenix"));
const et = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/New_York"));
/** R3 fixture: Maricopa County, Form 1004 (UAD 3.6 URAR), median 60,000 cents, p25 52,500, p75 70,000 (third-party survey, §1026.42(f)(3)). */
const BENCH: FeeBenchmark = { benchmark_id: "bench-az-013-urar", state: "AZ", county_fips: "04013", form_code: "urar_uad36", assignment_type: "traditional", median_fee_cents: 60_000n, p25_fee_cents: 52_500n, p75_fee_cents: 70_000n, source: "third_party_survey_1026_42f3", as_of: D("2026-07-01") };
const AMC_REG: AmcRegistration = { amc_registration_id: "amcreg-az-1", amc_party_id: "amc-1", state: "AZ", registration_number: "AMC-AZ-1234", expires_on: D("2027-06-30"), asc_amc_registry_status: "active", verified_at: mst("2026-10-01", "09:00") };
const AMC_REG_OH: AmcRegistration = { ...AMC_REG, amc_registration_id: "amcreg-oh-1", state: "OH", registration_number: "AMC-OH-5678" };
/** Refinance fixture: $560,000 LCOR on $800,000 (LTV 70 %), Phoenix AZ, 1-unit SFR, principal residence. */
const REFI_FACTS: MethodFacts = { offer_type: "none", transaction_type: "limited_cash_out", occupancy: "primary", units: 1, property_type: "sfr", ltv_bps: 7000, ordered_on: D("2026-10-06") };
/** Purchase fixture: $412,000 on $457,800 (LTV 90 %), Columbus OH, 1-unit SFR, principal residence; DU offers VA+PD and hybrid. */
const PURCH_FACTS: MethodFacts = { offer_type: "value_acceptance_pd", hybrid_offered: true, transaction_type: "purchase", occupancy: "primary", units: 1, property_type: "sfr", ltv_bps: 9000, ordered_on: D("2026-10-20") };
const APPRAISER_AZ: AppraiserFacts = { party_id: "appr-az-1", license_state: "AZ", license_type: "certified_residential", license_number: "CRA-41234", license_expires_on: D("2027-06-30"), asc_registry_status: "active", asc_registry_checked_on: D("2026-10-06") };
const PAYLOAD = { address: "4120 N 44th St, Phoenix AZ 85018", legal_description: "Lot 12, Arcadia Estates", unit_count: 1, occupancy: "primary", transaction_type: "limited_cash_out", access_contact: { name: "Alex Fixture", phone: "602-555-0100" }, hoa_contact: null, scope: "traditional", form_code: "urar_uad36", uad_version: "3.6" };

/** The 24.1 tools on the bus over the overridden registry (24.1 rows only), a memory ledger and the escalation service; the harness appends the upstream events (21.2 / 21.4 / 23.1 / 26.2) with origination context. */
function harness(nowIso: string, fx = REFI) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId: fx.app });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["24.1"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId: fx.loan, applicationId: fx.app, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const amc = new FakeAmc(); const pd = new FakePropertyDataApi();
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: { amc, propertyData: pd }, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_24_1); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("24.1", name))!, actor, { application_id: fx.app, time_zone: fx.tz, ...input }, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === fx.app);
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt = clock.now(), actor: Actor = { kind: "agent", id: "underwriter" }) => events.append({ type, applicationId: fx.app, aggregate: { kind: "application", id: fx.app }, actor, occurredAt, payload: { application_id: fx.app, ...payload } });
  /** 23.1's findings: `du.findings.received{value_acceptance_offer, du_submission_id, messages}` (ops-23-1 in flight — appended here). */
  const du = (offer: "value_acceptance" | "value_acceptance_pd" | "none", on: string, atIso: string, n = 1, messages: string[] = []) => upstream("du.findings.received", { du_submission_id: `du-${fx.app}-${n}`, submission_number: n, value_acceptance_offer: offer, offer_issued_at: on, recommendation: "approve_eligible", messages }, atIso);
  const leReceived = (on: string, atIso: string) => upstream("disclosure.le.received", { disclosure_id: "le-1", le_version: 1, evidence: "esign_confirmed", received_on: on, effective_receipt_date: on }, atIso, { kind: "agent", id: "disclosure" });
  /** 21.4's intent record (recordIntent → `intent.to_proceed.received{valid=true}`), kept in `intent_records` where the tools read it. */
  const intent = (atIso: string): IntentRecord => { const r = recordIntent(events, { application_id: fx.app, disclosure_id: "le-1", le_effective_receipt_date: D(atIso.slice(0, 10)) <= D("2026-10-05") ? D("2026-10-05") : D(atIso.slice(0, 10)) , received_at: atIso, channel: "app_button", statement_text: "I want to proceed", evidence_document_id: "evt-tap-1", recorded_by: "agent:intake", time_zone: fx.tz }); rt.store.put("intent_records", r.record.intent_id, { ...r.record }, AGENT, atIso); return r.record; };
  const consummate = (on: string, atIso: string) => upstream("closing.consummated", { consummation_on: on, consummation_at: atIso, note_date: on }, atIso, { kind: "agent", id: "title-closing" });
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  const feeTest = () => benchmarkFee({ gross_cents: 65_000n, appraiser_share_cents: 55_000n, amc_share_cents: 10_000n }, BENCH);
  return { rt, uow, events, ledger, timers, run, at, timer, ofType, upstream, du, leReceived, intent, consummate, refused, feeTest, decisions, clock, amc, pd, fx };
}
/** A placed order through the pure ops (no bus): refinance fixture, AMC path, SM-borne fee, intent in force. */
function placedOrder(h: ReturnType<typeof harness>, orderedAt: string, o: Partial<PlaceOrderInput> = {}) {
  const intent = o.fee_gate?.intent ?? h.intent(mst("2026-10-06", "08:40"));
  const offer: DuOffer = readDuOffer(h.events, h.fx.app);
  const selection = o.selection ?? selectMethod({ ...REFI_FACTS, offer_type: offer.offer_type });
  return placeOrder(h.events, { application_id: h.fx.app, selection, offer, ordered_at: orderedAt, property_state: h.fx.state, channel: "amc", vendor_party_id: "amc-1", fee_paid_by: "sm", fee_quote_cents: 65_000n, fee_test: h.feeTest(), fee_gate: { le_effective_receipt_date: D("2026-10-05"), intent }, amc_registration: h.fx.state === "AZ" ? AMC_REG : AMC_REG_OH, order_payload: PAYLOAD, amc: h.amc, time_zone: h.fx.tz, ...o });
}

test("24.1-T1: Given ITP received Tue Oct 6, 2026 08:40 MST and `fee_paid_by = borrower`, when the agent attempts `placeOrder` at 08:30 MST, then the command is refused with `REGZ_1026_19E2_INTENT_FEE_GATE` closed; at 08:41 it succeeds.", async () => {
  const h = harness(mst("2026-10-05", "09:10"));
  h.du("none", "2026-10-05", mst("2026-10-05", "16:30")); h.leReceived("2026-10-05", mst("2026-10-05", "17:42"));
  const intent = h.intent(mst("2026-10-06", "08:40"));   // 21.4: intent_records.valid = true (received after LE receipt)
  assert.equal(intent.valid, true);
  const fee_test = h.feeTest();
  const order = { ...REFI_FACTS, fee_paid_by: "borrower", fee_quote_cents: 65_000n, fee_test, property_state: "AZ", vendor_party_id: "amc-1", channel: "amc", amc_registration: AMC_REG, order_payload: PAYLOAD, le_effective_receipt_date: "2026-10-05", fee_item_id: "fee-appraisal" };
  h.at(mst("2026-10-06", "08:30"));
  const r = await h.refused(h.run("placeOrder", { ...order, ordered_at: mst("2026-10-06", "08:30") }), "REGZ_1026_19E2_INTENT_FEE_GATE");
  assert.match(r.message, /closed_no_intent/); assert.equal(r.citation, "12 CFR 1026.19(e)(2)(i)(A); 21.4 rule 1");
  assert.equal(h.ofType("valuation.ordered").length, 0); assert.equal(h.amc.orders.size, 0, "nothing transmitted to the AMC");
  const checks = h.ofType("fee.gate.checked");   // 21.4: every guarded attempt is a fee_gate_checks row, refusals included
  assert.equal(checks.length, 1); assert.equal(checks[0]!.payload.result, "closed_no_intent"); assert.equal(checks[0]!.payload.command, "order_appraisal"); assert.equal(checks[0]!.payload.amount_cents, "65000");
  h.at(mst("2026-10-06", "08:41"));
  const ok = await h.run("placeOrder", { ...order, ordered_at: mst("2026-10-06", "08:41") });
  assert.equal(ok.status, "ordered"); assert.equal(ok.fee_gate, "zero", "borrower-paid appraisal fee is a zero-tolerance charge (consumer cannot shop)");
  assert.equal(h.ofType("fee.gate.checked").at(-1)!.payload.result, "open"); assert.equal(h.ofType("valuation.ordered").length, 1);
  const stored = h.rt.store.require("valuation_orders", String(ok.order_id)).data;
  assert.equal(stored.fee_paid_by, "borrower"); assert.equal(stored.fee_gate_evidence_id, h.ofType("fee.gate.checked").at(-1)!.payload.check_id);
  assert.equal(h.amc.orders.size, 1); assert.equal(h.timer("SM_VALUATION_ASSIGN_SLA_2BD")!.status, "armed");
  // the same order by the mlo_of_record (an AIR §4.1.1 restricted party) is refused regardless of the gate
  await h.refused(h.run("placeOrder", { ...order, ordered_at: mst("2026-10-06", "08:42") }, { kind: "human", id: "u-mlo", role: "mlo_of_record" }), "AIR_4_1_1_RESTRICTED_PARTY");
});

test("24.1-T2: Given the refinance fixture with `offer_type = none`, when R1 runs, then `method = traditional`, `form_code = urar_uad36`, `desktop` is excluded with reason \"refinance\", and a decision record with the exclusion list is written.", async () => {
  const sel = selectMethod(REFI_FACTS);
  assert.equal(sel.method, "traditional"); assert.equal(sel.form_code, "urar_uad36"); assert.equal(sel.uad_version, "3.6"); assert.equal(sel.assignment_type, "traditional");
  const desktop = sel.exclusions.filter((e) => e.method === "desktop");
  assert.equal(desktop[0]!.reason, "refinance"); assert.match(desktop[0]!.citation, /B4-1\.2-02/);
  assert.deepEqual(sel.exclusions.filter((e) => e.method === "value_acceptance").map((e) => e.reason), ["no DU value acceptance offer"]);
  assert.deepEqual(sel.exclusions.filter((e) => e.method === "hybrid").map((e) => e.reason), ["DU did not offer hybrid appraisals"]);
  assert.equal(sel.second_appraisal_required, false);
  const rec = decisionRecord(sel, { application_id: REFI.app, offer_type: "none", du_submission_id: "du-app-refi-1-1" });
  assert.equal(rec.method, "traditional"); assert.equal(rec.rule_set_version, "fnma.selling.2026-09-02"); assert.ok(rec.exclusions_fired.some((e) => e.method === "desktop" && e.reason === "refinance")); assert.ok(rec.model_version && rec.prompt_version && rec.confidence > 0);
  // through the bus: the selection event, the store row with the exclusion list and the agent decision row
  const h = harness(mst("2026-10-06", "09:00"));
  h.du("none", "2026-10-05", mst("2026-10-05", "16:30"));
  const out = await h.run("selectMethod", { transaction_type: "limited_cash_out", occupancy: "primary", units: 1, property_type: "sfr", ltv_bps: 7000, at: mst("2026-10-06", "09:00") });
  assert.equal(out.method, "traditional"); assert.equal(out.form_code, "urar_uad36"); assert.equal(out.offer_type, "none"); assert.equal(out.offer_lost, false);
  const ev = h.ofType("valuation.method.selected")[0]!;
  assert.equal(ev.payload.method, "traditional"); assert.ok((ev.payload.exclusions_fired as string[]).includes("desktop:refinance")); assert.equal(ev.payload.selected_on, "2026-10-06");
  assert.equal(h.decisions.length, 1); assert.equal(h.decisions[0]!.action, "selectMethod"); assert.match(h.decisions[0]!.rationale, /desktop:refinance/); assert.equal(h.decisions[0]!.ruleCode, "24.1 R1");
  const row = h.rt.store.require("valuation_method_selections", String(out.selection_id)).data;
  assert.ok((row.exclusions_fired as { method: string; reason: string }[]).some((e) => e.method === "desktop" && e.reason === "refinance"));
  assert.equal(h.timer("SM_VALUATION_ORDER_SLA_1BD")!.status, "armed", "method ≠ VA arms the same-business-day order SLA");
});

test("24.1-T3: Given order Tue Oct 6, assignment Wed Oct 7, inspection Sat Oct 10 and report Thu Oct 15, 2026, then `SM_VALUATION_ORDER_SLA_1BD`, `_ASSIGN_SLA_2BD`, `_INSPECT_SLA_7CD` and `_REPORT_SLA_10CD` are all satisfied and `age_4m_update_after = 2027-02-10`, `age_12m_expires_on = 2027-10-10`.", () => {
  const h = harness(mst("2026-10-05", "09:10"));
  h.du("none", "2026-10-05", mst("2026-10-05", "16:30")); h.leReceived("2026-10-05", mst("2026-10-05", "17:42"));
  const intent = h.intent(mst("2026-10-06", "08:40"));
  const sel = selectMethod(REFI_FACTS);
  recordMethodSelection(h.events, REFI.app, sel, mst("2026-10-06", "09:00"), { offer_type: "none" });
  const order = h.timer("SM_VALUATION_ORDER_SLA_1BD")!;
  assert.equal(order.anchorDate, "2026-10-06"); assert.equal(order.dueDate, "2026-10-07"); assert.equal(order.dueDate, addBusinessDays(D("2026-10-06"), 1, creditor));
  const placed = placedOrder(h, mst("2026-10-06", "09:15"), { fee_gate: { le_effective_receipt_date: D("2026-10-05"), intent } });
  assert.equal(order.status, "satisfied"); assert.equal(placed.order.uad_version, "3.6"); assert.equal(uadVersionForEngagement(D("2026-10-06")), "3.6");   // engaged 3.6 from Sept 8, 2026 (removes the FNM0391 risk)
  const assign = h.timer("SM_VALUATION_ASSIGN_SLA_2BD")!, report = h.timer("SM_VALUATION_REPORT_SLA_10CD")!;
  assert.equal(assign.dueDate, "2026-10-08"); assert.equal(report.dueDate, "2026-10-16");
  const a = assignAppraiser(h.events, placed.order, APPRAISER_AZ, mst("2026-10-07", "10:00"));   // AZ license verified, ASC check Oct 6
  assert.equal(a.reassigned, false); assert.equal(assign.status, "satisfied");
  const inspect = h.timer("SM_VALUATION_INSPECT_SLA_7CD")!;
  assert.equal(inspect.dueDate, "2026-10-14", "7 calendar days — Columbus Day Mon Oct 12 is irrelevant to a calendar-day timer");
  assert.equal(h.timer("SM_APPRAISER_LICENSE_GATE")!.status, "satisfied", "the appraiser_panel verification snapshot closes the license gate");
  const done = completeInspection(h.events, a.order, mst("2026-10-10", "11:00"));
  assert.equal(inspect.status, "satisfied");
  const r = receiveReport(h.events, done.order, { report_document_id: "doc-urar-1", uad_version: "3.6", effective_date: D("2026-10-10"), received_at: mst("2026-10-15", "14:20"), lender_client_name: "Partner Bank, N.A.", partner_name: "Partner Bank, N.A.", fee_invoice_cents: 65_000n }, h.ledger, AMC);
  assert.equal(r.accepted, true); assert.equal(report.status, "satisfied");
  assert.equal(r.order.age_4m_update_after, "2027-02-10"); assert.equal(r.order.age_12m_expires_on, "2027-10-10");
  assert.deepEqual(appraisalAgeDates(D("2026-10-10")), { age_4m_update_after: D("2027-02-10"), age_12m_expires_on: D("2027-10-10") });
  for (const code of ["SM_VALUATION_ORDER_SLA_1BD", "SM_VALUATION_ASSIGN_SLA_2BD", "SM_VALUATION_INSPECT_SLA_7CD", "SM_VALUATION_REPORT_SLA_10CD"]) assert.equal(h.timer(code)!.status, "satisfied", code);
  assert.equal(h.timer("FNMA_B4_1_2_04_APPRAISAL_UPDATE_4M")!.dueDate, "2027-02-10"); assert.equal(h.timer("FNMA_B4_1_2_04_APPRAISAL_12M")!.anchorDate, "2026-10-10");
  assert.equal(appraisalAgeStatus(D("2026-10-10"), D("2026-11-06")).status, "current"); assert.equal(daysBetween(D("2026-10-10"), D("2026-11-06")), 27);   // consummation Nov 6 → no update
  assert.equal(h.ofType("valuation.received")[0]!.payload.opens, "24.2");
});

test("24.1-T4: Given effective date Oct 10, 2026 and a note date of Feb 16, 2027, when `consummate` is asserted, then `FNMA_B4_1_2_04_APPRAISAL_UPDATE_4M` blocks until an update dated between Oct 16, 2026 and Feb 16, 2027 with \"not declined\" is received; a \"declined\" update forces `method_pending`.", () => {
  const age = appraisalAgeStatus(D("2026-10-10"), D("2027-02-16"));
  assert.equal(age.status, "update_required"); assert.deepEqual(age.update_window, { from: D("2026-10-16"), to: D("2027-02-16") });   // 4 months + 6 days old
  const blocked = evaluateAppraisalUpdate(D("2026-10-10"), D("2027-02-16"), null);
  assert.equal(blocked.open, false); assert.equal(blocked.next_status, "update_required"); assert.match(blocked.reason, /within the four months before the note date/);
  const early = evaluateAppraisalUpdate(D("2026-10-10"), D("2027-02-16"), { effective_date: D("2026-10-15"), declined: false, report_document_id: "doc-upd-0" });
  assert.equal(early.open, false, "an update dated before Oct 16 is outside the window");
  const good = evaluateAppraisalUpdate(D("2026-10-10"), D("2027-02-16"), { effective_date: D("2027-01-20"), declined: false, report_document_id: "doc-upd-1" });
  assert.equal(good.open, true); assert.equal(good.next_status, "consummate");
  const declined = evaluateAppraisalUpdate(D("2026-10-10"), D("2027-02-16"), { effective_date: D("2027-01-20"), declined: true, report_document_id: "doc-upd-2" });
  assert.equal(declined.open, false); assert.equal(declined.next_status, "method_pending"); assert.match(declined.reason, /new appraisal/);
  assert.equal(evaluateGate("24.1.appraisalAge12mGate", { effective_date: "2026-10-10", note_date: "2027-02-16" }).open, true);
  assert.equal(evaluateGate("24.1.appraisalAge12mGate", { effective_date: "2026-10-10", note_date: "2027-10-10" }).open, false, "12 months on the note date → new appraisal (strict >)");
  // the timer: armed from valuation.received (effective_date), due Feb 10, 2027; the UAD 3.6 Restricted Appraisal Update Report received "not declined" satisfies it (late); "declined" cancels the original
  const h = harness(mst("2026-10-05", "09:10"));
  h.du("none", "2026-10-05", mst("2026-10-05", "16:30")); h.leReceived("2026-10-05", mst("2026-10-05", "17:42"));
  const placed = placedOrder(h, mst("2026-10-06", "09:15"));
  const a = assignAppraiser(h.events, placed.order, APPRAISER_AZ, mst("2026-10-07", "10:00"));
  const received = receiveReport(h.events, a.order, { report_document_id: "doc-urar-1", uad_version: "3.6", effective_date: D("2026-10-10"), received_at: mst("2026-10-15", "14:20") }, h.ledger, AMC);
  const t = h.timer("FNMA_B4_1_2_04_APPRAISAL_UPDATE_4M")!;
  assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2027-02-10");
  const upd = orderAppraisalUpdate(h.events, received.order, mst("2027-01-12", "09:00"), D("2027-02-16"));
  assert.equal(upd.order.form_code, "update_uad36"); assert.equal(upd.order.assignment_type, "appraisal_update"); assert.deepEqual(upd.window, { from: D("2026-10-16"), to: D("2027-02-16") });
  assert.equal(h.ofType("valuation.update.ordered").length, 1);
  const ok = receiveAppraisalUpdate(h.events, received.order, upd.order, { effective_date: D("2027-01-20"), declined: false, report_document_id: "doc-upd-1", received_at: mst("2027-01-22", "10:00") }, D("2027-02-16"));
  assert.equal(ok.evaluation.open, true); assert.equal(ok.parent.status, "report_received"); assert.equal(h.timer("FNMA_B4_1_2_04_APPRAISAL_UPDATE_4M")!.status, "satisfied");
  const upd2 = orderAppraisalUpdate(h.events, received.order, mst("2027-01-12", "09:00"), D("2027-02-16"));
  const bad = receiveAppraisalUpdate(h.events, received.order, upd2.order, { effective_date: D("2027-01-25"), declined: true, report_document_id: "doc-upd-2", received_at: mst("2027-01-27", "10:00") }, D("2027-02-16"));
  assert.equal(bad.evaluation.next_status, "method_pending"); assert.equal(bad.parent.status, "method_pending");
  assert.equal(h.ofType("valuation.order.cancelled").at(-1)!.payload.reason, "appraisal_update_declined_new_appraisal_required");
});

test("24.1-T5: Given the purchase fixture with `value_acceptance_pd` offered Oct 19, 2026 and PDC accepted Oct 26, when the note date is Nov 18, 2026, then both `FNMA_B4_1_4_10_VALUE_ACCEPTANCE_OFFER_4M` (expiry Feb 19, 2027) and `FNMA_B4_1_4_11_PDC_API_SUBMIT_GATE` are satisfied and delivery data carries SFC 774 and the Property Data ID.", async () => {
  const h = harness(et("2026-10-19", "09:30"), PURCH);
  h.du("value_acceptance_pd", "2026-10-19", et("2026-10-19", "11:00"), 1, ["DU offers hybrid appraisals"]);
  const offerTimer = h.timer("FNMA_B4_1_4_10_VALUE_ACCEPTANCE_OFFER_4M")!;
  assert.equal(offerTimer.anchorDate, "2026-10-19"); assert.equal(offerTimer.dueDate, "2027-02-19"); assert.equal(offerExpiresOn(D("2026-10-19")), "2027-02-19");
  const offer = readDuOffer(h.events, PURCH.app);
  assert.equal(offer.offer_type, "value_acceptance_pd"); assert.equal(offer.hybrid_offered, true); assert.equal(offer.offer_issued_at, "2026-10-19");
  const sel = selectMethod({ ...PURCH_FACTS, offer_type: offer.offer_type });
  assert.equal(sel.method, "value_acceptance_pd"); assert.equal(sel.form_code, null);
  recordMethodSelection(h.events, PURCH.app, sel, et("2026-10-19", "11:05"), { offer_type: offer.offer_type, du_submission_id: offer.du_submission_id, time_zone: PURCH.tz });
  const gate = h.timer("FNMA_B4_1_4_11_PDC_API_SUBMIT_GATE")!;
  assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:24.1.pdcApiSubmitGate");
  h.leReceived("2026-10-19", et("2026-10-19", "17:00")); h.at(et("2026-10-20", "10:05")); h.intent(et("2026-10-20", "09:30"));
  const ordered = await h.run("submitPropertyData", { op: "order", vendor_party_id: "pdc-vendor-1", collector_party_id: "collector-7", collector_background_check_on: "2026-03-03", collector_training_evidence_id: "doc-training-7", pdcir_attestation_id: "doc-pdcir-7", ordered_at: et("2026-10-20", "10:05"), le_effective_receipt_date: "2026-10-19" });
  assert.equal(ordered.status, "pdc_ordered"); assert.equal(h.timer("SM_VALUATION_ORDER_SLA_1BD")!.status, "armed", "VA+PD still orders the PDC (method ≠ VA)");
  h.at(et("2026-10-23", "15:00"));
  const collected = await h.run("submitPropertyData", { op: "collect", pdc_id: ordered.pdc_id, collected_at: et("2026-10-23", "15:00"), upd_version: "UPD-1.1", floor_plan_document_id: "doc-floorplan-1", image_document_ids: ["img-1", "img-2", "img-3"], safety_issue_flag: false });
  assert.equal(collected.status, "pdc_collected"); assert.equal(collected.safety_issue_flag, false);
  h.at(et("2026-10-26", "09:00"));
  const submitted = await h.run("submitPropertyData", { op: "submit", pdc_id: ordered.pdc_id, submitted_at: et("2026-10-26", "09:00") });
  assert.equal(submitted.submission_status, "accepted"); assert.equal(submitted.accepted_on, "2026-10-26"); assert.match(String(submitted.property_data_id_fnma), /^PDID-/);
  assert.equal(gate.status, "satisfied", "pdc.accepted closes FNMA_B4_1_4_11_PDC_API_SUBMIT_GATE (Oct 26 < note date Nov 18)");
  assert.equal(evaluateGate("24.1.pdcApiSubmitGate", { property_data_id_fnma: submitted.property_data_id_fnma, accepted_on: "2026-10-26", collected_on: "2026-10-23", note_date: "2026-11-18" }).open, true);
  assert.equal(pdcSubmitGate({ property_data_id_fnma: null, accepted_on: null, note_date: D("2026-11-18") }).open, false);
  const oa = offerAgeGate(D("2026-10-19"), D("2026-11-18"));
  assert.equal(oa.open, true); assert.equal(oa.expires_on, "2027-02-19"); assert.equal(daysBetween(D("2026-10-19"), D("2026-11-18")), 30);
  h.consummate("2026-11-18", et("2026-11-18", "14:00"));
  assert.equal(offerTimer.status, "satisfied", "closing.consummated on/before Feb 19, 2027 satisfies the offer-age row");
  const pdc = h.rt.store.require("property_data_collections", String(ordered.pdc_id)).data;
  const dd = deliveryData({ method: "value_acceptance_pd" }, pdc as unknown as Parameters<typeof deliveryData>[1]);
  assert.deepEqual(dd.special_feature_codes, ["774"]); assert.equal(dd.property_data_id_fnma, submitted.property_data_id_fnma);
  assert.equal(offerAgeGate(D("2026-10-19"), D("2027-02-20")).open, false); assert.equal(offerExpiresOn(D("2026-10-31")), "2027-02-28");   // R6 clamp
});

test("24.1-T6: Given a PDC with `safety_issue_flag = true` (collector reports active roof leak), then VA+PD is blocked, `converted_to_hybrid` is recorded, the PDC is attached to the hybrid engagement, and the lender representation rule is cited in the decision.", () => {
  const h = harness(et("2026-10-19", "09:30"), PURCH);
  h.du("value_acceptance_pd", "2026-10-19", et("2026-10-19", "11:00"), 1, ["DU offers hybrid appraisals"]); h.leReceived("2026-10-19", et("2026-10-19", "17:00"));
  const intent = h.intent(et("2026-10-20", "09:30"));
  const offer = readDuOffer(h.events, PURCH.app);
  const ordered = orderPdc(h.events, PURCH.app, { vendor_party_id: "pdc-vendor-1", collector_party_id: "collector-7", collector_background_check_on: D("2026-03-03"), collector_training_evidence_id: "doc-training-7", pdcir_attestation_id: "doc-pdcir-7" }, et("2026-10-20", "10:05"), { legally_engaged: false, check: null, evidence_id: intent.intent_id, tolerance_class: "not_a_consumer_charge" });
  const collected = recordPdcCollection(h.events, ordered.pdc, { collected_at: et("2026-10-23", "15:00"), upd_version: "UPD-1.1", floor_plan_document_id: "doc-floorplan-1", image_document_ids: ["img-1", "img-2"], safety_issue_flag: true, safety_issue_notes: "active roof leak observed in the primary bedroom ceiling", interior_observed: true, exterior_observed: true, ansi_floor_plan: true });
  assert.equal(collected.pdc.safety_issue_flag, true); assert.equal(collected.safety_event!.type, "pdc.safety_issue.flagged"); assert.match(String(collected.safety_event!.payload.rule), /safety, soundness, or structural integrity/);
  assert.throws(() => submitPropertyData(h.events, collected.pdc, h.pd, et("2026-10-26", "09:00")), (e: unknown) => e instanceof ValuationRefused && e.code === "FNMA_B4_1_4_11_SAFETY_ISSUE");
  const sel = selectMethod({ ...PURCH_FACTS, pdc_on_file: true, pdc_safety_issue: true });
  assert.equal(sel.method, "hybrid"); assert.ok(sel.exclusions.some((e) => e.method === "value_acceptance_pd" && /safety, soundness, or structural integrity/.test(e.reason)));
  const conv = convertOnSafetyIssue(h.events, PURCH.app, collected.pdc, PURCH_FACTS, et("2026-10-23", "16:00"), offer);
  assert.equal(conv.conversion, "converted_to_hybrid"); assert.equal(conv.selection.method, "hybrid"); assert.equal(conv.selection.form_code, "1004_hybrid"); assert.equal(conv.pdc_shared, true);
  assert.equal(conv.event.payload.conversion, "converted_to_hybrid"); assert.equal(conv.event.payload.pdc_id, collected.pdc.pdc_id);
  assert.ok(conv.decision.citations.some((c) => /B4-1\.4-11: the lender represents the property does not have safety, soundness, or structural integrity issues/.test(c)), "lender representation rule cited");
  assert.ok(conv.decision.citations.some((c) => /share the property data collection with the appraiser at the time of engagement/.test(c)));
  // the PDC is attached to the hybrid engagement: the order carries pdc_id and the assignment shares it with the appraiser
  const placed = placedOrder(h, et("2026-10-23", "16:30"), { selection: conv.selection, fee_gate: { le_effective_receipt_date: D("2026-10-19"), intent }, pdc_id: collected.pdc.pdc_id, order_payload: { ...PAYLOAD, address: "88 Neil Ave, Columbus OH 43215", transaction_type: "purchase", scope: "hybrid", form_code: "1004_hybrid", pdc_id: collected.pdc.pdc_id, pdc_document_id: "doc-floorplan-1" } });
  assert.equal(placed.order.pdc_id, collected.pdc.pdc_id); assert.equal(placed.order.method, "hybrid");
  const a = assignAppraiser(h.events, placed.order, { ...APPRAISER_AZ, party_id: "appr-oh-1", license_state: "OH", asc_registry_checked_on: D("2026-10-20") }, et("2026-10-26", "10:00"));
  assert.equal(a.event.payload.pdc_shared_at_engagement, true); assert.equal(a.event.payload.pdc_id, collected.pdc.pdc_id);
  assert.ok((h.amc.orders.values().next().value!.payload as Record<string, unknown>).pdc_id === collected.pdc.pdc_id, "the PDC file travels in the engagement payload");
});

test("24.1-T7: Given an outbound order payload containing `estimated_value` or `loan_amount`, then schema validation rejects the payload before transmission and an `air.guardrail.blocked` audit row is written.", async () => {
  const v1 = validateOrderPayload({ ...PAYLOAD, estimated_value: 80_000_000n });
  assert.equal(v1.ok, false); assert.deepEqual(v1.violations, ["estimated_value"]);
  const v2 = validateOrderPayload({ ...PAYLOAD, engagement_terms: { turn_time_days: 7, loan_amount: "560000" } });
  assert.equal(v2.ok, false); assert.deepEqual(v2.violations, ["engagement_terms.loan_amount"], "nested keys are scanned too");
  assert.equal(validateOrderPayload(PAYLOAD).ok, true);
  assert.equal(validateOrderPayload({ ...PAYLOAD, du_estimated_value: 1 }).ok, false); assert.equal(validateOrderPayload({ ...PAYLOAD, comparables: [] }).ok, false); assert.equal(validateOrderPayload({ ...PAYLOAD, target_ltv: 70 }).ok, false);
  const h = harness(mst("2026-10-06", "09:15"));
  h.du("none", "2026-10-05", mst("2026-10-05", "16:30")); h.leReceived("2026-10-05", mst("2026-10-05", "17:42"));
  assert.throws(() => guardOrderPayload(h.events, REFI.app, "order-x", { ...PAYLOAD, loan_amount: "560000" }, mst("2026-10-06", "09:15")), (e: unknown) => e instanceof ValuationRefused && e.code === "AIR_1_2_VALUE_INFORMATION" && e.citation === "AIR §1.2; 12 CFR 1026.42(c)(1)");
  const audit = h.ofType("air.guardrail.blocked");
  assert.equal(audit.length, 1); assert.deepEqual(audit[0]!.payload.violations, ["loan_amount"]); assert.equal(audit[0]!.payload.order_id, "order-x"); assert.equal(audit[0]!.payload.actor_is_restricted_party, false);
  assert.equal(h.amc.orders.size, 0, "nothing was transmitted");
  // placeOrder (ops) writes the audit row before refusing; the bus tool refuses on the same code
  const intent = h.intent(mst("2026-10-06", "08:40"));
  assert.throws(() => placedOrder(h, mst("2026-10-06", "09:16"), { fee_gate: { le_effective_receipt_date: D("2026-10-05"), intent }, order_payload: { ...PAYLOAD, estimated_value: "800000" } }), (e: unknown) => e instanceof ValuationRefused && e.code === "AIR_1_2_VALUE_INFORMATION");
  assert.equal(h.ofType("air.guardrail.blocked").length, 2); assert.equal(h.ofType("valuation.ordered").length, 0); assert.equal(h.amc.orders.size, 0);
  await h.refused(h.run("placeOrder", { ...REFI_FACTS, fee_paid_by: "sm", fee_quote_cents: 65_000n, fee_test: h.feeTest(), property_state: "AZ", vendor_party_id: "amc-1", amc_registration: AMC_REG, order_payload: { ...PAYLOAD, loan_amount: "560000" }, le_effective_receipt_date: "2026-10-05" }), "AIR_1_2_VALUE_INFORMATION");
});

test("24.1-T8: Given an AMC quote whose appraiser share is 45,000 cents against a benchmark p25 of 52,500 with no (f)(2) adjustment reason, then `benchmarkFee` fails and the order is held for vendor re-quote.", async () => {
  const t = benchmarkFee({ gross_cents: 55_000n, appraiser_share_cents: 45_000n, amc_share_cents: 10_000n }, BENCH);
  assert.equal(t.pass, false); assert.equal(t.held_for_requote, true); assert.equal(t.tested_cents, 45_000n); assert.equal(t.p25_fee_cents, 52_500n); assert.match(t.reason, /no \(f\)\(2\) adjustment reason — held for vendor re-quote/);
  const h = harness(mst("2026-10-06", "09:15"));
  h.du("none", "2026-10-05", mst("2026-10-05", "16:30")); h.leReceived("2026-10-05", mst("2026-10-05", "17:42"));
  const intent = h.intent(mst("2026-10-06", "08:40"));
  assert.throws(() => placedOrder(h, mst("2026-10-06", "09:15"), { fee_test: t, fee_quote_cents: 55_000n, fee_gate: { le_effective_receipt_date: D("2026-10-05"), intent } }), (e: unknown) => e instanceof ValuationRefused && e.code === "REGZ_1026_42F_FEE_BENCHMARK");
  assert.equal(h.ofType("valuation.ordered").length, 0); assert.equal(h.amc.orders.size, 0, "held: nothing transmitted");
  const requote = benchmarkFee({ gross_cents: 65_000n, appraiser_share_cents: 55_000n, amc_share_cents: 10_000n }, BENCH);
  assert.equal(requote.pass, true); assert.equal(requote.held_for_requote, false); assert.equal(requote.fee_item_current_amount_cents, 65_000n);
  const adjusted = benchmarkFee({ gross_cents: 55_000n, appraiser_share_cents: 45_000n, amc_share_cents: 10_000n, adjustment_reason: "turnaround" }, BENCH);
  assert.equal(adjusted.pass, true); assert.match(adjusted.reason, /§1026\.42\(f\)\(2\)/);
  assert.throws(() => benchmarkFee({ gross_cents: 55_000n, appraiser_share_cents: 45_000n, adjustment_reason: "low value" }, BENCH), RangeError);
  const viaTool = await h.run("benchmarkFee", { gross_cents: 55_000n, appraiser_share_cents: 45_000n, amc_share_cents: 10_000n, benchmark: { ...BENCH } });
  assert.equal(viaTool.pass, false); assert.equal(viaTool.held_for_requote, true); assert.equal(viaTool.tested_cents, "45000");
  await h.refused(h.run("benchmarkFee", { gross_cents: 55_000n, appraiser_share_cents: 55_000n, benchmark: { ...BENCH }, conditioned_on_value: true }), "AIR_1_2_FEE_CONDITIONED_ON_VALUE");
});

test("24.1-T9: Given an appraiser whose AZ license expires Oct 8, 2026 and an assignment attempt on Oct 9, then `SM_APPRAISER_LICENSE_GATE` blocks and the order is reassigned.", async () => {
  const lapsed: AppraiserFacts = { ...APPRAISER_AZ, party_id: "appr-az-2", license_number: "CRA-40001", license_expires_on: D("2026-10-08"), asc_registry_checked_on: D("2026-10-06") };
  const g = appraiserLicenseGate(lapsed, "AZ", D("2026-10-09"));
  assert.equal(g.open, false); assert.match(g.reason!, /expired 2026-10-08 \(assignment 2026-10-09\)/);
  assert.equal(appraiserLicenseGate(lapsed, "AZ", D("2026-10-08")).open, true, "still active on the expiry date");
  assert.equal(evaluateGate("24.1.appraiserLicenseGate", { ...lapsed, property_state: "AZ", on: "2026-10-09" }).open, false);
  assert.equal(evaluateGate("24.1.appraiserLicenseGate", { ...APPRAISER_AZ, property_state: "AZ", on: "2026-11-10" }).open, false, "ASC check older than 30 days blocks too");
  assert.equal(appraiserLicenseGate({ ...APPRAISER_AZ, license_state: "NV" }, "AZ", D("2026-10-09")).open, false, "license must be in the subject-property state");
  const h = harness(mst("2026-10-06", "09:15"));
  h.du("none", "2026-10-05", mst("2026-10-05", "16:30")); h.leReceived("2026-10-05", mst("2026-10-05", "17:42"));
  const placed = placedOrder(h, mst("2026-10-06", "09:15"));
  const r = assignAppraiser(h.events, placed.order, lapsed, mst("2026-10-09", "10:00"));
  assert.equal(r.reassigned, true); assert.equal(r.gate.open, false); assert.equal(r.order.reassigned_from_order_id, placed.order.order_id); assert.notEqual(r.order.order_id, placed.order.order_id); assert.equal(r.order.status, "ordered");
  assert.equal(r.event.type, "valuation.order.reassigned"); assert.equal(r.event.payload.reason, "SM_APPRAISER_LICENSE_GATE");
  assert.equal(h.ofType("valuation.assigned").length, 0); assert.equal(h.timer("SM_APPRAISER_LICENSE_GATE"), undefined, "no assignment, no gate instance");
  const ok = assignAppraiser(h.events, r.order, APPRAISER_AZ, mst("2026-10-09", "11:00"));
  assert.equal(ok.reassigned, false); assert.equal(h.timer("SM_APPRAISER_LICENSE_GATE")!.status, "satisfied");
  // through the bus: verifyAppraiserLicense with order_id assigns or reassigns and keeps both order versions
  h.rt.store.put("valuation_orders", placed.order.order_id, { ...placed.order }, AGENT, h.clock.now());
  const out = await h.run("verifyAppraiserLicense", { order_id: placed.order.order_id, appraiser: { ...lapsed }, assigned_at: mst("2026-10-09", "12:00") });
  assert.equal(out.open, false); assert.equal(out.reassigned, true); assert.equal(h.rt.store.require("valuation_orders", placed.order.order_id).data.status, "reassigned"); assert.equal(h.rt.store.require("valuation_orders", String(out.order_id)).data.reassigned_from_order_id, placed.order.order_id);
});

test("24.1-T10: Given an order placed Oct 20, 2026 whose first UCDP submission will occur Nov 3, 2026, when the vendor delivers a UAD 2.6 file, then receipt is rejected with reference FNM0391 and a re-engagement is issued.", () => {
  const h = harness(mst("2026-10-20", "09:15"));
  h.du("none", "2026-10-19", mst("2026-10-19", "16:30")); h.leReceived("2026-10-19", mst("2026-10-19", "17:42"));
  const intent = h.intent(mst("2026-10-20", "08:40"));
  const placed = placedOrder(h, mst("2026-10-20", "09:15"), { selection: selectMethod({ ...REFI_FACTS, ordered_on: D("2026-10-20") }), fee_gate: { le_effective_receipt_date: D("2026-10-19"), intent }, first_ucdp_submission_on: D("2026-11-03") });
  assert.equal(placed.order.uad_version, "3.6");
  const gate = h.timer("FNMA_UAD_3_6_REQUIRED_GATE")!;
  assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:24.1.uad36RequiredGate");
  assert.equal(evaluateGate("24.1.uad36RequiredGate", { uad_version: "3.6", first_ucdp_submission_on: "2026-11-03", deliverable_uad_version: "2.6" }).open, false);
  assert.match(evaluateGate("24.1.uad36RequiredGate", { uad_version: "2.6", first_ucdp_submission_on: "2026-11-03" }).reason!, /^FNMA_UAD_3_6_REQUIRED_GATE/);
  assert.equal(evaluateGate("24.1.uad36RequiredGate", { uad_version: "2.6", first_ucdp_submission_on: "2026-10-30" }).open, true, "before Nov 2, 2026 a 2.6 engagement is still accepted");
  const a = assignAppraiser(h.events, placed.order, { ...APPRAISER_AZ, asc_registry_checked_on: D("2026-10-19") }, mst("2026-10-21", "10:00"));
  const rejected = receiveReport(h.events, a.order, { report_document_id: "doc-uad26-1", uad_version: "2.6", effective_date: D("2026-10-24"), received_at: mst("2026-10-29", "14:00") }, h.ledger, AMC);
  assert.equal(rejected.accepted, false); assert.equal(rejected.reference, "FNM0391"); assert.equal(rejected.order.status, "assigned", "the order stays open for the re-engagement");
  assert.equal(rejected.event.type, "valuation.report.rejected"); assert.match(String(rejected.event.payload.detail), /submitted in UAD 2\.6 format and is not accepted\. As of November 2, 2026/);
  assert.equal(rejected.reengagement!.type, "valuation.engagement.reissued"); assert.equal(rejected.reengagement!.payload.reason, "FNM0391"); assert.equal(rejected.reengagement!.payload.uad_version, "3.6");
  assert.equal(h.ofType("valuation.received").length, 0); assert.equal(h.ledger.sets().length, 0); assert.equal(gate.status, "armed");
  const ok = receiveReport(h.events, a.order, { report_document_id: "doc-uad36-1", uad_version: "3.6", effective_date: D("2026-10-24"), received_at: mst("2026-10-30", "14:00") }, h.ledger, AMC);
  assert.equal(ok.accepted, true); assert.equal(gate.status, "satisfied", "valuation.received{uad_version=3.6} closes the UAD gate");
});

test("24.1-T11: Given a DU resubmission that loses the VA offer on Nov 6, 2026 for the purchase fixture, then `valuation.offer.lost` fires, R1 selects `hybrid`, and the order is placed the same business day.", async () => {
  const h = harness(et("2026-10-19", "09:30"), PURCH);
  h.du("value_acceptance_pd", "2026-10-19", et("2026-10-19", "11:00"), 1, ["DU offers hybrid appraisals"]); h.leReceived("2026-10-19", et("2026-10-19", "17:00"));
  const intent = h.intent(et("2026-10-20", "09:30"));
  const pdc = orderPdc(h.events, PURCH.app, { vendor_party_id: "pdc-vendor-1", collector_party_id: "collector-7", collector_background_check_on: D("2026-03-03"), collector_training_evidence_id: "doc-training-7", pdcir_attestation_id: "doc-pdcir-7" }, et("2026-10-20", "10:05"), { legally_engaged: false, check: null, evidence_id: intent.intent_id, tolerance_class: "not_a_consumer_charge" });
  const collected = recordPdcCollection(h.events, pdc.pdc, { collected_at: et("2026-10-23", "15:00"), upd_version: "UPD-1.1", floor_plan_document_id: "doc-floorplan-1", image_document_ids: ["img-1"], safety_issue_flag: false, interior_observed: true, exterior_observed: true, ansi_floor_plan: true });
  const accepted = submitPropertyData(h.events, collected.pdc, h.pd, et("2026-10-26", "09:00"));
  h.rt.store.put("property_data_collections", accepted.pdc.pdc_id, { ...accepted.pdc }, AGENT, h.clock.now());
  // DU #2 Fri Nov 6: loan amount +$500 within tolerance but occupancy → second home; the offer is gone
  h.at(et("2026-11-06", "09:40")); h.du("none", "2026-11-06", et("2026-11-06", "09:40"), 2, ["DU offers hybrid appraisals"]);
  assert.equal(detectOfferLoss(h.events, PURCH.app, et("2026-11-06", "09:41")) !== null, true);
  const lost = h.ofType("valuation.offer.lost");
  assert.equal(lost.length, 1); assert.equal(lost[0]!.payload.prior_offer_type, "value_acceptance_pd"); assert.equal(lost[0]!.payload.du_submission_id, "du-app-purch-1-2"); assert.equal(lost[0]!.payload.lost_on, "2026-11-06");
  assert.equal(detectOfferLoss(h.events, PURCH.app, et("2026-11-06", "09:42")), null, "idempotent per findings event");
  const sel = selectMethod({ ...PURCH_FACTS, offer_type: "none", occupancy: "second_home", pdc_on_file: true, ordered_on: D("2026-11-06") });
  assert.equal(sel.method, "hybrid"); assert.equal(sel.form_code, "1004_hybrid");
  assert.deepEqual(sel.exclusions.map((e) => `${e.method}:${e.reason}`), ["value_acceptance:no DU value acceptance offer", "value_acceptance_pd:no DU value acceptance + property data offer"], "hybrid is reached before desktop/traditional are considered");
  assert.ok(exclusionsFor("desktop", { ...PURCH_FACTS, offer_type: "none", occupancy: "second_home" }).some((e) => e.reason === "not a principal residence"));
  const selectedAt = et("2026-11-06", "09:45");
  recordMethodSelection(h.events, PURCH.app, sel, selectedAt, { offer_type: "none", du_submission_id: "du-app-purch-1-2", pdc_id: accepted.pdc.pdc_id, time_zone: PURCH.tz });
  const sla = h.timer("SM_VALUATION_ORDER_SLA_1BD")!;
  assert.equal(sla.anchorDate, "2026-11-06"); assert.equal(sla.dueDate, "2026-11-09", "Fri Nov 6 + 1 creditor business day = Mon Nov 9");
  const orderedAt = et("2026-11-06", "11:20");
  const placed = placedOrder(h, orderedAt, { selection: sel, offer: readDuOffer(h.events, PURCH.app), fee_gate: { le_effective_receipt_date: D("2026-10-19"), intent }, pdc_id: accepted.pdc.pdc_id, order_payload: { ...PAYLOAD, address: "88 Neil Ave, Columbus OH 43215", transaction_type: "purchase", occupancy: "second_home", scope: "hybrid", form_code: "1004_hybrid", pdc_id: accepted.pdc.pdc_id, pdc_document_id: "doc-floorplan-1" } });
  assert.equal(sla.status, "satisfied"); assert.equal(sameBusinessDay(selectedAt, orderedAt, creditor, PURCH.tz), true);
  assert.equal(placed.order.method, "hybrid"); assert.equal(placed.order.pdc_id, accepted.pdc.pdc_id, "the PDC is shared with the appraiser at engagement (B4-1.2-03)");
  assert.equal(h.timer("SM_VALUATION_REPORT_SLA_10CD")!.dueDate, "2026-11-16", "report by Mon Nov 16 (10 calendar days)");
  // the same run through the bus: selectMethod detects the loss first, then selects hybrid
  const h2 = harness(et("2026-10-19", "09:30"), PURCH);
  h2.du("value_acceptance_pd", "2026-10-19", et("2026-10-19", "11:00"), 1, ["DU offers hybrid appraisals"]); h2.at(et("2026-11-06", "09:40")); h2.du("none", "2026-11-06", et("2026-11-06", "09:40"), 2, ["DU offers hybrid appraisals"]);
  const out = await h2.run("selectMethod", { transaction_type: "purchase", occupancy: "second_home", units: 1, property_type: "sfr", ltv_bps: 9000, pdc_on_file: true, at: et("2026-11-06", "09:45") });
  assert.equal(out.offer_lost, true); assert.equal(out.method, "hybrid"); assert.equal(h2.ofType("valuation.offer.lost").length, 1);
});

test("24.1-T12: Given a report transferred from another lender dated Sept 20, 2026 with an AIR attestation, then the platform accepts it into 24.2 review, marks `transferred_from_lender`, and requires a UCDP resubmission under the partner.", async () => {
  const h = harness(mst("2026-10-06", "09:15"));
  const r = acceptTransferredReport(h.events, { application_id: REFI.app, report_document_id: "doc-transfer-1", effective_date: D("2026-09-20"), note_date: D("2026-11-06"), air_attestation_document_id: "doc-air-attest-1", original_lender_client_name: "Other Lender, LLC", uad_version: "3.6", received_at: mst("2026-10-06", "09:15"), property_state: "AZ" });
  assert.equal(r.order.transferred_from_lender, true); assert.equal(r.order.transfer_air_attestation_document_id, "doc-air-attest-1"); assert.equal(r.order.status, "report_received"); assert.equal(r.review_process, "24.2"); assert.equal(r.ucdp_resubmission_required, true);
  assert.equal(r.order.effective_date, "2026-09-20"); assert.equal(r.order.age_12m_expires_on, "2027-09-20"); assert.equal(r.order.age_4m_update_after, "2027-01-20");
  assert.equal(r.event.type, "valuation.received"); assert.equal(r.event.payload.transferred_from_lender, true); assert.equal(r.event.payload.ucdp_resubmission_required, true); assert.equal(r.event.payload.original_lender_client_name, "Other Lender, LLC", "stored as-is; no re-addressing"); assert.equal(r.event.payload.opens, "24.2");
  assert.equal(h.timer("FNMA_B4_1_2_04_APPRAISAL_12M")!.anchorDate, "2026-09-20"); assert.equal(h.timer("SM_VALUATION_REPORT_SLA_10CD"), undefined, "no order of ours to track");
  assert.throws(() => acceptTransferredReport(h.events, { application_id: REFI.app, report_document_id: "doc-transfer-2", effective_date: D("2026-09-20"), note_date: D("2026-11-06"), air_attestation_document_id: null, original_lender_client_name: "Other Lender, LLC", uad_version: "3.6", received_at: mst("2026-10-06", "09:16"), property_state: "AZ" }), (e: unknown) => e instanceof ValuationRefused && e.code === "AIR_6_ATTESTATION");
  assert.throws(() => acceptTransferredReport(h.events, { application_id: REFI.app, report_document_id: "doc-transfer-3", effective_date: D("2025-10-20"), note_date: D("2026-11-06"), air_attestation_document_id: "doc-air-attest-1", original_lender_client_name: "Other Lender, LLC", uad_version: "3.6", received_at: mst("2026-10-06", "09:16"), property_state: "AZ" }), (e: unknown) => e instanceof ValuationRefused && e.code === "FNMA_B4_1_2_04_APPRAISAL_12M");
  const out = await h.run("trackOrder", { op: "transfer_in", report_document_id: "doc-transfer-4", effective_date: "2026-09-20", note_date: "2026-11-06", air_attestation_document_id: "doc-air-attest-1", original_lender_client_name: "Other Lender, LLC", uad_version: "3.6", property_state: "AZ" });
  assert.equal(out.transferred_from_lender, true); assert.equal(out.ucdp_resubmission_required, true); assert.equal(out.review_process, "24.2");
  assert.equal(h.rt.store.require("valuation_orders", String(out.order_id)).data.transferred_from_lender, true);
  await h.refused(h.run("trackOrder", { op: "receive", order_id: String(out.order_id), report_document_id: "doc-x", uad_version: "3.6", effective_date: "2026-09-20", delivered_by: "borrower" }), "FNMA_B4_1_1_03_INTERESTED_PARTY");
});

test("24.1 worked figures: R3 benchmark median 60,000 / p25 52,500 / p75 70,000 cents, AMC quote 65,000 = 55,000 appraiser + 10,000 AMC → pass, fee_items.appraisal_fee.current_amount_cents = 65,000 posted to third_party_costs on valuation.received; CD \"Appraisal Fee $650.00\" Paid by Others; R4 SLA dates Oct 7 / Oct 8 / Oct 14 / Oct 16, age dates 2027-02-10 / 2027-10-10; R6 offer Oct 19 → Feb 19, 2027 and Oct 31 → Feb 28, 2027", () => {
  const t = benchmarkFee({ gross_cents: 65_000n, appraiser_share_cents: 55_000n, amc_share_cents: 10_000n }, BENCH);
  assert.equal(t.pass, true); assert.equal(t.tested_cents, 55_000n); assert.equal(BENCH.median_fee_cents, 60_000n); assert.equal(t.p25_fee_cents, 52_500n); assert.equal(t.p75_fee_cents, 70_000n); assert.equal(t.fee_item_current_amount_cents, 65_000n);
  const h = harness(mst("2026-10-05", "09:10"));
  h.du("none", "2026-10-05", mst("2026-10-05", "16:30")); h.leReceived("2026-10-05", mst("2026-10-05", "17:42"));
  const placed = placedOrder(h, mst("2026-10-06", "09:15"));
  assert.equal(placed.fee_gate.tolerance_class, "not_a_consumer_charge", "paid_by = sm: not a consumer charge");
  const a = assignAppraiser(h.events, placed.order, APPRAISER_AZ, mst("2026-10-07", "10:00"));
  const done = completeInspection(h.events, a.order, mst("2026-10-10", "11:00"));
  const r = receiveReport(h.events, done.order, { report_document_id: "doc-urar-1", uad_version: "3.6", effective_date: D("2026-10-10"), received_at: mst("2026-10-15", "14:20"), fee_invoice_cents: 65_000n }, h.ledger, AMC);
  const set = r.ledger_set!;
  const debit = set.lines.find((l) => String(l.account.account) === "third_party_costs")!, credit = set.lines.find((l) => String(l.account.account) === "accounts_payable_vendor")!;
  assert.equal(debit.amountCents, 65_000n); assert.equal(credit.amountCents, -65_000n); assert.equal(set.lines.reduce((s, l) => s + l.amountCents, 0n), 0n); assert.ok(set.lines.every((l) => l.ruleRef.startsWith("24.1")));
  assert.equal(`Appraisal Fee ${formatCents(debit.amountCents)}`, "Appraisal Fee $650.00");
  assert.equal(h.timer("SM_VALUATION_ASSIGN_SLA_2BD")!.dueDate, "2026-10-08"); assert.equal(h.timer("SM_VALUATION_INSPECT_SLA_7CD")!.dueDate, "2026-10-14"); assert.equal(h.timer("SM_VALUATION_REPORT_SLA_10CD")!.dueDate, "2026-10-16");
  assert.equal(addBusinessDays(D("2026-10-06"), 1, creditor), "2026-10-07");
  assert.deepEqual(appraisalAgeDates(D("2026-10-10")), { age_4m_update_after: D("2027-02-10"), age_12m_expires_on: D("2027-10-10") });
  assert.equal(offerExpiresOn(D("2026-10-19")), "2027-02-19"); assert.equal(offerExpiresOn(D("2026-10-31")), "2027-02-28"); assert.equal(addMonths(D("2026-10-31"), 4), "2027-02-28");
});
