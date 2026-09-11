// 20.4 Rate quote and pricing engine (base pricing, LLPAs, servicing value, cost pass-through, fee schedule)
// spec/sections/20-refinance-triggers-solicitation-lead-intake-and-pricing/20-4-rate-quote-and-pricing-engine-base-pricing-llpas-servicing-v.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_20_4 } from "../../app/tools/section20-4.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist, publishCheck } from "../../notices/checklist.ts";
import { RATE_QUOTE_SOURCE, RATE_QUOTE_SAMPLE, VERSIONS_20_4 } from "../../notices/authored/section20-4.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { prepaidInterest } from "../orig-boarding/ops-30-2.ts";
import { type RateSheet, type LlpaTable, type SmCostSchedule, type QuoteInputs, type PricingQuote, FNMA_LLPA_09_09_2026, QuoteRefused, publishRateSheet, loadLlpaTables, verifyLlpaTables, activateLlpaTables, priceQuote, recomputeQuote, numericFields, computeLlpa, tableReader, selectLlpaVersion, highBalance, quoteValidity, lockWindowCheck, lockOrRequote,
  disclaimerGate, h24Dissimilarity, gateRender, applyManualPrice, requestException, decideException, buildFeeItems, bpmiMonthly, escrowMonthlyEstimate, thirdPartyCosts, quoteNoticePayload, presentQuote, requestTermsReview, explainQuote, fetchPrices, PricingEnginePort, DISCLAIMER_STATEMENT } from "./ops-20-4.ts";

const AGENT: Actor = { kind: "agent", id: "pricing" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const OPERATOR: Actor = { kind: "human", id: "u-portal-1", role: "fnma_portal_operator" };
const REVIEWER_1: Actor = { kind: "human", id: "u-reviewer-1", role: "officer" };
const REVIEWER_2: Actor = { kind: "human", id: "u-reviewer-2", role: "compliance" };
const ET = (date: string, hhmm: string, offset = "-04:00"): string => new Date(`${date}T${hhmm}:00${offset}`).toISOString();
const store = (now = ET("2026-10-05", "09:00")) => new MemoryEventStore(new FixedClock(now));
const cost = (fee_code: string, description: string, mismo: string, le_section: SmCostSchedule["items"][number]["le_section"], vendor: string, amount_cents: bigint, provider_source: SmCostSchedule["items"][number]["provider_source"] = "creditor_selected_third_party", shoppable = false, valuation_methods?: string[]) => ({ fee_code, description, mismo_fee_type: mismo, le_section, vendor, amount_cents, provider_source, shoppable, ...(valuation_methods ? { valuation_methods } : {}) });
/** SM's AZ / LCOR / hybrid cost schedule — Σ $3,485.00 (worked example A; vendor amounts illustrative). */
const COST_AZ: SmCostSchedule = { cost_schedule_id: "cs-az-lcor-hybrid-2026-09", partner_id: "partner-1", state: "AZ", transaction_type: "limited_cash_out", valuation_method: "hybrid", effective_from: D("2026-09-01"), approved_by: "human:u-officer", items: [
  cost("credit_report", "Credit report (tri-merge)", "CreditReportFee", "B_cannot_shop", "CRA", 7500n), cost("appraisal_hybrid", "Hybrid appraisal", "AppraisalFee", "B_cannot_shop", "AMC", 49500n, "creditor_selected_third_party", false, ["hybrid"]), cost("flood_determination", "Flood determination (life of loan)", "FloodCertification", "B_cannot_shop", "FloodCo", 1200n), cost("tax_service", "Tax service", "TaxServiceFee", "B_cannot_shop", "TaxSvc", 8500n),
  cost("title_lenders_policy", "Lender's title policy", "TitleLendersCoveragePremium", "C_can_shop", "Grand Canyon Title", 125000n, "list_provider", true), cost("settlement_agent_fee", "Settlement agent fee", "TitleSettlementAgentFee", "C_can_shop", "Grand Canyon Title", 65000n, "list_provider", true), cost("title_endorsements", "Endorsements", "TitleEndorsementFee", "C_can_shop", "Grand Canyon Title", 15000n, "list_provider", true), cost("title_search", "Title search and exam", "TitleAbstractOrSearchFee", "C_can_shop", "Grand Canyon Title", 40000n, "list_provider", true),
  cost("recording_fee", "Recording fees", "RecordingFeeForDeed", "E_taxes_gov", "Maricopa County", 7000n, "government"), cost("ron_notary", "RON / notary", "NotaryFee", "B_cannot_shop", "RON vendor", 25000n), cost("mers_enote", "MERS eRegistry / eNote", "MERSRegistrationFee", "B_cannot_shop", "MERS", 4800n)] };
/** OH / purchase / traditional — Σ $2,774.00 (worked example B). */
const COST_OH: SmCostSchedule = { cost_schedule_id: "cs-oh-purchase-traditional-2026-09", partner_id: "partner-1", state: "OH", transaction_type: "purchase", valuation_method: "traditional", effective_from: D("2026-09-01"), approved_by: "human:u-officer", items: [
  cost("credit_report", "Credit report", "CreditReportFee", "B_cannot_shop", "CRA", 7500n), cost("appraisal_traditional", "Appraisal (1004)", "AppraisalFee", "B_cannot_shop", "AMC", 65000n, "creditor_selected_third_party", false, ["traditional"]), cost("flood_determination", "Flood determination", "FloodCertification", "B_cannot_shop", "FloodCo", 1200n), cost("tax_service", "Tax service", "TaxServiceFee", "B_cannot_shop", "TaxSvc", 8500n),
  cost("title_lenders_policy", "Lender's title policy", "TitleLendersCoveragePremium", "C_can_shop", "Buckeye Title", 85000n, "list_provider", true), cost("settlement_agent_fee", "Settlement agent fee", "TitleSettlementAgentFee", "C_can_shop", "Buckeye Title", 55000n, "list_provider", true), cost("title_endorsements", "Endorsements", "TitleEndorsementFee", "C_can_shop", "Buckeye Title", 10000n, "list_provider", true), cost("title_search", "Title search", "TitleAbstractOrSearchFee", "C_can_shop", "Buckeye Title", 11000n, "list_provider", true),
  cost("recording_fee", "Recording fees", "RecordingFeeForDeed", "E_taxes_gov", "Franklin County", 9400n, "government"), cost("ron_notary", "RON / notary", "NotaryFee", "B_cannot_shop", "RON vendor", 20000n), cost("mers_enote", "MERS eRegistry / eNote", "MERSRegistrationFee", "B_cannot_shop", "MERS", 4800n)] };
const grid45 = (rows: [string, string][]) => rows.map(([r, p]) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 45, price: p }));
const grid30 = (rows: [string, string][]) => rows.map(([r, p]) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 30, price: p }));
/** Example A's illustrative 45-day best-efforts sheet (PTR = rate − 0.250 %), published 06:35 ET, expiring 17:00 ET. */
const SHEET_A = (events: MemoryEventStore, date = "2026-10-05", id = `rs-${date}`, extra: Partial<Parameters<typeof publishRateSheet>[1]> = {}): RateSheet => publishRateSheet(events, { rate_sheet_id: id, partner_id: "partner-1", source: "pe_whole_loan_api", published_at: ET(date, "06:35"), expires_at: ET(date, "17:00"), published_by: "agent:pricing", prices: grid45([["6.375", "101.875"], ["6.250", "101.375"], ["6.125", "100.875"], ["6.000", "100.375"], ["5.875", "99.750"]]), ...extra }).sheet;
/** Example B's illustrative 30-day sheet, Mon Oct 19, 2026. */
const SHEET_B = (events: MemoryEventStore): RateSheet => publishRateSheet(events, { rate_sheet_id: "rs-2026-10-19", partner_id: "partner-1", source: "pe_whole_loan_api", published_at: ET("2026-10-19", "06:35"), expires_at: ET("2026-10-19", "17:00"), published_by: "agent:pricing", prices: grid30([["6.750", "102.250"], ["6.625", "101.875"], ["6.500", "101.500"], ["6.375", "101.000"], ["6.250", "100.500"], ["6.125", "100.000"]]) }).sheet;
const TABLES = (events: MemoryEventStore, notes: Record<string, unknown> = {}): LlpaTable[] => loadLlpaTables(events, FNMA_LLPA_09_09_2026, { at: ET("2026-09-10", "12:00"), status: "active", notes }).tables;
/** Worked example A: LCOR, 30-year fixed, $560,000 on $800,000 (LTV 70.00 %), score 765 Classic FICO, 1-unit primary, Maricopa AZ, escrowed, no MI, 45-day lock, Purchase Ready Thu Nov 19, 2026. */
const INPUTS_A: QuoteInputs = { product_code: "FRM30", term_months: 360, amortization: "fixed", transaction_type: "limited_cash_out", occupancy: "primary", property_type: "sfr", units: 1, loan_amount_cents: 56_000_000n, value_cents: 80_000_000n, purchase_price_cents: null, representative_score: 765, score_model: "classic_fico", score_source: "soft_pull_2026-10-05", borrower_score_models: ["classic_fico"],
  state: "AZ", county: "Maricopa", county_limit_cents: 83_275_000n, subordinate_financing_cents: 0n, mi_option: "none", homeready: false, homeready_evaluation: null, first_time_homebuyer: false, fthb_ami_waiver: false, dts_waiver: false, very_low_income: false, lock_period_days: 45, expected_purchase_ready_date: D("2026-11-19"), escrowed: true, valuation_method: "hybrid", borrower_pays_third_party_costs: false,
  taxes_annual_cents: 480_000n, insurance_annual_cents: 186_000n, mi_annual_rate_pct: null, assumed_disbursement_date: D("2026-11-12"), first_payment_date: D("2027-01-01") };
/** Worked example B: purchase, $412,000 on a $457,800 contract (LTV 89.995 → 90.00 %, 85.01–90 band), score 705, Franklin County OH, BPMI standard 25 %, HomeReady-eligible FTHB, 30-day lock, Purchase Ready Mon Dec 7, 2026. */
const INPUTS_B: QuoteInputs = { product_code: "FRM30", term_months: 360, amortization: "fixed", transaction_type: "purchase", occupancy: "primary", property_type: "sfr", units: 1, loan_amount_cents: 41_200_000n, value_cents: 45_780_000n, purchase_price_cents: 45_780_000n, representative_score: 705, score_model: "classic_fico", score_source: "tri_merge_2026-10-15", borrower_score_models: ["classic_fico"],
  state: "OH", county: "Franklin", county_limit_cents: 83_275_000n, subordinate_financing_cents: 0n, mi_option: "standard", homeready: true, homeready_evaluation: { eligible: true, source: "ami_api", ami_pct: 72, evaluated_at: ET("2026-10-16", "10:00") }, first_time_homebuyer: true, fthb_ami_waiver: false, dts_waiver: false, very_low_income: false, lock_period_days: 30, expected_purchase_ready_date: D("2026-12-07"), escrowed: true, valuation_method: "traditional", borrower_pays_third_party_costs: false,
  taxes_annual_cents: 540_000n, insurance_annual_cents: 144_000n, mi_annual_rate_pct: "0.58", assumed_disbursement_date: null, first_payment_date: null };
const ctxA = (events: MemoryEventStore, sheet?: RateSheet, tables?: LlpaTable[]) => ({ sheet: sheet ?? SHEET_A(events), tables: tables ?? TABLES(events), cost_schedule: COST_AZ, fee_schedule: null });
const quoteA = (events: MemoryEventStore, over: Partial<QuoteInputs> = {}, meta: Partial<Parameters<typeof priceQuote>[3]> = {}, ctx = ctxA(events)): PricingQuote => priceQuote(events, ctx, { ...INPUTS_A, ...over }, { quote_id: "Q-A-1005", purpose: "lead_quote", quoted_at: ET("2026-10-05", "10:00"), lead_id: "lead-a", ...meta }).quote;
const ofType = (events: MemoryEventStore, type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
const trace = (q: PricingQuote, ratePct: string) => q.solve_trace.find((t) => t.rate_pct === ratePct)!;
/** The Notice Registry with 20.4's own authored versions published (counsel approval; each passes its checklist). */
const noticeRegistry = () => { const reg = buildRegistry(); for (const v of VERSIONS_20_4) reg.publish(v.templateCode, v.version, "counsel", "2026-09-01T00:00:00.000Z", publishCheck); return reg; };

/** The 20.4 tools on the bus over the overridden registry (20.4 rows), the Notice Registry and the escalation service. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["20.4"] });
  const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const noticeReg = noticeRegistry();
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }), ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_20_4); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("20.4", name))!, actor, input, uow)).output as Record<string, unknown>;
  return { rt, uow, events, timers, run, at: (iso: string) => clock.set(iso), decisions };
}

test("20.4-T1: Given worked example A's inputs and sheet, then `llpa_items = [{lcor_fico, '760–779', '60.01–70.00%', 0.125}]`, `llpa_cents = 70000`, `solve_trace` shows 6.000% net $1,400 (fail) and 6.125% net $4,200 (pass), `note_rate = 0.06125`, `pass_through_rate = 0.05875`, `lender_credit_cents = 70000`, `sm_retained_cents = 1500`, `pi_cents = 340262`.", () => {
  const events = store(); const q = quoteA(events);
  assert.equal(q.outcome, "priced");
  assert.deepEqual(q.llpa_items, [{ grid: "lcor_fico", row: "760–779", col: "60.01–70.00%", pct: "0.125", waived: false }]);
  assert.equal(q.ltv_band, "60.01–70.00%"); assert.equal(q.ltv, "0.7000"); assert.equal(q.high_balance, false);
  assert.equal(q.llpa_total_pct, "0.125"); assert.equal(q.llpa_cents, 70000n); assert.equal(q.waiver_applied, null);
  assert.equal(q.third_party_costs_cents, 348_500n);
  assert.deepEqual([trace(q, "6.000").net_cents, trace(q, "6.000").pass], [140_000n, false]);
  assert.deepEqual([trace(q, "6.125").premium_cents, trace(q, "6.125").net_cents, trace(q, "6.125").pass], [490_000n, 420_000n, true]);
  assert.equal(trace(q, "5.875").net_cents, -210_000n);
  assert.equal(q.note_rate, "0.06125"); assert.equal(q.pass_through_rate, "0.05875"); assert.equal(q.base_price, "100.875"); assert.equal(q.net_price, "100.750");
  assert.equal(q.residual_cents, 71_500n); assert.equal(q.lender_credit_cents, 70000n); assert.equal(q.sm_retained_cents, 1500n); assert.equal(q.lender_credit_cap_cents, 70_000n);
  assert.equal(q.pi_cents, 340262n); assert.equal(q.points_cents, 0n);
  assert.deepEqual(q.sfcs, ["007"]);
  const created = ofType(events, "quote.created")[0]!;
  assert.equal(created.payload.quote_id, "Q-A-1005"); assert.equal(created.payload.rate_sheet_id, "rs-2026-10-05"); assert.equal(created.payload.llpa_table_id, "llpa-09.09.2026-lcor_fico"); assert.equal(created.payload.origination, true);
  assert.match(q.explanation_text, /6\.125%.*\$4,900\.00.*\$700\.00.*\$4,200\.00.*\$3,485\.00.*6\.000%.*\$1,400\.00.*\$715\.00.*\$700\.00.*\$15\.00/s);
});

test("20.4-T2: Given example B, then `waiver_applied = homeready`, `llpa_total_pct = 0.000`, `note_rate = 0.06375`, `pi_cents = 257034`; given `homeready=false` and no FTHB waiver, then `note_rate = 0.06750`, `pi_cents = 267222`.", () => {
  const events = store(ET("2026-10-19", "09:00")); const ctx = { sheet: SHEET_B(events), tables: TABLES(events), cost_schedule: COST_OH, fee_schedule: null };
  const q = priceQuote(events, ctx, INPUTS_B, { quote_id: "Q-B-1019", purpose: "lead_quote", quoted_at: ET("2026-10-19", "09:30") }).quote;
  assert.equal(q.ltv_band, "85.01–90.00%"); assert.equal(q.third_party_costs_cents, 277_400n);
  assert.equal(q.waiver_applied, "homeready"); assert.equal(q.llpa_total_pct, "0.000"); assert.equal(q.llpa_cents, 0n);
  assert.deepEqual(q.llpa_items, []); assert.deepEqual(q.llpa_items_waived, [{ grid: "purchase_fico", row: "700–719", col: "85.01–90.00%", pct: "1.250", waived: true }]);
  assert.equal(q.credits_cents, 0n);                                                     // income > 50 % AMI: no very-low-income credit
  assert.deepEqual([trace(q, "6.250").net_cents, trace(q, "6.250").pass, trace(q, "6.375").net_cents, trace(q, "6.375").pass], [206_000n, false, 412_000n, true]);
  assert.equal(q.note_rate, "0.06375"); assert.equal(q.pi_cents, 257034n);
  assert.equal(q.residual_cents, 134_600n); assert.equal(q.lender_credit_cents, 51_500n); assert.equal(q.sm_retained_cents, 83_100n);
  assert.equal(q.mi_coverage_pct, 25); assert.equal(q.mi_monthly_cents, 19_913n);
  assert.ok(q.sfcs.includes("900"));
  const nw = priceQuote(events, ctx, { ...INPUTS_B, homeready: false, homeready_evaluation: null, fthb_ami_waiver: false }, { quote_id: "Q-B-1019-nowaiver", purpose: "candidate", quoted_at: ET("2026-10-19", "09:31") }).quote;
  assert.equal(nw.waiver_applied, null); assert.equal(nw.llpa_total_pct, "1.250"); assert.equal(nw.llpa_cents, 515_000n);
  assert.deepEqual([trace(nw, "6.625").net_cents, trace(nw, "6.625").pass, trace(nw, "6.750").net_cents, trace(nw, "6.750").pass], [257_500n, false, 412_000n, true]);
  assert.equal(nw.note_rate, "0.06750"); assert.equal(nw.pi_cents, 267222n);
  assert.equal(nw.pi_cents - q.pi_cents, 10_188n);                                          // the waiver is worth 37.5 bps and $101.88/month
  assert.throws(() => priceQuote(events, ctx, { ...INPUTS_B, homeready_evaluation: null }, { quote_id: "Q-B-bad", purpose: "candidate", quoted_at: ET("2026-10-19", "09:32") }), (e: unknown) => e instanceof QuoteRefused && e.code === "waiver_without_evaluation");
});

test("20.4-T3: Given `score_model=vantagescore_4` with score 771, then the `lcor_vs4` grid is used, SFC 067 is staged, and any attempt to read `lcor_fico` for that quote fails; given the `lcor_vs4` table's `notes` flag `bands_unverified=true`, then the quote is blocked with `table_unverified`.", () => {
  const events = store(); const tables = TABLES(events);
  const q = quoteA(events, { score_model: "vantagescore_4", representative_score: 771, borrower_score_models: ["vantagescore_4", "vantagescore_4"] }, {}, ctxA(events, undefined, tables));
  assert.deepEqual(q.llpa_items, [{ grid: "lcor_vs4", row: "760–779", col: "60.01–70.00%", pct: "0.250", waived: false }]);   // VS 760–779 = Classic FICO 740–759
  assert.equal(q.llpa_cents, 140_000n); assert.equal(q.llpa_table_id, "llpa-09.09.2026-lcor_vs4");
  assert.ok(q.sfcs.includes("067")); assert.deepEqual(q.sfcs, ["007", "067"]);
  const reader = tableReader(tables, "vantagescore_4");
  assert.throws(() => reader.grid("lcor_fico"), (e: unknown) => e instanceof QuoteRefused && e.code === "wrong_score_model_grid");
  assert.throws(() => reader.cell("lcor_fico", "760–779", "60.01–70.00%"), QuoteRefused);
  assert.equal(reader.cell("lcor_vs4", "760–779", "60.01–70.00%"), "0.250");
  assert.throws(() => computeLlpa(tables, { ...INPUTS_A, score_model: "classic_fico", borrower_score_models: ["vantagescore_4", "classic_fico"] }), (e: unknown) => e instanceof QuoteRefused && e.code === "mixed_score_models");
  const flagged = TABLES(store(), { bands_unverified: true });
  assert.throws(() => computeLlpa(flagged, { ...INPUTS_A, score_model: "vantagescore_4", representative_score: 771, borrower_score_models: ["vantagescore_4"] }), (e: unknown) => e instanceof QuoteRefused && e.code === "table_unverified");
});

test("20.4-T4: Given a rendered written quote lacking the top-of-page disclaimer, then `REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE` blocks the render; given a template titled \"Loan Estimate\" with H-24 section headings, then the dissimilarity check fails.", () => {
  const h = harness(ET("2026-10-05", "09:11", "-07:00")); const q0 = quoteA(h.events, {}, { quote_id: "Q-A-T4", purpose: "candidate" });
  const payload = { ...RATE_QUOTE_SAMPLE, ...quoteNoticePayload(q0, { borrower_name: "Alex Borrower", property_address: "4210 E Camelback Rd, Phoenix, AZ 85018", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", partner_name: "Partner Bank, N.A.", partner_nmlsr_id: "123456", prepared_on: D("2026-10-05") }) };
  const good = render(RATE_QUOTE_SOURCE, payload);
  assert.equal(good.blocks[0]!.id, "disclaimer"); assert.equal(good.blocks[0]!.pt, 12); assert.ok(good.blocks[0]!.text.startsWith(DISCLAIMER_STATEMENT));
  const ok = gateRender(h.events, q0, { blocks: good.blocks, title: "Your Rate Quote", notice_id: "n-1" }, h.uow.clock.now());
  assert.equal(ok.blocked, false); assert.equal(ok.result.type, "quote.rendered"); assert.equal(ok.result.payload.disclaimer_verified, true);
  const gate = h.timers.byCode("REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE").at(-1)!;
  assert.equal(gate.armedByEventId, ok.requested.id); assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedByEventId, ok.result.id);
  const noDisclaimer = render(RATE_QUOTE_SOURCE.split("\n").slice(1).join("\n"), payload);
  const g = disclaimerGate(noDisclaimer.blocks, "Your Rate Quote"); assert.equal(g.open, false); assert.deepEqual(g.reasons, ["disclaimer_missing"]);
  const blocked = gateRender(h.events, q0, { blocks: noDisclaimer.blocks, title: "Your Rate Quote", notice_id: null }, h.uow.clock.now());
  assert.equal(blocked.blocked, true); assert.equal(blocked.result.type, "quote.render.blocked"); assert.equal(blocked.result.payload.severity, 1); assert.deepEqual(blocked.result.payload.reasons, ["disclaimer_missing"]);
  assert.equal(h.timers.byCode("REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE").at(-1)!.status, "armed");
  const small = render(RATE_QUOTE_SOURCE.replace('pt=12 bold}}', 'pt=10 bold}}'), payload);
  assert.deepEqual(disclaimerGate(small.blocks, "Your Rate Quote").reasons, ["disclaimer_font_10pt_below_12pt"]);
  const buried = render(RATE_QUOTE_SOURCE.replace('"disclaimer" page=1 y=0.02', '"disclaimer" page=1 y=0.9'), payload);
  assert.deepEqual(disclaimerGate(buried.blocks, "Your Rate Quote").reasons, ["disclaimer_not_top_of_page_1"]);
  const h24 = render(`{{#block "disclaimer" page=1 y=0.02 pt=12 bold}}${DISCLAIMER_STATEMENT}{{/block}}\n{{#block "heading" page=1 y=0.06 pt=18 bold}}Loan Estimate{{/block}}\n{{#block "lt" page=1 y=0.2 pt=10}}Loan Terms. Loan Amount {{money loan_amount_cents}}.{{/block}}\n{{#block "pp" page=1 y=0.4 pt=10}}Projected Payments. Principal & Interest {{money pi_cents}}.{{/block}}\n{{#block "cc" page=1 y=0.7 pt=10}}Costs at Closing. Estimated Closing Costs.{{/block}}`, payload);
  const dis = h24Dissimilarity(h24.blocks, "Loan Estimate");
  assert.equal(dis.dissimilar, false); assert.ok(dis.reasons.includes("title_resembles_h24_h25")); assert.ok(dis.reasons.some((r) => r.startsWith("h24_section_structure:") && r.includes("Loan Terms") && r.includes("Projected Payments")));
  assert.equal(disclaimerGate(h24.blocks, "Loan Estimate").open, false);
  const version = noticeRegistry().activeVersion("NTC_SM_RATE_QUOTE", D("2026-10-05"))!;
  const checklist = evaluateChecklist(version, payload, good);
  assert.equal(checklist.passed, true, JSON.stringify(checklist.blocking));
  const badTitle = evaluateChecklist(version, { ...payload, title: "Loan Estimate" }, render(RATE_QUOTE_SOURCE, { ...payload, title: "Loan Estimate" }));
  assert.equal(badTitle.passed, false); assert.ok(badTitle.blocking.some((b) => b.rule_id === "no-h24-title"));
});

test("20.4-T5: Given a quote at 10:00 ET on Mon Oct 5, 2026 and a sheet expiring 17:00 ET, then `valid_until = 2026-10-05T17:00-04:00`; a lock request at 17:30 ET is refused and a re-quote is issued from the extended-hours sheet if published.", () => {
  const events = store(); const sheet = SHEET_A(events); const tables = TABLES(events);
  const v = quoteValidity(ET("2026-10-05", "10:00"), sheet);
  assert.equal(v.valid_until, "2026-10-05T17:00-04:00"); assert.equal(v.basis, "sheet_expiry");
  assert.equal(quoteValidity(ET("2026-10-05", "10:00"), { expires_at: ET("2026-10-07", "17:00") }).valid_until, "2026-10-06T10:00-04:00");   // the 24-hour cap
  const q = quoteA(events, {}, {}, { sheet, tables, cost_schedule: COST_AZ, fee_schedule: null });
  assert.equal(q.valid_until, "2026-10-05T17:00-04:00");
  assert.deepEqual(lockWindowCheck(q, ET("2026-10-05", "16:59")), { allowed: true, reason: null });
  assert.deepEqual(lockWindowCheck(q, ET("2026-10-05", "17:30")), { allowed: false, reason: "quote_expired" });
  const none = lockOrRequote(events, { tables, cost_schedule: COST_AZ, fee_schedule: null }, [sheet], q, { requested_at: ET("2026-10-05", "17:30"), new_quote_id: "Q-A-1005-2" });
  assert.equal(none.allowed, false); assert.equal(none.reason, "quote_expired"); assert.equal(none.requote, null); assert.equal(none.superseded.status, "expired");
  assert.equal(ofType(events, "quote.expired").length, 1);
  const extended = publishRateSheet(events, { rate_sheet_id: "rs-2026-10-05-ext", partner_id: "partner-1", source: "pe_whole_loan_api", published_at: ET("2026-10-05", "17:00"), expires_at: ET("2026-10-05", "23:30"), published_by: "agent:pricing", prices: grid45([["6.375", "101.750"], ["6.250", "101.250"], ["6.125", "100.750"], ["6.000", "100.250"], ["5.875", "99.625"]]), previous_active: sheet }).sheet;
  const q2 = quoteA(events, {}, { quote_id: "Q-A-1005-b" }, { sheet, tables, cost_schedule: COST_AZ, fee_schedule: null });
  const re = lockOrRequote(events, { tables, cost_schedule: COST_AZ, fee_schedule: null }, [sheet, extended], q2, { requested_at: ET("2026-10-05", "17:30"), new_quote_id: "Q-A-1005-3" });
  assert.equal(re.allowed, false); assert.equal(re.reason, "quote_expired");
  assert.equal(re.requote!.rate_sheet_id, "rs-2026-10-05-ext"); assert.equal(re.requote!.quote_id, "Q-A-1005-3"); assert.equal(re.requote!.note_rate, "0.06125"); assert.equal(re.requote!.lender_credit_cents, 1_500n);   // 100.750 − 0.125 → net $3,500, residual $15 → credit $15
  assert.equal(re.requote!.valid_until, "2026-10-05T23:30-04:00");
});

test("20.4-T6: Given a manual price change attempt by an operator without a `pricing_exceptions` row, then the engine rejects it; given an exception `kind=relationship`, then rejected by policy; given `competitor_match` with evidence, then `SM_PRICING_EXCEPTION_APPROVAL_1BD.due_at` = next business day and the quote stays at policy price until approval.", () => {
  const h = harness(ET("2026-10-05", "11:00")); const q = quoteA(h.events, {}, { application_id: "app-a" });
  const operator: Actor = { kind: "human", id: "u-ops", role: "ops_analyst" };
  assert.throws(() => applyManualPrice(q, { price: "101.000", by: operator }, null), (e: unknown) => e instanceof QuoteRefused && e.code === "no_pricing_exception");
  assert.throws(() => requestException(h.events, { exception_id: "px-rel", quote: q, kind: "relationship", amount_bps: "12.5", requested_by: "human:u-ops", requested_at: ET("2026-10-05", "11:05"), evidence_document_id: null }), (e: unknown) => e instanceof QuoteRefused && e.code === "exception_kind_prohibited");
  assert.throws(() => requestException(h.events, { exception_id: "px-noev", quote: q, kind: "competitor_match", amount_bps: "12.5", requested_by: "human:u-ops", requested_at: ET("2026-10-05", "11:05"), evidence_document_id: null }), RangeError);
  const r = requestException(h.events, { exception_id: "px-1", quote: q, kind: "competitor_match", amount_bps: "12.5", requested_by: "human:u-ops", requested_at: ET("2026-10-05", "11:05"), evidence_document_id: "doc-competitor-quote" });
  assert.equal(r.exception.status, "pending"); assert.equal(r.exception.amount_cents, 70_000n); assert.equal(r.exception.due_on, "2026-10-06");
  const t = h.timers.byCode("SM_PRICING_EXCEPTION_APPROVAL_1BD").at(-1)!;
  assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-05"); assert.equal(t.dueDate, "2026-10-06"); assert.equal(t.armedByEventId, r.event.id);
  assert.throws(() => applyManualPrice(q, { by: operator }, r.exception), (e: unknown) => e instanceof QuoteRefused && e.code === "exception_not_approved");
  assert.equal(q.lender_credit_cents, 70_000n); assert.equal(q.note_rate, "0.06125");
  assert.throws(() => decideException(h.events, r.exception, { outcome: "approved", by: operator, decided_at: ET("2026-10-05", "12:00") }), /requires role officer/);
  const d = decideException(h.events, r.exception, { outcome: "approved", by: OFFICER, decided_at: ET("2026-10-05", "15:00"), fair_lending_review_id: "flr-2026-q4" });
  assert.equal(d.exception.status, "approved"); assert.equal(d.event.type, "pricing.exception.approved"); assert.equal(d.decided.payload.outcome, "approved");
  assert.equal(h.timers.byCode("SM_PRICING_EXCEPTION_APPROVAL_1BD").at(-1)!.status, "satisfied");
  const adjusted = applyManualPrice(q, { by: OFFICER }, d.exception);
  assert.equal(adjusted.lender_credit_cents, 140_000n); assert.equal(adjusted.sm_retained_cents, -68_500n);   // the competitor-match credit is SM's cost, not the borrower's
});

test("20.4-T7: Given `expected_purchase_ready_date = 2026-12-07` and a staged matrix with `effective_from = 2026-12-01`, then `SM_LLPA_TABLE_VERSION_GATE` selects the new table and flags `matrix_change_exposure`; given `2026-11-19`, then the 09.09.2026 table is used.", () => {
  const events = store(ET("2026-11-01", "09:00")); const active = TABLES(events);
  const staged = loadLlpaTables(events, { ...FNMA_LLPA_09_09_2026, version: "12.01.2026", effective_from: D("2026-12-01"), source_document_id: "doc-llpa-matrix-12-01-2026" }, { at: ET("2026-11-01", "09:00") }).tables;
  const all = [...active, ...staged];
  const dec7 = selectLlpaVersion(all, D("2026-12-07"));
  assert.equal(dec7.matrix_version, "12.01.2026"); assert.equal(dec7.matrix_change_exposure, true); assert.equal(dec7.current_active_version, "09.09.2026");
  const nov19 = selectLlpaVersion(all, D("2026-11-19"));
  assert.equal(nov19.matrix_version, "09.09.2026"); assert.equal(nov19.matrix_change_exposure, false);
  const exposed = computeLlpa(all, { ...INPUTS_A, expected_purchase_ready_date: D("2026-12-07") });
  assert.equal(exposed.matrix_version, "12.01.2026"); assert.ok(exposed.flags.includes("matrix_change_exposure")); assert.equal(exposed.llpa_table_id, "llpa-12.01.2026-lcor_fico");
  const current = computeLlpa(all, INPUTS_A);
  assert.equal(current.matrix_version, "09.09.2026"); assert.deepEqual(current.flags, []);
  assert.throws(() => selectLlpaVersion(all, D("2026-09-01")), (e: unknown) => e instanceof QuoteRefused && e.code === "no_active_table");
  const h = harness(ET("2026-11-02", "09:00")); const q = priceQuote(h.events, { sheet: SHEET_A(h.events, "2026-11-02"), tables: all, cost_schedule: COST_AZ, fee_schedule: null }, { ...INPUTS_A, expected_purchase_ready_date: D("2026-12-07") }, { quote_id: "Q-T7", purpose: "candidate", quoted_at: ET("2026-11-02", "09:30", "-05:00"), application_id: "app-t7" }).quote;
  const gate = h.timers.byCode("SM_LLPA_TABLE_VERSION_GATE").at(-1)!;
  assert.equal(gate.anchorDate, "2026-12-07"); assert.equal(gate.note, "evaluator:20.4.llpaTableVersionGate"); assert.ok(q.flags.includes("matrix_change_exposure"));
});

test("20.4-T8: Given the same ids (`rate_sheet_id`, `llpa_table_id`, `cost_schedule_id`, `fee_schedule_id`, engine version), when the quote is recomputed, then every numeric field is identical (reproducibility).", () => {
  const events = store(); const ctx = ctxA(events);
  const a = priceQuote(events, ctx, INPUTS_A, { quote_id: "Q-A-1005", purpose: "lead_quote", quoted_at: ET("2026-10-05", "10:00") }).quote;
  const b = recomputeQuote(ctx, a);
  assert.deepEqual([b.rate_sheet_id, b.llpa_table_id, b.cost_schedule_id, b.fee_schedule_id, b.engine_version], [a.rate_sheet_id, a.llpa_table_id, a.cost_schedule_id, a.fee_schedule_id, a.engine_version]);
  assert.deepEqual(numericFields(b), numericFields(a)); assert.equal(b.numeric_hash, a.numeric_hash); assert.equal(b.inputs_hash, a.inputs_hash);
  assert.ok(Object.keys(numericFields(a)).length > 25);
  for (const [k, v] of Object.entries(a)) if (typeof v === "bigint") assert.equal((b as unknown as Record<string, unknown>)[k], v, k);
  // property: the fingerprint changes with any pricing input, and never with the identity of the run
  const inputsVaried = [{ representative_score: 758 }, { loan_amount_cents: 56_000_100n }, { borrower_pays_third_party_costs: true }, { value_cents: 79_000_000n }, { mi_option: "minimum_coverage", value_cents: 62_000_000n }] as Partial<QuoteInputs>[];
  for (const over of inputsVaried) assert.notEqual(priceQuote(null, ctx, { ...INPUTS_A, ...over }, { quote_id: "Q-A-1005", purpose: "lead_quote", quoted_at: ET("2026-10-05", "10:00") }).quote.numeric_hash, a.numeric_hash, JSON.stringify(over, (_k, x) => (typeof x === "bigint" ? String(x) : x)));
  assert.equal(priceQuote(null, ctx, INPUTS_A, { quote_id: "Q-other-id", purpose: "candidate", quoted_at: ET("2026-10-05", "10:00"), lead_id: "lead-z" }).quote.numeric_hash, a.numeric_hash);
  assert.throws(() => recomputeQuote({ ...ctx, sheet: SHEET_A(events, "2026-10-07") }, a), /recompute needs the quote's own rate_sheet_id/);
});

test("20.4-T9: Given no score on any borrower, then the `≤639` row is used for Classic FICO grids (matrix rule) and the quote is flagged for 23.2 eligibility review.", () => {
  const events = store(); const tables = TABLES(events);
  const r = computeLlpa(tables, { ...INPUTS_A, representative_score: null, score_source: "no_score", borrower_score_models: [] });
  assert.equal(r.score_row, "≤639");
  assert.deepEqual(r.llpa_items, [{ grid: "lcor_fico", row: "≤639", col: "60.01–70.00%", pct: "1.750", waived: false }]);
  assert.equal(r.llpa_cents, 980_000n);
  assert.ok(r.flags.includes("no_score_lowest_band")); assert.ok(r.flags.includes("eligibility_review_23_2"));
  const q = quoteA(events, { representative_score: null, score_source: "no_score", borrower_score_models: [] }, {}, ctxA(events, undefined, tables));
  assert.equal(q.outcome, "not_priceable"); assert.equal(q.note_rate, null);               // $9,800 of LLPA: even 6.375 % nets $10,500 − $9,800 = $700 < $3,485 → the no-cost program cannot price it (edge case: lowest rate with borrower-paid costs)
  assert.deepEqual(q.solve_trace.map((t) => t.pass), [false, false, false, false, false]); assert.equal(trace(q, "6.375").net_cents, 70_000n);
  assert.deepEqual(ofType(events, "quote.created")[0]!.payload.flags, ["no_score_lowest_band", "eligibility_review_23_2"]); assert.equal(ofType(events, "quote.created")[0]!.payload.outcome, "not_priceable");
  const cash = quoteA(events, { representative_score: null, score_source: "no_score", borrower_score_models: [], borrower_pays_third_party_costs: true }, { quote_id: "Q-noscore-cash" }, ctxA(events, undefined, tables));
  assert.equal(cash.outcome, "priced"); assert.equal(cash.note_rate, "0.06375"); assert.equal(cash.lender_credit_cents, 70_000n);
  const p = computeLlpa(tables, { ...INPUTS_B, representative_score: null, homeready: false, homeready_evaluation: null, borrower_score_models: [] });
  assert.equal(p.llpa_items[0]!.row, "≤639"); assert.equal(p.llpa_items[0]!.pct, "2.625");
  const vs = computeLlpa(tables, { ...INPUTS_A, representative_score: null, score_model: "vantagescore_4", borrower_score_models: [] });
  assert.equal(vs.llpa_items[0]!.row, "≤659");                                              // the VantageScore family's own lowest band
});

test("20.4-T10: Given a $900,000 loan in a county with a $1,100,000 limit, then `high_balance = true` and the high-balance fixed row applies (0.750% at 60.01–70%); given $830,000 in a baseline county, then `high_balance = false`.", () => {
  const events = store(); const tables = TABLES(events);
  assert.deepEqual(highBalance(90_000_000n, 1, 110_000_000n), { high_balance: true, baseline_limit_cents: 83_275_000n, conforming: true });
  const hb = computeLlpa(tables, { ...INPUTS_A, loan_amount_cents: 90_000_000n, value_cents: 130_000_000n, county: "Santa Cruz", state: "CA", county_limit_cents: 110_000_000n });
  assert.equal(hb.high_balance, true); assert.equal(hb.ltv_band, "60.01–70.00%");
  assert.deepEqual(hb.llpa_items, [{ grid: "lcor_fico", row: "760–779", col: "60.01–70.00%", pct: "0.125", waived: false }, { grid: "attr_lcor", row: "high_balance_fixed", col: "60.01–70.00%", pct: "0.750", waived: false }]);
  assert.equal(hb.llpa_total_pct, "0.875"); assert.equal(hb.llpa_cents, 787_500n); assert.ok(hb.sfcs.includes("808"));
  assert.deepEqual(highBalance(83_000_000n, 1, 83_275_000n), { high_balance: false, baseline_limit_cents: 83_275_000n, conforming: true });
  const base = computeLlpa(tables, { ...INPUTS_A, loan_amount_cents: 83_000_000n, value_cents: 120_000_000n });
  assert.equal(base.high_balance, false); assert.equal(base.llpa_items.length, 1); assert.ok(!base.sfcs.includes("808"));
  assert.throws(() => computeLlpa(tables, { ...INPUTS_A, loan_amount_cents: 90_000_000n, value_cents: 130_000_000n }), (e: unknown) => e instanceof QuoteRefused && e.code === "not_conforming");   // $900,000 in a baseline county
  const arm = computeLlpa(tables, { ...INPUTS_A, amortization: "arm_7_6", loan_amount_cents: 90_000_000n, value_cents: 130_000_000n, county_limit_cents: 110_000_000n });
  assert.ok(arm.llpa_items.some((it) => it.row === "high_balance_arm" && it.pct === "1.500")); assert.ok(arm.llpa_items.some((it) => it.row === "arm" && it.pct === "0.000"));
});

test("20.4-T11: Given Loan Pricing API failures ×3, then the Browse Prices export is used; given both unavailable, then a `human_portal_task` for `fnma_portal_operator` is created and no quotes issue until a `manual_ui_read` sheet with dual entry is published.", async () => {
  const prices = grid45([["6.375", "101.875"], ["6.250", "101.375"], ["6.125", "100.875"], ["6.000", "100.375"], ["5.875", "99.750"]]);
  let calls = 0; const flaky = { loanPricingApi: () => { calls++; throw new Error("503"); }, browsePricesExport: () => prices };
  const r = fetchPrices(flaky); assert.equal(calls, 3); assert.equal(r.source, "browse_prices_export"); assert.equal(r.api_failures, 3); assert.equal(r.fallback, "browse_prices_export"); assert.equal(r.prices.length, 5);
  const h = harness(ET("2026-10-05", "06:36"));
  const viaExport = await h.run("fetchPeWlPrices", { partner_id: "partner-1", api_responses: ["503", "timeout", "502"], browse_prices_export: prices });
  assert.equal(viaExport.source, "browse_prices_export"); assert.equal(viaExport.api_failures, 3); assert.equal(ofType(h.events, "pricing.feed.fallback").length, 1);
  const down = await h.run("fetchPeWlPrices", { partner_id: "partner-1", api_responses: ["503", "503", "503"] });
  assert.equal(down.source, null); assert.equal(down.fallback, "manual_ui_read"); assert.equal(down.quotes_blocked, true); assert.equal(down.owner_role, "fnma_portal_operator");
  const esc = h.rt.escalations.list().find((e) => e.id === down.escalation_id)!;
  assert.equal(esc.kind, "human_portal_task"); assert.equal(esc.ownerRole, "fnma_portal_operator"); assert.equal(esc.payload.required_source, "manual_ui_read");
  assert.equal(ofType(h.events, "pricing.feed.unavailable").length, 1);
  await h.run("loadLlpaTable", { op: "stage", matrix_version: "09.09.2026", activate: true });
  await h.run("buildFeeItems", { op: "cost_schedule", ...COST_AZ, items: COST_AZ.items }, OFFICER);
  const inputs = { ...INPUTS_A, expected_purchase_ready_date: "2026-11-19" };
  await assert.rejects(h.run("solvePassThrough", { partner_id: "partner-1", inputs, quote_id: "Q-blocked" }), /no quotes issue until a manual_ui_read sheet with dual entry is published/);
  await assert.rejects(h.run("publishRateSheet", { rate_sheet_id: "rs-manual", partner_id: "partner-1", source: "manual_ui_read", prices, expires_at: ET("2026-10-05", "17:00") }, AGENT), (e: unknown) => e instanceof CommandRefused && e.code === "MANUAL_UI_READ_IS_OPERATOR");
  await assert.rejects(h.run("publishRateSheet", { rate_sheet_id: "rs-manual", partner_id: "partner-1", source: "manual_ui_read", prices, expires_at: ET("2026-10-05", "17:00") }, OPERATOR), /dual entry/);
  await assert.rejects(h.run("publishRateSheet", { rate_sheet_id: "rs-manual", partner_id: "partner-1", source: "manual_ui_read", prices, expires_at: ET("2026-10-05", "17:00"), dual_entry: { operator_id: "human:u-portal-2", prices: [...prices.slice(0, 4), { ...prices[4]!, price: "99.875" }] } }, OPERATOR), /dual entry mismatch/);
  const pub = await h.run("publishRateSheet", { rate_sheet_id: "rs-manual", partner_id: "partner-1", source: "manual_ui_read", prices, expires_at: ET("2026-10-05", "17:00"), dual_entry: { operator_id: "human:u-portal-2", prices } }, OPERATOR);
  assert.deepEqual(pub.dual_entry_verified_by, ["human:u-portal-1", "human:u-portal-2"]); assert.equal(pub.source, "manual_ui_read");
  assert.equal(h.timers.byCode("SM_RATE_SHEET_PUBLISH_DAILY").at(-1)!.dueDate, "2026-10-06");
  const q = await h.run("solvePassThrough", { partner_id: "partner-1", inputs, quote_id: "Q-after-manual" });
  assert.equal(q.outcome, "priced"); assert.equal(q.note_rate, "0.06125"); assert.equal(q.rate_sheet_id, "rs-manual"); assert.equal(q.lender_credit_cents, "70000");
});

test("20.4-T12: Given a borrower who elects to pay third-party costs in cash, then the solve uses `third_party_costs = 0`, the lowest rate with `net_premium ≥ 0` is returned (6.000% at 100.375 in example A → net $1,400 → credit $700, retained $700), and the fee items are `paid_by=borrower` with tolerance classes for 21.2.", () => {
  const events = store(); const q = quoteA(events, { borrower_pays_third_party_costs: true });
  assert.equal(q.third_party_costs_cents, 0n);
  assert.deepEqual([trace(q, "5.875").pass, trace(q, "6.000").pass], [false, true]);
  assert.equal(q.note_rate, "0.06000"); assert.equal(q.base_price, "100.375"); assert.equal(q.net_premium_cents, 140_000n); assert.equal(q.residual_cents, 140_000n);
  assert.equal(q.lender_credit_cents, 70_000n); assert.equal(q.sm_retained_cents, 70_000n);
  assert.equal(q.pi_cents, levelPayment(56_000_000n, ratePercent("6.000"), 360)); assert.ok(q.pi_cents < 340_262n);
  assert.ok(q.fee_items.length >= 11); assert.ok(q.fee_items.every((f) => f.paid_by === "borrower"));
  assert.ok(q.fee_items.every((f) => ["zero", "ten_percent", "unlimited"].includes(f.tolerance_class)));
  assert.equal(q.fee_items.find((f) => f.fee_code === "appraisal_hybrid")!.tolerance_class, "zero"); assert.equal(q.fee_items.find((f) => f.fee_code === "title_lenders_policy")!.tolerance_class, "ten_percent"); assert.equal(q.fee_items.find((f) => f.fee_code === "recording_fee")!.tolerance_class, "ten_percent");
  assert.equal(q.fee_items.reduce((a, f) => a + f.amount_cents, 0n), 348_500n);
  assert.ok(q.fee_items.every((f) => f.estimate_source === "pricing_engine" && f.estimated_at === "2026-10-05"));
  const program = quoteA(events, {}, { quote_id: "Q-A-program" });
  assert.ok(program.fee_items.every((f) => f.paid_by === "sm_third_party_cost_program"));
  const items = buildFeeItems({ inputs: { ...INPUTS_A, borrower_pays_third_party_costs: true }, quote_id: "Q-x", quoted_at: ET("2026-10-05", "10:00"), cost_items: thirdPartyCosts(COST_AZ, INPUTS_A).items }, { fee_schedule_id: "fs-az-maricopa", jurisdiction: "AZ:Maricopa", version: "2026-08-01", effective_from: D("2026-08-01"), refreshed_at: ET("2026-08-01", "06:00"), items: [{ fee_code: "transfer_tax", description: "Transfer tax", le_section: "E_taxes_gov", mismo_fee_type: "TransferTax", amount_cents: 0n, source: "jurisdiction_table", refreshed_at: ET("2026-08-01", "06:00") }] });
  const tt = items.find((f) => f.fee_code === "transfer_tax")!;
  assert.equal(tt.paid_by, "borrower"); assert.equal(tt.tolerance_class, "zero"); assert.equal(tt.stale_source, true);   // the jurisdiction table is 65 days old → SM_FEE_SCHEDULE_REFRESH_30 breach flag for 21.2
  assert.match(q.explanation_text, /6\.000%/);
  const port = new PricingEnginePort({ sheets: [SHEET_A(events, "2026-10-07")], tables: TABLES(events), cost_schedule: COST_AZ, fee_schedule: null });
  const lockQuote = port.price({ application_id: "app-a", loan_amount_cents: 56_000_000n, product_code: "FRM30", note_rate_pct: "6.125", lock_period_days: 45 }, ET("2026-10-07", "09:00"));
  assert.equal(lockQuote.price_pct, "100.875"); assert.equal(lockQuote.rate_sheet_id, "rs-2026-10-07"); assert.equal(lockQuote.llpa_version, "09.09.2026"); assert.equal(lockQuote.points_pct, "0.000");
  assert.throws(() => port.price({ application_id: "app-a", loan_amount_cents: 56_000_000n, product_code: "FRM30", note_rate_pct: "6.062", lock_period_days: 45 }, ET("2026-10-07", "09:00")), (e: unknown) => e instanceof QuoteRefused && e.code === "price_not_on_sheet");
});

test("20.4 worked figures: example A ($700.00 LLPA, $3,485.00 costs, $3,402.62 P&I, $93.97/day × 19 = $1,785.43, $555.00 escrow) and example B ($2,570.34 vs $2,672.22 = $101.88/month, $199.13 BPMI) reproduce from the engine", () => {
  const events = store(); const q = quoteA(events);
  assert.equal(q.llpa_cents, 70_000n);                                   // $700.00 — LCOR 760–779 × 60.01–70.00 % = 0.125 % of $560,000
  assert.equal(q.lender_credit_cents, 70_000n);                          // $700.00 — the 12.5 bps credit cap on $560,000
  assert.equal(q.third_party_costs_cents, 348_500n);                     // $3,485.00 — AZ / LCOR / hybrid schedule
  assert.equal(trace(q, "6.125").premium_cents, 490_000n);               // $4,900.00 premium at 100.875
  assert.equal(q.pi_cents, 340_262n);                                    // $3,402.62 — 20.1 discrepancy 5: not $3,402.63
  assert.equal(q.per_diem_cents, 9_397n);                                // $93.97 = $560,000 × 6.125 % / 365
  assert.equal(q.prepaid_interest_days, 19); assert.equal(q.prepaid_interest_cents, 178_543n);   // $1,785.43 for a Nov 12 disbursement (Nov 12–30)
  assert.deepEqual(prepaidInterest(56_000_000n, "6.125", D("2026-11-12")).prepaid_interest_cents, 178_543n);
  assert.equal(q.escrow_monthly_estimate_cents, 55_500n);                // $555.00 = ($4,800 + $1,860) / 12
  assert.equal(escrowMonthlyEstimate(480_000n, 186_000n), 55_500n);
  assert.equal(q.total_monthly_cents, 395_762n);
  // apr_estimate: the spec's 6.155 % is marked illustrative; the 25.1 Appendix J engine with prepaid interest as the only finance charge (term start Nov 12, first payment Jan 1) gives 6.095 % (reported as a discrepancy)
  assert.equal(q.apr_estimate, "6.095");
  const eventsB = store(ET("2026-10-19", "09:00")); const ctxB = { sheet: SHEET_B(eventsB), tables: TABLES(eventsB), cost_schedule: COST_OH, fee_schedule: null };
  const b = priceQuote(eventsB, ctxB, INPUTS_B, { quote_id: "Q-B", purpose: "lead_quote", quoted_at: ET("2026-10-19", "09:30") }).quote;
  const nw = priceQuote(eventsB, ctxB, { ...INPUTS_B, homeready: false, homeready_evaluation: null }, { quote_id: "Q-B-nw", purpose: "candidate", quoted_at: ET("2026-10-19", "09:31") }).quote;
  assert.equal(b.pi_cents, 257_034n);                                    // $2,570.34 at 6.375 %
  assert.equal(nw.pi_cents, 267_222n);                                   // $2,672.22 at 6.750 % without the waiver
  assert.equal(nw.pi_cents - b.pi_cents, 10_188n);                       // $101.88/month — the HomeReady waiver's value
  assert.equal(nw.llpa_cents, 515_000n);                                 // $5,150.00 = 1.250 % of $412,000 before the waiver
  assert.equal(b.third_party_costs_cents, 277_400n);                     // $2,774.00 — OH / purchase / traditional
  assert.equal(trace(b, "6.375").net_cents, 412_000n); assert.equal(b.residual_cents, 134_600n); assert.equal(b.lender_credit_cents, 51_500n); assert.equal(b.sm_retained_cents, 83_100n);
  assert.equal(bpmiMonthly(41_200_000n, "0.58"), 19_913n);               // $199.13 BPMI at 0.58 %/yr
  assert.equal(b.mi_monthly_cents, 19_913n);
  // the quote presents P&I, MI and escrow separately; the MLO review gates the presentation (20.3) and the explanation is deterministic
  assert.throws(() => presentQuote(events, q, null, ET("2026-10-05", "09:11", "-07:00")), (e: unknown) => e instanceof QuoteRefused && e.code === "mlo_review_required");
  const req = requestTermsReview(events, q, { requested_at: ET("2026-10-05", "08:50", "-07:00"), mlo_of_record_id: "mlo-1" });
  assert.equal(req.type, "terms.presentation.requested"); assert.equal(req.payload.origination, true);
  const shown = presentQuote(events, q, { review_id: "rev-1", outcome: "approved", mlo_of_record_id: "mlo-1", mlo_name: "Jordan Rivera", nmlsr_id: "987654", completed_at: ET("2026-10-05", "09:10", "-07:00") }, ET("2026-10-05", "09:11", "-07:00"));
  assert.equal(shown.quote.status, "presented"); assert.equal(shown.event.payload.nmlsr_id, "987654");
  assert.equal(explainQuote(q), q.explanation_text);
  // operational prerequisite: the matrix is staged from its rule set, verified by two distinct human reviewers (flags cleared), then activated
  const staged = loadLlpaTables(events, FNMA_LLPA_09_09_2026, { at: ET("2026-09-10", "12:00"), notes: { bands_unverified: true, second_home_unverified: true } }).tables;
  assert.throws(() => computeLlpa(staged, INPUTS_A), (e: unknown) => e instanceof QuoteRefused && e.code === "table_unverified");
  assert.throws(() => activateLlpaTables(events, staged, ET("2026-09-10", "12:05")), /not verified by two reviewers/);
  const once = verifyLlpaTables(events, staged, REVIEWER_1, ET("2026-09-10", "13:00")); assert.equal(once.verified, false); assert.equal(once.tables[0]!.notes.bands_unverified, true);
  assert.throws(() => verifyLlpaTables(events, once.tables, REVIEWER_1, ET("2026-09-10", "13:30")), /second, different reviewer/);
  assert.throws(() => verifyLlpaTables(events, once.tables, AGENT, ET("2026-09-10", "13:30")), /requires role human reviewer/);
  const twice = verifyLlpaTables(events, once.tables, REVIEWER_2, ET("2026-09-11", "09:00")); assert.equal(twice.verified, true); assert.deepEqual(twice.tables[0]!.notes, {}); assert.equal(twice.tables[0]!.status, "verified");
  const live = activateLlpaTables(events, twice.tables, ET("2026-09-11", "09:05")).tables; assert.equal(live[0]!.status, "active");
  assert.equal(computeLlpa(live, INPUTS_A).llpa_cents, 70_000n);
});
