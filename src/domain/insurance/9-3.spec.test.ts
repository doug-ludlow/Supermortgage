// 9.3 Force-placed — reminder notice
// spec/sections/09-insurance-property-protection/9-3-force-placed-reminder-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id runs through the reminder job (ops-9-3.ts composeReminder) over the 9.2 case service (ops-9-2.ts), with the
// TimerEngine armed from the process's own events: `fpi.first_notice.sent` arms REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30 and
// INS_FPI_REMINDER_TARGET_30_35 on t0; the Notice Registry's `notice.production{template∈MS-3}` arms
// REGX_1024_37D5_NOTICE_PRODUCTION_5BD and its `notice.mailed` closes it; the proof of mailing becomes `fpi.reminder.sent`
// (t1), which closes the 30-day gate/target and arms REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15 and
// REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15; `fpi.evidence_window.evaluated` and `fpi.charge.assessed` close those.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, type DomainEvent } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { Fpi92Service, fpiReactors_9_2, REMINDER_TEMPLATES, type OpenCaseInput } from "./ops-9-2.ts";
import { composeReminder, reminderTargetDate, reminderProductionCheck, quoteEscalation, estimateBasis, reminderReactors_9_3 } from "./ops-9-3.ts";
import { fpiClocks, reminderAllowed, reminderVariant, premiumQuote, premiumFromRate, productionWindowOk, boldItemsPresent, noticeChecklist } from "./fpi.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import type { TemplateVersion, VersionInput } from "../../notices/registry.ts";
import { SECTION_09_VERSIONS } from "../../notices/authored/section09.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { SECTION_09_TOOLS } from "../../app/tools/section09.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { CommandContext } from "../../app/commands.ts";

const REG = loadOverriddenRegistry();
const MS3B = REMINDER_TEMPLATES.b_no_info, MS3C = REMINDER_TEMPLATES.c_insufficient;
const version = (code: string): VersionInput => SECTION_09_VERSIONS.find((v) => v.templateCode === code)!;
const asVersion = (v: VersionInput): TemplateVersion => ({ ...v, sourceHash: "test", plainLanguageStatus: "draft" } as unknown as TemplateVersion);

function harness(nowIso = "2026-10-02T14:00:00.000Z") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const timers = new TimerEngine(REG, events, { processes: ["9.2", "9.3"] });
  const svc = new Fpi92Service({ events, clock, timers, ledger });
  const off92 = fpiReactors_9_2(svc, events); const off93 = reminderReactors_9_3(svc, events);
  const reg = buildRegistry(); publishAuthored(reg);
  const notices = new NoticeService({ registry: reg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const inst = (code: string) => timers.byCode(code).at(-1);
  const off = () => { off92(); off93(); };
  return { clock, events, ledger, timers, svc, notices, inst, off };
}
type H = ReturnType<typeof harness>;
/** 9.2 rule 8 worked example: policy expired 2026-10-01, vendor non-renewal 2026-10-02 = reasonable basis, non-escrowed, TX. */
const WORKED: OpenCaseInput = { loan_id: "L-93", kind: "nonrenewed", insurance_type: "hazard", fdpa_required: false, escrowed: false, regx_days_delinquent: 0, cancellation_reason: null, lapse_start: D("2026-10-01"), opened_on: D("2026-10-02"), basis: { kind: "carrier_nonrenewal", evidence_id: "doc-nonrenewal-1" }, state: "TX" };
const FACTS = { borrower_name: "Bea Borrower", borrower_address: "1 Test St, Testville TX 75001", property_address: "1 Test St, Testville TX 75001", account_last4: "1234", servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", insurance_email: "insurance@example.com" };
const RECIPIENTS = [{ partyId: "B1", name: "Bea Borrower", mailingAddress: FACTS.borrower_address }];
/** Rule 2 worked example: coverage $250,000, tier deductible $2,000, occupied, TX rate 0.876% → $2,190.00 (no carrier quote → rate table). */
const RATE_TABLE = { carrier_quote_cents: null, table_rate_pct: "0.876", rate_table_version: "TX-2026-Q4", coverage_cents: 25_000_000n, deductible_cents: 200_000n, occupancy: "occupied" };
const VENDOR = { vendor_id: "LPI-1", whitelist: ["LPI-1"], affiliate: false, fees: [] as { kind: string; cents: bigint }[] };
const COVER = { last_known_cents: 25_000_000n, rcv_cents: 26_200_000n, upb_cents: 20_000_000n };
const mailed = (case_id: string, notice_id: string, mailed_at: ReturnType<typeof D>, produced_at = mailed_at) => ({ case_id, notice_id, mailed_at, produced_at, mail_class: "first_class", proof_of_mailing_id: `POM-${notice_id}` });
/** The case with the MS-3(A) mailed 2026-10-05 (Mon) = t0 — the state the reminder job starts from. */
function firstNoticeSent(h: H) {
  const c = h.svc.openCase(WORKED);
  h.clock.set("2026-10-05T14:00:00.000Z"); h.svc.recordFirstNoticeMailed(mailed(c.case_id, "n-ms3a", D("2026-10-05")));
  return c;
}
/** Produce the reminder through the Notice Registry on the harness clock (→ `notice.production`), then record the proof of mailing (→ `notice.mailed` → `fpi.reminder.sent`). */
async function produce(h: H, caseId: string, producedIso: string, evidence: Parameters<typeof composeReminder>[2]["evidence"] = [], regenerates?: { previous_notice_id: string; reason: string }) {
  h.clock.set(producedIso);
  const comp = composeReminder(h.svc, h.events, { case_id: caseId, evidence, facts: { ...FACTS, notice_date: D(producedIso.slice(0, 10)) }, produced_on: D(producedIso.slice(0, 10)), quote: RATE_TABLE, ...(regenerates ? { regenerates } : {}) });
  const n = h.notices.render({ templateCode: comp.template, loanId: WORKED.loan_id, recipients: RECIPIENTS, payload: comp.payload, asOf: D(producedIso.slice(0, 10)) });
  await h.notices.send(n.id);
  return { comp, notice: n, mail: (mailedIso: string, proof = `POM-${n.id.slice(0, 8)}`) => { h.clock.set(mailedIso); h.notices.recordMailed(n.id, 1, mailedIso, proof); } };
}
const AGENT = { kind: "agent", id: "insurance-property" } as const;
const toolCtx = (h: H) => ({ loanId: WORKED.loan_id, events: h.events, ledger: h.ledger, timers: h.timers, clock: h.clock, decide: () => {}, actor: AGENT, now: h.clock.now() }) as unknown as CommandContext;
const toolRt = (h: H): ToolRuntime => ({ store: new EntityStore(), escalations: new EscalationService(h.events, h.clock), services: {}, ports: {} });
const tool93 = (name: string) => SECTION_09_TOOLS.find((t) => t.process === "9.3" && t.name === name)!;

test("9.3-T1: Given t0 = 2026-10-05 When 2026-11-03 Then reminder command refused; 2026-11-04 allowed.", async () => {
  const c0 = fpiClocks(D("2026-10-05"), null);
  assert.equal(c0.reminder_not_before, "2026-11-04"); assert.equal(reminderAllowed(c0, D("2026-11-03")), false); assert.equal(reminderAllowed(c0, D("2026-11-04")), true);
  // Policy target (open decision 2): first business day on/after t0 + 30, never later than t0 + 35 — Wed 11/04 for t0 = Mon 10/05; a Saturday t0 + 30 rolls to Monday.
  assert.deepEqual(reminderTargetDate(D("2026-10-05")), { target: "2026-11-04", not_before: "2026-11-04", not_after: "2026-11-09" });
  assert.deepEqual(reminderTargetDate(D("2026-10-01")), { target: "2026-11-02", not_before: "2026-10-31", not_after: "2026-11-05" });
  const h = harness(); const c = firstNoticeSent(h);
  // `fpi.first_notice.sent{first_notice_mailed_at=2026-10-05}` armed the 30-day gate (opens 11/04) and the 30–35-day policy target window (11/04–11/09) on t0.
  const gate = h.inst("REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30")!, target = h.inst("INS_FPI_REMINDER_TARGET_30_35")!;
  assert.equal(gate.anchorDate, "2026-10-05"); assert.equal(gate.dueDate, "2026-11-04"); assert.equal(gate.status, "armed"); assert.equal(gate.loanId, "L-93");
  assert.equal(target.anchorDate, "2026-10-05"); assert.equal(target.note, "window opens 2026-11-04"); assert.equal(target.dueDate, "2026-11-09"); assert.equal(target.status, "armed");
  assert.ok(eventMatches(REG.get("INS_FPI_REMINDER_TARGET_30_35")!.triggerPattern!, h.events.ofType("fpi.first_notice.sent")[0] as DomainEvent));
  // The reminder command on 11/03 is refused (service) and the same proof of mailing arriving through the Notice Registry is recorded as a rejected inbound — no `fpi.reminder.sent`, gate still armed.
  assert.throws(() => h.svc.recordReminderMailed({ ...mailed(c.case_id, "n-early", D("2026-11-03")), variant: "b_no_info" }), /REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30 open until 2026-11-04: reminder command refused/);
  const early = await produce(h, c.case_id, "2026-11-03T14:00:00.000Z"); early.mail("2026-11-03T18:00:00.000Z");
  const rejected = h.events.ofType("fpi.inbound.rejected"); assert.equal(rejected.length, 1); assert.match(String(rejected[0]!.payload.reason), /REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30 open until 2026-11-04/);
  assert.equal(h.events.ofType("fpi.reminder.sent").length, 0); assert.equal(gate.status, "armed"); assert.equal(target.status, "armed"); assert.equal(h.svc.get(c.case_id).status, "first_notice_sent");
  // 11/04: allowed — `fpi.reminder.sent{reminder_mailed_at=2026-11-04}` closes the gate and the target window and arms the t1 clocks.
  const ok = await produce(h, c.case_id, "2026-11-04T14:00:00.000Z"); ok.mail("2026-11-04T18:00:00.000Z");
  const sent = h.events.ofType("fpi.reminder.sent"); assert.equal(sent.length, 1);
  assert.equal(sent[0]!.payload.reminder_mailed_at, "2026-11-04"); assert.equal(sent[0]!.payload.template, MS3B); assert.equal(sent[0]!.payload.variant, "b_no_info"); assert.equal(sent[0]!.payload.earliest_charge_date, "2026-11-19");
  assert.ok(eventMatches(REG.get("REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30")!.satisfiedPattern!, sent[0] as DomainEvent)); assert.ok(eventMatches(REG.get("INS_FPI_REMINDER_TARGET_30_35")!.satisfiedPattern!, sent[0] as DomainEvent));
  assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedByEventId, sent[0]!.id); assert.equal(target.status, "satisfied");
  assert.equal(h.inst("REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15")!.anchorDate, "2026-11-04"); assert.equal(h.inst("REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15")!.dueDate, "2026-11-19");
  assert.equal(h.svc.get(c.case_id).status, "evidence_window"); assert.equal(h.svc.get(c.case_id).reminder_mailed_at, "2026-11-04");
  h.off();
});
test('9.3-T2: Given no evidence rows When rendered Then MS-3(B) with "second and final notice" and "$2,190.00 annually" in bold.', async () => {
  assert.equal(reminderVariant([], D("2026-10-01"), D("2026-11-04")).variant, "b_no_info");
  const h = harness(); const c = firstNoticeSent(h);
  // The reminder job: no `insurance_evidence` row after t0 → MS-3(B); $250,000 × 0.876% = $2,190.00 from the rate table (no carrier quote), basis stored on `fpi_cases`.
  const comp = composeReminder(h.svc, h.events, { case_id: c.case_id, evidence: [], facts: { ...FACTS, notice_date: D("2026-11-04") }, produced_on: D("2026-11-04"), quote: RATE_TABLE });
  assert.equal(comp.variant, "b_no_info"); assert.equal(comp.template, MS3B); assert.equal(comp.quote.annual_premium_cents, 219_000n); assert.equal(comp.payload.annual_premium_cents, 219_000n);
  const produced = h.events.ofType("fpi.reminder.produced"); assert.equal(produced.length, 1);
  assert.equal(produced[0]!.payload.variant, "b_no_info"); assert.equal(produced[0]!.payload.template, MS3B); assert.equal(produced[0]!.payload.annual_premium_cents, 219_000n); assert.equal(produced[0]!.payload.written_evidence_rows, 0);
  assert.equal(h.svc.get(c.case_id).annual_premium_cents, 219_000n); assert.equal(h.svc.get(c.case_id).premium_is_estimate, true);
  // Rendered from the job's payload: (d)(2)(i)(B) "second and final notice" and (D) the annual cost, in bold ((d)(3)); the (c)(3) bold items carried in; nothing else on the page ((d)(4)).
  const v = version(MS3B);
  const r = render(v.source, comp.payload);
  assert.equal(evaluateChecklist(asVersion(v), comp.payload, r).passed, true);
  const bold = boldItemsPresent(r.blocks, [/second and final notice/i, /will cost \$2,190\.00 annually/, /immediately provide us with your hazard insurance information/i, /insurance is required on your property, we will purchase insurance on your property at your expense/i, /may cost significantly more .* may not provide as much coverage/i]);
  assert.deepEqual(bold, { ok: true, missing: [] });                                                    // (d)(3) + (c)(3): (B), (D), (iv), (vi), (ix)(A)–(B)
  assert.equal(r.blocks.find((b) => b.id === "property")!.bold, false);                                // the address itself need not be bold
  assert.match(r.text, /To: Bea Borrower, 1 Test St/); assert.match(r.text, /From: Supermortgage, PO Box 1/);   // (c)(2)(ii)–(iii)
  assert.match(r.text, /\$2,190\.00 annually \(an estimate\)/);                                          // rate-table figure identified as an estimate ((d)(2)(i)(D))
  assert.equal(noticeChecklist(r.blocks.map((b) => ({ id: b.id, text: b.text })), "reminder").ok, true);   // (d)(4): nothing else on the pages
  const unbolded = evaluateChecklist(asVersion(v), comp.payload, render(v.source.replace('{{#block "bold_cost" page=1 y=0.49 pt=12 bold}}', '{{#block "bold_cost" page=1 y=0.49 pt=12}}'), comp.payload));
  assert.ok(unbolded.blocking.some((b) => b.rule_id === "bold-cost"));
  // The Notice Registry accepts the same payload for the MS-3(B) (checklist passes at render) and the mailing lands as t1.
  h.clock.set("2026-11-04T14:00:00.000Z");
  const n = h.notices.render({ templateCode: MS3B, loanId: WORKED.loan_id, recipients: RECIPIENTS, payload: comp.payload, asOf: D("2026-11-04") });
  assert.equal(n.checklist.passed, true); await h.notices.send(n.id); h.notices.recordMailed(n.id, 1, "2026-11-04T18:00:00.000Z", "POM-b");
  assert.equal(h.events.ofType("fpi.reminder.sent")[0]!.payload.template, MS3B);
  // Bus tool: the variant is deterministic from the evidence rows — the model cannot override it (guardrail DETERMINISTIC_VARIANT).
  const t = tool93("selectReminderVariant");
  assert.deepEqual(await t.handler({ evidence: [], lapse_start: "2026-10-01", as_of: "2026-11-04" }, toolCtx(h), toolRt(h)), { variant: "b_no_info", gaps: [{ from: "2026-10-01", to: "2026-11-04" }] });
  assert.ok(t.guardrails!.find((g) => g.code === "DETERMINISTIC_VARIANT")!.refuse({ evidence: [], lapse_start: "2026-10-01", as_of: "2026-11-04", override_variant: "c_insufficient" }, toolCtx(h)));
  h.off();
});
test("9.3-T3: Given a dec page received 2026-10-20 effective 2026-10-15 When rendered Then MS-3(C) with [Date Range] 2026-10-01 to 2026-10-14.", async () => {
  const rows = [{ received_on: D("2026-10-20"), effective: D("2026-10-15"), expiration: null, written: true }];
  const cv = reminderVariant(rows, D("2026-10-01"), D("2026-11-04"));
  assert.equal(cv.variant, "c_insufficient"); assert.deepEqual(cv.gaps, [{ from: "2026-10-01", to: "2026-10-14" }]);
  const h = harness(); const c = firstNoticeSent(h);
  // Information received (a dec page) but no evidence of continuous coverage from the lapse: MS-3(C) with the unverified period 10/01–10/14.
  const comp = composeReminder(h.svc, h.events, { case_id: c.case_id, evidence: rows, facts: { ...FACTS, notice_date: D("2026-11-04") }, produced_on: D("2026-11-04"), quote: RATE_TABLE });
  assert.equal(comp.variant, "c_insufficient"); assert.equal(comp.template, MS3C); assert.deepEqual(comp.gaps, [{ from: "2026-10-01", to: "2026-10-14" }]);
  assert.deepEqual(comp.payload.unverified_ranges, [{ start: "2026-10-01", end: "2026-10-14" }]);
  const produced = h.events.ofType("fpi.reminder.produced")[0]!; assert.equal(produced.payload.variant, "c_insufficient"); assert.deepEqual(produced.payload.unverified_ranges, [{ start: "2026-10-01", end: "2026-10-14" }]); assert.equal(produced.payload.written_evidence_rows, 1);
  const v = version(MS3C);
  const r = render(v.source, comp.payload);
  assert.match(r.text, /unable to verify that you had hazard insurance on the property listed above for the following period\(s\): October 1, 2026 to October 14, 2026/);
  assert.equal(evaluateChecklist(asVersion(v), comp.payload, r).passed, true);
  assert.deepEqual(boldItemsPresent(r.blocks, [/second and final notice/i, /will cost \$2,190\.00 annually/, /immediately provide us with your insurance information/i, /may cost significantly more/i]), { ok: true, missing: [] });
  assert.match(r.text, /We received the insurance information you provided/); assert.match(r.text, /charged for insurance we purchased for any period during which we cannot verify/);
  assert.equal(noticeChecklist(r.blocks.map((b) => ({ id: b.id, text: b.text })), "reminder").ok, true);
  // Mailed as the MS-3(C): the proof of mailing carries the variant into `fpi.reminder.sent` and the case.
  h.clock.set("2026-11-04T14:00:00.000Z");
  const n = h.notices.render({ templateCode: MS3C, loanId: WORKED.loan_id, recipients: RECIPIENTS, payload: comp.payload, asOf: D("2026-11-04") });
  await h.notices.send(n.id); h.notices.recordMailed(n.id, 1, "2026-11-04T18:00:00.000Z", "POM-c");
  const sent = h.events.ofType("fpi.reminder.sent")[0]!; assert.equal(sent.payload.template, MS3C); assert.equal(sent.payload.variant, "c_insufficient"); assert.equal(h.svc.get(c.case_id).reminder_variant, "c_insufficient");
  // An oral-only statement (no written follow-up) is recorded but is not "information" for the variant (rule 1; open decision 9.3-Q1 default).
  assert.equal(reminderVariant([{ ...rows[0]!, written: false }], D("2026-10-01"), D("2026-11-04")).variant, "b_no_info");
  h.off();
});
test("9.3-T4: Given production 2026-10-30 (Fri) and mailing 2026-11-09 (Mon; 6 federal business days later) Then regeneration required; mailing 2026-11-06 allowed.", async () => {
  assert.equal(productionWindowOk(D("2026-10-30"), D("2026-11-09")), false); assert.equal(productionWindowOk(D("2026-10-30"), D("2026-11-06")), true);
  assert.deepEqual(reminderProductionCheck(D("2026-10-30"), D("2026-11-09")), { ok: false, mail_by: "2026-11-06", federal_business_days: 6 });
  assert.deepEqual(reminderProductionCheck(D("2026-10-30"), D("2026-11-06")), { ok: true, mail_by: "2026-11-06", federal_business_days: 5 });
  // Through the Notice Registry: production Fri 10/30 arms REGX_1024_37D5_NOTICE_PRODUCTION_5BD (mail by Fri 11/06); the 11/09 proof of mailing is late → the stale piece is refused and regenerated.
  const h = harness(); const c = firstNoticeSent(h);
  const stale = await produce(h, c.case_id, "2026-10-30T14:00:00.000Z");
  assert.equal(stale.comp.event.payload.mail_by, "2026-11-06");
  const prod = h.inst("REGX_1024_37D5_NOTICE_PRODUCTION_5BD")!; assert.equal(prod.anchorDate, "2026-10-30"); assert.equal(prod.dueDate, "2026-11-06"); assert.equal(prod.status, "armed");
  assert.ok(eventMatches(REG.get("REGX_1024_37D5_NOTICE_PRODUCTION_5BD")!.triggerPattern!, h.events.ofType("notice.production").at(-1) as DomainEvent));
  h.clock.set("2026-11-09T14:00:00.000Z");
  const breaches = h.timers.evaluate("2026-11-09T14:00:00.000Z"); assert.ok(breaches.some((b) => b.instance.id === prod.id && /regenerate/i.test(b.breachText)));   // breach action: regenerate
  stale.mail("2026-11-09T14:00:00.000Z");
  assert.equal(prod.status, "satisfied_late");
  const rejected = h.events.ofType("fpi.inbound.rejected"); assert.equal(rejected.length, 1);
  assert.match(String(rejected[0]!.payload.reason), /REGX_1024_37D5_NOTICE_PRODUCTION_5BD: reminder produced 2026-10-30 and mailed 2026-11-09 — more than 5 federal business days; regenerate/);
  assert.equal(h.events.ofType("fpi.reminder.sent").length, 0); assert.equal(h.svc.get(c.case_id).status, "first_notice_sent");
  // Regenerated 11/09 with current evidence (re-selects the variant) and mailed the same day: mail-by Tue 11/17 (Veterans Day 11/11 skipped), satisfied on time, t1 = 11/09.
  const fresh = await produce(h, c.case_id, "2026-11-09T15:00:00.000Z", [], { previous_notice_id: stale.notice.id, reason: "REGX_1024_37D5_NOTICE_PRODUCTION_5BD" });
  const regen = h.events.ofType("fpi.reminder.regenerated"); assert.equal(regen.length, 1); assert.equal(regen[0]!.payload.previous_notice_id, stale.notice.id); assert.equal(regen[0]!.payload.mail_by, "2026-11-17");
  const prod2 = h.inst("REGX_1024_37D5_NOTICE_PRODUCTION_5BD")!; assert.notEqual(prod2.id, prod.id); assert.equal(prod2.anchorDate, "2026-11-09"); assert.equal(prod2.dueDate, "2026-11-17");
  fresh.mail("2026-11-09T16:00:00.000Z");
  assert.equal(prod2.status, "satisfied"); assert.ok(eventMatches(REG.get("REGX_1024_37D5_NOTICE_PRODUCTION_5BD")!.satisfiedPattern!, h.events.ofType("notice.mailed").at(-1) as DomainEvent));
  const sent = h.events.ofType("fpi.reminder.sent"); assert.equal(sent.length, 1); assert.equal(sent[0]!.payload.produced_at, "2026-11-09"); assert.equal(sent[0]!.payload.reminder_mailed_at, "2026-11-09"); assert.equal(sent[0]!.payload.earliest_charge_date, "2026-11-24");
  h.off();
  // Mailing 2026-11-06 (5 federal business days after production) is allowed: the row is satisfied on time and the 10/30 render mails as-is.
  const h2 = harness(); const c2 = firstNoticeSent(h2);
  const okPiece = await produce(h2, c2.case_id, "2026-10-30T14:00:00.000Z"); okPiece.mail("2026-11-06T14:00:00.000Z");
  const row = h2.inst("REGX_1024_37D5_NOTICE_PRODUCTION_5BD")!; assert.equal(row.dueDate, "2026-11-06"); assert.equal(row.status, "satisfied");
  assert.equal(h2.events.ofType("fpi.inbound.rejected").length, 0);
  const sent2 = h2.events.ofType("fpi.reminder.sent")[0]!; assert.equal(sent2.payload.produced_at, "2026-10-30"); assert.equal(sent2.payload.reminder_mailed_at, "2026-11-06"); assert.equal(sent2.payload.earliest_charge_date, "2026-11-21");   // max(t0+45 = 11/19, t1+15 = 11/21)
  assert.equal(h2.svc.get(c2.case_id).reminder_mailed_at, "2026-11-06");
  h2.off();
});
test("9.3-T5: Given reminder mailed 2026-11-07 Then `earliest_charge_date` = 2026-11-22.", () => {
  assert.equal(fpiClocks(D("2026-10-05"), D("2026-11-07")).earliest_charge, "2026-11-22");            // t1 + 15 > t0 + 45
  assert.equal(fpiClocks(D("2026-10-05"), D("2026-11-04")).earliest_charge, "2026-11-19");
  const h = harness(); const c = firstNoticeSent(h);
  h.clock.set("2026-11-07T14:00:00.000Z");
  const clocks = h.svc.recordReminderMailed({ ...mailed(c.case_id, "n-ms3b", D("2026-11-07"), D("2026-11-04")), variant: "b_no_info" });
  assert.equal(clocks.earliest_charge, "2026-11-22"); assert.equal(clocks.evidence_window_end, "2026-11-22"); assert.equal(h.svc.get(c.case_id).earliest_charge_date, "2026-11-22");
  const sent = h.events.ofType("fpi.reminder.sent")[0]!; assert.equal(sent.payload.reminder_mailed_at, "2026-11-07"); assert.equal(sent.payload.earliest_charge_date, "2026-11-22");
  // t1 = Sat 11/07 (calendar days): the 15-day charge gate opens 11/22 and the evidence window ends 11/22; 11/07 is inside the 30–35 policy window (satisfied, not late).
  const g15 = h.inst("REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15")!, ew = h.inst("REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15")!, g45 = h.inst("REGX_1024_37C_FPI_FIRST_NOTICE_45")!;
  assert.equal(g15.anchorDate, "2026-11-07"); assert.equal(g15.dueDate, "2026-11-22"); assert.equal(ew.anchorDate, "2026-11-07"); assert.equal(ew.dueDate, "2026-11-22"); assert.equal(g45.dueDate, "2026-11-19");
  assert.equal(h.inst("INS_FPI_REMINDER_TARGET_30_35")!.status, "satisfied"); assert.equal(h.inst("REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30")!.status, "satisfied");
  assert.ok(eventMatches(REG.get("REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15")!.triggerPattern!, sent as DomainEvent));
  // 11/21: the 45-day gate is open but the reminder's 15-day gate is not — charge refused; 11/22 allowed.
  const early = h.svc.chargeAllowed(c.case_id, D("2026-11-21")); assert.equal(early.allowed, false); assert.match((early as { reason: string }).reason, /open until 2026-11-22/);
  assert.equal(h.svc.chargeAllowed(c.case_id, D("2026-11-22")).allowed, true);
  // Window end: the evaluation the 15-day row waits for (no evidence → chargeable) and the charge that closes the 15-day gate.
  h.clock.set("2026-11-22T14:00:00.000Z");
  const ev = h.svc.evaluateEvidenceWindow(c.case_id, D("2026-11-22")); assert.equal(ev.outcome, "no_evidence"); assert.equal(ev.chargeable, true); assert.equal(ev.window_end, "2026-11-22");
  assert.equal(ew.status, "satisfied"); assert.ok(eventMatches(REG.get("REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15")!.satisfiedPattern!, h.events.ofType("fpi.evidence_window.evaluated")[0] as DomainEvent));
  const req = h.svc.requestPlacement(c.case_id, D("2026-11-22"), COVER, VENDOR, { carrier_quote_cents: null, table_rate_pct: "0.876", rate_table_version: "TX-2026-Q4" });
  h.svc.recordLpiBound({ request_id: req.request_id, policy_number: "LPI-TX-0093", premium_cents: 219_000n, effective: D("2026-10-01") });
  assert.equal(g15.status, "armed"); assert.equal(g45.status, "armed");
  const charge = h.svc.assessCharge(c.case_id, D("2026-11-22"));
  assert.equal(charge.event.payload.earliest_charge_date, "2026-11-22"); assert.equal(charge.charge.amount_cents, 219_000n);
  assert.equal(g15.status, "satisfied"); assert.equal(g45.status, "satisfied"); assert.ok(eventMatches(REG.get("REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15")!.satisfiedPattern!, charge.event));
  h.off();
});
test('9.3-T6: Given the quote API fails Then estimate from rate table, flagged "estimated," basis stored.', async () => {
  const q = premiumQuote(null, 25000000n, "0.876");
  assert.equal(q.annual_premium_cents, 219000n); assert.equal(q.is_estimate, true); assert.equal(q.basis, "rate_table 0.876%");
  const real = premiumQuote(221500n, 25000000n, "0.876");
  assert.equal(real.annual_premium_cents, 221500n); assert.equal(real.is_estimate, false); assert.equal(real.basis, "carrier_quote");
  // The reminder job with no carrier quote: the rate-table figure is flagged as an estimate and the basis (rate-table version, coverage, tier, occupancy, state, delinquency status) is stored on `fpi_cases` and the decision event.
  const h = harness(); const c = firstNoticeSent(h);
  const comp = composeReminder(h.svc, h.events, { case_id: c.case_id, evidence: [], facts: { ...FACTS, notice_date: D("2026-11-04") }, produced_on: D("2026-11-04"), quote: { ...RATE_TABLE, delinquency_status: "current" } });
  assert.equal(comp.quote.is_estimate, true); assert.equal(comp.quote.annual_premium_cents, 219_000n);
  assert.equal(comp.estimate_basis, "rate_table 0.876%; version=TX-2026-Q4; coverage_cents=25000000; deductible_cents=200000; occupancy=occupied; state=TX; delinquency=current");
  const cc = h.svc.get(c.case_id); assert.equal(cc.annual_premium_cents, 219_000n); assert.equal(cc.premium_is_estimate, true); assert.equal(cc.estimate_basis, comp.estimate_basis);
  const produced = h.events.ofType("fpi.reminder.produced")[0]!; assert.equal(produced.payload.premium_is_estimate, true); assert.equal(produced.payload.estimate_basis, comp.estimate_basis); assert.equal(produced.payload.cost_traced_to, "rate_table:TX-2026-Q4");
  assert.equal(comp.payload.premium_is_estimate, true); assert.equal(comp.payload.estimate_basis_present, true);
  const r = render(version(MS3B).source, comp.payload); assert.match(r.text, /\(an estimate\)/);      // (d)(2)(i)(D): "identified as such"
  // A carrier quote is the figure itself — no estimate flag, no basis, traced to the quote.
  const h2 = harness(); const c2 = firstNoticeSent(h2);
  const quoted = composeReminder(h2.svc, h2.events, { case_id: c2.case_id, evidence: [], facts: { ...FACTS, notice_date: D("2026-11-04") }, produced_on: D("2026-11-04"), quote: { ...RATE_TABLE, carrier_quote_cents: 221_500n, quote_id: "Q-93" } });
  assert.equal(quoted.quote.is_estimate, false); assert.equal(quoted.quote.annual_premium_cents, 221_500n); assert.equal(quoted.estimate_basis, null); assert.equal(h2.svc.get(c2.case_id).premium_is_estimate, false);
  assert.equal(h2.events.ofType("fpi.reminder.produced")[0]!.payload.cost_traced_to, "carrier_quote:Q-93");
  assert.equal(estimateBasis(quoted.quote, { coverage_cents: 25_000_000n }), null);
  // Escalation: a quote unavailable for > 2 business days → `officer` (the charge date slips); the 1-business-day vendor SLA breach alone does not.
  assert.equal(quoteEscalation(D("2026-10-30"), D("2026-11-03"), false), "none");     // Fri → Tue = 2 business days
  assert.equal(quoteEscalation(D("2026-10-30"), D("2026-11-04"), false), "officer");  // 3 business days without a quote
  assert.equal(quoteEscalation(D("2026-10-30"), D("2026-11-04"), true), "none");
  // Bus tool quoteLpi: the same figure, traced to the rate-table record; a hand-entered premium is refused (COST_TRACES_TO_RECORD).
  const t = tool93("quoteLpi");
  const out = (await t.handler({ coverage_cents: 25_000_000n, carrier_quote_cents: null, table_rate_pct: "0.876", rate_table_version: "TX-2026-Q4" }, toolCtx(h), toolRt(h))) as { annual_premium_cents: bigint; is_estimate: boolean; traced_to: string };
  assert.equal(out.annual_premium_cents, 219_000n); assert.equal(out.is_estimate, true); assert.equal(out.traced_to, "rate_table:TX-2026-Q4");
  assert.ok(t.guardrails!.find((g) => g.code === "COST_TRACES_TO_RECORD")!.refuse({ coverage_cents: 25_000_000n, manual_figure: true, annual_premium_cents: 200_000n }, toolCtx(h)));
  h.off(); h2.off();
});

test("9.3 rule 2: $250,000 coverage × 0.876% = $2,190.00 (round-half-up at the end)", () => { assert.equal(premiumFromRate(25000000n, "0.876"), 219000n); });
test("9.3 edge case: case closed by payoff before mailing cancels the produced reminder and its gates", () => {
  const h = harness(); const c = firstNoticeSent(h);
  composeReminder(h.svc, h.events, { case_id: c.case_id, evidence: [], facts: { ...FACTS, notice_date: D("2026-11-04") }, produced_on: D("2026-11-04"), quote: RATE_TABLE });
  h.events.append({ type: "loan.paid_in_full", loanId: WORKED.loan_id, actor: SYSTEM, payload: { paid_on: "2026-11-03" } });
  assert.equal(h.svc.get(c.case_id).status, "closed_paid_off");
  const cancelled = h.events.ofType("fpi.reminder.cancelled"); assert.equal(cancelled.length, 1); assert.equal(cancelled[0]!.payload.reason, "paid_off"); assert.equal(cancelled[0]!.payload.produced_renders, 1);
  assert.equal(h.inst("REGX_1024_37D_FPI_REMINDER_NOT_BEFORE_30")!.status, "cancelled");
  assert.throws(() => composeReminder(h.svc, h.events, { case_id: c.case_id, evidence: [], facts: { ...FACTS, notice_date: D("2026-11-04") }, produced_on: D("2026-11-04"), quote: RATE_TABLE }), /closed_paid_off/);
  h.off();
});
