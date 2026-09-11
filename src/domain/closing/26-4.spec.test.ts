// 26.4 Post-closing document collection, collateral perfection, and trailing documents (endorsements/allonges, assignments for non-MERS, MERS MOM registration and interim-funder designation, recorded security instrument, final title policy, note custody and shipping to warehouse/document custodian)
// spec/sections/26-closing-execution-documents-eclosing-ron-funding-and-post-cl/26-4-post-closing-document-collection-collateral-perfection-and-t.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_26_4 } from "../../app/tools/section26-4.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeMers } from "../../infra/integrations/mers.ts";
import { makeMin } from "../boarding/min.ts";
import { SM_ORG_ID, FANNIE_MAE_ORG_ID, PostClosingRefused, computeMersAnchor, validateRegistration, draftRegistration, registrationTimeliness, ensureEndorsement, endorsementText, decideAssignments, assignmentPopulationCheck, shipmentPlan, trailingDueAt, followupSchedule, reviewFinalPolicy, reviewRecordedInstrument, cureFor, insuredOk, nextBatchOn, type NoteEndorsement, type NoteFacts, type RecordedImageInput, type FinalPolicyInput, type FinalPolicyExpectations } from "./ops-26-4.ts";

const AGENT: Actor = { kind: "agent", id: "post-closing" };
const OFFICER: Actor = { kind: "human", id: "u-officer-partner", role: "officer" };
const SIGNING_OFFICER: Actor = { kind: "human", id: "u-so-partner", role: "signing_officer" };
const toolKey = (process: string, name: string): string => `${process} ${name}`;
const PARTNER_ORG = "1001234", PARTNER = "Partner Mortgage Bank, N.A.";
const MIN = makeMin(PARTNER_ORG, "98765");                 // 1001234-0000098765-<check digit> (worked example 1, illustrative)
const APP = "APP-REFI-1", PAPP = "APP-PURCH-1", TZ_AZ = "America/Phoenix", TZ_ET = "America/New_York";
/** Fixture instants: MST (UTC−7, no DST) for Phoenix, EST (UTC−5) for the Nov–Mar East-coast times. */
const mst = (date: string, hhmm: string): string => { const [h, m] = hhmm.split(":").map(Number) as [number, number]; return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h + 7, m)).toISOString(); };
const et = (date: string, hhmm: string): string => { const [h, m] = hhmm.split(":").map(Number) as [number, number]; return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h + 5, m)).toISOString(); };
/** Worked example 1 anchor input: refinance, Phoenix AZ (escrow state), note date Fri Nov 6, funding Thu Nov 12, 2026. */
const AZ_REFI = { transaction_type: "limited_cash_out", state: "AZ", escrow_state: true, note_date: "2026-11-06", funding_date: "2026-11-12" };
const OH_PURCHASE = { transaction_type: "purchase", state: "OH", escrow_state: false, note_date: "2026-11-18", funding_date: "2026-11-18" };
const NOTE: NoteFacts = { borrower_names: ["Alex Borrower", "Jamie Borrower"], note_date: D("2026-11-06"), note_amount_cents: 56_000_000n, property_address: "4321 N Central Ave, Phoenix, AZ 85012", property_state: "AZ", partner_legal_name: PARTNER };
/** Worked example 2: the allonge wet-signed by the signing_officer Wed Nov 4 and affixed by the escrow officer Fri Nov 6. */
const allonge = (o: Partial<NoteEndorsement> = {}): NoteEndorsement => ({ id: "END-1", closing_document_id: "DOC-NOTE-1", method: "allonge_pre_executed", endorsement_text: endorsementText(PARTNER), endorsee: "blank", signing_officer_party_id: "u-so-partner", signed_at: mst("2026-11-04", "10:00"), signature_kind: "wet", facsimile_authority: null, allonge_document_id: "DOC-ALLONGE-1",
  allonge_identifiers: { borrower_names: NOTE.borrower_names, note_date: D("2026-11-06"), note_amount_cents: 56_000_000n, property_address: NOTE.property_address }, note_references_allonge: true, affixed_by_party_id: "P-ESCROW-AZ-1", affixed_at: mst("2026-11-06", "15:10"), chain: [{ endorser: PARTNER, endorsee: "blank", at: mst("2026-11-04", "10:00") }], ...o });
const facsimile = (states: string[]): NoteEndorsement => allonge({ id: "END-FAX", method: "printed_facsimile", signature_kind: "facsimile", allonge_document_id: null, allonge_identifiers: null, note_references_allonge: false, affixed_at: null, affixed_by_party_id: null, facsimile_authority: { jurisdiction_opinion_states: states, board_resolution_document_id: "DOC-RES", corporate_secretary_certification_document_id: "DOC-SEC", notarized_facsimile_certification_document_id: "DOC-NFC" } });
const SHIPMENT = { shipment_id: "SHP-1", custody_record_id: "CR-1", from_party_id: "P-ESCROW-AZ-1", to_party_id: "P-FCC-1", to_role: "fcc_bailee", bailee_letter_id: "BL-1", carrier: "fedex", tracking_ref: "7489 1234 5678", contents: [{ document_kind: "note", closing_document_id: "DOC-NOTE-1", original: true }] };
/** Worked example 1 recorded image: 15 pages = 15, legal description hash equal, MIN + nominee paragraph, NMLSR block, RON notarial certificate, Maricopa, instrument number captured. */
const image = (o: Partial<RecordedImageInput> = {}): RecordedImageInput => ({ recording_id: "REC-1", trailing_document_id: `${APP}:recorded_security_instrument`, executed_document_id: "DOC-DOT-1", recorded_image_document_id: "DOC-DOT-REC-1", executed_pages: 15, executed_rider_count: 0, image_pages: 15, image_rider_count: 0, legal_description_hash_executed: "h-legal-1", legal_description_hash_image: "h-legal-1", names_vesting_match: true, min_on_page_1: true, mers_nominee_paragraph: true, nmlsr_block: true, notary: { venue: true, date: true, name: true, commission: true, seal: true }, ron: true, ron_statement: true, recording_stamp: true, instrument_number: "20261109-0412345", county_expected: "Maricopa", county_on_stamp: "Maricopa", signatures_initials_present: true, date_match: true, ...o });
/** Rule 7 fixture: 2021 ALTA Loan Policy for $560,000.00, partner ISAOA/ATIMA, Date of Policy Nov 9, 2026 10:12 MST, Schedule A = recordings, prior deed of trust removed, ALTA 8.1 issued. */
const policy = (o: Partial<FinalPolicyInput> = {}): FinalPolicyInput => ({ title_order_id: "TO-FINAL-1", trailing_document_id: `${APP}:final_title_policy`, policy_kind: "alta_2021_loan", policy_number: "AZ-2026-778899", date_of_policy: mst("2026-11-09", "10:12"), insured_text: `${PARTNER}, its successors and/or assigns as their interests may appear`, amount_cents: 56_000_000n, schedule_a: { vesting_match: true, legal_description_match: true, instrument_number: "20261109-0412345", recorded_on: D("2026-11-09") }, schedule_b: { expected_removed: ["prior deed of trust (paid)"], present: ["taxes not yet due and payable"], new_exceptions: [] }, endorsements_issued: ["ALTA 8.1"], creditors_rights_exclusion_present: false, ...o });
const POLICY_EXPECT: FinalPolicyExpectations = { partner_legal_name: PARTNER, original_principal_cents: 56_000_000n, recording: { instrument_number: "20261109-0412345", recorded_on: D("2026-11-09") }, required_endorsements: ["ALTA 8.1"], originated_on: D("2026-11-06") };

/** The 26.4 bus alone: TOOLS_26_4 bound to the `post-closing` agent over the overridden registry (26.4 rows), escalations, the shared MERS System fake (src/infra/integrations/mers.ts) and an entity store; the application-scoped unit of work stamps `applicationId` on every event so the origination clocks arm. */
function harness(applicationId: string, nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["26.4"] });
  const escalations = new EscalationService(events, clock); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const mers = new FakeMers();
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: {}, ports: { mers } };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const agents = new AgentRegistry(); const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_26_4) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(toolKey(d.process, d.name), cmd); }
  const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("26.4", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
  /** An upstream event as 26.2 / 26.3 / 27.1 / 25.3 append it, with origination context. */
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt: string, actor: Actor = { kind: "external", id: "platform" }) => events.append({ type, applicationId, actor, occurredAt, payload: { application_id: applicationId, ...payload } });
  const consummated = (o: Record<string, unknown> = {}) => upstream("closing.consummated", { closing_id: "CLS-1", consummation_at: mst("2026-11-06", "14:26"), consummation_on: "2026-11-06", note_date: "2026-11-06", anchor_date: null, tx_50a6: false, is_hpml: false, note_form: "enote", transaction_type: "limited_cash_out", state: "AZ", dry_state: true, ...o }, mst("2026-11-06", "14:26"), { kind: "agent", id: "title-closing" });
  const register = (o: Record<string, unknown> = {}) => run("registerMin", { min: MIN, partner_org_id: PARTNER_ORG, ...AZ_REFI, submitted_at: mst("2026-11-09", "18:00"), time_zone: TZ_AZ, ...o });
  /** The loan.funded-time expected set for the refinance fixture (eRecorded Mon Nov 9; funded Thu Nov 12; LTV 70; flood LOL on file). */
  const expectSet = (o: Record<string, unknown> = {}) => run("registerMin", { op: "expect_trailing_documents", funded_on: "2026-11-12", note_date: "2026-11-06", state: "AZ", note_form: "enote", ltv_pct: 70, flood_lol_on_file: true, recording: { channel: "erecording", recorded_on: "2026-11-09" }, at: mst("2026-11-12", "12:00"), ...o });
  return { clock, events, timers, escalations, rt, uow, run, at, timer, ofType, upstream, consummated, register, expectSet, decisions, mers };
}
type H = ReturnType<typeof harness>;
const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused ${code}, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
const domainRefused = (fn: () => unknown, code: string): PostClosingRefused => { try { fn(); } catch (e) { assert.ok(e instanceof PostClosingRefused, `expected PostClosingRefused ${code}, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected PostClosingRefused ${code}`); };
/** Worked example 2 paper-note shipment on the bus: prepared Mon Nov 9 (gate open), 26.2's `custody.paper_note.shipped` 15:40 MST, pickup scan 16:10 MST. */
async function shippedNote(h: H) {
  h.at(mst("2026-11-09", "09:15"));
  const p = await h.run("registerMin", { op: "prepare_shipment", shipment: SHIPMENT, address_on_closing_instructions: true, endorsement: allonge(), note: NOTE, time_zone: TZ_AZ, at: mst("2026-11-09", "09:15") });
  assert.equal(p.refusal, null);
  h.upstream("custody.paper_note.shipped", { closing_id: "CLS-1", tracking_ref: SHIPMENT.tracking_ref, shipped_at: mst("2026-11-09", "15:40"), shipped_on: "2026-11-09", from_party_id: SHIPMENT.from_party_id, to_custodian_party_id: SHIPMENT.to_party_id, on_time: true, note_form: "paper" }, mst("2026-11-09", "15:40"), { kind: "external", id: "P-ESCROW-AZ-1", role: "settlement_agent" });
  const pickup = await h.run("registerMin", { op: "track_shipment", shipment_id: "SHP-1", scan_kind: "pickup", scan_at: mst("2026-11-09", "16:10"), time_zone: TZ_AZ });
  return pickup;
}
test("26.4-T1: Given a refinance in Arizona (escrow state) with note date Fri Nov 6, 2026 and funding Thu Nov 12, when the MERS anchor is computed, then `anchor_kind = funding_date`, `registration_due_at` = Thu Nov 19, 2026, `policy_target_at` = Fri Nov 13, and `SM_O74_MOM_REGISTER_TARGET_1BD` is due Mon Nov 9; when the registration is accepted in the Nov 9 batch, then all three are satisfied; when it is first accepted Fri Nov 20, then `MERS_PROC_MOM_REGISTER_7` is breached (sev 1) even though `policy_target_at` breaches earlier.", async () => {
  // rule 1 / worked example 1: refinance in an escrow state anchors on the funding date (MERS Procedures Rel. 26.1); SM's policy target stays note date + 7
  const h = harness(APP, mst("2026-11-06", "12:00"));
  const a = await h.run("computeMersAnchor", AZ_REFI);
  assert.equal(a.anchor_kind, "funding_date"); assert.equal(a.anchor_date, "2026-11-12"); assert.equal(a.registration_due_at, "2026-11-19"); assert.equal(a.policy_target_at, "2026-11-13"); assert.equal(a.target_batch_on, "2026-11-09"); assert.equal(a.provisional, false);
  assert.ok(String(a.policy_target_at) < String(a.registration_due_at), "the policy target breaches before the MERS deadline");
  // 26.2's closing.consummated arms the 7-day clock and the next-batch policy target (Fri Nov 6 note date → Mon Nov 9; Sat/Sun no batch)
  h.consummated();
  const target = h.timer("SM_O74_MOM_REGISTER_TARGET_1BD")!; assert.equal(target.dueDate, D("2026-11-09")); assert.equal(target.status, "armed");
  const mers7 = h.timer("MERS_PROC_MOM_REGISTER_7")!; assert.equal(mers7.status, "armed");
  // registration accepted in the Mon Nov 9 18:00 MST batch: Servicer = Investor = partner, Subservicer = SM → all three satisfied
  h.at(mst("2026-11-09", "18:00")); const r = await h.register();
  assert.equal(r.accepted, true); assert.equal(r.batch_on, "2026-11-09"); assert.equal(r.status, "active");
  const t = r.timeliness as Record<string, unknown>; assert.equal(t.on_time, true); assert.equal(t.policy_target_met, true); assert.equal(t.target_batch_met, true);
  assert.equal(mers7.status, "satisfied"); assert.equal(target.status, "satisfied");
  const reg = h.ofType("mers.min.registered")[0]!; assert.equal(reg.payload.status, "active"); assert.equal(reg.payload.registration_kind, "mom"); assert.equal(reg.payload.investor_org_id, PARTNER_ORG); assert.equal(reg.payload.servicer_org_id, PARTNER_ORG); assert.equal(reg.payload.subservicer_org_id, SM_ORG_ID); assert.equal(reg.payload.interim_funder_org_id, null); assert.equal(reg.payload.registration_due_at, "2026-11-19");
  assert.equal(h.mers.registry.get(MIN)!.investorOrgId, PARTNER_ORG); assert.equal(h.mers.registry.get(MIN)!.subservicerOrgId, SM_ORG_ID);
  // first accepted Fri Nov 20: MERS_PROC_MOM_REGISTER_7 breached (sev 1 → officer) even though the Nov 13 policy target breached earlier
  const late = harness(APP, mst("2026-11-06", "12:00")); late.consummated();
  const breaches = late.timers.evaluate(mst("2026-11-20", "00:00"));
  const b7 = breaches.find((b) => b.def.code === "MERS_PROC_MOM_REGISTER_7")!; assert.equal(b7.severity, 1); assert.ok(b7.escalateTo.includes("officer")); assert.equal(late.timer("MERS_PROC_MOM_REGISTER_7")!.status, "breached");
  assert.equal(late.timer("SM_O74_MOM_REGISTER_TARGET_1BD")!.status, "breached");
  late.at(mst("2026-11-20", "18:00")); const lr = await late.register({ submitted_at: mst("2026-11-20", "18:00") });
  const lt = lr.timeliness as Record<string, unknown>; assert.equal(lt.on_time, false); assert.equal(lt.days_late, 1); assert.equal(lt.policy_target_met, false);
  assert.equal(late.timer("MERS_PROC_MOM_REGISTER_7")!.status, "satisfied_late");
  // the engine's instance anchors on the consummation day (26.2 sends anchor_date=null for refinances) — the SOR due date is the funding-date clock, recomputed for reporting
  assert.equal(registrationTimeliness({ registration_due_at: D("2026-11-19"), policy_target_at: D("2026-11-13"), target_batch_on: D("2026-11-09") }, D("2026-11-20")).on_time, false);
});
test("26.4-T2: Given a purchase in Ohio (non-escrow, wet) with note date Wed Nov 18, 2026, then `anchor_kind = note_date`, `registration_due_at` = Wed Nov 25, 2026; given the same loan in Maine with a Form 3749 assignment executed Nov 18, then `MERS_PROC_NON_MOM_REGISTER_7` is due Nov 25 and `registration_kind = non_mom_assignment`.", async () => {
  // purchase outside an escrow state: the note date is the anchor (Wed Nov 18 → Wed Nov 25)
  const h = harness(PAPP, et("2026-11-18", "12:00"));
  const a = await h.run("computeMersAnchor", OH_PURCHASE);
  assert.equal(a.anchor_kind, "note_date"); assert.equal(a.registration_due_at, "2026-11-25"); assert.equal(a.policy_target_at, "2026-11-25"); assert.equal(a.registration_kind, "mom");
  // the same loan in Maine: Form 3749 executed at closing by the signing_officer → non_mom_assignment anchored on the execution date
  const me = computeMersAnchor({ ...OH_PURCHASE, transaction_type: "purchase", state: "ME", assignment_executed_on: D("2026-11-18"), note_date: D("2026-11-18"), funding_date: D("2026-11-18") });
  assert.equal(me.registration_kind, "non_mom_assignment"); assert.equal(me.anchor_kind, "assignment_executed_date"); assert.equal(me.anchor_date, "2026-11-18"); assert.equal(me.registration_due_at, "2026-11-25");
  assert.throws(() => computeMersAnchor({ ...OH_PURCHASE, transaction_type: "purchase", state: "ME", note_date: D("2026-11-18"), funding_date: D("2026-11-18") }), RangeError, "Maine without an executed Form 3749 date");
  const ex = await h.run("registerMin", { op: "record_assignment", state: "ME", document_id: "DOC-3749-1", executed_at: et("2026-11-18", "11:05"), time_zone: TZ_ET, signing_officer_party_id: "u-so-partner" });
  assert.equal(ex.assignment_executed_on, "2026-11-18"); assert.equal(ex.registration_due_at, "2026-11-25");
  const t = h.timer("MERS_PROC_NON_MOM_REGISTER_7")!; assert.equal(t.dueDate, D("2026-11-25")); assert.equal(t.status, "armed");
  // registered in the Nov 18 batch with registration_kind = non_mom_assignment → the clock is satisfied by that conditioned event
  const MIN_ME = makeMin(PARTNER_ORG, "55501");
  const r = await h.run("registerMin", { min: MIN_ME, partner_org_id: PARTNER_ORG, ...OH_PURCHASE, state: "ME", assignment_executed_on: "2026-11-18", assignment_to_mers_document_id: "DOC-3749-1", submitted_at: et("2026-11-18", "18:00"), time_zone: TZ_ET });
  assert.equal(r.accepted, true); assert.equal((r.registration as Record<string, unknown>).registration_kind, "non_mom_assignment"); assert.equal((r.registration as Record<string, unknown>).anchor_kind, "assignment_executed_date");
  assert.equal(h.ofType("mers.min.registered")[0]!.payload.registration_kind, "non_mom_assignment"); assert.equal(t.status, "satisfied");
  // a MOM jurisdiction never records an assignment
  await assert.rejects(h.run("registerMin", { op: "record_assignment", state: "OH", document_id: "DOC-X", executed_at: et("2026-11-18", "11:05"), signing_officer_party_id: "u-so-partner" }), (e: unknown) => e instanceof PostClosingRefused && e.code === "NO_ASSIGNMENT_FOR_MOM");
});
test("26.4-T3: Given a registration payload, when it names any Investor other than the partner's Org ID before purchase, or names SM as Servicer, then `registerMin` refuses the submission; when `warehouse.advance.funded` occurs Thu Nov 12 at 09:40 ET, then Interim Funder = SM is submitted in the Nov 12 batch and `SM_O74_INTERIM_FUNDER_1BD` (due Fri Nov 13) is satisfied.", async () => {
  const h = harness(APP, mst("2026-11-09", "17:00")); h.consummated();
  // B8-7-01: Investor other than the partner before purchase → refused on the bus and in the rule
  await refused(h.register({ investor_org_id: FANNIE_MAE_ORG_ID }), "INVESTOR_NOT_PARTNER");
  await refused(h.register({ investor_org_id: "1007777" }), "INVESTOR_NOT_PARTNER");
  await refused(h.register({ servicer_org_id: SM_ORG_ID }), "SM_NEVER_SERVICER");
  const anchor = computeMersAnchor({ ...AZ_REFI, transaction_type: "limited_cash_out", note_date: D("2026-11-06"), funding_date: D("2026-11-12") });
  domainRefused(() => validateRegistration(draftRegistration({ min: MIN, application_id: APP, state: "AZ", anchor, partner_org_id: PARTNER_ORG, investor_org_id: SM_ORG_ID }), { partner_org_id: PARTNER_ORG }), "INVESTOR_NOT_PARTNER");
  domainRefused(() => validateRegistration(draftRegistration({ min: MIN, application_id: APP, state: "AZ", anchor, partner_org_id: PARTNER_ORG, servicer_org_id: SM_ORG_ID }), { partner_org_id: PARTNER_ORG }), "SERVICER_NOT_PARTNER");
  domainRefused(() => validateRegistration(draftRegistration({ min: makeMin("1009999", "1"), application_id: APP, state: "AZ", anchor, partner_org_id: PARTNER_ORG }), { partner_org_id: PARTNER_ORG }), "MIN_ORG_ID_NOT_PARTNER");
  domainRefused(() => validateRegistration(draftRegistration({ min: MIN.slice(0, 17) + String((Number(MIN[17]) + 1) % 10), application_id: APP, state: "AZ", anchor, partner_org_id: PARTNER_ORG }), { partner_org_id: PARTNER_ORG }), "MIN_CHECK_DIGIT");
  // after purchase the Investor is Fannie Mae (30.1 verifies the update)
  assert.equal(validateRegistration(draftRegistration({ min: MIN, application_id: APP, state: "AZ", anchor, partner_org_id: PARTNER_ORG, investor_org_id: FANNIE_MAE_ORG_ID }), { partner_org_id: PARTNER_ORG, purchased: true }).ok, true);
  assert.equal(h.ofType("mers.min.registered").length, 0, "nothing was submitted");
  // registered Mon Nov 9 without an advance; warehouse.advance.funded Thu Nov 12 09:40 ET (27.1) → Interim Funder = SM in the Nov 12 batch, due Fri Nov 13
  h.at(mst("2026-11-09", "18:00")); const r = await h.register(); assert.equal(r.accepted, true);
  h.upstream("warehouse.advance.funded", { advance_id: "adv-refi-1", note_form: "enote", wet: false, collateral_status: "secured_control", advance_date: "2026-11-12", value_date: "2026-11-12", interim_funder_anchor_date: "2026-11-12" }, et("2026-11-12", "09:40"), { kind: "agent", id: "warehouse" });
  const t = h.timer("SM_O74_INTERIM_FUNDER_1BD")!; assert.equal(t.dueDate, D("2026-11-13")); assert.equal(t.status, "armed");
  h.at(et("2026-11-12", "09:41"));
  const u = await h.run("registerMin", { op: "update_interim_funder", min: MIN, advance_id: "adv-refi-1", advance_funded_at: et("2026-11-12", "09:40"), advance_date: "2026-11-12", time_zone: TZ_ET });
  assert.equal(u.batch_on, "2026-11-12"); assert.equal(u.due_on, "2026-11-13"); assert.equal(u.on_time, true); assert.equal(u.interim_funder_org_id, SM_ORG_ID); assert.equal(u.already_set, false);
  const upd = h.ofType("mers.min.updated")[0]!; assert.equal(upd.payload.field, "interim_funder"); assert.equal(upd.payload.interim_funder_org_id, SM_ORG_ID); assert.equal(t.status, "satisfied");
  assert.equal(nextBatchOn(et("2026-11-12", "09:40"), TZ_ET), "2026-11-12"); assert.equal(nextBatchOn(et("2026-11-12", "18:05"), TZ_ET), "2026-11-13"); assert.equal(nextBatchOn(mst("2026-11-06", "18:10"), TZ_AZ), "2026-11-09");
  // the mers_registrations row carries the designation for 27.1's trackCollateral{op: interim_funder} check
  assert.equal(h.rt.store.get("mers_registrations", MIN)!.data.interim_funder_org_id, SM_ORG_ID);
});
test("26.4-T4: Given `endorsement_method = allonge_pre_executed` with an allonge whose note amount reads $560,000.00 and note date Nov 6, 2026, when the shipment is requested, then `SM_O74_ENDORSEMENT_BEFORE_SHIP_GATE` opens; given the allonge shows $565,000.00 (a re-drawn loan amount), then the gate refuses shipment and a replacement allonge escalation goes to `signing_officer`; given `printed_facsimile` in a state with no legal opinion in the authority file, then the gate refuses and the desk route is used.", async () => {
  // worked example 2: allonge pre-executed Nov 4 with identifiers matching the note ($560,000.00; Nov 6, 2026) → gate opens on the shipment request
  const h = harness(APP, mst("2026-11-09", "09:15"));
  const ok = await h.run("registerMin", { op: "prepare_shipment", shipment: SHIPMENT, address_on_closing_instructions: true, endorsement: allonge(), note: NOTE, time_zone: TZ_AZ, at: mst("2026-11-09", "09:15") });
  assert.equal(ok.refusal, null); assert.equal(ok.status, "prepared"); assert.equal(ok.to_role, "fcc_bailee"); assert.equal((ok.gate as Record<string, unknown>).open, true);
  const gate = h.timers.byCode("SM_O74_ENDORSEMENT_BEFORE_SHIP_GATE")[0]!; assert.equal(gate.status, "satisfied"); assert.equal(h.ofType("note.endorsed")[0]!.payload.method, "allonge_pre_executed");
  assert.equal(evaluateGate("26.4.endorsementBeforeShipGate", { endorsement: allonge(), note: { ...NOTE, note_amount_cents: "56000000" } }).open, true);
  // a re-drawn $565,000.00 on the allonge → the gate refuses shipment; replacement allonge escalation to the signing_officer; routed to the endorsement desk
  const bad = await h.run("registerMin", { op: "prepare_shipment", shipment: { ...SHIPMENT, shipment_id: "SHP-2" }, address_on_closing_instructions: true, endorsement: allonge({ id: "END-2", allonge_identifiers: { ...allonge().allonge_identifiers!, note_amount_cents: 56_500_000n } }), note: NOTE, time_zone: TZ_AZ, at: mst("2026-11-09", "09:20") });
  assert.match(String(bad.refusal), /SM_O74_ENDORSEMENT_BEFORE_SHIP_GATE closed/); assert.match(String(bad.refusal), /56500000 ≠ 56000000/); assert.equal(bad.to_role, "endorsement_desk"); assert.equal((bad.gate as Record<string, unknown>).escalation, "signing_officer");
  assert.equal(h.timers.byCode("SM_O74_ENDORSEMENT_BEFORE_SHIP_GATE")[1]!.status, "armed", "the second request's gate instance stays closed");
  const esc = h.escalations.list().find((e) => e.kind === "signing_officer")!; assert.equal(esc.payload.reason, "replacement_allonge_or_endorsement"); assert.equal(esc.ownerRole, "signing_officer");
  assert.equal(evaluateGate("26.4.endorsementBeforeShipGate", { endorsement: allonge({ allonge_identifiers: { ...allonge().allonge_identifiers!, note_amount_cents: 56_500_000n } }), note: { ...NOTE, note_amount_cents: "56000000" } }).open, false);
  // printed facsimile in a state with no legal opinion in the B8-3-04 authority file → refused; desk route
  const fax = ensureEndorsement(facsimile(["OH", "TX"]), NOTE); assert.equal(fax.open, false); assert.equal(fax.route, "endorsement_desk"); assert.match(fax.reason!, /legal opinion for AZ/);
  assert.equal(ensureEndorsement(facsimile(["AZ"]), NOTE).open, true);
  const desk = await h.run("registerMin", { op: "prepare_shipment", shipment: { ...SHIPMENT, shipment_id: "SHP-3" }, address_on_closing_instructions: true, endorsement: facsimile(["OH"]), note: NOTE, time_zone: TZ_AZ, at: mst("2026-11-09", "09:25") });
  assert.equal(desk.to_role, "endorsement_desk"); assert.equal(h.ofType("note.endorsement.exception").length, 2);
  // never SM or Fannie Mae as endorsee; never a second endorsement; never without a bailee letter / to an unlisted address / a copy
  assert.match(ensureEndorsement(allonge({ chain: [{ endorser: PARTNER, endorsee: "Supermortgage LLC", at: null }] }), NOTE).reason!, /in blank/);
  assert.match(ensureEndorsement(allonge({ chain: [{ endorser: PARTNER, endorsee: "blank", at: null }, { endorser: PARTNER, endorsee: "blank", at: null }] }), NOTE).reason!, /exactly one/);
  await refused(h.run("registerMin", { op: "prepare_shipment", shipment: { ...SHIPMENT, shipment_id: "SHP-4", bailee_letter_id: null }, address_on_closing_instructions: true, endorsement: allonge(), note: NOTE }), "SHIP_WITHOUT_BAILEE_LETTER");
  await refused(h.run("registerMin", { op: "prepare_shipment", shipment: { ...SHIPMENT, shipment_id: "SHP-5" }, address_on_closing_instructions: false, endorsement: allonge(), note: NOTE }), "SHIP_TO_UNLISTED_ADDRESS");
  await refused(h.run("registerMin", { op: "ensure_endorsement", endorsement: allonge(), note: NOTE, sign_allonge: true }), "NEVER_SIGNS");
});
test("26.4-T5: Given a paper note shipped Mon Nov 9, 2026 16:10 MST with a pickup scan, when delivery is scanned Tue Nov 10 10:05 ET and the trust receipt arrives 14:30 ET, then `SM_O74_NOTE_TRANSIT_3BD` and `SM_O74_TRUST_RECEIPT_1BD` are satisfied and 27.1 receives `warehouse.note.received` before the Nov 12 advance; given no delivery scan by Fri Nov 13 (3 `business_days_servicer`: Nov 10, 12, 13), then a trace opens, and with no delivery by Tue Nov 17 `note.lost_in_transit` is emitted and `SM_O74_LNA_DECISION_5BD` is due Tue Nov 24.", async () => {
  // worked example 2: pickup Mon Nov 9 16:10 MST → transit due Fri Nov 13 (Nov 10, 12, 13 — Veterans Day excluded); delivered Tue Nov 10 10:05 ET; trust receipt 14:30 ET
  const h = harness(APP, mst("2026-11-09", "09:00"));
  const pickup = await shippedNote(h);
  assert.equal(pickup.status, "in_transit"); assert.equal(pickup.transit_due_on, "2026-11-13");
  assert.equal(h.timer("SM_O74_NOTE_PICKUP_SCAN_1BD")!.status, "satisfied"); assert.equal(h.timer("SM_O74_NOTE_PICKUP_SCAN_1BD")!.dueDate, D("2026-11-10"));
  const transit = h.timer("SM_O74_NOTE_TRANSIT_3BD")!; assert.equal(transit.dueDate, D("2026-11-13")); assert.equal(transit.status, "armed");
  h.at(et("2026-11-10", "10:05")); const d = await h.run("registerMin", { op: "track_shipment", shipment_id: "SHP-1", scan_kind: "delivery", scan_at: et("2026-11-10", "10:05"), time_zone: TZ_ET, location: "FCC vault" });
  assert.equal(d.status, "delivered"); assert.equal(transit.status, "satisfied"); const tr = h.timer("SM_O74_TRUST_RECEIPT_1BD")!; assert.equal(tr.dueDate, D("2026-11-12")); assert.equal(d.trust_receipt_due_on, "2026-11-12");
  h.at(et("2026-11-10", "14:30")); const rc = await h.run("registerMin", { op: "ingest_trust_receipt", shipment_id: "SHP-1", receipt_id: "TR-1", received_at: et("2026-11-10", "14:30"), trust_receipt_document_id: "DOC-TR-1", custodian_loan_id: "FCC-000123" });
  assert.equal(rc.status, "receipted"); assert.equal(rc.holder_role, "fcc_bailee"); assert.equal(rc.collateral_status, "secured_possession"); assert.equal(tr.status, "satisfied");
  // 27.1 receives warehouse.note.received (its payload shape: secured_possession under the bailee letter) before the Thu Nov 12 09:40 ET advance
  const wn = h.ofType("warehouse.note.received")[0]!; assert.equal(wn.payload.collateral_status, "secured_possession"); assert.equal(wn.payload.bailee_letter_id, "BL-1"); assert.ok(wn.occurredAt < et("2026-11-12", "09:40"));
  assert.equal(h.rt.store.get("custody_records", "CR-1")!.data.holder_role, "fcc_bailee"); assert.equal(h.rt.store.get("custody_records", "CR-1")!.data.holding_for_party_id, "sm");
  // no delivery scan by Fri Nov 13 → the transit clock breaches and a trace opens; no delivery by Tue Nov 17 (day 5) → note.lost_in_transit; officer decision due Tue Nov 24
  const l = harness(APP, mst("2026-11-09", "09:00")); await shippedNote(l);
  const breaches = l.timers.evaluate(et("2026-11-14", "00:01")); assert.ok(breaches.some((b) => b.def.code === "SM_O74_NOTE_TRANSIT_3BD")); assert.match(breaches.find((b) => b.def.code === "SM_O74_NOTE_TRANSIT_3BD")!.breachText, /trace opened/);
  l.at(et("2026-11-14", "09:00")); const trace = await l.run("registerMin", { op: "open_trace", shipment_id: "SHP-1", claim_ref: "FDX-CLAIM-1", at: et("2026-11-14", "09:00") });
  assert.equal(trace.status, "exception"); assert.equal(trace.lost_determination_on, "2026-11-17"); assert.equal(l.ofType("note.shipment.trace_opened").length, 1);
  l.at(et("2026-11-17", "17:00")); const lost = await l.run("registerMin", { op: "handle_lost_note", shipment_id: "SHP-1", lna_id: "LNA-1", search_evidence_document_ids: ["DOC-TRACE-1", "DOC-ATTEST-1", "DOC-CUST-SEARCH-1"], courier_claim_ref: "FDX-CLAIM-1", at: et("2026-11-17", "17:00") });
  assert.equal(lost.status, "lost"); assert.equal(lost.decision_due_on, "2026-11-24"); assert.equal(lost.warehouse_effect, "unsecured_wet");
  const lna = l.timer("SM_O74_LNA_DECISION_5BD")!; assert.equal(lna.dueDate, D("2026-11-24")); assert.equal(lna.status, "armed");
  assert.ok(l.escalations.list().some((e) => e.kind === "officer" && e.severity === "sev1" && e.payload.reason === "lost_note_decision"));
  // the officer decides (re-execution first): the agent cannot; LNA-alone is refused while the borrower can re-execute
  await refused(l.run("registerMin", { op: "decide_lost_note", lna_id: "LNA-1", decision: "re_execute", borrower_can_reexecute: true, rationale: "borrower available" }), "LNA_DECISION_OFFICER");
  await assert.rejects(l.run("registerMin", { op: "decide_lost_note", lna_id: "LNA-1", decision: "lna", borrower_can_reexecute: true, rationale: "x" }, OFFICER), (e: unknown) => e instanceof PostClosingRefused && e.code === "REEXECUTION_FIRST");
  l.at(et("2026-11-18", "10:00")); const dec = await l.run("registerMin", { op: "decide_lost_note", lna_id: "LNA-1", decision: "both", borrower_can_reexecute: true, rationale: "replacement note plus LNA for the lost original (26.4-Q3)" }, OFFICER);
  assert.equal(dec.decision, "both"); assert.equal(lna.status, "satisfied");
});
test("26.4-T6: Given a wet advance funded Thu Nov 12, 2026 for a paper note, then 27.1's `SM_WH_WET_NOTE_DELIVERY_5BD` due date is Thu Nov 19, 2026 (Nov 13, 16, 17, 18, 19) and 26.4's shipment plan targets delivery by Tue Nov 17; given the purchase fixture funded Wed Nov 18, then the due date is Wed Nov 25 (Thanksgiving excluded).", async () => {
  // 27.1's facility clock (business_days_servicer): wet advance Thu Nov 12 → Nov 13, 16, 17, 18, 19; 26.4 ships next business day and targets delivery two days inside it
  const h = harness(APP, et("2026-11-12", "12:00"));
  const p = await h.run("computeMersAnchor", { op: "shipment_plan", advance_date: "2026-11-12" });
  assert.equal(p.wet_note_due_on, "2026-11-19"); assert.equal(p.target_delivery_on, "2026-11-17"); assert.equal(p.ship_by, "2026-11-13"); assert.equal(p.trust_receipt_target_on, "2026-11-18");
  const plan = shipmentPlan(D("2026-11-12")); assert.equal(plan.wet_note_due_on, "2026-11-19"); assert.equal(plan.target_delivery_on, "2026-11-17");
  // purchase fixture funded Wed Nov 18 → Nov 19, 20, 23, 24, 25 (Thanksgiving Thu Nov 26 excluded)
  const q = shipmentPlan(D("2026-11-18")); assert.equal(q.wet_note_due_on, "2026-11-25"); assert.equal(q.target_delivery_on, "2026-11-23");
  assert.equal(shipmentPlan(D("2026-11-25")).wet_note_due_on, "2026-12-03");
});
test("26.4-T7: Given a deed of trust eRecorded Mon Nov 9, 2026 10:12 MST, then `trailing_documents{recorded_security_instrument}.due_at` = Tue Nov 17 (5 `business_days_creditor`, Veterans Day excluded) and `final_title_policy.due_at` = Fri Jan 8, 2027 (60 calendar days); when the recorded image (15 pages, MIN present, legal description hash equal, RON certificate) is reviewed, then `pass`; when the image lacks the PUD Rider page, then `defect{missing_rider}` with `SM_O74_RERECORD_CURE_10BD` due 10 business days later and the title underwriter notified.", async () => {
  // worked example 1: eRecorded Mon Nov 9 10:12 MST → recorded-instrument image due Tue Nov 17 (5 business_days_creditor; Veterans Day excluded); final policy due Fri Jan 8, 2027
  const h = harness(APP, mst("2026-11-09", "10:12"));
  h.upstream("recording.confirmed", { closing_id: "CLS-1", recording_id: "REC-1", closing_document_id: "DOC-DOT-1", channel: "erecording", recorded_at: mst("2026-11-09", "10:12"), instrument_number: "20261109-0412345", gap_days: 0, recorded_image_document_id: null }, mst("2026-11-09", "10:12"), { kind: "external", id: "simplifile" });
  const er = h.timer("SM_O74_RECORDED_SI_ERECORD_5BD")!; assert.equal(er.dueDate, D("2026-11-17")); const fp = h.timer("SM_O74_FINAL_TITLE_POLICY_60")!; assert.equal(fp.dueDate, D("2027-01-08"));
  const set = await h.expectSet(); const rows = set.rows as { kind: string; due_at: string | null; status: string }[];
  assert.equal(rows.find((r) => r.kind === "recorded_security_instrument")!.due_at, "2026-11-17"); assert.equal(rows.find((r) => r.kind === "final_title_policy")!.due_at, "2027-01-08"); assert.equal(rows.find((r) => r.kind === "recorded_security_instrument")!.status, "open");
  assert.deepEqual(trailingDueAt("recorded_security_instrument", { recording: { channel: "erecording", recorded_on: D("2026-11-09"), submitted_on: D("2026-11-09") }, note_date: D("2026-11-06") }).due_at, D("2026-11-17"));
  assert.deepEqual(trailingDueAt("final_title_policy", { recording: { channel: "erecording", recorded_on: D("2026-11-09"), submitted_on: D("2026-11-09") }, note_date: D("2026-11-06") }).due_at, D("2027-01-08"));
  // image received 10:20, reviewed 11:05: 15 pages = 15, legal description hash equal, MIN + nominee paragraph, RON certificate → pass; the item closes
  h.at(mst("2026-11-09", "10:20")); const img = await h.run("registerMin", { op: "ingest_recorded_image", recording_id: "REC-1", document_id: "DOC-DOT-REC-1", received_at: mst("2026-11-09", "10:20"), time_zone: TZ_AZ, instrument_number: "20261109-0412345" });
  assert.equal(img.status, "received"); assert.equal(er.status, "satisfied"); const rv = h.timer("SM_O74_RECORDED_SI_REVIEW_2BD")!; assert.equal(rv.dueDate, D("2026-11-12"));
  h.at(mst("2026-11-09", "11:05")); const pass = await h.run("registerMin", { op: "review_recorded_instrument", image: image(), time_zone: TZ_AZ, at: mst("2026-11-09", "11:05") });
  assert.equal(pass.result, "pass"); assert.equal(pass.defect_kind, null); assert.equal(rv.status, "satisfied"); assert.equal((pass.checks as Record<string, boolean>).ron_statement_present_if_ron, true);
  const closed = await h.run("registerMin", { op: "close_trailing_document", kind: "recorded_security_instrument", at: mst("2026-11-09", "11:06") }); assert.equal(closed.status, "closed"); assert.equal(closed.file_complete, false);
  await assert.rejects(h.run("registerMin", { op: "close_trailing_document", kind: "final_title_policy" }), (e: unknown) => e instanceof PostClosingRefused && e.code === "CLOSE_WITHOUT_PASSED_REVIEW");
  // worked example 3: the recorded image lacks the PUD Rider page (executed 3 rider pages, recorded 2) → defect{missing_rider}; county correction; cure due 10 business days later; title underwriter notified
  const p = harness(PAPP, et("2026-11-19", "09:40"));
  p.upstream("recording.confirmed", { closing_id: "CLS-2", recording_id: "REC-2", channel: "erecording", recorded_at: et("2026-11-19", "09:40"), instrument_number: "202611190055123", gap_days: 0 }, et("2026-11-19", "09:40"), { kind: "external", id: "simplifile" });
  await p.expectSet({ funded_on: "2026-11-18", note_date: "2026-11-18", state: "OH", note_form: "paper", ltv_pct: 95, recording: { channel: "erecording", recorded_on: "2026-11-19" }, at: et("2026-11-19", "10:00") });
  p.at(et("2026-11-19", "11:00")); await p.run("registerMin", { op: "ingest_recorded_image", recording_id: "REC-2", document_id: "DOC-MTG-REC-2", received_at: et("2026-11-19", "11:00"), time_zone: TZ_ET });
  p.at(et("2026-11-19", "13:20")); const defect = await p.run("registerMin", { op: "review_recorded_instrument", image: image({ recording_id: "REC-2", trailing_document_id: `${PAPP}:recorded_security_instrument`, executed_document_id: "DOC-MTG-2", recorded_image_document_id: "DOC-MTG-REC-2", executed_pages: 18, executed_rider_count: 3, image_pages: 17, image_rider_count: 2, ron: false, ron_statement: false, county_expected: "Franklin", county_on_stamp: "Franklin", instrument_number: "202611190055123", county_image_incomplete: true }), time_zone: TZ_ET, at: et("2026-11-19", "13:20"), title_underwriter_party_id: "P-UW-1" });
  assert.equal(defect.result, "defect"); assert.equal(defect.defect_kind, "missing_rider"); assert.equal(defect.cure, "county_correction"); assert.equal(defect.cure_due_on, "2026-12-04"); assert.equal(defect.title_underwriter_notified_at, et("2026-11-19", "13:20")); assert.equal(defect.status, "defect_open");
  const cure = p.timer("SM_O74_RERECORD_CURE_10BD")!; assert.equal(cure.dueDate, D("2026-12-04")); assert.equal(cure.status, "armed");
  assert.equal(p.ofType("trailing_document.defect")[0]!.payload.kind, "recorded_security_instrument"); assert.equal(p.ofType("trailing_document.defect")[0]!.payload.title_underwriter_notified, true);
  const rr = await p.run("registerMin", { op: "request_rerecording", review_id: "REC-2:review", package_ref: "COUNTY-CORR-1", time_zone: TZ_ET, at: et("2026-11-19", "15:00") }); assert.equal(rr.cure, "county_correction"); assert.equal(cure.status, "satisfied");
  assert.equal(cureFor("legal_description", {}), "corrective_instrument"); assert.equal(cureFor("min_missing", {}), "none"); assert.equal(cureFor("image_illegible", {}), "certified_copy_request");
  assert.equal(reviewRecordedInstrument(image({ legal_description_hash_image: "h-legal-2" })).defect_kind, "legal_description");
});
test("26.4-T8: Given a final policy received Tue Dec 1, 2026 on the 2021 ALTA Loan Policy for $560,000.00 naming the partner ISAOA/ATIMA with Date of Policy Nov 9, 2026, Schedule A matching `recordings`, Schedule B without new exceptions and ALTA 8.1 issued, then `final_policy_reviews.result = pass` and the trailing item closes; given the insured is \"Mortgage Electronic Registration Systems, Inc.\" or the amount is $555,000.00, then `defect` and a correction request with the 30-day follow-up cadence.", async () => {
  // rule 7 fixture: received Tue Dec 1, 2026; 2021 ALTA Loan Policy, $560,000.00, partner ISAOA/ATIMA, Date of Policy Nov 9 10:12 MST, Schedule A = recordings, Schedule B clean, ALTA 8.1 → pass, closed Dec 1
  const h = harness(APP, mst("2026-11-09", "10:12"));
  h.upstream("recording.confirmed", { closing_id: "CLS-1", recording_id: "REC-1", channel: "erecording", recorded_at: mst("2026-11-09", "10:12"), instrument_number: "20261109-0412345", gap_days: 0 }, mst("2026-11-09", "10:12"), { kind: "external", id: "simplifile" });
  await h.expectSet(); const sixty = h.timer("SM_O74_FINAL_TITLE_POLICY_60")!; assert.equal(sixty.dueDate, D("2027-01-08"));
  h.at(mst("2026-12-01", "09:00")); const rec = await h.run("registerMin", { op: "ingest_final_policy", title_order_id: "TO-FINAL-1", document_id: "DOC-POLICY-1", received_at: mst("2026-12-01", "09:00"), time_zone: TZ_AZ, from_party_id: "P-UW-1", policy_number: "AZ-2026-778899" });
  assert.equal(rec.status, "received"); assert.equal(rec.review_due_on, "2026-12-03"); assert.equal(sixty.status, "satisfied"); const two = h.timer("SM_O74_FINAL_POLICY_REVIEW_2BD")!; assert.equal(two.dueDate, D("2026-12-03"));
  const pass = await h.run("registerMin", { op: "review_final_policy", policy: { ...policy(), amount_cents: "56000000" }, expectations: { ...POLICY_EXPECT, original_principal_cents: "56000000" }, time_zone: TZ_AZ, at: mst("2026-12-01", "10:00"), underwriter_party_id: "P-UW-1" });
  assert.equal(pass.result, "pass"); assert.deepEqual(pass.defects, []); assert.equal(pass.insured_ok, true); assert.equal(pass.amount_ok, true); assert.equal(pass.endorsements_ok, true); assert.equal(two.status, "satisfied");
  assert.equal(h.rt.store.get("final_policy_reviews", "TO-FINAL-1:final_policy_review")!.data.result, "pass");
  const closed = await h.run("registerMin", { op: "close_trailing_document", kind: "final_title_policy", at: mst("2026-12-01", "10:05") }); assert.equal(closed.status, "closed");
  assert.equal(h.ofType("trailing_document.closed").at(-1)!.payload.kind, "final_title_policy");
  // the insured is MERS, or the amount is $555,000.00 → defect and a correction request on the 30-day cadence
  const mers = reviewFinalPolicy(policy({ insured_text: "Mortgage Electronic Registration Systems, Inc., as nominee for the partner" }), POLICY_EXPECT);
  assert.equal(mers.result, "defect"); assert.equal(mers.insured_ok, false); assert.match(mers.defects[0]!, /under no circumstances may MERS be named as the insured/);
  const low = reviewFinalPolicy(policy({ amount_cents: 55_500_000n }), POLICY_EXPECT); assert.equal(low.result, "defect"); assert.equal(low.amount_ok, false); assert.match(low.defects[0]!, /amount_below_principal: 55500000 < original principal 56000000/);
  assert.equal(insuredOk(`${PARTNER} ISAOA/ATIMA`, PARTNER).ok, true);
  const d = harness(APP, mst("2026-11-09", "10:12")); await d.expectSet(); d.at(mst("2026-12-01", "09:00"));
  await d.run("registerMin", { op: "ingest_final_policy", title_order_id: "TO-FINAL-1", document_id: "DOC-POLICY-1", received_at: mst("2026-12-01", "09:00"), time_zone: TZ_AZ });
  const def = await d.run("registerMin", { op: "review_final_policy", policy: { ...policy({ amount_cents: 55_500_000n, insured_text: "Mortgage Electronic Registration Systems, Inc." }), amount_cents: "55500000" }, expectations: { ...POLICY_EXPECT, original_principal_cents: "56000000" }, time_zone: TZ_AZ, at: mst("2026-12-01", "10:00"), underwriter_party_id: "P-UW-1" });
  assert.equal(def.result, "defect"); assert.equal(def.status, "defect_open"); assert.equal(def.correction_requested_at, mst("2026-12-01", "10:00")); assert.equal(def.next_followup_on, "2026-12-31"); assert.equal((def.defects as string[]).length, 2);
  const cr = d.ofType("title.final_policy.correction_requested")[0]!; assert.equal(cr.payload.followup_cadence_days, 30); assert.equal(cr.payload.next_followup_on, "2026-12-31"); assert.equal(cr.payload.officer_escalation_on, "2027-03-12");
  assert.equal(d.ofType("title.final_policy.defect").length, 1);
  // other B7-2-03 defects: a 2006 form on a 2026 origination; a missing ALTA 8.1; T-42 for TX 50(a)(6)
  assert.match(reviewFinalPolicy(policy({ policy_kind: "alta_2006_loan" }), POLICY_EXPECT).defects[0]!, /2021 ALTA Loan Policy/);
  assert.match(reviewFinalPolicy(policy({ endorsements_issued: [] }), POLICY_EXPECT).defects[0]!, /endorsements_missing: ALTA 8.1/);
  assert.match(reviewFinalPolicy(policy(), { ...POLICY_EXPECT, tx_50a6: true }).defects[0]!, /T-42, T-42.1/);
});
test("26.4-T9: Given a custodian exception `endorser_not_on_resolution` recorded Mon Nov 23, 2026, then `SM_O74_CUSTODIAN_EXCEPTION_CURE_5BD` is due Tue Dec 1, 2026 (Thanksgiving excluded); when the corporate secretary certification is delivered Nov 24, then `custody.exception.cured` and 27.1's defect closes; when nothing is delivered by Dec 1, then sev 2 escalations to `signing_officer` and `officer` fire and the delivery (29.4) cannot certify.", async () => {
  // worked example 3: custodian exception Mon Nov 23 → cure due Tue Dec 1 (Nov 24, 25, 27, 30, Dec 1 — Thanksgiving excluded); 27.1's defect opened in parallel
  const h = harness(PAPP, et("2026-11-23", "10:00"));
  h.rt.store.put("custody_records", "CR-2", { holder_role: "fcc_bailee", custodian_exception_codes: [] }, AGENT, et("2026-11-20", "15:10"));
  const ex = await h.run("registerMin", { op: "open_custodian_exception", custody_record_id: "CR-2", code: "endorser_not_on_resolution", recorded_at: et("2026-11-23", "10:00"), time_zone: TZ_ET, notice_document_id: "DOC-EXC-1", advance_id: "adv-pur-1", description: "facsimile endorsement officer not on the corporate resolution on file" });
  assert.equal(ex.cure_due_on, "2026-12-01"); assert.equal(ex.cure_owner, "signing_officer"); assert.deepEqual(ex.codes, ["endorser_not_on_resolution"]); assert.equal((ex.certifiable as Record<string, unknown>).ok, false);
  const t = h.timer("SM_O74_CUSTODIAN_EXCEPTION_CURE_5BD")!; assert.equal(t.dueDate, D("2026-12-01")); assert.equal(t.status, "armed");
  const wd = h.ofType("warehouse.collateral.defect_recorded")[0]!; assert.equal(wd.payload.source, "custodian_exception"); assert.equal(wd.payload.cure_owner, "signing_officer"); assert.equal(wd.payload.advance_id, "adv-pur-1");
  // corporate secretary certification and updated resolution delivered to the FCC Tue Nov 24 → cured; 27.1's defect closes
  h.at(et("2026-11-24", "14:00")); const cure = await h.run("registerMin", { op: "cure_custodian_exception", custody_record_id: "CR-2", code: "endorser_not_on_resolution", cured_at: et("2026-11-24", "14:00"), time_zone: TZ_ET, evidence_document_id: "DOC-SEC-CERT-1", evidence_kind: "corporate_secretary_certification", advance_id: "adv-pur-1" });
  assert.deepEqual(cure.codes, []); assert.equal((cure.certifiable as Record<string, unknown>).ok, true); assert.equal(t.status, "satisfied");
  assert.equal(h.ofType("custody.exception.cured")[0]!.payload.evidence_kind, "corporate_secretary_certification"); assert.equal(h.ofType("warehouse.collateral.defect_cured").length, 1);
  // nothing delivered by Dec 1 → sev 2 escalations to signing_officer and officer; 29.4 cannot certify
  const b = harness(PAPP, et("2026-11-23", "10:00")); b.rt.store.put("custody_records", "CR-2", { holder_role: "fcc_bailee", custodian_exception_codes: [] }, AGENT, et("2026-11-20", "15:10"));
  await b.run("registerMin", { op: "open_custodian_exception", custody_record_id: "CR-2", code: "endorser_not_on_resolution", recorded_at: et("2026-11-23", "10:00"), time_zone: TZ_ET, notice_document_id: "DOC-EXC-1" });
  const breaches = b.timers.evaluate(et("2026-12-02", "00:01")); const br = breaches.find((x) => x.def.code === "SM_O74_CUSTODIAN_EXCEPTION_CURE_5BD")!; assert.equal(br.severity, 2); assert.ok(br.escalateTo.includes("signing_officer") && br.escalateTo.includes("officer"));
  b.at(et("2026-12-02", "07:00")); const esc = await b.run("registerMin", { op: "exception_breach", custody_record_id: "CR-2", at: et("2026-12-02", "07:00") });
  assert.equal((esc.escalation_ids as string[]).length, 2); assert.deepEqual(b.escalations.list().filter((e) => e.payload.reason === "custodian_exception_uncured").map((e) => [e.kind, e.severity]), [["signing_officer", "sev2"], ["officer", "sev2"]]);
  assert.equal(b.escalations.list()[0]!.payload.reason, "custodian_exception_cure", "the exception itself routed the cure to the signing_officer (sev 3) when it was recorded");
  assert.equal((esc.certifiable as Record<string, unknown>).ok, false); assert.deepEqual(b.ofType("custody.certification.blocked")[0]!.payload.blocks, ["custody.certified"]);
  const cg = await b.run("computeMersAnchor", { op: "certification_gate", custody_record_id: "CR-2" }); assert.equal(cg.ok, false); assert.match(String(cg.reason), /endorser_not_on_resolution/);
  // a corrected-allonge cure is the signing_officer's act, never the agent's
  b.rt.store.put("custody_records", "CR-3", { holder_role: "fcc_bailee", custodian_exception_codes: ["unsigned_allonge"] }, AGENT, et("2026-11-23", "10:00"));
  await assert.rejects(b.run("registerMin", { op: "cure_custodian_exception", custody_record_id: "CR-3", code: "unsigned_allonge", evidence_document_id: "DOC-ALLONGE-2", evidence_kind: "corrected_allonge" }), (e: unknown) => e instanceof PostClosingRefused && e.code === "CURE_BY_SIGNING_OFFICER");
  const so = await b.run("registerMin", { op: "cure_custodian_exception", custody_record_id: "CR-3", code: "unsigned_allonge", evidence_document_id: "DOC-ALLONGE-2", evidence_kind: "corrected_allonge" }, SIGNING_OFFICER); assert.deepEqual(so.codes, []);
});
test("26.4-T10: Given a registered MIN (Nov 9) and a rescission exercised Tue Nov 10, 2026, then `SM_O74_MIN_REVERSAL_2BD` is due Fri Nov 13 (Nov 12, 13 — Nov 11 excluded), the reversal is submitted in the Nov 12 batch, the recorded deed of trust's release is tracked to recording, and every trailing item is `waived{loan_cancelled}` with no `officer` action except the note release (paper) or none (eNote).", async () => {
  // worked example 4: MIN active Mon Nov 9; borrower rescinds Tue Nov 10 16:00 MST (25.3) → reversal due Fri Nov 13 (Nov 12, 13 — Nov 11 excluded); submitted in the Thu Nov 12 batch
  const h = harness(APP, mst("2026-11-09", "17:00")); h.consummated(); h.at(mst("2026-11-09", "18:00")); await h.register();
  h.upstream("recording.confirmed", { closing_id: "CLS-1", recording_id: "REC-1", channel: "erecording", recorded_at: mst("2026-11-09", "10:12"), instrument_number: "20261109-0412345", gap_days: 0 }, mst("2026-11-09", "10:12"), { kind: "external", id: "simplifile" });
  await h.expectSet({ at: mst("2026-11-09", "10:30") });
  h.upstream("rescission.exercised", { rescission_id: "RSC-1", exercise_id: "EX-1", consumer_id: "B1", refund_due_at: "2026-12-03", after_disbursement: false }, mst("2026-11-10", "16:00"), { kind: "agent", id: "compliance-disclosures" });
  h.at(mst("2026-11-10", "16:05"));
  const plan = await h.run("registerMin", { op: "void_collateral", cause: "rescission_exercised", event_at: mst("2026-11-10", "16:00"), time_zone: TZ_AZ, funded: false, min: MIN, note_form: "enote", recording: { recorded: true, instrument_number: "20261109-0412345" }, at: mst("2026-11-10", "16:05") });
  assert.equal(plan.min_action, "reversal"); assert.equal(plan.reversal_due_on, "2026-11-13"); assert.equal(plan.batch_on, "2026-11-12"); assert.equal(plan.note_action, "none"); assert.equal(plan.enote_action, "registration_reversal_26_2"); assert.equal(plan.release_tracked, true);
  assert.deepEqual([...(plan.waived as string[])].sort(), ["custodian_certification", "final_title_policy", "flood_cert", "recorded_security_instrument"]); assert.deepEqual(plan.officer_actions, []); assert.equal(plan.officer_escalation_id, null);
  const t = h.timer("SM_O74_MIN_REVERSAL_2BD")!; assert.equal(t.dueDate, D("2026-11-13")); assert.equal(t.status, "armed");
  for (const w of h.ofType("trailing_document.waived")) { assert.equal(w.payload.reason, "loan_cancelled"); assert.equal(w.payload.waived_by, "system"); }
  assert.equal(h.rt.store.get("trailing_documents", `${APP}:recorded_correction`)!.data.status, "open", "the deed of trust's release is tracked to recording");
  assert.equal(h.escalations.list().filter((e) => e.kind === "officer").length, 0, "no officer action on an eNote loan");
  h.at(mst("2026-11-12", "18:00")); const rv = await h.run("registerMin", { op: "reverse", min: MIN, reason: "loan_cancelled_before_funding", submitted_at: mst("2026-11-12", "18:00"), time_zone: TZ_AZ, due_on: "2026-11-13" });
  assert.equal(rv.status, "reversed"); assert.equal(rv.batch_on, "2026-11-12"); assert.equal(rv.on_time, true); assert.equal(t.status, "satisfied"); assert.equal(h.ofType("mers.min.reversed")[0]!.payload.kind, "registration_reversal");
  // the release recorded Tue Nov 17 closes the recorded_correction item on the recorded image
  h.at(mst("2026-11-17", "11:00")); await h.run("registerMin", { op: "ingest_recorded_image", kind: "recorded_correction", recording_id: "REC-REL-1", document_id: "DOC-RELEASE-REC-1", received_at: mst("2026-11-17", "11:00"), time_zone: TZ_AZ });
  await h.run("registerMin", { op: "review_recorded_instrument", kind: "recorded_correction", image: image({ recording_id: "REC-REL-1", trailing_document_id: `${APP}:recorded_correction`, executed_document_id: "DOC-RELEASE-1", recorded_image_document_id: "DOC-RELEASE-REC-1", executed_pages: 2, image_pages: 2, ron: false, ron_statement: false, instrument_number: "20261117-0419900" }), time_zone: TZ_AZ, at: mst("2026-11-17", "11:30") });
  const c = await h.run("registerMin", { op: "close_trailing_document", kind: "recorded_correction", at: mst("2026-11-17", "11:35") }); assert.equal(c.status, "closed");
  // paper variant: a note already at the FCC needs the partner officer's Form 2009-content release request — the one officer action
  const p = harness(APP, mst("2026-11-10", "16:05")); p.rt.store.put("mers_registrations", MIN, { min: MIN, application_id: APP, status: "active" }, AGENT, mst("2026-11-09", "18:00"));
  const pp = await p.run("registerMin", { op: "void_collateral", cause: "rescission_exercised", event_at: mst("2026-11-10", "16:00"), time_zone: TZ_AZ, funded: false, min: MIN, note_form: "paper", holder_role: "fcc_bailee", custody_record_id: "CR-1", recording: { recorded: true, instrument_number: "20261109-0412345" } });
  assert.equal(pp.note_action, "form_2009_release_officer"); assert.equal((pp.officer_actions as string[]).length, 1); assert.ok(pp.officer_escalation_id); assert.equal(p.escalations.list()[0]!.payload.reason, "note_release_form_2009");
  await refused(p.run("registerMin", { op: "release_note", custody_record_id: "CR-1" }), "NOTE_RELEASE_OFFICER");
});
test("26.4-T11: Given an eNote in SM's eVault with Secured Party = SM, when the daily hash check finds the eVault hash ≠ the eRegistry hash, then a sev 1 escalation to `officer` opens, 27.1 is told the collateral is `defect`, and no delivery request is prepared; when the monthly reconciliation on Tue Dec 1 finds Controller = Fannie Mae after the Nov 19 purchase and Investor = Fannie Mae on the MERS System, then `mers.reconciliation.completed{variances=0}`.", async () => {
  // rule 9: daily hash check — eVault hash ≠ eRegistry hash → sev 1 officer, 27.1 told the collateral is defect (eregistry_mismatch), no delivery request prepared
  const h = harness(APP, mst("2026-11-13", "06:00"));
  const enote = { enote_id: "EN-1", min: MIN, evault_hash: "sha256:aaaa", eregistry_hash: "sha256:bbbb", controller_org_id: PARTNER_ORG, location_org_id: SM_ORG_ID, secured_party_org_id: SM_ORG_ID, delegatee_org_id: SM_ORG_ID };
  const bad = await h.run("registerMin", { op: "daily_enote_check", enote, advance_id: "adv-refi-1", at: mst("2026-11-13", "06:00") });
  assert.equal(bad.ok, false); assert.equal(bad.delivery_request_blocked, true); assert.equal(bad.collateral_status, "defect"); assert.ok(bad.escalation_id);
  const esc = h.escalations.list()[0]!; assert.equal(esc.kind, "officer"); assert.equal(esc.severity, "sev1"); assert.equal(esc.payload.delivery_request_blocked, true);
  const wd = h.ofType("warehouse.collateral.defect_recorded")[0]!; assert.equal(wd.payload.source, "eregistry_mismatch"); assert.equal(wd.payload.collateral_status, "defect"); assert.equal(wd.payload.cure_owner, "post-closing");
  const good = await h.run("registerMin", { op: "daily_enote_check", enote: { ...enote, eregistry_hash: "sha256:aaaa" }, at: mst("2026-11-14", "06:00") }); assert.equal(good.ok, true); assert.equal(good.collateral_status, "secured_control");
  // monthly reconciliation Tue Dec 1: eRegistry Controller/Location = Fannie Mae after the Nov 19 purchase, Secured Party none; MERS System Investor = Fannie Mae, Interim Funder blank, Subservicer = SM → variances = 0
  h.at(mst("2026-12-01", "00:05"));
  await h.run("registerMin", { op: "open_reconciliation", scope: "eregistry", as_of: "2026-12-01", at: mst("2026-12-01", "00:05") }); await h.run("registerMin", { op: "open_reconciliation", scope: "mers_system", as_of: "2026-12-01", at: mst("2026-12-01", "00:05") });
  const ev = h.timer("SM_O74_EVAULT_EREGISTRY_RECONCILE_MONTHLY")!; const ms = h.timer("SM_O74_MERS_SYSTEM_RECONCILE_MONTHLY")!; assert.equal(ev.status, "armed"); assert.equal(ms.status, "armed"); assert.equal(ms.anchorDate, D("2026-12-01"));
  const er = await h.run("registerMin", { op: "reconcile_eregistry", as_of: "2026-12-01", rows: [{ min: MIN, sor: { controller_org_id: FANNIE_MAE_ORG_ID, location_org_id: FANNIE_MAE_ORG_ID, secured_party_org_id: null }, registry: { controller_org_id: FANNIE_MAE_ORG_ID, location_org_id: FANNIE_MAE_ORG_ID, secured_party_org_id: null }, hash_match: true }], at: mst("2026-12-01", "06:00") });
  assert.equal(er.variances, 0); assert.equal(ev.status, "satisfied"); assert.equal(h.ofType("enote.custody.reconciled")[0]!.payload.scope, "eregistry");
  const sor = { status: "active", servicer_org_id: PARTNER_ORG, subservicer_org_id: SM_ORG_ID, investor_org_id: FANNIE_MAE_ORG_ID, interim_funder_org_id: null };
  const mr = await h.run("registerMin", { op: "reconcile_mers_system", as_of: "2026-12-01", rows: [{ min: MIN, sor, mers: { ...sor } }], at: mst("2026-12-01", "06:10") });
  assert.equal(mr.variances, 0); assert.equal(mr.escalation_id, null); assert.equal(mr.cure_due_on, "2026-12-15"); assert.equal(ms.status, "satisfied");
  const done = h.ofType("mers.reconciliation.completed")[0]!; assert.equal(done.payload.variances, 0); assert.equal(done.payload.scope, "mers_system"); assert.equal(done.payload.as_of, "2026-12-01");
  // a stale Investor (partner after purchase) routes to 30.1; a stale Interim Funder to 27.2; both to the officer
  const v = await h.run("registerMin", { op: "reconcile_mers_system", as_of: "2026-12-01", rows: [{ min: MIN, sor, mers: { ...sor, investor_org_id: PARTNER_ORG, interim_funder_org_id: SM_ORG_ID } }], at: mst("2026-12-01", "06:20") });
  assert.equal(v.variances, 2); assert.deepEqual((v.variance_rows as { field: string; route: string }[]).map((x) => [x.field, x.route]), [["investor_org_id", "30.1"], ["interim_funder_org_id", "27.2"]]); assert.ok(v.escalation_id);
  await refused(h.run("registerMin", { op: "transfer_of_control", min: MIN }), "NEVER_TRANSFER_OF_CONTROL"); await refused(h.run("registerMin", { op: "daily_enote_check", enote, convert_enote_to_paper: true }), "NEVER_ENOTE_TO_PAPER");
});
test("26.4-T12: Given a Maine loan, then 26.1 renders Form 3749, the `signing_officer` executes it at closing, it is recorded promptly after the mortgage, `recorded_assignment_to_mers` is expected, and no other assignment (intervening, to Fannie Mae) exists on any loan in the population — a query for `closing_documents.kind` containing \"assignment\" outside Maine returns zero rows.", async () => {
  // rule 3: Maine → Form 3749 executed at closing by the signing_officer, recorded promptly after the mortgage, recorded_assignment_to_mers expected; everywhere else no assignment of any kind
  const me = decideAssignments({ state: "ME" }); assert.equal(me.kind, "form_3749_to_mers"); assert.equal(me.registration_kind, "non_mom_assignment"); assert.equal(me.executed_by, "signing_officer"); assert.equal(me.trailing_kind, "recorded_assignment_to_mers"); assert.equal(me.intervening, false); assert.equal(me.to_fannie_mae, false);
  for (const st of ["AZ", "OH", "TX", "NY", "MT"]) { const d = decideAssignments({ state: st }); assert.equal(d.kind, "none"); assert.equal(d.trailing_kind, null); assert.equal(d.to_fannie_mae, false); assert.equal(d.intervening, false); }
  const h = harness("APP-ME-1", et("2026-11-18", "12:00"));
  const a = await h.run("computeMersAnchor", { op: "assignments", state: "ME" }); assert.equal(a.kind, "form_3749_to_mers");
  const ex = await h.run("registerMin", { op: "record_assignment", state: "ME", document_id: "DOC-3749-1", executed_at: et("2026-11-18", "11:05"), time_zone: TZ_ET, signing_officer_party_id: "u-so-partner" });
  assert.equal(h.ofType("closing.assignment_to_mers.executed")[0]!.actor.role, "signing_officer"); assert.equal(ex.registration_due_at, "2026-11-25");
  const set = await h.run("registerMin", { op: "expect_trailing_documents", funded_on: "2026-11-18", note_date: "2026-11-18", state: "ME", note_form: "paper", ltv_pct: 80, flood_lol_on_file: true, recording: { channel: "erecording", recorded_on: "2026-11-19" }, at: et("2026-11-18", "16:00") });
  assert.ok((set.rows as { kind: string }[]).some((r) => r.kind === "recorded_assignment_to_mers"), "recorded_assignment_to_mers is expected in Maine");
  // the population query: closing_documents.kind containing "assignment" outside Maine returns zero rows (E-2-01 lists none; RDC v15 removed them; B8-6-01 is moot for MERS loans)
  h.rt.store.put("closing_documents", "DOC-ME-3749", { application_id: "APP-ME-1", state: "ME", kind: "mers_assignment_3749" }, AGENT, et("2026-11-16", "12:00"));
  h.rt.store.put("closing_documents", "DOC-AZ-NOTE", { application_id: APP, state: "AZ", kind: "note" }, AGENT, et("2026-11-05", "12:00"));
  h.rt.store.put("closing_documents", "DOC-AZ-DOT", { application_id: APP, state: "AZ", kind: "security_instrument" }, AGENT, et("2026-11-05", "12:00"));
  h.rt.store.put("closing_documents", "DOC-OH-MTG", { application_id: PAPP, state: "OH", kind: "security_instrument" }, AGENT, et("2026-11-16", "12:00"));
  const q = await h.run("computeMersAnchor", { op: "assignment_population" }); assert.deepEqual(q.offending, []);
  assert.deepEqual(assignmentPopulationCheck([{ application_id: PAPP, state: "OH", kind: "assignment_to_fnma" }]), [{ application_id: PAPP, state: "OH", kind: "assignment_to_fnma" }], "an assignment outside Maine would be a population defect");
  assert.throws(() => decideAssignments({ state: "OH", originator_is_servicer: false }), (e: unknown) => e instanceof PostClosingRefused && e.code === "INTERVENING_ASSIGNMENT_OUT_OF_MODEL");
  await refused(h.run("registerMin", { op: "record_assignment", state: "ME", document_id: "DOC-3749-2", executed_at: et("2026-11-18", "11:05"), signing_officer_party_id: "u-so-partner", execute_assignment: true }), "NEVER_SIGNS");
});
test("26.4-T13: Given the trailing-document population for the refinance fixture at Fri Mar 12, 2027 (120 days after Nov 12 funding), when the final policy is still open, then `SM_O74_TRAILING_DOC_ESCALATE_120` fires to `officer`, the QC file is flagged for 28.2, and the follow-up ladder shows at least four logged attempts (Jan 8, Feb 7, Mar 9 cadence plus the initial request).", async () => {
  // INT-O7-12: refinance funded Thu Nov 12, 2026; final policy due Fri Jan 8, 2027; 120 days → Fri Mar 12, 2027
  const h = harness(APP, mst("2026-11-12", "12:00"));
  h.upstream("loan.funded", { funding_id: "fund-refi-1", funding_date: "2026-11-12", disbursement_date: "2026-11-12", note_date: "2026-11-06", source: "origination" }, mst("2026-11-12", "11:30"), { kind: "agent", id: "funder" });
  await h.expectSet();
  // the recorded deed of trust came back Nov 9 and passed (26.4-T7) — only the final policy stays open
  await h.run("registerMin", { op: "ingest_recorded_image", recording_id: "REC-1", document_id: "DOC-DOT-REC-1", received_at: mst("2026-11-09", "10:20"), time_zone: TZ_AZ, at: mst("2026-11-12", "12:01") });
  await h.run("registerMin", { op: "review_recorded_instrument", image: image(), time_zone: TZ_AZ, at: mst("2026-11-12", "12:02") }); await h.run("registerMin", { op: "close_trailing_document", kind: "recorded_security_instrument", at: mst("2026-11-12", "12:03") });
  const t120 = h.timer("SM_O74_TRAILING_DOC_ESCALATE_120")!; assert.equal(t120.dueDate, D("2027-03-12")); assert.equal(t120.anchorDate, D("2026-11-12"));
  assert.equal(h.ofType("trailing_document.expected")[0]!.payload.escalate_on, "2027-03-12");
  // the follow-up ladder: the initial request at funding, then the due-date cadence Jan 8 → Feb 7 → Mar 9
  assert.deepEqual(followupSchedule(D("2027-01-08"), D("2027-03-12")), [D("2027-01-08"), D("2027-02-07"), D("2027-03-09")]);
  const sched = await h.run("computeMersAnchor", { op: "followup_schedule", due_at: "2027-01-08", through: "2027-03-12" }); assert.deepEqual(sched.dates, ["2027-01-08", "2027-02-07", "2027-03-09"]);
  const f0 = await h.run("registerMin", { op: "follow_up", kind: "final_title_policy", channel: "vendor_api", to_party_id: "P-UW-1", at: mst("2026-11-12", "12:30") }); assert.equal(f0.attempts, 1);
  const attempt = async (d: string, ch: "vendor_api" | "email" | "phone") => { h.at(mst(d, "09:00")); const f = await h.run("registerMin", { op: "follow_up", kind: "final_title_policy", channel: ch, to_party_id: "P-UW-1", at: mst(d, "09:00") }); assert.equal(f.next_at, followupSchedule(D(d), D("2027-12-31"))[1]); };
  await attempt("2027-01-08", "vendor_api");
  // the daily sweep past the due date arms the 30-day recurring follow-up on the last attempt (Jan 8 → Feb 7)
  h.at(mst("2027-01-09", "07:00")); const sw1 = await h.run("registerMin", { op: "sweep", today: "2027-01-09", at: mst("2027-01-09", "07:00") }); assert.deepEqual(sw1.overdue, ["final_title_policy"]); assert.equal(sw1.qc_flagged, false);
  assert.equal(h.timer("SM_O74_TRAILING_DOC_FOLLOWUP_30")!.anchorDate, D("2027-01-08")); assert.equal(h.timer("SM_O74_TRAILING_DOC_FOLLOWUP_30")!.dueDate, D("2027-02-07"));
  await attempt("2027-02-07", "email"); await attempt("2027-03-09", "phone");
  assert.equal((h.rt.store.get("trailing_documents", `${APP}:final_title_policy`)!.data.followups as unknown[]).length, 4, "at least four logged attempts");
  // Fri Mar 12, 2027 with the final policy still open → SM_O74_TRAILING_DOC_ESCALATE_120 fires to officer (sev 2); the QC file is flagged for 28.2
  const breaches = h.timers.evaluate(mst("2027-03-13", "00:01")); const b = breaches.find((x) => x.def.code === "SM_O74_TRAILING_DOC_ESCALATE_120")!; assert.equal(b.severity, 2); assert.ok(b.escalateTo.includes("officer")); assert.match(b.breachText, /QC file flagged \(28\.2\)/);
  h.at(mst("2027-03-12", "07:00")); const sw = await h.run("registerMin", { op: "sweep", today: "2027-03-12", at: mst("2027-03-12", "07:00") });
  assert.deepEqual(sw.escalate_120, ["final_title_policy"]); assert.equal(sw.qc_flagged, true); assert.ok(sw.escalation_id);
  const esc = h.escalations.list().find((e) => e.id === sw.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.severity, "sev2"); assert.equal(esc.payload.qc_flag, "28.2");
  const qc = h.ofType("qc.file.flagged")[0]!; assert.equal(qc.payload.process, "28.2"); assert.deepEqual(qc.payload.kinds, ["final_title_policy"]);
  assert.equal(h.ofType("trailing_document.escalation_120")[0]!.payload.days_since_funding, 120); assert.ok((h.rt.store.get("trailing_documents", `${APP}:final_title_policy`)!.data.blocks as string[]).includes("qc_file"));
  // the policy then received and passed closes the item; every other item closed/waived → collateral.file.complete satisfies the loan-level clock
  h.at(mst("2027-03-15", "09:00")); await h.run("registerMin", { op: "ingest_final_policy", title_order_id: "TO-FINAL-1", document_id: "DOC-POLICY-1", received_at: mst("2027-03-15", "09:00"), time_zone: TZ_AZ });
  const pr = await h.run("registerMin", { op: "review_final_policy", policy: { ...policy(), amount_cents: "56000000" }, expectations: { ...POLICY_EXPECT, original_principal_cents: "56000000" }, time_zone: TZ_AZ, at: mst("2027-03-15", "10:00"), underwriter_party_id: "P-UW-1" }); assert.equal(pr.result, "pass");
  await refused(h.run("registerMin", { op: "waive_trailing_document", kind: "recorded_security_instrument", reason: "county retains originals" }), "WAIVER_OFFICER_ONLY");
  for (const kind of ["flood_cert", "custodian_certification"]) await h.run("registerMin", { op: "waive_trailing_document", kind, reason: "boarding-time items closed by the officer for the closure test", at: mst("2027-03-15", "10:30") }, OFFICER);
  const c = await h.run("registerMin", { op: "close_trailing_document", kind: "final_title_policy", at: mst("2027-03-15", "10:35") }); assert.equal(c.file_complete, true); assert.equal(h.ofType("collateral.file.complete").length, 1); assert.equal(t120.status, "satisfied_late");
});

test("26.4 worked figures: $560,000.00 note amount on the allonge and the final policy (56_000_000n) pass; a re-drawn $565,000.00 allonge (56_500_000n) refuses shipment; a $555,000.00 policy (55_500_000n) is below the original principal; MERS clocks Nov 19 / Nov 25, policy Jan 8 / Jan 18, 2027, re-record cure Dec 4, LNA decision Nov 24, custodian cure Dec 1, wet note Nov 19 / Nov 25, 120-day escalation Mar 12, 2027", () => {
  // $560,000.00 (56_000_000n): the allonge identifiers match the note and the 2021 ALTA policy covers the original principal
  assert.equal(ensureEndorsement(allonge({ allonge_identifiers: { ...allonge().allonge_identifiers!, note_amount_cents: 56_000_000n } }), { ...NOTE, note_amount_cents: 56_000_000n }).open, true);
  assert.equal(reviewFinalPolicy(policy({ amount_cents: 56_000_000n }), { ...POLICY_EXPECT, original_principal_cents: 56_000_000n }).amount_ok, true);
  // $565,000.00 (56_500_000n) on the allonge against the $560,000.00 note → SM_O74_ENDORSEMENT_BEFORE_SHIP_GATE refuses
  const g = ensureEndorsement(allonge({ allonge_identifiers: { ...allonge().allonge_identifiers!, note_amount_cents: 56_500_000n } }), { ...NOTE, note_amount_cents: 56_000_000n }); assert.equal(g.open, false); assert.deepEqual(g.mismatches, ["note amount 56500000 ≠ 56000000"]);
  // $555,000.00 (55_500_000n) policy amount < $560,000.00 original principal → defect (B7-2-03)
  const r = reviewFinalPolicy(policy({ amount_cents: 55_500_000n }), { ...POLICY_EXPECT, original_principal_cents: 56_000_000n }); assert.equal(r.amount_ok, false); assert.equal(r.result, "defect");
  assert.equal(reviewFinalPolicy(policy({ amount_cents: 56_000_001n }), POLICY_EXPECT).amount_ok, true, "coverage may exceed the principal");
  // the fixture calendar (business_days_creditor / business_days_servicer exclude Veterans Day Nov 11 and Thanksgiving Nov 26, 2026)
  assert.equal(computeMersAnchor({ ...AZ_REFI, transaction_type: "limited_cash_out", note_date: D("2026-11-06"), funding_date: D("2026-11-12") }).registration_due_at, "2026-11-19");
  assert.equal(computeMersAnchor({ ...OH_PURCHASE, transaction_type: "purchase", note_date: D("2026-11-18"), funding_date: D("2026-11-18") }).registration_due_at, "2026-11-25");
  assert.equal(computeMersAnchor({ ...AZ_REFI, transaction_type: "limited_cash_out", note_date: D("2026-11-06"), funding_date: null }).provisional, true, "funding unknown → provisional on the note date, recomputed on loan.funded");
  assert.equal(trailingDueAt("final_title_policy", { recording: { channel: "erecording", recorded_on: D("2026-11-19"), submitted_on: D("2026-11-19") }, note_date: D("2026-11-18") }).due_at, "2027-01-18");
  assert.equal(trailingDueAt("recorded_security_instrument", { recording: { channel: "paper", recorded_on: null, submitted_on: D("2026-11-09") }, note_date: D("2026-11-06") }).due_at, "2027-02-07");
  assert.equal(trailingDueAt("recorded_security_instrument", { recording: { channel: "paper", recorded_on: null, submitted_on: D("2026-11-09"), recording_turnaround_days: 45 }, note_date: D("2026-11-06") }).due_at, "2026-12-24", "county recording_turnaround_days override");
  assert.equal(shipmentPlan(D("2026-11-12")).wet_note_due_on, "2026-11-19"); assert.equal(shipmentPlan(D("2026-11-18")).wet_note_due_on, "2026-11-25");
  assert.equal(nextBatchOn(mst("2026-11-10", "18:30"), TZ_AZ), "2026-11-12", "after the 18:00 batch on Nov 10 the next batch is Thu Nov 12 (Veterans Day)");
});
