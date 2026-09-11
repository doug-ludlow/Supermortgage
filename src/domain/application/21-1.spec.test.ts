// 21.1 Conversational URLA/1003 intake, application data capture, and the MLO-of-record touchpoint
// spec/sections/21-application-urla-initial-disclosures-intent-to-proceed-rate/21-1-conversational-urla-1003-intake-application-data-capture-and.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths } from "../../kernel/calendar/date.ts";
import { creditor } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_21_1 } from "../../app/tools/section21-1.ts";
import { evaluateGate, assertGate, GateClosed } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { type IntakeApplication, type MloRosterEntry, newIntakeApplication, startInterview, discloseAi, receiveApplication, captureSixItem, offerPrefill, confirmPrefill, detectSixItems, leDueDate, localIso, addBorrower, nonBorrowingSpouse, affirmJointIntent, demographicsRow, askDemographics, presentScif, scanTranscript, reportProhibitedInquiry, assignMlo, openMloReview, decideMloReview, reassignMlo, handleMloSlaBreach, loadNmlsFeed, gateFacts, mloOfRecordGate, jointIntentGate, scifPresentGate, utterancePermission, logSafeActivity, indicativeQuotePayment, renderForm1003, requestESign, abandonDecision, abandonSweep, educationAndCounseling, civilDate, SAFE_GATE, INTAKE_ABANDON_DAYS, REGB_RETENTION_MONTHS, SCIF_TEMPLATE } from "./ops-21-1.ts";
import { SCIF_SAMPLE } from "../../notices/authored/section21-1.ts";

const INTAKE: Actor = { kind: "agent", id: "intake" };
const MLO: Actor = { kind: "human", id: "u-mlo-az", role: "mlo_of_record" };
const MLO_OH: Actor = { kind: "human", id: "u-mlo-oh", role: "mlo_of_record" };
const toolKey = (process: string, name: string): string => `${process} ${name}`;
/** Partner roster (31.1): AZ- and OH-licensed MLOs of record, NMLS status per the nightly feed. */
const ROSTER: readonly MloRosterEntry[] = [
  { mlo_id: "u-mlo-az", name: "M. Originator", nmlsr_id: "1234567", licensed_states: ["AZ", "NY"], nmls_status: "active", open_queue: 3 },
  { mlo_id: "u-mlo-az2", name: "N. Second", nmlsr_id: "7654321", licensed_states: ["AZ"], nmls_status: "active", open_queue: 7 },
  { mlo_id: "u-mlo-oh", name: "O. Originator", nmlsr_id: "2345678", licensed_states: ["OH"], nmls_status: "active", open_queue: 1 },
  { mlo_id: "u-mlo-inactive", name: "P. Lapsed", nmlsr_id: "9999999", licensed_states: ["AZ", "OH"], nmls_status: "inactive", open_queue: 0 },
];
const noticeReg = buildRegistry(); publishAuthored(noticeReg);
/** The 21.1 bus alone (the 30-2 pattern): TOOLS_21_1 bound to the `intake` agent over the overridden registry (21.1 rows + 21.2/20.3's LE clock), escalations and the Notice Registry; the application-scoped unit of work stamps `applicationId` on every event. */
function harness(applicationId: string, nowIso: string, o: { tz?: string; processes?: readonly string[] } = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: [...(o.processes ?? ["21.1", "20.3"])] });
  const escalations = new EscalationService(events, clock); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: {}, ports: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }) };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const agents = new AgentRegistry(); const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_21_1) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(toolKey(d.process, d.name), cmd); }
  const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = INTAKE): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("21.1", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
  const app = (): IntakeApplication => rt.store.get("applications", applicationId)!.data as unknown as IntakeApplication;
  /** The runtime's own `application.started` (src/runtime/app.ts createApplication) — arms SM_O21_INTAKE_ABANDON_30. */
  const started = (extra: Record<string, unknown> = {}) => events.append({ type: "application.started", applicationId, aggregate: { kind: "application", id: applicationId }, actor: INTAKE, payload: { application_id: applicationId, channel: "refi_trigger", ...extra } });
  return { clock, events, timers, escalations, rt, uow, run, at, timer, ofType, app, started, decisions, tz: o.tz ?? "America/Phoenix" };
}
const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
/** Worked example 1 as a plain intake record: Phoenix AZ refinance, voice, started 10:14 MST Mon Oct 5, 2026. */
const refi = (o: Partial<Parameters<typeof newIntakeApplication>[0]> = {}): IntakeApplication => newIntakeApplication({ id: "APP-REFI-1", partner_name: "Partner Bank", partner_nmlsr_id: "123456", intake_channel: "voice", started_at: "2026-10-05T17:14:00.000Z", creditor_time_zone: "America/Phoenix", property_state: "AZ", borrowers: [{ id: "B1", legal_name: "R. Borrower", marital_status: "married" }], ...o });
/** Worked example 2: Columbus OH purchase, web, borrower A starts 18:40 EDT Mon Oct 19, 2026. */
const purchase = (): IntakeApplication => newIntakeApplication({ id: "APP-PURCH-1", partner_name: "Partner Bank", partner_nmlsr_id: "123456", intake_channel: "web", started_at: "2026-10-19T22:40:00.000Z", creditor_time_zone: "America/New_York", property_state: "OH", transaction_type: "purchase", occupancy: "primary", borrowers: [{ id: "A", legal_name: "A. Applicant", marital_status: "unmarried" }] });
const memStore = () => new MemoryEventStore(new FixedClock("2026-10-05T17:14:00.000Z"));
/** Refinance fixture through `received` (10:16 MST) with the MLO of record assigned at the same moment (rule 7). */
function receivedRefi(events: MemoryEventStore, app = refi()): IntakeApplication {
  return assignMlo(events, receiveApplication(events, app, { at: "2026-10-05T17:16:00.000Z", transaction_type: "limited_cash_out", occupancy: "primary", property_address: "1 Palm Ln, Phoenix AZ 85001", identity_verified: true }).app, { roster: ROSTER, at: "2026-10-05T17:16:00.000Z" }).app;
}

test("21.1-T1: Given a voice interview on Mon Oct 5, 2026 where the sixth item (loan amount $560,000) is stated at 10:41 MST, when the agent processes the utterance, then `trid_received_at` = 2026-10-05T10:41 MST, `application.trid_received` is emitted once, and 21.2's `REGZ_1026_19E1_LE_3BD` shows due date Thu Oct 8, 2026.", async () => {
  const h = harness("APP-REFI-1", "2026-10-05T17:14:00.000Z"); h.started();
  assert.equal(h.timer("SM_O21_INTAKE_ABANDON_30")!.status, "armed"); assert.equal(h.timer("SM_O21_INTAKE_ABANDON_30")!.dueDate, "2026-11-04", "+30 calendar days from the Oct 5 start");
  // 10:14 MST: session opens with the AI disclosure (ai_intake_mode snapshots the feature flag: assisted)
  const s = await h.run("startInterview", { session_id: "S-1", partner_name: "Partner Bank", partner_nmlsr_id: "123456", intake_channel: "voice", creditor_time_zone: "America/Phoenix", property_state: "AZ", borrowers: [{ id: "B1", legal_name: "R. Borrower", marital_status: "married" }], model_version: "intake-2026.09", prompt_version: "p-1.4" });
  assert.equal(s.ai_intake_mode, "assisted");
  h.at("2026-10-05T17:14:07.000Z"); await h.run("discloseAI", { session_id: "S-1", utterance_id: "utt-0001", state: "AZ" });
  // 10:16: "I want to refinance to lower my payment" → application.received (Reg B) = application_date / hmda_application_date 2026-10-05; the three gates arm on it
  h.at("2026-10-05T17:16:00.000Z"); const rec = await h.run("captureField", { field: "credit_request", transaction_type: "limited_cash_out", occupancy: "primary", property_state: "AZ", identity_verified: true });
  assert.deepEqual([rec.status, rec.application_date, rec.hmda_application_date], ["received", "2026-10-05", "2026-10-05"]);
  for (const code of [SAFE_GATE, "SM_O21_SCIF_PRESENT_GATE", "SM_O21_DEMOGRAPHICS_ASKED_GATE"]) { const t = h.timer(code)!; assert.equal(t.status, "armed", code); assert.match(t.note!, /^evaluator:21\.1\./); assert.equal(t.applicationId, "APP-REFI-1"); }
  // six items: name confirmed 10:16 (prefill), SSN 10:18 (spoken), address 10:19 (prefill confirmed), income $14,800/mo 10:27, value $800,000 10:33 (stated — the $795,000 AVM is not shown first), loan amount $560,000 10:41
  await h.run("confirmPrefill", { op: "offer", item: "name", value: "R. Borrower" }); await h.run("confirmPrefill", { item: "name" });
  h.at("2026-10-05T17:18:00.000Z"); await h.run("captureField", { field: "ssn", value: "123-45-6789", borrower_id: "B1" });
  await h.run("confirmPrefill", { op: "offer", item: "property_address", value: "1 Palm Ln, Phoenix AZ 85001" }); h.at("2026-10-05T17:19:00.000Z"); await h.run("confirmPrefill", { item: "property_address" });
  h.at("2026-10-05T17:27:00.000Z"); await h.run("captureField", { field: "income", value: 1_480_000n, borrower_id: "B1" });
  h.at("2026-10-05T17:33:00.000Z"); const five = await h.run("captureField", { field: "property_value_estimate", value: 80_000_000n });
  assert.equal(five.six_items_complete, false); assert.deepEqual(five.missing, ["loan_amount_sought"]); assert.equal(h.ofType("application.trid_received").length, 0);
  h.at("2026-10-05T17:41:00.000Z"); const sixth = await h.run("captureField", { field: "loan_amount_sought", value: 56_000_000n });
  assert.equal(sixth.six_items_complete, true); assert.equal(sixth.trid_emitted, true); assert.equal(sixth.trid_received_at, "2026-10-05T17:41:00.000Z");
  const app = h.app();
  assert.equal(localIso(app.trid_received_at!, h.tz), "2026-10-05T10:41:00-07:00", "trid_received_at = 2026-10-05T10:41 MST"); assert.equal(app.trid_application_date, "2026-10-05"); assert.equal(app.status, "trid_received"); assert.equal(app.loan_amount_sought_cents, 56_000_000n);
  assert.deepEqual(Object.fromEntries(Object.entries(app.six_items).map(([k, v]) => [k, v.source])), { name: "borrower_confirmed_prefill", income: "borrower_stated", ssn: "borrower_stated", property_address: "borrower_confirmed_prefill", property_value_estimate: "borrower_stated", loan_amount_sought: "borrower_stated" });
  // emitted once: the detector is idempotent and the payload carries 21.2's anchor
  const trid = h.ofType("application.trid_received"); assert.equal(trid.length, 1); assert.equal(trid[0]!.applicationId, "APP-REFI-1"); assert.equal(trid[0]!.payload.trid_application_date, "2026-10-05"); assert.equal(trid[0]!.payload.trid_received_at, "2026-10-05T17:41:00.000Z");
  const again = await h.run("detectSixItems", {}); assert.equal(again.emitted, false); assert.equal(again.complete, true); assert.equal(h.ofType("application.trid_received").length, 1); assert.equal(again.le_due, "2026-10-08");
  // 21.2's REGZ_1026_19E1_LE_3BD arms on the event: Tue 6, Wed 7, Thu 8 under business_days_creditor; the abandon clock stops at trid_received
  const le = h.timer("REGZ_1026_19E1_LE_3BD")!; assert.equal(le.dueDate, "2026-10-08"); assert.equal(le.anchorDate, "2026-10-05"); assert.equal(le.status, "armed"); assert.equal(le.subject.id, "APP-REFI-1");
  assert.equal(leDueDate(D("2026-10-05")), "2026-10-08"); assert.equal(h.timer("SM_O21_INTAKE_ABANDON_30")!.status, "satisfied");
  assert.equal(h.decisions.filter((d) => d.action.startsWith("captureField")).length, 5, "every write tool records a decision row (credit_request + four stated items)");
});

test("21.1-T2: Given a prefilled property address from servicing data, when the borrower has not yet confirmed it, then `six_items.property_address.submitted_at` is null and `trid_received` is not emitted even if the other five items are submitted.", () => {
  const events = memStore(); let app = receivedRefi(events);
  // 20.1's servicing data offered as a suggestion: not a submission
  app = offerPrefill(app, "property_address", "1 Palm Ln, Phoenix AZ 85001");
  assert.equal(app.six_items.property_address.submitted_at, null); assert.equal(app.six_items.property_address.source, "prefill_unconfirmed"); assert.ok(app.six_items.property_address.value_hash);
  app = captureSixItem(events, app, { item: "name", value: "R. Borrower", at: "2026-10-05T17:16:30.000Z" }).app;
  app = captureSixItem(events, app, { item: "ssn", value: "123-45-6789", at: "2026-10-05T17:18:00.000Z" }).app;
  app = captureSixItem(events, app, { item: "income", value: 1_480_000n, at: "2026-10-05T17:27:00.000Z" }).app;
  app = captureSixItem(events, app, { item: "property_value_estimate", value: 80_000_000n, at: "2026-10-05T17:33:00.000Z" }).app;
  const r = captureSixItem(events, app, { item: "loan_amount_sought", value: 56_000_000n, at: "2026-10-05T17:41:00.000Z" }); app = r.app;
  assert.equal(r.trid.complete, false); assert.deepEqual(r.trid.missing, ["property_address"]); assert.equal(r.trid.emitted, false);
  assert.equal(app.six_items.property_address.submitted_at, null); assert.equal(app.trid_received_at, null); assert.equal(app.status, "received");
  assert.equal(events.all().filter((e) => e.type === "application.trid_received").length, 0); assert.equal(events.all().filter((e) => e.type === "application.six_item.captured").length, 5);
  // captureField refuses to record a prefill as stated; only the borrower's explicit confirmation submits it — and it is the sixth item, so trid_received_at is the confirmation time
  assert.throws(() => captureSixItem(events, app, { item: "property_address", value: "1 Palm Ln, Phoenix AZ 85001", at: "2026-10-05T17:42:00.000Z", source: "borrower_confirmed_prefill" }), /only through confirmPrefill/);
  const c = confirmPrefill(events, app, { item: "property_address", at: "2026-10-05T17:43:00.000Z" });
  assert.equal(c.app.six_items.property_address.source, "borrower_confirmed_prefill"); assert.equal(c.app.six_items.property_address.submitted_at, "2026-10-05T17:43:00.000Z"); assert.equal(c.trid.emitted, true); assert.equal(c.app.trid_received_at, "2026-10-05T17:43:00.000Z");
  assert.equal(events.all().filter((e) => e.type === "application.trid_received").length, 1);
  // a purchase without a contract: "TBD" never satisfies the property_address item (rule 2) — the file stays `received`
  assert.throws(() => captureSixItem(events, receivedRefi(memStore()), { item: "property_address", value: "TBD", at: "2026-10-05T17:19:00.000Z" }), /'TBD' does not satisfy the TRID item/);
});

test("21.1-T3: Given a telephone application where the applicant declines ethnicity and race, when the record is saved, then `declined_*` are true, `visual_observation_used=false`, and any attempt to write ethnicity/race values is rejected by the constraint.", async () => {
  const row = demographicsRow({ collection_method: "telephone", declined_ethnicity: true, declined_race: true, sex: "female", collected_at: "2026-10-05T17:50:00.000Z" });
  assert.equal(row.declined_ethnicity, true); assert.equal(row.declined_race, true); assert.equal(row.declined_sex, false); assert.equal(row.visual_observation_used, false); assert.equal(row.ethnicity, null); assert.equal(row.race, null); assert.equal(row.sex, "female");
  assert.equal(row.collection_channel, "telephone"); assert.equal(row.hmda_not_provided_code_applies, true, "28.3 reports FIG code 3 'information not provided by applicant in mail, internet, or telephone application'");
  // 0057 CHECK constraints mirrored: declined ⇒ values null; visual observation only in person; never inferred
  assert.throws(() => demographicsRow({ collection_method: "telephone", declined_ethnicity: true, ethnicity: ["hispanic_or_latino"], collected_at: "2026-10-05T17:50:00.000Z" }), /applicant_demographics_declined_ethnicity/);
  assert.throws(() => demographicsRow({ collection_method: "telephone", declined_race: true, race: ["white"], collected_at: "2026-10-05T17:50:00.000Z" }), /applicant_demographics_declined_race/);
  assert.throws(() => demographicsRow({ collection_method: "telephone", visual_observation_used: true, race: ["white"], collected_at: "2026-10-05T17:50:00.000Z" }), /applicant_demographics_no_observation_remote/);
  assert.throws(() => demographicsRow({ collection_method: "video", visual_observation_used: true, collected_at: "2026-10-05T17:50:00.000Z" }), /video/);
  assert.throws(() => demographicsRow({ collection_method: "telephone", race: ["asian"], inferred_from: "surname", collected_at: "2026-10-05T17:50:00.000Z" }), /never inferred/);
  assert.equal(demographicsRow({ collection_method: "in_person", visual_observation_used: true, race: ["white"], declined_ethnicity: true, collected_at: "2026-10-05T17:50:00.000Z" }).visual_observation_used, true, "App. B instruction 10: lawful in person");
  // saved on the refinance fixture: the row persists once (append-only) and the demographics gate opens for the single borrower
  const events = memStore(); const app = receivedRefi(events);
  const saved = askDemographics(events, app, "B1", { collection_method: "telephone", declined_ethnicity: true, declined_race: true, sex: "female", collected_at: "2026-10-05T17:50:00.000Z" });
  assert.equal(saved.all_borrowers, true); assert.deepEqual([saved.event.payload.declined_ethnicity, saved.event.payload.declined_race, saved.event.payload.visual_observation_used], [true, true, false]);
  assert.equal(evaluateGate("21.1.demographicsAskedGate", gateFacts(saved.app)).open, true); assert.equal(evaluateGate("21.1.demographicsAskedGate", gateFacts(app)).open, false);
  assert.throws(() => askDemographics(events, saved.app, "B1", { collection_method: "telephone", race: ["white"], collected_at: "2026-10-05T17:51:00.000Z" }), /append-only/);
  // the bus refuses inference and remote visual observation before the handler runs
  const h = harness("APP-REFI-1", "2026-10-05T17:50:00.000Z"); h.rt.store.put("applications", "APP-REFI-1", app as unknown as Record<string, unknown>, INTAKE, h.clock.now());
  await refused(h.run("askDemographics", { borrower_id: "B1", collection_method: "telephone", race: ["asian"], inferred_from: "voice" }), "DEMOGRAPHICS_NEVER_INFERRED");
  await refused(h.run("askDemographics", { borrower_id: "B1", collection_method: "telephone", visual_observation_used: true }), "VISUAL_OBSERVATION_REMOTE");
  const out = await h.run("askDemographics", { borrower_id: "B1", collection_method: "telephone", declined_ethnicity: true, declined_race: true, sex: "female" });
  assert.match(out.statement_given as string, /Federal law requires this information to be collected/); assert.equal((out.row as { declined_race: boolean }).declined_race, true);
  assert.equal(h.timer("SM_O21_DEMOGRAPHICS_ASKED_GATE"), undefined, "no `application.received` on this store: nothing armed"); assert.equal(h.ofType("application.demographics.collected")[0]!.payload.all_borrowers, true);
});

test("21.1-T4: Given a web application where the applicant selects \"Asian\" and \"White\", when saved, then both values persist and the FIG \"more than one race\" handling is available to 28.3.", () => {
  const events = new MemoryEventStore(new FixedClock("2026-10-19T22:40:00.000Z")); const app = purchase();
  const r = askDemographics(events, app, "A", { collection_method: "internet", ethnicity: ["not_hispanic_or_latino"], race: ["asian", "white"], sex: "male", collected_at: "2026-10-19T22:45:00.000Z" });
  const row = r.app.borrowers[0]!.demographics!;
  assert.deepEqual(row.race, ["asian", "white"]); assert.deepEqual(row.ethnicity, ["not_hispanic_or_latino"]); assert.equal(row.declined_race, false); assert.equal(row.visual_observation_used, false); assert.equal(row.collection_channel, "internet");
  assert.equal(row.multiple_races_selected, true, "FIG: up to five race codes reported, never collapsed"); assert.equal(row.multiple_ethnicities_selected, false); assert.equal(row.hmda_not_provided_code_applies, false);
  assert.equal(r.event.payload.multiple_races_selected, true); assert.equal(r.event.type, "application.demographics.collected");
  // App. B instruction 9: more than one selection is always offered; disaggregated sub-categories persist as given
  const sub = demographicsRow({ collection_method: "internet", race: ["asian", "asian_indian", "white"], ethnicity: ["hispanic_or_latino", "mexican"], collected_at: "2026-10-19T22:45:00.000Z" });
  assert.deepEqual(sub.race, ["asian", "asian_indian", "white"]); assert.equal(sub.multiple_ethnicities_selected, true);
});

test("21.1-T5: Given two applicants on Mon Oct 19, 2026 where B has not affirmed joint intent, when 22.2 requests a credit pull for B, then `SM_O21_JOINT_INTENT_GATE` blocks it; after B's affirmation at 20:31 EDT the pull proceeds; the affirmation artifact id differs from the accuracy-attestation artifact id.", async () => {
  const h = harness("APP-PURCH-1", "2026-10-19T22:40:00.000Z", { tz: "America/New_York" }); h.started({ channel: "organic" });
  h.rt.store.put("applications", "APP-PURCH-1", purchase() as unknown as Record<string, unknown>, INTAKE, h.clock.now());
  await h.run("captureField", { field: "credit_request", transaction_type: "purchase", occupancy: "primary", property_state: "OH", identity_verified: true });
  // A affirms 18:52 EDT on a screen separate from the accuracy attestation
  h.at("2026-10-19T22:52:00.000Z"); await h.run("affirmJointIntent", { borrower_id: "A", method: "web_checkbox", evidence_id: "ji-A-1", accuracy_attestation_id: "att-A-1" });
  // B, invited by link, completes her own Section 1 at 20:15 EDT → application.borrower.added{joint_intent_required=true} arms the gate
  h.at("2026-10-20T00:15:00.000Z"); const added = await h.run("captureField", { field: "borrower", borrower_id: "B", legal_name: "B. Applicant", borrower_role: "co_borrower", marital_status: "unmarried", citizenship_status: "non_permanent_resident", legal_presence_evidence_document_id: "doc-ead-B", legal_presence_expires_on: "2027-03-31" });
  assert.equal(added.joint_intent_required, true); const gate = h.timer("SM_O21_JOINT_INTENT_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:21.1.jointIntentGate");
  // 22.2 requests a credit pull for B: the gate is closed on B
  const closedFacts = gateFacts(h.app()); const g = evaluateGate("21.1.jointIntentGate", closedFacts); assert.equal(g.open, false); assert.match(g.reason!, /borrower B has not affirmed joint intent/);
  assert.throws(() => assertGate("21.1.jointIntentGate", closedFacts), (e: unknown) => e instanceof GateClosed && e.ref === "21.1.jointIntentGate");
  assert.equal(h.ofType("credit.pull.requested").length, 0);
  // the affirmation cannot reuse the accuracy attestation artifact (comment 7(d)(1)-3)
  await refused(h.run("affirmJointIntent", { borrower_id: "B", method: "web_checkbox", evidence_id: "att-B-1", accuracy_attestation_id: "att-B-1" }), "JOINT_INTENT_DISTINCT_ARTIFACT");
  await refused(h.run("affirmJointIntent", { borrower_id: "B", method: "note_signature", evidence_id: "note-1" }), "NOTE_SIGNATURE_NOT_INTENT");
  // B affirms 20:31 EDT → gate opens; the pull proceeds
  h.at("2026-10-20T00:31:00.000Z"); const b = await h.run("affirmJointIntent", { borrower_id: "B", method: "web_checkbox", evidence_id: "ji-B-1" });
  assert.equal(b.all_borrowers, true); assert.equal(b.affirmed_at, "2026-10-20T00:31:00.000Z"); assert.equal(localIso(b.affirmed_at as string, "America/New_York"), "2026-10-19T20:31:00-04:00");
  assert.equal(evaluateGate("21.1.jointIntentGate", gateFacts(h.app())).open, true); assert.doesNotThrow(() => assertGate("21.1.jointIntentGate", gateFacts(h.app())));
  assert.equal(gate.status, "satisfied"); assert.equal(h.events.all().find((e) => e.id === gate.satisfiedByEventId)!.type, "application.joint_intent.affirmed");
  // the accuracy attestation (Section 6, at e-sign) is a different artifact from the joint-intent affirmation
  const app = h.app(); const bb = app.borrowers.find((x) => x.id === "B")!; assert.equal(bb.joint_intent_evidence_id, "ji-B-1"); assert.equal(bb.legal_presence_expires_on, "2027-03-31");
  const events = h.events; const signed = requestESign(events, app, { borrower_id: "B", document_id: "doc-1003-x", data_hash: "h", signed_at: "2026-10-20T00:50:00.000Z", consent: { status: "active", classes: ["application_documents"] }, accuracy_attestation_id: "att-B-1", audit: { ip: "10.0.0.2" } });
  assert.notEqual(signed.app.borrowers.find((x) => x.id === "B")!.accuracy_attestation_id, signed.app.borrowers.find((x) => x.id === "B")!.joint_intent_evidence_id);
  assert.throws(() => requestESign(events, app, { borrower_id: "B", document_id: "doc-1003-x", data_hash: "h", signed_at: "2026-10-20T00:50:00.000Z", consent: { status: "active", classes: ["application_documents"] }, accuracy_attestation_id: "ji-B-1", audit: {} }), /distinct from the joint-intent affirmation/);
  // a borrower added after the six items is measured against her own addition, not the earlier trid_received_at
  const late = jointIntentGate({ trid_received_at: "2026-10-20T00:44:00.000Z", borrowers: [{ id: "A", joint_intent_affirmed_at: "2026-10-19T22:52:00.000Z", added_at: "2026-10-19T22:40:00.000Z" }, { id: "C", joint_intent_affirmed_at: "2026-10-21T15:00:00.000Z", added_at: "2026-10-21T14:00:00.000Z" }] });
  assert.equal(late.open, true); assert.equal(jointIntentGate({ trid_received_at: "2026-10-20T00:44:00.000Z", borrowers: [{ id: "A", joint_intent_affirmed_at: "2026-10-20T01:00:00.000Z", added_at: "2026-10-19T22:40:00.000Z" }] }).open, false);
});

test("21.1-T6: Given no SCIF presented to borrower B, when 23.1 attempts `du.submit`, then `SM_O21_SCIF_PRESENT_GATE` blocks; after `scif_forms.presented_at` is set (even with all answers blank), the submission proceeds.", async () => {
  const h = harness("APP-PURCH-1", "2026-10-19T22:40:00.000Z", { tz: "America/New_York" });
  h.rt.store.put("applications", "APP-PURCH-1", purchase() as unknown as Record<string, unknown>, INTAKE, h.clock.now());
  await h.run("captureField", { field: "credit_request", transaction_type: "purchase", occupancy: "primary", property_state: "OH", identity_verified: true });
  assert.equal(h.timer("SM_O21_SCIF_PRESENT_GATE")!.status, "armed");
  h.at("2026-10-20T00:15:00.000Z"); await h.run("captureField", { field: "borrower", borrower_id: "B", legal_name: "B. Applicant", borrower_role: "co_borrower" });
  // A's SCIF: education "Completed Web-Based Workshop" on 2026-09-30 with a HUD agency id
  h.at("2026-10-19T23:05:00.000Z"); await h.run("presentSCIF", { borrower_id: "A", language_edition: "english", answers: { language_preference: "english", homeownership_education: { completed: true, format: "completed_web_based_workshop", agency_hud_id: "80123", agency_name: null, completed_on: "2026-09-30" } } });
  // 23.1 attempts du.submit: no SCIF for B → blocked
  const g = evaluateGate("21.1.scifPresentGate", gateFacts(h.app())); assert.equal(g.open, false); assert.match(g.reason!, /not presented to borrower\(s\) B/); assert.match(g.reason!, /du\.submit blocked/);
  assert.throws(() => assertGate("21.1.scifPresentGate", gateFacts(h.app())), (e: unknown) => e instanceof GateClosed && e.ref === "21.1.scifPresentGate");
  await refused(h.run("presentSCIF", { borrower_id: "B", skip: true }), "SCIF_NEVER_SKIPPED"); await refused(h.run("presentSCIF", { borrower_id: "B", require_answer: true }), "SCIF_ANSWER_NOT_A_CONDITION");
  // presented to B with every answer blank: presented_at set, completed_at null, language not_answered → the gate opens and du.submit proceeds
  h.at("2026-10-20T00:20:00.000Z"); const p = await h.run("presentSCIF", { borrower_id: "B", language_edition: "english", recipients: [{ partyId: "B", name: "B. Applicant", email: "b@example.com" }], payload: { ...SCIF_SAMPLE, borrower_name: "B. Applicant", presented_on: "2026-10-19", application_date: "2026-10-19", originator_name: "O. Originator", originator_nmlsr_id: "2345678" } });
  const scif = p.scif as { presented_at: string; completed_at: string | null; form_version: string; rendered_document_id: string | null; retention_class: string };
  assert.equal(scif.presented_at, "2026-10-20T00:20:00.000Z"); assert.equal(scif.completed_at, null); assert.equal(scif.form_version, "5/2022"); assert.ok(scif.rendered_document_id, "rendered through the Notice Registry"); assert.equal(scif.retention_class, "fnma_loan_file_life_plus_4y"); assert.equal(p.all_borrowers, true);
  const app = h.app(); assert.equal(app.borrowers.find((b) => b.id === "B")!.language_preference, "not_answered"); assert.equal(app.borrowers.find((b) => b.id === "A")!.homeownership_education!.completed_on, "2026-09-30");
  assert.equal(evaluateGate("21.1.scifPresentGate", gateFacts(app)).open, true); assert.doesNotThrow(() => assertGate("21.1.scifPresentGate", gateFacts(app)));
  assert.equal(h.timer("SM_O21_SCIF_PRESENT_GATE")!.status, "satisfied"); assert.equal(h.ofType("application.scif.presented").at(-1)!.payload.all_borrowers, true); assert.equal(h.ofType("application.scif.completed").length, 1, "only A's answered form completes");
  // the rendered Form 1103 carries the form's statements and passes its checklist (English edition; blank language answer)
  const v = noticeReg.activeVersion(SCIF_TEMPLATE, D("2026-10-19"))!; const rendered = render(v.source, SCIF_SAMPLE); const chk = evaluateChecklist(v, SCIF_SAMPLE, rendered);
  assert.equal(chk.passed, true, JSON.stringify(chk.blocking)); assert.match(rendered.text, /Your loan transaction is likely to be conducted in English\./); assert.match(rendered.text, /Your answer will NOT negatively affect your mortgage application/); assert.match(rendered.text, /not answered/);
  assert.equal(evaluateChecklist(v, { ...SCIF_SAMPLE, education: { completed: true, format_label: "Completed Web-Based Workshop" } }, render(v.source, { ...SCIF_SAMPLE, education: { completed: true, format_label: "Completed Web-Based Workshop" } })).passed, false, "a completed education answer without agency/date is a block");
  // B2-2-06 / SFC 184 on the purchase fixture: education required (HomeReady, all FTHB) and satisfied by A's 2026-09-30 completion; no counseling credit (education is not counseling)
  const ed = educationAndCounseling({ purchase: true, homeready: true, all_first_time_buyers: true, ltv_over_95: false, no_tradeline_du: false, education: app.borrowers[0]!.homeownership_education, counseling: null, closing_on: D("2026-11-18") });
  assert.deepEqual([ed.education_required, ed.education_satisfied, ed.sfc_184_counseling_credit, ed.counseling_window_start], [true, true, false, "2025-11-18"]);
});

test("21.1-T7: Given `ai_intake_mode='assisted'` and no MLO of record assigned, when the agent attempts to display a specific rate/fee scenario, then the `SAFE_1008_103_MLO_OF_RECORD_GATE` prevents the `particular_terms_presented` utterance and the agent falls back to general explanations; once the MLO is assigned and approves at 14:02 on Oct 5, the scenario displays with the MLO attribution.", async () => {
  const h = harness("APP-REFI-1", "2026-10-05T17:16:00.000Z"); h.started();
  const app0 = receiveApplication(h.events, refi(), { at: "2026-10-05T17:16:00.000Z", transaction_type: "limited_cash_out", occupancy: "primary", identity_verified: true }).app; h.rt.store.put("applications", "APP-REFI-1", app0 as unknown as Record<string, unknown>, INTAKE, h.clock.now());
  assert.equal(app0.ai_intake_mode, "assisted"); assert.equal(h.timer(SAFE_GATE)!.status, "armed");
  // 10:45 MST: the indicative quote (6.125 %, 30-year fixed) would be a particular-terms screen — no MLO of record: blocked, general explanation instead
  h.at("2026-10-05T17:45:00.000Z"); const blocked = await h.run("logSafeActivity", { utterance_id: "utt-0045", classification: "particular_terms_presented", loan_amount_cents: 56_000_000n, rate_pct: "6.125", term_months: 360 });
  assert.equal(blocked.presented, false); assert.equal(blocked.gate, SAFE_GATE); assert.equal(blocked.fallback, "general_explanation"); assert.equal(blocked.classification, "general_explanation"); assert.match(blocked.reason as string, /no MLO of record assigned/); assert.equal(blocked.quote, null);
  assert.equal(h.ofType("interview.utterance.blocked").length, 1); assert.equal(h.app().safe_activity_log.at(-1)!.presented_under_mlo_id, null);
  const perm = utterancePermission(app0, "particular_terms_presented"); assert.equal(perm.allowed, false); assert.equal(utterancePermission(app0, "general_explanation").allowed, true); assert.equal(utterancePermission(app0, "data_capture").allowed, true);
  await refused(h.run("logSafeActivity", { utterance_id: "utt-0046", classification: "underwriting_communication" }), "NEVER_STATE_QUALIFICATION"); await refused(h.run("logSafeActivity", { utterance_id: "utt-0047", classification: "negotiation" }), "NO_NEGOTIATION");
  // MLO of record assigned (AZ-licensed, active, lowest queue) → still closed: the stage-application review is pending
  const a = await h.run("assignMLO", { roster: ROSTER }); assert.deepEqual([a.mlo_of_record_id, a.nmlsr_id, a.mlo_review_state], ["u-mlo-az", "1234567", "pending"]);
  assert.match(evaluateGate("21.1.mloOfRecordGate", gateFacts(h.app())).reason!, /pending, not approved/);
  h.at("2026-10-05T18:06:00.000Z"); const esc = await h.run("openEscalation", { kind: "mlo_of_record", stage: "application", package_document_id: "doc-pkg-1" });
  assert.equal(esc.owner_role, "mlo_of_record"); assert.equal(esc.sla_due, "2026-10-06"); assert.equal(h.timer("SM_O21_MLO_REVIEW_SLA_1BD")!.dueDate, "2026-10-06");
  // the agent may not approve its own package; the MLO of record approves at 14:02 MST
  await refused(h.run("openEscalation", { op: "decide", escalation_id: esc.escalation_id, decision: "approved" }), "MLO_DECIDES_REVIEW");
  h.at("2026-10-05T21:02:00.000Z"); const dec = await h.run("openEscalation", { op: "decide", escalation_id: esc.escalation_id, decision: "approved" }, MLO);
  assert.equal(dec.mlo_review_state, "approved"); assert.equal(h.ofType("application.mlo.approved")[0]!.payload.stage, "application"); assert.equal(h.ofType("application.mlo.approved")[0]!.occurredAt, "2026-10-05T21:02:00.000Z");
  assert.equal(h.timer(SAFE_GATE)!.status, "satisfied"); assert.equal(h.timer("SM_O21_MLO_REVIEW_SLA_1BD")!.status, "satisfied"); assert.equal(h.escalations.list()[0]!.status, "completed");
  assert.equal(evaluateGate("21.1.mloOfRecordGate", gateFacts(h.app())).open, true);
  // the scenario displays with the MLO attribution and is logged as particular_terms_presented under the MLO id; P&I on $560,000 at 6.125 % is $3,402.62
  h.at("2026-10-05T21:05:00.000Z"); const shown = await h.run("logSafeActivity", { utterance_id: "utt-0090", classification: "particular_terms_presented", loan_amount_cents: 56_000_000n, rate_pct: "6.125", term_months: 360 });
  assert.equal(shown.presented, true); assert.equal(shown.classification, "particular_terms_presented"); assert.equal(shown.presented_under_mlo_id, "u-mlo-az");
  assert.deepEqual(shown.attribution, { mlo_name: "M. Originator", nmlsr_id: "1234567", text: "Estimates prepared for M. Originator, NMLS #1234567, who will review your Loan Estimate." });
  assert.deepEqual(shown.quote, { pi_cents: 340_262n, rate_pct: "6.125", term_months: 360 });
  const logged = h.ofType("safe_activity.logged").at(-1)!; assert.equal(logged.payload.presented_under_mlo_id, "u-mlo-az"); assert.equal(logged.payload.nmlsr_id, "1234567"); assert.equal(logged.payload.flag_mode, "assisted");
  // supervised_present shows nothing until the MLO approves the scenario; autonomous needs 31.1's written legal position
  const sup = { ...h.app(), ai_intake_mode: "supervised_present" as const }; assert.equal(utterancePermission(sup, "particular_terms_presented").allowed, false); assert.equal(utterancePermission(sup, "particular_terms_presented", { scenario_approved_by_mlo: true }).allowed, true);
  const auto = { ...h.app(), ai_intake_mode: "autonomous" as const }; assert.match(utterancePermission(auto, "particular_terms_presented").reason!, /written legal position/); assert.equal(utterancePermission(auto, "particular_terms_presented", { written_legal_position: true }).allowed, true);
});

test("21.1-T8: Given an application-stage escalation opened Fri Oct 9, 2026 at 16:00, when no MLO decision exists by end of creditor day Tue Oct 13, 2026 (Mon Oct 12 is a federal holiday and the calendar `creditor` marks it closed), then `SM_O21_MLO_REVIEW_SLA_1BD` breaches, the package is reassigned, and an `escalations` sev-2 row exists.", () => {
  const h = harness("APP-REFI-1", "2026-10-09T23:00:00.000Z"); h.started();
  let app = receivedRefi(h.events, refi({ started_at: "2026-10-09T22:30:00.000Z" }));
  assert.equal(creditor.isBusinessDay(D("2026-10-12")), false, "Columbus Day: creditor offices closed"); assert.equal(creditor.isBusinessDay(D("2026-10-13")), true);
  // Fri Oct 9 16:00 MST → +1 business_days_creditor skips Sat, Sun and Mon Oct 12 → due Tue Oct 13 end of creditor day
  const opened = openMloReview(h.events, h.escalations, app, { stage: "application", opened_at: "2026-10-09T23:00:00.000Z", package_document_id: "doc-pkg-2" }); app = opened.app;
  assert.equal(opened.sla_due, "2026-10-13"); assert.deepEqual([opened.event.payload.role, opened.event.payload.stage, opened.event.payload.state], ["mlo_of_record", "application", "AZ"]);
  const sla = h.timer("SM_O21_MLO_REVIEW_SLA_1BD")!; assert.equal(sla.dueDate, "2026-10-13"); assert.equal(sla.anchorDate, "2026-10-09"); assert.equal(sla.status, "armed"); assert.equal(sla.applicationId, "APP-REFI-1");
  // mid-day Tue Oct 13: not yet; end of the creditor day: breached (sev 2, escalate to the next licensed MLO; sev 1 to the partner officer at +2)
  assert.deepEqual(h.timers.evaluate("2026-10-13T16:00:00.000Z"), []); assert.equal(sla.status, "armed");
  const breaches = h.timers.evaluate("2026-10-14T03:59:00.000Z"); assert.equal(breaches.length, 1); assert.equal(breaches[0]!.instance.code, "SM_O21_MLO_REVIEW_SLA_1BD"); assert.equal(breaches[0]!.severity, 2); assert.deepEqual(breaches[0]!.escalateTo, ["officer"]); assert.equal(sla.status, "breached");
  assert.equal(h.ofType("timer.breached")[0]!.payload.severity, 2);
  // the breach handler: sev-2 escalations row + reassignment to the next AZ-licensed MLO with the new NMLSR ID; a fresh stage review opens (new SLA instance)
  // the morning sweep Wed Oct 14 (09:00 ET) reassigns; the new SLA anchors on that day → due Thu Oct 15
  const r = handleMloSlaBreach(h.events, h.escalations, app, { roster: ROSTER, at: "2026-10-14T13:00:00.000Z", timer_id: sla.id }); app = r.app;
  assert.equal(r.sev2.kind, "sev2"); assert.equal(r.sev2.severity, "2"); assert.equal(r.sev2.applicationId, "APP-REFI-1"); assert.equal(r.sev2.slaTimerId, sla.id); assert.equal(r.sev2.payload.timer_code, "SM_O21_MLO_REVIEW_SLA_1BD");
  assert.ok(h.escalations.list().some((e) => e.kind === "sev2" && e.severity === "2"), "an escalations sev-2 row exists");
  assert.deepEqual([r.reassigned.previous, r.reassigned.mlo.mlo_id, r.reassigned.mlo.nmlsr_id], ["u-mlo-az", "u-mlo-az2", "7654321"]); assert.equal(app.mlo_nmlsr_id, "7654321"); assert.equal(app.mlo_review_state, "pending");
  assert.equal(app.mlo_reviews[0]!.decision, "reassigned"); assert.equal(app.mlo_reviews[1]!.mlo_of_record_id, "u-mlo-az2"); assert.equal(app.mlo_reviews[1]!.decision, null);
  assert.equal(h.ofType("application.mlo_of_record.reassigned")[0]!.payload.reason, "sla_breach"); assert.equal(h.ofType("escalation.opened").length, 2);
  assert.equal(h.timers.byCode("SM_O21_MLO_REVIEW_SLA_1BD").length, 2); assert.equal(h.timer("SM_O21_MLO_REVIEW_SLA_1BD")!.status, "armed"); assert.equal(h.timer("SM_O21_MLO_REVIEW_SLA_1BD")!.dueDate, "2026-10-15");
  assert.equal(sla.status, "breached", "a reassignment is not a decision on the breached package"); assert.equal(h.ofType("application.mlo.approved").length + h.ofType("application.mlo.returned").length, 0);
  // the new MLO's approval satisfies the new instance and opens the SAFE gate with the new NMLSR ID
  const dec = decideMloReview(h.events, app, { escalation_id: app.mlo_reviews[1]!.escalation_id, decision: "approved", decided_at: "2026-10-14T16:00:00.000Z", by: { kind: "human", id: "u-mlo-az2", role: "mlo_of_record" } });
  assert.equal(h.timer("SM_O21_MLO_REVIEW_SLA_1BD")!.status, "satisfied"); assert.equal(mloOfRecordGate(gateFacts(dec.app)).open, true);
  assert.throws(() => decideMloReview(h.events, app, { escalation_id: app.mlo_reviews[1]!.escalation_id, decision: "approved", decided_at: "2026-10-14T16:00:00.000Z", by: INTAKE }), /decided by the mlo_of_record/);
});

test("21.1-T9: Given a `started` application with last activity Mon Oct 5, 2026 and no `received` transition, when the sweep runs on Wed Nov 4, 2026, then the application is `abandoned` and purged per the pre-application retention rule; the same file with `received` set is retained 25 months.", () => {
  const h = harness("APP-REFI-1", "2026-10-05T17:14:00.000Z"); h.started();
  const app = startInterview(h.events, refi(), { session_id: "S-1", started_at: "2026-10-05T17:14:00.000Z", model_version: "intake-2026.09", prompt_version: "p-1.4" }).app;
  assert.equal(app.status, "started"); assert.equal(app.application_received_at, null); assert.equal(civilDate(app.last_activity_at, app.creditor_time_zone), "2026-10-05"); assert.equal(app.abandon_at, "2026-11-04"); assert.equal(INTAKE_ABANDON_DAYS, 30);
  // the registry clock: application.started + 30 calendar days = Wed Nov 4; the sweep at the end of that day breaches it
  const t = h.timer("SM_O21_INTAKE_ABANDON_30")!; assert.equal(t.dueDate, "2026-11-04"); assert.deepEqual(h.timers.evaluate("2026-11-04T12:00:00.000Z"), []);
  assert.equal(h.timers.evaluate("2026-11-05T04:59:00.000Z")[0]!.instance.code, "SM_O21_INTAKE_ABANDON_30"); assert.equal(t.status, "breached");
  // the sweep's decision on Nov 3 (not yet) and Nov 4 (abandoned; never received → purged under the pre-application retention rule)
  assert.equal(abandonDecision(app, D("2026-11-03")).abandon, false);
  const d = abandonDecision(app, D("2026-11-04")); assert.deepEqual([d.abandon, d.purge, d.retain_until, d.abandon_at], [true, true, null, "2026-11-04"]);
  const swept = abandonSweep(h.events, app, D("2026-11-04"), "2026-11-05T04:59:00.000Z");
  assert.equal(swept.app.status, "abandoned"); assert.equal(swept.app.retention_class, "pre_application_purge"); assert.deepEqual([swept.event!.payload.purge, swept.event!.payload.was_received, swept.event!.payload.retain_until], [true, false, null]); assert.equal(swept.event!.type, "application.abandoned");
  assert.equal(abandonSweep(h.events, swept.app, D("2026-12-01"), "2026-12-01T05:00:00.000Z").event, null, "abandoning is idempotent");
  // the same file with `received` set (Oct 5) is retained 25 months from the application date: through 2028-11-05 (Reg B §1002.12(b))
  const received = receiveApplication(h.events, app, { at: "2026-10-05T17:16:00.000Z", transaction_type: "limited_cash_out", occupancy: "primary", identity_verified: true }).app;
  const dr = abandonDecision(received, D("2026-11-04")); assert.deepEqual([dr.abandon, dr.purge, dr.retain_until], [true, false, addMonths(D("2026-10-05"), REGB_RETENTION_MONTHS)]); assert.equal(dr.retain_until, "2028-11-05");
  const sweptReceived = abandonSweep(h.events, received, D("2026-11-04"), "2026-11-05T04:59:00.000Z"); assert.equal(sweptReceived.app.retention_class, "regb_25m"); assert.equal(sweptReceived.event!.payload.retain_until, "2028-11-05");
  // borrower activity re-anchors the clock; after trid_received an inactive file is 21.6's path, never abandoned
  const active = captureSixItem(h.events, received, { item: "ssn", value: "123-45-6789", at: "2026-10-20T17:00:00.000Z" }).app; assert.equal(active.abandon_at, "2026-11-19"); assert.equal(abandonDecision(active, D("2026-11-04")).abandon, false);
  const trid = { ...active, trid_received_at: "2026-10-20T17:41:00.000Z" }; assert.equal(abandonDecision(trid, D("2027-01-01")).abandon, false); assert.match(abandonDecision(trid, D("2027-01-01")).reason, /21\.6/);
});

test("21.1-T10: Given the interview transcript contains the agent asking about childbearing plans, when `compliance-sentinel` scans, then a sev-1 escalation is opened and the prompt version is quarantined.", async () => {
  const transcript = [
    { utterance_id: "utt-0010", speaker: "agent" as const, text: "What is your monthly income from your employer?" },
    { utterance_id: "utt-0011", speaker: "borrower" as const, text: "About $14,800; we may have children next year so it could change." },
    { utterance_id: "utt-0012", speaker: "agent" as const, text: "Are you planning to have children in the next few years?" },
    { utterance_id: "utt-0020", speaker: "agent" as const, text: "Federal law requires this information: what is your ethnicity? You may decline.", monitoring_section: true },
  ];
  const scan = scanTranscript(transcript, "p-1.4");
  assert.equal(scan.findings.length, 1); assert.deepEqual([scan.findings[0]!.utterance_id, scan.findings[0]!.code, scan.findings[0]!.citation], ["utt-0012", "childbearing", "§1002.5(d)(3)"]); assert.equal(scan.severity, 1); assert.equal(scan.quarantine_prompt_version, "p-1.4");
  assert.equal(scanTranscript(transcript.filter((u) => u.utterance_id !== "utt-0012"), "p-1.4").severity, null, "the borrower's own remark and the Section 8 monitoring question are not findings");
  // the sentinel's report: sev-1 escalation to compliance, the transcript finding and the prompt quarantine on the event log
  const events = memStore(); const escalations = new EscalationService(events, new FixedClock("2026-10-05T18:30:00.000Z"));
  const app = startInterview(events, refi(), { session_id: "S-1", started_at: "2026-10-05T17:14:00.000Z", model_version: "intake-2026.09", prompt_version: "p-1.4" }).app;
  const r = reportProhibitedInquiry(events, escalations, app, scan, "S-1", "2026-10-05T18:30:00.000Z");
  assert.equal(r.escalation!.kind, "sev1"); assert.equal(r.escalation!.severity, "1"); assert.equal(r.escalation!.ownerRole, "compliance"); assert.equal(r.escalation!.applicationId, "APP-REFI-1"); assert.equal(r.escalation!.payload.prompt_version, "p-1.4"); assert.equal(r.escalation!.openedBy, "agent:compliance-sentinel");
  assert.deepEqual(r.events.map((e) => e.type), ["interview.prohibited_inquiry.detected", "prompt.version.quarantined"]); assert.equal(r.events[1]!.payload.prompt_version, "p-1.4"); assert.equal(r.events[1]!.payload.escalation_id, r.escalation!.id);
  // through the bus (openEscalation op=compliance_scan) and the interview-time guardrail on the same question
  const h = harness("APP-REFI-1", "2026-10-05T18:30:00.000Z"); h.rt.store.put("applications", "APP-REFI-1", app as unknown as Record<string, unknown>, INTAKE, h.clock.now());
  const out = await h.run("openEscalation", { op: "compliance_scan", session_id: "S-1", transcript });
  assert.equal(out.severity, 1); assert.equal(out.quarantined_prompt_version, "p-1.4"); assert.equal(h.escalations.list()[0]!.kind, "sev1"); assert.equal(h.ofType("prompt.version.quarantined").length, 1);
  await refused(h.run("captureField", { field: "childbearing_plans", value: "yes" }), "REGB_1002_5_PROHIBITED_INQUIRY"); await refused(h.run("captureField", { field: "dependents_count", question: "Do you plan to have more children?", value: 2 }), "REGB_1002_5_PROHIBITED_INQUIRY");
  await refused(h.run("captureField", { field: "religion", value: "x" }), "REGB_1002_5_PROHIBITED_INQUIRY");
});

test("21.1-T11: Given an Arizona married applicant applying individually, when the 1003 is rendered, then the spouse appears only as `non_borrowing_spouse` for the security instrument and no credit data are requested from the spouse.", () => {
  const events = memStore(); let app = receivedRefi(events);
  const s = nonBorrowingSpouse(events, app, { applicant_id: "B1", spouse_id: "S1", spouse_name: "S. Spouse", at: "2026-10-05T17:20:00.000Z" }); app = s.app;
  assert.equal(s.required, true, "AZ is a community-property state (§1002.7(d)(4))"); assert.equal(s.spouse!.borrower_role, "non_borrowing_spouse"); assert.equal(s.spouse!.credit_requested, false);
  assert.equal(s.event!.payload.joint_intent_required, false, "a security-instrument signer never arms SM_O21_JOINT_INTENT_GATE"); assert.equal(s.event!.payload.credit_requested, false);
  // the rendered 1003: one Borrower Information form; the spouse appears only for the deed of trust; Section 9 carries the MLO of record
  const f = renderForm1003(app);
  assert.equal(f.urla_form_version, "1/2021"); assert.equal(f.ulad_version, "MISMO 3.4 B324"); assert.deepEqual(f.borrowers.map((b) => [b.id, b.form, b.credit_requested]), [["B1", "borrower_information", true]]);
  assert.deepEqual(f.non_borrowing_spouses, [{ id: "S1", legal_name: "S. Spouse", instrument: "security_instrument_only", note_signer: false, credit_data_requested: false }]);
  assert.deepEqual(f.section_9_loan_originator, { organization: "Partner Bank", organization_nmlsr_id: "123456", originator_name: "M. Originator", originator_nmlsr_id: "1234567" }); assert.match(f.data_hash, /^[0-9a-f]{64}$/);
  // no credit data, SCIF, demographics, joint intent or signature are ever requested from the spouse; the gates count applicants only
  assert.throws(() => askDemographics(events, app, "S1", { collection_method: "telephone", declined_race: true, collected_at: "2026-10-05T17:50:00.000Z" }), /not an applicant/);
  assert.throws(() => affirmJointIntent(events, app, { borrower_id: "S1", method: "voice_attestation_recorded", evidence_id: "x", at: "2026-10-05T17:50:00.000Z" }), /not a joint applicant/);
  assert.throws(() => presentScif(events, app, "S1", { presented_at: "2026-10-05T17:52:00.000Z" }), /no SCIF/);
  assert.throws(() => requestESign(events, app, { borrower_id: "S1", document_id: f.document_id, data_hash: f.data_hash, signed_at: "2026-10-05T18:05:00.000Z", consent: { status: "active", classes: ["application_documents"] }, accuracy_attestation_id: "att-S1", audit: {} }), /security instrument only/);
  assert.deepEqual(gateFacts(app).borrowers, [{ id: "B1", scif_presented_at: null, demographics_collected: false, joint_intent_affirmed_at: null, added_at: "2026-10-05T17:14:00.000Z" }]);
  assert.equal(scifPresentGate(gateFacts(app)).reason, "Form 1103 SCIF not presented to borrower(s) B1 (LL-2022-03; B2-2-06) — du.submit blocked");
  // an Ohio (common-law) married applicant applying individually has no non-borrowing spouse record; an AZ applicant with a co-borrower needs none either
  const oh = receiveApplication(events, refi({ id: "APP-OH", property_state: "OH" }), { at: "2026-10-05T17:16:00.000Z", transaction_type: "limited_cash_out", occupancy: "primary", identity_verified: true }).app;
  assert.equal(nonBorrowingSpouse(events, oh, { applicant_id: "B1", spouse_id: "S1", spouse_name: "S. Spouse", at: "2026-10-05T17:20:00.000Z" }).required, false);
  assert.throws(() => renderForm1003(refi()), /Section 9 needs the MLO of record/);
});

test("21.1-T12: Given the MLO of record's NMLS status changes to \"inactive\" on Wed Oct 7, 2026, when the nightly feed loads, then the gate closes, the LE issuance in 21.2 is blocked until reassignment, and the reassignment is logged with the new NMLSR ID before any LE renders.", async () => {
  const h = harness("APP-REFI-1", "2026-10-05T17:16:00.000Z"); h.started();
  let app = receivedRefi(h.events, refi()); const opened = openMloReview(h.events, h.escalations, app, { opened_at: "2026-10-05T18:06:00.000Z" });
  app = decideMloReview(h.events, opened.app, { escalation_id: opened.escalation.id, decision: "approved", decided_at: "2026-10-05T21:02:00.000Z", by: MLO }).app;
  assert.equal(mloOfRecordGate(gateFacts(app)).open, true); assert.equal(app.mlo_nmlsr_id, "1234567"); h.rt.store.put("applications", "APP-REFI-1", app as unknown as Record<string, unknown>, INTAKE, h.clock.now());
  // Wed Oct 7 nightly feed: 1234567 inactive → the gate closes; 21.2's issueLE is refused under the stale NMLSR ID
  h.at("2026-10-08T07:00:00.000Z"); const fed = await h.run("assignMLO", { op: "nmls_feed", feed: [{ nmlsr_id: "1234567", status: "inactive" }, { nmlsr_id: "7654321", status: "active" }] });
  assert.deepEqual([fed.changed, fed.gate_open, fed.nmls_status], [true, false, "inactive"]);
  const changed = h.ofType("application.mlo_of_record.status_changed")[0]!; assert.equal(changed.payload.status, "inactive"); assert.equal(changed.payload.gate_open, false); assert.deepEqual(changed.payload.blocks, ["issueLE", "executeLock", "particular_terms_presented"]); assert.equal(changed.actor.id, "nmls-feed");
  const closed = evaluateGate("21.1.mloOfRecordGate", gateFacts(h.app())); assert.equal(closed.open, false); assert.match(closed.reason!, /NMLS status is inactive/);
  assert.throws(() => assertGate("21.1.mloOfRecordGate", gateFacts(h.app())), (e: unknown) => e instanceof GateClosed && e.ref === "21.1.mloOfRecordGate");
  assert.equal(utterancePermission(h.app(), "particular_terms_presented").allowed, false, "assisted mode: particular terms blocked too");
  assert.equal(loadNmlsFeed(h.events, h.app(), [{ nmlsr_id: "1234567", status: "inactive" }], "2026-10-09T07:00:00.000Z").changed, false, "an unchanged status is not re-logged");
  // reassignment: the new NMLSR ID is logged (application.mlo_of_record.reassigned) and the new MLO's stage review opens; still blocked until that approval
  h.at("2026-10-08T15:00:00.000Z"); const re = await h.run("assignMLO", { op: "reassign", roster: ROSTER.map((m) => (m.nmlsr_id === "1234567" ? { ...m, nmls_status: "inactive" as const } : m)), reason: "nmls_inactive" });
  assert.deepEqual([re.previous_mlo_of_record_id, re.mlo_of_record_id, re.nmlsr_id], ["u-mlo-az", "u-mlo-az2", "7654321"]);
  const logged = h.ofType("application.mlo_of_record.reassigned")[0]!; assert.deepEqual([logged.payload.previous_mlo_of_record_id, logged.payload.nmlsr_id, logged.payload.reason], ["u-mlo-az", "7654321", "nmls_inactive"]);
  assert.equal(h.ofType("application.initial_1003.rendered").length, 0, "no 1003/LE rendered before the reassignment is logged"); assert.equal(evaluateGate("21.1.mloOfRecordGate", gateFacts(h.app())).open, false);
  const review = h.app().mlo_reviews.at(-1)!; assert.equal(review.mlo_of_record_id, "u-mlo-az2"); assert.equal(review.decision, null); assert.equal(h.app().mlo_reviews[0]!.decision, "approved", "the earlier approval stays on the record; the stale NMLSR ID no longer opens the gate");
  h.at("2026-10-08T16:00:00.000Z"); await h.run("openEscalation", { op: "decide", escalation_id: review.escalation_id, decision: "approved" }, { kind: "human", id: "u-mlo-az2", role: "mlo_of_record" });
  assert.equal(evaluateGate("21.1.mloOfRecordGate", gateFacts(h.app())).open, true);
  // the 1003 (and the LE that flows from it) now renders under the new NMLSR ID; events after the reassignment carry it
  const form = await h.run("renderForm1003", {}); assert.deepEqual((form.section_9_loan_originator as { originator_nmlsr_id: string; originator_name: string }), { organization: "Partner Bank", organization_nmlsr_id: "123456", originator_name: "N. Second", originator_nmlsr_id: "7654321" } as unknown as { originator_nmlsr_id: string; originator_name: string });
  const seq = h.events.all().map((e) => e.type); assert.ok(seq.indexOf("application.mlo_of_record.reassigned") < seq.indexOf("application.initial_1003.rendered")); assert.equal(h.ofType("application.initial_1003.rendered")[0]!.payload.originator_nmlsr_id, "7654321");
  assert.equal(h.app().mlo_nmlsr_id, "7654321"); assert.ok(MLO_OH.role === "mlo_of_record");
});

test("21.1 worked figures: $560,000 at 6.125 % / 360 → P&I $3,402.62 (half-up from 3,402.619; the brief's $3,402.63 is one cent high); LE due Thu Oct 8 (refi) and Thu Oct 22 (purchase); SLA due Tue Oct 6; SFC 184 window", () => {
  // Worked example 1: P&I = 560,000 × 0.0051041667 ÷ (1 − 1.0051041667^−360) = 3,402.619… → $3,402.62 half-up
  const q = indicativeQuotePayment(56_000_000n, "6.125", 360);
  assert.equal(q.pi_cents, 340_262n); assert.equal(q.rate_pct, "6.125"); assert.equal(q.term_months, 360);
  assert.notEqual(q.pi_cents, 340_263n, "the brief's $3,402.63 is off by one cent (spec 21.1 worked example 1; verification report)");
  assert.throws(() => indicativeQuotePayment(0n, "6.125", 360), RangeError);
  // trid_received Mon Oct 5 10:41 MST → LE due Thu Oct 8 (Tue 6, Wed 7, Thu 8 business_days_creditor); purchase Mon Oct 19 20:44 EDT → Thu Oct 22
  assert.equal(leDueDate(D("2026-10-05")), "2026-10-08"); assert.equal(leDueDate(civilDate("2026-10-20T00:44:00.000Z", "America/New_York")), "2026-10-22"); assert.equal(civilDate("2026-10-20T00:44:00.000Z", "America/New_York"), "2026-10-19");
  // stage-application escalation 11:06 MST Oct 5 → SLA due Tue Oct 6 end of creditor day; MLO approves 14:02 the same day
  const events = memStore(); const esc = new EscalationService(events, new FixedClock("2026-10-05T18:06:00.000Z")); const app = receivedRefi(events);
  const opened = openMloReview(events, esc, app, { opened_at: "2026-10-05T18:06:00.000Z" }); assert.equal(opened.sla_due, "2026-10-06");
  const dec = decideMloReview(events, opened.app, { escalation_id: opened.escalation.id, decision: "approved", decided_at: "2026-10-05T21:02:00.000Z", by: MLO }); assert.equal(dec.review.decided_at, "2026-10-05T21:02:00.000Z"); assert.equal(mloOfRecordGate(gateFacts(dec.app)).open, true);
  // Worked example 2 (OH purchase, MLO approves Tue Oct 20 09:10 EDT inside the SLA due Tue Oct 20): the review opened Mon Oct 19 20:44 EDT
  const oh = new EscalationService(events, new FixedClock("2026-10-20T00:44:00.000Z")); const p = assignMlo(events, receiveApplication(events, purchase(), { at: "2026-10-19T22:41:00.000Z", transaction_type: "purchase", occupancy: "primary", identity_verified: true }).app, { roster: ROSTER, at: "2026-10-19T22:41:00.000Z" });
  assert.equal(p.mlo.nmlsr_id, "2345678"); const ohReview = openMloReview(events, oh, p.app, { opened_at: "2026-10-20T00:44:00.000Z" }); assert.equal(ohReview.sla_due, "2026-10-20");
  const ohDec = decideMloReview(events, ohReview.app, { escalation_id: ohReview.escalation.id, decision: "approved", decided_at: "2026-10-20T13:10:00.000Z", by: MLO_OH }); assert.ok(civilDate(ohDec.review.decided_at!, "America/New_York") <= ohReview.sla_due, "inside the SLA");
  // SFC 184: counseling within the 12 months before the Nov 18 closing (on/after Nov 18, 2025) — A's item is education, so no credit; a counseling completion on 2026-06-01 would earn it
  const noCredit = educationAndCounseling({ purchase: true, homeready: true, all_first_time_buyers: true, ltv_over_95: false, no_tradeline_du: false, education: { completed: true, format: "completed_web_based_workshop", agency_hud_id: "80123", agency_name: null, completed_on: D("2026-09-30") }, counseling: null, closing_on: D("2026-11-18") });
  assert.equal(noCredit.sfc_184_counseling_credit, false); assert.equal(noCredit.counseling_window_start, "2025-11-18");
  assert.equal(educationAndCounseling({ purchase: true, homeready: true, all_first_time_buyers: true, ltv_over_95: false, no_tradeline_du: false, education: null, counseling: { completed: true, format: "internet", agency_hud_id: "80123", agency_name: null, completed_on: D("2026-06-01") }, closing_on: D("2026-11-18") }).sfc_184_counseling_credit, true);
  assert.equal(educationAndCounseling({ purchase: false, homeready: false, all_first_time_buyers: false, ltv_over_95: false, no_tradeline_du: false, education: null, counseling: null, closing_on: D("2026-11-12") }).education_required, false, "refinance: none required");
  // the AI disclosure precedes the first substantive question (10:14:07 before 10:16); the second borrower's own timestamps never re-anchor trid_received
  const d = discloseAi(events, startInterview(events, refi(), { session_id: "S-1", started_at: "2026-10-05T17:14:00.000Z", model_version: "m", prompt_version: "p" }).app, { session_id: "S-1", utterance_id: "utt-0001", at: "2026-10-05T17:14:07.000Z" });
  assert.equal(d.app.ai_disclosure_utterance_id, "utt-0001"); assert.equal(d.app.interview_sessions[0]!.ai_disclosure_given_at, "2026-10-05T17:14:07.000Z");
  const withB = addBorrower(events, { ...dec.app, trid_received_at: "2026-10-05T17:41:00.000Z", trid_application_date: D("2026-10-05"), status: "trid_received" }, { id: "B2", legal_name: "C. Borrower", borrower_role: "co_borrower", at: "2026-10-06T17:00:00.000Z" });
  assert.equal(detectSixItems(events, withB.app, "2026-10-06T17:00:00.000Z").emitted, false); assert.equal(withB.app.trid_received_at, "2026-10-05T17:41:00.000Z");
});
