// 10.4 Annual PMI disclosure
// spec/sections/10-pmi-administration/10-4-annual-pmi-disclosure.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { ltvBps, bpsToPercent } from "./cancellation.ts";
import { annualDisclosureCheck, disclosureTemplateCode, caStatementAttachment, disclosureSchedule, disclosureChannelAt, disclosureReleaseCheck, appendDisclosureRecord, type DisclosureRecord } from "./ops.ts";

// 10.4-T1 — implemented in src/domain/pmi/pmi.test.ts
test("10.4-T2: Given no disclosure sent by 2027-03-15 23:59, then `HPA_4903A3_ANNUAL_DISCLOSURE_12M` breaches, a standalone notice is auto-sent and an `officer` sev-2 escalation opens.", () => {
  const r = annualDisclosureCheck({ due: D("2027-03-15"), sent_on: null, now: D("2027-03-16") });
  assert.equal(r.timer, "HPA_4903A3_ANNUAL_DISCLOSURE_12M"); assert.equal(r.status, "breached");
  assert.deepEqual(r.auto_send, { code: "NTC_HPA_4903A3_ANNUAL", included_with: "standalone" }); assert.deepEqual(r.escalation, { role: "officer", severity: 2 }); assert.equal(r.sentinel, true);
  assert.equal(annualDisclosureCheck({ due: D("2027-03-15"), sent_on: D("2027-02-20"), now: D("2027-03-16") }).status, "satisfied");
});
test("10.4-T3: Given a pre-1999 loan, then the legacy template is used and the checklist verifies the \"with the consent of the mortgagee or in accordance with applicable State law\" sentence.", () => {
  assert.equal(disclosureTemplateCode({ plan: "bpmi_monthly", consummation: D("1998-11-15"), hpa_covered: true, state: "TX" }), "NTC_HPA_4903B_ANNUAL_LEGACY");
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_HPA_4903B_ANNUAL_LEGACY", D("2027-02-20"))!;
  const rendered = render(v.source, v.samplePayload);
  const rule = v.contentRules.find((r) => r.rule_id === "legacy-sentence")!;
  assert.match(rule.selector, /with the consent of the mortgagee or in accordance with applicable State law/);
  assert.ok(rendered.text.includes("with the consent of the mortgagee or in accordance with applicable State law"));
  assert.equal(evaluateChecklist(v, v.samplePayload, rendered).passed, true);
});
test("10.4-T4: Given an LPMI loan, then no annual disclosure is scheduled and the `HPA_4905C2_LPMI_OPTIONS_NOTICE_30` timer exists instead.", () => {
  const r = disclosureSchedule({ plan: "lpmi", status: "active", lpmi_equiv_termination_date: D("2035-07-01"), last_sent: null, boarded_on: D("2026-10-01") });
  assert.equal(r.annual_timer, null); assert.deepEqual(r.timers, [{ code: "HPA_4905C2_LPMI_OPTIONS_NOTICE_30", due: D("2035-07-31") }]);
  assert.equal(disclosureTemplateCode({ plan: "lpmi", consummation: D("2024-04-15"), hpa_covered: true, state: "TX" }), null);
  const b = disclosureSchedule({ plan: "bpmi_monthly", status: "active", lpmi_equiv_termination_date: null, last_sent: D("2026-03-15"), boarded_on: D("2026-10-01"), escrow_statement_on: D("2027-02-20") });
  assert.equal(b.annual_timer!.code, "HPA_4903A3_ANNUAL_DISCLOSURE_12M"); assert.equal(b.annual_timer!.due, D("2027-03-15"));
});
test("10.4-T5: Given an MN property, then the rendered PDF's body font size is \u2265 12 pt (template metadata check) and contains the statutory sentence; given CA, the notice is attached to every \u00a72954.2 statement in \u2265 10 pt bold.", () => {
  const reg = buildRegistry(); publishAuthored(reg);
  assert.equal(disclosureTemplateCode({ plan: "bpmi_monthly", consummation: D("2024-04-15"), hpa_covered: true, state: "MN" }), "NTC_HPA_4903A3_ANNUAL_MN");
  const mn = reg.activeVersion("NTC_HPA_4903A3_ANNUAL_MN", D("2027-02-20"))!;
  const mnR = render(mn.source, mn.samplePayload);
  assert.ok(mnR.blocks.find((b) => b.id === "body")!.pt >= 12); assert.ok(mnR.blocks.find((b) => b.id === "mn_statutory")!.pt >= 12);
  assert.ok(mnR.text.includes("may have the right under federal law or Minnesota law to cancel the insurance"));
  assert.ok(mn.layoutRules.some((r) => r.rule_id === "mn-12pt" && r.layout?.minPt === 12)); assert.equal(evaluateChecklist(mn, mn.samplePayload, mnR).passed, true);
  const ca = caStatementAttachment({ state: "CA", statement_kind: "annual_escrow" });
  assert.equal(ca.attach, true); assert.equal(ca.timer, "CA_2954_6_NOTICE_WITH_STATEMENT"); assert.equal(ca.release_blocked_without, true);
  const cav = reg.activeVersion("NTC_HPA_4903A3_ANNUAL_CA", D("2027-02-20"))!;
  const caR = render(cav.source, cav.samplePayload); const blk = caR.blocks.find((b) => b.id === "ca_notice")!;
  assert.ok(blk.pt >= 10); assert.equal(blk.bold, true); assert.ok(cav.layoutRules.some((r) => r.rule_id === "ca-10pt-bold" && r.layout?.bold === true && r.layout?.minPt === 10));
  assert.equal(evaluateChecklist(cav, cav.samplePayload, caR).passed, true);
  assert.equal(caStatementAttachment({ state: "TX", statement_kind: "annual_escrow" }).attach, false);
});
test("10.4-T6: Given `esign` consent revoked on 2027-02-18, then the 2027-02-20 disclosure is mailed, not e-delivered.", () => {
  const r = disclosureChannelAt({ consent: { class: "annual_disclosures", given_on: D("2026-10-01"), revoked_on: D("2027-02-18") }, send_on: D("2027-02-20") });
  assert.equal(r.channel, "mail"); assert.match(r.reason, /revoked 2027-02-18/);
  assert.equal(disclosureChannelAt({ consent: { class: "annual_disclosures", given_on: D("2026-10-01"), revoked_on: null }, send_on: D("2027-02-20") }).channel, "electronic");
  assert.equal(disclosureChannelAt({ consent: null, send_on: D("2027-02-20") }).channel, "mail");
});
test("10.4-T7: Given MI terminated 2027-02-19, then the PMI page is suppressed at release and the termination notice is sent within 30 days.", () => {
  const r = disclosureReleaseCheck({ terminated_on: D("2027-02-19"), release_on: D("2027-02-20") });
  assert.equal(r.suppress_pmi_page, true); assert.deepEqual(r.send_instead, { code: "NTC_HPA_4904A_CANCELLED", due: D("2027-03-21") });
  assert.equal(disclosureReleaseCheck({ terminated_on: null, release_on: D("2027-02-20") }).suppress_pmi_page, false);
});
// 10.4-T8 — implemented in src/domain/pmi/pmi.test.ts
test("10.4-T9: Given an ARM reset that moved the 78% date, then the next disclosure shows the new date and the prior disclosure record retains the old projection.", () => {
  let records: readonly DisclosureRecord[] = [];
  records = appendDisclosureRecord(records, { loan_id: "L1", schedule_version_id: "sched-initial", projected_80_date: D("2033-06-01"), projected_78_date: D("2034-07-01"), projected_midpoint_date: D("2039-05-01"), sent_on: D("2028-02-20") });
  const prior = records[0]!;
  records = appendDisclosureRecord(records, { loan_id: "L1", schedule_version_id: "sched-arm_reset-2029-05-01", projected_80_date: D("2034-08-01"), projected_78_date: D("2035-09-01"), projected_midpoint_date: D("2039-05-01"), sent_on: D("2030-02-20") });
  assert.equal(records.length, 2); assert.equal(records[1]!.projected_78_date, D("2035-09-01")); assert.equal(records[0]!.projected_78_date, D("2034-07-01")); assert.equal(records[0], prior);
});

test("10.4 worked figure: UPB $365,400.00 / $400,000 → 91.35%", () => { assert.equal(ltvBps(36540000n, 40000000n), 9135); assert.equal(bpsToPercent(9135), "91.35"); });
