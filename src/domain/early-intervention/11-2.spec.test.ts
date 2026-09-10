// 11.2 Written early intervention notice
// spec/sections/11-early-intervention-collections/11-2-written-early-intervention-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { eiRenderGate, eiChannel, day45Solicitation, bspAfterQrpc, noticeLegApplicability, dcLoanEiNotice, printFailover } from "./ops.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";

// 11.2-T1 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T2 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T3 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T4 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T5 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T6 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T7 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.2-T8 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.2-T9: Given the assigned-contact block is missing at render, then the send is refused, auto-assignment runs (4.3) and the re-render passes.", () => {
  const refused = eiRenderGate({ assigned_contact_block_present: false, exclusive_address_present: true });
  assert.equal(refused.send_allowed, false); assert.equal(refused.action, "auto_assign_4_3"); assert.deepEqual(refused.failing, ["continuity_block_present"]);
  const ok = eiRenderGate({ assigned_contact_block_present: true, exclusive_address_present: true });
  assert.equal(ok.send_allowed, true); assert.equal(ok.action, null);
});
test("11.2-T10: Given no `esign` consent for `regx_ei`, then the channel is mail; given consent and an email bounce, then mail is generated the same day.", () => {
  assert.deepEqual(eiChannel({ esign_consent_regx_ei: false }), { channel: "mail", mail_generated_on: null });
  assert.deepEqual(eiChannel({ esign_consent_regx_ei: true, bounced_on: D("2026-12-14") }), { channel: "mail", mail_generated_on: D("2026-12-14") });
  assert.equal(eiChannel({ esign_consent_regx_ei: true }).channel, "electronic");
});
test("11.2-T11: Given no QRPC by day 45, then a BSP (745 + 710) is sent with the EI notice in the same envelope, `hope_hotline_present=true`, and a `Borrower Solicitation Package` action event exists.", () => {
  const p = day45Solicitation({ qrpc_established: false, resolved: false, regx_days: 45 })!;
  assert.equal(p.kind, "bsp"); assert.deepEqual([...p.contents], ["form_745", "form_710", "document_checklist", "return_envelope", "portal_upload_link"]);
  assert.equal(p.same_envelope_with_ei, true); assert.equal(p.hope_hotline_present, true); assert.equal(p.fnma_action_event, "Borrower Solicitation Package");
  assert.equal(day45Solicitation({ qrpc_established: true, resolved: false, regx_days: 45 }), null);
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_FNMA_D2204_SOLICITATION_PACKAGE", D("2026-12-16"))!;
  assert.ok(render(v.source, v.samplePayload).text.includes("1-888-995-HOPE"));
});
test("11.2-T12: Given QRPC on day 30 with no resolution and no prior BSP, then a BSP is sent within 3 servicer BD; given a prior BSP exists, then none is sent and the decision cites it.", () => {
  const r = bspAfterQrpc({ qrpc_on: D("2026-12-01"), prior_bsp_id: null });
  assert.equal(r.send, true); assert.equal(r.due, D("2026-12-04"));
  const prior = bspAfterQrpc({ qrpc_on: D("2026-12-01"), prior_bsp_id: "bsp-1" });
  assert.equal(prior.send, false); assert.equal(prior.decision_cites, "bsp-1");
});
test("11.2-T13: Given an investment property, then no Reg X notice leg exists but `FNMA_D2204_SOLICITATION_45` runs.", () => {
  const r = noticeLegApplicability({ principal_residence: false, due_date: D("2026-11-01") });
  assert.equal(r.regx_notice_leg, "not_applicable"); assert.deepEqual(r.fnma_solicitation_45, { code: "FNMA_D2204_SOLICITATION_45", due: D("2026-12-16") });
  assert.equal(noticeLegApplicability({ principal_residence: true, due_date: D("2026-11-01") }).regx_notice_leg, "open");
});
test("11.2-T14: Given a DC loan inside its Reg F validation period, then the EI notice carries the \u00a71006.18(e) disclosure and no language demanding payment within the validation period (overshadowing check).", () => {
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGX_39D_EARLY_INTERVENTION_FDCPA", D("2026-12-14"))!;
  const text = render(v.source, v.samplePayload).text;
  const r = dcLoanEiNotice({ text, validation_end: D("2026-11-08"), ref_date: D("2026-10-20"), in_validation_period: true });
  assert.equal(r.fragment_present, true); assert.deepEqual([...r.overshadow_issues], []); assert.equal(r.accepted, true);
  const bad = dcLoanEiNotice({ text: text + " You must pay within 10 days.", validation_end: D("2026-11-08"), ref_date: D("2026-10-20"), in_validation_period: true });
  assert.equal(bad.accepted, false);
});
test("11.2-T15: Given the print vendor fails on 2026-12-14, then the secondary vendor mails on 12-15 and the timer is satisfied; given both fail through 12-16, then a breach with `officer` escalation is recorded and the notice mails 12-17.", () => {
  const ok = printFailover({ primary_failed_on: D("2026-12-14"), secondary_available: true, notice_due: D("2026-12-16") });
  assert.equal(ok.mailed_on, D("2026-12-15")); assert.equal(ok.vendor, "secondary"); assert.equal(ok.timer_satisfied, true); assert.equal(ok.breached, false);
  const both = printFailover({ primary_failed_on: D("2026-12-14"), secondary_available: false, notice_due: D("2026-12-16"), recovered_on: D("2026-12-17") });
  assert.equal(both.mailed_on, D("2026-12-17")); assert.equal(both.breached, true); assert.deepEqual(both.escalation, { role: "officer" });
});
