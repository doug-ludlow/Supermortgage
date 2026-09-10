// 6.2 Establish T&I custodial account (Form 1014)
// spec/sections/06-custodial-account-management/6-2-establish-t-i-custodial-account-form-1014.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { SECTION_06_TOOLS } from "../../app/tools/section06.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { NoticeRegistry } from "../../notices/registry.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { publishSection06 } from "../../notices/authored/section06.ts";
import { depositGate, disposeInterest, statutoryEscrowInterest, interestDispositionDueMs } from "./accounts.ts";
import { ET, interestDispositionStatus, interestDispositionPostings, tiUnmatchedDebit, tiTransferMatrixViolation, postingSetBalanced } from "./ops.ts";
import { tiCompositionSnapshot, form496A } from "./reconciliation.ts";
import { planTiAccounts, form1014InEffect, tiDepositGateCheck, ingestTiStatementLine, receivePurchaseProceeds, disposeInterestCredit, interestDisbursedIfSettled, handleInterestDisbursementBreach, openEscrowAccount, nextInterestCreditDate, interestPendingRef, tiTitleF103, isInterestCredit, type TiOps, type TiStatementLine } from "./ops-6-2.ts";

const at = (d: string, t: string) => toIso(zonedEpochMs(D(d), t, ET));
const RECON: Actor = { kind: "agent", id: "custodial-recon" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const REG = loadOverriddenRegistry();
function uow(nowIso = "2026-10-28T14:00:00.000Z", processes = ["6.2"]): UowContext & { decisions: DecisionInput[]; clock: FixedClock } {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  return { loanId: "L-1", events, ledger: new MemoryLedger(), timers: new TimerEngine(loadOverriddenRegistry(), events, { processes }), clock, decide: (d) => { decisions.push({ loanId: "L-1", ...d }); }, decisions };
}
function bus(ctx: UowContext) { const agents = new AgentRegistry(); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} }; const cmds = bindTools(rt, agents, SECTION_06_TOOLS); return { bus: new CommandBus(agents), cmds, rt }; }
/** The 6.2 emitters run inside the unit of work: the event spine, the ledger, the timer engine, the escalation queue and the decision log. */
const tiOps = (ctx: ReturnType<typeof uow>, rt: ToolRuntime, actor: Actor = RECON): TiOps => ({ events: ctx.events, ledger: ctx.ledger, actor, get now() { return ctx.clock.now(); }, escalations: rt.escalations, timers: ctx.timers, decide: (d) => ctx.decide(d) });
const line = (scope: "custodial" | "corporate" | "loan", account: string, amountCents: bigint, id = "C-TI-MAIN") => ({ account: scope === "custodial" ? { scope, custodialAccountId: id, account } : scope === "loan" ? { scope, loanId: id, account } : { scope, account }, amountCents, ruleRef: "6.2 rule 2" });
const cash = (ctx: UowContext, id = "C-TI-MAIN") => ctx.ledger.balance({ scope: "custodial", custodialAccountId: id, account: "custodial_ti_cash" });
const corporate = (ctx: UowContext, account: "corporate_cash" | "advance_receivable") => ctx.ledger.balance({ scope: "corporate", account });
/** 312 NY loans whose statutory interest sums to the worked example's 98,765 cents. */
const allocations = (total: bigint, n: number) => Array.from({ length: n }, (_, i) => ({ loan_id: `NY-${i + 1}`, statutory_cents: i === n - 1 ? total - (total / BigInt(n)) * BigInt(n - 1) : total / BigInt(n), state: "NY" }));
/** The bank's interest line for the worked example: $1,234.56 credited 2026-09-30 to the main T&I account (BAI2 interest family). */
const INTEREST_LINE: TiStatementLine = { id: "BSL-0930-INT", amount_cents: 123_456n, value_date: D("2026-09-30"), type_code: "354", direction: "credit" };
const creditTheInterest = (o: TiOps) => { const r = ingestTiStatementLine(o, { custodial_account_id: "C-TI-MAIN", account_kind: "ti", line: INTEREST_LINE }); if (r.kind !== "interest_credit") throw new Error(r.kind); return r; };

test("6.2-T1: Given a Form 1014 In Effect for {A/A, S/A} only, when an S/S loan boards with escrow, then the deposit is blocked by `FNMA_F103_FORM1014_IN_EFFECT_GATE` and a Change/Replace task is created.", () => {
  const g = depositGate({ status: "in_effect", kind: "1014", remittance_types: ["A/A", "S/A"] }, "S/S");
  assert.equal(g.ok, false);
  if (!g.ok) { assert.equal(g.gate, "FNMA_F103_FORM1014_IN_EFFECT_GATE"); assert.match(g.reason, /does not cover S\/S/); assert.deepEqual(g.task, { kind: "human_portal_task", role: "fnma_portal_operator", action: "cbam_change_replace", form_kind: "1014", add_remittance_types: ["S/S"] }); }
  assert.equal(depositGate({ status: "in_effect", kind: "1014", remittance_types: ["A/A", "S/A", "S/S"] }, "S/S").ok, true);
  assert.equal(depositGate({ status: "in_effect", kind: "1014", remittance_types: ["A/A", "S/A"] }, "A/A").ok, true);
  // the gate in the engine: planning the T&I accounts arms it per account; the executed Form 1014 opens it for the account it names
  const ctx = uow("2026-09-15T14:00:00.000Z"); const b = bus(ctx); const o = tiOps(ctx, b.rt);
  assert.throws(() => planTiAccounts(o, { arrangement_id: "ARR-1", portfolio: [] }), RangeError);
  const plan = planTiAccounts(o, { arrangement_id: "ARR-1", portfolio: [{ remittance_type: "S/S" }, { remittance_type: "A/A" }, { remittance_type: "S/A" }, { remittance_type: "A/A" }] });
  assert.deepEqual(plan.accounts.map((a) => a.account_kind), ["ti", "ti_unapplied", "ti_loss_draft"], "default layout: main + unapplied + loss drafts, buydown in main (open question 1)");
  assert.deepEqual(plan.accounts[0]!.remittance_types, ["A/A", "S/A", "S/S"], "one Form 1014 carries every remittance type in the portfolio (open question 4)");
  assert.equal(plan.accounts[0]!.title, "Supermortgage, as agent and/or trustee for the benefit of Fannie Mae and payments of various mortgagors, respectively (Custodial Account)", "F-1-03 T&I title, verbatim");
  assert.equal(tiTitleF103("Acme Subservicing LLC").startsWith("Acme Subservicing LLC, as agent and/or trustee"), true);
  const def = REG.get("FNMA_F103_FORM1014_IN_EFFECT_GATE")!; assert.ok(plan.events.every((e) => eventMatches(def.triggerPattern!, e)));
  const gates = ctx.timers.byCode("FNMA_F103_FORM1014_IN_EFFECT_GATE"); assert.equal(gates.length, 3);
  assert.ok(gates.every((t) => t.status === "armed" && t.dueDate === undefined && t.subject.kind === "custodial_account"), "a not_before_gate: armed with no due date until the form is in effect");
  // while the executed form is only fully signed, a deposit is blocked with a signature-chase task
  const early = tiDepositGateCheck(o, { custodial_account_id: "ARR-1:ti", loan_id: "L-AA", remittance_type: "A/A", form: { status: "fully_signed", remittance_types: ["A/A", "S/A"] } });
  assert.equal(early.ok, false); if (!early.ok) { assert.equal(early.gate, "FNMA_F103_FORM1014_IN_EFFECT_GATE"); assert.equal(early.task?.action, "cbam_form_signature"); assert.equal(early.blocked, "escrow.deposit.initiated"); }
  assert.throws(() => form1014InEffect(o, { form_id: "F1014-1", custodial_account_id: "ARR-1:ti", remittance_types: ["A/A", "S/A"], executed_document_hash: null, effective_on: D("2026-09-15") }), /executed_document_hash/, "6.1 guardrail: no in_effect without the executed document hash");
  assert.throws(() => form1014InEffect(o, { form_id: "F1014-1", custodial_account_id: "ARR-1:ti", remittance_types: ["A/A", "S/A"], executed_document_hash: "sha256:9f2c", effective_on: D("2026-09-16") }), /not reached/);
  const fx = form1014InEffect(o, { form_id: "F1014-1", custodial_account_id: "ARR-1:ti", remittance_types: ["A/A", "S/A"], executed_document_hash: "sha256:9f2c", effective_on: D("2026-09-15"), portfolio_remittance_types: ["A/A", "S/A", "S/S"] });
  assert.equal(fx.covers_portfolio, false); assert.deepEqual(fx.uncovered_remittance_types, ["S/S"]); assert.ok(eventMatches(def.satisfiedPattern!, fx.event));
  const main = gates.find((t) => t.subject.id === "ARR-1:ti")!; assert.equal(main.status, "satisfied"); assert.equal(main.satisfiedByEventId, fx.event.id);
  assert.equal(gates.filter((t) => t.status === "armed").length, 2, "F-1-03: a separate Form 1014 for each custodial account — the sub-accounts stay gated");
  // an S/S loan boards with escrow → blocked by the gate, CBAM Change/Replace task to the portal operator
  const ss = tiDepositGateCheck(o, { custodial_account_id: "ARR-1:ti", loan_id: "L-SS", remittance_type: "S/S", form: { status: "in_effect", remittance_types: ["A/A", "S/A"] }, deposit_kind: "escrow.deposit.initiated" });
  assert.equal(ss.ok, false);
  if (!ss.ok) {
    assert.equal(ss.gate, "FNMA_F103_FORM1014_IN_EFFECT_GATE"); assert.match(ss.reason, /does not cover S\/S; Change\/Replace task required/); assert.equal(ss.blocked, "escrow.deposit.initiated");
    assert.deepEqual(ss.task, { kind: "human_portal_task", role: "fnma_portal_operator", action: "cbam_change_replace", form_kind: "1014", add_remittance_types: ["S/S"] });
    const esc = b.rt.escalations.opened.find((e) => e.id === ss.escalation_id)!; assert.equal(esc.kind, "human_portal_task"); assert.equal(esc.ownerRole, "fnma_portal_operator"); assert.equal(esc.loanId, "L-SS");
    assert.equal(esc.payload.task, "cbam_change_replace"); assert.deepEqual(esc.payload.add_remittance_types, ["S/S"]); assert.equal(esc.payload.gate, "FNMA_F103_FORM1014_IN_EFFECT_GATE");
    assert.equal(ss.event.type, "custodial.deposit.blocked"); assert.equal(ss.event.loanId, "L-SS"); assert.equal(ss.event.payload.remittance_type, "S/S");
  }
  assert.equal(tiDepositGateCheck(o, { custodial_account_id: "ARR-1:ti", loan_id: "L-AA", remittance_type: "A/A", form: { status: "in_effect", remittance_types: ["A/A", "S/A"] } }).ok, true, "an A/A loan on the same form deposits");
  const sub = tiDepositGateCheck(o, { custodial_account_id: "ARR-1:ti_unapplied", loan_id: "L-AA", remittance_type: "A/A", form: { status: "in_effect", remittance_types: ["A/A", "S/A", "S/S"] }, deposit_kind: "suspense.item.created" });
  assert.equal(sub.ok, false); if (!sub.ok) { assert.equal(sub.blocked, "suspense.item.created"); assert.match(sub.reason, /fully_signed/, "the engine's armed gate, not the caller's form row, decides"); }
  assert.equal(ctx.events.ofType("custodial.deposit.blocked").length, 3);
});
test('6.2-T2: Given interest of $1,234.56 credited 2026-09-30 with $45.00 fees and $987.65 statutory interest, when disposed, then postings equal $987.65 to borrowers, $45.00 fees, $201.91 corporate, timer satisfied on the final posting; cashbook composition returns to zero "interest pending."', () => {
  assert.deepEqual(disposeInterest(123_456n, 4_500n, 98_765n), { to_borrowers_cents: 98_765n, to_fees_cents: 4_500n, to_corporate_cents: 20_191n, corporate_funds_shortfall_cents: 0n });
  const r = interestDispositionPostings({ credit_id: "IC-1", custodial_account_id: "C-TI-MAIN", credited_on: D("2026-09-30"), amount_cents: 123_456n, admin_expense_cents: 4_500n, allocations: allocations(98_765n, 312), posted_on: D("2026-10-28") });
  assert.equal(r.disposition.to_borrowers_cents, 98_765n); assert.equal(r.disposition.to_fees_cents, 4_500n); assert.equal(r.disposition.to_corporate_cents, 20_191n);
  assert.ok(r.sets.every(postingSetBalanced), "every entry set balances");
  const lines = r.sets.flatMap((s) => s.lines);
  assert.equal(lines.filter((l) => l.account === "escrow_liability").reduce((a, l) => a + l.amount_cents, 0n), -98_765n); assert.equal(lines.filter((l) => l.account === "escrow_liability").length, 312);
  assert.equal(lines.filter((l) => l.account === "custodial_ti_cash:C-TI-MAIN").reduce((a, l) => a + l.amount_cents, 0n), 123_456n - 4_500n - 20_191n, "the borrowers' $987.65 stays in T&I; $45.00 + $201.91 leave for corporate");
  assert.equal(lines.filter((l) => l.account === "corporate_cash").reduce((a, l) => a + l.amount_cents, 0n), 24_691n);
  assert.equal(r.interest_pending_after_cents, 0n); assert.equal(r.on_time, true); assert.equal(toIso(r.due_at_ms), at("2026-10-30", "17:00")); assert.equal(r.timer_satisfied_by, "custodial.interest.disbursed"); assert.equal(r.escalation, null);
  // the registry timer: armed by the bank's interest line (statement parsing → `custodial.interest.credited`, anchor = bank credit date), satisfied by the final posting
  const ctx = uow("2026-09-30T20:00:00.000Z"); const b = bus(ctx); const o = tiOps(ctx, b.rt);
  assert.equal(isInterestCredit({ ...INTEREST_LINE, type_code: "195" }), false); assert.equal(isInterestCredit({ id: "BSL-camt", amount_cents: 1n, value_date: D("2026-09-30"), direction: "credit", bktxcd: "ACMT/MCOP/INTR" }), true, "camt.053 BkTxCd ACMT/…/INTR");
  const ing = creditTheInterest(o);
  assert.equal(ing.credit.amount_cents, 123_456n); assert.equal(ing.credit.credited_on, "2026-09-30"); assert.equal(ing.credit.disposition, "pending"); assert.equal(ing.disburse_by, "2026-10-30"); assert.equal(ing.misdirected, false);
  assert.equal(cash(ctx), 123_456n); assert.equal(ctx.ledger.balance(interestPendingRef("C-TI-MAIN")), -123_456n, "the credit sits in the interest-pending control until disposed");
  const def = REG.get("FNMA_A4102_TI_INTEREST_DISBURSE_30")!; assert.ok(eventMatches(def.triggerPattern!, ing.event));
  const t = ctx.timers.byCode("FNMA_A4102_TI_INTEREST_DISBURSE_30")[0]!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-09-30"); assert.equal(t.dueDate, "2026-10-30"); assert.equal(toIso(t.dueAt!), at("2026-10-30", "17:00"), "due_at = 2026-09-30 + 30 days = 2026-10-30T17:00 local");
  assert.throws(() => disposeInterestCredit(o, { credit: ing.credit, admin_expense_cents: -1n, allocations: allocations(98_765n, 312), posted_on: D("2026-10-28") }), RangeError);
  ctx.clock.set("2026-10-28T15:00:00.000Z");
  const d = disposeInterestCredit(o, { credit: ing.credit, admin_expense_cents: 4_500n, allocations: allocations(98_765n, 312), posted_on: D("2026-10-28"), jurisdiction_rule_versions: { NY: "GOL-5-601@2026" } });
  assert.deepEqual(d.disposition, { to_borrowers_cents: 98_765n, to_fees_cents: 4_500n, to_corporate_cents: 20_191n, corporate_funds_shortfall_cents: 0n });
  assert.equal(d.sets.length, 3, "borrower credits, fees, residual — the bank credit set was posted at ingestion");
  assert.equal(cash(ctx), 98_765n, "the borrowers' $987.65 stays in T&I"); assert.equal(corporate(ctx, "corporate_cash"), 24_691n, "$45.00 fees + $201.91 residual to corporate");
  assert.equal(ctx.ledger.balance({ scope: "corporate", account: "corporate_interest_income" as "corporate_cash" }), -20_191n); assert.equal(ctx.ledger.balance({ scope: "corporate", account: "corporate_bank_fee_recovery" as "corporate_cash" }), -4_500n);
  assert.equal(Array.from({ length: 312 }, (_, i) => ctx.ledger.balance({ scope: "loan", loanId: `NY-${i + 1}`, account: "escrow" })).reduce((a, v) => a + v, 0n), -98_765n, "312 escrow credits");
  assert.equal(d.interest_pending_after_cents, 0n); assert.equal(ctx.ledger.balance(interestPendingRef("C-TI-MAIN")), 0n); assert.equal(d.on_time, true); assert.equal(d.escalation_id, null);
  assert.ok(d.disbursed); assert.equal(d.disbursed!.payload.interest_pending_after_cents, 0n); assert.ok(eventMatches(def.satisfiedPattern!, d.disbursed!));
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, d.disbursed!.id, "timer satisfied on the final posting");
  assert.equal(d.credit.disposition, "mixed"); assert.equal(d.credit.disbursed_on, "2026-10-28"); assert.equal(d.credit.admin_expense_cents, 4_500n);
  assert.equal(d.escrow_credits.length, 312); assert.equal(d.escrow_credits[0]!.loanId, "NY-1"); assert.equal(d.escrow_credits[0]!.payload.category, "Taxes & Insurance"); assert.equal(d.escrow_credits[0]!.payload.reason, "interest credit");
  assert.equal(ctx.decisions.length, 1); assert.equal(ctx.decisions[0]!.action, "custodial.interest.dispose"); assert.equal(ctx.decisions[0]!.ruleCode, "A4-1-02");
  assert.deepEqual(JSON.parse(ctx.decisions[0]!.rationale), { interest_credit_id: "IC-BSL-0930-INT", E: "4500", to_borrowers: "98765", to_corporate: "20191", corporate_funds_shortfall: "0", loan_count: 312, jurisdiction_rule_versions: { NY: "GOL-5-601@2026" } });
  // cashbook composition (6.4 rule 1) returns to zero "interest pending"
  const snap = tiCompositionSnapshot({ period_end: D("2026-10-31"), escrow_accounts: allocations(98_765n, 312).map((a) => ({ loan_id: a.loan_id, balance_cents: -ctx.ledger.balance({ scope: "loan", loanId: a.loan_id, account: "escrow" }), contractual_payment_cents: 0n })), interest_pending_cents: -ctx.ledger.balance(interestPendingRef("C-TI-MAIN")) });
  assert.equal(snap.I, 0n); assert.equal(snap.P, 98_765n); assert.equal(snap.composition.L6, 0n); assert.equal(snap.composition.L7, cash(ctx), "custodial_ti_cash = escrow_liability once interest pending is zero");
  // the memo (CUST-TI-INT-DISP-v1) lists the allocation and the 30-day evidence
  const reg = new NoticeRegistry(); publishSection06(reg); const v = reg.activeVersion("CUST-TI-INT-DISP-v1", D("2026-10-28"))!;
  const payload = { ...v.samplePayload, ...d.memo.payload, interest_pending_after_cents: d.interest_pending_after_cents, days_credit_to_posting: 28 };
  const text = render(v.source, payload); assert.match(text.text, /Statutory escrow interest funded to 312 borrowers: \$987\.65\. Residual to corporate: \$201\.91/); assert.match(text.text, /interest pending after posting: \$0\.00/);
  assert.equal(evaluateChecklist(v, payload, text).passed, true);
});
test("6.2-T3: Given the same credit but statutory interest of $1,300.00, then `to_corporate = 0`, corporate funds $110.44 (1,300.00 − (1,234.56 − 45.00)), and an `officer` escalation records the funding.", async () => {
  assert.deepEqual(disposeInterest(123_456n, 4_500n, 130_000n), { to_borrowers_cents: 130_000n, to_fees_cents: 4_500n, to_corporate_cents: 0n, corporate_funds_shortfall_cents: 11_044n });
  const r = interestDispositionPostings({ credit_id: "IC-2", custodial_account_id: "C-TI-MAIN", credited_on: D("2026-09-30"), amount_cents: 123_456n, admin_expense_cents: 4_500n, allocations: allocations(130_000n, 312), posted_on: D("2026-10-29") });
  assert.equal(r.disposition.to_corporate_cents, 0n); assert.equal(r.disposition.corporate_funds_shortfall_cents, 11_044n);
  assert.deepEqual(r.escalation, { role: "officer", reason: "to_borrowers $1,300.00 > I − E $1,189.56: corporate funds $110.44" });
  const fund = r.sets.find((s) => /shortfall/.test(s.description))!; assert.ok(postingSetBalanced(fund)); assert.equal(fund.lines.find((l) => l.account === "corporate_expense_escrow_interest")!.amount_cents, 11_044n);
  assert.ok(!r.sets.flatMap((s) => s.lines).some((l) => /servicer_advance_receivable/.test(l.account)), "escrow interest is a servicer expense, never an advance receivable");
  assert.equal(r.interest_pending_after_cents, 0n);
  // the same credit through the engine: the disposition needs the officer's approval, the escalation records the funding, the timer is still satisfied on the final posting
  const ctx = uow("2026-09-30T20:00:00.000Z"); const b = bus(ctx); const o = tiOps(ctx, b.rt);
  const ing = creditTheInterest(o); const t = ctx.timers.byCode("FNMA_A4102_TI_INTEREST_DISBURSE_30")[0]!;
  ctx.clock.set("2026-10-29T15:00:00.000Z");
  assert.throws(() => disposeInterestCredit(o, { credit: ing.credit, admin_expense_cents: 4_500n, allocations: allocations(130_000n, 312), posted_on: D("2026-10-29") }), /corporate funding of the statutory-interest shortfall \$110\.44 is an officer decision/);
  assert.equal(ctx.ledger.sets().length, 1); assert.equal(ctx.events.ofType("custodial.interest.disbursed").length, 0); assert.equal(t.status, "armed");
  const d = disposeInterestCredit(tiOps(ctx, b.rt, OFFICER), { credit: ing.credit, admin_expense_cents: 4_500n, allocations: allocations(130_000n, 312), posted_on: D("2026-10-29"), officer_approval_id: "APR-77" });
  assert.equal(d.disposition.to_corporate_cents, 0n); assert.equal(d.disposition.corporate_funds_shortfall_cents, 11_044n); assert.equal(d.sets.length, 3, "shortfall funding, borrower credits, fees — no residual set");
  assert.equal(ctx.ledger.balance({ scope: "corporate", account: "corporate_expense_escrow_interest" as "corporate_cash" }), 11_044n); assert.equal(corporate(ctx, "corporate_cash"), 4_500n - 11_044n, "corporate receives the fees and funds the $110.44");
  assert.equal(cash(ctx), 130_000n, "T&I holds exactly the $1,300.00 owed to borrowers"); assert.equal(ctx.ledger.balance(interestPendingRef("C-TI-MAIN")), 0n);
  assert.equal(corporate(ctx, "advance_receivable"), 0n, "never servicer_advance_receivable");
  const esc = b.rt.escalations.opened.find((e) => e.id === d.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.ownerRole, "officer"); assert.equal(esc.severity, "medium");
  assert.equal(esc.payload.corporate_funds_shortfall_cents, 11_044n); assert.equal(esc.payload.to_corporate, 0n); assert.equal(esc.payload.to_borrowers, 130_000n); assert.equal(esc.payload.E, 4_500n); assert.equal(esc.payload.officer_approval_id, "APR-77"); assert.equal(esc.payload.ledger_account, "corporate_expense_escrow_interest");
  assert.equal(esc.payload.reason, "to_borrowers $1,300.00 > I − E $1,189.56: corporate funds $110.44");
  assert.ok(d.disbursed); assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, d.disbursed!.id); assert.equal(d.credit.disposition, "mixed", "borrowers + the $45.00 fee transfer to corporate; nothing residual");
  // the funding posting is an officer decision on the bus (6.2 escalations)
  const ctx2 = uow(); const b2 = bus(ctx2);
  const set = { effectiveDate: "2026-10-29", description: "corporate funds the statutory-interest shortfall", lines: [line("custodial", "custodial_ti_cash", 11_044n), line("corporate", "corporate_cash", -11_044n)] };
  await assert.rejects(b2.bus.execute(b2.cmds.get(toolKey("6.2", "ledger.post"))!, RECON, { entry_set: set, corporate_funds_shortfall: true }, ctx2), (e: unknown) => e instanceof CommandRefused && e.code === "CORPORATE_FUNDS_SHORTFALL");
  await b2.bus.execute(b2.cmds.get(toolKey("6.2", "ledger.post"))!, OFFICER, { entry_set: set, corporate_funds_shortfall: true }, ctx2);
  assert.equal(ctx2.ledger.sets().length, 1);
});
test('6.2-T4: Given no disposition by day 30, then breach → `officer` medium and the amount appears as an aged "Other" item on Form 496A.', () => {
  const s = interestDispositionStatus({ credited_on: D("2026-09-30"), amount_cents: 123456n, disposed_at_ms: null, now_ms: zonedEpochMs(D("2026-10-31"), "10:00", ET) });
  assert.equal(toIso(s.due_ms), toIso(zonedEpochMs(D("2026-10-30"), "17:00", ET))); assert.equal(s.status, "breached");
  assert.deepEqual(s.escalation, { role: "officer", severity: "medium" });
  assert.equal(s.form496a_item!.line, 6); assert.equal(s.form496a_item!.category, "Other"); assert.equal(s.form496a_item!.aging_days, 31); assert.equal(s.form496a_item!.amount_cents, 123456n);
  assert.equal(interestDispositionStatus({ credited_on: D("2026-09-30"), amount_cents: 123456n, disposed_at_ms: zonedEpochMs(D("2026-10-15"), "10:00", ET), now_ms: zonedEpochMs(D("2026-10-31"), "10:00", ET) }).status, "satisfied");
  // a disposition on day 35 clears the "Other" line but the breach stands (satisfied_late) with its officer escalation
  const late = interestDispositionStatus({ credited_on: D("2026-09-30"), amount_cents: 123456n, disposed_at_ms: zonedEpochMs(D("2026-11-04"), "10:00", ET), now_ms: zonedEpochMs(D("2026-11-05"), "10:00", ET) });
  assert.equal(late.status, "satisfied_late"); assert.deepEqual(late.escalation, { role: "officer", severity: "medium" }); assert.equal(late.form496a_item, null);
  assert.equal(toIso(interestDispositionDueMs(D("2026-09-30"))), at("2026-10-30", "17:00"));
  // the engine: armed by the bank credit, breached at 17:00 on day 30, escalated to the officer (medium), the amount on Form 496A line 6 "Other" with aging
  const ctx = uow("2026-09-30T20:00:00.000Z"); const b = bus(ctx); const o = tiOps(ctx, b.rt);
  const ing = creditTheInterest(o); const t = ctx.timers.byCode("FNMA_A4102_TI_INTEREST_DISBURSE_30")[0]!;
  assert.equal(ctx.timers.evaluate(at("2026-10-30", "16:59")).length, 0, "still armed a minute before the deadline"); assert.equal(t.status, "armed");
  const breaches = ctx.timers.evaluate(at("2026-10-31", "10:00")); assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, "FNMA_A4102_TI_INTEREST_DISBURSE_30"); assert.deepEqual(breaches[0]!.escalateTo, ["officer"]); assert.match(breaches[0]!.breachText, /`officer`, medium/);
  assert.equal(t.status, "breached"); assert.equal(ctx.events.ofType("timer.breached").length, 1);
  assert.throws(() => handleInterestDisbursementBreach(o, { code: "FNMA_F103_BOARDING_ESCROW_DEPOSIT_1BD", credit: ing.credit, now_ms: zonedEpochMs(D("2026-10-31"), "10:00", ET) }), RangeError);
  const h = handleInterestDisbursementBreach(o, { code: "FNMA_A4102_TI_INTEREST_DISBURSE_30", timer_id: t.id, credit: ing.credit, now_ms: zonedEpochMs(D("2026-10-31"), "10:00", ET) });
  assert.equal(h.status, "breached"); assert.deepEqual(h.escalation, { role: "officer", severity: "medium" });
  const esc = b.rt.escalations.opened.find((e) => e.id === h.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.ownerRole, "officer"); assert.equal(esc.severity, "medium"); assert.equal(esc.payload.timer_id, t.id); assert.equal(esc.payload.interest_credit_id, ing.credit.id); assert.equal(esc.payload.due_at, at("2026-10-30", "17:00"));
  assert.deepEqual(h.form496a_item, { line: 6, category: "Other", description: "interest credited 2026-09-30 pending disposition", amount_cents: 123_456n, aging_days: 31 });
  assert.equal(h.form496a_item!.amount_cents, -ctx.ledger.balance(interestPendingRef("C-TI-MAIN")), "the aged item is the undisposed interest-pending balance");
  assert.equal(form496A({ P: 0n, N: 0n, A: 0n, LD: 0n, U: 0n, BD: 0n, I: 0n, O: h.form496a_item!.amount_cents }).L6, 123_456n, "Form 496A line 6 carries the aged Other item");
  // the disposition on day 35 satisfies late: the item clears, the breach and its escalation stand
  ctx.clock.set("2026-11-04T15:00:00.000Z");
  const d = disposeInterestCredit(o, { credit: ing.credit, admin_expense_cents: 4_500n, allocations: allocations(98_765n, 312), posted_on: D("2026-11-04") });
  assert.equal(d.on_time, false); assert.ok(d.disbursed); assert.equal(d.disbursed!.payload.on_time, false); assert.equal(t.status, "satisfied_late");
  const h2 = handleInterestDisbursementBreach(o, { code: "FNMA_A4102_TI_INTEREST_DISBURSE_30", timer_id: t.id, credit: d.credit, now_ms: zonedEpochMs(D("2026-11-05"), "10:00", ET) });
  assert.equal(h2.status, "satisfied_late"); assert.deepEqual(h2.escalation, { role: "officer", severity: "medium" }); assert.equal(h2.form496a_item, null); assert.equal(ctx.ledger.balance(interestPendingRef("C-TI-MAIN")), 0n);
});
test("6.2-T5: Given a NY loan with $4,812.33 average balance for 30 days, then the statutory credit is 791 cents (rounding half-up from 791.06).", () => {
  assert.equal(statutoryEscrowInterest(481_233n, "2", 30), 791n);
  assert.equal(statutoryEscrowInterest(481_233n, "2", 31), 817n, "481,233 × 0.02 × 31 / 365 = 817.43 → 817");
});
test("6.2-T6: Given a debit on the T&I statement with no `disbursements` match within 1 BD, then exception `unmatched_debit` opens with severity high and the bank's positive-pay exception list is pulled.", () => {
  const debit = { id: "D-1", amount_cents: 215000n, value_date: D("2026-10-06"), type_code: "475" };
  const x = tiUnmatchedDebit({ debit, disbursements: [], as_of: D("2026-10-07") });
  assert.deepEqual(x.exception, { code: "unmatched_debit", severity: "high", amount_cents: 215000n, debit_id: "D-1" }); assert.ok(x.actions.includes("pull_positive_pay_exception_list"));
  assert.deepEqual(tiUnmatchedDebit({ debit, disbursements: [], as_of: D("2026-10-06") }).actions, ["wait_1bd"]);
  assert.equal(tiUnmatchedDebit({ debit, disbursements: [{ id: "chk-9", amount_cents: 215000n, date: D("2026-10-05") }], as_of: D("2026-10-07") }).exception, null);
  // the statement-line ingestion opens the exception on the account (high) once the business day has passed
  const ctx = uow("2026-10-06T20:00:00.000Z"); const b = bus(ctx); const o = tiOps(ctx, b.rt);
  const same = ingestTiStatementLine(o, { custodial_account_id: "C-TI-MAIN", account_kind: "ti", line: { ...debit, direction: "debit" }, disbursements: [] });
  assert.equal(same.kind, "debit"); if (same.kind === "debit") { assert.equal(same.unmatched.exception, null); assert.deepEqual(same.unmatched.actions, ["wait_1bd"]); assert.equal(same.event, null); }
  ctx.clock.set("2026-10-07T20:00:00.000Z");
  const next = ingestTiStatementLine(o, { custodial_account_id: "C-TI-MAIN", account_kind: "ti", line: { ...debit, direction: "debit" }, disbursements: [] });
  assert.equal(next.kind, "debit");
  if (next.kind === "debit") { assert.deepEqual(next.unmatched.exception, { code: "unmatched_debit", severity: "high", amount_cents: 215000n, debit_id: "D-1" }); assert.equal(next.event!.type, "reconciliation_item.opened"); assert.equal(next.event!.payload.category, "unmatched_debit"); assert.equal(next.event!.payload.severity, "high"); assert.ok((next.event!.payload.actions as string[]).includes("pull_positive_pay_exception_list")); }
  assert.equal(ingestTiStatementLine(o, { custodial_account_id: "C-TI-MAIN", account_kind: "ti", line: { ...debit, direction: "debit" }, disbursements: [{ id: "chk-9", amount_cents: 215000n, date: D("2026-10-05") }] }).kind === "debit" && ctx.events.ofType("reconciliation_item.opened").length, 1, "a matched debit opens nothing");
  assert.equal(ctx.ledger.sets().length, 0, "the debit side is 3.7/9.x's disbursement posting; 6.2 only validates the match");
});

test("6.2 timers — FNMA_F103_BOARDING_ESCROW_DEPOSIT_1BD: purchase proceeds received Fri 2026-10-09 → escrow balances and buydown funds in T&I by Tue 2026-10-13 (Mon 10-12 federal holiday); the matched T&I statement credit satisfies it, a P&I confirmation does not", () => {
  const ctx = uow("2026-10-09T18:00:00.000Z"); const b = bus(ctx); const o = tiOps(ctx, b.rt);
  assert.throws(() => receivePurchaseProceeds(o, { transfer_id: "T-1", received_on: D("2026-10-09"), amount_cents: 100_000n, escrow_balances_cents: 150_000n, custodial_account_id: "C-TI-MAIN" }), /do not cover/);
  const r = receivePurchaseProceeds(o, { transfer_id: "T-1", received_on: D("2026-10-09"), amount_cents: 250_000_000n, escrow_balances_cents: 12_345_600n, buydown_cents: 250_000n, custodial_account_id: "C-TI-MAIN", wire_reference: "FED-20261009-17" });
  assert.equal(r.deposit_due_on, "2026-10-13"); assert.equal(toIso(r.deposit_due_at_ms), at("2026-10-13", "17:00")); assert.equal(r.escrow_deposit_cents, 12_595_600n);
  const def = REG.get("FNMA_F103_BOARDING_ESCROW_DEPOSIT_1BD")!; assert.ok(eventMatches(def.triggerPattern!, r.event));
  const t = ctx.timers.byCode("FNMA_F103_BOARDING_ESCROW_DEPOSIT_1BD")[0]!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-09"); assert.equal(t.dueDate, "2026-10-13"); assert.deepEqual(t.subject, { kind: "transfer_in", id: "T-1" });
  ctx.events.append({ type: "custodial.deposit.confirmed", aggregate: { kind: "transfer_in", id: "T-1" }, actor: RECON, payload: { custodial_account_id: "C-PI-SS", account_kind: "pi", amount_cents: 100_000n } });
  assert.equal(t.status, "armed", "the row is satisfied by the T&I deposit only (account_kind=ti)");
  ctx.clock.set("2026-10-13T14:00:00.000Z");
  const ing = ingestTiStatementLine(o, { custodial_account_id: "C-TI-MAIN", account_kind: "ti", line: { id: "BSL-1013-WIRE", amount_cents: 12_595_600n, value_date: D("2026-10-13"), type_code: "195", direction: "credit" },
    pending_deposits: [{ id: "DEP-T-1", deposit_id: "DEP-T-1", amount_cents: 12_595_600n, date: D("2026-10-12"), source: "boarding_escrow", transfer_id: "T-1" }] });
  assert.equal(ing.kind, "deposit_confirmed"); if (ing.kind !== "deposit_confirmed") return;
  assert.equal(ing.deposit.deposit_id, "DEP-T-1"); assert.equal(ing.event.payload.account_kind, "ti"); assert.equal(ing.event.payload.source, "boarding_escrow"); assert.ok(eventMatches(def.satisfiedPattern!, ing.event));
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, ing.event.id);
  assert.equal(cash(ctx), 12_595_600n); assert.equal(ctx.ledger.balance({ scope: "custodial", custodialAccountId: "C-TI-MAIN", account: "transfer_in_clearing" }), -12_595_600n);
  assert.equal(ingestTiStatementLine(o, { custodial_account_id: "C-TI-MAIN", account_kind: "ti", line: { id: "BSL-1013-X", amount_cents: 777n, value_date: D("2026-10-13"), type_code: "195", direction: "credit" } }).kind, "credit_unmatched", "an unmatched credit is 6.3's bank_credit_unposted path");
  // a second transfer whose deposit lands on day 2 breaches first (officer, high), then satisfies late
  const r2 = receivePurchaseProceeds(o, { transfer_id: "T-2", received_on: D("2026-10-13"), amount_cents: 9_000_000n, escrow_balances_cents: 1_000_000n, custodial_account_id: "C-TI-MAIN" });
  assert.equal(r2.deposit_due_on, "2026-10-14"); const t2 = ctx.timers.byCode("FNMA_F103_BOARDING_ESCROW_DEPOSIT_1BD")[1]!;
  const br = ctx.timers.evaluate(at("2026-10-15", "09:00")); assert.equal(br.length, 1); assert.deepEqual(br[0]!.escalateTo, ["officer"]); assert.match(br[0]!.breachText, /`officer`, high/); assert.equal(t2.status, "breached");
  ingestTiStatementLine(o, { custodial_account_id: "C-TI-MAIN", account_kind: "ti", line: { id: "BSL-1015-WIRE", amount_cents: 1_000_000n, value_date: D("2026-10-15"), type_code: "195", direction: "credit" }, pending_deposits: [{ id: "DEP-T-2", deposit_id: "DEP-T-2", amount_cents: 1_000_000n, date: D("2026-10-15"), source: "boarding_escrow", transfer_id: "T-2" }] });
  assert.equal(t2.status, "satisfied_late");
});
test("6.2 timers — STATE_ESCROW_INTEREST_CREDIT_RECUR: a NY escrow account opened 2026-09-15 (annual cadence) arms the statutory credit for 2026-12-31, a TX account does not; the disposition's per-loan `escrow.interest.credited` satisfies it and re-arms the next cycle", () => {
  assert.equal(nextInterestCreditDate(D("2026-09-15"), "annual"), "2026-12-31"); assert.equal(nextInterestCreditDate(D("2026-09-15"), "quarterly"), "2026-09-30"); assert.equal(nextInterestCreditDate(D("2026-10-01"), "quarterly"), "2026-12-31");
  assert.equal(nextInterestCreditDate(D("2026-09-15"), "at_analysis", 3), "2027-03-31"); assert.equal(nextInterestCreditDate(D("2026-09-15"), "at_analysis", 9), "2026-09-30"); assert.throws(() => nextInterestCreditDate(D("2026-09-15"), "at_analysis"), RangeError);
  const ctx = uow("2026-09-15T14:00:00.000Z"); const b = bus(ctx); const o = tiOps(ctx, b.rt);
  assert.throws(() => openEscrowAccount(o, { loan_id: "NY-1", state: "New York", opened_on: D("2026-09-15"), escrow_interest: null }), RangeError);
  const ny = openEscrowAccount(o, { loan_id: "NY-1", state: "NY", opened_on: D("2026-09-15"), escrow_interest: { rate_pct: "2", frequency: "annual", rule_version: "NY GOL §5-601@2026" }, initial_balance_cents: 481_233n });
  assert.equal(ny.interest_state, true); assert.equal(ny.next_interest_credit_on, "2026-12-31"); assert.equal(ny.event.payload.interest_state, true); assert.equal(ny.event.payload.escrow_interest_rate_pct, "2");
  const tx = openEscrowAccount(o, { loan_id: "TX-1", state: "TX", opened_on: D("2026-09-15"), escrow_interest: null }); assert.equal(tx.interest_state, false); assert.equal(tx.next_interest_credit_on, null);
  const def = REG.get("STATE_ESCROW_INTEREST_CREDIT_RECUR")!; assert.ok(eventMatches(def.triggerPattern!, ny.event)); assert.equal(eventMatches(def.triggerPattern!, tx.event), false);
  const ts = ctx.timers.byCode("STATE_ESCROW_INTEREST_CREDIT_RECUR"); assert.equal(ts.length, 1, "only the interest state arms the recurring credit");
  assert.equal(ts[0]!.loanId, "NY-1"); assert.equal(ts[0]!.status, "armed"); assert.equal(ts[0]!.anchorDate, "2026-12-31"); assert.equal(ts[0]!.dueDate, "2026-12-31");
  // the December credit: the T&I bank interest funds NY-1's 791 cents (T5), posted 2027-01-05, carrying the next cycle
  ctx.clock.set("2026-12-31T22:00:00.000Z");
  const ing = ingestTiStatementLine(o, { custodial_account_id: "C-TI-MAIN", account_kind: "ti", line: { id: "BSL-1231-INT", amount_cents: 1_000n, value_date: D("2026-12-31"), type_code: "354", direction: "credit" } });
  if (ing.kind !== "interest_credit") throw new Error(ing.kind);
  ctx.clock.set("2027-01-05T15:00:00.000Z");
  const d = disposeInterestCredit(o, { credit: ing.credit, admin_expense_cents: 0n, allocations: [{ loan_id: "NY-1", statutory_cents: statutoryEscrowInterest(481_233n, "2", 30), state: "NY", next_interest_credit_on: nextInterestCreditDate(D("2027-01-01"), "annual") }], posted_on: D("2027-01-05") });
  assert.equal(d.escrow_credits.length, 1); assert.equal(d.escrow_credits[0]!.loanId, "NY-1"); assert.equal(d.escrow_credits[0]!.payload.amount_cents, 791n); assert.ok(eventMatches(def.satisfiedPattern!, d.escrow_credits[0]!));
  assert.equal(d.disposition.to_corporate_cents, 209n); assert.equal(ctx.ledger.balance({ scope: "loan", loanId: "NY-1", account: "escrow" }), -791n);
  assert.equal(ts[0]!.status, "satisfied"); assert.equal(ts[0]!.satisfiedByEventId, d.escrow_credits[0]!.id);
  const again = ctx.timers.byCode("STATE_ESCROW_INTEREST_CREDIT_RECUR"); assert.equal(again.length, 2); assert.equal(again[1]!.status, "armed"); assert.equal(again[1]!.loanId, "NY-1"); assert.equal(again[1]!.dueDate, "2027-12-31", "recurring: re-armed for the next statutory cycle");
});

test("6.2 guardrail — the ledger's allowed-transfer matrix is enforced on the accounts an entry set touches: P&I ↔ T&I commingling and borrower-to-borrower escrow moves are refused; the $201.91 corporate sweep and a tax payee disbursement post; `custodial.interest.disbursed` comes from the ledger's interest-pending balance, never from a caller's flag", async () => {
  assert.match(tiTransferMatrixViolation({ lines: [line("custodial", "custodial_pi_cash", 10_000n, "C-PI"), line("custodial", "custodial_ti_cash", -10_000n)] })!, /never commingle/);
  assert.match(tiTransferMatrixViolation({ lines: [line("loan", "escrow", 5_000n, "L-A"), line("loan", "escrow", -5_000n, "L-B")] })!, /between borrowers/);
  assert.match(tiTransferMatrixViolation({ lines: [line("corporate", "late_charge_income", 20_191n), line("custodial", "custodial_ti_cash", -20_191n)] })!, /corporate account late_charge_income/);
  assert.equal(tiTransferMatrixViolation({ lines: [line("corporate", "corporate_cash", 20_191n), line("custodial", "custodial_ti_cash", -20_191n)] }), undefined);
  assert.equal(tiTransferMatrixViolation({ lines: [line("loan", "escrow", 154_000n, "L-1"), line("custodial", "custodial_ti_cash", -154_000n)] }), undefined, "T&I → payee on the borrower's escrow");
  const ctx = uow(); const b = bus(ctx); const post = b.cmds.get(toolKey("6.2", "ledger.post"))!;
  await assert.rejects(b.bus.execute(post, RECON, { entry_set: { effectiveDate: "2026-10-28", description: "commingle", lines: [line("custodial", "custodial_pi_cash", 10_000n, "C-PI"), line("custodial", "custodial_ti_cash", -10_000n)] } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "TI_ALLOWED_TRANSFER_MATRIX");
  await assert.rejects(b.bus.execute(post, RECON, { entry_set: { effectiveDate: "2026-10-28", description: "borrower to borrower", lines: [line("loan", "escrow", 5_000n, "L-A"), line("loan", "escrow", -5_000n, "L-B")] } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_BORROWER_TO_BORROWER_ESCROW");
  await assert.rejects(b.bus.execute(post, OFFICER, { entry_set: { effectiveDate: "2026-10-28", description: "borrower to borrower", lines: [line("loan", "escrow", 5_000n, "L-A"), line("loan", "escrow", -5_000n, "L-B")] } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_BORROWER_TO_BORROWER_ESCROW", "no actor may override it");
  // a sweep that claims to be the final disposition, with no credit on the books, emits nothing
  await b.bus.execute(post, RECON, { entry_set: { effectiveDate: "2026-10-28", description: "residual interest to corporate", lines: [line("corporate", "corporate_cash", 20_191n), line("custodial", "custodial_ti_cash", -20_191n)] }, corporate_sweep: true, amount_cents: 20_191n, interest_fully_disbursed: true, interest_credit_id: "IC-1" }, ctx);
  assert.equal(ctx.ledger.sets().length, 1); assert.equal(ctx.events.ofType("custodial.interest.disbursed").length, 0, "a self-declared flag is not evidence of disbursement");
  // the credit, the fees, the borrower allocation, then the residual: only the posting that zeroes interest-pending emits the event
  const step = (description: string, lines: ReturnType<typeof line>[], extra: Record<string, unknown> = {}) => b.bus.execute(post, RECON, { entry_set: { effectiveDate: "2026-10-28", description, lines }, interest_credit_id: "IC-1", ...extra }, ctx);
  await step("bank interest credit IC-1", [line("custodial", "custodial_ti_cash", 123_456n), line("custodial", "interest_pending", -123_456n)]);
  await step("bank analysis fees to corporate", [line("custodial", "interest_pending", 4_500n), line("custodial", "custodial_ti_cash", -4_500n), line("corporate", "corporate_cash", 4_500n), line("corporate", "corporate_bank_fee_recovery", -4_500n)]);
  await step("statutory escrow interest to 1 borrower", [line("custodial", "interest_pending", 98_765n), line("loan", "escrow", -98_765n, "NY-1")]);
  assert.equal(ctx.events.ofType("custodial.interest.disbursed").length, 0); assert.equal(ctx.ledger.balance(interestPendingRef("C-TI-MAIN")), -20_191n);
  await step("residual interest to corporate", [line("custodial", "interest_pending", 20_191n), line("custodial", "custodial_ti_cash", -20_191n), line("corporate", "corporate_cash", 20_191n), line("corporate", "corporate_interest_income", -20_191n)], { corporate_sweep: true, amount_cents: 20_191n });
  const done = ctx.events.ofType("custodial.interest.disbursed"); assert.equal(done.length, 1); assert.equal(done[0]!.payload.interest_pending_after_cents, 0n); assert.equal(done[0]!.payload.interest_credit_id, "IC-1"); assert.equal(done[0]!.payload.custodial_account_id, "C-TI-MAIN"); assert.equal(done[0]!.payload.disbursed_on, "2026-10-28");
  assert.equal(ctx.ledger.balance(interestPendingRef("C-TI-MAIN")), 0n); assert.equal(ctx.ledger.sets().length, 5);
  assert.equal(interestDisbursedIfSettled({ events: ctx.events, ledger: ctx.ledger, actor: RECON, now: ctx.clock.now() }, { interest_credit_id: "IC-9", custodial_account_id: "C-TI-OTHER" }), null, "no credit on the books for that account: nothing to have disbursed");
  await assert.rejects(b.bus.execute(post, RECON, { entry_set: { effectiveDate: "2026-10-28", description: "large sweep", lines: [line("corporate", "corporate_cash", 1_000_001n), line("custodial", "custodial_ti_cash", -1_000_001n)] }, corporate_sweep: true, amount_cents: 1_000_001n }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "CORPORATE_SWEEP_10K");
});
