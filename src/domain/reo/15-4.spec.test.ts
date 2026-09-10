// 15.4 Delinquency advance reimbursement (Form 4828)
// spec/sections/15-reo-claims-expense-reimbursement/15-4-delinquency-advance-reimbursement-form-4828.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { cents } from "../../kernel/money/cents.ts";
import { loadRegistry, TimerEngine } from "../../kernel/timers/index.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_15_4 } from "../../app/tools/section15-4.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { scheduleForward } from "../investor/remittance.ts";
import { advanceSpecialRemittance } from "../payoff/ops-16-2.ts";
import { expectedRecovery, matchReimbursement, outstanding, saRecoveryLar, mbsRemovalGate, unrecoveredEscalationDue, duplicateCreditNoticeDue, MATCH_TOLERANCE, type Advance } from "./advances.ts";
import { validateLine, type ClaimLine, type ClaimContext } from "./claims.ts";
import { sweepClaimCandidates } from "./ops-15-2.ts";
import { shadowClaimItemized } from "./ops-15-3.ts";
import { EVALUATORS_15_4 } from "./evaluators-15-4.ts";
import { applySatisfiedOverrides_15_4 } from "./timers-15-4.ts";
import { reclassReimbursement, payoffAdvanceRecovery, rescissionReversal, recoveryExpectation, advancePosition, advancesFundedDuringSda, saLiquidationInterestExpectation, saMonth4Recovery, parseCashAdjustmentLines, applyReimbursementLine, liquidationReimbursement, deferralReimbursement, entryLines, irrPackage, agingReport, duplicateCredit, writeOffDecision, piAdvanceLeaks, salePackageReleaseGate, outstandingCents, sdaExit, sdaStatusFromEvents, positionSweepTick, liquidationProcessed, saleScheduled, type AdvanceRow, type RecoveryRow } from "./ops-15-4.ts";

// Fixture L15 (rule 7): S/S MBS special servicing, PTR 6.00%, scheduled P&I drafted Jan 18, Feb 18, Mar 18 and Fri Apr 16, 2027.
const ADV: AdvanceRow[] = [
  { id: "a1", activity_period: "2027-01", amount_cents: cents("1476.00"), status: "outstanding", kind: "delinquency_pi", drafted_at: D("2027-01-18"), funded_from: "partner_advance_line" },
  { id: "a2", activity_period: "2027-02", amount_cents: cents("1476.10"), status: "outstanding", kind: "delinquency_pi", drafted_at: D("2027-02-18"), funded_from: "partner_advance_line" },
  { id: "a3", activity_period: "2027-03", amount_cents: cents("1476.19"), status: "outstanding", kind: "delinquency_pi", drafted_at: D("2027-03-18"), funded_from: "partner_advance_line" },
  { id: "a4", activity_period: "2027-04", amount_cents: cents("1476.29"), status: "outstanding", kind: "delinquency_pi", drafted_at: D("2027-04-16"), funded_from: "partner_advance_line" },
];
const REIMBURSED = ADV.map((a) => ({ ...a, status: "reimbursed_by_fnma" as const }));
// LAR 72 (MI-insured, Fannie Mae acquiring) submitted Tue Oct 5, accepted Wed Oct 6, 2027 (5.3)
const LAR72 = { id: "LAR-72-L15", ack_id: "ACK-L15-72", action_code: "72" as const };
const CTX_571: ClaimContext = { event_date: D("2027-10-05"), state: "TX", attorney_fee_exhibit_cents: cents("2300"), servicing_option: "special", preservation_cap_cents: cents("1000") };
const LINES_571: ClaimLine[] = [{ kind: "taxes", unit_cents: cents("4820"), quantity: 1, paid_on: D("2027-01-31"), invoice: true }, { kind: "hazard", unit_cents: cents("1450"), quantity: 1, paid_on: D("2027-03-15"), invoice: true }];
const octoberLine = (amount: bigint) => parseCashAdjustmentLines({ report_id: "RDCA-2027-10", activity_period: "2027-10", lines: [{ row: 12, loan_id: "L15", description: "S/S Delinquency Advance Reimbursement", amount_cents: amount }] })[0]!;
const ADV_IDS = ADV.map((a) => a.id);

// Tool harness: the 15.4 tools on the bus for `custodial-recon`, the overridden registry armed for 15.4 and the 5.3/5.4 rows its timer table reuses
// (FNMA_IRM_LIQ_AC70_72_NEXTBD_2000, FNMA_F120_SDA_FUNDING_HOLD, SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES), an in-memory ledger and escalation service —
// so a test can prove what each step emits, arms, satisfies, posts and escalates.
const RECON: Actor = { kind: "agent", id: "custodial-recon" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
type Out = Record<string, any>;
function harness(nowIso: string, loanId = "L15") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const reg = loadOverriddenRegistry(); const engine = new TimerEngine(reg, events, { processes: ["15.4", "5.3", "5.4"] });
  const ctx: UowContext = { loanId, events, ledger: new MemoryLedger(), timers: engine, clock, decide: () => {} };
  const escalations = new EscalationService(events, clock);
  const rt: ToolRuntime = { store: new EntityStore(), ports: {}, escalations, services: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_15_4); const bus = new CommandBus(agents);
  const run = async (tool: string, input: Record<string, unknown>, actor: Actor = RECON): Promise<Out> => (await bus.execute(cmds.get(toolKey("15.4", tool))!, actor, input, ctx)).output as Out;
  const timer = (code: string) => engine.byCode(code);
  const last = (code: string) => { const t = timer(code).at(-1); assert.ok(t, `${code} was never armed`); return t; };
  const ev = (type: string) => events.ofType(type);
  const def = (code: string) => { const d = reg.get(code); assert.ok(d, `no timer ${code}`); return d; };
  const refused = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: unknown) => e instanceof CommandRefused && e.code === code); };
  return { clock, events, engine, ctx, rt, escalations, run, timer, last, ev, def, refused };
}
type H = ReturnType<typeof harness>;
// 5.4 sets Stop Advance from Fannie Mae's data (BD2 of May 2027; start date May 1, 2027): `sda_status.active` arms FNMA_F120_SDA_FUNDING_HOLD
const stopAdvance = (h: H, startDate = "2027-05-01") => h.events.append({ type: "sda_status.active", loanId: "L15", actor: RECON, payload: { start_date: startDate, fnma_status: "stop_advance", set_on: "2027-05-04" } });
/**
 * The rule-7 liquidation on the bus: the sale held Tue Oct 5, 2027 (liquidation processed — the 5.3 LAR clock arms, "reimbursement cannot trigger"),
 * the LAR 72 submitted by 5.3 that evening (the clock is satisfied), accepted Wed Oct 6 (the exit: expectation set, Stop Advance exited, the
 * two-cycle and 60-day clocks armed).
 */
async function liquidationOnBus(): Promise<H> {
  const h = harness("2027-10-05T20:30:00.000Z");   // Tue Oct 5, 2027 16:30 ET
  stopAdvance(h);
  assert.equal(h.last("FNMA_F120_SDA_FUNDING_HOLD").status, "armed", "5.4: the funding hold arms on sda_status.active");
  const lp = await h.run("setRecoveryExpectation", { loan_id: "L15", event: "liquidation_lar", stage: "processed", fact_id: "LF-L15-1", processed_at: "2027-10-05T20:30:00.000Z", action_code: "72", sale_date: "2027-10-05", mi_insured: true, advances: ADV });
  assert.equal(lp.reimbursement_can_trigger, false); assert.equal(lp.pending_expected_recovery_event, "liquidation_lar"); assert.equal(lp.data_error, null); assert.equal(lp.advances_outstanding_cents, 590458n); assert.equal(lp.escalation_id, null);
  // FNMA_IRM_LIQ_AC70_72_NEXTBD_2000 (5.3): processed Tue Oct 5 (BD3 of October) → LAR by Wed Oct 6, 2027 20:00 ET
  const larDue = zonedEpochMs(D("2027-10-06"), "20:00", "America/New_York");
  assert.equal(lp.lar_due_date, "2027-10-06"); assert.equal(lp.lar_due_at_ms, larDue); assert.equal(lp.timer, "FNMA_IRM_LIQ_AC70_72_NEXTBD_2000");
  const fact = h.ev("liquidation_facts.processed")[0]!;
  assert.equal(fact.payload.processed_at, "2027-10-05T20:30:00.000Z"); assert.equal(fact.payload.event_type, "removal.liquidation.insured"); assert.equal(fact.payload.reimbursement_can_trigger, false);
  assert.ok(eventMatches(h.def("FNMA_IRM_LIQ_AC70_72_NEXTBD_2000").triggerPattern!, fact));
  const larClock = h.last("FNMA_IRM_LIQ_AC70_72_NEXTBD_2000");
  assert.equal(larClock.status, "armed"); assert.equal(larClock.anchorDate, "2027-10-05"); assert.equal(larClock.dueDate, "2027-10-06"); assert.equal(larClock.dueAt, larDue);
  assert.equal(h.ev("advance_position.expectation_set").length, 0, "no expectation until the LAR is accepted"); assert.equal(h.timer("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES").length, 0);
  // 5.3 submits the LAR 72 that evening → the 5.3 clock is satisfied
  h.clock.set("2027-10-05T22:00:00.000Z");
  const submitted = h.events.append({ type: "investor_events.submitted", loanId: "L15", actor: { kind: "agent", id: "investor-reporting" }, payload: { event_id: "IE-L15-72", event_type: "removal.liquidation.insured", family: "removal", status: "submitted", action_code: "72", submitted_at: "2027-10-05T22:00:00.000Z" } });
  assert.ok(eventMatches(h.def("FNMA_IRM_LIQ_AC70_72_NEXTBD_2000").satisfiedPattern!, submitted)); assert.equal(larClock.status, "satisfied");
  // Wed Oct 6: the LAR accepted → the expectation (two cycles, Dec 17), the 60-day clock, and the Stop Advance exit (status from the loan's own history)
  h.clock.set("2027-10-06T18:00:00.000Z");
  const acc = await h.run("setRecoveryExpectation", { loan_id: "L15", event: "liquidation_lar", accepted_on: "2027-10-06", advances: ADV });
  assert.equal(acc.expected_recovery_event, "liquidation_lar"); assert.equal(acc.expected_by, "2027-12-17"); assert.equal(acc.expected_cents, 590458n); assert.deepEqual(acc.sda_exit, { status: "exited", reason: "liquidation", exited_on: "2027-10-06" });
  const exited = h.ev("sda_status.exited")[0]!;
  assert.deepEqual(exited.payload, { reason: "liquidation", exited_on: "2027-10-06", expected_recovery_event: "liquidation_lar", advances_outstanding: true, advances_outstanding_cents: 590458n, fnma_reimburses: true });
  assert.equal(h.last("FNMA_F120_SDA_FUNDING_HOLD").status, "satisfied", "the funding hold lifts on the exit");
  assert.ok(eventMatches(h.def("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES").triggerPattern!, exited));
  const cycles = h.last("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES");
  assert.equal(cycles.status, "armed"); assert.equal(cycles.anchorDate, "2027-10-06"); assert.equal(cycles.dueDate, "2027-12-17", "two S/S draft cycles: Dec 18, 2027 is a Saturday → Fri Dec 17 (the spec's expected_by)");
  const sixty = h.last("SM_DELADV_UNRECOVERED_60"); assert.equal(sixty.status, "armed"); assert.equal(sixty.anchorDate, "2027-10-06"); assert.equal(sixty.dueDate, "2027-12-05");
  return h;
}

test("15.4-T1: Given fixture L15 with four advances totalling $5,904.58 and LAR 72 accepted Oct 6, 2027, then `expected_recovery_event = liquidation_lar`, `expected_by` = Dec 17, 2027, and no 571 or MI-claim line contains any `delinquency_pi` advance.", async () => {
  assert.equal(outstandingCents(ADV), cents("5904.58"));
  const liq = liquidationReimbursement({ accepted_on: D("2027-10-06"), lar: LAR72, advances: ADV, line: null, today: D("2027-10-07") });
  // rule 3: Fannie Mae reimburses the full outstanding within two S/S draft cycles — Nov 18 and Fri Dec 17, 2027 (Dec 18 is a Saturday)
  assert.equal(liq.expectation.expected_recovery_event, "liquidation_lar"); assert.equal(liq.expectation.expected_by, "2027-12-17");
  assert.deepEqual(liq.expectation.cycles, [D("2027-11-18"), D("2027-12-17")]);
  assert.equal(liq.expectation.expected_cents, cents("5904.58")); assert.equal(liq.expectation.fnma_reimburses, true); assert.equal(liq.expectation.source, "fnma_liquidation_reimb"); assert.equal(liq.expectation.timer, "SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES");
  assert.equal(liq.expectation.data_error, null); assert.equal(liq.irr_package, null); assert.deepEqual(liq.sda_exit, { status: "exited", reason: "liquidation", exited_on: D("2027-10-06") });
  assert.deepEqual(expectedRecovery("liquidation_lar", D("2027-10-06")), { expected_by: D("2027-12-17"), cycles: [D("2027-11-18"), D("2027-12-17")] });
  const pos = advancePosition({ loan_id: "L15", as_of: D("2027-10-07"), remittance_type: "SS", servicing_option: "special", sda_status: "exited", advances: ADV, fnma_sda_receivable_cents: cents("8860.00"), expected_recovery_event: liq.expectation.expected_recovery_event, expected_by: liq.expectation.expected_by });
  assert.equal(pos.status, "recovery_expected"); assert.equal(pos.expected_recovery_event, "liquidation_lar"); assert.equal(pos.expected_by, "2027-12-17"); assert.equal(pos.servicer_pi_advances_outstanding_cents, cents("5904.58"));
  // rule 5: nothing about the $5,904.58 goes on the 571 (15.2) or the MI claim (15.3 — note-rate interest and expenses, not investor advances)
  const mi = shadowClaimItemized({ upb_cents: cents("249088.61"), note_rate_pct: "6.500", interest_paid_to: D("2026-11-01"), anchor: D("2027-10-05"), default_date: D("2026-12-01"), advances: [{ advance_id: "adv-tax-2026", kind: "taxes", amount_cents: cents("4820") }, { advance_id: "adv-hazard", kind: "hazard_premium", amount_cents: cents("1450") }], credits_cents: 0n, coverage_pct: "25" });
  assert.ok(mi.lines.every((l) => !ADV.some((a) => a.id === l.advance_id)));
  const leaks = piAdvanceLeaks({ advances: ADV, claim_571_lines: LINES_571, claim_context: CTX_571, mi_claim_advances: mi.lines });
  assert.equal(leaks.clean, true); assert.equal(leaks.claim_571.accepted, 2); assert.deepEqual(leaks.claim_571.rejected, []); assert.equal(leaks.mi_claim.accepted, 2); assert.deepEqual(leaks.mi_claim.leaks, []);
  // a `delinquency_pi` advance smuggled into either claim is caught: the 15.2 validator rejects the line, the MI-claim advance is flagged
  const dirty = piAdvanceLeaks({ advances: ADV, claim_571_lines: [...LINES_571, { kind: "delinquency_pi", unit_cents: cents("1476.00"), quantity: 1, paid_on: D("2027-01-18"), invoice: true }], claim_context: CTX_571, mi_claim_advances: [...mi.lines, { advance_id: "a1", kind: "other", amount_cents: cents("1476.00") }] });
  assert.equal(dirty.clean, false); assert.deepEqual(dirty.claim_571.rejected, [{ index: 2, kind: "delinquency_pi", reason: "pi_advances_not_claimable" }]); assert.deepEqual(dirty.mi_claim.leaks, [{ advance_id: "a1", reason: "pi_advances_not_claimable" }]);
  assert.equal(dirty.rule, "15.4 rule 5");
  // ---- on the bus: the 5.3 LAR clock, the accepted LAR 72, the Stop Advance exit and the expectation clocks ----
  const h = await liquidationOnBus();
  const set = h.ev("advance_position.expectation_set")[0]!;
  assert.equal(set.payload.expected_recovery_event, "liquidation_lar"); assert.equal(set.payload.expected_by, "2027-12-17"); assert.equal(set.payload.accepted_on, "2027-10-06"); assert.equal(set.payload.advances_outstanding, true);
  assert.ok(eventMatches(h.def("SM_DELADV_UNRECOVERED_60").triggerPattern!, set));
  // the pure reading of the same steps: the processed fact and the exit
  const lp = liquidationProcessed({ fact_id: "LF-L15-1", processed_at: "2027-10-05T20:30:00.000Z", action_code: "72", sale_date: D("2027-10-05"), mi_insured: true, remittance_type: "SS", servicing_option: "special", advances: ADV });
  assert.equal(lp.event, "liquidation_facts.processed"); assert.equal(lp.lar_due_at, "2027-10-07T00:00:00.000Z"); assert.equal(lp.payload.lar_due_at, "2027-10-07T00:00:00.000Z");
  assert.throws(() => liquidationProcessed({ ...lp.payload, fact_id: "x", action_code: "60", advances: ADV }), RangeError);
  assert.deepEqual(sdaExit("liquidation_lar", "active", D("2027-10-06")), { status: "exited", reason: "liquidation", exited_on: D("2027-10-06") }); assert.equal(sdaExit("liquidation_lar", "not_applicable", D("2027-10-06")), null); assert.equal(sdaExit("pre_fcl_removal", "active", D("2027-10-06")), null);
  assert.deepEqual(sdaStatusFromEvents(h.events.byLoan("L15")), { status: "exited", start_date: null });
  // a zero expectation on an S/S special liquidation is a data error: the processed fact opens the sev-2 escalation
  const zero = await h.run("setRecoveryExpectation", { loan_id: "L16", event: "liquidation_lar", stage: "processed", fact_id: "LF-L16-1", processed_at: "2027-10-05T20:30:00.000Z", action_code: "70", advances: [] });
  assert.equal(zero.data_error, "zero_expectation_on_ss_special_liquidation"); assert.equal(h.escalations.opened.find((e) => e.id === zero.escalation_id)!.severity, "sev2");
});
test("15.4-T2: Given the November Cash Adjustments report shows a $5,904.58 delinquency-advance reimbursement, then four `advances` rows move to `reimbursed_by_fnma` (FIFO), the ledger posts Dr `custodial_pi_cash`/Cr `servicer_advance_receivable` $5,904.58, and the corporate transfer is scheduled.", async () => {
  // the Cash Adjustments report for the October activity period is available at the early-November BD3 notification (Wed Nov 3, 2027)
  const adj = octoberLine(cents("5904.58"));
  assert.equal(adj.type, "delinquency_advance_reimbursement"); assert.equal(adj.amount_cents, 590458n);
  const liq = liquidationReimbursement({ accepted_on: D("2027-10-06"), lar: LAR72, advances: ADV, line: { report_line_ref: adj.report_line_ref, amount_cents: adj.amount_cents, report_date: D("2027-11-03") }, today: D("2027-11-03") });
  const r = liq.applied!;
  assert.equal(r.status, "matched"); assert.deepEqual(r.match.matched, ["a1", "a2", "a3", "a4"]); assert.equal(r.match.matched_cents, cents("5904.58")); assert.equal(r.variance_cents, 0n);
  assert.deepEqual(r.advances_after.map((a) => [a.id, a.status]), [["a1", "reimbursed_by_fnma"], ["a2", "reimbursed_by_fnma"], ["a3", "reimbursed_by_fnma"], ["a4", "reimbursed_by_fnma"]]);
  assert.deepEqual(r.recoveries.map((x) => [x.advance_id, x.source, x.amount_cents, x.recovered_at, x.report_line_ref]), [["a1", "fnma_liquidation_reimb", 147600n, "2027-11-03", adj.report_line_ref], ["a2", "fnma_liquidation_reimb", 147610n, "2027-11-03", adj.report_line_ref], ["a3", "fnma_liquidation_reimb", 147619n, "2027-11-03", adj.report_line_ref], ["a4", "fnma_liquidation_reimb", 147629n, "2027-11-03", adj.report_line_ref]]);
  // rule 4 ledger, then the corporate transfer that returns the funds to the partner's advance line
  assert.deepEqual(r.ledger!.lines, [{ account: "custodial_pi_cash", side: "Dr", amount_cents: cents("5904.58") }, { account: "servicer_advance_receivable", side: "Cr", amount_cents: cents("5904.58") }]);
  assert.equal(r.ledger!.rule_ref, "15.4 rule 4"); assert.deepEqual(r.ledger!.corporate_transfer, { scheduled: true, amount_cents: cents("5904.58"), from: "custodial_pi_cash", to: "partner_advance_line" });
  // the same lines on the kernel chart (what postRecoveryEntries posts): balanced, the receivable named
  const lines = entryLines(r.ledger!.lines, "C-PI", r.ledger!.rule_ref);
  assert.equal(lines.reduce((s, l) => s + l.amountCents, 0n), 0n); assert.deepEqual(lines[0]!.account, { scope: "custodial", custodialAccountId: "C-PI", account: "custodial_pi_cash" }); assert.equal(lines[0]!.amountCents, 590458n);
  assert.deepEqual(lines[1]!.account, { scope: "corporate", account: "advance_receivable" }); assert.equal(lines[1]!.amountCents, -590458n); assert.equal(lines[1]!.memo, "servicer_advance_receivable");
  assert.equal(r.remaining_outstanding_cents, 0n); assert.equal(r.position_closed, true);
  assert.deepEqual(liq.timers.SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES, { due: D("2027-12-17"), satisfied: true }); assert.equal(liq.timers.SM_DELADV_UNRECOVERED_60.satisfied, true); assert.equal(liq.irr_package, null);
  const pos = advancePosition({ loan_id: "L15", as_of: D("2027-11-04"), remittance_type: "SS", servicing_option: "special", sda_status: "exited", advances: r.advances_after, fnma_sda_receivable_cents: 0n, matched_cents: r.match.matched_cents });
  assert.equal(pos.status, "closed"); assert.equal(pos.servicer_pi_advances_outstanding_cents, 0n); assert.equal(pos.matched_cents, cents("5904.58"));
  // a credit 5¢ short still matches every row (tolerance $0.05 per line) but Fannie Mae's amount is never recomputed (rule 9): cash is debited for the
  // $5,904.53 credited, the 5¢ stays in the receivable on the last row (never rounded into cash), and the corporate transfer returns what came in
  const short5 = applyReimbursementLine({ line: { report_line_ref: "RDCA-2027-10#13:x", amount_cents: cents("5904.58") - 5n }, advances: ADV, source: "fnma_liquidation_reimb", recovered_at: D("2027-11-03") });
  assert.equal(short5.status, "matched"); assert.equal(short5.residual_cents, 5n); assert.equal(short5.excess_cents, 0n); assert.ok(short5.advances_after.every((a) => a.status === "reimbursed_by_fnma"));
  assert.deepEqual(short5.ledger!.lines, [{ account: "custodial_pi_cash", side: "Dr", amount_cents: 590453n }, { account: "servicer_advance_receivable", side: "Cr", amount_cents: 590453n }]);
  assert.equal(short5.recoveries.reduce((s, x) => s + x.amount_cents, 0n), 590453n); assert.equal(short5.recoveries[3]!.amount_cents, 147624n); assert.equal(short5.recoveries[3]!.tolerance_cents, 5n); assert.equal(short5.recoveries[0]!.tolerance_cents, undefined);
  assert.equal(short5.ledger!.corporate_transfer.amount_cents, 590453n); assert.equal(short5.ledger!.received_cents, 590453n);
  // a credit 5¢ over books the excess as a payable to Fannie Mae — never kept
  const over5 = applyReimbursementLine({ line: { report_line_ref: "RDCA-2027-10#14:x", amount_cents: cents("5904.58") + 5n }, advances: ADV, source: "fnma_liquidation_reimb", recovered_at: D("2027-11-03") });
  assert.equal(over5.status, "matched"); assert.equal(over5.excess_cents, 5n); assert.equal(over5.residual_cents, 0n);
  assert.deepEqual(over5.ledger!.lines, [{ account: "custodial_pi_cash", side: "Dr", amount_cents: 590463n }, { account: "servicer_advance_receivable", side: "Cr", amount_cents: 590458n }, { account: "fnma_payable", side: "Cr", amount_cents: 5n }]);
  assert.equal(entryLines(over5.ledger!.lines, "C-PI", "15.4 rule 4").reduce((s, l) => s + l.amountCents, 0n), 0n);
  // ---- on the bus: the credit booked → ledger, corporate transfer, statuses, `advances.reimbursed_by_fnma{all_outstanding}` satisfies the two-cycle clock, the close satisfies the 60-day clock ----
  const h = await liquidationOnBus();
  h.clock.set("2027-11-03T15:00:00.000Z");
  const posted = await h.run("postRecoveryEntries", { loan_id: "L15", source: "fnma_liquidation_reimb", amount_cents: 590458n, credit_cents: adj.amount_cents, effective_date: "2027-11-03", report_line_ref: adj.report_line_ref, advance_ids: ADV_IDS, advances: ADV });
  assert.equal(posted.status, "reimbursed_by_fnma"); assert.equal(posted.all_reimbursed_by_fnma, true); assert.equal(posted.position_closed, true); assert.equal(posted.remaining_outstanding_cents, 0n); assert.deepEqual(posted.ledger_detail, { received_cents: 590458n, residual_cents: 0n, excess_cents: 0n });
  const set = h.ctx.ledger.sets().at(-1)!;
  assert.deepEqual(set.lines.map((l) => [l.account, l.amountCents, l.ruleRef]), [[{ scope: "custodial", custodialAccountId: "C-PI", account: "custodial_pi_cash" }, 590458n, "15.4 rule 4"], [{ scope: "corporate", account: "advance_receivable" }, -590458n, "15.4 rule 4"]]);
  assert.deepEqual(h.ev("corporate_transfer.scheduled")[0]!.payload, { amount_cents: 590458n, from: "custodial_pi_cash", to: "partner_advance_line" });
  assert.deepEqual(h.ev("advances.status_changed").map((e) => [e.aggregate!.id, e.payload.status]), [["a1", "reimbursed_by_fnma"], ["a2", "reimbursed_by_fnma"], ["a3", "reimbursed_by_fnma"], ["a4", "reimbursed_by_fnma"]]);
  const all = h.ev("advances.reimbursed_by_fnma")[0]!;
  assert.deepEqual(all.payload, { all_outstanding: true, rows: 4, source: "fnma_liquidation_reimb", report_line_ref: adj.report_line_ref });
  assert.ok(eventMatches(h.def("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES").satisfiedPattern!, all));
  assert.equal(h.last("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES").status, "satisfied"); assert.equal(h.last("SM_DELADV_UNRECOVERED_60").status, "satisfied");
  assert.deepEqual(h.ev("advance_position.closed")[0]!.payload, { reason: "recovered", source: "fnma_liquidation_reimb" });
  // guardrail: no recovery without a report-line reference
  await h.refused(h.run("postRecoveryEntries", { loan_id: "L15", source: "fnma_liquidation_reimb", amount_cents: 590458n, effective_date: "2027-11-03", advance_ids: ADV_IDS }), "RECOVERY_NEEDS_REPORT_LINE");
});
test("15.4-T3: Given the report shows $4,428.29 instead, then `variance_cents = 147,629` (one advance), a package with LAR ids/acks and drafted amounts is prepared for the Investor Reporting Representative, and `SM_DELADV_UNRECOVERED_60` is due Feb 4, 2028.", async () => {
  const adj = octoberLine(cents("4428.29"));
  const liq = liquidationReimbursement({ accepted_on: D("2027-10-06"), lar: LAR72, advances: ADV, line: { report_line_ref: adj.report_line_ref, amount_cents: adj.amount_cents, report_date: D("2027-11-03") }, today: D("2027-11-03") });
  const r = liq.applied!;
  assert.equal(r.status, "variance"); assert.equal(r.variance_cents, 147_629n); assert.equal(liq.variance_cents, 147_629n); assert.deepEqual(r.match.matched, ["a1", "a2", "a3"]); assert.equal(r.match.matched_cents, cents("4428.29"));
  assert.deepEqual(r.advances_after.map((a) => a.status), ["reimbursed_by_fnma", "reimbursed_by_fnma", "reimbursed_by_fnma", "outstanding"]); assert.equal(r.remaining_outstanding_cents, 147_629n); assert.equal(r.position_closed, false);
  assert.equal(r.ledger!.lines[0]!.amount_cents, cents("4428.29"));
  // the package for the Investor Reporting Representative (IRT is not the venue): loan, activity periods with drafted amounts, LAR id/ack, the report line
  const pkg = liq.irr_package!;
  assert.equal(pkg.recipient, "investor_reporting_representative"); assert.equal(pkg.channel, "email_phone_f402"); assert.equal(pkg.irt_is_the_venue, false);
  assert.deepEqual(pkg.contents.lar, { id: "LAR-72-L15", ack_id: "ACK-L15-72", action_code: "72", accepted_on: D("2027-10-06") });
  assert.deepEqual(pkg.contents.activity_periods, [{ period: "2027-01", drafted_cents: 147600n, draft_id: "draft:2027-01-18" }, { period: "2027-02", drafted_cents: 147610n, draft_id: "draft:2027-02-18" }, { period: "2027-03", drafted_cents: 147619n, draft_id: "draft:2027-03-18" }, { period: "2027-04", drafted_cents: 147629n, draft_id: "draft:2027-04-16" }]);
  assert.equal(pkg.contents.drafted_total_cents, cents("5904.58")); assert.equal(pkg.contents.expected_cents, cents("5904.58")); assert.equal(pkg.contents.matched_cents, cents("4428.29")); assert.equal(pkg.contents.variance_cents, 147_629n); assert.equal(pkg.contents.variance_kind, "amount");
  assert.deepEqual(pkg.contents.report_lines, [adj.report_line_ref]); assert.equal(pkg.contents.exit_event, "liquidation_lar"); assert.equal(pkg.contents.expected_by, "2027-12-17");
  assert.equal(pkg.escalation.kind, "human_agent"); assert.equal(pkg.escalation.severity, "sev2"); assert.equal(pkg.partner_monthly_report, false);
  // SM_DELADV_UNRECOVERED_60 = exit event + 60 calendar days → Dec 5, 2027 (Oct 6 + 25 + 30 + 5). The spec's "Feb 4, 2028 (60 days after Oct 6)"
  // is not Oct 6 + 60; docs/AUDIT-NOTES.md (15.4 rule 7 / T3) keeps the registry reading.
  assert.equal(liq.timers.SM_DELADV_UNRECOVERED_60.due, "2027-12-05"); assert.equal(unrecoveredEscalationDue(D("2027-10-06")), "2027-12-05"); assert.equal(pkg.officer_due, "2027-12-05");
  assert.equal(liq.timers.SM_DELADV_UNRECOVERED_60.satisfied, false); assert.equal(liq.timers.SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES.satisfied, false);
  // unresolved past the 60 days → `officer` (write-off authority) + the partner's monthly report, the package still addressed to the IRR
  const late = liquidationReimbursement({ accepted_on: D("2027-10-06"), lar: LAR72, advances: ADV, line: { report_line_ref: adj.report_line_ref, amount_cents: adj.amount_cents, report_date: D("2027-11-03") }, today: D("2027-12-18") });
  assert.equal(late.irr_package!.escalation.kind, "officer"); assert.equal(late.irr_package!.escalation.severity, "sev1"); assert.equal(late.irr_package!.partner_monthly_report, true); assert.equal(late.irr_package!.recipient, "investor_reporting_representative");
  // the one advance can only be written off by the officer (above $500 → the officer's own decision task); the write-off satisfies the 60-day clock
  assert.equal(writeOffDecision({ amount_cents: 147_629n, approved_by_role: "custodial-recon", exit_on: D("2027-10-06"), today: D("2027-12-18"), advance_ids: ["a4"] }).allowed, false);
  const wo = writeOffDecision({ amount_cents: 147_629n, approved_by_role: "officer", exit_on: D("2027-10-06"), today: D("2027-12-18"), advance_ids: ["a4"] });
  assert.equal(wo.allowed, true); assert.equal(wo.officer_task, true); assert.equal(wo.timer_satisfied, "SM_DELADV_UNRECOVERED_60"); assert.equal(wo.recoveries[0]!.source, "write_off");
  // ---- on the bus: the short credit leaves one advance outstanding — nothing closes, both clocks run to breach, the officer's write-off closes them late ----
  const h = await liquidationOnBus();
  h.clock.set("2027-11-03T15:00:00.000Z");
  const posted = await h.run("postRecoveryEntries", { loan_id: "L15", source: "fnma_liquidation_reimb", amount_cents: 442829n, credit_cents: adj.amount_cents, effective_date: "2027-11-03", report_line_ref: adj.report_line_ref, advance_ids: ["a1", "a2", "a3"], advances: ADV });
  assert.equal(posted.remaining_outstanding_cents, 147_629n); assert.equal(posted.position_closed, false); assert.equal(posted.all_reimbursed_by_fnma, false);
  assert.equal(h.ev("advances.reimbursed_by_fnma").length, 0); assert.equal(h.ev("advance_position.closed").length, 0);
  assert.equal(h.last("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES").status, "armed"); assert.equal(h.last("SM_DELADV_UNRECOVERED_60").status, "armed");
  const irr = await h.run("buildIrrPackage", { loan_id: "L15", exit_event: "liquidation_lar", exit_on: "2027-10-06", today: "2027-11-03", activity_periods: pkg.contents.activity_periods, lar: pkg.contents.lar, report_lines: [adj.report_line_ref], expected_cents: 590458n, matched_cents: 442829n, variance_cents: 147629n, expected_by: "2027-12-17" });
  const esc = h.escalations.opened.find((e) => e.id === irr.escalation_id)!;
  assert.equal(esc.kind, "human_agent"); assert.equal(esc.severity, "sev2"); assert.equal(esc.payload.recipient, "investor_reporting_representative"); assert.equal(esc.payload.officer_due, "2027-12-05");
  // the Dec 17 cycle passes unmatched: SM_DELADV_UNRECOVERED_60 (sev-1 → officer, due Dec 5) and the two-cycle expectation (sev-2, due Dec 17) breach
  const breaches = h.engine.evaluate("2027-12-18T05:00:00.000Z").filter((b) => b.instance.code === "SM_DELADV_UNRECOVERED_60" || b.instance.code === "SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES");
  assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity, b.instance.dueDate, b.escalateTo.includes("officer")]).sort(), [["SM_DELADV_UNRECOVERED_60", 1, "2027-12-05", true], ["SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES", 2, "2027-12-17", false]]);
  // the write-off of the one advance: refused for the agent, booked by the officer, closing the position and the 60-day clock (late)
  h.clock.set("2028-02-04T15:00:00.000Z");
  const remaining = [...REIMBURSED.slice(0, 3), ADV[3]!];
  await h.refused(h.run("postRecoveryEntries", { loan_id: "L15", source: "write_off", amount_cents: 147629n, effective_date: "2028-02-04", exit_on: "2027-10-06", advance_ids: ["a4"], advances: remaining }), "WRITE_OFF_NEEDS_OFFICER");
  const written = await h.run("postRecoveryEntries", { loan_id: "L15", source: "write_off", amount_cents: 147629n, effective_date: "2028-02-04", exit_on: "2027-10-06", advance_ids: ["a4"], advances: remaining }, OFFICER);
  assert.equal(written.status, "written_off"); assert.equal(written.position_closed, true); assert.equal(written.ledger, null);
  assert.deepEqual(h.ev("advance_position.closed")[0]!.payload, { reason: "written_off", source: "write_off" });
  assert.equal(h.last("SM_DELADV_UNRECOVERED_60").status, "satisfied_late"); assert.equal(h.last("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES").status, "breached", "a write-off is not a Fannie Mae reimbursement");
  // the officer's figure is booked to the cent across the rows it covers (rule 9): 147,629¢ over two advances → 73,815 + 73,814
  assert.deepEqual(writeOffDecision({ amount_cents: 147_629n, approved_by_role: "officer", exit_on: D("2027-10-06"), today: D("2028-02-04"), advance_ids: ["a3", "a4"] }).recoveries.map((r) => r.amount_cents), [73_815n, 73_814n]);
});
test("15.4-T4: Given a payment deferral accepted Fri Mar 12, 2027 with three advances outstanding, then reimbursement of $4,428.29 is expected by Thu Mar 18, 2027 and matched on that cycle.", async () => {
  const three = ADV.slice(0, 3);
  const pending = deferralReimbursement({ accepted_on: D("2027-03-12"), advances: three, line: null, sda_status: "not_applicable" });
  // IRM p. 35: within 3–4 business days of acceptance → 4 `fannie_et` BD: Mon 15, Tue 16, Wed 17, Thu Mar 18, 2027 — the March S/S draft day
  assert.equal(pending.expectation.expected_recovery_event, "deferral_acceptance"); assert.equal(pending.expectation.expected_cents, cents("4428.29")); assert.equal(pending.expectation.expected_by, "2027-03-18");
  assert.equal(pending.expectation.timer, "FNMA_IRM_PD_ADV_REIMB_4BD"); assert.equal(pending.expectation.source, "fnma_deferral_reimb"); assert.equal(pending.expectation.fnma_reimburses, true);
  assert.deepEqual(pending.cycle, { activity_period: "2027-03", draft_date: D("2027-03-18"), bd3_notification: D("2027-03-03") });
  assert.equal(pending.matched_on_cycle, false); assert.deepEqual(pending.timer, { code: "FNMA_IRM_PD_ADV_REIMB_4BD", due: D("2027-03-18"), satisfied: false });
  // the credit rides the Loan-Level Draft Notification for the Thu Mar 18 S/S draft (March activity period; CRS 208 "S/S Cash DelMod/PD P&I Advance
  // Reimbursement" if it appears) — the March BD3 notification (Wed Mar 3) predates the Mar 12 acceptance, so only the draft-day notification can carry it
  const [adj] = parseCashAdjustmentLines({ report_id: "LLDN-2027-03-18", activity_period: "2027-03", lines: [{ row: 3, loan_id: "L15", description: "PD P&I Advance Reimbursement", amount_cents: cents("4428.29"), crs_code: "208" }] });
  assert.equal(adj!.type, "delinquency_advance_reimbursement"); assert.equal(adj!.crs_code, "208");
  const r = deferralReimbursement({ accepted_on: D("2027-03-12"), advances: three, line: { report_line_ref: adj!.report_line_ref, amount_cents: adj!.amount_cents, report_date: D("2027-03-18"), crs_code: adj!.crs_code }, sda_status: "not_applicable" });
  assert.equal(r.applied!.status, "matched"); assert.deepEqual(r.applied!.match.matched, ["a1", "a2", "a3"]); assert.equal(r.applied!.match.matched_cents, cents("4428.29")); assert.equal(r.applied!.variance_cents, 0n);
  assert.equal(r.matched_on_cycle, true); assert.deepEqual(r.timer, { code: "FNMA_IRM_PD_ADV_REIMB_4BD", due: D("2027-03-18"), satisfied: true });
  assert.deepEqual(r.applied!.recoveries.map((x) => [x.advance_id, x.source, x.amount_cents, x.recovered_at, x.crs_code]), [["a1", "fnma_deferral_reimb", 147600n, "2027-03-18", "208"], ["a2", "fnma_deferral_reimb", 147610n, "2027-03-18", "208"], ["a3", "fnma_deferral_reimb", 147619n, "2027-03-18", "208"]]);
  assert.deepEqual(r.applied!.ledger!.lines, [{ account: "custodial_pi_cash", side: "Dr", amount_cents: cents("4428.29") }, { account: "servicer_advance_receivable", side: "Cr", amount_cents: cents("4428.29") }]);
  assert.ok(r.applied!.advances_after.every((a) => a.status === "reimbursed_by_fnma")); assert.equal(r.applied!.remaining_outstanding_cents, 0n); assert.equal(r.applied!.position_closed, true);
  assert.equal(pending.expectation.expected_cents, 442829n); assert.equal(r.applied!.recoveries.reduce((s, x) => s + x.amount_cents, 0n), 442829n);
  // the same credit a cycle late — on the March-period Cash Adjustments report at the April BD3 notification (Mon Apr 5, 2027) — still matches but not on the
  // March cycle → the 4-BD expectation breaches (sev-2)
  const [aprilAdj] = parseCashAdjustmentLines({ report_id: "RDCA-2027-03", activity_period: "2027-03", lines: [{ row: 5, loan_id: "L15", description: "PD P&I Advance Reimbursement", amount_cents: cents("4428.29"), crs_code: "208" }] });
  const lateLine = deferralReimbursement({ accepted_on: D("2027-03-12"), advances: three, line: { report_line_ref: aprilAdj!.report_line_ref, amount_cents: aprilAdj!.amount_cents, report_date: D("2027-04-05") }, sda_status: "not_applicable" });
  assert.equal(lateLine.applied!.status, "matched"); assert.equal(lateLine.matched_on_cycle, false); assert.equal(lateLine.timer.satisfied, false);
  // a deferral accepted on a Stop Advance loan ends SDA with reason `deferral` (5.4)
  assert.deepEqual(deferralReimbursement({ accepted_on: D("2027-03-12"), advances: three, line: null, sda_status: "active" }).sda_exit, { status: "exited", reason: "deferral", exited_on: D("2027-03-12") });
  // ---- on the bus: the acceptance arms FNMA_IRM_PD_ADV_REIMB_4BD for Thu Mar 18 and exits Stop Advance; the Mar 18 booking satisfies it and the two-cycle clock ----
  const h = harness("2027-03-12T20:00:00.000Z"); stopAdvance(h, "2027-03-01");
  const acc = await h.run("setRecoveryExpectation", { loan_id: "L15", event: "deferral_acceptance", accepted_on: "2027-03-12", advances: three });
  assert.equal(acc.expected_by, "2027-03-18"); assert.equal(acc.expected_cents, 442829n); assert.deepEqual(acc.sda_exit, { status: "exited", reason: "deferral", exited_on: "2027-03-12" });
  const fourBd = h.last("FNMA_IRM_PD_ADV_REIMB_4BD"); assert.equal(fourBd.status, "armed"); assert.equal(fourBd.anchorDate, "2027-03-12"); assert.equal(fourBd.dueDate, "2027-03-18");
  assert.equal(h.ev("sda_status.exited")[0]!.payload.reason, "deferral"); assert.equal(h.last("FNMA_F120_SDA_FUNDING_HOLD").status, "satisfied");
  const cycles = h.last("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES"); assert.equal(cycles.dueDate, "2027-05-18", "two S/S draft cycles from the Mar 12 exit: Tue May 18, 2027");
  h.clock.set("2027-03-18T14:00:00.000Z");
  const posted = await h.run("postRecoveryEntries", { loan_id: "L15", source: "fnma_deferral_reimb", amount_cents: 442829n, credit_cents: adj!.amount_cents, effective_date: "2027-03-18", report_line_ref: adj!.report_line_ref, advance_ids: ["a1", "a2", "a3"], advances: three });
  assert.equal(posted.all_reimbursed_by_fnma, true); assert.equal(posted.position_closed, true);
  const booked = h.ev("advance_recoveries.booked")[0]!; assert.equal(booked.payload.source, "fnma_deferral_reimb"); assert.ok(eventMatches(h.def("FNMA_IRM_PD_ADV_REIMB_4BD").satisfiedPattern!, booked));
  assert.equal(fourBd.status, "satisfied"); assert.equal(cycles.status, "satisfied"); assert.equal(h.last("SM_DELADV_UNRECOVERED_60").status, "satisfied");
});
test("15.4-T5: Given a reclass purchase advice dated Nov 3, 2027 for an SDA loan, then the reimbursement is matched on the PA and `sda_status` exits with reason `reclass`.", async () => {
  const r = reclassReimbursement({ purchase_advice_id: "PA-L15-2027-11-03", purchase_advice_date: D("2027-11-03"), pa_reimbursement_cents: cents("5904.58"), advances: ADV, sda_status: "active" });
  // rule 3: reclass → the full outstanding amount on the purchase advice (A1-3-06; IRM p. 37) — the expectation is due on the PA date itself
  assert.equal(r.expectation.expected_recovery_event, "reclass_pa"); assert.equal(r.expectation.expected_by, "2027-11-03"); assert.equal(r.expectation.expected_cents, cents("5904.58")); assert.equal(r.expectation.source, "fnma_reclass_pa");
  assert.deepEqual(r.timer, { code: "FNMA_A1306_RECLASS_REIMB_PA", due: D("2027-11-03"), satisfied: true });
  // matched FIFO on the PA line
  assert.equal(r.match.status, "matched"); assert.deepEqual(r.match.matched, ["a1", "a2", "a3", "a4"]); assert.equal(r.match.matched_cents, cents("5904.58")); assert.equal(r.match.variance_cents, 0n);
  assert.deepEqual(r.recoveries.map((x) => [x.advance_id, x.source, x.amount_cents, x.recovered_at, x.report_line_ref]), [["a1", "fnma_reclass_pa", 147600n, "2027-11-03", "purchase_advice:PA-L15-2027-11-03"], ["a2", "fnma_reclass_pa", 147610n, "2027-11-03", "purchase_advice:PA-L15-2027-11-03"], ["a3", "fnma_reclass_pa", 147619n, "2027-11-03", "purchase_advice:PA-L15-2027-11-03"], ["a4", "fnma_reclass_pa", 147629n, "2027-11-03", "purchase_advice:PA-L15-2027-11-03"]]);
  assert.ok(r.advances_after.every((a) => a.status === "reimbursed_by_fnma")); assert.equal(outstandingCents(r.advances_after), 0n);
  assert.deepEqual(r.ledger, [{ account: "custodial_pi_cash", side: "Dr", amount_cents: cents("5904.58") }, { account: "servicer_advance_receivable", side: "Cr", amount_cents: cents("5904.58") }]);
  // the reclass to A/A ends Stop Delinquency Advance (5.4): `sda_status` exits with reason `reclass` on the PA date
  assert.deepEqual(r.sda_exit, { status: "exited", reason: "reclass", exited_on: D("2027-11-03") });
  // a short PA line still exits SDA (the reclass completed) but leaves the expectation unsatisfied → variance for the IRR package
  const short = reclassReimbursement({ purchase_advice_id: "PA-L15-2027-11-03", purchase_advice_date: D("2027-11-03"), pa_reimbursement_cents: cents("4428.29"), advances: ADV, sda_status: "active" });
  assert.equal(short.match.status, "variance"); assert.equal(short.match.variance_cents, 147_629n); assert.equal(short.timer.satisfied, false); assert.equal(short.sda_exit!.reason, "reclass");
  // a loan that never entered SDA has no exit to record
  assert.equal(reclassReimbursement({ purchase_advice_id: "PA-2", purchase_advice_date: D("2027-11-03"), pa_reimbursement_cents: 0n, advances: [], sda_status: "not_applicable" }).sda_exit, null);
  // ---- on the bus: the PA recorded on a Stop Advance loan → `sda_status.exited{reason=reclass}` lifts the funding hold and arms the two-cycle clock; the PA line booked satisfies both PA clocks ----
  const h = harness("2027-11-03T15:00:00.000Z"); stopAdvance(h);
  const acc = await h.run("setRecoveryExpectation", { loan_id: "L15", event: "reclass_pa", accepted_on: "2027-11-03", advances: ADV });
  assert.equal(acc.expected_by, "2027-11-03"); assert.equal(acc.source, "fnma_reclass_pa"); assert.deepEqual(acc.sda_exit, { status: "exited", reason: "reclass", exited_on: "2027-11-03" });
  const exited = h.ev("sda_status.exited")[0]!; assert.equal(exited.payload.reason, "reclass"); assert.equal(exited.payload.exited_on, "2027-11-03");
  assert.equal(h.last("FNMA_F120_SDA_FUNDING_HOLD").status, "satisfied");
  const pa = h.last("FNMA_A1306_RECLASS_REIMB_PA"); assert.equal(pa.status, "armed"); assert.equal(pa.dueDate, "2027-11-03");
  const cycles = h.last("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES"); assert.equal(cycles.anchorDate, "2027-11-03"); assert.equal(cycles.dueDate, "2028-01-18");
  const posted = await h.run("postRecoveryEntries", { loan_id: "L15", source: "fnma_reclass_pa", amount_cents: 590458n, effective_date: "2027-11-03", report_line_ref: "purchase_advice:PA-L15-2027-11-03", advance_ids: ADV_IDS, advances: ADV });
  assert.equal(posted.all_reimbursed_by_fnma, true); assert.equal(pa.status, "satisfied"); assert.equal(cycles.status, "satisfied"); assert.equal(h.last("SM_DELADV_UNRECOVERED_60").status, "satisfied");
});
test("15.4-T6: Given a portfolio S/A loan that becomes four months delinquent at Mar 31, 2027, then the March-period LAR 96 reports −$3,736.32 interest and the position shows `sa_interest_advanced = 0` after acceptance.", () => {
  // installments due Dec 1, 2026 – Mar 1, 2027 unpaid: interest at PTR on UPB $249,088.61 ($1,245.44) advanced for the Dec, Jan and Feb periods (months 1–3)
  const SA: AdvanceRow[] = [
    { id: "s1", activity_period: "2026-12", amount_cents: cents("1245.44"), status: "outstanding", kind: "delinquency_interest_sa", interest_cents: cents("1245.44"), drafted_at: D("2027-01-20"), funded_from: "partner_advance_line" },
    { id: "s2", activity_period: "2027-01", amount_cents: cents("1245.44"), status: "outstanding", kind: "delinquency_interest_sa", interest_cents: cents("1245.44"), drafted_at: D("2027-02-22"), funded_from: "partner_advance_line" },
    { id: "s3", activity_period: "2027-02", amount_cents: cents("1245.44"), status: "outstanding", kind: "delinquency_interest_sa", interest_cents: cents("1245.44"), drafted_at: D("2027-03-22"), funded_from: "partner_advance_line" },
  ];
  const before = advancePosition({ loan_id: "SA1", as_of: D("2027-03-31"), remittance_type: "SA", servicing_option: "portfolio", sda_status: "not_applicable", advances: SA, fnma_sda_receivable_cents: 0n });
  assert.equal(before.sa_interest_advanced_cents, cents("3736.32")); assert.equal(before.servicer_pi_advances_outstanding_cents, 0n); assert.equal(before.status, "accruing");
  assert.deepEqual(before.periods.map((p) => [p.activity_period, p.principal_cents, p.interest_cents]), [["2026-12", 0n, 124544n], ["2027-01", 0n, 124544n], ["2027-02", 0n, 124544n]]);
  // IRM p. 26: the Transaction Type 96 LAR for the month the loan becomes four months delinquent reports a negative interest remittance — the March period, due BD2 (Fri Apr 2, 2027 17:00 ET)
  const m4 = saMonth4Recovery({ period_end: D("2027-03-31"), monthly_interest_cents: cents("1245.44"), months_advanced: 3, sa_advances: SA, lar_ack_id: "ACK-96-SA1" });
  assert.equal(m4.lar, "96"); assert.equal(m4.interest_cents, -cents("3736.32")); assert.equal(m4.report_period, "2027-03"); assert.equal(m4.due_bd2, "2027-04-02"); assert.equal(m4.timer, "FNMA_IRM_SA_MONTH4_NEG_INTEREST");
  assert.deepEqual(saRecoveryLar(cents("1245.44"), 3), { lar: "96", interest_cents: -373632n });
  // on acceptance the three interest advances are recovered FIFO against the LAR (report-line reference = the LAR 96 ack) and the position's sa_interest_advanced falls to 0
  assert.equal(m4.advanced_before_cents, cents("3736.32")); assert.equal(m4.recovered_cents, cents("3736.32"));
  assert.deepEqual(m4.recoveries.map((x) => [x.advance_id, x.source, x.amount_cents, x.recovered_at, x.report_line_ref]), [["s1", "sa_negative_interest_lar", 124544n, "2027-03-31", "lar96:2027-03:ACK-96-SA1"], ["s2", "sa_negative_interest_lar", 124544n, "2027-03-31", "lar96:2027-03:ACK-96-SA1"], ["s3", "sa_negative_interest_lar", 124544n, "2027-03-31", "lar96:2027-03:ACK-96-SA1"]]);
  assert.ok(m4.advances_after.every((a) => a.status === "reimbursed_by_fnma")); assert.equal(m4.position_after.sa_interest_advanced_cents, 0n);
  const after = advancePosition({ loan_id: "SA1", as_of: D("2027-04-02"), remittance_type: "SA", servicing_option: "portfolio", sda_status: "not_applicable", advances: m4.advances_after, fnma_sda_receivable_cents: 0n });
  assert.equal(after.sa_interest_advanced_cents, 0n); assert.equal(after.servicer_pi_advances_outstanding_cents, 0n); assert.equal(after.status, "closed");
  // a LAR 96 accepted for less than advanced leaves the balance: two months' worth recovered → $1,245.44 still advanced
  const partial = saMonth4Recovery({ period_end: D("2027-03-31"), monthly_interest_cents: cents("1245.44"), months_advanced: 2, sa_advances: SA });
  assert.equal(partial.interest_cents, -cents("2490.88")); assert.equal(partial.position_after.sa_interest_advanced_cents, cents("1245.44")); assert.deepEqual(partial.recoveries.map((x) => x.advance_id), ["s1", "s2"]);
  // a fourth-month interest advance ($1,245.44, if drafted) is not in the LAR 96 — reimbursed after the liquidation LAR within two S/A (CD20) draft cycles
  const withMonth4: AdvanceRow[] = [...m4.advances_after, { id: "s4", activity_period: "2027-03", amount_cents: cents("1245.44"), status: "outstanding", kind: "delinquency_interest_sa" }];
  const e = recoveryExpectation({ remittance_type: "SA", servicing_option: "portfolio", event: "liquidation_lar", accepted_on: D("2027-10-06"), advances: withMonth4 });
  assert.equal(e.expected_cents, cents("1245.44")); assert.equal(e.timer, "FNMA_IRM_SA_LIQ_INTEREST_REIMB"); assert.deepEqual(e.cycles, [D("2027-11-19"), D("2027-12-20")]); assert.equal(e.expected_by, "2027-12-20");
  assert.equal(applyReimbursementLine({ line: { report_line_ref: "RDCA-2027-11#9:sa", amount_cents: cents("1245.44") }, advances: withMonth4, source: "fnma_liquidation_reimb", recovered_at: D("2027-12-20"), kind: "delinquency_interest_sa" }).remaining_outstanding_cents, 0n);
});
test("15.4-T7: Given a regular servicing option MBS loan scheduled for sale Oct 5, 2027 without an accepted repurchase/reclass, then `FNMA_E3501_MBS_REMOVAL_BEFORE_FCL` blocks the sale-package release and an `officer` escalation opens.", async () => {
  // E-3.5-01: the loan must be removed from the MBS pool (repurchase A1-3-01/02 or reclassification A1-3-06) before the foreclosure completes
  const g = salePackageReleaseGate({ servicing_option: "regular_mbs", repurchase_or_reclass_accepted: false, sale_on: D("2027-10-05") });
  assert.equal(g.timer, "FNMA_E3501_MBS_REMOVAL_BEFORE_FCL"); assert.equal(g.kind, "not_before_gate"); assert.equal(g.blocked, true); assert.equal(g.release_allowed, false); assert.equal(g.remove_by, "2027-10-04");
  assert.equal(g.escalation!.kind, "officer"); assert.match(g.escalation!.reason, /E-3\.5-01/); assert.equal(g.expected_recovery_event, "pre_fcl_removal");
  assert.deepEqual(mbsRemovalGate("regular_mbs", false), { blocked: true, escalate: "officer" });
  // the registry gate: evaluator-backed not_before_gate whose breach names the officer; it fails closed when the servicing option is not boarded
  const ev = EVALUATORS_15_4["15.4.mbsRemovedBeforeSale"]!;
  const closed = ev({ servicing_option: "regular_mbs", repurchase_or_reclass_accepted: false, sale_at: "2027-10-05" });
  assert.equal(closed.open, false); assert.match(closed.reason ?? "", /E-3\.5-01.*blocked/);
  assert.equal(ev({ repurchase_or_reclass_accepted: false, sale_at: "2027-10-05" }).open, false); assert.equal(ev({}).open, false);
  assert.equal(ev({ servicing_option: "regular_mbs", repurchase_or_reclass_accepted: true, sale_at: "2027-10-05" }).open, true); assert.equal(ev({ servicing_option: "special", repurchase_or_reclass_accepted: false, sale_at: "2027-10-05" }).open, true);
  const reg = loadRegistry(); applySatisfiedOverrides_15_4(reg);
  const def = reg.get("FNMA_E3501_MBS_REMOVAL_BEFORE_FCL")!;
  assert.equal(def.kindNorm, "not_before_gate"); assert.equal(def.offsetParsed.kind, "evaluator"); assert.equal((def.offsetParsed as { ref: string }).ref, "15.4.mbsRemovedBeforeSale"); assert.ok(def.severity.escalateTo.includes("officer"));
  // a liquidation LAR on such a loan is a data error routed to the officer — advances recover through the purchase price / reclass, never a liquidation reimbursement
  const e = recoveryExpectation({ remittance_type: "SS", servicing_option: "regular_mbs", event: "liquidation_lar", accepted_on: D("2027-10-06"), advances: ADV });
  assert.equal(e.expected_recovery_event, "pre_fcl_removal"); assert.equal(e.fnma_reimburses, false); assert.equal(e.timer, "FNMA_E3501_MBS_REMOVAL_BEFORE_FCL"); assert.equal(e.escalation!.kind, "officer"); assert.equal(e.data_error, "regular_servicing_option_liquidated_in_pool");
  // the removal accepted before the sale opens the gate
  const open = salePackageReleaseGate({ servicing_option: "regular_mbs", repurchase_or_reclass_accepted: true, sale_on: D("2027-10-05") });
  assert.equal(open.blocked, false); assert.equal(open.release_allowed, true); assert.equal(open.escalation, null);
  assert.equal(salePackageReleaseGate({ servicing_option: "special", repurchase_or_reclass_accepted: false, sale_on: D("2027-10-05") }).blocked, false);
  // ---- on the bus: the 13.x sale scheduled, ingested as `foreclosure.sale.scheduled{mbs_regular_servicing}` → the gate arms, the release is blocked, the officer escalation opens ----
  const h = harness("2027-09-20T14:00:00.000Z");
  const s = await h.run("setRecoveryExpectation", { loan_id: "L15", event: "pre_fcl_removal", sale_on: "2027-10-05", servicing_option: "regular_mbs", repurchase_or_reclass_accepted: false, advances: ADV });
  assert.equal(s.gate.blocked, true); assert.equal(s.gate.release_allowed, false); assert.equal(s.gate.remove_by, "2027-10-04"); assert.equal(s.expectation.expected_recovery_event, "pre_fcl_removal"); assert.equal(s.expectation.expected_cents, 590458n); assert.ok(s.escalation_id);
  const scheduled = h.ev("foreclosure.sale.scheduled")[0]!;
  assert.equal(scheduled.payload.mbs_regular_servicing, true); assert.equal(scheduled.payload.sale_at, "2027-10-05"); assert.equal(scheduled.payload.timer, "FNMA_E3501_MBS_REMOVAL_BEFORE_FCL");
  assert.ok(eventMatches(h.def("FNMA_E3501_MBS_REMOVAL_BEFORE_FCL").triggerPattern!, scheduled));
  const gate = h.last("FNMA_E3501_MBS_REMOVAL_BEFORE_FCL"); assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2027-10-05"); assert.equal(gate.note, "evaluator:15.4.mbsRemovedBeforeSale"); assert.equal(gate.dueAt, undefined);
  const esc = h.escalations.opened.find((x) => x.id === s.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.ownerRole, "officer"); assert.match(String(esc.payload.reason), /E-3\.5-01/); assert.equal(esc.payload.remove_by, "2027-10-04");
  assert.deepEqual(h.ev("sale_package.release_blocked").map((x) => [x.payload.timer, x.payload.sale_at, x.payload.escalation_id]), [["FNMA_E3501_MBS_REMOVAL_BEFORE_FCL", "2027-10-05", esc.id]]);
  assert.equal(saleScheduled({ sale_on: D("2027-10-05"), servicing_option: "regular_mbs", repurchase_or_reclass_accepted: false, advances: ADV }).event, "foreclosure.sale.scheduled");
  // the repurchase approved Mon Oct 4 — the removal accepted before the sale — lifts the gate
  h.clock.set("2027-10-04T14:00:00.000Z");
  const rp = await h.run("setRecoveryExpectation", { loan_id: "L15", event: "repurchase", accepted_on: "2027-10-04", servicing_option: "regular_mbs", advances: ADV });
  assert.equal(rp.fnma_reimburses, false); assert.equal(rp.source, "repurchase_price");
  assert.ok(eventMatches(h.def("FNMA_E3501_MBS_REMOVAL_BEFORE_FCL").satisfiedPattern!, h.ev("advance_position.expectation_set").at(-1)!)); assert.equal(gate.status, "satisfied");
  // a special servicing option loan scheduled for sale is not gated and nothing escalates
  const h2 = harness("2027-09-20T14:00:00.000Z");
  const s2 = await h2.run("setRecoveryExpectation", { loan_id: "L15", event: "pre_fcl_removal", sale_on: "2027-10-05", servicing_option: "special", repurchase_or_reclass_accepted: false, advances: ADV });
  assert.equal(s2.gate.blocked, false); assert.equal(s2.escalation_id, null); assert.equal(h2.timer("FNMA_E3501_MBS_REMOVAL_BEFORE_FCL").length, 0); assert.equal(h2.escalations.opened.length, 0);
  // a servicing option that was never boarded fails closed on the bus too
  await assert.rejects(h2.run("setRecoveryExpectation", { loan_id: "L15", event: "pre_fcl_removal", sale_on: "2027-10-05", servicing_option: "unknown", advances: ADV }), RangeError);
  assert.equal((await h2.run("setRecoveryExpectation", { loan_id: "L15", event: "pre_fcl_removal", sale_on: "2027-10-05", advances: ADV })).gate.blocked, true);
});
test("15.4-T8: Given a payoff on an SDA loan (Fannie Mae receivable $8,860.00; our advances $5,904.58), then the payoff calculator includes Fannie Mae's receivable in the remittance, our $5,904.58 is recovered from the borrower's delinquent P&I on the payoff posting, and no reimbursement expectation is created.", async () => {
  // borrower's delinquent P&I in the payoff: Dec 2026–Sep 2027 = 10 × $1,580.17 note-rate installments
  const delinquentPi = 10n * cents("1580.17");
  const r = payoffAdvanceRecovery({ kind: "payoff", posted_on: D("2027-09-15"), posting_id: "PO-L15-2027-09-15", fnma_sda_receivable_cents: cents("8860.00"), delinquent_pi_collected_cents: delinquentPi, advances: ADV, fnma_share_cents: cents("249088.61") });
  // the 16.2 payoff calculator (advanceSpecialRemittance, F-1-09/F-1-20): Fannie Mae's outstanding P&I rides the payoff remittance as the CRS 352 special
  // remittance, outside the 001 draft and never netted against ours
  assert.equal(r.remittance.included, true); assert.equal(r.remittance.crs_code, "352"); assert.equal(r.remittance.crs_352_cents, cents("8860.00")); assert.equal(r.remittance.fnma_sda_receivable_cents, cents("8860.00"));
  assert.equal(r.remittance.crs_001_cents, cents("249088.61")); assert.equal(r.remittance.excluded_from_001, true); assert.equal(r.remittance.special_remit_by, "2027-10-15"); assert.equal(r.remittance.memo, "fnma_pi_receivable_sda"); assert.equal(r.remittance.drafted_by, "fannie_mae"); assert.equal(r.netted, false);
  const remit = advanceSpecialRemittance({ payoff_on: D("2027-09-15"), fnma_share_cents: cents("249088.61"), fnma_advance_repay_cents: cents("8860.00"), servicer_advance_recovered_cents: r.recovered_cents });
  assert.equal(remit.crs_352_cents, cents("8860.00")); assert.equal(remit.servicer_recovery_cents, cents("5904.58")); assert.equal(remit.crs_001_cents, cents("249088.61"));
  // ours is recovered FIFO from the delinquent P&I on the payoff posting (Fannie Mae first, 5.4 rule 4)
  assert.equal(r.recovered_cents, cents("5904.58")); assert.equal(r.shortfall_cents, 0n);
  assert.deepEqual(r.recoveries.map((x) => [x.advance_id, x.source, x.amount_cents, x.recovered_at, x.report_line_ref]), [["a1", "payoff_proceeds", 147600n, "2027-09-15", "payoff:PO-L15-2027-09-15"], ["a2", "payoff_proceeds", 147610n, "2027-09-15", "payoff:PO-L15-2027-09-15"], ["a3", "payoff_proceeds", 147619n, "2027-09-15", "payoff:PO-L15-2027-09-15"], ["a4", "payoff_proceeds", 147629n, "2027-09-15", "payoff:PO-L15-2027-09-15"]]);
  assert.ok(r.advances_after.every((a) => a.status === "recovered_from_borrower"));
  assert.deepEqual(r.ledger, [{ account: "custodial_pi_cash", side: "Dr", amount_cents: cents("5904.58") }, { account: "servicer_advance_receivable", side: "Cr", amount_cents: cents("5904.58") }]);
  // no reimbursement expectation — Fannie Mae reimburses nothing on a payoff; the same-day recovery timer is the only clock
  assert.equal(r.expectation, null); assert.deepEqual(r.timer, { code: "SM_PAYOFF_ADV_RECOVERY_SAME_DAY", due: D("2027-09-15") });
  const e = recoveryExpectation({ remittance_type: "SS", servicing_option: "special", event: "payoff", accepted_on: D("2027-09-15"), advances: ADV });
  assert.equal(e.fnma_reimburses, false); assert.equal(e.expected_cents, 0n); assert.equal(e.source, "payoff_proceeds"); assert.equal(e.timer, "SM_PAYOFF_ADV_RECOVERY_SAME_DAY");
  assert.equal(expectedRecovery("payoff", D("2027-09-15")).expected_by, null);
  // recovery order: Fannie Mae's $8,860.00 comes out of the delinquent P&I first — a short collection leaves ours partly unrecovered, the receivable untouched
  const short = payoffAdvanceRecovery({ kind: "payoff", posted_on: D("2027-09-15"), posting_id: "PO-2", fnma_sda_receivable_cents: cents("8860.00"), delinquent_pi_collected_cents: cents("10000.00"), advances: ADV });
  assert.equal(short.remittance.crs_352_cents, cents("8860.00")); assert.equal(short.recovered_cents, 0n); assert.equal(short.shortfall_cents, cents("5904.58"));
  const partial = payoffAdvanceRecovery({ kind: "repurchase", posted_on: D("2027-09-15"), posting_id: "RP-1", fnma_sda_receivable_cents: cents("8860.00"), delinquent_pi_collected_cents: cents("8860.00") + cents("4428.29"), advances: ADV });
  assert.deepEqual(partial.recoveries.map((x) => x.advance_id), ["a1", "a2", "a3"]); assert.equal(partial.recoveries[0]!.source, "repurchase_price"); assert.equal(partial.shortfall_cents, 147_629n);
  // ---- on the bus: the payoff posting exits Stop Advance (no reimbursement clock), arms the same-day recovery and the 60-day clock; the proceeds booked satisfy both ----
  const h = harness("2027-09-15T16:00:00.000Z"); stopAdvance(h);
  const p = await h.run("setRecoveryExpectation", { loan_id: "L15", event: "payoff", accepted_on: "2027-09-15", advances: ADV });
  assert.equal(p.fnma_reimburses, false); assert.equal(p.expected_cents, 0n); assert.equal(p.source, "payoff_proceeds"); assert.deepEqual(p.sda_exit, { status: "exited", reason: "payoff", exited_on: "2027-09-15" });
  assert.equal(h.ev("sda_status.exited")[0]!.payload.fnma_reimburses, false); assert.equal(h.last("FNMA_F120_SDA_FUNDING_HOLD").status, "satisfied");
  assert.equal(h.timer("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES").length, 0, "no reimbursement expectation on a payoff: the two-cycle clock never arms");
  const sameDay = h.last("SM_PAYOFF_ADV_RECOVERY_SAME_DAY"); assert.equal(sameDay.status, "armed"); assert.equal(sameDay.dueDate, "2027-09-15");
  const sixty = h.last("SM_DELADV_UNRECOVERED_60"); assert.equal(sixty.status, "armed"); assert.equal(sixty.dueDate, "2027-11-14", "an advance unrecovered after a payoff exit is the officer's at 60 days too");
  const posted = await h.run("postRecoveryEntries", { loan_id: "L15", source: "payoff_proceeds", amount_cents: 590458n, effective_date: "2027-09-15", report_line_ref: "payoff:PO-L15-2027-09-15", advance_ids: ADV_IDS, advances: ADV });
  assert.equal(posted.status, "recovered_from_borrower"); assert.equal(posted.position_closed, true); assert.equal(posted.all_reimbursed_by_fnma, false); assert.equal(h.ev("advances.reimbursed_by_fnma").length, 0);
  assert.ok(eventMatches(h.def("SM_PAYOFF_ADV_RECOVERY_SAME_DAY").satisfiedPattern!, h.ev("advance_recoveries.booked")[0]!));
  assert.equal(sameDay.status, "satisfied"); assert.equal(sixty.status, "satisfied");
});
test("15.4-T9: Given a rescission approved Dec 1, 2027 after the $5,904.58 was reimbursed, then a reversing recovery is expected on the next Cash Adjustments report and the loan returns to `sda_active`.", () => {
  const booked: RecoveryRow[] = ADV.map((a) => ({ id: `r-${a.id}`, advance_id: a.id, source: "fnma_liquidation_reimb", amount_cents: a.amount_cents, recovered_at: D("2027-11-03"), report_line_ref: `RDCA-2027-10#7:${a.id}` }));
  const approvedMs = zonedEpochMs(D("2027-12-01"), "10:00", "America/New_York");
  // Fannie Mae's Stop Advance status (5.4) still stands on the rescinded loan
  const r = rescissionReversal({ approved_on: D("2027-12-01"), approved_at_ms: approvedMs, recoveries: booked, advances: REIMBURSED, sda_status: "active" });
  // rule 8: the clawback is a debit adjustment on the Cash Adjustments report for the December activity period (January BD3 notification), matched to reversing rows
  assert.equal(r.expected_debit_cents, cents("5904.58")); assert.equal(r.expected_report, "remittance_detail_cash_adjustments"); assert.equal(r.expected_report_period, "2027-12"); assert.equal(r.expected_on, "2028-01-05");
  assert.deepEqual(r.reversing_recoveries.map((x) => [x.advance_id, x.source, x.amount_cents, x.recovered_at, x.report_line_ref]), [["a1", "reversal", -147600n, "2027-12-01", "reverses:RDCA-2027-10#7:a1"], ["a2", "reversal", -147610n, "2027-12-01", "reverses:RDCA-2027-10#7:a2"], ["a3", "reversal", -147619n, "2027-12-01", "reverses:RDCA-2027-10#7:a3"], ["a4", "reversal", -147629n, "2027-12-01", "reverses:RDCA-2027-10#7:a4"]]);
  // the loan returns to `sda_active`: advances outstanding again, the liquidation expectation cancelled, the rule-4 entries reversed
  assert.equal(r.position_status, "sda_active"); assert.ok(r.advances_after.every((a) => a.status === "outstanding")); assert.equal(outstandingCents(r.advances_after), cents("5904.58"));
  assert.deepEqual(r.expectation, { expected_recovery_event: null, expected_by: null });
  assert.deepEqual(r.ledger, [{ account: "servicer_advance_receivable", side: "Dr", amount_cents: cents("5904.58") }, { account: "custodial_pi_cash", side: "Cr", amount_cents: cents("5904.58") }]);
  // 15.1 rule 10: re-activated in servicing within 24 hours of the approval
  assert.equal(r.reintegrate_by_ms, approvedMs + 24 * 3600 * 1000);
  const pos = advancePosition({ loan_id: "L15", as_of: D("2027-12-02"), remittance_type: "SS", servicing_option: "special", sda_status: "active", advances: r.advances_after, fnma_sda_receivable_cents: cents("8860.00") });
  assert.equal(pos.status, "sda_active"); assert.equal(pos.servicer_pi_advances_outstanding_cents, cents("5904.58")); assert.equal(pos.fnma_sda_receivable_cents, cents("8860.00")); assert.equal(pos.expected_recovery_event, null);
  // a rescinded loan that never reached Stop Advance re-enters `accruing`
  assert.equal(rescissionReversal({ approved_on: D("2027-12-01"), recoveries: booked, advances: REIMBURSED, sda_status: "not_applicable" }).position_status, "accruing");
  // the debit line on the January report parses as a debit adjustment carrying a report-line reference for the reversing rows
  const [line] = parseCashAdjustmentLines({ report_id: "RDCA-2027-12", activity_period: "2027-12", lines: [{ row: 3, loan_id: "L15", description: "Delinquency Advance Reimbursement — rescission", amount_cents: -cents("5904.58") }] });
  assert.equal(line!.type, "debit_adjustment"); assert.equal(line!.amount_cents, -r.expected_debit_cents); assert.match(line!.report_line_ref, /^RDCA-2027-12#3:[0-9a-f]{8}$/);
});
test("15.4-T10: Given an operator uploads a 15.2 claim line with `advances.kind = delinquency_pi`, then the validator rejects it with reason `pi_advances_not_claimable`.", () => {
  // rule 5: the 15.2 line validator rejects P&I advances (delinquency_pi and the S/A interest kind alike) — no 571 line, ever
  const line: ClaimLine = { kind: "delinquency_pi", unit_cents: cents("1476.00"), quantity: 1, paid_on: D("2027-01-18"), invoice: true };
  const v = validateLine(line, CTX_571);
  assert.equal(v.ok, false); assert.deepEqual(v.messages, ["pi_advances_not_claimable"]); assert.equal(v.amount_cents, 147600n);
  assert.deepEqual(validateLine({ kind: "delinquency_interest_sa", unit_cents: cents("1245.44"), quantity: 1, paid_on: D("2027-01-20"), invoice: true }, CTX_571).messages, ["pi_advances_not_claimable"]);
  // the 15.2 sweep never proposes one as a claim candidate either
  const sw = sweepClaimCandidates([{ id: "a1", loan_id: "L15", kind: "delinquency_pi", amount_cents: 147_600n, paid_at: D("2027-01-18"), invoice_document_id: "draft-2027-01", allowable_code: null, borrower_recoverable: true }]);
  assert.deepEqual(sw.candidates, []); assert.deepEqual(sw.skipped, [{ advance_id: "a1", reason: "pi_advances_not_claimable" }]);
  const leaks = piAdvanceLeaks({ advances: ADV, claim_571_lines: [...LINES_571, line], claim_context: CTX_571, mi_claim_advances: [] });
  assert.equal(leaks.clean, false); assert.deepEqual(leaks.claim_571.rejected, [{ index: 2, kind: "delinquency_pi", reason: "pi_advances_not_claimable" }]); assert.equal(leaks.claim_571.accepted, 2);
  // expense lines on the same claim are unaffected
  assert.ok(validateLine(LINES_571[0]!, CTX_571).ok);
});
test("15.4-T11: Given a duplicate $5,904.58 credit in December, then a payable to Fannie Mae is booked and the Investor Reporting Representative is notified within 2 BD.", () => {
  // the November-period report (December BD3 notification) repeats the October credit already matched to a1–a4
  const [adj] = parseCashAdjustmentLines({ report_id: "RDCA-2027-11", activity_period: "2027-11", lines: [{ row: 4, loan_id: "L15", description: "S/S Delinquency Advance Reimbursement", amount_cents: cents("5904.58") }] });
  assert.equal(matchReimbursement([], adj!.amount_cents).status, "duplicate");
  const dup = duplicateCredit({ credit_cents: adj!.amount_cents, advances: REIMBURSED, received_on: D("2027-12-20"), report_line_ref: adj!.report_line_ref });
  assert.equal(dup.match_status, "duplicate"); assert.equal(dup.payable_cents, cents("5904.58")); assert.equal(dup.keep, false); assert.equal(dup.report_line_ref, adj!.report_line_ref);
  // a payable to Fannie Mae, never kept: Dr custodial_pi_cash / Cr fnma_payable — balanced on the kernel chart
  assert.deepEqual(dup.ledger, [{ account: "custodial_pi_cash", side: "Dr", amount_cents: cents("5904.58") }, { account: "fnma_payable", side: "Cr", amount_cents: cents("5904.58") }]);
  const lines = entryLines(dup.ledger, "C-PI", "15.4 edge case: duplicate credit");
  assert.equal(lines.reduce((s, l) => s + l.amountCents, 0n), 0n); assert.deepEqual(lines[1]!.account, { scope: "corporate", account: "fnma_payable" });
  // Mon Dec 20, 2027 + 2 `fannie_et` BD → Wed Dec 22, 2027
  assert.equal(dup.notify_irr_by, "2027-12-22"); assert.equal(duplicateCreditNoticeDue(D("2027-12-20")), "2027-12-22");
  // over the Christmas holiday: received Thu Dec 23 → Tue Dec 28 (Fri Dec 24 observed for the Saturday Dec 25; Mon Dec 27 is BD1)
  assert.equal(duplicateCreditNoticeDue(D("2027-12-23")), "2027-12-28");
  // a credit exceeding a partly open position: the open advance is matched, only the excess becomes the payable
  const partial = duplicateCredit({ credit_cents: cents("5904.58"), advances: [...REIMBURSED.slice(0, 3), ADV[3]!], received_on: D("2027-12-20"), report_line_ref: "RDCA-2027-11#5:x" });
  assert.equal(partial.match_status, "variance"); assert.equal(partial.payable_cents, cents("5904.58") - cents("1476.29")); assert.equal(partial.payable_cents, cents("4428.29"));
});

test("15.4 worked figures: fixture L15 drafts $1,476.00 + $1,476.10 + $1,476.19 + $1,476.29 = $5,904.58; PTR interest $1,245.44 on UPB $249,088.61; S/A recovery −$3,736.32; Fannie Mae receivable ≈ $8,860; matching tolerance $0.05; cycles Nov 18 / Dec 17, 2027; deferral Mar 12 → Mar 18, 2027", () => {
  // rule 7: scheduled P&I at PTR 6.00% on the scheduled UPB of the $250,000 / 6.50% / $1,580.17 loan — activity periods Dec 2026–Mar 2027 (drafted Jan–Apr 2027)
  const s = scheduleForward(cents("250000"), "6.500", "6.000", cents("1580.17"), 10);
  const drafts = s.slice(0, 4).map((m) => m.fnma_interest_cents + m.fnma_principal_cents);
  assert.deepEqual(drafts, [147600n, 147610n, 147619n, 147629n]);
  assert.equal(drafts.reduce((a, b) => a + b, 0n), 590458n);
  // The four totals are exact; the spec's parenthetical components are not: principal is $226.00 → $229.70 (250,000 × 6.5% / 12 = $1,354.17 note interest;
  // $1,580.17 − $1,354.17 = $226.00 in month 1), not "≈ $230.6–$230.9", and PTR interest is $1,250.00 → $1,246.59 — its "≈ $1,245.44" is the month-5
  // figure on UPB $249,088.61. The sum still rises because the 0.25% servicing-fee strip shrinks as the UPB amortizes.
  assert.deepEqual(s.slice(0, 4).map((m) => m.fnma_principal_cents), [22600n, 22723n, 22846n, 22970n]);
  assert.deepEqual(s.slice(0, 4).map((m) => m.fnma_interest_cents), [125000n, 124887n, 124773n, 124659n]);
  assert.ok(s.slice(1, 4).every((m, i) => m.servicing_fee_cents < s[i]!.servicing_fee_cents));
  // interest component $1,245.44: PTR interest on the scheduled UPB $249,088.61 after four scheduled payments (the S/A variant's UPB)
  assert.equal(s[4]!.prior_scheduled_upb_cents, 24908861n); assert.equal(s[4]!.fnma_interest_cents, 124544n);
  // S/A variant: months 1–3 interest = 3 × $1,245.44 = $3,736.32 reported as −$3,736.32 on the month-4 LAR 96; a fourth-month advance is reimbursed within two S/A draft cycles after the liquidation LAR
  assert.deepEqual(saRecoveryLar(124544n, 3), { lar: "96", interest_cents: -373632n });
  const m4 = saMonth4Recovery({ period_end: D("2027-03-31"), monthly_interest_cents: 124544n, months_advanced: 3 });
  assert.equal(m4.interest_cents, -cents("3736.32")); assert.equal(m4.report_period, "2027-03"); assert.equal(m4.due_bd2, "2027-04-02"); assert.equal(m4.advanced_before_cents, 373632n); assert.equal(m4.recovered_cents, 373632n); assert.equal(m4.position_after.sa_interest_advanced_cents, 0n);
  const sa = saLiquidationInterestExpectation(D("2027-10-06"), 124544n);
  assert.equal(sa.expected_cents, cents("1245.44")); assert.deepEqual(sa.cycles, [D("2027-11-19"), D("2027-12-20")]); assert.equal(sa.expected_by, "2027-12-20");
  // Stop Advance from BD2 May 2027: activity periods Apr–Sep 2027 (six) are credited and Fannie Mae's receivable grows to ≈ $8,860 — Fannie Mae's loss at liquidation
  const receivable = s.slice(4, 10).reduce((a, m) => a + m.fnma_interest_cents + m.fnma_principal_cents, 0n);
  // the spec's "≈ 6 × $1,476.4–$1,476.9 ≈ $8,860" rounds the schedule: the engine's six credited periods are $1,476.38 … $1,476.87, sum $8,859.75
  assert.deepEqual(s.slice(4, 10).map((m) => m.fnma_interest_cents + m.fnma_principal_cents), [147638n, 147648n, 147658n, 147667n, 147677n, 147687n]);
  assert.equal(receivable, 885975n); assert.ok(receivable > cents("8859") && receivable < cents("8861"), `receivable ${receivable}`);
  // rule 4: tolerance $0.05 per line — a credit 5¢ off still matches, 6¢ off is a variance (the calculator's own tolerance is the boundary)
  const open: Advance[] = ADV.map((a) => ({ id: a.id, activity_period: a.activity_period, amount_cents: a.amount_cents, status: "outstanding" }));
  assert.equal(outstanding(open), 590458n);
  assert.equal(matchReimbursement(open, 590458n + 5n).status, "matched"); assert.equal(matchReimbursement(open, 590458n - 5n).status, "matched"); assert.equal(matchReimbursement(open, 590458n + 6n).status, "variance");
  assert.equal(matchReimbursement(open, 590458n + MATCH_TOLERANCE).status, "matched"); assert.equal(matchReimbursement(open, 590458n + MATCH_TOLERANCE + 1n).status, "variance"); assert.equal(matchReimbursement(open, 590458n - MATCH_TOLERANCE - 1n).status, "variance");
  // rule 7: LAR 72 accepted Wed Oct 6, 2027 → two S/S draft cycles Nov 18 and Fri Dec 17, 2027 (Dec 18 is a Saturday); the expectation is the full $5,904.58
  const e = recoveryExpectation({ remittance_type: "SS", servicing_option: "special", event: "liquidation_lar", accepted_on: D("2027-10-06"), advances: ADV });
  assert.deepEqual(e.cycles, [D("2027-11-18"), D("2027-12-17")]); assert.equal(e.expected_by, "2027-12-17"); assert.equal(e.expected_cents, cents("5904.58")); assert.equal(e.source, "fnma_liquidation_reimb"); assert.equal(e.data_error, null);
  // guardrail: an S/S special servicing loan liquidated with a zero expectation is a data error
  const zero = recoveryExpectation({ remittance_type: "SS", servicing_option: "special", event: "liquidation_lar", accepted_on: D("2027-10-06"), advances: [] });
  assert.equal(zero.data_error, "zero_expectation_on_ss_special_liquidation"); assert.equal(zero.escalation!.kind, "sev2");
  // guardrail: never fund an advance on a Stop Advance loan — Stop Advance start May 1, 2027: the Apr 16 draft is fine, a May 18 draft is not
  assert.deepEqual(advancesFundedDuringSda(ADV, "active", D("2027-05-01")), []);
  assert.deepEqual(advancesFundedDuringSda([...ADV, { id: "a5", activity_period: "2027-05", amount_cents: cents("1476.38"), status: "outstanding", kind: "delinquency_pi", drafted_at: D("2027-05-18") }], "active", D("2027-05-01")), ["a5"]);
  // deferral variant: accepted Fri Mar 12, 2027 with three advances outstanding → $4,428.29 by Thu Mar 18, 2027 (4 fannie_et BD), the March draft day
  const def = recoveryExpectation({ remittance_type: "SS", servicing_option: "special", event: "deferral_acceptance", accepted_on: D("2027-03-12"), advances: ADV.slice(0, 3) });
  assert.equal(def.expected_cents, 442829n); assert.equal(def.expected_by, "2027-03-18"); assert.equal(def.timer, "FNMA_IRM_PD_ADV_REIMB_4BD");
  // the November Cash Adjustments line for the October period → one `delinquency_advance_reimbursement` adjustment with a report-line reference (rule 4 matching input)
  const adj = octoberLine(cents("5904.58"));
  assert.equal(adj.type, "delinquency_advance_reimbursement"); assert.equal(adj.amount_cents, 590458n); assert.match(adj.report_line_ref, /^RDCA-2027-10#12:[0-9a-f]{8}$/);
  // $4,428.29 instead → variance 147,629¢ → IRR package (LAR ids/acks, drafted amounts, report lines); registry SM_DELADV_UNRECOVERED_60 = exit + 60 calendar days → Dec 5, 2027 (spec prose says Feb 4, 2028 — audit note)
  const v = matchReimbursement(open, cents("4428.29"));
  const pkg = irrPackage({ loan_id: "L15", exit_event: "liquidation_lar", exit_on: D("2027-10-06"), today: D("2027-12-18"), activity_periods: ADV.map((a) => ({ period: a.activity_period, drafted_cents: a.amount_cents, draft_id: `draft-${a.activity_period}` })), lar: { id: "LAR-72-L15", ack_id: "ACK-1", action_code: "72", accepted_on: D("2027-10-06") }, report_lines: [adj.report_line_ref], expected_cents: e.expected_cents, matched_cents: v.matched_cents, variance_cents: v.variance_cents, expected_by: e.expected_by });
  assert.equal(pkg.contents.variance_cents, 147_629n); assert.equal(pkg.contents.drafted_total_cents, cents("5904.58")); assert.equal(pkg.contents.lar!.ack_id, "ACK-1"); assert.equal(pkg.contents.variance_kind, "amount"); assert.equal(pkg.recipient, "investor_reporting_representative"); assert.equal(pkg.irt_is_the_venue, false);
  assert.equal(pkg.officer_due, "2027-12-05"); assert.equal(pkg.escalation.kind, "officer"); assert.equal(pkg.partner_monthly_report, true);
  assert.equal(irrPackage({ loan_id: "L15", exit_event: "liquidation_lar", exit_on: D("2027-10-06"), today: D("2027-11-05"), activity_periods: [], lar: null, report_lines: [], expected_cents: e.expected_cents, matched_cents: v.matched_cents, variance_cents: v.variance_cents, expected_by: e.expected_by }).escalation.kind, "human_agent");
  // write-offs need the officer; above $500/loan the officer's own decision task
  assert.equal(writeOffDecision({ amount_cents: 147_629n, approved_by_role: null, exit_on: D("2027-10-06"), today: D("2028-02-04"), advance_ids: ["a4"] }).allowed, false);
  const wo = writeOffDecision({ amount_cents: 147_629n, approved_by_role: "officer", exit_on: D("2027-10-06"), today: D("2028-02-04"), advance_ids: ["a4"] });
  assert.equal(wo.allowed, true); assert.equal(wo.officer_task, true); assert.equal(wo.recoveries[0]!.source, "write_off"); assert.equal(wo.timer_satisfied, "SM_DELADV_UNRECOVERED_60");
  // duplicate $5,904.58 credit in December → payable to Fannie Mae, IRR notified within 2 BD (Dec 20 → Dec 22, 2027); the excess is never kept
  const dup = duplicateCredit({ credit_cents: cents("5904.58"), advances: REIMBURSED, received_on: D("2027-12-20"), report_line_ref: "RDCA-2027-11#4:dup" });
  assert.equal(dup.payable_cents, cents("5904.58")); assert.equal(dup.ledger[1]!.account, "fnma_payable"); assert.equal(dup.notify_irr_by, "2027-12-22"); assert.equal(dup.keep, false);
  // monthly aging report to the partner: 73 days after the Oct 6 exit the position is in the 61–90 bucket and officer-flagged
  const aging = agingReport({ as_of: D("2027-12-18"), positions: [{ loan_id: "L15", exit_on: D("2027-10-06"), outstanding_cents: 147_629n, status: "variance", expected_recovery_event: "liquidation_lar" }, { loan_id: "L16", exit_on: null, outstanding_cents: cents("2952.10"), status: "sda_active", expected_recovery_event: null }, { loan_id: "L17", exit_on: D("2027-11-03"), outstanding_cents: 0n, status: "closed", expected_recovery_event: "reclass_pa" }] });
  assert.deepEqual(aging.rows.map((r) => [r.loan_id, r.days_since_exit, r.bucket, r.officer_flag]), [["L15", 73, "61-90", true], ["L16", null, "not_exited", false]]);
  assert.equal(aging.totals.outstanding_cents, 147_629n + cents("2952.10")); assert.equal(aging.totals.by_bucket["61-90"], 147_629n); assert.equal(aging.totals.officer_flagged, 1);
  // the position row (rule 2) carries Fannie Mae's receivable separately from ours and never nets them; S/A interest rows are never counted in the S/S figure
  const pos = advancePosition({ loan_id: "L15", as_of: D("2027-10-07"), remittance_type: "SS", servicing_option: "special", sda_status: "active", advances: ADV, fnma_sda_receivable_cents: receivable, expected_recovery_event: "liquidation_lar", expected_by: e.expected_by });
  assert.equal(pos.status, "recovery_expected"); assert.equal(pos.servicer_pi_advances_outstanding_cents, 590458n); assert.equal(pos.fnma_sda_receivable_cents, receivable); assert.equal(pos.periods.length, 4); assert.equal(pos.periods[0]!.drafted_at, "2027-01-18"); assert.equal(pos.sa_interest_advanced_cents, 0n);
  const mixed = advancePosition({ loan_id: "SA1", as_of: D("2027-10-07"), remittance_type: "SA", servicing_option: "portfolio", sda_status: "not_applicable", advances: [{ id: "s4", activity_period: "2027-03", amount_cents: 124544n, status: "outstanding", kind: "delinquency_interest_sa" }], fnma_sda_receivable_cents: 0n });
  assert.equal(mixed.servicer_pi_advances_outstanding_cents, 0n); assert.equal(mixed.sa_interest_advanced_cents, 124544n);
  assert.equal(advancePosition({ loan_id: "L15", as_of: D("2027-11-04"), remittance_type: "SS", servicing_option: "special", sda_status: "exited", advances: REIMBURSED, fnma_sda_receivable_cents: 0n, matched_cents: 590458n }).status, "closed");
  assert.equal(advancePosition({ loan_id: "AA1", as_of: D("2027-11-04"), remittance_type: "AA", servicing_option: "portfolio", sda_status: "not_applicable", advances: [], fnma_sda_receivable_cents: 0n }).applies, false);
});

test("15.4 daily position sweep on the bus: SM_DELADV_POSITION_DAILY arms on the 00:30 sweep tick for a delinquent S/S loan, is satisfied by the written row and re-arms for the next day; the Stop Advance and no-netting guardrails read the loan's own facts", async () => {
  const h = harness("2027-10-07T04:30:00.000Z");   // 00:30 EDT Thu Oct 7, 2027 — the post-timer-sweep position recompute
  stopAdvance(h);
  const input = { loan_id: "L15", remittance_type: "SS", servicing_option: "special", advances: ADV, fnma_sda_receivable_cents: 885975n, expected_recovery_event: "liquidation_lar", expected_by: "2027-12-17" };
  const pos = await h.run("recomputeAdvancePosition", { ...input, as_of: "2027-10-07" });
  assert.equal(pos.status, "recovery_expected"); assert.equal(pos.servicer_pi_advances_outstanding_cents, 590458n); assert.equal(pos.fnma_sda_receivable_cents, 885975n); assert.equal(pos.daily_clock_armed, true);
  const tick = h.ev("schedule.tick")[0]!;
  assert.deepEqual(tick.payload, { cadence: "daily", at: "00:30", tz: "loan_local", job: "deladv-position-sweep", date: "2027-10-07" }); assert.equal(tick.loanId, "L15"); assert.deepEqual(tick.actor, { kind: "system", id: "scheduler" });
  assert.equal(positionSweepTick(D("2027-10-07"), "L15").loanId, "L15");
  const daily = h.def("SM_DELADV_POSITION_DAILY"); assert.equal(daily.kindNorm, "recurring");
  assert.ok(eventMatches(daily.triggerPattern!, tick));
  const written = h.ev("delinquency_advance_positions.written")[0]!; assert.ok(eventMatches(daily.satisfiedPattern!, written)); assert.equal(written.payload.status, "recovery_expected");
  assert.deepEqual(h.timer("SM_DELADV_POSITION_DAILY").map((t) => [t.status, t.anchorDate, t.dueDate]), [["satisfied", "2027-10-07", "2027-10-08"], ["armed", "2027-10-07", "2027-10-08"]], "armed by the tick, satisfied by the row, re-armed for tomorrow");
  assert.equal(h.rt.store.get("delinquency_advance_positions", "L15:2027-10-07")!.data.servicer_pi_advances_outstanding_cents, 590458n);
  // Fri Oct 8: the open clock is satisfied by the new row and re-armed — no second tick for a loan whose clock is open
  h.clock.set("2027-10-08T04:30:00.000Z");
  const pos2 = await h.run("recomputeAdvancePosition", { ...input, as_of: "2027-10-08" });
  assert.equal(pos2.daily_clock_armed, false); assert.equal(h.ev("schedule.tick").length, 1);
  assert.deepEqual(h.timer("SM_DELADV_POSITION_DAILY").map((t) => [t.status, t.dueDate]), [["satisfied", "2027-10-08"], ["satisfied", "2027-10-08"], ["armed", "2027-10-09"]]);
  // a day missed breaches the sev-3 row; the next row satisfies it late and re-arms
  const missed = h.engine.evaluate("2027-10-10T04:30:00.000Z").filter((b) => b.instance.code === "SM_DELADV_POSITION_DAILY");
  assert.equal(missed.length, 1); assert.equal(missed[0]!.severity, 3);
  h.clock.set("2027-10-10T04:30:00.000Z"); await h.run("recomputeAdvancePosition", { ...input, as_of: "2027-10-10" });
  assert.deepEqual(h.timer("SM_DELADV_POSITION_DAILY").slice(2).map((t) => [t.status, t.dueDate]), [["satisfied_late", "2027-10-09"], ["armed", "2027-10-11"]]);
  // guardrail from the loan's own history (no caller flag): Fannie Mae's Stop Advance from May 1, 2027 makes a May 18 draft an advance funded on a Stop Advance loan
  assert.deepEqual(sdaStatusFromEvents(h.events.byLoan("L15")), { status: "active", start_date: "2027-05-01" });
  await h.refused(h.run("recomputeAdvancePosition", { ...input, as_of: "2027-10-11", advances: [...ADV, { id: "a5", activity_period: "2027-05", amount_cents: 147638n, status: "outstanding", kind: "delinquency_pi", drafted_at: "2027-05-18" }] }), "NO_FUNDING_ON_SDA");
  // guardrail: a Fannie Mae receivable netted below zero by our advances is not a receivable
  await h.refused(h.run("recomputeAdvancePosition", { ...input, as_of: "2027-10-11", fnma_sda_receivable_cents: -cents("5904.58") }), "NO_NETTING_FNMA_RECEIVABLE");
  await h.refused(h.run("recomputeAdvancePosition", { ...input, as_of: "2027-10-11", net_fnma_receivable: true }), "NO_NETTING_FNMA_RECEIVABLE");
  // an A/A loan has no position to sweep: no tick, no clock
  const aa = await h.run("recomputeAdvancePosition", { loan_id: "AA1", remittance_type: "AA", servicing_option: "portfolio", as_of: "2027-10-11", advances: [], fnma_sda_receivable_cents: 0n });
  assert.equal(aa.applies, false); assert.equal(aa.daily_clock_armed, false); assert.equal(h.timer("SM_DELADV_POSITION_DAILY").filter((t) => t.loanId === "AA1").length, 0);
});
