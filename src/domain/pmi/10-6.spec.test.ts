// 10.6 Denial notice
// spec/sections/10-pmi-administration/10-6-denial-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, federal } from "../../kernel/calendar/business.ts";
import { ratePercent } from "../../kernel/money/cents.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { publishCheck } from "../../notices/checklist.ts";
import { SECTION_04_VERSIONS } from "../../notices/authored/section04.ts";
import { ltvBps, decisionDue } from "./cancellation.ts";
import { denialDue, historyRenewalDate, valuationDenialWindows, disputeRoute, humanReviewDue, noeAckDue, denialSendAllowed, reversalGrant } from "./denial.ts";
import { composeDenial, composeInfoRequest, requestHumanReview, completeHumanReview, MI_DENIAL_REASONS, type HumanReviewClosed } from "./ops-10-6.ts";
import { installmentLedger, WORKED_LOAN } from "./fixtures.ts";
import { infoRequest, qcSample } from "./ops.ts";
import { harness, BORROWER, HUMAN_AGENT, PMI_AGENT, PROCESSES_10, type Harness } from "./spec-harness.ts";

type Sent = { id: string; status: string; sentAt: string; rendered: { text: string } };
type Evaluated = { evaluation_id: string; result: string; reasons: string[]; ltv_bps: number; threshold_bps: number | null };
const composeDeps = (h: Harness) => ({ events: h.events, store: h.rt.store, actor: PMI_AGENT, now: h.clock.now() });
/** The worked loan's amortization (10.4: $380,000 at 6.5% over 360 months from 2024-05-01 → 80 percent at payment 124, 2034-08-01). */
const WORKED_SCHEDULE = { upb_cents: WORKED_LOAN.upb_cents, annual_rate: ratePercent(WORKED_LOAN.rate_pct), term_months: WORKED_LOAN.term_months, first_due: WORKED_LOAN.first_due };
/** 10.1's LTV worked example as the `pmi.*` evaluate input: request 2027-07-10, UPB $335,548.68 against the $400,000 original value, clean history. */
const ltvDenialRequest = (loanId: string, decisionOn: string) => ({ op: "evaluate", loan_id: loanId, received_on: "2027-07-10", decision_on: decisionOn, original_value_cents: 40000000n, evaluation_upb_cents: 33554868n, consummation: "2024-03-15", installments: installmentLedger(40, {}, D("2027-07-01")) });

test(`10.6-T1: Given the LTV denial example, then the rendered notice contains "$335,548.68", "$400,000.00", "83.88%", "80.00%", the scheduled date 2034-08-01, the current-value option with the $190 fee, and the error-resolution address; sent by 2027-08-09.`, async () => {
  // R1: request prong = received 2027-07-10 + 30 = 2027-08-09 (no borrower evidence re-anchors it)
  assert.equal(denialDue({ received_on: D("2027-07-10"), evidence_satisfied_on: null, scheduled_termination_on: null, state: "TX" }), D("2027-08-09"));
  const h = harness("2027-07-13T15:00:00.000Z", "L-61");
  h.raise("mi.cancel.requested", { received_at: "2027-07-10", channel: "written" });
  const d = (await h.run("10.1", "pmi.*", ltvDenialRequest("L-61", "2027-07-13"))) as Evaluated;
  assert.equal(d.result, "ineligible"); assert.deepEqual(d.reasons, ["LTV_ABOVE_THRESHOLD"]); assert.equal(d.ltv_bps, 8388);
  assert.equal(h.latest("HPA_4904B_DENIAL_NOTICE_30").dueDate, D("2027-08-09")); assert.equal(h.latest("SM_MI_DENIAL_SEND_5BD").dueDate, addBusinessDays(D("2027-07-13"), 5, servicer));
  // R2: the pmi agent composes from the decision record — reason codes from `mi_evaluations.reasons`, the numbers from the snapshot, the cure from the schedule
  const c = composeDenial(composeDeps(h), { loan_id: "L-61", evaluation_id: d.evaluation_id, notice_date: D("2027-07-14"), identity: h.sample("NTC_HPA_4904B_DENIAL"), state: "TX", schedule: WORKED_SCHEDULE });
  assert.equal(c.due_on, D("2027-08-09")); assert.deepEqual(c.reason_codes, ["LTV_ABOVE_THRESHOLD"]); assert.ok(MI_DENIAL_REASONS.LTV_ABOVE_THRESHOLD);
  assert.deepEqual(c.numbers, { evaluation_upb_cents: "33554868", value_cents: "40000000", ltv_percent: "83.88", threshold_percent: "80.00" });
  assert.equal(c.payload.grounds_text, "your loan balance is above 80 percent of the original value of your property.");
  assert.equal(c.payload.cure_text, "your balance is scheduled to reach 80 percent on August 1, 2034 (2034-08-01); you may qualify earlier when your balance is $320,000.00 or less, or you may ask us to evaluate the current value of your property after March 15, 2026 at a threshold of 75 percent (80 percent from March 15, 2029) with a broker price opinion at $190.");
  assert.equal(c.payload.valuation_kind, "none"); assert.equal(h.rt.store.get("mi_denials", c.denial_id)!.data.status, "notice_composed");
  // composed 2027-07-13, sent 2027-07-14 through the bus (mail; no e-consent) — within the 2027-08-09 due date
  h.clock.set("2027-07-14T15:00:00.000Z");
  const n = (await h.run("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-61", evaluation_id: d.evaluation_id, recipients: BORROWER, payload: c.payload })) as Sent;
  for (const s of ["$335,548.68", "$400,000.00", "83.88%", "80.00%", "2034-08-01", "broker price opinion at $190", "Supermortgage Error Resolution, PO Box 2, Testville TX 75001", "You may renew your request at any time"]) assert.ok(n.rendered.text.includes(s), s);
  assert.equal(n.status, "sent"); assert.ok(n.sentAt.slice(0, 10) <= "2027-08-09");
  assert.equal(h.latest("HPA_4904B_DENIAL_NOTICE_30").status, "satisfied"); assert.equal(h.latest("SM_MI_DENIAL_SEND_5BD").status, "satisfied");
  // the append-only `mi_denials` row: composed → sent, stamped with the notice id, on time
  const row = h.rt.store.get("mi_denials", c.denial_id)!.data;
  assert.equal(row.status, "sent"); assert.equal(row.notice_id, n.id); assert.equal(row.sent_on_time, true); assert.equal(row.due_on, D("2027-08-09")); assert.equal(row.evaluation_id, d.evaluation_id);
  assert.equal(h.rt.store.history("mi_denials", c.denial_id).length, 2);
  // guardrail: any change to numbers after composition forces re-composition
  assert.equal((await h.refused("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-61", evaluation_id: d.evaluation_id, recipients: BORROWER, payload: { ...c.payload, ltv_percent: "79.99" } })).code, "RECOMPOSE_AFTER_NUMBER_CHANGE");
});
test(`10.6-T2: Given the payment-history denial, then the notice names the 2028-10-01 installment and "35 days past due" and the renewal date 2029-11-06.`, async () => {
  assert.equal(historyRenewalDate(D("2028-11-05")), D("2029-11-06"));
  const h = harness("2029-07-15T15:00:00.000Z", "L-62");
  h.raise("mi.cancel.requested", { received_at: "2029-07-10", channel: "written" });
  // 10.1-T4's ledger: the 2028-10-01 installment received 2028-11-05 (35 days past due) inside window B; UPB $319,950.95 is 79.98% of the original value, AVM $455,000
  const led = installmentLedger(70, { "2028-10-01": "2028-11-05", "2028-11-01": "2028-11-05" }, D("2029-07-01"));
  const d = (await h.run("10.1", "pmi.*", { op: "evaluate", loan_id: "L-62", received_on: "2029-07-10", decision_on: "2029-07-15", original_value_cents: 40000000n, evaluation_upb_cents: 31995095n, consummation: "2024-03-15", avm_cents: 45500000n, installments: led })) as Evaluated;
  assert.equal(d.result, "ineligible"); assert.deepEqual(d.reasons, ["PAYMENT_HISTORY_30_12M"]);
  const stored = h.rt.store.get("mi_evaluations", d.evaluation_id)!.data as { late_installments: { due_date: string; paid_on: string; days_late: number }[] };
  assert.deepEqual(stored.late_installments.map((l) => [l.due_date, l.paid_on, l.days_late]), [[D("2028-10-01"), D("2028-11-05"), 35]]);
  // R2: the grounds name the installment and its days past due; the cure names the renewal date once the 12-month window no longer contains it
  const c = composeDenial(composeDeps(h), { loan_id: "L-62", evaluation_id: d.evaluation_id, notice_date: D("2029-07-15"), identity: h.sample("NTC_HPA_4904B_DENIAL"), state: "TX" });
  assert.equal(c.due_on, D("2029-08-09")); assert.equal(h.latest("HPA_4904B_DENIAL_NOTICE_30").dueDate, D("2029-08-09"));
  assert.equal(c.payload.grounds_text, "your payment history does not meet the requirement: the installment due 2028-10-01 was received 2028-11-05, 35 days past due, within the 12 months before your request (no payment may be 30 or more days past due in that period).");
  assert.equal(c.payload.cure_text, "a renewed request on or after 2029-11-06, when the 12-month window no longer contains that installment (assuming no other late payments), would satisfy the payment-history condition.");
  assert.equal(c.payload.valuation_kind, "avm"); assert.equal(c.payload.avm_disclaimer, true); assert.equal(c.numbers.ltv_percent, "79.98");
  const n = (await h.run("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-62", evaluation_id: d.evaluation_id, recipients: BORROWER, payload: c.payload })) as Sent;
  for (const s of ["2028-10-01", "35 days past due", "2029-11-06", "$455,000.00", "developed by an automated valuation model"]) assert.ok(n.rendered.text.includes(s), s);
  assert.equal(n.status, "sent"); assert.ok(n.sentAt.slice(0, 10) <= "2029-08-09"); assert.equal(h.latest("HPA_4904B_DENIAL_NOTICE_30").status, "satisfied");
  assert.equal(h.rt.store.get("mi_denials", c.denial_id)!.data.status, "sent");
  // SMDU FAQ Q6: the AVM result quoted without the disclaimer holds the notice
  assert.equal((await h.refused("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-62", evaluation_id: d.evaluation_id, recipients: BORROWER, payload: { ...c.payload, avm_disclaimer: false } })).code, "AVM_DISCLAIMER");
});
test("10.6-T3: Given the valuation denial, then the notice includes the BPO value $490,000 (2026-09-03), the appeal window to 2026-11-02 and validity to 2027-01-01; `due_on=2026-10-03`.", async () => {
  assert.deepEqual(valuationDenialWindows(D("2026-09-03")), { appeal_by: D("2026-11-02"), valid_until: D("2027-01-01") });
  assert.equal(denialDue({ received_on: D("2026-08-20"), evidence_satisfied_on: D("2026-09-03"), scheduled_termination_on: null, state: "TX" }), D("2026-10-03"));
  assert.equal(ltvBps(37052240n, 49000000n), 7561);
  const h = harness("2026-08-20T15:00:00.000Z", "L-63");
  h.raise("mi.cancel.requested", { received_at: "2026-08-20", channel: "written", basis: "current_value" });
  // the borrower-paid BPO delivered 2026-09-03 re-anchors the HPA clock (evidence) and opens the Fannie Mae denial and appeal clocks
  h.clock.set("2026-09-03T15:00:00.000Z");
  await h.run("10.1", "smdu.*", { op: "valuation.delivered", loan_id: "L-63", kind: "bpo", value_cents: 49000000n, delivered_on: "2026-09-03", received_on: "2026-08-20", borrower_paid: true });
  assert.equal(h.latest("HPA_4904B_DENIAL_NOTICE_30").dueDate, D("2026-10-03")); assert.equal(h.latest("FNMA_B8104_DENIAL_NOTICE_30").dueDate, D("2026-10-03")); assert.equal(h.latest("FNMA_SMDU_VALUATION_APPEAL_60").dueDate, D("2026-11-02"));
  h.clock.set("2026-09-05T15:00:00.000Z");
  const d = (await h.run("10.1", "pmi.*", { op: "evaluate", loan_id: "L-63", path: "current_value", received_on: "2026-08-20", decision_on: "2026-09-05", evidence_satisfied_on: "2026-09-03", original_value_cents: 40000000n, valuation_cents: 49000000n, valuation_delivered_on: "2026-09-03", evaluation_upb_cents: 37052240n, consummation: "2024-03-15", installments: installmentLedger(28, {}, D("2026-09-01")) })) as Evaluated;
  assert.equal(d.result, "ineligible"); assert.deepEqual(d.reasons, ["LTV_ABOVE_THRESHOLD_CURRENT"]); assert.equal(d.threshold_bps, 7500); assert.equal(d.ltv_bps, 7561);
  const c = composeDenial(composeDeps(h), { loan_id: "L-63", evaluation_id: d.evaluation_id, notice_date: D("2026-09-05"), identity: h.sample("NTC_HPA_4904B_DENIAL"), state: "TX" });
  assert.equal(c.due_on, D("2026-10-03")); assert.equal(h.rt.store.get("mi_denials", c.denial_id)!.data.due_on, D("2026-10-03"));
  assert.deepEqual(c.appeal, { valuation_kind: "bpo", appeal_by: D("2026-11-02"), valid_until: D("2027-01-01") });
  assert.equal(c.payload.valuation_text, "This determination used a broker price opinion of $490,000.00 delivered 2026-09-03. Because it did not support cancellation, you may appeal it through us until 2026-11-02; the valuation remains valid until 2027-01-01.");
  assert.equal(c.payload.cure_text, "a balance of $367,500.00 or less would meet the 75 percent threshold."); assert.equal(c.payload.path_text, "Fannie Mae current value (29 months of seasoning)"); assert.equal(c.payload.value_label, "current value");
  const n = (await h.run("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-63", evaluation_id: d.evaluation_id, recipients: BORROWER, payload: c.payload })) as Sent;
  for (const s of ["$490,000.00", "2026-09-03", "2026-11-02", "2027-01-01", "$367,500.00", "75.61%", "75.00%"]) assert.ok(n.rendered.text.includes(s), s);
  assert.equal(n.status, "sent"); assert.ok(n.sentAt.slice(0, 10) <= "2026-10-03");
  assert.equal(h.latest("HPA_4904B_DENIAL_NOTICE_30").status, "satisfied"); assert.equal(h.latest("FNMA_B8104_DENIAL_NOTICE_30").status, "satisfied"); assert.equal(h.latest("FNMA_SMDU_VALUATION_APPEAL_60").status, "armed");
});
test("10.6-T4: Given evidence received 2026-09-25 on a case received 2026-08-27, then `due_on` re-anchors to 2026-10-25 and the timer history shows both anchors.", async () => {
  assert.equal(decisionDue(D("2026-08-27"), D("2026-09-25")), D("2026-10-25")); assert.equal(decisionDue(D("2026-08-27"), null), D("2026-09-26"));
  assert.equal(denialDue({ received_on: D("2026-08-27"), evidence_satisfied_on: D("2026-09-25"), scheduled_termination_on: null, state: "TX" }), D("2026-10-25"));
  const h = harness("2026-08-27T15:00:00.000Z", "L-64");
  h.raise("mi.cancel.requested", { received_at: "2026-08-27", channel: "written" });
  const first = h.latest("HPA_4904B_DENIAL_NOTICE_30"); assert.equal(first.anchorDate, D("2026-08-27")); assert.equal(first.dueDate, D("2026-09-26"));
  h.clock.set("2026-09-25T15:00:00.000Z");
  await h.run("10.1", "ledger.post", { loan_id: "L-64", valuation_fee: true, fee_cents: 19000n, funding_account: "corporate_clearing", received_on: "2026-09-25", entry_set: { effectiveDate: "2026-09-25", description: "BPO fee receipt", lines: [{ account: { scope: "custodial", custodialAccountId: "C-CLR", account: "clearing_cash" }, amountCents: 19000n, ruleRef: "10.1 ledger: fee receipt" }, { account: { scope: "corporate", account: "fnma_payable" }, amountCents: -19000n, ruleRef: "10.1 ledger: mi_valuation_fee_payable" }] } });
  const history = h.timer("HPA_4904B_DENIAL_NOTICE_30");
  assert.deepEqual(history.map((t) => [t.anchorDate, t.dueDate, t.status]), [[D("2026-08-27"), D("2026-09-26"), "cancelled"], [D("2026-09-25"), D("2026-10-25"), "armed"]]);
  assert.match(history[0]!.cancelledReason!, /re-anchored on borrower evidence received 2026-09-25/);
  assert.deepEqual(h.events.all().filter((e) => e.type.startsWith("timer.") && e.payload.code === "HPA_4904B_DENIAL_NOTICE_30").map((e) => e.type), ["timer.armed", "timer.cancelled", "timer.armed"]);
});
test("10.6-T5: Given an automatic non-termination on 2035-07-01, then `NTC_HPA_4904B_AUTO_NOT_CURRENT` is sent by 2035-07-31 naming the June 2035 installment.", async () => {
  assert.equal(denialDue({ received_on: null, evidence_satisfied_on: null, scheduled_termination_on: D("2035-07-01"), state: "TX" }), D("2035-07-31"));
  const h = harness("2035-07-01T05:30:00.000Z", "L-65");
  // the sweep on 2035-07-01 sees the June 2035 installment still unpaid at the June month-end
  const r = (await h.run("10.2", "pmi.terminate", { loan_id: "L-65", scheduled_date: "2035-07-01", installments: installmentLedger(140, { "2035-06-01": null }, D("2035-07-01")) })) as { result: { status: string }; not_current_notice: { code: string; send_by: string; grounds_text: string } };
  assert.equal(r.result.status, "deferred_not_current"); assert.equal(r.not_current_notice.code, "NTC_HPA_4904B_AUTO_NOT_CURRENT"); assert.equal(r.not_current_notice.send_by, D("2035-07-31"));
  const t = h.latest("HPA_4904B2B_AUTO_NOT_CURRENT_NOTICE_30"); assert.equal(t.anchorDate, D("2035-07-01")); assert.equal(t.dueDate, D("2035-07-31"));
  assert.equal(h.events.ofType("mi.terminated").length, 0);
  h.clock.set("2035-07-05T15:00:00.000Z");
  const n = (await h.run("10.2", "notices.*", { template_code: "NTC_HPA_4904B_AUTO_NOT_CURRENT", loan_id: "L-65", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4904B_AUTO_NOT_CURRENT"), notice_date: "2035-07-05", scheduled_termination_on: "2035-07-01", grounds_text: r.not_current_notice.grounds_text } })) as { status: string; rendered: { text: string } };
  assert.equal(n.status, "sent"); assert.match(n.rendered.text, /because the June 2035 payment was not received by 2035-06-30/);
  assert.equal(t.status, "satisfied"); assert.ok(t.satisfiedAt!.slice(0, 10) <= "2035-07-31");
});
test("10.6-T6: Given an MN loan and a request missing the property-occupancy confirmation, then `NTC_MI_INFO_REQUEST` is sent within 30 days of receipt and the MN timer is satisfied.", async () => {
  const r = infoRequest({ state: "MN", received_on: D("2026-09-01"), missing: ["property occupancy confirmation"] });
  assert.equal(r.notice, "NTC_MI_INFO_REQUEST"); assert.equal(r.send_by, D("2026-10-01")); assert.equal(r.satisfies, "MN_47_207_RESPONSE_30"); assert.equal(r.closes_after_days, 60);
  assert.equal(infoRequest({ state: "TX", received_on: D("2026-09-01"), missing: ["x"] }).satisfies, null); assert.equal(infoRequest({ state: "MN", received_on: D("2026-09-01"), missing: [] }).notice, null);
  // the MN owner-occupied request arms the §47.207 subd. 4 clock: 30 calendar days from receipt
  const h = harness("2026-09-03T15:00:00.000Z", "L-66");
  h.raise("mi.cancel.requested", { received_at: "2026-09-01", channel: "written", state: "MN", owner_occupied: true });
  const t = h.latest("MN_47_207_RESPONSE_30"); assert.equal(t.anchorDate, D("2026-09-01")); assert.equal(t.dueDate, D("2026-10-01")); assert.equal(t.status, "armed");
  const c = composeInfoRequest(composeDeps(h), { loan_id: "L-66", received_on: D("2026-09-01"), state: "MN", missing: ["confirmation that you occupy the property as your principal residence"], notice_date: D("2026-09-03"), identity: h.sample("NTC_MI_INFO_REQUEST") });
  assert.equal(c.due_on, D("2026-10-01")); assert.equal(c.closes_after_days, 60); assert.equal(c.payload.mn_overlay, true);
  const n = (await h.run("10.6", "notices.*", { template_code: "NTC_MI_INFO_REQUEST", loan_id: "L-66", recipients: BORROWER, payload: c.payload })) as Sent;
  assert.equal(n.status, "sent"); assert.ok(n.sentAt.slice(0, 10) <= "2026-10-01");
  for (const s of ["confirmation that you occupy the property as your principal residence", "within 60 days of this notice, we will close the request", "response within 30 days of receipt under Minnesota Statutes section 47.207"]) assert.ok(n.rendered.text.includes(s), s);
  assert.equal(t.status, "satisfied"); assert.ok(t.satisfiedAt!.slice(0, 10) <= "2026-10-01"); assert.equal(t.satisfiedByEventId, h.events.ofType("notice.sent")[0]!.id);
  const row = h.rt.store.get("mi_denials", c.denial_id)!.data; assert.equal(row.kind, "info_request"); assert.equal(row.status, "sent"); assert.equal(row.notice_id, n.id); assert.equal(row.due_on, D("2026-10-01"));
});
test(`10.6-T7: Given a borrower letter "you miscounted my late payment" received 2027-07-20, then a NoE case opens with acknowledgment within 5 business days and the PMI case is linked.`, async () => {
  assert.deepEqual(disputeRoute({ asserts_error: true, valuation_disagreement: false, requests_human: false }), ["noe"]);
  assert.equal(noeAckDue(D("2027-07-20")), D("2027-07-27")); assert.equal(addBusinessDays(D("2027-07-20"), 5, federal), D("2027-07-27"));
  // §4.1's acknowledgment clock is registered under process 4.1: the harness runs it alongside §10
  const h = harness("2027-07-13T15:00:00.000Z", "L-67", [...PROCESSES_10, "4.1"]);
  const d = (await h.run("10.1", "pmi.*", ltvDenialRequest("L-67", "2027-07-13"))) as Evaluated; assert.equal(d.result, "ineligible");
  h.clock.set("2027-07-20T15:00:00.000Z");
  const c = (await h.run("10.6", "case.noe.open", { loan_id: "L-67", received_on: "2027-07-20", pmi_case_id: "pmi-L-67", evaluation_id: d.evaluation_id, assertion: "you miscounted my late payment" })) as { id: string; case_type: string; ack_due: string; response_due: string; pmi_case_id: string; status: string; linked_case_ids: string[] };
  assert.equal(c.case_type, "noe"); assert.equal(c.ack_due, D("2027-07-27")); assert.equal(c.response_due, D("2027-08-31")); assert.equal(c.pmi_case_id, "pmi-L-67"); assert.deepEqual(c.linked_case_ids, ["pmi-L-67"]); assert.equal(c.status, "open");
  // the §4.1 record: (b)(1)–(3) payment-related assertion, standard profile, ack required — the 4.1 clocks arm on `receipt_date`
  const ev = h.events.ofType("case.noe.opened")[0]!;
  assert.equal(ev.payload.case_id, c.id); assert.equal(ev.payload.receipt_date, D("2027-07-20")); assert.equal(ev.payload.ack_required, true); assert.equal(ev.payload.std_assertion, true); assert.equal(ev.payload.payment_related, true);
  assert.equal(ev.payload.pmi_case_id, "pmi-L-67"); assert.equal(ev.payload.evaluation_id, d.evaluation_id); assert.equal(ev.payload.source, "denial_dispute");
  const ack = h.latest("REGX_1024_35D_NOE_ACK_5"); assert.equal(ack.anchorDate, D("2027-07-20")); assert.equal(ack.dueDate, D("2027-07-27")); assert.equal(ack.armedByEventId, ev.id); assert.equal(ack.status, "armed");
  assert.equal(h.latest("REGX_1024_35E_NOE_RESPONSE_30").dueDate, D("2027-08-31"));
  assert.equal(h.ctx.decisions.at(-1)!.action, "case.noe.open");
  // a dispute that names no PMI case is refused: the NoE from a denial links the PMI case
  await assert.rejects(h.run("10.6", "case.noe.open", { loan_id: "L-67", received_on: "2027-07-20", assertion: "you miscounted my late payment" }), /pmi_case_id is required/);
  // acknowledgment within 5 business days: the §4.1 acknowledgment letter sent 2027-07-22 satisfies the clock
  const v4 = SECTION_04_VERSIONS.find((v) => v.templateCode === "NTC_REGX_35D_ACK")!;
  h.registry.publish("NTC_REGX_35D_ACK", v4.version, "counsel", "2026-09-01T00:00:00.000Z", publishCheck);
  h.clock.set("2027-07-22T15:00:00.000Z");
  const a = (await h.run("10.6", "notices.*", { template_code: "NTC_REGX_35D_ACK", loan_id: "L-67", case_id: c.id, recipients: BORROWER, payload: { ...v4.samplePayload, received_on: "2027-07-20", business_days_after_receipt: 2, assertions: [{ n: 1, text: "you miscounted my late payment", response_due: "2027-08-31" }] } })) as Sent;
  assert.equal(a.status, "sent"); assert.ok(a.sentAt.slice(0, 10) <= "2027-07-27");
  assert.equal(ack.status, "satisfied"); assert.ok(ack.satisfiedAt!.slice(0, 10) <= "2027-07-27");
});
test("10.6-T8: Given a human-review request, then a `human_agent` task with the package is created and closed within 10 BD with an outcome letter; a reversal triggers a grant effective 2027-07-10 and a refund of premiums collected since.", async () => {
  assert.deepEqual(disputeRoute({ asserts_error: false, valuation_disagreement: false, requests_human: true }), ["human_review"]);
  assert.equal(humanReviewDue(D("2027-07-20")), D("2027-08-03"));
  const h = harness("2027-07-13T15:00:00.000Z", "L-68");
  h.raise("mi.cancel.requested", { received_at: "2027-07-10", channel: "written" });
  const d = (await h.run("10.1", "pmi.*", ltvDenialRequest("L-68", "2027-07-13"))) as Evaluated; assert.equal(d.result, "ineligible");
  const c = composeDenial(composeDeps(h), { loan_id: "L-68", evaluation_id: d.evaluation_id, notice_date: D("2027-07-14"), identity: h.sample("NTC_HPA_4904B_DENIAL"), state: "TX", schedule: WORKED_SCHEDULE });
  h.clock.set("2027-07-14T15:00:00.000Z");
  await h.run("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-68", evaluation_id: d.evaluation_id, recipients: BORROWER, payload: c.payload });
  // the borrower's response (portal / classified mail) is ingested: `mi.denial.disputed` → human review requested, 10 BD clock, `human_agent` task with the package
  h.clock.set("2027-07-20T15:00:00.000Z");
  h.raise("mi.denial.disputed", { received_on: "2027-07-20", evaluation_id: d.evaluation_id, requests_human: true, text: "I would like a person to review this decision" });
  const req = h.events.ofType("mi.human_review.requested")[0]!;
  assert.equal(req.payload.request_date, D("2027-07-20")); assert.equal(req.payload.evaluation_id, d.evaluation_id); assert.equal(req.payload.denial_id, c.denial_id); assert.equal(req.payload.due, D("2027-08-03"));
  const pkg = req.payload.package as { evaluation_inputs: { ltv_bps: number; reasons: string[] }; payment_history: { late30_12m: number; installments: unknown[] }; valuation_report: unknown; rule_citations: string[] };
  assert.equal(pkg.evaluation_inputs.ltv_bps, 8388); assert.deepEqual(pkg.evaluation_inputs.reasons, ["LTV_ABOVE_THRESHOLD"]); assert.equal(pkg.payment_history.late30_12m, 0); assert.equal(pkg.valuation_report, null); assert.ok(pkg.rule_citations.includes("B-8.1-04"));
  const t = h.latest("SM_MI_HUMAN_REVIEW_10BD"); assert.equal(t.anchorDate, D("2027-07-20")); assert.equal(t.dueDate, D("2027-08-03")); assert.equal(t.armedByEventId, req.id); assert.equal(t.status, "armed");
  const reg = loadOverriddenRegistry(); assert.ok(eventMatches(reg.get("SM_MI_HUMAN_REVIEW_10BD")!.triggerPattern!, req));
  const task = h.escalations.opened.find((e) => e.kind === "human_agent")!;
  assert.equal(task.ownerRole, "human_agent"); assert.equal(task.loanId, "L-68"); assert.equal(task.slaTimerId, t.id); assert.equal(task.status, "open"); assert.deepEqual(task.payload.package, req.payload.package);
  const routed = h.events.ofType("mi.denial.dispute.routed")[0]!; assert.deepEqual(routed.payload.routes, ["human_review"]); assert.equal(routed.payload.human_review_id, req.payload.review_id);
  assert.equal(h.rt.store.get("mi_denials", c.denial_id)!.data.status, "human_review"); assert.ok(h.rt.store.get("mi_denials", c.denial_id)!.data.human_review_requested_at);
  // closed within 10 BD with an outcome letter: the human agent delivers the reversal letter on 2027-07-28 (documents.deliver)
  h.clock.set("2027-07-28T15:00:00.000Z");
  const out = (await h.run("10.6", "documents.deliver", { loan_id: "L-68", document_id: "doc-outcome-letter", human_review_id: req.payload.review_id, outcome: "reversed", qualified_on: "2027-07-10", premiums_collected: [{ on: "2027-07-01", amount_cents: 19000n }, { on: "2027-07-25", amount_cents: 19000n }] }, HUMAN_AGENT)) as { delivered: boolean; review: HumanReviewClosed };
  assert.equal(out.delivered, true); assert.equal(out.review.outcome, "reversed"); assert.equal(out.review.completed_on, D("2027-07-28")); assert.equal(out.review.on_time, true);
  assert.equal(task.status, "completed"); assert.equal(task.evidenceDocumentId, "doc-outcome-letter");
  const done = h.events.ofType("mi.human_review.completed")[0]!;
  assert.equal(done.payload.outcome, "reversed"); assert.equal(done.payload.outcome_letter_document_id, "doc-outcome-letter"); assert.equal(done.payload.grant_effective_on, D("2027-07-10")); assert.equal(done.payload.refund_cents, 19000n);
  assert.ok(eventMatches(reg.get("SM_MI_HUMAN_REVIEW_10BD")!.satisfiedPattern!, done));
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, done.id); assert.ok(t.satisfiedAt!.slice(0, 10) <= "2027-08-03");
  assert.equal(h.rt.store.get("mi_denials", c.denial_id)!.data.human_review_outcome, "reversed");
  // reversal → grant as of the date the borrower originally qualified, with the premiums collected since refunded (10.5)
  const g = out.review.grant!;
  assert.equal(g.effective_on, D("2027-07-10")); assert.equal(g.refund_cents, 19000n); assert.deepEqual(g.refunded.map((p) => p.on), [D("2027-07-25")]); assert.equal(g.refund_process, "10.5");
  assert.deepEqual(reversalGrant({ qualified_on: D("2027-07-10"), premiums_collected: [{ on: D("2027-07-01"), amount_cents: 19000n }, { on: D("2027-07-25"), amount_cents: 19000n }] }).refund_cents, 19000n);
  const cx = (await h.run("10.1", "pmi.*", { op: "cancel", loan_id: "L-68", evaluation: { result: "eligible", effective_on: g.effective_on, lar89_action_code: "51", evaluation_id: "eval-L-68-review" }, received_on: "2027-07-10" })) as { event: string; effective: string; refund_id: string };
  assert.equal(cx.event, "mi.cancelled"); assert.equal(cx.effective, D("2027-07-10"));
  assert.equal(h.latest("HPA_4902F1_REFUND_45").dueDate, D("2027-08-24")); assert.equal(h.rt.store.get("mi_refunds", cx.refund_id)!.data.status, "estimated");
  // a second outcome on the same review is refused; an outcome without the letter never closes the clock
  assert.throws(() => completeHumanReview({ events: h.events, store: h.rt.store, actor: HUMAN_AGENT, now: h.clock.now(), escalations: h.escalations }, { review_id: String(req.payload.review_id), outcome: "upheld", outcome_letter_document_id: "doc-2" }), /is completed/);
});
test("10.6-T9: Given an attempt to send a denial without a linked evaluation row, then the send command is rejected.", async () => {
  assert.equal(denialSendAllowed(null), false); assert.equal(denialSendAllowed("eval-1"), true);
  const h = harness("2027-07-14T15:00:00.000Z", "L-69");
  const before = h.seq();
  // no evaluation at all
  const e = await h.refused("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-69", recipients: BORROWER, payload: h.sample("NTC_HPA_4904B_DENIAL") });
  assert.equal(e.code, "DENIAL_NEEDS_EVALUATION"); assert.deepEqual(h.since(before).map((x) => x.type), ["command.refused"]); assert.equal(h.notices.all().length, 0);
  // an evaluation id that is not on the loan's record (`mi.evaluation.completed`) is not a linked row
  const e2 = await h.refused("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-69", evaluation_id: "eval-does-not-exist", recipients: BORROWER, payload: h.sample("NTC_HPA_4904B_DENIAL") });
  assert.equal(e2.code, "DENIAL_NEEDS_EVALUATION"); assert.match(e2.message, /no mi_evaluations row eval-does-not-exist/); assert.equal(h.notices.all().length, 0);
  assert.throws(() => composeDenial(composeDeps(h), { loan_id: "L-69", evaluation_id: "eval-does-not-exist", notice_date: D("2027-07-14") }), /no mi_evaluations row/);
  // an eligible evaluation on record is not a denial either
  const ok = (await h.run("10.1", "pmi.*", { op: "evaluate", loan_id: "L-69", received_on: "2027-07-10", decision_on: "2027-07-14", original_value_cents: 40000000n, evaluation_upb_cents: 31995095n, consummation: "2024-03-15", avm_cents: 45500000n, installments: installmentLedger(40, {}, D("2027-07-01")) })) as Evaluated;
  assert.equal(ok.result, "eligible");
  assert.match((await h.refused("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-69", evaluation_id: ok.evaluation_id, recipients: BORROWER, payload: h.sample("NTC_HPA_4904B_DENIAL") })).message, /is eligible, not ineligible/);
  // with the ineligible evaluation linked: the agent may not supply the due date (the Timer Engine computes it) nor soften the denial into a partial grant
  const d = (await h.run("10.1", "pmi.*", ltvDenialRequest("L-69", "2027-07-14"))) as Evaluated; assert.equal(d.result, "ineligible");
  assert.equal((await h.refused("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-69", evaluation_id: d.evaluation_id, recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4904B_DENIAL"), due_on: "2027-08-09" } })).code, "DUE_DATE_FROM_TIMER_ENGINE");
  assert.equal((await h.refused("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-69", evaluation_id: d.evaluation_id, recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4904B_DENIAL"), grounds_text: "your request is partially approved: coverage reduced by half." } })).code, "NO_PARTIAL_GRANT");
  const n = (await h.run("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-69", evaluation_id: d.evaluation_id, recipients: BORROWER, payload: h.sample("NTC_HPA_4904B_DENIAL") })) as { status: string };
  assert.equal(n.status, "sent");
});
test("10.6-T10: Given 10% monthly QC sampling, then sampled denials are marked and the QC findings feed `qc_finding` cases.", () => {
  const denials = Array.from({ length: 20 }, (_, i) => ({ id: `den-${String(i + 1).padStart(2, "0")}`, reason: "LTV_ABOVE_THRESHOLD" }));
  const r = qcSample(denials);
  assert.equal(r.sampled_ids.length, 2); assert.equal(r.marked.filter((d) => d.qc_sampled).length, 2);
  assert.ok(r.cases.every((c) => c.case_type === "qc_finding" && c.status === "open" && r.sampled_ids.includes(c.denial_id)));
  assert.deepEqual(qcSample(denials).sampled_ids, r.sampled_ids);
});

test("10.6 R4 dispute routing: a valuation disagreement appeals only a non-AVM valuation that did not support termination; an error assertion opens the NoE with the PMI case", async () => {
  const h = harness("2026-09-05T15:00:00.000Z", "L-70");
  await h.run("10.1", "smdu.*", { op: "valuation.delivered", loan_id: "L-70", kind: "bpo", value_cents: 49000000n, delivered_on: "2026-09-03", received_on: "2026-08-20", borrower_paid: true });
  const d = (await h.run("10.1", "pmi.*", { op: "evaluate", loan_id: "L-70", path: "current_value", received_on: "2026-08-20", decision_on: "2026-09-05", evidence_satisfied_on: "2026-09-03", original_value_cents: 40000000n, valuation_cents: 49000000n, valuation_delivered_on: "2026-09-03", evaluation_upb_cents: 37052240n, consummation: "2024-03-15", installments: installmentLedger(28, {}, D("2026-09-01")) })) as Evaluated;
  composeDenial(composeDeps(h), { loan_id: "L-70", evaluation_id: d.evaluation_id, notice_date: D("2026-09-05"), identity: h.sample("NTC_HPA_4904B_DENIAL"), state: "TX" });
  h.clock.set("2026-09-20T15:00:00.000Z");
  h.raise("mi.denial.disputed", { received_on: "2026-09-20", evaluation_id: d.evaluation_id, asserts_error: true, valuation_disagreement: true, requests_human: false, text: "you miscounted my late payment and the BPO is too low", valuation_id: "val-L-70", valuation_kind: "bpo", valuation_supported_termination: false });
  const routed = h.events.ofType("mi.denial.dispute.routed")[0]!;
  assert.deepEqual(routed.payload.routes, ["noe", "smdu_appeal"]); assert.equal(routed.payload.appeal_valuation_id, "val-L-70");
  assert.equal(h.events.ofType("mi.valuation.appeal_requested")[0]!.payload.valuation_id, "val-L-70"); assert.equal(h.events.ofType("case.noe.opened")[0]!.payload.pmi_case_id, "den-L-70-1");
  assert.equal(h.events.ofType("mi.human_review.requested").length, 0);
  // an AVM disagreement is rejected at ingestion (SMDU FAQ Q19) and recorded, not routed
  h.raise("mi.denial.disputed", { received_on: "2026-09-21", evaluation_id: d.evaluation_id, valuation_disagreement: true, valuation_id: "val-avm", valuation_kind: "avm" });
  assert.match(String(h.events.ofType("integration_messages.rejected").at(-1)!.payload.message), /AVM value may not be appealed/);
  // the human-review request needs a completed evaluation on the loan
  assert.throws(() => requestHumanReview({ events: h.events, store: h.rt.store, actor: PMI_AGENT, now: h.clock.now(), timers: h.timers, escalations: h.escalations }, { loan_id: "L-70", requested_on: D("2026-09-21"), evaluation_id: "eval-nope" }), /no mi_evaluations row/);
});
test("10.6 worked figure: current-value denial UPB $370,522.40 at BPO $490,000 → 75.62% > 75%", () => { assert.equal(ltvBps(37052240n, 49000000n), 7561); /* R3 floors: 75.61% (the spec prints the rounded 75.62%) */ });
