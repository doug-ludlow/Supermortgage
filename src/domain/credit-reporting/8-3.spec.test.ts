// 8.3 Suspend credit reporting
// spec/sections/08-credit-reporting/8-3-suspend-credit-reporting.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths, addDays } from "../../kernel/calendar/date.ts";
import { cents, levelPayment, ratePercent, monthlyInterest } from "../../kernel/money/cents.ts";
import { applyFifo, type AppliedInstallment } from "../boarding/delinquency.ts";
import {
  buildSnapshot, renderBase, type CreditLoanState, type PriorHistory, type LoanCondition, type Metro2Snapshot,
  applyNoeBar, noeBarEnd, bankruptcyOverlay, scraReducedPayment, scraOverlay, disasterOverlay, deceasedOverlay, identityTheftResponse,
  fdcpaGateIncludes, fdcpaGateOpensOn, sampleVerification, courtesyRequest, resolveSuppression, SCRA_CAP, type Suppression, type FdcpaGateInput,
} from "./index.ts";
import { buildCycle, CreditCycleRunner, CreditReportingRefused, staleSuppressionReview, type BureauConfig } from "./ops.ts";
import { OverlayRunner, applyOverlayMechanisms, MemoryRecords, nextCycleSnapshotOn, COURTESY_RESPONSE, COURTESY_SCRIPT, SUPPRESSIONS, COURTESY_REQUESTS, NOE_BAR_DAYS } from "./ops-8-3.ts";
import { finalReportedAfter, nextCycleCandidates } from "./ops-8-1.ts";
import { reliefStarted } from "../foreclosure/ops-13-8.ts";
import { fdcpaStatusAtBoarding, recordValidationSent, fdcpaSweep, recordConversation } from "../early-intervention/fdcpa.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { RoleDenied } from "../../app/roles.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { SECTION_08_TOOLS } from "../../app/tools/section08.ts";
import { EscalationService } from "../../app/escalations.ts";
import { FakeEoscar } from "../../infra/integrations/credit.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { Bureau } from "./disputes.ts";

// ---- fixtures: loan SM-1001 (8.1 rule 13), four bureaus, actors, the bus with the §8 tools, the registry after every override ----
const AGENT: Actor = { kind: "agent", id: "credit-reporting" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const CONFIG: Record<Bureau, BureauConfig> = { equifax: { program_identifier: "EFX-PROG", subscriber_code: "EFX123", file_naming: "SM_{cycle}_{bureau}.m2" }, experian: { program_identifier: "EXP-PROG", subscriber_code: "EXP123", file_naming: "SM_{cycle}_{bureau}.m2" }, transunion: { program_identifier: "TU-PROG", subscriber_code: "TU123", file_naming: "SM_{cycle}_{bureau}.m2" }, innovis: { program_identifier: "INV-PROG", subscriber_code: "INV123", file_naming: "SM_{cycle}_{bureau}.m2" } };
const PI = cents("1847.15"), ESCROW = cents("612.40"), PITI = PI + ESCROW;
const RATE = ratePercent("6.25");
const toolKey = (process: string, name: string): string => `${process} ${name}`;
function bindSection08(rt: ToolRuntime, agents: AgentRegistry): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of SECTION_08_TOOLS) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); out.set(toolKey(d.process, d.name), cmd); }
  return out;
}
/** The bus, the record store, the escalation service and the TimerEngine over one event log (the 8.3 rows live under 4.1/8.1/8.3/14.4 in the registry). */
function harness(now: string, loanId = "SM-1001") {
  const agents = new AgentRegistry(); const clock = new FixedClock(now); const events = new MemoryEventStore(clock);
  const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["4.1", "8.1", "8.2", "8.3", "14.4"] });
  const escalations = new EscalationService(events, clock);
  const ctx: UowContext = { loanId, events, ledger: new MemoryLedger(), timers: engine, clock, decide: () => {} };
  const eoscar = new FakeEoscar();
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: {}, ports: { eoscar } };
  const cmds = bindSection08(rt, agents); const bus = new CommandBus(agents);
  const exec = async (name: string, actor: Actor, input: ToolInput): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("8.3", name))!, actor, input, ctx)).output as Record<string, unknown>;
  const armed = (code: string) => engine.byCode(code).filter((t) => t.status === "armed");
  const satisfied = (code: string) => engine.byCode(code).filter((t) => t.status === "satisfied" || t.status === "satisfied_late");
  const runner = new OverlayRunner({ events, actor: AGENT, store: rt.store, escalations, now: () => clock.now() });
  return { clock, events, engine, escalations, ctx, rt, bus, cmds, exec, armed, satisfied, runner, loanId };
}
function schedule(from: string, n: number, amount: bigint = PITI) { return Array.from({ length: n }, (_, i) => ({ due_date: addMonths(D(from), i), amount_cents: amount })); }
/** Installments 2025-03-01 … with payments through `paidThrough` (inclusive). */
function ledger(paidThrough: string): readonly AppliedInstallment[] {
  const inst = schedule("2025-03-01", 40);
  return applyFifo(inst, inst.filter((i) => i.due_date <= D(paidThrough)).map((i) => ({ received_on: i.due_date, amount_cents: PITI }))).installments;
}
function state(asOf: string, installments: readonly AppliedInstallment[], prior: PriorHistory | Metro2Snapshot | null, over: Partial<CreditLoanState> = {}): CreditLoanState {
  return {
    loan_id: "SM-1001", as_of: D(asOf), installments, upb_cents: cents("293063.94"), deferred_principal_cents: 0n, forborne_principal_cents: 0n,
    pi_cents: PI, escrow_cents: ESCROW, original_amount_cents: cents("300000"), note_date: D("2025-02-14"), maturity_date: D("2055-02-01"),
    original_term_months: 360, remaining_term_months: 337, interest_type: "F", fnma_loan_number: "1234567890", min: "100012345678901234",
    payments_in_month_cents: PITI, last_payment_on: D("2027-01-01"), condition: { kind: "none" },
    consumers: [{ party_id: "A", position: 1, same_address_as_base: true, liability: "individual" }], prior, ...over,
  };
}
const JAN_PRIOR: PriorHistory = { php: "0".repeat(22) + "BB", status: "11", dofd: null };   // Dec-2026 snapshot
function aprSnapshot(): Metro2Snapshot {
  const led = ledger("2027-01-01");
  const jan = buildSnapshot(state("2027-01-31", led, JAN_PRIOR)); const feb = buildSnapshot(state("2027-02-28", led, jan)); const mar = buildSnapshot(state("2027-03-31", led, feb));
  return buildSnapshot(state("2027-04-30", led, mar));
}
function julySnapshot(): Metro2Snapshot {
  const led = ledger("2027-01-01");
  const fb: LoanCondition = { kind: "forbearance", effective_on: D("2027-05-01"), entry_status: "78", entry_amount_past_due_cents: cents("7378.65"), plan_payment_cents: 0n };
  let prior: Metro2Snapshot = aprSnapshot();
  for (const m of ["2027-05-31", "2027-06-30", "2027-07-31"]) prior = buildSnapshot(state(m, led, prior, { condition: fb }));
  return prior;
}
/** The 4.1 NoE worked example: 24 installments from 2025-03-01, the March-2026 installment paid 40 days late (a `1` in history), otherwise current. */
function noeFixture() {
  const inst = schedule("2025-03-01", 24);
  const led = applyFifo(inst, inst.map((i) => ({ received_on: i.due_date === D("2026-03-01") ? D("2026-04-10") : i.due_date, amount_cents: PITI }))).installments;
  const prior: PriorHistory = { php: "00001" + "0".repeat(19), status: "11", dofd: null };   // Aug-31-2026: position 5 = March 2026
  return { led, prior };
}
const NOE_OPENED = { case_id: "noe-2026-0904", receipt_date: "2026-09-04", receipt_at: "2026-09-04T14:00:00.000Z", state: null, payment_related: true, is_qwr: false, std_assertion: true, ack_required: true, document_id: "doc-noe-letter" };

test('8.3-T1: (NoE bar) Given the 4.1 NoE received 2026-09-04 disputing the March-2026 payment on an otherwise current loan, then the files transmitted 2026-10-05 and 2026-11-03 show status 11, XB, and PHP position for March 2026 = `D`; the file transmitted 2026-12-03 restores `1` with XH after a "no error" closure on 2026-10-20.', async () => {
  const h = harness("2026-09-04T14:00:00.000Z");
  const { led, prior } = noeFixture();
  // 4.1 opens the NoE (payment-related, b1–b3/b5/b11); 8.3 books the §1024.35(i)(1) bar from the record: receipt + 60 calendar days
  const noe = h.events.append({ type: "case.noe.opened", loanId: h.loanId, aggregate: { kind: "case", id: NOE_OPENED.case_id }, actor: AGENT, payload: NOE_OPENED });
  const booked = await h.exec("credit.suppression.create/release", AGENT, { op: "ingest_noe", event_id: noe.id, scope: ["2026-03-01"] });
  assert.equal(booked.reason, "regx_1024_35_i"); assert.equal(booked.ends_on, D("2026-11-03")); assert.equal(noeBarEnd(D("2026-09-04")), D("2026-11-03")); assert.equal(NOE_BAR_DAYS, 60);
  assert.equal(h.armed("REGX_1024_35I_CREDIT_SUPPRESS_60")[0]!.dueDate, D("2026-11-03"), "the 4.1 row arms on the payment-related NoE");
  assert.equal(h.armed("RESPA_2605E3_QWR_SUPPRESS_60").length, 0, "not a QWR");
  const ctxFor = (p: PriorHistory | Metro2Snapshot) => ({ installments: led, prior: p, noe_bars: h.runner.noeBars(h.loanId, led) });
  // Sept-30 file transmitted Oct 5: inside the bar → the March position renders D, status 11, XB (the internal snapshot keeps the accurate `1`)
  const sep = buildSnapshot(state("2026-09-30", led, prior, { last_payment_on: D("2026-09-01") }));
  assert.equal(sep.php[5], "1");
  const oct5 = h.runner.build({ cycle_id: "2026-09", as_of: D("2026-09-30"), evaluated_on: D("2026-10-05"), config: CONFIG, records: [{ snapshot: sep, suppressions: h.runner.activeSuppressions(h.loanId), overlay_context: ctxFor(prior) }] });
  assert.equal(oct5.status, "validated"); assert.equal(oct5.included.length, 1);
  assert.equal(oct5.included[0]!.account_status, "11"); assert.equal(oct5.included[0]!.php[5], "D"); assert.equal(oct5.included[0]!.consumers[0]!.ccc, "XB");
  assert.deepEqual(oct5.overlay_decisions[0], { loan_id: h.loanId, mechanism: "as_if_paid_projection", codes: ["XB"], reasons: ["regx_1024_35_i"] });
  assert.equal(renderBase(oct5.included[0]!).payment_history_profile!.charAt(5), "D");
  // Oct-31 file transmitted Nov 3: the last day of the bar → still D
  const oct = buildSnapshot(state("2026-10-31", led, sep, { last_payment_on: D("2026-10-01") }));
  const nov3 = h.runner.build({ cycle_id: "2026-10", as_of: D("2026-10-31"), evaluated_on: D("2026-11-03"), config: CONFIG, records: [{ snapshot: oct, suppressions: h.runner.activeSuppressions(h.loanId), overlay_context: ctxFor(sep) }] });
  assert.equal(nov3.included[0]!.php[6], "D"); assert.equal(nov3.included[0]!.account_status, "11"); assert.equal(nov3.included[0]!.consumers[0]!.ccc, "XB");
  // 4.1 closes the NoE "no error" on Oct 20; the transmission-time sweep on Dec 3 expires the bar (REGX row satisfied by the expiry)
  await h.exec("credit.suppression.create/release", AGENT, { op: "noe_closed", id: booked.suppression_id, closed_on: "2026-10-20", outcome: "no_error" });
  h.clock.set("2026-12-03T14:00:00.000Z");
  const sweep = await h.exec("credit.suppression.create/release", AGENT, { op: "expire", today: "2026-12-03" });
  assert.deepEqual((sweep.expired as { id: string; ends_on: string }[]).map((x) => [x.id, x.ends_on]), [[booked.suppression_id, "2026-11-03"]]);
  assert.deepEqual(h.events.ofType("credit.noe_bar.expired").map((e) => [e.payload.reason, e.payload.ccc_after_bar]), [["regx_1024_35_i", "XH"]]);
  assert.equal(h.satisfied("REGX_1024_35I_CREDIT_SUPPRESS_60").length, 1);
  assert.equal(h.rt.store.get(SUPPRESSIONS, String(booked.suppression_id))!.data.status, "expired");
  // Nov-30 file transmitted Dec 3: outside the bar → the March position reverts to `1`, CCC XH
  const nov = buildSnapshot(state("2026-11-30", led, oct, { last_payment_on: D("2026-11-01") }));
  const dec3 = h.runner.build({ cycle_id: "2026-11", as_of: D("2026-11-30"), evaluated_on: D("2026-12-03"), config: CONFIG, records: [{ snapshot: nov, suppressions: h.runner.activeSuppressions(h.loanId), overlay_context: ctxFor(oct) }] });
  assert.equal(dec3.included[0]!.php[7], "1"); assert.equal(dec3.included[0]!.consumers[0]!.ccc, "XH"); assert.equal(dec3.overlay_decisions[0]!.mechanism, "report");
  // the pure overlay agrees with the pipeline
  const direct = applyNoeBar(nov, led, { received_on: D("2026-09-04"), scope: [D("2026-03-01")], closed_on: D("2026-10-20"), outcome: "no_error" }, D("2026-12-03"), oct);
  assert.equal(direct.php, dec3.included[0]!.php); assert.equal(direct.consumers[0]!.ccc, "XH");
});

test("8.3-T2: (bar at transmission time) Given a file built 2026-11-01 and transmitted 2026-11-04 (after expiry), then the projection is not applied.", async () => {
  const h = harness("2026-11-01T05:05:00.000Z");
  const { led, prior } = noeFixture();
  const noe = h.events.append({ type: "case.noe.opened", loanId: h.loanId, aggregate: { kind: "case", id: NOE_OPENED.case_id }, actor: AGENT, payload: NOE_OPENED });
  const booked = await h.exec("credit.suppression.create/release", AGENT, { op: "ingest_noe", event_id: noe.id, scope: ["2026-03-01"] });
  const sep = buildSnapshot(state("2026-09-30", led, prior, { last_payment_on: D("2026-09-01") }));
  const oct = buildSnapshot(state("2026-10-31", led, sep, { last_payment_on: D("2026-10-01") }));   // built 2026-11-01 (as of Oct 31)
  assert.equal(oct.php[6], "1");
  const record = { snapshot: oct, suppressions: h.runner.activeSuppressions(h.loanId), overlay_context: { installments: led, prior: sep, noe_bars: h.runner.noeBars(h.loanId, led) } };
  // the same build evaluated on the 3rd is inside the bar; on the 4th the bar has expired (receipt 09-04 + 60 = 11-03) → projection not applied
  const inside = h.runner.build({ cycle_id: "2026-10", as_of: D("2026-10-31"), evaluated_on: D("2026-11-03"), config: CONFIG, records: [record] });
  assert.equal(inside.included[0]!.php[6], "D");
  h.clock.set("2026-11-04T14:00:00.000Z");
  const sweep = await h.exec("credit.suppression.create/release", AGENT, { op: "expire", today: "2026-11-04" });
  assert.equal((sweep.expired as unknown[]).length, 1);
  const after = h.runner.build({ cycle_id: "2026-10", as_of: D("2026-10-31"), evaluated_on: D("2026-11-04"), config: CONFIG, records: [{ ...record, suppressions: h.runner.activeSuppressions(h.loanId), overlay_context: { installments: led, prior: sep, noe_bars: h.runner.noeBars(h.loanId, led) } }] });
  assert.equal(after.included[0]!.php, oct.php, "no D: the projection is not applied after expiry");
  assert.equal(after.included[0]!.account_status, oct.account_status);
  assert.equal(after.overlay_decisions[0]!.mechanism, "report", "the expired bar no longer resolves a mechanism");
  assert.equal(after.included[0]!.consumers[0]!.ccc, "XB", "the dispute is still open → XB stays (FCRA §1681s-2(a)(3))");
  assert.equal(applyNoeBar(oct, led, { received_on: D("2026-09-04"), scope: [D("2026-03-01")] }, D("2026-11-04"), sep).php, oct.php);
  assert.equal(h.rt.store.get(SUPPRESSIONS, String(booked.suppression_id))!.data.status, "expired");
});

test("8.3-T3: (partial scope) Given an NoE disputing only the June installment on a loan also unpaid for July, then the June installment is treated as paid and July's delinquency is reported (status by July's days past due) with XB.", async () => {
  const h = harness("2027-07-10T14:00:00.000Z");
  const led = ledger("2027-05-01");                                              // June-1 and July-1 unpaid
  const may = buildSnapshot(state("2027-05-31", led, JAN_PRIOR));               // current through May (DOFD zero-filled)
  assert.equal(may.account_status, "11"); assert.equal(may.dofd, null);
  const s = buildSnapshot(state("2027-07-31", led, may));
  assert.equal(s.account_status, "78");                                          // 60 days from Jun-1
  assert.equal(renderBase(s).date_of_first_delinquency, "06012027");
  const noe = h.events.append({ type: "case.noe.opened", loanId: h.loanId, aggregate: { kind: "case", id: "noe-june" }, actor: AGENT, payload: { ...NOE_OPENED, case_id: "noe-june", receipt_date: "2027-07-10", receipt_at: "2027-07-10T14:00:00.000Z" } });
  await h.exec("credit.suppression.create/release", AGENT, { op: "ingest_noe", event_id: noe.id, scope: ["2027-06-01"] });
  const b = h.runner.build({ cycle_id: "2027-07", as_of: D("2027-07-31"), evaluated_on: D("2027-08-03"), config: CONFIG, records: [{ snapshot: s, suppressions: h.runner.activeSuppressions(h.loanId), overlay_context: { installments: led, prior: may, noe_bars: h.runner.noeBars(h.loanId, led) } }] });
  const r = b.included[0]!;
  assert.equal(r.account_status, "71", "June as-if-paid; July-1 unpaid → 30 days → 71");
  assert.equal(r.days_past_due, 30);
  assert.equal(r.amount_past_due_cents, PITI, "July's installment only");
  assert.equal(renderBase(r).amount_past_due, "000002459");
  assert.equal(renderBase(r).date_of_first_delinquency, "07012027");
  assert.equal(r.consumers[0]!.ccc, "XB");
  assert.ok(r.derivation.some((d) => d.includes("as_if_paid 2027-06-01")));
  const direct = applyNoeBar(s, led, { received_on: D("2027-07-10"), scope: [D("2027-06-01")] }, D("2027-08-03"), may);
  assert.equal(direct.account_status, "71"); assert.equal(direct.amount_past_due_cents, PITI);
});

test("8.3-T4: (Ch. 13 petition/confirmation/dismissal) Given the worked example, then Mar-31 = 71/CII D frozen; Jun-30 = 11/CII D with Amount Past Due 0; Jan-31-2028 = 80/CII L with DOFD 11012027; Feb-29-2028 = CII Q.", () => {
  const led = ledger("2027-01-01");                                              // Feb-1 and Mar-1 unpaid (pre-petition)
  const feb = buildSnapshot(state("2027-02-28", led, JAN_PRIOR));
  assert.equal(feb.account_status, "11"); assert.equal(feb.days_past_due, 27);   // "Feb-28 status was 11 at 27 days"
  const petition = { party_id: "A", chapter: 13 as const, petition_on: D("2027-03-10"), phase: { phase: "petition" as const, petition_status: "71" as const, petition_amount_past_due_cents: cents("4919.10") } };
  // Mar-31 through the overlay engine: contractual 58 days (71) and the petition-date status (37 days from Feb-1 → 71) agree; frozen, CII D
  const events = new MemoryEventStore(new FixedClock("2027-04-01T05:05:00.000Z"));
  const runner = new OverlayRunner({ events, actor: AGENT, store: new MemoryRecords() });
  const marRaw = buildSnapshot(state("2027-03-31", led, feb));
  assert.equal(marRaw.days_past_due, 58);
  const b = runner.build({ cycle_id: "2027-03", as_of: D("2027-03-31"), config: CONFIG, records: [{ snapshot: marRaw, overlay_context: { installments: led, prior: feb, bankruptcy: petition } }] });
  const mar = b.included[0]!;
  assert.equal(mar.account_status, "71"); assert.equal(mar.consumers[0]!.cii, "D");
  assert.equal(renderBase(mar).amount_past_due, "000004919");                    // 2 × 2,459.55 frozen
  assert.equal(renderBase(mar).date_of_first_delinquency, "02012027");
  assert.equal(renderBase(mar).current_balance, "000293063");                    // UPB; accrued interest is not Current Balance (8.1 rule 2)
  assert.equal(mar.special_comment, "");
  assert.deepEqual(events.ofType("metro2.snapshot.built").map((e) => [e.payload.cii_applied, e.payload.cii_by_party]), [[true, { A: "D" }]]);
  assert.deepEqual(bankruptcyOverlay(marRaw, petition, led, feb).consumers.map((c) => c.cii), ["D"]);
  // Plan confirmed 2027-06-15 curing the arrears through the trustee; Apr–Jun post-petition payments on time → Jun-30: 11, CII D, APD 0, scheduled 000002459, DOFD zero-filled
  const inst = schedule("2025-03-01", 40);
  const led2 = applyFifo(inst, inst.filter((i) => i.due_date <= D("2027-01-01") || (i.due_date >= D("2027-04-01") && i.due_date <= D("2027-06-01"))).map((i) => ({ received_on: i.due_date, amount_cents: PITI }))).installments;
  const led2post = led2.map((i) => (i.due_date >= D("2027-04-01") && i.due_date <= D("2027-06-01")) ? { ...i, satisfied_on: i.due_date, paid_cents: PITI } : i);   // FIFO would apply post-petition cash to the pre-petition arrears the plan cures
  const jun = bankruptcyOverlay(buildSnapshot(state("2027-06-30", led2post, mar)), { party_id: "A", chapter: 13, petition_on: D("2027-03-10"), phase: { phase: "ch13_confirmed", plan_cures_arrears: true } }, led2post, mar);
  assert.equal(jun.account_status, "11"); assert.equal(jun.consumers[0]!.cii, "D"); assert.equal(jun.amount_past_due_cents, 0n);
  assert.equal(renderBase(jun).scheduled_monthly_payment, "000002459"); assert.equal(renderBase(jun).date_of_first_delinquency, "00000000"); assert.equal(renderBase(jun).current_balance, "000293063");
  // Dismissed 2028-01-20 with Nov-1 and Dec-1-2027 (and Jan-1) unpaid → Jan-31-2028: 80 (Nov-1 → 91 days), CII L, DOFD 11012027 (the cured Feb-2027 delinquency does not re-open)
  const led3 = applyFifo(inst, inst.filter((i) => i.due_date <= D("2027-10-01")).map((i) => ({ received_on: i.due_date, amount_cents: PITI }))).installments;
  const dismissed = (cycles: number) => ({ party_id: "A", chapter: 13 as const, petition_on: D("2027-03-10"), phase: { phase: "dismissed" as const, dismissed_on: D("2028-01-20"), cycles_since: cycles } });
  const jan28 = bankruptcyOverlay(buildSnapshot(state("2028-01-31", led3, { php: jun.php, status: "11", dofd: null })), dismissed(0), led3, { php: jun.php, status: "11", dofd: null });
  assert.equal(jan28.days_past_due, 91); assert.equal(jan28.account_status, "80"); assert.equal(jan28.consumers[0]!.cii, "L");
  assert.equal(renderBase(jan28).date_of_first_delinquency, "11012027");
  assert.equal(renderBase(jan28).amount_past_due, "000007378");                  // Nov + Dec + Jan = 3 × 2,459.55
  const feb28 = bankruptcyOverlay(buildSnapshot(state("2028-02-29", led3, jan28)), dismissed(1), led3, jan28);
  assert.equal(feb28.consumers[0]!.cii, "Q");
});

test("8.3-T5: (Ch. 7 discharge) Given discharge 2027-09-20 without reaffirmation, then the Sep-30 record carries CII E, balances 0, Date Closed 09202027, and no record is furnished in October; given a reaffirmation agreement filed, CII R and normal reporting.", () => {
  // the July fixture's forbearance (78 frozen, CP) runs on: the Sep-30 base is the frozen pre-discharge status with its DOFD
  const led = ledger("2027-01-01");
  const fb: LoanCondition = { kind: "forbearance", effective_on: D("2027-05-01"), entry_status: "78", entry_amount_past_due_cents: cents("7378.65"), plan_payment_cents: 0n };
  const base = buildSnapshot(state("2027-09-30", led, julySnapshot(), { condition: fb }));
  assert.equal(base.account_status, "78"); assert.equal(renderBase(base).date_of_first_delinquency, "02012027"); assert.ok(base.current_balance_cents > 0n);
  const ch7 = (reaffirmed: boolean) => ({ party_id: "A", chapter: 7 as const, petition_on: D("2027-06-01"), phase: { phase: "ch7_discharged" as const, reaffirmed, discharged_on: D("2027-09-20") } });
  const events = new MemoryEventStore(new FixedClock("2027-10-01T05:05:00.000Z"));
  const runner = new OverlayRunner({ events, actor: AGENT, store: new MemoryRecords() });
  const sep = runner.build({ cycle_id: "2027-09", as_of: D("2027-09-30"), config: CONFIG, records: [{ snapshot: base, overlay_context: { installments: led, prior: julySnapshot(), bankruptcy: ch7(false) } }] });
  assert.deepEqual(sep.exceptions, []); assert.equal(sep.included.length, 1);
  const s = sep.included[0]!;
  assert.equal(s.consumers[0]!.cii, "E"); assert.equal(s.account_status, "78", "the frozen pre-discharge status");
  assert.equal(s.current_balance_cents, 0n); assert.equal(s.amount_past_due_cents, 0n); assert.equal(s.scheduled_monthly_payment_cents, 0n);
  assert.equal(renderBase(s).current_balance, "000000000"); assert.equal(renderBase(s).amount_past_due, "000000000"); assert.equal(renderBase(s).date_closed, "09202027");
  assert.equal(s.final_reported, true);
  // October: the loan is `final_reported` after the discharge record → no record furnished (8.1 rule 14; 8.3-Q4 default)
  const finals = finalReportedAfter(sep);
  assert.ok(finals.has("SM-1001"));
  const octRaw = buildSnapshot(state("2027-10-31", led, s, { condition: fb }));
  assert.deepEqual(nextCycleCandidates([octRaw], finals), { included: [], skipped: [{ loan_id: "SM-1001", reason: "final_reported" }] });
  // reaffirmation agreement filed → CII R, normal reporting continues (balances from the ledger, not zeroed)
  const r = bankruptcyOverlay(base, ch7(true), led, julySnapshot());
  assert.equal(r.consumers[0]!.cii, "R"); assert.equal(r.final_reported, false); assert.equal(r.current_balance_cents, base.current_balance_cents); assert.equal(r.date_closed, null);
  assert.equal(bankruptcyOverlay(base, { ...ch7(true), phase: { ...ch7(true).phase, rescinded: true } }, led, julySnapshot()).consumers[0]!.cii, "V", "rescission → V");
});

test('8.3-T6: (SCRA) Given relief from 2027-05-01 and payments of $2,413.31 monthly, then status 11, Scheduled Payment 000002413, no AI code, no forgiven interest ($60.85 in May) in balances; given a missed reduced payment in July, the resulting 71 at Aug-31 is held for `officer` review (documented "not solely by reason of the relief") before furnishing.', () => {
  // rule 4 arithmetic: UPB after payment #26 = $292,096.58, 334 payments remain, 6% cap → P&I $1,800.91; forgiven May interest $60.85; PITI with $612.40 escrow $2,413.31
  const UPB = cents("292096.58");
  const p = scraReducedPayment(UPB, RATE, 334, ESCROW);
  assert.equal(p.pi_cents, cents("1800.91")); assert.equal(p.forgiven_interest_cents, cents("60.85")); assert.equal(p.piti_cents, cents("2413.31"));
  assert.equal(levelPayment(UPB, SCRA_CAP, 334), cents("1800.91")); assert.equal(levelPayment(cents("300000"), RATE, 360), PI);
  // the ledger: PITI through April 2027, the reduced PITI from May 2027; every installment paid on its due date except the July one
  const inst = [...schedule("2025-03-01", 26), ...schedule("2027-05-01", 8, p.piti_cents)];
  const led = applyFifo(inst, inst.filter((i) => i.due_date !== D("2027-07-01")).map((i) => ({ received_on: i.due_date, amount_cents: i.amount_cents }))).installments;
  const scra = { party_id: "A", relief_from: D("2027-05-01"), relief_to: null, reduced_piti_cents: p.piti_cents, stay_granted: false };
  // May-31: current, Scheduled = Actual = 000002413, no AI, Current Balance reduced by the full scheduled principal (interest at 6%, the forgiven $60.85 never a receivable)
  const mayInterest = monthlyInterest(UPB, SCRA_CAP); const mayPrincipal = p.pi_cents - mayInterest;
  assert.equal(mayInterest, cents("1460.48")); assert.equal(mayPrincipal, cents("340.43"));
  const mayRaw = buildSnapshot(state("2027-05-31", led, aprSnapshot(), { payments_in_month_cents: p.piti_cents, last_payment_on: D("2027-05-01"), upb_cents: UPB - mayPrincipal, pi_cents: p.pi_cents }));
  const may = scraOverlay({ ...mayRaw, account_status: "11", dofd: null, days_past_due: 0, amount_past_due_cents: 0n }, scra, { php: mayRaw.php, status: "11", dofd: null });
  assert.equal(may.held_for_officer, false);
  assert.equal(renderBase(may.snapshot).account_status, "11");
  assert.equal(renderBase(may.snapshot).scheduled_monthly_payment, "000002413"); assert.equal(renderBase(may.snapshot).actual_payment_amount, "000002413");
  assert.equal(renderBase(may.snapshot).current_balance, "000291756");            // 292,096.58 − 340.43
  assert.equal(renderBase(may.snapshot).amount_past_due, "000000000");
  assert.notEqual(String(may.snapshot.special_comment), "AI"); assert.ok(may.snapshot.consumers.every((c) => String(c.special_comment) !== "AI"));
  assert.ok(may.snapshot.derivation.some((d) => d.includes("no AI code")));
  // the §3919 gate on the engine: 13.8's `scra.relief.started` arms it (no due date); `scra.relief.ended{plus_one_cycle=true}` closes it
  const h = harness("2027-05-01T12:00:00.000Z");
  const started = reliefStarted({ case_id: "scra-A", started_on: D("2027-05-01"), status_code: "11" });
  h.events.append({ type: started.type, loanId: h.loanId, actor: AGENT, payload: started.payload });
  assert.equal(h.armed("SCRA_3919_NO_ADVERSE_GATE").length, 1); assert.equal(h.armed("SCRA_3919_NO_ADVERSE_GATE")[0]!.dueDate, undefined);
  // July's reduced payment missed: Aug-1's cash applies to July (FIFO) → Aug-1 unpaid → 30 days at Aug-31 → 71, a *new* adverse status during relief → held, not furnished
  const jun = buildSnapshot(state("2027-06-30", led, may.snapshot, { payments_in_month_cents: p.piti_cents, upb_cents: UPB - mayPrincipal, pi_cents: p.pi_cents }));
  assert.equal(jun.account_status, "11");
  const jul = buildSnapshot(state("2027-07-31", led, jun, { payments_in_month_cents: 0n, upb_cents: UPB - mayPrincipal, pi_cents: p.pi_cents }));
  const augRaw = buildSnapshot(state("2027-08-31", led, jun, { payments_in_month_cents: p.piti_cents, upb_cents: UPB - mayPrincipal, pi_cents: p.pi_cents }));
  assert.equal(jul.days_past_due, 30); assert.equal(augRaw.days_past_due, 30); assert.equal(augRaw.account_status, "71");
  const held = scraOverlay(augRaw, scra, jun);
  assert.equal(held.held_for_officer, true);
  const aug = h.runner.build({ cycle_id: "2027-08", as_of: D("2027-08-31"), config: CONFIG, records: [{ snapshot: augRaw, overlay_context: { installments: led, prior: jun, scra } }] });
  assert.equal(aug.included.length, 0);
  assert.deepEqual(aug.omitted, [{ loan_id: h.loanId, reason: "scra_adverse_held_for_officer:A" }]);
  assert.deepEqual(aug.held_for_officer, [{ loan_id: h.loanId, party_id: "A", status: "71", prior_status: "11" }]);
  assert.deepEqual(h.escalations.opened.map((e) => [e.kind, e.payload.rationale_required]), [["officer", "not solely by reason of the relief"]]);
  assert.deepEqual(h.events.ofType("credit.overlay.held_for_officer").map((e) => [e.payload.status, e.payload.omitted_from_file]), [["71", true]]);
  // the officer documents "not solely by reason of the relief" → the 71 is furnished with the reduced scheduled payment
  const reviewed = h.runner.build({ cycle_id: "2027-08", as_of: D("2027-08-31"), config: CONFIG, records: [{ snapshot: augRaw, overlay_context: { installments: led, prior: jun, scra: { ...scra, officer_reviewed_adverse: true } } }] });
  assert.equal(reviewed.included[0]!.account_status, "71"); assert.equal(renderBase(reviewed.included[0]!).scheduled_monthly_payment, "000002413"); assert.deepEqual(reviewed.held_for_officer, []);
  h.events.append({ type: "scra.relief.ended", loanId: h.loanId, actor: AGENT, payload: { case_id: "scra-A", kind: "foreclosure_stay", ended_on: "2027-10-31", plus_one_cycle: true } });
  assert.equal(h.satisfied("SCRA_3919_NO_ADVERSE_GATE").length, 1);
});

test("8.3-T7: (disaster) Given a FEMA declaration covering the property on 2027-08-20 and no forbearance, then the Aug-31 record carries AW; given a disaster forbearance from 2027-09-01, CP replaces AW.", () => {
  const led = ledger("2027-08-01");
  const events = new MemoryEventStore(new FixedClock("2027-09-01T05:05:00.000Z"));
  const runner = new OverlayRunner({ events, actor: AGENT, store: new MemoryRecords() });
  const disaster = { declared_on: D("2027-08-20") };
  // the raw Aug-31 snapshot carries no Special Comment; the 8.3 disaster overlay (D1-3-01 case open, property in the declared area) writes AW
  const augRaw = buildSnapshot(state("2027-08-31", led, julySnapshot()));
  assert.equal(augRaw.special_comment, "");
  const aug = runner.build({ cycle_id: "2027-08", as_of: D("2027-08-31"), config: CONFIG, records: [{ snapshot: augRaw, overlay_context: { installments: led, prior: julySnapshot(), disaster } }] }).included[0]!;
  assert.equal(aug.special_comment, "AW"); assert.ok(aug.consumers.every((c) => c.special_comment === "AW"));
  assert.equal(renderBase(aug).special_comment, "AW");
  assert.equal(disasterOverlay(augRaw, D("2027-08-20")).special_comment, "AW");
  assert.equal(buildSnapshot(state("2027-08-31", led, julySnapshot(), { disaster_case_open: true })).special_comment, "AW", "the 8.1 generator's disaster flag agrees");
  // a disaster forbearance from 2027-09-01: the 8.1 forbearance rule freezes and writes CP, which takes the single Special Comment field over AW
  const fb: LoanCondition = { kind: "forbearance", effective_on: D("2027-09-01"), entry_status: "11", entry_amount_past_due_cents: 0n, plan_payment_cents: 0n };
  const sepRaw = buildSnapshot(state("2027-09-30", led, aug, { condition: fb }));
  const sep = runner.build({ cycle_id: "2027-09", as_of: D("2027-09-30"), config: CONFIG, records: [{ snapshot: sepRaw, overlay_context: { installments: led, prior: aug, disaster } }] }).included[0]!;
  assert.equal(sep.special_comment, "CP"); assert.equal(renderBase(sep).special_comment, "CP");
  assert.equal(disasterOverlay(sepRaw, D("2027-08-20")).special_comment, "CP");
  // the overlay expires with the case: 12 months from the declaration unless extended by `officer`
  assert.equal(disasterOverlay({ ...augRaw, as_of: D("2028-08-31") }, D("2027-08-20")).special_comment, "");
  assert.equal(disasterOverlay({ ...augRaw, as_of: D("2028-08-31") }, D("2027-08-20"), D("2028-12-31")).special_comment, "AW");
});

test("8.3-T8: (deceased) Given confirmed death of co-borrower B on 2027-04-12, then B's J1 segment carries ECOA X from the Apr-30 cycle and A's segment is unchanged; given the successor daughter confirmed under 4.4, no segment is created for her.", async () => {
  const h = harness("2027-04-12T15:00:00.000Z");
  for (const [id, over] of [["A", {}], ["B", {}], ["D", { successor_in_interest: true, confirmed_under: "4.4" }]] as const) h.rt.store.put("borrowers", id, { loan_id: h.loanId, ...over }, AGENT, h.clock.now());
  // 4.4's confirmation (death certificate) → `borrower.deceased.confirmed{confirmation=2027-04-12}` → the row arms for the 1st-of-next-month snapshot
  const c = await h.exec("credit.suppression.create/release", AGENT, { op: "confirm_deceased", party_id: "B", confirmed_on: "2027-04-12", evidence_kind: "death_certificate", evidence_document_id: "doc-death-cert-B" });
  assert.equal(c.ecoa_x_from_cycle_as_of, D("2027-04-30")); assert.equal(c.next_cycle_snapshot_on, D("2027-05-01")); assert.equal(nextCycleSnapshotOn(D("2027-04-12")), D("2027-05-01"));
  assert.deepEqual(h.events.ofType("borrower.deceased.confirmed").map((e) => [e.payload.party_id, e.payload.confirmation, e.payload.evidence_kind]), [["B", "2027-04-12", "death_certificate"]]);
  const armed = h.armed("SM_CR_DECEASED_ECOA_X_NEXT_CYCLE");
  assert.equal(armed.length, 1); assert.equal(armed[0]!.anchorDate, D("2027-04-12")); assert.equal(armed[0]!.dueDate, D("2027-05-01"));
  assert.deepEqual(h.runner.deceasedPartyIds(h.loanId), ["B"]);
  // no confirmation without 4.4 evidence; a confirmed successor is never an obligor, so never marked deceased
  await assert.rejects(h.exec("credit.suppression.create/release", AGENT, { op: "confirm_deceased", party_id: "B", confirmed_on: "2027-04-12", evidence_kind: "phone_call", evidence_document_id: "doc-x" }), RangeError);
  await assert.rejects(h.exec("credit.suppression.create/release", AGENT, { op: "confirm_deceased", party_id: "D", confirmed_on: "2027-04-12", evidence_kind: "death_certificate", evidence_document_id: "doc-y" }), /not an obligor/);
  // the Apr-30 cycle (built May 1): B's J1 segment ECOA X, A unchanged (joint → 2), the successor daughter D gets no segment
  h.clock.set("2027-05-01T05:05:00.000Z");
  const aprRaw = buildSnapshot(state("2027-04-30", ledger("2027-04-01"), JAN_PRIOR, { consumers: [
    { party_id: "A", position: 1, same_address_as_base: true, liability: "joint" },
    { party_id: "B", position: 2, same_address_as_base: true, liability: "joint" },
    { party_id: "D", position: 3, same_address_as_base: true, liability: "joint", successor_in_interest: true },
  ] }));
  assert.deepEqual(aprRaw.consumers.map((c) => c.party_id), ["A", "B"], "4.4: a confirmed successor who has not assumed is not furnished");
  const b = h.runner.build({ cycle_id: "2027-04", as_of: D("2027-04-30"), config: CONFIG, records: [{ snapshot: aprRaw, suppressions: h.runner.activeSuppressions(h.loanId), overlay_context: { installments: ledger("2027-04-01"), prior: JAN_PRIOR, deceased_party_ids: h.runner.deceasedPartyIds(h.loanId) } }] });
  assert.deepEqual(b.included[0]!.consumers.map((c) => [c.party_id, c.segment, c.ecoa]), [["A", "base", "2"], ["B", "J1", "X"]]);
  assert.deepEqual(b.overlay_decisions[0], { loan_id: h.loanId, mechanism: "flag_only", codes: ["ECOA X"], reasons: ["deceased"] });
  assert.deepEqual(deceasedOverlay(aprRaw, "B").consumers.map((c) => [c.party_id, c.ecoa]), [["A", "2"], ["B", "X"]]);
  // the snapshot carries ECOA X → the row is satisfied by the build's `metro2.snapshot.built{ecoa_x_applied=true}`
  const built = h.events.ofType("metro2.snapshot.built");
  assert.deepEqual(built.map((e) => [e.payload.cycle_id, e.payload.ecoa_x_applied, e.payload.ecoa_x_party_ids]), [["2027-04", true, ["B"]]]);
  assert.equal(h.satisfied("SM_CR_DECEASED_ECOA_X_NEXT_CYCLE").length, 1);
  assert.equal(h.satisfied("SM_CR_DECEASED_ECOA_X_NEXT_CYCLE")[0]!.satisfiedByEventId, built[0]!.id);
});

test("8.3-T9: (identity theft) Given a Block notification on 2027-05-03 for borrower C, then C is omitted from the May cycle, an AUD removing C is sent by 2027-05-05, a `fraud` case opens, and resumption requires `officer` + BRR.", async () => {
  const h = harness("2027-05-03T12:00:00.000Z");
  // the e-OSCAR Block notification at the designated address → omit C immediately, AUD within 2 servicer BD, fraud case
  const r = await h.exec("credit.suppression.create/release", AGENT, { op: "ingest_block", party_id: "C", control_number: "BLK-2027-0503", cra: "experian", received_at: "2027-05-03T12:00:00.000Z", identity_theft_report_id: "ftc-report-C" });
  assert.equal((r.suppression as Suppression).mechanism, "omit_account"); assert.equal(r.aud_due, D("2027-05-05"), "2 business_days_servicer from Mon 2027-05-03"); assert.equal(r.omitted_from_cycle_as_of, D("2027-05-31")); assert.equal(r.fraud_case_opened, true);
  assert.deepEqual(r.resumption_requires, ["officer_approval", "brr_with_evidence", "cra_block_rescission"]);
  assert.deepEqual(identityTheftResponse({ party_id: "C", received_on: D("2027-05-07"), never_liable: false }).aud_due, D("2027-05-11"), "Fri 05-07 → Mon 05-10, Tue 05-11");
  assert.deepEqual(h.events.ofType("credit.block.notice.received").map((e) => [e.payload.kind, e.payload.party_id, e.payload.received_on]), [["Block", "C", "2027-05-03"]]);
  assert.deepEqual(h.events.ofType("case.fraud.opened").map((e) => e.payload.party_id), ["C"]);
  assert.deepEqual(h.escalations.opened.map((e) => [e.kind, e.payload.task]), [["officer", "fraud_case_review"]]);
  assert.equal(h.armed("FCRA_1681C2_IDTHEFT_BLOCK_GATE").length, 1, "the block gate arms on the notification (no due date: until officer release)");
  const urgent = h.armed("SM_CR_OVERLAY_URGENT_AUD_BD2");
  assert.equal(urgent.length, 1); assert.equal(urgent[0]!.dueDate, D("2027-05-05"));
  // the May cycle omits C's segment (a J1) — the record furnishes A only; a suppressed base consumer omits the whole record
  const may = buildSnapshot(state("2027-05-31", ledger("2027-05-01"), JAN_PRIOR, { consumers: [{ party_id: "A", position: 1, same_address_as_base: true, liability: "joint" }, { party_id: "C", position: 2, same_address_as_base: true, liability: "joint" }] }));
  const b = buildCycle({ cycle_id: "2027-05", as_of: D("2027-05-31"), records: [{ snapshot: may, suppressions: h.runner.activeSuppressions(h.loanId) }], config: CONFIG });
  assert.deepEqual(b.included[0]!.consumers.map((c) => c.party_id), ["A"]);
  assert.deepEqual(b.overlay_decisions[0], { loan_id: h.loanId, mechanism: "omit_account", codes: [], reasons: ["identity_theft_block"] });
  const baseBlock = identityTheftResponse({ party_id: "A", received_on: D("2027-05-03"), never_liable: false });
  assert.deepEqual(buildCycle({ cycle_id: "2027-05", as_of: D("2027-05-31"), records: [{ snapshot: may, suppressions: [baseBlock.suppression] }], config: CONFIG }).omitted, [{ loan_id: h.loanId, reason: "omit_account:identity_theft" }]);
  // the AUD removing C's segment by 05-05 satisfies the urgent-AUD row
  h.clock.set("2027-05-04T15:00:00.000Z");
  await h.exec("eoscar.aud.submit", AGENT, { op: "submit", aud: { audId: "U-C-1", bureau: "experian", accountNumber: "SM-1001", fields: { consumer_segment: "delete", party_id: "C", ecoa: "" }, reason: "identity_theft_block" } });
  assert.deepEqual(h.events.ofType("eoscar.aud.submitted").map((e) => e.payload.aud_id), ["U-C-1"]);
  assert.equal(h.satisfied("SM_CR_OVERLAY_URGENT_AUD_BD2").length, 1);
  // resumption: never automatic — the agent cannot release (even claiming approval); the officer can, only with the BRR / rescission evidence
  const id = String(r.suppression_id);
  await assert.rejects(h.exec("credit.suppression.create/release", AGENT, { op: "release", id, officer_approved: true }), (e: unknown) => e instanceof RoleDenied);
  await assert.rejects(h.exec("credit.suppression.create/release", AGENT, { op: "release", id, reason: "identity_theft_block" }), (e: unknown) => e instanceof CommandRefused && e.code === "DELETE_NEEDS_OFFICER");
  await assert.rejects(h.exec("credit.suppression.create/release", OFFICER, { op: "release", id }), /evidence_document_id is required/);
  assert.equal(h.rt.store.get(SUPPRESSIONS, id)!.data.status, "active"); assert.equal(h.armed("FCRA_1681C2_IDTHEFT_BLOCK_GATE").length, 1);
  await h.exec("credit.suppression.create/release", OFFICER, { op: "release", id, evidence_document_id: "doc-brr-rescission", released_reason: "CRA block rescinded after BRR (§1681c-2(c))" });
  assert.equal(h.rt.store.get(SUPPRESSIONS, id)!.data.status, "released");
  assert.deepEqual(h.events.ofType("credit.identity_theft.released").map((e) => e.payload.by), ["officer"]);
  assert.equal(h.satisfied("FCRA_1681C2_IDTHEFT_BLOCK_GATE").length, 1);
  // a consumer who was never liable: ECOA Z (`delete_consumer`) is an officer decision
  await assert.rejects(h.exec("credit.suppression.create/release", AGENT, { op: "ingest_block", party_id: "C", control_number: "BLK-2", cra: "equifax", received_at: "2027-05-03T12:00:00.000Z", never_liable: true }), (e: unknown) => e instanceof CreditReportingRefused && e.code === "OFFICER_REQUIRED");
  assert.equal(((await h.exec("credit.suppression.create/release", OFFICER, { op: "ingest_block", party_id: "C", control_number: "BLK-2", cra: "equifax", received_at: "2027-05-03T12:00:00.000Z", never_liable: true })).suppression as Suppression).mechanism, "delete_consumer");
});

test("8.3-T10: (FDCPA gate) Given boarding in default on 2027-02-10 and a validation notice mailed 2027-02-12 with no undeliverability by 2027-02-26, then the Feb-28 cycle includes the loan; given the notice returned undeliverable on 2027-02-20, the loan is omitted until live contact.", () => {
  assert.equal(fdcpaGateOpensOn({ live_contact_on: null, validation_notice_sent_on: D("2027-02-12"), undeliverable_on: null }), D("2027-02-26"));   // 02-12 + 14 calendar days
  assert.equal(addDays(D("2027-02-12"), 14), D("2027-02-26"));
  const clean: FdcpaGateInput = { live_contact_on: null, validation_notice_sent_on: D("2027-02-12"), undeliverable_on: null };
  const returned: FdcpaGateInput = { live_contact_on: null, validation_notice_sent_on: D("2027-02-12"), undeliverable_on: D("2027-02-20") };
  assert.ok(fdcpaGateIncludes(clean, D("2027-02-28")));
  assert.equal(fdcpaGateIncludes(returned, D("2027-02-28")), false);
  assert.equal(fdcpaGateOpensOn(returned), null);
  assert.ok(fdcpaGateIncludes({ ...returned, live_contact_on: D("2027-03-02") }, D("2027-03-31")), "live contact re-opens the gate");
  // the cycle: included on Feb-28 with the clean notice; omitted (never furnished) with the returned one until live contact; PHP D for the omitted month
  const led = ledger("2026-11-01");
  const feb = buildSnapshot(state("2027-02-28", led, JAN_PRIOR));
  const rec = (gate: typeof clean) => ({ snapshot: feb, fdcpa: { boarded_in_default: true, gate } });
  assert.deepEqual(buildCycle({ cycle_id: "2027-02", as_of: D("2027-02-28"), records: [rec(clean)], config: CONFIG }).omitted, []);
  assert.deepEqual(buildCycle({ cycle_id: "2027-02", as_of: D("2027-02-28"), records: [rec(returned)], config: CONFIG }).omitted, [{ loan_id: "SM-1001", reason: "fdcpa_pre_furnishing_gate" }]);
  assert.deepEqual(buildCycle({ cycle_id: "2027-03", as_of: D("2027-03-31"), records: [{ snapshot: { ...feb, as_of: D("2027-03-31") }, fdcpa: { boarded_in_default: true, gate: { ...returned, live_contact_on: D("2027-03-02") } } }], config: CONFIG }).omitted, []);
  // FDCPA_1006_30A_PRE_FURNISH_GATE on the engine: `loan.boarded` in default arms it; 11.4's `fdcpa.furnishing_gate.opened` (14 days after mailing, no undeliverability) closes it
  const h = harness("2027-02-10T12:00:00.000Z");
  h.events.append({ type: "loan.boarded", loanId: h.loanId, aggregate: { kind: "transfer_batch", id: "B-2027-02-10" }, actor: { kind: "agent", id: "boarding" }, payload: { loan_id: h.loanId, transfer_date: "2027-02-10", regx_days_delinquent: 45, default_status_at_boarding: true, fdcpa_debt_collector_flag: true, fdcpa_debt_collector: true } });
  assert.equal(h.armed("FDCPA_1006_30A_PRE_FURNISH_GATE").length, 1);
  const st = fdcpaStatusAtBoarding(h.loanId, D("2027-02-10"), { regx_days_delinquent_at_transfer: 45, bk_active: false, fc_active: false, accelerated: false });
  assert.equal(st.status.debt_collector, true);
  for (const e of recordValidationSent(st.status, { sent_on: D("2027-02-12"), channel: "mail" })) h.events.append({ type: e.type, loanId: h.loanId, actor: AGENT, payload: e.payload });
  assert.deepEqual(fdcpaSweep(st.status, D("2027-02-25")).filter((e) => e.type === "fdcpa.furnishing_gate.opened"), [], "day 13: still closed");
  const opened = fdcpaSweep(st.status, D("2027-02-26")).filter((e) => e.type === "fdcpa.furnishing_gate.opened");
  assert.equal(opened.length, 1); assert.equal(opened[0]!.payload.furnishing_gate_open_at, D("2027-02-26"));
  h.events.append({ type: opened[0]!.type, loanId: h.loanId, actor: AGENT, payload: opened[0]!.payload });
  assert.equal(h.satisfied("FDCPA_1006_30A_PRE_FURNISH_GATE").length, 1);
  // returned undeliverable on 02-20: the sweep never opens the gate; a live conversation does
  const st2 = fdcpaStatusAtBoarding("SM-2002", D("2027-02-10"), { regx_days_delinquent_at_transfer: 45, bk_active: false, fc_active: false, accelerated: false });
  recordValidationSent(st2.status, { sent_on: D("2027-02-12"), channel: "mail" }); st2.status.undeliverable_at = D("2027-02-20");
  assert.deepEqual(fdcpaSweep(st2.status, D("2027-02-26")).filter((e) => e.type === "fdcpa.furnishing_gate.opened"), []);
  assert.deepEqual(fdcpaSweep(st2.status, D("2027-03-31")).filter((e) => e.type === "fdcpa.furnishing_gate.opened"), []);
  assert.equal(recordConversation(st2.status, D("2027-03-02")).find((e) => e.type === "fdcpa.furnishing_gate.opened")!.payload.furnishing_gate_open_at, D("2027-03-02"));
});

test("8.3-T11: (stale suppression) Given a bankruptcy dismissed 2027-10-02 with no monitor event, then the 30-day review on 2027-10-10 flags the docket mismatch and the agent applies CII L/Q with the dismissal order.", async () => {
  const r = staleSuppressionReview({ suppression: { reason: "bankruptcy", chapter: 13, phase: "plan_confirmed", last_event_on: D("2027-09-10") }, docket: { status: "dismissed", event_on: D("2027-10-02"), order_document_id: "doc-dismissal-order" }, review_on: D("2027-10-10") });
  assert.equal(r.review_due_on, "2027-10-10"); assert.equal(r.mismatch, true);
  assert.deepEqual(r.action, { cii_this_cycle: "L", cii_next_cycle: "Q", release_freeze: true, evidence_document_id: "doc-dismissal-order", via: "aud_and_next_cycle" }); assert.equal(r.escalation, null);
  assert.equal(staleSuppressionReview({ suppression: { reason: "bankruptcy", chapter: 13, phase: "plan_confirmed", last_event_on: D("2027-09-10") }, docket: { status: "dismissed", event_on: D("2027-10-02"), order_document_id: null }, review_on: D("2027-10-10") }).escalation, "officer");
  assert.equal(staleSuppressionReview({ suppression: { reason: "bankruptcy", chapter: 13, phase: "plan_confirmed", last_event_on: D("2027-09-10") }, docket: { status: "open", event_on: null, order_document_id: null }, review_on: D("2027-10-10") }).mismatch, false);
  // SM_CR_SUPPRESSION_REVIEW_30 on the bus: the freeze booked 2027-09-10 arms the 30-day review (due 10-10); the review records the docket
  // mismatch, applies CII L this cycle / Q next with the dismissal order, releases the freeze and escalates `human_agent` (a stale freeze is an inaccuracy)
  const h = harness("2027-09-10T12:00:00.000Z");
  const c = await h.exec("credit.suppression.create/release", AGENT, { id: "sup-bk-A", reason: "bankruptcy_active", mechanism: "freeze_status", party_id: "A", codes: ["CII D"], chapter: 13, phase: "plan_confirmed", starts_on: "2027-09-10", trigger_event_id: "ev-plan-confirmed", evidence_document_id: "doc-plan-order" });
  assert.equal(c.id, "sup-bk-A");
  const review = h.armed("SM_CR_SUPPRESSION_REVIEW_30");
  assert.equal(review.length, 1); assert.equal(review[0]!.dueDate, D("2027-10-10"));
  h.clock.set("2027-10-10T12:00:00.000Z");
  const out = await h.exec("credit.suppression.create/release", AGENT, { op: "review", id: "sup-bk-A", reviewed_on: "2027-10-10", docket: { status: "dismissed", event_on: "2027-10-02", order_document_id: "doc-dismissal-order" } });
  assert.equal(out.review_due_on, D("2027-10-10")); assert.equal(out.stale, true); assert.equal(out.next_review_on, D("2027-11-09"));
  assert.deepEqual(out.action, r.action); assert.equal(out.escalation, "human_agent");
  const row = h.rt.store.get(SUPPRESSIONS, "sup-bk-A")!.data;
  assert.deepEqual([row.phase, row.codes, row.next_cycle_codes, row.mechanism, row.evidence_document_id, row.freeze_released_on], ["dismissed", ["CII L"], ["CII Q"], "flag_only", "doc-dismissal-order", "2027-10-10"]);
  assert.deepEqual(h.events.ofType("credit.suppression.reviewed").map((e) => [e.payload.id, e.payload.stale, e.payload.docket_checked, (e.payload.action as { cii_this_cycle: string }).cii_this_cycle]), [["sup-bk-A", true, true, "L"]]);
  assert.equal(h.satisfied("SM_CR_SUPPRESSION_REVIEW_30").length, 1);
  assert.equal(h.armed("SM_CR_SUPPRESSION_REVIEW_30").length, 1, "recurring: the next 30-day review re-arms on the review");
  assert.deepEqual(h.escalations.opened.map((e) => [e.kind, e.payload.task]), [["human_agent", "stale_suppression"]]);
  // a consistent docket: reviewed, not stale, nothing escalated
  const h2 = harness("2027-09-10T12:00:00.000Z");
  await h2.exec("credit.suppression.create/release", AGENT, { id: "sup-bk-B", reason: "bankruptcy_active", mechanism: "freeze_status", party_id: "A", codes: ["CII D"], chapter: 13, phase: "plan_confirmed", starts_on: "2027-09-10", trigger_event_id: "ev-1", evidence_document_id: "doc-1" });
  const ok = await h2.exec("credit.suppression.create/release", AGENT, { op: "review", id: "sup-bk-B", reviewed_on: "2027-10-10", docket: { status: "open", event_on: null, order_document_id: null } });
  assert.equal(ok.stale, false); assert.equal(ok.escalation, null); assert.deepEqual(h2.escalations.opened, []);
});

test("8.3-T12: (no courtesy suppression) Given a borrower asks the AI voice agent not to report a late payment, then no suppression is created, the request is logged, and the borrower is told about the direct-dispute process.", async () => {
  const h = harness("2027-06-15T16:00:00.000Z");
  const r = await h.exec("credit.suppression.create/release", AGENT, { reason: "courtesy_request", party_id: "A", channel: "ai_voice", utterance: "please don't report my May payment as late" });
  assert.equal(r.created, false); assert.equal(r.response, COURTESY_RESPONSE); assert.equal(r.borrower_told, COURTESY_SCRIPT);
  assert.match(String(r.borrower_told), /dispute it directly with us in writing at our designated dispute address/);
  assert.equal(r.suppressions_for_loan, 0);
  assert.deepEqual(h.rt.store.list(SUPPRESSIONS), [], "no suppression row");
  assert.deepEqual(h.events.ofType("credit.suppression.created"), []);
  // the request is logged (a record and an event), with the answer given
  const logged = h.rt.store.list(COURTESY_REQUESTS);
  assert.equal(logged.length, 1); assert.equal(logged[0]!.id, String(r.log_id));
  assert.deepEqual([logged[0]!.data.channel, logged[0]!.data.party_id, logged[0]!.data.suppression_created, logged[0]!.data.response, logged[0]!.data.utterance], ["ai_voice", "A", false, COURTESY_RESPONSE, "please don't report my May payment as late"]);
  assert.deepEqual(h.events.ofType("credit.courtesy_request.logged").map((e) => [e.payload.channel, e.payload.suppression_created, e.payload.response]), [["ai_voice", false, COURTESY_RESPONSE]]);
  assert.equal(courtesyRequest().created, false);
  // forcing it is refused by the guardrail before anything runs
  await assert.rejects(h.exec("credit.suppression.create/release", AGENT, { reason: "courtesy_request", force: true, channel: "ai_voice" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_COURTESY_SUPPRESSION");
  assert.equal(h.rt.store.list(COURTESY_REQUESTS).length, 1);
});

test("8.3-T13: (sample verification) Given a cycle of 5,000 records, then ≥250 are re-derived by `qc-audit`; a match rate of 99.2% escalates to `officer` with field-level variances.", async () => {
  const sv = sampleVerification(5000, 248, 250);
  assert.equal(sv.sample_size, 250, "max(200, 5% of 5,000)"); assert.equal(sv.match_rate, 0.992); assert.equal(sv.escalate, true);
  assert.equal(sampleVerification(5000, 250, 250).escalate, false);
  assert.equal(sampleVerification(3000, 200, 200).sample_size, 200, "≥200 tradelines or 5%, whichever is larger");
  assert.equal(sampleVerification(5000, 240, 240).escalate, true, "fewer than the required sample is a breach even at 100% match");
  // SM_APPX_E_SAMPLE_VERIFY_MONTHLY: `credit.cycle.validated` (the 8.1 runner) arms the row on the cycle; the E-III-d control run on that cycle satisfies it
  const h = harness("2027-02-01T05:05:00.000Z");
  const cycle = new CreditCycleRunner(h.events, AGENT);
  cycle.open("2027-01", D("2027-01-31"));
  const b = cycle.build({ cycle_id: "2027-01", as_of: D("2027-01-31"), records: [{ snapshot: buildSnapshot(state("2027-01-31", ledger("2027-01-01"), JAN_PRIOR)), b1_on_file: true }], config: CONFIG });
  assert.equal(b.status, "validated");
  assert.equal(h.armed("SM_APPX_E_SAMPLE_VERIFY_MONTHLY").length, 1);
  const variances = [{ loan_id: "SM-1042", field: "amount_past_due", furnished: "000004919", rederived: "000002459" }, { loan_id: "SM-1077", field: "date_of_first_delinquency", furnished: "02012027", rederived: "03012027" }];
  const run = await h.exec("accuracy.control.run", AGENT, { control_id: "E-III-d", cycle_id: "2027-01", cycle_records: 5000, sampled: 250, matched: 248, variances });
  assert.deepEqual(run.result, { sample_size: 250, match_rate: 0.992, escalate: true }); assert.equal(run.escalation, "officer"); assert.deepEqual(run.variances, variances);
  assert.deepEqual(h.escalations.opened.map((e) => [e.kind, e.payload.control_id, e.payload.match_rate, e.payload.variances]), [["officer", "E-III-d", 0.992, variances]]);
  assert.equal(h.satisfied("SM_APPX_E_SAMPLE_VERIFY_MONTHLY").length, 1);
  assert.equal(h.armed("SM_APPX_E_SAMPLE_VERIFY_MONTHLY").length, 1, "recurring: re-armed for the next cycle");
  const pattern = loadOverriddenRegistry().get("SM_APPX_E_SAMPLE_VERIFY_MONTHLY")!.satisfiedPattern!;
  assert.equal(eventMatches(pattern, h.events.ofType("accuracy_program.control_run")[0]!), true);
  const other = await h.exec("accuracy.control.run", AGENT, { control_id: "E-III-l", cycle_id: "2027-01" });
  assert.equal(other.escalation, null);
  assert.equal(eventMatches(pattern, h.events.ofType("accuracy_program.control_run")[1]!), false, "only the E-III-d run satisfies the row");
});

test("8.3-T14: (priority resolution) Given bankruptcy freeze + open dispute + SCRA on one consumer, then mechanism = freeze_status, codes = {CII D, XB}, and the decision record lists three reasons.", async () => {
  const active: Suppression[] = [
    { reason: "bankruptcy", mechanism: "freeze_status", party_id: "A", starts_on: D("2027-03-10"), ends_on: null, codes: ["CII D"] },
    { reason: "dispute_open", mechanism: "flag_only", party_id: "A", starts_on: D("2027-09-15"), ends_on: null, codes: ["XB"] },
    { reason: "scra", mechanism: "freeze_status", party_id: "A", starts_on: D("2027-05-01"), ends_on: null },
  ];
  const r = resolveSuppression(active, D("2027-09-30"), "A")!;
  assert.equal(r.mechanism, "freeze_status"); assert.deepEqual(r.codes, ["CII D", "XB"]); assert.equal(r.reasons.length, 3);
  assert.deepEqual(r.reasons, ["bankruptcy", "dispute_open", "scra"]);
  assert.equal(resolveSuppression(active, D("2027-04-30"), "A")!.reasons.length, 1, "only the bankruptcy row is live in April");
  assert.equal(resolveSuppression(active, D("2027-09-30"), "B"), null, "another consumer is unaffected");
  // on the bus: three suppressions with evidence → the last create resolves all three; the cycle's decision record lists them
  const h = harness("2027-09-15T12:00:00.000Z");
  const ev = { trigger_event_id: "ev-1", evidence_document_id: "doc-1" };
  await h.exec("credit.suppression.create/release", AGENT, { id: "s-bk", reason: "bankruptcy_active", mechanism: "freeze_status", party_id: "A", codes: ["CII D"], starts_on: "2027-03-10", ...ev });
  await h.exec("credit.suppression.create/release", AGENT, { id: "s-scra", reason: "scra_relief", mechanism: "freeze_status", party_id: "A", starts_on: "2027-05-01", ...ev });
  const last = await h.exec("credit.suppression.create/release", AGENT, { id: "s-xb", reason: "fcra_dispute_open", mechanism: "flag_only", party_id: "A", codes: ["XB"], starts_on: "2027-09-15", ...ev });
  assert.deepEqual(last.resolved, { mechanism: "freeze_status", codes: ["CII D", "XB"], reasons: ["bankruptcy_active", "scra_relief", "fcra_dispute_open"] });
  const sep = buildSnapshot(state("2027-09-30", ledger("2027-09-01"), JAN_PRIOR));
  const b = buildCycle({ cycle_id: "2027-09", as_of: D("2027-09-30"), records: [{ snapshot: sep, suppressions: h.runner.activeSuppressions(h.loanId) }], config: CONFIG });
  assert.deepEqual(b.overlay_decisions, [{ loan_id: h.loanId, mechanism: "freeze_status", codes: ["CII D", "XB"], reasons: ["bankruptcy_active", "scra_relief", "fcra_dispute_open"] }]);
  assert.deepEqual(b.included[0]!.consumers.map((c) => [c.party_id, c.cii, c.ccc]), [["A", "D", "XB"]]);
});

test("8.3 rule 4 worked example: SCRA 6% cap on UPB $292,096.58 over 334 payments → P&I $1,800.91 (contract $1,847.15), forgiven interest $60.85, payment with $612.40 escrow $2,413.31; two missed PITI installments = $4,919.10", () => {
  const r = scraReducedPayment(29209658n, ratePercent("6.25"), 334, 61240n);
  assert.equal(r.pi_cents, 180091n); assert.equal(r.forgiven_interest_cents, 6085n); assert.equal(r.piti_cents, 241331n);
  assert.equal(184715n - 180091n > 0n, true); assert.equal(245955n * 2n, 491910n);
});

test("RESPA_2605E3_QWR_SUPPRESS_60 arms on a QWR (`case.noe.opened{is_qwr=true}`, receipt + 60 calendar days) and is satisfied by the expiry sweep's `credit.noe_bar.expired{is_qwr=true}`", async () => {
  const h = harness("2026-09-04T14:00:00.000Z");
  const noe = h.events.append({ type: "case.noe.opened", loanId: h.loanId, aggregate: { kind: "case", id: "qwr-1" }, actor: AGENT, payload: { ...NOE_OPENED, case_id: "qwr-1", is_qwr: true } });
  const respa = h.armed("RESPA_2605E3_QWR_SUPPRESS_60");
  assert.equal(respa.length, 1); assert.equal(respa[0]!.anchorDate, D("2026-09-04")); assert.equal(respa[0]!.dueDate, D("2026-11-03"));
  assert.equal(h.armed("REGX_1024_35I_CREDIT_SUPPRESS_60").length, 1, "a payment-related QWR is also a Reg X NoE (4.1's row)");
  const booked = await h.exec("credit.suppression.create/release", AGENT, { op: "ingest_noe", event_id: noe.id });
  assert.equal(booked.reason, "respa_6e3_qwr"); assert.equal(booked.ends_on, D("2026-11-03"));
  assert.equal(h.rt.store.get(SUPPRESSIONS, String(booked.suppression_id))!.data.scope, "all", "default scope: every overdue payment in the period the QWR addresses");
  // not yet: the sweep on the last day of the bar expires nothing
  assert.deepEqual((await h.exec("credit.suppression.create/release", AGENT, { op: "expire", today: "2026-11-03" })).expired, []);
  assert.equal(h.satisfied("RESPA_2605E3_QWR_SUPPRESS_60").length, 0);
  h.clock.set("2026-11-04T14:00:00.000Z");
  const sweep = await h.exec("credit.suppression.create/release", AGENT, { op: "expire", today: "2026-11-04" });
  assert.equal((sweep.expired as { is_qwr: boolean }[])[0]!.is_qwr, true);
  const expired = h.events.ofType("credit.noe_bar.expired");
  assert.deepEqual(expired.map((e) => [e.payload.is_qwr, e.payload.ends_on, e.payload.reason]), [[true, "2026-11-03", "respa_6e3_qwr"]]);
  assert.equal(eventMatches(loadOverriddenRegistry().get("RESPA_2605E3_QWR_SUPPRESS_60")!.satisfiedPattern!, expired[0]!), true);
  assert.equal(h.satisfied("RESPA_2605E3_QWR_SUPPRESS_60").length, 1);
  assert.equal(h.satisfied("RESPA_2605E3_QWR_SUPPRESS_60")[0]!.satisfiedByEventId, expired[0]!.id);
  // a non-QWR NoE never arms the RESPA row; a NoE touching no payment books no bar at all
  const h2 = harness("2026-09-04T14:00:00.000Z");
  h2.events.append({ type: "case.noe.opened", loanId: h2.loanId, aggregate: { kind: "case", id: "noe-x" }, actor: AGENT, payload: { ...NOE_OPENED, case_id: "noe-x", is_qwr: false } });
  assert.equal(h2.armed("RESPA_2605E3_QWR_SUPPRESS_60").length, 0);
  const none = h2.events.append({ type: "case.noe.opened", loanId: h2.loanId, aggregate: { kind: "case", id: "noe-y" }, actor: AGENT, payload: { ...NOE_OPENED, case_id: "noe-y", is_qwr: false, payment_related: false } });
  assert.equal(h2.runner.ingestNoeOpened(none), null);
});

test("8.3 overlay mechanisms compose in priority order: a bankruptcy freeze owns the status over a NoE projection while the codes co-exist; an unknown evaluation date is refused", () => {
  const led = ledger("2027-01-01");
  const feb = buildSnapshot(state("2027-02-28", led, JAN_PRIOR));
  const marRaw = buildSnapshot(state("2027-03-31", led, feb));
  const petition = { party_id: "A", chapter: 13 as const, petition_on: D("2027-03-10"), phase: { phase: "petition" as const, petition_status: "71" as const, petition_amount_past_due_cents: cents("4919.10") } };
  const o = applyOverlayMechanisms(marRaw, { installments: led, prior: feb, bankruptcy: petition, noe_bars: [{ received_on: D("2027-03-15"), scope: [D("2027-02-01")] }], deceased_party_ids: ["A"] }, D("2027-04-03"));
  assert.equal(o.snapshot.account_status, "71"); assert.equal(o.snapshot.amount_past_due_cents, cents("4919.10"), "the freeze (higher priority) owns status/APD");
  assert.deepEqual(o.snapshot.consumers.map((c) => [c.cii, c.ccc, c.ecoa]), [["D", "XB", "X"]]);
  assert.deepEqual([o.cii_applied, o.ecoa_x_applied, o.ecoa_x_party_ids, o.held_for_officer], [true, true, ["A"], null]);
  assert.deepEqual(o.applied, ["noe_bar:as_if_paid_projection:2027-02-01", "bankruptcy:petition", "deceased:ECOA X:A"]);
  assert.throws(() => applyOverlayMechanisms(marRaw, { installments: led, prior: feb }, "2027-4-3" as never), RangeError);
});
