// 13.1 120-day pre-foreclosure prohibition
// spec/sections/13-foreclosure/13-1-120-day-pre-foreclosure-prohibition.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { occupancyDefault, preFilingAppHold, exceptionGround, nyFirstNoticeGate, refusedReferral, ruleSetSwap, transferredFirstFiling } from "./ops.ts";

// 13.1-T1 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.1-T2 — implemented in src/domain/foreclosure/foreclosure.test.ts
// 13.1-T3 — implemented in src/domain/foreclosure/foreclosure.test.ts
test("13.1-T4: Given occupancy unknown, Then treated as principal residence; escalation to `human_agent` if the model concludes otherwise with confidence 0.85.", () => {
  assert.deepEqual(occupancyDefault({ occupancy: "unknown" }), { treated_as: "principal_residence", escalation: null });
  const r = occupancyDefault({ occupancy: "unknown", model_conclusion: { non_principal: true, confidence: 0.85 } });
  assert.equal(r.treated_as, "principal_residence"); assert.equal(r.escalation!.kind, "human_agent"); assert.match(r.escalation!.reason, /0\.85/);
  assert.equal(occupancyDefault({ occupancy: "unknown", model_conclusion: { non_principal: true, confidence: 0.95 } }).treated_as, "non_principal");
});
test("13.1-T5: Given complete application received day 100 and determination \"ineligible\" sent day 118 with 14-day appeal window, When referral attempted day 121, Then refused by `REGX_1024_41F2_PRE_FILING_APP_GATE` until day 133 (window expiry) or appeal denial.", () => {
  const eu = D("2026-03-01"); const day = (n: number) => D(new Date(Date.parse(eu) + n * 86_400_000).toISOString().slice(0, 10));
  const r = preFilingAppHold({ earliest_unpaid_due: eu, complete_received_on: day(100), determination_sent_on: day(118), appeal_available: true, referral_attempt_on: day(121) });
  assert.equal(r.day_of_attempt, 121); assert.equal(r.state, "closed"); assert.equal(r.opens_on, day(133)); assert.match(r.refusal!, /REGX_1024_41F2_PRE_FILING_APP_GATE until/);
  assert.equal(preFilingAppHold({ earliest_unpaid_due: eu, complete_received_on: day(100), determination_sent_on: day(118), appeal_available: true, referral_attempt_on: day(133) }).state, "open");
  assert.equal(preFilingAppHold({ earliest_unpaid_due: eu, complete_received_on: day(100), determination_sent_on: day(118), appeal_available: true, appeal_denied_on: day(125), referral_attempt_on: day(126) }).state, "open");
});
test("13.1-T6: Given a due-on-sale violation recorded by `officer` with counsel memo at day 60, When `foreclosure.first_notice.authorize{ground=due_on_sale}`, Then allowed; When `{ground=default}`, Then refused.", () => {
  const base = { recorded_by_role: "officer", counsel_memo_document_id: "memo-1", today: D("2026-04-30"), earliest_unpaid_due: D("2026-03-01"), principal_residence: true };
  const dos = exceptionGround({ ...base, ground: "due_on_sale" }); assert.equal(dos.allowed, true); assert.equal(dos.state, "exception_open");
  const def = exceptionGround({ ...base, ground: "default" }); assert.equal(def.allowed, false); assert.equal(def.state, "closed"); assert.match(def.refusal!, /120_DAY_GATE/);
  assert.equal(exceptionGround({ ...base, ground: "due_on_sale", recorded_by_role: "ops_analyst" }).allowed, false);
});
test("13.1-T7: Given NY property, day 121 reached but \u00a71304 notice mailed only 50 days ago, Then referral allowed (policy) but `first_notice.authorize` refused by `STATE_PREFC_NOTICE_GATE:NY` until day 90 after mailing and \u00a71306 filing evidenced.", () => {
  const r = nyFirstNoticeGate({ today: D("2026-06-30"), earliest_unpaid_due: D("2026-03-01"), s1304_mailed_on: D("2026-05-11"), s1306_filed: false });
  assert.equal(r.referral_allowed, true); assert.equal(r.first_notice_allowed, false); assert.equal(r.gate, "STATE_PREFC_NOTICE_GATE:NY"); assert.equal(r.opens_on, "2026-08-09"); assert.match(r.refusal!, /§1306 filing evidence/);
  assert.equal(nyFirstNoticeGate({ today: D("2026-08-09"), earliest_unpaid_due: D("2026-03-01"), s1304_mailed_on: D("2026-05-11"), s1306_filed: true }).first_notice_allowed, true);
});
test("13.1-T8: Given a referral attempt while the gate is closed, Then command refused, `foreclosure.gate.refused` written, sev-1 escalation, and no message leaves for the attorney network.", () => {
  const r = refusedReferral({ gate: "REGX_1024_41F1_120_DAY_GATE", opens_on: D("2026-06-30"), attempted_on: D("2026-06-01"), actor: "foreclosure-ops" });
  assert.equal(r.refused, true); assert.equal(r.event.type, "foreclosure.gate.refused"); assert.equal(r.escalation.severity, "sev1"); assert.equal(r.attorney_message_sent, false);
});
test("13.1-T9: Given rule set flipped to `regx.lossmit.2024nprm` on an effective date, Then evaluations after that date reference the new gate codes and a diff report is produced.", () => {
  const before = ruleSetSwap({ effective_on: D("2027-01-01"), evaluation_on: D("2026-12-31") }); assert.equal(before.rule_set, "regx.lossmit.2013"); assert.ok(before.gate_codes.includes("REGX_1024_41F2_PRE_FILING_APP_GATE"));
  const after = ruleSetSwap({ effective_on: D("2027-01-01"), evaluation_on: D("2027-01-01") }); assert.equal(after.rule_set, "regx.lossmit.2024nprm"); assert.ok(after.gate_codes.includes("NPRM_REVIEW_CYCLE_GATE"));
  assert.deepEqual(after.diff, { added: ["NPRM_REVIEW_CYCLE_GATE", "NPRM_FEE_FREEZE"], removed: ["REGX_1024_41F2_PRE_FILING_APP_GATE"] });
});
test("13.1-T10: Given a transfer-in with transferor first filing evidenced, Then no second \"first notice\" is authorized and the 7.1 statement flag is true from boarding.", () => {
  const r = transferredFirstFiling({ transferor_first_notice_filed_at: D("2026-05-20"), transferor_state_prefc_notice_sent: true, transferor_lpi_due: D("2026-01-01") });
  assert.equal(r.second_first_notice_allowed, false); assert.equal(r.statement_flag_from_boarding, true); assert.equal(r.resend_state_prefc_notice, false);
});
