// 23.4 ATR/QM, HPML, HOEPA, and state high-cost determinations
// spec/sections/23-desktop-underwriter-and-the-credit-decision/23-4-atr-qm-hpml-hoepa-and-state-high-cost-determinations.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandContext } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_23_4 } from "../../app/tools/section23-4.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { computeApr, ingestAporTable, perDiem365Rounded, prepaidInterest } from "../compliance-disclosures/ops-25-1.ts";
import { evaluateOriginationWaiver } from "../orig-boarding/ops-30-3.ts";
import { runDeterminations, recordDeterminations, classifyFeeItems, computeTotalLoanAmount, runQmTests, runHpmlTests, runHoepaTests, runStateHighCostTests, fnmaEligibility, aprTier, pfTier, selectApor, rateSetDate, supersede, assembleAtrEvidence, considerVerifyStatus, evaluateBonaFideDiscount,
  qmDeterminationGate, hoepaGate, stateHighCostGate, hpmlEscrowGate, proposeFeeRestructure, recordPfCureRequired, recordPfCurePaid, cancelEscrowRequest, hpmlClosingPayload, floorPct, nearThreshold, STATE_HIGH_COST_DEFINITIONS,
  type AporTableRow, type FeeItem23, type LockRow, type ProductTerms, type ConsiderVerifyFactor, type StageRunInput, type QmRow, type Classification23, type TotalLoanAmount } from "./ops-23-4.ts";
import { ruleSet, type QmRuleSet } from "../compliance-disclosures/ops-25-1.ts";

const AGENT: Actor = { kind: "agent", id: "compliance-tester" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const REFI = "APP-REFI-560K", PURCHASE = "APP-PURCH-412K";

/** APOR snapshots for the fixture weeks (README: Oct 5, Oct 19, Nov 2, 2026 — 6.020 % fixture value; 30-year fixed). */
const aporRow = (week: string, apor: string, extra: Partial<AporTableRow> = {}): AporTableRow => ({ table_id: `T-${week}`, published_on: D(week), effective_week: D(week), type: "fixed", rows: { "30": apor, "15": "5.400" }, source_url: "https://ffiec.cfpb.gov/tools/rate-spread", fetched_at: `${week}T13:05:00.000Z`, hash: `sha256:${week}`, ...extra });
const APOR_TABLES: AporTableRow[] = [aporRow("2026-10-05", "6.020"), aporRow("2026-10-19", "6.020"), aporRow("2026-11-02", "6.020")];
const LOCK_REFI: LockRow = { lock_id: "LK-REFI-1", kind: "initial", locked_at: "2026-10-07T15:10:00.000Z", rate_pct: "6.125", product: "fixed", term_years: 30 };
const LOCK_PURCHASE: LockRow = { lock_id: "LK-PUR-1", kind: "initial", locked_at: "2026-10-21T15:10:00.000Z", rate_pct: "6.375", product: "fixed", term_years: 30 };
const PRODUCT_30Y: ProductTerms = { term_months: 360, amortization: "fully_amortizing", substantially_equal_payments: true, arm: null };
const ev = (kind: string, id: string, source_process: string) => ({ kind, id, source_process });
/** The eight-factor consider-and-verify map from the processes that hold each fact (rule 4). */
const considerVerify = (creditReportId: string | null = "CR-2026-10-05-1"): ConsiderVerifyFactor[] => assembleAtrEvidence({
  income: { monthly_cents: 1_450_000n, evidence: [ev("paystub", "DOC-PAY-1", "22.3"), ev("w2", "DOC-W2-2025", "22.3"), ev("du_validation_income_report", "DUV-INC-1", "22.3")], standard_ref: "SG-2020-06-03/B3-3.1-01 ≡ SG-2026-09-02/B3-3.2-01" },
  employment: { status: "employed_w2", evidence: [ev("vvoe", "VVOE-1", "22.3")], standard_ref: "SG-2020-06-03/B3-3.1-04 ≡ SG-2026-09-02/B3-3.1-04" },
  payment: { pi_cents: 340_262n, basis: "note_rate_fully_amortizing", evidence: [ev("cd_projected_payments", "CD-1", "25.2")] },
  simultaneous_loans: { monthly_cents: 0n, evidence: [ev("credit_report", "CR-2026-10-05-1", "22.5")], standard_ref: "SG-2020-06-03/B3-6-02" },
  mortgage_obligations: { monthly_cents: 68_500n, evidence: [ev("escrow_analysis", "EA-1", "30.3"), ev("hoi_declaration", "HOI-1", "24.5")], standard_ref: "SG-2020-06-03/B3-6-03" },
  debts: { monthly_cents: 142_000n, alimony_child_support_cents: 0n, evidence: [ev("credit_report", "CR-2026-10-05-1", "22.5")], standard_ref: "SG-2020-06-03/B3-6-05" },
  dti: { pct: "38.00", evidence: [ev("dti_worksheet", "DTI-1", "22.5")], standard_ref: "SG-2020-06-03/B3-6-02" },
  credit_history: { report_id: creditReportId, pulled_at: D("2026-10-05"), standard_ref: "SG-2020-06-03/B3-5.1-01" },
});
/** Refinance fixture fee set (T2 / worked example 1): origination $1,995.00 creditor-retained; prepaid interest $1,785.43 (26.3's convention); credit report $75.00; unaffiliated title $1,800.00; recording $95.00. */
const REFI_FEES: FeeItem23[] = [
  { fee_item_id: "F-ORIG", service_code: "origination", description: "Origination fee", amount_cents: 199_500n, paid_to: "Partner Lender", paid_to_kind: "creditor", payee: "Partner Lender", retained_by_creditor: true },
  { fee_item_id: "F-PPI", service_code: "interest_prepaid", description: "Prepaid interest Nov 12–30 (19 × $93.97)", amount_cents: 178_543n, paid_to: "Partner Lender", paid_to_kind: "creditor", payee: "Partner Lender" },
  { fee_item_id: "F-CR", service_code: "credit_report", description: "Credit report", amount_cents: 7_500n, paid_to: "Xactus LLC", paid_to_kind: "third_party", payee: "Xactus LLC" },
  { fee_item_id: "F-TITLE", service_code: "settlement_fee", description: "Title / settlement services", amount_cents: 180_000n, paid_to: "Desert Title Agency", paid_to_kind: "third_party", payee: "Desert Title Agency", affiliate: false, reasonable: true },
  { fee_item_id: "F-REC", service_code: "recording", description: "Recording fee", amount_cents: 9_500n, paid_to: "Maricopa County Recorder", paid_to_kind: "public_official", payee: "Maricopa County Recorder" },
];
/** Purchase fixture itemization (worked example 2): the $9,800.00 set incl. $3,010.00 to the partner's affiliated title agency and a $2,060.00 non-bona-fide half point; BPMI monthly; prepaid interest Nov 18–30 $935.47 (the fixture's CD figure). */
const purchaseFees = (o: { affiliated?: boolean; extra_points?: { amount_cents: bigint; points: number } | null; prepaid_interest_cents?: bigint } = {}): FeeItem23[] => [
  { fee_item_id: "P-ORIG", service_code: "origination", description: "Origination fee", amount_cents: 299_500n, paid_to: "Partner Lender", paid_to_kind: "creditor", payee: "Partner Lender", retained_by_creditor: true },
  { fee_item_id: "P-UW", service_code: "underwriting", description: "Underwriting fee", amount_cents: 129_500n, paid_to: "Partner Lender", paid_to_kind: "creditor", payee: "Partner Lender", retained_by_creditor: true },
  { fee_item_id: "P-DOC", service_code: "document_preparation", description: "Document preparation", amount_cents: 44_000n, paid_to: "Partner Lender", paid_to_kind: "creditor", payee: "Partner Lender", retained_by_creditor: true },
  { fee_item_id: "P-PTS", service_code: "discount_points", description: "0.5 discount point", amount_cents: 206_000n, paid_to: "Partner Lender", paid_to_kind: "creditor", payee: "Partner Lender", discount_points: 0.5 },
  ...(o.extra_points ? [{ fee_item_id: "P-PTS-2", service_code: "discount_points" as const, description: `${o.extra_points.points} additional points`, amount_cents: o.extra_points.amount_cents, paid_to: "Partner Lender", paid_to_kind: "creditor" as const, payee: "Partner Lender", discount_points: o.extra_points.points }] : []),
  { fee_item_id: "P-TITLE", service_code: "settlement_fee", description: "Title services", amount_cents: 301_000n, paid_to: o.affiliated === false ? "Buckeye Independent Title" : "Partner Title Agency LLC", paid_to_kind: o.affiliated === false ? "third_party" : "affiliate", payee: o.affiliated === false ? "Buckeye Independent Title" : "Partner Title Agency LLC", affiliate: o.affiliated !== false, reasonable: true },
  { fee_item_id: "P-PPI", service_code: "interest_prepaid", description: "Prepaid interest Nov 18–30", amount_cents: o.prepaid_interest_cents ?? 93_547n, paid_to: "Partner Lender", paid_to_kind: "creditor", payee: "Partner Lender" },
  { fee_item_id: "P-BPMI", service_code: "mi_premium_monthly", description: "BPMI monthly premium", amount_cents: 17_167n, paid_to: "Arch MI", paid_to_kind: "third_party", payee: "Arch MI", mi_kind: "private", paid_at: "after_consummation" },
  { fee_item_id: "P-CR", service_code: "credit_report", description: "Credit report", amount_cents: 7_500n, paid_to: "Xactus LLC", paid_to_kind: "third_party", payee: "Xactus LLC" },
  { fee_item_id: "P-REC", service_code: "recording", description: "Recording fee", amount_cents: 12_400n, paid_to: "Franklin County Recorder", paid_to_kind: "public_official", payee: "Franklin County Recorder" },
];
const refiRun = (o: Partial<StageRunInput> & { apr?: string } = {}): StageRunInput => ({ application_id: REFI, stage: "cd", as_of: D("2026-11-02"), determined_at: "2026-11-02T16:00:00.000Z", apr_calculation_id: "APR-REFI-CD-1", apr: "6.159", locks: [LOCK_REFI], apor_tables: APOR_TABLES, loan_amount_cents: 56_000_000n, fee_items: REFI_FEES, product: PRODUCT_30Y, consider_verify: considerVerify(), lien: "first", principal_dwelling: true, state: "AZ", county: "Maricopa", consummation_date: D("2026-11-06"), escrow_established_before_consummation: true, computed_from_final_cd: true, ...o });
const purchaseRun = (o: Partial<StageRunInput> & { fees?: FeeItem23[] } = {}): StageRunInput => ({ application_id: PURCHASE, stage: "cd", as_of: D("2026-11-12"), determined_at: "2026-11-12T16:00:00.000Z", apr_calculation_id: "APR-PUR-CD-1", apr: "6.640", locks: [LOCK_PURCHASE], apor_tables: APOR_TABLES, loan_amount_cents: 41_200_000n, fee_items: o.fees ?? purchaseFees(), undiscounted_rate_pct: "8.10", buydown_evidence_ref: "PQ-2026-10-21-buydown", product: PRODUCT_30Y, consider_verify: considerVerify(), lien: "first", principal_dwelling: true, state: "OH", county: "Franklin", consummation_date: D("2026-11-18"), escrow_established_before_consummation: true, computed_from_final_cd: true, ...o });
const facts = (q: QmRow, command: string) => ({ ...(q as unknown as Record<string, unknown>), command });

/** The 23.4 tools on the bus over the overridden timer registry (23.4 rows only) and an entity store; `now` is the wall clock. */
function harness(applicationId: string, nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["23.4"] });
  const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const escalations = new EscalationService(events, clock);
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_23_4); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("23.4", name))!, actor, { application_id: applicationId, ...input }, uow)).output as Record<string, unknown>;
  const timer = (code: string) => timers.byCode(code).at(-1);
  return { clock, events, timers, uow, escalations, rt, run, timer, decisions };
}

test("23.4-T1: Given the refinance fixture with APR 6.159% (25.1's engine result) and APOR 6.020% at `cd` stage on Mon Nov 2, 2026, then `spread = 0.139`, `apr_tier = first_lien_ge_137958`, `apr_test_pass = true`, `hpct = false`, `qm_type = general_safe_harbor`, `is_hpml = false`, `is_hoepa = false`, and `REGZ_1026_43_QM_DETERMINATION_GATE` is open for `issueCD`.", () => {
  const h = harness(REFI, "2026-11-02T16:00:00.000Z");
  const r = runDeterminations(refiRun());
  assert.equal(r.rate_set.rate_set_date, "2026-10-07"); assert.equal(r.apor.table_id, "T-2026-10-05"); assert.equal(r.apor.apor_pct, "6.020"); assert.equal(r.apor.apor_stale, false);
  assert.equal(r.qm.apr, 6.159); assert.equal(r.qm.apor, 6.02); assert.equal(r.qm.spread, 0.139);
  assert.equal(r.qm.apr_tier, "first_lien_ge_137958"); assert.equal(r.qm.apr_threshold_pts, 2.25); assert.equal(r.qm.apr_test_pass, true); assert.equal(r.qm.hpct, false); assert.equal(r.qm.hpct_threshold_pts, 1.5);
  assert.equal(r.qm.product_tests_pass, true); assert.equal(r.qm.consider_verify_complete, true); assert.equal(r.qm.pf_pass, true);
  assert.equal(r.qm.qm_type, "general_safe_harbor"); assert.equal(r.qm.stage, "cd"); assert.equal(r.qm.rule_set_versions["regz.qm.general.2021"], "2026");
  assert.equal(r.hpml.is_hpml, false); assert.equal(r.hpml.threshold_pts, 1.5); assert.equal(r.hpml.above_conforming, false); assert.equal(r.hpml.escrow_required, false);
  assert.equal(r.high_cost.is_hoepa, false); assert.equal(r.high_cost.hoepa.apr_test.fail, false); assert.deepEqual(r.high_cost.state_tests, []); assert.equal(r.high_cost.fnma_eligible, true);
  // the gate: open for issueCD on the current-stage row (evaluator), and on the bus the determination event arms the row and compliance.test.passed{test=qm} closes it
  const g = qmDeterminationGate(r.qm, "issueCD"); assert.equal(g.open, true); assert.deepEqual(g.blocking_codes, []);
  assert.equal(evaluateGate("23.4.qmDeterminationGate", facts(r.qm, "issueCD")).open, true);
  const emitted = recordDeterminations(h.events, { application_id: REFI }, r);
  assert.deepEqual(emitted.map((e) => e.type), ["compliance.qm.determined", "compliance.test.passed", "compliance.hpml.determined", "compliance.test.passed", "compliance.high_cost.determined", "compliance.test.passed", "compliance.test.passed"]);
  assert.equal(emitted[0]!.payload.qm_type, "general_safe_harbor"); assert.equal(emitted[0]!.applicationId, REFI);
  const t = h.timer("REGZ_1026_43_QM_DETERMINATION_GATE")!; assert.equal(t.status, "satisfied"); assert.equal(t.note, "evaluator:23.4.qmDeterminationGate");
  assert.equal(h.timer("REGZ_1026_32_HOEPA_GATE")!.status, "satisfied"); assert.equal(h.timer("STATE_HIGH_COST_GATE")!.status, "satisfied");
});

test("23.4-T2: Given the refinance fixture fee set (origination $1,995.00; prepaid interest $1,785.43 per 26.3's convention; credit report $75.00; unaffiliated title $1,800.00; recording $95.00), then `amount_financed_cents = 55621957`, `total_loan_amount_cents = 55621957`, `cap_cents = 1668658`, `pf_cents = 199500`, and the excluded items carry reason codes `interest`, `bona_fide_third_party`, `reasonable_no_comp_not_affiliate`, and `not_finance_charge`.", () => {
  const c = classifyFeeItems(REFI_FEES, { as_of: D("2026-11-02"), apor_pct: "6.020", state: "AZ" });
  assert.equal(c.prepaid_finance_charges_cents, 378_043n);   // $1,995.00 + $1,785.43 = $3,780.43
  const t = computeTotalLoanAmount({ loan_amount_cents: 56_000_000n, prepaid_finance_charges_cents: c.prepaid_finance_charges_cents, pf_items: c.items });
  assert.equal(t.amount_financed_cents, 55_621_957n); assert.equal(t.financed_pf_items_cents, 0n); assert.equal(t.total_loan_amount_cents, 55_621_957n);
  const rs = ruleSet<QmRuleSet>("regz.qm.general.2021", D("2026-11-02")).content;
  assert.deepEqual(pfTier(t.total_loan_amount_cents, rs), { pf_tier: "pct3_ge_137958", cap_cents: 1_668_658n, cap_basis: "floor(3% × total loan amount 55621957)" });   // floor(1668658.71)
  assert.equal(c.pf_cents, 199_500n);
  const by = Object.fromEntries(c.items.map((x) => [x.fee_item_id, x]));
  assert.equal(by["F-ORIG"]!.included, true); assert.equal(by["F-ORIG"]!.category, "b1_i_finance_charge"); assert.equal(by["F-ORIG"]!.exclusion, null);
  assert.equal(by["F-PPI"]!.exclusion, "interest"); assert.equal(by["F-PPI"]!.included, false);
  assert.equal(by["F-CR"]!.exclusion, "bona_fide_third_party"); assert.equal(by["F-CR"]!.payee, "Xactus LLC");
  assert.equal(by["F-TITLE"]!.exclusion, "reasonable_no_comp_not_affiliate"); assert.equal(by["F-TITLE"]!.category, "b1_iii_real_estate");
  assert.equal(by["F-REC"]!.exclusion, "not_finance_charge"); assert.equal(by["F-REC"]!.category, null);
  assert.deepEqual([...c.exclusions].sort(), ["bona_fide_third_party", "interest", "not_finance_charge", "reasonable_no_comp_not_affiliate"]);
  assert.equal(c.bona_fide.max_excludable_points, 0); assert.match(c.bona_fide.basis, /undiscounted rate .* required/);
});

test("23.4-T3: Given the purchase fixture with the $9,800.00 itemization (including $3,010.00 to an affiliated title agency and a $2,060.00 non-bona-fide half point at undiscounted rate 8.10% vs APOR 6.020%), then `pf_cents = 980000`, `total_loan_amount_cents = 40427453`, `cap_cents = 1212824`, `qm_type = general_safe_harbor`; given the same loan with the title agency unaffiliated, then `pf_cents = 679000`.", () => {
  const r = runDeterminations(purchaseRun());
  assert.equal(r.rate_set.rate_set_date, "2026-10-21"); assert.equal(r.apor.table_id, "T-2026-10-19"); assert.equal(r.qm.spread, 0.62);
  assert.equal(r.fees.bona_fide.undiscounted_minus_apor, 2.08); assert.equal(r.fees.bona_fide.max_excludable_points, 0); assert.equal(r.fees.bona_fide_discount_points_excluded_cents, 0n);
  const by = Object.fromEntries(r.fees.items.map((x) => [x.fee_item_id, x]));
  assert.equal(by["P-PTS"]!.included_cents, 206_000n); assert.match(by["P-PTS"]!.basis, /not excludable/);
  assert.equal(by["P-TITLE"]!.included_cents, 301_000n); assert.match(by["P-TITLE"]!.basis, /paid to an affiliate/);
  assert.equal(by["P-DOC"]!.included_cents, 44_000n); assert.equal(by["P-BPMI"]!.exclusion, "pmi_after_consummation"); assert.equal(by["P-CR"]!.exclusion, "bona_fide_third_party");
  assert.equal(r.fees.pf_cents, 980_000n);
  assert.equal(r.fees.prepaid_finance_charges_cents, 772_547n);   // $2,995.00 + $1,295.00 + $440.00 + $2,060.00 + $935.47 = $7,725.47
  assert.equal(r.total.amount_financed_cents, 40_427_453n); assert.equal(r.total.total_loan_amount_cents, 40_427_453n);   // $404,274.53 (the affiliate title fee is paid in cash, not financed)
  // spec T3 says cap_cents = 1212824 ($12,128.24 = HALF_UP of 1212823.59); rule 3 "the cap is floor(total_loan_amount_cents × 3 / 100)" gives 1212823 — the floor wins (25.1's HALF_UP figure is kept on the row)
  assert.equal(r.qm.cap_cents, 1_212_823n); assert.equal(r.qm.cap_cents_25_1, 1_212_824n); assert.equal(r.qm.pf_tier, "pct3_ge_137958");
  assert.equal(r.qm.pf_pass, true); assert.equal(r.qm.qm_type, "general_safe_harbor"); assert.equal(r.hpml.is_hpml, false); assert.equal(r.high_cost.is_hoepa, false); assert.equal(r.high_cost.fnma_eligible, true);
  const un = runDeterminations(purchaseRun({ fees: purchaseFees({ affiliated: false }) }));
  assert.equal(un.fees.pf_cents, 679_000n); assert.equal(un.fees.items.find((x) => x.fee_item_id === "P-TITLE")!.exclusion, "reasonable_no_comp_not_affiliate"); assert.equal(un.qm.qm_type, "general_safe_harbor");
});

test("23.4-T4: Given 1.5 additional non-bona-fide points ($6,180.00) on the purchase fixture at `cd` stage, then `qm_type = not_qm`, `issueCD` is blocked, and a `restructure.proposed{kind=fee_change}` is emitted; given the same excess found at `post_closing` on Dec 1, 2026 for a Nov 18 consummation, then the `post_closing` row records `qm_type = not_qm`, `cure_required_cents = 385176` is queued as a remediation refund for `officer` approval, no `REGZ_1026_43_E3III_PF_CURE_210` timer is created (the (e)(3)(iii) cure is unavailable for loans consummated after Jan 10, 2021), and an 28.4 self-report evaluation is opened.", () => {
  const h = harness(PURCHASE, "2026-11-12T16:00:00.000Z");
  const fees = purchaseFees({ extra_points: { amount_cents: 618_000n, points: 1.5 } });
  const cd = runDeterminations(purchaseRun({ fees }));
  assert.equal(cd.fees.pf_cents, 1_598_000n); assert.equal(cd.qm.pf_pass, false); assert.equal(cd.qm.apr_test_pass, true); assert.equal(cd.qm.qm_type, "not_qm");
  // the $6,180.00 of points are prepaid finance charges (§1026.4(b)(3)): amount financed $398,094.53 → cap floor(3 %) = $11,942.83 (the spec kept $12,128.24, the cap before the points were added)
  assert.equal(cd.total.total_loan_amount_cents, 39_809_453n); assert.equal(cd.qm.cap_cents, 1_194_283n);
  const g = qmDeterminationGate(cd.qm, "issueCD"); assert.equal(g.open, false); assert.deepEqual(g.blocking_codes, ["QM_POINTS_FEES_OVER_CAP"]);
  assert.equal(evaluateGate("23.4.qmDeterminationGate", facts(cd.qm, "issueCD")).open, false);
  recordDeterminations(h.events, { application_id: PURCHASE }, cd);
  assert.equal(h.timer("REGZ_1026_43_QM_DETERMINATION_GATE")!.status, "armed");   // compliance.test.failed{test=qm} does not close it
  const rp = proposeFeeRestructure(h.events, { application_id: PURCHASE }, cd.qm);
  assert.equal(rp.type, "restructure.proposed"); assert.equal(rp.payload.kind, "fee_change"); assert.equal(rp.payload.excess_pf_cents, "403717"); assert.equal(rp.applicationId, PURCHASE);
  // post-closing discovery (Dec 1, 2026; consummation Nov 18): not_qm permanently; remediation refund queued; no cure clock
  h.clock.set("2026-12-01T15:00:00.000Z");
  const pc = runDeterminations(purchaseRun({ fees, stage: "post_closing", as_of: D("2026-12-01"), determined_at: "2026-12-01T15:00:00.000Z", apr_calculation_id: "APR-PUR-PC-1" }));
  assert.equal(pc.qm.stage, "post_closing"); assert.equal(pc.qm.qm_type, "not_qm");
  // spec T4 says cure_required_cents = 385176 ($15,980.00 − $12,128.24 = $3,851.76 — the cap before the points were added); on the row the points reduce the total loan amount, so the excess is $15,980.00 − $11,942.83 = $4,037.17
  assert.equal(pc.qm.cure_required_cents, 1_598_000n - pc.qm.cap_cents); assert.equal(pc.qm.cure_required_cents, 403_717n); assert.equal(pc.qm.cure_deadline, null);
  const cure = recordPfCureRequired(h.events, { application_id: PURCHASE }, { qm: pc.qm, consummation_date: D("2026-11-18"), discovered_on: D("2026-12-01"), note_rate_pct: "6.375", escalations: h.escalations });
  assert.equal(cure.cure_required_cents, 403_717n); assert.equal(cure.interest_cents, 917n);   // 13 days at the contract rate 6.375 %
  assert.equal(cure.timer_created, false); assert.equal(cure.event.payload.consummated_on_or_before_2021_01_10, false); assert.equal(cure.event.payload.cure_available, false);
  assert.equal(h.timers.byCode("REGZ_1026_43_E3III_PF_CURE_210").length, 0);
  const officer = h.escalations.list().find((e) => e.id === cure.officer_escalation_id)!; assert.equal(officer.kind, "officer"); assert.equal(officer.payload.reason, "points_and_fees_remediation_refund"); assert.equal(officer.payload.cure_required_cents, "403717");
  const sr = h.escalations.list().find((e) => e.id === cure.self_report_escalation_id)!; assert.equal(sr.kind, "qc_officer"); assert.equal(sr.payload.process, "28.4"); assert.equal(sr.payload.reason, "qm_representation_breach_self_report_evaluation");
  assert.throws(() => recordPfCurePaid(h.events, { application_id: PURCHASE }, { determination_id: pc.qm.determination_id, paid_cents: 404_634n, paid_on: D("2026-12-10"), approved_by: AGENT }), RangeError);
  const paid = recordPfCurePaid(h.events, { application_id: PURCHASE }, { determination_id: pc.qm.determination_id, paid_cents: 404_634n, paid_on: D("2026-12-10"), approved_by: OFFICER });
  assert.equal(paid.type, "compliance.pf_cure.paid"); assert.equal(paid.payload.qm_type_after, "not_qm");
});

test("23.4-T5: Given APR 7.550% vs APOR 6.020% on the refinance fixture, then `hpct = true`, `is_hpml = true`, `qm_type = general_rebuttable`, `escrow_required = true`, `escrow_min_cancel_date = 2031-11-06`, `appraisal_rules_apply = false`, `fnma_eligible = true`; a servicing `cancelEscrow` request dated Nov 5, 2031 is refused and one dated Nov 6, 2031 proceeds to the < 80% UPB test.", () => {
  const r = runDeterminations(refiRun({ apr: "7.550" }));
  assert.equal(r.qm.spread, 1.53); assert.equal(r.qm.hpct, true); assert.equal(r.qm.apr_test_pass, true); assert.equal(r.qm.qm_type, "general_rebuttable");
  assert.equal(r.hpml.is_hpml, true); assert.equal(r.hpml.escrow_required, true); assert.equal(r.hpml.escrow_min_cancel_date, "2031-11-06"); assert.equal(r.hpml.appraisal_rules_apply, false); assert.equal(r.hpml.small_creditor_exempt, false);
  assert.equal(r.high_cost.fnma_eligible, true); assert.equal(r.qm.fnma_spread_ok, true);
  assert.deepEqual(hpmlClosingPayload(r.hpml), { is_hpml: true, escrow_required: true, appraisal_rules_apply: false, escrow_min_cancel_date: "2031-11-06" });
  const req = (requested_on: string) => ({ requested_on: D(requested_on), upb_cents: 52_000_000n, original_appraised_value_cents: 62_000_000n, original_property_value_cents: 62_000_000n, hpml: true, consummation_date: D("2026-11-06"), regx_days_delinquent: 0, late_30_in_12m: 0, late_60_in_24m: 0, prior_modification: false, prior_waiver_missed_payments: false, monthly_mi_line: false, flood_escrow_mandatory: false, instrument_permits: true, next_due_dates: [D("2031-12-01")] });
  const early = cancelEscrowRequest(req("2031-11-05"));
  assert.equal(early.refused, true); assert.equal(early.before_floor, true); assert.equal(early.floor, "2031-11-06"); assert.ok(early.decision.reasons.includes("HPML_LT_5Y")); assert.ok(early.decision.re_request_on! >= "2031-11-06");
  const onDay = cancelEscrowRequest(req("2031-11-06"));
  assert.equal(onDay.before_floor, false); assert.ok(!onDay.decision.reasons.includes("HPML_LT_5Y"));
  assert.ok(onDay.decision.reasons.includes("HPML_LTV_GE_80_ORIG_VALUE"));   // proceeds to the < 80 % UPB test (52,000,000 / 62,000,000 = 83.9 %)
});

test("23.4-T6: Given APR 8.400% vs APOR 6.020%, then `apr_test_pass = false`, `qm_type = not_qm`, `is_hpml = true`, `fnma_eligible = false` (spread > 2.25), and both `REGZ_1026_43_QM_DETERMINATION_GATE` and delivery are blocked.", () => {
  const r = runDeterminations(refiRun({ apr: "8.400" }));
  assert.equal(r.qm.spread, 2.38); assert.equal(r.qm.apr_test_pass, false); assert.equal(r.qm.pf_pass, true); assert.equal(r.qm.qm_type, "not_qm"); assert.equal(r.qm.hpct, true);
  assert.equal(r.hpml.is_hpml, true); assert.equal(r.hpml.appraisal_rules_apply, true);   // not a QM and > $34,200 → §1026.35(c) applies (24.2)
  assert.equal(r.qm.fnma_spread_ok, false); assert.equal(r.high_cost.fnma_eligible, false); assert.match(r.high_cost.fnma_ineligibility_reasons.join(" "), /spread 2.38 exceeds 2.25/);
  for (const command of ["issueCD", "consummate", "submitDelivery"] as const) { const g = qmDeterminationGate(r.qm, command); assert.equal(g.open, false, command); assert.ok(g.blocking_codes.includes("QM_APR_TEST_FAIL")); }
  assert.equal(evaluateGate("23.4.qmDeterminationGate", facts(r.qm, "submitDelivery")).open, false);
});

test("23.4-T7: Given APR 12.600% vs APOR 6.020% (spread 6.580 > 6.5), then `is_hoepa = true` and `REGZ_1026_32_HOEPA_GATE` blocks `issueCD`; given spread exactly 6.500, then `is_hoepa = false` on the APR test (\"more than\").", () => {
  const h = harness(REFI, "2026-11-02T16:00:00.000Z");
  const r = runDeterminations(refiRun({ apr: "12.600" }));
  assert.equal(r.high_cost.hoepa.apr_test.spread, 6.58); assert.equal(r.high_cost.hoepa.apr_test.threshold_pts, 6.5); assert.equal(r.high_cost.hoepa.apr_test.fail, true); assert.equal(r.high_cost.hoepa.pf_test.fail, false); assert.equal(r.high_cost.is_hoepa, true);
  const g = hoepaGate(r.high_cost.is_hoepa, "issueCD"); assert.equal(g.open, false); assert.deepEqual(g.blocking_codes, ["HOEPA_HIGH_COST"]);
  assert.equal(evaluateGate("23.4.hoepaGate", { is_hoepa: true, command: "issueCD" }).open, false);
  recordDeterminations(h.events, { application_id: REFI }, r);
  assert.equal(h.timer("REGZ_1026_32_HOEPA_GATE")!.status, "armed"); assert.equal(h.events.ofType("compliance.test.failed").filter((e) => e.payload.test === "hoepa").length, 1);
  assert.equal(r.high_cost.fnma_eligible, false);
  const edge = runDeterminations(refiRun({ apr: "12.520" }));
  assert.equal(edge.high_cost.hoepa.apr_test.spread, 6.5); assert.equal(edge.high_cost.hoepa.apr_test.fail, false); assert.equal(edge.high_cost.is_hoepa, false);
  assert.equal(hoepaGate(edge.high_cost.is_hoepa, "issueCD").open, true);
});

test("23.4-T8: Given a $340,000 New Jersey loan with points and fees $15,640.00 (4.60%), then `state_tests[NJ].pf_test.fail = true`, `is_state_high_cost = true`, `fnma_eligible = false`, `STATE_HIGH_COST_GATE` blocks; at $15,300.00 (4.50%) the NJ test passes but the QM 3% test fails ($10,200.00 cap) — `qm_type = not_qm`.", () => {
  const nj = (pf_cents: bigint) => runStateHighCostTests({ state: "NJ", loan_amount_cents: 34_000_000n, total_loan_amount_cents: 34_000_000n, pf_cents, apr: "6.640", lien: "first", hoepa_apr_fail: false, as_of: D("2026-11-02") });
  const fail = nj(1_564_000n);
  assert.equal(fail.length, 1); const t = fail[0]!;
  assert.equal(t.statute, "N.J.S.A. 46:10B-24"); assert.equal(t.applies_by_size, true); assert.equal(t.size_cap_cents, 35_000_000n); assert.equal(t.reference_rate_series, "hoepa_ref");
  assert.deepEqual(t.pf_test, { threshold_pct: "4.5", threshold_cents: 1_530_000n, pf_cents: 1_564_000n, fail: true }); assert.equal(t.apr_test.fail, false); assert.equal(t.result, "fail"); assert.equal(t.fnma_ineligible_if_fail, true);
  const apor = selectApor(APOR_TABLES, { rate_set_date: D("2026-10-21"), term_years: 30, product: "fixed", stage: "cd", requested_on: D("2026-11-02") });
  const fees = (pf: bigint): Classification23 => ({ items: [], pf_cents: pf, prepaid_finance_charges_cents: 0n, bona_fide_discount_points_excluded_cents: 0n, bona_fide: evaluateBonaFideDiscount({}), exclusions: [] });
  const total: TotalLoanAmount = computeTotalLoanAmount({ loan_amount_cents: 34_000_000n, prepaid_finance_charges_cents: 0n });
  const qmOf = (pf: bigint) => runQmTests({ application_id: "APP-NJ", stage: "cd", apr_calculation_id: "APR-NJ", apr: "6.640", rate_set_date: D("2026-10-21"), apor, loan_amount_cents: 34_000_000n, total, fees: fees(pf), product: PRODUCT_30Y, consider_verify: considerVerify(), lien: "first", as_of: D("2026-11-02"), determined_at: "2026-11-02T16:00:00.000Z" });
  const q1 = qmOf(1_564_000n);
  const el = fnmaEligibility(q1, false, fail); assert.equal(el.fnma_eligible, false); assert.match(el.reasons[0]!, /NJ high-cost home loan/);
  const g = stateHighCostGate(fail, "issueCD"); assert.equal(g.open, false); assert.deepEqual(g.blocking_codes, ["STATE_HIGH_COST_NJ_FNMA_INELIGIBLE"]);
  assert.equal(evaluateGate("23.4.stateHighCostGate", { state_tests: fail, command: "issueCD" }).open, false);
  assert.equal(fail.some((s) => s.result === "fail"), true);   // is_state_high_cost
  // exactly 4.50 %: "exceed … 4.5%" passes; the QM 3 % cap ($10,200.00) still fails
  const pass = nj(1_530_000n); assert.equal(pass[0]!.pf_test.fail, false); assert.equal(pass[0]!.result, "pass"); assert.equal(stateHighCostGate(pass, "issueCD").open, true);
  const q2 = qmOf(1_530_000n); assert.equal(q2.cap_cents, 1_020_000n); assert.equal(q2.pf_pass, false); assert.equal(q2.qm_type, "not_qm"); assert.equal(fnmaEligibility(q2, false, pass).fnma_eligible, false);
});

test("23.4-T9: Given a $412,000 North Carolina loan, then `state_tests[NC].applies_by_size = false` (cap $300,000) and `result = not_applicable`; given a $290,000 NC loan with points and fees 5.2%, then `fail` and Fannie Mae ineligible.", () => {
  const big = runStateHighCostTests({ state: "NC", loan_amount_cents: 41_200_000n, total_loan_amount_cents: 40_427_453n, pf_cents: 980_000n, apr: "6.640", lien: "first", hoepa_apr_fail: false, as_of: D("2026-11-02") });
  assert.equal(big.length, 1); assert.equal(big[0]!.statute, "N.C.G.S. § 24-1.1E"); assert.equal(big[0]!.applies_by_size, false); assert.equal(big[0]!.size_cap_cents, 30_000_000n); assert.equal(big[0]!.result, "not_applicable");
  assert.equal(stateHighCostGate(big, "issueCD").open, true);
  const small = runStateHighCostTests({ state: "NC", loan_amount_cents: 29_000_000n, total_loan_amount_cents: 29_000_000n, pf_cents: 1_508_000n, apr: "6.640", lien: "first", hoepa_apr_fail: false, as_of: D("2026-11-02") });
  assert.equal(small[0]!.applies_by_size, true); assert.deepEqual(small[0]!.pf_test, { threshold_pct: "5", threshold_cents: 1_450_000n, pf_cents: 1_508_000n, fail: true }); assert.equal(small[0]!.result, "fail");
  const el = fnmaEligibility({ fnma_spread_ok: true, pf_pass: true, spread: 0.62 }, false, small); assert.equal(el.fnma_eligible, false); assert.match(el.reasons[0]!, /NC high-cost home loan \(N\.C\.G\.S\. § 24-1\.1E\) — B2-1\.5-02/);
  assert.deepEqual(stateHighCostGate(small, "consummate").blocking_codes, ["STATE_HIGH_COST_NC_FNMA_INELIGIBLE"]);
});

test("23.4-T10: Given a lock on Wed Oct 7, 2026 and a relock on Mon Nov 2, 2026 at a new rate, then `rate_set_date = 2026-11-02` and the APOR row is re-selected from the table current on Nov 2; the Oct 7 row remains on the superseded `lock` stage record.", () => {
  const tables = [aporRow("2026-10-05", "6.020"), aporRow("2026-10-19", "6.020"), aporRow("2026-11-02", "6.070")];
  const relock: LockRow = { lock_id: "LK-REFI-2", kind: "relock", locked_at: "2026-11-02T14:30:00.000Z", rate_pct: "6.375", product: "fixed", term_years: 30 };
  const first = runDeterminations(refiRun({ stage: "lock", as_of: D("2026-10-07"), determined_at: "2026-10-07T16:00:00.000Z", apr_calculation_id: "APR-REFI-LOCK-1", apor_tables: tables, locks: [LOCK_REFI, relock], consummation_date: null, computed_from_final_cd: false }));
  assert.equal(first.rate_set.rate_set_date, "2026-10-07"); assert.equal(first.rate_set.lock!.lock_id, "LK-REFI-1"); assert.equal(first.qm.apor_table_id, "T-2026-10-05"); assert.equal(first.qm.apor, 6.02);
  const second = runDeterminations(refiRun({ stage: "lock", as_of: D("2026-11-02"), determined_at: "2026-11-02T15:00:00.000Z", apr_calculation_id: "APR-REFI-LOCK-2", apr: "6.410", apor_tables: tables, locks: [LOCK_REFI, relock], consummation_date: null, computed_from_final_cd: false }));
  assert.equal(second.rate_set.rate_set_date, "2026-11-02"); assert.equal(second.rate_set.lock!.lock_id, "LK-REFI-2"); assert.deepEqual(second.rate_set.superseded_lock_ids, ["LK-REFI-1"]);
  assert.equal(second.qm.apor_table_id, "T-2026-11-02"); assert.equal(second.qm.apor, 6.07); assert.equal(second.qm.spread, 0.34); assert.equal(second.qm.rate_set_date, "2026-11-02");
  const rows = supersede([first.qm], second.qm);
  assert.equal(rows.length, 2); assert.equal(rows[0]!.status, "superseded"); assert.equal(rows[0]!.stage, "lock"); assert.equal(rows[0]!.rate_set_date, "2026-10-07"); assert.equal(rows[0]!.apor_table_id, "T-2026-10-05");
  assert.equal(rows[1]!.status, "current"); assert.equal(rows[1]!.apor_table_id, "T-2026-11-02");
  // an extension keeps the rate-set date
  assert.equal(rateSetDate([LOCK_REFI, { lock_id: "LK-REFI-X", kind: "extension", locked_at: "2026-10-28T12:00:00.000Z", rate_pct: "6.125", product: "fixed", term_years: 30 }], D("2026-11-02")).rate_set_date, "2026-10-07");
});

test("23.4-T11: Given the APOR table last ingested Mon Sept 21, 2026 and a lock-stage determination requested Wed Oct 7, 2026 (16 days), then the determination is blocked with `apor_stale` until `FFIEC_APOR_TABLE_REFRESH_WEEKLY` ingests a newer table.", async () => {
  const h = harness(REFI, "2026-10-07T16:00:00.000Z");
  const stale = [aporRow("2026-09-21", "6.010")];
  const sel = selectApor(stale, { rate_set_date: D("2026-10-07"), term_years: 30, product: "fixed", stage: "lock", requested_on: D("2026-10-07") });
  assert.equal(sel.table_id, "T-2026-09-21"); assert.equal(sel.age_days, 16); assert.equal(sel.apor_stale, true); assert.equal(sel.blocked, true); assert.match(sel.reason!, /^apor_stale: .*16 days old/);
  const r = runDeterminations(refiRun({ stage: "lock", as_of: D("2026-10-07"), determined_at: "2026-10-07T16:00:00.000Z", apr_calculation_id: "APR-REFI-LOCK-1", apor_tables: stale, consummation_date: null, computed_from_final_cd: false }));
  assert.equal(r.qm.apor_stale, true); assert.equal(r.qm.qm_type, null); assert.match(r.qm.blocked_reason!, /apor_stale/);
  const g = qmDeterminationGate(r.qm, "issueCD"); assert.equal(g.open, false); assert.ok(g.blocking_codes.includes("APOR_STALE"));
  // the agent cannot accept the stale table (guardrail); the read tool reports the staleness
  await assert.rejects(h.run("getApor", { rate_set_date: "2026-10-07", stage: "lock", apor_tables: stale, accept_stale: true }), (e: unknown) => e instanceof CommandRefused && e.code === "APOR_STALE_NOT_ACCEPTED");
  const out = await h.run("getApor", { rate_set_date: "2026-10-07", stage: "lock", apor_tables: stale }); assert.equal(out.apor_stale, true); assert.equal(out.blocked, true);
  // the weekly ingest (25.1 ingestAporTable → apor.table.ingested{table_date}) arms FFIEC_APOR_TABLE_REFRESH_WEEKLY (+7 calendar days) and a newer table unblocks the determination
  const ing = ingestAporTable(h.events, [{ table_date: D("2026-10-05"), term_years: 30, product: "fixed", apor_pct: "6.020" }, { table_date: D("2026-10-05"), term_years: 30, product: "adjustable", apor_pct: "5.900" }]);
  assert.equal(ing.event.type, "apor.table.ingested"); assert.equal(ing.next_due, "2026-10-12");
  const t = h.timer("FFIEC_APOR_TABLE_REFRESH_WEEKLY")!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-05"); assert.equal(t.dueDate, "2026-10-12");
  const fresh = selectApor([...stale, aporRow("2026-10-05", "6.020")], { rate_set_date: D("2026-10-07"), term_years: 30, product: "fixed", stage: "lock", requested_on: D("2026-10-07") });
  assert.equal(fresh.table_id, "T-2026-10-05"); assert.equal(fresh.apor_stale, false); assert.equal(fresh.blocked, false);
  const ok = runDeterminations(refiRun({ stage: "lock", as_of: D("2026-10-07"), determined_at: "2026-10-07T16:30:00.000Z", apr_calculation_id: "APR-REFI-LOCK-1", apor_tables: [...stale, aporRow("2026-10-05", "6.020")], consummation_date: null, computed_from_final_cd: false }));
  assert.equal(ok.qm.qm_type, "general_safe_harbor"); assert.equal(qmDeterminationGate(ok.qm, "issueCD").open, true);
});

test("23.4-T12: Given a loan amount of $137,900 (below the 2026 first tier), then `apr_threshold_pts = 3.5` and `pf_tier = usd4139_82775_137957` with `cap_cents = 413900`; given $137,958, then 2.25 and 3%.", () => {
  const rs = ruleSet<QmRuleSet>("regz.qm.general.2021", D("2026-11-02")).content;
  assert.deepEqual(aprTier(13_790_000n, "first", false, rs), { apr_tier: "first_lien_82775_137957", apr_threshold_pts: 3.5 });
  assert.deepEqual(pfTier(13_790_000n, rs), { pf_tier: "usd4139_82775_137957", cap_cents: 413_900n, cap_basis: "$4139 (2026 indexed)" });
  assert.deepEqual(aprTier(13_795_800n, "first", false, rs), { apr_tier: "first_lien_ge_137958", apr_threshold_pts: 2.25 });
  assert.deepEqual(pfTier(13_795_800n, rs), { pf_tier: "pct3_ge_137958", cap_cents: 413_874n, cap_basis: "floor(3% × total loan amount 13795800)" });
  // the other tiers: $82,774 → 6.5 / 5 %; manufactured home < $137,958 → 6.5; subordinate liens
  assert.equal(aprTier(8_277_400n, "first", false, rs).apr_threshold_pts, 6.5); assert.equal(pfTier(8_277_400n, rs).pf_tier, "pct5_27592_82774");
  assert.equal(aprTier(13_790_000n, "first", true, rs).apr_tier, "mh_lt_137958"); assert.equal(aprTier(13_790_000n, "subordinate", false, rs).apr_tier, "sub_ge_82775"); assert.equal(aprTier(8_000_000n, "subordinate", false, rs).apr_threshold_pts, 6.5);
  assert.equal(pfTier(2_000_000n, rs).cap_cents, 138_000n); assert.equal(pfTier(1_700_000n, rs).pf_tier, "pct8_lt_17245");
  // the tier boundary on a real row: $137,900 at the fixture pricing
  const apor = selectApor(APOR_TABLES, { rate_set_date: D("2026-10-07"), term_years: 30, product: "fixed", stage: "cd", requested_on: D("2026-11-02") });
  const q = runQmTests({ application_id: "APP-SMALL", stage: "cd", apr_calculation_id: "APR-S", apr: "6.159", rate_set_date: D("2026-10-07"), apor, loan_amount_cents: 13_790_000n, total: computeTotalLoanAmount({ loan_amount_cents: 13_790_000n, prepaid_finance_charges_cents: 0n }), fees: { items: [], pf_cents: 300_000n, prepaid_finance_charges_cents: 0n, bona_fide_discount_points_excluded_cents: 0n, bona_fide: evaluateBonaFideDiscount({}), exclusions: [] }, product: PRODUCT_30Y, consider_verify: considerVerify(), lien: "first", as_of: D("2026-11-02"), determined_at: "2026-11-02T16:00:00.000Z" });
  assert.equal(q.apr_threshold_pts, 3.5); assert.equal(q.pf_tier, "usd4139_82775_137957"); assert.equal(q.cap_cents, 413_900n); assert.equal(q.qm_type, "general_safe_harbor");
});

test("23.4-T13: Given an HPML first lien on a principal dwelling where the borrower elects to waive escrow, then `REGZ_1026_35B1_HPML_ESCROW_GATE` blocks consummation and 30.3 refuses the waiver.", () => {
  const h = harness(REFI, "2026-11-04T16:00:00.000Z");
  const r = runDeterminations(refiRun({ apr: "7.550", escrow_established_before_consummation: false, escrow_waiver_elected: true }));
  assert.equal(r.hpml.is_hpml, true); assert.equal(r.hpml.escrow_required, true); assert.equal(r.hpml.escrow_waiver_elected, true);
  const g = hpmlEscrowGate(r.hpml); assert.equal(g.open, false); assert.deepEqual(g.blocking_codes, ["HPML_ESCROW_WAIVER_REFUSED", "HPML_ESCROW_NOT_ESTABLISHED"]); assert.match(g.reason!, /§1026.35\(b\)\(1\)/);
  assert.equal(evaluateGate("23.4.hpmlEscrowGate", { is_hpml: true, lien: "first", principal_dwelling: true, escrow_established_before_consummation: false, escrow_waiver_elected: true }).open, false);
  // 26.2's closing.scheduled carrying hpmlClosingPayload arms the gate; 30.3 refuses the waiver (HPML_ESCROW_REQUIRED); its escrow.initial_analysis.approved{hpml=true} satisfies the gate
  h.events.append({ type: "closing.scheduled", actor: AGENT, payload: { closing_id: "CL-1", scheduled_at: "2026-11-06T17:00:00.000Z", application_id: REFI, ...hpmlClosingPayload(r.hpml) } });
  const t = h.timer("REGZ_1026_35B1_HPML_ESCROW_GATE")!; assert.equal(t.status, "armed"); assert.equal(t.note, "evaluator:23.4.hpmlEscrowGate");
  const w = evaluateOriginationWaiver({ application_id: REFI, waiver_id: "W-1", requested_on: D("2026-11-04"), scope: "full", waived_line_types: ["tax", "hazard"], channel: "portal", is_hpml: true, consummation_date: D("2026-11-06"), state: "AZ", transaction_type: "refinance", taxes_financed_in_loan: false, mi_premium_plan: "none", ltv_pct: "70.000", reserves_months_of_ti: 6, mortgage_lates_30_in_12m: 0, dti_pct: "38.00", lump_sum_ability_documented: true, sfha: false, loan_amount_cents: 56_000_000n, annual_ti_cents: 822_000n });
  assert.equal(w.decision, "denied"); assert.ok(w.reasons.includes("HPML_ESCROW_REQUIRED"));
  assert.equal(h.timer("REGZ_1026_35B1_HPML_ESCROW_GATE")!.status, "armed");
  h.events.append({ type: "escrow.initial_analysis.approved", actor: { kind: "agent", id: "escrow" }, payload: { analysis_id: "EA-1", analysis_type: "initial", source: "origination", hpml: true, approved_on: "2026-11-05", application_id: REFI } });
  assert.equal(h.timer("REGZ_1026_35B1_HPML_ESCROW_GATE")!.status, "satisfied");
  const established = hpmlEscrowGate({ ...r.hpml, escrow_established_before_consummation: true, escrow_waiver_elected: false }); assert.equal(established.open, true);
  assert.equal(hpmlEscrowGate({ ...r.hpml, is_hpml: false }).open, true);   // not an HPML: no escrow mandate from §1026.35(b)
});

test("23.4-T14: Given a consider-and-verify map missing the \"credit history\" factor's evidence reference, then `qm_type` cannot be `general_*` and the gate blocks until 22.2's report id is linked.", () => {
  const missing = considerVerify(null);
  const st = considerVerifyStatus(missing); assert.equal(st.complete, false); assert.deepEqual(st.missing, ["credit_history: no third-party evidence reference (22.2 credit report id)"]);
  const r = runDeterminations(refiRun({ consider_verify: missing }));
  assert.equal(r.qm.apr_test_pass, true); assert.equal(r.qm.pf_pass, true); assert.equal(r.qm.consider_verify_complete, false); assert.equal(r.qm.qm_type, "not_qm");
  const g = qmDeterminationGate(r.qm, "issueCD"); assert.equal(g.open, false); assert.deepEqual(g.blocking_codes, ["QM_CONSIDER_VERIFY_INCOMPLETE"]); assert.match(g.reason!, /credit_history: no third-party evidence reference \(22\.2 credit report id\)/);
  assert.equal(evaluateGate("23.4.qmDeterminationGate", facts(r.qm, "issueCD")).open, false);
  // DU findings are not evidence: a map that cites them is refused; linking 22.2's report id completes the map and the gate opens
  assert.throws(() => assembleAtrEvidence({ income: { monthly_cents: 1n, evidence: [ev("du_findings", "DU-1", "23.2")], standard_ref: "x" }, employment: { status: "e", evidence: [], standard_ref: "x" }, payment: { pi_cents: 1n, basis: "note_rate_fully_amortizing", evidence: [] }, simultaneous_loans: { monthly_cents: 0n, evidence: [], standard_ref: "x" }, mortgage_obligations: { monthly_cents: 0n, evidence: [], standard_ref: "x" }, debts: { monthly_cents: 0n, alimony_child_support_cents: 0n, evidence: [], standard_ref: "x" }, dti: { pct: "1", evidence: [], standard_ref: "x" }, credit_history: { report_id: null, pulled_at: null, standard_ref: "x" } }), /DU findings are not third-party records/);
  const linked = runDeterminations(refiRun({ consider_verify: considerVerify("CR-2026-10-05-1") }));
  assert.deepEqual(linked.qm.consider_verify.find((f) => f.factor === "credit_history")!.evidence_refs, [{ kind: "credit_report", id: "CR-2026-10-05-1", source_process: "22.2" }]);
  assert.equal(linked.qm.consider_verify_complete, true); assert.equal(linked.qm.qm_type, "general_safe_harbor"); assert.equal(qmDeterminationGate(linked.qm, "issueCD").open, true);
});

test("23.4 worked figures: refinance ($560,000 at 6.125%) and purchase ($412,000 at 6.375%) fixtures, the NJ / NC / NY state examples and the compliance-tester tools on the bus", async () => {
  // --- worked example 1: per diem $93.97 (26.3's cent-rounded convention) × 19 days Nov 12–30 = $1,785.43; PFC $1,995.00 + $1,785.43 = $3,780.43 → amount financed $556,219.57
  assert.equal(perDiem365Rounded(56_000_000n, "6.125"), 9_397n);
  const ppi = prepaidInterest(56_000_000n, "6.125", D("2026-11-12")); assert.equal(ppi.days, 19); assert.equal(ppi.per_diem_cents, 9_397n); assert.equal(ppi.prepaid_interest_cents, 178_543n);
  const refi = runDeterminations(refiRun());
  assert.equal(refi.fees.prepaid_finance_charges_cents, 199_500n + 178_543n); assert.equal(refi.fees.prepaid_finance_charges_cents, 378_043n);
  assert.equal(refi.total.amount_financed_cents, 55_621_957n); assert.equal(refi.qm.cap_cents, 1_668_658n);   // $16,686.58 = floor(3 % × $556,219.57)
  assert.equal(refi.qm.pf_cents, 199_500n); assert.equal(refi.qm.pf_pct, 0.3587);   // 0.36 %
  assert.equal(refi.fees.items.find((x) => x.fee_item_id === "F-CR")!.amount_cents, 7_500n); assert.equal(refi.fees.items.find((x) => x.fee_item_id === "F-TITLE")!.amount_cents, 180_000n); assert.equal(refi.fees.items.find((x) => x.fee_item_id === "F-REC")!.amount_cents, 9_500n);
  // HOEPA 5 % of the total loan amount: the spec line reads "5% × $556,219.52 = $27,810.98" (typo for $556,219.57; 5 % of $556,219.57 = $27,810.98)
  assert.equal(refi.high_cost.hoepa.pf_test.base_cents, 55_621_957n); assert.equal(refi.high_cost.hoepa.pf_test.threshold_cents, 2_781_098n); assert.equal(refi.high_cost.hoepa.pf_test.fail, false);
  assert.equal(refi.high_cost.hoepa.apr_test.spread, 0.139);
  // 25.1's engine result the row cites: the fixture APR 6.159 (25.1 worked example 1, PFC $3,849.95 on its fuller fee list)
  assert.equal(computeApr({ loan_amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, term_start_date: D("2026-11-12"), first_payment_date: D("2027-01-01"), prepaid_finance_charges_cents: 384_995n, prepaid_interest_cents: 178_543n }).apr_disclosed, 6.159);
  assert.deepEqual(nearThreshold(refi.qm), { spread_near: false, pf_near: false });
  // --- worked example 2: $2,995.00 + $1,295.00 + $440.00 + $2,060.00 (0.5 point, undiscounted 8.10 % > APOR 6.020 + 2) + $3,010.00 affiliated title = $9,800.00; PFC $7,725.47 → $404,274.53
  const pur = runDeterminations(purchaseRun());
  const by = Object.fromEntries(pur.fees.items.map((x) => [x.fee_item_id, x.included_cents]));
  assert.equal(by["P-ORIG"], 299_500n); assert.equal(by["P-UW"], 129_500n); assert.equal(by["P-DOC"], 44_000n); assert.equal(by["P-PTS"], 206_000n); assert.equal(by["P-TITLE"], 301_000n);
  assert.equal(pur.fees.pf_cents, 980_000n); assert.equal(pur.fees.prepaid_finance_charges_cents, 772_547n); assert.equal(pur.total.total_loan_amount_cents, 40_427_453n);
  // the engine's per diem for the purchase fixture: $412,000 × 6.375 % / 365 = $71.96 (cent-rounded) × 13 = $935.48; the spec's $935.47 multiplied the unrounded per diem
  assert.equal(perDiem365Rounded(41_200_000n, "6.375"), 7_196n); assert.equal(prepaidInterest(41_200_000n, "6.375", D("2026-11-18")).prepaid_interest_cents, 93_548n);
  // the section-note figure $12,360.00 is 3 % of the note amount — not the Reg Z base; the Reg Z cap is floor(3 % × $404,274.53) (spec: $12,128.24 HALF_UP)
  assert.equal(floorPct(41_200_000n, "3"), 1_236_000n); assert.equal(pur.qm.cap_cents, 1_212_823n); assert.equal(pur.qm.cap_cents_25_1, 1_212_824n);
  assert.equal(pur.high_cost.hoepa.pf_test.threshold_cents, 2_021_373n);   // HOEPA 5 % test $20,213.73 → pass
  assert.equal(pur.qm.spread, 0.62); assert.equal(pur.qm.qm_type, "general_safe_harbor"); assert.equal(pur.hpml.is_hpml, false); assert.equal(pur.high_cost.fnma_eligible, true);
  // failing variant: 1.5 additional points $6,180.00 → $15,980.00 > cap → not_qm; remediation refund $15,980.00 − cap (spec: $3,851.76 against the pre-points cap $12,128.24; the points are prepaid finance charges, so the row's cap is floor(3 % × $398,094.53) = $11,942.83)
  const failing = runDeterminations(purchaseRun({ fees: purchaseFees({ extra_points: { amount_cents: 618_000n, points: 1.5 } }), stage: "post_closing", as_of: D("2026-12-01"), determined_at: "2026-12-01T15:00:00.000Z" }));
  assert.equal(failing.fees.pf_cents, 1_598_000n); assert.equal(failing.fees.prepaid_finance_charges_cents, 772_547n + 618_000n); assert.equal(failing.qm.cap_cents, 1_194_283n); assert.equal(failing.qm.qm_type, "not_qm"); assert.equal(failing.qm.cure_required_cents, 1_598_000n - 1_194_283n); assert.equal(failing.qm.cure_required_cents, 403_717n);
  // APR failing variant 8.400 % → spread 2.380 ≥ 2.25 → not_qm, HPML, Fannie Mae ineligible
  const aprFail = runDeterminations(purchaseRun({ apr: "8.400" })); assert.equal(aprFail.qm.spread, 2.38); assert.equal(aprFail.qm.qm_type, "not_qm"); assert.equal(aprFail.hpml.is_hpml, true); assert.equal(aprFail.high_cost.fnma_eligible, false);
  // --- worked example 4: NJ $340,000 — federal HOEPA 5 % ($17,000.00) passes, QM 3 % ($10,200.00) fails, NJ 4.5 % ($15,300.00): $15,640.00 fails, $15,300.00 passes
  const apor = selectApor(APOR_TABLES, { rate_set_date: D("2026-10-21"), term_years: 30, product: "fixed", stage: "cd", requested_on: D("2026-11-02") });
  const njHoepa = runHoepaTests({ apr: "6.640", rate_set_date: D("2026-10-21"), apor, loan_amount_cents: 34_000_000n, total_loan_amount_cents: 34_000_000n, pf_cents: 1_564_000n, lien: "first", as_of: D("2026-11-02") });
  assert.equal(njHoepa.hoepa.pf_test.threshold_cents, 1_700_000n); assert.equal(njHoepa.is_hoepa, false);
  const rs = ruleSet<QmRuleSet>("regz.qm.general.2021", D("2026-11-02")).content; assert.equal(pfTier(34_000_000n, rs).cap_cents, 1_020_000n);
  const nj = runStateHighCostTests({ state: "NJ", loan_amount_cents: 34_000_000n, total_loan_amount_cents: 34_000_000n, pf_cents: 1_564_000n, apr: "6.640", lien: "first", hoepa_apr_fail: njHoepa.hoepa.apr_test.fail, as_of: D("2026-11-02") });
  assert.equal(nj[0]!.pf_test.threshold_cents, 1_530_000n); assert.equal(nj[0]!.pf_test.pf_cents, 1_564_000n); assert.equal(nj[0]!.result, "fail");
  // NC $412,000 outside the $300,000 cap; NY APR 6.310 % vs PMMS northeast 6.20 % (0.11 < 1.75 → not § 6-m subprime) and vs Treasury 4.10 % + 8 = 12.10 (§ 6-l pass)
  assert.equal(runStateHighCostTests({ state: "NC", loan_amount_cents: 41_200_000n, total_loan_amount_cents: 40_427_453n, pf_cents: 980_000n, apr: "6.640", lien: "first", hoepa_apr_fail: false, as_of: D("2026-11-02") })[0]!.result, "not_applicable");
  const ny = runStateHighCostTests({ state: "NY", loan_amount_cents: 41_200_000n, total_loan_amount_cents: 40_427_453n, pf_cents: 980_000n, apr: "6.310", lien: "first", hoepa_apr_fail: false, reference_rates: { treasury_yield_pct: "4.10", pmms_ne_pct: "6.20" }, as_of: D("2026-11-02") });
  assert.equal(ny.length, 2); assert.deepEqual(ny.map((t) => t.result), ["pass", "pass"]); assert.equal(ny[0]!.apr_test.spread, 2.21); assert.equal(ny[0]!.apr_test.threshold, "8"); assert.equal(ny[1]!.apr_test.spread, 0.11); assert.equal(ny[1]!.apr_test.threshold, "1.75");
  assert.equal(stateHighCostGate(ny, "issueCD").open, true); assert.equal(STATE_HIGH_COST_DEFINITIONS.filter((d) => d.fnma_ineligible_if_fail).length, 7);
  // an unverified statute (IL) blocks CD until an officer accepts the state risk; AZ / OH have no definitions
  const il = runStateHighCostTests({ state: "IL", loan_amount_cents: 41_200_000n, total_loan_amount_cents: 40_427_453n, pf_cents: 980_000n, apr: "6.640", lien: "first", hoepa_apr_fail: false, reference_rates: { apor_pct: "6.020" }, as_of: D("2026-11-02") });
  assert.equal(il[0]!.result, "pass"); assert.deepEqual(stateHighCostGate(il, "issueCD").blocking_codes, ["STATE_IL_PF_DEFINITION_UNVERIFIED"]); assert.equal(stateHighCostGate(il, "issueCD", true).open, true);
  assert.deepEqual(runStateHighCostTests({ state: "OH", loan_amount_cents: 1n, total_loan_amount_cents: 1n, pf_cents: 0n, apr: "6", lien: "first", hoepa_apr_fail: false, as_of: D("2026-11-02") }), []);
  // --- the tools on the bus: the stage run writes the three rows, emits the events, arms and closes the gates; guardrails refuse asserted results and unevidenced exclusions
  const h = harness(REFI, "2026-11-02T16:00:00.000Z");
  const out = await h.run("runQmTests", { op: "stage", stage: "cd", apr: "6.159", apr_calculation_id: "APR-REFI-CD-1", loan_amount_cents: "56000000", locks: [LOCK_REFI], apor_tables: APOR_TABLES, fee_items: REFI_FEES.map((f) => ({ ...f, amount_cents: f.amount_cents.toString() })), product: PRODUCT_30Y, consider_verify: considerVerify(), state: "AZ", consummation_date: "2026-11-06", escrow_established_before_consummation: true, computed_from_final_cd: true });
  assert.equal((out.qm as QmRow).qm_type, "general_safe_harbor"); assert.equal(h.rt.store.list("qm_determinations").length, 1); assert.equal(h.rt.store.list("hpml_determinations").length, 1); assert.equal(h.rt.store.list("high_cost_determinations").length, 1);
  assert.equal(h.timer("REGZ_1026_43_QM_DETERMINATION_GATE")!.status, "satisfied"); assert.equal(h.timer("STATE_HIGH_COST_GATE")!.status, "satisfied");
  assert.equal((out.decision as Record<string, unknown>).qm_type, "general_safe_harbor"); assert.equal(h.decisions.length, 1);
  await assert.rejects(h.run("runQmTests", { stage: "cd", apr: "6.159", apr_calculation_id: "x", loan_amount_cents: "56000000", rate_set_date: "2026-10-07", apor_tables: APOR_TABLES, fee_items: [], product: PRODUCT_30Y, qm_type: "general_safe_harbor" }), (e: unknown) => e instanceof CommandRefused && e.code === "QM_TYPE_NOT_ASSERTABLE");
  await assert.rejects(h.run("evaluateBonaFideDiscount", { apor_pct: "6.020", exclude_points: 1 }), (e: unknown) => e instanceof CommandRefused && e.code === "DISCOUNT_EXCLUSION_NEEDS_UNDISCOUNTED_RATE");
  await assert.rejects(h.run("classifyFeeItems", { fee_items: [{ fee_item_id: "x", service_code: "appraisal", amount_cents: "65000", exclusion: "bona_fide_third_party" }] }), (e: unknown) => e instanceof CommandRefused && e.code === "BONA_FIDE_THIRD_PARTY_NEEDS_PAYEE");
  await assert.rejects(h.run("runStateHighCostTests", { state: "NJ", loan_amount_cents: "34000000", total_loan_amount_cents: "34000000", pf_cents: "1564000", apr: "6.640", override_result: "pass" }), (e: unknown) => e instanceof CommandRefused && e.code === "STATE_TEST_NOT_OVERRIDABLE");
  await assert.rejects(h.run("runStateHighCostTests", { state: "NJ", loan_amount_cents: "34000000", total_loan_amount_cents: "34000000", pf_cents: "1564000", apr: "6.640", accept_state_risk: true }), (e: unknown) => e instanceof CommandRefused && e.code === "STATE_RISK_ACCEPTANCE_OFFICER");
  await assert.rejects(h.run("assembleAtrEvidence", { inputs: { income: { monthly_cents: "1", evidence: [{ kind: "du_findings", id: "DU-1", source_process: "23.2" }], standard_ref: "x" } } }), (e: unknown) => e instanceof CommandRefused && e.code === "DU_FINDINGS_NOT_ATR_EVIDENCE");
  const bf = await h.run("evaluateBonaFideDiscount", { undiscounted_rate_pct: "6.900", apor_pct: "6.020" }); assert.equal(bf.max_excludable_points, 2); assert.equal(bf.exclusion, "bona_fide_discount_2");
  const bf1 = await h.run("evaluateBonaFideDiscount", { undiscounted_rate_pct: "7.900", apor_pct: "6.020" }); assert.equal(bf1.max_excludable_points, 1); assert.equal(bf1.exclusion, "bona_fide_discount_1");
  const tla = await h.run("computeTotalLoanAmount", { loan_amount_cents: "56000000", prepaid_finance_charges_cents: "378043" }); assert.equal(tla.total_loan_amount_cents, 55_621_957n);
});
