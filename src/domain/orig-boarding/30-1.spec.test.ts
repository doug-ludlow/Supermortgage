// 30.1 Fannie Mae post-purchase servicing setup (servicer number, Fannie Mae loan number, remittance type, first reporting cycle, initial custodial deposits, servicer loan number, MERS/eRegistry post-purchase state, custodian record, Escrow Setup event)
// spec/sections/30-post-purchase-servicing-setup-and-boarding-to-the-subservice/30-1-fannie-mae-post-purchase-servicing-setup-servicer-number-fan.md
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
import { TOOLS_30_1 } from "../../app/tools/section30-1.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FANNIE_MAE_ORG_ID } from "../../infra/integrations/mers.ts";
import { SUPERMORTGAGE_ORG_ID } from "../transfers/inbound.ts";
import { purchaseUpdate, seedInvestorPosition, ptrConsistency, establishmentCheck, firstLarClocks, firstLarProjection, firstLarGate, paymentLar, purchaseMonthInterestDeduction, purchaseMonthRemittance, escrowSetupPlan, escrowSetupDecision, setupDecisionRecord, scheduleCustodialTransfers, interimFunderRemovalTxn, verifyENote, enoteCommandGate, investorSetupStatus, postPurchaseSetupLine, UPB_TOLERANCE_CENTS, ESCROW_SETUP_ITEM_TYPE, PREPURCHASE_TI_ACCOUNT, type PurchaseAdvice, type PurchaseLoan } from "./ops-30-1.ts";

const AGENT: Actor = { kind: "agent", id: "investor-reporting" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const LOAN = "L-REFI-1", APP = "app-refi-1", MIN = "100012300004567890", PARTNER_ORG = "1000123", SERVICER = "123456789", FNMA_LOAN = "4000012345";
const FNMA_TI = "ca-fnma-ti-aa", FNMA_PI = "ca-fnma-pi-aa";
/** The refinance fixture (section README): $560,000 LCOR, 6.125%, P&I $3,402.62, escrowed, no MI; purchased Thu Nov 19, 2026; LPI Dec 1, 2026; PTR 5.875% (25 bps fee). */
const LOAN_ROW: PurchaseLoan = { loan_id: LOAN, application_id: APP, servicing_loan_number: "SM-000000001", original_upb_cents: 56_000_000n, first_payment_date: D("2027-01-01"), note_rate_pct: "6.125", commitment_remittance_type: "AA", escrowed: true, note_form: "paper", mers_registered: true, min: MIN };
const ADVICE: PurchaseAdvice = { advice_id: "PA-2026-11-19-0001", fnma_loan_number: FNMA_LOAN, fnma_servicer_number: SERVICER, lender_loan_number: "SM-000000001", advice_date: D("2026-11-19"), purchase_date: D("2026-11-19"), remittance_type: "AA", pass_through_rate: "5.875000", note_rate_pct: "6.125", servicing_fee_bps: 25, interest_adjustment_cents: -109_667n, net_proceeds_cents: 56_590_333n };
const POSITION = { loan_id: LOAN, fnma_lpi_date: "2026-12-01", fnma_actual_upb_cents: "56000000", remittance_type: "AA", fnma_ptr: "5.875000", as_of: "2026-11-19" };
const loanInput = (over: Partial<PurchaseLoan> = {}): Record<string, unknown> => ({ ...LOAN_ROW, ...over, original_upb_cents: String(LOAN_ROW.original_upb_cents) });
const adviceInput = (over: Partial<PurchaseAdvice> = {}): Record<string, unknown> => ({ ...ADVICE, ...over, interest_adjustment_cents: String(ADVICE.interest_adjustment_cents), net_proceeds_cents: String(ADVICE.net_proceeds_cents) });
const et = (date: string, hhmm: string): string => { const [h, m] = hhmm.split(":").map(Number) as [number, number]; return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h + 5, m)).toISOString(); };   // EST (UTC−5) in Nov–Jan

/** The 30.1 tools on the bus over the overridden registry (30.1 rows plus 27.2's referenced clocks), a memory ledger and the escalation service; the harness appends the upstream events (27.2 / 29.4) with origination context. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["30.1", "27.2"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId: LOAN, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_30_1); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("30.1", name))!, actor, { loan_id: LOAN, application_id: APP, ...input }, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.byLoan(LOAN).filter((e) => e.type === type);
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt = clock.now()) => events.append({ type, loanId: LOAN, applicationId: APP, actor: { kind: "external", id: "fnma" }, occurredAt, payload: { application_id: APP, ...payload } });
  const adviceReceived = (on = "2026-11-19") => upstream("purchase_advice.received", { advice_id: ADVICE.advice_id, advice_date: on, fnma_loan_number: FNMA_LOAN, purchase_date: on, remittance_type: "AA", pass_through_rate: "5.875000" }, et(on, "09:00"));
  const purchased = (over: Record<string, unknown> = {}, on = "2026-11-19") => upstream("loan.purchased", { purchase_date: on, fnma_loan_number: FNMA_LOAN, loan_delivery_status: "Purchased and Funded", note_form: "paper", escrowed: true, ...over }, et(on, "16:00"));
  const proceeds = (on = "2026-11-20") => upstream("proceeds.received", { proceeds_received_at: et(on, "14:00"), amount_cents: "56590333", value_date: on, originator: "fnma" }, et(on, "14:00"));
  const repaid = (on = "2026-11-20") => upstream("warehouse.advance.repaid", { repaid_at: on, repaid_from: "purchase_proceeds", note_form: "paper", bank_matched: true }, et(on, "15:00"));
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  /** T1 + T2 on the bus: advice matched Nov 19, purchased, established Fri Nov 20 from the LSDU position. */
  const throughEstablishment = async () => {
    at(et("2026-11-19", "10:00")); adviceReceived(); await run("matchPurchaseAdvice", { loan: loanInput(), advice: adviceInput() }); await run("seedInvestorPosition", { loan: loanInput(), advice: adviceInput() }); purchased();
    await run("createCorrection", { op: "timer_cancel_inapplicable", loan: loanInput() });   // paper note: the eNote row does not apply
    at(et("2026-11-20", "07:00"));
    return run("checkFnmaEstablishment", { source: "lsdu_position", found: true, observed: { fnma_lpi_date: "2026-12-01", fnma_upb_cents: "56000000", fnma_remittance_type: "AA", fnma_ptr: "5.875" }, expected: POSITION, purchase_date: "2026-11-19", fnma_loan_number: FNMA_LOAN });
  };
  const firstLar = { servicer_number: SERVICER, fnma_loan_number: FNMA_LOAN, position: POSITION, purchase_date: "2026-11-19", established_at: "2026-11-20" };
  return { rt, uow, events, ledger, timers, run, at, timer, ofType, upstream, adviceReceived, purchased, proceeds, repaid, refused, throughEstablishment, firstLar, decisions, clock };
}

test("30.1-T1: Given a Purchase Advice dated Thu Nov 19, 2026 for the fixture loan, when `purchase_advice.received` is processed, then `loans.fnma_loan_number`, `purchase_date=2026-11-19`, `remittance_type='AA'`, `pass_through_rate=5.875000` and `loan_terms` v2 effective 2026-11-19 exist by 17:00 ET the same day and `SM_FNMA_LOAN_NUMBER_RECORD_T0` is satisfied.", async () => {
  const h = harness(et("2026-11-19", "09:00"));
  h.adviceReceived("2026-11-19");
  const t0 = h.timer("SM_FNMA_LOAN_NUMBER_RECORD_T0")!;
  assert.equal(t0.status, "armed"); assert.equal(t0.dueDate, "2026-11-19"); assert.equal(new Date(t0.dueAt!).toISOString(), et("2026-11-19", "17:00"));
  h.at(et("2026-11-19", "10:30"));
  const out = await h.run("matchPurchaseAdvice", { loan: loanInput(), advice: adviceInput() });
  assert.equal(out.ok, true);
  const loan = h.rt.store.get("loans", LOAN)!.data;
  assert.equal(loan.fnma_loan_number, FNMA_LOAN); assert.equal(loan.fnma_servicer_number, SERVICER); assert.equal(loan.purchase_date, "2026-11-19"); assert.equal(loan.remittance_type, "AA"); assert.equal(loan.pass_through_rate, "5.875000"); assert.equal(loan.investor, "fnma"); assert.equal(loan.investor_setup_status, "purchased"); assert.equal(loan.fnma_first_reporting_period, "2026-11");
  const terms = h.rt.store.get("loan_terms", `${LOAN}:2`)!.data;
  assert.equal(terms.version, 2); assert.equal(terms.effective_date, "2026-11-19"); assert.equal(terms.servicing_fee_bps, 25); assert.equal(terms.gfee_bps, 0);
  const updated = h.ofType("loan.investor_updated")[0]!;
  assert.ok(Date.parse(updated.occurredAt) <= t0.dueAt!, "written by 17:00 ET the same day");
  assert.equal(t0.status, "satisfied"); assert.equal(t0.satisfiedByEventId, updated.id);
  assert.deepEqual(ptrConsistency("6.125", "5.875000", 25), { consistent: true, implied_fee_bps: 25 });
  // rule 1 idempotency: the same advice again is a replay, not a second version
  const again = await h.run("matchPurchaseAdvice", { loan: loanInput(), advice: adviceInput() });
  assert.equal(again.replayed, true); assert.equal(h.ofType("loan.investor_updated").length, 1); assert.equal(h.rt.store.history("loans", LOAN).length, 1);
  assert.deepEqual(seedInvestorPosition(LOAN_ROW, ADVICE).fnma_lpi_date, D("2026-12-01"));
});

test("30.1-T2: Given the loan appears in the LSDU position extract on Fri Nov 20, 2026 with LPI 12/2026 and UPB $560,000.00, then `loan.fnma_established` (established_at 2026-11-20), `investor_setup_status='established'`, and the first LAR 96 (`0005600000{`, action 00, action date 112026) is submitted by Mon Nov 23, 2026 20:00 ET.", async () => {
  const h = harness(et("2026-11-19", "09:00"));
  const est = await h.throughEstablishment();
  assert.equal(est.status, "established"); assert.equal(est.established_at, "2026-11-20");
  assert.equal(h.ofType("loan.fnma_established").length, 1); assert.equal(h.ofType("loan.fnma_established")[0]!.payload.established_at, "2026-11-20");
  assert.equal(h.rt.store.get("loans", LOAN)!.data.investor_setup_status, "established");
  const verify = h.timer("SM_FNMA_ESTABLISHMENT_VERIFY_1BD")!;
  assert.equal(verify.dueDate, "2026-11-20"); assert.equal(new Date(verify.dueAt!).toISOString(), et("2026-11-20", "17:00")); assert.equal(verify.status, "satisfied");
  const target = h.timer("SM_FIRST_LAR_TARGET_NEXTBD_2000")!;
  assert.equal(target.dueDate, "2026-11-23"); assert.equal(new Date(target.dueAt!).toISOString(), et("2026-11-23", "20:00"));
  const pr = await h.run("projectEvent", { op: "first_lar", ...h.firstLar });
  const fields = pr.lar as { fields: Record<string, string>; record: string };
  assert.equal(fields.fields.upb, "0005600000{"); assert.equal(fields.fields.action_code, "00"); assert.equal(fields.fields.action_date, "112026"); assert.equal(fields.fields.lpi, "1226"); assert.equal(fields.fields.interest, "0000000000{"); assert.equal(fields.fields.principal, "0000000000{"); assert.equal(fields.fields.servicer_number, SERVICER);
  assert.equal(fields.record.length, 81); assert.equal(pr.held, false);
  h.at(et("2026-11-23", "10:00"));
  const sub = await h.run("submitBatch", { op: "lar", ...h.firstLar, submission_id: "lsdu-b2b-0001" });
  assert.equal(sub.submitted, true); assert.equal(sub.late_vs_target, false);
  const submitted = h.ofType("investor.first_lar.submitted")[0]!;
  assert.ok(Date.parse(submitted.occurredAt) <= target.dueAt!); assert.equal(target.status, "satisfied");
  assert.equal(submitted.payload.hard_deadline_at, et("2026-11-30", "20:00"));
  const clocks = firstLarClocks(D("2026-11-19"), D("2026-11-20"));
  assert.equal(clocks.target_on, "2026-11-23"); assert.equal(clocks.hard_deadline_on, "2026-11-30"); assert.equal(clocks.activity_period, "2026-11");
  // edge cases (spec): purchase Tue Dec 1 → established Wed Dec 2, target Thu Dec 3, hard stop Thu Dec 31; purchase Mon Nov 30 → established Tue Dec 1 (BD1) is itself the hard stop
  assert.deepEqual([firstLarClocks(D("2026-12-01"), D("2026-12-02")).target_on, firstLarClocks(D("2026-12-01"), D("2026-12-02")).hard_deadline_on], ["2026-12-03", "2026-12-31"]);
  assert.deepEqual([firstLarClocks(D("2026-11-30"), D("2026-12-01")).hard_deadline_on, firstLarClocks(D("2026-11-30"), D("2026-12-01")).basis], ["2026-12-01", "bd1_prior_period_limit"]);
});

test("30.1-T3: Given the first LAR is not accepted by Mon Nov 30, 2026 20:00 ET, then `FNMA_TT96_FIRST_LAR_ACQ_MONTH_BD2` breaches with an `officer` escalation and the Compliance Sentinel report lists it; given acceptance on Nov 23, then the December cycle creates `payment.none` due Tue Dec 22, 2026 20:00 ET.", async () => {
  const h = harness(et("2026-11-19", "09:00"));
  await h.throughEstablishment();
  h.at(et("2026-11-23", "10:00")); await h.run("submitBatch", { op: "lar", ...h.firstLar, submission_id: "lsdu-b2b-0001" });
  const hard = h.timer("FNMA_TT96_FIRST_LAR_ACQ_MONTH_BD2")!;
  assert.equal(hard.dueDate, "2026-11-30"); assert.equal(new Date(hard.dueAt!).toISOString(), et("2026-11-30", "20:00"));
  assert.ok(!h.timers.evaluate(et("2026-11-30", "19:59")).some((b) => b.def.code === "FNMA_TT96_FIRST_LAR_ACQ_MONTH_BD2"), "not yet breached before 20:00 ET");
  const breaches = h.timers.evaluate(et("2026-11-30", "20:01"));
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, "FNMA_TT96_FIRST_LAR_ACQ_MONTH_BD2"); assert.equal(breaches[0]!.severity, 1); assert.ok(breaches[0]!.escalateTo.includes("officer"));
  const status = await h.run("pollFeedback", { op: "status" });
  const line = status.sentinel_line as Record<string, unknown>;
  assert.equal(line.first_lar_status, "breached"); assert.ok((line.breached_timers as string[]).includes("FNMA_TT96_FIRST_LAR_ACQ_MONTH_BD2"));
  // acceptance on Nov 23 (a parsed Fannie Mae response) → the December cycle's payment.none is due CD22 (Tue Dec 22) 20:00 ET
  const g = harness(et("2026-11-19", "09:00"));
  await g.throughEstablishment();
  g.at(et("2026-11-23", "10:00")); await g.run("submitBatch", { op: "lar", ...g.firstLar, submission_id: "lsdu-b2b-0001" });
  await g.refused(g.run("pollFeedback", { op: "lar", submission_id: "lsdu-b2b-0001", assume_accepted: true }), "NO_ACCEPT_WITHOUT_RESPONSE");
  g.at(et("2026-11-23", "16:00"));
  const acc = await g.run("pollFeedback", { op: "lar", submission_id: "lsdu-b2b-0001", fnma_response_id: "fb-0001" });
  assert.equal(acc.status, "first_lar_accepted"); assert.equal(g.timer("FNMA_TT96_FIRST_LAR_ACQ_MONTH_BD2")!.status, "satisfied");
  assert.equal(g.ofType("investor.first_lar.accepted")[0]!.payload.activity_period, "2026-11");
  const dec = await g.run("projectEvent", { op: "payment_none", month_of: "2026-12-01", servicer_number: SERVICER, fnma_loan_number: FNMA_LOAN, position: POSITION, sequence: 2 });
  assert.equal(dec.event_type, "payment.none"); assert.equal(dec.due_on, "2026-12-22"); assert.equal(dec.submit_by, et("2026-12-22", "20:00")); assert.equal(dec.sweep_run, et("2026-12-22", "18:00"));
  assert.deepEqual(purchaseMonthRemittance(D("2026-11-19")), { period: "2026-11", remittance_calculations: [], first_lar_interest_cents: 0n, first_lar_principal_cents: 0n });
});

test("30.1-T4: Given the flag `investor_reporting.escrow_events=on` and Servicing Platform visibility observed Fri Nov 20, then the T&I Escrow Setup event for $2,062.50 (sequence 1, item \"Set up\") is accepted before Mon Nov 23, 2026 03:00 ET; given visibility observed Thu Nov 19, the deadline is Fri Nov 20 03:00 ET and the decision record shows `deadline_basis='purchase_day_visibility'`.", async () => {
  const plan = escrowSetupPlan({ loan_id: LOAN, escrowed: true, flag_on: true, categories: [{ category: "ti", balance_cents: 206_250n }, { category: "buydown", balance_cents: 0n }], purchase_date: D("2026-11-19"), visibility_observed_on: D("2026-11-20") });
  assert.equal(plan.required, true); assert.equal(plan.events.length, 1);
  assert.deepEqual([plan.events[0]!.category, plan.events[0]!.item_type, plan.events[0]!.sequence, plan.events[0]!.amount_cents, plan.events[0]!.balance_cents], ["ti", ESCROW_SETUP_ITEM_TYPE, 1, 206_250n, 206_250n]);
  assert.equal(plan.deadline_basis, "establishment_day_visibility"); assert.equal(plan.deadline_on, "2026-11-23"); assert.equal(new Date(plan.deadline_at_ms!).toISOString(), et("2026-11-23", "03:00"));
  assert.equal(new Date(plan.target_at_ms).toISOString(), et("2026-11-20", "03:00"), "the purchase-day target (open question 5)"); assert.equal(plan.contractual, false, "purchased before Dec 1, 2026: CIT window, not a contractual breach");
  const h = harness(et("2026-11-19", "09:00"));
  await h.throughEstablishment();
  assert.equal(h.timer("LL_2026_05_ESCROW_SETUP_ORIG_PURCHASE_BD1")!.status, "armed");
  h.at(et("2026-11-20", "09:00"));
  const sent = await h.run("submitBatch", { op: "escrow_setup", purchase_date: "2026-11-19", visibility_observed_on: "2026-11-20", categories: [{ category: "ti", balance_cents: "206250" }] });
  assert.equal(sent.sent, 1); assert.equal(sent.deadline_at, et("2026-11-23", "03:00"));
  const se = h.ofType("escrow.setup_event.sent")[0]!; assert.equal(se.payload.item_type, "Set up"); assert.equal(se.payload.sequence, 1); assert.equal(se.payload.amount_cents, "206250");
  h.at(et("2026-11-20", "18:00"));
  const ack = await h.run("pollFeedback", { op: "escrow_setup", category: "ti", fnma_response_id: "sp-resp-0001", status: "accepted" });
  assert.equal(ack.every_category, true);
  const acked = h.ofType("investor_events.acked")[0]!;
  assert.equal(acked.payload.type, "EscrowSetup"); assert.equal(acked.payload.every_category, true); assert.equal(acked.payload.late, false);
  assert.ok(Date.parse(acked.occurredAt) < plan.deadline_at_ms!, "accepted before Mon Nov 23 03:00 ET");
  assert.ok(["satisfied", "satisfied_late"].includes(h.timer("LL_2026_05_ESCROW_SETUP_ORIG_PURCHASE_BD1")!.status));
  assert.equal(h.rt.store.get("loans", LOAN)!.data.investor_setup_status, "escrow_setup_acked");
  // visibility on the purchase day: the deadline is the target and the decision record says so
  const early = escrowSetupPlan({ loan_id: LOAN, escrowed: true, flag_on: true, categories: [{ category: "ti", balance_cents: 206_250n }], purchase_date: D("2026-11-19"), visibility_observed_on: D("2026-11-19") });
  assert.equal(early.deadline_basis, "purchase_day_visibility"); assert.equal(new Date(early.deadline_at_ms!).toISOString(), et("2026-11-20", "03:00"));
  const decision = escrowSetupDecision(h.events, LOAN, early)[0]!;
  assert.equal(decision.deadline_basis, "purchase_day_visibility"); assert.equal(decision.amount_cents, 206_250n); assert.equal(decision.accepted_at, acked.occurredAt);
  const record = setupDecisionRecord(h.events, LOAN, early) as { escrow_setup: { deadline_basis: string }[]; rule_set_version: string };
  assert.equal(record.escrow_setup[0]!.deadline_basis, "purchase_day_visibility"); assert.equal(record.rule_set_version, "30.1@ops.v1");
  // flag off: no Setup event (3.7's cut-over job sends it later)
  assert.equal(escrowSetupPlan({ loan_id: LOAN, escrowed: true, flag_on: false, categories: [{ category: "ti", balance_cents: 206_250n }], purchase_date: D("2026-11-19"), visibility_observed_on: D("2026-11-20") }).required, false);
});

test("30.1-T5: Given purchase proceeds bank-matched Fri Nov 20, 2026, then `custodial_transfers{ti_escrow_balance, 206250}` is due Mon Nov 23, 2026 and the T&I bank feed shows the credit; a transfer executed Tue Nov 24 breaches `FNMA_F1_03_TI_DEPOSIT_PROCEEDS_1BD` (sev-1).", async () => {
  const schedule = { op: "custodial_transfer", proceeds_received_at: et("2026-11-20", "14:00"), balances: { ti_escrow_balance_cents: "206250" }, fnma_ti_account_id: FNMA_TI, fnma_pi_account_id: FNMA_PI };
  const h = harness(et("2026-11-19", "09:00"));
  await h.throughEstablishment();
  h.at(et("2026-11-20", "14:00")); h.proceeds("2026-11-20");
  const ti = h.timer("FNMA_F1_03_TI_DEPOSIT_PROCEEDS_1BD")!, pi = h.timer("FNMA_F1_03_PI_DEPOSIT_PROCEEDS_1BD")!;
  assert.equal(ti.dueDate, "2026-11-23"); assert.equal(ti.anchorDate, "2026-11-20");
  const sched = await h.run("submitBatch", schedule);
  const rows = sched.rows as Record<string, unknown>[];
  assert.equal(sched.due_on, "2026-11-23"); assert.equal(rows.length, 1); assert.equal(rows[0]!.kind, "ti_escrow_balance"); assert.equal(rows[0]!.amount_cents, "206250"); assert.equal(rows[0]!.from_account_id, PREPURCHASE_TI_ACCOUNT); assert.equal(rows[0]!.to_account_id, FNMA_TI);
  assert.equal(pi.status, "cancelled", "no P&I collected between delivery and purchase");
  const pure = scheduleCustodialTransfers(new MemoryEventStore(h.clock), { loan_id: LOAN, proceeds_received_at: et("2026-11-20", "14:00"), balances: { ti_escrow_balance_cents: 206_250n }, fnma_ti_account_id: FNMA_TI, fnma_pi_account_id: FNMA_PI });
  assert.deepEqual([pure.rows[0]!.kind, pure.rows[0]!.amount_cents, pure.due_on], ["ti_escrow_balance", 206_250n, "2026-11-23"]);
  h.at(et("2026-11-23", "11:00"));
  const posted = await h.run("submitBatch", { op: "book_transfer", row: rows[0], transferred_at: et("2026-11-23", "11:00"), bank_reference: "BT-20261123-0001" });
  assert.equal(posted.late, false);
  assert.equal(h.ledger.balance({ scope: "custodial", custodialAccountId: FNMA_TI, account: "custodial_ti_cash" }), 206_250n);
  assert.equal(h.ledger.balance({ scope: "custodial", custodialAccountId: PREPURCHASE_TI_ACCOUNT, account: "custodial_ti_cash" }), -206_250n);
  assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "escrow" }), 0n, "no borrower-level entry: the loan's escrow liability is unchanged");
  assert.equal(ti.status, "armed", "the ledger posting alone does not satisfy F-1-03: the bank feed must show the credit");
  h.at(et("2026-11-23", "17:30"));
  const matched = await h.run("pollFeedback", { op: "bank_feed", row: posted.row, credits: [{ amountCents: "206250", bankReference: "BT-20261123-0001", text: "BOOK TRANSFER SM SUBSERVICER FOR PARTNER" }] });
  assert.equal(matched.matched, true);
  const ev = h.ofType("custodial.prepurchase_funds.transferred")[0]!;
  assert.equal(ev.payload.kind, "ti_escrow_balance"); assert.equal(ev.payload.bank_matched, true); assert.equal(ev.payload.amount_cents, "206250");
  assert.equal(ti.status, "satisfied"); assert.equal(ti.satisfiedByEventId, ev.id);
  // executed Tue Nov 24 → the deposit timer breached sev-1 to the officer (custodial breach; Form 496A exception)
  const g = harness(et("2026-11-19", "09:00"));
  await g.throughEstablishment();
  g.at(et("2026-11-20", "14:00")); g.proceeds("2026-11-20"); const late = await g.run("submitBatch", schedule);
  const breaches = g.timers.evaluate(et("2026-11-24", "09:00"));
  const b = breaches.find((x) => x.def.code === "FNMA_F1_03_TI_DEPOSIT_PROCEEDS_1BD")!;
  assert.equal(b.severity, 1); assert.ok(b.escalateTo.includes("officer"));
  g.at(et("2026-11-24", "10:00"));
  const lateRow = await g.run("submitBatch", { op: "book_transfer", row: (late.rows as Record<string, unknown>[])[0], transferred_at: et("2026-11-24", "10:00") });
  assert.equal(lateRow.late, true);
  await g.run("pollFeedback", { op: "bank_feed", row: lateRow.row, credits: [{ amountCents: "206250", bankReference: "BT-20261124-0007", text: "BOOK TRANSFER" }] });
  assert.equal(g.timer("FNMA_F1_03_TI_DEPOSIT_PROCEEDS_1BD")!.status, "satisfied_late");
  assert.equal(((await g.run("pollFeedback", { op: "status" })).sentinel_line as Record<string, unknown>).custodial_transfer_status, "matched");
});

test("30.1-T6: Given `warehouse.advance.repaid` on Fri Nov 20, then a MERS MIN Update removing SM's Interim Funder Org ID is in the Mon Nov 23 batch and accepted; given the MRE snapshot on Fri Dec 4 shows investor = Fannie Mae, then `mers.investor.fnma_verified` and 1.5 `W-016` closes; if not, a partner query package exists on Dec 4.", async () => {
  const h = harness(et("2026-11-19", "09:00"));
  await h.throughEstablishment();
  const verify = h.timer("SM_MERS_INVESTOR_FNMA_VERIFY_10BD")!;
  assert.equal(verify.dueDate, "2026-12-04", "10 servicer business days from Nov 19 (Nov 20, 23, 24, 25, 27, 30, Dec 1, 2, 3, 4)");
  h.at(et("2026-11-20", "15:00")); h.repaid("2026-11-20");
  const release = h.timer("SM_WH_INTERIM_FUNDER_RELEASE_2BD")!;
  assert.equal(release.status, "armed", "27.2's clock, referenced by 30.1");
  await h.refused(h.run("submitBatch", { op: "mers_min_update", min: MIN, repaid_on: "2026-11-20", bank_matched: false }), "INTERIM_FUNDER_AFTER_REPAID");
  await h.refused(h.run("submitBatch", { op: "mers_min_update", min: MIN, repaid_on: "2026-11-20", txn_type: "tob_confirm" }), "NO_TOB");
  const txn = interimFunderRemovalTxn({ min: MIN, repaid_on: D("2026-11-20"), bank_matched: true });
  assert.equal(txn.batch_on, "2026-11-23"); assert.equal(txn.txn.subtype, "interim_funder_removed"); assert.equal(txn.txn.from_org_id, SUPERMORTGAGE_ORG_ID); assert.equal(txn.txn.to_org_id, null); assert.equal(txn.tob, false);
  const batch = await h.run("submitBatch", { op: "mers_min_update", min: MIN, repaid_on: "2026-11-20" });
  assert.equal(batch.batch_on, "2026-11-23"); assert.equal((batch.txn as { type: string }).type, "min_update_other");
  h.at(et("2026-11-23", "22:00"));
  const ack = await h.run("pollFeedback", { op: "mers_ack", txn: batch.txn, batch_id: batch.batch_id, accepted: true, min: MIN });
  assert.equal(ack.removed, true);
  const removed = h.ofType("warehouse.interim_funder.removed")[0]!;
  assert.equal(removed.payload.mers_transaction_subtype, "interim_funder_removed"); assert.equal(removed.payload.min, MIN);
  assert.equal(release.status, "satisfied"); assert.equal(h.rt.store.get("mers_transactions", `${batch.batch_id}:${MIN}`)!.data.subtype, "interim_funder_removed");
  h.at(et("2026-12-04", "07:00"));
  const snap = await h.run("pollFeedback", { op: "mers_snapshot", min: MIN, snapshot_on: "2026-12-04", purchase_date: "2026-11-19", partner_org_id: PARTNER_ORG, snapshot: { status: "active", investor_org_id: FANNIE_MAE_ORG_ID, servicer_org_id: PARTNER_ORG, subservicer_org_id: SUPERMORTGAGE_ORG_ID, interim_funder_org_id: null } });
  assert.equal(snap.verified, true); assert.equal(snap.w016_closed, true); assert.deepEqual(snap.problems, []);
  assert.equal(h.ofType("mers.investor.fnma_verified").length, 1); assert.equal(h.ofType("loan.boarding_exception.resolved")[0]!.payload.rule_code, "W-016");
  assert.equal(verify.status, "satisfied");
  // Fannie Mae's update not reflected by Fri Dec 4: partner query package for the MERS Program Office (B8-7-01); W-016 stays open; no TOB
  const g = harness(et("2026-11-19", "09:00"));
  await g.throughEstablishment();
  g.at(et("2026-12-04", "07:00"));
  const miss = await g.run("pollFeedback", { op: "mers_snapshot", min: MIN, snapshot_on: "2026-12-04", purchase_date: "2026-11-19", partner_org_id: PARTNER_ORG, snapshot: { status: "active", investor_org_id: PARTNER_ORG, servicer_org_id: PARTNER_ORG, subservicer_org_id: SUPERMORTGAGE_ORG_ID, interim_funder_org_id: null } });
  assert.equal(miss.verified, false); assert.equal(miss.w016_closed, false);
  const q = miss.partner_query as Record<string, unknown>;
  assert.equal(q.kind, "partner_query"); assert.equal(q.addressee, "Fannie Mae MERS Program Office"); assert.equal(q.citation, "Selling Guide B8-7-01"); assert.equal(q.snapshot_on, "2026-12-04");
  assert.equal(g.ofType("mers.investor.query_packaged")[0]!.payload.no_tob, true); assert.equal(g.ofType("mers.investor.fnma_verified").length, 0);
  assert.ok(g.timers.evaluate(et("2026-12-05", "00:00")).some((b) => b.def.code === "SM_MERS_INVESTOR_FNMA_VERIFY_10BD" && b.severity === 3));
});

test("30.1-T7: Given an eNote loan purchased Nov 19, when the eRegistry inquiry on Nov 20 shows Controller = Fannie Mae, Location = Fannie Mae eVault, Master Servicer = SM Org ID and no Secured Party, then `enote.post_purchase.verified`; given Master Servicer = partner Org ID, then the timer breaches and eNote payoff commands are blocked with reason `enote_master_servicer_mismatch`.", async () => {
  const h = harness(et("2026-11-19", "16:00"));
  h.purchased({ note_form: "enote" });
  const t = h.timer("SM_ENOTE_POST_PURCHASE_VERIFY_1BD")!;
  assert.equal(t.dueDate, "2026-11-20"); assert.equal(enoteCommandGate(h.events, LOAN).blocked, true);
  h.at(et("2026-11-20", "10:00"));
  const ok = await h.run("pollFeedback", { op: "eregistry", inquiry: { controller_org_id: FANNIE_MAE_ORG_ID, location_org_id: FANNIE_MAE_ORG_ID, master_servicer_org_id: SUPERMORTGAGE_ORG_ID, secured_party_org_id: null } });
  assert.equal(ok.verified, true); assert.deepEqual(ok.mismatches, []);
  const v = h.ofType("enote.post_purchase.verified")[0]!;
  assert.equal(v.payload.post_purchase_verified_at, et("2026-11-20", "10:00")); assert.equal(v.payload.sfc_508, true); assert.equal(v.payload.note_location, "fnma_evault");
  assert.equal(t.status, "satisfied"); assert.deepEqual(enoteCommandGate(h.events, LOAN), { blocked: false, reason: null });
  // Master Servicer = the partner's Org ID (open question 4 resolved the other way) → mismatch, breach, eNote payoff commands blocked
  const g = harness(et("2026-11-19", "16:00"));
  g.purchased({ note_form: "enote" });
  g.at(et("2026-11-20", "10:00"));
  const bad = await g.run("pollFeedback", { op: "eregistry", inquiry: { controller_org_id: FANNIE_MAE_ORG_ID, location_org_id: FANNIE_MAE_ORG_ID, master_servicer_org_id: PARTNER_ORG, secured_party_org_id: null } });
  assert.equal(bad.verified, false); assert.deepEqual(bad.mismatches, ["enote_master_servicer_mismatch"]);
  assert.deepEqual(bad.gate, { blocked: true, reason: "enote_master_servicer_mismatch" });
  const breaches = g.timers.evaluate(et("2026-11-21", "00:00"));
  const b = breaches.find((x) => x.def.code === "SM_ENOTE_POST_PURCHASE_VERIFY_1BD")!;
  assert.equal(b.severity, 2); assert.ok(b.escalateTo.includes("post-closing"));
  assert.equal(enoteCommandGate(g.events, LOAN).reason, "enote_master_servicer_mismatch");
  assert.deepEqual(verifyENote(new MemoryEventStore(g.clock), { loan_id: LOAN, inquiry: { controller_org_id: FANNIE_MAE_ORG_ID, location_org_id: FANNIE_MAE_ORG_ID, master_servicer_org_id: SUPERMORTGAGE_ORG_ID, secured_party_org_id: SUPERMORTGAGE_ORG_ID }, inquiry_at: et("2026-11-20", "10:00") }).mismatches, ["enote_secured_party_present"], "the warehouse Secured Party must be cleared after purchase");
});

test("30.1-T8: Given Fannie Mae's position shows UPB $560,000.01, then a `position_variance` (money) opens, the first LAR is held, and the command to adopt Fannie Mae's figure is refused without an `officer` approval record and a PPA package.", async () => {
  const h = harness(et("2026-11-19", "09:00"));
  h.at(et("2026-11-19", "10:00")); h.adviceReceived(); await h.run("matchPurchaseAdvice", { loan: loanInput(), advice: adviceInput() }); h.purchased();
  h.at(et("2026-11-20", "07:00"));
  const chk = await h.run("checkFnmaEstablishment", { source: "lsdu_position", found: true, observed: { fnma_lpi_date: "2026-12-01", fnma_upb_cents: "56000001", fnma_remittance_type: "AA", fnma_ptr: "5.875" }, expected: POSITION, purchase_date: "2026-11-19" });
  assert.equal(chk.status, "position_variance"); assert.equal(chk.lar_held, true);
  const v = (chk.variances as { kind: string; money: boolean }[])[0]!;
  assert.equal(v.kind, "upb"); assert.equal(v.money, true);
  const opened = h.ofType("position_variance.opened")[0]!;
  assert.equal(opened.payload.money, true); assert.equal(opened.payload.lar_held, true);
  assert.equal(h.ofType("loan.fnma_established").length, 0); assert.equal(h.ofType("escalation.created").filter((e) => e.payload.kind === "officer").length, 1);
  assert.deepEqual(firstLarGate(h.events, LOAN).held, true);
  await assert.rejects(h.run("submitBatch", { op: "lar", ...h.firstLar, submission_id: "lsdu-b2b-0001" }), /FIRST_LAR_HELD/);
  assert.equal(h.ofType("investor.first_lar.submitted").length, 0);
  // adopting Fannie Mae's figure: refused for the agent, refused for the officer without the PPA package + approval record, allowed with both
  await h.refused(h.run("createCorrection", { op: "adopt_fnma_figure", opened_event_id: opened.id, adopted_value: "56000001" }), "MONEY_VARIANCE_EVIDENCE");
  await h.refused(h.run("createCorrection", { op: "adopt_fnma_figure", opened_event_id: opened.id, adopted_value: "56000001", officer_approval_id: "appr-1" }, OFFICER), "MONEY_VARIANCE_EVIDENCE");
  const ppa = await h.run("createCorrection", { op: "ppa_package", opened_event_id: opened.id, kind: "upb", evidence_document_ids: ["doc-purchase-advice", "doc-establishment-check"] });
  assert.equal(h.ofType("ppa.requested")[0]!.payload.kind, "position_variance"); assert.equal(h.ofType("escalation.created").filter((e) => e.payload.kind === "human_portal_task").length, 1);
  await h.refused(h.run("createCorrection", { op: "adopt_fnma_figure", opened_event_id: opened.id, adopted_value: "56000001", officer_approval_id: "appr-1", ppa_package_id: ppa.package_id }), "OFFICER_ADOPTS_FNMA_FIGURE");
  const adopted = await h.run("createCorrection", { op: "adopt_fnma_figure", opened_event_id: opened.id, adopted_value: "56000001", officer_approval_id: "appr-1", ppa_package_id: ppa.package_id }, OFFICER);
  assert.equal(adopted.resolved, true); assert.equal(firstLarGate(h.events, LOAN).held, false);
  // rule 12 states a ±$0.05 UPB tolerance while T8 opens the variance on $560,000.01: at establishment the engine compares to the cent (T8);
  // rule 12's figure applies only when a caller passes it for an already-amortized position (spec discrepancy, reported)
  const store = new MemoryEventStore(h.clock); const expected = seedInvestorPosition(LOAN_ROW, ADVICE);
  const exact = establishmentCheck(store, { loan_id: LOAN, checked_at: et("2026-11-20", "07:00"), source: "lsdu_position", found: true, observed: { fnma_lpi_date: D("2026-12-01"), fnma_upb_cents: 56_000_001n, fnma_remittance_type: "AA", fnma_ptr: "5.875" }, expected, purchase_date: D("2026-11-19") });
  assert.equal(exact.status, "position_variance"); assert.equal(exact.row.variance!.upb_diff_cents, 1n);
  const within = establishmentCheck(store, { loan_id: "L-amortized", checked_at: et("2026-11-20", "07:00"), source: "lsdu_position", found: true, observed: { fnma_lpi_date: D("2026-12-01"), fnma_upb_cents: 56_000_000n + UPB_TOLERANCE_CENTS, fnma_remittance_type: "AA", fnma_ptr: "5.875" }, expected: { ...expected, loan_id: "L-amortized" }, purchase_date: D("2026-11-19"), upb_tolerance_cents: UPB_TOLERANCE_CENTS });
  assert.equal(within.status, "established"); assert.equal(within.row.variance!.upb_diff_cents, 5n);
  const beyond = establishmentCheck(store, { loan_id: "L-other", checked_at: et("2026-11-20", "07:00"), source: "lsdu_position", found: true, observed: { fnma_lpi_date: D("2026-12-01"), fnma_upb_cents: 56_000_006n, fnma_remittance_type: "AA", fnma_ptr: "5.875" }, expected: { ...expected, loan_id: "L-other" }, purchase_date: D("2026-11-19"), upb_tolerance_cents: UPB_TOLERANCE_CENTS });
  assert.equal(beyond.status, "position_variance");
});

test("30.1-T9: Given the Purchase Advice shows remittance type S/A while the commitment says A/A, then no LAR is projected until the variance is resolved and the decision record cites C1-3-01.", async () => {
  const h = harness(et("2026-11-19", "10:00"));
  h.adviceReceived();
  const out = await h.run("matchPurchaseAdvice", { loan: loanInput(), advice: adviceInput({ remittance_type: "SA" }) });
  assert.equal(out.ok, false); assert.equal(out.loan, null, "no silent overwrite");
  const v = out.variance as { kind: string; citation: string; money: boolean };
  assert.equal(v.kind, "remittance_type"); assert.ok(v.citation.includes("C1-3-01")); assert.equal(v.money, false);
  assert.equal(h.rt.store.get("loans", LOAN), undefined); assert.equal(h.ofType("loan.investor_updated").length, 0);
  await h.refused(h.run("matchPurchaseAdvice", { loan: loanInput(), advice: adviceInput({ remittance_type: "SA" }), overwrite_remittance_type: true }), "REMITTANCE_TYPE_OVERWRITE");
  h.purchased(); h.at(et("2026-11-20", "09:00"));
  const pr = await h.run("projectEvent", { op: "first_lar", ...h.firstLar });
  assert.equal(pr.held, true); assert.ok((pr.hold_reasons as string[])[0]!.includes("remittance_type"));
  await assert.rejects(h.run("submitBatch", { op: "lar", ...h.firstLar, submission_id: "lsdu-b2b-0001" }), /FIRST_LAR_HELD/);
  await h.refused(h.run("projectEvent", { op: "first_lar", ...h.firstLar, submit: true, variance_open: true }), "NO_LAR_WITH_OPEN_VARIANCE");
  const record = setupDecisionRecord(h.events, LOAN, null) as { variances: { kind: string; citation: string; resolved: boolean }[] };
  assert.equal(record.variances[0]!.kind, "remittance_type"); assert.ok(record.variances[0]!.citation.includes("C1-3-01")); assert.equal(record.variances[0]!.resolved, false);
  const pure = purchaseUpdate(new MemoryEventStore(h.clock), { loan: LOAN_ROW, advice: { ...ADVICE, remittance_type: "SA" }, now: et("2026-11-19", "10:00") });
  assert.equal(pure.ok, false); assert.equal(pure.variance!.kind, "remittance_type");
  // resolved on the commitment record → the advice is re-matched and the LAR may be projected
  const opened = h.ofType("position_variance.opened")[0]!;
  await h.run("createCorrection", { op: "resolve_variance", opened_event_id: opened.id, resolution: "commitment_confirmed", evidence_document_ids: ["doc-commitment-29-1", "doc-fnma-confirmation"] });
  assert.equal(firstLarGate(h.events, LOAN).held, false);
  const fixed = await h.run("matchPurchaseAdvice", { loan: loanInput(), advice: adviceInput({ advice_id: "PA-2026-11-19-0001-corrected" }) });
  assert.equal(fixed.ok, true); assert.equal((await h.run("projectEvent", { op: "first_lar", ...h.firstLar })).held, false);
});

test("30.1-T10: Given the January payment ($3,402.62) is processed Wed Dec 30, 2026, then the LAR with LPI 0127, UPB `0005594557A`, interest `0000027416G`, principal `0000005442I` is submitted by Thu Dec 31 20:00 ET and a CRS 001 request for $3,285.96 is prepared the same day (5.2).", async () => {
  const jan = paymentLar({ servicer_number: SERVICER, fnma_loan_number: FNMA_LOAN, prior_upb_cents: 56_000_000n, prior_lpi_date: D("2026-12-01"), note_rate_pct: "6.125", ptr_pct: "5.875", payment_cents: 340_262n, processed_at: et("2026-12-30", "10:00"), open_periods: ["2026-12"] });
  assert.equal(jan.lar.fields.lpi, "0127"); assert.equal(jan.lar.fields.upb, "0005594557A"); assert.equal(jan.lar.fields.interest, "0000027416G"); assert.equal(jan.lar.fields.principal, "0000005442I"); assert.equal(jan.lar.fields.action_code, "00"); assert.equal(jan.lar.fields.action_date, "123026");
  assert.equal(jan.due_on, "2026-12-31"); assert.equal(new Date(jan.due_at_ms).toISOString(), et("2026-12-31", "20:00")); assert.equal(jan.activity_period, "2026-12");
  assert.equal(jan.remittance.fnma_interest_cents, 274_167n); assert.equal(jan.remittance.principal_cents, 54_429n); assert.equal(jan.remittance.remittance_cents, 328_596n); assert.equal(jan.new_upb_cents, 55_945_571n); assert.equal(jan.new_lpi_date, "2027-01-01");
  assert.equal(jan.remittance.servicing_fee_cents, 285_833n - 274_167n);
  assert.deepEqual(jan.crs, { instruct: true, settlement_date: D("2026-12-31"), code: "001" });
  const h = harness(et("2026-12-30", "10:00"));
  const out = await h.run("projectEvent", { op: "payment_lar", servicer_number: SERVICER, fnma_loan_number: FNMA_LOAN, prior_upb_cents: "56000000", prior_lpi_date: "2026-12-01", note_rate_pct: "6.125", ptr_pct: "5.875", payment_cents: "340262", processed_at: et("2026-12-30", "10:00"), open_periods: ["2026-12"] });
  assert.equal((out.fields as Record<string, string>).upb, "0005594557A"); assert.equal(out.due_at, et("2026-12-31", "20:00")); assert.equal(out.remittance_cents, "328596"); assert.equal((out.crs as { code: string }).code, "001");
});

test("30.1-T11: Given a non-escrowed loan, then no Escrow Setup event is created and `escrow_setup_acked` is reached on `first_lar_accepted`.", async () => {
  const h = harness(et("2026-11-19", "10:00"));
  h.adviceReceived(); await h.run("matchPurchaseAdvice", { loan: loanInput({ escrowed: false }), advice: adviceInput() }); h.purchased({ escrowed: false });
  const cancelled = await h.run("createCorrection", { op: "timer_cancel_inapplicable", loan: loanInput({ escrowed: false }) });
  assert.deepEqual((cancelled.cancelled as { code: string }[]).map((c) => c.code), ["LL_2026_05_ESCROW_SETUP_ORIG_PURCHASE_BD1", "SM_ENOTE_POST_PURCHASE_VERIFY_1BD"], "no Setup event for a non-escrowed loan; no eRegistry state for a paper note");
  assert.equal(h.timer("LL_2026_05_ESCROW_SETUP_ORIG_PURCHASE_BD1")!.status, "cancelled");
  const plan = await h.run("projectEvent", { op: "escrow_setup", purchase_date: "2026-11-19", visibility_observed_on: "2026-11-20", escrowed: false, categories: [] });
  assert.equal(plan.required, false); assert.deepEqual(plan.events, []);
  await assert.rejects(h.run("submitBatch", { op: "escrow_setup", purchase_date: "2026-11-19", visibility_observed_on: "2026-11-20", escrowed: false, categories: [] }), /no Escrow Setup event is due/);
  h.at(et("2026-11-20", "07:00"));
  await h.run("checkFnmaEstablishment", { source: "lsdu_position", found: true, observed: { fnma_lpi_date: "2026-12-01", fnma_upb_cents: "56000000", fnma_remittance_type: "AA", fnma_ptr: "5.875" }, expected: POSITION, purchase_date: "2026-11-19" });
  h.at(et("2026-11-23", "10:00")); await h.run("submitBatch", { op: "lar", ...h.firstLar, submission_id: "lsdu-b2b-0002" });
  h.at(et("2026-11-23", "16:00"));
  const acc = await h.run("pollFeedback", { op: "lar", submission_id: "lsdu-b2b-0002", fnma_response_id: "fb-0002", escrow_setup_required: false });
  assert.equal(acc.status, "escrow_setup_acked"); assert.equal(h.rt.store.get("loans", LOAN)!.data.investor_setup_status, "escrow_setup_acked");
  assert.equal(h.ofType("escrow.setup_event.sent").length, 0); assert.equal(h.ofType("investor_setup.escrow_setup_acked")[0]!.payload.basis, "no_escrow_setup_event");
  assert.equal(investorSetupStatus(h.events, LOAN, { escrowed: false, escrow_events_on: true, note_form: "paper", mers_registered: true }).status, "escrow_setup_acked");
});

test("30.1-T12: Given all sub-steps complete by Tue Nov 24, 2026, then `loan.reporting_active` is emitted and `SM_INVESTOR_SETUP_COMPLETE_5BD` (due Fri Nov 27 — servicer calendar) is satisfied.", async () => {
  const h = harness(et("2026-11-19", "09:00"));
  await h.throughEstablishment();
  const rollup = h.timer("SM_INVESTOR_SETUP_COMPLETE_5BD")!;
  assert.equal(rollup.dueDate, "2026-11-27", "5 business_days_servicer from Nov 19: Nov 20, 23, 24, 25, 27 (Thanksgiving excluded; the servicer works Nov 27)");
  assert.equal(h.timer("SM_CUSTODY_RECORD_FINALIZE_1BD")!.dueDate, "2026-11-20");
  h.at(et("2026-11-20", "09:00"));
  await h.run("submitBatch", { op: "custody_finalize", note_form: "paper", certification_status: "certified", custodian_party_id: "party-custodian-2017", certified_on: "2026-11-18" });
  assert.equal(h.timer("SM_CUSTODY_RECORD_FINALIZE_1BD")!.status, "satisfied"); assert.deepEqual([h.rt.store.get("custody_records", LOAN)!.data.certification_status, h.rt.store.get("custody_records", LOAN)!.data.code_type, h.rt.store.get("custody_records", LOAN)!.data.note_location], ["certified", "none", "custodian"]);
  await h.run("submitBatch", { op: "escrow_setup", purchase_date: "2026-11-19", visibility_observed_on: "2026-11-20", categories: [{ category: "ti", balance_cents: "206250" }] });
  h.at(et("2026-11-20", "14:00")); h.proceeds("2026-11-20"); h.repaid("2026-11-20");
  const sched = await h.run("submitBatch", { op: "custodial_transfer", proceeds_received_at: et("2026-11-20", "14:00"), balances: { ti_escrow_balance_cents: "206250" }, fnma_ti_account_id: FNMA_TI, fnma_pi_account_id: FNMA_PI });
  h.at(et("2026-11-20", "18:00")); await h.run("pollFeedback", { op: "escrow_setup", category: "ti", fnma_response_id: "sp-resp-0001" });
  assert.equal((await h.run("pollFeedback", { op: "setup" })).reporting_active, false, "the roll-up waits for every sub-step");
  h.at(et("2026-11-23", "10:00")); await h.run("submitBatch", { op: "lar", ...h.firstLar, submission_id: "lsdu-b2b-0001" });
  const posted = await h.run("submitBatch", { op: "book_transfer", row: (sched.rows as Record<string, unknown>[])[0], transferred_at: et("2026-11-23", "10:00"), bank_reference: "BT-1" });
  await h.run("pollFeedback", { op: "bank_feed", row: posted.row, credits: [{ amountCents: "206250", bankReference: "BT-1", text: "BOOK TRANSFER" }] });
  const batch = await h.run("submitBatch", { op: "mers_min_update", min: MIN, repaid_on: "2026-11-20" });
  h.at(et("2026-11-23", "16:00")); await h.run("pollFeedback", { op: "lar", submission_id: "lsdu-b2b-0001", fnma_response_id: "fb-0001" });
  h.at(et("2026-11-23", "22:00")); await h.run("pollFeedback", { op: "mers_ack", txn: batch.txn, batch_id: batch.batch_id, accepted: true, min: MIN });
  h.at(et("2026-11-24", "07:00"));
  await h.run("pollFeedback", { op: "mers_snapshot", min: MIN, snapshot_on: "2026-11-24", purchase_date: "2026-11-19", partner_org_id: PARTNER_ORG, snapshot: { status: "active", investor_org_id: FANNIE_MAE_ORG_ID, servicer_org_id: PARTNER_ORG, subservicer_org_id: SUPERMORTGAGE_ORG_ID, interim_funder_org_id: null } });
  h.at(et("2026-11-24", "09:00"));
  const done = await h.run("pollFeedback", { op: "setup" });
  assert.equal(done.status, "reporting_active"); assert.deepEqual(done.pending, []); assert.equal(done.reporting_active, true);
  const active = h.ofType("loan.reporting_active")[0]!;
  assert.equal(active.payload.completed_on, "2026-11-24"); assert.equal(active.payload.days_to_reporting_active, 5);
  assert.equal(rollup.status, "satisfied"); assert.equal(rollup.satisfiedByEventId, active.id);
  assert.equal(h.rt.store.get("loans", LOAN)!.data.investor_setup_status, "reporting_active");
  const reg = loadOverriddenRegistry(); const own = new Set(reg.forProcess("30.1").map((t) => t.code).filter((c) => reg.get(c)!.process === "30.1"));   // 27.2's referenced PPA window stays open for 30 days
  assert.deepEqual(h.timers.forSubject("loan", LOAN).filter((t) => t.status === "armed" && own.has(t.code)).map((t) => t.code), [], "every 30.1 clock closed by Nov 24");
  const line = postPurchaseSetupLine(h.events, LOAN, h.timers.forSubject("loan", LOAN));
  assert.deepEqual([line.first_lar_status, line.setup_event_status, line.custodial_transfer_status, line.mers_verified, line.days_to_reporting_active], ["accepted", "acked", "matched", true, 5]);
  assert.equal((await h.run("pollFeedback", { op: "setup" })).reporting_active, true, "idempotent: the existing loan.reporting_active is returned"); assert.equal(h.ofType("loan.reporting_active").length, 1);
});

test("30.1 worked figures: purchase-month interest deduction ($1,096.67 / $1,081.64 on 12 days at 5.875%), the January LAR ($2,741.67 interest, $544.29 principal, UPB $559,455.71, A/A remittance $3,285.96 on $560,000.00), the T&I Setup event ($2,062.50) and the $0.05 UPB tolerance", () => {
  const ded = purchaseMonthInterestDeduction(56_000_000n, "5.875", D("2026-11-19"), D("2026-12-01"));
  assert.equal(ded.days, 12, "Nov 19–30");
  assert.equal(ded.cents_360, 109_667n, "$1,096.67 = 12 × 560,000 × 5.875% ÷ 360");
  assert.equal(ded.cents_365, 108_164n, "$1,081.64 on a 365 basis");
  const jan = paymentLar({ servicer_number: SERVICER, fnma_loan_number: FNMA_LOAN, prior_upb_cents: 56_000_000n, prior_lpi_date: D("2026-12-01"), note_rate_pct: "6.125", ptr_pct: "5.875", payment_cents: 340_262n, processed_at: et("2026-12-30", "10:00"), open_periods: ["2026-12"] });
  assert.equal(jan.remittance.fnma_interest_cents, 274_167n, "$2,741.67 = 560,000 × 5.875% ÷ 12");
  assert.equal(jan.remittance.note_interest_cents, 285_833n, "note interest 560,000 × 6.125% ÷ 12");
  assert.equal(jan.remittance.principal_cents, 54_429n, "$544.29 = 3,402.62 − 2,858.33");
  assert.equal(jan.new_upb_cents, 55_945_571n, "$559,455.71 = 560,000.00 − 544.29");
  assert.equal(jan.remittance.remittance_cents, 328_596n, "$3,285.96 = 2,741.67 + 544.29 > $2,500 → CRS 001");
  assert.equal(firstLarProjection({ servicer_number: SERVICER, fnma_loan_number: FNMA_LOAN, position: seedInvestorPosition(LOAN_ROW, ADVICE), purchase_date: D("2026-11-19"), established_at: D("2026-11-20") }).payload.upb_cents, 56_000_000n, "$560,000.00 on the first LAR (0005600000{)");
  assert.equal(escrowSetupPlan({ loan_id: LOAN, escrowed: true, flag_on: true, categories: [{ category: "ti", balance_cents: 206_250n }], purchase_date: D("2026-11-19"), visibility_observed_on: D("2026-11-20") }).events[0]!.amount_cents, 206_250n, "$2,062.50 T&I balance (30.3)");
  assert.equal(UPB_TOLERANCE_CENTS, 5n, "$0.05 (rule 12)");
});
