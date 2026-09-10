// 9.5 Force-placed cancellation/refund
// spec/sections/09-insurance-property-protection/9-5-force-placed-cancellation-refund.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, dayOfWeek, addDays } from "../../kernel/calendar/date.ts";
import { cancellation, dailyRate, overlapDays, overlapPremium, fnmaRemittanceDue, servicerNetCost, type LpiTerm } from "./refund.ts";
import { refundTimeline } from "./ops.ts";
import { reconcileCarrierRefund, ingestLpiCancelAck, lpiRemovalSet, lpiRefundPaymentSet, carrierRefundSet, officerBreachRisk, CARRIER_REFUND_RECON_DAYS } from "./ops-9-5.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { CommandContext } from "../../app/commands.ts";
import { SECTION_09_TOOLS } from "../../app/tools/section09.ts";
import { FakeLpiTracking, type LpiBinding, type LpiTrackingPort } from "../../infra/integrations/property.ts";

const TERM: LpiTerm = { effective: D("2026-10-01"), expiration: D("2027-10-01"), premium_cents: 219000n };
const AGENT: Actor = { kind: "agent", id: "insurance-property" };
const tool = (name: string) => SECTION_09_TOOLS.find((t) => t.process === "9.5" && t.name === name)!;
const reg = () => loadOverriddenRegistry();
const def = (code: string) => reg().unique().find((t) => t.code === code)!;

/** One loan's runtime: event store + engine (9.5 and the 15.2 remittance control) + ledger + escalations, clock at `nowIso`. */
function rig(loanId: string, nowIso: string, processes: readonly string[] = ["9.5"], lpi?: LpiTrackingPort) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const timers = new TimerEngine(reg(), events, { processes: [...processes] });
  const escalations = new EscalationService(events, clock);
  const rt: ToolRuntime = { store: new EntityStore(), ports: lpi ? { lpi } : {}, escalations, services: {} };
  const ctx = (at?: string): CommandContext => { if (at) clock.set(at); return { actor: AGENT, now: clock.now(), loanId, events, ledger, timers, clock } as unknown as CommandContext; };
  return { clock, events, ledger, timers, escalations, rt, ctx };
}
const BASE = { terms: [TERM], borrower_coverage_start: "2026-12-15", borrower_coverage_end: null, evidence_received_on: "2027-01-12" } as const;

test("9.5-T1: Given LPI 2026-10-01→2027-10-01 at $2,190.00 and evidence received 2027-01-12 of coverage from 2026-12-15 Then overlap 290 days, $1,740.00 removed, retained $450.00, deadline 2027-01-27.", async () => {
  assert.equal(dailyRate(TERM).toFixed(6), "600.000000");
  assert.equal(overlapDays(TERM, D("2026-12-15"), null), 290); assert.equal(overlapPremium(TERM, 290), 174000n);
  const r = cancellation({ terms: [TERM], borrower_coverage_start: D("2026-12-15"), borrower_coverage_end: null, evidence_received_on: D("2027-01-12"), borrower_paid_cents: 0n });
  assert.equal(r.overlap_days, 290); assert.equal(r.removed_cents, 174000n); assert.equal(r.retained_cents, 45000n); assert.equal(r.deadline, "2027-01-27"); assert.equal(r.cancellation_effective, "2026-12-15");
  assert.equal(r.removed_cents + r.retained_cents, 219000n);
  // The agent's computeOverlapRefund tool is the same calculator; the 15-day clock arms on receipt (Tue 2027-01-12 + 15 calendar days = Wed 2027-01-27) and the 2-BD evaluation SLA on Thu 2027-01-14.
  const { events, timers, rt, ctx } = rig("L-T1", "2027-01-12T15:00:00.000Z");
  const viaTool = (await tool("computeOverlapRefund").handler({ ...BASE, borrower_paid_cents: 0n }, ctx(), rt)) as typeof r;
  assert.equal(viaTool.overlap_days, 290); assert.equal(viaTool.removed_cents, 174000n); assert.equal(viaTool.retained_cents, 45000n); assert.equal(viaTool.deadline, "2027-01-27");
  events.append({ type: "insurance.evidence.received", loanId: "L-T1", actor: AGENT, payload: { fpi_active: true, kind: "hazard", evidence_id: "ev-1", receipt: "2027-01-12" } });
  const clock15 = timers.byCode("REGX_1024_37G_FPI_CANCEL_REFUND_15")[0]!; const eval2 = timers.byCode("INS_FPI_EVIDENCE_EVAL_2BD")[0]!;
  assert.equal(clock15.dueDate, "2027-01-27"); assert.equal(clock15.status, "armed"); assert.equal(eval2.dueDate, "2027-01-14"); assert.equal(eval2.status, "armed");
  const ev = (await tool("evaluateEvidence").handler({ evidence_id: "ev-1", continuous_coverage_shown: true, written: true }, ctx("2027-01-13T15:00:00.000Z"), rt)) as { outcome: string };
  assert.equal(ev.outcome, "confirmed"); assert.equal(eval2.status, "satisfied"); assert.equal(clock15.status, "armed");   // confirmation fits inside the 15-day window, which keeps running from receipt
});
test("9.5-T2: Given the borrower paid $600.00 toward the charge Then $150.00 refunded and $300.00 remains due.", async () => {
  const r = cancellation({ terms: [TERM], borrower_coverage_start: D("2026-12-15"), borrower_coverage_end: null, evidence_received_on: D("2027-01-12"), borrower_paid_cents: 60000n });
  assert.equal(r.refund_cents, 15000n);                                                                // paid 600 − retained 450
  // The spec's "$300.00 remains due" contradicts its own arithmetic: $600 paid against a $450 retained charge leaves nothing owed (docs/AUDIT-NOTES.md 9.5-T2).
  assert.equal(r.still_due_cents, 0n);
  assert.equal(cancellation({ terms: [TERM], borrower_coverage_start: D("2026-12-15"), borrower_coverage_end: null, evidence_received_on: D("2027-01-12"), borrower_paid_cents: 15000n }).still_due_cents, 30000n);   // $150 paid → $300 remains due
  // Two-sided correction on the ledger (rule 3/6): the 9.2 advance (Dr corporate_advance 219,000) less the $600 paid, then postRefund's reversal set
  // Cr corporate_advance 174,000 / Dr lpi_refund_expense→advance_receivable 174,000, then payRefund's ACH Dr corporate_advance 15,000 / Cr corporate_cash 15,000 → the loan account nets to zero.
  const { ledger, events, rt, ctx } = rig("L-T2", "2027-01-20T15:00:00.000Z");
  const loanAdv = { scope: "loan", loanId: "L-T2", account: "corporate_advance" } as const;
  const charge = ledger.post({ effectiveDate: D("2026-10-01"), description: "LPI premium advanced at binding", lines: [{ account: loanAdv, amountCents: 219000n, ruleRef: "9.2 rule 7" }, { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -219000n, ruleRef: "9.2 rule 7" }] });
  ledger.post({ effectiveDate: D("2026-12-01"), description: "borrower payment applied to the LPI charge", lines: [{ account: loanAdv, amountCents: -60000n, ruleRef: "2.x application" }, { account: { scope: "corporate", account: "corporate_cash" }, amountCents: 60000n, ruleRef: "2.x application" }] });
  const posted = (await tool("postRefund").handler({ ...BASE, borrower_paid_cents: 60000n, binding_id: "B-2", ledger_set_id: charge.id }, ctx(), rt)) as { removed_cents: bigint; refund_cents: bigint; still_due_cents: bigint; ledger_set_id: string; ledger: string[] };
  assert.equal(posted.removed_cents, 174000n); assert.equal(posted.refund_cents, 15000n); assert.equal(posted.still_due_cents, 0n);
  const rev = ledger.sets().find((s) => s.id === posted.ledger_set_id)!;
  assert.equal(rev.reversesSetId, charge.id); assert.equal(rev.lines.reduce((a, l) => a + l.amountCents, 0n), 0n); assert.ok(rev.lines.every((l) => l.ruleRef.startsWith("9.5 rule 3(a)")));
  assert.deepEqual(posted.ledger, ["Cr corporate_advance 174000", "Dr advance_receivable 174000"]);
  assert.equal(ledger.balance(loanAdv), -15000n);                                                    // credit balance = the $150 owed back to the borrower
  events.append({ type: "fpi.lpi.cancelled", loanId: "L-T2", actor: AGENT, payload: { binding_id: "B-2", effective: "2026-12-15", track: "regx_hazard", on_books: true, carrier_ack: "pending" } });
  const paid = (await tool("payRefund").handler({ ...BASE, binding_id: "B-2", refund_cents: 15000n, rail: "ach" }, ctx(), rt)) as { paid: boolean; ledger_set_id: string };
  assert.equal(paid.paid, true); const out = ledger.sets().find((s) => s.id === paid.ledger_set_id)!;
  assert.equal(out.lines.reduce((a, l) => a + l.amountCents, 0n), 0n); assert.equal(ledger.balance(loanAdv), 0n); assert.equal(ledger.balance({ scope: "corporate", account: "corporate_cash" }), -219000n + 60000n - 15000n);
  // The retained $450 gap charge stays on the account when the borrower paid only $150: still_due $300 (7.1 statement), and no cash moves for an escrow credit.
  const partial = (await tool("computeOverlapRefund").handler({ ...BASE, borrower_paid_cents: 15000n }, ctx(), rt)) as { still_due_cents: bigint; refund_cents: bigint };
  assert.equal(partial.still_due_cents, 30000n); assert.equal(partial.refund_cents, 0n);
  assert.equal(lpiRefundPaymentSet({ loan_id: "L-T2", refund_cents: 15000n, effective: D("2027-01-20"), rail: "escrow_credit" }), null);
});
test("9.5-T3: Given carrier ack arrives on day 20 Then borrower refund still paid by day 15; sev-3 vendor follow-up only.", async () => {
  const input = { terms: [{ effective: D("2026-10-01"), expiration: D("2027-10-01"), premium_cents: 219000n }], borrower_coverage_start: D("2026-12-15"), borrower_coverage_end: null, evidence_received_on: D("2027-01-12"), borrower_paid_cents: 60000n, deadline_days: 15 as const };
  const t = refundTimeline(input, D("2027-02-01"), D("2027-01-26"));
  assert.equal(t.borrower_refund_by, "2027-01-27"); assert.equal(t.refund_on_time, true); assert.equal(t.carrier_ack_late, true); assert.equal(t.vendor_followup, "sev3"); assert.equal(t.result.refund_cents, 15000n);
  assert.equal(refundTimeline(input, D("2027-01-20"), null).vendor_followup, null);
  // REGX_1024_37G_FPI_CANCEL_REFUND_15 is satisfied by the servicer's own cancellation + refund on day 14 — the carrier's ack on day 20 plays no part.
  // The carrier acks without a refund figure at request time (ack pending) — the servicer cancels on its books anyway.
  const pendingAck: LpiTrackingPort = { sendLoanFile: async () => ({ fileId: "f", duplicate: false }), inbound: async () => [], bind: async () => { throw new Error("unused"); },
    cancel: async (bindingId, cancelledOn): Promise<LpiBinding> => ({ bindingId, vendorLoanId: "V-1", coverageCents: 30000000n, effectiveOn: "2026-10-01", annualPremiumCents: 219000n, cancelledOn }) };
  const { events, timers, escalations, rt, ctx } = rig("L-1", "2027-01-12T15:00:00.000Z", ["9.5"], pendingAck);
  events.append({ type: "insurance.evidence.received", loanId: "L-1", actor: AGENT, payload: { fpi_active: true, kind: "hazard", evidence_id: "ev-1" } });
  const inst = timers.byCode("REGX_1024_37G_FPI_CANCEL_REFUND_15")[0]!;
  assert.equal(inst.dueDate, "2027-01-27"); assert.equal(inst.status, "armed");
  const req = (await tool("requestLpiCancel").handler({ loan_id: "L-1", binding_id: "B-1", cancelled_on: "2026-12-15" }, ctx("2027-01-13T15:00:00.000Z"), rt)) as { cancelled_on_books: boolean; carrier_refund: unknown };
  assert.equal(req.cancelled_on_books, true); assert.equal(req.carrier_refund, null);
  const recon = timers.byCode("INS_FPI_CARRIER_REFUND_RECON_45")[0]!;
  assert.equal(recon.status, "armed"); assert.equal(recon.anchorDate, "2027-01-13"); assert.equal(recon.dueDate, addDays(D("2027-01-13"), CARRIER_REFUND_RECON_DAYS)); assert.equal(recon.dueDate, "2027-02-27");
  const paid = (await tool("payRefund").handler({ loan_id: "L-1", binding_id: "B-1", refund_cents: 15000n, rail: "ach" }, ctx("2027-01-26T15:00:00.000Z"), rt)) as { lpi_cancelled_on_books: boolean; timer_satisfied: string | null };
  assert.equal(paid.lpi_cancelled_on_books, true); assert.equal(paid.timer_satisfied, "REGX_1024_37G_FPI_CANCEL_REFUND_15");
  assert.ok(events.ofType("fpi.lpi.cancelled_and_refunded").some((e) => (e.payload as { track: string }).track === "regx_hazard"));
  assert.equal(inst.status, "satisfied"); assert.equal(inst.satisfiedAt, "2027-01-26T15:00:00.000Z");
  assert.deepEqual(timers.evaluate("2027-02-01T15:00:00.000Z").filter((b) => b.def.code === "REGX_1024_37G_FPI_CANCEL_REFUND_15"), []);   // day 20 carrier ack: the 15-day clock does not breach
  // Day 20 (2027-02-01): the carrier's refund_advice arrives short-rated ($1,700.00) — reconciled against the $1,740.00 removed; $40.00 is the servicer's cost, never the borrower's.
  ctx("2027-02-01T15:00:00.000Z");
  const rc = reconcileCarrierRefund({ events, actor: AGENT, escalations }, { loan_id: "L-1", binding_id: "B-1", advice_id: "ADV-1", carrier: "lpi", carrier_refund_cents: 170000n, received_on: D("2027-02-01"), short_rate: true, removed_cents: 174000n });
  assert.equal(rc.duplicate, false); assert.equal(rc.servicer_cost_cents, 4000n); assert.equal(rc.on_time, true); assert.equal(rc.recon_deadline, "2027-02-27"); assert.equal(rc.fnma_remit_due, null);
  const reconciled = events.ofType("fpi.carrier_refund.reconciled").at(-1)!;
  assert.ok(eventMatches(def("INS_FPI_CARRIER_REFUND_RECON_45").satisfiedPattern!, reconciled)); assert.equal(recon.status, "satisfied"); assert.equal(recon.satisfiedByEventId, reconciled.id);
  assert.deepEqual(escalations.opened.map((e) => e.kind), []);                                           // within 45 days: no vendor follow-up from reconciliation itself
  assert.equal(reconcileCarrierRefund({ events, actor: AGENT }, { loan_id: "L-1", binding_id: "B-1", advice_id: "ADV-1", carrier: "lpi", carrier_refund_cents: 170000n, received_on: D("2027-02-02") }).duplicate, true);   // idempotent per advice
  assert.equal(events.ofType("fpi.carrier_refund.reconciled").length, 1);
  // A refund paid before the cancellation is on the books does not satisfy the clock.
  const two = rig("L-2", "2027-01-12T15:00:00.000Z");
  two.events.append({ type: "insurance.evidence.received", loanId: "L-2", actor: AGENT, payload: { fpi_active: true, kind: "hazard" } });
  const early = (await tool("payRefund").handler({ loan_id: "L-2", refund_cents: 15000n, rail: "ach" }, two.ctx("2027-01-26T15:00:00.000Z"), two.rt)) as { lpi_cancelled_on_books: boolean };
  assert.equal(early.lpi_cancelled_on_books, false); assert.equal(two.timers.byCode("REGX_1024_37G_FPI_CANCEL_REFUND_15")[0]!.status, "armed");
});
test("9.5-T4: Given a 366-day term and 100-day overlap Then $598.36.", () => {
  const leap: LpiTerm = { effective: D("2027-05-01"), expiration: D("2028-05-01"), premium_cents: 219000n };
  assert.equal(dailyRate(leap).toFixed(6), "598.360656");
  assert.equal(overlapPremium(leap, 100), 59836n);                                                      // 59,836.0656 → $598.36
});
test("9.5-T5: Given evidence received Friday 2027-01-15 Then deadline 2027-01-30 (Saturday) — refund must post by then; the sweep treats it as a calendar deadline.", async () => {
  assert.equal(dayOfWeek(D("2027-01-15")), 5);
  const r = cancellation({ terms: [TERM], borrower_coverage_start: D("2026-12-15"), borrower_coverage_end: null, evidence_received_on: D("2027-01-15"), borrower_paid_cents: 0n });
  assert.equal(r.deadline, "2027-01-30"); assert.equal(dayOfWeek(r.deadline), 6);                       // calendar days: no roll to Monday
  // The engine's sweep: the clock armed on Friday's receipt is due Saturday 2027-01-30 and breaches on Sunday's sweep — it does not roll to Monday 2027-02-01.
  const late = rig("L-T5a", "2027-01-15T15:00:00.000Z");
  late.events.append({ type: "insurance.evidence.received", loanId: "L-T5a", actor: AGENT, payload: { fpi_active: true, kind: "hazard", evidence_id: "ev-5", receipt: "2027-01-15" } });
  const inst = late.timers.byCode("REGX_1024_37G_FPI_CANCEL_REFUND_15")[0]!;
  assert.equal(inst.dueDate, "2027-01-30"); assert.equal(dayOfWeek(inst.dueDate!), 6);
  const sweep = (at: string) => late.timers.evaluate(at).map((b) => b.def.code).filter((c) => c === "REGX_1024_37G_FPI_CANCEL_REFUND_15");   // the unevaluated evidence also breaches INS_FPI_EVIDENCE_EVAL_2BD on this loan — not this T-id's subject
  assert.deepEqual(sweep("2027-01-30T23:00:00.000Z"), []);                                                // still Saturday in ET: not yet breached
  assert.deepEqual(sweep("2027-01-31T15:00:00.000Z"), ["REGX_1024_37G_FPI_CANCEL_REFUND_15"]);
  assert.equal(inst.status, "breached");
  // Cancelled and refunded on Saturday 2027-01-30 → satisfied on time.
  const onTime = rig("L-T5b", "2027-01-15T15:00:00.000Z");
  onTime.events.append({ type: "insurance.evidence.received", loanId: "L-T5b", actor: AGENT, payload: { fpi_active: true, kind: "hazard", evidence_id: "ev-5", receipt: "2027-01-15" } });
  onTime.events.append({ type: "fpi.lpi.cancelled", loanId: "L-T5b", actor: AGENT, payload: { binding_id: "B-5", effective: "2026-12-15", track: "regx_hazard", on_books: true, carrier_ack: "pending" } });
  const paid = (await tool("payRefund").handler({ loan_id: "L-T5b", binding_id: "B-5", refund_cents: 15000n, rail: "ach", evidence_received_on: "2027-01-15" }, onTime.ctx("2027-01-30T15:00:00.000Z"), onTime.rt)) as { paid_on: string; timer_satisfied: string | null; breach_risk_reported: boolean };
  assert.equal(paid.paid_on, "2027-01-30"); assert.equal(paid.timer_satisfied, "REGX_1024_37G_FPI_CANCEL_REFUND_15"); assert.equal(paid.breach_risk_reported, true);   // day 15 > day 12 unpaid until now → officer breach-risk report, but the payment still goes out
  assert.equal(onTime.timers.byCode("REGX_1024_37G_FPI_CANCEL_REFUND_15")[0]!.status, "satisfied");
  assert.deepEqual(onTime.timers.evaluate("2027-02-02T15:00:00.000Z").map((b) => b.def.code).filter((c) => c === "REGX_1024_37G_FPI_CANCEL_REFUND_15"), []);
  assert.deepEqual(onTime.escalations.opened.map((e) => [e.kind, e.ownerRole]), [["officer", "officer"]]);
});
test("9.5-T6: Given a Fannie Mae claim already paid for the LPI premium Then a 15.2 remittance task within 30 days of the carrier refund.", () => {
  assert.equal(fnmaRemittanceDue(D("2027-02-10"), true), "2027-03-12");
  assert.equal(fnmaRemittanceDue(D("2027-02-10"), false), null);
  // Rule 5: the carrier's refund_advice on a premium Fannie Mae already reimbursed → 15.2's CRS 336 control armed on the receipt date, due 30 days later, and a portal task for the operator.
  const { events, timers, escalations, ledger } = rig("L-T6", "2027-02-10T15:00:00.000Z", ["9.5", "15.2"]);
  events.append({ type: "fpi.lpi.cancel_requested", loanId: "L-T6", actor: AGENT, payload: { binding_id: "B-6", effective: "2026-12-15", track: "regx_hazard", request: "2027-01-13" } });
  events.append({ type: "fpi.refund.posted", loanId: "L-T6", actor: AGENT, payload: { removed_cents: 174000n, refund_cents: 15000n, binding_id: "B-6" } });
  const rc = reconcileCarrierRefund({ events, actor: AGENT, escalations, ledger }, { loan_id: "L-T6", binding_id: "B-6", advice_id: "ADV-6", carrier: "lpi", carrier_refund_cents: 170000n, received_on: D("2027-02-10"), fnma_claim_paid: true, fnma_claim_id: "CLM-6" });
  assert.equal(rc.fnma_remit_due, "2027-03-12"); assert.equal(rc.removed_cents, 174000n); assert.equal(rc.servicer_cost_cents, 4000n); assert.equal(rc.on_time, true);
  const credit = events.ofType("expense_claim.credit.received").at(-1)!;
  assert.ok(eventMatches(def("FNMA_F105_MI_REFUND_336_30").triggerPattern!, credit));
  const remit = timers.byCode("FNMA_F105_MI_REFUND_336_30")[0]!;
  assert.equal(remit.status, "armed"); assert.equal(remit.anchorDate, "2027-02-10"); assert.equal(remit.dueDate, "2027-03-12");
  assert.deepEqual(escalations.opened.map((e) => [e.kind, e.ownerRole, (e.payload as { due: string }).due]), [["human_portal_task", "fnma_portal_operator", "2027-03-12"]]);
  const set = ledger.sets().find((s) => s.id === rc.ledger_set_id)!;
  assert.equal(set.lines.reduce((a, l) => a + l.amountCents, 0n), 0n); assert.equal(ledger.balance({ scope: "corporate", account: "corporate_cash" }), 170000n);
  assert.equal(timers.byCode("INS_FPI_CARRIER_REFUND_RECON_45")[0]!.status, "satisfied");
  // No claim paid → no 15.2 control and no task.
  const none = rig("L-T6b", "2027-02-10T15:00:00.000Z", ["9.5", "15.2"]);
  none.events.append({ type: "fpi.lpi.cancel_requested", loanId: "L-T6b", actor: AGENT, payload: { binding_id: "B-6", effective: "2026-12-15", track: "regx_hazard", request: "2027-01-13" } });
  assert.equal(reconcileCarrierRefund({ events: none.events, actor: AGENT, escalations: none.escalations }, { loan_id: "L-T6b", binding_id: "B-6", advice_id: "ADV-6", carrier: "lpi", carrier_refund_cents: 170000n, received_on: D("2027-02-10") }).fnma_remit_due, null);
  assert.equal(none.timers.byCode("FNMA_F105_MI_REFUND_336_30").length, 0); assert.deepEqual(none.escalations.opened, []);
});
test("9.5-T7: Given evidence effective before the LPI effective date Then full removal, full refund, `servicer_error` root-cause record.", async () => {
  const e = cancellation({ terms: [TERM], borrower_coverage_start: D("2026-09-15"), borrower_coverage_end: null, evidence_received_on: D("2027-01-12"), borrower_paid_cents: 219000n });
  assert.equal(e.overlap_days, 365); assert.equal(e.removed_cents, 219000n); assert.equal(e.retained_cents, 0n); assert.equal(e.refund_cents, 219000n); assert.equal(e.root_cause, "servicer_error");
  assert.equal(cancellation({ terms: [TERM], borrower_coverage_start: D("2026-12-15"), borrower_coverage_end: null, evidence_received_on: D("2027-01-12"), borrower_paid_cents: 0n }).root_cause, "borrower_evidence");
  // The posting records the root cause on the `fpi.refund.posted` event and removes the whole premium.
  const { events, ledger, rt, ctx } = rig("L-T7", "2027-01-13T15:00:00.000Z");
  const posted = (await tool("postRefund").handler({ ...BASE, borrower_coverage_start: "2026-09-15", borrower_paid_cents: 219000n, binding_id: "B-7" }, ctx(), rt)) as { removed_cents: bigint; refund_cents: bigint; root_cause: string };
  assert.equal(posted.removed_cents, 219000n); assert.equal(posted.refund_cents, 219000n); assert.equal(posted.root_cause, "servicer_error");
  assert.equal((events.ofType("fpi.refund.posted").at(-1)!.payload as { root_cause: string; cancellation_effective: string }).root_cause, "servicer_error");
  assert.equal((events.ofType("fpi.refund.posted").at(-1)!.payload as { cancellation_effective: string }).cancellation_effective, "2026-10-01");   // never before the LPI effective date
  assert.equal(ledger.balance({ scope: "loan", loanId: "L-T7", account: "corporate_advance" }), -219000n);
});

test("9.5 worked example: $2,190.00 LPI, evidence 2027-01-12 for coverage from 2026-12-15 → 290 days overlap, $1,740.00 removed, $450.00 retained, $150.00 refunded of the $600.00 paid; carrier short-rate $1,700.00 → servicer cost $40.00", () => {
  const r = cancellation({ terms: [{ effective: D("2026-10-01"), expiration: D("2027-10-01"), premium_cents: 219000n }], borrower_coverage_start: D("2026-12-15"), borrower_coverage_end: null, evidence_received_on: D("2027-01-12"), borrower_paid_cents: 60000n, deadline_days: 15 });
  assert.equal(r.overlap_days, 290); assert.equal(r.removed_cents, 174000n); assert.equal(r.retained_cents, 45000n); assert.equal(r.refund_cents, 15000n); assert.equal(r.still_due_cents, 0n); assert.equal(r.deadline, "2027-01-27");   // paid $600 > retained $450 → nothing remains due (the spec's "$300 stays due" remark contradicts its own 600 − 450 arithmetic)
  assert.equal(servicerNetCost(174000n, 170000n), 4000n); assert.equal(45000n + 174000n, 219000n);
  // Rule 6 ledger sets, balanced with rule_ref: removal (non-escrowed and escrowed variants) and the carrier's short-rate refund.
  const removal = lpiRemovalSet({ loan_id: "L-W", removed_cents: 174000n, effective: D("2026-12-15"), escrowed: false, binding_id: "B-W" });
  assert.deepEqual(removal.lines.map((l) => [l.account.account, l.amountCents]), [["corporate_advance", -174000n], ["advance_receivable", 174000n]]);
  const escrowed = lpiRemovalSet({ loan_id: "L-W", removed_cents: 174000n, effective: D("2026-12-15"), escrowed: true, custodial_ti: "C-TI" });
  assert.deepEqual(escrowed.lines.map((l) => [l.account.account, l.amountCents]), [["escrow", -174000n], ["custodial_ti_cash", 174000n]]);
  const carrier = carrierRefundSet(D("2027-02-01"), "B-W", "ADV-W", 170000n);
  assert.deepEqual(carrier.lines.map((l) => [l.account.account, l.amountCents]), [["corporate_cash", 170000n], ["advance_receivable", -170000n]]);
  const ledger = new MemoryLedger(); ledger.post(removal); ledger.post(carrier);
  assert.equal(ledger.balance({ scope: "corporate", account: "advance_receivable" }), 4000n);           // the $40.00 short-rate residual is the servicer's cost
  assert.throws(() => lpiRemovalSet({ loan_id: "L-W", removed_cents: 0n, effective: D("2026-12-15"), escrowed: false }), RangeError);
  assert.throws(() => carrierRefundSet(D("2027-02-01"), "B-W", "ADV-W", 0n), RangeError);
});

test("9.5 carrier refund_advice: the cancel ack that carries the refund figure is ingested as the advice (INS_FPI_CARRIER_REFUND_RECON_45 armed by the request and satisfied by the reconciliation); a late advice is a sev-3 vendor follow-up; a bad record is refused", async () => {
  const lpi = new FakeLpiTracking(); const bound = await lpi.bind("V-9", 30000000n, "2026-10-01", "2026-10-01T15:00:00.000Z");
  const { events, timers, escalations, rt, ctx } = rig("L-A", "2027-01-13T15:00:00.000Z", ["9.5"], lpi);
  const req = (await tool("requestLpiCancel").handler({ loan_id: "L-A", binding_id: bound.bindingId, cancelled_on: "2026-12-15" }, ctx(), rt)) as { carrier_refund: { duplicate: boolean; carrier_refund_cents: bigint; on_time: boolean } | null };
  assert.ok(req.carrier_refund); assert.equal(req.carrier_refund.duplicate, false); assert.equal(req.carrier_refund.on_time, true);
  assert.equal(req.carrier_refund.carrier_refund_cents, bound.annualPremiumCents - bound.annualPremiumCents * 75n / 365n);   // the fake carrier's pro-rata figure for 75 earned days
  const requested = events.ofType("fpi.lpi.cancel_requested").at(-1)!; assert.equal((requested.payload as { request: string }).request, "2027-01-13");
  assert.ok(eventMatches(def("INS_FPI_CARRIER_REFUND_RECON_45").triggerPattern!, requested));
  const recon = timers.byCode("INS_FPI_CARRIER_REFUND_RECON_45")[0]!;
  assert.equal(recon.dueDate, "2027-02-27"); assert.equal(recon.status, "satisfied"); assert.equal(recon.satisfiedByEventId, events.ofType("fpi.carrier_refund.reconciled").at(-1)!.id);
  assert.equal(ingestLpiCancelAck({ events, actor: AGENT }, { loan_id: "L-A", binding: { ...bound, cancelledOn: "2026-12-15" }, received_on: D("2027-01-13") }), null);   // an ack without a figure is not an advice
  // Day 50: the advice arrives after the 45-day window → reconciled late, sev-3 vendor follow-up (breach column: "sev-3; vendor follow-up").
  const lateRig = rig("L-B", "2027-01-13T15:00:00.000Z");
  lateRig.events.append({ type: "fpi.lpi.cancel_requested", loanId: "L-B", actor: AGENT, payload: { binding_id: "B-L", effective: "2026-12-15", track: "regx_hazard", request: "2027-01-13" } });
  const armed = lateRig.timers.byCode("INS_FPI_CARRIER_REFUND_RECON_45")[0]!;
  assert.deepEqual(lateRig.timers.evaluate("2027-02-28T15:00:00.000Z").map((b) => b.def.code), ["INS_FPI_CARRIER_REFUND_RECON_45"]);
  lateRig.clock.set("2027-03-04T15:00:00.000Z");
  const rc = reconcileCarrierRefund({ events: lateRig.events, actor: AGENT, escalations: lateRig.escalations }, { loan_id: "L-B", binding_id: "B-L", advice_id: "ADV-L", carrier: "lpi", carrier_refund_cents: 170000n, received_on: D("2027-03-04"), removed_cents: 174000n });
  assert.equal(rc.on_time, false); assert.equal(armed.status, "satisfied_late");
  assert.deepEqual(lateRig.escalations.opened.map((e) => [e.kind, e.severity]), [["sev3", "sev3"]]);
  // Validation: no request to reconcile against, empty ids, negative or non-bigint money.
  assert.throws(() => reconcileCarrierRefund({ events: lateRig.events }, { loan_id: "L-B", binding_id: "B-X", advice_id: "ADV-X", carrier: "lpi", carrier_refund_cents: 1n, received_on: D("2027-03-04") }), /no LPI cancel request/);
  assert.throws(() => reconcileCarrierRefund({ events: lateRig.events }, { loan_id: "", binding_id: "B-L", advice_id: "ADV-X", carrier: "lpi", carrier_refund_cents: 1n, received_on: D("2027-03-04") }), RangeError);
  assert.throws(() => reconcileCarrierRefund({ events: lateRig.events }, { loan_id: "L-B", binding_id: "B-L", advice_id: "ADV-X", carrier: "lpi", carrier_refund_cents: -1n, received_on: D("2027-03-04") }), RangeError);
  assert.throws(() => reconcileCarrierRefund({ events: lateRig.events }, { loan_id: "L-B", binding_id: "B-L", advice_id: "ADV-X", carrier: "lpi", carrier_refund_cents: 170000 as unknown as bigint, received_on: D("2027-03-04") }), RangeError);
  void escalations;
});

test("9.5 escalations: officer at day 12 if unpaid is a breach-risk report, not a refusal — the agent still pays; reported once per binding", async () => {
  const { events, escalations, rt, ctx } = rig("L-O", "2027-01-24T15:00:00.000Z");
  const before = officerBreachRisk({ events, actor: AGENT, escalations }, { loan_id: "L-O", evidence_received_on: D("2027-01-12"), today: D("2027-01-23"), paid: false });
  assert.equal(before.day, 11); assert.equal(before.reported, false); assert.equal(before.report_due, "2027-01-24"); assert.equal(before.deadline, "2027-01-27");
  const at12 = officerBreachRisk({ events, actor: AGENT, escalations }, { loan_id: "L-O", evidence_received_on: D("2027-01-12"), today: D("2027-01-24"), paid: false, binding_id: "B-O" });
  assert.equal(at12.day, 12); assert.equal(at12.reported, true); assert.deepEqual(escalations.opened.map((e) => [e.kind, e.severity]), [["officer", "sev2"]]);
  assert.equal(events.ofType("fpi.refund.breach_risk").length, 1);
  events.append({ type: "fpi.lpi.cancelled", loanId: "L-O", actor: AGENT, payload: { binding_id: "B-O", effective: "2026-12-15", track: "regx_hazard", on_books: true, carrier_ack: "pending" } });
  // The agent pays on day 13 — no OFFICER_DAY_12 refusal; the existing report is not duplicated.
  const paid = (await tool("payRefund").handler({ loan_id: "L-O", binding_id: "B-O", refund_cents: 15000n, rail: "ach", days_since_evidence: 13 }, ctx("2027-01-25T15:00:00.000Z"), rt)) as { paid: boolean; breach_risk_reported: boolean; timer_satisfied: string | null };
  assert.equal(paid.paid, true); assert.equal(paid.breach_risk_reported, false); assert.equal(paid.timer_satisfied, "REGX_1024_37G_FPI_CANCEL_REFUND_15");
  assert.equal(escalations.opened.length, 1);
  assert.equal(officerBreachRisk({ events, actor: AGENT, escalations }, { loan_id: "L-O", evidence_received_on: D("2027-01-12"), today: D("2027-01-26"), paid: true }).reported, false);
  assert.throws(() => officerBreachRisk({ events }, { loan_id: "", evidence_received_on: D("2027-01-12"), today: D("2027-01-26"), paid: false }), RangeError);
});
