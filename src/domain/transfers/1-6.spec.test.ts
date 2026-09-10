// 1.6 Escrow/suspense/UPB reconciliation
// spec/sections/01-boarding-servicing-transfer-in/1-6-escrow-suspense-upb-reconciliation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { cents } from "../../kernel/money/cents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { CommandBus, CommandRefused, type CommandContext } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolDef, type ToolRuntime } from "../../app/tools.ts";
import { TOOLS_1_6 } from "../../app/tools/section1-6.ts";
import { SECTION_06_TOOLS } from "../../app/tools/section06.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { BoardingService } from "../boarding/service.ts";
import { boardingMachine } from "../boarding/machine.ts";
import { stagedLoan, batchContext, FakePositions, type LoanOverrides } from "../boarding/fixtures.ts";
import { loanLevelRecon, escrowSetupEvents, activeGate, escalateBreach } from "./inbound.ts";
import { escrowContinuity, expectedWires, wireVariance, absorbGate, absorbNeedsOfficer, finalAccountingDue, fnmaPositionLagDeadline, fnmaPositionRecon, classifyVariance, shortageAnalysisDraft, lateChargeReceivable, isBorrowerAffecting } from "./reconciliation.ts";
import { inheritedBalanceTreatment, inheritedUnappliedId, type TransferorEscrowAnalysis } from "./ops-1-6.ts";

const AGENT: Actor = { kind: "agent", id: "custodial-recon" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const T = D("2026-10-01");
// The spec's three-loan worked example (cents).
const L1 = { upb_cents: 24_563_412n, escrow_cents: 184_250n, unapplied_cents: 32_500n, corporate_advances_cents: 15_000n, late_charges_cents: 6_464n };
const L2 = { upb_cents: 18_020_000n, escrow_cents: -41_300n, unapplied_cents: 0n, corporate_advances_cents: 0n, late_charges_cents: 0n };
const L3 = { upb_cents: 31_100_055n, escrow_cents: 92_015n, unapplied_cents: 0n, corporate_advances_cents: 0n, late_charges_cents: 0n, unremitted_pi_cents: 205_800n };
const BOARDED_UPB = L1.upb_cents + L2.upb_cents + L3.upb_cents;   // 73,683,467
/** A staged 1.1 loan carrying one of the worked-example balance sets. */
const staged = (seq: number, b: typeof L1 | typeof L3, extra: LoanOverrides = {}) => stagedLoan({ seq, upb_cents: b.upb_cents, escrow_balance_cents: b.escrow_cents, unapplied_cents: b.unapplied_cents, corporate_advances_cents: b.corporate_advances_cents, late_charges_due_cents: b.late_charges_cents, ...extra });
/** The transferor's last escrow analysis as it arrives on the tape (`escrow_analyses` seed, source=transferor). */
const TRANSFEROR_ANALYSIS = { analysis_date: "2026-03-15", computation_year_start: "2026-04-01", monthly_escrow_cents: "41250", cushion_cents: "82500", shortage_cents: "0", surplus_cents: "6000", deficiency_cents: "0", shortage_spread_months: null, method: "aggregate" };
const wire = (batch_id: string, custodial_account_id: string, kind: string, amount_cents: string, wire_reference: string) => ({ op: "wire", batch_id, custodial_account_id, kind, amount_cents, wire_reference, sender: "Transferor Bank" });

/**
 * The 1.6 tools on the command bus over the same in-memory event store, ledger and timer engine the 1.1 BoardingService
 * writes to (the fully overridden registry, so `loan.validated` / `loan.boarded` / `transfer.batch.cutover_completed` arm
 * the 1.6 clocks exactly as in production), plus the Notice Registry (3.1's initial escrow statement) and 6.5's suspense
 * tools (the inherited-unapplied closure).
 */
function live(nowIso: string, transferDate = T, processes: readonly string[] = ["1.6"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const registry = loadOverriddenRegistry(); const timers = new TimerEngine(registry, events, { processes: [...processes] });
  const ext = new FakePositions(); const svc = new BoardingService({ events, ledger, ext, clock, clearingAccountId: "CUST-CLEARING" });
  svc.openBatch(batchContext({ batch_id: "B1", transfer_date: transferDate }));
  const esc = new EscalationService(events, clock);
  const noticeReg = buildRegistry(); publishAuthored(noticeReg);
  const notices = new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const decisions: { action?: string; agent?: string }[] = [];
  const ctx = { loanId: "", events, ledger, timers, clock, decide: (d: { action?: string; agent?: string }) => { decisions.push(d); } } as unknown as UowContext;
  const rt: ToolRuntime = { store: new EntityStore(), escalations: esc, services: { boarding: svc }, notices, ports: {} };
  // Bound exactly as src/app/tools/index.ts bindTools does (toolCommand + the agent allowlist), without importing every section's tools file.
  const agents = new AgentRegistry(); const bus = new CommandBus(agents); const cmds = new Map<string, ReturnType<typeof toolCommand>>();
  for (const d of [...TOOLS_1_6, ...SECTION_06_TOOLS.filter((t) => t.process === "6.5")] as ToolDef[]) { const cmd = toolCommand(d, rt, ["officer"]); agents.registerTool(d.agent, cmd.name); cmds.set(`${d.process} ${d.name}`, cmd); }
  const run = async (name: string, actor: Actor, input: Record<string, unknown>, now?: string, process = "1.6"): Promise<Record<string, unknown>> => { if (now) clock.set(now); return (await bus.execute(cmds.get(`${process} ${name}`)!, actor, input, ctx)).output as Record<string, unknown>; };
  const refused = async (name: string, actor: Actor, input: Record<string, unknown>, now?: string): Promise<string> => { try { await run(name, actor, input, now); } catch (e) { if (e instanceof CommandRefused) return e.code; throw e; } return "ALLOWED"; };
  /** stage → validate → board through the 1.1 service (finalTapeReconciled asserted by the caller, as boardLoan does). */
  const board = (o: LoanOverrides) => { const loan = stagedLoan(o); ext.agree(loan); const [bl] = svc.stage("B1", [loan]); svc.validate("B1"); const r = svc.board("B1", { finalTapeReconciled: true }); return { loan, bl: bl!, boarded: r.boarded.some((b) => b.id === bl!.id), refused: r.refused.map((x) => x.reason) }; };
  return { clock, events, ledger, timers, registry, svc, ext, esc, notices, noticeReg, rt, ctx, run, refused, board, decisions };
}

test("1.6-T1: Given the three-loan example, when wires of 276,265 (T&I) and 238,300 (P&I) are received, then both wire reconciliations balance and L2 carries a 41,300 `escrow_advances` receivable.", async () => {
  const exp = expectedWires([L1, L2, L3]);
  assert.deepEqual([exp.ti_wire_cents, exp.pi_wire_cents, exp.escrow_advances_receivable_cents], [276_265n, 238_300n, 41_300n]);   // 184,250 + 92,015; 32,500 + 205,800; L2's −41,300 is a receivable, not cash
  const h = live("2026-10-01T14:00:00.000Z");
  const l1 = h.board(staged(1, L1)), l2 = h.board(staged(2, L2)), l3 = h.board(staged(3, L3));
  assert.deepEqual([l1.boarded, l2.boarded, l3.boarded], [true, true, true]);
  // Opening postings at `loan.boarded` (rule 2), balanced against transfer_in_clearing: L2's negative escrow is Dr escrow_advances (receivable); L1's unapplied is Cr suspense, its late charge a memo receivable.
  const bal = (loanId: string, account: "escrow_advance" | "escrow" | "suspense_unapplied" | "late_charges" | "principal" | "corporate_advance") => h.ledger.balance({ scope: "loan", loanId, account });
  assert.equal(bal(l2.bl.loan_id!, "escrow_advance"), 41_300n); assert.equal(bal(l2.bl.loan_id!, "escrow"), 0n); assert.equal(bal(l2.bl.loan_id!, "principal"), 18_020_000n);
  assert.deepEqual([bal(l1.bl.loan_id!, "principal"), bal(l1.bl.loan_id!, "escrow"), bal(l1.bl.loan_id!, "suspense_unapplied"), bal(l1.bl.loan_id!, "corporate_advance"), bal(l1.bl.loan_id!, "late_charges")], [24_563_412n, -184_250n, -32_500n, 15_000n, 6_464n]);
  assert.equal(bal(l3.bl.loan_id!, "escrow"), -92_015n);
  // Cutover arms SM_RECON_WIRE_MATCH_1: T + 1 servicer business day = Fri Oct 2, 2026.
  h.svc.completeCutover("B1");
  const t = h.timers.byCode("SM_RECON_WIRE_MATCH_1")[0]!; assert.equal(t.dueDate, "2026-10-02"); assert.equal(t.status, "armed");
  // The bank feed's wire advices land as transfer_funds_receipts (custodial.wire.received), idempotent by bank reference.
  h.clock.set("2026-10-02T15:00:00.000Z");
  const ti = await h.run("loadBankFeed", AGENT, wire("B1", "CUST-TI", "escrow", "276265", "FED-TI-0001"));
  await h.run("loadBankFeed", AGENT, wire("B1", "CUST-PI-AA", "pi_unremitted", "205800", "FED-PI-0001"));
  await h.run("loadBankFeed", AGENT, wire("B1", "CUST-PI-AA", "unapplied", "32500", "FED-PI-0002"));
  assert.deepEqual([ti.kind, ti.wire, ti.received_cents, ti.duplicate], ["escrow", "ti", "276265", false]);
  const replay = await h.run("loadBankFeed", AGENT, wire("B1", "CUST-TI", "escrow", "276265", "FED-TI-0001"));
  assert.equal(replay.duplicate, true); assert.equal(h.events.ofType("custodial.wire.received").length, 3);
  // matchWires: both wires equal the trial-balance totals by category → recon.wires.matched satisfies the clock; receipts are matched, both reconciliations balanced.
  const m = await h.run("matchWires", AGENT, { batch_id: "B1", loans: [L1, L2, L3] });
  assert.deepEqual([m.wires_matched, m.batch_status], [true, "wires_matched"]); assert.deepEqual(m.received, { ti: 276_265n, pi: 238_300n, other: 0n });
  const matched = h.events.ofType("recon.wires.matched"); assert.equal(matched.length, 1); assert.deepEqual([matched[0]!.payload.ti_cents, matched[0]!.payload.pi_cents], ["276265", "238300"]);
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, matched[0]!.id);
  assert.ok(h.rt.store.list("transfer_funds_receipts").every((r) => r.data.matched_at === "2026-10-02"));
  assert.deepEqual([h.rt.store.get("reconciliations", "B1:boarding_wire_ti")!.data.status, h.rt.store.get("reconciliations", "B1:boarding_wire_pi")!.data.status], ["balanced", "balanced"]);
  assert.equal(h.events.ofType("recon.variance.raised").length, 0);
});
test("1.6-T2: Given a P&I wire of 238,000, then a 300-cent variance is raised with SLA 5 business days and the batch cannot reach `wires_matched`.", async () => {
  const v = wireVariance(238_300n, 238_000n, "pi", D("2026-10-02"));
  assert.deepEqual([v.variance_cents, v.category, v.sla_due, v.blocks_wires_matched], [-300n, "unknown", "2026-10-09", true]);   // unknown → transferor query; Oct 2 + 5 servicer business days
  const h = live("2026-10-01T14:00:00.000Z"); h.board(staged(1, L1)); h.board(staged(2, L2)); h.board(staged(3, L3)); h.svc.completeCutover("B1");
  const wireClock = h.timers.byCode("SM_RECON_WIRE_MATCH_1")[0]!;
  h.clock.set("2026-10-02T15:00:00.000Z");
  await h.run("loadBankFeed", AGENT, wire("B1", "CUST-TI", "escrow", "276265", "FED-TI-0001"));
  await h.run("loadBankFeed", AGENT, wire("B1", "CUST-PI-AA", "pi_unremitted", "238000", "FED-PI-0001"));
  const m = await h.run("matchWires", AGENT, { batch_id: "B1", loans: [L1, L2, L3] });
  assert.deepEqual([m.wires_matched, m.batch_status, (m.ti as { blocks_wires_matched: boolean }).blocks_wires_matched, (m.pi as { variance_cents: bigint }).variance_cents], [false, "variances_open", false, -300n]);
  const raised = h.events.ofType("recon.variance.raised"); assert.equal(raised.length, 1);
  assert.deepEqual([raised[0]!.payload.field, raised[0]!.payload.difference_cents, raised[0]!.payload.category, raised[0]!.payload.batch_id], ["pi_wire", -300n, "unknown", "B1"]);
  const sla = h.timers.byCode("SM_RECON_VARIANCE_SLA_5"); assert.equal(sla.length, 1); assert.equal(sla[0]!.dueDate, "2026-10-09");
  assert.equal(h.events.ofType("recon.wires.matched").length, 0, "the batch stays in variances_open; no wires_matched"); assert.equal(wireClock.status, "armed");
  assert.equal(h.rt.store.get("recon_variances", "B1:pi_wire")!.data.sla_due, "2026-10-09"); assert.equal(h.rt.store.get("reconciliations", "B1:boarding_wire_pi")!.data.status, "open");
  // The nightly re-run neither plugs the difference nor raises a second variance for the same open wire.
  const again = await h.run("matchWires", AGENT, { batch_id: "B1", loans: [L1, L2, L3] });
  assert.equal(again.wires_matched, false); assert.equal(h.events.ofType("recon.variance.raised").length, 1); assert.equal(h.events.ofType("recon.wires.matched").length, 0);
  // Oct 3: the wire-match clock breaches (sev 1 → officer; shortfall demand to the transferor drafted by the agent).
  const breach = h.timers.evaluate("2026-10-03T14:00:00.000Z").find((b) => b.def.code === "SM_RECON_WIRE_MATCH_1")!;
  assert.equal(breach.severity, 1); assert.ok(breach.escalateTo.includes("officer")); assert.match(breach.breachText, /shortfall demand/);
  await h.run("draftTransferorQuery", AGENT, { data: { batch_id: "B1", variance_id: "B1:pi_wire", kind: "shortfall_demand", amount_cents: "300", signer_role: "officer" } }, "2026-10-05T14:00:00.000Z");
  assert.equal(h.events.ofType("transferor_query.drafted").length, 1);
  // Oct 7: the transferor wires the 300; the variance resolves transferor_corrected on the bank evidence (SLA satisfied) and the batch reaches wires_matched (the breached clock closes late).
  await h.run("loadBankFeed", AGENT, wire("B1", "CUST-PI-AA", "pi_unremitted", "300", "FED-PI-0002"), "2026-10-07T15:00:00.000Z");
  await h.run("raiseVariance", AGENT, { id: "B1:pi_wire", data: { resolution: "transferor_corrected", evidence_document_id: "doc-FED-PI-0002" } });
  assert.equal(h.events.ofType("recon.variance.resolved")[0]!.payload.resolution, "transferor_corrected"); assert.equal(sla[0]!.status, "satisfied");
  const fixed = await h.run("matchWires", AGENT, { batch_id: "B1", loans: [L1, L2, L3] });
  assert.deepEqual([fixed.wires_matched, fixed.batch_status], [true, "wires_matched"]); assert.equal(wireClock.status, "satisfied_late");
});
test("1.6-T3: Given a tape UPB ≠ trial-balance UPB for a loan, then the loan cannot board (`SM_RECON_LOAN_LEVEL_T0`).", async () => {
  const r = loanLevelRecon({ upb_cents: 24_563_412n, escrow_cents: 184_250n }, { upb_cents: 24_563_413n, escrow_cents: 184_250n });
  assert.equal(r.status, "variance"); assert.deepEqual(r.variances, [{ field: "upb_cents", tape: 24_563_412n, trial_balance: 24_563_413n }]); assert.equal(r.gate, "SM_RECON_LOAN_LEVEL_T0");
  assert.equal(evaluateGate("1.6.loanReconciledBeforeBoard", { recon_status: r.status }).open, false);   // boardLoan asserts this gate
  assert.equal(evaluateGate("1.6.loanReconciledBeforeBoard", { recon_status: loanLevelRecon({ upb_cents: 1n }, { upb_cents: 1n }).status }).open, true);
  // Through the 1.1 service: `loan.validated` arms the not-before gate; the loan-level reconciliation raises the UPB variance and the board command is refused until it clears.
  const h = live("2026-10-01T14:00:00.000Z");
  const loan = staged(1, L1); h.ext.agree(loan); const [bl] = h.svc.stage("B1", [loan]); h.svc.validate("B1"); assert.equal(bl!.status, "validated");
  const gate = h.timers.byCode("SM_RECON_LOAN_LEVEL_T0").filter((t) => t.loanId === bl!.id); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "armed"); assert.equal(gate[0]!.note, "evaluator:1.6.loanReconciledBeforeBoard");
  const tape = { upb: "24563412", escrow_balance: "184250", unapplied: "32500", corporate_advances: "15000", late_charges_due: "6464" };
  const bad = await h.run("raiseVariance", AGENT, { op: "loan_level", loan_id: bl!.id, batch_id: "B1", tape, trial_balance: { ...tape, upb: "24563413" } });
  assert.deepEqual([bad.status, bad.boardable, bad.gate], ["variance", false, "SM_RECON_LOAN_LEVEL_T0"]);
  assert.deepEqual((bad.variances as { field: string; difference_cents: bigint; category: string }[]).map((x) => [x.field, x.difference_cents, x.category]), [["upb", 1n, "unknown"]]);
  assert.equal(h.events.ofType("recon.loan.reconciled").length, 0); assert.equal(gate[0]!.status, "armed"); assert.equal(h.timers.byCode("SM_RECON_VARIANCE_SLA_5").length, 1);
  assert.equal(h.rt.store.get("reconciliations", `B1:${bl!.id}:boarding_loan_level`)!.data.status, "open");
  const closed = evaluateGate("1.6.loanReconciledBeforeBoard", { recon_status: bad.status }); assert.equal(closed.open, false);
  const attempt = boardingMachine.attempt("validated", "board", AGENT, { openHardFailures: 0, transferDateReached: true, finalTapeReconciled: closed.open, onApprovedList: true });
  assert.equal(attempt.ok, false); if (!attempt.ok) assert.match(attempt.reason, /not reconciled/);
  const refusedBoard = h.svc.board("B1", { finalTapeReconciled: closed.open }); assert.equal(refusedBoard.boarded.length, 0); assert.match(refusedBoard.refused[0]!.reason, /not reconciled/); assert.equal(bl!.status, "validated");
  // The transferor's corrected trial balance: the field agrees, the open variance resolves transferor_corrected on that evidence, the gate is satisfied and the loan boards.
  const good = await h.run("raiseVariance", AGENT, { op: "loan_level", loan_id: bl!.id, batch_id: "B1", tape, trial_balance: tape, evidence_document_id: "doc-trial-balance-v2" }, "2026-10-01T18:00:00.000Z");
  assert.deepEqual([good.status, good.boardable, good.resolved], ["reconciled", true, ["upb"]]);
  assert.equal(h.events.ofType("recon.variance.resolved")[0]!.payload.resolution, "transferor_corrected"); assert.equal(h.timers.byCode("SM_RECON_VARIANCE_SLA_5")[0]!.status, "satisfied");
  assert.equal(gate[0]!.status, "satisfied"); assert.equal(gate[0]!.satisfiedByEventId, h.events.ofType("recon.loan.reconciled")[0]!.id);
  assert.equal(h.svc.board("B1", { finalTapeReconciled: evaluateGate("1.6.loanReconciledBeforeBoard", { recon_status: good.status }).open }).boarded.length, 1); assert.equal(bl!.status, "boarded");
});
test("1.6-T4: Given Supermortgage keeps the transferor's escrow payment and method, then no initial escrow statement timer is created and the computation year is retained.", async () => {
  const kept = escrowContinuity(true, true, D("2026-10-01"));
  assert.deepEqual(kept, { initial_statement_due: null, computation_year_start: "retained" });   // no REGX_1024_17E_INITIAL_ESCROW_STMT_60 instance
  const changed = escrowContinuity(false, true, D("2026-10-01"));
  assert.equal(changed.initial_statement_due, "2026-11-30"); assert.equal(changed.computation_year_start, "2026-10-01");
  // `loan.boarded{escrowed}` arms the 30-day computation-year decision clock (T + 30 = Oct 31); the escrow agent's decision satisfies it and seeds escrow_analyses from the transferor's analysis.
  const h = live("2026-10-01T14:00:00.000Z"); const { bl } = h.board(staged(1, L1));
  const decide = h.timers.byCode("SM_ESCROW_COMPUTATION_YEAR_DECISION_30").filter((t) => t.loanId === bl.id); assert.equal(decide.length, 1); assert.equal(decide[0]!.dueDate, "2026-10-31");
  const d = await h.run("writeDecision", AGENT, { op: "escrow_computation_year", loan_id: bl.id, batch_id: "B1", transfer_date: "2026-10-01", transferor: TRANSFEROR_ANALYSIS, monthly_escrow_cents: "41250" }, "2026-10-05T14:00:00.000Z");
  assert.deepEqual([d.decision, d.computation_year_start, d.initial_statement_due, d.initial_statement_required, d.payment_changed, d.method_changed, d.method], ["retained", "2026-04-01", null, false, false, false, "aggregate"]);
  assert.equal(h.events.ofType("escrow.terms.changed_at_transfer").length, 0); assert.equal(h.timers.byCode("REGX_1024_17E_INITIAL_ESCROW_STMT_60").length, 0);
  const decided = h.events.ofType("escrow.computation_year.decided"); assert.equal(decided.length, 1); assert.equal(decided[0]!.loanId, bl.id); assert.equal(decided[0]!.payload.decision, "retained");
  assert.equal(decide[0]!.status, "satisfied"); assert.equal(decide[0]!.satisfiedByEventId, decided[0]!.id);
  const seed = h.rt.store.get("escrow_analyses", `${bl.id}:transferor`)!.data; assert.deepEqual([seed.source, seed.computation_year_start, seed.monthly_escrow_cents, seed.continuity], ["transferor", "2026-04-01", "41250", "retained"]);
  assert.ok(h.decisions.some((x) => x.action === "escrow.computation_year:retained"));
  // §1024.17(f) on the inherited balances: the $60.00 surplus is refunded within 30 days of the analysis that identified it; a shortage spreads over ≥ 12 months.
  assert.deepEqual([(d.inherited as { surplus: string }).surplus, (d.inherited as { surplus_refund_due: string }).surplus_refund_due], ["refund_within_30_days", "2026-04-14"]);
  const a: TransferorEscrowAnalysis = { analysis_date: D("2026-03-15"), computation_year_start: D("2026-04-01"), monthly_escrow_cents: 41_250n, cushion_cents: 82_500n, shortage_cents: 60_000n, surplus_cents: 0n, deficiency_cents: 0n, shortage_spread_months: 6, method: "aggregate" };
  assert.deepEqual([inheritedBalanceTreatment(a).shortage, inheritedBalanceTreatment(a).shortage_spread_months, inheritedBalanceTreatment({ ...a, shortage_cents: 30_000n }).shortage, inheritedBalanceTreatment({ ...a, surplus_cents: 4_999n, shortage_cents: 0n }).surplus], ["spread_12_months_or_more", 12, "collect_30_days_or_spread", "credit_or_refund"]);
  // §1024.17(e)(1): a kept payment and method may still start a new year with a short-year statement (3.3) — still no initial statement.
  const { bl: bl2 } = h.board(staged(2, L2));
  const short = await h.run("writeDecision", AGENT, { op: "escrow_computation_year", loan_id: bl2.id, batch_id: "B1", transfer_date: "2026-10-01", transferor: TRANSFEROR_ANALYSIS, monthly_escrow_cents: "41250", short_year_statement: true });
  assert.deepEqual([short.decision, short.computation_year_start, short.initial_statement_due], ["short_year", "2026-10-01", null]); assert.equal(h.timers.byCode("REGX_1024_17E_INITIAL_ESCROW_STMT_60").length, 0);
});
test("1.6-T5: Given Supermortgage changes the monthly escrow payment on Oct. 1, 2026, then `REGX_1024_17E_INITIAL_ESCROW_STMT_60` is due Nov. 30, 2026 and the new computation year starts Oct. 1, 2026.", async () => {
  assert.deepEqual(escrowContinuity(false, true, D("2026-10-01")), { initial_statement_due: "2026-11-30", computation_year_start: "2026-10-01" });
  assert.deepEqual(escrowContinuity(true, false, D("2026-10-01")), { initial_statement_due: "2026-11-30", computation_year_start: "2026-10-01" });   // a method change alone also restarts the year
  const h = live("2026-10-01T14:00:00.000Z"); const { bl } = h.board(staged(1, L1));
  // The escrow agent raises the monthly escrow (Supermortgage's cushion policy, 3.4): payment changed → escrow.terms.changed_at_transfer arms the 60-day clock from the transfer date; the year restarts Oct 1.
  const d = await h.run("writeDecision", AGENT, { op: "escrow_computation_year", loan_id: bl.id, batch_id: "B1", transfer_date: "2026-10-01", transferor: TRANSFEROR_ANALYSIS, monthly_escrow_cents: "43000", rationale: "Supermortgage cushion policy (3.4) raises the monthly escrow" }, "2026-10-01T16:00:00.000Z");
  assert.deepEqual([d.decision, d.computation_year_start, d.initial_statement_due, d.initial_statement_required, d.payment_changed, d.method_changed], ["new_year", "2026-10-01", "2026-11-30", true, true, false]);
  const changed = h.events.ofType("escrow.terms.changed_at_transfer"); assert.equal(changed.length, 1); assert.equal(changed[0]!.loanId, bl.id);
  assert.deepEqual([changed[0]!.payload.transfer_date, changed[0]!.payload.payment_changed, changed[0]!.payload.computation_year_start, changed[0]!.payload.statement], ["2026-10-01", true, "2026-10-01", "NTC_REGX_1024_17G_INITIAL_ESCROW_STMT"]);
  const t = h.timers.byCode("REGX_1024_17E_INITIAL_ESCROW_STMT_60"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-11-30"); assert.equal(t[0]!.anchorDate, "2026-10-01"); assert.equal(t[0]!.loanId, bl.id);
  assert.equal(h.timers.byCode("SM_ESCROW_COMPUTATION_YEAR_DECISION_30").find((x) => x.loanId === bl.id)!.status, "satisfied");
  // A single-item transferor is a method change (§1024.17(c)(4) mandates aggregate accounting) — the same clock, even with the payment kept.
  const { bl: bl2 } = h.board(staged(2, L2));
  const m = await h.run("writeDecision", AGENT, { op: "escrow_computation_year", loan_id: bl2.id, batch_id: "B1", transfer_date: "2026-10-01", transferor: { ...TRANSFEROR_ANALYSIS, method: "single_item" }, monthly_escrow_cents: "41250" });
  assert.deepEqual([m.decision, m.payment_changed, m.method_changed, m.initial_statement_due], ["new_year", false, true, "2026-11-30"]);
  assert.equal(h.timers.byCode("REGX_1024_17E_INITIAL_ESCROW_STMT_60").length, 2);
  // 3.1 sends the initial escrow statement through the Notice Registry (mail — no e-delivery without verified consent); `notice.sent{template}` on the loan satisfies its clock and no other loan's.
  const sample = h.noticeReg.activeVersion("NTC_REGX_1024_17G_INITIAL_ESCROW_STMT", D("2026-10-20"))!.samplePayload;
  const n = h.notices.render({ templateCode: "NTC_REGX_1024_17G_INITIAL_ESCROW_STMT", loanId: bl.id, recipients: [{ partyId: "B1", name: "A. Borrower", mailingAddress: "12 Elm St, Columbus OH 43215" }], payload: { ...sample, computation_year_start: "2026-10-01", computation_year_end: "2027-09-30" }, asOf: D("2026-10-20") });
  assert.equal(n.status, "rendered"); h.clock.set("2026-10-20T14:00:00.000Z"); await h.notices.send(n.id);
  const sent = h.events.ofType("notice.sent").at(-1)!; assert.equal(sent.payload.template, "NTC_REGX_1024_17G_INITIAL_ESCROW_STMT"); assert.equal(sent.loanId, bl.id);
  assert.ok(eventMatches(h.registry.get("REGX_1024_17E_INITIAL_ESCROW_STMT_60")!.satisfiedPattern!, sent));
  assert.equal(t[0]!.status, "satisfied"); assert.equal(t[0]!.satisfiedByEventId, sent.id);
  assert.equal(h.timers.byCode("REGX_1024_17E_INITIAL_ESCROW_STMT_60").find((x) => x.loanId === bl2.id)!.status, "armed");
});
test("1.6-T6: Given transfer date Oct. 1, 2026 and no final accounting by Oct. 31, then the timer breaches, an `officer` escalation exists and Supermortgage's own shortage analysis draft is produced.", async () => {
  assert.equal(finalAccountingDue(D("2026-10-01")), "2026-10-31");
  const h = live("2026-10-01T14:00:00.000Z"); h.board(staged(1, L1)); h.board(staged(2, L2)); h.board(staged(3, L3)); h.svc.completeCutover("B1");
  const t = h.timers.byCode("FNMA_F1_11_FINAL_ACCOUNTING_30")[0]!; assert.equal(t.dueDate, "2026-10-31");
  assert.equal(h.timers.evaluate("2026-10-31T20:00:00.000Z").filter((b) => b.def.code === "FNMA_F1_11_FINAL_ACCOUNTING_30").length, 0);
  const breach = h.timers.evaluate("2026-11-01T14:00:00.000Z").find((b) => b.def.code === "FNMA_F1_11_FINAL_ACCOUNTING_30")!;
  assert.equal(t.status, "breached"); assert.equal(breach.severity, 1); assert.ok(breach.escalateTo.includes("officer")); assert.match(breach.breachText, /own shortage analysis/);
  const e = escalateBreach(h.esc, breach, AGENT); assert.equal(e.ownerRole, "officer"); assert.equal(h.esc.opened[0]!.batchId, "B1"); assert.equal(h.esc.opened[0]!.status, "open");
  const draft = shortageAnalysisDraft({ batch_id: "B1", transfer_date: D("2026-10-01"), prepared_on: D("2026-11-01"), loans: [{ fnma_loan_number: "4000000001", upb_cents: L1.upb_cents }, { fnma_loan_number: "4000000002", upb_cents: L2.upb_cents, escrow_advances_cents: 41_300n }, { fnma_loan_number: "4000000003", upb_cents: L3.upb_cents, unremitted_pi_cents: 205_800n }] });
  assert.deepEqual([draft.status, draft.prepared_by, draft.final_accounting_due, draft.loan_count, draft.upb_total_cents, draft.unremitted_pi_total_cents, draft.advances_claimed_cents, draft.shortage_surplus_cents], ["draft", "supermortgage", "2026-10-31", 3, 73_683_467n, 205_800n, 41_300n, 164_500n]);
  assert.match(draft.basis, /F-1-11/);
  // Reimbursing before any final accounting is refused — F-1-11 reimburses "once it receives a final accounting".
  assert.equal(await h.refused("postOpeningEntries", AGENT, { op: "reimburse_transferor", batch_id: "B1", custodial_account_id: "CUST-CLEARING", paid_on: "2026-11-02", amount_cents: "41300" }, "2026-11-02T14:00:00.000Z"), "FINAL_ACCOUNTING_SUBSTANTIATION");
  // Nov 3: the transferor's final accounting arrives late (satisfied_late) with its Fannie Mae adjustment-request evidence and arms the 30-day reimbursement clock from receipt (Dec 3).
  const fa = await h.run("loadTapeBalances", AGENT, { op: "final_accounting", batch_id: "B1", document_id: "doc-fa", received_on: "2026-11-03", transfer_date: "2026-10-01", advances_claimed_cents: "41300", shortage_surplus_cents: "0", fnma_adjustment_request_document_id: "doc-adj" }, "2026-11-03T14:00:00.000Z");
  assert.deepEqual([fa.late, fa.due, fa.advances_claimed_cents, fa.adjustment_request_evidenced, fa.batch_status], [true, "2026-10-31", 41_300n, true, "final_accounting_received"]);
  assert.equal(t.status, "satisfied_late");
  const reimb = h.timers.byCode("SM_ADVANCE_REIMBURSE_TRANSFEROR_30")[0]!; assert.equal(reimb.dueDate, "2026-12-03"); assert.equal(reimb.anchorDate, "2026-11-03");
  // Only substantiated amounts: 50,000 > the 41,300 claimed is refused; the 41,300 posts Dr transfer_in_clearing / Cr corporate_cash and `ledger.posted{advance_reimbursement_out}` satisfies the clock.
  assert.equal(await h.refused("postOpeningEntries", AGENT, { op: "reimburse_transferor", batch_id: "B1", custodial_account_id: "CUST-CLEARING", paid_on: "2026-11-10", amount_cents: "50000" }, "2026-11-10T14:00:00.000Z"), "FINAL_ACCOUNTING_SUBSTANTIATION");
  const paid = await h.run("postOpeningEntries", AGENT, { op: "reimburse_transferor", batch_id: "B1", custodial_account_id: "CUST-CLEARING", paid_on: "2026-11-10", amount_cents: "41300", wire_reference: "FED-OUT-0001" });
  assert.deepEqual([paid.amount_cents, paid.settled_cents, paid.unsettled_cents, paid.batch_status], [41_300n, 41_300n, 0n, "advances_settled"]);
  const posted = h.events.ofType("ledger.posted").find((x) => x.payload.advance_reimbursement_out === true)!;
  assert.deepEqual([posted.payload.amount_cents, posted.payload.batch_id, posted.aggregate], ["41300", "B1", { kind: "transfer_batch", id: "B1" }]);
  assert.ok(eventMatches(h.registry.get("SM_ADVANCE_REIMBURSE_TRANSFEROR_30")!.satisfiedPattern!, posted));
  assert.equal(reimb.status, "satisfied"); assert.equal(reimb.satisfiedByEventId, posted.id);
  const set = h.ledger.sets().find((s) => s.id === paid.set_id)!;
  assert.equal(set.lines.reduce((s, l) => s + l.amountCents, 0n), 0n); assert.ok(set.lines.every((l) => l.ruleRef === "1.6 funds: advance_reimbursement_out"));
  assert.equal(h.ledger.balance({ scope: "corporate", account: "corporate_cash" }), -41_300n);
  assert.equal(h.rt.store.get("reconciliations", "B1:boarding_final_accounting")!.data.status, "closed"); assert.equal(h.events.ofType("transfer.advances.settled").length, 1);
});
test("1.6-T7: Given the Fannie Mae position still shows the transferor's pre-transfer UPB on Oct. 15 (LAR lag), then the variance is `fnma_reporting_lag` and must close by Oct. 30, 2026 (last Fannie Mae business day of October).", async () => {
  assert.equal(fnmaPositionLagDeadline(D("2026-10-01")), "2026-10-30");   // Oct 31, 2026 is a Saturday
  const r = fnmaPositionRecon({ transfer_date: D("2026-10-01"), as_of: D("2026-10-15"), boarded_upb_cents: 73_683_467n, fnma_position_upb_cents: 73_720_112n, transferor_pre_transfer_upb_cents: 73_720_112n, transferor_lar_posted: false });
  assert.deepEqual([r.category, r.must_close_by, r.balanced, r.overdue, r.difference_cents], ["fnma_reporting_lag", "2026-10-30", false, false, 36_645n]);
  assert.equal(classifyVariance({ difference_cents: 36_645n, fnma_position_is_pre_transfer: true, transferor_lar_posted: true }), "unknown", "once the LAR has posted a remaining difference is no longer a lag");
  assert.equal(classifyVariance({ difference_cents: -300n, in_transit_cents: 300n }), "timing_in_transit"); assert.equal(classifyVariance({ difference_cents: 1n, transferor_corrected: true }), "transferor_error"); assert.equal(classifyVariance({ difference_cents: 1n, mapping_mismatch: true }), "mapping_error");
  const h = live("2026-10-01T14:00:00.000Z"); h.board(staged(1, L1)); h.board(staged(2, L2)); h.board(staged(3, L3)); h.svc.completeCutover("B1");
  const t = h.timers.byCode("SM_RECON_FNMA_POSITION_EOM")[0]!; assert.equal(t.dueDate, "2026-10-30"); assert.equal(t.anchorDate, "2026-10-30");
  // Oct 15: the position is the transferor's pre-transfer figure and its LAR has not posted → one fnma_reporting_lag variance, must close by Oct 30.
  const lag = await h.run("classifyVariance", AGENT, { op: "fnma_position", batch_id: "B1", transfer_date: "2026-10-01", as_of: "2026-10-15", boarded_upb_cents: String(BOARDED_UPB), fnma_position_upb_cents: "73720112", transferor_pre_transfer_upb_cents: "73720112", transferor_lar_posted: false }, "2026-10-15T14:00:00.000Z");
  assert.deepEqual([lag.category, lag.must_close_by, lag.balanced, lag.overdue, lag.difference_cents, lag.raised, lag.batch_status], ["fnma_reporting_lag", "2026-10-30", false, false, 36_645n, true, "variances_open"]);
  const raised = h.events.ofType("recon.variance.raised"); assert.equal(raised.length, 1); assert.deepEqual([raised[0]!.payload.category, raised[0]!.payload.field], ["fnma_reporting_lag", "upb"]); assert.equal(t.status, "armed");
  assert.equal(h.rt.store.get("recon_variances", "B1:fnma_position")!.data.must_close_by, "2026-10-30");
  // The nightly re-check does not raise a second variance for the same open lag.
  const again = await h.run("classifyVariance", AGENT, { op: "fnma_position", batch_id: "B1", transfer_date: "2026-10-01", as_of: "2026-10-16", boarded_upb_cents: String(BOARDED_UPB), fnma_position_upb_cents: "73720112", transferor_pre_transfer_upb_cents: "73720112", transferor_lar_posted: false }, "2026-10-16T14:00:00.000Z");
  assert.deepEqual([again.raised, again.category], [false, "fnma_reporting_lag"]); assert.equal(h.events.ofType("recon.variance.raised").length, 1);
  // Oct 28: the transferor's transfer-month LAR posted and the position equals Σ boarded UPB → balanced, the lag variance resolved on the LSDU snapshot, the EOM clock satisfied before Oct 30.
  const ok = await h.run("classifyVariance", AGENT, { op: "fnma_position", batch_id: "B1", transfer_date: "2026-10-01", as_of: "2026-10-28", boarded_upb_cents: String(BOARDED_UPB), fnma_position_upb_cents: String(BOARDED_UPB), transferor_lar_posted: true, snapshot_document_id: "doc-lsdu-2026-10-28" }, "2026-10-28T14:00:00.000Z");
  assert.deepEqual([ok.balanced, ok.category, ok.resolved, ok.batch_status], [true, "matched", true, "fnma_position_reconciled"]);
  const balanced = h.events.ofType("recon.fnma_position.balanced"); assert.equal(balanced.length, 1); assert.equal(balanced[0]!.payload.upb_cents, BOARDED_UPB);
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, balanced[0]!.id);
  assert.deepEqual([h.events.ofType("recon.variance.resolved")[0]!.payload.resolution, h.events.ofType("recon.variance.resolved")[0]!.payload.evidence_document_id], ["transferor_corrected", "doc-lsdu-2026-10-28"]);
  assert.equal(h.rt.store.get("reconciliations", "B1:boarding_fnma_position")!.data.status, "balanced");
});
test("1.6-T8: Given a batch-level variance of $5,001 the agent proposes to absorb, then the command is refused without `officer` approval.", async () => {
  assert.equal(absorbGate(500_100n, false), false); assert.equal(absorbGate(500_100n, true), true);
  assert.equal(absorbGate(500_000n, false), false, "≥ $5,000/batch needs the officer"); assert.equal(absorbGate(499_900n, false), true);
  assert.equal(absorbGate(2_500n, false, "loan"), false, "≥ $25/loan needs the officer"); assert.equal(absorbGate(2_400n, false, "loan"), true);
  assert.equal(absorbGate(1n, false, "loan", true), false, "any borrower-affecting cent needs the officer"); assert.equal(absorbNeedsOfficer(1n, "batch", isBorrowerAffecting("escrow_balance")), true);
  // The path that records it: raiseVariance's guardrail refuses the agent's absorption / write-off; the officer may.
  const tool = TOOLS_1_6.find((t) => t.name === "raiseVariance")!; const g = tool.guardrails![0]!; assert.equal(g.code, "ABSORB_NEEDS_OFFICER");
  const ctx = (actor: Actor) => ({ actor } as unknown as CommandContext);
  assert.match(g.refuse({ id: "V-9", data: { batch_id: "B1", field: "buydown_balance", difference_cents: 500_100n, resolution: "absorbed_by_supermortgage" } }, ctx(AGENT))!, /requires an officer/);
  assert.equal(g.refuse({ id: "V-9", data: { batch_id: "B1", field: "buydown_balance", difference_cents: 499_900n, resolution: "absorbed_by_supermortgage" } }, ctx(AGENT)), undefined);
  assert.match(g.refuse({ id: "V-9", data: { batch_id: "B1", loan_id: "L-1", field: "escrow_balance", difference_cents: 1n, resolution: "absorbed_by_supermortgage" } }, ctx(AGENT))!, /requires an officer/);
  assert.match(g.refuse({ id: "V-9", data: { batch_id: "B1", field: "mi_accrual", difference_cents: 100n, resolution: "written_off_officer" } }, ctx(AGENT))!, /officer resolution/);
  assert.equal(g.refuse({ id: "V-9", data: { batch_id: "B1", field: "buydown_balance", difference_cents: 500_100n, resolution: "absorbed_by_supermortgage" } }, ctx(OFFICER)), undefined);
  assert.equal(g.refuse({ id: "V-9", data: { batch_id: "B1", field: "upb", difference_cents: 500_100n, category: "unknown" } }, ctx(AGENT)), undefined, "raising a variance is not absorbing it");
  // Through the bus: the $5,001 batch-level variance is raised, the agent's absorption is refused (only the refusal is written — the stored row's amount decides, not what the caller omits), the officer's is recorded.
  const h = live("2026-10-01T14:00:00.000Z");
  await h.run("raiseVariance", AGENT, { id: "V-9", data: { batch_id: "B1", field: "buydown_balance", difference_cents: "500100", category: "unknown" } });
  assert.equal(h.timers.byCode("SM_RECON_VARIANCE_SLA_5").length, 1);
  const before = h.events.all().length;
  assert.equal(await h.refused("raiseVariance", AGENT, { id: "V-9", data: { resolution: "absorbed_by_supermortgage" } }), "ABSORB_NEEDS_OFFICER");
  assert.deepEqual(h.events.all().slice(before).map((e) => e.type), ["command.refused"]); assert.equal(h.rt.store.get("recon_variances", "V-9")!.data.resolved_at, undefined);
  assert.equal(await h.refused("raiseVariance", AGENT, { id: "V-9", data: { batch_id: "B1", field: "buydown_balance", difference_cents: "500100", resolution: "absorbed_by_supermortgage" } }), "ABSORB_NEEDS_OFFICER");
  // The guardrail's other half: an evidence-backed resolution without the evidence is a plug and is refused; with it the agent may resolve.
  assert.equal(await h.refused("raiseVariance", AGENT, { id: "V-9", data: { resolution: "adjusted_with_evidence" } }), "EVIDENCE_REQUIRED");
  assert.equal(h.events.ofType("recon.variance.resolved").length, 0);
  await h.run("raiseVariance", OFFICER, { id: "V-9", data: { resolution: "absorbed_by_supermortgage" } });
  const resolved = h.events.ofType("recon.variance.resolved"); assert.equal(resolved.length, 1); assert.deepEqual([resolved[0]!.payload.resolution, resolved[0]!.payload.resolved_by], ["absorbed_by_supermortgage", "human:u-officer"]);
  assert.equal(h.timers.byCode("SM_RECON_VARIANCE_SLA_5")[0]!.status, "satisfied"); assert.equal(h.rt.store.get("recon_variances", "V-9")!.data.field, "buydown_balance");
  // Below the threshold the agent absorbs on its own ($4,999 batch-level); an evidence-backed resolution with the evidence is allowed too.
  await h.run("raiseVariance", AGENT, { id: "V-10", data: { batch_id: "B1", field: "buydown_balance", difference_cents: "499900", category: "unknown" } });
  assert.equal(await h.refused("raiseVariance", AGENT, { id: "V-10", data: { resolution: "absorbed_by_supermortgage" } }), "ALLOWED");
  await h.run("raiseVariance", AGENT, { id: "V-11", data: { batch_id: "B1", field: "mi_accrual", difference_cents: "1200", category: "unknown" } });
  assert.equal(await h.refused("raiseVariance", AGENT, { id: "V-11", data: { resolution: "adjusted_with_evidence", evidence_document_id: "doc-bank-advice-7" } }), "ALLOWED");
});
test("1.6-T9: Given an escrowed loan boarded after Dec. 1, 2026, then Escrow Setup events exist per category and are acked before `active`.", () => {
  const evs = escrowSetupEvents({ loan_id: "L-9", escrowed: true, boarded_on: D("2026-12-02"), categories: ["tax", "hazard", "mi"] });
  assert.deepEqual(evs.map((e) => e.category), ["tax", "hazard", "mi"]); assert.ok(evs.every((e) => e.type === "EscrowSetup"));
  assert.deepEqual(activeGate(evs, ["tax", "hazard"]), { ok: false, missing: ["mi"] });
  assert.deepEqual(activeGate(evs, ["tax", "hazard", "mi"]), { ok: true, missing: [] });
  assert.equal(escrowSetupEvents({ loan_id: "L-8", escrowed: true, boarded_on: D("2026-11-02"), categories: ["tax"] }).length, 0);   // before Dec 1, 2026
  // Through the 1.1 service: a loan with tax, hazard and MI escrow lines boards Dec 2, 2026 → `loan.boarded{escrowed}` arms LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1 for the next Fannie Mae business day 03:00 ET (Thu Dec 3).
  const h = live("2026-12-02T14:00:00.000Z", D("2026-12-01"), ["1.6", "1.1"]);
  const { bl, boarded } = h.board(stagedLoan({ seq: 9, escrow_lines: [{ line_type: "county_tax", annual_amount_cents: 320_000n }, { line_type: "hazard", annual_amount_cents: 175_000n }, { line_type: "mi", annual_amount_cents: 96_000n }] }));
  assert.ok(boarded);
  const boardedEv = h.events.ofType("loan.boarded").at(-1)!; assert.equal(boardedEv.payload.escrowed, true); assert.equal(String(boardedEv.payload.boarded_at).slice(0, 10), "2026-12-02");
  const expected = BoardingService.escrowCategoriesOf(bl.staged); assert.deepEqual(expected, ["tax", "hazard", "mi"]);
  const perCategory = escrowSetupEvents({ loan_id: bl.id, escrowed: true, boarded_on: D("2026-12-02"), categories: expected }); assert.equal(perCategory.length, 3);
  const t = h.timers.byCode("LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1").filter((x) => x.loanId === bl.id); assert.equal(t.length, 1);
  assert.equal(t[0]!.dueAt, zonedEpochMs(D("2026-12-03"), "03:00", "America/New_York"));
  // Fannie Mae acks arrive per category; `active` waits for every one — two of three keep the gate closed and the clock armed.
  h.svc.recordEscrowSetupAck(bl.id, "tax"); const two = h.svc.recordEscrowSetupAck(bl.id, "hazard");
  assert.deepEqual(activeGate(perCategory, two.acked), { ok: false, missing: ["mi"] }); assert.equal(two.every_category, false); assert.equal(t[0]!.status, "armed");
  const last = h.svc.recordEscrowSetupAck(bl.id, "mi");
  assert.deepEqual(activeGate(perCategory, last.acked), { ok: true, missing: [] }); assert.equal(last.every_category, true);
  assert.equal(t[0]!.status, "satisfied"); assert.equal(t[0]!.satisfiedByEventId, last.event.id);
});
test("1.6-T10: Given L1's late charge of 4% on P&I $1,616.03, then the boarded receivable is $64.64.", () => {
  assert.equal(lateChargeReceivable(cents("1616.03"), "4"), 6_464n);            // 6,464.12 → round-half-up 6,464
  assert.equal(lateChargeReceivable(cents("1616.03"), "4"), cents("64.64"));
  assert.equal(lateChargeReceivable(cents("1616.03"), "5"), 8_080n);            // 8,080.15 → 8,080
  assert.equal(expectedWires([L1]).late_charges_memo_cents, 6_464n);            // memo receivable, not cash
  // At `loan.boarded` the receivable is a Dr late_charges memo line against transfer_in_clearing (not part of any wire).
  const h = live("2026-10-01T14:00:00.000Z"); const { bl } = h.board(staged(1, L1));
  assert.equal(h.ledger.balance({ scope: "loan", loanId: bl.loan_id!, account: "late_charges" }), cents("64.64"));
  assert.equal(expectedWires([L1]).pi_wire_cents + expectedWires([L1]).ti_wire_cents, 184_250n + 32_500n);
});

test("1.6 inherited unapplied: L1's 32,500 boards as a 6.5 register item (reason_code inherited_unapplied) and SM_UNAPPLIED_INHERITED_REVIEW_60 (T + 60 = Nov 30, 2026) is satisfied when 6.5 closes it", async () => {
  const h = live("2026-10-01T14:00:00.000Z", T, ["1.6", "6.5"]);
  const { bl } = h.board(staged(1, L1));
  assert.equal(h.ledger.balance({ scope: "loan", loanId: bl.loan_id!, account: "suspense_unapplied" }), -32_500n);
  // Trigger `loan.boarded{unapplied_cents>0}` (anchor transfer_date): BoardingService.board (src/domain/boarding/service.ts, 1.1) does not yet carry
  // `unapplied_cents` on its payload, so the clock is armed here from the boarded event with the loan's unapplied balance added — the seed and the closure below are the real code paths.
  const def = h.registry.get("SM_UNAPPLIED_INHERITED_REVIEW_60")!; const boardedEv = h.events.ofType("loan.boarded").at(-1)!;
  assert.equal(eventMatches(def.triggerPattern!, boardedEv), false, "the 1.1 payload does not carry unapplied_cents yet");
  const withUnapplied: DomainEvent = { ...boardedEv, payload: { ...boardedEv.payload, unapplied_cents: 32_500n } };
  assert.equal(eventMatches(def.triggerPattern!, withUnapplied), true); assert.equal(eventMatches(def.triggerPattern!, { ...boardedEv, payload: { ...boardedEv.payload, unapplied_cents: 0n } }), false);
  const t = h.timers.arm(def, withUnapplied); assert.deepEqual([t.dueDate, t.anchorDate, t.loanId, t.status], ["2026-11-30", "2026-10-01", bl.id, "armed"]);
  // The seed: the boarded unapplied balance becomes the 6.5 register item, triaged and aged by 6.5's own clocks; a second seed is a no-op.
  const seed = await h.run("postOpeningEntries", AGENT, { op: "seed_inherited_unapplied", loan_id: bl.id, batch_id: "B1", transfer_date: "2026-10-01", unapplied_cents: "32500" });
  assert.deepEqual([seed.id, seed.reason_code, seed.source, seed.status, seed.review_due, seed.amount_cents, seed.duplicate], [inheritedUnappliedId(bl.id), "inherited_unapplied", "transfer_in", "open", "2026-11-30", "32500", false]);
  const created = h.events.ofType("suspense.item.created"); assert.equal(created.length, 1); assert.equal(created[0]!.loanId, bl.id); assert.equal(created[0]!.payload.reason_code, "inherited_unapplied");
  assert.equal(h.timers.byCode("SM_SUSPENSE_TRIAGE_1BD").length, 1);
  assert.equal((await h.run("postOpeningEntries", AGENT, { op: "seed_inherited_unapplied", loan_id: bl.id, batch_id: "B1", transfer_date: "2026-10-01", unapplied_cents: "32500" })).duplicate, true); assert.equal(h.events.ofType("suspense.item.created").length, 1);
  assert.equal(t.status, "armed");
  // 6.5 resolves it through its own register (the accumulated balance applied via cashiering): `suspense.item.closed` on the loan is the resolution the review clock waits for.
  await h.run("ledger.apply_via_cashiering", AGENT, { loan_id: bl.id, amount_cents: "32500", suspense_item_id: inheritedUnappliedId(bl.id), credited_as_of: "2026-10-05", confidence: 1 }, "2026-10-05T14:00:00.000Z", "6.5");
  const closed = h.events.ofType("suspense.item.closed").at(-1)!; assert.equal(closed.loanId, bl.id); assert.deepEqual([closed.payload.id, closed.payload.status], [inheritedUnappliedId(bl.id), "applied"]);
  assert.ok(eventMatches(def.satisfiedPattern!, closed)); assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, closed.id);
  assert.equal(h.rt.store.get("suspense_items", inheritedUnappliedId(bl.id))!.data.status, "applied");
});
