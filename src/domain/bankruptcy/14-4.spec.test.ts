// 14.4 Credit reporting suspension in BK
// spec/sections/14-bankruptcy/14-4-credit-reporting-suspension-in-bk.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, daysBetween } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import { accountStatus, petitionSnapshot, dollars9, correctionDue, cii, reaffirmationFinal as sharedReaffirmationFinal } from "./credit.ts";
import { stateRow, falseMatchReversal, suppressionRequest, lateDiscoveryCorrection, rescissionWindowEnds, reaffirmationIsFinal, syncDue, phaseForEvent, snapshotSegment, contractualStatus, feedCii, debtDischargedAtDischarge, statusAtPetition, planTermsUpb, RULE_SET_VERSION, type StateRowInput, type PerformanceView } from "./ops-14-4.ts";
import { EVALUATORS_14_4 } from "./evaluators-14-4.ts";
import { SECTION_14_EVALUATORS } from "./evaluators.ts";
import { EVALUATORS } from "../../app/evaluators.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EntityStore } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { EscalationService } from "../../app/escalations.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import type { DomainEvent } from "../../kernel/events/types.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
/** The section map src/app/evaluators.ts spreads last, so its `14.4.reaffirmationFinal` is the one the registry resolves (app.test.ts proves the registry side). */
const evaluateGate = (ref: string, facts: Record<string, unknown>) => SECTION_14_EVALUATORS[ref]!(facts);

/**
 * Fixture BK-13-A as 14.1 verified it: Chapter 13 petition 2026-09-08 by borrower B-1; co-borrower B-2 did not file.
 * `status_at_petition` is not asserted: the feed derives it from 8.1's day count on the petition date (rule 2) —
 * the contract-terms earliest unpaid installment is May 1, 2026 (14.1 worked example).
 */
const PETITION: StateRowInput = { case_id: "BK-13-A", case_verified: true, loan_id: "L-1", borrower_id: "B-1", filer_borrower_ids: ["B-1"], chapter: "13", event: "bankruptcy.petition.filed", event_on: D("2026-09-08"), evidence_document_id: "doc-petition-notice", petition_date: D("2026-09-08"), earliest_unpaid_due_at_petition: D("2026-05-01") };
/** The note behind the fixture (14.1 rule 5 worked example): $325,000.00 at 6.500%, 360 months; 33 payments made before the petition. */
const NOTE = { original_upb_cents: 32_500_000n, rate_pct: "6.500", term_months: 360 } as const;
/** Contract-terms view of the fixture at any 2026 month-end: May 1 unpaid, $2,699.22 PITI, UPB $314,415.22 (14.1 worked example). */
const contractAt = (installmentsPastDue: number): PerformanceView => ({ earliest_unpaid_due: D("2026-05-01"), installments_past_due: installmentsPastDue, scheduled_payment_cents: 269_922n, upb_cents: 31_441_522n });
/** Fixture example C: the same loan filed under Chapter 7 (14.1 worked example C). */
const CH7_PETITION: StateRowInput = { ...PETITION, case_id: "BK-7-C", chapter: "7" };

test("14.4-T1: Given the fixture petition 2026-09-08, then the state row exists by 2026-09-09 with `status_at_petition=82`, and the Sept-30 snapshot for the filer shows CII D, status 82, Amount Past Due 000013496, DOFD 05012026, Current Balance 000314415; the non-filing co-borrower shows status 83 and no CII.", () => {
  // rule 2: the petition event writes the row within 1 servicer BD (SM_BK_CR_STATE_SYNC_1BD) with 8.1's day count on the petition date frozen
  const r = stateRow(PETITION);
  assert.equal(r.refusal, null); assert.equal(r.sync_due, "2026-09-09"); assert.equal(r.event, "bankruptcy.reporting_state.changed");
  assert.equal(daysBetween(D("2026-05-01"), D("2026-09-08")), 130); assert.equal(r.row!.status_at_petition, "82");
  // the frozen status is derived from 8.1's day count on the petition date (May 1 unpaid → 130 days → 82), never taken from the caller:
  // an asserted value that contradicts the derivation is refused; 8.1's day count alone derives the same bucket
  assert.equal(statusAtPetition({ anchor: D("2026-09-08"), earliest_unpaid_due: D("2026-05-01") }), "82"); assert.equal(statusAtPetition({ anchor: D("2026-09-08"), days_delinquent: 130 }), "82");
  assert.equal(stateRow({ ...PETITION, status_at_petition: "82" }).row!.status_at_petition, "82");
  const contradicted = stateRow({ ...PETITION, status_at_petition: "83" });
  assert.equal(contradicted.refusal_code, "STATUS_AT_PETITION_DERIVED"); assert.match(contradicted.refusal!, /83 contradicts 8.1's day count on 2026-09-08 \(82\)/);
  assert.equal(stateRow({ ...PETITION, earliest_unpaid_due_at_petition: null, days_delinquent_at_petition: 130 }).row!.status_at_petition, "82");
  assert.equal(r.row!.phase, "petition"); assert.equal(r.row!.debt_discharged, false); assert.equal(r.row!.cii_current, "D"); assert.equal(r.row!.rule_set_version, RULE_SET_VERSION);
  assert.deepEqual(suppressionRequest(r.row!), { reason: "bankruptcy_active", mechanism: "freeze_status", codes: ["CII D"], party_id: "B-1", final_reported: false, zero_balances: false });
  // the Sept-30 snapshot for the filer: CII D, status frozen at 82 (contractually 152 days), Amount Past Due 5 × 2,699.22 truncated, DOFD May 1, Current Balance the UPB
  const filer = snapshotSegment({ row: r.row!, cycle_as_of: D("2026-09-30"), contract: contractAt(5), prior_cii: "" });
  assert.equal(filer.furnish, true); assert.equal(filer.cii, "D"); assert.equal(filer.account_status, "82"); assert.equal(filer.amount_past_due, "000013496"); assert.equal(filer.dofd, "05012026"); assert.equal(filer.current_balance, "000314415");
  assert.equal(filer.scheduled_payment, "000002699"); assert.equal(filer.mechanism, "freeze_status"); assert.equal(filer.date_closed, "00000000");
  assert.equal(contractualStatus(D("2026-05-01"), D("2026-09-30")), "83");   // what the freeze suppresses on the filer's segment
  // the non-filing co-borrower never receives a row (rule 1) and reports the contractual 152-day status 83 with no CII
  assert.match(stateRow({ ...PETITION, borrower_id: "B-2" }).refusal!, /not a filer — non-filing obligors never receive a state row/);
  const co = snapshotSegment({ row: null, cycle_as_of: D("2026-09-30"), contract: contractAt(5), prior_cii: "" });
  assert.equal(daysBetween(D("2026-05-01"), D("2026-09-30")), 152); assert.equal(co.account_status, "83"); assert.equal(co.cii, ""); assert.equal(co.mechanism, "report"); assert.equal(co.amount_past_due, "000013496");
});

test("14.4-T2: Given confirmation 2026-12-10 (`plan_cures_arrears=true`, post-petition payment $2,806.72) and Dec 1 unpaid on Dec 31, then the Dec-31 snapshot shows 71, CII D, Amount Past Due 000002806, DOFD 12012026.", () => {
  const petition = stateRow(PETITION).row!;
  // rule 3: the confirmation order moves the row to `confirmed` with the plan's cure and the post-petition amount (after the 14.2 payment change)
  const conf = stateRow({ ...PETITION, event: "bankruptcy.plan.confirmed", event_on: D("2026-12-10"), evidence_document_id: "doc-confirmation-order", prior: petition, plan_cures_arrears: true, post_petition_payment_cents: 280_672n });
  assert.equal(conf.refusal, null); assert.equal(conf.sync_due, "2026-12-11");
  assert.equal(conf.row!.phase, "confirmed"); assert.equal(conf.row!.confirmation_date, "2026-12-10"); assert.equal(conf.row!.plan_cures_arrears, true); assert.equal(conf.row!.post_petition_payment_cents, 280_672n);
  assert.equal(conf.row!.status_at_petition, "82"); assert.equal(conf.row!.cii_current, "D");
  assert.deepEqual(suppressionRequest(conf.row!), { reason: "bankruptcy_active", mechanism: "flag_only", codes: ["CII D"], party_id: "B-1", final_reported: false, zero_balances: false });
  // Dec-31 snapshot: post-petition performance — Dec 1 unpaid → 30 days → 71 with CII D; Amount Past Due = one post-petition installment; DOFD is the new post-petition delinquency,
  // the frozen pre-petition DOFD (05012026) does not carry; Current Balance = the plan-terms UPB (14.4-Q2 default), Scheduled Monthly Payment = the post-petition amount.
  // The plan-terms UPB is the note's amortization with the post-petition installments applied per schedule as if the pre-petition ones had been paid (14.1 example A):
  // $314,415.22 after #33; the trustee's Dec-18 disbursement applied Oct (#39, principal 360.75) and Nov (#40, principal 362.71) → $311,916.95.
  // The spec's `000312279` ($312,279.66) is the balance after the Oct application alone — its "after the Oct/Nov applications" is one installment short (discrepancy reported).
  assert.equal(planTermsUpb({ ...NOTE, installments_applied: 33 }), cents("314415.22")); assert.equal(planTermsUpb({ ...NOTE, installments_applied: 39 }), cents("312279.66")); assert.equal(dollars9(planTermsUpb({ ...NOTE, installments_applied: 39 })), "000312279");
  const upbAfterOctNov = planTermsUpb({ ...NOTE, installments_applied: 40 });
  assert.equal(upbAfterOctNov, cents("311916.95")); assert.equal(planTermsUpb({ ...NOTE, installments_applied: 39 }) - upbAfterOctNov, cents("362.71"));
  const plan: PerformanceView = { earliest_unpaid_due: D("2026-12-01"), installments_past_due: 1, scheduled_payment_cents: 280_672n, upb_cents: upbAfterOctNov };
  const dec = snapshotSegment({ row: conf.row!, cycle_as_of: D("2026-12-31"), contract: contractAt(8), plan, prior_cii: "D" });
  assert.equal(daysBetween(D("2026-12-01"), D("2026-12-31")), 30); assert.equal(dec.account_status, "71"); assert.equal(dec.cii, "D"); assert.equal(dec.amount_past_due, "000002806"); assert.equal(dec.dofd, "12012026");
  assert.equal(dec.scheduled_payment, "000002806"); assert.equal(dec.current_balance, "000311916"); assert.equal(dec.mechanism, "flag_only");   // spec: 000312279 (after Oct only); after Oct and Nov: 000311916
  assert.notEqual(dec.dofd, "05012026");
  // post-petition current (conduit example A after the trustee's disbursement posts) → 11 with CII D and nothing past due
  const cur = snapshotSegment({ row: conf.row!, cycle_as_of: D("2027-01-31"), contract: contractAt(9), plan: { ...plan, earliest_unpaid_due: null, installments_past_due: 0 }, prior_cii: "D" });
  assert.equal(cur.account_status, "11"); assert.equal(cur.cii, "D"); assert.equal(cur.amount_past_due, "000000000"); assert.equal(cur.dofd, "00000000");
});

test("14.4-T3: Given Chapter 13 discharge 2031-08-20 after a cured/current end-of-case response, then `debt_discharged=false`, CII Q from the Aug-31-2031 snapshot and normal reporting thereafter.", () => {
  const conf = stateRow({ ...PETITION, event: "bankruptcy.plan.confirmed", event_on: D("2026-12-10"), evidence_document_id: "doc-confirmation-order", prior: stateRow(PETITION).row!, plan_cures_arrears: true, post_petition_payment_cents: 280_672n }).row!;
  // rule 4: the maintained §1322(b)(5) mortgage is not discharged (§1328(a)) — debt_discharged derives false; the 14.2 end-of-case response (arrearage paid in full, current) is the cure evidence
  assert.equal(debtDischargedAtDischarge({ chapter: "13", reaffirmation_pending: false, reaffirmation_final: false, surrendered: false }), false);
  const dis = stateRow({ ...PETITION, event: "bankruptcy.case.discharged", event_on: D("2031-08-20"), evidence_document_id: "doc-discharge-order-2031", prior: conf, treatment: "maintained" });
  assert.equal(dis.refusal, null); assert.equal(dis.row!.phase, "discharged"); assert.equal(dis.row!.debt_discharged, false); assert.equal(dis.row!.discharge_date, "2031-08-20"); assert.equal(dis.row!.cii_current, "Q");
  assert.deepEqual(suppressionRequest(dis.row!), { reason: "bankruptcy_active", mechanism: "flag_only", codes: ["CII Q"], party_id: "B-1", final_reported: false, zero_balances: false });
  // Aug-31-2031 snapshot: Q removes the indicator; contractual reporting of the cured, current loan (14.2 end-of-case: UPB $288,625.18, next $2,054.22 due 2031-07-01 paid)
  const current: PerformanceView = { earliest_unpaid_due: null, installments_past_due: 0, scheduled_payment_cents: 205_422n, upb_cents: 28_862_518n };
  const aug = snapshotSegment({ row: dis.row!, cycle_as_of: D("2031-08-31"), contract: current, prior_cii: "D" });
  assert.equal(aug.cii, "Q"); assert.equal(aug.account_status, "11"); assert.equal(aug.amount_past_due, "000000000"); assert.equal(aug.dofd, "00000000"); assert.equal(aug.current_balance, "000288625"); assert.equal(aug.date_closed, "00000000"); assert.equal(aug.final_reported, false);
  // Sept-30-2031 and thereafter: normal reporting, no CII, nothing suppressed
  const sep = snapshotSegment({ row: dis.row!, cycle_as_of: D("2031-09-30"), contract: current, prior_cii: "Q" });
  assert.equal(sep.furnish, true); assert.equal(sep.cii, ""); assert.equal(sep.account_status, "11"); assert.equal(sep.mechanism, "report");
  // surrender with discharge is the other branch of rule 4: debt_discharged=true → H, zero balances, Date Closed, final record
  const sur = stateRow({ ...PETITION, event: "bankruptcy.case.discharged", event_on: D("2031-08-20"), evidence_document_id: "doc-discharge-order-2031", prior: conf, treatment: "surrender" }).row!;
  assert.equal(sur.debt_discharged, true); assert.equal(sur.cii_current, "H"); assert.deepEqual(suppressionRequest(sur), { reason: "bankruptcy_discharged", mechanism: "delete_account", codes: ["CII H"], party_id: "B-1", final_reported: true, zero_balances: true });
  // the H record's Account Status is "the frozen pre-discharge status" (8.3 rule 3): after years of confirmed-plan reporting that is the
  // post-petition performance status (11 when current), not the petition-date 82 the Ch. 7 freeze would carry
  const h = snapshotSegment({ row: sur, cycle_as_of: D("2031-08-31"), contract: current, plan: current, prior_cii: "D" });
  assert.equal(h.date_closed, "08202031"); assert.equal(h.account_status, "11"); assert.notEqual(h.account_status, sur.status_at_petition); assert.equal(h.current_balance, "000000000");
  assert.equal(snapshotSegment({ row: sur, cycle_as_of: D("2031-08-31"), contract: current, plan: { ...current, earliest_unpaid_due: D("2031-07-01"), installments_past_due: 1 }, prior_cii: "D" }).account_status, "71");   // Jul 1 unpaid at the 08-20 discharge → 50 days
  assert.equal(snapshotSegment({ row: sur, cycle_as_of: D("2031-08-31"), contract: current, plan: current, prior_cii: "D", prior_account_status: "78" }).account_status, "78");   // what the last cycle furnished wins
  // the routine closure after the discharge (trustee's final report) changes nothing: the feed reviews it without writing (rule 6 is closure *without* discharge)
  const closedAfter = stateRow({ ...PETITION, event: "bankruptcy.case.closed", event_on: D("2031-09-10"), evidence_document_id: "doc-final-decree-2031", prior: dis.row! });
  assert.equal(closedAfter.no_change, true); assert.equal(closedAfter.row, null);
});

test("14.4-T4: Given Chapter 7 discharge 2026-12-15 without reaffirmation, then the Dec-31 record carries CII E, zero balances, Date Closed 12152026, status 82, and January is not furnished.", () => {
  // fixture example C: Chapter 7 petition 2026-09-08 (CII A, status frozen at 82), SOI "retain — continue payments" without a reaffirmation (ride-through)
  const pet = stateRow(CH7_PETITION);
  assert.equal(pet.row!.cii_current, "A"); assert.equal(pet.row!.status_at_petition, "82");
  // rule 5 / data model: Ch. 7 discharge with no reaffirmation → debt_discharged derives true; the discharge order (the event's evidence) is the required document
  assert.equal(debtDischargedAtDischarge({ chapter: "7", reaffirmation_pending: false, reaffirmation_final: false, surrendered: false }), true);
  const dis = stateRow({ ...CH7_PETITION, event: "bankruptcy.case.discharged", event_on: D("2026-12-15"), evidence_document_id: "doc-discharge-order", prior: pet.row! });
  assert.equal(dis.refusal, null); assert.equal(dis.row!.phase, "discharged"); assert.equal(dis.row!.debt_discharged, true); assert.equal(dis.row!.discharge_date, "2026-12-15"); assert.equal(dis.row!.discharge_order_document_id, "doc-discharge-order"); assert.equal(dis.row!.cii_current, "E");
  assert.deepEqual(suppressionRequest(dis.row!), { reason: "bankruptcy_discharged", mechanism: "delete_account", codes: ["CII E"], party_id: "B-1", final_reported: true, zero_balances: true });
  // Dec-31 record: CII E, Current Balance / Amount Past Due / Scheduled Payment 0, Date Closed = discharge date, Account Status frozen at the pre-discharge 82, then final_reported
  const dec = snapshotSegment({ row: dis.row!, cycle_as_of: D("2026-12-31"), contract: contractAt(8), prior_cii: "A" });
  assert.equal(dec.furnish, true); assert.equal(dec.cii, "E"); assert.equal(dec.current_balance, "000000000"); assert.equal(dec.amount_past_due, "000000000"); assert.equal(dec.scheduled_payment, "000000000");
  assert.equal(dec.date_closed, "12152026"); assert.equal(dec.account_status, "82"); assert.equal(dec.mechanism, "delete_account"); assert.equal(dec.final_reported, true);
  // January (and every later cycle) is not furnished — 8.3-Q4 default: no ride-through reporting after the final record
  const jan = snapshotSegment({ row: dis.row!, cycle_as_of: D("2027-01-31"), contract: contractAt(9), prior_cii: "E" });
  assert.equal(jan.furnish, false); assert.equal(jan.final_reported, true);
  // fixture example C's own sequence: "trustee's no-asset report and case closed 2026-12-22" — a closure after the discharge is not rule 6's
  // "closure without discharge": it changes nothing (no row, no new suppression), the row stays discharged/E and January is still not furnished
  const closed = stateRow({ ...CH7_PETITION, event: "bankruptcy.case.closed", event_on: D("2026-12-22"), evidence_document_id: "doc-final-decree", prior: dis.row! });
  assert.equal(closed.no_change, true); assert.equal(closed.row, null); assert.equal(closed.event, null);
  assert.equal(phaseForEvent({ event: "bankruptcy.case.closed", prior_phase: "discharged", discharge_entered: true }), null);
  const reopened = stateRow({ ...CH7_PETITION, event: "bankruptcy.case.reopened", event_on: D("2027-01-05"), evidence_document_id: "doc-reopen-order", prior: dis.row! }).row!;
  assert.equal(reopened.phase, "discharged"); assert.equal(reopened.debt_discharged, true); assert.equal(reopened.cii_current, "E");   // a routine event never resets debt_discharged
  assert.equal(snapshotSegment({ row: reopened, cycle_as_of: D("2027-01-31"), contract: contractAt(9), prior_cii: "E" }).furnish, false);
  // closure *without* a discharge (rule 6) is the dismissal-code path: CII I for one cycle then Q
  assert.equal(stateRow({ ...CH7_PETITION, event: "bankruptcy.case.closed", event_on: D("2026-12-22"), evidence_document_id: "doc-final-decree", prior: pet.row! }).row!.cii_current, "I");
  // the guardrail: an asserted debt_discharged=true on any other event still needs the discharge order document
  const noOrder = stateRow({ ...CH7_PETITION, event: "bankruptcy.case.closed", event_on: D("2026-12-22"), evidence_document_id: "doc-final-decree", prior: pet.row!, debt_discharged: true });
  assert.match(noOrder.refusal!, /discharge order document/); assert.equal(noOrder.refusal_code, "DISCHARGE_ORDER_REQUIRED");
});

test("14.4-T5: Given a reaffirmation filed 2026-11-20 and discharge 2026-12-15, then CII stays A until 2027-01-19 and becomes R on the Jan-31-2027 snapshot; a rescission on 2027-01-10 yields V.", () => {
  const pet = stateRow(CH7_PETITION).row!;
  // §524(c)(4) / USC_524C4_REAFFIRM_RESCISSION: the window runs to the later of the discharge and 60 days after filing → 2027-01-19 (not discharge + 60 = 2027-02-13)
  assert.equal(rescissionWindowEnds(D("2026-11-20"), D("2026-12-15")), "2027-01-19"); assert.equal(daysBetween(D("2026-11-20"), D("2027-01-19")), 60);
  assert.equal(rescissionWindowEnds(D("2026-11-20"), D("2027-02-01")), "2027-02-01");   // a later discharge extends it
  assert.equal(reaffirmationIsFinal(D("2026-11-20"), D("2026-12-15"), D("2027-01-19")), false); assert.equal(reaffirmationIsFinal(D("2026-11-20"), D("2026-12-15"), D("2027-01-20")), true);
  // the filing keeps the row in `petition` (CII A); the discharge entered while the agreement is still rescindable does not discharge the reaffirmed debt
  const filed = stateRow({ ...CH7_PETITION, event: "bankruptcy.reaffirmation.filed", event_on: D("2026-11-20"), evidence_document_id: "doc-reaffirmation-2400a", prior: pet }).row!;
  assert.equal(filed.phase, "petition"); assert.equal(filed.reaffirmation_date, "2026-11-20"); assert.equal(filed.reaffirmation_final, false); assert.equal(filed.cii_current, "A");
  const dis = stateRow({ ...CH7_PETITION, event: "bankruptcy.case.discharged", event_on: D("2026-12-15"), evidence_document_id: "doc-discharge-order", prior: filed }).row!;
  assert.equal(dis.phase, "petition"); assert.equal(dis.debt_discharged, false); assert.equal(dis.discharge_date, "2026-12-15"); assert.equal(dis.cii_current, "A");
  assert.equal(snapshotSegment({ row: dis, cycle_as_of: D("2026-12-31"), contract: contractAt(8), prior_cii: "A" }).cii, "A");
  // SM_BK_CR_REAFFIRM_HOLD: the gate stays closed through 2027-01-19 and opens on 2027-01-20 (the registry resolves this section's evaluator)
  const facts = { reaffirmation_filed_on: "2026-11-20", discharge_on: "2026-12-15" };
  assert.equal(EVALUATORS_14_4["14.4.reaffirmationFinal"]!({ ...facts, today: "2027-01-19" }).open, false);
  assert.match(EVALUATORS_14_4["14.4.reaffirmationFinal"]!({ ...facts, today: "2027-01-19" }).reason!, /lapses on 2027-01-19/);
  assert.equal(EVALUATORS_14_4["14.4.reaffirmationFinal"]!({ ...facts, today: "2027-01-20" }).open, true);
  assert.equal(evaluateGate("14.4.reaffirmationFinal", { ...facts, today: "2027-01-19" }).open, false); assert.equal(evaluateGate("14.4.reaffirmationFinal", { ...facts, today: "2027-01-31" }).open, true);
  assert.equal(evaluateGate("14.4.reaffirmationFinal", { ...facts, today: "2027-01-31", rescinded: true }).open, false);
  // the app-level map (what the registry resolves) is this section's definition, not the inline literal in src/app/evaluators.ts (discharge + 60 → 2027-02-13):
  // on 2027-01-31 the inline anchor would still hold the gate closed; the resolved evaluator opens it
  assert.equal(EVALUATORS["14.4.reaffirmationFinal"], EVALUATORS_14_4["14.4.reaffirmationFinal"]);
  assert.equal(EVALUATORS["14.4.reaffirmationFinal"]!({ ...facts, today: "2027-01-31" }).open, true);
  // ./credit.ts reaffirmationFinal (later of filing + 60 and discharge + 60 → 2027-02-13) is not the statute and is not what the feed uses
  assert.equal(sharedReaffirmationFinal(D("2026-11-20"), D("2026-12-15")), "2027-02-13"); assert.notEqual(sharedReaffirmationFinal(D("2026-11-20"), D("2026-12-15")), rescissionWindowEnds(D("2026-11-20"), D("2026-12-15")));
  // the feed refuses `final` on 2027-01-19 and writes `reaffirmed` (CII R) from 2027-01-20; the Jan-31-2027 snapshot shows R with normal reporting
  const held = stateRow({ ...CH7_PETITION, event: "bankruptcy.reaffirmation.final", event_on: D("2027-01-19"), evidence_document_id: "doc-reaffirmation-2400a", prior: dis, as_of: D("2027-01-19") });
  assert.match(held.refusal!, /not final until the §524\(c\)\(4\) rescission window lapses on 2027-01-19/);
  const fin = stateRow({ ...CH7_PETITION, event: "bankruptcy.reaffirmation.final", event_on: D("2027-01-20"), evidence_document_id: "doc-reaffirmation-2400a", prior: dis, as_of: D("2027-01-20") }).row!;
  assert.equal(fin.phase, "reaffirmed"); assert.equal(fin.reaffirmation_final, true); assert.equal(fin.debt_discharged, false); assert.equal(fin.cii_current, "R");
  const jan = snapshotSegment({ row: fin, cycle_as_of: D("2027-01-31"), contract: contractAt(9), prior_cii: "A" });
  assert.equal(jan.cii, "R"); assert.equal(jan.furnish, true); assert.equal(jan.account_status, contractualStatus(D("2026-05-01"), D("2027-01-31"))); assert.equal(jan.current_balance, "000314415");
  // a late docket: the 2026-12-15 discharge processed on 2027-01-25, after the window lapsed — the reaffirmed debt lands in `reaffirmed` (R), never
  // `discharged` with debt_discharged=false (Q is the Ch. 13 §1322(b)(5) removal code, rule 4)
  const late = stateRow({ ...CH7_PETITION, event: "bankruptcy.case.discharged", event_on: D("2026-12-15"), evidence_document_id: "doc-discharge-order", prior: filed, as_of: D("2027-01-25") }).row!;
  assert.equal(late.phase, "reaffirmed"); assert.equal(late.reaffirmation_final, true); assert.equal(late.debt_discharged, false); assert.equal(late.cii_current, "R"); assert.equal(late.discharge_date, "2026-12-15");
  assert.equal(snapshotSegment({ row: late, cycle_as_of: D("2027-01-31"), contract: contractAt(9), prior_cii: "A" }).cii, "R");
  assert.equal(phaseForEvent({ event: "bankruptcy.case.discharged", prior_phase: "petition", reaffirmation_final: true }), "reaffirmed");
  assert.equal(phaseForEvent({ event: "bankruptcy.case.discharged", prior_phase: "reaffirmed" }), "reaffirmed");
  // a rescission on 2027-01-10 (inside the window) yields V; with the discharge already entered the debt is discharged, so the E final record follows on the next cycle
  const resc = stateRow({ ...CH7_PETITION, event: "bankruptcy.reaffirmation.rescinded", event_on: D("2027-01-10"), evidence_document_id: "doc-rescission-notice", prior: dis, as_of: D("2027-01-10") }).row!;
  assert.equal(resc.cii_current, "V"); assert.equal(resc.reaffirmation_date, null); assert.equal(resc.reaffirmation_final, false); assert.equal(resc.phase, "discharged"); assert.equal(resc.debt_discharged, true);
  assert.deepEqual(feedCii(resc), { cii: "V", zero_balances: false, freeze_status: false, final: false }); assert.deepEqual(suppressionRequest(resc).codes, ["CII V"]);
  assert.equal(snapshotSegment({ row: resc, cycle_as_of: D("2027-01-31"), contract: contractAt(9), prior_cii: "A" }).cii, "V");
  const feb = snapshotSegment({ row: resc, cycle_as_of: D("2027-02-28"), contract: contractAt(10), prior_cii: "V" });
  assert.equal(feb.cii, "E"); assert.equal(feb.date_closed, "12152026"); assert.equal(feb.current_balance, "000000000");
  assert.match(stateRow({ ...CH7_PETITION, event: "bankruptcy.reaffirmation.final", event_on: D("2027-01-20"), evidence_document_id: "doc-reaffirmation-2400a", prior: resc, as_of: D("2027-01-20") }).refusal!, /not final/);
});

test("14.4-T6: Given dismissal 2027-06-05 with May–Jun 2026 installments cured through the trustee, then the Jun-30-2027 snapshot shows CII L, the contractual status from the earliest unpaid installment (Jul 1, 2026), DOFD 07012026, and Jul-31 shows Q.", () => {
  const conf = stateRow({ ...PETITION, event: "bankruptcy.plan.confirmed", event_on: D("2026-12-10"), evidence_document_id: "doc-confirmation-order", prior: stateRow(PETITION).row!, plan_cures_arrears: true, post_petition_payment_cents: 280_672n }).row!;
  // rule 6 / 14.4-Q3: the court's (trustee's) dismissal → `dismissed`; the debtor's own motion would be `withdrawn` (M/N/O/P)
  const dis = stateRow({ ...PETITION, event: "bankruptcy.case.dismissed", event_on: D("2027-06-05"), evidence_document_id: "doc-dismissal-order", prior: conf });
  assert.equal(dis.refusal, null); assert.equal(dis.sync_due, "2027-06-07"); assert.equal(dis.row!.phase, "dismissed"); assert.equal(dis.row!.dismissal_date, "2027-06-05"); assert.equal(dis.row!.cii_current, "L");
  assert.deepEqual(suppressionRequest(dis.row!), { reason: "bankruptcy_active", mechanism: "flag_only", codes: ["CII L"], party_id: "B-1", final_reported: false, zero_balances: false });
  assert.equal(phaseForEvent({ event: "bankruptcy.case.dismissed", debtor_motion: true }), "withdrawn"); assert.equal(cii("13", "withdrawn", false).cii, "P");
  // Jun-30-2027 snapshot: CII L for one cycle; the freeze is released and the contract-terms view governs — May–Jun 2026 cured through the trustee,
  // so the earliest unpaid installment is Jul 1, 2026 (364 days → 84), DOFD reverts to that date, Amount Past Due = the 12 unpaid contractual installments
  const cured: PerformanceView = { earliest_unpaid_due: D("2026-07-01"), installments_past_due: 12, scheduled_payment_cents: 269_922n, upb_cents: 31_441_522n };
  const jun = snapshotSegment({ row: dis.row!, cycle_as_of: D("2027-06-30"), contract: cured, prior_cii: "D" });
  assert.equal(jun.cii, "L"); assert.equal(daysBetween(D("2026-07-01"), D("2027-06-30")), 364); assert.equal(jun.account_status, "84"); assert.equal(jun.dofd, "07012026"); assert.equal(jun.amount_past_due, "000032390");
  assert.equal(jun.mechanism, "flag_only"); assert.notEqual(jun.account_status, dis.row!.status_at_petition);   // the frozen 82 is released (8.1 anomaly gate whitelists the jump with the dismissal order)
  // Jul-31 shows Q; from Aug-31 the indicator is gone and reporting is purely contractual
  const jul = snapshotSegment({ row: dis.row!, cycle_as_of: D("2027-07-31"), contract: { ...cured, installments_past_due: 13 }, prior_cii: "L" });
  assert.equal(jul.cii, "Q"); assert.equal(jul.dofd, "07012026"); assert.equal(jul.account_status, "84");
  assert.equal(snapshotSegment({ row: dis.row!, cycle_as_of: D("2027-08-31"), contract: { ...cured, installments_past_due: 14 }, prior_cii: "Q" }).cii, "");
  // had the May installment stayed uncured, the DOFD would still be 05012026 (rule 6 fixture note)
  assert.equal(snapshotSegment({ row: dis.row!, cycle_as_of: D("2027-06-30"), contract: contractAt(14), prior_cii: "D" }).dofd, "05012026");
  // `reopened` re-enters the prior phase — the phase before the dismissal/closure (confirmed, since a plan had been confirmed), not the dismissal-code state
  const reopened = stateRow({ ...PETITION, event: "bankruptcy.case.reopened", event_on: D("2027-08-02"), evidence_document_id: "doc-vacatur-order", prior: dis.row! }).row!;
  assert.equal(reopened.phase, "confirmed"); assert.equal(reopened.cii_current, "D"); assert.equal(reopened.confirmation_date, "2026-12-10"); assert.equal(reopened.dismissal_date, "2027-06-05");
  const closedNoPlan = stateRow({ ...PETITION, event: "bankruptcy.case.closed", event_on: D("2027-06-05"), evidence_document_id: "doc-closing-order", prior: stateRow(PETITION).row! }).row!;
  assert.equal(closedNoPlan.phase, "closed"); assert.equal(closedNoPlan.cii_current, "L");
  assert.equal(stateRow({ ...PETITION, event: "bankruptcy.case.reopened", event_on: D("2027-08-02"), evidence_document_id: "doc-reopen-order", prior: closedNoPlan }).row!.phase, "petition");
  assert.equal(phaseForEvent({ event: "bankruptcy.case.reopened", prior_phase: "closed", prior_confirmed: true }), "confirmed"); assert.equal(phaseForEvent({ event: "bankruptcy.case.reopened", prior_phase: "closed" }), "petition");
});

test("14.4-T7: Given a petition discovered on 2026-10-20 after the Sept-30 file was furnished without CII, then an AUD adding CII D and the frozen status is sent by 2026-10-22.", () => {
  // rule 10: the petition (2026-09-08) is verified on 2026-10-20; the Sept-30 file went out with the contractual 83 and no CII
  const row = stateRow({ ...PETITION, evidence_document_id: "doc-petition-notice-late" }).row!;
  const furnished = { cycle_as_of: D("2026-09-30"), transmitted_on: D("2026-10-02"), cii: "", account_status: "83", dofd: D("2026-05-01") };
  const aud = lateDiscoveryCorrection({ discovered_on: D("2026-10-20"), row, furnished });
  // the AUD adds CII D and corrects the status to the frozen 82 (the freeze rule would have applied); due 2 servicer BD after discovery → Thu 2026-10-22
  assert.equal(correctionDue(D("2026-10-20")), "2026-10-22");
  assert.deepEqual(aud, { kind: "aud", action: "add_cii", cycle_as_of: "2026-09-30", due: "2026-10-22", codes: ["CII D"], account_status: "82", party_id: "B-1", evidence_document_id: "doc-petition-notice-late", owner: "8.3" });
  // a cycle that already carried the CII needs no AUD; a cycle before the petition date is not corrected (the status was accurate then)
  assert.equal(lateDiscoveryCorrection({ discovered_on: D("2026-10-20"), row, furnished: { ...furnished, cii: "D", account_status: "82" } }), null);
  assert.equal(lateDiscoveryCorrection({ discovered_on: D("2026-10-20"), row, furnished: { ...furnished, cycle_as_of: D("2026-08-31"), transmitted_on: D("2026-09-02") } }), null);
});

test("14.4-T8: Given a same-name false match reversed on 2026-09-15, then no state row survives, and if a file was already furnished with CII an AUD removes it within 2 BD with `officer` notified.", () => {
  // the same-name EBN hit was booked as the fixture petition: one row for the named filer, none for the co-borrower (rule 1)
  const booked = stateRow(PETITION);
  assert.equal(booked.refusal, null); assert.equal(booked.sync_due, "2026-09-09"); assert.equal(booked.row!.status_at_petition, "82"); assert.equal(booked.row!.retracted, false);
  assert.match(stateRow({ ...PETITION, borrower_id: "B-2" }).refusal!, /not a filer/);
  // (a) 14.1 reverses the match on 2026-09-15 before the Sept-30 file: the row is retracted (no active row survives), 8.3 releases what it derived, no AUD is needed, and the officer is notified of the deletion
  const a = falseMatchReversal({ reversed_on: D("2026-09-15"), rows: [booked.row!], furnished: [], evidence_document_id: "doc-pcl-mismatch" });
  assert.deepEqual(a.surviving_rows, []); assert.equal(a.retracted.length, 1);
  assert.equal(a.retracted[0]!.retracted, true); assert.equal(a.retracted[0]!.retracted_on, "2026-09-15"); assert.equal(a.retracted[0]!.retraction_reason, "false_match"); assert.equal(a.retracted[0]!.evidence_document_id, "doc-pcl-mismatch");
  assert.deepEqual(a.releases, [{ party_id: "B-1", reason: "bankruptcy_active" }]);
  assert.deepEqual(a.auds, []); assert.equal(a.aud_due, null);
  assert.equal(a.escalation.kind, "officer"); assert.match(a.escalation.reason, /deleted/);
  assert.deepEqual(a.events, ["bankruptcy.reporting_state.retracted"]);
  assert.equal(snapshotSegment({ row: a.retracted[0]!, cycle_as_of: D("2026-09-30"), contract: contractAt(5), prior_cii: "" }).cii, "");   // a retracted row furnishes nothing
  // (b) the false match had been booked with petition 2026-08-20 and the Aug-31 file was furnished with CII D and the frozen status 80 (May 1 unpaid → 111 days):
  //     an AUD removing the CII is due 2026-09-17 (2 servicer BD after 2026-09-15) and restores the contractual Aug-31 status 82 (122 days)
  const earlier = stateRow({ ...PETITION, event_on: D("2026-08-20"), petition_date: D("2026-08-20"), status_at_petition: accountStatus(daysBetween(D("2026-05-01"), D("2026-08-20"))) }).row!;
  assert.equal(earlier.status_at_petition, "80");
  const furnished = { cycle_as_of: D("2026-08-31"), transmitted_on: D("2026-09-02"), cii: "D", account_status: earlier.status_at_petition!, dofd: D("2026-05-01") };
  const b = falseMatchReversal({ reversed_on: D("2026-09-15"), rows: [earlier], furnished: [furnished], evidence_document_id: "doc-pcl-mismatch" });
  assert.deepEqual(b.surviving_rows, []); assert.equal(b.retracted.length, 1);
  assert.equal(b.auds.length, 1); assert.equal(b.aud_due, correctionDue(D("2026-09-15"))); assert.equal(b.aud_due, "2026-09-17");
  assert.deepEqual(b.auds[0], { kind: "aud", action: "remove_cii", cycle_as_of: "2026-08-31", due: "2026-09-17", codes: ["CII D"], account_status: "82", party_id: "B-1", evidence_document_id: "doc-pcl-mismatch", owner: "8.3" });
  assert.equal(b.escalation.kind, "officer"); assert.match(b.escalation.reason, /1 AUD\(s\) removing the CII due 2026-09-17/);
  assert.deepEqual(b.events, ["bankruptcy.reporting_state.retracted", "credit.correction.requested"]);
  // a cycle furnished without a CII needs no AUD; a repeated reversal finds no live row and deletes nothing
  assert.equal(falseMatchReversal({ reversed_on: D("2026-09-15"), rows: [earlier], furnished: [{ ...furnished, cii: "" }], evidence_document_id: "doc-pcl-mismatch" }).auds.length, 0);
  const again = falseMatchReversal({ reversed_on: D("2026-09-16"), rows: b.retracted, furnished: [furnished], evidence_document_id: "doc-pcl-mismatch" });
  assert.equal(again.retracted.length, 0); assert.equal(again.auds.length, 0); assert.deepEqual(again.events, []);
});

test("14.4 worked figures: fixture BK-13-A petition 2026-09-08 with May 1 unpaid → 130 days → status 82 frozen; Sept-30 snapshot CII D, Amount Past Due 5 × $2,699.22 = $13,496.10 → 000013496, DOFD 05012026, Current Balance $314,415.22 → 000314415, Scheduled Monthly Payment 000002699; non-filing co-borrower 152 days → 83; confirmation 2026-12-10 post-petition payment $2,806.72 → 000002806 and Dec 1 unpaid on Dec 31 → 71; Ch. 7 discharge 2026-12-15 → E/zero balances/final; reaffirmation filed 2026-11-20 final after 2027-01-19; late discovery 2026-10-20 → AUD by 2026-10-22", () => {
  const dofd = D("2026-05-01"), petition = D("2026-09-08");
  // rule 2: 8.1's day count on the petition date, frozen, and the Sept-30 segment for the filer
  assert.equal(daysBetween(dofd, petition), 130); assert.equal(accountStatus(130), "82");
  const snap = petitionSnapshot({ chapter: "13", days_delinquent_at_petition: daysBetween(dofd, petition), monthly_payment_cents: 269_922n, installments_past_due: 5, upb_cents: 31_441_522n, dofd });
  assert.deepEqual(snap, { cii: "D", account_status: "82", amount_past_due: "000013496", dofd: "05012026", current_balance: "000314415", scheduled_payment: "000002699" });
  assert.equal(dollars9(5n * 269_922n), "000013496");   // $13,496.10 truncated to whole dollars (8.1-Q2)
  assert.equal(dollars9(31_441_522n), "000314415");      // $314,415.22
  // the non-filing co-borrower's segment carries the contractual 152-day status 83 and no CII (rule 1)
  assert.equal(daysBetween(dofd, D("2026-09-30")), 152); assert.equal(accountStatus(152), "83");
  assert.match(stateRow({ ...PETITION, borrower_id: "B-2" }).refusal!, /non-filing obligors never receive a state row/);
  // the state row exists by 2026-09-09 (1 servicer BD) and asks 8.3 for the petition freeze with CII D
  const row = stateRow(PETITION);
  assert.equal(syncDue(petition), "2026-09-09"); assert.equal(row.sync_due, "2026-09-09"); assert.equal(row.event, "bankruptcy.reporting_state.changed");
  assert.equal(row.row!.rule_set_version, RULE_SET_VERSION);
  assert.deepEqual(suppressionRequest(row.row!), { reason: "bankruptcy_active", mechanism: "freeze_status", codes: ["CII D"], party_id: "B-1", final_reported: false, zero_balances: false });
  // rule 3: confirmation 2026-12-10 with plan_cures_arrears and the $2,806.72 post-petition payment; Dec 1 unpaid on Dec 31 → 30 days → 71 with CII D
  const conf = stateRow({ ...PETITION, event: "bankruptcy.plan.confirmed", event_on: D("2026-12-10"), evidence_document_id: "doc-confirmation-order", prior: row.row!, plan_cures_arrears: true, post_petition_payment_cents: 280_672n, postpetition_days_delinquent: daysBetween(D("2026-12-01"), D("2026-12-31")) });
  assert.equal(conf.row!.phase, "confirmed"); assert.equal(conf.row!.confirmation_date, "2026-12-10"); assert.equal(conf.row!.plan_cures_arrears, true); assert.equal(conf.row!.post_petition_payment_cents, 280_672n); assert.equal(conf.row!.status_at_petition, "82");
  assert.equal(dollars9(conf.row!.post_petition_payment_cents!), "000002806"); assert.equal(accountStatus(conf.row!.postpetition_days_delinquent!), "71");
  assert.deepEqual(suppressionRequest(conf.row!), { reason: "bankruptcy_active", mechanism: "flag_only", codes: ["CII D"], party_id: "B-1", final_reported: false, zero_balances: false });
  // rule 4: Chapter 13 discharge with the mortgage maintained → debt_discharged=false → Q; surrender with discharge → H, zero balances, final
  const ch13 = stateRow({ ...PETITION, event: "bankruptcy.case.discharged", event_on: D("2031-08-20"), evidence_document_id: "doc-discharge-order", prior: conf.row! });
  assert.equal(ch13.row!.debt_discharged, false); assert.equal(ch13.row!.discharge_date, "2031-08-20"); assert.deepEqual(suppressionRequest(ch13.row!).codes, ["CII Q"]);
  assert.deepEqual(suppressionRequest(stateRow({ ...PETITION, event: "bankruptcy.case.discharged", event_on: D("2031-08-20"), evidence_document_id: "doc-discharge-order", prior: conf.row!, treatment: "surrender" }).row!), { reason: "bankruptcy_discharged", mechanism: "delete_account", codes: ["CII H"], party_id: "B-1", final_reported: true, zero_balances: true });
  // rule 5: Chapter 7 discharge 2026-12-15 without reaffirmation → E, zero balances, final; the discharge order is the required document (the event's evidence)
  const ch7: StateRowInput = { ...CH7_PETITION, event: "bankruptcy.case.discharged", event_on: D("2026-12-15"), evidence_document_id: "doc-discharge-order" };
  assert.deepEqual(suppressionRequest(stateRow(ch7).row!), { reason: "bankruptcy_discharged", mechanism: "delete_account", codes: ["CII E"], party_id: "B-1", final_reported: true, zero_balances: true });
  assert.match(stateRow({ ...CH7_PETITION, event: "bankruptcy.case.closed", event_on: D("2026-12-22"), evidence_document_id: "doc-final-decree", debt_discharged: true, discharge_order_document_id: null }).refusal!, /discharge order document/);
  // rule 5 / §524(c)(4): reaffirmation filed 2026-11-20, discharge 2026-12-15 → rescission window ends 2027-01-19 (later of discharge and filing + 60); A through that day, R after, V on rescission
  assert.equal(rescissionWindowEnds(D("2026-11-20"), D("2026-12-15")), "2027-01-19");
  assert.equal(daysBetween(D("2026-11-20"), D("2027-01-19")), 60);
  const held = stateRow({ ...CH7_PETITION, event: "bankruptcy.reaffirmation.final", event_on: D("2027-01-19"), evidence_document_id: "doc-reaffirmation-2400a", reaffirmation_filed_on: D("2026-11-20"), discharge_date: D("2026-12-15"), as_of: D("2027-01-19") });
  assert.match(held.refusal!, /not final until the §524\(c\)\(4\) rescission window lapses on 2027-01-19/);
  const fin = stateRow({ ...CH7_PETITION, event: "bankruptcy.reaffirmation.final", event_on: D("2027-01-20"), evidence_document_id: "doc-reaffirmation-2400a", reaffirmation_filed_on: D("2026-11-20"), discharge_date: D("2026-12-15"), as_of: D("2027-01-20") });
  assert.equal(fin.row!.phase, "reaffirmed"); assert.equal(fin.row!.reaffirmation_final, true); assert.deepEqual(suppressionRequest(fin.row!).codes, ["CII R"]);
  assert.equal(phaseForEvent({ event: "bankruptcy.reaffirmation.filed", reaffirmation_final: false }), "petition"); assert.equal(cii("7", "petition", false).cii, "A");
  assert.equal(stateRow({ ...CH7_PETITION, event: "bankruptcy.reaffirmation.rescinded", event_on: D("2027-01-10"), evidence_document_id: "doc-rescission-notice", reaffirmation_filed_on: D("2026-11-20") }).row!.cii_current, "V");
  // rule 6 / 14.4-Q3: the debtor's own motion → withdrawn (P); the court's/trustee's dismissal → dismissed (L); relief from stay changes nothing (rule 8)
  assert.equal(phaseForEvent({ event: "bankruptcy.case.dismissed", debtor_motion: true }), "withdrawn"); assert.equal(cii("13", "withdrawn", false).cii, "P");
  assert.equal(stateRow({ ...PETITION, event: "bankruptcy.case.dismissed", event_on: D("2027-06-05"), evidence_document_id: "doc-dismissal-order", prior: conf.row! }).row!.dismissal_date, "2027-06-05");
  assert.equal(stateRow({ ...PETITION, event: "bankruptcy.stay.relief_granted", event_on: D("2027-03-01"), evidence_document_id: "doc-relief-order", prior: conf.row! }).no_change, true);
  // rule 7: conversion 13 → 7 re-enters petition with chapter 7 (CII A) and the petition date retained
  // (status frozen at the conversion-date status: Jan 1, 2027 unpaid on 2027-02-03 → 33 days → 71 — derived from the day count, an asserted 71 agrees)
  const conv = stateRow({ ...PETITION, chapter: "7", event: "bankruptcy.case.converted", event_on: D("2027-02-03"), evidence_document_id: "doc-conversion-order", prior: conf.row!, earliest_unpaid_due_at_petition: D("2027-01-01"), status_at_petition: "71" });
  assert.equal(conv.row!.phase, "petition"); assert.equal(conv.row!.chapter, "7"); assert.equal(conv.row!.petition_date, "2026-09-08"); assert.equal(conv.row!.status_at_petition, "71"); assert.deepEqual(suppressionRequest(conv.row!).codes, ["CII A"]);
  // rule 10 / T7: a petition discovered 2026-10-20 after the Sept-30 file went out without a CII → AUD adding CII D and the frozen status 82 by 2026-10-22
  const aud = lateDiscoveryCorrection({ discovered_on: D("2026-10-20"), row: row.row!, furnished: { cycle_as_of: D("2026-09-30"), transmitted_on: D("2026-10-02"), cii: "", account_status: "83", dofd } });
  assert.deepEqual(aud, { kind: "aud", action: "add_cii", cycle_as_of: "2026-09-30", due: "2026-10-22", codes: ["CII D"], account_status: "82", party_id: "B-1", evidence_document_id: "doc-petition-notice", owner: "8.3" });
  assert.equal(lateDiscoveryCorrection({ discovered_on: D("2026-10-20"), row: row.row!, furnished: { cycle_as_of: D("2026-09-30"), transmitted_on: D("2026-10-02"), cii: "D", account_status: "82", dofd } }), null);
});

/** The bus: the 14.4 tools bound to a runtime whose timer engine runs the overridden registry for the feed's rows (and 8.3's BK_CII_APPLY_NEXT_CYCLE / SM_CR_SUPPRESSION_REVIEW_30, which the 14.4 rows share). */
function feedHarness(now = "2026-09-08T15:00:00.000Z") {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["14.4", "8.3"] });
  const ctx: UowContext & { decisions: DecisionInput[] } = { loanId: "L-1", events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push({ loanId: "L-1", ...d }); }, decisions };
  const agents = new AgentRegistry(); const store = new EntityStore(); const cmds = bindTools({ store, ports: {}, escalations: new EscalationService(events, clock), services: {} }, agents); const bus = new CommandBus(agents);
  const feed: Actor = { kind: "agent", id: "bankruptcy-ops" };
  const write = cmds.get(toolKey("14.4", "bk.reporting_state.write"))!;
  // the 14.1 case record as the docket monitor verified it: Chapter 7 example C, B-1 filed, B-2 did not (`filer_borrower_ids` and `verification` are the record's, never the caller's)
  store.put("bankruptcy_cases", "BK-7-C", { case_id: "BK-7-C", loan_id: "L-1", chapter: "7", status: "active", petition_date: "2026-09-08", filer_borrower_ids: ["B-1"], non_filing_obligor_ids: ["B-2"], verification: { sources: ["pcl", "ebn"], pcl_case_id: "4:26-bk-31234", verified_at: "2026-09-08T14:00:00.000Z", verified_by: "bankruptcy-ops" } }, feed, now);
  const base = { loan_id: "L-1", borrower_id: "B-1", case_id: "BK-7-C", chapter: "7", petition_date: "2026-09-08", earliest_unpaid_due_at_petition: "2026-05-01" };
  return { ctx, events, timers, store, bus, feed, write, base, decisions, cmds };
}

test("14.4 bus: guardrails refuse on the case record (typed `command.refused`), the feed never creates a suppression, the decision record is the spec's {trigger_event_id, phase, fields_written…}, each row supersedes the prior suppression, and the timers arm and satisfy on events the bus actually emits", async () => {
  const h = feedHarness();
  const { bus, feed, write, base, events, timers, decisions } = h;
  // rule 1 on the real path: the caller volunteers no filer set; the handler reads the case record and refuses the co-obligor under the guardrail's code, writing nothing but the refusal event
  await assert.rejects(bus.execute(write, feed, { ...base, borrower_id: "B-2", event: "bankruptcy.petition.filed", event_on: "2026-09-08", evidence_document_id: "doc-petition-notice" }, h.ctx),
    (e: unknown) => e instanceof CommandRefused && e.code === "NON_FILER_NEVER_GETS_ROW");
  assert.deepEqual(events.ofType("command.refused").map((e) => e.payload.code), ["NON_FILER_NEVER_GETS_ROW"]); assert.equal(h.store.list("bankruptcy_reporting_state").length, 0); assert.equal(decisions.length, 0);
  // a caller-volunteered filer set that contradicts the borrower is refused by the bus-level predicate under the same code
  await assert.rejects(bus.execute(write, feed, { ...base, borrower_id: "B-2", filer_borrower_ids: ["B-1"], event: "bankruptcy.petition.filed", event_on: "2026-09-08", evidence_document_id: "doc-petition-notice" }, h.ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NON_FILER_NEVER_GETS_ROW");
  // no case record → no row (typed); a case the record does not verify → no row (typed)
  await assert.rejects(bus.execute(write, feed, { ...base, case_id: "BK-unknown", event: "bankruptcy.petition.filed", event_on: "2026-09-08", evidence_document_id: "doc-petition-notice" }, h.ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_ROW_WITHOUT_VERIFIED_CASE");
  await assert.rejects(bus.execute(write, feed, { ...base, event: "bankruptcy.petition.filed", event_on: "2026-09-08", evidence_document_id: "doc-petition-notice", case_verified: false }, h.ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_ROW_WITHOUT_VERIFIED_CASE");
  // the agent cannot create suppressions directly: a call carrying 8.3's suppression-row fields, or a suppression op, is refused (credit.suppression.create/release is not a 14.4 tool at all)
  await assert.rejects(bus.execute(write, feed, { ...base, event: "bankruptcy.petition.filed", event_on: "2026-09-08", evidence_document_id: "doc-petition-notice", mechanism: "freeze_status", codes: ["CII A"] }, h.ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_DIRECT_SUPPRESSION");
  await assert.rejects(bus.execute(write, feed, { ...base, op: "create_suppression", evidence_document_id: "doc-petition-notice" }, h.ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_DIRECT_SUPPRESSION");
  assert.equal(h.cmds.get(toolKey("14.4", "credit.suppression.create/release")), undefined);
  // a status asserted against the day count is refused (rule 2: derived, never asserted)
  await assert.rejects(bus.execute(write, feed, { ...base, event: "bankruptcy.petition.filed", event_on: "2026-09-08", evidence_document_id: "doc-petition-notice", status_at_petition: "83" }, h.ctx), (e: unknown) => e instanceof CommandRefused && e.code === "STATUS_AT_PETITION_DERIVED");
  // SM_BK_CR_STATE_SYNC_1BD arms on the 14.1 phase event the bus carries — the case-record write — and the feed's row satisfies it within 1 BD
  events.append({ type: "bankruptcy.case.written", loanId: "L-1", aggregate: { kind: "bankruptcy_cases", id: "BK-7-C" }, actor: feed, payload: { id: "BK-7-C", version: 2, fields: ["status", "petition_date"] } });
  const sync = timers.byCode("SM_BK_CR_STATE_SYNC_1BD")[0]!; assert.equal(sync.status, "armed"); assert.equal(sync.dueDate, "2026-09-09");
  const petition = await bus.execute(write, feed, { ...base, event: "bankruptcy.petition.filed", event_on: "2026-09-08", evidence_document_id: "doc-petition-notice", trigger_event_id: "evt-petition-1" }, h.ctx);
  const out = petition.output as { phase: string; status_at_petition: string; cii_current: string; supersedes: unknown; fields_written: string[]; suppression: { mechanism: string } };
  assert.equal(out.phase, "petition"); assert.equal(out.status_at_petition, "82"); assert.equal(out.cii_current, "A"); assert.equal(out.supersedes, null); assert.equal(out.suppression.mechanism, "freeze_status"); assert.ok(out.fields_written.includes("phase") && out.fields_written.includes("status_at_petition"));
  assert.equal(sync.status, "satisfied");
  const changed = events.ofType("bankruptcy.reporting_state.changed"); assert.equal(changed.length, 1); assert.equal(changed[0]!.payload.trigger_event_id, "evt-petition-1"); assert.deepEqual(changed[0]!.payload.fields_written, out.fields_written);
  // the decision record: {case_id, borrower_id, trigger_event_id, phase, fields_written, evidence_document_id, rule_set_version, rationale} (as the rationale's JSON — DecisionInput has no facts column)
  assert.equal(decisions.length, 1); const d = decisions[0]!; assert.equal(d.action, "bk.reporting_state.write:write"); assert.equal(d.ruleSetVersion, RULE_SET_VERSION); assert.deepEqual(d.subject, { kind: "bankruptcy_reporting_state", id: "L-1:B-1" }); assert.deepEqual(d.evidenceDocumentIds, ["doc-petition-notice"]);
  const rec = JSON.parse(d.rationale) as Record<string, unknown>;
  assert.deepEqual(Object.keys(rec).sort(), ["borrower_id", "case_id", "evidence_document_id", "fields_written", "phase", "rationale", "rule_set_version", "trigger_event_id"]);
  assert.equal(rec.trigger_event_id, "evt-petition-1"); assert.equal(rec.phase, "petition"); assert.deepEqual(rec.fields_written, out.fields_written); assert.equal(rec.rule_set_version, RULE_SET_VERSION); assert.equal(rec.case_id, "BK-7-C");
  // BK_CII_APPLY_NEXT_CYCLE (8.3's row) arms on the feed's event and is satisfied when the next cycle furnishes the loan (8.1's per-loan `metro2.loan.furnished`)
  const apply = timers.byCode("BK_CII_APPLY_NEXT_CYCLE")[0]!; assert.equal(apply.status, "armed");
  events.append({ type: "metro2.loan.furnished", loanId: "L-1", actor: feed, payload: { cycle_id: "2026-09", account_status: "82", dofd: "2026-05-01", negative_information: true, b1_on_file: true, transmitted_at: "2026-10-02T15:00:00.000Z" } });
  assert.equal(apply.status, "satisfied");
  // the reaffirmation filing: the row carries it (CII stays A) and SM_BK_CR_REAFFIRM_HOLD arms on that row; the write supersedes nothing (same freeze, same CII A)
  const filed = await bus.execute(write, feed, { ...base, event: "bankruptcy.reaffirmation.filed", event_on: "2026-11-20", evidence_document_id: "doc-reaffirmation-2400a", trigger_event_id: "evt-reaff-1", as_of: "2026-11-20" }, h.ctx);
  assert.equal((filed.output as { cii_current: string }).cii_current, "A"); assert.equal((filed.output as { reaffirmation_date: string }).reaffirmation_date, "2026-11-20"); assert.equal((filed.output as { supersedes: unknown }).supersedes, null);
  assert.equal(timers.byCode("SM_BK_CR_REAFFIRM_HOLD").length, 1);
  // rescission inside the window → V, superseding the petition freeze (8.3 releases it on this event); the discharge then discharges the debt (E) and
  // SM_BK_CR_DISCHARGE_FINAL_RECORD arms on the row, satisfied by the next cycle's furnishing — not by 8.3 booking the suppression
  const resc = await bus.execute(write, feed, { ...base, event: "bankruptcy.reaffirmation.rescinded", event_on: "2026-12-01", evidence_document_id: "doc-rescission-notice", as_of: "2026-12-01" }, h.ctx);
  assert.deepEqual((resc.output as { supersedes: unknown }).supersedes, { reason: "bankruptcy_active", mechanism: "freeze_status", codes: ["CII A"], party_id: "B-1", final_reported: false, zero_balances: false });
  assert.equal(timers.byCode("SM_BK_CR_REAFFIRM_HOLD").length, 1, "a rescinded reaffirmation (reaffirmation_date null, V) does not re-arm the hold");
  const discharged = await bus.execute(write, feed, { ...base, event: "bankruptcy.case.discharged", event_on: "2026-12-15", evidence_document_id: "doc-discharge-order", trigger_event_id: "evt-discharge-1", as_of: "2026-12-16" }, h.ctx);
  const dis = discharged.output as { phase: string; debt_discharged: boolean; cii_current: string; supersedes: { codes: string[] }; suppression: { mechanism: string; reason: string } };
  assert.equal(dis.phase, "discharged"); assert.equal(dis.debt_discharged, true); assert.equal(dis.cii_current, "E"); assert.equal(dis.suppression.mechanism, "delete_account"); assert.deepEqual(dis.supersedes.codes, ["CII V"]);
  const fin = timers.byCode("SM_BK_CR_DISCHARGE_FINAL_RECORD")[0]!; assert.equal(fin.status, "armed");
  // 8.3 booking the `delete_account` suppression (`credit.suppression.created`, the moment it reads the row) is not the E record being furnished: the pattern does not match it
  // (checked against the pattern, not through the engine: `credit.suppression.created` arms the recurring SM_CR_SUPPRESSION_REVIEW_30, and the kernel engine re-arms a satisfied
  // recurring instance inside the loop that iterates the instances — src/kernel/timers/engine.ts onEvent — so satisfying it through the engine never returns)
  const reg = loadOverriddenRegistry();
  const booked: DomainEvent = { id: "e-sup", type: "credit.suppression.created", occurredAt: "2026-12-16T09:00:00.000Z", loanId: "L-1", actor: feed, payload: { id: "sup-1", reason: "bankruptcy_discharged", mechanism: "delete_account", party_id: "B-1", created_at: "2026-12-16T09:00:00.000Z" }, sequence: 0 };
  assert.equal(eventMatches(reg.get("SM_BK_CR_DISCHARGE_FINAL_RECORD")!.satisfiedPattern!, booked), false);
  assert.equal(eventMatches(reg.get("SM_CR_SUPPRESSION_REVIEW_30")!.triggerPattern!, booked), true);
  events.append({ type: "metro2.loan.furnished", loanId: "L-1", actor: feed, payload: { cycle_id: "2026-12", account_status: "82", dofd: "2026-05-01", negative_information: true, b1_on_file: true, transmitted_at: "2027-01-04T15:00:00.000Z" } });
  assert.equal(fin.status, "satisfied");
  // the routine closure after the discharge (example C: 2026-12-22) writes nothing: reviewed, no `.changed`, the row stays discharged/E, no new suppression is requested
  const closed = await bus.execute(write, feed, { ...base, event: "bankruptcy.case.closed", event_on: "2026-12-22", evidence_document_id: "doc-final-decree", trigger_event_id: "evt-closed-1" }, h.ctx);
  assert.deepEqual(closed.output, { written: false, no_change: true, phase: "discharged", sync_due: "2026-12-23", fields_written: [] });
  assert.equal(events.ofType("bankruptcy.reporting_state.changed").length, 4); assert.equal((h.store.get("bankruptcy_reporting_state", "L-1:B-1")!.data as { phase: string }).phase, "discharged");
  assert.equal(JSON.parse(decisions.at(-1)!.rationale).phase, "discharged");
  // the docket-check review (SM_CR_SUPPRESSION_REVIEW_30's 14.4 half; a case write that is not a phase event): recorded with `docket_checked`, consistent with the case record
  // it is also the 30-day review of the suppression 8.3 derived from the row: recorded under 8.3's `credit.suppression.reviewed` ("review recorded"), the event
  // SM_CR_SUPPRESSION_REVIEW_30 is satisfied by (pattern-checked, see above) — the feed's docket check is the review the 14.4 row names
  const review = await bus.execute(write, feed, { ...base, op: "review", trigger_event_id: "evt-sync-1" }, h.ctx);
  assert.deepEqual(review.output, { reviewed: true, docket_checked: true, consistent: true, phase: "discharged", suppression_reviewed: "bankruptcy_discharged", escalation: null });
  assert.equal(events.ofType("bankruptcy.reporting_state.reviewed").filter((e) => e.payload.docket_checked === true).length, 1);
  const reviewed = events.ofType("credit.suppression.reviewed"); assert.equal(reviewed.length, 1); assert.equal(reviewed[0]!.payload.reason, "bankruptcy_discharged"); assert.equal(reviewed[0]!.payload.docket_checked, true);
  assert.equal(eventMatches(reg.get("SM_CR_SUPPRESSION_REVIEW_30")!.satisfiedPattern!, reviewed[0]!), true);
  assert.equal(timers.byCode("SM_CR_SUPPRESSION_REVIEW_30").length, 0, "nothing armed it in this run (8.3's booking event was not appended)");
  assert.equal(decisions.at(-1)!.action, "bk.reporting_state.write:review"); assert.equal(decisions.at(-1)!.ruleCode, "14.4 SM_CR_SUPPRESSION_REVIEW_30");
  // T8 on the bus: the retraction leaves no active row, releases the derived suppression and files the officer escalation
  const retract = await bus.execute(write, feed, { ...base, op: "retract", reversed_on: "2027-01-05", evidence_document_id: "doc-pcl-mismatch", furnished: [{ cycle_as_of: "2026-12-31", transmitted_on: "2027-01-04", cii: "E", account_status: "82", dofd: "2026-05-01" }] }, h.ctx);
  assert.equal((retract.output as { retracted: number }).retracted, 1); assert.equal((retract.output as { escalation: string }).escalation, "officer");
  assert.equal((h.store.get("bankruptcy_reporting_state", "L-1:B-1")!.data as { retracted: boolean }).retracted, true); assert.equal(events.ofType("bankruptcy.reporting_state.retracted").length, 1); assert.equal(events.ofType("credit.correction.requested").length, 1);
  assert.equal(JSON.parse(decisions.at(-1)!.rationale).phase, "retracted");
});
