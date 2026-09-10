// 9.2 Force-placed insurance — first notice
// spec/sections/09-insurance-property-protection/9-2-force-placed-insurance-first-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id runs through the 9.2 case service (ops-9-2.ts) with the TimerEngine armed from the process's own events
// (registry + section + 9.2 overrides), so the §1024.37 clocks are proven as armed/satisfied timer instances, not as
// date arithmetic alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, type DomainEvent } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { Fpi92Service, fpiReactors_9_2, MS3A, type OpenCaseInput } from "./ops-9-2.ts";
import { fpiClocks, chargeDecision, escrowGuard, lpiCoverage, noticeChecklist, noticeSentenceKind, productionWindowOk, tierDeductible, premiumFromRate, boldItemsPresent } from "./fpi.ts";
import { dailyRate } from "./refund.ts";
import { placementConfig, firstNoticeVariant, fpiCaseOpen } from "./ops.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render, type Rendered } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";

const K5 = "9.2.escrowedAdvanceBeforeForcePlacement";   // evaluator behind REGX_1024_17K5_LPI_PURCHASE_GATE
const REG = loadOverriddenRegistry();
const CA_RULE = { state: "CA", hazard_amount_cap_rule: "rcv" as const };
function harness(nowIso = "2026-10-02T14:00:00.000Z") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const timers = new TimerEngine(REG, events, { processes: ["9.2"] });
  const svc = new Fpi92Service({ events, clock, timers, ledger, jurisdiction: (s) => (s === "CA" ? CA_RULE : undefined) });
  const off = fpiReactors_9_2(svc, events);
  const inst = (code: string) => timers.byCode(code).at(-1);
  const types = (loanId: string) => events.byLoan(loanId).map((e) => e.type).filter((t) => !t.startsWith("timer."));
  return { clock, events, ledger, timers, svc, off, inst, types };
}
/** 9.2 rule 8 worked example: policy expired 2026-10-01 (Thu), vendor non-renewal notice 2026-10-02 = reasonable basis, case opened 10/02 (non-escrowed, TX). */
const WORKED: OpenCaseInput = { loan_id: "L-92", kind: "nonrenewed", insurance_type: "hazard", fdpa_required: false, escrowed: false, regx_days_delinquent: 0, cancellation_reason: null, lapse_start: D("2026-10-01"), opened_on: D("2026-10-02"), basis: { kind: "carrier_nonrenewal", evidence_id: "doc-nonrenewal-1" }, state: "TX" };
const FACTS = { borrower_name: "Bea Borrower", borrower_address: "1 Test St, Testville TX 75001", property_address: "1 Test St, Testville TX 75001", account_last4: "1234", servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", insurance_email: "insurance@example.com" };
const mailed = (case_id: string, notice_id: string, mailed_at: ReturnType<typeof D>, produced_at = mailed_at) => ({ case_id, notice_id, mailed_at, produced_at, mail_class: "first_class", proof_of_mailing_id: `POM-${notice_id}` });
/** The cycle through the reminder: MS-3(A) mailed 2026-10-05 (Mon) = t0; MS-3(B) mailed 2026-11-04 (Wed) = t1 (9.3). */
function cycle(h: ReturnType<typeof harness>, over: Partial<OpenCaseInput> = {}) {
  const c = h.svc.openCase({ ...WORKED, ...over });
  h.clock.set("2026-10-05T14:00:00.000Z"); h.svc.recordFirstNoticeMailed(mailed(c.case_id, "n-ms3a", D("2026-10-05")));
  h.clock.set("2026-11-04T14:00:00.000Z"); h.svc.recordReminderMailed({ ...mailed(c.case_id, "n-ms3b", D("2026-11-04")), variant: "b_no_info" });
  return c;
}
const VENDOR = { vendor_id: "LPI-1", whitelist: ["LPI-1"], affiliate: false, fees: [] as { kind: string; cents: bigint }[] };
const COVER = { last_known_cents: 25_000_000n, rcv_cents: 26_200_000n, upb_cents: 20_000_000n };   // last known $250,000 within 15% of RCV $262,000
const QUOTE = { carrier_quote_cents: null, table_rate_pct: "0.876", rate_table_version: "TX-2026-Q4" };
const paragraphs = (r: Rendered) => r.blocks.map((b) => ({ id: b.id, text: b.text }));

test("9.2-T1: Given non-escrowed loan, lapse 2026-10-01, first notice mailed 2026-10-05 When day 44 (2026-11-18) Then charge command refused (`REGX_1024_37C_FPI_FIRST_NOTICE_45` closed).", () => {
  const h = harness(); const c = cycle(h);
  // The clocks the engine armed from the process's own events: fpi.case.opened → 3-BD notice SLA (Fri 10/02 → Wed 10/07) closed by fpi.first_notice.sent,
  // which arms the 45-day charge gate and the 30-day reminder gate on t0; fpi.reminder.sent closes the 30-day gate and arms the 15-day gate on t1.
  const sla = h.inst("INS_FPI_FIRST_NOTICE_SLA_3BD")!; assert.equal(sla.anchorDate, "2026-10-02"); assert.equal(sla.dueDate, "2026-10-07"); assert.equal(sla.status, "satisfied");
  const g45 = h.inst("REGX_1024_37C_FPI_FIRST_NOTICE_45")!; assert.equal(g45.anchorDate, "2026-10-05"); assert.equal(g45.dueDate, "2026-11-19"); assert.equal(g45.loanId, "L-92");
  const g30 = h.inst("REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30")!; assert.equal(g30.dueDate, "2026-11-04"); assert.equal(g30.status, "satisfied");
  assert.equal(h.inst("REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15")!.dueDate, "2026-11-19"); assert.equal(h.inst("REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15")!.dueDate, "2026-11-19");
  assert.equal(c.earliest_charge_date, "2026-11-19"); assert.equal(fpiClocks(D("2026-10-05"), D("2026-11-04")).earliest_charge, "2026-11-19");   // max(t0 + 45, t1 + 15)
  // Day 44: the gate is still closed — nothing is overdue and the charge command is refused, leaving no charge event and the gate armed.
  h.clock.set("2026-11-18T14:00:00.000Z");
  assert.deepEqual(h.timers.evaluate("2026-11-18T14:00:00.000Z"), []);
  assert.throws(() => h.svc.assessCharge(c.case_id, D("2026-11-18")), /REGX_1024_37C_FPI_FIRST_NOTICE_45 open until 2026-11-19/);
  assert.equal(g45.status, "armed"); assert.equal(h.events.ofType("fpi.charge.assessed").length, 0); assert.equal(h.svc.get(c.case_id).status, "evidence_window");
  const d = chargeDecision(fpiClocks(D("2026-10-05"), D("2026-11-04")), D("2026-11-18"), null, D("2026-10-01"));
  assert.equal(d.allowed, false); assert.match((d as { reason: string }).reason, /REGX_1024_37C_FPI_FIRST_NOTICE_45 open until 2026-11-19/);
  // No placement (and so no charge) before both notices exist — B-6-01 "only after unsuccessful attempts" (FNMA_B601_LPI_AFTER_ATTEMPTS is evaluator-backed).
  const h2 = harness(); const c2 = h2.svc.openCase(WORKED); h2.clock.set("2026-10-05T14:00:00.000Z"); h2.svc.recordFirstNoticeMailed(mailed(c2.case_id, "n-a", D("2026-10-05")));
  assert.throws(() => h2.svc.requestPlacement(c2.case_id, D("2026-11-19"), COVER, VENDOR, QUOTE), /FNMA_B601_LPI_AFTER_ATTEMPTS/);
  assert.deepEqual(chargeDecision(fpiClocks(D("2026-10-05"), null), D("2026-11-19"), null, D("2026-10-01")), { allowed: false, reason: "REMINDER_NOT_MAILED" });
  assert.equal(h2.inst("FNMA_B601_LPI_AFTER_ATTEMPTS")!.note, "evaluator:9.2.firstNoticeAndReminderSent");
  assert.equal(evaluateGate("9.2.firstNoticeAndReminderSent", { first_notice_sent: true, reminder_sent: false }).open, false);
  assert.equal(evaluateGate("9.2.firstNoticeAndReminderSent", { first_notice_sent: true, reminder_sent: true }).open, true);
});
test("9.2-T2: Given reminder mailed 2026-11-04 When 2026-11-19 Then both gates open; charge allowed; effective date retro 2026-10-01; premium $2,190.00 → 600 c/day.", () => {
  const h = harness(); const c = cycle(h);
  const clocks = fpiClocks(D("2026-10-05"), D("2026-11-04"));
  assert.equal(clocks.reminder_not_before, "2026-11-04"); assert.equal(clocks.earliest_charge, "2026-11-19"); assert.equal(clocks.evidence_window_end, "2026-11-19");
  h.clock.set("2026-11-19T14:00:00.000Z");
  assert.ok(h.svc.chargeAllowed(c.case_id, D("2026-11-19")).allowed);
  // Window end, no evidence: the (c)(1)(iii) evaluation is recorded (closing REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15) and the case is chargeable.
  const ev = h.svc.evaluateEvidenceWindow(c.case_id, D("2026-11-19"), null);
  assert.equal(ev.outcome, "no_evidence"); assert.equal(ev.chargeable, true); assert.equal(h.svc.get(c.case_id).status, "chargeable");
  assert.equal(h.inst("REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15")!.status, "satisfied");
  // Placement at cycle end, effective retroactive to the lapse: $250,000 (last known within 15% of RCV $262,000), $2,000 deductible, $2,190.00 from the 0.876% rate table.
  const req = h.svc.requestPlacement(c.case_id, D("2026-11-19"), COVER, VENDOR, QUOTE);
  assert.equal(req.coverage_cents, 25_000_000n); assert.equal(req.deductible_cents, 200_000n); assert.equal(req.effective, "2026-10-01"); assert.equal(req.expiration, "2027-10-01");
  assert.equal(req.quote.annual_premium_cents, 219_000n); assert.equal(req.quote.is_estimate, true); assert.equal(req.idempotency_key, `${c.case_id}+0`);
  const b = h.svc.recordLpiBound({ request_id: req.request_id, policy_number: "LPI-TX-0001", premium_cents: 219_000n, effective: D("2026-10-01") });
  assert.equal(b.placement.effective_date, "2026-10-01"); assert.equal(b.placement.expiration_date, "2027-10-01"); assert.equal(b.placement.premium_cents, 219_000n);
  assert.deepEqual(b.ledger!.lines.map((l) => [l.account.account, l.amountCents, l.ruleRef]), [["corporate_advance", 219_000n, "9.2 rule 7"], ["corporate_cash", -219_000n, "9.2 rule 7"]]);   // rule 7 at binding
  assert.equal(h.svc.get(c.case_id).status, "lpi_bound");
  // Both not-before gates are open on 2026-11-19 (armed, due that day, nothing breached) and the charge closes them.
  const g45 = h.inst("REGX_1024_37C_FPI_FIRST_NOTICE_45")!, g15 = h.inst("REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15")!;
  assert.equal(g45.status, "armed"); assert.equal(g15.status, "armed"); assert.deepEqual(h.timers.evaluate("2026-11-19T14:00:00.000Z"), []);
  const r = h.svc.assessCharge(c.case_id, D("2026-11-19"));
  assert.equal(r.charge.amount_cents, 219_000n); assert.equal(r.charge.period_start, "2026-10-01"); assert.equal(r.charge.period_end, "2027-09-30");
  assert.equal(r.daily_rate.toFixed(6), "600.000000");                                                  // 219,000 ÷ 365
  assert.equal(dailyRate({ effective: D("2026-10-01"), expiration: D("2027-10-01"), premium_cents: 219_000n }).toFixed(6), "600.000000");
  assert.equal(g45.status, "satisfied"); assert.equal(g15.status, "satisfied"); assert.equal(g45.satisfiedByEventId, r.event.id); assert.equal(g15.satisfiedByEventId, r.event.id);
  assert.ok(eventMatches(REG.get("REGX_1024_37C_FPI_FIRST_NOTICE_45")!.satisfiedPattern!, r.event)); assert.ok(eventMatches(REG.get("REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15")!.satisfiedPattern!, r.event));
  assert.equal(r.event.payload.rail, "corporate_advance_receivable"); assert.equal(r.event.payload.statement_line, "Lender-placed insurance premium");
  assert.equal(h.svc.get(c.case_id).status, "charged");
  assert.equal(premiumFromRate(25_000_000n, "0.876"), 219_000n);
});
test("9.2-T3: Given escrowed loan, borrower 45 days overdue, carrier cancelled for non-payment When lapse detected Then `k5_blocked`, premium advanced by 3.7, no FPI notice.", () => {
  assert.equal(escrowGuard(true, 45, "nonpayment"), "k5_blocked");
  const h = harness();
  const c = h.svc.openCase({ ...WORKED, loan_id: "L-K5", kind: "cancelled", escrowed: true, regx_days_delinquent: 45, cancellation_reason: "nonpayment", basis: { kind: "carrier_cancellation", evidence_id: "doc-cancel-1" } });
  assert.equal(c.guard, "k5_blocked"); assert.equal(c.k5_gate, "blocked_advance"); assert.equal(c.status, "closed_k5_advance"); assert.equal(c.closed_reason, "k5_advance");
  assert.deepEqual(h.types("L-K5"), ["fpi.case.opened", "fpi.case.k5_blocked", "escrow.advance.requested", "fpi.case.closed"]);
  const opened = h.events.ofType("fpi.case.opened")[0]!; assert.equal(opened.payload.escrowed, true); assert.equal(opened.payload.k5_blocked, true); assert.equal(opened.payload.first_notice, null);
  assert.deepEqual(h.events.ofType("escrow.advance.requested")[0]!.payload.line, "hazard");                // the premium is advanced by 3.7
  // The (k)(5) gate armed on `fpi.case.opened{escrowed=true}` and is evaluator-backed; the notice SLA never armed (trigger requires k5_blocked=false).
  const k5 = h.inst("REGX_1024_17K5_LPI_PURCHASE_GATE")!; assert.equal(k5.note, `evaluator:${K5}`); assert.equal(k5.status, "cancelled");
  assert.equal(h.timers.byCode("INS_FPI_FIRST_NOTICE_SLA_3BD").length, 0);
  assert.throws(() => h.svc.composeFirstNotice(c.case_id, { ...FACTS, notice_date: D("2026-10-05") }), /closed_k5_advance/);
  assert.throws(() => h.svc.recordFirstNoticeMailed(mailed(c.case_id, "n-x", D("2026-10-05"))), /closed_k5_advance/);
  assert.equal(h.events.ofType("fpi.first_notice.sent").length, 0);
  const gate = evaluateGate(K5, { escrowed: true, regx_days_delinquent: 45, cancellation_reason: "nonpayment" });
  assert.equal(gate.open, false); assert.match(gate.reason!, /§1024\.17\(k\)\(5\)/);
  assert.equal(evaluateGate(K5, { escrowed: true, regx_days_delinquent: 45 }).open, false);            // unknown reason → treated as non-payment
  // ≤ 30 days overdue: never FPI — the servicer pays/advances the renewal under (k)(1)–(2).
  assert.equal(escrowGuard(true, 20, "underwriting"), "servicer_pays");
  const cur = h.svc.openCase({ ...WORKED, loan_id: "L-CUR", escrowed: true, regx_days_delinquent: 20, cancellation_reason: "underwriting" });
  assert.equal(cur.status, "closed_servicer_pays"); assert.equal(h.events.ofType("escrow.advance.requested").at(-1)!.payload.reason, "regx_1024_17_k1_k2_renewal");
  assert.equal(evaluateGate(K5, { escrowed: true, regx_days_delinquent: 20, cancellation_reason: "underwriting" }).open, false);
  // The same outcome when 9.1's lapse event arrives through the reactor.
  h.events.append({ type: "insurance.lapse_detected", loanId: "L-K5b", actor: SYSTEM, payload: { kind: "cancelled", insurance_type: "hazard", escrowed: true, regx_days_delinquent: 45, cancellation_reason: "nonpayment", basis_evidence: "doc-cancel-2", lapse_start: "2026-10-01" } });
  assert.equal(h.svc.all().find((x) => x.loan_id === "L-K5b")!.status, "closed_k5_advance");
});
test(`9.2-T4: Given escrowed loan, borrower 45 days overdue, insurer cancellation citing "underwriting" When lapse detected Then inability documented, gate open, cycle proceeds.`, () => {
  assert.equal(escrowGuard(true, 45, "underwriting"), "k5_inability_documented");
  const h = harness();
  const c = h.svc.openCase({ ...WORKED, loan_id: "L-K5U", kind: "cancelled", escrowed: true, regx_days_delinquent: 45, cancellation_reason: "underwriting", basis: { kind: "carrier_cancellation", evidence_id: "doc-cancel-uw" } });
  assert.equal(c.guard, "k5_inability_documented"); assert.equal(c.k5_gate, "open_inability"); assert.equal(c.status, "first_notice_pending");
  const opened = h.events.ofType("fpi.case.opened")[0]!; assert.equal(opened.payload.k5_gate, "open_inability"); assert.equal(opened.payload.k5_blocked, false); assert.equal(opened.payload.first_notice, "INS_FPI_FIRST_MS3A");
  const k5 = h.inst("REGX_1024_17K5_LPI_PURCHASE_GATE")!; assert.equal(k5.status, "armed"); assert.equal(k5.note, `evaluator:${K5}`);
  assert.equal(evaluateGate(K5, { escrowed: true, regx_days_delinquent: 45, cancellation_reason: "underwriting" }).open, true);
  // the cycle proceeds: the notice SLA armed on open (3 servicer BD) and the mailed MS-3(A) closes it and starts the 45-day clock
  const sla = h.inst("INS_FPI_FIRST_NOTICE_SLA_3BD")!; assert.equal(sla.dueDate, "2026-10-07"); assert.equal(sla.status, "armed");
  assert.equal(h.svc.composeFirstNotice(c.case_id, { ...FACTS, notice_date: D("2026-10-05") }).template, "INS_FPI_FIRST_MS3A");
  h.clock.set("2026-10-05T14:00:00.000Z"); const clocks = h.svc.recordFirstNoticeMailed(mailed(c.case_id, "n-uw", D("2026-10-05")));
  assert.equal(sla.status, "satisfied"); assert.equal(clocks.reminder_not_before, "2026-11-04"); assert.equal(h.inst("REGX_1024_37C_FPI_FIRST_NOTICE_45")!.dueDate, "2026-11-19");
  h.clock.set("2026-11-04T14:00:00.000Z"); h.svc.recordReminderMailed({ ...mailed(c.case_id, "n-uw-b", D("2026-11-04")), variant: "b_no_info" });
  h.clock.set("2026-11-19T14:00:00.000Z");
  const req = h.svc.requestPlacement(c.case_id, D("2026-11-19"), COVER, VENDOR, QUOTE);                    // the (k)(5) gate is open: placement permitted
  const b = h.svc.recordLpiBound({ request_id: req.request_id, policy_number: "LPI-TX-0002", premium_cents: 219_000n, effective: D("2026-10-01") });
  assert.deepEqual(b.ledger!.lines.map((l) => [l.account.account, l.amountCents]), [["escrow", 219_000n], ["custodial_ti_cash", -219_000n]]);   // rule 7 escrowed rail (3.7 lpi_premium)
  assert.equal(h.events.ofType("escrow.disbursement.requested")[0]!.payload.disbursement_kind, "lpi_premium");
  assert.equal(h.svc.assessCharge(c.case_id, D("2026-11-19")).event.payload.rail, "escrow_disbursement_3_7"); assert.equal(h.events.ofType("escrow.analysis.requested")[0]!.payload.kind, "interim");
  // vacancy is inability too (comment 17(k)(5)(ii)(A)-1); a non-escrowed loan never sees the gate
  assert.equal(escrowGuard(true, 45, "nonpayment", true), "k5_inability_documented");
  assert.equal(evaluateGate(K5, { escrowed: true, regx_days_delinquent: 45, cancellation_reason: "nonpayment", vacant: true }).open, true);
  assert.equal(evaluateGate(K5, { escrowed: false }).open, true);
  const hv = harness(); hv.svc.openCase({ ...WORKED, loan_id: "L-VAC", escrowed: true, regx_days_delinquent: 45, cancellation_reason: "nonpayment", vacant: true });
  assert.equal(hv.svc.openFor("L-VAC")!.k5_gate, "open_inability");
});
test("9.2-T5: Given a notice rendered with an extra marketing paragraph When checklist runs Then render fails ((c)(4)).", () => {
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion(MS3A, D("2026-10-05"))!; assert.equal(v.version, "1.1.0");
  const h = harness(); const c = h.svc.openCase(WORKED);
  const n = h.svc.composeFirstNotice(c.case_id, { ...FACTS, notice_date: D("2026-10-05"), additional_information: true, estimated_annual_premium_cents: 219_000n });
  assert.equal(n.payload.purchase_phrase, "will purchase"); assert.equal(n.payload.status_phrase, "expired"); assert.equal(n.payload.coverage_event_date, "2026-10-01");
  const payload = { ...v.samplePayload, ...n.payload };
  const clean = render(v.source, payload);
  assert.equal(evaluateChecklist(v, payload, clean).passed, true);
  assert.deepEqual(noticeChecklist(paragraphs(clean), "first"), { ok: true, violations: [], extra: [] });   // (c)(4): only the (c)(2) items and the account number on the pages
  assert.deepEqual(boldItemsPresent(clean.blocks, [/immediately provide us with your hazard insurance information/i, /hazard insurance is required on your property, we will purchase insurance on your property at your expense/i, /may cost significantly more .* may not provide as much coverage/i]), { ok: true, missing: [] });   // (c)(3)
  assert.equal(clean.blocks.find((b) => b.id === "property")!.bold, false);                                // "except the address itself"
  assert.doesNotMatch(clean.text, /\$[\d,]+\.\d{2}/);                                                       // no cost figure on the first notice — the estimate rides on the (xi) insert
  assert.match(clean.text, /To: Bea Borrower, 1 Test St/); assert.match(clean.text, /we do not have evidence that you have had hazard insurance/);
  assert.equal(n.payload.mail_class, "first_class"); assert.ok(evaluateChecklist(v, { ...payload, mail_class: "email" }, clean).blocking.some((b) => b.rule_id === "first-class"));   // (f): always mailed
  // An extra marketing paragraph: the platform checklist fails on (c)(4) and the sentence classifier names the paragraph and sentence.
  const promo = render(v.source + `\n{{#block "promo" page=1 y=0.8 pt=10}}Ask us about our home warranty partner offers today!{{/block}}`, payload);
  const cl = evaluateChecklist(v, payload, promo);
  assert.equal(cl.passed, false); assert.ok(cl.blocking.some((b) => b.rule_id === "nothing-else" && b.citation === "§1024.37(c)(4)"));
  const sc = noticeChecklist(paragraphs(promo), "first");
  assert.equal(sc.ok, false); assert.deepEqual(sc.violations, ["extra_content_(c)(4)"]); assert.deepEqual(sc.extra, [{ paragraph: "promo", sentence: "Ask us about our home warranty partner offers today!" }]);
  // A cost figure on the first-notice pages is (c)(4) extra content too (it belongs on the reminder, (d)(2)(i)(D)).
  const priced = render(v.source + `\n{{#block "cost" page=1 y=0.8 pt=10}}Insurance we purchase will cost an estimated $2,190.00 per year.{{/block}}`, payload);
  assert.ok(evaluateChecklist(v, payload, priced).blocking.some((b) => b.rule_id === "no-cost-on-pages"));
  assert.deepEqual(noticeChecklist(paragraphs(priced), "first").extra.map((e) => e.sentence), ["Insurance we purchase will cost an estimated $2,190.00 per year."]);
  // Sentences that merely contain a trigger word are not the required items.
  for (const s of ["Call us immediately to hear about our home warranty partner offers.", "Contact us at (800) 555-0100 to enroll in autopay today.", "Visit our website within 10 days for a free credit review.", "Ask about our estimate of your savings."]) assert.equal(noticeSentenceKind(s, "first"), "other", s);
  assert.equal(noticeSentenceKind("Loan number ending 1234.", "first"), "account_number");                 // the one permitted extra
  assert.equal(noticeSentenceKind("You must immediately provide us with your hazard insurance information for the property at:", "first"), "required");
  assert.equal(noticeSentenceKind("The insurance we buy will cost $2,190.00 annually (an estimate).", "reminder"), "required");   // (d)(2)(i)(D) belongs on the reminder …
  assert.equal(noticeSentenceKind("The insurance we buy will cost $2,190.00 annually (an estimate).", "first"), "other");         // … never on the first notice
  assert.equal(noticeChecklist([{ kind: "required" }, { kind: "account_number" }]).ok, true);
  assert.deepEqual(noticeChecklist([{ kind: "required" }, { kind: "account_number" }, { kind: "other" }]).violations, ["extra_content_(c)(4)"]);
});
test(`9.2-T6: Given a windstorm-only gap When notice composed Then [Insurance Type]="windstorm" and (v)(C) statement present.`, () => {
  const h = harness();
  const c = h.svc.openCase({ ...WORKED, loan_id: "L-WIND", kind: "perils_gap", insurance_type: "wind", basis: { kind: "insufficient_coverage", evidence_id: "doc-adequacy-1", deficiency: "wind_gap" } });
  assert.equal(c.track, "regx_hazard"); assert.equal(h.events.ofType("fpi.case.opened")[0]!.payload.insurance_type, "wind");
  const n = h.svc.composeFirstNotice(c.case_id, { ...FACTS, notice_date: D("2026-10-05") });
  assert.equal(n.insurance_type, "windstorm"); assert.equal(n.payload.insurance_type, "windstorm"); assert.equal(n.payload.status_phrase, "provides insufficient coverage");
  assert.match(n.vC_statement!, /^The type of insurance for which we do not have evidence is windstorm coverage/);   // comment 37(c)(2)(v)-1
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion(MS3A, D("2026-10-05"))!;
  const payload = { ...v.samplePayload, ...n.payload }; const r = render(v.source, payload);
  assert.match(r.text, /your windstorm insurance provides insufficient coverage on October 1, 2026, and we do not have evidence that you have had windstorm insurance/);
  assert.match(r.text, /The type of insurance for which we do not have evidence is windstorm coverage, which your loan requires in addition to your homeowners policy\./);
  assert.match(r.text, /immediately provide us with your windstorm insurance information/); assert.match(r.text, /Because windstorm insurance is required on your property, we will purchase/);
  assert.equal(evaluateChecklist(v, payload, r).passed, true);
  assert.deepEqual(noticeChecklist(paragraphs(r), "first"), { ok: true, violations: [], extra: [] });
  // the (v)(C) rule: a non-hazard type without the statement fails the checklist; hazard carries no statement
  assert.ok(evaluateChecklist(v, { ...payload, type_statement: null }, render(v.source, { ...payload, type_statement: null })).blocking.some((b) => b.rule_id === "c2-v-c-type"));
  const hz = h.svc.composeFirstNotice(h.svc.openCase({ ...WORKED, loan_id: "L-HZ" }).case_id, { ...FACTS, notice_date: D("2026-10-05") });
  assert.equal(hz.insurance_type, "hazard"); assert.equal(hz.vC_statement, null); assert.doesNotMatch(render(v.source, { ...v.samplePayload, ...hz.payload }).text, /type of insurance for which/);
  const fv = firstNoticeVariant("insufficient", "wind"); assert.equal(fv.insurance_type, "windstorm"); assert.match(fv.vC_statement!, /windstorm/); assert.equal(fv.purchase_phrase, "will purchase");
  assert.equal(firstNoticeVariant("expired", "hazard").vC_statement, null);
  // a deficiency LPI cannot cure is not a basis for the cycle (rule 1)
  assert.throws(() => h.svc.openCase({ ...WORKED, loan_id: "L-DED", kind: "insufficient_coverage", basis: { kind: "insufficient_coverage", evidence_id: "doc-x", deficiency: "deductible_excess" } }), /not a reasonable basis/);
});
test("9.2-T7: Given a notice produced 2026-10-01 and mailed 2026-10-09 (6 federal business days later; 2026-10-12 is Columbus Day but after) When mailing Then regeneration required per (d)(5) rule; produced 2026-10-05 → allowed.", async () => {
  assert.equal(productionWindowOk(D("2026-10-01"), D("2026-10-09")), false);                          // 6 federal business days → regenerate
  assert.equal(productionWindowOk(D("2026-10-05"), D("2026-10-09")), true);                           // 4 federal business days
  const h = harness("2026-10-01T14:00:00.000Z"); const c = h.svc.openCase({ ...WORKED, opened_on: D("2026-10-01") });
  assert.throws(() => h.svc.recordFirstNoticeMailed(mailed(c.case_id, "n-stale", D("2026-10-09"), D("2026-10-01"))), /REGX_1024_37D5_NOTICE_PRODUCTION_5BD: first notice produced 2026-10-01 and mailed 2026-10-09 .* regenerate with current evidence/);
  assert.equal(h.svc.get(c.case_id).status, "first_notice_pending"); assert.equal(h.events.ofType("fpi.first_notice.sent").length, 0);
  assert.throws(() => h.svc.recordFirstNoticeMailed({ ...mailed(c.case_id, "n-std", D("2026-10-05")), mail_class: "standard" }), /§1024\.37\(f\)/);   // first-class only
  // Through the Notice Registry: production on 10/01 arms the 5-federal-BD row (mail by Thu 10/08); the 10/09 proof of mailing lands late and the stale piece is refused.
  const reg = buildRegistry(); publishAuthored(reg);
  const notices = new NoticeService({ registry: reg, events: h.events, clock: h.clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const recipients = [{ partyId: "B1", name: "Bea Borrower", mailingAddress: FACTS.borrower_address }];
  const stale = notices.render({ templateCode: MS3A, loanId: WORKED.loan_id, recipients, payload: { ...reg.activeVersion(MS3A, D("2026-10-01"))!.samplePayload, ...h.svc.composeFirstNotice(c.case_id, { ...FACTS, notice_date: D("2026-10-01") }).payload }, asOf: D("2026-10-01") });
  await notices.send(stale.id);
  assert.equal(stale.channelDecision![0]!.channel, "mail_first_class");                              // mail_only template
  const prod = h.inst("REGX_1024_37D5_NOTICE_PRODUCTION_5BD")!; assert.equal(prod.anchorDate, "2026-10-01"); assert.equal(prod.dueDate, "2026-10-08");
  h.clock.set("2026-10-09T14:00:00.000Z");
  assert.ok(h.timers.evaluate("2026-10-09T14:00:00.000Z").some((b) => b.instance.id === prod.id));   // overdue on 10/09
  notices.recordMailed(stale.id, 1, "2026-10-09T14:00:00.000Z", "POM-stale");
  assert.equal(prod.status, "satisfied_late");
  const rejected = h.events.ofType("fpi.inbound.rejected"); assert.equal(rejected.length, 1); assert.match(String(rejected[0]!.payload.reason), /REGX_1024_37D5_NOTICE_PRODUCTION_5BD/);
  assert.equal(h.events.ofType("fpi.first_notice.sent").length, 0); assert.equal(h.svc.get(c.case_id).status, "first_notice_pending");
  // Regenerated on 10/05 with current evidence: mail by Tue 10/13 (Columbus Day 10/12 skipped); mailed 10/09 → the row is satisfied and t0 = 10/09.
  h.clock.set("2026-10-05T14:00:00.000Z");
  const fresh = notices.render({ templateCode: MS3A, loanId: WORKED.loan_id, recipients, payload: { ...reg.activeVersion(MS3A, D("2026-10-05"))!.samplePayload, ...h.svc.composeFirstNotice(c.case_id, { ...FACTS, notice_date: D("2026-10-05") }).payload }, asOf: D("2026-10-05") });
  await notices.send(fresh.id);
  const prod2 = h.inst("REGX_1024_37D5_NOTICE_PRODUCTION_5BD")!; assert.notEqual(prod2.id, prod.id); assert.equal(prod2.anchorDate, "2026-10-05"); assert.equal(prod2.dueDate, "2026-10-13");
  h.clock.set("2026-10-09T15:00:00.000Z");
  notices.recordMailed(fresh.id, 1, "2026-10-09T15:00:00.000Z", "POM-fresh");
  assert.equal(prod2.status, "satisfied");
  const sent = h.events.ofType("fpi.first_notice.sent"); assert.equal(sent.length, 1); assert.equal(sent[0]!.payload.first_notice_mailed_at, "2026-10-09"); assert.equal(sent[0]!.payload.produced_at, "2026-10-05"); assert.equal(sent[0]!.payload.proof_of_mailing_id, "POM-fresh");
  assert.equal(h.svc.get(c.case_id).first_notice_mailed_at, "2026-10-09"); assert.equal(h.inst("REGX_1024_37C_FPI_FIRST_NOTICE_45")!.dueDate, "2026-11-23");
});
test("9.2-T8: Given evidence received 2026-11-19 (day 15) When evaluated Then no charge; case closed `closed_evidence`.", () => {
  const h = harness(); const c = cycle(h);
  h.clock.set("2026-11-19T14:00:00.000Z");
  const ev = h.svc.evaluateEvidenceWindow(c.case_id, D("2026-11-19"), { received_on: D("2026-11-19"), continuous_coverage: true, evidence_id: "dec-page-1" });
  assert.equal(ev.outcome, "continuous_coverage"); assert.equal(ev.chargeable, false); assert.equal(ev.window_end, "2026-11-19");   // day 15 counts
  const cc = h.svc.get(c.case_id); assert.equal(cc.status, "closed_evidence"); assert.equal(cc.closed_reason, "closed_evidence");
  assert.equal(h.events.ofType("fpi.case.closed")[0]!.payload.charged, false);
  assert.throws(() => h.svc.assessCharge(c.case_id, D("2026-11-19")), /closed_evidence/);
  assert.throws(() => h.svc.requestPlacement(c.case_id, D("2026-11-19"), COVER, VENDOR, QUOTE), /closed_evidence/);
  assert.equal(h.events.ofType("fpi.charge.assessed").length, 0); assert.equal(h.events.ofType("fpi.lpi_bound").length, 0); assert.equal(h.svc.charges.length, 0);
  assert.equal(h.inst("REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15")!.status, "satisfied");
  for (const code of ["REGX_1024_37C_FPI_FIRST_NOTICE_45", "REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15", "FNMA_B601_LPI_AFTER_ATTEMPTS"]) assert.equal(h.inst(code)!.status, "cancelled", code);   // gates of a closed case
  assert.deepEqual(chargeDecision(fpiClocks(D("2026-10-05"), D("2026-11-04")), D("2026-11-19"), D("2026-11-19"), D("2026-10-01")), { allowed: false, reason: "closed_evidence" });
  assert.deepEqual(chargeDecision(fpiClocks(D("2026-10-05"), D("2026-11-04")), D("2026-11-25"), D("2026-11-19"), D("2026-10-01")), { allowed: false, reason: "closed_evidence" });
  // Evidence after the window does not stop the cycle: coverage from a later date leaves the gap chargeable; continuous coverage shown late is 9.5's cancel/refund.
  const h2 = harness(); const c2 = cycle(h2); h2.clock.set("2026-11-25T14:00:00.000Z");
  const gap = h2.svc.evaluateEvidenceWindow(c2.case_id, D("2026-11-25"), { received_on: D("2026-11-20"), continuous_coverage: false });
  assert.equal(gap.outcome, "gap_remains"); assert.equal(gap.chargeable, true); assert.equal(h2.svc.get(c2.case_id).status, "chargeable");
  const h3 = harness(); const c3 = cycle(h3); h3.clock.set("2026-11-25T14:00:00.000Z");
  assert.equal(h3.svc.evaluateEvidenceWindow(c3.case_id, D("2026-11-25"), { received_on: D("2026-11-20"), continuous_coverage: true }).outcome, "late_evidence");
  assert.ok(chargeDecision(fpiClocks(D("2026-10-05"), D("2026-11-04")), D("2026-11-25"), D("2026-11-20"), D("2026-10-01")).allowed);
});
test("9.2-T9: Given flood required by FDPA lapses When case opened Then track `fdpa_flood`, no MS-3A.", () => {
  const h = harness();
  const c = h.svc.openCase({ ...WORKED, loan_id: "L-FLOOD", kind: "expired", insurance_type: "flood", fdpa_required: true, basis: { kind: "vendor_expiration_no_renewal", evidence_id: "doc-flood-1" }, opened_on: D("2027-02-04"), lapse_start: D("2027-02-03") });
  assert.equal(c.track, "fdpa_flood"); assert.equal(c.status, "flood_notice_pending");
  const opened = h.events.ofType("fpi.case.opened")[0]!; assert.equal(opened.payload.track, "fdpa_flood"); assert.equal(opened.payload.first_notice, "INS_FLOOD_FPI_NOTICE_45");
  assert.throws(() => h.svc.composeFirstNotice(c.case_id, { ...FACTS, notice_date: D("2027-02-05") }), /no MS-3\(A\) on the fdpa_flood track/);
  assert.throws(() => h.svc.recordFirstNoticeMailed(mailed(c.case_id, "n-x", D("2027-02-05"))), /flood_notice_pending/);
  assert.equal(h.timers.byCode("INS_FPI_FIRST_NOTICE_SLA_3BD").length, 0);                            // the MS-3(A) SLA never arms on the flood track (9.6 runs its own)
  assert.equal(h.events.ofType("fpi.first_notice.sent").length, 0);
  // the same through 9.1's lapse event
  h.events.append({ type: "insurance.lapse_detected", loanId: "L-FLOOD-2", actor: SYSTEM, payload: { kind: "expired", insurance_type: "flood", fdpa_required: true, basis_evidence: "doc-flood-2", lapse_start: "2027-02-03", detected_on: "2027-02-04" } });
  assert.equal(h.svc.openFor("L-FLOOD-2")!.track, "fdpa_flood"); assert.equal(h.svc.openFor("L-FLOOD-2")!.status, "flood_notice_pending");
  const o = fpiCaseOpen({ insurance_type: "flood", fdpa_required: true, opened_on: D("2027-02-04") });
  assert.equal(o.track, "fdpa_flood"); assert.equal(o.first_notice, "INS_FLOOD_FPI_NOTICE_45"); assert.equal(o.ms3a, false);
  assert.equal(fpiCaseOpen({ insurance_type: "hazard", fdpa_required: false, opened_on: D("2026-10-02") }).ms3a, true);
});
test(`9.2-T10: Given LPI vendor offers a "servicer expense reimbursement" fee When placement configured Then rejected (B-6-01 commission exclusion).`, () => {
  const h = harness(); const c = cycle(h); h.clock.set("2026-11-19T14:00:00.000Z");
  const fee = { ...VENDOR, fees: [{ kind: "servicer_expense_reimbursement", cents: 15_000n }] };
  assert.throws(() => h.svc.requestPlacement(c.case_id, D("2026-11-19"), COVER, fee, QUOTE), /servicer_expense_reimbursement: B-6-01 commission\/expense-reimbursement exclusion; §1024\.37\(h\) bona fide premium only/);
  assert.throws(() => h.svc.requestPlacement(c.case_id, D("2026-11-19"), COVER, { ...VENDOR, affiliate: true }, QUOTE), /affiliate carrier prohibited/);
  assert.throws(() => h.svc.requestPlacement(c.case_id, D("2026-11-19"), COVER, { ...VENDOR, vendor_id: "LPI-9" }, QUOTE), /not on the program whitelist/);
  assert.equal(h.events.ofType("fpi.placement.requested").length, 0);
  const r = placementConfig({ vendor_id: "LPI-1", whitelist: ["LPI-1"], affiliate: false, fees: [{ kind: "servicer_expense_reimbursement", cents: 15000n }] });
  assert.equal(r.accepted, false); assert.match(r.rejected[0]!, /B-6-01/);
  assert.equal(placementConfig({ vendor_id: "LPI-1", whitelist: ["LPI-1"], affiliate: false, fees: [] }).accepted, true);
  // A clean configuration is requested; a vendor `lpi_bound` that adds a fee on top of the premium is refused at ingestion (no fees added to the premium).
  const req = h.svc.requestPlacement(c.case_id, D("2026-11-19"), COVER, VENDOR, QUOTE);
  assert.equal(h.events.ofType("fpi.placement.requested")[0]!.payload.premium_cents, 219_000n);
  assert.throws(() => h.svc.recordLpiBound({ request_id: req.request_id, policy_number: "P-1", premium_cents: 219_000n, effective: D("2026-10-01"), fees_cents: 15_000n }), /B-6-01 commission\/incentive exclusion/);
  assert.throws(() => h.svc.recordLpiBound({ request_id: req.request_id, policy_number: "P-1", premium_cents: 219_000n, effective: D("2026-11-19") }), /retroactive to the lapse/);
  assert.equal(h.events.ofType("fpi.lpi_bound").length, 0);
});
test("9.2-T11: Given a CA property with RCV $310,000 and last-known $360,000 When coverage computed Then $310,000 (cap), deductible $2,500.", () => {
  const h = harness(); const c = cycle(h, { loan_id: "L-CA", state: "CA" });
  const cov = h.svc.coverage(c.case_id, { last_known_cents: 36_000_000n, rcv_cents: 31_000_000n, upb_cents: 20_000_000n });
  assert.equal(cov.coverage_cents, 31_000_000n); assert.equal(cov.deductible_cents, 250_000n); assert.equal(cov.state_cap_cents, 31_000_000n);   // CA cap = RCV; last known is outside ±15% of RCV
  h.clock.set("2026-11-19T14:00:00.000Z");
  const req = h.svc.requestPlacement(c.case_id, D("2026-11-19"), { last_known_cents: 36_000_000n, rcv_cents: 31_000_000n, upb_cents: 20_000_000n }, VENDOR, QUOTE);
  assert.equal(req.coverage_cents, 31_000_000n); assert.equal(req.deductible_cents, 250_000n); assert.equal(req.quote.annual_premium_cents, 271_560n);   // $310,000 × 0.876%
  assert.equal(h.events.ofType("fpi.placement.requested")[0]!.payload.state_cap_cents, 31_000_000n);
  const r = lpiCoverage({ last_known_cents: 36000000n, rcv_cents: 31000000n, upb_cents: 20000000n, state_cap_cents: 31000000n });
  assert.equal(r.coverage_cents, 31000000n); assert.equal(r.deductible_cents, 250000n);
  assert.equal(lpiCoverage({ last_known_cents: 32000000n, rcv_cents: 32500000n, upb_cents: 20000000n, state_cap_cents: 31000000n }).basis, "state_cap");
  const tx = harness().svc; const w = tx.coverage(tx.openCase(WORKED).case_id, COVER);                   // worked example: last known within 15% of RCV, no cap
  assert.equal(w.coverage_cents, 25000000n); assert.equal(w.deductible_cents, 200000n); assert.equal(w.state_cap_cents, null);
});

test("9.2 worked example: $250,000.00 coverage → $2,000 deductible tier ($250,000.01 → $2,500) and a $2,190.00 annual premium at the 0.876% TX rate", () => {
  assert.equal(tierDeductible(25000000n), 200000n); assert.equal(tierDeductible(25000001n), 250000n); assert.equal(premiumFromRate(25000000n, "0.876"), 219000n);
  // B-6-01 tiers: coverage < $100,000 → $1,000; $100,000–$250,000 → $2,000; > $250,000 → $2,500
  assert.equal(tierDeductible(9999999n), 100000n); assert.equal(tierDeductible(10000000n), 200000n); assert.equal(tierDeductible(60000000n), 250000n);
});
test("9.2 reactors: 9.1's lapse event opens the case, the Notice Registry's proof of mailing of the MS-3(B) records t1, and a payoff closes the case and cancels its clocks", async () => {
  const h = harness();
  h.events.append({ type: "insurance.lapse_detected", loanId: "L-92", actor: SYSTEM, payload: { kind: "nonrenewed", insurance_type: "hazard", escrowed: false, regx_days_delinquent: 0, basis_evidence: "doc-nonrenewal-1", lapse_start: "2026-10-01", detected_on: "2026-10-02", state: "TX" } });
  const c = h.svc.openFor("L-92")!; assert.equal(c.status, "first_notice_pending"); assert.equal(c.basis!.kind, "carrier_nonrenewal"); assert.equal(c.opened_at, "2026-10-02");
  assert.equal(h.events.ofType("fpi.case.opened")[0]!.causationId, h.events.ofType("insurance.lapse_detected")[0]!.id);
  h.clock.set("2026-10-05T14:00:00.000Z"); h.svc.recordFirstNoticeMailed(mailed(c.case_id, "n-a", D("2026-10-05")));
  const reg = buildRegistry(); publishAuthored(reg);
  const notices = new NoticeService({ registry: reg, events: h.events, clock: h.clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  // the reminder mailed on 11/03 is refused by the 30-day gate (t0 + 30 = 11/04) and recorded as a rejected inbound; 11/04 is on time
  const v = reg.activeVersion("INS_FPI_REMINDER_NOINFO_MS3B", D("2026-11-03"))!;
  h.clock.set("2026-11-03T14:00:00.000Z");
  const early = notices.render({ templateCode: "INS_FPI_REMINDER_NOINFO_MS3B", loanId: "L-92", recipients: [{ partyId: "B1", name: "Bea Borrower", mailingAddress: FACTS.borrower_address }], payload: v.samplePayload, asOf: D("2026-11-03") });
  await notices.send(early.id); notices.recordMailed(early.id, 1, "2026-11-03T18:00:00.000Z", "POM-early");
  assert.match(String(h.events.ofType("fpi.inbound.rejected")[0]!.payload.reason), /REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30 open until 2026-11-04/);
  assert.equal(h.events.ofType("fpi.reminder.sent").length, 0); assert.equal(h.inst("REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30")!.status, "armed");
  h.clock.set("2026-11-04T14:00:00.000Z");
  const ok = notices.render({ templateCode: "INS_FPI_REMINDER_NOINFO_MS3B", loanId: "L-92", recipients: [{ partyId: "B1", name: "Bea Borrower", mailingAddress: FACTS.borrower_address }], payload: v.samplePayload, asOf: D("2026-11-04") });
  await notices.send(ok.id); notices.recordMailed(ok.id, 1, "2026-11-04T18:00:00.000Z", "POM-ok");
  const sent = h.events.ofType("fpi.reminder.sent"); assert.equal(sent.length, 1); assert.equal(sent[0]!.payload.reminder_mailed_at, "2026-11-04"); assert.equal(sent[0]!.payload.variant, "b_no_info"); assert.equal(sent[0]!.payload.evidence_window_end, "2026-11-19");
  assert.equal(h.inst("REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30")!.status, "satisfied"); assert.equal(h.inst("REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15")!.anchorDate, "2026-11-04");
  assert.ok(eventMatches(REG.get("REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30")!.satisfiedPattern!, sent[0] as DomainEvent));
  // payoff mid-cycle: the case closes and its gates are cancelled
  h.events.append({ type: "loan.paid_in_full", loanId: "L-92", actor: SYSTEM, payload: { paid_on: "2026-11-10" } });
  assert.equal(h.svc.get(c.case_id).status, "closed_paid_off"); assert.equal(h.inst("REGX_1024_37C_FPI_FIRST_NOTICE_45")!.status, "cancelled");
  assert.throws(() => h.svc.assessCharge(c.case_id, D("2026-11-19")), /closed_paid_off/);
  h.off();
});
