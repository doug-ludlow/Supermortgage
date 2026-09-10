// 17.3 Data/document transfer
// spec/sections/17-servicing-transfer-out/17-3-data-document-transfer.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM } from "../../kernel/events/index.ts";
import { loadRegistry, TimerEngine } from "../../kernel/timers/index.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { applyTransferTimerOverrides } from "./timers.ts";
import { EVALUATORS_17_3 } from "./evaluators-17-3.ts";
import { SUPERMORTGAGE_ORG_ID } from "./inbound.ts";
import { outboundSchedule } from "./reconciliation.ts";
import { planDeliverables, outboundDqGate, attestationGate, balanceEditRequest, postTransferReceipt, forwardingFile, piAdvancesReceivable, miTransferNotices, finalPeriodClose, finalAccountingWatch, advanceReimbursementWatch, enoteServicingAgentHandoff, enoteHandoffEvidence, minUpdateFile, verifyMersSnapshot, outboundMersAckRows, transfereeRequest, transfereeRequestBacklog, postTransferNoe, form2009Handoff, retentionPlan, deidentify, prelimQc, cbamLoaCancellation, planCounterpartyNotifications, counterpartyStatus, miNoticeCheck, finalCycleNoticeCheck, custodialAccountDisposition, custodialAdjustmentWindow, ledgerAtFreeze, supportWindow, archiveManifestStatus, buildDebrief, ackConditions, finalTapeSetAcked, deliveryAllowed, cutoverFreeze, matchWires, shortageSurplusResolution, participationNotesHandoff } from "./ops-17-3.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_17_3 } from "../../app/tools/section17-3.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";

const ET = "America/New_York";
const T = D("2026-12-01");
const BATCH = { kind: "batch", id: "B-out-2026-12" };
/** A registry with the §1/§17 overrides applied and an engine arming only the named processes. */
function engine(processes: readonly string[], nowIso = "2026-10-30T14:00:00.000Z"): { events: MemoryEventStore; timers: TimerEngine } {
  const events = new MemoryEventStore(new FixedClock(nowIso)); const registry = loadRegistry(); applyTransferTimerOverrides(registry);
  return { events, timers: new TimerEngine(registry, events, { processes }) };
}
const AGENT: Actor = { kind: "agent", id: "transfer" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const SIGNER: Actor = { kind: "human", id: "u-signer", role: "signing_officer" };
/** The 17.3 tools on the command bus over a fresh store, ledger and timer engine (the shared 1.4/1.5/1.6 codes keep their owner's process id, so those are armed too — production arms every process). */
function bus(nowIso: string, processes: readonly string[] = ["17.3", "1.4", "1.5", "1.6"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const registry = loadRegistry(); applyTransferTimerOverrides(registry);
  const timers = new TimerEngine(registry, events, { processes });
  const ctx = { loanId: "L1", events, ledger: new MemoryLedger(), timers, clock, decide: () => {} } as unknown as UowContext;
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_17_3); const b = new CommandBus(agents);
  const run = async (name: string, actor: Actor, input: Record<string, unknown>, now?: string): Promise<Record<string, unknown>> => { if (now) clock.set(now); return (await b.execute(cmds.get(toolKey("17.3", name))!, actor, input, ctx)).output as Record<string, unknown>; };
  const refused = async (name: string, actor: Actor, input: Record<string, unknown>): Promise<string> => { try { await run(name, actor, input); } catch (e) { if (e instanceof CommandRefused) return e.code; throw e; } return "ALLOWED"; };
  const status = (code: string): string[] => timers.byCode(code).map((t) => t.status);
  const types = (): string[] => events.all().map((e) => e.type);
  /** generate → validate + officer attestation → deliver: the ladder a deliverable climbs before it can be acknowledged. */
  const deliver = async (kind: string, asOf: string, now?: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await run("generateDeliverable", AGENT, { batch_id: BATCH.id, kind, as_of: asOf, document_id: `doc-${kind}`, ...extra }, now);
    await run("runOutboundDqGate", OFFICER, { batch_id: BATCH.id, deliverable_kind: kind, attest: true, as_of: asOf, scorecard_document_id: "doc-scorecard", loans: [{ loan_id: "L1", tape_upb_cents: "24563412", trial_balance_upb_cents: "24563412", ledger_principal_cents: "24563412" }] }, now);
    await run("sendDeliverable", kind === "D31" ? OFFICER : AGENT, { batch_id: BATCH.id, kind, channel: kind === "D27" ? "restricted" : "sftp" }, now);
  };
  return { ctx, rt, run, refused, status, types, deliver, events, timers };
}

test("17.3-T1: Given T = Dec 1, 2026, then deliverable due dates are: test Nov 1, preliminary Nov 17, counterparties Nov 30, final/trial balance/wires Dec 2, images Dec 8, custodial recons Dec 8, final period close Dec 2 17:00 ET, adjustment request and final accounting Dec 31, MGIC notice Jan 30, 2027, support window end Mar 1, 2027, NoE/RFI tail Dec 1, 2027.", () => {
  const s = outboundSchedule(T);
  assert.deepEqual([s.test_tape_by, s.preliminary_by, s.counterparties_by, s.final_tape_by, s.wires_by, s.images_by, s.custodial_recons_by, s.final_period_close, s.final_accounting_by, s.mi_notice_by, s.support_window_end, s.noe_rfi_tail_end],
    ["2026-11-01", "2026-11-17", "2026-11-30", "2026-12-02", "2026-12-02", "2026-12-08", "2026-12-08", "2026-12-02 17:00 ET", "2026-12-31", "2027-01-30", "2027-03-01", "2027-12-01"]);
  assert.equal(toIso(finalPeriodClose({ transfer_date: T, processed_at_ms: zonedEpochMs(D("2026-11-30"), "16:00", ET), open_hard_rejects: 0, now_ms: 0 }).period_close_ms), toIso(zonedEpochMs(D("2026-12-02"), "17:00", ET)));
  assert.equal(postTransferNoe({ transfer_date: T, received_on: D("2027-12-01"), assertion_type: "b3" }).tail_end, "2027-12-01");
  // the same dates on the registry rows: approval arms the pre-T clocks, the freeze the T+1/T+5 clocks, the cutover the post-T clocks
  const { events, timers } = engine(["17.3", "1.4", "1.6"]);
  events.append({ type: "transfer.batch.approved", aggregate: BATCH, actor: SYSTEM, payload: { direction: "out", transfer_date: "2026-12-01" } });
  const due = (code: string): string | undefined => timers.byCode(code)[0]?.dueDate;
  assert.deepEqual([due("SM_XFER_OUT_TEST_TAPE_30"), due("SM_XFER_OUT_PRELIM_TAPE_14"), due("SM_XFER_OUT_COUNTERPARTIES_T1"), due("SM_XFER_OUT_MI_NOTICE_T1"), due("SM_XFER_OUT_CUTOVER_FREEZE_T1"), due("FNMA_A2_7_03_TRANSFEROR_CUSTODIAN_NOTICE_30")], ["2026-11-01", "2026-11-17", "2026-11-30", "2026-11-30", "2026-11-30", "2026-12-31"]);
  events.append({ type: "transfer.cutover.frozen", aggregate: BATCH, actor: SYSTEM, payload: { transfer_date: "2026-12-01" }, occurredAt: "2026-12-01T03:00:00.000Z" });
  assert.deepEqual([due("FNMA_F1_11_TRIAL_BALANCE_T1"), due("SM_XFER_OUT_FINAL_TAPE_1"), due("SM_XFER_OUT_FUNDS_WIRE_1"), due("SM_XFER_OUT_IMAGES_5")], ["2026-12-02", "2026-12-02", "2026-12-02", "2026-12-08"]);   // Dec 2, 3, 4, 7, 8
  events.append({ type: "transfer.batch.cutover_completed", aggregate: BATCH, actor: SYSTEM, payload: { direction: "out", transfer_date: "2026-12-01" }, occurredAt: "2026-12-01T15:00:00.000Z" });
  // the cutover event 17.1 emits carries no insurer list: planDeliverables{op=cutover} emits one `transfer.mi_transfer_notice.pending{mi}` per MI insurer of the loan list (ops miTransferNotices) and the MGIC one arms the 60-day row on the same transfer_date anchor
  const mgic = miTransferNotices(T, ["MGIC", "Radian"]); assert.deepEqual(mgic.map((n) => [n.mi, n.timer, n.due, n.send_by]), [["MGIC", "MI_MGIC_TRANSFER_NOTICE_60", "2027-01-30", "2026-11-30"], ["Radian", "SM_XFER_OUT_MI_NOTICE_T1", "2027-01-30", "2026-11-30"]]);
  for (const n of mgic) events.append({ type: n.event.type, aggregate: BATCH, actor: SYSTEM, payload: { mi: n.event.mi, transfer_date: n.event.transfer_date }, occurredAt: "2026-12-01T15:00:00.000Z" });
  assert.equal(timers.byCode("MI_MGIC_TRANSFER_NOTICE_60").length, 1);   // Radian's pending notice does not arm MGIC's row
  assert.deepEqual([due("FNMA_F1_11_CUSTODIAL_RECON_5BD"), due("FNMA_F1_11_SHORTAGE_SURPLUS_ADJ_30"), due("FNMA_F1_11_FINAL_ACCOUNTING_30"), due("MI_MGIC_TRANSFER_NOTICE_60"), due("SM_XFER_OUT_DEBRIEF_30")], ["2026-12-08", "2026-12-31", "2026-12-31", "2027-01-30", "2026-12-31"]);
  assert.equal(supportWindow({ transfer_date: T, today: D("2026-12-01") }).window_end, "2027-03-01");   // support window end Mon Mar 1, 2027 (T + 90 calendar days)
  assert.equal(timers.byCode("SM_XFER_OUT_SUPPORT_WINDOW_90")[0]!.note, "evaluator:17.3.supportWindowOpen");   // the window is a gate: open through Mar 1, 2027, closed after
  assert.equal(EVALUATORS_17_3["17.3.supportWindowOpen"]!({ today: "2027-03-01", transfer_date: "2026-12-01" }).open, true); assert.match(EVALUATORS_17_3["17.3.supportWindowOpen"]!({ today: "2027-03-02", transfer_date: "2026-12-01" }).reason!, /closed 2027-03-01/);
  assert.equal(timers.byCode("REGX_1024_35G_NOE_TAIL_1Y")[0]!.note, "evaluator:17.3.noeRfiWithinPostTransferTail");   // the one-year tail is a gate the evaluator asserts per notice (T10)
  assert.equal(toIso(timers.byCode("SM_XFER_OUT_CREDIT_FINAL_CYCLE")[0]!.dueAt!), toIso(zonedEpochMs(D("2027-01-01"), "00:05", ET)));   // the next Metro 2 cycle after T (8.1 snapshot cadence)
});
test("17.3-T2: Given the three-loan example, then the T&I wire is 276,572 cents (L1 escrow interest 307), the P&I forwardable wire 238,300, and the final accounting shows 541,109 receivable from the transferee.", () => {
  const L1 = { upb_cents: 24_563_412n, escrow_cents: 184_250n, unapplied_cents: 32_500n, corporate_advances_cents: 15_000n, late_charges_cents: 6_464n, escrow_interest_rate_pct: "2" };
  // L2: S/S loan three installments delinquent — the scheduled P&I advanced to Fannie Mae under Stop Delinquency Advance rules is months × scheduled P&I (3 × 161,603 = 484,809), computed, not given
  const adv = piAdvancesReceivable({ scheduled_pi_cents: 161_603n, installments_delinquent: 3 });
  assert.deepEqual(adv, { months_advanced: 3, receivable_cents: 484_809n, advances_stopped: false });
  assert.deepEqual(piAdvancesReceivable({ scheduled_pi_cents: 161_603n, installments_delinquent: 6 }), { months_advanced: 4, receivable_cents: 646_412n, advances_stopped: true });   // advances stop after the fourth month (15.4)
  assert.throws(() => piAdvancesReceivable({ scheduled_pi_cents: 161_603n, installments_delinquent: -1 }), RangeError);
  const L2 = { upb_cents: 18_020_000n, escrow_cents: -41_300n, unapplied_cents: 0n, corporate_advances_cents: 0n, late_charges_cents: 0n, pi_advances_cents: adv.receivable_cents };
  const L3 = { upb_cents: 31_100_055n, escrow_cents: 92_015n, unapplied_cents: 0n, corporate_advances_cents: 0n, late_charges_cents: 0n, prepaid_next_period_pi_cents: 205_800n };
  const w = ledgerAtFreeze([L1, L2, L3]);
  assert.equal(w.wires.ti_wire_cents, 276_572n); assert.equal(w.wires.ti_wire_cents - (L1.escrow_cents + L3.escrow_cents), 307n);   // round_half_up(184,250 × 0.02 / 12) = 307.08 → 307
  assert.equal(w.wires.pi_wire_cents, 238_300n); assert.equal(w.wires.final_accounting_receivable_cents, 541_109n); assert.equal(w.wires.pi_advances_receivable_cents, 484_809n);
  const m = matchWires({ loans: [L1, L2, L3], confirmations: [{ kind: "ti", amount_cents: 276_572n, reference: "W-TI" }, { kind: "pi", amount_cents: 238_300n, reference: "W-PI" }] });
  assert.equal(m.matched, true); assert.equal(m.event, "recon.transfer_out_wires.matched"); assert.deepEqual(m.variances, []);
  const short = matchWires({ loans: [L1, L2, L3], confirmations: [{ kind: "ti", amount_cents: 276_572n, reference: "W-TI" }, { kind: "pi", amount_cents: 238_000n, reference: "W-PI" }] });
  assert.equal(short.matched, false); assert.deepEqual(short.variances, [{ kind: "pi", expected_cents: 238_300n, received_cents: 238_000n, variance_cents: -300n }]); assert.equal(short.escalation!.kind, "officer");
});
test("17.3-T3: Given a tape UPB ≠ ledger `principal` for one loan, then the outbound DQ gate fails, attestation is blocked, and no balance is edited by the agent.", async () => {
  const loans = [
    { loan_id: "L1", tape_upb_cents: 24_563_412n, trial_balance_upb_cents: 24_563_412n, ledger_principal_cents: 24_563_412n },
    { loan_id: "L2", tape_upb_cents: 18_020_000n, trial_balance_upb_cents: 18_020_000n, ledger_principal_cents: 18_019_000n },   // tape UPB ≠ ledger principal by 1,000 cents
    { loan_id: "L3", tape_upb_cents: 31_100_055n, trial_balance_upb_cents: 31_100_055n, ledger_principal_cents: 31_100_055n },
  ];
  const dq = outboundDqGate({ loans });
  assert.equal(dq.passed, false); assert.equal(dq.attestation_blocked, true);
  assert.deepEqual(dq.hard_failures.map((f) => [f.loan_id, f.rule, f.variance_cents, f.balance_edit_allowed]), [["L2", "TIE_OUT_UPB_TAPE_LEDGER", -1_000n, false]]);
  assert.deepEqual(dq.balance_edits, []); assert.equal(dq.totals.tape_upb_cents - dq.totals.ledger_principal_cents, 1_000n); assert.match(dq.refusal!, /no balance may be altered/);
  const officer = { kind: "human" as const, id: "u-officer", role: "officer" };
  const blocked = attestationGate({ dq, as_of: D("2026-11-30"), attested_by: officer, scorecard_document_id: "doc-scorecard" });
  assert.equal(blocked.allowed, false); assert.match(blocked.refusal!, /attestation blocked/); assert.equal(blocked.statement, null);
  const edit = balanceEditRequest({ field: "L2.ledger_principal_cents", from_cents: 18_019_000n, to_cents: 18_020_000n, reason: "make the UPB tie-out pass" });
  assert.equal(edit.refused, true); assert.equal(edit.alternative, "escalate_officer"); assert.equal(edit.escalation!.kind, "officer");
  assert.equal(balanceEditRequest({ field: "L2.ledger_principal_cents", from_cents: 18_019_000n, to_cents: 18_020_000n, reason: "curtailment posted to the wrong loan", evidence_document_id: "doc-ev" }).alternative, "categorize_and_resolve_with_evidence");
  const clean = outboundDqGate({ loans: loans.map((l) => ({ ...l, ledger_principal_cents: l.tape_upb_cents, fnma_position_upb_cents: l.tape_upb_cents })) });
  assert.equal(clean.passed, true); assert.equal(clean.totals.fnma_position_upb_cents, 73_683_467n);
  assert.equal(attestationGate({ dq: clean, as_of: D("2026-11-30"), attested_by: { kind: "agent", id: "transfer" }, scorecard_document_id: "doc-scorecard" }).allowed, false);
  const att = attestationGate({ dq: clean, as_of: D("2026-11-30"), attested_by: officer, scorecard_document_id: "doc-scorecard" });
  assert.equal(att.allowed, true); assert.equal(att.statement!.as_of, "2026-11-30"); assert.equal(att.statement!.rule_set_version, clean.rule_set_version); assert.equal(att.statement!.tie_outs.tape_upb_cents, 73_683_467n);
  // on the bus: the gate fails (no attestation), and any attempt to adjust a balance to make the tie-out pass is refused before the handler runs — the difference stays a categorized variance
  const b = bus("2026-11-30T21:00:00.000Z");
  const gate = await b.run("runOutboundDqGate", AGENT, { batch_id: BATCH.id, loans }) as { passed: boolean; attestation_blocked: boolean; hard_failures: unknown[] };
  assert.equal(gate.passed, false); assert.equal(gate.attestation_blocked, true); assert.equal(gate.hard_failures.length, 1); assert.ok(b.types().includes("transfer.dq_gate.failed"));
  assert.equal(await b.refused("runOutboundDqGate", AGENT, { batch_id: BATCH.id, loans, adjust_balances: true }), "NO_BALANCE_EDIT");
  assert.equal(await b.refused("runOutboundDqGate", OFFICER, { batch_id: BATCH.id, loans, balance_overrides: { "L2.ledger_principal_cents": "18020000" } }), "NO_BALANCE_EDIT");   // not even the officer
  assert.equal(await b.refused("generateDeliverable", AGENT, { batch_id: BATCH.id, kind: "D04", as_of: "2026-11-30", changes: { upb_cents: "1" } }), "NO_BALANCE_EDIT");
  assert.equal(await b.refused("runOutboundDqGate", AGENT, { batch_id: BATCH.id, loans, attest: true, as_of: "2026-11-30", scorecard_document_id: "doc-scorecard" }), "OFFICER_ATTESTATION");   // attestation is an officer act
  assert.ok(!b.types().includes("transfer.deliverable.attested"));
});
test("17.3-T4: Given a payment received Dec 1 by lockbox for a listed loan, then no `payment.received` or investor event is created; a `misdirected_payments{direction=out}` row exists and is in the Dec 2 forwarding file.", async () => {
  const r = postTransferReceipt({ loan_id: "L1", received_on: D("2026-12-01"), transfer_date: T, listed: true, channel: "lockbox", amount_cents: 219_257n });
  assert.equal(r.payment_received_event, null); assert.equal(r.investor_event, null);
  assert.deepEqual(r.misdirected_payment, { direction: "out", loan_id: "L1", received_on: "2026-12-01", amount_cents: 219_257n, channel: "lockbox", status: "pending_forward" });
  assert.equal(r.forwarding_file_date, "2026-12-02"); assert.equal(r.gate, "SM_XFER_OUT_POST_T_EVENT_GATE"); assert.match(r.refusal!, /payment.received refused/);
  const file = forwardingFile(D("2026-12-02"), [{ loan_id: "L1", received_on: D("2026-12-01"), amount_cents: 219_257n }, { loan_id: "L9", received_on: D("2026-12-02"), amount_cents: 100_000n }]);
  assert.deepEqual(file.rows, [{ loan_id: "L1", received_on: "2026-12-01", amount_cents: 219_257n }]); assert.equal(file.kind, "D32"); assert.equal(file.total_cents, 219_257n);
  const gate = evaluateGate("17.3.noInvestorEventsOnOrAfterTransferDate", { activity_date: "2026-12-01", transfer_date: "2026-12-01" }); assert.equal(gate.open, false);
  assert.equal(evaluateGate("17.3.noInvestorEventsOnOrAfterTransferDate", { activity_date: "2026-11-30", transfer_date: "2026-12-01" }).open, true);
  const before = postTransferReceipt({ loan_id: "L1", received_on: D("2026-11-30"), transfer_date: T, listed: true, channel: "lockbox", amount_cents: 219_257n });
  assert.equal(before.payment_received_event, "payment.received"); assert.equal(before.misdirected_payment, null);
  assert.equal(postTransferReceipt({ loan_id: "L-other", received_on: D("2026-12-01"), transfer_date: T, listed: false, channel: "lockbox", amount_cents: 1n }).payment_received_event, "payment.received");
  // on the bus: the freeze lists the loans (payment_holds{transfer_out_cutover}); the Dec 1 lockbox receipt on a listed loan is refused as payment.received (SM_XFER_OUT_POST_T_EVENT_GATE) and recorded as a
  // misdirected_payments{direction=out} row (0019 DDL columns); the Dec 2 forwarding file (D32) carries it and marks it forwarded
  const b = bus("2026-11-30T22:00:00.000Z");
  await b.run("runOutboundDqGate", AGENT, { op: "freeze", batch_id: BATCH.id, transfer_date: "2026-12-01", frozen_on: "2026-11-30", loans: ["L1", "L2", "L3"] });
  const rec = await b.run("runOutboundDqGate", AGENT, { op: "receipt", batch_id: BATCH.id, loan_id: "L1", payment_id: "P-1201", received_on: "2026-12-01", transfer_date: "2026-12-01", channel: "lockbox", amount_cents: "219257" }, "2026-12-01T15:00:00.000Z") as { payment_received_event: string | null; investor_event: null; refusal: string; forwarding_file_date: string };
  assert.equal(rec.payment_received_event, null); assert.equal(rec.investor_event, null); assert.match(rec.refusal, /payment.received refused/); assert.equal(rec.forwarding_file_date, "2026-12-02");
  const row = b.rt.store.get("misdirected_payments", "P-1201")!.data;
  assert.deepEqual([row.loan_id, row.direction, row.received_by, row.received_at, row.amount_cents, row.instrument, row.forwarded_at, row.forward_reference, row.payment_id], ["L1", "out", "supermortgage", "2026-12-01", 219_257n, "check", null, null, "P-1201"]);
  assert.ok(b.types().includes("transfer.misdirected_payment.recorded")); assert.ok(!b.types().includes("payment.received")); assert.ok(!b.types().some((t) => t.startsWith("investor_event")));
  const other = await b.run("runOutboundDqGate", AGENT, { op: "receipt", batch_id: BATCH.id, loan_id: "L-other", payment_id: "P-other", received_on: "2026-12-01", transfer_date: "2026-12-01", channel: "lockbox", amount_cents: "1" }) as { payment_received_event: string | null };
  assert.equal(other.payment_received_event, "payment.received"); assert.equal(b.rt.store.get("misdirected_payments", "P-other"), undefined);   // not a listed loan: posts normally
  const fwd = await b.run("generateDeliverable", AGENT, { batch_id: BATCH.id, kind: "D32", as_of: "2026-12-02" }, "2026-12-02T12:00:00.000Z") as { rows: { loan_id: string; received_on: string; amount_cents: bigint }[]; total_cents: bigint; row_count: number; file_id: string; status: string };
  assert.deepEqual(fwd.rows, [{ loan_id: "L1", received_on: "2026-12-01", amount_cents: 219_257n }]); assert.equal(fwd.total_cents, 219_257n); assert.equal(fwd.row_count, 1); assert.equal(fwd.status, "generated");
  const forwarded = b.rt.store.get("misdirected_payments", "P-1201")!.data; assert.equal(forwarded.forward_reference, fwd.file_id); assert.equal(forwarded.disposition, "forwarded"); assert.ok(forwarded.forwarded_at);
  assert.deepEqual(forwardingFile(D("2026-12-03"), [{ loan_id: "L1", received_on: D("2026-12-01"), amount_cents: 219_257n, forwarded_on: D("2026-12-02") }]).rows, []);   // already forwarded: the Dec 3 file carries nothing
});
test("17.3-T5: Given events processed Nov 30 at 16:00 ET, then they are due 3:00 a.m. ET Dec 1 (event mode) and the November period closes Dec 2 17:00 ET with zero open hard rejects; an open reject at 16:00 ET Dec 2 escalates to `officer`.", () => {
  const processed = zonedEpochMs(D("2026-11-30"), "16:00", ET);
  const r = finalPeriodClose({ transfer_date: T, processed_at_ms: processed, open_hard_rejects: 0, now_ms: processed });
  assert.deepEqual(r.event_due_et, { date: "2026-12-01", hour: 3, minute: 0 }); assert.equal(toIso(r.event_due_ms), toIso(zonedEpochMs(D("2026-12-01"), "03:00", ET)));
  assert.equal(r.period_close_date, "2026-12-02"); assert.equal(toIso(r.period_close_ms), toIso(zonedEpochMs(D("2026-12-02"), "17:00", ET)));
  assert.equal(r.close_permitted, true); assert.equal(r.escalation, null);
  const late = finalPeriodClose({ transfer_date: T, processed_at_ms: processed, open_hard_rejects: 1, now_ms: zonedEpochMs(D("2026-12-02"), "16:00", ET) });
  assert.equal(late.close_permitted, false); assert.equal(late.escalation!.kind, "officer"); assert.equal(late.escalation!.severity, "sev1"); assert.match(late.escalation!.reason, /2026-12-02 16:00 ET/); assert.match(late.escalation!.reason, /FNMA_IRM_PERIOD_CLOSE_BD2_1700/);
  assert.equal(finalPeriodClose({ transfer_date: T, processed_at_ms: processed, open_hard_rejects: 1, now_ms: zonedEpochMs(D("2026-12-01"), "16:00", ET) }).escalation, null);   // BD1: still workable
  assert.equal(outboundSchedule(T).final_period_close, "2026-12-02 17:00 ET");
});
test("17.3-T6: Given the final accounting is not acked by Dec 31, 2026, then `FNMA_F1_11_FINAL_ACCOUNTING_30` breaches and an `officer` escalation exists; given the transferee has not reimbursed 541,109 cents 30 days after ack, then a demand letter draft exists.", async () => {
  const { events, timers } = engine(["1.6", "17.3"], "2026-12-01T14:00:00.000Z");
  events.append({ type: "transfer.batch.cutover_completed", aggregate: BATCH, actor: SYSTEM, payload: { transfer_date: "2026-12-01", direction: "out" } });
  const fa = timers.byCode("FNMA_F1_11_FINAL_ACCOUNTING_30"); assert.equal(fa.length, 1); assert.equal(fa[0]!.dueDate, "2026-12-31");
  const b = timers.evaluate("2027-01-01T05:00:00.000Z").find((x) => x.def.code === "FNMA_F1_11_FINAL_ACCOUNTING_30")!;
  assert.equal(fa[0]!.status, "breached"); assert.equal(b.severity, 1); assert.deepEqual([...b.escalateTo], ["officer"]);
  const w = finalAccountingWatch({ transfer_date: T, acked_on: null, today: D("2027-01-01") }); assert.equal(w.due, "2026-12-31"); assert.equal(w.breached, true); assert.equal(w.escalation!.kind, "officer"); assert.equal(w.escalation!.severity, "sev1");
  assert.equal(finalAccountingWatch({ transfer_date: T, acked_on: D("2026-12-31"), today: D("2027-01-01") }).breached, false);
  // the D31 ack starts the 30-day reimbursement clock; unpaid past it the partner gets a demand-letter draft for 541,109
  events.append({ type: "deliverable.acked", aggregate: BATCH, actor: SYSTEM, payload: { D31: true, kind: "D31", ack_reference: "ACK-D31" }, occurredAt: "2026-12-31T15:00:00.000Z" });
  const ar = timers.byCode("SM_ADVANCE_REIMBURSEMENT_RECEIVABLE_30"); assert.equal(ar.length, 1); assert.equal(ar[0]!.dueDate, "2027-01-30");
  const b2 = timers.evaluate("2027-01-31T05:00:00.000Z").find((x) => x.def.code === "SM_ADVANCE_REIMBURSEMENT_RECEIVABLE_30")!; assert.equal(b2.severity, 2); assert.match(b2.breachText, /demand letter/);
  const rw = advanceReimbursementWatch({ acked_on: D("2026-12-31"), receivable_cents: 541_109n, reimbursed_on: null, today: D("2027-01-31") });
  assert.equal(rw.due, "2027-01-30"); assert.equal(rw.breached, true); assert.deepEqual(rw.demand_letter_draft, { to: "transferee", via: "partner", amount_cents: 541_109n, receivable_account: "due_from_transferee", basis: "F-1-11 advances reimbursement due 2027-01-30 (30 days after the final accounting ack 2026-12-31)", status: "draft" });
  assert.equal(advanceReimbursementWatch({ acked_on: D("2026-12-31"), receivable_cents: 541_109n, reimbursed_on: D("2027-01-20"), today: D("2027-01-31") }).demand_letter_draft, null);
  events.append({ type: "ledger.posted", aggregate: BATCH, actor: SYSTEM, payload: { advance_reimbursement_in: true, amount_cents: "541109" } }); assert.equal(ar[0]!.status, "satisfied_late");
  // on the bus: the (1.6; now owned) row is satisfied by the transferee's D31 ack — the final accounting climbs the ladder (officer-signed), is delivered, then acknowledged; the settlement posting satisfies the reimbursement clock
  const bb = bus("2026-12-01T15:00:00.000Z");
  bb.events.append({ type: "transfer.batch.cutover_completed", aggregate: BATCH, actor: SYSTEM, payload: { direction: "out", transfer_date: "2026-12-01" } });
  await bb.run("planDeliverables", AGENT, { batch_id: BATCH.id, transfer_date: "2026-12-01" });
  await assert.rejects(bb.run("sendDeliverable", OFFICER, { batch_id: BATCH.id, kind: "D31", channel: "sftp" }), /only an attested deliverable can be delivered/);   // never generated: the ladder refuses the delivery
  assert.equal(await bb.refused("sendDeliverable", AGENT, { batch_id: BATCH.id, kind: "D31", channel: "sftp" }), "OFFICER_ATTESTATION");   // the final accounting is signed by the officer
  await bb.deliver("D31", "2026-12-01", "2026-12-20T15:00:00.000Z"); assert.ok(bb.types().includes("transfer.final_accounting.delivered")); assert.deepEqual(bb.status("FNMA_F1_11_FINAL_ACCOUNTING_30"), ["armed"]);
  const ack = await bb.run("ingestTransfereeAck", AGENT, { batch_id: BATCH.id, kind: "D31", ack_reference: "ACK-D31" }, "2026-12-31T15:00:00.000Z") as { status: string };
  assert.equal(ack.status, "acked"); assert.deepEqual(bb.status("FNMA_F1_11_FINAL_ACCOUNTING_30"), ["satisfied"]); assert.ok(bb.types().includes("transfer.final_accounting.acked"));
  assert.deepEqual(bb.timers.byCode("SM_ADVANCE_REIMBURSEMENT_RECEIVABLE_30").map((t) => [t.dueDate, t.status]), [["2027-01-30", "armed"]]); assert.deepEqual(bb.timers.byCode("SM_XFER_OUT_ARCHIVE_MANIFEST_10").map((t) => t.dueDate), ["2027-01-15"]);
  const settle = await bb.run("runOutboundDqGate", AGENT, { op: "settlement", batch_id: BATCH.id, amount_cents: "541109", received_on: "2027-01-20" }, "2027-01-20T15:00:00.000Z") as { amount_cents: bigint; receivable_account: string };
  assert.equal(settle.amount_cents, 541_109n); assert.equal(settle.receivable_account, "due_from_transferee"); assert.deepEqual(bb.status("SM_ADVANCE_REIMBURSEMENT_RECEIVABLE_30"), ["satisfied"]); assert.ok(bb.types().includes("transfer.advances.reimbursed"));
});
test("17.3-T7: Given an eNote with Servicing Agent still Supermortgage on Nov 30, then `FNMA_F1_11_ENOTE_SERVICING_AGENT_T0` breaches at sev 1 and the partner is escalated.", async () => {
  const r = enoteServicingAgentHandoff({ transfer_date: T, servicing_agent_org_id: SUPERMORTGAGE_ORG_ID, transferee_org_id: "1004567", checked_on: D("2026-11-30") });
  assert.equal(r.due, "2026-11-30"); assert.equal(r.warn_from, "2026-11-23"); assert.equal(r.updated, false); assert.equal(r.breached, true); assert.equal(r.severity, "sev1"); assert.equal(r.timer, "FNMA_F1_11_ENOTE_SERVICING_AGENT_T0");
  assert.equal(r.escalation!.to, "partner"); assert.equal(r.escalation!.kind, "officer"); assert.equal(r.escalation!.severity, "sev1"); assert.match(r.escalation!.reason, /still Supermortgage/);
  assert.equal(r.unauthorized_past_transfer, false); assert.equal(enoteServicingAgentHandoff({ transfer_date: T, servicing_agent_org_id: SUPERMORTGAGE_ORG_ID, transferee_org_id: "1004567", checked_on: D("2026-12-01") }).unauthorized_past_transfer, true);
  const warn = enoteServicingAgentHandoff({ transfer_date: T, servicing_agent_org_id: SUPERMORTGAGE_ORG_ID, transferee_org_id: "1004567", checked_on: D("2026-11-24") }); assert.equal(warn.breached, false); assert.equal(warn.escalation!.severity, "sev2");
  assert.equal(enoteServicingAgentHandoff({ transfer_date: T, servicing_agent_org_id: "1004567", transferee_org_id: "1004567", checked_on: D("2026-11-30") }).escalation, null);
  assert.deepEqual(enoteHandoffEvidence({ updated: true, edelivery_copies_acked: true, audit_trails_acked: false }), { complete: false, missing: ["audit_trails"] });
  // the registry row (1.4; now owned — one definition per code, kept under 1.4's process id): due T−1 servicer BD (Nov 30), breaches at sev 1 once Nov 30 passes without the update; the tool's update event satisfies it late
  const b = bus("2026-11-02T14:00:00.000Z");
  b.events.append({ type: "transfer.batch.approved", loanId: "L-enote", actor: SYSTEM, payload: { direction: "out", emortgage_count: 1, transfer_date: "2026-12-01" } });
  const t = b.timers.byCode("FNMA_F1_11_ENOTE_SERVICING_AGENT_T0"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-11-30");
  const still = await b.run("verifyERegistry", AGENT, { loan_id: "L-enote", transfer_date: "2026-12-01", servicing_agent_org_id: SUPERMORTGAGE_ORG_ID, transferee_org_id: "1004567", checked_on: "2026-11-30" }) as { breached: boolean; escalation: { to: string; severity: string } };
  assert.equal(still.breached, true); assert.equal(still.escalation.to, "partner"); assert.equal(still.escalation.severity, "sev1"); assert.ok(!b.types().includes("enote.eregistry.updated")); assert.ok(b.types().includes("escalation.created"));
  const breach = b.timers.evaluate("2026-12-01T05:00:00.000Z").find((x) => x.def.code === "FNMA_F1_11_ENOTE_SERVICING_AGENT_T0")!; assert.equal(breach.severity, 1); assert.equal(t[0]!.status, "breached");
  await b.run("verifyERegistry", AGENT, { loan_id: "L-enote", transfer_date: "2026-12-01", servicing_agent_org_id: "1004567", transferee_org_id: "1004567", checked_on: "2026-12-01" });   // updated, but the eDelivery copies and audit trails are not acked yet
  assert.equal(t[0]!.status, "breached");
  await b.run("verifyERegistry", AGENT, { loan_id: "L-enote", transfer_date: "2026-12-01", servicing_agent_org_id: "1004567", transferee_org_id: "1004567", checked_on: "2026-12-01", edelivery_copies_acked: true, audit_trails_acked: true });
  assert.equal(t[0]!.status, "satisfied_late"); assert.ok(b.types().includes("enote.eregistry.updated"));
});
test("17.3-T8: Given a `sub_to_sub` batch, then the partner's MIN Update file replaces Supermortgage's Org ID with the new subservicer's, and the Dec 4 snapshot shows no MIN with Supermortgage in the Subservicer field.", async () => {
  const mins = [{ min: "100099990000000011", subservicer_org_id: SUPERMORTGAGE_ORG_ID }, { min: "100099990000000029", subservicer_org_id: SUPERMORTGAGE_ORG_ID }];
  const f = minUpdateFile({ type: "sub_to_sub", mins, new_subservicer_org_id: "1004567" });
  assert.equal(f.transaction, "min_update_replace_subservicer"); assert.equal(f.submitted_by, "partner"); assert.equal(f.remaining_supermortgage, 0);
  assert.deepEqual(f.rows.map((r) => [r.min, r.subservicer_before, r.subservicer_after]), [["100099990000000011", SUPERMORTGAGE_ORG_ID, "1004567"], ["100099990000000029", SUPERMORTGAGE_ORG_ID, "1004567"]]);
  assert.deepEqual(minUpdateFile({ type: "sub_to_master", mins, new_subservicer_org_id: null }).rows.map((r) => r.subservicer_after), [null, null]);
  const minList = mins.map((m) => m.min);
  const v = verifyMersSnapshot({ transfer_date: T, snapshot_on: D("2026-12-04"), mins: minList, snapshot: f.rows.map((r) => ({ min: r.min, subservicer_org_id: r.subservicer_after })) });
  assert.equal(v.verify_by, "2026-12-04"); assert.equal(v.on_time, true); assert.deepEqual(v.remaining_with_supermortgage, []); assert.deepEqual(v.missing_from_snapshot, []); assert.equal(v.expected, 2); assert.equal(v.ok, true); assert.equal(v.event, "mers.snapshot.verified");
  const bad = verifyMersSnapshot({ transfer_date: T, snapshot_on: D("2026-12-04"), mins: minList, snapshot: [{ min: "100099990000000011", subservicer_org_id: "1004567" }, { min: "100099990000000029", subservicer_org_id: SUPERMORTGAGE_ORG_ID }] });
  assert.equal(bad.ok, false); assert.deepEqual(bad.remaining_with_supermortgage, ["100099990000000029"]); assert.equal(bad.event, null);
  // an empty or partial snapshot verifies nothing (1.5: `mers.snapshot.verified` for 100% of MINs) — the batch's MIN population is the yardstick, not the rows the snapshot happens to contain
  const empty = verifyMersSnapshot({ transfer_date: T, snapshot_on: D("2026-12-04"), mins: minList, snapshot: [] });
  assert.equal(empty.ok, false); assert.equal(empty.event, null); assert.deepEqual(empty.missing_from_snapshot, minList); assert.equal(empty.on_time, true);
  const partial = verifyMersSnapshot({ transfer_date: T, snapshot_on: D("2026-12-04"), mins: minList, snapshot: [{ min: "100099990000000011", subservicer_org_id: "1004567" }] });
  assert.equal(partial.ok, false); assert.deepEqual(partial.missing_from_snapshot, ["100099990000000029"]);
  assert.equal(verifyMersSnapshot({ transfer_date: T, snapshot_on: D("2026-12-07"), mins: minList, snapshot: [] }).on_time, false);   // T+3 servicer BD = Fri Dec 4; Mon Dec 7 is late
  // on the bus: SM_MERS_POST_TRANSFER_VERIFY_3 arms on the cutover (due Dec 4); the snapshot is verified against the batch's MINs — an empty one is a partner escalation, never `mers.snapshot.verified`
  const b = bus("2026-12-01T15:00:00.000Z");
  b.events.append({ type: "transfer.batch.cutover_completed", aggregate: BATCH, actor: SYSTEM, payload: { direction: "out", transfer_date: "2026-12-01" } });
  assert.deepEqual(b.timers.byCode("SM_MERS_POST_TRANSFER_VERIFY_3").map((t) => [t.dueDate, t.status]), [["2026-12-04", "armed"]]);
  await assert.rejects(b.run("verifyMersSnapshot", AGENT, { batch_id: BATCH.id, transfer_date: "2026-12-01", snapshot_on: "2026-12-04", snapshot: [] }), /no MINs to verify/);
  await b.run("verifyMersSnapshot", AGENT, { batch_id: BATCH.id, transfer_date: "2026-12-01", snapshot_on: "2026-12-04", mins: minList, snapshot: [] }, "2026-12-04T15:00:00.000Z");
  assert.deepEqual(b.status("SM_MERS_POST_TRANSFER_VERIFY_3"), ["armed"]); assert.ok(!b.types().includes("mers.snapshot.verified")); assert.ok(b.types().includes("escalation.created"));
  await b.run("verifyMersSnapshot", AGENT, { batch_id: BATCH.id, transfer_date: "2026-12-01", snapshot_on: "2026-12-04", mins: minList, snapshot: f.rows.map((r) => ({ min: r.min, subservicer_org_id: r.subservicer_after })) }, "2026-12-04T16:00:00.000Z");
  assert.deepEqual(b.status("SM_MERS_POST_TRANSFER_VERIFY_3"), ["satisfied"]); assert.ok(b.types().includes("mers.snapshot.verified"));
});
test("17.3-T9: Given a transferee request for a missing modification agreement received Dec 10, then it is answered by Dec 17 (5 BD) with the document hash.", () => {
  const r = transfereeRequest({ received_on: D("2026-12-10"), transfer_date: T, kind: "missing_document", document: { id: "doc-mod-agreement", sha256: "9f2c4d1e" }, responded_on: D("2026-12-17") });
  assert.equal(r.due, "2026-12-17"); assert.equal(r.sla_business_days, 5); assert.equal(r.within_support_window, true); assert.deepEqual(r.response, { document_id: "doc-mod-agreement", document_hash: "9f2c4d1e" }); assert.equal(r.status, "responded"); assert.equal(r.on_time, true);
  assert.equal(transfereeRequest({ received_on: D("2026-12-10"), transfer_date: T, kind: "missing_document", document: { id: "doc-mod-agreement", sha256: "9f2c4d1e" }, responded_on: D("2026-12-18") }).on_time, false);
  // the registry row is anchored on received_at and satisfied by the response event
  const { events, timers } = engine(["17.3"], "2026-12-10T15:00:00.000Z");
  events.append({ type: "transferee_request.received", aggregate: { kind: "transferee_request", id: "TR-1" }, actor: SYSTEM, payload: { received_at: "2026-12-10", kind: "missing_document", batch_id: BATCH.id } });
  const t = timers.byCode("SM_XFER_OUT_TRANSFEREE_REQUEST_5BD"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-12-17");
  events.append({ type: "transferee_request.responded", aggregate: { kind: "transferee_request", id: "TR-1" }, actor: SYSTEM, payload: { document_hash: "9f2c4d1e" }, occurredAt: "2026-12-17T15:00:00.000Z" }); assert.equal(t[0]!.status, "satisfied");
  // after the 90-day support window the SLA relaxes to 10 BD; > 10 open requests → officer
  const after = transfereeRequest({ received_on: D("2027-03-02"), transfer_date: T, kind: "data_question" }); assert.equal(after.within_support_window, false); assert.equal(after.sla_business_days, 10); assert.equal(after.due, "2027-03-16"); assert.equal(after.status, "open");
  assert.equal(transfereeRequestBacklog(10), null); assert.equal(transfereeRequestBacklog(11)!.kind, "officer");
});
test("17.3-T10: Given an NoE about a 2026 escrow disbursement received Nov 15, 2027, then it is timely (≤ T+1y) and the 4.1 clocks run; received Dec 15, 2027 → `untimely` with the §1024.35(g)(2) notice.", () => {
  const timely = postTransferNoe({ transfer_date: T, received_on: D("2027-11-15"), assertion_type: "b3" });
  assert.equal(timely.tail_end, "2027-12-01"); assert.equal(timely.timely, true); assert.equal(timely.exception, null); assert.equal(timely.exception_notice, null); assert.equal(timely.gate, "REGX_1024_35G_NOE_TAIL_1Y");
  assert.deepEqual([timely.deadlines!.profile, timely.deadlines!.ack_due, timely.deadlines!.response_due], ["std_30", "2027-11-22", "2027-12-29"]);   // the 4.1 clocks run (5 / 30 federal BD)
  const late = postTransferNoe({ transfer_date: T, received_on: D("2027-12-15"), assertion_type: "b3" });
  assert.equal(late.timely, false); assert.equal(late.exception, "untimely"); assert.equal(late.deadlines, null);
  assert.deepEqual(late.exception_notice, { template: "NTC_REGX_35G2_EXCEPTION", citation: "§1024.35(g)(2)", due: "2027-12-22" });
  const ev = EVALUATORS_17_3["17.3.noeRfiWithinPostTransferTail"]!;
  assert.equal(ev({ received_on: "2027-11-15", transfer_date: "2026-12-01" }).open, true); assert.equal(ev({ received_on: "2027-12-01", transfer_date: "2026-12-01" }).open, true);
  const closed = ev({ received_on: "2027-12-15", transfer_date: "2026-12-01" }); assert.equal(closed.open, false); assert.match(closed.reason!, /untimely/); assert.match(closed.reason!, /1024\.35\(g\)\(1\)\(iii\)/);
});
test("17.3-T11: Given a loan with an open non-liquidation Form 2009 release at T, then the executed Form 2009 is delivered to the transferee custodian by T and the custodian's 90-day report responsibility passes with it.", () => {
  const h = form2009Handoff({ transfer_date: T, releases: [{ loan_id: "L-fc", opened_on: D("2026-10-15"), liquidation: false, executed_form2009_document_id: "doc-2009-L-fc" }, { loan_id: "L-payoff", opened_on: D("2026-11-20"), liquidation: true, executed_form2009_document_id: null }], delivered_on: D("2026-11-30") });
  assert.equal(h.due, "2026-12-01"); assert.equal(h.recipient, "transferee_custodian");
  assert.deepEqual(h.items, [{ loan_id: "L-fc", report_due: "2027-01-13", overdue_at_transfer: false, responsibility_after_transfer: "transferee_custodian", executed: true }]);   // liquidation releases do not travel
  assert.equal(h.delivered_by_transfer, true); assert.deepEqual(h.signing_officer_required, []); assert.equal(h.event, "custody.form2009.handed_off");
  const unsigned = form2009Handoff({ transfer_date: T, releases: [{ loan_id: "L-fc", opened_on: D("2026-08-15"), liquidation: false, executed_form2009_document_id: null }], delivered_on: D("2026-11-30") });
  assert.deepEqual(unsigned.signing_officer_required, ["L-fc"]); assert.equal(unsigned.delivered_by_transfer, false); assert.equal(unsigned.event, null); assert.equal(unsigned.items[0]!.overdue_at_transfer, true);
  assert.equal(unsigned.items[0]!.responsibility_after_transfer, "transferor_custodian");   // the 90-day report responsibility passes only with an executed, delivered Form 2009
  const lateDelivery = form2009Handoff({ transfer_date: T, releases: [{ loan_id: "L-fc", opened_on: D("2026-10-15"), liquidation: false, executed_form2009_document_id: "doc" }], delivered_on: D("2026-12-02") });
  assert.equal(lateDelivery.delivered_by_transfer, false); assert.equal(lateDelivery.items[0]!.responsibility_after_transfer, "transferor_custodian"); assert.equal(lateDelivery.event, null);
  // registry: due T on the freeze, satisfied by the hand-off event
  const { events, timers } = engine(["17.3"], "2026-11-30T22:00:00.000Z");
  events.append({ type: "transfer.cutover.frozen", aggregate: BATCH, actor: SYSTEM, payload: { transfer_date: "2026-12-01" } });
  const t = timers.byCode("SM_XFER_OUT_FORM2009_HANDOFF_T0"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-12-01");
  events.append({ type: "custody.form2009.handed_off", aggregate: BATCH, actor: SYSTEM, payload: { recipient: "transferee_custodian", loans: ["L-fc"] } }); assert.equal(t[0]!.status, "satisfied");
});
test("17.3-T12: Given `retain_until` = Dec 1, 2033 for a loan with no legal hold, then PII de-identification runs after that date and the manifest hashes remain queryable.", () => {
  const p = retentionPlan({ transfer_date: T });
  assert.deepEqual([p.regx_floor, p.policy_archive_until, p.retain_until, p.retention_class, p.legal_hold], ["2027-12-01", "2033-12-01", "2033-12-01", "transfer_out_archive", false]);
  assert.equal(retentionPlan({ transfer_date: T, legal_hold_until: D("2035-01-01") }).retain_until, "2035-01-01"); assert.equal(retentionPlan({ transfer_date: T, state_retention_years: 10 }).retain_until, "2036-12-01");
  const manifest = [{ document_id: "doc-note", sha256: "a1b2", as_of: D("2026-11-30") }, { document_id: "doc-mod", sha256: "c3d4", as_of: D("2026-11-30") }];
  const onDay = deidentify({ retain_until: p.retain_until, legal_hold: false, today: D("2033-12-01"), manifest, pii_fields: ["borrower_name", "ssn", "property_address"] }); assert.equal(onDay.ran, false); assert.match(onDay.reason!, /2033-12-01 not yet passed/);
  const after = deidentify({ retain_until: p.retain_until, legal_hold: false, today: D("2033-12-02"), manifest, pii_fields: ["borrower_name", "ssn", "property_address"] });
  assert.equal(after.ran, true); assert.equal(after.deidentified_at, "2033-12-02"); assert.deepEqual(after.pii_removed, ["borrower_name", "ssn", "property_address"]); assert.deepEqual(after.manifest, manifest); assert.equal(after.gate, "REGX_1024_38C1_RETENTION_1Y");
  assert.equal(deidentify({ retain_until: p.retain_until, legal_hold: true, today: D("2033-12-02"), manifest, pii_fields: ["ssn"] }).ran, false);
  const ev = EVALUATORS_17_3["17.3.retentionFloorElapsed"]!;
  assert.equal(ev({ today: "2033-12-02", transfer_date: "2026-12-01", retain_until: "2033-12-01", legal_hold: false }).open, true); assert.equal(ev({ today: "2033-12-01", transfer_date: "2026-12-01", retain_until: "2033-12-01" }).open, false);
  assert.match(ev({ today: "2027-06-01", transfer_date: "2026-12-01" }).reason!, /2027-12-01/); assert.match(ev({ today: "2040-01-01", transfer_date: "2026-12-01", legal_hold: true }).reason!, /legal hold/);
});
test("17.3-T13: Given the transferee's preliminary load report shows a mapping difference on `NoteRatePercent` for 12 loans, then `SM_XFER_OUT_PRELIM_QC_7` cannot be satisfied until a corrected preliminary is acknowledged.", async () => {
  const blocked = prelimQc({ load_report: { differences: [{ field: "NoteRatePercent", loan_count: 12 }] }, corrected_preliminary_acked: false });
  assert.equal(blocked.match, false); assert.equal(blocked.satisfiable, false); assert.equal(blocked.event, null); assert.deepEqual(blocked.blocking, [{ field: "NoteRatePercent", loan_count: 12 }]); assert.equal(blocked.corrective_action, "send_corrected_preliminary"); assert.equal(blocked.timer, "SM_XFER_OUT_PRELIM_QC_7");
  assert.equal(prelimQc({ load_report: null, corrected_preliminary_acked: false }).corrective_action, "await_load_report");
  // a corrected preliminary acknowledged but not yet re-loaded still cannot complete the QC
  const pending = prelimQc({ load_report: { differences: [{ field: "NoteRatePercent", loan_count: 12 }] }, corrected_preliminary_acked: true }); assert.equal(pending.satisfiable, false); assert.equal(pending.corrective_action, "await_load_report");
  const clean = prelimQc({ load_report: { differences: [{ field: "NoteRatePercent", loan_count: 0 }] }, corrected_preliminary_acked: true }); assert.equal(clean.match, true); assert.equal(clean.event, "transfer.prelim_qc.completed");
  // on the bus: the D02 ack comes with the load report (Bulletin 2020-02 preliminary QC) — differences leave the tape acknowledged (SM_XFER_OUT_PRELIM_TAPE_14 closes; SM_XFER_OUT_PRELIM_QC_7 arms on the ack, due +7 = Nov 24)
  // but the QC blocked; an acked deliverable is regenerated only as an explicit correction, and `transfer.prelim_qc.completed` is emitted only when the corrected preliminary is acknowledged with a clean load report
  const b = bus("2026-11-02T14:00:00.000Z");
  b.events.append({ type: "transfer.batch.approved", aggregate: BATCH, actor: SYSTEM, payload: { direction: "out", transfer_date: "2026-12-01" } });
  await b.run("planDeliverables", AGENT, { batch_id: BATCH.id, transfer_date: "2026-12-01" });
  assert.deepEqual(b.timers.byCode("SM_XFER_OUT_PRELIM_TAPE_14").map((t) => [t.dueDate, t.status]), [["2026-11-17", "armed"]]);
  await b.deliver("D02", "2026-11-17", "2026-11-17T10:00:00.000Z");
  const first = await b.run("ingestTransfereeAck", AGENT, { batch_id: BATCH.id, kind: "D02", ack_reference: "ACK-D02", load_report: { differences: [{ field: "NoteRatePercent", loan_count: 12 }] } }, "2026-11-17T15:00:00.000Z") as { status: string; correction_seq: number; prelim_qc: { satisfiable: boolean; corrective_action: string; blocking: unknown[] } };
  assert.equal(first.status, "acked"); assert.equal(first.correction_seq, 0); assert.equal(first.prelim_qc.satisfiable, false); assert.equal(first.prelim_qc.corrective_action, "send_corrected_preliminary"); assert.deepEqual(first.prelim_qc.blocking, [{ field: "NoteRatePercent", loan_count: 12 }]);
  assert.deepEqual(b.status("SM_XFER_OUT_PRELIM_TAPE_14"), ["satisfied"]); assert.deepEqual(b.timers.byCode("SM_XFER_OUT_PRELIM_QC_7").map((t) => [t.dueDate, t.status]), [["2026-11-24", "armed"]]);
  assert.ok(b.types().includes("transfer.prelim_qc.blocked")); assert.ok(!b.types().includes("transfer.prelim_qc.completed"));
  await assert.rejects(b.run("generateDeliverable", AGENT, { batch_id: BATCH.id, kind: "D02", as_of: "2026-11-19" }), /regenerate it only as a correction/);
  await assert.rejects(b.run("ingestTransfereeAck", AGENT, { batch_id: BATCH.id, kind: "D02", ack_reference: "ACK-D02-again", load_report: { differences: [] } }), /only a delivered deliverable can be acknowledged/);   // re-acking the same file is not a correction
  await b.deliver("D02", "2026-11-19", "2026-11-19T10:00:00.000Z", { corrected: true });   // the corrected preliminary climbs the ladder again (correction_seq 1)
  assert.deepEqual(b.status("SM_XFER_OUT_PRELIM_QC_7"), ["armed"]); assert.equal(b.rt.store.get("transfer_out_deliverables", `${BATCH.id}-D02`)!.data.correction_seq, 1);
  const corrected = await b.run("ingestTransfereeAck", AGENT, { batch_id: BATCH.id, kind: "D02", ack_reference: "ACK-D02-c1", load_report: { differences: [{ field: "NoteRatePercent", loan_count: 0 }] } }, "2026-11-20T15:00:00.000Z") as { status: string; correction_seq: number; prelim_qc: { satisfiable: boolean; event: string | null } };
  assert.deepEqual([corrected.status, corrected.correction_seq, corrected.prelim_qc.satisfiable, corrected.prelim_qc.event], ["acked", 1, true, "transfer.prelim_qc.completed"]);
  assert.ok(b.types().includes("transfer.prelim_qc.completed")); assert.deepEqual(b.status("SM_XFER_OUT_PRELIM_QC_7"), ["satisfied", "satisfied"]);   // the Nov 17 row and the one the corrected ack armed (Nov 27) both close on the QC
});
test("17.3-T14: Given the last batch for the partner cut over and the final-period draft cleared Dec 21, then the CBAM LOA-cancellation portal task is due Jan 6, 2027 (10 BD; Dec 25 and Jan 1 excluded).", () => {
  const r = cbamLoaCancellation({ last_batch_for_partner: true, draft_cleared_on: D("2026-12-21") });
  assert.equal(r.due, "2027-01-06"); assert.equal(r.timer, "SM_XFER_OUT_CUSTODIAL_ACCOUNT_CLOSE");
  assert.deepEqual(r.task, { kind: "human_portal_task", portal: "CBAM", action: "loa_cancellation", due: "2027-01-06", completion_event: "human_portal_task.completed" });
  assert.deepEqual(cbamLoaCancellation({ last_batch_for_partner: false, draft_cleared_on: D("2026-12-21") }), { due: null, task: null, timer: "SM_XFER_OUT_CUSTODIAL_ACCOUNT_CLOSE" });
  // registry: +10 servicer BD from the clearing date (Dec 25 and Jan 1 excluded), satisfied by the portal task completion
  const { events, timers } = engine(["17.3"], "2026-12-21T20:00:00.000Z");
  events.append({ type: "transfer.final_remittance.cleared", aggregate: BATCH, actor: SYSTEM, payload: { last_batch_for_partner: true, form_496_final: true } });
  const t = timers.byCode("SM_XFER_OUT_CUSTODIAL_ACCOUNT_CLOSE"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2027-01-06");
  events.append({ type: "human_portal_task.completed", aggregate: BATCH, actor: SYSTEM, payload: { task: "cbam_loa_cancellation" }, occurredAt: "2027-01-05T15:00:00.000Z" }); assert.equal(t[0]!.status, "satisfied");
});

test("17.3 worked figures: T&I wire 276,572 cents (L1 escrow 184,250 + November interest 307 = 184,557; L3 92,015), P&I forwardable 238,300 (unapplied 32,500 + prepaid Dec 1 P&I 205,800), final accounting receivable 541,109 (3 × 161,603 = 484,809 + escrow advance 41,300 + corporate advances 15,000), late charges 6,464 as a borrower memo; deliverable, counterparty, custodial-close, support-window and archive dates", () => {
  const L1 = { upb_cents: 24_563_412n, escrow_cents: 184_250n, unapplied_cents: 32_500n, corporate_advances_cents: 15_000n, late_charges_cents: 6_464n, escrow_interest_rate_pct: "2" };
  const L2 = { upb_cents: 18_020_000n, escrow_cents: -41_300n, unapplied_cents: 0n, corporate_advances_cents: 0n, late_charges_cents: 0n, pi_advances_cents: 3n * 161_603n };
  const L3 = { upb_cents: 31_100_055n, escrow_cents: 92_015n, unapplied_cents: 0n, corporate_advances_cents: 0n, late_charges_cents: 0n, prepaid_next_period_pi_cents: 205_800n };
  const w = ledgerAtFreeze([L1, L2, L3]);
  assert.equal(w.wires.ti_wire_cents, 276_572n); assert.equal(w.wires.ti_wire_cents - L3.escrow_cents - L1.escrow_cents, 307n); assert.equal(w.wires.pi_wire_cents, 238_300n); assert.equal(w.wires.pi_wire_cents, L1.unapplied_cents + L3.prepaid_next_period_pi_cents);
  assert.equal(w.wires.pi_advances_receivable_cents, 484_809n); assert.equal(w.wires.escrow_advances_receivable_cents, 41_300n); assert.equal(w.wires.corporate_advances_receivable_cents, 15_000n); assert.equal(w.wires.final_accounting_receivable_cents, 541_109n); assert.equal(w.wires.late_charges_memo_cents, 6_464n);
  for (const s of [w.ti_wire, w.pi_wire, w.advances_on_ack, w.reimbursement]) { assert.equal(s.balanced, true); assert.ok(s.lines.every((l) => l.rule_ref.startsWith("17.3 funds"))); }
  assert.deepEqual(w.ti_wire.lines.map((l) => [l.account, l.side, l.amount_cents]), [["escrow", "Dr", 276_572n], ["custodial_ti_cash", "Cr", 276_572n]]);
  assert.deepEqual(w.pi_wire.lines.map((l) => [l.account, l.side, l.amount_cents]), [["suspense_unapplied", "Dr", 32_500n], ["fnma_remittance_payable_next_period", "Dr", 205_800n], ["custodial_pi_cash", "Cr", 238_300n]]);
  assert.deepEqual(w.advances_on_ack.lines.map((l) => [l.account, l.side, l.amount_cents]), [["due_from_transferee", "Dr", 541_109n], ["servicer_advance_receivable", "Cr", 484_809n], ["escrow_advances", "Cr", 41_300n], ["corporate_advances", "Cr", 15_000n]]);
  assert.deepEqual(w.reimbursement.lines.map((l) => [l.account, l.side, l.amount_cents]), [["custodial_pi_cash", "Dr", 541_109n], ["due_from_transferee", "Cr", 541_109n]]);
  // deliverable plan (T1 dates): test Nov 1, preliminary Nov 17, final/trial balance as of Nov 30 delivered Dec 2, images and custodial recons Dec 8, final accounting Dec 31, eNote copies before T
  const plan = planDeliverables(T); const due = Object.fromEntries(plan.map((p) => [p.kind, p.due])); const asOf = Object.fromEntries(plan.map((p) => [p.kind, p.as_of]));
  assert.equal(plan.length, 34); assert.deepEqual([due.D01, due.D02, due.D03, due.D04, asOf.D04, due.D05, due.D28, due.D08, due.D31, due.D18], ["2026-11-01", "2026-11-17", "2026-12-02", "2026-12-02", "2026-11-30", "2026-12-02", "2026-12-08", "2026-12-08", "2026-12-31", "2026-11-30"]);
  assert.equal(plan.find((p) => p.kind === "D27")!.channel, "restricted"); assert.ok(plan.every((p) => p.status === "planned"));
  // counterparties: everything due Mon Nov 30 (T−1 servicer BD) except the transferor custodian (at approval); groups complete → group events; all sent → transfer.counterparties.notified
  const parties = [{ party_type: "mi" as const, party_id: "MGIC" }, { party_type: "hazard_insurer" as const, party_id: "H-1" }, { party_type: "lpi_tracker" as const, party_id: "LPI" }, { party_type: "tax_service" as const, party_id: "TAX" }, { party_type: "taxing_authority" as const, party_id: "Kings County" }, { party_type: "hoa" as const, party_id: "HOA-1" }, { party_type: "law_firm" as const, party_id: "FIRM-1" }, { party_type: "bk_trustee" as const, party_id: "TR-13" }, { party_type: "custodian_transferor" as const, party_id: "CUST-1" }];
  const n = planCounterpartyNotifications({ transfer_date: T, approved_on: D("2026-10-30"), parties });
  assert.ok(n.filter((x) => x.party_type !== "custodian_transferor").every((x) => x.due_at === "2026-11-30")); assert.equal(n.find((x) => x.party_type === "custodian_transferor")!.due_at, "2026-10-30");
  assert.deepEqual(n.map((x) => x.kind), ["transfer_notice", "endorsement_request", "endorsement_request", "continue_or_discontinue", "transfer_notice", "transfer_notice", "transfer_notice", "payment_address_change", "transfer_notice"]);
  assert.deepEqual(n.map((x) => x.group), ["mi", "insurers", "insurers", "vendors", "taxing_authorities", "taxing_authorities", "law_firms", "bk_trustees", "custodians"]);
  const partial = counterpartyStatus({ transfer_date: T, notifications: n.map((x) => ({ ...x, sent_at: x.party_type === "law_firm" ? null : D("2026-11-30") })) });
  assert.equal(partial.all_due_before_transfer_sent, false); assert.deepEqual(partial.unsent_due_before_transfer.map((x) => x.party_id), ["FIRM-1"]); assert.equal(partial.event, null);
  assert.ok(partial.groups_complete.includes("mi") && partial.groups_complete.includes("insurers") && !partial.groups_complete.includes("law_firms"));
  const all = counterpartyStatus({ transfer_date: T, notifications: n.map((x) => ({ ...x, sent_at: D("2026-11-30") })) });
  assert.deepEqual(all.event, { type: "transfer.counterparties.notified", all_due_before_transfer_sent: true }); assert.deepEqual(all.group_events.map((g) => g.group).sort(), ["bk_trustees", "custodians", "insurers", "law_firms", "mi", "taxing_authorities", "vendors"]);
  assert.deepEqual(miNoticeCheck({ certificate_number: "C-1", borrower_name: "A", selling_servicer: "Supermortgage", new_servicer_name: "N", new_servicer_address: "1 Main", new_loan_number: "N-1", effective_date: "2026-12-01" }), { ok: false, missing: ["requestor_contact"] });
  // custodial-account disposition (+60 CD from the Dec 8 reconciliation ack → Feb 6, 2027)
  const closed = custodialAccountDisposition({ account_id: "C-PI", recon_acked_on: D("2026-12-08"), adjustment_window_closed: true, open_variance: false, population_fully_transferred: true, balance_cents: 0n, forms_1013_1014_withdrawn: true, bank_closure_letter_document_id: "doc-close", recon_certificate_document_id: null });
  assert.equal(closed.due, "2027-02-06"); assert.equal(closed.armed, true); assert.equal(closed.outcome, "closed"); assert.deepEqual(closed.event, { type: "transfer.custodial_account.disposed", outcome: "closed", account_id: "C-PI" });
  const pending = custodialAccountDisposition({ account_id: "C-PI", recon_acked_on: D("2026-12-08"), adjustment_window_closed: true, open_variance: false, population_fully_transferred: true, balance_cents: 1_250n, forms_1013_1014_withdrawn: false, bank_closure_letter_document_id: null, recon_certificate_document_id: null });
  assert.equal(pending.outcome, null); assert.equal(pending.remaining_steps.length, 3); assert.equal(pending.portal_task!.action, "withdraw_forms_1013_1014"); assert.equal(pending.portal_task!.countersignature, "partner");
  assert.equal(custodialAccountDisposition({ account_id: "C-TI", recon_acked_on: D("2026-12-08"), adjustment_window_closed: true, open_variance: false, population_fully_transferred: false, balance_cents: 500_000n, forms_1013_1014_withdrawn: false, bank_closure_letter_document_id: null, recon_certificate_document_id: "doc-cert" }).outcome, "recon_certificate_filed");
  // support window through Mon Mar 1, 2027; archive manifests within 10 servicer BD of the D31 ack; de-brief at T+30
  assert.deepEqual(supportWindow({ transfer_date: T, today: D("2027-03-01") }), { window_end: "2027-03-01", open: true, forwarding: "daily", request_sla_business_days: 5, event: null });
  assert.deepEqual(supportWindow({ transfer_date: T, today: D("2027-03-02") }), { window_end: "2027-03-01", open: false, forwarding: "on_receipt", request_sla_business_days: 10, event: "transfer.support_window.expired" });
  const am = archiveManifestStatus({ d31_acked_on: D("2026-12-31"), listed_loans: ["L1", "L2", "L3"], archives: [{ loan_id: "L1", archive_manifest_document_id: "m1" }, { loan_id: "L2", archive_manifest_document_id: "m2" }, { loan_id: "L3", archive_manifest_document_id: null }] });
  assert.equal(am.due, "2027-01-15"); assert.deepEqual(am.missing, ["L3"]); assert.equal(am.event, null);
  assert.deepEqual(archiveManifestStatus({ d31_acked_on: D("2026-12-31"), listed_loans: ["L1"], archives: [{ loan_id: "L1", archive_manifest_document_id: "m1" }] }).event, { type: "transfer.archive.written", all_loans: true });
  const db = buildDebrief({ transfer_date: T, deliverables: [{ kind: "D03", due: D("2026-12-02"), acked_at: D("2026-12-02"), status: "acked" }, { kind: "D28", due: D("2026-12-08"), acked_at: D("2026-12-09"), status: "acked" }, { kind: "D08", due: D("2026-12-08"), acked_at: null, status: "exception" }], transferee_requests: [{ due: D("2026-12-17"), responded_on: D("2026-12-17") }, { due: D("2026-12-18"), responded_on: null }], misdirected_count: 1, counterparty_notifications: n.map((x) => ({ ...x, sent_at: D("2026-11-30") })) });
  assert.equal(db.due, "2026-12-31"); assert.deepEqual(db.late_deliverables, ["D28", "D08"]); assert.deepEqual(db.open_exceptions, ["D08"]); assert.equal(db.late_requests, 1); assert.equal(db.misdirected_payments, 1); assert.equal(db.unacked_counterparties, 0); assert.equal(db.event, "transfer.debrief.completed");
});

test("17.3 bus wiring: planned counterparties, freeze, wires, acknowledgment ladder, custodian feed, MERS/eRegistry, shortage/surplus, custodial close, final cycle, support window and archive satisfy the registry rows through the tools", async () => {
  const b = bus("2026-10-30T14:00:00.000Z");
  b.events.append({ type: "transfer.batch.approved", aggregate: BATCH, actor: SYSTEM, payload: { direction: "out", transfer_date: "2026-12-01", type: "sub_to_sub" } });   // the 17.1 payload: direction / type / transfer_date, no population counts
  for (const c of ["SM_XFER_OUT_COUNTERPARTIES_T1", "SM_XFER_OUT_MI_NOTICE_T1", "SM_XFER_OUT_INSURER_ENDORSEMENT_T1", "SM_XFER_OUT_VENDOR_NOTICE_T1", "SM_XFER_OUT_TAXING_AUTHORITY_NOTICE_T1", "MERS_PROC_SUBSERVICER_MIN_UPDATE_T0", "FNMA_A2_7_03_TRANSFEROR_CUSTODIAN_NOTICE_30"]) assert.deepEqual(b.status(c), ["armed"], c);
  // the law-firm / trustee rows key on `fc_or_litigation>0` / `bk>0`, facts the approval event does not carry: the deliverable plan on that approval states them from the attested loan list and arms them on the same transfer_date anchor
  assert.deepEqual([b.status("SM_XFER_OUT_LAW_FIRM_NOTICE_T1"), b.status("SM_XFER_OUT_BK_TRUSTEE_NOTICE_T1")], [[], []]);
  const planned = await b.run("planDeliverables", AGENT, { batch_id: BATCH.id, transfer_date: "2026-12-01", type: "sub_to_sub", loans: [{ loan_id: "L1", mi: "MGIC" }, { loan_id: "L2", foreclosure: true }, { loan_id: "L3", bankruptcy: true, litigation: true }] }) as { facts: Record<string, unknown> };
  assert.deepEqual(planned.facts, { loan_count: 3, fc_or_litigation: 2, bk: 1, emortgage_count: 0, participation_pool: 0, mi_insurers: ["MGIC"] });
  assert.deepEqual([b.timers.byCode("SM_XFER_OUT_LAW_FIRM_NOTICE_T1").map((t) => [t.dueDate, t.status]), b.timers.byCode("SM_XFER_OUT_BK_TRUSTEE_NOTICE_T1").map((t) => [t.dueDate, t.status])], [[["2026-11-30", "armed"]], [["2026-11-30", "armed"]]]);
  assert.deepEqual(b.status("FNMA_F1_11_ENOTE_SERVICING_AGENT_T0"), []);   // no eNotes on the list
  // --- counterparties: completeness is measured against the planned population, never against the notices sent so far
  const mi = { certificate_number: "C-1", borrower_name: "A. Borrower", selling_servicer: "Supermortgage", new_servicer_name: "Newco Servicing", new_servicer_address: "1 Main St", new_loan_number: "N-1", effective_date: "2026-12-01", requestor_contact: "transfers@supermortgage.example" };
  const one = await b.run("notifyCounterparty", AGENT, { batch_id: BATCH.id, party_type: "mi", party_id: "MGIC", transfer_date: "2026-12-01", notice: mi }) as { planned: boolean; group_complete: boolean; all_due_before_transfer_sent: boolean };
  assert.deepEqual([one.planned, one.group_complete, one.all_due_before_transfer_sent], [false, false, false]); assert.deepEqual(b.status("SM_XFER_OUT_MI_NOTICE_T1"), ["armed"]); assert.deepEqual(b.status("SM_XFER_OUT_COUNTERPARTIES_T1"), ["armed"]);
  const parties = [{ party_type: "mi", party_id: "MGIC" }, { party_type: "mi", party_id: "Radian" }, { party_type: "mi", party_id: "Enact" }, { party_type: "hazard_insurer", party_id: "H-1" }, { party_type: "lpi_tracker", party_id: "LPI" }, { party_type: "tax_service", party_id: "TAX" }, { party_type: "taxing_authority", party_id: "Kings County" }, { party_type: "law_firm", party_id: "FIRM-1" }, { party_type: "law_firm", party_id: "FIRM-2" }, { party_type: "bk_trustee", party_id: "TR-13" }, { party_type: "custodian_transferor", party_id: "CUST-1" }, { party_type: "credit_bureau", party_id: "equifax" }, { party_type: "credit_bureau", party_id: "experian" }];
  const plan = await b.run("notifyCounterparty", AGENT, { op: "plan", batch_id: BATCH.id, transfer_date: "2026-12-01", approved_on: "2026-10-30", parties }) as unknown as { due_at: string; party_type: string }[];
  assert.equal(plan.length, 13); assert.equal(plan.find((n) => n.party_type === "custodian_transferor")!.due_at, "2026-10-30"); assert.equal(plan.find((n) => n.party_type === "law_firm")!.due_at, "2026-11-30");
  const two = await b.run("notifyCounterparty", AGENT, { batch_id: BATCH.id, party_type: "mi", party_id: "Radian", transfer_date: "2026-12-01", notice: mi }) as { group_complete: boolean; unsent_due_before_transfer: string[] };
  assert.equal(two.group_complete, false); assert.ok(two.unsent_due_before_transfer.includes("Enact")); assert.deepEqual(b.status("SM_XFER_OUT_MI_NOTICE_T1"), ["armed"]);
  await assert.rejects(b.run("notifyCounterparty", AGENT, { batch_id: BATCH.id, party_type: "mi", party_id: "Enact", transfer_date: "2026-12-01", notice: { ...mi, new_loan_number: "" } }), /missing new_loan_number/);   // MGIC content list
  await b.run("notifyCounterparty", AGENT, { batch_id: BATCH.id, party_type: "mi", party_id: "Enact", transfer_date: "2026-12-01", notice: mi });
  assert.deepEqual(b.status("SM_XFER_OUT_MI_NOTICE_T1"), ["satisfied"]); assert.deepEqual(b.status("SM_XFER_OUT_COUNTERPARTIES_T1"), ["armed"]);   // three MIs sent; law firms, trustee, insurers … still due
  assert.equal(await b.refused("notifyCounterparty", AGENT, { batch_id: BATCH.id, party_type: "law_firm", party_id: "FIRM-1", transfer_date: "2026-12-01", instructions: "substitute_counsel" }), "ATTORNEY_SUBSTITUTION");   // counsel of record substitutes → attorney
  await b.run("notifyCounterparty", { kind: "human", id: "u-atty", role: "attorney" }, { batch_id: BATCH.id, party_type: "law_firm", party_id: "FIRM-1", transfer_date: "2026-12-01", instructions: "substitute_counsel" });
  await b.run("notifyCounterparty", AGENT, { batch_id: BATCH.id, party_type: "law_firm", party_id: "FIRM-2", transfer_date: "2026-12-01", instructions: "hold" });
  assert.deepEqual(b.status("SM_XFER_OUT_LAW_FIRM_NOTICE_T1"), ["satisfied"]);
  assert.equal(await b.refused("notifyCounterparty", AGENT, { batch_id: BATCH.id, party_type: "borrower", party_id: "B-1", transfer_date: "2026-12-01" }), "NO_BORROWER_CONTACT");
  for (const p of [["hazard_insurer", "H-1"], ["lpi_tracker", "LPI"], ["tax_service", "TAX"], ["taxing_authority", "Kings County"], ["bk_trustee", "TR-13"], ["custodian_transferor", "CUST-1"]]) await b.run("notifyCounterparty", AGENT, { batch_id: BATCH.id, party_type: p[0], party_id: p[1], transfer_date: "2026-12-01" });
  assert.deepEqual([b.status("SM_XFER_OUT_INSURER_ENDORSEMENT_T1"), b.status("SM_XFER_OUT_VENDOR_NOTICE_T1"), b.status("SM_XFER_OUT_TAXING_AUTHORITY_NOTICE_T1"), b.status("SM_XFER_OUT_BK_TRUSTEE_NOTICE_T1"), b.status("SM_XFER_OUT_COUNTERPARTIES_T1")], [["satisfied"], ["satisfied"], ["satisfied"], ["satisfied"], ["satisfied"]]);   // the bureaus are due at T, not before it
  // --- the custodian feed: the transferor custodian's confirmation (D-Code, approval letter, trial balance) closes the 30-day notice row and starts the shipment row; the manifest + transferee custodian receipt closes that
  await assert.rejects(b.run("ingestTransfereeAck", AGENT, { source: "custodian", batch_id: BATCH.id, item: { kind: "transferor_notice_confirmed", on: "2026-10-31" } }), /d_code, approval_letter_document_id, trial_balance_document_id/);
  await b.run("ingestTransfereeAck", AGENT, { source: "custodian", batch_id: BATCH.id, item: { kind: "transferor_notice_confirmed", on: "2026-10-31", d_code: "D-123", approval_letter_document_id: "doc-629", trial_balance_document_id: "doc-tb" } }, "2026-10-31T15:00:00.000Z");
  assert.deepEqual(b.status("FNMA_A2_7_03_TRANSFEROR_CUSTODIAN_NOTICE_30"), ["satisfied"]); assert.deepEqual(b.timers.byCode("FNMA_DTJA_DOCS_SHIPPED_30").map((t) => [t.dueDate, t.status]), [["2026-11-30", "armed"]]);
  await b.run("ingestTransfereeAck", AGENT, { source: "custodian", batch_id: BATCH.id, item: { kind: "shipment_confirmed", on: "2026-11-20", manifest_id: "M-1", transferee_custodian_receipt_id: "R-1", document_count: 3 } }, "2026-11-20T15:00:00.000Z");
  assert.deepEqual(b.status("FNMA_DTJA_DOCS_SHIPPED_30"), ["satisfied"]);
  // --- MERS: the partner's MIN Update file (sub_to_sub replaces Supermortgage's Org ID); only the partner's officer submits; the acknowledgment for all MINs satisfies the 1.5 code the 17.3 batch armed
  const mins = [{ min: "100099990000000011", subservicer_org_id: SUPERMORTGAGE_ORG_ID }, { min: "100099990000000029", subservicer_org_id: SUPERMORTGAGE_ORG_ID }];
  assert.equal(await b.refused("verifyMersSnapshot", AGENT, { op: "submit", batch_id: BATCH.id, transfer_date: "2026-12-01", type: "sub_to_sub", mins, new_subservicer_org_id: "1004567" }), "PARTNER_CREDENTIALS");
  await b.run("verifyMersSnapshot", { kind: "human", id: "u-partner-officer", role: "officer" }, { op: "submit", batch_id: BATCH.id, transfer_date: "2026-12-01", type: "sub_to_sub", mins, new_subservicer_org_id: "1004567", partner_org_id: "1000456" }); assert.ok(b.types().includes("mers.txn.submitted"));
  const ack = await b.run("verifyMersSnapshot", AGENT, { op: "ack", batch_id: BATCH.id, transfer_date: "2026-12-01", type: "sub_to_sub", mins, partner_org_id: "1000456", results: [{ min: mins[0]!.min, accepted: true }, { min: mins[1]!.min, accepted: true }], acked_on: "2026-11-30" }) as { all_mins: boolean; txn_type: string };
  assert.deepEqual([ack.txn_type, ack.all_mins], ["min_update_subservicer", true]); assert.deepEqual(b.status("MERS_PROC_SUBSERVICER_MIN_UPDATE_T0"), ["satisfied"]);
  assert.deepEqual(outboundMersAckRows({ type: "servicing_sale", transfer_date: T, partner_org_id: "1000456", mins: [{ min: "1" }] }).txn_type, "tos_initiate");
  // --- the freeze at COB T−1: not before, not with postings dated ≥ T; it arms the T+1 / T+5 clocks; the wires are matched to the trial-balance totals
  await assert.rejects(b.run("runOutboundDqGate", AGENT, { op: "freeze", batch_id: BATCH.id, transfer_date: "2026-12-01", frozen_on: "2026-11-27", loans: ["L1", "L2", "L3"] }), /not before COB 2026-11-30/);
  await assert.rejects(b.run("runOutboundDqGate", AGENT, { op: "freeze", batch_id: BATCH.id, transfer_date: "2026-12-01", frozen_on: "2026-11-30", loans: ["L1", "L2", "L3"], postings: [{ loan_id: "L2", effective_date: "2026-12-01" }] }), /dated ≥ 2026-12-01 on listed loans \(L2\)/);
  const fz = await b.run("runOutboundDqGate", AGENT, { op: "freeze", batch_id: BATCH.id, transfer_date: "2026-12-01", frozen_on: "2026-11-30", loans: ["L1", "L2", "L3"], postings: [{ loan_id: "L1", effective_date: "2026-11-30" }] }, "2026-12-01T03:00:00.000Z") as { holds: unknown[] };
  assert.equal(fz.holds.length, 3); assert.equal(b.rt.store.list("payment_holds").length, 3); assert.deepEqual(b.status("SM_XFER_OUT_CUTOVER_FREEZE_T1"), ["satisfied"]);
  assert.deepEqual([b.status("FNMA_F1_11_TRIAL_BALANCE_T1"), b.status("SM_XFER_OUT_FINAL_TAPE_1"), b.status("SM_XFER_OUT_FUNDS_WIRE_1"), b.status("SM_XFER_OUT_IMAGES_5"), b.status("SM_XFER_OUT_FORM2009_HANDOFF_T0")], [["armed"], ["armed"], ["armed"], ["armed"], ["armed"]]);
  const L = [{ upb_cents: "24563412", escrow_cents: "184250", unapplied_cents: "32500", corporate_advances_cents: "15000", late_charges_cents: "6464", escrow_interest_rate_pct: "2" }, { upb_cents: "18020000", escrow_cents: "-41300", unapplied_cents: "0", corporate_advances_cents: "0", late_charges_cents: "0", pi_advances_cents: "484809" }, { upb_cents: "31100055", escrow_cents: "92015", unapplied_cents: "0", corporate_advances_cents: "0", late_charges_cents: "0", prepaid_next_period_pi_cents: "205800" }];
  const short = await b.run("runOutboundDqGate", AGENT, { op: "match_wires", batch_id: BATCH.id, loans: L, confirmations: [{ kind: "ti", amount_cents: "276572", reference: "W1" }, { kind: "pi", amount_cents: "238000", reference: "W2" }] }, "2026-12-02T15:00:00.000Z") as { matched: boolean };
  assert.equal(short.matched, false); assert.deepEqual(b.status("SM_XFER_OUT_FUNDS_WIRE_1"), ["armed"]); assert.ok(b.types().includes("recon.transfer_out_wires.variance"));
  const ok = await b.run("runOutboundDqGate", AGENT, { op: "match_wires", batch_id: BATCH.id, loans: L, confirmations: [{ kind: "ti", amount_cents: "276572", reference: "W1" }, { kind: "pi", amount_cents: "238300", reference: "W3" }] }, "2026-12-02T16:00:00.000Z") as { matched: boolean; expected: { ti_cents: bigint; pi_cents: bigint } };
  assert.equal(ok.matched, true); assert.deepEqual([ok.expected.ti_cents, ok.expected.pi_cents], [276_572n, 238_300n]); assert.deepEqual(b.status("SM_XFER_OUT_FUNDS_WIRE_1"), ["satisfied"]);
  // --- the acknowledgment ladder: no ack for an undelivered deliverable; D04 must carry as_of = T−1; a wrong ack is an exception (resolved → regenerated → re-delivered); the final-tape set closes as one
  await assert.rejects(b.run("ingestTransfereeAck", AGENT, { batch_id: BATCH.id, kind: "D04", ack_reference: "X" }), /only a delivered deliverable can be acknowledged/); assert.deepEqual(b.status("FNMA_F1_11_TRIAL_BALANCE_T1"), ["armed"]);
  assert.equal(await b.refused("sendDeliverable", AGENT, { batch_id: BATCH.id, kind: "D27", channel: "sftp" }), "D27_RESTRICTED_CHANNEL");
  await b.deliver("D04", "2026-11-30", "2026-12-02T10:00:00.000Z");
  await assert.rejects(b.run("sendDeliverable", AGENT, { batch_id: BATCH.id, kind: "D04", channel: "sftp" }), /pass resend=true/);
  const bad = await b.run("ingestTransfereeAck", AGENT, { batch_id: BATCH.id, kind: "D04", ack_reference: "ACK-D04", as_of: "2026-11-29" }, "2026-12-02T12:00:00.000Z") as { status: string; refusal: string };
  assert.equal(bad.status, "exception"); assert.match(bad.refusal, /as_of = transfer_date − 1/); assert.deepEqual(b.status("FNMA_F1_11_TRIAL_BALANCE_T1"), ["armed"]);
  await assert.rejects(b.run("sendDeliverable", AGENT, { batch_id: BATCH.id, kind: "D04", channel: "sftp", resend: true }), /only an attested deliverable can be delivered/);   // an exception is not re-sent as is
  await b.run("ingestTransfereeAck", AGENT, { op: "resolve", batch_id: BATCH.id, kind: "D04", resolution: "as-of corrected" });
  await assert.rejects(b.run("sendDeliverable", AGENT, { batch_id: BATCH.id, kind: "D04", channel: "sftp" }), /regenerated, validated and attested first/);
  await b.deliver("D04", "2026-11-30", "2026-12-02T13:00:00.000Z");
  const good = await b.run("ingestTransfereeAck", AGENT, { batch_id: BATCH.id, kind: "D04", ack_reference: "ACK-D04b", as_of: "2026-11-30" }, "2026-12-02T14:00:00.000Z") as { status: string };
  assert.equal(good.status, "acked"); assert.deepEqual(b.status("FNMA_F1_11_TRIAL_BALANCE_T1"), ["satisfied"]);
  for (const k of ["D03", "D05"]) { await b.deliver(k, "2026-11-30", "2026-12-02T10:00:00.000Z"); await b.run("ingestTransfereeAck", AGENT, { batch_id: BATCH.id, kind: k, ack_reference: `ACK-${k}` }, "2026-12-02T15:00:00.000Z"); }
  assert.deepEqual(b.status("SM_XFER_OUT_FINAL_TAPE_1"), ["armed"]);   // D06 outstanding
  await b.deliver("D06", "2026-11-30", "2026-12-02T10:00:00.000Z"); const fin = await b.run("ingestTransfereeAck", AGENT, { batch_id: BATCH.id, kind: "D06", ack_reference: "ACK-D06" }, "2026-12-02T15:30:00.000Z") as { final_tape_set_complete: boolean };
  assert.equal(fin.final_tape_set_complete, true); assert.deepEqual(b.status("SM_XFER_OUT_FINAL_TAPE_1"), ["satisfied"]);
  await b.deliver("D28", "2026-11-30", "2026-12-03T10:00:00.000Z"); const idx = await b.run("ingestTransfereeAck", AGENT, { batch_id: BATCH.id, kind: "D28", ack_reference: "ACK-D28", index_count: 1200, document_count: 1201 }, "2026-12-03T15:00:00.000Z") as { status: string };
  assert.equal(idx.status, "exception"); assert.deepEqual(b.status("SM_XFER_OUT_IMAGES_5"), ["armed"]);
  // --- cutover: the post-T rows arm; D08 must cover every custodial account; the T+30 window and the disposition close the custodial rows; the 1.4 participation-notes code is armed on the outbound cutover fact
  b.events.append({ type: "transfer.batch.cutover_completed", aggregate: BATCH, actor: SYSTEM, payload: { direction: "out", transfer_date: "2026-12-01", mi: "MGIC", last_batch_for_partner: true }, occurredAt: "2026-12-01T15:00:00.000Z" });
  const pn = await b.run("planDeliverables", AGENT, { op: "cutover", batch_id: BATCH.id, transfer_date: "2026-12-01", participation_pool: 2 }, "2026-12-01T15:00:00.000Z") as { applies: boolean; due: string };
  assert.deepEqual([pn.applies, pn.due], [true, "2026-12-31"]); assert.deepEqual(b.timers.byCode("FNMA_F1_11_PARTICIPATION_NOTES_30").map((t) => [t.dueDate, t.status]), [["2026-12-31", "armed"]]);
  await b.run("ingestTransfereeAck", AGENT, { source: "custodian", batch_id: BATCH.id, item: { kind: "shipment_confirmed", on: "2026-12-10", manifest_id: "M-2", transferee_custodian_receipt_id: "R-2", participation_notes: true } }, "2026-12-10T15:00:00.000Z");
  assert.deepEqual(b.status("FNMA_F1_11_PARTICIPATION_NOTES_30"), ["satisfied"]);
  await b.deliver("D08", "2026-11-30", "2026-12-04T10:00:00.000Z");
  const partial = await b.run("ingestTransfereeAck", AGENT, { batch_id: BATCH.id, kind: "D08", ack_reference: "ACK-D08", custodial_accounts: ["C-PI", "C-TI"], accounts_acked: ["C-PI"] }, "2026-12-08T15:00:00.000Z") as { status: string; refusal: string };
  assert.equal(partial.status, "exception"); assert.match(partial.refusal, /missing C-TI/); assert.deepEqual(b.status("FNMA_F1_11_CUSTODIAL_RECON_5BD"), ["armed"]);
  await b.run("ingestTransfereeAck", AGENT, { op: "resolve", batch_id: BATCH.id, kind: "D08", resolution: "second account reconciled" }); await b.deliver("D08", "2026-11-30", "2026-12-08T10:00:00.000Z");
  await b.run("ingestTransfereeAck", AGENT, { batch_id: BATCH.id, kind: "D08", ack_reference: "ACK-D08b", custodial_accounts: ["C-PI", "C-TI"], accounts_acked: ["C-PI", "C-TI"], acked_at: "2026-12-08T16:00:00.000Z" }, "2026-12-08T16:00:00.000Z");
  assert.deepEqual(b.status("FNMA_F1_11_CUSTODIAL_RECON_5BD"), ["satisfied"]);
  const early = await b.run("runOutboundDqGate", AGENT, { op: "custodial_window", batch_id: BATCH.id, transfer_date: "2026-12-01", custodial_accounts: ["C-PI", "C-TI"], today: "2026-12-20" }) as { blocker: string | null };
  assert.match(early.blocker!, /window open until 2026-12-31/); assert.deepEqual(b.status("SM_XFER_OUT_CUSTODIAL_CLOSE_60"), []);
  const win = await b.run("runOutboundDqGate", AGENT, { op: "custodial_window", batch_id: BATCH.id, transfer_date: "2026-12-01", custodial_accounts: ["C-PI", "C-TI"], today: "2027-01-04" }, "2027-01-04T15:00:00.000Z") as { blocker: string | null; recon_acked_on: string };
  assert.equal(win.blocker, null); assert.equal(win.recon_acked_on, "2026-12-08"); assert.deepEqual(b.timers.byCode("SM_XFER_OUT_CUSTODIAL_CLOSE_60").map((t) => [t.dueDate, t.status]), [["2027-02-06", "armed"]]);
  const disp = await b.run("runOutboundDqGate", AGENT, { op: "custodial_disposition", batch_id: BATCH.id, account_id: "C-PI", recon_acked_on: "2026-12-08", population_fully_transferred: true, balance_cents: "0", forms_1013_1014_withdrawn: true, bank_closure_letter_document_id: "doc-close" }, "2027-01-20T15:00:00.000Z") as { outcome: string };
  assert.equal(disp.outcome, "closed"); assert.deepEqual(b.status("SM_XFER_OUT_CUSTODIAL_CLOSE_60"), ["satisfied"]);
  // --- shortage/surplus by T+30: the officer signs the zero-unresolved reconciliation; an adjustment request is the partner officer's
  assert.equal(await b.refused("runOutboundDqGate", AGENT, { op: "shortage_surplus", batch_id: BATCH.id, transfer_date: "2026-12-01", unresolved_cents: "0" }), "OFFICER_ATTESTATION");
  assert.equal(await b.refused("runOutboundDqGate", AGENT, { op: "shortage_surplus", batch_id: BATCH.id, transfer_date: "2026-12-01", unresolved_cents: "1250", request_adjustment: true, adjustment_request_document_id: "doc-adj" }), "PARTNER_CREDENTIALS");
  assert.deepEqual(shortageSurplusResolution({ transfer_date: T, unresolved_cents: 1_250n, adjustment_request_document_id: null, signed_by: { kind: "human", id: "u-officer", role: "officer" } }).outcome, null);
  const ss = await b.run("runOutboundDqGate", OFFICER, { op: "shortage_surplus", batch_id: BATCH.id, transfer_date: "2026-12-01", unresolved_cents: "0" }, "2026-12-15T15:00:00.000Z") as { outcome: string; due: string };
  assert.deepEqual([ss.outcome, ss.due], ["no_adjustment", "2026-12-31"]); assert.ok(b.types().includes("recon.final_period.no_adjustment")); assert.deepEqual(b.status("FNMA_F1_11_SHORTAGE_SURPLUS_ADJ_30"), ["satisfied"]);
  // --- MERS post-transfer snapshot (T+3 BD), the bureaus' final cycle (status 05, date closed = T) and its acceptance, MGIC's acknowledgment, the day-91 sweep, the archive manifests
  await b.run("verifyMersSnapshot", AGENT, { batch_id: BATCH.id, transfer_date: "2026-12-01", snapshot_on: "2026-12-04", snapshot: mins.map((m) => ({ min: m.min, subservicer_org_id: "1004567" })) }, "2026-12-04T15:00:00.000Z"); assert.deepEqual(b.status("SM_MERS_POST_TRANSFER_VERIFY_3"), ["satisfied"]);
  await assert.rejects(b.run("notifyCounterparty", AGENT, { batch_id: BATCH.id, party_type: "credit_bureau", party_id: "equifax", transfer_date: "2026-12-01", notice: { account_status: "11", date_closed: "2026-12-01" } }), /account_status must be 05/);
  for (const bureau of ["equifax", "experian"]) await b.run("notifyCounterparty", AGENT, { batch_id: BATCH.id, party_type: "credit_bureau", party_id: bureau, transfer_date: "2026-12-01", notice: { account_status: "05", date_closed: "2026-12-01" } }, "2027-01-04T15:00:00.000Z");
  await b.run("notifyCounterparty", AGENT, { op: "ack", batch_id: BATCH.id, party_type: "credit_bureau", party_id: "equifax", transfer_date: "2026-12-01", notice: { account_status: "05", date_closed: "2026-12-01" } }, "2027-01-05T15:00:00.000Z"); assert.deepEqual(b.status("SM_XFER_OUT_CREDIT_FINAL_CYCLE"), ["armed"]);
  await b.run("notifyCounterparty", AGENT, { op: "ack", batch_id: BATCH.id, party_type: "credit_bureau", party_id: "experian", transfer_date: "2026-12-01", notice: { account_status: "05", date_closed: "2026-12-01" } }, "2027-01-05T16:00:00.000Z"); assert.deepEqual(b.status("SM_XFER_OUT_CREDIT_FINAL_CYCLE"), ["satisfied"]);
  assert.deepEqual(finalCycleNoticeCheck({ account_status: "05", date_closed: "2026-12-02" }, T).problems.length, 1);
  await b.run("notifyCounterparty", AGENT, { op: "ack", batch_id: BATCH.id, party_type: "mi", party_id: "MGIC", transfer_date: "2026-12-01" }, "2026-12-10T15:00:00.000Z"); assert.deepEqual(b.status("MI_MGIC_TRANSFER_NOTICE_60"), ["satisfied"]);
  assert.equal(b.timers.byCode("SM_XFER_OUT_SUPPORT_WINDOW_90")[0]!.note, "evaluator:17.3.supportWindowOpen");   // a window gate, never event-satisfied (the engine re-arms a recurring row on satisfaction)
  const open = await b.run("answerTransfereeRequest", AGENT, { op: "window", batch_id: BATCH.id, transfer_date: "2026-12-01", today: "2027-03-01" }) as { open: boolean; request_sla_business_days: number }; assert.deepEqual([open.open, open.request_sla_business_days], [true, 5]); assert.ok(!b.types().includes("transfer.support_window.expired"));
  const shut = await b.run("answerTransfereeRequest", AGENT, { op: "window", batch_id: BATCH.id, transfer_date: "2026-12-01", today: "2027-03-02" }, "2027-03-02T15:00:00.000Z") as { open: boolean; forwarding: string; request_sla_business_days: number }; assert.deepEqual([shut.open, shut.forwarding, shut.request_sla_business_days], [false, "on_receipt", 10]); assert.ok(b.types().includes("transfer.support_window.expired"));
  assert.equal(evaluateGate("17.3.supportWindowOpen", { today: "2027-03-02", transfer_date: "2026-12-01" }).open, false);
  const rq = await b.run("answerTransfereeRequest", AGENT, { op: "receive", batch_id: BATCH.id, request_id: "TR-9", received_on: "2026-12-10", transfer_date: "2026-12-01", kind: "missing_document" }, "2026-12-10T15:00:00.000Z") as { due: string };
  assert.equal(rq.due, "2026-12-17"); assert.deepEqual(b.timers.byCode("SM_XFER_OUT_TRANSFEREE_REQUEST_5BD").map((t) => [t.dueDate, t.status]), [["2026-12-17", "armed"]]);
  await b.run("answerTransfereeRequest", AGENT, { batch_id: BATCH.id, request_id: "TR-9", received_on: "2026-12-10", transfer_date: "2026-12-01", kind: "missing_document", document: { id: "doc-mod", sha256: "9f2c4d1e" }, responded_on: "2026-12-17" }, "2026-12-17T15:00:00.000Z");
  assert.deepEqual(b.status("SM_XFER_OUT_TRANSFEREE_REQUEST_5BD"), ["satisfied"]); assert.equal(b.rt.store.get("transferee_requests", "TR-9")!.data.response_document_id, "doc-mod");
  const arch = await b.run("buildDebrief", AGENT, { op: "archive", batch_id: BATCH.id, transfer_date: "2026-12-01", d31_acked_on: "2026-12-31", listed_loans: ["L1", "L2"], archives: [{ loan_id: "L1", archive_manifest_document_id: "m1" }, { loan_id: "L2", archive_manifest_document_id: "m2" }] }, "2027-01-05T15:00:00.000Z") as { complete: boolean; retain_until: string };
  assert.deepEqual([arch.complete, arch.retain_until], [true, "2033-12-01"]); assert.ok(b.types().includes("transfer.archive.written")); assert.equal(b.rt.store.get("transfer_out_archives", "L1")!.data.retention, "transfer_out_archive");
  // --- the Form 2009 hand-off and the recert exception: executing an instrument is the signing officer's act; the custodian's exception notice runs the 10-BD row
  const releases = [{ loan_id: "L-fc", opened_on: "2026-10-15", liquidation: false, executed_form2009_document_id: null }];
  const unsigned = await b.run("ingestTransfereeAck", AGENT, { source: "custodian", batch_id: BATCH.id, transfer_date: "2026-12-01", releases, item: { kind: "form2009_handed_off", on: "2026-11-30" } }) as { signing_officer_required: string[] };
  assert.deepEqual(unsigned.signing_officer_required, ["L-fc"]); assert.deepEqual(b.status("SM_XFER_OUT_FORM2009_HANDOFF_T0"), ["armed"]);
  assert.equal(await b.refused("ingestTransfereeAck", AGENT, { source: "custodian", batch_id: BATCH.id, transfer_date: "2026-12-01", releases, execute: true, instrument: "form2009", item: { kind: "form2009_handed_off", on: "2026-11-30", executed_document_id: "doc-2009" } }), "SIGNING_OFFICER_INSTRUMENT");
  await b.run("ingestTransfereeAck", SIGNER, { source: "custodian", batch_id: BATCH.id, transfer_date: "2026-12-01", releases, execute: true, instrument: "form2009", item: { kind: "form2009_handed_off", on: "2026-11-30", executed_document_id: "doc-2009" } }, "2026-11-30T20:00:00.000Z");
  assert.deepEqual(b.status("SM_XFER_OUT_FORM2009_HANDOFF_T0"), ["satisfied"]);
  await b.run("ingestTransfereeAck", AGENT, { source: "custodian", batch_id: BATCH.id, item: { kind: "exception_received", on: "2026-12-10", exceptions: [{ fnma_loan_number: "1", kind: "missing_allonge" }] } }, "2026-12-10T15:00:00.000Z");
  assert.deepEqual(b.timers.byCode("SM_XFER_OUT_RECERT_EXCEPTION_RESPONSE_10").map((t) => [t.dueDate, t.status]), [["2026-12-24", "armed"]]);
  assert.equal(await b.refused("ingestTransfereeAck", AGENT, { source: "custodian", batch_id: BATCH.id, execute: true, instrument: "allonge", item: { kind: "exception_resolved", on: "2026-12-15", outcome: "cured" } }), "SIGNING_OFFICER_INSTRUMENT");
  await b.run("ingestTransfereeAck", SIGNER, { source: "custodian", batch_id: BATCH.id, execute: true, instrument: "allonge", item: { kind: "exception_resolved", on: "2026-12-15", outcome: "cured", document_id: "doc-allonge" } }, "2026-12-15T15:00:00.000Z");
  assert.deepEqual(b.status("SM_XFER_OUT_RECERT_EXCEPTION_RESPONSE_10"), ["satisfied"]);
  // --- the last batch's final draft clears Dec 21 → the CBAM LOA cancellation portal task (T14 date) opens and the row arms on the clearing date
  const loa = await b.run("runOutboundDqGate", AGENT, { op: "final_draft_cleared", batch_id: BATCH.id, cleared_on: "2026-12-21", last_batch_for_partner: true, form_496_final: true }, "2026-12-22T15:00:00.000Z") as { due: string };
  assert.equal(loa.due, "2027-01-06"); assert.deepEqual(b.timers.byCode("SM_XFER_OUT_CUSTODIAL_ACCOUNT_CLOSE").map((t) => [t.dueDate, t.status]), [["2027-01-06", "armed"]]);
  // the stored rows carry the DDL's columns only (0019_transfers.sql): no derived group / name / mapping_set / hash columns
  assert.ok(b.rt.store.list("counterparty_notifications").every((r) => !("group" in r.data))); assert.ok(b.rt.store.list("transfer_out_deliverables").every((r) => !("name" in r.data) && !("mapping_set" in r.data)));
  assert.ok(!("response_document_hash" in b.rt.store.get("transferee_requests", "TR-9")!.data));
});
