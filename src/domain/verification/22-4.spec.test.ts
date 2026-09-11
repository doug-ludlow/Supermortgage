// 22.4 Asset, reserve, and cash-to-close verification (VOA, large deposits, gifts, EMD, IPCs, reserves, subordinate financing)
// spec/sections/22-documents-credit-income-assets-liabilities-identity-and-frau/22-4-asset-reserve-and-cash-to-close-verification-voa-large-depos.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_22_4 } from "../../app/tools/section22-4.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import {
  anticipatedSalesProceeds, cashToClose, communitySecond, declareAsset, emdCheck, evaluateDeposit, ipcBandBps, largeDepositThreshold, lcorCashBack, lcorCures, miCoverageBps, monthlyPI, otherCosts, perDiemInterest, prepaidInterest, ratioMilliPct, reserveTolerance, reservesRequired, retirementUse, saleProceedsGate,
  statementFloor, statementGate, sufficiency, testIpcLimits, usableCents, verifyAsset, virtualCurrencyUsable, type AssetRecord, type DepositResult, type IpcItem, type StatementEvidence,
} from "./ops-22-4.ts";

const AGENT: Actor = { kind: "agent", id: "verification" };
const B1 = "borrower-1";
/** Creditor time (Phoenix: MST all year, UTC−7). */
const mst = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/Phoenix"));
/** Purchase fixture: application Mon Oct 19, 2026; price $457,800.00; loan $412,000.00; consummation Wed Nov 18, 2026. Refinance fixture: application Mon Oct 5, 2026; note date Fri Nov 6; disbursement Thu Nov 12. */
const PURCHASE = { app: "app-purchase-1", loan: "L-PUR-1", application_date: "2026-10-19", closing: "2026-11-18" } as const;
const REFI = { app: "app-refi-1", loan: "L-REFI-1", application_date: "2026-10-05", closing: "2026-11-06" } as const;
const stmt = (document_id: string, period_start: string, period_end: string): StatementEvidence => ({ document_id, period_start: D(period_start), period_end: D(period_end) });
const JUL = stmt("stmt-jul", "2026-07-01", "2026-07-31"), AUG = stmt("stmt-aug", "2026-08-01", "2026-08-31"), SEP = stmt("stmt-sep", "2026-09-01", "2026-09-30");

/** The 22.4 tools on the bus over the overridden registry (22.4 rows only) and the escalation service; the harness appends the upstream events (21.1 / 22.1 / 23.1 / 25.2 / 26.x) with origination context. */
function harness(fx: typeof PURCHASE | typeof REFI, nowIso: string, o: { transaction?: "purchase" | "refinance" | "lcor"; occupancy?: string } = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId: fx.app });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["22.4"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId: fx.loan, applicationId: fx.app, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_22_4); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("22.4", name))!, actor, { application_id: fx.app, ...input }, uow)).output as Record<string, unknown>;
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === fx.app);
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt = clock.now(), actor: Actor = { kind: "agent", id: "closing" }) => events.append({ type, applicationId: fx.app, aggregate: { kind: "application", id: fx.app }, actor, occurredAt, payload: { application_id: fx.app, ...payload } });
  rt.store.put("applications", fx.app, { id: fx.app, application_date: fx.application_date, transaction: o.transaction ?? (fx === PURCHASE ? "purchase" : "lcor"), occupancy: o.occupancy ?? "principal_residence" }, AGENT, nowIso);
  upstream("closing.scheduled", { scheduled_note_date: fx.closing, scheduled_disbursement_date: fx === PURCHASE ? fx.closing : "2026-11-12" }, mst(fx.application_date, "17:00"));
  const asset = (id: string): AssetRecord => rt.store.require("application_assets", id).data as unknown as AssetRecord;
  return { clock, events, timers, rt, run, timer, ofType, upstream, decisions, asset, at: (iso: string) => clock.set(iso) };
}
/** Borrower A's checking on the purchase fixture: Sept 30 balance $31,240.18, EMD $5,000.00 cleared Oct 20 (after the statement) → usable $26,240.18. */
async function declareChecking(h: ReturnType<typeof harness>, statements: StatementEvidence[] = [AUG, SEP]) {
  await h.run("declareAssets", { assets: [{ asset_id: "chk-a", asset_type: "checking", borrower_ids: [B1], declared_balance_cents: 3124018n, institution_name: "First Bank", account_last4: "1234", holder_names: ["Alex Fixture"] }], borrower_names: ["Alex Fixture"] });
  let last: Record<string, unknown> = {};
  for (const s of statements) last = await h.run("parseStatement", { asset_id: "chk-a", document_id: s.document_id, period_start: s.period_start, period_end: s.period_end, ending_balance_cents: 3124018n, emd_offset_cents: 500000n });
  return last;
}
const purchaseWorksheet = { stage: "pre_cd", sales_price_cents: 45780000n, appraised_value_cents: 46000000n, loan_amount_cents: 41200000n, total_closing_costs_cents: 871200n, emd_cents: 500000n, seller_credits_cents: 500000n, lender_credit_premium_cents: 51500n, reserves_required_cents: 800000n };
const fixtureAssets = (checking = 2624018n) => [{ asset_id: "chk-a", usable_cents: checking, usable_for: "both", status: "verified" }, { asset_id: "sav-a", usable_cents: 1490000n, usable_for: "both", status: "verified" }, { asset_id: "gift-a", usable_cents: 1000000n, usable_for: "both", status: "verified" }, { asset_id: "401k-a", usable_cents: 3800000n, usable_for: "both", status: "verified", liquidation_required_for_closing: true, liquidated_cents: 0n }];

test("22.4-T1: (45-day rule, purchase) Given application Mon Oct 19, 2026 and statements for Jul 1–31, Aug 1–31 and Sept 1–30, 2026, when evaluated, then the August+September pair satisfies `FNMA_B3_4_4_02_ASSET_STMT_45D_GATE` (Sept 30 ≥ Sept 4) and a July+August pair does not (Aug 31 ≥ Sept 4 is false).", async () => {
  assert.equal(statementFloor(D(PURCHASE.application_date)), "2026-09-04"); assert.equal(statementFloor(D(PURCHASE.application_date), true), "2026-07-21");
  const pair = statementGate({ transaction: "purchase", initial_application_date: D(PURCHASE.application_date), statements: [JUL, AUG, SEP] });
  assert.equal(pair.open, true); assert.equal(pair.required_count, 2); assert.deepEqual(pair.qualifying_document_ids, ["stmt-sep", "stmt-aug"]); assert.equal(pair.most_recent_period_end, "2026-09-30");
  const julAug = statementGate({ transaction: "purchase", initial_application_date: D(PURCHASE.application_date), statements: [JUL, AUG] });
  assert.equal(julAug.open, false); assert.equal(julAug.request_newer, true); assert.match(julAug.reason!, /2026-08-31 < floor 2026-09-04/);
  // A single September statement is not two consecutive months; the 45-day rule is anchored to the initial application date and never re-bases when closing slips (Dec 18 → the four-month rule, 22.1's, still passes on Sept 30).
  const sepOnly = statementGate({ transaction: "purchase", initial_application_date: D(PURCHASE.application_date), statements: [SEP] }); assert.equal(sepOnly.open, false); assert.match(sepOnly.reason!, /1 of 2 consecutive/);
  assert.equal(evaluateGate("22.4.assetStatement45d", { transaction: "purchase", application_date: PURCHASE.application_date, statements: [AUG, SEP] }).open, true);
  assert.equal(evaluateGate("22.4.assetStatement45d", { transaction: "purchase", application_date: PURCHASE.application_date, statements: [JUL, AUG] }).open, false);
  // Through the bus: 22.1's `document.classified{bank_statement}` arms the gate; the August statement alone leaves the asset documentation_requested; September verifies it (Sept 30 ≥ Sept 4).
  const h = harness(PURCHASE, mst("2026-10-20", "09:00"));
  h.upstream("document.classified", { document_id: "stmt-aug", doc_class: "bank_statement", doc_family: "assets" }, mst("2026-10-20", "09:00"), { kind: "agent", id: "verification" });
  const armed = h.timer("FNMA_B3_4_4_02_ASSET_STMT_45D_GATE")!; assert.equal(armed.status, "armed"); assert.equal(armed.note, "evaluator:22.4.assetStatement45d");
  const afterAug = await declareChecking(h, [AUG]); assert.equal(afterAug.status, "documentation_requested"); assert.equal((afterAug.gate as { open: boolean; floor: string }).open, false); assert.equal((afterAug.gate as { floor: string }).floor, "2026-09-04");
  const afterSep = await h.run("parseStatement", { asset_id: "chk-a", document_id: "stmt-sep", period_start: "2026-09-01", period_end: "2026-09-30", ending_balance_cents: 3124018n, emd_offset_cents: 500000n });
  assert.equal(afterSep.status, "verified"); assert.equal(afterSep.du_45d_ok, true); assert.equal(afterSep.statement_count, 2); assert.deepEqual((afterSep.gate as { qualifying_document_ids: string[] }).qualifying_document_ids, ["stmt-sep", "stmt-aug"]);
  assert.equal(afterSep.usable_cents, 2624018n);   // $31,240.18 − EMD offset $5,000.00
  assert.equal(h.ofType("asset.verified").length, 1);
});

test("22.4-T2: (refinance one-month rule) Given application Mon Oct 5, 2026 and one statement dated Aug 31, 2026, when evaluated, then the gate is satisfied (Aug 31 ≥ Aug 21) and no second statement is requested; given a statement dated Aug 15, 2026, then a newer statement is requested.", async () => {
  assert.equal(statementFloor(D(REFI.application_date)), "2026-08-21"); assert.equal(statementFloor(D(REFI.application_date), true), "2026-07-07");
  const aug = statementGate({ transaction: "lcor", initial_application_date: D(REFI.application_date), statements: [AUG] });
  assert.equal(aug.open, true); assert.equal(aug.required_count, 1); assert.equal(aug.request_newer, false); assert.deepEqual(aug.qualifying_document_ids, ["stmt-aug"]);
  const aug15 = statementGate({ transaction: "lcor", initial_application_date: D(REFI.application_date), statements: [stmt("stmt-aug15", "2026-07-16", "2026-08-15")] });
  assert.equal(aug15.open, false); assert.equal(aug15.request_newer, true); assert.match(aug15.reason!, /2026-08-15 < floor 2026-08-21/);
  // A July statement fails the 45-day rule even though it passes 22.1's four-month rule at the Nov 6 note date (Jul 31 + 4 months = Nov 30 ≥ Nov 6).
  assert.equal(statementGate({ transaction: "lcor", initial_application_date: D(REFI.application_date), statements: [JUL] }).open, false);
  // Through the bus: the Aug 15 statement opens exactly one needs-list request for the newer statement (22.1's document_requests); Aug 31 verifies with no second statement requested.
  const h = harness(REFI, mst("2026-10-06", "09:00"));
  await h.run("declareAssets", { assets: [{ asset_id: "chk-r", asset_type: "checking", borrower_ids: [B1], declared_balance_cents: 1200000n, account_last4: "9911", holder_names: ["Alex Fixture"] }], borrower_names: ["Alex Fixture"] });
  const stale = await h.run("parseStatement", { asset_id: "chk-r", document_id: "stmt-aug15", period_start: "2026-07-16", period_end: "2026-08-15", ending_balance_cents: 1200000n });
  assert.equal(stale.status, "documentation_requested"); assert.ok(stale.request_id);
  const req = h.rt.store.require("document_requests", String(stale.request_id)).data; assert.equal(req.doc_class, "bank_statement"); assert.equal(req.reason_code, "sm_freshness"); assert.match(String(req.reason_text), /dated on\/after 2026-08-21/);
  const fresh = await h.run("parseStatement", { asset_id: "chk-r", document_id: "stmt-aug", period_start: "2026-08-01", period_end: "2026-08-31", ending_balance_cents: 1200000n });
  assert.equal(fresh.status, "verified"); assert.equal(fresh.request_id, null); assert.equal(fresh.statement_count, 1); assert.equal(h.rt.store.list("document_requests").length, 1);
});

test("22.4-T3: (large deposit sourcing) Given qualifying income $8,200.00 and a $9,000.00 deposit on Sept 14, 2026 with $6,500.00 printed as a transfer from a verified brokerage account and $2,500.00 unexplained, when evaluated, then `unsourced_cents = 250,000 ≤ 410,000` → `large_deposit = false` and `usable_cents` is not reduced; given the whole $9,000.00 unexplained, then `usable_cents` falls by 900,000 cents and `funds_to_close.computed` shows shortfall $1,856.82 on the fixture worksheet.", async () => {
  assert.equal(largeDepositThreshold(820000n), 410000n); assert.equal(largeDepositThreshold(750000n), 375000n);
  const partly = evaluateDeposit({ deposit_id: "dep-1", asset_id: "chk-a", posted_on: D("2026-09-14"), amount_cents: 900000n, description_on_statement: "TRANSFER FROM SCHWAB …7781", sources: [{ cents: 650000n, kind: "transfer_verified_account", readily_identifiable: true }] }, { transaction: "purchase", threshold_cents: 410000n });
  assert.equal(partly.unsourced_cents, 250000n); assert.equal(partly.large_deposit, false); assert.equal(partly.reduction_cents, 0n); assert.equal(partly.readily_identifiable, true);
  const whole = evaluateDeposit({ deposit_id: "dep-1", asset_id: "chk-a", posted_on: D("2026-09-14"), amount_cents: 900000n, description_on_statement: "DEPOSIT", sources: [] }, { transaction: "purchase", threshold_cents: 410000n });
  assert.equal(whole.large_deposit, true); assert.equal(whole.status, "unsourced"); assert.equal(whole.reduction_cents, 900000n);
  // Refinances are never tested; a DU-validated account is tested only for DU-named deposits.
  assert.equal(evaluateDeposit({ ...whole, sources: [] }, { transaction: "lcor", threshold_cents: 410000n }).status, "waived_refinance");
  assert.equal(evaluateDeposit({ ...whole, sources: [] }, { transaction: "purchase", threshold_cents: 410000n, du_validated: true }).status, "waived_du_validated");
  // Through the bus on the fixture checking account (usable $26,240.18 after the EMD offset).
  const h = harness(PURCHASE, mst("2026-10-21", "09:00")); await declareChecking(h);
  const a = await h.run("evaluateDeposits", { asset_id: "chk-a", total_monthly_qualifying_income_cents: 820000n, deposits: [{ deposit_id: "dep-1", posted_on: "2026-09-14", amount_cents: 900000n, description_on_statement: "TRANSFER FROM SCHWAB …7781", sources: [{ cents: 650000n, kind: "transfer_verified_account", readily_identifiable: true }] }] });
  assert.equal(a.threshold_cents, 410000n); assert.equal((a.deposits as DepositResult[])[0]!.unsourced_cents, 250000n); assert.equal((a.deposits as DepositResult[])[0]!.large_deposit, false); assert.equal(a.usable_cents, 2624018n); assert.equal(a.unsourced_deposit_offset_cents, 0n);
  assert.equal(h.ofType("asset.deposit.flagged_large").length, 0);
  const b = await h.run("evaluateDeposits", { asset_id: "chk-a", total_monthly_qualifying_income_cents: 820000n, deposits: [{ deposit_id: "dep-1", posted_on: "2026-09-14", amount_cents: 900000n, description_on_statement: "DEPOSIT", sources: [] }] });
  assert.equal(b.usable_cents, 2624018n - 900000n); assert.equal(b.unsourced_deposit_offset_cents, 900000n); assert.equal((b.deposits as DepositResult[])[0]!.status, "unsourced");
  assert.equal(h.ofType("asset.deposit.flagged_large").length, 1); assert.equal(h.ofType("asset.deposit.unsourced")[0]!.payload.reduction_cents, 900000n);
  const gate = h.timer("FNMA_B3_4_2_02_LARGE_DEPOSIT_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:22.4.largeDeposit");
  assert.equal(evaluateGate("22.4.largeDeposit", { transaction: "purchase", deposits: b.deposits, sufficient: false }).open, false);
  const ws = await h.run("buildFundsToCloseWorksheet", { ...purchaseWorksheet, assets: fixtureAssets(1724018n) });
  assert.equal(ws.cash_to_close_cents, 4399700n); assert.equal(ws.verified_usable_closing_cents, 4214018n); assert.equal(ws.sufficient, false); assert.equal(ws.shortfall_cents, 185682n);
  assert.equal(h.ofType("funds_to_close.computed")[0]!.payload.shortfall_cents, 185682n);
  // The single structured question per deposit goes through 22.1's needs list (never a borrower explanation without evidence).
  const q = await h.run("requestSource", { deposit_id: "dep-1", borrower_id: B1, expected_source_kind: "sale_of_asset" });
  assert.match(String(q.question), /\$9,000\.00 deposit posted 2026-09-14/); assert.match(String(q.evidence_required), /bill of sale/);
});

test("22.4-T4: (gift letter and transfer) Given a $10,000.00 gift letter from a parent lacking the \"no repayment is expected\" statement, when evaluated, then `gift_records.status = letter_received` with a needs-list item; given the corrected letter and a wire evidenced on the October statement, then `transfer_verified` and `FNMA_B3_4_3_04_GIFT_TRANSFER_GATE` is open; given the donor is the listing agent, then `rejected` and an 22.6 case opens.", async () => {
  const h = harness(PURCHASE, mst("2026-10-22", "09:00"));
  await h.run("declareAssets", { assets: [{ asset_id: "gift-a", asset_type: "gift", borrower_ids: [B1], declared_balance_cents: 1000000n }] });
  const parties = [{ name: "Casey Seller", role: "seller" }, { name: "Morgan Lister", role: "listing_agent" }];
  const letter = { gift_id: "gift-1", asset_id: "gift-a", borrower_id: B1, letter_document_id: "doc-gift-1", donor_name: "Pat Fixture", donor_address: "1 Elm St, Columbus OH 43215", donor_phone: "614-555-0100", relationship: "parent", amount_stated_cents: 1000000n, amount_is_maximum: true, parties };
  const incomplete = await h.run("verifyGift", { ...letter, no_repayment_statement: false });
  assert.equal(incomplete.status, "letter_received"); assert.equal(incomplete.complete, false); assert.match(String((incomplete.needs_list_item as { reason_text: string }).reason_text), /no repayment is expected/);
  assert.equal(h.rt.store.require("gift_records", "gift-1").data.status, "letter_received"); assert.equal(h.rt.store.require("document_requests", String(incomplete.request_id)).data.doc_class, "gift_letter");
  const gate = h.timer("FNMA_B3_4_3_04_GIFT_TRANSFER_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:22.4.giftTransfer");
  assert.equal(evaluateGate("22.4.giftTransfer", { gifts: [{ gift_id: "gift-1", status: "letter_received" }] }).open, false);
  // Transfer evidence cannot close the gate over an incomplete letter.
  await assert.rejects(h.run("verifyGift", { op: "transfer", gift_id: "gift-1", transfer_amount_cents: 1000000n, evidence_document_ids: ["doc-wire", "stmt-oct"], transferred_on: "2026-10-26" }), /incomplete/);
  const corrected = await h.run("verifyGift", { op: "correct_letter", ...letter, letter_document_id: "doc-gift-2", no_repayment_statement: true }); assert.equal(corrected.complete, true);
  const wired = await h.run("verifyGift", { op: "transfer", gift_id: "gift-1", evidence_kind: "electronic_transfer", transfer_amount_cents: 1000000n, evidence_document_ids: ["doc-donor-wire-confirmation", "stmt-oct"], transferred_on: "2026-10-26" });
  assert.equal(wired.status, "transfer_verified"); assert.equal(wired.transfer_status, "transferred_to_borrower"); assert.equal(wired.usable_cents, 1000000n); assert.equal(wired.gate_open, true);
  assert.equal(h.timer("FNMA_B3_4_3_04_GIFT_TRANSFER_GATE")!.status, "satisfied"); assert.equal(evaluateGate("22.4.giftTransfer", { gifts: [{ gift_id: "gift-1", status: "transfer_verified" }] }).open, true);
  assert.equal(h.asset("gift-a").status, "verified"); assert.equal(String(h.asset("gift-a").usable_cents), "1000000");
  // 1-unit principal residence at 90 % LTV → no minimum own-funds contribution; the donor as listing agent → rejected, 22.6 case candidate, underwriting_reviewer hand-off.
  const rejected = await h.run("verifyGift", { ...letter, gift_id: "gift-2", asset_id: null, donor_name: "Morgan Lister", no_repayment_statement: true });
  assert.equal(rejected.status, "rejected"); assert.equal(rejected.reject_reason, "interested_party_donor"); assert.equal(rejected.donor_interested_party_check, "match"); assert.ok(rejected.fraud_case_event_id); assert.ok(rejected.escalation_id);
  assert.equal(h.ofType("gift.donor.interested_party_suspected")[0]!.payload.matched_role, "listing_agent"); assert.equal(h.ofType("fraud.case.candidate")[0]!.payload.owner, "22.6");
  assert.equal(h.ofType("asset.rejected")[0]!.payload.reason, "ineligible_source");
});

test("22.4-T5: (IPC limits) Given price $457,800.00, appraised $460,000.00, CLTV 90.00% and seller-paid items of $5,000.00 plus an interested-party-funded buydown subsidy of $8,640.00, when tested, then `max_financing_concessions = 2,746,800 cents` and `ipc.limit.ok`; given a $30,000.00 seller credit, then excess $2,532.00 is reclassified, adjusted price $455,268.00, LTV 90.496% → 24.6 coverage 30%, band 3% ($13,658.04), and 21.5 receives a changed circumstance.", async () => {
  assert.equal(ipcBandBps(90000, "principal_residence"), 600); assert.equal(ipcBandBps(90001, "principal_residence"), 300); assert.equal(ipcBandBps(75000, "second_home"), 900); assert.equal(ipcBandBps(60000, "investment"), 200);
  const h = harness(PURCHASE, mst("2026-10-23", "09:00"));
  await h.run("recordIpc", { ipc_id: "ipc-1", payer_role: "seller", kind: "financing_concession", amount_cents: 500000n, disclosed_on_settlement: true });
  await h.run("recordIpc", { ipc_id: "ipc-2", payer_role: "seller", kind: "buydown_subsidy", amount_cents: 864000n, funded_by_interested_party: true, disclosed_on_settlement: true });
  assert.equal(h.timer("FNMA_B3_4_1_02_IPC_LIMIT_GATE")!.status, "armed");
  const ok = await h.run("testIpcLimits", { sales_price_cents: 45780000n, appraised_value_cents: 46000000n, loan_amount_cents: 41200000n, cltv_milli_pct: 90000 });
  assert.equal(ok.ok, true); assert.equal(ok.max_financing_concessions_cents, 2746800n); assert.equal(ok.financing_concessions_cents, 1364000n); assert.equal(ok.band_bps, 600);
  assert.equal(h.ofType("ipc.limit.ok").length, 1); assert.equal(h.timer("FNMA_B3_4_1_02_IPC_LIMIT_GATE")!.status, "satisfied");
  // Variant: a $30,000.00 seller credit.
  const over = testIpcLimits({ sales_price_cents: 45780000n, appraised_value_cents: 46000000n, loan_amount_cents: 41200000n, occupancy: "principal_residence", cltv_milli_pct: 90000, items: [{ ipc_id: "ipc-3", application_id: PURCHASE.app, payer_party_id: "seller", payer_role: "seller", kind: "financing_concession", amount_cents: 3000000n, disclosed_on_settlement: true, counts_toward_limit: true, evidence_document_ids: [], status: "declared" } satisfies IpcItem] });
  assert.equal(over.ok, false); assert.equal(over.excess_cents, 253200n); assert.equal(over.adjusted_price_cents, 45526800n); assert.equal(over.ltv_milli_pct, 90496); assert.equal(over.mi_coverage_bps, 3000); assert.equal(miCoverageBps(90496), 3000);
  assert.equal(over.iterations.length, 2); assert.equal(over.iterations[1]!.band_bps, 300); assert.equal(over.iterations[1]!.max_financing_concessions_cents, 1365804n); assert.equal(over.iterations[1]!.excess_cents, 1634196n);
  const h2 = harness(PURCHASE, mst("2026-10-23", "10:00"));
  await h2.run("recordIpc", { ipc_id: "ipc-3", payer_role: "seller", kind: "financing_concession", amount_cents: 3000000n });
  const r = await h2.run("testIpcLimits", { sales_price_cents: 45780000n, appraised_value_cents: 46000000n, loan_amount_cents: 41200000n, cltv_milli_pct: 90000 });
  assert.equal(r.ok, false); assert.equal(r.excess_cents, 253200n); assert.equal(r.adjusted_price_cents, 45526800n); assert.equal(r.ltv_milli_pct, 90496); assert.equal(r.mi_coverage_bps, 3000); assert.equal(r.band_bps, 300); assert.ok(r.escalation_id);
  const cc = h2.ofType("ipc.excess.reclassified")[0]!.payload; assert.equal(cc.changed_circumstance, true); assert.deepEqual(cc.hand_off, ["21.5", "24.6", "23.1"]); assert.equal(cc.new_max_financing_concessions_cents, 1365804n);
  assert.equal(h2.ofType("purchase_contracts.changed")[0]!.payload.owner, "21.5"); assert.equal(h2.rt.store.require("ipc_items", "ipc-3").data.status, "excess_reclassified");
  assert.equal(evaluateGate("22.4.ipcLimit", { ok: false }).open, false); assert.equal(h2.timer("FNMA_B3_4_1_02_IPC_LIMIT_GATE")!.status, "armed");
  assert.ok((r.cures as { option: string }[]).some((c) => c.option === "cap_credit_at_maximum"));
});

test("22.4-T6: (cash-to-close reconciliation, purchase) Given the worked-example inputs, when CD v1 is prepared Thu Nov 12, 2026 with \"Cash to Close $43,997.00\", then `reconciled_to_cd = true`, `sufficient = true` (closing funds $51,140.18; reserves $45,143.18 ≥ $8,000.00) and `SM_CASH_TO_CLOSE_RECONCILED_GATE` opens; given the CD shows $44,097.00 because the title fee changed, then `funds_to_close.variance` lists \"B. Title – settlement fee +$100.00\" and the gate stays closed until 25.2 reissues or corrects.", async () => {
  assert.equal(cashToClose({ transaction: "purchase", ...purchaseWorksheet, stage: "pre_cd" }), 4399700n);   // 45,800.00 + 8,712.00 − 5,000.00 − 5,000.00 − 515.00
  const h = harness(PURCHASE, mst("2026-11-12", "09:00"));
  const ws = await h.run("buildFundsToCloseWorksheet", { ...purchaseWorksheet, assets: fixtureAssets() });
  assert.equal(ws.cash_to_close_cents, 4399700n); assert.equal(ws.verified_usable_closing_cents, 5114018n); assert.equal(ws.verified_usable_reserves_cents, 4514318n); assert.equal(ws.sufficient, true); assert.equal(ws.funds_to_verify_cents, 5199700n);
  h.upstream("disclosure.cd.prepared", { version: 1, cd_version: 1, disclosure_id: "cd-1", cash_to_close_cents: 4399700n }, mst("2026-11-12", "10:00"), { kind: "agent", id: "disclosure" });
  const gate = h.timer("SM_CASH_TO_CLOSE_RECONCILED_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:22.4.cashToCloseReconciled");
  const rec = await h.run("reconcileToCd", { cd_disclosure_id: "cd-1", cd_version: 1, cd_cash_to_close_cents: 4399700n });
  assert.equal(rec.reconciled_to_cd, true); assert.deepEqual(rec.variances, []); assert.equal(rec.gate_open, true);
  assert.equal(h.ofType("funds_to_close.reconciled")[0]!.payload.cd_version, 1); assert.equal(h.timer("SM_CASH_TO_CLOSE_RECONCILED_GATE")!.status, "satisfied");
  assert.equal(evaluateGate("22.4.cashToCloseReconciled", { reconciled_to_cd: true, sufficient: true, cash_back_ok: true }).open, true);
  // The CD shows $44,097.00 because the title settlement fee moved from $500.00 to $600.00: variance itemized per CD line, routed to 25.2; the gate stays closed.
  h.upstream("disclosure.cd.prepared", { version: 2, cd_version: 2, disclosure_id: "cd-2", cash_to_close_cents: 4409700n }, mst("2026-11-13", "10:00"), { kind: "agent", id: "disclosure" });
  const v = await h.run("reconcileToCd", { cd_disclosure_id: "cd-2", cd_version: 2, cd_cash_to_close_cents: 4409700n, cd_lines: [{ section: "B", label: "Title – settlement fee", cents: 60000n }], worksheet_lines: [{ section: "B", label: "Title – settlement fee", cents: 50000n }] });
  assert.equal(v.reconciled_to_cd, false); assert.deepEqual(v.variances, ["B. Title – settlement fee +$100.00"]); assert.equal(v.routed_to, "25.2"); assert.equal(v.gate_open, false);
  assert.deepEqual(h.ofType("funds_to_close.variance")[0]!.payload.variances, ["B. Title – settlement fee +$100.00"]); assert.equal(h.timer("SM_CASH_TO_CLOSE_RECONCILED_GATE")!.status, "armed");
  assert.equal(evaluateGate("22.4.cashToCloseReconciled", { reconciled_to_cd: false, sufficient: true }).open, false);
  await assert.rejects(h.run("finalizeAssets", { skip_document_gate: true }), (e: unknown) => e instanceof CommandRefused && e.code === "SM_CASH_TO_CLOSE_RECONCILED_GATE");
  // Without the gift: $41,140.18 < $43,997.00 → shortfall $2,856.82 and a needs-list item before CD issuance.
  const noGift = sufficiency(fixtureAssets().filter((a) => a.asset_id !== "gift-a") as Parameters<typeof sufficiency>[0], 4399700n, 800000n);
  assert.equal(noGift.usable_closing_cents, 4114018n); assert.equal(noGift.shortfall_cents, 285682n); assert.equal(noGift.sufficient, false);
});

test("22.4-T7: (LCOR cash-back cap) Given loan $560,000.00, payoff $547,912.40 and closing costs $6,318.00, when computed, then `cash_to_borrower = 576,960 cents > cap 560,000 cents` → `lcor.cash_back.exceeded`; when a principal curtailment of $169.60 is recorded, then `cash_back_ok = true`; given payoff $549,000.00, then cash to borrower $4,682.00 ≤ $5,600.00 with no cure.", async () => {
  const r = lcorCashBack({ loan_amount_cents: 56000000n, payoffs_cents: 54791240n, total_closing_costs_cents: 631800n });
  assert.equal(r.cash_to_borrower_cents, 576960n); assert.equal(r.cap_cents, 560000n); assert.equal(r.cash_back_ok, false); assert.equal(r.overage_cents, 16960n);
  const cures = lcorCures(r, 56000000n); assert.equal(cures.principal_curtailment!.curtailment_cents, 16960n); assert.equal(cures.principal_curtailment!.upb_after_funding_cents, 55983040n);
  assert.equal(cures.loan_reduction!.new_loan_amount_cents, 55983000n); assert.equal(cures.loan_reduction!.decrease_cents, 17000n); assert.equal(cures.loan_reduction!.within_5pct_tolerance, true); assert.equal(monthlyPI(55983000n, "0.06125", 360), 340159n);
  assert.equal(lcorCashBack({ loan_amount_cents: 15000000n, payoffs_cents: 14700000n, total_closing_costs_cents: 100000n }).cap_cents, 200000n);   // the $2,000.00 floor
  const h = harness(REFI, mst("2026-11-02", "09:00"), { transaction: "lcor" });
  const t = await h.run("testLcorCashBack", { loan_amount_cents: 56000000n, payoffs_cents: 54791240n, total_closing_costs_cents: 631800n, note_rate: "0.06125" });
  assert.equal(t.cash_back_ok, false); assert.equal(t.cash_to_borrower_cents, 576960n); assert.equal(t.new_pi_cents, 340159n); assert.equal(h.ofType("lcor.cash_back.exceeded")[0]!.payload.overage_cents, 16960n);
  const ws = await h.run("buildFundsToCloseWorksheet", { stage: "cd_v1", sales_price_cents: 0n, loan_amount_cents: 56000000n, payoffs_cents: 54791240n, total_closing_costs_cents: 631800n, reserves_required_cents: 0n, assets: [] });
  assert.equal(ws.cash_to_close_cents, -576960n); assert.equal(ws.cash_back_ok, false); assert.equal(ws.cash_back_cap_cents, 560000n);
  const gate = h.timer("FNMA_B2_1_3_02_LCOR_CASHBACK_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:22.4.lcorCashBack");
  assert.equal(evaluateGate("22.4.lcorCashBack", { transaction: "lcor", loan_amount_cents: 56000000n, payoffs_cents: 54791240n, total_closing_costs_cents: 631800n }).open, false);
  const cured = await h.run("proposeCure", { op: "lcor_curtailment", curtailment_cents: 16960n });
  assert.equal(cured.cash_back_ok, true); assert.equal(cured.cash_to_borrower_cents, 560000n); assert.equal(cured.upb_after_funding_cents, 55983040n);
  assert.ok(h.timers.byCode("FNMA_B2_1_3_02_LCOR_CASHBACK_GATE").some((x) => x.status === "satisfied")); assert.equal(evaluateGate("22.4.lcorCashBack", { transaction: "lcor", cash_back_ok: true }).open, true);
  const ok = await h.run("testLcorCashBack", { loan_amount_cents: 56000000n, payoffs_cents: 54900000n, total_closing_costs_cents: 631800n });
  assert.equal(ok.cash_to_borrower_cents, 468200n); assert.equal(ok.cash_back_ok, true); assert.equal((ok.cures as { principal_curtailment: unknown }).principal_curtailment, null); assert.equal(h.ofType("lcor.cash_back.exceeded").length, 2);   // the test and the worksheet, none from the cured re-test
});

test("22.4-T8: (reserves with other financed properties) Given the purchase fixture with two financed rentals (UPB $250,000.00 and $160,000.00) and DU reserves $8,000.00, when computed, then `reserves_required = 1,620,000 cents`; given verified reserves $14,580.00, then 23.1's 90% test passes (`tolerance_90pct_ok`) but `SM_RESERVES_VERIFIED_GATE` remains closed until $16,200.00 is verified; given $14,500.00, then `B3_2_10_RESERVES_90PCT` resubmission is required.", async () => {
  const calc = reservesRequired({ occupancy: "principal_residence", units: 1, transaction: "purchase", qualifying_pitia_cents: 300000n, du_reserves_required_cents: 800000n, other_financed_upb_cents: [25000000n, 16000000n] });
  assert.equal(calc.months, 0); assert.equal(calc.formula_cents, 0n); assert.equal(calc.other_financed_upb_cents, 41000000n); assert.equal(calc.financed_property_count, 3); assert.equal(calc.pct_bps, 200); assert.equal(calc.other_financed_cents, 820000n); assert.equal(calc.required_cents, 1620000n);
  assert.equal(reservesRequired({ occupancy: "principal_residence", units: 1, transaction: "purchase", qualifying_pitia_cents: 300000n, du_reserves_required_cents: 800000n }).required_cents, 800000n);
  assert.equal(reservesRequired({ occupancy: "second_home", units: 1, transaction: "purchase", qualifying_pitia_cents: 300000n }).required_cents, 600000n); assert.equal(reservesRequired({ occupancy: "principal_residence", units: 1, transaction: "cash_out", dti_bps: 4600, qualifying_pitia_cents: 300000n }).months, 6);
  const t90 = reserveTolerance(1458000n, 1620000n); assert.equal(t90.tolerance_90pct_ok, true); assert.equal(t90.sufficient, false); assert.equal(t90.resubmission_required, false);
  const t89 = reserveTolerance(1450000n, 1620000n); assert.equal(t89.tolerance_90pct_ok, false); assert.equal(t89.resubmission_rule, "B3_2_10_RESERVES_90PCT");
  const h = harness(PURCHASE, mst("2026-11-10", "09:00"));
  h.upstream("du.findings.received", { submission_number: 3, final: true, reserves_required_cents: 800000n }, mst("2026-11-10", "09:00"), { kind: "agent", id: "underwriter" });
  const gate = h.timer("SM_RESERVES_VERIFIED_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:22.4.reservesVerified");
  const inputs = { qualifying_pitia_cents: 300000n, du_reserves_required_cents: 800000n, other_financed_upb_cents: [25000000n, 16000000n] };
  const a = await h.run("computeReserves", { ...inputs, verified_reserves_cents: 1458000n });
  assert.equal(a.reserves_required_cents, 1620000n); assert.equal(a.tolerance_90pct_ok, true); assert.equal(a.sufficient, false); assert.equal(a.gate_open, false); assert.equal(a.resubmission_required, false); assert.equal(a.shortfall_cents, 162000n);
  assert.equal(h.timer("SM_RESERVES_VERIFIED_GATE")!.status, "armed"); assert.equal(evaluateGate("22.4.reservesVerified", { verified_cents: 1458000n, required_cents: 1620000n }).open, false); assert.equal(h.ofType("reserves.shortfall").length, 1);
  const b = await h.run("computeReserves", { ...inputs, verified_reserves_cents: 1620000n });
  assert.equal(b.sufficient, true); assert.equal(b.gate_open, true); assert.equal(h.timer("SM_RESERVES_VERIFIED_GATE")!.status, "satisfied"); assert.equal(h.ofType("reserves.computed").at(-1)!.payload.sufficient, true);
  const c = await h.run("computeReserves", { ...inputs, verified_reserves_cents: 1450000n });
  assert.equal(c.tolerance_90pct_ok, false); assert.equal(c.resubmission_required, true); assert.equal(c.resubmission_rule, "B3_2_10_RESERVES_90PCT");
  assert.equal(h.rt.store.list("reserve_calculations").length, 3);
});

test("22.4-T9: (Community Seconds CLTV) Given an OHFA-type DPA second of $13,734.00 on the purchase fixture, when computed, then CLTV 92.998% ≤ 105%, `SFC 118` is emitted, the IPC band becomes 3%, and 22.5 receives `deferred_5y_or_more = true`; given the provider is the property seller, then `subordinate_financing.declared{ineligible_provider}` and the loan is restructured.", async () => {
  const cs = { amount_cents: 1373400n, provider_name: "Ohio Housing Finance Agency", provider_kind: "state_or_local_government", repayment: "forgivable", first_lien_cents: 41200000n, sales_price_cents: 45780000n, appraised_value_cents: 46000000n, occupancy: "principal_residence", seller_credit_cents: 500000n } as const;
  const r = communitySecond(cs);
  // (412,000 + 13,734) ÷ 457,800 = 0.929956… → 92.996 % (the spec's 92.998 % is a rounding slip; the engine's value is asserted). ≤ 105 % either way.
  assert.equal(r.cltv_milli_pct, 92996); assert.equal(ratioMilliPct(41200000n + 1373400n, 45780000n), 92996); assert.equal(r.cltv_ok, true); assert.equal(r.cltv_cap_milli, 105000);
  assert.equal(r.eligible, true); assert.deepEqual(r.sfc_codes, [118]); assert.equal(r.ipc_band_bps, 300); assert.equal(r.max_financing_concessions_cents, 1373400n); assert.equal(r.seller_credit_within_band, true); assert.equal(r.deferred_5y_or_more, true);
  assert.equal(communitySecond({ ...cs, repayment: "deferred", deferral_years: 3 }).deferred_5y_or_more, false);
  const h = harness(PURCHASE, mst("2026-10-24", "09:00"));
  const ok = await h.run("proposeCure", { op: "community_second", ...cs });
  assert.equal(ok.eligible, true); assert.equal(ok.cltv_milli_pct, 92996); assert.ok(ok.sfc_event_id);
  assert.equal(h.ofType("delivery.sfc.queued")[0]!.payload.code, 118);
  const declared = h.ofType("subordinate_financing.declared")[0]!.payload; assert.equal(declared.deferred_5y_or_more, true); assert.ok((declared.consumers as string[]).includes("22.5")); assert.equal(declared.ipc_band_bps, 300);
  const seller = await h.run("proposeCure", { op: "community_second", ...cs, provider_name: "Casey Seller", provider_kind: "property_seller" });
  assert.equal(seller.eligible, false); assert.equal(seller.ineligible_reason, "ineligible_provider"); assert.deepEqual(seller.sfc_codes, []); assert.equal(seller.sfc_event_id, null);
  assert.equal(h.ofType("subordinate_financing.declared")[1]!.payload.reason, "ineligible_provider"); assert.ok((seller.hand_offs as string[]).some((s) => s.startsWith("23.2 restructure")));
});

test("22.4-T10: (virtual currency) Given $20,000.00 in bitcoin on a U.S.-regulated exchange declared as reserves, when evaluated, then `usable_cents = 0` until exchange-to-dollars evidence and a deposit into a U.S.-regulated institution are documented; given the exchange sale settled to the borrower's checking on Oct 22, 2026 with the exchange statement, then usable $20,000.00 and the deposit is `sourced{virtual_currency_exchange}`; given the EMD was paid in bitcoin, then the EMD is rejected.", async () => {
  const held = virtualCurrencyUsable({ balance_cents: 2000000n, exchange_us_regulated: true });
  assert.equal(held.usable_cents, 0n); assert.equal(held.conditions.length, 2); assert.match(held.conditions[0]!, /exchanged into U\.S\. dollars/); assert.equal(held.deposit, null);
  const settled = virtualCurrencyUsable({ balance_cents: 2000000n, exchange_us_regulated: true, exchanged_to_usd_evidence_document_ids: ["doc-exchange-stmt"], settlement_deposit: { deposit_id: "dep-btc", posted_on: D("2026-10-22"), amount_cents: 2000000n, institution_us_regulated: true, exchange_statement_document_id: "doc-exchange-stmt" } });
  assert.equal(settled.usable_cents, 2000000n); assert.deepEqual(settled.conditions, []); assert.equal(settled.deposit!.status, "sourced"); assert.equal(settled.deposit!.source_kind, "virtual_currency_exchange"); assert.equal(settled.deposit!.posted_on, "2026-10-22");
  const emd = emdCheck({ amount_cents: 500000n, paid_in: "virtual_currency" }); assert.equal(emd.accepted, false); assert.match(emd.reject_reason!, /earnest money/);
  assert.equal(emdCheck({ amount_cents: 500000n, paid_in: "check", cleared_on: D("2026-10-20"), statement_period_end: D("2026-09-30") }).emd_offset_applies, true);
  const h = harness(PURCHASE, mst("2026-10-23", "09:00"));
  await assert.rejects(h.run("declareAssets", { assets: [{ asset_id: "btc", asset_type: "virtual_currency", borrower_ids: [B1], declared_balance_cents: 2000000n }] }), (e: unknown) => e instanceof CommandRefused && e.code === "VIRTUAL_CURRENCY_UNCONVERTED");
  const before = await h.run("proposeCure", { op: "virtual_currency", balance_cents: 2000000n, exchange_us_regulated: true }); assert.equal(before.usable_cents, 0n);
  const after = await h.run("proposeCure", { op: "virtual_currency", balance_cents: 2000000n, exchange_us_regulated: true, exchanged_to_usd_evidence_document_ids: ["doc-exchange-stmt"], settlement_deposit: { deposit_id: "dep-btc", posted_on: "2026-10-22", amount_cents: 2000000n, institution_us_regulated: true, exchange_statement_document_id: "doc-exchange-stmt" }, emd: { amount_cents: 500000n, paid_in: "virtual_currency" } });
  assert.equal(after.usable_cents, 2000000n); assert.equal(after.deposit_status, "sourced"); assert.equal(after.deposit_source_kind, "virtual_currency_exchange"); assert.equal((after.emd as { accepted: boolean }).accepted, false);
});

test("22.4-T11: (retirement and liquidation) Given a vested 401(k) of $38,000.00 needed for closing ($5,000.00 short), when evaluated, then a liquidation-evidence condition opens and the asset's reserves value falls by the amount withdrawn plus fees; given the funds are needed only for reserves, then no withdrawal is required and $38,000.00 counts.", async () => {
  const forClosing = retirementUse({ vested_balance_cents: 3800000n, vested: true, withdrawable_regardless_of_employment: true, needed_for_closing_cents: 500000n, withdrawal_fees_cents: 7500n });
  assert.equal(forClosing.withdrawal_required, true); assert.equal(forClosing.condition!.code, "liquidation_evidence"); assert.equal(forClosing.condition!.kind, "PTD"); assert.equal(forClosing.usable_for_closing_cents, 0n);
  assert.equal(forClosing.withdrawn_cents, 500000n); assert.equal(forClosing.reserves_after_withdrawal_cents, 3800000n - 500000n - 7500n);
  const evidenced = retirementUse({ vested_balance_cents: 3800000n, vested: true, withdrawable_regardless_of_employment: true, needed_for_closing_cents: 500000n, liquidation_evidence_document_ids: ["doc-401k-distribution"] });
  assert.equal(evidenced.condition, null); assert.equal(evidenced.usable_for_closing_cents, 500000n);
  const reservesOnly = retirementUse({ vested_balance_cents: 3800000n, vested: true, withdrawable_regardless_of_employment: true, needed_for_closing_cents: 0n });
  assert.equal(reservesOnly.withdrawal_required, false); assert.equal(reservesOnly.usable_for_reserves_cents, 3800000n); assert.equal(reservesOnly.reserves_after_withdrawal_cents, 3800000n); assert.equal(reservesOnly.condition, null);
  assert.equal(retirementUse({ vested_balance_cents: 3800000n, vested: false, withdrawable_regardless_of_employment: true, needed_for_closing_cents: 0n }).usable_for_reserves_cents, 0n);
  assert.equal(retirementUse({ vested_balance_cents: 3800000n, vested: true, withdrawable_regardless_of_employment: false, needed_for_closing_cents: 500000n }).usable_for_closing_cents, 0n);
  // The verified 401(k) carries a 0 bps haircut (B3-4.3-03: vested balance) and usable_for=both; sufficiency counts it for reserves without a withdrawal.
  const a = declareAsset(new MemoryEventStore(new FixedClock(mst("2026-10-23", "09:00"))), { application_id: PURCHASE.app, asset_id: "401k-a", borrower_ids: [B1], asset_type: "retirement", declared_balance_cents: 3800000n }).asset;
  assert.equal(a.usable_for, "both"); assert.equal(a.liquidation_required_for_closing, true); assert.equal(usableCents({ ...a, verified_balance_cents: 3800000n }), 3800000n);
  const s = sufficiency([{ asset_id: "401k-a", usable_cents: 3800000n, usable_for: "both", status: "verified", liquidation_required_for_closing: true, liquidated_cents: 0n }], 500000n, 800000n);
  assert.equal(s.usable_closing_cents, 0n); assert.equal(s.shortfall_cents, 500000n); assert.equal(s.usable_reserves_after_closing_cents, 3800000n);
  const h = harness(PURCHASE, mst("2026-10-23", "09:00"));
  const r = await h.run("proposeCure", { op: "retirement", asset_id: "401k-a", vested_balance_cents: 3800000n, needed_for_closing_cents: 500000n, withdrawal_fees_cents: 7500n });
  assert.ok(r.condition_id); const cond = h.rt.store.require("conditions", String(r.condition_id)).data; assert.equal(cond.code, "liquidation_evidence"); assert.equal(cond.kind, "PTD"); assert.equal(cond.source, "22.4");
  const r2 = await h.run("proposeCure", { op: "retirement", asset_id: "401k-a", vested_balance_cents: 3800000n, needed_for_closing_cents: 0n }); assert.equal(r2.condition_id, null); assert.equal(r2.usable_for_reserves_cents, 3800000n);
});

test("22.4-T12: (departing residence) Given anticipated sales proceeds computed as $520,000.00 − ($36,400.00 + $301,500.00) = $182,100.00 needed for the down payment, when the subject closing is scheduled Wed Nov 18, 2026 and the sale closes Tue Nov 17, then the settlement statement satisfies `FNMA_B3_4_3_10_SALE_PROCEEDS_GATE`; given the sale slips to Nov 20, then funding is blocked and the agent proposes a bridge loan (22.5 payment) or reschedule.", async () => {
  const p = anticipatedSalesProceeds({ sales_price_cents: 52000000n, sales_costs_cents: 3640000n, liens_cents: 30150000n }); assert.equal(p.estimated_proceeds_cents, 18210000n); assert.equal(p.basis, "sales_price");
  assert.equal(anticipatedSalesProceeds({ listing_price_cents: 52000000n, sales_costs_cents: 0n, liens_cents: 30150000n }).estimated_proceeds_cents, 46800000n - 30150000n);
  assert.equal(saleProceedsGate({ subject_closing_date: D("2026-11-18"), sale_settlement_date: D("2026-11-17"), settlement_statement_document_id: "doc-hud-departing" }).open, true);
  const slipped = saleProceedsGate({ subject_closing_date: D("2026-11-18"), sale_settlement_date: D("2026-11-20"), settlement_statement_document_id: null });
  assert.equal(slipped.open, false); assert.deepEqual(slipped.blocks, ["funding.authorized"]); assert.ok(slipped.fallbacks.some((f) => /bridge loan/.test(f))); assert.ok(slipped.fallbacks.some((f) => /reschedule/.test(f)));
  assert.equal(evaluateGate("22.4.saleProceeds", { subject_closing_date: "2026-11-18", sale_settlement_date: "2026-11-20", settlement_statement_document_id: "doc-hud-departing" }).open, false);
  const h = harness(PURCHASE, mst("2026-10-23", "09:00"));
  await h.run("declareAssets", { assets: [{ asset_id: "sale-a", asset_type: "proceeds_real_estate_sale", borrower_ids: [B1], declared_balance_cents: 18210000n }] });
  const gate = h.timer("FNMA_B3_4_3_10_SALE_PROCEEDS_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:22.4.saleProceeds"); assert.equal(h.asset("sale-a").usable_for, "closing");
  h.at(mst("2026-11-17", "16:00"));
  const v = verifyAsset(h.events, { ...h.asset("sale-a"), declared_balance_cents: 18210000n, verified_balance_cents: null, usable_cents: 0n, secured_loan_offset_cents: 0n, emd_offset_cents: 0n, unsourced_deposit_offset_cents: 0n, liquidated_cents: 0n }, { verification_method: "settlement_statement", verified_balance_cents: 18210000n, evidence_document_ids: ["doc-hud-departing"], transaction: "purchase", initial_application_date: D(PURCHASE.application_date) });
  assert.equal(v.asset.status, "verified"); assert.equal(v.asset.usable_cents, 18210000n); assert.equal(v.event.payload.verification_method, "settlement_statement");
  assert.equal(h.timer("FNMA_B3_4_3_10_SALE_PROCEEDS_GATE")!.status, "satisfied");
  const cure = await h.run("proposeCure", { op: "sale_proceeds", subject_closing_date: "2026-11-18", sale_settlement_date: "2026-11-20", sales_price_cents: 52000000n, sales_costs_cents: 3640000n, liens_cents: 30150000n });
  assert.equal(cure.gate_open, false); assert.deepEqual(cure.blocks, ["funding.authorized"]); assert.equal(cure.estimated_proceeds_cents, 18210000n); assert.equal((cure.bridge_loan as { dti_hand_off: string }).dti_hand_off, "22.5 qualifying payment");
});

test("22.4 worked figures: purchase cash to close $43,997.00 = $45,800.00 + $8,712.00 − $5,000.00 − $5,000.00 − $515.00; closing funds $51,140.18 ($26,240.18 + $14,900.00 + $10,000.00), reserves $45,143.18 ≥ $8,000.00; shortfalls $2,856.82 / $1,856.82; IPC $27,468.00 / $13,640.00 / $2,532.00 / $455,268.00 / $13,658.04 / $16,341.96; reserves $8,200.00 → $16,200.00; LCOR $5,769.60 / $5,600.00 / $169.60 / $559,830.40 / $559,830.00 / $3,401.59; prepaid interest $935.47 and $1,785.48", () => {
  // R8 worked example 1 (purchase fixture): price $457,800.00, appraised $460,000.00, loan $412,000.00 → down payment $45,800.00; J = loan costs $1,960.00 + other costs $6,752.00 (13 days' prepaid interest $935.47 + homeowner's premium $1,380.00 + escrow/title/recording) = $8,712.00.
  assert.equal(45780000n - 41200000n, 4580000n); assert.equal(prepaidInterest(41200000n, 6375n, 13), 93547n); assert.equal(otherCosts([93547n, 138000n, 443653n]), 675200n); assert.equal(196000n + 675200n, 871200n);
  const ctc = cashToClose({ stage: "cd_v1", transaction: "purchase", sales_price_cents: 45780000n, appraised_value_cents: 46000000n, loan_amount_cents: 41200000n, total_closing_costs_cents: 871200n, down_payment_cents: 4580000n, emd_cents: 500000n, seller_credits_cents: 500000n, lender_credit_premium_cents: 51500n, reserves_required_cents: 800000n });
  assert.equal(ctc, 4399700n);
  // Verified assets: checking $31,240.18 − EMD offset $5,000.00 = $26,240.18; savings $14,900.00; gift $10,000.00; vested 401(k) $38,000.00 (reserves, no withdrawal).
  const chk = usableCents({ verified_balance_cents: 3124018n, secured_loan_offset_cents: 0n, emd_offset_cents: 500000n, unsourced_deposit_offset_cents: 0n, haircut_bps: 0, usable_for: "both" }); assert.equal(chk, 2624018n);
  const s = sufficiency(fixtureAssets(chk) as Parameters<typeof sufficiency>[0], ctc, 800000n);
  assert.equal(s.usable_closing_cents, 5114018n); assert.equal(2624018n + 1490000n + 1000000n, 5114018n); assert.equal(s.usable_reserves_after_closing_cents, 4514318n); assert.equal(5114018n - 4399700n + 3800000n, 4514318n); assert.equal(s.sufficient, true);
  assert.equal(sufficiency(fixtureAssets(chk).filter((a) => a.asset_id !== "gift-a") as Parameters<typeof sufficiency>[0], ctc, 800000n).shortfall_cents, 285682n); assert.equal(4399700n - 4114018n, 285682n);
  assert.equal(sufficiency(fixtureAssets(chk - 900000n) as Parameters<typeof sufficiency>[0], ctc, 800000n).shortfall_cents, 185682n); assert.equal(5114018n - 900000n, 4214018n);
  // R3: income $8,200.00 → threshold $4,100.00 ($7,500.00 → $3,750.00); deposit $9,000.00 = $6,500.00 transfer + $2,500.00 sale of a motorcycle → unsourced 0 after sourcing.
  assert.equal(largeDepositThreshold(820000n), 410000n); assert.equal(largeDepositThreshold(750000n), 375000n);
  const sourced = evaluateDeposit({ deposit_id: "d", asset_id: "chk-a", posted_on: D("2026-09-14"), amount_cents: 900000n, description_on_statement: "TRANSFER FROM SCHWAB …7781", sources: [{ cents: 650000n, kind: "transfer_verified_account" }, { cents: 250000n, kind: "sale_of_asset", evidence_document_ids: ["doc-title", "doc-bill-of-sale", "doc-purchaser-check"] }] }, { transaction: "purchase", threshold_cents: 410000n });
  assert.equal(sourced.unsourced_cents, 0n); assert.equal(sourced.status, "sourced"); assert.equal(250000n * 100n < 820000n * 50n, true);   // $2,500.00 < 50 % of income → no independent valuation (B3-4.3-18)
  // R7: base $457,800.00 (< $460,000.00); 6 % band → $27,468.00; $5,000.00 + $8,640.00 buydown = $13,640.00 ≤ max; $30,000.00 → excess $2,532.00 → adjusted $455,268.00 → LTV 90.496 % → 3 % → $13,658.04 → $16,341.96 over.
  const item = (amount_cents: bigint, kind: IpcItem["kind"] = "financing_concession"): IpcItem => ({ ipc_id: "i", application_id: PURCHASE.app, payer_party_id: "seller", payer_role: "seller", kind, amount_cents, disclosed_on_settlement: true, counts_toward_limit: true, evidence_document_ids: [], status: "declared" });
  const within = testIpcLimits({ sales_price_cents: 45780000n, appraised_value_cents: 46000000n, loan_amount_cents: 41200000n, occupancy: "principal_residence", cltv_milli_pct: 90000, items: [item(500000n), item(864000n, "buydown_subsidy")] });
  assert.equal(within.max_financing_concessions_cents, 2746800n); assert.equal(within.financing_concessions_cents, 1364000n); assert.equal(within.ok, true);
  const over = testIpcLimits({ sales_price_cents: 45780000n, appraised_value_cents: 46000000n, loan_amount_cents: 41200000n, occupancy: "principal_residence", cltv_milli_pct: 90000, items: [item(3000000n)] });
  assert.equal(over.excess_cents, 253200n); assert.equal(over.adjusted_price_cents, 45526800n); assert.equal(over.ltv_milli_pct, 90496); assert.equal(over.iterations[1]!.max_financing_concessions_cents, 1365804n); assert.equal(over.iterations[1]!.excess_cents, 1634196n);
  // R6: DU $8,000.00; rentals $250,000.00 + $160,000.00 = $410,000.00 × 2 % = $8,200.00 → $16,200.00; $14,580.00 = 90.00 % (no resubmission; gate closed); $14,500.00 → resubmission.
  const rsv = reservesRequired({ occupancy: "principal_residence", units: 1, transaction: "purchase", qualifying_pitia_cents: 300000n, du_reserves_required_cents: 800000n, other_financed_upb_cents: [25000000n, 16000000n] });
  assert.equal(rsv.other_financed_upb_cents, 41000000n); assert.equal(rsv.other_financed_cents, 820000n); assert.equal(rsv.required_cents, 1620000n); assert.equal(reserveTolerance(1458000n, 1620000n).tolerance_90pct_ok, true); assert.equal(reserveTolerance(1450000n, 1620000n).tolerance_90pct_ok, false);
  // R10: OHFA second $13,734.00 (3 % of $457,800.00); 3 % band max $13,734.00 ≥ seller credit $5,000.00.
  assert.equal(45780000n * 3n / 100n, 1373400n); assert.equal(communitySecond({ amount_cents: 1373400n, provider_name: "OHFA", provider_kind: "state_or_local_government", repayment: "forgivable", first_lien_cents: 41200000n, sales_price_cents: 45780000n, appraised_value_cents: 46000000n, occupancy: "principal_residence", seller_credit_cents: 500000n }).max_financing_concessions_cents, 1373400n);
  // R9 worked example 2 (refinance fixture): loan $560,000.00; payoff $547,912.40; J $6,318.00 = loan costs $1,720.00 + title/recording $1,978.00 + prepaid interest $1,785.48 (19 × $93.97 per diem at 6.125 %) + initial escrow deposit $834.52 (taxes $500.00 + insurance $120.00 per month, 30.3); cap $5,600.00 > $2,000.00.
  assert.equal(perDiemInterest(56000000n, 6125n), 9397n); assert.equal(prepaidInterest(56000000n, 6125n, 19), 178548n); assert.equal(otherCosts([172000n, 197800n, 178548n, 83452n]), 631800n); assert.equal(50000n + 12000n, 62000n);
  const cb = lcorCashBack({ loan_amount_cents: 56000000n, payoffs_cents: 54791240n, total_closing_costs_cents: 631800n });
  assert.equal(cb.cap_cents, 560000n); assert.equal(cb.cash_to_borrower_cents, 576960n); assert.equal(cb.overage_cents, 16960n); assert.equal(56000000n * 1n / 100n > 200000n, true);
  const cures = lcorCures(cb, 56000000n); assert.equal(cures.principal_curtailment!.upb_after_funding_cents, 55983040n); assert.equal(cures.loan_reduction!.new_loan_amount_cents, 55983000n); assert.equal(cures.loan_reduction!.decrease_cents, 17000n); assert.equal(monthlyPI(55983000n, "0.06125", 360), 340159n);
  assert.equal(lcorCashBack({ loan_amount_cents: 56000000n, payoffs_cents: 54900000n, total_closing_costs_cents: 631800n }).cash_to_borrower_cents, 468200n);
  // Gift $10,000.00 from the borrower's mother; departing residence $520,000.00 − ($36,400.00 + $301,500.00) = $182,100.00; bitcoin $20,000.00.
  assert.equal(anticipatedSalesProceeds({ sales_price_cents: 52000000n, sales_costs_cents: 3640000n, liens_cents: 30150000n }).estimated_proceeds_cents, 18210000n);
  assert.equal(virtualCurrencyUsable({ balance_cents: 2000000n, exchange_us_regulated: true, exchanged_to_usd_evidence_document_ids: ["x"], settlement_deposit: { deposit_id: "d", posted_on: D("2026-10-22"), amount_cents: 2000000n, institution_us_regulated: true, exchange_statement_document_id: "x" } }).usable_cents, 2000000n);
});
