// 10.4 Annual PMI disclosure
// spec/sections/10-pmi-administration/10-4-annual-pmi-disclosure.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { buildRegistry } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import type { Recipient } from "../../notices/channel.ts";
import { ltvBps, bpsToPercent } from "./cancellation.ts";
import { annualDisclosureApplies, disclosureTemplate, disclosurePlan, disclosureChannel } from "./disclosure.ts";
import { annualDisclosureCheck, disclosureTemplateCode, caStatementAttachment, disclosureSchedule, disclosureChannelAt, disclosureReleaseCheck, appendDisclosureRecord, type DisclosureRecord } from "./ops.ts";
import { runDisclosureSweep, validateMiPolicyRecord, HPA_ANNUAL, MN_ANNUAL, FIRST_60, COMPOSE_LEAD, CA_STATEMENT, type DisclosureDeps, type ComposeResult, type ReleaseResult, type SweepResult } from "./ops-10-4.ts";
import { harness, publishSection10, BORROWER, PMI_AGENT, type Harness } from "./spec-harness.ts";

/** The boarded MI policy record (Section 1.1 tape MI block; `pmi_last_annual_disclosure_on` reported by the transferor). */
const MI = (o: Record<string, unknown> = {}) => ({ policy_id: "MI-1", premium_plan: "bpmi_monthly", status: "active", state: "TX", consummation: "2024-04-15", hpa_covered: true, last_annual_disclosure_on: "2026-03-15", ...o });
/** Boarding with the MI block: the 10.4 ingestion hook validates it and appends `mi_policy.activated` (the clocks arm on that). */
const board = (h: Harness, mi: Record<string, unknown>, boarded_at = "2026-10-01"): void => {
  h.rt.store.put("loan_contacts", h.loanId, { recipients: BORROWER }, PMI_AGENT, h.clock.now());
  h.rt.store.put("mi_disclosure_merge", h.loanId, h.sample("NTC_HPA_4903A3_ANNUAL"), PMI_AGENT, h.clock.now());   // the last approved merge data (loan, fees, projections)
  h.raise("loan.boarded", { boarded_at, escrowed: true, mi });
};
const deps = (h: Harness): DisclosureDeps => ({ events: h.events, timers: h.timers, store: h.rt.store, clock: h.clock, notices: h.notices, escalations: h.escalations });
const sentEvents = (h: Harness) => h.events.byLoan(h.loanId).filter((e) => e.type === "mi.disclosure.sent");
const noticeSent = (h: Harness, template: string) => h.events.byLoan(h.loanId).filter((e) => e.type === "notice.sent" && e.payload.template === template);

test("10.4-T1: Given the worked boarding (last sent 2026-03-15, escrow statement 2027-02-20), then the PMI page is attached to the 2027-02-20 statement, `mi_disclosures.included_with='escrow_statement'`, and `next_annual_disclosure_due=2028-02-20`.", async () => {
  const p = disclosurePlan({ last_sent: D("2026-03-15"), boarded_on: D("2026-10-01"), escrow_statement_on: D("2027-02-20"), form_1098_on: D("2027-01-25") });
  assert.deepEqual(p, { next_due: D("2027-03-15"), send_on: D("2027-02-20"), included_with: "escrow_statement" });
  const s = disclosureSchedule({ plan: "bpmi_monthly", status: "active", lpmi_equiv_termination_date: null, last_sent: D("2026-03-15"), boarded_on: D("2026-10-01"), escrow_statement_on: D("2027-02-20") });
  assert.deepEqual(s.annual_timer, { code: "HPA_4903A3_ANNUAL_DISCLOSURE_12M", due: D("2027-03-15"), send_on: D("2027-02-20"), included_with: "escrow_statement" });
  // sent with the statement on 2027-02-20 → the cycle re-anchors: next due 2028-02-20 (2028 is a leap year; Feb. 29 falls after the span, so 12 months = 365 days)
  assert.equal(disclosurePlan({ last_sent: D("2027-02-20"), boarded_on: D("2026-10-01"), escrow_statement_on: null, form_1098_on: null }).next_due, D("2028-02-20"));
  assert.equal(disclosurePlan({ last_sent: D("2027-03-01"), boarded_on: D("2026-10-01"), escrow_statement_on: null, form_1098_on: null }).next_due, D("2028-02-29"), "R2: never more than 365 days — 12 months across Feb. 29, 2028 would be 366");
  // an escrow statement outside the window → standalone at next_due − 15
  const standalone = disclosurePlan({ last_sent: D("2026-03-15"), boarded_on: D("2026-10-01"), escrow_statement_on: D("2027-04-05"), form_1098_on: null });
  assert.deepEqual([standalone.included_with, standalone.send_on], ["standalone", D("2027-02-28")]);
  assert.equal(annualDisclosureApplies("lpmi", "active"), false); assert.equal(disclosureTemplate(D("1998-11-15")), "annual_b_legacy"); assert.equal(disclosureChannel(false), "mail");

  // On the bus: boarding 2026-10-01 with the transferor's last-sent date arms the 12-month clock on 2026-03-15 → due 2027-03-15.
  const h = harness("2026-10-01T15:00:00.000Z", "L-41", ["10.4"]);
  board(h, MI());
  const act = h.events.byLoan("L-41").find((e) => e.type === "mi_policy.activated")!;
  assert.deepEqual([act.payload.annual_disclosure, act.payload.disclosure_anchor_on, act.payload.next_annual_disclosure_due, act.payload.template], [true, "2026-03-15", D("2027-03-15"), "NTC_HPA_4903A3_ANNUAL"]);
  const cycle1 = h.latest(HPA_ANNUAL);
  assert.deepEqual([cycle1.status, cycle1.anchorDate, cycle1.dueDate], ["armed", D("2026-03-15"), D("2027-03-15")]);
  assert.equal(h.timer(FIRST_60).length, 0, "the last-sent date is known: no 60-day post-boarding clock"); assert.equal(h.timer(MN_ANNUAL).length, 0, "TX: no Minnesota override");
  // The scheduler at 70% elapsed (261 of 365 days on 2026-12-01 = 71%) queues composition 30 days before due (2027-02-13).
  h.clock.set("2026-12-01T15:00:00.000Z");
  const sw: SweepResult = await runDisclosureSweep(deps(h));
  assert.deepEqual(sw.approaching.map((a) => [a.loan_id, a.elapsed_pct, a.disclosure_due_on, a.compose_by]), [["L-41", 71, D("2027-03-15"), D("2027-02-13")]]);
  const lead = h.latest(COMPOSE_LEAD); assert.deepEqual([lead.status, lead.anchorDate, lead.dueDate], ["armed", D("2027-03-15"), D("2027-02-13")]);
  assert.equal((await runDisclosureSweep(deps(h))).approaching.length, 0, "the 70% mark is raised once per cycle");
  // Composition 2027-02-10 selects the carrier: the annual escrow statement 2027-02-20 lies in [2026-11-15, 2027-03-15].
  h.clock.set("2027-02-10T15:00:00.000Z");
  const c = (await h.run("10.4", "notices.compose/send", { op: "compose", loan_id: "L-41", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4903A3_ANNUAL"), notice_date: "2027-02-20" }, escrow_statement_on: "2027-02-20", form_1098_on: "2027-01-25", schedule_version_id: "sched-initial", projected_80_date: "2034-08-01", projected_78_date: "2035-07-01", projected_midpoint_date: "2039-05-01" })) as ComposeResult;
  assert.deepEqual([c.status, c.template, c.included_with, c.send_on, c.due_on], ["composed", "NTC_HPA_4903A3_ANNUAL", "escrow_statement", D("2027-02-20"), D("2027-03-15")]);
  assert.match(c.rendered.text, /the 78 percent date is July 1, 2035/);
  assert.equal(lead.status, "satisfied", "`mi.disclosure.composed` closes the compose-lead clock"); assert.equal(cycle1.status, "armed", "composition is not a send");
  const row = h.rt.store.get("mi_disclosures", c.disclosure_id!)!.data;
  assert.deepEqual([row.included_with, row.status, row.kind, row.projected_78_date, row.sent_at], ["escrow_statement", "composed", "annual_a3", "2035-07-01", null]);
  // Release rides the statement on 2027-02-20: `notice.sent{template=NTC_HPA_4903A3_ANNUAL}` closes the cycle and re-arms it from the send date.
  h.clock.set("2027-02-20T15:00:00.000Z");
  const r = (await h.run("10.4", "notices.compose/send", { op: "release", disclosure_id: c.disclosure_id })) as ReleaseResult;
  assert.deepEqual([r.status, r.included_with, r.sent_on, r.next_annual_disclosure_due, r.channel], ["sent", "escrow_statement", D("2027-02-20"), D("2028-02-20"), "mail_first_class"]);
  assert.equal(cycle1.status, "satisfied"); assert.equal(cycle1.satisfiedAt!.slice(0, 10), "2027-02-20");
  const cycle2 = h.latest(HPA_ANNUAL); assert.notEqual(cycle2.id, cycle1.id); assert.deepEqual([cycle2.status, cycle2.anchorDate, cycle2.dueDate], ["armed", D("2027-02-20"), D("2028-02-20")]);
  const policy = h.rt.store.get("mi_policies", "L-41")!.data; assert.deepEqual([policy.last_annual_disclosure_on, policy.next_annual_disclosure_due], [D("2027-02-20"), D("2028-02-20")]);
  assert.deepEqual([h.rt.store.get("mi_disclosures", c.disclosure_id!)!.data.included_with, h.rt.store.get("mi_disclosures", c.disclosure_id!)!.data.status], ["escrow_statement", "sent"]);
  assert.deepEqual(sentEvents(h).map((e) => [e.payload.included_with, e.payload.sent_on, e.payload.next_annual_disclosure_due]), [["escrow_statement", D("2027-02-20"), D("2028-02-20")]]);
  assert.equal(noticeSent(h, "NTC_HPA_4903A3_ANNUAL").length, 1);
});
test("10.4-T2: Given no disclosure sent by 2027-03-15 23:59, then `HPA_4903A3_ANNUAL_DISCLOSURE_12M` breaches, a standalone notice is auto-sent and an `officer` sev-2 escalation opens.", async () => {
  const r = annualDisclosureCheck({ due: D("2027-03-15"), sent_on: null, now: D("2027-03-16") });
  assert.equal(r.timer, "HPA_4903A3_ANNUAL_DISCLOSURE_12M"); assert.equal(r.status, "breached");
  assert.deepEqual(r.auto_send, { code: "NTC_HPA_4903A3_ANNUAL", included_with: "standalone" }); assert.deepEqual(r.escalation, { role: "officer", severity: 2 }); assert.equal(r.sentinel, true);
  assert.equal(annualDisclosureCheck({ due: D("2027-03-15"), sent_on: D("2027-02-20"), now: D("2027-03-16") }).status, "satisfied");

  // Through the engine: the clock armed on the transferor's 2026-03-15 date is due 2027-03-15 23:59 ET.
  const h = harness("2026-10-01T15:00:00.000Z", "L-42", ["10.4"]);
  board(h, MI());
  const cycle1 = h.latest(HPA_ANNUAL); assert.equal(cycle1.dueDate, D("2027-03-15"));
  h.clock.set("2027-03-15T20:00:00.000Z");   // 15:00 ET on the due date: not yet breached
  const early = await runDisclosureSweep(deps(h)); assert.equal(early.breaches.length, 0); assert.equal(cycle1.status, "armed"); assert.equal(sentEvents(h).length, 0);
  h.clock.set("2027-03-16T13:00:00.000Z");   // 08:00 ET the next day: breached — the scheduler auto-sends the standalone notice and opens the officer sev-2
  const sw = await runDisclosureSweep(deps(h));
  assert.equal(sw.breaches.length, 1); const b = sw.breaches[0]!;
  assert.deepEqual([b.code, b.loan_id, b.auto_sent, b.held_reason], [HPA_ANNUAL, "L-42", true, null]); assert.match(b.sentinel_line, /HPA_4903A3_ANNUAL_DISCLOSURE_12M breached: annual PMI disclosure due 2027-03-15 23:59 \(anchor 2026-03-15\) not sent; standalone disclosure auto-sent/);
  assert.equal(cycle1.status, "satisfied_late", "the late standalone send closes the breached instance");
  assert.deepEqual(sentEvents(h).map((e) => [e.payload.template, e.payload.included_with, e.payload.sent_on]), [["NTC_HPA_4903A3_ANNUAL", "standalone", D("2027-03-16")]]);
  const esc = h.escalations.opened.find((e) => e.id === b.escalation_id)!;
  assert.deepEqual([esc.kind, esc.ownerRole, esc.severity, esc.loanId, esc.slaTimerId, esc.payload.code, esc.payload.report, esc.payload.auto_sent], ["officer", "officer", "sev2", "L-42", cycle1.id, HPA_ANNUAL, "Compliance Sentinel daily report", true]);
  assert.equal(esc.payload.notice_id, b.notice_id); assert.ok(h.events.byLoan("L-42").some((e) => e.type === "timer.breached" && e.payload.code === HPA_ANNUAL));
  // The cycle re-arms from the late send: 2027-03-16 + 365 days = 2028-03-15 (12 months would be 2028-03-16 — 366 days across Feb. 29, 2028; the row's "365 calendar days max" governs).
  const cycle2 = h.latest(HPA_ANNUAL); assert.deepEqual([cycle2.status, cycle2.anchorDate, cycle2.dueDate], ["armed", D("2027-03-16"), D("2028-03-15")]);
});
test('10.4-T3: Given a pre-1999 loan, then the legacy template is used and the checklist verifies the "with the consent of the mortgagee or in accordance with applicable State law" sentence.', async () => {
  assert.equal(disclosureTemplateCode({ plan: "bpmi_monthly", consummation: D("1998-11-15"), hpa_covered: true, state: "TX" }), "NTC_HPA_4903B_ANNUAL_LEGACY");
  const reg = publishSection10(buildRegistry());
  const v = reg.activeVersion("NTC_HPA_4903B_ANNUAL_LEGACY", D("2027-02-20"))!;
  const rendered = render(v.source, v.samplePayload);
  const rule = v.contentRules.find((r) => r.rule_id === "legacy-sentence")!;
  assert.match(rule.selector, /with the consent of the mortgagee or in accordance with applicable State law/);
  assert.ok(rendered.text.includes("with the consent of the mortgagee or in accordance with applicable State law"));
  assert.equal(evaluateChecklist(v, v.samplePayload, rendered).passed, true);
  // On the bus: a loan consummated 1998-11-15 is activated with the legacy template; composition renders it and the checklist passes.
  const h = harness("2026-10-01T15:00:00.000Z", "L-43", ["10.4"]);
  board(h, MI({ consummation: "1998-11-15" }));
  assert.equal(h.events.byLoan("L-43").find((e) => e.type === "mi_policy.activated")!.payload.template, "NTC_HPA_4903B_ANNUAL_LEGACY");
  h.clock.set("2027-02-20T15:00:00.000Z");
  const r = (await h.run("10.4", "notices.compose/send", { loan_id: "L-43", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4903B_ANNUAL_LEGACY"), notice_date: "2027-02-20" } })) as ReleaseResult;
  assert.deepEqual([r.status, r.template], ["sent", "NTC_HPA_4903B_ANNUAL_LEGACY"]);
  assert.ok(r.rendered.text.includes("with the consent of the mortgagee or in accordance with applicable State law"));
  assert.equal(h.notices.get(r.notice_id).checklist.passed, true); assert.equal(h.rt.store.get("mi_disclosures", r.disclosure_id)!.data.kind, "annual_b_legacy");
  assert.equal(h.latest(HPA_ANNUAL).anchorDate, D("2027-02-20"), "the legacy variant satisfies and re-arms the 12-month clock");
});
test("10.4-T4: Given an LPMI loan, then no annual disclosure is scheduled and the `HPA_4905C2_LPMI_OPTIONS_NOTICE_30` timer exists instead.", async () => {
  const r = disclosureSchedule({ plan: "lpmi", status: "active", lpmi_equiv_termination_date: D("2035-07-01"), last_sent: null, boarded_on: D("2026-10-01") });
  assert.equal(r.annual_timer, null); assert.deepEqual(r.timers, [{ code: "HPA_4905C2_LPMI_OPTIONS_NOTICE_30", due: D("2035-07-31") }]);
  assert.equal(disclosureTemplateCode({ plan: "lpmi", consummation: D("2024-04-15"), hpa_covered: true, state: "TX" }), null);
  const b = disclosureSchedule({ plan: "bpmi_monthly", status: "active", lpmi_equiv_termination_date: null, last_sent: D("2026-03-15"), boarded_on: D("2026-10-01"), escrow_statement_on: D("2027-02-20") });
  assert.equal(b.annual_timer!.code, "HPA_4903A3_ANNUAL_DISCLOSURE_12M"); assert.equal(b.annual_timer!.due, D("2027-03-15"));
  // On the bus: an LPMI policy activates with `annual_disclosure=false` — none of the 10.4 clocks arm (12 U.S.C. 4905(b)); composition is refused.
  const h = harness("2026-10-01T15:00:00.000Z", "L-44", ["10.2", "10.4"]);
  board(h, MI({ premium_plan: "lpmi", last_annual_disclosure_on: null, lpmi_equivalent_termination_date: "2035-07-01" }));
  const act = h.events.byLoan("L-44").find((e) => e.type === "mi_policy.activated")!; assert.deepEqual([act.payload.annual_disclosure, act.payload.template], [false, null]);
  for (const code of [HPA_ANNUAL, FIRST_60, MN_ANNUAL, COMPOSE_LEAD]) assert.equal(h.timer(code).length, 0, `${code} is not instantiated for LPMI`);
  assert.equal((await runDisclosureSweep(deps(h))).approaching.length, 0);
  await assert.rejects(h.run("10.4", "notices.compose/send", { loan_id: "L-44", recipients: BORROWER, payload: h.sample("NTC_HPA_4903A3_ANNUAL") }), /lender-paid MI gets no annual disclosure \(12 U.S.C. 4905\(b\)\)/);
  // The 4905(c)(2) options clock (process 10.2) is the LPMI loan's notice: 30 calendar days after the BPMI-equivalent termination date.
  h.clock.set("2035-07-01T15:00:00.000Z");
  h.raise("mi.lpmi_equivalent_termination_date.reached", { equivalent_termination_on: "2035-07-01", premium_plan: "lpmi" });
  const t = h.latest("HPA_4905C2_LPMI_OPTIONS_NOTICE_30"); assert.deepEqual([t.status, t.anchorDate, t.dueDate], ["armed", D("2035-07-01"), D("2035-07-31")]);
  assert.equal(h.timer(HPA_ANNUAL).length, 0);
});
test("10.4-T5: Given an MN property, then the rendered PDF's body font size is ≥ 12 pt (template metadata check) and contains the statutory sentence; given CA, the notice is attached to every §2954.2 statement in ≥ 10 pt bold.", async () => {
  const reg = publishSection10(buildRegistry());
  assert.equal(disclosureTemplateCode({ plan: "bpmi_monthly", consummation: D("2024-04-15"), hpa_covered: true, state: "MN" }), "NTC_HPA_4903A3_ANNUAL_MN");
  const mn = reg.activeVersion("NTC_HPA_4903A3_ANNUAL_MN", D("2027-02-20"))!;
  const mnR = render(mn.source, mn.samplePayload);
  assert.ok(mnR.blocks.find((b) => b.id === "body")!.pt >= 12); assert.ok(mnR.blocks.find((b) => b.id === "mn_statutory")!.pt >= 12); assert.ok(mnR.blocks.find((b) => b.id === "contact")!.pt >= 12, "the statutory address/telephone block is in 12-point type too");
  assert.ok(mnR.text.includes("may have the right under federal law or Minnesota law to cancel the insurance"));
  assert.ok(mn.layoutRules.some((r) => r.rule_id === "mn-12pt" && r.layout?.minPt === 12)); assert.ok(mn.layoutRules.some((r) => r.rule_id === "mn-12pt-contact" && r.layout?.minPt === 12)); assert.equal(evaluateChecklist(mn, mn.samplePayload, mnR).passed, true);
  const ca = caStatementAttachment({ state: "CA", statement_kind: "annual_escrow" });
  assert.equal(ca.attach, true); assert.equal(ca.timer, "CA_2954_6_NOTICE_WITH_STATEMENT"); assert.equal(ca.release_blocked_without, true);
  const cav = reg.activeVersion("NTC_HPA_4903A3_ANNUAL_CA", D("2027-02-20"))!;
  const caR = render(cav.source, cav.samplePayload); const blk = caR.blocks.find((b) => b.id === "ca_notice")!;
  assert.ok(blk.pt >= 10); assert.equal(blk.bold, true); assert.ok(cav.layoutRules.some((r) => r.rule_id === "ca-10pt-bold" && r.layout?.bold === true && r.layout?.minPt === 10));
  assert.equal(evaluateChecklist(cav, cav.samplePayload, caR).passed, true);
  assert.equal(caStatementAttachment({ state: "TX", statement_kind: "annual_escrow" }).attach, false);

  // MN on the bus: the §47.207 override arms beside the HPA clock (same anchor) and only the MN variant closes it.
  const m = harness("2026-10-01T15:00:00.000Z", "L-45mn", ["10.4"]);
  board(m, MI({ state: "MN" }));
  const mnT = m.latest(MN_ANNUAL); assert.deepEqual([mnT.status, mnT.anchorDate, mnT.dueDate], ["armed", D("2026-03-15"), D("2027-03-15")]); assert.equal(m.latest(HPA_ANNUAL).anchorDate, D("2026-03-15"));
  m.clock.set("2027-02-20T15:00:00.000Z");
  const mr = (await m.run("10.4", "notices.compose/send", { loan_id: "L-45mn", recipients: BORROWER, payload: { ...m.sample("NTC_HPA_4903A3_ANNUAL_MN"), notice_date: "2027-02-20" } })) as ReleaseResult;
  assert.deepEqual([mr.status, mr.template], ["sent", "NTC_HPA_4903A3_ANNUAL_MN"]);
  assert.ok(mr.rendered.blocks.every((b) => b.id === "heading" || b.pt >= 12), "every body block of the sent MN notice is 12-point or larger"); assert.ok(mr.rendered.text.includes("may have the right under federal law or Minnesota law to cancel the insurance"));
  assert.equal(mnT.status, "satisfied"); assert.equal(m.rt.store.get("mi_disclosures", mr.disclosure_id)!.data.kind, "mn_47_207");
  // CA on the bus: every §2954.2 annual statement arms the same-day gate; the CA variant attached to the statement closes it.
  const c = harness("2026-10-01T15:00:00.000Z", "L-45ca", ["10.4"]);
  board(c, MI({ state: "CA" }));
  c.clock.set("2027-02-20T15:00:00.000Z");
  c.raise("escrow.statement.sent", { template: "NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT", statement_type: "short_year_transfer", disposition: "sent", sent_on: "2027-02-20", due_on: "2027-03-01" });
  assert.equal(c.timer(CA_STATEMENT).length, 0, "a short-year statement is not the §2954.2 statement");
  c.raise("escrow.statement.sent", { template: "NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT", statement_type: "annual", disposition: "sent", sent_on: "2027-02-20", due_on: "2027-03-01" });
  const caT = c.latest(CA_STATEMENT); assert.deepEqual([caT.status, caT.dueDate], ["armed", D("2027-02-20")]);
  const cr = (await c.run("10.4", "notices.compose/send", { loan_id: "L-45ca", recipients: BORROWER, payload: { ...c.sample("NTC_HPA_4903A3_ANNUAL_CA"), notice_date: "2027-02-20" }, included_with: "escrow_statement" })) as ReleaseResult;
  assert.deepEqual([cr.status, cr.template, cr.included_with], ["sent", "NTC_HPA_4903A3_ANNUAL_CA", "escrow_statement"]);
  const sentBlk = cr.rendered.blocks.find((b) => b.id === "ca_notice")!; assert.ok(sentBlk.pt >= 10); assert.equal(sentBlk.bold, true);
  assert.equal(caT.status, "satisfied"); assert.equal(c.rt.store.get("mi_disclosures", cr.disclosure_id)!.data.kind, "ca_2954_6");
  // A Texas property: the jurisdiction override is cancelled the same day the annual statement goes out — it never breaches.
  const t = harness("2026-10-01T15:00:00.000Z", "L-45tx", ["10.4"]);
  board(t, MI({ state: "TX" }));
  t.clock.set("2027-02-20T15:00:00.000Z");
  t.raise("escrow.statement.sent", { template: "NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT", statement_type: "annual", disposition: "sent", sent_on: "2027-02-20", due_on: "2027-03-01" });
  const txT = t.latest(CA_STATEMENT); assert.equal(txT.status, "cancelled"); assert.match(txT.cancelledReason!, /jurisdiction override \(CA\): property state TX/);
  assert.equal(t.timers.evaluate("2027-02-21T15:00:00.000Z").filter((b) => b.def.code === CA_STATEMENT).length, 0);
});
test("10.4-T6: Given `esign` consent revoked on 2027-02-18, then the 2027-02-20 disclosure is mailed, not e-delivered.", async () => {
  const r = disclosureChannelAt({ consent: { class: "annual_disclosures", given_on: D("2026-10-01"), revoked_on: D("2027-02-18") }, send_on: D("2027-02-20") });
  assert.equal(r.channel, "mail"); assert.match(r.reason, /revoked 2027-02-18/);
  assert.equal(disclosureChannelAt({ consent: { class: "annual_disclosures", given_on: D("2026-10-01"), revoked_on: null }, send_on: D("2027-02-20") }).channel, "electronic");
  assert.equal(disclosureChannelAt({ consent: null, send_on: D("2027-02-20") }).channel, "mail");
  // Through the registry's channel decision (7.4 rules): the consent withdrawn 2027-02-18 mails the 2027-02-20 disclosure; an active consent e-delivers it.
  const consent = (status: "active" | "withdrawn") => ({ party_id: "B1", classes: ["mi_notices"], disclosure_version: "esign.v1", status, consented_on: D("2026-10-01"), soft_bounces_30d: 0, ...(status === "withdrawn" ? { withdrawn_classes: ["mi_notices"] } : {}) });   // withdrawn 2027-02-18 (7.4 rule 7)
  const party = (status: "active" | "withdrawn"): Recipient => ({ ...BORROWER[0]!, email: "borrower@example.test", consent: consent(status) });
  const h = harness("2026-10-01T15:00:00.000Z", "L-46", ["10.4"]);
  board(h, MI());
  h.clock.set("2027-02-20T15:00:00.000Z");
  const mailed = (await h.run("10.4", "notices.compose/send", { loan_id: "L-46", recipients: [party("withdrawn")], payload: { ...h.sample("NTC_HPA_4903A3_ANNUAL"), notice_date: "2027-02-20" } })) as ReleaseResult;
  assert.deepEqual([mailed.status, mailed.channel, mailed.sent_on], ["sent", "mail_first_class", D("2027-02-20")]);
  const n = h.notices.get(mailed.notice_id); assert.match(n.channelDecision![0]!.reason, /withdrawn/); assert.deepEqual(n.deliveries.map((d) => d.vendor), ["print-mail"]);
  assert.equal(sentEvents(h)[0]!.payload.channel, "mail_first_class");
  const e = harness("2026-10-01T15:00:00.000Z", "L-46e", ["10.4"]);
  board(e, MI());
  e.clock.set("2027-02-20T15:00:00.000Z");
  const electronic = (await e.run("10.4", "notices.compose/send", { loan_id: "L-46e", recipients: [party("active")], payload: { ...e.sample("NTC_HPA_4903A3_ANNUAL"), notice_date: "2027-02-20" } })) as ReleaseResult;
  assert.equal(electronic.channel, "email_link"); assert.equal(e.latest(HPA_ANNUAL).anchorDate, D("2027-02-20"), "e-delivery under an active consent satisfies the clock too");
});
test("10.4-T7: Given MI terminated 2027-02-19, then the PMI page is suppressed at release and the termination notice is sent within 30 days.", async () => {
  const r = disclosureReleaseCheck({ terminated_on: D("2027-02-19"), release_on: D("2027-02-20") });
  assert.equal(r.suppress_pmi_page, true); assert.deepEqual(r.send_instead, { code: "NTC_HPA_4904A_CANCELLED", due: D("2027-03-21") });
  assert.equal(disclosureReleaseCheck({ terminated_on: null, release_on: D("2027-02-20") }).suppress_pmi_page, false);
  // On the bus: composed 2027-02-10 for the 2027-02-20 statement; MI terminated 2027-02-19 → composition re-checks status at release and suppresses the page.
  const h = harness("2026-10-01T15:00:00.000Z", "L-47", ["10.4"]);
  board(h, MI());
  const cycle = h.latest(HPA_ANNUAL);
  h.clock.set("2027-02-10T15:00:00.000Z");
  const c = (await h.run("10.4", "notices.compose/send", { op: "compose", loan_id: "L-47", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4903A3_ANNUAL"), notice_date: "2027-02-20" }, escrow_statement_on: "2027-02-20" })) as ComposeResult;
  assert.deepEqual([c.status, c.included_with, c.send_on], ["composed", "escrow_statement", D("2027-02-20")]);
  h.clock.set("2027-02-19T15:00:00.000Z");
  h.raise("mi.terminated", { effective: "2027-02-19", effective_on: "2027-02-19", premium_stop_from: "2027-03-01", termination_type: "automatic_78" });
  assert.equal(cycle.status, "cancelled", "`mi.terminated` cancels the recurring disclosure clock"); assert.match(cycle.cancelledReason!, /mi\.terminated effective 2027-02-19/);
  assert.deepEqual([h.rt.store.get("mi_policies", "L-47")!.data.status, h.rt.store.get("mi_policies", "L-47")!.data.terminated_on], ["terminated", D("2027-02-19")]);
  h.clock.set("2027-02-20T15:00:00.000Z");
  const rel = (await h.run("10.4", "notices.compose/send", { op: "release", disclosure_id: c.disclosure_id })) as ReleaseResult;
  assert.deepEqual([rel.status, rel.suppress_pmi_page, rel.send_instead, rel.sent_on], ["suppressed", true, { code: "NTC_HPA_4904A_CANCELLED", due: D("2027-03-21") }, null]);
  assert.equal(noticeSent(h, "NTC_HPA_4903A3_ANNUAL").length, 0, "no annual disclosure goes out after MI ended"); assert.equal(h.rt.store.get("mi_disclosures", c.disclosure_id!)!.data.status, "suppressed");
  assert.deepEqual(h.events.byLoan("L-47").filter((e) => e.type === "mi.disclosure.suppressed").map((e) => [e.payload.terminated_on, (e.payload.send_instead as { due: string }).due]), [[D("2027-02-19"), D("2027-03-21")]]);
  assert.equal(h.timer(HPA_ANNUAL).length, 1, "no new cycle after termination");
});
test("10.4-T8: Given a loan boarded 2026-10-01 with null last-sent date, then a standalone disclosure is sent by 2026-11-30.", async () => {
  assert.deepEqual(disclosurePlan({ last_sent: null, boarded_on: D("2026-10-01"), escrow_statement_on: null, form_1098_on: null }), { next_due: D("2026-11-30"), send_on: D("2026-11-30"), included_with: "standalone" });
  const s = disclosureSchedule({ plan: "bpmi_monthly", status: "active", lpmi_equiv_termination_date: null, last_sent: null, boarded_on: D("2026-10-01") });
  assert.deepEqual(s.timers, [{ code: "SM_MI_FIRST_DISCLOSURE_POST_BOARDING_60", due: D("2026-11-30") }]); assert.equal(s.annual_timer!.send_on, D("2026-11-30"));
  assert.throws(() => validateMiPolicyRecord("L-48", { premium_plan: "bpmi_monthly", boarded_at: "2026-10-01", last_annual_disclosure_on: "last year" }), RangeError);
  // On the bus: boarding with MI and a null last-sent date arms the 60-day policy clock (anchor boarded_at 2026-10-01 → 2026-11-30) beside the 12-month clock from boarding.
  const h = harness("2026-10-01T15:00:00.000Z", "L-48", ["10.4"]);
  board(h, MI({ last_annual_disclosure_on: null }));
  const act = h.events.byLoan("L-48").find((e) => e.type === "mi_policy.activated")!; assert.deepEqual([act.payload.last_annual_disclosure_on, act.payload.disclosure_anchor_on, act.payload.next_annual_disclosure_due], [null, D("2026-10-01"), D("2026-11-30")]);
  const t = h.latest(FIRST_60); assert.deepEqual([t.status, t.anchorDate, t.dueDate], ["armed", D("2026-10-01"), D("2026-11-30")]);
  const cycle = h.latest(HPA_ANNUAL); assert.deepEqual([cycle.anchorDate, cycle.dueDate], [D("2026-10-01"), D("2027-10-01")]);
  h.clock.set("2026-11-20T15:00:00.000Z");
  h.raise("notice.sent", { template: "NTC_REGZ_41_STMT_STD", notice_id: "n-stmt" });
  assert.equal(t.status, "armed", "a periodic statement is not the disclosure");
  const n = (await h.run("10.4", "notices.compose/send", { loan_id: "L-48", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4903A3_ANNUAL"), notice_date: "2026-11-20" } })) as ReleaseResult;
  assert.deepEqual([n.status, n.included_with, n.sent_on], ["sent", "standalone", D("2026-11-20")]); assert.match(n.rendered.text, /right to ask us to cancel your private mortgage insurance in writing/);
  assert.equal(t.status, "satisfied"); assert.ok(t.satisfiedAt!.slice(0, 10) <= "2026-11-30");
  assert.equal(cycle.status, "satisfied"); assert.deepEqual([h.latest(HPA_ANNUAL).anchorDate, h.latest(HPA_ANNUAL).dueDate], [D("2026-11-20"), D("2027-11-20")]);
  assert.deepEqual([h.rt.store.get("mi_policies", "L-48")!.data.last_annual_disclosure_on, h.rt.store.get("mi_policies", "L-48")!.data.next_annual_disclosure_due], [D("2026-11-20"), D("2027-11-20")]);
});
test("10.4-T9: Given an ARM reset that moved the 78% date, then the next disclosure shows the new date and the prior disclosure record retains the old projection.", async () => {
  let records: readonly DisclosureRecord[] = [];
  records = appendDisclosureRecord(records, { loan_id: "L1", schedule_version_id: "sched-initial", projected_80_date: D("2033-06-01"), projected_78_date: D("2034-07-01"), projected_midpoint_date: D("2039-05-01"), sent_on: D("2028-02-20") });
  const prior = records[0]!;
  records = appendDisclosureRecord(records, { loan_id: "L1", schedule_version_id: "sched-arm_reset-2029-05-01", projected_80_date: D("2034-08-01"), projected_78_date: D("2035-09-01"), projected_midpoint_date: D("2039-05-01"), sent_on: D("2030-02-20") });
  assert.equal(records.length, 2); assert.equal(records[1]!.projected_78_date, D("2035-09-01")); assert.equal(records[0]!.projected_78_date, D("2034-07-01")); assert.equal(records[0], prior);
  // On the bus: the 2028 disclosure prints the initial schedule's 78% date; the ARM reset's `mi.schedule.updated` refreshes the merge data (no resend); the 2029 disclosure prints the new date.
  const h = harness("2028-02-20T15:00:00.000Z", "L-49", ["10.4"]);
  board(h, MI({ last_annual_disclosure_on: "2027-02-20" }), "2027-10-01");
  const first = (await h.run("10.4", "notices.compose/send", { loan_id: "L-49", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4903A3_ANNUAL"), notice_date: "2028-02-20" }, schedule_version_id: "sched-initial", projected_80_date: "2033-06-01", projected_78_date: "2034-07-01", projected_midpoint_date: "2039-05-01" })) as ReleaseResult;
  assert.equal(first.status, "sent"); assert.match(first.rendered.text, /the 78 percent date is July 1, 2034/);
  const before = h.seq();
  h.clock.set("2029-05-01T15:00:00.000Z");
  h.raise("mi.schedule.updated", { schedule_version_id: "sched-arm_reset-2029-05-01", kind: "arm_reset", projected_80_date: "2034-08-01", projected_78_date: "2035-09-01", projected_midpoint_date: "2039-05-01" });
  assert.equal(h.since(before).filter((e) => e.type === "notice.sent" || e.type === "mi.disclosure.sent").length, 0, "a schedule update refreshes the next disclosure — no resend");
  h.clock.set("2029-06-20T15:00:00.000Z");
  const second = (await h.run("10.4", "notices.compose/send", { loan_id: "L-49", recipients: BORROWER, payload: { notice_date: "2029-06-20" } })) as ReleaseResult;   // the loan's merge data carries the rest — with the ARM reset's dates
  assert.equal(second.status, "sent"); assert.match(second.rendered.text, /the 78 percent date is September 1, 2035/);
  const rows = [...h.rt.store.list("mi_disclosures", (d) => d.loan_id === "L-49")].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  assert.deepEqual(rows.map((r) => [r.data.schedule_version_id, r.data.projected_78_date, r.data.status]), [["sched-initial", "2034-07-01", "sent"], ["sched-arm_reset-2029-05-01", "2035-09-01", "sent"]]);
  assert.equal(h.rt.store.history("mi_disclosures", rows[0]!.id).every((v) => v.data.projected_78_date === "2034-07-01"), true, "the prior record is append-only: its projection never changes");
  assert.deepEqual(sentEvents(h).map((e) => e.payload.projected_78_date), ["2034-07-01", "2035-09-01"]);
});

test("10.4 worked figure: UPB $365,400.00 / $400,000 → 91.35%", () => { assert.equal(ltvBps(36540000n, 40000000n), 9135); assert.equal(bpsToPercent(9135), "91.35"); });
