// 19.1 Records retention
// spec/sections/19-data-security-recordkeeping/19-1-records-retention.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, dayOfWeek, addYears, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import type { CommandContext } from "../../app/commands.ts";
import { anniversary, retention, nextDisposalRun, disposalAllowed, holdReleaseAllowed, servicingFileDue, fnmaRecordsRequestDue, ftcDisposalDue, routeRecordsRequest, type RetentionInput } from "./retention.ts";
import {
  RECORD_TYPES, RETENTION_CLASSES, classifyRecord, retentionClass, gateOpensOn, jurisdictionYears, objectEligibility, assertGateOpen, assertObjectGatesOpen, GateClosed, fnmaRetentionGate, regBRetentionGate, classGate, DISPOSAL_GATES, loanRetention,
  sweep, placeHold, reviewLegalHold, releaseHold, planDisposalRun, attestDisposalRun, executeDisposalRun, attestationFromEvents, wormFromEvents, disposalGuards,
  wormIntegrityCheck, wormIntegrityJob, compileServicingFile, transactionSchedule, dollars, servicingFileDrill, sampleDrillLoans, runServicingFileDrill, emitScheduleTicks, reviewRecordsInventory, SERVICING_FILE_TARGET_MS, DRILL_SAMPLE_SIZE,
  intakeRecordsRequest, productionDue, productionFacts, productionDeliveryAllowed, productionGuards, approveProduction, deliverProduction, ftcExceptionReason, exceptFtcDisposal,
  recordLoanLiquidated, recordLoanDischarged, reverseLoanLiquidation, writeSecurityLog, LIQUIDATION_KINDS, type LiquidationKind,
  recordLoanFinalEntry, recordLossmitDecisionNotified, recordCallRecorded, recordTaxFormFiled, recordInvestorReportFiled, recordContactLastUse, ingestAnchorEvent,
  type GateFacts, type ObjectFacts, type RecordObject, type IncidentContext, type DrillCompile, type ServicingFileInput,
} from "./ops-19-1.ts";
import { EVALUATORS_19_1 } from "./evaluators-19-1.ts";
import { TOOLS_19_1 } from "../../app/tools/section19-1.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";

const ET = "America/New_York";
const notices = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };
const AGENT: Actor = { kind: "agent", id: "security-records" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const ATTORNEY: Actor = { kind: "human", id: "u-attorney", role: "attorney" };
const OPERATOR: Actor = { kind: "human", id: "u-ops", role: "ops_analyst" };
/** The platform pieces a 19.1 command runs against: the event spine, the overridden timer registry, the escalation queue. */
function harness(nowIso: string, processes: string[] = ["19.1"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const registry = loadOverriddenRegistry();
  const engine = new TimerEngine(registry, events, { processes });
  const escalations = new EscalationService(events, clock);
  const ctx = (actor: Actor): IncidentContext => ({ events, escalations, actor, now: clock.now() });
  const at = (date: string, hhmm: string) => toIso(zonedEpochMs(D(date), hhmm, ET));
  const commandCtx = (actor: Actor, loanId = "L-1"): CommandContext => ({ loanId, events, ledger: new MemoryLedger(), timers: engine, clock, decide: () => {}, actor, now: clock.now() });
  const runtime = (): ToolRuntime => ({ store: new EntityStore(), ports: {}, escalations, services: {} });
  return { clock, events, registry, engine, escalations, ctx, at, commandCtx, runtime };
}
/** Worked example A's loan for the shared calculator (TX, no debt-collector flag). */
const PAID_LOAN: RetentionInput = { liquidated_on: D("2027-03-15"), discharged_on: D("2027-03-15"), transferred_out_on: null, final_entry_on: null, state: "TX", fdcpa_debt_collector: false, last_collection_activity_on: null, hold_count: 0, loan_active: false };
/** The same loan's anchors as a record object carries them (`record_objects.anchors`). */
const PAID_TX: ObjectFacts = { loan_active: false, liquidated_on: D("2027-03-15"), discharged_on: D("2027-03-15"), transferred_out_on: null, final_entry_on: null, fdcpa_debt_collector: false, last_collection_activity_on: null };
const object = (id: string, loan_id: string | null, facts: ObjectFacts, record_type = "contact_note", worm: string | null = "a".repeat(64), state: string | null = "TX"): RecordObject => ({ id, record_type, loan_id, state, facts, sha256: "a".repeat(64), worm_sha256: worm, status: "active", hold_count: 0, hold_ids: [], eligible_for_disposal_at: null, effective_class_code: null, gates: [], disposed_at: null, disposal_run_id: null });
const wormOf = (o: RecordObject) => ({ id: o.id, sha256: o.sha256, worm_sha256: o.worm_sha256 });
const gateMap = (o: RecordObject) => Object.fromEntries(o.gates.map((g) => [g.timer_code ?? g.class_code, g.opens_on]));
/** A loan in the systems of record the compile tool gathers from (rule 5 (i)–(v)). */
function seedLoan(rt: ToolRuntime, loanId: string, o: { lossmit?: boolean; security_instrument?: boolean } = {}): void {
  const by = SYSTEM, now = "2026-10-01T12:00:00.000Z";
  rt.store.put("loans", loanId, { loan_id: loanId, upb_cents: 25_000_000n, note_rate_bps: 650, state: "TX", days_delinquent: 0, borrower_ssn: "123-45-6789" }, by, now);
  rt.store.put("loan_terms", `lt-${loanId}-1`, { loan_id: loanId, version: 1, pi_cents: 158_000n, effective_from: "2021-10-01" }, by, now);
  rt.store.put("loan_terms", `lt-${loanId}-2`, { loan_id: loanId, version: 2, pi_cents: 160_000n, effective_from: "2024-10-01" }, by, now);
  rt.store.put("loan_borrowers", `lb-${loanId}`, { loan_id: loanId, borrower_id: `B-${loanId}` }, by, now);
  rt.store.put("borrowers", `B-${loanId}`, { name: "A. Borrower", ssn: "987-65-4321", mailing_state: "TX" }, by, now);
  rt.store.put("properties", loanId, { loan_id: loanId, state: "TX", occupancy_status: "owner" }, by, now);
  rt.store.put("escrow_accounts", `ea-${loanId}`, { loan_id: loanId, balance_cents: 120_000n, cushion_cents: 40_000n }, by, now);
  rt.store.put("escrow_lines", `el-${loanId}-tax`, { loan_id: loanId, kind: "tax", amount_cents: -300_000n, posted_at: "2026-01-15T15:00:00.000Z" }, by, now);
  rt.store.put("disbursements", `d-${loanId}-1`, { loan_id: loanId, amount_cents: -300_000n, payee: "County tax", rail: "check", issued_on: "2026-01-15" }, by, now);
  rt.store.put("ledger_entries", `le-${loanId}-tax`, { loan_id: loanId, posted_at: "2026-01-15T15:00:00.000Z", disbursement_id: `d-${loanId}-1`, escrow_line_id: `el-${loanId}-tax`, description: "county tax disbursement", escrow_cents: -300_000n }, by, now);
  rt.store.put("payments", `pay-${loanId}-1`, { loan_id: loanId, amount_cents: 200_000n, channel: "ach", received_on: "2026-09-01" }, by, now);
  rt.store.put("payment_allocations", `pa-${loanId}-1`, { loan_id: loanId, payment_id: `pay-${loanId}-1`, posted_at: "2026-09-01T14:00:00.000Z", principal_cents: 40_000n, interest_cents: 120_000n, escrow_cents: 40_000n }, by, now);
  rt.store.put("ledger_entries", `le-${loanId}-pay`, { loan_id: loanId, posted_at: "2026-09-01T14:00:00.000Z", payment_id: `pay-${loanId}-1`, allocation_id: `pa-${loanId}-1`, description: "payment posted", principal_cents: 40_000n, interest_cents: 120_000n, escrow_cents: 40_000n }, by, now);
  rt.store.put("suspense_items", `si-${loanId}-1`, { loan_id: loanId, amount_cents: 5_000n, reason: "partial payment", received_on: "2026-09-15", status: "held" }, by, now);
  if (o.security_instrument !== false) rt.store.put("documents", `doc-si-${loanId}`, { loan_id: loanId, type: "security_instrument", recorded_on: "2021-10-05", source: "custodian" }, by, now);
  rt.store.put("documents", `doc-mod-${loanId}`, { loan_id: loanId, type: "security_instrument_modification", recorded: true, recorded_on: "2024-10-03", source: "servicer" }, by, now);
  rt.store.put("contacts", `ct-${loanId}-1`, { loan_id: loanId, narrative: "borrower called about the escrow analysis", attempted_at: "2026-09-20T15:00:00.000Z" }, by, now);
  rt.store.put("agent_decisions", `ad-${loanId}-1`, { loan_id: loanId, action: "contact.log", rationale: "escrow analysis explained per §1024.17; no dispute raised" }, by, now);
  if (o.lossmit) { rt.store.put("cases", `case-${loanId}-lm`, { loan_id: loanId, case_type: "lossmit", status: "open" }, by, now); rt.store.put("documents", `doc-lm-${loanId}`, { loan_id: loanId, source: "borrower", case_type: "lossmit", type: "hardship_letter" }, by, now); }
}
const lcg = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
/** The pure compile over caller-built sources (the domain function the tool calls) with a caller-measured compile time. */
const pureBundle = (n: number, extra: Partial<ServicingFileInput> = {}) => compileServicingFile({ loan_id: `L-${n}`, transactions: { ledger_entries: [{ id: "le-1", posted_at: "2026-10-01T14:00:00.000Z", principal_cents: 100_000n }] }, security_instrument: { id: `doc-si-${n}`, type: "security_instrument" }, personnel_notes: { contacts: [{ narrative: "borrower called about the escrow analysis" }] }, data_fields: { loans: { loan_id: `L-${n}`, upb_cents: 25_000_000n, borrower_ssn: "123-45-6789" } }, documents: n % 2 ? [{ id: `doc-lm-${n}`, source: "borrower", case_type: "lossmit" }] : [], borrower_submitted_not_applicable_reason: n % 2 ? null : "no §1024.35 / §1024.41 submissions on this loan", compile_ms: 4 * 60_000, compiled_at: "2026-11-01T06:00:00.000Z", requested_by: "drill", ...extra });

test("19.1-T1: Given a loan paid in full 2027-03-15 (NY, Reg F flag, last collection 2027-03-10, final entry 2027-03-24), when the sweep runs, then `eligible_for_disposal_at` = 2031-03-15 and the four gates show 2028-03-15 / 2030-03-10 / 2030-03-24 / 2031-03-15.", () => {
  const loan: RetentionInput = { liquidated_on: D("2027-03-15"), discharged_on: D("2027-03-15"), transferred_out_on: null, final_entry_on: D("2027-03-24"), state: "NY", fdcpa_debt_collector: true, last_collection_activity_on: D("2027-03-10"), reg_b_notified_on: D("2027-01-20"), hold_count: 0, loan_active: false };
  const g = retention(loan, D("2027-04-01"));
  assert.deepEqual([g.regx, g.regf, g.ny, g.fnma], [D("2028-03-15"), D("2030-03-10"), D("2030-03-24"), D("2031-03-15")]);
  assert.equal(g.eligible_for_disposal_at, D("2031-03-15")); assert.equal(g.status, "retained");
  assert.equal(g.reg_b, D("2029-02-20"));   // a pre-payoff Reg B denial notified 2027-01-20 → 2029-02-20 does not extend the date
  assert.deepEqual(loanRetention(loan, D("2027-04-01")), { ...g, reg_b_extended_until: null });   // the corrected calculator agrees with the shared one wherever no enforcement notice is open
  // rule 1 per object: a contact note of this loan carries Fannie Mae + Reg X + NY 419.9 + Reg F (a); effective = max over the classes
  const facts: ObjectFacts = { loan_active: false, liquidated_on: D("2027-03-15"), discharged_on: D("2027-03-15"), transferred_out_on: null, final_entry_on: D("2027-03-24"), fdcpa_debt_collector: true, last_collection_activity_on: D("2027-03-10"), notified_on: D("2027-01-20") };
  const gf: GateFacts = { ...facts, today: D("2031-03-15"), hold_count: 0 };
  const e = objectEligibility("contact_note", "NY", gf);
  assert.deepEqual(Object.fromEntries(e.gates.map((x) => [x.timer_code, x.opens_on])), { REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER: D("2028-03-15"), REGF_1006_100A_RETENTION_3Y_POST_LAST_COLLECTION: D("2030-03-10"), NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY: D("2030-03-24"), FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION: D("2031-03-15") });
  assert.equal(e.eligible_for_disposal_at, D("2031-03-15")); assert.equal(e.disposable, true); assert.equal(e.effective_class_code, "life_of_loan_plus_4y");
  const before = objectEligibility("contact_note", "NY", { ...gf, today: D("2031-03-14") }); assert.equal(before.disposable, false); assert.deepEqual(before.blocking, ["FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION: retention runs to 2031-03-15"]);
  // the sweep evaluates every class of the object (not a loan-level summary): the four gates on the object, retention_running the day before, eligible on the date
  const o = object("ro-1", "L-1", facts, "contact_note", "a".repeat(64), "NY");
  const day = sweep([o], D("2031-03-14"))[0]!;
  assert.equal(day.status, "retention_running"); assert.equal(day.eligible_for_disposal_at, D("2031-03-15")); assert.equal(day.effective_class_code, "life_of_loan_plus_4y");
  assert.deepEqual(gateMap(day), { REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER: D("2028-03-15"), REGF_1006_100A_RETENTION_3Y_POST_LAST_COLLECTION: D("2030-03-10"), NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY: D("2030-03-24"), FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION: D("2031-03-15") });
  assert.equal(sweep([o], D("2031-03-15"))[0]!.status, "eligible");
  // a Reg B decision on the loan's loss-mitigation file gates that object (25 months → 2029-02-20) but not the contact note; the object's own classes decide
  const lm = sweep([object("ro-lm", "L-1", facts, "lossmit_document_borrower", "a".repeat(64), "NY")], D("2031-03-15"))[0]!;
  assert.equal(lm.status, "eligible"); assert.equal(gateMap(lm).REGB_1002_12B_RETENTION_25M, D("2029-02-20")); assert.equal(lm.eligible_for_disposal_at, D("2031-03-15"));
  // the first disposal run after eligibility is Sunday 2031-04-06 (first Sunday of the following month)
  assert.equal(nextDisposalRun(D("2031-03-15")), D("2031-04-06")); assert.equal(dayOfWeek(D("2031-04-06")), 0);
  // the timer rows are gates, not clocks: armed from their anchor events they carry no due instant and never breach when the gate opens
  const h = harness("2027-03-15T15:00:00.000Z");
  // the payoff is recorded through the anchor-event ingestion: `loan.liquidated{liquidation_kind=paid_in_full}` (the Fannie Mae liquidation) and, in the same transaction, `loan.discharged{basis=paid_in_full}` (the Reg X discharge); both anchors land on the loan's objects
  const unanchored = sweep([object("ro-1a", "L-1", { loan_active: true, liquidated_on: null, discharged_on: null, transferred_out_on: null, final_entry_on: null, fdcpa_debt_collector: null, last_collection_activity_on: null }, "contact_note", "a".repeat(64), "NY"), object("ro-other", "L-2", PAID_TX)], D("2027-03-15"));
  assert.equal(unanchored[0]!.status, "active");
  assert.throws(() => recordLoanFinalEntry(unanchored, { loan_id: "L-1", entry_on: D("2027-03-24"), entry_kind: "escrow_refund", entry_ref: "disb-refund-1", state: "NY" }, h.ctx(SYSTEM)), /no liquidation or transfer-out anchor/);   // a final entry follows the liquidation (rule 2)
  const paid = recordLoanLiquidated(unanchored, { loan_id: "L-1", liquidation_kind: "paid_in_full", liquidated_on: D("2027-03-15"), source_process: "16.2" }, h.ctx(SYSTEM));
  assert.deepEqual(paid.events.map((e) => [e.type, e.loanId, e.payload.liquidation_kind ?? e.payload.basis]), [["loan.liquidated", "L-1", "paid_in_full"], ["loan.discharged", "L-1", "paid_in_full"]]);
  assert.deepEqual([paid.objects[0]!.facts.liquidated_on, paid.objects[0]!.facts.discharged_on, paid.objects[0]!.facts.loan_active], [D("2027-03-15"), D("2027-03-15"), false]); assert.equal(paid.objects[1]!.facts.liquidated_on, PAID_TX.liquidated_on);   // the neighbour loan's anchors are untouched
  assert.ok(eventMatches(h.registry.get("FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION")!.triggerPattern!, paid.events[0]!)); assert.ok(eventMatches(h.registry.get("REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER")!.triggerPattern!, paid.events[1]!));
  // the last collection activity is 11.4's event (computed for Reg F loans): the lifecycle engine ingests it onto the loan's objects — anchor and debt-collector flag
  h.clock.set("2027-03-10T15:00:00.000Z");
  const lastCollection = h.events.append({ type: "collection.activity.last", loanId: "L-1", actor: SYSTEM, payload: { fdcpa_debt_collector_flag: true, last_activity_on: "2027-03-10", activity: "collection call" } });
  const collected = ingestAnchorEvent(paid.objects, lastCollection);
  assert.deepEqual(collected.patch, { last_collection_activity_on: D("2027-03-10"), fdcpa_debt_collector: true }); assert.deepEqual(collected.anchored, ["ro-1a"]);
  // the final entry — the escrow refund disbursed 2027-03-24 — is computed by the lifecycle engine when it posts: `loan.final_entry` for the NY loan, anchored on the entry date, never before the liquidation
  h.clock.set("2027-03-24T15:00:00.000Z");
  assert.throws(() => recordLoanFinalEntry(collected.objects, { loan_id: "L-1", entry_on: D("2027-03-14"), entry_kind: "escrow_refund", entry_ref: "disb-refund-1", state: "NY" }, h.ctx(SYSTEM)), /precedes the loan's liquidation/);
  const finalEntry = recordLoanFinalEntry(collected.objects, { loan_id: "L-1", entry_on: D("2027-03-24"), entry_kind: "escrow_refund", entry_ref: "disb-refund-1", state: "NY" }, h.ctx(SYSTEM));
  assert.equal(finalEntry.event.type, "loan.final_entry"); assert.equal(finalEntry.event.loanId, "L-1"); assert.deepEqual([finalEntry.event.payload.entry_on, finalEntry.event.payload.state, finalEntry.event.payload.timer_code], [D("2027-03-24"), "NY", "NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY"]);
  assert.ok(eventMatches(h.registry.get("NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY")!.triggerPattern!, finalEntry.event)); assert.ok(eventMatches(h.registry.get("REGF_1006_100A_RETENTION_3Y_POST_LAST_COLLECTION")!.triggerPattern!, lastCollection));
  assert.deepEqual(finalEntry.objects[0]!.facts, { loan_active: false, liquidated_on: D("2027-03-15"), discharged_on: D("2027-03-15"), transferred_out_on: null, bankruptcy_discharge_only: false, final_entry_on: D("2027-03-24"), fdcpa_debt_collector: true, last_collection_activity_on: D("2027-03-10") });
  // the sweep over the anchored objects reproduces the four gates and the effective date from the events alone
  assert.deepEqual(gateMap(sweep(finalEntry.objects, D("2031-03-15"))[0]!), { REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER: D("2028-03-15"), REGF_1006_100A_RETENTION_3Y_POST_LAST_COLLECTION: D("2030-03-10"), NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY: D("2030-03-24"), FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION: D("2031-03-15") });
  assert.deepEqual(sweep(finalEntry.objects, D("2031-03-15"))[0]!.status, "eligible"); assert.equal(sweep(finalEntry.objects, D("2031-03-15"))[0]!.eligible_for_disposal_at, D("2031-03-15")); assert.equal(sweep(finalEntry.objects, D("2031-03-14"))[0]!.status, "retention_running");
  const armed = Object.fromEntries(h.engine.all().map((i) => [i.code, i]));
  for (const [code, ev] of [["FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION", "19.1.fnmaRetentionGateOpen"], ["REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER", "19.1.regXRetentionGateOpen"], ["REGF_1006_100A_RETENTION_3Y_POST_LAST_COLLECTION", "19.1.regFCollectionGateOpen"], ["NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY", "19.1.nyFinalEntryGateOpen"]]) {
    assert.equal(armed[code!]?.status, "armed"); assert.equal(armed[code!]?.dueAt, undefined); assert.equal(armed[code!]?.note, `evaluator:${ev}`);
  }
  assert.deepEqual(h.engine.evaluate("2040-01-01T00:00:00.000Z"), []);
  // and each evaluator reports the gate's own opening date over the same facts the sweep used
  const f = { today: "2030-03-24", hold_count: 0, loan_active: false, liquidated_on: "2027-03-15", discharged_on: "2027-03-15", last_collection_activity_on: "2027-03-10", final_entry_on: "2027-03-24" };
  assert.deepEqual([EVALUATORS_19_1["19.1.regXRetentionGateOpen"]!(f).open, EVALUATORS_19_1["19.1.regFCollectionGateOpen"]!(f).open, EVALUATORS_19_1["19.1.nyFinalEntryGateOpen"]!(f).open, EVALUATORS_19_1["19.1.fnmaRetentionGateOpen"]!(f).open], [true, true, true, false]);
  assert.equal(EVALUATORS_19_1["19.1.fnmaRetentionGateOpen"]!(f).reason, "retention runs to 2031-03-15");
});
test("19.1-T2: Given a servicing transfer-out 2028-10-01, then Reg X gate = 2029-10-01 and effective eligibility = 2032-10-01; no object is disposable before 2029-10-01 under any configuration.", () => {
  const g = retention({ liquidated_on: null, discharged_on: null, transferred_out_on: D("2028-10-01"), final_entry_on: D("2028-10-31"), state: "NY", fdcpa_debt_collector: false, last_collection_activity_on: null, hold_count: 0, loan_active: true }, D("2028-11-01"));
  assert.equal(g.regx, D("2029-10-01")); assert.equal(g.ny, D("2031-10-31")); assert.equal(g.policy_transfer, D("2032-10-01")); assert.equal(g.eligible_for_disposal_at, D("2032-10-01"));
  // every loan-linked record type carries the Reg X (c)(1) floor beside the Fannie Mae class — including recordings, 1098s, TCPA consents and fair-lending data
  const loanLinked = RECORD_TYPES.filter((r) => r.retention_class_codes.includes("life_of_loan_plus_4y"));
  assert.ok(loanLinked.length >= 15);
  for (const r of loanLinked) assert.ok(r.retention_class_codes.includes("regx_1024_38c1_1y_post_discharge_or_transfer"), `${r.code} lacks the Reg X floor`);
  // "under any configuration": every loan-linked type, NY and non-NY, default and a longer local period, with every other anchor firing on the transfer date — nothing opens before 2029-10-01, and the effective date is never before 2032-10-01
  const base: GateFacts = { today: D("2029-09-30"), hold_count: 0, loan_active: true, transferred_out_on: D("2028-10-01"), discharged_on: null, liquidated_on: null, final_entry_on: D("2028-10-31"), notified_on: D("2028-10-01"), revoked_on: D("2028-10-01"), last_reliance_on: null, filed_on: D("2028-10-01"), disclosure_due_date: D("2028-10-01"), last_collection_activity_on: D("2028-10-01"), call_on: D("2028-10-01"), record_on: D("2028-10-01"), form_due_date: D("2028-10-01"), created_on: D("2028-10-01") };
  const eligibilities: string[] = [];
  for (const r of loanLinked) for (const state of ["NY", "TX"]) for (const jurisdiction_years of [null, 6]) {
    const e = objectEligibility(r.code, state, { ...base, jurisdiction_years });
    assert.equal(e.disposable, false, `${r.code}/${state} disposable before 2029-10-01`);
    assert.equal(e.gates.find((x) => x.timer_code === "REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER")!.opens_on, D("2029-10-01"));
    assert.equal(objectEligibility(r.code, state, { ...base, jurisdiction_years, today: D("2029-10-01") }).gates.find((x) => x.timer_code === "REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER")!.open, true);
    assert.ok(e.eligible_for_disposal_at !== null && e.eligible_for_disposal_at >= D(jurisdiction_years ? "2034-10-01" : "2032-10-01"), `${r.code}/${state}: ${e.eligible_for_disposal_at}`);
    eligibilities.push(e.eligible_for_disposal_at);
  }
  assert.equal(eligibilities.reduce((a, b) => (b < a ? b : a)), D("2032-10-01"));   // the earliest any loan-linked object of the transferred loan can go is the policy class
  assert.equal(retentionClass("life_of_loan_plus_4y").may_shorten, false); assert.equal(classifyRecord("note_image").may_shorten, false);   // rule 9: no configuration shortens a Fannie Mae class
  // the sweep over the transferred loan's objects: the 4-year policy class from the transfer date is the effective class; a longer local period the counsel matrix carries is applied by the engine, not by the caller
  const facts: ObjectFacts = { loan_active: true, transferred_out_on: D("2028-10-01"), liquidated_on: null, discharged_on: null, final_entry_on: D("2028-10-31"), fdcpa_debt_collector: false };
  const swept = sweep([object("ro-2", "L-2", facts, "escrow_analysis", "a".repeat(64), "NY")], D("2029-10-01"))[0]!;
  assert.equal(swept.status, "retention_running"); assert.equal(swept.eligible_for_disposal_at, D("2032-10-01")); assert.equal(gateMap(swept).REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER, D("2029-10-01")); assert.equal(gateMap(swept).NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY, D("2031-10-31"));
  assert.equal(sweep([object("ro-2", "L-2", facts, "escrow_analysis", "a".repeat(64), "NY")], D("2032-10-01"))[0]!.status, "eligible");
  assert.equal(sweep([object("ro-2", "L-2", { ...facts, jurisdiction_years: 6 }, "escrow_analysis", "a".repeat(64), "NY")], D("2032-10-01"))[0]!.eligible_for_disposal_at, D("2034-10-01"));
  // the transfer-out is 17.3's event: the lifecycle engine ingests it onto the loan's objects (the loan stays active with the transferee), and the same ingestion lands Reg Z and TCPA anchors from the notice registry's and 11.1's events
  const hx = harness("2028-10-01T14:00:00.000Z");
  const activeObjects = [object("ro-2x", "L-2", { loan_active: true, liquidated_on: null, discharged_on: null, transferred_out_on: null, final_entry_on: null }, "escrow_analysis", "a".repeat(64), "NY"), object("ro-2n", "L-2", { loan_active: true, liquidated_on: null, discharged_on: null, transferred_out_on: null }, "notice_rendered", "a".repeat(64), "NY"), object("ro-9", "L-9", PAID_TX)];
  assert.equal(sweep(activeObjects, D("2032-10-01"))[0]!.status, "active");
  const transfer = ingestAnchorEvent(activeObjects, hx.events.append({ type: "servicing.transferred_out", loanId: "L-2", actor: SYSTEM, payload: { transferee: "SVC-9", transferred_on: "2028-10-01", source_process: "17.3" } }));
  assert.deepEqual(transfer.patch, { transferred_out_on: D("2028-10-01") }); assert.deepEqual(transfer.anchored, ["ro-2x", "ro-2n"]); assert.equal(transfer.objects[2]!.facts.transferred_out_on, null);
  const afterTransfer = sweep(transfer.objects, D("2029-10-01"));
  assert.equal(afterTransfer[0]!.status, "retention_running"); assert.equal(gateMap(afterTransfer[0]!).REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER, D("2029-10-01")); assert.equal(gateMap(afterTransfer[0]!).FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION, D("2032-10-01"));
  assert.equal(afterTransfer[0]!.eligible_for_disposal_at, null); assert.equal(afterTransfer[0]!.gates.find((g) => g.timer_code === "NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY")!.reason, "no_anchor_event");   // the NY class waits for the final reconciliation entry
  hx.clock.set("2028-10-31T20:00:00.000Z");
  const recon = recordLoanFinalEntry(transfer.objects, { loan_id: "L-2", entry_on: D("2028-10-31"), entry_kind: "final_remittance", entry_ref: "recon-2028-10", state: "NY" }, hx.ctx(SYSTEM));   // the transfer-out is the anchor the final entry follows
  assert.equal(hx.engine.byCode("NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY")[0]!.anchorDate, D("2028-10-31"));
  const reconciled = sweep(recon.objects, D("2029-10-01"))[0]!;
  assert.equal(reconciled.eligible_for_disposal_at, D("2032-10-01")); assert.equal(gateMap(reconciled).NY_419_9_RETENTION_3Y_POST_FINAL_ENTRY, D("2031-10-31")); assert.equal(reconciled.effective_class_code, "life_of_loan_plus_4y");
  const regz = ingestAnchorEvent(transfer.objects, hx.events.append({ type: "notice.sent", loanId: "L-2", actor: SYSTEM, payload: { template: "NTC_ARM_RATE_CHANGE", regz: true, disclosure_due_date: "2028-09-15" } }));
  assert.deepEqual(regz.patch, { disclosure_due_date: D("2028-09-15"), regz_disclosure: true }); assert.equal(gateMap(sweep(regz.objects, D("2029-10-01"))[1]!).REGZ_1026_25A_RETENTION_2Y, D("2030-09-15"));
  assert.throws(() => ingestAnchorEvent(regz.objects, hx.events.append({ type: "notice.sent", loanId: "L-2", actor: SYSTEM, payload: { template: "NTC_HELLO" } })), /not a Reg Z disclosure/);
  const tcpa = ingestAnchorEvent(regz.objects, hx.events.append({ type: "consent.revoked", loanId: "L-2", actor: SYSTEM, payload: { channel: "sms", revoked_on: "2028-10-01" } }));
  assert.deepEqual(tcpa.patch, { revoked_on: D("2028-10-01") });
  assert.throws(() => ingestAnchorEvent(tcpa.objects, hx.events.append({ type: "loan.boarded", loanId: "L-2", actor: SYSTEM, payload: {} })), /not an anchor event/);
  assert.throws(() => ingestAnchorEvent(tcpa.objects, hx.events.append({ type: "servicing.transferred_out", actor: SYSTEM, payload: { transferred_on: "2028-10-01" } })), /names no loan/);
  // the ledger rows of the same loan also carry NYDFS 500.6's five years from the record date: a longer class than the loan's, so the object's own effective class
  const ledger = sweep([object("ro-2l", "L-2", { ...facts, record_on: D("2028-10-31") }, "payment_history", "a".repeat(64), "NY")], D("2032-10-01"))[0]!;
  assert.equal(ledger.status, "retention_running"); assert.equal(ledger.eligible_for_disposal_at, D("2033-10-31")); assert.equal(ledger.effective_class_code, "nydfs_500_6_audit_trail_5y");
  // the audit-trail write of the transfer itself (23 NYCRR 500.6): `security_log.written` enrols the entry as a `security_log` object anchored on its record date and arms NYDFS_500_6_AUDIT_TRAIL_5Y for it — a gate (no due instant) that opens five years later
  const h = harness("2028-10-01T14:00:00.000Z");
  const log = writeSecurityLog({ id: "SL-2028-10-01-0001", kind: "transaction_reconstruction", detail: { action: "servicing.transferred_out", loan_id: "L-2", transferee: "SVC-9" }, worm_location: "s3://worm/security-logs/2028/10/01/0001" }, h.ctx(SYSTEM));
  assert.equal(log.event.type, "security_log.written"); assert.deepEqual(log.event.aggregate, { kind: "security_log", id: "SL-2028-10-01-0001" }); assert.equal(log.event.payload.record_on, D("2028-10-01")); assert.equal(log.event.payload.timer_code, "NYDFS_500_6_AUDIT_TRAIL_5Y");
  assert.ok(eventMatches(h.registry.get("NYDFS_500_6_AUDIT_TRAIL_5Y")!.triggerPattern!, log.event));
  const nydfs = h.engine.byCode("NYDFS_500_6_AUDIT_TRAIL_5Y"); assert.equal(nydfs.length, 1); assert.equal(nydfs[0]!.status, "armed"); assert.deepEqual(nydfs[0]!.subject, { kind: "security_log", id: "SL-2028-10-01-0001" }); assert.equal(nydfs[0]!.dueAt, undefined); assert.equal(nydfs[0]!.note, "evaluator:19.1.nydfsAuditTrailGateOpen");
  assert.deepEqual(h.engine.evaluate("2040-01-01T00:00:00.000Z"), []);
  assert.equal(log.object.record_type, "security_log"); assert.equal(log.object.status, "retention_running"); assert.equal(log.object.eligible_for_disposal_at, D("2033-10-01")); assert.deepEqual(log.object.gates.map((g) => [g.timer_code, g.opens_on]), [["NYDFS_500_6_AUDIT_TRAIL_5Y", D("2033-10-01")]]); assert.equal(log.object.worm_sha256, log.object.sha256);
  assert.equal(sweep([log.object], D("2033-09-30"))[0]!.status, "retention_running"); assert.equal(sweep([log.object], D("2033-10-01"))[0]!.status, "eligible");
  assert.deepEqual([EVALUATORS_19_1["19.1.nydfsAuditTrailGateOpen"]!({ today: "2033-09-30", record_on: "2028-10-01", hold_count: 0 }).open, EVALUATORS_19_1["19.1.nydfsAuditTrailGateOpen"]!({ today: "2033-10-01", record_on: "2028-10-01", hold_count: 0 }).open], [false, true]);
  assert.throws(() => writeSecurityLog({ id: " ", kind: "auth", detail: {} }, h.ctx(SYSTEM)), RangeError); assert.throws(() => writeSecurityLog({ id: "SL-x", kind: "diary" as "auth", detail: {} }, h.ctx(SYSTEM)), RangeError);
  // the counsel matrix is empty [UNVERIFIED]: every state resolves to the class's own 4 years and the registry rows carry their version, effective date and disposal method
  assert.deepEqual(jurisdictionYears("TX"), { years: 4, basis: "class_default", state: "TX" }); assert.deepEqual(jurisdictionYears(null).years, 4);
  for (const c of RETENTION_CLASSES) { assert.equal(c.version, "v1"); assert.equal(c.effective_from, D("2026-09-01")); assert.equal(c.effective_to, null); assert.ok(["crypto_shred", "object_delete"].includes(c.disposal_method), c.code); assert.deepEqual(c.jurisdiction_overrides, {}); }
});
test("19.1-T3: Given an active loan, when a disposal command targets any of its Fannie Mae-property objects, then `assertGateOpen` fails with `permanent_while_active`.", () => {
  const active: GateFacts = { today: D("2028-11-01"), hold_count: 0, loan_active: true, liquidated_on: null, transferred_out_on: null, discharged_on: null };
  assert.throws(() => assertGateOpen("FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION", active), (e: unknown) => e instanceof GateClosed && e.gate === "FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION" && e.reason === "permanent_while_active" && e.opens_on === null);
  // every Fannie Mae-property object of the loan is blocked by that gate, whatever its other classes say — through the per-object assertion the executing command uses
  for (const r of RECORD_TYPES.filter((x) => x.fnma_property && x.retention_class_codes.includes("life_of_loan_plus_4y"))) {
    const facts: GateFacts = { ...active, today: D("2040-01-01"), filed_on: D("2028-01-01"), disclosure_due_date: D("2028-01-01"), call_on: D("2028-01-01"), record_on: D("2028-01-01"), form_due_date: D("2028-01-01"), notified_on: D("2028-01-01"), revoked_on: D("2028-01-01"), last_collection_activity_on: D("2028-01-01"), final_entry_on: D("2028-01-01") };
    const e = objectEligibility(r.code, "TX", facts);
    assert.equal(e.disposable, false, r.code); assert.ok(e.blocking.includes("FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION: permanent_while_active"), r.code); assert.equal(e.eligible_for_disposal_at, null);
    assert.throws(() => assertObjectGatesOpen(r.code, "TX", facts), (err: unknown) => err instanceof GateClosed && err.gate === "FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION" && err.reason === "permanent_while_active", r.code);
  }
  // the disposal command: the planner excludes the object with the gate's reason, and the calculator's own guard agrees
  const o = object("ro-active", "L-3", { ...PAID_TX, liquidated_on: null, discharged_on: null, loan_active: true });
  const plan = planDisposalRun({ run_on: D("2031-04-06"), class_code: "life_of_loan_plus_4y", objects: [o], worm: wormIntegrityCheck([wormOf(o)]) });
  assert.deepEqual(plan.object_ids, []); assert.deepEqual(plan.excluded, [{ object_id: "ro-active", reason: "permanent_while_active" }]); assert.equal(plan.status, "planned"); assert.equal(sweep([o], D("2031-04-06"))[0]!.status, "active");
  assert.equal(disposalAllowed(retention({ ...PAID_LOAN, liquidated_on: null, discharged_on: null, loan_active: true }, D("2031-04-06")), true, true).reason, "permanent_while_active");
  // the executing command asserts the gates over the facts, not over the status column: a run that names the object anyway — attested, WORM-verified, the row even claiming `eligible` — is refused by `assertGateOpen`
  const h = harness("2031-04-06T07:00:00.000Z");
  const forced = { ...plan, object_ids: ["ro-active"], status: "awaiting_attestation" as const };
  wormIntegrityJob([wormOf(o)], h.ctx(SYSTEM), { run_id: forced.id });
  const att = attestDisposalRun(forced, h.ctx(OFFICER)); assert.equal(att.allowed, true);
  const exec = executeDisposalRun(att.run, [{ ...o, status: "eligible" }], h.ctx(AGENT), h.events.all());
  assert.equal(exec.executed, false); assert.equal(exec.refusal?.code, "GATE_CLOSED"); assert.match(exec.refusal!.citation!, /FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION closed: permanent_while_active/); assert.equal(exec.run.status, "failed");
  assert.ok(!h.events.all().some((e) => e.type === "record_object.disposed"));
  // the evaluator the timer row names: the same answer, and never open on missing facts ("permanent while active" and "never while held" are not defaults)
  const ev = EVALUATORS_19_1["19.1.fnmaRetentionGateOpen"]!;
  assert.deepEqual(ev({ today: "2028-11-01", loan_active: true, hold_count: 0 }), { open: false, reason: "permanent_while_active" });
  assert.match(ev({ today: "2032-01-01", liquidated_on: "2027-03-15" }).reason!, /loan_active fact required/);
  assert.match(ev({ today: "2032-01-01", liquidated_on: "2027-03-15", loan_active: false }).reason!, /hold_count fact required/);
  assert.equal(ev({ today: "2032-01-01", liquidated_on: "2027-03-15", loan_active: false, hold_count: 1 }).reason, "legal_hold");
  assert.equal(ev({ today: "2032-01-01", liquidated_on: "2027-03-15", loan_active: false, hold_count: 0 }).open, true);
  // a transfer-out anchors the class even while the loan stays active with the transferee
  assert.equal(fnmaRetentionGate({ today: D("2032-10-01"), liquidated_on: null, transferred_out_on: D("2028-10-01"), loan_active: true, hold_count: 0 }).open, true);
  assert.equal(loadOverriddenRegistry().get("FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION")!.offset, "evaluator:19.1.fnmaRetentionGateOpen");
  // the anchor events that end "active": only a Fannie Mae liquidation kind of rule 2 is accepted; a bankruptcy discharge is never a `loan.discharged` (rule 2) — the loan stays active and its objects permanent
  assert.deepEqual([...LIQUIDATION_KINDS], ["paid_in_full", "foreclosure_sale", "short_sale", "dil", "charge_off", "repurchase", "make_whole"]);
  assert.throws(() => recordLoanLiquidated([o], { loan_id: "L-3", liquidation_kind: "reo_listed" as LiquidationKind, liquidated_on: D("2028-11-01") }, h.ctx(SYSTEM)), RangeError);
  assert.throws(() => recordLoanDischarged([o], { loan_id: "L-3", basis: "bankruptcy_discharge", discharged_on: D("2028-11-01") }, h.ctx(SYSTEM)), /bankruptcy discharge/);
  assert.equal(h.engine.byCode("FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION").length, 0); assert.equal(h.engine.byCode("REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER").length, 0);
  // a foreclosure sale liquidates without a Reg X discharge: the Fannie Mae gate arms, the Reg X row does not; reported in error, the correcting `loan.liquidation.reversed` cancels the gate with the reason and the objects are active again (edge case)
  const sold = recordLoanLiquidated([o], { loan_id: "L-3", liquidation_kind: "foreclosure_sale", liquidated_on: D("2031-04-06") }, h.ctx(SYSTEM));
  assert.deepEqual(sold.events.map((e) => e.type), ["loan.liquidated"]); assert.equal(sold.objects[0]!.facts.loan_active, false);
  assert.equal(gateMap(sweep(sold.objects, D("2035-04-06"))[0]!).FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION, D("2035-04-06")); assert.ok(!sweep(sold.objects, D("2035-04-06"))[0]!.gates.some((g) => g.reason === "permanent_while_active"));   // the Fannie Mae gate now runs from the sale; Reg X waits for its own anchor (discharge or transfer-out)
  const armed = h.engine.byCode("FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION"); assert.equal(armed.length, 1); assert.deepEqual([armed[0]!.status, armed[0]!.loanId, armed[0]!.dueAt], ["armed", "L-3", undefined]); assert.equal(h.engine.byCode("REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER").length, 0);
  const rev = reverseLoanLiquidation(sold.objects, { loan_id: "L-3", reason: "foreclosure sale rescinded; loan reported liquidated in error (SVC-2026-03)" }, h.ctx(OFFICER), h.engine);
  assert.equal(rev.event.type, "loan.liquidation.reversed"); assert.deepEqual(rev.cancelled_timer_ids, [armed[0]!.id]); assert.equal(armed[0]!.status, "cancelled"); assert.match(armed[0]!.cancelledReason!, /^liquidation reversed: foreclosure sale rescinded/);
  assert.deepEqual([rev.objects[0]!.facts.liquidated_on, rev.objects[0]!.facts.loan_active], [null, true]); assert.equal(sweep(rev.objects, D("2035-04-06"))[0]!.status, "active");
  assert.throws(() => assertObjectGatesOpen(rev.objects[0]!.record_type, "TX", { ...rev.objects[0]!.facts, today: D("2035-04-06"), hold_count: 0 }), (err: unknown) => err instanceof GateClosed && err.reason === "permanent_while_active");
  // a recorded call and a filed 1098 of the active loan: their own floors (3 years from the call, 4 from the form due date) arm and open, and the Fannie Mae gate still blocks every disposal command while the loan is serviced
  const hc = harness("2028-11-01T15:00:00.000Z");
  const call = recordCallRecorded({ loan_id: "L-3", call_id: "CALL-3-1", call_on: D("2028-11-01"), recording_ref: "carrier://rec/CALL-3-1", duration_seconds: 412, state: "TX", worm_location: "s3://worm/recordings/CALL-3-1" }, hc.ctx(SYSTEM));
  assert.equal(call.event.type, "call.recorded"); assert.equal(call.event.loanId, "L-3"); assert.equal(call.event.payload.timer_code, "REGF_1006_100B_CALL_RECORDING_3Y"); assert.ok(eventMatches(hc.registry.get("REGF_1006_100B_CALL_RECORDING_3Y")!.triggerPattern!, call.event));
  const callRow = hc.engine.byCode("REGF_1006_100B_CALL_RECORDING_3Y"); assert.equal(callRow.length, 1); assert.deepEqual([callRow[0]!.status, callRow[0]!.loanId, callRow[0]!.anchorDate, callRow[0]!.dueAt, callRow[0]!.note], ["armed", "L-3", D("2028-11-01"), undefined, "evaluator:19.1.callRecordingGateOpen"]);
  assert.equal(call.object.record_type, "call_recording"); assert.equal(call.object.status, "active"); assert.equal(gateMap(call.object).REGF_1006_100B_CALL_RECORDING_3Y, D("2031-11-01")); assert.equal(call.object.worm_sha256, call.object.sha256);
  assert.throws(() => recordCallRecorded({ loan_id: "L-3", call_id: "CALL-3-2", call_on: D("2028-11-01"), recording_ref: "x", duration_seconds: 0 }, hc.ctx(SYSTEM)), RangeError);
  const form = recordTaxFormFiled({ loan_id: "L-3", form: "1098", tax_year: 2028, filed_on: D("2029-01-28"), form_due_date: D("2029-01-31"), document_id: "doc-1098-L-3-2028", state: "TX" }, hc.ctx(SYSTEM));
  assert.equal(form.event.type, "tax.form.filed"); assert.deepEqual([form.event.payload.form_due_date, form.event.payload.timer_code], [D("2029-01-31"), "IRS_INFO_RETURN_RETENTION_4Y"]); assert.ok(eventMatches(hc.registry.get("IRS_INFO_RETURN_RETENTION_4Y")!.triggerPattern!, form.event));
  const irsRow = hc.engine.byCode("IRS_INFO_RETURN_RETENTION_4Y"); assert.equal(irsRow.length, 1); assert.deepEqual([irsRow[0]!.status, irsRow[0]!.anchorDate, irsRow[0]!.dueAt, irsRow[0]!.note], ["armed", D("2029-01-31"), undefined, "evaluator:19.1.irsInfoReturnGateOpen"]);   // anchored on the form due date, not the filing date
  assert.equal(gateMap(form.object).IRS_INFO_RETURN_RETENTION_4Y, D("2033-01-31")); assert.equal(form.object.record_type, "tax_form_1098");
  assert.throws(() => recordTaxFormFiled({ loan_id: "L-3", form: "1098", tax_year: 2028, filed_on: D("2029-01-28"), form_due_date: D("2028-01-31"), document_id: "doc-x" }, hc.ctx(SYSTEM)), /not the filing due date for tax year 2028/);
  assert.throws(() => recordTaxFormFiled({ loan_id: "L-3", form: "W-2" as "1098", tax_year: 2028, filed_on: D("2029-01-28"), form_due_date: D("2029-01-31"), document_id: "doc-x" }, hc.ctx(SYSTEM)), RangeError);
  assert.deepEqual(hc.engine.evaluate("2040-01-01T00:00:00.000Z"), []);
  for (const [o, own] of [[call.object, "REGF_1006_100B_CALL_RECORDING_3Y"], [form.object, "IRS_INFO_RETURN_RETENTION_4Y"]] as const) {
    const far = sweep([o], D("2040-01-01"))[0]!;
    assert.equal(far.status, "active"); assert.equal(far.gates.find((g) => g.timer_code === own)!.open, true, own); assert.equal(far.gates.find((g) => g.timer_code === "FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION")!.reason, "permanent_while_active", o.record_type);
    assert.throws(() => assertObjectGatesOpen(o.record_type, o.state, { ...o.facts, today: D("2040-01-01"), hold_count: 0 }), (err: unknown) => err instanceof GateClosed && err.gate === "FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION" && err.reason === "permanent_while_active");
  }
});
test("19.1-T4: Given a `records.request.received` (servicing file) on Fri 2026-10-16 09:00 ET, then `REGX_1024_38C2_SERVICING_FILE_5D` is due Wed 2026-10-21 23:59 ET and a bundle compiled 2026-10-22 breaches sev-1.", () => {
  assert.equal(servicingFileDue(D("2026-10-16")), D("2026-10-21"));
  const h = harness("2026-10-16T13:00:00.000Z");   // 09:00 ET
  const r = intakeRecordsRequest({ id: "RR-4", requester_type: "regulator_state", requester_ref: "NYDFS examination unit", received_at: h.clock.now(), format: "servicing_file_1024_38c2", loan_ids: ["L-1"], scope_description: "servicing file, loan L-1", authority_confidence: 0.97 }, h.ctx(AGENT));
  assert.equal(r.routed_to, "19.1_production"); if (r.routed_to !== "19.1_production") return;
  assert.equal(r.request.status, "scoped"); assert.equal(r.request.hold_reason, "regulator_exam"); assert.equal(r.request.redaction_required, false);
  const five = h.engine.byCode("REGX_1024_38C2_SERVICING_FILE_5D")[0]!;
  assert.equal(five.status, "armed"); assert.equal(five.dueDate, D("2026-10-21")); assert.equal(toIso(five.dueAt!), h.at("2026-10-21", "23:59"));
  // the regulator production clock arms beside it (per request; policy default +10 servicer business days), and the automatic hold's 180-day review
  const reg = h.engine.byCode("SM_REGULATOR_RECORDS_REQUEST")[0]!; assert.equal(reg.dueDate, productionDue("regulator_state", D("2026-10-16"))); assert.equal(reg.dueDate, D("2026-10-30"));
  assert.equal(h.engine.byCode("SM_LEGAL_HOLD_REVIEW_180")[0]!.dueDate, D("2027-04-14"));
  // 23:59 ET on the 21st has not breached; the first instant of the 22nd has — sev-1 to security-records and the officer
  assert.deepEqual(h.engine.evaluate(h.at("2026-10-21", "23:58")), []);
  const breaches = h.engine.evaluate(h.at("2026-10-22", "00:00"));
  assert.deepEqual(breaches.map((b) => [b.def.code, b.severity, [...b.escalateTo]]), [["REGX_1024_38C2_SERVICING_FILE_5D", 1, ["security-records", "officer"]]]);
  assert.equal(h.events.all().filter((e) => e.type === "timer.breached").length, 1);
  // the bundle compiled on the 22nd through the bus tool, from the systems of record, satisfies the clock late; its compile time is the handler's own elapsed wall-clock — a caller's `compile_ms` / `started_ms` is ignored
  h.clock.set(h.at("2026-10-22", "10:00"));
  const rt = h.runtime(); seedLoan(rt, "L-1", { lossmit: true });
  const tool = TOOLS_19_1.find((t) => t.name === "records.compileServicingFile")!;
  const out = tool.handler({ loan_id: "L-1", requested_by: "RR-4", compile_ms: 999_999, started_ms: Date.now() - 6 * 60_000 }, h.commandCtx(AGENT), rt) as { compile_ms: number; within_target: boolean; sections: Record<string, unknown>; bundle_document_id: string; snapshot_id: string; transaction_schedule: { rows: { source: string; posted_at: string; joined: string[] }[]; closing: Record<string, bigint>; csv: string; pdf_pages: string[] }; data_field_report: { table: string; field: string; value: unknown; redacted: boolean }[]; security_instrument: { document: Record<string, unknown> | null; recorded_modifications: unknown[] }; personnel_notes: { source: string; text: string }[]; borrower_submitted: unknown[]; formats: string[] };
  assert.ok(out.compile_ms >= 0 && out.compile_ms < 60_000, `compile_ms ${out.compile_ms}`); assert.equal(out.within_target, true);
  assert.deepEqual(out.sections, { i_transactions: 3, ii_security_instrument: 1, ii_recorded_modifications: 1, iii_personnel_notes: 2, iv_data_fields: out.data_field_report.length, v_borrower_submitted: 1 });
  // (i) ledger entries joined to the payment/allocation and the disbursement/escrow line they name (folded, not double-counted), the suspense item on its own, ordered by posting timestamp with running balances
  assert.deepEqual(out.transaction_schedule.rows.map((x) => [x.source, x.posted_at.slice(0, 10)]), [["ledger_entry", "2026-01-15"], ["ledger_entry", "2026-09-01"], ["suspense_item", "2026-09-15"]]);
  assert.deepEqual(out.transaction_schedule.rows[1]!.joined, ["payment_id:pay-L-1-1", "allocation_id:pa-L-1-1"]);
  assert.deepEqual(out.transaction_schedule.closing, { principal_cents: 40_000n, interest_cents: 120_000n, escrow_cents: -260_000n, suspense_cents: 5_000n, fee_cents: 0n });
  assert.equal(out.transaction_schedule.csv.split("\n").length, 4); assert.match(out.transaction_schedule.csv.split("\n")[0]!, /^posted_at,source,ref,description,principal,interest,escrow,suspense,fees,running_principal/); assert.match(out.transaction_schedule.csv, /^2026-01-15T15:00:00\.000Z,ledger_entry,le-L-1-tax,county tax disbursement,0\.00,0\.00,-3000\.00,0\.00,0\.00,0\.00,0\.00,-3000\.00,0\.00,0\.00$/m); assert.match(out.transaction_schedule.csv, /,50\.00,0\.00,400\.00,1200\.00,-2600\.00,50\.00,0\.00$/m);
  assert.equal(out.transaction_schedule.pdf_pages.length, 1); assert.match(out.transaction_schedule.pdf_pages[0]!, /^Transaction schedule — loan L-1 — compiled 2026-10-22T14:00:00\.000Z/); assert.deepEqual(out.formats, ["json", "csv", "pdf"]);
  // (ii) the recorded security instrument and its recorded modification; (iii) the contact narrative and the agent's rationale; (iv) every column by name with the SSNs redacted and the current loan_terms version; (v) the borrower's loss-mitigation submission
  assert.equal(out.security_instrument.document?.id, "doc-si-L-1"); assert.equal(out.security_instrument.recorded_modifications.length, 1);
  assert.deepEqual(out.personnel_notes.map((n) => n.source), ["contact", "agent_decision"]);
  assert.deepEqual(out.data_field_report.filter((x) => x.redacted).map((x) => [x.table, x.field, x.value]), [["loans", "borrower_ssn", "***-**-6789"], ["borrowers[0]", "ssn", "***-**-4321"]]);
  assert.deepEqual(out.data_field_report.find((x) => x.table === "loan_terms" && x.field === "version")?.value, 2); assert.ok(out.data_field_report.some((x) => x.table === "escrow_lines[0]" && x.field === "amount_cents"));
  assert.equal(out.borrower_submitted.length, 1);
  // the bundle is a documents row (hashed, three formats) the snapshot row points at; the compile event closes the clock late
  assert.equal(rt.store.get("documents", out.bundle_document_id)?.data.record_type, "servicing_file_bundle"); assert.equal(rt.store.get("servicing_file_snapshots", out.snapshot_id)?.data.bundle_document_id, out.bundle_document_id);
  assert.equal(five.status, "satisfied_late"); assert.equal(h.events.all().at(-2)?.type, "servicing_file.compiled");
  assert.throws(() => tool.handler({ loan_id: "L-404" }, h.commandCtx(AGENT), rt), RangeError);   // a servicing file exists only for a loan in the system of record
});
test('19.1-T5: Given the monthly drill of 25 random loans, then all 25 bundles compile in ≤5 minutes each with sections (i)–(v) populated (or a documented "not applicable" for (v)), else CTL-REC-01 fails.', () => {
  // the drill: the schedule tick of the 1st arms the monthly row; 25 loans drawn at random from the portfolio; each compiled by the bus tool, which measures its own wall-clock
  const h = harness("2026-11-01T06:00:00.000Z"); const rt = h.runtime();
  const portfolio = Array.from({ length: 40 }, (_, k) => `L-${k + 1}`);
  for (const [k, id] of portfolio.entries()) seedLoan(rt, id, { lossmit: k % 2 === 0 });
  const ticks = emitScheduleTicks(D("2026-11-01"), h.events);
  assert.deepEqual(ticks.map((e) => [e.type, e.payload.cadence, e.payload.job]), [["schedule.tick", "daily", "retention-sweep"], ["schedule.tick", "monthly", "servicing-file-drill"], ["schedule.tick", "monthly", "disposal-run"]]);   // 2026-11-01 is a Sunday: also the disposal run's first-Sunday tick
  const t = h.engine.byCode("SM_SERVICING_FILE_DRILL_MONTHLY")[0]!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, D("2026-12-01"));
  const tool = TOOLS_19_1.find((x) => x.name === "records.compileServicingFile")!; assert.equal(tool.kind, "act");
  const compile = (loanId: string, d: { drill_id: string }) => tool.handler({ loan_id: loanId, requested_by: "drill", drill_id: d.drill_id }, h.commandCtx(AGENT, loanId), rt) as DrillCompile & { sections: Record<string, unknown>; v_not_applicable_reason: string | null; drill_index: number; drill_all_within_target: boolean };
  const run = runServicingFileDrill({ drill_id: "DRILL-2026-11", run_on: D("2026-11-01"), loan_ids: portfolio, compile, rng: lcg(7) }, h.ctx(AGENT));
  assert.equal(run.sample.length, 25); assert.equal(new Set(run.sample).size, 25); assert.ok(run.sample.every((id) => portfolio.includes(id))); assert.equal(run.population, 40);
  assert.deepEqual(run.result, { control: "CTL-REC-01", sample_size: 25, passed: true, failures: [], qc_finding: null, severity: null }); assert.equal(run.escalation_id, null);
  assert.ok(run.bundles.every((b) => b.within_target && b.compile_ms >= 0 && b.compile_ms < SERVICING_FILE_TARGET_MS && /^[0-9a-f]{64}$/.test(b.sha256) && b.gaps.length === 0));
  const bundles = run.bundles as (typeof compile extends (...a: never[]) => infer R ? R : never)[];
  const even = bundles.find((b) => Number(b.loan_id.slice(2)) % 2 === 0)!, odd = bundles.find((b) => Number(b.loan_id.slice(2)) % 2 === 1)!;
  assert.equal(even.sections.v_borrower_submitted, "not_applicable"); assert.match(even.v_not_applicable_reason!, /no §1024\.35 \/ §1024\.41 case/); assert.equal(odd.sections.v_borrower_submitted, 1);   // (v) present, or "not applicable" documented from the case register
  assert.deepEqual(bundles.map((b) => b.drill_index), Array.from({ length: 25 }, (_, k) => k + 1)); assert.ok(bundles.every((b) => b.drill_all_within_target));
  // the 25th compile of the drill, every compile within target, satisfies the recurring row — and re-arms it for the next month; the control test is recorded
  assert.equal(t.status, "satisfied"); assert.equal(h.engine.byCode("SM_SERVICING_FILE_DRILL_MONTHLY").length, 2); assert.equal(h.engine.byCode("SM_SERVICING_FILE_DRILL_MONTHLY")[1]!.dueDate, D("2026-12-01"));
  assert.equal(h.events.all().filter((e) => e.type === "servicing_file.compiled" && e.payload.requested_by === "drill").length, 25);
  assert.deepEqual(run.events.map((e) => [e.type, e.payload.control, e.payload.result]), [["control_test.completed", "CTL-REC-01", "pass"]]);
  const row = loadOverriddenRegistry().get("SM_SERVICING_FILE_DRILL_MONTHLY")!;
  assert.deepEqual(row.satisfiedPattern?.conditions.map((c) => [c.field, c.op, c.value]), [["requested_by", "=", "drill"], ["drill_index", "=", "25"], ["drill_all_within_target", "=", "true"]]); assert.equal(row.triggerPattern?.type, "schedule.tick");
  // a drill with one compile over target never satisfies the row: the tool reads the drill's prior compiles from the log, so the 25th bundle is tagged drill_all_within_target=false
  const slow = harness("2026-12-01T06:00:00.000Z"); const srt = slow.runtime(); for (const id of portfolio) seedLoan(srt, id);
  emitScheduleTicks(D("2026-12-01"), slow.events); const st = slow.engine.byCode("SM_SERVICING_FILE_DRILL_MONTHLY")[0]!;
  slow.events.append({ type: "servicing_file.compiled", loanId: "L-40", actor: AGENT, payload: { requested_by: "drill", drill_id: "DRILL-2026-12", within_target: false, compile_ms: 5 * 60_000 + 1, drill_index: 1, drill_all_within_target: false } });
  const sample = sampleDrillLoans(portfolio.slice(0, 39), 24, lcg(3));
  const tagged = sample.map((id) => tool.handler({ loan_id: id, requested_by: "drill", drill_id: "DRILL-2026-12" }, slow.commandCtx(AGENT, id), srt) as { drill_index: number; drill_all_within_target: boolean });
  assert.equal(tagged.at(-1)!.drill_index, 25); assert.equal(tagged.at(-1)!.drill_all_within_target, false); assert.equal(st.status, "armed");
  assert.deepEqual(slow.engine.evaluate(slow.at("2027-01-02", "00:00")).map((b) => [b.def.code, b.severity]), [["SM_SERVICING_FILE_DRILL_MONTHLY", 2]]);   // sev-2: the control test failed
  // the drill runner scores CTL-REC-01: one bundle over five minutes → fail, sev-2 escalation and an 18.1 QC finding; the pure evaluator says the same
  const late = runServicingFileDrill({ drill_id: "DRILL-x", run_on: D("2026-12-01"), loan_ids: portfolio, rng: lcg(11), compile: (loanId, d) => (d.index === 25 ? { loan_id: loanId, compile_ms: 5 * 60_000 + 1, within_target: false, gaps: [], sha256: "f".repeat(64) } : { loan_id: loanId, compile_ms: 4 * 60_000, within_target: true, gaps: [], sha256: "f".repeat(64) }) }, slow.ctx(AGENT));
  assert.equal(late.result.passed, false); assert.equal(late.result.severity, "sev2"); assert.equal(late.result.qc_finding, "18.1"); assert.deepEqual(late.result.failures, [{ loan_id: late.sample[24]!, reasons: ["compile 300001 ms > 5 minutes"] }]);
  assert.deepEqual(late.events.map((e) => [e.type, e.payload.result ?? e.payload.process]), [["control_test.completed", "fail"], ["qc_finding.opened", "18.1"]]); assert.equal(slow.escalations.opened.find((e) => e.id === late.escalation_id)?.kind, "sev2");
  const pure = Array.from({ length: 25 }, (_, k) => pureBundle(k));
  assert.deepEqual(pure[1]!.sections, { i_transactions: 1, ii_security_instrument: 1, ii_recorded_modifications: 0, iii_personnel_notes: 1, iv_data_fields: 3, v_borrower_submitted: 1 }); assert.equal(pure[1]!.data_field_report.find((x) => x.field === "borrower_ssn")?.value, "***-**-6789");   // (iv) lists fields by name; the SSN is redacted
  assert.equal(servicingFileDrill(pure).passed, true);
  assert.deepEqual(servicingFileDrill([...pure.slice(0, 24), pureBundle(24, { compile_ms: 5 * 60_000 + 1 })]).failures, [{ loan_id: "L-24", reasons: ["compile 300001 ms > 5 minutes"] }]);
  // (ii) is mandatory; (v) must be present or documented not applicable; 25 bundles are required
  assert.match(servicingFileDrill([...pure.slice(0, 24), pureBundle(24, { security_instrument: null })]).failures[0]!.reasons[0]!, /\(ii\) security instrument missing/);
  assert.match(servicingFileDrill([...pure.slice(0, 24), pureBundle(24, { documents: [], borrower_submitted_not_applicable_reason: null })]).failures[0]!.reasons[0]!, /\(v\) borrower-submitted documents neither present nor documented/);
  assert.deepEqual(servicingFileDrill(pure.slice(0, 24)).failures, [{ loan_id: "*", reasons: ["only 24 of 25 bundles compiled"] }]);
  const nosi = h.runtime(); seedLoan(nosi, "L-nosi", { security_instrument: false });
  assert.match((tool.handler({ loan_id: "L-nosi" }, h.commandCtx(AGENT, "L-nosi"), nosi) as { gaps: string[] }).gaps[0]!, /\(ii\) security instrument missing → documents\.gap/);
  assert.equal(DRILL_SAMPLE_SIZE, 25); assert.throws(() => sampleDrillLoans([], 25), RangeError);
});
test('19.1-T6: Given a Fannie Mae written request received 2026-11-19 stating "within 10 business days," then the timer is due 2026-12-04 (Thanksgiving Nov 26 excluded) and a delivery 2026-12-07 breaches.', () => {
  assert.equal(fnmaRecordsRequestDue(D("2026-11-19"), 10), D("2026-12-04"));   // 20, 23, 24, 25, 27, 30, Dec 1, 2, 3, 4 — Thanksgiving Nov 26 is not a fannie_et business day
  assert.equal(productionDue("fannie_mae", D("2026-11-19"), 10), D("2026-12-04")); assert.equal(productionDue("fannie_mae", D("2026-11-19")), D("2026-12-04"));   // the policy default is the same 10 days
  const h = harness("2026-11-19T15:00:00.000Z");
  const r = intakeRecordsRequest({ id: "RR-6", requester_type: "fannie_mae", requester_ref: "Fannie Mae account team (MORA)", received_at: h.clock.now(), format: "full_loan_file", loan_ids: ["L-1"], scope_description: "individual loan file", stated_business_days: 10, authority_confidence: 0.99 }, h.ctx(AGENT));
  assert.equal(r.routed_to, "19.1_production"); if (r.routed_to !== "19.1_production") return;
  assert.equal(r.request.due_on, D("2026-12-04")); assert.equal(r.request.hold_reason, "fannie_mae_request"); assert.deepEqual(r.request.production_requires, ["officer_sign_off"]); assert.equal(r.request.redaction_required, false);
  assert.equal(h.events.all().find((e) => e.type === "records.request.received")?.payload.delivery_due_stated, "2026-12-04");
  const t = h.engine.byCode("FNMA_A2_4_1_02_RECORDS_DELIVERY_REQUESTED")[0]!;
  assert.equal(t.status, "armed"); assert.equal(t.dueDate, D("2026-12-04")); assert.equal(toIso(t.dueAt!), h.at("2026-12-04", "23:59"));
  assert.equal(h.engine.byCode("SM_LEGAL_HOLD_REVIEW_180")[0]!.dueDate, D("2027-05-18"));
  // delivered on the 7th: the deadline breached on the 5th (sev-1 → officer; partner notified), the delivery closes it late
  assert.deepEqual(h.engine.evaluate(h.at("2026-12-04", "23:58")).length, 0);   // due 23:59 ET on the 4th
  const breaches = h.engine.evaluate(h.at("2026-12-05", "00:00"));
  assert.deepEqual(breaches.map((b) => [b.def.code, b.severity, [...b.escalateTo]]), [["FNMA_A2_4_1_02_RECORDS_DELIVERY_REQUESTED", 1, ["officer"]]]);
  h.clock.set(h.at("2026-12-07", "11:00"));
  const delivery = { delivered_via: "fnma_file_transfer_portal", manifest_sha256: "b".repeat(64) };
  // the officer's sign-off is an event by a human officer — the agent cannot record it, and no caller flag stands in for it
  const refused = deliverProduction(r.request, delivery, h.ctx(OFFICER), h.events.all());
  assert.equal(refused.delivered, false); assert.equal(refused.decision.code, "OFFICER_SIGN_OFF_REQUIRED"); assert.deepEqual(refused.decision.requires, ["officer_sign_off"]); assert.equal(t.status, "breached");
  assert.equal(approveProduction(r.request, "officer_sign_off", { rationale: "MORA request verified against the account-team roster" }, h.ctx(AGENT)).code, "APPROVAL_NEEDS_HUMAN_ROLE");
  assert.equal(approveProduction(r.request, "officer_sign_off", { rationale: "x" }, h.ctx(ATTORNEY)).code, "APPROVAL_NEEDS_HUMAN_ROLE");
  const rails = TOOLS_19_1[0]!.guardrails!;
  for (const who of [AGENT, OPERATOR, OFFICER]) assert.deepEqual(rails.filter((g) => g.refuse({ op: "deliver", request_id: "RR-6" }, h.commandCtx(who)) !== undefined).map((g) => g.code), ["PRODUCTION_APPROVAL_REQUIRED"]);
  const signed = approveProduction(r.request, "officer_sign_off", { rationale: "MORA request verified against the account-team roster; scope one loan" }, h.ctx(OFFICER));
  assert.equal(signed.allowed, true); assert.equal(signed.event?.type, "records.request.approved"); assert.equal(signed.event?.payload.kind, "officer_sign_off");
  for (const who of [AGENT, OPERATOR, OFFICER]) assert.deepEqual(rails.filter((g) => g.refuse({ op: "deliver", request_id: "RR-6" }, h.commandCtx(who)) !== undefined), []);
  const delivered = deliverProduction(r.request, delivery, h.ctx(AGENT), h.events.all());
  assert.equal(delivered.delivered, true); assert.equal(delivered.request.status, "delivered"); assert.deepEqual(delivered.event?.payload.approvals, { attorney_approved: false, officer_signed_off: true, officer_confirmed: false, authority_confidence: 0.99 });
  assert.equal(t.status, "satisfied_late"); assert.equal(t.satisfiedAt, h.at("2026-12-07", "11:00"));
});
test("19.1-T7: Given a legal hold placed on a loan at 2030-11-01 and an object eligible 2031-03-15, then the object is `held`, appears in no disposal run, and is disposed in the first run after release (2032-02-01 → run 2032-03-01).", () => {
  const h = harness("2030-11-01T14:00:00.000Z");
  let objects = sweep([object("ro-7", "L-7", PAID_TX), object("ro-8", "L-8", PAID_TX)], D("2030-11-01"));
  assert.equal(objects[0]!.eligible_for_disposal_at, D("2031-03-15")); assert.equal(objects[0]!.status, "retention_running"); assert.equal(objects[0]!.effective_class_code, "life_of_loan_plus_4y");
  const placed = placeHold(objects, { id: "LH-7", scope: "loan", scope_ref: "L-7", reason: "litigation", matter_ref: "Index No. 700/2030" }, h.ctx(ATTORNEY));
  objects = placed.objects;
  assert.equal(objects[0]!.status, "held"); assert.equal(objects[0]!.hold_count, 1); assert.deepEqual(objects[0]!.hold_ids, ["LH-7"]); assert.equal(objects[1]!.hold_count, 0);   // scope: the loan, not its neighbour
  assert.equal(placed.event.type, "legal_hold.placed"); assert.equal(placed.event.loanId, "L-7"); assert.equal(h.engine.byCode("SM_LEGAL_HOLD_REVIEW_180")[0]!.dueDate, D("2031-04-30"));
  assert.equal(retention({ ...PAID_LOAN, hold_count: 1 }, D("2031-06-01")).status, "held"); assert.equal(disposalAllowed(retention({ ...PAID_LOAN, hold_count: 1 }, D("2031-06-01")), true, true).reason, "legal_hold");
  assert.equal(sweep(objects, D("2031-06-01"))[0]!.status, "held"); assert.deepEqual(sweep(objects, D("2031-06-01"))[0]!.gates.map((g) => g.reason), ["legal_hold", "legal_hold"]);   // every gate of a held object is closed by the hold
  // the 180-day review is a recorded act that satisfies and re-arms the clock — and never releases anything
  h.clock.set("2031-04-15T15:00:00.000Z");
  const review = reviewLegalHold(placed.hold, { outcome: "continue", matter_status: "litigation pending; discovery open" }, h.ctx(AGENT));
  assert.equal(review.event.type, "legal_hold.reviewed"); assert.equal(review.event.loanId, "L-7"); assert.equal(review.hold.next_review_at, "2031-10-12T15:00:00.000Z"); assert.equal(review.hold.released_at, null);
  assert.deepEqual(h.engine.byCode("SM_LEGAL_HOLD_REVIEW_180").map((t) => [t.status, t.dueDate]), [["satisfied", D("2031-04-30")], ["armed", D("2031-10-12")]]);
  assert.equal(sweep(objects, D("2031-06-01"))[0]!.status, "held");
  // it appears in no disposal run while held: every first-Sunday run from eligibility to the release excludes it (and disposes its unheld neighbour in the first one)
  let run = D("2031-04-06");
  while (run < D("2032-02-01")) {
    const plan = planDisposalRun({ run_on: run, class_code: "life_of_loan_plus_4y", objects, worm: wormIntegrityCheck(objects.map(wormOf)) });
    assert.ok(!plan.object_ids.includes("ro-7"), `held object planned in run ${run}`); assert.deepEqual(plan.excluded.filter((x) => x.object_id === "ro-7"), [{ object_id: "ro-7", reason: "legal_hold" }]);
    if (run === D("2031-04-06")) { assert.deepEqual(plan.object_ids, ["ro-8"]); assert.deepEqual(plan.gates_checked, ["FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION", "REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER"]); assert.equal(plan.method, "crypto_shred"); objects = objects.map((o) => (o.id === "ro-8" ? { ...o, status: "disposed", disposed_at: `${run}T07:00:00.000Z`, disposal_run_id: plan.id } : o)); }
    run = nextDisposalRun(run);
  }
  // release 2032-02-01 by officer + attorney: the sweep re-evaluates on release and the object is eligible again
  h.clock.set("2032-02-01T15:00:00.000Z");
  const rel = releaseHold(objects, review.hold, ["officer", "attorney"], h.ctx(OFFICER));
  assert.equal(rel.allowed, true); objects = rel.objects; assert.equal(rel.event?.type, "legal_hold.released");
  assert.equal(objects[0]!.status, "eligible"); assert.equal(objects[0]!.hold_count, 0); assert.equal(objects[0]!.eligible_for_disposal_at, D("2031-03-15"));
  // first run after release: the first Sunday of the following month is 2032-03-07 — the spec's 2032-03-01 is a Monday and cannot be a "first Sunday" run (docs/AUDIT-NOTES.md, 19.1 rule 3)
  const firstRun = nextDisposalRun(D("2032-02-01"));
  assert.equal(firstRun, D("2032-03-07")); assert.equal(dayOfWeek(firstRun), 0); assert.equal(dayOfWeek(D("2032-03-01")), 1);
  h.clock.set("2032-03-07T07:00:00.000Z");
  const ticks = emitScheduleTicks(firstRun, h.events); assert.ok(ticks.some((e) => e.type === "schedule.tick" && e.payload.job === "disposal-run" && e.payload.ordinal === 1));
  const monthly = h.engine.byCode("SM_DISPOSAL_RUN_MONTHLY")[0]!; assert.equal(monthly.status, "armed"); assert.equal(monthly.dueDate, D("2032-04-07"));
  let plan = planDisposalRun({ run_on: firstRun, class_code: "life_of_loan_plus_4y", objects, worm: wormIntegrityCheck(objects.map(wormOf)) });
  assert.deepEqual(plan.object_ids, ["ro-7"]); assert.equal(plan.status, "awaiting_attestation");
  wormIntegrityJob(objects.filter((o) => o.status !== "disposed").map(wormOf), h.ctx(SYSTEM), { run_id: plan.id });
  const att = attestDisposalRun(plan, h.ctx(OFFICER)); assert.equal(att.allowed, true); plan = att.run;
  const exec = executeDisposalRun(plan, objects, h.ctx(AGENT), h.events.all());
  assert.equal(exec.executed, true); assert.equal(exec.run.status, "executed");
  const disposed = exec.objects.find((o) => o.id === "ro-7")!; assert.equal(disposed.status, "disposed"); assert.equal(disposed.disposal_run_id, "DR-2032-03-07-life_of_loan_plus_4y"); assert.equal(disposed.disposed_at, "2032-03-07T07:00:00.000Z");
  assert.deepEqual(exec.events.map((e) => e.type), ["record_object.disposed", "disposal_run.executed"]); assert.equal(exec.events[0]!.loanId, "L-7"); assert.equal(exec.events[0]!.payload.timer_code, "FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION");
  assert.deepEqual(exec.events[0]!.payload.gates_checked, ["FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION", "REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER"]); assert.equal(exec.events[0]!.payload.effective_class_code, "life_of_loan_plus_4y");
  assert.equal(monthly.status, "satisfied");   // `disposal_run.executed` closes the monthly schedule row
  assert.equal(sweep(exec.objects, D("2033-01-01")).find((o) => o.id === "ro-7")!.status, "disposed");   // terminal
});
test("19.1-T8: Given a hold release request by an `officer` alone, then the release is rejected (needs `attorney` co-approval).", () => {
  assert.equal(holdReleaseAllowed(["officer"]), false); assert.equal(holdReleaseAllowed(["attorney"]), false); assert.ok(holdReleaseAllowed(["officer", "attorney"]));
  const h = harness("2031-01-10T15:00:00.000Z");
  const placed = placeHold([object("ro-8", "L-8", PAID_TX)], { id: "LH-8", scope: "loan", scope_ref: "L-8", reason: "regulator_exam", matter_ref: "NYDFS exam 2031" }, h.ctx(AGENT));
  const alone = releaseHold(placed.objects, placed.hold, ["officer"], h.ctx(OFFICER));
  assert.equal(alone.allowed, false); assert.equal(alone.code, "HOLD_RELEASE_NEEDS_OFFICER_AND_ATTORNEY"); assert.equal(alone.event, null); assert.equal(alone.objects[0]!.status, "held"); assert.equal(alone.hold.released_at, null);
  // never automatic: the agent is refused even with both approvals recorded on its input; a review recommending release is not a release; two humans acting jointly succeed
  assert.equal(releaseHold(placed.objects, placed.hold, ["officer", "attorney"], h.ctx(AGENT)).code, "HOLD_RELEASE_NEEDS_OFFICER_AND_ATTORNEY");
  const rec = reviewLegalHold(placed.hold, { outcome: "release_recommended", matter_status: "exam closed 2031-01-05" }, h.ctx(OFFICER)); assert.equal(rec.hold.released_at, null); assert.equal(rec.event.payload.release_requires, "officer_and_attorney");
  assert.equal(disposalGuards({ op: "release_hold", actor: OFFICER, disposal_run_id: null, attestation: null, worm: null, release_approvals: ["officer"] }).code, "HOLD_RELEASE_NEEDS_OFFICER_AND_ATTORNEY");
  assert.equal(disposalGuards({ op: "release_hold", actor: AGENT, disposal_run_id: null, attestation: null, worm: null, release_approvals: ["officer", "attorney"] }).code, "HOLD_RELEASE_NEEDS_OFFICER_AND_ATTORNEY");
  const joint = releaseHold(placed.objects, rec.hold, ["officer", "attorney"], h.ctx(ATTORNEY));
  assert.equal(joint.allowed, true); assert.deepEqual(joint.hold.release_approvals, ["officer", "attorney"]); assert.equal(joint.objects[0]!.hold_count, 0); assert.equal(joint.event?.type, "legal_hold.released");
  assert.equal(h.events.all().filter((e) => e.type === "legal_hold.released").length, 1);
  assert.throws(() => reviewLegalHold(joint.hold, { outcome: "continue", matter_status: "x" }, h.ctx(AGENT)), RangeError);   // a released hold is not reviewed
  // the tool guardrail refuses a release through any 19.1 tool, for every actor
  const rail = TOOLS_19_1[0]!.guardrails!.find((g) => g.code === "NO_AUTO_HOLD_RELEASE")!;
  for (const who of [AGENT, OFFICER, ATTORNEY]) assert.ok(rail.refuse({ op: "release_hold" }, h.commandCtx(who)));
});
test("19.1-T9: Given a Reg B decision notified 2027-01-20 and an enforcement notice received 2029-02-01 (before 2029-02-20), then the Reg B gate is extended until `investigation.closed`.", () => {
  const g = regBRetentionGate({ today: D("2029-03-01"), notified_on: D("2027-01-20"), enforcement_notice_received_on: D("2029-02-01") });
  assert.equal(g.base_opens_on, D("2029-02-20")); assert.equal(g.extended_until, "investigation.closed"); assert.equal(g.opens_on, null); assert.equal(g.open, false); assert.equal(g.reason, "enforcement_open_until_investigation_closed");
  // without an enforcement notice the gate opens 25 months after notification
  const plain = regBRetentionGate({ today: D("2029-02-20"), notified_on: D("2027-01-20") }); assert.equal(plain.open, true); assert.equal(plain.opens_on, D("2029-02-20"));
  assert.equal(regBRetentionGate({ today: D("2029-02-19"), notified_on: D("2027-01-20") }).open, false);
  // final disposition: investigation closed 2030-06-30 → the gate opens on that date
  const closed = regBRetentionGate({ today: D("2030-06-30"), notified_on: D("2027-01-20"), enforcement_notice_received_on: D("2029-02-01"), investigation_closed_on: D("2030-06-30") });
  assert.equal(closed.open, true); assert.equal(closed.opens_on, D("2030-06-30")); assert.equal(closed.extended_until, null);
  // §1002.12(b)(4) binds "beyond 25 months": actual notice received after 2029-02-20, while the record still exists, re-closes the gate until final disposition
  const late = regBRetentionGate({ today: D("2029-03-01"), notified_on: D("2027-01-20"), enforcement_notice_received_on: D("2029-02-25") });
  assert.equal(late.open, false); assert.equal(late.extended_until, "investigation.closed");
  assert.equal(regBRetentionGate({ today: D("2029-03-01"), notified_on: D("2027-01-20"), enforcement_notice_received_on: D("2029-02-25"), investigation_closed_on: D("2029-02-28") }).opens_on, D("2029-02-28"));
  // held objects stay closed whatever the Reg B arithmetic says
  assert.equal(regBRetentionGate({ today: D("2029-03-01"), notified_on: D("2027-01-20"), hold_count: 1 }).reason, "legal_hold");
  // the disposal path honours the extension: the loss-mitigation file of a loan paid off 2027-03-15 is not swept eligible and is excluded from every run while the proceeding is open, and opens on the closing date once the matter is disposed of
  const facts: ObjectFacts = { ...PAID_TX, notified_on: D("2027-01-20"), enforcement_notice_received_on: D("2029-02-01") };
  const open = sweep([object("ro-lm", "L-9", facts, "lossmit_document_borrower")], D("2031-06-01"))[0]!;
  assert.equal(open.status, "retention_running"); assert.equal(open.eligible_for_disposal_at, null); assert.equal(open.gates.find((x) => x.timer_code === "REGB_1002_12B_RETENTION_25M")?.reason, "enforcement_open_until_investigation_closed");
  const plan = planDisposalRun({ run_on: D("2031-06-01"), class_code: "life_of_loan_plus_4y", objects: [open], worm: wormIntegrityCheck([wormOf(open)]) });
  assert.deepEqual(plan.object_ids, []); assert.deepEqual(plan.excluded, [{ object_id: "ro-lm", reason: "REGB_1002_12B_RETENTION_25M: enforcement_open_until_investigation_closed" }]);
  const done = sweep([object("ro-lm", "L-9", { ...facts, investigation_closed_on: D("2030-06-30") }, "lossmit_document_borrower")], D("2031-06-01"))[0]!;
  assert.equal(done.status, "eligible"); assert.equal(done.eligible_for_disposal_at, D("2031-03-15")); assert.equal(gateMap(done).REGB_1002_12B_RETENTION_25M, D("2030-06-30"));
  const longer = sweep([object("ro-lm", "L-9", { ...facts, investigation_closed_on: D("2032-01-10") }, "lossmit_document_borrower")], D("2031-06-01"))[0]!;
  assert.equal(longer.status, "retention_running"); assert.equal(longer.eligible_for_disposal_at, D("2032-01-10")); assert.equal(longer.effective_class_code, "regb_1002_12b_25m");   // the disposition, later than the Fannie Mae gate, becomes the effective class
  // the same for an object whose other class runs longer than the loan's 4 years (a 1098 due 2030-01-31 → IRS 4 years → 2034-01-31): the run excludes it with that gate's reason
  const tax = sweep([object("ro-t", "L-9", { ...PAID_TX, form_due_date: D("2030-01-31") }, "tax_form_1098")], D("2031-06-01"))[0]!;
  assert.equal(tax.status, "retention_running"); assert.equal(tax.eligible_for_disposal_at, D("2034-01-31")); assert.equal(tax.effective_class_code, "tax_4y");
  assert.deepEqual(planDisposalRun({ run_on: D("2031-06-01"), class_code: "life_of_loan_plus_4y", objects: [tax], worm: wormIntegrityCheck([wormOf(tax)]) }).excluded, [{ object_id: "ro-t", reason: "IRS_INFO_RETURN_RETENTION_4Y: retention runs to 2034-01-31" }]);
  // the corrected loan-level calculator: an open enforcement proceeding leaves no effective date (never an earlier one); the shared calculator's `enforcement_open` flag reads the same way
  const loan: RetentionInput = { ...PAID_LOAN, reg_b_notified_on: D("2027-01-20"), enforcement_open: true };
  const ext = loanRetention(loan, D("2031-06-01")); assert.equal(ext.reg_b, null); assert.equal(ext.reg_b_extended_until, "investigation.closed"); assert.equal(ext.eligible_for_disposal_at, null); assert.equal(ext.status, "retained");
  const fin = loanRetention({ ...loan, investigation_closed_on: D("2030-06-30") }, D("2031-06-01")); assert.equal(fin.reg_b, D("2030-06-30")); assert.equal(fin.eligible_for_disposal_at, D("2031-03-15")); assert.equal(fin.status, "eligible");
  // the timer row is evaluator-backed and the evaluator reads the same facts
  const ev = EVALUATORS_19_1["19.1.regBRetentionGateOpen"]!;
  assert.equal(ev({ today: "2029-03-01", notified_on: "2027-01-20", enforcement_notice_received_on: "2029-02-01", hold_count: 0 }).open, false);
  assert.equal(ev({ today: "2029-03-01", notified_on: "2027-01-20", enforcement_notice_received_on: "2029-02-01", hold_count: 0 }).reason, "enforcement_open_until_investigation_closed");
  assert.equal(ev({ today: "2029-03-01", notified_on: "2027-01-20", hold_count: 0 }).open, true);
  assert.match(ev({ today: "2029-03-01", notified_on: "2027-01-20" }).reason!, /hold_count fact required/);
  const row = loadOverriddenRegistry().unique().find((t) => t.code === "REGB_1002_12B_RETENTION_25M")!;
  assert.equal(row.offset, "evaluator:19.1.regBRetentionGateOpen"); assert.equal(row.triggerPattern?.type, "lossmit.decision.notified");
  // the anchor event itself: the denial notified 2027-01-20 is recorded through the lifecycle engine — the row arms for the loan (a gate, no due instant) and `notified_on` lands on the loan's loss-mitigation file, whose Reg B gate then reads 2029-02-20
  const h = harness("2027-01-20T16:00:00.000Z");
  const before = [object("ro-lm2", "L-9", PAID_TX, "lossmit_document_borrower"), object("ro-ct2", "L-9", PAID_TX, "contact_note")];
  const notified = recordLossmitDecisionNotified(before, { loan_id: "L-9", case_id: "LM-9", decision: "denied", notified_on: D("2027-01-20"), notice_id: "NTC-LM-DENIAL-9" }, h.ctx(AGENT));
  assert.equal(notified.event.type, "lossmit.decision.notified"); assert.equal(notified.event.loanId, "L-9"); assert.deepEqual([notified.event.payload.decision, notified.event.payload.notified_on, notified.event.payload.timer_code], ["denied", D("2027-01-20"), "REGB_1002_12B_RETENTION_25M"]);
  assert.ok(eventMatches(row.triggerPattern!, notified.event));
  const armed = h.engine.byCode("REGB_1002_12B_RETENTION_25M"); assert.equal(armed.length, 1); assert.deepEqual([armed[0]!.status, armed[0]!.loanId, armed[0]!.anchorDate, armed[0]!.dueAt, armed[0]!.note], ["armed", "L-9", D("2027-01-20"), undefined, "evaluator:19.1.regBRetentionGateOpen"]);
  assert.deepEqual(h.engine.evaluate("2040-01-01T00:00:00.000Z"), []);
  assert.equal(gateMap(sweep(notified.objects, D("2029-02-19"))[0]!).REGB_1002_12B_RETENTION_25M, D("2029-02-20")); assert.equal(sweep(notified.objects, D("2029-02-19"))[0]!.gates.find((g) => g.timer_code === "REGB_1002_12B_RETENTION_25M")!.open, false);
  assert.equal(sweep(notified.objects, D("2029-02-20"))[0]!.gates.find((g) => g.timer_code === "REGB_1002_12B_RETENTION_25M")!.open, true);
  assert.ok(!sweep(notified.objects, D("2029-02-19"))[1]!.gates.some((g) => g.timer_code === "REGB_1002_12B_RETENTION_25M"));   // the contact note of the same loan carries the anchor but not the class
  assert.throws(() => recordLossmitDecisionNotified(before, { loan_id: "L-9", case_id: "LM-9", decision: "pending" as "denied", notified_on: D("2027-01-20"), notice_id: "n" }, h.ctx(AGENT)), RangeError);
  assert.throws(() => recordLossmitDecisionNotified(before, { loan_id: "L-9", case_id: "LM-9", decision: "denied", notified_on: "2027-1-20" as unknown as ReturnType<typeof D>, notice_id: "n" }, h.ctx(AGENT)), RangeError);
});
test("19.1-T10: Given prospect contact data last used 2026-10-01 with no loan linkage, then `FTC_314_4C6_DISPOSAL_2Y_POST_LAST_USE` is due 2028-10-01 and breaches sev-2 if neither disposed nor excepted.", () => {
  assert.equal(ftcDisposalDue(D("2026-10-01"), false), D("2028-10-01")); assert.equal(ftcDisposalDue(D("2026-10-01"), true), null);   // rule 8: loan-linked information is "otherwise required to be retained"
  assert.deepEqual(classifyRecord("prospect_contact").timer_codes, ["FTC_314_4C6_DISPOSAL_2Y_POST_LAST_USE"]); assert.equal(classifyRecord("prospect_contact").fnma_property, false);
  // the last use is recorded through the lifecycle engine: the prospect's contact data is enrolled as a `prospect_contact` object anchored on the use, and the event arms the two-year deadline for the contact
  const arm = (id: string) => { const h = harness("2026-10-01T15:00:00.000Z"); const r = recordContactLastUse([], { contact_id: id, last_used_on: D("2026-10-01"), loan_linked: false, use: "rate-quote follow-up e-mail" }, h.ctx(AGENT)); return { h, r, t: h.engine.byCode("FTC_314_4C6_DISPOSAL_2Y_POST_LAST_USE")[0]! }; };
  // neither disposed nor excepted → sev-2 to security-records (listed in the 19.2 board report)
  const a = arm("C-1");
  assert.equal(a.r.event.type, "contact.last_use"); assert.deepEqual([a.r.event.payload.loan_linked, a.r.event.payload.last_used_on, a.r.event.payload.timer_code], [false, D("2026-10-01"), "FTC_314_4C6_DISPOSAL_2Y_POST_LAST_USE"]); assert.ok(eventMatches(a.h.registry.get("FTC_314_4C6_DISPOSAL_2Y_POST_LAST_USE")!.triggerPattern!, a.r.event));
  assert.equal(a.r.object.record_type, "prospect_contact"); assert.equal(a.r.object.status, "retention_running"); assert.equal(a.r.object.eligible_for_disposal_at, D("2028-10-01")); assert.deepEqual(a.r.objects, [a.r.object]);
  assert.equal(a.t.status, "armed"); assert.equal(a.t.dueDate, D("2028-10-01")); assert.deepEqual(a.t.subject, { kind: "contact", id: "C-1" });
  // loan-linked information never carries the FTC clock (rule 8: "otherwise required to be retained")
  assert.throws(() => recordContactLastUse([], { contact_id: "C-loan", last_used_on: D("2026-10-01"), loan_linked: true, use: "payment reminder" }, a.h.ctx(AGENT)), /otherwise required to be retained/);
  // a later use of the same information moves the anchor: the clock the earlier use armed is superseded (cancelled with the reason) and the two years run from the last use; never backwards; a disposed object is terminal
  const d = arm("C-4"); d.h.clock.set("2026-12-01T15:00:00.000Z");
  const again = recordContactLastUse(d.r.objects, { contact_id: "C-4", last_used_on: D("2026-12-01"), loan_linked: false, use: "second follow-up" }, d.h.ctx(AGENT), d.h.engine);
  assert.equal(again.objects.length, 1); assert.equal(again.object.eligible_for_disposal_at, D("2028-12-01")); assert.deepEqual(again.superseded_timer_ids, [d.t.id]); assert.equal(d.t.status, "cancelled"); assert.match(d.t.cancelledReason!, /^superseded: information used again 2026-12-01/);
  assert.deepEqual(d.h.engine.byCode("FTC_314_4C6_DISPOSAL_2Y_POST_LAST_USE").map((t) => [t.status, t.dueDate]), [["cancelled", D("2028-10-01")], ["armed", D("2028-12-01")]]);
  assert.deepEqual(d.h.engine.evaluate(d.h.at("2028-10-02", "00:00")), []); assert.deepEqual(d.h.engine.evaluate(d.h.at("2028-12-02", "00:00")).map((b) => [b.def.code, b.severity]), [["FTC_314_4C6_DISPOSAL_2Y_POST_LAST_USE", 2]]);
  assert.throws(() => recordContactLastUse(again.objects, { contact_id: "C-4", last_used_on: D("2026-11-01"), loan_linked: false, use: "x" }, d.h.ctx(AGENT), d.h.engine), /precedes the last use on file/);
  assert.throws(() => recordContactLastUse([{ ...again.object, status: "disposed", disposed_at: "2028-09-03T07:00:00.000Z" }], { contact_id: "C-4", last_used_on: D("2028-10-01"), loan_linked: false, use: "x" }, d.h.ctx(AGENT)), /disposed is terminal/);
  assert.deepEqual(a.h.engine.evaluate(a.h.at("2028-10-01", "23:58")), []);   // due 23:59 ET on 2028-10-01
  assert.deepEqual(a.h.engine.evaluate(a.h.at("2028-10-02", "00:00")).map((b) => [b.def.code, b.severity, [...b.escalateTo]]), [["FTC_314_4C6_DISPOSAL_2Y_POST_LAST_USE", 2, ["security-records"]]]);
  // the object's own class: eligible two years after last use, disposed in the 2028-09-03 run → satisfied
  const p = sweep([object("ro-C-2", null, { last_use_on: D("2026-10-01") }, "prospect_contact", "a".repeat(64), null)], D("2028-09-03"))[0]!;
  assert.equal(p.status, "retention_running"); assert.equal(p.eligible_for_disposal_at, D("2028-10-01")); assert.equal(p.effective_class_code, "ftc_314_disposal_2y_post_last_use");
  assert.equal(sweep([p], D("2028-10-01"))[0]!.status, "eligible");
  const b = arm("C-2"); b.h.clock.set("2028-09-03T07:00:00.000Z");
  b.h.events.append({ type: "record_object.disposed", aggregate: { kind: "contact", id: "C-2" }, actor: SYSTEM, payload: { object_id: "ro-C-2", class_code: "ftc_314_disposal_2y_post_last_use", disposal_run_id: "DR-2028-09-03-ftc_314_disposal_2y_post_last_use" } });
  assert.equal(b.t.status, "satisfied"); assert.deepEqual(b.h.engine.evaluate(b.h.at("2028-10-02", "00:00")), []);
  // documented exception (legal_requirement / business_need / infeasible) → the exception command records it and cancels the clock with the documentation as its reason; nothing else excepts it
  const c = arm("C-3"); c.h.clock.set("2027-02-01T15:00:00.000Z");
  const ex = exceptFtcDisposal({ subject: { kind: "contact", id: "C-3" }, object_id: "ro-C-3", kind: "legal_requirement", detail: "prospect became a borrower 2027-02-01; record now loan-linked (Reg X / A2-4.1-02)" }, c.h.ctx(AGENT), c.h.engine);
  assert.equal(ex.event.type, "record_object.disposal_excepted"); assert.deepEqual(ex.event.payload.kind, "legal_requirement"); assert.deepEqual(ex.cancelled_timer_ids, [c.t.id]);
  assert.equal(c.t.status, "cancelled"); assert.match(c.t.cancelledReason!, /^documented_exception:legal_requirement: prospect became a borrower/); assert.deepEqual(c.h.engine.evaluate(c.h.at("2028-10-02", "00:00")), []);
  assert.equal(c.h.events.all().at(-1)?.type, "timer.cancelled"); assert.equal(c.h.events.all().at(-1)?.payload.reason, ex.reason);
  assert.throws(() => ftcExceptionReason("convenience" as "infeasible", "x"), RangeError); assert.throws(() => ftcExceptionReason("business_need", "  "), RangeError);
  assert.throws(() => exceptFtcDisposal({ subject: { kind: "contact", id: "C-3" }, object_id: "ro-C-3", kind: "business_need", detail: " " }, c.h.ctx(AGENT), c.h.engine), RangeError);
  assert.equal(retentionClass("ftc_314_disposal_2y_post_last_use").may_shorten, true); assert.equal(retentionClass("ftc_314_disposal_2y_post_last_use").disposal_method, "object_delete");
});
test("19.1-T11: Given a Feb 29, 2028 liquidation, then the 4-year anchor resolves to 2032-03-01.", () => {
  assert.equal(anniversary(D("2028-02-29"), 4), D("2032-03-01"));
  assert.equal(gateOpensOn(D("2028-02-29"), retentionClass("life_of_loan_plus_4y")), D("2032-03-01"));
  assert.notEqual(addYears(D("2028-02-29"), 4), D("2032-03-01"));   // plain calendar arithmetic would land on 2032-02-29 (a leap day); rule 1 rolls Feb 29 anchors to Mar 1
  const gate = fnmaRetentionGate({ today: D("2032-02-29"), liquidated_on: D("2028-02-29"), transferred_out_on: null, loan_active: false, hold_count: 0 });
  assert.equal(gate.open, false); assert.equal(gate.opens_on, D("2032-03-01")); assert.equal(gate.reason, "retention runs to 2032-03-01");
  assert.equal(fnmaRetentionGate({ today: D("2032-03-01"), liquidated_on: D("2028-02-29"), transferred_out_on: null, loan_active: false, hold_count: 0 }).open, true);
  assert.equal(classGate("regf_1006_100b_call_3y", { today: D("2031-03-01"), anchor: D("2028-02-29"), hold_count: 0 }).opens_on, D("2031-03-01"));   // the same rule for every yearly class
  assert.equal(retention({ ...PAID_LOAN, liquidated_on: D("2028-02-29"), discharged_on: D("2028-02-29") }, D("2032-03-01")).fnma, D("2032-03-01"));
  const o = object("ro-11", "L-11", { ...PAID_TX, liquidated_on: D("2028-02-29"), discharged_on: D("2028-02-29") });
  assert.equal(sweep([o], D("2032-02-29"))[0]!.status, "retention_running"); assert.equal(sweep([o], D("2032-02-29"))[0]!.eligible_for_disposal_at, D("2032-03-01")); assert.equal(sweep([o], D("2032-03-01"))[0]!.status, "eligible");
  assert.equal(EVALUATORS_19_1["19.1.fnmaRetentionGateOpen"]!({ today: "2032-03-01", liquidated_on: "2028-02-29", loan_active: false, hold_count: 0 }).open, true);
  assert.equal(EVALUATORS_19_1["19.1.fnmaRetentionGateOpen"]!({ today: "2032-02-29", liquidated_on: "2028-02-29", loan_active: false, hold_count: 0 }).open, false);
  // the liquidation recorded on the leap day arms the gate row (anchored on the event's civil date) and the loan's objects resolve to 2032-03-01 through the sweep
  const h = harness("2028-02-29T15:00:00.000Z");
  const leap = recordLoanLiquidated([object("ro-11b", "L-11", { ...PAID_TX, liquidated_on: null, discharged_on: null, loan_active: true })], { loan_id: "L-11", liquidation_kind: "paid_in_full", liquidated_on: D("2028-02-29") }, h.ctx(SYSTEM));
  assert.deepEqual(leap.events.map((e) => [e.type, e.payload.liquidated_on ?? e.payload.discharged_on]), [["loan.liquidated", D("2028-02-29")], ["loan.discharged", D("2028-02-29")]]);
  const t = h.engine.byCode("FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION")[0]!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, D("2028-02-29")); assert.equal(t.dueAt, undefined);
  assert.equal(sweep(leap.objects, D("2032-02-29"))[0]!.eligible_for_disposal_at, D("2032-03-01")); assert.equal(sweep(leap.objects, D("2032-03-01"))[0]!.status, "eligible");
});
test("19.1-T12: Given the WORM integrity check fails for one object, then that object's disposal is blocked and a sev-1 incident (19.2) is opened.", () => {
  const objects = sweep([object("ro-1", "L-1", PAID_TX), object("ro-2", "L-2", PAID_TX, "contact_note", "c".repeat(64)), object("ro-3", "L-3", PAID_TX)], D("2031-06-01"));
  assert.ok(objects.every((o) => o.status === "eligible"));
  const chk = wormIntegrityCheck(objects.map(wormOf));
  assert.deepEqual(chk.failed_object_ids, ["ro-2"]); assert.deepEqual(chk.disposal_blocked_object_ids, ["ro-2"]); assert.equal(chk.run_halted, false);
  assert.deepEqual(chk.incident, { severity: "sev1", process: "19.2", control: "CTL-SEC-22", object_ids: ["ro-2"] });
  // the daily job opens the incident: `security.incident.identified` (S1, CTL-SEC-22) and the sev-1 escalation the 19.2 triage owns
  const h = harness("2031-06-01T06:00:00.000Z");
  const runId = "DR-2031-06-01-life_of_loan_plus_4y";
  const job = wormIntegrityJob(objects.map(wormOf), h.ctx(SYSTEM), { run_id: runId });
  assert.equal(job.incident_event?.type, "security.incident.identified");
  assert.deepEqual([job.incident_event?.payload.severity, job.incident_event?.payload.control, job.incident_event?.payload.source_process, job.incident_event?.payload.category, job.incident_event?.payload.object_ids], ["S1", "CTL-SEC-22", "19.1", "worm_integrity_failure", ["ro-2"]]);
  assert.equal(h.escalations.opened.length, 1); assert.equal(h.escalations.opened[0]!.kind, "sev1"); assert.equal(h.escalations.opened[0]!.ownerRole, "ciso"); assert.equal(h.escalations.opened[0]!.id, job.escalation_id);
  assert.deepEqual(h.events.all().map((e) => e.type), ["worm_integrity.checked", "security.incident.identified", "escalation.created"]);
  // the failed object's disposal is blocked; the verified objects in the same run proceed
  const plan = planDisposalRun({ run_on: D("2031-06-01"), class_code: "life_of_loan_plus_4y", objects, worm: job.check });
  assert.deepEqual(plan.object_ids, ["ro-1", "ro-3"]); assert.deepEqual(plan.excluded, [{ object_id: "ro-2", reason: "worm_integrity_failed_sev1" }]); assert.equal(plan.id, runId);
  const worm = wormFromEvents(h.events.all(), runId)!; assert.equal(worm.verified, true); assert.deepEqual(worm.blocked_object_ids, ["ro-2"]);
  const att = attestDisposalRun(plan, h.ctx(OFFICER)); const attestation = attestationFromEvents(h.events.all(), runId);
  assert.equal(disposalGuards({ op: "dispose", actor: AGENT, disposal_run_id: runId, attestation, worm, object_id: "ro-2" }).code, "WORM_INTEGRITY_FAILED_SEV1");
  assert.equal(disposalGuards({ op: "dispose", actor: AGENT, disposal_run_id: runId, attestation, worm, object_id: "ro-1" }).allowed, true);
  const exec = executeDisposalRun(att.run, objects, h.ctx(AGENT), h.events.all());
  assert.equal(exec.executed, true); assert.deepEqual(exec.objects.map((o) => o.status), ["disposed", "eligible", "disposed"]);
  const elig = retention(PAID_LOAN, D("2031-06-01")); assert.equal(disposalAllowed(elig, false, true).reason, "worm_integrity_failed_sev1"); assert.ok(disposalAllowed(elig, true, true).allowed);
  // WORM store unavailable → the run halts: never delete without the verified-copy check passing first
  const down = harness("2031-06-01T06:00:00.000Z");
  const outage = wormIntegrityJob(objects.map(wormOf), down.ctx(SYSTEM), { run_id: runId, worm_available: false });
  assert.equal(outage.check.run_halted, true); assert.deepEqual(outage.check.disposal_blocked_object_ids, ["ro-1", "ro-2", "ro-3"]); assert.equal(outage.incident_event?.payload.category, "worm_store_unavailable"); assert.equal(down.escalations.opened[0]!.kind, "sev1");
  assert.deepEqual(planDisposalRun({ run_on: D("2031-06-01"), class_code: "life_of_loan_plus_4y", objects, worm: outage.check }).excluded.map((x) => x.reason), ["worm_store_unavailable", "worm_store_unavailable", "worm_store_unavailable"]);
  assert.equal(wormFromEvents(down.events.all(), runId)!.verified, false);
  assert.equal(executeDisposalRun(attestDisposalRun(plan, down.ctx(OFFICER)).run, objects, down.ctx(OFFICER), down.events.all()).refusal?.code, "WORM_INTEGRITY_FAILED_SEV1");
  // the officer-attested run certificate lists the excluded object with its reason and blocks when WORM integrity was not verified
  const reg = notices(); const v = reg.activeVersion("NTC_DISPOSAL_CERTIFICATE", D("2026-09-01"))!; const out = render(v.source, v.samplePayload);
  assert.match(out.text, /ro-77120 \(worm_integrity_failed_sev1/); assert.match(out.text, /Reasonable measures were taken to protect against unauthorized access/); assert.equal(evaluateChecklist(v, v.samplePayload, out).passed, true);
  const unverified = { ...v.samplePayload, worm_integrity_verified: false }; assert.ok(evaluateChecklist(v, unverified, render(v.source, unverified)).blocking.some((b) => b.rule_id === "worm-verified"));
  const unattested = { ...v.samplePayload, attested_by_role: "ops_analyst" }; assert.ok(evaluateChecklist(v, unattested, render(v.source, unattested)).blocking.some((b) => b.rule_id === "attested-officer"));
  const paper = { ...v.samplePayload, method: "physical_destroy", physical: true, electronic: false, vendor_name: "ShredCo", vendor_certificate_document_id: null }; assert.ok(evaluateChecklist(v, paper, render(v.source, paper)).blocking.some((b) => b.rule_id === "vendor-cert"));
  assert.equal(reg.template("NTC_DISPOSAL_CERTIFICATE").channelPolicy, "electronic_ok_without_esign");
});
test('19.1-T13: Given a borrower-signed RFI asking for "my entire servicing file," then the request is routed to 4.2 (not 19.1) and the 4.2 clocks apply.', () => {
  assert.equal(routeRecordsRequest({ borrower_signed: true, requester: "borrower" }), "4.2_rfi"); assert.equal(routeRecordsRequest({ borrower_signed: false, requester: "fnma" }), "19.1_production");
  const h = harness("2026-10-16T13:00:00.000Z", ["19.1", "4.2"]);
  const r = intakeRecordsRequest({ id: "RR-13", requester_type: "borrower", borrower_signed: true, requester_ref: "borrower B-1", received_at: h.clock.now(), format: "servicing_file_1024_38c2", loan_ids: ["L-1"], scope_description: "my entire servicing file", authority_confidence: 1 }, h.ctx(AGENT));
  assert.equal(r.routed_to, "4.2_rfi"); if (r.routed_to !== "4.2_rfi") return;
  assert.equal(r.request_status, "rerouted"); assert.equal(r.timers_19_1, false);
  // the §1024.36 clocks: acknowledgment +5 federal business days (2026-10-23), response +30 (2026-12-01 — Veterans Day and Thanksgiving skipped), extendable +15
  assert.deepEqual(r.clocks, { ack_due: addBusinessDays(D("2026-10-16"), 5, federal), response_due: addBusinessDays(D("2026-10-16"), 30, federal), extendable: true });
  assert.deepEqual([r.clocks.ack_due, r.clocks.response_due], [D("2026-10-23"), D("2026-12-01")]);
  assert.deepEqual(r.events.map((e) => e.type), ["records.request.rerouted", "case.rfi.opened"]); assert.equal(r.events[0]!.payload.to, "4.2");
  // nothing of 19.1 armed; 4.2's own timers carry the clocks
  const armed = h.engine.all();
  assert.ok(armed.length > 0); assert.ok(armed.every((i) => h.registry.get(i.code)!.process !== "19.1"), armed.map((i) => i.code).join(","));
  assert.equal(h.engine.byCode("REGX_1024_36C_RFI_ACK_5")[0]?.dueDate, r.clocks.ack_due); assert.equal(h.engine.byCode("REGX_1024_36D_RFI_RESPONSE_30")[0]?.dueDate, r.clocks.response_due);
  assert.equal(h.engine.byCode("REGX_1024_38C2_SERVICING_FILE_5D").length, 0); assert.equal(h.escalations.opened.length, 0); assert.ok(!h.events.all().some((e) => e.type === "legal_hold.placed" || e.type === "records.request.received"));
  // an unsigned request is not an RFI: the `refused` branch — no authority, an attorney review, no hold, no clock
  const before = h.engine.all().length;
  const refused = intakeRecordsRequest({ id: "RR-13b", requester_type: "borrower", borrower_signed: false, requester_ref: "unknown caller", received_at: h.clock.now(), format: "servicing_file_1024_38c2", loan_ids: ["L-1"], scope_description: "everything", authority_confidence: 0.2 }, h.ctx(AGENT));
  assert.equal(refused.routed_to, "refused"); if (refused.routed_to !== "refused") return;
  assert.equal(refused.request.status, "refused"); assert.match(refused.request.refusal_reason, /not signed by the borrower/); assert.equal(refused.timers_19_1, false);
  assert.deepEqual(refused.events.map((e) => e.type), ["records.request.refused"]); assert.equal(refused.events[0]!.payload.hold_placed, false); assert.equal(refused.events[0]!.payload.attorney_review_escalation_id, refused.request.attorney_review_escalation_id);
  const esc = h.escalations.opened.find((e) => e.id === refused.request.attorney_review_escalation_id)!; assert.equal(esc.kind, "attorney"); assert.equal(esc.ownerRole, "attorney"); assert.match(String(esc.payload.reason), /refused request/);
  assert.equal(h.engine.all().length, before); assert.ok(!h.events.all().some((e) => e.type === "legal_hold.placed"));
  // a third party without a borrower's authorization is refused the same way; one carrying an authorization is intaken as the borrower's own request, never as a third party
  const third = intakeRecordsRequest({ id: "RR-13c", requester_type: "third_party", requester_ref: "relative of the borrower", received_at: h.clock.now(), format: "full_loan_file", loan_ids: ["L-1"], scope_description: "everything", authority_confidence: 0.1 }, h.ctx(AGENT));
  assert.equal(third.routed_to, "refused"); assert.ok(third.routed_to === "refused" && /third party without a borrower's written authorization/.test(third.request.refusal_reason));
  assert.throws(() => intakeRecordsRequest({ id: "RR-13d", requester_type: "third_party", authorization_evidence: "POA doc-poa-1", requester_ref: "attorney-in-fact", received_at: h.clock.now(), format: "full_loan_file", loan_ids: ["L-1"], scope_description: "everything", authority_confidence: 0.9 }, h.ctx(AGENT)), RangeError);
  // a refused request can never be delivered: the delivery gate knows no `records.request.received` for it
  assert.equal(productionGuards({ op: "deliver", request_id: "RR-13b", log: h.events.all() }).code, "AUTHORITY_CONFIDENCE_BELOW_0_85");
});
test("19.1-T14: Given a subpoena received, then a hold is placed automatically, an `attorney` escalation is created within 1 hour, and no production is delivered without attorney approval.", () => {
  const h = harness("2026-11-19T14:05:00.000Z");
  const objects = sweep([object("ro-14", "L-1", { ...PAID_TX, liquidated_on: null, discharged_on: null, loan_active: true })], D("2026-11-19"));
  const s = intakeRecordsRequest({ id: "RR-14", requester_type: "court_subpoena", requester_ref: "Supreme Court of the State of New York, County of Kings", received_at: h.clock.now(), format: "full_loan_file", loan_ids: ["L-1"], scope_description: "loan ending 1234, complete file", matter_ref: "Index No. 512345/2026", authority_confidence: 0.99 }, h.ctx(AGENT), objects);
  assert.equal(s.routed_to, "19.1_production"); if (s.routed_to !== "19.1_production") return;
  assert.equal(s.request.status, "scoped"); assert.deepEqual(s.request.production_requires, ["attorney_approval"]); assert.equal(s.request.redaction_required, false);   // courts receive unredacted files (rule 6)
  // the hold is placed automatically (reason subpoena) on every object of the loan, and its 180-day review clock arms
  assert.deepEqual(s.hold, { id: "LH-RR-14", scope: "loan", scope_ref: "L-1", reason: "subpoena", matter_ref: "Index No. 512345/2026", placed_by: "agent:security-records", placed_at: "2026-11-19T14:05:00.000Z", next_review_at: "2027-05-18T14:05:00.000Z", auto_placed: true, released_at: null, release_approvals: [], last_reviewed_at: null });
  assert.equal(s.objects[0]!.status, "held"); assert.equal(s.objects[0]!.hold_count, 1); assert.equal(s.request.hold_id, "LH-RR-14");
  assert.deepEqual(s.events.map((e) => e.type), ["legal_hold.placed", "records.request.received"]); assert.deepEqual(s.events[0]!.payload.object_ids, ["ro-14"]);
  assert.equal(h.engine.byCode("SM_LEGAL_HOLD_REVIEW_180")[0]!.dueDate, D("2027-05-18")); assert.equal(loadOverriddenRegistry().get("SM_LEGAL_HOLD_REVIEW_180")?.satisfiedPattern?.type, "legal_hold.reviewed");
  // the attorney escalation exists in the queue within the hour, with the package
  assert.equal(s.escalations.length, 1); assert.equal(s.escalations[0]!.kind, "attorney"); assert.equal(s.escalations[0]!.due_at, "2026-11-19T15:05:00.000Z");
  const esc = h.escalations.opened.find((e) => e.id === s.escalations[0]!.id)!;
  assert.equal(esc.kind, "attorney"); assert.equal(esc.ownerRole, "attorney"); assert.equal(esc.status, "open"); assert.equal(esc.loanId, "L-1"); assert.equal(esc.payload.within_minutes, 60); assert.match(String(esc.payload.reason), /validity, objections, privilege/);
  assert.equal(Date.parse(String(esc.payload.due_at)) - Date.parse(esc.openedAt), 60 * 60_000);
  assert.ok(h.events.all().some((e) => e.type === "escalation.created" && e.payload.kind === "attorney"));
  // no production is delivered without attorney approval — the approval is a `records.request.approved{kind=attorney_approval}` by a human attorney in the log: not the officer's sign-off, not the agent's word, not the caller's role
  const delivery = { delivered_via: "e-discovery load file", manifest_sha256: "3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855a" };
  const rails = TOOLS_19_1.find((t) => t.name === "records.compileServicingFile")!.guardrails!;
  const refusals = (input: Record<string, unknown>, actor: Actor) => rails.filter((g) => g.refuse(input, h.commandCtx(actor)) !== undefined).map((g) => g.code);
  assert.equal(approveProduction(s.request, "officer_sign_off", { rationale: "subpoena logged" }, h.ctx(OFFICER)).allowed, true);   // an officer's sign-off is not an attorney's approval
  assert.equal(approveProduction(s.request, "attorney_approval", { rationale: "looks valid" }, h.ctx(AGENT)).code, "APPROVAL_NEEDS_HUMAN_ROLE");
  assert.equal(approveProduction(s.request, "attorney_approval", { rationale: "looks valid" }, h.ctx(OFFICER)).code, "APPROVAL_NEEDS_HUMAN_ROLE");
  for (const who of [AGENT, OFFICER, ATTORNEY]) {
    const refused = deliverProduction(s.request, delivery, h.ctx(who), h.events.all());
    assert.equal(refused.delivered, false); assert.equal(refused.decision.code, "ATTORNEY_APPROVAL_REQUIRED"); assert.deepEqual(refused.decision.requires, ["attorney_approval"]);
    assert.deepEqual(refusals({ op: "deliver", request_id: "RR-14" }, who), ["PRODUCTION_APPROVAL_REQUIRED"]);
  }
  assert.ok(!h.events.all().some((e) => e.type === "records.request.delivered"));
  const facts = productionFacts(h.events.all(), "RR-14"); assert.deepEqual([facts.known, facts.attorney_approved, facts.officer_signed_off, facts.authority_confidence], [true, false, true, 0.99]);
  assert.deepEqual(productionDeliveryAllowed({ ...facts, attorney_approved: true }), { allowed: true, code: null, citation: null, requires: [] });
  assert.equal(productionDeliveryAllowed({ ...facts, attorney_approved: true, authority_confidence: 0.84 }).code, "AUTHORITY_CONFIDENCE_BELOW_0_85");
  const approved = approveProduction(s.request, "attorney_approval", { rationale: "subpoena valid on its face; no privilege objection; produce the complete file" }, h.ctx(ATTORNEY));
  assert.equal(approved.allowed, true); assert.equal(approved.event?.actor.role, "attorney");
  assert.deepEqual(refusals({ op: "deliver", request_id: "RR-14" }, AGENT), []);
  const ok = deliverProduction(s.request, delivery, h.ctx(AGENT), h.events.all());
  assert.equal(ok.delivered, true); assert.equal(ok.event?.type, "records.request.delivered"); assert.equal(ok.facts.attorney_approved, true);
  // a >500-loan regulator scope: the officer's sign-off does not stand in for the officer's confirmation of the scope, and the guard reads the events whoever calls
  const big = intakeRecordsRequest({ id: "RR-14big", requester_type: "regulator_state", requester_ref: "NYDFS", received_at: h.clock.now(), format: "portfolio_export_mismo", loan_ids: Array.from({ length: 501 }, (_, k) => `L-${k}`), scope_description: "portfolio", authority_confidence: 0.9 }, h.ctx(AGENT));
  assert.ok(big.routed_to === "19.1_production"); if (big.routed_to !== "19.1_production") return;
  assert.deepEqual(big.request.production_requires, ["officer_sign_off", "officer_confirmation"]); assert.equal(big.escalations.filter((e) => e.kind === "officer").length, 1);
  assert.deepEqual(productionDeliveryAllowed(productionFacts(h.events.all(), "RR-14big")).requires, ["officer_sign_off", "officer_confirmation"]);
  approveProduction(big.request, "officer_sign_off", { rationale: "exam request on letterhead with the exam notice" }, h.ctx(OFFICER));
  assert.equal(deliverProduction(big.request, delivery, h.ctx(OFFICER), h.events.all()).decision.code, "OFFICER_CONFIRMATION_REQUIRED");
  for (const who of [AGENT, OPERATOR, OFFICER]) assert.deepEqual(refusals({ op: "deliver", request_id: "RR-14big" }, who), ["OFFICER_CONFIRM_LARGE_OR_NEW_REQUESTER"]);
  approveProduction(big.request, "officer_confirmation", { rationale: "scope of 501 loans confirmed against the exam scope letter" }, h.ctx(OFFICER));
  assert.equal(deliverProduction(big.request, delivery, h.ctx(AGENT), h.events.all()).delivered, true);
  // a low-confidence authority on a non-court request escalates to the officer instead of delivering, until the officer records the verified authority
  const low = intakeRecordsRequest({ id: "RR-14b", requester_type: "auditor", requester_ref: "unknown firm", received_at: h.clock.now(), format: "custom", loan_ids: ["L-1"], scope_description: "sample", authority_confidence: 0.6 }, h.ctx(AGENT));
  assert.ok(low.routed_to === "19.1_production" && low.request.production_requires.includes("authority_escalation") && low.escalations[0]!.kind === "officer"); if (low.routed_to !== "19.1_production") return;
  assert.equal(deliverProduction(low.request, delivery, h.ctx(OFFICER), h.events.all()).decision.code, "AUTHORITY_CONFIDENCE_BELOW_0_85"); assert.deepEqual(refusals({ op: "deliver", request_id: "RR-14b" }, OFFICER), ["AUTHORITY_CONFIDENCE_BELOW_0_85"]);
  assert.throws(() => approveProduction(low.request, "authority_verified", { rationale: "engagement letter verified" }, h.ctx(OFFICER)), RangeError);   // the verified confidence is recorded
  approveProduction(low.request, "authority_verified", { rationale: "engagement letter and partner confirmation verified", confidence: 0.95 }, h.ctx(OFFICER));
  assert.equal(productionFacts(h.events.all(), "RR-14b").authority_confidence, 0.95); assert.equal(deliverProduction(low.request, delivery, h.ctx(AGENT), h.events.all()).delivered, true);
  // the hold notice to custodians/vendors and the court certification signed by a signing_officer
  const reg = notices(); const hn = reg.activeVersion("NTC_LEGAL_HOLD_INTERNAL", D("2026-09-01"))!; const ho = render(hn.source, hn.samplePayload);
  assert.match(ho.text, /DO NOT DESTROY/); assert.match(ho.text, /released only in writing by an officer and an attorney/); assert.match(ho.text, /within five business days of a request/); assert.equal(evaluateChecklist(hn, hn.samplePayload, ho).passed, true);
  const auto = { ...hn.samplePayload, release_requires: "officer" }; assert.ok(evaluateChecklist(hn, auto, render(hn.source, auto)).blocking.some((b) => b.rule_id === "release-approvals"));
  const noTypes = { ...hn.samplePayload, record_types: [] }; const noTypesOut = render(hn.source, noTypes);
  assert.deepEqual(evaluateChecklist(hn, noTypes, noTypesOut).blocking.map((b) => b.rule_id), ["record-types", "record-types-data"]);   // the record types in scope are read from record_types[] itself
  const c = reg.activeVersion("NTC_RECORDS_CERTIFICATION", D("2026-09-01"))!; const co = render(c.source, c.samplePayload);
  assert.match(co.text, /I declare under penalty of perjury under the laws of the United States of America/); assert.match(co.text, /kept in the course of a regularly conducted activity/); assert.match(co.text, /property of Fannie Mae/); assert.equal(evaluateChecklist(c, c.samplePayload, co).passed, true);
  const analyst = { ...c.samplePayload, signer_role: "ops_analyst" }; assert.ok(evaluateChecklist(c, analyst, render(c.source, analyst)).blocking.some((b) => b.rule_id === "signing-officer"));
  const redactedNoLog = { ...c.samplePayload, redacted: true, redaction_log_id: null }; assert.ok(evaluateChecklist(c, redactedNoLog, render(c.source, redactedNoLog)).blocking.some((b) => b.rule_id === "redaction-log"));
  // the Fannie Mae ownership statement is a rule that can fail: a template that drops the sentence blocks; a non-Fannie Mae production must not claim it
  const dropped = evaluateChecklist(c, c.samplePayload, render(c.source.replace("are the property of Fannie Mae; ", "are records of "), c.samplePayload));
  assert.ok(dropped.blocking.some((b) => b.rule_id === "fnma-ownership"));
  const nonFnma = { ...c.samplePayload, fnma_property: false }; const nonOut = render(c.source, nonFnma);
  assert.doesNotMatch(nonOut.text, /property of Fannie Mae/); assert.equal(evaluateChecklist(c, nonFnma, nonOut).passed, true);
  assert.ok(evaluateChecklist(c, nonFnma, render(c.source, c.samplePayload)).blocking.some((b) => b.rule_id === "no-fnma-claim-on-non-fnma"));
  // the E-SIGN accuracy statement is a sentence of the text: a template that drops it blocks for electronic records, and a paper production must not carry it
  const noEsign = evaluateChecklist(c, c.samplePayload, render(c.source.replace(/\{\{#if electronic_records\}\}[^]*?\{\{\/if\}\}/, ""), c.samplePayload));
  assert.deepEqual(noEsign.blocking.map((b) => b.rule_id), ["esign-7001d"]);
  const paper = { ...c.samplePayload, electronic_records: false }; const paperOut = render(c.source, paper);
  assert.doesNotMatch(paperOut.text, /accurately reflect the information/); assert.equal(evaluateChecklist(c, paper, paperOut).passed, true); assert.ok(evaluateChecklist(c, paper, co).blocking.some((b) => b.rule_id === "no-esign-claim-on-paper"));
});
test("19.1-T15: Given AI off, when a human operator uses the ops console, then the same guards (no delete, attestation before disposal) apply.", () => {
  const h = harness("2031-06-01T06:00:00.000Z");
  const runId = "DR-2031-06-01-life_of_loan_plus_4y";
  const attested = (by: Actor) => ({ by: by.id, by_role: by.role ?? by.kind, at: h.clock.now() });
  const worm = { verified: true, blocked_object_ids: [], at: h.clock.now() };
  // the domain guards refuse the agent and the console operator identically
  for (const actor of [AGENT, OPERATOR, OFFICER]) {
    assert.equal(disposalGuards({ op: "delete", actor, disposal_run_id: runId, attestation: attested(OFFICER), worm }).code, "NO_DELETE");
    assert.equal(disposalGuards({ op: "dispose", actor, disposal_run_id: null, attestation: attested(OFFICER), worm }).code, "DISPOSAL_ONLY_VIA_ATTESTED_RUN");
    assert.equal(disposalGuards({ op: "dispose", actor, disposal_run_id: runId, attestation: attested(OFFICER), worm: null }).code, "WORM_INTEGRITY_FAILED_SEV1");
    assert.equal(disposalGuards({ op: "dispose", actor, disposal_run_id: runId, attestation: null, worm }).code, "OFFICER_ATTESTATION_REQUIRED");
    assert.equal(disposalGuards({ op: "dispose", actor, disposal_run_id: runId, attestation: attested(OPERATOR), worm }).code, "OFFICER_ATTESTATION_REQUIRED");
    assert.equal(disposalGuards({ op: "dispose", actor, disposal_run_id: runId, attestation: attested(AGENT), worm }).code, "OFFICER_ATTESTATION_REQUIRED");
    assert.equal(disposalGuards({ op: "release_hold", actor, disposal_run_id: null, attestation: null, worm: null, release_approvals: [] }).code, "HOLD_RELEASE_NEEDS_OFFICER_AND_ATTORNEY");
    assert.deepEqual(disposalGuards({ op: "dispose", actor, disposal_run_id: runId, attestation: attested(OFFICER), worm }), { allowed: true, code: null, citation: null });
  }
  // the bus tools bind the same guardrails over the same event log: caller-asserted flags change nothing; only an officer's `disposal_run.attested` and a passing `worm_integrity.checked` open the way
  const rails = TOOLS_19_1.find((t) => t.name === "records.compileServicingFile")!.guardrails!;
  assert.deepEqual(TOOLS_19_1.find((t) => t.name === "records.classify")!.guardrails, rails);
  const refusals = (input: Record<string, unknown>, actor: Actor) => rails.filter((g) => g.refuse(input, h.commandCtx(actor)) !== undefined).map((g) => g.code);
  for (const who of [AGENT, OPERATOR, OFFICER]) {
    assert.deepEqual(refusals({ op: "delete" }, who), ["NO_DELETE"]);
    assert.deepEqual(refusals({ op: "dispose" }, who), ["DISPOSAL_ONLY_VIA_ATTESTED_RUN"]);
    assert.deepEqual(refusals({ op: "dispose", disposal_run_id: runId, attested_by_officer: true, worm_integrity_ok: true }, who), ["DISPOSAL_ONLY_VIA_ATTESTED_RUN"]);
    assert.deepEqual(refusals({ op: "release_hold" }, who), ["NO_AUTO_HOLD_RELEASE"]);
    assert.deepEqual(refusals({ deliver: true }, who), ["AUTHORITY_CONFIDENCE_BELOW_0_85"]);   // a delivery of no known request has no verified authority
    assert.deepEqual(refusals({ op: "deliver", request_id: "RR-x", authority_confidence: 0.99, officer_confirmed: true }, who), ["AUTHORITY_CONFIDENCE_BELOW_0_85"]);   // caller flags are not facts
  }
  assert.match(rails.find((g) => g.code === "DISPOSAL_ONLY_VIA_ATTESTED_RUN")!.refuse({ op: "dispose", disposal_run_id: runId }, h.commandCtx(AGENT))!, /WORM_INTEGRITY_FAILED_SEV1/);
  h.events.append({ type: "worm_integrity.checked", actor: SYSTEM, payload: { run_id: runId, failed_object_ids: ["ro-2"], disposal_blocked_object_ids: ["ro-2"], run_halted: false } });
  assert.match(rails.find((g) => g.code === "DISPOSAL_ONLY_VIA_ATTESTED_RUN")!.refuse({ op: "dispose", disposal_run_id: runId }, h.commandCtx(AGENT))!, /OFFICER_ATTESTATION_REQUIRED/);
  h.events.append({ type: "disposal_run.attested", actor: OPERATOR, payload: { run_id: runId } });   // an analyst's attestation is not an officer's
  for (const who of [AGENT, OPERATOR, OFFICER]) assert.deepEqual(refusals({ op: "dispose", disposal_run_id: runId }, who), ["DISPOSAL_ONLY_VIA_ATTESTED_RUN"]);
  h.events.append({ type: "disposal_run.attested", actor: OFFICER, payload: { run_id: runId } });
  for (const who of [AGENT, OPERATOR, OFFICER]) { assert.deepEqual(refusals({ op: "dispose", disposal_run_id: runId }, who), []); assert.deepEqual(refusals({ op: "dispose", disposal_run_id: runId, object_id: "ro-2" }, who), ["DISPOSAL_ONLY_VIA_ATTESTED_RUN"]); }
  // the delivery rails read the request's events: a >500-loan scope is refused for every caller — the officer included — until the officer's confirmation is in the log
  const big = intakeRecordsRequest({ id: "RR-15", requester_type: "auditor", requester_ref: "external audit firm (engagement letter on file)", received_at: h.clock.now(), format: "custom", loan_ids: Array.from({ length: 501 }, (_, k) => `L-${k}`), scope_description: "audit sample", authority_confidence: 0.9 }, h.ctx(AGENT));
  assert.ok(big.routed_to === "19.1_production"); if (big.routed_to !== "19.1_production") return;
  for (const who of [AGENT, OPERATOR, OFFICER]) assert.deepEqual(refusals({ op: "deliver", request_id: "RR-15" }, who), ["OFFICER_CONFIRM_LARGE_OR_NEW_REQUESTER"]);
  assert.equal(approveProduction(big.request, "officer_confirmation", { rationale: "sample of 501 loans matches the engagement scope" }, h.ctx(OPERATOR)).code, "APPROVAL_NEEDS_HUMAN_ROLE");
  approveProduction(big.request, "officer_confirmation", { rationale: "sample of 501 loans matches the engagement scope" }, h.ctx(OFFICER));
  for (const who of [AGENT, OPERATOR, OFFICER]) assert.deepEqual(refusals({ op: "deliver", request_id: "RR-15" }, who), []);
  const small = intakeRecordsRequest({ id: "RR-15s", requester_type: "auditor", requester_ref: "external audit firm", received_at: h.clock.now(), format: "custom", loan_ids: ["L-1"], scope_description: "one loan", authority_confidence: 0.9, new_requester_identity: true }, h.ctx(AGENT));
  assert.ok(small.routed_to === "19.1_production" && small.request.production_requires.includes("officer_confirmation")); assert.deepEqual(refusals({ op: "deliver", request_id: "RR-15s" }, OFFICER), ["OFFICER_CONFIRM_LARGE_OR_NEW_REQUESTER"]);
  // the console's disposal command (AI off) runs the same lifecycle engine: no attestation → refused; officer attests → the operator and the agent execute alike
  const cold = harness("2031-06-01T06:00:00.000Z");
  const objects = sweep([object("ro-1", "L-1", PAID_TX)], D("2031-06-01"));
  let plan = planDisposalRun({ run_on: D("2031-06-01"), class_code: "life_of_loan_plus_4y", objects, worm: wormIntegrityCheck(objects.map(wormOf)) });
  wormIntegrityJob(objects.map(wormOf), cold.ctx(OPERATOR), { run_id: plan.id });
  assert.equal(executeDisposalRun(plan, objects, cold.ctx(OPERATOR), cold.events.all()).refusal?.code, "OFFICER_ATTESTATION_REQUIRED");
  assert.equal(attestDisposalRun(plan, cold.ctx(OPERATOR)).code, "OFFICER_ATTESTATION_REQUIRED"); assert.equal(attestDisposalRun(plan, cold.ctx(AGENT)).code, "OFFICER_ATTESTATION_REQUIRED");
  plan = attestDisposalRun(plan, cold.ctx(OFFICER)).run; assert.equal(plan.attested_by, "u-officer");
  assert.equal(executeDisposalRun(plan, objects, cold.ctx(OPERATOR), cold.events.all()).executed, true);
  assert.equal(executeDisposalRun(plan, objects, cold.ctx(AGENT), cold.events.all()).executed, true);
  assert.deepEqual(TOOLS_19_1.map((t) => [t.process, t.agent, t.name]), [["19.1", "security-records", "records.classify"], ["19.1", "security-records", "records.compileServicingFile"]]);
  assert.deepEqual(classifyRecord("call_recording").timer_codes, ["FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION", "REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER", "REGF_1006_100B_CALL_RECORDING_3Y"]); assert.equal(classifyRecord("payment_history").may_shorten, false);
  assert.deepEqual(classifyRecord("notice_rendered").anchors.find((a) => a.class_code === "regz_1026_25a_2y"), { class_code: "regz_1026_25a_2y", anchor_event: "notice.sent{regz}", anchor_rule: "form_due_date" });
  assert.deepEqual(classifyRecord("payment_history", "NY").anchors.find((a) => a.class_code === "ny_419_9_3y_post_final_entry"), { class_code: "ny_419_9_3y_post_final_entry", anchor_event: "loan.final_entry", anchor_rule: "record_created" });
  // conditional classes: NY 419.9 only on New York loans, Reg F (a) only on debt-collector loans, Reg Z only on Reg Z disclosures — dropped with the citation, kept when the fact is unknown
  assert.deepEqual(classifyRecord("contact_note", "TX", { fdcpa_debt_collector: false }).dropped.map((d) => d.class_code), ["ny_419_9_3y_post_final_entry", "regf_1006_100a_3y_post_last_collection"]);
  assert.deepEqual(classifyRecord("contact_note").dropped, []); assert.deepEqual(classifyRecord("notice_rendered", "TX", { regz_disclosure: false }).timer_codes, ["FNMA_A2_4_1_02_RETENTION_4Y_POST_LIQUIDATION", "REGX_1024_38C1_RETENTION_1Y_POST_DISCHARGE_OR_TRANSFER"]);
  // corporate_7y has no timer-table row: it gates by its own anniversary and never names the annual inventory schedule as a retention gate
  assert.equal(retentionClass("corporate_7y").timer_code, null); assert.deepEqual(classifyRecord("board_report").timer_codes, []); assert.deepEqual(classifyRecord("investor_report").timer_codes, ["FNMA_A2_4_1_02_ACCOUNTING_REPORTS_18M"]);
  const board = sweep([object("ro-b", null, { created_on: D("2026-01-15") }, "board_report", "a".repeat(64), null)], D("2033-01-14"))[0]!;
  assert.equal(board.status, "retention_running"); assert.equal(board.eligible_for_disposal_at, D("2033-01-15")); assert.deepEqual(board.gates.map((g) => [g.class_code, g.timer_code]), [["corporate_7y", null]]);
  assert.throws(() => classifyRecord("mystery_type"), RangeError);
  // the annual inventory review: Dec 31's period.year_end arms the Jan 15 row; the recorded review satisfies it
  h.clock.set("2031-12-31T15:00:00.000Z"); emitScheduleTicks(D("2031-12-31"), h.events);
  const inv = h.engine.byCode("SM_RECORDS_INVENTORY_REVIEW_365")[0]!; assert.equal(inv.status, "armed"); assert.equal(inv.dueDate, D("2032-01-15"));
  h.clock.set("2032-01-10T15:00:00.000Z");
  const review = reviewRecordsInventory([{ id: "inv-1", record_type: "call_recording", storage_tier: "vendor_hosted", encryption_scope: "carrier KMS", restore_sla_hours: 24, last_verified_at: D("2031-11-01") }, { id: "inv-2", record_type: "note_image", storage_tier: null, encryption_scope: "worm-kms", restore_sla_hours: 4, last_verified_at: D("2030-06-01") }], { rule_set_version: "19.1@2026-09", guide_watch_diff: ["A2-4.1-03 05/06/2026: electronic records text unchanged"] }, h.ctx(OFFICER));
  assert.equal(review.passed, false); assert.deepEqual(review.gaps, [{ id: "inv-2", reasons: ["storage_tier missing", "last_verified_at 2030-06-01 is older than 365 days"] }]); assert.equal(review.event.type, "records_inventory.reviewed"); assert.equal(inv.status, "satisfied");
  // the monthly accounting report filed with Fannie Mae is enrolled as an `investor_report` object: `investor_report.filed` arms the 18-month row (a gate — "may destroy … unless instructed otherwise", breach n/a) and the object's own eligibility is the later corporate_7y anniversary
  h.clock.set("2032-01-31T20:00:00.000Z");
  const filed = recordInvestorReportFiled({ report_id: "LAR-2031-12", period: "2031-12", filed_on: D("2032-01-31"), document_id: "doc-lar-2031-12", worm_location: "s3://worm/investor-reports/2031-12" }, h.ctx(SYSTEM));
  assert.equal(filed.event.type, "investor_report.filed"); assert.deepEqual([filed.event.payload.filed_on, filed.event.payload.timer_code], [D("2032-01-31"), "FNMA_A2_4_1_02_ACCOUNTING_REPORTS_18M"]); assert.ok(eventMatches(h.registry.get("FNMA_A2_4_1_02_ACCOUNTING_REPORTS_18M")!.triggerPattern!, filed.event));
  const rpt = h.engine.byCode("FNMA_A2_4_1_02_ACCOUNTING_REPORTS_18M"); assert.equal(rpt.length, 1); assert.deepEqual([rpt[0]!.status, rpt[0]!.subject, rpt[0]!.anchorDate, rpt[0]!.dueAt, rpt[0]!.note], ["armed", { kind: "investor_report", id: "LAR-2031-12" }, D("2032-01-31"), undefined, "evaluator:19.1.accountingReportGateOpen"]);
  assert.equal(filed.object.record_type, "investor_report"); assert.equal(gateMap(filed.object).FNMA_A2_4_1_02_ACCOUNTING_REPORTS_18M, D("2033-07-31")); assert.equal(filed.object.eligible_for_disposal_at, D("2039-01-31")); assert.equal(filed.object.effective_class_code, "corporate_7y");
  assert.equal(EVALUATORS_19_1["19.1.accountingReportGateOpen"]!({ today: "2033-07-31", filed_on: "2032-01-31", hold_count: 0 }).open, true); assert.equal(EVALUATORS_19_1["19.1.accountingReportGateOpen"]!({ today: "2033-07-30", filed_on: "2032-01-31", hold_count: 0 }).open, false);
  assert.throws(() => recordInvestorReportFiled({ report_id: "LAR-x", period: "December 2031", filed_on: D("2032-01-31"), document_id: "d" }, h.ctx(SYSTEM)), RangeError);
  assert.deepEqual(h.engine.evaluate("2040-01-01T00:00:00.000Z").filter((b) => b.def.code === "FNMA_A2_4_1_02_ACCOUNTING_REPORTS_18M"), []);
  // every not-before gate of the timer table is evaluator-backed — none carries a due instant that could breach when it lawfully opens
  const reg = loadOverriddenRegistry();
  for (const g of DISPOSAL_GATES) { const row = reg.get(g.code)!; assert.equal(row.offset, `evaluator:${g.evaluator}`, g.code); assert.equal(row.kindNorm, "not_before_gate"); assert.ok(EVALUATORS_19_1[g.evaluator], g.evaluator); }
  assert.equal(DISPOSAL_GATES.length, 11); assert.equal(Object.keys(EVALUATORS_19_1).length, 11);
  assert.equal(addDays(D("2026-10-16"), 5), D("2026-10-21"));
  assert.deepEqual(transactionSchedule({ ledger_entries: [] }).rows, []); assert.equal(dollars(-300_000n), "-3000.00");
});
