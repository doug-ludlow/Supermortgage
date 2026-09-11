// 29.1 Committing and pricing execution (best efforts and mandatory PE–Whole Loan commitments, commitment terms, LLPAs, servicing fee and buy-up/buy-down, pair-off/extension, over/under delivery tolerance)
// spec/sections/29-secondary-marketing-and-delivery-to-fannie-mae-whole-loan-se/29-1-committing-and-pricing-execution-best-efforts-and-mandatory.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays } from "../../kernel/calendar/business.ts";
import { toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { formatCents } from "../../kernel/money/cents.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_29_1 } from "../../app/tools/section29-1.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FNMA_LLPA_09_09_2026, loadLlpaTables, type LlpaTable } from "../../domain/leads-pricing/ops-20-4.ts";
import type { Lock } from "../../domain/application/ops-21-4.ts";
import {
  CommitmentService, CommitmentRefused, FakePewl, DEFAULT_POLICY, fannieSifma, isSifmaEarlyClose, rollExpirationToBusinessDay, expiringDaySweepHhmm, committingWindow, commitmentExpiration, passThroughRate, mandatoryPtrRange, mandatoryTolerance,
  netPriceForecast, proceedsUnrounded, llpaForecast, executionVarianceCents, servicingStripMonthOne, worstCasePrice, applyAmountChange, classifyFallout, dpaWindowGate, dpaEconomics, bestEffortsExtensionFee, bestEffortsPairOffFee, carryAlternative, pairOffDecision,
  mandatoryPairOff, mandatoryExtensionFee, extensionCapCheck, autoExtensionCap, dailyLimitCheck, duApproveWindow, reconcileDraft, keyDataChangeDue, closedStatusDue, loanAgeDueOn, expectedPurchaseReadyDate, COMMITTING_FEE_EXPENSE, PARTNER_REIMBURSABLE_FROM_SM,
  type Commitment, type CommitmentPolicy,
} from "./ops-29-1.ts";

const AGENT: Actor = { kind: "agent", id: "secondary" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const OPERATOR: Actor = { kind: "human", id: "u-operator", role: "fnma_portal_operator" };
const APP = "app-refi-1", APP_PURCHASE = "app-purchase-1";
/** Eastern time (Fannie Mae's clock) and the creditor's Phoenix clock (MST all year). */
const et = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/New_York"));
const mst = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/Phoenix"));
/** The 09.09.2026 LLPA matrix (20.4) activated for the forecast. */
const LLPA_TABLES: readonly LlpaTable[] = loadLlpaTables(new MemoryEventStore(new FixedClock("2026-09-09T12:00:00.000Z")), FNMA_LLPA_09_09_2026, { at: "2026-09-09T12:00:00.000Z", status: "active" }).tables;
/** Refinance fixture (section README): $560,000 LCOR 30-year fixed 6.125% Phoenix AZ, Classic FICO 765, gross LTV 70.00% (value $800,000), lock Wed Oct 7, 2026 for 45 days → Mon Nov 23 (rolled from Sat Nov 21); DU Approve/Eligible Tue Oct 6; planned disbursement Thu Nov 12. */
const REFI_FORECAST = { value_cents: 80_000_000n, representative_score: 765, score_model: "classic_fico", transaction_type: "limited_cash_out", state: "AZ", county: "Maricopa" } as const;
const REFI: ToolInput = { application_id: APP, lock_id: "lock-refi-1", lineage_id: "lin-refi-1", lock_status: "executed", mlo_approved: true, loan_amount_cents: 56_000_000n, note_rate: "6.125", base_price: "100.875", product_code: "FRM30_CONV", lock_expires_on: "2026-11-23", rate_set_date: "2026-10-07",
  property_address: "4120 N 44th St, Phoenix AZ 85018", borrower_last_name: "Fixture", du_casefile_id: "DU-CF-REFI-1", underwriting_method: "du", du_recommendation_at: et("2026-10-06", "14:05"), disbursement_date_planned: "2026-11-12", forecast: REFI_FORECAST };
/** Purchase fixture (Columbus, OH): HomeReady 30-year fixed 6.375%, $412,000, lock Mon Oct 26, 2026 for 30 days → Wed Nov 25; DU Approve/Eligible Tue Oct 20; Loan Pricing quote for the Dec 9 expiration 100.875 (illustrative). */
const PURCHASE: ToolInput = { application_id: APP_PURCHASE, lock_id: "lock-purch-1", lineage_id: "lin-purch-1", lock_status: "executed", mlo_approved: true, loan_amount_cents: 41_200_000n, note_rate: "6.375", base_price: "100.500", product_code: "FRM30_HR", lock_expires_on: "2026-11-25", rate_set_date: "2026-10-26",
  property_address: "1875 Neil Ave, Columbus OH 43201", borrower_last_name: "Columbus", du_casefile_id: "DU-CF-PURCH-1", underwriting_method: "du", du_recommendation_at: et("2026-10-20", "11:00"), disbursement_date_planned: "2026-11-19" };
/** 21.4's lock row as the store holds it (only the fields `linkCommitment` reads matter). */
const lockRow = (i: ToolInput): Lock => ({ lock_id: String(i.lock_id), application_id: String(i.application_id), lineage_id: String(i.lineage_id), version: 1, kind: "initial", supersedes_lock_id: null, status: "executed", requested_at: et("2026-10-07", "12:05"), quote: {} as Lock["quote"], quote_id: "q-1", quote_id_fnma: null, mlo_approval_escalation_id: null, approved_at: et("2026-10-07", "12:19"), mlo_nmlsr_id: "1234567",
  locked_at: et("2026-10-07", "12:19"), rate_set_date: D(String(i.rate_set_date)), note_rate: String(i.note_rate), price: String(i.base_price), points_cents: 0n, lender_credit_cents: 0n, lock_period_days: 45, expires_on: D(String(i.lock_expires_on)), expires_at: mst(String(i.lock_expires_on), "17:00"), expiry_roll_applied: false, time_zone: "America/Phoenix", product_code: String(i.product_code), loan_amount_cents: i.loan_amount_cents as bigint, worst_case_pricing_applied: false,
  extension_fee_cents: 0n, extension_payer: null, float_down_fee_cents: 0n, commitment_id: null, revised_le_disclosure_id: null, state_agreement_variant: null, property_state: "AZ", cancelled_reason: null, ny_expiry_notice_required: false, borrower_statement: "Please lock my rate today", superseded_quote_ids: [], recorded_by: "agent:pricing" });

/** The 29.1 tools on the bus over the overridden registry (29.1 rows only), a memory ledger, the escalation service, the fake PE–Whole Loan API and the 09.09.2026 LLPA tables; the harness appends the upstream events (21.4 / 23.1 / 26.3 / 29.4) with origination context. */
function harness(nowIso: string, o: { price?: string; by_date?: Record<string, string>; by_rate?: Record<string, string>; policy?: Partial<CommitmentPolicy> } = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["29.1"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId: "", applicationId: APP, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const escalations = new EscalationService(events, clock);
  const pewl = new FakePewl({ price: o.price ?? "101.375", ...(o.by_date ? { by_date: o.by_date } : {}), ...(o.by_rate ? { by_rate: o.by_rate } : {}) });
  const svc = new CommitmentService({ events, clock, pewl, ledger, escalations, llpaTables: LLPA_TABLES, ...(o.policy ? { policy: o.policy } : {}) });
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: { secondary: svc, pewl, llpaTables: LLPA_TABLES }, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_29_1); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("29.1", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): readonly DomainEvent[] => events.ofType(type);
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt = clock.now(), actor: Actor = { kind: "agent", id: "pricing" }, app = APP) => events.append({ type, applicationId: app, aggregate: { kind: "application", id: app }, actor, occurredAt, payload: { application_id: app, ...payload } });
  const lockExecuted = (atIso: string, i: ToolInput = REFI) => upstream("lock.executed", { lock_id: i.lock_id, lineage_id: i.lineage_id, version: 1, note_rate: i.note_rate, price: i.base_price, lock_period_days: 45, expires_on: i.lock_expires_on, expires_at: mst(String(i.lock_expires_on), "17:00"), rate_set_date: i.rate_set_date, quote_id_fnma: null }, atIso, { kind: "agent", id: "pricing" }, String(i.application_id));
  const duFindings = (receivedAt: string, app = APP, casefile = "DU-CF-REFI-1") => upstream("du.findings.received", { casefile_id: casefile, submission_number: 1, recommendation: "approve_eligible", last_updated_at: receivedAt }, receivedAt, { kind: "agent", id: "underwriter" }, app);
  const loanFunded = (atIso: string, disbursement: string, firstPayment = "2027-01-01") => upstream("loan.funded", { source: "origination", funding_date: disbursement, disbursement_date: disbursement, funded_at: atIso, first_payment_date: firstPayment, funded_amount_cents: "56000000" }, atIso, { kind: "agent", id: "funding" });
  const loanPurchased = (atIso: string, purchaseDate: string) => upstream("loan.purchased", { purchase_date: purchaseDate, acquisition_date: purchaseDate, fnma_loan_number: "1234567890" }, atIso, { kind: "agent", id: "secondary" });
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused | CommitmentRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused || e instanceof CommitmentRefused, `expected a refusal, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  /** Worked example 1: lock Wed Oct 7, 2026 12:19 p.m. ET; DU Approve/Eligible Oct 6; the agent prices 12:24 and commits 12:25 p.m. ET. */
  const commitRefi = async (atIso = et("2026-10-07", "12:25"), extra: ToolInput = {}) => { rt.store.put("locks", String(REFI.lock_id), { ...lockRow(REFI) }, AGENT, clock.now()); at(atIso); return run("commitBestEfforts", { ...REFI, at: atIso, ...extra }); };
  const commitment = (id: string): Commitment => svc.get(id);
  const officerApproval = (task: string, commitmentId: string | null = null): string => { const e = escalations.open({ kind: "officer", applicationId: APP, payload: { task, commitment_id: commitmentId, source: "origination" } }, AGENT); escalations.complete(e.id, OFFICER, "doc-officer-approval"); return e.id; };
  return { rt, uow, events, ledger, timers, escalations, pewl, svc, run, at, timer, ofType, upstream, lockExecuted, duFindings, loanFunded, loanPurchased, refused, commitRefi, commitment, officerApproval, decisions, clock };
}
const lastEscalation = (h: ReturnType<typeof harness>, task: string) => h.escalations.list().filter((e) => e.payload.task === task).at(-1);

test("29.1-T1: Given `lock.executed` Wed Oct 7, 2026 12:19 p.m. ET for the refinance fixture with a DU Approve/Eligible dated Oct 6, when the `secondary` agent runs, then a Loan Pricing quote and a Loan Committing confirmation exist by 12:30 p.m. ET, `commitments.expires_on = 2026-12-07`, `commitment_period_days = 61`, `pass_through_rate = 5.8750`, `commitment_price = 101.375`, `net_price_forecast = 101.250`, `proceeds_forecast_cents = 56,700,000`, and 21.4 records `lock.commitment.linked`.", async () => {
  const h = harness(et("2026-10-07", "12:19"));
  h.duFindings(et("2026-10-06", "14:05")); h.lockExecuted(et("2026-10-07", "12:19"));
  const du = h.timer("FNMA_C2_1_2_03_DU_APPROVE_60_GATE")!; assert.equal(du.status, "armed"); assert.equal(du.note, "evaluator:29.1.duApproveWindow");   // window open until Sat Dec 5
  // the agent prices through the Loan Pricing API at 12:24 and commits at 12:25 p.m. ET — both inside the standard window and inside the quote window
  h.at(et("2026-10-07", "12:24"));
  const q = await h.run("priceForCommitment", { product_code: "FRM30_CONV", note_rate: "6.125", expires_on: "2026-12-07", loan_amount_cents: 56_000_000n, at: et("2026-10-07", "12:24"), state: "AZ" });
  assert.equal(q.price, "101.375"); assert.equal(q.pass_through_rate, "5.8750"); assert.equal(q.window, "standard"); assert.equal(q.executable, true); assert.ok(Date.parse(String(q.captured_at)) <= Date.parse(et("2026-10-07", "12:30")));
  const c = await h.commitRefi(et("2026-10-07", "12:25"));
  assert.equal(c.status, "committed"); assert.equal(c.commitment_id_fnma, "BE-2026-0001"); assert.ok(c.confirmation_document_id); assert.ok(Date.parse(String(c.executed_at)) <= Date.parse(et("2026-10-07", "12:30")));
  assert.equal(c.expires_on, "2026-12-07"); assert.equal(c.original_expires_on, "2026-12-07"); assert.equal(c.commitment_period_days, 61);   // Nov 23 + 14 = Mon Dec 7, 2026 (21.4's "Dec 6" is a Sunday); 61 ≤ 90
  assert.equal(c.pass_through_rate, "5.8750"); assert.equal(c.commitment_price, "101.375"); assert.equal(c.remittance_type, "actual_actual"); assert.equal(c.underwriting_method, "du"); assert.equal(c.execution_channel, "api");
  assert.equal(c.expected_purchase_ready_date, "2026-11-19");   // Nov 12 disbursement + 5 fannie_sifma business days
  assert.equal(c.llpa_forecast_pct, "0.125"); assert.equal(c.llpa_forecast_cents, 70_000n); assert.equal(c.net_price_forecast, "101.250"); assert.equal(c.proceeds_forecast_cents, 56_700_000n);   // LCOR / Classic FICO 760–779 / LTV 60.01–70 → 0.125% = $700.00; $560,000 × 1.01250 = $567,000.00
  assert.equal(c.execution_variance_cents, 280_000n);   // 101.375 − 100.875 (20.4 example A) = +0.500 → +$2,800.00 program surplus
  assert.deepEqual(c.sfcs_staged, ["007"]);
  const results = c.guardrail_results as { code: string; passed: boolean }[]; assert.ok(results.every((r) => r.passed)); assert.deepEqual(results.map((r) => r.code), ["lock_state", "mlo_approval", "one_open_per_lineage", "casefile_not_committed", "complete_address", "FNMA_C2_1_2_03_DU_APPROVE_60_GATE", "FNMA_PEWL_DPA_WINDOW_30", "expires_on_business_day_le_90", "FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE", "committing_window", "FNMA_PEWL_COMMIT_ACCEPT_60S"]);
  // the Loan Committing call carried the quote id and the idempotency key lineage + lock; the confirmation is the record
  assert.equal(h.pewl.requests.length, 1); assert.equal(h.pewl.requests[0]!.idempotency_key, "lin-refi-1:lock-refi-1"); assert.equal(h.pewl.requests[0]!.du_casefile_id, "DU-CF-REFI-1");
  const executed = h.ofType("commitment.executed")[0]!; assert.equal(executed.applicationId, APP); assert.equal(executed.payload.type, "best_efforts"); assert.equal(executed.payload.expires_on, "2026-12-07"); assert.equal(executed.payload.ptr, "5.8750");
  // 21.4 records lock.commitment.linked on the lock row
  assert.equal(c.linked, "lock.commitment.linked"); const linked = h.ofType("lock.commitment.linked")[0]!; assert.equal(linked.payload.commitment_id, c.commitment_id); assert.equal(linked.payload.expires_on, "2026-12-07"); assert.equal(h.rt.store.get("locks", "lock-refi-1")!.data.commitment_id, c.commitment_id);
  // the clocks: expiry at 5:00 p.m. ET Dec 7 (satisfied only by loan.purchased), the composite delivery gate, the DU window and the acceptance window closed by the execution
  const exp = h.timer("FNMA_C2_1_2_02_BE_COMMITMENT_EXPIRY")!; assert.equal(exp.status, "armed"); assert.equal(exp.dueDate, "2026-12-07"); assert.equal(exp.dueAt, zonedEpochMs(D("2026-12-07"), "17:00", "America/New_York"));
  assert.equal(h.timer("FNMA_C2_2_DELIVERY_COMMITMENT_EXPIRY")!.note, "evaluator:29.1.deliveryCommitmentGate"); assert.equal(du.status, "satisfied"); assert.equal(h.timer("FNMA_PEWL_COMMIT_ACCEPT_60S")!.status, "satisfied"); assert.equal(h.timer("FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE")!.status, "satisfied");
  assert.deepEqual(evaluateGate("29.1.deliveryCommitmentGate", { expires_on: "2026-12-07", today_et: "2026-11-16", custodian_receipt_possible_on: "2026-11-17" }), { open: true });   // custodian deadline: first morning delivery of Fri Dec 4
  assert.equal(evaluateGate("29.1.deliveryCommitmentGate", { expires_on: "2026-12-07", today_et: "2026-12-07" }).open, false);
  h.loanPurchased(et("2026-11-19", "15:00"), "2026-11-19"); assert.equal(exp.status, "satisfied"); assert.equal(h.timer("FNMA_C2_2_DELIVERY_COMMITMENT_EXPIRY")!.status, "satisfied");   // fulfilled 18 days early
  assert.equal(h.decisions.length, 2); assert.equal(h.decisions[1]!.action, "commitBestEfforts");
});

test("29.1-T2: Given a lock executed Wed Oct 7, 2026 at 6:30 p.m. ET with `secondary.after_hours_commit=false`, then no commit call is made; the request is queued; 29.2's 7:00 a.m. ET position shows the lock as `locked_uncommitted`; the commit executes at 8:15 a.m. ET Thu Oct 8 and `execution_variance_cents` records the overnight price change.", async () => {
  const h = harness(et("2026-10-07", "18:30"), { by_date: { "2026-10-07": "101.375", "2026-10-08": "101.250" } });
  h.duFindings(et("2026-10-06", "14:05")); h.lockExecuted(et("2026-10-07", "18:30"));
  assert.equal(committingWindow(et("2026-10-07", "18:30")).kind, "extended"); assert.equal(committingWindow(et("2026-10-07", "18:30")).cob_price_period, true);   // 5–8 p.m. ET: close-of-business prices, never executable
  const r = await h.refused(h.commitRefi(et("2026-10-07", "18:30"), { flags: { "secondary.after_hours_commit": false } }), "outside_window");
  assert.match(r.message, /queued to 2026-10-08T12:15:00.000Z/);   // 8:15 a.m. ET Thu Oct 8
  assert.equal(h.pewl.requests.length, 0, "no commit call is made");
  const queued = h.svc.queue[0]!; assert.equal(queued.reason, "outside_window"); assert.equal(queued.release_at, et("2026-10-08", "08:15"));
  const rejected = h.ofType("commitment.rejected")[0]!; assert.equal(rejected.payload.reason, "outside_window"); assert.equal(rejected.payload.queued, true);
  const c0 = h.commitment(queued.commitment_id); assert.equal(c0.status, "queued"); assert.equal(c0.commitment_price, "101.375");   // the queue-time mark (a close-of-business price) 29.2 carries overnight
  // 29.2's 7:00 a.m. ET position shows the lock as locked_uncommitted
  h.at(et("2026-10-08", "07:00"));
  const pos = (await h.run("commitBestEfforts", { op: "position", at: et("2026-10-08", "07:00") })).position as { state: string; release_at: string; amount_cents: bigint }[];
  assert.equal(pos.length, 1); assert.equal(pos[0]!.state, "locked_uncommitted"); assert.equal(pos[0]!.release_at, et("2026-10-08", "08:15")); assert.equal(pos[0]!.amount_cents, 56_000_000n);
  // the window opens 8:15 a.m. ET Thu Oct 8: the queue releases, the commit executes on the live Oct 8 price and records the overnight move
  h.at(et("2026-10-08", "08:15"));
  const rel = (await h.run("commitBestEfforts", { op: "release", at: et("2026-10-08", "08:15") })).released as Record<string, unknown>[];
  assert.equal(rel.length, 1); assert.equal(rel[0]!.status, "committed"); assert.equal(rel[0]!.executed_at, et("2026-10-08", "08:15")); assert.equal(rel[0]!.commitment_price, "101.250");
  assert.equal(rel[0]!.overnight_price_change, "-0.125"); assert.equal(rel[0]!.execution_variance_cents, 210_000n);   // (101.250 − 100.875) × $560,000 = +$2,100 after the −0.125 overnight move ($70,000 × … = −$700 vs the Oct 7 mark)
  assert.equal(executionVarianceCents("101.250", "101.375", 56_000_000n), -70_000n);
  assert.equal(h.pewl.requests.length, 1); assert.equal(h.svc.queue.length, 0); assert.equal(h.ofType("commitment.executed").length, 1);
  assert.equal(h.commitment(queued.commitment_id).effective_on, "2026-10-08"); assert.equal(h.commitment(queued.commitment_id).expires_on, "2026-12-07");
  // with secondary.after_hours_commit=true the extended window commits at a live (non-COB) price — 9:00 p.m. ET is past the 5–8 p.m. close-of-business period
  const h2 = harness(et("2026-10-07", "21:00")); h2.duFindings(et("2026-10-06", "14:05"));
  const c2 = await h2.commitRefi(et("2026-10-07", "21:00"), { flags: { "secondary.after_hours_commit": true } }); assert.equal(c2.status, "committed");
  await h2.refused(h2.run("commitBestEfforts", { ...REFI, lineage_id: "lin-x", lock_id: "lock-x", use_close_of_business_price: true }), "STALE_OR_COB_PRICE");
});

test("29.1-T3: Given the purchase-fixture commitment and a loan-amount change to $409,500 at 2:10 p.m. ET Thu Nov 5, 2026, then `FNMA_C2_1_2_03_KEY_DATA_CHANGE_1BD` is due Fri Nov 6, 2026 5:00 p.m. ET; a modification filed at 2:31 p.m. ET Nov 5 satisfies it with `amount_cents = 40,950,000` and `max_amount_cents = 41,200,000`; if no modification exists at 5:00 p.m. ET Nov 6 the timer breaches sev 2 and an `officer` escalation opens.", async () => {
  const h = harness(et("2026-10-26", "14:41"), { by_rate: { "6.3750": "100.875" } });
  h.duFindings(et("2026-10-20", "11:00"), APP_PURCHASE, "DU-CF-PURCH-1"); h.lockExecuted(et("2026-10-26", "14:41"), PURCHASE);
  const c = await h.run("commitBestEfforts", { ...PURCHASE, at: et("2026-10-26", "14:41") });
  assert.equal(c.commitment_price, "100.875"); assert.equal(c.expires_on, "2026-12-09"); assert.equal(c.commitment_period_days, 44); assert.equal(c.pass_through_rate, "6.1250");   // Nov 25 + 14 = Wed Dec 9, 2026
  // Thu Nov 5, 2026 2:10 p.m. ET: the appraisal comes in at $455,000 and the borrower reduces the loan to $409,500 (LTV 90.00%) → 21.4's renegotiation version
  h.at(et("2026-11-05", "14:10"));
  h.upstream("lock.relocked", { lock_id: "lock-purch-2", supersedes_lock_id: "lock-purch-1", version: 2, note_rate: "6.375", price: "100.500", expires_on: "2026-11-25", rate_set_date: "2026-10-26", commitment_id: c.commitment_id, key_data_change: "loan_amount", loan_amount_cents: "40950000" }, et("2026-11-05", "14:10"), { kind: "agent", id: "pricing" }, APP_PURCHASE);
  const kd = h.timer("FNMA_C2_1_2_03_KEY_DATA_CHANGE_1BD")!;
  assert.equal(kd.status, "armed"); assert.equal(kd.dueDate, "2026-11-06"); assert.equal(kd.dueAt, zonedEpochMs(D("2026-11-06"), "17:00", "America/New_York"));   // Fri Nov 6, 2026 5:00 p.m. ET
  assert.deepEqual(keyDataChangeDue(et("2026-11-05", "14:10")), { due_on: D("2026-11-06"), due_at: et("2026-11-06", "17:00") });
  // the agent files the modification 2:31 p.m. ET Nov 5: amount_cents falls, max_amount_cents (the fee base) stays; no re-price (amount decrease; product and rate unchanged)
  h.at(et("2026-11-05", "14:31"));
  const m = await h.run("modifyCommitment", { commitment_id: c.commitment_id, changed_at: et("2026-11-05", "14:10"), reported_at: et("2026-11-05", "14:31"), after: { loan_amount_cents: 40_950_000n }, lock_id: "lock-purch-2" });
  assert.equal(m.amount_cents, 40_950_000n); assert.equal(m.max_amount_cents, 41_200_000n); assert.equal(m.repriced, false); assert.equal(m.worst_case_applied, false); assert.equal(m.late, false); assert.equal(m.due_at, et("2026-11-06", "17:00"));
  assert.deepEqual((m.fields as { before: Record<string, unknown> }).before, { loan_amount_cents: 41_200_000n }); assert.deepEqual((m.fields as { after: Record<string, unknown> }).after, { loan_amount_cents: "40950000" });
  assert.equal(kd.status, "satisfied"); assert.equal(kd.satisfiedByEventId, h.ofType("commitment.modified")[0]!.id);
  assert.equal(h.commitment(String(c.commitment_id)).lock_id, "lock-purch-2"); assert.equal(h.commitment(String(c.commitment_id)).commitment_price, "100.875");
  assert.deepEqual(applyAmountChange(41_200_000n, 41_200_000n, 40_950_000n), { amount_cents: 40_950_000n, max_amount_cents: 41_200_000n });
  assert.deepEqual(applyAmountChange(41_200_000n, 41_200_000n, 41_500_000n), { amount_cents: 41_500_000n, max_amount_cents: 41_500_000n });   // an increase raises both
  // revised proceeds forecast $409,500 × 1.00875 = $413,083.125 → $413,083.13 half-up
  assert.equal(netPriceForecast({ commitment_price: "100.875", llpa_forecast_pct: "0.000", upb_at_purchase_cents: 40_950_000n }).proceeds_forecast_cents, 41_308_313n);
  // no modification by 5:00 p.m. ET Nov 6: the timer breaches sev 2 and an officer escalation opens (compliance-sentinel copied; the modification is still made)
  const h2 = harness(et("2026-10-26", "14:41"), { by_rate: { "6.3750": "100.875" } }); h2.duFindings(et("2026-10-20", "11:00"), APP_PURCHASE, "DU-CF-PURCH-1");
  const c2 = await h2.run("commitBestEfforts", { ...PURCHASE, at: et("2026-10-26", "14:41") });
  h2.upstream("lock.relocked", { lock_id: "lock-purch-2", version: 2, key_data_change: "loan_amount", loan_amount_cents: "40950000", commitment_id: c2.commitment_id }, et("2026-11-05", "14:10"), { kind: "agent", id: "pricing" }, APP_PURCHASE);
  assert.equal(h2.timers.evaluate(et("2026-11-06", "16:59")).length, 0);
  const breaches = h2.timers.evaluate(et("2026-11-06", "17:01"));
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.instance.code, "FNMA_C2_1_2_03_KEY_DATA_CHANGE_1BD"); assert.equal(breaches[0]!.severity, 2); assert.ok(breaches[0]!.escalateTo.includes("officer"));
  const escId = h2.svc.handleBreach(breaches[0]!, et("2026-11-06", "17:01")); const esc = h2.escalations.list().find((e) => e.id === escId)!;
  assert.equal(esc.kind, "officer"); assert.equal(esc.severity, "sev2"); assert.equal(esc.payload.task, "key_data_notice_late"); assert.equal(esc.applicationId, APP_PURCHASE);
  const late = await h2.run("modifyCommitment", { commitment_id: c2.commitment_id, changed_at: et("2026-11-05", "14:10"), reported_at: et("2026-11-06", "17:30"), after: { loan_amount_cents: 40_950_000n } });
  assert.equal(late.late, true); assert.equal(h2.timer("FNMA_C2_1_2_03_KEY_DATA_CHANGE_1BD")!.status, "satisfied_late");
});

test("29.1-T4: Given a note-rate change from 6.125% to 6.250% on the refinance commitment when the live price for the new terms is 101.750, then `commitment_modifications.repriced=true`, `new_commitment_price = 101.375` (worse case), `worst_case_applied=true`.", async () => {
  const h = harness(et("2026-10-07", "12:25")); h.duFindings(et("2026-10-06", "14:05"));
  const c = await h.commitRefi();
  // Mon Nov 2: relocked at 6.250% (23.1 example 3); the live price for the new terms is 101.750 — worse case keeps the lender at min(101.375, 101.750)
  h.at(et("2026-11-02", "15:00"));
  const m = await h.run("modifyCommitment", { commitment_id: c.commitment_id, changed_at: et("2026-11-02", "15:00"), after: { note_rate: "6.250" }, live_price_for_new_terms: "101.750" });
  assert.equal(m.repriced, true); assert.equal(m.new_commitment_price, "101.375"); assert.equal(m.worst_case_applied, true); assert.equal(m.commitment_price, "101.375");
  assert.equal(m.note_rate, "6.2500"); assert.equal(m.pass_through_rate, "6.0000");   // the strip stays 25 bps
  assert.deepEqual(worstCasePrice("101.375", "101.750"), { new_commitment_price: "101.375", worst_case_applied: true, repriced: true });
  assert.deepEqual(worstCasePrice("101.375", "100.900"), { new_commitment_price: "100.900", worst_case_applied: true, repriced: true });   // a lower live price is the worse case for the lender
  const ev = h.ofType("commitment.modified")[0]!; assert.equal(ev.payload.repriced, true); assert.equal(ev.payload.new_commitment_price, "101.375"); assert.equal(ev.payload.worst_case_applied, true); assert.equal(ev.payload.change, "note_rate");
  assert.equal(h.rt.store.get("commitment_modifications", String(m.modification_id))!.data.worst_case_applied, true);
  // the maximum PTR carried over the life (the extension fee base) is now 6.0000
  assert.equal(h.svc.maxPtrOverLife(h.commitment(String(c.commitment_id))), "6.0000");
  // a remittance-type or execution-type change is refused in code (C2-1.2-03)
  await h.refused(h.run("modifyCommitment", { commitment_id: c.commitment_id, changed_at: et("2026-11-02", "15:00"), after: { remittance_type: "scheduled_scheduled" } }), "REMITTANCE_TYPE_IMMUTABLE");
});

test("29.1-T5: Given `lock.cancelled{lender_declination}` Fri Oct 23, 2026, then the commitment moves to `fallout` the same day with `pair_off_expected=false` and `dpa_exposure_until = 2026-11-22`; a `commitBestEfforts` request for the same borrower and property on Tue Nov 10 is refused with `reason='dpa_window'` unless `dpa_acknowledged=true`; the same request on Mon Nov 23 succeeds.", async () => {
  const h = harness(et("2026-10-07", "12:25")); h.duFindings(et("2026-10-06", "14:05"));
  const c = await h.commitRefi();
  // Fri Oct 23, 2026: the application is denied (21.4-T12) → lock.cancelled{lender_declination} → fallout the same day, no fee, DPA window to Sun Nov 22
  h.at(et("2026-10-23", "11:00")); h.upstream("lock.cancelled", { lock_id: "lock-refi-1", lineage_id: "lin-refi-1", reason: "lender_declination", commitment_id: c.commitment_id }, et("2026-10-23", "11:00"));
  const f = await h.run("moveToFallout", { commitment_id: c.commitment_id, reason: "lender_declination", at: et("2026-10-23", "11:00") });
  assert.equal(f.status, "fallout"); assert.equal(f.fallout_reason, "lender_declination"); assert.equal(f.pair_off_expected, false); assert.equal(f.dpa_exposure_until, "2026-11-22");
  const ev = h.ofType("commitment.fallout.recorded")[0]!; assert.equal(ev.payload.reason, "lender_declination"); assert.equal(ev.payload.pair_off_expected, false); assert.equal(ev.payload.fallout_on, "2026-10-23"); assert.equal(ev.payload.dpa_exposure_until, "2026-11-22");
  assert.deepEqual(classifyFallout("lender_declination", D("2026-10-23")), { status: "fallout", fallout_reason: "lender_declination", pair_off_expected: false, fallout_on: D("2026-10-23"), dpa_exposure_until: D("2026-11-22") });
  const w = h.timer("FNMA_PEWL_DPA_WINDOW_30")!; assert.equal(w.status, "armed"); assert.equal(w.note, "evaluator:29.1.dpaWindow"); assert.equal(w.anchorDate, "2026-10-23");
  assert.equal(h.svc.open("lin-refi-1").length, 0);
  // Tue Nov 10: re-approved and relocked; a commitBestEfforts for the same borrower and property inside the window is refused with reason dpa_window …
  const relock: ToolInput = { ...REFI, lock_id: "lock-refi-2", lineage_id: "lin-refi-2", rate_set_date: "2026-11-10", lock_expires_on: "2026-12-10" };
  h.at(et("2026-11-10", "10:05"));
  const r = await h.refused(h.run("commitBestEfforts", { ...relock, at: et("2026-11-10", "10:05") }), "dpa_window");
  assert.match(r.message, /dpa_window/); assert.equal(h.ofType("commitment.rejected").at(-1)!.payload.reason, "dpa_window"); assert.equal(h.pewl.requests.length, 1);
  assert.deepEqual(evaluateGate("29.1.dpaWindow", { dpa_exposure_until: "2026-11-22", requested_on: "2026-11-10", same_borrower_property: true }), { open: false, reason: "dpa_window" });
  assert.equal(dpaWindowGate({ dpa_exposure_until: "2026-11-22", requested_on: "2026-11-10", same_borrower_property: false }).open, true);   // a different property is not a duplicate
  // … unless dpa_acknowledged=true (the DPA/worse-case price accepted by the economics rule; the officer above $1,000)
  const ack = await h.run("commitBestEfforts", { ...relock, lock_id: "lock-refi-2b", lineage_id: "lin-refi-2b", at: et("2026-11-10", "10:06"), dpa_acknowledged: true });
  assert.equal(ack.status, "committed"); assert.equal(ack.duplicate_of_commitment_id, c.commitment_id);
  await h.refused(h.run("commitBestEfforts", { ...relock, lock_id: "lock-refi-2c", lineage_id: "lin-refi-2c", dpa_acknowledged: true, dpa_officer_approved: true }), "DPA_OFFICER_APPROVAL");   // an agent cannot assert the officer's approval
  // worked example 3(a): waiting to Mon Nov 23 costs 13 days of uncommitted exposure (~$1,120) against a $3,500 DPA when the market rallied to 102.000 → the agent waits (officer notified beyond the 5-day policy)
  assert.deepEqual(dpaEconomics({ amount_cents: 56_000_000n, original_price: "101.375", live_price: "102.000", expected_move_points: "0.200", days_uncommitted: 13 }), { dpa_cost_cents: 350_000n, exposure_cents: 112_000n, choice: "wait", officer_notification: true });
  // the same request on Mon Nov 23 (the window elapsed Sun Nov 22) succeeds without acknowledgement
  const h3 = harness(et("2026-10-07", "12:25")); h3.duFindings(et("2026-10-06", "14:05")); const c3 = await h3.commitRefi();
  h3.at(et("2026-10-23", "11:00")); await h3.run("moveToFallout", { commitment_id: c3.commitment_id, reason: "lender_declination", at: et("2026-10-23", "11:00") });
  h3.duFindings(et("2026-11-09", "09:00"));
  h3.at(et("2026-11-23", "08:15"));
  const ok = await h3.run("commitBestEfforts", { ...relock, du_recommendation_at: et("2026-11-09", "09:00"), rate_set_date: "2026-11-23", lock_expires_on: "2026-12-23", at: et("2026-11-23", "08:15") });
  assert.equal(ok.status, "committed"); assert.equal(ok.duplicate_of_commitment_id, null); assert.equal(ok.executed_at, et("2026-11-23", "08:15"));
  assert.equal(h3.timer("FNMA_PEWL_DPA_WINDOW_30")!.status, "satisfied");
});

test("29.1-T6: Given `loan.funded` Thu Nov 12, 2026 3:40 p.m. ET, then `FNMA_PEWL_CLOSED_STATUS_1BD` is due Fri Nov 13 5:00 p.m. ET; `setClosedStatus` at 4:05 p.m. ET Nov 12 satisfies it and `commitments.status='closed'`; consummation on Nov 6 does not start the timer.", async () => {
  const h = harness(et("2026-10-07", "12:25")); h.duFindings(et("2026-10-06", "14:05"));
  const c = await h.commitRefi();
  // consummation Fri Nov 6 (inside the lock) does not start the closed-status clock — only the disbursement does
  h.at(et("2026-11-06", "14:00")); h.upstream("closing.consummated", { consummated_on: "2026-11-06" }, et("2026-11-06", "14:00"), { kind: "agent", id: "title-closing" });
  assert.equal(h.timers.byCode("FNMA_PEWL_CLOSED_STATUS_1BD").length, 0);
  await h.refused(h.run("setClosedStatus", { commitment_id: c.commitment_id, disbursement_date: "2026-11-06", at: et("2026-11-06", "14:05") }), "not_funded");
  // loan.funded Thu Nov 12, 2026 3:40 p.m. ET (disbursement) → due Fri Nov 13 5:00 p.m. ET
  h.at(et("2026-11-12", "15:40")); h.loanFunded(et("2026-11-12", "15:40"), "2026-11-12", "2027-01-01");
  const t = h.timer("FNMA_PEWL_CLOSED_STATUS_1BD")!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2026-11-13"); assert.equal(t.dueAt, zonedEpochMs(D("2026-11-13"), "17:00", "America/New_York"));
  assert.deepEqual(closedStatusDue(D("2026-11-12")), { due_on: D("2026-11-13"), due_at: et("2026-11-13", "17:00") });
  // setClosedStatus at 4:05 p.m. ET Nov 12 satisfies it; the loan is now a mandatory obligation, visible in Loan Delivery within 15–20 minutes
  h.at(et("2026-11-12", "16:05"));
  const s = await h.run("setClosedStatus", { commitment_id: c.commitment_id, disbursement_date: "2026-11-12", first_payment_date: "2027-01-01", at: et("2026-11-12", "16:05") });
  assert.equal(s.status, "closed"); assert.equal(s.fnma_loan_status, "closed"); assert.equal(s.closed_status_set_at, et("2026-11-12", "16:05")); assert.equal(s.expected_purchase_ready_date, "2026-11-19");
  assert.equal(t.status, "satisfied"); const ev = h.ofType("commitment.closed_status.set")[0]!; assert.equal(ev.payload.mandatory_obligation, true); assert.equal(ev.payload.late, false); assert.equal(ev.payload.loan_delivery_visible_by, et("2026-11-12", "16:25")); assert.equal(ev.payload.loan_age_due_on, "2027-06-30");
  // closed status arms the 60-day auto-extension cap (Dec 7 + 60 = Fri Feb 5, 2027) and the loan-age reference (Jan 1, 2027 first payment → Wed Jun 30, 2027); the 30-day manual cap closes
  assert.equal(h.timer("FNMA_C2_1_2_02_BE_CLOSED_AUTOEXT_CAP_60")!.dueDate, "2027-02-05"); assert.equal(h.timer("FNMA_B2_1_5_02_LOAN_AGE_6M_PURCHASE_READY")!.dueDate, "2027-06-30"); assert.equal(h.timer("FNMA_C2_1_2_02_BE_EXTENSION_CAP_30")!.status, "satisfied");
  assert.equal(loanAgeDueOn(D("2027-01-01")), "2027-06-30"); assert.equal(expectedPurchaseReadyDate(D("2026-11-12")), "2026-11-19");
  // fallout is no longer available on a closed loan — the option is a pair-off
  await h.refused(h.run("moveToFallout", { commitment_id: c.commitment_id, reason: "lender_declination" }), "closed_is_mandatory");
  // no closed status by 5:00 p.m. ET Nov 13 → sev 2, operator task, officer notified
  const h2 = harness(et("2026-10-07", "12:25")); h2.duFindings(et("2026-10-06", "14:05")); await h2.commitRefi(); h2.loanFunded(et("2026-11-12", "15:40"), "2026-11-12");
  const b = h2.timers.evaluate(et("2026-11-13", "17:01")); assert.equal(b.length, 1); assert.equal(b[0]!.severity, 2); h2.svc.handleBreach(b[0]!, et("2026-11-13", "17:01"));
  assert.ok(h2.escalations.list().some((e) => e.kind === "human_portal_task" && e.payload.step === "closed_status")); assert.ok(h2.escalations.list().some((e) => e.kind === "officer" && e.payload.task === "closed_status_late"));
});

test("29.1-T7: Given a closed refinance commitment (max amount $560,000, PTR 5.875%, price 101.375) and a live price of 102.125 on Mon Nov 30, 2026, when a lender-requested pair-off is prepared, then `fee_cents = 420,000` ($4,200.00), an `officer_pair_off_approval` escalation is opened (fee > $2,500), and the package states the alternative carry of $5,483.33 for 60 days; with a live price of 100.500 the fee is $0.00 and `cash_back_cents = 0`.", async () => {
  const h = harness(et("2026-10-07", "12:25")); h.duFindings(et("2026-10-06", "14:05"));
  const c = await h.commitRefi();
  h.at(et("2026-11-12", "15:40")); h.loanFunded(et("2026-11-12", "15:40"), "2026-11-12"); h.at(et("2026-11-12", "16:05")); await h.run("setClosedStatus", { commitment_id: c.commitment_id, disbursement_date: "2026-11-12", at: et("2026-11-12", "16:05") });
  // Mon Nov 30: post-closing QC finds an undisclosed lien — non-delivery is certain; live price 11:02 a.m. ET 102.125 (rates fell ~25 bps since Oct 7)
  h.at(et("2026-11-30", "11:02"));
  const pkg = await h.run("preparePairOffPackage", { commitment_id: c.commitment_id, market_price: "102.125", at: et("2026-11-30", "11:02"), reason: "28.2 post-closing QC: undisclosed recorded lien; ineligible and not curable before delivery", certain_non_delivery: true, payer: "sm" });
  assert.equal(pkg.kind, "lender_requested"); assert.equal(pkg.amount_cents, 56_000_000n); assert.equal(pkg.fee_cents, 420_000n); assert.equal(pkg.cash_back_cents, 0n); assert.equal(pkg.decision, "pair_off_now"); assert.equal(pkg.status, "prepared");   // $560,000 × (102.125 − 101.375)/100 = $4,200.00
  const p = pkg.package as Record<string, unknown>; assert.equal(p.fee_display, "$4,200.00"); assert.equal(p.officer_approval_required, true); assert.equal(p.accept_window_seconds, 60);
  const alt = p.alternative as Record<string, unknown>; assert.equal(alt.days, 60); assert.equal(alt.carry_cents, "548333"); assert.equal(alt.carry_display, "$5,483.33"); assert.equal(alt.per_diem, "$91.3889/day"); assert.equal(alt.auto_pair_off_on, "2027-02-05");
  assert.match(String(alt.statement), /60 days of auto-extension carry at \$91\.3889\/day → \$5,483\.33, plus open market risk/);
  // fee > $2,500 → officer_pair_off_approval escalation (SLA 1 hour); the operator task waits for the approval
  const esc = lastEscalation(h, "officer_pair_off_approval")!; assert.equal(esc.kind, "officer"); assert.equal(esc.payload.sla_hours, 1); assert.equal(pkg.approval_escalation_id, esc.id); assert.equal(pkg.operator_escalation_id, null);
  assert.deepEqual(bestEffortsPairOffFee(56_000_000n, "101.375", "102.125"), { fee_cents: 420_000n, cash_back_cents: 0n, price_delta: "0.750" });
  assert.deepEqual(carryAlternative(56_000_000n, "5.8750", 60).carry_cents, 548_333n);
  // an agent may not assert the approval; the officer approves 11:40, the operator executes inside the 60-second window at 11:52, the e-mail confirmation is ingested
  await h.refused(h.run("preparePairOffPackage", { op: "execute", commitment_id: c.commitment_id, officer_approved: true }), "OFFICER_PAIR_OFF_APPROVAL");
  await h.refused(h.run("preparePairOffPackage", { op: "execute", commitment_id: c.commitment_id, executed_at: et("2026-11-30", "11:52") }), "officer_approval_required");
  h.at(et("2026-11-30", "11:40")); h.escalations.complete(esc.id, OFFICER, "doc-officer-approval-1");
  h.at(et("2026-11-30", "11:52"));
  const done = await h.run("preparePairOffPackage", { op: "execute", commitment_id: c.commitment_id, approval_escalation_id: esc.id, executed_at: et("2026-11-30", "11:52"), confirmation_document_id: "doc-pewl-pairoff-email-1" }, OPERATOR);
  assert.equal(done.status, "executed"); assert.equal(done.fee_cents, 420_000n); assert.equal(h.commitment(String(c.commitment_id)).status, "paired_off");
  const ev = h.ofType("commitment.paired_off")[0]!; assert.equal(ev.payload.kind, "lender_requested"); assert.equal(ev.payload.fee_cents, "420000"); assert.equal(ev.payload.cash_back_cents, "0"); assert.equal(ev.payload.payer, "sm");
  // the fee draft reconciles: payer SM → committing_fee_expense $4,200.00 / partner_reimbursable_from_sm $4,200.00
  const rec = await h.run("reconcileFeeDrafts", { drafts: [{ draft_id: "FD-2026-12-01-0007", notification_date: "2026-12-01", draft_date: "2026-12-02", commitment_id_fnma: c.commitment_id_fnma, fee_type: "pair_off", amount_cents: 420_000n }] });
  assert.equal(rec.matched, 1); const set = h.ledger.sets()[0]!; assert.equal(set.lines[0]!.account.account, COMMITTING_FEE_EXPENSE.account); assert.equal(set.lines[0]!.amountCents, 420_000n); assert.equal(set.lines[1]!.account.account, PARTNER_REIMBURSABLE_FROM_SM.account); assert.equal(set.lines[1]!.amountCents, -420_000n);
  // had the Nov 30 price been 100.500 (rates up), the fee is $0.00 and no cash back is assumed on a best-efforts pair-off
  const h2 = harness(et("2026-10-07", "12:25")); h2.duFindings(et("2026-10-06", "14:05")); const c2 = await h2.commitRefi();
  h2.loanFunded(et("2026-11-12", "15:40"), "2026-11-12"); h2.at(et("2026-11-12", "16:05")); await h2.run("setClosedStatus", { commitment_id: c2.commitment_id, disbursement_date: "2026-11-12" });
  h2.at(et("2026-11-30", "11:02"));
  const flat = await h2.run("preparePairOffPackage", { commitment_id: c2.commitment_id, market_price: "100.500", at: et("2026-11-30", "11:02"), reason: "undisclosed lien" });
  assert.equal(flat.fee_cents, 0n); assert.equal(flat.cash_back_cents, 0n); assert.equal((flat.package as Record<string, unknown>).fee_display, "$0.00"); assert.equal((flat.package as Record<string, unknown>).officer_approval_required, false); assert.ok(flat.operator_escalation_id);
  // a pair-off before closed status is refused (PE–WL: the option exists once the loan is closed)
  const h3 = harness(et("2026-10-07", "12:25")); h3.duFindings(et("2026-10-06", "14:05")); const c3 = await h3.commitRefi();
  await h3.refused(h3.run("preparePairOffPackage", { commitment_id: c3.commitment_id, market_price: "102.125" }), "pair_off_requires_closed");
});

test("29.1-T8: Given an 8-day manual extension requested while `committed`, then `per_diem_cents = 9,138.89` ($560,000 × 0.05875 / 360) and `fee_cents = 73,111` ($731.11); a further extension that would bring cumulative manual extensions to 31 days is refused by `FNMA_C2_1_2_02_BE_EXTENSION_CAP_30`.", async () => {
  const h = harness(et("2026-10-07", "12:25")); h.duFindings(et("2026-10-06", "14:05"));
  const c = await h.commitRefi();
  h.at(et("2026-11-30", "10:00"));
  const e = await h.run("requestExtension", { commitment_id: c.commitment_id, days: 8, at: et("2026-11-30", "10:00"), cause: "closing moved to Dec 4 (dry-state recording delay)" });
  assert.equal(e.kind, "manual"); assert.equal(e.per_diem_cents, "9138.89"); assert.equal(e.fee_cents, 73_111n); assert.equal(e.new_expires_on, "2026-12-15"); assert.equal(e.manual_extension_days, 8); assert.equal(e.payer, "sm");   // $560,000 × 0.05875 / 360 = 9,138.89 cents/day × 8 = $731.11
  assert.deepEqual(bestEffortsExtensionFee(56_000_000n, "5.8750", 8), { per_diem_cents: "9138.89", per_diem_display: "$91.3889/day", fee_cents: 73_111n });
  const ev = h.ofType("commitment.extended")[0]!; assert.equal(ev.payload.kind, "manual"); assert.equal(ev.payload.days, 8); assert.equal(ev.payload.fee_cents, "73111"); assert.equal(ev.payload.new_expires_on, "2026-12-15");
  assert.equal(h.commitment(String(c.commitment_id)).expires_on, "2026-12-15"); assert.equal(h.commitment(String(c.commitment_id)).original_expires_on, "2026-12-07");
  // the extension is a UI-only step: a fnma_portal_operator task with the 4-hour SLA, satisfied by the confirmation the operator attaches
  const task = lastEscalation(h, "fnma_portal_commitment_task")!; assert.equal(task.kind, "human_portal_task"); assert.equal(task.ownerRole, "fnma_portal_operator"); assert.equal(task.payload.step, "extension"); assert.equal(task.payload.sla_hours, 4); assert.equal(e.escalation_id, task.id);
  const sla = h.timer("SM_PORTAL_OPERATOR_COMMITMENT_TASK_4H")!; assert.equal(sla.status, "armed"); assert.equal(sla.dueAt, Date.parse(et("2026-11-30", "14:00")));
  await h.run("reconcilePewlStatus", { op: "operator_confirmation", commitment_id: c.commitment_id, escalation_id: task.id, confirmation_document_id: "doc-pewl-ext-conf-1", at: et("2026-11-30", "11:15") }, OPERATOR);
  assert.equal(sla.status, "satisfied");
  // a further extension that would bring cumulative manual extensions to 31 days is refused by the 30-day cap
  const r = await h.refused(h.run("requestExtension", { commitment_id: c.commitment_id, days: 23, at: et("2026-12-10", "10:00") }), "FNMA_C2_1_2_02_BE_EXTENSION_CAP_30");
  assert.match(r.message, /31 days/); assert.deepEqual(extensionCapCheck(8, 23, 30), { allowed: false, cumulative_after: 31 }); assert.deepEqual(extensionCapCheck(8, 22, 30), { allowed: true, cumulative_after: 30 });
  assert.equal(evaluateGate("29.1.beExtensionCap", { manual_extension_days: 8, requested_days: 23 }).open, false); assert.deepEqual(evaluateGate("29.1.beExtensionCap", { manual_extension_days: 8, requested_days: 22 }), { open: true });
  assert.equal(h.timer("FNMA_C2_1_2_02_BE_EXTENSION_CAP_30")!.status, "armed"); assert.equal(h.commitment(String(c.commitment_id)).manual_extension_days, 8);
  // a partner-borne fee needs its documented cause
  await h.refused(h.run("requestExtension", { commitment_id: c.commitment_id, days: 2, payer: "partner" }), "FEE_ALLOCATION_NEEDS_CAUSE");
});

test("29.1-T9: Given a closed commitment with `original_expires_on = 2026-12-07` and no purchase, then `FNMA_C2_1_2_02_BE_CLOSED_AUTOEXT_CAP_60` is anchored at Fri Feb 5, 2027; an `officer` escalation opens no later than Fri Jan 29, 2027; if unresolved, the automatic pair-off is recorded from the fee draft with `kind='automatic'`.", async () => {
  const h = harness(et("2026-10-07", "12:25")); h.duFindings(et("2026-10-06", "14:05"));
  const c = await h.commitRefi();
  h.at(et("2026-11-12", "15:40")); h.loanFunded(et("2026-11-12", "15:40"), "2026-11-12"); h.at(et("2026-11-12", "16:05")); await h.run("setClosedStatus", { commitment_id: c.commitment_id, disbursement_date: "2026-11-12" });
  const cap = h.timer("FNMA_C2_1_2_02_BE_CLOSED_AUTOEXT_CAP_60")!; assert.equal(cap.status, "armed"); assert.equal(cap.anchorDate, "2026-12-07"); assert.equal(cap.dueDate, "2027-02-05"); assert.equal(cap.dueAt, zonedEpochMs(D("2027-02-05"), "17:00", "America/New_York"));   // Dec 7 + 60 = Fri Feb 5, 2027
  assert.deepEqual(autoExtensionCap(D("2026-12-07")), { cap_on: D("2027-02-05"), decision_by: D("2027-01-29") });   // five business days earlier: Feb 4, 3, 2, 1, Jan 29
  // the night the commitment expires PE–WL auto-extends five days at a time (fee) — recorded by the 4:30 p.m. sweep from the confirmation
  h.at(et("2026-12-07", "16:30")); const s0 = await h.run("reconcilePewlStatus", { op: "sweep", at: et("2026-12-07", "16:30") });
  assert.deepEqual(s0.auto_extended, [c.commitment_id]); assert.equal(h.commitment(String(c.commitment_id)).expires_on, "2026-12-14"); assert.equal(h.ofType("commitment.extended")[0]!.payload.kind, "auto_5d"); assert.equal(h.ofType("commitment.extended")[0]!.payload.fee_cents, "45694");   // 5 × 9,138.89 cents
  // the pair-off decision is escalated to the officer no later than Fri Jan 29, 2027 (not on Thu Jan 28)
  h.at(et("2027-01-28", "16:30")); assert.deepEqual((await h.run("reconcilePewlStatus", { op: "sweep", at: et("2027-01-28", "16:30") })).escalated, []);
  h.at(et("2027-01-29", "16:30")); const s1 = await h.run("reconcilePewlStatus", { op: "sweep", at: et("2027-01-29", "16:30") });
  assert.deepEqual(s1.escalated, [c.commitment_id]); const esc = lastEscalation(h, "pair_off_decision")!; assert.equal(esc.kind, "officer"); assert.equal(esc.payload.cap_on, "2027-02-05"); assert.equal(esc.payload.decision_by, "2027-01-29"); assert.equal(esc.payload.per_diem, "$91.3889/day");
  // unresolved at the cap: the timer breaches sev 1 and the automatic pair-off is recorded from the fee draft with kind='automatic'
  const b = h.timers.evaluate(et("2027-02-05", "17:01")).filter((x) => x.instance.code === "FNMA_C2_1_2_02_BE_CLOSED_AUTOEXT_CAP_60"); assert.equal(b.length, 1); assert.equal(b[0]!.severity, 1);
  h.svc.handleBreach(b[0]!, et("2027-02-05", "17:01")); assert.equal(lastEscalation(h, "auto_pair_off_at_cap")!.severity, "sev1");
  h.at(et("2027-02-08", "07:00"));
  const rec = await h.run("reconcileFeeDrafts", { drafts: [{ draft_id: "FD-2027-02-08-0001", notification_date: "2027-02-08", draft_date: "2027-02-09", commitment_id_fnma: c.commitment_id_fnma, fee_type: "pair_off", amount_cents: 210_000n }] });
  assert.equal(rec.matched, 1); const po = h.svc.pairOffs.find((x) => x.commitment_id === c.commitment_id)!; assert.equal(po.kind, "automatic"); assert.equal(po.source, "draft"); assert.equal(po.status, "executed"); assert.equal(po.fee_cents, 210_000n); assert.equal(po.amount_cents, 56_000_000n);
  assert.equal(h.commitment(String(c.commitment_id)).status, "auto_paired_off"); const ev = h.ofType("commitment.paired_off")[0]!; assert.equal(ev.payload.kind, "automatic"); assert.equal(ev.payload.automatic, true);
  assert.equal(h.rt.store.get("committing_fee_drafts", "FD-2027-02-08-0001")!.data.reconciled_to, po.pair_off_id);
});

test("29.1-T10: Given a DU Approve/Eligible dated Sat Aug 1, 2026 and a lock on Wed Oct 7, 2026 (67 days), then `commitBestEfforts` with `underwriting_method='du'` is refused by `FNMA_C2_1_2_03_DU_APPROVE_60_GATE`; after an 23.1 resubmission on Oct 7 the commit succeeds.", async () => {
  const h = harness(et("2026-10-07", "12:25"));
  h.duFindings(et("2026-08-01", "10:00"));   // Sat Aug 1, 2026 Approve/Eligible: 67 days before Wed Oct 7
  assert.deepEqual(duApproveWindow(et("2026-08-01", "10:00"), et("2026-10-07", "12:25"), "du"), { open: false, days: 67, window_closes_on: D("2026-09-30"), reason: "FNMA_C2_1_2_03_DU_APPROVE_60_GATE: DU Approve/Eligible is 67 days old (> 60)" });
  const r = await h.refused(h.commitRefi(et("2026-10-07", "12:25"), { du_recommendation_at: et("2026-08-01", "10:00") }), "FNMA_C2_1_2_03_DU_APPROVE_60_GATE");
  assert.match(r.message, /67 days old/); assert.equal(h.pewl.requests.length, 0); assert.equal(h.ofType("commitment.rejected")[0]!.payload.reason, "FNMA_C2_1_2_03_DU_APPROVE_60_GATE");
  assert.equal(evaluateGate("29.1.duApproveWindow", { du_recommendation_at: et("2026-08-01", "10:00"), executed_at: et("2026-10-07", "12:25"), underwriting_method: "du" }).open, false);
  assert.deepEqual(evaluateGate("29.1.duApproveWindow", { du_recommendation_at: et("2026-08-01", "10:00"), executed_at: et("2026-10-07", "12:25"), underwriting_method: "other" }), { open: true });   // 'Other' needs no DU recommendation (open question 5)
  // after a 23.1 resubmission on Oct 7 (Approve/Eligible the same day) the commit succeeds under `du`
  h.duFindings(et("2026-10-07", "12:40"));
  const c = await h.commitRefi(et("2026-10-07", "12:45"), { du_recommendation_at: et("2026-10-07", "12:40") });
  assert.equal(c.status, "committed"); assert.equal(c.underwriting_method, "du"); assert.equal((c.guardrail_results as { code: string; detail: string }[]).find((g) => g.code === "FNMA_C2_1_2_03_DU_APPROVE_60_GATE")!.detail, "0 days since Approve/Eligible");
  assert.equal(h.timers.byCode("FNMA_C2_1_2_03_DU_APPROVE_60_GATE").at(-1)!.status, "satisfied"); assert.equal(h.timers.byCode("FNMA_C2_1_2_03_DU_APPROVE_60_GATE")[0]!.status, "satisfied");
});

test("29.1-T11: Given `execution.mandatory_enabled=false`, when 29.2 requests a $5,000,000 mandatory commitment, then `prepareMandatoryPackage` is refused; with the flag true and an approved `officer_mandatory_authorization`, the operator package shows `tolerance_low_cents = 487,500,000`, `tolerance_high_cents = 512,500,000`, `over_delivery_cap_cents = 125,000,000`, five PTRs 5.625–6.125%, `expires_on = 2026-12-07`.", async () => {
  const h = harness(et("2026-10-07", "10:00"));
  const req: ToolInput = { amount_cents: 500_000_000n, product_code: "FRM30_CONV", min_ptr: "5.625", period_days: 60, remittance_type: "actual_actual", at: et("2026-10-07", "10:00"), hedge_request_id: "hedge-req-1" };
  // execution.mandatory_enabled=false (the default): refused in the guardrail and in the service
  await h.refused(h.run("prepareMandatoryPackage", { ...req, flags: { "execution.mandatory_enabled": false } }), "MANDATORY_DISABLED");
  await h.refused(h.run("prepareMandatoryPackage", req), "mandatory_disabled");
  assert.equal(h.svc.rows.length, 0); assert.equal(h.escalations.list().length, 0);
  // flag on but no officer authorization — and an agent asserting one — are refused
  await h.refused(h.run("prepareMandatoryPackage", { ...req, flags: { "execution.mandatory_enabled": true } }), "officer_mandatory_authorization_required");
  await h.refused(h.run("prepareMandatoryPackage", { ...req, flags: { "execution.mandatory_enabled": true }, officer_authorization: { escalation_id: "x", status: "approved" } }), "OFFICER_MANDATORY_AUTHORIZATION");
  // with the flag true and an approved officer_mandatory_authorization escalation the operator package is prepared
  const auth = h.officerApproval("officer_mandatory_authorization");
  const c = await h.run("prepareMandatoryPackage", { ...req, flags: { "execution.mandatory_enabled": true }, authorization_escalation_id: auth });
  assert.equal(c.type, "mandatory"); assert.equal(c.status, "authorized"); assert.equal(c.execution_channel, "ui_operator");
  assert.equal(c.tolerance_low_cents, 487_500_000n); assert.equal(c.tolerance_high_cents, 512_500_000n); assert.equal(c.expires_on, "2026-12-07"); assert.equal(c.commitment_period_days, 61);   // Oct 7 + 60 = Sun Dec 6 → Mon Dec 7, 2026
  const pkg = c.package as Record<string, unknown>;
  assert.equal(pkg.tolerance_low_cents, "487500000"); assert.equal(pkg.tolerance_high_cents, "512500000"); assert.equal(pkg.over_delivery_cap_cents, "125000000"); assert.equal(pkg.tolerance_cents, "12500000");
  assert.deepEqual(pkg.ptrs, ["5.6250", "5.7500", "5.8750", "6.0000", "6.1250"]); assert.equal(pkg.ptr_range, "5.6250–6.1250"); assert.equal(pkg.expires_on, "2026-12-07"); assert.equal(pkg.rolled_from, "2026-12-06"); assert.equal(pkg.officer_authorization_escalation_id, auth); assert.equal(pkg.accept_window_seconds, 60);
  assert.deepEqual(mandatoryTolerance(500_000_000n), { tolerance_cents: 12_500_000n, tolerance_low_cents: 487_500_000n, tolerance_high_cents: 512_500_000n, over_delivery_cap_cents: 125_000_000n, post_over_delivery_tolerance_cents: 5_000n });
  assert.deepEqual(mandatoryTolerance(20_000_000n), { tolerance_cents: 1_000_000n, tolerance_low_cents: 19_000_000n, tolerance_high_cents: 21_000_000n, over_delivery_cap_cents: 5_000_000n, post_over_delivery_tolerance_cents: 5_000n });   // $200,000: the $10,000 floor beats 2.5%
  assert.deepEqual(mandatoryPtrRange("5.625").ptrs, ["5.6250", "5.7500", "5.8750", "6.0000", "6.1250"]);
  const task = lastEscalation(h, "fnma_portal_commitment_task")!; assert.equal(task.kind, "human_portal_task"); assert.equal(task.payload.step, "mandatory_commit"); assert.equal(c.operator_escalation_id, task.id);
  // the operator's confirmation executes it (price 101.250 for the 5.875% PTR, illustrative); the mandatory clocks arm on the commitment aggregate
  const x = await h.run("prepareMandatoryPackage", { op: "execute", commitment_id: c.commitment_id, commitment_id_fnma: "MAND-2026-0001", price: "101.250", executed_at: et("2026-10-07", "10:12"), confirmation_document_id: "doc-pewl-mand-1" }, OPERATOR);
  assert.equal(x.status, "open"); assert.equal(x.commitment_price, "101.250"); assert.equal(x.remaining_balance_cents, 500_000_000n); assert.equal(x.ptr_range_low, "5.6250"); assert.equal(x.ptr_range_high, "6.1250");
  const exp = h.timer("FNMA_C2_1_1_03_MAND_COMMITMENT_EXPIRY")!; assert.equal(exp.dueDate, "2026-12-07"); assert.deepEqual(exp.subject, { kind: "commitment", id: c.commitment_id }); assert.equal(h.timer("FNMA_PEWL_MAND_TOLERANCE_GATE")!.note, "evaluator:29.1.mandToleranceGate"); assert.equal(h.timer("FNMA_C2_1_1_04_MAND_EXTENSION_CAP_30")!.note, "evaluator:29.1.mandExtensionCap");
  assert.equal(evaluateGate("29.1.mandToleranceGate", { original_amount_cents: 500_000_000n, purchased_cents: 460_000_000n }).open, false); assert.deepEqual(evaluateGate("29.1.mandToleranceGate", { original_amount_cents: 500_000_000n, purchased_cents: 487_500_000n }), { open: true });
  // a best-efforts commitment can never be converted (C2-1.2-03); a Sales Desk order needs a partner-authorized trader
  await h.refused(h.run("commitBestEfforts", { ...REFI, convert_to_mandatory: true }), "BEST_EFFORTS_TO_MANDATORY");
  await h.refused(h.run("prepareMandatoryPackage", { ...req, flags: { "execution.mandatory_enabled": true }, authorization_escalation_id: auth, channel: "sales_desk" }), "SALES_DESK_AUTHORIZED_TRADER");
});

test("29.1-T12: Given a mandatory commitment (price 101.250) with $4,600,000 purchased on Fri Dec 4, 2026 and a live price of 100.750, then a partial pair-off of $275,000 yields `cash_back_cents = 137,500`; with a live price of 101.750 it yields `fee_cents = 137,500`; a 10-day extension of the $400,000 remaining balance at the lowest PTR 5.625% costs `fee_cents = 62,500`.", async () => {
  const h = harness(et("2026-10-07", "10:00"), { policy: { mandatory_enabled: true } });
  const auth = h.officerApproval("officer_mandatory_authorization");
  const c = await h.run("prepareMandatoryPackage", { amount_cents: 500_000_000n, product_code: "FRM30_CONV", min_ptr: "5.625", period_days: 60, at: et("2026-10-07", "10:00"), authorization_escalation_id: auth });
  await h.run("prepareMandatoryPackage", { op: "execute", commitment_id: c.commitment_id, commitment_id_fnma: "MAND-2026-0001", price: "101.250", executed_at: et("2026-10-07", "10:12") }, OPERATOR);
  // by Fri Dec 4 the partner has purchased $4,600,000 against it — $275,000 short of the $4,875,000 lower band
  h.at(et("2026-12-04", "14:30"));
  const after = await h.run("prepareMandatoryPackage", { op: "purchase", commitment_id: c.commitment_id, purchased_cents: 460_000_000n, at: et("2026-12-04", "09:00") });
  assert.equal(after.status, "open"); assert.equal(after.purchased_cents, 460_000_000n); assert.equal(after.remaining_balance_cents, 40_000_000n); assert.equal(h.ofType("commitment.fulfilled").length, 0);
  // the partial pair-off of $275,000 at 2:30 p.m. ET (before 5:00 p.m. ET on the expiration date): live 100.750 → cash back $1,375.00 (C2-1.1-04)
  const poAuth = h.officerApproval("officer_mandatory_authorization", String(c.commitment_id));
  const cb = await h.run("preparePairOffPackage", { commitment_id: c.commitment_id, amount_cents: 27_500_000n, market_price: "100.750", at: et("2026-12-04", "14:30"), authorization_escalation_id: poAuth, reason: "shortfall to the lower tolerance band" });
  assert.equal(cb.amount_cents, 27_500_000n); assert.equal(cb.cash_back_cents, 137_500n); assert.equal(cb.fee_cents, 0n); assert.equal((cb.package as Record<string, unknown>).cash_back_display, "$1,375.00"); assert.equal((cb.package as Record<string, unknown>).request_by, et("2026-12-07", "17:00"));
  // with a live price of 101.750 it is a fee of $1,375.00
  const fee = await h.run("preparePairOffPackage", { commitment_id: c.commitment_id, amount_cents: 27_500_000n, market_price: "101.750", at: et("2026-12-04", "14:31"), authorization_escalation_id: poAuth, reason: "shortfall to the lower tolerance band" });
  assert.equal(fee.fee_cents, 137_500n); assert.equal(fee.cash_back_cents, 0n); assert.equal((fee.package as Record<string, unknown>).officer_approval_required, false);   // $1,375.00 < $2,500 threshold
  assert.deepEqual(mandatoryPairOff(27_500_000n, "101.250", "100.750"), { fee_cents: 0n, cash_back_cents: 137_500n, price_delta: "-0.500" }); assert.deepEqual(mandatoryPairOff(27_500_000n, "101.250", "101.750"), { fee_cents: 137_500n, cash_back_cents: 0n, price_delta: "0.500" });
  // a 10-day extension of the $400,000 remaining balance at the lowest PTR 5.625% costs $625.00
  const ext = await h.run("requestExtension", { commitment_id: c.commitment_id, days: 10, at: et("2026-12-04", "14:32") });
  assert.equal(ext.fee_cents, 62_500n); assert.equal(ext.per_diem_cents, "6250.00"); assert.equal(ext.new_expires_on, "2026-12-17"); assert.deepEqual(mandatoryExtensionFee(40_000_000n, "5.6250", 10), { per_diem_cents: "6250.00", fee_cents: 62_500n });
  await h.refused(h.run("requestExtension", { commitment_id: c.commitment_id, days: 21, at: et("2026-12-04", "14:33") }), "FNMA_C2_1_1_04_MAND_EXTENSION_CAP_30");   // 10 + 21 = 31 > 30
  // executing the pair-off leaves $125,000 remaining — inside the band once the late loans purchase; the cash back reconciles to committing_cash_back_receivable
  const done = await h.run("preparePairOffPackage", { op: "execute", commitment_id: c.commitment_id, pair_off_id: cb.pair_off_id, executed_at: et("2026-12-04", "14:40"), confirmation_document_id: "doc-pewl-pairoff-mand-1" }, OPERATOR);
  assert.equal(done.status, "executed"); assert.equal(h.commitment(String(c.commitment_id)).remaining_balance_cents, 12_500_000n); assert.equal(h.commitment(String(c.commitment_id)).paired_off_cents, 27_500_000n); assert.equal(h.commitment(String(c.commitment_id)).status, "open");
  const rec = await h.run("reconcileFeeDrafts", { drafts: [{ draft_id: "FD-2026-12-07-0002", notification_date: "2026-12-07", draft_date: "2026-12-08", commitment_id_fnma: "MAND-2026-0001", fee_type: "pair_off", amount_cents: -137_500n }] });
  assert.equal(rec.matched, 1); assert.equal(h.ledger.sets()[0]!.lines[0]!.account.account, "committing_cash_back_receivable"); assert.equal(h.ledger.sets()[0]!.lines[0]!.amountCents, 137_500n);
  const fill = await h.run("prepareMandatoryPackage", { op: "purchase", commitment_id: c.commitment_id, purchased_cents: 40_000_000n, at: et("2026-12-10", "09:00") });
  assert.equal(fill.status, "fulfilled"); assert.equal(fill.purchased_cents, 500_000_000n); assert.equal(h.ofType("commitment.fulfilled")[0]!.payload.within_tolerance, true); assert.equal(h.timer("FNMA_C2_1_1_03_MAND_COMMITMENT_EXPIRY")!.status, "satisfied");
});

test("29.1-T13: Given a Fee Draft Notification of $731.11 for the extension in T8, then `committing_fee_drafts.status='matched'` and the ledger posts `committing_fee_expense` $731.11 (payer SM); a notification of $760.00 produces `status='exception'` and an `officer` task.", async () => {
  const h = harness(et("2026-10-07", "12:25")); h.duFindings(et("2026-10-06", "14:05"));
  const c = await h.commitRefi();
  h.at(et("2026-11-30", "10:00")); await h.run("requestExtension", { commitment_id: c.commitment_id, days: 8, at: et("2026-11-30", "10:00"), cause: "dry-state recording delay" });
  // the Fee Draft Notification of $731.11 for the extension matches (±$1.00) and posts committing_fee_expense $731.11 (payer SM) / partner_reimbursable_from_sm
  h.at(et("2026-12-02", "06:45"));
  const rec = await h.run("reconcileFeeDrafts", { drafts: [{ draft_id: "FD-2026-12-02-0001", notification_date: "2026-12-02", draft_date: "2026-12-03", commitment_id_fnma: c.commitment_id_fnma, fee_type: "extension", amount_cents: 73_111n }], at: et("2026-12-02", "06:45") });
  const d = (rec.drafts as Record<string, unknown>[])[0]!; assert.equal(d.status, "matched"); assert.equal(d.variance_cents, 0n); assert.equal(d.reconciled_to, h.svc.extensions[0]!.extension_id); assert.ok(d.ledger_set_id);
  const set = h.ledger.sets()[0]!; assert.equal(set.id, d.ledger_set_id); assert.equal(set.effectiveDate, "2026-12-03");
  assert.deepEqual(set.lines.map((l) => [l.account.account, l.amountCents]), [["committing_fee_expense", 73_111n], ["partner_reimbursable_from_sm", -73_111n]]); assert.ok(set.lines.every((l) => l.ruleRef.startsWith("29.1 rule 15")));
  assert.equal(h.ofType("committing_fee.drafted").length, 1); const ev = h.ofType("committing_fee.reconciled")[0]!; assert.equal(ev.payload.payer, "sm"); assert.equal(ev.payload.ledger_set_id, set.id); assert.equal(ev.payload.amount_cents, "73111");
  assert.equal(h.rt.store.get("committing_fee_drafts", "FD-2026-12-02-0001")!.data.status, "matched");
  // a notification of $760.00 against the same extension produces status='exception' (variance $28.89) and an officer task (Fannie Mae inquiry within 30 days)
  const h2 = harness(et("2026-10-07", "12:25")); h2.duFindings(et("2026-10-06", "14:05")); const c2 = await h2.commitRefi();
  h2.at(et("2026-11-30", "10:00")); await h2.run("requestExtension", { commitment_id: c2.commitment_id, days: 8, at: et("2026-11-30", "10:00") });
  const bad = await h2.run("reconcileFeeDrafts", { drafts: [{ draft_id: "FD-2026-12-02-0002", notification_date: "2026-12-02", draft_date: "2026-12-03", commitment_id_fnma: c2.commitment_id_fnma, fee_type: "extension", amount_cents: 76_000n }] });
  const x = (bad.drafts as Record<string, unknown>[])[0]!; assert.equal(x.status, "exception"); assert.equal(x.variance_cents, 2_889n); assert.equal(x.ledger_set_id, null); assert.equal(h2.ledger.sets().length, 0);
  const esc = h2.escalations.list().find((e) => e.id === x.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.payload.task, "fee_draft_exception"); assert.equal(esc.payload.inquiry_window_days, 30);
  const ex = h2.ofType("committing_fee.exception")[0]!; assert.equal(ex.payload.variance_cents, "2889"); assert.equal(ex.payload.inquiry_by, "2027-01-01");
  // the ±$1.00 rounding tolerance: $732.11 still matches (variance exactly $1.00); $732.12 does not
  assert.deepEqual(reconcileDraft(73_211n, 73_111n), { status: "matched", variance_cents: 100n }); assert.deepEqual(reconcileDraft(73_212n, 73_111n), { status: "exception", variance_cents: 101n }); assert.deepEqual(reconcileDraft(76_000n, 73_111n), { status: "exception", variance_cents: 2_889n });
  assert.equal(DEFAULT_POLICY.fee_draft_tolerance_cents, 100n);
});

test("29.1-T14: Given a requested expiration of Fri Dec 25, 2026 (SIFMA full close), then the adapter rolls to Mon Dec 28, 2026 before calling the API; a requested Sun Dec 6 rolls to Mon Dec 7; a requested Fri Nov 27 (early close) is accepted as a business day with the expiring-day sweep at 12:30 p.m. ET.", async () => {
  // Fri Dec 25, 2026 is a SIFMA full close → Mon Dec 28; Sun Dec 6 → Mon Dec 7; Fri Nov 27 (early close 2:00 p.m. ET) is a business day with the sweep at 12:30 p.m. ET
  assert.deepEqual(rollExpirationToBusinessDay(D("2026-12-25")), { expires_on: D("2026-12-28"), rolled: true, early_close: false, sweep_hhmm: "16:30" });
  assert.deepEqual(rollExpirationToBusinessDay(D("2026-12-06")), { expires_on: D("2026-12-07"), rolled: true, early_close: false, sweep_hhmm: "16:30" });
  assert.deepEqual(rollExpirationToBusinessDay(D("2026-11-27")), { expires_on: D("2026-11-27"), rolled: false, early_close: true, sweep_hhmm: "12:30" });
  assert.equal(isSifmaEarlyClose(D("2026-11-27")), true); assert.equal(isSifmaEarlyClose(D("2026-12-24")), true); assert.equal(isSifmaEarlyClose(D("2026-12-31")), true); assert.equal(isSifmaEarlyClose(D("2026-11-26")), false);
  assert.equal(expiringDaySweepHhmm(D("2026-11-27")), "12:30"); assert.equal(expiringDaySweepHhmm(D("2026-12-07")), "16:30");
  // the 2026 SIFMA full closes the fixture calendar bites: Columbus Day Mon Oct 12, Veterans Day Wed Nov 11, Thanksgiving Thu Nov 26, Christmas Fri Dec 25, New Year's Day Fri Jan 1, 2027 — and Good Friday (Apr 3, 2026), which the federal calendar lacks
  for (const d of ["2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2026-04-03"]) assert.equal(fannieSifma.isBusinessDay(D(d)), false, d);
  for (const d of ["2026-11-27", "2026-12-24", "2026-12-31", "2026-12-28"]) assert.equal(fannieSifma.isBusinessDay(D(d)), true, d);
  // the adapter rolls before calling the Loan Pricing API (the request carries Dec 28) and the standard window ends at the 2:00 p.m. early close on Nov 27
  const h = harness(et("2026-12-04", "10:00"));
  const q = await h.run("priceForCommitment", { product_code: "FRM30_CONV", note_rate: "6.125", expires_on: "2026-12-25", loan_amount_cents: 56_000_000n, at: et("2026-12-04", "10:00") });
  assert.equal(q.expires_on, "2026-12-28"); assert.equal(q.expiration_rolled, true); assert.equal(h.pewl.quotes[0]!.raw.request && (h.pewl.quotes[0]!.raw.request as { expires_on: string }).expires_on, "2026-12-28");
  const w = committingWindow(et("2026-11-27", "13:59")); assert.equal(w.kind, "standard"); assert.equal(w.early_close, true); assert.equal(w.closes_at, et("2026-11-27", "14:00")); assert.equal(committingWindow(et("2026-11-27", "14:01")).kind, "extended");
  assert.equal(committingWindow(et("2026-10-12", "10:00")).kind, "closed"); assert.equal(committingWindow(et("2026-10-12", "10:00")).next_open_at, et("2026-10-13", "08:15"));   // Columbus Day: no committing; queue to Tue Oct 13 8:15 a.m. ET
  // the mandatory package for a commitment expiring Fri Nov 27 asks for requests by 2:00 p.m. ET (the safe assumption)
  const h2 = harness(et("2026-11-17", "10:00"), { policy: { mandatory_enabled: true } }); const auth = h2.officerApproval("officer_mandatory_authorization");
  const m = await h2.run("prepareMandatoryPackage", { amount_cents: 100_000_000n, product_code: "FRM30_CONV", min_ptr: "5.625", period_days: 10, at: et("2026-11-17", "10:00"), authorization_escalation_id: auth });
  assert.equal(m.expires_on, "2026-11-27"); assert.equal((m.package as Record<string, unknown>).request_by, et("2026-11-27", "14:00"));
});

test("29.1-T15: Given the day's executed commitments total $199,600,000 and a new $560,000 request, then `FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE` refuses the commit, queues it, and opens an `officer` escalation to contact the Sales Desk.", async () => {
  const h = harness(et("2026-10-07", "09:00"), { policy: { mandatory_enabled: true } }); h.duFindings(et("2026-10-06", "14:05"));
  // the day's executed commitments total $199,600,000 (a mandatory commitment executed 9:12 a.m. ET)
  const auth = h.officerApproval("officer_mandatory_authorization");
  const big = await h.run("prepareMandatoryPackage", { amount_cents: 19_960_000_000n, product_code: "FRM30_CONV", min_ptr: "5.625", period_days: 60, at: et("2026-10-07", "09:00"), authorization_escalation_id: auth });
  await h.run("prepareMandatoryPackage", { op: "execute", commitment_id: big.commitment_id, commitment_id_fnma: "MAND-2026-0009", price: "101.250", executed_at: et("2026-10-07", "09:12") }, OPERATOR);
  assert.equal(h.svc.executedTodayCents(et("2026-10-07", "12:25")), 19_960_000_000n);
  // a new $560,000 request: the gate refuses the commit, queues it to the next day and opens an officer escalation to contact the Sales Desk
  const r = await h.refused(h.commitRefi(et("2026-10-07", "12:25")), "FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE");
  assert.match(r.message, /\$200,160,000\.00 exceeds the daily limit; queued to 2026-10-08T12:15:00.000Z/);
  assert.equal(h.pewl.requests.length, 0); const q = h.svc.queue[0]!; assert.equal(q.reason, "daily_limit"); assert.equal(q.release_at, et("2026-10-08", "08:15"));
  const c = h.commitment(q.commitment_id); assert.equal(c.status, "queued"); assert.equal(c.queued_release_at, et("2026-10-08", "08:15"));
  const esc = lastEscalation(h, "sales_desk_daily_limit_approval")!; assert.equal(esc.kind, "officer"); assert.equal(esc.severity, "sev2"); assert.equal(esc.payload.executed_today_cents, "19960000000"); assert.equal(esc.payload.amount_cents, "56000000"); assert.match(String(esc.payload.action), /Sales Desk/);
  const rej = h.ofType("commitment.rejected").at(-1)!; assert.equal(rej.payload.reason, "FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE"); assert.equal(rej.payload.queued, true);
  assert.equal(h.ofType("commitment.requested")[0]!.payload.executed_today_cents, "19960000000"); assert.equal(h.timer("FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE")!.status, "armed");
  assert.deepEqual(dailyLimitCheck(19_960_000_000n, 56_000_000n), { allowed: false, after_cents: 20_016_000_000n, headroom_cents: 40_000_000n });
  assert.equal(evaluateGate("29.1.dailyLimit", { executed_today_cents: 19_960_000_000n, amount_cents: 56_000_000n }).open, false); assert.deepEqual(evaluateGate("29.1.dailyLimit", { executed_today_cents: 19_960_000_000n, amount_cents: 40_000_000n }), { open: true });
  // next day the queue releases and the commit executes
  h.at(et("2026-10-08", "08:15")); const rel = (await h.run("commitBestEfforts", { op: "release", at: et("2026-10-08", "08:15") })).released as Record<string, unknown>[];
  assert.equal(rel.length, 1); assert.equal(rel[0]!.status, "committed"); assert.equal(h.svc.executedTodayCents(et("2026-10-08", "09:00")), 56_000_000n); assert.equal(h.timer("FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE")!.status, "satisfied");
});

test("29.1-T16: Given a VantageScore 4.0 tri-merge (771) instead of Classic FICO on the refinance fixture, then `llpa_forecast_pct = 0.250`, `net_price_forecast = 101.125`, `proceeds_forecast_cents = 56,630,000`, and SFC 067 is staged for 29.3.", async () => {
  const h = harness(et("2026-10-07", "12:25")); h.duFindings(et("2026-10-06", "14:05"));
  // a VantageScore 4.0 tri-merge (771) instead of Classic FICO: the lcor_vs4 grid, row 760–779 × LTV 60.01–70 → 0.250% (one band below the Classic FICO 0.125%)
  const c = await h.commitRefi(et("2026-10-07", "12:25"), { forecast: { ...REFI_FORECAST, representative_score: 771, score_model: "vantagescore_4" } });
  assert.equal(c.commitment_price, "101.375"); assert.equal(c.llpa_forecast_pct, "0.250"); assert.equal(c.llpa_forecast_cents, 140_000n); assert.equal(c.net_price_forecast, "101.125"); assert.equal(c.proceeds_forecast_cents, 56_630_000n);
  assert.deepEqual(c.sfcs_staged, ["007", "067"]);   // SFC 067 staged for 29.3 alongside the LCOR 007
  const f = c.forecast as Record<string, unknown>; assert.equal(f.matrix_version, "09.09.2026"); assert.deepEqual(f.cells, [{ grid: "lcor_vs4", row: "760–779", col: "60.01–70.00%", pct: "0.250" }]);
  const ev = h.ofType("commitment.forecast.updated")[0]!; assert.equal(ev.payload.llpa_forecast_pct, "0.250"); assert.deepEqual(ev.payload.sfcs, ["007", "067"]); assert.equal(ev.payload.expected_purchase_ready_date, "2026-11-19");
  // the same forecast through computeNetPriceForecast (a later refresh on loan.funded / delivery.submitted / custody.certified)
  const again = await h.run("computeNetPriceForecast", { commitment_id: c.commitment_id, forecast: { ...REFI_FORECAST, representative_score: 771, score_model: "vantagescore_4", expected_purchase_ready_date: "2026-11-19" } });
  assert.equal(again.llpa_forecast_pct, "0.250"); assert.equal(again.proceeds_forecast_cents, 56_630_000n); assert.deepEqual(again.sfcs, ["007", "067"]);
  await h.refused(h.run("computeNetPriceForecast", { commitment_id: c.commitment_id, forecast: REFI_FORECAST, use_lock_date_matrix: true }), "LLPA_MATRIX_BY_PURCHASE_READY");
  // the pure calculator: Classic FICO 765 on the same fixture is 0.125% / $700.00 / 101.250 / $567,000.00
  const fico = llpaForecast({ tables: LLPA_TABLES, expected_purchase_ready_date: D("2026-11-19"), loan_amount_cents: 56_000_000n, ...REFI_FORECAST });
  assert.equal(fico.llpa_forecast_pct, "0.125"); assert.equal(fico.llpa_forecast_cents, 70_000n); assert.deepEqual(fico.sfcs, ["007"]);
  const vs4 = llpaForecast({ tables: LLPA_TABLES, expected_purchase_ready_date: D("2026-11-19"), loan_amount_cents: 56_000_000n, ...REFI_FORECAST, representative_score: 771, score_model: "vantagescore_4" });
  assert.equal(vs4.llpa_forecast_pct, "0.250"); assert.equal(vs4.llpa_forecast_cents, 140_000n); assert.deepEqual(vs4.sfcs, ["007", "067"]);
});

test("29.1 worked figures: the refinance and purchase fixtures, the pair-off, extension and mandatory arithmetic reproduce the spec's dollar amounts", () => {
  // Worked example 1 — refinance fixture: LLPA 0.125% of $560,000 = $700.00; premium (101.375 − 100) = $7,700.00; proceeds $567,000.00; execution variance +0.500 = $2,800.00; month-one servicing strip $116.67
  const f = netPriceForecast({ commitment_price: "101.375", llpa_forecast_pct: "0.125", upb_at_purchase_cents: 56_000_000n });
  assert.equal(f.llpa_forecast_cents, 70_000n); assert.equal(f.premium_cents, 770_000n); assert.equal(f.net_price_forecast, "101.250"); assert.equal(f.proceeds_forecast_cents, 56_700_000n);
  assert.equal(f.proceeds_forecast_cents, 56_000_000n + f.premium_cents - f.llpa_forecast_cents);
  assert.equal(executionVarianceCents("101.375", "100.875", 56_000_000n), 280_000n);
  assert.equal(servicingStripMonthOne(56_000_000n), 11_667n);
  assert.equal(passThroughRate("6.125"), "5.8750"); assert.equal(commitmentExpiration(D("2026-11-23"), D("2026-10-07")).expires_on, "2026-12-07"); assert.equal(commitmentExpiration(D("2026-11-23"), D("2026-10-07")).commitment_period_days, 61);
  // guardrail: day volume $18.4M + $0.56M < $200M (the refinance commit on Oct 7)
  assert.deepEqual(dailyLimitCheck(1_840_000_000n, 56_000_000n), { allowed: true, after_cents: 1_896_000_000n, headroom_cents: 18_160_000_000n });
  assert.equal(formatCents(56_000_000n, { symbol: true }), "$560,000.00");
  // Worked example 2 — purchase fixture: $412,000 × 1.00875 = $415,605.00; revised $409,500 × 1.00875 = $413,083.125 → $413,083.13 half-up (a truncation would show $413,083.12)
  assert.equal(netPriceForecast({ commitment_price: "100.875", llpa_forecast_pct: "0.000", upb_at_purchase_cents: 41_200_000n }).proceeds_forecast_cents, 41_560_500n);
  assert.deepEqual(proceedsUnrounded(40_950_000n, "100.875"), { half_up_cents: 41_308_313n, truncated_cents: 41_308_312n, exact: "413083.125" });
  assert.equal(netPriceForecast({ commitment_price: "100.875", llpa_forecast_pct: "0.000", upb_at_purchase_cents: 40_950_000n }).proceeds_forecast_cents, 41_308_313n);
  assert.equal(passThroughRate("6.375"), "6.1250");
  // Worked example 3 — pair-off: $560,000 × 0.0075 = $4,200.00 (> the $2,500 threshold); the alternative carry $91.3889/day × 60 = $5,483.33; at 100.500 the fee is $0.00
  assert.equal(bestEffortsPairOffFee(56_000_000n, "101.375", "102.125").fee_cents, 420_000n); assert.ok(bestEffortsPairOffFee(56_000_000n, "101.375", "102.125").fee_cents > DEFAULT_POLICY.pair_off_officer_threshold_cents);
  const carry = carryAlternative(56_000_000n, "5.8750", 60); assert.equal(carry.carry_cents, 548_333n); assert.equal(carry.per_diem_display, "$91.3889/day"); assert.equal(formatCents(carry.carry_cents, { symbol: true }), "$5,483.33");
  assert.equal(bestEffortsPairOffFee(56_000_000n, "101.375", "100.500").fee_cents, 0n); assert.equal(formatCents(bestEffortsPairOffFee(56_000_000n, "101.375", "100.500").fee_cents, { symbol: true }), "$0.00");
  assert.equal(pairOffDecision({ certain_non_delivery: false, cure_probability: "0.50", fee_now_cents: 420_000n, remaining_carry_cents: 548_333n }), "pair_off_now");   // (1 − 0.5) × ($4,200 + $5,483.33) = $4,841.67 > $4,200 → pair off now
  assert.equal(pairOffDecision({ certain_non_delivery: false, cure_probability: "0.90", fee_now_cents: 420_000n, remaining_carry_cents: 548_333n }), "carry");
  // DPA economics: 13 days of exposure at 0.20 points on $560,000 = $1,120 versus a 0.625-point DPA = $3,500 when the market rallied to 102.000
  assert.deepEqual(dpaEconomics({ amount_cents: 56_000_000n, original_price: "101.375", live_price: "102.000", expected_move_points: "0.200", days_uncommitted: 13 }), { dpa_cost_cents: 350_000n, exposure_cents: 112_000n, choice: "wait", officer_notification: true });
  // T8 / T13 — extension: 9,138.89 cents per diem × 8 = $731.11; a $760.00 draft is $28.89 off (> the ±$1.00 rounding tolerance)
  const ext = bestEffortsExtensionFee(56_000_000n, "5.8750", 8); assert.equal(ext.per_diem_cents, "9138.89"); assert.equal(ext.fee_cents, 73_111n); assert.equal(formatCents(ext.fee_cents, { symbol: true }), "$731.11");
  assert.deepEqual(reconcileDraft(76_000n, 73_111n), { status: "exception", variance_cents: 2_889n }); assert.deepEqual(reconcileDraft(73_211n, 73_111n), { status: "matched", variance_cents: 100n });
  // Worked example 4 — mandatory: tolerance $125,000 → $4,875,000–$5,125,000; over-delivery cap $1,250,000; $275,000 pair-off at 100.750 vs 101.250 = −$1,375.00 (cash back) / at 101.750 = $1,375.00 (fee); 10-day extension of $400,000 at 5.625% = $625.00
  const tol = mandatoryTolerance(500_000_000n); assert.equal(tol.tolerance_cents, 12_500_000n); assert.equal(tol.tolerance_low_cents, 487_500_000n); assert.equal(tol.tolerance_high_cents, 512_500_000n); assert.equal(tol.over_delivery_cap_cents, 125_000_000n);
  assert.equal(mandatoryPairOff(27_500_000n, "101.250", "100.750").cash_back_cents, 137_500n); assert.equal(mandatoryPairOff(27_500_000n, "101.250", "101.750").fee_cents, 137_500n); assert.equal(formatCents(137_500n, { symbol: true }), "$1,375.00");
  assert.equal(mandatoryExtensionFee(40_000_000n, "5.6250", 10).fee_cents, 62_500n); assert.equal(formatCents(62_500n, { symbol: true }), "$625.00");
  assert.equal(500_000_000n - 460_000_000n - 27_500_000n, 12_500_000n);   // $125,000 remaining inside the band
  // the calendar arithmetic behind the clocks
  assert.equal(addBusinessDays(D("2026-11-12"), 1, fannieSifma), "2026-11-13"); assert.equal(addDays(D("2026-12-07"), 60), "2027-02-05"); assert.equal(addBusinessDays(D("2027-02-05"), -5, fannieSifma), "2027-01-29"); assert.equal(daysBetween(D("2026-08-01"), D("2026-10-07")), 67); assert.equal(addDays(D("2026-10-23"), 30), "2026-11-22");
});
