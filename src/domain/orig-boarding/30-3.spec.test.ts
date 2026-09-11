// 30.3 Escrow account establishment at origination: RESPA §1024.17 aggregate analysis, initial deposit, initial escrow statement, CD escrow consistency, waivers, HPML escrow, same-servicer refinance escrow transfer
// spec/sections/30-post-purchase-servicing-setup-and-boarding-to-the-subservice/30-3-escrow-account-establishment-at-origination-respa-1024-17-ag.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor, federal } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_30_3 } from "../../app/tools/section30-3.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { postEscrowActivity } from "../escrow/ops-3-7.ts";
import { buildEscrowLines, runInitialAnalysis, approveInitialAnalysis, cdDraftFromAnalysis, checkCdConsistency, freezeAnalysis, renderInitialStatement, deliverStatementAtSettlement, mailStatementFallback, dueDateProjectionDeposit, overrideLineEstimate, establishEscrowAccount, hpmlMinCancelDate, evaluateOriginationWaiver, recordOriginationWaiver,
  recordCreditAgreement, postCreditTransfer, priorBalanceAfterFinalDisbursements, noAgreementRefund, closingEscrowDepositLines, queueEscrowSetupAtPurchase, biweeklyProjection, firstYearActualBalances, statementMonthlyPayment, money, cushionParameter, ESCROW_AGENT, CUSTODIAL_TI_PREPURCHASE, PARTNER_WAIVER_POLICY_DEFAULT,
  type ParcelRecord, type PolicyRecord, type MiRecord, type OriginationWaiverRequest, type InitialAnalysis30 } from "./ops-30-3.ts";

// ---- the refinance fixture (Phoenix, AZ; consummation Fri Nov 6, 2026; disbursement Thu Nov 12; first payment Fri Jan 1, 2027) ----
const APP = "APP-REFI-1"; const LOAN = "L-REFI-1"; const OLD_LOAN = "SM-0007";
const AGENT: Actor = ESCROW_AGENT; const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const FIRST = D("2027-01-01"), SETTLE = D("2026-11-06"), FUNDED = D("2026-11-12"), ANALYSIS_ON = D("2026-11-04");
const PI = 340_262n;   // P&I $3,402.62 ($560,000 at 6.125%, 30 years)
/** A.R.S. §42-18052: halves due Oct 1 / Mar 1, delinquent after Nov 1 / May 1; the 2026 first half was paid Oct 2026 by the prior servicer. */
const parcel = (): ParcelRecord => ({ apn: "APN-123-45-678", state: "AZ", county: "Maricopa", annual_cents: 640_000n, basis: "known_bill", installments: [
  { tax_year: 2026, installment_no: 1, amount_cents: 320_000n, due_on: D("2026-10-01"), penalty_on: D("2026-11-01"), paid: true },
  { tax_year: 2026, installment_no: 2, amount_cents: 320_000n, due_on: D("2027-03-01"), penalty_on: D("2027-05-01") },
  { tax_year: 2027, installment_no: 1, amount_cents: 320_000n, due_on: D("2027-10-01"), penalty_on: D("2027-11-01") },
  { tax_year: 2027, installment_no: 2, amount_cents: 320_000n, due_on: D("2028-03-01"), penalty_on: D("2028-05-01") }] });
/** Hazard $1,850/yr paid 12 months at closing (policy Nov 6, 2026 – Nov 6, 2027); the insurer invoices the renewal ~30 days before expiry. */
const hazard = (): PolicyRecord => ({ policy_number: "HO-7781", kind: "hazard", first_year_premium_cents: 185_000n, premium_paid_through: D("2027-11-06"), renewal_invoice_due_on: D("2027-10-07"), required_by_creditor: true });
const lines = () => buildEscrowLines({ first_payment_date: FIRST, parcel: parcel(), policies: [hazard()] });
function store(now = "2026-11-04T15:00:00.000Z", processes: readonly string[] = []) {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock, { applicationId: APP });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: [...processes] });
  return { clock, events, timers };
}
const analysis = (events: MemoryEventStore, extra: Partial<Parameters<typeof runInitialAnalysis>[1]> = {}): InitialAnalysis30 =>
  runInitialAnalysis(events, { application_id: APP, analysis_id: "EA-REFI-1", lines: lines(), first_payment_date: FIRST, settlement_date: SETTLE, disbursement_date: FUNDED, cushion: { policy_months: 2 }, as_of: ANALYSIS_ON, pi_cents: PI, ...extra });
const refiWaiver = (extra: Partial<OriginationWaiverRequest> = {}): OriginationWaiverRequest => ({ application_id: APP, waiver_id: "W-REFI-1", requested_on: D("2026-10-07"), scope: "full", waived_line_types: ["tax_county", "hazard"], channel: "portal", is_hpml: false, consummation_date: SETTLE, state: "AZ", transaction_type: "refinance", taxes_financed_in_loan: false,
  mi_premium_plan: "none", ltv_pct: "70.000", reserves_months_of_ti: 9, mortgage_lates_30_in_12m: 0, dti_pct: "38.000", lump_sum_ability_documented: true, sfha: false, loan_amount_cents: 56_000_000n, annual_ti_cents: 825_000n, ...extra });
/** The 30.3 tools on the bus over the overridden timer registry (30.3 rows only): the agent's path, refusals as CommandRefused. */
function harness(nowIso = "2026-11-04T15:00:00.000Z", processes: readonly string[] = ["30.3"]) {
  const { clock, events, timers } = store(nowIso, processes); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: APP, applicationId: APP, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_30_3); const bus = new CommandBus(agents);
  const run = async (input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("30.3", "buildEscrowLines"))!, actor, input, uow)).output as Record<string, unknown>;
  const refusal = async (input: ToolInput, actor: Actor = AGENT): Promise<CommandRefused | null> => { try { await run(input, actor); return null; } catch (e) { if (e instanceof CommandRefused) return e; throw e; } };
  const build = () => run({ op: "build", first_payment_date: FIRST, parcel: parcel(), policies: [hazard()] });
  return { events, timers, rt, uow, run, refusal, build, decisions };
}
const payload = (e: { payload: unknown }): Record<string, unknown> => e.payload as Record<string, unknown>;

test("30.3-T1: Given the fixture lines (taxes $3,200 × 2 with deadlines May 1/Nov 1, hazard renewal $1,850 in Nov; first payment Jan 1, 2027), when the initial analysis runs with a 2-month cushion, then base = $687.50, cushion = $1,375.00, low point −$687.50 (Nov), `target_at_start` = $2,062.50, lowest target = $1,375.00, and the 12-row trial balance matches the table above to the cent.", () => {
  const { events, timers } = store("2026-11-04T15:00:00.000Z", ["30.3"]);
  const a = analysis(events);
  assert.equal(a.analysis_type, "initial"); assert.equal(a.source, "origination"); assert.equal(a.computation_year_start, "2027-01-01"); assert.equal(a.computation_year_end, "2027-12-31");
  assert.equal(a.annual_disbursements_cents, 825_000n);                 // $6,400.00 taxes + $1,850.00 hazard
  assert.equal(a.base_payment_cents, 68_750n);                          // $687.50 = round_half_up(825,000 / 12)
  assert.equal(a.cushion_months, 2); assert.equal(a.cushion_cents, 137_500n);   // $1,375.00 = floor(825,000 / 6)
  assert.equal(a.low_point_cents, -68_750n); assert.equal(a.low_point_month, "2027-11-01");
  assert.equal(a.required_start_balance_cents, 68_750n); assert.equal(a.target_at_start_cents, 206_250n);   // $2,062.50 initial deposit at closing
  assert.equal(a.lowest_target_cents, 137_500n); assert.ok(a.cap_check_passed && a.preaccrual_check_passed); assert.equal(a.status, "computed");
  // The spec's table: [month, disbursement, Step 1 balance, Step 2 zeroed, Step 3 target] in cents.
  const table: [string, bigint, bigint, bigint, bigint][] = [["Jan", 0n, 68_750n, 137_500n, 275_000n], ["Feb", 0n, 137_500n, 206_250n, 343_750n], ["Mar", 0n, 206_250n, 275_000n, 412_500n], ["Apr", 0n, 275_000n, 343_750n, 481_250n], ["May", 320_000n, 23_750n, 92_500n, 230_000n], ["Jun", 0n, 92_500n, 161_250n, 298_750n],
    ["Jul", 0n, 161_250n, 230_000n, 367_500n], ["Aug", 0n, 230_000n, 298_750n, 436_250n], ["Sep", 0n, 298_750n, 367_500n, 505_000n], ["Oct", 0n, 367_500n, 436_250n, 573_750n], ["Nov", 505_000n, -68_750n, 0n, 137_500n], ["Dec", 0n, 0n, 68_750n, 206_250n]];
  assert.equal(a.trial_balance.length, 12);
  for (const [k, row] of table.entries()) { const r = a.trial_balance[k]!; assert.equal(r.month, row[0]); assert.equal(r.deposit_cents, 68_750n); assert.equal(r.disbursement_cents, row[1], row[0]); assert.equal(r.step1_cents, row[2], row[0]); assert.equal(r.zeroed_cents, row[3], row[0]); assert.equal(r.target_cents, row[4], row[0]); }
  assert.deepEqual(a.trial_balance[10]!.disbursements.map((d) => [d.line_type, d.amount_cents]), [["tax_county", 320_000n], ["hazard", 185_000n]]);
  // 3.4's facts and the approval that closes REGX_1024_17C2_INITIAL_ANALYSIS_GATE (armed by 25.2's disclosure.cd.prepared).
  assert.equal(payload(a.events.validated).cap_check_passed, true); assert.equal(a.events.cap_failed, null);
  events.append({ type: "disclosure.cd.prepared", actor: AGENT, payload: { version: "CD-1", application_id: APP } });
  const gate = timers.byCode("REGX_1024_17C2_INITIAL_ANALYSIS_GATE").at(-1)!; assert.equal(gate.status, "armed");
  assert.equal(evaluateGate("30.3.initialAnalysisApproved", { approved: false }).open, false);
  approveInitialAnalysis(events, a, { approved_on: ANALYSIS_ON });
  assert.equal(a.status, "approved"); assert.equal(gate.status, "satisfied");
});

test("30.3-T2: Given the same analysis, when CD figures are computed, then (g)(3) shows taxes 4 × $533.33 = $2,133.32, insurance 4 × $154.17 = $616.68, aggregate adjustment −$687.50, total $2,062.50; (l)(7) shows $8,250.00 / $0.00 / $2,062.50 / $687.50; a CD draft with (g)(3) total $2,062.51 fails `REGZ_1026_38L7_CD_ESCROW_CONSISTENCY_GATE`.", () => {
  const { events, timers } = store("2026-11-04T15:00:00.000Z", ["30.3"]);
  const a = analysis(events); approveInitialAnalysis(events, a, { approved_on: ANALYSIS_ON });
  const f = a.cd_figures;
  const taxes = f.g3.lines.find((l) => l.item === "Property taxes")!, ins = f.g3.lines.find((l) => l.item === "Homeowner's insurance")!;
  assert.equal(taxes.per_month_cents, 53_333n); assert.equal(taxes.months, 4); assert.equal(taxes.amount_cents, 213_332n);   // 4 deposits before May 1 cover $2,133.32 of $3,200 → 2 + 2 months
  assert.equal(taxes.deposits_before_first_disbursement_cents, 213_332n);
  assert.equal(ins.per_month_cents, 15_417n); assert.equal(ins.months, 4); assert.equal(ins.amount_cents, 61_668n);        // 10 deposits cover $1,541.70 of $1,850 → 2 + 2 months
  assert.equal(ins.deposits_before_first_disbursement_cents, 154_170n);
  assert.equal(f.g3.aggregate_adjustment_cents, -68_750n); assert.equal(f.g3.total_cents, 206_250n);
  assert.equal(taxes.amount_cents + ins.amount_cents + f.g3.aggregate_adjustment_cents, f.g3.total_cents);   // rule 10: the adjustment absorbs rounding to the cent
  assert.deepEqual([f.l7.escrowed_property_costs_year1_cents, f.l7.non_escrowed_property_costs_year1_cents, f.l7.initial_escrow_payment_cents, f.l7.monthly_escrow_payment_cents], [825_000n, 0n, 206_250n, 68_750n]);
  assert.equal(f.projected_payments_escrow_cents, 68_750n);
  // 25.2 prepares the CD draft from the analysis → the gate arms and passes; a draft off by one cent fails it.
  const cd = events.append({ type: "disclosure.cd.prepared", actor: AGENT, payload: { version: "CD-1", application_id: APP } });
  const gate = timers.byCode("REGZ_1026_38L7_CD_ESCROW_CONSISTENCY_GATE").at(-1)!; assert.equal(gate.status, "armed");
  const bad = checkCdConsistency(events, a, { ...cdDraftFromAnalysis(a, "CD-1"), g3_total_cents: 206_251n }, { cd_prepared_event_id: cd.id });
  assert.equal(bad.passed, false); assert.equal(bad.event.type, "escrow.cd_consistency.failed"); assert.match(bad.mismatches[0]!, /\(g\)\(3\) total: CD 206251 ≠ analysis 206250/);
  assert.equal(evaluateGate("30.3.cdEscrowConsistency", { consistent: false, mismatches: bad.mismatches }).open, false); assert.equal(gate.status, "armed");
  const good = checkCdConsistency(events, a, cdDraftFromAnalysis(a, "CD-2"), { cd_prepared_event_id: cd.id });
  assert.equal(good.passed, true); assert.equal(good.event.type, "escrow.cd_consistency.passed"); assert.equal(gate.status, "satisfied"); assert.equal(a.status, "disclosed_on_cd");
});

test("30.3-T3: Given consummation Fri Nov 6, 2026 with the statement in the package, then `escrow.statement.sent{initial}` is dated Nov 6, `initial_statement_delivery_basis='at_settlement'`, and no `REGX_1024_17G_INITIAL_STMT_45` instance remains open; given the package omitted it, then the 3.1 timer is due Mon Dec 21, 2026 and the statement is mailed by then.", () => {
  const inPackage = store("2026-11-06T17:00:00.000Z", ["3.1", "30.3"]);
  const a = analysis(inPackage.events); approveInitialAnalysis(inPackage.events, a, { approved_on: ANALYSIS_ON }); freezeAnalysis(inPackage.events, a, { cd_version_id: "CD-3", frozen_at: "2026-11-05T14:00:00.000Z" });
  inPackage.events.append({ type: "closing.scheduled", actor: AGENT, payload: { closing_id: "CL-1", scheduled_at: "2026-11-06T17:00:00.000Z", closing_type: "dry", application_id: APP } });   // 26.2
  const stmt = renderInitialStatement(inPackage.events, a, { pi_cents: PI, account_last4: "4417", servicer_phone: "(800) 555-0100", partner_name: "Partner Bank", rendered_on: ANALYSIS_ON });
  assert.equal(stmt.checklist.passed, true);
  assert.deepEqual([payload(stmt.event).scheduled_consummation, payload(stmt.event).in_closing_package, payload(stmt.event).latest_approval_for_package_on], ["2026-11-06", true, "2026-11-05"]);   // 25.4: approved ≥ 1 creditor BD before consummation assert.equal(stmt.cushion_text, "$1,375.00 selected by the servicer"); assert.equal(stmt.servicer_block, "Supermortgage, servicer for Partner Bank");
  assert.deepEqual(stmt.computation_year, { start: "2027-01-01", end: "2027-12-31" }); assert.match(stmt.rendered.text, /\$4,090\.12, of which \$3,402\.62 .* \$687\.50 will go into your escrow account/);
  const d = deliverStatementAtSettlement(inPackage.events, { application_id: APP, settlement_date: SETTLE, in_package: true, rendered_event_id: stmt.event.id });
  assert.equal(d.delivery_basis, "at_settlement"); assert.equal(d.initial_statement_delivered_at, "2026-11-06"); assert.equal(d.sent!.type, "escrow.statement.sent");
  assert.deepEqual([payload(d.sent!).statement_type, payload(d.sent!).sent_on, payload(d.sent!).channel], ["initial", "2026-11-06", "closing_package"]);
  const inst = inPackage.timers.byCode("REGX_1024_17G_INITIAL_STMT_45"); assert.equal(inst.length, 1); assert.equal(inst[0]!.status, "satisfied");   // satisfied on day 0
  assert.equal(inPackage.timers.open().filter((t) => t.code === "REGX_1024_17G_INITIAL_STMT_45").length, 0);
  // Package omitted the statement: 3.1's 45-day row runs from settlement (Reg X §1024.2(b): the signing date, not the Nov 12 disbursement).
  const omitted = store("2026-11-06T17:00:00.000Z", ["3.1", "30.3"]);
  const o = deliverStatementAtSettlement(omitted.events, { application_id: APP, settlement_date: SETTLE, in_package: false });
  assert.equal(o.delivery_basis, "within_45_days"); assert.equal(o.due_on, "2026-12-21"); assert.equal(o.sent, null);
  const open = omitted.timers.byCode("REGX_1024_17G_INITIAL_STMT_45").at(-1)!; assert.equal(open.status, "armed"); assert.equal(open.dueDate, "2026-12-21");
  const mailed = mailStatementFallback(omitted.events, { application_id: APP, loan_id: LOAN, settlement_date: SETTLE, mailed_on: D("2026-12-18") });
  assert.deepEqual([mailed.delivery_basis, mailed.on_time, mailed.due_on], ["within_45_days", true, "2026-12-21"]); assert.equal(open.status, "satisfied");
});

test("30.3-T4: Given the disbursement dates were entered as Oct 1/Mar 1 (due dates) instead of the Nov 1/May 1 deadlines, then the engine's projection uses the `scheduled_pay_date` (deadline-based) and the decision record shows the (c)(2)/(k) basis; the resulting deposit is $2,062.50, not the $2,750.00 an earlier-disbursement projection would produce.", () => {
  const { events } = store();
  const ls = lines(); const tax = ls.find((l) => l.line_type === "tax_county")!;
  assert.deepEqual(tax.bills.map((b) => [b.due_on, b.penalty_on, b.scheduled_pay_date]).slice(0, 2), [["2027-03-01", "2027-05-01", "2027-05-01"], ["2027-10-01", "2027-11-01", "2027-11-01"]]);
  const a = analysis(events);
  assert.deepEqual(a.projection.items.map((it) => [it.line_type, it.disburse_on]).sort(), [["hazard", "2027-11-06"], ["tax_county", "2027-05-01"], ["tax_county", "2027-11-01"]]);
  assert.equal(a.disbursement_date_basis, "scheduled_pay_date (§1024.17(c)(2)/(k): on or before the penalty-avoidance deadline)");
  const rec = a.decision_record.lines as { type: string; disbursement_dates: string[]; disbursement_date_basis: string }[];
  assert.match(rec.find((l) => l.type === "tax_county")!.disbursement_date_basis, /§1024\.17\(c\)\(2\)\/\(k\).*Nov 1 \/ May 1, not the Oct 1 \/ Mar 1 due dates/);
  assert.equal(a.target_at_start_cents, 206_250n);
  // The data-entry error replayed on the bills' due dates: taxes Mar 1 / Oct 1 and the renewal on its Oct 7 invoice date put $8,250 of disbursements before 11 deposits → low point −$1,375.00 → deposit $2,750.00.
  const wrong = dueDateProjectionDeposit(ls, FIRST);
  assert.deepEqual(wrong.projection.items.map((it) => it.disburse_on).sort(), ["2027-03-01", "2027-10-01", "2027-10-07"]);
  assert.equal(wrong.low_point_cents, -137_500n); assert.equal(wrong.target_at_start_cents, 275_000n);
});

test("30.3-T5: Given `is_hpml=true`, when a waiver is requested, then it is denied with `HPML_ESCROW_REQUIRED`, the account is established at funding, and `hpml_escrow_min_cancel_date` = 2031-11-06.", () => {
  const { events, timers, clock } = store("2026-10-07T16:00:00.000Z", ["30.3"]);
  const w = recordOriginationWaiver(events, refiWaiver({ is_hpml: true }), { decided_on: D("2026-10-07"), lines: lines() });
  assert.equal(w.decision.decision, "denied"); assert.deepEqual(w.decision.reasons, ["HPML_ESCROW_REQUIRED"]); assert.equal(w.le_revision, null);
  assert.equal(payload(w.decided).le_unchanged, true);
  const a = analysis(events, { hpml: true }); const approved = approveInitialAnalysis(events, a, { approved_on: ANALYSIS_ON }); assert.equal(payload(approved.event).hpml, true);   // 23.4's REGZ_1026_35B1 satisfier
  freezeAnalysis(events, a, { cd_version_id: "CD-3", frozen_at: "2026-11-05T14:00:00.000Z" });
  events.append({ type: "closing.consummated", actor: AGENT, payload: { consummation_at: "2026-11-06", is_hpml: true, application_id: APP } });
  clock.set("2026-11-12T18:00:00.000Z");
  events.append({ type: "loan.funded", actor: AGENT, payload: { disbursement_date: "2026-11-12", application_id: APP } });
  const refresh = timers.byCode("SM_ESCROW_REFRESH_AT_FUNDING_T0").at(-1)!; assert.equal(refresh.status, "armed"); assert.equal(refresh.anchorDate, "2026-11-12");
  const est = establishEscrowAccount(events, { application_id: APP, loan_id: LOAN, analysis: a, funded_on: FUNDED, consummation_date: SETTLE, is_hpml: true, interest_rule_code: null });
  assert.equal(est.account.status, "active"); assert.equal(est.account.establishment_reason, "origination"); assert.equal(est.account.established_at, "2026-11-12");
  assert.equal(est.account.hpml_escrow_min_cancel_date, "2031-11-06"); assert.equal(hpmlMinCancelDate(SETTLE), "2031-11-06");
  assert.equal(est.account.custodial_account_id, CUSTODIAL_TI_PREPURCHASE); assert.equal(est.account.initial_deposit_cents, 206_250n); assert.equal(est.account.annual_analysis_lead_on, "2027-11-16");
  assert.deepEqual([est.established.type, payload(est.established).reason, payload(est.established).hpml_escrow_min_cancel_date], ["escrow.account.established", "origination", "2031-11-06"]);
  assert.equal(payload(est.refreshed).result, "frozen_confirmed"); assert.equal(refresh.status, "satisfied");
  assert.throws(() => establishEscrowAccount(events, { application_id: APP, loan_id: LOAN, analysis: { ...a, status: "frozen" }, funded_on: FUNDED, consummation_date: SETTLE, is_hpml: true, waived: true }), /HPML loan cannot be established waived/);
});

test("30.3-T6: Given the purchase fixture with BPMI monthly $130.47 and LTV 90%, when a waiver is requested, then denied with `MI_MONTHLY` and `PARTNER_POLICY_LTV`, the decision worksheet is stored, and the LE is unchanged.", async () => {
  const h = harness("2026-10-20T16:00:00.000Z");
  const mi: MiRecord = { certificate_id: "MI-CERT-9", premium_plan: "bpmi_monthly", monthly_premium_cents: 13_047n, scheduled_78_date: D("2035-12-01") };
  const purchaseLines = buildEscrowLines({ first_payment_date: FIRST, parcel: { ...parcel(), state: "OH", county: "Franklin" }, policies: [hazard()], mi });
  assert.equal(purchaseLines.find((l) => l.line_type === "mi_borrower_paid")!.bills[0]!.amount_cents, 13_047n);
  const out = await h.run({ op: "evaluate_waiver", waiver_id: "W-PURCH-1", requested_on: "2026-10-20", scope: "full", waived_line_types: ["tax_county", "hazard", "mi_borrower_paid"], transaction_type: "purchase", ltv_pct: "90.000", dti_pct: "40.000", reserves_months_of_ti: 3, mortgage_lates_30_in_12m: 0, lump_sum_ability_documented: true,
    mi_premium_plan: "bpmi_monthly", mi_monthly_premium_cents: 13_047n, state: "OH", loan_amount_cents: 41_200_000n, annual_ti_cents: 825_000n + 156_564n, lines: purchaseLines });
  assert.equal(out.decision, "denied"); assert.deepEqual(out.reasons, ["PARTNER_POLICY_LTV", "MI_MONTHLY"]); assert.deepEqual(out.lines_kept, ["mi_borrower_paid"]);
  assert.equal(out.le_unchanged, true); assert.equal(out.le_revision, null);
  const doc = h.rt.store.get("documents", String(out.worksheet_document_id))!.data; assert.equal(doc.kind, "escrow_waiver_decision_worksheet");
  const ws = doc.worksheet as { steps: { partner_policy: { failures: string[]; max_ltv_pct: string }; fannie_mae: { bpmi_monthly_non_waivable: boolean } }; policy_version: string };
  assert.deepEqual(ws.steps.partner_policy.failures, ["PARTNER_POLICY_LTV"]); assert.equal(ws.steps.partner_policy.max_ltv_pct, "80.000"); assert.equal(ws.steps.fannie_mae.bpmi_monthly_non_waivable, true); assert.equal(ws.policy_version, PARTNER_WAIVER_POLICY_DEFAULT.version);
  assert.equal(h.rt.store.get("escrow_waivers", "W-PURCH-1")!.data.basis_document_id, out.worksheet_document_id);
  const decided = h.events.ofType("escrow.waiver.decided").at(-1)!; assert.equal(payload(decided).decision, "denied"); assert.equal(payload(decided).le_revision, null);
  assert.equal(payload(h.events.ofType("escrow.waiver.evaluating").at(-1)!).borrower_paid_mi_monthly, true);   // 3.8's FNMA_B101_MI_MONTHLY_ESCROW_GATE fact
  assert.equal(h.events.ofType("disclosure.le.revision.requested").length, 0);
  // The agent may not solicit the waiver (B-1-01) and cannot approve outside the partner's policy.
  const sol = await h.refusal({ op: "evaluate_waiver", waiver_id: "W-PURCH-2", requested_on: "2026-10-20", transaction_type: "purchase", ltv_pct: "90.000", dti_pct: "40.000", loan_amount_cents: 1n, annual_ti_cents: 1n, script: "Would you like to waive escrow on this loan?" }); assert.equal(sol?.code, "NO_WAIVER_SOLICITATION");
  const exc = await h.refusal({ op: "evaluate_waiver", waiver_id: "W-PURCH-3", requested_on: "2026-10-20", transaction_type: "purchase", ltv_pct: "90.000", dti_pct: "40.000", loan_amount_cents: 1n, annual_ti_cents: 1n, officer_exception: { rationale: "relationship" } }); assert.equal(exc?.code, "POLICY_EXCEPTION_NEEDS_OFFICER");
});

test("30.3-T7: Given the refinance borrower (LTV 70%, reserves 9 months, no lates) requests a waiver Oct 7, 2026, then approved by Oct 12 (3 creditor BDs), a revised LE issues under 21.5 with \"Escrow Waiver Fee\" $0.00 (default), and `escrow_lines` are retained inactive for 3.7 monitoring.", () => {
  const { events, timers } = store("2026-10-08T16:00:00.000Z", ["30.3"]);
  const d = evaluateOriginationWaiver(refiWaiver());
  assert.equal(d.decision, "approved"); assert.deepEqual(d.reasons, []); assert.equal(d.pricing_adjustment_bps, 0);
  // Spec: "approved by Oct 12 (3 creditor BDs)". Mon Oct 12, 2026 is Columbus Day, a federal holiday the creditor calendar observes (addendum §4), so the third creditor business day after Wed Oct 7 is Tue Oct 13.
  assert.equal(d.decision_due_on, addBusinessDays(D("2026-10-07"), 3, creditor)); assert.equal(d.decision_due_on, "2026-10-13");
  const w = recordOriginationWaiver(events, refiWaiver(), { decided_on: D("2026-10-08"), lines: lines() });
  const sla = timers.byCode("SM_ESCROW_WAIVER_DECISION_ORIG_3BD").at(-1)!; assert.equal(sla.anchorDate, "2026-10-07"); assert.equal(sla.dueDate, "2026-10-13"); assert.equal(sla.status, "satisfied");
  assert.equal(timers.byCode("FNMA_B2_1_5_04_REFI_TAX_FINANCING_GATE").at(-1)!.status, "satisfied");   // not a tax-financing refinance: the gate opens and closes on the decision
  assert.deepEqual(w.le_revision, { changed_circumstance: "borrower_request", process: "21.5", escrow_waiver_fee_cents: 0n, escrowed: false, property_costs_year1_cents: 825_000n });
  assert.deepEqual(payload(w.decided).le_revision, { changed_circumstance: "borrower_request", process: "21.5", escrow_waiver_fee_cents: "0", escrowed: false, property_costs_year1_cents: "825000", line_label: "Escrow Waiver Fee" });
  assert.equal(w.lines_after.length, 2); assert.ok(w.lines_after.every((l) => l.active === false && l.escrowed));   // retained inactive for 3.7 monitoring
  // A refinance financing its taxes cannot waive (B2-1.5-04); the gate refuses and the engine denies.
  const refi = recordOriginationWaiver(events, refiWaiver({ waiver_id: "W-REFI-2", taxes_financed_in_loan: true }), { decided_on: D("2026-10-08"), lines: lines() });
  assert.deepEqual(refi.decision.reasons, ["REFI_FINANCING_TAXES"]); assert.equal(evaluateGate("30.3.refiTaxFinancing", { transaction_type: "refinance", taxes_financed_in_loan: true }).open, false);
});

test("30.3-T8: Given a same-servicer refinance with a recorded agreement dated Oct 6 and a prior balance of $1,610.40 after the Nov 10 hazard disbursement, when the prior loan pays off Nov 12, then `escrow_credit_transfers.credited_cents = 161040`, the new loan's `escrow` liability = 206,250 with the borrower's closing escrow funds = $452.10, and no refund check is issued.", () => {
  const { events, timers } = store("2026-11-12T18:00:00.000Z", ["30.3", "3.5"]); const ledger = new MemoryLedger();
  const consent = recordCreditAgreement(events, { old_loan_id: OLD_LOAN, new_application_id: APP, borrower_id: "B-A", evidence: { kind: "recorded_call", recorded_call_id: "call-2026-10-06-itp", scripted_agreement_language_used: true }, captured_on: D("2026-10-06"), settlement_date: SETTLE });
  assert.equal(consent.kind, "escrow_credit_to_new_loan"); assert.equal(consent.captured_at, "2026-10-06");
  assert.throws(() => recordCreditAgreement(events, { old_loan_id: OLD_LOAN, new_application_id: APP, borrower_id: "B-A", evidence: { kind: "recorded_call", recorded_call_id: "call-x", scripted_agreement_language_used: false }, captured_on: D("2026-10-06"), settlement_date: SETTLE }), /recorded and the scripted agreement language/);
  const B = priorBalanceAfterFinalDisbursements(201_040n, [{ amount_cents: 40_000n, paid_on: D("2026-11-10") }], FUNDED);   // $2,010.40 − $400.00 hazard paid Nov 10 = $1,610.40
  assert.equal(B, 161_040n);
  events.append({ type: "loan.paid_in_full", loanId: OLD_LOAN, actor: AGENT, payload: { payoff_date: "2026-11-12", settlement_id: "ps-0007", escrowed: true } });   // 16.2's payload on an escrowed loan arms 3.5's 20-BD refund row
  events.append({ type: "payoff.funds.received", loanId: OLD_LOAN, actor: AGENT, payload: { amount: "55000000", method: "wire", source_party: "title", bank_ref: "W-1", same_servicer_new_application_id: APP } });
  const gate = timers.byCode("REGX_1024_34B_SAME_SERVICER_CREDIT_AGREEMENT_GATE").at(-1)!; assert.equal(gate.status, "armed");
  const refund20 = timers.byCode("REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD").at(-1)!; assert.equal(refund20.status, "armed"); assert.equal(refund20.dueDate, "2026-12-11");
  const t = postCreditTransfer(events, ledger, { old_loan_id: OLD_LOAN, new_loan_id: LOAN, new_application_id: APP, consent, payoff_date: FUNDED, settlement_date: SETTLE, old_balance_after_final_disbursements_cents: B, target_at_start_cents: 206_250n });
  assert.equal(t.credited_cents, 161_040n); assert.equal(t.refunded_remainder_cents, 0n); assert.equal(t.borrower_closing_escrow_funds_cents, 45_210n); assert.equal(t.refund_check_issued, false); assert.equal(t.posted_at, "2026-11-06");
  assert.equal(ledger.balance({ scope: "loan", loanId: OLD_LOAN, account: "escrow" }), 161_040n);   // Dr old-loan escrow
  ledger.post({ effectiveDate: FUNDED, description: "30.2 opening entry: closing escrow funds", lines: closingEscrowDepositLines(LOAN, t.borrower_closing_escrow_funds_cents) });
  assert.equal(ledger.balance({ scope: "loan", loanId: LOAN, account: "escrow" }), -206_250n);      // Cr new-loan escrow liability 206,250 = credit 161,040 + closing funds 45,210
  assert.equal(ledger.balance({ scope: "custodial", custodialAccountId: CUSTODIAL_TI_PREPURCHASE, account: "custodial_ti_cash" }), 206_250n);
  assert.equal(ledger.balance({ scope: "custodial", custodialAccountId: "TI-1014", account: "custodial_ti_cash" }), -161_040n);   // Fannie Mae T&I: funds due borrower withdrawn (F-1-03)
  assert.equal(t.events.posted.type, "escrow.credit_to_new_loan.posted"); assert.equal(t.events.posted.loanId, OLD_LOAN); assert.equal(payload(t.events.disbursement).method, "credit_to_new_loan");
  assert.equal(events.ofType("disbursement.issued").filter((e) => payload(e).method === "check").length, 0);
  assert.equal(gate.status, "satisfied"); assert.equal(refund20.status, "satisfied");   // 3.5's 20-day row is closed by the credit, not a check
  assert.equal(money(t.borrower_closing_escrow_funds_cents), "$452.10");
});

test("30.3-T9: Given no agreement, then 3.5's refund of $1,610.40 is due Fri Dec 11, 2026 and the closing collects $2,062.50.", () => {
  const { events } = store("2026-11-12T18:00:00.000Z");
  const r = noAgreementRefund({ payoff_date: FUNDED, old_balance_after_final_disbursements_cents: 161_040n, target_at_start_cents: 206_250n });
  assert.equal(r.refund_cents, 161_040n); assert.equal(r.due_on, "2026-12-11"); assert.equal(r.due_on, addBusinessDays(FUNDED, 20, federal));   // Thanksgiving Nov 26 excluded
  assert.equal(r.closing_collects_cents, 206_250n); assert.equal(r.timer, "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD"); assert.equal(r.credit_posted, false);
  assert.equal(evaluateGate("30.3.creditAgreementPresent", { consent_present: false }).open, false);
  assert.throws(() => postCreditTransfer(events, new MemoryLedger(), { old_loan_id: OLD_LOAN, new_loan_id: LOAN, new_application_id: APP, consent: null, payoff_date: FUNDED, settlement_date: SETTLE, old_balance_after_final_disbursements_cents: 161_040n, target_at_start_cents: 206_250n }), /REGX_1024_34B_SAME_SERVICER_CREDIT_AGREEMENT_GATE/);
  assert.equal(events.ofType("escrow.credit_to_new_loan.posted").length, 0);
});

test("30.3-T10: Given the agent proposes a hazard-line override to $1,700 without a document, then the command is refused; with a renewal quote document, the override is accepted and a superseding analysis is created with the new figures.", async () => {
  const h = harness();
  await h.build();
  const first = await h.run({ op: "run_analysis", analysis_id: "EA-REFI-1", first_payment_date: FIRST, settlement_date: SETTLE, disbursement_date: FUNDED, pi_cents: PI });
  assert.equal(first.target_at_start_cents, 206_250n);
  const refused = await h.refusal({ op: "override_line", analysis_id: "EA-REFI-1", line_type: "hazard", new_annual_cents: 170_000n, reason: "renewal quote lower" });
  assert.equal(refused?.code, "LINE_OVERRIDE_NEEDS_DOCUMENT"); assert.match(refused!.message, /only with a cited document/);
  assert.throws(() => overrideLineEstimate(lines(), { line_type: "hazard", new_annual_cents: 170_000n, reason: "x" }), RangeError);
  const out = await h.run({ op: "override_line", analysis_id: "EA-REFI-1", line_type: "hazard", new_annual_cents: 170_000n, reason: "renewal quote", evidence_document_id: "doc:renewal-quote-HO-7781", new_analysis_id: "EA-REFI-2" });
  assert.equal(out.superseded, "EA-REFI-1"); assert.equal(out.analysis_id, "EA-REFI-2");
  assert.equal(out.base_payment_cents, 67_500n); assert.equal(out.cushion_cents, 135_000n); assert.equal(out.target_at_start_cents, 202_500n);   // annual 810,000: base $675.00, cushion $1,350.00, deposit $2,025.00
  assert.equal(h.rt.store.get("escrow_analyses", "EA-REFI-1")!.data.status, "superseded");
  const next = h.rt.store.get("escrow_analyses", "EA-REFI-2")!.data as unknown as InitialAnalysis30; assert.equal(next.supersedes_analysis_id, "EA-REFI-1");
  assert.deepEqual(next.lines.find((l) => l.line_type === "hazard")!.evidence_document_id, "doc:renewal-quote-HO-7781"); assert.equal(next.lines.find((l) => l.line_type === "hazard")!.estimate_basis, "quote");
  const sup = h.events.ofType("escrow.initial_analysis.superseded").at(-1)!; assert.deepEqual([payload(sup).analysis_id, payload(sup).superseded_by], ["EA-REFI-1", "EA-REFI-2"]);
  assert.equal(h.decisions.at(-1)!.action, "escrow.origination.override_line");
});

test("30.3-T11: Given a cushion parameter of 2.5 months, then `REGX_1024_17C5_CUSHION_CAP_GATE` (3.4) blocks approval; given an instrument cushion of 1 month, then cushion = floor(825,000/12) = $687.50 and the deposit = $1,375.00.", async () => {
  const h = harness("2026-11-04T15:00:00.000Z", ["30.3", "3.4"]);
  await h.build();
  const out = await h.run({ op: "run_analysis", analysis_id: "EA-CUSH-25", first_payment_date: FIRST, settlement_date: SETTLE, cushion: { policy_months: 2.5 } });
  assert.equal(out.cap_check_passed, false); assert.ok((out.anomalies as string[]).includes("cushion_cap_failed")); assert.equal(out.status, "anomaly_review");
  assert.equal(cushionParameter(825_000n, { policy_months: 2.5 }).requested_cents, 171_875n);   // 2.5 months = $1,718.75 > the 1/6 cap $1,375.00
  const failed = h.events.ofType("escrow.cushion.cap_failed").at(-1)!; assert.equal(payload(failed).reason, "cushion_cap_failed");
  const refused = await h.refusal({ op: "approve_analysis", analysis_id: "EA-CUSH-25", reviewed: true });
  assert.equal(refused?.code, "REGX_1024_17C5_CUSHION_CAP_GATE"); assert.equal(h.events.ofType("escrow.initial_analysis.approved").length, 0);
  // Instrument cushion of 1 month (c)(8): the lower cushion controls.
  const { events } = store();
  const one = analysis(events, { analysis_id: "EA-CUSH-1", cushion: { policy_months: 2, instrument_months: 1 } });
  assert.equal(one.cushion_months, 1); assert.equal(one.cushion_cap_source, "instrument"); assert.equal(one.cushion_cents, 68_750n); assert.equal(one.target_at_start_cents, 137_500n); assert.ok(one.cap_check_passed);
  assert.equal(approveInitialAnalysis(events, one, { approved_on: ANALYSIS_ON }).status, "approved");
});

test("30.3-T12: Given the loan funds Nov 12 and is purchased Nov 19 with the escrow-events flag on, then 30.1's Escrow Setup event reports T&I balance $2,062.50 (sequence 1) and the first deposit event on Dec 30 (payment 1) reports +$687.50, balance $2,750.00 (3.7 balance rule).", () => {
  const clock = new FixedClock("2026-11-19T20:00:00.000Z"); const events = new MemoryEventStore(clock, { loanId: LOAN }); const ledger = new MemoryLedger();
  events.append({ type: "loan.funded", actor: AGENT, payload: { disbursement_date: "2026-11-12", application_id: APP } });
  events.append({ type: "loan.purchased", actor: AGENT, payload: { purchase_date: "2026-11-19", fnma_loan_number: "1234567890" } });
  const off = queueEscrowSetupAtPurchase(events, { loan_id: LOAN, purchase_date: D("2026-11-19"), ti_balance_cents: 206_250n, flag_on: false, now: clock.now() });
  assert.equal(off.queued, false); assert.equal(events.ofType("escrow.setup_event.sent").length, 0);
  const setup = queueEscrowSetupAtPurchase(events, { loan_id: LOAN, purchase_date: D("2026-11-19"), ti_balance_cents: 206_250n, flag_on: true, now: clock.now() });
  assert.equal(setup.queued, true); assert.equal(setup.sequence, 1); assert.equal(setup.balance_cents, 206_250n); assert.equal(setup.deadline_at, "2026-11-20T08:00:00.000Z");   // next Fannie Mae BD 03:00 ET
  const sent = events.ofType("escrow.setup_event.sent").at(-1)!; assert.deepEqual([payload(sent).category, payload(sent).item_type, payload(sent).sequence, payload(sent).balance_cents], ["taxes_insurance", "Set up", 1, "206250"]);
  assert.equal(events.ofType("escrow.setup_event.queued").at(-1)!.loanId, LOAN);
  clock.set("2026-12-30T15:00:00.000Z");
  const dep = postEscrowActivity(events, ledger, { loan_id: LOAN, direction: "deposit", amount_cents: 68_750n, item: "contractual_payment", processed_at: "2026-12-30T15:00:00.000Z", now: clock.now(), contractual_payment_cents: 68_750n, actor: AGENT });
  assert.equal(dep.sequence, 2); assert.equal(dep.amount_cents, 68_750n); assert.equal(dep.balance_cents, 275_000n); assert.equal(dep.processed_on, "2026-12-30");   // 206,250 + 68,750 = 275,000 (3.7 rule 11 balance equation)
  assert.equal(payload(events.ofType("escrow.event.queued").at(-1)!).item_type, "Loan Escrow Payment");
});

test("30.3-T13: Given a biweekly election, then the projection has 26 periods with per-period escrow round_half_up(825,000/26) = $317.31 and the cushion remains $1,375.00.", () => {
  const p = biweeklyProjection(lines(), FIRST);
  assert.equal(p.periods, 26); assert.equal(p.step1.length, 26); assert.equal(p.targets.length, 26);
  assert.equal(p.annual_cents, 825_000n); assert.equal(p.base_payment_cents, 31_731n);   // 825,000 / 26 = 31,730.77 → $317.31
  assert.equal(p.cushion_cents, 137_500n); assert.equal(p.cap_cents, 137_500n); assert.ok(p.cap_ok);
  const { events } = store();
  const a = analysis(events, { analysis_id: "EA-BIWEEKLY", biweekly: true });
  assert.equal(a.periods, 26); assert.equal(a.trial_balance.length, 26); assert.equal(a.per_period_cents, 31_731n); assert.equal(a.cushion_cents, 137_500n);
  assert.equal(a.cd_figures.l7.periodic_payments_in_year1, 26); assert.equal(a.cd_figures.l7.escrowed_property_costs_year1_cents, 31_731n * 26n);
});

test("30.3 worked figures: refinance fixture analysis, CD (g)(3)/(l)(7), statement payment, first-year actuals and the same-servicer credit", () => {
  const { events } = store();
  const ls = lines();
  assert.equal(ls.find((l) => l.line_type === "tax_county")!.estimated_annual_cents, 640_000n);        // $6,400.00 county taxes/yr
  assert.equal(ls.find((l) => l.line_type === "hazard")!.estimated_annual_cents, 185_000n);            // $1,850.00 hazard renewal
  const a = analysis(events);
  assert.equal(a.base_payment_cents, 68_750n); assert.equal(money(a.base_payment_cents), "$687.50");
  assert.equal(a.cushion_cents, 137_500n); assert.equal(money(a.cushion_cents), "$1,375.00");
  assert.equal(a.target_at_start_cents, 206_250n); assert.equal(money(a.target_at_start_cents), "$2,062.50");
  const g3 = a.cd_figures.g3; const taxes = g3.lines[0]!, ins = g3.lines[1]!;
  assert.equal(taxes.per_month_cents, 53_333n); assert.equal(money(taxes.per_month_cents), "$533.33"); assert.equal(taxes.amount_cents, 213_332n); assert.equal(money(taxes.amount_cents), "$2,133.32");
  assert.equal(ins.per_month_cents, 15_417n); assert.equal(money(ins.per_month_cents), "$154.17"); assert.equal(ins.amount_cents, 61_668n); assert.equal(money(ins.amount_cents), "$616.68");
  assert.equal(ins.deposits_before_first_disbursement_cents, 154_170n); assert.equal(money(ins.deposits_before_first_disbursement_cents), "$1,541.70");   // 10 deposits before the Nov renewal
  assert.equal(g3.aggregate_adjustment_cents, -68_750n); assert.equal(money(g3.aggregate_adjustment_cents), "-$687.50");
  assert.equal(a.cd_figures.l7.escrowed_property_costs_year1_cents, 825_000n); assert.equal(money(825_000n), "$8,250.00");
  assert.equal(a.cd_figures.l7.non_escrowed_property_costs_year1_cents, 0n); assert.equal(money(0n), "$0.00");
  assert.equal(statementMonthlyPayment(PI, a), 409_012n); assert.equal(money(PI), "$3,402.62"); assert.equal(money(409_012n), "$4,090.12");
  // First-year actual projection with 3.7's release dates: Apr 30 $1,612.50, Oct 31 $687.50, Dec 31 $2,062.50 — never negative.
  const actual = firstYearActualBalances(a);
  assert.equal(actual[3]!.balance_cents, 161_250n); assert.equal(money(161_250n), "$1,612.50");
  assert.equal(actual[9]!.balance_cents, 68_750n); assert.equal(actual[11]!.balance_cents, 206_250n); assert.ok(actual.every((m) => m.balance_cents >= 0n));
  // Same-servicer credit: $2,010.40 − $400.00 = $1,610.40 credited; closing funds $452.10.
  const B = priorBalanceAfterFinalDisbursements(201_040n, [{ amount_cents: 40_000n, paid_on: D("2026-11-10") }], FUNDED);
  assert.equal(money(201_040n), "$2,010.40"); assert.equal(money(40_000n), "$400.00"); assert.equal(B, 161_040n); assert.equal(money(B), "$1,610.40");
  assert.equal(a.target_at_start_cents - B, 45_210n); assert.equal(money(45_210n), "$452.10");
  // Purchase fixture: BPMI monthly $130.47 from the certificate.
  const mi = buildEscrowLines({ first_payment_date: FIRST, mi: { certificate_id: "MI-CERT-9", premium_plan: "bpmi_monthly", monthly_premium_cents: 13_047n, scheduled_78_date: D("2035-12-01") } })[0]!;
  assert.equal(mi.bills[0]!.amount_cents, 13_047n); assert.equal(money(13_047n), "$130.47"); assert.equal(mi.estimated_annual_cents, 156_564n);
});
