// 30.4 First-90-days servicing hand-off: ownership notice, first statement, first credit and investor cycles, vendor activations, EPD monitoring, servicing file, origination record retention and timer seeding
// spec/sections/30-post-purchase-servicing-setup-and-boarding-to-the-subservice/30-4-first-90-days-servicing-hand-off-ownership-notice-first-stat.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { TimerEngine, computeDue } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { levelPayment, ratePercent, cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { EntityStore } from "../../app/tools.ts";
import type { CommandContext } from "../../app/commands.ts";
import { TOOLS_30_4 } from "../../app/tools/section30-4.ts";
import { activateMiPolicy } from "../pmi/ops-10-4.ts";
import { openHandoff, boardingDueDates, handoffItem, satisfyItem, breachItem, recordPurchase, mirrorOwnershipNotice, ownershipNoticeMayRender, fnmaLetterEvidenced, FNMA_LETTER_EXPLAINER, cycleClocks, expectedFirstStatement, reconcileFirstStatement, firstCreditCycle, ackFirstCreditCycle,
  epdWatchUntil, epdEarliestDates, runEpdDaily, clearEpdFlags, closeEpdWatch, qcSelectionFromEpd, requestVendorActivation, confirmVendorActivation, rejectVendorActivation, miActivationCheck, seedMiSchedule, requestServicingFile, compileHandoffServicingFile, classifyRetention, classifyDocument, purgeFloor,
  expectedSeedSet, verifyTimerSeeding, repairTimer, recordSeedingVerified, closeHandoff, buildBoardedOriginationsReport, partnerCopy, containsNpi, dailyReportTick, publishDailyReport, HANDOFF_ITEM_DEFS, PURCHASE_DEPENDENT_ITEMS, REPAIR_PROVENANCE, AMOUNT_DUE_SEV2_THRESHOLD_CENTS,
  type HandoffState, type EpdInstallment, type EpdFlagRow, type ReportLoan, type BoardedFigures, type RenderedStatement, type RetentionAnchors, type OwnershipNoticeStatus } from "./ops-30-4.ts";

const AGENT: Actor = { kind: "agent", id: "boarding" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const LOAN = "L-REFI-1", APP = "APP-REFI-1";
const CTX = { loan_id: LOAN, application_id: APP };
const BOARDED_AT = "2026-11-12T19:05:00.000Z";                 // Thu Nov 12, 2026 12:05 MST — 30.2 worked example 1
const FPD = D("2027-01-01"), CONSUMMATION = D("2026-11-06"), FUNDING = D("2026-11-12"), BOARDED_ON = D("2026-11-12");
/** The refinance fixture ($560,000 LCOR, 30-year fixed 6.125%, Phoenix AZ, escrowed, no MI; 30.3 escrow $687.50/mo, deposit $2,062.50). */
const BOARDED: BoardedFigures = { pi_cents: 340262n, escrow_payment_cents: 68750n, first_payment_date: FPD, original_amount_cents: 56_000_000n, escrow_deposit_cents: 206250n, late_charge_pct: "5.00", late_charge_grace_days: 15 };
const STATEMENT: RenderedStatement = { amount_due_cents: 409012n, due_date: FPD, late_fee_cents: 17013n, late_fee_after: D("2027-01-16"), upb_cents: 56_000_000n, escrow_balance_cents: 206250n, transactions: [{ kind: "escrow_initial_deposit", amount_cents: 206250n }], fcra_negative_info_notice: false, partial_payment_policy_present: true, contact_information_present: true };

/** The 30.4 clocks over the overridden registry (plus the servicing/origination processes a T-id crosses into), in-memory events, a fixed clock. */
function harness(nowIso: string, processes: readonly string[] = ["30.4"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: [...processes] });
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const boarded = (extra: Record<string, unknown> = {}, loanId = LOAN, appId: string | null = APP) => events.append({ type: "loan.boarded", loanId, ...(appId ? { applicationId: appId } : {}), actor: AGENT, payload: { loan_id: loanId, boarded_at: BOARDED_AT, first_payment_date: FPD, source: appId ? "origination" : "transfer", ...extra } });
  const ofType = (t: string) => events.all().filter((e) => e.type === t);
  return { clock, events, timers, at, timer, boarded, ofType };
}
const open = (h: ReturnType<typeof harness>, mi = false): HandoffState => { const r = openHandoff(h.events, { ...CTX, boarded_at: BOARDED_AT, first_payment_date: FPD, mi_certificates_present: mi }, h.timers); return { handoff: r.handoff, items: r.items }; };
const tool = (name: string) => TOOLS_30_4.find((t) => t.name === name)!;
const guardOf = (name: string, code: string) => tool(name).guardrails!.find((g) => g.code === code)!;

test("30.4-T1: Given `loan.boarded` Thu Nov 12, 2026 for the refinance fixture, when the hand-off opens, then 22 `handoff_items` exist, HO-018 is `not_applicable{no_mi}`, HO-010…HO-014 are `pending` with `due_at` null until `loan.purchased`, and `SM_TAX_SERVICE_ACTIVATE_2BD`, `SM_FLOOD_LOL_SERVICING_LINK_2BD`, `SM_INSURANCE_TRACKING_ACTIVATE_2BD` are due Mon Nov 16, 2026, `SM_SERVICING_FILE_COMPILE_TEST_1BD` Fri Nov 13, `SM_ORIG_HANDOFF_CLOSE_90` Wed Feb 10, 2027.", () => {
  const h = harness(BOARDED_AT);
  h.boarded();
  const r = openHandoff(h.events, { ...CTX, boarded_at: BOARDED_AT, first_payment_date: FPD, mi_certificates_present: false }, h.timers);
  assert.equal(r.items.length, 22);
  assert.equal(HANDOFF_ITEM_DEFS.length, 22);
  assert.deepEqual(r.items.map((x) => x.item_code), HANDOFF_ITEM_DEFS.map((d) => d.code));
  const ho18 = r.items.find((x) => x.item_code === "HO-018")!;
  assert.equal(ho18.status, "not_applicable"); assert.equal(ho18.na_reason, "no_mi");
  assert.deepEqual(PURCHASE_DEPENDENT_ITEMS, ["HO-010", "HO-011", "HO-012", "HO-013", "HO-014"]);
  for (const code of PURCHASE_DEPENDENT_ITEMS) { const it = r.items.find((x) => x.item_code === code)!; assert.equal(it.status, "pending"); assert.equal(it.due_at, null); }
  assert.equal(r.handoff.status, "open"); assert.equal(r.handoff.opened_at, BOARDED_ON); assert.equal(r.handoff.close_by, D("2027-02-10"));
  // the engine's instances, armed on 30.2's `loan.boarded` under origination context
  for (const code of ["SM_TAX_SERVICE_ACTIVATE_2BD", "SM_FLOOD_LOL_SERVICING_LINK_2BD", "SM_INSURANCE_TRACKING_ACTIVATE_2BD"]) assert.equal(h.timer(code)!.dueDate, D("2026-11-16"), code);
  assert.equal(h.timer("SM_SERVICING_FILE_COMPILE_TEST_1BD")!.dueDate, D("2026-11-13"));
  assert.equal(h.timer("SM_ORIG_HANDOFF_CLOSE_90")!.dueDate, D("2027-02-10"));
  const due = boardingDueDates(BOARDED_ON);
  assert.equal(due.SM_TAX_SERVICE_ACTIVATE_2BD, D("2026-11-16")); assert.equal(due.SM_SERVICING_FILE_COMPILE_TEST_1BD, D("2026-11-13")); assert.equal(due.SM_ORIG_HANDOFF_CLOSE_90, D("2027-02-10"));
  assert.equal(r.items.find((x) => x.item_code === "HO-015")!.due_at, D("2026-11-16")); assert.equal(r.items.find((x) => x.item_code === "HO-019")!.due_at, D("2026-11-13"));
  // no MI → the registry's MI clock (armed on every `loan.boarded`) is retired as not_applicable; vendor requests go out for the three applicable vendors
  assert.equal(h.timer("SM_MI_ACTIVATION_CONFIRM_2BD")!.status, "cancelled"); assert.equal(r.retired_mi_timer_id, h.timer("SM_MI_ACTIVATION_CONFIRM_2BD")!.id);
  assert.deepEqual(r.vendor_requests.map((v) => v.vendor_kind), ["tax_service", "flood_lol", "insurance_tracking"]);
  assert.equal(h.ofType("vendor.activation.requested").length, 3);
  assert.equal(r.event.type, "servicing_handoff.opened"); assert.equal(r.event.applicationId, APP); assert.equal(r.event.payload.item_count, 22);
  // one product, two contexts: a transferred-in loan's `loan.boarded` (no application context) arms none of the 30.4 clocks
  const s = harness(BOARDED_AT); s.boarded({}, "L-XFER-9", null);
  assert.equal(s.timers.all().length, 0);
});

test("30.4-T2: Given `loan.purchased` Thu Nov 19, 2026, when HO-009 is evaluated, then 25.4's `ownership_transfer_notices.status='expected'` with `due_date=2026-12-19` is mirrored, no `NTC_REGZ_1026_39_OWNERSHIP_TRANSFER` is rendered, the portal explainer is primed the same day, and a borrower-uploaded copy of the Fannie Mae letter on Dec 28 satisfies HO-009 (`evidenced`) and 25.4's evidence timer.", () => {
  const h = harness(BOARDED_AT, ["30.4", "25.4"]);
  h.boarded();
  let s = open(h);
  h.at("2026-11-19T20:00:00.000Z");
  h.events.append({ type: "loan.purchased", loanId: LOAN, applicationId: APP, actor: { kind: "system", id: "investor-reporting" }, payload: { purchase_date: "2026-11-19", date_of_transfer: "2026-11-19", investor: "fnma", source: "origination" } });
  const evidence = h.timer("SM_O64_FNMA_1026_39_EVIDENCE_45")!;
  assert.equal(evidence.status, "armed"); assert.equal(evidence.dueDate, D("2027-01-03"));
  const m = mirrorOwnershipNotice(h.events, { ...CTX, purchase_date: D("2026-11-19"), covered_person: "fannie_mae" });
  assert.equal(m.status, "expected"); assert.equal(m.due_date, D("2026-12-19")); assert.equal(m.sender, "covered_person_direct"); assert.equal(m.render_notice, false); assert.equal(m.hard_deadline_owner, "25.4");
  assert.equal(ownershipNoticeMayRender("expected", "covered_person_direct"), false);
  assert.equal(m.explainer_primed_on, D("2026-11-19")); assert.equal(m.explainer_event.type, "portal.explainer.primed"); assert.equal(m.explainer_event.occurredAt.slice(0, 10), "2026-11-19");
  assert.equal(FNMA_LETTER_EXPLAINER.consumer_notice, false); assert.match(FNMA_LETTER_EXPLAINER.points.join(" "), /Fannie Mae is not your mortgage servicer/);
  assert.equal(h.events.all().filter((e) => /^notice\./.test(e.type) || String(e.payload.template ?? "").includes("NTC_REGZ_1026_39_OWNERSHIP_TRANSFER")).length, 0);
  s = recordPurchase(s, D("2026-11-19"));
  for (const code of PURCHASE_DEPENDENT_ITEMS) assert.ok(handoffItem(s, code).due_at !== null, `${code} due after purchase`);
  assert.equal(handoffItem(s, "HO-009").status, "pending");
  h.at("2026-12-28T17:30:00.000Z");
  const ev = fnmaLetterEvidenced(h.events, s, { document_id: "doc-fnma-letter-1", received_on: D("2026-12-28"), source: "borrower_upload" });
  assert.equal(ev.status, "evidenced"); assert.equal(ev.evidence_event.type, "ownership_transfer.notice.evidenced"); assert.equal(ev.evidence_event.payload.kind, "fnma_loan_purchase_letter");
  const ho9 = handoffItem(ev, "HO-009");
  assert.equal(ho9.status, "satisfied"); assert.equal(ho9.evidence_document_id, "doc-fnma-letter-1"); assert.equal(ho9.satisfied_at, D("2026-12-28")); assert.equal(ho9.note, "evidenced");
  assert.equal(evidence.status, "satisfied"); assert.equal(evidence.satisfiedByEventId, ev.evidence_event.id);
  // SM as the covered person (warehouse assignment) → 25.4's hard deadline; 30.4 still only mirrors
  const sm = mirrorOwnershipNotice(h.events, { ...CTX, purchase_date: D("2026-11-19"), covered_person: "sm_warehouse_assignee" });
  assert.equal(sm.sender, "servicer_on_behalf"); assert.equal(sm.status, "sent_by_sm"); assert.equal(ownershipNoticeMayRender(sm.status, sm.sender), true);
});

test("30.4-T3: Given the fixture, when the cycle-1 statement is sent Thu Dec 17, 2026, then reconciliation passes with amount due $4,090.12 (P&I $3,402.62 + escrow $687.50), due date Jan 1, 2027, late fee $170.13 if not received by Jan 16, UPB $560,000.00, escrow balance $2,062.50; given the statement shows $4,090.13, then `SM_FIRST_STATEMENT_RECONCILE_1BD` breaches and 7.1 issues a corrected statement.", () => {
  const h = harness(BOARDED_AT);
  h.boarded();
  const s = open(h);
  h.at("2026-12-17T16:00:00.000Z");
  const sent = h.events.append({ type: "statement.sent", loanId: LOAN, applicationId: APP, actor: { kind: "agent", id: "disclosures" }, payload: { cycle: 1, cycle_due_date: FPD, statement_date: "2026-12-17", variant: "standard", template: "NTC_REGZ_41_STMT_STD", sent_at: "2026-12-17T16:00:00.000Z", mailed_at: "2026-12-17T16:00:00.000Z", channel: "mail", reminder_panel: false, single_statement_exemption_used: false } });
  const t = h.timer("SM_FIRST_STATEMENT_RECONCILE_1BD")!;
  assert.equal(t.status, "armed"); assert.equal(t.dueDate, D("2026-12-18"));
  const expected = expectedFirstStatement(BOARDED);
  assert.equal(expected.amount_due_cents, 409012n); assert.equal(expected.amount_due_cents, 340262n + 68750n);
  assert.equal(expected.due_date, D("2027-01-01")); assert.equal(expected.late_fee_cents, 17013n); assert.equal(expected.late_fee_after, D("2027-01-16"));
  assert.equal(expected.upb_cents, 56_000_000n); assert.equal(expected.escrow_balance_cents, 206250n);
  const ok = reconcileFirstStatement(h.events, s, { statement: STATEMENT, boarded: BOARDED, statement_event_id: sent.id, at: "2026-12-17T17:00:00.000Z" });
  assert.equal(ok.passed, true); assert.deepEqual(ok.mismatches, []); assert.equal(ok.corrected_statement_required, false);
  assert.equal(ok.event!.type, "handoff_item.satisfied"); assert.equal(ok.event!.payload.item_code, "HO-006");
  assert.equal(handoffItem(ok.state, "HO-006").status, "satisfied"); assert.equal(handoffItem(ok.state, "HO-006").evidence_event_id, sent.id);
  assert.equal(t.status, "satisfied");
  // the $4,090.13 statement: a one-cent discrepancy in the amount due is sev-2, the clock keeps running and breaches +1 BD; 7.1 issues the corrected statement
  const b = harness(BOARDED_AT); b.boarded(); const sb = open(b);
  b.at("2026-12-17T16:00:00.000Z");
  const sent2 = b.events.append({ type: "statement.sent", loanId: LOAN, applicationId: APP, actor: { kind: "agent", id: "disclosures" }, payload: { cycle: 1, cycle_due_date: FPD, statement_date: "2026-12-17", sent_at: "2026-12-17T16:00:00.000Z" } });
  const bad = reconcileFirstStatement(b.events, sb, { statement: { ...STATEMENT, amount_due_cents: 409013n }, boarded: BOARDED, statement_event_id: sent2.id, at: "2026-12-17T17:00:00.000Z" });
  assert.equal(bad.passed, false); assert.equal(bad.amount_due_discrepancy_cents, 1n); assert.ok(bad.amount_due_discrepancy_cents >= AMOUNT_DUE_SEV2_THRESHOLD_CENTS);
  assert.deepEqual(bad.mismatches, [{ field: "amount_due_cents", expected: "409012", actual: "409013", severity: "sev2" }]);
  assert.equal(bad.corrected_statement_required, true); assert.equal(bad.corrected_by, "7.1"); assert.equal(bad.event!.type, "first_statement.discrepancy"); assert.equal(bad.event!.payload.severity, "sev2");
  assert.equal(handoffItem(bad.state, "HO-006").status, "pending");
  const breaches = b.timers.evaluate("2026-12-19T05:00:00.000Z");
  const br = breaches.find((x) => x.def.code === "SM_FIRST_STATEMENT_RECONCILE_1BD")!;
  assert.ok(br, "the reconcile clock breached"); assert.equal(br.severity, 2); assert.match(br.breachText, /corrected statement is issued by 7\.1/);
  assert.equal(b.timer("SM_FIRST_STATEMENT_RECONCILE_1BD")!.status, "breached");
});

test("30.4-T4: Given the Jan 1, 2027 installment is paid Wed Dec 30, 2026, when cycle 2 runs, then `REGZ_1026_41B_STATEMENT_PROMPT_4` is due Wed Jan 20, 2027 from the Sat Jan 16 courtesy end and no `FNMA_D2_2_03_PAYMENT_REMINDER_20` instance is created; given it is unpaid on Jan 17, then the reminder is due Jan 20 and the late-charge gate opens on the next servicer business day after Sat Jan 16.", () => {
  const paid = cycleClocks({ first_payment_date: FPD, late_charge_grace_days: 15, paid_on: D("2026-12-30"), as_of: D("2027-01-20") });
  assert.equal(paid.first_statement_by, D("2026-12-17"));
  assert.equal(paid.courtesy_period_end, D("2027-01-16")); assert.equal(paid.second_statement_by, D("2027-01-20"));
  assert.equal(paid.reminder_instance, false); assert.equal(paid.reminder_due, null);
  const unpaid = cycleClocks({ first_payment_date: FPD, late_charge_grace_days: 15, paid_on: null, as_of: D("2027-01-17") });
  assert.equal(unpaid.reminder_instance, true); assert.equal(unpaid.reminder_due, D("2027-01-20"));
  assert.equal(unpaid.late_charge_grace_end, D("2027-01-16"));
  assert.equal(unpaid.late_charge_gate_opens, D("2027-01-19"));   // Sat Jan 16 → Sun → Mon Jan 18 (MLK Day) → Tue Jan 19
  // 7.1's own rows over the registry: the statement clock from `statement.cycle.opened{courtesy_period_end}`; the reminder only from `payment.cycle.unpaid_day16`
  const h = harness("2027-01-17T06:00:00.000Z", ["7.1"]);
  h.events.append({ type: "statement.cycle.opened", loanId: LOAN, actor: AGENT, payload: { cycle_due_date: "2027-02-01", prior_due_date: FPD, courtesy_period_end: "2027-01-16", statement_due_by: "2027-01-20", late_charge_grace_days: 15 } });
  assert.equal(h.timer("REGZ_1026_41B_STATEMENT_PROMPT_4")!.dueDate, D("2027-01-20"));
  assert.equal(h.timers.byCode("FNMA_D2_2_03_PAYMENT_REMINDER_20").length, 0, "paid Dec 30: no reminder instance");
  h.events.append({ type: "payment.cycle.unpaid_day16", loanId: LOAN, actor: AGENT, payload: { due_date: FPD, unpaid_on: "2027-01-17" } });
  assert.equal(h.timer("FNMA_D2_2_03_PAYMENT_REMINDER_20")!.dueDate, D("2027-01-20"));
  // 2.x's grace gate row: anchor `grace_end_on` Sat Jan 16, offset 0 rolled to the next servicer business day
  const gate = loadOverriddenRegistry().get("NOTE_6A_LATE_CHARGE_GRACE_GATE")!;
  assert.equal(gate.anchorField, "grace_end_on");
  assert.equal(computeDue({ kind: "step", n: 0, unit: "calendar_days", rollTo: "business_days_servicer" }, D("2027-01-16"), Date.parse("2027-01-16T05:00:00Z")).dueDate, D("2027-01-19"));
});

test("30.4-T5: Given boarding Nov 12 with `loan.active` on Nov 13, when the Nov 30 snapshot runs, then the loan appears with Date Opened 11062026, status 11, current balance 000560000, DOFD blank, PHP `BBBBBBBBBBBBBBBBBBBBBBBB`, and HO-007 is satisfied on the 8.1 acknowledgment; given `loan.boarding.warnings_open` with an identity OW rule, then the loan is held to the Dec 31 snapshot with `credit.cycle.held{reason}`.", () => {
  const h = harness("2026-12-01T05:05:00.000Z");
  h.boarded();
  const s = open(h);
  const state = { installments: [], upb_cents: 56_000_000n, deferred_principal_cents: 0n, forborne_principal_cents: 0n, pi_cents: 340262n, escrow_cents: 68750n, original_amount_cents: 56_000_000n, note_date: CONSUMMATION, maturity_date: D("2056-12-01"), original_term_months: 360, remaining_term_months: 360, interest_type: "F" as const, fnma_loan_number: "4000000777", min: "100012300000000778", payments_in_month_cents: 0n, last_payment_on: null, condition: { kind: "none" as const }, consumers: [{ party_id: "B1", position: 1, same_address_as_base: true, liability: "individual" as const }], prior: null };
  const c = firstCreditCycle(h.events, { ...CTX, boarded_on: BOARDED_ON, active_on: D("2026-11-13"), warnings_open: [], as_of: D("2026-11-30"), state });
  assert.equal(c.held, false); assert.equal(c.as_of, D("2026-11-30"));
  assert.equal(c.base!.date_opened, "11062026"); assert.equal(c.base!.account_status, "11"); assert.equal(c.base!.current_balance, "000560000");
  assert.equal(c.base!.date_of_first_delinquency, "00000000"); assert.equal(c.snapshot!.dofd, null);
  assert.equal(c.base!.payment_history_profile, "BBBBBBBBBBBBBBBBBBBBBBBB"); assert.equal(c.base!.payment_history_profile.length, 24);
  assert.equal(c.base!.scheduled_monthly_payment, "000004090"); assert.equal(c.base!.original_loan_amount, "000560000"); assert.equal(c.snapshot!.consumers[0]!.ecoa, "1");
  const ack = h.events.append({ type: "metro2.ack.received", loanId: LOAN, applicationId: APP, actor: { kind: "agent", id: "credit-reporting" }, payload: { bureau: "equifax", file_id: "f-1", received_at: "2026-12-04", reject_count: 0, items: [] } });
  const a = ackFirstCreditCycle(h.events, s, { event_id: ack.id, received_at: "2026-12-04T15:00:00.000Z", items: [] });
  assert.equal(a.satisfied, true); assert.equal(handoffItem(a, "HO-007").status, "satisfied"); assert.equal(handoffItem(a, "HO-007").evidence_event_id, ack.id);
  const rejected = ackFirstCreditCycle(h.events, s, { event_id: "e-2", received_at: "2026-12-04T15:00:00.000Z", items: [{ loan_id: LOAN, status: "rejected" }] });
  assert.equal(rejected.satisfied, false, "HO-007 waits on SM_METRO2_REJECT_RESOLVE_BD5 while the loan has a reject");
  // identity OW rule open (30.2 `loan.boarding.warnings_open`) → held from the first cycle, reported at the Dec 31 snapshot
  const held = firstCreditCycle(h.events, { ...CTX, boarded_on: BOARDED_ON, active_on: D("2026-11-13"), warnings_open: ["OW-001", "OW-008"], as_of: D("2026-11-30"), state });
  assert.equal(held.held, true); assert.match(held.reason!, /OW-001/); assert.doesNotMatch(held.reason!, /OW-008/); assert.equal(held.held_to_as_of, D("2026-12-31"));
  assert.equal(held.event!.type, "credit.cycle.held"); assert.equal(held.event!.payload.reason, held.reason); assert.equal(held.event!.payload.held_to_as_of, D("2026-12-31"));
  const inactive = firstCreditCycle(h.events, { ...CTX, boarded_on: BOARDED_ON, active_on: null, warnings_open: [], as_of: D("2026-11-30"), state });
  assert.equal(inactive.held, true); assert.match(inactive.reason!, /not active/);
});

const INSTALLMENTS = (paid: Partial<Record<number, PlainDate | null>>): EpdInstallment[] => [1, 2, 3, 4, 5, 6].map((n) => ({ n, due_date: D(`2027-${String(n).padStart(2, "0")}-01`), paid_on: paid[n] === undefined ? null : paid[n]! }));

test("30.4-T6: Given no payment on the Jan 1 installment, when the daily EPD job runs, then `sm_watch_p1_6_30` is raised Sun Jan 31, 2027 (30 days past due), `fnma_e205_p1_3_60` and `sm_qc_p1_6_60` are raised Tue Mar 2, 2027, `epd.flag.raised` reaches 28.2 (immediate `qc_reviews{kind='epd'}`), and a payment posted Mar 3 that cures Jan 1 clears the 60-day flags with `clear_reason='payment'` while the history rows remain.", () => {
  const h = harness("2026-11-13T18:00:00.000Z");
  h.events.append({ type: "loan.active", loanId: LOAN, applicationId: APP, actor: AGENT, payload: { first_payment_date: FPD, active_on: "2026-11-13", source: "origination" } });
  const watch = h.timer("SM_ORIG_EPD_WATCH_P6_60")!;
  assert.equal(watch.status, "armed"); assert.equal(watch.note, "evaluator:30.4.epdWatchOpen"); assert.equal(watch.anchorDate, FPD);
  assert.equal(epdWatchUntil(FPD), D("2027-07-31"));
  assert.deepEqual(epdEarliestDates(FPD), { sm_watch_p1_6_30: D("2027-01-31"), fnma_e205_p1_3_60: D("2027-03-02"), sm_qc_p1_6_60: D("2027-03-02") });
  // 28.2 consumes `epd.flag.raised{definition=sm_qc_p1_6_60}` as an immediate discretionary selection
  const qc = new EntityStore();
  h.events.subscribe("epd.flag.raised", (e) => { const sel = qcSelectionFromEpd(e); if (sel) qc.put("qc_reviews", `qc-${sel.flag_id}`, { kind: sel.kind, selection: sel.selection, loan_id: e.loanId, opened_on: e.occurredAt.slice(0, 10) }, { kind: "agent", id: "qc-audit" }, e.occurredAt); });
  const inst = INSTALLMENTS({});
  let flags: EpdFlagRow[] = [];
  const run = (on: string) => { h.at(`${on}T09:00:00.000Z`); const r = runEpdDaily(h.events, { ...CTX, as_of: D(on), installments: inst, flags }); flags = [...r.flags]; return r.raised; };
  assert.deepEqual(run("2027-01-30"), []);
  const jan31 = run("2027-01-31");
  assert.deepEqual(jan31.map((f) => [f.definition, f.installment_no, f.days_past_due_at_flag, f.basis]), [["sm_watch_p1_6_30", 1, 30, "calendar_days_past_due"]]);
  assert.equal(jan31[0]!.flagged_at, D("2027-01-31")); assert.equal(jan31[0]!.fnma_month_bucket, "30");
  assert.deepEqual(run("2027-02-01"), [], "an open flag is never re-raised");
  assert.deepEqual(run("2027-03-01"), []);
  const mar2 = run("2027-03-02");
  assert.deepEqual(mar2.map((f) => [f.definition, f.installment_no, f.days_past_due_at_flag]).sort(), [["fnma_e205_p1_3_60", 1, 60], ["sm_qc_p1_6_60", 1, 60]]);
  assert.equal(qc.list("qc_reviews").length, 1); assert.equal(qc.list("qc_reviews")[0]!.data.kind, "epd"); assert.equal(qc.list("qc_reviews")[0]!.data.opened_on, "2027-03-02");
  assert.equal(h.ofType("epd.flag.raised").length, 3); assert.equal(h.ofType("epd.flag.raised")[0]!.applicationId, APP);
  assert.equal(evaluateGate("30.4.epdWatchOpen", { as_of: "2027-03-02", epd_watch_until: "2027-07-31" }).open, true);
  // Mar 3: the payment that cures Jan 1 (2.x `payment.posted` is the ledger event) clears the 60-day flags with clear_reason='payment'; the rows remain
  h.at("2027-03-03T15:00:00.000Z");
  const posted = h.events.append({ type: "payment.posted", loanId: LOAN, actor: { kind: "agent", id: "cashiering" }, payload: { installment_due_date: FPD, amount_cents: "409012", received_on: "2027-03-03" } });
  const cured = INSTALLMENTS({ 1: D("2027-03-03") });
  assert.throws(() => clearEpdFlags(h.events, { ...CTX, as_of: D("2027-03-03"), installments: cured, flags, clear_reason: "payment", ledger_event_id: "" }), RangeError);
  const cl = clearEpdFlags(h.events, { ...CTX, as_of: D("2027-03-03"), installments: cured, flags, clear_reason: "payment", ledger_event_id: posted.id });
  const sixty = cl.cleared.filter((f) => f.definition !== "sm_watch_p1_6_30");
  assert.deepEqual(sixty.map((f) => f.definition).sort(), ["fnma_e205_p1_3_60", "sm_qc_p1_6_60"]);
  for (const f of sixty) { assert.equal(f.clear_reason, "payment"); assert.equal(f.cleared_at, D("2027-03-03")); }
  assert.equal(cl.flags.length, 3, "history rows remain"); assert.ok(cl.flags.every((f) => f.flagged_at !== null && f.days_past_due_at_flag === (f.definition === "sm_watch_p1_6_30" ? 30 : 60)));
  assert.equal(cl.qc_withdraw, false); assert.equal(h.ofType("epd.flag.cleared").length, 3); assert.equal(h.ofType("epd.flag.cleared")[0]!.payload.ledger_event_id, posted.id);
  assert.ok(runEpdDaily(h.events, { ...CTX, as_of: D("2027-03-04"), installments: cured, flags: cl.flags }).raised.every((f) => f.installment_no !== 1), "the cured Jan 1 installment raises nothing further (Feb 1, still unpaid, runs its own clocks)");
  assert.equal(guardOf("evaluateEpd", "EPD_CLEAR_NEEDS_LEDGER_EVENT").refuse({ op: "clear", clear_reason: "payment" }, { actor: AGENT } as unknown as CommandContext)?.includes("ledger event"), true);
});

test("30.4-T7: Given installments 1–3 paid on time and installment 5 (May 1, 2027) 60 days past due on Jun 30, 2027, then `fnma_e205_p1_3_60` is never raised, `sm_qc_p1_6_60` is raised Jun 30, and the watch closes Sat Jul 31, 2027 (`epd.watch.closed`); given the loan paid off on Apr 15, 2027, then the watch closes that day.", () => {
  const h = harness("2026-11-13T18:00:00.000Z");
  h.events.append({ type: "loan.active", loanId: LOAN, applicationId: APP, actor: AGENT, payload: { first_payment_date: FPD, source: "origination" } });
  const watch = h.timer("SM_ORIG_EPD_WATCH_P6_60")!;
  const inst = INSTALLMENTS({ 1: FPD, 2: D("2027-02-01"), 3: D("2027-03-01"), 4: D("2027-04-01"), 5: null, 6: D("2027-06-01") });
  let flags: EpdFlagRow[] = [];
  for (let d = D("2027-05-01"); d <= D("2027-06-30"); d = addDays(d, 1)) { h.at(`${d}T09:00:00.000Z`); flags = [...runEpdDaily(h.events, { ...CTX, as_of: d, installments: inst, flags }).flags]; }
  assert.equal(flags.some((f) => f.definition === "fnma_e205_p1_3_60"), false, "E-2-05 covers payments 1–3 only");
  const qc = flags.find((f) => f.definition === "sm_qc_p1_6_60")!;
  assert.equal(qc.installment_no, 5); assert.equal(qc.flagged_at, D("2027-06-30")); assert.equal(qc.days_past_due_at_flag, 60);
  assert.equal(flags.find((f) => f.definition === "sm_watch_p1_6_30")!.flagged_at, D("2027-05-31"));
  const until = epdWatchUntil(FPD);
  assert.equal(until, D("2027-07-31"));
  assert.equal(closeEpdWatch(h.events, { ...CTX, as_of: D("2027-07-30"), epd_watch_until: until }).closed, false);
  assert.equal(evaluateGate("30.4.epdWatchOpen", { as_of: "2027-07-31", epd_watch_until: until }).open, true);
  assert.equal(evaluateGate("30.4.epdWatchOpen", { as_of: "2027-08-01", epd_watch_until: until }).open, false);
  h.at("2027-07-31T09:00:00.000Z");
  const closed = closeEpdWatch(h.events, { ...CTX, as_of: D("2027-07-31"), epd_watch_until: until });
  assert.equal(closed.closed, true); assert.equal(closed.closed_on, D("2027-07-31")); assert.equal(closed.basis, "window_end"); assert.equal(closed.event!.type, "epd.watch.closed");
  assert.equal(watch.status, "satisfied"); assert.equal(watch.satisfiedByEventId, closed.event!.id);
  // paid off Apr 15, 2027 → the watch closes that day
  const p = harness("2026-11-13T18:00:00.000Z");
  p.events.append({ type: "loan.active", loanId: LOAN, applicationId: APP, actor: AGENT, payload: { first_payment_date: FPD, source: "origination" } });
  p.at("2027-04-15T20:00:00.000Z");
  const payoff = closeEpdWatch(p.events, { ...CTX, as_of: D("2027-04-15"), epd_watch_until: until, paid_off_on: D("2027-04-15") });
  assert.equal(payoff.closed, true); assert.equal(payoff.closed_on, D("2027-04-15")); assert.equal(payoff.basis, "payoff");
  assert.equal(p.timer("SM_ORIG_EPD_WATCH_P6_60")!.status === "satisfied" || p.timers.byCode("SM_ORIG_EPD_WATCH_P6_60")[0]!.status === "satisfied", true);
  assert.equal(evaluateGate("30.4.epdWatchOpen", { as_of: "2027-04-16", epd_watch_until: until, paid_off_on: "2027-04-15" }).open, false);
});

const LEDGER_OPENING = [
  { id: "le-1", posted_at: "2026-11-12T19:05:00.000Z", description: "opening principal (funding)", principal_cents: 56_000_000n },
  { id: "le-2", posted_at: "2026-11-12T19:05:00.000Z", description: "escrow initial deposit (custodial_ti_prepurchase)", escrow_cents: 206250n },
];
const DATA_FIELDS = { loans: { loan_id: LOAN, servicer_loan_number: "SM-0000777", first_payment_date: FPD, original_upb_cents: "56000000", borrower_ssn: "123-45-6789" }, loan_terms: { note_rate_pct: "6.125", pi_cents: "340262", late_charge_pct: "5.00", grace_days: 15 }, escrow_accounts: [{ status: "active", monthly_cents: "68750", balance_cents: "206250" }] };

test("30.4-T8: Given a §1024.36 request received Mon Nov 16, 2026 asking for the payment history, when `compileServicingFile` runs, then the package contains the opening-ledger schedule (principal 56,000,000; escrow 206,250; prepaid interest as an origination charge, not a loan-account transaction), the executed security instrument marked `pending_recorded_copy`, the interaction notes, the data-field report and an empty (v) container, `within_five_days=true` if completed by Sat Nov 21, 2026 23:59; the boarding test on Nov 13 recorded `elapsed_seconds`.", () => {
  const h = harness(BOARDED_AT);
  h.boarded();
  const s = open(h);
  // the boarding-day test compile (Nov 13) proves the five-day capability and records elapsed_seconds; HO-019 satisfied
  h.at("2026-11-13T15:00:00.000Z");
  const test1 = compileHandoffServicingFile(h.events, s, { ...CTX, kind: "boarding_test", request_id: null, requested_at: "2026-11-13T15:00:00.000Z", compiled_at: "2026-11-13T15:00:04.250Z", elapsed_ms: 4250, ledger_entries: LEDGER_OPENING, security_instrument: { document_id: "doc-dot-1", recorded: false }, interaction_notes: [{ at: "2026-11-12T20:00:00Z", author: "boarding", narrative: "first-payment letter payee data verified" }], data_fields: DATA_FIELDS, borrower_documents: [] });
  assert.equal(test1.compilation.elapsed_seconds, 4.25); assert.equal(test1.compilation.kind, "boarding_test"); assert.equal(test1.compilation.within_five_days, true);
  assert.equal(handoffItem(test1.state!, "HO-019").status, "satisfied");
  assert.equal(h.timer("SM_SERVICING_FILE_COMPILE_TEST_1BD")!.status, "satisfied");
  assert.equal(h.timers.byCode("REGX_1024_38C2_SERVICING_FILE_5").length, 0, "the boarding test neither arms nor closes the statutory clock");
  // the §1024.36 request (Mon Nov 16) → REGX_1024_38C2_SERVICING_FILE_5 due Sat Nov 21 23:59
  h.at("2026-11-16T15:30:00.000Z");
  const req = requestServicingFile(h.events, { ...CTX, kind: "regx_35_36", requested_at: "2026-11-16T15:30:00.000Z", requester: "borrower", scope: "payment history" });
  assert.equal(req.due_on, D("2026-11-21")); assert.equal(req.event.payload.kind, "regx_35_36");
  const t = h.timer("REGX_1024_38C2_SERVICING_FILE_5")!;
  assert.equal(t.status, "armed"); assert.equal(t.dueDate, D("2026-11-21")); assert.equal(t.anchorDate, D("2026-11-16"));
  h.at("2026-11-17T14:00:00.000Z");
  const r = compileHandoffServicingFile(h.events, test1.state, { ...CTX, kind: "regx_35_36", request_id: req.request_id, requested_at: "2026-11-16T15:30:00.000Z", compiled_at: "2026-11-17T14:00:03.000Z", elapsed_ms: 3000, ledger_entries: LEDGER_OPENING, security_instrument: { document_id: "doc-dot-1", recorded: false }, interaction_notes: [{ at: "2026-11-12T20:00:00Z", author: "boarding", narrative: "first-payment letter payee data verified" }, { at: "2026-11-16T15:30:00Z", author: "human_agent", narrative: "§1024.36 request: payment history" }], data_fields: DATA_FIELDS, borrower_documents: [] });
  assert.equal(r.bundle.transaction_schedule.closing.principal_cents, 56_000_000n); assert.equal(r.bundle.transaction_schedule.closing.escrow_cents, 206250n); assert.equal(r.bundle.transaction_schedule.closing.interest_cents, 0n);
  assert.equal(r.bundle.transaction_schedule.rows.length, 2);
  assert.equal(r.compilation.items.ii.status, "pending_recorded_copy"); assert.deepEqual(r.compilation.items.ii.document_ids, ["doc-dot-1"]);
  assert.equal(r.compilation.items.iii.count, 2); assert.ok(r.compilation.items.iv.count > 0);
  assert.ok(r.bundle.data_field_report.find((x) => x.field === "borrower_ssn")!.redacted);
  assert.equal(r.compilation.items.v.included, "not_applicable"); assert.equal(r.compilation.items.v.count, 0); assert.deepEqual(r.bundle.borrower_submitted, []);
  assert.equal(r.compilation.within_five_days, true); assert.equal(r.compilation.due_on, D("2026-11-21")); assert.equal(r.compilation.request_id, req.request_id);
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, r.event.id);
  assert.match(r.compilation.package_document_id, /^doc-sfp-/); assert.equal(r.compilation.package_sha256, r.bundle.sha256);
  // prepaid interest is an origination charge — a schedule that carries it is refused; a compile after Nov 21 is outside the five days
  assert.throws(() => compileHandoffServicingFile(h.events, null, { ...CTX, kind: "regx_35_36", request_id: req.request_id, requested_at: "2026-11-16T15:30:00.000Z", compiled_at: "2026-11-17T14:00:03.000Z", elapsed_ms: 1, ledger_entries: [...LEDGER_OPENING, { id: "le-3", posted_at: "2026-11-12T19:05:00.000Z", account: "prepaid_interest", interest_cents: 178543n }], security_instrument: null, interaction_notes: [], data_fields: DATA_FIELDS, borrower_documents: [] }), RangeError);
  const late = compileHandoffServicingFile(h.events, null, { ...CTX, kind: "regx_35_36", request_id: req.request_id, requested_at: "2026-11-16T15:30:00.000Z", compiled_at: "2026-11-22T14:00:00.000Z", elapsed_ms: 1, ledger_entries: LEDGER_OPENING, security_instrument: { document_id: "doc-dot-1", recorded: true, recording_reference: "Maricopa 2026-1234567" }, interaction_notes: [], data_fields: DATA_FIELDS, borrower_documents: [] });
  assert.equal(late.compilation.within_five_days, false); assert.equal(late.compilation.items.ii.status, "recorded");
});

const DOCS = [{ document_id: "d-le", kind: "le" }, { document_id: "d-cd", kind: "cd" }, { document_id: "d-atr", kind: "atr_worksheet" }, { document_id: "d-regb", kind: "regb_approval_notice" }, { document_id: "d-afba", kind: "afba" }, { document_id: "d-sfhdf", kind: "sfhdf" }, { document_id: "d-esign", kind: "esign_consent" }];
const ANCHORS: RetentionAnchors = { consummation: CONSUMMATION, action_taken_notice: D("2026-10-30"), afba_execution: D("2026-10-05"), hmda_submission: D("2027-03-01"), compensation_payment: FUNDING };

test("30.4-T9: Given the indexed origination documents, when `classifyRetention` runs, then the LE → `regz_le_3y` / 2029-11-06, CD → `regz_cd_5y` / 2031-11-06 (but `retention_until` = the Fannie Mae class value, i.e., null until liquidation), ATR worksheet → `regz_atr_3y` / 2029-11-06, Reg B notices → `regb_25m` / 25 months after the notification date, AfBA → `respa_afba_5y` / 2031-10-05, SFHDF → `fdpa_life_of_loan`, E-SIGN consents → `esign_consent_life`; a document with no class blocks `servicing_handoffs.complete` via `SM_ORIG_RETENTION_CLASSIFY_GATE`.", () => {
  const h = harness(BOARDED_AT);
  h.boarded();
  const s = open(h);
  assert.equal(h.timer("SM_ORIG_RETENTION_CLASSIFY_GATE")!.note, "evaluator:30.4.retentionClassified");
  const r = classifyRetention(h.events, CTX, { documents: DOCS, anchors: ANCHORS, computed_at: BOARDED_AT });
  const by = (id: string) => r.rows.find((x) => x.document_id === id)!;
  assert.equal(by("d-le").retention_class, "regz_le_3y"); assert.equal(by("d-le").retention_until, D("2029-11-06")); assert.equal(by("d-le").anchor_event, "consummation");
  assert.equal(by("d-cd").retention_class, "regz_cd_5y"); assert.equal(by("d-cd").class_until, D("2031-11-06")); assert.equal(by("d-cd").retention_until, null); assert.equal(by("d-cd").governing_class, "fnma_loan_file_life_plus_4y");
  assert.equal(by("d-atr").retention_class, "regz_atr_3y"); assert.equal(by("d-atr").retention_until, D("2029-11-06"));
  assert.equal(by("d-regb").retention_class, "regb_25m"); assert.equal(by("d-regb").anchor_date, D("2026-10-30")); assert.equal(by("d-regb").retention_until, D("2028-11-30"));
  assert.equal(by("d-afba").retention_class, "respa_afba_5y"); assert.equal(by("d-afba").retention_until, D("2031-10-05"));
  assert.equal(by("d-sfhdf").retention_class, "fdpa_life_of_loan"); assert.equal(by("d-sfhdf").retention_until, null); assert.equal(by("d-sfhdf").anchor_date, CONSUMMATION);
  assert.equal(by("d-esign").retention_class, "esign_consent_life"); assert.equal(by("d-esign").retention_until, null);
  assert.equal(r.gate_open, true); assert.equal(r.unclassified.length, 0); assert.equal(r.purge_floor, D("2031-01-01")); assert.equal(purgeFloor(CONSUMMATION), D("2031-01-01"));
  assert.equal(r.events[0]!.type, "documents.retention.classified"); assert.equal(r.events[0]!.payload.unclassified_count, 0);
  assert.equal(h.timer("SM_ORIG_RETENTION_CLASSIFY_GATE")!.status, "satisfied");
  // liquidation moves the Fannie Mae class: the CD's retention_until becomes payoff + 4 years
  assert.equal(classifyDocument({ document_id: "d-cd", kind: "cd" }, { ...ANCHORS, liquidation: D("2040-03-15") }, BOARDED_AT).retention_until, D("2044-03-15"));
  // a document with no class → the gate stays closed and `servicing_handoffs.complete` is refused
  const g = harness(BOARDED_AT); g.boarded(); const s2 = open(g);
  const bad = classifyRetention(g.events, CTX, { documents: [...DOCS, { document_id: "d-misc", kind: "misc_upload" }], anchors: ANCHORS, computed_at: BOARDED_AT });
  assert.equal(bad.gate_open, false); assert.deepEqual(bad.unclassified, ["d-misc"]); assert.equal(g.timer("SM_ORIG_RETENTION_CLASSIFY_GATE")!.status, "armed");
  const facts = { documents: bad.rows.map((x) => ({ document_id: x.document_id, retention_class: x.retention_class, retention_anchor_date: x.anchor_date })) };
  assert.equal(evaluateGate("30.4.retentionClassified", facts).open, false); assert.match(evaluateGate("30.4.retentionClassified", facts).reason!, /d-misc/);
  assert.equal(evaluateGate("30.4.retentionClassified", { documents: facts.documents.filter((d) => d.document_id !== "d-misc") }).open, true);
  let all = s2;
  for (const it of all.items) if (it.status === "pending") all = satisfyItem(g.events, all, it.item_code, { at: "2027-01-21T12:00:00.000Z" });
  const refused = closeHandoff(g.events, all, { as_of: D("2027-02-20"), third_statement_sent_on: D("2027-02-20"), retention_gate_open: false });
  assert.equal(refused.closed, false); assert.equal(refused.refused, "RETENTION_GATE_CLOSED"); assert.deepEqual(refused.open_items, ["HO-020"]);
  void s;
});

test("30.4-T10: Given the seeded timers are verified, then the expected set in rule 10 exists with the fixture anchors (Dec 17, Dec 24, Nov 19/Dec 12, Nov 12, Dec 21, Jan 30 2028, May 1/Nov 1 2027, Nov 30 snapshot, Nov 12 2027 reminder, Feb 1 2027 1098, Nov 6 2029 rescission watch); given 3.3's `REGX_1024_17I_ANNUAL_STMT_30` is missing, then the agent creates it with `created_by='O11.4_repair'` and HO-021 records the repair.", () => {
  const expected = expectedSeedSet({ boarded_on: BOARDED_ON, funding_date: FUNDING, consummation_date: CONSUMMATION, first_payment_date: FPD, fnma_established_on: D("2026-11-20"), purchase_date: D("2026-11-19"), late_charge_grace_days: 15, policy_expiration: D("2027-11-06"), tax_installments: [D("2027-05-01"), D("2027-11-01")], hazard_renewal_by: D("2027-10-27") });
  const anchor = (code: string) => expected.find((e) => e.code === code)!.anchor;
  assert.equal(anchor("SM_ORIG_FIRST_STATEMENT_LEAD_15"), D("2026-12-17"));
  assert.equal(anchor("SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE"), D("2026-12-24"));   // Dec 31, 30, 29, 28, 24 — Dec 25 holiday
  assert.equal(anchor("SM_O64_FIRST_PAYMENT_LETTER_5BD"), D("2026-11-19")); assert.equal(anchor("SM_O64_FIRST_PAYMENT_LETTER_PREDUE_20"), D("2026-12-12"));
  assert.equal(anchor("SM_O64_1098_SEEDS_AT_BOARDING_GATE"), D("2026-11-12"));
  assert.equal(anchor("REGX_1024_17G_INITIAL_STMT_45"), D("2026-12-21"));
  assert.equal(anchor("REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45"), D("2027-11-16")); assert.equal(anchor("REGX_1024_17I_ANNUAL_STMT_30"), D("2028-01-30"));
  assert.equal(anchor("ESCROW_BILL_TAX_1"), D("2027-05-01")); assert.equal(anchor("ESCROW_BILL_TAX_2"), D("2027-11-01")); assert.equal(anchor("ESCROW_BILL_HAZARD_RENEWAL"), D("2027-10-27"));
  assert.equal(anchor("FNMA_C41_01_METRO2_SNAPSHOT_EOM"), D("2026-11-30"));
  assert.equal(anchor("FNMA_B201_ANNUAL_INSURANCE_REMINDER_365"), D("2027-11-12"));
  assert.equal(anchor("FORM_1098_FURNISH"), D("2027-02-01"));   // Jan 31, 2027 is a Sunday
  assert.equal(anchor("RESCISSION_EXTENDED_WATCH"), D("2029-11-06"));
  assert.equal(anchor("REGZ_1026_41B_STATEMENT_PROMPT_4"), D("2027-01-20")); assert.equal(anchor("FNMA_D2_2_03_PAYMENT_REMINDER_20"), D("2027-01-20")); assert.equal(anchor("NOTE_6A_LATE_CHARGE_GRACE_GATE"), D("2027-01-16"));
  assert.equal(anchor("FNMA_IRM_PERIOD_CLOSE_BD2_1700"), D("2026-11-20")); assert.equal(anchor("SM_ORIG_HANDOFF_CLOSE_90"), D("2027-02-10"));
  const full = verifyTimerSeeding(expected, expected.map((e) => ({ code: e.code, anchor_date: e.anchor })));
  assert.equal(full.ok, true); assert.equal(full.matched, expected.length);
  // 3.3's annual-statement instance missing → the agent creates it with created_by='O11.4_repair'; HO-021 records the repair
  const seeded = expected.filter((e) => e.code !== "REGX_1024_17I_ANNUAL_STMT_30").map((e) => ({ code: e.code, anchor_date: e.anchor }));
  const v = verifyTimerSeeding(expected, [...seeded.filter((x) => x.code !== "SM_O64_1098_SEEDS_AT_BOARDING_GATE"), { code: "SM_O64_1098_SEEDS_AT_BOARDING_GATE", anchor_date: D("2026-11-13") }]);
  assert.equal(v.ok, false); assert.deepEqual(v.missing.map((m) => [m.owner, m.code, m.anchor]), [["3.3", "REGX_1024_17I_ANNUAL_STMT_30", D("2028-01-30")]]);
  assert.deepEqual(v.misanchored.map((m) => [m.expected.code, m.actual]), [["SM_O64_1098_SEEDS_AT_BOARDING_GATE", D("2026-11-13")]]);
  const h = harness(BOARDED_AT); h.boarded(); const s = open(h);
  const rep = repairTimer(h.events, CTX, { code: "REGX_1024_17I_ANNUAL_STMT_30", anchor_date: D("2028-01-30"), owner: "3.3", reason: "missing from the seeding set at boarding (rule 10)", at: BOARDED_AT });
  assert.equal(rep.instance.created_by, REPAIR_PROVENANCE); assert.equal(rep.instance.created_by, "O11.4_repair"); assert.equal(rep.event.type, "timer.seed.repaired"); assert.equal(rep.event.payload.created_by, "O11.4_repair");
  const rep2 = repairTimer(h.events, CTX, { code: "SM_O64_1098_SEEDS_AT_BOARDING_GATE", anchor_date: D("2026-11-12"), owner: "25.4", reason: "mis-anchored on Nov 13", at: BOARDED_AT });
  assert.throws(() => recordSeedingVerified(h.events, s, v, [], BOARDED_AT), RangeError);
  const done = recordSeedingVerified(h.events, s, v, [rep.instance, rep2.instance], BOARDED_AT);
  assert.equal(handoffItem(done, "HO-021").status, "satisfied"); assert.match(handoffItem(done, "HO-021").note!, /REGX_1024_17I_ANNUAL_STMT_30@2028-01-30 \(O11\.4_repair\)/);
  assert.deepEqual(done.event.payload.missing, ["REGX_1024_17I_ANNUAL_STMT_30"]); assert.equal((done.event.payload.repaired as unknown[]).length, 2);
});

test("30.4-T11: Given the tax-service vendor rejects the contract for an APN mismatch, then the agent re-submits with the 24.4 APN within the same business day; given the second rejection, then sev-2 at Thu Nov 19, 2026 (+5 BD) and 3.7 falls back to direct authority lookup for the May 1, 2027 installment.", () => {
  const h = harness(BOARDED_AT);
  h.boarded();
  const s = open(h);
  const APN = "217-05-118";   // 24.4's canonical parcel
  const first = s.items.length ? requestVendorActivation(h.events, { ...CTX, vendor_kind: "tax_service", requested_at: BOARDED_AT, apns: [APN], escrowed: true }) : null;
  assert.equal(first!.activation.status, "requested"); assert.equal(first!.activation.attempt, 1); assert.equal(first!.event.payload.contracts, 1);
  h.at("2026-11-13T16:00:00.000Z");   // Fri Nov 13
  const r1 = rejectVendorActivation(h.events, { ...CTX, activation: first!.activation, reject_reason: "APN mismatch (vendor parcel 217-05-118A)", rejected_at: "2026-11-13T16:00:00.000Z", boarded_on: BOARDED_ON, next_installment_due: D("2027-05-01") });
  assert.equal(r1.activation.status, "rejected"); assert.equal(r1.escalation, null);
  assert.deepEqual(r1.retry, { attempt: 2, resubmit_by: D("2026-11-13"), corrected_from: "30.2 canonical data (24.4 APN)", requires_boarding_correction: false });
  const second = requestVendorActivation(h.events, { ...CTX, vendor_kind: "tax_service", requested_at: "2026-11-13T17:00:00.000Z", attempt: 2, apns: [APN], correction: { apn_source: "24.4", apn: APN } });
  assert.equal(second.activation.attempt, 2); assert.equal(second.event.occurredAt.slice(0, 10), "2026-11-13");
  h.at("2026-11-16T14:00:00.000Z");
  const r2 = rejectVendorActivation(h.events, { ...CTX, activation: second.activation, reject_reason: "APN mismatch", rejected_at: "2026-11-16T14:00:00.000Z", boarded_on: BOARDED_ON, next_installment_due: D("2027-05-01") });
  assert.equal(r2.retry, null); assert.equal(r2.event.payload.second_rejection, true);
  assert.deepEqual(r2.escalation, { severity: "sev2", at: D("2026-11-19"), informed: ["boarding", "officer"], fallback: { owner: "3.7", method: "direct_tax_authority_lookup", installment_due: D("2027-05-01") } });
  // the clock itself: unsatisfied at Nov 16 → breach sev-3 (retry), and the confirmation with the right parcel closes it
  const breaches = h.timers.evaluate("2026-11-17T05:00:00.000Z");
  assert.equal(breaches.find((b) => b.def.code === "SM_TAX_SERVICE_ACTIVATE_2BD")!.severity, 3);
  assert.throws(() => confirmVendorActivation(h.events, s, { ...CTX, activation: second.activation, contract_ref: "TS-99", confirmed_at: "2026-11-18T14:00:00.000Z", parcels_confirmed: ["217-05-118A"], expected_apns: [APN] }), RangeError);
  const ok = confirmVendorActivation(h.events, s, { ...CTX, activation: second.activation, contract_ref: "TS-LOL-4471", confirmed_at: "2026-11-18T14:00:00.000Z", parcels_confirmed: [APN], expected_apns: [APN], installments: [{ due_on: D("2027-05-01"), amount_cents: 320000n }, { due_on: D("2027-11-01"), amount_cents: 320000n }], projected_bills: [{ due_on: D("2027-05-01"), amount_cents: 320000n }, { due_on: D("2027-11-01"), amount_cents: 320000n }] });
  assert.equal(ok.activation.status, "confirmed"); assert.deepEqual(ok.variance, []); assert.equal(ok.event.payload.vendor_kind, "tax_service");
  assert.equal(handoffItem(ok.state!, "HO-015").status, "satisfied");
  assert.equal(h.timer("SM_TAX_SERVICE_ACTIVATE_2BD")!.status, "satisfied_late");
});

test("30.4-T12: Given the purchase fixture boarded Wed Nov 18, 2026 with `mi_certificates` present, when no insurer activation confirmation exists by Fri Nov 20, then `SM_MI_ACTIVATION_CONFIRM_2BD` breaches sev-1 to the `pmi` agent and partner `officer`, premium remittance is held, and HO-018 shows `breached`; given confirmation Nov 20 with certificate number and first premium due Jan 1, 2027, then `mi_schedules` are seeded and `HPA_4902B_AUTO_TERMINATE_0` = 2035-12-01, `HPA_4902C_MIDPOINT_TERMINATE_0` = 2042-01-01.", () => {
  const P_LOAN = "L-PURCH-1", P_APP = "APP-PURCH-1", P_CTX = { loan_id: P_LOAN, application_id: P_APP };
  const P_BOARDED = "2026-11-18T20:00:00.000Z";
  const h = harness(P_BOARDED, ["30.4", "10.2", "10.3"]);
  h.events.append({ type: "loan.boarded", loanId: P_LOAN, applicationId: P_APP, actor: AGENT, payload: { boarded_at: P_BOARDED, first_payment_date: FPD, mi_certificates: ["MI-CERT-0451"], source: "origination" } });
  const o = openHandoff(h.events, { ...P_CTX, boarded_at: P_BOARDED, first_payment_date: FPD, mi_certificates_present: true }, h.timers);
  let s: HandoffState = { handoff: o.handoff, items: o.items };
  assert.equal(handoffItem(s, "HO-018").status, "pending"); assert.equal(handoffItem(s, "HO-018").due_at, D("2026-11-20")); assert.equal(o.retired_mi_timer_id, null);
  assert.deepEqual(o.vendor_requests.map((v) => v.vendor_kind), ["tax_service", "flood_lol", "insurance_tracking", "mi_activation"]);
  const t = h.timer("SM_MI_ACTIVATION_CONFIRM_2BD")!;
  assert.equal(t.dueDate, D("2026-11-20"));
  const breaches = h.timers.evaluate("2026-11-21T05:00:00.000Z");
  const b = breaches.find((x) => x.def.code === "SM_MI_ACTIVATION_CONFIRM_2BD")!;
  assert.equal(b.severity, 1); assert.ok(b.escalateTo.includes("pmi") && b.escalateTo.includes("officer"), `escalates to ${b.escalateTo.join(",")}`);
  const chk = miActivationCheck({ boarded_on: D("2026-11-18"), confirmed_on: null, as_of: D("2026-11-21") });
  assert.deepEqual(chk, { due: D("2026-11-20"), breached: true, severity: "sev1", escalate_to: ["pmi", "officer"], premium_remittance_held: true, item_status: "breached" });
  s = breachItem(h.events, s, "HO-018", { timer_id: t.id, at: "2026-11-21T05:00:00.000Z" });
  assert.equal(handoffItem(s, "HO-018").status, "breached"); assert.equal(handoffItem(s, "HO-018").timer_instance_id, t.id);
  // confirmation Nov 20 (fresh clock): 10.x's `mi_policy.activated` satisfies the clock; the schedule is seeded with the HPA dates
  const c = harness(P_BOARDED, ["30.4", "10.2", "10.3"]);
  c.events.append({ type: "loan.boarded", loanId: P_LOAN, applicationId: P_APP, actor: AGENT, payload: { boarded_at: P_BOARDED, first_payment_date: FPD, mi_certificates: ["MI-CERT-0451"], source: "origination" } });
  c.at("2026-11-20T18:00:00.000Z");
  const store = new EntityStore();
  const activated = activateMiPolicy({ events: c.events, timers: c.timers, store, clock: c.clock, actor: { kind: "agent", id: "pmi" } }, { loan_id: P_LOAN, policy_id: "MI-CERT-0451", premium_plan: "bpmi_monthly", status: "active", state: "OH", consummation: D("2026-11-18"), hpa_covered: true, boarded_at: D("2026-11-18"), last_annual_disclosure_on: D("2026-11-18"), lpmi_equivalent_termination_date: null })!;
  assert.equal(activated.type, "mi_policy.activated"); assert.equal(activated.payload.status, "active");
  assert.equal(c.timer("SM_MI_ACTIVATION_CONFIRM_2BD")!.status, "satisfied");
  assert.equal(miActivationCheck({ boarded_on: D("2026-11-18"), confirmed_on: D("2026-11-20"), as_of: D("2026-11-21") }).premium_remittance_held, false);
  const mi = seedMiSchedule(c.events, P_CTX, { certificate_number: "MI-CERT-0451", first_premium_due: FPD, premium_plan: "bpmi_monthly", upb_cents: 41_200_000n, note_rate_pct: "6.375", term_months: 360, first_payment_date: FPD, original_value_cents: 45_780_000n });
  assert.equal(mi.scheduled_78_date, D("2035-12-01")); assert.equal(mi.midpoint_termination_date, D("2042-01-01")); assert.equal(mi.cancellation_eligibility_date, D("2034-10-01")); assert.equal(mi.first_premium_due, FPD);
  assert.equal(mi.event.type, "mi.schedule.updated"); assert.equal(mi.event.payload.bpmi, true);
  assert.equal(c.timer("HPA_4902B_AUTO_TERMINATE_0")!.dueDate, D("2035-12-01")); assert.equal(c.timer("HPA_4902C_MIDPOINT_TERMINATE_0")!.dueDate, D("2042-01-01"));
  assert.equal(levelPayment(41_200_000n, ratePercent("6.375"), 360), 257034n);
  assert.equal(guardOf("openHandoff", "HO018_NA_WITH_MI_CERTIFICATE").refuse({ ho018_not_applicable: true, mi_certificates_present: true }, { actor: AGENT } as unknown as CommandContext)?.includes("HO-018"), true);
});

test("30.4-T13: Given all items satisfied by Jan 21, 2027 and the third statement cycle (Feb 20, 2027) sent, when closure runs, then `servicing_handoff.closed{close_basis='all_items_satisfied'}` on Feb 20; given HO-009 still `expected` on Feb 10, then closure requires an `officer` override listing HO-009 and 25.4's timer keeps running.", () => {
  const h = harness(BOARDED_AT, ["30.4", "25.4"]);
  h.boarded();
  let s = open(h);
  h.at("2026-11-19T20:00:00.000Z");
  h.events.append({ type: "loan.purchased", loanId: LOAN, applicationId: APP, actor: { kind: "system", id: "investor-reporting" }, payload: { purchase_date: "2026-11-19", source: "origination" } });
  s = recordPurchase(s, D("2026-11-19"));
  for (const it of s.items) if (it.status === "pending") s = satisfyItem(h.events, s, it.item_code, { at: "2027-01-21T12:00:00.000Z" });
  h.at("2027-02-10T12:00:00.000Z");
  assert.equal(closeHandoff(h.events, s, { as_of: D("2027-02-09"), third_statement_sent_on: null, retention_gate_open: true }).refused, "NOT_YET_CLOSABLE");
  h.at("2027-02-20T16:00:00.000Z");
  const r = closeHandoff(h.events, s, { as_of: D("2027-02-20"), third_statement_sent_on: D("2027-02-20"), retention_gate_open: true });
  assert.equal(r.closed, true); assert.equal(r.close_basis, "all_items_satisfied"); assert.equal(r.closed_at, D("2027-02-20")); assert.equal(r.exception_count, 0);
  assert.deepEqual(r.events.map((e) => e.type), ["servicing_handoff.completed", "servicing_handoff.closed"]); assert.equal(r.events[1]!.payload.close_basis, "all_items_satisfied");
  assert.equal(r.state.handoff.status, "closed");
  assert.equal(h.timer("SM_ORIG_HANDOFF_CLOSE_90")!.status, "satisfied"); assert.equal(h.timer("SM_ORIG_HANDOFF_CLOSE_90")!.satisfiedByEventId, r.events[1]!.id);
  // HO-009 still `expected` on Feb 10 → closure needs the officer's override listing HO-009; 25.4's evidence timer keeps running
  const g = harness(BOARDED_AT, ["30.4", "25.4"]); g.boarded(); let s2 = open(g);
  g.at("2026-11-19T20:00:00.000Z");
  g.events.append({ type: "loan.purchased", loanId: LOAN, applicationId: APP, actor: { kind: "system", id: "investor-reporting" }, payload: { purchase_date: "2026-11-19", source: "origination" } });
  s2 = recordPurchase(s2, D("2026-11-19"));
  for (const it of s2.items) if (it.status === "pending" && it.item_code !== "HO-009") s2 = satisfyItem(g.events, s2, it.item_code, { at: "2027-01-21T12:00:00.000Z" });
  g.at("2027-02-10T12:00:00.000Z");
  const refused = closeHandoff(g.events, s2, { as_of: D("2027-02-10"), third_statement_sent_on: null, retention_gate_open: true });
  assert.equal(refused.closed, false); assert.equal(refused.refused, "OFFICER_OVERRIDE_REQUIRED"); assert.deepEqual(refused.open_items, ["HO-009"]);
  assert.equal(closeHandoff(g.events, s2, { as_of: D("2027-02-10"), third_statement_sent_on: null, retention_gate_open: true, override: { officer_decision_id: "dec-1", officer_actor: AGENT, exceptions: [{ item_code: "HO-009", follow_on_owner: "25.4" }] } }).refused, "OVERRIDE_REQUIRES_OFFICER");
  assert.equal(closeHandoff(g.events, s2, { as_of: D("2027-02-10"), third_statement_sent_on: null, retention_gate_open: true, override: { officer_decision_id: "dec-1", officer_actor: OFFICER, exceptions: [{ item_code: "HO-001", follow_on_owner: "30.2" }] } }).refused, "OVERRIDE_MUST_LIST_OPEN_ITEMS");
  const ov = closeHandoff(g.events, s2, { as_of: D("2027-02-10"), third_statement_sent_on: null, retention_gate_open: true, override: { officer_decision_id: "dec-officer-77", officer_actor: OFFICER, exceptions: [{ item_code: "HO-009", follow_on_owner: "25.4", note: "Fannie Mae letter evidence outstanding — SM_O64_FNMA_1026_39_EVIDENCE_45 keeps running" }] } });
  assert.equal(ov.closed, true); assert.equal(ov.close_basis, "officer_override"); assert.equal(ov.exception_count, 1); assert.deepEqual(ov.timers_kept_running, ["SM_O64_FNMA_1026_39_EVIDENCE_45"]);
  assert.deepEqual((ov.events[1]!.payload.exceptions as { item_code: string }[]).map((e) => e.item_code), ["HO-009"]); assert.equal(ov.events[1]!.actor.role, "officer"); assert.equal(ov.state.handoff.agent_decision_id, "dec-officer-77");
  const evidence = g.timer("SM_O64_FNMA_1026_39_EVIDENCE_45")!;
  assert.ok(evidence.status === "armed" || evidence.status === "breached", "25.4's evidence timer is untouched by the override"); assert.equal(evidence.cancelledReason, undefined);
  // the bus guardrail: an agent may prepare the override but only an officer executes it
  const guard = guardOf("closeHandoff", "STATUTORY_BREACH_CLOSE_NEEDS_OFFICER");
  assert.match(guard.refuse({ override: { exceptions: [{ item_code: "HO-009", follow_on_owner: "25.4" }] } }, { actor: AGENT } as unknown as CommandContext)!, /officer/);
  assert.equal(guard.refuse({ override: { exceptions: [{ item_code: "HO-009", follow_on_owner: "25.4" }] } }, { actor: OFFICER } as unknown as CommandContext), undefined);
  assert.match(guardOf("closeHandoff", "OVERRIDE_LISTS_EXCEPTIONS").refuse({ override: { exceptions: [] } }, { actor: OFFICER } as unknown as CommandContext)!, /follow-on owner/);
});

test("30.4-T14: Given 118 loans boarded in November 2026, when `CS_BOARDED_ORIGINATIONS_DAILY` runs Thu Dec 3, 2026 06:00 ET, then the report lists the Metro 2 transmission due that day, any vendor rejects, overdue compile tests, and the §1026.39 status distribution; the partner copy contains loan numbers only.", () => {
  const AS_OF = D("2026-12-03");
  const statuses: OwnershipNoticeStatus[] = ["expected", "evidenced", "not_applicable", "overdue_unconfirmed"];
  const names: string[] = [];
  const loans: ReportLoan[] = Array.from({ length: 118 }, (_, k) => {
    const name = `Borrower Surname-${k + 1}`; names.push(name);
    const boardedOn = D(`2026-11-${String(2 + (k % 26)).padStart(2, "0")}`);
    return { loan_id: `L-${k + 1}`, servicer_loan_number: `SM-${String(100000 + k)}`, borrower_name: name, boarded_on: boardedOn, handoff_status: "open" as const, ownership_status: statuses[k % 4]!,
      timers: [{ code: "SM_METRO2_TRANSMIT_ALL4_BD3", due_date: AS_OF, status: "armed" }, { code: "SM_ORIG_HANDOFF_CLOSE_90", due_date: addDays(boardedOn, 90), status: "armed" }],
      ...(k % 20 === 0 ? { vendor_rejects: [{ vendor_kind: "tax_service" as const, reason: "APN mismatch" }] } : {}),
      compile_test: { due: addDays(boardedOn, 1), status: k % 30 === 0 ? "armed" as const : "satisfied" as const },
      ...(k === 5 ? { epd_flags: [{ definition: "sm_watch_p1_6_30" as const, raised_on: AS_OF, cleared_on: null }] } : {}) };
  });
  const report = buildBoardedOriginationsReport(AS_OF, [...loans, { ...loans[0]!, loan_id: "L-closed", servicer_loan_number: "SM-CLOSED", handoff_status: "closed" }]);
  assert.equal(report.population, 118); assert.equal(report.kind, "boarded_originations_daily"); assert.equal(report.as_of, AS_OF);
  assert.equal(report.sections.timer_health.due_today.SM_METRO2_TRANSMIT_ALL4_BD3!.length, 118);
  assert.equal(report.sections.vendor_rejects.tax_service!.length, 6); assert.equal(report.sections.vendor_rejects.tax_service![0]!.reason, "APN mismatch");
  assert.equal(report.sections.timer_health.overdue.SM_SERVICING_FILE_COMPILE_TEST_1BD!.length, 4);
  assert.deepEqual(report.sections.ownership_1026_39, { expected: 30, evidenced: 30, not_applicable: 29, overdue_unconfirmed: 29, sent: 0, sent_by_sm: 0 });
  assert.deepEqual(report.sections.epd.raised.map((x) => x.loan), ["SM-100005"]); assert.deepEqual(report.sections.epd.early_warnings, ["SM-100005"]);
  assert.equal(report.hash.length, 64);
  const partner = partnerCopy(report);
  const text = JSON.stringify(partner);
  assert.equal(partner.loan_numbers_only, true); assert.equal(containsNpi(text, names), false); assert.ok(text.includes("SM-100005") && text.includes("SM-100000"));
  assert.equal(containsNpi(JSON.stringify(loans), names), true);
  // the clock: the 06:00 ET tick arms the recurring row on the report date; publishing closes it and the engine re-arms the next day
  const h = harness("2026-12-03T11:00:00.000Z");
  const tick = dailyReportTick(h.events, AS_OF);
  assert.equal(tick.occurredAt, "2026-12-03T11:00:00.000Z"); assert.equal(tick.payload.job, "cs_boarded_originations_daily");
  const t = h.timer("SM_CS_BOARDED_ORIG_REPORT_DAILY")!;
  assert.equal(t.status, "armed"); assert.equal(t.subject.kind, "global"); assert.equal(t.anchorDate, AS_OF); assert.equal(t.dueDate, D("2026-12-04"));
  const pub = publishDailyReport(h.events, report);
  assert.equal(pub.event.payload.kind, "boarded_originations_daily"); assert.deepEqual(pub.distribution, [{ to: "sm_servicing_lead", copy: "full" }, { to: "partner_officer", copy: "partner" }]);
  assert.equal(t.status, "satisfied"); assert.equal(h.timers.byCode("SM_CS_BOARDED_ORIG_REPORT_DAILY").length, 2);
});

test("30.4 worked figures: P&I $3,402.62 on $560,000 at 6.125%; escrow $687.50 = ($6,400 taxes as 2 × $3,200.00 + $1,850.00 hazard) / 12; deposit $2,062.50; amount due $4,090.12; late fee $170.13 (5% of P&I); per diem $93.97 × 19 = $1,785.43 prepaid interest (365_rounded_per_diem — an origination charge, not a loan-account transaction); $0.01 amount-due discrepancy is sev-2", () => {
  const pi = levelPayment(cents("560000"), ratePercent("6.125"), 360);
  assert.equal(pi, 340262n);                                                    // $3,402.62
  const taxes = 640000n, hazard = 185000n;                                      // $6,400.00 / $1,850.00
  assert.equal(taxes / 2n, 320000n);                                            // $3,200.00 per installment (May 1 / Nov 1, 2027)
  const monthlyEscrow = (taxes + hazard) / 12n;
  assert.equal(monthlyEscrow, 68750n);                                          // $687.50
  const deposit = monthlyEscrow + 2n * monthlyEscrow;                           // base month + two-month cushion (30.3)
  assert.equal(deposit, 206250n);                                               // $2,062.50
  const expected = expectedFirstStatement({ pi_cents: pi, escrow_payment_cents: monthlyEscrow, first_payment_date: FPD, original_amount_cents: cents("560000"), escrow_deposit_cents: deposit, late_charge_pct: "5.00", late_charge_grace_days: 15 });
  assert.equal(expected.amount_due_cents, 409012n);                             // $4,090.12
  assert.equal(expected.late_fee_cents, 17013n);                                // $170.13
  const perDiem = Decimal.fromBigInt(cents("560000")).mul(ratePercent("6.125")).div(Decimal.fromInt(365)).toScaledInt(0, "HALF_UP");
  assert.equal(perDiem, 9397n);                                                 // $93.97
  assert.equal(perDiem * 19n, 178543n);                                         // $1,785.43 (26.3's 365_rounded_per_diem; the README's $1,785.48 is the unrounded product — verification report H7(a))
  assert.equal(AMOUNT_DUE_SEV2_THRESHOLD_CENTS, 1n);                            // $0.01
  const h = harness(BOARDED_AT); h.boarded(); const s = open(h);
  const bad = reconcileFirstStatement(h.events, s, { statement: { ...STATEMENT, amount_due_cents: expected.amount_due_cents + 1n }, boarded: BOARDED, statement_event_id: "e-stmt", at: BOARDED_AT });
  assert.equal(bad.amount_due_discrepancy_cents, 1n); assert.equal(bad.mismatches[0]!.severity, "sev2");
  assert.equal(h.ofType("servicing_handoff.opened").length, 1);
});
