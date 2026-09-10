// 6.3 Monthly P&I reconciliation (Form 496)
// spec/sections/06-custodial-account-management/6-3-monthly-p-i-reconciliation-form-496.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso, wallClock } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../../kernel/events/index.ts";
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
import { shortageFunding, RECON_WRITE_OFF_LIMIT_CENTS, reconWriteOff, form496Deadline, form496SS, reconcile, draftVariance, ssFundsAvailableMs, draftCoverage, FORM_496_TEMPLATE, BAI2_CATEGORY, residualCategory } from "./reconciliation.ts";
import { ET, form496TimerOutcome, unidentifiedDebit, ingestStatement, reviewerRun, approvalReminder, retroCorrection, aaLine1Logic, form472TimersFor, generateCustodialForm, periodClosedEvent, openBankCreditUnposted, bankFeeReimbursement, postingSetBalanced } from "./ops.ts";
import { dailyTick, ACCOUNT_AGG, ITEM_AGG, PERIOD_AGG, remittanceClass, draftVarianceSignViolation } from "./ops-6-3.ts";

const at = (d: string, t: string) => toIso(zonedEpochMs(D(d), t, ET));
const RECON: Actor = { kind: "agent", id: "custodial-recon" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
function uow(nowIso = "2026-10-01T14:00:00.000Z", processes = ["6.3"]): UowContext & { decisions: DecisionInput[] } {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  return { loanId: "L-1", events, ledger: new MemoryLedger(), timers: new TimerEngine(loadOverriddenRegistry(), events, { processes }), clock, decide: (d) => { decisions.push({ loanId: "L-1", ...d }); }, decisions };
}
function bus(ctx: UowContext) { const agents = new AgentRegistry(); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} }; const cmds = bindTools(rt, agents, SECTION_06_TOOLS); return { bus: new CommandBus(agents), cmds, rt, run: (tool: string, actor: Actor, input: Record<string, unknown>) => new CommandBus(agents).execute(cmds.get(toolKey("6.3", tool))!, actor, input, ctx) }; }
const SEPT_SS = { section_i: { bank_closing_ledger_cents: 125_430_055n, deposits_in_transit_cents: 1_245_000n, disbursements_in_transit_cents: 0n, adjustments_cents: 0n }, composition: { L3_prepaid_net: 812_040n, L4_curtailments: 4_500_000n, L5_interest_fundings: 0n, L7_payoff_fixed_net: 321_015n, L8_delinquent_net: -2_258_000n, L9_fnma_receivable: 123_300_000n, L10_variances: 0n, L11_other: 0n }, cashbook_cents: 126_675_055n,
  section_iii: [{ id: "dit-1", category: "deposit_in_transit", amount_cents: 1_245_000n, loan_id: "LBX-0930-07 (14 loans listed)", root_cause: "lockbox batch LBX-0930-07 posted 9/30, bank credit 10/1", first_seen_on: D("2026-09-30"), evidence_refs: ["doc-lbx-0930-07", "doc-bai2-1001"] }] };
// worked example 8: the bank took $200.00 more than the ledger expected → custodial cash is credited (−) and fnma_shortage_surplus debited (+)
const reclassSet = (memo: string, cash = -20_000n) => ({ effectiveDate: "2026-10-07", description: memo, lines: [{ account: { scope: "custodial", custodialAccountId: "C-PI-AA", account: "custodial_pi_cash" }, amountCents: cash, ruleRef: "6.3 rule 4" }, { account: { scope: "corporate", account: "fnma_shortage_surplus" }, amountCents: -cash, ruleRef: "6.3 rule 4" }] });
const fundingSet = (account: string, amount: bigint, on: string, memo: string, rule = "6.3 rule 5") => ({ effectiveDate: on, description: memo, lines: [{ account: { scope: "custodial", custodialAccountId: account, account: "custodial_pi_cash" }, amountCents: amount, ruleRef: rule }, { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -amount, ruleRef: rule }] });
const types = (ctx: UowContext, prefix: string) => ctx.events.all().filter((e) => e.type.startsWith(prefix)).map((e) => e.type);

test("6.3-T1: Given a September 2026 S/S MBS account with the worked-example balances, when the monthly job runs, then Section I difference = 0, L12 = $1,266,750.55, xlsx cells populated per `form_templates.cell_map`, PDF rendered, hashes stored.", async () => {
  const { L12 } = form496SS(SEPT_SS.composition); assert.equal(L12, 126_675_055n);
  const r = reconcile(SEPT_SS.section_i, 126_675_055n, L12); assert.equal(r.balanced, true); assert.equal(r.difference_cents, 0n); assert.equal(r.adjusted_depository_cents, 126_675_055n);
  const g = generateCustodialForm({ kind: "ss", period: "2026-09", custodial_account_id: "C-PI-SS-MBS", servicer_number: "123456789", remittance_type: "S/S MBS", ...SEPT_SS, preparer_run_id: "run-prep", posting_run_ids: ["run-cashiering"], complete: true });
  assert.equal(g.total_cents, 126_675_055n); assert.equal(g.difference_cents, 0n); assert.equal(g.status, "completed"); assert.deepEqual(g.events, ["custodial.reconciliation.drafted", "custodial.reconciliation.completed"]);
  const c = FORM_496_TEMPLATE.cell_map;
  assert.equal(g.workbook.cells[c["I.1"]!], "$1,254,300.55"); assert.equal(g.workbook.cells[c["I.2"]!], "$12,450.00"); assert.equal(g.workbook.cells[c["I.5"]!], "$1,266,750.55"); assert.equal(g.workbook.cells[c["I.6"]!], "$1,266,750.55"); assert.equal(g.workbook.cells[c["I.7"]!], "$0.00");
  assert.equal(g.workbook.cells[c["II.3"]!], "$8,120.40"); assert.equal(g.workbook.cells[c["II.4"]!], "$45,000.00"); assert.equal(g.workbook.cells[c["II.7"]!], "$3,210.15"); assert.equal(g.workbook.cells[c["II.8"]!], "-$22,580.00"); assert.equal(g.workbook.cells[c["II.9"]!], "$1,233,000.00"); assert.equal(g.workbook.cells[c["II.12"]!], "$1,266,750.55");
  assert.match(g.workbook.cells[c["III.deposits_in_transit"]!]!, /LBX-0930-07/);
  assert.deepEqual(g.workbook.missing_fields.filter((f) => !/^II\.(1|2|6)$/.test(f)), [], "every cell of the S/S cell map is populated (lines 1, 2 and 6 are A/A and S/A only)");
  assert.match(g.xlsx_sha256, /^[0-9a-f]{64}$/); assert.match(g.pdf_sha256, /^[0-9a-f]{64}$/); assert.notEqual(g.xlsx_sha256, g.pdf_sha256); assert.match(g.workbook.pdf.text, /Fannie Mae Form 496 .*\nII\.12: \$1,266,750\.55/s);
  // through the bus: `form496.generate` stores the workbook and the PDF (SHA-256) in `documents` and emits drafted + completed
  const ctx = uow(); const b = bus(ctx);
  const out = await b.bus.execute(b.cmds.get(toolKey("6.3", "form496.generate"))!, RECON, { kind: "ss", period: "2026-09", custodial_account_id: "C-PI-SS-MBS", servicer_number: "123456789", remittance_type: "S/S MBS", ...SEPT_SS, preparer_run_id: "run-prep", posting_run_ids: ["run-cashiering"], complete: true }, ctx);
  const o = out.output as { id: string; xlsx_sha256: string; pdf_sha256: string; generated_document_id: string; rendered_document_id: string; status: string };
  assert.equal(o.status, "completed"); assert.equal(o.xlsx_sha256, g.xlsx_sha256); assert.equal(o.pdf_sha256, g.pdf_sha256);
  assert.equal(b.rt.store.get("documents", o.generated_document_id)!.data.sha256, g.xlsx_sha256); assert.equal(b.rt.store.get("documents", o.rendered_document_id)!.data.sha256, g.pdf_sha256);
  assert.equal(b.rt.store.get("custodial_reconciliations", o.id)!.data.generated_document_id, o.generated_document_id);
  assert.deepEqual(ctx.events.all().filter((e) => e.type.startsWith("custodial.reconciliation.")).map((e) => e.type), ["custodial.reconciliation.drafted", "custodial.reconciliation.completed"]);
  await assert.rejects(b.bus.execute(b.cmds.get(toolKey("6.3", "form496.generate"))!, RECON, { kind: "ss", period: "2026-09", ...SEPT_SS, cashbook_cents: 126_675_056n, preparer_run_id: "run-prep", posting_run_ids: [] }, ctx), /difference -1 cents/);
});
test("6.3-T2: Given `ledger.period.closed` for 2026-09-30, then `FNMA_F496_PI_RECON_45.due_at` = 2026-11-13 17:00 local (day 45 = Sat 11/14 → preceding BD) and `warning_at` = 2026-10-30; for 2027-01-31 → 2027-03-17; for 2027-02-28 → 2027-04-14.", () => {
  const dl = form496Deadline(D("2026-09-30")); assert.equal(dl.due_on, "2026-11-13"); assert.equal(dl.warning_on, "2026-10-30"); assert.equal(toIso(dl.due_at_ms), at("2026-11-13", "17:00"));
  assert.equal(form496Deadline(D("2027-01-31")).due_on, "2027-03-17"); assert.equal(form496Deadline(D("2027-02-28")).due_on, "2027-04-14");
  // the armed registry timer, from the period-close event that carries the computed anchor
  const armFor = (periodEnd: string) => { const ctx = uow(`${periodEnd}T23:00:00.000Z`, ["6.3", "6.4"]); ctx.events.append({ ...periodClosedEvent({ period_end: D(periodEnd), account_kind: "pi", custodial_account_id: "C-PI-SS-MBS", remittance_type: "S/S" }), actor: SYSTEM }); return ctx; };
  const ctx = armFor("2026-09-30");
  const t = ctx.timers.byCode("FNMA_F496_PI_RECON_45")[0]!;
  assert.equal(t.dueDate, "2026-11-13"); assert.equal(toIso(t.dueAt!), at("2026-11-13", "17:00")); assert.equal(t.anchorDate, "2026-11-13");
  assert.equal(ctx.events.all()[0]!.payload.recon_warning_on, "2026-10-30"); assert.equal(ctx.events.all()[0]!.payload.recon_due_at, at("2026-11-13", "17:00"));
  assert.equal(ctx.timers.byCode("FNMA_F496A_TI_RECON_45").length, 0, "a P&I period close arms the 496 timer, not the 496A");
  assert.equal(ctx.timers.byCode("SM_F496_DRAFT_BD10")[0]!.dueDate, "2026-10-15", "10 servicer BD after 9/30 (Columbus Day 10/12 is not a business day)");
  assert.equal(armFor("2027-01-31").timers.byCode("FNMA_F496_PI_RECON_45")[0]!.dueDate, "2027-03-17"); assert.equal(armFor("2027-02-28").timers.byCode("FNMA_F496_PI_RECON_45")[0]!.dueDate, "2027-04-14");
  ctx.events.append({ type: "custodial.reconciliation.completed", aggregate: { kind: "custodial_account", id: "C-PI-SS-MBS" }, actor: RECON, occurredAt: "2026-11-13T20:00:00.000Z", payload: { kind: "monthly_form_496" } });
  assert.equal(t.status, "satisfied");
});
test("6.3-T3: Given completion on 2026-11-13 16:00, then timer `satisfied`; given no completion by 2026-11-13 17:00, then `breached`, `officer` critical escalation, partner notice, Sentinel report line.", () => {
  const ok = form496TimerOutcome({ kind: "monthly_form_496", period_end: D("2026-09-30"), completed_at_ms: zonedEpochMs(D("2026-11-13"), "16:00", ET), now_ms: zonedEpochMs(D("2026-11-13"), "16:00", ET) });
  assert.equal(ok.status, "satisfied"); assert.equal(toIso(ok.due_at_ms), toIso(zonedEpochMs(D("2026-11-13"), "17:00", ET)));
  const late = form496TimerOutcome({ kind: "monthly_form_496", period_end: D("2026-09-30"), completed_at_ms: null, now_ms: zonedEpochMs(D("2026-11-13"), "17:01", ET) });
  assert.equal(late.status, "breached"); assert.deepEqual(late.escalation, { role: "officer", severity: "critical" }); assert.equal(late.partner_notice, true); assert.match(late.sentinel_line!, /45-day/);
});
test('6.3-T4: Given a bank credit with no ledger match (BAI2 165, $1,250.00, memo "J SMITH"), then item `bank_credit_unposted` and a `suspense_items` row (6.5) within the same day; no auto-posting to any loan without a ≥ 0.97 identification.', async () => {
  const ledger = [{ id: "a", amount_cents: 125_000n, date: D("2026-10-07") }, { id: "b1", amount_cents: 50_000n, date: D("2026-10-07"), batch_id: "LBX1" }, { id: "b2", amount_cents: 70_000n, date: D("2026-10-07"), batch_id: "LBX1" }];
  const line = { id: "bsl-165-1", amount_cents: 125_000n, value_date: D("2026-10-07"), type_code: "165", memo: "J SMITH" };
  assert.equal(residualCategory("165", "credit"), "bank_credit_unposted"); assert.equal(BAI2_CATEGORY["165"], "bank_credit_unposted");
  // three J. Smiths, none with the originator's account on file → best candidate scores below 0.97 → no posting, item open, suspense row the same day
  const cands = [{ loan_id: "4471", borrower_names: ["John Smith"], periodic_payment_cents: 125_000n }, { loan_id: "9001", borrower_names: ["Jane Smith"], periodic_payment_cents: 99_000n }, { loan_id: "9002", borrower_names: ["J Smithers"], periodic_payment_cents: 140_000n }];
  const r = openBankCreditUnposted({ line, ledger: [ledger[1]!, ledger[2]!], today: D("2026-10-07"), custodial_account_id: "C-TI-UNAPPLIED", candidates: cands });
  assert.equal(r.matched, false); assert.equal(r.auto_post, false); assert.equal(r.same_day, true);
  assert.equal(r.item!.category, "bank_credit_unposted"); assert.equal(r.item!.amount_cents, 125_000n); assert.equal(r.item!.status, "open"); assert.equal(r.item!.loan_id, null); assert.match(r.item!.root_cause, /unidentified deposit \(BAI2 165, memo "J SMITH"\)/);
  assert.equal(r.suspense_item!.source, "bank_credit_unposted"); assert.equal(r.suspense_item!.created_on, "2026-10-07"); assert.equal(r.suspense_item!.received_on, "2026-10-07"); assert.equal(r.suspense_item!.loan_id, null); assert.ok(["researching", "contact_pending"].includes(r.suspense_item!.status));
  assert.ok(r.identification!.scores[0]!.score < 0.97);
  // worked example B: the originator's account last4 matches loan 4471 → 0.99-class unique identification → auto-applied, item cleared the same day
  const b = openBankCreditUnposted({ line, ledger: [], today: D("2026-10-07"), custodial_account_id: "C-TI-UNAPPLIED", receipt: { amount_cents: 125_000n, memo: "J SMITH", payer_name: "J SMITH", ach_last4: "8831" }, candidates: [{ ...cands[0]!, ach_last4: "8831" }, cands[1]!, cands[2]!] });
  assert.equal(b.auto_post, true); assert.equal(b.item!.status, "cleared"); assert.equal(b.item!.loan_id, "4471"); assert.equal(b.suspense_item!.status, "applied");
  assert.equal(openBankCreditUnposted({ line: { ...line, amount_cents: 120_000n }, ledger, today: D("2026-10-08"), custodial_account_id: "C-TI-UNAPPLIED" }).matched, true, "a many-to-one lockbox match opens nothing");
  // through the bus: the prior-day file's residual line opens the item (its aging clock) and the 6.5 register row the same day; nothing is posted to any loan
  const ctx = uow("2026-10-07T13:00:00.000Z"); const bb = bus(ctx);
  const out = await bb.run("bank.read_statement", RECON, { custodial_account_id: "C-PI-AA", file_id: "BAI2-1007", format: "bai2", as_of_date: "2026-10-07", credit_lines: [125_000n], summary_credits: 125_000n, debit_lines: [], summary_debits: 0n, closing_ledger_cents: 4_946_033n,
    lines: [{ id: "bsl-165-1", type_code: "165", direction: "credit", amount_cents: 125_000n, value_date: "2026-10-07", memo: "J SMITH" }], ledger: [ledger[1]!, ledger[2]!], candidates: cands });
  const o = out.output as { ok: boolean; items: { item_id: string; category: string; status: string; loan_id: string | null; suspense_item_id: string | null; first_seen_on: string }[]; suspense_rows: { id: string; status: string; created_on: string; loan_id: string | null }[] };
  assert.equal(o.ok, true); assert.equal(o.items.length, 1); assert.equal(o.items[0]!.category, "bank_credit_unposted"); assert.equal(o.items[0]!.status, "open"); assert.equal(o.items[0]!.loan_id, null); assert.equal(o.items[0]!.first_seen_on, "2026-10-07");
  assert.equal(o.suspense_rows[0]!.created_on, "2026-10-07"); assert.equal(o.suspense_rows[0]!.loan_id, null); assert.equal(bb.rt.store.get("suspense_items", o.suspense_rows[0]!.id)!.data.source, "bank_credit_unposted"); assert.equal(bb.rt.store.get("reconciliation_items", o.items[0]!.item_id)!.data.status, "open");
  assert.deepEqual(types(ctx, "custodial.statement"), ["custodial.statement.received"]); assert.deepEqual(types(ctx, "reconciliation_item"), ["reconciliation_item.opened"]); assert.deepEqual(types(ctx, "suspense.item"), ["suspense.item.created"]);
  assert.equal(ctx.events.ofType("suspense.item.created")[0]!.payload.reason_code, "unidentified_loan");
  assert.equal(ctx.ledger.sets().length, 0, "no auto-posting below 0.97");
  const age30 = ctx.timers.byCode("SM_RECON_ITEM_AGE_30")[0]!; assert.equal(age30.anchorDate, "2026-10-07"); assert.equal(age30.dueDate, "2026-11-06"); assert.deepEqual(age30.subject, ITEM_AGG(o.items[0]!.item_id));
  assert.equal(ctx.timers.byCode("SM_RECON_ITEM_AGE_60")[0]!.dueDate, "2026-12-06"); assert.equal(ctx.timers.byCode("SM_RECON_ITEM_AGE_90_FUND_OR_CLEAR").length, 0, "an unposted credit is not a cash shortfall");
});
test("6.3-T5: Given an unmatched bank debit of $8,500.00 (BAI2 451) not in Draft Notifications/CRS reports, then severity critical, `fraud` case opened, bank contacted same day, funding tier evaluated, `officer` escalation.", async () => {
  const d = unidentifiedDebit({ amount_cents: 850000n, type_code: "451", in_draft_notifications: false, in_crs_reports: false, identified_on: D("2026-10-08") });
  assert.equal(d.severity, "critical"); assert.equal(d.fraud_case, true); assert.equal(d.bank_contact_by, "2026-10-08"); assert.equal(d.category, "bank_debit_unposted"); assert.equal(d.instrument, "ach_debit");
  assert.equal(d.funding!.tier, "officer_partner_fraud"); assert.equal(d.escalation, "officer");
  assert.equal(unidentifiedDebit({ amount_cents: 850000n, type_code: "451", in_draft_notifications: true, in_crs_reports: false, identified_on: D("2026-10-08") }).severity, null);
  // through the bus: the residual 451 debit (no Draft Notification / CRS report for $8,500.00) opens the critical item, the fraud case and the officer escalation the same day
  const ctx = uow("2026-10-08T13:00:00.000Z"); const b = bus(ctx);
  b.rt.store.put("draft_notifications", "dn-oct", { period: "2026-10", amount_cents: 4_821_033n }, RECON, ctx.clock.now());
  const out = await b.run("bank.read_statement", RECON, { custodial_account_id: "C-PI-AA", file_id: "BAI2-1008", format: "bai2", as_of_date: "2026-10-08", credit_lines: [], summary_credits: 0n, debit_lines: [850_000n], summary_debits: 850_000n, lines: [{ id: "bsl-451-1", type_code: "451", direction: "debit", amount_cents: 850_000n, value_date: "2026-10-08" }] });
  const o = out.output as { items: { item_id: string; category: string; severity: string; fraud_case: boolean; bank_contact_by: string | null; funding_tier: string | null; amount_cents: bigint }[]; escalation_ids: string[] };
  assert.equal(o.items[0]!.category, "bank_debit_unposted"); assert.equal(o.items[0]!.severity, "critical"); assert.equal(o.items[0]!.fraud_case, true); assert.equal(o.items[0]!.bank_contact_by, "2026-10-08"); assert.equal(o.items[0]!.funding_tier, "officer_partner_fraud"); assert.equal(o.items[0]!.amount_cents, -850_000n);
  assert.equal(o.escalation_ids.length, 2); assert.deepEqual(b.rt.escalations.opened.map((e) => [e.kind, e.ownerRole, e.severity]), [["fraud_officer", "fraud_officer", "critical"], ["officer", "officer", "critical"]]); assert.equal(ctx.events.ofType("escalation.created")[0]!.payload.fraud_case, true);
  assert.equal(ctx.events.ofType("reconciliation_item.opened")[0]!.payload.fraud_case, true); assert.equal(ctx.timers.byCode("SM_RECON_ITEM_AGE_30")[0]!.dueDate, "2026-11-07");
  const known = await b.run("bank.read_statement", RECON, { custodial_account_id: "C-PI-AA", file_id: "BAI2-1009", format: "bai2", as_of_date: "2026-10-09", credit_lines: [], summary_credits: 0n, debit_lines: [4_821_033n], summary_debits: 4_821_033n, lines: [{ id: "bsl-451-2", type_code: "451", direction: "debit", amount_cents: 4_821_033n, value_date: "2026-10-09" }] });
  assert.equal((known.output as { items: { category: string; severity: string }[] }).items[0]!.category, "draft_variance", "a debit the Draft Notifications announce is the expected draft, not a suspected unauthorized debit");
});
test("6.3-T6: Given expected A/A draft $48,210.33 and bank debit $48,410.33 with a $200.00 LSDU adjustment on loan 1234567890, then `draft_variance` item with loan, root cause and `fnma_shortage_surplus` posting; no plug.", async () => {
  const dv = draftVariance(4_821_033n, 4_841_033n, [{ loan: "1234567890", amount_cents: 20_000n, reason: "Fannie Mae adjustment for corrected LAR (5.1 correction 10/02)" }]);
  assert.equal(dv.variance_cents, 20_000n); assert.deepEqual(dv.items, [{ loan: "1234567890", amount_cents: -20_000n, root_cause: "Fannie Mae adjustment for corrected LAR (5.1 correction 10/02)" }]); assert.equal(dv.residual_to_shortage_surplus_cents, 0n); assert.equal(dv.action, "none", "the LSDU adjustment explains the whole $200.00 — a refund claim only if the correction was Fannie Mae's error");
  // the posting to fnma_shortage_surplus goes through `ledger.post_reclass`: a plug (or a missing root cause / evidence) is refused, the documented variance posts and resolves the item
  const ctx = uow(); const b = bus(ctx); const reclass = b.cmds.get(toolKey("6.3", "ledger.post_reclass"))!;
  const good = { entry_set: reclassSet("draft variance 10/07"), category: "draft_variance", variance_cents: dv.variance_cents, root_cause: dv.items[0]!.root_cause, confidence: 0.99, evidence_refs: ["lsdu-adj-2026-10", "bai2-1007-451"], reconciliation_item_id: "dv-1", item_status: "posted", aggregate: ACCOUNT_AGG("C-PI-AA") };
  // rule 4 sign: the bank took $200.00 more, so custodial cash is credited — a set that debits custodial cash (the old fixture) is refused
  assert.match(draftVarianceSignViolation(reclassSet("wrong way", 20_000n), 20_000n)!, /custodial cash must be credited/); assert.equal(draftVarianceSignViolation(reclassSet("right way"), 20_000n), undefined); assert.equal(draftVarianceSignViolation(reclassSet("under-draft", 20_000n), -20_000n), undefined);
  await assert.rejects(b.bus.execute(reclass, RECON, { ...good, entry_set: reclassSet("draft variance 10/07", 20_000n) }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "DRAFT_VARIANCE_SIGN");
  await assert.rejects(b.bus.execute(reclass, RECON, { ...good, variance_cents: undefined }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "DRAFT_VARIANCE_SIGN", "a draft_variance reclass states the variance it explains");
  await assert.rejects(b.bus.execute(reclass, RECON, { ...good, root_cause: "plug" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_PLUG");
  await assert.rejects(b.bus.execute(reclass, RECON, { ...good, root_cause: "" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_PLUG", "no root cause is a plug");
  await assert.rejects(b.bus.execute(reclass, RECON, { ...good, evidence_refs: ["lsdu-adj-2026-10"] }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "EVIDENCE_AND_CONFIDENCE", "evidence on one side only");
  await assert.rejects(b.bus.execute(reclass, RECON, { entry_set: good.entry_set, root_cause: good.root_cause }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "EVIDENCE_AND_CONFIDENCE", "confidence and evidence cannot be omitted");
  await b.bus.execute(reclass, RECON, good, ctx);
  assert.equal(ctx.ledger.sets().length, 1); assert.deepEqual(ctx.events.ofType("reconciliation_item.resolved").map((e) => e.payload.status), ["posted"]);
});
test("6.3-T7: Given a $312.50 bank analysis fee debited from the P&I account on 10/05, then corporate reimburses by 10/06 (1 BD), item cleared, fee re-billed to corporate ops.", async () => {
  const open = bankFeeReimbursement({ fee_cents: 31_250n, debited_on: D("2026-10-05"), custodial_account_id: "C-PI-AA", account_kind: "pi", reimbursed_on: null });
  assert.equal(open.reimburse_by, "2026-10-06"); assert.equal(open.item.category, "bank_fee"); assert.equal(open.item.status, "open"); assert.equal(open.item.amount_cents, -31_250n);
  const r = bankFeeReimbursement({ fee_cents: 31_250n, debited_on: D("2026-10-05"), custodial_account_id: "C-PI-AA", account_kind: "pi", reimbursed_on: D("2026-10-06") });
  assert.equal(r.item.status, "cleared"); assert.equal(r.cleared_on, "2026-10-06");
  assert.ok(postingSetBalanced(r.reimbursement)); assert.equal(r.reimbursement.lines.find((l) => l.account === "custodial_pi_cash:C-PI-AA")!.amount_cents, 31_250n); assert.equal(r.reimbursement.lines.find((l) => l.account === "corporate_cash")!.amount_cents, -31_250n);
  assert.deepEqual(r.rebill, { to: "corporate_ops", account: "corporate_bank_fee_expense", amount_cents: 31_250n, custodial_account_id: "C-PI-AA" });
  assert.equal(bankFeeReimbursement({ fee_cents: 31_250n, debited_on: D("2026-10-05"), custodial_account_id: "C-PI-AA", account_kind: "pi", reimbursed_on: D("2026-10-07") }).item.status, "overdue");
  assert.equal(residualCategory("560", "debit"), "bank_fee");
  // through the bus: the 560 debit on the 10/05 file opens the `bank_fee` item (reimburse by 10/06) and its aging clocks; the corporate reimbursement reclass on 10/06 clears it (item `cleared` satisfies AGE_30/60)
  const ctx = uow("2026-10-06T12:00:00.000Z"); const b = bus(ctx);
  const out = await b.run("bank.read_statement", RECON, { custodial_account_id: "C-PI-AA", file_id: "BAI2-1005", format: "bai2", as_of_date: "2026-10-05", credit_lines: [], summary_credits: 0n, debit_lines: [31_250n], summary_debits: 31_250n, lines: [{ id: "bsl-560-1", type_code: "560", direction: "debit", amount_cents: 31_250n, value_date: "2026-10-05" }] });
  const fee = (out.output as { items: { item_id: string; category: string; amount_cents: bigint; reimburse_by: string; reimbursement: { lines: { account: string; amount_cents: bigint }[] } }[] }).items[0]!;
  assert.equal(fee.category, "bank_fee"); assert.equal(fee.amount_cents, -31_250n); assert.equal(fee.reimburse_by, "2026-10-06"); assert.equal(fee.reimbursement.lines.find((l) => l.account === "corporate_cash")!.amount_cents, -31_250n);
  const age30 = ctx.timers.byCode("SM_RECON_ITEM_AGE_30")[0]!; assert.equal(age30.anchorDate, "2026-10-05"); assert.equal(age30.dueDate, "2026-11-04"); assert.equal(age30.status, "armed");
  await b.run("ledger.post_reclass", RECON, { entry_set: fundingSet("C-PI-AA", 31_250n, "2026-10-06", "corporate reimburses the 10/05 bank analysis fee", "6.3 rule 3 bank_fee"), root_cause: r.item.root_cause, confidence: 1, evidence_refs: ["bai2-1005-560", "bank-analysis-invoice-2026-09"], reconciliation_item_id: fee.item_id, item_status: "cleared", aggregate: ACCOUNT_AGG("C-PI-AA") });
  assert.equal(age30.status, "satisfied"); assert.equal(ctx.timers.byCode("SM_RECON_ITEM_AGE_60")[0]!.status, "satisfied"); assert.equal(ctx.ledger.balance({ scope: "custodial", custodialAccountId: "C-PI-AA", account: "custodial_pi_cash" }), 31_250n);
});
test("6.3-T8: Given a confirmed cash shortfall of $18,000.00 identified Mon 10/12, then `SM_CUSTODIAL_SHORTAGE_FUND_2BD.due_at` = Wed 10/14 17:00; approval tier `officer`; when funded 10/13 → satisfied; recovery reverses when the root cause (duplicate refund) is recovered.", async () => {
  const sf = shortageFunding(1_800_000n, D("2026-10-12")); assert.equal(sf.tier, "officer_1bd"); assert.equal(sf.due_on, "2026-10-14"); assert.equal(toIso(sf.due_at_ms), at("2026-10-14", "17:00"));
  // the Mon 10/12 daily close confirms the shortfall (bank after validated in-transit items < cashbook): `custodial.shortage.identified{identification=10/12}` arms the 2-BD row, the `cash_shortfall` item arms AGE_90
  const ctx = uow("2026-10-12T21:00:00.000Z"); const b = bus(ctx);
  const close = await b.run("timer.*", RECON, { op: "close_day", custodial_account_id: "C-PI-AA", as_of_date: "2026-10-12", section_i: { bank_closing_ledger_cents: 3_021_033n, deposits_in_transit_cents: 0n, disbursements_in_transit_cents: 0n, adjustments_cents: 0n }, cashbook_cents: 4_821_033n });
  const c = close.output as { status: string; difference_cents: bigint; shortfall: { item_id: string; amount_cents: bigint; tier: string; fund_by: string; fund_by_at: string; approval: string } };
  assert.equal(c.status, "exceptions_open"); assert.equal(c.difference_cents, -1_800_000n); assert.equal(c.shortfall.amount_cents, 1_800_000n); assert.equal(c.shortfall.tier, "officer_1bd"); assert.equal(c.shortfall.approval, "officer"); assert.equal(c.shortfall.fund_by, "2026-10-14"); assert.equal(c.shortfall.fund_by_at, at("2026-10-14", "17:00"));
  assert.deepEqual(types(ctx, "custodial."), ["custodial.shortage.identified", "custodial.reconciliation.daily_completed"]); assert.equal(ctx.events.ofType("custodial.shortage.identified")[0]!.payload.identification, "2026-10-12");
  const t = ctx.timers.byCode("SM_CUSTODIAL_SHORTAGE_FUND_2BD")[0]!; assert.equal(t.anchorDate, "2026-10-12"); assert.equal(t.dueDate, "2026-10-14"); assert.equal(wallClock(t.dueAt!, ET).date, "2026-10-14");   // the row's 17:00 is servicer-local (shortageFunding above computes it); the engine holds the day
  const age90 = ctx.timers.byCode("SM_RECON_ITEM_AGE_90_FUND_OR_CLEAR")[0]!; assert.equal(age90.dueDate, "2027-01-10"); assert.deepEqual(age90.subject, ITEM_AGG(c.shortfall.item_id));
  // funded Tue 10/13 by the officer (tier $1,000.01–$25,000.00) through `ledger.post_reclass` → `custodial.shortage.funded` satisfies the 2-BD row; the item `funded` satisfies AGE_30/60/90
  (ctx.clock as FixedClock).set("2026-10-13T18:00:00.000Z");
  const funded = await b.run("ledger.post_reclass", OFFICER, { entry_set: fundingSet("C-PI-AA", 1_800_000n, "2026-10-13", "corporate funds the 10/12 shortfall (officer approved)"), root_cause: "cash shortfall vs cashbook 10/12 — funded within 2 BD regardless of root cause (fiduciary rule); duplicate refund under research", confidence: 1, evidence_refs: ["bai2-1012", "cashbook-1012"], reconciliation_item_id: c.shortfall.item_id, item_status: "funded", amount_cents: 1_800_000n, approval_tier: "officer_1bd", aggregate: ACCOUNT_AGG("C-PI-AA") });
  assert.equal(t.status, "satisfied"); assert.equal(age90.status, "satisfied"); assert.equal(ctx.timers.byCode("SM_RECON_ITEM_AGE_30")[0]!.status, "satisfied");
  assert.equal(ctx.events.ofType("custodial.shortage.funded")[0]!.payload.approval_tier, "officer_1bd");
  assert.equal(ctx.ledger.balance({ scope: "custodial", custodialAccountId: "C-PI-AA", account: "custodial_pi_cash" }), 1_800_000n);
  const recovery = ctx.ledger.reverse((funded.output as { id: string }).id, D("2026-10-20"), "duplicate refund recovered from the payee");
  assert.equal(recovery.reversesSetId, (funded.output as { id: string }).id); assert.equal(ctx.ledger.balance({ scope: "custodial", custodialAccountId: "C-PI-AA", account: "custodial_pi_cash" }), 0n); assert.equal(ctx.ledger.balance({ scope: "corporate", account: "corporate_cash" }), 0n);
});
test("6.3-T9: Given the 18th falls on Sat 2026-07-18, then `FNMA_F120_SS_FUNDS_AVAILABLE_18TH.due_at` = Fri 2026-07-17 00:01 ET and coverage uses the 7/16 intraday available balance + same-day corporate top-up if short.", async () => {
  assert.equal(toIso(ssFundsAvailableMs(D("2026-07-01"))), at("2026-07-17", "00:01"));
  // the June P&I period close opens July's remittance schedule for the S/S MBS account: `period.opened{remittance_type=ss, period_start=2026-07-01}` → CD18 = Sat 7/18 → preceding Fannie Mae BD Fri 7/17, 00:01 ET
  const ctx = uow("2026-06-30T23:00:00.000Z"); const b = bus(ctx);
  const closed = await b.run("timer.*", RECON, { op: "close_period", period_end: "2026-06-30", account_kind: "pi", custodial_account_id: "C-PI-SS-MBS", remittance_type: "S/S MBS" });
  assert.deepEqual((closed.output as { remittance_period: unknown }).remittance_period, { period: "2026-07", period_start: "2026-07-01", remittance_type: "ss", draft_on: "2026-07-17", funds_available_at: at("2026-07-17", "00:01") });
  assert.equal(remittanceClass("S/S MRS"), "ss"); assert.equal(remittanceClass("S/A"), "sa"); assert.equal(remittanceClass("A/A"), "aa"); assert.equal(remittanceClass("escrow"), null);
  assert.deepEqual(types(ctx, "period."), ["period.opened"]); assert.equal(ctx.events.ofType("period.opened")[0]!.payload.period_start, "2026-07-01");
  const t = ctx.timers.byCode("FNMA_F120_SS_FUNDS_AVAILABLE_18TH")[0]!; assert.equal(t.anchorDate, "2026-07-01"); assert.equal(t.dueDate, "2026-07-17"); assert.equal(toIso(t.dueAt!), at("2026-07-17", "00:01"));
  assert.equal(ctx.timers.byCode("FNMA_F120_SA_FUNDS_AVAILABLE_20TH").length, 0, "an S/S account has no 20th draft");
  const c = draftCoverage({ expected_draft_cents: 123_300_000n, intraday_available_cents: 123_000_000n, as_of: D("2026-07-16") });
  assert.equal(c.covered, false); assert.equal(c.shortfall_cents, 300_000n); assert.equal(c.action, "corporate_top_up_same_day"); assert.equal(c.top_up_by, "2026-07-16"); assert.equal(c.balance_basis, "available_045_CLAV"); assert.deepEqual(c.escalation, { role: "officer", severity: "critical" });
  assert.equal(draftCoverage({ expected_draft_cents: 123_300_000n, intraday_available_cents: 123_300_000n, as_of: D("2026-07-16") }).covered, true);
  // the 7/16 intraday snapshot (camt.052 available balance) is $3,000.00 short → `coverage_short`, the same-day corporate top-up auto-prepared, officer critical; the timer stays armed
  (ctx.clock as FixedClock).set("2026-07-16T15:00:00.000Z");
  const short = await b.run("bank.read_statement", RECON, { custodial_account_id: "C-PI-SS-MBS", format: "camt052", as_of: "2026-07-16", remittance_type: "S/S MBS", expected_draft_cents: 123_300_000n, intraday_available_cents: 123_000_000n, draft_date: "2026-07-17" });
  const s = short.output as { covered: boolean; shortfall_cents: bigint; event: string; top_up: { by: string; tier: string; approval: string; posting: { lines: { account: string; amount_cents: bigint }[] } }; escalation: unknown };
  assert.equal(s.covered, false); assert.equal(s.shortfall_cents, 300_000n); assert.equal(s.event, "custodial.draft.coverage_short"); assert.equal(s.top_up.by, "2026-07-16"); assert.equal(s.top_up.tier, "officer_1bd"); assert.equal(s.top_up.approval, "officer"); assert.deepEqual(s.escalation, { role: "officer", severity: "critical" });
  assert.equal(s.top_up.posting.lines.find((l) => l.account === "custodial_pi_cash:C-PI-SS-MBS")!.amount_cents, 300_000n); assert.equal(s.top_up.posting.lines.find((l) => l.account === "corporate_cash")!.amount_cents, -300_000n);
  assert.equal(t.status, "armed");
  // after the top-up lands the same day the snapshot covers the draft → `custodial.draft.coverage_confirmed{remittance_type=ss}` satisfies the row
  const ok = await b.run("bank.read_statement", RECON, { custodial_account_id: "C-PI-SS-MBS", format: "camt052", as_of: "2026-07-16", remittance_type: "S/S MBS", expected_draft_cents: 123_300_000n, intraday_available_cents: 123_300_000n, draft_date: "2026-07-17" });
  assert.equal((ok.output as { event: string }).event, "custodial.draft.coverage_confirmed"); assert.equal(ctx.events.ofType("custodial.draft.coverage_confirmed")[0]!.payload.remittance_type, "ss");
  assert.equal(t.status, "satisfied");
  assert.deepEqual(types(ctx, "custodial.statement"), [], "an intraday snapshot is never the reconciliation of record");
});
test("6.3-T10: Given the statement file's 49-record total ≠ Σ 16 records, then `control_total_mismatch`, statement quarantined, bank re-request logged, daily recon closes with the item.", async () => {
  const bad = ingestStatement({ file_id: "BAI2-1007", credit_lines: [100000n, 250000n], summary_credits: 350000n, debit_lines: [482103300n], summary_debits: 484103300n });
  assert.equal(bad.ok, false); assert.equal(bad.exception, "control_total_mismatch"); assert.equal(bad.quarantined, true); assert.equal(bad.bank_rerequest_logged, true); assert.match(bad.daily_close_item!, /quarantined/);
  assert.equal(ingestStatement({ file_id: "BAI2-1008", credit_lines: [100000n, 250000n], summary_credits: 350000n, debit_lines: [482103300n], summary_debits: 482103300n }).ok, true);
  // through the bus: the file is quarantined (`custodial.statement.quarantined`, never `.received`), the item opened, and the 17:00 daily close closes the day carrying it
  const ctx = uow("2026-10-07T13:30:00.000Z"); const b = bus(ctx);
  ctx.events.append(dailyTick(D("2026-10-07"), "17:00"));
  const close5 = ctx.timers.byCode("SM_RECON_DAILY_CLOSE_5PM")[0]!; assert.equal(close5.dueDate, "2026-10-07"); assert.equal(close5.status, "armed");
  const q = await b.run("bank.read_statement", RECON, { custodial_account_id: "C-PI-AA", file_id: "BAI2-1007", format: "bai2", as_of_date: "2026-10-07", credit_lines: [100000n, 250000n], summary_credits: 350000n, debit_lines: [482103300n], summary_debits: 484103300n });
  const qo = q.output as { ok: boolean; quarantined: boolean; bank_rerequest_logged: boolean; event: string; item_id: string; statement_id: string };
  assert.equal(qo.ok, false); assert.equal(qo.quarantined, true); assert.equal(qo.bank_rerequest_logged, true); assert.equal(qo.event, "custodial.statement.quarantined");
  assert.equal(b.rt.store.get("bank_statements", qo.statement_id)!.data.control_totals_ok, false); assert.equal(b.rt.store.get("reconciliation_items", qo.item_id)!.data.category, "control_total_mismatch");
  assert.deepEqual(types(ctx, "custodial.statement"), ["custodial.statement.quarantined"]); assert.equal(ctx.events.ofType("reconciliation_item.opened")[0]!.payload.category, "control_total_mismatch");
  (ctx.clock as FixedClock).set("2026-10-07T21:00:00.000Z");
  const day = await b.run("timer.*", RECON, { op: "close_day", custodial_account_id: "C-PI-AA", as_of_date: "2026-10-07", section_i: { bank_closing_ledger_cents: 4_821_033n, deposits_in_transit_cents: 0n, disbursements_in_transit_cents: 0n, adjustments_cents: 0n }, cashbook_cents: 4_821_033n, carried_item_ids: [qo.item_id] });
  const d = day.output as { status: string; difference_cents: bigint; items_carried: string[]; shortfall: unknown };
  assert.equal(d.status, "exceptions_open"); assert.equal(d.difference_cents, 0n); assert.deepEqual(d.items_carried, [qo.item_id]); assert.equal(d.shortfall, null);
  assert.equal(ctx.events.ofType("custodial.reconciliation.daily_completed")[0]!.payload.status, "exceptions_open"); assert.equal(close5.status, "satisfied");
  assert.equal(b.rt.store.get("custodial_reconciliations", "daily-C-PI-AA-2026-10-07")!.data.kind, "daily_three_way");
});
test("6.3-T11: Given the reviewer run detects an item without a loan number, then status `rework`, not `approved`.", () => {
  const good = { id: "it-1", category: "deposit_in_transit", amount_cents: 1245000n, loan_id: "L-1", root_cause: "lockbox batch LBX-0930-07 credited 10/1", first_seen_on: D("2026-09-30"), evidence_refs: ["doc-1"] };
  const r = reviewerRun([good, { ...good, id: "it-2", loan_id: null }], { difference_cents: 0n, preparer_run_id: "run-p", posting_run_ids: ["run-x"] });
  assert.equal(r.status, "rework"); assert.deepEqual(r.findings, ["it-2: no loan number"]);
  assert.equal(reviewerRun([good], { difference_cents: 0n, preparer_run_id: "run-p", posting_run_ids: ["run-x"] }).status, "approved");
});
test("6.3-T12: Given `custodial.form496.human_approval = on` and no officer action in 3 BD after review, then reminder escalation; the 45-day timer is unaffected (it is satisfied only by `completed`).", () => {
  const r = approvalReminder({ human_approval_on: true, reviewed_on: D("2026-11-02"), officer_action_on: null, today: D("2026-11-06") });
  assert.equal(r.reminder_due_on, "2026-11-05"); assert.equal(r.reminder, true); assert.equal(r.form_timer_affected, false); assert.equal(r.form_timer_satisfied_by, "custodial.reconciliation.completed");
  assert.equal(approvalReminder({ human_approval_on: true, reviewed_on: D("2026-11-02"), officer_action_on: null, today: D("2026-11-05") }).reminder, false);
  assert.equal(approvalReminder({ human_approval_on: false, reviewed_on: D("2026-11-02"), officer_action_on: null, today: D("2026-11-20") }).reminder, false);
  const g = generateCustodialForm({ kind: "ss", period: "2026-09", custodial_account_id: "C-PI-SS-MBS", ...SEPT_SS, preparer_run_id: "run-prep", posting_run_ids: [], human_approval_on: true, complete: true });
  assert.equal(g.status, "under_review"); assert.deepEqual(g.events, ["custodial.reconciliation.drafted"], "no `completed` (and no timer satisfaction) until the officer approves");
  assert.equal(generateCustodialForm({ kind: "ss", period: "2026-09", custodial_account_id: "C-PI-SS-MBS", ...SEPT_SS, preparer_run_id: "run-prep", posting_run_ids: [], human_approval_on: true, officer_approval_id: "esc-42", complete: true }).status, "completed");
});
test("6.3-T13: Given a payment reversal posted 11/20 for a 10/28 receipt after the October form is completed, then the October form is unchanged, the November Section III carries the item with `first_seen_on = 10/28` (aging 23+ days).", () => {
  const r = retroCorrection({ completed_period_end: D("2026-10-31"), original_receipt_on: D("2026-10-28"), reversal_posted_on: D("2026-11-20"), amount_cents: 150000n, completed_form_version: 1 });
  assert.equal(r.completed_form_changed, false); assert.equal(r.completed_form_version, 1); assert.equal(r.carried_in_period, "2026-11");
  assert.equal(r.item.first_seen_on, "2026-10-28"); assert.equal(r.item.aging_days, 23); assert.equal(r.item.amount_cents, -150000n);
});
test("6.3-T14: Given LL-2026-05 A/A auto-draft flag on, then L1 logic switches and Form 472 timers are not started for A/A.", () => {
  const components = { L1_collected_not_remitted: 4_821_033n, L1_events_processed_draft_pending: 4_600_000n, L11_other: 1_000n };
  const on = aaLine1Logic({ autodraft_on: true, composition: components });
  assert.equal(on.line1_basis, "events_processed_draft_pending_2bd"); assert.equal(on.L1, 4_600_000n); assert.equal(on.L12, 4_601_000n); assert.equal(on.form472_timers_started, false); assert.deepEqual(on.form472_timers, []); assert.equal(on.settle_up_category, "fnma_settle_up");
  const off = aaLine1Logic({ autodraft_on: false, composition: components });
  assert.equal(off.line1_basis, "collected_not_remitted"); assert.equal(off.L1, 4_821_033n); assert.equal(off.L12, 4_822_033n); assert.equal(off.form472_timers_started, true); assert.deepEqual(off.form472_timers, ["FNMA_IRM102_SHORTAGE_REMIT_1BD", "FNMA_IRM102_SURPLUS_UNEXPLAINED_90"]); assert.equal(off.settle_up_category, null);
  assert.deepEqual(form472TimersFor({ remittance_type: "S/S", aa_autodraft_on: true }), ["FNMA_IRM102_SHORTAGE_REMIT_1BD", "FNMA_IRM102_SURPLUS_UNEXPLAINED_90"], "no remitting or draft changes for other remittance types");
  // the monthly job composes line 1 on the switched basis
  const aa = generateCustodialForm({ kind: "aa", period: "2026-12", custodial_account_id: "C-PI-AA", section_i: { bank_closing_ledger_cents: 4_601_000n, deposits_in_transit_cents: 0n, disbursements_in_transit_cents: 0n, adjustments_cents: 0n }, cashbook_cents: 4_601_000n, composition: components, section_iii: [], preparer_run_id: "p", posting_run_ids: [], aa_autodraft_on: true });
  assert.equal(aa.lines["II.1"], 4_600_000n); assert.equal(aa.total_cents, 4_601_000n);
});

test("6.3 rule 5 funding tiers: ≤ $1,000.00 agent auto-funds; $1,000.01–$25,000.00 officer within 1 BD; above $25,000.00 officer + partner + fraud; write-offs only in the ≤ $25.00 rounding class", async () => {
  assert.equal(shortageFunding(100000n, D("2026-10-08")).tier, "agent_auto");
  assert.equal(shortageFunding(100001n, D("2026-10-08")).tier, "officer_1bd");
  assert.equal(shortageFunding(2500000n, D("2026-10-08")).tier, "officer_1bd");
  assert.equal(shortageFunding(2500001n, D("2026-10-08")).tier, "officer_partner_fraud");
  assert.equal(RECON_WRITE_OFF_LIMIT_CENTS, 2500n);
  assert.equal(reconWriteOff({ amount_cents: 2500n, actor_is_officer: true, reason: "rounding residual" }).allowed, true);
  assert.match(reconWriteOff({ amount_cents: 2501n, actor_is_officer: true, reason: "rounding residual" }).refusal!, /\$25\.01 exceeds the \$25\.00 rounding class/);
  assert.match(reconWriteOff({ amount_cents: 100n, actor_is_officer: false, reason: "rounding" }).refusal!, /officer sign-off/);
  assert.match(reconWriteOff({ amount_cents: 100n, actor_is_officer: true, reason: " " }).refusal!, /reason/);
  const ctx = uow(); const b = bus(ctx); const reclass = b.cmds.get(toolKey("6.3", "ledger.post_reclass"))!;
  const wo = (amount: bigint) => ({ entry_set: { effectiveDate: "2026-10-07", description: "write-off", lines: [{ account: { scope: "custodial", custodialAccountId: "C-PI-AA", account: "custodial_pi_cash" }, amountCents: amount, ruleRef: "6.3 rule 5" }, { account: { scope: "corporate", account: "corporate_bank_fee_expense" }, amountCents: -amount, ruleRef: "6.3 rule 5" }] }, root_cause: "rounding residual on a lockbox batch", confidence: 1, evidence_refs: ["bai2", "cashbook"], reconciliation_item_id: "rd-1", item_status: "written_off", amount_cents: amount });
  await assert.rejects(b.bus.execute(reclass, RECON, wo(100n), ctx), (e: unknown) => e instanceof CommandRefused && e.code === "RECON_WRITE_OFF_25");
  await assert.rejects(b.bus.execute(reclass, OFFICER, wo(2501n), ctx), (e: unknown) => e instanceof CommandRefused && e.code === "RECON_WRITE_OFF_25");
  await b.bus.execute(reclass, OFFICER, wo(2500n), ctx);
  assert.equal(ctx.ledger.sets().length, 1);
});

test("6.3 timer table SM_RECON_DAILY_FEED_10AM: the 10:00 recurring row is satisfied only when every active P&I account's prior-day file has passed control totals (`custodial.statement.received{all_active_accounts=true}`), and re-arms for the next business day", async () => {
  const ctx = uow("2026-10-07T12:00:00.000Z"); const b = bus(ctx);
  b.rt.store.put("custodial_accounts", "C-PI-AA", { kind: "pi", status: "active" }, RECON, ctx.clock.now()); b.rt.store.put("custodial_accounts", "C-PI-SS-MBS", { kind: "pi", status: "active" }, RECON, ctx.clock.now()); b.rt.store.put("custodial_accounts", "C-PI-OLD", { kind: "pi", status: "closed" }, RECON, ctx.clock.now());
  ctx.events.append(dailyTick(D("2026-10-07"), "10:00"));
  const feed = ctx.timers.byCode("SM_RECON_DAILY_FEED_10AM"); assert.equal(feed.length, 1); assert.equal(feed[0]!.dueDate, "2026-10-07"); assert.equal(feed[0]!.status, "armed");
  const file = (account: string, file_id: string, closing: bigint) => ({ custodial_account_id: account, file_id, format: "bai2", as_of_date: "2026-10-06", credit_lines: [closing], summary_credits: closing, debit_lines: [], summary_debits: 0n, closing_ledger_cents: closing });
  const first = await b.run("bank.read_statement", RECON, file("C-PI-AA", "BAI2-AA-1006", 4_821_033n));
  assert.equal((first.output as { all_active_accounts: boolean; balance_of_record_cents: bigint }).all_active_accounts, false); assert.equal((first.output as { balance_of_record_cents: bigint }).balance_of_record_cents, 4_821_033n);
  assert.equal(feed[0]!.status, "armed", "one of two active accounts is not every active account");
  const second = await b.run("bank.read_statement", RECON, file("C-PI-SS-MBS", "BAI2-SS-1006", 125_430_055n));
  assert.equal((second.output as { all_active_accounts: boolean }).all_active_accounts, true);
  assert.deepEqual(ctx.events.ofType("custodial.statement.received").map((e) => e.payload.all_active_accounts), [false, true]);
  assert.equal(feed[0]!.status, "satisfied"); assert.equal(ctx.timers.byCode("SM_RECON_DAILY_FEED_10AM").length, 2, "a recurring row re-arms on satisfaction");
  await assert.rejects(b.run("bank.read_statement", RECON, { custodial_account_id: "C-PI-AA", format: "sheet", as_of_date: "2026-10-06", credit_lines: [], summary_credits: 0n, debit_lines: [], summary_debits: 0n }), RangeError);
  await assert.rejects(b.run("bank.read_statement", RECON, {}), RangeError);
});

test("6.3 timer table FNMA_IRM102_SURPLUS_UNEXPLAINED_90: a Schedule 3 surplus (5.2 `fnma.shortage_surplus.surplus_identified{first_seen_on}`) is due explained in 90 calendar days; the documented `ledger.post_reclass{surplus_id}` appends `fnma.shortage_surplus.explained` and satisfies it", async () => {
  const ctx = uow("2026-10-05T18:00:00.000Z"); const b = bus(ctx);
  ctx.events.append({ type: "fnma.shortage_surplus.surplus_identified", aggregate: PERIOD_AGG("2026-09"), actor: SYSTEM, payload: { period: "2026-09", remittance_type: "A/A", surplus_id: "ss-2026-09-aa", amount_cents: 20_000n, first_seen_on: "2026-10-05" } });
  const t = ctx.timers.byCode("FNMA_IRM102_SURPLUS_UNEXPLAINED_90")[0]!; assert.equal(t.anchorDate, "2026-10-05"); assert.equal(t.dueDate, "2027-01-03"); assert.deepEqual(t.subject, PERIOD_AGG("2026-09"));
  const reclass = { entry_set: reclassSet("Fannie Mae over-draft $200.00 on loan 1234567890 refunded per C-3-01 documented claim", 20_000n), root_cause: "Fannie Mae adjustment for corrected LAR (5.1 correction 10/02) — Fannie Mae's error, refund claim C-3-01 paid 10/20", confidence: 0.99, evidence_refs: ["lsdu-adj-2026-10", "crs-refund-2026-10-20"], surplus_id: "ss-2026-09-aa", period: "2026-09", remittance_type: "A/A", amount_cents: 20_000n, aggregate: PERIOD_AGG("2026-09") };
  await assert.rejects(b.run("ledger.post_reclass", RECON, { ...reclass, root_cause: "unexplained" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_PLUG");
  assert.equal(t.status, "armed");
  (ctx.clock as FixedClock).set("2026-10-20T18:00:00.000Z");
  await b.run("ledger.post_reclass", RECON, reclass);
  const ex = ctx.events.ofType("fnma.shortage_surplus.explained"); assert.equal(ex.length, 1); assert.equal(ex[0]!.payload.surplus_id, "ss-2026-09-aa"); assert.equal(ex[0]!.payload.explained_on, "2026-10-20"); assert.equal(ex[0]!.payload.posting_set_id, ctx.ledger.sets()[0]!.id);
  assert.equal(t.status, "satisfied");
});

test("6.3 timer table FNMA_LL202605_AA_PREDRAFT_COVERAGE_1BD: the A/A pre-draft notification (5.2 `fnma.draft_notification.received{kind=predraft, draft_date}`) is due covered draft date − 1 Fannie Mae BD 15:00 ET; the intraday coverage check confirms it on the notification's period", async () => {
  const ctx = uow("2026-10-05T11:00:00.000Z"); const b = bus(ctx);
  ctx.events.append({ type: "fnma.draft_notification.received", aggregate: PERIOD_AGG("2026-10"), actor: SYSTEM, payload: { notification_id: "dn-aa-1007", kind: "predraft", source: "api", period: "2026-10", servicer_number: "123456789", remittance_code: "001", draft_date: "2026-10-07", amount_cents: 4_821_033n, custodial_account_id: "C-PI-AA" } });
  ctx.events.append({ type: "fnma.draft_notification.received", aggregate: PERIOD_AGG("2026-10"), actor: SYSTEM, payload: { notification_id: "dn-bd3", kind: "bd3", period: "2026-10", draft_date: "2026-10-20", amount_cents: 1n } });
  const t = ctx.timers.byCode("FNMA_LL202605_AA_PREDRAFT_COVERAGE_1BD"); assert.equal(t.length, 1, "only the pre-draft notification arms the LL-2026-05 row");
  assert.equal(t[0]!.anchorDate, "2026-10-07"); assert.equal(t[0]!.dueDate, "2026-10-06"); assert.equal(toIso(t[0]!.dueAt!), at("2026-10-06", "15:00"));
  (ctx.clock as FixedClock).set("2026-10-06T14:00:00.000Z");
  const out = await b.run("bank.read_statement", RECON, { custodial_account_id: "C-PI-AA", format: "bai2_intraday", as_of: "2026-10-06", remittance_type: "A/A", period: "2026-10", notification_id: "dn-aa-1007", draft_date: "2026-10-07", expected_draft_cents: 4_821_033n, intraday_available_cents: 4_946_033n });
  assert.equal((out.output as { covered: boolean; remittance_type: string }).covered, true); assert.equal((out.output as { remittance_type: string }).remittance_type, "aa");
  const ev = ctx.events.ofType("custodial.draft.coverage_confirmed")[0]!; assert.deepEqual(ev.aggregate, PERIOD_AGG("2026-10")); assert.equal(ev.payload.notification_id, "dn-aa-1007"); assert.equal(ev.payload.draft_date, "2026-10-07");
  assert.equal(t[0]!.status, "satisfied");
});

test("6.3 timer table SM_FNMA_CONNECT_REMIT_DETAIL_PULL_2BD: the Fannie Mae reporting-period close (5.1/5.2 `investor_reporting_periods.closed{bd2_following}`) gives 2 Fannie Mae BD to pull the Remittance P&I Detail report; `documents.write{kind=fnma_remittance_pi_detail}` validates it, records line 9's source document and appends `fnma.remittance_detail.report_received`", async () => {
  const ctx = uow("2026-10-02T21:00:00.000Z"); const b = bus(ctx);
  ctx.events.append({ type: "investor_reporting_periods.closed", aggregate: PERIOD_AGG("2026-09"), actor: SYSTEM, payload: { period: "2026-09", period_end: "2026-09-30", bd2_following: "2026-10-02", servicer_number: "123456789", checklist_complete: true } });
  const t = ctx.timers.byCode("SM_FNMA_CONNECT_REMIT_DETAIL_PULL_2BD")[0]!; assert.equal(t.anchorDate, "2026-10-02"); assert.equal(t.dueDate, "2026-10-06"); assert.deepEqual(t.subject, PERIOD_AGG("2026-09"));
  const sha = "3f".repeat(32);
  const report = { kind: "fnma_remittance_pi_detail", period: "2026-09", servicer_number: "123456789", remittance_type: "S/S MBS", custodial_account_id: "C-PI-SS-MBS", sha256: sha, rows: [{ fnma_loan_number: "1234567890", pi_receivable_cents: 100_000_000n }, { fnma_loan_number: "1234567891", pi_receivable_cents: 23_300_000n }] };
  await assert.rejects(b.run("documents.write", RECON, { id: "rpd-2026-09", data: { ...report, sha256: "" } }), /sha256/);
  await assert.rejects(b.run("documents.write", RECON, { id: "rpd-2026-09", data: { ...report, rows: [] } }), /rows/);
  await assert.rejects(b.run("documents.write", RECON, { id: "rpd-2026-09", data: { ...report, servicer_number: "12345" } }), /servicer_number/);
  assert.equal(t.status, "armed");
  (ctx.clock as FixedClock).set("2026-10-05T15:00:00.000Z");
  const out = await b.run("documents.write", RECON, { id: "rpd-2026-09", data: report });
  const o = out.output as { fnma_receivable_cents: bigint; fnma_receivable_source_document_id: string; row_count: number; line: string };
  assert.equal(o.fnma_receivable_cents, 123_300_000n, "worked example 7: L9 Fannie Mae P&I receivable $1,233,000.00"); assert.equal(o.fnma_receivable_source_document_id, "rpd-2026-09"); assert.equal(o.row_count, 2); assert.equal(o.line, "II.9");
  assert.equal(b.rt.store.get("documents", "rpd-2026-09")!.data.sha256, sha);
  const ev = ctx.events.ofType("fnma.remittance_detail.report_received")[0]!; assert.deepEqual(ev.aggregate, PERIOD_AGG("2026-09")); assert.equal(ev.payload.fnma_receivable_cents, 123_300_000n);
  assert.equal(t.status, "satisfied");
  const plain = await b.run("documents.write", RECON, { id: "memo-1", data: { kind: "memo", text: "package cover" } });
  assert.equal((plain.output as { kind: string }).kind, "memo"); assert.equal(ctx.events.ofType("fnma.remittance_detail.report_received").length, 1);
});
