// 27.2 Purchase-proceeds settlement, warehouse payoff, gain-on-sale computation and the borrower rate pass-through (Grander economics), MSR accounting hand-off to the partner
// spec/sections/27-warehouse-funding-and-settlement-economics-supermortgage-as/27-2-purchase-proceeds-settlement-warehouse-payoff-gain-on-sale-c.md
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
import { TOOLS_27_2 } from "../../app/tools/section27-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FACILITY_FIXTURE, accrualSchedule, payoffStatement, advanceAmount, type SofrPoint } from "./ops-27-1.ts";
import {
  ECONOMICS_V1, GuardrailViolation, forecastProceeds, purchaseInterest, days30_360, prepaidInterest, matchProceeds, explainVariance, provisionalMatch, missingAdvice, splitReceipt, settlementWaterfall, costRecoveryDue, releasePlan, computeGainOnSale, reconcilePassthrough, grossPremium, recaptureExposure, assessPremiumRecapture,
  msrHandoffPayload, MSR_PAYLOAD_FIELDS, scheduledPi, upbAfterPayment, monthlyPlatformFee, platformFeeAccrual, preparePpa, buildGlBatches, waterfallLedgerSets, compact,
  type ProceedsForecast, type PurchaseAdviceRecord, type SettlementKeys, type QuoteEconomics, type PassthroughEvidence,
} from "./ops-27-2.ts";

const AGENT: Actor = { kind: "agent", id: "warehouse" };
const FUNDING_APPROVER: Actor = { kind: "human", id: "u-fa-sm", role: "funding_approver" };
const PORTAL_OPERATOR: Actor = { kind: "human", id: "u-portal-partner", role: "fnma_portal_operator" };
const LOAN = "L-REFI-1", APP = "app-refi-1", ADV = "adv-refi-1", MIN = "100012300004567890", SELLER_NO = "SM-000000001", FNMA_NO = "4001234567";
const PLOAN = "L-PUR-1", PAPP = "app-pur-1", PADV = "adv-pur-1", PMIN = "100012300009876543", PSELLER_NO = "SM-000000002", PFNMA_NO = "4001234568";
const F = FACILITY_FIXTURE; const COLL = F.collection_account_ref;
const et = (date: string, hhmm: string): string => { const [h, m] = hhmm.split(":").map(Number) as [number, number]; return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h + 5, m)).toISOString(); };   // EST (UTC−5) in Nov–Mar
/** SOFR 4.30% flat on the federal business days of the fixture window (27.1 fixture). */
const SOFR: SofrPoint[] = ["2026-11-06", "2026-11-09", "2026-11-10", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-30", "2026-12-01", "2026-12-02"].map((d) => ({ publication_date: D(d), rate_bps: 430 }));
const NO_FLAGS = { dwell_stepup_active: false, wet_overdue: false };
const MATRIX = "fnma.llpa.09.09.2026";

// ---- fixtures (section README "Refinance fixture" / "Purchase fixture"; 27.1 examples A / B for the payoffs) ----
const QUOTE_A: QuoteEconomics = { quote_id: "q-refi-1", price: "101.375", llpa_total_pct: "0.125", third_party_costs_cents: 348_500n, lender_credit_cents: 70_000n, sm_retained_cents: 281_500n, matrix_version: MATRIX, solve_trace_document_id: "doc-solve-1", quoted_note_rate: "0.06125" };
const QUOTE_B: QuoteEconomics = { ...QUOTE_A, quote_id: "q-refi-1b", price: "100.875", sm_retained_cents: 1_500n };
const EVIDENCE: PassthroughEvidence = { quote_solve_trace_document_id: "doc-solve-1", lock_confirmation_document_id: "doc-lock-1", final_cd_document_id: "doc-cd-final-1", note_document_id: "doc-note-1", purchase_advice_document_id: "doc:pa-4001234567-2026-11-19.json", invoice_document_ids: ["doc-inv-1", "doc-inv-2"] };
const refiLoan = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ loan_id: LOAN, application_id: APP, advance_id: ADV, facility_id: F.facility_id, funding_id: "fund-refi-1", delivery_id: "del-refi-1", seller_loan_number: SELLER_NO, partner_id: F.partner_id,
  upb_cents: "56000000", note_rate: "0.06125", pass_through_rate: "0.05875", remittance_type: "aa", lpi_date: "2026-12-01", first_payment_date: "2027-01-01", term_months: 360, amortization_type: "fixed", product_code: "FNMA-30FRM", pi_cents: "340262", escrow_indicator: true, mi_flag: false, occupancy: "primary", property_state: "AZ", sfc_codes: ["007", "127", "508"],
  price: "101.375", llpa_items: [{ code: "LCOR_760_779_60_01_70", pct: "0.125" }], fees_cents: "0", expected_purchase_date: "2026-11-19", matrix_version: MATRIX,
  quote: { ...QUOTE_A, third_party_costs_cents: "348500", lender_credit_cents: "70000", sm_retained_cents: "281500" }, lock_id: "lock-refi-1", evidence: EVIDENCE, disclosure_id_cd_final: "cd-final-1", cd_lender_credit_cents: "70000", prepaid_interest_collected_cents: "178543", third_party_costs_actual_cents: "348500",
  note_form: "enote", bailee_letter_id: null, custodian_party_id: null, min: MIN, ...over });
const purchaseLoan = (over: Record<string, unknown> = {}): Record<string, unknown> => refiLoan({ loan_id: PLOAN, application_id: PAPP, advance_id: PADV, funding_id: "fund-pur-1", delivery_id: "del-pur-1", seller_loan_number: PSELLER_NO, upb_cents: "41200000", note_rate: "0.06375", pass_through_rate: "0.06125", pi_cents: "257034", escrow_indicator: true, mi_flag: true, property_state: "OH", sfc_codes: ["007"],
  price: "101.000", llpa_items: [], expected_purchase_date: "2026-12-02", quote: { quote_id: "q-pur-1", price: "101.000", llpa_total_pct: "0", third_party_costs_cents: "277400", lender_credit_cents: "51500", sm_retained_cents: "83100", matrix_version: MATRIX, solve_trace_document_id: "doc-solve-2", quoted_note_rate: "0.06375" }, lock_id: "lock-pur-1",
  cd_lender_credit_cents: "51500", prepaid_interest_collected_cents: "93548", third_party_costs_actual_cents: "277400", note_form: "paper", bailee_letter_id: "BL-2026-11-18", custodian_party_id: "party-fcc-1", min: PMIN, ...over });
/** The Sellers API advice for the refinance (example A, convention A) — `over` builds the B / D(i) / D(ii) variants. */
const adviceA = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ fnma_loan_number: FNMA_NO, seller_loan_number: SELLER_NO, fnma_servicer_number: "123456789", commitment_id_fnma: "BE-2026-11-0001", advice_date: "2026-11-19", purchase_date: "2026-11-19", purchase_ready_date: "2026-11-18", remittance_type: "aa", note_rate: "0.06125", pass_through_rate: "0.05875", servicing_fee_bps: 25, lpi_date: "2026-12-01",
  interest_days: 12, interest_direction: "due_fannie_mae", interest_cents: "109667", upb_cents: "56000000", price: "101.375", gross_price_proceeds_cents: "56770000", llpa_items: [{ code: "LCOR_760_779_60_01_70", pct: "0.125", cents: "70000" }], llpa_total_cents: "70000", other_fees_cents: "0", net_proceeds_cents: "56590333", payee_code: "SM-COLL-482", wire_nickname: "SM WAREHOUSE", ...over });
const adviceC = (over: Record<string, unknown> = {}): Record<string, unknown> => adviceA({ fnma_loan_number: PFNMA_NO, seller_loan_number: PSELLER_NO, commitment_id_fnma: "BE-2026-11-0002", advice_date: "2026-12-02", purchase_date: "2026-12-02", purchase_ready_date: "2026-12-01", note_rate: "0.06375", pass_through_rate: "0.06125", interest_days: 1, interest_direction: "due_lender", interest_cents: "7010", upb_cents: "41200000", price: "101.000", gross_price_proceeds_cents: "41612000", llpa_items: [], llpa_total_cents: "0", net_proceeds_cents: "41619010", ...over });
const receipt = (amount: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ bank_ref: "FED-20261119-0001", value_date: "2026-11-19", amount_cents: amount, originator_name: "FANNIE MAE", reference_text: `PAYEE SM-COLL-482 LOAN ${FNMA_NO} ${SELLER_NO}`, account_ref: COLL, received_at: et("2026-11-19", "10:40"), ...over });
const KEYS: SettlementKeys = { advance_id: ADV, loan_id: LOAN, application_id: APP, facility_id: F.facility_id, funding_id: "fund-refi-1", delivery_id: "del-refi-1", fnma_loan_number: null, seller_loan_number: SELLER_NO };
const toAdvice = (r: Record<string, unknown>): PurchaseAdviceRecord => ({ ...(r as unknown as PurchaseAdviceRecord), purchase_advice_id: `pa-${r.fnma_loan_number}-${r.advice_date}`, loan_id: LOAN, delivery_id: "del-refi-1", interest_cents: BigInt(String(r.interest_cents)), upb_cents: BigInt(String(r.upb_cents)), gross_price_proceeds_cents: BigInt(String(r.gross_price_proceeds_cents)), llpa_total_cents: BigInt(String(r.llpa_total_cents)), other_fees_cents: BigInt(String(r.other_fees_cents)), net_proceeds_cents: BigInt(String(r.net_proceeds_cents)), llpa_items: (r.llpa_items as { code: string; pct: string; cents: string }[]).map((l) => ({ ...l, cents: BigInt(l.cents) })), source: "purchase_advice_api_sellers", raw_document_id: "doc:pa.json", received_at: et("2026-11-19", "09:15"), status: "received", purchase_ready_date: D(String(r.purchase_ready_date)), advice_date: D(String(r.advice_date)), purchase_date: D(String(r.purchase_date)), lpi_date: D(String(r.lpi_date)) });
const forecastA = (): ProceedsForecast => forecastProceeds({ upb_cents: 56_000_000n, price: "101.375", llpa_items: [{ code: "LCOR_760_779_60_01_70", pct: "0.125" }], remittance_type: "aa", purchase_date: D("2026-11-19"), lpi_date: D("2026-12-01"), pass_through_rate: "0.05875", fees_cents: 0n, matrix_version: MATRIX });
/** 27.1 example A payoff, reused: $548,800.00 + 7 days at 6.80% act/360 by the cumulative method ($725.64) + $25.00 = $549,550.64. */
const payoffA = () => payoffStatement({ outstanding_principal_cents: 54_880_000n, capitalized_interest_cents: 0n, accrued_not_capitalized_cents: accrualSchedule(F, { from: D("2026-11-12"), to: D("2026-11-18"), principalOn: () => 54_880_000n, flagsOn: () => NO_FLAGS, sofr: SOFR }).total_posted_cents, fees_cents: 2_500n, repayment_on: D("2026-11-19") });
const payoffC = () => payoffStatement({ outstanding_principal_cents: 40_376_000n, capitalized_interest_cents: 0n, accrued_not_capitalized_cents: accrualSchedule(F, { from: D("2026-11-18"), to: D("2026-12-01"), principalOn: () => 40_376_000n, flagsOn: () => NO_FLAGS, sofr: SOFR }).total_posted_cents, fees_cents: 2_500n, repayment_on: D("2026-12-02") });

/** The 27.2 tools on the bus over the overridden registry (27.2 rows), a memory ledger, the escalation service and the fake ports; 27.1's advance and accrual records are seeded as 27.1 leaves them at purchase. */
function harness(nowIso: string, loanId = LOAN, appId = APP) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["27.2"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_27_2); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("27.2", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt = clock.now(), keys: { loanId: string; applicationId: string } = { loanId, applicationId: appId }) => events.append({ type, ...keys, actor: { kind: "external", id: "platform" }, occurredAt, payload: { application_id: keys.applicationId, ...payload } });
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused ${code}, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  const violated = async (p: Promise<unknown>, code: string): Promise<GuardrailViolation> => { try { await p; } catch (e) { assert.ok(e instanceof GuardrailViolation, `expected GuardrailViolation ${code}, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected guardrail violation ${code}`); };
  /** 27.1's records at purchase: the funded advance (98% of the note; $25.00 wire fee outstanding) and its daily accrual rows by the cumulative method. */
  const seedAdvance = (id: string, lid: string, aid: string, principal: bigint, from: string, to: string, noteForm: "enote" | "paper") => {
    rt.store.put("warehouse_advances", id, { advance_id: id, loan_id: lid, application_id: aid, facility_id: F.facility_id, status: "funded", note_form: noteForm, outstanding_principal_cents: String(principal), capitalized_interest_cents: "0", fees_outstanding_cents: "2500", interest_accrued_cents: "0", advance_date: from, collateral_status: noteForm === "enote" ? "transferred_pending_payment" : "secured_possession" }, AGENT, clock.now());
    const s = accrualSchedule(F, { from: D(from), to: D(to), principalOn: () => principal, flagsOn: () => NO_FLAGS, sofr: SOFR });
    for (const r of s.rows) rt.store.put("warehouse_interest_accruals", `${id}:${r.accrual_date}`, { advance_id: id, accrual_date: r.accrual_date, posted_cents: String(r.posted_cents), capitalized: false, all_in_rate_bps: r.all_in_rate_bps }, AGENT, clock.now());
    return s.total_posted_cents;
  };
  /** Example A on the bus through the match: registered and forecast Mon Nov 16, certified Wed Nov 18, advice 09:15 and bank credit 10:40 ET Thu Nov 19, matched 11:02 ET. */
  const throughMatch = async (adviceOver: Record<string, unknown> = {}, amount = "56590333", loanOver: Record<string, unknown> = {}) => {
    at(et("2026-11-16", "10:00")); seedAdvance(ADV, LOAN, APP, 54_880_000n, "2026-11-12", "2026-11-18", "enote");
    await run("forecastProceeds", { op: "register", loan: refiLoan(loanOver) }); await run("forecastProceeds", { loan_id: LOAN });
    at(et("2026-11-18", "08:00")); await run("forecastProceeds", { loan_id: LOAN, op: "certified", certification_date: "2026-11-18" });
    at(et("2026-11-19", "09:15")); await run("pollPurchaseAdvices", { advices: [adviceA(adviceOver)] });
    at(et("2026-11-19", "10:40")); await run("ingestReceipts", { receipts: [receipt(amount)] });
    at(et("2026-11-19", "11:02")); return run("matchProceeds", { loan_id: LOAN });
  };
  const throughWaterfall = async () => { const m = await throughMatch(); at(et("2026-11-19", "11:30")); const w = await run("postWaterfall", { loan_id: LOAN }); return { m, w }; };
  return { clock, events, timers, ledger, rt, decisions, run, at, timer, ofType, upstream, refused, violated, seedAdvance, throughMatch, throughWaterfall };
}

test("27.2-T1: Given the fixture loan delivered Nov 16, certified Nov 18 and the Sellers API advice dated Thu Nov 19, 2026 showing gross $567,700.00, LLPA $700.00 and interest due Fannie Mae $1,096.67, when the bank credits $565,903.33 with value date Nov 19, then the three-way match succeeds with `variance_cents = 0`, `interest_convention_observed = a_30_360`, and `SM_WH_PROCEEDS_MATCH_SAME_DAY` is satisfied.", async () => {
  // rule 1: the forecast at delivery under both conventions
  const f = forecastA();
  assert.equal(f.expected_gross_cents, 56_770_000n, "101.375% × $560,000 = $567,700.00"); assert.equal(f.expected_llpa_cents, 70_000n, "0.125% × $560,000 = $700.00");
  assert.equal(f.interest.direction, "due_fannie_mae"); assert.equal(f.interest.days_a, 12); assert.equal(f.interest.cents_a, 109_667n, "$560,000 × 0.05875 × 12/360 = $1,096.67"); assert.equal(f.interest.cents_b, 108_164n, "actual/365: $1,081.64");
  assert.equal(f.expected_net_a_cents, 56_590_333n, "$567,700.00 − $700.00 − $1,096.67 = $565,903.33"); assert.equal(f.expected_net_b_cents, 56_591_836n);
  // rule 2 on the pure calculator
  const m = matchProceeds({ keys: KEYS, forecast: f, advice: toAdvice(adviceA()), received_cents: 56_590_333n, receipt_account_ref: COLL, partner_convention: "unresolved", collection_account_ref: COLL, expected_payee_code: "SM-COLL-482" });
  assert.equal(m.status, "matched"); assert.equal(m.variance_cents, 0n); assert.equal(m.interest_convention_observed, "a_30_360"); assert.equal(m.convention_action, "lock"); assert.equal(m.convention_after, "a_30_360"); assert.equal(m.tolerance_rule_applied, "rounding_le_100_cents");
  assert.deepEqual(m.variance_breakdown, { price_cents: 0n, llpa_cents: 0n, interest_cents: 0n, fees_cents: 0n, convention_cents: 0n, unexplained_cents: 0n });
  // on the bus: certification arms the expected-proceeds clock (Nov 18 + 1 fannie_et BD = Nov 19); the advice arms the C2-2-05 window; the receipt satisfies the expectation and arms the same-day match clock (18:00 ET)
  const h = harness(et("2026-11-16", "10:00"));
  const out = await h.throughMatch();
  const expected = h.timer("SM_WH_PROCEEDS_EXPECTED_1BD")!; assert.equal(expected.dueDate, "2026-11-19"); assert.equal(expected.status, "satisfied");
  assert.equal(h.ofType("purchase_advice.received")[0]!.payload.net_proceeds_cents, "56590333"); assert.equal(h.ofType("purchase_advice.received")[0]!.payload.advice_date, "2026-11-19");
  const same = h.timer("SM_WH_PROCEEDS_MATCH_SAME_DAY")!; assert.equal(same.dueDate, "2026-11-19"); assert.equal(new Date(same.dueAt!).toISOString(), et("2026-11-19", "18:00")); assert.equal(same.status, "satisfied", "satisfied by proceeds.matched at 11:02 ET");
  assert.equal(out.status, "matched"); assert.equal(out.variance_cents, "0"); assert.equal(out.interest_convention_observed, "a_30_360"); assert.equal(out.expected_proceeds_cents, "56590333"); assert.equal(out.received_cents, "56590333");
  const matched = h.ofType("proceeds.matched")[0]!; assert.equal(matched.payload.variance_cents, "0"); assert.equal(matched.loanId, LOAN); assert.equal(matched.applicationId, APP);
  assert.equal(h.rt.store.get("warehouse_partners", F.partner_id)!.data.fnma_interest_convention, "a_30_360", "locked for the partner on the first production advice (27.2-Q1)");
  assert.equal(h.ofType("fnma_interest_convention.locked").length, 1); assert.equal(h.rt.store.get("proceeds_receipts", "FED-20261119-0001")!.data.status, "matched"); assert.equal(h.rt.store.get("purchase_advices", `pa-${FNMA_NO}-2026-11-19`)!.data.status, "matched");
  assert.equal(h.timer("SM_WH_PAYOFF_POST_SAME_DAY")!.status, "armed"); assert.equal(h.timer("SM_MSR_HANDOFF_1BD")!.dueDate, "2026-11-20");
  assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "purchase_proceeds_receivable" as never }), 0n, "the receipt clears the delivery forecast"); assert.equal(h.ledger.balance({ scope: "custodial", custodialAccountId: COLL, account: "sm_collection_cash" as never }), 56_590_333n);
  assert.equal(h.decisions.at(-1)!.action, "matchProceeds");
});

test("27.2-T2: Given the same advice but the credited amount $565,918.36, when matching runs with `fnma_interest_convention = unresolved`, then the variance $15.03 is classified `convention_cents` and the match is `matched_with_variance` with convention B recorded; given the partner is already locked to A, then `exception{convention_changed}` and an `officer{sm}` escalation.", async () => {
  const f = forecastA(); const adviceB = toAdvice(adviceA({ interest_cents: "108164", net_proceeds_cents: "56591836" }));
  const m = matchProceeds({ keys: KEYS, forecast: f, advice: adviceB, received_cents: 56_591_836n, receipt_account_ref: COLL, partner_convention: "unresolved", collection_account_ref: COLL, expected_payee_code: null });
  assert.equal(m.variance_cents, 1_503n, "$565,918.36 − $565,903.33 = $15.03"); assert.equal(m.variance_breakdown.convention_cents, 1_503n); assert.equal(m.variance_breakdown.interest_cents, 0n); assert.equal(m.variance_breakdown.unexplained_cents, 0n);
  assert.equal(m.status, "matched_with_variance"); assert.equal(m.tolerance_rule_applied, "explained_le_10000_cents"); assert.equal(m.interest_convention_observed, "b_act_365"); assert.equal(m.convention_action, "lock"); assert.equal(m.convention_after, "b_act_365", "convention B recorded for the partner");
  const bd = explainVariance(f, adviceB, 56_591_836n, "a_30_360", "b_act_365"); assert.equal(bd.breakdown.convention_cents, 1_503n, "signed B (−$1,081.64) − signed A (−$1,096.67)"); assert.equal(bd.breakdown.interest_cents, 0n); assert.equal(bd.variance_cents, 1_503n);
  // locked to A already: the flip is an exception, officer{sm} reviews, both conventions stay stored
  const locked = matchProceeds({ keys: KEYS, forecast: f, advice: adviceB, received_cents: 56_591_836n, receipt_account_ref: COLL, partner_convention: "a_30_360", collection_account_ref: COLL, expected_payee_code: null });
  assert.equal(locked.status, "exception"); assert.equal(locked.exception_kind, "convention_changed"); assert.equal(locked.convention_action, "changed"); assert.equal(locked.convention_after, "a_30_360");
  assert.deepEqual(locked.escalations.map((e) => [e.kind, e.role, e.party]), [["officer", "officer", "sm"]]); assert.deepEqual(f.conventions_stored, ["a_30_360", "b_act_365"]);
  // on the bus, unresolved partner
  const h = harness(et("2026-11-16", "10:00"));
  const out = await h.throughMatch({ interest_cents: "108164", net_proceeds_cents: "56591836" }, "56591836");
  assert.equal(out.status, "matched_with_variance"); assert.equal(out.variance_cents, "1503"); assert.equal((out.variance_breakdown as Record<string, string>).convention_cents, "1503");
  assert.equal(h.rt.store.get("warehouse_partners", F.partner_id)!.data.fnma_interest_convention, "b_act_365"); assert.equal(h.timer("SM_WH_PROCEEDS_MATCH_SAME_DAY")!.status, "satisfied");
  // on the bus, partner locked to A beforehand
  const g = harness(et("2026-11-16", "10:00"));
  g.rt.store.put("warehouse_partners", F.partner_id, { partner_id: F.partner_id, fnma_interest_convention: "a_30_360", locked_at: et("2026-10-30", "12:00") }, AGENT, g.clock.now());
  const ex = await g.throughMatch({ interest_cents: "108164", net_proceeds_cents: "56591836" }, "56591836");
  assert.equal(ex.status, "exception"); assert.equal(ex.exception_kind, "convention_changed");
  assert.equal(g.ofType("proceeds.exception")[0]!.payload.kind, "convention_changed"); assert.equal(g.ofType("proceeds.matched").length, 0); assert.equal(g.timer("SM_WH_PROCEEDS_MATCH_SAME_DAY")!.status, "armed");
  const esc = g.rt.escalations.opened.find((e) => e.kind === "officer")!; assert.equal(esc.ownerRole, "officer"); assert.equal(esc.payload.party, "sm"); assert.match(String(esc.payload.reason), /convention_changed/);
  assert.equal(g.rt.store.get("warehouse_partners", F.partner_id)!.data.fnma_interest_convention, "a_30_360", "the lock is not flipped by the agent"); assert.equal(g.rt.store.get("warehouse_partners", F.partner_id)!.data.both_conventions_kept, true);
});

test("27.2-T3: Given the matched receipt of $565,903.33 and the 27.1 payoff statement $549,550.64, when the waterfall posts, then SM cost recovery = $3,485.00, SM retained = $2,815.00, partner residual = $10,052.69, `warehouse.advance.repaid{repaid_from=purchase_proceeds}` is emitted with repaid_at = Nov 19, and the residual wire is scheduled for Fri Nov 20 pending `funding_approver` approval.", async () => {
  const payoff = payoffA(); assert.equal(payoff.total_cents, 54_955_064n, "27.1 example A: $548,800.00 + $725.64 + $25.00"); assert.equal(payoff.accrued_not_capitalized_cents, 72_564n);
  const w = settlementWaterfall({ received_cents: 56_590_333n, payoff, third_party_costs_actual_cents: 348_500n, quote_third_party_costs_cents: 348_500n, quote_sm_retained_cents: 281_500n, value_date: D("2026-11-19") });
  assert.equal(w.warehouse_paid_cents, 54_955_064n); assert.equal(w.shortfall_cents, 0n); assert.equal(w.sm_cost_recovery_cents, 348_500n); assert.equal(w.sm_cost_recovery_cap_cents, 383_350n, "forecast × 110%"); assert.equal(w.sm_retained_residual_cents, 281_500n); assert.equal(w.partner_residual_cents, 1_005_269n, "$565,903.33 − $549,550.64 − $3,485.00 − $2,815.00 = $10,052.69");
  assert.equal(w.partner_wire_value_date, "2026-11-20"); assert.equal(w.partner_wire_required, true); assert.equal(w.warehouse_repaid_in_full, true);
  assert.deepEqual(costRecoveryDue(400_000n, 348_500n), { cap_cents: 383_350n, due_cents: 383_350n, excess_sm_cents: 16_650n }, "invoices above the cap are SM's");
  const h = harness(et("2026-11-16", "10:00"));
  const { w: out } = await h.throughWaterfall();
  assert.equal((out.payoff as Record<string, string>).total_cents, "54955064", "computed from 27.1's advance and accrual records with payoffStatement"); assert.equal(out.sm_cost_recovery_cents, "348500"); assert.equal(out.sm_retained_residual_cents, "281500"); assert.equal(out.partner_residual_cents, "1005269");
  const repaid = h.ofType("warehouse.advance.repaid")[0]!; assert.equal(repaid.payload.repaid_from, "purchase_proceeds"); assert.equal(repaid.payload.repaid_at, "2026-11-19"); assert.equal(repaid.payload.bank_matched, true); assert.equal(repaid.payload.note_form, "enote"); assert.equal(repaid.payload.amount_cents, "54955064"); assert.equal(repaid.loanId, LOAN); assert.equal(repaid.applicationId, APP);
  assert.equal(h.rt.store.get("warehouse_advances", ADV)!.data.status, "repaid"); assert.equal(h.rt.store.get("warehouse_advances", ADV)!.data.repaid_from, "purchase_proceeds"); assert.equal(h.rt.store.get("warehouse_advances", ADV)!.data.proceeds_match_id, h.rt.store.get("settlement_loans", LOAN)!.data.match_id);
  assert.equal(h.timer("SM_WH_PAYOFF_POST_SAME_DAY")!.status, "satisfied"); assert.equal(h.timer("SM_WH_BAILEE_RELEASE_SAME_DAY"), undefined, "eNote: no bailee clock"); assert.equal(h.ofType("warehouse.collateral.status_changed")[0]!.payload.to, "released", "Funding Agreement release on payment; chain closed");
  // the residual wire: scheduled for Fri Nov 20 (next federal business day), handed to funding_approver under dual control; the agent cannot release it
  const pkg = out.residual_package as Record<string, unknown>; assert.equal(pkg.value_date, "2026-11-20"); assert.equal(pkg.amount_cents, "1005269"); assert.equal(pkg.handed_to, "funding_approver"); assert.equal(pkg.released, false);
  const esc = h.rt.escalations.opened.find((e) => e.kind === "funding_approver")!; assert.equal(esc.status, "open"); assert.equal(esc.ownerRole, "funding_approver");
  const residualTimer = h.timer("SM_WH_PARTNER_RESIDUAL_1BD")!; assert.equal(residualTimer.dueDate, "2026-11-20"); assert.equal(residualTimer.status, "armed");
  await h.refused(h.run("funding_approver", { loan_id: LOAN }), "HUMAN_ONLY"); await h.refused(h.run("schedulePartnerResidual", { loan_id: LOAN, op: "release" }), "RESIDUAL_NEEDS_FUNDING_APPROVER");
  // ledger: the warehouse receivables are cleared, the partner payable holds the residual, the partner mirror balances with gain_on_sale = net proceeds − UPB
  assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "warehouse_advance_receivable.principal" as never }), -54_880_000n, "seeded principal was never debited in this harness: the waterfall credit is the full principal");
  assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "partner_settlement_payable" as never }), -1_005_269n); assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "gain_on_sale" as never }), -590_333n); assert.equal(h.ledger.balance({ scope: "corporate", account: "sm_program_margin" as never }), -281_500n);
  h.at(et("2026-11-20", "09:30")); const paid = await h.run("funding_approver", { loan_id: LOAN, wire_verification_id: "wv-partner-residual-1" }, FUNDING_APPROVER);
  assert.equal(paid.amount_cents, "1005269"); assert.equal(paid.value_date, "2026-11-20"); assert.equal(h.ofType("partner.residual.paid")[0]!.payload.dual_control, true); assert.equal(residualTimer.status, "satisfied"); assert.equal(esc.status, "completed");
  assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "partner_settlement_payable" as never }), 0n); assert.equal(h.rt.store.get("settlement_loans", LOAN)!.data.status, "settled");
});

test("27.2-T4: Given the purchase fixture purchased Wed Dec 2, 2026 with LPI Dec 1, then the forecast interest is +$70.10 (due lender, convention A) and net $416,190.10; the partner residual is $7,732.38; `SM_WH_BAILEE_RELEASE_SAME_DAY.due_at` = Dec 2 and `SM_WH_INTERIM_FUNDER_RELEASE_2BD.due_at` = Fri Dec 4, 2026.", async () => {
  const f = forecastProceeds({ upb_cents: 41_200_000n, price: "101.000", llpa_items: [], remittance_type: "aa", purchase_date: D("2026-12-02"), lpi_date: D("2026-12-01"), pass_through_rate: "0.06125", fees_cents: 0n, matrix_version: MATRIX });
  assert.equal(f.interest.direction, "due_lender"); assert.equal(f.interest.days_a, 1); assert.equal(f.interest.signed_a, 7_010n, "$412,000 × 0.06125 × 1/360 = +$70.10"); assert.equal(f.interest.cents_b, 6_914n, "actual/365: $69.14");
  assert.equal(f.expected_gross_cents, 41_612_000n, "$416,120.00"); assert.equal(f.expected_llpa_cents, 0n, "HomeReady LLPA waived"); assert.equal(f.expected_net_a_cents, 41_619_010n, "$416,190.10");
  const payoff = payoffC(); assert.equal(payoff.total_cents, 40_485_272n, "27.1 example B: $403,760.00 + $1,067.72 + $25.00");
  const w = settlementWaterfall({ received_cents: 41_619_010n, payoff, third_party_costs_actual_cents: 277_400n, quote_third_party_costs_cents: 277_400n, quote_sm_retained_cents: 83_100n, value_date: D("2026-12-02") });
  assert.equal(w.sm_cost_recovery_cents, 277_400n); assert.equal(w.sm_retained_residual_cents, 83_100n); assert.equal(w.partner_residual_cents, 773_238n, "$7,732.38"); assert.equal(w.partner_wire_value_date, "2026-12-03");
  assert.deepEqual(releasePlan("paper", D("2026-12-02")), { note_form: "paper", bailee_letter_release_due_on: D("2026-12-02"), interim_funder_removal_due_on: D("2026-12-04"), secured_party_release: "not_applicable", collateral_chain: "open_pending_interim_funder", c2_2_03_satisfied: true });
  const h = harness(et("2026-11-30", "10:00"), PLOAN, PAPP);
  h.seedAdvance(PADV, PLOAN, PAPP, 40_376_000n, "2026-11-18", "2026-12-01", "paper");
  await h.run("forecastProceeds", { op: "register", loan: purchaseLoan() }); const fc = await h.run("forecastProceeds", { loan_id: PLOAN });
  assert.equal(fc.expected_net_a_cents, "41619010"); assert.equal((fc.interest as Record<string, unknown>).direction, "due_lender"); assert.equal((fc.interest as Record<string, unknown>).signed_a, "7010");
  h.at(et("2026-12-01", "08:00")); await h.run("forecastProceeds", { loan_id: PLOAN, op: "certified", certification_date: "2026-12-01" }); assert.equal(h.timer("SM_WH_PROCEEDS_EXPECTED_1BD")!.dueDate, "2026-12-02");
  h.at(et("2026-12-02", "09:10")); await h.run("pollPurchaseAdvices", { advices: [adviceC()] });
  h.at(et("2026-12-02", "10:20")); await h.run("ingestReceipts", { receipts: [receipt("41619010", { bank_ref: "FED-20261202-0001", value_date: "2026-12-02", reference_text: `PAYEE SM-COLL-482 LOAN ${PFNMA_NO} ${PSELLER_NO}`, received_at: et("2026-12-02", "10:20") })] });
  h.at(et("2026-12-02", "10:45")); const m = await h.run("matchProceeds", { loan_id: PLOAN }); assert.equal(m.status, "matched"); assert.equal(m.variance_cents, "0");
  h.at(et("2026-12-02", "11:00")); const out = await h.run("postWaterfall", { loan_id: PLOAN });
  assert.equal(out.partner_residual_cents, "773238"); assert.equal((out.payoff as Record<string, string>).total_cents, "40485272");
  const repaid = h.ofType("warehouse.advance.repaid")[0]!; assert.equal(repaid.payload.note_form, "paper"); assert.equal(repaid.payload.repaid_at, "2026-12-02");
  const bailee = h.timer("SM_WH_BAILEE_RELEASE_SAME_DAY")!; assert.equal(bailee.dueDate, "2026-12-02"); assert.equal(bailee.status, "satisfied", "released to the custodian the same day (recordReleases)");
  const released = h.ofType("warehouse.bailee_letter.released")[0]!; assert.equal(released.payload.bailee_letter_id, "BL-2026-11-18"); assert.equal(released.payload.letter_status, "released"); assert.equal(released.payload.interim_funder_removal_due_on, "2026-12-04");
  const ifr = h.timer("SM_WH_INTERIM_FUNDER_RELEASE_2BD")!; assert.equal(ifr.dueDate, "2026-12-04", "Dec 2 + 2 servicer business days"); assert.equal(ifr.status, "armed");
  const st = await h.run("releaseCollateral", { loan_id: PLOAN }); assert.equal(st.collateral_chain, "open_pending_interim_funder"); assert.equal(st.interim_funder_removed, false);
  // 30.1 removes SM's Interim Funder Org ID (MIN Update accepted Thu Dec 3) and emits 27.2's satisfying event
  h.at(et("2026-12-03", "22:00")); h.upstream("warehouse.interim_funder.removed", { min: PMIN, mers_transaction_subtype: "interim_funder_removed", batch_on: "2026-12-03" }, et("2026-12-03", "22:00"), { loanId: PLOAN, applicationId: PAPP });
  assert.equal(ifr.status, "satisfied"); assert.equal((await h.run("releaseCollateral", { loan_id: PLOAN })).collateral_chain, "closed");
});

test("27.2-T5: Given an advice with LLPA $1,400.00 against a forecast of $700.00, then `proceeds.exception{kind=llpa}` is raised, the warehouse is still repaid in full, the partner residual is reduced by $700.00, `ppa_requests{kind=data_correction, channel=lsdu}` is prepared for `fnma_portal_operator{party=partner}`, and `FNMA_C2_2_05_PPA_REQUEST_30.due_at` = Sat Dec 19, 2026 (no business-day roll; the platform targets Fri Dec 18).", async () => {
  const llpa1400 = { llpa_items: [{ code: "LCOR_740_759_60_01_70", pct: "0.250", cents: "140000" }], llpa_total_cents: "140000", net_proceeds_cents: "56520333" };
  const m = matchProceeds({ keys: KEYS, forecast: forecastA(), advice: toAdvice(adviceA(llpa1400)), received_cents: 56_520_333n, receipt_account_ref: COLL, partner_convention: "unresolved", collection_account_ref: COLL, expected_payee_code: null });
  assert.equal(m.status, "exception"); assert.equal(m.exception_kind, "llpa"); assert.equal(m.variance_cents, -70_000n); assert.equal(m.variance_breakdown.llpa_cents, -70_000n); assert.equal(m.variance_breakdown.unexplained_cents, 0n); assert.equal(m.funds_transfer_error, false);
  const p = preparePpa({ ppa_id: "ppa-1", loan_id: LOAN, purchase_advice_id: "pa-1", kind: "data_correction", advice_date: D("2026-11-19"), purchase_date: D("2026-11-19"), amount_cents: 70_000n, seller_number: "123456789", fnma_loan_number: FNMA_NO });
  assert.equal(p.channel, "lsdu"); assert.equal(p.filed_by_role, "fnma_portal_operator"); assert.equal(p.party, "partner"); assert.equal(p.requires_human_submission, true); assert.equal(p.due_at, "2028-05-19", "29.4's 18-month lookback"); assert.equal(p.status, "draft");
  assert.equal(preparePpa({ ppa_id: "ppa-1s", loan_id: LOAN, purchase_advice_id: "pa-1", kind: "data_correction", advice_date: D("2026-11-19"), purchase_date: D("2026-11-19"), amount_cents: 9_999n, seller_number: "123456789", fnma_loan_number: FNMA_NO }).status, "below_threshold", "$100 minimum on LLPA PPAs");
  const ft = preparePpa({ ppa_id: "ppa-2", loan_id: LOAN, purchase_advice_id: "pa-1", kind: "funds_transfer_error", advice_date: D("2026-11-19"), purchase_date: D("2026-11-19"), amount_cents: 1_503n, seller_number: "123456789", fnma_loan_number: FNMA_NO });
  assert.equal(ft.due_at, "2026-12-19", "advice date + 30 calendar days, a Saturday — no roll"); assert.equal(ft.platform_target_on, "2026-12-18"); assert.equal(ft.channel, "email_acquisitions_loan_delivery");
  const h = harness(et("2026-11-16", "10:00"));
  const out = await h.throughMatch(llpa1400, "56520333");
  assert.equal(out.status, "exception"); assert.equal(out.exception_kind, "llpa"); assert.equal(h.ofType("proceeds.exception")[0]!.payload.kind, "llpa");
  const ppa = h.rt.store.list("ppa_requests", (d) => d.loan_id === LOAN)[0]!; assert.equal(ppa.data.kind, "data_correction"); assert.equal(ppa.data.channel, "lsdu"); assert.equal(ppa.data.status, "draft"); assert.equal(ppa.data.amount_cents, "70000"); assert.equal(ppa.data.filed_by_role, "fnma_portal_operator");
  const task = h.rt.escalations.opened.find((e) => e.kind === "human_portal_task")!; assert.equal(task.ownerRole, "fnma_portal_operator"); assert.equal(task.payload.party, "partner"); assert.equal(task.payload.reason, "ppa_lsdu_data_correction");
  const window = h.timer("FNMA_C2_2_05_PPA_REQUEST_30")!; assert.equal(window.dueDate, "2026-12-19"); assert.equal(window.anchorDate, "2026-11-19"); assert.equal(window.status, "armed", "no funds-transfer variance: nothing to file under C2-2-05");
  // the warehouse is still repaid in full; the partner residual carries the $700.00 until the PPA credit arrives
  h.at(et("2026-11-19", "11:30")); const w = await h.run("postWaterfall", { loan_id: LOAN });
  assert.equal(w.warehouse_repaid_in_full, true); assert.equal(w.sm_cost_recovery_cents, "348500"); assert.equal(w.partner_residual_cents, "935269", "$10,052.69 − $700.00 = $9,352.69"); assert.equal(h.ofType("warehouse.advance.repaid").length, 1);
  // the agent may not file under the partner's credentials; the human fnma_portal_operator{party=partner} does, which also satisfies 29.4's 18-month clock armed by loan.purchased
  h.upstream("loan.purchased", { purchase_date: "2026-11-19", acquisition_date: "2026-11-19", fnma_loan_number: FNMA_NO }, et("2026-11-19", "12:00"));
  const lookback = h.timer("FNMA_C1_2_02_PPA_LLPA_REPRICING_18M")!; assert.equal(lookback.dueDate, "2028-05-19");
  await h.refused(h.run("preparePpa", { loan_id: LOAN, op: "submit", ppa_id: ppa.id, channel: "lsdu" }), "PPA_LSDU_IS_HUMAN_PORTAL_OPERATOR"); await h.violated(h.run("preparePpa", { loan_id: LOAN, op: "submit", ppa_id: ppa.id }), "PPA_NOT_UNDER_PARTNER_CREDENTIALS");
  await h.refused(h.run("preparePpa", { loan_id: LOAN, op: "submit", ppa_id: ppa.id, use_partner_credentials: true }), "NO_PARTNER_CREDENTIALS");
  h.at(et("2026-11-20", "10:00")); const filed = await h.run("fnma_portal_operator", { op: "submit_ppa", ppa_id: ppa.id, fnma_reference: "LSDU-2026-11-20-0001" }, PORTAL_OPERATOR);
  assert.equal(filed.status, "submitted"); const req = h.ofType("ppa.requested")[0]!; assert.equal(req.payload.kind, "data_correction"); assert.equal(req.payload.channel, "lsdu"); assert.equal(req.actor.role, "fnma_portal_operator"); assert.equal(lookback.status, "satisfied"); assert.equal(task.status, "completed");
  h.at(et("2026-12-04", "10:00")); const res = await h.run("preparePpa", { loan_id: LOAN, op: "resolve", ppa_id: ppa.id, resolution_cents: "70000", outcome: "settled", fnma_reference: "PPA-CREDIT-1" });
  assert.equal(res.resolution_cents, "70000"); assert.equal(h.ofType("ppa.resolved")[0]!.payload.kind, "data_correction"); assert.equal(h.rt.store.get("proceeds_receipts", String(res.settlement_receipt_id))!.data.amount_cents, "70000", "the PPA credit re-enters as a positive receipt");
});

test("27.2-T6: Given a discount execution netting $542,103.33 against a payoff of $549,550.64, then `shortfall_cents = 744,731`, `SM_WH_SHORTFALL_DRAFT_2BD.due_at` = Mon Nov 23, 2026, SM's cost recovery becomes a partner receivable, and no partner residual wire is created.", async () => {
  const fD = forecastProceeds({ upb_cents: 56_000_000n, price: "99.000", llpa_items: [{ code: "DISCOUNT_2000", pct: "2.000" }], remittance_type: "aa", purchase_date: D("2026-11-19"), lpi_date: D("2026-12-01"), pass_through_rate: "0.05875", fees_cents: 0n, matrix_version: MATRIX });
  assert.equal(fD.expected_gross_cents, 55_440_000n, "$554,400.00"); assert.equal(fD.expected_llpa_cents, 1_120_000n, "$11,200.00"); assert.equal(fD.expected_net_a_cents, 54_210_333n, "$542,103.33");
  const w = settlementWaterfall({ received_cents: 54_210_333n, payoff: payoffA(), third_party_costs_actual_cents: 348_500n, quote_third_party_costs_cents: 348_500n, quote_sm_retained_cents: 281_500n, value_date: D("2026-11-19") });
  assert.equal(w.shortfall_cents, 744_731n, "$549,550.64 − $542,103.33 = $7,447.31"); assert.equal(w.warehouse_repaid_in_full, false); assert.equal(w.shortfall_draft_due_on, "2026-11-23");
  assert.equal(w.sm_cost_recovery_cents, 0n); assert.equal(w.sm_cost_recovery_receivable_cents, 348_500n, "SM's cost recovery becomes a partner receivable"); assert.equal(w.sm_retained_receivable_cents, 281_500n); assert.equal(w.partner_residual_cents, 0n); assert.equal(w.partner_wire_required, false); assert.equal(w.partner_wire_value_date, null);
  assert.equal(w.partner_receivable_cents, 744_731n + 348_500n + 281_500n); assert.equal(w.paid_principal_cents, 54_210_333n); assert.equal(w.paid_accrued_cents, 0n);
  const discount = { price: "99.000", llpa_items: [{ code: "DISCOUNT_2000", pct: "2.000" }], quote: { ...QUOTE_A, price: "99.000", llpa_total_pct: "2.000", third_party_costs_cents: "348500", lender_credit_cents: "70000", sm_retained_cents: "281500" } };
  const h = harness(et("2026-11-16", "10:00"));
  const m = await h.throughMatch({ price: "99.000", gross_price_proceeds_cents: "55440000", llpa_items: [{ code: "DISCOUNT_2000", pct: "2.000", cents: "1120000" }], llpa_total_cents: "1120000", net_proceeds_cents: "54210333" }, "54210333", discount);
  assert.equal(m.status, "matched");
  h.at(et("2026-11-19", "11:30")); const out = await h.run("postWaterfall", { loan_id: LOAN });
  assert.equal(out.shortfall_cents, "744731"); assert.equal(out.sm_cost_recovery_receivable_cents, "348500"); assert.equal(out.partner_residual_cents, "0"); assert.equal(out.residual_package, null); assert.equal(out.warehouse_repaid_in_full, false);
  assert.equal(h.rt.escalations.opened.some((e) => e.kind === "funding_approver"), false, "no partner residual wire"); assert.equal(h.ofType("warehouse.advance.repaid").length, 0, "not repaid until the draft arrives");
  const posted = h.ofType("settlement.waterfall.posted")[0]!; assert.equal(posted.payload.shortfall, true); assert.equal(posted.payload.shortfall_cents, "744731");
  const draft = h.timer("SM_WH_SHORTFALL_DRAFT_2BD")!; assert.equal(draft.dueDate, "2026-11-23", "Thu Nov 19 + 2 servicer business days"); assert.equal(draft.status, "armed"); assert.equal(h.ofType("settlement.shortfall.drafted")[0]!.payload.due_on, "2026-11-23");
  assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "sm_cost_recovery_receivable" as never }), 348_500n, "open receivable from the partner"); assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "warehouse_advance_receivable.principal" as never }), -54_210_333n);
  await h.refused(h.run("postWaterfall", { loan_id: LOAN, op: "write_off" }), "WRITEOFF_SETOFF_NEEDS_OFFICER"); await h.refused(h.run("postWaterfall", { loan_id: LOAN, op: "set_off" }), "WRITEOFF_SETOFF_NEEDS_OFFICER");
  // the partner's haircut-reserve draw on Mon Nov 23 repays the warehouse; the pass-through reconciliation flags the lock-time defect for 31.2
  h.at(et("2026-11-23", "10:00")); const draw = await h.run("postWaterfall", { loan_id: LOAN, op: "shortfall_received", amount_cents: "744731", source: "haircut_reserve_draw" });
  assert.equal(draw.repaid_in_full, true); assert.equal(draft.status, "satisfied"); assert.equal(h.ofType("warehouse.advance.repaid")[0]!.payload.repaid_from, "purchase_proceeds"); assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "warehouse_advance_receivable.principal" as never }), -54_880_000n);
  const recon = await h.run("reconcilePassthrough", { loan_id: LOAN }); assert.equal(recon.status, "exception"); assert.ok((recon.flags as string[]).includes("not_priceable_should_have_returned_at_lock")); assert.ok(recon.compliance_feed_escalation_id);
});

test("27.2-T7: Given example A settled Nov 19, when `SM_GOS_POST_1BD` runs, then `gain_on_sale_computations.actual.partner_origination_result_cents = −6,188`, `rate_passthrough_reconciliations.surplus_cents = 0`, `status = reconciled`, evidence ids include the quote solve trace, lock, final CD, note and advice; given example B (price 100.875), then the partner result is again −$61.88 and `sm_retained_residual_cents = 1,500`.", async () => {
  const adv = toAdvice(adviceA());
  const gA = computeGainOnSale({ upb_cents: 56_000_000n, quote: QUOTE_A, advice: adv, prepaid_interest_collected_cents: 178_543n, cd_lender_credit_cents: 70_000n, note_rate: "0.06125", third_party_costs_actual_cents: 348_500n, warehouse_interest_cents: 72_564n, warehouse_fees_cents: 2_500n, sm_cost_recovery_cents: 348_500n, sm_retained_residual_cents: 281_500n });
  assert.equal(gA.actual.gross_premium_cents, 770_000n, "$7,700.00"); assert.equal(gA.actual.net_premium_cents, 700_000n, "$7,000.00"); assert.equal(gA.actual.interest_carry_cents, 68_876n, "$1,785.43 − $1,096.67 = +$688.76"); assert.equal(gA.actual.warehouse_carry_cents, 75_064n, "$750.64");
  assert.equal(gA.actual.partner_origination_result_cents, -6_188n, "−$61.88 = $688.76 − $750.64"); assert.equal(gA.expected.net_premium_cents, 700_000n); assert.equal(gA.expected.by_construction, true, "$7,000.00 = $3,485.00 + $700.00 + $2,815.00");
  assert.equal(gA.gaap_view.gain_on_sale_cents, 590_333n); assert.equal(gA.gaap_view.interest_expense_cents, 75_064n); assert.equal(gA.recapture_exposure_cents, 770_000n); assert.equal(gA.recapture_exposure_until, "2027-03-19");
  const rA = reconcilePassthrough(gA, { note_rate: "0.06125", cd_lender_credit_cents: 70_000n, evidence: EVIDENCE });
  assert.equal(rA.surplus_cents, 0n); assert.equal(rA.status, "reconciled"); assert.equal(rA.borrower_post_closing_adjustment_cents, 0n); assert.deepEqual(rA.evidence_document_ids.slice(0, 5), ["doc-solve-1", "doc-lock-1", "doc-cd-final-1", "doc-note-1", "doc:pa-4001234567-2026-11-19.json"]);
  // example B: 100.875 → gross $564,900.00, premium $4,900.00, net wire $563,103.33, SM retained $15.00, residual identical, result invariant
  const advB = toAdvice(adviceA({ price: "100.875", gross_price_proceeds_cents: "56490000", net_proceeds_cents: "56310333" })); assert.equal(grossPremium("100.875", 56_000_000n), 490_000n);
  const wB = settlementWaterfall({ received_cents: 56_310_333n, payoff: payoffA(), third_party_costs_actual_cents: 348_500n, quote_third_party_costs_cents: 348_500n, quote_sm_retained_cents: 1_500n, value_date: D("2026-11-19") });
  assert.equal(wB.sm_retained_residual_cents, 1_500n); assert.equal(wB.partner_residual_cents, 1_005_269n, "identical to example A");
  const gB = computeGainOnSale({ upb_cents: 56_000_000n, quote: QUOTE_B, advice: advB, prepaid_interest_collected_cents: 178_543n, cd_lender_credit_cents: 70_000n, note_rate: "0.06125", third_party_costs_actual_cents: 348_500n, warehouse_interest_cents: 72_564n, warehouse_fees_cents: 2_500n, sm_cost_recovery_cents: 348_500n, sm_retained_residual_cents: 1_500n });
  assert.equal(gB.actual.partner_origination_result_cents, -6_188n); assert.equal(gB.actual.sm_retained_residual_cents, 1_500n); assert.equal(gB.expected.net_premium_cents, 420_000n, "$4,200.00 = $3,485.00 + $700.00 + $15.00"); assert.equal(gB.expected.by_construction, true); assert.equal(reconcilePassthrough(gB, { note_rate: "0.06125", cd_lender_credit_cents: 70_000n, evidence: EVIDENCE }).status, "reconciled");
  // on the bus: the clock runs from the Nov 19 posting to Fri Nov 20; computed and reconciled that morning
  const h = harness(et("2026-11-16", "10:00")); await h.throughWaterfall();
  const clock = h.timer("SM_GOS_POST_1BD")!; assert.equal(clock.dueDate, "2026-11-20"); assert.equal(clock.status, "armed");
  h.at(et("2026-11-20", "09:00")); const g = await h.run("computeGainOnSale", { loan_id: LOAN });
  assert.equal((g.actual as Record<string, string>).partner_origination_result_cents, "-6188"); assert.equal(h.rt.store.get("gain_on_sale_computations", String(g.gos_id))!.data.recapture_exposure_cents, "770000"); assert.equal(clock.status, "armed", "computed is not posted");
  const r = await h.run("reconcilePassthrough", { loan_id: LOAN });
  assert.equal(r.surplus_cents, "0"); assert.equal(r.status, "reconciled"); assert.ok(["doc-solve-1", "doc-lock-1", "doc-cd-final-1", "doc-note-1", "doc:pa-4001234567-2026-11-19.json"].every((d) => (r.evidence_document_ids as string[]).includes(d)));
  assert.equal(h.rt.store.get("rate_passthrough_reconciliations", String(r.recon_id))!.data.surplus_cents, "0"); assert.equal(h.ofType("rate_passthrough.reconciled")[0]!.payload.status, "reconciled"); assert.equal(h.ofType("gain_on_sale.posted")[0]!.payload.passthrough_reconciled, true); assert.equal(clock.status, "satisfied");
  await h.refused(h.run("reconcilePassthrough", { loan_id: LOAN, borrower_post_closing_credit: true }), "NO_BORROWER_ADJUSTMENT");
});

test("27.2-T8: Given example A, when the MSR hand-off is issued, then the payload contains exactly the rule-8 fields with UPB 56,000,000 cents, PTR 0.05875, servicing fee 25, remittance `aa`, purchase date 2026-11-19, first payment 2027-01-01, LPI 2026-12-01, P&I 340,262, platform fee 12.5 — and no valuation field.", async () => {
  assert.equal(scheduledPi(56_000_000n, "0.06125", 360), 340_262n, "$3,402.62");
  const p = msrHandoffPayload({ fnma_loan_number: FNMA_NO, seller_loan_number: SELLER_NO, upb_at_purchase_cents: 56_000_000n, note_rate: "0.06125", pass_through_rate: "0.05875", remittance_type: "aa", purchase_date: D("2026-11-19"), first_payment_date: D("2027-01-01"), lpi_date: D("2026-12-01"), term_months: 360, amortization_type: "fixed", product_code: "FNMA-30FRM", pi_cents: 340_262n, escrow_indicator: true, mi_flag: false, occupancy: "primary", property_state: "AZ", sfc_codes: ["007", "127", "508"], valuation_cents: 999n });
  assert.deepEqual(Object.keys(p).sort(), [...MSR_PAYLOAD_FIELDS].sort()); assert.equal((p as unknown as Record<string, unknown>).valuation_cents, undefined); assert.equal(p.servicing_fee_bps, 25); assert.equal(p.platform_fee_bps, 12.5);
  const h = harness(et("2026-11-16", "10:00")); await h.throughWaterfall();
  const clock = h.timer("SM_MSR_HANDOFF_1BD")!; assert.equal(clock.dueDate, "2026-11-20");
  await h.refused(h.run("issueMsrHandoff", { loan_id: LOAN, include_valuation: true }), "NO_MSR_VALUATION");
  h.at(et("2026-11-20", "09:30")); const out = await h.run("issueMsrHandoff", { loan_id: LOAN, channel: "partner_api" });
  const payload = out.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), [...MSR_PAYLOAD_FIELDS].sort(), "exactly the rule-8 fields"); assert.equal(out.valuation, null); assert.equal("valuation" in payload, false);
  assert.equal(payload.upb_at_purchase_cents, "56000000"); assert.equal(payload.pass_through_rate, "0.05875"); assert.equal(payload.servicing_fee_bps, 25); assert.equal(payload.remittance_type, "aa"); assert.equal(payload.purchase_date, "2026-11-19"); assert.equal(payload.first_payment_date, "2027-01-01"); assert.equal(payload.lpi_date, "2026-12-01"); assert.equal(payload.pi_cents, "340262"); assert.equal(payload.platform_fee_bps, 12.5);
  assert.equal(payload.fnma_loan_number, FNMA_NO); assert.equal(payload.note_rate, "0.06125"); assert.equal(payload.term_months, 360); assert.deepEqual(payload.sfc_codes, ["007", "127", "508"]); assert.equal(payload.property_state, "AZ"); assert.equal(payload.escrow_indicator, true); assert.equal(payload.mi_flag, false);
  assert.deepEqual(out.attachments, [`doc:pa-${FNMA_NO}-2026-11-19.json`], "purchase advice attached"); assert.equal(out.schema_version, "msr-handoff.v1");
  assert.equal(clock.status, "satisfied"); assert.equal(h.ofType("msr.handoff.issued")[0]!.payload.valuation, null);
  h.at(et("2026-11-20", "16:00")); await h.run("issueMsrHandoff", { loan_id: LOAN, op: "ack" }); assert.equal(h.ofType("msr.handoff.acknowledged").length, 1); assert.equal(h.rt.store.get("msr_handoffs", String(out.handoff_id))!.data.acknowledged_at, et("2026-11-20", "16:00"));
});

test("27.2-T9: Given purchase on Nov 19, 2026, when the monthly platform-fee accrual runs Dec 1, then November's fee is $23.33 (12/30 × $58.33) and December's is $58.33; given the Jan 1, 2027 payment reduces UPB to $559,455.71, then February's fee is $58.28.", async () => {
  assert.equal(monthlyPlatformFee(56_000_000n), 5_833n, "$560,000 × 0.00125 / 12 = $58.33");
  const nov = platformFeeAccrual({ upb_basis_cents: 56_000_000n, period: "2026-11", purchase_date: D("2026-11-19") });
  assert.deepEqual([nov.basis_rule, nov.days_accrued, nov.days_in_period, nov.fee_cents], ["prorated_first_period", 12, 30, 2_333n], "12/30 × $58.33 = $23.33");
  const dec = platformFeeAccrual({ upb_basis_cents: 56_000_000n, period: "2026-12", purchase_date: D("2026-11-19") }); assert.equal(dec.basis_rule, "full_month"); assert.equal(dec.fee_cents, 5_833n);
  const jan = upbAfterPayment(56_000_000n, "0.06125", 340_262n); assert.equal(jan.interest_cents, 285_833n); assert.equal(jan.upb_after_cents, 55_945_571n, "$559,455.71 after the Jan 1, 2027 payment");
  const feb = platformFeeAccrual({ upb_basis_cents: jan.upb_after_cents, period: "2027-02", purchase_date: D("2026-11-19") }); assert.equal(feb.fee_cents, 5_828n, "$58.28"); assert.equal(feb.days_in_period, 28);
  assert.equal(platformFeeAccrual({ upb_basis_cents: 56_000_000n, period: "2027-02", purchase_date: D("2026-11-19"), payoff_date: D("2027-02-15") }).basis_rule, "prorated_last_period");
  assert.throws(() => platformFeeAccrual({ upb_basis_cents: 56_000_000n, period: "2026-10", purchase_date: D("2026-11-19") }), /accrual begins at the Fannie Mae purchase date/);
  const h = harness(et("2026-11-16", "10:00")); await h.throughWaterfall();
  h.upstream("loan.purchased", { purchase_date: "2026-11-19", fnma_loan_number: FNMA_NO }, et("2026-11-19", "12:00"));
  const clock = h.timer("SM_PLATFORM_FEE_ACCRUAL_MONTHLY")!; assert.equal(clock.dueDate, "2026-12-01"); assert.equal(new Date(clock.dueAt!).toISOString(), et("2026-12-01", "03:00"));
  h.at(et("2026-12-01", "03:00")); const out = await h.run("accruePlatformFee", { period: "2026-11" });
  const row = (out.accruals as Record<string, unknown>[])[0]!; assert.equal(row.fee_cents, "2333"); assert.equal(row.basis_rule, "prorated_first_period"); assert.equal(row.days_accrued, 12);
  assert.equal(h.ofType("platform_fee.accrued")[0]!.payload.fee_cents, "2333"); assert.equal(clock.status, "satisfied"); assert.equal(h.timer("SM_PLATFORM_FEE_ACCRUAL_MONTHLY")!.dueDate, "2027-01-01", "re-armed for the next 1st");
  assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "platform_fee_receivable" as never }), 2_333n); assert.equal(h.ledger.balance({ scope: "corporate", account: "platform_fee_income" as never }), -2_333n);
  assert.equal(((await h.run("accruePlatformFee", { period: "2026-11" })).accruals as Record<string, unknown>[])[0]!.skipped, "already accrued", "catch-up runs are idempotent");
  h.at(et("2027-01-01", "03:00")); assert.equal(((await h.run("accruePlatformFee", { period: "2026-12", loan_id: LOAN })).accruals as Record<string, unknown>[])[0]!.fee_cents, "5833");
  h.at(et("2027-03-01", "03:00")); assert.equal(((await h.run("accruePlatformFee", { period: "2027-02", loan_id: LOAN, upb_basis_cents: "55945571" })).accruals as Record<string, unknown>[])[0]!.fee_cents, "5828");
});

test("27.2-T10: Given a receipt with no advice by 14:00 ET whose amount equals the forecast within $100, then a provisional match is created and confirmed when the advice arrives; given no advice by the next business day, then `proceeds.exception{kind=missing_advice}` and a Connect-report fallback task for `fnma_portal_operator`.", async () => {
  const f = forecastA();
  assert.equal(provisionalMatch(56_590_333n, f, "unresolved", et("2026-11-19", "13:00")).provisional, false, "before the 14:00 ET cut-off the receipt leg is held");
  assert.equal(provisionalMatch(56_590_333n + 9_999n, f, "unresolved", et("2026-11-19", "14:05")).provisional, true); assert.equal(provisionalMatch(56_590_333n + 10_001n, f, "unresolved", et("2026-11-19", "14:05")).provisional, false);
  assert.deepEqual(missingAdvice(D("2026-11-19"), D("2026-11-20")), { missing: false, deadline: D("2026-11-20") }); assert.deepEqual(missingAdvice(D("2026-11-19"), D("2026-11-23")), { missing: true, deadline: D("2026-11-20") });
  assert.deepEqual(splitReceipt(112_000_000n + 50n, [{ purchase_advice_id: "a", net_proceeds_cents: 56_000_000n }, { purchase_advice_id: "b", net_proceeds_cents: 56_000_000n }]), { allocations: [{ purchase_advice_id: "a", cents: 56_000_000n }, { purchase_advice_id: "b", cents: 56_000_050n }], suspense_cents: 0n }, "one wire, two loans: ≤ $1.00 per loan absorbed");
  const h = harness(et("2026-11-16", "10:00")); h.seedAdvance(ADV, LOAN, APP, 54_880_000n, "2026-11-12", "2026-11-18", "enote");
  await h.run("forecastProceeds", { op: "register", loan: refiLoan() }); await h.run("forecastProceeds", { loan_id: LOAN });
  h.at(et("2026-11-19", "10:40")); await h.run("ingestReceipts", { receipts: [receipt("56590333")] });
  h.at(et("2026-11-19", "13:00")); assert.equal((await h.run("matchProceeds", { loan_id: LOAN })).status, "held");
  h.at(et("2026-11-19", "14:05")); const prov = await h.run("matchProceeds", { loan_id: LOAN });
  assert.equal(prov.status, "provisional"); assert.equal(prov.variance_cents, "0"); assert.equal(h.ofType("proceeds.provisional_match").length, 1); assert.equal(h.rt.store.get("proceeds_receipts", "FED-20261119-0001")!.data.status, "provisional");
  await assert.rejects(h.run("postWaterfall", { loan_id: LOAN }), /provisional match is not settled/);
  h.at(et("2026-11-20", "06:10")); h.timers.evaluate(h.clock.now()); assert.equal(h.timer("SM_WH_PROCEEDS_MATCH_SAME_DAY")!.status, "breached", "18:00 ET Nov 19 passed without proceeds.matched");
  const poll = await h.run("pollPurchaseAdvices", { advices: [adviceA()] });
  assert.deepEqual(poll.confirmed_provisional, [String(prov.match_id)]); assert.equal(h.ofType("proceeds.matched").length, 1); assert.equal(h.rt.store.get("proceeds_receipts", "FED-20261119-0001")!.data.status, "matched"); assert.equal(h.rt.store.get("settlement_loans", LOAN)!.data.status, "matched");
  assert.equal(h.timer("SM_WH_PROCEEDS_MATCH_SAME_DAY")!.status, "satisfied_late", "confirmed the next morning, after the 18:00 ET same-day mark");
  // no advice by the next business day (Fri Nov 20): exception and the Connect fallback for the human portal operator, who enters the report
  const g = harness(et("2026-11-16", "10:00")); g.seedAdvance(ADV, LOAN, APP, 54_880_000n, "2026-11-12", "2026-11-18", "enote");
  await g.run("forecastProceeds", { op: "register", loan: refiLoan() }); await g.run("forecastProceeds", { loan_id: LOAN });
  g.at(et("2026-11-19", "10:40")); await g.run("ingestReceipts", { receipts: [receipt("56590333")] });
  g.at(et("2026-11-23", "06:10")); const miss = await g.run("matchProceeds", { loan_id: LOAN });
  assert.equal(miss.status, "exception"); assert.equal(miss.exception_kind, "missing_advice"); assert.equal(miss.deadline, "2026-11-20"); assert.equal(g.ofType("proceeds.exception")[0]!.payload.kind, "missing_advice");
  const task = g.rt.escalations.opened.find((e) => e.kind === "human_portal_task")!; assert.equal(task.ownerRole, "fnma_portal_operator"); assert.equal(task.payload.reason, "connect_report_fallback");
  await g.refused(g.run("fnma_portal_operator", { op: "connect_report", advices: [adviceA()] }), "HUMAN_ONLY");
  g.at(et("2026-11-23", "09:30")); const rep = await g.run("fnma_portal_operator", { op: "connect_report", advices: [adviceA()] }, PORTAL_OPERATOR);
  assert.equal(rep.source, "connect_report"); assert.equal(task.status, "completed"); assert.equal(g.rt.store.get("purchase_advices", `pa-${FNMA_NO}-2026-11-19`)!.data.source, "connect_report");
  assert.equal((await g.run("matchProceeds", { loan_id: LOAN })).status, "matched");
});

test("27.2-T11: Given the nightly GL export at 20:00 ET, then every ledger entry created that day appears exactly once across `sm_gl` and `partner_gl` batches with balanced control totals; a re-run produces no duplicate lines.", async () => {
  const sets = waterfallLedgerSets(LOAN, settlementWaterfall({ received_cents: 56_590_333n, payoff: payoffA(), third_party_costs_actual_cents: 348_500n, quote_third_party_costs_cents: 348_500n, quote_sm_retained_cents: 281_500n, value_date: D("2026-11-19") }), 56_000_000n);
  for (const s of [sets.sm, sets.partner_mirror]) assert.equal(compact(s)!.lines.reduce((t, l) => t + l.amountCents, 0n), 0n, "each set balances on its own target");
  const h = harness(et("2026-11-16", "10:00"));
  h.events.append({ type: "warehouse.facility.activated", aggregate: { kind: "warehouse_facility", id: F.facility_id }, actor: AGENT, occurredAt: et("2026-11-16", "09:00"), payload: { facility_id: F.facility_id, ucc1_filed_on: "2026-09-15", source: "origination" } });
  await h.throughWaterfall();
  const today = h.ledger.sets().filter((s) => s.postedAt.startsWith("2026-11-19")); const lineIds = today.flatMap((s) => s.lines.map((l) => l.id));
  assert.ok(today.length >= 4, "receipt, cost-recovery receivable, waterfall (SM) and the partner mirror were posted Nov 19"); assert.equal(h.ledger.sets().length, today.length + 1, "the Nov 16 forecast is not in the Nov 19 batch");
  const pure = buildGlBatches(h.ledger.sets(), D("2026-11-19"), new Set(), et("2026-11-19", "20:00"));
  assert.equal(pure.sm_gl.line_count + pure.partner_gl.line_count, lineIds.length); assert.equal(new Set(pure.exported_line_ids).size, lineIds.length); assert.equal(pure.sm_gl.control_totals.balanced, true); assert.equal(pure.partner_gl.control_totals.balanced, true);
  assert.ok(pure.partner_gl.lines.some((l) => l.account_code === "gain_on_sale")); assert.ok(pure.sm_gl.lines.some((l) => l.account_code === "sm_collection_cash")); assert.equal(pure.sm_gl.batch_id, "gl-sm_gl-2026-11-19");
  h.at(et("2026-11-19", "20:00")); const first = await h.run("exportGl", { period_date: "2026-11-19" });
  const batches = first.batches as Record<string, unknown>[]; assert.equal(first.new_lines, lineIds.length); assert.ok(batches.every((b) => (b.control_totals as Record<string, unknown>).balanced === true));
  const stored = () => ["gl-sm_gl-2026-11-19", "gl-partner_gl-2026-11-19"].flatMap((id) => (h.rt.store.get("gl_export_batches", id)!.data.lines as { ledger_entry_id: string }[]).map((l) => l.ledger_entry_id));
  assert.deepEqual([...stored()].sort(), [...lineIds].sort(), "every entry created that day exactly once across sm_gl and partner_gl");
  const done = h.ofType("gl.export.completed"); assert.deepEqual(done.map((e) => e.payload.target), ["sm_gl", "partner_gl"]); assert.equal(done[1]!.aggregate?.id, F.facility_id);
  const clocks = h.timers.byCode("SM_GL_EXPORT_DAILY"); assert.equal(clocks.length, 2); assert.equal(clocks[0]!.dueDate, "2026-11-17", "armed for the next servicer business day 20:00 ET from Monday's activation"); assert.equal(clocks[0]!.status, "satisfied"); assert.equal(clocks[1]!.dueDate, "2026-11-20", "re-armed for the next servicer business day"); assert.equal(new Date(clocks[1]!.dueAt!).toISOString(), et("2026-11-20", "20:00"));
  h.at(et("2026-11-19", "20:30")); const rerun = await h.run("exportGl", { period_date: "2026-11-19" });
  assert.equal(rerun.new_lines, 0); assert.deepEqual((rerun.batches as Record<string, unknown>[]).map((b) => b.batch_id), ["gl-sm_gl-2026-11-19", "gl-partner_gl-2026-11-19"], "same batch ids"); assert.equal(stored().length, lineIds.length, "no duplicate lines");
  await h.run("exportGl", { op: "ack", batch_id: "gl-partner_gl-2026-11-19" }); assert.equal(h.rt.store.get("gl_export_batches", "gl-partner_gl-2026-11-19")!.data.status, "acknowledged");
});

test("27.2-T12: Given a payoff of the fixture loan on Feb 15, 2027 (within 120 days of Nov 19, 2026), when Fannie Mae's recapture assessment of $7,700.00 arrives, then `premium_recapture.assessed` posts the partner-mirror reversal, `recapture_exposure_cents` closes, and SM's cost recovery is unchanged.", async () => {
  assert.deepEqual(recaptureExposure(770_000n, D("2026-11-19")), { cents: 770_000n, until: D("2027-03-19") }); assert.equal(recaptureExposure(-560_000n, D("2026-11-19")).cents, 0n, "no exposure on a discount execution");
  const g = computeGainOnSale({ upb_cents: 56_000_000n, quote: QUOTE_A, advice: toAdvice(adviceA()), prepaid_interest_collected_cents: 178_543n, cd_lender_credit_cents: 70_000n, note_rate: "0.06125", third_party_costs_actual_cents: 348_500n, warehouse_interest_cents: 72_564n, warehouse_fees_cents: 2_500n, sm_cost_recovery_cents: 348_500n, sm_retained_residual_cents: 281_500n });
  const r = assessPremiumRecapture(g, { payoff_date: D("2027-02-15"), assessed_cents: 770_000n, purchase_date: D("2026-11-19") });
  assert.deepEqual(r, { within_window: true, assessed_cents: 770_000n, allocation: "partner", sm_cost_recovery_cents_after: 348_500n, recapture_exposure_cents_after: 0n, days_after_purchase: 88 });
  assert.equal(assessPremiumRecapture(g, { payoff_date: D("2027-03-20"), assessed_cents: 770_000n, purchase_date: D("2026-11-19") }).within_window, false, "day 121: outside C1-1-01's window");
  const h = harness(et("2026-11-16", "10:00")); await h.throughWaterfall();
  h.at(et("2026-11-20", "09:00")); const gos = await h.run("computeGainOnSale", { loan_id: LOAN }); await h.run("reconcilePassthrough", { loan_id: LOAN });
  const before = h.ledger.balance({ scope: "loan", loanId: LOAN, account: "gain_on_sale" as never });
  await h.refused(h.run("computeGainOnSale", { loan_id: LOAN, op: "premium_recapture", assessed_cents: "770000", payoff_date: "2027-02-15", claw_back_cost_recovery: true }), "NO_COST_RECOVERY_CLAWBACK");
  h.at(et("2027-02-16", "10:00")); const out = await h.run("computeGainOnSale", { loan_id: LOAN, op: "premium_recapture", assessed_cents: "770000", payoff_date: "2027-02-15", fnma_reference: "RECAP-2027-02-0001" });
  assert.equal(out.within_window, true); assert.equal(out.allocation, "partner"); assert.equal(out.recapture_exposure_cents, "0"); assert.equal(out.sm_cost_recovery_cents, "348500", "SM's cost recovery is unchanged (27.2-Q4)");
  const e = h.ofType("premium_recapture.assessed")[0]!; assert.equal(e.payload.assessed_cents, "770000"); assert.equal(e.payload.sm_cost_recovery_clawed_back, false); assert.equal(e.payload.within_window, true);
  assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "gain_on_sale" as never }) - before, 770_000n, "partner-mirror reversal: Dr gain_on_sale $7,700.00"); assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "premium_recapture_payable" as never }), -770_000n);
  const row = h.rt.store.get("gain_on_sale_computations", String(gos.gos_id))!.data; assert.equal(row.recapture_exposure_cents, "0"); assert.equal(row.recapture_assessed_cents, "770000"); assert.equal((row.actual as Record<string, string>).sm_cost_recovery_cents, "348500");
  assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "sm_cost_recovery_receivable" as never }), 0n, "recovered at the waterfall and never reversed");
});

test("27.2 worked figures: examples A–D reproduced by the calculators (forecast, match, waterfall, gain on sale, fee)", () => {
  // example A — $560,000 at 6.125%, PTR 5.875%, price 101.375, LLPA 0.125%, purchased Thu Nov 19 (A/A, paid ahead to Dec 1)
  const pre = prepaidInterest(56_000_000n, "0.06125", 19); assert.equal(pre.per_diem_cents, 9_397n); assert.equal(pre.prepaid_interest_cents, 178_543n, "19 × $93.97 = $1,785.43");
  assert.equal(days30_360(D("2026-11-19"), D("2026-12-01")), 12); assert.equal(purchaseInterest(56_000_000n, "0.05875", "aa", D("2026-11-19"), D("2026-12-01")).cents_b, 108_164n, "$1,081.64");
  const fA = forecastA(); assert.equal(fA.expected_gross_cents, 56_770_000n, "$567,700.00"); assert.equal(fA.expected_llpa_cents, 70_000n, "$700.00"); assert.equal(fA.interest.cents_a, 109_667n, "$1,096.67"); assert.equal(fA.expected_net_a_cents, 56_590_333n, "$565,903.33"); assert.equal(fA.expected_net_b_cents, 56_591_836n, "$565,918.36");
  assert.equal(grossPremium("101.375", 56_000_000n), 770_000n, "$7,700.00"); assert.equal(770_000n - fA.expected_llpa_cents, 700_000n, "$7,000.00 net premium");
  const payoff = payoffA(); assert.equal(payoff.accrued_not_capitalized_cents, 72_564n); assert.equal(payoff.total_cents, 54_955_064n);
  const wA = settlementWaterfall({ received_cents: 56_590_333n, payoff, third_party_costs_actual_cents: 348_500n, quote_third_party_costs_cents: 348_500n, quote_sm_retained_cents: 281_500n, value_date: D("2026-11-19") });
  assert.equal(wA.sm_cost_recovery_cents, 348_500n, "$3,485.00"); assert.equal(wA.sm_retained_residual_cents, 281_500n, "$2,815.00"); assert.equal(wA.partner_residual_cents, 1_005_269n, "$10,052.69");
  assert.equal(281_500n + 70_000n, 351_500n, "20.4-Q1: residual $3,515.00 less the $700.00 credit cap = $2,815.00 retained");
  const gA = computeGainOnSale({ upb_cents: 56_000_000n, quote: QUOTE_A, advice: toAdvice(adviceA()), prepaid_interest_collected_cents: pre.prepaid_interest_cents, cd_lender_credit_cents: 70_000n, note_rate: "0.06125", third_party_costs_actual_cents: 348_500n, warehouse_interest_cents: payoff.accrued_not_capitalized_cents, warehouse_fees_cents: payoff.fees_cents, sm_cost_recovery_cents: wA.sm_cost_recovery_cents, sm_retained_residual_cents: wA.sm_retained_residual_cents });
  assert.equal(gA.actual.interest_carry_cents, 68_876n, "$688.76"); assert.equal(gA.actual.warehouse_carry_cents, 75_064n, "$750.64"); assert.equal(gA.actual.partner_origination_result_cents, -6_188n, "−$61.88"); assert.equal(gA.recapture_exposure_cents, 770_000n);
  assert.equal(-844_957n + 1_005_269n - 166_500n, -6_188n, "partner cash check: −$8,449.57 contribution + $10,052.69 residual − $1,665.00 escrow deposit = −$61.88");
  assert.equal(scheduledPi(56_000_000n, "0.06125", 360), 340_262n, "P&I $3,402.62"); assert.equal(upbAfterPayment(56_000_000n, "0.06125", 340_262n).upb_after_cents, 55_945_571n, "$559,455.71");
  assert.equal(platformFeeAccrual({ upb_basis_cents: 56_000_000n, period: "2026-11", purchase_date: D("2026-11-19") }).fee_cents, 2_333n, "$23.33"); assert.equal(monthlyPlatformFee(56_000_000n), 5_833n, "$58.33"); assert.equal(monthlyPlatformFee(55_945_571n), 5_828n, "$58.28");
  assert.equal(56_000_000n * 25n / 10_000n, 140_000n, "the partner's return: the 25 bps strip, $1,400.00/yr at origination UPB");
  // example B — 100.875: gross $564,900.00, premium $4,900.00, net wire $563,103.33, SM retained $15.00, expected net premium $4,200.00
  const fB = forecastProceeds({ upb_cents: 56_000_000n, price: "100.875", llpa_items: [{ code: "LCOR", pct: "0.125" }], remittance_type: "aa", purchase_date: D("2026-11-19"), lpi_date: D("2026-12-01"), pass_through_rate: "0.05875", fees_cents: 0n, matrix_version: MATRIX });
  assert.equal(fB.expected_gross_cents, 56_490_000n, "$564,900.00"); assert.equal(grossPremium("100.875", 56_000_000n), 490_000n, "$4,900.00"); assert.equal(fB.expected_net_a_cents, 56_310_333n, "$563,103.33");
  const wB = settlementWaterfall({ received_cents: fB.expected_net_a_cents, payoff, third_party_costs_actual_cents: 348_500n, quote_third_party_costs_cents: 348_500n, quote_sm_retained_cents: 1_500n, value_date: D("2026-11-19") });
  assert.equal(wB.sm_retained_residual_cents, 1_500n, "$15.00"); assert.equal(wB.partner_residual_cents, 1_005_269n); assert.equal(490_000n - 70_000n, 420_000n, "$4,200.00 = $3,485.00 + $700.00 + $15.00"); assert.equal(348_500n + 70_000n + 1_500n, 420_000n);
  // example C — purchase fixture: $412,000 at 6.375%, PTR 6.125%, 101.000, LLPA waived, purchased Wed Dec 2 (one day after LPI)
  const preC = prepaidInterest(41_200_000n, "0.06375", 13); assert.equal(preC.per_diem_cents, 7_196n, "$71.96"); assert.equal(preC.prepaid_interest_cents, 93_548n, "13 × $71.96 = $935.48");
  const fC = forecastProceeds({ upb_cents: 41_200_000n, price: "101.000", llpa_items: [], remittance_type: "aa", purchase_date: D("2026-12-02"), lpi_date: D("2026-12-01"), pass_through_rate: "0.06125", fees_cents: 0n, matrix_version: MATRIX });
  assert.equal(fC.interest.signed_a, 7_010n, "+$70.10 due lender"); assert.equal(fC.interest.cents_b, 6_914n, "$69.14"); assert.equal(fC.expected_gross_cents, 41_612_000n, "$416,120.00"); assert.equal(fC.expected_net_a_cents, 41_619_010n, "$416,190.10");
  const pC = payoffC(); assert.equal(pC.total_cents, 40_485_272n); assert.equal(advanceAmount(F, 41_200_000n, 41_200_000n).advance_cents, 40_376_000n);
  const wC = settlementWaterfall({ received_cents: 41_619_010n, payoff: pC, third_party_costs_actual_cents: 277_400n, quote_third_party_costs_cents: 277_400n, quote_sm_retained_cents: 83_100n, value_date: D("2026-12-02") });
  assert.equal(wC.sm_cost_recovery_cents, 277_400n, "$2,774.00"); assert.equal(wC.sm_retained_residual_cents, 83_100n, "$831.00"); assert.equal(wC.partner_residual_cents, 773_238n, "$7,732.38");
  assert.equal(grossPremium("101.000", 41_200_000n), 412_000n, "$4,120.00"); assert.equal(412_000n - 51_500n, 360_500n, "premium $4,120.00 − credit $515.00 = $3,605.00"); assert.equal(277_400n + 83_100n, 360_500n, "= costs $2,774.00 + SM retained $831.00");
  assert.equal(preparePpa({ ppa_id: "p", loan_id: PLOAN, purchase_advice_id: "a", kind: "funds_transfer_error", advice_date: D("2026-12-02"), purchase_date: D("2026-12-02"), amount_cents: 1n, seller_number: "123456789", fnma_loan_number: PFNMA_NO }).due_at, "2027-01-01", "advice Dec 2 + 30 = New Year's Day");
  assert.equal(preparePpa({ ppa_id: "p", loan_id: PLOAN, purchase_advice_id: "a", kind: "funds_transfer_error", advice_date: D("2026-12-02"), purchase_date: D("2026-12-02"), amount_cents: 1n, seller_number: "123456789", fnma_loan_number: PFNMA_NO }).platform_target_on, "2026-12-31", "the platform files by Thu Dec 31");
  // example D — (i) LLPA $1,400.00 → net wire $565,203.33, residual $9,352.69; (ii) discount 99.000 / 2.000% → $554,400.00 − $11,200.00 − $1,096.67 = $542,103.33, shortfall 744,731
  const advD = toAdvice(adviceA({ llpa_items: [{ code: "LCOR_740_759", pct: "0.250", cents: "140000" }], llpa_total_cents: "140000", net_proceeds_cents: "56520333" })); assert.equal(advD.llpa_total_cents, 140_000n, "$1,400.00"); assert.equal(advD.net_proceeds_cents, 56_520_333n, "$565,203.33");
  const mD = matchProceeds({ keys: KEYS, forecast: fA, advice: advD, received_cents: 56_520_333n, receipt_account_ref: COLL, partner_convention: "unresolved", collection_account_ref: COLL, expected_payee_code: null }); assert.equal(mD.exception_kind, "llpa"); assert.equal(mD.variance_cents, -70_000n);
  assert.equal(settlementWaterfall({ received_cents: 56_520_333n, payoff, third_party_costs_actual_cents: 348_500n, quote_third_party_costs_cents: 348_500n, quote_sm_retained_cents: 281_500n, value_date: D("2026-11-19") }).partner_residual_cents, 935_269n, "$9,352.69");
  const fD = forecastProceeds({ upb_cents: 56_000_000n, price: "99.000", llpa_items: [{ code: "D", pct: "2.000" }], remittance_type: "aa", purchase_date: D("2026-11-19"), lpi_date: D("2026-12-01"), pass_through_rate: "0.05875", fees_cents: 0n, matrix_version: MATRIX });
  assert.equal(fD.expected_gross_cents, 55_440_000n, "$554,400.00"); assert.equal(fD.expected_llpa_cents, 1_120_000n, "$11,200.00"); assert.equal(fD.expected_net_a_cents, 54_210_333n, "$542,103.33");
  assert.equal(settlementWaterfall({ received_cents: 54_210_333n, payoff, third_party_costs_actual_cents: 348_500n, quote_third_party_costs_cents: 348_500n, quote_sm_retained_cents: 281_500n, value_date: D("2026-11-19") }).shortfall_cents, 744_731n);
  // tolerances: |variance| ≤ $1.00 → matched; ≤ $100.00 explained → matched_with_variance
  assert.equal(ECONOMICS_V1.rounding_tolerance_cents, 100n, "$1.00"); assert.equal(ECONOMICS_V1.explained_tolerance_cents, 10_000n, "$100.00"); assert.equal(ECONOMICS_V1.ppa_llpa_min_cents, 10_000n);
  assert.equal(matchProceeds({ keys: KEYS, forecast: fA, advice: toAdvice(adviceA()), received_cents: 56_590_333n + 100n, receipt_account_ref: COLL, partner_convention: "a_30_360", collection_account_ref: COLL, expected_payee_code: null }).status, "matched");
  assert.equal(matchProceeds({ keys: KEYS, forecast: fA, advice: toAdvice(adviceA()), received_cents: 56_590_333n + 101n, receipt_account_ref: COLL, partner_convention: "a_30_360", collection_account_ref: COLL, expected_payee_code: null }).exception_kind, "unexplained", "a funds-transfer difference above $1.00 is not explained by any advice component");
});
