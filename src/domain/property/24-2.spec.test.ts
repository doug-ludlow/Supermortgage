// 24.2 Appraisal receipt, UCDP/Collateral Underwriter review, reconsideration of value, appraisal quality/bias controls, Reg B delivery, and HPML appraisal rules
// spec/sections/24-property-valuation-eligibility-title-hazard-flood-insurance/24-2-appraisal-receipt-ucdp-collateral-underwriter-review-reconsi.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_24_2 } from "../../app/tools/section24-2.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import type { Recipient } from "../../notices/channel.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeUcdp, NO_CU_FLAGS, copyPlan, earliestConsummation, providedOn, regBCopyGate, waiverDecision, screenRov, rovTurnTimeDue, scanLanguage, flipTest, hpmlAppraisalRulesApply, hpmlCopyDueOn, hpmlAppraisalCopyGate, secondAppraisalPlan, notConsummatedCopyDue, valueUsed, ltv, rwReliefPropertyValue, cuReviewTier, ucdpSubmitDue, reviewDue, routeUcdpResult, completionAt, rovClosingGate,
  type UcdpFinding, type RovRequestInput, type ValuationRow } from "./ops-24-2.ts";

const AGENT: Actor = { kind: "agent", id: "valuation" };
const SME: Actor = { kind: "human", id: "u-uw-reviewer", role: "underwriting_reviewer" };
const REFI = "APP-REFI-560K", PURCHASE = "APP-PURCH-412K";
const APPRAISAL = "APR-REFI-1", APPRAISER = "PARTY-APPRAISER-1", PARTNER = "PARTY-PARTNER";
/** MST wall-clock instants of the refinance fixture (America/Phoenix, UTC−7). */
const MST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-07:00`).toISOString();
const PACKAGE = { uad_version: "3.6" as const, has_xml: true, has_pdf: true, has_images: true, lender_client_party_id: PARTNER, partner_party_id: PARTNER, appraiser_party_id: APPRAISER, ordered_appraiser_party_id: APPRAISER, appraiser_license_active: true, ordered_form: "1004" as const, form: "1004" as const };
const CHECKLIST = { closed_comparables: 3, adjustments_explained: true, market_conditions_consistent: true, gla_sqft: 2140, application_gla_sqft: 2140, units: 1, application_units: 1, condition_rating: "C3", quality_rating: "Q3", subject_to: false, narrative: "The subject is a well-maintained single-family residence in an established subdivision; sales activity is stable." };
const consent = (party_id: string) => ({ party_id, classes: ["disclosures.origination"], disclosure_version: "1.3", status: "active" as const, consented_on: D("2026-10-02"), soft_bounces_30d: 0 });
const RECIPIENTS: Recipient[] = [{ partyId: "B1", name: "Alex Fixture", mailingAddress: "4120 N 44th St, Phoenix AZ 85018", email: "alex@example.com", consent: consent("B1") }];
const COPY_PAYLOAD = (completion_at: string, earliest: string, extra: Record<string, unknown> = {}) => ({ partner_name: "Partner Bank, N.A.", borrower_names: ["Alex Fixture"], property_address: "4120 N 44th St, Phoenix AZ 85018", loan_number_last4: "0917", mlo_name: "Jordan Originator", mlo_nmlsr_id: "1234567", contact_phone: "1-800-555-0142", notice_date: completion_at.slice(0, 10), completion_at: completion_at.slice(0, 10), earliest_consummation: earliest, consummation_scheduled_on: "2026-11-06", revision: false, includes_rov_disclosure: true, valuation_count: 1, valuations: [{ kind_label: "Uniform Residential Appraisal Report (Form 1004, UAD 3.6)", developed_at: "2026-10-14", version_no: 1 }], ...extra });

function harness(applicationId: string, nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["24.2"] });
  const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const escalations = new EscalationService(events, clock);
  const reg = buildRegistry(); publishAuthored(reg);
  const notices = new NoticeService({ registry: reg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const ucdp = new FakeUcdp();
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: { ucdp }, ports: {}, notices };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_24_2); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("24.2", name))!, actor, { application_id: applicationId, ...input }, uow)).output as Record<string, unknown>;
  const timer = (code: string) => timers.byCode(code).at(-1);
  const evts = (type: string) => events.all().filter((e) => e.type === type);
  /** The refinance fixture's v1 path through Fri Oct 16 acceptance (R5): received Thu Oct 15 14:20, DI 15:05, SSRs 15:07 (CU 1.9), review Fri Oct 16 10:30. */
  const acceptV1 = async (o: { cu_score?: number; consummation_on?: string } = {}) => {
    clock.set(MST("2026-10-15", "14:20"));
    // 24.1's receipt event (ops-24-1.ts emits it; appended here as the seam) — arms SM_UCDP_SUBMIT_SLA_1BD
    events.append({ type: "valuation.received", applicationId, actor: AGENT, payload: { application_id: applicationId, valuation_order_id: "VO-REFI-1", appraisal_id: APPRAISAL, assignment_type: "traditional", received_at: MST("2026-10-15", "14:20"), source: "origination" } });
    await run("ingestReport", { appraisal_id: APPRAISAL, version_no: 1, package: PACKAGE, appraised_value_cents: 80_000_000n, effective_date: "2026-10-14", appraiser_party_id: APPRAISER, received_at: MST("2026-10-15", "14:20") });
    clock.set(MST("2026-10-15", "15:05"));
    await run("submitUcdp", { appraisal_id: APPRAISAL, version_no: 1, package_hash: "sha256:v1" });
    ucdp.script(APPRAISAL, 1, "fnma", { status: "successful", findings: [], cu_score: o.cu_score ?? 1.9, cu_flags: NO_CU_FLAGS, result_at: MST("2026-10-15", "15:07") });
    ucdp.script(APPRAISAL, 1, "fhlmc", { status: "successful", findings: [], cu_score: null, cu_flags: NO_CU_FLAGS, result_at: MST("2026-10-15", "15:07") });
    clock.set(MST("2026-10-15", "15:07"));
    await run("pollFindings", { appraisal_id: APPRAISAL, version_no: 1 });
    clock.set(MST("2026-10-16", "10:30"));
    return run("applyReviewChecklist", { appraisal_id: APPRAISAL, version_no: 1, checklist: CHECKLIST, transaction_type: "refinance", loan_amount_cents: 56_000_000n, consummation_on: o.consummation_on ?? "2026-11-06" });
  };
  return { clock, events, timers, uow, escalations, rt, ucdp, run, timer, evts, decisions, acceptV1 };
}

test("24.2-T1: Given v1 received Thu Oct 15, 2026 14:20 and UCDP Successful both GSEs 15:07 with CU 1.9, when review completes Fri Oct 16 10:30, then `completion_at = 2026-10-16`, `rw_relief_property_value = true`, and the copy package is due by Fri Oct 23 and by Tue Nov 3 (`copy_required_by = Oct 23`).", async () => {
  const h = harness(REFI, MST("2026-10-15", "14:20"));
  const r = await h.acceptV1();
  // SM_UCDP_SUBMIT_SLA_1BD: received Thu Oct 15 → due Fri Oct 16; satisfied by `valuation.ucdp.submitted{both_gses=true}` at 15:05
  const sub = h.timer("SM_UCDP_SUBMIT_SLA_1BD")!; assert.equal(sub.dueDate, "2026-10-16"); assert.equal(sub.status, "satisfied");
  assert.equal(ucdpSubmitDue(D("2026-10-15")), "2026-10-16");
  assert.deepEqual(h.evts("valuation.ucdp.submitted").map((e) => e.payload.both_gses), [true]);
  assert.equal(h.evts("valuation.ucdp.submitted")[0]!.payload.doc_file_id, "1200000123456");
  // SM_APPRAISAL_REVIEW_SLA_2BD: SSR Thu Oct 15 15:07 + 2 business_days_creditor = Mon Oct 19 (the spec's "due Tue Oct 20" counts one day too many); satisfied Fri Oct 16
  const rev = h.timer("SM_APPRAISAL_REVIEW_SLA_2BD")!; assert.equal(rev.dueDate, "2026-10-19"); assert.equal(rev.status, "satisfied");
  assert.equal(reviewDue(D("2026-10-15")), "2026-10-19");
  assert.equal(r.review_status, "accepted");
  assert.equal(String(r.completion_at).slice(0, 10), "2026-10-16");
  assert.equal(completionAt(MST("2026-10-15", "14:20"), MST("2026-10-16", "10:30")), MST("2026-10-16", "10:30"));
  assert.equal(r.rw_relief_property_value, true);
  assert.equal(rwReliefPropertyValue({ cu_score: 1.9, ucdp_status: "successful", form: "1004" }), true);
  assert.deepEqual(cuReviewTier(1.9, NO_CU_FLAGS), { tier: "standard", enhanced_review_required: false, flagged: [] });
  assert.deepEqual(r.value_used, { value_used_cents: 80_000_000n, value_basis: "appraised" });
  assert.deepEqual(r.ltv, { ratio: 0.7, pct_display: "70.00%" });
  const plan = r.copy_plan as ReturnType<typeof copyPlan>;
  assert.equal(plan.copy_due_prompt, "2026-10-23"); assert.equal(plan.copy_due_gate, "2026-11-03"); assert.equal(plan.copy_required_by, "2026-10-23");
  assert.deepEqual(copyPlan({ completion_at: MST("2026-10-16", "10:30"), consummation_on: D("2026-11-06") }), { completion_on: "2026-10-16", copy_due_prompt: "2026-10-23", copy_due_gate: "2026-11-03", copy_required_by: "2026-10-23", earliest_consummation_if_copied_today: "2026-10-21" });
  // REGB_1002_14_APPRAISAL_COPY_PROMPT_7 arms on the accepted review (completion) with the +7 calendar-day due date
  const prompt = h.timer("REGB_1002_14_APPRAISAL_COPY_PROMPT_7")!; assert.equal(prompt.dueDate, "2026-10-23"); assert.equal(prompt.status, "armed");
  assert.equal(h.rt.store.get("appraisals", `${APPRAISAL}:v1`)!.data.is_final_version, true);
  assert.equal(h.rt.store.get("appraisals", `${APPRAISAL}:v1`)!.data.copy_required_by, "2026-10-23");
  // the package e-delivered Fri Oct 16 10:45 (portal view 11:02) satisfies the prompt timer with `valuation.copy.delivered{version=1}`
  h.clock.set(MST("2026-10-16", "10:45"));
  const d = await h.run("deliverNotice", { template_code: "NTC_REGB_1002_14_VALUATION_COPY", payload: COPY_PAYLOAD(MST("2026-10-16", "10:30"), "2026-10-21"), recipients: RECIPIENTS, appraisal_id: APPRAISAL, version: 1, is_final_version: true, channel: "electronic", esign_consent_verified: true, receipt_evidence: "esign_confirmed", consummation_on: "2026-11-06", valuation_ids: [`VAL-${APPRAISAL}-v1`] });
  assert.equal(d.status, "sent"); assert.equal(d.earliest_consummation, "2026-10-21"); assert.equal(d.gate_open_for_scheduled, true); assert.equal(d.charge_cents, 0n);
  assert.equal(h.timer("REGB_1002_14_APPRAISAL_COPY_PROMPT_7")!.status, "satisfied");
  assert.equal(h.evts("valuation.copy.delivered")[0]!.payload.version, 1);
  assert.equal(h.rt.store.get("valuations", `VAL-${APPRAISAL}-v1`)!.data.delivered_at, MST("2026-10-16", "10:45"));
});

test("24.2-T2: Given consummation Fri Nov 6, 2026 and the latest version copy e-delivered Tue Nov 3 at 17:59 MST, then `REGB_1002_14_APPRAISAL_COPY_3BD_GATE` is open; delivered Wed Nov 4 08:00 → gate closed and the proposed earliest consummation is Mon Nov 9.", async () => {
  // copy day D → earliest consummation = D + 3 business_days_creditor (Nov 3 → Nov 4, 5, 6; Nov 4 → Nov 5, 6, 9)
  assert.equal(earliestConsummation(D("2026-11-03")), "2026-11-06");
  assert.equal(earliestConsummation(D("2026-11-04")), "2026-11-09");
  const open = regBCopyGate({ consummation_on: D("2026-11-06"), latest_version_provided_on: providedOn({ copied_on: D("2026-11-03"), channel: "electronic" }) });
  assert.equal(open.open, true); assert.equal(open.earliest_consummation, "2026-11-06"); assert.equal(open.proposed_consummation_on, null);
  const closed = regBCopyGate({ consummation_on: D("2026-11-06"), latest_version_provided_on: D("2026-11-04") });
  assert.equal(closed.open, false); assert.deepEqual(closed.blocking_codes, ["REGB_COPY_LT_3BD"]); assert.equal(closed.proposed_consummation_on, "2026-11-09"); assert.match(closed.reason!, /earliest consummation 2026-11-09/);
  assert.equal(evaluateGate("24.2.regbCopy3bdGate", { consummation_date: "2026-11-06", latest_version_provided_on: "2026-11-03" }).open, true);
  const g = evaluateGate("24.2.regbCopy3bdGate", { consummation_date: "2026-11-06", latest_version_provided_on: "2026-11-04" }); assert.equal(g.open, false); assert.match(g.reason!, /2026-11-09/);
  // mailed copies: provided three business days after mailing or on evidenced receipt, whichever earlier (comment 14(a)(1)-4)
  assert.equal(providedOn({ copied_on: D("2026-10-29"), channel: "mail" }), "2026-11-03");
  assert.equal(providedOn({ copied_on: D("2026-10-29"), channel: "mail", actual_receipt_on: D("2026-10-31") }), "2026-10-31");
  // through the bus: the revised-report branch (R6-B) — v2 accepted and e-delivered Wed Nov 4 08:00 fails the Nov 6 gate
  const h = harness(REFI, MST("2026-10-15", "14:20"));
  await h.acceptV1();
  h.events.append({ type: "closing.scheduled", applicationId: REFI, actor: AGENT, payload: { application_id: REFI, consummation_at: "2026-11-06", source: "origination" } });
  assert.equal(h.timer("REGB_1002_14_APPRAISAL_COPY_3BD_GATE")!.status, "armed");
  h.clock.set(MST("2026-11-03", "17:59"));
  const early = await h.run("deliverNotice", { template_code: "NTC_REGB_1002_14_VALUATION_COPY", payload: COPY_PAYLOAD(MST("2026-10-16", "10:30"), "2026-11-06", { notice_date: "2026-11-03" }), recipients: RECIPIENTS, appraisal_id: APPRAISAL, version: 1, is_final_version: true, channel: "electronic", esign_consent_verified: true, consummation_on: "2026-11-06" });
  assert.equal(early.provided_on, "2026-11-03"); assert.equal(early.earliest_consummation, "2026-11-06"); assert.equal(early.gate_open_for_scheduled, true);
  assert.equal(h.timer("REGB_1002_14_APPRAISAL_COPY_3BD_GATE")!.status, "satisfied");
  h.clock.set(MST("2026-11-04", "08:00"));
  const late = await h.run("deliverNotice", { template_code: "NTC_REGB_1002_14_VALUATION_COPY", payload: COPY_PAYLOAD(MST("2026-11-04", "08:00"), "2026-11-09", { notice_date: "2026-11-04", revision: true }), recipients: RECIPIENTS, appraisal_id: APPRAISAL, version: 2, is_final_version: true, channel: "electronic", esign_consent_verified: true, consummation_on: "2026-11-06" });
  assert.equal(late.earliest_consummation, "2026-11-09"); assert.equal(late.gate_open_for_scheduled, false);
});

test("24.2-T3: Given a borrower waiver statement recorded Wed Nov 4 for a Nov 6 consummation, then `REGB_1002_14_WAIVER_3BD_GATE` rejects it; recorded Tue Nov 3 → accepted, and copies must still be delivered at or before consummation.", async () => {
  const refused = waiverDecision({ obtained_on: D("2026-11-04"), consummation_on: D("2026-11-06") });
  assert.equal(refused.accepted, false); assert.equal(refused.latest_obtained_on, "2026-11-03"); assert.match(refused.reason, /REGB_1002_14_WAIVER_3BD_GATE/);
  const accepted = waiverDecision({ obtained_on: D("2026-11-03"), consummation_on: D("2026-11-06") });
  assert.equal(accepted.accepted, true); assert.equal(accepted.copies_due_at_or_before, "2026-11-06");
  assert.equal(evaluateGate("24.2.waiver3bdGate", { consummation_date: "2026-11-06", waiver_obtained_on: "2026-11-04" }).open, false);
  assert.equal(evaluateGate("24.2.waiver3bdGate", { consummation_date: "2026-11-06", waiver_obtained_on: "2026-11-03" }).open, true);
  // with a valid waiver the copy gate still needs the copy at or before consummation (§1002.14(a)(1))
  assert.equal(regBCopyGate({ consummation_on: D("2026-11-06"), latest_version_provided_on: null, waiver_obtained_on: D("2026-11-03") }).open, false);
  assert.equal(regBCopyGate({ consummation_on: D("2026-11-06"), latest_version_provided_on: D("2026-11-06"), waiver_obtained_on: D("2026-11-03") }).open, true);
  assert.equal(regBCopyGate({ consummation_on: D("2026-11-06"), latest_version_provided_on: D("2026-11-05"), waiver_obtained_on: D("2026-11-04") }).open, false);   // late waiver: the 3-day gate governs
  const h = harness(REFI, MST("2026-11-04", "09:00"));
  const rej = await h.run("recordWaiver", { appraisal_id: APPRAISAL, statement_channel: "oral_recorded", obtained_at: MST("2026-11-04", "09:00"), consummation_on: "2026-11-06" });
  assert.equal(rej.accepted, false); assert.equal(rej.latest_obtained_on, "2026-11-03"); assert.equal(h.evts("valuation.copy.waived").length, 0);
  assert.equal(h.timer("REGB_1002_14_WAIVER_3BD_GATE")!.status, "armed");   // armed by the statement, never satisfied
  h.clock.set(MST("2026-11-03", "16:00"));
  const ok = await h.run("recordWaiver", { appraisal_id: APPRAISAL, statement_channel: "written", obtained_at: MST("2026-11-03", "16:00"), consummation_on: "2026-11-06" });
  assert.equal(ok.accepted, true); assert.equal(ok.copies_due_at_or_before, "2026-11-06");
  assert.equal(h.rt.store.get("consents", String(ok.consent_id))!.data.kind, "regb_1002_14_timing_waiver");
  assert.equal(h.evts("valuation.copy.waived")[0]!.payload.copies_due_at_or_before, "2026-11-06");
  assert.equal(h.timer("REGB_1002_14_WAIVER_3BD_GATE")!.status, "satisfied");
  // guardrail: never waive the 3-day timing without a dated borrower statement
  await assert.rejects(h.run("recordWaiver", { appraisal_id: APPRAISAL, consummation_on: "2026-11-06" }), (e: unknown) => e instanceof CommandRefused && e.code === "WAIVER_NEEDS_DATED_STATEMENT");
});

const ROV: RovRequestInput = { rov_id: "ROV-1", appraisal_id: APPRAISAL, application_id: REFI, requested_by: "borrower", requested_at: MST("2026-10-20", "09:15"), borrower_names: ["Alex Fixture"], property_address: "4120 N 44th St, Phoenix AZ 85018", appraisal_effective_date: D("2026-10-14"), appraiser_name: "Pat Appraiser", disputed_areas: ["GLA adjustment of $40/sq ft is not market-supported"],
  comparables: [{ address: "4201 N 42nd Pl", sale_price_cents: 82_500_000n, sale_date: D("2026-08-14"), source: "ARMLS #6712345" }, { address: "3915 E Campbell Ave", sale_price_cents: 81_000_000n, sale_date: D("2026-07-30"), source: "ARMLS #6709981" }, { address: "4444 N 40th St", sale_price_cents: 83_900_000n, sale_date: D("2026-09-02"), source: "ARMLS #6720102" }] };

test("24.2-T4: Given an ROV received Tue Oct 20 with three sourced comparables, then screening completes by Thu Oct 22, the SME escalation is created, and after forwarding on Oct 21 the appraiser response is due Wed Oct 28.", async () => {
  const s = screenRov({ request: ROV, prior_borrower_rovs_for_appraisal: 0, consummated: false });
  assert.equal(s.screen_result, "complete"); assert.equal(s.screen_due_on, "2026-10-22"); assert.equal(s.sme_required, true);
  assert.equal(rovTurnTimeDue(D("2026-10-21")), "2026-10-28");   // Oct 22, 23, 26, 27, 28
  const h = harness(REFI, MST("2026-10-20", "09:15"));
  const r = await h.run("screenRov", { request: ROV });
  assert.equal(r.screen_result, "complete"); assert.equal(r.screen_due_on, "2026-10-22");
  const esc = h.escalations.opened.find((e) => e.id === r.sme_escalation_id)!;
  assert.equal(esc.kind, "underwriting_reviewer"); assert.equal(esc.ownerRole, "underwriting_reviewer"); assert.equal(esc.applicationId, REFI); assert.equal(esc.payload.rov_id, "ROV-1");
  const screen = h.timer("SM_ROV_SCREEN_SLA_2BD")!; assert.equal(screen.dueDate, "2026-10-22"); assert.equal(screen.status, "satisfied");
  h.clock.set(MST("2026-10-21", "15:00"));
  const f = await h.run("forwardRov", { rov_id: "ROV-1", sme_decision: "forward", sme_reviewer: "u-uw-reviewer", rationale: "three ARMLS-sourced sales; GLA adjustment dispute is specific" }, SME);
  assert.equal(f.forwarded, true); assert.equal(f.turn_time_due_at, "2026-10-28"); assert.equal(f.appraiser_contacted, true);
  assert.match(String(f.text), /turn-time expectation of five business days \(due 2026-10-28\)/); assert.doesNotMatch(String(f.text), /\$8[0-9]{2},[0-9]{3}/);
  const tt = h.timer("FNMA_B4_1_3_12_ROV_TURNTIME_5BD")!; assert.equal(tt.dueDate, "2026-10-28"); assert.equal(tt.status, "armed");
  assert.equal(h.rt.store.get("rov_requests", "ROV-1")!.data.status, "awaiting_appraiser");
  // Branch A: revised report (value unchanged) Mon Oct 26 → response received, rov.closed{no_change}, outcome retained
  h.clock.set(MST("2026-10-26", "11:00"));
  const c = await h.run("closeRov", { rov_id: "ROV-1", appraisal_id: APPRAISAL, original_value_cents: 80_000_000n, revised_value_cents: 80_000_000n, revised_appraisal_id: `${APPRAISAL}:v2`, outcome_document_id: "DOC-ROV-1-OUTCOME" });
  assert.equal(c.outcome, "no_change"); assert.equal(c.retained_in_loan_file, true);
  assert.equal(h.timer("FNMA_B4_1_3_12_ROV_TURNTIME_5BD")!.status, "satisfied");
  assert.equal(h.evts("rov.closed")[0]!.payload.outcome, "no_change");
});

test("24.2-T5: Given a second borrower ROV on the same appraisal, or an ROV submitted after `closing.consummated`, then the request is rejected with the stated reason and no appraiser contact occurs.", async () => {
  const dup = screenRov({ request: { ...ROV, rov_id: "ROV-2" }, prior_borrower_rovs_for_appraisal: 1, consummated: false });
  assert.equal(dup.screen_result, "duplicate_rejected"); assert.equal(dup.appraiser_contact_allowed, false); assert.match(dup.rejection_reason!, /only one is permitted per appraisal/);
  const post = screenRov({ request: { ...ROV, rov_id: "ROV-3" }, prior_borrower_rovs_for_appraisal: 0, consummated: true });
  assert.equal(post.screen_result, "post_closing_rejected"); assert.match(post.rejection_reason!, /The loan has closed/);
  assert.equal(rovClosingGate({ consummated: true, requested_by: "borrower" }).open, false);
  assert.equal(rovClosingGate({ consummated: true, requested_by: "lender" }).open, true);   // a lender-initiated ROV remains possible
  assert.equal(evaluateGate("24.2.rovClosingGate", { consummated: true, requested_by: "borrower" }).open, false);
  const h = harness(REFI, MST("2026-10-20", "09:15"));
  await h.run("screenRov", { request: ROV });
  const second = await h.run("screenRov", { request: { ...ROV, rov_id: "ROV-2", requested_at: MST("2026-10-27", "10:00") } });
  assert.equal(second.screen_result, "duplicate_rejected"); assert.equal(second.sme_escalation_id, null); assert.equal(second.appraiser_contacted, false);
  await assert.rejects(h.run("forwardRov", { rov_id: "ROV-2", sme_decision: "forward", sme_reviewer: "u-uw-reviewer" }, SME), /screen_result is duplicate_rejected/);
  h.events.append({ type: "closing.consummated", applicationId: REFI, actor: AGENT, payload: { application_id: REFI, consummation_at: "2026-11-06", source: "origination" } });
  assert.equal(h.timer("FNMA_B4_1_3_12_ROV_CLOSING_GATE")!.status, "armed");
  const third = await h.run("screenRov", { request: { ...ROV, rov_id: "ROV-3", requested_at: MST("2026-11-09", "10:00") } });
  assert.equal(third.screen_result, "post_closing_rejected"); assert.match(String(third.rejection_reason), /Fannie Mae B4-1.3-12/);
  assert.equal(h.evts("rov.forwarded").length, 0);
  assert.equal(h.escalations.opened.filter((e) => e.payload.rov_id !== "ROV-1").length, 0);
  // guardrail: the agent never declines an ROV alone — a decline is the SME's
  await assert.rejects(h.run("forwardRov", { rov_id: "ROV-1", sme_decision: "decline", sme_reviewer: "agent" }), (e: unknown) => e instanceof CommandRefused && e.code === "ROV_DECLINE_IS_SME_DECISION");
});

test("24.2-T6: Given a report narrative containing \"undesirable neighborhood\" without factual support, then `bias_scan_result.severity = high`, `correction_requested` is issued using the template, and a fair-lending record is written; the value is not used until the corrected version is accepted.", async () => {
  const scan = scanLanguage("The subject is located in an undesirable neighborhood with limited appeal.");
  assert.equal(scan.severity, "high"); assert.deepEqual(scan.terms_hit, ["undesirable neighborhood"]); assert.deepEqual(scan.demographic_references, []);
  assert.equal(scanLanguage("Police report #2231 (quoted): 'crime in the block was reported twice in 2025'.", ["quoted police report: crime"]).severity, "low");
  assert.equal(scanLanguage("The neighborhood is predominantly Hispanic.").severity, "high");
  const h = harness(REFI, MST("2026-10-15", "14:20"));
  await h.run("ingestReport", { appraisal_id: APPRAISAL, version_no: 1, package: PACKAGE, appraised_value_cents: 80_000_000n, effective_date: "2026-10-14", appraiser_party_id: APPRAISER });
  await h.run("submitUcdp", { appraisal_id: APPRAISAL, version_no: 1, package_hash: "sha256:v1" });
  await h.run("pollFindings", { appraisal_id: APPRAISAL, version_no: 1 });
  const r = await h.run("applyReviewChecklist", { appraisal_id: APPRAISAL, version_no: 1, checklist: { ...CHECKLIST, narrative: "The subject is located in an undesirable neighborhood with limited appeal." }, transaction_type: "refinance" });
  assert.equal((r.bias_scan as { severity: string }).severity, "high"); assert.equal(r.review_status, "correction_requested"); assert.equal(r.value_used, null); assert.equal(r.fair_lending_record_required, true);
  assert.ok(h.rt.store.get("fair_lending_records", `${APPRAISAL}:v1`)); assert.equal(h.evts("valuation.bias.flagged")[0]!.payload.fair_lending_record, true);
  const c = await h.run("requestCorrection", { appraisal_id: APPRAISAL, version_no: 1, reason: "bias_language", scan: r.bias_scan });
  assert.equal(c.template, "CR-24.2 v1"); assert.match(String(c.text), /Term "undesirable neighborhood" — please describe the property and market area in factual, unbiased and specific terms/); assert.match(String(c.text), /contains no opinion of value/);
  assert.equal(h.evts("valuation.correction.requested")[0]!.payload.reason, "bias_language");
  const row = h.rt.store.get("appraisals", `${APPRAISAL}:v1`)!.data; assert.equal(row.review_status, "correction_requested"); assert.equal(row.value_used_cents, null); assert.equal(row.is_final_version, false);
  await assert.rejects(h.run("setValueUsed", { appraisal_id: APPRAISAL, version_no: 1, transaction_type: "refinance", appraised_value_cents: 80_000_000n }), /not used until the corrected version is accepted/);
  // template-locked: no value language reaches the appraiser; the report is never altered by the platform
  await assert.rejects(h.run("requestCorrection", { appraisal_id: APPRAISAL, version_no: 1, reason: "bias_language", scan: r.bias_scan, target_value_cents: 82_000_000n }), (e: unknown) => e instanceof CommandRefused && e.code === "APPRAISER_TEXT_TEMPLATE_LOCKED");
  await assert.rejects(h.run("ingestReport", { appraisal_id: APPRAISAL, version_no: 1, package: PACKAGE, appraised_value_cents: 80_000_000n, effective_date: "2026-10-14", appraiser_party_id: APPRAISER, edit_narrative: "..." }), (e: unknown) => e instanceof CommandRefused && e.code === "REPORT_NOT_ALTERABLE");
  // the corrected v2 is accepted → value used
  h.clock.set(MST("2026-10-20", "09:00"));
  await h.run("ingestReport", { appraisal_id: APPRAISAL, version_no: 2, package: PACKAGE, appraised_value_cents: 80_000_000n, effective_date: "2026-10-14", appraiser_party_id: APPRAISER });
  await h.run("submitUcdp", { appraisal_id: APPRAISAL, version_no: 2, package_hash: "sha256:v2" });
  await h.run("pollFindings", { appraisal_id: APPRAISAL, version_no: 2 });
  const r2 = await h.run("applyReviewChecklist", { appraisal_id: APPRAISAL, version_no: 2, checklist: CHECKLIST, transaction_type: "refinance" });
  assert.equal(r2.review_status, "accepted"); assert.deepEqual(r2.value_used, { value_used_cents: 80_000_000n, value_basis: "appraised" });
});

test("24.2-T7: Given a non-QM HPML purchase with seller acquisition Aug 1, 2026 at $340,000 and a contract Oct 15, 2026 at $412,000, then the flip test yields days = 75, pct = 21.18%, a second appraisal by a different appraiser is required, only one appraisal fee may be borrower-paid, and both copies are due by Fri Nov 13 for a Nov 18 consummation.", async () => {
  const flip = flipTest({ contract_date: D("2026-10-15"), seller_acquisition_date: D("2026-08-01"), contract_price_cents: 41_200_000n, seller_acquisition_price_cents: 34_000_000n });
  assert.equal(flip.days, 75); assert.equal(flip.pct, 0.2118); assert.equal(flip.pct_display, "21.18%"); assert.equal(flip.increase_cents, 7_200_000n); assert.equal(flip.second_appraisal_required, true);
  assert.equal(hpmlAppraisalRulesApply({ is_hpml: true, qm_type: "not_qm", loan_amount_cents: 32_960_000n, as_of: D("2026-10-15") }).apply, true);
  assert.equal(hpmlCopyDueOn(D("2026-11-18")), "2026-11-13");   // Nov 17, 16, 13
  const h = harness(PURCHASE, MST("2026-10-28", "10:00"));
  const t = await h.run("runHpmlTests", { appraisal_id: "APR-PURCH-1", is_hpml: true, qm_type: "not_qm", loan_amount_cents: 32_960_000n, assignment_type: "traditional", interior_visit: true, consummation_on: "2026-11-18", flip: { contract_date: "2026-10-15", seller_acquisition_date: "2026-08-01", contract_price_cents: "41200000", seller_acquisition_price_cents: "34000000" },
    first_appraiser_party_id: "PARTY-APPRAISER-1", second_appraiser_party_id: "PARTY-APPRAISER-2", appraisal_fee_items: [{ fee_item_id: "F-APR-1", paid_by: "borrower", appraisal_no: 1 }, { fee_item_id: "F-APR-2", paid_by: "borrower", appraisal_no: 2 }] });
  assert.equal(t.hpml_appraisal_rules_apply, true); assert.equal((t.flip as typeof flip).days, 75); assert.equal((t.flip as typeof flip).pct_display, "21.18%");
  assert.equal(t.second_appraisal_required, true); assert.equal(t.second_appraiser_must_differ, true); assert.equal(t.borrower_chargeable_appraisals, 1); assert.equal(t.copies_due_on, "2026-11-13"); assert.equal(t.waiver_allowed, false);
  const plan = t.second_appraisal_plan as ReturnType<typeof secondAppraisalPlan>;
  assert.equal(plan.different_appraiser, true); assert.deepEqual(plan.refused_fee_item_ids, ["F-APR-2"]); assert.equal(plan.ok, false);
  assert.equal(secondAppraisalPlan({ first_appraiser_party_id: "PARTY-APPRAISER-1", second_appraiser_party_id: "PARTY-APPRAISER-1", appraisal_fee_items: [{ fee_item_id: "F-APR-1", paid_by: "borrower", appraisal_no: 1 }] }).different_appraiser, false);
  assert.equal(h.evts("hpml.second_appraisal.required")[0]!.payload.copies_due_on, "2026-11-13");
  // REGZ_1026_35C_HPML_APPRAISAL_COPY_3BD (23.4 trigger, 24.2-owned): both copies by Fri Nov 13 — one late copy blocks consummation, no waiver
  const gate = hpmlAppraisalCopyGate({ appraisal_rules_apply: true, consummation_date: D("2026-11-18"), copies: [{ appraisal_id: "APR-PURCH-1", delivered_on: D("2026-11-12") }, { appraisal_id: "APR-PURCH-2", delivered_on: D("2026-11-16") }] });
  assert.equal(gate.open, false); assert.match(gate.reason!, /by 2026-11-13/);
  assert.equal(hpmlAppraisalCopyGate({ appraisal_rules_apply: true, consummation_date: D("2026-11-18"), copies: [{ appraisal_id: "APR-PURCH-1", delivered_on: D("2026-11-12") }, { appraisal_id: "APR-PURCH-2", delivered_on: D("2026-11-13") }] }).open, true);
  assert.equal(evaluateGate("23.4.hpmlAppraisalCopy3bd", { appraisal_rules_apply: true, consummation_date: "2026-11-18", copies: [{ appraisal_id: "APR-PURCH-1", delivered_on: "2026-11-16" }] }).open, false);
  h.events.append({ type: "compliance.hpml.determined", applicationId: PURCHASE, actor: { kind: "agent", id: "compliance-tester" }, payload: { application_id: PURCHASE, stage: "cd", is_hpml: true, appraisal_rules_apply: true, source: "origination" } });
  assert.equal(h.timer("REGZ_1026_35C_HPML_APPRAISAL_COPY_3BD")!.status, "armed");
  await assert.rejects(h.run("runHpmlTests", { loan_amount_cents: 32_960_000n, assignment_type: "traditional", waive_copy_timing: true }), (e: unknown) => e instanceof CommandRefused && e.code === "HPML_COPY_TIMING_NOT_WAIVABLE");
});

test("24.2-T8: Given a General QM classification, then `hpml_appraisal_rules_apply = false` and only the Reg B timers exist.", async () => {
  const a = hpmlAppraisalRulesApply({ is_hpml: true, qm_type: "general_safe_harbor", loan_amount_cents: 32_960_000n, as_of: D("2026-10-15") });
  assert.equal(a.apply, false); assert.equal(a.threshold_cents, 3_420_000n); assert.match(a.reason, /qualified mortgage/);
  assert.equal(hpmlAppraisalRulesApply({ is_hpml: true, qm_type: "not_qm", loan_amount_cents: 3_420_000n, as_of: D("2026-10-15") }).apply, false);   // at the $34,200 threshold: exempt
  const h = harness(PURCHASE, MST("2026-10-15", "14:20"));
  const t = await h.run("runHpmlTests", { is_hpml: true, qm_type: "general_safe_harbor", loan_amount_cents: 32_960_000n, assignment_type: "traditional", consummation_on: "2026-11-18" });
  assert.equal(t.hpml_appraisal_rules_apply, false); assert.equal(t.second_appraisal_required, false); assert.equal(t.copies_due_on, null);
  assert.deepEqual(t.timers, ["REGB_1002_14_APPRAISAL_COPY_PROMPT_7", "REGB_1002_14_APPRAISAL_COPY_3BD_GATE", "REGB_1002_14_WAIVER_3BD_GATE"]);
  // 23.4's determination with appraisal_rules_apply=false arms nothing; the Reg B rows arm on the accepted review and the scheduled closing
  h.events.append({ type: "compliance.hpml.determined", applicationId: PURCHASE, actor: { kind: "agent", id: "compliance-tester" }, payload: { application_id: PURCHASE, stage: "cd", is_hpml: true, appraisal_rules_apply: false, source: "origination" } });
  await h.run("ingestReport", { appraisal_id: "APR-PURCH-1", version_no: 1, package: PACKAGE, appraised_value_cents: 41_200_000n, effective_date: "2026-10-27", appraiser_party_id: APPRAISER });
  await h.run("submitUcdp", { appraisal_id: "APR-PURCH-1", version_no: 1, package_hash: "sha256:p1" });
  await h.run("pollFindings", { appraisal_id: "APR-PURCH-1", version_no: 1 });
  await h.run("applyReviewChecklist", { appraisal_id: "APR-PURCH-1", version_no: 1, checklist: CHECKLIST, transaction_type: "purchase", purchase_price_cents: 41_200_000n, consummation_on: "2026-11-18" });
  h.events.append({ type: "closing.scheduled", applicationId: PURCHASE, actor: AGENT, payload: { application_id: PURCHASE, consummation_at: "2026-11-18", is_hpml: true, appraisal_rules_apply: false, source: "origination" } });
  const codes = new Set(h.timers.all().map((t) => t.code));
  assert.ok(codes.has("REGB_1002_14_APPRAISAL_COPY_PROMPT_7") && codes.has("REGB_1002_14_APPRAISAL_COPY_3BD_GATE"));
  assert.ok(![...codes].some((c) => c.startsWith("REGZ_1026_35C")), `HPML appraisal timers must not exist for a QM: ${[...codes].join(", ")}`);
});

test("24.2-T9: Given UCDP \"Not Successful\" with a manually overridable stop, then a `fnma_portal_operator` escalation with reason code and justification is created and delivery remains blocked by `FNMA_B4_1_1_06_UCDP_SUCCESSFUL_GATE` until Successful.", async () => {
  const STOP: UcdpFinding = { code: "FNM0401", severity: "overridable", message: "Fewer than the three closed sales required per Selling Guide B4-1.3-08 within 12 months", overridable: true };
  const routing = routeUcdpResult([{ gse: "fnma", status: "not_successful", doc_file_id: "1200000123456", findings: [STOP, { code: "FNM0900", severity: "warning", message: "Comparable 3 sale date > 6 months", overridable: false }], cu_score: 2.4, cu_flags: NO_CU_FLAGS, result_at: MST("2026-10-15", "15:07"), api_correlation_id: "x" }]);
  assert.equal(routing.route, "override_requested"); assert.equal(routing.ucdp_status, "not_successful"); assert.deepEqual(routing.overridable_stops.map((s) => s.code), ["FNM0401"]);
  const h = harness(REFI, MST("2026-10-15", "14:20"));
  await h.run("ingestReport", { appraisal_id: APPRAISAL, version_no: 1, package: PACKAGE, appraised_value_cents: 80_000_000n, effective_date: "2026-10-14", appraiser_party_id: APPRAISER });
  await h.run("submitUcdp", { appraisal_id: APPRAISAL, version_no: 1, package_hash: "sha256:v1" });
  h.ucdp.script(APPRAISAL, 1, "fnma", { status: "not_successful", findings: [STOP], cu_score: 2.4, cu_flags: NO_CU_FLAGS, result_at: MST("2026-10-15", "15:07") });
  h.ucdp.script(APPRAISAL, 1, "fhlmc", { status: "successful", findings: [], cu_score: null, cu_flags: NO_CU_FLAGS, result_at: MST("2026-10-15", "15:07") });
  const p = await h.run("pollFindings", { appraisal_id: APPRAISAL, version_no: 1 });
  assert.equal((p.routing as { route: string }).route, "override_requested");
  const pkg = await h.run("prepareOverride", { finding: STOP, reason_code: "RC-03 rural market — closed sales within 12 months exhausted", evidence: "MLS export shows 2 closed sales in 12 months; third comp is a 14-month sale with market-conditions adjustment" });
  assert.equal(pkg.reason_code, "RC-03 rural market — closed sales within 12 months exhausted"); assert.equal(pkg.ui_only, true); assert.equal(pkg.approved_at, null); assert.equal(pkg.queue, "fnma_portal_operator");
  await assert.rejects(h.run("prepareOverride", { finding: STOP, reason_code: "RC-03", evidence: "…", approve: true }), (e: unknown) => e instanceof CommandRefused && e.code === "UCDP_OVERRIDE_APPROVAL_OPERATOR");
  const esc = await h.run("fileEscalation", { kind: "fnma_portal_operator", reason: "UCDP Not Successful — manually overridable stop FNM0401", reason_code: pkg.reason_code, justification: pkg.justification, appraisal_id: APPRAISAL, override: pkg });
  assert.equal(esc.owner_role, "fnma_portal_operator"); assert.equal(esc.sla, "1 business_days_creditor");
  const opened = h.escalations.opened.find((e) => e.id === esc.escalation_id)!; assert.equal(opened.ownerRole, "fnma_portal_operator"); assert.equal(opened.payload.reason_code, pkg.reason_code); assert.match(String(opened.payload.justification), /MLS export/);
  // delivery gate closed while Not Successful
  const row = h.rt.store.get("appraisals", `${APPRAISAL}:v1`)!.data; assert.equal(row.ucdp_status, "not_successful"); assert.equal(row.review_status, "override_requested");
  const closed = evaluateGate("24.2.ucdpSuccessfulGate", { command: "submitDelivery", fnma_status: row.ucdp_status, doc_file_id: row.doc_file_id, is_final_version: true });
  assert.equal(closed.open, false); assert.match(closed.reason!, /not Successful — delivery blocked/);
  // the operator's override in the UCDP UI → resubmission Successful → gate open
  h.ucdp.script(APPRAISAL, 1, "fnma", { status: "successful", findings: [], cu_score: 2.4, cu_flags: NO_CU_FLAGS, result_at: MST("2026-10-16", "09:40") });
  h.clock.set(MST("2026-10-16", "09:40"));
  await h.run("pollFindings", { appraisal_id: APPRAISAL, version_no: 1 });
  const after = h.rt.store.get("appraisals", `${APPRAISAL}:v1`)!.data; assert.equal(after.ucdp_status, "successful");
  assert.equal(evaluateGate("24.2.ucdpSuccessfulGate", { command: "submitDelivery", fnma_status: after.ucdp_status, doc_file_id: after.doc_file_id, is_final_version: true }).open, true);
  assert.equal(evaluateGate("24.2.ucdpSuccessfulGate", { command: "submitDelivery", fnma_status: "successful", doc_file_id: "1200000123456", is_final_version: false }).open, false);
  assert.deepEqual(h.evts("valuation.ucdp.result.received").filter((e) => e.payload.gse === "fnma").map((e) => e.payload.status), ["not_successful", "successful"]);
});

test("24.2-T10: Given denial issued Fri Oct 30, 2026 with an undelivered AVM report developed Oct 12, then `REGB_1002_14_COPY_NOT_CONSUMMATED_30` is due Sun Nov 29 and the package includes the AVM report.", async () => {
  assert.equal(notConsummatedCopyDue(D("2026-10-30")), "2026-11-29");
  const h = harness(REFI, MST("2026-10-30", "16:00"));
  const pkg = await h.run("buildCopyPackage", { not_consummated: { cause: "decision.issued", decision_kind: "denial", determination_at: MST("2026-10-30", "16:00") }, add_valuations: [{ valuation_id: "VAL-AVM-1", kind: "avm_report", source_document_id: "DOC-AVM-1", developed_at: "2026-10-12" }, { valuation_id: "VAL-DU-1", kind: "du_value_acceptance_message", source_document_id: "DOC-DU-1", developed_at: "2026-10-06" }] });
  assert.equal(pkg.copy_required_by, "2026-11-29"); assert.equal(pkg.scheduled_on, "2026-11-27"); assert.equal(pkg.includes_avm, true); assert.equal(pkg.cover_template, "NTC_REGB_1002_14_COPY_NOT_CONSUMMATED");
  assert.deepEqual((pkg.valuations as ValuationRow[]).map((v) => v.valuation_id), ["VAL-AVM-1"]);   // the DU value-acceptance message is not a valuation (open question 4)
  assert.deepEqual(pkg.timers, ["REGB_1002_14_COPY_NOT_CONSUMMATED_30"]);
  const t = h.timer("REGB_1002_14_COPY_NOT_CONSUMMATED_30")!; assert.equal(t.dueDate, "2026-11-29"); assert.equal(t.status, "armed");
  assert.equal(h.timer("REGZ_1026_35C_HPML_COPY_NOT_CONSUMMATED_30"), undefined);
  assert.equal(h.evts("valuation.not_consummated.determined")[0]!.payload.decision_kind, "denial");
  // the copies go out Fri Nov 27 through the Notice Registry → `notice.sent{template=NTC_REGB_1002_14_COPY_NOT_CONSUMMATED}` satisfies the timer
  h.clock.set(MST("2026-11-27", "09:00"));
  const d = await h.run("deliverNotice", { template_code: "NTC_REGB_1002_14_COPY_NOT_CONSUMMATED", version: 1, channel: "electronic", esign_consent_verified: true, not_consummated: true, recipients: RECIPIENTS, valuation_ids: ["VAL-AVM-1"],
    payload: { partner_name: "Partner Bank, N.A.", borrower_names: ["Alex Fixture"], property_address: "4120 N 44th St, Phoenix AZ 85018", loan_number_last4: "0917", contact_phone: "1-800-555-0142", notice_date: "2026-11-27", determination_at: "2026-10-30", reason_label: "application denied", days_after_determination: 28, hpml: false, valuation_count: 1, valuations: [{ kind_label: "Automated valuation model report", developed_at: "2026-10-12", version_no: 1 }] } });
  assert.equal(d.status, "sent"); assert.equal(h.timer("REGB_1002_14_COPY_NOT_CONSUMMATED_30")!.status, "satisfied");
  assert.equal(h.rt.store.get("valuations", "VAL-AVM-1")!.data.delivered_at, MST("2026-11-27", "09:00"));
  // HPML variant: the same determination arms the §1026.35(c)(6)(ii)(B) row too
  const hp = harness(PURCHASE, MST("2026-10-30", "16:00"));
  const pk2 = await hp.run("buildCopyPackage", { hpml_appraisal_rules_apply: true, not_consummated: { cause: "application.withdrawn", determination_at: MST("2026-10-30", "16:00") }, add_valuations: [{ valuation_id: "VAL-P-1", kind: "appraisal", source_document_id: "DOC-P-1", developed_at: "2026-10-27" }] });
  assert.deepEqual(pk2.timers, ["REGB_1002_14_COPY_NOT_CONSUMMATED_30", "REGZ_1026_35C_HPML_COPY_NOT_CONSUMMATED_30"]);
  assert.equal(hp.timer("REGZ_1026_35C_HPML_COPY_NOT_CONSUMMATED_30")!.dueDate, "2026-11-29");
});

test("24.2-T11: Given a revised report (v2) received Mon Oct 26 after v1 was delivered Oct 16, then v2 is resubmitted to UCDP under the same Doc File ID, delivered to the applicants, and `is_final_version` moves to v2.", async () => {
  const h = harness(REFI, MST("2026-10-15", "14:20"));
  await h.acceptV1();
  h.clock.set(MST("2026-10-16", "10:45"));
  await h.run("deliverNotice", { template_code: "NTC_REGB_1002_14_VALUATION_COPY", payload: COPY_PAYLOAD(MST("2026-10-16", "10:30"), "2026-10-21"), recipients: RECIPIENTS, appraisal_id: APPRAISAL, version: 1, is_final_version: true, channel: "electronic", esign_consent_verified: true, valuation_ids: [`VAL-${APPRAISAL}-v1`] });
  assert.equal(h.rt.store.get("appraisals", `${APPRAISAL}:v1`)!.data.is_final_version, true);
  h.clock.set(MST("2026-10-26", "09:30"));
  const v2 = await h.run("ingestReport", { appraisal_id: APPRAISAL, version_no: 2, package: PACKAGE, appraised_value_cents: 80_000_000n, effective_date: "2026-10-14", appraiser_party_id: APPRAISER, received_at: MST("2026-10-26", "09:30") });
  assert.deepEqual(v2.events, ["valuation.revision.received"]); assert.equal((v2.appraisal as { doc_file_id: string }).doc_file_id, "1200000123456"); assert.equal((v2.valuation as ValuationRow).kind, "appraisal_revision");
  const sub = await h.run("submitUcdp", { appraisal_id: APPRAISAL, version_no: 2, package_hash: "sha256:v2" });
  assert.equal(sub.doc_file_id, "1200000123456"); assert.equal(sub.resubmission, true); assert.equal(sub.both_gses, true);
  assert.deepEqual(h.ucdp.submissions.map((s) => `${s.version_no}:${s.gse}:${s.doc_file_id}`), ["1:fnma:1200000123456", "1:fhlmc:1200000123456", "2:fnma:1200000123456", "2:fhlmc:1200000123456"]);
  h.ucdp.script(APPRAISAL, 2, "fnma", { status: "successful", findings: [], cu_score: 1.9, cu_flags: NO_CU_FLAGS, result_at: MST("2026-10-26", "09:45") });
  await h.run("pollFindings", { appraisal_id: APPRAISAL, version_no: 2 });
  h.clock.set(MST("2026-10-27", "10:00"));
  const r2 = await h.run("applyReviewChecklist", { appraisal_id: APPRAISAL, version_no: 2, checklist: CHECKLIST, transaction_type: "refinance", consummation_on: "2026-11-06" });
  assert.equal(r2.is_final_version, true); assert.equal(String(r2.completion_at).slice(0, 10), "2026-10-27");
  assert.equal(h.rt.store.get("appraisals", `${APPRAISAL}:v1`)!.data.is_final_version, false);
  assert.equal(h.rt.store.get("appraisals", `${APPRAISAL}:v2`)!.data.is_final_version, true);
  assert.equal((r2.copy_plan as ReturnType<typeof copyPlan>).copy_due_gate, "2026-11-03");   // gate for Nov 6 still satisfiable (Oct 27 ≤ Nov 3)
  const d = await h.run("deliverNotice", { template_code: "NTC_REGB_1002_14_VALUATION_COPY", payload: COPY_PAYLOAD(MST("2026-10-27", "10:00"), "2026-10-30", { revision: true, includes_rov_disclosure: false, valuations: [{ kind_label: "Uniform Residential Appraisal Report (Form 1004, UAD 3.6) — revised", developed_at: "2026-10-14", version_no: 2 }] }), recipients: RECIPIENTS, appraisal_id: APPRAISAL, version: 2, is_final_version: true, channel: "electronic", esign_consent_verified: true, consummation_on: "2026-11-06", valuation_ids: [`VAL-${APPRAISAL}-v2`] });
  assert.equal(d.gate_open_for_scheduled, true);
  assert.deepEqual(h.evts("valuation.copy.delivered").map((e) => [e.payload.version, e.payload.is_final_version]), [[1, true], [2, true]]);
  assert.equal(h.rt.store.get("valuations", `VAL-${APPRAISAL}-v2`)!.data.delivered_at, MST("2026-10-27", "10:00"));
  // a transferred report never reuses the other lender's Doc File ID
  await assert.rejects(h.run("submitUcdp", { appraisal_id: APPRAISAL, version_no: 2, package_hash: "sha256:v2", doc_file_id_source: "prior_lender" }), (e: unknown) => e instanceof CommandRefused && e.code === "DOC_FILE_ID_NOT_REUSABLE_ACROSS_LENDERS");
});

test("24.2-T12: Given CU score 4.3 with an Overvaluation flag, then `SM_CU_HIGH_RISK_REVIEW_1BD` is opened, the enhanced review record includes a comparable re-analysis, and `rw_relief_property_value = false`.", async () => {
  const FLAGS = { ...NO_CU_FLAGS, overvaluation: true };
  assert.deepEqual(cuReviewTier(4.3, FLAGS), { tier: "enhanced", enhanced_review_required: true, flagged: ["overvaluation"] });
  assert.equal(cuReviewTier(2.2, FLAGS).tier, "enhanced");   // the Overvaluation flag alone triggers enhanced review
  assert.equal(cuReviewTier(3.1, NO_CU_FLAGS).tier, "targeted"); assert.equal(cuReviewTier(999, NO_CU_FLAGS).tier, "manual_equivalent");
  assert.equal(rwReliefPropertyValue({ cu_score: 4.3, ucdp_status: "successful", form: "1004" }), false);
  const h = harness(REFI, MST("2026-10-15", "14:20"));
  await h.run("ingestReport", { appraisal_id: APPRAISAL, version_no: 1, package: PACKAGE, appraised_value_cents: 80_000_000n, effective_date: "2026-10-14", appraiser_party_id: APPRAISER, received_at: MST("2026-10-15", "14:20") });
  await h.run("submitUcdp", { appraisal_id: APPRAISAL, version_no: 1, package_hash: "sha256:v1" });
  h.ucdp.script(APPRAISAL, 1, "fnma", { status: "successful", findings: [], cu_score: 4.3, cu_flags: FLAGS, result_at: MST("2026-10-15", "15:07") });
  h.clock.set(MST("2026-10-15", "15:07"));
  const p = await h.run("pollFindings", { appraisal_id: APPRAISAL, version_no: 1 });
  assert.equal((p.cu as { tier: string; high_risk_review_due: string }).tier, "enhanced"); assert.equal((p.cu as { high_risk_review_due: string }).high_risk_review_due, "2026-10-16");
  const t = h.timer("SM_CU_HIGH_RISK_REVIEW_1BD")!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2026-10-16");
  assert.equal(h.evts("valuation.cu.scored")[0]!.payload.enhanced_review_required, true);
  h.clock.set(MST("2026-10-16", "09:00"));
  const r = await h.run("applyReviewChecklist", { appraisal_id: APPRAISAL, version_no: 1, checklist: CHECKLIST, transaction_type: "refinance", comparables: [
    { comp_id: "C1", distance_miles: 0.4, sale_date: "2026-08-14", adjusted_price_cents: "80500000", supported: true }, { comp_id: "C2", distance_miles: 0.9, sale_date: "2026-07-30", adjusted_price_cents: "81200000", supported: false, note: "GLA adjustment exceeds paired-sales indication" }, { comp_id: "C3", distance_miles: 1.2, sale_date: "2026-09-02", adjusted_price_cents: "79800000", supported: true }] });
  const enhanced = r.enhanced_review as { comparable_reanalysis: unknown[]; field_review_recommended: boolean; rw_relief_property_value: boolean };
  assert.equal(enhanced.comparable_reanalysis.length, 3); assert.equal(enhanced.field_review_recommended, true); assert.equal(enhanced.rw_relief_property_value, false);
  assert.equal(r.rw_relief_property_value, false); assert.equal(r.review_status, "accepted");
  assert.equal(h.rt.store.get("appraisals", `${APPRAISAL}:v1`)!.data.rw_relief_property_value, false);
  assert.equal(h.timer("SM_CU_HIGH_RISK_REVIEW_1BD")!.status, "satisfied");
  assert.equal(h.evts("valuation.review.enhanced.recorded")[0]!.payload.comparable_reanalysis, 3);
  assert.equal(h.evts("valuation.review.completed")[0]!.payload.rw_relief_property_value, false);
});

test("24.2 worked figures: $800,000 appraised → value_used 80,000,000 cents, LTV 56,000,000 / 80,000,000 = 0.7000 (70.00%); flip $412,000 vs $340,000 = $72,000 (21.18%, 75 days); $34,200 HPML exemption; Doc File ID 1200000123456; Oct 23 / Nov 3 / Nov 9 / Oct 22 / Oct 28 / Nov 13 / Nov 29 (Nov 27)", () => {
  assert.deepEqual(valueUsed({ transaction_type: "refinance", appraised_value_cents: 80_000_000n }), { value_used_cents: 80_000_000n, value_basis: "appraised" });
  assert.deepEqual(valueUsed({ transaction_type: "purchase", appraised_value_cents: 80_000_000n, purchase_price_cents: 81_500_000n }), { value_used_cents: 80_000_000n, value_basis: "appraised" });
  assert.deepEqual(valueUsed({ transaction_type: "purchase", appraised_value_cents: 41_000_000n, purchase_price_cents: 41_200_000n }), { value_used_cents: 41_000_000n, value_basis: "appraised" });
  assert.deepEqual(valueUsed({ transaction_type: "purchase", appraised_value_cents: 41_500_000n, purchase_price_cents: 41_200_000n }), { value_used_cents: 41_200_000n, value_basis: "lower_of_two" });
  assert.deepEqual(ltv(56_000_000n, 80_000_000n), { ratio: 0.7, pct_display: "70.00%" });
  const flip = flipTest({ contract_date: D("2026-10-15"), seller_acquisition_date: D("2026-08-01"), contract_price_cents: 41_200_000n, seller_acquisition_price_cents: 34_000_000n });
  assert.equal(flip.increase_cents, 7_200_000n); assert.equal(flip.pct, 0.2118); assert.equal(flip.pct_display, "21.18%"); assert.equal(flip.days, 75);
  assert.equal(flipTest({ contract_date: D("2026-10-15"), seller_acquisition_date: D("2026-06-01"), contract_price_cents: 41_200_000n, seller_acquisition_price_cents: 34_000_000n }).second_appraisal_required, true);    // 136 days, 21.18 % > 20 %
  assert.equal(flipTest({ contract_date: D("2026-10-15"), seller_acquisition_date: D("2026-06-01"), contract_price_cents: 40_000_000n, seller_acquisition_price_cents: 34_000_000n }).second_appraisal_required, false);   // 136 days, 17.65 % ≤ 20 %
  assert.equal(flipTest({ contract_date: D("2026-10-15"), seller_acquisition_date: D("2026-08-01"), contract_price_cents: 41_200_000n, seller_acquisition_price_cents: 34_000_000n, exemption_code: "c4vii_A_gse_reo" }).second_appraisal_required, false);
  assert.equal(hpmlAppraisalRulesApply({ is_hpml: true, qm_type: "not_qm", loan_amount_cents: 3_420_001n, as_of: D("2026-10-15") }).apply, true);
  assert.equal(hpmlAppraisalRulesApply({ is_hpml: true, qm_type: "not_qm", loan_amount_cents: 3_420_000n, as_of: D("2026-10-15") }).threshold_cents, 3_420_000n);
  // calendar arithmetic (business_days_creditor; Veterans Day Wed Nov 11, 2026 closed)
  assert.equal(copyPlan({ completion_at: MST("2026-10-16", "10:30"), consummation_on: D("2026-11-06") }).copy_required_by, "2026-10-23");
  assert.equal(copyPlan({ completion_at: MST("2026-10-16", "10:30"), consummation_on: D("2026-10-23") }).copy_required_by, "2026-10-20");   // gate earlier than prompt → gate wins
  assert.equal(earliestConsummation(D("2026-11-03")), "2026-11-06"); assert.equal(earliestConsummation(D("2026-11-04")), "2026-11-09"); assert.equal(earliestConsummation(D("2026-11-10")), "2026-11-16");
  assert.equal(screenRov({ request: ROV, prior_borrower_rovs_for_appraisal: 0, consummated: false }).screen_due_on, "2026-10-22");
  assert.equal(rovTurnTimeDue(D("2026-10-21")), "2026-10-28");
  assert.equal(hpmlCopyDueOn(D("2026-11-18")), "2026-11-13");
  assert.equal(notConsummatedCopyDue(D("2026-10-30")), "2026-11-29");
  assert.equal(ucdpSubmitDue(D("2026-10-15")), "2026-10-16");
  assert.equal(reviewDue(D("2026-10-15")), "2026-10-19");   // spec R5 says "due Tue Oct 20": Oct 15 + 2 creditor business days is Mon Oct 19 (discrepancy reported)
  assert.equal(new FakeUcdp().submit({ appraisal_id: APPRAISAL, version_no: 1, gse: "fnma", doc_file_id: null, submitted_at: MST("2026-10-15", "15:05"), package_hash: "h" }).doc_file_id, "1200000123456");
});
