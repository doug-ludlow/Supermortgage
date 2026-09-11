// 21.4 Intent to proceed, fee collection, and rate lock (lock confirmation, revised LE on lock, extensions, relocks, float-down, lock-to-commitment linkage)
// spec/sections/21-application-urla-initial-disclosures-intent-to-proceed-rate/21-4-intent-to-proceed-fee-collection-and-rate-lock-lock-confirma.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, isWeekend, type PlainDate } from "../../kernel/calendar/date.ts";
import { isFederalHoliday } from "../../kernel/calendar/holidays.ts";
import { addBusinessDays, creditor, fannieEt, type Calendar } from "../../kernel/calendar/business.ts";
import { toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_21_4 } from "../../app/tools/section21-4.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import {
  ORIGINATION_FEES_RECEIVABLE, FixturePricing, aprEstimatePct, assertNyNoticeInWindow, civilDate, commitmentExpiry, evaluateFeeGate, extensionFeeCents, extensionBpsX10, intentValid, lateLockWarning, lockExpiry, nyExpiryNoticeWindow, pointsCents, quoteExtension, revisedLeDue, assessRevisedLe,
  type Lock, type RateSheet,
} from "./ops-21-4.ts";

const AGENT: Actor = { kind: "agent", id: "pricing" };
const MLO: Actor = { kind: "human", id: "u-mlo", role: "mlo_of_record" };
const APP = "app-refi-1", LOAN = "L-REFI-1", NMLSR = "1234567";
const RECIPIENTS = [{ partyId: "B1", name: "Alex Fixture", mailingAddress: "4120 N 44th St, Phoenix AZ 85018" }];
const PARTY = { borrower_names: ["Alex Fixture"], property_address: "4120 N 44th St, Phoenix AZ 85018", partner_name: "Partner Bank, N.A.", mlo_name: "Jordan Originator", mlo_nmlsr_id: NMLSR, recipients: RECIPIENTS };
/** Creditor time (Phoenix: MST all year, UTC−7). */
const mst = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/Phoenix"));
/** Pricing fixtures (section README): rate sheet Oct 7 10:00 MST; a superseding sheet 10:15 for the stale-quote test; a November sheet for the late lock. */
const SHEET_OCT: RateSheet = { rate_sheet_id: "RS-2026-10-07-1000", effective_at: mst("2026-10-07", "10:00"), superseded_at: null, llpa_version: "09.09.2026" };
const SHEET_NOV: RateSheet = { rate_sheet_id: "RS-2026-11-03-0900", effective_at: mst("2026-11-03", "09:00"), superseded_at: null, llpa_version: "09.09.2026" };
const STALE_SHEETS: RateSheet[] = [{ ...SHEET_OCT, superseded_at: mst("2026-10-07", "10:15") }, { rate_sheet_id: "RS-2026-10-07-1015", effective_at: mst("2026-10-07", "10:15"), superseded_at: null, llpa_version: "09.09.2026" }];
const noticeReg = buildRegistry(); publishAuthored(noticeReg);
const sample = (code: string) => noticeReg.activeVersion(code, D("2026-10-08"))!.samplePayload;
/** The creditor calendar with the partner open on Columbus Day (T4: "the calendar is data"). */
const OPEN_OCT_12: Calendar = { unit: "business_days_creditor", timeZone: "America/Phoenix", isBusinessDay: (d) => !isWeekend(d) && (d === "2026-10-12" || !isFederalHoliday(d)) };

/** The 21.4 tools on the bus over the overridden registry (21.4 rows plus 29.1's referenced key-data clock), a memory ledger, the escalation service and the Notice Registry; the harness appends the upstream events (21.1 / 21.2 / 25.2) with origination context. */
function harness(nowIso: string, sheets: readonly RateSheet[] = [SHEET_OCT, SHEET_NOV]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId: APP });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["21.4", "29.1"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId: LOAN, applicationId: APP, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: { pricing: new FixturePricing(sheets) }, ports: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }) };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_21_4); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("21.4", name))!, actor, { application_id: APP, ...input }, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === APP);
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt = clock.now(), actor: Actor = { kind: "agent", id: "disclosure" }) => events.append({ type, applicationId: APP, aggregate: { kind: "application", id: APP }, actor, occurredAt, payload: { application_id: APP, ...payload } });
  const trid = (atIso: string) => upstream("application.trid_received", { trid_received_at: atIso, trid_application_date: civilDate(atIso) }, atIso, { kind: "agent", id: "intake" });
  const leReceived = (on: string, atIso: string, disclosure_id = "le-1") => upstream("disclosure.le.received", { disclosure_id, le_version: 1, evidence: "esign_confirmed", received_on: on, effective_receipt_date: on }, atIso);
  const cdProvided = (atIso: string, disclosure_id = "cd-1") => upstream("disclosure.cd.delivered", { disclosure_id, kind: "cd", delivered_at: atIso, channel: "esign_portal" }, atIso);
  const lock = (id: string): Lock => rt.store.require("locks", id).data as unknown as Lock;
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  /** Worked example 1 up to the intent: six items Mon Oct 5 10:41 MST, LE v1 delivered 16:10 and viewed 17:42 (effective receipt Oct 5), "I want to proceed" Tue Oct 6 09:14. */
  const throughIntent = async (f = { tridAt: mst("2026-10-05", "10:41"), leOn: "2026-10-05", leAt: mst("2026-10-05", "17:42"), intentAt: mst("2026-10-06", "09:14") }) => {
    at(f.tridAt); trid(f.tridAt); at(f.leAt); leReceived(f.leOn, f.leAt); at(f.intentAt);
    return run("recordIntent", { channel: "app_button", statement_text: "I want to proceed with this Loan Estimate", evidence_document_id: "evt-app-tap-1", received_at: f.intentAt });
  };
  /** Worked example 1 lock: request Wed Oct 7 10:05 MST at 6.125 % / 100.000 for 45 days, MLO approval 10:19, executed 10:19. */
  const throughLock = async (o: { state?: string; loan?: bigint; rate?: string; period?: number; quoteAt?: string; approveAt?: string; execute?: Record<string, unknown>; intent?: Parameters<typeof throughIntent>[0] } = {}) => {
    await throughIntent(o.intent);
    const quoteAt = o.quoteAt ?? mst("2026-10-07", "10:05"), approveAt = o.approveAt ?? mst("2026-10-07", "10:19"); const loan = o.loan ?? 56_000_000n;
    at(quoteAt);
    const q = await run("getQuote", { loan_amount_cents: loan, product_code: "FRM30_CONV", note_rate_pct: o.rate ?? "6.125", lock_period_days: o.period ?? 45, at: quoteAt });
    const req = await run("requestLock", { quote_id: q.quote_id, borrower_statement: "Please lock my rate today", property_state: o.state ?? "AZ", le_loan_amount_cents: loan, requested_at: quoteAt });
    at(approveAt);
    await run("executeLock", { lock_id: req.lock_id, op: "approve", quote_id: req.quote_id, mlo_nmlsr_id: NMLSR, approved_at: approveAt }, MLO);
    const out = await run("executeLock", { lock_id: req.lock_id, executed_at: approveAt, ...(o.execute ?? {}) });
    return { quote: q, request: req, out, lockId: String(req.lock_id) };
  };
  return { rt, uow, events, ledger, timers, run, at, timer, ofType, upstream, trid, leReceived, cdProvided, lock, refused, throughIntent, throughLock, decisions, clock };
}

test("21.4-T1: Given LE v1 with `effective_receipt_date` 2026-10-05 and no intent, when `orderAppraisal` ($650) is called Mon Oct 5, 2026 18:00 MST, then the gate refuses with `closed_no_intent`, no card token is captured, and `fee_gate_checks` records the attempt.", async () => {
  const h = harness(mst("2026-10-05", "10:41"));
  h.trid(mst("2026-10-05", "10:41"));
  const gate = h.timer("REGZ_1026_19E2_INTENT_FEE_GATE")!;
  assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:21.4.intentFeeGate"); assert.equal(gate.dueAt, undefined);   // created closed at trid_received; a state gate, not a clock
  h.at(mst("2026-10-05", "17:42")); h.leReceived("2026-10-05", mst("2026-10-05", "17:42"));
  h.at(mst("2026-10-05", "18:00"));
  const r = await h.refused(h.run("checkFeeGate", { command: "order_appraisal", fee_kind: "appraisal", amount_cents: 65_000n, op: "impose", fee_item_id: "fee-appraisal", method: "card_token", checked_at: mst("2026-10-05", "18:00") }), "closed_no_intent");
  assert.match(r.message, /payment method not captured/);
  assert.equal(h.ofType("fee.imposed").length, 0); assert.equal(h.ledger.sets().length, 0);   // no card token, no posting
  const checks = h.rt.store.list("fee_gate_checks").map((x) => x.data);
  assert.equal(checks.length, 1); assert.equal(checks[0]!.result, "closed_no_intent"); assert.equal(checks[0]!.command, "order_appraisal"); assert.equal(checks[0]!.amount_cents, 65_000n); assert.equal(checks[0]!.collected_cents, 0n);
  assert.deepEqual((checks[0]!.basis as Record<string, unknown>).le_effective_receipt_date, "2026-10-05"); assert.equal((checks[0]!.basis as Record<string, unknown>).intent_id, null);
  assert.equal(h.ofType("fee.gate.checked").length, 1); assert.equal(h.ofType("fee.gate.checked")[0]!.payload.result, "closed_no_intent");
  assert.equal(gate.status, "armed");
  assert.ok(h.rt.escalations.opened.some((e) => e.kind === "sev1" && e.payload.reason === "fee_before_intent_attempt"), "an attempted charge is an incident (sev 1 → compliance-sentinel)");
  const g = evaluateGate("21.4.intentFeeGate", { le_effective_receipt_date: "2026-10-05", checked_on: "2026-10-05", intent_valid: false, fee_kind: "appraisal", amount_cents: 65_000n });
  assert.equal(g.open, false); assert.match(g.reason!, /^closed_no_intent/);
});

test("21.4-T2: Given the same LE, when the borrower taps \"I want to proceed\" Tue Oct 6, 2026 09:14 MST, then `intent_records.valid=true`, `REGZ_1026_19E2_INTENT_FEE_GATE` opens at 09:14, and an `orderAppraisal` at 09:20 succeeds with `fee.imposed` $650.00.", async () => {
  const h = harness(mst("2026-10-05", "10:41"));
  const intent = await h.throughIntent();
  assert.equal(intent.valid, true); assert.equal(intent.event, "intent.to_proceed.received"); assert.equal(intent.le_effective_receipt_date, "2026-10-05");
  assert.equal(h.rt.store.list("intent_records")[0]!.data.valid, true); assert.equal(h.rt.store.list("intent_records")[0]!.data.channel, "app_button");
  const gate = h.timer("REGZ_1026_19E2_INTENT_FEE_GATE")!;
  assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedAt, mst("2026-10-06", "09:14")); assert.equal(gate.satisfiedByEventId, h.ofType("intent.to_proceed.received")[0]!.id);
  h.at(mst("2026-10-06", "09:20"));
  const out = await h.run("checkFeeGate", { command: "order_appraisal", fee_kind: "appraisal", amount_cents: 65_000n, op: "impose", fee_item_id: "fee-appraisal", method: "card_token", checked_at: mst("2026-10-06", "09:20") });
  assert.equal(out.result, "open"); assert.equal(out.collected_cents, 65_000n); assert.equal(out.imposed, true); assert.equal(out.intent_id, intent.intent_id);
  const imposed = h.ofType("fee.imposed")[0]!;
  assert.equal(imposed.payload.amount_cents, "65000"); assert.equal(imposed.payload.fee_item_id, "fee-appraisal"); assert.equal(imposed.occurredAt, mst("2026-10-06", "09:20"));
  assert.equal(h.ledger.balance(ORIGINATION_FEES_RECEIVABLE), 65_000n); assert.equal(h.ledger.sets()[0]!.lines[0]!.ruleRef.includes("fee_gate_checks.result=open"), true);
  assert.equal(intentValid(mst("2026-10-06", "09:14"), D("2026-10-05")), true); assert.equal(intentValid(mst("2026-10-05", "15:00"), D("2026-10-05")), true);
  // edge case: a statement at 15:00 on the delivery day against a receipt on Oct 6 is premature (valid=false; the agent re-asks after the view)
  assert.equal(intentValid(mst("2026-10-05", "15:00"), D("2026-10-06")), false);
  assert.equal(evaluateGate("21.4.intentFeeGate", { le_effective_receipt_date: "2026-10-05", checked_on: "2026-10-06", intent_valid: true, fee_kind: "appraisal", amount_cents: 65_000n }).open, true);
});

test("21.4-T3: Given no LE yet, when the credit-report fee is collected Oct 5 10:50 with a vendor invoice of $68.50, then the gate result is `exempt_credit_report` and the collected amount is capped at $68.50; a \"processing fee\" of $250 attempted at the same time is refused with `closed_no_receipt`.", async () => {
  const h = harness(mst("2026-10-05", "10:41"));
  h.trid(mst("2026-10-05", "10:41")); h.at(mst("2026-10-05", "10:50"));
  const out = await h.run("checkFeeGate", { command: "order_credit_report", fee_kind: "credit_report", amount_cents: 7_500n, vendor_invoice_cents: 6_850n, op: "impose", fee_item_id: "fee-credit-report", method: "card_token", checked_at: mst("2026-10-05", "10:50") });
  assert.equal(out.result, "exempt_credit_report"); assert.equal(out.collected_cents, 6_850n); assert.equal(out.imposed, true);
  assert.equal(h.ofType("fee.imposed")[0]!.payload.amount_cents, "6850"); assert.equal(h.ledger.balance(ORIGINATION_FEES_RECEIVABLE), 6_850n);
  const r = await h.refused(h.run("checkFeeGate", { command: "impose_fee", fee_kind: "processing", amount_cents: 25_000n, op: "impose", fee_item_id: "fee-processing", method: "card_token", checked_at: mst("2026-10-05", "10:50") }), "closed_no_receipt");
  assert.match(r.message, /closed_no_receipt/);
  const rows = h.rt.store.list("fee_gate_checks").map((x) => x.data);
  assert.deepEqual(rows.map((x) => [x.result, x.collected_cents]), [["exempt_credit_report", 6_850n], ["closed_no_receipt", 0n]]);
  assert.equal(h.ofType("fee.imposed").length, 1);
  const base = { application_id: APP, command: "impose_fee", checked_at: mst("2026-10-05", "10:50"), le_effective_receipt_date: null, intent: null };
  assert.equal(evaluateFeeGate({ ...base, command: "order_credit_report", fee_kind: "credit_report", amount_cents: 7_500n, vendor_invoice_cents: 6_850n }).collected_cents, 6_850n);
  assert.equal(evaluateFeeGate({ ...base, command: "order_credit_report", fee_kind: "credit_report", amount_cents: 6_000n, vendor_invoice_cents: 6_850n }).collected_cents, 6_000n);   // never more than charged
  assert.equal(evaluateFeeGate({ ...base, fee_kind: "processing", amount_cents: 25_000n }).result, "closed_no_receipt");
  assert.throws(() => evaluateFeeGate({ ...base, command: "order_credit_report", fee_kind: "credit_report", amount_cents: 7_500n, vendor_invoice_cents: null }), RangeError);   // bona fide and reasonable needs the invoice
});

test("21.4-T4: Given a lock executed Wed Oct 7, 2026 10:19 MST with calendar `creditor` closed on Mon Oct 12, then `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD` is due Tue Oct 13, 2026 23:59 MST; with the partner open on Oct 12 the due date is Mon Oct 12.", async () => {
  const closed = revisedLeDue(D("2026-10-07"), creditor);
  assert.equal(closed.due_on, "2026-10-13"); assert.equal(closed.due_at, mst("2026-10-13", "23:59"));   // Thu 8 (1), Fri 9 (2), Mon 12 Columbus Day closed, Tue 13 (3)
  const open = revisedLeDue(D("2026-10-07"), OPEN_OCT_12);
  assert.equal(open.due_on, "2026-10-12"); assert.equal(open.due_at, mst("2026-10-12", "23:59"));
  const h = harness(mst("2026-10-05", "10:41"));
  const { out, lockId } = await h.throughLock();
  assert.equal(out.status, "executed"); assert.equal(out.locked_at, mst("2026-10-07", "10:19")); assert.equal(out.rate_set_date, "2026-10-07");
  assert.deepEqual([(out.revised_le as { due_on: string }).due_on, (out.revised_le as { due_at: string }).due_at], ["2026-10-13", mst("2026-10-13", "23:59")]);
  const t = h.timer("REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD")!;
  assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2026-10-13"); assert.equal(t.anchorDate, "2026-10-07"); assert.equal(t.armedByEventId, out.event_id);   // the engine's end-of-day instant is ET; the creditor-zone instant is on the row
  const cc = h.rt.store.get("changed_circumstances", String(out.cc_id))!.data;
  assert.equal(cc.kind, "rate_lock"); assert.equal(cc.basis, "D"); assert.equal(cc.revised_le_due_at, mst("2026-10-13", "23:59")); assert.equal(cc.discovered_at, out.locked_at); assert.equal(cc.reflected_on, "le");
  assert.equal(h.ofType("changed_circumstance.recorded")[0]!.payload.kind, "rate_lock"); assert.equal(h.lock(lockId).mlo_nmlsr_id, NMLSR);
  // 21.5's revised LE satisfies the clock
  h.at(mst("2026-10-08", "15:02")); h.upstream("disclosure.le.revised", { disclosure_id: "le-2", le_version: 2, reason: "rate_lock", lock_id: lockId });
  assert.equal(t.status, "satisfied");
  const link = await h.run("recordChangedCircumstance", { lock_id: lockId });
  assert.equal(link.reflected_on, "le"); assert.equal(link.disclosure_id, "le-2"); assert.equal(h.lock(lockId).revised_le_disclosure_id, "le-2");
  // edge case: 23:30 MST Oct 7 is still Oct 7 for the creditor (Oct 8 in ET)
  assert.equal(civilDate(mst("2026-10-07", "23:30")), "2026-10-07"); assert.equal(assessRevisedLe({ locked_at: mst("2026-10-07", "23:30"), consummation_on: null, cd_provided_at: null }).due_on, "2026-10-13");
});

test("21.4-T5: Given a 45-day lock executed Oct 7, then `expires_on` = Sat Nov 21 → rolled to Mon Nov 23, 2026 and `expires_at` = 2026-11-23 17:00 MST, displayed on LE v2 as \"11/23/2026 at 5:00 p.m. MST\"; `rate_set_date` = 2026-10-07.", async () => {
  const e = lockExpiry(D("2026-10-07"), 45);
  assert.deepEqual([e.raw_expires_on, e.expires_on, e.expiry_roll_applied, e.expires_at, e.display], ["2026-11-21", "2026-11-23", true, mst("2026-11-23", "17:00"), "11/23/2026 at 5:00 p.m. MST"]);
  assert.equal(e.expires_at, "2026-11-24T00:00:00.000Z");
  const h = harness(mst("2026-10-05", "10:41"));
  const { out, lockId } = await h.throughLock();
  assert.equal(out.expires_on, "2026-11-23"); assert.equal(out.expiry_roll_applied, true); assert.equal(out.expires_at, mst("2026-11-23", "17:00")); assert.equal(out.expires_display, "11/23/2026 at 5:00 p.m. MST"); assert.equal(out.rate_set_date, "2026-10-07");
  const ex = h.ofType("lock.executed")[0]!.payload;
  assert.equal(ex.expires_at, mst("2026-11-23", "17:00")); assert.equal(ex.rate_set_date, "2026-10-07"); assert.equal(ex.note_rate, "6.125"); assert.equal(ex.price, "100.000"); assert.equal(ex.points_cents, "0"); assert.equal(ex.lock_period_days, 45);
  assert.equal(h.timer("SM_LOCK_EXPIRY_DEADLINE")!.dueDate, "2026-11-23"); assert.equal(h.timer("SM_LOCK_EXPIRY_WARN_7")!.dueDate, "2026-11-16");
  // LE v2 (21.5 renders the form; the Rate Lock block is this section's template): "YES, until 11/23/2026 at 5:00 p.m. MST", closing-costs expiration blank after intent
  const n = h.rt.notices!.render({ templateCode: "NTC_REGZ_1026_37_LE_REVISED", recipients: RECIPIENTS, payload: { ...sample("NTC_REGZ_1026_37_LE_REVISED"), lock_expires_display: out.expires_display, revision_reason: `interest rate locked ${out.rate_set_date}` }, asOf: D("2026-10-08") });
  assert.equal(n.checklist.passed, true); assert.match(n.rendered.text, /Rate Lock: YES, until 11\/23\/2026 at 5:00 p\.m\. MST/); assert.doesNotMatch(n.rendered.text, /closing costs expire/); assert.match(n.rendered.text, /\$3,402\.62/);
  assert.equal(h.lock(lockId).expires_on, "2026-11-23");
  // a 30-day lock from Mon Oct 26 expires Wed Nov 25 (a creditor business day; no roll) — worked example 3
  assert.deepEqual([lockExpiry(D("2026-10-26"), 30).expires_on, lockExpiry(D("2026-10-26"), 30).expiry_roll_applied], ["2026-11-25", false]);
});

test("21.4-T6: Given a lock request at 6.125 %/100.000 with a stale rate sheet (superseded 2 minutes earlier), when the agent runs guardrails, then the lock is not executed, the quote is refreshed, and a new MLO escalation is opened; the MLO's approval of the old quote is rejected as `quote_expired`.", async () => {
  const h = harness(mst("2026-10-05", "10:41"), STALE_SHEETS);
  await h.throughIntent();
  h.at(mst("2026-10-07", "10:05"));
  const q1 = await h.run("getQuote", { loan_amount_cents: 56_000_000n, product_code: "FRM30_CONV", note_rate_pct: "6.125", price_pct: "100.000", lock_period_days: 45, at: mst("2026-10-07", "10:05") });
  assert.equal(q1.rate_sheet_id, "RS-2026-10-07-1000");
  h.at(mst("2026-10-07", "10:17"));   // the 10:15 sheet superseded the quote's sheet two minutes ago
  const req = await h.run("requestLock", { quote_id: q1.quote_id, borrower_statement: "Lock it at 6.125", property_state: "AZ", le_loan_amount_cents: 56_000_000n, requested_at: mst("2026-10-07", "10:17") });
  assert.equal(req.executed, false); assert.equal(req.status, "pending_mlo_approval"); assert.equal(req.quote_refreshed, true); assert.equal(req.stale_quote_id, q1.quote_id); assert.notEqual(req.quote_id, q1.quote_id); assert.equal(req.rate_sheet_id, "RS-2026-10-07-1015");
  const fresh = (req.guardrails as { code: string; ok: boolean }[]).find((g) => g.code === "rate_sheet_fresh")!; assert.equal(fresh.ok, true);
  assert.equal(h.ofType("lock.executed").length, 0);
  assert.equal(h.ofType("lock.rejected").length, 1); assert.equal(h.ofType("lock.rejected")[0]!.payload.reason, "quote_expired"); assert.equal(h.ofType("lock.rejected")[0]!.payload.quote_id, q1.quote_id);
  const escs = h.rt.escalations.opened.filter((e) => e.kind === "mlo_of_record");
  assert.equal(escs.length, 1); assert.equal(escs[0]!.id, req.escalation_id); assert.equal(escs[0]!.payload.quote_id, req.quote_id); assert.equal(escs[0]!.payload.stale_quote_id, q1.quote_id);
  // the MLO approves the old quote → quote_expired; the fresh quote is approvable
  h.at(mst("2026-10-07", "10:20"));
  const r = await h.refused(h.run("executeLock", { lock_id: req.lock_id, op: "approve", quote_id: q1.quote_id, mlo_nmlsr_id: NMLSR, approved_at: mst("2026-10-07", "10:20") }, MLO), "quote_expired");
  assert.match(r.message, /superseded/); assert.equal(h.lock(String(req.lock_id)).approved_at, null); assert.equal(h.ofType("lock.executed").length, 0);
  await h.refused(h.run("executeLock", { lock_id: req.lock_id, executed_at: mst("2026-10-07", "10:21") }), "MLO_APPROVAL_REQUIRED");   // never executed without the approval
  const ok = await h.run("executeLock", { lock_id: req.lock_id, op: "approve", quote_id: req.quote_id, mlo_nmlsr_id: NMLSR, approved_at: mst("2026-10-07", "10:21") }, MLO);
  assert.equal(ok.approved_at, mst("2026-10-07", "10:21"));
  // the SLA row: one instance per request; the stale request's is satisfied by lock.rejected, the fresh one by lock.approved
  const sla = h.timers.byCode("SM_LOCK_MLO_APPROVAL_SLA_30MIN");
  assert.equal(sla.length, 2); assert.deepEqual(sla.map((t) => t.status), ["satisfied", "satisfied"]); assert.equal(sla[1]!.dueAt, Date.parse(mst("2026-10-07", "10:47")));
  // only the MLO of record (a human) approves
  await h.refused(h.run("executeLock", { lock_id: req.lock_id, op: "approve", quote_id: req.quote_id, mlo_nmlsr_id: NMLSR }), "MLO_APPROVAL_IS_HUMAN");
});

test("21.4-T7: Given the CD was provided Mon Nov 2, 2026 and the borrower locks Tue Nov 3 at 6.250 % with $700.00 points, then no `disclosure.le.revised` is produced; a `changed_circumstances{kind='rate_lock', reflected_on='cd'}` row is created; 25.2 receives the terms; and the borrower was warned before execution that the closing may move to Mon Nov 9.", async () => {
  const h = harness(mst("2026-10-05", "10:41"));
  await h.throughIntent();
  h.at(mst("2026-11-02", "10:00")); h.cdProvided(mst("2026-11-02", "10:00"));
  h.at(mst("2026-11-03", "10:00"));
  const q = await h.run("getQuote", { loan_amount_cents: 56_000_000n, product_code: "FRM30_CONV", note_rate_pct: "6.250", points_pct: "0.125", lock_period_days: 15, at: mst("2026-11-03", "10:00") });
  const req = await h.run("requestLock", { quote_id: q.quote_id, borrower_statement: "I floated long enough — lock at 6.25 with the eighth point", property_state: "AZ", le_loan_amount_cents: 56_000_000n, requested_at: mst("2026-11-03", "10:00") });
  await h.run("executeLock", { lock_id: req.lock_id, op: "approve", quote_id: req.quote_id, mlo_nmlsr_id: NMLSR, approved_at: mst("2026-11-03", "10:05") }, MLO);
  const late = { cd_provided_at: mst("2026-11-02", "10:00"), consummation_on: "2026-11-06", le_terms: { note_rate_pct: "6.125", points_cents: 0n } };
  const assess = await h.run("executeLock", { lock_id: req.lock_id, op: "assess_late_lock", executed_at: mst("2026-11-03", "10:10"), ...late });
  const w = assess.warning as ReturnType<typeof lateLockWarning>; const a = assess.revised_le as ReturnType<typeof assessRevisedLe>;
  assert.equal(a.revised_le_permitted, false); assert.equal(a.reflected_on, "cd"); assert.equal(a.latest_receipt_on, "2026-11-02");   // Thu 5 (1), Wed 4 (2), Tue 3 (3), Mon 2 (4) — already past, and the CD went out Nov 2
  assert.equal(w.exceeds_apr_tolerance, true); assert.equal(w.earliest_consummation_on, "2026-11-09"); assert.equal(w.closing_moves, true); assert.match(w.text, /moves your closing to 2026-11-09/);
  assert.equal(w.apr_before_pct, "6.125"); assert.equal(w.apr_after_pct, "6.262");   // rate +0.125 plus $700 points on $560,000 (spec: "about 6.262 %")
  await h.refused(h.run("executeLock", { lock_id: req.lock_id, executed_at: mst("2026-11-03", "10:15"), ...late }), "LATE_LOCK_WARNING_REQUIRED");
  const out = await h.run("executeLock", { lock_id: req.lock_id, executed_at: mst("2026-11-03", "10:15"), borrower_warned_at: mst("2026-11-03", "10:12"), ...late });
  assert.equal(out.points_cents, 70_000n); assert.equal(out.note_rate, "6.250"); assert.equal((out.revised_le as { reflected_on: string }).reflected_on, "cd"); assert.equal(out.borrower_warned_at, mst("2026-11-03", "10:12"));
  const cc = h.rt.store.get("changed_circumstances", String(out.cc_id))!.data;
  assert.equal(cc.kind, "rate_lock"); assert.equal(cc.reflected_on, "cd"); assert.equal(cc.revised_le_due_on, "2026-11-06");   // the (e)(3)(iv)(D) clock still runs: Wed 4, Thu 5, Fri 6
  assert.equal(h.ofType("disclosure.le.revised").length, 0); assert.equal(h.ofType("lock.executed")[0]!.payload.revised_le_reflected_on, "cd");
  const t = h.timer("REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD")!; assert.equal(t.dueDate, "2026-11-06");
  // 25.2 receives the terms on the corrected CD; the clock is retired citing it (reflected_on=cd)
  h.at(mst("2026-11-03", "15:00")); h.upstream("disclosure.cd.corrected", { disclosure_id: "cd-2", kind: "corrected_cd", lock_id: out.lock_id, reflected_on: "cd", note_rate: "6.250", points_cents: "70000" });
  const link = await h.run("recordChangedCircumstance", { lock_id: out.lock_id });
  assert.equal(link.reflected_on, "cd"); assert.equal(link.disclosure_id, "cd-2"); assert.equal(link.timer_retired, t.id);
  assert.equal(t.status, "cancelled"); assert.match(t.cancelledReason!, /disclosure\.cd\.corrected cd-2 \(reflected_on=cd\)/);
  assert.equal(h.rt.store.get("changed_circumstances", String(out.cc_id))!.data.revised_le_disclosure_id, "cd-2"); assert.equal(h.ofType("disclosure.le.revised").length, 0);
  assert.equal(pointsCents(56_000_000n, "0.125"), 70_000n);
});

test("21.4-T8: Given the closing slips from Nov 6 to Tue Dec 1, 2026 because the appraisal was late (`delay_attribution='lender_agent'`), then the lock is extended 8 days at 6.125 % with `extension_payer='lender_delay'`, fee $700.00 borne by the lender, no consumer charge and no revised LE/CD change for the fee.", async () => {
  const h = harness(mst("2026-10-05", "10:41"));
  const { lockId } = await h.throughLock();
  const quote = quoteExtension(h.lock(lockId), { new_closing_on: D("2026-12-01"), delay_attribution: "lender_agent" });
  assert.deepEqual([quote.days, quote.fee_cents, quote.payer, quote.consumer_charge_cents, quote.revised_disclosure], [8, 70_000n, "lender_delay", 0n, "none"]);   // Nov 23 → Dec 1; 12.5 bps × $560,000
  h.at(mst("2026-11-20", "09:00"));
  await h.refused(h.run("extendLock", { lock_id: lockId, new_closing_on: "2026-12-01", delay_attribution: "lender_agent", charge_borrower: true }), "LENDER_DELAY_CHARGED_TO_BORROWER");
  const out = await h.run("extendLock", { lock_id: lockId, new_closing_on: "2026-12-01", delay_attribution: "lender_agent", requested_at: mst("2026-11-20", "09:00") });
  assert.equal(out.days, 8); assert.equal(out.fee_cents, 70_000n); assert.equal(out.payer, "lender_delay"); assert.equal(out.consumer_charge_cents, 0n); assert.equal(out.note_rate, "6.125"); assert.equal(out.cc_id, null); assert.equal(out.revised_disclosure, "none");
  assert.equal(out.new_expires_on, "2026-12-01"); assert.equal(out.new_expires_at, mst("2026-12-01", "17:00"));
  const l = h.lock(lockId); assert.equal(l.expires_on, "2026-12-01"); assert.equal(l.extension_payer, "lender_delay"); assert.equal(l.extension_fee_cents, 70_000n); assert.equal(l.note_rate, "6.125"); assert.equal(l.status, "executed");
  const ext = h.rt.store.list("lock_extensions")[0]!.data; assert.equal(ext.days, 8); assert.equal(ext.payer, "lender_delay"); assert.equal(ext.delay_attribution, "lender_agent");
  assert.equal(h.ofType("changed_circumstance.recorded").length, 1);   // only the rate_lock row from execution — no consumer charge, nothing to redisclose
  assert.equal(h.ofType("lock.extended")[0]!.payload.consumer_charge_cents, "0"); assert.equal(h.ofType("disclosure.le.revised").length, 0);
  const deadlines = h.timers.byCode("SM_LOCK_EXPIRY_DEADLINE");
  assert.deepEqual(deadlines.map((t) => [t.status, t.dueDate]), [["cancelled", "2026-11-23"], ["armed", "2026-12-01"]]);
  assert.deepEqual(h.timers.byCode("SM_LOCK_EXPIRY_WARN_7").map((t) => [t.status, t.dueDate]), [["cancelled", "2026-11-16"], ["armed", "2026-11-24"]]);
  assert.equal(extensionFeeCents(56_000_000n, 8), 70_000n); assert.equal(extensionBpsX10(8), 125n); assert.equal(extensionBpsX10(15), 250n);
});

test("21.4-T9: Given the same slip requested by the borrower on Fri Nov 13, then `extension_payer='borrower'`, `changed_circumstances{kind='borrower_request'}` is inserted, and — because the CD was provided Nov 2 — the fee is reflected on a corrected CD (25.2) rather than a revised LE.", async () => {
  const h = harness(mst("2026-10-05", "10:41"));
  const { lockId } = await h.throughLock();
  h.at(mst("2026-11-02", "10:00")); h.cdProvided(mst("2026-11-02", "10:00"));
  h.at(mst("2026-11-13", "10:00"));
  const req = { lock_id: lockId, new_closing_on: "2026-12-01", delay_attribution: "borrower", requested_at: mst("2026-11-13", "10:00"), cd_provided_at: mst("2026-11-02", "10:00"), consummation_on: "2026-12-01" };
  await h.refused(h.run("extendLock", req), "MLO_APPROVAL_REQUIRED");   // a borrower-paid extension is approved by the MLO of record
  const out = await h.run("extendLock", { ...req, mlo_nmlsr_id: NMLSR });
  assert.equal(out.payer, "borrower"); assert.equal(out.fee_cents, 70_000n); assert.equal(out.consumer_charge_cents, 70_000n); assert.equal(out.cc_kind, "borrower_request"); assert.equal(out.reflected_on, "cd"); assert.equal(out.revised_disclosure, "corrected_cd");
  const cc = h.rt.store.get("changed_circumstances", String(out.cc_id))!.data;
  assert.equal(cc.kind, "borrower_request"); assert.equal(cc.basis, "C"); assert.equal(cc.reflected_on, "cd"); assert.equal(cc.discovered_at, mst("2026-11-13", "10:00")); assert.equal(cc.affected_amount_cents, 70_000n); assert.equal(cc.revised_le_due_on, "2026-11-18");   // 3 creditor business days: Mon 16, Tue 17, Wed 18
  const ev = h.ofType("changed_circumstance.recorded").filter((e) => e.payload.kind === "borrower_request");
  assert.equal(ev.length, 1); assert.equal(ev[0]!.payload.reflected_on, "cd"); assert.equal(h.ofType("disclosure.le.revised").length, 0);
  assert.equal(h.lock(lockId).extension_payer, "borrower"); assert.equal(h.lock(lockId).expires_on, "2026-12-01");
  // the same request with no CD yet would be a revised LE within 3 creditor business days
  assert.equal(quoteExtension({ ...h.lock(lockId), expires_on: D("2026-11-23") }, { new_closing_on: D("2026-12-01"), delay_attribution: "borrower" }).revised_disclosure, "revised_le");
});

test("21.4-T10: Given a New York property, a lock on Mon Oct 26 expiring Wed Nov 25, 2026, then the §38.6(b)(4) notice window is Tue Oct 27–Fri Nov 6 (creditor calendar; Veterans Day closed) and `NTC_NY_3NYCRR_38_6_LOCK_EXPIRY_NOTICE` is sent inside it (a send on Mon Nov 9 would be only 11 business days before expiry and fails the gate); the confirmation carries applicant and lender signature blocks and `state_agreement_variant='NY'`.", async () => {
  const w = nyExpiryNoticeWindow(D("2026-10-26"), D("2026-11-25"));
  assert.deepEqual(w, { required: true, business_days_lock_to_expiry: 21, opens_on: "2026-10-27", closes_on: "2026-11-06" });
  assert.throws(() => assertNyNoticeInWindow(w, D("2026-11-25"), D("2026-11-09")), (e: Error) => /11 business days before 2026-11-25/.test(e.message));
  assert.equal(assertNyNoticeInWindow(w, D("2026-11-25"), D("2026-10-29")).business_days_before_expiry, 18);
  assert.deepEqual([assertNyNoticeInWindow(w, D("2026-11-25"), D("2026-10-27")).business_days_before_expiry, assertNyNoticeInWindow(w, D("2026-11-25"), D("2026-11-06")).business_days_before_expiry], [20, 12]);
  const h = harness(mst("2026-10-19", "10:00"));
  const ny = { borrower_names: ["Casey Purchaser", "Riley Purchaser"], property_address: "88 Maple Ave, Albany NY 12203", partner_name: PARTY.partner_name, mlo_name: PARTY.mlo_name, mlo_nmlsr_id: NMLSR, recipients: [{ partyId: "B1", name: "Casey Purchaser", mailingAddress: "88 Maple Ave, Albany NY 12203" }] };
  const { out, lockId } = await h.throughLock({ state: "NY", loan: 41_200_000n, rate: "6.375", period: 30, quoteAt: mst("2026-10-26", "10:00"), approveAt: mst("2026-10-26", "10:10"), intent: { tridAt: mst("2026-10-19", "10:00"), leOn: "2026-10-22", leAt: mst("2026-10-22", "11:00"), intentAt: mst("2026-10-23", "10:00") } });
  assert.equal(out.expires_on, "2026-11-25"); assert.equal(out.expiry_roll_applied, false); assert.deepEqual(out.ny_window, w);
  assert.equal(h.lock(lockId).state_agreement_variant, "NY"); assert.equal(h.ofType("lock.executed")[0]!.payload.ny_expiry_notice_required, true);
  const t = h.timer("NY_3NYCRR_38_6B4_LOCK_EXPIRY_NOTICE_12_20BD")!;
  assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2026-11-06"); assert.equal(t.note, "window opens 2026-10-27"); assert.equal(t.anchorDate, "2026-11-25");
  // the confirmation (NY variant): applicant and lender signature blocks
  const conf = await h.run("renderLockConfirmation", { lock_id: lockId, ...ny });
  assert.equal(conf.rendered, true); assert.equal(conf.checklist_ok, true);
  const text = h.rt.notices!.get(String(conf.notice_id)).rendered.text;
  assert.match(text, /Applicant signature: _+ Date: _+ Lender signature \(Partner Bank, N\.A\., by Jordan Originator\)/); assert.match(text, /binding on both the applicant and the lender/); assert.match(text, /locked at 6\.375%/); assert.match(text, /expires on 11\/25\/2026 at 5:00 p\.m\. MST/);
  assert.equal((conf.payload as Record<string, unknown>).state_agreement_variant, "NY"); assert.equal((conf.payload as Record<string, unknown>).variant_ny, true);
  // a send on Mon Nov 9 is 11 business days before expiry → refused; Thu Oct 29 is inside the window → sent, the timer is satisfied
  await h.refused(h.run("sendNotice", { lock_id: lockId, template_code: "NTC_NY_3NYCRR_38_6_LOCK_EXPIRY_NOTICE", send_on: "2026-11-09", recipients: ny.recipients }), "NY_38_6B4_WINDOW");
  assert.equal(h.ofType("notice.sent").length, 0);
  h.at(mst("2026-10-29", "15:02"));
  const sent = await h.run("sendNotice", { lock_id: lockId, template_code: "NTC_NY_3NYCRR_38_6_LOCK_EXPIRY_NOTICE", send_on: "2026-10-29", recipients: ny.recipients, cannot_print: true });
  assert.equal(sent.sent, true); assert.equal((sent.window as { business_days_before_expiry: number }).business_days_before_expiry, 18); assert.equal(sent.state_agreement_variant, "NY");
  const ns = h.ofType("notice.sent")[0]!; assert.equal(ns.payload.template, "NTC_NY_3NYCRR_38_6_LOCK_EXPIRY_NOTICE");
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, ns.id);
  assert.match(h.rt.notices!.get(String(sent.notice_id)).rendered.text, /hard copy will follow within three business days/);
  // sending the confirmation moves the lock to `confirmed`
  await h.run("sendNotice", { lock_id: lockId, template_code: "NTC_SM_RATE_LOCK_CONFIRMATION", recipients: ny.recipients });
  assert.equal(h.lock(lockId).status, "confirmed");
  // an Ohio property (the fixture's) needs no NY notice: no window row, no variant
  assert.equal(nyExpiryNoticeWindow(D("2026-10-26"), D("2026-11-05")).required, false);   // 8 business days ≤ 12
});

test("21.4-T11: Given a best-efforts commitment executed for a lock lineage, when a relock creates version 2, then exactly one open commitment remains, `lock.relocked` triggers the 29.1 key-data update, and a second `commit` call for the same lineage is refused by the adapter.", async () => {
  const h = harness(mst("2026-10-05", "10:41"));
  const { lockId } = await h.throughLock();
  h.at(mst("2026-10-07", "10:25"));
  const c = await h.run("requestCommitment", { lock_id: lockId, at: mst("2026-10-07", "10:25") });
  assert.equal(c.commitment_id_fnma, "BE-000001"); assert.equal(c.expires_on, "2026-12-07"); assert.equal(c.open_commitments, 1);   // 29.1-Q1: Nov 23 + 14 = Mon Dec 7, 2026
  assert.equal(h.ofType("commitment.executed").length, 1); assert.equal(h.ofType("lock.commitment.linked")[0]!.payload.commitment_id, c.commitment_id); assert.equal(h.lock(lockId).commitment_id, c.commitment_id);
  await h.refused(h.run("requestCommitment", { lock_id: lockId, at: mst("2026-10-07", "10:26") }), "DUPLICATE_COMMITMENT");
  // relock → version 2 at worst-case pricing; the key-data change goes to 29.1 within one business day
  h.at(mst("2026-11-10", "10:00"));
  const q2 = await h.run("getQuote", { loan_amount_cents: 56_000_000n, product_code: "FRM30_CONV", note_rate_pct: "6.000", price_pct: "99.500", lock_period_days: 30, at: mst("2026-11-10", "10:00") });
  const v2 = await h.run("relock", { lock_id: lockId, quote_id: q2.quote_id, mlo_nmlsr_id: NMLSR, relocked_at: mst("2026-11-10", "10:00") });
  assert.equal(v2.version, 2); assert.equal(v2.supersedes_lock_id, lockId); assert.equal(v2.note_rate, "6.000"); assert.equal(v2.price, "99.500"); assert.equal(v2.rate_set_date, "2026-11-10"); assert.equal(v2.expires_on, "2026-12-10"); assert.equal(v2.open_commitments, 1);
  assert.equal(h.lock(lockId).status, "superseded"); assert.equal(h.lock(String(v2.lock_id)).status, "executed"); assert.equal(h.lock(String(v2.lock_id)).commitment_id, c.commitment_id);
  assert.equal(h.ofType("lock.relocked").length, 1); assert.equal(h.ofType("lock.relocked")[0]!.payload.key_data_change, "note_rate/price");
  assert.equal(h.ofType("commitment.modified").length, 1); assert.equal(h.ofType("commitment.modified")[0]!.payload.commitment_id, c.commitment_id); assert.equal((v2.commitment as { modifications: number }).modifications, 1);
  const kd = h.timer("FNMA_C2_1_2_03_KEY_DATA_CHANGE_1BD")!;
  assert.equal(kd.armedByEventId, h.ofType("lock.relocked")[0]!.id); assert.equal(kd.status, "satisfied"); assert.equal(kd.dueDate, addBusinessDays(D("2026-11-10"), 1, fannieEt)); assert.equal(kd.dueAt, zonedEpochMs(kd.dueDate!, "17:00", "America/New_York"));   // +1 Fannie Mae business day, 5:00 p.m. ET
  assert.equal(h.ofType("changed_circumstance.recorded").filter((e) => e.payload.lock_id === v2.lock_id && e.payload.kind === "rate_lock").length, 1);   // relock → revised LE within 3 creditor business days
  // a second commit for the same lineage is refused by the adapter
  await h.refused(h.run("requestCommitment", { lock_id: v2.lock_id, at: mst("2026-11-10", "10:05") }), "DUPLICATE_COMMITMENT");
  assert.equal((h.rt.services.secondary as { open(l: string): unknown[] }).open(h.lock(lockId).lineage_id).length, 1);
  assert.equal(commitmentExpiry(D("2026-11-23"), D("2026-10-07")), "2026-12-07");
});

test("21.4-T12: Given the application is denied Fri Oct 23, 2026 after a lock with a $500 NY lock-in fee, then `lock.cancelled{lender_declination}`, the fee is refunded (ledger reversal) and 29.1 records fallout with `pair_off_expected=false`.", async () => {
  const h = harness(mst("2026-10-05", "10:41"));
  const { lockId } = await h.throughLock({ state: "NY" });
  h.at(mst("2026-10-07", "10:30"));
  const fee = await h.run("checkFeeGate", { command: "impose_fee", fee_kind: "lock_in_fee", amount_cents: 50_000n, op: "impose", fee_item_id: "fee-ny-lock-in", method: "card", checked_at: mst("2026-10-07", "10:30") });
  assert.equal(fee.result, "open"); assert.equal(h.ledger.balance(ORIGINATION_FEES_RECEIVABLE), 50_000n);
  await h.run("requestCommitment", { lock_id: lockId, at: mst("2026-10-07", "10:35") });
  h.at(mst("2026-10-23", "14:00"));
  const out = await h.run("expireLock", { lock_id: lockId, op: "cancel", reason: "lender_declination", detail: "application denied (21.6)", lock_fee_ledger_set_id: fee.ledger_set_id, at: mst("2026-10-23", "14:00") });
  assert.equal(out.status, "cancelled"); assert.equal(out.cancelled_reason, "lender_declination"); assert.equal(out.refund_cents, 50_000n); assert.deepEqual(out.fallout, { commitment_id: h.lock(lockId).commitment_id, pair_off_expected: false });
  const cancelled = h.ofType("lock.cancelled")[0]!; assert.equal(cancelled.payload.reason, "lender_declination"); assert.equal(cancelled.payload.refund_cents, "50000"); assert.equal(cancelled.occurredAt, mst("2026-10-23", "14:00"));
  const reversal = h.ledger.sets().find((s) => s.reversesSetId === fee.ledger_set_id)!;
  assert.ok(reversal); assert.equal(reversal.effectiveDate, "2026-10-23"); assert.match(reversal.description, /3 NYCRR 38\.6\(b\)\(2\)/); assert.equal(h.ledger.balance(ORIGINATION_FEES_RECEIVABLE), 0n);
  const fallout = h.ofType("commitment.fallout.recorded")[0]!; assert.equal(fallout.payload.pair_off_expected, false); assert.equal(fallout.payload.reason, "lender_declination"); assert.equal(fallout.payload.dpa_exposure_until, "2026-11-22");
  assert.ok(h.timers.byCode("SM_LOCK_EXPIRY_DEADLINE").every((t) => t.status === "cancelled")); assert.ok(h.timers.byCode("NY_3NYCRR_38_6B4_LOCK_EXPIRY_NOTICE_12_20BD").every((t) => t.status === "cancelled"));
  await h.refused(h.run("expireLock", { lock_id: lockId, op: "cancel", reason: "lender_declination" }), "LOCK_STATE");   // already cancelled
});

test("21.4 worked figures: P&I $3,402.62 on the $560,000 / 6.125 % fixture; the $650.00 appraisal fee after intent; the $68.50 credit-report cap; the $700.00 extension fee (12.5 bps × $560,000) and $700.00 of points (0.125 %)", () => {
  assert.equal(levelPayment(56_000_000n, ratePercent("6.125"), 360), 340_262n);   // $3,402.62, not $3,402.63 (21.2 discrepancy 5)
  const base = { application_id: APP, checked_at: mst("2026-10-06", "09:20"), le_effective_receipt_date: D("2026-10-05") };
  const intent = { intent_id: "i-1", application_id: APP, disclosure_id: "le-1", le_effective_receipt_date: D("2026-10-05"), received_at: mst("2026-10-06", "09:14"), channel: "app_button" as const, statement_text: "I want to proceed", evidence_document_id: "evt-1", recorded_by: "agent:pricing", valid: true, withdrawn_at: null };
  assert.deepEqual(evaluateFeeGate({ ...base, command: "order_appraisal", fee_kind: "appraisal", amount_cents: 65_000n, intent }).collected_cents, 65_000n);   // $650.00
  assert.equal(evaluateFeeGate({ ...base, command: "order_credit_report", fee_kind: "credit_report", amount_cents: 7_500n, vendor_invoice_cents: 6_850n, intent: null, le_effective_receipt_date: null, checked_at: mst("2026-10-05", "10:50") }).collected_cents, 6_850n);   // $68.50 of the $75 estimate
  assert.equal(extensionFeeCents(56_000_000n, 8), 70_000n);   // $700.00 = 560,000 × 0.00125
  assert.equal(pointsCents(56_000_000n, "0.125"), 70_000n);   // $700.00 of points at 6.250 %
  assert.equal(aprEstimatePct(56_000_000n, "6.125", 0n), "6.125"); assert.equal(aprEstimatePct(56_000_000n, "6.250", 70_000n), "6.262");
  assert.equal(lockExpiry(D("2026-10-07"), 45).display, "11/23/2026 at 5:00 p.m. MST"); assert.equal(commitmentExpiry(D("2026-11-23"), D("2026-10-07")), "2026-12-07");
  const late = lateLockWarning({ loan_amount_cents: 56_000_000n, before: { note_rate_pct: "6.125", points_cents: 0n }, after: { note_rate_pct: "6.250", points_cents: 70_000n }, corrected_cd_received_on: D("2026-11-03"), scheduled_consummation_on: D("2026-11-06") });
  assert.equal(late.earliest_consummation_on, "2026-11-09");   // Wed 4, Thu 5, Fri 6 (3 specific business days) → Sat Nov 7 → Mon Nov 9 (Sunday excluded)
  const typed: PlainDate = D("2026-10-07"); assert.equal(typed, "2026-10-07");
});
