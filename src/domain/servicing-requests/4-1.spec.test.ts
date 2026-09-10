// 4.1 Notice of Error (NoE) resolution
// spec/sections/04-customer-service-borrower-communications/4-1-notice-of-error-noe-resolution.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
void cents;
import * as N from "./noe.ts";
import { federalDays } from "./clocks.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";
import { goodFaithResponse, splitOverbroad, documentRequest, earlyCorrection, nyNoeDeadline, nyExtension, triageWithConfidence, manifestWatch, noeCommunicationCheck, boardOpenNoe, expireCreditSuppressions } from "./ops.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { SYSTEM } from "../../kernel/events/index.ts";
import { servicerCalendar, defaultCalendars } from "../../kernel/calendar/business.ts";
import type { CommandSpec } from "../../app/commands.ts";
import type { ToolInput } from "../../app/tools.ts";
import { FC_NOE_OPEN, withFcNoeGate, foreclosureHoldPackage } from "../../app/tools/section04.ts";
import { harness, CASE_AGENT, OFFICER, ATTORNEY, refusedWith } from "./test-harness.ts";
void SYSTEM;
const notice = (h: ReturnType<typeof harness>, template: string, caseId: string, extra: Record<string, unknown> = {}) => h.events.append({ type: "notice.sent", loanId: "L-1", actor: CASE_AGENT, payload: { template, case_id: caseId, notice_id: `n-${template}-${caseId}`, ...extra } });
const noError = (assertion_id: string, snapshot: string) => ({ assertion_id, determination: "no_error", snapshot_ids: [snapshot], statement_of_reasons: "the record shows the servicer acted as the loan terms and the rule require" });

test("4.1-T1: (happy path) Given a written letter received 2026-09-04 asserting a misapplied 2026-03-01 payment, when classified, then a `noe` case with assertion `b2` exists, ack mailed ≤2026-09-14, response by 2026-10-20, ledger shows reversal + repost dated 2026-03-01, late charge 9,211¢ reversed, suppression row through 2026-11-03.", async () => {
  const h = harness("2026-09-04T14:00:00.000Z");
  // the misapplied payment as posted on 2026-03-17: $2,454.57 = $1,842.17 P&I + $612.40 escrow
  const orig = h.ctx.ledger.post({ effectiveDate: D("2026-03-17"), description: "payment allocation 2026-03", lines: [
    { account: { scope: "custodial", custodialAccountId: "C-CL", account: "clearing_cash" }, amountCents: 245_457n, ruleRef: "2.1:r8" },
    { account: { scope: "loan", loanId: "L-1", account: "principal" }, amountCents: -60_000n, ruleRef: "2.1:r8" },
    { account: { scope: "loan", loanId: "L-1", account: "interest_due" }, amountCents: -124_217n, ruleRef: "2.1:r8" },
    { account: { scope: "loan", loanId: "L-1", account: "escrow" }, amountCents: -61_240n, ruleRef: "2.1:r8" }] });
  await assert.rejects(h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-0", receipt_date: "2026-09-04", channel: "mail", assertions: [] }), refusedWith("NOE_NEEDS_ASSERTION"));
  await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-1", receipt_date: "2026-09-04", channel: "mail", assertions: [{ id: "a1", category: "b2", description: "my 2026-03-01 payment was applied on 2026-03-17", period: "2026-03" }] });
  assert.equal(h.rt.store.get("cases", "noe-1")!.data.case_type, "noe"); assert.equal(h.rt.store.get("case_assertions", "noe-1:a1")!.data.category, "b2");
  const due = (code: string) => h.timer(code)[0]?.dueDate;
  assert.equal(due("REGX_1024_35D_NOE_ACK_5"), "2026-09-14"); assert.equal(due("REGX_1024_35E_NOE_RESPONSE_30"), "2026-10-20"); assert.equal(due("REGX_1024_35I_CREDIT_SUPPRESS_60"), "2026-11-03");
  for (const c of ["REGX_1024_35E_NOE_PAYOFF_RESPONSE_7", "REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30", FC_NOE_OPEN, "REGX_1024_35F2_FC_GOODFAITH_RESPONSE"]) assert.equal(h.timer(c).length, 0, `${c} is not a b2 clock`);
  const sup = h.rt.store.get("credit_reporting_suppressions", "noe-1")!.data; assert.equal(sup.ends_at, "2026-11-03"); assert.deepEqual(sup.scope, ["2026-03"]); assert.equal(sup.reason, "regx_1024_35_i");
  assert.deepEqual(expireCreditSuppressions(h.events, [sup as { loan_id: string; case_id: string; ends_at: PlainDate }], D("2026-11-03")), []);                       // still in force on the last day
  assert.deepEqual(expireCreditSuppressions(h.events, [sup as { loan_id: string; case_id: string; ends_at: PlainDate }], D("2026-11-04")), [{ loan_id: "L-1", case_id: "noe-1" }]);
  assert.equal(h.timer("REGX_1024_35I_CREDIT_SUPPRESS_60")[0]!.status, "satisfied");                                           // 'expiry' = the sweep's credit_reporting.suppression.expired
  h.clock.set("2026-09-10T15:00:00.000Z"); notice(h, "NTC_COMPLAINT_ACK", "cmp-x");
  assert.equal(h.timer("REGX_1024_35D_NOE_ACK_5")[0]!.status, "armed");                                                        // another template on the loan is not the ack
  notice(h, "NTC_REGX_35D_ACK", "noe-1");
  assert.equal(h.timer("REGX_1024_35D_NOE_ACK_5")[0]!.status, "satisfied");                                                    // ack mailed on 09-10 ≤ 09-14
  const re = (await h.run("4.1", "payment.reapply", CASE_AGENT, { case_id: "noe-1", original_set_id: orig.id, effective_date: "2026-03-01" })).output as { reversal_set_id: string; repost_set_id: string; amount_cents: bigint };
  assert.equal(re.amount_cents, 245_457n);                                                                                       // measured on the set re-posted, not on a stated amount
  const sets = h.ctx.ledger.sets(); const reversal = sets.find((s) => s.id === re.reversal_set_id)!, repost = sets.find((s) => s.id === re.repost_set_id)!;
  assert.equal(reversal.effectiveDate, "2026-03-01"); assert.equal(reversal.reversesSetId, orig.id); assert.equal(repost.effectiveDate, "2026-03-01");
  assert.deepEqual(repost.lines.map((l) => l.amountCents), orig.lines.map((l) => l.amountCents)); assert.deepEqual(reversal.lines.map((l) => l.amountCents), orig.lines.map((l) => -l.amountCents));
  await h.run("4.1", "fee.reverse", CASE_AGENT, { case_id: "noe-1", fee_account: "late_charges", amount_cents: 9_211n, effective_date: "2026-03-17", reason: "late charge on a payment that was not late (comment 35(b)-2)" });
  assert.equal(h.ctx.ledger.balance({ scope: "loan", loanId: "L-1", account: "late_charges" }), -9_211n);
  assert.deepEqual(h.events.ofType("fee.reversed").map((e) => e.payload.amount_cents), ["9211"]); assert.equal(h.events.ofType("payment.reapplied").length, 1);
  // guardrails: the $5,000 threshold (500,000¢) needs the officer — as the actor, or as a recorded approval the agent cites; an id no officer recorded is refused
  await assert.rejects(h.run("4.1", "fee.reverse", CASE_AGENT, { case_id: "noe-1", fee_account: "other_fees", amount_cents: 600_000n }), refusedWith("CORRECTION_MAX_CENTS"));
  await assert.rejects(h.run("4.1", "fee.reverse", CASE_AGENT, { case_id: "noe-1", fee_account: "other_fees", amount_cents: 600_000n, officer_approval_id: "made-up" }), refusedWith("CORRECTION_MAX_CENTS"));
  await assert.rejects(h.run("4.1", "case.approval.record", CASE_AGENT, { approval_id: "appr-agent", case_id: "noe-1", scope: "fee.reverse", amount_cents: 600_000n }), refusedWith("HUMAN_ONLY"));
  await h.approve(OFFICER, { approval_id: "appr-fee", case_id: "noe-1", scope: "fee.reverse", amount_cents: 600_000n, rationale: "force-placed premium not permitted by §1024.37" });
  assert.equal(h.decisions.at(-1)!.approvedRole, "officer");
  await assert.rejects(h.run("4.1", "fee.reverse", CASE_AGENT, { case_id: "noe-1", fee_account: "other_fees", amount_cents: 700_000n, officer_approval_id: "appr-fee" }), refusedWith("CORRECTION_MAX_CENTS"));   // the approval covers 600,000¢, not 700,000¢
  await h.run("4.1", "fee.reverse", CASE_AGENT, { case_id: "noe-1", fee_account: "other_fees", amount_cents: 600_000n, officer_approval_id: "appr-fee" });
  await h.run("4.1", "fee.reverse", OFFICER, { case_id: "noe-1", fee_account: "other_fees", amount_cents: 600_000n });
  // the threshold measures the money posted: a stated amount_cents of 100¢ does not let a ±1,000,000¢ entry set through, nor an omitted amount
  const big = { effectiveDate: D("2026-03-01"), description: "escrow re-class", lines: [{ account: { scope: "loan" as const, loanId: "L-1", account: "escrow" as const }, amountCents: 1_000_000n, ruleRef: "4.1:r6:escrow_correction" }, { account: { scope: "loan" as const, loanId: "L-1", account: "suspense_unapplied" as const }, amountCents: -1_000_000n, ruleRef: "4.1:r6:escrow_correction" }] };
  await assert.rejects(h.run("4.1", "escrow.correct", CASE_AGENT, { case_id: "noe-1", amount_cents: 100n, entry_set: big }), refusedWith("CORRECTION_MAX_CENTS"));
  await assert.rejects(h.run("4.1", "suspense.apply", CASE_AGENT, { case_id: "noe-1", entry_set: big }), refusedWith("CORRECTION_MAX_CENTS"));
  await assert.rejects(h.run("4.1", "payment.reapply", CASE_AGENT, { case_id: "noe-1", original_set_id: h.ctx.ledger.post(big, h.clock.now()).id, effective_date: "2026-03-01" }), refusedWith("CORRECTION_MAX_CENTS"));
  await assert.rejects(h.run("4.1", "fee.reverse", CASE_AGENT, { fee_account: "late_charges", amount_cents: 100n }), refusedWith("CASE_ID_REQUIRED"));
  await assert.rejects(h.run("4.1", "fee.reverse", CASE_AGENT, { case_id: "noe-nope", fee_account: "late_charges", amount_cents: 100n }), refusedWith("CASE_NOT_FOUND"));
  // determination guards read the record: no no_error without a snapshot, without reasons, or without the record types a b2 assertion implicates
  await assert.rejects(h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-1", assertion_id: "a1", determination: "no_error", statement_of_reasons: "the payment posted on the day received" }), refusedWith("NO_ERROR_WITHOUT_SNAPSHOT"));
  await assert.rejects(h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-1", assertion_id: "a1", determination: "no_error", snapshot_ids: ["snap-1"] }), refusedWith("NO_ERROR_WITHOUT_REASONS"));
  await assert.rejects(h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-1", ...noError("a1", "snap-1"), records_consulted: ["ledger"] }), refusedWith("INVESTIGATION_RECORDS"));
  await assert.rejects(h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-1", assertion_id: "a9", determination: "error_found" }), refusedWith("ASSERTION_NOT_FOUND"));
  // no response before every assertion is determined; no close before a complete response with delivery evidence on the record
  await assert.rejects(h.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-1", template: "NTC_REGX_35E_CORRECTION" }), refusedWith("UNDETERMINED_ASSERTIONS"));
  await h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-1", assertion_id: "a1", determination: "error_found", records_consulted: ["ledger", "payment_images", "allocation_rules"] });
  await assert.rejects(h.run("4.1", "case.noe.close", CASE_AGENT, { case_id: "noe-1", delivery_evidence_id: "anything" }), refusedWith("CLOSE_WITHOUT_EVIDENCE"));
  const resp = (await h.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-1", template: "NTC_REGX_35E_CORRECTION", text: "We corrected the error: your March 1 payment was re-applied as of March 1 and the $92.11 late charge reversed." }, "2026-09-18T15:00:00.000Z")).output as { complete: boolean };
  assert.equal(resp.complete, true); assert.equal(h.timer("REGX_1024_35E_NOE_RESPONSE_30")[0]!.status, "satisfied"); assert.equal(h.timer("SM_NOE_INTERNAL_TARGET_10")[0]!.status, "satisfied");   // 09-18 is day 9 of the 10-BD policy target
  await assert.rejects(h.run("4.1", "case.noe.close", CASE_AGENT, { case_id: "noe-1", delivery_evidence_id: "anything" }), refusedWith("CLOSE_WITHOUT_EVIDENCE"));       // responded, but no notice.sent of the letter
  notice(h, "NTC_REGX_35E_CORRECTION", "noe-1", { notice_id: "n-corr-1", channels: [{ channel: "mail", satisfies_timer: true }] });
  assert.deepEqual((await h.run("4.1", "case.noe.close", CASE_AGENT, { case_id: "noe-1", delivery_evidence_id: "n-corr-1" })).output, { closed: true });
  assert.equal(h.rt.store.get("cases", "noe-1")!.data.status, "closed");
});
test("4.1-T2: (holiday boundary) Given receipt on 2026-11-06, then ack due 2026-11-16 (Veterans Day 11-11 excluded) and response due 2026-12-22; a servicer closure day (e.g., day after Thanksgiving) does not extend either date.", async () => {
  const d = N.deadlines("b5", D("2026-11-06")); assert.equal(d.ack_due, "2026-11-16"); assert.equal(d.response_due, "2026-12-22");
  const closed = servicerCalendar({ closures: [D("2026-11-27")] });                                  // Supermortgage closed the day after Thanksgiving; the federal calendar is not
  assert.equal(closed.isBusinessDay(D("2026-11-27")), false); assert.equal(federal.isBusinessDay(D("2026-11-27")), true);
  const h = harness("2026-11-06T15:00:00.000Z", "L-2", { ...defaultCalendars, business_days_servicer: closed });
  await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-2", receipt_date: "2026-11-06", assertions: [{ id: "a1", category: "b5" }] });
  assert.equal(h.timer("REGX_1024_35D_NOE_ACK_5")[0]!.dueDate, "2026-11-16"); assert.equal(h.timer("REGX_1024_35E_NOE_RESPONSE_30")[0]!.dueDate, "2026-12-22");
});
test("4.1-T3: (payoff error) Given an assertion `b6`, then due 7 federal BD; extension command is rejected with `EXTENSION_NOT_PERMITTED`.", async () => {
  const h = harness();
  const p = (await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-3", receipt_date: "2026-09-04", assertions: [{ id: "a1", category: "b6" }] })).output as { assertions: { profile: string; response_due: string; extendable: boolean }[] };
  assert.deepEqual([p.assertions[0]!.profile, p.assertions[0]!.response_due, p.assertions[0]!.extendable], ["payoff_7", "2026-09-16", false]);
  assert.equal(h.timer("REGX_1024_35E_NOE_PAYOFF_RESPONSE_7")[0]!.dueDate, "2026-09-16"); assert.equal(h.timer("REGX_1024_35E_NOE_RESPONSE_30").length, 0);
  // the profile comes from the record, not from the caller: claiming `std_30` for a b6 assertion changes nothing
  await assert.rejects(h.run("4.1", "case.noe.extend", CASE_AGENT, { case_id: "noe-3", assertion_id: "a1", profile: "std_30", reason: "payoff records" }, "2026-09-10T15:00:00.000Z"), refusedWith("EXTENSION_NOT_PERMITTED"));
  assert.deepEqual(N.extend(N.deadlines("b6", D("2026-09-04")), D("2026-09-10")), { error: "EXTENSION_NOT_PERMITTED" });
  assert.equal(h.events.ofType("case.noe.extended").length, 0);
  // rule 3: profiles and satisfaction are per assertion — a b6 + b5 letter has clocks of 7 and 30 days; answering the b6 alone satisfies only the 7-day clock
  const h2 = harness();
  await h2.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-3b", receipt_date: "2026-09-04", assertions: [{ id: "a1", category: "b6" }, { id: "a2", category: "b5" }] });
  assert.equal(h2.timer("REGX_1024_35E_NOE_PAYOFF_RESPONSE_7")[0]!.dueDate, "2026-09-16"); assert.equal(h2.timer("REGX_1024_35E_NOE_RESPONSE_30")[0]!.dueDate, "2026-10-20");
  await h2.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-3b", assertion_id: "a1", determination: "error_found", records_consulted: ["payoff_quotes", "ledger"] });
  await assert.rejects(h2.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-3b" }, "2026-09-10T15:00:00.000Z"), refusedWith("UNDETERMINED_ASSERTIONS"));                      // a2 has no determination
  const r1 = (await h2.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-3b", assertion_ids: ["a1"], template: "NTC_REGX_35E_CORRECTION" }, "2026-09-10T15:00:00.000Z")).output as { complete: boolean; remaining_assertion_ids: string[] };
  assert.deepEqual([r1.complete, r1.remaining_assertion_ids], [false, ["a2"]]);
  assert.equal(h2.timer("REGX_1024_35E_NOE_PAYOFF_RESPONSE_7")[0]!.status, "satisfied"); assert.equal(h2.timer("REGX_1024_35E_NOE_RESPONSE_30")[0]!.status, "armed"); assert.equal(h2.timer("SM_NOE_INTERNAL_TARGET_10")[0]!.status, "armed");
  await h2.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-3b", assertion_id: "a2", determination: "error_found", records_consulted: ["fee_schedule", "jurisdiction_rules", "ledger"] });
  const r2 = (await h2.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-3b", assertion_ids: ["a2"], template: "NTC_REGX_35E_CORRECTION" }, "2026-09-17T15:00:00.000Z")).output as { complete: boolean };
  assert.equal(r2.complete, true); assert.equal(h2.timer("REGX_1024_35E_NOE_RESPONSE_30")[0]!.status, "satisfied"); assert.equal(h2.timer("SM_NOE_INTERNAL_TARGET_10")[0]!.status, "satisfied");
});
test("4.1-T4: (foreclosure error, sale in 20 days) Given `b9` received 2026-09-04 with sale 2026-09-24, then due 2026-09-23; `foreclosure.sale.conduct` on 2026-09-24 is blocked while `REGX_1024_35E_FC_NOE_OPEN` is open; attorney escalation package generated; after response, the gate clears.", async () => {
  const h = harness();
  const p = (await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-4", receipt_date: "2026-09-04", foreclosure_sale_date: "2026-09-24", assertions: [{ id: "a1", category: "b9" }] })).output as { noe_fc_response_due: string; assertions: { profile: string }[] };
  assert.equal(p.noe_fc_response_due, "2026-09-23"); assert.equal(p.assertions[0]!.profile, "fc_before_sale"); assert.equal(N.noeForeclosureDue(D("2026-09-04"), D("2026-09-24")), "2026-09-23");
  assert.equal(h.timer("REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30")[0]!.dueDate, "2026-09-23"); assert.equal(h.timer(FC_NOE_OPEN)[0]!.status, "armed"); assert.equal(h.timer("REGX_1024_35F2_FC_GOODFAITH_RESPONSE").length, 0);
  const conduct: CommandSpec<ToolInput, { conducted: true }> = { name: "foreclosure.sale.conduct", process: "13.2", agent: "foreclosure-ops", ruleSetVersion: "13.2@test", allow: { humansAny: true }, guardrails: withFcNoeGate(), handler: () => ({ conducted: true }) };
  h.clock.set("2026-09-24T13:00:00.000Z");
  await assert.rejects(h.bus.execute(conduct, ATTORNEY, { loan_id: "L-1" }, h.ctx), refusedWith("FC_NOE_OPEN"));
  assert.deepEqual(h.events.ofType("command.refused").map((e) => e.payload.code), ["FC_NOE_OPEN"]);
  const pkg = foreclosureHoldPackage(h.rt, { ...h.ctx, actor: CASE_AGENT, now: h.clock.now() }, { case_id: "noe-4", draft_response: "no error: the first notice was filed on day 130", decision_record: { determination: "no_error" }, snapshot_ids: ["snap-fc-1"], summary: "b9 assertion: first notice before day 121?", sale_date: "2026-09-24" });
  const esc = h.rt.escalations.opened[0]!; assert.equal(esc.id, pkg.escalation_id); assert.equal(esc.kind, "attorney"); assert.equal(esc.ownerRole, "attorney"); assert.equal(esc.severity, "sev-1");
  assert.ok((esc.payload.timer_status as { code: string }[]).some((t) => t.code === FC_NOE_OPEN)); assert.equal(esc.payload.attorney_network_message, "noe_hold"); assert.deepEqual(esc.payload.snapshot_ids, ["snap-fc-1"]);
  assert.equal(h.events.ofType("foreclosure.noe_hold.requested").length, 1);
  const breach = h.ctx.timers.evaluate(h.clock.now()).find((b) => b.def.code === "REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30")!;   // sale day, no response: the sale-or-30 clock breached on 09-23
  assert.equal(breach.severity, 1); assert.deepEqual([...breach.escalateTo].sort(), ["attorney", "officer"]);
  // reversing a foreclosure milestone is a human act: the agent needs the attorney's/officer's recorded approval, not a string
  await assert.rejects(h.run("4.1", "foreclosure.milestone.reverse", CASE_AGENT, { case_id: "noe-4", milestone: "first_notice", human_approval_id: "nobody" }), refusedWith("FC_MILESTONE_REVERSAL_NEEDS_HUMAN"));
  await h.approve(ATTORNEY, { approval_id: "appr-fc", case_id: "noe-4", scope: "foreclosure.milestone.reverse", rationale: "first notice filed on day 130 — no §1024.41(f) violation; sale postponed for the response" });
  await h.run("4.1", "foreclosure.milestone.reverse", CASE_AGENT, { case_id: "noe-4", milestone: "first_notice", human_approval_id: "appr-fc" });
  await h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-4", ...noError("a1", "snap-fc-1"), records_consulted: ["foreclosure_milestones", "lossmit_case_history"] });
  await h.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-4", template: "NTC_REGX_35E_NO_ERROR", text: "We investigated your notice of error. No error occurred: the first notice was filed on day 130." });
  assert.equal(h.timer(FC_NOE_OPEN)[0]!.status, "satisfied"); assert.equal(h.timer("REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30")[0]!.status, "satisfied_late");
  assert.equal((await h.bus.execute(conduct, ATTORNEY, { loan_id: "L-1" }, h.ctx)).output.conducted, true);
  // `foreclosure.sale.rescheduled` recomputes the due date: the open sale-or-30 instance is re-anchored on min(30 federal BD, new sale − 1)
  const h2 = harness();
  await h2.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-4b", receipt_date: "2026-09-04", foreclosure_sale_date: "2026-09-24", assertions: [{ id: "a1", category: "b9" }] });
  const first = h2.timer("REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30")[0]!; assert.equal(first.dueDate, "2026-09-23");
  const rs = (await h2.run("4.1", "case.noe.sale_rescheduled", CASE_AGENT, { case_id: "noe-4b", sale_date: "2026-10-30" }, "2026-09-15T15:00:00.000Z")).output as { noe_fc_response_due: string };
  assert.equal(rs.noe_fc_response_due, "2026-10-20"); assert.equal(first.status, "cancelled"); assert.match(first.cancelledReason!, /rescheduled to 2026-10-30/);
  assert.equal(h2.timer("REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30")[1]!.dueDate, "2026-10-20"); assert.equal(h2.timer(FC_NOE_OPEN)[0]!.status, "armed");
});
test("4.1-T5: (≤7 days before sale) Given `b10` received 3 days before sale, then a good-faith contact is logged before the sale and the (f)(2) path records `deadline_profile=fc_within_7_days_goodfaith`; no ack timer.", async () => {
  const r = goodFaithResponse(D("2026-09-21"), D("2026-09-24"), D("2026-09-22"), "oral");
  assert.equal(r.profile, "fc_within_7_days_goodfaith"); assert.equal(r.ack_timer, null); assert.equal(r.contact.before_sale, true); assert.equal(r.satisfied, true);
  assert.equal(goodFaithResponse(D("2026-09-04"), D("2026-09-24"), D("2026-09-10"), "oral").ack_timer, "2026-09-14");   // outside the (f)(2) window the ack clock runs
  const h = harness("2026-09-21T14:00:00.000Z");
  const p = (await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-5", receipt_date: "2026-09-21", foreclosure_sale_date: "2026-09-24", assertions: [{ id: "a1", category: "b10" }] })).output as { ack_required: boolean; days_before_sale: number; goodfaith_assertion: boolean; fc_response_assertion: boolean };
  assert.deepEqual([p.ack_required, p.days_before_sale, p.goodfaith_assertion, p.fc_response_assertion], [false, 3, true, false]);
  assert.equal(h.timer("REGX_1024_35D_NOE_ACK_5").length, 0);                                                                  // no ack timer: (d) does not apply
  for (const c of ["REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30", "SM_NOE_INTERNAL_TARGET_10", "REGX_1024_35E_NOE_RESPONSE_30"]) assert.equal(h.timer(c).length, 0, `${c}: (e) does not apply on the (f)(2) path`);
  assert.equal(h.timer("REGX_1024_35F2_FC_GOODFAITH_RESPONSE")[0]!.dueDate, "2026-09-23"); assert.equal(h.timer(FC_NOE_OPEN)[0]!.status, "armed");       // before the sale date/time; the gate still holds the sale
  await h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-5", ...noError("a1", "snap-fc-5"), records_consulted: ["foreclosure_milestones"] }, "2026-09-22T14:00:00.000Z");
  await h.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-5", goodfaith: true, mode: "oral" }, "2026-09-22T15:00:00.000Z");
  assert.equal(h.events.ofType("contact.logged")[0]!.payload.purpose, "noe_goodfaith_response"); assert.equal(h.timer("REGX_1024_35F2_FC_GOODFAITH_RESPONSE")[0]!.status, "satisfied"); assert.equal(h.timer(FC_NOE_OPEN)[0]!.status, "satisfied");
});
test("4.1-T6: (extension) Given `std_30` and an extension notice sent on the due date, then due moves +15 federal BD; an extension attempted one day after the due date is rejected.", async () => {
  const h = harness();
  await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-6", receipt_date: "2026-09-04", assertions: [{ id: "a1", category: "b5" }] });
  assert.equal(h.timer("REGX_1024_35E_NOE_EXT_NOTICE_BEFORE_30")[0]!.dueDate, "2026-10-20");
  const original = h.timer("REGX_1024_35E_NOE_RESPONSE_30")[0]!; assert.equal(original.dueDate, "2026-10-20");
  const ext = (await h.run("4.1", "case.noe.extend", CASE_AGENT, { case_id: "noe-6", assertion_id: "a1", reason: "records from the prior servicer are being retrieved" }, "2026-10-20T15:00:00.000Z")).output as Record<string, unknown>;
  assert.deepEqual({ ...ext, response_timer_id: null }, { original_due: "2026-10-20", new_due: "2026-11-10", federal_new_due: "2026-11-10", days: "+15 business_days_federal", notice: "NTC_REGX_35E_EXTENSION", response_timer_id: null });
  assert.equal(h.events.ofType("case.noe.extended")[0]!.payload.new_due, "2026-11-10");
  // the response clock moved: the original instance closed as extended, the new one is due 2026-11-10 and does not breach on 10-22
  assert.equal(original.status, "cancelled"); assert.match(original.cancelledReason!, /extended \+15 business_days_federal/);
  const moved = h.timer("REGX_1024_35E_NOE_RESPONSE_30")[1]!; assert.equal(moved.id, ext.response_timer_id); assert.equal(moved.dueDate, "2026-11-10"); assert.equal(moved.status, "armed");
  assert.deepEqual(h.ctx.timers.evaluate("2026-10-22T12:00:00.000Z").map((b) => b.def.code).filter((c) => c === "REGX_1024_35E_NOE_RESPONSE_30"), []);
  assert.deepEqual(h.ctx.timers.evaluate("2026-11-11T12:00:00.000Z").map((b) => b.def.code).filter((c) => c === "REGX_1024_35E_NOE_RESPONSE_30"), ["REGX_1024_35E_NOE_RESPONSE_30"]);   // it breaches only after the moved date
  // the extension-notice gate is satisfied by the extension notice only
  h.events.append({ type: "notice.sent", loanId: "L-1", actor: CASE_AGENT, payload: { template: "NTC_REGX_35D_ACK", case_id: "noe-6" } });
  assert.equal(h.timer("REGX_1024_35E_NOE_EXT_NOTICE_BEFORE_30")[0]!.status, "breached");
  h.events.append({ type: "notice.sent", loanId: "L-1", actor: CASE_AGENT, payload: { template: "NTC_REGX_35E_EXTENSION", case_id: "noe-6" } });
  assert.equal(h.timer("REGX_1024_35E_NOE_EXT_NOTICE_BEFORE_30")[0]!.status, "satisfied_late");
  await assert.rejects(h.run("4.1", "case.noe.extend", CASE_AGENT, { case_id: "noe-6", assertion_id: "a1", reason: "late" }, "2026-10-21T15:00:00.000Z"), refusedWith("EXTENSION_LATE"));
  await assert.rejects(h.run("4.1", "case.noe.extend", CASE_AGENT, { case_id: "noe-6", assertion_id: "a1", reason: "again" }, "2026-10-20T16:00:00.000Z"), refusedWith("EXTENSION_ONCE"));      // the record shows the extension; no caller flag needed
  await assert.rejects(h.run("4.1", "case.noe.extend", CASE_AGENT, { case_id: "noe-6", assertion_id: "a1" }, "2026-10-20T16:00:00.000Z"), refusedWith("EXTENSION_REASON"));
  const d = N.deadlines("b5", D("2026-09-04")); assert.equal((N.extend(d, D("2026-10-20")) as N.Deadlines).response_due, "2026-11-10"); assert.deepEqual(N.extend(d, D("2026-10-21")), { error: "EXTENSION_LATE" });
});
test("4.1-T7: (overbroad with carve-out) Given a 40-page pleading-style letter containing one identifiable late-fee assertion, then the late fee is investigated and answered and the (g)(2) notice states the overbroad basis for the remainder, both within their clocks.", async () => {
  const r = splitOverbroad([{ id: "a1", type: "b5", text: "the late fee assessed in March was not owed" }, { id: "a2", type: "unidentifiable", text: "40 pages of pleading-style allegations" }], D("2026-09-04"));
  assert.deepEqual(r.investigate.map((a) => a.id), ["a1"]); assert.deepEqual(r.overbroad_residue.map((a) => a.id), ["a2"]);
  assert.deepEqual(r.exception_notice, { template: "NTC_REGX_35G2_EXCEPTION", basis: "overbroad", due_on: "2026-09-14", carved_out: ["a1"] }); assert.equal(r.response_due, "2026-10-20");
  assert.equal(splitOverbroad([{ id: "a1", type: "b5", text: "late fee" }, { id: "a2", type: "unidentifiable", text: "40 pages" }], D("2026-09-04"), D("2026-09-09")).exception_notice!.due_on, "2026-09-16");   // the (g)(2) clock runs from the determination
  const h = harness();
  await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-7", receipt_date: "2026-09-04", assertions: [{ id: "a1", category: "b5", description: "the late fee assessed in March was not owed" }, { id: "a2", category: "b11", identifiable: false, description: "40 pages of pleading-style allegations" }] });
  await assert.rejects(h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-7", assertion_id: "a1", determination: "exception", exception_basis: "overbroad" }), refusedWith("EXCEPTION_WITH_IDENTIFIABLE"));   // the record says a1 is identifiable
  const ex = (await h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-7", assertion_id: "a2", determination: "exception", exception_basis: "overbroad" })).output as { exception_notice_due: string };
  assert.equal(ex.exception_notice_due, "2026-09-14"); assert.equal(h.timer("REGX_1024_35G2_NOE_EXCEPTION_NOTICE_5")[0]!.dueDate, "2026-09-14");
  await h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-7", assertion_id: "a1", determination: "error_found", records_consulted: ["fee_schedule", "jurisdiction_rules", "ledger"] });
  h.clock.set("2026-09-10T15:00:00.000Z"); h.events.append({ type: "notice.sent", loanId: "L-1", actor: CASE_AGENT, payload: { template: "NTC_REGX_35D_ACK", case_id: "noe-7" } });
  assert.equal(h.timer("REGX_1024_35G2_NOE_EXCEPTION_NOTICE_5")[0]!.status, "armed");                                          // the ack is not the (g)(2) notice
  h.events.append({ type: "notice.sent", loanId: "L-1", actor: CASE_AGENT, payload: { template: "NTC_REGX_35G2_EXCEPTION", case_id: "noe-7", basis: "overbroad", carved_out: ["a1"] } });
  assert.equal(h.timer("REGX_1024_35G2_NOE_EXCEPTION_NOTICE_5")[0]!.status, "satisfied");
  await h.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-7", template: "NTC_REGX_35E_CORRECTION" }, "2026-09-18T15:00:00.000Z");
  assert.equal(h.timer("REGX_1024_35E_NOE_RESPONSE_30")[0]!.status, "satisfied");
});
test("4.1-T8: (duplicative) Given the same escrow-shortage assertion answered 60 days ago and no new material, then `exception_basis=duplicative` and the (g)(2) notice issues ≤5 federal BD; with a new bank statement showing an unposted payment, the case is investigated.", async () => {
  const h = harness();
  await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-8", receipt_date: "2026-09-04", assertions: [{ id: "a1", category: "b3", description: "the escrow shortage was computed wrong" }] });
  const basis = N.exception({ similarity_to_prior: 0.92, new_material_info: false, identifiable: true, received_on: D("2026-09-04") }); assert.equal(basis, "duplicative");
  const det = (await h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-8", assertion_id: "a1", determination: "exception", exception_basis: basis, why_not_material: "repeats the July argument; nothing not previously reviewed (comment 35(g)(1)(i)-1)" }, "2026-09-08T15:00:00.000Z")).output as { exception_notice_due: string };
  assert.equal(det.exception_notice_due, "2026-09-15"); assert.equal(N.exceptionNoticeDue(D("2026-09-08")), "2026-09-15");     // 5 federal BD after the 09-08 determination, not after receipt
  assert.equal(h.timer("REGX_1024_35G2_NOE_EXCEPTION_NOTICE_5")[0]!.dueDate, "2026-09-15"); assert.equal(h.rt.store.get("case_assertions", "noe-8:a1")!.data.exception_basis, "duplicative");
  assert.equal(N.exception({ similarity_to_prior: 0.92, new_material_info: true, identifiable: true, received_on: D("2026-09-04") }), null);   // new bank statement → investigated
  const inv = (await h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-8", assertion_id: "a1", determination: "error_found", records_consulted: ["ledger", "escrow_analysis"] })).output as { exception_notice_due: string | null };
  assert.equal(inv.exception_notice_due, null); assert.equal(h.timer("REGX_1024_35G2_NOE_EXCEPTION_NOTICE_5").length, 1);
});
test("4.1-T9: (untimely) Given a discharge date 14 months before receipt, then untimely notice issues; given 11 months, investigated.", async () => {
  const h = harness();
  await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-9", receipt_date: "2026-09-04", assertions: [{ id: "a1", category: "b2" }] });
  const untimely = N.exception({ similarity_to_prior: 0, new_material_info: false, identifiable: true, received_on: D("2026-09-04"), transfer_out_or_discharge_on: D("2025-07-04") }); assert.equal(untimely, "untimely");
  await h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-9", assertion_id: "a1", determination: "exception", exception_basis: untimely });
  assert.equal(h.events.ofType("case.noe.exception_determined")[0]!.payload.exception_basis, "untimely"); assert.equal(h.timer("REGX_1024_35G2_NOE_EXCEPTION_NOTICE_5")[0]!.dueDate, "2026-09-14");   // the (g)(2) notice ≤5 federal BD after the same-day determination
  assert.equal(N.exception({ similarity_to_prior: 0, new_material_info: false, identifiable: true, received_on: D("2026-09-04"), transfer_out_or_discharge_on: D("2025-10-04") }), null);           // 11 months → investigated
  assert.equal(N.exception({ similarity_to_prior: 0, new_material_info: false, identifiable: true, received_on: D("2026-09-04"), transfer_out_or_discharge_on: D("2025-07-04"), concerns_own_servicing: true }), null);   // rule 4: Supermortgage's own errors are never untimely on the transferor's date
});
test("4.1-T10: (documents) Given a no-error response and a borrower's oral request for documents, then copies (snapshots) are mailed ≤15 federal BD; a privileged memo is withheld with the written withholding notice in the same window.", async () => {
  const r = documentRequest(D("2026-09-04"), [{ id: "ledger-2026-03", relied_on: true }, { id: "legal-memo-2026-09-10", relied_on: true, privileged: true }, { id: "unrelated", relied_on: false }]);
  assert.equal(r.copies_due, "2026-09-28"); assert.deepEqual(r.provided, [{ id: "ledger-2026-03", kind: "snapshot" }]);
  assert.deepEqual(r.withheld, [{ id: "legal-memo-2026-09-10", notice: "NTC_REGX_35E4_WITHHELD", basis: "privileged" }]);
  const h = harness();
  await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-10", receipt_date: "2026-08-03", assertions: [{ id: "a1", category: "b2" }] });
  await h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-10", ...noError("a1", "ledger-2026-03"), records_consulted: ["ledger", "payment_images", "allocation_rules"] });
  await h.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-10", template: "NTC_REGX_35E_NO_ERROR" }, "2026-09-01T15:00:00.000Z");
  const req = (await h.run("4.1", "case.noe.documents.request", CASE_AGENT, { case_id: "noe-10", requested_via: "oral", documents: [{ id: "ledger-2026-03", relied_on: true }, { id: "legal-memo-2026-09-10", relied_on: true, privileged: true }] }, "2026-09-04T15:00:00.000Z")).output as { copies_due: string; withheld: { id: string }[] };
  assert.equal(req.copies_due, "2026-09-28"); assert.deepEqual(req.withheld.map((w) => w.id), ["legal-memo-2026-09-10"]);
  const t = h.timer("REGX_1024_35E4_NOE_DOCS_15")[0]!; assert.equal(t.dueDate, "2026-09-28");                                   // 15 federal BD from the request date
  h.clock.set("2026-09-20T15:00:00.000Z"); h.events.append({ type: "notice.sent", loanId: "L-1", actor: CASE_AGENT, payload: { template: "NTC_REGX_35E_NO_ERROR", case_id: "noe-10" } });
  assert.equal(t.status, "armed");                                                                                               // the response letter is not the document copies
  h.events.append({ type: "notice.sent", loanId: "L-1", actor: CASE_AGENT, payload: { template: "NTC_REGX_35E4_WITHHELD", case_id: "noe-10", withheld: ["legal-memo-2026-09-10"] } });
  assert.equal(t.status, "satisfied");
});
test("4.1-T11: (early correction) Given a clear posting error fixed on day 2 with the correction letter mailed on day 3, then ack/response timers cancel with reason `early_correction`.", async () => {
  const r = earlyCorrection(D("2026-09-04"), D("2026-09-08"), D("2026-09-09"));
  assert.equal(r.qualifies, true); assert.equal(r.cancel_reason, "early_correction"); assert.deepEqual(r.timers_cancelled, ["REGX_1024_35D_NOE_ACK_5", "REGX_1024_35E_NOE_RESPONSE_30"]);
  assert.equal(earlyCorrection(D("2026-09-04"), D("2026-09-08"), D("2026-09-16")).qualifies, false);
  const h = harness();
  await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-11", receipt_date: "2026-09-04", assertions: [{ id: "a1", category: "b2", description: "my September 1 payment posted to the wrong loan" }] });
  const ack = h.timer("REGX_1024_35D_NOE_ACK_5")[0]!, resp = h.timer("REGX_1024_35E_NOE_RESPONSE_30")[0]!;
  const start = (await h.run("4.1", "case.noe.early_correction.start", CASE_AGENT, { case_id: "noe-11" }, "2026-09-08T15:00:00.000Z")).output as { letter_due: string };
  assert.equal(start.letter_due, "2026-09-14"); assert.equal(h.timer("REGX_1024_35F1_NOE_EARLY_CORRECTION_5")[0]!.dueDate, "2026-09-14");
  await assert.rejects(h.run("4.1", "case.noe.early_correct", CASE_AGENT, { case_id: "noe-11", correction: "re-applied the payment" }, "2026-09-09T15:00:00.000Z"), refusedWith("EARLY_CORRECTION_NEEDS_CORRECTION"));   // nothing was corrected yet
  await h.run("4.1", "fee.reverse", CASE_AGENT, { case_id: "noe-11", fee_account: "late_charges", amount_cents: 9_211n, effective_date: "2026-09-01", reason: "late charge on the misposted payment" }, "2026-09-08T16:00:00.000Z");   // fixed on day 2
  const ec = (await h.run("4.1", "case.noe.early_correct", CASE_AGENT, { case_id: "noe-11", correction: "re-applied the payment as of September 1 and reversed the late charge", effective_on: "2026-09-01", fixed_on: "2026-09-08" }, "2026-09-09T15:00:00.000Z")).output as { qualifies: boolean; cancel_reason: string; timers_cancelled: string[] };   // letter mailed on day 3
  assert.equal(ec.qualifies, true); assert.equal(ec.cancel_reason, "early_correction"); assert.deepEqual(ec.timers_cancelled.sort(), ["REGX_1024_35D_NOE_ACK_5", "REGX_1024_35E_NOE_EXT_NOTICE_BEFORE_30", "REGX_1024_35E_NOE_RESPONSE_30", "SM_NOE_INTERNAL_TARGET_10"]);
  assert.deepEqual([ack.status, ack.cancelledReason, resp.status, resp.cancelledReason], ["cancelled", "early_correction", "cancelled", "early_correction"]);
  assert.deepEqual(h.events.ofType("timer.cancelled").map((e) => e.payload.reason), ["early_correction", "early_correction", "early_correction", "early_correction"]);
  h.events.append({ type: "notice.sent", loanId: "L-1", actor: CASE_AGENT, payload: { template: "NTC_REGX_35F1_EARLY_CORRECTION", case_id: "noe-11" } });
  assert.equal(h.timer("REGX_1024_35F1_NOE_EARLY_CORRECTION_5")[0]!.status, "satisfied");
  // after day 5 the (f)(1) path is closed and the std clocks stay live
  const h2 = harness();
  await h2.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-11b", receipt_date: "2026-09-04", assertions: [{ id: "a1", category: "b2" }] });
  await assert.rejects(h2.run("4.1", "case.noe.early_correction.start", CASE_AGENT, { case_id: "noe-11b" }, "2026-09-16T15:00:00.000Z"), refusedWith("EARLY_CORRECTION_WINDOW"));
  assert.equal(h2.timer("REGX_1024_35D_NOE_ACK_5")[0]!.status, "armed"); assert.equal(h2.timer("REGX_1024_35E_NOE_RESPONSE_30")[0]!.status, "armed");
});
test("4.1-T12: (NY override) Given a NY property and a `b9` assertion with a sale in 40 days, then due = 15 servicer BD, not 30; extension for a `std_30` NY case adds 7 BD.", async () => {
  const ny = nyNoeDeadline(D("2026-09-04"), { foreclosure_assertion: true, sale_on: D("2026-10-14") });
  assert.equal(ny.response_due, "2026-09-28"); assert.match(ny.basis, /15 business days/);                 // 15 servicer BD (Labor Day closed), not 30
  assert.equal(nyNoeDeadline(D("2026-09-04"), { foreclosure_assertion: true, sale_on: D("2026-11-20") }).response_due, "2026-09-28");   // a sale 77 days out is still 15 BD (419.6 has no 60-day condition)
  assert.equal(nyNoeDeadline(D("2026-09-04"), { foreclosure_assertion: true, sale_on: D("2026-09-14") }).response_due, "2026-09-13");   // sale in 10 days → the day before the sale, whichever is earlier
  const h = harness();
  await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-12", receipt_date: "2026-09-04", state: "NY", foreclosure_sale_date: "2026-10-14", assertions: [{ id: "a1", category: "b9" }, { id: "a2", category: "b5", description: "the March late fee" }] });
  assert.equal(h.timer("NY_419_6_NOE_FC_RESPONSE_15BD")[0]!.dueDate, "2026-09-28"); assert.equal(h.timer("REGX_1024_35E_NOE_FC_RESPONSE_SALE_OR_30")[0]!.dueDate, "2026-10-13");   // the command layer enforces the earlier
  const ext = (await h.run("4.1", "case.noe.extend", CASE_AGENT, { case_id: "noe-12", assertion_id: "a2", reason: "prior-servicer records" }, "2026-10-19T15:00:00.000Z")).output as { new_due: string; federal_new_due: string; days: string };
  assert.deepEqual([ext.new_due, ext.federal_new_due, ext.days], ["2026-10-29", "2026-11-10", "+7 business_days_servicer"]);     // the NY date governs; the federal clock also moves
  assert.equal(h.timer("NY_419_6_NOE_EXTENSION_7BD")[0]!.dueDate, "2026-10-29"); assert.equal(h.timer("REGX_1024_35E_NOE_RESPONSE_30").at(-1)!.dueDate, "2026-11-10");
  await assert.rejects(h.run("4.1", "case.noe.extend", CASE_AGENT, { case_id: "noe-12", assertion_id: "a1", reason: "foreclosure file" }, "2026-09-10T15:00:00.000Z"), refusedWith("EXTENSION_NOT_PERMITTED"));
  const std = nyNoeDeadline(D("2026-09-04"), { foreclosure_assertion: false }); assert.equal(nyExtension(std), "2026-10-29");   // 30 servicer BD → 2026-10-20 (Labor Day, Columbus Day closed), +7 BD
});
test("4.1-T13: (AI escalation) Given classifier confidence 0.4, then `needs_human` queue with the ack timer running; a human classification within 1 BD does not change the receipt date.", () => {
  const r = triageWithConfidence({ confidence: 0.4, received_on: D("2026-09-04"), human_classified_on: D("2026-09-08") });
  assert.equal(r.queue, "needs_human"); assert.equal(r.ack_due, "2026-09-14"); assert.equal(r.receipt_date, "2026-09-04"); assert.equal(r.human_within_1bd, true); assert.equal(r.human_sla, "2026-09-08");
  assert.equal(triageWithConfidence({ confidence: 0.65, received_on: D("2026-09-04") }).queue, "auto");                    // Intake Router threshold is 0.6 (spec), not 0.7
  assert.equal(triageWithConfidence({ confidence: 0.59, received_on: D("2026-09-04") }).queue, "needs_human");
  assert.equal(triageWithConfidence({ confidence: 0.95, received_on: D("2026-09-04"), kind: "other" }).queue, "needs_human");
});
test("4.1-T14: (mail vendor failure) Given no manifest by 18:00 ET, then an alarm fires and the manual intake protocol logs receipt dates from the physical stamp.", () => {
  assert.deepEqual(manifestWatch({ expected_by: "2026-09-04T18:00:00-04:00", received_at: null, now: "2026-09-04T18:05:00-04:00" }), { alarm: true, protocol: "manual_intake", receipt_date_source: "physical_stamp" });
  assert.equal(manifestWatch({ expected_by: "2026-09-04T18:00:00-04:00", received_at: "2026-09-04T17:10:00-04:00", now: "2026-09-04T18:05:00-04:00" }).alarm, false);
});
test("4.1-T15: (fee prohibition) Given a borrower 2 months delinquent, then no fee or payment is requested in any NoE communication (template checklist assertion).", async () => {
  assert.deepEqual(noeCommunicationCheck("We received your notice of error. We will respond by October 20. You are two months behind; you may call us about options."), { ok: true, violations: [] });
  assert.equal(noeCommunicationCheck("A $25 fee applies for this dispute review.").ok, false);
  assert.equal(noeCommunicationCheck("You must bring your account current before we investigate.").ok, false);
  const h = harness();
  await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-15", receipt_date: "2026-09-04", assertions: [{ id: "a1", category: "b5" }] });
  await h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-15", assertion_id: "a1", determination: "error_found", records_consulted: ["fee_schedule", "jurisdiction_rules", "ledger"] });
  await assert.rejects(h.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-15", text: "You must bring your account current before we investigate." }), refusedWith("FEE_CONDITION"));
  await assert.rejects(h.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-15", text: "A $25 fee applies for this dispute review." }), refusedWith("FEE_CONDITION"));
  assert.equal(h.events.ofType("case.noe.responded").length, 0);
});
test("4.1-T16: (transfer-in open case) Given a boarding file with an NoE received by the transferor 20 federal BD earlier, then the case boards with the original receipt date and a 10-day residual clock.", () => {
  const boarded = D("2026-09-04"); const received = addBusinessDays(boarded, -20, federal);              // 20 federal BD earlier
  const r = boardOpenNoe({ type: "b2", transferor_received_on: received, boarded_on: boarded });
  assert.equal(r.receipt_date, received); assert.equal(r.response_due, federalDays(received, 30)); assert.equal(r.residual_federal_bd, 10);
});

// 4.1 rule 6 worked example: $1,842.17 P&I + $612.40 escrow = $2,454.57 received 2026-03-01 but posted 2026-03-17 → 5% × 184,217¢ = 9,211¢ reversed.
test("4.1 worked example: $1,842.17 + $612.40 = $2,454.57; the $92.11 late charge is reversed and the payment re-dated to 2026-03-01", () => {
  assert.equal(cents("1842.17") + cents("612.40"), cents("2454.57"));
  const corr = N.misappliedPaymentCorrection(cents("1842.17"), "5", D("2026-03-01")); assert.equal(corr.late_charge_reversed_cents, 9_211n); assert.equal(corr.repost_effective_date, "2026-03-01");
});
