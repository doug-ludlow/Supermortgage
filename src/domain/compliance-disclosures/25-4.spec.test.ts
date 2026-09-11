// 25.4 Other closing-time and immediate post-closing consumer notices: initial escrow statement delivery, escrow elections and state escrow-waiver disclosures, the §1026.39 notice of ownership transfer (Fannie Mae's practice), GLBA privacy gate, first-payment letter and autopay enrollment, HPA and flood cross-references, state post-closing notices, IRS Form 1098 seeding, and the closing-day notice run
// spec/sections/25-compliance-testing-the-closing-disclosure-rescission-and-clo/25-4-other-closing-time-and-immediate-post-closing-consumer-notic.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import type { NoticeRegistry } from "../../notices/registry.ts";
import { runInitialAnalysis, approveInitialAnalysis, deliverStatementAtSettlement, type EscrowLine30, type InitialAnalysis30 } from "../orig-boarding/ops-30-3.ts";
import { firstPaymentLetterChecklist, type FirstPaymentLetterPayload } from "../orig-boarding/ops-30-2.ts";
import { verifyInitialStatementEvidence } from "../escrow/ops-3-1.ts";
import { form1098Cycle } from "../notices/ops.ts";
import { MODEL_B1 } from "../../notices/authored/section08.ts";
import { composeClosingPackage, deliverPackage, recordPackageEvidence, runCdEscrowConsistency, evaluateEscrowWaiver, recordEscrowElection, renderStateEscrowNotice, utReserveOptionsGate, caImpoundStmtGate, ca2954Applies, interestOnEscrowRequired, checkPrivacyNotice, firstPaymentLetterDeadlines, firstPaymentLetterPayload, validateFirstPaymentLetterAutopay, firstPaymentLetterAmount, schedulePostClosingRun, completePostClosingRun,
  evaluateOwnershipTransfer, ownershipNoticeDueDate, renderOwnershipNotice, sendOwnershipNotice, recordBorrowerReport, seedTaxReporting, handoffTaxReportingSeeds, prepaidInterestCents, perDiemCentsUnrounded, pointsSeed, paymentAddressAtClosing, checkJurisdiction, closingPackageGate, money, NTC, TIMER,
  type ComposeInput, type BorrowerPrivacyFact, type EscrowElection, type ClosingNoticeRun } from "./ops-25-4.ts";
import { EVALUATORS_25_4 } from "./evaluators-25-4.ts";

const AGENT: Actor = { kind: "agent", id: "disclosure" };
const FNMA: Actor = { kind: "external", id: "fnma" };
const FUNDING: Actor = { kind: "agent", id: "funding" };
const APP = "APP-REFI-1"; const LOAN = "LN-REFI-1"; const PURCHASE_APP = "APP-PURCH-1"; const PURCHASE_LOAN = "LN-PURCH-1";
/** Refinance fixture: consummation Fri Nov 6, 2026 10:00 MST (17:00Z); disbursement Thu Nov 12; purchase Thu Nov 19; first payment Fri Jan 1, 2027; P&I $3,402.62. */
const CONSUMMATION_AT = "2026-11-06T17:00:00.000Z"; const CONSUMMATION_ON = D("2026-11-06"); const DISBURSEMENT = D("2026-11-12"); const FIRST_PAYMENT = D("2027-01-01"); const PI_CENTS = 340_262n;

function harness(now = "2026-11-04T17:00:00.000Z", processes: readonly string[] = ["25.4"], defaults: { loanId?: string; applicationId?: string } = {}) {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock, defaults);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes });
  const escalations = new EscalationService(events, clock);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (t: string) => events.ofType(t);
  return { clock, events, timers, escalations, timer, ofType };
}
let registryCache: NoticeRegistry | null = null;
const registry = (): NoticeRegistry => { if (!registryCache) { registryCache = buildRegistry(); publishAuthored(registryCache); } return registryCache; };
const renderCode = (code: string, payload: Record<string, unknown>) => { const v = registry().activeVersion(code, D("2026-11-06"))!; assert.ok(v, `${code} has an active authored version`); const r = render(v.source, payload); return { v, r, checklist: evaluateChecklist(v, payload, r) }; };

/** Worked example 3 lines: Arizona taxes $4,800.00 payable $2,400.00 on Mar 1 and Oct 1; hazard $1,500.00 renewing Nov 1; computation year Jan–Dec 2027. */
const bill = (amount_cents: bigint, on: string, reference: string) => ({ amount_cents, due_on: D(on), penalty_on: D(on), discount_by: null, scheduled_pay_date: D(on), status: "projected" as const, reference });
const EXAMPLE_3_LINES: EscrowLine30[] = [
  { line_type: "tax_county", source: "origination", estimate_basis: "known_bill", payee_reference: "Maricopa County Treasurer", frequency: "semiannual", installment_count: 2, estimated_annual_cents: 480_000n, terminates_on: null, effective_from: D("2027-01-01"), active: true, escrowed: true, bills: [bill(240_000n, "2027-03-01", "T1"), bill(240_000n, "2027-10-01", "T2")], disbursement_date_basis: "scheduled_pay_date" },
  { line_type: "hazard", source: "origination", estimate_basis: "quote", payee_reference: "Desert Mutual", frequency: "annual", installment_count: 1, estimated_annual_cents: 150_000n, terminates_on: null, effective_from: D("2027-01-01"), active: true, escrowed: true, bills: [bill(150_000n, "2027-11-01", "H1")], disbursement_date_basis: "scheduled_pay_date" },
];
/** 30.3's initial analysis for the refinance fixture, approved on `approvedOn` (the escrow figures every 25.4 test reads: $525.00 / $1,050.00 / $1,875.00). */
function approvedAnalysis(events: MemoryEventStore, approvedOn: PlainDate): InitialAnalysis30 {
  const a = runInitialAnalysis(events, { application_id: APP, analysis_id: "EA-REFI-1", lines: EXAMPLE_3_LINES, first_payment_date: FIRST_PAYMENT, settlement_date: CONSUMMATION_ON, disbursement_date: DISBURSEMENT, as_of: approvedOn, pi_cents: PI_CENTS });
  approveInitialAnalysis(events, a, { approved_on: approvedOn }); a.status = "approved";
  return a;
}
const BORROWERS: BorrowerPrivacyFact[] = [{ borrower_id: "B-1", privacy_delivered_at: "2026-10-05T16:00:00.000Z", customer: true }, { borrower_id: "B-2", privacy_delivered_at: "2026-10-05T16:00:00.000Z", customer: true }];
function composeInput(a: InitialAnalysis30 | null, approvedOn: PlainDate | null, over: Partial<ComposeInput> = {}): ComposeInput {
  return { application_id: APP, loan_id: null, run_id: "RUN-REFI-1", agent_run_id: "AR-1", now: CONSUMMATION_AT, consummation_at: CONSUMMATION_AT, property_state: "AZ", transaction_type: "refinance",
    cd: { disclosure_id: "CD-REFI-3", cd_version: 3, status: "consummation_ready", escrow: { initial_escrow_payment_cents: 187_500n, monthly_escrow_cents: 52_500n, escrowed_costs_year1_cents: 630_000n } },
    escrow_analysis: a ? { analysis: a, approved_on: approvedOn, rendered_document_id: "DOC-ESCROW-STMT-1" } : null, escrow_election: null, borrowers: BORROWERS, hpa: null, flood_ack_required: false, ...over };
}
/** 26.2's `closing.scheduled` for the fixture — arms the four consummation gates and the escrow-statement policy target. */
const scheduleClosing = (h: ReturnType<typeof harness>, applicationId = APP, at = CONSUMMATION_AT) => h.events.append({ type: "closing.scheduled", applicationId, actor: { kind: "agent", id: "closing" }, payload: { application_id: applicationId, source: "origination", closing_id: "CLS-1", scheduled_at: at, consummation_at: at, transaction_type: "refinance" } });
const manifestFor = (run: ClosingNoticeRun, at: string) => run.items.filter((x) => x.in_package).map((x) => ({ notice_code: x.notice_code, delivered_at: at, receipt_evidence: "esign_session" as const, document_id: x.rendered_document_id ?? `DOC-${x.notice_code}` }));

test("25.4-T1: Given the refinance fixture with 30.3's initial analysis approved Wed Nov 4, 2026 (monthly escrow $525.00, cushion $1,050.00, initial deposit $1,875.00), when `composeClosingPackage` runs for the Fri Nov 6 closing, then the package contains the initial escrow statement, `escrow_accounts.initial_statement_delivered_at = 2026-11-06` after the signing manifest is captured, and servicing 3.1's evidence check returns `satisfied_by_originator`.", () => {
  const h = harness(); scheduleClosing(h);
  const a = approvedAnalysis(h.events, D("2026-11-04"));
  assert.equal(a.base_payment_cents, 52_500n); assert.equal(a.cushion_cents, 105_000n); assert.equal(a.target_at_start_cents, 187_500n);
  assert.equal(h.timer(TIMER.escrow_stmt)?.status, "armed", "closing.scheduled armed the policy target");
  const run = composeClosingPackage(h.events, composeInput(a, D("2026-11-04")));
  assert.equal(run.status, "gated"); assert.equal(run.escrow_statement?.decision, "in_package"); assert.equal(run.escrow_statement?.latest_approval_on, "2026-11-05");
  const stmt = run.items.find((x) => x.notice_code === NTC.initial_escrow_stmt)!; assert.equal(stmt.in_package, true); assert.equal(stmt.required, true); assert.equal(stmt.owner_process, "3.1");
  assert.equal(run.consistency?.result, "match"); assert.equal(h.timer(TIMER.package_gate)?.status, "satisfied", "notice.closing_package.composed{status=gated}");
  h.clock.set("2026-11-06T17:30:00.000Z");
  const delivered = deliverPackage(h.events, run, { channel: "signing_session", session_id: "RON-1", delivered_at: "2026-11-06T17:30:00.000Z" });
  assert.equal(delivered.items.find((x) => x.notice_code === NTC.initial_escrow_stmt)?.receipt_evidence, null, "delivery alone marks nothing delivered");
  const ev = recordPackageEvidence(h.events, delivered, { manifest: manifestFor(delivered, "2026-11-06T18:05:00.000Z"), manifest_document_id: "DOC-MANIFEST-1" });
  assert.equal(ev.run.status, "evidenced"); assert.deepEqual(ev.missing_required, []);
  assert.deepEqual(ev.escrow_account, { initial_statement_delivered_at: "2026-11-06", initial_statement_document_id: "DOC-ESCROW-STMT-1", initial_statement_delivery_basis: "at_settlement" });
  assert.equal(ev.escrow_statement_sent?.type, "escrow.statement.sent"); assert.equal(ev.escrow_statement_sent?.payload.channel, "closing_package"); assert.equal(ev.escrow_statement_sent?.payload.statement_type, "initial");
  assert.equal(h.timer(TIMER.escrow_stmt)?.status, "satisfied", "3.1's event closes 25.4's policy target on day 0");
  // servicing 3.1 at boarding (Nov 12): the boarding file carries the document and a delivery date ≤ settlement + 45
  const check = verifyInitialStatementEvidence(h.events, { loan_id: LOAN, settlement_date: CONSUMMATION_ON, boarded_on: DISBURSEMENT, evidence: { document_id: ev.escrow_account!.initial_statement_document_id, delivered_on: ev.escrow_account!.initial_statement_delivered_at } }, { kind: "agent", id: "escrow" });
  assert.equal(check.status, "satisfied_by_originator"); assert.equal(check.timer, null);
});

test("25.4-T2: Given the same fixture but the analysis approved only on Fri Nov 6 at 08:00, then the statement is not in the package, `SM_O64_INITIAL_ESCROW_STMT_AT_SETTLEMENT` records `deferred`, and 3.1's `REGX_1024_17G_INITIAL_STMT_45` is due Mon Dec 21, 2026.", () => {
  const h = harness("2026-11-06T15:00:00.000Z", ["25.4", "3.1"]); scheduleClosing(h);
  const a = approvedAnalysis(h.events, D("2026-11-06"));   // approved Fri Nov 6 08:00 MST — less than 1 creditor business day before consummation (latest Thu Nov 5)
  const run = composeClosingPackage(h.events, composeInput(a, D("2026-11-06")));
  assert.equal(run.status, "gated", "the package still gates; only the statement drops out");
  assert.equal(run.escrow_statement?.decision, "deferred"); assert.equal(run.escrow_statement?.latest_approval_on, "2026-11-05"); assert.equal(run.escrow_statement?.fallback_due_on, "2026-12-21");
  const stmt = run.items.find((x) => x.notice_code === NTC.initial_escrow_stmt)!; assert.equal(stmt.in_package, false); assert.equal(stmt.required, false); assert.match(stmt.after_closing ?? "", /2026-12-21/);
  const decision = h.ofType("escrow.statement.package_decision").at(-1)!; assert.equal(decision.payload.timer, TIMER.escrow_stmt); assert.equal(decision.payload.decision, "deferred"); assert.equal(decision.payload.fallback_due_on, "2026-12-21");
  assert.equal(h.timer(TIMER.escrow_stmt)?.status, "armed", "the policy target is not satisfied — no statement.sent at settlement");
  // the fallback: 30.3 raises 3.1's `escrow.initial_statement.required{reason=settlement}` at consummation without the package send
  const d = deliverStatementAtSettlement(h.events, { application_id: APP, settlement_date: CONSUMMATION_ON, in_package: false });
  assert.equal(d.delivery_basis, "within_45_days"); assert.equal(d.sent, null); assert.equal(d.due_on, "2026-12-21");
  const t = h.timer(TIMER.regx_17g_45)!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2026-12-21");   // Nov 6 → Nov 30 is 24 days; 21 more → Mon Dec 21
  assert.equal(addDays(CONSUMMATION_ON, 45), "2026-12-21");
});

test("25.4-T3: Given the CD shows \"Initial Escrow Payment at Closing\" $1,875.00 and monthly escrow $525.00 but 30.3's approved analysis yields $1,900.00 / $525.00, when the consistency check runs, then `CD_ESCROW_VS_O11_3 = mismatch`, `SM_O64_CLOSING_PACKAGE_NOTICES_GATE` blocks, and 25.2 issues a corrected CD with `cd_reason = pre_consummation_no_wait`.", () => {
  const h = harness(); scheduleClosing(h);
  const cd = { initial_escrow_payment_cents: 187_500n, monthly_escrow_cents: 52_500n, escrowed_costs_year1_cents: 630_000n };
  const drifted = { analysis_id: "EA-REFI-2", target_at_start_cents: 190_000n, base_payment_cents: 52_500n, escrowed_costs_year1_cents: 630_000n };
  const c = runCdEscrowConsistency({ application_id: APP, cd_version: 3, cd, analysis: drifted, now: CONSUMMATION_AT });
  assert.equal(c.check.check_code, "CD_ESCROW_VS_O11_3"); assert.equal(c.result, "mismatch"); assert.equal(c.blocks_gate, true); assert.equal(c.gate, TIMER.package_gate);
  assert.deepEqual(c.variances, [{ field: "initial", cd_cents: 187_500n, analysis_cents: 190_000n }]);
  assert.equal(c.corrected_cd?.process, "25.2"); assert.equal(c.corrected_cd?.cd_reason, "pre_consummation_no_wait");
  const run = composeClosingPackage(h.events, composeInput(null, null, { escrow_analysis: { analysis: drifted, approved_on: D("2026-11-04") } }));
  assert.equal(run.status, "composing"); assert.equal(run.gates[TIMER.package_gate]?.open, false); assert.match(run.gates[TIMER.package_gate]?.reason ?? "", /CD_ESCROW_VS_O11_3 = mismatch.*\$1,875\.00 vs analysis \$1,900\.00.*pre_consummation_no_wait/);
  assert.equal(run.escrow_statement?.decision, "deferred", "a mismatched statement never rides in the package");
  assert.equal(h.timer(TIMER.package_gate)?.status, "armed", "the composed event carries status=composing, not gated");
  assert.equal(EVALUATORS_25_4["25.4.closingPackageGateOpen"]!({ status: "composing", cd_status: "consummation_ready", consistency_result: "mismatch" }).open, false);
  assert.equal(closingPackageGate({ status: "gated", cd_status: "consummation_ready", consistency_result: "match" }).open, true);
  // the corrected CD (25.2, no new waiting period) re-composes and gates
  const fixed = composeClosingPackage(h.events, composeInput(null, null, { run_id: "RUN-REFI-2", cd: { disclosure_id: "CD-REFI-4", cd_version: 4, status: "consummation_ready", escrow: { ...cd, initial_escrow_payment_cents: 190_000n } }, escrow_analysis: { analysis: drifted, approved_on: D("2026-11-04") } }));
  assert.equal(fixed.status, "gated"); assert.equal(fixed.consistency?.result, "match"); assert.equal(h.timer(TIMER.package_gate)?.status, "satisfied");
});

test("25.4-T4: Given `loan.purchased` on Thu Nov 19, 2026 with `date_basis = acquirer_books`, when `evaluateOwnershipTransfer` runs, then `ownership_transfer_notices.due_date = 2026-12-19`, `sender = covered_person_direct`, `status = expected`, no notice is rendered, and `SM_O64_FNMA_1026_39_EVIDENCE_45` is due Sun Jan 3, 2027; given a written Fannie Mae instruction on file, then `sender = servicer_on_behalf` and `REGZ_1026_39_OWNERSHIP_NOTICE_30` is satisfied by a mailing on Fri Dec 18 and breached by a mailing on Mon Dec 21.", () => {
  const purchased = (h: ReturnType<typeof harness>) => h.events.append({ type: "loan.purchased", loanId: LOAN, applicationId: APP, actor: FNMA, payload: { application_id: APP, loan_id: LOAN, source: "origination", purchase_date: "2026-11-19", fnma_loan_number: "1234567890", purchase_advice_id: "PA-1" } });
  const h = harness("2026-11-19T20:00:00.000Z"); purchased(h);
  assert.equal(h.timer(TIMER.ownership_30)?.dueDate, "2026-12-19"); assert.equal(h.timer(TIMER.fnma_evidence_45)?.dueDate, "2027-01-03");
  const r = evaluateOwnershipTransfer(h.events, { application_id: APP, loan_id: LOAN, otn_id: "OTN-1", covered_person: "fannie_mae", date_basis: "acquirer_books", acquisition_date: D("2026-11-19"), as_of: D("2026-11-19") });
  assert.equal(r.row.due_date, "2026-12-19"); assert.equal(r.row.sender, "covered_person_direct"); assert.equal(r.row.status, "expected"); assert.equal(r.row.must_send, false); assert.equal(r.row.evidence_due, "2027-01-03"); assert.equal(r.row.date_of_transfer, "2026-11-19");
  assert.equal(r.event?.type, "ownership_transfer.notice.expected"); assert.equal(r.event?.payload.render_notice, false);
  assert.throws(() => renderOwnershipNotice({ row: r.row, covered_person_contact: { name: "Fannie Mae", address: "1100 15th St NW, Washington DC 20005", phone: "(800) 232-6643", source: "fnma_written_instruction" }, agent: { name: "Supermortgage", address: "PO Box 1, Testville TX 75001", phone: "(800) 555-0100", email: "help@supermortgage.example", portal_url: "portal.supermortgage.example", on_behalf_of: "Partner Bank, N.A." }, mers_registered: true, county_recorder: "Maricopa County Recorder", borrower_names: ["Alex Rivera"], property_address: "4821 E Camelback Rd, Phoenix AZ 85018", loan_number: "1000000016" }), /no fallback notice/, "no notice is rendered while Fannie Mae sends its own letter");
  assert.equal(h.timer(TIMER.ownership_30)?.status, "armed", "informational — Fannie Mae sends; the row stays expected");
  // written Fannie Mae instruction on file → SM sends on Fannie Mae's behalf; Fri Dec 18 is on time
  const h2 = harness("2026-11-19T20:00:00.000Z"); purchased(h2);
  const s = evaluateOwnershipTransfer(h2.events, { application_id: APP, loan_id: LOAN, otn_id: "OTN-2", covered_person: "fannie_mae", acquisition_date: D("2026-11-19"), as_of: D("2026-11-19"), written_fnma_instruction_on_file: true });
  assert.equal(s.row.sender, "servicer_on_behalf"); assert.equal(s.row.must_send, true); assert.equal(s.row.send_scheduled_on, "2026-12-18");
  const rendered = renderOwnershipNotice({ row: s.row, written_fnma_instruction_on_file: true, covered_person_contact: { name: "Fannie Mae", address: "1100 15th St NW, Washington DC 20005", phone: "(800) 232-6643", source: "fnma_written_instruction" }, agent: { name: "Supermortgage", address: "PO Box 1, Testville TX 75001", phone: "(800) 555-0100", email: "help@supermortgage.example", portal_url: "portal.supermortgage.example", on_behalf_of: "Partner Bank, N.A." }, mers_registered: true, county_recorder: "Maricopa County Recorder", borrower_names: ["Alex Rivera"], property_address: "4821 E Camelback Rd, Phoenix AZ 85018", loan_number: "1000000016" });
  assert.equal(rendered.send_by, "2026-12-19"); assert.equal(rendered.payload.covered_person_name, "Fannie Mae");
  const sent = sendOwnershipNotice(h2.events, { application_id: APP, loan_id: LOAN, row: s.row, notice_id: "N-OTN-2", sent_on: D("2026-12-18"), channel: "mail" });
  assert.equal(sent.on_time, true); assert.equal(sent.row.status, "sent"); assert.equal(h2.timer(TIMER.ownership_30)?.status, "satisfied");
  // a Mon Dec 21 mailing is after the 30th calendar day (Sat Dec 19)
  const h3 = harness("2026-11-19T20:00:00.000Z"); purchased(h3);
  const late = evaluateOwnershipTransfer(h3.events, { application_id: APP, loan_id: LOAN, otn_id: "OTN-3", covered_person: "fannie_mae", acquisition_date: D("2026-11-19"), as_of: D("2026-11-19"), written_fnma_instruction_on_file: true });
  h3.clock.set("2026-12-21T15:00:00.000Z"); const breaches = h3.timers.evaluate("2026-12-21T15:00:00.000Z");
  assert.ok(breaches.some((b) => b.instance.code === TIMER.ownership_30)); assert.deepEqual(breaches.find((b) => b.instance.code === TIMER.ownership_30)!.escalateTo, ["officer"]);
  const lateSend = sendOwnershipNotice(h3.events, { application_id: APP, loan_id: LOAN, row: late.row, notice_id: "N-OTN-3", sent_on: D("2026-12-21"), channel: "mail" });
  assert.equal(lateSend.on_time, false); assert.equal(h3.timer(TIMER.ownership_30)?.status, "satisfied_late");
});

test("25.4-T5: Given purchase on Wed Nov 25, 2026, then `due_date = 2026-12-25` (no holiday adjustment); given the warehouse facility takes an assignment at funding on Thu Nov 12 and the loan is purchased Nov 19, then `covered_person = sm_warehouse_assignee` with `status = exception_c1`; given the loan is still unsold on Sat Dec 12, then `REGZ_1026_39_OWNERSHIP_NOTICE_30` requires `NTC_REGZ_1026_39_OWNERSHIP_TRANSFER` sent by that day with (d)(4) \"has not been recorded in public records\" and (d)(5) alternative (ii).", () => {
  const h = harness("2026-11-25T20:00:00.000Z");
  assert.equal(ownershipNoticeDueDate(D("2026-11-25")), "2026-12-25");   // Christmas Day — a calendar-day rule
  const xmas = evaluateOwnershipTransfer(h.events, { application_id: PURCHASE_APP, loan_id: PURCHASE_LOAN, otn_id: "OTN-P1", covered_person: "fannie_mae", acquisition_date: D("2026-11-25"), as_of: D("2026-11-25"), written_fnma_instruction_on_file: true });
  assert.equal(xmas.row.due_date, "2026-12-25"); assert.equal(xmas.row.send_scheduled_on, "2026-12-24", "spec text says Wed Dec 23; the servicer calendar's last business day before the Fri Dec 25 due date is Thu Dec 24 (Christmas Eve is not a servicer closure) — discrepancy reported");
  // assignment structure: SM acquires legal title at funding Nov 12; sold to Fannie Mae Nov 19 (7 days) → (c)(1)
  const c1 = evaluateOwnershipTransfer(h.events, { application_id: APP, loan_id: LOAN, otn_id: "OTN-W1", covered_person: "sm_warehouse_assignee", warehouse_legal_form: "assignment_at_funding", acquisition_date: D("2026-11-12"), sold_on: D("2026-11-19"), as_of: D("2026-11-19") });
  assert.equal(c1.row.covered_person, "sm_warehouse_assignee"); assert.equal(c1.row.status, "exception_c1"); assert.equal(c1.row.must_send, false); assert.equal(c1.row.due_date, "2026-12-12");
  // still unsold on Sat Dec 12 → SM must send by day 30
  const unsold = evaluateOwnershipTransfer(h.events, { application_id: APP, loan_id: LOAN, otn_id: "OTN-W2", covered_person: "sm_warehouse_assignee", warehouse_legal_form: "assignment_at_funding", acquisition_date: D("2026-11-12"), sold_on: null, as_of: D("2026-12-12") });
  assert.equal(unsold.row.status, "expected"); assert.equal(unsold.row.must_send, true); assert.equal(unsold.row.send_scheduled_on, "2026-12-12"); assert.equal(unsold.event?.payload.template, NTC.ownership_transfer);
  const n = renderOwnershipNotice({ row: unsold.row, covered_person_contact: { name: "Supermortgage Warehouse Lending LLC", address: "1 Supermortgage Way, Testville TX 75001", phone: "(800) 555-0100", source: "sm_legal_entity", web: "supermortgage.example" }, agent: { name: "Supermortgage", address: "PO Box 1, Testville TX 75001", phone: "(800) 555-0100", email: "help@supermortgage.example", portal_url: "portal.supermortgage.example", on_behalf_of: "Partner Bank, N.A." }, mers_registered: true, county_recorder: "Maricopa County Recorder", borrower_names: ["Alex Rivera"], property_address: "4821 E Camelback Rd, Phoenix AZ 85018", loan_number: "1000000016" });
  assert.equal(n.template, NTC.ownership_transfer); assert.equal(n.send_by, "2026-12-12");
  assert.match(String(n.payload.recording_statement), /has not been recorded in public records at the time this notice is provided/); assert.equal(n.payload.partial_payment_policy, "ii"); assert.match(String(n.payload.partial_payment_text), /hold partial payments in a separate account/);
  const { r, checklist } = renderCode(NTC.ownership_transfer, { ...n.payload, days_to_due: 30 });
  assert.equal(checklist.passed, true, checklist.blocking.map((b) => b.rule_id).join(", "));
  assert.match(r.text, /Date of transfer: November 12, 2026/); assert.match(r.text, /has not been recorded in public records/); assert.match(r.text, /If this loan is sold, your new lender may have a different policy/);
  // the secured-loan legal form (31.1/27.1 decision) makes SM a security-interest holder, never a covered person
  const secured = evaluateOwnershipTransfer(h.events, { application_id: APP, loan_id: LOAN, otn_id: "OTN-W3", covered_person: "sm_warehouse_assignee", warehouse_legal_form: "secured_loan_to_partner", acquisition_date: D("2026-11-12"), as_of: D("2026-12-12") });
  assert.equal(secured.row.status, "not_applicable"); assert.equal(secured.event, null);
});

test("25.4-T6: Given the privacy notice evidenced Mon Oct 5, 2026 for both borrowers, then `GLBA_1016_4_INITIAL_PRIVACY_GATE` is open; given no evidence for the co-borrower, then the gate blocks until `NTC_GLBA_1016_4_PRIVACY_INITIAL` is added to the package and acknowledged at signing on Nov 6.", () => {
  const open = checkPrivacyNotice(BORROWERS, CONSUMMATION_AT);
  assert.equal(open.result, "open"); assert.deepEqual(open.missing_borrower_ids, []); assert.equal(open.insert_into_package, false);
  assert.equal(EVALUATORS_25_4["25.4.privacyGateOpen"]!({ borrowers: BORROWERS, consummation_at: CONSUMMATION_AT }).open, true);
  const noCo: BorrowerPrivacyFact[] = [BORROWERS[0]!, { borrower_id: "B-2", privacy_delivered_at: null, customer: true }];
  const blocked = checkPrivacyNotice(noCo, CONSUMMATION_AT);
  assert.equal(blocked.result, "blocked"); assert.deepEqual(blocked.missing_borrower_ids, ["B-2"]); assert.equal(blocked.insert_into_package, true);
  assert.match(EVALUATORS_25_4["25.4.privacyGateOpen"]!({ borrowers: noCo, consummation_at: CONSUMMATION_AT }).reason ?? "", /B-2/);
  const h = harness(); scheduleClosing(h);
  const a = approvedAnalysis(h.events, D("2026-11-04"));
  const run = composeClosingPackage(h.events, composeInput(a, D("2026-11-04"), { borrowers: noCo }));
  assert.equal(run.status, "composing"); assert.equal(run.gates[TIMER.privacy_gate]?.open, false);
  const priv = run.items.find((x) => x.notice_code === NTC.privacy_initial)!; assert.equal(priv.required, true); assert.equal(priv.in_package, true); assert.equal(priv.owner_process, "21.3"); assert.equal(priv.gate, TIMER.privacy_gate);
  assert.equal(h.timer(TIMER.privacy_gate)?.status, "armed");
  // acknowledged at signing on Nov 6 → the gate opens
  const gated: ClosingNoticeRun = { ...run, status: "gated" };   // the other gates are open; the privacy item is the only block
  const delivered = deliverPackage(h.events, gated, { channel: "signing_session", session_id: "RON-1", delivered_at: "2026-11-06T17:30:00.000Z" });
  const ev = recordPackageEvidence(h.events, delivered, { manifest: manifestFor(delivered, "2026-11-06T18:00:00.000Z"), manifest_document_id: "DOC-MANIFEST-6", borrowers: noCo });
  assert.equal(ev.privacy_gate?.result, "open"); assert.equal(ev.run.gates[TIMER.privacy_gate]?.open, true);
  assert.equal(h.ofType("privacy.gate.evaluated").at(-1)!.payload.result, "open"); assert.equal(h.timer(TIMER.privacy_gate)?.status, "satisfied");
  // a non-borrower spouse is not a GLBA customer and never blocks the gate
  assert.equal(checkPrivacyNotice([BORROWERS[0]!, { borrower_id: "SPOUSE-1", privacy_delivered_at: null, customer: false }], CONSUMMATION_AT).result, "open");
});

test("25.4-T7: Given funding Thu Nov 12, 2026 and first payment Fri Jan 1, 2027, then `SM_O64_FIRST_PAYMENT_LETTER_5BD` is due Thu Nov 19 and `SM_O64_FIRST_PAYMENT_LETTER_PREDUE_20` on Sat Dec 12; given the purchase fixture funded Thu Nov 19, then the 5-day timer is due Fri Nov 27 (Thanksgiving excluded); a letter template that pre-checks autopay or states enrollment is required fails validation (§1005.10(e)(1)).", () => {
  const d = firstPaymentLetterDeadlines(DISBURSEMENT, FIRST_PAYMENT);
  assert.equal(d.due_5bd, "2026-11-19"); assert.equal(d.predue_20, "2026-12-12"); assert.equal(d.post_closing_run_due, "2026-11-16"); assert.equal(d.send_no_later_than, "2026-11-19");
  assert.equal(firstPaymentLetterDeadlines(D("2026-11-19"), FIRST_PAYMENT).due_5bd, "2026-11-27");   // Fri 20, Mon 23, Tue 24, Wed 25, Thu 26 Thanksgiving excluded, Fri 27
  const h = harness("2026-11-12T20:00:00.000Z");
  h.events.append({ type: "loan.funded", applicationId: APP, actor: FUNDING, payload: { application_id: APP, source: "origination", funding_date: "2026-11-12", disbursement_date: "2026-11-12", first_payment_date: "2027-01-01", funded_at: "2026-11-12T20:00:00.000Z" } });
  assert.equal(h.timer(TIMER.letter_5bd)?.dueDate, "2026-11-19"); assert.equal(h.timer(TIMER.letter_predue_20)?.dueDate, "2026-12-12"); assert.equal(h.timer(TIMER.post_closing_run)?.dueDate, "2026-11-16");
  const run = schedulePostClosingRun(h.events, { application_id: APP, loan_id: LOAN, run_id: "RUN-POST-1", agent_run_id: "AR-2", now: "2026-11-12T20:00:00.000Z", disbursement_date: DISBURSEMENT, first_payment_date: FIRST_PAYMENT, escrow_statement_deferred: false });
  assert.equal(run.scheduled_on, "2026-11-16"); assert.deepEqual(run.items.map((x) => x.notice_code), [NTC.welcome, NTC.first_payment_letter]);
  assert.equal(h.ofType("first_payment_letter.due_computed").at(-1)!.payload.due_5bd, "2026-11-19");
  // 30.2 sends the letter with the post-closing run (Mon Nov 16): both letter clocks close on its notice.sent; the run's completion closes the 2-BD clock
  h.clock.set("2026-11-16T15:00:00.000Z");
  h.events.append({ type: "notice.sent", applicationId: APP, loanId: LOAN, actor: { kind: "agent", id: "boarding" }, payload: { application_id: APP, notice_id: "N-FPL-1", template: NTC.first_payment_letter, party_id: "B-1", channel: "mail_first_class", sent_on: "2026-11-16", via: "registry" } });
  assert.equal(h.timer(TIMER.letter_5bd)?.status, "satisfied"); assert.equal(h.timer(TIMER.letter_predue_20)?.status, "satisfied");
  const done = completePostClosingRun(h.events, run, { completed_on: D("2026-11-16"), sent: [{ notice_code: NTC.welcome, sent_on: D("2026-11-16"), channel: "mail", manifest_id: "MAN-1" }, { notice_code: NTC.first_payment_letter, sent_on: D("2026-11-16"), channel: "mail", manifest_id: "MAN-1" }] });
  assert.equal(done.status, "sent"); assert.equal(h.timer(TIMER.post_closing_run)?.status, "satisfied");
  // the authored template: the fixture letter passes; a template that pre-checks autopay or states enrollment is required fails validation
  const payload = firstPaymentLetterPayload({ partner_name: "Partner Bank, N.A.", servicing_loan_number: "1000000016", property_address: "4821 E Camelback Rd, Phoenix AZ 85018", borrower_names: ["Alex Rivera"], first_payment_date: FIRST_PAYMENT, figures: { pi_cents: PI_CENTS, escrow_cents: 52_500n, mi_cents: 0n }, remittance_address: "PO Box 7, Testville TX 75001", portal_url: "portal.supermortgage.example", servicer_phone: "(800) 555-0100", contact_hours: "Mon–Fri 8am–8pm ET", automation_disclosure: "Our phone and chat assistant is automated; you can ask for a person at any time.", late_charge_pct: "5.000", late_charge_grace_days: 15, escrow_summary: "your escrow account starts with $1,875.00 and collects $525.00 monthly.", initial_escrow_statement_pointer: "See the initial escrow account statement delivered at settlement.", esign_invitation: true, privacy_reference: "Partner Bank, N.A.'s privacy notice was delivered with your application; it continues to apply.", hud_cfpb_block: "Housing counseling: (800) 569-4287 (HUD) / consumerfinance.gov/find-a-housing-counselor.", account_last4: "0016" });
  assert.equal(payload.total_cents, 392_762n);
  const { v, r, checklist } = renderCode(NTC.first_payment_letter, payload);
  assert.equal(checklist.passed, true, checklist.blocking.map((b) => b.rule_id).join(", "));
  assert.match(r.text, /first payment of \$3,927\.62 is due January 1, 2027/); assert.match(r.text, /\(autopay\) are optional/);
  assert.equal(validateFirstPaymentLetterAutopay(r.text, payload).passed, true);
  // 30.2's rule-9 checklist (a)–(m) accepts the registry render
  const p30: FirstPaymentLetterPayload = { servicer_name: "Supermortgage", partner_name: "Partner Bank, N.A.", servicing_loan_number: "1000000016", property_address: "4821 E Camelback Rd, Phoenix AZ 85018", first_payment_date: FIRST_PAYMENT, pi_cents: PI_CENTS, escrow_cents: 52_500n, mi_cents: 0n, total_cents: 392_762n, remittance_address: "PO Box 7, Testville TX 75001", portal_url: "portal.supermortgage.example", ach_enrollment: "autopay optional", servicer_phone: "(800) 555-0100", automation_disclosure: String(payload.automation_disclosure), late_charge_pct: "5.000", late_charge_grace_days: 15, escrow_summary: String(payload.escrow_summary), initial_escrow_statement_pointer: String(payload.initial_escrow_statement_pointer), not_a_transfer_notice: true, b1_text: MODEL_B1, esign_invitation: true, privacy_reference: String(payload.privacy_reference), hud_cfpb_block: String(payload.hud_cfpb_block), acp_or_successor_handling: null, account_last4: "0016" };
  const c30 = firstPaymentLetterChecklist(p30, r.text); assert.equal(c30.passed, true, c30.blocking.map((b) => b.rule_id).join(", "));
  const conditioned = render(v.source.replace(/Automatic payments \(autopay\) are optional\.[^{]*/, "Enrollment in automatic payments is required as a condition of this loan. "), payload);
  const bad = evaluateChecklist(v, payload, conditioned); assert.equal(bad.passed, false); assert.ok(bad.blocking.some((b) => b.rule_id === "rege-1005-10e1-no-condition"));
  assert.ok(validateFirstPaymentLetterAutopay(conditioned.text, payload).violations.some((x) => x.rule_id === "rege-1005-10e1-no-condition"));
  const prechecked = { ...payload, autopay_prechecked: true }; const pc = evaluateChecklist(v, prechecked, render(v.source, prechecked));
  assert.ok(pc.blocking.some((b) => b.rule_id === "rege-1005-10e1-no-precheck")); assert.ok(validateFirstPaymentLetterAutopay(r.text, prechecked).violations.some((x) => x.rule_id === "rege-1005-10e1-no-precheck"));
});

test("25.4-T8: Given a Utah property, escrow requested waived, LTV 70%, when the package is composed, then `NTC_UT_7_17_4_RESERVE_OPTIONS` (both options; \"a reserve account is not required by the lender\"; borrower responsible for taxes and insurance) is delivered at or before closing and `UT_7_17_4_RESERVE_OPTIONS_NOTICE_GATE` opens only when `escrow_elections.elected_at ≤ consummation_at`; given the borrower elects a reserve account at 70% LTV, then `interest_on_escrow_required = true` (7-17-3).", () => {
  const h = harness(); scheduleClosing(h);
  const criteria = { ltv_pct: 70, reserves_months_of_ti: 6, mortgage_lates_30_in_12m: 0, hpml: false, bpmi: false, delinquent_tax_financed_refi: false, flood_required_escrow: false, blanket_policy_unit: false, state: "UT" };
  const waived = evaluateEscrowWaiver({ election_requested: "waived", criteria });
  assert.equal(waived.waivable, true); assert.equal(waived.election, "waived"); assert.deepEqual(waived.state_notice_codes, [NTC.escrow_election, NTC.ut_reserve_options]); assert.equal(waived.interest_on_escrow_required, false); assert.equal(waived.waiver_fee_cents, 0n);
  const ut = renderStateEscrowNotice({ state: "UT", election: "waived", ltv_pct: 70, partner_name: "Partner Bank, N.A.", borrower_names: ["Taylor Young"], property_address: "12 Wasatch Dr, Salt Lake City UT 84101", loan_number: "1000000024" })!;
  assert.equal(ut.code, NTC.ut_reserve_options); assert.equal(ut.required, true); assert.equal(ut.timing, "at_or_prior_to_closing"); assert.equal(ut.gate, TIMER.ut_gate); assert.equal(ut.payload.reserve_required_by_lender, false);
  const { r, checklist } = renderCode(NTC.ut_reserve_options, ut.payload);
  assert.equal(checklist.passed, true, checklist.blocking.map((b) => b.rule_id).join(", "));
  assert.match(r.text, /noninterest-bearing reserve account to be serviced by the lender at no charge/); assert.match(r.text, /manage the payment of insurance premiums, taxes and other charges for your own account/);
  assert.match(r.text, /a reserve account is not required by the lender/i); assert.match(r.text, /legally responsible for the payment of taxes, insurance premiums, and other charges/); assert.match(r.text, /Option 2 — you will pay taxes, insurance premiums and other charges for your own account/);
  // the gate: notice at or before closing AND the election captured at closing
  assert.equal(utReserveOptionsGate({ notice_delivered_on: "2026-11-06", elected_at: "2026-11-06T18:00:00.000Z", consummation_at: "2026-11-06T19:00:00.000Z" }).open, true);
  assert.equal(utReserveOptionsGate({ notice_delivered_on: "2026-11-05", elected_at: "2026-11-06T18:00:00.000Z", consummation_at: "2026-11-06T19:00:00.000Z" }).open, true, "delivered prior to the closing");
  assert.match(utReserveOptionsGate({ notice_delivered_on: "2026-11-06", elected_at: "2026-11-06T19:30:00.000Z", consummation_at: "2026-11-06T19:00:00.000Z" }).reason ?? "", /elected_at .* > consummation_at/);
  assert.match(utReserveOptionsGate({ notice_delivered_on: null, elected_at: "2026-11-06T18:00:00.000Z", consummation_at: "2026-11-06T19:00:00.000Z" }).reason ?? "", /not delivered/);
  assert.equal(EVALUATORS_25_4["25.4.utReserveOptionsGateOpen"]!({ property_state: "UT", notice_delivered_on: "2026-11-06", elected_at: "2026-11-06T18:00:00.000Z", consummation_at: CONSUMMATION_AT }).open, false, "elected after the 17:00Z consummation");
  const election = recordEscrowElection(h.events, { application_id: APP, election_id: "EE-UT-1", evaluation: waived, elected_at: "2026-11-06T16:30:00.000Z", agent_run_id: "AR-8" });
  assert.equal(election.event.type, "escrow.election.recorded"); assert.equal(election.row.interest_on_escrow_required, false);
  const run = composeClosingPackage(h.events, composeInput(null, null, { property_state: "UT", escrow_election: election.row, state_notice: ut, state_notice_delivered_on: D("2026-11-06"), cd: { disclosure_id: "CD-UT-1", cd_version: 2, status: "consummation_ready", escrow: null } }));
  assert.equal(run.status, "gated"); assert.equal(run.gates[TIMER.ut_gate]?.open, true);
  assert.ok(run.items.some((x) => x.notice_code === NTC.ut_reserve_options && x.required && x.in_package)); assert.equal(h.timer(TIMER.ut_gate)?.status, "satisfied");
  // the borrower elects a reserve account at 70% LTV → §7-17-3 interest; at 90% LTV (purchase fixture) no interest until 80%
  const reserve = evaluateEscrowWaiver({ election_requested: "escrow_full", criteria });
  assert.equal(reserve.election, "escrow_full"); assert.equal(reserve.interest_on_escrow_required, true);
  assert.equal(interestOnEscrowRequired("UT", "escrow_full", 90), false); assert.equal(interestOnEscrowRequired("UT", "escrow_full", 70), true);
  assert.equal(renderStateEscrowNotice({ state: "UT", election: "escrow_full", ltv_pct: 70, partner_name: "Partner Bank, N.A.", borrower_names: ["Taylor Young"], property_address: "12 Wasatch Dr, Salt Lake City UT 84101", loan_number: "1000000024" })!.interest_on_escrow_required, true);
});

test("25.4-T9: Given a California single-family owner-occupied purchase at 85% LTV where the borrower elects an impound account, then `NTC_CA_CIV_2954_IMPOUND_STMT` (not required as a condition; interest statement) is required and `CA_CIV_2954_IMPOUND_STMT_GATE` blocks without it; given 90% LTV, then the account may be required under §2954(a)(1) and the notice is still generated as policy.", () => {
  const ca = renderStateEscrowNotice({ state: "CA", election: "escrow_full", ltv_pct: 85, partner_name: "Partner Bank, N.A.", borrower_names: ["Morgan Lee"], property_address: "900 Mission St, San Diego CA 92101", loan_number: "1000000032", single_family_owner_occupied: true, transaction_type: "purchase" })!;
  assert.equal(ca.code, NTC.ca_impound_stmt); assert.equal(ca.required, true); assert.equal(ca.basis, "statute"); assert.equal(ca.account_may_be_required, false); assert.equal(ca.gate, TIMER.ca_gate); assert.equal(ca.payload.required_as_condition, false);
  const { r, checklist } = renderCode(NTC.ca_impound_stmt, ca.payload);
  assert.equal(checklist.passed, true, checklist.blocking.map((b) => b.rule_id).join(", "));
  assert.match(r.text, /shall not be required as a condition of this loan on a single-family, owner-occupied dwelling/); assert.match(r.text, /Interest will not be paid on the funds in the account/);
  assert.match(caImpoundStmtGate({ required: true, statement_delivered_on: null }).reason ?? "", /not delivered/);
  assert.equal(caImpoundStmtGate({ required: true, statement_delivered_on: "2026-11-18", elected_at: "2026-11-18T18:00:00.000Z" }).open, true);
  assert.equal(EVALUATORS_25_4["25.4.caImpoundStmtGateOpen"]!({ property_state: "CA", required: true, statement_delivered_on: null }).open, false);
  const h = harness("2026-11-18T15:00:00.000Z"); scheduleClosing(h, PURCHASE_APP, "2026-11-18T19:00:00.000Z");
  const blocked = composeClosingPackage(h.events, composeInput(null, null, { application_id: PURCHASE_APP, run_id: "RUN-CA-1", consummation_at: "2026-11-18T19:00:00.000Z", property_state: "CA", transaction_type: "purchase", state_notice: ca, state_notice_delivered_on: null, cd: { disclosure_id: "CD-CA-1", cd_version: 2, status: "consummation_ready", escrow: null } }));
  assert.equal(blocked.status, "composing"); assert.equal(blocked.gates[TIMER.ca_gate]?.open, false); assert.equal(h.timer(TIMER.ca_gate)?.status, "armed");
  const gated = composeClosingPackage(h.events, composeInput(null, null, { application_id: PURCHASE_APP, run_id: "RUN-CA-2", consummation_at: "2026-11-18T19:00:00.000Z", property_state: "CA", transaction_type: "purchase", state_notice: ca, state_notice_delivered_on: D("2026-11-18"), cd: { disclosure_id: "CD-CA-1", cd_version: 2, status: "consummation_ready", escrow: null } }));
  assert.equal(gated.gates[TIMER.ca_gate]?.open, true); assert.equal(h.timer(TIMER.ca_gate)?.status, "satisfied");
  // 90% LTV: within (a)(1) — the account may be required; the statement still issues as policy
  const ninety = renderStateEscrowNotice({ state: "CA", election: "escrow_full", ltv_pct: 90, partner_name: "Partner Bank, N.A.", borrower_names: ["Morgan Lee"], property_address: "900 Mission St, San Diego CA 92101", loan_number: "1000000032", single_family_owner_occupied: true })!;
  assert.equal(ninety.required, true); assert.equal(ninety.basis, "policy"); assert.equal(ninety.account_may_be_required, true);
  assert.deepEqual(ca2954Applies({ ltv_pct: 90, single_family_owner_occupied: true, impound_elected: true }), { required: true, basis: "policy", account_may_be_required: true });
  const n90 = renderCode(NTC.ca_impound_stmt, ninety.payload); assert.equal(n90.checklist.passed, true); assert.match(n90.r.text, /90 percent or more of the sale price/);
  assert.equal(ca2954Applies({ ltv_pct: 85, single_family_owner_occupied: false, impound_elected: true }).required, false, "not a single-family owner-occupied dwelling");
});

test("25.4-T10: Given the purchase fixture with BPMI, when the borrower requests an escrow waiver, then `evaluateEscrowWaiver` returns `waivable = false` with reason `bpmi` (B2-1.5-04) and `escrow_elections.election = escrow_full`; given an HPML result from 23.4, reason `hpml`.", () => {
  const h = harness("2026-11-10T15:00:00.000Z");
  const purchase = { ltv_pct: 90, reserves_months_of_ti: 3, mortgage_lates_30_in_12m: 0, hpml: false, bpmi: true, delinquent_tax_financed_refi: false, flood_required_escrow: false, blanket_policy_unit: false, state: "OH" };
  const w = evaluateEscrowWaiver({ election_requested: "waived", criteria: purchase });
  assert.equal(w.waivable, false); assert.equal(w.reason, "bpmi"); assert.ok(w.reasons.includes("bpmi")); assert.equal(w.election, "escrow_full"); assert.match(w.citations[0]!, /B2-1\.5-04/);
  assert.deepEqual(w.state_notice_codes, [NTC.escrow_election], "no Ohio escrow-election statute row");
  const rec = recordEscrowElection(h.events, { application_id: PURCHASE_APP, election_id: "EE-P1", evaluation: w, elected_at: "2026-11-18T19:00:00.000Z", agent_run_id: "AR-10" });
  assert.equal(rec.row.election, "escrow_full"); assert.equal(rec.row.waiver_criteria.bpmi, true); assert.equal(rec.event.payload.mi_flag, true); assert.equal(rec.event.payload.election, "escrow_full");
  const hpml = evaluateEscrowWaiver({ election_requested: "waived", criteria: { ...purchase, ltv_pct: 70, bpmi: false, hpml: true } });
  assert.equal(hpml.waivable, false); assert.equal(hpml.reason, "hpml"); assert.equal(hpml.election, "escrow_full"); assert.match(hpml.citations[0]!, /1026\.35\(b\)\(1\)/);
  // the election record renders through the registry with the non-waivable reason
  const { checklist } = renderCode(NTC.escrow_election, { loan_number: "1000000024", borrower_names: ["Jordan Park", "Casey Park"], property_address: "77 Buckeye Ln, Columbus OH 43215", partner_name: "Partner Bank, N.A.", election: rec.row.election, election_text: "escrow account (escrow_full)", waived: false, waiver_policy_version: rec.row.waiver_policy_version, escrowed_items: "property taxes, homeowner's insurance and borrower-paid mortgage insurance", non_waivable_reason: "bpmi", non_waivable_reason_text: "borrower-paid mortgage insurance premiums cannot be waived (B2-1.5-04)", waiver_fee_cents: 0n, initial_escrow_payment_cents: 187_500n, monthly_escrow_cents: 52_500n, escrowed_costs_year1_cents: 630_000n, interest_statement: "No interest is paid on escrow funds in Ohio.", state_notice_codes: [], elected_at: rec.row.elected_at, elected_at_text: "signing on November 18, 2026" });
  assert.equal(checklist.passed, true, checklist.blocking.map((b) => b.rule_id).join(", "));
});

test("25.4-T11: Given boarding on Thu Nov 12, 2026 for the refinance fixture, then `tax_reporting_seeds` = {origination_date 2026-11-06, principal 56000000, prepaid_interest 178548, points 0, mi_at_closing 0, acquisition_date null} and `SM_O64_1098_SEEDS_AT_BOARDING_GATE` opens; servicing 7.1-A produces a 2026 Form 1098 with Box 1 $1,785.48; given the purchase fixture with 0.500 borrower-paid points on $412,000, then `points_paid_cents = 206000` and prepaid interest $863.51.", () => {
  const h = harness("2026-11-12T22:00:00.000Z");
  h.events.append({ type: "loan.boarded", loanId: LOAN, applicationId: APP, actor: { kind: "agent", id: "boarding" }, payload: { application_id: APP, loan_id: LOAN, source: "origination", boarded_at: "2026-11-12T22:00:00.000Z", funding_date: "2026-11-12", first_payment_date: "2027-01-01" } });
  assert.equal(h.timer(TIMER.seeds_gate)?.status, "armed");
  const seeds = seedTaxReporting({ loan_id: LOAN, note_date: CONSUMMATION_ON, disbursement_date: DISBURSEMENT, first_period_end: D("2026-11-30"), principal_cents: 56_000_000n, note_rate_pct: "6.125", points: { transaction_type: "refinance", principal_cents: 56_000_000n, points_pct: null, borrower_paid_cents: 0n, designated_as_points_on_cd: false, principal_residence: true }, mi_premiums_paid_at_closing_cents: 0n, property_address_id: "PROP-1", payer_of_record_borrower_id: "B-1", source_cd_disclosure_id: "CD-REFI-3" });
  assert.equal(seeds.origination_date, "2026-11-06"); assert.equal(seeds.principal_at_origination_cents, 56_000_000n); assert.equal(seeds.prepaid_interest_cents, 178_548n); assert.equal(seeds.points_paid_cents, 0n); assert.equal(seeds.mi_premiums_paid_at_closing_cents, 0n); assert.equal(seeds.acquisition_date, null);
  assert.deepEqual(seeds.prepaid_interest_period, { from: "2026-11-12", to: "2026-11-30", days: 19 }); assert.equal(seeds.tax_year, 2026);
  const h11 = handoffTaxReportingSeeds(h.events, { application_id: APP, loan_id: LOAN, seeds, handed_off_at: "2026-11-12T22:05:00.000Z" });
  assert.equal(h11.gate_open, true); assert.equal(h11.event.type, "tax_reporting.seeds.handed_off"); assert.equal(h11.event.payload.prepaid_interest_cents, "178548"); assert.equal(h.timer(TIMER.seeds_gate)?.status, "satisfied");
  // servicing 7.1-A: $1,785.48 ≥ $600 received in 2026 and accruing by Dec 31 → the 2026 Form 1098, furnished by Jan 31, 2027
  const f = form1098Cycle({ tax_year: 2026, interest_received_cents: seeds.prepaid_interest_cents, points_cents: 0n, upb_jan1_cents: seeds.principal_at_origination_cents, electronic: false });
  assert.equal(f.box1_cents, 178_548n); assert.equal(f.box2_cents, 56_000_000n); assert.equal(f.furnish_by, "2027-01-31"); assert.equal(f.file_with_irs, true); assert.equal(money(f.box1_cents), "$1,785.48");
  // purchase fixture: 0.500 borrower-paid points on $412,000 = $2,060.00 (Box 6); 12 days × ($412,000 × 0.06375 / 365) = $863.51 (Box 1)
  const p = seedTaxReporting({ loan_id: PURCHASE_LOAN, note_date: D("2026-11-18"), disbursement_date: D("2026-11-19"), first_period_end: D("2026-11-30"), principal_cents: 41_200_000n, note_rate_pct: "6.375", points: { transaction_type: "purchase", principal_cents: 41_200_000n, points_pct: "0.500", borrower_paid_cents: 206_000n, designated_as_points_on_cd: true, principal_residence: true }, mi_premiums_paid_at_closing_cents: 0n, property_address_id: "PROP-2", payer_of_record_borrower_id: "B-P1", source_cd_disclosure_id: "CD-PURCH-2" });
  assert.equal(p.points_paid_cents, 206_000n); assert.equal(p.prepaid_interest_cents, 86_351n); assert.equal(p.prepaid_interest_period.days, 12); assert.equal(p.box6_candidate_cents, 206_000n);
  assert.equal(form1098Cycle({ tax_year: 2026, interest_received_cents: p.prepaid_interest_cents, points_cents: 0n, upb_jan1_cents: 41_200_000n, electronic: false }).box1_cents, 86_351n);
  assert.equal(pointsSeed({ transaction_type: "refinance", principal_cents: 56_000_000n, points_pct: "0.750", borrower_paid_cents: 420_000n, designated_as_points_on_cd: true, principal_residence: true }).points_refinance_excluded_cents, 420_000n, "refinance points are never Box 6");
  assert.equal(pointsSeed({ transaction_type: "purchase", principal_cents: 41_200_000n, points_pct: "0.500", borrower_paid_cents: 0n, seller_paid_cents: 206_000n, designated_as_points_on_cd: true, principal_residence: true }).points_seller_paid_cents, 206_000n, "seller-paid points are treated as paid by the payer of record");
});

test("25.4-T12: Given a partner that names its own payee address at closing, then `loans.payment_address_named_at_closing = false`, servicing 1.3's combined MS-2 notice is included in the package with `delivered_at_settlement = true`, and `REGX_1024_33B3_COMBINED_15` is recorded satisfied at settlement.", () => {
  const pa = paymentAddressAtClosing({ payee_named: "partner_own_address" });
  assert.equal(pa.payment_address_named_at_closing, false); assert.equal(pa.combined_ms2_required, true); assert.equal(pa.template, "NTC_REGX_1024_33B_COMBINED_MS2"); assert.equal(pa.timer, TIMER.combined_ms2_15);
  assert.equal(paymentAddressAtClosing({ payee_named: "sm_as_servicer_for_partner" }).combined_ms2_required, false, "the default: SM named at closing — no §1024.33(b) transfer");
  const h = harness("2026-11-06T15:00:00.000Z", ["25.4", "1.3"]); scheduleClosing(h);
  // 1.3's own clock on the combined run (transfer.batch.approved{notice_mode=combined}) is what the settlement delivery closes
  h.events.append({ type: "transfer.batch.approved", loanId: LOAN, actor: { kind: "agent", id: "boarding" }, payload: { batch_id: "XFER-1", notice_mode: "combined", respa_effective_date: "2027-01-01", direction: "in" } });
  assert.equal(h.timer(TIMER.combined_ms2_15)?.dueDate, "2026-12-17", "1.3: respa_effective_date (first payment Jan 1, 2027) − 15 calendar days");
  const a = approvedAnalysis(h.events, D("2026-11-04"));
  const run = composeClosingPackage(h.events, composeInput(a, D("2026-11-04"), { loan_id: LOAN, payment_address_named_at_closing: false }));
  const ms2 = run.items.find((x) => x.notice_code === NTC.combined_ms2)!;
  assert.equal(ms2.owner_process, "1.3"); assert.equal(ms2.required, true); assert.equal(ms2.in_package, true); assert.equal(ms2.payload?.delivered_at_settlement, true); assert.equal(ms2.gate, TIMER.combined_ms2_15);
  const delivered = deliverPackage(h.events, run, { channel: "paper_manifest", delivered_at: "2026-11-06T17:30:00.000Z" });
  const ev = recordPackageEvidence(h.events, delivered, { manifest: manifestFor(delivered, "2026-11-06T18:00:00.000Z").map((m) => ({ ...m, receipt_evidence: "signed_manifest" as const })), manifest_document_id: "DOC-MANIFEST-12" });
  assert.equal(ev.combined_ms2?.timer, TIMER.combined_ms2_15); assert.equal(ev.combined_ms2?.satisfied_at_settlement, true); assert.equal(ev.combined_ms2?.basis, "§1024.33(b)(3)(iii)");
  const mailed = h.ofType("notice.mailed").at(-1)!; assert.equal(mailed.payload.template, "NTC_REGX_1024_33B_COMBINED_MS2"); assert.equal(mailed.payload.every_loan, true); assert.equal(mailed.payload.delivered_at_settlement, true); assert.equal(mailed.payload.delivered_on, "2026-11-06");
  assert.equal(h.timer(TIMER.combined_ms2_15)?.status, "satisfied");
});

test("25.4-T13: Given an Illinois property, when `composeClosingPackage` runs, then it refuses with `jurisdiction_rules.escrow_election_notice[IL].verified_at = null` and opens an escalation to `officer` (31.1 verification required).", () => {
  const j = checkJurisdiction("IL");
  assert.equal(j.ok, false); if (!j.ok) { assert.equal(j.refusal.code, "JURISDICTION_RULE_UNVERIFIED"); assert.equal(j.refusal.reason, "jurisdiction_rules.escrow_election_notice[IL].verified_at = null"); assert.equal(j.refusal.escalate_to, "officer"); }
  assert.deepEqual(checkJurisdiction("AZ"), { ok: true, rule: null }, "no Arizona escrow-election statute row → no state notice");
  assert.equal(checkJurisdiction("UT").ok, true);
  const h = harness(); scheduleClosing(h);
  const run = composeClosingPackage(h.events, composeInput(null, null, { property_state: "IL", cd: { disclosure_id: "CD-IL-1", cd_version: 2, status: "consummation_ready", escrow: null } }));
  assert.equal(run.status, "exception"); assert.equal(run.refusal?.reason, "jurisdiction_rules.escrow_election_notice[IL].verified_at = null"); assert.deepEqual(run.items, []);
  const composed = h.ofType("notice.closing_package.composed").at(-1)!; assert.equal(composed.payload.status, "exception"); assert.equal(composed.payload.escalate_to, "officer");
  assert.equal(h.timer(TIMER.package_gate)?.status, "armed", "an exception never opens the gate");
  const esc = h.escalations.open({ kind: run.refusal!.escalate_to, ownerRole: "officer", applicationId: run.application_id, severity: "sev2", payload: { reason: run.refusal!.reason, action: "31.1 verification required" } }, AGENT);
  assert.equal(esc.kind, "officer"); assert.equal(esc.ownerRole, "officer"); assert.equal(esc.applicationId, APP);
  const created = h.ofType("escalation.created").at(-1)!; assert.equal(created.payload.kind, "officer");
});

test("25.4-T14: Given a borrower call on Mon Dec 14, 2026 reporting \"a letter from Fannie Mae says they own my loan\", then the agent records `ownership_transfer.notice.evidenced` with `evidence = borrower_report`, explains that payments continue to Supermortgage, and no misdirected-payment case is opened unless a payment was sent to Fannie Mae.", () => {
  const h = harness("2026-11-19T20:00:00.000Z");
  h.events.append({ type: "loan.purchased", loanId: LOAN, applicationId: APP, actor: FNMA, payload: { application_id: APP, loan_id: LOAN, source: "origination", purchase_date: "2026-11-19" } });
  const expected = evaluateOwnershipTransfer(h.events, { application_id: APP, loan_id: LOAN, otn_id: "OTN-14", covered_person: "fannie_mae", acquisition_date: D("2026-11-19"), as_of: D("2026-11-19") });
  assert.equal(h.timer(TIMER.fnma_evidence_45)?.status, "armed");
  h.clock.set("2026-12-14T16:00:00.000Z");
  const call = recordBorrowerReport(h.events, { application_id: APP, loan_id: LOAN, row: expected.row, reported_on: D("2026-12-14"), channel: "call", payment_sent_to_fnma: false });
  assert.equal(call.event.type, "ownership_transfer.notice.evidenced"); assert.equal(call.event.payload.evidence, "borrower_report"); assert.equal(call.event.payload.evidenced_on, "2026-12-14"); assert.equal(call.on_time, true);
  assert.equal(call.row.status, "evidenced"); assert.equal(call.misdirected_payment_case, null);
  assert.ok(call.script.some((s) => /Keep sending your payments to Supermortgage/.test(s))); assert.ok(call.script.some((s) => /Fannie Mae is not your servicer/.test(s))); assert.ok(call.script.some((s) => /informational — no action is required/.test(s)));
  assert.match(call.script[0]!, /automated/, "automation disclosure at the start of every interaction");
  assert.equal(h.timer(TIMER.fnma_evidence_45)?.status, "satisfied");
  // a payment actually sent to Fannie Mae opens servicing 2.x's misdirected-payment case
  const paid = recordBorrowerReport(h.events, { application_id: APP, loan_id: LOAN, row: expected.row, reported_on: D("2026-12-14"), channel: "call", payment_sent_to_fnma: true, payment_details: { amount_cents: 392_762n, sent_on: D("2026-12-10") } });
  assert.deepEqual(paid.misdirected_payment_case, { kind: "misdirected_payment", owner_process: "2.x", amount_cents: 392_762n, sent_on: "2026-12-10" });
});

test("25.4 worked figures: example 3's aggregate analysis ($4,800.00 taxes in two $2,400.00 installments + $1,500.00 hazard → $525.00 monthly, $1,050.00 cushion, $1,875.00 initial deposit, $6,300.00 year-1 escrowed costs), the $3,927.62 first-payment amount, the purchase fixture's $2,060.00 points and $863.51 prepaid interest at $71.95 per diem", () => {
  const h = harness();
  const a = approvedAnalysis(h.events, D("2026-11-04"));
  assert.equal(EXAMPLE_3_LINES[0]!.estimated_annual_cents, 480_000n);                                        // $4,800.00 annual property taxes
  assert.deepEqual(EXAMPLE_3_LINES[0]!.bills.map((b) => b.amount_cents), [240_000n, 240_000n]);           // $2,400.00 on Mar 1 and Oct 1
  assert.equal(a.annual_disbursements_cents, 630_000n);                                                     // $6,300.00 = Σ disbursements = CD "Escrowed Property Costs over Year 1"
  assert.equal(a.base_payment_cents, 52_500n);                                                              // $525.00 = 6,300 / 12
  assert.equal(a.cushion_cents, 105_000n);                                                                  // $1,050.00 ≤ 1/6 × 6,300
  assert.equal(a.target_at_start_cents, 187_500n);                                                          // $1,875.00 — lowest projected balance S − 825 = cushion 1,050
  assert.equal(a.lowest_target_cents, 105_000n); assert.equal(a.cd_figures.l7.escrowed_property_costs_year1_cents, 630_000n); assert.equal(a.cd_figures.l7.initial_escrow_payment_cents, 187_500n); assert.equal(a.cd_figures.l7.monthly_escrow_payment_cents, 52_500n);
  const trial = Object.fromEntries(a.trial_balance.map((r) => [r.month, r.target_cents - a.target_at_start_cents]));
  assert.equal(trial.Mar, -82_500n); assert.equal(trial.Oct, 45_000n); assert.equal(trial.Nov, -52_500n); assert.equal(trial.Dec, 0n);   // S−825 / S+450 / S−525 / S
  const c = runCdEscrowConsistency({ application_id: APP, cd_version: 3, cd: { initial_escrow_payment_cents: 187_500n, monthly_escrow_cents: 52_500n, escrowed_costs_year1_cents: 630_000n }, analysis: a, now: CONSUMMATION_AT });
  assert.equal(c.result, "match"); assert.equal(c.blocks_gate, false);
  assert.equal(firstPaymentLetterAmount({ pi_cents: 340_262n, escrow_cents: 52_500n, mi_cents: 0n }).total_cents, 392_762n);              // $3,927.62 = P&I $3,402.62 + escrow $525.00
  assert.equal(money(392_762n), "$3,927.62"); assert.equal(money(187_500n), "$1,875.00"); assert.equal(money(105_000n), "$1,050.00"); assert.equal(money(630_000n), "$6,300.00");
  assert.equal(prepaidInterestCents(56_000_000n, "6.125", 19), 178_548n);                                   // $1,785.48 = 19 × $93.9726
  assert.equal(prepaidInterestCents(41_200_000n, "6.375", 12), 86_351n);                                    // $863.51 = 12 × $71.9589
  assert.equal(perDiemCentsUnrounded(41_200_000n, "6.375"), "71.9589"); assert.equal(`$${perDiemCentsUnrounded(41_200_000n, "6.375").slice(0, 5)}`, "$71.95");   // $71.95(89) per diem
  assert.equal(pointsSeed({ transaction_type: "purchase", principal_cents: 41_200_000n, points_pct: "0.500", borrower_paid_cents: 206_000n, designated_as_points_on_cd: true, principal_residence: true }).points_paid_cents, 206_000n);   // $2,060.00 = 0.500% × $412,000
  assert.equal(money(206_000n), "$2,060.00"); assert.equal(money(86_351n), "$863.51"); assert.equal(money(480_000n), "$4,800.00"); assert.equal(money(240_000n), "$2,400.00"); assert.equal(money(52_500n), "$525.00");
});
