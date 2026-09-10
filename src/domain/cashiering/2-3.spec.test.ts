// 2.3 Automatic draft (ACH) setup
// spec/sections/02-payment-processing-cashiering/2-3-automatic-draft-ach-setup.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { CashieringService } from "./service.ts";
import type { LoanCashState } from "./types.ts";
const AGENT = { kind: "agent" as const, id: "cashiering" };
function L1(o: Partial<LoanCashState> = {}, firstDue = D("2026-09-01"), n = 4): LoanCashState {
  const installments = Array.from({ length: n }, (_, i) => ({ due_date: addMonths(firstDue, i), pi_cents: 158_017n, escrow_cents: 61_240n, status: "due" as const }));
  return { loan_id: "L-1", instrument_date: D("2021-07-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: 24_977_400n, lpi_date: D("2026-08-01"), installments,
    late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false, late_charge_pct: "5", late_charge_grace_days: 15, fees: [], overlays: [], ...o };
}
function harness(nowIso: string, loan: LoanCashState) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const store = new Map<string, LoanCashState>([[loan.loan_id, loan]]);
  const svc = new CashieringService({ events, ledger, clock, loans: { get: (id) => store.get(id), put: (s) => store.set(s.loan_id, s) }, custodial: { clearing: "C-CLR", pi: "C-PI", ti: "C-TI" } });
  const pay = (amount: bigint, on: string, extra: Record<string, unknown> = {}) => {
    const p = svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: amount, received_at: `${on}T14:00:00.000Z`, loan_id: loan.loan_id, source_item_id: `${on}-${amount}`, ...extra }).payment;
    svc.identify(p.id, loan.loan_id); return svc.post(p.id);
  };
  return { clock, events, ledger, svc, pay, state: () => store.get(loan.loan_id)! };
}
import { newEnrollment, handleReturn, voiceEnrollmentEvidence, terminateOnTransferOut, fileLoans, authorizationDefects, canOriginateDebit, draftAmount, variableAmountNoticeStatus, r11CorrectionWindowEnd, releaseFromReview, type Authorization } from "./autodraft.ts";
import { assessLateCharge } from "./latecharges.ts";
import { SYSTEM, eventMatches } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { CashieringOps } from "./ops.ts";
import { NoticeRegistry } from "../../notices/registry.ts";
import { publishSection02 } from "../../notices/authored/section02.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { validateDraftDay, settlementDateFor, revocationEffect } from "./autodraft.ts";
import { servicer, federal, addBusinessDays } from "../../kernel/calendar/business.ts";
import { nsfFee, recordFee } from "./latecharges.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
/** The 2.3 tools on the bus (nacha.build_entry guardrails refuse a third NSF retry and any reinitiation of an unauthorized return). */
function bus23(h: ReturnType<typeof harness>, timers: TimerEngine) {
  const agents = new AgentRegistry(); const cmds = bindTools({ store: new EntityStore(), ports: {}, escalations: new EscalationService(h.events, h.clock), services: {} }, agents); const bus = new CommandBus(agents);
  const ctx: UowContext = { loanId: "L-1", events: h.events, ledger: h.ledger, timers, clock: h.clock, decide: () => {} };
  return { build: (input: Record<string, unknown>) => bus.execute(cmds.get(toolKey("2.3", "nacha.build_entry"))!, AGENT, input, ctx) };
}
const AUTH: Authorization = { borrower_name: "B", loan_number_masked: "******1234", routing: "021000021", account_last4: "9876", account_type: "checking", amount_rule: "full_periodic_payment", variable_amount_statement: true, frequency: "monthly", first_debit_on: D("2026-10-01"), authorized_on: D("2026-09-20"), company_name: "SUPERMORTGAGE", revocation_instructions: true, optional_statement: true, esign_consent: true, sec: "WEB" };

test("2.3-T1: Given a WEB enrollment, when authorization is captured, then all Nacha/Reg E elements are present (checklist), a copy notice is sent within 1 BD, and no debit is possible until `validation_status` is validated.", () => {
  const clock = new FixedClock("2026-09-20T15:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.3"] });
  const ops = new CashieringOps({ events, clock });
  assert.deepEqual(authorizationDefects(AUTH), []);                                   // rule 1 checklist: every Nacha/Reg E element present
  assert.deepEqual(authorizationDefects({ ...AUTH, revocation_instructions: false, optional_statement: false }), ["revocation_instructions", "optional_statement (Reg E 1005.10(e)(1))"]);
  const e = newEnrollment("L-1", AUTH, 1, 10_000n);
  const { copy_due_by } = ops.authorizeEnrollment(e, D("2026-09-20"));
  assert.equal(e.status, "authorized"); assert.equal(copy_due_by, "2026-09-21");     // 1 servicer BD after Sunday 2026-09-20
  const copy = timers.byCode("SM_AUTODRAFT_COPY_DELIVERY_1BD")[0]!; assert.equal(copy.dueDate, "2026-09-21"); assert.equal(copy.status, "armed");
  assert.equal(timers.byCode("NACHA_WEB_ACCOUNT_VALIDATION_GATE").length, 1);         // WEB: the validation gate arms with the authorization
  assert.equal(events.ofType("notice.queued").find((x) => x.payload.template === "AUTODRAFT-CONFIRM-v1")!.payload.due_by, "2026-09-21");
  // no debit until validated: neither an authorized nor an active-but-unvalidated enrollment can originate
  assert.deepEqual(canOriginateDebit(e), { ok: false, reason: "enrollment is authorized, not active", gate: "ENROLLMENT_ACTIVE" });
  e.status = "active"; const gate = canOriginateDebit(e); assert.equal(gate.ok, false); if (!gate.ok) assert.equal(gate.gate, "NACHA_WEB_ACCOUNT_VALIDATION_GATE");
  assert.equal(ops.scheduleEntry(e, D("2026-10-01"), D("2026-10-01"), 229_257n).ok, false); assert.equal(events.ofType("autodraft.entry.refused").length, 1);
  assert.equal(evaluateGate("2.3.accountValidated", { validation_status: "pending" }).open, false);
  ops.completeValidation(e, "validated_api", D("2026-09-20"), D("2026-10-01"));
  assert.equal(e.status, "active"); assert.equal(e.validation_status, "validated"); assert.equal(e.next_draft_on, "2026-10-01"); assert.equal(canOriginateDebit(e).ok, true);
  assert.equal(events.ofType("autodraft.validation.completed")[0]!.payload.status, "validated_api");
  assert.equal(ops.scheduleEntry(e, D("2026-10-01"), D("2026-10-01"), 229_257n).ok, true);
  // the copy delivered on Monday closes the 1-BD clock; the authored AUTODRAFT-CONFIRM-v1 carries the Nacha minimum elements and the Reg E statements
  clock.set("2026-09-21T14:00:00.000Z"); ops.sendEnrollmentConfirmation(e, D("2026-09-21")); assert.equal(copy.status, "satisfied");
  const reg = new NoticeRegistry(); publishSection02(reg); const v = reg.activeVersion("AUTODRAFT-CONFIRM-v1", D("2026-09-21"))!;
  const c = evaluateChecklist(v, v.samplePayload, render(v.source, v.samplePayload)); assert.equal(c.passed, true);
  assert.deepEqual(c.results.map((x) => x.rule_id).filter((id) => id.startsWith("nacha-")), ["nacha-consumer-name", "nacha-account", "nacha-amount", "nacha-timing", "nacha-date", "nacha-revocation"]);
  assert.ok(c.results.some((x) => x.rule_id === "optional" && x.passed) && c.results.some((x) => x.rule_id === "variable-amount-notice" && x.passed));
  const unmasked = { ...v.samplePayload, account_masked: "123456789876" }; assert.ok(evaluateChecklist(v, unmasked, render(v.source, unmasked)).blocking.some((b) => b.rule_id === "account-masked"));
});
test("2.3-T2: Given a borrower-chosen draft day of the 20th, when scheduling, then the validator rejects it (grace end = 16th) and offers ≤ 16th.", () => {
  // rule 3 / C-1.1-03: due day 1 + 15 grace days → the latest settlement day is the 16th; the 20th is refused and the validator offers ≤ 16
  const v = validateDraftDay(20, 1, 15); assert.equal(v.ok, false);
  if (!v.ok) { assert.equal(v.latest_day, 16); assert.equal(v.reason, "draft day must be between 1 and 16 (due 1 + grace 15)"); }
  assert.equal(validateDraftDay(16, 1, 15).ok, true); assert.equal(validateDraftDay(17, 1, 15).ok, false);
  // the same gate on the scheduler: an active, validated enrollment asking for 2026-10-20 is rejected on FNMA_C1103_DRAFT_BY_PENALTY_FREE_DATE_GATE and no entry is scheduled
  const clock = new FixedClock("2026-09-29T19:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.3"] }); const ops = new CashieringOps({ events, clock });
  const e = newEnrollment("L-1", AUTH, 20, 10_000n); e.status = "active"; e.validation_status = "validated"; e.last_debit_cents = 229_257n;
  const late = ops.scheduleEntry(e, D("2026-10-01"), D("2026-10-20"), 229_257n, { today: D("2026-09-29") });
  assert.equal(late.ok, false); if (!late.ok) { assert.equal(late.gate, "FNMA_C1103_DRAFT_BY_PENALTY_FREE_DATE_GATE"); assert.match(late.reason, /between 1 and 16/); }
  assert.equal(events.ofType("autodraft.entry.scheduled").length, 0); assert.equal(timers.byCode("FNMA_C1103_DRAFT_BY_PENALTY_FREE_DATE_GATE").length, 0);
  assert.equal(evaluateGate("2.3.settlementWithinGrace", { settlement_date: "2026-10-20", due_date: "2026-10-01", grace_days: 15 }).open, false);   // 10-20 > 10-16
  assert.equal(evaluateGate("2.3.settlementWithinGrace", { settlement_date: "2026-10-16", due_date: "2026-10-01", grace_days: 15 }).open, true);
  // the offered day (16th) settles on Friday 2026-10-16: the entry is scheduled and the C-1.1-03 gate arms on it, anchored on the installment due date
  e.draft_day = 16; assert.equal(settlementDateFor(D("2026-10-01"), 16, 15, servicer), "2026-10-16");
  const ok = ops.scheduleEntry(e, D("2026-10-01"), settlementDateFor(D("2026-10-01"), 16, 15, servicer), 229_257n, { today: D("2026-09-29") }); assert.equal(ok.ok, true);
  const gate = timers.byCode("FNMA_C1103_DRAFT_BY_PENALTY_FREE_DATE_GATE")[0]!; assert.equal(gate.anchorDate, "2026-10-01"); assert.equal(gate.note, "evaluator:2.3.settlementWithinGrace");
  assert.equal(events.ofType("autodraft.entry.scheduled")[0]!.payload.settlement_date, "2026-10-16");
  // rule 3 rolling: a non-banking chosen day settles the next banking day when that stays ≤ the 16th, else the preceding banking day
  assert.equal(settlementDateFor(D("2026-11-01"), 1, 15, servicer), "2026-11-02");      // Sunday 11-01 → Monday (≤ 11-16)
  assert.equal(settlementDateFor(D("2026-08-01"), 16, 15, servicer), "2026-08-14");     // Sunday 08-16: Monday 08-17 would breach → preceding Friday
});
test("2.3-T3: Given an escrow analysis changing P effective 2027-01-01, when no notice has been sent by 2026-12-22, then the 2027-01-01 entry is held and a sev-2 escalation is raised; when the annual statement carrying amount and date was sent 2026-12-12, the entry is released.", () => {
  const scenario = () => { const clock = new FixedClock("2026-12-10T15:00:00.000Z"); const events = new MemoryEventStore(clock); const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.3"] }); const ops = new CashieringOps({ events, clock });
    const e = newEnrollment("L-1", AUTH, 1, 10_000n); e.status = "active"; e.validation_status = "validated"; e.last_debit_cents = draftAmount(e, 219_257n, 0n);
    events.append({ type: "loan_terms.activated", loanId: "L-1", actor: SYSTEM, payload: { reason: "escrow_analysis", effective_on: "2027-01-01", scheduled_settlement_date: "2027-01-01", escrow_payment_cents: "64916" } });
    return { clock, events, timers, ops, e, t: timers.byCode("REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10")[0]! }; };
  const a = scenario();
  assert.equal(a.e.last_debit_cents, 229_257n);                                     // example E: 219,257 + 10,000 extra principal
  const newAmount = draftAmount(a.e, 158_017n + 64_916n, 0n); assert.equal(newAmount, 232_933n);   // rule 4 after the escrow analysis: $2,329.33
  assert.equal(a.t.dueDate, "2026-12-22");                                           // −10 calendar days from the 2027-01-01 settlement
  const st = variableAmountNoticeStatus(a.e, newAmount, D("2027-01-01"), D("2026-12-23")); assert.equal(st.ok, false); if (!st.ok) { assert.equal(st.deadline, "2026-12-22"); assert.equal(st.action, "hold_entry_escalate"); }
  a.clock.set("2026-12-23T19:00:00.000Z");
  const held = a.ops.scheduleEntry(a.e, D("2027-01-01"), D("2027-01-01"), newAmount, { today: D("2026-12-23") });
  assert.equal(held.ok, false); if (!held.ok) assert.equal(held.gate, "REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10");
  assert.equal(a.events.ofType("autodraft.entry.held").length, 1); assert.equal(a.events.ofType("autodraft.entry.scheduled").length, 0);
  assert.equal(a.events.ofType("escalation.requested")[0]!.payload.severity, "sev-2");
  assert.ok(a.timers.evaluate("2026-12-23T19:00:00.000Z").some((b) => b.def.code === "REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10")); assert.equal(a.t.status, "breached");
  // the annual escrow statement mailed 2026-12-12 stating "$2,329.33 will be drafted on 01/01/2027" satisfies the 10-day rule and the entry is released
  const b = scenario();
  b.clock.set("2026-12-12T15:00:00.000Z"); b.ops.sendVariableAmountNotice(b.e, newAmount, D("2027-01-01"), D("2026-12-12"), "ESCROW-ANNUAL-v1");
  assert.equal(b.t.status, "satisfied"); assert.equal(b.events.ofType("notice.sent")[0]!.payload.on_time, true);
  assert.deepEqual(variableAmountNoticeStatus(b.e, newAmount, D("2027-01-01"), D("2026-12-23")), { ok: true, satisfied_by: "ESCROW-ANNUAL-v1" });
  b.clock.set("2026-12-23T19:00:00.000Z"); assert.equal(b.ops.scheduleEntry(b.e, D("2027-01-01"), D("2027-01-01"), newAmount, { today: D("2026-12-23") }).ok, true);
  assert.equal(b.events.ofType("autodraft.entry.scheduled")[0]!.payload.amount_cents, "232933");
  // the dedicated AUTODRAFT-AMOUNT-CHANGE-v1 carries the amount and date and is only publishable ≥ 10 days ahead
  const reg = new NoticeRegistry(); publishSection02(reg); const v = reg.activeVersion("AUTODRAFT-AMOUNT-CHANGE-v1", D("2026-12-12"))!;
  const payload = { ...v.samplePayload, new_amount_cents: newAmount, days_before_debit: 20 }; const r = render(v.source, payload);
  assert.match(r.text, /On January 1, 2027 we will debit \$2,329\.33/); assert.equal(evaluateChecklist(v, payload, r).passed, true);
  const late = { ...payload, days_before_debit: 9 }; assert.ok(evaluateChecklist(v, late, render(v.source, late)).blocking.some((x) => x.rule_id === "ten-days"));
});
test("2.3-T4: Given a revocation received 2 business days before settlement with the file already transmitted, when the debit settles, then a same-day PPD refund is originated and `officer` is notified.", () => {
  const clock = new FixedClock("2026-09-29T15:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.3"] }); const ops = new CashieringOps({ events, clock });
  const e = newEnrollment("L-1", AUTH, 1, 10_000n); e.status = "active"; e.validation_status = "validated";
  // settlement Thursday 2026-10-01; the Reg E 3-business-day gate (federal proxy) closes 2026-09-28; the file went out 09-28 and the revocation arrives Tuesday 09-29 — 2 business days before
  assert.equal(addBusinessDays(D("2026-10-01"), -3, federal), "2026-09-28"); assert.equal(addBusinessDays(D("2026-10-01"), -2, federal), "2026-09-29");
  assert.deepEqual(revocationEffect(D("2026-09-29"), D("2026-09-28"), D("2026-10-01")), { stop_entry: false, refund_same_day: true, officer_notice: true });
  const eff = ops.receiveRevocation(e, D("2026-09-29"), { channel: "portal", scheduled_settlement_date: D("2026-10-01"), file_transmitted_on: D("2026-09-28"), trace: `${e.id}:2026-10-01` });
  assert.deepEqual([eff.stop_entry, eff.refund_same_day, eff.officer_notice, eff.retention_until], [false, true, true, "2028-09-29"]);
  assert.equal(e.status, "revoked"); assert.equal(events.ofType("ach.entry.cancelled").length, 0);                       // transmitted entries are not reversible (rule 6)
  const gate = timers.byCode("REGE_1005_10C_STOP_PAYMENT_3BD_GATE")[0]!; assert.equal(gate.dueDate, "2026-09-28"); assert.equal(gate.status, "armed");
  // the debit settles 2026-10-01: a same-day PPD refund credit is originated and the officer is told; the gate breaches with the spec's breach action
  clock.set("2026-10-01T20:00:00.000Z");
  const refund = events.ofType("ach.credit.refund_originated")[0]!;
  assert.equal(refund.payload.refund_on, "2026-10-01"); assert.equal(refund.payload.sec_code, "PPD"); assert.equal(refund.payload.direction, "credit"); assert.equal(refund.payload.same_day, true);
  assert.equal(refund.payload.company_entry_description, "REFUND"); assert.equal(refund.payload.reason, "debit settled after a timely revocation (treated as unauthorized)");
  const officer = events.ofType("escalation.requested").find((x) => x.payload.to === "officer")!; assert.equal(officer.payload.reason, "debit transmitted after a timely revocation"); assert.equal(officer.payload.enrollment_id, e.id);
  const breach = timers.evaluate("2026-10-01T20:00:00.000Z").find((b) => b.def.code === "REGE_1005_10C_STOP_PAYMENT_3BD_GATE")!;
  assert.equal(gate.status, "breached"); assert.deepEqual([...breach.escalateTo], ["officer"]); assert.match(breach.breachText, /treat as unauthorized: immediate refund credit \+ `officer` notice/);
  assert.ok(events.ofType("notice.queued").some((x) => x.payload.template === "AUTODRAFT-REVOKED-v1"));
  // contrast: the same revocation received 3 business days before (09-28) with the file still unsent cancels the entry and nothing is refunded
  const e2 = newEnrollment("L-2", AUTH, 1); e2.status = "active"; e2.validation_status = "validated";
  const timely = ops.receiveRevocation(e2, D("2026-09-28"), { channel: "portal", scheduled_settlement_date: D("2026-10-01"), file_transmitted_on: null });
  assert.deepEqual([timely.stop_entry, timely.refund_same_day, timely.officer_notice], [true, false, false]); assert.equal(events.ofType("ach.credit.refund_originated").length, 1);
  assert.equal(timers.byCode("REGE_1005_10C_STOP_PAYMENT_3BD_GATE")[1]!.status, "satisfied");                            // `ach.entry.cancelled`
});
test('2.3-T5: Given an R01 return, when processed, then the payment is reversed, the fee (if permitted) posted, notice sent, and one retry scheduled with "RETRY PYMT"; a third attempt within 180 days is refused.', async () => {
  // example E: the 2027-02-01 debit (229,257¢ incl. 10,000¢ extra principal) posts, then returns R01 on 2027-02-03
  const h = harness("2027-02-01T14:00:00.000Z", L1({ upb_cents: 24_921_831n, lpi_date: D("2027-01-01") }, D("2027-02-01"), 3));
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.3"] }); const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const posted = h.pay(229_257n, "2027-02-01", { curtailment_cents: 10_000n });
  assert.equal(h.state().lpi_date, "2027-02-01"); assert.equal(h.state().upb_cents, 24_888_807n);   // Feb: interest 24,921,831 × 0.065 ÷ 12 = 134,993.25 → 134,993; principal 158,017 − 134,993 = 23,024; UPB 24,921,831 − 23,024 − 10,000
  h.clock.set("2027-02-03T15:00:00.000Z");
  const reversed = h.svc.reverse(posted.payment.id, "returned_item", { return_code: "R01" });
  assert.equal(reversed.status, "reversed"); assert.equal(h.state().lpi_date, "2027-01-01"); assert.equal(h.state().upb_cents, 24_921_831n);   // Reversal Engine restores the pre-payment state
  assert.equal(h.events.ofType("payment.reversed")[0]!.payload.return_code, "R01");
  const fee = nsfFee(h.state(), { allowed: true, cap_cents: null }, { our_error: false, returned_on: D("2027-02-03"), payment_id: posted.payment.id })!;
  assert.equal(fee.amount_cents, 2_500n); recordFee(h.state(), fee); assert.equal(h.state().nsf_fees_due_cents, 2_500n);                          // 2.7 rule 8: $25 where permitted
  assert.equal(nsfFee(h.state(), { allowed: false, cap_cents: null }, { our_error: false, returned_on: D("2027-02-03"), payment_id: posted.payment.id }), null);   // not permitted → nothing posted
  // the return disposition: reverse, fee, AUTODRAFT-RETURN-v1 (+RETRY-v1), one retry 3 banking days later with "RETRY PYMT"
  const e = newEnrollment("L-1", AUTH, 1, 10_000n); e.status = "active"; e.validation_status = "validated";
  const retryOn = (from: PlainDate) => addBusinessDays(from, 3, federal);
  const r1 = ops.handleReturn(e, "R01", D("2027-02-03"), { authorization_valid: true, original_entry_on: D("2027-02-01"), retryOn, trace: `${e.id}:2027-02-01`, amount_cents: 229_257n });
  assert.deepEqual([r1.reverse_payment, r1.assess_nsf_fee, r1.notice, r1.retry_on, r1.company_entry_description, r1.enrollment_action], [true, true, "AUTODRAFT-RETURN-v1", "2027-02-08", "RETRY PYMT", "none"]);
  const notice = h.events.ofType("notice.queued").find((x) => x.payload.template === "AUTODRAFT-RETURN-v1")!; assert.equal(notice.payload.retry_on, "2027-02-08"); assert.equal(notice.payload.with, "AUTODRAFT-RETRY-v1");
  const retry = h.events.ofType("ach.entry.reinitiation_scheduled"); assert.equal(retry.length, 1); assert.equal(retry[0]!.payload.company_entry_description, "RETRY PYMT"); assert.equal(retry[0]!.payload.reinitiation_count, 1);
  const counter = timers.byCode("NACHA_NSF_REINITIATION_180_MAX2")[0]!; assert.equal(counter.anchorDate, "2027-02-01"); assert.equal(counter.note, "evaluator:2.3.reinitiationLimit");   // armed by ach.return.received{reason_code=R01}
  assert.equal(evaluateGate("2.3.reinitiationLimit", { reinitiations_within_180_days: 1 }).open, true);
  // a later installment returns R01 again: second and last reinitiation within 180 days; the third attempt (2027-06-03, 115 days after the first retry) is refused
  e.returns_on_current_installment = 0; const r2 = ops.handleReturn(e, "R01", D("2027-04-03"), { authorization_valid: true, original_entry_on: D("2027-04-01"), retryOn });
  assert.equal(r2.retry_on, "2027-04-07"); assert.equal(e.reinitiations.length, 2);
  e.returns_on_current_installment = 0; const r3 = ops.handleReturn(e, "R01", D("2027-06-03"), { authorization_valid: true, original_entry_on: D("2027-06-01"), retryOn });
  assert.equal(r3.retry_on, null); assert.equal(r3.company_entry_description, null); assert.equal(r3.refused, "at most two reinitiations within 180 days (Nacha)");
  assert.equal(h.events.ofType("ach.entry.reinitiation_scheduled").length, 2); assert.equal(timers.byCode("NACHA_NSF_REINITIATION_180_MAX2").length, 3);
  assert.equal(evaluateGate("2.3.reinitiationLimit", { reinitiations_within_180_days: 2 }).open, false);
  await assert.rejects(bus23(h, timers).build({ enrollment_id: e.id, amount_cents: "229257", settlement_date: "2027-06-08", sec_code: "WEB", enrollment_status: "active", validation_status: "validated_api", nsf_reinitiations: 2 }),
    (err: unknown) => err instanceof CommandRefused && err.code === "NSF_RETRY_MAX2");
  // a second return on the same installment suspends the enrollment instead (rule 7)
  const e2 = newEnrollment("L-1", AUTH, 1); e2.status = "active"; e2.validation_status = "validated"; e2.returns_on_current_installment = 1;
  assert.equal(ops.handleReturn(e2, "R01", D("2027-02-10"), { authorization_valid: true, retryOn }).enrollment_action, "suspended_returns"); assert.equal(e2.status, "suspended_returns");
});
test("2.3-T6: Given an R10 return, when processed, then the enrollment is cancelled, no reinitiation occurs, and a fraud case opens if a valid authorization exists.", async () => {
  const h = harness("2027-02-03T15:00:00.000Z", L1());
  const timers = new TimerEngine(loadOverriddenRegistry(), h.events, { processes: ["2.3"] }); const ops = new CashieringOps({ events: h.events, clock: h.clock });
  const retryOn = (from: PlainDate) => addBusinessDays(from, 3, federal);
  const e = newEnrollment("L-1", AUTH, 1, 10_000n); e.status = "active"; e.validation_status = "validated";
  const r10 = ops.handleReturn(e, "R10", D("2027-02-03"), { authorization_valid: true, original_entry_on: D("2027-02-01"), retryOn, trace: `${e.id}:2027-02-01` });
  assert.deepEqual([r10.enrollment_action, r10.retry_on, r10.company_entry_description, r10.open_fraud_case, r10.reverse_payment, r10.assess_nsf_fee, r10.notice], ["revoked", null, null, true, true, false, "AUTODRAFT-REVOKED-v1"]);
  assert.equal(e.status, "revoked"); assert.equal(canOriginateDebit(e).ok, false); assert.deepEqual(fileLoans([e], D("2027-02-08")), []);
  assert.equal(h.events.ofType("ach.entry.reinitiation_scheduled").length, 0);                                            // never reinitiated
  const fraud = h.events.ofType("fraud.case.opened"); assert.equal(fraud.length, 1); assert.equal(fraud[0]!.payload.return_code, "R10"); assert.match(String(fraud[0]!.payload.reason), /dispute with the RDFI through the ODFI/);
  const revoked = h.events.ofType("autodraft.revoked")[0]!; assert.equal(revoked.payload.return_code, "R10"); assert.equal(revoked.payload.revoked_at, "2027-02-03"); assert.equal(revoked.payload.retention_until, "2029-02-03");
  const retention = timers.byCode("NACHA_AUTH_RETENTION_2Y_POST_REVOCATION")[0]!; assert.equal(retention.dueDate, "2029-02-03"); assert.equal(retention.status, "satisfied");   // `retention.class_applied{class=tpsc_2y_post_revocation}`
  assert.equal(timers.byCode("NACHA_NSF_REINITIATION_180_MAX2").length, 0);                                               // the R01/R09 counter never arms on an unauthorized code
  // the bus refuses any reinitiation of an unauthorized return, even for an otherwise eligible enrollment
  await assert.rejects(bus23(h, timers).build({ enrollment_id: e.id, amount_cents: "229257", settlement_date: "2027-02-08", sec_code: "WEB", enrollment_status: "active", validation_status: "validated_api", reinitiating_return_code: "R10" }),
    (err: unknown) => err instanceof CommandRefused && err.code === "NO_UNAUTHORIZED_REINITIATION");
  // without a valid authorization on file the enrollment is still cancelled but no fraud case is opened
  const e2 = newEnrollment("L-2", AUTH, 1); e2.status = "active"; e2.validation_status = "validated";
  const bare = ops.handleReturn(e2, "R10", D("2027-02-03"), { authorization_valid: false, retryOn });
  assert.equal(bare.enrollment_action, "revoked"); assert.equal(bare.open_fraud_case, false); assert.equal(e2.status, "revoked"); assert.equal(h.events.ofType("fraud.case.opened").length, 1);
});
test("2.3-T7: Given an R11 return for a wrong amount, when corrected within 60 days, then the corrected entry is transmitted without new authorization; on day 61 the engine refuses.", () => {
  const clock = new FixedClock("2027-03-01T15:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.3"] });
  const ops = new CashieringOps({ events, clock });
  const retryOn = (d: PlainDate) => addDays(d, 5);
  assert.equal(r11CorrectionWindowEnd(D("2027-03-01")), "2027-04-30");            // 60 calendar days from the Settlement Date of the Return Entry
  const e = newEnrollment("L-1", AUTH, 1); e.status = "active"; e.validation_status = "validated";
  const ok = ops.handleReturn(e, "R11", D("2027-03-01"), { authorization_valid: true, defect_ours: true, original_entry_on: D("2027-01-05"), corrected_on: D("2027-04-30"), retryOn, trace: "E-1:2027-02-26" });
  assert.equal(ok.enrollment_action, "correct_and_reinitiate"); assert.equal(ok.retry_on, "2027-04-30"); assert.equal(ok.company_entry_description, "RETRY PYMT"); assert.equal(ok.correction_window_ends_on, "2027-04-30");
  assert.equal(e.status, "active");                                                  // no new authorization
  const t = timers.byCode("NACHA_R11_CORRECTED_REINITIATION_60")[0]!; assert.equal(t.dueDate, "2027-04-30"); assert.equal(t.status, "satisfied");
  assert.equal(events.ofType("ach.return.received")[0]!.payload.R11, true);
  assert.equal(events.ofType("ach.r11.resolved")[0]!.payload.outcome, "corrected_reinitiated"); assert.equal(events.ofType("ach.entry.reinitiation_scheduled")[0]!.payload.company_entry_description, "RETRY PYMT");
  // day 61: refused — the window closed, the enrollment is treated as revoked and a new authorization is required
  const e2 = newEnrollment("L-2", AUTH, 1); e2.status = "active"; e2.validation_status = "validated";
  const late = ops.handleReturn(e2, "R11", D("2027-03-01"), { authorization_valid: true, defect_ours: true, original_entry_on: D("2027-01-05"), corrected_on: D("2027-05-01"), retryOn });
  assert.equal(late.enrollment_action, "revoked"); assert.match(late.refused!, /60 days from the return settlement date 2027-03-01 \(closed 2027-04-30\); new authorization required/); assert.equal(e2.status, "revoked");
  assert.equal(events.ofType("ach.r11.resolved")[1]!.payload.outcome, "not_reinitiated");
  // the window is anchored on the return, not the original entry: an entry from 2027-01-05 returned 2027-03-07 may still be corrected on 2027-03-12
  assert.equal(handleReturn(newEnrollment("L-3", AUTH, 1), "R11", D("2027-03-07"), { authorization_valid: true, defect_ours: true, original_entry_on: D("2027-01-05"), corrected_on: D("2027-03-12"), retryOn }).enrollment_action, "correct_and_reinitiate");
  assert.match(handleReturn(newEnrollment("L-4", AUTH, 1), "R11", D("2027-03-01"), { authorization_valid: true, defect_ours: false, retryOn }).refused!, /defect not ours/);
});
test("2.3-T8: Given the 60-day unauthorized return rate reaches 0.6%, when the monthly watch runs, then `officer` and the ODFI are notified and enrollments from the affected channel are held for review.", () => {
  const clock = new FixedClock("2026-10-31T23:30:00.000Z"); const events = new MemoryEventStore(clock);
  const ops = new CashieringOps({ events, clock });
  const web = newEnrollment("L-1", AUTH, 1); web.status = "active"; web.validation_status = "validated";
  const ppd = newEnrollment("L-2", { ...AUTH, sec: "PPD" }, 1); ppd.status = "active"; ppd.validation_status = "validated";
  // the monthly watch is a recurring row: month end arms it, the report closes it (patterns checked against the registry directly — the
  // engine re-arms a recurring row inside its own satisfaction loop and would re-satisfy it with the same event; see src/kernel/timers/engine.ts onEvent)
  const def = loadOverriddenRegistry().get("NACHA_RETURN_RATE_MONTHLY_WATCH")!; assert.equal(def.kindNorm, "recurring"); assert.equal(def.offsetParsed.kind, "recurring");
  const monthEnd = events.append({ type: "period.month_end", actor: SYSTEM, payload: { period_end: "2026-10-31" } });
  assert.equal(eventMatches(def.triggerPattern!, monthEnd), true);
  const { report, held, notified } = ops.monthlyReturnRateWatch([web, ppd], [{ channel: "WEB", debits: 1000, unauthorized_returns: 6, administrative_returns: 4, total_returns: 30 }, { channel: "PPD", debits: 2000, unauthorized_returns: 2, administrative_returns: 10, total_returns: 40 }], D("2026-10-31"));
  assert.deepEqual(report.channels.map((c) => [c.channel, c.unauthorized_bps, c.breaches]), [["WEB", 60, ["unauthorized"]], ["PPD", 10, []]]);   // 0.6% > 0.5% on WEB only
  assert.deepEqual(report.breached_channels, ["WEB"]); assert.deepEqual(notified, ["officer", "odfi"]);
  assert.equal(events.ofType("escalation.requested")[0]!.payload.to, "officer"); assert.equal(events.ofType("odfi.notified")[0]!.payload.channel, "WEB");
  assert.deepEqual(held.map((x) => x.loan_id), ["L-1"]); assert.equal(web.held_for_review!.reason, "return_rate_review"); assert.equal(ppd.held_for_review, undefined);
  assert.deepEqual(fileLoans([web, ppd], D("2026-11-01")), ["L-2"]);                 // the held channel is out of every file until released
  assert.equal(canOriginateDebit(web).ok, false); assert.equal(events.ofType("autodraft.enrollment.held_for_review")[0]!.payload.enrollment_id, web.id);
  const produced = events.ofType("report.produced")[0]!; assert.equal(produced.payload.report, "nacha_return_rate"); assert.equal(eventMatches(def.satisfiedPattern!, produced), true);
  releaseFromReview(web); assert.deepEqual(fileLoans([web, ppd], D("2026-11-01")), ["L-1", "L-2"]);
});
test("2.3 lifecycle clocks: prenote wait → validation; oral revocation → stop-payment gate, 14-day written confirmation, 2-year retention class — every row armed and satisfied by the events ops emits", () => {
  const clock = new FixedClock("2026-09-20T15:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["2.3"] });
  const ops = new CashieringOps({ events, clock });
  const e = newEnrollment("L-1", { ...AUTH, sec: "PPD" }, 1); ops.authorizeEnrollment(e, D("2026-09-20"));
  ops.transmitPrenote(e, D("2026-09-22"));
  const prenote = timers.byCode("NACHA_PRENOTE_WAIT_3BANKING_DAYS")[0]!; assert.equal(prenote.dueDate, "2026-09-25"); assert.equal(e.status, "validating");   // 3 banking days after the prenote settlement
  clock.set("2026-09-25T15:00:00.000Z"); ops.completeValidation(e, "validated_prenote", D("2026-09-25"), D("2026-10-01"));
  assert.equal(prenote.status, "satisfied"); assert.equal(e.status, "active");
  // an oral revocation 3 business days before the 2026-10-01 settlement stops the unsent entry; the retention class runs 2 years from the revocation
  clock.set("2026-09-28T15:00:00.000Z");
  const eff = ops.receiveRevocation(e, D("2026-09-28"), { channel: "oral", scheduled_settlement_date: D("2026-10-01"), file_transmitted_on: null, trace: "E:2026-10-01" });
  assert.deepEqual([eff.stop_entry, eff.refund_same_day, eff.officer_notice, eff.retention_until], [true, false, false, "2028-09-28"]);
  const stop = timers.byCode("REGE_1005_10C_STOP_PAYMENT_3BD_GATE")[0]!; assert.equal(stop.dueDate, "2026-09-28"); assert.equal(stop.status, "satisfied");   // `ach.entry.cancelled`
  const written = timers.byCode("REGE_1005_10C_WRITTEN_CONFIRMATION_14")[0]!; assert.equal(written.dueDate, "2026-10-12"); assert.equal(written.status, "armed");
  const retention = timers.byCode("NACHA_AUTH_RETENTION_2Y_POST_REVOCATION")[0]!; assert.equal(retention.dueDate, "2028-09-28"); assert.equal(retention.status, "satisfied");   // `retention.class_applied{class=tpsc_2y_post_revocation}`
  assert.equal(e.status, "revoked"); assert.ok(events.ofType("notice.queued").some((x) => x.payload.template === "AUTODRAFT-REVOKED-v1"));
  ops.confirmRevocationInWriting(e, D("2026-10-02")); assert.equal(written.status, "satisfied");
  // a revocation after the file went out: the debit is refunded the same day and the officer is told
  const e2 = newEnrollment("L-2", AUTH, 1); e2.status = "active"; e2.validation_status = "validated";
  const late = ops.receiveRevocation(e2, D("2026-09-29"), { channel: "portal", scheduled_settlement_date: D("2026-10-01"), file_transmitted_on: D("2026-09-28") });
  assert.deepEqual([late.stop_entry, late.refund_same_day, late.officer_notice], [false, true, true]); assert.equal(events.ofType("ach.credit.refund_originated").length, 1);
  // Nacha fraud-monitoring procedures: adoption arms the 365-day review; the officer's review matches the satisfying pattern (a recurring row, checked
  // against the registry on a side store — the engine re-arms a recurring row inside its own satisfaction loop; see the return-rate watch in 2.3-T8)
  const side = new MemoryEventStore(clock); const sideOps = new CashieringOps({ events: side, clock });
  const fraud = loadOverriddenRegistry().get("NACHA_FRAUD_PROCEDURES_ANNUAL_REVIEW_365")!; assert.equal(fraud.kindNorm, "recurring");
  assert.equal(eventMatches(fraud.triggerPattern!, sideOps.adoptFraudPolicy(D("2026-09-01"), "u-officer")), true); assert.equal(eventMatches(fraud.satisfiedPattern!, sideOps.recordFraudPolicyReview(D("2027-08-15"), "u-officer")), true);
});
test("2.3-T9: Given the retry in example E settles 2027-02-08, when 2.7 evaluates February, then no late charge is assessed.", () => {
  const e = newEnrollment("L-1", AUTH, 1, 10_000n);
  const ret = handleReturn(e, "R01", D("2027-02-03"), { authorization_valid: true, retryOn: () => D("2027-02-08") });
  assert.equal(ret.reverse_payment, true); assert.equal(ret.retry_on, "2027-02-08"); assert.equal(ret.notice, "AUTODRAFT-RETURN-v1");
  // the retry settles 2027-02-08 → the February installment is credited 02-08, inside the grace period ending 02-16
  const feb = L1({ upb_cents: 24_921_831n, lpi_date: D("2027-01-01") }, D("2027-02-01"), 3);
  const a = assessLateCharge({ state: feb, installment_due_date: D("2027-02-01"), received_toward_basis_cents: 158_017n, run_on: D("2027-02-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(a.outcome, "not_assessed"); assert.equal(a.grace_end_on, "2027-02-16"); if (a.outcome === "not_assessed") assert.equal(a.reason, "paid within grace");
});
test("2.3-T10: Given a voice enrollment, when the call starts, then the AI disclosure is logged before any account data is requested, and the recording + written confirmation are linked to the consent.", () => {
  const good = voiceEnrollmentEvidence([{ at: "2026-09-20T15:00:00Z", kind: "ai_disclosure", text: "You are speaking with an automated assistant; say 'agent' for a person." }, { at: "2026-09-20T15:00:05Z", kind: "human_offered" }, { at: "2026-09-20T15:01:00Z", kind: "account_data_requested" }, { at: "2026-09-20T15:03:00Z", kind: "consent_given" }], { recording_id: "rec-1", written_confirmation_id: "conf-1" });
  assert.equal(good.ok, true); assert.equal(good.disclosure_before_account_data, true); assert.deepEqual(good.consent_links, { recording_id: "rec-1", written_confirmation_id: "conf-1" });
  const bad = voiceEnrollmentEvidence([{ at: "2026-09-20T15:00:00Z", kind: "account_data_requested" }, { at: "2026-09-20T15:00:30Z", kind: "ai_disclosure" }], { recording_id: "rec-2", written_confirmation_id: null });
  assert.equal(bad.ok, false); assert.deepEqual(bad.problems, ["AI disclosure must be logged before any account data is requested", "a human must be offered at the start of every voice/chat enrollment", "written confirmation not linked to the consent"]);
});
test("2.3-T11: Given a loan transferred out, when cutover completes, then the enrollment is `terminated` and no file after cutover contains the loan.", () => {
  const e = newEnrollment("L-1", AUTH, 1); e.status = "active"; e.next_draft_on = D("2026-12-01");
  const other = newEnrollment("L-2", AUTH, 1); other.status = "active";
  assert.deepEqual(fileLoans([e, other], D("2026-11-25")), ["L-1", "L-2"]);
  terminateOnTransferOut(e, D("2026-12-01"));                                   // transfer.batch.cutover_completed
  assert.equal(e.status, "terminated"); assert.equal(e.termination_reason, "transfer_out"); assert.equal(e.next_draft_on, null);
  assert.deepEqual(fileLoans([e, other], D("2026-12-01")), ["L-2"]); assert.deepEqual(fileLoans([e, other], D("2027-01-01")), ["L-2"]);
});
