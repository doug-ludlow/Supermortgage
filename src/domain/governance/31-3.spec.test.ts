// 31.3 Records, retention, privacy, data ownership, and security for origination
// spec/sections/31-cross-cutting-licensing-and-approvals-ai-governance-and-fair/31-3-records-retention-privacy-data-ownership-and-security-for-or.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, dayOfWeek, addDays } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import type { CommandContext } from "../../app/commands.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { anniversary, nextDisposalRun } from "../data-security/retention.ts";
import { TOOLS_31_3 } from "../../app/tools/section31-3.ts";
import { EVALUATORS_31_3 } from "./evaluators-31-3.ts";
import {
  REFI_FIXTURE_FACTS, DENIED_FIXTURE_FACTS, fileClocks, firstDisposalRunOnOrAfter, originationObjectEligibility, assertOriginationGatesOpen, origClassGate, classifyOriginationRecord,
  enrollRecord, anchorObjects, anchorFromEvent, sweepOrigination, planUnfundedPurgeRun, attestUnfundedPurgeRun, executeUnfundedPurgeRun, originationScheduleTicks, emitOriginationScheduleTicks,
  recordEcoaAllegation, recordInvestigationClosed, releaseOriginationHold, checkVendorOrder, vendorFlowdownRequirement, glbaServiceProviderGate, GLBA_USE_LIMIT_CLAUSE,
  logPiiAccess, dispositionPiiAnomaly, completePiiAccessReview, ciRestrictedTableCheck, ciDataUseCheck, scanFannieDataUse, scopeOriginationIncident, stateConsumerNoticeClock,
  ronRecordingAccess, ronAccessTest, fnmaOriginationFileRequest, compileOriginationFile, privacyRequest, operatorPath, originationGuards, recordLoCompPaid, recordAfbaExecuted,
  ORIG_RETENTION_CLASSES, RON_RETENTION, type OrigRecordObject, type OrigObjectFacts, type OrigContext, type ClauseStatus,
} from "./ops-31-3.ts";

const ET = "America/New_York";
const AGENT: Actor = { kind: "agent", id: "security-records" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const ATTORNEY: Actor = { kind: "human", id: "u-attorney", role: "attorney" };
const OPERATOR: Actor = { kind: "human", id: "u-ops", role: "ops_analyst" };
const at = (date: string, hhmm: string) => toIso(zonedEpochMs(D(date), hhmm, ET));
const tool = (name: string) => TOOLS_31_3.find((t) => t.name === name)!;
const guard = (name: string, code: string) => tool(name).guardrails!.find((g) => g.code === code)!;

/** The platform pieces a 31.3 command runs against: the event spine, the overridden timer registry (31.3 + the 19.x rows it reuses), the escalation queue, the entity store. */
function harness(nowIso: string, processes: string[] = ["31.3", "19.1", "19.2"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes });
  const escalations = new EscalationService(events, clock);
  const ctx = (actor: Actor = AGENT): OrigContext => ({ events, actor, now: clock.now(), escalations });
  const rt: ToolRuntime = { store: new EntityStore(), ports: {}, escalations, services: {} };
  const commandCtx = (actor: Actor = AGENT): CommandContext => ({ loanId: "", events, ledger: new MemoryLedger(), timers: engine, clock, decide: () => {}, actor, now: clock.now() });
  const run = (name: string, input: ToolInput, actor: Actor = AGENT) => tool(name).handler(input, commandCtx(actor), rt) as Record<string, unknown>;
  const timer = (code: string) => engine.byCode(code).at(-1);
  const types = () => events.all().map((e) => e.type);
  return { clock, events, engine, escalations, ctx, rt, commandCtx, run, timer, types };
}
const sha = "a".repeat(64);
/** The application file's objects (worked example 2's list: 1003, credit report, verifications, notices, reasons, decision record) plus the LAR row and the OFAC screening log. */
function enrollFile(ctx: OrigContext, applicationId: string, facts: OrigObjectFacts, state: string, extra: string[] = []): OrigRecordObject[] {
  const types = ["urla_1003", "credit_report", "verification_report", "adverse_action_notice", "statement_of_reasons", "agent_decision", "hmda_lar_row", "ofac_screen", ...extra];
  return types.map((t, k) => enrollRecord({ id: `${applicationId}-${t}-${k}`, record_type: t, application_id: applicationId, state, sha256: sha, facts }, ctx).object);
}
const AMC_CLAUSES = (): Record<string, ClauseStatus> => Object.fromEntries(vendorFlowdownRequirement("amc_appraiser").required_clause_codes.map((c) => [c, "present" as const]));

test("31.3-T1: Given the refinance fixture (LE required Oct 8, 2026; consummation Nov 6, 2026; LO comp paid Dec 15, 2026; AfBA executed Oct 5, 2026; LAR submitted Feb 15, 2027), then the gates read `regz_le_3y` = 2029-11-06, `regz_cd_5y` = 2031-11-06, `regz_atr_3y` = 2029-11-06, `regz_locomp_3y` = 2029-12-15, `respa_afba_5y` = 2031-10-05, `hmda_3y` = 2030-02-15, `ofac_10y` = 2036-10-05, and the effective class is `fnma_loan_file_life_plus_4y` (`permanent_while_active`).", () => {
  const h = harness(at("2027-03-01", "09:00"));
  const APP = "APP-REFI-AZ";
  // the anchors arrive as platform events and `records.anchor` reads each into the file's facts
  let objects = enrollFile(h.ctx(), APP, { funded: false, state: "AZ" }, "AZ", ["lo_comp_record", "afba_disclosure", "loan_estimate", "closing_disclosure", "atr_evidence"]);
  const anchor = (type: string, date: string, payload: Record<string, unknown>) => { const e = h.events.append({ type, applicationId: APP, aggregate: { kind: "application", id: APP }, actor: AGENT, occurredAt: at(date, "12:00"), payload: { application_id: APP, ...payload } }); const r = anchorObjects(objects, e, h.ctx()); objects = r.objects; return r; };
  anchor("disclosure.le.delivered", "2026-10-07", { le_version: 1, disclosure_required_at: "2026-10-08" });
  anchor("party.screened", "2026-10-05", { party_id: "P1", role: "borrower", result: "clear", screened_on: "2026-10-05" });
  recordAfbaExecuted({ application_id: APP, executed_on: D("2026-10-05"), record_id: `${APP}-afba`, sha256: sha, provider: "affiliate title" }, h.ctx());
  anchor("afba.executed", "2026-10-05", { executed_on: "2026-10-05" });
  const cd = anchor("closing.consummated", "2026-11-06", { consummation_date: "2026-11-06", closing_type: "ron", note_form: "enote" });
  assert.ok(cd.events.some((e) => e.type === "record.anchored" && e.payload.class === "regz_cd_5y" && e.payload.anchor_at === "2026-11-06"));
  anchor("loan.funded", "2026-11-12", { consummation_date: "2026-11-06", regb_action_notified_at: "2026-11-06" });
  anchor("lo_comp.paid", "2026-12-15", { paid_on: "2026-12-15" });
  anchor("hmda.lar.accepted", "2027-02-15", { signed_at: at("2027-02-15", "15:00"), year: 2026 });
  const file = objects.find((o) => o.record_type === "urla_1003")!;
  assert.equal(file.facts.consummation_date, "2026-11-06"); assert.equal(file.facts.disclosure_required_at, "2026-10-08"); assert.equal(file.facts.lo_comp_paid_on, "2026-12-15"); assert.equal(file.facts.lar_signed_on, "2027-02-15"); assert.equal(file.facts.funded, true);
  // the gates read from the anchored facts (rule 2, worked example 1)
  const clocks = fileClocks(file.facts, D("2027-03-01"));
  assert.equal(clocks.clocks.regz_le_3y, "2029-11-06");      // later of Nov 6, 2026 / Oct 8, 2026 + 3 years
  assert.equal(clocks.clocks.regz_cd_5y, "2031-11-06");
  assert.equal(clocks.clocks.regz_atr_3y, "2029-11-06");
  assert.equal(clocks.clocks.regz_locomp_3y, "2029-12-15");
  assert.equal(clocks.clocks.respa_afba_5y, "2031-10-05");
  assert.equal(clocks.clocks.hmda_3y, "2030-02-15");
  assert.equal(clocks.clocks.ofac_10y, "2036-10-05");
  assert.equal(clocks.clocks.regb_25m, "2028-12-06");        // approval notified at consummation (Nov 6, 2026 + 25 months)
  assert.equal(clocks.effective_class, "fnma_loan_file_life_plus_4y");
  assert.equal(clocks.status, "active"); assert.equal(clocks.eligible_for_disposal_at, null);
  const e = originationObjectEligibility("urla_1003", { ...file.facts, today: D("2032-01-01"), hold_count: 0 });
  assert.equal(e.gates.find((g) => g.class_code === "fnma_loan_file_life_plus_4y")!.reason, "permanent_while_active");
  assert.ok(e.gates.filter((g) => g.class_code !== "fnma_loan_file_life_plus_4y").every((g) => g.open), "every federal clock has expired by 2032 but the Fannie Mae class holds the file");
  assert.throws(() => assertOriginationGatesOpen("urla_1003", { ...file.facts, today: D("2032-01-01"), hold_count: 0 }), /FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION closed: permanent_while_active/);
  // the same fixture through the bus tools and the timer engine: the gates are evaluator-backed rows armed by the anchor events
  const viaTool = h.run("records.anchor", { op: "clocks", facts: REFI_FIXTURE_FACTS, today: "2027-03-01" }) as unknown as ReturnType<typeof fileClocks>;
  assert.deepEqual(viaTool.clocks, clocks.clocks);
  assert.equal(h.timer("REGZ_1026_25C1II_CD_RETENTION_5Y")?.note, "evaluator:31.3.regZCdGateOpen");
  assert.equal(h.timer("REGZ_1026_25C1I_LE_RETENTION_3Y")?.subject.id, APP);
  assert.equal(EVALUATORS_31_3["31.3.regZLeGateOpen"]!({ ...REFI_FIXTURE_FACTS, today: "2029-11-05", hold_count: 0 }).open, false);
  assert.equal(EVALUATORS_31_3["31.3.regZLeGateOpen"]!({ ...REFI_FIXTURE_FACTS, today: "2029-11-06", hold_count: 0 }).open, true);
  assert.equal(EVALUATORS_31_3["31.3.hmdaLarGateOpen"]!({ ...REFI_FIXTURE_FACTS, today: "2030-02-15", hold_count: 0 }).open, true);
  assert.equal(EVALUATORS_31_3["31.3.ofacGateOpen"]!({ ...REFI_FIXTURE_FACTS, today: "2036-10-04", hold_count: 0 }).open, false);
  // records.classify: every object of a funded loan is Fannie Mae property; the federal clocks are recorded, never shorten
  const c = h.run("records.classify", { record_type: "loan_estimate", funded: true, state: "AZ" }) as unknown as ReturnType<typeof classifyOriginationRecord>;
  assert.deepEqual(c.retention_class_codes, ["regz_le_3y", "regz_general_2y", "fnma_loan_file_life_plus_4y"]); assert.equal(c.fnma_property, true); assert.equal(c.may_shorten, false);
  assert.ok(ORIG_RETENTION_CLASSES.every((k) => k.may_shorten === false));
});

test("31.3-T2: Given the funded fixture paid in full Mon 2032-03-15, then the loan file is eligible 2036-03-15, the OFAC screening record 2036-10-05, the eNote signing records 2039-03-15, and the first disposal run including the loan file is Sunday 2036-04-06.", () => {
  const h = harness(at("2036-03-15", "09:00"));
  assert.equal(dayOfWeek(D("2032-03-15")), 1, "Monday");
  const paid: OrigObjectFacts = { ...REFI_FIXTURE_FACTS, loan_active: false, liquidated_on: D("2032-03-15") };
  // `loan.liquidated` is 19.1's servicing anchor: records.anchor reads it into every object of the file
  let objects = enrollFile(h.ctx(), "APP-REFI-AZ", REFI_FIXTURE_FACTS, "AZ", ["enote_signing_record"]);
  const liq = h.events.append({ type: "loan.liquidated", loanId: "L-REFI", applicationId: "APP-REFI-AZ", actor: AGENT, occurredAt: at("2032-03-15", "16:00"), payload: { application_id: "APP-REFI-AZ", liquidation_kind: "paid_in_full", liquidated_on: "2032-03-15" } });
  objects = anchorObjects(objects, liq, h.ctx()).objects;
  const loanFile = objects.find((o) => o.record_type === "urla_1003")!, ofac = objects.find((o) => o.record_type === "ofac_screen")!, enote = objects.find((o) => o.record_type === "enote_signing_record")!;
  assert.equal(loanFile.eligible_for_disposal_at, "2036-03-15"); assert.equal(loanFile.effective_class_code, "fnma_loan_file_life_plus_4y"); assert.equal(loanFile.status, "eligible");
  assert.equal(dayOfWeek(D("2036-03-15")), 6, "Sat Mar 15, 2036");
  assert.equal(ofac.eligible_for_disposal_at, "2036-10-05"); assert.equal(ofac.effective_class_code, "ofac_10y", "later, so the OFAC record's own class holds it");
  assert.equal(enote.eligible_for_disposal_at, "2039-03-15"); assert.equal(enote.effective_class_code, "fnma_enote_signing_life_plus_7y");
  const clocks = fileClocks(paid, D("2036-03-15"));
  assert.equal(clocks.eligible_for_disposal_at, "2036-03-15"); assert.equal(clocks.clocks.fnma_enote_signing_life_plus_7y, "2039-03-15"); assert.equal(clocks.clocks.fnma_loan_file_life_plus_4y, "2036-03-15");
  assert.ok(Object.entries(clocks.clocks).filter(([k]) => k.startsWith("reg") || k.startsWith("hmda") || k.startsWith("respa")).every(([, d]) => d !== null && d < "2036-03-15"), "every federal clock has already expired");
  // runs are the first Sunday of each month (19.1): the March run precedes eligibility, so the file joins the April run
  assert.equal(clocks.first_disposal_run, "2036-04-06"); assert.equal(dayOfWeek(D("2036-04-06")), 0, "Sunday");
  assert.equal(firstDisposalRunOnOrAfter(D("2036-03-15")), nextDisposalRun(D("2036-03-15")));
  const marchRun = D("2036-03-02"); assert.equal(dayOfWeek(marchRun), 0); assert.equal(sweepOrigination([loanFile], marchRun)[0]!.status, "retention_running");
  assert.equal(sweepOrigination([loanFile], D("2036-04-06"))[0]!.status, "eligible");
  assert.equal(sweepOrigination([ofac], D("2036-04-06"))[0]!.status, "retention_running", "the OFAC screening record is not in the April 2036 run");
  assert.equal(anniversary(D("2032-03-15"), 4), "2036-03-15");
});

test("31.3-T3: Given a denial notified Wed 2026-11-04, then `REGB_1002_12B_APPLICATION_RETENTION_25M` = 2028-12-04, the file is `unfunded_running`, is not selected on Sunday 2028-12-03, and is included in the attested run of Sunday 2029-01-07 with the LAR row and OFAC log retained.", () => {
  const h = harness(at("2026-11-04", "09:00"));
  const APP = "APP-DENIED-OH";
  assert.equal(dayOfWeek(D("2026-11-04")), 3, "Wednesday");
  let objects = enrollFile(h.ctx(), APP, { funded: false, state: "OH", ofac_transaction_on: D("2026-10-19"), lar_signed_on: D("2027-02-15") }, "OH");
  assert.ok(objects.every((o) => o.status === "pre_funding"));
  // 21.6's adverse-action notice is the Reg B anchor; the timer row arms on it (evaluator-backed) and records.anchor sets the date
  const aa = h.events.append({ type: "notice.adverse_action.sent", applicationId: APP, aggregate: { kind: "application", id: APP }, actor: AGENT, occurredAt: at("2026-11-04", "14:00"), payload: { application_id: APP, notice_ids: ["N1"], sent_on: "2026-11-04", combined_notice: false } });
  objects = anchorObjects(objects, aa, h.ctx()).objects;
  const regb = h.timer("REGB_1002_12B_APPLICATION_RETENTION_25M")!;
  assert.equal(regb.subject.id, APP); assert.equal(regb.note, "evaluator:31.3.regBApplicationGateOpen");
  const file = objects.find((o) => o.record_type === "urla_1003")!;
  assert.equal(file.facts.regb_action_notified_at, "2026-11-04");
  assert.equal(origClassGate("regb_25m", { ...file.facts, today: D("2026-11-05"), hold_count: 0 }).opens_on, "2028-12-04");   // Nov 4, 2026 + 25 calendar months
  assert.equal(dayOfWeek(D("2028-12-04")), 1, "Monday");
  assert.equal(file.status, "unfunded_running"); assert.equal(file.eligible_for_disposal_at, "2028-12-04"); assert.equal(file.effective_class_code, "regb_25m");
  assert.equal(originationObjectEligibility("urla_1003", { ...DENIED_FIXTURE_FACTS, today: D("2027-01-01"), hold_count: 0 }).status, "unfunded_running");
  // Sunday Dec 3, 2028 precedes eligibility: nothing selected
  assert.equal(dayOfWeek(D("2028-12-03")), 0);
  const dec = planUnfundedPurgeRun({ run_on: D("2028-12-03"), objects });
  assert.deepEqual(dec.object_ids, []); assert.equal(dec.status, "planned");
  assert.match(dec.excluded.find((x) => x.object_id === file.id)!.reason, /REGB_1002_12B_APPLICATION_RETENTION_25M: retention runs to 2028-12-04/);
  // Sunday Jan 7, 2029: the file is included; the LAR row (hmda_3y → Feb 15, 2030) and the OFAC log (ofac_10y → Oct 19, 2036) survive under their own classes
  assert.equal(dayOfWeek(D("2029-01-07")), 0); assert.equal(firstDisposalRunOnOrAfter(D("2028-12-04")), "2029-01-07");
  h.clock.set(at("2029-01-07", "02:00"));
  emitOriginationScheduleTicks(D("2029-01-07"), h.events);
  assert.ok(originationScheduleTicks(D("2029-01-07")).some((t) => t.payload!.job === "denied_withdrawn_purge_sweep"));
  const sweepTimer = h.timer("SM_O123_UNFUNDED_FILE_PURGE_SWEEP_MONTHLY")!; assert.equal(sweepTimer.status, "armed");
  const jan = planUnfundedPurgeRun({ run_on: D("2029-01-07"), objects });
  const fileObjects = objects.filter((o) => !["hmda_lar_row", "ofac_screen"].includes(o.record_type));
  assert.deepEqual([...jan.object_ids].sort(), fileObjects.map((o) => o.id).sort());
  assert.deepEqual(jan.retained_under_own_class.map((r) => [objects.find((o) => o.id === r.object_id)!.record_type, r.class_code, r.opens_on]), [["hmda_lar_row", "hmda_3y", "2030-02-15"], ["ofac_screen", "ofac_10y", "2036-10-19"]]);
  assert.equal(jan.status, "awaiting_attestation"); assert.equal(jan.tombstone.credit_reports, "crypto_shred"); assert.ok(jan.tombstone.retained_columns.includes("hmda_derived_fields"));
  // the run is attested by an officer (never the agent) and executed against the same gates
  assert.equal(attestUnfundedPurgeRun(jan, h.ctx(AGENT)).code, "OFFICER_ATTESTATION_REQUIRED");
  assert.equal(executeUnfundedPurgeRun(jan, objects, h.ctx(OFFICER)).refusal?.code, "OFFICER_ATTESTATION_REQUIRED");
  const attested = attestUnfundedPurgeRun(jan, h.ctx(OFFICER)); assert.equal(attested.allowed, true);
  const run = executeUnfundedPurgeRun(attested.run, objects, h.ctx(OFFICER));
  assert.equal(run.executed, true);
  assert.equal(run.objects.filter((o) => o.status === "disposed").length, fileObjects.length);
  assert.ok(run.objects.filter((o) => o.record_type === "hmda_lar_row" || o.record_type === "ofac_screen").every((o) => o.status !== "disposed"));
  const executed = run.events.find((e) => e.type === "disposal_run.executed")!;
  assert.equal(executed.payload.origination_unfunded, true); assert.deepEqual(executed.payload.application_ids, [APP]);
  assert.equal(h.timer("SM_O123_UNFUNDED_FILE_PURGE_SWEEP_MONTHLY")!.status, "armed", "recurring: the executed run satisfied the January instance and re-armed it");
  assert.equal(h.engine.byCode("SM_O123_UNFUNDED_FILE_PURGE_SWEEP_MONTHLY")[0]!.status, "satisfied");
});

test("31.3-T4: Given a written ECOA allegation received 2028-06-05 on that file, then the Reg B gate is extended until `investigation.closed` and the file is `held`.", () => {
  const h = harness(at("2028-06-05", "09:00"));
  const APP = "APP-DENIED-OH";
  let objects = enrollFile(h.ctx(), APP, DENIED_FIXTURE_FACTS, "OH");
  assert.equal(objects[0]!.status, "unfunded_running");
  assert.equal(dayOfWeek(D("2028-06-05")), 1, "Monday");
  const r = recordEcoaAllegation(objects, { application_id: APP, received_on: D("2028-06-05"), matter_ref: "ECOA-2028-017", hold_id: "LH-ECOA-2028-017" }, h.ctx());
  objects = r.objects;
  assert.equal(r.reg_b.extended_until, "investigation.closed"); assert.equal(r.reg_b.open, false); assert.equal(r.reg_b.base_opens_on, "2028-12-04");
  assert.ok(objects.every((o) => o.status === "held" && o.hold_count === 1));
  assert.deepEqual(r.events.map((e) => e.type).filter((t) => t !== "record.anchored"), ["enforcement_notice.received", "legal_hold.trigger.detected", "legal_hold.placed"]);
  assert.equal(r.hold.reason, "origination_complaint_discrimination");
  // the one-hour hold clock armed on the trigger and closed by the placement; 19.1's 180-day review armed on the same `legal_hold.placed`
  assert.equal(h.timer("SM_O123_LEGAL_HOLD_ON_TRIGGER_1H")!.status, "satisfied");
  assert.equal(h.timer("SM_O123_LEGAL_HOLD_ON_TRIGGER_1H")!.dueAt, zonedEpochMs(D("2028-06-05"), "10:00", ET));
  assert.equal(h.timer("SM_LEGAL_HOLD_REVIEW_180")?.status, "armed");
  // past the 25 months the gate stays closed while the investigation is open; the agent can never release the hold
  const file = objects.find((o) => o.record_type === "urla_1003")!;
  const past = originationObjectEligibility("urla_1003", { ...file.facts, today: D("2029-01-07"), hold_count: 0 });
  assert.equal(past.gates.find((g) => g.class_code === "regb_25m")!.reason, "enforcement_open_until_investigation_closed"); assert.equal(past.eligible_for_disposal_at, null);
  assert.deepEqual(planUnfundedPurgeRun({ run_on: D("2029-01-07"), objects }).object_ids, []);
  assert.equal(releaseOriginationHold(objects, r.hold, ["officer"], h.ctx(OFFICER)).code, "HOLD_RELEASE_NEEDS_OFFICER_AND_ATTORNEY");
  assert.equal(releaseOriginationHold(objects, r.hold, ["officer", "attorney"], h.ctx(AGENT)).allowed, false);
  // final disposition: the gate opens at the later of the 25 months and the closing date; officer + attorney release the hold
  h.clock.set(at("2029-03-01", "17:00"));
  objects = recordInvestigationClosed(objects, { application_id: APP, closed_on: D("2029-03-01"), matter_ref: "ECOA-2028-017" }, h.ctx()).objects;
  const released = releaseOriginationHold(objects, r.hold, ["officer", "attorney"], h.ctx(ATTORNEY));
  assert.equal(released.allowed, true);
  const after = released.objects.find((o) => o.record_type === "urla_1003")!;
  assert.equal(after.eligible_for_disposal_at, "2029-03-01"); assert.equal(after.status, "eligible");
});

test("31.3-T5: Given an appraisal order to an AMC whose `contract_clauses` lack `GLBA_1016_13_USE_LIMIT`, then `GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE` blocks the order, `vendor.flowdown.blocked` is emitted and a sev-1 `officer` task exists; with the clause `present`, the order proceeds.", () => {
  const h = harness(at("2026-10-06", "10:00"));
  const APP = "APP-REFI-AZ";
  const lacking = { ...AMC_CLAUSES() }; delete lacking[GLBA_USE_LIMIT_CLAUSE];
  const blocked = checkVendorOrder({ order_id: "APR-1", vendor_id: "V-AMC-1", application_id: APP, facts: { vendor_class: "amc_appraiser", clauses: lacking, privacy_notice_delivered_or_scheduled: true, state: "AZ" } }, h.ctx());
  assert.equal(blocked.allowed, false); assert.equal(blocked.gate, "GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE"); assert.equal(blocked.order_status, "refused");
  assert.deepEqual(blocked.missing, ["GLBA_1016_13_USE_LIMIT=missing"]);
  assert.deepEqual(blocked.events.map((e) => e.type), ["vendor.order.requested", "vendor.flowdown.blocked"]);
  assert.equal(blocked.events[0]!.payload.vendor_class, "amc_appraiser");
  const task = h.escalations.opened.find((e) => e.id === blocked.escalation!.id)!;
  assert.equal(task.kind, "sev1"); assert.equal(task.ownerRole, "officer"); assert.equal(task.applicationId, APP); assert.equal(task.payload.gate, "GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE");
  // both gate rows arm on the order request as evaluator-backed gates; the evaluators read the executed clauses, never an inference
  assert.equal(h.timer("GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE")?.note, "evaluator:31.3.glbaServiceProviderContractGateOpen");
  assert.equal(h.timer("SM_O123_VENDOR_FLOWDOWN_GATE")?.note, "evaluator:31.3.vendorFlowdownGateOpen");
  assert.equal(EVALUATORS_31_3["31.3.glbaServiceProviderContractGateOpen"]!({ vendor_class: "amc_appraiser", clauses: lacking, privacy_notice_delivered_or_scheduled: true }).open, false);
  assert.equal(glbaServiceProviderGate({ vendor_class: "amc_appraiser", clauses: AMC_CLAUSES(), privacy_notice_delivered_or_scheduled: false }).open, false, "and the partner's §1016.4 notice must be delivered or scheduled");
  assert.throws(() => checkVendorOrder({ order_id: "APR-1", vendor_id: "V-AMC-1", application_id: APP, facts: { vendor_class: "amc_appraiser", clauses: lacking, privacy_notice_delivered_or_scheduled: true }, inferred: true }, h.ctx()), /never opens a vendor gate on inference/);
  // with the clause present the order proceeds
  const ok = checkVendorOrder({ order_id: "APR-2", vendor_id: "V-AMC-1", application_id: APP, facts: { vendor_class: "amc_appraiser", clauses: AMC_CLAUSES(), privacy_notice_delivered_or_scheduled: true, state: "AZ" } }, h.ctx());
  assert.equal(ok.allowed, true); assert.equal(ok.order_status, "flowdown_checked"); assert.deepEqual(ok.events.map((e) => e.type), ["vendor.order.requested", "vendor.flowdown.verified"]);
  assert.equal(EVALUATORS_31_3["31.3.vendorFlowdownGateOpen"]!({ vendor_class: "amc_appraiser", clauses: AMC_CLAUSES(), privacy_notice_delivered_or_scheduled: true }).open, true);
  // the class flow-down itself fails closed on any other required clause (AIR independence for an AMC)
  const noAir = { ...AMC_CLAUSES(), AIR_1026_42_INDEPENDENCE: "missing" as const };
  const air = checkVendorOrder({ order_id: "APR-3", vendor_id: "V-AMC-1", application_id: APP, facts: { vendor_class: "amc_appraiser", clauses: noAir, privacy_notice_delivered_or_scheduled: true } }, h.ctx());
  assert.equal(air.gate, "SM_O123_VENDOR_FLOWDOWN_GATE"); assert.deepEqual(air.missing, ["AIR_1026_42_INDEPENDENCE"]);
  assert.ok(vendorFlowdownRequirement("credit_reseller").required_clause_codes.includes("FCRA_END_USER_CERT"));
});

test("31.3-T6: Given a SELECT on `applicant_demographics` by a principal outside the roster, then the read is denied, a SIEM alert fires within 5 minutes, and `SM_O123_PII_ACCESS_ANOMALY_1H` opens.", () => {
  const h = harness(at("2026-11-10", "14:00"));
  const r = logPiiAccess({ principal: "svc:marketing-etl", role: "system", table: "applicant_demographics", application_id: "APP-REFI-AZ", purpose_code: "monitoring_run", request_id: "req-9001", query_hash: sha, row_count: 1 }, h.ctx());
  assert.equal(r.denied, true); assert.equal(r.log.decision, "denied"); assert.deepEqual(r.anomaly, ["unexpected_principal"]);
  assert.equal(r.siem_alert_due_at, at("2026-11-10", "14:05"));
  assert.deepEqual(r.events.map((e) => e.type), ["pii.access.logged", "pii.access.anomaly"]);
  assert.equal(r.log.retention, "security_logs_5y"); assert.equal(r.auto_revoke, "svc:marketing-etl");
  const t = h.timer("SM_O123_PII_ACCESS_ANOMALY_1H")!;
  assert.equal(t.status, "armed"); assert.equal(t.dueAt, zonedEpochMs(D("2026-11-10"), "15:00", ET));
  assert.equal(h.escalations.opened.find((e) => e.id === r.escalation!.id)!.kind, "sev1");
  // the roster's principals read with a purpose code and are logged, not denied
  const ok = logPiiAccess({ principal: "svc:28.3-lar-build", role: "system", table: "applicant_demographics", application_id: null, purpose_code: "hmda_export", request_id: "req-9002", query_hash: sha, row_count: 800 }, h.ctx());
  assert.equal(ok.denied, false); assert.equal(ok.events.length, 1);
  assert.deepEqual(logPiiAccess({ principal: "svc:28.3-lar-build", role: "system", table: "applicant_demographics", application_id: null, purpose_code: "marketing", request_id: "req-9003", query_hash: sha, row_count: 5000 }, h.ctx()).anomaly, ["off_purpose_code", "bulk_read"]);
  // content never enters a prompt; the CI check fails a build referencing the table outside the roster packages
  assert.throws(() => logPiiAccess({ principal: "agent:security-records", role: "agent", table: "applicant_demographics", application_id: null, purpose_code: "incident_scoping", request_id: "req-9004", query_hash: sha, row_count: 1, include_content: true }, h.ctx()), /never reads applicant_demographics content into a prompt/);
  assert.equal(ciRestrictedTableCheck({ package: "marketing/etl", references: ["applicant_demographics.ethnicity"] }).passed, false);
  assert.equal(ciRestrictedTableCheck({ package: "28.3/lar", references: ["applicant_demographics.ethnicity"] }).passed, true);
  // disposition inside the hour closes the row; an incident opens in 19.2's tables
  h.clock.set(at("2026-11-10", "14:40"));
  const d = dispositionPiiAnomaly({ anomaly_id: r.anomaly_id!, disposition: "incident_opened", rationale: "marketing ETL credential misuse", application_id: "APP-REFI-AZ" }, h.ctx());
  assert.deepEqual(d.events.map((e) => e.type), ["security.incident.opened", "pii.access.anomaly.dispositioned"]);
  assert.equal(d.events[0]!.payload.domain, "origination");
  assert.equal(h.engine.byCode("SM_O123_PII_ACCESS_ANOMALY_1H")[0]!.status, "satisfied", "req-9001 dispositioned inside the hour");
  assert.equal(h.engine.byCode("SM_O123_PII_ACCESS_ANOMALY_1H")[1]!.status, "armed", "req-9003 (no application) is still open on its own anomaly subject");
  // the quarterly certification: `access_review.completed{scope=orig_pii}` revokes uncertified access
  h.clock.set(at("2026-12-31", "17:00")); emitOriginationScheduleTicks(D("2026-12-31"), h.events);
  assert.equal(h.timer("SM_O123_PII_ACCESS_REVIEW_90")!.status, "armed");
  const rev = completePiiAccessReview({ period: "2026-Q4", reviewer: "u-ciso", principals: [{ principal: "svc:28.3-lar-build", certified: true, certified_by: "u-ciso" }, { principal: "svc:legacy-report", certified: false, certified_by: "" }] }, h.ctx(OFFICER));
  assert.deepEqual(rev.revoked, ["svc:legacy-report"]); assert.equal(rev.event.payload.scope, "orig_pii");
  assert.equal(h.engine.byCode("SM_O123_PII_ACCESS_REVIEW_90")[0]!.status, "satisfied");
});

test("31.3-T7: Given a marketing dataset build that references `credit_reports.scores`, then the CI check fails and the weekly `SM_O123_FANNIE_DATA_USE_SCAN_WEEKLY` (if the build slipped through) raises a sev-1 incident.", () => {
  const h = harness(at("2026-11-23", "03:00"));
  const ci = ciDataUseCheck({ dataset: "mkt_refi_propensity", pipeline: "marketing", references: ["applications.loan_amount", "credit_reports.scores"] });
  assert.equal(ci.passed, false); assert.deepEqual(ci.violations.map((v) => [v.reference, v.data_class]), [["credit_reports.scores", "fcra_consumer_report"]]);
  assert.match(ci.violations[0]!.citation, /1681b\(f\)/);
  assert.equal(ciDataUseCheck({ dataset: "uw_pipeline", pipeline: "underwriting", references: ["credit_reports.scores"] }).passed, true, "transaction use is the permissible purpose");
  assert.equal(ciDataUseCheck({ dataset: "train", pipeline: "model_training", references: ["du_submissions.findings.risk_factors"] }).violations[0]!.data_class, "fnma_data");
  // the bus guardrail refuses the same build whoever calls the tool
  assert.match(guard("records.classify", "NO_REPURPOSE_CREDIT_OR_FNMA_DATA").refuse({ pipeline: "marketing", references: ["credit_reports.scores"] }, h.commandCtx())!, /never for analytics, marketing or model training/);
  // the weekly scan (Monday tick) finds the build that slipped through → sev-1 incident (Technology Guide / FCRA)
  assert.equal(dayOfWeek(D("2026-11-23")), 1);
  emitOriginationScheduleTicks(D("2026-11-23"), h.events);
  assert.equal(h.timer("SM_O123_FANNIE_DATA_USE_SCAN_WEEKLY")!.status, "armed");
  const scan = scanFannieDataUse({ scan_id: "scan-2026-11-23", datasets: [{ dataset: "mkt_refi_propensity", pipeline: "marketing", references: ["credit_reports.scores"] }, { dataset: "ops_kpis", pipeline: "analytics", references: ["applications.status"] }] }, h.ctx());
  assert.deepEqual(scan.hits.map((x) => x.dataset), ["mkt_refi_propensity"]);
  assert.deepEqual(scan.events.map((e) => e.type), ["fannie_data.use.violation_detected", "security.incident.opened", "fannie_data_use.scan.completed"]);
  assert.equal(scan.events[1]!.payload.severity, "S1"); assert.equal(scan.events[1]!.payload.domain, "origination");
  assert.equal(h.escalations.opened.find((e) => e.id === scan.escalation!.id)!.kind, "sev1");
  assert.equal(h.engine.byCode("SM_O123_FANNIE_DATA_USE_SCAN_WEEKLY")[0]!.status, "satisfied");
  assert.equal(scanFannieDataUse({ scan_id: "scan-clean", datasets: [{ dataset: "ops_kpis", pipeline: "analytics", references: ["applications.status"] }] }, h.ctx()).incident_id, null);
});

test("31.3-T8: Given the AMC incident identified Mon 2026-11-16 10:00 ET with 620 consumers (60 NY), then the Fannie Mae/Form 101 timers are due Tue 2026-11-17 22:00 ET, the partner timer Tue 10:00 ET, the FTC timer Wed 2026-12-16, and the NYDFS timer Sat 2026-11-21 09:00 ET after determination Wed 2026-11-18 09:00 ET; legal holds exist on all 620 applications within 1 hour.", () => {
  const identified = at("2026-11-16", "10:00");
  const h = harness(identified);
  assert.equal(dayOfWeek(D("2026-11-16")), 1, "Monday");
  const mix: [string, number][] = [["AZ", 210], ["OH", 180], ["TX", 95], ["NY", 60], ["CA", 75]];
  const consumers = mix.flatMap(([state, n]) => Array.from({ length: n }, (_, k) => ({ id: `C-${state}-${k}`, application_id: `APP-${state}-${k}`, mailing_state: state, encrypted: false })));
  assert.equal(consumers.length, 620);
  const objects = consumers.map((c) => enrollRecord({ id: `${c.application_id}-appraisal`, record_type: "appraisal_uad", application_id: c.application_id, state: c.mailing_state, sha256: sha }, h.ctx()).object);
  const s = scopeOriginationIncident(objects, { incident_id: "INC-2026-11-16-AMC", identified_at: identified, category: "vendor_incident", confirmed_exposure: true, fnma_application_data: true, consumers, vendor_id: "V-AMC-1", determined_at: at("2026-11-18", "09:00"), assets: ["amc-sftp", "appraisal-pdfs"] }, h.ctx());
  assert.equal(s.severity, "S1"); assert.equal(s.consumer_count, 620); assert.equal(s.ny_residents, 60);
  assert.equal(s.due.fnma_supplement_at, at("2026-11-17", "22:00")); assert.equal(s.due.form101_at, at("2026-11-17", "22:00"));
  assert.equal(s.due.partner_at, at("2026-11-17", "10:00"));
  assert.equal(s.due.ftc_on, "2026-12-16"); assert.equal(dayOfWeek(D("2026-12-16")), 3, "Wednesday"); assert.equal(s.due.ftc_internal_target_on, "2026-12-14");
  assert.equal(s.due.nydfs_notice_at, at("2026-11-21", "09:00")); assert.equal(dayOfWeek(D("2026-11-21")), 6, "Saturday");
  assert.equal(s.due.ny_consumer_on, "2026-12-16");
  // 19.2's rows are armed by the identification / scoping / determination events the origination scoping emits
  assert.equal(h.timer("FNMA_SUPP_INCIDENT_NOTICE_36H")!.dueAt, zonedEpochMs(D("2026-11-17"), "22:00", ET));
  assert.equal(h.timer("FNMA_FORM101_DATA_INCIDENT_NOTICE_36H")!.dueAt, zonedEpochMs(D("2026-11-17"), "22:00", ET));
  assert.equal(h.timer("SM_PARTNER_INCIDENT_NOTICE_24H")!.dueAt, zonedEpochMs(D("2026-11-17"), "10:00", ET));
  assert.equal(h.timer("FTC_314_4J_NOTIFICATION_EVENT_30D")!.dueDate, "2026-12-16");
  assert.equal(h.timer("NYDFS_500_17A_INCIDENT_NOTICE_72H")!.dueAt, zonedEpochMs(D("2026-11-21"), "09:00", ET));
  // holds on all 620 applications within one hour of identification
  assert.equal(s.holds.application_ids.length, 620); assert.equal(s.holds.within_hour, true); assert.equal(s.due.holds_by, at("2026-11-16", "11:00"));
  assert.ok(s.objects.every((o) => o.status === "held" && o.hold_ids.includes(s.holds.hold_id)));
  assert.equal(h.timer("SM_O123_LEGAL_HOLD_ON_TRIGGER_1H")!.status, "satisfied");
  assert.equal(s.events.find((e) => e.type === "legal_hold.placed")!.payload.reason, "origination_security_incident");
  assert.equal(s.vendor_incident?.reassessment, "19.3");
  assert.ok(s.escalations.some((e) => e.kind === "officer"), "every Fannie Mae/partner notice is sent by an officer from the agent's draft");
  assert.ok(s.escalations.some((e) => e.kind === "human_portal_task" && e.owner_role === "officer"), "FTC Safeguards notification form");
  // Veterans Day and Thanksgiving do not extend hour- and calendar-day clocks
  assert.equal(addDays(D("2026-11-16"), 30), "2026-12-16");
});

test("31.3-T9: Given an Arizona applicant in that incident and no `breach_notice` matrix row for AZ, then the AZ consumer-notice clock is refused and an `attorney` escalation is created within 1 hour.", () => {
  const identified = at("2026-11-16", "10:00");
  const h = harness(identified);
  const consumers = [{ id: "C-AZ-1", application_id: "APP-AZ-1", mailing_state: "AZ", encrypted: false }, { id: "C-NY-1", application_id: "APP-NY-1", mailing_state: "NY", encrypted: false }];
  const s = scopeOriginationIncident([], { incident_id: "INC-2026-11-16-AMC", identified_at: identified, category: "vendor_incident", confirmed_exposure: true, fnma_application_data: true, consumers }, h.ctx());
  assert.deepEqual(s.refused_states, ["AZ"]);
  assert.deepEqual(s.state_clocks.map((c) => c.state), ["NY"], "NY computes from the matrix; AZ is refused");
  const esc = s.escalations.find((e) => e.kind === "attorney")!;
  assert.equal(esc.within_minutes, 60); assert.match(esc.reason, /no jurisdiction_rules.breach_notice row for AZ/);
  const opened = h.escalations.opened.find((e) => e.id === esc.id)!;
  assert.equal(opened.ownerRole, "attorney"); assert.equal(opened.payload.due_by, at("2026-11-16", "11:00"));
  const az = stateConsumerNoticeClock({ state: "AZ", discovered_on: D("2026-11-16"), residents: 210, scoped_at: identified }, h.ctx());
  assert.equal(az.refused, true); assert.equal(az.consumer_due, null); assert.equal(az.escalation!.kind, "attorney"); assert.equal(az.escalation!.due_by, at("2026-11-16", "11:00"));
  // once counsel loads the AZ row the clock computes (fail-closed until then)
  const loaded = stateConsumerNoticeClock({ state: "AZ", discovered_on: D("2026-11-16"), residents: 210, scoped_at: identified, matrix: { AZ: { consumer_days: 45, ag_days: 45, ag_threshold: 1000, cra_threshold: 1000 } } }, h.ctx());
  assert.equal(loaded.refused, false); assert.equal(loaded.consumer_due, "2026-12-31");
});

test("31.3-T10: Given a RON closing in Florida on 2026-11-18, then `RON_RECORDING_ACCESS_FL` shows retention to 2036-11-18 by the RON provider, and the quarterly access test retrieves the session journal entry; a failed retrieval opens a 19.3 reassessment.", () => {
  const h = harness(at("2027-01-05", "09:00"));
  const fl = ronRecordingAccess({ state: "FL", notarial_act_on: D("2026-11-18") });
  assert.equal(fl.timer_code, "RON_RECORDING_ACCESS_FL"); assert.equal(fl.retained_until, "2036-11-18"); assert.equal(fl.holder, "ron_provider"); assert.equal(fl.years, 10);
  assert.match(fl.citation, /§117.245/); assert.equal(fl.verification_status, "verified"); assert.equal(fl.platform_class, "fnma_loan_file_life_plus_4y");
  assert.deepEqual(fl.platform_retains, ["access_right", "session_audit_trail", "recording_hash"]);
  assert.equal(ronRecordingAccess({ state: "AZ", notarial_act_on: D("2026-11-06") }).retained_until, "2031-11-06");
  assert.equal(ronRecordingAccess({ state: "OH", notarial_act_on: D("2026-11-18") }).retained_until, "2036-11-18");
  assert.equal(ronRecordingAccess({ state: "TX", notarial_act_on: D("2026-11-18") }).verification_status, "unverified", "fail-closed: 10 years");
  assert.equal(RON_RETENTION.FL!.years, 10);
  // the session audit trail is the platform's record under the Fannie Mae class; the recording is the provider's
  const c = classifyOriginationRecord("ron_session_audit", { funded: true, state: "FL", closing_type: "ron" });
  assert.deepEqual(c.retention_class_codes, ["regb_25m", "fnma_loan_file_life_plus_4y", "ron_recording_state_10y"]);
  const pass = ronAccessTest({ vendor_id: "V-RON-1", session_id: "RON-FL-1", state: "FL", application_id: "APP-PUR-FL", retrieved: true, journal_entry_hash: sha, period: "2027-Q1" }, h.ctx());
  assert.equal(pass.passed, true); assert.equal(pass.reassessment, null); assert.equal(pass.events[0]!.payload.retention, "RON_RECORDING_ACCESS_FL");
  const fail = ronAccessTest({ vendor_id: "V-RON-1", session_id: "RON-FL-1", state: "FL", application_id: "APP-PUR-FL", retrieved: false, period: "2027-Q2" }, h.ctx());
  assert.equal(fail.passed, false); assert.deepEqual(fail.reassessment, { process: "19.3", vendor_id: "V-RON-1", timer_code: "FNMA_SUPP_VENDOR_REASSESSMENT" });
  assert.equal(h.escalations.opened.find((e) => e.id === fail.escalation!.id)!.kind, "sev2"); assert.equal(fail.escalation!.owner_role, "officer");
  assert.ok(fail.events.some((e) => e.type === "vendor.access_test.failed" && e.payload.reassessment_process === "19.3"));
});

test("31.3-T11: Given a Fannie Mae written request on 2026-11-19 for the origination file with no stated time frame, then the production (A2-4.1-01 checklist complete, hashed manifest) is due 2026-12-04 (10 Fannie Mae ET business days; Thanksgiving excluded) via a `fnma_portal_operator` task.", () => {
  const h = harness(at("2026-11-19", "09:30"));
  const APP = "APP-REFI-AZ";
  const kinds = ["urla_1003", "scif_1103", "credit_report", "verification_report", "du_findings", "appraisal_uad", "title_policy", "insurance_evidence", "note_image", "enote_smartdoc", "enote_signing_record", "security_instrument", "mi_certificate", "bank_statement", "closing_package", "closing_disclosure", "assignment"];
  const objects = kinds.map((t) => enrollRecord({ id: `${APP}-${t}`, record_type: t, application_id: APP, state: "AZ", sha256: sha, facts: REFI_FIXTURE_FACTS }, h.ctx()).object);
  const r = fnmaOriginationFileRequest({ request_id: "FNMA-REQ-2026-11-19", application_id: APP, received_on: D("2026-11-19"), objects, funded: true, mi_required: true, flood_required: false, enote: true, purchased: true, fnma_loan_number: "1234567890" }, h.ctx());
  assert.equal(r.due_on, "2026-12-04"); assert.equal(r.stated_business_days, null); assert.equal(r.calendar, "business_days_fannie_et");
  assert.equal(dayOfWeek(D("2026-11-26")), 4, "Thanksgiving Thursday is excluded from the ten Fannie Mae ET business days");
  assert.equal(r.file.complete, true); assert.deepEqual(r.file.missing, []); assert.match(r.file.manifest_sha256, /^[0-9a-f]{64}$/); assert.equal(r.file.object_count, kinds.length);
  assert.equal(r.task.owner_role, "fnma_portal_operator"); assert.equal(r.task.kind, "human_portal_task"); assert.equal(r.timer_code, "FNMA_A2_4_1_02_RECORDS_DELIVERY_REQUESTED");
  const task = h.escalations.opened.find((e) => e.id === r.task.id)!;
  assert.equal(task.ownerRole, "fnma_portal_operator"); assert.equal(task.payload.due_on, "2026-12-04"); assert.equal(task.payload.manifest_sha256, r.file.manifest_sha256);
  assert.equal(r.events[0]!.type, "records.request.received"); assert.equal(r.events[0]!.payload.requester_type, "fannie_mae"); assert.equal(r.events[0]!.payload.due_on, "2026-12-04");
  assert.equal(r.hold_reason, "fannie_mae_request");
  // a stated time frame wins; an incomplete file names what A2-4.1-01 still requires
  assert.equal(fnmaOriginationFileRequest({ request_id: "FNMA-REQ-2", application_id: APP, received_on: D("2026-11-19"), stated_business_days: 5, objects, funded: true }, h.ctx()).due_on, "2026-11-27");   // Nov 20, 23, 24, 25, 27 — Thanksgiving skipped
  const partial = compileOriginationFile({ application_id: APP, objects: objects.filter((o) => o.record_type !== "closing_disclosure"), funded: true, enote: true });
  assert.equal(partial.complete, false); assert.deepEqual(partial.missing, ["the final version of the Closing Disclosure"]);
  assert.notEqual(partial.manifest_sha256, r.file.manifest_sha256);
});

test("31.3-T12: Given a CCPA deletion request from a denied California applicant on 2027-02-01, then the response cites the GLBA exemption, nothing is deleted before the file's own Reg B expiry (2028-12-04 in T3), and the request is logged.", () => {
  const h = harness(at("2027-02-01", "10:00"));
  const APP = "APP-DENIED-CA";
  const facts: OrigObjectFacts = { ...DENIED_FIXTURE_FACTS, state: "CA" };
  const r = privacyRequest({ request_id: "CCPA-2027-02-01", application_id: APP, kind: "ccpa_deletion", state: "CA", received_on: D("2027-02-01"), file_facts: facts }, h.ctx());
  assert.equal(r.disposition, "glba_exempt"); assert.match(r.citation, /1798\.145\(e\)/); assert.equal(r.deletion_allowed, false);
  assert.equal(r.earliest_disposal, "2028-12-04"); assert.match(r.response_basis, /runs to 2028-12-04/);
  assert.equal(r.event.type, "privacy.request.received"); assert.equal(r.event.payload.logged, true); assert.equal(r.event.payload.kind, "ccpa_deletion"); assert.equal(r.event.applicationId, APP);
  // nothing is deleted before the Reg B expiry: the gate refuses the disposal, the tools refuse a delete outright
  assert.throws(() => assertOriginationGatesOpen("urla_1003", { ...facts, today: D("2027-02-01"), hold_count: 0 }), /REGB_1002_12B_APPLICATION_RETENTION_25M closed: retention runs to 2028-12-04/);
  assert.equal(originationObjectEligibility("credit_report", { ...facts, today: D("2027-02-01"), hold_count: 0 }).status, "unfunded_running");
  assert.equal(originationObjectEligibility("urla_1003", { ...facts, today: D("2028-12-04"), hold_count: 0 }).status, "eligible");
  assert.match(guard("records.anchor", "NO_DELETE").refuse({ op: "delete", application_id: APP }, h.commandCtx())!, /never deleted by a tool/);
  assert.equal(originationGuards({ op: "delete" }, OFFICER).code, "NO_DELETE", "not even an officer deletes: disposal only through the attested run");
  const objects = enrollFile(h.ctx(), APP, facts, "CA");
  assert.deepEqual(planUnfundedPurgeRun({ run_on: D("2027-02-07"), objects }).object_ids, []);
  // a Colorado correction request is routed to 21.6, never deletion
  assert.equal(privacyRequest({ request_id: "CO-1", application_id: "APP-CO", kind: "co_correction", state: "CO", received_on: D("2027-02-01"), file_facts: { ...facts, state: "CO" } }, h.ctx()).disposition, "routed_21_6");
});

test("31.3-T13: Given AI off, then the same gates block disposals and vendor orders and the human operator uses the 19.1/19.2 workspaces.", () => {
  const h = harness(at("2027-03-01", "09:00"));
  const path = operatorPath(false);
  assert.equal(path.executor, "human_operator"); assert.deepEqual(path.workspaces, ["19.1", "19.2"]); assert.equal(path.guardrails_identical, true);
  assert.ok(path.gates.includes("REGB_1002_12B_APPLICATION_RETENTION_25M") && path.gates.includes("GLBA_1016_13_SERVICE_PROVIDER_CONTRACT_GATE"));
  assert.equal(operatorPath(true).executor, "security-records");
  // disposal: the funded active file and the running unfunded file are blocked identically for the agent and the operator (the gate takes no actor)
  const funded = { ...REFI_FIXTURE_FACTS, today: D("2032-01-01"), hold_count: 0 };
  assert.throws(() => assertOriginationGatesOpen("urla_1003", funded), /permanent_while_active/);
  const objects = enrollFile(h.ctx(OPERATOR), "APP-DENIED-OH", DENIED_FIXTURE_FACTS, "OH");
  const plan = planUnfundedPurgeRun({ run_on: D("2028-12-03"), objects });
  assert.deepEqual(plan.object_ids, []);
  assert.equal(executeUnfundedPurgeRun({ ...plan, object_ids: [objects[0]!.id], attested_by: "u-officer", attested_at: h.clock.now() }, objects, h.ctx(OPERATOR)).refusal?.code, "GATE_CLOSED");
  assert.equal(executeUnfundedPurgeRun({ ...plan, object_ids: [objects[0]!.id], attested_by: "u-officer", attested_at: h.clock.now() }, objects, h.ctx(AGENT)).refusal?.code, "GATE_CLOSED");
  // vendor orders: the operator's order without the §1016.13 clause is refused exactly as the agent's
  const lacking = { ...AMC_CLAUSES() }; delete lacking[GLBA_USE_LIMIT_CLAUSE];
  const human = checkVendorOrder({ order_id: "APR-H", vendor_id: "V-AMC-1", application_id: "APP-REFI-AZ", facts: { vendor_class: "amc_appraiser", clauses: lacking, privacy_notice_delivered_or_scheduled: true } }, h.ctx(OPERATOR));
  const agent = checkVendorOrder({ order_id: "APR-A", vendor_id: "V-AMC-1", application_id: "APP-REFI-AZ", facts: { vendor_class: "amc_appraiser", clauses: lacking, privacy_notice_delivered_or_scheduled: true } }, h.ctx(AGENT));
  assert.equal(human.gate, agent.gate); assert.deepEqual(human.missing, agent.missing); assert.equal(human.allowed, false);
  // the guardrails read the same for both paths
  for (const actor of [AGENT, OPERATOR]) {
    assert.equal(originationGuards({ op: "delete" }, actor).code, "NO_DELETE");
    assert.equal(originationGuards({ op: "open_vendor_gate", inferred: true }, actor).code, "NO_GATE_ON_INFERENCE");
    assert.equal(originationGuards({ op: "prompt", includes_demographics_content: true }, actor).code, "NO_DEMOGRAPHICS_IN_PROMPT");
    assert.equal(originationGuards({ op: "dataset_build", pipeline: "marketing", references: ["credit_reports.scores"] }, actor).code, "NO_REPURPOSE_CREDIT_OR_FNMA_DATA");
    assert.equal(originationGuards({ op: "release_hold", approvals: ["officer"] }, actor).code, "NO_HOLD_RELEASE");
  }
  assert.equal(originationGuards({ op: "send_notice", recipient: "fannie_mae_supplement" }, AGENT).code, "DRAFTS_ONLY");
  assert.equal(originationGuards({ op: "send_notice", recipient: "fannie_mae_supplement" }, OFFICER).allowed, true);
  assert.equal(originationGuards({ op: "release_hold", approvals: ["officer", "attorney"] }, ATTORNEY).allowed, true);
  assert.match(guard("records.classify", "NO_HOLD_RELEASE").refuse({ op: "release_hold" }, h.commandCtx(OPERATOR))!, /officer and attorney/);
  // the tools refuse a missing subject with a typed reason on both paths
  assert.throws(() => h.run("records.classify", {}, OPERATOR), RangeError);
  assert.throws(() => h.run("records.anchor", {}, AGENT), RangeError);
});

test("31.3 worked figures: retention arithmetic of worked examples 1–3 (rule 2–4) and the anchors the tools record", () => {
  const h = harness(at("2026-11-18", "17:00"));
  // worked example 3 — purchase fixture (Columbus, OH; closing Wed Nov 18, 2026; LE required by Oct 22, 2026)
  const purchase: OrigObjectFacts = { funded: true, loan_active: true, state: "OH", consummation_date: D("2026-11-18"), disclosure_required_at: D("2026-10-22"), notarial_act_on: D("2026-11-18") };
  const c = fileClocks(purchase, D("2026-12-01"));
  assert.equal(c.clocks.regz_cd_5y, "2031-11-18"); assert.equal(c.clocks.regz_le_3y, "2029-11-18"); assert.equal(c.effective_class, "fnma_loan_file_life_plus_4y");
  assert.equal(ronRecordingAccess({ state: "OH", notarial_act_on: D("2026-11-18") }).retained_until, "2036-11-18");
  assert.equal(origClassGate("regz_general_2y", { ...purchase, today: D("2028-10-22"), hold_count: 0 }).opens_on, "2028-10-22");
  // rule 2 arithmetic: same month/day N years later; Feb 29 anchors roll to Mar 1 (19.1)
  assert.equal(origClassGate("regz_cd_5y", { funded: false, consummation_date: D("2028-02-29"), today: D("2030-01-01"), hold_count: 0 }).opens_on, "2033-03-01");
  assert.equal(origClassGate("regb_25m", { funded: false, regb_action_notified_at: D("2026-11-04"), today: D("2027-01-01"), hold_count: 0 }).opens_on, "2028-12-04");
  // OFAC blocked property: the anchor is unset until the unblocking report (31 CFR 501.601)
  const blocked = origClassGate("ofac_10y", { funded: false, ofac_blocked: true, ofac_transaction_on: D("2026-10-19"), today: D("2040-01-01"), hold_count: 0 });
  assert.equal(blocked.open, false); assert.match(blocked.reason!, /anchor unset until ofac.report.submitted\{unblocking\}/);
  assert.equal(origClassGate("ofac_10y", { funded: false, ofac_blocked: true, ofac_transaction_on: D("2026-10-19"), ofac_unblocked_on: D("2027-06-01"), today: D("2040-01-01"), hold_count: 0 }).opens_on, "2037-06-01");
  // the two 31.3 writes that carry their own anchors, through the bus tool
  const lo = h.run("records.anchor", { op: "lo_comp_paid", application_id: "APP-REFI-AZ", loan_id: "L-REFI", record_id: "LOC-1", mlo_nmlsr_id: "123456", paid_on: "2026-12-15", sha256: sha }) as { object: OrigRecordObject };
  assert.equal(lo.object.facts.lo_comp_paid_on, "2026-12-15"); assert.equal(h.timer("REGZ_1026_25C2_LOCOMP_RETENTION_3Y")?.note, "evaluator:31.3.regZLoCompGateOpen");
  assert.equal(origClassGate("regz_locomp_3y", { ...lo.object.facts, today: D("2029-12-15"), hold_count: 0 }).open, true);
  const afba = recordAfbaExecuted({ application_id: "APP-REFI-AZ", executed_on: D("2026-10-05"), record_id: "AFBA-1", sha256: sha, provider: "affiliate title" }, h.ctx());
  assert.equal(afba.event.type, "afba.executed"); assert.equal(h.timer("RESPA_1024_15D_AFBA_RETENTION_5Y")?.subject.id, "APP-REFI-AZ");
  assert.equal(origClassGate("respa_afba_5y", { ...afba.object.facts, today: D("2031-10-05"), hold_count: 0 }).opens_on, "2031-10-05");
  assert.equal(recordLoCompPaid({ application_id: "APP-2", mlo_nmlsr_id: "1", paid_on: D("2026-12-15"), kind: "received", record_id: "LOC-2", sha256: sha }, h.ctx()).event.payload.receipt_or_payment, "received");
  // a Section 8 record's enrolment arms the RESPA_1024_14H row from its document date
  h.run("records.classify", { op: "enroll", record_type: "msa_agreement", application_id: "APP-REFI-AZ", object_id: "MSA-1", sha256: sha, document_date: "2026-09-15" });
  assert.equal(h.timer("RESPA_1024_14H_S8_RETENTION_5Y")?.note, "evaluator:31.3.respaS8GateOpen");
  assert.equal(EVALUATORS_31_3["31.3.respaS8GateOpen"]!({ document_date: "2026-09-15", today: "2031-09-15", hold_count: 0 }).open, true);
  // records.anchor op=read explains an unknown event as anchoring nothing
  assert.equal(anchorFromEvent({ type: "payment.received", payload: {}, occurredAt: h.clock.now() }).anchored, false);
  assert.equal((h.run("records.anchor", { op: "read", event_type: "sar.filed", payload: { filed_on: "2027-01-10" } }) as { patch: { sar_filed_on: string } }).patch.sar_filed_on, "2027-01-10");
});
