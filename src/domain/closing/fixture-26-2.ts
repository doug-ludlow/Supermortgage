/**
 * 26.2's worked example 1 (Phoenix, AZ refinance RON) as a fixture other sections' tests drive — the constants and the
 * scenario helpers of src/domain/closing/26-2.spec.test.ts (its `harness`, `scheduledRon`, `signedRon`, `sealed`), verbatim
 * in their inputs and clocks, parameterised only where a caller must supply its own ids (the application, the eNote's signed
 * document). 35.2-T15 drives 26.2's FAKE RON session over a real application and stores the platform's audit trail and the
 * signed closing document through `documents.store`, then feeds 26.2's `ingestAuditTrail` unchanged. A non-test module so
 * it can be imported by a test in another section without importing that section's test file.
 */
import assert from "node:assert/strict";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_26_2 } from "../../app/tools/section26-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { FakeEvault } from "../../infra/integrations/custody.ts";
import { makeMin } from "../boarding/min.ts";
import { type ClosingTypeInput, type ClosingEsignConsent, type EclosingEligibility, FakeERegistry26, sha256 } from "./ops-26-2.ts";

export const CLOSER: Actor = { kind: "agent", id: "title-closing" };
const toolKey = (process: string, name: string): string => `${process} ${name}`;
const noticeReg = buildRegistry(); publishAuthored(noticeReg);
export const PARTNER_ORG = "1001234";
export const MIN = makeMin(PARTNER_ORG, "12");
export const AGENT = "P-ESCROW-AZ-1";
export const AUTHORITATIVE_COPY = "<SMART_DOCUMENT version=\"1.02\"><DATA min=\"" + MIN + "\" amount=\"560000.00\" rate=\"6.125\"/></SMART_DOCUMENT>";
export const SEAL = sha256(AUTHORITATIVE_COPY);
export const ELIGIBILITY: EclosingEligibility[] = [{ settlement_agent_party_id: AGENT, county_fips: null, ron_capable: true, ipen_capable: true, erecording_submitter: true, platforms: ["Snapdocs"], remote_witness_service: false, verified_at: "2026-10-20T00:00:00Z", verified_by: "title-closing" }];
export const CONSENT: ClosingEsignConsent = { consent_id: "CONS-1", kind: "esign", scope: ["disclosures", "closing_package"], granted_at: "2026-10-06T15:00:00Z", withdrawn_at: null, hw_sw_statement_version: "2026-09", access_demonstrated: true, paper_option_disclosed: true };
/** Worked example 1 (Phoenix, AZ refinance RON): the closing-type input with every RON condition satisfied. */
export const azRon = (o: Partial<ClosingTypeInput> = {}): ClosingTypeInput => ({ state: "AZ", county_fips: "04013", tx_50a6: false, enote_eligible: true, proposed_closing_type: "ron", borrower_election: null, signers: [{ party_id: "B1", esign_consented: true, identity_proofing_possible: true }, { party_id: "B2", esign_consented: true, identity_proofing_possible: true }], county_accepts_ron_instruments: true, title_no_ron_exception: true, agent: ELIGIBILITY[0]!, ron_provider_available: true, notary: { commission_state: "AZ", physical_location_state: "AZ" }, counsel_confirmation: null, in_person_enotarization_valid: true, ...o });
export const GATE_FACTS = { ctc: { ctc_issued: true, checklist_passed: true, decision_status: "active" }, le: { earliest_consummation_date: "2026-10-30" }, cd: { earliest_consummation_date: "2026-11-05", receipts_complete: true }, signing_package: [{ consumer_id: "B1", copies: 2, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }, { consumer_id: "B2", copies: 2, channel: "in_person", material_disclosures_in_package: true, receipt_capture: true }], fraud_hold: { fraud_hold: false }, compliance_consummate_gate_open: true, vvoe_within_10bd: true, mi_commitment_valid: true, lock_valid_through_closing: true };
export const NOTARY_AZ = { party_id: "N-AZ-1", commission_state: "AZ", commission_number: "AZ-123456", physical_location_state: "AZ" };

/** The 26.2 bus alone: TOOLS_26_2 bound to the `title-closing` agent over the overridden registry (26.2 rows), escalations, the eVault, the eRegistry fake and the Notice Registry; the application-scoped unit of work stamps `applicationId` on every event. */
export function ron26Harness(applicationId: string, nowIso: string) {
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
export type Ron26Harness = ReturnType<typeof ron26Harness>;

/** Schedules the fixture RON closing (Fri Nov 6, 2026 14:00 MST), folds 26.1's release in and passes the pre-session checks. `o` overrides the schedule input (a real application id). */
export async function scheduledRon(h: Ron26Harness, o: Record<string, unknown> = {}): Promise<string> {
  h.at("2026-11-02T17:00:00.000Z");
  const s = await h.run("runPreSessionChecks", { op: "schedule", closing_id: "CLS-1", application_id: "APP-REFI-1", scheduled_at: "2026-11-06T21:00:00.000Z", time_zone: "America/Phoenix", state: "AZ", county_fips: "04013", transaction_type: "limited_cash_out", dry_state: true, settlement_agent_party_id: AGENT, notary_party_id: "N-AZ-1", ron_provider_party_id: "P-RON-1", eligibility: ELIGIBILITY, signers: azRon().signers, ...o });
  await h.run("runPreSessionChecks", { op: "upstream", closing_id: "CLS-1", event: { type: "closing.documents.released", occurredAt: "2026-11-05T22:00:00.000Z", payload: { set_id: "SET-APP-REFI-1-1" } } });
  h.at("2026-11-06T20:30:00.000Z");
  await h.run("verifyEsignConsent", { closing_id: "CLS-1", consent: CONSENT });
  const pre = await h.run("runPreSessionChecks", { closing_id: "CLS-1", consent: CONSENT, facts: GATE_FACTS }); assert.equal(pre.passed, true, JSON.stringify(pre.blocking));
  return String(s.closing_type);
}
/** Opens the fixture session, proofs both signers, signs the eNote at 14:26 MST (consummation) and the deed of trust, and completes the RON acknowledgment 14:36. `enote_signed_document_id` names the signed eNote's `documents` row (35.2). */
export async function signedRon(h: Ron26Harness, o: { enote_signed_document_id?: string } = {}): Promise<void> {
  h.at("2026-11-06T21:00:00.000Z");
  await h.run("openSigningSession", { closing_id: "CLS-1", session_id: "SES-1", signer_party_ids: ["B1", "B2"], notary: NOTARY_AZ, consent_record_id: "CONS-1" });
  h.at("2026-11-06T21:07:00.000Z"); await h.run("monitorSession", { op: "identity", closing_id: "CLS-1", party_id: "B1", method: "credential_analysis_kba", credential_type: "driver_license", credential_analysis_result: "pass", kba_attempts: [{ questions: 5, correct: 5, seconds: 71, at: "2026-11-06T21:07:00.000Z", notary_party_id: "N-AZ-1" }], notary_party_id: "N-AZ-1", vendor: "Proof" });
  h.at("2026-11-06T21:11:00.000Z"); await h.run("monitorSession", { op: "identity", closing_id: "CLS-1", party_id: "B2", method: "credential_analysis_kba", credential_type: "driver_license", credential_analysis_result: "pass", kba_attempts: [{ questions: 5, correct: 4, seconds: 80, at: "2026-11-06T21:11:00.000Z", notary_party_id: "N-AZ-1" }], notary_party_id: "N-AZ-1", vendor: "Proof" });
  await h.run("monitorSession", { op: "start", closing_id: "CLS-1" });
  await h.run("monitorSession", { op: "enote_created", closing_id: "CLS-1", closing_document_id: "DOC-ENOTE", min: MIN, partner_org_id: PARTNER_ORG });
  await h.run("monitorSession", { op: "sign", closing_id: "CLS-1", closing_document_id: "DOC-1003", kind: "final_1003", signer_party_id: "B1", signed_at: "2026-11-06T21:18:00.000Z", signature_method: "esign_ron", required_note_signers: ["B1"] });
  await h.run("monitorSession", { op: "sign", closing_id: "CLS-1", closing_document_id: "DOC-ENOTE", kind: "enote", signer_party_id: "B1", signed_at: "2026-11-06T21:26:00.000Z", signature_method: "esign_ron", required_note_signers: ["B1"], ...(o.enote_signed_document_id ? { signed_document_id: o.enote_signed_document_id } : {}) });
  await h.run("monitorSession", { op: "sign", closing_id: "CLS-1", closing_document_id: "DOC-DOT", kind: "security_instrument", signer_party_id: "B1", signed_at: "2026-11-06T21:31:00.000Z", signature_method: "esign_ron", required_note_signers: ["B1"] });
  await h.run("monitorSession", { op: "sign", closing_id: "CLS-1", closing_document_id: "DOC-DOT", kind: "security_instrument", signer_party_id: "B2", signed_at: "2026-11-06T21:31:30.000Z", signature_method: "esign_ron", required_note_signers: ["B1"] });
  await h.run("monitorSession", { op: "notarial_act", closing_id: "CLS-1", closing_document_id: "DOC-DOT", kind: "security_instrument", act_type: "acknowledgment", completed_at: "2026-11-06T21:36:00.000Z", certificate_indicates_communication_technology: true, recordable: true, last: true, notary_party_id: "N-AZ-1" });
}
/** Tamper seal 14:41 MST (2026-11-06T21:41:00Z); the Authoritative Copy in SM's eVault 14:42; hash validated 14:43. */
export async function sealed(h: Ron26Harness, at = "2026-11-06T21:41:00.000Z"): Promise<void> {
  h.at(at); await h.run("validateAuthoritativeCopy", { op: "seal", closing_id: "CLS-1", seal_hash: SEAL, signing_completed_at: "2026-11-06T21:26:00.000Z", authoritative_copy_ref: "EV-1", tamper_sealed_at: at });
  h.at(new Date(Date.parse(at) + 2 * 60_000).toISOString()); const v = await h.run("validateAuthoritativeCopy", { closing_id: "CLS-1", authoritative_copy: AUTHORITATIVE_COPY }); assert.equal(v.gate_open, true, String(v.reason));
}
