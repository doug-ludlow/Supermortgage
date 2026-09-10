// 8.2 Dispute handling (e-OSCAR / ACDV)
// spec/sections/08-credit-reporting/8-2-dispute-handling-e-oscar-acdv.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, federal } from "../../kernel/calendar/business.ts";
import { cents, levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { applyFifo, type AppliedInstallment } from "../boarding/delinquency.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { FakeEoscar, type Acdv } from "../../infra/integrations/credit.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { SECTION_08_TOOLS } from "../../app/tools/section08.ts";
import { buildSnapshot, renderBase } from "./metro2.ts";
import { CreditCycleRunner, CreditReportingRefused, applyOverlayCodes, oralDisputeIntake, linkedNoeDispute, audAndCycle, type BureauConfig } from "./ops.ts";
import { DisputeCaseRunner, DisputeRefused, xbGateAssertion, etDate, RESULTS_TEMPLATE, FRIVOLOUS_TEMPLATE, RESPONSE_CODES } from "./ops-8-2.ts";
import { ACDV_RETURNED_STATUS, ACDV_SUBMITTED_STATUS, ACDV_NO_RESPONSE_STATUS, acdvClocks, type Bureau } from "./disputes.ts";
import type { CreditLoanState, PriorHistory, Metro2Snapshot } from "./types.ts";

// ---- fixtures: loan SM-1001 (8.1 rule 13), the four bureaus, actors, the registry after every override --------------
const AGENT: Actor = { kind: "agent", id: "credit-reporting" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const HUMAN_AGENT: Actor = { kind: "human", id: "u-reviewer", role: "human_agent" };
const CONFIG: Record<Bureau, BureauConfig> = { equifax: { program_identifier: "EFX-PROG", subscriber_code: "EFX123", file_naming: "SM_{cycle}_{bureau}.m2" }, experian: { program_identifier: "EXP-PROG", subscriber_code: "EXP123", file_naming: "SM_{cycle}_{bureau}.m2" }, transunion: { program_identifier: "TU-PROG", subscriber_code: "TU123", file_naming: "SM_{cycle}_{bureau}.m2" }, innovis: { program_identifier: "INV-PROG", subscriber_code: "INV123", file_naming: "SM_{cycle}_{bureau}.m2" } };
const REG = loadOverriddenRegistry();
const LETTER = { dispute_address: "PO Box 2, Testville TX 75001", servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001" };
const RECIPIENTS = [{ partyId: "A", name: "Borrower A", mailingAddress: "1 Main St, Testville TX 75001" }];

const PI = cents("1847.15"), ESCROW = cents("612.40"), PITI = PI + ESCROW;
const RATE = ratePercent("6.25");
function schedule(from: string, n: number) { return Array.from({ length: n }, (_, i) => ({ due_date: addMonths(D(from), i), amount_cents: PITI })); }
function ledger(paidThrough: string): readonly AppliedInstallment[] {
  const inst = schedule("2025-03-01", 40);
  return applyFifo(inst, inst.filter((i) => i.due_date <= D(paidThrough)).map((i) => ({ received_on: i.due_date, amount_cents: PITI }))).installments;
}
function state(asOf: string, installments: readonly AppliedInstallment[], prior: PriorHistory | Metro2Snapshot | null, over: Partial<CreditLoanState> = {}): CreditLoanState {
  return {
    loan_id: "SM-1001", as_of: D(asOf), installments, upb_cents: cents("293063.94"), deferred_principal_cents: 0n, forborne_principal_cents: 0n,
    pi_cents: PI, escrow_cents: ESCROW, original_amount_cents: cents("300000"), note_date: D("2025-02-14"), maturity_date: D("2055-02-01"),
    original_term_months: 360, remaining_term_months: 337, interest_type: "F", fnma_loan_number: "1234567890", min: "100012345678901234",
    payments_in_month_cents: PITI, last_payment_on: D(asOf.slice(0, 8) + "01"), condition: { kind: "none" },
    consumers: [{ party_id: "A", position: 1, same_address_as_base: true, liability: "individual" }], prior, ...over,
  };
}
const PRIOR: PriorHistory = { php: "0".repeat(24), status: "11", dofd: null };
/** SM-1001 current as of 2027-08-31 — the 8.1 snapshot logic the ACDV response is generated from (rule 4). */
const currentSnapshot = (loanId = "SM-1001"): Metro2Snapshot => ({ ...buildSnapshot(state("2027-08-31", ledger("2027-08-01"), PRIOR)), loan_id: loanId });
/** The rule-10 ACDV: control 2027091500123 from Experian, "disputes payment history", one check-copy image; CRA received 2027-09-12; Response Due Date 2027-10-01. */
const acdvOf = (control: string, over: Partial<Acdv> = {}): Acdv => ({ controlNumber: control, bureau: "experian", consumer: { name: "Borrower A", ssnLast4: "1234" }, accountNumber: "SM-1001", disputeCodes: ["106"], receivedAt: "2027-09-12T12:00:00.000Z", responseDueOn: "2027-10-01", images: ["doc-check-copy-2027-02-03"], fcraRelevantInfo: false, ...over });
const RECEIVED_AT = "2027-09-15T13:12:00.000Z";   // 2027-09-15 09:12 ET (rule 1 worked example)

/** The 8.2 world: event store + TimerEngine (8.2 rows only) + DisputeCaseRunner + e-OSCAR fake + the 8.2 tools on the bus + Notice Registry + escalations. */
function world(nowIso: string, loanId = "SM-1001") {
  const clock = new FixedClock(nowIso);
  const events = new MemoryEventStore(clock);
  const engine = new TimerEngine(REG, events, { processes: ["8.2"] });
  const runner = new DisputeCaseRunner(events, AGENT);
  const cycles = new CreditCycleRunner(events, AGENT);
  const eoscar = new FakeEoscar();
  const escalations = new EscalationService(events, clock);
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: {}, ports: { eoscar } };
  const agents = new AgentRegistry();
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const tools = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of SECTION_08_TOOLS) if (d.process === "8.2") { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); tools.set(d.name, cmd); }
  const bus = new CommandBus(agents);
  const ctx: UowContext = { loanId, events, ledger: new MemoryLedger(), timers: engine, clock, decide: () => {} };
  const reg = buildRegistry(); publishAuthored(reg);
  const notices = new NoticeService({ registry: reg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const acdvTool = tools.get("eoscar.acdv.find/view/validate/submit")!;
  const run = (actor: Actor, input: ToolInput) => bus.execute(acdvTool, actor, input, ctx);
  const armed = (code: string) => engine.byCode(code).filter((t) => t.status === "armed");
  const satisfied = (code: string) => engine.byCode(code).filter((t) => t.status === "satisfied" || t.status === "satisfied_late");
  /** Intake through the poll (the `find` op of the e-OSCAR tool → `pollAcdvs` → `ingestAcdv`), then the mandatory `/view`. */
  const intake = async (a: Acdv, viewIt = true) => {
    eoscar.post(a);
    await run(AGENT, { op: "find", loan_id_by_account: { [a.accountNumber]: loanId } });
    if (viewIt) await run(AGENT, { op: "view", control_number: a.controlNumber });
    return `acdv-${a.bureau}-${a.controlNumber}`;
  };
  return { clock, events, engine, runner, cycles, eoscar, escalations, notices, bus, tools, ctx, run, armed, satisfied, intake };
}
type World = ReturnType<typeof world>;
const refused = (code: string) => (e: unknown) => (e instanceof DisputeRefused || e instanceof CommandRefused || e instanceof CreditReportingRefused) && e.code === code;
const LOCKBOX_EVIDENCE = [{ evidence_type: "ledger_history" as const, system_snapshot_id: "snap-ledger-2027-02..04", relied_upon: true }, { evidence_type: "payment_image" as const, document_id: "doc-lockbox-bai2-feb-apr-2027", relied_upon: true }];
/** Rule 10 ACDV happy path up to the investigation: intake, evidence, `verified_as_reported` at the given confidence. */
async function investigatedAcdv(w: World, control: string, confidence: number, over: Partial<Acdv> = {}) {
  const id = await w.intake(acdvOf(control, over));
  w.runner.recordEvidence({ dispute_id: id, evidence: LOCKBOX_EVIDENCE });
  const inv = w.runner.investigate({ dispute_id: id, determination: "verified_as_reported", confidence, requested_at: w.clock.now(), findings: [{ claim: "my February 2027 payment was mailed on Feb 3 (check copy dated 2027-02-03 for $2,459.55)", finding: "lockbox/BAI2 records show no deposit of that check in Feb–Apr 2027; the image is a check copy, not a cleared-check image", effect: "no_change", why: "Feb-1 and Mar-1 installments unpaid at the Mar-31 snapshot → status 71 and PHP `1` for March are correct" }] });
  return { id, inv };
}

test("8.2-T1: (ACDV happy path) Given an ACDV with Response Due Date 2027-10-01 received 2027-09-15, when investigated, then a response with the full field set is submitted by 2027-09-22, status reaches RESOLVED-RETURNEDTOAGENCY, and the case closes with XH scheduled for the next cycle.", async () => {
  const w = world(RECEIVED_AT);
  // the scheduler's 15-minute tick arms SM_ACDV_POLL_15M; the poll (`find`) ingests the ACDV and satisfies it
  w.runner.acdvPollTick(RECEIVED_AT);
  assert.equal(w.armed("SM_ACDV_POLL_15M").length, 1);
  const { id, inv } = await investigatedAcdv(w, "2027091500123", 0.93);
  assert.equal(w.satisfied("SM_ACDV_POLL_15M").length, 1, "poll success satisfies the 15-minute row");
  const rec = w.events.ofType("credit.dispute.acdv.received")[0]!;
  assert.equal(rec.payload.dispute_id, id); assert.equal(rec.payload.received_on, "2027-09-15"); assert.equal(rec.payload.response_due_on, "2027-10-01");
  assert.equal(rec.payload.internal_target_on, "2027-09-22"); assert.equal(rec.payload.cra_outer_bound_on, "2027-10-12"); assert.equal(rec.payload.category, "payment_history");
  // rule 1 clocks arm from the receipt event: the CRA-assigned due date, the +7 internal target, the CRA's outer bound from 2027-09-12
  assert.equal(w.armed("FCRA_1681S2B_ACDV_RESPONSE_DUE")[0]!.dueDate, "2027-10-01");
  assert.equal(w.armed("SM_ACDV_INTERNAL_TARGET_CD7")[0]!.dueDate, "2027-09-22");
  assert.equal(w.armed("FCRA_1681I_A1_CRA_OUTER_30_45")[0]!.dueDate, "2027-10-12");
  assert.equal(w.armed("FCRA_1681S2A3_XB_FLAG_GATE").length, 1, "the XB gate holds from receipt");
  assert.equal(w.events.ofType("credit.dispute.acdv.viewed")[0]!.payload.eoscar_status, "PENDING-AWAITINGRESPONSE");
  assert.equal(inv.review.required, false, "confidence 0.93 → no reviewer condition"); assert.equal(inv.status, "investigating");
  // rule 4: the response carries the full Metro 2 field set from the 8.1 snapshot logic with XB carried
  const response = w.runner.responsePayload({ control_number: "2027091500123", determination: "verified_as_reported", snapshot: currentSnapshot(), party_id: "A" });
  assert.equal(response.responseCode, RESPONSE_CODES.verified_as_reported);
  for (const k of ["account_status", "payment_rating", "special_comment", "current_balance", "amount_past_due", "scheduled_monthly_payment", "date_opened", "date_of_first_delinquency", "date_of_last_payment", "payment_history_profile", "ecoa", "cii", "ccc"]) assert.ok(k in response.accountFields, `field ${k}`);
  assert.equal(response.accountFields.ccc, "XB"); assert.equal(response.accountFields.account_status, "11"); assert.equal(response.accountFields.current_balance, "000293063");
  // submitted 2027-09-22 (the internal target) through the tool → RESOLVED-SENDINGTOAGENCY closes the three ACDV clocks
  w.clock.set("2027-09-22T14:00:00.000Z");
  const s = await w.run(AGENT, { op: "submit", determination: "verified_as_reported", evidence_ids: LOCKBOX_EVIDENCE.map((e) => e.document_id ?? e.system_snapshot_id), response });
  const out = s.output as { eoscar_status: string; submittedAt: string; data_changed: boolean };
  assert.equal(out.eoscar_status, ACDV_SUBMITTED_STATUS); assert.equal(etDate(out.submittedAt), "2027-09-22"); assert.equal(out.data_changed, false);
  assert.ok(etDate(out.submittedAt) <= acdvClocks(D("2027-09-15"), D("2027-10-01"), D("2027-09-12")).internal_target);
  for (const code of ["FCRA_1681S2B_ACDV_RESPONSE_DUE", "SM_ACDV_INTERNAL_TARGET_CD7", "FCRA_1681I_A1_CRA_OUTER_30_45"]) assert.equal(w.satisfied(code).length, 1, code);
  assert.equal(w.events.ofType("credit.dispute.acdv.responded")[0]!.payload.eoscar_status, ACDV_SUBMITTED_STATUS);
  // the case closes only on RESOLVED-RETURNEDTOAGENCY (2027-09-23), with XH scheduled for the next cycle (rule 6)
  assert.throws(() => w.runner.closeDispute({ dispute_id: id, determination: "verified_as_reported", closed_at: "2027-09-22T15:00:00.000Z" }), refused("CLOSE_REQUIRES_RETURNED"));
  w.clock.set("2027-09-23T12:00:00.000Z");
  assert.equal(w.runner.eoscarStatus({ control_number: "2027091500123", status: ACDV_RETURNED_STATUS, at: "2027-09-23T12:00:00.000Z" }).breach, false);
  const closed = w.runner.closeDispute({ dispute_id: id, determination: "verified_as_reported", closed_at: "2027-09-23T12:00:00.000Z" });
  assert.deepEqual(closed, { status: "closed", ccc_transition: "XH", open_disputes_remaining: 0 });
  assert.equal(w.events.ofType("credit.dispute.closed")[0]!.payload.ccc_effective, "next cycle (AUD if >10 days away)");
  assert.equal(w.satisfied("FCRA_1681S2A3_XB_FLAG_GATE").length, 1, "the last open dispute closing releases the XB gate");
  // the day after the due date only the re-armed 15-minute poll row (no tick since the intake poll) is overdue — no ACDV clock breached
  assert.deepEqual(w.engine.evaluate("2027-10-02T04:00:00.000Z").map((b) => b.instance.code), ["SM_ACDV_POLL_15M"]);
});

test('8.2-T2: (ACDV modify + fan-out) Given lockbox evidence of a misposted Feb-5 deposit, then response "modify" with corrected Feb/Mar statuses, AUDs to the other three bureaus within 2 BD, `credit_reporting_corrections` and `payment.reapplied` posted, late charge reversed.', async () => {
  const w = world(RECEIVED_AT);
  const id = await w.intake(acdvOf("2027091500124"));
  w.runner.recordEvidence({ dispute_id: id, evidence: [{ evidence_type: "payment_image", document_id: "doc-lockbox-deposit-2027-02-05", relied_upon: true }, { evidence_type: "allocation_trace", system_snapshot_id: "snap-suspense-2027-02-05", relied_upon: true }] });
  const inv = w.runner.investigate({ dispute_id: id, determination: "modified", confidence: 0.95, requested_at: RECEIVED_AT, findings: [{ claim: "my February 2027 payment was mailed on Feb 3", finding: "the lockbox shows the $2,459.55 check deposited 2027-02-05 and misposted to suspense", effect: "changes_outcome", why: "the Feb-1 installment was paid within the grace period; Feb/Mar statuses 71 were wrong" }] });
  assert.equal(inv.determination, "modified"); assert.equal(inv.review.required, false);
  // rule 5: the corrections row (DOFD moves with evidence), the 4.1 `payment.reapply` and the late-charge reversal
  w.clock.set("2027-09-22T14:00:00.000Z");
  const fix = w.runner.modifyCorrections(w.cycles, { dispute_id: id, correction: { fields_changed: [{ field: "account_status", before: "71", after: "11" }, { field: "payment_history_profile", before: "1", after: "0" }, { field: "date_of_first_delinquency", before: "2027-02-01", after: "2027-03-01" }], evidence_document_id: "doc-lockbox-deposit-2027-02-05", determined_on: D("2027-09-22") },
    reapply: { payment_id: "pay-lockbox-2027-02-05", deposited_on: D("2027-02-05"), amount_cents: 245955n, to_installment_due: D("2027-02-01"), from: "suspense" }, late_charges_assessed: [{ installment_due: D("2027-02-01"), assessed_on: D("2027-02-17"), amount_cents: 9236n }] });
  assert.deepEqual(fix.commands.map((c) => c.command), ["payment.reapply", "fee.reverse"]);
  assert.equal(fix.commands[0]!.effective_date, "2027-02-05"); assert.equal(fix.commands[0]!.amount_cents, "245955");
  assert.equal(fix.late_charges_reversed_cents, 9236n); assert.equal(fix.correction.aud_due, "2027-09-24");
  const corr = w.events.ofType("credit.correction.created")[0]!;
  assert.equal(corr.payload.source, "dispute_acdv"); assert.deepEqual((corr.payload.fields_changed as { field: string; after: string }[]).map((f) => [f.field, f.after]), [["account_status", "11"], ["payment_history_profile", "0"], ["date_of_first_delinquency", "2027-03-01"]]);
  assert.equal(w.events.ofType("credit.dispute.servicing_correction.requested")[0]!.payload.late_charges_reversed_cents, "9236");
  // "modify as indicated" with the corrected fields → `credit.dispute.responded{determination=modified}` arms the 2-BD fan-out (Wed 09-22 → Fri 09-24)
  const response = w.runner.responsePayload({ control_number: "2027091500124", determination: "modified", snapshot: currentSnapshot(), party_id: "A", corrections: { account_status: "11", payment_history_profile: "0".repeat(24), date_of_first_delinquency: "03012027" } });
  assert.equal(response.responseCode, RESPONSE_CODES.modified); assert.equal(response.accountFields.date_of_first_delinquency, "03012027");
  const s = await w.run(AGENT, { op: "submit", determination: "modified", fields_changed: ["account_status", "payment_history_profile", "date_of_first_delinquency"], response });
  const out = s.output as { data_changed: boolean; aud_to: Bureau[]; aud_due: string };
  assert.equal(out.data_changed, true); assert.deepEqual(out.aud_to, ["equifax", "transunion", "innovis"]); assert.equal(out.aud_due, "2027-09-24");
  const fan = w.armed("FCRA_1681S2B_D_OTHER_CRAS_AUD_BD2");
  assert.equal(fan.length, 1); assert.equal(fan[0]!.dueDate, "2027-09-24"); assert.equal(fan[0]!.dueDate, addBusinessDays(D("2027-09-22"), 2, servicer));
  // AUDs to Equifax/TransUnion/Innovis on 2027-09-23: the first two do not close the clock, the last of the set does
  const auds = await w.runner.submitAudFanOut(w.eoscar, { dispute_id: id, account_number: "SM-1001", bureaus: out.aud_to, fields: { account_status: "11", payment_history_profile: "0".repeat(24), date_of_first_delinquency: "03012027" }, reason: "8.2 dispute correction (misposted 2027-02-05 deposit)", now: "2027-09-23T15:00:00.000Z" });
  assert.deepEqual(auds.bureaus, ["equifax", "transunion", "innovis"]); assert.equal(auds.in_cycle, true);
  const submitted = w.events.ofType("eoscar.aud.submitted");
  assert.deepEqual(submitted.map((e) => [e.payload.bureau, e.payload.fan_out_complete]), [["equifax", false], ["transunion", false], ["innovis", true]]);
  const pattern = REG.get("FCRA_1681S2B_D_OTHER_CRAS_AUD_BD2")!.satisfiedPattern!;
  assert.deepEqual(submitted.map((e) => eventMatches(pattern, e)), [false, false, true]);
  assert.equal(w.satisfied("FCRA_1681S2B_D_OTHER_CRAS_AUD_BD2").length, 1); assert.equal(etDate(auds.completed_at!), "2027-09-23");
  assert.deepEqual(w.events.ofType("credit.dofd.furnished").map((e) => [e.payload.via, e.payload.dofd]), [["aud", "03012027"], ["aud", "03012027"], ["aud", "03012027"]]);
  // close: RESOLVED-RETURNEDTOAGENCY + corrections row + completed fan-out → XR (rule 6)
  w.runner.eoscarStatus({ control_number: "2027091500124", status: ACDV_RETURNED_STATUS, at: "2027-09-24T12:00:00.000Z" });
  assert.equal(w.runner.closeDispute({ dispute_id: id, determination: "modified", closed_at: "2027-09-24T12:00:00.000Z" }).ccc_transition, "XR");
});

test("8.2-T3: (due-date breach prevention) Given no reviewer action by 90% of the Response Due Date, then the case auto-escalates to `officer` and, absent action by the due date, the agent submits a best-available response (never RESOLVED-NORESPONSEPROVIDED).", async () => {
  const w = world(RECEIVED_AT);
  const { id, inv } = await investigatedAcdv(w, "2027091500125", 0.7);
  assert.equal(inv.status, "review_pending"); assert.equal(inv.review.approver, "human_agent");
  assert.equal(w.armed("SM_DISPUTE_REVIEW_SLA_BD1")[0]!.dueDate, "2027-09-16");   // 1 servicer BD from Wed 09-15
  const watch = (day: string) => w.runner.acdvDueDateWatch({ dispute_id: id, today: D(day), now: `${day}T14:00:00.000Z` }, w.escalations);
  // 16-day window: 80% → day 12 (2027-09-27) officer sev-1; 90% → day 14 (2027-09-29) auto-escalation to officer + the human_agent queue
  assert.deepEqual(watch("2027-09-26").escalated_now, []);
  assert.deepEqual(watch("2027-09-27").escalated_now, [{ to: "officer", threshold: 0.8 }]);
  assert.deepEqual(watch("2027-09-28").escalated_now, [], "idempotent per threshold");
  const at90 = watch("2027-09-29");
  assert.deepEqual(at90.escalated_now, [{ to: "officer", threshold: 0.9 }]); assert.equal(at90.plan.escalate_to, "officer"); assert.equal(at90.plan.submit_best_available, false);
  assert.deepEqual(at90.escalations.map((e) => [e.kind, e.ownerRole, e.severity ?? null]), [["officer", "officer", "sev1"], ["human_agent", "human_agent", null]]);
  assert.deepEqual(w.events.ofType("credit.dispute.escalated").map((e) => [e.payload.threshold, e.payload.to, e.payload.queue]), [[0.8, "officer", null], [0.9, "officer", "human_agent"]]);
  assert.equal(w.armed("SM_DISPUTE_REVIEW_SLA_BD1").length, 1, "the review SLA keeps running while the case escalates");
  // due date with no action: best-available response (a modify in the consumer's favour with a follow-up correction) — never silence
  w.clock.set("2027-10-01T18:00:00.000Z");
  const due = watch("2027-10-01");
  assert.equal(due.plan.submit_best_available, true); assert.equal(due.plan.determination, "modified"); assert.equal(due.plan.follow_up_correction, true); assert.equal(due.plan.never, ACDV_NO_RESPONSE_STATUS);
  // the timers keep running: the policy target (09-22) and the review SLA (09-16) are overdue; the Response Due Date row (23:59 ET) is still open
  assert.deepEqual(w.engine.evaluate("2027-10-01T18:00:00.000Z").map((b) => b.instance.code).sort(), ["SM_ACDV_INTERNAL_TARGET_CD7", "SM_DISPUTE_REVIEW_SLA_BD1"]);
  assert.equal(w.engine.byCode("FCRA_1681S2B_ACDV_RESPONSE_DUE")[0]!.status, "armed");
  await assert.rejects(w.run(AGENT, { op: "submit", response: { controlNumber: "2027091500125", responseCode: ACDV_NO_RESPONSE_STATUS, accountFields: {} } }), refused("DUE_DATE_NEVER_LAPSES"));
  assert.throws(() => w.runner.acdvResponded({ control_number: "2027091500125", response_code: ACDV_NO_RESPONSE_STATUS, determination: null, submitted_at: "2027-10-01T18:00:00.000Z" }), refused("DUE_DATE_NEVER_LAPSES"));
  const response = w.runner.responsePayload({ control_number: "2027091500125", determination: due.plan.determination, snapshot: currentSnapshot(), party_id: "A", corrections: { account_status: "11" }, narrative: "best-available response at the due date; follow-up correction to issue" });
  const s = await w.run(AGENT, { op: "submit", determination: due.plan.determination, response });
  assert.equal((s.output as { eoscar_status: string }).eoscar_status, ACDV_SUBMITTED_STATUS);
  assert.equal(w.satisfied("FCRA_1681S2B_ACDV_RESPONSE_DUE").length, 1); assert.equal(w.engine.byCode("FCRA_1681S2B_ACDV_RESPONSE_DUE")[0]!.status, "satisfied", "on time — not satisfied_late");
  assert.equal(w.events.ofType("credit.dispute.expired_no_response").length, 0);
  assert.equal(w.runner.acdvDueDateWatch({ dispute_id: id, today: D("2027-10-02"), now: "2027-10-02T14:00:00.000Z" }, w.escalations).responded, true);
});

test("8.2-T4: (view-before-submit) Given an ACDV never viewed, then `submit` is refused by the adapter until `/view` has been called.", async () => {
  const w = world(RECEIVED_AT);
  const a = acdvOf("2027091500126");
  await w.intake(a, false);
  const response = w.runner.responsePayload({ control_number: a.controlNumber, determination: "modified", snapshot: currentSnapshot(), party_id: "A", corrections: { account_status: "11" } });
  await assert.rejects(w.run(AGENT, { op: "submit", determination: "modified", response }), /2027091500126 must be viewed before a response is submitted/);
  assert.equal(w.events.ofType("credit.dispute.acdv.responded").length, 0); assert.equal(w.eoscar.responses.size, 0, "nothing reached e-OSCAR");
  assert.equal(w.armed("FCRA_1681S2B_ACDV_RESPONSE_DUE").length, 1, "the clock stays open");
  const v = await w.run(AGENT, { op: "view", control_number: a.controlNumber });
  assert.equal((v.output as Acdv).controlNumber, a.controlNumber);
  assert.equal(w.events.ofType("credit.dispute.acdv.viewed")[0]!.payload.eoscar_status, "PENDING-AWAITINGRESPONSE");
  const s = await w.run(AGENT, { op: "submit", determination: "modified", response });
  assert.equal((s.output as { eoscar_status: string }).eoscar_status, ACDV_SUBMITTED_STATUS);
  assert.equal(w.satisfied("FCRA_1681S2B_ACDV_RESPONSE_DUE").length, 1);
});

test("8.2-T5: (direct dispute clocks) Given receipt 2027-09-03, then results are mailed by 2027-10-03; given supplementation on 2027-09-20, the due date moves to 2027-10-18; supplementation on 2027-10-05 opens a new case.", async () => {
  const w = world("2027-09-03T14:00:00.000Z");
  const letter = { loan_id: "SM-1001", source: "direct_written" as const, channel: "mail" as const, received_at: "2027-09-03T14:00:00.000Z", allegations: ["my credit report shows a late payment in February 2027 that is wrong"] };
  // case A: received Fri 2027-09-03 → results due 2027-10-03 (a Sunday; policy dispatch 09-28, mail no later than Fri 10-01)
  const a = w.runner.receiveDirectDispute(letter);
  assert.equal(a.results_due_on, "2027-10-03"); assert.equal(a.dispatch_target_on, "2027-09-28"); assert.equal(a.mail_by_on, "2027-10-01"); assert.equal(a.ccc_transition, "XB");
  assert.equal(w.armed("FCRA_1022_43E_DIRECT_RESULTS_30")[0]!.dueDate, "2027-10-03"); assert.equal(w.armed("FCRA_1681S2A3_XB_FLAG_GATE").length, 1);
  // supplemented 2027-09-20 (within the 30 days): extended_to 2027-10-18; the 45-day row replaces the 30-day row
  const supp = w.runner.supplementDirectDispute({ dispute_id: a.id, supplemented_at: "2027-09-20T15:00:00.000Z", new_information: true, document_ids: ["doc-bank-statements"] }, w.engine);
  assert.equal(supp.action, "extended"); assert.equal(supp.extended_to, "2027-10-18"); assert.equal(supp.cancelled_timer_ids.length, 1);
  assert.equal(w.engine.byCode("FCRA_1022_43E_DIRECT_RESULTS_30")[0]!.status, "cancelled");
  assert.equal(w.armed("FCRA_1022_43E_DIRECT_RESULTS_EXT_45")[0]!.dueDate, "2027-10-18"); assert.equal(w.armed("FCRA_1022_43E_DIRECT_RESULTS_EXT_45")[0]!.dueDate, addDays(D("2027-09-03"), 45));
  // the results letter mailed 2027-10-13 (day 40, inside the extended period) satisfies the 45-day row
  w.clock.set("2027-10-13T15:00:00.000Z");
  const sent = await w.runner.sendResultsNotice(w.notices, { dispute_id: a.id, determination: "verified_as_reported", recipients: RECIPIENTS, items: [{ item: "February 2027 payment reported late", determination: "verified as reported", reason: "the bank statements show no February payment cleared" }], corrections: [], adverse_ai: true, sent_at: "2027-10-13T15:00:00.000Z", ...LETTER });
  assert.equal(sent.notice.status, "sent"); assert.equal(sent.mailed_by_day_30, true);
  assert.equal(w.events.ofType("notice.sent").at(-1)!.payload.template, RESULTS_TEMPLATE);
  assert.equal(w.satisfied("FCRA_1022_43E_DIRECT_RESULTS_EXT_45").length, 1);
  // case B (no supplementation): mailed Fri 2027-10-01 — before day 30 expires — satisfies the 30-day row; supplementation 2027-10-05 (after day 30) with new information opens a new case with its own clock
  const b = w.runner.receiveDirectDispute({ ...letter, loan_id: "SM-1002" });
  assert.equal(w.armed("FCRA_1022_43E_DIRECT_RESULTS_30").length, 1);
  w.clock.set("2027-10-01T15:00:00.000Z");
  const sentB = await w.runner.sendResultsNotice(w.notices, { dispute_id: b.id, determination: "verified_as_reported", recipients: RECIPIENTS, items: [{ item: "February 2027 payment reported late", determination: "verified as reported", reason: "our records show no February payment" }], corrections: [], adverse_ai: false, sent_at: "2027-10-01T15:00:00.000Z", ...LETTER });
  assert.equal(sentB.mailed_by_day_30, true); assert.equal(w.satisfied("FCRA_1022_43E_DIRECT_RESULTS_30").length, 1);
  w.clock.set("2027-10-05T15:00:00.000Z");
  const late = w.runner.supplementDirectDispute({ dispute_id: b.id, supplemented_at: "2027-10-05T15:00:00.000Z", new_information: true, document_ids: ["doc-cleared-check"] }, w.engine);
  assert.equal(late.action, "new_case"); assert.equal(late.extended_to, null); assert.equal(late.new_dispute!.results_due_at, "2027-11-04"); assert.notEqual(late.new_dispute!.id, b.id);
  assert.equal(w.events.ofType("credit.dispute.direct.received").at(-1)!.payload.supersedes_dispute_id, b.id);
  assert.equal(w.armed("FCRA_1022_43E_DIRECT_RESULTS_30")[0]!.dueDate, "2027-11-04");
  assert.equal(w.runner.supplementDirectDispute({ dispute_id: b.id, supplemented_at: "2027-10-06T15:00:00.000Z", new_information: false }, w.engine).action, "letter_referencing_prior_results");
  assert.equal(w.armed("FCRA_1022_43E_DIRECT_RESULTS_EXT_45").length, 0, "a post-day-30 supplement never extends");
});

test("8.2-T6: (frivolous notice) Given a repeat direct dispute with no new information determined frivolous on 2027-09-07 and approved by `human_agent`, then the (f) notice with reasons and the standardized information list is mailed by 2027-09-14; given the repeat includes a new bank statement, the case is investigated instead.", async () => {
  const w = world("2027-09-01T14:00:00.000Z");
  const repeat = w.runner.receiveDirectDispute({ loan_id: "SM-1001", source: "direct_written", channel: "mail", received_at: "2027-09-01T14:00:00.000Z", allegations: ["my credit report shows me late in February 2027 and I was not"] });
  const det = { dispute_id: repeat.id, determined_on: D("2027-09-07"), basis: "f2_substantially_same" as const, repeat: true, new_information: false, reasons: ["it is substantially the same as the dispute we investigated on 2027-06-10 and contains no new information"], required_information: ["the specific account information you dispute", "why you believe it is inaccurate", "supporting documents such as a cleared check image"] };
  assert.throws(() => w.runner.determineFrivolous(det, AGENT), refused("FRIVOLOUS_NEEDS_HUMAN"), "made only by a human reviewer (rule 7)");
  w.clock.set("2027-09-07T16:00:00.000Z");
  const f = w.runner.determineFrivolous(det, HUMAN_AGENT);
  assert.equal(f.notice_due_on, "2027-09-14"); assert.equal(f.notice_due_on, addBusinessDays(D("2027-09-07"), 5, federal)); assert.equal(f.approved_by, HUMAN_AGENT.id);
  assert.equal(w.armed("FCRA_1022_43F_FRIVOLOUS_NOTICE_5BD")[0]!.dueDate, "2027-09-14");
  // the (f) notice: reasons + the standardized list, mailed Tue 2027-09-14 (5 federal business days)
  w.clock.set("2027-09-14T15:00:00.000Z");
  const n = await w.runner.sendFrivolousNotice(w.notices, { dispute_id: repeat.id, recipients: RECIPIENTS, sent_at: "2027-09-14T15:00:00.000Z", ...LETTER });
  assert.equal(n.notice.templateCode, FRIVOLOUS_TEMPLATE); assert.equal(n.notice.status, "sent"); assert.equal(n.mailed_by_due, true); assert.equal(n.business_days_after_determination, 5);
  assert.equal(n.notice.deliveries[0]!.channel, "mail_first_class", "by mail unless the consumer authorized another means");
  assert.match(n.notice.rendered.text, /cannot investigate it because it is substantially the same/); assert.match(n.notice.rendered.text, /please send the following information to PO Box 2, Testville TX 75001: the specific account information you dispute;/);
  assert.equal(w.satisfied("FCRA_1022_43F_FRIVOLOUS_NOTICE_5BD").length, 1);
  assert.equal(w.runner.closeDispute({ dispute_id: repeat.id, determination: "frivolous", closed_at: "2027-09-14T16:00:00.000Z" }).status, "closed_frivolous");
  // the repeat that includes a new bank statement is not "substantially the same" (§1022.43(f)(1)(ii)) — it is investigated
  const withNew = w.runner.receiveDirectDispute({ loan_id: "SM-1002", source: "direct_written", channel: "mail", received_at: "2027-09-01T14:00:00.000Z", allegations: ["my credit report shows me late in February 2027 and I was not"], image_document_ids: ["doc-bank-statement-2027-02"] });
  assert.throws(() => w.runner.determineFrivolous({ ...det, dispute_id: withNew.id, new_information: true }, HUMAN_AGENT), refused("NOT_FRIVOLOUS_NEW_INFORMATION"));
  w.runner.recordEvidence({ dispute_id: withNew.id, evidence: [{ evidence_type: "borrower_submission", document_id: "doc-bank-statement-2027-02", relied_upon: true }, ...LOCKBOX_EVIDENCE] });
  const inv = w.runner.investigate({ dispute_id: withNew.id, determination: "verified_as_reported", confidence: 0.9, requested_at: "2027-09-07T16:00:00.000Z", findings: [{ claim: "the bank statement shows a February payment", finding: "the statement shows a debit to a different payee", effect: "no_change", why: "no February receipt reached the lockbox" }] });
  assert.equal(inv.status, "investigating"); assert.equal(w.armed("FCRA_1022_43F_FRIVOLOUS_NOTICE_5BD").length, 0);
});

test("8.2-T7: (XB flag) Given any open dispute, then the next Metro 2 file (or an AUD if >10 days away) carries XB on the consumer's segment; on close with correction, XR; on verified with stated disagreement, XC.", async () => {
  const w = world(RECEIVED_AT);
  // received 2027-09-15 with the next cycle transmitting 2027-10-04 (19 days away) → XB by AUD now, and in the next file
  const id = await w.intake(acdvOf("2027091500127"));
  w.runner.recordEvidence({ dispute_id: id, evidence: LOCKBOX_EVIDENCE });
  const flag = w.events.ofType("credit.dispute.received")[0]!;
  assert.equal(flag.payload.ccc, "XB"); assert.equal(flag.payload.ccc_via, "next_cycle", "no next-cycle date on the poll → carried in the next file");
  const late = w.runner.receiveDirectDispute({ loan_id: "SM-1002", source: "direct_written", channel: "mail", received_at: RECEIVED_AT, allegations: ["my credit report is wrong about my balance"], next_cycle_transmit_on: D("2027-10-04") });
  assert.equal(late.ccc_via, "aud");
  const xbAud = await w.runner.submitAudFanOut(w.eoscar, { dispute_id: late.id, account_number: "SM-1002", bureaus: ["equifax", "experian", "transunion", "innovis"], fields: { compliance_condition_code: "XB" }, reason: "§1681s-2(a)(3) dispute flag", now: "2027-09-16T15:00:00.000Z", purpose: "dispute_flag" });
  assert.equal(xbAud.bureaus.length, 4); assert.ok(w.events.ofType("eoscar.aud.submitted").every((e) => e.payload.purpose === "dispute_flag" && e.payload.fan_out_complete === false));
  assert.equal(w.armed("FCRA_1681S2A3_XB_FLAG_GATE").length, 2);
  // the next Metro 2 file: the 8.1 render asserts XB on the disputed consumer's segment while the dispute is open
  const plain = currentSnapshot();
  const flagged = applyOverlayCodes(plain, { mechanism: "flag_only", codes: ["XB"], reasons: ["dispute_open"] }, "A");
  w.cycles.open("2027-09", D("2027-09-30"));
  const ok = w.cycles.build({ cycle_id: "2027-09", as_of: D("2027-09-30"), records: [{ snapshot: flagged, b1_on_file: true }], config: CONFIG });
  assert.equal(ok.included[0]!.consumers[0]!.ccc, "XB");
  assert.deepEqual(xbGateAssertion(ok, [{ loan_id: "SM-1001", party_id: "A" }]), { asserted: true, records_checked: 1 });
  const bare = w.cycles.build({ cycle_id: "2027-09b", as_of: D("2027-09-30"), records: [{ snapshot: plain, b1_on_file: true }], config: CONFIG });
  assert.throws(() => xbGateAssertion(bare, [{ loan_id: "SM-1001", party_id: "A" }]), refused("XB_FLAG_GATE"));
  // close with correction → XR (the corrections row and the completed fan-out are required first)
  w.runner.investigate({ dispute_id: id, determination: "modified", confidence: 0.95, requested_at: RECEIVED_AT, findings: [{ claim: "the check was mailed Feb 3", finding: "deposited 2027-02-05, misposted", effect: "changes_outcome", why: "paid within grace" }] });
  const response = w.runner.responsePayload({ control_number: "2027091500127", determination: "modified", snapshot: plain, party_id: "A", corrections: { account_status: "11" } });
  await w.run(AGENT, { op: "submit", determination: "modified", response });
  w.runner.eoscarStatus({ control_number: "2027091500127", status: ACDV_RETURNED_STATUS, at: "2027-09-23T12:00:00.000Z" });
  assert.throws(() => w.runner.closeDispute({ dispute_id: id, determination: "modified", closed_at: "2027-09-23T12:00:00.000Z" }), refused("CORRECTION_ROW_REQUIRED"));
  w.cycles.createCorrection({ loan_id: "SM-1001", source: "dispute_acdv", fields_changed: [{ field: "account_status", before: "71", after: "11" }], determined_on: D("2027-09-22") });
  assert.throws(() => w.runner.closeDispute({ dispute_id: id, determination: "modified", closed_at: "2027-09-23T12:00:00.000Z" }), refused("AUD_FANOUT_REQUIRED"));
  await w.runner.submitAudFanOut(w.eoscar, { dispute_id: id, account_number: "SM-1001", bureaus: ["equifax", "transunion", "innovis"], fields: { account_status: "11" }, reason: "correction", now: "2027-09-23T15:00:00.000Z" });
  const xr = w.runner.closeDispute({ dispute_id: id, determination: "modified", closed_at: "2027-09-23T16:00:00.000Z" });
  assert.equal(xr.ccc_transition, "XR"); assert.equal(xr.open_disputes_remaining, 0, "counted per loan");
  assert.equal(w.satisfied("FCRA_1681S2A3_XB_FLAG_GATE").length, 1);
  // verified with the consumer's stated continuing disagreement → XC
  const xc = w.runner.closeDispute({ dispute_id: late.id, determination: "verified_as_reported", continuing_disagreement: true, closed_at: "2027-10-01T16:00:00.000Z", mailing_evidence_document_id: "doc-mail-proof-results" });
  assert.equal(xc.ccc_transition, "XC"); assert.equal(xc.status, "closed");
  assert.equal(w.satisfied("FCRA_1681S2A3_XB_FLAG_GATE").length, 2); assert.equal(w.armed("FCRA_1681S2A3_XB_FLAG_GATE").length, 0);
  assert.deepEqual(w.events.ofType("credit.dispute.closed").map((e) => [e.payload.ccc_from, e.payload.ccc_transition]), [["XB", "XR"], ["XB", "XC"]]);
});

test("8.2-T8: (unverifiable pre-boarding) Given a dispute about a 2026 late mark reported by the transferor and no hand-off evidence, then determination `unverifiable`, the item is deleted/modified, and the transferor is notified.", () => {
  const w = world("2027-09-10T14:00:00.000Z");
  const dd = w.runner.receiveDirectDispute({ loan_id: "SM-1005", source: "direct_written", channel: "mail", received_at: "2027-09-10T14:00:00.000Z", allegations: ["my credit report shows a late payment in June 2026 from my old servicer and I was never late"] });
  const base = { dispute_id: dd.id, boarded_on: D("2027-01-15"), transferor: { name: "OldCo Servicing", contact: "transfers@oldco.example" }, substantiated: false, reported_php_char: "1", determined_on: D("2027-09-10"), requested_at: "2027-09-10T15:00:00.000Z", confidence: 0.9 };
  assert.throws(() => w.runner.preBoardingInvestigation(w.cycles, { ...base, disputed_month: D("2027-03-01"), transferor_record: false, boarding_reconciliation: false }), refused("NOT_PRE_BOARDING"));
  const r = w.runner.preBoardingInvestigation(w.cycles, { ...base, disputed_month: D("2026-06-01"), transferor_record: false, boarding_reconciliation: false });
  assert.equal(r.determination, "unverifiable");
  assert.deepEqual(r.correction!.fields_changed, [{ field: "payment_history_profile[2026-06]", before: "1", after: "D" }]); assert.equal(r.correction!.source, "dispute_direct"); assert.equal(r.correction!.aud_due, "2027-09-14");
  assert.deepEqual(r.transferor_notification, { to: "OldCo Servicing", kind: "dispute_unverifiable_records_request", respond_by: "2027-09-17" });   // 5 servicer BD from Fri 09-10
  assert.equal(r.transferor_notification!.respond_by, addBusinessDays(D("2027-09-10"), 5, servicer));
  assert.equal(r.review.approver, "human_agent"); assert.ok(r.review.conditions.includes(7), "condition (7): pre-boarding with incomplete prior-servicer records");
  assert.equal(w.armed("SM_DISPUTE_REVIEW_SLA_BD1").length, 1);
  const notified = w.events.ofType("credit.dispute.transferor_notified")[0]!;
  assert.equal(notified.loanId, "SM-1005"); assert.equal(notified.payload.disputed_month, "2026-06-01"); assert.equal(notified.payload.determination, "unverifiable");
  assert.equal(w.events.ofType("credit.correction.created")[0]!.loanId, "SM-1005");
  assert.equal(w.events.ofType("credit.dispute.investigated")[0]!.payload.determination, "unverifiable");
  // with the transferor's record substantiating the mark (an evidence row relied upon) the item is verified and nothing is corrected
  w.runner.recordEvidence({ dispute_id: dd.id, evidence: [{ evidence_type: "prior_servicer_record", document_id: "doc-oldco-history-2026", relied_upon: true }] });
  const ok = w.runner.preBoardingInvestigation(w.cycles, { ...base, disputed_month: D("2026-06-01"), transferor_record: true, boarding_reconciliation: true, substantiated: true });
  assert.equal(ok.determination, "verified_as_reported"); assert.equal(ok.correction, null); assert.equal(ok.transferor_notification, null);
});

test("8.2-T9: (identity theft) Given an ACDV with an identity-theft dispute code and a §1681c-2 block notification, then furnishing for that consumer stops immediately, a `fraud` case opens, and `officer` approves any DF/ECOA Z.", async () => {
  const w = world(RECEIVED_AT);
  const id = await w.intake(acdvOf("2027091500128", { disputeCodes: ["003"], images: [] }));
  assert.equal(w.events.ofType("credit.dispute.acdv.received")[0]!.payload.category, "identity_theft");
  const r = w.runner.identityTheftIntake({ dispute_id: id, party_id: "A", block_notice: { control_number: "BLK-2027091500128", cra: "experian", received_at: "2027-09-15T14:00:00.000Z", identity_theft_report_id: "itr-ftc-2027-0915" }, never_liable: true, requested_at: "2027-09-15T14:05:00.000Z" });
  assert.equal(r.furnishing_stops_immediately, true); assert.equal(r.omitted_from_cycle_as_of, "2027-09-30"); assert.equal(r.fraud_case, true);
  assert.equal(r.suppression.mechanism, "delete_consumer"); assert.deepEqual(r.suppression.codes, ["ECOA Z"]); assert.equal(r.suppression.reason, "identity_theft");
  assert.equal(r.delete_requires, "officer"); assert.equal(r.review.approver, "officer"); assert.deepEqual(r.review.conditions, [2, 3]);
  const block = w.events.ofType("credit.block.notice.received")[0]!;
  assert.equal(block.payload.kind, "Block"); assert.equal(block.payload.identity_theft_report_id, "itr-ftc-2027-0915"); assert.equal(block.payload.action, "omit_account_immediately_and_open_fraud_case");
  assert.equal(w.events.ofType("case.fraud.opened")[0]!.payload.party_id, "A");
  assert.equal(w.armed("SM_DISPUTE_REVIEW_SLA_BD1")[0]!.dueDate, "2027-09-16");
  // the ECOA Z / DF delete is an officer decision on every path: the review, the corrections row, the response tool
  assert.throws(() => w.runner.recordReview({ dispute_id: id, action: "approve", rationale: "consumer never had liability", reviewed_at: "2027-09-15T15:00:00.000Z" }, HUMAN_AGENT), refused("OFFICER_REQUIRED"));
  assert.throws(() => w.cycles.createCorrection({ loan_id: "SM-1001", source: "dispute_acdv", fields_changed: [{ field: "ecoa", before: "1", after: "Z" }], determined_on: D("2027-09-15") }), refused("OFFICER_REQUIRED"));
  const response = w.runner.responsePayload({ control_number: "2027091500128", determination: "deleted_consumer", snapshot: currentSnapshot(), party_id: "A" });
  assert.equal(response.accountFields.ecoa, "Z"); assert.equal(response.responseCode, RESPONSE_CODES.deleted_consumer);
  await assert.rejects(w.run(AGENT, { op: "submit", determination: "deleted_consumer", officer_approved: true, response }), refused("DELETE_NEEDS_OFFICER"));
  assert.equal(w.events.ofType("credit.dispute.acdv.responded").length, 0);
  const rev = w.runner.recordReview({ dispute_id: id, action: "approve", rationale: "§1681c-2 block; no liability from this consumer", reviewed_at: "2027-09-15T15:00:00.000Z" }, OFFICER);
  assert.equal(rev.payload.reviewer_role, "officer"); assert.equal(rev.payload.determination, "deleted_consumer");
  assert.equal(w.satisfied("SM_DISPUTE_REVIEW_SLA_BD1").length, 1);
  assert.equal(w.cycles.createCorrection({ loan_id: "SM-1001", source: "dispute_acdv", fields_changed: [{ field: "ecoa", before: "1", after: "Z" }], determined_on: D("2027-09-15") }, OFFICER).correction.requires_officer, true);
  const s = await w.run(OFFICER, { op: "submit", determination: "deleted_consumer", response });
  assert.equal((s.output as { data_changed: boolean }).data_changed, true);
  assert.equal(w.armed("FCRA_1681S2B_D_OTHER_CRAS_AUD_BD2").length, 1, "a delete fans out to the other bureaus");
});

test(`8.2-T10: (oral dispute) Given a borrower says on an AI voice call that "my credit report shows me late in March and I wasn't," then a direct-dispute case opens, XB applies, and the results letter goes out within 30 days.`, async () => {
  const r = oralDisputeIntake({ utterance: "my credit report shows me late in March and I wasn't", received_on: D("2027-09-03"), next_cycle_transmit_on: D("2027-10-03"), automation_disclosed: true });
  assert.equal(r.opens_case, true); assert.equal(r.channel, "oral"); assert.equal(r.category, "payment_history"); assert.equal(r.ccc, "XB"); assert.equal(r.ccc_via, "aud");
  assert.equal(r.results_due, "2027-10-03"); assert.equal(r.results_template, "NTC_FCRA_1022_43E_RESULTS"); assert.equal(r.automation_disclosed, true); assert.equal(r.human_transfer_requested, false);
  assert.equal(oralDisputeIntake({ utterance: "what is my payoff amount", received_on: D("2027-09-03"), next_cycle_transmit_on: D("2027-10-03"), automation_disclosed: true }).opens_case, false);
  // the case itself: logged as a contact with credit_dispute_asserted, the 30-day clock armed, the results letter sent inside it
  const w = world("2027-09-03T15:30:00.000Z");
  const oral = w.runner.receiveDirectDispute({ loan_id: "SM-1001", source: "direct_oral", received_at: "2027-09-03T15:30:00.000Z", allegations: ["my credit report shows me late in March and I wasn't"], next_cycle_transmit_on: D("2027-10-03"), automation_disclosed: true });
  assert.equal(oral.opens_case, true); assert.equal(oral.results_due_on, "2027-10-03"); assert.equal(oral.ccc_via, "aud"); assert.equal(oral.category, "payment_history");
  assert.deepEqual(w.events.ofType("credit.dispute.direct.received")[0]!.payload.contact_log, { credit_dispute_asserted: true, automation_disclosed: true, human_transfer_requested: false });
  assert.equal(w.armed("FCRA_1022_43E_DIRECT_RESULTS_30")[0]!.dueDate, "2027-10-03"); assert.equal(w.events.ofType("credit.dispute.received")[0]!.payload.ccc, "XB");
  assert.throws(() => w.runner.receiveDirectDispute({ loan_id: "SM-1001", source: "direct_oral", received_at: "2027-09-03T15:30:00.000Z", allegations: ["what is my payoff amount"], automation_disclosed: true }), refused("NOT_A_CREDIT_DISPUTE"));
  w.clock.set("2027-09-28T15:00:00.000Z");
  const sent = await w.runner.sendResultsNotice(w.notices, { dispute_id: oral.id, determination: "verified_as_reported", recipients: RECIPIENTS, items: [{ item: "March 2027 payment reported late", determination: "verified as reported", reason: "the March 1 installment was received April 20" }], corrections: [], adverse_ai: true, sent_at: "2027-09-28T15:00:00.000Z", ...LETTER });
  assert.equal(sent.mailed_by_day_30, true); assert.equal(w.satisfied("FCRA_1022_43E_DIRECT_RESULTS_30").length, 1);
});

test("8.2-T11: (API outage) Given e-OSCAR API 5xx for 4 hours with a response due tomorrow, then a `human_agent` task is created with the response payload for web-app entry.", async () => {
  const w = world("2027-09-30T13:00:00.000Z");
  w.runner.acdvPollTick("2027-09-30T13:00:00.000Z");
  const id = await w.intake(acdvOf("2027091500129", { receivedAt: "2027-09-28T12:00:00.000Z", responseDueOn: "2027-10-01" }));
  const response = w.runner.responsePayload({ control_number: "2027091500129", determination: "modified", snapshot: currentSnapshot(), party_id: "A", corrections: { account_status: "11" } });
  // the API returns 5xx from 13:00: two consecutive failed polls raise the alarm (SM_ACDV_POLL_15M stays open; a human checks the web app)
  w.eoscar.transientRemaining = 2;
  const p1 = await w.runner.pollAcdvs(w.eoscar, { now: "2027-09-30T13:15:00.000Z", loan_id_for: () => "SM-1001" });
  const p2 = await w.runner.pollAcdvs(w.eoscar, { now: "2027-09-30T13:30:00.000Z", loan_id_for: () => "SM-1001" });
  assert.deepEqual([p1.ok, p1.consecutive_failures, p1.alarm], [false, 1, false]); assert.deepEqual([p2.ok, p2.consecutive_failures, p2.alarm, p2.action], [false, 2, true, "human_agent_checks_web_app"]);
  assert.equal(w.events.ofType("eoscar.poll.alarm").length, 1); assert.equal(w.armed("SM_ACDV_POLL_15M").length, 1); assert.equal(w.satisfied("SM_ACDV_POLL_15M").length, 1, "only the intake poll succeeded; the re-armed row waits");
  // four hours in, with the response due tomorrow: route to the web app with the exact payload
  w.clock.set("2027-09-30T17:00:00.000Z");
  const r = w.runner.outageFallback({ dispute_id: id, response, today: D("2027-09-30"), now: "2027-09-30T17:00:00.000Z", outage_started_at: "2027-09-30T13:00:00.000Z", error: "HTTP 503 from /acdvresp/v12/submit" }, w.escalations);
  assert.equal(r.route, "human_web_app"); assert.equal(r.outage_hours, 4);
  assert.equal(r.task!.kind, "human_agent"); assert.equal(r.task!.ownerRole, "human_agent"); assert.equal(r.task!.loanId, "SM-1001"); assert.equal(r.task!.status, "open");
  const payload = r.task!.payload as { task: string; response_due_on: string; response_payload: { controlNumber: string; responseCode: string; accountFields: Record<string, string> }; credentials: string };
  assert.equal(payload.task, "eoscar_web_app_entry"); assert.equal(payload.response_due_on, "2027-10-01"); assert.equal(payload.response_payload.controlNumber, "2027091500129");
  assert.equal(payload.response_payload.responseCode, RESPONSE_CODES.modified); assert.equal(payload.response_payload.accountFields.account_status, "11"); assert.match(payload.credentials, /interactive/);
  assert.equal(w.events.ofType("escalation.created")[0]!.payload.kind, "human_agent");
  assert.equal(w.events.ofType("credit.dispute.outage.routed")[0]!.payload.route, "human_web_app");
  // a response due in ten days waits for the API instead
  const later = await w.intake(acdvOf("2027091500130", { receivedAt: "2027-09-28T12:00:00.000Z", responseDueOn: "2027-10-10" }));
  assert.deepEqual(w.runner.outageFallback({ dispute_id: later, response: { ...response, controlNumber: "2027091500130" }, today: D("2027-09-30"), now: "2027-09-30T17:00:00.000Z", outage_started_at: "2027-09-30T13:00:00.000Z", error: "HTTP 503" }, w.escalations).route, "wait_for_api");
  assert.equal(w.escalations.opened.length, 1);
});

test("8.2-T12: (reviewer conditions) Given `verified_as_reported` at confidence 0.7, then the case waits for `human_agent` review with the evidence pack; given confidence 0.9 and no other condition, it submits without review.", async () => {
  const w = world(RECEIVED_AT);
  const low = await investigatedAcdv(w, "2027091500131", 0.7);
  assert.equal(low.inv.status, "review_pending"); assert.equal(low.inv.review.approver, "human_agent"); assert.deepEqual(low.inv.review.conditions, [1]);
  const req = w.events.ofType("credit.dispute.review_requested")[0]!;
  assert.equal(req.payload.approver, "human_agent"); assert.equal(req.payload.sla, "1 business_days_servicer");
  const pack = req.payload.evidence_pack as { draft_determination: string; confidence: number; evidence: unknown[]; images: string[]; findings: unknown[]; timers: { response_due_on: string; keep_running: boolean }; summary: string };
  assert.equal(pack.draft_determination, "verified_as_reported"); assert.equal(pack.confidence, 0.7); assert.equal(pack.evidence.length, 2); assert.deepEqual(pack.images, ["doc-check-copy-2027-02-03"]); assert.equal(pack.findings.length, 1);
  assert.deepEqual(pack.timers, { response_due_on: "2027-10-01", results_due_on: null, escalate_on: "2027-09-29", keep_running: true }); assert.match(pack.summary, /draft verified_as_reported at 0.7/);
  assert.equal(w.armed("SM_DISPUTE_REVIEW_SLA_BD1")[0]!.dueDate, "2027-09-16");
  assert.throws(() => w.runner.recordReview({ dispute_id: low.id, action: "approve", rationale: "ok", reviewed_at: RECEIVED_AT }, AGENT), refused("REVIEWER_ROLE"));
  w.clock.set("2027-09-16T14:00:00.000Z");
  const rev = w.runner.recordReview({ dispute_id: low.id, action: "approve", rationale: "the lockbox search covered Feb–Apr; verified", reviewed_at: "2027-09-16T14:00:00.000Z" }, HUMAN_AGENT);
  assert.equal(rev.payload.reviewer_id, HUMAN_AGENT.id); assert.equal(w.satisfied("SM_DISPUTE_REVIEW_SLA_BD1").length, 1);
  assert.equal(w.runner.acdvDueDateWatch({ dispute_id: low.id, today: D("2027-09-29"), now: "2027-09-29T14:00:00.000Z" }, w.escalations).escalated_now.length, 0, "reviewed — no 90% auto-escalation");
  // confidence 0.9 and no other condition: no review request; the response submits straight away
  const high = await investigatedAcdv(w, "2027091500132", 0.9);
  assert.equal(high.inv.status, "investigating"); assert.equal(high.inv.review.required, false); assert.equal(high.inv.review.approver, null);
  assert.equal(w.events.ofType("credit.dispute.review_requested").length, 1); assert.equal(w.armed("SM_DISPUTE_REVIEW_SLA_BD1").length, 0);
  const response = w.runner.responsePayload({ control_number: "2027091500132", determination: "verified_as_reported", snapshot: currentSnapshot(), party_id: "A" });
  const s = await w.run(AGENT, { op: "submit", determination: "verified_as_reported", evidence_ids: ["snap-ledger-2027-02..04"], response });
  assert.equal((s.output as { eoscar_status: string }).eoscar_status, ACDV_SUBMITTED_STATUS);
  assert.equal(w.events.ofType("credit.dispute.reviewed").filter((e) => e.payload.dispute_id === high.id).length, 0);
  // condition (1) is verified-only, and a verified response never goes out without evidence rows
  const none = await w.intake(acdvOf("2027091500133"));
  assert.throws(() => w.runner.investigate({ dispute_id: none, determination: "verified_as_reported", confidence: 0.99, requested_at: RECEIVED_AT, findings: [{ claim: "x", finding: "y", effect: "no_change", why: "z" }] }), refused("VERIFIED_NEEDS_EVIDENCE"));
  await assert.rejects(w.run(AGENT, { op: "submit", determination: "verified_as_reported", response: { ...response, controlNumber: "2027091500133" } }), refused("VERIFIED_NEEDS_EVIDENCE"));
  await assert.rejects(w.run(AGENT, { op: "submit", response: { ...response, controlNumber: "2027091500133" } }), refused("VERIFIED_NEEDS_EVIDENCE"), "the \"accurate as reported\" code without a determination is still a verified response");
});

test("8.2-T13: (NoE linkage) Given a letter alleging a misapplied payment and a wrong credit report, then both an NoE case (4.1) and a direct dispute exist, the corrections are shared, and both letters meet their clocks.", () => {
  const r = linkedNoeDispute({ received_on: D("2027-09-03"), allegations: ["you misapplied my February payment", "my credit report shows a late payment that is wrong"] });
  assert.equal(r.noe_case!.opens, true); assert.equal(r.noe_case!.response_due, "2027-10-19");   // 30 servicer BD from Fri 09-03 (Labor Day 09-06, Columbus Day 10-11 closed)
  assert.equal(r.direct_dispute!.opens, true); assert.equal(r.direct_dispute!.results_due, "2027-10-03");   // 30 calendar days (§1022.43(e))
  assert.equal(r.shared_corrections, true); assert.equal(r.combined_letter_allowed, true); assert.equal(r.earlier_clock, "2027-10-03");
  assert.equal(linkedNoeDispute({ received_on: D("2027-09-03"), allegations: ["my credit report is wrong"] }).noe_case, null);
  // the case: one letter → the direct dispute plus the linked NoE record, each with its own clock
  const w = world("2027-09-03T14:00:00.000Z");
  const dd = w.runner.receiveDirectDispute({ loan_id: "SM-1001", source: "direct_written", channel: "mail", received_at: "2027-09-03T14:00:00.000Z", allegations: ["you misapplied my February payment", "my credit report shows a late payment that is wrong"] });
  assert.equal(dd.noe_linked, true); assert.equal(dd.noe_response_due_on, "2027-10-19"); assert.equal(dd.results_due_on, "2027-10-03");
  const link = w.events.ofType("credit.dispute.noe_linked")[0]!;
  assert.equal(link.payload.shared_corrections, true); assert.equal(link.payload.combined_letter_allowed, true); assert.equal(link.payload.earlier_clock, "2027-10-03"); assert.equal(link.payload.noe_case_id, `noe-${dd.id}`);
  assert.equal(w.armed("FCRA_1022_43E_DIRECT_RESULTS_30")[0]!.dueDate, "2027-10-03");
});

test("8.2-T14: (AUD is not in-cycle) Given an AUD sent on 2027-09-25, then the 2027-09-30 cycle still carries the corrected values (no reliance on the AUD alone).", async () => {
  const w = world("2027-09-24T14:00:00.000Z");
  const id = await w.intake(acdvOf("2027091500134", { receivedAt: "2027-09-20T12:00:00.000Z", responseDueOn: "2027-10-06" }));
  // the correction (Feb/Mar statuses → 11) and its AUD on 2027-09-25
  w.cycles.createCorrection({ loan_id: "SM-1001", source: "dispute_acdv", fields_changed: [{ field: "account_status", before: "71", after: "11" }], determined_on: D("2027-09-24") });
  await assert.rejects(w.runner.submitAudFanOut(w.eoscar, { dispute_id: id, account_number: "SM-1001", bureaus: ["equifax", "transunion", "innovis"], fields: { account_status: "11" }, reason: "correction", now: "2027-09-25T15:00:00.000Z", skip_next_cycle: true }), refused("AUD_NOT_IN_CYCLE_SUBSTITUTE"));
  const aud = await w.runner.submitAudFanOut(w.eoscar, { dispute_id: id, account_number: "SM-1001", bureaus: ["equifax", "transunion", "innovis"], fields: { account_status: "11" }, reason: "correction", now: "2027-09-25T15:00:00.000Z" });
  assert.equal(etDate(aud.completed_at!), "2027-09-25"); assert.equal(aud.in_cycle, true);
  // the 2027-09-30 cycle is built from the 8.1 snapshot logic — the corrected value is in every bureau's file, AUD or not
  const corrected = currentSnapshot();
  w.cycles.open("2027-09", D("2027-09-30"));
  const b = w.cycles.build({ cycle_id: "2027-09", as_of: D("2027-09-30"), records: [{ snapshot: applyOverlayCodes(corrected, { mechanism: "flag_only", codes: ["XB"], reasons: ["dispute_open"] }, "A"), b1_on_file: true }], config: CONFIG });
  assert.equal(b.status, "validated"); assert.equal(b.files.length, 4);
  for (const f of b.files) assert.equal(f.records[0]!.account_status, "11", `${f.bureau} file carries the corrected status`);
  const r = audAndCycle({ aud_sent_on: D("2027-09-25"), cycle_as_of: D("2027-09-30"), corrected_fields: { account_status: "11", date_of_first_delinquency: "00000000", amount_past_due: "000000000" }, snapshot_fields: renderBase(b.included[0]!) });
  assert.equal(r.aud_in_cycle_substitute, false); assert.equal(r.cycle_carries_correction, true); assert.deepEqual(r.mismatches, []);
  assert.deepEqual(audAndCycle({ aud_sent_on: D("2027-09-25"), cycle_as_of: D("2027-09-30"), corrected_fields: { account_status: "11" }, snapshot_fields: { account_status: "71" } }).mismatches, ["account_status"]);
});

test("8.2 worked example: the disputed check copy is for one PITI installment of $2,459.55", () => {
  // Rule 10: SM-1001's PITI = P&I on $300,000.00 at 6.250% over 360 months ($1,847.15, 8.1 rule 13) + escrow $612.40.
  const pi = levelPayment(30000000n, ratePercent("6.25"), 360);
  assert.equal(pi, 184715n);
  assert.equal(pi + 61240n, 245955n);
});
