/**
 * Notice Registry tests: catalog coverage, publish gating (7.1 acceptance),
 * rendering + checklists against the spec's worked examples, channel
 * decisions (7.4-T3/T4/T9/T10), the production window (9.2 §1024.37(d)(5)),
 * envelope planning (7.3 separate document) and superseding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegistry, publishAuthored, AUTHORED_VERSIONS, loadCatalog } from "./catalog.ts";
import { NoticeRegistry, TemplateNotPublishable } from "./registry.ts";
import { render, money, longDate } from "./render.ts";
import { evaluateChecklist, publishCheck } from "./checklist.ts";
import { decideChannel, planEnvelopes } from "./channel.ts";
import { NoticeService, NoticeHeld } from "./service.ts";
import { MemoryEventStore, FixedClock } from "../kernel/events/index.ts";
import { FakePrintMail, FakeEdelivery } from "../infra/integrations/delivery.ts";
import { plainDate as D } from "../kernel/calendar/date.ts";
import type { Consent } from "../domain/notices/esign.ts";

const consent = (partyId: string, classes: string[], status: Consent["status"] = "active"): Consent => ({ party_id: partyId, classes, disclosure_version: "1.3", status, consented_on: D("2026-10-02"), soft_bounces_30d: 0 });

test("catalog: every NTC_/INS_ code the spec names is registered with an owner section, class and channel policy", () => {
  const reg = buildRegistry();
  const cat = loadCatalog();
  assert.equal(reg.all().length, cat.length);
  assert.ok(cat.length >= 248, `spec names ${cat.length} notice codes`);
  const t = reg.template("NTC_REGZ_20D_ARM_INITIAL");
  assert.equal(t.separateDocument, true); assert.equal(t.noticeClass, "arm_notices"); assert.equal(t.ownerSection, "7.3");
  assert.equal(reg.template("NTC_REGX_39C_EARLY_INTERVENTION_BK").channelPolicy, "mail_only");
  assert.equal(reg.template("NTC_REGZ_41_STMT_STD").noticeClass, "periodic_statements");
  assert.ok(reg.bySection("12.1").length >= 5);
  for (const t of reg.all()) { assert.ok(t.citation.length > 0, t.code); assert.ok(["esign_or_mail", "mail_only", "electronic_ok_without_esign"].includes(t.channelPolicy)); }
});

test("publish gate: every authored version passes its own checklist; a version with a failing block rule cannot be published; approved versions are immutable", () => {
  const reg = buildRegistry();
  for (const v of AUTHORED_VERSIONS) assert.deepEqual(publishCheck(reg.versionsOf(v.templateCode)[0]!), [], v.templateCode);
  publishAuthored(reg);
  assert.equal(reg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-10-17"))?.plainLanguageStatus, "counsel_approved");
  assert.equal(reg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-08-01")), undefined, "not in effect before effectiveFrom");
  const bad = reg.draft({ templateCode: "NTC_REGZ_41_STMT_STD", version: "1.0.1", effectiveFrom: D("2026-09-01"), source: "Amount due {{money amount_due_cents}}", contentRules: reg.versionsOf("NTC_REGZ_41_STMT_STD")[0]!.contentRules, layoutRules: [], samplePayload: { amount_due_cents: 1n }, ruleSet: "regz.periodic_statement.2018" });
  assert.throws(() => reg.publish(bad.templateCode, bad.version, "counsel", "2026-09-02T00:00:00.000Z", publishCheck), TemplateNotPublishable);
  assert.throws(() => reg.draft({ ...bad }), /immutable/);
  const r = new NoticeRegistry();
  assert.throws(() => r.template("NTC_NOPE"), /unknown notice template/);
});

test("renderer: helpers, conditionals, each, blocks; payload hash is canonical", () => {
  assert.equal(money(907_379n), "$9,073.79"); assert.equal(money(-5n), "-$0.05"); assert.equal(longDate("2026-10-17"), "October 17, 2026");
  const r = render(`{{#block "b" page=2 y=0.5 pt=12 bold}}Hi {{name}}{{#if vip}} (VIP){{else}} (std){{/if}} {{#each items}}{{@index}}:{{this}} {{/each}}{{money cents}}{{/block}}{{#unless vip}}no-vip{{/unless}}`, { name: "A<B", vip: false, items: ["x", "y"], cents: 123n });
  assert.equal(r.text, "Hi A<B (std) 0:x 1:y $1.23 no-vip");
  assert.deepEqual(r.blocks.map((b) => [b.id, b.page, b.yFraction, b.pt, b.bold]), [["b", 2, 0.5, 12, true]]);
  assert.ok(r.html.includes("A&lt;B"));
  assert.equal(render("x", { b: 1n, a: [1, 2] }).payloadHash, render("y", { a: [1, 2], b: "1" }).payloadHash, "key order and bigint/string cents hash the same");
});

test("7.1 worked example: the Nov 1 delinquent statement carries the (d)(8) box, reminder panel and (d)(5) suspense text; the standard statement omits the box; a late-fee line missing is a block", () => {
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-10-17"))!;
  const payload = { ...v.samplePayload };
  const r = render(v.source, payload);
  assert.match(r.text, /Amount due \$9,073\.79 — payment due date November 1, 2026/);
  assert.match(r.text, /If payment is received after November 16, 2026, a late fee of \$116\.71 will be charged/);
  assert.match(r.text, /you are 46 days delinquent; your first unpaid payment was due September 1, 2026/);
  assert.match(r.text, /Amount to bring the loan current: \$6,127\.00/);
  assert.match(r.text, /We need \$1,446\.79 more to apply a full payment/);
  assert.match(r.text, /we want to work with you to preserve homeownership/);
  const c = evaluateChecklist(v, payload, r);
  assert.equal(c.passed, true); assert.deepEqual(c.warnings, []);
  // 46 days delinquent but the delinquency block missing → d8 blocks
  const noBox = { ...payload, delinquency: null };
  const c2 = evaluateChecklist(v, noBox, render(v.source, noBox));
  assert.deepEqual(c2.blocking.map((b) => b.rule_id), ["d8-delinquency", "d8-delinquency-layout"]);
  // amount due must tie to the computation (rule 2)
  const off = { ...payload, amount_due_cents: 907_380n };
  assert.ok(evaluateChecklist(v, off, render(v.source, off)).blocking.some((b) => b.rule_id === "amount-due-ties"));
  const std = reg.activeVersion("NTC_REGZ_41_STMT_STD", D("2026-09-17"))!;
  const rs = render(std.source, std.samplePayload);
  assert.doesNotMatch(rs.text, /days delinquent/);
  assert.equal(evaluateChecklist(std, std.samplePayload, rs).passed, true);
});

test("9.2 first force-placed notice: (c)(2)(i)–(xi) present, bold items, 'will purchase' not 'we bought', nothing else on the pages", () => {
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("INS_FPI_FIRST_MS3A", D("2026-10-05"))!;
  const ok = evaluateChecklist(v, v.samplePayload, render(v.source, v.samplePayload));
  assert.equal(ok.passed, true);
  const bought = { ...v.samplePayload, status_phrase: "expired and we bought coverage" };
  assert.ok(evaluateChecklist(v, bought, render(v.source, bought)).blocking.some((b) => b.rule_id === "no-bought-yet"));
  const noEstimate = { ...v.samplePayload, estimated_annual_premium_cents: null };
  assert.ok(evaluateChecklist(v, noEstimate, render(v.source, noEstimate)).blocking.some((b) => b.rule_id === "c2-ix-estimate"));
  const wrongType = { ...v.samplePayload, insurance_type: "umbrella" };
  assert.ok(evaluateChecklist(v, wrongType, render(v.source, wrongType)).blocking.some((b) => b.rule_id === "c2-xi-type"));
});

test("11.2 early-intervention notice: five items on page 1 at 12-pt; FDCPA/bk variants may not carry an amount due; DC loans need the §1006.18(e) disclosure", () => {
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGX_39B_EARLY_INTERVENTION", D("2026-12-14"))!;
  assert.equal(evaluateChecklist(v, v.samplePayload, render(v.source, v.samplePayload)).passed, true);
  const fdcpa = { ...v.samplePayload, variant: "fdcpa", amount_due_cents: 589_358n };
  assert.ok(evaluateChecklist(v, fdcpa, render(v.source, fdcpa)).blocking.some((b) => b.rule_id === "fdcpa-no-amount"));
  const dc = { ...v.samplePayload, fdcpa_debt_collector: true };
  assert.ok(evaluateChecklist(v, dc, render(v.source, dc)).blocking.some((b) => b.rule_id === "fdcpa-disclosure"));
  const dcOk = { ...dc, fdcpa_disclosure: "This communication is from a debt collector." };
  assert.equal(evaluateChecklist(v, dcOk, render(v.source, dcOk)).passed, true);
  const small = { ...v };
  const smallSrc = v.source.replace('{{#block "options" page=1 y=0.3 pt=12}}', '{{#block "options" page=1 y=0.3 pt=10}}');
  assert.ok(evaluateChecklist(small, v.samplePayload, render(smallSrc, v.samplePayload)).blocking.some((b) => b.rule_id === "min-12pt"));
});

test("7.3 ARM initial notice and 12.1 acknowledgment: content, timing-window and recency rules", () => {
  const reg = buildRegistry(); publishAuthored(reg);
  const arm = reg.activeVersion("NTC_REGZ_20D_ARM_INITIAL", D("2026-09-20"))!;
  const r = render(arm.source, arm.samplePayload);
  assert.match(r.text, /6\.375% \(estimated\)/); assert.match(r.text, /\$2,476\.44 \(estimated\)/); assert.match(r.text, /cannot increase or decrease by more than 2\.000%/);
  assert.equal(evaluateChecklist(arm, arm.samplePayload, r).passed, true);
  const late = { ...arm.samplePayload, days_before_first_payment: 200 };
  assert.ok(evaluateChecklist(arm, late, render(arm.source, late)).blocking.some((b) => b.rule_id === "timing-window"));
  const stale = { ...arm.samplePayload, index_age_business_days: 16 };
  assert.ok(evaluateChecklist(arm, stale, render(arm.source, stale)).blocking.some((b) => b.rule_id === "index-recency"));
  const ack = reg.activeVersion("NTC_REGX_41B2_ACK_INCOMPLETE", D("2026-09-15"))!;
  assert.equal(evaluateChecklist(ack, ack.samplePayload, render(ack.source, ack.samplePayload)).passed, true);
  const soon = { ...ack.samplePayload, days_to_reasonable_date: 5 };
  assert.ok(evaluateChecklist(ack, soon, render(ack.source, soon)).blocking.some((b) => b.rule_id === "reasonable-date"));
});

test("channel decision (7.4): T3 split parties — mail satisfies the timer; T9 1098 needs its own class; T10 state-mandated mail; suspect/reconsent consents mail; electronic_ok_without_esign emails", () => {
  const reg = buildRegistry();
  const stmt = reg.template("NTC_REGZ_41_STMT_STD");
  const A = { partyId: "A", name: "A", mailingAddress: "1 Test St", email: "a@x.com", consent: consent("A", ["periodic_statements", "regx_ei"]) };
  const B = { partyId: "B", name: "B", mailingAddress: "1 Test St" };
  const d = decideChannel(stmt, [A, B]);
  assert.deepEqual(d.map((x) => [x.partyId, x.channel, x.satisfiesTimer]), [["A", "email_link", false], ["B", "mail_first_class", true]]);
  assert.deepEqual(decideChannel(stmt, [A]).map((x) => [x.channel, x.satisfiesTimer]), [["email_link", true]]);
  const irs = reg.template("NTC_IRS_1098");
  assert.equal(decideChannel(irs, [A])[0]!.channel, "mail_first_class", "7.4-T9: periodic_statements consent does not cover irs_estatement");
  assert.equal(decideChannel(stmt, [A], { stateMandatedMail: true })[0]!.reason, "state-mandated mail (7.4-T10)");
  assert.equal(decideChannel(reg.template("NTC_REGX_39C_EARLY_INTERVENTION_BK"), [A])[0]!.reason, "template is mail_only");
  assert.equal(decideChannel(stmt, [{ ...A, consent: consent("A", ["periodic_statements"], "suspect") }])[0]!.channel, "mail_first_class");
  assert.equal(decideChannel(stmt, [{ ...A, consent: consent("A", ["periodic_statements"], "reconsent_required") }])[0]!.reason, "consent reconsent_required (7.4 rule 6)");
  assert.equal(decideChannel(reg.template("NTC_REGZ_36C3_PAYOFF_STMT"), [{ partyId: "A", name: "A", mailingAddress: "1 Test St", email: "a@x.com" }])[0]!.channel, "email_link");
  assert.equal(decideChannel(stmt, [{ ...B, mailingAddress: null }])[0]!.held, "address unknown");
  // envelopes: the (d) notice is its own PDF but may share the statement's envelope; unrelated notices get their own
  const env = planEnvelopes([{ noticeId: "n1", template: stmt, partyId: "A" }, { noticeId: "n2", template: reg.template("NTC_REGZ_20D_ARM_INITIAL"), partyId: "A" }, { noticeId: "n3", template: reg.template("INS_FPI_FIRST_MS3A"), partyId: "A" }]);
  assert.equal(env.length, 2);
  assert.deepEqual(env[0]!.items.map((i) => i.noticeId), ["n1", "n2"]); assert.deepEqual(env[0]!.separatePdfs, ["n2"]);
});

test("NoticeService: render→checklist→send with proof of mailing, production window event, bounce fallback to same-day mail (7.4-T4), held notices refuse to send, supersede", async () => {
  const reg = buildRegistry(); publishAuthored(reg);
  const clock = new FixedClock("2026-10-17T05:00:00.000Z");
  const events = new MemoryEventStore(clock);
  const pm = new FakePrintMail(); const ed = new FakeEdelivery(); ed.bouncing.add("a@x.com");
  const svc = new NoticeService({ registry: reg, events, clock, printMail: pm, edelivery: ed });
  const A = { partyId: "A", name: "A", mailingAddress: "1 Test St", email: "a@x.com", consent: consent("A", ["periodic_statements"]) };
  const B = { partyId: "B", name: "B", mailingAddress: "1 Test St" };
  const v = reg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-10-17"))!;
  const n = svc.render({ templateCode: "NTC_REGZ_41_STMT_DELQ", loanId: "L-1", recipients: [A, B], payload: v.samplePayload, asOf: D("2026-10-17") });
  assert.equal(n.status, "rendered");
  await svc.send(n.id);
  assert.equal(n.status, "sent");
  // A: email bounced → same-day mail fallback, consent suspect; B: mailed and satisfies the timer
  assert.deepEqual(n.deliveries.map((d) => [d.partyId, d.channel, d.emailStatus ?? null, d.fallbackOf ?? null, d.satisfiesTimer]), [["A", "email_link", "bounced", null, false], ["A", "mail_first_class", null, 1, true], ["B", "mail_first_class", null, null, true]]);
  assert.equal(A.consent.status, "suspect");
  const types = events.all().map((e) => e.type);
  assert.ok(types.includes("notice.bounced") && types.includes("notice.production") && types.includes("notice.sent"));
  const prod = events.ofType("notice.production")[0]!.payload as { mail_by: string };
  assert.equal(prod.mail_by, "2026-10-23", "5 federal business days from Sat Oct 17: Mon 19 … Fri 23 (§1024.37(d)(5), comment 37(d)(5)-1)");
  pm.runProduction("2026-10-19T13:00:00.000Z");
  svc.recordMailed(n.id, 3, "2026-10-19T13:00:00.000Z", "POM-1");
  assert.equal(n.status, "delivered");
  // held: block failure → cannot send
  const bad = svc.render({ templateCode: "NTC_REGZ_41_STMT_DELQ", loanId: "L-1", recipients: [B], payload: { ...v.samplePayload, delinquency: null }, asOf: D("2026-10-17") });
  assert.equal(bad.status, "held"); assert.match(bad.heldReason!, /d8-delinquency/);
  await assert.rejects(svc.send(bad.id), NoticeHeld);
  // supersede
  const fixed = svc.render({ templateCode: "NTC_REGZ_41_STMT_DELQ", loanId: "L-1", recipients: [B], payload: v.samplePayload, asOf: D("2026-10-17") });
  svc.supersede(bad.id, fixed.id);
  assert.equal(bad.status, "superseded"); assert.equal(bad.supersededBy, fixed.id);
  // returned mail
  svc.recordReturned(n.id, 3, "2026-10-28T00:00:00.000Z", "NIXIE");
  assert.equal(n.status, "returned"); assert.equal(events.ofType("notice.returned").length, 1);
});

test("channel esign_portal (DELTA-08): with an active E-SIGN consent for the class and a card instance for the party, the notice is card-delivered and the delivery evidence carries card_instance_id beside rendered_document_id; without a card the same consent e-mails; without consent it mails", async () => {
  const reg = buildRegistry(); publishAuthored(reg);
  const clock = new FixedClock("2026-10-17T05:00:00.000Z");
  const events = new MemoryEventStore(clock);
  const pm = new FakePrintMail(); const ed = new FakeEdelivery();
  const svc = new NoticeService({ registry: reg, events, clock, printMail: pm, edelivery: ed });
  const stmt = reg.template("NTC_REGZ_41_STMT_DELQ");
  const A = { partyId: "A", name: "A", mailingAddress: "1 Test St", email: "a@x.com", consent: consent("A", ["periodic_statements"]) };
  const B = { partyId: "B", name: "B", mailingAddress: "1 Test St", email: "b@x.com" };
  const cards = { A: "11111111-1111-4111-8111-111111111111" };
  assert.deepEqual(decideChannel(stmt, [A], { cardInstances: cards }).map((d) => [d.channel, d.cardInstanceId, d.satisfiesTimer]), [["esign_portal", cards.A, true]]);
  assert.equal(decideChannel(stmt, [A]).map((d) => d.channel)[0], "email_link", "no card → the e-mail link as before");
  assert.equal(decideChannel(stmt, [B], { cardInstances: { B: "x" } })[0]!.channel, "mail_first_class", "a card never bypasses the consent rule (7.4 rule 1)");
  const v = reg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-10-17"))!;
  const n = svc.render({ templateCode: "NTC_REGZ_41_STMT_DELQ", loanId: "L-1", recipients: [A, B], payload: v.samplePayload, asOf: D("2026-10-17"), renderedDocumentId: "22222222-2222-4222-8222-222222222222" });
  await svc.send(n.id, { cardInstances: cards });
  assert.deepEqual(n.deliveries.map((d) => [d.partyId, d.channel, d.vendor, d.cardInstanceId ?? null, d.renderedDocumentId ?? null, d.satisfiesTimer]),
    [["A", "esign_portal", "borrower-app", cards.A, "22222222-2222-4222-8222-222222222222", false], ["B", "mail_first_class", "print-mail", null, "22222222-2222-4222-8222-222222222222", true]]);
  const sent = events.ofType("notice.sent")[0]!.payload as { channels: { party_id: string; channel: string; card_instance_id?: string }[]; rendered_document_id: string };
  assert.deepEqual(sent.channels.find((c) => c.party_id === "A"), { party_id: "A", channel: "esign_portal", satisfies_timer: false, card_instance_id: cards.A });
  assert.equal(sent.rendered_document_id, "22222222-2222-4222-8222-222222222222");
  assert.equal([...ed.messages.values()].find((m) => m.message.noticeId === n.id)?.message.channel, "portal", "the availability message goes through the e-delivery port");
});
