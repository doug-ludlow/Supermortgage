// 22.6 Identity, fraud, OFAC/AML, Red Flags, occupancy/undisclosed-REO, and non-arm's-length screening
// spec/sections/22-documents-credit-income-assets-liabilities-identity-and-frau/22-6-identity-fraud-ofac-aml-red-flags-occupancy-undisclosed-reo.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_22_6 } from "../../app/tools/section22-6.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import {
  ALERT_CONTACT_WINDOW_BUSINESS_DAYS, CBSV_ENROLLMENT_CENTS, CBSV_FEE_CENTS, DECLINE_REASON_UNVERIFIABLE, FakeCbsv, FakeFraudTool, FakeIdentityVendor, FakeMers, FakeOfacScreener, HOLD_BLOCKED_COMMANDS, OCCUPANCY_WEIGHTS, SAR_THRESHOLD_CENTS, ScreeningRefused,
  assertNoDemographicInputs, assertNoSarTerms, classifyIdentityResult, contactSatisfiesGate, decisionRecord, identityInconclusive, identityPass, identityRetryDue, investigationDue, listStale, ofacReportDue, ofacRecordsRetainedUntil, pitiaCents, redFlagResponseDue, rescreenRequired, sarDeadlines, scoreOccupancy, scrubSarTerms, selfReportDue, unreachableDeadline,
  type FraudAlertFact, type IdentitySessionResult, type ListVersion, type OfacCandidate, type OccupancySignals,
} from "./ops-22-6.ts";
import { otherFinancedPctBps } from "./ops-22-4.ts";

const AGENT: Actor = { kind: "agent", id: "fraud-risk" };
const BSA: Actor = { kind: "human", id: "u-bsa", role: "bsa_officer" };
const APP = "app-22-6", A = "B-A", B = "B-B";
/** Purchase fixture (Columbus OH — Eastern) and refinance fixture (Phoenix — MST all year). */
const et = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/New_York"));
const mst = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/Phoenix"));
const SDN_OCT5: ListVersion[] = [{ list: "ofac_sdn", version: "SLS-2026-10-05", published_on: D("2026-10-05") }, { list: "ofac_consolidated", version: "CONS-2026-10-05", published_on: D("2026-10-05") }];
const SDN_NOV3: ListVersion[] = [{ list: "ofac_sdn", version: "SLS-2026-11-03", published_on: D("2026-11-03") }, { list: "ofac_consolidated", version: "CONS-2026-11-03", published_on: D("2026-11-03") }];
const SDN_NOV4: ListVersion[] = [{ list: "ofac_sdn", version: "SLS-2026-11-04", published_on: D("2026-11-04") }, { list: "ofac_consolidated", version: "CONS-2026-11-04", published_on: D("2026-11-04") }];

/** The 22.6 tools on the bus over the overridden registry (22.6 rows plus 28.4's SAR / self-report / OFAC clocks that arm on this process's hand-off events), the vendor fakes, the escalation service and an entity store seeded with the application. */
function harness(nowIso: string, o: { identity?: FakeIdentityVendor; cbsv?: FakeCbsv; ofac?: FakeOfacScreener; fraud?: FakeFraudTool; app?: Record<string, unknown> } = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId: APP });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["22.6", "28.4"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId: "", applicationId: APP, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };   // no loans row before funding (30.2): the application is the aggregate
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: { identity_vendor: o.identity ?? new FakeIdentityVendor({}), cbsv: o.cbsv ?? new FakeCbsv(), ofac_screener: o.ofac ?? new FakeOfacScreener(), fraud_tool: o.fraud ?? new FakeFraudTool(), mers: new FakeMers() }, ports: {} };
  rt.store.put("applications", APP, { occupancy: "primary", units: 1, borrower_ids: [A, B], scheduled_note_date: "2026-11-18", ...(o.app ?? {}) }, AGENT, nowIso);
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_22_6); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("22.6", name))!, actor, { application_id: APP, ...input }, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === APP);
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt = clock.now(), actor: Actor = { kind: "agent", id: "verification" }) => events.append({ type, applicationId: APP, aggregate: { kind: "application", id: APP }, actor, occurredAt, payload: { application_id: APP, ...payload } });
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  const escalations = (kind: string) => rt.escalations.opened.filter((e) => e.kind === kind);
  return { clock, events, timers, rt, run, at, timer, ofType, upstream, refused, escalations, decisions };
}

test("22.6-T1: (IAL2 gate) Given two borrowers on the purchase fixture (Mon Oct 19, 2026), when Borrower A passes document + liveness + face match and Borrower B's session is inconclusive, then `SM_IDENTITY_IAL2_GATE` blocks `submitDu`, `SM_IDENTITY_RETRY_2BD` is due Wed Oct 21, 2026, and a supervised remote session passing Oct 20 opens the gate.", async () => {
  const vendor = new FakeIdentityVendor({ [A]: identityPass("S-A-1"), [B]: (method) => (method === "remote_doc_biometric" ? identityInconclusive("S-B-1") : identityPass("S-B-2", { id_document_type: "ead", id_document_expires_on: D("2027-03-31") })) });
  const h = harness(et("2026-10-19", "10:00"), { identity: vendor });
  h.upstream("application.received", { received_at: et("2026-10-19", "09:30") }, et("2026-10-19", "09:30"), { kind: "agent", id: "intake" });
  assert.equal(h.timer("SM_IDENTITY_IAL2_GATE")?.status, "armed");
  const a = await h.run("verifyIdentity", { borrower_id: A });
  assert.equal(a.outcome, "verified"); assert.equal(a.level, "ial2_remote_doc_biometric"); assert.equal(a.all_borrowers_verified, false);
  const b = await h.run("verifyIdentity", { borrower_id: B });
  assert.equal(b.outcome, "inconclusive"); assert.equal(b.retry_due, "2026-10-21"); assert.equal(identityRetryDue(D("2026-10-19")), "2026-10-21");
  const gate = b.gate as { open: boolean; reason?: string }; assert.equal(gate.open, false); assert.match(gate.reason ?? "", /blocks submitDu/);
  assert.equal(evaluateGate("22.6.identityIal2Gate", { borrower_ids: [A, B], levels: { [A]: "ial2_remote_doc_biometric", [B]: null } }).open, false);
  const retry = h.timer("SM_IDENTITY_RETRY_2BD")!; assert.equal(retry.status, "armed"); assert.equal(retry.dueDate, "2026-10-21");
  assert.equal(h.timer("SM_IDENTITY_IAL2_GATE")?.status, "armed");   // closed: identity.verified{all_borrowers_verified=true} has not fired
  assert.equal(h.ofType("identity.inconclusive").length, 1); assert.equal((h.ofType("identity.inconclusive")[0]!.payload as { next: string }).next, "supervised_remote");
  // Tue Oct 20: the supervised remote session passes → second-method result satisfies the retry clock, the last borrower's identity.verified opens the gate
  h.at(et("2026-10-20", "14:00"));
  const b2 = await h.run("verifyIdentity", { borrower_id: B, method: "supervised_remote" });
  assert.equal(b2.outcome, "verified"); assert.equal(b2.level, "ial2_supervised_remote"); assert.equal(b2.all_borrowers_verified, true); assert.equal((b2.gate as { open: boolean }).open, true);
  assert.equal(h.timer("SM_IDENTITY_RETRY_2BD")?.status, "satisfied"); assert.equal(h.timer("SM_IDENTITY_IAL2_GATE")?.status, "satisfied");
  assert.equal(evaluateGate("22.6.identityIal2Gate", { borrower_ids: [A, B], levels: { [A]: "ial2_remote_doc_biometric", [B]: "ial2_supervised_remote" } }).open, true);
  assert.equal(vendor.sessions.filter((s) => s.borrower_id === B).map((s) => s.method).join(","), "remote_doc_biometric,supervised_remote");
  // R1: an expired ID is never accepted; an ID expiring before the note date is re-verified at closing
  assert.equal(classifyIdentityResult(identityPass("x", { id_document_expires_on: D("2026-10-01") }), D("2026-10-19"), D("2026-11-18")).outcome, "failed");
  assert.equal(classifyIdentityResult(identityPass("x", { id_document_expires_on: D("2026-11-10") }), D("2026-10-19"), D("2026-11-18")).reverify_at_closing, true);
  await h.refused(h.run("verifyIdentity", { borrower_id: A, purpose: "marketing_face_index" }), "BIOMETRIC_PURPOSE_LIMIT");
});

test("22.6-T2: (SSN discrepancy → SSA validation → SFC 162) Given DU returns an SSN issue-date/age message for Borrower B (SSN issued 2019, DOB 1988) that documents cannot resolve, when CBSV returns a match with no death indicator, then `ssn.validated{cbsv_web_service}`, the loan is eligible, and because DU's edit persists `sfc_162_required = true` flows to 29.3; given CBSV returns no match, then `not_validated`, the loan is ineligible and 21.6 receives the decline with `underwriting_reviewer` approval.", async () => {
  const cbsv = new FakeCbsv({ [B]: { match: true, death_indicator: false } });
  const h = harness(et("2026-10-20", "11:00"), { cbsv });
  const d = await h.run("resolveSsn", { op: "detect", borrower_id: B, indicator: "du_ssn_message", detail: { ssn_issue_year: 2019, dob_year: 1988, message: "SSN issue date is inconsistent with the borrower's age" } });
  assert.equal((d.record as { status: string }).status, "discrepancy_open"); assert.equal(h.timer("FNMA_B2_2_01_SSN_VALIDATION_GATE")?.status, "armed");
  assert.equal(evaluateGate("22.6.ssnValidationGate", { ssn_status: "discrepancy_open" }).open, false);
  const doc = await h.run("resolveSsn", { op: "documentary", borrower_id: B, documents: [{ document_id: "doc-ssn-card", doc_class: "ssn_card", name_matches: true }, { document_id: "doc-w2", doc_class: "w2", name_matches: false }] });
  assert.equal(doc.next, "ssa_validation"); assert.equal(doc.event, null);
  await h.refused(h.run("orderCbsv", { borrower_id: B, response: { request_id: "x", match: true, death_indicator: false } }), "CBSV_NEEDS_SIGNED_SSA_89");
  const v = await h.run("orderCbsv", { borrower_id: B, ssa_89_document_id: "doc-ssa89-B", name: "Borrower B", date_of_birth: "1988-04-12", ssn_hash: "h-b", discrepancy_persists: true });
  assert.equal(v.eligible, true); assert.equal(v.sfc_162_required, true); assert.equal(v.fee_cents, CBSV_FEE_CENTS); assert.equal(v.fee_cents, 225n);
  assert.equal(cbsv.requests[0]!.ssa_89_document_id, "doc-ssa89-B");
  const ev = h.ofType("ssn.validated")[0]!.payload as { method: string; sfc_162_required: boolean; delivery_sfc: number; retention_class: string };
  assert.equal(ev.method, "cbsv_web_service"); assert.equal(ev.sfc_162_required, true); assert.equal(ev.delivery_sfc, 162); assert.equal(ev.retention_class, "ssa_89_5y");
  assert.equal(h.timer("FNMA_B2_2_01_SSN_VALIDATION_GATE")?.status, "satisfied"); assert.equal(evaluateGate("22.6.ssnValidationGate", { ssn_status: "validated" }).open, true);
  assert.equal(h.escalations("underwriting_reviewer").length, 0);
  // no match → not_validated, ineligible, 21.6 with underwriting_reviewer
  const h2 = harness(et("2026-10-20", "11:00"), { cbsv: new FakeCbsv({ [B]: { match: false, death_indicator: false } }) });
  await h2.run("resolveSsn", { op: "detect", borrower_id: B, indicator: "du_ssn_message" });
  const nv = await h2.run("orderCbsv", { borrower_id: B, ssa_89_document_id: "doc-ssa89-B", discrepancy_persists: true });
  assert.equal(nv.eligible, false); assert.equal((nv.record as { status: string }).status, "not_validated"); assert.equal(nv.sfc_162_required, false); assert.equal(nv.escalated_to, "underwriting_reviewer");
  assert.equal(h2.ofType("ssn.validation.failed").length, 1); assert.equal((h2.ofType("ssn.validation.failed")[0]!.payload as { eligible: boolean }).eligible, false);
  assert.equal(h2.escalations("underwriting_reviewer").length, 1); assert.match(String(h2.escalations("underwriting_reviewer")[0]!.payload.route), /21\.6 decline/);
  assert.equal(h2.timer("FNMA_B2_2_01_SSN_VALIDATION_GATE")?.status, "armed"); assert.equal(evaluateGate("22.6.ssnValidationGate", { ssn_status: "not_validated" }).open, false);
});

test("22.6-T3: (legal presence at note date) Given Borrower B's EAD expires 2027-03-31 and the note date is Wed Nov 18, 2026, then `FNMA_B2_2_02_LEGAL_PRESENCE_GATE` is open; given the EAD expired 2026-11-01 with a pending renewal receipt and partner policy `legal_presence.pending_renewal_accepted = false`, then the gate blocks `consummate` and a condition opens.", async () => {
  const h = harness(et("2026-10-20", "12:00"));
  const ok = await h.run("assessLegalPresence", { borrower_id: B, status_declared: "non_permanent_resident", evidence_kind: "ead", evidence_document_id: "doc-ead-B", evidence_expires_on: "2027-03-31", scheduled_note_date: "2026-11-18" });
  const rec = ok.record as { assessment: string; expires_before_note_date: boolean; regb_6b7_rationale: string };
  assert.equal(rec.expires_before_note_date, false); assert.equal(rec.assessment, "legally_present"); assert.match(rec.regb_6b7_rationale, /1002\.6\(b\)\(7\)/); assert.equal(ok.condition, null);
  assert.equal((ok.gate as { open: boolean }).open, true);
  const t = h.timer("FNMA_B2_2_02_LEGAL_PRESENCE_GATE")!; assert.equal(t.status, "satisfied"); assert.equal(t.anchorDate, "2026-11-18");
  assert.equal(evaluateGate("22.6.legalPresenceGate", { assessment: "legally_present" }).open, true);
  // expired EAD, pending renewal receipt, partner policy pending_renewal_accepted = false → not_established: consummate blocked, condition opens
  const h2 = harness(et("2026-11-05", "12:00"));
  h2.rt.store.put("partner_policy", "legal_presence", { pending_renewal_accepted: false }, AGENT, h2.clock.now());
  const no = await h2.run("assessLegalPresence", { borrower_id: B, status_declared: "non_permanent_resident", evidence_kind: "ead", evidence_document_id: "doc-ead-B", evidence_expires_on: "2026-11-01", scheduled_note_date: "2026-11-18", renewal_receipt_present: true });
  const r2 = no.record as { assessment: string; expires_before_note_date: boolean };
  assert.equal(r2.expires_before_note_date, true); assert.equal(r2.assessment, "not_established");
  const gate = no.gate as { open: boolean; reason: string }; assert.equal(gate.open, false); assert.match(gate.reason, /blocks consummate/);
  assert.equal((no.condition as { kind: string }).kind, "ptd_legal_presence"); assert.match((no.condition as { text: string }).text, /pending renewal receipt is not accepted/);
  assert.equal(h2.rt.store.list("conditions", (d) => d.kind === "ptd_legal_presence").length, 1);
  assert.equal(h2.timer("FNMA_B2_2_02_LEGAL_PRESENCE_GATE")?.status, "armed"); assert.equal(h2.ofType("legal_presence.established").length, 0);
  assert.equal(h2.escalations("underwriting_reviewer").length, 1);
  // the same evidence with the partner's policy set to accept a USCIS extension receipt (Q5) is legally_present
  const yes = await h2.run("assessLegalPresence", { borrower_id: B, status_declared: "non_permanent_resident", evidence_kind: "ead", evidence_document_id: "doc-ead-B", evidence_expires_on: "2026-11-01", scheduled_note_date: "2026-11-18", renewal_receipt_present: true, policy: { pending_renewal_accepted: true } });
  assert.equal((yes.record as { assessment: string }).assessment, "legally_present");
  await h2.refused(h2.run("assessLegalPresence", { borrower_id: B, status_declared: "non_permanent_resident", scheduled_note_date: "2026-11-18", national_origin: "X" }), "NO_DEMOGRAPHIC_INPUTS");
});

test("22.6-T4: (OFAC rejected transaction) Given a confirmed SDN match on the seller's LLC member on Wed Nov 4, 2026, when `ofac.match.confirmed{rejected}` fires, then `fraud_hold` blocks `issueCD`/`consummate`/`funding.authorized`, 28.4's §501.604 timer computes a due date of Thu Nov 19, 2026 (10 `business_days_federal`, Veterans Day excluded), the record carries `retention_class = ofac_records_10y`, and no borrower notice mentions the screening result.", async () => {
  const hit: OfacCandidate = { list: "ofac_sdn", sdn_name: "MEMBER, Seller LLC", program: "SDGT", date_of_birth: "1971-02-14", nationality: "XX", id_numbers: ["P-7788"], score: 0.96 };
  const h = harness(et("2026-11-04", "10:00"), { ofac: new FakeOfacScreener({ "seller-llc-member": [hit] }) });
  const s = await h.run("screenParty", { party_id: "seller-llc-member", party_role: "seller", name: "Seller LLC member", date_of_birth: "1971-02-14", nationality: "XX", id_numbers: ["P-7788"], lists: SDN_NOV4 });
  assert.equal(s.result, "potential_match"); assert.equal(s.list_version, "SLS-2026-11-04"); assert.equal(h.ofType("ofac.potential_match").length, 1);
  const r = await h.run("resolveOfacMatch", { screening_id: (s.screening as { screening_id: string }).screening_id, disposition: "true_match", action: "rejected", identifiers_compared: [{ identifier: "date_of_birth", party_value: "1971-02-14", sdn_value: "1971-02-14", matches: true }, { identifier: "passport_number", party_value: "P-7788", sdn_value: "P-7788", matches: true }] });
  assert.equal(r.result, "match_true"); assert.equal(r.report_kind, "rejected_transaction"); assert.equal(r.report_due_on, "2026-11-19");
  const confirmed = h.ofType("ofac.match.confirmed")[0]!.payload as { rejected: boolean; disposition: string; retention_class: string; records_retained_until: string };
  assert.equal(confirmed.rejected, true); assert.equal(confirmed.disposition, "rejected"); assert.equal(confirmed.retention_class, "ofac_records_10y"); assert.equal(confirmed.records_retained_until, "2036-11-04");
  assert.equal(h.ofType("ofac.transaction.rejected").length, 1); assert.equal(h.ofType("fraud.hold.placed").length, 1);
  // fraud_hold blocks issueCD / consummate / funding.authorized (and submitDu for new casefiles)
  assert.equal(h.rt.store.get("applications", APP)!.data.fraud_hold, true);
  for (const command of ["issueCD", "consummate", "funding.authorized", "submitDu"]) await h.refused(h.run("placeHold", { op: "check", command }), "FRAUD_HOLD");
  assert.deepEqual([...HOLD_BLOCKED_COMMANDS], ["submitDu", "issueCD", "consummate", "funding.authorized"]);
  // 28.4's §501.604 rejected-transaction clock: 10 business_days_federal from Wed Nov 4 — Nov 5, 6, 9, 10, (Veterans Day Nov 11 excluded), 12, 13, 16, 17, 18, 19 → Thu Nov 19, 2026
  const t = h.timer("OFAC_501_604_REJECTED_REPORT_10BD")!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2026-11-19"); assert.equal(t.anchorDate, "2026-11-04");
  assert.equal(ofacReportDue(D("2026-11-04")), "2026-11-19");
  assert.equal(ofacReportDue(D("2026-11-06")), "2026-11-23");   // R4: the $5,000.00 EMD blocked Fri Nov 6 → §501.603 initial report Mon Nov 23
  assert.equal(ofacRecordsRetainedUntil(D("2026-11-04")), "2036-11-04");
  // the borrower is told only that the transaction cannot proceed — no screening result, no SAR-related content
  const statement = String(r.borrower_statement); assert.doesNotMatch(statement, /OFAC|SDN|sanction|screen|match|SAR|FinCEN/i); assert.equal(scrubSarTerms(statement).clean, true);
  assert.equal(h.escalations("bsa_officer").length, 1); assert.equal(h.escalations("bsa_officer")[0]!.payload.report_due_on, "2026-11-19");
  // the ORS package is prepared for the bsa_officer, never filed by the agent
  const pkg = await h.run("prepareOfacReport", { screening_id: (s.screening as { screening_id: string }).screening_id, kind: "rejected_transaction", event_on: "2026-11-04", package_document_id: "doc-ors-1", content: { filer_identity: "partner", transaction_description: "purchase rejected", parties: ["seller"], blocked_or_rejected_person: "MEMBER", property_description_location_value: "n/a", date: "2026-11-04", actions_taken: "rejected", legal_authority: "31 CFR 501.604" } });
  assert.equal(pkg.due_on, "2026-11-19"); assert.deepEqual(pkg.missing_elements, []); assert.equal(pkg.sent_to, "bsa_officer");
  await h.refused(h.run("prepareOfacReport", { screening_id: "x", kind: "rejected_transaction", event_on: "2026-11-04", package_document_id: "d", file: true }), "NO_SAR_FILING");
  // the OFAC hold is released only by the bsa_officer
  await h.refused(h.run("releaseHold", { rationale: "cleared", hold_reason: "ofac_match_true" }), "OFAC_HOLD_RELEASE_BSA_OFFICER");
  await h.refused(h.run("releaseHold", { rationale: "cleared", bypass_hold: true }, BSA), "NO_HOLD_BYPASS");
  const rel = await h.run("releaseHold", { rationale: "OFAC report filed; transaction cancelled", hold_reason: "ofac_match_true" }, BSA);
  assert.equal(rel.released, true); assert.equal(h.rt.store.get("applications", APP)!.data.fraud_hold, false);
});

test("22.6-T5: (OFAC false positive and list version) Given a potential match on \"Maria Lopez\" with a different DOB and nationality, when resolved, then `false_positive_resolved` with both identifiers recorded; given a new SLS list version is published Wed Nov 4 after the Nov 3 screen, then `OFAC_SDN_SCREEN_GATE` requires a re-screen before the Nov 5 pre-consummation check and again before funding Thu Nov 12 if another version appears.", async () => {
  const lopez: OfacCandidate = { list: "ofac_sdn", sdn_name: "LOPEZ, Maria", program: "SDNTK", date_of_birth: "1965-09-02", nationality: "CO", id_numbers: [], score: 0.88 };
  const h = harness(mst("2026-11-03", "09:00"), { ofac: new FakeOfacScreener({ [A]: [lopez] }) });
  h.upstream("application.received", {}, mst("2026-10-05", "10:41"), { kind: "agent", id: "intake" });
  assert.equal(h.timer("OFAC_SDN_SCREEN_GATE")?.status, "armed");
  const s = await h.run("screenParty", { party_id: A, party_role: "borrower", name: "Maria Lopez", date_of_birth: "1984-03-30", nationality: "US", lists: SDN_NOV3 });
  assert.equal(s.result, "potential_match"); assert.equal(s.list_stale, false); assert.equal(listStale(D("2026-11-03"), D("2026-11-03")), false); assert.equal(listStale(D("2026-10-30"), D("2026-11-03")), true);
  await h.refused(h.run("resolveOfacMatch", { screening_id: (s.screening as { screening_id: string }).screening_id, disposition: "false_positive", identifiers_compared: [{ identifier: "date_of_birth", party_value: "1984-03-30", sdn_value: "1965-09-02", matches: false }] }), "OFAC_RESOLUTION_NEEDS_TWO_IDENTIFIERS");
  const r = await h.run("resolveOfacMatch", { screening_id: (s.screening as { screening_id: string }).screening_id, disposition: "false_positive", memo_document_id: "doc-memo-lopez", identifiers_compared: [{ identifier: "date_of_birth", party_value: "1984-03-30", sdn_value: "1965-09-02", matches: false }, { identifier: "nationality", party_value: "US", sdn_value: "CO", matches: false }] });
  assert.equal(r.result, "match_resolved_false");
  const fp = h.ofType("ofac.false_positive.resolved")[0]!.payload as { result: string; identifiers_compared: { identifier: string }[]; retention_class: string };
  assert.equal(fp.result, "false_positive_resolved"); assert.deepEqual(fp.identifiers_compared.map((c) => c.identifier), ["date_of_birth", "nationality"]); assert.equal(fp.retention_class, "ofac_records_10y");
  assert.equal(h.ofType("fraud.hold.placed").length, 0);
  // the other parties clear on the Nov 3 list → party.screened{all_parties_clear=true} satisfies the gate instance
  const seller = await h.run("screenParty", { party_id: "seller-1", party_role: "seller", name: "Seller One", lists: SDN_NOV3 });
  assert.equal(seller.all_parties_clear, true); assert.equal(h.timer("OFAC_SDN_SCREEN_GATE")?.status, "satisfied");
  assert.equal(evaluateGate("22.6.ofacScreenGate", { party_results: { [A]: "match_resolved_false", "seller-1": "clear" }, last_screen_on: "2026-11-03", last_list_published_on: "2026-11-03", latest_list_published_on: "2026-11-03" }).open, true);
  assert.equal(evaluateGate("22.6.ofacScreenGate", { party_results: { [A]: "match_resolved_false", "seller-1": "clear" }, last_screen_on: "2026-11-03", last_list_published_on: "2026-11-03", latest_list_published_on: "2026-11-03", checkpoint: "pre_consummation", checkpoint_on: "2026-11-06" }).open, false);   // the Nov 3 screen is not the final re-screen ≤ 1 business_days_creditor before the Fri Nov 6 consummation
  assert.equal(evaluateGate("22.6.ofacScreenGate", { party_results: { [A]: "match_resolved_false", "seller-1": "clear" }, last_screen_on: "2026-11-05", last_list_published_on: "2026-11-04", latest_list_published_on: "2026-11-04", checkpoint: "pre_consummation", checkpoint_on: "2026-11-06" }).open, true);
  // Wed Nov 4: a new SLS version → re-screen required before the Nov 5 pre-consummation check (consummation Fri Nov 6)
  const need = await h.run("screenParty", { op: "rescreen_check", checkpoint: "pre_consummation", checkpoint_on: "2026-11-06", last_screen_on: "2026-11-03", last_list_published_on: "2026-11-03", latest_list_published_on: "2026-11-04" });
  assert.equal(need.required, true); assert.match(String(need.reason), /published 2026-11-04 after the 2026-11-03 screen/); assert.equal(need.rescreen_by, "2026-11-05");
  assert.equal(evaluateGate("22.6.ofacScreenGate", { party_results: { [A]: "match_resolved_false", "seller-1": "clear" }, last_screen_on: "2026-11-03", last_list_published_on: "2026-11-03", latest_list_published_on: "2026-11-04", checkpoint: "pre_consummation", checkpoint_on: "2026-11-06" }).open, false);
  h.at(mst("2026-11-05", "09:00"));
  const re = await h.run("screenParty", { party_id: "seller-1", party_role: "seller", name: "Seller One", lists: SDN_NOV4 });
  assert.equal(re.list_version, "SLS-2026-11-04"); assert.equal(re.all_parties_clear, true);
  assert.equal(rescreenRequired({ last_screen_on: D("2026-11-05"), last_list_published_on: D("2026-11-04"), latest_list_published_on: D("2026-11-04"), checkpoint: "pre_consummation", checkpoint_on: D("2026-11-06") }).required, false);
  // another version before funding Thu Nov 12 → again
  const again = rescreenRequired({ last_screen_on: D("2026-11-05"), last_list_published_on: D("2026-11-04"), latest_list_published_on: D("2026-11-10"), checkpoint: "funding", checkpoint_on: D("2026-11-12") });
  assert.equal(again.required, true); assert.equal(again.rescreen_by, "2026-11-10");   // the last business_days_creditor day before Thu Nov 12 (Veterans Day Wed Nov 11 excluded)
  assert.equal(rescreenRequired({ last_screen_on: D("2026-11-05"), last_list_published_on: D("2026-11-04"), latest_list_published_on: D("2026-11-04"), checkpoint: "funding", checkpoint_on: D("2026-11-12") }).required, false);
  // a screen older than 1 business_days_creditor before consummation needs the final re-screen even without a list change (purchase: Tue Nov 17 before Wed Nov 18)
  assert.equal(rescreenRequired({ last_screen_on: D("2026-11-13"), last_list_published_on: D("2026-11-13"), latest_list_published_on: D("2026-11-13"), checkpoint: "pre_consummation", checkpoint_on: D("2026-11-18") }).required, true);
  assert.equal(rescreenRequired({ last_screen_on: D("2026-11-17"), last_list_published_on: D("2026-11-17"), latest_list_published_on: D("2026-11-17"), checkpoint: "pre_consummation", checkpoint_on: D("2026-11-18") }).required, false);
});

test("22.6-T6: (fraud alert contact) Given an initial fraud alert with a phone number on the Oct 5, 2026 report, when the AI-voice contact is completed Tue Oct 6 with the borrower's confirmation, then `FCRA_605A_H_ALERT_CONTACT_GATE` is open before the Oct 7 conditional approval; given an extended alert with \"contact by mail only\", then an AI-voice contact does not satisfy the gate and a mailed confirmation with a returned signed statement does.", async () => {
  const h = harness(mst("2026-10-05", "11:00"));
  // 22.2's detectFraudAlerts: credit.fraud_alert.detected{borrower_id, repository, kind, contact_phone} arms the gate
  h.upstream("credit.fraud_alert.detected", { report_id: "rpt-oct5", borrower_id: A, repository: "tu", kind: "initial", contact_phone: "602-555-0142", contact_required_before: "decision.issued{approval} / submitDu" });
  assert.equal(h.timer("FCRA_605A_H_ALERT_CONTACT_GATE")?.status, "armed");
  assert.equal(evaluateGate("22.6.fraudAlertContactGate", { alerted_borrower_ids: [A], contact_completed_borrower_ids: [] }).open, false);
  h.at(mst("2026-10-06", "10:14"));
  const c = await h.run("contactForFraudAlert", { borrower_id: A, alert_kind: "initial", contact_phone: "602-555-0142", method: "ai_voice", number_called: "602-555-0142", outcome: "confirmed", automation_disclosed: true });
  assert.equal(c.satisfies_gate, true); assert.equal(typeof c.contact_completed_event_id, "string");   // 22.2's detectFraudAlerts op=clear takes this id
  const done = h.ofType("fraud_alert.contact.completed")[0]!; assert.equal(done.id, c.contact_completed_event_id); assert.equal(done.occurredAt, mst("2026-10-06", "10:14"));
  assert.equal(h.timer("FCRA_605A_H_ALERT_CONTACT_GATE")?.status, "satisfied");
  assert.equal(evaluateGate("22.6.fraudAlertContactGate", { alerted_borrower_ids: [A], contact_completed_borrower_ids: [A] }).open, true);   // open before the Oct 7 conditional approval
  assert.equal(unreachableDeadline(D("2026-10-06")), "2026-10-13"); assert.equal(ALERT_CONTACT_WINDOW_BUSINESS_DAYS, 5);   // R5: unreachable through Tue Oct 13 (Columbus Day Oct 12 excluded) → 21.6
  // the wrong number does not satisfy an initial alert; reasonable steps (identity verified + credit-header callback) do
  const initial: FraudAlertFact = { borrower_id: A, kind: "initial", contact_phone: "602-555-0142", designated_method: null, credit_header_phones: ["602-555-0199"] };
  assert.equal(contactSatisfiesGate(initial, { method: "ai_voice", number_called: "602-555-0100", outcome: "confirmed" }).satisfies, false);
  assert.equal(contactSatisfiesGate(initial, { method: "telephone_human", number_called: "602-555-0199", outcome: "confirmed", identity_verified: true }).satisfies, true);
  // extended alert, "contact by mail only": AI voice does not satisfy; a mailed confirmation with the returned signed statement does
  const h2 = harness(mst("2026-10-06", "10:00"));
  h2.upstream("credit.fraud_alert.detected", { report_id: "rpt-oct5", borrower_id: B, repository: "efx", kind: "extended", contact_phone: null, designated_method: "mail" });
  const voice = await h2.run("contactForFraudAlert", { borrower_id: B, alert_kind: "extended", designated_method: "mail", method: "ai_voice", number_called: "602-555-0142", outcome: "confirmed" });
  assert.equal(voice.satisfies_gate, false); assert.match(String(voice.reason), /not the consumer's designated method/); assert.equal(voice.contact_completed_event_id, null);
  assert.equal(h2.ofType("fraud_alert.contact.attempted").length, 1); assert.equal(h2.timer("FCRA_605A_H_ALERT_CONTACT_GATE")?.status, "armed");
  const mailNoStatement = await h2.run("contactForFraudAlert", { borrower_id: B, alert_kind: "extended", designated_method: "mail", method: "mail", outcome: "confirmed", signed_statement_returned: false });
  assert.equal(mailNoStatement.satisfies_gate, false);
  h2.at(mst("2026-10-13", "15:00"));
  const mail = await h2.run("contactForFraudAlert", { borrower_id: B, alert_kind: "extended", designated_method: "mail", method: "mail", outcome: "confirmed", signed_statement_returned: true });
  assert.equal(mail.satisfies_gate, true); assert.equal(mail.attempt_no, 3); assert.equal(h2.timer("FCRA_605A_H_ALERT_CONTACT_GATE")?.status, "satisfied");
  await h2.refused(h2.run("contactForFraudAlert", { borrower_id: B, alert_kind: "initial", method: "ai_voice", outcome: "confirmed", target: "employer" }), "NO_UNDOCUMENTED_THIRD_PARTY_CONTACT");
  await h2.refused(h2.run("contactForFraudAlert", { borrower_id: B, alert_kind: "initial", method: "ai_voice", outcome: "confirmed", automation_disclosed: false }), "AI_DISCLOSURE_AND_TCPA");
});

test("22.6-T7: (address discrepancy) Given a notice of address discrepancy on Borrower A, when the agent matches the application address to the driver's license and a utility statement, then `address_discrepancy.resolved` and the confirmed address is queued for furnishing at boarding (30.4).", async () => {
  const h = harness(mst("2026-10-05", "11:30"));
  // 22.2's credit.identity_mismatch.detected{fields ∋ address} is the CRA's notice of address discrepancy → Red Flags row + address_discrepancy.detected (arms the §1022.82 gate)
  const notice = h.upstream("credit.identity_mismatch.detected", { report_id: "rpt-oct5", borrower_id: A, fields: ["address"] });
  const intake = await h.run("logRedFlag", { op: "intake", event_id: notice.id });
  assert.equal(intake.category, "address_discrepancy"); assert.equal(intake.address_discrepancy, "address_discrepancy.detected");
  assert.equal(h.timer("REGV_1022_82_ADDRESS_DISCREPANCY_GATE")?.status, "armed"); assert.equal(h.timer("RED_FLAGS_681_RESPONSE_1BD")?.status, "armed");
  assert.equal(evaluateGate("22.6.addressDiscrepancyGate", { discrepant_borrower_ids: [A], resolved_borrower_ids: [] }).open, false);
  await h.refused(h.run("resolveAddressDiscrepancy", { borrower_id: A, application_address: "1420 W Camelback Rd, Phoenix, AZ 85015", sources: [{ kind: "drivers_license", address: "77 Other St, Mesa, AZ 85201", document_id: "doc-dl-A" }] }), "ADDRESS_DISCREPANCY_UNRESOLVED");
  const r = await h.run("resolveAddressDiscrepancy", { borrower_id: A, application_address: "1420 W Camelback Rd, Phoenix, AZ 85015", sources: [{ kind: "drivers_license", address: "1420 W Camelback Rd., Phoenix, AZ 85015", document_id: "doc-dl-A" }, { kind: "utility_statement", address: "1420 W CAMELBACK RD, PHOENIX AZ 85015", document_id: "doc-util-A" }] });
  assert.deepEqual(r.matched_sources, ["drivers_license", "utility_statement"]); assert.equal(r.confirmed_address, "1420 W Camelback Rd, Phoenix, AZ 85015");
  const ev = h.ofType("address_discrepancy.resolved")[0]!.payload as { method: string; furnish_at_boarding: boolean; furnish_to: string; confirmed_address: string };
  assert.equal(ev.method, "1022.82(c)(2)"); assert.equal(ev.furnish_at_boarding, true); assert.equal(ev.furnish_to, "cra");
  assert.deepEqual(r.furnishing, { furnish_to: "cra", when: "boarding_30_4", address: "1420 W Camelback Rd, Phoenix, AZ 85015" });
  const queued = h.rt.store.list("furnishing_queue", (d) => d.borrower_id === A); assert.equal(queued.length, 1); assert.equal(queued[0]!.data.when, "boarding_30_4");
  assert.equal(h.timer("REGV_1022_82_ADDRESS_DISCREPANCY_GATE")?.status, "satisfied");
  assert.equal(evaluateGate("22.6.addressDiscrepancyGate", { discrepant_borrower_ids: [A], resolved_borrower_ids: [A] }).open, true);
  // the Red Flags row is answered inside its 1-business-day SLA
  const rf = await h.run("logRedFlag", { op: "respond", event_id: intake.red_flag_event_id, response: "verify_identity", resolution: { method: "1022.82(c)(2)" } });
  assert.equal(rf.within_sla, true); assert.equal(h.timer("RED_FLAGS_681_RESPONSE_1BD")?.status, "satisfied");
});

test("22.6-T8: (occupancy score) Given the purchase-variant signals (rent needed from the retained condo with no lease +3, smaller house +2, DP-3 landlord quote +3), when scored, then 8 → `inconsistent`, `SM_OCCUPANCY_REO_GATE` blocks CTC and an investigation opens; given only the smaller-house signal (+2), then `consistent`.", async () => {
  const variant: OccupancySignals = { distance_subject_employer_km: 3, residence_retained_no_rental_history_rent_needed: true, purchase_smaller_or_cheaper_than_current: true, insurance_landlord_policy: true, other_rentals_owned: 0, rent_free_letter: false, mailing_address_differs_after_closing: false };
  const pure = scoreOccupancy(variant);
  assert.equal(pure.score, OCCUPANCY_WEIGHTS.residence_retained_rent_needed + OCCUPANCY_WEIGHTS.smaller_or_cheaper + OCCUPANCY_WEIGHTS.landlord_policy); assert.equal(pure.score, 8); assert.equal(pure.conclusion, "inconsistent");
  assert.deepEqual(pure.contributions.map((c) => c.points), [3, 2, 3]);
  const h = harness(et("2026-10-26", "10:00"));
  h.upstream("application.received", {}, et("2026-10-19", "09:30"), { kind: "agent", id: "intake" });
  assert.equal(h.timer("SM_OCCUPANCY_REO_GATE")?.status, "armed");
  const r = await h.run("scoreOccupancy", { declared_occupancy: "primary", signals: variant });
  assert.equal(r.score, 8); assert.equal(r.conclusion, "inconsistent"); assert.equal(r.next, "open_investigation"); assert.equal(r.blocks_ctc, true); assert.equal(r.rent_excluded_until_b3_3_8, true);
  assert.equal((r.gate as { open: boolean }).open, false); assert.equal(evaluateGate("22.6.occupancyReoGate", { occupancy_conclusion: "inconsistent", reo_status: "clear" }).open, false);
  assert.equal(typeof r.investigation_id, "string"); assert.equal(h.ofType("investigation.opened").length, 1); assert.deepEqual((h.ofType("investigation.opened")[0]!.payload as { hypotheses: string[] }).hypotheses, ["occupancy_misrepresentation"]);
  assert.equal(h.timer("SM_FRAUD_INVESTIGATION_10BD")?.status, "armed"); assert.equal(h.timer("SM_OCCUPANCY_REO_GATE")?.status, "armed"); assert.equal(h.ofType("occupancy_reo.cleared").length, 0);
  assert.equal((h.ofType("occupancy.assessed")[0]!.payload as { decline_reason_if_unexplained: string }).decline_reason_if_unexplained, DECLINE_REASON_UNVERIFIABLE);   // declined via 21.6, never re-cast as an investment loan
  await h.refused(h.run("scoreOccupancy", { declared_occupancy: "primary", signals: variant, recast_as: "investment" }), "NO_OCCUPANCY_COACHING");
  // only the smaller-house signal (+2) → consistent; the gate clears
  const h2 = harness(et("2026-10-26", "10:00"));
  h2.upstream("application.received", {}, et("2026-10-19", "09:30"), { kind: "agent", id: "intake" });
  const c = await h2.run("scoreOccupancy", { declared_occupancy: "primary", signals: { distance_subject_employer_km: 3, purchase_smaller_or_cheaper_than_current: true } });
  assert.equal(c.score, 2); assert.equal(c.conclusion, "consistent"); assert.equal(c.next, "none"); assert.equal(c.blocks_ctc, false); assert.equal(c.investigation_id, null);
  assert.equal(h2.timer("SM_OCCUPANCY_REO_GATE")?.status, "satisfied"); assert.equal(h2.ofType("investigation.opened").length, 0);
  // refinance fixture: Phoenix primary, employer in Tempe (16 km), HO-3, mailing = subject → 0; a contradiction is inconsistent whatever the score; ≥ 5 needs an explanation
  assert.equal(scoreOccupancy({ distance_subject_employer_km: 16, insurance_landlord_policy: false, mailing_address_differs_after_closing: false }).score, 0);
  assert.equal(scoreOccupancy({ contradiction: "borrower states a different residence on the insurance application" }).conclusion, "inconsistent");
  assert.equal(scoreOccupancy({ distance_subject_employer_km: 140, purchase_smaller_or_cheaper_than_current: true }).conclusion, "needs_explanation");
});

test("22.6-T9: (undisclosed REO) Given a $210,000 mortgage tradeline with no REO entry and a MERS MIN vested in the borrower, when the borrower documents an inherited rental, then `resolved_added_to_reo`, 22.5 adds PITIA $1,640.00, 23.2 recounts financed properties (2), 22.4 adds 2% of the other UPB to reserves, and 23.1 resubmits; given the borrower denies ownership and the deed shows a same-name relative, then `resolved_not_borrower` with the deed as evidence.", async () => {
  const findings = [{ source: "credit_mortgage_tradelines", description: "mortgage tradeline opened 2021, $210,000", upb_cents: 21_000_000n, opened_year: 2021, on_reo_schedule: false }, { source: "mers_lookup", description: "4410 E Main St, Mesa, AZ 85205", min: "100012345678901234", vested_name: "Borrower A", on_reo_schedule: false }, { source: "servicing_book", description: "subject property (SM subserviced)", on_reo_schedule: true }];
  const h = harness(mst("2026-10-20", "09:00"));
  const d = await h.run("discoverReo", { borrower_id: A, findings });
  assert.equal(d.status, "discrepancy_open"); assert.equal(d.undisclosed_count, 2); assert.equal(d.event, "reo.discrepancy.detected");
  const check_id = (d.check as { check_id: string }).check_id;
  await h.refused(h.run("discoverReo", { op: "resolve", check_id, resolution: "added_to_reo", evidence_document_ids: [] }), "REO_RESOLUTION_NEEDS_EVIDENCE");
  // inherited rental documented: PITIA $1,286.00 + $214.00 + $140.00 = $1,640.00 (22.5); financed properties 1 → 2 (23.2); reserves + 2 % × $210,000 = $4,200.00 (22.4); 23.1 resubmits
  const r = await h.run("discoverReo", { op: "resolve", check_id, resolution: "added_to_reo", evidence_document_ids: ["doc-deed-inherit", "doc-mtg-stmt", "doc-lease"], financed_property_count_before: 1, property: { address: "4410 E Main St, Mesa, AZ 85205", upb_cents: 21_000_000n, rental: true, pitia: { pi_cents: 128_600n, taxes_cents: 21_400n, insurance_cents: 14_000n } } });
  assert.equal(r.status, "resolved_added_to_reo"); assert.equal(r.misstatement, "unintentional");
  const hand = r.handoffs as Record<string, Record<string, unknown>>;
  assert.equal(hand["22.5"]!.qualifying_payment_cents, 164_000n); assert.equal(hand["22.5"]!.payment_basis, "mortgage_pitia"); assert.equal(pitiaCents({ pi_cents: 128_600n, taxes_cents: 21_400n, insurance_cents: 14_000n }), 164_000n);
  assert.equal(hand["23.2"]!.financed_property_count, 2);
  assert.equal(hand["22.4"]!.pct_bps, 200); assert.equal(hand["22.4"]!.pct_bps, otherFinancedPctBps(2)); assert.equal(hand["22.4"]!.reserves_add_on_cents, 420_000n); assert.equal(hand["22.4"]!.other_financed_upb_cents, 21_000_000n);
  assert.equal(hand["23.1"]!.du_resubmission_required, true);
  const ev = h.ofType("reo.discrepancy.resolved")[0]!.payload as { pitia_cents: string; financed_property_count: number; reserves_add_on_cents: string; du_resubmission_required: boolean; status: string };
  assert.equal(ev.status, "resolved_added_to_reo"); assert.equal(ev.pitia_cents, "164000"); assert.equal(ev.financed_property_count, 2); assert.equal(ev.reserves_add_on_cents, "420000"); assert.equal(ev.du_resubmission_required, true);
  assert.equal((r.gate as { open: boolean }).open, false);   // the occupancy assessment is still to come on this application; the REO leg is resolved
  assert.equal(evaluateGate("22.6.occupancyReoGate", { occupancy_conclusion: "consistent", reo_status: "resolved_added_to_reo" }).open, true);
  // the borrower denies ownership and the deed shows a same-name relative → resolved_not_borrower with the deed as evidence
  const h2 = harness(mst("2026-10-20", "09:00"));
  const d2 = await h2.run("discoverReo", { borrower_id: A, findings: findings.slice(0, 2) });
  const n = await h2.run("discoverReo", { op: "resolve", check_id: (d2.check as { check_id: string }).check_id, resolution: "not_borrower", evidence_document_ids: ["doc-deed-relative"] });
  assert.equal(n.status, "resolved_not_borrower"); assert.deepEqual((n.check as { evidence_document_ids: string[] }).evidence_document_ids, ["doc-deed-relative"]); assert.equal(n.misstatement, null);
  assert.equal((h2.ofType("reo.discrepancy.resolved")[0]!.payload as { du_resubmission_required: boolean }).du_resubmission_required, false);
  assert.equal(evaluateGate("22.6.occupancyReoGate", { occupancy_conclusion: "consistent", reo_status: "resolved_not_borrower" }).open, true);
  assert.equal(evaluateGate("22.6.occupancyReoGate", { occupancy_conclusion: "consistent", reo_status: "discrepancy_open" }).open, false);
});

test("22.6-T10: (non-arm's-length new construction) Given a borrower employed by the builder buying a newly constructed second home, when assessed, then `eligible = false` (principal residence only) and the loan is declined or restructured only if the true occupancy is primary with evidence; given the parents' existing home with a gift of equity, then eligible, `value_acceptance_blocked = true` (24.1 orders an appraisal) and 22.4 excludes the gift of equity from the IPC test.", async () => {
  const h = harness(et("2026-10-21", "10:00"));
  const no = await h.run("assessNonArmsLength", { relationship_kind: "employer_employee", property_new_construction: true, occupancy: "second_home" });
  assert.equal(no.eligible, false); assert.equal(no.disposition, "decline_via_21_6"); assert.equal(no.value_acceptance_blocked, false);
  assert.match(String((h.ofType("non_arms_length.assessed")[0]!.payload as { rule: string }).rule), /principal residence only/);
  assert.equal(h.timer("FNMA_B2_1_3_01_NON_ARMS_LENGTH_GATE")?.status, "armed"); assert.equal(h.ofType("non_arms_length.eligible").length, 0);
  assert.equal(evaluateGate("22.6.nonArmsLengthGate", { eligible: false }).open, false); assert.equal(h.escalations("underwriting_reviewer").length, 1);
  assert.equal((no.handoffs as Record<string, Record<string, unknown>>)["21.6"]!.reason, DECLINE_REASON_UNVERIFIABLE);
  // restructured only when the true occupancy is primary with evidence — never coached
  const re = await h.run("assessNonArmsLength", { relationship_kind: "employer_employee", property_new_construction: true, occupancy: "second_home", true_occupancy_primary_evidence: true });
  assert.equal(re.eligible, false); assert.equal(re.disposition, "restructure_with_primary_evidence");
  await h.refused(h.run("assessNonArmsLength", { relationship_kind: "employer_employee", property_new_construction: true, occupancy: "second_home", suggest_occupancy_change: true }), "NO_OCCUPANCY_COACHING");
  const primary = await h.run("assessNonArmsLength", { relationship_kind: "builder_relationship", property_new_construction: true, occupancy: "primary" });
  assert.equal(primary.eligible, true);
  // the parents' existing house at $457,800.00 with a $30,000.00 gift of equity → eligible; value acceptance blocked (24.1 orders an appraisal); 22.4's IPC test excludes the gift of equity (B3-4.3-05)
  const h2 = harness(et("2026-10-21", "10:00"));
  const yes = await h2.run("assessNonArmsLength", { relationship_kind: "family", property_new_construction: false, occupancy: "primary", gift_of_equity_cents: 3_000_000n, purchase_price_cents: 45_780_000n });
  assert.equal(yes.eligible, true); assert.equal(yes.value_acceptance_blocked, true); assert.equal(yes.disposition, "proceed");
  const hand = yes.handoffs as Record<string, Record<string, unknown>>;
  assert.deepEqual(hand["24.1"], { order_appraisal: true, value_acceptance_blocked: true }); assert.equal(hand["22.4"]!.ipc_test_excludes_gift_of_equity_cents, 3_000_000n);
  assert.ok((yes.assessment as { documentation_required: string[] }).documentation_required.includes("traditional appraisal (value acceptance ineligible — B4-1.4-10)"));
  assert.equal(h2.timer("FNMA_B2_1_3_01_NON_ARMS_LENGTH_GATE")?.status, "satisfied"); assert.equal(evaluateGate("22.6.nonArmsLengthGate", { eligible: true }).open, true);
  assert.equal((h2.ofType("non_arms_length.assessed")[0]!.payload as { gift_of_equity_cents: string }).gift_of_equity_cents, "3000000");
});

test("22.6-T11: (investigation → SAR anchors) Given an altered paystub confirmed Thu Oct 22, 2026 and the investigation concluded Fri Oct 30 with a reasonable basis for misrepresentation, when `sar.candidate.prepared` is sent to the `bsa_officer` by Fri Nov 6 (`SM_SAR_PACKAGE_5BD`), then 28.4's `BSA_1029_320_SAR_30` is due Sun Nov 29, 2026 and `FNMA_A3_4_03_FRAUD_SELF_REPORT_30` Nov 29; given no subject can be identified, then the outer limit is Tue Dec 29, 2026; the borrower-facing decline names \"information provided cannot be verified\" and contains no SAR reference.", async () => {
  const h = harness(mst("2026-10-22", "10:00"));
  // Thu Oct 22: 22.1 confirms the altered paystub (document.integrity.failed{fraud_case_candidate}) → Red Flags row + investigation candidate
  const failed = h.upstream("document.integrity.failed", { document_id: "doc-paystub-1", doc_class: "paystub", integrity_status: "failed", checks: [{ check_type: "font_kerning", result: "fail" }, { check_type: "fica_arithmetic", result: "fail" }], escalation_role: "underwriting_reviewer", severity: "sev-2", fraud_case_candidate: true, hand_off: "22.6" });
  const intake = await h.run("logRedFlag", { op: "intake", event_id: failed.id }); assert.equal(intake.investigation_candidate, true); assert.equal(intake.category, "suspicious_document");
  const opened = await h.run("openInvestigation", { triggers: [String(intake.red_flag_event_id), "doc-paystub-1"], hypotheses: ["income_fabrication"] });
  assert.equal(opened.due_on, "2026-11-05"); assert.equal(investigationDue(D("2026-10-22")), "2026-11-05");
  const inv = h.timer("SM_FRAUD_INVESTIGATION_10BD")!; assert.equal(inv.status, "armed"); assert.equal(inv.dueDate, "2026-11-05"); assert.equal(inv.anchorDate, "2026-10-22");
  assert.equal(h.rt.store.get("applications", APP)!.data.fraud_hold, true); await h.refused(h.run("placeHold", { op: "check", command: "issueCD" }), "FRAUD_HOLD");   // O3-IT3: the hold blocked issueCD
  assert.equal(h.rt.store.get("cases", String(opened.case_id))!.data.case_type, "fraud");
  await h.refused(h.run("gatherEvidence", { investigation_id: opened.investigation_id, evidence_document_ids: ["x"], channel: "third_party_direct" }), "NO_UNDOCUMENTED_THIRD_PARTY_CONTACT");
  h.at(mst("2026-10-28", "15:00"));
  await h.run("gatherEvidence", { investigation_id: opened.investigation_id, evidence_document_ids: ["doc-voe-written", "doc-borrower-admission"], channel: "documented_verification_channel", hypothesis_updates: [{ hypothesis: "income_fabrication", status: "supported", note: "employer's written VOE shows income 40% lower; borrower admits editing the document" }] });
  // Fri Oct 30: concluded with a reasonable basis for misrepresentation → sar_detection_date = Oct 30 (the "initial detection"); the hand-off arms 28.4's clocks
  h.at(mst("2026-10-30", "11:00"));
  const c = await h.run("concludeInvestigation", { investigation_id: opened.investigation_id, conclusion: "reasonable_basis_misrepresentation", subject_identified: true, amount_cents: 56_000_000n, sar_category: "facilitate_criminal_activity", loan_disposition: "decline_via_o2_6", rationale: "employer VOE contradicts the paystub; borrower admitted the alteration" });
  assert.equal(c.sar_candidate, true); assert.equal(c.sar_detection_date, "2026-10-30"); assert.equal(c.fnma_self_report_candidate, true);
  const dl = c.deadlines as { package_due_on: string; sar: { filing_due_on: string; outer_limit_on: string; policy_file_by: string }; self_report_due_on: string };
  assert.equal(dl.package_due_on, "2026-11-06"); assert.equal(dl.sar.filing_due_on, "2026-11-29"); assert.equal(dl.sar.policy_file_by, "2026-11-27"); assert.equal(dl.self_report_due_on, "2026-11-29");   // filed by Fri Nov 27 policy (Thanksgiving Nov 26)
  assert.equal(h.timer("SM_FRAUD_INVESTIGATION_10BD")?.status, "satisfied");
  const pkg = h.timer("SM_SAR_PACKAGE_5BD")!; assert.equal(pkg.status, "armed"); assert.equal(pkg.dueDate, "2026-11-06"); assert.equal(pkg.anchorDate, "2026-10-30");
  const sar = h.timer("BSA_1029_320_SAR_30")!; assert.equal(sar.status, "armed"); assert.equal(sar.dueDate, "2026-11-29"); assert.equal(sar.anchorDate, "2026-10-30");
  const self = h.timer("FNMA_A3_4_03_FRAUD_SELF_REPORT_30")!; assert.equal(self.status, "armed"); assert.equal(self.dueDate, "2026-11-29");
  assert.equal((h.ofType("fraud.suspicious.determined")[0]!.payload as { initial_detection_at: string }).initial_detection_at, "2026-10-30");
  assert.equal((h.ofType("fnma.fraud.reasonable_basis")[0]!.payload as { reasonable_basis_at: string }).reasonable_basis_at, "2026-10-30");
  assert.equal(h.escalations("underwriting_reviewer").length, 1); assert.equal(h.escalations("bsa_officer").length, 1);
  // the borrower-facing decline names "information provided cannot be verified" and carries no SAR reference (R11)
  assert.deepEqual(c.decline_reasons, [DECLINE_REASON_UNVERIFIABLE, "income cannot be verified"]);
  for (const reason of c.decline_reasons as string[]) { assert.equal(scrubSarTerms(reason).clean, true); assert.doesNotThrow(() => assertNoSarTerms(reason)); }
  assert.equal(scrubSarTerms(JSON.stringify(h.ofType("investigation.concluded")[0]!.payload.decline_reasons)).clean, true);
  // Thu Nov 5: the package goes to the bsa_officer inside SM_SAR_PACKAGE_5BD; the agent never files
  h.at(mst("2026-11-05", "16:00"));
  await h.refused(h.run("prepareSarPackage", { investigation_id: opened.investigation_id, narrative_draft_document_id: "doc-sar-narrative", file: true }), "NO_SAR_FILING");
  await h.refused(h.run("prepareSarPackage", { investigation_id: opened.investigation_id, narrative_draft_document_id: "doc-sar-narrative", share_with_role: "mlo_of_record" }), "NO_SAR_DISCLOSURE");
  const p = await h.run("prepareSarPackage", { investigation_id: opened.investigation_id, narrative_draft_document_id: "doc-sar-narrative", exhibit_document_ids: ["doc-paystub-1", "doc-voe-written"] });
  assert.equal(p.on_time, true); assert.equal(p.filing_due_on, "2026-11-29"); assert.equal(p.outer_limit_on, "2026-12-29"); assert.equal(p.sent_to, "bsa_officer");
  assert.equal(h.timer("SM_SAR_PACKAGE_5BD")?.status, "satisfied"); assert.equal(h.timer("BSA_1029_320_SAR_30")?.status, "armed");   // 28.4's clock keeps running until the officer's sar.filed
  assert.deepEqual((p.candidate as { access_roles: string[] }).access_roles, ["bsa_officer", "officer", "qc_officer"]); assert.equal((p.candidate as { retention_class: string }).retention_class, "bsa_sar_5y");
  assert.equal(h.escalations("bsa_officer").length, 2);
  const sr = await h.run("prepareSelfReportPackage", { investigation_id: opened.investigation_id, package_document_id: "doc-lqc-pkg", content: { loan_identifiers: "app-22-6", parties: ["borrower"], scheme_description: "altered paystub", timeline: "Oct 22–30", evidence: ["doc-paystub-1"], exposure_cents: "56000000", actions_taken: "declined", law_enforcement_status: "not_referred", contact_person: "bsa_officer" } });
  assert.equal(sr.due_on, "2026-11-29"); assert.deepEqual(sr.missing_elements, []); assert.equal(sr.sent_to, "officer");
  // no subject identifiable → the delay may extend to Tue Dec 29, 2026 (60 days) but "in no case" beyond
  const noSubject = sarDeadlines(D("2026-10-30"), false); assert.equal(noSubject.filing_due_on, "2026-12-29"); assert.equal(noSubject.outer_limit_on, "2026-12-29"); assert.equal(sarDeadlines(D("2026-10-30"), true).filing_due_on, "2026-11-29");
  assert.equal(selfReportDue(D("2026-10-30")), "2026-11-29");
  // the hold releases only on the concluded investigation; 28.4's officer-executed sar.filed closes the loop (never emitted by the agent)
  const filed = h.events.append({ type: "sar.filed", applicationId: APP, actor: BSA, occurredAt: mst("2026-11-20", "10:00"), payload: { application_id: APP, candidate_id: p.candidate_id, bsa_identifier: "31000000000001" } });
  const rel = await h.run("releaseHold", { rationale: "investigation concluded; decline issued through 21.6", investigation_id: opened.investigation_id, return_event_id: filed.id });
  assert.equal(rel.released, true); assert.equal(rel.investigation_status, "closed"); assert.equal(h.timer("BSA_1029_320_SAR_30")?.status, "satisfied");
});

test("22.6-T12: (Red Flags SLA and program log) Given a suspicious-document red flag detected Fri Oct 23, 2026 16:30 MST, when no response is recorded by Mon Oct 26 end of day, then `RED_FLAGS_681_RESPONSE_1BD` breaches (sev 3) and the event appears in the annual ITPP report with its response time.", async () => {
  const detected = mst("2026-10-23", "16:30");
  const h = harness(detected);
  const r = await h.run("logRedFlag", { red_flag_code: "RF_DOC_ALTERED_ID", detected_at: detected, detected_by: "agent:document-intake", detail: { document_id: "doc-id-A" } });
  assert.equal(r.response_due_on, "2026-10-26"); assert.equal(redFlagResponseDue(detected), "2026-10-26"); assert.equal((r.row as { category: string }).category, "suspicious_document");
  const t = h.timer("RED_FLAGS_681_RESPONSE_1BD")!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-23"); assert.equal(t.dueDate, "2026-10-26");
  // Mon Oct 26 during the day: still armed; after end of day (23:59 ET) with no response: breached at sev 3
  assert.equal(h.timers.evaluate(et("2026-10-26", "17:00")).filter((b) => b.instance.code === "RED_FLAGS_681_RESPONSE_1BD").length, 0);
  const breaches = h.timers.evaluate(et("2026-10-27", "00:30")).filter((b) => b.instance.code === "RED_FLAGS_681_RESPONSE_1BD");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.severity, 3); assert.equal(t.status, "breached");
  assert.equal(h.ofType("timer.breached").filter((e) => (e.payload as { code: string }).code === "RED_FLAGS_681_RESPONSE_1BD").length, 1);
  // the late response is recorded with its response time and shows in the annual ITPP report as a breach
  h.at(mst("2026-10-27", "09:00"));
  const resp = await h.run("logRedFlag", { op: "respond", event_id: r.event_id, response: "verify_identity", resolution: { method: "supervised remote session ordered" } });
  assert.equal(resp.within_sla, false); assert.equal(resp.response_hours, 88.5); assert.equal(h.timer("RED_FLAGS_681_RESPONSE_1BD")?.status, "satisfied_late");
  const report = await h.run("logRedFlag", { op: "report", from: "2026-01-01", to: "2026-12-31" });
  const events = report.events as { event_id: string; category: string; response_hours: number; sla_breached: boolean; response: string }[];
  assert.equal(events.length, 1); assert.equal(events[0]!.event_id, r.event_id); assert.equal(events[0]!.category, "suspicious_document"); assert.equal(events[0]!.response_hours, 88.5); assert.equal(events[0]!.sla_breached, true); assert.equal(events[0]!.response, "verify_identity");
  assert.equal(report.breaches, 1); assert.deepEqual(report.by_category, { suspicious_document: 1 });
  // a flag answered the next business day is inside the SLA
  const h2 = harness(mst("2026-10-23", "16:30"));
  const r2 = await h2.run("logRedFlag", { red_flag_code: "RF_PII_SSN_SHARED", detected_at: mst("2026-10-23", "16:30"), detected_by: "agent:fraud-risk" });
  h2.at(mst("2026-10-26", "14:00")); const ok = await h2.run("logRedFlag", { op: "respond", event_id: r2.event_id, response: "escalate" });
  assert.equal(ok.within_sla, true); assert.equal(h2.timer("RED_FLAGS_681_RESPONSE_1BD")?.status, "satisfied");
});

test("22.6-T13: (guardrails) Given an adverse-action draft generated after a fraud investigation, when scanned, then any reference to \"SAR\"/\"FinCEN\" is rejected before 21.6 renders the notice; given a request to use `applicant_demographics` fields in the occupancy model, then the tool call is refused and logged.", async () => {
  const h = harness(mst("2026-11-02", "10:00"));
  const draft = "Your application was declined because a SAR was filed with FinCEN after our review.";
  const e1 = await h.refused(h.run("writeDecision", { op: "scan_borrower_text", text: draft }), "SAR_CONFIDENTIALITY");
  assert.match(e1.message, /SAR/); assert.match(e1.citation, /1029\.320\(d\)/);
  assert.deepEqual(scrubSarTerms(draft).findings, ["SAR", "FinCEN"]);
  assert.throws(() => assertNoSarTerms("We could not verify the information provided (suspicious activity report pending)."), (e: unknown) => e instanceof ScreeningRefused && e.code === "SAR_CONFIDENTIALITY");
  const clean = await h.run("writeDecision", { op: "scan_borrower_text", text: `Your application was declined: ${DECLINE_REASON_UNVERIFIABLE}.` });
  assert.equal(clean.clean, true);
  await h.refused(h.run("writeDecision", { action: "decline_recommendation", rationale: "x", borrower_message: "A suspicious activity report was filed." }), "NO_SAR_DISCLOSURE");
  // applicant_demographics fields in the occupancy model → refused and logged (command.refused)
  const before = h.events.ofType("command.refused").length;
  const e2 = await h.refused(h.run("scoreOccupancy", { declared_occupancy: "primary", signals: { purchase_smaller_or_cheaper_than_current: true, "applicant_demographics.ethnicity": "hispanic_or_latino" } }), "NO_DEMOGRAPHIC_INPUTS");
  assert.match(e2.citation, /1002\.6\(b\)/);
  const logged = h.events.ofType("command.refused").slice(before); assert.equal(logged.length, 1);
  assert.equal((logged[0]!.payload as { command: string; code: string }).command, "scoreOccupancy"); assert.equal((logged[0]!.payload as { code: string }).code, "NO_DEMOGRAPHIC_INPUTS");
  assert.equal(h.ofType("occupancy.assessed").length, 0);
  await h.refused(h.run("scoreOccupancy", { declared_occupancy: "primary", signals: { purchase_smaller_or_cheaper_than_current: true }, use_applicant_demographics: true }), "NO_DEMOGRAPHIC_INPUTS");
  await h.refused(h.run("runFraudTool", { application_data: { race: "x" } }), "NO_DEMOGRAPHIC_INPUTS");
  assert.throws(() => scoreOccupancy({ national_origin: "x" } as OccupancySignals), (e: unknown) => e instanceof ScreeningRefused && e.code === "NO_DEMOGRAPHIC_INPUTS");
  assert.throws(() => assertNoDemographicInputs(["language_preference"]), ScreeningRefused);
  assert.throws(() => decisionRecord({ application_id: APP, subject: { kind: "application", id: APP }, screening_results: { race: "x" }, identity_scores: {}, ssn_resolution_path: null, occupancy: null, reo_findings: null, non_arms_length: null, red_flags: null, investigation: null, sar_candidate_rationale: null, model_version: "m1", prompt_version: "p1", rationale: "r", confidence: 0.9 }), ScreeningRefused);
  // the decision record the agent writes carries the versions and the §1002.6(b)(7) rationale
  const rec = decisionRecord({ application_id: APP, subject: { kind: "application", id: APP }, screening_results: { ofac: "clear" }, identity_scores: { [A]: 0.97 }, ssn_resolution_path: "documentary", occupancy: { signals: {}, score: 0 }, reo_findings: null, non_arms_length: null, red_flags: null, investigation: null, sar_candidate_rationale: null, model_version: "fraud-risk-2026.09", prompt_version: "p-22.6-3", rationale: "screening clear", confidence: 0.95 });
  assert.equal(rec.rule_set_version, "22.6/2026-09-10"); assert.match(rec.legal_presence_rationale, /rights and remedies/);
  const wd = await h.run("writeDecision", { action: "screening_clear", rationale: "all gates open", model_version: "fraud-risk-2026.09", prompt_version: "p-22.6-3", confidence: 0.95, screening_results: { ofac: "clear" } });
  assert.equal(wd.recorded, true); assert.equal(h.decisions.filter((d) => d.action === "screening_clear" && d.ruleSetVersion === "22.6/2026-09-10").length, 1);
});

test("22.6 worked figures: CBSV $2.25 per request ($5,000 enrollment); undisclosed REO PITIA $1,640.00 on the $210,000 tradeline → 2% reserves $4,200.00; SAR threshold $5,000; the $5,000.00 EMD blocked Fri Nov 6 → §501.603 report Mon Nov 23; rejected Wed Nov 4 → §501.604 Thu Nov 19; parents' house $457,800.00 with a $30,000.00 gift of equity; $1,800/month rent excluded; SAR Sun Nov 29 / Tue Dec 29", async () => {
  // R2: "$2.25 per verification request", "$5,000" enrollment — the fee is charged once per CBSV request on the SSN record
  assert.equal(CBSV_FEE_CENTS, 225n); assert.equal(CBSV_ENROLLMENT_CENTS, 500_000n);
  const h = harness(et("2026-10-20", "11:00"), { cbsv: new FakeCbsv({ [B]: { match: true, death_indicator: false } }) });
  await h.run("resolveSsn", { op: "detect", borrower_id: B, indicator: "du_ssn_message" });
  const v = await h.run("orderCbsv", { borrower_id: B, ssa_89_document_id: "doc-ssa89-B" });
  assert.equal(v.fee_cents, 225n); assert.equal((h.ofType("ssn.validated")[0]!.payload as { fee_cents: string }).fee_cents, "225");
  assert.equal(CBSV_FEE_CENTS * 10n, 2_250n);   // CBSV online: ≤ 10 per submission → $22.50
  // R8: PITIA $1,640.00 = P&I $1,286.00 + taxes $214.00 + insurance $140.00; 2 % of the $210,000 UPB = $4,200.00 (B3-4.1-01, one to four financed properties)
  assert.equal(pitiaCents({ pi_cents: 128_600n, taxes_cents: 21_400n, insurance_cents: 14_000n }), 164_000n);
  assert.equal(pitiaCents({ pi_cents: 120_000n, taxes_cents: 26_200n, insurance_cents: 11_800n, hoa_cents: 6_000n }), 164_000n);
  assert.equal((21_000_000n * BigInt(otherFinancedPctBps(2))) / 10_000n, 420_000n);
  // R10: the SAR is required when ≥ $5,000 and a category applies
  assert.equal(SAR_THRESHOLD_CENTS, 500_000n);
  // R4: the $5,000.00 EMD already held by the settlement agent blocked Fri Nov 6 → §501.603 initial report Mon Nov 23, 2026; the rejected purchase Wed Nov 4 → §501.604 report Thu Nov 19, 2026 (Veterans Day excluded)
  const emd = 500_000n; assert.equal(emd, 5_000n * 100n);
  assert.equal(ofacReportDue(D("2026-11-06")), "2026-11-23"); assert.equal(ofacReportDue(D("2026-11-04")), "2026-11-19");
  // R9: $457,800.00 purchase with a $30,000.00 gift of equity — eligible, value acceptance blocked, gift excluded from the IPC test
  const h2 = harness(et("2026-10-21", "10:00"));
  const nal = await h2.run("assessNonArmsLength", { relationship_kind: "family", property_new_construction: false, occupancy: "primary", gift_of_equity_cents: 3_000_000n, purchase_price_cents: 45_780_000n });
  assert.equal((nal.handoffs as Record<string, Record<string, unknown>>)["22.4"]!.ipc_test_excludes_gift_of_equity_cents, 3_000_000n); assert.equal((nal.assessment as { gift_of_equity_cents: bigint }).gift_of_equity_cents, 3_000_000n);
  assert.equal(45_780_000n - 3_000_000n, 42_780_000n);
  // R7: the $1,800/month rent from the retained condo is excluded until B3-3.8 evidence exists
  const rent = 180_000n; const occ = scoreOccupancy({ residence_retained_no_rental_history_rent_needed: true, purchase_smaller_or_cheaper_than_current: true, insurance_landlord_policy: true }); assert.equal(occ.score, 8); assert.equal(rent, 1_800n * 100n);
  // R10: Oct 30 detection → SAR Sun Nov 29, 2026 (policy Fri Nov 27; Thanksgiving Nov 26); no subject → Tue Dec 29, 2026
  assert.deepEqual(sarDeadlines(D("2026-10-30"), true), { filing_due_on: "2026-11-29", outer_limit_on: "2026-12-29", policy_file_by: "2026-11-27" });
  assert.equal(sarDeadlines(D("2026-10-30"), false).filing_due_on, "2026-12-29");
  // the identity vendor and fraud-tool fakes drive the same store the bus reads
  const fraud = new FakeFraudTool([{ alert_id: "AL-1", category: "identity", severity: "high", description: "SSN issued 2019 for a DOB of 1988" }]);
  const h3 = harness(et("2026-10-19", "12:00"), { fraud });
  h3.upstream("application.received", {}, et("2026-10-19", "09:30"), { kind: "agent", id: "intake" });
  const run = await h3.run("runFraudTool", { parties: [{ party_id: A, party_role: "borrower", name: "Borrower A" }], scheduled_consummation_date: "2026-11-18" });
  assert.equal(run.high_open, 1); assert.equal(h3.timer("SM_FRAUD_TOOL_CLEAR_GATE")?.status, "armed"); assert.equal(evaluateGate("22.6.fraudToolClearGate", { report_id: run.report_id, high_open: 1 }).open, false);
  await h3.refused(h3.run("runFraudTool", { op: "disposition", report_id: run.report_id, alert_id: "AL-1", disposition: "cleared_with_evidence", rationale: "CBSV match", evidence_document_ids: [] }), "HIGH_ALERT_NEEDS_EVIDENCE");
  const disp = await h3.run("runFraudTool", { op: "disposition", report_id: run.report_id, alert_id: "AL-1", disposition: "cleared_with_evidence", rationale: "CBSV match with no death indicator", evidence_document_ids: ["doc-cbsv-B"] });
  assert.equal(disp.high_open, 0); assert.equal(h3.timer("SM_FRAUD_TOOL_CLEAR_GATE")?.status, "satisfied");
  assert.equal(evaluateGate("22.6.fraudToolClearGate", { report_id: run.report_id, high_open: 0, run_on: "2026-10-19", scheduled_consummation_date: "2026-11-18" }).open, false);   // refresh ≤ 10 business_days_creditor before consummation: Nov 4 or later
  assert.equal(evaluateGate("22.6.fraudToolClearGate", { report_id: run.report_id, high_open: 0, run_on: "2026-11-04", scheduled_consummation_date: "2026-11-18" }).open, true);
  const s: IdentitySessionResult = identityPass("S-1"); assert.equal(classifyIdentityResult(s, D("2026-10-19"), D("2026-11-18")).outcome, "verified");
});
