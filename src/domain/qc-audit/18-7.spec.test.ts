// 18.7 Net-worth / liquidity eligibility
// spec/sections/18-qc-audit-regulatory-reporting/18-7-net-worth-liquidity-eligibility.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, daysBetween } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import type { DomainEvent } from "../../kernel/events/types.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { netWorth, form1002Due, capitalPlanDue } from "./networth.ts";
import {
  staleGlRun, glCloseDeadline, quarterlyTest, eligibilityTest, declineTriggers, projectedNextQuarter, breachDetected, breachNotified, warningDetected, largeServicerCrossing,
  form1002Clock, form1002Submit, form1002aSubmit, capliqPlanSubmit, officerCertify, materialChangeNotice, materialChangeNotified, serviceOneLoanTest,
  partnerUpbReportDue, csbsPrudentialApplicability, upbFinalization, glSnapshotIntake, classifyLiquidity, ELIG_EVENTS,
  periodCloseEvents, remediationPlanApproval, partnerUpbReportDelivered, materialChangeDetected, glCloseCompletedEvent, upbPositionFinalizedEvent,
} from "./ops-18-7.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, type TimerInstance } from "../../kernel/timers/index.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { ELIGIBILITY_TOOLS_18_7, TOOLS_18_7 } from "../../app/tools/section18-7.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";

const reg = loadOverriddenRegistry();
const AGENT: Actor = { kind: "agent", id: "qc-audit" };
const OFFICER: Actor = { kind: "human", id: "cfo-1", role: "officer" };
type Bus = ReturnType<typeof bus18_7>;
/** A one-process bus over the 18.7 eligibility tools with the overridden registry's 18.7 timers armed and satisfied by the events the tools append. */
function bus18_7(nowIso: string): { bus: CommandBus; clock: FixedClock; ctx: UowContext & { decisions: DecisionInput[] }; rt: ToolRuntime; run: (name: string, input: Record<string, unknown>, actor?: Actor) => Promise<Record<string, unknown>>; timers: (code: string) => readonly TimerInstance[]; types: () => string[] } {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["18.7"] });
  const ctx = { loanId: "", events, ledger: new MemoryLedger(), timers, clock, decide: (d: DecisionInput) => { decisions.push(d); }, decisions } as UowContext & { decisions: DecisionInput[] };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const escalates = loadAgentsFile().processes.find((p) => p.process === "18.7")!.escalates_to;
  const cmds = new Map(ELIGIBILITY_TOOLS_18_7.map((d) => { const c = toolCommand(d, rt, escalates); agents.registerTool(d.agent, c.name); return [d.name, c] as const; }));
  return { bus, clock, ctx, rt, run: (name, input, actor = AGENT) => { const c = cmds.get(name); if (!c) throw new Error(`no 18.7 tool ${name}`); return bus.execute(c, actor, input, ctx).then((r) => r.output as Record<string, unknown>); }, timers: (code) => ctx.timers.byCode(code), types: () => ctx.events.all().map((e) => e.type) };
}
const DOCS = [{ id: "TB-2026-09", sha256: "a".repeat(64) }, { id: "CUST-2026-09", sha256: "b".repeat(64) }];
/** Worked example 2 as the GL adapter delivers it (cents), received by BD5 unless `received_on` says otherwise. */
const glEx2 = (period_end: string, received_on: string) => ({ entity: "supermortgage", period_end, received_on, source_documents: DOCS, total_equity_cents: 420_000_000n, goodwill_intangibles_cents: 90_000_000n, affiliate_receivables_cents: 0n, pledged_assets_net_cents: 0n, total_assets_cents: 1_200_000_000n, cash_unrestricted_cents: 250_000_000n });
/** Supermortgage's Section 5 position: $6B subserviced for the partner (excluded from its own requirement), no master-serviced UPB. */
const upbSub = (period_end: string) => ({ entity: "supermortgage", period_end, positions: [{ class: "subserviced_for_others", upb_cents: cents("6000000000"), loan_count: 24_000 }] });
/** The partner's master-serviced book by remittance type (what the monthly partner UPB report carries). */
const upbPartner = (period_end: string) => ({ entity: "partner", period_end, positions: [{ class: "ent_ss_sa", upb_cents: cents("5000000000"), loan_count: 20_000 }, { class: "ent_aa", upb_cents: cents("1000000000"), loan_count: 4_000 }] });
/** A large non-depository ($49B S/A + $1B A/A, compliant): ANW $198M vs required $127.5M; allowable liquidity $100M vs required $44.65M (buffer included). */
const EXL = { total_equity: cents("200000000"), goodwill_intangibles: cents("2000000"), affiliate_receivables: 0n, pledged_assets_net: 0n, total_assets: cents("1500000000"), ent_ss_sa_upb: cents("49000000000"), ent_aa_upb: cents("1000000000"), gnma_upb: 0n, other_upb: 0n, cash_unrestricted: cents("60000000"), eligible_securities: cents("20000000"), advance_line_committed: cents("40000000"), advance_line_drawn: 0n };
const PLAN = { governance: true, liquidity_risk_monitoring: true, contingency_funding_plan_tested_on: "2027-11-15", liquidity_stress_test_on: "2027-12-10", stress_test_includes_msr_valuation: true };
/** Wrap an emitted `{ type, payload }` as a DomainEvent so the registry's satisfied pattern can be matched against it. */
const asEvent = (e: { type: string; payload: Record<string, unknown> } | null): DomainEvent => {
  if (e === null) throw new Error("no event emitted");
  return { id: "e-18.7", type: e.type, occurredAt: "2026-10-07T12:00:00Z", actor: { kind: "agent", id: "qc-audit" }, payload: e.payload, sequence: 1 };
};
const satisfies = (code: string, e: { type: string; payload: Record<string, unknown> } | null): boolean => eventMatches(reg.get(code)!.satisfiedPattern!, asEvent(e));

// Worked example 1 — partner (master; non-depository), quarter-end 2026-12-31.
const EX1 = {
  total_equity: cents("40000000"), goodwill_intangibles: cents("2000000"), affiliate_receivables: cents("500000"), pledged_assets_net: 0n, total_assets: cents("300000000"),
  ent_ss_sa_upb: cents("5000000000"), ent_aa_upb: cents("1000000000"), gnma_upb: 0n, other_upb: 0n,
  cash_unrestricted: cents("6000000"), eligible_securities: cents("2000000"), advance_line_committed: cents("10000000"), advance_line_drawn: cents("4000000"),
};
// Worked example 2 — Supermortgage (pure subservicer): $6B subserviced UPB excluded; own master-serviced UPB $0.
const EX2 = { ...EX1, total_equity: cents("4200000"), goodwill_intangibles: cents("900000"), affiliate_receivables: 0n, total_assets: cents("12000000"), ent_ss_sa_upb: 0n, ent_aa_upb: 0n, cash_unrestricted: cents("2500000"), eligible_securities: 0n, advance_line_committed: 0n, advance_line_drawn: 0n };
// Worked example 3 — decline trigger: ANW Q2 $37.5M → Q3 $27.0M (−28.0%) with positive surplus.
const EX3 = { ...EX1, total_equity: cents("29500000"), prior_anw: 3_750_000_000n };

test("18.7-T1: Given worked example 1 inputs, then `anw = 3_750_000_000¢`, `req_nw = 1_750_000_000¢`, `ratio_bps = 1250`, `allowable_liquidity = 1_100_000_000¢`, `required_liquidity = 385_000_000¢`, status `compliant`.", async () => {
  const r = eligibilityTest(EX1);
  // Rule 1: ANW = total equity − goodwill/intangibles − affiliate receivables − pledged assets (net).
  assert.equal(r.anw, 3_750_000_000n); assert.equal(r.anw, EX1.total_equity - EX1.goodwill_intangibles - EX1.affiliate_receivables - EX1.pledged_assets_net);
  // Rule 2: $2.5M base + 25 bps of the $6B Enterprise UPB (S/A + A/A; the master counts the UPB Supermortgage subservices for it).
  assert.equal(r.req_nw, 1_750_000_000n); assert.equal(r.req_nw, 250_000_000n + (EX1.ent_ss_sa_upb + EX1.ent_aa_upb) * 25n / 10_000n);
  assert.equal(r.nw_surplus, 2_000_000_000n);
  // Rule 3: ratio 37.5M / 300M = 12.50% ≥ 6%.
  assert.equal(r.ratio_bps, 1250); assert.ok(r.ratio_bps >= 600);
  // Rule 4: cash + agency MBS + 50% of the undrawn committed advance line.
  assert.equal(r.allowable_liquidity, 1_100_000_000n); assert.equal(r.allowable_liquidity, EX1.cash_unrestricted + EX1.eligible_securities + (EX1.advance_line_committed - EX1.advance_line_drawn) / 2n);
  // Rule 5: 7 bps of S/A $5B + 3.5 bps of A/A $1B; not large ($6B < $50B) → no buffer.
  assert.equal(r.required_liquidity, 385_000_000n); assert.equal(r.required_liquidity, EX1.ent_ss_sa_upb * 7n / 10_000n + EX1.ent_aa_upb * 35n / 100_000n);
  assert.equal(r.liquidity_surplus, 715_000_000n); assert.equal(r.large, false);
  assert.deepEqual(r.decline_flags, { q_over_q_25: false, two_q_40: false, losses_4q_30: false });
  assert.equal(r.status, "compliant"); assert.equal(r.reason, null);
  // The shared calculator reproduces the same components.
  const n = netWorth(EX1);
  assert.deepEqual([n.anw, n.req_nw, n.ratio_bps, n.allowable_liquidity, n.required_liquidity, n.status], [3_750_000_000n, 1_750_000_000n, 1250, 1_100_000_000n, 385_000_000n, "compliant"]);
  // A compliant quarter arms no warning/breach clock and still needs the officer certification (quarter-end).
  const q = quarterlyTest({ ...EX1, period_end: D("2026-12-31"), computed_on: D("2027-01-08") });
  assert.equal(q.result.status, "compliant"); assert.equal(q.outcome, null); assert.equal(q.certification_required, true);
  // On the bus: the partner's Q4 2026 GL close and Section 5 position are stored, the compute writes `eligibility_results` with the worked figures and appends an
  // uncertified `eligibility.computed` (which cannot satisfy FHFA_ELIG_QUARTERLY_TEST); the officer's certification appends the certified one and closes the row
  // (armed by `period.quarter_end` on the quarter-end, due BD10 after 2026-12-31 across New Year's Day = 2027-01-15).
  const b = bus18_7("2027-01-04T14:00:00.000Z");
  await b.run("gl_snapshot.intake", { entity: "partner", period_end: "2026-12-31", received_on: "2027-01-06", source_documents: [{ id: "PTR-TB-2026-12", sha256: "d".repeat(64) }, { id: "PTR-CUST-2026-12", sha256: "e".repeat(64) }], total_equity_cents: 4_000_000_000n, goodwill_intangibles_cents: 200_000_000n, affiliate_receivables_cents: 50_000_000n, total_assets_cents: 30_000_000_000n, cash_unrestricted_cents: 600_000_000n, eligible_securities_cents: 200_000_000n, advance_line_committed_cents: 1_000_000_000n, advance_line_drawn_cents: 400_000_000n });
  await b.run("upb_position.finalize", upbPartner("2026-12-31"));
  assert.deepEqual(b.types().filter((t) => !t.startsWith("command.")), ["gl.close.completed", "upb.position.finalized"]);
  await b.run("eligibility.period.close", { entity: "partner", period_end: "2026-12-31" });
  const fhfa = b.timers("FHFA_ELIG_QUARTERLY_TEST"); assert.equal(fhfa.length, 1); assert.deepEqual([fhfa[0]!.status, fhfa[0]!.anchorDate, fhfa[0]!.dueDate, fhfa[0]!.subject], ["armed", "2026-12-31", "2027-01-15", { kind: "eligibility_entity", id: "partner" }]);
  const out = await b.run("eligibility.compute", { entity: "partner", period_end: "2026-12-31", computed_on: "2027-01-08" });
  const res = out.result as { anw: bigint; req_nw: bigint; ratio_bps: number; allowable_liquidity: bigint; required_liquidity: bigint; status: string };
  assert.deepEqual([res.anw, res.req_nw, res.ratio_bps, res.allowable_liquidity, res.required_liquidity, res.status], [3_750_000_000n, 1_750_000_000n, 1250, 1_100_000_000n, 385_000_000n, "compliant"]);
  assert.equal(out.stale, false); assert.equal(out.certification_allowed, true); assert.equal(out.outcome, null);
  const row = b.rt.store.get("eligibility_results", "partner:2026-12-31")!.data;
  assert.deepEqual([row.anw_cents, row.required_nw_cents, row.nw_surplus_cents, row.ratio_bps, row.allowable_liquidity_cents, row.required_liquidity_cents, row.liquidity_surplus_cents, row.large_servicer, row.status, row.stale, row.state, row.certified_by_officer_id], [3_750_000_000n, 1_750_000_000n, 2_000_000_000n, 1250, 1_100_000_000n, 385_000_000n, 715_000_000n, false, "compliant", false, "computed", null]);
  assert.equal(fhfa[0]!.status, "armed"); assert.equal(b.ctx.events.ofType("eligibility.computed")[0]!.payload.certified_by_officer_id, null);
  const cert = await b.run("eligibility.certify", { entity: "partner", period_end: "2026-12-31", certified_on: "2027-01-08", certification_document_id: "ELIG-CERT-PTR-2026Q4" }, OFFICER);
  assert.equal(cert.allowed, true); assert.equal(cert.state, "officer_certified"); assert.equal(fhfa[0]!.status, "satisfied");
  const certified = b.ctx.events.ofType("eligibility.computed")[1]!; assert.equal(certified.id, fhfa[0]!.satisfiedByEventId); assert.deepEqual([certified.payload.quarter, certified.payload.certified_by_officer_id, certified.payload.status], [4, "cfo-1", "compliant"]);
  assert.equal(b.rt.store.get("eligibility_results", "partner:2026-12-31")!.data.state, "officer_certified");
});

test("18.7-T2: Given worked example 2 inputs, then `nw_surplus = 80_000_000¢` (24.24% of requirement) and status `warning` with a 30-day remediation-plan timer.", async () => {
  const r = eligibilityTest(EX2);
  assert.equal(r.anw, 330_000_000n); assert.equal(r.anw, EX2.total_equity - EX2.goodwill_intangibles);   // capitalized software deducted as an intangible (open decision 18.7-Q3)
  assert.equal(r.req_nw, 250_000_000n);                                                                     // no master-serviced UPB: base only; the $6B subserviced book is excluded
  assert.equal(r.nw_surplus, 80_000_000n);
  // docs/AUDIT-NOTES.md 18.7 example 2: the spec's "24.24% of requirement" is $800k / $3.3M ANW; against the $2.5M requirement the surplus is 32%.
  // The warning band is implemented as < 25% of either, which is what puts worked example 2 in `warning`.
  assert.equal(r.nw_surplus * 10_000n / r.anw, 2_424n); assert.equal(r.nw_surplus * 10_000n / r.req_nw, 3_200n);
  assert.equal(r.status, "warning"); assert.equal(r.reason, "nw_surplus < 25% of anw");
  assert.equal(r.ratio_bps, 2750); assert.equal(r.required_liquidity, 0n); assert.equal(r.allowable_liquidity, 250_000_000n); assert.equal(r.liquidity_surplus, 250_000_000n);
  // Status ladder `compliant → warning`: the 30-day remediation-plan timer is armed at detection (BD5 after the 2026-09-30 quarter-end = 2026-10-07).
  const q = quarterlyTest({ ...EX2, period_end: D("2026-09-30"), computed_on: D("2026-10-07") });
  assert.equal(q.result.status, "warning"); assert.equal(q.reason, "nw_surplus < 25% of anw");
  const w = q.outcome!; if (w.status !== "warning") throw new Error("unreachable");
  assert.equal(w.timer.code, "SM_ELIG_WARNING_REMEDIATION_30"); assert.equal(w.timer.anchor, D("2026-10-07")); assert.equal(w.timer.due, D("2026-11-06")); assert.equal(daysBetween(w.timer.anchor, w.timer.due), 30);
  assert.deepEqual(w, warningDetected({ detected_on: D("2026-10-07"), reason: "nw_surplus < 25% of anw" }));
  assert.deepEqual(w.escalations.map((e) => [e.kind, e.severity, e.due]), [["officer", "sev2", D("2026-11-06")]]);
  // The registry row: `eligibility.threshold.warning` + 30 calendar days, satisfied by the board-approved remediation plan.
  const row = reg.get("SM_ELIG_WARNING_REMEDIATION_30")!;
  assert.equal(row.triggerPattern!.type, ELIG_EVENTS.warning); assert.deepEqual(row.offsetParsed, { kind: "step", n: 30, unit: "calendar_days" }); assert.equal(row.severity.level, 2);
  assert.equal(w.timer.satisfied_by, ELIG_EVENTS.remediation_plan_approved);
  assert.ok(satisfies("SM_ELIG_WARNING_REMEDIATION_30", { type: "eligibility.remediation_plan.approved", payload: { approved_by: "board", approved_on: D("2026-11-02") } }));
  assert.equal(satisfies("SM_ELIG_WARNING_REMEDIATION_30", { type: "eligibility.remediation_plan.approved", payload: { approved_by: "officer" } }), false);
  // Expensing the software instead would lift ANW to $4.2M and the surplus to $1.7M (51.5% of ANW) → compliant; the config follows the confirmed ANW definition.
  const expensed = eligibilityTest({ ...EX2, goodwill_intangibles: 0n });
  assert.equal(expensed.anw, 420_000_000n); assert.equal(expensed.status, "compliant");
  // On the bus: the Q3 2026 compute of worked example 2 appends `eligibility.threshold.warning{detected_on=2026-10-07}`, which arms SM_ELIG_WARNING_REMEDIATION_30
  // (anchor 2026-10-07, due 2026-11-06) and opens the sev-2 officer escalation; the board's approval satisfies it, an officer's approval does not, and the agent cannot approve.
  const b = bus18_7("2026-10-07T14:00:00.000Z");
  await b.run("upb_position.finalize", upbSub("2026-09-30"));
  await b.run("gl_snapshot.intake", glEx2("2026-09-30", "2026-10-06"));
  await b.run("eligibility.period.close", { period_end: "2026-09-30" });
  assert.deepEqual(b.timers("SM_ELIG_WARNING_REMEDIATION_30"), []);
  const out = await b.run("eligibility.compute", { period_end: "2026-09-30", computed_on: "2026-10-07" });
  assert.equal((out.result as { status: string }).status, "warning"); assert.equal((out.result as { nw_surplus: bigint }).nw_surplus, 80_000_000n); assert.equal((out.result as { req_nw: bigint }).req_nw, 250_000_000n); assert.equal(out.stale, false);
  const warn = b.ctx.events.ofType("eligibility.threshold.warning"); assert.equal(warn.length, 1); assert.deepEqual([warn[0]!.payload.detected_on, warn[0]!.payload.reason, warn[0]!.payload.entity, warn[0]!.payload.remediation_plan_due], ["2026-10-07", "nw_surplus < 25% of anw", "supermortgage", "2026-11-06"]);
  const t = b.timers("SM_ELIG_WARNING_REMEDIATION_30"); assert.equal(t.length, 1); assert.deepEqual([t[0]!.status, t[0]!.anchorDate, t[0]!.dueDate, t[0]!.armedByEventId], ["armed", "2026-10-07", "2026-11-06", warn[0]!.id]);
  assert.deepEqual(b.rt.escalations.opened.map((e) => [e.kind, e.ownerRole, e.severity, e.payload.timer]), [["officer", "officer", "sev2", "SM_ELIG_WARNING_REMEDIATION_30"]]);
  const notBoard = await b.run("remediation_plan.approve", { approved_by: "officer", approved_on: "2026-11-02", plan_document_id: "PLAN-2026Q3" }, OFFICER);
  assert.equal(notBoard.allowed, false); assert.match(String(notBoard.refusal), /board-approved/); assert.equal(t[0]!.status, "armed"); assert.equal(b.ctx.events.ofType("eligibility.remediation_plan.approved").length, 0);
  await assert.rejects(b.run("remediation_plan.approve", { approved_by: "board", approved_on: "2026-11-02", plan_document_id: "PLAN-2026Q3" }), (e: unknown) => e instanceof CommandRefused && e.code === "HUMAN_ONLY");
  const board = await b.run("remediation_plan.approve", { approved_by: "board", approved_on: "2026-11-02", plan_document_id: "PLAN-2026Q3", minutes_document_id: "MIN-2026-11-02" }, OFFICER);
  assert.equal(board.allowed, true); assert.equal(board.timely, true); assert.equal(board.due, "2026-11-06"); assert.equal(t[0]!.status, "satisfied");
  assert.equal(b.rt.store.get("eligibility_results", "supermortgage:2026-09-30")!.data.state, "remediation_plan");
  assert.equal(remediationPlanApproval({ warning_detected_on: D("2026-10-07"), approved_by: "board", approved_on: D("2026-11-07"), plan_document_id: "PLAN" }).timely, false);   // day 31
  assert.equal(remediationPlanApproval({ warning_detected_on: D("2026-10-07"), approved_by: "board", approved_on: D("2026-11-02"), plan_document_id: null }).allowed, false);   // no plan document
});

test("18.7-T3: Given ANW falling 28% quarter-over-quarter with positive surplus, then status `breach` via `decline_flags.q_over_q_25` and partner/officer notices within 1 BD.", async () => {
  const r = eligibilityTest(EX3);
  assert.equal(r.anw, 2_700_000_000n);
  assert.equal((3_750_000_000n - 2_700_000_000n) * 1_000n / 3_750_000_000n, 280n);       // −28.0% quarter over quarter
  assert.ok(r.nw_surplus > 0n); assert.equal(r.nw_surplus, 950_000_000n); assert.ok(r.liquidity_surplus > 0n); assert.ok(r.ratio_bps >= 600);
  assert.equal(r.decline_flags.q_over_q_25, true); assert.equal(r.decline_flags.two_q_40, false); assert.equal(r.decline_flags.losses_4q_30, false);
  assert.equal(r.status, "breach"); assert.equal(r.reason, "decline_flags.q_over_q_25");
  // Rule 6 boundaries, exact in bigint: 25% or more over a quarter; more than 40% over two quarters (A4-1-01) — 40.00% is not a trigger.
  assert.equal(declineTriggers({ anw: 2_812_500_000n, prior_anw: 3_750_000_000n }).q_over_q_25, true);              // exactly −25.00%
  assert.equal(declineTriggers({ anw: 2_812_500_001n, prior_anw: 3_750_000_000n }).q_over_q_25, false);
  assert.equal(declineTriggers({ anw: 3_000_000_000n, two_quarters_back_anw: 5_000_000_000n }).two_q_40, false);    // exactly −40.00%: "more than 40%" not met
  assert.equal(declineTriggers({ anw: 2_999_999_999n, two_quarters_back_anw: 5_000_000_000n }).two_q_40, true);
  assert.equal(eligibilityTest({ ...EX1, two_quarters_back_anw: 6_250_000_000n }).status, "compliant");            // 37.5M vs 62.5M = −40.00% → not a breach
  assert.equal(eligibilityTest({ ...EX1, two_quarters_back_anw: 6_250_000_001n }).reason, "decline_flags.two_q_40");
  assert.equal(declineTriggers({ anw: 2_700_000_000n, four_quarters_back_anw: 3_750_000_000n, consecutive_loss_quarters: 4 }).losses_4q_30, false);   // −28% < 30%
  assert.equal(declineTriggers({ anw: 2_625_000_000n, four_quarters_back_anw: 3_750_000_000n, consecutive_loss_quarters: 4 }).losses_4q_30, true);    // −30% with 4 losses
  assert.equal(declineTriggers({ anw: 2_625_000_000n, four_quarters_back_anw: 3_750_000_000n, consecutive_loss_quarters: 3 }).losses_4q_30, false);
  // Status ladder → breach irrespective of surplus: partner + officer notices within 1 BD of detection (2026-10-07 → Thu 2026-10-08); Fannie Mae within 5 BD (18.4 material adverse change; Columbus Day Mon 2026-10-12 → 2026-10-15).
  const q = quarterlyTest({ ...EX3, period_end: D("2026-09-30"), computed_on: D("2026-10-07") });
  const b = q.outcome!; if (b.status !== "breach") throw new Error("unreachable");
  assert.deepEqual(b, breachDetected({ detected_on: D("2026-10-07"), trigger: "decline_flags.q_over_q_25" }));
  assert.deepEqual(b.notices.map((x) => [x.to, x.kind, x.due]), [["partner", "eligibility_breach", D("2026-10-08")], ["officer", "eligibility_breach", D("2026-10-08")], ["fannie_mae", "material_adverse_change", D("2026-10-15")]]);
  assert.equal(b.timer.code, "SM_ELIG_BREACH_NOTIFY_1BD"); assert.equal(b.timer.anchor, D("2026-10-07")); assert.equal(b.timer.due, D("2026-10-08"));
  assert.deepEqual(b.fnma_handoff, { process: "18.4", kind: "material_adverse_change", due: D("2026-10-15") });
  assert.deepEqual(b.escalations.map((e) => [e.kind, e.severity, e.due]), [["officer", "sev1", D("2026-10-08")]]);
  // Registry row: `eligibility.breach.detected` + 1 business day (servicer), sev-1; satisfied only when both the partner and the officer are notified.
  const row = reg.get("SM_ELIG_BREACH_NOTIFY_1BD")!;
  assert.equal(row.triggerPattern!.type, ELIG_EVENTS.breach); assert.deepEqual(row.offsetParsed, { kind: "step", n: 1, unit: "business_days_servicer" }); assert.equal(row.severity.level, 1);
  const notified = breachNotified({ detected_on: D("2026-10-07"), partner_notified_on: D("2026-10-08"), officer_notified_on: D("2026-10-07") });
  assert.equal(notified.complete, true); assert.equal(notified.timely, true); assert.ok(satisfies("SM_ELIG_BREACH_NOTIFY_1BD", notified.event));
  assert.equal(breachNotified({ detected_on: D("2026-10-07"), partner_notified_on: null, officer_notified_on: D("2026-10-07") }).event, null);
  assert.equal(breachNotified({ detected_on: D("2026-10-07"), partner_notified_on: D("2026-10-09"), officer_notified_on: D("2026-10-08") }).timely, false);
  // Friday detection: 1 BD lands on Monday.
  assert.equal(breachDetected({ detected_on: D("2026-10-09"), trigger: "decline_flags.q_over_q_25" }).timer.due, D("2026-10-13"));   // Mon 2026-10-12 is Columbus Day
  // On the bus: the partner's Q3 2026 compute (ANW $27.0M against $37.5M a quarter earlier) appends `eligibility.breach.detected{detected_on=2026-10-07}`, which arms
  // SM_ELIG_BREACH_NOTIFY_1BD (due 2026-10-08) and opens the sev-1 officer escalation with the 18.4 hand-off; `eligibility.breach.notify` satisfies it only once both notices exist.
  const bb = bus18_7("2026-10-07T14:00:00.000Z");
  await bb.run("eligibility.period.close", { entity: "partner", period_end: "2026-09-30" });
  const out = await bb.run("eligibility.compute", { entity: "partner", period_end: "2026-09-30", computed_on: "2026-10-07", inputs: EX3 });
  assert.equal((out.result as { status: string }).status, "breach"); assert.equal((out.result as { reason: string }).reason, "decline_flags.q_over_q_25"); assert.equal((out.result as { nw_surplus: bigint }).nw_surplus, 950_000_000n);
  const ev = bb.ctx.events.ofType("eligibility.breach.detected"); assert.equal(ev.length, 1);
  assert.deepEqual([ev[0]!.payload.entity, ev[0]!.payload.detected_on, ev[0]!.payload.trigger, ev[0]!.payload.notify_by, ev[0]!.payload.fnma_notice_by], ["partner", "2026-10-07", "decline_flags.q_over_q_25", "2026-10-08", "2026-10-15"]);
  const t = bb.timers("SM_ELIG_BREACH_NOTIFY_1BD"); assert.equal(t.length, 1); assert.deepEqual([t[0]!.status, t[0]!.anchorDate, t[0]!.dueDate, t[0]!.armedByEventId], ["armed", "2026-10-07", "2026-10-08", ev[0]!.id]);
  assert.deepEqual(bb.rt.escalations.opened.map((e) => [e.kind, e.severity, (e.payload.fnma_handoff as { process: string; kind: string }).process, (e.payload.fnma_handoff as { due: string }).due]), [["officer", "sev1", "18.4", "2026-10-15"]]);
  assert.deepEqual(bb.timers("FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD"), []); assert.equal(bb.ctx.events.ofType("material_change.detected").length, 0);   // a $6B servicer: no material-change clock
  const partial = await bb.run("eligibility.breach.notify", { entity: "partner", period_end: "2026-09-30", officer_notified_on: "2026-10-07", officer_notice_id: "N-OFF-1" });
  assert.equal(partial.complete, false); assert.equal(t[0]!.status, "armed"); assert.equal(bb.ctx.events.ofType("eligibility.breach.notified").length, 0);
  const both = await bb.run("eligibility.breach.notify", { entity: "partner", period_end: "2026-09-30", partner_notified_on: "2026-10-08", partner_notice_id: "N-PTR-1", officer_notified_on: "2026-10-07", officer_notice_id: "N-OFF-1" });
  assert.equal(both.complete, true); assert.equal(both.timely, true); assert.equal(t[0]!.status, "satisfied");
  const done = bb.ctx.events.ofType("eligibility.breach.notified")[0]!; assert.equal(done.id, t[0]!.satisfiedByEventId); assert.deepEqual([done.payload.partner, done.payload.officer, done.payload.partner_notified_on], [true, true, "2026-10-08"]);
});

test("18.7-T4: Given Enterprise A/A UPB `123_456_789_00¢`, then required liquidity component = `round(12_345_678_900 × 35 / 100_000) = 4_320_988¢` (i.e., $43,209.88; exact value 4,320,987.615 rounds half-up to 4,320,988).", () => {
  // 3.5 bps implemented as × 35 / 100_000, round-half-up to the cent at the component: 12,345,678,900 × 35 / 100,000 = 4,320,987.615 → 4,320,988¢.
  const r = eligibilityTest({ ...EX1, ent_ss_sa_upb: 0n, ent_aa_upb: 12_345_678_900n });
  assert.equal(r.required_liquidity, 4_320_988n);
  assert.equal(12_345_678_900n * 35n / 100_000n, 4_320_987n); assert.equal((12_345_678_900n * 35n) % 100_000n, 61_500n); assert.ok(61_500n * 2n >= 100_000n);   // remainder .615 ≥ .5 → up
  assert.equal(netWorth({ ...EX1, ent_ss_sa_upb: 0n, ent_aa_upb: 12_345_678_900n }).required_liquidity, 4_320_988n);
  // The same UPB in the S/A class is 7 bps: 12,345,678,900 × 7 / 10,000 = 8,641,975.23 → 8,641,975¢ (remainder .23 rounds down).
  assert.equal(eligibilityTest({ ...EX1, ent_ss_sa_upb: 12_345_678_900n, ent_aa_upb: 0n }).required_liquidity, 8_641_975n);
  // Components round separately before summing: A/A 4,320,988 + S/A 8,641,975 = 12,962,963.
  assert.equal(eligibilityTest({ ...EX1, ent_ss_sa_upb: 12_345_678_900n, ent_aa_upb: 12_345_678_900n }).required_liquidity, 12_962_963n);
});

test("18.7-T5: Given quarter-end 2026-09-30, then Form 1002 is due 2026-10-30 (warning 2026-10-20); given Dec 31, due 2027-03-01.", async () => {
  // Mar/Jun/Sep quarter-ends: "within 30 days", warning day 20 (FNMA_A4102_FORM1002_Q_30).
  const q3 = form1002Clock(D("2026-09-30"));
  assert.deepEqual(q3, { code: "FNMA_A4102_FORM1002_Q_30", quarter: 3, anchor: D("2026-09-30"), due: D("2026-10-30"), warning: D("2026-10-20"), satisfied_by: ELIG_EVENTS.form1002_q_submitted });
  assert.equal(daysBetween(q3.anchor, q3.due), 30); assert.equal(daysBetween(q3.anchor, q3.warning), 20);
  assert.deepEqual(form1002Due(D("2026-09-30")), { due: D("2026-10-30"), warning: D("2026-10-20") });
  // December 31: "within 60 days" → 2027-03-01, warning day 40 → 2027-02-09 (FNMA_A4102_FORM1002_YE_60).
  const ye = form1002Clock(D("2026-12-31"));
  assert.deepEqual(ye, { code: "FNMA_A4102_FORM1002_YE_60", quarter: 4, anchor: D("2026-12-31"), due: D("2027-03-01"), warning: D("2027-02-09"), satisfied_by: ELIG_EVENTS.form1002_ye_submitted });
  assert.equal(daysBetween(ye.anchor, ye.due), 60); assert.equal(daysBetween(ye.anchor, ye.warning), 40);
  assert.equal(form1002Due(D("2026-12-31")).due, D("2027-03-01"));   // networth.form1002Due warns at due − 10 (day 50) for year-end; the spec's day-40 warning is form1002Clock's
  // The registry rows carry the same offsets and warning days.
  const rq = reg.get("FNMA_A4102_FORM1002_Q_30")!, ry = reg.get("FNMA_A4102_FORM1002_YE_60")!;
  assert.deepEqual(rq.offsetParsed, { kind: "step", n: 30, unit: "calendar_days" }); assert.match(rq.offset, /warning day 20/); assert.deepEqual(rq.triggerPattern!.conditions, [{ field: "quarter", op: "in", value: ["1", "2", "3"] }]); assert.deepEqual(rq.severity, { level: 1, escalateTo: ["officer"] });
  assert.deepEqual(ry.offsetParsed, { kind: "step", n: 60, unit: "calendar_days" }); assert.match(ry.offset, /warning day 40/); assert.equal(ry.triggerPattern!.type, "period.year_end"); assert.equal(ry.severity.level, 1);
  // The other quarters of 2027: Mar 31 → Apr 30 (warning Apr 20); Jun 30 → Jul 30 (warning Jul 20).
  assert.deepEqual([form1002Clock(D("2027-03-31")).due, form1002Clock(D("2027-03-31")).warning], [D("2027-04-30"), D("2027-04-20")]);
  assert.deepEqual([form1002Clock(D("2027-06-30")).due, form1002Clock(D("2027-06-30")).warning], [D("2027-07-30"), D("2027-07-20")]);
  // On the bus: closing 2026-09-30 appends `period.quarter_end{quarter=3}` → FNMA_A4102_FORM1002_Q_30 armed on the quarter-end, due 2026-10-30; closing 2026-12-31
  // appends `period.year_end` → FNMA_A4102_FORM1002_YE_60 due 2027-03-01 (quarter 4 arms no _Q_30 row). The WebMB submissions with the certification record satisfy them.
  const b = bus18_7("2026-10-01T14:00:00.000Z");
  const q3c = await b.run("eligibility.period.close", { period_end: "2026-09-30" });
  assert.deepEqual(q3c.events, ["period.month_end", "period.quarter_end"]); assert.deepEqual((q3c.clocks as { form1002: unknown }).form1002, q3);
  const fq = b.timers("FNMA_A4102_FORM1002_Q_30"); assert.equal(fq.length, 1); assert.deepEqual([fq[0]!.anchorDate, fq[0]!.dueDate, fq[0]!.status], ["2026-09-30", "2026-10-30", "armed"]);
  assert.deepEqual(b.timers("FNMA_A4102_FORM1002_YE_60"), []);
  b.clock.set("2027-01-04T14:00:00.000Z");
  const yec = await b.run("eligibility.period.close", { period_end: "2026-12-31" });
  assert.deepEqual(yec.events, ["period.month_end", "period.quarter_end", "period.year_end"]); assert.deepEqual((yec.clocks as { form1002: unknown }).form1002, ye);
  const fy = b.timers("FNMA_A4102_FORM1002_YE_60"); assert.equal(fy.length, 1); assert.deepEqual([fy[0]!.anchorDate, fy[0]!.dueDate, fy[0]!.status], ["2026-12-31", "2027-03-01", "armed"]);
  assert.equal(b.timers("FNMA_A4102_FORM1002_Q_30").length, 1);
  await b.run("form1002.submit", { period_end: "2026-09-30", webmb_confirmation: "WMB-2026Q3-001", ceo_cfo_certification: "CERT-2026Q3", submitted_on: "2026-10-30" });
  assert.equal(fq[0]!.status, "satisfied"); assert.equal(fy[0]!.status, "armed"); assert.equal(b.rt.store.get("regulatory_filings", "supermortgage:form_1002:2026-09-30")!.data.late, false);
  await b.run("form1002.submit", { period_end: "2026-12-31", webmb_confirmation: "WMB-2026Q4-001", ceo_cfo_certification: "CERT-2026Q4", submitted_on: "2027-03-01" });
  assert.equal(fy[0]!.status, "satisfied"); assert.equal(b.rt.store.get("regulatory_filings", "supermortgage:form_1002:2026-12-31")!.data.due_at, "2027-03-01");
  await assert.rejects(b.run("form1002.submit", { period_end: "2026-10-31", webmb_confirmation: "x", ceo_cfo_certification: "y" }), RangeError);   // not a quarter-end
});

test("18.7-T6: Given total UPB crossing $50B at 2027-06-30, then the buffer applies to the 2027-06-30 test, `FNMA_A4102_FORM1002A_M_30` starts for July, and the capital/liquidity plan timer targets 2028-03-30 (Dec 31, 2027 + 90 days = March 30, 2028).", async () => {
  // Crossing at the 2027-06-30 quarter-end: $48B → $50B (S/A $49B + A/A $1B).
  const x = largeServicerCrossing({ quarter_end: D("2027-06-30"), total_upb: cents("50000000000"), prior_total_upb: cents("48000000000") });
  assert.equal(x.large, true); assert.equal(x.crossed, true); assert.equal(x.buffer_applies_from, D("2027-06-30"));
  // Buffer applies to the 2027-06-30 test: 7 bps ($34,300,000) + 3.5 bps ($350,000) + 2 bps Enterprise buffer on $50B ($10,000,000) = $44,650,000.
  const at = eligibilityTest({ ...EX1, ent_ss_sa_upb: cents("49000000000") });
  assert.equal(at.large, true); assert.equal(at.required_liquidity, 4_465_000_000n); assert.equal(at.required_liquidity - 3_430_000_000n - 35_000_000n, 1_000_000_000n);
  assert.equal(at.required_liquidity - 3_430_000_000n - 35_000_000n, cents("50000000000") * 2n / 10_000n);
  const under = eligibilityTest({ ...EX1, ent_ss_sa_upb: cents("48999999999") });
  assert.equal(under.large, false); assert.equal(under.required_liquidity, 3_465_000_000n);   // one cent under $50B: no buffer
  assert.equal(largeServicerCrossing({ quarter_end: D("2027-03-31"), total_upb: cents("48000000000"), prior_total_upb: cents("30000000000") }).large, false);
  // Ginnie Mae buffer is 5 bps: $50B all Ginnie Mae → 10 bps ($50,000,000) + 5 bps ($25,000,000).
  assert.equal(eligibilityTest({ ...EX1, ent_ss_sa_upb: 0n, ent_aa_upb: 0n, gnma_upb: cents("50000000000") }).required_liquidity, 7_500_000_000n);
  // FNMA_A4102_FORM1002A_M_30 starts for July: month-end 2027-07-31 → due 2027-08-30 (no report for the third month of a quarter).
  assert.deepEqual(x.form1002a, { first_month_end: D("2027-07-31"), due: D("2027-08-30") });
  const july = form1002aSubmit({ month_end: D("2027-07-31"), large: true, webmb_confirmation: null });
  assert.equal(july.required, true); assert.equal(july.quarter_month, 1); assert.deepEqual(july.timer, { code: "FNMA_A4102_FORM1002A_M_30", anchor: D("2027-07-31"), due: D("2027-08-30"), satisfied_by: ELIG_EVENTS.form1002a_submitted });
  assert.equal(july.allowed, false); assert.equal(july.state, "form1002a_prepared"); assert.match(july.refusal!, /WebMB submission confirmation/);
  const filed = form1002aSubmit({ month_end: D("2027-07-31"), large: true, webmb_confirmation: "WMB-2027-07-001" });
  assert.equal(filed.state, "submitted"); assert.ok(satisfies("FNMA_A4102_FORM1002A_M_30", filed.event));
  assert.deepEqual(form1002aSubmit({ month_end: D("2027-08-31"), large: true, webmb_confirmation: null }).timer, { code: "FNMA_A4102_FORM1002A_M_30", anchor: D("2027-08-31"), due: D("2027-09-30"), satisfied_by: ELIG_EVENTS.form1002a_submitted });
  const sept = form1002aSubmit({ month_end: D("2027-09-30"), large: true, webmb_confirmation: "WMB-2027-09-001" });
  assert.equal(sept.required, false); assert.equal(sept.quarter_month, 3); assert.equal(sept.state, "not_required"); assert.equal(sept.event, null); assert.match(sept.refusal!, /third month of a quarter/);
  assert.equal(form1002aSubmit({ month_end: D("2027-04-30"), large: false, webmb_confirmation: null }).required, false);   // before the crossing: not large
  const ra = reg.get("FNMA_A4102_FORM1002A_M_30")!;
  assert.deepEqual(ra.offsetParsed, { kind: "step", n: 30, unit: "calendar_days" }); assert.deepEqual(ra.triggerPattern!.conditions, [{ field: "quarter_month", op: "in", value: ["1", "2"] }]);
  // Capital/liquidity plan: Dec 31, 2027 + 90 days = March 30, 2028 (FNMA_A4101_LARGE_CAPLIQ_PLAN_90).
  assert.deepEqual(x.capliq_plan, { year_end: D("2027-12-31"), due: D("2028-03-30") }); assert.equal(capitalPlanDue(D("2027-12-31")), D("2028-03-30")); assert.equal(daysBetween(D("2027-12-31"), D("2028-03-30")), 90);
  const plan = { governance: true, liquidity_risk_monitoring: true, contingency_funding_plan_tested_on: D("2027-11-15"), liquidity_stress_test_on: D("2027-12-10"), stress_test_includes_msr_valuation: true };
  const p = capliqPlanSubmit({ year_end: D("2027-12-31"), large: true, plan, submitted_on: D("2028-03-30") });
  assert.equal(p.required, true); assert.equal(p.allowed, true); assert.equal(p.late, false); assert.deepEqual(p.timer, { code: "FNMA_A4101_LARGE_CAPLIQ_PLAN_90", anchor: D("2027-12-31"), due: D("2028-03-30"), satisfied_by: ELIG_EVENTS.capliq_plan_submitted });
  assert.ok(satisfies("FNMA_A4101_LARGE_CAPLIQ_PLAN_90", p.event));
  assert.equal(capliqPlanSubmit({ year_end: D("2027-12-31"), large: true, plan, submitted_on: D("2028-03-31") }).late, true);
  const incomplete = capliqPlanSubmit({ year_end: D("2027-12-31"), large: true, plan: { ...plan, contingency_funding_plan_tested_on: D("2027-03-01"), stress_test_includes_msr_valuation: false }, submitted_on: D("2028-03-30") });
  assert.equal(incomplete.allowed, false); assert.deepEqual(incomplete.missing, ["contingency funding plan tested at least annually", "stress test including MSR valuation"]); assert.equal(incomplete.event, null);
  assert.equal(capliqPlanSubmit({ year_end: D("2027-12-31"), large: false, plan, submitted_on: D("2028-03-30") }).required, false);
  assert.deepEqual(reg.get("FNMA_A4101_LARGE_CAPLIQ_PLAN_90")!.offsetParsed, { kind: "step", n: 90, unit: "calendar_days" });
  // Ratings lead time: $40B warning before the crossing.
  assert.equal(largeServicerCrossing({ quarter_end: D("2027-03-31"), total_upb: cents("48000000000"), prior_total_upb: cents("30000000000") }).ratings_warning, true);
  // On the bus: the 2027-06-30 test of the $50B book stores `large_servicer=true` (buffer 2 bps of $50B = $10,000,000); the July close then appends
  // `period.month_end{quarter_month=1, large_servicer=true}` → FNMA_A4102_FORM1002A_M_30 armed on 2027-07-31, due 2027-08-30; the 2027-12-31 close appends
  // `period.year_end{large_servicer=true}` → FNMA_A4101_LARGE_CAPLIQ_PLAN_90 due 2028-03-30. The WebMB confirmation and the complete plan satisfy them.
  const b = bus18_7("2027-07-08T14:00:00.000Z");
  await b.run("eligibility.period.close", { period_end: "2027-06-30" });
  const big = await b.run("eligibility.compute", { period_end: "2027-06-30", computed_on: "2027-07-08", inputs: EXL });
  assert.deepEqual([(big.result as { large: boolean }).large, (big.result as { status: string }).status, (big.result as { required_liquidity: bigint }).required_liquidity, (big.result as { req_nw: bigint }).req_nw], [true, "compliant", 4_465_000_000n, 12_750_000_000n]);
  assert.equal(b.rt.store.get("eligibility_results", "supermortgage:2027-06-30")!.data.buffer_required_cents, 1_000_000_000n);
  assert.deepEqual(b.timers("FNMA_A4102_FORM1002A_M_30"), []);   // June is the third month of its quarter
  b.clock.set("2027-08-02T14:00:00.000Z");
  const julyClose = await b.run("eligibility.period.close", { period_end: "2027-07-31" });
  assert.equal(julyClose.large_servicer, true); assert.equal(julyClose.quarter_month, 1); assert.deepEqual(julyClose.events, ["period.month_end"]); assert.deepEqual((julyClose.clocks as { form1002a: unknown }).form1002a, { code: "FNMA_A4102_FORM1002A_M_30", due: D("2027-08-30") });
  const fa = b.timers("FNMA_A4102_FORM1002A_M_30"); assert.equal(fa.length, 1); assert.deepEqual([fa[0]!.anchorDate, fa[0]!.dueDate, fa[0]!.status], ["2027-07-31", "2027-08-30", "armed"]);
  const unconfirmed = await b.run("form1002a.submit", { period_end: "2027-07-31" }); assert.equal(unconfirmed.allowed, false); assert.equal(fa[0]!.status, "armed");
  const confirmed = await b.run("form1002a.submit", { period_end: "2027-07-31", webmb_confirmation: "WMB-2027-07-001", submitted_on: "2027-08-20" }); assert.equal(confirmed.allowed, true); assert.equal(fa[0]!.status, "satisfied");
  b.clock.set("2028-01-03T14:00:00.000Z");
  const yeClose = await b.run("eligibility.period.close", { period_end: "2027-12-31" });
  assert.deepEqual((yeClose.clocks as { capliq_plan: unknown }).capliq_plan, { code: "FNMA_A4101_LARGE_CAPLIQ_PLAN_90", due: D("2028-03-30") });
  const cp = b.timers("FNMA_A4101_LARGE_CAPLIQ_PLAN_90"); assert.equal(cp.length, 1); assert.deepEqual([cp[0]!.anchorDate, cp[0]!.dueDate, cp[0]!.status], ["2027-12-31", "2028-03-30", "armed"]);
  const missing = await b.run("capliq_plan.submit", { year_end: "2027-12-31", plan: { ...PLAN, stress_test_includes_msr_valuation: false }, submitted_on: "2028-03-15" });
  assert.equal(missing.allowed, false); assert.deepEqual(missing.missing, ["stress test including MSR valuation"]); assert.equal(cp[0]!.status, "armed");
  const planned = await b.run("capliq_plan.submit", { year_end: "2027-12-31", plan: PLAN, plan_document_id: "CAPLIQ-2027", submitted_on: "2028-03-30" });
  assert.equal(planned.allowed, true); assert.equal(planned.late, false); assert.equal(cp[0]!.status, "satisfied");
  // Before the crossing the year-end row does not arm: a Dec 31 close of a $6B servicer carries `large_servicer=false`.
  const small = bus18_7("2027-01-04T14:00:00.000Z"); await small.run("eligibility.period.close", { period_end: "2026-12-31" });
  assert.deepEqual(small.timers("FNMA_A4101_LARGE_CAPLIQ_PLAN_90"), []); assert.equal(small.ctx.events.ofType("period.year_end")[0]!.payload.large_servicer, false);
});

test("18.7-T7: Given a GL close missing at BD5, then the monthly result is flagged `stale` and the quarterly certification cannot proceed.", async () => {
  // Quarter-end 2026-09-30: BD5 (Fannie ET business days) is Wed 2026-10-07; no close for September has arrived.
  assert.equal(glCloseDeadline(D("2026-09-30")), D("2026-10-07"));
  const q = staleGlRun({ period_end: D("2026-09-30"), gl_close: { period_end: D("2026-08-31"), received_on: D("2026-09-04") } });
  assert.equal(q.bd5, D("2026-10-07")); assert.equal(q.quarter_end, true);
  assert.equal(q.stale, true); assert.deepEqual(q.flags, ["stale"]);
  assert.deepEqual(q.computed_on, { basis: "prior_close", period_end: D("2026-08-31") });
  assert.equal(q.certification_allowed, false); assert.equal(q.next_state, "computed");
  assert.match(q.refusal!, /quarterly certification refused/); assert.match(q.refusal!, /2026-10-07/); assert.match(q.refusal!, /stale/);
  assert.equal(q.awaiting, ELIG_EVENTS.gl_close_completed);
  // The officer cannot certify a stale quarter either (computed → officer_certified blocked until a fresh close).
  const cert = officerCertify({ entity: "supermortgage", period_end: D("2026-09-30"), status: "warning", stale: q.stale, certified_by: { role: "officer", id: "cfo-1" }, certified_on: D("2026-10-07") });
  assert.equal(cert.allowed, false); assert.equal(cert.state, "computed"); assert.match(cert.refusal!, /stale/); assert.equal(cert.event, null);
  // A September close that lands after BD5 (Thu 2026-10-08) was still missing at BD5 → stale.
  const late = staleGlRun({ period_end: D("2026-09-30"), gl_close: { period_end: D("2026-09-30"), received_on: D("2026-10-08") } });
  assert.equal(late.stale, true); assert.equal(late.certification_allowed, false);
  // No close at all → stale, computed on nothing, certification blocked.
  const none = staleGlRun({ period_end: D("2026-09-30"), gl_close: null });
  assert.equal(none.stale, true); assert.deepEqual(none.computed_on, { basis: "prior_close", period_end: null }); assert.equal(none.certification_allowed, false);
  // A non-quarter month (October; BD5 = 2026-11-06): the monthly result is flagged stale but there is no certification to block.
  const m = staleGlRun({ period_end: D("2026-10-31"), gl_close: null });
  assert.equal(m.bd5, D("2026-11-06")); assert.equal(m.quarter_end, false); assert.equal(m.stale, true); assert.deepEqual(m.flags, ["stale"]);
  assert.equal(m.certification_allowed, true); assert.equal(m.next_state, "reported_to_partner"); assert.equal(m.refusal, null);
  // A fresh close received by BD5 clears the flag and lets the quarter proceed to officer certification.
  const fresh = staleGlRun({ period_end: D("2026-09-30"), gl_close: { period_end: D("2026-09-30"), received_on: D("2026-10-06") } });
  assert.equal(fresh.stale, false); assert.deepEqual(fresh.flags, []); assert.equal(fresh.computed_on.basis, "fresh_close");
  assert.equal(fresh.certification_allowed, true); assert.equal(fresh.next_state, "officer_certified"); assert.equal(fresh.awaiting, null);
  assert.equal(officerCertify({ entity: "supermortgage", period_end: D("2026-09-30"), status: "warning", stale: fresh.stale, certified_by: { role: "officer", id: "cfo-1" }, certified_on: D("2026-10-07") }).state, "officer_certified");
  // Year-end: Jan 1 2027 is a holiday, so BD5 after 2026-12-31 is Fri 2027-01-08.
  assert.equal(staleGlRun({ period_end: D("2026-12-31"), gl_close: null }).bd5, D("2027-01-08"));
  // On the bus: only an August close is on file at BD5 → the September run computes on it flagged `stale`; the officer's certification is refused, no certified
  // `eligibility.computed` is appended, and FHFA_ELIG_QUARTERLY_TEST (armed by the quarter-end close, due BD10 = 2026-10-15) breaches at sev-2.
  const b = bus18_7("2026-10-07T14:00:00.000Z");
  await b.run("upb_position.finalize", upbSub("2026-09-30"));
  await b.run("gl_snapshot.intake", { ...glEx2("2026-08-31", "2026-09-04"), source_documents: [{ id: "TB-2026-08", sha256: "c".repeat(64) }] });
  await b.run("eligibility.period.close", { period_end: "2026-09-30" });
  const out = await b.run("eligibility.compute", { period_end: "2026-09-30", computed_on: "2026-10-07" });
  assert.equal(out.stale, true); assert.deepEqual(out.flags, ["stale"]); assert.deepEqual(out.computed_on, { basis: "prior_close", period_end: "2026-08-31" }); assert.equal(out.certification_allowed, false); assert.equal(out.awaiting, ELIG_EVENTS.gl_close_completed);
  assert.equal(b.rt.store.get("eligibility_results", "supermortgage:2026-09-30")!.data.stale, true); assert.equal(b.ctx.events.ofType("eligibility.computed")[0]!.payload.stale, true);
  const refused = await b.run("eligibility.certify", { period_end: "2026-09-30", certified_on: "2026-10-07" }, OFFICER);
  assert.equal(refused.allowed, false); assert.match(String(refused.refusal), /stale/); assert.equal(b.rt.store.get("eligibility_results", "supermortgage:2026-09-30")!.data.certified_by_officer_id, null);
  const fhfa = b.timers("FHFA_ELIG_QUARTERLY_TEST"); assert.equal(fhfa.length, 1); assert.equal(fhfa[0]!.dueDate, "2026-10-15"); assert.equal(fhfa[0]!.status, "armed");
  assert.equal(b.ctx.events.ofType("eligibility.computed").filter((e) => e.payload.certified_by_officer_id !== null).length, 0);
  const breaches = b.ctx.timers.evaluate("2026-10-16T12:00:00.000Z").filter((x) => x.instance.code === "FHFA_ELIG_QUARTERLY_TEST");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.severity, 2); assert.equal(fhfa[0]!.status, "breached");
  // A non-quarter month with no close: stale, no certification to block, the partner report still runs (reported_to_partner).
  await b.run("upb_position.finalize", upbSub("2026-10-31"));   // the October position exists; only the GL close is missing
  const oct = await b.run("eligibility.compute", { period_end: "2026-10-31", computed_on: "2026-11-06" });
  assert.equal(oct.stale, true); assert.equal(oct.certification_allowed, true); assert.equal(oct.next_state, "reported_to_partner"); assert.equal(oct.quarter_end, false);
});

test("18.7-T8: Given the agent attempts to mark the Form 1002 filing `submitted` without a WebMB confirmation and CEO/CFO certification record, then the transition is refused.", async () => {
  // Missing the certification record: refused, the filing stays `form1002_prepared`, no `filing.submitted` event.
  const noCert = form1002Submit({ period_end: D("2026-09-30"), webmb_confirmation: "WMB-2026Q3-001", ceo_cfo_certification: null });
  assert.equal(noCert.allowed, false); assert.equal(noCert.state, "form1002_prepared"); assert.equal(noCert.event, null); assert.match(noCert.refusal!, /CEO\/CFO certification/); assert.equal(noCert.due, D("2026-10-30"));
  // Missing the WebMB confirmation: refused.
  const noWebmb = form1002Submit({ period_end: D("2026-09-30"), webmb_confirmation: null, ceo_cfo_certification: "CERT-2026Q3" });
  assert.equal(noWebmb.allowed, false); assert.match(noWebmb.refusal!, /WebMB submission confirmation/); assert.equal(noWebmb.event, null);
  // Missing both: the refusal names both.
  const neither = form1002Submit({ period_end: D("2026-09-30"), webmb_confirmation: null, ceo_cfo_certification: null });
  assert.equal(neither.allowed, false); assert.match(neither.refusal!, /WebMB submission confirmation and CEO\/CFO certification/);
  // The certification is an officer act the agent cannot supply (guardrail: certifications are CEO/CFO acts).
  const agentCert = officerCertify({ entity: "supermortgage", period_end: D("2026-09-30"), status: "compliant", stale: false, certified_by: { role: "agent", id: "qc-audit" }, certified_on: D("2026-10-07") });
  assert.equal(agentCert.allowed, false); assert.equal(agentCert.certified_by_officer_id, null); assert.match(agentCert.refusal!, /certifications are CEO\/CFO acts \(officer\)/); assert.equal(agentCert.event, null);
  const officerCert = officerCertify({ entity: "supermortgage", period_end: D("2026-09-30"), status: "compliant", stale: false, certified_by: { role: "officer", id: "ceo-1" }, certified_on: D("2026-10-07") });
  assert.equal(officerCert.allowed, true); assert.equal(officerCert.certified_by_officer_id, "ceo-1"); assert.equal(officerCert.event!.payload.quarter, 3);
  assert.ok(satisfies("FHFA_ELIG_QUARTERLY_TEST", officerCert.event)); assert.equal(officerCert.timer.due, D("2026-10-15"));   // BD10 (fannie_et) after 2026-09-30 across Columbus Day (Mon 2026-10-12)
  assert.equal(officerCertify({ entity: "supermortgage", period_end: D("2026-10-31"), status: "compliant", stale: false, certified_by: { role: "officer", id: "ceo-1" }, certified_on: D("2026-11-06") }).allowed, false);   // monthly runs are not certified
  // With both records the transition is allowed and the event satisfies FNMA_A4102_FORM1002_Q_30 (quarter ∈ {1, 2, 3}).
  const ok = form1002Submit({ period_end: D("2026-09-30"), webmb_confirmation: "WMB-2026Q3-001", ceo_cfo_certification: "CERT-2026Q3" });
  assert.equal(ok.allowed, true); assert.equal(ok.state, "submitted");
  assert.deepEqual(ok.event, { type: "filing.submitted", payload: { form: "form_1002", quarter: 3, period_end: D("2026-09-30"), webmb_confirmation: "WMB-2026Q3-001", ceo_cfo_certification: "CERT-2026Q3" } });
  assert.ok(satisfies("FNMA_A4102_FORM1002_Q_30", ok.event)); assert.equal(satisfies("FNMA_A4102_FORM1002_YE_60", ok.event), false);
  // The December 31 filing satisfies the year-end row instead.
  const ye = form1002Submit({ period_end: D("2026-12-31"), webmb_confirmation: "WMB-2026Q4-001", ceo_cfo_certification: "CERT-2026Q4" });
  assert.equal(ye.event!.payload.quarter, 4); assert.equal(ye.due, D("2027-03-01")); assert.ok(satisfies("FNMA_A4102_FORM1002_YE_60", ye.event)); assert.equal(satisfies("FNMA_A4102_FORM1002_Q_30", ye.event), false);
  // A refused transition emits nothing that could satisfy either row.
  assert.equal(satisfies("FNMA_A4102_FORM1002_Q_30", { type: "filing.submitted", payload: { form: "form_1002", quarter: 3, period_end: D("2026-09-30"), webmb_confirmation: "WMB-2026Q3-001", ceo_cfo_certification: null } }), false);
  // On the bus: the agent's `form1002.submit` without the certification record is refused — the filing row stays `officer_review`, no `filing.submitted` is appended
  // and FNMA_A4102_FORM1002_Q_30 stays armed; the agent cannot certify at all (`eligibility.certify` is a human act); with both records the transition is allowed.
  const b = bus18_7("2026-10-07T14:00:00.000Z");
  await b.run("upb_position.finalize", upbSub("2026-09-30")); await b.run("gl_snapshot.intake", glEx2("2026-09-30", "2026-10-06"));
  await b.run("eligibility.period.close", { period_end: "2026-09-30" }); await b.run("eligibility.compute", { period_end: "2026-09-30", computed_on: "2026-10-07" });
  const fq = b.timers("FNMA_A4102_FORM1002_Q_30"); assert.equal(fq.length, 1);
  const refused = await b.run("form1002.submit", { period_end: "2026-09-30", webmb_confirmation: "WMB-2026Q3-001" });
  assert.equal(refused.allowed, false); assert.match(String(refused.refusal), /CEO\/CFO certification/); assert.equal(refused.state, "form1002_prepared");
  assert.equal(b.rt.store.get("regulatory_filings", "supermortgage:form_1002:2026-09-30")!.data.status, "officer_review"); assert.equal(b.ctx.events.ofType("filing.submitted").length, 0); assert.equal(fq[0]!.status, "armed");
  await assert.rejects(b.run("eligibility.certify", { period_end: "2026-09-30" }), (e: unknown) => e instanceof CommandRefused && e.code === "HUMAN_ONLY");
  assert.equal(b.ctx.events.ofType("command.refused").length, 1); assert.equal(b.timers("FHFA_ELIG_QUARTERLY_TEST")[0]!.status, "armed");
  const certified = await b.run("eligibility.certify", { period_end: "2026-09-30", certified_on: "2026-10-08", certification_document_id: "ELIG-CERT-2026Q3" }, OFFICER);
  assert.equal(certified.allowed, true); assert.equal(certified.certified_by_officer_id, "cfo-1"); assert.equal(b.timers("FHFA_ELIG_QUARTERLY_TEST")[0]!.status, "satisfied");
  const ok2 = await b.run("form1002.submit", { period_end: "2026-09-30", webmb_confirmation: "WMB-2026Q3-001", ceo_cfo_certification: "CERT-2026Q3", submitted_on: "2026-10-20" });
  assert.equal(ok2.allowed, true); assert.equal(ok2.state, "submitted"); assert.equal(fq[0]!.status, "satisfied");
  const filed = b.ctx.events.ofType("filing.submitted"); assert.equal(filed.length, 1); assert.equal(filed[0]!.id, fq[0]!.satisfiedByEventId);
  assert.deepEqual([filed[0]!.payload.form, filed[0]!.payload.quarter, filed[0]!.payload.webmb_confirmation, filed[0]!.payload.ceo_cfo_certification, filed[0]!.payload.channel], ["form_1002", 3, "WMB-2026Q3-001", "CERT-2026Q3", "WebMB"]);
  assert.equal(b.rt.store.get("regulatory_filings", "supermortgage:form_1002:2026-09-30")!.data.status, "submitted");
});

test("18.7-T9: Given Supermortgage holds zero Fannie Mae loans as of Dec 31, then `FNMA_A4101_SERVICE_ONE_LOAN_DEC31` breaches to `officer` (approval at risk).", async () => {
  const zero = serviceOneLoanTest({ as_of: D("2026-12-31"), fnma_loans_serviced: 0 });
  assert.equal(zero.code, "FNMA_A4101_SERVICE_ONE_LOAN_DEC31"); assert.equal(zero.breached, true);
  assert.deepEqual(zero.escalations.map((e) => [e.kind, e.severity, e.due]), [["officer", "sev1", D("2026-12-31")]]);
  assert.match(zero.escalations[0]!.reason, /approval at risk/); assert.match(zero.escalations[0]!.reason, /at least one loan serviced for Fannie Mae as of December 31/);
  assert.match(zero.consequence!, /loss of access to all technology that is licensed only to approved servicers/);
  // The registry evaluator that backs the timer closes on the same facts.
  assert.equal(zero.evaluator, "18.7.servicesAtLeastOneFannieMaeLoan"); assert.deepEqual(zero.facts, { fnma_loans_serviced_dec31: 0 });
  const gate = evaluateGate(zero.evaluator, zero.facts);
  assert.equal(gate.open, false); assert.match(gate.reason!, /Fannie Mae loans serviced as of Dec 31/); assert.match(gate.reason!, /0 < 1/);
  const one = serviceOneLoanTest({ as_of: D("2026-12-31"), fnma_loans_serviced: 1 });
  assert.equal(one.breached, false); assert.deepEqual(one.escalations, []); assert.equal(one.consequence, null); assert.equal(evaluateGate(one.evaluator, one.facts).open, true);
  assert.equal(evaluateGate("18.7.servicesAtLeastOneFannieMaeLoan", {}).open, false);   // no position at all is not "≥ 1"
  // Registry row: recurring on `period.year_end`, evaluator-backed, sev-1 "approval at risk".
  const row = reg.get("FNMA_A4101_SERVICE_ONE_LOAN_DEC31")!;
  assert.equal(row.process, "18.7"); assert.equal(row.triggerPattern!.type, "period.year_end"); assert.deepEqual(row.offsetParsed, { kind: "evaluator", ref: "18.7.servicesAtLeastOneFannieMaeLoan" });
  assert.equal(row.severity.level, 1); assert.match(row.breach, /approval at risk/); assert.equal(row.kindNorm, "recurring");
  // On the bus: the Dec 31 close appends `period.year_end` → FNMA_A4101_SERVICE_ONE_LOAN_DEC31 armed as the evaluator gate on the Dec 31 anchor; the one-loan test
  // with zero Fannie Mae loans opens the sev-1 `officer` escalation (approval at risk); with one loan it opens nothing.
  const b = bus18_7("2027-01-04T14:00:00.000Z");
  await b.run("eligibility.period.close", { period_end: "2026-12-31" });
  const armed = b.timers("FNMA_A4101_SERVICE_ONE_LOAN_DEC31"); assert.equal(armed.length, 1);
  assert.deepEqual([armed[0]!.status, armed[0]!.anchorDate, armed[0]!.note, armed[0]!.dueDate], ["armed", "2026-12-31", "evaluator:18.7.servicesAtLeastOneFannieMaeLoan", undefined]);
  const tested = await b.run("service_one_loan.test", { as_of: "2026-12-31", fnma_loans_serviced: 0 });
  assert.equal(tested.breached, true); assert.equal((tested.escalation_ids as string[]).length, 1);
  assert.deepEqual(b.rt.escalations.opened.map((e) => [e.kind, e.ownerRole, e.severity, e.payload.timer]), [["officer", "officer", "sev1", "FNMA_A4101_SERVICE_ONE_LOAN_DEC31"]]);
  assert.match(String(b.rt.escalations.opened[0]!.payload.reason), /approval at risk/);
  const ev = b.ctx.events.ofType("eligibility.one_loan.tested"); assert.equal(ev.length, 1); assert.equal(ev[0]!.payload.fnma_loans_serviced_dec31, 0); assert.equal(evaluateGate("18.7.servicesAtLeastOneFannieMaeLoan", ev[0]!.payload).open, false);
  assert.equal((await b.run("service_one_loan.test", { as_of: "2026-12-31", fnma_loans_serviced: 1 })).breached, false); assert.equal(b.rt.escalations.opened.length, 1);
});

test("18.7 timers and guardrails: material change 5 BD (1 BD during stress) evidenced; partner UPB report BD5; CSBS applicability; hashed GL sources, no GL adjustments, sourced liquidity classification; rule 7 pipeline projection", () => {
  // FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD: material change detected Wed 2026-10-07 → notice by 2026-10-15 (5 servicer BD across Columbus Day); during stress 1 BD → 2026-10-08.
  const mc = materialChangeNotice({ detected_on: D("2026-10-07"), large: true, stress: false, decline_trigger: "decline_flags.q_over_q_25" });
  assert.equal(mc.required, true); assert.equal(mc.variant, "FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD"); assert.equal(mc.business_days, 5); assert.equal(mc.timer.due, D("2026-10-15"));
  assert.equal(mc.trigger_event, ELIG_EVENTS.material_change_detected); assert.equal(mc.timer.satisfied_by, ELIG_EVENTS.material_change_notified);
  assert.deepEqual(mc.escalations.map((e) => [e.kind, e.severity, e.due]), [["officer", "sev1", D("2026-10-15")]]);
  const stress = materialChangeNotice({ detected_on: D("2026-10-07"), large: true, stress: true });
  assert.equal(stress.variant, "FNMA_A4101_LARGE_MATERIAL_CHANGE_STRESS_1BD"); assert.equal(stress.business_days, 1); assert.equal(stress.timer.due, D("2026-10-08")); assert.equal(stress.timer.code, "FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD");
  assert.equal(materialChangeNotice({ detected_on: D("2026-10-07"), large: false, stress: false }).required, false);
  const row = reg.get("FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD")!;
  assert.equal(row.triggerPattern!.type, "material_change.detected"); assert.deepEqual(row.triggerPattern!.conditions, [{ field: "large_servicer", op: "=", value: "true" }]);
  assert.deepEqual(row.offsetParsed, { kind: "step", n: 5, unit: "business_days_servicer" }); assert.equal(row.severity.level, 1);
  assert.ok(eventMatches(row.triggerPattern!, asEvent({ type: "material_change.detected", payload: { decline_trigger: "decline_flags.q_over_q_25", large_servicer: true } })));
  assert.equal(eventMatches(row.triggerPattern!, asEvent({ type: "material_change.detected", payload: { decline_trigger: "decline_flags.q_over_q_25", large_servicer: false } })), false);
  // "notice evidenced": the notice needs its evidence document; then it satisfies the row.
  const unevidenced = materialChangeNotified({ detected_on: D("2026-10-07"), large: true, stress: false, sent_on: D("2026-10-09"), evidence_document_id: null });
  assert.equal(unevidenced.allowed, false); assert.equal(unevidenced.event, null); assert.match(unevidenced.refusal!, /evidence/);
  const evidenced = materialChangeNotified({ detected_on: D("2026-10-07"), large: true, stress: false, sent_on: D("2026-10-09"), evidence_document_id: "DOC-MC-1" });
  assert.equal(evidenced.timely, true); assert.equal(evidenced.due, D("2026-10-15")); assert.ok(satisfies("FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD", evidenced.event));
  assert.equal(materialChangeNotified({ detected_on: D("2026-10-07"), large: true, stress: true, sent_on: D("2026-10-09"), evidence_document_id: "DOC-MC-1" }).timely, false);   // stress: due 2026-10-08
  // SM_PARTNER_UPB_REPORT_MONTHLY_BD5 and CSBS_PRUDENTIAL_APPLICABILITY_CHECK_Q.
  const upb = partnerUpbReportDue(D("2026-10-31"));
  assert.deepEqual(upb, { code: "SM_PARTNER_UPB_REPORT_MONTHLY_BD5", due: D("2026-11-06"), template: "ELIG-UPB-PARTNER-M-v1", satisfied_by: ELIG_EVENTS.partner_upb_report_delivered });
  assert.ok(satisfies("SM_PARTNER_UPB_REPORT_MONTHLY_BD5", { type: "partner.upb_report.delivered", payload: { template: "ELIG-UPB-PARTNER-M-v1", period_end: D("2026-10-31") } }));
  assert.equal(partnerUpbReportDue(D("2026-12-31")).due, D("2027-01-08"));   // 2027-01-01 holiday
  const csbs = csbsPrudentialApplicability({ quarter_end: D("2026-09-30"), loan_count: 24_000, states: ["NC", "SC", "GA"], fhfa_compliant: true });
  assert.equal(csbs.applies, true); assert.equal(csbs.state_count, 3); assert.equal(csbs.nc_safe_harbor, true);
  assert.ok(satisfies("CSBS_PRUDENTIAL_APPLICABILITY_CHECK_Q", { type: csbs.record_event, payload: { applies: true, loan_count: 24_000, state_count: 3 } }));
  assert.equal(csbsPrudentialApplicability({ quarter_end: D("2026-09-30"), loan_count: 1_999, states: ["NC", "SC"], fhfa_compliant: true }).applies, false);
  assert.equal(csbsPrudentialApplicability({ quarter_end: D("2026-09-30"), loan_count: 24_000, states: ["NC", "nc"], fhfa_compliant: true }).applies, false);
  // Every 18.7 satisfaction pattern the registry names is a string ELIG_EVENTS carries.
  for (const code of ["FHFA_ELIG_QUARTERLY_TEST", "FNMA_A4102_FORM1002_Q_30", "FNMA_A4102_FORM1002_YE_60", "FNMA_A4102_FORM1002A_M_30", "FNMA_A4101_LARGE_CAPLIQ_PLAN_90", "FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD", "SM_ELIG_WARNING_REMEDIATION_30", "SM_ELIG_BREACH_NOTIFY_1BD", "SM_PARTNER_UPB_REPORT_MONTHLY_BD5", "CSBS_PRUDENTIAL_APPLICABILITY_CHECK_Q"]) {
    const t = reg.get(code)!; assert.equal(t.process, "18.7"); assert.ok(Object.values(ELIG_EVENTS).includes(t.satisfiedPattern!.raw as never), `${code}: ${t.satisfiedPattern!.raw}`);
  }
  // Guardrail: every input is a hashed source document; the agent never adjusts GL balances.
  const docs = [{ id: "TB-2026-09", sha256: "a".repeat(64) }, { id: "CUST-2026-09", sha256: "b".repeat(64) }];
  const intake = glSnapshotIntake({ entity: "supermortgage", period_end: D("2026-09-30"), source_documents: docs });
  assert.equal(intake.accepted, true); assert.match(intake.inputs_hash!, /^[0-9a-f]{64}$/); assert.deepEqual(intake.source_document_ids, ["TB-2026-09", "CUST-2026-09"]);
  assert.equal(glSnapshotIntake({ entity: "supermortgage", period_end: D("2026-09-30"), source_documents: [...docs].reverse() }).inputs_hash, intake.inputs_hash);   // order-independent
  const unhashed = glSnapshotIntake({ entity: "supermortgage", period_end: D("2026-09-30"), source_documents: [docs[0]!, { id: "MEMO-1", sha256: null }] });
  assert.equal(unhashed.accepted, false); assert.equal(unhashed.refusal_code, "UNHASHED_SOURCE"); assert.match(unhashed.refusal!, /MEMO-1/); assert.equal(unhashed.inputs_hash, null);
  assert.equal(glSnapshotIntake({ entity: "partner", period_end: D("2026-09-30"), source_documents: [] }).refusal_code, "UNHASHED_SOURCE");
  const adjusted = glSnapshotIntake({ entity: "supermortgage", period_end: D("2026-09-30"), source_documents: docs, adjustments: [{ account: "1010-cash", cents: 100_000n }] });
  assert.equal(adjusted.accepted, false); assert.equal(adjusted.refusal_code, "NEVER_ADJUST_GL"); assert.match(adjusted.refusal!, /never adjusts GL balances/);
  // Guardrail: "eligible security" / "unrestricted cash" need a source (custodial statement, facility agreement) or are excluded; covenant-breached lines excluded.
  const liq = classifyLiquidity({
    cash: [{ item: "operating account", cents: cents("6000000"), source_document_id: "BANK-2026-09" }, { item: "unsourced sweep", cents: cents("1000000"), source_document_id: null }],
    securities: [
      { item: "FNMA MBS", cents: cents("2000000"), source_document_id: "CUST-2026-09", kind: "agency_mbs", unpledged: true, investment_grade: true },
      { item: "corporate bond", cents: cents("500000"), source_document_id: "CUST-2026-09", kind: "corporate", unpledged: true, investment_grade: true },
      { item: "pledged Treasuries", cents: cents("300000"), source_document_id: "CUST-2026-09", kind: "treasury", unpledged: false, investment_grade: true },
      { item: "unsourced GNMA MBS", cents: cents("400000"), source_document_id: null, kind: "agency_mbs", unpledged: true, investment_grade: true },
    ],
    advance_lines: [
      { item: "advance facility A", committed: cents("10000000"), drawn: cents("4000000"), facility_agreement_id: "FAC-A", covenant_breached: false },
      { item: "advance facility B", committed: cents("5000000"), drawn: 0n, facility_agreement_id: "FAC-B", covenant_breached: true },
      { item: "verbal line", committed: cents("2000000"), drawn: 0n, facility_agreement_id: null, covenant_breached: false },
    ],
  });
  assert.equal(liq.cash_unrestricted, cents("6000000")); assert.equal(liq.eligible_securities, cents("2000000")); assert.equal(liq.advance_line_committed, cents("10000000")); assert.equal(liq.advance_line_drawn, cents("4000000"));
  assert.deepEqual(liq.excluded.map((x) => x.item), ["unsourced sweep", "corporate bond", "pledged Treasuries", "unsourced GNMA MBS", "advance facility B", "verbal line"]);
  assert.match(liq.excluded.find((x) => x.item === "advance facility B")!.reason, /committed-but-unavailable/);
  assert.equal(eligibilityTest({ ...EX1, ...liq }).allowable_liquidity, 1_100_000_000n);   // the sourced items reproduce worked example 1's $11,000,000 allowable liquidity
  // Rule 7, third clause: the boarding pipeline projects next quarter's requirement — $10B more Enterprise UPB lifts required NW to $42.5M against $37.5M ANW → warning now.
  const pipeline = { ent_ss_sa_upb: cents("10000000000"), ent_aa_upb: 0n, gnma_upb: 0n, other_upb: 0n };
  const proj = projectedNextQuarter(EX1, pipeline);
  assert.equal(proj.projected.req_nw, 4_250_000_000n); assert.equal(proj.projected.nw_surplus, -500_000_000n); assert.equal(proj.would_breach, true); assert.match(proj.reason!, /nw_surplus < 0/);
  const ahead = eligibilityTest({ ...EX1, pipeline });
  assert.equal(ahead.nw_surplus, 2_000_000_000n); assert.equal(ahead.status, "warning"); assert.equal(ahead.reason, "projected next-quarter nw_surplus < 0 (boarding pipeline)");
  assert.equal(quarterlyTest({ ...EX1, pipeline, period_end: D("2026-12-31"), computed_on: D("2027-01-08") }).outcome!.timer.code, "SM_ELIG_WARNING_REMEDIATION_30");
  assert.equal(eligibilityTest({ ...EX1, pipeline: { ...pipeline, ent_ss_sa_upb: cents("8000000000") } }).status, "compliant");   // $14B × 25 bps + $2.5M = $37.5M: projected surplus exactly $0
  assert.equal(eligibilityTest({ ...EX1, pipeline: null }).status, "compliant");
  // Edge case: UPB finalization — a 0.6% swing holds the certification, a 0.4% swing only re-runs.
  assert.deepEqual(upbFinalization({ reconciled_upb: cents("6000000000"), final_upb: cents("6036000000") }), { rerun: true, difference: cents("36000000"), certification_waits: true });
  assert.equal(upbFinalization({ reconciled_upb: cents("6000000000"), final_upb: cents("6024000000") }).certification_waits, false);
});

test("18.7 worked figures: ex1 ANW $37,500,000.00 = $40,000,000.00 − $2,000,000.00 − $500,000.00; required NW $17,500,000.00 = $2,500,000.00 + $6,000,000,000.00 × 0.0025 ($15,000,000.00) → surplus $20,000,000.00; ratio 12.50%; allowable liquidity $11,000,000.00 = $6,000,000.00 + $2,000,000.00 + 0.5 × $6,000,000.00; required liquidity $3,850,000.00 = $3,500,000.00 + $350,000.00 → surplus $7,150,000.00; ex2 ANW $3,300,000.00, required $2,500,000.00, surplus $800,000.00 (32% of requirement / 24.24% of ANW → warning), ratio 27.5%, required liquidity $0.00, allowable $2,500,000.00, expensed-software ANW $4,200,000.00; ex3 $37,500,000.00 → $27,000,000.00 (−28.0%) → q_over_q_25 breach, partner/officer 1 BD, Fannie Mae 5 BD; T4 A/A component $43,209.88", () => {
  // Worked example 1 — partner (master; non-depository), quarter-end 2026-12-31.
  const r1 = netWorth(EX1);
  assert.equal(r1.anw, 3_750_000_000n); assert.equal(r1.anw, cents("40000000") - cents("2000000") - cents("500000"));
  assert.equal(r1.req_nw, 1_750_000_000n); assert.equal(r1.req_nw, 250_000_000n + 1_500_000_000n); assert.equal((cents("5000000000") + cents("1000000000")) * 25n / 10_000n, 1_500_000_000n);
  assert.equal(r1.nw_surplus, 2_000_000_000n); assert.equal(r1.ratio_bps, 1250);
  assert.equal(r1.allowable_liquidity, 1_100_000_000n); assert.equal(r1.allowable_liquidity, cents("6000000") + cents("2000000") + (cents("10000000") - cents("4000000")) / 2n);
  assert.equal(r1.required_liquidity, 385_000_000n); assert.equal(r1.required_liquidity, 350_000_000n + 35_000_000n);
  assert.equal(cents("5000000000") * 7n / 10_000n, 350_000_000n); assert.equal(cents("1000000000") * 35n / 100_000n, 35_000_000n);
  assert.equal(r1.liquidity_surplus, 715_000_000n); assert.equal(r1.status, "compliant"); assert.equal(r1.large, false);
  assert.equal(largeServicerCrossing({ quarter_end: D("2026-12-31"), total_upb: cents("6000000000"), prior_total_upb: null }).large, false);
  const t1 = quarterlyTest({ ...EX1, period_end: D("2026-12-31"), computed_on: D("2027-01-08") });
  assert.equal(t1.result.status, "compliant"); assert.equal(t1.reason, null); assert.equal(t1.outcome, null); assert.equal(t1.certification_required, true);

  // Worked example 2 — Supermortgage (pure subservicer): $6B subserviced UPB excluded; own master-serviced UPB $0.
  const r2 = netWorth(EX2);
  assert.equal(r2.anw, 330_000_000n); assert.equal(r2.anw, cents("4200000") - cents("900000"));
  assert.equal(r2.req_nw, 250_000_000n); assert.equal(r2.nw_surplus, 80_000_000n);
  // AUDIT-NOTES 18.7: $800,000 is 32% of the $2.5M requirement and 24.24% of the $3.3M ANW; the warning band is < 25% of either.
  assert.equal(r2.nw_surplus * 10_000n / r2.req_nw, 3_200n); assert.equal(r2.nw_surplus * 10_000n / r2.anw, 2_424n);
  assert.ok(r2.nw_surplus * 4n >= r2.req_nw); assert.ok(r2.nw_surplus * 4n < r2.anw);
  assert.equal(r2.ratio_bps, 2750); assert.equal(r2.required_liquidity, 0n); assert.equal(r2.allowable_liquidity, 250_000_000n); assert.equal(r2.status, "warning");
  assert.equal(netWorth({ ...EX2, goodwill_intangibles: 0n }).anw, 420_000_000n);    // capitalized software expensed instead of deducted
  const t2 = quarterlyTest({ ...EX2, period_end: D("2026-09-30"), computed_on: D("2026-10-07") });
  assert.equal(t2.reason, "nw_surplus < 25% of anw"); assert.equal(t2.outcome!.status, "warning");
  assert.deepEqual(t2.outcome!.timer, warningDetected({ detected_on: D("2026-10-07"), reason: "nw_surplus < 25% of anw" }).timer);
  assert.equal(t2.outcome!.timer.code, "SM_ELIG_WARNING_REMEDIATION_30"); assert.equal(t2.outcome!.timer.due, D("2026-11-06"));
  assert.equal(t2.outcome!.timer.satisfied_by, "eligibility.remediation_plan.approved{approved_by=board}");
  assert.deepEqual(t2.outcome!.escalations.map((e) => [e.kind, e.severity]), [["officer", "sev2"]]);

  // Worked example 3 — decline trigger: ANW Q2 $37.5M → Q3 $27.0M (−28.0%), positive surplus, breach irrespective of surplus.
  const r3 = eligibilityTest(EX3);
  assert.equal(r3.anw, 2_700_000_000n); assert.equal((3_750_000_000n - 2_700_000_000n) * 1_000n / 3_750_000_000n, 280n);
  assert.ok(r3.nw_surplus > 0n); assert.equal(r3.decline_flags.q_over_q_25, true); assert.equal(r3.status, "breach"); assert.equal(netWorth(EX3).status, "breach");
  const t3 = quarterlyTest({ ...EX3, period_end: D("2026-09-30"), computed_on: D("2026-10-07") });
  assert.equal(t3.reason, "decline_flags.q_over_q_25");
  const b = t3.outcome!; assert.equal(b.status, "breach");
  assert.deepEqual(b, breachDetected({ detected_on: D("2026-10-07"), trigger: "decline_flags.q_over_q_25" }));
  if (b.status !== "breach") throw new Error("unreachable");
  assert.deepEqual(b.notices.map((x) => [x.to, x.due]), [["partner", D("2026-10-08")], ["officer", D("2026-10-08")], ["fannie_mae", D("2026-10-15")]]);   // 5 servicer BD across Columbus Day (Mon 2026-10-12)
  assert.equal(b.timer.code, "SM_ELIG_BREACH_NOTIFY_1BD"); assert.equal(b.timer.due, D("2026-10-08")); assert.equal(b.timer.satisfied_by, "eligibility.breach.notified{partner=true, officer=true}");
  assert.deepEqual(b.fnma_handoff, { process: "18.4", kind: "material_adverse_change", due: D("2026-10-15") });
  assert.deepEqual(b.escalations.map((e) => [e.kind, e.severity]), [["officer", "sev1"]]);

  // T4 — Enterprise A/A component: round(12_345_678_900 × 35 / 100_000) = 4,320,988¢ ($43,209.88; exact 4,320,987.615 rounds half-up).
  assert.equal(netWorth({ ...EX1, ent_ss_sa_upb: 0n, ent_aa_upb: 12_345_678_900n }).required_liquidity, 4_320_988n);
  assert.equal(12_345_678_900n * 35n / 100_000n, 4_320_987n); assert.equal((12_345_678_900n * 35n) % 100_000n * 2n >= 100_000n, true);

  // T5 / T6 clocks the timers-18-7 rows deliver: Form 1002 Q3 2026 due 2026-10-30 (warning 10-20); Dec 31 due 2027-03-01 (warning day 40 = 2027-02-09);
  // $50B crossing at 2027-06-30 → buffer that quarter, 1002A for July (due 2027-08-30), capital/liquidity plan 2028-03-30.
  assert.deepEqual(form1002Due(D("2026-09-30")), { due: D("2026-10-30"), warning: D("2026-10-20") }); assert.equal(form1002Due(D("2026-12-31")).due, D("2027-03-01"));
  assert.deepEqual([form1002Clock(D("2026-12-31")).due, form1002Clock(D("2026-12-31")).warning], [D("2027-03-01"), D("2027-02-09")]);
  const x = largeServicerCrossing({ quarter_end: D("2027-06-30"), total_upb: cents("50000000000"), prior_total_upb: cents("48000000000") });
  assert.equal(x.crossed, true); assert.equal(x.buffer_applies_from, D("2027-06-30"));
  assert.deepEqual(x.form1002a, { first_month_end: D("2027-07-31"), due: D("2027-08-30") });
  assert.deepEqual(x.capliq_plan, { year_end: D("2027-12-31"), due: D("2028-03-30") }); assert.equal(capitalPlanDue(D("2027-12-31")), D("2028-03-30"));
  assert.equal(largeServicerCrossing({ quarter_end: D("2027-03-31"), total_upb: cents("48000000000"), prior_total_upb: cents("30000000000") }).ratings_warning, true);
  // Buffer at the threshold: S/A $49B + A/A $1B = $50B total → large; required liquidity 7 bps ($34,300,000) + 3.5 bps ($350,000) + 2 bps Enterprise buffer ($10,000,000) = $44,650,000; one cent under → no buffer.
  const atThreshold = netWorth({ ...EX1, ent_ss_sa_upb: cents("49000000000") }); assert.equal(atThreshold.large, true); assert.equal(atThreshold.required_liquidity, 4_465_000_000n);
  assert.equal(atThreshold.required_liquidity - 3_430_000_000n - 35_000_000n, 1_000_000_000n);
  const underThreshold = netWorth({ ...EX1, ent_ss_sa_upb: cents("48999999999") }); assert.equal(underThreshold.large, false); assert.equal(underThreshold.required_liquidity, 3_465_000_000n);

  // T8 — the `submitted` transition and the event that satisfies FNMA_A4102_FORM1002_Q_30.
  const refused = form1002Submit({ period_end: D("2026-09-30"), webmb_confirmation: "WMB-2026Q3-001", ceo_cfo_certification: null });
  assert.equal(refused.allowed, false); assert.match(refused.refusal!, /CEO\/CFO certification/); assert.equal(refused.state, "form1002_prepared"); assert.equal(refused.event, null);
  assert.match(form1002Submit({ period_end: D("2026-09-30"), webmb_confirmation: null, ceo_cfo_certification: "CERT-1" }).refusal!, /WebMB submission confirmation/);
  const ok = form1002Submit({ period_end: D("2026-09-30"), webmb_confirmation: "WMB-2026Q3-001", ceo_cfo_certification: "CERT-1" });
  assert.equal(ok.state, "submitted"); assert.equal(ok.due, D("2026-10-30"));
  assert.deepEqual(ok.event, { type: "filing.submitted", payload: { form: "form_1002", quarter: 3, period_end: D("2026-09-30"), webmb_confirmation: "WMB-2026Q3-001", ceo_cfo_certification: "CERT-1" } });

  // Partner UPB report by BD5 (SM_PARTNER_UPB_REPORT_MONTHLY_BD5) and the CSBS applicability record.
  assert.deepEqual(partnerUpbReportDue(D("2026-10-31")), { code: "SM_PARTNER_UPB_REPORT_MONTHLY_BD5", due: D("2026-11-06"), template: "ELIG-UPB-PARTNER-M-v1", satisfied_by: "partner.upb_report.delivered{template=ELIG-UPB-PARTNER-M-v1}" });
  const csbs = csbsPrudentialApplicability({ quarter_end: D("2026-09-30"), loan_count: 24_000, states: ["NC", "SC", "GA"], fhfa_compliant: true });
  assert.equal(csbs.applies, true); assert.equal(csbs.state_count, 3); assert.equal(csbs.nc_safe_harbor, true); assert.equal(csbs.record_event, "csbs.prudential_applicability.recorded");
});

test("18.7 eligibility module on the bus: GL/UPB intake guardrails, the September close arms the partner UPB report (BD5) and the CSBS check, the large seller/servicer material-change clock (5 BD across Columbus Day), every 18.7 tool refuses empty input, the bus slice is what agents.json names", async () => {
  // Guardrails refuse before anything runs: the agent never adjusts GL balances; every input is a hashed source document.
  const b = bus18_7("2026-10-01T14:00:00.000Z");
  await assert.rejects(b.run("gl_snapshot.intake", { ...glEx2("2026-09-30", "2026-10-06"), adjustments: [{ account: "1010-cash", cents: 100_000n }] }), (e: unknown) => e instanceof CommandRefused && e.code === "NEVER_ADJUST_GL");
  await assert.rejects(b.run("gl_snapshot.intake", { ...glEx2("2026-09-30", "2026-10-06"), source_documents: [DOCS[0], { id: "MEMO-1", sha256: null }] }), (e: unknown) => e instanceof CommandRefused && e.code === "UNHASHED_SOURCE");
  await assert.rejects(b.run("gl_snapshot.intake", { ...glEx2("2026-09-30", "2026-10-06"), source_documents: [] }), (e: unknown) => e instanceof CommandRefused && e.code === "UNHASHED_SOURCE");
  assert.equal(b.rt.store.list("gl_snapshots").length, 0); assert.deepEqual(b.types(), ["command.refused", "command.refused", "command.refused"]);
  // Sourced liquidity items are classified on intake; the unsourced sweep and the covenant-breached line are excluded from the stored allowable-liquidity inputs.
  const intake = await b.run("gl_snapshot.intake", { ...glEx2("2026-09-30", "2026-10-06"), cash: [{ item: "operating account", cents: 250_000_000n, source_document_id: "BANK-2026-09" }, { item: "unsourced sweep", cents: 100_000_000n, source_document_id: null }], advance_lines: [{ item: "facility B", committed: 500_000_000n, drawn: 0n, facility_agreement_id: "FAC-B", covenant_breached: true }] });
  assert.equal(intake.accepted, true); assert.match(String(intake.inputs_hash), /^[0-9a-f]{64}$/); assert.deepEqual((intake.excluded_liquidity as { item: string }[]).map((x) => x.item), ["unsourced sweep", "facility B"]);
  assert.deepEqual([b.rt.store.get("gl_snapshots", "supermortgage:2026-09-30")!.data.cash_unrestricted_cents, b.rt.store.get("gl_snapshots", "supermortgage:2026-09-30")!.data.advance_line_committed_cents], [250_000_000n, 0n]);
  const gl = b.ctx.events.ofType("gl.close.completed"); assert.equal(gl.length, 1); assert.deepEqual([gl[0]!.payload.entity, gl[0]!.payload.period, gl[0]!.payload.period_end, gl[0]!.payload.inputs_hash], ["supermortgage", "2026-09", "2026-09-30", intake.inputs_hash]);
  assert.deepEqual(glCloseCompletedEvent({ entity: "supermortgage", period_end: D("2026-09-30"), received_on: D("2026-10-06"), intake: glSnapshotIntake({ entity: "supermortgage", period_end: D("2026-09-30"), source_documents: [] }) }), null);
  // The Section 5 position: an empty or negative position is refused (RangeError), a good one is stored per class and announced.
  await assert.rejects(b.run("upb_position.finalize", { entity: "partner", period_end: "2026-09-30", positions: [] }), RangeError);
  await assert.rejects(b.run("upb_position.finalize", { entity: "partner", period_end: "2026-09-30", positions: [{ class: "ent_aa", upb_cents: -1n, loan_count: 1 }] }), RangeError);
  await assert.rejects(b.run("upb_position.finalize", { entity: "partner", period_end: "2026-09-30", positions: [{ class: "jumbo", upb_cents: 1n, loan_count: 1 }] }), RangeError);
  const upb = await b.run("upb_position.finalize", upbPartner("2026-09-30")); assert.equal(upb.rows, 2); assert.equal(upb.master_serviced_upb_cents, cents("6000000000"));
  assert.equal(upbPositionFinalizedEvent({ entity: "partner", period_end: D("2026-09-30"), positions: [{ class: "ent_ss_sa", upb_cents: cents("5000000000"), loan_count: 20_000 }, { class: "subserviced_for_others", upb_cents: cents("1"), loan_count: 1 }], source: "s5" }).payload.master_serviced_upb_cents, cents("5000000000"));
  await b.run("upb_position.finalize", upbSub("2026-09-30"));
  // The September close: `period.month_end{quarter_month=3}` (no Form 1002A row — third month) and `period.quarter_end{quarter=3}` arm the partner UPB report by BD5
  // (2026-10-07) and the CSBS applicability check (recurring quarterly), both anchored on the month-end however late the close is processed.
  b.clock.set("2026-10-02T09:00:00.000Z");
  const close = periodCloseEvents({ entity: "supermortgage", period_end: D("2026-09-30"), large_servicer: false });
  assert.deepEqual(close.events.map((e) => e.type), ["period.month_end", "period.quarter_end"]); assert.deepEqual([close.quarter, close.quarter_month, close.quarter_end, close.year_end], [3, 3, true, false]);
  assert.deepEqual(close.clocks, { gl_close_by: D("2026-10-07"), partner_upb_report_due: D("2026-10-07"), eligibility_test_by: D("2026-10-15"), form1002: form1002Clock(D("2026-09-30")), form1002a: null, capliq_plan: null });
  assert.deepEqual(periodCloseEvents({ entity: "supermortgage", period_end: D("2026-12-31"), large_servicer: true }).events.map((e) => [e.type, e.payload.quarter, e.payload.quarter_month, e.payload.large_servicer]), [["period.month_end", 4, 3, true], ["period.quarter_end", 4, 3, true], ["period.year_end", 4, 3, true]]);
  assert.deepEqual(periodCloseEvents({ entity: "supermortgage", period_end: D("2027-07-31"), large_servicer: true }).clocks.form1002a, { code: "FNMA_A4102_FORM1002A_M_30", due: D("2027-08-30") });
  assert.throws(() => periodCloseEvents({ entity: "supermortgage", period_end: D("2026-09-29"), large_servicer: false }), RangeError);
  await b.run("eligibility.period.close", { period_end: "2026-09-30" });
  assert.deepEqual(b.ctx.timers.all().map((t) => [t.code, t.anchorDate, t.dueDate ?? null, t.status]).sort(), [
    ["CSBS_PRUDENTIAL_APPLICABILITY_CHECK_Q", "2026-09-30", "2026-12-30", "armed"], ["FHFA_ELIG_QUARTERLY_TEST", "2026-09-30", "2026-10-15", "armed"], ["FNMA_A4102_FORM1002_Q_30", "2026-09-30", "2026-10-30", "armed"], ["SM_PARTNER_UPB_REPORT_MONTHLY_BD5", "2026-09-30", "2026-10-07", "armed"],
  ]);
  const pu = b.timers("SM_PARTNER_UPB_REPORT_MONTHLY_BD5")[0]!, cs = b.timers("CSBS_PRUDENTIAL_APPLICABILITY_CHECK_Q")[0]!;
  assert.deepEqual(reg.get("SM_PARTNER_UPB_REPORT_MONTHLY_BD5")!.offsetParsed, { kind: "step", n: 5, unit: "business_days_fannie_et" }); assert.equal(reg.get("SM_PARTNER_UPB_REPORT_MONTHLY_BD5")!.anchorField, "period_end");
  // The partner UPB report (ELIG-UPB-PARTNER-M-v1) delivered 2026-10-05 from the partner's book by remittance type satisfies the BD5 row; an empty report is refused.
  await assert.rejects(b.run("partner_upb_report.deliver", { period_end: "2026-08-31", delivered_on: "2026-09-04" }), RangeError);   // no August position on file
  const report = await b.run("partner_upb_report.deliver", { period_end: "2026-09-30", delivered_on: "2026-10-05", recipient: "partner-cfo@partner.example", receipt_id: "RCPT-2026-09" });
  assert.deepEqual([report.template, report.code, report.due, report.timely, report.subserviced_upb_cents, report.loan_count], ["ELIG-UPB-PARTNER-M-v1", "SM_PARTNER_UPB_REPORT_MONTHLY_BD5", "2026-10-07", true, cents("6000000000"), 24_000]);
  assert.deepEqual(report.by_remittance_type, [{ class: "ent_ss_sa", upb_cents: cents("5000000000"), loan_count: 20_000 }, { class: "ent_aa", upb_cents: cents("1000000000"), loan_count: 4_000 }]);
  assert.equal(pu.status, "satisfied"); const delivered = b.ctx.events.ofType("partner.upb_report.delivered"); assert.equal(delivered.length, 1); assert.equal(delivered[0]!.id, pu.satisfiedByEventId); assert.equal(delivered[0]!.payload.template, "ELIG-UPB-PARTNER-M-v1");
  assert.ok(satisfies("SM_PARTNER_UPB_REPORT_MONTHLY_BD5", partnerUpbReportDelivered({ month_end: D("2026-09-30"), delivered_on: D("2026-10-05"), recipient: "partner", positions: [{ class: "ent_aa", upb_cents: 1n, loan_count: 1 }] }).event));
  assert.equal(partnerUpbReportDelivered({ month_end: D("2026-09-30"), delivered_on: D("2026-10-08"), recipient: "partner", positions: [{ class: "ent_aa", upb_cents: 1n, loan_count: 1 }] }).timely, false);   // BD6
  // The CSBS applicability record (≥ 2,000 loans in ≥ 2 states; NC safe harbor for an FHFA-compliant servicer) satisfies the quarterly check.
  await assert.rejects(b.run("csbs.applicability.record", { quarter_end: "2026-09-30", loan_count: 24_000, states: [] }), RangeError);
  await assert.rejects(b.run("csbs.applicability.record", { quarter_end: "2026-10-31", loan_count: 24_000, states: ["NC", "SC"] }), RangeError);
  const csbsOut = await b.run("csbs.applicability.record", { quarter_end: "2026-09-30", loan_count: 24_000, states: ["NC", "SC", "GA"], fhfa_compliant: true });
  assert.deepEqual([csbsOut.applies, csbsOut.state_count, csbsOut.nc_safe_harbor, csbsOut.informs], [true, 3, true, "Section 19 licensing program"]);
  assert.equal(cs.status, "satisfied"); const recorded = b.ctx.events.ofType("csbs.prudential_applicability.recorded"); assert.equal(recorded.length, 1); assert.equal(recorded[0]!.id, cs.satisfiedByEventId); assert.deepEqual(recorded[0]!.payload.states, ["GA", "NC", "SC"]);
  assert.equal(b.rt.store.get("csbs_applicability", "supermortgage:2026-09-30")!.data.applies, true);
  // The large seller/servicer material change: `material_change.detected{large_servicer=true}` arms FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD on the detection date
  // (Thu 2027-10-07 → 5 servicer BD across Columbus Day Mon 2027-10-11 = 2027-10-15); the evidenced Fannie Mae notice satisfies it; a non-large detection arms nothing.
  const lg = bus18_7("2027-10-07T14:00:00.000Z");
  const notLarge = await lg.run("material_change.detect", { detected_on: "2027-10-07", large_servicer: false, source: "facility.commitment.changed", description: "advance line commitment cut from $40M to $20M" });
  assert.equal(notLarge.required, false); assert.equal(notLarge.timer, null); assert.deepEqual(lg.timers("FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD"), []); assert.equal(lg.ctx.events.ofType("material_change.detected")[0]!.payload.large_servicer, false);
  const mcOut = await lg.run("material_change.detect", { detected_on: "2027-10-07", large_servicer: true, source: "facility.commitment.changed", description: "advance line commitment cut from $40M to $20M" });
  assert.deepEqual([mcOut.required, mcOut.variant, mcOut.business_days], [true, "FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD", 5]);
  const mc = lg.timers("FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD"); assert.equal(mc.length, 1); assert.deepEqual([mc[0]!.status, mc[0]!.anchorDate, mc[0]!.dueDate], ["armed", "2027-10-07", "2027-10-15"]);
  assert.equal(mc[0]!.dueDate, materialChangeNotice({ detected_on: D("2027-10-07"), large: true, stress: false }).timer.due);
  assert.deepEqual(lg.rt.escalations.opened.map((e) => [e.kind, e.severity, e.payload.variant]), [["officer", "sev1", "FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD"]]);
  const stress = materialChangeDetected({ detected_on: D("2027-10-07"), large: true, stress: true, source: "msr_valuation", description: "MSR mark −20% in a rate shock" });
  assert.equal(stress.notice.variant, "FNMA_A4101_LARGE_MATERIAL_CHANGE_STRESS_1BD"); assert.equal(stress.notice.timer.due, D("2027-10-08")); assert.equal(stress.event.payload.stress, true);
  assert.throws(() => materialChangeDetected({ detected_on: D("2027-10-07"), large: true, stress: false, source: "x", description: "" }), RangeError);
  const unevidenced = await lg.run("material_change.notify", { detected_on: "2027-10-07", sent_on: "2027-10-12" }); assert.equal(unevidenced.allowed, false); assert.equal(mc[0]!.status, "armed"); assert.equal(lg.ctx.events.ofType("fnma.notified").length, 0);
  const notified = await lg.run("material_change.notify", { detected_on: "2027-10-07", sent_on: "2027-10-12", evidence_document_id: "DOC-MC-2027-10" });
  assert.deepEqual([notified.allowed, notified.timely, notified.due], [true, true, "2027-10-15"]); assert.equal(mc[0]!.status, "satisfied");
  const fn = lg.ctx.events.ofType("fnma.notified"); assert.equal(fn.length, 1); assert.equal(fn[0]!.id, mc[0]!.satisfiedByEventId); assert.deepEqual([fn[0]!.payload.kind, fn[0]!.payload.evidence_document_id], ["eligibility_material_change", "DOC-MC-2027-10"]);
  // A large servicer's decline trigger found by the quarterly compute is itself a material change: the breach compute appends `material_change.detected{large_servicer=true}`.
  const decl = bus18_7("2027-10-07T14:00:00.000Z");
  await decl.run("eligibility.compute", { entity: "partner", period_end: "2027-09-30", computed_on: "2027-10-07", inputs: { ...EXL, total_equity: cents("140000000"), prior_anw: cents("198000000") } });   // ANW $138M vs $198M = −30.3%
  assert.equal((decl.rt.store.get("eligibility_results", "partner:2027-09-30")!.data.decline_flags as { q_over_q_25: boolean }).q_over_q_25, true);
  assert.deepEqual(decl.ctx.events.ofType("material_change.detected").map((e) => [e.payload.large_servicer, e.payload.decline_trigger, e.payload.detected_on]), [[true, "decline_flags.q_over_q_25", "2027-10-07"]]);
  assert.deepEqual([decl.timers("SM_ELIG_BREACH_NOTIFY_1BD")[0]!.dueDate, decl.timers("FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD")[0]!.dueDate], ["2027-10-08", "2027-10-15"]);
  // Escalations and the WebMB portal task; reads.
  const esc = await lg.run("escalations.create", { reason: "certification package ready for CEO/CFO review" }) as { kind: string; ownerRole: string };
  assert.deepEqual([esc.kind, esc.ownerRole], ["officer", "officer"]);
  const portal = await lg.run("human_portal_task.create", { reason: "Form 1002 Q3 2027 WebMB entry", payload: { schedules: ["balance_sheet", "income_statement", "servicing_portfolio", "liquidity_net_worth", "subservicing"], certification_record: "CERT-2027Q3" } }) as { kind: string; ownerRole: string };
  assert.deepEqual([portal.kind, portal.ownerRole], ["human_portal_task", "fnma_portal_operator"]);
  assert.equal((await b.run("eligibility_results.read", {}) as unknown as unknown[]).length, 0); assert.equal((await b.run("upb_positions.read", { where: { entity: "partner" } }) as unknown as unknown[]).length, 2); assert.equal((await b.run("gl_snapshots.read", { id: "supermortgage:2026-09-30" }) as { entity: string }).entity, "supermortgage");
  // Every 18.7 tool refuses an empty input with a typed reason (RangeError / CommandRefused), never a TypeError; the bus slice is exactly what agents.json names (nothing).
  for (const t of ELIGIBILITY_TOOLS_18_7) {
    assert.equal(t.process, "18.7"); assert.equal(t.agent, "qc-audit");
    if (t.kind === "read") continue;
    const actor: Actor = t.humanOnly ? OFFICER : AGENT;
    await assert.rejects(bus18_7("2026-10-01T14:00:00.000Z").run(t.name, {}, actor), (e: unknown) => (e instanceof RangeError || e instanceof CommandRefused) && !/Cannot read|is not a function|is not iterable/.test((e as Error).message), `${t.name} with {}`);
  }
  assert.deepEqual(TOOLS_18_7, []); assert.deepEqual(loadAgentsFile().processes.find((p) => p.process === "18.7")!.tools, []);
  assert.deepEqual(new Set(ELIGIBILITY_TOOLS_18_7.map((t) => t.name)).size, ELIGIBILITY_TOOLS_18_7.length);
});
