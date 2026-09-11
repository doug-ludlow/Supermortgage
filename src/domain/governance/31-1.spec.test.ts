// 31.1 Licensing, approvals, and the partner boundary
// spec/sections/31-cross-cutting-licensing-and-approvals-ai-governance-and-fair/31-1-licensing-approvals-and-the-partner-boundary.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_31_1 } from "../../app/tools/section31-1.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { newLicense, deriveJurisdictionLicensing, stateReadiness, assertStateGate, LicensingRefused, routeHumanTouchpoint, recordSupervisedAct, recomputeRoster, proposeMloOfRecord, reassignInFlightApplications, openRenewalWindow, recordCeCompletion, requestRenewal, approveRenewal, expireUnrenewed, reinstateLicense, changeLicenseStatus, upsertLicense, assertLicenseEvidence,
  closeQuarter, computeOrigInputs, fhfaEligibilityIllustration, tpoCadence, bpsOf, tenthBpsOf, scaledRate, renewalCalendar, decideClosingNoteForm, emortgageGate, requestProductionCall, tspProductionGate, setWarehouseLegalForm, detectStatePageChange, verifyMatrixRow, closeStateForInFlight, borrowerStateClosedMessage, deliverOrigInputs,
  type License, type LicenseRequirement, type MloRosterMember, type FnmaApproval, type AiIntakeLegalPosition, type ReadinessFacts, type Person, type InFlightApplication } from "./ops-31-1.ts";
import { EVALUATORS_31_1 } from "./evaluators-31-1.ts";

const SENTINEL: Actor = { kind: "agent", id: "compliance-sentinel" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const COUNSEL: Actor = { kind: "human", id: "u-counsel", role: "counsel" };
const MLO_HUMAN = (id: string): Actor => ({ kind: "human", id, role: "mlo_of_record" });
const PARTNER = "PARTNER-BANK", SM = "SUPERMORTGAGE", DOC = "DOC-EVIDENCE-1";
const APP_AZ = "APP-REFI-AZ-1", APP_OH = "APP-PURCH-OH-1";

// ------------------------------------------------------------------ fixtures: licences (partner + SM; AZ / OH / TX / GA), matrix rows, AI positions, roster
type LI = Parameters<typeof newLicense>[0];
const lic = (i: LI & { readonly expires?: string; readonly issued?: string; readonly ce?: string | null }): License => newLicense({ nmls_id: `N-${i.license_id}`, status: "approved", evidence_document_id: DOC, nmls_status_raw: "Approved", issued_at: D(i.issued ?? "2025-01-05"), expires_at: D(i.expires ?? "2026-12-31"), ...(i.ce ? { ce_completed_at: D(i.ce), ce_hours: 8 } : {}), ...i });
const partnerCo = (st: string, code: string, over: Partial<LI & { expires: string }> = {}) => lic({ license_id: `L-${st}-PARTNER`, holder_kind: "partner_company", holder_ref: PARTNER, jurisdiction: st, license_type_code: code, activity_scope: ["lend"], ...over });
const partnerMlo = (st: string, person: string, ce: string | null, over: Partial<LI & { expires: string; issued: string }> = {}) => lic({ license_id: `L-${st}-MLO-${person}`, holder_kind: "partner_individual", holder_ref: `p-${person}`, jurisdiction: st, license_type_code: `${st}_MLO`, activity_scope: ["mlo_individual"], sponsor_license_id: `L-${st}-PARTNER`, ce, ...over });
const BASE_LICENSES: License[] = [
  partnerCo("AZ", "AZ_MORTGAGE_BANKER", { authority_citation: "A.R.S. §6-943" }), partnerMlo("AZ", "lee", "2026-09-14", { authority_citation: "A.R.S. §6-991.03" }),
  lic({ license_id: "L-AZ-SM-BROKER", holder_kind: "sm_company", holder_ref: SM, jurisdiction: "AZ", license_type_code: "AZ_MORTGAGE_BROKER", activity_scope: ["broker", "processing_underwriting_entity"], authority_citation: "A.R.S. §6-903", issued: "2026-08-20" }),
  lic({ license_id: "L-AZ-UW1", holder_kind: "sm_individual", holder_ref: "p-uw1", jurisdiction: "AZ", license_type_code: "AZ_MLO", activity_scope: ["mlo_individual", "processor_underwriter_individual"], sponsor_license_id: "L-AZ-SM-BROKER", ce: "2026-06-01", issued: "2026-08-25" }),
  lic({ license_id: "L-AZ-UW2", holder_kind: "sm_individual", holder_ref: "p-uw2", jurisdiction: "AZ", license_type_code: "AZ_MLO", activity_scope: ["mlo_individual", "processor_underwriter_individual"], sponsor_license_id: "L-AZ-SM-BROKER", ce: "2026-06-01", issued: "2026-08-25" }),
  partnerCo("OH", "OH_RMLA_CERTIFICATE", { authority_citation: "R.C. 1322.07" }), partnerMlo("OH", "kim", "2026-08-10"),
  lic({ license_id: "L-OH-SM-EXEMPT", holder_kind: "sm_company", holder_ref: SM, jurisdiction: "OH", license_type_code: "OH_LOAN_PROCESSING_EXEMPTION_LETTER", activity_scope: ["exempt_letter"], status: "exempt", authority_citation: "OAC 1301:8-7-32", issued: "2026-07-01" }),
  partnerCo("TX", "TX_MORTGAGE_BANKER_REGISTRATION"), partnerMlo("TX", "ortiz", "2026-07-15"),
  lic({ license_id: "L-TX-SM-COMPANY", holder_kind: "sm_company", holder_ref: SM, jurisdiction: "TX", license_type_code: "TX_IC_LOAN_PROCESSOR_UNDERWRITER_COMPANY", activity_scope: ["processing_underwriting_entity"], authority_citation: "Tex. Fin. Code §156.2044" }),
  partnerCo("GA", "GA_MORTGAGE_LENDER"), partnerMlo("GA", "brown", "2026-05-20"),
];
const req = (st: string, applies_to: "partner" | "sm", activity: LicenseRequirement["activity"], kind: LicenseRequirement["requirement_kind"], code: string | null, verification: LicenseRequirement["verification_status"] = "verified"): LicenseRequirement =>
  ({ requirement_id: `R-${st}-${applies_to}-${activity}`, jurisdiction: st, activity, applies_to, requirement_kind: kind, license_type_code: code, citation: `${st} statute`, quoted_text: "…", verification_status: verification, verified_at: verification === "unverified" ? null : D("2026-09-11"), verified_by: verification === "unverified" ? null : "u-counsel", source_url: null, effective_from: D("2026-09-11"), superseded_by: null });
const MATRIX: LicenseRequirement[] = [
  req("AZ", "partner", "lend", "license", "AZ_MORTGAGE_BANKER"), req("AZ", "partner", "mlo_individual", "license", "AZ_MLO"), req("AZ", "sm", "processing_underwriting_entity", "license", "AZ_MORTGAGE_BROKER"), req("AZ", "sm", "processor_underwriter_individual_independent", "license", "AZ_MLO"),
  req("OH", "partner", "lend", "license", "OH_RMLA_CERTIFICATE"), req("OH", "partner", "mlo_individual", "license", "OH_MLO"), req("OH", "sm", "processing_underwriting_entity", "exemption_letter", "OH_LOAN_PROCESSING_EXEMPTION_LETTER"), req("OH", "sm", "processor_underwriter_individual_independent", "none", null),
  req("TX", "partner", "lend", "license", "TX_MORTGAGE_BANKER_REGISTRATION"), req("TX", "partner", "mlo_individual", "license", "TX_MLO"), req("TX", "sm", "processing_underwriting_entity", "license", "TX_IC_LOAN_PROCESSOR_UNDERWRITER_COMPANY"), req("TX", "sm", "processor_underwriter_individual_independent", "license", "TX_MLO"),
  req("GA", "partner", "lend", "license", "GA_MORTGAGE_LENDER"), req("GA", "partner", "mlo_individual", "license", "GA_MLO"), req("GA", "sm", "processing_underwriting_entity", "unverified", null, "unverified"),
];
const POSITIONS: AiIntakeLegalPosition[] = ["AZ", "OH", "TX"].map((s) => ({ jurisdiction: s, position: "assisted_required", memo_document_id: `DOC-AI-${s}`, counsel: "u-counsel", issued_at: D("2026-08-01"), review_due_at: D("2027-08-01") }));
const member = (mlo_id: string, person: string, employer: "partner" | "sm", state_licenses: string[], sponsor: string | null, open_queue = 0): MloRosterMember => ({ mlo_id, person_id: `p-${person}`, name: person, nmls_id: `N-${person}`, employer, sponsor_license_id: sponsor, state_licenses, states_assignable: [], lo_comp_plan_id: "LOCOMP-1", capacity_per_day: 10, status: "active", assignable: false, open_queue });
const BASE_ROSTER: MloRosterMember[] = [member("M-LEE", "lee", "partner", ["L-AZ-MLO-lee"], "L-AZ-PARTNER"), member("M-KIM", "kim", "partner", ["L-OH-MLO-kim"], "L-OH-PARTNER"), member("M-ORTIZ", "ortiz", "partner", ["L-TX-MLO-ortiz"], "L-TX-PARTNER"), member("M-BROWN", "brown", "partner", ["L-GA-MLO-brown"], "L-GA-PARTNER"),
  member("M-SM-UW1", "uw1", "sm", ["L-AZ-UW1"], "L-AZ-SM-BROKER"), member("M-SM-PROC", "proc", "sm", [], null)];
const jur = (state: string, asOf: PlainDate, rows: readonly LicenseRequirement[] = MATRIX) => deriveJurisdictionLicensing(state, rows, POSITIONS.find((p) => p.jurisdiction === state) ?? null, asOf);
function facts(state: string, asOf: string, over: { licenses?: License[]; roster?: MloRosterMember[]; rows?: LicenseRequirement[] } = {}): ReadinessFacts {
  const on = D(asOf); const licenses = over.licenses ?? BASE_LICENSES;
  const jurisdictions = ["AZ", "OH", "TX", "GA"].map((s) => jur(s, on, over.rows));
  return { state, as_of: on, licenses, jurisdiction: jurisdictions.find((j) => j.state === state)!, roster: recomputeRoster(over.roster ?? BASE_ROSTER, licenses, jurisdictions, on) };
}
const UW1: Person = { person_id: "p-uw1", employer: "sm" }, UW2: Person = { person_id: "p-uw2", employer: "sm" }, PROC: Person = { person_id: "p-proc", employer: "sm" }, PARTNER_STAFF: Person = { person_id: "p-partner-uw", employer: "partner" };

/** The 31.1 clocks over the overridden registry, in-memory events, a fixed clock, the escalation service. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["31.1"] });
  const escalations = new EscalationService(events, clock);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (t: string) => events.all().filter((e) => e.type === t);
  return { clock, events, timers, escalations, timer, ofType };
}
const toolKey = (process: string, name: string): string => `${process} ${name}`;
/** The 31.1 bus alone (the 12-8 pattern): TOOLS_31_1 bound to the `compliance-sentinel` agent. */
function busFor(h: ReturnType<typeof harness>) {
  const ctx: UowContext = { loanId: "", events: h.events, ledger: new MemoryLedger(), timers: h.timers, clock: h.clock, decide: () => {} };
  const agents = new AgentRegistry(); const rt: ToolRuntime = { store: new EntityStore(), ports: {}, escalations: h.escalations, services: {} };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_31_1) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(toolKey(d.process, d.name), cmd); }
  const bus = new CommandBus(agents);
  const run = (name: string, input: ToolInput, actor: Actor = SENTINEL) => bus.execute(cmds.get(toolKey("31.1", name))!, actor, input, ctx);
  return { ctx, cmds, bus, rt, run };
}
const APPROVALS_OK: FnmaApproval[] = [
  { approval_id: "A-EM", entity: "partner", kind: "emortgage_special_approval", product: null, seller_servicer_number: "123456789", status: "active", granted_at: D("2026-10-23"), expires_at: null, conditions: {}, evidence_document_id: "DOC-FNMA-EM-LETTER", contact_ref: "account team" },
  { approval_id: "A-MERS-P", entity: "partner", kind: "mers_eregistry_addendum", product: null, seller_servicer_number: null, status: "active", granted_at: D("2026-09-01"), expires_at: null, conditions: {}, evidence_document_id: "DOC-MERS-P", contact_ref: null },
  { approval_id: "A-MERS-SM", entity: "sm", kind: "mers_eregistry_addendum", product: null, seller_servicer_number: null, status: "active", granted_at: D("2026-09-01"), expires_at: null, conditions: {}, evidence_document_id: "DOC-MERS-SM", contact_ref: null },
  { approval_id: "A-WH", entity: "sm", kind: "enote_warehouse_agreement", product: null, seller_servicer_number: null, status: "active", granted_at: D("2026-10-12"), expires_at: null, conditions: {}, evidence_document_id: "DOC-WH-ENOTE", contact_ref: null },
];
const closingScheduled = (h: ReturnType<typeof harness>, at: string, enote: boolean): DomainEvent => h.events.append({ type: "closing.scheduled", applicationId: APP_AZ, actor: { kind: "agent", id: "closer" }, occurredAt: at, payload: { application_id: APP_AZ, closing_id: "CL-1", scheduled_at: "2026-11-06T17:00:00.000Z", closing_type: enote ? "ron" : "hybrid", note_form: enote ? "enote" : "paper", enote, ron: enote } });

test("31.1-T1: Given the AZ fixture on Mon Oct 5, 2026 with partner `AZ_MORTGAGE_BANKER` approved, MLO `AZ_MLO` approved and sponsored, SM `AZ_MORTGAGE_BROKER` approved and two SM underwriters holding `AZ_MLO`, when `application.started{AZ}` fires, then `SM_LICENSE_STATE_GATE` is open and the `underwriting_reviewer` router accepts only those two SM underwriters or partner employees.", () => {
  const h = harness("2026-10-05T14:00:00.000Z");
  const f = facts("AZ", "2026-10-05");
  assert.equal(f.jurisdiction.processor_license_required, "entity_license"); assert.equal(f.jurisdiction.independent_processor_individual_license_required, true); assert.equal(f.jurisdiction.ai_intake_position, "assisted_required");
  // 21.1's application.started arms the gate per application (origination context: applicationId)
  h.events.append({ type: "application.started", applicationId: APP_AZ, aggregate: { kind: "application", id: APP_AZ }, actor: SYSTEM, payload: { application_id: APP_AZ, property_state: "AZ", partner_party_id: PARTNER, channel: "refinance_retention" } });
  assert.equal(h.timer("SM_LICENSE_STATE_GATE")?.status, "armed");
  const r = assertStateGate(h.events, { command: "application.start", at: h.clock.now(), application_id: APP_AZ, partner_name: "Partner Bank" }, f, h.escalations);
  assert.equal(r.readiness.open, true); assert.deepEqual(r.readiness.predicates, { partner_company_ok: true, branch_ok: true, mlo_available: true, sm_processing_ok: true, matrix_ok: true, ai_position_ok: true });
  assert.equal(r.event.type, "licensing.gate.opened"); assert.equal(r.event.applicationId, APP_AZ); assert.equal((r.event.payload as { gate: string }).gate, "SM_LICENSE_STATE_GATE");
  assert.equal(h.timer("SM_LICENSE_STATE_GATE")?.status, "satisfied");
  assert.equal(EVALUATORS_31_1["31.1.stateReadinessGate"]!(f as unknown as Record<string, unknown>).open, true);
  assert.equal(h.escalations.list().length, 0);
  // the underwriting_reviewer router: the two SM underwriters (AZ_MLO sponsored by SM's broker licence) and partner staff; an unlicensed SM processor is rejected (independent contractor — A.R.S. §6-991.02)
  const route = routeHumanTouchpoint("underwriting_reviewer", "AZ", [UW1, UW2, PROC, PARTNER_STAFF], f.jurisdiction, f.licenses, f.as_of);
  assert.deepEqual(route.eligible.map((p) => p.person_id), ["p-uw1", "p-uw2", "p-partner-uw"]);
  assert.deepEqual(route.rejected.map((p) => p.person_id), ["p-proc"]);
  // the MLO of record is the partner's sponsored AZ_MLO; the roster derived it assignable in AZ
  assert.deepEqual(f.roster.find((m) => m.mlo_id === "M-LEE")?.states_assignable, ["AZ"]);
});

test("31.1-T2: Given the OH fixture on Mon Oct 19, 2026 with SM's Ohio letter of exemption approved 2026-07-01, then `processor_license_required(OH) = exemption_letter` is satisfied, SM employees without MLO licenses may clear conditions, and each clearance records the supervising MLO of record.", () => {
  const h = harness("2026-10-19T15:00:00.000Z");
  const f = facts("OH", "2026-10-19");
  assert.equal(f.jurisdiction.processor_license_required, "exemption_letter"); assert.equal(f.jurisdiction.independent_processor_individual_license_required, false);
  const r = stateReadiness(f); assert.equal(r.open, true); assert.equal(r.predicates.sm_processing_ok, true);
  assert.equal(f.licenses.find((l) => l.license_id === "L-OH-SM-EXEMPT")?.issued_at, "2026-07-01");
  // an SM employee with no MLO licence clears a condition under the letter of exemption; the partner's licensee who assigns and monitors is recorded on every act
  const route = routeHumanTouchpoint("licensed_specialist", "OH", [PROC, PARTNER_STAFF], f.jurisdiction, f.licenses, f.as_of);
  assert.deepEqual(route.eligible.map((p) => p.person_id), ["p-proc", "p-partner-uw"]); assert.equal(route.rejected.length, 0);
  const act = recordSupervisedAct(h.events, { state: "OH", activity: "condition_clearance", person: PROC, application_id: APP_OH, supervising_mlo_of_record_id: "M-KIM", at: h.clock.now() }, f.jurisdiction, f.licenses);
  assert.equal(act.basis, "exemption_letter"); assert.equal(act.license_id, "L-OH-SM-EXEMPT");
  const p = act.event.payload as Record<string, unknown>;
  assert.equal(act.event.applicationId, APP_OH); assert.equal(p.supervising_mlo_of_record_id, "M-KIM"); assert.equal(p.mlo_license_required, false); assert.equal(p.activity, "condition_clearance");
  // without a supervising MLO of record the clearance is not recorded
  assert.throws(() => recordSupervisedAct(h.events, { state: "OH", activity: "condition_clearance", person: PROC, application_id: APP_OH, supervising_mlo_of_record_id: "", at: h.clock.now() }, f.jurisdiction, f.licenses), RangeError);
  // the same SM employee in AZ (individual licence required) is refused
  const az = facts("AZ", "2026-10-19");
  assert.throws(() => recordSupervisedAct(h.events, { state: "AZ", activity: "condition_clearance", person: PROC, application_id: APP_AZ, supervising_mlo_of_record_id: "M-LEE", at: h.clock.now() }, az.jurisdiction, az.licenses), (e: unknown) => e instanceof LicensingRefused);
});

test("31.1-T3: Given a Georgia lead on Tue Oct 6, 2026 with `license_requirements(GA, processing_underwriting_entity).verification_status = unverified`, then the gate blocks, no quote or application is created, `licensing.gate.blocked{GA, matrix_unverified}` is emitted and a sev-1 `officer` escalation exists.", () => {
  const h = harness("2026-10-06T16:00:00.000Z");
  const f = facts("GA", "2026-10-06");
  assert.equal(MATRIX.find((r) => r.jurisdiction === "GA" && r.activity === "processing_underwriting_entity")?.verification_status, "unverified");
  assert.equal(f.jurisdiction.verification_status, "unverified"); assert.equal(f.jurisdiction.processor_license_required, "unverified");
  assert.throws(() => assertStateGate(h.events, { command: "lead.create", at: h.clock.now(), lead_id: "LEAD-GA-1", partner_name: "Partner Bank" }, f, h.escalations), (e: unknown) => e instanceof LicensingRefused && e.code === "SM_LICENSE_STATE_GATE" && /matrix_unverified/.test(e.message));
  const blocked = h.ofType("licensing.gate.blocked"); assert.equal(blocked.length, 1);
  const p = blocked[0]!.payload as Record<string, unknown>;
  assert.equal(p.state, "GA"); assert.equal(p.reason, "matrix_unverified"); assert.equal(p.quote_created, false); assert.equal(p.application_created, false); assert.equal(p.escalated_party, "sm");
  assert.equal(p.borrower_message, "Partner Bank is not currently accepting applications for Georgia properties through this channel.");
  assert.equal(borrowerStateClosedMessage("Partner Bank", "GA"), p.borrower_message);
  const esc = h.escalations.list(); assert.equal(esc.length, 1); assert.equal(esc[0]!.kind, "officer"); assert.equal(esc[0]!.severity, "sev1"); assert.equal(esc[0]!.ownerRole, "officer"); assert.equal(p.escalation_id, esc[0]!.id);
  assert.equal(h.ofType("lead.created").length, 0); assert.equal(h.ofType("application.started").length, 0); assert.equal(h.ofType("licensing.gate.opened").length, 0);
  // an officer risk acceptance never opens an `unverified` processor rule (rule 1: never for processor_license_required = unverified)
  assert.equal(stateReadiness({ ...f, officer_risk_acceptance: { decision_id: "DEC-1", attorney_memo_document_id: "DOC-MEMO" } }).open, false);
  assert.match(EVALUATORS_31_1["31.1.stateReadinessGate"]!(f as unknown as Record<string, unknown>).reason ?? "", /matrix_unverified/);
});

test("31.1-T4: Given MLO Chen with no CE logged by Thu Dec 31, 2026, then on Fri Jan 1, 2027 her license is `terminated_expired`, `assignable = false`, her 14 in-flight applications are reassigned and logged, and disclosures already delivered are unchanged; given she reinstates Mon Feb 15, 2027, she is assignable again.", () => {
  const h = harness("2026-11-01T07:00:00.000Z");
  // Lee already renewed for 2027; Chen holds AZ_MLO expiring Dec 31, 2026 with her last CE in 2025 (none logged in 2026); the partner's AZ licence runs to 2027
  let licenses: License[] = [partnerCo("AZ", "AZ_MORTGAGE_BANKER", { expires: "2027-12-31" }), partnerMlo("AZ", "lee", "2026-09-14", { expires: "2027-12-31" }), partnerMlo("AZ", "chen", "2025-12-05")];
  const roster0 = [member("M-LEE", "lee", "partner", ["L-AZ-MLO-lee"], "L-AZ-PARTNER", 3), member("M-CHEN", "chen", "partner", ["L-AZ-MLO-chen"], "L-AZ-PARTNER", 14)];
  const jAZ = [jur("AZ", D("2026-11-01"))];
  const w = openRenewalWindow(h.events, licenses, 2026, h.clock.now()); licenses = w.licenses;
  assert.deepEqual(w.events.map((e) => (e.payload as { license_id: string }).license_id), ["L-AZ-MLO-chen"]);
  assert.equal(h.timer("NMLS_RENEWAL_1101_1231")?.dueDate, "2026-12-31"); assert.equal(h.timer("SAFE_1008_107_MLO_CE_8H_1231")?.dueDate, "2026-12-31");
  assert.equal(recomputeRoster(roster0, licenses, jAZ, D("2026-12-31")).find((m) => m.mlo_id === "M-CHEN")?.assignable, true);
  // Fri Jan 1, 2027: the deadline breached with no CE and no request; NMLS terminates the licence and the platform mirrors it
  h.clock.set("2027-01-01T07:00:00.000Z");
  assert.equal(h.timers.evaluate(h.clock.now()).map((b) => b.def.code).sort().join(","), "NMLS_RENEWAL_1101_1231,SAFE_1008_107_MLO_CE_8H_1231");
  const x = expireUnrenewed(h.events, licenses, D("2027-01-01"), h.clock.now()); licenses = x.licenses;
  assert.deepEqual(x.expired.map((l) => l.license_id), ["L-AZ-MLO-chen"]);
  const chen = () => licenses.find((l) => l.license_id === "L-AZ-MLO-chen")!;
  assert.equal(chen().status, "terminated_expired"); assert.equal(chen().reinstatement_deadline, "2027-02-28");
  assert.equal(h.timer("NMLS_REINSTATEMENT_0101_0228")?.status, "armed"); assert.equal(h.timer("NMLS_REINSTATEMENT_0101_0228")?.dueDate, "2027-02-28");
  const roster1 = recomputeRoster(roster0, licenses, jAZ, D("2027-01-01"));
  assert.equal(roster1.find((m) => m.mlo_id === "M-CHEN")?.assignable, false); assert.equal(roster1.find((m) => m.mlo_id === "M-LEE")?.assignable, true);
  // her 14 in-flight AZ applications move overnight to the assignable AZ MLO; every reassignment is logged on the application; delivered disclosures keep Chen's NMLSR ID
  const delivered = [{ document_id: "LE-1", kind: "le", nmlsr_id: "N-chen", delivered_at: "2026-12-20T15:00:00.000Z" }];
  const apps: InFlightApplication[] = Array.from({ length: 14 }, (_, k) => ({ application_id: `APP-CHEN-${k + 1}`, state: "AZ", mlo_of_record_id: "M-CHEN", delivered_disclosures: delivered }));
  const r = reassignInFlightApplications(h.events, { from_mlo_id: "M-CHEN", applications: apps, roster: roster1, at: h.clock.now() });
  assert.equal(r.reassignments.length, 14); assert.ok(r.reassignments.every((x) => x.from === "M-CHEN" && x.to === "M-LEE" && x.state === "AZ"));
  assert.equal(h.ofType("application.mlo_of_record.reassigned").length, 14);
  assert.ok(h.ofType("application.mlo_of_record.reassigned").every((e) => typeof e.applicationId === "string" && (e.payload as { reason: string }).reason === "nmls_inactive" && (e.payload as { delivered_disclosures_reissued: boolean }).delivered_disclosures_reissued === false));
  assert.equal((h.ofType("mlo.roster.updated")[0]!.payload as { reassigned: number }).reassigned, 14);
  assert.equal(r.delivered_disclosures_unchanged, true); assert.ok(r.applications.every((a) => a.delivered_disclosures === delivered && a.delivered_disclosures[0]!.nmlsr_id === "N-chen"));
  assert.ok(r.applications.every((a) => a.mlo_of_record_id === "M-LEE"));
  // she completes CE and reinstates Mon Feb 15, 2027 → assignable again (the reassigned files stay where they are)
  h.clock.set("2027-02-15T15:00:00.000Z");
  const ce = recordCeCompletion(h.events, chen(), { completed_on: D("2027-02-10"), federal_law_hours: 3, ethics_hours: 2, nontraditional_hours: 2, elective_hours: 1, certificate_document_id: "DOC-CE-CHEN", at: "2027-02-10T20:00:00.000Z" });
  licenses = licenses.map((l) => (l.license_id === ce.license.license_id ? ce.license : l));
  const ri = reinstateLicense(h.events, chen(), { reinstated_on: D("2027-02-15"), nmls_status_raw: "Approved", at: h.clock.now() });
  licenses = licenses.map((l) => (l.license_id === ri.license.license_id ? ri.license : l));
  assert.equal(chen().status, "approved"); assert.equal(chen().expires_at, "2027-12-31");
  assert.equal(h.timer("NMLS_REINSTATEMENT_0101_0228")?.status, "satisfied");
  const roster2 = recomputeRoster(roster1, licenses, jAZ, D("2027-02-15"));
  assert.equal(roster2.find((m) => m.mlo_id === "M-CHEN")?.assignable, true); assert.deepEqual(roster2.find((m) => m.mlo_id === "M-CHEN")?.states_assignable, ["AZ"]);
  assert.ok(r.applications.every((a) => a.mlo_of_record_id === "M-LEE"), "no claim to the reassigned files");
  // past the last day of February a reinstatement is refused (re-application required)
  assert.throws(() => reinstateLicense(h.events, { ...chen(), status: "terminated_expired", reinstatement_deadline: D("2027-02-28") }, { reinstated_on: D("2027-03-01"), nmls_status_raw: "Approved", at: "2027-03-01T15:00:00.000Z" }), (e: unknown) => e instanceof LicensingRefused && e.code === "NMLS_REINSTATEMENT_0101_0228");
});

test("31.1-T5: Given MLO Ramirez completes 8 CE hours (3/2/2) Wed Dec 16, 2026 and renewal is requested Dec 17, then `NMLS_RENEWAL_1101_1231` is satisfied and `expires_at` becomes 2027-12-31 on approval.", () => {
  const h = harness("2026-11-01T07:00:00.000Z");
  let ramirez = partnerMlo("AZ", "ramirez", null);
  const cal = renewalCalendar(2026);
  assert.equal(cal.window_opens, "2026-11-01"); assert.equal(cal.deadline, "2026-12-31"); assert.equal(cal.reinstatement_opens, "2027-01-01"); assert.equal(cal.reinstatement_ends, "2027-02-28"); assert.equal(cal.policy_ce_target, "2026-12-01");
  ramirez = openRenewalWindow(h.events, [ramirez], 2026, h.clock.now()).licenses[0]!;
  assert.equal(h.timer("NMLS_RENEWAL_1101_1231")?.status, "armed"); assert.equal(h.timer("NMLS_RENEWAL_1101_1231")?.dueDate, "2026-12-31");
  assert.equal(h.timer("SAFE_1008_107_MLO_CE_8H_1231")?.status, "armed"); assert.equal(h.timer("SAFE_1008_107_MLO_CE_8H_1231")?.dueDate, "2026-12-31");
  // renewal cannot be requested before the CE is complete (SAFE breach text)
  assert.throws(() => requestRenewal(h.events, ramirez, { requested_on: D("2026-12-10"), by: MLO_HUMAN("u-ramirez"), confirmation_document_id: "DOC-NMLS-REQ", at: "2026-12-10T15:00:00.000Z" }), (e: unknown) => e instanceof LicensingRefused && e.code === "SAFE_1008_107_MLO_CE_8H_1231");
  // Wed Dec 16: 8 h (3 federal law / 2 ethics / 2 nontraditional + 1 elective)
  const ce = recordCeCompletion(h.events, ramirez, { completed_on: D("2026-12-16"), federal_law_hours: 3, ethics_hours: 2, nontraditional_hours: 2, elective_hours: 1, certificate_document_id: "DOC-CE-RAMIREZ", at: "2026-12-16T22:00:00.000Z" });
  ramirez = ce.license; assert.equal(ce.hours, 8); assert.equal(ramirez.ce_completed_at, "2026-12-16");
  assert.equal(h.timers.byCode("SAFE_1008_107_MLO_CE_8H_1231")[0]!.status, "satisfied");
  assert.equal(h.timer("SAFE_1008_107_MLO_CE_8H_1231")?.dueDate, "2027-12-31", "the recurring row re-arms on next year's Dec 31");
  // Thu Dec 17: the partner attests and requests renewal in NMLS (a human act; the agent may not file)
  assert.throws(() => requestRenewal(h.events, ramirez, { requested_on: D("2026-12-17"), by: SENTINEL, confirmation_document_id: "DOC-NMLS-REQ", at: "2026-12-17T15:00:00.000Z" }), (e: unknown) => e instanceof LicensingRefused && e.code === "NMLS_FILING_IS_HUMAN");
  const rq = requestRenewal(h.events, ramirez, { requested_on: D("2026-12-17"), by: MLO_HUMAN("u-ramirez"), confirmation_document_id: "DOC-NMLS-REQ", at: "2026-12-17T15:00:00.000Z" });
  ramirez = rq.license; assert.equal(ramirez.status, "renewal_requested"); assert.equal(ramirez.renewal_requested_at, "2026-12-17");
  // Mon Jan 4, 2027: NMLS approves (backdated to the new term) → expires_at 2027-12-31; the renewal deadline row is satisfied
  const ap = approveRenewal(h.events, ramirez, { approved_on: D("2027-01-04"), nmls_status_raw: "Approved", at: "2027-01-04T14:00:00.000Z" });
  ramirez = ap.license;
  assert.equal(ramirez.status, "approved"); assert.equal(ramirez.expires_at, "2027-12-31"); assert.equal(ramirez.renewed_at, "2027-01-04");
  assert.equal(h.timers.byCode("NMLS_RENEWAL_1101_1231")[0]!.status, "satisfied");
  assert.equal(h.timer("NMLS_RENEWAL_1101_1231")?.dueDate, "2027-12-31", "next year's deadline re-armed from the renewal");
  // the new term's expiry warning arms from `license.status.changed{to=approved, expires_at}`: 2027-12-31 − 90 days
  assert.equal(h.timer("SM_LICENSE_EXPIRY_WARN_90")?.dueDate, "2027-10-02");
});

test("31.1-T6: Given HFS $150,000,000.00, IRLC pipeline $200,000,000.00, fallout 30 %, prior-year originations $1,400,000,000.00 for Q4 2026, then `origination_liquidity_required_cents = 1_450_000_00` and the inputs are due to 18.3 by Fri Jan 8, 2027; given prior-year originations $900,000,000.00, the component is 0.", () => {
  const h = harness("2026-12-31T23:30:00.000Z");
  closeQuarter(h.events, { period: "2026Q4", quarter_end: D("2026-12-31"), at: "2027-01-01T05:05:00.000Z" });
  assert.equal(h.timer("FNMA_A4_1_01_ORIG_LIQUIDITY_INPUTS_QBD5")?.dueDate, "2027-01-08");   // Jan 4, 5, 6, 7, 8 — Fri Jan 1 observed holiday excluded
  assert.equal(h.timer("FNMA_A3_3_01_TPO_QUARTERLY_PERFORMANCE_90")?.dueDate, "2027-01-30");
  const r = computeOrigInputs(h.events, { period: "2026Q4", quarter_end: D("2026-12-31"), hfs_upb_cents: 150_000_000_00n, irlc_pipeline_cents: 200_000_000_00n, fallout_rate: "0.30", trailing_12m_originations_cents: 1_400_000_000_00n, computed_at: "2027-01-05T15:00:00.000Z" });
  assert.equal(r.row.irlc_adjusted_cents, 140_000_000_00n); assert.equal(r.row.origination_liquidity_base_cents, 290_000_000_00n);
  assert.equal(r.row.origination_liquidity_applies, true); assert.equal(r.row.origination_liquidity_required_cents, 1_450_000_00n);
  assert.equal(r.row.due_to_18_3, "2027-01-08");
  assert.equal(h.timer("FNMA_A4_1_01_ORIG_LIQUIDITY_INPUTS_QBD5")?.status, "satisfied");
  const d = deliverOrigInputs(h.events, r.row, "2027-01-07T16:00:00.000Z"); assert.equal(d.on_time, true); assert.equal(d.row.delivered_to_18_3_at, "2027-01-07T16:00:00.000Z");
  const small = computeOrigInputs(h.events, { period: "2026Q4", quarter_end: D("2026-12-31"), hfs_upb_cents: 150_000_000_00n, irlc_pipeline_cents: 200_000_000_00n, fallout_rate: "0.30", trailing_12m_originations_cents: 900_000_000_00n, computed_at: "2027-01-05T15:00:00.000Z" });
  assert.equal(small.row.origination_liquidity_applies, false); assert.equal(small.row.origination_liquidity_required_cents, 0n); assert.equal(small.row.origination_liquidity_base_cents, 290_000_000_00n);
});

test("31.1-T7: Given `fnma_approvals{partner, emortgage_special_approval}` granted Fri Oct 23, 2026, then the Nov 6 refinance closing may be scheduled `ron` with an eNote; given the approval arrives Nov 9, the Nov 6 closing is scheduled `hybrid` and `closing.enote_default` is overridden with reason `emortgage_gate_closed`.", () => {
  const h = harness("2026-10-30T15:00:00.000Z");
  closingScheduled(h, h.clock.now(), true);
  assert.equal(h.timer("FNMA_A2_1_01_EMORTGAGE_APPROVAL_GATE")?.status, "armed");
  assert.deepEqual(emortgageGate(APPROVALS_OK, D("2026-10-30")), { open: true, missing: [] });
  const ron = decideClosingNoteForm(h.events, { application_id: APP_AZ, closing_id: "CL-1", enote_default: true, requested_closing_type: "ron", scheduled_on: D("2026-11-06"), approvals: APPROVALS_OK, at: h.clock.now() });
  assert.equal(ron.closing_type, "ron"); assert.equal(ron.note_form, "enote"); assert.equal(ron.override, null);
  assert.equal(h.timer("FNMA_A2_1_01_EMORTGAGE_APPROVAL_GATE")?.status, "satisfied");
  assert.equal(EVALUATORS_31_1["31.1.emortgageApprovalGate"]!({ approvals: APPROVALS_OK, as_of: "2026-10-30" }).open, true);
  // the approval letter arrives Nov 9 instead: at scheduling the gate is closed → hybrid (paper note), enote_default overridden
  const h2 = harness("2026-11-02T15:00:00.000Z");
  const late: FnmaApproval[] = APPROVALS_OK.map((a) => (a.kind === "emortgage_special_approval" ? { ...a, granted_at: D("2026-11-09") } : a));
  closingScheduled(h2, h2.clock.now(), true);
  const hy = decideClosingNoteForm(h2.events, { application_id: APP_AZ, closing_id: "CL-1", enote_default: true, requested_closing_type: "ron", scheduled_on: D("2026-11-06"), approvals: late, at: h2.clock.now() });
  assert.equal(hy.closing_type, "hybrid"); assert.equal(hy.note_form, "paper"); assert.deepEqual(hy.override, { field: "closing.enote_default", from: true, to: false, reason: "emortgage_gate_closed" });
  const ov = h2.ofType("closing.enote_default.overridden"); assert.equal(ov.length, 1); assert.equal((ov[0]!.payload as { reason: string }).reason, "emortgage_gate_closed"); assert.equal(ov[0]!.applicationId, APP_AZ);
  assert.equal((h2.ofType("licensing.gate.blocked")[0]!.payload as { gate: string }).gate, "FNMA_A2_1_01_EMORTGAGE_APPROVAL_GATE");
  assert.equal(h2.timer("FNMA_A2_1_01_EMORTGAGE_APPROVAL_GATE")?.status, "armed");
  assert.match(EVALUATORS_31_1["31.1.emortgageApprovalGate"]!({ approvals: late, as_of: "2026-11-02" }).reason ?? "", /emortgage_special_approval/);
});

test("31.1-T8: Given `tsp_certification{du}` not yet granted on Mon Oct 5, 2026, when the `fnma-du` adapter is invoked in production under partner scope, then the call is refused with `tsp_gate_closed` and a `fnma_portal_operator` task with the prepared DU file is created.", () => {
  const h = harness("2026-10-05T14:30:00.000Z");
  const approvals: FnmaApproval[] = [{ approval_id: "A-TSP-DU", entity: "sm", kind: "tsp_certification", product: "du", seller_servicer_number: null, status: "testing", granted_at: null, expires_at: null, conditions: {}, evidence_document_id: null, contact_ref: "TSP Integration Team" }];
  const form101 = { status: "acknowledged" as const };
  assert.deepEqual(tspProductionGate("du", approvals, form101, D("2026-10-05")).open, false);
  assert.throws(() => requestProductionCall(h.events, h.escalations, { product: "du", adapter: "fnma-du", application_id: APP_AZ, scope: "partner", environment: "production", prepared_file_document_id: "DOC-DU-MISMO34", ui_fallback: "DU UI", at: h.clock.now() }, { approvals, form101 }),
    (e: unknown) => e instanceof LicensingRefused && e.code === "tsp_gate_closed" && e.escalationId !== null);
  const task = h.escalations.list()[0]!;
  assert.equal(task.kind, "human_portal_task"); assert.equal(task.ownerRole, "fnma_portal_operator"); assert.equal(task.applicationId, APP_AZ); assert.equal(task.payload.prepared_file_document_id, "DOC-DU-MISMO34"); assert.equal(task.payload.product, "du");
  assert.equal(h.timer("FNMA_TSP_PRODUCTION_CERT_GATE")?.status, "armed");
  assert.equal((h.ofType("licensing.gate.blocked")[0]!.payload as { reason: string }).reason, "tsp_gate_closed");
  assert.match(EVALUATORS_31_1["31.1.tspProductionCertGate"]!({ product: "du", approvals, form101, as_of: "2026-10-05" }).reason ?? "", /tsp_certification\{du\} not granted/);
  // Fri Jan 15, 2027: DU certified and the partner's Technology Manager assignment active → the adapter path opens
  const certified: FnmaApproval[] = [{ ...approvals[0]!, status: "granted", granted_at: D("2027-01-15"), evidence_document_id: "DOC-TSP-CERT-DU" }, { approval_id: "A-TM-DU", entity: "partner", kind: "tm_tsp_product_assignment", product: "du", seller_servicer_number: "123456789", status: "active", granted_at: D("2027-01-15"), expires_at: null, conditions: {}, evidence_document_id: "DOC-TM-SCREENSHOT", contact_ref: null }];
  h.clock.set("2027-01-18T14:00:00.000Z");
  const ok = requestProductionCall(h.events, h.escalations, { product: "du", adapter: "fnma-du", application_id: APP_AZ, scope: "partner", environment: "production", prepared_file_document_id: null, ui_fallback: null, at: h.clock.now() }, { approvals: certified, form101 });
  assert.equal(ok.allowed, true); assert.equal(h.timer("FNMA_TSP_PRODUCTION_CERT_GATE")?.status, "satisfied");
  assert.equal(EVALUATORS_31_1["31.1.tspProductionCertGate"]!({ product: "du", approvals: certified, form101, as_of: "2027-01-18" }).open, true);
});

test("31.1-T9: Given a request to set `origination.warehouse_legal_form = purchase_at_settlement` without an `officer` + `attorney` decision record, then the change is rejected; with the record, the change is applied and 26.3/27.1 receive `config.changed` (table-funding consequences flagged).", async () => {
  const h = harness("2026-10-01T15:00:00.000Z");
  assert.throws(() => setWarehouseLegalForm(h.events, { from: "secured_loan_to_partner", to: "purchase_at_settlement", by: OFFICER, decision: null, at: h.clock.now() }), (e: unknown) => e instanceof LicensingRefused && e.code === "table_funding_form_not_approved");
  assert.throws(() => setWarehouseLegalForm(h.events, { from: "secured_loan_to_partner", to: "purchase_at_settlement", by: OFFICER, decision: { decision_id: "DEC-9", roles: ["officer"] }, at: h.clock.now() }), (e: unknown) => e instanceof LicensingRefused && e.code === "table_funding_form_not_approved");
  assert.throws(() => setWarehouseLegalForm(h.events, { from: "secured_loan_to_partner", to: "purchase_at_settlement", by: SENTINEL, decision: { decision_id: "DEC-9", roles: ["officer", "attorney"] }, at: h.clock.now() }), (e: unknown) => e instanceof LicensingRefused && e.code === "WAREHOUSE_LEGAL_FORM_HUMAN_ONLY");
  assert.equal(h.ofType("config.changed").length, 0);
  const r = setWarehouseLegalForm(h.events, { from: "secured_loan_to_partner", to: "purchase_at_settlement", by: OFFICER, decision: { decision_id: "DEC-9", roles: ["officer", "attorney"] }, at: h.clock.now() });
  assert.equal(r.value, "purchase_at_settlement");
  const p = r.event.payload as Record<string, unknown>;
  assert.equal(r.event.type, "config.changed"); assert.equal(p.key, "origination.warehouse_legal_form"); assert.deepEqual(p.consumers, ["26.3", "27.1"]); assert.equal(p.table_funding, true); assert.equal(p.decision_id, "DEC-9");
  assert.ok((p.consequences as string[]).some((c) => /RESPA lender/.test(c)) && (p.consequences as string[]).some((c) => /mortgage broker/.test(c)));
  // through the bus: the agent is refused before anything runs; a lone officer is refused; officer with the record applies it
  const b = busFor(h);
  await assert.rejects(b.run("licenses.upsert", { op: "warehouse_legal_form", to: "purchase_at_settlement", decision: { decision_id: "DEC-9", roles: ["officer", "attorney"] } }), (e: unknown) => e instanceof CommandRefused && e.code === "WAREHOUSE_LEGAL_FORM_HUMAN_ONLY");
  await assert.rejects(b.run("licenses.upsert", { op: "warehouse_legal_form", to: "purchase_at_settlement" }, { kind: "human", id: "u-analyst", role: "ops_analyst" }), (e: unknown) => e instanceof CommandRefused);
  const out = await b.run("licenses.upsert", { op: "warehouse_legal_form", to: "purchase_at_settlement", decision: { decision_id: "DEC-9", roles: ["officer", "attorney"] } }, OFFICER);
  assert.equal((out.output as { value: string }).value, "purchase_at_settlement"); assert.equal(b.rt.store.get("feature_flags", "origination.warehouse_legal_form")?.data.value, "purchase_at_settlement");
});

test("31.1-T10: Given the agent attempts `licenses.upsert{status=approved}` with no evidence document or NMLS record, then the write is refused.", async () => {
  const h = harness("2026-10-01T15:00:00.000Z");
  const draft = { license_id: "L-NEW", holder_kind: "partner_company" as const, holder_ref: PARTNER, jurisdiction: "NV", license_type_code: "NV_MORTGAGE_COMPANY", activity_scope: ["lend" as const] };
  assert.throws(() => assertLicenseEvidence("approved", {}), (e: unknown) => e instanceof LicensingRefused && e.code === "LICENSE_APPROVAL_NEEDS_EVIDENCE");
  assert.throws(() => upsertLicense(h.events, null, { ...draft, status: "approved", at: h.clock.now() }), (e: unknown) => e instanceof LicensingRefused && e.code === "LICENSE_APPROVAL_NEEDS_EVIDENCE");
  const applied = upsertLicense(h.events, null, { ...draft, status: "applied", evidence_document_id: "DOC-NMLS-FILING", at: h.clock.now() });
  assert.equal(applied.event?.type, "license.applied");
  assert.throws(() => changeLicenseStatus(h.events, applied.license, { to: "approved", at: h.clock.now() }), (e: unknown) => e instanceof LicensingRefused && e.code === "LICENSE_APPROVAL_NEEDS_EVIDENCE");
  const b = busFor(h);
  await assert.rejects(b.run("licenses.upsert", { license: { ...draft, status: "approved" } }), (e: unknown) => e instanceof CommandRefused && e.code === "LICENSE_APPROVAL_NEEDS_EVIDENCE");
  assert.equal(b.rt.store.get("licenses", "L-NEW"), undefined, "the refused write persisted nothing");
  assert.equal(h.ofType("command.refused").length, 1);
  // with an NMLS Consumer Access record the same write is accepted
  const ok = await b.run("licenses.upsert", { license: { ...draft, status: "approved", nmls_status_raw: "Approved", issued_at: "2026-09-28", expires_at: "2026-12-31" } });
  assert.equal((ok.output as { license: License }).license.status, "approved"); assert.equal(b.rt.store.get("licenses", "L-NEW")?.data.status, "approved");
  // the same guardrail on Fannie Mae approvals
  await assert.rejects(b.run("licenses.upsert", { op: "approval", approval: { approval_id: "A-X", entity: "partner", kind: "emortgage_special_approval", status: "granted", granted_at: "2026-10-23" } }), (e: unknown) => e instanceof CommandRefused && e.code === "APPROVAL_GRANT_NEEDS_EVIDENCE");
});

test("31.1-T11: Given a state page change detected for Ohio on 2027-03-01, then the OH rows degrade to `partially_verified`, a counsel task opens, and the state stays open (no processor-rule change) until counsel decides.", () => {
  const h = harness("2026-09-11T15:00:00.000Z");
  // counsel's verification arms the annual re-verification clock
  const v = verifyMatrixRow(h.events, { ...MATRIX.find((r) => r.requirement_id === "R-OH-sm-processing_underwriting_entity")!, verification_status: "unverified", verified_at: null, verified_by: null }, { verified_on: D("2026-09-11"), by: COUNSEL, memo_document_id: "DOC-OH-MEMO", at: h.clock.now() });
  assert.equal(v.row.verification_status, "verified"); assert.equal(h.timer("SM_O121_MATRIX_REVERIFY_365")?.dueDate, "2027-09-11");
  assert.throws(() => verifyMatrixRow(h.events, v.row, { verified_on: D("2026-09-11"), by: SENTINEL, memo_document_id: "DOC-OH-MEMO", at: h.clock.now() }), (e: unknown) => e instanceof LicensingRefused && e.code === "MATRIX_NEVER_VERIFIED_BY_AGENT");
  h.clock.set("2027-03-01T13:00:00.000Z");
  const before = facts("OH", "2027-03-01", { licenses: BASE_LICENSES.map((l) => ({ ...l, expires_at: D("2027-12-31") })) });
  assert.equal(before.jurisdiction.processor_license_required, "exemption_letter");
  const r = detectStatePageChange(h.events, h.escalations, MATRIX, { state: "OH", detected_on: D("2027-03-01"), source_url: "https://codes.ohio.gov/ohio-administrative-code/rule-1301:8-7-32", summary: "rule text changed", at: h.clock.now() });
  assert.deepEqual(r.degraded.sort(), MATRIX.filter((x) => x.jurisdiction === "OH").map((x) => x.requirement_id).sort());
  assert.ok(r.rows.filter((x) => x.jurisdiction === "OH").every((x) => x.verification_status === "partially_verified"));
  assert.ok(r.rows.filter((x) => x.jurisdiction !== "OH").every((x, k) => x === MATRIX.filter((y) => y.jurisdiction !== "OH")[k]));
  assert.equal(r.escalation.kind, "attorney"); assert.equal(r.escalation.ownerRole, "counsel"); assert.equal(r.escalation.payload.state, "OH");
  assert.equal(r.processor_rule_changed, false);
  const after = facts("OH", "2027-03-01", { licenses: BASE_LICENSES.map((l) => ({ ...l, expires_at: D("2027-12-31") })), rows: r.rows });
  assert.equal(after.jurisdiction.verification_status, "partially_verified"); assert.equal(after.jurisdiction.processor_license_required, "exemption_letter");
  assert.equal(stateReadiness(after).open, true);
  assert.equal(h.timer("SM_O121_MATRIX_REVERIFY_365")?.status, "armed", "the re-verification clock keeps running until counsel decides");
  assert.equal((h.ofType("jurisdiction.licensing.changed")[0]!.payload as { to: string }).to, "partially_verified");
});

test("31.1-T12: Given SM's employee is proposed as `mlo_of_record` for an AZ application, then the roster refuses (`employer = sm` with no SM-sponsored AZ MLO license and `ai_intake_position = assisted_required`).", () => {
  const f = facts("AZ", "2026-10-05");
  const proc = f.roster.find((m) => m.mlo_id === "M-SM-PROC")!;
  const r = proposeMloOfRecord(proc, "AZ", f.jurisdiction, f.licenses, f.as_of);
  assert.equal(r.accepted, false);
  assert.deepEqual(r.refusal_codes, ["employer=sm", "no SM-sponsored AZ MLO license", "ai_intake_position = assisted_required"]);
  assert.equal(proc.assignable, false); assert.deepEqual(proc.states_assignable, []);
  // even an SM underwriter holding an SM-sponsored AZ_MLO is refused while the state's position is assisted_required (open question 5: default never)
  const uw = f.roster.find((m) => m.mlo_id === "M-SM-UW1")!;
  assert.deepEqual(proposeMloOfRecord(uw, "AZ", f.jurisdiction, f.licenses, f.as_of).refusal_codes, ["employer=sm", "ai_intake_position = assisted_required"]);
  assert.equal(uw.assignable, false);
  // the partner's sponsored AZ MLO is accepted
  assert.deepEqual(proposeMloOfRecord(f.roster.find((m) => m.mlo_id === "M-LEE")!, "AZ", f.jurisdiction, f.licenses, f.as_of), { accepted: true, refusal_codes: [] });
});

test("31.1-T13: Given `license.status.changed{to=suspended}` for the partner's Texas license on Tue Nov 10, 2026, then 18.4's `org.change.recorded{material}` is emitted and readiness for TX closes immediately (in-flight TX files escalate to `officer`).", () => {
  const h = harness("2026-11-10T15:00:00.000Z");
  const before = facts("TX", "2026-11-10"); assert.equal(stateReadiness(before).open, true);
  const tx = BASE_LICENSES.find((l) => l.license_id === "L-TX-PARTNER")!;
  const r = changeLicenseStatus(h.events, tx, { to: "suspended", at: h.clock.now(), nmls_status_raw: "Approved - Suspended", regulator: "Texas SML", reason: "regulatory action" });
  assert.equal(r.license.status, "suspended");
  assert.equal(r.event.type, "license.status.changed"); assert.equal((r.event.payload as { to: string }).to, "suspended"); assert.equal((r.event.payload as { holder_kind: string }).holder_kind, "partner_company");
  assert.ok(r.org_change); assert.equal(r.org_change.type, "org.change.recorded");
  const oc = r.org_change.payload as Record<string, unknown>;
  assert.equal(oc.material, true); assert.equal(oc.entity, "partner"); assert.equal(oc.occurred_at, "2026-11-10"); assert.equal(oc.license_id, "L-TX-PARTNER"); assert.equal(oc.source_process, "31.1");
  assert.equal(h.ofType("org.change.recorded").length, 1);
  // readiness for TX closes at once: the partner company predicate fails → in-flight TX files escalate to officer
  const licenses = BASE_LICENSES.map((l) => (l.license_id === "L-TX-PARTNER" ? r.license : l));
  const after = facts("TX", "2026-11-10", { licenses });
  const rd = stateReadiness(after); assert.equal(rd.open, false); assert.equal(rd.reason, "partner_license_missing"); assert.equal(rd.escalated_party, "partner");
  const closed = closeStateForInFlight(h.events, h.escalations, { state: "TX", reason: "partner_license_suspended", applications: [{ application_id: "APP-TX-1" }, { application_id: "APP-TX-2" }], at: h.clock.now() }, after);
  assert.equal(closed.escalations.length, 2); assert.ok(closed.escalations.every((e) => e.kind === "officer" && e.severity === "sev1" && /^APP-TX-/.test(e.applicationId ?? "")));
  assert.equal((closed.event.payload as { open: boolean }).open, false);
  assert.throws(() => assertStateGate(h.events, { command: "application.start", at: h.clock.now(), application_id: "APP-TX-3" }, after, h.escalations), (e: unknown) => e instanceof LicensingRefused && /partner_license_missing/.test(e.message));
  // an SM licence suspension is an SM matter (no partner org-change record)
  const sm = changeLicenseStatus(h.events, BASE_LICENSES.find((l) => l.license_id === "L-TX-SM-COMPANY")!, { to: "suspended", at: h.clock.now(), nmls_status_raw: "Approved - Suspended" });
  assert.equal(sm.org_change, null);
});

test("31.1 worked figures: Q4 2026 origination eligibility inputs ($1,450,000.00), the 18.3 arithmetic the spec illustrates, the NMLS calendar and the TPO cadence", () => {
  const h = harness("2027-01-05T15:00:00.000Z");
  // rule 5: HFS $150,000,000.00; IRLC $200,000,000.00 × (1 − 0.30) = $140,000,000.00; base $290,000,000.00 × 50 bps = $1,450,000.00
  const r = computeOrigInputs(h.events, { period: "2026Q4", quarter_end: D("2026-12-31"), hfs_upb_cents: 150_000_000_00n, irlc_pipeline_cents: 200_000_000_00n, fallout_rate: "0.3000", trailing_12m_originations_cents: 1_400_000_000_00n, computed_at: h.clock.now() }).row;
  assert.equal(r.irlc_adjusted_cents, 140_000_000_00n); assert.equal(r.origination_liquidity_base_cents, 290_000_000_00n); assert.equal(r.origination_liquidity_required_cents, 1_450_000_00n);
  assert.equal(bpsOf(290_000_000_00n, 50n), 1_450_000_00n); assert.equal(scaledRate("0.30"), 3000n); assert.equal(scaledRate("0.3000"), 3000n);
  assert.equal(r.due_to_18_3, "2027-01-08");
  // 18.3 then computes the whole test: net worth $2,500,000.00 + 0.25 % × $2,000,000,000.00 + 0.35 % × 0 + 0.25 % × $300,000,000.00 = $8,250,000.00;
  // base liquidity 3.5 bps × $2,000,000,000.00 ($700,000.00) + 3.5 bps × $300,000,000.00 ($105,000.00) = $805,000.00; total $805,000.00 + $1,450,000.00 = $2,255,000.00; capital 9,000,000 / 120,000,000 = 7.5 % ≥ 6 %
  const e = fhfaEligibilityIllustration({ fnma_freddie_upb_cents: 2_000_000_000_00n, gnma_upb_cents: 0n, other_upb_cents: 300_000_000_00n, origination_liquidity_required_cents: r.origination_liquidity_required_cents, tangible_net_worth_cents: 9_000_000_00n, total_assets_cents: 120_000_000_00n });
  assert.equal(e.net_worth_required_cents, 8_250_000_00n); assert.equal(bpsOf(2_000_000_000_00n, 25n), 5_000_000_00n); assert.equal(bpsOf(300_000_000_00n, 25n), 750_000_00n);
  assert.equal(tenthBpsOf(2_000_000_000_00n, 35n), 700_000_00n); assert.equal(tenthBpsOf(300_000_000_00n, 35n), 105_000_00n);
  assert.equal(e.base_liquidity_required_cents, 805_000_00n); assert.equal(e.total_liquidity_required_cents, 2_255_000_00n); assert.equal(e.capital_ratio_pct, "7.50"); assert.equal(e.capital_ok, true);
  // rule 4: the 2026–27 NMLS calendar; rule 9: SM FYE Dec 31 → AFS Mar 31, 2027 → partner review Apr 30, 2027; Q4 package Jan 30, 2027
  assert.deepEqual(renewalCalendar(2026), { year: 2026, window_opens: "2026-11-01", deadline: "2026-12-31", reinstatement_opens: "2027-01-01", reinstatement_ends: "2027-02-28", policy_ce_target: "2026-12-01", next_expires_at: "2027-12-31" });
  assert.equal(renewalCalendar(2027).reinstatement_ends, "2028-02-29");
  const c = tpoCadence(D("2026-12-31"), D("2026-12-31")); assert.equal(c.afs_due, "2027-03-31"); assert.equal(c.annual_review_due, "2027-04-30"); assert.equal(c.quarterly_package_due, "2027-01-30");
  assert.equal(`$${(Number(r.origination_liquidity_required_cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, "$1,450,000.00");
});
