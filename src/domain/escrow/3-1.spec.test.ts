// 3.1 Initial escrow account statement
// spec/sections/03-escrow-administration/3-1-initial-escrow-account-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { cents } from "../../kernel/money/cents.ts";
import { project, settlementDepositCeiling } from "./analysis.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, type EventStore } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { initialStatementStatus, establishmentStatement, statementChannel, biweeklyTrialBalance, vendorFallback, recordStatementSent } from "./ops.ts";
import { readBoardingFile, verifyInitialStatementEvidence, transferInInitialStatement, transferInFacts } from "./ops-3-1.ts";
import { escrowContinuityDecision, type TransferorEscrowAnalysis } from "../transfers/ops-1-6.ts";
const E = [{ line_type: "school_tax", amount_cents: cents("360"), disburse_on: D("2026-09-15") }, { line_type: "county_tax", amount_cents: cents("500"), disburse_on: D("2026-07-15") }, { line_type: "county_tax", amount_cents: cents("700"), disburse_on: D("2026-12-15") }];
const A = [{ line_type: "county_tax", amount_cents: cents("520"), disburse_on: D("2027-07-15") }, { line_type: "county_tax", amount_cents: cents("760"), disburse_on: D("2027-12-15") }, { line_type: "school_tax", amount_cents: cents("380"), disburse_on: D("2027-09-15") }];
const ESCROW = { kind: "agent", id: "escrow" } as const;
const TEMPLATE = "NTC_REGX_1024_17G_INITIAL_ESCROW_STMT";

/** An event store with the 3.1 rows of the (overridden) registry armed by the TimerEngine, as the platform runs them. */
function harness(now: string) { const clock = new FixedClock(now); const events = new MemoryEventStore(clock); const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["3.1"] }); return { clock, events, engine }; }
/** Section 1.1's `loan.boarded` (payload `boarded_at`, the ESC_BOARDING_EVIDENCE_CHECK_5BD anchor) for an escrowed loan. */
const board = (events: EventStore, loanId: string, boardedAt: string) => events.append({ type: "loan.boarded", loanId, aggregate: { kind: "transfer_batch", id: "B-1" }, actor: { kind: "agent", id: "boarding" }, payload: { loan_id: loanId, boarded_at: boardedAt, escrowed: true } });
const only = <T>(xs: readonly T[]): T => { assert.equal(xs.length, 1); return xs[0]!; };
const transferor: TransferorEscrowAnalysis = { analysis_date: D("2026-06-01"), computation_year_start: D("2026-07-01"), monthly_escrow_cents: 41_000n, cushion_cents: 8_200n, shortage_cents: 0n, surplus_cents: 0n, deficiency_cents: 0n, shortage_spread_months: null, method: "aggregate" };

test("3.1-T1: Given a loan boarded 10 days after settlement with originator statement evidence dated at settlement, when boarding completes, then status = `satisfied_by_originator` and no timer instance is created.", () => {
  const r = initialStatementStatus({ settlement_date: D("2026-09-01"), boarded_on: D("2026-09-11"), originator_statement_delivered_on: D("2026-09-01") });
  assert.equal(r.status, "satisfied_by_originator"); assert.equal(r.timer, null); assert.equal(r.qc_finding, null);
  // Boarding completes: `loan.boarded` arms the 5-servicer-BD evidence check; the check finds the originator's statement and closes it with `escrow.initial_statement.evidence_verified`.
  const { events, engine } = harness("2026-09-11T14:00:00.000Z");
  board(events, "L-1", "2026-09-11T14:00:00.000Z");
  const check = only(engine.byCode("ESC_BOARDING_EVIDENCE_CHECK_5BD")); assert.equal(check.status, "armed"); assert.equal(check.anchorDate, "2026-09-11"); assert.equal(check.dueDate, addBusinessDays(D("2026-09-11"), 5, servicer)); assert.equal(check.dueDate, "2026-09-18");
  const b = readBoardingFile(events, { loan_id: "L-1", boarded_on: D("2026-09-11"), settlement_date: D("2026-09-01"), evidence: { document_id: "DOC-IES-1", delivered_on: D("2026-09-01") } }, ESCROW);
  assert.equal(b.kind, "settlement"); assert.equal(b.status, "satisfied_by_originator"); assert.equal(b.timer, null); assert.equal(b.qc_finding, null);
  assert.equal(b.event.type, "escrow.initial_statement.evidence_verified"); assert.equal(b.event.loanId, "L-1"); assert.equal(b.event.payload.evidence_document_id, "DOC-IES-1"); assert.equal(b.event.payload.delivered_on, "2026-09-01"); assert.equal(b.event.payload.settlement_date, "2026-09-01");
  assert.ok(eventMatches(loadOverriddenRegistry().get("ESC_BOARDING_EVIDENCE_CHECK_5BD")!.satisfiedPattern!, b.event));
  assert.equal(check.status, "satisfied"); assert.equal(check.satisfiedByEventId, b.event.id);
  assert.equal(engine.byCode("REGX_1024_17G_INITIAL_STMT_45").length, 0);   // no timer instance is created — the fact is not `escrow.initial_statement.required`
  assert.equal(events.ofType("escrow.initial_statement.required").length, 0);
  // Rule 1: a document without a delivery date is not evidence; evidence dated after the 45-day window (settlement + 46) does not satisfy (g)(1).
  assert.throws(() => verifyInitialStatementEvidence(events, { loan_id: "L-1", settlement_date: D("2026-09-01"), boarded_on: D("2026-09-11"), evidence: { document_id: "DOC-X", delivered_on: "" as never } }, ESCROW), RangeError);
  assert.equal(initialStatementStatus({ settlement_date: D("2026-09-01"), boarded_on: D("2026-10-20"), originator_statement_delivered_on: addDays(D("2026-09-01"), 46) }).status, "required");
});
test("3.1-T2: Given no evidence and settlement 2026-09-01, when boarded 2026-09-15, then timer due 2026-10-16 23:59 (property TZ) and a statement is sent by then; `loan_events` has `escrow.statement.sent`.", () => {
  const r = initialStatementStatus({ settlement_date: D("2026-09-01"), boarded_on: D("2026-09-15"), originator_statement_delivered_on: null });
  assert.equal(r.status, "required"); assert.equal(r.timer!.code, "REGX_1024_17G_INITIAL_STMT_45"); assert.equal(r.timer!.due_on, "2026-10-16"); assert.equal(r.timer!.breached_at_boarding, false);   // 23:59 property TZ
  assert.equal(r.send_by, "2026-10-16");
  const { clock, events, engine } = harness("2026-09-15T14:00:00.000Z");
  board(events, "L-1", "2026-09-15T14:00:00.000Z");
  const check = only(engine.byCode("ESC_BOARDING_EVIDENCE_CHECK_5BD")); assert.equal(check.dueDate, "2026-09-22");   // Tue Sep 15 + 5 servicer BD
  // No evidence → `escrow.initial_statement.required{reason=settlement}` anchored on `settlement_date`: the 45-day row arms, due 2026-10-16 23:59 (ET = 03:59Z on the 17th), and the boarding check is closed by the same fact.
  const b = readBoardingFile(events, { loan_id: "L-1", boarded_on: D("2026-09-15"), settlement_date: D("2026-09-01"), evidence: null }, ESCROW);
  assert.equal(b.kind, "settlement"); assert.equal(b.status, "required"); assert.deepEqual(b.timer, { code: "REGX_1024_17G_INITIAL_STMT_45", due_on: "2026-10-16", breached_at_boarding: false });
  assert.equal(b.event.type, "escrow.initial_statement.required"); assert.equal(b.event.payload.reason, "settlement"); assert.equal(b.event.payload.settlement_date, "2026-09-01"); assert.equal(b.event.payload.due_on, "2026-10-16"); assert.equal(b.event.payload.breached_at_boarding, false);
  assert.equal(check.status, "satisfied");
  const t45 = only(engine.byCode("REGX_1024_17G_INITIAL_STMT_45")); assert.equal(t45.status, "armed"); assert.equal(t45.anchorDate, "2026-09-01"); assert.equal(t45.dueDate, "2026-10-16"); assert.equal(new Date(t45.dueAt!).toISOString(), "2026-10-17T03:59:00.000Z");
  assert.equal(engine.byCode("REGX_1024_17E_TRANSFER_INITIAL_STMT_60").length, 0);   // settlement is not the transfer-in code's trigger
  // A statement is sent by then (Oct 10): the send is the `escrow.statement.sent{statement_type=initial}` fact that satisfies the row.
  clock.set("2026-10-10T15:00:00.000Z");
  const sent = recordStatementSent(events, { loan_id: "L-1", template: TEMPLATE, statement_type: "initial", sent_on: D("2026-10-10"), due_on: r.timer!.due_on, actor: SYSTEM });
  assert.equal(sent.satisfied_on_time, true);
  const e = only(events.ofType("escrow.statement.sent")); assert.equal(e.loanId, "L-1"); assert.equal(e.payload.template, TEMPLATE); assert.equal(e.payload.statement_type, "initial");
  assert.equal(t45.status, "satisfied"); assert.equal(t45.satisfiedByEventId, e.id);
  assert.equal(engine.evaluate("2026-10-17T04:00:00.000Z").length, 0);   // nothing breaches after the deadline passes
  assert.deepEqual(events.all().filter((x) => x.loanId === "L-1" && !x.type.startsWith("timer.")).map((x) => x.type), ["loan.boarded", "escrow.initial_statement.required", "escrow.statement.sent"]);   // the audit chain required → sent
  assert.equal(recordStatementSent(events, { loan_id: "L-1", template: TEMPLATE, statement_type: "initial", sent_on: D("2026-10-17"), due_on: r.timer!.due_on, actor: SYSTEM }).satisfied_on_time, false);   // a day late
});
test("3.1-T3: Given the Appendix E lines (Sep $360; Jul $500; Dec $700; first payment Jul 1), when the initial analysis runs with cushion 2 months, then base payment = $130.00, cushion = $260.00, starting balance ceiling = $1,040.00, December projected balance = $260.00.", () => {
  const p = project(E, D("2026-07-01"), { policy_months: 2 });
  assert.equal(p.base_payment_cents, 13_000n); assert.equal(p.cushion_cents, 26_000n); assert.equal(p.cushion_source, "policy");
  assert.equal(settlementDepositCeiling(p), 104_000n); assert.equal(p.target_at_start_cents, 104_000n);   // starting balance ceiling
  assert.equal(p.targets[5], 26_000n);                                                                  // December projected balance
});
test("3.1-T4: Given settlement 2026-08-10 and boarding 2026-10-01 with no evidence, when boarded, then the statement is sent within 1 business day and the timer is recorded `breached` with `waiver_reason='inherited_from_originator'` and a `qc_finding` case exists.", () => {
  const r = initialStatementStatus({ settlement_date: D("2026-08-10"), boarded_on: D("2026-10-01"), originator_statement_delivered_on: null });
  assert.equal(r.send_by, "2026-10-02");                                        // within 1 business day
  assert.deepEqual(r.timer, { code: "REGX_1024_17G_INITIAL_STMT_45", due_on: "2026-09-24", breached_at_boarding: true, waiver_reason: "inherited_from_originator" });
  assert.equal(r.qc_finding, "originator_failed_g1");
  // Boarded after the window: the required fact carries the inherited-breach marks, the row arms already overdue (Sep 24) and breaches on the boarding-day evaluation (sev-2 to the escrow lead); the Oct 2 send closes it late.
  const { clock, events, engine } = harness("2026-10-01T14:00:00.000Z");
  board(events, "L-1", "2026-10-01T14:00:00.000Z");
  const b = readBoardingFile(events, { loan_id: "L-1", boarded_on: D("2026-10-01"), settlement_date: D("2026-08-10") }, ESCROW);
  assert.equal(b.kind, "settlement"); assert.equal(b.qc_finding, "originator_failed_g1"); assert.equal(b.send_by, "2026-10-02");
  assert.equal(b.event.payload.breached_at_boarding, true); assert.equal(b.event.payload.waiver_reason, "inherited_from_originator"); assert.equal(b.event.payload.qc_finding, "originator_failed_g1"); assert.equal(b.event.payload.send_by, "2026-10-02");
  const t45 = only(engine.byCode("REGX_1024_17G_INITIAL_STMT_45")); assert.equal(t45.dueDate, "2026-09-24"); assert.equal(t45.status, "armed");
  const breaches = engine.evaluate("2026-10-01T14:00:00.000Z"); assert.equal(breaches.length, 1);
  assert.equal(breaches[0]!.instance.code, "REGX_1024_17G_INITIAL_STMT_45"); assert.equal(breaches[0]!.severity, 2); assert.deepEqual(breaches[0]!.escalateTo, ["escrow"]); assert.equal(t45.status, "breached");
  assert.equal(only(events.ofType("timer.breached")).payload.code, "REGX_1024_17G_INITIAL_STMT_45");
  assert.equal(only(engine.byCode("ESC_BOARDING_EVIDENCE_CHECK_5BD")).status, "satisfied");   // the evidence check itself was done on time
  clock.set("2026-10-02T15:00:00.000Z");
  recordStatementSent(events, { loan_id: "L-1", template: TEMPLATE, statement_type: "initial", sent_on: D("2026-10-02"), due_on: D("2026-09-24"), actor: SYSTEM });
  assert.equal(t45.status, "satisfied_late"); assert.equal(only(events.ofType("timer.satisfied").filter((e) => e.payload.code === "REGX_1024_17G_INITIAL_STMT_45")).payload.late, true);
});
test("3.1-T5: Given a transfer-in effective 2026-11-01 where the new escrow payment differs by $0.01, when transfer completes, then `REGX_1024_17E_TRANSFER_INITIAL_STMT_60` is due 2026-12-31 and `computation_year_start` = 2026-11-01.", () => {
  const r = establishmentStatement("transfer_in_changed", D("2026-11-01"), 1n);
  assert.deepEqual(r, { timer: "REGX_1024_17E_TRANSFER_INITIAL_STMT_60", due_on: "2026-12-31", computation_year_start: "2026-11-01" });
  assert.deepEqual(establishmentStatement("transfer_in_changed", D("2026-11-01"), 0n), { timer: null, computation_year_start: "retained" });
  // Transfer completes: §1.6's continuity decision finds the $0.01 change and emits `escrow.terms.changed_at_transfer{transfer_date}` — the row's trigger; 60 calendar days from the effective date is Dec 31.
  const { clock, events, engine } = harness("2026-11-01T14:00:00.000Z");
  const d = escrowContinuityDecision(events, { loan_id: "L-1", batch_id: "B-1", transfer_date: D("2026-11-01"), decided_on: D("2026-11-01"), transferor, supermortgage: { monthly_escrow_cents: 41_001n } }, ESCROW);
  assert.equal(d.decision, "new_year"); assert.equal(d.payment_changed, true); assert.equal(d.method_changed, false);
  const trigger = only(events.ofType("escrow.terms.changed_at_transfer")); assert.ok(eventMatches(loadOverriddenRegistry().get("REGX_1024_17E_TRANSFER_INITIAL_STMT_60")!.triggerPattern!, trigger));
  const t60 = only(engine.byCode("REGX_1024_17E_TRANSFER_INITIAL_STMT_60")); assert.equal(t60.status, "armed"); assert.equal(t60.anchorDate, "2026-11-01"); assert.equal(t60.dueDate, "2026-12-31"); assert.equal(t60.dueDate, addDays(D("2026-11-01"), 60));
  // 3.1 reads the boarding file: the decision on the loan's log routes it to reason='transfer_in' with the computation year from the transfer date ((e)(1)(i)); the 45-day code is not armed by it.
  board(events, "L-1", "2026-11-01T14:00:00.000Z");
  assert.deepEqual(transferInFacts(events, "L-1"), { transfer_date: "2026-11-01", payment_changed: true, accounting_method_changed: false, decision: "new_year", source_event_id: events.ofType("escrow.computation_year.decided")[0]!.id });
  const b = readBoardingFile(events, { loan_id: "L-1", boarded_on: D("2026-11-01") }, ESCROW);
  assert.equal(b.kind, "transfer_in"); if (b.kind !== "transfer_in") return;
  assert.deepEqual(b.timer, { code: "REGX_1024_17E_TRANSFER_INITIAL_STMT_60", due_on: "2026-12-31" }); assert.equal(b.computation_year_start, "2026-11-01");
  assert.equal(b.event.type, "escrow.initial_statement.required"); assert.equal(b.event.payload.reason, "transfer_in"); assert.equal(b.event.payload.computation_year_start, "2026-11-01"); assert.equal(b.event.payload.due_on, "2026-12-31"); assert.equal(b.event.causationId, transferInFacts(events, "L-1")!.source_event_id);
  assert.equal(engine.byCode("REGX_1024_17G_INITIAL_STMT_45").length, 0); assert.equal(only(engine.byCode("ESC_BOARDING_EVIDENCE_CHECK_5BD")).status, "satisfied");
  assert.equal(engine.evaluate("2026-12-31T23:00:00.000Z").length, 0);   // 23:59 ET on Dec 31 is 04:59Z Jan 1
  clock.set("2026-12-15T15:00:00.000Z");
  recordStatementSent(events, { loan_id: "L-1", template: TEMPLATE, statement_type: "initial", sent_on: D("2026-12-15"), due_on: D("2026-12-31"), actor: SYSTEM });
  assert.equal(t60.status, "satisfied");
  // Unchanged payment and method: no `escrow.terms.changed_at_transfer`, nothing arms, and the transfer-in path refuses — the transferor's computation year continues ((e)(1)(ii)).
  const same = escrowContinuityDecision(events, { loan_id: "L-2", batch_id: "B-1", transfer_date: D("2026-11-01"), decided_on: D("2026-11-01"), transferor, supermortgage: { monthly_escrow_cents: 41_000n } }, ESCROW);
  assert.equal(same.decision, "retained"); assert.equal(events.ofType("escrow.terms.changed_at_transfer").filter((e) => e.loanId === "L-2").length, 0); assert.equal(engine.byCode("REGX_1024_17E_TRANSFER_INITIAL_STMT_60").length, 1);
  assert.throws(() => transferInInitialStatement(events, { loan_id: "L-2", transfer_date: D("2026-11-01"), payment_changed: false, accounting_method_changed: false }, ESCROW), RangeError);
  const kept = readBoardingFile(events, { loan_id: "L-2", boarded_on: D("2026-11-01") }, ESCROW);
  assert.equal(kept.kind, "transfer_in_retained"); assert.equal(kept.status, "satisfied_by_originator"); assert.equal(kept.event.type, "escrow.initial_statement.evidence_verified"); assert.equal(kept.event.payload.basis, "transferor_computation_year_retained");
  assert.equal(engine.byCode("REGX_1024_17G_INITIAL_STMT_45").length, 0);
  // A method-only change (single-item transferor; (c)(4) makes aggregate mandatory) is the same 60-day duty.
  const m = transferInInitialStatement(events, { loan_id: "L-3", transfer_date: D("2026-11-01"), payment_changed: false, accounting_method_changed: true }, ESCROW);
  assert.equal(m.timer.due_on, "2026-12-31"); assert.equal(m.event.payload.accounting_method_changed, true);
});
test("3.1-T6: Given a waiver revocation on 2026-10-05 (3.8), when the account is established, then `REGX_1024_17G_INITIAL_STMT_45` due 2026-11-19 and an Escrow Setup investor event is queued before any deposit event.", () => {
  const r = establishmentStatement("established", D("2026-10-05"), { balance_cents: -252_000n, first_deposit: { amount_cents: 41_000n, on: D("2026-11-01") } });
  assert.equal(r.timer, "REGX_1024_17G_INITIAL_STMT_45"); assert.equal(r.due_on, "2026-11-19");
  assert.deepEqual(r.events_in_order, ["EscrowSetup", "deposit"]);                                       // order is the event ledger's sequence
  assert.deepEqual(r.events.map((e) => [e.item, e.sequence, e.balance_cents]), [["Set up", 1, -252_000n], ["Loan Escrow Payment", 2, -211_000n]]);
  assert.ok(r.events[0]!.sequence < r.events[1]!.sequence); assert.equal(r.events[0]!.deadline_at, "2026-10-06");   // next fannie_et BD 03:00 ET
  assert.deepEqual(establishmentStatement("established", D("2026-10-05")).events_in_order, ["EscrowSetup"]);   // no deposit yet → only the Setup is queued
  // The 3.8 revocation path's fact (`escrow.initial_statement.required{reason=post_settlement}`) arms the same code: revocation day + 45 = Nov 19.
  const { events, engine } = harness("2026-10-05T14:00:00.000Z");
  events.append({ type: "escrow.initial_statement.required", loanId: "L-1", actor: ESCROW, payload: { reason: "post_settlement", established_at: "2026-10-05", due_on: r.due_on } });
  const t45 = only(engine.byCode("REGX_1024_17G_INITIAL_STMT_45")); assert.equal(t45.anchorDate, "2026-10-05"); assert.equal(t45.dueDate, "2026-11-19");
});
test("3.1-T7: Given valid E-SIGN consent for class `escrow_statements`, when sent, then channel = electronic with receipt evidence; given consent revoked the day before, then channel = mail.", () => {
  assert.deepEqual(statementChannel({ class: "escrow_statements", given_on: D("2026-01-10") }, D("2026-10-10")), { channel: "electronic", receipt_evidence_required: true });
  assert.deepEqual(statementChannel({ class: "escrow_statements", given_on: D("2026-01-10"), revoked_on: D("2026-10-09") }, D("2026-10-10")), { channel: "mail", receipt_evidence_required: false });
  assert.equal(statementChannel({ class: "periodic_statements", given_on: D("2026-01-10") }, D("2026-10-10")).channel, "mail");
});
test("3.1-T8: Given a biweekly loan, when analyzed, then the trial balance has 26 rows and the per-period escrow amount × 26 = annual disbursements ± $0.26.", () => {
  const b = biweeklyTrialBalance(A, D("2027-07-01"));
  assert.equal(b.rows, 26); assert.equal(b.per_period_cents, 6_385n); assert.equal(b.within_tolerance, true);   // 26 × $63.85 = $1,660.10 vs $1,660.00
  assert.equal(b.projection.periods, 26);
});
test("3.1-T9: Given the print vendor rejects the file, when retried 3× and still failing 2 days before due, then an in-house mail fallback is used and an escalation sev-3 is logged.", () => {
  assert.deepEqual(vendorFallback({ attempts: 3, due_on: D("2026-10-16"), today: D("2026-10-14") }), { fallback: "in_house_mail", escalation: "sev3", retry: false });
  assert.deepEqual(vendorFallback({ attempts: 2, due_on: D("2026-10-16"), today: D("2026-10-14") }), { fallback: null, escalation: null, retry: true });
  assert.deepEqual(vendorFallback({ attempts: 3, due_on: D("2026-10-16"), today: D("2026-10-05") }), { fallback: null, escalation: null, retry: false });
});
