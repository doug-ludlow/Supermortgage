// 5.5 Guaranty fee relief
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-5-guaranty-fee-relief.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadRegistry } from "../../kernel/timers/registry.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { TOOLS_5_5 } from "../../app/tools/section5-5.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { applyInvestorTimerOverrides } from "./timers.ts";
import { applySatisfiedOverrides_5_5 } from "./timers-5-5.ts";
import { openReportingPeriod } from "./ops-5-1.ts";
import { ET, gfeeBillLine, gfeeDraft, gfeeReliefPrediction, gfeeRecovery, gfeeBillVariance } from "./ops.ts";
import { gfeeTwoCyclesFrom, gfeeResumeDraftOn, gfeeReliefStatusFromEvents, gfeeReliefFromEvents, gfeePeriodSubject } from "./ops-5-5.ts";

const at = (d: string, hhmm: string) => zonedEpochMs(D(d), hhmm, ET);
const iso = (d: string, hhmm: string) => toIso(at(d, hhmm));
/** The registry as src/domain/timer-overrides.ts composes it for 5.5: the §5 section overrides, then the process overrides (which win). */
const REG = (() => { const r = loadRegistry(); applyInvestorTimerOverrides(r); applySatisfiedOverrides_5_5(r); return r; })();
const ESCALATES_TO = loadAgentsFile().processes.find((p) => p.process === "5.5")!.escalates_to;
const AGENT: Actor = { kind: "agent", id: "custodial-recon" };
const LOAN = "L-SS", SERVICER = "123456789", CUST = "CUST-PI";
/** The 5.5 tools on the bus over a real timer engine (5.5 rows only), the entity store and the escalation service. */
function harness(nowIso: string, loanId = LOAN) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const timers = new TimerEngine(REG, events, { processes: ["5.5"] });
  const decisions: DecisionInput[] = [];
  const ctx: UowContext = { loanId, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const store = new EntityStore(); const escalations = new EscalationService(events, clock);
  const rt: ToolRuntime = { store, ports: {}, escalations, services: {} };
  const agents = new AgentRegistry(); const cmds = new Map(TOOLS_5_5.map((d) => { const cmd = toolCommand(d, rt, ESCALATES_TO); agents.registerTool(d.agent, cmd.name); return [d.name, cmd] as const; })); const bus = new CommandBus(agents);
  const run = async (name: string, input: Record<string, unknown>, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(name)!, actor, input, ctx)).output as Record<string, unknown>;
  const timer = (code: string, subjectId?: string) => { const all = timers.byCode(code).filter((t) => subjectId === undefined || t.subject.id === subjectId); assert.ok(all.length, `${code} armed${subjectId ? ` for ${subjectId}` : ""}`); return all[all.length - 1]!; };
  const ofType = (type: string, loan?: string) => events.ofType(type).filter((e) => loan === undefined || e.loanId === loan);
  const relief = (loan = loanId) => gfeeReliefFromEvents(events.byLoan(loan));
  return { clock, events, ledger, timers, store, escalations, decisions, run, timer, ofType, relief };
}
type H = ReturnType<typeof harness>;
/** The 5.1 example loan into relief through the tools: predicted at four consecutive months (T2 facts), then active from Fannie Mae's April 2027 bill — Fannie Mae forwent $52.08 + $52.04 (two relief months); the servicer advanced $208.05 (months 1–4: 52.08 + 52.04 + 51.99 + 51.94). */
async function enterRelief(h: H, loan = LOAN, balances: { outstanding_fnma_gfee_cents: bigint; servicer_gfee_advances_cents: bigint } = { outstanding_fnma_gfee_cents: 10412n, servicer_gfee_advances_cents: 20805n }) {
  await h.run("reconcileRelief", { loan_id: loan, lpi: "2026-11-01", period_end: "2027-03-31", type: "SS", option: "special", sda_status: "predicted", bill_line_cents: 5208n, servicer_gfee_advances_cents: balances.servicer_gfee_advances_cents });
  await h.run("reconcileRelief", { loan_id: loan, op: "activate", period: "2027-04", bill_line_cents: 0n, fnma_start_date: "2027-04-01", ...balances });
}
/** 5.1's accepted contractual-payment LAR as `acceptEvent` records it on the loan (src/domain/investor/ops-5-1.ts). */
const acceptedLar = (h: H, loan: string, event_id: string, event_type: string, accepted_at: string, activity_period: string) =>
  h.events.append({ type: "investor_events.accepted", loanId: loan, aggregate: { kind: "investor_event", id: event_id }, actor: { kind: "external", id: "fnma-lsdu" }, occurredAt: accepted_at, payload: { event_id, event_type, family: "payment", activity_period, sequence: 1, submission_id: "sub-1", source: "lsdu", status: "accepted", accepted_at, deferral_pending: false, supersedes_event_id: null, warnings: [] } });

test("5.5-T1: Given the example loan current in October 2026, then the November bill line is $52.08 (check figure equal) and the draft is funded by Thu Nov 5, 2026 16:00 ET for the Fri Nov 6 draft (Nov 7 is a Saturday).", async () => {
  assert.equal(gfeeBillLine(25000000n, "0.250"), 5208n);
  const d = gfeeDraft(D("2026-11-01"));
  assert.equal(d.draft_on, "2026-11-06");                                                              // Nov 7 is a Saturday → preceding BD
  assert.equal(toIso(d.funding_gate_ms), toIso(zonedEpochMs(D("2026-11-05"), "16:00", ET)));
  // Through the tools: the October 2026 reporting period opens (5.1) and arms the two period clocks on the servicer's period subject —
  // the bill by CD5 (Thu Nov 5 12:00 ET) and the CD7 draft funded by the funding check (Thu Nov 5 16:00 ET for the Fri Nov 6 draft).
  const h = harness(iso("2026-10-01", "09:00")); const subject = gfeePeriodSubject(SERVICER, "2026-10");
  const opened = openReportingPeriod(h.events, { month_of: D("2026-10-01"), servicer_number: SERVICER, loans: [{ loan_id: LOAN, fnma_loan_number: "1000000001", reporting: "summary" }], opened_at_ms: at("2026-10-01", "09:00") });
  assert.deepEqual(opened.opened.aggregate, subject); assert.equal(opened.anchors.gfee_draft_on, "2026-11-06"); assert.equal(opened.anchors.gfee_bill_due_on, "2026-11-05");
  const cd5 = h.timer("FNMA_F120_GFEE_BILL_RETRIEVE_CD5", subject.id), cd7 = h.timer("FNMA_F120_GFEE_DRAFT_CD7", subject.id);
  assert.deepEqual(cd5.subject, subject); assert.equal(cd5.status, "armed"); assert.equal(cd5.anchorDate, "2026-11-05"); assert.equal(toIso(cd5.dueAt!), iso("2026-11-05", "12:00"));
  assert.deepEqual(cd7.subject, subject); assert.equal(cd7.status, "armed"); assert.equal(cd7.anchorDate, "2026-11-06"); assert.equal(toIso(cd7.dueAt!), iso("2026-11-05", "16:00"));
  // the November bill (October activity) parsed into draft_notifications on Wed Nov 4: the line equals the check figure
  h.clock.set(iso("2026-11-04", "10:00"));
  await assert.rejects(h.run("parseGfeeBill", { servicer_number: SERVICER, period: "2026-10", lines: [] }), RangeError);
  await assert.rejects(h.run("parseGfeeBill", { servicer_number: "12", period: "2026-10", lines: [{ fnma_loan_number: "1000000001", loan_id: LOAN, amount_cents: 5208n }] }), RangeError);
  const bill = await h.run("parseGfeeBill", { servicer_number: SERVICER, period: "2026-10", lines: [{ fnma_loan_number: "1000000001", loan_id: LOAN, amount_cents: 5208n }] });
  assert.equal(bill.notification_id, `gfee-${SERVICER}-2026-10`); assert.equal(bill.draft_type, "mbs_gfee"); assert.equal(bill.draft_date, "2026-11-06"); assert.equal(bill.funding_gate_at, iso("2026-11-05", "16:00")); assert.equal(bill.total_cents, 5208n);
  const figures = await h.run("computeGfeeCheckFigures", { loans: [{ fnma_loan_number: "1000000001", prior_scheduled_upb_cents: 25000000n, gfee_pct: "0.250" }] }) as unknown as { check_figure_cents: bigint }[];
  assert.equal(figures[0]!.check_figure_cents, 5208n); assert.equal((bill.lines as { amount_cents: bigint }[])[0]!.amount_cents, figures[0]!.check_figure_cents);
  const row = h.store.require("draft_notifications", `gfee-${SERVICER}-2026-10`).data; assert.equal(row.draft_type, "mbs_gfee"); assert.equal(row.status, "parsed");
  const parsed = h.ofType("gfee.bill.parsed")[0]!; assert.deepEqual(parsed.aggregate, subject); assert.equal(parsed.payload.draft_type, "mbs_gfee");
  assert.ok(eventMatches(REG.get("FNMA_F120_GFEE_BILL_RETRIEVE_CD5")!.satisfiedPattern!, parsed));
  assert.equal(cd5.status, "satisfied"); assert.equal(cd5.satisfiedByEventId, parsed.id);
  // the parse arms the same-day relief reconciliation on the period; no loan is in relief, so the bill reconciles with nothing to explain
  const rec = h.timer("FNMA_F120_GFEE_RELIEF_RECONCILE_BILL", subject.id); assert.deepEqual(rec.subject, subject); assert.equal(rec.status, "armed"); assert.equal(rec.dueDate, "2026-11-04");
  const r = await h.run("reconcileRelief", { op: "bill", notification_id: `gfee-${SERVICER}-2026-10` });
  assert.equal(r.all_reconciled, true); assert.deepEqual(r.relief_loans, []); assert.equal(rec.status, "satisfied");
  // the draft is funded Thu Nov 5 before 16:00 ET for the Fri Nov 6 draft: remittances.funded{kind=gfee} on the period satisfies the CD7 clock
  h.clock.set(iso("2026-11-05", "12:00"));
  await assert.rejects(h.run("fundDraft", { draft_date: "2026-11-06", expected_draft_cents: 5208n, custodial_available_cents: 5208n, facility_available_cents: 0n }), RangeError);   // no servicer number → no period
  const f = await h.run("fundDraft", { servicer_number: SERVICER, draft_date: "2026-11-06", expected_draft_cents: 5208n, custodial_available_cents: 5208n, facility_available_cents: 0n, custodial_account_id: CUST });
  assert.equal(f.status, "funded"); assert.equal(f.period, "2026-10"); assert.equal(f.funded_at, iso("2026-11-05", "12:00")); assert.equal(toIso((f.advance as { funded_by_ms: number }).funded_by_ms), iso("2026-11-05", "17:00"));
  const funded = h.ofType("remittances.funded")[0]!; assert.deepEqual(funded.aggregate, subject); assert.equal(funded.payload.kind, "gfee"); assert.equal(funded.payload.draft_date, "2026-11-06"); assert.equal(funded.payload.initiator, "fnma");
  assert.ok(eventMatches(REG.get("FNMA_F120_GFEE_DRAFT_CD7")!.satisfiedPattern!, funded));
  assert.equal(cd7.status, "satisfied"); assert.equal(cd7.satisfiedByEventId, funded.id);
  assert.equal(h.ledger.balance({ scope: "corporate", account: "advance_receivable" }), 0n);           // covered: no g-fee advance
});
test("5.5-T2: Given the loan four consecutive months delinquent at Mar 31, 2027, then `gfee_relief_status.predicted` is set, the bill after Fannie Mae's status shows zero, and the engine asserts `sda_status` is also active (special servicing).", () => {
  const r = gfeeReliefPrediction({ lpi: D("2026-11-01"), period_end: D("2027-03-31"), type: "SS", option: "special", sda_status: "predicted", bill_line_cents: 5208n });
  assert.equal(r.months_delinquent, 4); assert.equal(r.gfee_relief_status, "predicted"); assert.equal(r.bill_expected_cents, 0n); assert.equal(r.consistent, true); assert.match(r.assertion, /sda_status/);
  const diverged = gfeeReliefPrediction({ lpi: D("2026-11-01"), period_end: D("2027-03-31"), type: "SS", option: "special", sda_status: "not_applicable", bill_line_cents: 5208n });
  assert.equal(diverged.consistent, false); assert.equal(diverged.alert, true);
});
test("5.5-T3: Given two contractual payments during relief, then the next bill drafts two months of g-fee ($52.08 + $52.04) applied first to `outstanding_fnma_gfee`, and subsequent bills show servicer retention credits until $208.05 of servicer g-fee advances are recovered.", async () => {
  const first = gfeeRecovery({ outstanding_fnma_gfee_cents: 10412n, servicer_gfee_advances_cents: 20805n, payment_gfees_cents: [5208n, 5204n] });
  assert.equal(first.bill_draft_cents, 10412n); assert.equal(first.servicer_retention_cents, 0n); assert.equal(first.remaining_fnma_cents, 0n);
  assert.deepEqual(first.lines.map((l) => l.to_fnma_cents), [5208n, 5204n]);
  const later = gfeeRecovery({ outstanding_fnma_gfee_cents: first.remaining_fnma_cents, servicer_gfee_advances_cents: first.remaining_servicer_advances_cents, payment_gfees_cents: [5199n, 5194n, 5189n, 5185n, 5180n] });
  assert.equal(later.bill_draft_cents, 0n); assert.equal(later.servicer_retention_cents, 20805n); assert.equal(later.remaining_servicer_advances_cents, 0n);
  assert.equal(later.lines[4]!.retained_cents, 20805n - (5199n + 5194n + 5189n + 5185n));
  // Through the tools: the loan is in relief per its own history (predicted at four months, active from the April bill) and 5.1's
  // accepted contractual LAR (Fri Jun 11, 2027) is on the loan; the expectation arms SM_GFEE_RECOVERY_MATCH_2_CYCLES on the
  // acceptance date — two CD7 bill cycles: Aug 7, 2027 is a Saturday → Fri Aug 6.
  const h = harness(iso("2027-06-11", "11:00"));
  acceptedLar(h, LOAN, "ie-gf-1", "payment.contractual", iso("2027-06-11", "10:00"), "2027-06");
  await assert.rejects(h.run("matchDebit", { op: "expect_recovery", event_id: "ie-gf-1", payment_gfees_cents: [5208n, 5204n] }), /not in the Guaranty Fee Relief process/);   // no relief history on the loan
  await enterRelief(h);
  assert.equal(h.relief().status, "active"); assert.equal(h.relief().outstanding_fnma_gfee_cents, 10412n); assert.equal(h.relief().servicer_gfee_advances_cents, 20805n);
  acceptedLar(h, LOAN, "ie-gf-2", "payment.curtailment", iso("2027-06-11", "10:30"), "2027-06");
  await assert.rejects(h.run("matchDebit", { op: "expect_recovery", event_id: "ie-gf-2", payment_gfees_cents: [5208n] }), /not payment\.contractual/);
  await assert.rejects(h.run("matchDebit", { op: "expect_recovery", event_id: "ie-none", payment_gfees_cents: [5208n] }), /no investor_events\.accepted row/);
  const ex = await h.run("matchDebit", { op: "expect_recovery", event_id: "ie-gf-1", payment_gfees_cents: [5208n, 5204n] });
  assert.equal(ex.accepted_on, "2027-06-11"); assert.equal(ex.activity_period, "2027-06"); assert.equal(ex.fnma_recovery_expected_cents, 10412n); assert.equal(ex.servicer_retention_expected_cents, 0n); assert.equal(ex.match_by, "2027-08-06");
  assert.equal(gfeeTwoCyclesFrom(D("2027-06-11")), "2027-08-06");
  const expected = h.ofType("gfee.recovery.expected", LOAN)[0]!;
  assert.equal(expected.payload.gfee_relief_active, true); assert.equal(expected.payload.contractual, true); assert.equal(expected.causationId, h.ofType("investor_events.accepted", LOAN)[0]!.id);
  assert.ok(eventMatches(REG.get("SM_GFEE_RECOVERY_MATCH_2_CYCLES")!.triggerPattern!, expected));
  const rec = h.timer("SM_GFEE_RECOVERY_MATCH_2_CYCLES", LOAN); assert.equal(rec.status, "armed"); assert.equal(rec.anchorDate, "2027-06-11"); assert.equal(rec.dueDate, "2027-08-06");
  // The next bill drafts $104.12 — matched FIFO against outstanding_fnma_gfee (Fannie Mae recovery first), which satisfies the clock;
  // the draft leaves the custodial account (Dr gfee_payable Cr custodial_pi_cash).
  h.clock.set(iso("2027-07-07", "10:00"));
  await assert.rejects(h.run("matchDebit", { debit_cents: 10412n, payment_gfees_cents: [5208n, 5204n] }), RangeError);   // custodial_account_id is required
  const m1 = await h.run("matchDebit", { debit_cents: 10412n, payment_gfees_cents: [5208n, 5204n], debit_id: "dbt-1", settled_on: "2027-07-07", custodial_account_id: CUST });
  assert.equal(m1.matched, true); assert.equal(m1.bill_draft_cents, 10412n); assert.deepEqual((m1.matches as { kind: string; amount_cents: bigint }[]).map((m) => [m.kind, m.amount_cents]), [["fnma_recovery", 10412n]]);
  assert.equal(h.relief().outstanding_fnma_gfee_cents, 0n); assert.equal(h.relief().servicer_gfee_advances_cents, 20805n);
  assert.equal((m1.posted_entry_sets as string[]).length, 1); assert.equal(h.ledger.balance({ scope: "custodial", custodialAccountId: CUST, account: "custodial_pi_cash" }), -10412n);
  const matched = h.ofType("gfee.recovery.matched", LOAN); assert.equal(matched.length, 1); assert.equal(matched[0]!.payload.kind, "fnma_recovery");
  assert.ok(eventMatches(REG.get("SM_GFEE_RECOVERY_MATCH_2_CYCLES")!.satisfiedPattern!, matched[0]!));
  assert.equal(rec.status, "satisfied"); assert.equal(rec.satisfiedByEventId, matched[0]!.id);
  // Subsequent bills: zero draft, servicer retention credits until the $208.05 of advances are recovered — posted Cr servicer_advance_receivable(gfee).
  const m2 = await h.run("matchDebit", { debit_cents: 0n, payment_gfees_cents: [5199n, 5194n, 5189n, 5185n, 5180n], custodial_account_id: CUST, settled_on: "2027-08-06" });
  assert.equal(m2.matched, true); assert.equal(m2.servicer_retention_cents, 20805n); assert.equal(h.relief().servicer_gfee_advances_cents, 0n); assert.equal(m2.ledger_rule, "Cr servicer_advance_receivable(gfee)");
  const ret = h.ofType("gfee.recovery.matched", LOAN)[1]!; assert.equal(ret.payload.kind, "servicer_retention"); assert.equal(ret.payload.amount_cents, 20805n);
  assert.equal(h.ledger.balance({ scope: "corporate", account: "advance_receivable" }), -20805n); assert.equal(h.ledger.balance({ scope: "corporate", account: "corporate_cash" }), 20805n);
  const retention = h.ledger.linesFor({ scope: "corporate", account: "advance_receivable" }); assert.equal(retention.length, 1); assert.equal(retention[0]!.ruleRef, "5.5 rule 4 servicer_retention"); assert.match(retention[0]!.memo!, /servicer_advance_receivable\(gfee\)/);
  assert.equal(h.ledger.balance({ scope: "custodial", custodialAccountId: CUST, account: "custodial_pi_cash" }), -10412n - 20805n);
  // An unmatched debit emits and posts nothing.
  const bad = await h.run("matchDebit", { debit_cents: 9999n, payment_gfees_cents: [5208n, 5204n], custodial_account_id: CUST });
  assert.equal(bad.matched, false); assert.deepEqual(bad.posted_entry_sets, []); assert.equal(h.ofType("gfee.recovery.matched", LOAN).length, 2);
});
test("5.5-T4: Given a bill total $48,210.44 vs computed $47,600.10 (variance $610.34 > $500), then an `officer` escalation opens with the per-loan variance list.", () => {
  const v = gfeeBillVariance({ bill_total_cents: 4821044n, computed_total_cents: 4760010n, per_loan: [{ loan_id: "L1", bill_cents: 66242n, computed_cents: 5208n }, { loan_id: "L2", bill_cents: 5204n, computed_cents: 5204n }] });
  assert.equal(v.variance_cents, 61034n); assert.equal(v.threshold_cents, 50000n); assert.equal(v.escalation, "officer");
  assert.deepEqual(v.per_loan_variances, [{ loan_id: "L1", variance_cents: 61034n }]);
  assert.equal(gfeeBillVariance({ bill_total_cents: 4760020n, computed_total_cents: 4760010n, per_loan: [] }).escalation, null);
});
test("5.5-T5: Given a regular servicing option MBS loan five months delinquent, then g-fee relief is active while P&I advances continue (documented expected divergence, no alert).", () => {
  const r = gfeeReliefPrediction({ lpi: D("2026-10-01"), period_end: D("2027-03-31"), type: "SS", option: "regular", sda_status: "not_applicable", bill_line_cents: 5208n });
  assert.equal(r.months_delinquent, 5); assert.equal(r.gfee_relief_status, "predicted"); assert.equal(r.expected_divergence, true); assert.equal(r.alert, false); assert.equal(r.consistent, true);
  assert.match(r.assertion, /advances continue/);
});
test("5.5-T6: Given the g-fee draft date Jan 7, 2027 (Thursday), then funding gate = Wed Jan 6 16:00 ET; for Feb 7, 2027 (Sunday) the draft date is Fri Feb 5 and the gate Thu Feb 4.", () => {
  const jan = gfeeDraft(D("2027-01-01")); assert.equal(jan.draft_on, "2027-01-07"); assert.equal(toIso(jan.funding_gate_ms), toIso(zonedEpochMs(D("2027-01-06"), "16:00", ET)));
  const feb = gfeeDraft(D("2027-02-01")); assert.equal(feb.draft_on, "2027-02-05"); assert.equal(toIso(feb.funding_gate_ms), toIso(zonedEpochMs(D("2027-02-04"), "16:00", ET)));
});

// ---- timer rows beyond the T-ids: the relief state machine through the tools, and the exit-to-current resume clock ----
test("5.5 state machine: predicted at four consecutive months (once), active only from the bill, exit current only from the loan's became-current fact → FNMA_F120_GFEE_RESUME_ON_CURRENT arms on the period end and the resumed g-fee funding satisfies it", async () => {
  const h = harness(iso("2027-04-05", "09:00"));
  // rule 3: period-end prediction (T2 facts) sets gfee_relief_status.predicted once; a second reconciliation only records the reconciliation.
  const p1 = await h.run("reconcileRelief", { lpi: "2026-11-01", period_end: "2027-03-31", type: "SS", option: "special", sda_status: "predicted", bill_line_cents: 5208n, servicer_gfee_advances_cents: 20805n });
  assert.equal(p1.gfee_relief_status, "predicted"); assert.equal(p1.predicted_set, true); assert.equal(p1.period, "2027-03"); assert.equal(p1.bill_expected_cents, 0n);
  const p2 = await h.run("reconcileRelief", { lpi: "2026-11-01", period_end: "2027-04-30", type: "SS", option: "special", sda_status: "active", bill_line_cents: 0n });
  assert.equal(p2.predicted_set, false); assert.equal(h.ofType("gfee_relief_status.predicted", LOAN).length, 1); assert.equal(h.ofType("gfee_relief.reconciled", LOAN).length, 2);
  assert.equal(gfeeReliefStatusFromEvents(h.events.byLoan(LOAN)).status, "predicted"); assert.equal(h.relief().servicer_gfee_advances_cents, 20805n);
  // authoritative from Fannie Mae's bill: a non-zero line never activates; a zero line does. A loan with no relief history cannot be activated.
  await assert.rejects(h.run("reconcileRelief", { op: "activate", period: "2027-04", bill_line_cents: 5208n, fnma_start_date: "2027-04-01" }), RangeError);
  await assert.rejects(h.run("reconcileRelief", { op: "activate", loan_id: "L-OTHER", period: "2027-04", bill_line_cents: 0n, fnma_start_date: "2027-04-01" }), /not predicted/);
  const act = await h.run("reconcileRelief", { op: "activate", period: "2027-04", bill_line_cents: 0n, fnma_start_date: "2027-04-01", outstanding_fnma_gfee_cents: 5208n });
  assert.equal(act.status, "active"); assert.equal(h.relief().status, "active"); assert.equal(h.relief().outstanding_fnma_gfee_cents, 5208n); assert.equal(h.relief().servicer_gfee_advances_cents, 20805n);
  assert.equal(gfeeReliefStatusFromEvents(h.events.byLoan(LOAN)).status, "active");
  // the resumed draft is refused while the loan is still in relief
  await assert.rejects(h.run("fundDraft", { op: "resume", period: "2027-06", draft_date: "2027-07-07", expected_draft_cents: 5208n, custodial_available_cents: 5208n, facility_available_cents: 0n, custodial_account_id: CUST }), RangeError);
  // rule 5 (current): the exit is recorded from the loan's own became-current fact, never from the caller's say-so
  h.clock.set(iso("2027-06-15", "14:00"));
  await assert.rejects(h.run("reconcileRelief", { op: "exit", reason: "current", exited_on: "2027-06-15" }), /no loan\.became_current fact/);
  assert.equal(h.ofType("gfee_relief_status.exited", LOAN).length, 0); assert.equal(h.timers.byCode("FNMA_F120_GFEE_RESUME_ON_CURRENT").length, 0);
  h.events.append({ type: "loan.became_current", loanId: LOAN, actor: { kind: "system", id: "cashiering" }, payload: { became_current_on: "2027-06-15", cure_date: "2027-06-15", effective_on: "2027-07-01" } });
  await assert.rejects(h.run("reconcileRelief", { op: "exit", reason: "current", exited_on: "2027-06-14" }), /precedes the date the loan became current/);
  // exit on Tue Jun 15, 2027 → period end Jun 30 → resume at the next CD7: Wed Jul 7, 2027 (gate Tue Jul 6 16:00 ET; Jul 5 is the observed holiday).
  const exit = await h.run("reconcileRelief", { op: "exit", reason: "current" });
  assert.equal(exit.exited_on, "2027-06-15"); assert.equal(exit.became_current_on, "2027-06-15"); assert.equal(exit.period_end, "2027-06-30"); assert.equal(exit.resume_draft_on, "2027-07-07"); assert.equal(exit.funding_gate_at, iso("2027-07-06", "16:00")); assert.equal(exit.expected, "gfee_drafting_resumes");
  assert.equal(gfeeResumeDraftOn(D("2027-06-30")), "2027-07-07"); assert.equal(h.relief().status, "exited"); assert.equal(h.relief().exit_reason, "current");
  const exited = h.ofType("gfee_relief_status.exited", LOAN)[0]!; assert.equal(exited.payload.reason, "current"); assert.equal(exited.payload.period_end, "2027-06-30");
  assert.ok(eventMatches(REG.get("FNMA_F120_GFEE_RESUME_ON_CURRENT")!.triggerPattern!, exited));
  const t = h.timer("FNMA_F120_GFEE_RESUME_ON_CURRENT", LOAN); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2027-06-30"); assert.equal(t.dueDate, "2027-07-07");
  // a draft before the resumed CD7 is refused; the Jul 7 draft funded through 5.2's funding check satisfies the clock
  await assert.rejects(h.run("fundDraft", { op: "resume", period: "2027-06", draft_date: "2027-06-07", expected_draft_cents: 5208n, custodial_available_cents: 5208n, facility_available_cents: 0n, custodial_account_id: CUST }), RangeError);
  const r = await h.run("fundDraft", { op: "resume", period: "2027-06", draft_date: "2027-07-07", expected_draft_cents: 5208n, custodial_available_cents: 5208n, facility_available_cents: 0n, custodial_account_id: CUST, now: iso("2027-07-06", "12:00") });
  assert.equal(r.status, "funded"); assert.equal(r.resumed_from, "2027-06-15"); assert.equal(r.resume_draft_on, "2027-07-07");
  const funded = h.ofType("remittances.funded", LOAN); assert.equal(funded.length, 1); assert.equal(funded[0]!.payload.kind, "gfee"); assert.equal(funded[0]!.payload.remittance_type, "ss"); assert.equal(funded[0]!.payload.draft_date, "2027-07-07");
  assert.ok(eventMatches(REG.get("FNMA_F120_GFEE_RESUME_ON_CURRENT")!.satisfiedPattern!, funded[0]!));
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, funded[0]!.id);
  // other exits: no resume clock — reclass carries the fee in the PTR (F-1-25); liquidation with advances outstanding is a Section 15 claim, not a payoff add-on.
  const h2 = harness(iso("2027-06-15", "14:00"), "L-LIQ"); await enterRelief(h2, "L-LIQ");
  await assert.rejects(h2.run("reconcileRelief", { op: "exit", reason: "liquidation" }), /exited_on/);
  const liq = await h2.run("reconcileRelief", { op: "exit", reason: "liquidation", exited_on: "2027-06-15" });
  assert.equal(liq.resume_draft_on, null); assert.equal(liq.expected, "no_further_gfee"); assert.equal(liq.claim_servicer_gfee_advances, true); assert.equal(liq.servicer_gfee_advances_cents, 20805n); assert.equal(h2.timers.byCode("FNMA_F120_GFEE_RESUME_ON_CURRENT").length, 0);
  const h3 = harness(iso("2027-06-15", "14:00"), "L-RECLASS"); await enterRelief(h3, "L-RECLASS");
  assert.equal((await h3.run("reconcileRelief", { op: "exit", reason: "reclass", exited_on: "2027-06-15" })).expected, "ptr_adjusted_to_include_gfee");
  await assert.rejects(h3.run("reconcileRelief", { op: "exit", reason: "reclass", exited_on: "2027-06-16" }), /not in the Guaranty Fee Relief process/);   // already exited
});
test("5.5 bill reconciliation: every predicted/active relief loan is reconciled to the parsed bill — omitted/zero confirms relief, a recovery draft is explained by the accepted contractual payment, a reappearance without one keeps FNMA_F120_GFEE_RELIEF_RECONCILE_BILL open and escalates to officer", async () => {
  const h = harness(iso("2027-04-05", "09:00")); const other = "L-CUR";
  await enterRelief(h);                                                                                  // L-SS active from the April bill
  await h.run("reconcileRelief", { loan_id: other, lpi: "2026-11-01", period_end: "2027-03-31", type: "SS", option: "special", sda_status: "predicted", bill_line_cents: 5208n });   // L-CUR predicted
  openReportingPeriod(h.events, { month_of: D("2027-05-01"), servicer_number: SERVICER, loans: [{ loan_id: LOAN, fnma_loan_number: "1000000001", reporting: "summary" }, { loan_id: other, fnma_loan_number: "1000000002", reporting: "summary" }], opened_at_ms: at("2027-05-01", "09:00") });
  const subject = gfeePeriodSubject(SERVICER, "2027-05");
  // the June bill (May activity): L-SS omitted (relief), L-CUR billed $52.08 with no contractual payment reported → reappeared
  h.clock.set(iso("2027-06-03", "10:00"));
  await h.run("parseGfeeBill", { servicer_number: SERVICER, period: "2027-05", lines: [{ fnma_loan_number: "1000000002", loan_id: other, amount_cents: 5208n }, { fnma_loan_number: "1000000003", loan_id: "L-CURRENT", amount_cents: 5204n }] });
  const rec = h.timer("FNMA_F120_GFEE_RELIEF_RECONCILE_BILL", subject.id); assert.equal(rec.status, "armed"); assert.equal(rec.dueDate, "2027-06-03");
  await assert.rejects(h.run("reconcileRelief", { op: "bill", notification_id: "gfee-nope" }), RangeError);
  const r1 = await h.run("reconcileRelief", { op: "bill", notification_id: `gfee-${SERVICER}-2027-05` });
  assert.equal(r1.all_reconciled, false); assert.equal(r1.officer, true); assert.deepEqual(r1.variances, [other]);
  assert.deepEqual((r1.relief_loans as { loan_id: string; reason: string; consistent: boolean; bill_line_cents: bigint }[]).map((l) => [l.loan_id, l.reason, l.consistent, l.bill_line_cents]), [[other, "reappeared_without_contractual_payment", false, 5208n], [LOAN, "relief_confirmed", true, 0n]]);
  assert.equal((r1.escalations as string[]).length, 1); assert.equal(h.escalations.list().find((e) => e.id === (r1.escalations as string[])[0])!.ownerRole, "officer");
  assert.equal(rec.status, "armed"); assert.equal(h.ofType("gfee_relief.reconciled").length, 2 + 2 /* the two period-end reconciliations */);
  assert.equal(h.ofType("gfee_relief.bill_reconciled")[0]!.payload.all_reconciled, false); assert.deepEqual(h.ofType("gfee_relief.bill_reconciled")[0]!.aggregate, subject);
  assert.equal(h.store.require("draft_notifications", `gfee-${SERVICER}-2027-05`).data.status, "variance");
  // the same bill once L-CUR's contractual payment LAR is accepted (rule 4: the line is Fannie Mae's recovery draft) → every relief loan explained
  acceptedLar(h, other, "ie-cur-1", "payment.contractual", iso("2027-05-20", "10:00"), "2027-05");
  await h.run("matchDebit", { op: "expect_recovery", loan_id: other, event_id: "ie-cur-1", payment_gfees_cents: [5208n] });
  const r2 = await h.run("reconcileRelief", { op: "bill", notification_id: `gfee-${SERVICER}-2027-05` });
  assert.equal(r2.all_reconciled, true); assert.deepEqual(r2.variances, []); assert.equal((r2.relief_loans as { reason: string }[])[0]!.reason, "recovery_draft");
  const done = h.ofType("gfee_relief.bill_reconciled")[1]!; assert.ok(eventMatches(REG.get("FNMA_F120_GFEE_RELIEF_RECONCILE_BILL")!.satisfiedPattern!, done));
  assert.equal(rec.status, "satisfied"); assert.equal(rec.satisfiedByEventId, done.id);
  assert.equal(h.store.require("draft_notifications", `gfee-${SERVICER}-2027-05`).data.status, "reconciled");
});
test("5.5 guardrail: no g-fee advance for a loan Fannie Mae has flagged Stop Advance (SVC-2026-02) — read from the loan the call is about, not only an explicit loan_id", async () => {
  const h = harness(iso("2026-11-05", "10:00"));
  h.events.append({ type: "sda_status.active", loanId: LOAN, actor: AGENT, payload: { start_date: "2026-11-01", report_id: "RD-PI-2026-10" } });
  const draft = { servicer_number: SERVICER, draft_date: "2026-11-06", expected_draft_cents: 5208n, custodial_available_cents: 0n, facility_available_cents: 100000n, custodial_account_id: CUST };
  await assert.rejects(h.run("fundDraft", draft), (e: unknown) => e instanceof CommandRefused && e.code === "NO_ADVANCE_ON_STOP_ADVANCE");
  await assert.rejects(h.run("fundDraft", { ...draft, loan_id: LOAN }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_ADVANCE_ON_STOP_ADVANCE");
  assert.equal(h.ofType("remittances.funded").length, 0);
  // a covered draft (no advance) on the same loan is funded and carries the loan and the period
  const ok = await h.run("fundDraft", { ...draft, custodial_available_cents: 5208n });
  assert.equal(ok.status, "funded"); assert.equal(h.ofType("remittances.funded", LOAN)[0]!.payload.kind, "gfee"); assert.deepEqual(h.ofType("remittances.funded", LOAN)[0]!.aggregate, gfeePeriodSubject(SERVICER, "2026-10"));
  // a delinquent non-relief loan with no Stop Advance flag: the uncollected g-fee is a posted advance (rule 2: Dr servicer_advance_receivable(gfee) Cr custodial_pi_cash transfer)
  const h2 = harness(iso("2026-11-05", "10:00"), "L-DQ");
  await assert.rejects(h2.run("fundDraft", { ...draft, custodial_account_id: undefined }), /custodial_account_id is required/);
  const adv = await h2.run("fundDraft", draft); assert.equal(adv.status, "funded"); assert.equal(adv.amount_cents, 5208n);
  assert.equal(h2.ledger.balance({ scope: "corporate", account: "advance_receivable" }), 5208n); assert.equal(h2.ledger.balance({ scope: "custodial", custodialAccountId: CUST, account: "custodial_pi_cash" }), 5208n);
  assert.equal(h2.ledger.linesFor({ scope: "corporate", account: "advance_receivable" })[0]!.ruleRef, "5.5 rule 2 advance (gfee)");
  // T&I is never a funding source
  await assert.rejects(h.run("fundDraft", { ...draft, custodial_available_cents: 5208n, source_account: "custodial_ti_cash" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_TI_FUNDING");
});
