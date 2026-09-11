// 26.3 Funding authorization and disbursement (funding conditions, wet vs dry states, rescission expiry, wire controls, per-diem interest and interest credits, table-funding analysis, unwind)
// spec/sections/26-closing-execution-documents-eclosing-ron-funding-and-post-cl/26-3-funding-authorization-and-disbursement-funding-conditions-we.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { TOOLS_26_3 } from "../../app/tools/section26-3.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { RescissionRefused, type DisburseFacts } from "../compliance-disclosures/ops-25-3.ts";
import { EVALUATORS_26_3 } from "./evaluators-26-3.ts";
import { computeDates, fedwireDayCheck, assertDisburseDate, vaDisburseDeadline, vaDisbursementCompliance, computePerDiem, prepaidInterestArtifact, decideInterestMode, buildFundingWorksheet, reconcileToSettlementStatement, recordReconciliation, fundingLedgerLines, postFundingLedger, partnerMirrorLines, evaluateFundingConditions, recordConditionsEvaluated, fcStatus, documentsNotReturned, openFunding, requestFunding, authorizeFunding, recordAdvanceApproved, scoreBecIndicators, recordBecHold, prepareWire, recordWirePrepared, releaseWire, acceptWire, wireAcceptOverdue, confirmAgentReceipt, issueDisbursementAuthorization, confirmDisbursement, resyncDates, openUnwind, executeUnwindStep, wetFundsAtTableGate, FundingRefused,
  type Funding, type ConditionFacts, type VerifiedWireRecord, type FundingCalendar } from "./ops-26-3.ts";

const FUNDER: Actor = { kind: "agent", id: "funder" };
const APPROVER: Actor = { kind: "human", id: "u-approver", role: "funding_approver" };
const ANALYST_APPROVER: Actor = { kind: "human", id: "u-analyst", role: "funding_approver" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const APP = "APP-REFI-1", PARTNER = "P-PARTNER", PARTNER_LOAN = "PL-1001", TZ = "America/Phoenix";
/** Refinance fixture: $560,000.00 LCOR at 6.125 %, Phoenix AZ (dry; RON eNote), consummation Fri Nov 6, 2026 14:26 MST. */
const GROSS = 56_000_000n, RATE = "6.125";
const CONSUMMATION = "2026-11-06T21:26:00.000Z";
const refiCalendar = (over: Partial<Parameters<typeof computeDates>[0]> = {}): FundingCalendar =>
  computeDates({ application_id: APP, state: "AZ", transaction_type: "limited_cash_out", time_zone: TZ, consummation_at: CONSUMMATION, rescindable: true, review_completed_on: D("2026-11-09"), ...over });
/** 25.3's rescission_periods facts: expired midnight ending Tue Nov 10 (2026-11-11T07:00:00Z); the sweep confirms Wed Nov 11 08:00 MST. */
const rescissionRunning = (now: string): DisburseFacts => ({ status: "running", expires_at: "2026-11-11T07:00:00.000Z", reasonably_satisfied_at: null, waiver_id: null, now });
const rescissionConfirmed = (now: string): DisburseFacts => ({ status: "expired_not_rescinded", expires_at: "2026-11-11T07:00:00.000Z", reasonably_satisfied_at: "2026-11-11T15:00:00.000Z", waiver_id: null, now });
const VERIFIED: VerifiedWireRecord = { verification_id: "WV-1", beneficiary_party_id: "SA-1", beneficiary_name: "Escrow Co Trust Account", instructions_hash: "h-verified", verified_at: "2026-11-03T15:00:00.000Z", expires_at: "2026-12-03T15:00:00.000Z", blocks_disbursement: false, change_detected_at: null, callback_number_source: "alta_registry", cpl_agent_party_id: "SA-1", ofac_screen_ref: "OFAC-1", ofac_clear: true };
/** Worked example 1's checklist run (Wed Nov 11 09:00 MST, refreshed Nov 12): every item passes or is n/a. */
const passingFacts = (as_of: string, over: Partial<ConditionFacts> = {}): ConditionFacts => ({
  as_of, funding: { funding_type: "dry", transaction_type: "limited_cash_out", disbursement_date: D("2026-11-12"), release_date: D("2026-11-12"), note_date: D("2026-11-06"), authorized: false },
  loan: { ltv_pct: 70, sfha: false, project: false, enote: true, tx_50a6: false, record_before_fund: false },
  execution: { review_passed: true, all_docs_signed: true, blocking_defects: 0, package_returned: true }, cd: { consummated_version: 1, delivered_with_receipt: true, signed_copy_in_documents: true }, identity: { all_signers_proofed: true },
  rescission: rescissionConfirmed(as_of), hazard: { hazard_status: "verified", effective_date: D("2026-11-12"), transaction_type: "refinance", policy_in_force: true },
  title: { cpl_open: true, commitment_open: true }, vvoe: { verified_on: D("2026-11-04"), self_employed: false }, credit_refresh_open: true, compliance_disburse_open: true, ptf: { ptf_cleared: true },
  cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [], wire: { verified_at: VERIFIED.verified_at, blocks_disbursement: false, callback_number_source: "alta_registry", as_of },
  payoffs: [{ liability_id: "L-PRIOR", status: "received", good_through_date: D("2026-11-13") }], first_payment: { first_payment_date: D("2027-01-01") }, audit_trail_open: true, enote: { registered: true, secured_party_set: true },
  qc_hold: false, commitment: { active: true, expires_on: D("2026-12-07") }, worksheet: { reconciled: true }, fraud: { fraud_hold: false, ofac_clear: true }, ...over });
const RUN = { at: "2026-11-12T13:05:00.000Z", run_id: "run-funder-1" };
/** The fixture fundings row with the reconciled worksheet (rule 4): $560,000.00 − $1,785.43 − $1,665.00 + $700.00 = $557,249.57. */
function fixtureFunding(over: Partial<Funding> = {}): Funding {
  const f = openFunding({ funding_id: "F-1", application_id: APP, partner_id: PARTNER, partner_loan_number: PARTNER_LOAN, calendar: refiCalendar(), gross_loan_cents: GROSS, note_rate_pct: RATE, interest: { note_first_payment_date: D("2027-01-01") } });
  const ws = reconcileToSettlementStatement(buildFundingWorksheet({ funding_id: "F-1", version: 1, cd_version: 1, gross_loan_cents: GROSS, prepaid_interest_cents: 178_543n, escrow_deposit_cents: 166_500n, lender_credits_cents: 70_000n }), 55_724_957n, RUN).worksheet;
  return { ...f, worksheet: ws, net_wire_cents: ws.net_wire_cents, ...over };
}
const AUTH_AT = "2026-11-12T13:12:00.000Z";   // 08:12 ET Thu Nov 12
const authorizeInput = (at = AUTH_AT) => ({ at, conditions: evaluateFundingConditions("F-1", passingFacts(at)), rescission: rescissionConfirmed(at), fraud_hold: { fraud_hold: false }, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [] });

/** The 26.3 clocks over the overridden registry, in-memory events, a fixed clock, the escalation service. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["26.3"] });
  const escalations = new EscalationService(events, clock);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (t: string) => events.all().filter((e) => e.type === t);
  return { clock, events, timers, escalations, timer, ofType };
}
/** Worked example 1 up to `warehouse.advance.approved` 08:14 ET: request → authorize → advance approved. */
function advanceApproved(h: ReturnType<typeof harness>, over: Partial<Funding> = {}): Funding {
  let f = fixtureFunding(over);
  f = requestFunding(h.events, f, "2026-11-11T16:00:00.000Z").funding;
  f = authorizeFunding(h.events, f, authorizeInput()).funding;
  return recordAdvanceApproved(f, "ADV-1");
}
const toolKey = (process: string, name: string): string => `${process} ${name}`;
/** The 26.3 bus alone (the 12-8 pattern): TOOLS_26_3 bound to the `funder` agent. */
function busFor(h: ReturnType<typeof harness>) {
  const ctx: UowContext = { loanId: "", applicationId: APP, events: h.events, ledger: new MemoryLedger(), timers: h.timers, clock: h.clock, decide: () => {} };
  const agents = new AgentRegistry(); const rt: ToolRuntime = { store: new EntityStore(), ports: {}, escalations: h.escalations, services: {} };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_26_3) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(toolKey(d.process, d.name), cmd); }
  const bus = new CommandBus(agents);
  const run = (name: string, input: ToolInput, actor: Actor = FUNDER) => bus.execute(cmds.get(toolKey("26.3", name))!, actor, input, ctx);
  return { ctx, cmds, bus, rt, run };
}

test("26.3-T1: Given consummation Fri Nov 6, 2026 (refinance, AZ), when the rescission period is computed and the Fedwire calendar applied, then `rescission_expires_at` = midnight ending Tue Nov 10, `earliest_funding_date` = Thu Nov 12 (Wed Nov 11 Veterans Day excluded), and `disburse` on Nov 11 is refused with `FC_FEDWIRE_DAY = fail` and `REGZ_1026_23_RESCISSION_3SBD_GATE` closed until the 25.3 sweep.", () => {
  const cal = refiCalendar();
  assert.equal(cal.funding_type, "dry"); assert.equal(cal.disbursement_authorization_mode, "review_then_fund"); assert.equal(cal.note_date, "2026-11-06");
  assert.equal(cal.rescission_expires_on, "2026-11-10");                              // Sat Nov 7 (1), Sun excluded, Mon Nov 9 (2), Tue Nov 10 (3)
  assert.equal(cal.rescission_expires_at, "2026-11-11T07:00:00.000Z");                 // midnight ending Tue Nov 10 MST
  assert.equal(cal.rescission_expires_display, "2026-11-10T24:00 MST");
  assert.equal(cal.earliest_funding_date, "2026-11-12");                               // Wed Nov 11 Veterans Day — Fedwire closed
  assert.equal(cal.scheduled_funding_date, "2026-11-12");
  assert.equal(fedwireDayCheck(D("2026-11-11")).status, "fail"); assert.equal(fedwireDayCheck(D("2026-11-12")).status, "pass");
  // `disburse` on Nov 11: FC_FEDWIRE_DAY fails first; on Nov 12 before the 25.3 sweep the rescission gate is still closed
  assert.throws(() => assertDisburseDate(D("2026-11-11"), rescissionRunning("2026-11-11T14:00:00.000Z")), (e: unknown) => e instanceof FundingRefused && e.code === "FC_FEDWIRE_DAY");
  assert.throws(() => assertDisburseDate(D("2026-11-12"), rescissionRunning("2026-11-11T14:00:00.000Z")), (e: unknown) => e instanceof RescissionRefused && e.code === "REGZ_1026_23_RESCISSION_3SBD_GATE");
  assert.equal(assertDisburseDate(D("2026-11-12"), rescissionConfirmed("2026-11-12T13:00:00.000Z")).rescission_gate.open, true);
  const c = evaluateFundingConditions("F-1", passingFacts("2026-11-11T14:00:00.000Z", { funding: { ...passingFacts("x").funding, release_date: D("2026-11-11") }, rescission: rescissionRunning("2026-11-11T14:00:00.000Z") }));
  assert.equal(fcStatus(c, "FC_FEDWIRE_DAY"), "fail"); assert.equal(fcStatus(c, "FC_RESCISSION_EXPIRED"), "fail"); assert.equal(c.passed, false);
  assert.deepEqual([...c.blocking_codes].sort(), ["FC_FEDWIRE_DAY", "FC_RESCISSION_EXPIRED"]);
  // the same closed gate through the 25.3 evaluator the funder asserts at authorization; the refusal reason names §1026.23(c)
  assert.equal(evaluateGate("25.3.rescissionGateOpen", { ...rescissionRunning("2026-11-11T14:00:00.000Z") }).open, false);
  assert.throws(() => authorizeFunding(new MemoryEventStore(new FixedClock(AUTH_AT)), fixtureFunding(), { ...authorizeInput(), rescission: rescissionRunning(AUTH_AT) }), (e: unknown) => e instanceof RescissionRefused);
});

test("26.3-T2: Given $560,000.00 at 6.125% disbursed Nov 12, 2026, when per-diem is computed under `365_rounded_per_diem`, then `per_diem_cents` = 9,397, `prepaid_days` = 19, `per_diem_interest_cents` = 178,543 ($1,785.43), first payment Jan 1, 2027, `first_payment_latest_allowed_date` = Jan 12, 2027, `lpi_date` = Dec 1, 2026, `maturity_date_expected` = Dec 1, 2056, and the gate passes; the unrounded product $1,785.48 never appears on any artifact.", async () => {
  const p = computePerDiem(GROSS, RATE, D("2026-11-12"));
  assert.equal(p.convention, "365_rounded_per_diem"); assert.equal(p.per_diem_basis, 365);
  assert.equal(p.annual_interest_cents, 3_430_000n);                                    // $34,300.00
  assert.equal(p.per_diem_cents, 9_397n);                                               // 3,430,000 / 365 = 9,397.26… → $93.97
  assert.equal(p.prepaid_days, 19); assert.equal(p.per_diem_interest_cents, 178_543n); assert.equal(p.prepaid_interest_cents, 178_543n);   // $1,785.43
  assert.equal(p.unrounded_product_cents, 178_548n);                                    // $1,785.48 — computed for the reconciliation note only
  const d = decideInterestMode({ disbursement_date: D("2026-11-12"), gross_loan_cents: GROSS, note_rate_pct: RATE, note_first_payment_date: D("2027-01-01") });
  assert.equal(d.mode, "prepaid"); assert.equal(d.first_payment_date, "2027-01-01"); assert.equal(d.first_payment_latest_allowed_date, "2027-01-12");
  assert.equal(d.lpi_date, "2026-12-01"); assert.equal(d.maturity_date_expected, "2056-12-01"); assert.equal(d.first_payment_gate.status, "pass"); assert.equal(d.redraw_required, false);
  assert.equal(evaluateGate("26.3.firstPaymentTwoMonthsGate", { disbursement_date: "2026-11-12", first_payment_date: "2027-01-01" }).open, true);
  assert.equal(EVALUATORS_26_3["26.3.firstPaymentTwoMonthsGate"]!({ disbursement_date: "2026-11-12", first_payment_date: "2027-01-13" }).open, false);
  // artifacts: the CD prepaid line and the tool output carry per day × days = total; the unrounded product is absent everywhere
  const art = prepaidInterestArtifact(p, D("2026-11-12"), D("2026-11-30"), RATE);
  assert.equal(art.total_cents, art.per_day_cents * BigInt(art.days)); assert.equal(art.total_cents, 178_543n);
  assert.equal(art.label, "Prepaid Interest ($93.97 per day for 19 days @ 6.125%)");
  const h = harness("2026-11-12T13:00:00.000Z"); const b = busFor(h);
  const r = await b.run("computePerDiem", { gross_loan_cents: GROSS, note_rate_pct: RATE, disbursement_date: "2026-11-12" });
  const json = JSON.stringify(r.output, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.ok(!("unrounded_product_cents" in (r.output as object))); assert.ok(!json.includes("1,785.48") && !json.includes("\"178548\""));
  assert.ok(!JSON.stringify(art, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes("178548"));   // never "$1,785.48"
});

test("26.3-T3: Given disbursement Thu Dec 3, 2026 on a note printed with first payment Jan 1, 2027, when `decideInterestMode` runs with a 7-day window, then interest-credit mode is offered with `interest_credit_cents` = 18,794 ($187.94), accrual start Dec 1, first payment Jan 1, 2027 (gate: ≤ Feb 3 ✓) and no re-draw; given disbursement Dec 15, then interest credit is refused, prepaid = 17 × $93.97 = $1,597.49, first payment Feb 1, 2027 and an 26.1 re-draw (`date_change`) is opened before funding.", async () => {
  const a = decideInterestMode({ disbursement_date: D("2026-12-03"), gross_loan_cents: GROSS, note_rate_pct: RATE, window_days: 7, note_first_payment_date: D("2027-01-01") });
  assert.equal(a.interest_credit_available, true); assert.equal(a.interest_credit_offered, true); assert.equal(a.mode, "interest_credit");
  assert.equal(a.interest_credit_days, 2); assert.equal(a.interest_credit_cents, 18_794n);   // 2 × $93.97 = $187.94
  assert.equal(a.interest_accrual_start_date, "2026-12-01"); assert.equal(a.prepaid_interest_cents, 0n);
  assert.equal(a.first_payment_date, "2027-01-01"); assert.equal(a.first_payment_latest_allowed_date, "2027-02-03"); assert.equal(a.first_payment_gate.status, "pass");
  assert.equal(a.redraw_required, false); assert.equal(a.redraw_reason, null);
  const b = decideInterestMode({ disbursement_date: D("2026-12-15"), gross_loan_cents: GROSS, note_rate_pct: RATE, window_days: 7, borrower_elected_credit: true, note_first_payment_date: D("2027-01-01") });
  assert.equal(b.interest_credit_available, false); assert.equal(b.mode, "prepaid"); assert.match(b.refusal ?? "", /interest credit refused: day\(2026-12-15\) = 15 > interest_credit_window_days 7/);
  assert.equal(b.prepaid_days, 17); assert.equal(b.prepaid_interest_cents, 159_749n);        // 17 × $93.97 = $1,597.49
  assert.equal(b.first_payment_date, "2027-02-01"); assert.equal(b.maturity_date_expected, "2057-01-01"); assert.equal(b.first_payment_latest_allowed_date, "2027-02-15");
  assert.equal(b.redraw_required, true); assert.equal(b.redraw_reason, "date_change");
  // through the bus: the re-draw request to 26.1 is on the log before any funding event; the agent never overrides the first payment date
  const h = harness("2026-12-15T15:00:00.000Z"); const bus = busFor(h);
  const r = await bus.run("decideInterestMode", { disbursement_date: "2026-12-15", gross_loan_cents: GROSS, note_rate_pct: RATE, window_days: 7, borrower_elected_credit: true, note_first_payment_date: "2027-01-01" });
  assert.equal((r.output as { redraw_required: boolean }).redraw_required, true);
  const redraw = h.ofType("funding.redraw.requested"); assert.equal(redraw.length, 1); assert.equal(redraw[0]!.payload.redraw_reason, "date_change"); assert.equal(redraw[0]!.payload.to_process, "26.1");
  assert.equal(h.ofType("funding.authorized").length, 0);
  await assert.rejects(bus.run("decideInterestMode", { disbursement_date: "2026-12-15", gross_loan_cents: GROSS, note_rate_pct: RATE, override_first_payment_date: "2027-01-01" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_FIRST_PAYMENT_OVERRIDE");
});

test("26.3-T4: Given disbursement Tue Nov 3, 2026 with interest credit, then `interest_credit_days` = 2, `first_payment_date` = Dec 1, 2026, `lpi_date` = Nov 1, 2026, and the authorization record carries `delivery_window_compressed = true` with the Dec 16, 2026 LPI-45 date handed to 29.4.", () => {
  const d = decideInterestMode({ disbursement_date: D("2026-11-03"), gross_loan_cents: GROSS, note_rate_pct: RATE, borrower_elected_credit: true });
  assert.equal(d.mode, "interest_credit"); assert.equal(d.interest_credit_days, 2); assert.equal(d.interest_credit_cents, 18_794n);
  assert.equal(d.interest_accrual_start_date, "2026-11-01"); assert.equal(d.first_payment_date, "2026-12-01"); assert.equal(d.first_payment_latest_allowed_date, "2027-01-03");
  assert.equal(d.lpi_date, "2026-11-01"); assert.equal(d.lpi_45_date, "2026-12-16"); assert.equal(d.delivery_window_compressed, true);
  // example 3's net wire: gross − escrow + lender credit + interest credit = $559,222.94
  const ws = buildFundingWorksheet({ funding_id: "F-3", version: 1, cd_version: 2, gross_loan_cents: GROSS, prepaid_interest_cents: 0n, interest_credit_cents: d.interest_credit_cents, escrow_deposit_cents: 166_500n, lender_credits_cents: 70_000n });
  assert.equal(ws.net_wire_cents, 55_922_294n);
  // the authorization record (funding.authorized) carries the compressed-window flag and the LPI-45 date for 29.1/29.4
  const h = harness("2026-11-03T13:12:00.000Z");
  const cal = computeDates({ application_id: APP, state: "AZ", transaction_type: "limited_cash_out", time_zone: TZ, consummation_at: "2026-10-28T21:00:00.000Z", rescindable: true, review_completed_on: D("2026-11-02"), scheduled_funding_date: D("2026-11-03") });
  assert.equal(cal.rescission_expires_on, "2026-10-31"); assert.equal(cal.earliest_funding_date, "2026-11-02"); assert.equal(cal.scheduled_funding_date, "2026-11-03");
  let f = openFunding({ funding_id: "F-3", application_id: APP, partner_id: PARTNER, partner_loan_number: PARTNER_LOAN, calendar: cal, gross_loan_cents: GROSS, note_rate_pct: RATE, interest: { borrower_elected_credit: true } });
  const wsr = reconcileToSettlementStatement(ws, 55_922_294n, RUN).worksheet; f = { ...f, worksheet: wsr, net_wire_cents: wsr.net_wire_cents };
  assert.equal(f.delivery_window_compressed, true);
  const at = "2026-11-03T13:12:00.000Z";
  const facts = passingFacts(at, { funding: { ...passingFacts(at).funding, disbursement_date: D("2026-11-03"), release_date: D("2026-11-03"), note_date: D("2026-10-28") }, rescission: { status: "expired_not_rescinded", expires_at: "2026-11-01T07:00:00.000Z", reasonably_satisfied_at: "2026-11-02T15:00:00.000Z", waiver_id: null, now: at }, vvoe: { verified_on: D("2026-10-26"), self_employed: false }, hazard: { hazard_status: "verified", effective_date: D("2026-11-03"), transaction_type: "refinance", policy_in_force: true }, first_payment: { first_payment_date: D("2026-12-01") }, payoffs: [{ liability_id: "L-PRIOR", status: "received", good_through_date: D("2026-11-05") }] });
  const a = authorizeFunding(h.events, f, { ...authorizeInput(at), conditions: evaluateFundingConditions("F-3", facts), rescission: facts.rescission! });
  assert.equal(a.funding.status, "authorized");
  const ev = h.ofType("funding.authorized")[0]!;
  assert.equal(ev.payload.delivery_window_compressed, true); assert.equal(ev.payload.lpi_45_date, "2026-12-16"); assert.equal(ev.payload.lpi_date, "2026-11-01"); assert.equal(ev.payload.first_payment_date, "2026-12-01"); assert.equal(ev.payload.interest_mode, "interest_credit");
});

test("26.3-T5: Given the consummated CD shows gross $560,000.00, prepaid interest $1,785.43, escrow deposit $1,665.00 and lender credit $700.00, when the settlement statement requests $557,249.57, then `variance_cents` = 0, `FC_FIGURES_RECONCILED = pass`, and the SM ledger set is Dr `warehouse_advance_receivable` 54,880,000 / Dr `partner_haircut_reserve` 844,957 / Cr `sm_funding_cash` 55,724,957; when the statement requests $557,449.57, then the funding holds with `variance_cents` = 20,000 and an escalation to the settlement agent.", async () => {
  const ws = buildFundingWorksheet({ funding_id: "F-1", version: 1, cd_version: 1, gross_loan_cents: 56_000_000n, prepaid_interest_cents: 178_543n, escrow_deposit_cents: 166_500n, lender_credits_cents: 70_000n });
  assert.equal(ws.lender_retained_cents, 345_043n); assert.equal(ws.net_wire_cents, 55_724_957n);                 // $557,249.57
  const ok = reconcileToSettlementStatement(ws, 55_724_957n, RUN);
  assert.equal(ok.worksheet.variance_cents, 0n); assert.equal(ok.worksheet.reconciled, true); assert.equal(ok.item.status, "pass"); assert.equal(ok.hold.held, false);
  const led = fundingLedgerLines({ gross_loan_cents: 56_000_000n, net_wire_cents: 55_724_957n, loan_ref: APP });
  assert.deepEqual(led.lines.map((l) => [l.account.account, l.amountCents]), [["warehouse_advance_receivable", 54_880_000n], ["partner_haircut_reserve", 844_957n], ["sm_funding_cash", -55_724_957n]]);
  assert.equal(led.split.advance_cents, 54_880_000n); assert.equal(led.split.partner_contribution_cents, 844_957n); assert.equal(led.posting_target, "warehouse_advance_receivable");
  assert.ok(led.lines.every((l) => l.ruleRef.startsWith("26.3 rule 5")));
  const ledger = new MemoryLedger();
  const set = postFundingLedger(ledger, { gross_loan_cents: 56_000_000n, net_wire_cents: 55_724_957n, loan_ref: APP, effective_date: D("2026-11-12") }, "2026-11-12T14:41:00.000Z");
  assert.equal(set.lines.reduce((a, l) => a + l.amountCents, 0n), 0n); assert.equal(ledger.balance({ scope: "corporate", account: "sm_funding_cash" as never }), -55_724_957n);
  const mirror = partnerMirrorLines({ gross_loan_cents: 56_000_000n, lender_credits_cents: 70_000n, prepaid_interest_cents: 178_543n, escrow_deposit_cents: 166_500n, net_wire_cents: 55_724_957n, loan_ref: APP });
  assert.equal(mirror.balanced, true); assert.equal(mirror.lines.find((l) => l.account === "prepaid_interest")!.amount_cents, -178_543n);
  // $557,449.57 requested: variance = net_wire − agent_requested = −20,000 cents (magnitude 20,000 — the data-model sign convention); the funding holds
  const bad = reconcileToSettlementStatement(ws, 55_744_957n, RUN);
  assert.equal(bad.worksheet.variance_cents, -20_000n); assert.equal(bad.worksheet.reconciled, false); assert.equal(bad.item.status, "fail"); assert.equal(bad.hold.held, true); assert.equal(bad.hold.escalate_to, "settlement_agent");
  const h = harness("2026-11-12T13:05:00.000Z");
  const held = recordReconciliation(h.events, APP, bad, RUN.at); assert.equal(held.type, "funding.held"); assert.equal(held.payload.reason, "figures_variance"); assert.equal(held.payload.variance_cents, "-20000");
  // through the bus: the worksheet row is reconciled, then the second statement holds the funding and escalates to the settlement agent
  const b = busFor(h);
  await b.run("computeDates", { op: "open", funding_id: "F-1", state: "AZ", transaction_type: "limited_cash_out", time_zone: TZ, consummation_at: CONSUMMATION, review_completed_on: "2026-11-09", partner_id: PARTNER, partner_loan_number: PARTNER_LOAN, gross_loan_cents: GROSS, note_rate_pct: RATE, note_first_payment_date: "2027-01-01" });
  await b.run("buildFundingWorksheet", { funding_id: "F-1", version: 1, cd_version: 1, gross_loan_cents: GROSS, prepaid_interest_cents: 178_543n, escrow_deposit_cents: 166_500n, lender_credits_cents: 70_000n });
  const r1 = await b.run("reconcileToSettlementStatement", { funding_id: "F-1", worksheet_id: "F-1:ws:1", agent_requested_net_cents: 55_724_957n });
  assert.equal((r1.output as { item: { status: string } }).item.status, "pass"); assert.equal(h.ofType("funding.worksheet.reconciled").length, 1);
  const r2 = await b.run("reconcileToSettlementStatement", { funding_id: "F-1", worksheet_id: "F-1:ws:1", agent_requested_net_cents: 55_744_957n });
  assert.equal((r2.output as { worksheet: { variance_cents: bigint } }).worksheet.variance_cents, -20_000n);
  assert.equal(h.escalations.list().filter((e) => e.kind === "settlement_agent").length, 1);
});

test("26.3-T6: Given a verified wire record (Nov 3) and an e-mail on Nov 12 07:30 ET from `closer@escrow-c0.com` (domain altered) instructing a new account, when `scoreBecIndicators` runs, then two indicators hit (altered address; changed account at a known beneficiary), `funding.held{bec_indicator}` is emitted, a callback is required to the ALTA-Registry number, and even after a genuine confirmation the earliest release is Fri Nov 13 (no same-day changes); the original verified instructions are the only ones the agent may prepare.", () => {
  const s = scoreBecIndicators({ received_at: "2026-11-12T12:30:00.000Z", channel: "email", sender_email: "closer@escrow-c0.com", registered_email_domain: "escrow-co.com", account_hash: "h-new-account", verified_account_hash: VERIFIED.instructions_hash, beneficiary_known: true }, D("2026-11-12"));
  assert.deepEqual(s.indicators, ["altered_sender_domain", "changed_account_at_known_beneficiary"]); assert.equal(s.score, 2);
  assert.equal(s.hold, true); assert.equal(s.callback_required, true); assert.equal(s.callback_number_source, "alta_registry"); assert.equal(s.officer_and_fraud_case, true);
  assert.equal(s.earliest_release_after_confirmation, "2026-11-13"); assert.equal(s.prepare_from, "verified_record_only"); assert.match(s.citation, /FIN-2016-A003/);
  const h = harness("2026-11-12T12:30:00.000Z");
  const f = advanceApproved(h);
  const held = recordBecHold(h.events, f, s, "2026-11-12T12:31:00.000Z");
  assert.equal(held.funding.status, "held"); assert.equal(held.funding.hold_reason, "bec_indicator");
  const ev = h.ofType("funding.held"); assert.equal(ev.length, 1); assert.equal(ev[0]!.payload.reason, "bec_indicator"); assert.equal(ev[0]!.payload.callback_number_source, "alta_registry"); assert.equal(ev[0]!.payload.earliest_release_after_confirmation, "2026-11-13");
  assert.equal(h.ofType("funding.fraud_case.requested").length, 1);
  // only the verified instructions are preparable: the e-mailed account is refused by hash, and by source
  const base = { wire_id: "W-1", funding: f, record: VERIFIED, value_date: D("2026-11-12"), prepared_at: "2026-11-12T13:20:00.000Z", run_id: "run-1", editors: ["u-analyst"], borrower_last_name: "Borrower", property_short: "123 Main St, Phoenix AZ", funding_account_ref_hash: "sha256:funding", closing_documents: [] };
  assert.throws(() => prepareWire({ ...base, instructions_hash: "h-new-account", instructions_source: "verified_record" }), (e: unknown) => e instanceof FundingRefused && e.code === "WIRE_NOT_VERIFIED_RECORD");
  assert.throws(() => prepareWire({ ...base, instructions_hash: VERIFIED.instructions_hash, instructions_source: "email" }), (e: unknown) => e instanceof FundingRefused && e.code === "WIRE_INSTRUCTIONS_FROM_EMAIL");
  const w = prepareWire({ ...base, instructions_hash: VERIFIED.instructions_hash, instructions_source: "verified_record" });
  assert.equal(w.instructions_hash, "h-verified"); assert.equal(w.four_eyes_check.instructions_hash_match, true);
  // a genuine change confirmed on the funding day still fails the freeze check — no same-day changes
  const changed = { ...VERIFIED, instructions_hash: "h-new-account", change_detected_at: "2026-11-12T12:30:00.000Z", verified_at: "2026-11-12T14:00:00.000Z" };
  const four = prepareWire({ ...base, record: changed, instructions_hash: "h-new-account", instructions_source: "verified_record" }).four_eyes_check;
  assert.equal(four.change_freeze_ok, false); assert.ok(four.failures.includes("change_inside_48h_freeze"));
});

test("26.3-T7: Given a prepared wire, when the same user who edited the worksheet attempts release, then release is refused (`released_by` must differ from every editor); when a distinct `funding_approver` releases at 09:40 ET, then `funding.wire.released`, IMAD within 30 minutes, and `funding.wire.accepted`; when the IMAD is not received by 10:10 ET, then `SM_O73_WIRE_ACCEPT_30M` breaches and the bank is contacted — no second wire is prepared.", () => {
  const prepared = (h: ReturnType<typeof harness>) => {
    const f0 = advanceApproved(h);
    const w = prepareWire({ wire_id: "W-1", funding: f0, record: VERIFIED, instructions_hash: VERIFIED.instructions_hash, instructions_source: "verified_record", value_date: D("2026-11-12"), prepared_at: "2026-11-12T13:20:00.000Z", run_id: "run-1", editors: ["u-analyst"], borrower_last_name: "Borrower", property_short: "123 Main St, Phoenix AZ", funding_account_ref_hash: "sha256:funding", closing_documents: [] });
    const r = recordWirePrepared(h.events, f0, w);
    return { f: r.funding, w };
  };
  const h = harness("2026-11-12T13:20:00.000Z");
  const { f, w } = prepared(h);
  assert.equal(f.status, "wire_pending_release"); assert.equal(h.timer("SM_O73_DUAL_CONTROL_RELEASE_1H")?.status, "armed");
  assert.throws(() => releaseWire(h.events, f, w, { by: ANALYST_APPROVER, released_at: "2026-11-12T14:40:00.000Z", bank_ref: "BK-1" }), (e: unknown) => e instanceof FundingRefused && e.code === "RELEASE_BY_EDITOR");
  assert.throws(() => releaseWire(h.events, f, w, { by: FUNDER, released_at: "2026-11-12T14:40:00.000Z", bank_ref: "BK-1" }), (e: unknown) => e instanceof FundingRefused && e.code === "RELEASE_NEEDS_FUNDING_APPROVER");
  const rel = releaseWire(h.events, f, w, { by: APPROVER, released_at: "2026-11-12T14:40:00.000Z", bank_ref: "BK-1" });   // 09:40 ET
  assert.equal(rel.wire.status, "released"); assert.equal(rel.wire.released_by, "u-approver"); assert.equal(rel.cutoff.same_day, true); assert.equal(rel.funding.funding_date, "2026-11-12");
  const released = h.ofType("funding.wire.released"); assert.equal(released.length, 1); assert.equal(released[0]!.payload.by, "u-approver"); assert.equal(released[0]!.occurredAt, "2026-11-12T14:40:00.000Z");
  assert.equal(h.timer("SM_O73_DUAL_CONTROL_RELEASE_1H")?.status, "satisfied");
  const t = h.timer("SM_O73_WIRE_ACCEPT_30M")!; assert.equal(t.status, "armed"); assert.equal(t.dueAt, Date.parse("2026-11-12T15:10:00.000Z"));   // 10:10 ET
  const acc = acceptWire(h.events, rel.funding, rel.wire, { imad: "20261112B1QGC01R000123", accepted_at: "2026-11-12T14:41:00.000Z" });
  assert.equal(acc.funding.status, "wire_accepted"); assert.equal(acc.wire.imad, "20261112B1QGC01R000123");
  assert.equal(h.ofType("funding.wire.accepted")[0]!.payload.imad, "20261112B1QGC01R000123"); assert.equal(h.timer("SM_O73_WIRE_ACCEPT_30M")?.status, "satisfied");
  // no IMAD by 10:10 ET: the 30-minute clock breaches, the bank is contacted, and a second wire is refused
  const h2 = harness("2026-11-12T13:20:00.000Z");
  const p2 = prepared(h2);
  const rel2 = releaseWire(h2.events, p2.f, p2.w, { by: APPROVER, released_at: "2026-11-12T14:40:00.000Z", bank_ref: "BK-2" });
  const breaches = h2.timers.evaluate("2026-11-12T15:10:01.000Z");
  assert.ok(breaches.some((b) => b.instance.code ==="SM_O73_WIRE_ACCEPT_30M")); assert.equal(h2.timer("SM_O73_WIRE_ACCEPT_30M")?.status, "breached");
  const contact = wireAcceptOverdue(h2.events, rel2.funding, rel2.wire, "2026-11-12T15:11:00.000Z");
  assert.equal(contact.event.type, "funding.wire.bank_contacted"); assert.equal(contact.second_wire_allowed, false);
  assert.throws(() => prepareWire({ wire_id: "W-2", funding: { ...rel2.funding, status: "advance_approved" }, record: VERIFIED, instructions_hash: VERIFIED.instructions_hash, instructions_source: "verified_record", value_date: D("2026-11-12"), prepared_at: "2026-11-12T15:12:00.000Z", run_id: "run-2", editors: [], borrower_last_name: "Borrower", property_short: "123 Main St", funding_account_ref_hash: "sha256:funding", closing_documents: [], existing_wire: rel2.wire }), (e: unknown) => e instanceof FundingRefused && e.code === "NO_SECOND_WIRE");
});

test("26.3-T8: Given a wet-state purchase closing Wed Nov 18, 2026 10:05 ET, when the pre-signing subset passes Nov 17 and the wire (value date Nov 18) is accepted at 08:56 ET, then `SM_O73_WET_FUNDS_AT_TABLE_GATE` is satisfied; when the execution review passes 11:40 ET, then the disbursement authorization is sent and `loan.funded{disbursement_date=2026-11-18}` follows the agent's 13:15 ET confirmation; prepaid interest = 13 × $71.96 = $935.48 and first payment Jan 1, 2027 (≤ Jan 18 ✓).", () => {
  const APP_OH = "APP-PURCH-OH"; const GROSS_OH = 41_200_000n, RATE_OH = "6.375";
  const cal = computeDates({ application_id: APP_OH, state: "OH", transaction_type: "purchase", time_zone: "America/New_York", consummation_at: null, rescindable: false, closing_date: D("2026-11-18") });
  assert.equal(cal.funding_type, "wet"); assert.equal(cal.disbursement_authorization_mode, "table_funds_then_authorize"); assert.equal(cal.earliest_funding_date, "2026-11-18"); assert.equal(cal.rescission_expires_at, null);
  const p = computePerDiem(GROSS_OH, RATE_OH, D("2026-11-18"));
  assert.equal(p.per_diem_cents, 7_196n); assert.equal(p.prepaid_days, 13); assert.equal(p.prepaid_interest_cents, 93_548n);   // 13 × $71.96 = $935.48
  const h = harness("2026-11-17T21:00:00.000Z");
  h.events.append({ type: "closing.scheduled", applicationId: APP_OH, actor: { kind: "agent", id: "title-closing" }, occurredAt: "2026-11-16T15:00:00.000Z", payload: { application_id: APP_OH, source: "origination", wet: true, closing_type: "wet", scheduled_at: "2026-11-18T15:05:00.000Z", closing_date: "2026-11-18" } });
  let f = openFunding({ funding_id: "F-OH", application_id: APP_OH, partner_id: PARTNER, partner_loan_number: "PL-2002", calendar: cal, gross_loan_cents: GROSS_OH, note_rate_pct: RATE_OH, interest: { note_first_payment_date: D("2027-01-01") } });
  assert.equal(f.interest.first_payment_date, "2027-01-01"); assert.equal(f.interest.first_payment_latest_allowed_date, "2027-01-18"); assert.equal(f.interest.first_payment_gate.status, "pass"); assert.equal(f.interest.lpi_date, "2026-12-01");
  const ws = reconcileToSettlementStatement(buildFundingWorksheet({ funding_id: "F-OH", version: 1, cd_version: 1, gross_loan_cents: GROSS_OH, prepaid_interest_cents: 93_548n, escrow_deposit_cents: 124_000n, lender_credits_cents: 0n }), 40_982_452n, { at: "2026-11-17T21:00:00.000Z", run_id: "run-oh" }).worksheet;
  assert.equal(ws.net_wire_cents, 40_982_452n); assert.equal(ws.reconciled, true);                                             // $409,824.52
  f = { ...f, worksheet: ws, net_wire_cents: ws.net_wire_cents };
  // pre-signing subset Tue Nov 17 16:00 ET: the post-signing items are still pending, the subset passes
  const pre = passingFacts("2026-11-17T21:00:00.000Z", { funding: { funding_type: "wet", transaction_type: "purchase", disbursement_date: D("2026-11-18"), release_date: D("2026-11-18"), note_date: D("2026-11-18"), authorized: false, stage: "pre_signing" }, loan: { ltv_pct: 90, sfha: false, project: false, enote: true, tx_50a6: false, record_before_fund: false }, execution: null, cd: null, identity: null, rescission: null, mi: { status: "committed" }, hazard: { hazard_status: "verified", effective_date: D("2026-11-18"), transaction_type: "purchase", premium_on_cd: true }, gifts: [{ gift_id: "G-1", status: "transfer_verified" }], payoffs: [], wire: { verified_at: "2026-11-10T15:00:00.000Z", blocks_disbursement: false, callback_number_source: "alta_registry", as_of: "2026-11-17T21:00:00.000Z" }, enote: null, audit_trail_open: null, vvoe: { verified_on: D("2026-11-16"), self_employed: false } });
  const c = evaluateFundingConditions("F-OH", pre);
  assert.equal(c.pre_signing_subset_passed, true); assert.equal(fcStatus(c, "FC_DOCS_EXECUTED_QC"), "pending"); assert.equal(fcStatus(c, "FC_RESCISSION_EXPIRED"), "n/a"); assert.equal(fcStatus(c, "FC_MI_CERT"), "pass"); assert.equal(fcStatus(c, "FC_GIFT_TRANSFER"), "pass"); assert.equal(fcStatus(c, "FC_AUDIT_TRAIL"), "n/a");
  // Nov 18: authorize 08:12 ET, advance approved, wire prepared, released 08:55 ET, IMAD 08:56 ET — before the 10:05 ET session
  const at = "2026-11-18T13:12:00.000Z";
  const full = passingFacts(at, { ...pre, as_of: at, execution: { review_passed: false, all_docs_signed: false, blocking_defects: 0, package_returned: false }, wire: { ...pre.wire!, as_of: at } });
  f = requestFunding(h.events, f, "2026-11-17T21:00:00.000Z").funding;
  const cond = evaluateFundingConditions("F-OH", { ...full, execution: { review_passed: true, all_docs_signed: true, blocking_defects: 0, package_returned: true }, cd: { consummated_version: 1, delivered_with_receipt: true, signed_copy_in_documents: null }, identity: { all_signers_proofed: true }, enote: { registered: true, secured_party_set: true } });
  f = authorizeFunding(h.events, f, { at, conditions: cond, rescission: null, fraud_hold: null, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [{ gift_id: "G-1", status: "transfer_verified" }] }).funding;
  f = recordAdvanceApproved(f, "ADV-OH");
  const w = prepareWire({ wire_id: "W-OH", funding: f, record: { ...VERIFIED, verified_at: "2026-11-10T15:00:00.000Z", expires_at: "2026-12-10T15:00:00.000Z" }, instructions_hash: VERIFIED.instructions_hash, instructions_source: "verified_record", value_date: D("2026-11-18"), prepared_at: "2026-11-18T13:20:00.000Z", run_id: "run-oh", editors: ["u-analyst"], borrower_last_name: "Buyer", property_short: "45 Elm St, Columbus OH", funding_account_ref_hash: "sha256:funding", closing_documents: [] });
  f = recordWirePrepared(h.events, f, w).funding;
  const rel = releaseWire(h.events, f, w, { by: APPROVER, released_at: "2026-11-18T13:55:00.000Z", bank_ref: "BK-OH" }); f = rel.funding;
  const acc = acceptWire(h.events, f, rel.wire, { imad: "20261118B1QGC01R000777", accepted_at: "2026-11-18T13:56:00.000Z" }); f = acc.funding;
  const gate = wetFundsAtTableGate({ funding_type: "wet", pre_signing_subset_passed: c.pre_signing_subset_passed, wire_accepted_at: "2026-11-18T13:56:00.000Z", wire_value_date: D("2026-11-18"), closing_date: D("2026-11-18"), signing_start_at: "2026-11-18T15:05:00.000Z" });
  assert.equal(gate.open, true);
  assert.equal(evaluateGate("26.3.wetFundsAtTableGate", { funding_type: "wet", pre_signing_subset_passed: true, wire_accepted_at: "2026-11-18T13:56:00.000Z", wire_value_date: "2026-11-18", closing_date: "2026-11-18", signing_start_at: "2026-11-18T15:05:00.000Z" }).open, true);
  assert.equal(evaluateGate("26.3.wetFundsAtTableGate", { funding_type: "wet", pre_signing_subset_passed: true, wire_accepted_at: null, closing_date: "2026-11-18", signing_start_at: "2026-11-18T15:05:00.000Z" }).open, false);
  const wet = h.timer("SM_O73_WET_FUNDS_AT_TABLE_GATE"); assert.ok(wet, "closing.scheduled{wet} arms the table-funds gate"); assert.equal(wet.status, "satisfied");
  f = confirmAgentReceipt(h.events, f, { funds_received_by_agent_at: "2026-11-18T14:20:00.000Z", channel: "portal", confirmed_by: "title-agency" }).funding;
  assert.throws(() => issueDisbursementAuthorization(h.events, f, { execution_review_passed_at: "2026-11-18T16:40:00.000Z", issued_at: "2026-11-18T15:30:00.000Z", channel: "portal", funding_number: "FN-OH-1" }), (e: unknown) => e instanceof FundingRefused && e.code === "AUTHORIZATION_BEFORE_REVIEW");
  const auth = issueDisbursementAuthorization(h.events, f, { execution_review_passed_at: "2026-11-18T16:40:00.000Z", issued_at: "2026-11-18T16:52:00.000Z", channel: "portal", funding_number: "FN-OH-1" });   // 11:40 → 11:52 ET
  assert.equal(auth.type, "funding.disbursement.authorized");
  const done = confirmDisbursement(h.events, f, { disbursement_date: D("2026-11-18"), confirmed_at: "2026-11-18T18:15:00.000Z", source: "agent_attestation", evidence_document_id: "DOC-OH-DISB", escrow_deposit_cents: 124_000n });   // 13:15 ET
  assert.equal(done.funding.status, "disbursed"); assert.equal(done.loan_funded.disbursement_date, "2026-11-18"); assert.equal(done.loan_funded.funding_date, "2026-11-18");
  assert.equal(done.loan_funded.prepaid_interest_cents, 93_548n); assert.equal(done.loan_funded.per_diem_cents, 7_196n); assert.equal(done.loan_funded.first_payment_date, "2027-01-01"); assert.equal(done.loan_funded.interest_credit, false);
  const lf = h.ofType("loan.funded"); assert.equal(lf.length, 1); assert.equal(lf[0]!.payload.disbursement_date, "2026-11-18"); assert.equal(lf[0]!.applicationId, APP_OH); assert.equal(lf[0]!.payload.wire_id, "W-OH");
  assert.ok(Date.parse(lf[0]!.occurredAt) > Date.parse(auth.occurredAt));
  assert.equal(h.timer("SM_O73_DISBURSEMENT_CONFIRM_1BD")?.status, "satisfied"); assert.equal(h.timer("SM_O73_AGENT_RECEIPT_CONFIRM_2H")?.status, "satisfied");
});

test("26.3-T9: Given a refinance in Virginia with rescission expiring midnight Tue Nov 10, 2026, when the wire is released Thu Nov 12 (Nov 11 a Fedwire holiday), then `VA_55_1_902_REFI_DISBURSE_1BD` (federal-calendar reading) is satisfied; when it is released Fri Nov 13, then the timer breaches and a sev-1 escalation to `officer` records the statutory exposure.", () => {
  const cal = computeDates({ application_id: "APP-VA", state: "VA", transaction_type: "limited_cash_out", time_zone: "America/New_York", consummation_at: "2026-11-06T19:00:00.000Z", rescindable: true });
  assert.equal(cal.funding_type, "wet"); assert.equal(cal.rescission_expires_on, "2026-11-10"); assert.equal(cal.earliest_funding_date, "2026-11-12");
  assert.equal(vaDisburseDeadline(D("2026-11-10")), "2026-11-12");
  assert.deepEqual(vaDisbursementCompliance(D("2026-11-10"), D("2026-11-12")), { deadline: D("2026-11-12"), compliant: true, statutory_exposure: null });
  const late = vaDisbursementCompliance(D("2026-11-10"), D("2026-11-13")); assert.equal(late.compliant, false); assert.match(late.statutory_exposure ?? "", /Va\. Code § 55\.1-902/);
  const expired = (h: ReturnType<typeof harness>) => h.events.append({ type: "rescission.period.expired", applicationId: "APP-VA", actor: { kind: "agent", id: "disclosure" }, occurredAt: "2026-11-11T05:00:00.000Z", payload: { application_id: "APP-VA", rescission_id: "APP-VA:rescission", basis: "regz_1026_23", expires_on: "2026-11-10", expires_at: "2026-11-11T05:00:00.000Z", mail_allowance_ends_on: "2026-11-12" } });
  const h = harness("2026-11-11T05:00:00.000Z"); expired(h);
  const t = h.timer("VA_55_1_902_REFI_DISBURSE_1BD")!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-11-10"); assert.equal(t.dueDate, "2026-11-12");
  h.events.append({ type: "funding.wire.released", applicationId: "APP-VA", actor: APPROVER, occurredAt: "2026-11-12T14:40:00.000Z", payload: { application_id: "APP-VA", funding_id: "F-VA", wire_id: "W-VA", by: "u-approver", released_at: "2026-11-12T14:40:00.000Z", value_date: "2026-11-12" } });
  assert.equal(h.timer("VA_55_1_902_REFI_DISBURSE_1BD")?.status, "satisfied");
  const h2 = harness("2026-11-11T05:00:00.000Z"); expired(h2);
  const breaches = h2.timers.evaluate("2026-11-13T05:00:00.000Z");
  assert.ok(breaches.some((b) => b.instance.code ==="VA_55_1_902_REFI_DISBURSE_1BD")); assert.equal(h2.timer("VA_55_1_902_REFI_DISBURSE_1BD")?.status, "breached");
  const esc = h2.escalations.open({ kind: "officer", applicationId: "APP-VA", severity: "sev1", payload: { timer: "VA_55_1_902_REFI_DISBURSE_1BD", statutory_exposure: late.statutory_exposure, released_on: "2026-11-13" } }, FUNDER);
  assert.equal(esc.kind, "officer"); assert.equal(esc.severity, "sev1"); assert.match(String(esc.payload.statutory_exposure), /not disbursed to the settlement agent by 2026-11-12/);
});

test("26.3-T10: Given a valid rescission notice received Fri Nov 13 postmarked Tue Nov 10 after the Nov 12 disbursement, when 25.3 records `rescission.exercised`, then 26.3 opens `funding_unwinds{funds_position=disbursed}` with steps (recover escrow deposit; partner repurchase of the advance; void document set; eNote reversal; MIN deactivation; release/reconveyance; de-board; HMDA update), the money steps carry `refund_due_at` = Thu Dec 3, 2026 (25.3), and no step moving money executes without `officer` approval.", () => {
  const h = harness("2026-11-13T17:00:00.000Z");
  const disbursed = fixtureFunding({ status: "disbursed", prior_status: "funds_at_agent", passed_wire_pending_release: true, funding_date: D("2026-11-12"), disbursement_date: D("2026-11-12"), wire_id: "W-1", warehouse_advance_id: "ADV-1", disbursement_confirmed_at: "2026-11-12T19:10:00.000Z", disbursement_confirmation_source: "final_settlement_statement" });
  // 25.3: received Fri Nov 13 (postmarked Nov 10 → given within the period) → refund_due_at = received_on + 20 calendar days = Thu Dec 3
  const refund_due_at = addDays(D("2026-11-13"), 20); assert.equal(refund_due_at, "2026-12-03");
  h.events.append({ type: "rescission.exercised", applicationId: APP, actor: { kind: "agent", id: "disclosure" }, occurredAt: "2026-11-13T17:00:00.000Z", payload: { application_id: APP, rescission_id: `${APP}:rescission`, exercise_id: "X-1", consumer_id: "C-B", refund_due_at, after_disbursement: true } });
  const u = openUnwind(h.events, disbursed, { unwind_id: "U-1", trigger: "rescission_exercised_post_disbursement", at: "2026-11-13T17:05:00.000Z", time_zone: TZ, exercise: { exercise_id: "X-1", refund_due_at }, enote: true, security_instrument_recorded: true, prior_lien_paid: true });
  assert.equal(u.unwind.funds_position, "disbursed"); assert.equal(u.funding.status, "unwinding"); assert.equal(u.funding.unwind_id, "U-1");
  const steps = u.unwind.steps.map((s) => s.step);
  for (const want of [/recover the escrow deposit/, /partner repurchase of the advance/, /void the document set/, /eNote Registration Reversal/, /MIN reversal or deactivation/, /release or reconveyance/, /de-board/, /HMDA action taken/]) assert.ok(steps.some((s) => want.test(s)), `step ${want}`);
  const money = u.unwind.steps.filter((s) => s.moves_money); assert.ok(money.length >= 4);
  assert.ok(money.every((s) => s.refund_due_at === "2026-12-03" && s.due_at === "2026-12-03"));
  assert.ok(u.unwind.steps.filter((s) => !s.moves_money).every((s) => s.due_at === "2026-11-20"));   // +5 creditor business days from Fri Nov 13
  const ev = h.ofType("funding.unwind.opened"); assert.equal(ev.length, 1); assert.equal(ev[0]!.payload.funds_position, "disbursed"); assert.equal(ev[0]!.payload.exercise_id, "X-1");
  assert.equal(h.timer("SM_O73_UNWIND_STEPS_5BD")?.status, "armed");
  const idx = u.unwind.steps.findIndex((s) => s.moves_money);
  assert.throws(() => executeUnwindStep(u.unwind, idx, { actor: FUNDER, at: "2026-11-16T15:00:00.000Z", evidence: "DOC-REFUND" }), (e: unknown) => e instanceof FundingRefused && e.code === "UNWIND_MONEY_NEEDS_OFFICER");
  assert.throws(() => executeUnwindStep(u.unwind, idx, { actor: APPROVER, at: "2026-11-16T15:00:00.000Z", evidence: "DOC-REFUND" }), (e: unknown) => e instanceof FundingRefused && e.code === "UNWIND_MONEY_NEEDS_OFFICER");
  const done = executeUnwindStep(u.unwind, idx, { actor: OFFICER, at: "2026-11-16T15:00:00.000Z", evidence: "DOC-REFUND" });
  assert.equal(done.steps[idx]!.approved_by, "human:u-officer"); assert.equal(done.steps[idx]!.done_at, "2026-11-16T15:00:00.000Z");
  const nonMoney = u.unwind.steps.findIndex((s) => !s.moves_money);
  assert.equal(executeUnwindStep(u.unwind, nonMoney, { actor: FUNDER, at: "2026-11-16T15:00:00.000Z", evidence: "DOC-VOID" }).steps[nonMoney]!.done_at, "2026-11-16T15:00:00.000Z");
});

test("26.3-T11: Given consummation Wed Nov 25, 2026, then `rescission_expires_at` = midnight ending Mon Nov 30, `earliest_funding_date` = Tue Dec 1, `interest_mode = none`, prepaid interest $0.00, first payment Jan 1, 2027, and the printed note (first payment Jan 1; maturity Dec 1, 2056) needs no re-draw.", () => {
  const cal = refiCalendar({ consummation_at: "2026-11-25T21:00:00.000Z", review_completed_on: D("2026-11-27") });
  assert.equal(cal.rescission_expires_on, "2026-11-30");                     // Thu Nov 26 Thanksgiving excluded; Fri 27 (1), Sat 28 (2), Sun excluded, Mon 30 (3)
  assert.equal(cal.rescission_expires_at, "2026-12-01T07:00:00.000Z");        // midnight ending Mon Nov 30 MST
  assert.equal(cal.earliest_funding_date, "2026-12-01"); assert.equal(cal.scheduled_funding_date, "2026-12-01");
  const d = decideInterestMode({ disbursement_date: D("2026-12-01"), gross_loan_cents: GROSS, note_rate_pct: RATE, note_first_payment_date: D("2027-01-01"), note_maturity_date: D("2056-12-01") });
  assert.equal(d.mode, "none"); assert.equal(d.prepaid_days, 0); assert.equal(d.prepaid_interest_cents, 0n); assert.equal(d.interest_credit_cents, 0n);   // $0.00
  assert.equal(d.interest_accrual_start_date, "2026-12-01"); assert.equal(d.first_payment_date, "2027-01-01"); assert.equal(d.first_payment_latest_allowed_date, "2027-02-01"); assert.equal(d.first_payment_gate.status, "pass");
  assert.equal(d.maturity_date_expected, "2056-12-01"); assert.equal(d.redraw_required, false); assert.equal(d.lpi_date, "2026-12-01");
  const f = openFunding({ funding_id: "F-4", application_id: APP, partner_id: PARTNER, partner_loan_number: PARTNER_LOAN, calendar: cal, gross_loan_cents: GROSS, note_rate_pct: RATE, interest: { note_first_payment_date: D("2027-01-01") } });
  assert.equal(f.interest.mode, "none"); assert.equal(f.interest.redraw_required, false);
  // the alternative (Feb 1 first payment with 31 days prepaid, $2,913.07 under this convention) is permitted but dominated
  const alt = computePerDiem(GROSS, RATE, D("2026-12-01")); assert.equal(alt.prepaid_days, 31); assert.equal(alt.prepaid_interest_cents, 291_307n); assert.equal(alt.unrounded_product_cents, 291_315n);
});

test("26.3-T12: Given `origination.warehouse_legal_form = secured_loan_to_partner`, when the wire is prepared, then `originator_to_beneficiary_info` names the partner as lender and the partner loan number, no assignment/endorsement to SM exists in `closing_documents`, and the posting target is `warehouse_advance_receivable`; given the flag set to `purchase_at_settlement` without an `officer`+`attorney` decision record (31.1), then `funding.authorized` is refused with reason `table_funding_form_not_approved`.", async () => {
  const h = harness("2026-11-12T13:20:00.000Z");
  const f = advanceApproved(h);
  assert.equal(f.legal_form, "secured_loan_to_partner");
  const base = { wire_id: "W-1", funding: f, record: VERIFIED, instructions_hash: VERIFIED.instructions_hash, instructions_source: "verified_record" as const, value_date: D("2026-11-12"), prepared_at: "2026-11-12T13:20:00.000Z", run_id: "run-1", editors: ["u-analyst"], borrower_last_name: "Borrower", property_short: "123 Main St, Phoenix AZ", funding_account_ref_hash: "sha256:funding" };
  const w = prepareWire({ ...base, closing_documents: [{ kind: "endorsement", assignee: "in blank (Fannie Mae's benefit only)" }, { kind: "note" }] });
  assert.match(w.originator_to_beneficiary_info, /^Lender: P-PARTNER; Partner loan PL-1001; Borrower; 123 Main St, Phoenix AZ/);
  assert.ok(!/SSN|\d{3}-\d{2}-\d{4}/.test(w.originator_to_beneficiary_info));
  assert.equal(w.posting_target, "warehouse_advance_receivable"); assert.equal(w.kind, "funding");
  assert.equal(fundingLedgerLines({ gross_loan_cents: GROSS, net_wire_cents: w.amount_cents, loan_ref: APP }).posting_target, "warehouse_advance_receivable");
  assert.throws(() => prepareWire({ ...base, closing_documents: [{ kind: "assignment_of_mortgage", assignee: "Supermortgage, Inc." }] }), (e: unknown) => e instanceof FundingRefused && e.code === "ASSIGNMENT_TO_SM");
  assert.throws(() => prepareWire({ ...base, closing_documents: [{ kind: "allonge", assignee: "SM" }] }), (e: unknown) => e instanceof FundingRefused && e.code === "ASSIGNMENT_TO_SM");
  // Form B without the officer + attorney record: funding.authorized refused with reason table_funding_form_not_approved
  const formB = fixtureFunding({ legal_form: "purchase_at_settlement" });
  assert.throws(() => authorizeFunding(h.events, formB, authorizeInput()), (e: unknown) => e instanceof FundingRefused && e.code === "table_funding_form_not_approved");
  assert.equal(h.ofType("funding.authorized").length, 1);   // only the fixture's Form A authorization from advanceApproved()
  const withRecord = authorizeFunding(h.events, formB, { ...authorizeInput(), legal_form_decision_id: "DEC-31-1-9", decision_roles: ["officer", "attorney"] });
  assert.equal(withRecord.funding.status, "authorized");
  assert.throws(() => prepareWire({ ...base, funding: { ...f, legal_form: "purchase_at_settlement" }, closing_documents: [] }), (e: unknown) => e instanceof FundingRefused && e.code === "table_funding_form_not_approved");
  // the bus guardrail refuses the same flag before the handler runs
  const b = busFor(h);
  await assert.rejects(b.run("requestWarehouseAdvance", { funding_id: "F-1", warehouse_legal_form: "purchase_at_settlement", conditions: {}, ptf: {}, cash_to_close: {} }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_FORM_B" && /table_funding_form_not_approved/.test(e.message));
});

test("26.3-T13: Given a dry-state loan whose executed package is not returned by Mon Nov 9 17:00 MST (signing Nov 6), then the funding stays `pending_conditions` with `FC_DOCS_EXECUTED_QC = pending`, the settlement agent is escalated at day 2 and the title underwriter notified at day 5; no wire is ever prepared.", async () => {
  const d0 = documentsNotReturned({ signing_on: D("2026-11-06"), time_zone: TZ, as_of: "2026-11-09T22:00:00.000Z", package_returned: false });
  assert.equal(d0.return_deadline_at, "2026-11-10T00:00:00.000Z");   // Mon Nov 9 17:00 MST
  assert.equal(d0.overdue, false); assert.equal(d0.stage, "not_due");
  const d2 = documentsNotReturned({ signing_on: D("2026-11-06"), time_zone: TZ, as_of: "2026-11-10T16:00:00.000Z", package_returned: false });
  assert.equal(d2.overdue, true); assert.equal(d2.stage, "escalate_settlement_agent"); assert.equal(d2.escalate_settlement_agent_on, "2026-11-10"); assert.equal(d2.notify_title_underwriter_on, "2026-11-16");   // day 5 in creditor business days: Wed Nov 11 (Veterans Day) excluded → Mon Nov 16
  assert.equal(documentsNotReturned({ signing_on: D("2026-11-06"), time_zone: TZ, as_of: "2026-11-13T16:00:00.000Z", package_returned: false }).stage, "escalate_settlement_agent");   // day 4
  const d5 = documentsNotReturned({ signing_on: D("2026-11-06"), time_zone: TZ, as_of: "2026-11-16T16:00:00.000Z", package_returned: false });
  assert.equal(d5.stage, "notify_title_underwriter");
  assert.equal(documentsNotReturned({ signing_on: D("2026-11-06"), time_zone: TZ, as_of: "2026-11-16T16:00:00.000Z", package_returned: true }).stage, "not_due");
  const f = fixtureFunding(); assert.equal(f.status, "pending_conditions");
  const c = evaluateFundingConditions("F-1", passingFacts("2026-11-10T16:00:00.000Z", { execution: { review_passed: false, all_docs_signed: false, blocking_defects: 0, package_returned: false } }));
  assert.equal(fcStatus(c, "FC_DOCS_EXECUTED_QC"), "pending"); assert.equal(c.passed, false); assert.deepEqual(c.pending_codes, ["FC_DOCS_EXECUTED_QC"]);
  const h = harness("2026-11-10T16:00:00.000Z");
  assert.throws(() => authorizeFunding(h.events, f, { ...authorizeInput("2026-11-12T13:12:00.000Z"), conditions: c }), (e: unknown) => e instanceof FundingRefused && e.code === "FUNDING_CONDITIONS");
  assert.throws(() => prepareWire({ wire_id: "W-1", funding: f, record: VERIFIED, instructions_hash: VERIFIED.instructions_hash, instructions_source: "verified_record", value_date: D("2026-11-12"), prepared_at: "2026-11-12T13:20:00.000Z", run_id: "run-1", editors: [], borrower_last_name: "Borrower", property_short: "123 Main St", funding_account_ref_hash: "sha256:funding", closing_documents: [] }), (e: unknown) => e instanceof FundingRefused && e.code === "WIRE_BEFORE_ADVANCE");
  assert.equal(h.ofType("funding.wire.prepared").length, 0);
  // through the bus: day 2 → settlement_agent escalation; day 5 → officer escalation carrying the title-underwriter (CPL) notice; the row stays pending_conditions
  const b = busFor(h);
  await b.run("computeDates", { op: "open", funding_id: "F-1", state: "AZ", transaction_type: "limited_cash_out", time_zone: TZ, consummation_at: CONSUMMATION, review_completed_on: "2026-11-09", partner_id: PARTNER, partner_loan_number: PARTNER_LOAN, gross_loan_cents: GROSS, note_rate_pct: RATE });
  const facts = passingFacts("2026-11-10T16:00:00.000Z", { execution: { review_passed: false, all_docs_signed: false, blocking_defects: 0, package_returned: false } });
  const r2 = await b.run("evaluateFundingConditions", { funding_id: "F-1", facts, signing_on: "2026-11-06", time_zone: TZ, at: "2026-11-10T16:00:00.000Z" });
  assert.equal((r2.output as { documents: { stage: string } }).documents.stage, "escalate_settlement_agent");
  assert.equal(h.escalations.list().filter((e) => e.kind === "settlement_agent").length, 1);
  h.clock.set("2026-11-16T16:00:00.000Z");
  const r5 = await b.run("evaluateFundingConditions", { funding_id: "F-1", facts: { ...facts, as_of: "2026-11-16T16:00:00.000Z" }, signing_on: "2026-11-06", time_zone: TZ, at: "2026-11-16T16:00:00.000Z" });
  assert.equal((r5.output as { documents: { stage: string } }).documents.stage, "notify_title_underwriter");
  const officer = h.escalations.list().filter((e) => e.kind === "officer"); assert.equal(officer.length, 1); assert.equal(officer[0]!.payload.notify, "title_underwriter");
  assert.equal((b.rt.store.get("fundings", "F-1")!.data as { status: string }).status, "pending_conditions");
  assert.equal(h.ofType("funding.wire.prepared").length, 0); assert.equal(b.rt.store.list("funding_wires").length, 0);
});

test("26.3-T14: Given the hazard policy's effective date is Nov 12 and funding slips to Nov 13, when `SM_O73_DATE_RESYNC` runs, then `FC_HAZARD_EVIDENCE` still passes (effective ≤ disbursement), prepaid interest becomes 18 × $93.97 = $1,691.46, the 24.4 payoff good-through is re-tested, and 25.2 is asked whether a corrected CD is due.", () => {
  const h = harness("2026-11-12T20:00:00.000Z");
  const f = fixtureFunding();
  assert.equal(f.scheduled_funding_date, "2026-11-12"); assert.equal(f.interest.prepaid_interest_cents, 178_543n);
  const r = resyncDates(h.events, f, { new_date: D("2026-11-13"), at: "2026-11-12T20:00:00.000Z", reason: "bank OFAC hold cleared after the 13:00 ET cutoff", hazard: { hazard_status: "verified", effective_date: D("2026-11-12"), transaction_type: "refinance", policy_in_force: true }, payoffs: [{ liability_id: "L-PRIOR", status: "received", good_through_date: D("2026-11-13") }], consummated_cd: { disbursement_date: D("2026-11-12"), prepaid_interest_cents: 178_543n } });
  assert.equal(r.hazard.status, "pass"); assert.equal(r.payoff.status, "pass"); assert.equal(r.first_payment_gate.open, true);
  assert.equal(r.funding.scheduled_funding_date, "2026-11-13"); assert.equal(r.funding.interest.prepaid_days, 18); assert.equal(r.funding.interest.prepaid_interest_cents, 169_146n);   // 18 × $93.97 = $1,691.46
  assert.equal(r.funding.interest.first_payment_date, "2027-01-01"); assert.equal(r.funding.interest.first_payment_latest_allowed_date, "2027-01-13"); assert.equal(r.held, false);
  assert.equal(r.corrected_cd_review.asked, true); assert.deepEqual(r.corrected_cd_review.reasons, ["CD Disbursement Date 2026-11-12 → 2026-11-13", "CD prepaid interest 178543 → 169146 cents"]);
  const resynced = h.ofType("funding.date.resynced"); assert.equal(resynced.length, 1);
  assert.equal(resynced[0]!.payload.old, "2026-11-12"); assert.equal(resynced[0]!.payload.new, "2026-11-13"); assert.equal(resynced[0]!.payload.hazard, "pass"); assert.equal(resynced[0]!.payload.payoff_good_through, "pass"); assert.equal(resynced[0]!.payload.corrected_cd_review_requested, true);
  assert.equal(h.ofType("funding.corrected_cd.review_requested")[0]!.payload.to_process, "25.2");
  assert.equal(h.timer("SM_O73_DATE_RESYNC")?.status, "satisfied");
  // a payoff good only through Nov 12 fails the re-test and holds a funding that was already authorized
  const stale = resyncDates(h.events, { ...f, status: "authorized", prior_status: "conditions_met" }, { new_date: D("2026-11-13"), at: "2026-11-12T20:05:00.000Z", reason: "slip", hazard: { hazard_status: "verified", effective_date: D("2026-11-12"), transaction_type: "refinance", policy_in_force: true }, payoffs: [{ liability_id: "L-PRIOR", status: "received", good_through_date: D("2026-11-12") }] });
  assert.equal(stale.payoff.status, "fail"); assert.equal(stale.held, true); assert.equal(stale.funding.status, "held"); assert.equal(stale.funding.hold_reason, "payoff_good_through_stale");
  // a hazard policy effective after the slipped date fails FC_HAZARD_EVIDENCE
  const late = resyncDates(h.events, f, { new_date: D("2026-11-13"), at: "2026-11-12T20:06:00.000Z", reason: "slip", hazard: { hazard_status: "verified", effective_date: D("2026-11-14"), transaction_type: "refinance", policy_in_force: true } });
  assert.equal(late.hazard.status, "fail");
});

test("26.3 worked figures: fixture refinance, month-roll, interest-credit, Thanksgiving and wet-purchase examples reproduce the spec's arithmetic", () => {
  // example 1 / rule 2: $560,000.00 at 6.125 % — $34,300.00 per year; $93.97 per day; Nov 12–30 = 19 days → $1,785.43 (not the unrounded $1,785.48)
  const p = computePerDiem(56_000_000n, "6.125", D("2026-11-12"));
  assert.equal(p.annual_interest_cents, 3_430_000n); assert.equal(p.per_diem_cents, 9_397n); assert.equal(p.prepaid_interest_cents, 178_543n); assert.equal(p.unrounded_product_cents, 178_548n);
  // rule 4: gross $560,000.00 − prepaid $1,785.43 − escrow $1,665.00 + lender credit $700.00 = net wire $557,249.57; advance 98 % = $548,800.00; partner contribution $8,449.57
  const ws = buildFundingWorksheet({ funding_id: "F", version: 1, cd_version: 1, gross_loan_cents: 56_000_000n, prepaid_interest_cents: 178_543n, escrow_deposit_cents: 166_500n, lender_credits_cents: 70_000n });
  assert.equal(ws.net_wire_cents, 55_724_957n);
  const split = fundingLedgerLines({ gross_loan_cents: 56_000_000n, net_wire_cents: ws.net_wire_cents, loan_ref: "F" }).split;
  assert.equal(split.advance_cents, 54_880_000n); assert.equal(split.partner_contribution_cents, 844_957n);
  const informational = buildFundingWorksheet({ funding_id: "F", version: 2, cd_version: 1, gross_loan_cents: 56_000_000n, prepaid_interest_cents: 178_543n, escrow_deposit_cents: 166_500n, lender_credits_cents: 70_000n, informational: [{ line_code: "PAYOFF_PRIOR_LIEN", description: "payoff to the prior servicer (illustrative)", amount_cents: 53_821_460n }] });
  assert.equal(informational.net_wire_cents, 55_724_957n); assert.equal(informational.lines.find((l) => l.line_code === "PAYOFF_PRIOR_LIEN")!.amount_cents, 53_821_460n);   // $538,214.60 disbursed by the agent from gross funds
  // example 2: Dec 3 prepaid = 29 × $93.97 = $2,725.13; interest credit 2 × $93.97 = $187.94; Dec 15 → 17 × $93.97 = $1,597.49
  assert.equal(computePerDiem(56_000_000n, "6.125", D("2026-12-03")).prepaid_interest_cents, 272_513n);
  assert.equal(decideInterestMode({ disbursement_date: D("2026-12-03"), gross_loan_cents: 56_000_000n, note_rate_pct: "6.125", borrower_elected_credit: true }).interest_credit_cents, 18_794n);
  assert.equal(computePerDiem(56_000_000n, "6.125", D("2026-12-15")).prepaid_interest_cents, 159_749n);
  // example 3: net wire with the interest credit = $557,249.57 + $1,785.43 + $187.94 = $559,222.94
  assert.equal(buildFundingWorksheet({ funding_id: "F", version: 1, cd_version: 1, gross_loan_cents: 56_000_000n, prepaid_interest_cents: 0n, interest_credit_cents: 18_794n, escrow_deposit_cents: 166_500n, lender_credits_cents: 70_000n }).net_wire_cents, 55_922_294n);
  assert.equal(55_724_957n + 178_543n + 18_794n, 55_922_294n);
  // example 4 / INT-O6-6: the Feb 1 alternative — 31 days × $93.97 = $2,913.07 under this convention ($2,913.15 exact × days, not used)
  const dec1 = computePerDiem(56_000_000n, "6.125", D("2026-12-01")); assert.equal(dec1.prepaid_interest_cents, 291_307n); assert.equal(dec1.unrounded_product_cents, 291_315n);
  // example 5: $412,000.00 at 6.375 % — $71.96 per day; Nov 18–30 = 13 days → $935.48; net $412,000.00 − $935.48 − $1,240.00 + $0.00 = $409,824.52; advance $403,760.00; a Nov 19 disbursement = 12 × $71.96 = $863.52 (25.4's unrounded $863.51)
  const oh = computePerDiem(41_200_000n, "6.375", D("2026-11-18")); assert.equal(oh.per_diem_cents, 7_196n); assert.equal(oh.prepaid_interest_cents, 93_548n);
  const ohWs = buildFundingWorksheet({ funding_id: "F-OH", version: 1, cd_version: 1, gross_loan_cents: 41_200_000n, prepaid_interest_cents: 93_548n, escrow_deposit_cents: 124_000n, lender_credits_cents: 0n });
  assert.equal(ohWs.net_wire_cents, 40_982_452n); assert.equal(fundingLedgerLines({ gross_loan_cents: 41_200_000n, net_wire_cents: ohWs.net_wire_cents, loan_ref: "F-OH" }).split.advance_cents, 40_376_000n);
  const nov19 = computePerDiem(41_200_000n, "6.375", D("2026-11-19")); assert.equal(nov19.prepaid_interest_cents, 86_352n); assert.equal(nov19.unrounded_product_cents, 86_351n);
  // rule 5 partner mirror: debits 56,070,000 = credits 54,880,000 + 844,957 + 178,543 + 166,500
  const mirror = partnerMirrorLines({ gross_loan_cents: 56_000_000n, lender_credits_cents: 70_000n, prepaid_interest_cents: 178_543n, escrow_deposit_cents: 166_500n, net_wire_cents: 55_724_957n, loan_ref: "F" });
  assert.equal(mirror.balanced, true); assert.equal(mirror.lines.filter((l) => l.amount_cents > 0n).reduce((a, l) => a + l.amount_cents, 0n), 56_070_000n);
  // T14: an 18-day slip = $1,691.46
  assert.equal(computePerDiem(56_000_000n, "6.125", D("2026-11-13")).prepaid_interest_cents, 169_146n);
  const strings = ["$93.97", "$1,785.43", "$1,785.48", "$34,300.00", "$557,249.57", "$548,800.00", "$8,449.57", "$1,665.00", "$700.00", "$187.94", "$559,222.94", "$2,725.13", "$1,597.49", "$2,913.07", "$2,913.15", "$71.96", "$935.48", "$863.51", "$863.52", "$1,240.00", "$403,760.00", "$409,824.52", "$538,214.60"];
  assert.equal(new Set(strings).size, strings.length);
});
