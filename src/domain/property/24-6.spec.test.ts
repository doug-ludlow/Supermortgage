// 24.6 Mortgage insurance ordering, coverage selection, MI types (BPMI/LPMI/single/split), delegated approval, certificate activation, and HPA/MI disclosures
// spec/sections/24-property-valuation-eligibility-title-hazard-flood-insurance/24-6-mortgage-insurance-ordering-coverage-selection-mi-types-bpmi.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_24_6 } from "../../app/tools/section24-6.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { buildRegistry } from "../../notices/catalog.ts";
import { HPA_4903_INITIAL_FIXED_SOURCE } from "../../notices/authored/section24-6.ts";
import { computeLtvRounded, roundLtv, lookupCoverage, lookupMinCoverageLlpa, monthlyPremiumCents, upfrontPremiumCents, priceQuote, compareMiPlans, financedSinglePremiumPlan, hpaCovered, buildInitialAmortizationSchedule, computeHpaDates, projectedPaymentsMi, receiveQuotes, selectPlan, submitOrder, parseCommitment, receiveCommitment, verifyCertificateMatchesTerms, recordTermsVerified, revalue, renderHpaDisclosure, deliverHpaDisclosure, renderLpmiDisclosure, requestActivation, confirmActivation, seedMiPolicy, hpaInitialDisclosureGate, lpmiDisclosureGate, miActiveBeforeDeliveryGate, evaluateGates, gateFactsOf, activationDeadline, isApprovedInsurer, MiRefused, LOAN_LIMIT_2026_1_UNIT_CENTS,
  type MiCertificate, type MiQuote, type QuoteInput, type LtvComputation, type CoverageLookup, type HpaDisclosure } from "./ops-24-6.ts";
import { lpmiOptionsNoticeDue } from "../pmi/termination.ts";

const AGENT: Actor = { kind: "agent", id: "title-closing" };
const APP = "app-cmh-purchase";
const PARTIES = { partner_name: "Partner Bank, N.A.", borrower_name: "Jordan Borrower", property_address: "1420 Neil Ave, Columbus, OH 43201" };

/** 24.6 ops over a fresh event store, the overridden timer registry (24.6 rows only) and the escalation service; the bus runs the 24.6 tools for the role / guardrail checks. */
function harness(nowIso: string, applicationId: string = APP) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["24.6"] });
  const ledger = new MemoryLedger(); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_24_6); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("24.6", name))!, actor, { application_id: applicationId, ...input }, uow)).output as Record<string, unknown>;
  const timer = (code: string) => timers.byCode(code).at(-1);
  const at = (iso: string) => clock.set(iso);
  return { clock, events, timers, ledger, decisions, rt, run, timer, at, uow };
}

// Purchase fixture (Columbus, OH; HomeReady-eligible; application Mon Oct 19, closing Wed Nov 18, 2026; first payment Fri Jan 1, 2027).
const LOAN = 41_200_000n, PRICE = 45_780_000n, APPRAISED = 46_000_000n, ORIGINAL_VALUE = 45_780_000n;
const FIXED30 = { product: "fixed" as const, term_months: 360, homeready: true };
const quoteInput = (mi_company_code: string, plan: QuoteInput["plan"], coverage_pct: number, coverage_option: QuoteInput["coverage_option"], rate_bps: number, extra: Partial<QuoteInput> = {}): QuoteInput => ({ mi_company_code, plan, coverage_pct, coverage_option, rate_bps, quoted_at: "2026-10-21T15:00:00.000Z", expires_at: "2027-01-19T23:59:59.000Z", ...extra });
const fixtureLtv = (): LtvComputation => computeLtvRounded({ loan_amount_cents: LOAN, transaction_type: "purchase", sales_price_cents: PRICE, appraised_value_cents: APPRAISED });
const fixtureCoverage = (option: "standard" | "minimum" = "standard"): CoverageLookup => lookupCoverage({ ltv_pct_rounded: 90, ...FIXED30, coverage_option: option });
/** Quote → plan → delegated order → commitment: the certificate the closing-side tests start from. */
function committedCertificate(h: ReturnType<typeof harness>, o: { plan?: QuoteInput["plan"]; rate_bps?: number; units?: number; occupancy?: "primary" | "second_home" | "investment"; coverage_pct?: number; expires_at?: string } = {}): { certificate: MiCertificate; quote: MiQuote } {
  const plan = o.plan ?? "bpmi_monthly";
  const q = receiveQuotes(h.events, { application_id: APP, loan_amount_cents: LOAN, quotes: [quoteInput("06", plan, o.coverage_pct ?? 25, "standard", o.rate_bps ?? 38), quoteInput("33", plan, o.coverage_pct ?? 25, "standard", (o.rate_bps ?? 38) + 2)] }, "2026-10-21T15:00:00.000Z");
  const sel = selectPlan(h.events, { application_id: APP, quote: q.quotes[0]!, election: { by: "borrower", recorded_at: "2026-10-22T14:00:00.000Z" }, ltv: fixtureLtv(), coverage: fixtureCoverage(), units: o.units ?? 1, occupancy: o.occupancy ?? "primary", transaction_type: "purchase" }, "2026-10-22T14:00:00.000Z");
  const ord = submitOrder(h.events, sel.certificate, { order_type: "delegated", du_reliance: true, du_casefile_id: "DU-1234567890", du_recommendation: "Approve/Eligible" }, "2026-10-26T16:00:00.000Z");
  const com = receiveCommitment(h.events, ord.certificate, parseCommitment({ decision: "commitment", commitment_number: "MGIC-C-77812", certificate_number: "MGIC-0042-9981", coverage_pct: o.coverage_pct ?? 25, premium_plan: plan, rate_bps: o.rate_bps ?? 38, renewal_type: "constant", refundable: false, issued_at: "2026-10-27T13:00:00.000Z", expires_at: o.expires_at ?? "2027-02-24T23:59:59.000Z", insurer_code: "06", master_policy_version: "MGIC 2020 master policy" }), "2026-10-27T13:00:00.000Z");
  return { certificate: com.certificate, quote: q.quotes[0]! };
}
const FINAL_TERMS = { loan_amount_cents: LOAN, value_basis_cents: PRICE, ...FIXED30, note_date: D("2026-11-18") };
const initialSchedule = (note = LOAN) => buildInitialAmortizationSchedule({ note_amount_cents: note, note_rate_pct: "6.375", term_months: 360, first_payment_due: D("2027-01-01") });
const fixtureDates = () => { const s = initialSchedule(); return { schedule: s, dates: computeHpaDates({ schedule: s.schedule, original_value_cents: ORIGINAL_VALUE, term_months: 360, first_payment_due: D("2027-01-01") }) }; };

test("24.6-T1: Given loan $412,000, sales price $457,800, appraised $460,000, when the LTV is computed, then `ltv_raw=0.899956…`, `ltv_pct_rounded=90`, band 85.01–90%, 30-year fixed → `coverage_required_pct=25`; given sales price $457,700, then raw 90.0153 → trunc 90.01 → rounded 91 → 30%.", async () => {
  const ltv = fixtureLtv();
  assert.equal(ltv.value_basis_cents, 45_780_000n, "value basis = lower of $457,800.00 sales price and $460,000.00 appraisal");
  assert.equal(ltv.ltv_raw, "0.899956"); assert.equal(ltv.ltv_trunc2, "89.99"); assert.equal(ltv.ltv_bps, 8999);
  assert.equal(ltv.ltv_pct_rounded, 90); assert.equal(ltv.band, "85.01-90.00"); assert.equal(ltv.mi_required, true);
  const cov = lookupCoverage({ ltv_pct_rounded: ltv.ltv_pct_rounded, product: "fixed", term_months: 360, homeready: false });
  assert.equal(cov.row, "fixed_gt_20_or_arm"); assert.equal(cov.coverage_required_pct, 25); assert.equal(cov.standard_pct, 25); assert.equal(cov.minimum_pct, 12);
  // Sales price $457,700: 412,000 ÷ 457,700 = 0.900153… → 90.01 → 91% → 30%.
  const low = computeLtvRounded({ loan_amount_cents: LOAN, transaction_type: "purchase", sales_price_cents: 45_770_000n, appraised_value_cents: APPRAISED });
  assert.equal(low.ltv_raw, "0.900152", "412,000 ÷ 457,700 = 0.9001529… (the spec's 90.0153 rounds the sixth place; truncation → 90.01 either way)"); assert.equal(low.ltv_trunc2, "90.01"); assert.equal(low.ltv_pct_rounded, 91); assert.equal(low.band, "90.01-95.00");
  assert.equal(lookupCoverage({ ltv_pct_rounded: 91, product: "fixed", term_months: 360, homeready: false }).coverage_required_pct, 30);
  // B2-1.2-01's own examples: 94.01% → 95%; 80.001% → 80% (no MI).
  assert.equal(roundLtv(9_401n, 10_000n).ltv_pct_rounded, 95); assert.equal(roundLtv(80_001n, 100_000n).ltv_pct_rounded, 80);
  assert.equal(computeLtvRounded({ loan_amount_cents: 80_001n, transaction_type: "purchase", sales_price_cents: 100_000n, appraised_value_cents: 100_000n }).mi_required, false);
  // The same arithmetic on the bus.
  const h = harness("2026-10-21T15:00:00.000Z");
  const out = await h.run("computeLtvRounded", { loan_amount_cents: LOAN, transaction_type: "purchase", sales_price_cents: PRICE, appraised_value_cents: APPRAISED });
  assert.equal(out.ltv_pct_rounded, 90); assert.equal(out.value_basis_cents, 45_780_000n);
  assert.equal((await h.run("lookupCoverage", { ltv_pct_rounded: 90, product: "fixed", term_months: 360 })).coverage_required_pct, 25);
});

test("24.6-T2: Given the same loan with HomeReady at 96% LTV, then coverage 25% (not 35%); given non-HomeReady, then 35%.", () => {
  const hr = lookupCoverage({ ltv_pct_rounded: 96, product: "fixed", term_months: 360, homeready: true });
  assert.equal(hr.band, "95.01-97.00"); assert.equal(hr.row, "homeready_fixed_gt_20_or_arm"); assert.equal(hr.coverage_required_pct, 25); assert.equal(hr.minimum_pct, 18);
  const std = lookupCoverage({ ltv_pct_rounded: 96, product: "fixed", term_months: 360, homeready: false });
  assert.equal(std.row, "fixed_gt_20_or_arm"); assert.equal(std.coverage_required_pct, 35);
  // The HomeReady cap holds at 90.01–95% too (25% vs 30%) and for the ≤ 20-year row (25% vs 35% at 95.01–97%).
  assert.equal(lookupCoverage({ ltv_pct_rounded: 93, product: "fixed", term_months: 360, homeready: true }).coverage_required_pct, 25);
  assert.equal(lookupCoverage({ ltv_pct_rounded: 93, product: "fixed", term_months: 360, homeready: false }).coverage_required_pct, 30);
  assert.equal(lookupCoverage({ ltv_pct_rounded: 96, product: "fixed", term_months: 180, homeready: true }).coverage_required_pct, 25);
  assert.equal(lookupCoverage({ ltv_pct_rounded: 96, product: "fixed", term_months: 180, homeready: false }).coverage_required_pct, 35);
  // Edge case: HomeReady lost (income > 80% AMI) → 25% rises to 35%; ARMs use the > 20-year row; standard MH at 95.01–97% is not applicable.
  assert.equal(lookupCoverage({ ltv_pct_rounded: 96, product: "arm", term_months: 360, homeready: false }).coverage_required_pct, 35);
  assert.equal(lookupCoverage({ ltv_pct_rounded: 96, product: "fixed", term_months: 360, homeready: false, standard_mh: true }).not_applicable, true);
});

test("24.6-T3: Given the minimum-coverage election with Classic FICO 752 at 90% LTV, then `coverage_pct=12`, `llpa_min_coverage_bps=37.5` ($1,545.00 on $412,000) passed to pricing and recorded in the decision; given VantageScore 4.0 752, then the VantageScore grid row 740–759 applies (0.625% at 85.01–90% — verified 2026-09-11 against the 09.09.2026 matrix).", async () => {
  const cov = fixtureCoverage("minimum");
  assert.equal(cov.coverage_option, "minimum"); assert.equal(cov.coverage_required_pct, 12); assert.equal(cov.standard_pct, 25);
  const llpa = lookupMinCoverageLlpa({ score_model: "classic_fico", representative_score: 752, ltv_pct_rounded: 90, loan_amount_cents: LOAN });
  assert.equal(llpa.row_label, "≥ 740"); assert.equal(llpa.llpa_pct, "0.375"); assert.equal(llpa.llpa_bps, 37.5); assert.equal(llpa.llpa_cents, 154_500n, "$1,545.00 = 412,000 × 0.375%"); assert.equal(llpa.rule_set_version, "fnma.llpa.2026-09-09");
  const vs = lookupMinCoverageLlpa({ score_model: "vantagescore_4", representative_score: 752, ltv_pct_rounded: 90, loan_amount_cents: LOAN });
  assert.equal(vs.grid, "vantagescore_4"); assert.equal(vs.row_label, "740–759"); assert.equal(vs.llpa_pct, "0.625"); assert.equal(vs.llpa_bps, 62.5); assert.equal(vs.llpa_cents, 257_500n);
  // Band edges: exactly 740 (Classic) / 760 (VS 4.0) fall in the top band; 739 / 759 in the next.
  assert.equal(lookupMinCoverageLlpa({ score_model: "classic_fico", representative_score: 740, ltv_pct_rounded: 90, loan_amount_cents: LOAN }).llpa_pct, "0.375");
  assert.equal(lookupMinCoverageLlpa({ score_model: "classic_fico", representative_score: 739, ltv_pct_rounded: 90, loan_amount_cents: LOAN }).llpa_pct, "0.625");
  assert.equal(lookupMinCoverageLlpa({ score_model: "vantagescore_4", representative_score: 760, ltv_pct_rounded: 90, loan_amount_cents: LOAN }).llpa_pct, "0.375");
  assert.equal(lookupMinCoverageLlpa({ score_model: "classic_fico", representative_score: 610, ltv_pct_rounded: 97, loan_amount_cents: LOAN }).llpa_pct, "3.000");
  // The election on the bus: the minimum option needs the recorded election and the score model; the LLPA is recorded on the certificate and in the decision.
  const h = harness("2026-10-22T14:00:00.000Z");
  await h.run("requestMiQuotes", { loan_amount_cents: LOAN, quotes: [quoteInput("06", "bpmi_monthly", 25, "standard", 38), quoteInput("06", "bpmi_monthly", 12, "minimum", 30, { quote_id: "q-min" }), quoteInput("33", "bpmi_monthly", 25, "standard", 40)] });
  await assert.rejects(h.run("recordPlanElection", { quote_id: "q-min", coverage_option: "minimum", loan_amount_cents: LOAN, sales_price_cents: PRICE, appraised_value_cents: APPRAISED, transaction_type: "purchase", ...FIXED30, units: 1, occupancy: "primary" }), (e: Error) => e instanceof CommandRefused && e.code === "MIN_COVERAGE_NEEDS_ELECTION_AND_LLPA");
  const elected = await h.run("recordPlanElection", { quote_id: "q-min", coverage_option: "minimum", election: { by: "borrower", recorded_at: "2026-10-22T14:00:00.000Z" }, score_model: "classic_fico", representative_score: 752, loan_amount_cents: LOAN, sales_price_cents: PRICE, appraised_value_cents: APPRAISED, transaction_type: "purchase", ...FIXED30, units: 1, occupancy: "primary" });
  const cert = elected.certificate as MiCertificate;
  assert.equal(cert.coverage_pct, 12); assert.equal(cert.coverage_option, "minimum"); assert.equal(cert.llpa_min_coverage_bps, 37.5); assert.equal(cert.monthly_premium_cents, 10_300n);
  assert.equal(h.events.ofType("mi.plan.selected").at(-1)!.payload.llpa_min_coverage_bps, 37.5);
  const d = await h.run("writeDecision", { loan_amount_cents: LOAN, sales_price_cents: PRICE, appraised_value_cents: APPRAISED, transaction_type: "purchase", ...FIXED30, score_model: "classic_fico", representative_score: 752 });
  assert.equal(d.llpa_bps, 37.5); assert.equal(d.coverage_option, "minimum"); assert.equal(d.coverage_required_pct, 12); assert.match(String(d.rationale), /LLPA 0\.375% \(classic_fico ≥ 740\)/);
  assert.equal(h.decisions.find((x) => x.action === "24.6.mortgage_insurance")!.ruleSetVersion, "fnma.selling.2026-09-02+fnma.llpa.2026-09-09+fnma.limits.2026");
});

test("24.6-T4: Given monthly BPMI at 0.38%, when the premium is computed, then `monthly_premium_cents=13047`; the LE projected-payments table shows $130.47 through the column containing payment 108 and a MI-free column from payment 109.", () => {
  assert.equal(monthlyPremiumCents(LOAN, 38), 13_047n, "round_half_up(41,200,000 × 38 ÷ 10000 ÷ 12) = 13,046.67 → $130.47");
  const q = priceQuote(APP, LOAN, quoteInput("06", "bpmi_monthly", 25, "standard", 38));
  assert.equal(q.monthly_premium_cents, 13_047n); assert.equal(q.upfront_premium_cents, 0n, "Prepaids: Mortgage Insurance Premium (0 months) for a monthly plan");
  const { dates } = fixtureDates();
  assert.equal(dates.termination_payment_n, 108);
  const pp = projectedPaymentsMi({ termination_payment_n: dates.termination_payment_n, monthly_premium_cents: 13_047n, term_months: 360 });
  assert.deepEqual(pp.columns, [{ from_payment: 1, to_payment: 108, mi_cents: 13_047n }, { from_payment: 109, to_payment: 360, mi_cents: 0n }]);
  assert.equal(pp.mi_for_payment(1), 13_047n); assert.equal(pp.mi_for_payment(108), 13_047n); assert.equal(pp.mi_for_payment(109), 0n, "§1026.37(c)(1)(i)(C): a new column from payment 109 (year 10) with Mortgage Insurance —/0");
  // Annual plans divide by 12 for the escrow line; the 0.30% minimum-coverage quote is $103.00.
  assert.equal(priceQuote(APP, LOAN, quoteInput("06", "bpmi_annual", 25, "standard", 38)).monthly_premium_cents, 13_047n);
  assert.equal(monthlyPremiumCents(LOAN, 30), 10_300n);
});

test("24.6-T5: Given the initial schedule at 6.375%/360 months and original value $457,800, when HPA dates are computed, then cancellation date Oct 1, 2034 (payment 94, balance $365,633.53), termination date Dec 1, 2035 (payment 108, $356,532.66), midpoint termination Jan 1, 2042; `NTC_HPA_4903_INITIAL_FIXED` embeds the full 360-row schedule and the three dates.", () => {
  const { schedule: s, dates } = fixtureDates();
  assert.equal(s.pi_cents, 257_034n, "P&I $2,570.34 by P × r ÷ (1 − (1+r)^−360)"); assert.equal(s.schedule.rows.length, 360);
  assert.deepEqual({ ...s.schedule.rows[0]! }, { n: 1, due_date: "2027-01-01", payment_cents: 257_034n, interest_cents: 218_875n, principal_cents: 38_159n, upb_after_cents: 41_161_841n });
  assert.equal(dates.threshold_80_cents, 36_624_000n, "80% of $457,800.00 = $366,240.00"); assert.equal(dates.threshold_78_cents, 35_708_400n, "78% = $357,084.00");
  assert.equal(dates.cancellation_date, "2034-10-01"); assert.equal(dates.cancellation_payment_n, 94); assert.equal(dates.cancellation_balance_cents, 36_563_353n);
  assert.equal(dates.termination_date, "2035-12-01"); assert.equal(dates.termination_payment_n, 108); assert.equal(dates.termination_balance_cents, 35_653_266n);
  assert.equal(dates.amortization_start, "2026-12-01"); assert.equal(dates.midpoint_date, "2041-12-01", "payment 180 due Dec 1, 2041"); assert.equal(dates.midpoint_termination_date, "2042-01-01", "first day of the following month (§4902(c))");
  assert.equal(s.schedule.rows[93]!.upb_after_cents > dates.threshold_80_cents === false && s.schedule.rows[92]!.upb_after_cents > dates.threshold_80_cents, true, "payment 94 is the FIRST scheduled balance ≤ 80%");
  assert.equal(s.schedule.rows[106]!.upb_after_cents > dates.threshold_78_cents, true, "payment 107 is still above 78%");
  // The notice embeds the 360-row schedule and the three dates and passes its own checklist.
  const h = harness("2026-11-10T15:00:00.000Z");
  const c0 = committedCertificate(h).certificate;
  const verified = recordTermsVerified(c0, verifyCertificateMatchesTerms(c0, { ...FINAL_TERMS, premium_plan_on_cd: "bpmi_monthly" }), "2026-11-10T15:00:00.000Z", D("2026-11-18"));
  const r = renderHpaDisclosure(h.events, verified, { product: "fixed", initial: s, dates, ...PARTIES, loan_number: "PB-2026-004127" }, "2026-11-10T15:00:00.000Z");
  assert.equal(r.rendered, true); if (!r.rendered) return;
  assert.equal(r.disclosure.kind, "initial_fixed"); assert.equal(r.disclosure.notice_code, "NTC_HPA_4903_INITIAL_FIXED"); assert.equal(r.disclosure.schedule_hash, s.schedule_hash); assert.equal(r.disclosure.schedule_version, "initial");
  assert.equal(r.certificate.status, "docs_ready"); assert.equal(r.certificate.hpa_disclosure_kind, "initial_fixed");
  const rendered = render(HPA_4903_INITIAL_FIXED_SOURCE, r.disclosure.payload);
  assert.equal((rendered.text.match(/Payment \d+ due /g) ?? []).length, 360, "all 360 rows embedded");
  assert.match(rendered.text, /Payment 94 due October 1, 2034: payment \$2,570\.34, interest \$1,945\.75, principal \$624\.59, balance after payment \$365,633\.53/);
  assert.match(rendered.text, /Payment 108 due December 1, 2035: .*balance after payment \$356,532\.66/);
  assert.match(rendered.text, /You may cancel the PMI requirement on October 1, 2034/); assert.match(rendered.text, /will automatically terminate on December 1, 2035/); assert.match(rendered.text, /will end on January 1, 2042/);
  assert.match(rendered.text, /based solely on your actual payments/); assert.match(rendered.text, /No exemption applies to your loan/); assert.match(rendered.text, /good payment history, that you are current on the loan/);
  const version = buildRegistry().versionsOf("NTC_HPA_4903_INITIAL_FIXED")[0]!;
  const check = evaluateChecklist(version, r.disclosure.payload, rendered);
  assert.deepEqual(check.blocking.map((b) => b.rule_id), []); assert.equal(check.passed, true);
  assert.equal(h.events.ofType("hpa.initial_disclosure.rendered").at(-1)!.payload.schedule_rows, 360);
});

test("24.6-T6: Given closing scheduled Wed Nov 18, 2026 with no HPA disclosure rendered, when `HPA_4903_INITIAL_DISCLOSURE_GATE` is evaluated, then `consummate` is refused; rendered and delivered at consummation → satisfied with `disclosures.delivered_at = consummation_at`.", async () => {
  const h = harness("2026-11-10T15:00:00.000Z");
  const { certificate: c0 } = committedCertificate(h);
  h.rt.store.put("mi_certificates", c0.certificate_id, c0 as unknown as Record<string, unknown>, AGENT, h.clock.now());
  // closing.scheduled (26.1) arms the gate as an evaluator-backed timer for the application.
  h.events.append({ type: "closing.scheduled", applicationId: APP, actor: { kind: "agent", id: "closing" }, payload: { application_id: APP, scheduled_on: "2026-11-18", note_date: "2026-11-18" } });
  const gate = h.timer("HPA_4903_INITIAL_DISCLOSURE_GATE"); assert.ok(gate, "gate armed by closing.scheduled"); assert.equal(gate!.status, "armed"); assert.equal(gate!.note, "evaluator:24.6.hpaInitialDisclosureGate");
  // No disclosure rendered → closed → consummate refused.
  const closed = evaluateGate("24.6.hpaInitialDisclosureGate", gateFactsOf(c0)); assert.equal(closed.open, false); assert.match(closed.reason!, /consummate refused: no HPA §4903 initial disclosure rendered/);
  await assert.rejects(h.run("evaluateGates", { op: "consummate", consummation_at: "2026-11-18T19:30:00.000Z" }), (e: Error) => e instanceof MiRefused && e.code === "GATE_CLOSED" && /consummate refused: no HPA §4903 initial disclosure rendered/.test(e.message));
  // Verify the certificate against the final terms, build the schedule from the final note terms, render into the closing package.
  await h.run("verifyCertificateMatchesTerms", { ...FINAL_TERMS, premium_plan_on_cd: "bpmi_monthly" });
  await h.run("buildInitialAmortizationSchedule", { note_amount_cents: LOAN, note_rate_pct: "6.375", term_months: 360, first_payment_due: "2027-01-01" });
  await assert.rejects(h.run("renderHpaDisclosure", { product: "fixed", ...PARTIES, estimated_terms: true }), (e: Error) => e instanceof CommandRefused && e.code === "HPA_SCHEDULE_FINAL_TERMS_ONLY");
  const rendered = await h.run("renderHpaDisclosure", { product: "fixed", ...PARTIES });
  assert.equal(rendered.rendered, true); assert.equal(rendered.variant, "initial_fixed"); assert.equal(rendered.cancellation_date, "2034-10-01"); assert.equal(rendered.status, "docs_ready");
  // Rendered but not yet delivered: still closed against the consummation instant.
  await assert.rejects(h.run("evaluateGates", { op: "consummate", consummation_at: "2026-11-18T19:30:00.000Z" }), (e: Error) => /not delivered at consummation/.test(e.message));
  // Delivered at consummation (Wed Nov 18) → delivered_at = consummation_at → satisfied.
  h.at("2026-11-18T19:30:00.000Z");
  const delivered = await h.run("renderHpaDisclosure", { op: "deliver", consummation_at: "2026-11-18T19:30:00.000Z" });
  assert.equal(delivered.delivered_at, "2026-11-18T19:30:00.000Z");
  const row = h.rt.store.list("hpa_disclosures").at(-1)!.data as unknown as HpaDisclosure; assert.equal(row.delivered_at, "2026-11-18T19:30:00.000Z"); assert.equal(row.kind, "initial_fixed");
  const open = await h.run("evaluateGates", { op: "consummate", consummation_at: "2026-11-18T19:30:00.000Z" }); assert.equal(open.all_open, true);
  assert.equal(h.timer("HPA_4903_INITIAL_DISCLOSURE_GATE")!.status, "satisfied", "hpa.initial_disclosure.delivered satisfies the gate");
  assert.equal(hpaInitialDisclosureGate({ hpa_rendered: true, hpa_disclosure_kind: "initial_fixed", schedule_hash: row.schedule_hash, delivered_at: "2026-11-18T19:30:00.000Z", consummation_at: "2026-11-18T19:30:00.000Z", premium_plan: "bpmi_monthly", hpa_covered: true }).open, true);
  assert.equal(hpaInitialDisclosureGate({ hpa_rendered: true, hpa_disclosure_kind: "initial_fixed", schedule_hash: null, premium_plan: "bpmi_monthly", hpa_covered: true }).open, false, "a fixed-rate disclosure without the schedule is no disclosure");
});

test("24.6-T7: Given a financed single premium of 1.60%, then `note_amount=41,859,200` cents, base LTV 90 → coverage 25%, gross LTV 92 ≤ 97, SFC 281 and MI Financed Indicator set; given a cash-out refinance, then the plan is refused.", async () => {
  assert.equal(upfrontPremiumCents(LOAN, 160), 659_200n, "$6,592.00 = 41,200,000 × 160 ÷ 10000");
  const plan = financedSinglePremiumPlan({ loan_amount_cents: LOAN, rate_bps: 160, value_basis_cents: PRICE, transaction_type: "purchase", ...FIXED30, note_rate_pct: "6.375" });
  assert.equal(plan.financed_premium_cents, 659_200n); assert.equal(plan.note_amount_cents, 41_859_200n, "$418,592.00");
  assert.equal(plan.base_ltv_pct_rounded, 90); assert.equal(plan.coverage_required_pct, 25, "coverage on the base LTV (unchanged)");
  assert.equal(plan.gross_ltv_pct_rounded, 92, "418,592 ÷ 457,800 = 91.4355… → 91.43 → 92%"); assert.equal(plan.max_ltv_pct, 97); assert.equal(plan.eligible, true);
  assert.equal(plan.loan_limit_cents, LOAN_LIMIT_2026_1_UNIT_CENTS); assert.ok(plan.note_amount_cents <= 83_275_000n);
  assert.deepEqual(plan.sfc_codes, ["281"]); assert.equal(plan.mi_financed_indicator, true); assert.equal(plan.financed_mi_amount_cents, 659_200n);
  assert.equal(plan.pi_cents, 261_147n, "P&I rises to $2,611.47 — recomputed by the amortization engine"); assert.equal(plan.prepaids_line, "Mortgage Insurance Premium (360 months)");
  assert.equal(computeLtvRounded({ loan_amount_cents: LOAN, transaction_type: "purchase", sales_price_cents: PRICE, appraised_value_cents: APPRAISED, financed_premium_cents: 659_200n }).gross_ltv_pct_rounded, 92);
  // Cash-out refinance → refused (B7-1-04 loan purposes); over the loan limit / over the Eligibility Matrix maximum → refused.
  assert.throws(() => financedSinglePremiumPlan({ loan_amount_cents: LOAN, rate_bps: 160, value_basis_cents: PRICE, transaction_type: "cash_out", ...FIXED30 }), (e: Error) => e instanceof MiRefused && e.code === "FINANCED_MI_CASH_OUT");
  assert.throws(() => financedSinglePremiumPlan({ loan_amount_cents: 83_000_000n, rate_bps: 160, value_basis_cents: 92_000_000n, transaction_type: "purchase", ...FIXED30 }), (e: Error) => e instanceof MiRefused && e.code === "FINANCED_MI_OVER_LOAN_LIMIT");
  assert.throws(() => financedSinglePremiumPlan({ loan_amount_cents: 44_000_000n, rate_bps: 160, value_basis_cents: PRICE, transaction_type: "purchase", ...FIXED30 }), (e: Error) => e instanceof MiRefused && e.code === "FINANCED_MI_OVER_MAX_LTV");
  // On the bus the guardrail refuses before the handler runs; the financed election carries SFC 281 on the certificate and financed single-premium BPMI keeps the §4903 disclosure.
  const h = harness("2026-10-22T14:00:00.000Z");
  await assert.rejects(h.run("recordPlanElection", { op: "financed", plan: "financed_single", loan_amount_cents: LOAN, rate_bps: 160, value_basis_cents: PRICE, transaction_type: "cash_out", ...FIXED30 }), (e: Error) => e instanceof CommandRefused && e.code === "FINANCED_MI_CASH_OUT");
  const priced = await h.run("recordPlanElection", { op: "financed", plan: "financed_single", loan_amount_cents: LOAN, rate_bps: 160, value_basis_cents: PRICE, transaction_type: "purchase", ...FIXED30 });
  assert.equal(priced.note_amount_cents, 41_859_200n);
  await h.run("requestMiQuotes", { loan_amount_cents: LOAN, quotes: [quoteInput("06", "financed_single", 25, "standard", 160, { quote_id: "q-fin", refundable: true }), quoteInput("33", "financed_single", 25, "standard", 165)] });
  const el = await h.run("recordPlanElection", { quote_id: "q-fin", election: { by: "borrower", recorded_at: "2026-10-22T14:00:00.000Z" }, loan_amount_cents: LOAN, sales_price_cents: PRICE, appraised_value_cents: APPRAISED, transaction_type: "purchase", financed_premium_cents: 659_200n, ...FIXED30, units: 1, occupancy: "primary" });
  const cert = el.certificate as MiCertificate;
  assert.equal(cert.financed_premium_cents, 659_200n); assert.equal(cert.upfront_premium_cents, 0n); assert.equal(cert.gross_ltv_pct_rounded, 92); assert.deepEqual(cert.sfc_codes, ["281"]); assert.equal(cert.hpa_covered, true, "financed single-premium BPMI is still borrower-paid PMI"); assert.equal(cert.refundable, true);
});

test("24.6-T8: Given LPMI selected on Oct 26, 2026, when the conditional approval is prepared, then `HPA_4905C_LPMI_DISCLOSURE_GATE` requires `NTC_HPA_4905_LPMI` delivered before the approval/commitment letter; SFC 019 is set; no §4903 initial disclosure is rendered; `lpmi_equiv_termination_date=2035-12-01` is boarded.", async () => {
  const h = harness("2026-10-26T14:00:00.000Z");
  await h.run("requestMiQuotes", { loan_amount_cents: LOAN, quotes: [quoteInput("06", "lpmi_monthly", 25, "standard", 38, { quote_id: "q-lpmi" }), quoteInput("33", "lpmi_monthly", 25, "standard", 40)] });
  const el = await h.run("recordPlanElection", { quote_id: "q-lpmi", election: { by: "borrower", recorded_at: "2026-10-26T14:00:00.000Z" }, loan_amount_cents: LOAN, sales_price_cents: PRICE, appraised_value_cents: APPRAISED, transaction_type: "purchase", ...FIXED30, units: 1, occupancy: "primary" });
  const cert = el.certificate as MiCertificate;
  assert.equal(cert.premium_plan, "lpmi_monthly"); assert.deepEqual(cert.sfc_codes, ["019"]); assert.equal(cert.hpa_covered, false, "§4905(b): §§4902–4904 do not apply to LPMI");
  // mi.plan.selected{premium_plan=lpmi_monthly} arms the gate; the approval letter is refused until the disclosure is delivered.
  const gate = h.timer("HPA_4905C_LPMI_DISCLOSURE_GATE"); assert.ok(gate, "gate armed by the LPMI election"); assert.equal(gate!.status, "armed");
  assert.equal(evaluateGate("24.6.lpmiDisclosureGate", gateFactsOf(cert)).open, false);
  await assert.rejects(h.run("evaluateGates", { op: "approval_letter" }), (e: Error) => e instanceof MiRefused && e.code === "GATE_CLOSED" && /NTC_HPA_4905_LPMI not delivered/.test(e.message));
  // Delivered Mon Oct 26 with the conditional approval (before any commitment letter) → satisfied; a letter issued before the disclosure is refused.
  const { dates } = fixtureDates();
  assert.throws(() => renderLpmiDisclosure(h.events, cert, { delivered_at: "2026-10-27T10:00:00.000Z", commitment_letter_issued_at: "2026-10-26T18:00:00.000Z", dates, ...PARTIES }), (e: Error) => e instanceof MiRefused && e.code === "LPMI_DISCLOSURE_AFTER_COMMITMENT");
  const d = await h.run("renderLpmiDisclosure", { delivered_at: "2026-10-26T15:00:00.000Z", note_amount_cents: LOAN, note_rate_pct: "6.375", term_months: 360, first_payment_due: "2027-01-01", lpmi_rate_adjustment_pct: "0.250", ...PARTIES });
  assert.equal(d.notice_code, "NTC_HPA_4905_LPMI"); assert.equal(d.delivered_at, "2026-10-26T15:00:00.000Z"); assert.equal(d.lpmi_equiv_termination_date, "2035-12-01"); assert.deepEqual(d.sfc_codes, ["019"]);
  assert.equal(h.timer("HPA_4905C_LPMI_DISCLOSURE_GATE")!.status, "satisfied", "hpa.lpmi_disclosure.delivered satisfies the gate");
  assert.equal((await h.run("evaluateGates", { op: "approval_letter", commitment_letter_issued_at: "2026-10-26T18:00:00.000Z" })).all_open, true);
  assert.equal(lpmiDisclosureGate({ premium_plan: "lpmi_monthly", lpmi_disclosure_delivered_at: "2026-10-27T10:00:00.000Z", commitment_letter_issued_at: "2026-10-26T18:00:00.000Z" }).open, false, "letter before the disclosure → refused");
  // No §4903 initial disclosure for LPMI; the BPMI-equivalent termination date is boarded for 10.x's §4905(c)(2) notice by Dec 31, 2035.
  const committed = receiveCommitment(h.events, submitOrder(h.events, cert, { order_type: "delegated", du_reliance: true, du_casefile_id: "DU-1234567890", du_recommendation: "Approve/Eligible" }, "2026-10-26T16:00:00.000Z").certificate, parseCommitment({ decision: "commitment", commitment_number: "MGIC-C-77900", certificate_number: "MGIC-0042-9990", coverage_pct: 25, premium_plan: "lpmi_monthly", rate_bps: 38, issued_at: "2026-10-27T13:00:00.000Z", expires_at: "2027-02-24T23:59:59.000Z", insurer_code: "06" }), "2026-10-27T13:00:00.000Z").certificate;
  const verified = recordTermsVerified(committed, verifyCertificateMatchesTerms(committed, { ...FINAL_TERMS, premium_plan_on_cd: "lpmi_monthly" }), "2026-11-10T15:00:00.000Z", D("2026-11-18"));
  const s = initialSchedule();
  const none = renderHpaDisclosure(h.events, verified, { product: "fixed", initial: s, dates, ...PARTIES }, "2026-11-10T15:00:00.000Z");
  assert.equal(none.rendered, false); if (none.rendered) return; assert.equal(none.variant, "none_lpmi"); assert.equal(none.event, null);
  assert.equal(h.events.ofType("hpa.initial_disclosure.rendered").length, 0);
  assert.equal(hpaInitialDisclosureGate(gateFactsOf(verified)).open, true, "the §4903 gate does not apply to LPMI");
  const activated = confirmActivation(h.events, requestActivation(h.events, { ...verified, hpa_disclosure_kind: "lpmi_commitment" }, { note_date: D("2026-11-18"), loan_id: "L-cmh-1" }, "2026-11-18T20:00:00.000Z").certificate, { activation_effective_date: D("2026-11-18") }, "2026-11-19T15:00:00.000Z").certificate;
  const seed = seedMiPolicy(activated, { loan_id: "L-cmh-1", dates, term_months: 360, sales_price_cents: PRICE, appraised_value_cents: APPRAISED });
  assert.equal(seed.lpmi_equiv_termination_date, "2035-12-01"); assert.equal(seed.premium_plan, "lpmi_monthly"); assert.deepEqual(seed.sfc_codes, ["019"]); assert.equal(seed.hpa_covered, false); assert.equal(seed.auto_status, "not_applicable_midpoint_only");
  assert.equal(lpmiOptionsNoticeDue(seed.lpmi_equiv_termination_date!), "2035-12-31", "10.x sends NTC_HPA_4905C2_LPMI_OPTIONS by Dec 31, 2035");
});

test("24.6-T9: Given consummation Wed Nov 18, 2026 (Ohio, wet funding), when activation is not confirmed by Thu Nov 19, then `SM_MI_ACTIVATE_1BD` breaches (sev-2); given activation confirmed Nov 19 with effective date Nov 18, then `active` and 29.4's delivery gate passes.", async () => {
  assert.equal(activationDeadline(D("2026-11-18")), "2026-11-19");
  const h = harness("2026-11-10T15:00:00.000Z");
  const c0 = committedCertificate(h).certificate;
  const verified = recordTermsVerified(c0, verifyCertificateMatchesTerms(c0, { ...FINAL_TERMS, premium_plan_on_cd: "bpmi_monthly" }), "2026-11-10T15:00:00.000Z", D("2026-11-18"));
  const { schedule: s, dates } = fixtureDates();
  const ready = renderHpaDisclosure(h.events, verified, { product: "fixed", initial: s, dates, ...PARTIES }, "2026-11-10T15:00:00.000Z").certificate;
  h.rt.store.put("mi_certificates", ready.certificate_id, ready as unknown as Record<string, unknown>, AGENT, h.clock.now());
  // Never before the note date.
  assert.throws(() => requestActivation(h.events, ready, { note_date: D("2026-11-18") }, "2026-11-17T20:00:00.000Z"), (e: Error) => e instanceof MiRefused && e.code === "ACTIVATE_BEFORE_NOTE_DATE");
  // Wed Nov 18: consummation (wet funding — closing.consummated carries the note date) arms SM_MI_ACTIVATE_1BD, due Thu Nov 19 (+1 business_days_creditor).
  h.at("2026-11-18T20:00:00.000Z");
  h.events.append({ type: "closing.consummated", applicationId: APP, actor: { kind: "agent", id: "closing" }, payload: { application_id: APP, note_date: "2026-11-18", consummation_at: "2026-11-18T19:30:00.000Z", funding: "wet", state: "OH" } });
  const t = h.timer("SM_MI_ACTIVATE_1BD"); assert.ok(t, "armed by closing.consummated"); assert.equal(t!.anchorDate, "2026-11-18"); assert.equal(t!.dueDate, "2026-11-19"); assert.equal(t!.status, "armed");
  const req = await h.run("requestActivation", { note_date: "2026-11-18", loan_id: "L-cmh-1" });
  assert.equal(req.status, "activation_requested"); assert.equal(req.confirm_by, "2026-11-19");
  const dg = h.timer("FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE"); assert.ok(dg, "delivery gate armed by mi.activation.requested"); assert.equal(dg!.status, "armed");
  assert.equal(evaluateGate("24.6.miActiveBeforeDeliveryGate", gateFactsOf(h.rt.store.list("mi_certificates").at(-1)!.data as unknown as MiCertificate)).open, false, "29.4's submitDelivery is refused while activation is pending");
  // Branch A: no confirmation by end of Thu Nov 19 → breach sev-2.
  const breaches = h.timers.evaluate("2026-11-20T09:00:00.000Z");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, "SM_MI_ACTIVATE_1BD"); assert.equal(breaches[0]!.severity, 2); assert.equal(breaches[0]!.instance.status, "breached");
  assert.equal(h.events.ofType("timer.breached").at(-1)!.payload.code, "SM_MI_ACTIVATE_1BD");
  // Branch B (fresh clock): confirmation Thu Nov 19 with effective date Nov 18 → active; the delivery gate passes; a wrong effective date is refused.
  const h2 = harness("2026-11-18T20:00:00.000Z");
  h2.rt.store.put("mi_certificates", ready.certificate_id, ready as unknown as Record<string, unknown>, AGENT, h2.clock.now());
  h2.events.append({ type: "closing.consummated", applicationId: APP, actor: { kind: "agent", id: "closing" }, payload: { application_id: APP, note_date: "2026-11-18", consummation_at: "2026-11-18T19:30:00.000Z" } });
  await h2.run("requestActivation", { note_date: "2026-11-18", loan_id: "L-cmh-1" });
  h2.at("2026-11-19T15:00:00.000Z");
  await assert.rejects(h2.run("requestActivation", { op: "confirm", activation_effective_date: "2026-11-19" }), (e: Error) => /ACTIVATION_DATE_NOT_NOTE_DATE/.test(e.message));
  const conf = await h2.run("requestActivation", { op: "confirm", activation_effective_date: "2026-11-18", first_premium_due_date: "2027-01-01" });
  assert.equal(conf.status, "active"); assert.equal(conf.activation_effective_date, "2026-11-18"); assert.equal(conf.certificate_number, "MGIC-0042-9981");
  assert.equal(h2.timer("SM_MI_ACTIVATE_1BD")!.status, "satisfied"); assert.equal(h2.timer("FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE")!.status, "satisfied");
  assert.equal(h2.timers.evaluate("2026-11-20T09:00:00.000Z").length, 0, "no breach when confirmed on Nov 19");
  const active = h2.rt.store.list("mi_certificates").at(-1)!.data as unknown as MiCertificate;
  assert.equal(miActiveBeforeDeliveryGate(gateFactsOf(active)).open, true, "29.4's delivery gate passes");
  assert.equal((await h2.run("evaluateGates", { op: "submit_delivery" })).all_open, true);
  assert.equal(["active", "activation_requested"].includes(active.status) && !!active.certificate_number && !!active.hpa_disclosure_kind, true, "30.2 OB-009 reads status, certificate number, coverage, plan and hpa_disclosure_kind");
  const seed = await h2.run("seedMiPolicy", { loan_id: "L-cmh-1", note_amount_cents: LOAN, note_rate_pct: "6.375", term_months: 360, first_payment_due: "2027-01-01", sales_price_cents: PRICE, appraised_value_cents: APPRAISED });
  assert.equal(seed.scheduled_78_date, "2035-12-01"); assert.equal(seed.midpoint_termination_date, "2042-01-01"); assert.equal(seed.auto_status, "pending"); assert.equal(seed.consummation_date, "2026-11-18"); assert.equal(seed.occupancy_at_origination, "principal");
});

test("24.6-T10: Given an insurer with MI code 12 (United Guaranty) on the July 2025 list, when ordering, then allowed; given an insurer absent from the list, then refused.", async () => {
  assert.equal(isApprovedInsurer("12"), true); assert.equal(isApprovedInsurer("37"), true, "MassHousing (37) is on the July 2025 list too"); assert.equal(isApprovedInsurer("99"), false); assert.equal(isApprovedInsurer("95"), false, "95/97 denote 'MI not required', not an insurer");
  const h = harness("2026-10-22T14:00:00.000Z");
  const q = receiveQuotes(h.events, { application_id: APP, loan_amount_cents: LOAN, quotes: [quoteInput("12", "bpmi_monthly", 25, "standard", 39), quoteInput("06", "bpmi_monthly", 25, "standard", 38)] }, "2026-10-21T15:00:00.000Z");
  assert.deepEqual(q.insurers, ["12", "06"]); assert.equal(q.event.payload.multiple_insurers, true);
  const sel = selectPlan(h.events, { application_id: APP, quote: q.quotes[0]!, election: { by: "borrower", recorded_at: "2026-10-22T14:00:00.000Z" }, ltv: fixtureLtv(), coverage: fixtureCoverage(), units: 1, occupancy: "primary", transaction_type: "purchase" }, "2026-10-22T14:00:00.000Z");
  const ord = submitOrder(h.events, sel.certificate, { order_type: "delegated", du_reliance: true, du_casefile_id: "DU-1234567890", du_recommendation: "Approve/Eligible" }, "2026-10-26T16:00:00.000Z");
  assert.equal(ord.certificate.status, "ordered"); assert.equal(ord.certificate.mi_company_code, "12"); assert.equal(ord.event.type, "mi.ordered"); assert.equal(ord.external_underwriter_followup, null);
  // Absent from the list → refused at the quote, at the order and by the bus guardrail.
  assert.throws(() => receiveQuotes(h.events, { application_id: APP, loan_amount_cents: LOAN, quotes: [quoteInput("99", "bpmi_monthly", 25, "standard", 35)] }, "2026-10-21T15:00:00.000Z"), (e: Error) => e instanceof MiRefused && e.code === "INSURER_NOT_APPROVED");
  assert.throws(() => submitOrder(h.events, { ...sel.certificate, mi_company_code: "99" }, { order_type: "delegated", du_reliance: true, du_casefile_id: "DU-1234567890" }, "2026-10-26T16:00:00.000Z"), (e: Error) => e instanceof MiRefused && e.code === "INSURER_NOT_APPROVED");
  await assert.rejects(h.run("requestMiQuotes", { loan_amount_cents: LOAN, quotes: [quoteInput("99", "bpmi_monthly", 25, "standard", 35)] }), (e: Error) => e instanceof CommandRefused && e.code === "INSURER_NOT_APPROVED");
  await assert.rejects(h.run("submitMiOrder", { order_type: "delegated", mi_company_code: "99" }), (e: Error) => e instanceof CommandRefused && e.code === "INSURER_NOT_APPROVED");
  // A premium must never come from an internal rate table; a withdrawn DU Approve/Eligible invalidates a delegated order; non-delegated orders open the external-underwriter follow-up (2 business_days_creditor).
  await assert.rejects(h.run("requestMiQuotes", { loan_amount_cents: LOAN, use_internal_rate_table: true, quotes: [quoteInput("06", "bpmi_monthly", 25, "standard", 38)] }), (e: Error) => e instanceof CommandRefused && e.code === "PREMIUM_NEVER_FROM_INTERNAL_TABLE");
  assert.throws(() => submitOrder(h.events, sel.certificate, { order_type: "delegated", du_reliance: true, du_casefile_id: "DU-1234567890", du_recommendation: "Refer with Caution" }, "2026-10-26T16:00:00.000Z"), (e: Error) => e instanceof MiRefused && e.code === "DELEGATED_NEEDS_DU_APPROVE_ELIGIBLE");
  const nd = submitOrder(h.events, sel.certificate, { order_type: "non_delegated", du_reliance: false, du_casefile_id: null }, "2026-10-26T16:00:00.000Z");
  assert.deepEqual(nd.external_underwriter_followup, { role: "settlement_agent", sla: "+2 business_days_creditor", due: "2026-10-28" });
});

test("24.6-T11: Given the appraisal comes in at $455,000 after the commitment (price $457,800), then `value_basis=45,500,000`, LTV 90.55 → 91% → coverage 30% → re-quote, revised LE (21.5) and re-order; the old certificate is `cancelled_pre_closing`.", async () => {
  const h = harness("2026-10-29T16:00:00.000Z");
  const { certificate: committed } = committedCertificate(h);
  assert.equal(committed.status, "committed"); assert.equal(committed.coverage_pct, 25); assert.equal(committed.base_ltv_pct_rounded, 90);
  const r = revalue(h.events, committed, { loan_amount_cents: LOAN, sales_price_cents: PRICE, appraised_value_cents: 45_500_000n, transaction_type: "purchase", ...FIXED30 }, "2026-10-29T16:00:00.000Z");
  assert.equal(r.value_basis_cents, 45_500_000n, "lower of $457,800 price and $455,000 appraisal");
  assert.equal(r.ltv.ltv_trunc2, "90.54", "412,000 ÷ 455,000 = 0.905494… → truncated 90.54 (the spec's 90.55 is the unrounded 90.549 rounded)"); assert.equal(r.ltv.ltv_pct_rounded, 91);
  assert.equal(r.old_coverage_required_pct, 25); assert.equal(r.new_coverage_required_pct, 25, "HomeReady caps 90.01–95% at 25% — the fixture is HomeReady-eligible");
  // The spec's 30% is the standard (non-HomeReady) row: 90.01–95% → 30%.
  const std = revalue(h.events, committed, { loan_amount_cents: LOAN, sales_price_cents: PRICE, appraised_value_cents: 45_500_000n, transaction_type: "purchase", product: "fixed", term_months: 360, homeready: false }, "2026-10-29T16:00:00.000Z");
  assert.equal(std.new_coverage_required_pct, 30); assert.equal(std.band_changed, true); assert.equal(std.requote_required, true); assert.equal(std.reorder_required, true);
  assert.deepEqual(std.revised_le, { process: "21.5", basis: "changed_circumstance", reason: "coverage band changed 85.01-90.00 (25%) → 90.01-95.00 (30%)" });
  assert.equal(std.certificate.status, "cancelled_pre_closing"); assert.equal(std.event!.type, "mi.cancelled_pre_closing"); assert.equal(std.event!.payload.new_coverage_pct, 30);
  // The HomeReady branch: same band change 85.01–90 → 90.01–95 → re-quote and re-order as well (band changed), coverage stays 25%.
  assert.equal(r.band_changed, true); assert.equal(r.certificate.status, "cancelled_pre_closing"); assert.equal(r.revised_le!.process, "21.5");
  // No change → nothing to do; a value change that keeps the band → re-quote only.
  const same = revalue(h.events, committed, { loan_amount_cents: LOAN, sales_price_cents: PRICE, appraised_value_cents: APPRAISED, transaction_type: "purchase", ...FIXED30 }, "2026-10-29T16:00:00.000Z");
  assert.equal(same.requote_required, false); assert.equal(same.event, null);
  const within = revalue(h.events, committed, { loan_amount_cents: LOAN, sales_price_cents: PRICE, appraised_value_cents: 45_790_000n, transaction_type: "purchase", ...FIXED30 }, "2026-10-29T16:00:00.000Z");
  assert.equal(within.requote_required, false, "value basis stays the $457,800 sales price → unchanged");
  // On the bus: the re-order after the cancellation starts from a fresh election (the old certificate is no longer live).
  h.rt.store.put("mi_certificates", committed.certificate_id, committed as unknown as Record<string, unknown>, AGENT, h.clock.now());
  const out = await h.run("recordPlanElection", { op: "revalue", loan_amount_cents: LOAN, sales_price_cents: PRICE, appraised_value_cents: 45_500_000n, transaction_type: "purchase", product: "fixed", term_months: 360, homeready: false });
  assert.equal(out.reorder_required, true); assert.equal(out.event, "mi.cancelled_pre_closing");
  assert.equal((h.rt.store.get("mi_certificates", committed.certificate_id)!.data as unknown as MiCertificate).status, "cancelled_pre_closing");
  await assert.rejects(h.run("submitMiOrder", { order_type: "delegated" }), (e: Error) => /MI_STATE/.test(e.message));
});

test("24.6-T12: Given a 2-unit primary residence at 90% LTV, then coverage 25% (standard table), `hpa_covered=false`, the Fannie Mae-only notice variant is rendered and 10.x boards `not_applicable_midpoint_only`.", () => {
  const cov = lookupCoverage({ ltv_pct_rounded: 90, product: "fixed", term_months: 360, homeready: false });
  assert.equal(cov.row, "fixed_gt_20_or_arm", "2–4 unit properties use the standard table (all property types except standard MH)"); assert.equal(cov.coverage_required_pct, 25);
  assert.equal(hpaCovered({ units: 2, occupancy: "primary", premium_plan: "bpmi_monthly" }), false); assert.equal(hpaCovered({ units: 1, occupancy: "second_home", premium_plan: "bpmi_monthly" }), false); assert.equal(hpaCovered({ units: 1, occupancy: "primary", premium_plan: "bpmi_monthly" }), true);
  const h = harness("2026-11-10T15:00:00.000Z");
  const c0 = committedCertificate(h, { units: 2 }).certificate;
  assert.equal(c0.hpa_covered, false); assert.equal(c0.units, 2);
  const verified = recordTermsVerified(c0, verifyCertificateMatchesTerms(c0, { ...FINAL_TERMS, homeready: false, premium_plan_on_cd: "bpmi_monthly" }), "2026-11-10T15:00:00.000Z", D("2026-11-18"));
  const { schedule: s, dates } = fixtureDates();
  const r = renderHpaDisclosure(h.events, verified, { product: "fixed", initial: s, dates, ...PARTIES }, "2026-11-10T15:00:00.000Z");
  assert.equal(r.rendered, false); if (r.rendered) return;
  assert.equal(r.variant, "fnma_only"); assert.match(r.reason, /12 U\.S\.C\. 4901\(15\)/);
  assert.deepEqual(r.fnma_only_payload, { variant: "fnma_only", basis: "Fannie Mae Servicing Guide B-8.1-04", units: 2, occupancy: "primary", midpoint_termination_date: "2042-01-01", scheduled_78_date: "2035-12-01", auto_status: "not_applicable_midpoint_only", section_4903_content: false });
  assert.equal(r.event!.type, "hpa.initial_disclosure.rendered"); assert.equal(r.event!.payload.kind, "fnma_only"); assert.equal(r.certificate.hpa_disclosure_kind, "fnma_only"); assert.equal(r.certificate.status, "docs_ready");
  assert.equal(hpaInitialDisclosureGate(gateFactsOf(r.certificate)).open, true, "no §4903(a) gate for a non-HPA loan");
  const active = confirmActivation(h.events, requestActivation(h.events, r.certificate, { note_date: D("2026-11-18"), loan_id: "L-cmh-2u" }, "2026-11-18T20:00:00.000Z").certificate, { activation_effective_date: D("2026-11-18") }, "2026-11-19T15:00:00.000Z").certificate;
  const seed = seedMiPolicy(active, { loan_id: "L-cmh-2u", dates, term_months: 360 });
  assert.equal(seed.hpa_covered, false); assert.equal(seed.auto_status, "not_applicable_midpoint_only"); assert.equal(seed.units, 2); assert.equal(seed.scheduled_78_date, null); assert.equal(seed.scheduled_80_date, null); assert.equal(seed.midpoint_termination_date, "2042-01-01"); assert.equal(seed.hpa_disclosure_kind, "fnma_only");
});

test("24.6 worked figures: purchase fixture — value basis, LLPA, premiums, break-even, P&I, schedule rows, HPA thresholds and balances, financed premium", () => {
  // Worked example 1: value basis and rounded LTV.
  const ltv = fixtureLtv(); assert.equal(ltv.value_basis_cents, 45_780_000n, "$457,800.00 (lower than the $460,000.00 appraisal)");
  assert.equal(computeLtvRounded({ loan_amount_cents: LOAN, transaction_type: "purchase", sales_price_cents: 46_500_000n, appraised_value_cents: 46_000_000n }).value_basis_cents, 46_000_000n, "$460,000.00 when the appraisal is the lower figure");
  // Minimum-coverage LLPA $1,545.00; illustrative monthly rates 0.38% / 0.30% → $130.47 vs $103.00; the $27.47 saving costs $1,545.00 up front (break-even ≈ 56 months).
  const llpa = lookupMinCoverageLlpa({ score_model: "classic_fico", representative_score: 752, ltv_pct_rounded: 90, loan_amount_cents: LOAN }); assert.equal(llpa.llpa_cents, 154_500n);
  const quotes = [priceQuote(APP, LOAN, quoteInput("06", "bpmi_monthly", 25, "standard", 38)), priceQuote(APP, LOAN, quoteInput("06", "bpmi_monthly", 12, "minimum", 30))];
  assert.equal(quotes[0]!.monthly_premium_cents, 13_047n); assert.equal(quotes[1]!.monthly_premium_cents, 10_300n);
  const cmp = compareMiPlans({ quotes, llpa });
  assert.deepEqual(cmp.minimum_vs_standard, { monthly_saving_cents: 2_747n, llpa_cents: 154_500n, breakeven_months: 56 });
  assert.equal(cmp.rows[1]!.llpa_cents, 154_500n); assert.equal(cmp.rows[0]!.llpa_cents, 0n); assert.match(cmp.disclosure, /prepared automatically/); assert.match(cmp.disclosure, /protects the lender/);
  // Worked example 1 (continued): P&I $2,570.34; payment 1 interest $2,188.75, principal $381.59, balance $411,618.41; 80% = $366,240.00; 78% = $357,084.00; balances $365,633.53 / $356,532.66.
  const { schedule: s, dates } = fixtureDates();
  assert.equal(s.pi_cents, 257_034n); assert.equal(s.schedule.rows[0]!.interest_cents, 218_875n); assert.equal(s.schedule.rows[0]!.principal_cents, 38_159n); assert.equal(s.schedule.rows[0]!.upb_after_cents, 41_161_841n);
  assert.equal(dates.threshold_80_cents, 36_624_000n); assert.equal(dates.threshold_78_cents, 35_708_400n); assert.equal(dates.cancellation_balance_cents, 36_563_353n); assert.equal(dates.termination_balance_cents, 35_653_266n);
  assert.equal(s.schedule.rows.at(-1)!.upb_after_cents, 0n, "the final row absorbs rounding to a zero balance");
  // Worked example 2: financed single premium $6,592.00 → note amount $418,592.00; P&I $2,611.47.
  const fin = financedSinglePremiumPlan({ loan_amount_cents: LOAN, rate_bps: 160, value_basis_cents: PRICE, transaction_type: "purchase", ...FIXED30, note_rate_pct: "6.375" });
  assert.equal(fin.financed_premium_cents, 659_200n); assert.equal(fin.note_amount_cents, 41_859_200n); assert.equal(fin.pi_cents, 261_147n);
  assert.equal(initialSchedule(41_859_200n).pi_cents, 261_147n, "the amortization engine, not a hand entry");
});
