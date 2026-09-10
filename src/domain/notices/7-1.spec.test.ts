// 7.1 Periodic statement
// spec/sections/07-compliance-notices-disclosures/7-1-periodic-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, dayOfWeek } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { NoticeService, NoticeHeld } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { cycle, delinquencyBox, amountDue, lateFeeLine, reinstatementAmount, contractualPayment } from "./statement.ts";
import { newConsent, verify } from "./esign.ts";
import { tppStatement, bankruptcyStatementPlan, ceaseRequest, chargeOffSuspension, CHARGEOFF_TITLE, CHARGEOFF_ITEMS, reminderDecision, checklistHold, availabilityEmailBounce, form1098Cycle, statementRecipients, transferOutStatements, statementSuppressionRequest } from "./ops.ts";
import { StatementCycleService } from "./ops-7-1.ts";

const REG = loadOverriddenRegistry();
const rig = (iso: string) => { const clock = new FixedClock(iso); const events = new MemoryEventStore(clock); const engine = new TimerEngine(REG, events, { processes: ["7.1"] }); return { clock, events, engine }; };
/** The 7.1 pipeline over a rig: NoticeService (print/mail + e-delivery fakes) and the StatementCycleService that appends the cycle events. */
const pipeline = (r: { clock: FixedClock; events: MemoryEventStore; engine?: TimerEngine }, features?: { coupon_books?: boolean }) => { const reg = published(); const pm = new FakePrintMail(); const ed = new FakeEdelivery(); const notices = new NoticeService({ registry: reg, events: r.events, clock: r.clock, printMail: pm, edelivery: ed }); const svc = new StatementCycleService({ events: r.events, clock: r.clock, notices, ...(r.engine ? { timers: r.engine } : {}), ...(features ? { features } : {}) }); return { reg, pm, ed, notices, svc }; };
const types = (events: MemoryEventStore, loanId: string) => events.byLoan(loanId).map((e) => e.type);
const published = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };
const BEA = { partyId: "A", name: "Bea Borrower", mailingAddress: "1 Test St, Testville TX 75001" };

test("7.1-T1: Given due Oct 1, 2026 and 15-day courtesy, when the cycle opens, then `statement_due_by` = Oct 20, 2026 and the statement is mailed ≤ Oct 20 with `mailed_at` from the vendor manifest.", async () => {
  const c = cycle(D("2026-10-01"), 15);
  assert.deepEqual([c.courtesy_period_end, c.statement_due_by], ["2026-10-16", "2026-10-20"]);
  assert.equal(toIso(c.snapshot_at_ms), toIso(zonedEpochMs(D("2026-10-17"), "01:00", "America/New_York")));   // cut-off 01:00 the day after courtesy ends (rule 1)
  const r = rig("2026-10-17T05:00:00.000Z"); const { clock, events, engine } = r; const { reg, pm, svc } = pipeline(r);
  // the scheduler opens the Nov 1 cycle the day after the Oct 1 courtesy period ends → `statement.cycle.opened{courtesy_period_end}` arms both cycle timers
  const row = svc.openCycle("L-1", { prior_due_date: D("2026-10-01"), late_charge_grace_days: 15 });
  assert.deepEqual([row.cycle_due_date, row.courtesy_period_end, row.statement_due_by, row.vendor_file_by], ["2026-11-01", "2026-10-16", "2026-10-20", "2026-10-19"]);
  const prompt = engine.byCode("REGZ_1026_41B_STATEMENT_PROMPT_4")[0]!, gen = engine.byCode("SM_STATEMENT_GENERATE_T1")[0]!;
  assert.equal(prompt.dueDate, "2026-10-20"); assert.equal(prompt.status, "armed");                                     // courtesy end + 4 calendar days, no business-day roll
  assert.equal(gen.dueDate, "2026-10-17"); assert.equal(gen.status, "armed");                                           // internal render buffer: courtesy end + 1
  const v = reg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-10-17"))!;
  const rendered = svc.renderStatement("L-1", { cycle_due_date: row.cycle_due_date, statement_date: D("2026-10-17"), template: "NTC_REGZ_41_STMT_DELQ", variant: "delinquent", payload: v.samplePayload, recipients: [BEA], reminder_panel: true });
  assert.equal(rendered.status, "rendered"); assert.equal(gen.status, "satisfied");                                      // `statement.rendered` on Oct 17 closes SM_STATEMENT_GENERATE_T1
  const sent = await svc.sendStatement(rendered.notice.id);
  assert.equal(sent.awaiting, "vendor_manifest"); assert.equal(prompt.status, "armed");                                  // a mailed statement is "sent" on the manifest's mailed_at, not at vendor submission
  clock.set("2026-10-19T13:00:00.000Z"); pm.runProduction("2026-10-19T13:00:00.000Z");                                  // vendor manifest: mailed Mon Oct 19
  const job = pm.jobs.get(`${rendered.notice.id}:1`)!;
  const stmt = svc.recordStatementMailed(rendered.notice.id, { attempt_no: 1, mailed_at: job.mailedAt!, proof_of_mailing_id: job.proofOfMailingId! });
  const mailed = events.ofType("notice.mailed")[0]!.payload as { mailed_at: string; proof_of_mailing_id: string };
  assert.equal(mailed.mailed_at, "2026-10-19T13:00:00.000Z"); assert.equal(mailed.proof_of_mailing_id, `POM-${rendered.notice.id}:1`);
  assert.equal((stmt.payload as { mailed_at: string }).mailed_at, mailed.mailed_at); assert.ok(mailed.mailed_at.slice(0, 10) <= c.statement_due_by, "mailed on or before statement_due_by");
  assert.equal(prompt.status, "satisfied");                                                                            // `statement.cycle.closed{outcome=sent}` closes REGZ_1026_41B_STATEMENT_PROMPT_4
  assert.deepEqual(types(events, "L-1").filter((t) => t.startsWith("statement.")), ["statement.cycle.opened", "statement.rendered", "statement.sent", "statement.cycle.closed"]);
  assert.throws(() => svc.recordStatementMailed(rendered.notice.id, { attempt_no: 1, mailed_at: job.mailedAt!, proof_of_mailing_id: "x" }), /no statement rendered/);   // a cycle closes once
  assert.throws(() => svc.openCycle("L-1", { prior_due_date: D("2026-10-01"), late_charge_grace_days: -1 }), RangeError);
});
test("7.1-T2: Given the Sept 1 payment unpaid and statement date Oct 17, then `regx_days_delinquent` = 46 and the (d)(8) box with all seven items renders; given statement date Oct 16 (45 days), then no box.", () => {
  const box = delinquencyBox(D("2026-10-17"), D("2026-09-01"));
  assert.deepEqual(box, { include: true, regx_days: 46, began_on: "2026-09-02", first_unpaid_due: "2026-09-01" });
  const reg = published();
  const v = reg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-10-17"))!;
  const r = render(v.source, v.samplePayload);
  const items = [/you are 46 days delinquent; your first unpaid payment was due September 1, 2026/, /may face foreclosure and additional expenses/, /Account history \(last six months\): May: credited as paid May 1, 2026; .* Sep: \$2,946\.79 remaining; Oct: \$2,946\.79 remaining/, /No loss mitigation program is in place/, /No foreclosure filing has been made/, /Amount to bring the loan current: \$6,127\.00/, /Housing counselor information: consumerfinance\.gov\/find-a-housing-counselor · HUD \(800\) 569-4287/];
  for (const item of items) assert.match(r.text, item);                                                                    // (d)(8)(i)–(vii)
  const c = evaluateChecklist(v, v.samplePayload, r); assert.equal(c.passed, true); assert.equal(c.results.find((x) => x.rule_id === "d8-delinquency")!.passed, true);
  assert.deepEqual(delinquencyBox(D("2026-10-16"), D("2026-09-01")), { include: false, regx_days: 45, began_on: "2026-09-02", first_unpaid_due: "2026-09-01" });
  const std = reg.activeVersion("NTC_REGZ_41_STMT_STD", D("2026-10-16"))!;
  const at45 = { ...std.samplePayload, statement_date: "2026-10-16", regx_days_delinquent: 45, delinquency: null };
  const rs = render(std.source, at45); assert.doesNotMatch(rs.text, /days delinquent/); assert.equal(evaluateChecklist(std, at45, rs).passed, true);
  const boxAt45 = { ...at45, delinquency: v.samplePayload.delinquency };
  assert.ok(evaluateChecklist(std, boxAt45, render(std.source, boxAt45)).blocking.some((b) => b.rule_id === "d8-absent-le45"), "a box at 45 days is a block");
});
test(`7.1-T3: Given a $1,500.00 partial in suspense, then (d)(3) shows unapplied $1,500.00 since last statement and YTD held $1,500.00, transaction activity says "held in suspense," and (d)(5) text states $1,446.79 more is needed.`, () => {
  const ad = amountDue({ current_payment_cents: 294679n, past_due_cents: 0n, late_charges_cents: 0n, fees_cents: 0n, suspense_cents: 150000n });
  assert.equal(ad.amount_due_cents, 294679n); assert.equal(ad.shortfall_to_complete_cents, 144679n); assert.equal(ad.suspense_disclosed_cents, 150000n);   // never netted
  const reg = published();
  const v = reg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-10-17"))!;
  const r = render(v.source, v.samplePayload);
  assert.match(r.text, /Payments received since last statement: \$1,500\.00 \(principal \$0\.00, .* unapplied \$1,500\.00\)/);   // (d)(3) since last statement
  assert.match(r.text, /unapplied funds currently held \$1,500\.00/);                                                        // (d)(3) YTD held
  assert.match(r.text, /October 9, 2026 Payment received — held in suspense \$1,500\.00/);                                  // (d)(4) transaction activity
  assert.match(r.text, /We received \$1,500\.00, which is being held\. We need \$1,446\.79 more to apply a full payment\./);   // (d)(5)
  assert.equal(evaluateChecklist(v, v.samplePayload, r).passed, true);
  const without = { ...v.samplePayload, suspense_instructions: null };
  assert.deepEqual(evaluateChecklist(v, without, render(v.source, without)).blocking.map((b) => b.rule_id), ["d5-suspense"]);
});
test("7.1-T4: Given an active Flex Mod trial with TPP payment $2,100.00, then amount due = $2,100.00 and the explanation shows both $2,100.00 and the contractual $2,946.79; application per contract.", () => {
  const s = tppStatement({ tpp_payment_cents: 210000n, contractual_payment_cents: 294679n, past_due_cents: 294679n, late_charges_cents: 11671n, fees_cents: 0n, suspense_cents: 0n, regx_days: 46 });
  assert.equal(s.template, "NTC_REGZ_41_STMT_TPP"); assert.equal(s.amount_due_cents, 210000n);
  assert.deepEqual(s.explanation, { tpp_payment_cents: 210000n, contractual_payment_cents: 294679n }); assert.equal(s.application_basis, "contract"); assert.equal(s.delinquency_box, true);
});
test("7.1-T5: Given a Chapter 13 case opened Oct 5, then the Nov cycle may use the single-statement exemption and the Dec cycle renders `NTC_REGZ_41_STMT_BK12_13` with post-petition amount due and pre-petition arrearage figures and no late-fee language.", () => {
  const p = bankruptcyStatementPlan({ chapter: "13", petition_on: D("2026-10-05"), docket_reference: "PACER 26-12345", cycles: [{ due_date: D("2026-11-01"), statement_date: D("2026-10-17"), statement_due_by: D("2026-10-20") }, { due_date: D("2026-12-01"), statement_date: D("2026-11-17"), statement_due_by: D("2026-11-20") }], post_petition_due_cents: 294679n, prepetition_arrearage_cents: 589358n });
  assert.equal(p.cycles[0]!.treatment, "single_statement_exemption"); assert.equal(p.cycles[0]!.template, null);
  assert.equal(p.cycles[1]!.treatment, "bk_modified"); assert.equal(p.cycles[1]!.template, "NTC_REGZ_41_STMT_BK12_13"); assert.equal(p.cycles[1]!.amount_due_cents, 294679n); assert.equal(p.cycles[1]!.prepetition_arrearage_cents, 589358n);
  assert.equal(p.cycles[1]!.late_fee_language, false); assert.match(p.cycles[1]!.legend!, /informational purposes only/);
  // the (e)(5)(iv) timer: anchored on the next statement_due_by (Oct 20), one statement cycle → the Dec cycle's Nov 20; only the compliant statement closes it
  const { clock, events, engine } = rig("2026-10-05T15:00:00.000Z");
  events.append({ type: p.timer.trigger.type, loanId: "L-1", actor: SYSTEM, payload: p.timer.trigger.payload });
  const t = engine.byCode("REGZ_1026_41E5IV_BK_TRANSITION_1")[0]!;
  assert.equal(t.dueDate, "2026-11-20"); assert.equal(p.timer.compliant_statement_due_by, "2026-11-20"); assert.equal(t.status, "armed");
  clock.set("2026-10-17T12:00:00.000Z"); events.append({ type: p.cycles[0]!.event.type, loanId: "L-1", actor: SYSTEM, payload: p.cycles[0]!.event.payload }); assert.equal(t.status, "armed");   // unmodified statement under the exemption
  clock.set("2026-11-17T12:00:00.000Z"); events.append({ type: p.cycles[1]!.event.type, loanId: "L-1", actor: SYSTEM, payload: p.cycles[1]!.event.payload }); assert.equal(t.status, "satisfied");
  const reg = published(); const bk = reg.activeVersion("NTC_REGZ_41_STMT_BK12_13", D("2026-11-17"))!;
  const r = render(bk.source, bk.samplePayload); assert.match(r.text, /Post-petition amount due \$2,946\.79/); assert.match(r.text, /Pre-petition arrearage: total \$5,893\.58/); assert.doesNotMatch(r.text, /late fee/i); assert.equal(evaluateChecklist(bk, bk.samplePayload, r).passed, true);
  assert.throws(() => bankruptcyStatementPlan({ chapter: "13", petition_on: D("2026-10-05"), docket_reference: null, cycles: [], post_petition_due_cents: 0n, prepetition_arrearage_cents: 0n }), /docket reference/);
});
test("7.1-T6: Given a written cease request received Oct 12 from the debtor's attorney, then `statement.cycle.exempt` is recorded with the image as evidence and no statement is sent for cycles after Oct 12; given a later written request for statements, then statements resume the next cycle.", () => {
  const cycles = [{ due_date: D("2026-10-01"), statement_date: D("2026-09-17") }, { due_date: D("2026-11-01"), statement_date: D("2026-10-17") }, { due_date: D("2026-12-01"), statement_date: D("2026-11-17") }, { due_date: D("2027-01-01"), statement_date: D("2026-12-17") }];
  const c = ceaseRequest({ received_on: D("2026-10-12"), evidence_document_id: "img-cease-1", cycles });
  assert.deepEqual(c.exemption, { event: "statement.cycle.exempt", effective_on: "2026-10-12", evidence_document_id: "img-cease-1" });
  assert.deepEqual(c.cycles.map((x) => x.send), [true, false, false, false]);
  const r = ceaseRequest({ received_on: D("2026-10-12"), evidence_document_id: "img-cease-1", cycles, resume_request_on: D("2026-11-20") });
  assert.deepEqual(r.cycles.map((x) => x.send), [true, false, false, true]);                       // resumes the next cycle after the written request
  assert.throws(() => ceaseRequest({ received_on: D("2026-10-12"), evidence_document_id: null, cycles }), /evidence document/);
  assert.equal(statementSuppressionRequest({ reason: "bk_written_cease_request", evidence_document_id: "img-cease-1" }).exemption_basis, "§1026.41(e)(5)(i)(A)");
  // the Nov 1 cycle (opened Oct 17, prompt due Oct 20) is exempt from the Oct 12 receipt: `statement.cycle.exempt` with the image, no `statement.sent`, and the (e)(5) exemption closes REGZ_1026_41B_STATEMENT_PROMPT_4
  const rg = rig("2026-10-17T05:05:00.000Z"); const { events, engine } = rg; const { svc } = pipeline(rg);
  const row = svc.openCycle("L-1", { prior_due_date: D("2026-10-01"), late_charge_grace_days: 15 });
  const prompt = engine.byCode("REGZ_1026_41B_STATEMENT_PROMPT_4")[0]!; assert.equal(prompt.dueDate, "2026-10-20"); assert.equal(prompt.status, "armed");
  assert.throws(() => svc.recordExempt("L-1", { cycle_due_date: row.cycle_due_date, reason: "bk_written_cease_request", evidence_document_id: null, effective_on: D("2026-10-12") }), /evidence document/);
  assert.throws(() => svc.recordExempt("L-1", { cycle_due_date: row.cycle_due_date, reason: "fdcpa_cease", evidence_document_id: "img-x", effective_on: D("2026-10-12") }), /no FDCPA exemption/);
  assert.equal(prompt.status, "armed");                                                              // refusals leave the deadline open
  const ex = svc.recordExempt("L-1", { cycle_due_date: row.cycle_due_date, reason: "bk_written_cease_request", evidence_document_id: "img-cease-1", effective_on: D("2026-10-12"), case_id: "BK-1" });
  assert.deepEqual([ex.exemption_basis, ex.variant], ["§1026.41(e)(5)(i)(A)", "exempt_bk"]);
  const exempt = events.ofType("statement.cycle.exempt")[0]!.payload as Record<string, unknown>;
  assert.deepEqual([exempt.cycle_due_date, exempt.evidence_document_id, exempt.effective_on, exempt.exemption_basis], ["2026-11-01", "img-cease-1", "2026-10-12", "§1026.41(e)(5)(i)(A)"]);
  assert.equal(prompt.status, "satisfied"); assert.equal(events.ofType("statement.sent").length, 0);
  assert.deepEqual(types(events, "L-1").filter((t) => t.startsWith("statement.")), ["statement.cycle.opened", "statement.cycle.exempt", "statement.cycle.closed"]);
});
test("7.1-T7: Given charge-off approved Nov 3, then `NTC_REGZ_41E6_CHARGEOFF_SUSPENSION` is sent by Dec 3 with the exact title and seven items; given a fee assessed Jan 10, then statements resume and the fee is reversed.", async () => {
  const n = chargeOffSuspension({ approved_on: D("2026-11-03") });
  assert.equal(n.template, "NTC_REGZ_41E6_CHARGEOFF_SUSPENSION"); assert.equal(n.due_on, "2026-12-03"); assert.equal(n.title, CHARGEOFF_TITLE);
  assert.equal(n.title, "Suspension of Statements & Notice of Charge Off — Retain This Copy for Your Records"); assert.equal(n.items.length, 7); assert.equal(n.exemption_lapsed, false);
  assert.match(CHARGEOFF_ITEMS[6], /§1026\.41\(e\)\(6\)\(ii\)/);                                    // the seventh item is the (e)(6)(ii) resumption rule — (e)(6)(i)(B) lists six
  const reg = published(); const v = reg.activeVersion("NTC_REGZ_41E6_CHARGEOFF_SUSPENSION", D("2026-11-20"))!;
  const r = render(v.source, v.samplePayload); assert.match(r.text, /^Suspension of Statements & Notice of Charge Off — Retain This Copy for Your Records/); assert.match(r.text, /\(7\) if any fee or interest is charged/); assert.equal(evaluateChecklist(v, v.samplePayload, r).passed, true);
  const fee = chargeOffSuspension({ approved_on: D("2026-11-03"), fee_assessed_on: D("2027-01-10"), fee_cents: 2500n });
  assert.equal(fee.exemption_lapsed, true); assert.equal(fee.statements_resume, true); assert.equal(fee.fee_reversed_cents, 2500n);
  // REGZ_1026_41E6_CHARGEOFF_NOTICE_30: `loan.charged_off{charged_off_on=Nov 3}` (approval ingestion) → due Dec 3; the notice sent through the registry closes it
  const rg = rig("2026-11-03T20:00:00.000Z"); const { clock, events, engine } = rg; const { svc } = pipeline(rg);
  assert.throws(() => svc.recordChargeOff("L-1", { charged_off_on: D("2026-11-03"), approval_document_id: null, no_further_fees_or_interest: true, balance_cents: 37_104_886n }), /approval document/);
  assert.throws(() => svc.recordChargeOff("L-1", { charged_off_on: D("2026-11-03"), approval_document_id: "co-approval-1", no_further_fees_or_interest: false, balance_cents: 37_104_886n }), /no further fees or interest/);
  assert.equal(engine.byCode("REGZ_1026_41E6_CHARGEOFF_NOTICE_30").length, 0);
  const co = svc.recordChargeOff("L-1", { charged_off_on: D("2026-11-03"), approval_document_id: "co-approval-1", no_further_fees_or_interest: true, balance_cents: 37_104_886n });
  assert.equal(co.notice_due_by, "2026-12-03");
  const t = engine.byCode("REGZ_1026_41E6_CHARGEOFF_NOTICE_30")[0]!; assert.equal(t.dueDate, "2026-12-03"); assert.equal(t.anchorDate, "2026-11-03"); assert.equal(t.status, "armed");
  clock.set("2026-11-20T15:00:00.000Z");
  const sent = await svc.sendChargeOffNotice("L-1", { charged_off_on: D("2026-11-03"), sent_on: D("2026-11-20"), recipients: [BEA], payload: { ...v.samplePayload, balance_cents: 37_104_886n } });
  assert.equal(sent.status, "sent"); assert.match(sent.rendered.text, /^Suspension of Statements & Notice of Charge Off — Retain This Copy for Your Records/);
  assert.equal((events.ofType("notice.sent")[0]!.payload as { template: string }).template, "NTC_REGZ_41E6_CHARGEOFF_SUSPENSION"); assert.equal(t.status, "satisfied");
  await assert.rejects(svc.sendChargeOffNotice("L-1", { charged_off_on: D("2026-11-03"), sent_on: D("2026-12-04"), recipients: [BEA], payload: v.samplePayload }), NoticeHeld);   // day 31 fails the template's within-30 rule
  clock.set("2027-01-10T15:00:00.000Z");
  const lapsed = svc.recordChargeOffFeeAssessed("L-1", { charged_off_on: D("2026-11-03"), fee_assessed_on: D("2027-01-10"), fee_cents: 2500n });
  assert.deepEqual([lapsed.exemption_lapsed, lapsed.statements_resume, lapsed.fee_reversed_cents], [true, true, 2500n]);
  assert.equal((events.ofType("statement.exemption.lapsed")[0]!.payload as { fee_reversed_cents: string }).fee_reversed_cents, "2500");
});
test("7.1-T8: Given the October payment unpaid on Oct 17 and no forbearance, then the Oct 17 statement carries the D2-2-03 panel and `FNMA_D2_2_03_PAYMENT_REMINDER_20` is satisfied; given the statement is held, then a standalone reminder is sent by Oct 20.", async () => {
  const sent = reminderDecision({ statement_date: D("2026-10-17"), month_payment_unpaid: true, forbearance_active: false, statement_held: false });
  assert.equal(sent.panel, true); assert.equal(sent.timer, "FNMA_D2_2_03_PAYMENT_REMINDER_20"); assert.equal(sent.satisfied_by, "statement.sent{reminder_panel=true}"); assert.equal(sent.standalone, null);
  const unpaid16 = (events: MemoryEventStore) => events.append({ type: "payment.cycle.unpaid_day16", loanId: "L-1", actor: SYSTEM, payload: { due_date: "2026-10-01", grace_end_on: "2026-10-16", late_charges_due_cents: "23342" } });   // 2.7 fires it on the 17th
  // (a) the Oct 17 statement carries the panel: `payment.reminder.sent{via=statement_panel}` rides with `statement.sent{reminder_panel=true}` and closes the timer
  const a = rig("2026-10-17T05:05:00.000Z"); const { reg, pm, svc } = pipeline(a);
  unpaid16(a.events);
  const t = a.engine.byCode("FNMA_D2_2_03_PAYMENT_REMINDER_20")[0]!; assert.equal(t.dueDate, "2026-10-20"); assert.equal(t.status, "armed");
  const v = reg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-10-17"))!;
  assert.match(render(v.source, v.samplePayload).text, /Bea Borrower, we want to work with you to preserve homeownership\. Late charges due: \$233\.42\./);
  const row = svc.openCycle("L-1", { prior_due_date: D("2026-10-01"), late_charge_grace_days: 15 });
  const stmt = svc.renderStatement("L-1", { cycle_due_date: row.cycle_due_date, statement_date: D("2026-10-17"), template: "NTC_REGZ_41_STMT_DELQ", variant: "delinquent", payload: v.samplePayload, recipients: [BEA], reminder_panel: sent.panel });
  await svc.sendStatement(stmt.notice.id); a.clock.set("2026-10-19T13:00:00.000Z"); pm.runProduction("2026-10-19T13:00:00.000Z");
  assert.equal(t.status, "armed");                                                                                       // vendor submission alone is not the reminder
  svc.recordStatementMailed(stmt.notice.id, { attempt_no: 1, mailed_at: "2026-10-19T13:00:00.000Z", proof_of_mailing_id: `POM-${stmt.notice.id}:1` });
  const panel = a.events.ofType("payment.reminder.sent")[0]!.payload as Record<string, unknown>;
  assert.deepEqual([panel.via, panel.sent_on, panel.on_time], ["statement_panel", "2026-10-17", true]); assert.equal(t.status, "satisfied");
  assert.equal(eventMatches(REG.get("FNMA_D2_2_03_PAYMENT_REMINDER_20")!.satisfiedPattern!, { ...a.events.ofType("statement.sent")[0]!, payload: { reminder_panel: false } }), false);   // a statement without the panel never closes it
  // (b) the statement is held → the standalone NTC_FNMA_D2_2_03_PAYMENT_REMINDER by Oct 20 closes it
  const held = reminderDecision({ statement_date: D("2026-10-17"), month_payment_unpaid: true, forbearance_active: false, statement_held: true });
  assert.equal(held.panel, false); assert.deepEqual(held.standalone, { template: "NTC_FNMA_D2_2_03_PAYMENT_REMINDER", by: "2026-10-20" }); assert.deepEqual(held.satisfying_event, { type: "notice.sent", payload: { template: "NTC_FNMA_D2_2_03_PAYMENT_REMINDER" } });
  const b = rig("2026-10-17T05:05:00.000Z"); const pb = pipeline(b);
  unpaid16(b.events); const tb = b.engine.byCode("FNMA_D2_2_03_PAYMENT_REMINDER_20")[0]!;
  const noPhone = { ...v.samplePayload, servicer_phone: "" };
  const h = pb.svc.renderStatement("L-1", { cycle_due_date: D("2026-11-01"), statement_date: D("2026-10-17"), template: "NTC_REGZ_41_STMT_DELQ", variant: "delinquent", payload: noPhone, recipients: [BEA], reminder_panel: true });
  assert.equal(h.status, "held"); await assert.rejects(pb.svc.sendStatement(h.notice.id), NoticeHeld); assert.equal(tb.status, "armed");
  b.clock.set("2026-10-20T14:00:00.000Z");
  const rem = pb.reg.activeVersion("NTC_FNMA_D2_2_03_PAYMENT_REMINDER", D("2026-10-20"))!;
  const standalone = await pb.svc.sendStandaloneReminder("L-1", { sent_on: D("2026-10-20"), recipients: [BEA], payload: { ...rem.samplePayload, late_charges_due_cents: 23_342n } });
  assert.equal(standalone.status, "sent"); assert.match(standalone.rendered.text, /Late charges due: \$233\.42/);
  assert.equal((b.events.ofType("payment.reminder.sent")[0]!.payload as { via: string }).via, "standalone_notice"); assert.equal(tb.status, "satisfied");
  await assert.rejects(pb.svc.sendStandaloneReminder("L-1", { sent_on: D("2026-10-21"), recipients: [BEA], payload: rem.samplePayload }), NoticeHeld);   // the 21st fails the template's by-20th rule
  // (c) cancellation: a full periodic payment applied on the 18th (or an active forbearance) cancels the open timer instead of breaching it on the 21st
  const c = rig("2026-10-17T05:05:00.000Z"); const pc = pipeline(c); const off = pc.svc.subscribe();
  unpaid16(c.events); const tc = c.engine.byCode("FNMA_D2_2_03_PAYMENT_REMINDER_20")[0]!;
  c.events.append({ type: "payment.applied", loanId: "L-1", actor: SYSTEM, payload: { due_date: "2026-10-01", full_periodic_payment: false, amount_cents: "150000" } }); assert.equal(tc.status, "armed");   // a partial is not a periodic payment (2.2)
  c.clock.set("2026-10-18T16:00:00.000Z"); c.events.append({ type: "payment.applied", loanId: "L-1", actor: SYSTEM, payload: { due_date: "2026-10-01", full_periodic_payment: true, amount_cents: "294679" } });
  assert.equal(tc.status, "cancelled"); assert.match(tc.cancelledReason!, /full periodic payment for 2026-10-01/); assert.equal(c.engine.evaluate("2026-10-21T04:00:00.000Z").length, 0);
  off();
  assert.equal(reminderDecision({ statement_date: D("2026-10-17"), month_payment_unpaid: true, forbearance_active: true, statement_held: false }).satisfied_by, null);
  const f = rig("2026-10-17T05:05:00.000Z"); const pf = pipeline(f); unpaid16(f.events);
  assert.deepEqual(pf.svc.forbearanceActivated("L-1", { plan_id: "FB-1" }).cancelled, [f.engine.byCode("FNMA_D2_2_03_PAYMENT_REMINDER_20")[0]!.id]); assert.equal(f.engine.byCode("FNMA_D2_2_03_PAYMENT_REMINDER_20")[0]!.status, "cancelled");
});
test("7.1-T9: Given `statement_due_by` falls on Sunday Oct 18 (courtesy ending Oct 14), then the file goes to the vendor by Friday Oct 16 and no business-day roll is applied.", () => {
  const c = cycle(D("2026-09-29"), 15);
  assert.equal(c.courtesy_period_end, "2026-10-14"); assert.equal(c.statement_due_by, "2026-10-18"); assert.equal(dayOfWeek(c.statement_due_by), 0);   // Sunday stays the due date
  assert.equal(c.vendor_file_by, "2026-10-16"); assert.equal(dayOfWeek(c.vendor_file_by), 5);
});
test("7.1-T10: Given late charge 5% of P&I $2,334.29, then late fee = $116.71 (round-half-up) and the (d)(1)(ii) line names Oct 16 as the last timely date.", () => {
  assert.equal(lateFeeLine(233429n, "5", null), 11671n); assert.equal(lateFeeLine(233429n, "5.000", 10000n), 10000n);
  assert.equal(cycle(D("2026-10-01"), 15).courtesy_period_end, "2026-10-16");
  const reg = published(); const v = reg.activeVersion("NTC_REGZ_41_STMT_STD", D("2026-09-17"))!;
  const r = render(v.source, v.samplePayload);
  assert.match(r.text, /If payment is received after October 16, 2026, a late fee of \$116\.71 will be charged/);
  const noLine = { ...v.samplePayload, late_fee_cents: null };
  assert.ok(evaluateChecklist(v, noLine, render(v.source, noLine)).blocking.some((b) => b.rule_id === "d1-late-fee"));
});
test("7.1-T11: Given a checklist `block` failure (missing toll-free number), then the statement is held, cannot be sent, and an ops alert fires within 5 minutes.", async () => {
  const reg = published(); const v = reg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-10-17"))!;
  const noPhone = { ...v.samplePayload, servicer_phone: "" };
  const c = evaluateChecklist(v, noPhone, render(v.source, noPhone));
  assert.ok(c.blocking.some((b) => b.rule_id === "d6-tollfree"), "REGZ_41_D6_TOLLFREE_P1 blocks");
  const h = checklistHold({ failures: c.blocking.map((b) => ({ rule_id: b.rule_id, severity: b.severity })), detected_at: "2026-10-17T06:00:00.000Z" });
  assert.equal(h.held, true); assert.equal(h.can_send, false); assert.ok(h.blocking.includes("d6-tollfree")); assert.equal(h.ops_alert_by, "2026-10-17T06:05:00.000Z");
  const clock = new FixedClock("2026-10-17T06:00:00.000Z"); const events = new MemoryEventStore(clock);
  const svc = new NoticeService({ registry: reg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const n = svc.render({ templateCode: "NTC_REGZ_41_STMT_DELQ", loanId: "L-1", recipients: [BEA], payload: noPhone, asOf: D("2026-10-17") });
  assert.equal(n.status, "held"); assert.match(n.heldReason!, /d6-tollfree/); await assert.rejects(svc.send(n.id), NoticeHeld);
  assert.equal(checklistHold({ failures: [{ rule_id: "no-suspense-netting", severity: "warn" }], detected_at: "2026-10-17T06:00:00.000Z" }).can_send, true);
  // the pipeline: `statement.held{blocking, ops_alert_by}` instead of `statement.rendered`, so SM_STATEMENT_GENERATE_T1 stays open; the send is refused
  const rg = rig("2026-10-17T06:00:00.000Z"); const { svc: cyc } = pipeline(rg);
  const row = cyc.openCycle("L-1", { prior_due_date: D("2026-10-01"), late_charge_grace_days: 15 });
  const held = cyc.renderStatement("L-1", { cycle_due_date: row.cycle_due_date, statement_date: D("2026-10-17"), template: "NTC_REGZ_41_STMT_DELQ", variant: "delinquent", payload: noPhone, recipients: [BEA], reminder_panel: true });
  assert.equal(held.status, "held"); assert.match(held.held_reason!, /d6-tollfree/); assert.equal(held.ops_alert_by, "2026-10-17T06:05:00.000Z");
  const ev = rg.events.ofType("statement.held")[0]!.payload as { blocking: string[]; ops_alert_by: string }; assert.ok(ev.blocking.includes("d6-tollfree")); assert.equal(ev.ops_alert_by, "2026-10-17T06:05:00.000Z");
  await assert.rejects(cyc.sendStatement(held.notice.id), NoticeHeld); assert.equal(rg.events.ofType("statement.rendered").length, 0); assert.equal(rg.engine.byCode("SM_STATEMENT_GENERATE_T1")[0]!.status, "armed");
});
test("7.1-T12: Given e-delivery consent active and the availability email hard-bounces, then a paper statement is mailed within 1 business day and the consent is flagged `suspect`.", () => {
  const c = newConsent("A", ["periodic_statements"], "v1.3", D("2026-10-02"), "portal"); if ("error" in c) throw new Error(c.error);
  verify(c, true, true, D("2026-10-02")); assert.equal(c.status, "active");
  const b = availabilityEmailBounce({ consent: c, bounced_on: D("2026-12-03"), kind: "hard" });
  assert.equal(b.mail_paper_by, "2026-12-04"); assert.equal(b.consent_status, "suspect"); assert.equal(b.reverification_invite, true); assert.equal(b.timer, "SM_EMAIL_BOUNCE_SUSPECT_1BD"); assert.equal(b.satisfied_by, "notice.mailed{satisfies_timer=true}");
});
test("7.1-T13: Given tax year 2026 interest received $23,412.55 and Jan 1 UPB $371,048.86, then the 1098 shows box 1 $23,412.55, box 2 $371,048.86, is furnished by Jan 31, 2027 and e-filed by Mar 31, 2027; given electronic furnishing, then it remains accessible through Oct 15, 2027.", async () => {
  const f = form1098Cycle({ tax_year: 2026, interest_received_cents: 2341255n, upb_jan1_cents: 37104886n, electronic: true });
  assert.equal(f.box1_cents, 2341255n); assert.equal(f.box2_cents, 37104886n); assert.equal(f.furnish_by, "2027-01-31"); assert.equal(f.efile_by, "2027-03-31"); assert.equal(f.accessible_through, "2027-10-15"); assert.equal(f.template, "NTC_IRS_1098"); assert.equal(f.file_with_irs, true);
  assert.deepEqual(f.access_check_event, { type: "tax_form.1098.access_verified", payload: { tax_year: 2026, available: true } });
  const paper = form1098Cycle({ tax_year: 2026, interest_received_cents: 2341255n, upb_jan1_cents: 37104886n, electronic: false }); assert.equal(paper.accessible_through, null); assert.equal(paper.access_check_event, null);
  // Jan 31, 2027 is a Sunday: the furnish deadline stays a calendar date (no business-day roll)
  assert.deepEqual(REG.get("IRS_6050H_1098_FURNISH_0131")!.offsetParsed, { kind: "calendar_day", day: 31, monthOffset: 0, month: 1, yearOffset: 0 });
  // below $600: furnished to the payer anyway (decision 5), filed only ≥ $600 — the checklist holds only a filed form under the threshold
  const small = form1098Cycle({ tax_year: 2026, interest_received_cents: 50000n, upb_jan1_cents: 37104886n, electronic: false }); assert.equal(small.furnish_to_all_payers, true); assert.equal(small.file_with_irs, false);
  const nr = published(); const v = nr.activeVersion("NTC_IRS_1098", D("2027-01-15"))!;
  const furnishOnly = { ...v.samplePayload, box1_cents: 50000n, box1_cents_number: 50000, filed_with_irs: false };
  assert.equal(evaluateChecklist(v, furnishOnly, render(v.source, furnishOnly)).passed, true);
  const filedSmall = { ...furnishOnly, filed_with_irs: true };
  assert.ok(evaluateChecklist(v, filedSmall, render(v.source, filedSmall)).blocking.some((b) => b.rule_id === "threshold"));
  // `tax_year.closed` (Jan 2, 00:05 ET) per reportable loan arms both annual timers: furnish by Sun Jan 31, 2027 (calendar) and e-file by Mar 31, 2027
  const a = rig("2027-01-02T05:05:00.000Z"); const pa = pipeline(a);
  assert.throws(() => pa.svc.closeTaxYear({ tax_year: 2026, reportable_loans: [] }), RangeError);
  const closed = pa.svc.closeTaxYear({ tax_year: 2026, reportable_loans: ["L-1", "L-2"] });
  assert.deepEqual([closed.tax_year_end, closed.furnish_by, closed.efile_by, closed.loans], ["2026-12-31", "2027-01-31", "2027-03-31", 2]);
  const furnishT = a.engine.byCode("IRS_6050H_1098_FURNISH_0131"), fileT = a.engine.byCode("IRS_6050H_1098_FILE_0331");
  assert.deepEqual(furnishT.map((t) => [t.loanId, t.dueDate, t.status]), [["L-1", "2027-01-31", "armed"], ["L-2", "2027-01-31", "armed"]]); assert.deepEqual(fileT.map((t) => t.dueDate), ["2027-03-31", "2027-03-31"]);
  assert.equal(dayOfWeek(furnishT[0]!.dueDate!), 0);
  // electronic furnishing under an active `irs_estatement` consent (7.4) through the registry → `tax_form.1098.furnished{channel=electronic, tax_year_end}`; the two annual rows are recurring, so their
  // satisfaction is proved against the registry patterns (eventMatches) on a store of its own
  const b = { clock: new FixedClock("2027-01-20T15:00:00.000Z"), events: new MemoryEventStore(new FixedClock("2027-01-20T15:00:00.000Z")) }; const pb = pipeline(b);
  const consent = newConsent("A", ["irs_estatement"], "v1.3", D("2026-10-02"), "portal"); if ("error" in consent) throw new Error(consent.error); verify(consent, true, true, D("2026-10-02"));
  const fu = await pb.svc.furnish1098("L-1", { tax_year: 2026, interest_received_cents: 2341255n, upb_jan1_cents: 37104886n, furnished_on: D("2027-01-20"), recipients: [{ ...BEA, email: "bea@example.com", consent }], payload: v.samplePayload });
  assert.deepEqual([fu.box1_cents, fu.box2_cents, fu.furnish_by, fu.efile_by, fu.channel, fu.accessible_through, fu.file_with_irs], [2341255n, 37104886n, "2027-01-31", "2027-03-31", "electronic", "2027-10-15", true]);
  assert.match(fu.notice.rendered.text, /Box 1 Mortgage interest received from payer\(s\)\/borrower\(s\): \$23,412\.55\. Box 2 Outstanding mortgage principal as of January 1, 2026: \$371,048\.86/);
  assert.equal(fu.notice.deliveries[0]!.channel, "email_link"); assert.deepEqual([fu.furnished_on, fu.on_time], ["2027-01-20", true]);
  const furnished = fu.event; assert.deepEqual([furnished.type, (furnished.payload as { channel: string }).channel, (furnished.payload as { tax_year_end: string }).tax_year_end], ["tax_form.1098.furnished", "electronic", "2026-12-31"]);
  assert.equal(eventMatches(REG.get("IRS_6050H_1098_FURNISH_0131")!.satisfiedPattern!, furnished), true);
  assert.throws(() => pb.svc.record1098Filed("L-1", { tax_year: 2026, filed_at: "2027-03-15T14:00:00.000Z", irs_receipt_id: null, irs_accepted: true }), /receipt id/);
  const rejected = pb.svc.record1098Filed("L-1", { tax_year: 2026, filed_at: "2027-03-15T14:00:00.000Z", irs_receipt_id: null, irs_accepted: false, rejection_reason: "TIN mismatch" });
  const accepted = pb.svc.record1098Filed("L-1", { tax_year: 2026, filed_at: "2027-03-20T14:00:00.000Z", irs_receipt_id: "IRIS-2027-000123", irs_accepted: true });
  const filePattern = REG.get("IRS_6050H_1098_FILE_0331")!.satisfiedPattern!;
  assert.equal(eventMatches(filePattern, rejected), false); assert.equal(eventMatches(filePattern, accepted), true);            // "+ IRS acceptance"
  // the Oct 15 gate: armed by the electronic furnishing on the tax year's end (2026-12-31 → 2027-10-15, not 2028), never by paper; the daily check `available=true` satisfies it
  const c = rig("2027-01-20T15:00:00.000Z"); c.events.append({ type: furnished.type, loanId: "L-1", actor: furnished.actor, payload: furnished.payload });
  const access = c.engine.byCode("IRS_1098_EFURNISH_ACCESS_1015")[0]!; assert.equal(access.dueDate, "2027-10-15"); assert.equal(access.anchorDate, "2026-12-31"); assert.equal(access.status, "armed");
  const d = rig("2027-01-20T15:00:00.000Z"); d.events.append({ type: furnished.type, loanId: "L-2", actor: furnished.actor, payload: { ...furnished.payload, channel: "paper", accessible_through: null } });
  assert.equal(d.engine.byCode("IRS_1098_EFURNISH_ACCESS_1015").length, 0);
  const accessPattern = REG.get("IRS_1098_EFURNISH_ACCESS_1015")!.satisfiedPattern!;
  assert.equal(eventMatches(accessPattern, pb.svc.verify1098Access("L-1", { tax_year: 2026, checked_on: D("2027-06-01"), available: true, accessible_through: D("2027-10-15") })), true);
  assert.equal(eventMatches(accessPattern, pb.svc.verify1098Access("L-1", { tax_year: 2026, checked_on: D("2027-06-02"), available: false, accessible_through: D("2027-10-15") })), false);
  // paper furnishing (no consent) records channel=paper and no access window
  const pp = await pb.svc.furnish1098("L-2", { tax_year: 2026, interest_received_cents: 50000n, upb_jan1_cents: 37104886n, furnished_on: D("2027-01-20"), recipients: [BEA], payload: v.samplePayload });
  assert.deepEqual([pp.channel, pp.accessible_through, pp.file_with_irs], ["paper", null, false]);
});
test("7.1-T14: Given a confirmed successor without an executed acknowledgment, then no statement is addressed to the successor; given the acknowledgment executed, then the successor is added as a recipient on the next cycle.", () => {
  const before = statementRecipients({ borrower_of_record: "Bea Borrower", successor: { name: "Sam Successor", confirmed: true, acknowledgment_executed: false, assumed: false } });
  assert.deepEqual(before.recipients, ["Bea Borrower"]); assert.equal(before.successor_added_from, null);
  const after = statementRecipients({ borrower_of_record: "Bea Borrower", successor: { name: "Sam Successor", confirmed: true, acknowledgment_executed: true, assumed: false } });
  assert.deepEqual(after.recipients, ["Bea Borrower", "Sam Successor"]); assert.equal(after.successor_added_from, "next_cycle");
});
test("7.1-T15: Given transfer-out effective Dec 1, then no statement is generated for the Dec 1 cycle and the Nov statement references the goodbye notice.", () => {
  const t = transferOutStatements({ transfer_effective: D("2026-12-01"), cycles: [{ due_date: D("2026-11-01") }, { due_date: D("2026-12-01") }, { due_date: D("2027-01-01") }] });
  assert.deepEqual(t.cycles, [{ due_date: "2026-11-01", generate: true, goodbye_reference: true }, { due_date: "2026-12-01", generate: false, goodbye_reference: false }, { due_date: "2027-01-01", generate: false, goodbye_reference: false }]);
});

test("7.1 worked example: $400,000 at 5.750% (P&I $2,334.29, escrow $612.50, payment $2,946.79) → Oct statement $6,010.29, Nov statement $9,073.79 with $5,893.58 past due and $233.42 late charges, $6,127.00 to reinstate, $1,446.79 still needed after a $1,500.00 partial", () => {
  assert.equal(contractualPayment(233429n, 61250n), 294679n); assert.equal(lateFeeLine(233429n, "5.000", null), 11671n);
  const oct = amountDue({ current_payment_cents: 294679n, past_due_cents: 294679n, late_charges_cents: 11671n, fees_cents: 0n, suspense_cents: 0n });
  assert.equal(oct.amount_due_cents, 601029n);
  const nov = amountDue({ current_payment_cents: 294679n, past_due_cents: 589358n, late_charges_cents: 23342n, fees_cents: 0n, suspense_cents: 150000n });
  assert.equal(nov.amount_due_cents, 907379n); assert.equal(reinstatementAmount({ past_due_cents: 589358n, late_charges_cents: 23342n, fees_cents: 0n }), 612700n); assert.equal(nov.shortfall_to_complete_cents, 144679n); assert.equal(nov.suspense_disclosed_cents, 150000n);
});
test("7.1 guardrail: the agent cannot suppress a statement for returned mail or an FDCPA cease request, and never without evidence", () => {
  assert.match(statementSuppressionRequest({ reason: "returned_mail", evidence_document_id: "img-1" }).refusal!, /returned mail never suppresses/);
  assert.match(statementSuppressionRequest({ reason: "fdcpa_cease", evidence_document_id: "img-1" }).refusal!, /no FDCPA exemption/);
  assert.match(statementSuppressionRequest({ reason: "charged_off", evidence_document_id: null }).refusal!, /evidence document/);
  assert.deepEqual(statementSuppressionRequest({ reason: "charged_off", evidence_document_id: "approval-1" }), { allowed: true, refusal: null, exemption_basis: "§1026.41(e)(6)" });
});
test("7.1 returned mail: `notice.returned` (return date) arms SM_STATEMENT_RETURNED_MAIL_5 for +5 servicer business days; `address.research.completed` closes it and statements are never suppressed meanwhile", async () => {
  const r = rig("2026-10-17T05:05:00.000Z"); const { clock, events, engine } = r; const { reg, pm, notices, svc } = pipeline(r);
  const v = reg.activeVersion("NTC_REGZ_41_STMT_STD", D("2026-10-17"))!;
  const row = svc.openCycle("L-1", { prior_due_date: D("2026-10-01"), late_charge_grace_days: 15 });
  const st = svc.renderStatement("L-1", { cycle_due_date: row.cycle_due_date, statement_date: D("2026-10-17"), template: "NTC_REGZ_41_STMT_STD", variant: "standard", payload: v.samplePayload, recipients: [BEA], reminder_panel: false });
  await svc.sendStatement(st.notice.id); pm.runProduction("2026-10-19T13:00:00.000Z"); svc.recordStatementMailed(st.notice.id, { attempt_no: 1, mailed_at: "2026-10-19T13:00:00.000Z", proof_of_mailing_id: `POM-${st.notice.id}:1` });
  clock.set("2026-11-02T18:00:00.000Z"); notices.recordReturned(st.notice.id, 1, "2026-11-02T18:00:00.000Z", "NIXIE: moved, left no address");   // vendor return-mail feed, Mon Nov 2
  const t = engine.byCode("SM_STATEMENT_RETURNED_MAIL_5")[0]!;
  assert.equal(t.anchorDate, "2026-11-02"); assert.equal(t.dueDate, "2026-11-09"); assert.equal(t.status, "armed");               // Nov 3, 4, 5, 6, Mon 9 — five servicer business days
  assert.match(statementSuppressionRequest({ reason: "returned_mail", evidence_document_id: st.notice.id }).refusal!, /returned mail never suppresses/);
  assert.throws(() => svc.completeAddressResearch("L-1", { notice_id: st.notice.id, completed_on: D("2026-11-06"), outcome: "new_address_verified", new_address: null }), /new address/);
  clock.set("2026-11-06T16:00:00.000Z");
  const done = svc.completeAddressResearch("L-1", { notice_id: st.notice.id, completed_on: D("2026-11-06"), outcome: "new_address_verified", new_address: "9 New Rd, Testville TX 75002", ncoa_reference: "NCOA-77" });
  assert.equal(done.statements_suppressed, false); assert.match(done.refusal, /returned mail never suppresses/);
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, done.event.id);
  assert.deepEqual(events.ofType("address.change.detected").map((e) => (e.payload as { routed_to: string }).routed_to), ["4.x verification"]);
});
test("7.1 coupon books (decision 1, default off): `delinquency.crossed_45{coupon_book=true}` arms REGZ_1026_41E3IV_COUPON_DELQ_NOTICE +4 days after that cycle's statement_due_by; the written (d)(8) notice closes it; ARM loans and the feature flag are refused", async () => {
  // feature off: the crossing is recorded for the (d)(8) box, but never as a coupon-book crossing, so nothing arms
  const off = rig("2026-10-17T05:05:00.000Z"); const po = pipeline(off);
  const x = po.svc.recordDelinquencyCrossing("L-1", { statement_date: D("2026-10-17"), earliest_unpaid_due: D("2026-09-01"), prior_regx_days: 16, statement_due_by: D("2026-10-20"), coupon_book: true });
  assert.deepEqual([x.crossed, x.regx_days, x.coupon_book], [true, 46, false]); assert.equal(off.engine.byCode("REGZ_1026_41E3IV_COUPON_DELQ_NOTICE").length, 0);
  await assert.rejects(po.svc.sendCouponDelinquencyNotice("L-1", { statement_date: D("2026-10-17"), arm_loan: false, recipients: [BEA], payload: {} }), /coupon_books is off/);
  // feature on, coupon-book borrower crossing 45 on the Oct 17 statement date (16 → 46): due statement_due_by Oct 20 + 4 = Oct 24
  const on = rig("2026-10-17T05:05:00.000Z"); const pn = pipeline(on, { coupon_books: true });
  assert.equal(pn.svc.recordDelinquencyCrossing("L-1", { statement_date: D("2026-10-16"), earliest_unpaid_due: D("2026-09-01"), prior_regx_days: 16, statement_due_by: D("2026-10-20"), coupon_book: true }).crossed, false);   // 45 days: not yet
  const y = pn.svc.recordDelinquencyCrossing("L-1", { statement_date: D("2026-10-17"), earliest_unpaid_due: D("2026-09-01"), prior_regx_days: 45, statement_due_by: D("2026-10-20"), coupon_book: true });
  assert.deepEqual([y.crossed, y.coupon_book, y.began_on], [true, true, "2026-09-02"]);
  const t = on.engine.byCode("REGZ_1026_41E3IV_COUPON_DELQ_NOTICE")[0]!; assert.equal(t.anchorDate, "2026-10-20"); assert.equal(t.dueDate, "2026-10-24"); assert.equal(t.status, "armed");
  assert.equal(pn.svc.recordDelinquencyCrossing("L-1", { statement_date: D("2026-11-17"), earliest_unpaid_due: D("2026-09-01"), prior_regx_days: 46, statement_due_by: D("2026-11-20"), coupon_book: true }).crossed, false);   // already past 45: no second crossing
  await assert.rejects(pn.svc.sendCouponDelinquencyNotice("L-1", { statement_date: D("2026-10-17"), arm_loan: true, recipients: [BEA], payload: {} }), /fixed-rate loans only/);
  const v = pn.reg.activeVersion("NTC_REGZ_41E3IV_COUPON_DELQ_NOTICE", D("2026-10-17"))!;
  const n = await pn.svc.sendCouponDelinquencyNotice("L-1", { statement_date: D("2026-10-17"), arm_loan: false, recipients: [BEA], payload: v.samplePayload });
  assert.equal(n.status, "sent"); assert.match(n.rendered.text, /you are 46 days delinquent .* Your delinquency began on September 2, 2026/); assert.equal(t.status, "satisfied");
  // a non-coupon loan's crossing carries coupon_book=false and does not arm the row even with the feature on
  pn.svc.recordDelinquencyCrossing("L-2", { statement_date: D("2026-10-17"), earliest_unpaid_due: D("2026-09-01"), prior_regx_days: 16, statement_due_by: D("2026-10-20") });
  assert.equal(on.engine.byCode("REGZ_1026_41E3IV_COUPON_DELQ_NOTICE").length, 1);
});
