// 5.4 Stop Delinquency Advance handling
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-4-stop-delinquency-advance-handling.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso, wallClock } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadRegistry } from "../../kernel/timers/registry.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolDef } from "../../app/tools.ts";
import { TOOLS_5_4 } from "../../app/tools/section5-4.ts";
import { TOOLS_5_2 } from "../../app/tools/section5-2.ts";
import { advanceEntrySet } from "./ops-5-2.ts";
import { monthEnd } from "./ops-5-1.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { applyInvestorTimerOverrides } from "./timers.ts";
import { applySatisfiedOverrides_5_4 } from "./timers-5-4.ts";
import { scheduleForward, classifyVariance } from "./remittance.ts";
import { larDeadlineMs } from "./period.ts";
import { predictSda, advanceSchedule, applyRecovery, consecutiveMonthsDelinquent, firstExcludedDraft, sdaBoundaryReconciliation, fmReceivableForPeriods, contractualPaymentsTotal, type SdaState } from "./sda.ts";
import { ET, matchReimbursements, regularOptionSixMonths, sdaStatusVariance, form496Line12, FORM_496_LINE_12_EXPLANATION, sdaPayoffRemittance, servicingFeeComponent, advanceTransfer } from "./ops.ts";
import { sdaEntryModel, bd3ReconcileMs, twoCyclesFrom } from "./ops-5-4.ts";

const at = (d: string, hhmm: string) => zonedEpochMs(D(d), hhmm, ET);
const iso = (d: string, hhmm: string) => toIso(at(d, hhmm));
/** The registry as src/domain/timer-overrides.ts composes it for 5.4: the §5 section overrides, then the process overrides (which win). */
const REG = (() => { const r = loadRegistry(); applyInvestorTimerOverrides(r); applySatisfiedOverrides_5_4(r); return r; })();
const AGENTS = loadAgentsFile();
const escalatesTo = (process: string) => AGENTS.processes.find((p) => p.process === process)!.escalates_to;
const AGENT: Actor = { kind: "agent", id: "custodial-recon" };
const LOAN = "L-SS", REG_LOAN = "L-REG", SERVICER = "123456789";
/** The 5.4 tools (plus any sibling process's, e.g. 5.2's funding gate) on the bus over a real timer engine (5.4 rows only), the entity store and the escalation service. */
function harness(nowIso: string, loanId = LOAN, extraTools: readonly ToolDef[] = []) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const timers = new TimerEngine(REG, events, { processes: ["5.4"] });
  const decisions: DecisionInput[] = [];
  const ctx: UowContext = { loanId, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const store = new EntityStore(); const escalations = new EscalationService(events, clock);
  const rt: ToolRuntime = { store, ports: {}, escalations, services: {} };
  const agents = new AgentRegistry(); const cmds = new Map([...TOOLS_5_4, ...extraTools].map((d) => { const cmd = toolCommand(d, rt, escalatesTo(d.process)); agents.registerTool(d.agent, cmd.name); return [d.name, cmd] as const; })); const bus = new CommandBus(agents);
  const run = async (name: string, input: Record<string, unknown>, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(name)!, actor, input, ctx)).output as Record<string, unknown>;
  const timer = (code: string, subjectId?: string) => { const all = timers.byCode(code).filter((t) => subjectId === undefined || t.subject.id === subjectId); assert.ok(all.length, `${code} armed${subjectId ? ` for ${subjectId}` : ""}`); return all[all.length - 1]!; };
  const ofType = (type: string, loan?: string) => events.ofType(type).filter((e) => loan === undefined || e.loanId === loan);
  return { clock, events, ledger, timers, store, escalations, decisions, run, timer, ofType };
}
/** The 5.2 worked loan in SDA: four advances booked (Nov 2026–Feb 2027 activity), Fannie Mae's receivable at $2,952.86 after two credited months. */
function activeState(): SdaState {
  const adv = advanceSchedule(D("2026-11-01"), 25000000n, "6.500", "6.000", 158017n); const s = scheduleForward(25000000n, "6.500", "6.000", 158017n, 6);
  return { ...predictSda(D("2026-11-01"), "SS", "special", D("2027-03-31")), status: "active", fm_pi_receivable_cents: fmReceivableForPeriods([s[4]!, s[5]!]), servicer_advances_outstanding_cents: adv.total_cents, advances: adv.drafts.map((d) => ({ period: d.period, amount_cents: d.amount_cents, draft_date: d.draft_date, status: "outstanding" as const })) };
}
const RD_REPORT = { report: "sda_status", report_id: "RD-PI-2027-04", period: "2027-04", posted_on: "2027-05-05", source: "connect_pull", document_id: "doc-rd-2027-04", loans: [{ fnma_loan_number: "1000000001", loan_id: LOAN, stop_advance_status: "stop_advance", start_date: "2027-04-01", adjusted_start_date: null, expiration_date: null, outstanding_pi_receivable_cents: 147638n, lpi: "2026-11-01" }] };
const HISTORY = [{ period: "2026-12", lpi: D("2026-11-01"), status: "accepted" }, { period: "2027-01", lpi: D("2026-11-01"), status: "accepted" }, { period: "2027-02", lpi: D("2026-11-01"), status: "accepted" }, { period: "2027-03", lpi: D("2026-11-01"), status: "accepted" }];

test("5.4-T1: Given the S/S special-servicing loan with installments due Dec 1, 2026–Mar 1, 2027 unpaid, then `predicted_entry_period = 2027-03`, four advances totalling $5,904.58 are booked (drafts Jan 15, Feb 18, Mar 18 and Apr 16, 2027 — Apr 18 is a Sunday), and the funding gate excludes the loan from the first draft after Fannie Mae's report shows `active` (expected Tue May 18, 2027 under the four-advance model; if Fannie Mae instead credits the Apr 16 draft, the reconciliation flags the boundary and the advance for that period is reversed).", async () => {
  assert.equal(consecutiveMonthsDelinquent(D("2026-11-01"), D("2027-03-31")), 4);
  const st = predictSda(D("2026-11-01"), "SS", "special", D("2027-03-31"));
  assert.equal(st.status, "predicted"); assert.equal(st.predicted_entry_period, "2027-03");
  const adv = advanceSchedule(D("2026-11-01"), 25000000n, "6.500", "6.000", 158017n);
  assert.equal(adv.total_cents, 590458n); assert.deepEqual(adv.drafts.map((d) => d.amount_cents), [147600n, 147610n, 147619n, 147629n]);
  assert.deepEqual(adv.drafts.map((d) => d.draft_date), ["2027-01-15", "2027-02-18", "2027-03-18", "2027-04-16"]);
  // four-advance model (rule 2): four months delinquent at Mar 31 → Fannie Mae reads it at April BD2 (Fri Apr 2) and sets Stop Advance with Start Date Apr 1;
  // the Apr 16 draft (March activity) is the 4th and last advance, so the first draft the funding gate excludes is the May CD18 → Tue May 18, 2027
  const model = sdaEntryModel("2027-03");
  assert.deepEqual(model, { predicted_entry_period: "2027-03", stop_advance_set_on: "2027-04-02", fnma_start_date: "2027-04-01", last_advanced_draft: "2027-04-16", first_excluded_draft: "2027-05-18" });
  assert.equal(model.last_advanced_draft, adv.drafts[3]!.draft_date);
  const bd3ReportOn = wallClock(bd3ReconcileMs("2027-04"), ET).date; assert.equal(bd3ReportOn, "2027-05-05");   // the BD3 Remittance Detail for April activity (Wed May 5) is the report that shows `active`
  assert.equal(firstExcludedDraft(bd3ReportOn), model.first_excluded_draft);
  const h = harness(iso("2027-03-31", "23:59"), LOAN, TOOLS_5_2);
  const p = await h.run("predictSdaEntry", { lpi: "2026-11-01", type: "SS", option: "special", period_end: "2027-03-31" });
  assert.equal(p.status, "predicted"); assert.equal(p.predicted_entry_period, "2027-03"); assert.deepEqual(p.entry_model, model);
  await h.run("predictSdaEntry", { op: "period_end", period_end: "2027-03-31", servicer_number: SERVICER, loans: [{ loan_id: LOAN, lpi: "2026-11-01", remittance_type: "SS", servicing_option: "special", prior_status: "not_applicable" }] });
  assert.equal(h.ofType("sda_status.predicted", LOAN)[0]!.payload.predicted_entry_period, "2027-03");
  // rule 3: the four advances are booked — `advances` rows (kind delinquency_pi, partner line, status outstanding) with the 5.2 rule-7 posting each: Dr servicer_advance_receivable / Cr corporate cash, Dr custodial_pi_cash / Cr transfer clearing
  h.clock.set(iso("2027-04-16", "17:00"));
  const b = await h.run("rollForwardReceivables", { op: "book_advances", custodial_account_id: "C-PI-SS", funded_from: "partner_line", drafts: adv.drafts });
  assert.equal(b.total_cents, 590458n); assert.equal((b.entry_set_ids as string[]).length, 4);
  assert.deepEqual(h.ofType("advances.booked", LOAN).map((e) => [e.payload.kind, e.payload.period, e.payload.amount_cents, e.payload.drafted_at, e.payload.funded_from, e.payload.status]),
    [["delinquency_pi", "2026-12", 147600n, "2027-01-15", "partner_line", "outstanding"], ["delinquency_pi", "2027-01", 147610n, "2027-02-18", "partner_line", "outstanding"], ["delinquency_pi", "2027-02", 147619n, "2027-03-18", "partner_line", "outstanding"], ["delinquency_pi", "2027-03", 147629n, "2027-04-16", "partner_line", "outstanding"]]);   // activity periods Dec 2026–Mar 2027, each drafted CD18 of the following month
  const sets = h.ledger.sets(); assert.equal(sets.length, 4);
  for (const s of sets) { assert.equal(s.lines.reduce((t, l) => t + l.amountCents, 0n), 0n, "balanced"); assert.ok(s.lines.every((l) => l.ruleRef === "5.2 rule 7 advance"), "rule_ref on every line"); }
  const lines = sets.flatMap((s) => s.lines);
  assert.equal(lines.filter((l) => l.account.scope === "corporate" && l.account.account === "advance_receivable").reduce((t, l) => t + l.amountCents, 0n), 590458n);      // Dr servicer_advance_receivable
  assert.equal(lines.filter((l) => l.account.scope === "custodial" && l.account.account === "custodial_pi_cash").reduce((t, l) => t + l.amountCents, 0n), 590458n);        // Dr custodial_pi_cash
  await assert.rejects(h.run("rollForwardReceivables", { op: "book_advances", custodial_account_id: "C-PI-SS", funded_from: "partner_line", drafts: [adv.drafts[0]!] }), RangeError);                                                  // already booked
  await assert.rejects(h.run("rollForwardReceivables", { op: "book_advances", custodial_account_id: "C-PI-SS", funded_from: "partner_line", drafts: [{ period: "2027-04", draft_date: "2027-05-18", amount_cents: 147638n }] }), RangeError);   // on/after the predicted first excluded draft
  // Fannie Mae's report shows `active` → the loan is Stop Advance from Fannie Mae data, and the funding gate refuses an advance for it
  h.clock.set(iso("2027-05-05", "09:30"));
  await h.run("parseRemittanceDetail", { op: "ingest", report: RD_REPORT });
  await h.run("rollForwardReceivables", { op: "reconcile", report_id: "RD-PI-2027-04", period: "2027-04", loans: [{ loan_id: LOAN, our_status: "predicted", predicted_months: 5, our_lpi: "2026-11-01", fnma: { status: "stop_advance", start_date: "2027-04-01", adjusted_start_date: null, expiration_date: null, outstanding_pi_receivable_cents: 147638n, lpi: "2026-11-01" }, fm_pi_receivable_computed_cents: 147638n, servicer_advances_outstanding_cents: 590458n, reporting_history: HISTORY }] });
  assert.equal(h.ofType("sda_status.active", LOAN)[0]!.payload.start_date, "2027-04-01");
  assert.equal(h.ofType("sda.reconciled", LOAN).length, 1, "the reconciliation is recorded after `active` and is not a status move");
  // the refusals read the loan's event history (no `fnma_status` label in the input): 5.4's own funding/booking ops and 5.2's postLedger gate
  const refused = (e: unknown) => e instanceof CommandRefused && e.code === "NO_ADVANCE_ON_STOP_ADVANCE";
  await assert.rejects(h.run("rollForwardReceivables", { fund_advance: true, state: activeState(), our_lpi: "2026-11-01", predicted_months: 5, draft_date: "2027-05-18" }), refused);
  await assert.rejects(h.run("rollForwardReceivables", { op: "book_advances", custodial_account_id: "C-PI-SS", funded_from: "partner_line", drafts: [{ period: "2027-04", draft_date: "2027-05-18", amount_cents: 147638n }] }), refused);
  await assert.rejects(h.run("postLedger", { transfer_kind: "advance", entry_set: advanceEntrySet({ amount_cents: 147638n, custodial_account_id: "C-PI-SS", effective_date: D("2027-05-17"), period: "2027-04", remittance_type: "ss", cycle: "standard" }) }), refused);
  assert.equal(h.ledger.sets().length, 4, "nothing funded for the loan after Fannie Mae set Stop Advance");
  assert.deepEqual(sdaBoundaryReconciliation({ predicted_first_excluded_draft: model.first_excluded_draft, fnma_credited_draft: D("2027-05-18"), advances: adv.drafts }), { boundary_flagged: false, reverse_advance_period: null });
  assert.deepEqual(sdaBoundaryReconciliation({ predicted_first_excluded_draft: model.first_excluded_draft, fnma_credited_draft: D("2027-04-16"), advances: adv.drafts }), { boundary_flagged: true, reverse_advance_period: "2027-03" });
});
test("5.4-T2: Given the BD3 Remittance Detail shows Stop Advance credits of −$1,245.44/−$230.94, then `fm_pi_receivable = $1,476.38`, no corporate transfer occurs, and the variance classifier labels `sda_credit`.", async () => {
  const s = scheduleForward(25000000n, "6.500", "6.000", 158017n, 5);
  const expected = s[4]!.fnma_interest_cents + s[4]!.fnma_principal_cents;
  assert.equal(s[4]!.fnma_interest_cents, 124544n); assert.equal(s[4]!.fnma_principal_cents, 23094n); assert.equal(expected, 147638n);
  const credits = -124544n + -23094n;
  const v = classifyVariance(expected, expected + credits, { sda_credit_cents: credits });
  assert.equal(v.class, "sda_credit"); assert.equal(v.draft_expectation_cents, 0n); assert.equal(-credits, 147638n);         // fm_pi_receivable grows by the credited P&I
  const h = harness(iso("2027-05-05", "10:00"));
  const lines = (await h.run("parseRemittanceDetail", { lines: [{ fnma_loan_number: "1000000001", expected_pi_cents: 147638n, stop_advance_credit_cents: 147638n }] })) as unknown as { net_cents: bigint; fm_pi_receivable_delta_cents: bigint }[];
  assert.equal(lines[0]!.net_cents, 0n); assert.equal(lines[0]!.fm_pi_receivable_delta_cents, 147638n);
  const roll = await h.run("rollForwardReceivables", { state: { ...activeState(), fm_pi_receivable_cents: 0n }, fm_pi_receivable_delta_cents: 147638n, fnma_status: "stop_advance", predicted_months: 5, our_lpi: "2026-11-01", fnma_lpi: "2026-11-01", reporting_history: HISTORY });
  assert.equal(roll.fm_pi_receivable_cents, 147638n); assert.equal(roll.variance, null);
  const a = advanceTransfer({ expected_draft_cents: v.draft_expectation_cents, custodial_available_cents: 0n, facility_available_cents: 5000000n, at_ms: at("2027-05-17", "16:00"), draft_date: D("2027-05-18") });
  assert.equal(a.amount_cents, 0n); assert.deepEqual(a.ledger, []);
});
test("5.4-T3: Given two full contractual payments collected during SDA, then a contractual-payment LAR with LPI +2 months is submitted by next BD 20:00 ET, Fannie Mae's recovery draft of $2,952.86 is matched, and `fm_pi_receivable` returns to zero before any servicer retention is booked.", async () => {
  const s = scheduleForward(25000000n, "6.500", "6.000", 158017n, 6);
  assert.equal(contractualPaymentsTotal(158017n, 2), 316034n);
  const recoveryDraft = fmReceivableForPeriods([s[4]!, s[5]!]); assert.equal(recoveryDraft, 295286n);
  const state = activeState(); assert.equal(state.fm_pi_receivable_cents, recoveryDraft);
  // the contractual-payment LAR (LPI 2026-11-01 → 2027-01-01) goes on the 5.1 clock: processed Thu 2027-06-10 15:00 ET → Fri 2027-06-11 20:00 ET
  assert.equal(toIso(larDeadlineMs(at("2027-06-10", "15:00"), false)), iso("2027-06-11", "20:00"));
  const h = harness(iso("2027-06-10", "15:05"));
  h.events.append({ type: "sda_status.active", loanId: LOAN, actor: AGENT, payload: { start_date: "2027-04-01", report_id: "RD-PI-2027-04" } });
  const pay = (n: number) => ({ payment_id: `pmt-${n}`, installment_due_date: n === 1 ? "2026-12-01" : "2027-01-01", interest_cents: 135417n, principal_cents: 22600n, processed_at: iso("2027-06-10", "15:00") });
  await assert.rejects(h.run("rollForwardReceivables", { op: "contractual_payment", state, pi_cents: 158017n, lpi_before: "2026-11-01", installments: [{ ...pay(1), principal_cents: 100n }] }), RangeError);   // a partial sits in suspense
  const c = await h.run("rollForwardReceivables", { op: "contractual_payment", state, pi_cents: 158017n, lpi_before: "2026-11-01", installments: [pay(1), pay(2)] });
  assert.equal(c.lpi_after, "2027-01-01"); assert.equal(c.total_cents, 316034n); assert.equal(c.lar_due_at, iso("2027-06-11", "20:00"));
  const lar = h.timer("FNMA_IRM_SDA_CONTRACTUAL_LAR_NEXTBD_2000", LOAN);
  assert.equal(lar.status, "armed"); assert.equal(toIso(lar.dueAt!), iso("2027-06-11", "20:00"));
  // 5.1 accepts the contractual LAR (ops-5-1 `acceptEvent` payload shape) → the LAR clock is satisfied
  h.clock.set(iso("2027-06-11", "10:00"));
  const accepted = h.events.append({ type: "investor_events.accepted", loanId: LOAN, aggregate: { kind: "investor_event", id: "ie-1" }, actor: { kind: "external", id: "fnma" }, payload: { event_id: "ie-1", event_type: "payment.contractual", family: "payment", activity_period: "2027-06", sequence: 1, submission_id: "sub-1", source: "lsdu", status: "accepted", accepted_at: iso("2027-06-11", "10:00"), deferral_pending: false, supersedes_event_id: null, warnings: [] } });
  assert.equal(lar.status, "satisfied"); assert.equal(lar.satisfiedByEventId, accepted.id);
  // Fannie Mae then drafts recovery = its receivable for the two periods; the match is expected within 2 draft cycles (CD18 of Aug 2027)
  const ex = await h.run("matchAdjustments", { op: "expect_recovery", state, accepted: { event_id: "ie-1", event_type: "payment.contractual", status: "accepted", accepted_at: iso("2027-06-11", "10:00"), activity_period: "2027-06" }, cleared_periods: [s[4]!, s[5]!] });
  assert.equal(ex.fnma_recovery_expected_cents, 295286n); assert.equal(ex.servicer_retention_expected_cents, 0n); assert.equal(ex.match_by, "2027-08-18");
  const rec = h.timer("SM_SDA_RECOVERY_MATCH_2_CYCLES", LOAN); assert.equal(rec.status, "armed"); assert.equal(rec.dueDate, "2027-08-18");
  h.clock.set(iso("2027-06-18", "12:00"));
  const m = await h.run("matchAdjustments", { op: "recovery_draft", state, draft_cents: recoveryDraft, debit_id: "dbt-0618", settled_on: "2027-06-18", report_line_id: "ca-1" });
  assert.equal(m.to_fnma_receivable_cents, 295286n); assert.equal(m.to_servicer_advances_cents, 0n); assert.equal(m.fm_pi_receivable_cents, 0n);
  assert.deepEqual((m.matches as { kind: string }[]).map((x) => x.kind), ["fnma_recovery"]);
  assert.equal(rec.status, "satisfied"); assert.equal(h.ofType("sda.adjustment.matched", LOAN)[0]!.payload.kind, "fnma_recovery");
  assert.equal(h.ofType("remittances.drafted", LOAN)[0]!.payload.sda_recovery, true);
  assert.ok(state.advances.every((a) => a.status === "outstanding"), "no servicer retention before fm_pi_receivable is zero");
  const r2 = applyRecovery(state, 147600n);
  assert.equal(r2.to_fnma_receivable_cents, 0n); assert.equal(r2.to_servicer_advances_cents, 147600n); assert.equal(state.advances[0]!.status, "recovered_from_borrower"); assert.equal(state.servicer_advances_outstanding_cents, 590458n - 147600n);
});
test("5.4-T4: Given a completed payment deferral on an SDA loan, then all `advances` rows move to `reimbursed_by_fnma` within two cycles or an IRR package is escalated.", async () => {
  const advances = [{ period: "2026-11", amount_cents: 147600n, status: "outstanding" as const }, { period: "2026-12", amount_cents: 147610n, status: "outstanding" as const }, { period: "2027-01", amount_cents: 147619n, status: "outstanding" as const }, { period: "2027-02", amount_cents: 147629n, status: "outstanding" as const }];
  const ok = matchReimbursements({ advances, credits: [590458n], cycles_elapsed: 1 });
  assert.equal(ok.all_reimbursed, true); assert.ok(ok.advances.every((a) => a.status === "reimbursed_by_fnma")); assert.equal(ok.unmatched_credit_cents, 0n); assert.equal(ok.escalation, null);
  const partial = matchReimbursements({ advances, credits: [295210n], cycles_elapsed: 2 });
  assert.equal(partial.all_reimbursed, false); assert.equal(partial.escalation, "irr_package"); assert.equal(partial.advances.filter((a) => a.status === "reimbursed_by_fnma").length, 2);
  assert.equal(matchReimbursements({ advances, credits: [], cycles_elapsed: 1 }).escalation, null);
  // the deferral completed Jul 20, 2027 ends SDA; reimbursement is due within two S/S draft cycles → CD18 of Sep 2027 = Fri Sep 17 (Sep 18 is a Saturday)
  const h = harness(iso("2027-07-22", "16:00"));   // recorded two days after the exit: the clock anchors on `exited_on`, not on the recording
  const x = await h.run("rollForwardReceivables", { op: "exit", state: activeState(), reason: "deferral", exited_on: "2027-07-20" });
  assert.equal(x.expected, "fnma_reimbursement"); assert.equal(x.reimbursement_match_by, "2027-09-17"); assert.equal(x.advances_outstanding_cents, 590458n);
  assert.equal(twoCyclesFrom(D("2027-07-20")), "2027-09-17");
  const t = h.timer("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES", LOAN); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2027-07-20"); assert.equal(t.dueDate, "2027-09-17");
  h.clock.set(iso("2027-08-18", "12:00"));
  const m = await h.run("matchAdjustments", { advances, credits: [590458n], cycles_elapsed: 1, exit_reason: "deferral", report_line_ids: ["ca-208-1"] });
  assert.equal(m.all_reimbursed, true); assert.equal(m.escalation_id, null); assert.equal(t.status, "satisfied");
  assert.equal(h.ofType("advances.reimbursed_by_fnma", LOAN)[0]!.payload.all_outstanding, true);
  // …or, two cycles on with credits short, the Investor Reporting Representative package goes to `officer`
  const g = harness(iso("2027-09-17", "17:00"));
  const p = await g.run("matchAdjustments", { advances, credits: [295210n], cycles_elapsed: 2, exit_reason: "deferral" });
  assert.equal(p.escalation, "irr_package"); assert.equal(typeof p.escalation_id, "string");
  const esc = g.escalations.opened[0]!; assert.equal(esc.kind, "officer"); assert.equal(esc.ownerRole, "officer"); assert.equal(esc.payload.package, "irr_package"); assert.deepEqual(esc.payload.outstanding_periods, ["2027-01", "2027-02"]);
});
test("5.4-T5: Given a regular servicing option S/S loan six consecutive months delinquent, then no SDA is predicted, advances continue, and the deselection decision task is created on CD11 and due CD15.", async () => {
  const r = regularOptionSixMonths({ lpi: D("2026-10-01"), period_end: D("2027-04-30"), type: "SS", option: "regular" });
  assert.equal(r.months_delinquent, 6); assert.equal(r.sda, "not_applicable"); assert.equal(r.advances_continue, true); assert.equal(r.reclass_selection_expected, true);
  assert.deepEqual(r.deselection_task, { created_on: "2027-05-11", due_on: "2027-05-15" });
  assert.equal(regularOptionSixMonths({ lpi: D("2026-10-01"), period_end: D("2027-04-30"), type: "SS", option: "special" }).sda, "predicted");
  const h = harness(iso("2027-04-30", "23:59"), REG_LOAN);
  const run = await h.run("predictSdaEntry", { op: "period_end", period_end: "2027-04-30", servicer_number: SERVICER, loans: [{ loan_id: REG_LOAN, lpi: "2026-10-01", remittance_type: "SS", servicing_option: "regular", prior_status: "not_applicable" }] });
  const res = (run.results as { loan_id: string; status: string; action: string; consecutive_months_delinquent: number; reclass_selection_expected: boolean }[])[0]!;
  assert.equal(res.status, "not_applicable"); assert.equal(res.action, "none"); assert.equal(res.consecutive_months_delinquent, 6); assert.equal(res.reclass_selection_expected, true);
  assert.equal(h.ofType("sda_status.predicted", REG_LOAN).length, 0);
  const exp = h.ofType("reclass.selection.expected", REG_LOAN)[0]!; assert.equal(exp.payload.servicing_option, "regular"); assert.deepEqual(exp.payload.deselection_window, { created_on: "2027-05-11", due_on: "2027-05-15" });
  const sel = h.timer("FNMA_A1306_RECLASS_SELECTION_6M", REG_LOAN); assert.equal(sel.dueDate, "2027-04-30");
  // the Eligible for Deselection report posts on CD11 → the decision task for the loan, due CD15
  h.clock.set(iso("2027-05-11", "09:00"));
  const ing = await h.run("parseRemittanceDetail", { op: "ingest", report: { report: "eligible_for_deselection", report_id: "EFD-2027-05", period: "2027-04", posted_on: "2027-05-11", loans: [{ fnma_loan_number: "1000000002", loan_id: REG_LOAN }] } });
  assert.deepEqual(ing.eligible, [REG_LOAN]); assert.equal(ing.decide_by, "2027-05-15");
  const task = h.ofType("reclass.deselection.eligible", REG_LOAN)[0]!; assert.equal(task.payload.posted_on, "2027-05-11"); assert.equal(task.payload.decide_by, "2027-05-15");
  const des = h.timer("FNMA_F125_RECLASS_DESELECT_CD15", REG_LOAN); assert.equal(des.status, "armed"); assert.equal(des.dueDate, "2027-05-15"); assert.equal(des.anchorDate, "2027-05-11");
  h.clock.set(iso("2027-05-13", "11:00"));
  const dec = await h.run("openPortalTask", { op: "deselection", report_id: "EFD-2027-05", decision: "deselect", decided_on: "2027-05-13", rationale: "repayment plan agreed; keep the loan in the MBS pool" });
  assert.equal(dec.portal_task, true); assert.equal(des.status, "satisfied");
  assert.equal(h.escalations.opened[0]!.kind, "human_portal_task"); assert.equal(h.escalations.opened[0]!.ownerRole, "fnma_portal_operator");
  // a reclass purchase advice (effective the 1st of the reclass month) closes the informational selection row
  h.clock.set(iso("2027-06-03", "09:00")); const breaches = h.timers.evaluate(h.clock.now()); assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity]), [["FNMA_A1306_RECLASS_SELECTION_6M", 3]]);
  await h.run("parseRemittanceDetail", { op: "purchase_advice", advice: { kind: "reclass", fnma_loan_number: "1000000002", loan_id: REG_LOAN, effective_date: "2027-06-01", received_on: "2027-06-03", reimbursed_advances_cents: 885660n } });
  assert.equal(sel.status, "satisfied_late");
});
test("5.4-T6: Given Fannie Mae's report shows Stop Advance for a loan we predicted as three months delinquent, then a sev-2 variance opens comparing LPI dates and the 5.1 reporting history.", async () => {
  const history = [{ period: "2026-11", lpi: D("2026-10-01"), status: "accepted" }, { period: "2026-12", lpi: D("2026-10-01"), status: "accepted" }, { period: "2027-01", lpi: D("2026-10-01"), status: "accepted" }];
  const v = sdaStatusVariance({ predicted: "not_applicable", predicted_months: 3, fnma_status: "stop_advance", our_lpi: D("2026-10-01"), fnma_lpi: D("2026-09-01"), reporting_history: history });
  assert.equal(v.variance!.severity, "sev2"); assert.equal(v.variance!.kind, "sda_status_mismatch"); assert.equal(v.variance!.our_lpi, "2026-10-01"); assert.equal(v.variance!.fnma_lpi, "2026-09-01");
  assert.equal(v.variance!.reporting_history.length, 3); assert.equal(v.authoritative, "fnma");
  assert.equal(sdaStatusVariance({ predicted: "active", predicted_months: 4, fnma_status: "stop_advance", our_lpi: D("2026-10-01"), fnma_lpi: D("2026-10-01"), reporting_history: history }).variance, null);
  const h = harness(iso("2027-02-03", "10:00"));
  await h.run("parseRemittanceDetail", { op: "ingest", report: { report: "sda_status", report_id: "RD-PI-2027-01", period: "2027-01", posted_on: "2027-02-03", loans: [{ fnma_loan_number: "1000000001", loan_id: LOAN, stop_advance_status: "stop_advance", start_date: "2027-01-01", outstanding_pi_receivable_cents: 147638n, lpi: "2026-09-01" }] } });
  const r = await h.run("rollForwardReceivables", { op: "reconcile", report_id: "RD-PI-2027-01", period: "2027-01", loans: [{ loan_id: LOAN, our_status: "not_applicable", predicted_months: 3, our_lpi: "2026-10-01", fnma: { status: "stop_advance", start_date: "2027-01-01", adjusted_start_date: null, expiration_date: null, outstanding_pi_receivable_cents: 147638n, lpi: "2026-09-01" }, fm_pi_receivable_computed_cents: 0n, servicer_advances_outstanding_cents: 442829n, reporting_history: history }] });
  const d = (r.decisions as { action: string; variance: { kind: string; severity: string; our_lpi: string; fnma_lpi: string } }[])[0]!;
  assert.equal(d.action, "open_sev2_variance"); assert.equal(d.variance.kind, "sda_status_mismatch"); assert.equal(d.variance.our_lpi, "2026-10-01"); assert.equal(d.variance.fnma_lpi, "2026-09-01");
  const esc = h.escalations.opened[0]!; assert.equal(esc.kind, "sev2"); assert.equal(esc.severity, "sev2"); assert.equal(esc.loanId, LOAN); assert.equal(esc.payload.our_lpi, "2026-10-01"); assert.equal(esc.payload.fnma_lpi, "2026-09-01"); assert.equal((esc.payload.reporting_history as unknown[]).length, 3);
  assert.equal(h.ofType("sda_status.active", LOAN).length, 1, "Fannie Mae's status is authoritative: the loan is Stop Advance from the report");
  assert.equal(h.ofType("sda.reconciled", LOAN)[0]!.payload.severity, "sev2");
});
test("5.4-T7: Given month-end Form 496 preparation, then Section II line 12 equals Σ Fannie Mae-reported outstanding P&I receivables for SDA loans with the standard explanation.", async () => {
  const rows = [{ loan_id: "L1", sda_status: "active" as const, fm_pi_receivable_reported_cents: 147638n }, { loan_id: "L2", sda_status: "active" as const, fm_pi_receivable_reported_cents: 147648n }, { loan_id: "L3", sda_status: "not_applicable" as const, fm_pi_receivable_reported_cents: 100n }];
  const line = form496Line12(rows);
  assert.equal(line.amount_cents, 295286n); assert.deepEqual(line.loans, ["L1", "L2"]); assert.equal(line.explanation, FORM_496_LINE_12_EXPLANATION); assert.equal(line.source, "remittance_detail_pi");
  const h = harness(iso("2027-06-30", "18:00"));
  const t = await h.run("buildForm496Line12", { rows });
  assert.equal(t.amount_cents, 295286n); assert.equal(t.source, "remittance_detail_pi"); assert.equal(h.decisions.length, 0, "a read tool leaves no decision row");
  await assert.rejects(h.run("buildForm496Line12", { rows: [] }), RangeError);
});
test("5.4-T8: Given a payoff of an SDA loan, then the payoff remittance includes Fannie Mae's outstanding P&I receivable and the servicer's advances are recovered from the payoff proceeds/borrower per the payoff calculator.", async () => {
  const p = sdaPayoffRemittance({ payoff_upb_cents: 24885767n, payoff_interest_cents: 124429n, fm_pi_receivable_cents: 295286n, servicer_advances_outstanding_cents: 590458n, proceeds_cents: 24885767n + 124429n + 295286n + 590458n });
  assert.equal(p.remittance_cents, 24885767n + 124429n + 295286n); assert.equal(p.includes_fm_receivable, true);
  assert.equal(p.servicer_recovery_cents, 590458n); assert.equal(p.recovery_source, "payoff_proceeds"); assert.equal(p.shortfall_cents, 0n);
  const short = sdaPayoffRemittance({ payoff_upb_cents: 24885767n, payoff_interest_cents: 124429n, fm_pi_receivable_cents: 295286n, servicer_advances_outstanding_cents: 590458n, proceeds_cents: 24885767n + 124429n + 295286n });
  assert.equal(short.recovery_source, "borrower_balance"); assert.equal(short.shortfall_cents, 590458n);
  const h = harness(iso("2027-06-25", "14:00"));
  await assert.rejects(h.run("rollForwardReceivables", { op: "exit", state: activeState(), reason: "payoff", exited_on: "2027-06-25" }), RangeError);   // a payoff exit needs the payoff figures
  const x = await h.run("rollForwardReceivables", { op: "exit", state: activeState(), reason: "payoff", exited_on: "2027-06-25", payoff: { payoff_upb_cents: 24885767n, payoff_interest_cents: 124429n, proceeds_cents: 24885767n + 124429n + 295286n + 590458n } });
  assert.equal(x.expected, "fnma_drafts_receivable_from_proceeds"); assert.deepEqual(x.payoff, p);
  const ev = h.ofType("sda_status.exited", LOAN)[0]!; assert.equal(ev.payload.reason, "payoff"); assert.equal(ev.payload.payoff_remittance_cents, p.remittance_cents); assert.equal(ev.payload.fm_pi_receivable_cents, 295286n);
});

test("5.4 worked examples 3–4: Stop Advance month P&I $1,476.38 then $1,476.48, two contractual payments $3,160.34, servicing-fee component $51.90", () => {
  const s = scheduleForward(25000000n, "6.500", "6.000", 158017n, 6);
  assert.equal(s[4]!.prior_scheduled_upb_cents, 24908861n); assert.equal(s[4]!.fnma_interest_cents, 124544n); assert.equal(s[4]!.fnma_principal_cents, 23094n); assert.equal(s[4]!.fnma_interest_cents + s[4]!.fnma_principal_cents, 147638n);
  assert.equal(s[5]!.prior_scheduled_upb_cents, 24885767n); assert.equal(s[5]!.fnma_interest_cents + s[5]!.fnma_principal_cents, 147648n);
  assert.equal(fmReceivableForPeriods([s[4]!, s[5]!]), 295286n); assert.equal(contractualPaymentsTotal(158017n, 2), 316034n);
  assert.equal(servicingFeeComponent(24908861n, "6.500", "6.000", "0.250"), 5190n);
});

test("5.4 timers: FNMA_C301_SDA_PREDICT_EOM arms on period.month_end and the period-end run satisfies it (set/cleared per special-servicing S/S loan; Fannie Mae's `active` is never set by prediction)", async () => {
  const h = harness(iso("2027-03-31", "23:59"));
  // 5.1's month-end job is the trigger, on the servicer's period subject (ops-5-1 `periodAggregate`: "<servicer>:<period>")
  const { event: me } = monthEnd(h.events, { month_of: D("2027-03-01"), servicer_number: SERVICER, now_ms: at("2027-03-31", "23:59") });
  assert.deepEqual(me.aggregate, { kind: "period", id: `${SERVICER}:2027-03` });
  const t = h.timer("FNMA_C301_SDA_PREDICT_EOM", `${SERVICER}:2027-03`); assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2027-03-31"); assert.equal(toIso(t.dueAt!), iso("2027-03-31", "23:59"));
  const loans = [
    { loan_id: LOAN, lpi: "2026-11-01", remittance_type: "SS", servicing_option: "special", prior_status: "not_applicable" },              // four months → predicted, entry 2027-03
    { loan_id: "L-3", lpi: "2026-12-01", remittance_type: "SS", servicing_option: "special", prior_status: "not_applicable" },             // three months → nothing
    { loan_id: "L-CLR", lpi: "2027-03-01", remittance_type: "SS", servicing_option: "special", prior_status: "predicted" },                // paid up before Fannie Mae set the status → cleared
    { loan_id: "L-ACT", lpi: "2026-10-01", remittance_type: "SS", servicing_option: "special", prior_status: "active" },                   // Fannie Mae's status stands
    { loan_id: "L-SA", lpi: "2026-09-01", remittance_type: "SA", servicing_option: "special", prior_status: "not_applicable" } ];          // S/A: IRM three-month interest rule, never SDA
  await assert.rejects(h.run("predictSdaEntry", { op: "period_end", period_end: "2027-03-31", loans }), RangeError);   // the run must address the servicer's period subject
  assert.equal(t.status, "armed");
  const r = await h.run("predictSdaEntry", { op: "period_end", period_end: "2027-03-31", servicer_number: SERVICER, loans });
  assert.deepEqual(r.subject, { kind: "period", id: `${SERVICER}:2027-03` }); assert.equal(r.next_period_end, "2027-04-30");
  const by = new Map((r.results as { loan_id: string; action: string; status: string; predicted_entry_period: string | null }[]).map((x) => [x.loan_id, x]));
  assert.deepEqual([by.get(LOAN)!.action, by.get(LOAN)!.status, by.get(LOAN)!.predicted_entry_period], ["set", "predicted", "2027-03"]);
  assert.deepEqual([by.get("L-3")!.action, by.get("L-CLR")!.action, by.get("L-ACT")!.action, by.get("L-SA")!.action], ["none", "cleared", "kept", "none"]);
  assert.equal(r.set, 1); assert.equal(r.cleared, 1);
  const set = h.ofType("sda_status.predicted", LOAN)[0]!; assert.equal(set.payload.prediction, "set"); assert.equal(set.payload.first_excluded_draft, "2027-05-18"); assert.equal(set.payload.stop_advance_set_on, "2027-04-02");
  assert.equal(h.ofType("sda_status.prediction_cleared", "L-CLR").length, 1); assert.equal(h.ofType("sda_status.active").length, 0);
  assert.equal(t.status, "satisfied");
  // recurring: re-armed for the next period end (Apr 30 23:59 ET, from the run's `next_period_end`), not for the one just satisfied — nothing breaches on the 1st
  const next = h.timers.byCode("FNMA_C301_SDA_PREDICT_EOM").filter((x) => x.status === "armed"); assert.equal(next.length, 1);
  assert.deepEqual(next[0]!.subject, t.subject); assert.equal(next[0]!.dueDate, "2027-04-30"); assert.equal(toIso(next[0]!.dueAt!), iso("2027-04-30", "23:59"));
  assert.deepEqual(h.timers.evaluate(iso("2027-04-01", "00:30")), []);
  assert.deepEqual(h.timers.evaluate(iso("2027-04-30", "23:59")).map((b) => [b.instance.code, b.severity, b.instance.dueDate]), [["FNMA_C301_SDA_PREDICT_EOM", 3, "2027-04-30"]]);
  // coverage: the run is over every predicted/active loan, checked against the event store — L-SS is predicted now, so a run that omits it, or contradicts its recorded status, is refused
  await assert.rejects(h.run("predictSdaEntry", { op: "period_end", period_end: "2027-04-30", servicer_number: SERVICER, loans: loans.filter((l) => l.loan_id !== LOAN) }), /missing L-SS/);
  await assert.rejects(h.run("predictSdaEntry", { op: "period_end", period_end: "2027-04-30", servicer_number: SERVICER, loans }), /prior_status not_applicable contradicts/);
  await assert.rejects(h.run("predictSdaEntry", { op: "period_end", period_end: "2027-03-30", servicer_number: SERVICER, loans: [] }), RangeError);
});
test("5.4 timers: FNMA_F120_SDA_STATUS_RECONCILE_BD3 arms on the Remittance Detail – P&I report for BD3 12:00 ET and the report-level reconciliation satisfies it; `sda_status.active` arms FNMA_F120_SDA_FUNDING_HOLD, which lifts on exit", async () => {
  // April 2027 activity: BD3 of May 2027 is Wed May 5 (May 1 is a Saturday)
  assert.equal(toIso(bd3ReconcileMs("2027-04")), iso("2027-05-05", "12:00"));
  const h = harness(iso("2027-05-04", "09:00"));
  const ing = await h.run("parseRemittanceDetail", { op: "ingest", report: RD_REPORT });
  assert.equal(ing.reconcile_by_at, iso("2027-05-05", "12:00")); assert.deepEqual(ing.subject, { kind: "fnma_report", id: "RD-PI-2027-04" });
  const t = h.timer("FNMA_F120_SDA_STATUS_RECONCILE_BD3", "RD-PI-2027-04"); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2027-04-30"); assert.equal(toIso(t.dueAt!), iso("2027-05-05", "12:00"));
  await assert.rejects(h.run("parseRemittanceDetail", { op: "ingest", report: { ...RD_REPORT, loans: [{ fnma_loan_number: "1000000001", loan_id: LOAN }] } }), RangeError);   // the P&I report must carry the Stop Advance status
  const line = h.ofType("fnma.connect.report.line", LOAN)[0]!; assert.equal(line.payload.stop_advance_status, "stop_advance"); assert.equal(line.payload.report_id, "RD-PI-2027-04");
  h.clock.set(iso("2027-05-05", "10:30"));
  const lp = { loan_id: "L-P", our_status: "predicted", predicted_months: 4, our_lpi: "2026-12-01", fnma: { status: "advancing", start_date: null, adjusted_start_date: null, expiration_date: null, outstanding_pi_receivable_cents: 0n, lpi: "2026-12-01" }, fm_pi_receivable_computed_cents: 0n, servicer_advances_outstanding_cents: 590458n, reporting_history: HISTORY };
  // "every predicted/active loan reconciled" is verified: the report lists L-SS as Stop Advance, so a reconciliation that omits it is refused (and an un-ingested report cannot be reconciled at all)
  await assert.rejects(h.run("rollForwardReceivables", { op: "reconcile", report_id: "RD-PI-2027-04", period: "2027-04", loans: [lp] }), /missing L-SS/);
  await assert.rejects(h.run("rollForwardReceivables", { op: "reconcile", report_id: "RD-PI-2027-03", period: "2027-03", loans: [lp] }), /has not been ingested/);
  await assert.rejects(h.run("rollForwardReceivables", { op: "reconcile", report_id: "RD-PI-2027-04", period: "2027-04", loans: [lp, { ...lp, loan_id: LOAN, our_status: "predicted", predicted_months: 5, our_lpi: "2026-11-01" }] }), /contradicts the ingested report line/);
  assert.equal(t.status, "armed"); assert.equal(h.ofType("sda_status.active").length, 0);
  const r = await h.run("rollForwardReceivables", { op: "reconcile", report_id: "RD-PI-2027-04", period: "2027-04", loans: [
    { loan_id: LOAN, our_status: "predicted", predicted_months: 5, our_lpi: "2026-11-01", fnma: null, fm_pi_receivable_computed_cents: 147638n, servicer_advances_outstanding_cents: 590458n, reporting_history: HISTORY },   // Fannie Mae's line comes from the ingested report
    lp ] });
  assert.deepEqual(r.activated, [LOAN]); assert.deepEqual((r.variances as { loan_id: string }[]).map((v) => v.loan_id), ["L-P"]); assert.equal(r.all_reconciled, true); assert.deepEqual(r.covered, [LOAN]);
  assert.equal(h.ofType("sda_status.active", LOAN)[0]!.payload.start_date, "2027-04-01");
  assert.equal(t.status, "satisfied"); assert.equal(h.ofType("sda.reconciled").filter((e) => e.payload.all_reconciled === true).length, 1);
  assert.equal(h.escalations.opened.length, 1); assert.equal(h.escalations.opened[0]!.loanId, "L-P");                    // a predicted loan still drafted in full → variance triage (state machine guard)
  const hold = h.timer("FNMA_F120_SDA_FUNDING_HOLD", LOAN); assert.equal(hold.status, "armed"); assert.equal(hold.dueAt, undefined);
  assert.equal(h.decisions.filter((d) => d.action === "rollForwardReceivables:reconcile").length, 1);
  h.clock.set(iso("2027-06-15", "12:00"));
  await h.run("rollForwardReceivables", { op: "exit", state: activeState(), reason: "current", exited_on: "2027-06-15" });
  assert.equal(hold.status, "satisfied");
  assert.equal(h.timers.byCode("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES").length, 0, "a `current` exit reimburses nothing: no reimbursement clock");
});
test("5.4 timers: FNMA_F120_SDA_EXIT_RESUME_DRAFT arms when the loan becomes current (anchor period end → next CD18) and the resumed scheduled draft funded through 5.2's funding check satisfies it", async () => {
  const h = harness(iso("2027-06-15", "12:00"));
  await assert.rejects(h.run("rollForwardReceivables", { op: "resume_draft", period: "2027-06", draft_date: "2027-07-16", expected_draft_cents: 147658n, custodial_available_cents: 200000n, facility_available_cents: 5000000n, custodial_account_id: "C-PI-SS" }), RangeError);   // not exited
  const x = await h.run("rollForwardReceivables", { op: "exit", state: activeState(), reason: "current", exited_on: "2027-06-15" });
  assert.equal(x.expected, "recovery_from_contractual_payments"); assert.equal(x.resume_draft_on, "2027-07-16"); assert.equal(x.period_end, "2027-06-30");   // Jul 18, 2027 is a Sunday → Fri Jul 16
  const t = h.timer("FNMA_F120_SDA_EXIT_RESUME_DRAFT", LOAN); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2027-06-30"); assert.equal(t.dueDate, "2027-07-16");
  h.clock.set(iso("2027-07-15", "15:00"));
  await assert.rejects(h.run("rollForwardReceivables", { op: "resume_draft", period: "2027-05", draft_date: "2027-06-18", expected_draft_cents: 147658n, custodial_available_cents: 200000n, facility_available_cents: 5000000n, custodial_account_id: "C-PI-SS" }), RangeError);   // drafts resume from the month after
  const f = await h.run("rollForwardReceivables", { op: "resume_draft", period: "2027-06", draft_date: "2027-07-16", expected_draft_cents: 147658n, custodial_available_cents: 200000n, facility_available_cents: 5000000n, custodial_account_id: "C-PI-SS" });
  assert.equal(f.status, "funded"); assert.equal(f.resumed_from, "2027-06-15"); assert.deepEqual(f.cycle_subject, { kind: "remittance_cycle", id: "2027-06:ss:standard" });
  const funded = h.ofType("remittances.funded", LOAN)[0]!; assert.equal(funded.payload.remittance_type, "ss"); assert.equal(funded.payload.kind, "pi_scheduled"); assert.equal(funded.payload.sda_resumed, true); assert.equal(funded.payload.draft_date, "2027-07-16");
  assert.equal(funded.aggregate, undefined, "loan-scoped: the resumed loan's funding never stands in for 5.2's whole-cycle FNMA_F120_SS_DRAFT_CD18 fact on the remittance-cycle subject");
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, funded.id);
});
