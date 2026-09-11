// 22.5 Liabilities, debt-to-income, qualifying payment, and debts paid at closing
// spec/sections/22-documents-credit-income-assets-liabilities-identity-and-frau/22-5-liabilities-debt-to-income-qualifying-payment-and-debts-paid.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor } from "../../kernel/calendar/business.ts";
import { toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { Decimal, divRound, formatCents } from "../../kernel/money/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_22_5 } from "../../app/tools/section22-5.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { newDebtImpact, dtiTenths, b3210ToleranceCheck } from "./ops-22-2.ts";
import {
  LiabilityRefused, DU_MAX_DTI_BPS, alimonyTreatments, amortizingPayment, computeDti, computeQualifyingPayment, declareLiability, dtiBps, dtiDisplayPct, electIncomeReduction, evaluateExclusion, irsAgreementGate, legalDocGate, liabilityRecalcGate, paydownTarget, payoffAmount, payoffFundsGate, paymentsRemaining, piCents, qualifyingRate, remainingMonths, revolving5pct, selectPaymentBasis, significantlyAffects, student1pct, tenMonthRule, tenMonthRemainingRule, toleranceResult,
  type Liability, type QualifyingPayment,
} from "./ops-22-5.ts";

const AGENT: Actor = { kind: "agent", id: "verification" };
const APP = "app-refi-1", LOAN = "L-REFI-1", APP_P = "app-purchase-1", A = "B-A", B = "B-B";
/** Creditor time (Phoenix: MST all year, UTC−7). */
const mst = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/Phoenix"));
const OCT5 = mst("2026-10-05", "11:00"), OCT19 = mst("2026-10-19", "11:00");

/** The 22.5 tools on the bus over the overridden registry (22.5 rows only), the escalation service and an entity store seeded with the application. */
function harness(nowIso: string, app = APP, appData: Record<string, unknown> = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId: app });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["22.5"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId: LOAN, applicationId: app, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  rt.store.put("applications", app, { occupancy: "primary", units: 1, borrower_ids: [A, B], ...appData }, AGENT, nowIso);
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_22_5); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("22.5", name))!, actor, { application_id: app, ...input }, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === app);
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt = clock.now(), actor: Actor = { kind: "agent", id: "intake" }) => events.append({ type, applicationId: app, aggregate: { kind: "application", id: app }, actor, occurredAt, payload: { application_id: app, ...payload } });
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  const liability = (id: string): Record<string, unknown> => rt.store.require("application_liabilities", id).data;
  const declare = async (id: string, input: ToolInput, evidence: ToolInput = {}) => { await run("buildLiabilitySet", { liability_id: id, borrower_ids: [A], source: "credit_report", ...input }); return run("selectPaymentBasis", { liability_id: id, ...evidence }); };
  return { clock, events, timers, rt, run, at, timer, ofType, upstream, refused, liability, declare, decisions, app };
}
type H = ReturnType<typeof harness>;
/** Refinance fixture (R6): Mon Oct 5, 2026; $560,000.00 30-year fixed 6.125 %; taxes 50,000, hazard 12,000; income 1,200,000; auto 31,237 (26 left), card A 7,500, card B $3,000.00 with no minimum → 15,000. */
async function seedRefi(h: H, at = OCT5) {
  h.upstream("income.finalized", { total_qualifying_cents: "1200000", scheduled_note_date: "2026-11-06" }, at);
  const qp = await h.run("computeQualifyingPayment", { loan_amount_cents: "56000000", note_rate_bps: 6125, product: "fixed", term_months: 360, taxes_cents: "50000", hazard_cents: "12000", mi_cents: "0", hoa_cents: "0", at });
  await h.declare("L-auto", { liability_type: "installment", creditor_name: "Desert Auto Finance", balance_cents: "810000", reported_payment_cents: "31237", remaining_months: 26, at });
  await h.declare("L-cardA", { liability_type: "revolving", creditor_name: "Card A", balance_cents: "250000", reported_payment_cents: "7500", at });
  await h.declare("L-cardB", { liability_type: "revolving", creditor_name: "Card B", balance_cents: "300000", at });
  const dti = await h.run("computeDti", { stage: "application", at });
  return { qp, dti };
}
/** Purchase fixture (R7): Mon Oct 19, 2026; $412,000.00 30-year fixed 6.375 % HomeReady, price $457,800.00; income 820,000; BPMI 13,047; T&I 61,500; student loan 24,000 (1 %), card 4,500, lease 12,500. */
async function seedPurchase(h: H, at = OCT19) {
  h.upstream("income.finalized", { total_qualifying_cents: "820000", scheduled_note_date: "2026-11-18" }, at);
  const qp = await h.run("computeQualifyingPayment", { loan_amount_cents: "41200000", note_rate_bps: 6375, product: "fixed", term_months: 360, mi_cents: "13047", taxes_cents: "50000", hazard_cents: "11500", at });
  await h.declare("L-student", { liability_type: "student_loan", creditor_name: "Federal Student Aid", balance_cents: "2400000", reported_payment_cents: "0", at }, { amortizing_terms: { rate_bps: 6530, term_months: 120 } });
  await h.declare("L-card", { liability_type: "revolving", creditor_name: "Card B", borrower_ids: [B], balance_cents: "118000", reported_payment_cents: "4500", at });
  await h.declare("L-lease", { liability_type: "lease_auto", creditor_name: "Auto Lease Co", borrower_ids: [B], balance_cents: "175000", reported_payment_cents: "12500", remaining_months: 14, at });
  const dti = await h.run("computeDti", { stage: "application", at });
  return { qp, dti };
}
const refiLiabilities = (): Liability[] => [
  { ...blank("L-auto", "installment", "Desert Auto Finance", 810_000n), reported_payment_cents: 31_237n, qualifying_payment_cents: 31_237n, payment_basis: "credit_report", remaining_months: 26 },
  { ...blank("L-cardA", "revolving", "Card A", 250_000n), reported_payment_cents: 7_500n, qualifying_payment_cents: 7_500n, payment_basis: "credit_report" },
  { ...blank("L-cardB", "revolving", "Card B", 300_000n), qualifying_payment_cents: 15_000n, payment_basis: "revolving_5pct" },
];
function blank(liability_id: string, liability_type: Liability["liability_type"], creditor_name: string, balance_cents: bigint, app = APP): Liability {
  return { liability_id, application_id: app, borrower_ids: [A], liability_type, creditor_name, account_last4: null, source: "credit_report", credit_tradeline_id: null, balance_cents, reported_payment_cents: null, remaining_months: null, qualifying_payment_cents: 0n, payment_basis: "none", include_in_dti: true, exclusion_reason: null, exclusion_evidence_document_ids: [], significantly_affects: false, income_reduction_elected: false, paid_at_closing: false, payoff_amount_cents: null, payoff_source_asset_id: null, payoff_statement_document_id: null, tax_lien_indicated: false, du_message_ids: [], status: "basis_selected", retention_class: "fnma_loan_file_life_plus_4y" };
}
const refiQp = (): QualifyingPayment => computeQualifyingPayment({ application_id: APP, version: 1, property_role: "subject_primary", loan_amount_cents: 56_000_000n, note_rate_bps: 6125, term_months: 360, product: "fixed", taxes_cents: 50_000n, hazard_cents: 12_000n });

test("22.5-T1: (refinance baseline) Given the refinance fixture inputs (P&I 340,262; taxes 50,000; hazard 12,000; liabilities 53,737; income 1,200,000), when computed, then `obligations = 455,999`, `dti_bps = 3,800`, display 38.00%, `du_cap_ok = true`.", async () => {
  const qp = refiQp();
  assert.equal(qp.pi_cents, 340_262n); assert.equal(qp.qualifying_rate_bps, 6125); assert.equal(qp.qualifying_rate_basis, "note_rate"); assert.equal(qp.pitia_cents, 402_262n);   // pi + taxes 50,000 + hazard 12,000 (MI 0, HOA 0)
  const c = computeDti({ application_id: APP, version: 1, stage: "application", qualifying_income_cents: 1_200_000n, qp, liabilities: refiLiabilities() });
  assert.equal(c.liabilities_cents, 53_737n); assert.equal(c.obligations_cents, 455_999n); assert.equal(c.income_cents, 1_200_000n);
  assert.equal(c.dti_bps, 3800); assert.equal(c.dti_display_pct, "38.00"); assert.equal(c.du_cap_ok, true); assert.equal(c.dti_tenths, 380);   // 455,999 × 10000 / 1,200,000 = 3,799.99 → 3,800 half-up (R1: rounded once, at the ratio)
  assert.deepEqual(c.liability_ids, ["L-auto", "L-cardA", "L-cardB"]);
  assert.equal(dtiBps(455_999n, 1_200_000n), 3800); assert.equal(dtiDisplayPct(3800), "38.00"); assert.throws(() => dtiBps(1n, 0n), RangeError);
  // the same figures through the bus: income from 22.3's income.finalized, the qualifying payment version, three liabilities with their bases, one immutable DTI version
  const h = harness(OCT5); const { qp: q, dti } = await seedRefi(h);
  assert.equal(q.pi_cents, 340_262n); assert.equal(q.pitia_cents, 402_262n);
  assert.equal(dti.obligations_cents, 455_999n); assert.equal(dti.dti_bps, 3800); assert.equal(dti.dti_display_pct, "38.00"); assert.equal(dti.du_cap_ok, true); assert.equal(dti.version, 1); assert.equal(dti.stage, "application");
  assert.equal(h.liability("L-cardB").payment_basis, "revolving_5pct"); assert.equal(h.liability("L-cardB").qualifying_payment_cents, "15000");
  const ev = h.ofType("dti.computed")[0]!; assert.equal(ev.payload.dti_bps, 3800); assert.equal(ev.payload.du_cap_ok, true); assert.equal(ev.payload.stage, "application");
  const gate = h.timer("FNMA_B3_6_02_DU_DTI_50_GATE")!; assert.equal(gate.status, "armed"); assert.match(gate.note ?? "", /evaluator:22.5.duDti50Gate/);
  assert.equal(evaluateGate("22.5.duDti50Gate", { dti_bps: 3800 }).open, true);
  const cap = await h.run("checkDuCap", { dti_id: dti.dti_id }); assert.equal(cap.du_cap_ok, true); assert.equal(cap.event, null); assert.equal(h.rt.escalations.opened.length, 0);
});

test("22.5-T2: (undisclosed debt) Given a UDM alert on Tue Oct 20, 2026 verified as a $450.00 auto payment, when `liabilities.changed` fires, then `dti_bps = 4,175`, 23.1's check returns `resubmission_required` (`B3_2_10_DTI_45_OR_3PT`, delta 375 bps), `SM_DU_RESUBMIT_SLA_1BD` due Wed Oct 21, 2026; given a $300.00 payment instead, then `dti_bps = 4,050` and `within_tolerance`.", async () => {
  const OCT20 = mst("2026-10-20", "14:00");
  const h = harness(OCT5); const { dti: v1 } = await seedRefi(h); h.at(OCT20);
  // 22.2's triage (credit.undisclosed_debt.found{source=udm_alert}) is the hand-off; its own impact check already says resubmission (417 tenths = 41.7 %)
  const impact = newDebtImpact({ application_id: APP, borrower_id: A, creditor_name: "New Auto Lender", liability_kind: "installment", monthly_payment_cents: 45_000n, qualifying_income_cents: 1_200_000n, obligations_cents: 455_999n, source: "udm_alert" });
  assert.equal(impact.new_dti_tenths, 417); assert.equal(impact.tolerance.result, "resubmission required"); assert.equal(impact.dti_recalculation_for, "22.5");
  const ing = await h.run("buildLiabilitySet", { op: "ingest_undisclosed", liability_id: "L-newauto", borrower_id: A, creditor_name: "New Auto Lender", liability_kind: "installment", monthly_payment_cents: "45000", balance_cents: "2400000", source: "udm_alert", at: OCT20 });
  assert.deepEqual(ing.events, ["liability.discovered", "liability.payment_basis.selected"]); assert.equal((ing.liability as Liability).source, "udm_alert"); assert.equal((ing.liability as Liability).qualifying_payment_cents, 45_000n);
  const v2 = await h.run("computeDti", { stage: "pre_cd", at: OCT20 });
  assert.equal(v2.obligations_cents, 500_999n); assert.equal(v2.dti_bps, 4175); assert.equal(v2.dti_display_pct, "41.75"); assert.equal(v2.du_cap_ok, true);
  const t = await h.run("notifyTolerance", { dti_after_id: v2.dti_id, dti_before_id: v1.dti_id, trigger: "credit.undisclosed_debt.found{udm_alert}", liability_id: "L-newauto", at: OCT20 });
  assert.equal(t.result, "resubmission_required"); assert.equal(t.rule_code, "B3_2_10_DTI_45_OR_3PT"); assert.equal(t.delta_bps, 375); assert.equal(t.exceeds_45, false); assert.equal(t.increase_3_points, true); assert.equal(t.resubmission_for, "23.1");
  assert.equal((t.check_23_1 as { result: string }).result, "resubmission required");   // 23.1's tenths-based check (22.2 b3210ToleranceCheck) agrees: 380 → 417 tenths
  const ev = h.ofType("liabilities.changed")[0]!; assert.equal(ev.payload.dti_before, "38.00"); assert.equal(ev.payload.dti_after, "41.75"); assert.equal(ev.payload.tolerance_result, "resubmission_required"); assert.equal(ev.payload.dti_before_bps, 3800); assert.equal(ev.payload.dti_after_bps, 4175);
  const sla = h.timer("SM_DU_RESUBMIT_SLA_1BD")!; assert.equal(sla.status, "armed"); assert.equal(sla.anchorDate, "2026-10-20"); assert.equal(sla.dueDate, "2026-10-21");   // +1 business_days_creditor
  assert.equal(addBusinessDays(D("2026-10-20"), 1, creditor), "2026-10-21");
  assert.equal(h.timer("FNMA_B3_6_01_LIABILITY_RECALC_GATE")!.status, "armed");   // every liabilities.changed re-opens the final-consistency question
  // the resubmission's DTI version (checked against 23.1's check / the new DU submission) retires the SLA
  const v3 = await h.run("computeDti", { stage: "du_submission_2", du_submission_id: "DU-SUB-2", b3_2_10_check_id: "CHK-1", at: mst("2026-10-20", "16:30") });
  assert.equal(v3.dti_bps, 4175); assert.equal(h.timer("SM_DU_RESUBMIT_SLA_1BD")!.status, "satisfied");
  // $300.00 instead: 485,999 / 1,200,000 → 4,050 bps, +250 < 300 and ≤ 4,500 → within tolerance, no SLA instance
  const h2 = harness(OCT5); const { dti: w1 } = await seedRefi(h2); h2.at(OCT20);
  await h2.run("buildLiabilitySet", { op: "ingest_undisclosed", liability_id: "L-newauto", borrower_id: A, creditor_name: "New Auto Lender", liability_kind: "installment", monthly_payment_cents: "30000", source: "udm_alert", at: OCT20 });
  const w2 = await h2.run("computeDti", { stage: "pre_cd", at: OCT20 }); assert.equal(w2.obligations_cents, 485_999n); assert.equal(w2.dti_bps, 4050);
  const t2 = await h2.run("notifyTolerance", { dti_after_id: w2.dti_id, dti_before_id: w1.dti_id, at: OCT20 });
  assert.equal(t2.result, "within_tolerance"); assert.equal(t2.delta_bps, 250); assert.equal(t2.resubmission_for, null); assert.equal((t2.check_23_1 as { result: string }).result, "no resubmission required");
  assert.equal(h2.timer("SM_DU_RESUBMIT_SLA_1BD"), undefined);
  assert.equal(b3210ToleranceCheck(dtiTenths(455_999n, 1_200_000n), dtiTenths(485_999n, 1_200_000n)).result, "no resubmission required");
});

test("22.5-T3: (alimony election) Given alimony of $800.00/month under a decree ending 2031, when the income-reduction option is elected, then `income = 1,120,000`, `dti_bps = 4,071`; when not elected, then `obligations = 535,999`, `dti_bps = 4,467`; given the obligation is child support, then the election is refused and `dti_bps = 4,467`.", async () => {
  const h = harness(OCT5); await seedRefi(h);
  const dec = await h.declare("L-alimony", { liability_type: "alimony", creditor_name: "Ex-spouse (2022 decree, ends 2031)", balance_cents: "0", source: "application" }, { legal_agreement_document_id: "DOC-decree", legal_agreement_payment_cents: "80000" });
  assert.equal(dec.payment_basis, "legal_agreement"); assert.equal(dec.qualifying_payment_cents, 80_000n); assert.equal(dec.condition, null);
  const gate = h.timer("FNMA_B3_6_05_LEGAL_DOC_GATE")!; assert.equal(gate.status, "armed"); assert.match(gate.note ?? "", /evaluator:22.5.legalDocGate/);   // armed by liability.declared{liability_type=alimony}
  assert.equal(evaluateGate("22.5.legalDocGate", { liability_type: "alimony", legal_agreement_document_id: null }).open, false);
  assert.equal(evaluateGate("22.5.legalDocGate", { liability_type: "alimony", legal_agreement_document_id: "DOC-decree", amount_confirmed: true }).open, true);
  h.upstream("document.classified", { document_id: "DOC-decree", doc_class: "divorce_decree", doc_family: "income_employment", confidence: 0.97 }, mst("2026-10-06", "09:00"), { kind: "agent", id: "verification" });
  assert.equal(h.timer("FNMA_B3_6_05_LEGAL_DOC_GATE")!.status, "satisfied");   // 22.1's classification of the decree
  // both computations (Q2): as a liability 44.67 %, with the income reduction 40.71 % → the agent elects the reduction and DU is submitted with income reduced
  const both = await h.run("evaluateExclusion", { op: "alimony_treatments", liability_id: "L-alimony", obligations_without_cents: "455999", income_cents: "1200000" });
  assert.deepEqual(both.as_liability, { obligations_cents: 535_999n, income_cents: 1_200_000n, dti_bps: 4467 }); assert.deepEqual(both.income_reduction, { obligations_cents: 455_999n, income_cents: 1_120_000n, dti_bps: 4071 }); assert.equal(both.recommended, "income_reduction"); assert.equal(both.permitted, true);
  const elect = await h.run("evaluateExclusion", { op: "elect_income_reduction", liability_id: "L-alimony", liability_type: "alimony", elect: true, legal_agreement_document_id: "DOC-decree", rationale: "lower DTI; permitted for alimony (B3-6-05)" });
  assert.equal(elect.income_reduction_elected, true); assert.equal(elect.exclusion_reason, "income_reduction_elected"); assert.equal(elect.du_submitted_as, "income reduced, not the liability");
  const e = await h.run("computeDti", { stage: "pre_cd" }); assert.equal(e.income_cents, 1_120_000n); assert.equal(e.income_reductions_cents, 80_000n); assert.equal(e.obligations_cents, 455_999n); assert.equal(e.dti_bps, 4071); assert.equal(e.dti_display_pct, "40.71");
  const un = await h.run("evaluateExclusion", { op: "elect_income_reduction", liability_id: "L-alimony", liability_type: "alimony", elect: false }); assert.equal(un.include_in_dti, true); assert.equal(un.income_reduction_elected, false);
  const n = await h.run("computeDti", { stage: "pre_cd" }); assert.equal(n.income_cents, 1_200_000n); assert.equal(n.obligations_cents, 535_999n); assert.equal(n.dti_bps, 4467); assert.equal(n.dti_display_pct, "44.67");
  // child support: no income-reduction option — refused by the guardrail and by the rule; it stays a debt → 44.67 %
  const h2 = harness(OCT5); await seedRefi(h2);
  await h2.declare("L-support", { liability_type: "child_support", creditor_name: "Support order (ends 2031)", balance_cents: "0", source: "application" }, { legal_agreement_document_id: "DOC-order", legal_agreement_payment_cents: "80000" });
  await h2.refused(h2.run("evaluateExclusion", { op: "elect_income_reduction", liability_id: "L-support", liability_type: "child_support", elect: true, legal_agreement_document_id: "DOC-order" }), "NO_INCOME_REDUCTION_FOR_CHILD_SUPPORT");
  await h2.refused(h2.run("evaluateExclusion", { op: "elect_income_reduction", liability_id: "L-support", elect: true, legal_agreement_document_id: "DOC-order" }), "ALIMONY_ELECTION_NOT_FOR_CHILD_SUPPORT");
  const cs = { ...blank("L-support", "child_support", "Support order", 0n), qualifying_payment_cents: 80_000n, payment_basis: "legal_agreement" as const };
  assert.throws(() => electIncomeReduction(new MemoryEventStore(new FixedClock(OCT5)), cs, true, { at: OCT5, legal_agreement_document_id: "DOC-order", rationale: "x" }), (e: unknown) => e instanceof LiabilityRefused && e.code === "ALIMONY_ELECTION_NOT_FOR_CHILD_SUPPORT");
  assert.equal(alimonyTreatments(cs, { obligations_without_cents: 455_999n, income_cents: 1_200_000n }).permitted, false);
  const c = await h2.run("computeDti", { stage: "pre_cd" }); assert.equal(c.obligations_cents, 535_999n); assert.equal(c.dti_bps, 4467);
});

test("22.5-T4: (ARM qualifying rates) Given a 5/6 ARM at 5.875% (cap 2%), index 4.30%, margin 2.75%, when computed, then `qualifying_rate_bps = 7,875` and `pi = 406,039`; given a 7/6 ARM at 6.000% not HPML, then 6,000 bps and `pi = 335,748`; given the same loan flagged HPML by 23.4, then 7,050 bps and `pi = 374,452`; given a 2-1 buydown on the fixed purchase loan, then the qualifying P&I is 257,034, not 205,706.", async () => {
  const base = { application_id: APP, version: 1, property_role: "subject_primary" as const, loan_amount_cents: 56_000_000n, term_months: 360 };
  const arm5 = computeQualifyingPayment({ ...base, product: "arm_5", note_rate_bps: 5875, first_cap_bps: 2000, index_bps: 4300, margin_bps: 2750 });
  assert.equal(arm5.qualifying_rate_bps, 7875); assert.equal(arm5.qualifying_rate_basis, "greater_note_plus_cap_or_fir"); assert.equal(arm5.fully_indexed_bps, 7050); assert.equal(arm5.pi_cents, 406_039n);   // max(5.875 + 2.000, 4.300 + 2.750) = 7.875 %
  const arm7 = computeQualifyingPayment({ ...base, product: "arm_7", note_rate_bps: 6000, first_cap_bps: 5000, index_bps: 4300, margin_bps: 2750, hpml_or_hpct: false });
  assert.equal(arm7.qualifying_rate_bps, 6000); assert.equal(arm7.qualifying_rate_basis, "note_rate"); assert.equal(arm7.pi_cents, 335_748n);
  const hpml = computeQualifyingPayment({ ...base, product: "arm_7", note_rate_bps: 6000, first_cap_bps: 5000, index_bps: 4300, margin_bps: 2750, hpml_or_hpct: true });
  assert.equal(hpml.qualifying_rate_bps, 7050); assert.equal(hpml.qualifying_rate_basis, "greater_note_or_fir_hpml"); assert.equal(hpml.pi_cents, 374_452n);   // max(6.000, 7.050)
  assert.equal(qualifyingRate({ product: "arm_10", note_rate_bps: 6250, index_bps: 4300, margin_bps: 2750, hpml_or_hpct: true }).qualifying_rate_bps, 7050);
  assert.equal(qualifyingRate({ product: "arm_3_or_less", note_rate_bps: 5500, first_cap_bps: 2000, max_rate_first_5y_bps: 9500 }).qualifying_rate_bps, 9500);
  assert.equal(qualifyingRate({ product: "generic_arm", note_rate_bps: 6000, du_arm_qualifying_rate_bps: 6500 }).qualifying_rate_basis, "du_arm_qualifying_rate_field");   // DU 12.1 honors the field when higher
  // 2-1 temporary buydown on the purchase loan: qualifying rate stays 6.375 % → 257,034; the year-1 4.375 % payment of $2,057.06 is recorded, never used
  const buy = computeQualifyingPayment({ application_id: APP_P, version: 1, property_role: "subject_primary", loan_amount_cents: 41_200_000n, note_rate_bps: 6375, term_months: 360, product: "fixed", temporary_buydown: { year1_rate_bps: 4375, kind: "2-1 seller-funded (22.4 IPC)" } });
  assert.equal(buy.qualifying_rate_bps, 6375); assert.equal(buy.buydown_ignored, true); assert.equal(buy.pi_cents, 257_034n); assert.equal(buy.bought_down_pi_cents, 205_706n); assert.notEqual(buy.pi_cents, 205_706n);
  assert.equal(piCents(41_200_000n, 4375, 360), 205_706n);
  // through the bus: 23.4's compliance.hpml.determined{is_hpml=true} flips the 7/6 ARM; the bought-down rate is a refused input
  const h = harness(OCT5);
  const q1 = await h.run("computeQualifyingPayment", { loan_amount_cents: "56000000", note_rate_bps: 5875, product: "arm_5", first_cap_bps: 2000, index_bps: 4300, margin_bps: 2750 }); assert.equal(q1.qualifying_rate_bps, 7875); assert.equal(q1.pi_cents, 406_039n);
  const q2 = await h.run("computeQualifyingPayment", { loan_amount_cents: "56000000", note_rate_bps: 6000, product: "arm_7", index_bps: 4300, margin_bps: 2750 }); assert.equal(q2.qualifying_rate_bps, 6000); assert.equal(q2.pi_cents, 335_748n);
  h.upstream("compliance.hpml.determined", { stage: "cd", is_hpml: true, spread: "1.62" }, mst("2026-11-02", "10:00"), { kind: "agent", id: "compliance" });
  const q3 = await h.run("computeQualifyingPayment", { loan_amount_cents: "56000000", note_rate_bps: 6000, product: "arm_7", index_bps: 4300, margin_bps: 2750 }); assert.equal(q3.qualifying_rate_bps, 7050); assert.equal(q3.pi_cents, 374_452n); assert.equal(q3.qualifying_rate_basis, "greater_note_or_fir_hpml");
  await h.refused(h.run("computeQualifyingPayment", { loan_amount_cents: "41200000", note_rate_bps: 6375, product: "fixed", temporary_buydown: { year1_rate_bps: 4375, kind: "2-1" }, use_bought_down_rate: true }), "NO_BOUGHT_DOWN_RATE");
  assert.equal(h.ofType("qualifying_payment.computed").length, 3);
});

test("22.5-T5: (student loans) Given a $24,000.00 balance with $0 on the report and no documentation, when the basis is selected, then `qualifying_payment = 24,000` (`student_1pct_balance`) with the amortizing alternative 27,288 recorded; given an IDR statement showing $0.00, then `student_idr_zero_documented` and payment 0; given the report shows $180.00, then 18,000 (`credit_report`).", async () => {
  const sl = { liability_type: "student_loan" as const, balance_cents: 2_400_000n, reported_payment_cents: 0n };
  const onePct = selectPaymentBasis(sl, { amortizing_terms: { rate_bps: 6530, term_months: 120 } });
  assert.equal(onePct.qualifying_payment_cents, 24_000n); assert.equal(onePct.payment_basis, "student_1pct_balance");
  assert.deepEqual(onePct.alternatives, { student_1pct_balance: "24000", student_amortizing_documented: "27288" });   // both figures recorded (guardrail); 1 % is the lower permitted figure
  assert.equal(student1pct(2_400_000n), 24_000n); assert.equal(amortizingPayment(2_400_000n, 6530, 120), 27_288n);
  const bare = selectPaymentBasis(sl); assert.equal(bare.qualifying_payment_cents, 24_000n); assert.deepEqual(bare.alternatives, { student_1pct_balance: "24000" }); assert.match(bare.condition ?? "", /repayment terms|IDR/);
  const lower = selectPaymentBasis(sl, { amortizing_payment_cents: 21_000n }); assert.equal(lower.payment_basis, "student_amortizing_documented"); assert.equal(lower.qualifying_payment_cents, 21_000n);   // forbearance with a documented amortizing payment below 1 % (edge case)
  const idr = selectPaymentBasis(sl, { idr_statement_document_id: "DOC-idr", idr_payment_cents: 0n }); assert.equal(idr.payment_basis, "student_idr_zero_documented"); assert.equal(idr.qualifying_payment_cents, 0n);
  const rep = selectPaymentBasis({ ...sl, reported_payment_cents: 18_000n }); assert.equal(rep.payment_basis, "credit_report"); assert.equal(rep.qualifying_payment_cents, 18_000n);
  // through the bus on the purchase fixture (Borrower A): the choice is recorded on liability.payment_basis.selected; an IDR statement moves the DTI from 45.44 % to 42.51 %; "optimizing" past the Guide is refused
  const h = harness(OCT19, APP_P); const { dti } = await seedPurchase(h);
  assert.equal(dti.dti_bps, 4544); assert.equal(h.liability("L-student").payment_basis, "student_1pct_balance"); assert.equal(h.liability("L-student").qualifying_payment_cents, "24000");
  assert.deepEqual(h.ofType("liability.payment_basis.selected").find((e) => e.payload.liability_id === "L-student")!.payload.alternatives, { student_1pct_balance: "24000", student_amortizing_documented: "27288" });
  const i = await h.run("selectPaymentBasis", { liability_id: "L-student", idr_statement_document_id: "DOC-idr", idr_payment_cents: "0" }); assert.equal(i.payment_basis, "student_idr_zero_documented"); assert.equal(i.qualifying_payment_cents, 0n);
  const d2 = await h.run("computeDti", { stage: "pre_cd" }); assert.equal(d2.obligations_cents, 348_581n); assert.equal(d2.dti_bps, 4251);
  const r = await h.run("selectPaymentBasis", { liability_id: "L-student", reported_payment_cents: "18000" }); void r;
  await h.run("buildLiabilitySet", { liability_id: "L-student2", liability_type: "student_loan", creditor_name: "Servicer B", borrower_ids: [A], balance_cents: "1000000", reported_payment_cents: "18000" });
  const s2 = await h.run("selectPaymentBasis", { liability_id: "L-student2" }); assert.equal(s2.payment_basis, "credit_report"); assert.equal(s2.qualifying_payment_cents, 18_000n);
  await h.refused(h.run("selectPaymentBasis", { liability_id: "L-student2", force_basis: "student_idr_zero_documented" }), "NO_BASIS_OPTIMIZATION");
});

test("22.5-T6: (purchase DTI and 50% cap) Given the purchase fixture inputs, when computed, then `obligations = 372,581`, `dti_bps = 4,544`; given added child support of $600.00 with 13 payments remaining, then `dti_bps = 5,275`, `FNMA_B3_6_02_DU_DTI_50_GATE` fails and 23.2 receives `dti.du_cap.exceeded`; given 9 payments remaining and `significantly_affects = false`, then excluded and `dti_bps = 4,544`.", async () => {
  const h = harness(OCT19, APP_P); const { qp, dti } = await seedPurchase(h);
  assert.equal(qp.pi_cents, 257_034n); assert.equal(qp.pitia_cents, 331_581n);   // 257,034 + BPMI 13,047 + taxes 50,000 + hazard 11,500
  assert.equal(dti.obligations_cents, 372_581n); assert.equal(dti.dti_bps, 4544); assert.equal(dti.dti_display_pct, "45.44"); assert.equal(dti.du_cap_ok, true);   // 372,581 × 10000 / 820,000 = 4,543.67 → 4,544
  assert.equal(h.liability("L-lease").payment_basis, "lease_full");
  // child support 60,000/month, order to Dec 2027 → 13 payments after the Wed Nov 18, 2026 note date → included → 432,581 → 52.75 % > 50.00 %
  h.upstream("closing.scheduled", { scheduled_note_date: "2026-11-18" }, mst("2026-11-02", "09:00"), { kind: "agent", id: "closing" });
  await h.declare("L-support", { liability_type: "child_support", creditor_name: "Franklin County support order", borrower_ids: [B], balance_cents: "0", source: "application" }, { legal_agreement_document_id: "DOC-order", legal_agreement_payment_cents: "60000" });
  assert.equal(paymentsRemaining(D("2026-11-18"), D("2027-12-01")), 13); assert.equal(paymentsRemaining(D("2026-11-18"), D("2027-08-01")), 9);
  const inc = await h.run("evaluateExclusion", { liability_id: "L-support", reason: "le_10_payments", note_date: "2026-11-18", last_payment_month: "2027-12-01" });
  assert.equal(inc.include_in_dti, true); assert.equal(inc.remaining_months, 13); assert.equal(inc.exclusion_reason, null); assert.equal(inc.event, "liability.included");
  const over = await h.run("computeDti", { stage: "decision_of_record" }); assert.equal(over.obligations_cents, 432_581n); assert.equal(over.dti_bps, 5275); assert.equal(over.du_cap_ok, false);
  assert.equal(evaluateGate("22.5.duDti50Gate", { dti_bps: 5275 }).open, false); assert.equal(DU_MAX_DTI_BPS, 5000);
  const cap = await h.run("checkDuCap", { dti_id: over.dti_id });
  assert.equal(cap.du_cap_ok, false); assert.equal(cap.event, "dti.du_cap.exceeded"); assert.equal(cap.hand_off, "23.2"); assert.equal(cap.escalated_to, "underwriting_reviewer");
  const ex = h.ofType("dti.du_cap.exceeded")[0]!; assert.equal(ex.payload.dti_bps, 5275); assert.equal(ex.payload.cap_bps, 5000); assert.ok((ex.payload.consumers as string[]).includes("23.2"));
  assert.equal(h.rt.escalations.opened.filter((e) => e.kind === "underwriting_reviewer").length, 1);
  await h.refused(h.run("finalizeLiabilities", { dti_id: over.dti_id, cd_final_pi_cents: "257034", du_final_liability_ids: over.liability_ids as string[] }), "FNMA_B3_6_02_DU_DTI_50_GATE");
  // order to Aug 2027 → 9 payments ≤ 10 and not significant (60,000 is 7.3 % of 820,000) → excluded → back to 45.44 %
  const ex9 = await h.run("evaluateExclusion", { liability_id: "L-support", reason: "le_10_payments", note_date: "2026-11-18", last_payment_month: "2027-08-01", qualifying_income_cents: "820000" });
  assert.equal(ex9.include_in_dti, false); assert.equal(ex9.exclusion_reason, "le_10_payments"); assert.equal(ex9.remaining_months, 9); assert.equal(ex9.significantly_affects, false);
  const back = await h.run("computeDti", { stage: "decision_of_record", remaining_months_recomputed: true }); assert.equal(back.obligations_cents, 372_581n); assert.equal(back.dti_bps, 4544); assert.equal(back.du_cap_ok, true);
  assert.equal(h.timer("FNMA_B3_6_05_10MO_REMAINING_RULE")!.status, "satisfied");   // the recomputation as of the note date is recorded on the version
  assert.equal(tenMonthRule({ liability_type: "child_support", significantly_affects: false }, 9).exclusion_reason, "le_10_payments");
  assert.equal(tenMonthRule({ liability_type: "lease_auto", significantly_affects: false }, 3).applies, false);   // leases count regardless of the months remaining
});

test("22.5-T7: (debt paid at closing) Given a $1,180.00 revolving balance planned `pay_off_at_closing`, when the plan is evaluated, then the payment (4,500) is excluded, `funds_to_verify` in 22.4 rises by 118,000 cents, no account-closure condition is opened, and `FNMA_B3_6_07_PAYOFF_FUNDS_GATE` opens only when the settlement statement (Wed Nov 18, 2026) shows the payoff; given the settlement statement omits it, then the gate blocks `funding.authorized` and the DTI is recomputed with the payment included.", async () => {
  const NOV2 = mst("2026-11-02", "10:00"), NOV18 = mst("2026-11-18", "15:30");
  const h = harness(OCT19, APP_P); await seedPurchase(h); h.at(NOV2);
  h.upstream("closing.scheduled", { scheduled_note_date: "2026-11-18" }, NOV2, { kind: "agent", id: "closing" });
  const plan = await h.run("planPayoff", { liability_id: "L-card", mode: "pay_off_at_closing", funds_source_asset_id: "ASSET-checking", funds_verified_in_addition: true, post_closing_liquid_cents: "4514318", credit_use_rationale: "trended data: card paid to zero in 9 of the last 12 months; payoff is not a pattern of revolving reliance (B3-6-07)", at: NOV2 });
  assert.equal(plan.payoff_amount_cents, 118_000n); assert.equal(plan.funds_to_verify_delta_cents, 118_000n); assert.equal(plan.excluded_payment_cents, 4_500n); assert.equal(plan.exclusion_reason, "paid_off_at_closing"); assert.equal(plan.account_closure_condition, null); assert.equal(plan.reviewer_required, false); assert.equal(plan.status, "approved");
  assert.equal(h.rt.store.list("conditions", (d) => /clos(e|ure)/i.test(String(d.text))).length, 0);   // "Such accounts do not need to be closed"
  assert.equal(h.liability("L-card").include_in_dti, false); assert.equal(h.liability("L-card").paid_at_closing, true); assert.equal(h.liability("L-card").payoff_amount_cents, "118000");
  const planned = h.ofType("debt_payoff.planned")[0]!; assert.equal(planned.payload.funds_to_verify_delta_cents, "118000"); assert.equal(planned.payload.scheduled_note_date, "2026-11-18"); assert.equal(planned.payload.account_closure_required, false); assert.ok((planned.payload.consumers as string[])[0]!.startsWith("22.4"));
  const gate = h.timer("FNMA_B3_6_07_PAYOFF_FUNDS_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2026-11-18"); assert.match(gate.note ?? "", /evaluator:22.5.payoffFundsGate/);
  // 22.4's worksheet: 51,140.18 usable closing funds − 43,997.00 cash to close = 7,143.18 ≥ 1,180.00 → funds in addition; the gate still waits for the settlement statement
  assert.equal(5_114_018n - 4_399_700n, 714_318n); assert.ok(714_318n >= 118_000n);
  assert.equal(evaluateGate("22.5.payoffFundsGate", { payoff_amount_cents: "118000", verified_funds_in_addition_cents: "714318" }).open, false);
  assert.equal(evaluateGate("22.5.payoffFundsGate", { payoff_amount_cents: "118000", verified_funds_in_addition_cents: "100000", settlement_statement_shows_payoff: true }).open, false);   // funds short → re-included
  assert.equal(evaluateGate("22.5.payoffFundsGate", { payoff_amount_cents: "118000", verified_funds_in_addition_cents: "714318", settlement_statement_shows_payoff: true }).open, true);
  const d = await h.run("computeDti", { stage: "pre_cd", at: NOV2 }); assert.equal(d.obligations_cents, 368_081n); assert.equal(d.dti_bps, 4489);   // 372,581 − 4,500
  h.at(NOV18);
  const ok = await h.run("evidencePayoff", { plan_id: plan.plan_id, settlement_statement_document_id: "DOC-settlement", settlement_statement_shows_payoff: true, at: NOV18 });
  assert.equal(ok.status, "evidenced"); assert.equal(ok.evidence, "settlement_statement_line"); assert.equal(ok.re_included, false); assert.equal(ok.event, "debt_payoff.evidenced");
  assert.equal(h.timer("FNMA_B3_6_07_PAYOFF_FUNDS_GATE")!.status, "satisfied");
  // the settlement statement omits the payoff → debt_payoff.failed, funding.authorized blocked, the payment back in DTI → 45.44 %
  const h2 = harness(OCT19, APP_P); await seedPurchase(h2); h2.at(NOV2);
  h2.upstream("closing.scheduled", { scheduled_note_date: "2026-11-18" }, NOV2, { kind: "agent", id: "closing" });
  const p2 = await h2.run("planPayoff", { liability_id: "L-card", mode: "pay_off_at_closing", funds_verified_in_addition: true, credit_use_rationale: "as above", at: NOV2 });
  h2.at(NOV18);
  const bad = await h2.run("evidencePayoff", { plan_id: p2.plan_id, settlement_statement_document_id: "DOC-settlement", settlement_statement_shows_payoff: false, at: NOV18 });
  assert.equal(bad.status, "failed"); assert.equal(bad.blocks, "funding.authorized"); assert.equal(bad.re_included, true); assert.equal(bad.event, "debt_payoff.failed"); assert.equal(h2.timer("FNMA_B3_6_07_PAYOFF_FUNDS_GATE")!.status, "armed");
  assert.equal(h2.liability("L-card").include_in_dti, true); assert.equal(h2.liability("L-card").status, "reopened");
  const again = await h2.run("computeDti", { stage: "final", at: NOV18 }); assert.equal(again.obligations_cents, 372_581n); assert.equal(again.dti_bps, 4544);
  await h2.refused(h2.run("planPayoff", { liability_id: "L-card", mode: "pay_off_at_closing", funds_verified_in_addition: false, credit_use_rationale: "x" }), "PAYOFF_FUNDS_NOT_IN_ADDITION");
  assert.equal(payoffAmount({ liability_type: "revolving", balance_cents: 118_000n, qualifying_payment_cents: 4_500n }, "pay_off_at_closing"), 118_000n);
});

test("22.5-T8: (installment ≤ 10 payments) Given an installment loan with 9 payments of $312.37 remaining as of Fri Nov 6, 2026, when evaluated, then excluded (`le_10_payments`); given the closing moves to Mon Oct 26, 2026 with 11 remaining, then re-included; given `significantly_affects = true` (payment 16% of income), then included regardless.", async () => {
  const auto = { ...blank("L-auto", "installment", "Desert Auto Finance", 281_133n), reported_payment_cents: 31_237n, qualifying_payment_cents: 31_237n, payment_basis: "credit_report" as const, remaining_months: 9 };
  const ex = evaluateExclusion(auto, "le_10_payments", { note_date: D("2026-11-06"), qualifying_income_cents: 1_200_000n });
  assert.equal(ex.include_in_dti, false); assert.equal(ex.exclusion_reason, "le_10_payments"); assert.equal(ex.liability.remaining_months, 9); assert.equal(ex.liability.significantly_affects, false);
  assert.equal(remainingMonths({ remaining_months: null, balance_cents: 281_133n, qualifying_payment_cents: 31_237n }), 9);   // ceil(balance ÷ payment) when the creditor states nothing
  // the closing moves to Mon Oct 26, 2026 and the creditor's statement shows 11 remaining as of that note date → re-included (the calendar count Nov 2026–Aug 2027 is 10; the creditor-stated figure governs — R4)
  assert.equal(paymentsRemaining(D("2026-10-26"), D("2027-08-01")), 10);
  const re = evaluateExclusion({ ...auto, remaining_months: 11 }, "le_10_payments", { note_date: D("2026-10-26"), qualifying_income_cents: 1_200_000n });
  assert.equal(re.include_in_dti, true); assert.equal(re.exclusion_reason, null); assert.match(re.why, /11 payments remaining > 10/);
  // significantly affects: a 192,000 payment is 16 % of 1,200,000 (> 15 %, Q4) → included regardless of the 9 payments
  assert.equal(significantlyAffects({ payment_cents: 192_000n, qualifying_income_cents: 1_200_000n }), true); assert.equal(significantlyAffects({ payment_cents: 31_237n, qualifying_income_cents: 1_200_000n }), false);
  const big = evaluateExclusion({ ...auto, qualifying_payment_cents: 192_000n }, "le_10_payments", { note_date: D("2026-11-06"), qualifying_income_cents: 1_200_000n });
  assert.equal(big.include_in_dti, true); assert.equal(big.liability.significantly_affects, true); assert.match(big.why, /significantly affects/);
  assert.equal(evaluateExclusion({ ...auto, significantly_affects: true }, "le_10_payments", { remaining_months: 9 }).include_in_dti, true);
  // the gate: armed by closing.scheduled (anchor = scheduled_note_date), open only when the recomputation as of that date agrees with every inclusion, retired by the DTI version that records it
  const h = harness(OCT5); await seedRefi(h);
  await h.run("buildLiabilitySet", { liability_id: "L-auto9", liability_type: "installment", creditor_name: "Nine Left Finance", borrower_ids: [A], balance_cents: "281133", reported_payment_cents: "31237", remaining_months: 9 }); await h.run("selectPaymentBasis", { liability_id: "L-auto9" });
  h.upstream("closing.scheduled", { scheduled_note_date: "2026-11-06" }, mst("2026-10-23", "09:00"), { kind: "agent", id: "closing" });
  const g = h.timer("FNMA_B3_6_05_10MO_REMAINING_RULE")!; assert.equal(g.status, "armed"); assert.equal(g.anchorDate, "2026-11-06"); assert.match(g.note ?? "", /evaluator:22.5.tenMonthRemainingRule/);
  assert.equal(tenMonthRemainingRule({ scheduled_note_date: "2026-11-06", recomputed_as_of: null, liabilities: [] }).open, false);
  assert.equal(tenMonthRemainingRule({ scheduled_note_date: "2026-11-06", recomputed_as_of: "2026-11-06", liabilities: [{ liability_type: "installment", remaining_months: 9, include_in_dti: true }] }).open, false);   // still included → disagrees with the rule
  const x = await h.run("evaluateExclusion", { liability_id: "L-auto9", reason: "le_10_payments", remaining_months: 9, qualifying_income_cents: "1200000" }); assert.equal(x.include_in_dti, false);
  assert.equal(tenMonthRemainingRule({ scheduled_note_date: "2026-11-06", recomputed_as_of: "2026-11-06", liabilities: [{ liability_type: "installment", remaining_months: 9, include_in_dti: false }] }).open, true);
  const v = await h.run("computeDti", { stage: "pre_cd", remaining_months_recomputed: true }); assert.equal(v.dti_bps, 3800); assert.equal(h.timer("FNMA_B3_6_05_10MO_REMAINING_RULE")!.status, "satisfied");
  h.upstream("closing.scheduled", { scheduled_note_date: "2026-10-26" }, mst("2026-10-23", "11:00"), { kind: "agent", id: "closing" });
  assert.equal(h.timer("FNMA_B3_6_05_10MO_REMAINING_RULE")!.status, "armed"); assert.equal(h.timer("FNMA_B3_6_05_10MO_REMAINING_RULE")!.anchorDate, "2026-10-26");
  const y = await h.run("evaluateExclusion", { liability_id: "L-auto9", reason: "le_10_payments", remaining_months: 11, qualifying_income_cents: "1200000" }); assert.equal(y.include_in_dti, true); assert.equal(y.event, "liability.included");
  const w = await h.run("computeDti", { stage: "pre_cd", remaining_months_recomputed: true }); assert.equal(w.obligations_cents, 487_236n); assert.equal(w.dti_bps, 4060);   // 455,999 + 31,237 re-included → liabilities.changed (23.1)
  const t = await h.run("notifyTolerance", { dti_after_id: w.dti_id, dti_before_id: v.dti_id, trigger: "closing moved to 2026-10-26: 11 payments remaining" }); assert.equal(t.result, "within_tolerance"); assert.equal(t.delta_bps, 260);
});

test("22.5-T9: (IRS installment agreement) Given an approved agreement at $300.00/month with payment evidence and no lien indicated in Franklin County, when evaluated, then included with `payment_basis = irs_agreement` and `dti_bps = 4,910` on the purchase fixture; given only the pending application, then the same inclusion; given a Notice of Federal Tax Lien in the county, then `FNMA_B3_6_05_IRS_AGREEMENT_GATE` routes to 24.4 and the loan cannot finalize until the lien is paid or subordinated.", async () => {
  const approved = { irs_agreement_status: "approved", irs_agreement_document_id: "DOC-irs-433d", irs_agreement_payment_cents: "30000", irs_payment_evidence_document_id: "DOC-irs-receipts" };
  const h = harness(OCT19, APP_P); await seedPurchase(h);
  const b = await h.declare("L-irs", { liability_type: "irs_installment", creditor_name: "IRS ($14,400.00 owed)", borrower_ids: [B], balance_cents: "1440000", source: "borrower_disclosure", tax_lien_indicated: false }, approved);
  assert.equal(b.payment_basis, "irs_agreement"); assert.equal(b.qualifying_payment_cents, 30_000n); assert.equal(b.condition, null);
  const g = h.timer("FNMA_B3_6_05_IRS_AGREEMENT_GATE")!; assert.equal(g.status, "armed"); assert.match(g.note ?? "", /evaluator:22.5.irsAgreementGate/);   // armed by liability.declared{liability_type=irs_installment}
  const facts = { agreement_status: "approved", agreement_document_id: "DOC-irs-433d", payment_evidence_document_id: "DOC-irs-receipts", tax_lien_indicated: false, include_in_dti: true, payment_basis: "irs_agreement" };
  assert.equal(evaluateGate("22.5.irsAgreementGate", facts).open, true); assert.equal(evaluateGate("22.5.irsAgreementGate", { ...facts, payment_evidence_document_id: null }).open, false); assert.equal(evaluateGate("22.5.irsAgreementGate", { ...facts, include_in_dti: false }).open, false);
  const inc = await h.run("evaluateExclusion", { op: "include", liability_id: "L-irs" }); assert.equal(inc.payment_basis, "irs_agreement"); assert.equal(inc.event, "liability.included");
  assert.equal(h.timer("FNMA_B3_6_05_IRS_AGREEMENT_GATE")!.status, "satisfied");   // liability.included{payment_basis=irs_agreement}
  const d = await h.run("computeDti", { stage: "decision_of_record" }); assert.equal(d.obligations_cents, 402_581n); assert.equal(d.dti_bps, 4910); assert.equal(d.dti_display_pct, "49.10"); assert.equal(d.du_cap_ok, true);   // 372,581 + 30,000 → 49.10 % ≤ 50.00 %
  // pending application: identical treatment
  const h2 = harness(OCT19, APP_P); await seedPurchase(h2);
  const p = await h2.declare("L-irs", { liability_type: "irs_installment", creditor_name: "IRS", borrower_ids: [B], balance_cents: "1440000", source: "borrower_disclosure" }, { irs_agreement_status: "pending", irs_agreement_document_id: "DOC-irs-9465", irs_agreement_payment_cents: "30000" });
  assert.equal(p.payment_basis, "irs_agreement"); assert.equal(p.qualifying_payment_cents, 30_000n);
  assert.equal(irsAgreementGate({ agreement_status: "pending", agreement_document_id: "DOC-irs-9465", tax_lien_indicated: false, include_in_dti: true, payment_basis: "irs_agreement" }).open, true);
  await h2.run("evaluateExclusion", { op: "include", liability_id: "L-irs" }); const d2 = await h2.run("computeDti", { stage: "decision_of_record" }); assert.equal(d2.dti_bps, 4910);
  assert.equal(selectPaymentBasis({ liability_type: "irs_installment", balance_cents: 1_440_000n, reported_payment_cents: null }, { irs_paid_in_full: true }).qualifying_payment_cents, 0n);   // paid in full → nothing to include
  // a Notice of Federal Tax Lien in Franklin County: the gate routes to 24.4 and the liabilities cannot finalize
  const h3 = harness(OCT19, APP_P); await seedPurchase(h3);
  await h3.declare("L-irs", { liability_type: "irs_installment", creditor_name: "IRS", borrower_ids: [B], balance_cents: "1440000", source: "borrower_disclosure", tax_lien_indicated: true }, approved);
  const lien = irsAgreementGate({ ...facts, tax_lien_indicated: true }); assert.equal(lien.open, false); assert.match(lien.reason ?? "", /Notice of Federal Tax Lien .* 24\.4 .*paid or subordinated/);
  await h3.refused(h3.run("evaluateExclusion", { op: "include", liability_id: "L-irs" }), "TAX_LIEN_ROUTES_TO_24_4");
  const d3 = await h3.run("computeDti", { stage: "final" }); assert.equal(d3.dti_bps, 4910);   // the payment stays in DTI (declared included) — the file just cannot finalize
  await h3.refused(h3.run("finalizeLiabilities", { dti_id: d3.dti_id, cd_final_pi_cents: "257034", du_final_liability_ids: d3.liability_ids as string[], irs_facts: { agreement_status: "approved", agreement_document_id: "DOC-irs-433d", payment_evidence_document_id: "DOC-irs-receipts" } }), "FNMA_B3_6_05_IRS_AGREEMENT_GATE");
  assert.equal(h3.timer("FNMA_B3_6_05_IRS_AGREEMENT_GATE")!.status, "armed");
});

test("22.5-T10: (HELOC and revolving 5%) Given a HELOC with a $12,000.00 balance and an interest-only payment of $74.00 on the statement, then 7,400 included; given a HELOC with no required payment, then 0 and no imputed payment; given a card with $3,000.00 and no reported minimum, then 15,000.", async () => {
  const io = selectPaymentBasis({ liability_type: "heloc", balance_cents: 1_200_000n, reported_payment_cents: null }, { heloc_required_payment_cents: 7_400n });
  assert.equal(io.qualifying_payment_cents, 7_400n); assert.equal(io.payment_basis, "heloc_required_payment");
  const none = selectPaymentBasis({ liability_type: "heloc", balance_cents: 1_200_000n, reported_payment_cents: null });
  assert.equal(none.qualifying_payment_cents, 0n); assert.equal(none.payment_basis, "none"); assert.match(none.rationale, /no equivalent payment developed/);
  const heloc = { ...blank("L-heloc", "heloc", "Home Equity Bank", 1_200_000n), qualifying_payment_cents: 0n };
  const ex = evaluateExclusion(heloc, "heloc_no_payment"); assert.equal(ex.include_in_dti, false); assert.equal(ex.exclusion_reason, "heloc_no_payment");
  assert.equal(evaluateExclusion({ ...heloc, qualifying_payment_cents: 7_400n, payment_basis: "heloc_required_payment" }, "heloc_no_payment").include_in_dti, true);
  const card = selectPaymentBasis({ liability_type: "revolving", balance_cents: 300_000n, reported_payment_cents: null });
  assert.equal(card.qualifying_payment_cents, 15_000n); assert.equal(card.payment_basis, "revolving_5pct"); assert.equal(revolving5pct(300_000n), 15_000n); assert.equal(revolving5pct(123_450n), 6_173n);   // round_half_up(123,450 × 5 / 100) = 6,172.5 → 6,173
  assert.equal(selectPaymentBasis({ liability_type: "revolving", balance_cents: 300_000n, reported_payment_cents: null }, { supplemental_statement_payment_cents: 9_000n }).payment_basis, "creditor_statement");   // a statement supporting < 5 %
  // through the bus: the HELOC that requires a payment is included at 7,400; imputing a payment on a zero-payment line is refused
  const h = harness(OCT5); await seedRefi(h);
  const a = await h.declare("L-heloc", { liability_type: "heloc", creditor_name: "Home Equity Bank", balance_cents: "1200000" }, { heloc_required_payment_cents: "7400" });
  assert.equal(a.qualifying_payment_cents, 7_400n); assert.equal(a.payment_basis, "heloc_required_payment");
  const d = await h.run("computeDti", { stage: "pre_cd" }); assert.equal(d.obligations_cents, 463_399n); assert.equal(d.dti_bps, 3862);   // 455,999 + 7,400
  const z = await h.declare("L-heloc0", { liability_type: "heloc", creditor_name: "Zero Payment HELOC", balance_cents: "0" }); assert.equal(z.qualifying_payment_cents, 0n); assert.equal(z.payment_basis, "none");
  await h.refused(h.run("selectPaymentBasis", { liability_id: "L-heloc0", impute_heloc_payment: true }), "NO_HELOC_IMPUTED_PAYMENT");
  const zx = await h.run("evaluateExclusion", { liability_id: "L-heloc0", reason: "heloc_no_payment" }); assert.equal(zx.include_in_dti, false);
  assert.equal((await h.run("computeDti", { stage: "pre_cd" })).obligations_cents, 463_399n);
});

test("22.5-T11: (paid by others / business debt) Given a co-signed auto loan with 12 months' canceled checks from the co-signer and no lates, then excluded; given one 30-day late in the 12 months, then included; given a business loan in the borrower's name with 12 months' company checks but 22.3's cash-flow analysis did not deduct the payment, then included.", async () => {
  const cosigned = { ...blank("L-cosigned", "co_signed", "Auto loan (co-signed for sibling)", 1_500_000n), reported_payment_cents: 42_000n, qualifying_payment_cents: 42_000n, payment_basis: "credit_report" as const };
  const ex = evaluateExclusion(cosigned, "paid_by_other_12m", { evidence_document_ids: ["DOC-checks-12m"], canceled_checks_months: 12, payer_delinquencies_12m: 0 });
  assert.equal(ex.include_in_dti, false); assert.equal(ex.exclusion_reason, "paid_by_other_12m"); assert.deepEqual(ex.liability.exclusion_evidence_document_ids, ["DOC-checks-12m"]);
  const late = evaluateExclusion(cosigned, "paid_by_other_12m", { evidence_document_ids: ["DOC-checks-12m"], canceled_checks_months: 12, payer_delinquencies_12m: 1 });
  assert.equal(late.include_in_dti, true); assert.equal(late.exclusion_reason, null); assert.match(late.why, /1 delinquent payment/);
  assert.throws(() => evaluateExclusion(cosigned, "paid_by_other_12m", { evidence_document_ids: ["DOC-checks-9m"], canceled_checks_months: 9 }), (e: unknown) => e instanceof LiabilityRefused && e.code === "NO_EXCLUSION_WITHOUT_EVIDENCE" && /12 required/.test(e.message));
  assert.throws(() => evaluateExclusion(cosigned, "paid_by_other_12m"), (e: unknown) => e instanceof LiabilityRefused && e.code === "NO_EXCLUSION_WITHOUT_EVIDENCE");
  const business = { ...blank("L-biz", "business_debt_personal_name", "Equipment loan (Desert LLC)", 3_000_000n), reported_payment_cents: 65_000n, qualifying_payment_cents: 65_000n, payment_basis: "credit_report" as const };
  const notDeducted = evaluateExclusion(business, "business_paid_12m_cashflow", { evidence_document_ids: ["DOC-company-checks"], company_checks_months: 12, cash_flow_deducted: false });
  assert.equal(notDeducted.include_in_dti, true); assert.match(notDeducted.why, /cash-flow analysis did not deduct/);
  const deducted = evaluateExclusion(business, "business_paid_12m_cashflow", { evidence_document_ids: ["DOC-company-checks"], company_checks_months: 12, cash_flow_deducted: true });
  assert.equal(deducted.include_in_dti, false); assert.equal(deducted.exclusion_reason, "business_paid_12m_cashflow");
  assert.equal(evaluateExclusion(business, "business_paid_12m_cashflow", { evidence_document_ids: ["DOC-company-checks"], company_checks_months: 12, cash_flow_deducted: true, payer_delinquencies_12m: 1 }).include_in_dti, true);
  // through the bus: the refusal carries the Guide-named evidence; a documented exclusion drops the payment from the next version; non-applicant exclusions need documents
  const h = harness(OCT5); await seedRefi(h);
  await h.declare("L-cosigned", { liability_type: "co_signed", creditor_name: "Auto loan (co-signed)", balance_cents: "1500000", reported_payment_cents: "42000" });
  const r = await h.refused(h.run("evaluateExclusion", { liability_id: "L-cosigned", reason: "paid_by_other_12m", canceled_checks_months: 12 }), "NO_EXCLUSION_WITHOUT_EVIDENCE"); assert.match(r.citation, /12 months' canceled checks/);
  const okx = await h.run("evaluateExclusion", { liability_id: "L-cosigned", reason: "paid_by_other_12m", evidence_document_ids: ["DOC-checks-12m"], canceled_checks_months: 12, payer_delinquencies_12m: 0 }); assert.equal(okx.include_in_dti, false); assert.equal(okx.event, "liability.excluded");
  assert.equal((await h.run("computeDti", { stage: "pre_cd" })).obligations_cents, 455_999n);
  const inc = await h.run("evaluateExclusion", { liability_id: "L-cosigned", reason: "paid_by_other_12m", evidence_document_ids: ["DOC-checks-12m"], canceled_checks_months: 12, payer_delinquencies_12m: 1 }); assert.equal(inc.include_in_dti, true);
  assert.equal((await h.run("computeDti", { stage: "pre_cd" })).obligations_cents, 497_999n);
  await h.declare("L-biz", { liability_type: "business_debt_personal_name", creditor_name: "Equipment loan", balance_cents: "3000000", reported_payment_cents: "65000" });
  const biz = await h.run("evaluateExclusion", { liability_id: "L-biz", reason: "business_paid_12m_cashflow", evidence_document_ids: ["DOC-company-checks"], company_checks_months: 12, cash_flow_deducted: false }); assert.equal(biz.include_in_dti, true);
  await h.refused(h.run("evaluateExclusion", { liability_id: "L-biz", reason: "non_applicant_documented" }), "NO_NON_APPLICANT_EXCLUSION_WITHOUT_DOCS");
});

test("22.5-T12: (final consistency) Given CD-final P&I 340,262 and the final DU submission on Tue Nov 3, 2026, when `dti.computed{final}` runs, then its liability set equals the DU submission's and `FNMA_B3_6_01_LIABILITY_RECALC_GATE` is open; given a new liability discovered Thu Nov 5, then the gate closes until a new final version and 23.1 resubmission complete before Fri Nov 6.", async () => {
  const OCT20 = mst("2026-10-20", "14:00"), NOV3 = mst("2026-11-03", "10:00"), NOV5 = mst("2026-11-05", "09:30"), NOV5PM = mst("2026-11-05", "15:00");
  const h = harness(OCT5); const { qp, dti: v1 } = await seedRefi(h);
  h.upstream("closing.scheduled", { scheduled_note_date: "2026-11-06" }, mst("2026-10-23", "09:00"), { kind: "agent", id: "closing" });
  h.at(OCT20); await h.run("buildLiabilitySet", { op: "ingest_undisclosed", liability_id: "L-newauto", borrower_id: A, creditor_name: "New Auto Lender", monthly_payment_cents: "45000", source: "udm_alert", at: OCT20 });
  const v2 = await h.run("computeDti", { stage: "pre_cd", at: OCT20 }); await h.run("notifyTolerance", { dti_after_id: v2.dti_id, dti_before_id: v1.dti_id, at: OCT20 });
  assert.equal(h.timer("FNMA_B3_6_01_LIABILITY_RECALC_GATE")!.status, "armed"); assert.match(h.timer("FNMA_B3_6_01_LIABILITY_RECALC_GATE")!.note ?? "", /evaluator:22.5.liabilityRecalcGate/);
  // Tue Nov 3: the final version on the CD-final P&I equals the final DU submission's liability set → gate open
  h.at(NOV3); const fin = await h.run("computeDti", { stage: "final", du_submission_id: "DU-FINAL-3", at: NOV3 });
  assert.equal(fin.dti_bps, 4175); assert.deepEqual(fin.liability_ids, ["L-auto", "L-cardA", "L-cardB", "L-newauto"]); assert.equal(qp.pi_cents, 340_262n);
  assert.equal(h.timer("FNMA_B3_6_01_LIABILITY_RECALC_GATE")!.status, "satisfied");   // dti.computed{stage=final}
  const finalFacts = { final_version: { stage: "final", liability_ids: fin.liability_ids, qp_id: fin.qp_id, computed_at: NOV3, pi_cents: "340262" }, current_included_liability_ids: fin.liability_ids, current_qp_id: fin.qp_id, du_final_liability_ids: fin.liability_ids, cd_final_pi_cents: "340262" };
  assert.equal(evaluateGate("22.5.liabilityRecalcGate", finalFacts).open, true);
  assert.equal(liabilityRecalcGate({ ...finalFacts, cd_final_pi_cents: "340263" }).open, false);   // 25.2 CD_PI_MATCH
  assert.equal(liabilityRecalcGate({ ...finalFacts, du_final_liability_ids: ["L-auto", "L-cardA", "L-cardB"] }).open, false);   // 23.1 FNMA_B3_2_10_DU_FINAL_MATCH_GATE
  // Thu Nov 5: a new liability ($500.00) → the final version no longer carries the included set → gate closed; finalize on the stale version refused
  h.at(NOV5); await h.run("buildLiabilitySet", { op: "ingest_undisclosed", liability_id: "L-nov5", borrower_id: B, creditor_name: "Furniture Finance", monthly_payment_cents: "50000", source: "refresh", at: NOV5 });
  const v4 = await h.run("computeDti", { stage: "pre_cd", at: NOV5 }); assert.equal(v4.dti_bps, 4592); assert.equal(v4.du_cap_ok, true);
  const tol = await h.run("notifyTolerance", { dti_after_id: v4.dti_id, dti_before_id: fin.dti_id, trigger: "credit.refresh.received{alerts_open=1}", liability_id: "L-nov5", at: NOV5 });
  assert.equal(tol.result, "resubmission_required"); assert.equal(tol.exceeds_45, true);   // 45.92 % > 45.00 %
  const sla = h.timer("SM_DU_RESUBMIT_SLA_1BD")!; assert.equal(sla.status, "armed"); assert.equal(sla.dueDate, "2026-11-06");   // Thu Nov 5 + 1 business_days_creditor = Fri Nov 6
  const gate = h.timer("FNMA_B3_6_01_LIABILITY_RECALC_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.armedAt, NOV5);
  assert.equal(evaluateGate("22.5.liabilityRecalcGate", { ...finalFacts, current_included_liability_ids: [...(fin.liability_ids as string[]), "L-nov5"], last_change_at: NOV5 }).open, false);
  await h.refused(h.run("finalizeLiabilities", { dti_id: fin.dti_id, cd_final_pi_cents: "340262", du_final_liability_ids: fin.liability_ids as string[], last_change_at: NOV5, at: NOV5 }), "FNMA_B3_6_01_LIABILITY_RECALC_GATE");
  // a new final version reconciled to 23.1's resubmission (Nov 5, before the Fri Nov 6 consummation) reopens the gate, retires the SLA and finalizes the set
  h.at(NOV5PM); const fin2 = await h.run("computeDti", { stage: "final", du_submission_id: "DU-FINAL-4", at: NOV5PM });
  assert.deepEqual(fin2.liability_ids, ["L-auto", "L-cardA", "L-cardB", "L-newauto", "L-nov5"]); assert.equal(fin2.dti_bps, 4592);
  assert.equal(h.timer("FNMA_B3_6_01_LIABILITY_RECALC_GATE")!.status, "satisfied"); assert.equal(h.timer("SM_DU_RESUBMIT_SLA_1BD")!.status, "satisfied"); assert.ok(NOV5PM < mst("2026-11-06", "00:00"));
  const done = await h.run("finalizeLiabilities", { dti_id: fin2.dti_id, cd_final_pi_cents: "340262", du_final_liability_ids: fin2.liability_ids as string[], last_change_at: NOV5, at: NOV5PM });
  assert.equal(done.event, "liabilities.finalized"); assert.equal(done.du_cap_ok, true); assert.equal(h.timer("FNMA_B3_6_02_DU_DTI_50_GATE")!.status, "satisfied");   // liabilities.finalized{du_cap_ok=true}
  const ev = h.ofType("liabilities.finalized")[0]!; assert.equal(ev.payload.pi_cents, "340262"); assert.deepEqual(ev.payload.liability_ids, fin2.liability_ids); assert.ok((ev.payload.consumers as string[]).some((c) => c.startsWith("28.3")));
  assert.equal(h.liability("L-nov5").status, "finalized");
  const dec = await h.run("writeDecision", { action: "finalizeLiabilities", dti_id: fin2.dti_id, rationale: "final version matches DU-FINAL-4 and the CD-final P&I", confidence: 0.98, tolerance_result: "resubmission_required" });
  const rec = dec.record as Record<string, unknown>; assert.equal(rec.dti_bps, 4592); assert.equal(rec.rule_set_version, "fnma.selling.2026-09-02"); assert.equal((rec.liabilities as unknown[]).length, 5); assert.ok(h.decisions.some((x) => x.action === "finalizeLiabilities" && x.ruleSetVersion === "fnma.selling.2026-09-02"));
});

test("22.5 worked figures: R6 refinance and R7 purchase arithmetic in cents (P&I rounding conventions, paydown to qualify, the 23.2 restructure lever, LTV)", () => {
  // R6: $560,000.00 at 6.125 % → $3,402.619 at full precision: $3,402.61 truncated, $3,402.62 half-up (the platform figure; 23.1 and 25.2 use the same)
  const r = Decimal.ratio(6125n, 100_000n).div(Decimal.fromInt(12)), g = Decimal.ONE.add(r).pow(360);
  const exact = Decimal.ratio(56_000_000n, 100n).mul(r).mul(g).div(g.sub(Decimal.ONE));   // $560,000 × 0.0051041667 ÷ (1 − 1.0051041667^−360)
  assert.equal(exact.toCents("DOWN"), 340_261n); assert.equal(exact.toCents("HALF_UP"), 340_262n); assert.equal(exact.toFixed(3), "3402.619");
  assert.equal(piCents(56_000_000n, 6125, 360), 340_262n); assert.equal(formatCents(340_262n), "$3,402.62");
  // 23.1's fixture convention ($3,402.63) totals $4,560.00 = 340,263 + 50,000 + 12,000 + 53,737 = 456,000; the rounded DTI is identical (38.00 %)
  assert.equal(340_263n + 50_000n + 12_000n + 53_737n, 456_000n); assert.equal(formatCents(456_000n), "$4,560.00"); assert.equal(dtiBps(456_000n, 1_200_000n), 3800); assert.equal(dtiBps(455_999n, 1_200_000n), 3800);
  // R6 liabilities: auto balance $8,100.00, payment 31,237, 26 remaining; Variant C paydown to 10 × 31,237 = 312,370 → 810,000 − 312,370 = 497,630 ($4,976.30) in addition; DTI without the auto payment 3,540
  assert.equal(paydownTarget(31_237n), 312_370n);
  assert.equal(payoffAmount({ liability_type: "installment", balance_cents: 810_000n, qualifying_payment_cents: 31_237n }, "pay_down_to_le_10"), 497_630n); assert.equal(formatCents(497_630n), "$4,976.30");
  assert.equal(dtiBps(455_999n - 31_237n, 1_200_000n), 3540);
  // R7 purchase: $412,000.00 at 6.375 % → 257,034 (never the 2-1 year-1 $2,057.06 = 205,706); price $457,800.00 → LTV 90.00 %; T&I 61,500 = 23.2's $615.00; student loan $24,000.00 → 1 % = 24,000 vs amortizing 27,288
  assert.equal(piCents(41_200_000n, 6375, 360), 257_034n); assert.equal(piCents(41_200_000n, 4375, 360), 205_706n); assert.equal(formatCents(205_706n), "$2,057.06");
  assert.equal(divRound(41_200_000n * 10_000n, 45_780_000n, "HALF_UP"), 9000n); assert.equal(formatCents(45_780_000n), "$457,800.00"); assert.equal(formatCents(41_200_000n), "$412,000.00"); assert.equal(formatCents(56_000_000n), "$560,000.00");
  assert.equal(50_000n + 11_500n, 61_500n); assert.equal(formatCents(61_500n), "$615.00");
  assert.equal(student1pct(2_400_000n), 24_000n); assert.equal(formatCents(2_400_000n), "$24,000.00"); assert.equal(amortizingPayment(2_400_000n, 6530, 120), 27_288n);
  const purchaseQp = computeQualifyingPayment({ application_id: APP_P, version: 1, property_role: "subject_primary", loan_amount_cents: 41_200_000n, note_rate_bps: 6375, term_months: 360, product: "fixed", mi_cents: 13_047n, taxes_cents: 50_000n, hazard_cents: 11_500n });
  assert.equal(purchaseQp.pitia_cents, 331_581n); assert.equal(dtiBps(331_581n + 41_000n, 820_000n), 4544);
  // R7 variants: IDR $0 → 4,251; card $1,180.00 paid at closing → 368,081 → 4,489; IRS 30,000 → 402,581 → 4,910; child support 13 remaining → 432,581 → 5,275 (fails DU's 50 %)
  assert.equal(dtiBps(372_581n - 24_000n, 820_000n), 4251); assert.equal(formatCents(118_000n), "$1,180.00"); assert.equal(dtiBps(372_581n - 4_500n, 820_000n), 4489); assert.equal(dtiBps(372_581n + 30_000n, 820_000n), 4910); assert.equal(dtiBps(372_581n + 60_000n, 820_000n), 5275);
  // 23.2's $360,000.00 lever: at 6.375 % the P&I falls to 224,593 and even with the 13-payment child support the DTI is back under DU's ceiling
  const lever = computeQualifyingPayment({ application_id: APP_P, version: 2, property_role: "subject_primary", loan_amount_cents: 36_000_000n, note_rate_bps: 6375, term_months: 360, product: "fixed", mi_cents: 13_047n, taxes_cents: 50_000n, hazard_cents: 11_500n });
  assert.equal(lever.pi_cents, 224_593n); assert.equal(formatCents(36_000_000n), "$360,000.00");
  const restructured = dtiBps(lever.pitia_cents + 41_000n + 60_000n, 820_000n); assert.ok(restructured <= DU_MAX_DTI_BPS); assert.equal(restructured, 4880);
  // the tolerance cross-check between the two calculators on the R6 move (38.00 → 41.75; 380 → 417 tenths)
  const before = computeDti({ application_id: APP, version: 1, stage: "application", qualifying_income_cents: 1_200_000n, qp: refiQp(), liabilities: refiLiabilities() });
  const after = computeDti({ application_id: APP, version: 2, stage: "pre_cd", qualifying_income_cents: 1_200_000n, qp: refiQp(), liabilities: [...refiLiabilities(), { ...blank("L-newauto", "installment", "New Auto Lender", 2_400_000n), qualifying_payment_cents: 45_000n, payment_basis: "credit_report" }] });
  const t = toleranceResult(before, after); assert.equal(t.delta_bps, 375); assert.equal(t.check_23_1.increase_tenths, 37); assert.equal(t.result, "resubmission_required");
  const d = declareLiability(new MemoryEventStore(new FixedClock(OCT5)), { application_id: APP, borrower_ids: [A], liability_type: "installment", creditor_name: "Desert Auto Finance", source: "credit_report", balance_cents: 810_000n, reported_payment_cents: 31_237n, remaining_months: 26 }, OCT5);
  assert.equal(d.event.type, "liability.declared"); assert.equal(formatCents(d.liability.balance_cents), "$8,100.00");
});
