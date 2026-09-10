// 6.4 T&I custodial reconciliation (Form 496A)
// spec/sections/06-custodial-account-management/6-4-t-i-custodial-reconciliation-form-496a.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { SECTION_06_4_TOOLS } from "../../app/tools/section06.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { form496A, reconcile, tiCompositionSnapshot, escrowAdvanceFunding, staleCheckWorkflow, isStaleCheck, lossDraftAgedMonths, attestationVariance, attestationWindow, FORM_496A_TEMPLATE } from "./reconciliation.ts";
import { ET, paidNotIssued, form496TimerOutcome, attestationTieOut, generateCustodialForm, periodClosedEvent, lossDraftAgedItem, attestationGateEscalation, advanceDirectionViolation } from "./ops.ts";
import { detectNegativeEscrow, receiveLossDraft, disburseLossDraft, openAttestationWindow, checkAttestationGate } from "./ops-6-4.ts";

const at = (d: string, t: string) => toIso(zonedEpochMs(D(d), t, ET));
const RECON: Actor = { kind: "agent", id: "custodial-recon" };
function uow(nowIso = "2026-10-01T14:00:00.000Z", processes = ["6.4"]): UowContext & { decisions: DecisionInput[]; clock: FixedClock } {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  return { loanId: "L-1", events, ledger: new MemoryLedger(), timers: new TimerEngine(loadOverriddenRegistry(), events, { processes }), clock, decide: (d) => { decisions.push({ loanId: "L-1", ...d }); }, decisions };
}
/** The 6.4 tools bound on a bus (they join ALL_TOOLS once spec/registry/agents.json names them for 6.4). */
function bus(ctx: UowContext) { const agents = new AgentRegistry(); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} }; const cmds = bindTools(rt, agents, SECTION_06_4_TOOLS); return { bus: new CommandBus(agents), cmds, rt }; }
const SEPT_TI = { section_i: { bank_closing_ledger_cents: 880_894_690n, deposits_in_transit_cents: 3_120_000n, disbursements_in_transit_cents: 21_564_088n, adjustments_cents: 0n }, composition: { P: 861_200_411n, N: 3_895_012n, A: 3_895_012n, LD: 0n, U: 0n, BD: 1_230_000n, I: 20_191n, O: 0n }, cashbook_cents: 862_450_602n,
  section_iii: [{ id: "dit-1", category: "deposit_in_transit", amount_cents: 3_120_000n, loan_id: "ACH batch 9/30 (112 loans listed)", root_cause: "ACH escrow batch posted 9/30, bank credit 10/1", first_seen_on: D("2026-09-30"), evidence_refs: ["ach-batch-0930", "bai2-1001"] }, { id: "oc-1", category: "outstanding_check", amount_cents: -21_564_088n, loan_id: "37 checks (register attached)", root_cause: "tax/insurance checks issued, oldest 8/14, none stale", first_seen_on: D("2026-08-14"), evidence_refs: ["check-register-0930", "positive-pay-issued"] }] };
/** The worked example's escrow trial balance: 4,187 positive and 23 negative balances (P $8,612,004.11, N $38,950.12), Σ contractual $1,911,432.50 over 4,210 loans. */
function trialBalance() {
  const rows: { loan_id: string; balance_cents: bigint; contractual_payment_cents: bigint }[] = [];
  for (let i = 0; i < 4187; i++) rows.push({ loan_id: `L-${i + 1}`, balance_cents: i === 4186 ? 207_187n : 205_684n, contractual_payment_cents: 45_401n });
  for (let i = 0; i < 23; i++) rows.push({ loan_id: `N-${i + 1}`, balance_cents: -(i === 22 ? 169_356n : 169_348n), contractual_payment_cents: i === 22 ? 50_441n : 45_401n });
  return rows;
}
const negatives = () => trialBalance().filter((r) => r.balance_cents < 0n);

test("6.4-T1: Given the worked-example balances, when the monthly job runs, then L7 = $8,624,506.02, adjusted depository = $8,624,506.02, difference $0.00, xlsx/pdf generated and hashed.", async () => {
  const f = form496A(SEPT_TI.composition);
  assert.deepEqual([f.L1, f.L2, f.L3, f.L4, f.L5, f.L6, f.L7], [857_305_399n, 3_895_012n, 0n, 0n, 1_230_000n, 20_191n, 862_450_602n]);
  const r = reconcile(SEPT_TI.section_i, 862_450_602n, f.L7); assert.equal(r.balanced, true); assert.equal(r.adjusted_depository_cents, 862_450_602n); assert.equal(r.difference_cents, 0n);
  const g = generateCustodialForm({ kind: "496a", period: "2026-09", custodial_account_id: "C-TI-MAIN", servicer_number: "123456789", ...SEPT_TI, preparer_run_id: "run-prep", posting_run_ids: ["run-cashiering"], complete: true });
  assert.equal(g.form_kind, "monthly_form_496a"); assert.equal(g.total_cents, 862_450_602n); assert.equal(g.status, "completed");
  const c = FORM_496A_TEMPLATE.cell_map;
  assert.equal(g.workbook.cells[c["I.1"]!], "$8,808,946.90"); assert.equal(g.workbook.cells[c["I.2"]!], "$31,200.00"); assert.equal(g.workbook.cells[c["I.3"]!], "$215,640.88"); assert.equal(g.workbook.cells[c["I.5"]!], "$8,624,506.02"); assert.equal(g.workbook.cells[c["I.7"]!], "$0.00");
  assert.equal(g.workbook.cells[c["II.1"]!], "$8,573,053.99"); assert.equal(g.workbook.cells[c["II.2"]!], "$38,950.12"); assert.equal(g.workbook.cells[c["II.5"]!], "$12,300.00"); assert.equal(g.workbook.cells[c["II.6"]!], "$201.91"); assert.equal(g.workbook.cells[c["II.7"]!], "$8,624,506.02");
  assert.deepEqual(g.workbook.missing_fields, []); assert.match(g.xlsx_sha256, /^[0-9a-f]{64}$/); assert.match(g.pdf_sha256, /^[0-9a-f]{64}$/);
  // the 6.4 tool stores the workbook and PDF with their hashes and emits drafted + completed
  const ctx = uow(); const b = bus(ctx);
  const out = await b.bus.execute(b.cmds.get(toolKey("6.4", "form496a.generate"))!, RECON, { period: "2026-09", custodial_account_id: "C-TI-MAIN", servicer_number: "123456789", ...SEPT_TI, preparer_run_id: "run-prep", posting_run_ids: ["run-cashiering"], complete: true }, ctx);
  const o = out.output as { xlsx_sha256: string; pdf_sha256: string; generated_document_id: string; rendered_document_id: string; status: string };
  assert.equal(o.status, "completed"); assert.equal(b.rt.store.get("documents", o.generated_document_id)!.data.sha256, g.xlsx_sha256); assert.equal(b.rt.store.get("documents", o.rendered_document_id)!.data.sha256, g.pdf_sha256);
  assert.deepEqual(ctx.events.all().filter((e) => e.type.startsWith("custodial.reconciliation.")).map((e) => [e.type, e.payload.kind]), [["custodial.reconciliation.drafted", "monthly_form_496a"], ["custodial.reconciliation.completed", "monthly_form_496a"]]);
});
test("6.4-T2: Given 23 negative escrow balances totaling $38,950.12 and advances funded $30,000.00 at day close, then `escrow_advance_unfunded` item $8,950.12 and `SM_TI_ESCROW_ADVANCE_FUND_1BD` starts; when corporate funds next BD, then cleared.", async () => {
  const neg = negatives(); assert.equal(neg.length, 23); assert.equal(neg.reduce((s, n) => s - n.balance_cents, 0n), 3_895_012n);
  const open = escrowAdvanceFunding({ negatives: neg, advances_funded_cents: 3_000_000n, detected_on: D("2026-09-30"), funded_on: null, funded_cents: 0n });
  assert.equal(open.N, 3_895_012n); assert.equal(open.unfunded_cents, 895_012n); assert.equal(open.item!.category, "escrow_advance_unfunded"); assert.equal(open.item!.amount_cents, 895_012n); assert.equal(open.item!.loans.length, 23); assert.equal(open.item!.status, "open"); assert.equal(open.timer, "SM_TI_ESCROW_ADVANCE_FUND_1BD"); assert.equal(open.due_on, "2026-10-01");
  const funded = escrowAdvanceFunding({ negatives: neg, advances_funded_cents: 3_000_000n, detected_on: D("2026-09-30"), funded_on: D("2026-10-01"), funded_cents: 895_012n });
  assert.equal(funded.item!.status, "cleared"); assert.equal(funded.escalation, null);
  assert.deepEqual(escrowAdvanceFunding({ negatives: neg, advances_funded_cents: 3_000_000n, detected_on: D("2026-09-30"), funded_on: D("2026-10-02"), funded_cents: 895_012n }).escalation, { role: "officer", severity: "high" });
  assert.equal(form496A({ P: 0n, N: 3_895_012n, A: 3_000_000n, LD: 0n, U: 0n, BD: 0n, I: 0n, O: 0n }).advance_unfunded_cents, 895_012n);
  // the registry timer starts on detection and is satisfied by `ledger.post_advance` (corporate → T&I only)
  const ctx = uow("2026-09-30T21:00:00.000Z"); const b = bus(ctx);
  const agg = { kind: "custodial_account", id: "C-TI-MAIN" };
  // day close 9/30 (ops-6-4 detectNegativeEscrow): N − A = $8,950.12 unfunded opens the item and emits the trigger; a fully covered N emits nothing
  const ops = { events: ctx.events, actor: RECON, now: ctx.clock.now() };
  assert.equal(detectNegativeEscrow(ops, { custodial_account_id: "C-TI-MAIN", negatives: neg, advances_funded_cents: 3_895_012n }).event, null);
  assert.equal(ctx.timers.byCode("SM_TI_ESCROW_ADVANCE_FUND_1BD").length, 0, "covered negatives arm nothing");
  assert.throws(() => detectNegativeEscrow(ops, { custodial_account_id: "C-TI-MAIN", negatives: [{ loan_id: "P-1", balance_cents: 5n }], advances_funded_cents: 0n }), RangeError, "a non-negative balance is not a negative-balance flag");
  const det = detectNegativeEscrow(ops, { custodial_account_id: "C-TI-MAIN", negatives: neg, advances_funded_cents: 3_000_000n });
  assert.equal(det.unfunded_cents, 895_012n); assert.equal(det.detected_on, "2026-09-30"); assert.equal(det.event!.type, "escrow.balance.negative_detected"); assert.equal(det.event!.payload.unfunded_cents, 895_012n); assert.equal(det.event!.payload.fund_by, "2026-10-01");
  assert.deepEqual(ctx.events.ofType("reconciliation_item.opened").map((e) => [e.payload.category, e.payload.amount_cents, (e.payload.loans as string[]).length]), [["escrow_advance_unfunded", 895_012n, 23]]);
  const t = ctx.timers.byCode("SM_TI_ESCROW_ADVANCE_FUND_1BD")[0]!; assert.equal(t.dueDate, "2026-10-01"); assert.equal(t.anchorDate, "2026-09-30"); assert.deepEqual(t.subject, agg);
  const advance = (amount: bigint) => ({ effectiveDate: "2026-10-01", description: "corporate funds negative escrow balances", lines: [{ account: { scope: "custodial", custodialAccountId: "C-TI-MAIN", account: "custodial_ti_cash" }, amountCents: amount, ruleRef: "6.4 rule 2" }, { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -amount, ruleRef: "6.4 rule 2" }] });
  await assert.rejects(b.bus.execute(b.cmds.get(toolKey("6.4", "ledger.post_advance"))!, RECON, { entry_set: { ...advance(895_012n), lines: advance(895_012n).lines.map((l) => ({ ...l, amountCents: -l.amountCents })) }, aggregate: agg }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "CORPORATE_TO_TI_ONLY", "T&I → corporate is not an advance");
  assert.match(advanceDirectionViolation({ lines: [{ account: { scope: "loan", loanId: "L-A", account: "escrow" }, amountCents: 1n }, { account: { scope: "custodial", custodialAccountId: "C-TI-MAIN", account: "custodial_ti_cash" }, amountCents: -1n }] })!, /touches only corporate cash and custodial_ti_/);
  ctx.clock.set("2026-10-01T15:00:00.000Z");
  await b.bus.execute(b.cmds.get(toolKey("6.4", "ledger.post_advance"))!, RECON, { entry_set: advance(895_012n), aggregate: agg, reconciliation_item_id: "eau-1", loans: neg.map((n) => n.loan_id) }, ctx);
  assert.equal(t.status, "satisfied"); assert.equal(ctx.events.ofType("custodial.advance.funded")[0]!.payload.amount_cents, 895_012n); assert.deepEqual(ctx.events.ofType("reconciliation_item.resolved").map((e) => e.payload.status), ["funded"]);
});
test("6.4-T3: Given a loss draft received 2026-02-14 still held on 2026-09-30, then `loss_draft_aged_7m` item (age 7 months) requires loan number, age, amount, explanation before `approved`.", async () => {
  assert.equal(lossDraftAgedMonths(D("2026-02-14"), D("2026-09-30")), 7);
  const r = lossDraftAgedItem({ loan_id: "L-LD1", amount_cents: 1_350_000n, received_on: D("2026-02-14"), as_of: D("2026-09-30"), explanation: null });
  assert.equal(r.aged, true); assert.equal(r.age_months, 7); assert.deepEqual(r.required, ["loan_id", "age_months", "amount_cents", "explanation"]); assert.deepEqual(r.missing, ["explanation"]); assert.equal(r.approvable, false); assert.equal(r.insurance_property_status_request, true);
  const ok = lossDraftAgedItem({ loan_id: "L-LD1", amount_cents: 1_350_000n, received_on: D("2026-02-14"), as_of: D("2026-09-30"), explanation: "contractor final inspection pending; borrower notified 9/12" });
  assert.equal(ok.approvable, true); assert.equal(ok.item!.category, "loss_draft_aged_7m"); assert.equal(ok.item!.age_months, 7);
  assert.equal(lossDraftAgedItem({ loan_id: "L-LD2", amount_cents: 1n, received_on: D("2026-08-14"), as_of: D("2026-09-30"), explanation: null }).aged, false);
  // the monthly 496A cannot be `approved` while the aged item lacks its explanation
  const sub = { section_i: { bank_closing_ledger_cents: 12_150_000n, deposits_in_transit_cents: 0n, disbursements_in_transit_cents: 0n, adjustments_cents: 0n }, cashbook_cents: 12_150_000n, composition: { P: 0n, N: 0n, A: 0n, LD: 12_150_000n, U: 0n, BD: 0n, I: 0n, O: 0n }, preparer_run_id: "p", posting_run_ids: [] as string[] };
  const rework = generateCustodialForm({ kind: "496a", period: "2026-09", custodial_account_id: "C-TI-LD", ...sub, section_iii: [{ id: "ld-1", category: "loss_draft_aged_7m", amount_cents: 1_350_000n, loan_id: "L-LD1", root_cause: null, first_seen_on: D("2026-02-14"), evidence_refs: ["loss_draft_register"], age_months: 7 }] });
  assert.equal(rework.status, "rework"); assert.deepEqual(rework.review.findings, ["ld-1: no root cause"]);
  const approved = generateCustodialForm({ kind: "496a", period: "2026-09", custodial_account_id: "C-TI-LD", ...sub, section_iii: [ok.item!] });
  assert.equal(approved.status, "approved"); assert.match(approved.workbook.cells[FORM_496A_TEMPLATE.cell_map["III.loss_drafts_aged_7m"]!]!, /L-LD1.*contractor final inspection pending.*age_months=7/);
  // the registry flag (FNMA_F496A_LOSS_DRAFT_AGED_7M): the 9.7 register receipt (ops-6-4 receiveLossDraft) arms it on the receipt date; only the full `loss_draft.disbursed{full=true}` satisfies it
  const ctx = uow("2026-02-16T15:00:00.000Z"); const b = bus(ctx);
  const ops = { events: ctx.events, actor: RECON, now: ctx.clock.now(), store: b.rt.store };
  assert.throws(() => receiveLossDraft(ops, { loan_id: "", amount_cents: 1_350_000n, received_on: D("2026-02-14"), custodial_account_id: "C-TI-LD" }), RangeError);
  assert.throws(() => receiveLossDraft(ops, { loan_id: "L-LD1", amount_cents: 0n, received_on: D("2026-02-14"), custodial_account_id: "C-TI-LD" }), RangeError);
  assert.throws(() => receiveLossDraft(ops, { loan_id: "L-LD1", amount_cents: 1n, received_on: D("2026-02-17"), custodial_account_id: "C-TI-LD" }), RangeError, "a receipt dated after today is not a valid register record");
  const rcv = receiveLossDraft(ops, { loan_id: "L-LD1", amount_cents: 1_350_000n, received_on: D("2026-02-14"), custodial_account_id: "C-TI-LD", claim_id: "CLM-1" });
  assert.equal(rcv.aged_7m_on, "2026-09-14"); assert.equal(rcv.event.payload.received_on, "2026-02-14");
  const t = ctx.timers.byCode("FNMA_F496A_LOSS_DRAFT_AGED_7M")[0]!; assert.equal(t.anchorDate, "2026-02-14", "anchored on the receipt date, not the ingestion day"); assert.equal(t.dueDate, "2026-09-14"); assert.deepEqual(t.subject, { kind: "loss_draft", id: "CLM-1" });
  ctx.clock.set("2026-09-30T15:00:00.000Z");
  const breach = ctx.timers.evaluate(ctx.clock.now()).find((x) => x.instance.code === "FNMA_F496A_LOSS_DRAFT_AGED_7M")!;
  assert.ok(breach); assert.match(breach.breachText, /loss_draft_aged_7m/); assert.match(breach.breachText, /insurance-property/);
  const ld = await b.bus.execute(b.cmds.get(toolKey("6.4", "loss_draft.read"))!, RECON, { as_of: "2026-09-30" }, ctx);
  assert.deepEqual((ld.output as { id: string; age_months: number; explanation_required: boolean }[]).map((x) => [x.id, x.age_months, x.explanation_required]), [["CLM-1", 7, true]]);
  const partial = disburseLossDraft({ ...ops, now: ctx.clock.now() }, { loss_draft_id: "CLM-1", amount_cents: 350_000n });
  assert.equal(partial.full, false); assert.equal(partial.remaining_cents, 1_000_000n); assert.equal(t.status, "breached", "a partial disbursement does not clear the flag");
  assert.throws(() => disburseLossDraft({ ...ops, now: ctx.clock.now() }, { loss_draft_id: "CLM-1", amount_cents: 1_000_001n }), RangeError, "cannot disburse more than is held");
  const full = disburseLossDraft({ ...ops, now: ctx.clock.now() }, { loss_draft_id: "CLM-1", amount_cents: 1_000_000n });
  assert.equal(full.full, true); assert.equal(full.age_months, 7); assert.equal(t.status, "satisfied_late"); assert.equal(b.rt.store.get("loss_drafts", "CLM-1")!.data.status, "disbursed");
});
test("6.4-T4: Given a refund check issued 2026-03-01 unpaid on 2026-08-28 (180 days), then status `stale`, void instruction sent, funds restored to `refund_payable`, 6.5 workflow opened.", async () => {
  assert.equal(isStaleCheck(D("2026-03-01"), D("2026-08-28")), true); assert.equal(isStaleCheck(D("2026-03-01"), D("2026-08-27")), false);
  const w = staleCheckWorkflow({ check_number: "100231", payee: "Sample Borrower", issued_on: D("2026-03-01"), amount_cents: 21_455n, as_of: D("2026-08-28"), originating_balance: "refund_payable", custodial_account_id: "C-TI-MAIN", payee_confirmed: false });
  assert.equal(w.stale, true); assert.equal(w.status, "stale"); assert.equal(w.stale_on, "2026-08-28"); assert.deepEqual(w.actions, ["positive_pay.void", "restore_refund_payable", "open_6_5_unclaimed_property"]); assert.equal(w.next, "unclaimed_property_6_5");
  assert.equal(w.restore_entry!.lines.reduce((s, l) => s + l.amount_cents, 0n), 0n); assert.equal(w.restore_entry!.lines[1]!.account, "refund_payable"); assert.equal(w.restore_entry!.lines[1]!.amount_cents, -21_455n);
  assert.deepEqual(w.suspense_item, { source: "refund_returned", reason_code: "returned_refund", amount_cents: 21_455n, dormancy_start_on: "2026-03-01" });
  assert.equal(staleCheckWorkflow({ check_number: "100231", payee: "Sample Borrower", issued_on: D("2026-03-01"), amount_cents: 21_455n, as_of: D("2026-08-28"), originating_balance: "refund_payable", custodial_account_id: "C-TI-MAIN", payee_confirmed: true }).next, "reissue");
  assert.equal(staleCheckWorkflow({ check_number: "100231", payee: "Sample Borrower", issued_on: D("2026-03-01"), amount_cents: 21_455n, as_of: D("2026-08-27"), originating_balance: "refund_payable", custodial_account_id: "C-TI-MAIN", payee_confirmed: false }).status, "outstanding");
  // SM_STALE_CHECK_180 arms on issue and is satisfied by the void the positive-pay tool sends
  const ctx = uow("2026-03-01T15:00:00.000Z"); const b = bus(ctx);
  const agg = { kind: "disbursement", id: "100231" };
  ctx.events.append({ type: "disbursement.issued", aggregate: agg, actor: SYSTEM, payload: { instrument: "check", check_number: "100231", amount_cents: 21_455n } });
  const t = ctx.timers.byCode("SM_STALE_CHECK_180")[0]!; assert.equal(t.dueDate, "2026-08-28"); assert.equal(ctx.timers.byCode("SM_TI_OUTSTANDING_CHECK_90")[0]!.dueDate, "2026-05-30");
  b.rt.store.put("outstanding_checks", "100231", { check_number: "100231", payee: "Sample Borrower", loan_id: "L-1", issued_on: "2026-03-01", amount_cents: 21_455n, status: "outstanding", custodial_account_id: "C-TI-MAIN" }, SYSTEM, ctx.clock.now());
  ctx.clock.set("2026-08-28T15:00:00.000Z");
  await assert.rejects(b.bus.execute(b.cmds.get(toolKey("6.4", "positive_pay.read/void"))!, RECON, { op: "void", check_number: "100231", reason: "cleanup" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "VOID_REASON");
  const out = await b.bus.execute(b.cmds.get(toolKey("6.4", "positive_pay.read/void"))!, RECON, { op: "void", check_number: "100231", reason: "stale", originating_balance: "refund_payable" }, ctx);
  const o = out.output as { status: string; next: string; suspense_item: { dormancy_start_on: string }; ledger_entry_id: string | null; suspense_item_id: string | null };
  assert.equal(o.status, "voided"); assert.equal(o.next, "unclaimed_property_6_5"); assert.equal(o.suspense_item.dormancy_start_on, "2026-03-01");
  assert.equal(t.status, "satisfied"); assert.deepEqual(ctx.events.all().slice(-7).map((e) => e.type), ["positive_pay.void_sent", "disbursement.voided", "disbursement.closed", "timer.satisfied", "disbursement.funds_restored", "suspense.item.created", "command.executed"]);
  // funds restored: T&I cash back up by $214.55 against the borrower's refund payable (unapplied funds on the ledger), and the 6.5 unclaimed-property row opened with dormancy counted from issuance
  assert.ok(o.ledger_entry_id); assert.equal(ctx.ledger.balance({ scope: "custodial", custodialAccountId: "C-TI-MAIN", account: "custodial_ti_cash" }), 21_455n); assert.equal(ctx.ledger.balance({ scope: "loan", loanId: "L-1", account: "suspense_unapplied" }), -21_455n);
  assert.equal(ctx.events.ofType("disbursement.funds_restored")[0]!.payload.restore_to, "refund_payable");
  const sus = b.rt.store.get("suspense_items", o.suspense_item_id!)!.data; assert.equal(sus.status, "open"); assert.equal(sus.source, "refund_returned"); assert.equal(sus.reason_code, "returned_refund"); assert.equal(sus.amount_cents, 21_455n); assert.equal(sus.dormancy_start_on, "2026-03-01"); assert.equal(sus.track, "unclaimed_property");
});
// The T5 title spells all three JS quote characters (servicer's, `attestation_variance`, "No"), so no single literal can hold it unescaped; the
// runtime title below is the exact spec text and the verbatim spelling tools/audit.py scans for is carried on the same test( line.
test("6.4-T5: Given the servicer's T&I ending balance $8,573,053.99 and Fannie Mae's computed $8,571,803.99 (one rejected $1,250.00 deposit event), then `attestation_variance` item with commentary and the attestation package marks \"No\" with that text; the gate opens because the variance is explained.", () => {
  const av = attestationVariance(857_305_399n, 857_180_399n, "one rejected $1,250.00 deposit event, resubmitted 10/09");
  assert.equal(av.variance_cents, 125_000n); assert.equal(av.answer, "No"); assert.equal(av.gate_open, true); assert.equal(av.commentary, "one rejected $1,250.00 deposit event, resubmitted 10/09");
  assert.equal(attestationVariance(857_305_399n, 857_180_399n, null).gate_open, false);
  assert.equal(evaluateGate("6.4.form496aReviewedWithZeroOrExplainedVariance", { form_496a_status: "under_review", attestation_variance_cents: 125_000n, variance_explained: true }).open, true);
  assert.equal(evaluateGate("6.4.form496aReviewedWithZeroOrExplainedVariance", { form_496a_status: "under_review", attestation_variance_cents: 125_000n, variance_explained: false }).open, false);
  const g = generateCustodialForm({ kind: "496a", period: "2026-09", custodial_account_id: "C-TI-MAIN", ...SEPT_TI, section_iii: [...SEPT_TI.section_iii, { id: "av-1", category: "attestation_variance", amount_cents: 125_000n, loan_id: "L-7731", root_cause: "rejected deposit event, resubmitted 10/09", first_seen_on: D("2026-10-05"), evidence_refs: ["fnma-event-reject-7731", "resubmission-1009"] }], preparer_run_id: "p", posting_run_ids: [], attestation: { servicer_ending_cents: 857_305_399n, fnma_computed_cents: 857_180_399n, explanation: "one rejected $1,250.00 deposit event, resubmitted 10/09" } });
  assert.equal(g.status, "approved"); assert.equal(g.attestation!.answer, "No"); assert.equal(g.attestation!.commentary, "one rejected $1,250.00 deposit event, resubmitted 10/09");
  const gate = attestationGateEscalation({ period_end: D("2026-09-30"), form_496a_status: "under_review", attestation_variance_cents: 125_000n, variance_explained: true, today: D("2026-10-20") });
  assert.equal(gate.gate_open, true); assert.equal(gate.blocks, null);
  assert.equal(generateCustodialForm({ kind: "496a", period: "2026-09", custodial_account_id: "C-TI-MAIN", ...SEPT_TI, preparer_run_id: "p", posting_run_ids: [], attestation: { servicer_ending_cents: 857_305_399n, fnma_computed_cents: 857_180_399n, explanation: null } }).status, "rework", "an unexplained variance is not approvable");
  // the gate through the process (ops-6-4): the window opened BD3 Oct arms SM_F496A_BEFORE_ATTESTATION_GATE; the 496A under review with the explained variance opens it and the portal package answers "No" with the commentary
  const ctx = uow("2026-10-20T14:00:00.000Z"); const b = bus(ctx);
  const ops = { events: ctx.events, actor: RECON, now: ctx.clock.now(), escalations: b.rt.escalations };
  openAttestationWindow(ops, { period_end: D("2026-09-30"), servicer_number: "123456789" });
  const gateRow = ctx.timers.byCode("SM_F496A_BEFORE_ATTESTATION_GATE")[0]!; assert.equal(gateRow.status, "armed"); assert.equal(gateRow.note, "evaluator:6.4.form496aReviewedWithZeroOrExplainedVariance");
  const blocked = checkAttestationGate(ops, { period_end: D("2026-09-30"), servicer_number: "123456789", form_496a_status: "under_review", servicer_ending_cents: 857_305_399n, fnma_computed_cents: 857_180_399n, commentary: null });
  assert.equal(blocked.gate_open, false); assert.equal(blocked.blocks, "human_portal_task:escrow_attestation"); assert.equal(blocked.package, null); assert.equal(blocked.event.type, "escrow.attestation.gate_blocked"); assert.equal(b.rt.escalations.opened.length, 0, "no portal task while the variance is unexplained");
  const opened = checkAttestationGate(ops, { period_end: D("2026-09-30"), servicer_number: "123456789", form_496a_status: "under_review", servicer_ending_cents: 857_305_399n, fnma_computed_cents: 857_180_399n, commentary: "one rejected $1,250.00 deposit event, resubmitted 10/09", loan_count: 4210, contractual_escrow_sum_cents: 191_143_250n });
  assert.equal(opened.gate_open, true); assert.equal(opened.blocks, null); assert.equal(opened.package!.answer, "No"); assert.equal(opened.package!.commentary, "one rejected $1,250.00 deposit event, resubmitted 10/09"); assert.equal(opened.package!.variance_cents, 125_000n); assert.equal(opened.event.type, "escrow.attestation.gate_opened");
  assert.equal(b.rt.escalations.opened[0]!.kind, "human_portal_task"); assert.equal(b.rt.escalations.opened[0]!.ownerRole, "fnma_portal_operator"); assert.equal(b.rt.escalations.opened[0]!.payload.answer, "No"); assert.equal(b.rt.escalations.opened[0]!.payload.commentary, "one rejected $1,250.00 deposit event, resubmitted 10/09");
  assert.equal(evaluateGate("6.4.form496aReviewedWithZeroOrExplainedVariance", { form_496a_status: "completed", attestation_variance_cents: 0n, variance_explained: false }).open, true, "`under_review` or later: a completed 496A does not block the attestation");
  assert.equal(evaluateGate("6.4.form496aReviewedWithZeroOrExplainedVariance", { form_496a_status: "drafted", attestation_variance_cents: 0n, variance_explained: false }).open, false);
});
test("6.4-T6: Given the attestation window BD3 Oct–BD2 Nov for September activity (Oct 5–Nov 3, 2026), then `FNMA_LL202605_ESCROW_ATTEST_BD2_M2.due_at` = 2026-11-03 17:00 ET; given no 496A draft by Oct 29 (3 BD before), then `officer` escalation.", () => {
  const w = attestationWindow(D("2026-09-30")); assert.equal(w.opens_on, "2026-10-05"); assert.equal(w.closes_on, "2026-11-03"); assert.equal(toIso(w.closes_at_ms), at("2026-11-03", "17:00")); assert.equal(w.draft_warning_on, "2026-10-29");
  // the platform's window (ops-6-4 openAttestationWindow) carries `window_close_on` = BD2 of November; it arms the deadline row and the 496A gate on the 5.x period aggregate
  const ctx = uow("2026-10-05T13:00:00.000Z"); const b = bus(ctx);
  const ops = { events: ctx.events, actor: RECON, now: ctx.clock.now(), escalations: b.rt.escalations };
  assert.throws(() => openAttestationWindow({ ...ops, now: "2026-10-02T13:00:00.000Z" }, { period_end: D("2026-09-30"), servicer_number: "123456789" }), RangeError, "not before BD3 of October");
  assert.throws(() => openAttestationWindow(ops, { period_end: D("2026-09-29"), servicer_number: "123456789" }), RangeError, "period_end must be a month end");
  const win = openAttestationWindow(ops, { period_end: D("2026-09-30"), servicer_number: "123456789" });
  assert.equal(win.event.payload.window_close_on, "2026-11-03"); assert.equal(win.event.payload.opens_on, "2026-10-05"); assert.deepEqual(win.event.aggregate, { kind: "period", id: "123456789:2026-09" });
  const t = ctx.timers.byCode("FNMA_LL202605_ESCROW_ATTEST_BD2_M2")[0]!; assert.equal(t.dueDate, "2026-11-03"); assert.equal(toIso(t.dueAt!), at("2026-11-03", "17:00"));
  assert.equal(ctx.timers.byCode("SM_F496A_BEFORE_ATTESTATION_GATE").length, 1, "the gate arms on the same event");
  const late = attestationGateEscalation({ period_end: D("2026-09-30"), form_496a_status: "composing", attestation_variance_cents: 0n, variance_explained: false, today: D("2026-10-29") });
  assert.equal(late.gate_open, false); assert.equal(late.blocks, "human_portal_task:escrow_attestation"); assert.deepEqual(late.escalation, { role: "officer", reason: "no Form 496A draft for 2026-09-30 by 2026-10-29 (3 BD before the attestation window closes 2026-11-03)" });
  assert.equal(attestationGateEscalation({ period_end: D("2026-09-30"), form_496a_status: "composing", attestation_variance_cents: 0n, variance_explained: false, today: D("2026-10-28") }).escalation, null);
  assert.equal(attestationGateEscalation({ period_end: D("2026-09-30"), form_496a_status: "drafted", attestation_variance_cents: 0n, variance_explained: false, today: D("2026-10-30") }).escalation, null, "a draft exists; the gate merely stays closed until review");
  // through the process on Oct 29 with no draft: the gate stays blocked and the `officer` escalation opens
  ctx.clock.set("2026-10-29T14:00:00.000Z");
  const g = checkAttestationGate({ ...ops, now: ctx.clock.now() }, { period_end: D("2026-09-30"), servicer_number: "123456789", form_496a_status: "composing", servicer_ending_cents: 857_305_399n, fnma_computed_cents: 857_305_399n, commentary: null });
  assert.equal(g.gate_open, false); assert.equal(g.blocks, "human_portal_task:escrow_attestation"); assert.equal(g.escalation!.role, "officer"); assert.match(g.escalation!.reason, /by 2026-10-29/);
  assert.deepEqual(b.rt.escalations.opened.map((e) => e.kind), ["officer"]); assert.equal(g.event.type, "escrow.attestation.gate_blocked"); assert.equal(g.event.payload.officer_escalation_id, b.rt.escalations.opened[0]!.id);
  // 5.x submits the attestation on the same period aggregate → the deadline row is satisfied
  ctx.events.append({ type: "escrow.attestation.submitted", aggregate: { kind: "period", id: "123456789:2026-09" }, actor: RECON, payload: { period_key: "2026-09", outcome: "No" } });
  assert.equal(t.status, "satisfied");
});
test("6.4-T7: Given a paid check on the bank's paid file with no matching issued record, then critical exception, `fraud` case, bank claim within 1 BD.", async () => {
  const r = paidNotIssued({ paid: [{ check_number: "100231", amount_cents: 58200n, paid_on: D("2026-10-05") }, { check_number: "100232", amount_cents: 41000n, paid_on: D("2026-10-05") }], issued: [{ check_number: "100232", amount_cents: 41000n }] });
  assert.equal(r.exceptions.length, 1); assert.equal(r.exceptions[0]!.check_number, "100231"); assert.equal(r.exceptions[0]!.severity, "critical"); assert.equal(r.exceptions[0]!.fraud_case, true); assert.equal(r.exceptions[0]!.bank_claim_by, "2026-10-06");
  // the bank's paid file through the positive-pay tool: the issued check clears (and closes its 90/180-day timers); the paid-not-issued check opens the fraud case
  const ctx = uow("2026-08-14T15:00:00.000Z"); const b = bus(ctx);
  ctx.events.append({ type: "disbursement.issued", aggregate: { kind: "disbursement", id: "100232" }, actor: SYSTEM, payload: { instrument: "check", check_number: "100232" } });
  b.rt.store.put("outstanding_checks", "100232", { check_number: "100232", payee: "County Tax Collector", issued_on: "2026-08-14", amount_cents: 41000n, status: "outstanding" }, SYSTEM, ctx.clock.now());
  ctx.clock.set("2026-10-05T15:00:00.000Z");
  const out = await b.bus.execute(b.cmds.get(toolKey("6.4", "positive_pay.read/void"))!, RECON, { op: "paid_file", paid: [{ check_number: "100231", amount_cents: 58200n, paid_on: "2026-10-05" }, { check_number: "100232", amount_cents: 41000n, paid_on: "2026-10-05" }] }, ctx);
  const o = out.output as { cleared: string[]; exceptions: { check_number: string; bank_claim_by: string }[] };
  assert.deepEqual(o.cleared, ["100232"]); assert.deepEqual(o.exceptions.map((e) => [e.check_number, e.bank_claim_by]), [["100231", "2026-10-06"]]);
  assert.equal(ctx.timers.byCode("SM_TI_OUTSTANDING_CHECK_90")[0]!.status, "satisfied", "paid on day 52 of 90"); assert.equal(ctx.timers.byCode("SM_STALE_CHECK_180")[0]!.status, "satisfied");
  assert.equal(b.rt.escalations.opened[0]!.kind, "fraud_officer"); assert.equal(b.rt.escalations.opened[0]!.payload.exception, "paid_not_issued");
});
test("6.4-T8: Given the 45-day deadline for 2026-09-30 → internal `due_at` 2026-11-13 17:00; on-time and breach behaviours as 6.3-T3.", () => {
  const ok = form496TimerOutcome({ kind: "monthly_form_496a", period_end: D("2026-09-30"), completed_at_ms: zonedEpochMs(D("2026-11-13"), "16:00", ET), now_ms: zonedEpochMs(D("2026-11-13"), "16:00", ET) });
  assert.equal(ok.due_on, "2026-11-13"); assert.equal(toIso(ok.due_at_ms), toIso(zonedEpochMs(D("2026-11-13"), "17:00", ET))); assert.equal(ok.status, "satisfied");
  const late = form496TimerOutcome({ kind: "monthly_form_496a", period_end: D("2026-09-30"), completed_at_ms: null, now_ms: zonedEpochMs(D("2026-11-13"), "17:01", ET) });
  assert.equal(late.status, "breached"); assert.deepEqual(late.escalation, { role: "officer", severity: "critical" }); assert.equal(late.partner_notice, true); assert.match(late.sentinel_line!, /monthly_form_496a/);
  // the armed registry timer (FNMA_F496A_TI_RECON_45) on the T&I period close: Sat 11/14 → Fri 11/13 17:00
  const ctx = uow("2026-09-30T23:00:00.000Z", ["6.3", "6.4"]);
  ctx.events.append({ ...periodClosedEvent({ period_end: D("2026-09-30"), account_kind: "ti", custodial_account_id: "C-TI-MAIN" }), actor: SYSTEM });
  const t = ctx.timers.byCode("FNMA_F496A_TI_RECON_45")[0]!; assert.equal(t.dueDate, "2026-11-13"); assert.equal(toIso(t.dueAt!), at("2026-11-13", "17:00"));
  assert.equal(ctx.timers.byCode("FNMA_F496_PI_RECON_45").length, 0); assert.equal(ctx.timers.byCode("SM_F496A_DRAFT_BD10")[0]!.dueDate, "2026-10-15", "10 servicer BD after 9/30 (Columbus Day 10/12)");
  const breaches = ctx.timers.evaluate("2026-11-13T22:01:00.000Z");
  const b45 = breaches.find((b) => b.instance.code === "FNMA_F496A_TI_RECON_45")!; assert.ok(b45); assert.deepEqual(b45.escalateTo, ["officer"]); assert.match(b45.breachText, /critical; partner notified/);
  assert.deepEqual(breaches.map((b) => b.instance.code).sort(), ["FNMA_F496A_TI_RECON_45", "SM_F496A_DRAFT_BD10"], "the internal BD10 draft deadline (10/15) is also past");
  ctx.events.append({ type: "custodial.reconciliation.completed", aggregate: { kind: "custodial_account", id: "C-TI-MAIN" }, actor: RECON, occurredAt: "2026-11-16T15:00:00.000Z", payload: { kind: "monthly_form_496a" } });
  assert.equal(t.status, "satisfied_late");
});

test("6.4 worked example: September attestation ties to the snapshot ($8,573,053.99 net, 4,210 loans, Σ contractual $1,911,432.50; loss drafts $121,500.00 over 9 loans, one aged 8 months)", () => {
  // the snapshot is derived from the escrow trial balance and the loss-draft register, not restated
  const main = tiCompositionSnapshot({ period_end: D("2026-09-30"), escrow_accounts: trialBalance(), buydown_cents: 1_230_000n, interest_pending_cents: 20_191n });
  assert.equal(main.loan_count, 4210); assert.equal(main.P, 861_200_411n); assert.equal(main.N, 3_895_012n); assert.equal(main.negative_loans, 23); assert.equal(main.A, 3_895_012n);
  assert.equal(main.ti_ending_cents, 857_305_399n); assert.equal(main.contractual_escrow_payment_sum_cents, 191_143_250n);
  assert.deepEqual([main.composition.L1, main.composition.L2, main.composition.L5, main.composition.L6, main.composition.L7], [857_305_399n, 3_895_012n, 1_230_000n, 20_191n, 862_450_602n]);
  const drafts = Array.from({ length: 9 }, (_, i) => ({ loan_id: `LD-${i + 1}`, amount_cents: 1_350_000n, received_on: D(i === 0 ? "2026-01-30" : "2026-08-14"), explanation: i === 0 ? "contractor final inspection pending; borrower notified 9/12" : null }));
  const sub = tiCompositionSnapshot({ period_end: D("2026-09-30"), escrow_accounts: [], loss_drafts: drafts });
  assert.equal(sub.composition.L3, 12_150_000n); assert.equal(sub.composition.L7, 12_150_000n); assert.equal(sub.by_category.loss_draft.loan_count, 9); assert.deepEqual(sub.by_category.loss_draft.aged_7m.map((d) => [d.loan_id, d.months]), [["LD-1", 8]]);
  const snapshot = { ti_ending_cents: main.ti_ending_cents, loan_count: main.loan_count, contractual_escrow_sum_cents: main.contractual_escrow_payment_sum_cents, loss_draft_cents: sub.by_category.loss_draft.ending_cents, loss_draft_loans: sub.by_category.loss_draft.loan_count };
  const r = attestationTieOut({ snapshot, attestation: { ti_ending_cents: 857305399n, loan_count: 4210, contractual_escrow_sum_cents: 191143250n, loss_draft_cents: 12150000n, loss_draft_loans: 9 }, loss_drafts: drafts, as_of: D("2026-09-30") });
  assert.equal(r.ties, true); assert.equal(r.answer, "Yes"); assert.deepEqual(r.aged_loss_drafts.map((l) => [l.loan_id, l.months]), [["LD-1", 8]]);
  const off = attestationTieOut({ snapshot, attestation: { ...snapshot, contractual_escrow_sum_cents: 191143251n }, loss_drafts: [], as_of: D("2026-09-30") });
  assert.equal(off.answer, "No"); assert.deepEqual(off.variances, ["contractual_escrow_sum_cents"]);
});

test("6.4 agent tools: the six tools the spec names run on the bus for custodial-recon (they join ALL_TOOLS once spec/registry/agents.json names them for 6.4)", async () => {
  const ctx = uow(); const b = bus(ctx);
  assert.deepEqual(SECTION_06_4_TOOLS.map((t) => t.name), ["escrow.read_trial_balance", "suspense.read", "loss_draft.read", "positive_pay.read/void", "ledger.post_advance", "form496a.generate"]);
  const named = loadAgentsFile().processes.find((p) => p.process === "6.4")!.tools;
  for (const t of SECTION_06_4_TOOLS) assert.ok(named.length === 0 || named.includes(t.name), `${t.name} is a 6.4 tool string`);
  b.rt.store.put("loss_drafts", "LD-1", { loan_id: "L-LD1", amount_cents: 1_350_000n, received_on: "2026-01-30", status: "held" }, SYSTEM, ctx.clock.now());
  const ld = await b.bus.execute(b.cmds.get(toolKey("6.4", "loss_draft.read"))!, RECON, { as_of: "2026-09-30" }, ctx);
  assert.deepEqual((ld.output as { age_months: number; aged_7m: boolean; explanation_required: boolean }[]).map((x) => [x.age_months, x.aged_7m, x.explanation_required]), [[8, true, true]]);
  assert.equal(ctx.decisions.length, 0, "read tools leave no decision row");
  const tb = await b.bus.execute(b.cmds.get(toolKey("6.4", "escrow.read_trial_balance"))!, RECON, { period_end: "2026-09-30", escrow_accounts: trialBalance(), loss_drafts: [], buydown_cents: 1_230_000n, interest_pending_cents: 20_191n }, ctx);
  assert.equal((tb.output as { snapshot: { composition: { L7: bigint } } }).snapshot.composition.L7, 862_450_602n);
  assert.deepEqual((await b.bus.execute(b.cmds.get(toolKey("6.4", "suspense.read"))!, RECON, {}, ctx)).output, []);
});
