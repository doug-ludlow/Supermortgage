// 26.2 eClosing execution (RON, IPEN, hybrid, wet), eNote signing, eVault custody, MERS eRegistry registration, eRecording, and paper-note handling
// spec/sections/26-closing-execution-documents-eclosing-ron-funding-and-post-cl/26-2-eclosing-execution-ron-ipen-hybrid-wet-enote-signing-evault.md
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
import { TOOLS_26_2 } from "../../app/tools/section26-2.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { FakeEvault } from "../../infra/integrations/custody.ts";
import { makeMin } from "../boarding/min.ts";
import { CLOSING_APPOINTMENT_SAMPLE } from "../../notices/authored/section26-2.ts";
import { type ClosingTypeInput, type ExecutedDocument, type ClosingEsignConsent, type EclosingEligibility, FakeERegistry26, SM_ORG_ID, TX_KBA_PARAMS, registrationDueAt, registrationOnTime, decideClosingType, ronStateAuthCheck, evaluateKba, enoteLocationGate, securedPartyGate, assertSecuredPartyBeforeAdvance, AdvanceRefused, auditTrailGate, FundingBlocked, erecordSubmitDue, recordingRejectCureDue, paperFallbackDue, paperNoteHandoffDue, consummationFromSignatures, reviewExecution, deliveryIndicators, recordingGapDays, sha256, TX_PERMITTED_OFFICES } from "./ops-26-2.ts";

const CLOSER: Actor = { kind: "agent", id: "title-closing" };
const toolKey = (process: string, name: string): string => `${process} ${name}`;
const noticeReg = buildRegistry(); publishAuthored(noticeReg);
const PARTNER_ORG = "1001234";
const MIN = makeMin(PARTNER_ORG, "12");
const AGENT = "P-ESCROW-AZ-1";
const AUTHORITATIVE_COPY = "<SMART_DOCUMENT version=\"1.02\"><DATA min=\"" + MIN + "\" amount=\"560000.00\" rate=\"6.125\"/></SMART_DOCUMENT>";
const SEAL = sha256(AUTHORITATIVE_COPY);
const ELIGIBILITY: EclosingEligibility[] = [{ settlement_agent_party_id: AGENT, county_fips: null, ron_capable: true, ipen_capable: true, erecording_submitter: true, platforms: ["Snapdocs"], remote_witness_service: false, verified_at: "2026-10-20T00:00:00Z", verified_by: "title-closing" }];
const CONSENT: ClosingEsignConsent = { consent_id: "CONS-1", kind: "esign", scope: ["disclosures", "closing_package"], granted_at: "2026-10-06T15:00:00Z", withdrawn_at: null, hw_sw_statement_version: "2026-09", access_demonstrated: true, paper_option_disclosed: true };
/** Worked example 1 (Phoenix, AZ refinance RON): the closing-type input with every RON condition satisfied. */
const azRon = (o: Partial<ClosingTypeInput> = {}): ClosingTypeInput => ({ state: "AZ", county_fips: "04013", tx_50a6: false, enote_eligible: true, proposed_closing_type: "ron", borrower_election: null, signers: [{ party_id: "B1", esign_consented: true, identity_proofing_possible: true }, { party_id: "B2", esign_consented: true, identity_proofing_possible: true }], county_accepts_ron_instruments: true, title_no_ron_exception: true, agent: ELIGIBILITY[0]!, ron_provider_available: true, notary: { commission_state: "AZ", physical_location_state: "AZ" }, counsel_confirmation: null, in_person_enotarization_valid: true, ...o });
const GATE_FACTS = { ctc: { ctc_issued: true, checklist_passed: true, decision_status: "active" }, le: { earliest_consummation_date: "2026-10-30" }, cd: { earliest_consummation_date: "2026-11-05", receipts_complete: true }, signing_package: [{ consumer_id: "B1", copies: 2, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }, { consumer_id: "B2", copies: 2, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }], fraud_hold: { fraud_hold: false }, compliance_consummate_gate_open: true, vvoe_within_10bd: true, mi_commitment_valid: true, lock_valid_through_closing: true };

/** The 26.2 bus alone: TOOLS_26_2 bound to the `title-closing` agent over the overridden registry (26.2 rows), escalations, the eVault, the eRegistry fake and the Notice Registry; the application-scoped unit of work stamps `applicationId` on every event. */
function harness(applicationId: string, nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["26.2"] });
  const escalations = new EscalationService(events, clock); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const eregistry = new FakeERegistry26(); const evault = new FakeEvault();
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: { "26.2.eregistry": eregistry }, ports: { evault }, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }) };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const agents = new AgentRegistry(); const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_26_2) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(toolKey(d.process, d.name), cmd); }
  const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = CLOSER): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("26.2", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
  return { clock, events, timers, escalations, rt, uow, run, at, timer, ofType, decisions, eregistry, evault };
}
type H = ReturnType<typeof harness>;
const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
const NOTARY_AZ = { party_id: "N-AZ-1", commission_state: "AZ", commission_number: "AZ-123456", physical_location_state: "AZ" };
/** Schedules the fixture RON closing (Fri Nov 6, 2026 14:00 MST), folds 26.1's release in and passes the pre-session checks. */
async function scheduledRon(h: H, o: Record<string, unknown> = {}): Promise<string> {
  h.at("2026-11-02T17:00:00.000Z");
  const s = await h.run("runPreSessionChecks", { op: "schedule", closing_id: "CLS-1", application_id: "APP-REFI-1", scheduled_at: "2026-11-06T21:00:00.000Z", time_zone: "America/Phoenix", state: "AZ", county_fips: "04013", transaction_type: "limited_cash_out", dry_state: true, settlement_agent_party_id: AGENT, notary_party_id: "N-AZ-1", ron_provider_party_id: "P-RON-1", eligibility: ELIGIBILITY, signers: azRon().signers, ...o });
  await h.run("runPreSessionChecks", { op: "upstream", closing_id: "CLS-1", event: { type: "closing.documents.released", occurredAt: "2026-11-05T22:00:00.000Z", payload: { set_id: "SET-APP-REFI-1-1" } } });
  h.at("2026-11-06T20:30:00.000Z");
  await h.run("verifyEsignConsent", { closing_id: "CLS-1", consent: CONSENT });
  const pre = await h.run("runPreSessionChecks", { closing_id: "CLS-1", consent: CONSENT, facts: GATE_FACTS }); assert.equal(pre.passed, true, JSON.stringify(pre.blocking));
  return String(s.closing_type);
}
/** Opens the fixture session, proofs both signers, signs the eNote at 14:26 MST (consummation) and the deed of trust, and completes the RON acknowledgment 14:36. */
async function signedRon(h: H): Promise<void> {
  h.at("2026-11-06T21:00:00.000Z");
  await h.run("openSigningSession", { closing_id: "CLS-1", session_id: "SES-1", signer_party_ids: ["B1", "B2"], notary: NOTARY_AZ, consent_record_id: "CONS-1" });
  h.at("2026-11-06T21:07:00.000Z"); await h.run("monitorSession", { op: "identity", closing_id: "CLS-1", party_id: "B1", method: "credential_analysis_kba", credential_type: "driver_license", credential_analysis_result: "pass", kba_attempts: [{ questions: 5, correct: 5, seconds: 71, at: "2026-11-06T21:07:00.000Z", notary_party_id: "N-AZ-1" }], notary_party_id: "N-AZ-1", vendor: "Proof" });
  h.at("2026-11-06T21:11:00.000Z"); await h.run("monitorSession", { op: "identity", closing_id: "CLS-1", party_id: "B2", method: "credential_analysis_kba", credential_type: "driver_license", credential_analysis_result: "pass", kba_attempts: [{ questions: 5, correct: 4, seconds: 80, at: "2026-11-06T21:11:00.000Z", notary_party_id: "N-AZ-1" }], notary_party_id: "N-AZ-1", vendor: "Proof" });
  await h.run("monitorSession", { op: "start", closing_id: "CLS-1" });
  await h.run("monitorSession", { op: "enote_created", closing_id: "CLS-1", closing_document_id: "DOC-ENOTE", min: MIN, partner_org_id: PARTNER_ORG });
  await h.run("monitorSession", { op: "sign", closing_id: "CLS-1", closing_document_id: "DOC-1003", kind: "final_1003", signer_party_id: "B1", signed_at: "2026-11-06T21:18:00.000Z", signature_method: "esign_ron", required_note_signers: ["B1"] });
  await h.run("monitorSession", { op: "sign", closing_id: "CLS-1", closing_document_id: "DOC-ENOTE", kind: "enote", signer_party_id: "B1", signed_at: "2026-11-06T21:26:00.000Z", signature_method: "esign_ron", required_note_signers: ["B1"] });
  await h.run("monitorSession", { op: "sign", closing_id: "CLS-1", closing_document_id: "DOC-DOT", kind: "security_instrument", signer_party_id: "B1", signed_at: "2026-11-06T21:31:00.000Z", signature_method: "esign_ron", required_note_signers: ["B1"] });
  await h.run("monitorSession", { op: "sign", closing_id: "CLS-1", closing_document_id: "DOC-DOT", kind: "security_instrument", signer_party_id: "B2", signed_at: "2026-11-06T21:31:30.000Z", signature_method: "esign_ron", required_note_signers: ["B1"] });
  await h.run("monitorSession", { op: "notarial_act", closing_id: "CLS-1", closing_document_id: "DOC-DOT", kind: "security_instrument", act_type: "acknowledgment", completed_at: "2026-11-06T21:36:00.000Z", certificate_indicates_communication_technology: true, recordable: true, last: true, notary_party_id: "N-AZ-1" });
}
/** Tamper seal 14:41 MST (2026-11-06T21:41:00Z); the Authoritative Copy in SM's eVault 14:42; hash validated 14:43. */
async function sealed(h: H, at = "2026-11-06T21:41:00.000Z"): Promise<void> {
  h.at(at); await h.run("validateAuthoritativeCopy", { op: "seal", closing_id: "CLS-1", seal_hash: SEAL, signing_completed_at: "2026-11-06T21:26:00.000Z", authoritative_copy_ref: "EV-1", tamper_sealed_at: at });
  h.at(new Date(Date.parse(at) + 2 * 60_000).toISOString()); const v = await h.run("validateAuthoritativeCopy", { closing_id: "CLS-1", authoritative_copy: AUTHORITATIVE_COPY }); assert.equal(v.gate_open, true, String(v.reason));
}

test("26.2-T1: Given an eNote tamper-sealed Fri Nov 6, 2026 14:41 MST, when `registration_due_at` is computed, then it is Mon Nov 9, 2026 23:59 ET; registration accepted at 14:46 MST satisfies `MERS_PROC_ENOTE_REGISTER_1BD`; an acceptance at Tue Nov 10 00:30 ET breaches it.", async () => {
  // the pure clock: anchor = local (MST) date of the earlier of signing completion (14:26) and the seal (14:41); +1 business_days_federal → Mon Nov 9 (Sat/Sun are not business days), 23:59 ET
  const due = registrationDueAt("2026-11-06T21:41:00.000Z", "2026-11-06T21:26:00.000Z", "America/Phoenix");
  assert.equal(due.anchor_date, "2026-11-06"); assert.equal(due.due_date, "2026-11-09"); assert.equal(due.due_at, "2026-11-10T04:59:00.000Z", "Mon Nov 9, 2026 23:59 ET");
  assert.equal(due.target_at, "2026-11-06T23:41:00.000Z", "SM target: +2 hours");
  assert.equal(registrationOnTime("2026-11-06T21:46:00.000Z", due), true, "accepted 14:46 MST");
  assert.equal(registrationOnTime("2026-11-10T05:30:00.000Z", due), false, "accepted Tue Nov 10 00:30 ET breaches");
  // the bus: seal → the timer arms on the anchor date; acceptance at 14:46 MST satisfies it
  const h = harness("APP-REFI-1", "2026-11-02T17:00:00.000Z"); await scheduledRon(h); await signedRon(h); await sealed(h);
  const t = h.timer("MERS_PROC_ENOTE_REGISTER_1BD")!; assert.equal(t.anchorDate, "2026-11-06"); assert.equal(t.dueDate, "2026-11-09"); assert.equal(t.dueAt, Date.parse("2026-11-10T04:59:00.000Z"));
  assert.equal(h.timer("SM_O72_ENOTE_SAME_DAY_REGISTER")!.dueAt, Date.parse("2026-11-06T23:41:00.000Z"), "policy target +2 hours");
  h.at("2026-11-06T21:44:00.000Z"); const r = await h.run("registerENote", { closing_id: "CLS-1" });
  assert.equal(r.accepted, true); assert.equal(r.registered_at, "2026-11-06T21:46:00.000Z"); assert.equal(r.on_time, true); assert.equal(r.controller_org_id, PARTNER_ORG); assert.equal(r.location_org_id, SM_ORG_ID); assert.equal(r.delegatee_org_id, SM_ORG_ID);
  assert.equal(t.status, "satisfied"); assert.equal(h.timer("SM_O72_ENOTE_SAME_DAY_REGISTER")!.status, "satisfied");
  const reg = h.ofType("enote.registered")[0]!; assert.equal(reg.payload.controller, "partner"); assert.equal(reg.payload.location, "sm_evault"); assert.equal(reg.payload.delegatee, "sm"); assert.equal(reg.applicationId, "APP-REFI-1");
  assert.equal(h.rt.store.get("enotes", "EN-CLS-1")!.data.registration_status, "registered");
  // breach: the same seal, no acceptance until Tue Nov 10 00:30 ET → breached, then satisfied_late with the officer incident
  const b = harness("APP-REFI-1", "2026-11-02T17:00:00.000Z"); await scheduledRon(b); await signedRon(b); await sealed(b);
  b.at("2026-11-10T05:30:00.000Z"); const breaches = b.timers.evaluate("2026-11-10T05:30:00.000Z");
  assert.ok(breaches.some((x) => x.instance.code === "MERS_PROC_ENOTE_REGISTER_1BD" && x.severity === 1 && x.escalateTo.includes("officer")), "sev 1 → officer");
  const late = await b.run("registerENote", { closing_id: "CLS-1" }); assert.equal(late.on_time, false); assert.equal(b.timer("MERS_PROC_ENOTE_REGISTER_1BD")!.status, "satisfied_late");
  assert.ok(b.escalations.list().some((e) => e.kind === "officer" && e.payload.reason === "emortgage_registration_late" && e.payload.severity === 1), "loan flagged emortgage_registration_late");
});

test("26.2-T2: Given a tamper seal at Wed Nov 25, 2026 16:10 EST (day before Thanksgiving), then `registration_due_at` = Fri Nov 27, 2026 23:59 ET (Thu Nov 26 excluded).", () => {
  const due = registrationDueAt("2026-11-25T21:10:00.000Z", "2026-11-25T20:40:00.000Z", "America/New_York");
  assert.equal(due.anchor_date, "2026-11-25"); assert.equal(due.due_date, "2026-11-27", "Thu Nov 26 (Thanksgiving) is not a federal business day"); assert.equal(due.due_at, "2026-11-28T04:59:00.000Z", "Fri Nov 27, 2026 23:59 ET");
  // the engine arms the same date from the seal event's registration_anchor_date (a seal at 23:30 ET still anchors on the ET date of the earlier signing)
  const h = harness("APP-OH-1", "2026-11-25T21:10:00.000Z");
  h.events.append({ type: "enote.tamper_sealed", applicationId: "APP-OH-1", actor: CLOSER, payload: { application_id: "APP-OH-1", registration_anchor_date: due.anchor_date, registration_due_at: due.due_at, seal_hash: SEAL } });
  assert.equal(h.timer("MERS_PROC_ENOTE_REGISTER_1BD")!.dueDate, "2026-11-27"); assert.equal(h.timer("MERS_PROC_ENOTE_REGISTER_1BD")!.dueAt, Date.parse("2026-11-28T04:59:00.000Z"));
  // worked example 2 (Columbus, OH hybrid IPEN): seal Wed Nov 18 10:44 EST → Thu Nov 19 23:59 ET
  assert.equal(registrationDueAt("2026-11-18T15:44:00.000Z", "2026-11-18T15:31:00.000Z", "America/New_York").due_at, "2026-11-20T04:59:00.000Z");
});

test("26.2-T3: Given a Texas 50(a)(6) closing, when `decideClosingType` runs, then `closing_type=wet`, `SM_O72_RON_STATE_AUTH_GATE` reports `product_excluded`, and the location must be a lender/attorney/title-company office.", async () => {
  const d = decideClosingType(azRon({ state: "TX", county_fips: "48453", tx_50a6: true, enote_eligible: false, proposed_closing_type: "wet", notary: { commission_state: "TX", physical_location_state: "TX" } }));
  assert.equal(d.closing_type, "wet"); assert.equal(d.note_form, "paper"); assert.equal(d.enote_indicator, false); assert.equal(d.remote_notarization_indicator, false);
  assert.ok(d.ron.refusals.includes("product_excluded")); assert.deepEqual(d.location_required, ["lender_office", "attorney_office", "title_company"]); assert.deepEqual(TX_PERMITTED_OFFICES, d.location_required);
  assert.match(d.reasons[0]!, /product_excluded:tx_50a6/);
  const g = evaluateGate("26.2.ronStateAuthGate", { state: "TX", tx_50a6: true, closing_type: "ron", signers: azRon().signers, county_accepts_ron_instruments: true, title_no_ron_exception: true, agent: ELIGIBILITY[0], ron_provider_available: true, in_person_enotarization_valid: true, enote_eligible: false });
  assert.equal(g.open, false); assert.match(g.reason!, /product_excluded/);
  // the bus: the tool decides wet; scheduling at the homestead/remotely is refused; a title-company office is accepted
  const h = harness("APP-TX-1", "2026-10-30T17:00:00.000Z");
  const out = await h.run("decideClosingType", { state: "TX", county_fips: "48453", tx_50a6: true, settlement_agent_party_id: "P-TITLE-TX-1", eligibility: [{ ...ELIGIBILITY[0], settlement_agent_party_id: "P-TITLE-TX-1" }], signers: azRon().signers });
  assert.equal(out.closing_type, "wet"); assert.ok((out.ron as { refusals: string[] }).refusals.includes("product_excluded"));
  const base = { op: "schedule", closing_id: "CLS-TX", application_id: "APP-TX-1", scheduled_at: "2026-11-06T16:00:00.000Z", time_zone: "America/Chicago", state: "TX", tx_50a6: true, transaction_type: "cash_out", settlement_agent_party_id: "P-TITLE-TX-1", eligibility: [{ ...ELIGIBILITY[0], settlement_agent_party_id: "P-TITLE-TX-1" }] };
  await refused(h.run("runPreSessionChecks", { ...base, location_type: "remote" }), "TX_50A6_OFFICE_ONLY");
  await assert.rejects(h.run("runPreSessionChecks", { ...base, location_type: "settlement_agent_office" }), /permanent office of the lender, an attorney or a title company/);
  const ok = await h.run("runPreSessionChecks", { ...base, location_type: "title_company" }); assert.equal(ok.closing_type, "wet"); assert.equal(ok.note_form, "paper");
  assert.equal(h.ofType("closing.scheduled")[0]!.payload.tx_50a6, true); assert.equal(h.ofType("closing.scheduled")[0]!.payload.closing_type, "wet");
  assert.equal(h.timer("SM_O72_RON_STATE_AUTH_GATE"), undefined, "no RON gate arms for a wet closing"); assert.equal(h.timer("SM_O72_ESIGN_CONSENT_CLOSING_GATE"), undefined);
});

test("26.2-T4: Given a Georgia property, then RON is refused with reason `state_not_on_fnma_list` unless a counsel confirmation record exists.", async () => {
  const ga = azRon({ state: "GA", county_fips: "13121", notary: { commission_state: "GA", physical_location_state: "GA" }, agent: { ...ELIGIBILITY[0]!, remote_witness_service: true } });
  const r = ronStateAuthCheck(ga); assert.equal(r.eligible, false); assert.ok(r.refusals.includes("state_not_on_fnma_list")); assert.equal(r.rule.fnma_listed, false);
  assert.equal(decideClosingType(ga).closing_type, "ipen", "IPEN offered when RON is refused and the agent is IPEN-capable");
  // Georgia's one-witness rule (memo) needs remote witnessing the state has not authorized — counsel confirmation alone removes only the list refusal
  const withCounsel = ronStateAuthCheck({ ...ga, counsel_confirmation: { opinion_id: "OP-GA-2026-1", issued_on: D("2026-10-01"), counsel: "Partner Counsel LLP", conclusion: "expressly_permits" } });
  assert.ok(!withCounsel.refusals.includes("state_not_on_fnma_list")); assert.equal(withCounsel.counsel_confirmed, true); assert.deepEqual(withCounsel.refusals, ["witness_not_remote"]);
  const ms = ronStateAuthCheck(azRon({ state: "MS", notary: { commission_state: "MS", physical_location_state: "MS" } })); assert.deepEqual(ms.refusals, ["state_not_on_fnma_list"]);
  assert.equal(ronStateAuthCheck({ ...azRon({ state: "MS", notary: { commission_state: "MS", physical_location_state: "MS" } }), counsel_confirmation: { opinion_id: "OP-MS-1", issued_on: D("2026-10-01"), counsel: "Partner Counsel LLP", conclusion: "expressly_permits" } }).eligible, true, "Mississippi with a counsel opinion and no witness rule → RON");
  const g = evaluateGate("26.2.ronStateAuthGate", { state: "GA", closing_type: "ron", signers: ga.signers, county_accepts_ron_instruments: true, title_no_ron_exception: true, agent: ga.agent, ron_provider_available: true, in_person_enotarization_valid: true, enote_eligible: true }); assert.match(g.reason!, /state_not_on_fnma_list/);
  // the bus: the guardrail refuses treating GA as RON-eligible without counsel; checkRonEligibility records the refusal event
  const h = harness("APP-GA-1", "2026-10-30T17:00:00.000Z");
  await refused(h.run("decideClosingType", { state: "GA", settlement_agent_party_id: AGENT, eligibility: ELIGIBILITY, proposed_closing_type: "ron", treat_as_ron_eligible: true }), "UNLISTED_STATE_NEEDS_COUNSEL");
  await h.run("runPreSessionChecks", { op: "schedule", closing_id: "CLS-GA", application_id: "APP-GA-1", scheduled_at: "2026-11-06T16:00:00.000Z", time_zone: "America/New_York", state: "GA", county_fips: "13121", transaction_type: "purchase", settlement_agent_party_id: AGENT, notary_party_id: "N-GA-1", eligibility: ELIGIBILITY, signers: ga.signers, borrower_election: "ron", proposed_closing_type: "ron" });
  const c = await h.run("checkRonEligibility", { closing_id: "CLS-GA", signers: ga.signers, notary: { commission_state: "GA", physical_location_state: "GA" } });
  assert.equal(c.ron_eligible, false); assert.ok((c.ron_refusals as string[]).includes("state_not_on_fnma_list")); assert.deepEqual(c.offered_alternatives, ["ipen", "hybrid", "wet"]);
  assert.equal(h.ofType("closing.eligibility.checked").find((e) => e.payload.check === "ron_state_auth")!.payload.result, "refused");
});

test("26.2-T5: Given a borrower who fails KBA twice within the session in Texas, then the session status is `failed{identity}` and no retake is offered with the same notary for 24 hours; a wet/IPEN reschedule is proposed.", async () => {
  // 1 TAC §87.70: 5 questions, 2 minutes, 80 %; one retake within 24 hours with ≥ 60 % new questions
  const a1 = { questions: 5, correct: 3, seconds: 95, at: "2026-11-06T16:10:00.000Z", notary_party_id: "N-TX-1" }, a2 = { questions: 5, correct: 3, seconds: 110, at: "2026-11-06T16:16:00.000Z", notary_party_id: "N-TX-1", new_question_pct: 60 };
  assert.equal(evaluateKba([a1], TX_KBA_PARAMS).result, "retake_allowed"); assert.equal(evaluateKba([a1], TX_KBA_PARAMS).retake_deadline, "2026-11-07T16:10:00.000Z");
  const k = evaluateKba([a1, a2], TX_KBA_PARAMS); assert.equal(k.result, "failed_identity"); assert.equal(k.attempts, 2); assert.equal(k.retake_blocked_until, "2026-11-07T16:16:00.000Z", "24 hours after the second failure");
  assert.equal(evaluateKba([a1, { ...a2, correct: 4 }], TX_KBA_PARAMS).result, "pass", "4/5 on the retake passes"); assert.equal(evaluateKba([a1, { ...a2, correct: 5, new_question_pct: 40 }], TX_KBA_PARAMS).result, "failed_identity", "retake with < 60 % new questions is not a valid retake");
  assert.equal(evaluateKba([{ ...a1, correct: 5, seconds: 130 }], TX_KBA_PARAMS).result, "retake_allowed", "over two minutes fails the attempt");
  // the bus: a Texas RON purchase (not 50(a)(6)); the second failure fails the session, blocks the notary for 24 hours and proposes wet/IPEN
  const h = harness("APP-TX-2", "2026-11-02T17:00:00.000Z");
  await h.run("runPreSessionChecks", { op: "schedule", closing_id: "CLS-TX2", application_id: "APP-TX-2", scheduled_at: "2026-11-06T16:00:00.000Z", time_zone: "America/Chicago", state: "TX", county_fips: "48453", transaction_type: "purchase", rescindable: false, settlement_agent_party_id: AGENT, notary_party_id: "N-TX-1", eligibility: ELIGIBILITY, signers: [{ party_id: "B1", esign_consented: true, identity_proofing_possible: true }], notary: { commission_state: "TX", physical_location_state: "TX" } });
  await h.run("runPreSessionChecks", { op: "upstream", closing_id: "CLS-TX2", event: { type: "closing.documents.released", occurredAt: "2026-11-05T22:00:00.000Z", payload: { set_id: "SET-TX2" } } });
  h.at("2026-11-06T15:30:00.000Z"); await h.run("verifyEsignConsent", { closing_id: "CLS-TX2", consent: CONSENT }); assert.equal((await h.run("runPreSessionChecks", { closing_id: "CLS-TX2", consent: CONSENT, facts: { ...GATE_FACTS, signing_package: [] } })).passed, true);
  h.at("2026-11-06T16:00:00.000Z"); await h.run("openSigningSession", { closing_id: "CLS-TX2", session_id: "SES-TX2", signer_party_ids: ["B1"], notary: { party_id: "N-TX-1", commission_state: "TX", commission_number: "TX-1", physical_location_state: "TX" }, consent_record_id: "CONS-1" });
  h.at("2026-11-06T16:10:00.000Z"); const first = await h.run("monitorSession", { op: "identity", closing_id: "CLS-TX2", party_id: "B1", method: "credential_analysis_kba", credential_analysis_result: "pass", kba_attempts: [a1], notary_party_id: "N-TX-1" });
  assert.equal(first.result, "retake_offered"); assert.equal(first.status, "consent_captured");
  h.at("2026-11-06T16:16:00.000Z"); const second = await h.run("monitorSession", { op: "identity", closing_id: "CLS-TX2", party_id: "B1", method: "credential_analysis_kba", credential_analysis_result: "pass", kba_attempts: [a1, a2], notary_party_id: "N-TX-1" });
  assert.equal(second.status, "failed"); assert.equal(second.failure_reason, "identity"); assert.equal(second.retake_blocked_until, "2026-11-07T16:16:00.000Z"); assert.deepEqual(second.reschedule_proposal, ["wet", "ipen"]);
  const f = h.ofType("closing.session.failed")[0]!; assert.equal(f.payload.reason, "identity"); assert.equal(f.payload.retake_blocked_notary_party_id, "N-TX-1");
  assert.equal(h.rt.store.get("closings", "CLS-TX2")!.data.execution_status, "session_failed");
  h.at("2026-11-06T18:00:00.000Z"); await assert.rejects(h.run("assignNotary", { closing_id: "CLS-TX2", notary_party_id: "N-TX-1", commission_state: "TX", physical_location_state: "TX", commission_verified: true }), /blocked until 2026-11-07T16:16:00.000Z/);
  await assert.rejects(h.run("monitorSession", { op: "start", closing_id: "CLS-TX2" }), /is failed/);
  await refused(h.run("monitorSession", { op: "identity", closing_id: "CLS-TX2", party_id: "B1", method: "credential_analysis_kba", kba_override: true, notary_party_id: "N-TX-1" }), "NO_KBA_OVERRIDE");
  const rs = await h.run("monitorSession", { op: "reschedule", closing_id: "CLS-TX2", scheduled_at: "2026-11-09T16:00:00.000Z", closing_type: "ipen", reason: "identity failure — IPEN at the title office" }); assert.equal(rs.closing_type, "ipen"); assert.equal(rs.execution_status, "rescheduled");
  assert.equal(decideClosingType(azRon({ state: "TX", session_failure: true, notary: { commission_state: "TX", physical_location_state: "TX" } })).closing_type, "ipen");
});

test("26.2-T6: Given the eVault copy hash ≠ the platform seal hash, then `SM_O72_ENOTE_LOCATION_GATE` stays closed and no Registration XML is sent.", async () => {
  const bad = sha256("a different copy");
  const g = enoteLocationGate({ tamper_seal_hash: SEAL, evault_copy_hash: bad }); assert.equal(g.open, false); assert.equal(g.hash_match, false); assert.match(g.reason!, /registration request not sent/);
  assert.equal(enoteLocationGate({ tamper_seal_hash: SEAL, evault_copy_hash: SEAL }).open, true); assert.equal(enoteLocationGate({ tamper_seal_hash: SEAL, evault_copy_hash: SEAL, evault_status: "tampered" }).open, false);
  assert.equal(evaluateGate("26.2.enoteLocationGate", { tamper_seal_hash: SEAL, evault_copy_hash: bad }).open, false);
  const h = harness("APP-REFI-1", "2026-11-02T17:00:00.000Z"); await scheduledRon(h); await signedRon(h);
  h.at("2026-11-06T21:41:00.000Z"); await h.run("validateAuthoritativeCopy", { op: "seal", closing_id: "CLS-1", seal_hash: SEAL, signing_completed_at: "2026-11-06T21:26:00.000Z", tamper_sealed_at: "2026-11-06T21:41:00.000Z" });
  assert.equal(h.timer("SM_O72_ENOTE_LOCATION_GATE")!.status, "armed");
  h.at("2026-11-06T21:43:00.000Z"); const v = await h.run("validateAuthoritativeCopy", { closing_id: "CLS-1", authoritative_copy: "<SMART_DOCUMENT>altered</SMART_DOCUMENT>" });
  assert.equal(v.gate_open, false); assert.equal(v.hash_match, false); assert.equal(h.ofType("enote.authoritative_copy.validated")[0]!.payload.hash_match, false);
  assert.equal(h.timer("SM_O72_ENOTE_LOCATION_GATE")!.status, "armed", "the gate stays closed");
  await assert.rejects(h.run("registerENote", { closing_id: "CLS-1" }), /registerENote refused/);
  assert.equal(h.eregistry.requests.length, 0, "no Registration XML sent"); assert.equal(h.ofType("enote.registered").length, 0);
  await refused(h.run("registerENote", { closing_id: "CLS-1", hash_mismatch: true }), "HASH_MUST_MATCH");
  // the genuine copy validates, the gate opens and the registration goes out
  h.at("2026-11-06T21:44:00.000Z"); const ok = await h.run("validateAuthoritativeCopy", { closing_id: "CLS-1", authoritative_copy: AUTHORITATIVE_COPY }); assert.equal(ok.hash_match, true); assert.equal(h.timer("SM_O72_ENOTE_LOCATION_GATE")!.status, "satisfied");
  const r = await h.run("registerENote", { closing_id: "CLS-1" }); assert.equal(r.accepted, true); assert.equal(h.eregistry.requests.length, 1);
});

test("26.2-T7: Given a warehouse advance requested on an eNote loan before `enote.secured_party.set`, then the advance is refused with reason `secured_party_missing`.", async () => {
  assert.deepEqual(securedPartyGate({ note_form: "enote", secured_party_org_id: null, registration_status: "registered" }), { open: false, reason: "secured_party_missing" });
  assert.deepEqual(securedPartyGate({ note_form: "enote", secured_party_org_id: SM_ORG_ID, registration_status: "registered" }), { open: true, reason: null });
  assert.deepEqual(securedPartyGate({ note_form: "paper", secured_party_org_id: null }), { open: true, reason: null }, "no Secured Party role on a paper note (Interim Funder instead — 26.4)");
  assert.throws(() => assertSecuredPartyBeforeAdvance({ secured_party_org_id: null, registration_status: "registered" }, "enote"), (e: unknown) => e instanceof AdvanceRefused && e.code === "secured_party_missing");
  assert.match(evaluateGate("26.2.securedPartyGate", { note_form: "enote", secured_party_org_id: null, registration_status: "registered" }).reason!, /secured_party_missing/);
  const h = harness("APP-REFI-1", "2026-11-02T17:00:00.000Z"); await scheduledRon(h); await signedRon(h); await sealed(h); h.at("2026-11-06T21:44:00.000Z"); await h.run("registerENote", { closing_id: "CLS-1" });
  assert.equal(h.timer("SM_O72_SECURED_PARTY_BEFORE_ADVANCE_GATE")!.status, "armed", "armed by enote.registered");
  h.at("2026-11-09T14:30:00.000Z"); await assert.rejects(h.run("setSecuredParty", { op: "advance_check", closing_id: "CLS-1" }), (e: unknown) => e instanceof AdvanceRefused && e.code === "secured_party_missing");
  await refused(h.run("setSecuredParty", { closing_id: "CLS-1", secured_party_org_id: "1000010" }), "SECURED_PARTY_IS_SM");
  // worked example 1: Change Data (Secured Party = SM) Mon Nov 9 08:05 MST, before the Thu Nov 12 dry-state advance
  h.at("2026-11-09T15:05:00.000Z"); const sp = await h.run("setSecuredParty", { closing_id: "CLS-1" }); assert.equal(sp.accepted, true); assert.equal(sp.secured_party_org_id, SM_ORG_ID);
  assert.equal(h.timer("SM_O72_SECURED_PARTY_BEFORE_ADVANCE_GATE")!.status, "satisfied"); assert.equal(h.ofType("enote.secured_party.set")[0]!.payload.secured_party, "sm");
  h.at("2026-11-12T16:00:00.000Z"); const adv = await h.run("setSecuredParty", { op: "advance_check", closing_id: "CLS-1" }); assert.equal(adv.advance_allowed, true);
  assert.equal((await h.eregistry.inquiry(MIN))!.secured_party_org_id, SM_ORG_ID);
});

test("26.2-T8: Given the fixture RON session, when the audit trail has not arrived by the funding request on Thu Nov 12, then `funding.authorize` is refused until `closing.audit_trail.received`.", async () => {
  const closed = auditTrailGate({ closing_type: "ron", audit_trail_received_at: null, audit_trail_hash: null, platform_hash: null, recording_ref: null, recording_custodian: null }); assert.equal(closed.open, false); assert.match(closed.reason!, /funding.authorize refused/);
  assert.equal(auditTrailGate({ closing_type: "wet", audit_trail_received_at: null, audit_trail_hash: null, platform_hash: null, recording_ref: null, recording_custodian: null }).open, true, "no audit trail on a wet closing");
  const h = harness("APP-REFI-1", "2026-11-02T17:00:00.000Z"); await scheduledRon(h); await signedRon(h); await sealed(h);
  assert.equal(h.timer("SM_O72_AUDIT_TRAIL_BEFORE_FUNDING_GATE")!.status, "armed", "armed by the last notarial act");
  h.at("2026-11-12T15:00:00.000Z");
  await assert.rejects(h.run("ingestAuditTrail", { op: "funding_check", closing_id: "CLS-1", command: "funding.authorize" }), (e: unknown) => e instanceof FundingBlocked && e.command === "funding.authorize" && /closing.audit_trail.received not on file/.test(e.message));
  await refused(h.run("ingestAuditTrail", { closing_id: "CLS-1", authorize_funding_without_audit_trail: true }), "NO_FUNDING_BEFORE_AUDIT_TRAIL");
  assert.equal(evaluateGate("26.2.auditTrailBeforeFundingGate", await h.run("writeDecision", { op: "gate_facts", closing_id: "CLS-1" })).open, false);
  // a mismatched hash is not accepted; the genuine tamper-sealed audit trail (received 15:05 in the worked example) opens the gate
  const trail = sha256("audit-trail-SES-1");
  await assert.rejects(h.run("ingestAuditTrail", { closing_id: "CLS-1", document_id: "DOC-AT-1", audit_trail_hash: sha256("x"), platform_hash: trail, recording_ref: "REC-PROOF-991" }), /does not match the platform/);
  const r = await h.run("ingestAuditTrail", { closing_id: "CLS-1", document_id: "DOC-AT-1", audit_trail_hash: trail, platform_hash: trail, recording_ref: "REC-PROOF-991", journal_ref: "J-2026-1187" });
  assert.equal(r.recording_custodian, "ron_provider"); assert.equal(r.recording_retention_years, 5, "A.R.S. §41-263: at least five years"); assert.equal(r.retention_class, "fnma_enote_signing_life_plus_7y");
  assert.equal(h.timer("SM_O72_AUDIT_TRAIL_BEFORE_FUNDING_GATE")!.status, "satisfied"); assert.equal(h.ofType("closing.audit_trail.received")[0]!.payload.hash_verified, true);
  const ok = await h.run("ingestAuditTrail", { op: "funding_check", closing_id: "CLS-1" }); assert.equal(ok.funding_allowed, true);
  assert.equal(evaluateGate("26.2.auditTrailBeforeFundingGate", await h.run("writeDecision", { op: "gate_facts", closing_id: "CLS-1" })).open, true);
  assert.equal(h.rt.store.get("documents", "DOC-AT-1")!.data.retention_class, "fnma_enote_signing_life_plus_7y");
});

test("26.2-T9: Given a deed of trust notarized Fri Nov 6 in a dry state under the record-after-signing default, then `SM_O72_ERECORD_SUBMIT_1BD` is satisfied by a submission on Mon Nov 9 and breached on Tue Nov 10.", async () => {
  assert.equal(erecordSubmitDue(D("2026-11-06")), "2026-11-09");
  const h = harness("APP-REFI-1", "2026-11-02T17:00:00.000Z"); await scheduledRon(h); await signedRon(h);
  const act = h.ofType("closing.notarial_act.completed")[0]!; assert.equal(act.payload.recording_anchor, true); assert.equal(act.payload.anchor_date, "2026-11-06"); assert.equal(act.payload.erecord_due, "2026-11-09");
  const t = h.timer("SM_O72_ERECORD_SUBMIT_1BD")!; assert.equal(t.anchorDate, "2026-11-06"); assert.equal(t.dueDate, "2026-11-09");
  // worked example 1: the escrow agent submits to Maricopa County Mon Nov 9 08:30 MST; recorded 10:12 with gap_days 0 against a Date of Policy of Nov 9
  h.at("2026-11-09T15:30:00.000Z"); const o = await h.run("submitERecording", { op: "open", closing_id: "CLS-1", recording_id: "REC-1", closing_document_id: "DOC-DOT", county: "Maricopa", county_covered: true, anchor_date: "2026-11-06", date_of_policy: "2026-11-09" });
  assert.equal(o.channel, "erecording"); assert.equal(o.due_date, "2026-11-09"); assert.equal(o.pria_model, "model_2_image_index");
  const s = await h.run("submitERecording", { closing_id: "CLS-1", recording_id: "REC-1" }); assert.equal(s.status, "accepted"); assert.equal(s.on_time, true); assert.equal(t.status, "satisfied");
  h.at("2026-11-09T17:12:00.000Z"); const c = await h.run("submitERecording", { op: "confirm", closing_id: "CLS-1", recording_id: "REC-1", instrument_number: "20261109-0412345", recording_fee_cents: "3400" });
  assert.equal(c.gap_days, 0); assert.equal(c.covered_risk_14_applies, false); assert.equal(h.ofType("recording.confirmed")[0]!.payload.channel, "erecording"); assert.equal(recordingGapDays("2026-11-12T17:00:00.000Z", D("2026-11-09"), "America/Phoenix"), 3);
  // breach: nothing submitted by Tue Nov 10
  const b = harness("APP-REFI-1", "2026-11-02T17:00:00.000Z"); await scheduledRon(b); await signedRon(b);
  const breaches = b.timers.evaluate("2026-11-10T14:00:00.000Z"); assert.ok(breaches.some((x) => x.instance.code === "SM_O72_ERECORD_SUBMIT_1BD" && x.escalateTo.includes("settlement_agent")));
  assert.equal(b.timer("SM_O72_ERECORD_SUBMIT_1BD")!.status, "breached");
});

test("26.2-T10: Given an eRecording rejection on Mon Nov 9 10:30 for a missing cover sheet, then a corrected submission accepted by Wed Nov 11 close satisfies `SM_O72_RECORDING_REJECT_CURE_2BD` (Veterans Day is not a creditor business day — the due date is Thu Nov 12); a paper fallback dispatched instead starts `SM_O72_PAPER_FALLBACK_5BD`.", async () => {
  assert.equal(recordingRejectCureDue(D("2026-11-09")), "2026-11-12", "Tue Nov 10, (Wed Nov 11 Veterans Day skipped), Thu Nov 12"); assert.equal(paperFallbackDue(D("2026-11-09")), "2026-11-17");
  const rejected = async (): Promise<H> => { const h = harness("APP-REFI-1", "2026-11-02T17:00:00.000Z"); await scheduledRon(h); await signedRon(h);
    h.at("2026-11-09T15:30:00.000Z"); await h.run("submitERecording", { op: "open", closing_id: "CLS-1", recording_id: "REC-1", closing_document_id: "DOC-DOT", county: "Maricopa", county_covered: true, anchor_date: "2026-11-06" }); await h.run("submitERecording", { closing_id: "CLS-1", recording_id: "REC-1" });
    h.at("2026-11-09T17:30:00.000Z"); const r = await h.run("handleRecordingReject", { closing_id: "CLS-1", recording_id: "REC-1", reason: "missing_cover_sheet" });
    assert.equal(r.cure_due, "2026-11-12"); assert.equal(r.cure, "add the county cover sheet and resubmit"); assert.equal(h.timer("SM_O72_RECORDING_REJECT_CURE_2BD")!.dueDate, "2026-11-12"); assert.equal(h.timer("SM_O72_RECORDING_REJECT_CURE_2BD")!.anchorDate, "2026-11-09");
    assert.ok(h.escalations.list().some((e) => e.kind === "settlement_agent" && e.payload.reason === "recording_rejected")); return h; };
  // cure path: corrected resubmission accepted Wed Nov 11 22:00 UTC (before close of Nov 12)
  const h = await rejected(); h.at("2026-11-11T22:00:00.000Z"); const s = await h.run("submitERecording", { closing_id: "CLS-1", recording_id: "REC-1", package_ref: "PKG-REC-1-2" });
  assert.equal(s.resubmitted_count, 1); assert.equal(h.ofType("recording.resubmission.accepted").length, 1); assert.equal(h.timer("SM_O72_RECORDING_REJECT_CURE_2BD")!.status, "satisfied");
  // fallback path: a paper package dispatched instead starts the 5-BD county-receipt clock and cancels the cure clock
  const p = await rejected(); p.at("2026-11-09T20:00:00.000Z"); await refused(p.run("dispatchPaperRecording", { closing_id: "CLS-1", recording_id: "REC-1", tracking_ref: "1Z999", disable_paper_fallback: true }), "PAPER_FALLBACK_NEVER_DISABLED");
  const f = await p.run("dispatchPaperRecording", { closing_id: "CLS-1", recording_id: "REC-1", tracking_ref: "1Z999AA10123456784" });
  assert.equal(f.county_receipt_due, "2026-11-17"); assert.equal(p.timer("SM_O72_PAPER_FALLBACK_5BD")!.dueDate, "2026-11-17"); assert.equal(p.timer("SM_O72_RECORDING_REJECT_CURE_2BD")!.status, "cancelled");
  assert.equal(p.ofType("recording.paper_fallback")[0]!.payload.tracking_ref, "1Z999AA10123456784"); assert.ok(p.ofType("recording.submitted").some((e) => e.payload.channel === "paper"), "26.4's SM_O74_RECORDED_SI_PAPER_90 trigger");
  p.at("2026-11-13T18:00:00.000Z"); await p.run("dispatchPaperRecording", { op: "county_receipt", closing_id: "CLS-1", recording_id: "REC-1", evidence_document_id: "DOC-RCPT" }); assert.equal(p.timer("SM_O72_PAPER_FALLBACK_5BD")!.status, "satisfied");
});

test("26.2-T11: Given a wet-signed paper note on Wed Nov 18, then a courier scan by Thu Nov 19 satisfies `SM_O72_PAPER_NOTE_HANDOFF_1BD` and `custody_records.chain` shows settlement_agent → courier with the tracking reference.", async () => {
  assert.equal(paperNoteHandoffDue(D("2026-11-18")), "2026-11-19");
  // worked example 3: South Carolina purchase at the closing attorney's office (two witnesses on the mortgage), paper note Form 3200 wet-signed Wed Nov 18
  const h = harness("APP-SC-1", "2026-11-12T17:00:00.000Z");
  const s = await h.run("runPreSessionChecks", { op: "schedule", closing_id: "CLS-SC", application_id: "APP-SC-1", scheduled_at: "2026-11-18T16:00:00.000Z", time_zone: "America/New_York", state: "SC", county_fips: "45079", transaction_type: "purchase", settlement_agent_party_id: "P-ATTY-SC-1", notary_party_id: "N-SC-1", location_type: "attorney_office", borrower_election: "wet", eligibility: [], signers: [{ party_id: "B1", esign_consented: false, identity_proofing_possible: true }], rescindable: false });
  assert.equal(s.closing_type, "wet"); assert.equal(s.note_form, "paper");
  await h.run("runPreSessionChecks", { op: "upstream", closing_id: "CLS-SC", event: { type: "closing.documents.released", occurredAt: "2026-11-16T22:00:00.000Z", payload: { set_id: "SET-SC" } } });
  h.at("2026-11-18T15:30:00.000Z"); assert.equal((await h.run("runPreSessionChecks", { closing_id: "CLS-SC", facts: { ...GATE_FACTS, signing_package: [] } })).passed, true, "no E-SIGN consent needed on the wet path");
  h.at("2026-11-18T16:00:00.000Z"); await h.run("openSigningSession", { closing_id: "CLS-SC", session_id: "SES-SC", signer_party_ids: ["B1"], notary: { party_id: "N-SC-1", commission_state: "SC", commission_number: "SC-1", physical_location_state: "SC" } });
  await h.run("monitorSession", { op: "start", closing_id: "CLS-SC" });
  const sig = await h.run("monitorSession", { op: "sign", closing_id: "CLS-SC", closing_document_id: "DOC-NOTE", kind: "note", signer_party_id: "B1", signed_at: "2026-11-18T16:30:00.000Z", signature_method: "wet", required_note_signers: ["B1"] });
  assert.equal(sig.consummation_on, "2026-11-18"); const cons = h.ofType("closing.consummated")[0]!; assert.equal(cons.payload.note_form, "paper"); assert.equal(cons.payload.anchor_date, "2026-11-18", "MERS MOM anchor: note date for a purchase outside escrow states (26.4)");
  const t = h.timer("SM_O72_PAPER_NOTE_HANDOFF_1BD")!; assert.equal(t.anchorDate, "2026-11-18"); assert.equal(t.dueDate, "2026-11-19");
  await assert.rejects(h.run("monitorSession", { op: "sign", closing_id: "CLS-SC", closing_document_id: "DOC-NOTE", kind: "note", signer_party_id: "B1", signature_method: "esign", required_note_signers: ["B1"] }), /single-method/);
  const k = await h.run("seedCustodyRecord", { closing_id: "CLS-SC", custodian_party_id: "P-FCC-2017" }); assert.equal(k.note_location, "settlement_agent"); assert.equal(k.handoff_due, "2026-11-19");
  await refused(h.run("trackPaperNote", { closing_id: "CLS-SC", tracking_ref: "x", convert_paper_to_enote: true }), "PAPER_NEVER_CONVERTED");
  h.at("2026-11-18T21:45:00.000Z"); const ship = await h.run("trackPaperNote", { op: "shipped", closing_id: "CLS-SC", tracking_ref: "794644790132", courier_party_id: "P-FEDEX" });
  assert.equal(ship.note_location, "courier"); assert.equal(ship.on_time, true); assert.equal(t.status, "satisfied");
  const chain = ship.chain as { holder_role: string; holder_party_id: string; tracking_ref: string | null; to_at: string | null }[];
  assert.deepEqual(chain.map((l) => [l.holder_role, l.tracking_ref]), [["settlement_agent", null], ["courier", "794644790132"]]); assert.equal(chain[0]!.holder_party_id, "P-ATTY-SC-1"); assert.equal(chain[0]!.to_at, "2026-11-18T21:45:00.000Z");
  assert.equal(h.ofType("custody.paper_note.shipped")[0]!.payload.tracking_ref, "794644790132");
  h.at("2026-11-19T15:05:00.000Z"); const rcv = await h.run("trackPaperNote", { op: "received", closing_id: "CLS-SC", tracking_ref: "794644790132" }); assert.equal(rcv.note_location, "warehouse_custodian"); assert.equal(rcv.original_received_at, "2026-11-19T15:05:00.000Z"); assert.equal(h.ofType("custody.paper_note.received").length, 1);
});

test("26.2-T12: Given the same session signs the eNote at 23:58 local and the deed of trust at 00:04 the next day, then `consummation_at` and the note date remain the first day and 25.3's period is anchored there; an eNote signed after midnight triggers a re-draw.", async () => {
  const enote = { closing_document_id: "DOC-ENOTE", kind: "enote", signed_at: "2026-11-07T06:58:00.000Z", signer_party_id: "B1", required: true, signature_method: "esign_ron" as const };
  const dot = { closing_document_id: "DOC-DOT", kind: "security_instrument", signed_at: "2026-11-07T07:04:00.000Z", signer_party_id: "B1", required: true, signature_method: "esign_ron" as const };
  const r = consummationFromSignatures([enote, dot], D("2026-11-06"), "America/Phoenix", ["B1"]);
  assert.equal(r.consummation_at, "2026-11-07T06:58:00.000Z", "23:58 MST Nov 6"); assert.equal(r.consummation_on, "2026-11-06"); assert.equal(r.note_date, "2026-11-06"); assert.equal(r.redraw_required, false); assert.deepEqual(r.ancillaries_after_midnight, ["DOC-DOT"]);
  const late = consummationFromSignatures([{ ...enote, signed_at: "2026-11-07T07:04:00.000Z" }], D("2026-11-06"), "America/Phoenix", ["B1"]);
  assert.equal(late.redraw_required, true); assert.equal(late.redraw_reason, "date_change"); assert.equal(late.consummation_on, "2026-11-07");
  assert.equal(consummationFromSignatures([enote], D("2026-11-06"), "America/Phoenix", ["B1", "B3"]).note_fully_signed, false, "consummation only at the final required signature");
  // the bus: the consummation event carries the local date 25.3 anchors on; the after-midnight eNote is refused with a re-draw
  const h = harness("APP-REFI-1", "2026-11-02T17:00:00.000Z"); await scheduledRon(h);
  h.at("2026-11-07T06:00:00.000Z"); await h.run("openSigningSession", { closing_id: "CLS-1", session_id: "SES-1", signer_party_ids: ["B1"], notary: NOTARY_AZ, consent_record_id: "CONS-1" });
  await h.run("monitorSession", { op: "identity", closing_id: "CLS-1", party_id: "B1", method: "credential_analysis_kba", credential_analysis_result: "pass", kba_attempts: [{ questions: 5, correct: 5, seconds: 60, at: "2026-11-07T06:10:00.000Z", notary_party_id: "N-AZ-1" }], notary_party_id: "N-AZ-1" });
  await h.run("monitorSession", { op: "start", closing_id: "CLS-1" });
  const s = await h.run("monitorSession", { op: "sign", closing_id: "CLS-1", closing_document_id: "DOC-ENOTE", kind: "enote", signer_party_id: "B1", signed_at: "2026-11-07T06:58:00.000Z", signature_method: "esign_ron", required_note_signers: ["B1"] });
  assert.equal(s.consummation_at, "2026-11-07T06:58:00.000Z"); assert.equal(s.consummation_on, "2026-11-06"); assert.equal(s.note_date, "2026-11-06");
  const d = await h.run("monitorSession", { op: "sign", closing_id: "CLS-1", closing_document_id: "DOC-DOT", kind: "security_instrument", signer_party_id: "B1", signed_at: "2026-11-07T07:04:00.000Z", signature_method: "esign_ron", required_note_signers: ["B1"] });
  assert.equal(d.consummation_on, "2026-11-06", "the note date stands; ancillaries after midnight do not move it");
  const cons = h.ofType("closing.consummated")[0]!; assert.equal(cons.payload.consummation_date_local, "2026-11-06"); assert.equal(cons.payload.consummation_on, "2026-11-06"); assert.equal(cons.payload.note_date, "2026-11-06"); assert.equal(cons.occurredAt, "2026-11-07T06:58:00.000Z");
  assert.equal(h.timer("SM_O72_POST_SIGNING_REVIEW_4H")!.dueAt, Date.parse("2026-11-09T14:00:00.000Z"), "an evening session's review is due the next creditor business morning (Mon Nov 9 09:00 ET)");
  const g = harness("APP-REFI-1", "2026-11-02T17:00:00.000Z"); await scheduledRon(g);
  g.at("2026-11-07T06:00:00.000Z"); await g.run("openSigningSession", { closing_id: "CLS-1", session_id: "SES-1", signer_party_ids: ["B1"], notary: NOTARY_AZ, consent_record_id: "CONS-1" });
  await g.run("monitorSession", { op: "identity", closing_id: "CLS-1", party_id: "B1", method: "credential_analysis_kba", credential_analysis_result: "pass", kba_attempts: [{ questions: 5, correct: 5, seconds: 60, at: "2026-11-07T06:10:00.000Z", notary_party_id: "N-AZ-1" }], notary_party_id: "N-AZ-1" }); await g.run("monitorSession", { op: "start", closing_id: "CLS-1" });
  await assert.rejects(g.run("monitorSession", { op: "sign", closing_id: "CLS-1", closing_document_id: "DOC-ENOTE", kind: "enote", signer_party_id: "B1", signed_at: "2026-11-07T07:04:00.000Z", signature_method: "esign_ron", required_note_signers: ["B1"] }), /re-draw required \(26.1 date_change\)/);
  assert.equal(g.ofType("closing.consummated").length, 0);
});

test("26.2-T13: Given an executed set with a handwritten change to the interest rate on a paper note, then `reviewExecution` fails with `instrument_altered`, funding is blocked, and a re-draw is scheduled.", async () => {
  const note: ExecutedDocument = { closing_document_id: "DOC-NOTE", kind: "note", form: "paper", required_signers: [{ party_id: "B1", typed_name: "R. Borrower", capacity: "borrower" }], signatures: [{ party_id: "B1", signed_name: "R. Borrower", attributable: true, dated: true }], notarized: false, witness_count_required: 0, witnesses: 0, handwritten_changes: [{ field: "interest_rate", description: "6.125% struck and 6.250% written in" }], recordable: false, min_present: true, cover_sheet: true };
  const mortgage: ExecutedDocument = { closing_document_id: "DOC-MTG", kind: "security_instrument", form: "paper", required_signers: [{ party_id: "B1", typed_name: "R. Borrower", capacity: "borrower" }], signatures: [{ party_id: "B1", signed_name: "Robert Borrower", attributable: true, dated: true }], notarized: true, notarial_certificate: { venue: true, date: true, notary_name: true, commission_expiry: true, seal: true, ron_statement: null }, witness_count_required: 2, witnesses: 2, handwritten_changes: [], recordable: true, min_present: true, cover_sheet: true };
  const r = reviewExecution([note, mortgage]);
  assert.equal(r.passed, false); assert.equal(r.funding_blocked, true); assert.equal(r.defects[0]!.code, "instrument_altered"); assert.equal(r.defects[0]!.cure, "redraw"); assert.deepEqual(r.redraw, { reason: "qc_defect_found", documents: ["DOC-NOTE"] });
  assert.ok(r.defects.some((d) => d.code === "name_variance" && !d.blocking), "signed 'Robert Borrower' vs typed 'R. Borrower' → name affidavit, not blocking"); assert.deepEqual(r.name_affidavits, ["DOC-MTG"]);
  assert.equal(reviewExecution([{ ...note, handwritten_changes: [] }, mortgage]).passed, true);
  assert.ok(reviewExecution([{ ...mortgage, witnesses: 1 }]).defects.some((d) => d.code === "witness_count_short" && d.blocking), "S.C. Code §30-5-30: two witnesses");
  // the bus: the review fails, funding is blocked, the settlement agent is escalated and the re-draw is requested on the released set
  const h = harness("APP-SC-1", "2026-11-18T18:00:00.000Z");
  await h.run("runPreSessionChecks", { op: "schedule", closing_id: "CLS-SC", application_id: "APP-SC-1", scheduled_at: "2026-11-18T16:00:00.000Z", time_zone: "America/New_York", state: "SC", transaction_type: "purchase", settlement_agent_party_id: "P-ATTY-SC-1", location_type: "attorney_office", borrower_election: "wet", eligibility: [], signers: [], rescindable: false });
  await h.run("runPreSessionChecks", { op: "upstream", closing_id: "CLS-SC", event: { type: "closing.documents.released", occurredAt: "2026-11-16T22:00:00.000Z", payload: { set_id: "SET-SC" } } });
  const out = await h.run("reviewExecution", { closing_id: "CLS-SC", documents: [note, mortgage] });
  assert.equal(out.passed, false); assert.equal(out.funding_blocked, true); assert.equal(out.redraw_scheduled, true); assert.equal(out.execution_status, "session_failed"); assert.ok(out.escalation_id);
  assert.equal(h.ofType("closing.execution_review.failed")[0]!.payload.funding_blocked, true); assert.deepEqual(h.ofType("closing.redraw.requested")[0]!.payload.documents, ["DOC-NOTE"]);
  assert.ok(h.escalations.list().some((e) => e.kind === "settlement_agent" && e.payload.reason === "execution_defects"));
  await refused(h.run("reviewExecution", { closing_id: "CLS-SC", documents: [note], waive_defects: ["instrument_altered"] }), "DEFECT_WAIVER_OFFICER");
  await h.run("submitERecording", { op: "open", closing_id: "CLS-SC", recording_id: "REC-SC", closing_document_id: "DOC-MTG", county: "Richland", county_covered: true, anchor_date: "2026-11-18" });
  await refused(h.run("submitERecording", { closing_id: "CLS-SC", recording_id: "REC-SC", instrument_altered: true }), "NO_ALTERED_INSTRUMENT");
  assert.equal(h.timer("SM_O72_POST_SIGNING_REVIEW_4H"), undefined, "no consummation was recorded on this bus");
});

test("26.2-T14: Given a RON closing delivered to Fannie Mae, then the ULDD carries `remote_notarization_indicator=true` and `enote_indicator=true`, and the audit trail is in the electronic loan file handed to servicing.", async () => {
  const h = harness("APP-REFI-1", "2026-11-02T17:00:00.000Z"); await scheduledRon(h); await signedRon(h); await sealed(h);
  h.at("2026-11-06T21:44:00.000Z"); await h.run("registerENote", { closing_id: "CLS-1" });
  h.at("2026-11-06T22:05:00.000Z"); const trail = sha256("audit-trail-SES-1"); await h.run("ingestAuditTrail", { closing_id: "CLS-1", document_id: "DOC-AT-1", audit_trail_hash: trail, platform_hash: trail, recording_ref: "REC-PROOF-991" });
  h.at("2026-11-06T23:20:00.000Z"); const rv = await h.run("reviewExecution", { closing_id: "CLS-1", documents: [{ closing_document_id: "DOC-ENOTE", kind: "enote", form: "electronic", required_signers: [{ party_id: "B1", typed_name: "R. Borrower", capacity: "borrower" }], signatures: [{ party_id: "B1", signed_name: "R. Borrower", attributable: true, dated: true }], notarized: false, witness_count_required: 0, witnesses: 0, handwritten_changes: [], recordable: false, min_present: true, cover_sheet: true, smart_doc_hash: SEAL, eregistry_hash: SEAL }] });
  assert.equal(rv.passed, true); assert.equal(h.timer("SM_O72_POST_SIGNING_REVIEW_4H")!.status, "satisfied");
  h.at("2026-11-09T15:05:00.000Z"); await h.run("setSecuredParty", { closing_id: "CLS-1" });
  h.at("2026-11-09T15:30:00.000Z"); await h.run("submitERecording", { op: "open", closing_id: "CLS-1", recording_id: "REC-1", closing_document_id: "DOC-DOT", county: "Maricopa", county_covered: true, anchor_date: "2026-11-06", date_of_policy: "2026-11-09" }); await h.run("submitERecording", { closing_id: "CLS-1", recording_id: "REC-1" });
  h.at("2026-11-09T17:12:00.000Z"); await h.run("submitERecording", { op: "confirm", closing_id: "CLS-1", recording_id: "REC-1", instrument_number: "20261109-0412345" });
  const d = await h.run("writeDecision", { op: "delivery", closing_id: "CLS-1" });
  const ind = d.indicators as ReturnType<typeof deliveryIndicators>; assert.equal(ind.remote_notarization_indicator, true); assert.equal(ind.enote_indicator, true); assert.equal(ind.min, MIN); assert.equal(ind.eregistry_status, "registered"); assert.deepEqual(ind.recording, { instrument_number: "20261109-0412345", recorded_at: "2026-11-09T17:12:00.000Z" });
  const file = d.loan_file as { audit_trails: { session_id: string; document_id: string; hash: string; retention_class: string }[]; eregistry: { txn_type: string; result: string }[]; signing_records: { identity: { method: string; result: string }[] }[]; enote: { controller_org_id: string; secured_party_org_id: string } };
  assert.deepEqual(file.audit_trails, [{ session_id: "SES-1", document_id: "DOC-AT-1", hash: trail, retention_class: "fnma_enote_signing_life_plus_7y" }]);
  assert.deepEqual(file.eregistry.map((t) => [t.txn_type, t.result]), [["eregistry_registration", "accepted"], ["eregistry_change_data_secured_party", "accepted"]]); assert.equal(file.enote.controller_org_id, PARTNER_ORG); assert.equal(file.enote.secured_party_org_id, SM_ORG_ID);
  assert.ok(file.signing_records[0]!.identity.every((x) => x.method === "credential_analysis_kba" && x.result === "proofed"), "identity results carry method/result only");
  // worked example 2 (Columbus, OH hybrid IPEN): eNote signed in person → enote_indicator=true, remote_notarization_indicator=false
  assert.deepEqual(deliveryIndicators({ note_form: "enote", closing_type: "ipen" }, { min: MIN, registration_status: "registered" }, [{ mode: "ipen", notarial_acts: [{ closing_document_id: "DOC-3036", act_type: "acknowledgment", completed_at: "2026-11-18T15:40:00.000Z", certificate_indicates_communication_technology: false, recordable: true }] }], null), { enote_indicator: true, remote_notarization_indicator: false, min: MIN, eregistry_status: "registered", recording: null });
  const closing = h.rt.store.get("closings", "CLS-1")!.data; assert.equal(closing.remote_notarization_indicator, true); assert.equal(closing.enote_indicator, true);
  // the decision record and the borrower's appointment notice
  await h.run("writeDecision", { closing_id: "CLS-1", action: "closer.session", rationale: "fixture RON session executed, registered, reviewed, recorded", identity_results: [{ party_id: "B1", method: "credential_analysis_kba", result: "proofed" }], confidence: 0.98 });
  assert.equal(h.decisions.at(-1)!.ruleSetVersion.startsWith("fnma.selling.2026-09-02"), true);
  await refused(h.run("writeDecision", { closing_id: "CLS-1", action: "x", identity_results: [{ party_id: "B1", method: "credential_analysis_kba", result: "proofed", ssn: "123" }] }), "NO_PII_IN_IDENTITY_RESULTS");
  const v = noticeReg.activeVersion("NTC_SM_CLOSING_APPOINTMENT", D("2026-11-02"))!; const n = render(v.source, CLOSING_APPOINTMENT_SAMPLE); const chk = evaluateChecklist(v, CLOSING_APPOINTMENT_SAMPLE, n); assert.equal(chk.passed, true, JSON.stringify(chk.results.filter((r) => !r.passed)));
  const tx = { ...CLOSING_APPOINTMENT_SAMPLE, electronic: false, ron: false, tx_50a6: true, closing_type_label: "Paper (wet) closing", location_name: "Austin Title Company", location_address: "12 Congress Ave, Austin, TX 78701", tx_office_name: "Austin Title Company", tx_office_address: "12 Congress Ave, Austin, TX 78701", tx_earliest_closing_date: "2026-10-17" };
  assert.equal(evaluateChecklist(v, tx, render(v.source, tx)).passed, true); assert.equal(evaluateChecklist(v, { ...tx, electronic: true, ron: true }, render(v.source, { ...tx, electronic: true, ron: true })).passed, false, "TX 50(a)(6) is never electronic");
  assert.match(n.text, /never required to sign electronically or to use remote notarization/); assert.match(n.text, /5 questions in 2 minutes, 80% correct to pass/); assert.match(n.text, /the system records and never signs/);
});

test("26.2 worked figures: fixture RON timeline (Phoenix) — seal 14:41 MST, registration due Mon Nov 9 23:59 ET, accepted 14:46 MST; eRecording Mon Nov 9 with gap_days 0; OH hybrid IPEN due Thu Nov 19; SC paper note shipped the same day; eRegistry fee schedule", () => {
  const due = registrationDueAt("2026-11-06T21:41:00.000Z", "2026-11-06T21:26:00.000Z", "America/Phoenix");
  assert.equal(due.due_at, "2026-11-10T04:59:00.000Z");
  // the spec's "2 days and 9 hours early" mixes MST and ET: 14:46 MST Fri Nov 6 (21:46Z) to 23:59 ET Mon Nov 9 (04:59Z Nov 10) is 3 days 7 h 13 min — the engine value is asserted (reported as a discrepancy)
  assert.equal(Date.parse(due.due_at) - Date.parse("2026-11-06T21:46:00.000Z"), (3 * 24 + 7) * 3_600_000 + 13 * 60_000);
  assert.equal(erecordSubmitDue(D("2026-11-06")), "2026-11-09"); assert.equal(recordingGapDays("2026-11-09T17:12:00.000Z", D("2026-11-09"), "America/Phoenix"), 0);
  assert.equal(registrationDueAt("2026-11-18T15:44:00.000Z", "2026-11-18T15:31:00.000Z", "America/New_York").due_date, "2026-11-19"); assert.equal(erecordSubmitDue(D("2026-11-18")), "2026-11-19", "OH wet state: loan.funded Nov 18 → Nov 19");
  assert.equal(paperNoteHandoffDue(D("2026-11-18")), "2026-11-19");
  // eRegistry pricing (00b-orig F9): registration $0.00 when also on the MERS System, $8.95 otherwise; eDelivery $0.00; Converted-to-Paper $15.00 — SM operating costs, never CD items
  const EREGISTRY_FEES_CENTS = { registration_with_mers_system: 0n, registration_without_mers_system: 895n, edelivery: 0n, converted_to_paper: 1_500n } as const;
  assert.equal(EREGISTRY_FEES_CENTS.registration_without_mers_system - EREGISTRY_FEES_CENTS.registration_with_mers_system, 895n); assert.equal(EREGISTRY_FEES_CENTS.converted_to_paper, 1_500n);
});
