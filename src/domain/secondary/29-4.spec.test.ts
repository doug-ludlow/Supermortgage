// 29.4 Loan Delivery submission, custodian certification, purchase, purchase advice reconciliation, and post-delivery corrections/remedies
// spec/sections/29-secondary-marketing-and-delivery-to-fannie-mae-whole-loan-se/29-4-loan-delivery-submission-custodian-certification-purchase-pu.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays, addMonths } from "../../kernel/calendar/date.ts";
import { addBusinessDays, rollBack } from "../../kernel/calendar/business.ts";
import { toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { formatCents } from "../../kernel/money/cents.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_29_4 } from "../../app/tools/section29-4.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeERegistry } from "../warehouse/ops-27-1.ts";
import { fannieSifma, loanAgeDueOn } from "./ops-29-1.ts";
import {
  DeliveryService, DeliveryRefused, operatorTaskDue, expectedDates, recomputeOnReceipt, recomputeOnCertification, lpiWindow, loanAgeCheck, seasonedCheck, custodianReceiptDeadline, receiptPlan, renderInstructionSheet, evidenceGate, classifyImportEdits, dataRevisionDecision, baileeNameCheck, enoteTransferGate, warehouseReleaseGate,
  principalProceedsCents, interestAdjustment, expectedProceeds, reconcileProceeds, warehouseSlipCostCents, advanceCents, adviceLagCheck, evaluateRelief, preparePpa, ppaProcessingExpected, remedyPlan, REQUIRED_EVIDENCE, PPA_LLPA_MINIMUM_CENTS,
  type WireInstruction, type PurchaseAdviceInput, type DeliveryInput,
} from "./ops-29-4.ts";

const AGENT: Actor = { kind: "agent", id: "secondary" };
const OPERATOR: Actor = { kind: "human", id: "u-op-seller", role: "fnma_portal_operator" };
const WH_OPERATOR: Actor = { kind: "human", id: "u-op-warehouse", role: "fnma_portal_operator" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const APP = "app-refi-1", LOAN = "loan-refi-1", DLV = "dlv-refi-1", APP_P = "app-purchase-1", LOAN_P = "loan-purch-1", DLV_P = "dlv-purch-1";
const FNMA_NO = "1234567890";
const LETTERHEAD = "SUPERMORTGAGE WAREHOUSE LENDING, LLC";
/** Eastern time (Fannie Mae's clock) and the creditor's Phoenix clock (MST all year). */
const et = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/New_York"));
const mst = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/Phoenix"));
/** 23.4's gates as the consummation-stage rows leave them for the fixture (QM safe harbor, not HOEPA, no state high-cost test). */
const GATE_FACTS = { qm_type: "general_safe_harbor", apr_test_pass: true, pf_pass: true, product_tests_pass: true, consider_verify_complete: true, consider_verify_missing: [], stage: "consummation", computed_from_final_cd: true, is_hoepa: false, state_tests: [] };
/** SM's warehouse account payee code (Form 482 on file since onboarding), Receiver Type Warehouse Lender, Letter Type Bailee, Letter Name = the letterhead text byte-for-byte. */
const WIRE: WireInstruction = { wire_instruction_id: "wire-sm-1", partner_id: "partner-1", payee_code: "SMWH1", receiver_type: "warehouse_lender", warehouse_lender_org_id: "1000123", letter_type: "bailee", bailee_letter_name: LETTERHEAD, status: "active", form_482_document_id: "doc-482-1", form_482_signed_by: "officer", fnma_confirmation_call_at: null, approved_by_warehouse_at: "2026-09-15T15:00:00.000Z", approved_by_operator_id: "u-op-warehouse" };
/** Refinance fixture (section README): $560,000 LCOR 6.125% Phoenix AZ, paper note under SM's bailee letter; disbursed Thu Nov 12, 2026; first payment Fri Jan 1, 2027; best-efforts commitment expiring Mon Dec 7, 2026; PTR 5.875 (25 bps servicing fee); commitment price 101.125. */
const REFI: DeliveryInput = { delivery_id: DLV, loan_id: LOAN, application_id: APP, partner_id: "partner-1", seller_loan_number: "SM-0000001", commitment_id_fnma: "C-2026-0001", commitment_expires_on: D("2026-12-07"), note_form: "paper", upb_cents: 56_000_000n, note_rate: "6.125", pass_through_rate: "5.875", servicing_fee_rate: "0.250", commitment_price: "101.125000", remittance_type: "actual_actual", disbursement_date: D("2026-11-12"), first_payment_date: D("2027-01-01"), custodian_fin: "FIN-000123", bailee_letter_id: "bl-1", wire_instruction_id: "wire-sm-1", payee_code: "SMWH1", commitment_closed: true };
/** Purchase fixture (Columbus OH): HomeReady $412,000 6.375%, eNote (SFC 508), closing/funding Wed Nov 18, 2026; MI active Thu Nov 19; ULDD frozen Thu Nov 19. */
const PURCH: DeliveryInput = { delivery_id: DLV_P, loan_id: LOAN_P, application_id: APP_P, partner_id: "partner-1", seller_loan_number: "SM-0000002", commitment_id_fnma: "C-2026-0002", commitment_expires_on: D("2026-12-09"), note_form: "enote", enote_indicator: true, min: "100012300000000021", upb_cents: 41_200_000n, note_rate: "6.375", pass_through_rate: "6.125", servicing_fee_rate: "0.250", commitment_price: "100.500000", remittance_type: "actual_actual", disbursement_date: D("2026-11-18"), first_payment_date: D("2027-01-01"), wire_instruction_id: "wire-sm-1", payee_code: "SMWH1", commitment_closed: true };
/** The Purchase Advice of worked example A / R3 (A/A; price 101.125; 12 days of prepaid interest deducted at 30/360; one 0.125% LLPA line). */
const ADVICE = (over: Partial<PurchaseAdviceInput> = {}): PurchaseAdviceInput => ({ purchase_advice_id: "pa-1", fnma_loan_number: FNMA_NO, advice_date: D("2026-11-19"), purchase_date: D("2026-11-19"), commitment_id_fnma: "C-2026-0001", payee_code: "SMWH1", remittance_type: "actual_actual", pass_through_rate: "5.875", servicing_fee_rate: "0.250", price: "101.125000", upb_cents: 56_000_000n, principal_proceeds_cents: 56_630_000n, interest_adjustment_cents: -109_667n, llpa_total_cents: 70_000n, llpa_lines: [{ code: "LCOR_762_70", pct: "0.125", cents: 70_000n }], fees: [], net_proceeds_cents: 56_450_333n, wire_reference: "FEDW-20261119-001", source: "api", raw_payload_document_id: "doc-pa-json-1", received_at: et("2026-11-20", "06:00"), ...over });
const EVIDENCE = REQUIRED_EVIDENCE.map((kind, n) => ({ kind, document_id: `doc-ev-${n + 1}` }));

/** The 29.4 tools on the bus over the overridden registry (29.4 rows plus 29.1's loan-age reference and 27.2's PPA-request clock), the escalation service, 27.1's fake eRegistry and a 29.3 build-service spy; the harness appends the upstream events (29.3 / 21.4 / 29.1 / 26.3) with origination context. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["29.4", "29.1", "27.2"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId: LOAN, applicationId: APP, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const escalations = new EscalationService(events, clock); const registry = new FakeERegistry();
  const svc = new DeliveryService({ events, clock, escalations, registry });
  const build = { submitted: [] as string[], superseded: [] as string[], markSubmitted(id: string) { this.submitted.push(id); }, supersede(id: string, reason: string) { this.superseded.push(`${id}:${reason}`); return null; } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: { "delivery-29-4": svc, "delivery-29-3": build, warehouse: { registry } }, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_29_4); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("29.4", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string, loanId = LOAN) => timers.byCode(code).filter((t) => t.loanId === loanId).at(-1);
  const ofType = (type: string, loanId = LOAN): readonly DomainEvent[] => events.ofType(type).filter((e) => e.loanId === loanId);
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt = clock.now(), actor: Actor = { kind: "agent", id: "secondary" }, ids: { loan: string; app: string } = { loan: LOAN, app: APP }) => events.append({ type, loanId: ids.loan, applicationId: ids.app, actor, occurredAt, payload: { application_id: ids.app, loan_id: ids.loan, source: "origination", ...payload } });
  /** 29.3's freeze: `delivery.package.frozen{package_id, sha256, version, commitment_id_fnma, enote_indicator}` then the 29.4 row takes the package. */
  const freeze = async (frozenAt: string, d: DeliveryInput = REFI, pkg = "pkg-refi-1", sha = "a".repeat(64)) => { at(frozenAt); upstream("delivery.package.frozen", { delivery_id: d.delivery_id, package_id: pkg, sha256: sha, version: 1, frozen_at: frozenAt, commitment_id_fnma: d.commitment_id_fnma, enote_indicator: d.enote_indicator ?? false }, frozenAt, AGENT, { loan: d.loan_id, app: d.application_id }); return run("openOperatorTask", { op: "frozen", delivery_id: d.delivery_id, package_id: pkg, sha256: sha, file_name: `${pkg}.xml`, frozen_at: frozenAt }); };
  const register = (d: DeliveryInput = REFI, wire: WireInstruction = WIRE) => { svc.register(d); svc.registerWire(wire); return svc.get(d.delivery_id); };
  const openTask = (atIso: string, id = DLV) => { at(atIso); return run("openOperatorTask", { delivery_id: id, at: atIso, gate_facts: GATE_FACTS }); };
  const submit = (taskId: string, submittedAt: string, extra: Record<string, unknown> = {}, edits: unknown[] = []) => { at(submittedAt); return run("parseOperatorEvidence", { task_id: taskId, operator_id: OPERATOR.id, evidence: EVIDENCE, hash_confirmed: true, edits, captured_state: { fnma_loan_number: FNMA_NO, submitted_at: submittedAt, commitment_number: "C-2026-0001", file_sha256: "a".repeat(64), loan_delivery_status: "Purchase Requested", certification_status: "Awaiting Certification", ...extra }, at: submittedAt }, OPERATOR); };
  /** Worked example A through certification: freeze Fri Nov 13 10:05 MST → task → submit Mon Nov 16 13:31 ET → carrier 15:40 MT → delivered Tue Nov 17 17:05 ET → certified Wed Nov 18 07:15 ET. */
  const throughCertification = async () => {
    register(); await freeze(mst("2026-11-13", "10:05")); const t = await openTask(mst("2026-11-13", "10:06"));
    await submit(String(t.task_id), et("2026-11-16", "13:31"));
    at(mst("2026-11-16", "15:40")); await run("scheduleShipment", { delivery_id: DLV, carrier: "overnight", tracking_number: "1Z-REFI-1", tendered_at: mst("2026-11-16", "15:40"), first_morning_service: true, package_document_ids: ["doc-cover-1", "doc-bailee-1", "doc-note-1"] });
    at(et("2026-11-17", "17:05")); await run("trackShipment", { op: "received", delivery_id: DLV, received_at: et("2026-11-17", "17:05") });
    at(et("2026-11-18", "07:15")); return run("trackShipment", { op: "certified", delivery_id: DLV, certified_at: et("2026-11-18", "07:15"), certification_kind: "certified", bailee_validation: "passed", bailee_letter_name_used: LETTERHEAD, notice_document_id: "doc-cert-notice-1" });
  };
  const purchase = async (advice: PurchaseAdviceInput = ADVICE(), atIso = et("2026-11-20", "06:00")) => { at(atIso); return run("ingestPurchaseAdvice", { delivery_id: DLV, advice: { ...advice, upb_cents: String(advice.upb_cents), principal_proceeds_cents: String(advice.principal_proceeds_cents), interest_adjustment_cents: String(advice.interest_adjustment_cents), llpa_total_cents: String(advice.llpa_total_cents), net_proceeds_cents: String(advice.net_proceeds_cents), llpa_lines: advice.llpa_lines.map((l) => ({ ...l, cents: String(l.cents) })) }, at: atIso }); };
  const refused = async (p: Promise<unknown>, code: string): Promise<void> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused || e instanceof DeliveryRefused, `expected a refusal, got ${(e as Error).message}`); assert.equal(e.code, code); return; } assert.fail(`expected refusal ${code}`); };
  return { rt, uow, events, timers, escalations, registry, svc, build, run, at, timer, ofType, upstream, freeze, register, openTask, submit, throughCertification, purchase, refused, decisions, clock };
}

test("29.4-T1: Given the refinance fixture package frozen Fri Nov 13, 2026 10:05 MST, then an `import_and_submit` task is opened with `sla_due_at` = Mon Nov 16, 2026 15:00 MT, the instruction sheet shows the commitment number, payee code, Receiver Type \"Warehouse Lender\", Letter Type \"Bailee\" and Bailee Letter Name, and the task cannot be marked complete without the four evidence items and `hash_confirmed = true`.", async () => {
  const h = harness(mst("2026-11-13", "10:05")); h.register(); await h.freeze(mst("2026-11-13", "10:05"));
  const due = operatorTaskDue(mst("2026-11-13", "10:05")); assert.equal(due.due_on, "2026-11-16"); assert.equal(due.sla_due_at, mst("2026-11-16", "15:00"));   // one business_days_creditor after Fri Nov 13 (Sat/Sun excluded), 15:00 MT
  const out = await h.openTask(mst("2026-11-13", "10:06"));
  assert.equal(out.extension_requested, false); assert.equal(out.sla_due_at, mst("2026-11-16", "15:00"));
  const task = h.svc.tasks.find((t) => t.task_id === out.task_id)!; assert.equal(task.kind, "import_and_submit"); assert.equal(task.org, "partner_seller_org");
  const esc = h.escalations.list().find((e) => e.id === task.escalation_id)!; assert.equal(esc.kind, "human_portal_task"); assert.equal(esc.ownerRole, "fnma_portal_operator"); assert.equal(esc.payload.task, "import_and_submit");
  assert.equal(h.ofType("delivery.operator_task.opened").at(-1)!.payload.kind, "import_and_submit");
  const sheet = out.sheet as ReturnType<typeof renderInstructionSheet>;
  assert.equal(sheet.commitment_number, "C-2026-0001"); assert.equal(sheet.payee_code, "SMWH1"); assert.equal(sheet.receiver_type_label, "Warehouse Lender"); assert.equal(sheet.letter_type_label, "Bailee"); assert.equal(sheet.bailee_letter_name, LETTERHEAD); assert.equal(sheet.enote_indicator, false);
  assert.deepEqual(sheet.evidence_required, ["import_result_screenshot", "edit_history_csv", "loan_record_print", "wire_details_screenshot"]); assert.equal(sheet.loan_count, 1); assert.deepEqual(sheet.expected_edits, ["none"]);
  // the SLA row armed on 29.3's freeze: due Mon Nov 16 15:00 MT
  const sla = h.timer("SM_LOAN_DELIVERY_OPERATOR_SLA_1BD")!; assert.equal(sla.status, "armed"); assert.equal(sla.dueDate, "2026-11-16"); assert.equal(sla.dueAt, Date.parse(mst("2026-11-16", "15:00")));
  // cannot complete: three evidence items / hash not confirmed / wrong commitment number
  const three = EVIDENCE.slice(0, 3); const cap = { fnma_loan_number: FNMA_NO, submitted_at: et("2026-11-16", "13:31"), commitment_number: "C-2026-0001" };
  assert.deepEqual(evidenceGate({ evidence: three, hash_confirmed: true, captured_state: cap }, { commitment_id_fnma: "C-2026-0001", sha256: "a".repeat(64) }).missing, ["wire_details_screenshot"]);
  assert.equal(evidenceGate({ evidence: EVIDENCE, hash_confirmed: false, captured_state: cap }, { commitment_id_fnma: "C-2026-0001", sha256: "a".repeat(64) }).complete, false);
  assert.equal(evidenceGate({ evidence: EVIDENCE, hash_confirmed: true, captured_state: { ...cap, commitment_number: "C-2026-9999" } }, { commitment_id_fnma: "C-2026-0001", sha256: "a".repeat(64) }).complete, false);
  await h.refused(h.run("parseOperatorEvidence", { task_id: task.task_id, operator_id: OPERATOR.id, evidence: three, hash_confirmed: true, captured_state: cap }, OPERATOR), "EVIDENCE_INCOMPLETE");
  await h.refused(h.run("parseOperatorEvidence", { task_id: task.task_id, operator_id: OPERATOR.id, evidence: EVIDENCE, hash_confirmed: false, captured_state: cap }, OPERATOR), "EVIDENCE_INCOMPLETE");
  await h.refused(h.run("parseOperatorEvidence", { task_id: task.task_id, operator_id: OPERATOR.id, evidence: three, hash_confirmed: true, mark_complete: true, captured_state: cap }, OPERATOR), "EVIDENCE_LIST_REQUIRED");
  assert.equal(task.outcome, null); assert.equal(h.svc.get(DLV).loan_delivery_status, "not_started");
  await h.refused(h.run("openOperatorTask", { delivery_id: DLV, automate_ui: true }), "NO_FNMA_UI_AUTOMATION");
});

test("29.4-T2: Given the operator submits Mon Nov 16 13:31 ET and the carrier receives the package 15:40 MT the same day, then `delivery.submitted{fnma_loan_number}` is recorded with `submit_before_2100_et = true`, `FNMA_C2_2_02_SHIP_SAME_DAY_AS_SUBMIT` is satisfied, `expected_certification_date` = Tue Nov 17 and `expected_purchase_date` = Wed Nov 18.", async () => {
  const h = harness(mst("2026-11-13", "10:05")); h.register(); await h.freeze(mst("2026-11-13", "10:05")); const t = await h.openTask(mst("2026-11-13", "10:06"));
  const out = await h.submit(String(t.task_id), et("2026-11-16", "13:31"));
  assert.equal(out.outcome, "completed"); assert.equal(out.fnma_loan_number, FNMA_NO); assert.deepEqual(h.build.submitted, [DLV]);   // 29.3's markSubmitted
  const sub = h.ofType("delivery.submitted").at(-1)!; assert.equal(sub.payload.fnma_loan_number, FNMA_NO); assert.equal(sub.payload.submit_before_2100_et, true); assert.equal(sub.payload.submitted_at, et("2026-11-16", "13:31")); assert.equal(sub.payload.resubmit, false);
  const r = h.svc.get(DLV); assert.equal(r.loan_delivery_status, "purchase_requested"); assert.equal(r.certification_status, "awaiting_certification"); assert.equal(r.status_source, "operator_capture"); assert.equal(r.submit_before_2100_et, true);
  assert.equal(r.expected_certification_date, "2026-11-17"); assert.equal(r.expected_purchase_date, "2026-11-18");
  const exp = expectedDates(et("2026-11-16", "13:31")); assert.equal(exp.expected_receipt_at, et("2026-11-17", "07:30")); assert.equal(exp.expected_certification_date, "2026-11-17"); assert.equal(exp.expected_purchase_date, "2026-11-18");
  assert.equal(expectedDates(et("2026-11-16", "21:05")).data_day, "2026-11-17");   // after the 9:00 p.m. ET cutoff the data counts on Tue Nov 17
  assert.equal(h.timer("SM_LOAN_DELIVERY_OPERATOR_SLA_1BD")!.status, "satisfied");
  const ship = h.timer("FNMA_C2_2_02_SHIP_SAME_DAY_AS_SUBMIT")!; assert.equal(ship.status, "armed"); assert.equal(ship.dueDate, "2026-11-16"); assert.equal(ship.dueAt, Date.parse(mst("2026-11-16", "16:30")));   // carrier pickup 16:30 MT
  const exp0730 = h.timer("FNMA_LD_UG_CUSTODIAN_0730_ET_EXPECTATION")!; assert.equal(exp0730.dueDate, "2026-11-17"); assert.equal(exp0730.dueAt, Date.parse(et("2026-11-17", "07:30")));
  h.at(mst("2026-11-16", "15:40"));
  const s = await h.run("scheduleShipment", { delivery_id: DLV, carrier: "overnight", tracking_number: "1Z-REFI-1", tendered_at: mst("2026-11-16", "15:40"), first_morning_service: true, package_document_ids: ["doc-cover-1", "doc-bailee-1", "doc-note-1"] });
  assert.equal(s.same_day_as_submit, true); assert.equal(h.ofType("custody.package.shipped").at(-1)!.payload.first_morning_service, true);
  assert.equal(h.timer("FNMA_C2_2_02_SHIP_SAME_DAY_AS_SUBMIT")!.status, "satisfied");
});

test("29.4-T3: Given the package is delivered Tue Nov 17 17:05 ET, then `received_by_0730_et = false`, the expectations are recomputed to certification Wed Nov 18 and purchase Thu Nov 19; given the custodian certifies Wed Nov 18 07:15 ET, then `purchase_ready_at = 2026-11-18`; given the Purchase Advice dated Thu Nov 19 arrives via the API on Fri Nov 20, then `purchase_date = 2026-11-19`, `acquisition_date = 2026-11-19`, `loan.purchased` is emitted once, and 27.2's `FNMA_C2_2_05_PPA_REQUEST_30` is due Sat Dec 19, 2026 (platform due-at Fri Dec 18).", async () => {
  const h = harness(mst("2026-11-13", "10:05")); h.upstream("loan.funded", { funding_date: "2026-11-12", disbursement_date: "2026-11-12", first_payment_date: "2027-01-01", lpi_due_date: "2026-12-01", funded_amount_cents: "56000000" }, et("2026-11-12", "14:00"), { kind: "agent", id: "funding" });
  await h.throughCertification();
  const rc = recomputeOnReceipt(et("2026-11-17", "17:05")); assert.equal(rc.received_by_0730_et, false); assert.equal(rc.received_by_custodian_cutoff, false); assert.equal(rc.expected_certification_date, "2026-11-18"); assert.equal(rc.expected_purchase_date, "2026-11-19");
  const rec = h.ofType("custody.package.received").at(-1)!; assert.equal(rec.payload.by_0730_et, false); assert.equal(rec.payload.expected_certification_date, "2026-11-18"); assert.equal(rec.payload.carrier_claim, true);
  assert.equal(h.timer("FNMA_LD_UG_CUSTODIAN_0730_ET_EXPECTATION")!.status, "armed");   // not satisfied by a late receipt — an expectation, not an obligation
  const certExp = h.timer("FNMA_C2_2_04_CERTIFICATION_EXPECTED_1BD")!; assert.equal(certExp.dueDate, "2026-11-18"); assert.equal(certExp.status, "satisfied");
  const r = h.svc.get(DLV); assert.equal(r.purchase_ready_at, "2026-11-18"); assert.equal(r.loan_delivery_status, "purchase_ready"); assert.equal(r.certification_status, "certified"); assert.equal(r.status_source, "custodian_notice"); assert.equal(r.expected_purchase_date, "2026-11-19");
  assert.equal(recomputeOnCertification(et("2026-11-18", "07:15")).expected_purchase_date, "2026-11-19");
  const pe = h.timer("FNMA_C2_2_04_PURCHASE_EXPECTED_1BD")!; assert.equal(pe.status, "armed"); assert.equal(pe.dueDate, "2026-11-19");
  assert.equal(h.svc.certifications[0]!.bailee_validation, "passed");
  const p1 = await h.purchase(); assert.equal(p1.replayed, false); assert.equal(p1.purchase_date, "2026-11-19"); assert.equal(p1.acquisition_date, "2026-11-19"); assert.equal(p1.loan_delivery_status, "purchased_and_funded"); assert.equal(p1.loan_purchased_emitted, true);
  assert.equal(h.svc.get(DLV).status_source, "purchase_advice_api");
  const p2 = await h.purchase(ADVICE(), et("2026-11-21", "06:00")); assert.equal(p2.replayed, true);   // the Saturday pull sees the same (fnma_loan_number, advice_date)
  const purchased = h.ofType("loan.purchased"); assert.equal(purchased.length, 1); assert.equal(purchased[0]!.payload.purchase_date, "2026-11-19"); assert.equal(purchased[0]!.payload.acquisition_date, "2026-11-19"); assert.equal(purchased[0]!.payload.fnma_loan_number, FNMA_NO); assert.equal(purchased[0]!.applicationId, APP);
  assert.equal(h.ofType("purchase_advice.received").length, 1);
  assert.equal(h.timer("FNMA_C2_2_04_PURCHASE_EXPECTED_1BD")!.status, "satisfied"); assert.equal(h.timer("FNMA_C2_2_DELIVERY_LPI_45")!.status, "satisfied");
  // 27.2's clock: advice Nov 19 + 30 calendar days = Sat Dec 19, 2026 → platform due-at the preceding business day, Fri Dec 18
  const adv = h.svc.advices[0]!; assert.equal(adv.adjustment_request_due_at, "2026-12-19"); assert.equal(rollBack(adv.adjustment_request_due_at, fannieSifma), "2026-12-18");
  const ppaReq = h.timer("FNMA_C2_2_05_PPA_REQUEST_30"); if (ppaReq?.dueDate) assert.equal(ppaReq.dueDate, "2026-12-19");
  assert.equal(h.ofType("purchase_advice.received")[0]!.payload.adjustment_request_due_at_on, "2026-12-18");
  await h.refused(h.run("ingestPurchaseAdvice", { delivery_id: DLV, advice: ADVICE(), release_warehouse_interest: true }), "RELEASE_BEFORE_PROCEEDS");
});

test("29.4-T4: Given first payment due Fri Jan 1, 2027 and no payment posted, then `lpi_due_date = 2026-12-01`, `FNMA_C2_2_DELIVERY_LPI_45` is due Fri Jan 15, 2027, `FNMA_B2_1_5_02_LOAN_AGE_6M_PURCHASE_READY` is due Wed Jun 30, 2027 (a Purchase Ready date of Thu Jul 1, 2027 breaches it) and `FNMA_B2_1_5_02_SEASONED_1Y_FLAG` fires Sat Jan 1, 2028 if unsold; given the Jan 1 installment posts on Mon Dec 28, 2026, then the LPI window moves to Mon Feb 15, 2027.", async () => {
  const w = lpiWindow(D("2027-01-01")); assert.equal(w.lpi_due_date, "2026-12-01"); assert.equal(w.delivery_lpi_due, "2027-01-15"); assert.equal(w.loan_age_due_on, "2027-06-30"); assert.equal(w.seasoned_on, "2028-01-01");
  assert.equal(addDays(D("2026-12-01"), 30), "2026-12-31"); assert.equal(addDays(D("2026-12-31"), 15), "2027-01-15");   // R1: Dec 1 + 30 = Dec 31; + 15 = Jan 15
  const age = loanAgeCheck(D("2027-01-01"), D("2027-07-01")); assert.equal(age.due_on, "2027-06-30"); assert.equal(age.breached, true); assert.equal(loanAgeCheck(D("2027-01-01"), D("2027-06-30")).breached, false); assert.equal(loanAgeDueOn(D("2027-01-01")), "2027-06-30");
  assert.equal(seasonedCheck(D("2027-01-01"), null, D("2028-01-01")).seasoned, true); assert.equal(seasonedCheck(D("2027-01-01"), D("2026-11-19"), D("2028-01-01")).seasoned, false);
  assert.equal(lpiWindow(D("2027-01-01"), D("2027-01-01")).delivery_lpi_due, "2027-02-15");
  const h = harness(et("2026-11-12", "14:00")); h.register();
  h.upstream("loan.funded", { funding_date: "2026-11-12", disbursement_date: "2026-11-12", first_payment_date: "2027-01-01", lpi_due_date: "2026-12-01", funded_amount_cents: "56000000" }, et("2026-11-12", "14:00"), { kind: "agent", id: "funding" });
  h.upstream("commitment.closed_status.set", { commitment_id: "cmt-refi-1", commitment_id_fnma: "C-2026-0001", disbursement_date: "2026-11-12", first_payment_date: "2027-01-01", loan_age_due_on: loanAgeDueOn(D("2027-01-01")), expires_on: "2026-12-07", original_expires_on: "2026-12-07", autoext_cap_on: "2027-02-05" }, et("2026-11-12", "15:00"));
  const lpi = h.timer("FNMA_C2_2_DELIVERY_LPI_45")!; assert.equal(lpi.status, "armed"); assert.equal(lpi.anchorDate, "2026-12-01"); assert.equal(lpi.dueDate, "2027-01-15");
  const la = h.timer("FNMA_B2_1_5_02_LOAN_AGE_6M_PURCHASE_READY")!; assert.equal(la.status, "armed"); assert.equal(la.dueDate, "2027-06-30"); assert.equal(la.dueAt, Date.parse(et("2027-06-30", "17:00")));
  const sea = h.timer("FNMA_B2_1_5_02_SEASONED_1Y_FLAG")!; assert.equal(sea.status, "armed"); assert.equal(sea.dueDate, "2028-01-01");
  // a Purchase Ready of Thu Jul 1, 2027 breaches: the observation lands after the due instant and the officer is escalated
  h.at(et("2027-07-01", "18:00")); h.timers.evaluate(et("2027-07-01", "18:00")); assert.equal(h.timer("FNMA_B2_1_5_02_LOAN_AGE_6M_PURCHASE_READY")!.status, "breached");
  const cert = h.svc.recordCertification({ delivery_id: DLV, certified_at: et("2027-07-01", "09:00"), certification_kind: "certified", at: et("2027-07-01", "18:00") }); assert.equal(cert.loan_age.breached, true); assert.equal(cert.loan_age.due_on, "2027-06-30");
  assert.equal(h.timer("FNMA_B2_1_5_02_LOAN_AGE_6M_PURCHASE_READY")!.status, "satisfied_late"); assert.equal(h.escalations.list().at(-1)!.payload.task, "loan_age_flow_ineligible"); assert.equal(h.escalations.list().at(-1)!.kind, "officer");
  // early payer: the Jan 1 installment posts Mon Dec 28, 2026 → LPI Jan 1, 2027 → window Mon Feb 15, 2027
  const h2 = harness(et("2026-12-28", "10:00")); h2.register();
  const moved = await h2.run("observeStatus", { op: "payment_posted", delivery_id: DLV, installment_due: "2027-01-01", at: et("2026-12-28", "10:00") });
  assert.equal(moved.lpi_due_date, "2027-01-01"); assert.equal(moved.delivery_lpi_due, "2027-02-15"); assert.equal(h2.svc.get(DLV).lpi_due_date, "2027-01-01"); assert.equal(h2.ofType("delivery.lpi.reanchored").at(-1)!.payload.delivery_lpi_due, "2027-02-15");
  const calc = await h2.run("computeExpectedDates", { op: "lpi", first_payment_date: "2027-01-01", last_paid_installment_due: "2027-01-01", today: "2026-12-28" }); assert.equal(calc.delivery_lpi_due, "2027-02-15");
});

test("29.4-T5: Given a commitment expiring Mon Dec 7, 2026, then `FNMA_C2_2_01_CUSTODIAN_RECEIPT_BEFORE_EXPIRY` is anchored on Sun Dec 6 and due Fri Dec 4 07:30 ET (rolled backward — no first-morning delivery on Sunday); given the package is delivered Tue Nov 17, the timer is satisfied; given instead a commitment expiring Fri Nov 20 (due Thu Nov 19 07:30 ET) and a freeze on Wed Nov 18 with expected receipt Fri Nov 20, then the agent requests an 29.1 extension before opening the operator task.", async () => {
  const dl = custodianReceiptDeadline(D("2026-12-07")); assert.equal(dl.anchor_on, "2026-12-06"); assert.equal(dl.due_on, "2026-12-04"); assert.equal(dl.due_at, et("2026-12-04", "07:30")); assert.equal(dl.rolled_backward, true);
  const h = harness(et("2026-10-07", "12:30"));
  h.upstream("lock.commitment.linked", { lock_id: "lock-refi-1", lineage_id: "lin-refi-1", commitment_id: "cmt-refi-1", commitment_id_fnma: "C-2026-0001", expires_on: "2026-12-07" }, et("2026-10-07", "12:30"), { kind: "agent", id: "pricing" });
  const t = h.timer("FNMA_C2_2_01_CUSTODIAN_RECEIPT_BEFORE_EXPIRY")!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-12-07"); assert.equal(t.dueDate, "2026-12-04"); assert.equal(t.dueAt, Date.parse(et("2026-12-04", "07:30")));
  await h.throughCertification();
  assert.equal(h.timer("FNMA_C2_2_01_CUSTODIAN_RECEIPT_BEFORE_EXPIRY")!.status, "satisfied"); assert.equal(h.timer("FNMA_C2_2_01_CUSTODIAN_RECEIPT_BEFORE_EXPIRY")!.satisfiedAt, et("2026-11-17", "17:05"));
  // the composite delivery gate 29.1 owns stays open through the fixture: receipt Tue Nov 17 ≤ Fri Dec 4
  assert.equal(evaluateGate("29.1.deliveryCommitmentGate", { expires_on: "2026-12-07", today_et: "2026-11-17", custodian_receipt_possible_on: "2026-11-17" }).open, true);
  // a commitment expiring Fri Nov 20: due Thu Nov 19 07:30 ET; a freeze Wed Nov 18 puts the expected receipt on Fri Nov 20 → extension first, no task
  const short = custodianReceiptDeadline(D("2026-11-20")); assert.equal(short.anchor_on, "2026-11-19"); assert.equal(short.due_on, "2026-11-19"); assert.equal(short.due_at, et("2026-11-19", "07:30")); assert.equal(short.rolled_backward, false);
  const plan = receiptPlan(mst("2026-11-18", "10:05"), D("2026-11-20")); assert.equal(plan.task_due_on, "2026-11-19"); assert.equal(plan.expected_receipt_on, "2026-11-20"); assert.equal(plan.extension_required, true);
  const h2 = harness(mst("2026-11-18", "10:05")); h2.register({ ...REFI, delivery_id: "dlv-refi-2", commitment_id_fnma: "C-2026-0003", commitment_expires_on: D("2026-11-20") }); await h2.freeze(mst("2026-11-18", "10:05"), { ...REFI, delivery_id: "dlv-refi-2", commitment_id_fnma: "C-2026-0003", commitment_expires_on: D("2026-11-20") }, "pkg-refi-2");
  const out = await h2.openTask(mst("2026-11-18", "10:06"), "dlv-refi-2");
  assert.equal(out.extension_requested, true); assert.equal(out.task_id, null); assert.equal(h2.svc.tasks.length, 0);
  const ext = h2.ofType("delivery.extension.requested").at(-1)!; assert.equal(ext.payload.expected_receipt_on, "2026-11-20"); assert.equal(ext.payload.receipt_deadline_on, "2026-11-19"); assert.equal(ext.payload.requested_of, "29.1");
  assert.equal(evaluateGate("29.1.deliveryCommitmentGate", { expires_on: "2026-11-20", today_et: "2026-11-18", custodian_receipt_possible_on: "2026-11-20" }).open, false);
});

test("29.4-T6: Given the custodian proposes a data revision (P&I 3,402.62 → 3,420.62) and the signed note reads 3,402.62, then the agent prepares a **decline** with the note page reference within `SM_LD_DATA_REVISION_RESPONSE_1BD`; given the note reads 3,420.62 (ULDD wrong), then the agent prepares an **accept** (Qualified Cert), emits `delivery.edit.observed` to 29.3, and opens an 25.2/26.1 review of the CD/note consistency.", async () => {
  const rev = { field: "pi_amount", custodian_value: "3420.62", seller_value: "3402.62", editable_by_custodian: true };
  const decline = dataRevisionDecision(rev, { value: "3402.62", page_ref: "note p. 1 ¶3" }); assert.equal(decline.case, "decline_note_reference"); assert.equal(decline.response, "declined"); assert.equal(decline.note_page_ref, "note p. 1 ¶3"); assert.equal(decline.edit_observed, false);
  const accept = dataRevisionDecision(rev, { value: "3420.62", page_ref: "note p. 1 ¶3" }); assert.equal(accept.case, "accept_qualified_cert"); assert.equal(accept.response, "accepted"); assert.equal(accept.edit_observed, true); assert.deepEqual([...accept.review_processes], ["29.3", "25.2", "26.1"]);
  assert.equal(dataRevisionDecision({ ...rev, field: "bailee_letter_name", editable_by_custodian: false }, { value: "x", page_ref: "n/a" }).case, "non_editable_operator_correction");
  const h = harness(mst("2026-11-13", "10:05")); h.register(); await h.freeze(mst("2026-11-13", "10:05")); const t = await h.openTask(mst("2026-11-13", "10:06")); await h.submit(String(t.task_id), et("2026-11-16", "13:31"));
  h.at(et("2026-11-17", "15:30"));
  const got = await h.run("trackShipment", { op: "data_revision_received", delivery_id: DLV, revision: rev, notice_document_id: "doc-dr-1", at: et("2026-11-17", "15:30") });
  assert.equal(got.response_due_on, "2026-11-18");   // +1 business_days_creditor
  const dr = h.timer("SM_LD_DATA_REVISION_RESPONSE_1BD")!; assert.equal(dr.status, "armed"); assert.equal(dr.dueDate, "2026-11-18");
  const prep = await h.run("trackShipment", { op: "data_revision_prepare", delivery_id: DLV, field: "pi_amount", note: { value: "3402.62", page_ref: "note p. 1 ¶3" }, at: et("2026-11-17", "15:35") });
  assert.equal(prep.response, "declined"); assert.equal(prep.note_page_ref, "note p. 1 ¶3"); assert.equal(h.svc.tasks.at(-1)!.kind, "data_revision_response"); assert.equal(h.escalations.list().at(-1)!.payload.response, "declined");
  await h.run("trackShipment", { op: "data_revision_responded", delivery_id: DLV, field: "pi_amount", accepted: false, operator_id: OPERATOR.id, evidence_document_id: "doc-dr-resp-1", at: et("2026-11-17", "16:00") }, OPERATOR);
  assert.equal(h.timer("SM_LD_DATA_REVISION_RESPONSE_1BD")!.status, "satisfied"); assert.equal(h.svc.get(DLV).certification_status, "awaiting_certification"); assert.equal(h.ofType("delivery.edit.observed").length, 0);
  // the note reads 3,420.62: the ULDD was wrong → accept (Qualified Cert), 29.3 corrects the source, 25.2/26.1 review
  await h.run("trackShipment", { op: "data_revision_received", delivery_id: DLV, revision: rev, at: et("2026-11-17", "16:30") });
  const prep2 = await h.run("trackShipment", { op: "data_revision_prepare", delivery_id: DLV, field: "pi_amount", note: { value: "3420.62", page_ref: "note p. 1 ¶3" }, at: et("2026-11-17", "16:35") }); assert.equal(prep2.response, "accepted");
  const resp = await h.run("trackShipment", { op: "data_revision_responded", delivery_id: DLV, field: "pi_amount", accepted: true, operator_id: OPERATOR.id, evidence_document_id: "doc-dr-resp-2", at: et("2026-11-17", "17:00") }, OPERATOR);
  assert.equal(resp.edit_observed, "delivery.edit.observed"); assert.deepEqual(resp.reviews, ["25.2", "26.1"]); assert.equal(h.svc.get(DLV).certification_status, "qualified_cert");
  const edit = h.ofType("delivery.edit.observed").at(-1)!; assert.equal(edit.payload.owner_process, "29.3"); assert.equal(edit.payload.corrected_value, "3420.62"); assert.equal(edit.payload.delivered_value, "3402.62"); assert.equal(edit.payload.source, "custodian_data_revision");
  assert.deepEqual(h.ofType("delivery.consistency_review.requested").map((e) => e.payload.process), ["25.2", "26.1"]);
});

test("29.4-T7: Given SM's warehouse org enters \"Supermortgage Warehouse Lending LLC\" while the bailee letterhead reads \"SUPERMORTGAGE WAREHOUSE LENDING, LLC\", then the platform's pre-check (byte comparison of `bailee_letter_name` to `bailee_letters.letterhead_text`) blocks the approval task; after correction the custodian's validation passes.", async () => {
  const bad = baileeNameCheck("Supermortgage Warehouse Lending LLC", LETTERHEAD); assert.equal(bad.matches, false); assert.equal(bad.entered_bytes, 35); assert.equal(bad.letterhead_bytes, 36); assert.match(bad.reason!, /byte comparison/);
  assert.equal(baileeNameCheck(LETTERHEAD, LETTERHEAD).matches, true); assert.equal(baileeNameCheck(LETTERHEAD.toLowerCase(), LETTERHEAD).matches, false);   // no case folding, no punctuation normalization
  const h = harness(et("2026-11-13", "12:00")); h.register(REFI, { ...WIRE, status: "pending", bailee_letter_name: null, approved_by_warehouse_at: null, approved_by_operator_id: null });
  await h.run("observeStatus", { op: "wire_listed", delivery_id: DLV, wire_instruction_id: "wire-sm-1", at: et("2026-11-13", "12:00") });
  assert.equal(h.timer("SM_WAREHOUSE_WIRE_APPROVAL_SLA_1BD")!.dueDate, "2026-11-16"); assert.equal(h.svc.tasks.at(-1)!.kind, "warehouse_wire_approval"); assert.equal(h.svc.tasks.at(-1)!.org, "sm_warehouse_org");
  const pre = await h.run("approveWarehouseWire", { op: "precheck", entered_letter_name: "Supermortgage Warehouse Lending LLC", letterhead_text: LETTERHEAD }); assert.equal(pre.matches, false);
  await h.refused(h.run("approveWarehouseWire", { delivery_id: DLV, wire_instruction_id: "wire-sm-1", entered_letter_name: LETTERHEAD, letterhead_text: LETTERHEAD }), "WAREHOUSE_WIRE_HUMAN_OPERATOR");   // the agent never approves
  const blocked = await h.run("approveWarehouseWire", { delivery_id: DLV, wire_instruction_id: "wire-sm-1", entered_letter_name: "Supermortgage Warehouse Lending LLC", letterhead_text: LETTERHEAD, at: et("2026-11-13", "12:10") }, WH_OPERATOR);
  assert.equal(blocked.blocked, true); assert.equal(blocked.status, "pending"); assert.equal(blocked.event, null); assert.equal(h.ofType("wire.instruction.precheck_failed").length, 1); assert.equal(h.timer("SM_WAREHOUSE_WIRE_APPROVAL_SLA_1BD")!.status, "armed");
  const ok = await h.run("approveWarehouseWire", { delivery_id: DLV, wire_instruction_id: "wire-sm-1", entered_letter_name: LETTERHEAD, letterhead_text: LETTERHEAD, at: et("2026-11-13", "12:20") }, WH_OPERATOR);
  assert.equal(ok.blocked, false); assert.equal(ok.status, "active"); assert.equal(ok.event, "wire.instruction.approved"); assert.equal(h.ofType("wire.instruction.approved").at(-1)!.payload.bailee_letter_name, LETTERHEAD); assert.equal(h.timer("SM_WAREHOUSE_WIRE_APPROVAL_SLA_1BD")!.status, "satisfied");
  assert.equal(h.svc.tasks.at(-1)!.outcome, "completed"); assert.equal(h.svc.wire("wire-sm-1")!.approved_by_operator_id, WH_OPERATOR.id);
  // segregation: the warehouse-org approver cannot also submit the delivery in the seller org
  await h.freeze(mst("2026-11-13", "10:05")); const t = await h.openTask(mst("2026-11-13", "12:30"));
  await h.refused(h.run("parseOperatorEvidence", { task_id: t.task_id, operator_id: WH_OPERATOR.id, evidence: EVIDENCE, hash_confirmed: true, captured_state: { fnma_loan_number: FNMA_NO, submitted_at: et("2026-11-16", "13:31"), commitment_number: "C-2026-0001" } }, WH_OPERATOR), "SEGREGATION_OF_DUTIES");
  // after the correction the custodian's validation passes; a failed validation cannot be certified
  await h.submit(String(t.task_id), et("2026-11-16", "13:31"));
  const cert = h.svc.recordCertification({ delivery_id: DLV, certified_at: et("2026-11-18", "07:15"), certification_kind: "certified", bailee_validation: "passed", bailee_letter_name_used: LETTERHEAD }); assert.equal(cert.certification.bailee_validation, "passed");
  assert.throws(() => h.svc.recordCertification({ delivery_id: DLV, certified_at: et("2026-11-18", "07:16"), certification_kind: "certified", bailee_validation: "failed" }), (e: unknown) => e instanceof DeliveryRefused && e.code === "BAILEE_VALIDATION_FAILED");
});

test("29.4-T8: Given the eNote fixture (Columbus) with eDelivery at 11:02 ET and a Transfer of Control and Location request with `effective_date = 2026-11-19`, then `FNMA_C1_2_04_ENOTE_TRANSFER_SAME_DAY_GATE` opens, submission is permitted, auto-certification is observed the same day, and `expected_purchase_date` = Fri Nov 20, 2026; given a request with `effective_date = 2026-11-20`, the gate stays closed.", async () => {
  const h = harness(et("2026-11-19", "10:00")); h.register(PURCH);
  await h.freeze(et("2026-11-19", "10:00"), PURCH, "pkg-purch-1", "b".repeat(64));
  const gate = h.timer("FNMA_C1_2_04_ENOTE_TRANSFER_SAME_DAY_GATE", LOAN_P)!; assert.equal(gate.status, "armed"); assert.match(gate.note ?? "", /29\.4\.enoteTransferSameDay/);
  assert.equal(evaluateGate("29.4.enoteTransferSameDay", { edelivered: false }).open, false);
  await h.refused(h.svc.requestEnoteTransfer({ delivery_id: DLV_P, op: "transfer", delegatee_on_file: false }), "ENOTE_CONTROLLER_CHANGE_NEEDS_DELEGATEE");
  h.at(et("2026-11-19", "11:02")); const ed = await h.run("requestEnoteTransfer", { op: "edeliver", delivery_id: DLV_P, at: et("2026-11-19", "11:02") }); assert.equal(ed.event, "enote.edelivered"); assert.equal((ed.gate as { open: boolean }).open, false);   // eDelivered, no transfer request yet
  h.at(et("2026-11-19", "11:05")); const tr = await h.run("requestEnoteTransfer", { op: "transfer", delivery_id: DLV_P, effective_date: "2026-11-19", at: et("2026-11-19", "11:05") });
  assert.equal(tr.event, "enote.transfer_of_control.requested"); assert.equal(tr.accepted, true); assert.equal((tr.gate as { open: boolean }).open, true); assert.equal(tr.same_day, true); assert.equal(tr.effective_date, "2026-11-19");
  assert.equal(h.timer("FNMA_C1_2_04_ENOTE_TRANSFER_SAME_DAY_GATE", LOAN_P)!.status, "satisfied"); assert.equal(await h.registry.secured_party(PURCH.min!), null);   // SM's Secured Party entry removed by the accepted transfer
  assert.equal(evaluateGate("29.4.enoteTransferSameDay", { edelivered: true, effective_date: "2026-11-19", request_date: "2026-11-19", master_servicer_org_id: "1000123", sm_org_id: "1000123", accepted: true }).open, true);
  // operator imports and submits 13:05 ET with the eNote Indicator; auto-certification the same day; purchase expected Fri Nov 20
  h.at(et("2026-11-19", "13:05")); const t = await h.run("openOperatorTask", { delivery_id: DLV_P, at: et("2026-11-19", "13:05"), gate_facts: GATE_FACTS });
  assert.equal((t.sheet as { enote_indicator: boolean }).enote_indicator, true);
  const sub = await h.run("parseOperatorEvidence", { task_id: t.task_id, operator_id: OPERATOR.id, evidence: EVIDENCE, hash_confirmed: true, captured_state: { fnma_loan_number: "1234567891", submitted_at: et("2026-11-19", "13:05"), commitment_number: "C-2026-0002", file_sha256: "b".repeat(64) }, at: et("2026-11-19", "13:05") }, OPERATOR);
  assert.equal(sub.outcome, "completed"); assert.equal(h.svc.get(DLV_P).loan_delivery_status, "purchase_requested"); assert.equal(h.ofType("custody.package.received", LOAN_P).at(-1)!.payload.custody_mode, "evault_auto");
  assert.equal(h.timer("FNMA_C2_2_01_CUSTODIAN_RECEIPT_BEFORE_EXPIRY", LOAN_P), undefined);   // no 21.4 link event in this harness; the eNote receipt stand-in would satisfy it
  h.at(et("2026-11-19", "18:30")); const cert = await h.run("trackShipment", { op: "certified", delivery_id: DLV_P, certified_at: et("2026-11-19", "18:30"), certification_kind: "auto_certified_enote", notice_document_id: "doc-autocert-1", at: et("2026-11-19", "18:30") });
  assert.equal(cert.purchase_ready_at, "2026-11-19"); assert.equal(cert.expected_purchase_date, "2026-11-20"); assert.equal(h.svc.get(DLV_P).certification_status, "auto_certified"); assert.equal(h.svc.get(DLV_P).status_source, "evault_event"); assert.equal(h.svc.get(DLV_P).expected_purchase_date, "2026-11-20");
  assert.equal(h.timer("FNMA_C2_2_04_PURCHASE_EXPECTED_1BD", LOAN_P)!.dueDate, "2026-11-20");
  const pkg = await h.run("prepareCustodianPackage", { delivery_id: DLV_P }); assert.equal(pkg.custody_mode, "evault_auto"); assert.deepEqual(pkg.documents, []);
  // a request with effective_date = Nov 20 on Nov 19: the gate stays closed and the submission is held
  const LOAN_Q = "loan-purch-2", DLV_Q = "dlv-purch-2"; h.register({ ...PURCH, delivery_id: DLV_Q, loan_id: LOAN_Q, application_id: "app-purchase-2", commitment_id_fnma: "C-2026-0004", min: "100012300000000038" });
  h.at(et("2026-11-19", "11:10")); await h.svc.requestEnoteTransfer({ delivery_id: DLV_Q, op: "edeliver", at: et("2026-11-19", "11:10") });
  const late = await h.svc.requestEnoteTransfer({ delivery_id: DLV_Q, op: "transfer", effective_date: D("2026-11-20"), at: et("2026-11-19", "11:12") });
  assert.equal(late.gate.open, false); assert.match(late.gate.reason!, /2026-11-20 ≠ request date 2026-11-19/); assert.equal(late.event.payload.same_day, false);
  assert.throws(() => h.svc.recordSubmission({ delivery_id: DLV_Q, fnma_loan_number: "1234567892", submitted_at: et("2026-11-19", "13:10"), operator_id: OPERATOR.id }), (e: unknown) => e instanceof DeliveryRefused && e.code === "FNMA_C1_2_04_ENOTE_TRANSFER_SAME_DAY_GATE");
  assert.equal(enoteTransferGate({ edelivered: true, effective_date: "2026-11-19", request_date: "2026-11-19", master_servicer_org_id: "9999999", sm_org_id: "1000123" }).open, false);   // Master Servicer must be SM's Org ID (29.4-Q7)
});

test("29.4-T9: Given a Purchase Advice with net proceeds $564,503.33 and the platform's expected range $564,503.33–$564,518.36 (day-count uncertainty), then the advice reconciles automatically and 27.2 receives `purchase_advice.reconciled{variance_cents=0}`; given net proceeds $563,803.33, then a component decomposition identifies an unexpected 0.125% LLPA line and the `officer` receives an adjustment-request package by Fri Nov 27, 2026 (within 30 days).", async () => {
  const exp = expectedProceeds({ upb_cents: 56_000_000n, price: "101.125000", pass_through_rate: "5.875", purchase_date: D("2026-11-19"), lpi_due_date: D("2026-12-01"), llpa_total_cents: 70_000n });
  assert.equal(exp.expected_net_low_cents, 56_450_333n); assert.equal(exp.expected_net_high_cents, 56_451_836n); assert.equal(formatCents(exp.expected_net_low_cents), "$564,503.33"); assert.equal(formatCents(exp.expected_net_high_cents), "$564,518.36");
  const auto = reconcileProceeds(ADVICE(), exp); assert.equal(auto.reconciled, true); assert.equal(auto.variance_cents, 0n); assert.equal(auto.day_count, "30_360"); assert.equal(auto.officer_package, false);
  assert.equal(reconcileProceeds(ADVICE({ net_proceeds_cents: 56_451_836n, interest_adjustment_cents: -108_164n }), exp).day_count, "act_365");
  const h = harness(mst("2026-11-13", "10:05")); await h.throughCertification(); await h.purchase();
  const r1 = await h.run("reconcileProceeds", { delivery_id: DLV, llpa_expected_cents: "70000", at: et("2026-11-20", "06:05") });
  assert.equal(r1.reconciled, true); assert.equal(r1.variance_cents, "0"); assert.equal(r1.escalation_id, null);
  const ev = h.ofType("purchase_advice.reconciled").at(-1)!; assert.equal(ev.payload.variance_cents, "0"); assert.deepEqual(ev.payload.consumers, ["27.2"]); assert.equal(ev.payload.expected_net_high_cents, "56451836");
  assert.equal(h.svc.advices[0]!.variance_cents, 0n); assert.equal(h.svc.advices[0]!.reconciled_at, et("2026-11-20", "06:05"));
  // $563,803.33: −$700.00 = an unexpected 0.125% LLPA line on $560,000 → officer package by Fri Nov 27 (advice Nov 19 + 5 Fannie Mae business days over Thanksgiving), inside the 30-day clock (Dec 19 / due-at Dec 18)
  const short = ADVICE({ purchase_advice_id: "pa-2", advice_date: D("2026-11-19"), net_proceeds_cents: 56_380_333n, llpa_total_cents: 140_000n, llpa_lines: [{ code: "LCOR_762_70", pct: "0.125", cents: 70_000n }, { code: "UNEXPECTED", pct: "0.125", cents: 70_000n }] });
  const rec = reconcileProceeds(short, exp); assert.equal(rec.reconciled, false); assert.equal(rec.variance_cents, -70_000n); assert.equal(formatCents(short.net_proceeds_cents), "$563,803.33");
  const llpa = rec.decomposition.find((d) => d.component === "llpa_line")!; assert.equal(llpa.cents, -70_000n); assert.match(llpa.detail, /unexpected LLPA line 0\.125% of UPB/); assert.equal(rec.decomposition.some((d) => d.component === "unexplained"), false);
  assert.equal(rec.officer_package, true); assert.equal(rec.fnma_error_indicated, true); assert.equal(rec.package_due_on, "2026-11-27"); assert.equal(rec.adjustment_request_due_on, "2026-12-19"); assert.equal(rec.adjustment_request_due_at_on, "2026-12-18");
  assert.equal(addBusinessDays(D("2026-11-19"), 5, fannieSifma), "2026-11-27");   // Nov 20, 23, 24, 25, 27 (Thanksgiving Thu Nov 26 closed)
  const h2 = harness(mst("2026-11-13", "10:05")); await h2.throughCertification(); await h2.purchase(short);
  const r2 = await h2.run("reconcileProceeds", { delivery_id: DLV, llpa_expected_cents: "70000", at: et("2026-11-20", "06:05") });
  assert.equal(r2.reconciled, false); assert.equal(r2.variance_cents, "-70000"); assert.ok(r2.escalation_id);
  const esc = h2.escalations.list().find((e) => e.id === r2.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.payload.task, "purchase_advice_adjustment_request"); assert.equal(esc.payload.package_due_on, "2026-11-27"); assert.equal(esc.payload.adjustment_request_due_on, "2026-12-19");
  assert.match(JSON.stringify(esc.payload.decomposition), /0\.125% of UPB/);
  await h2.refused(h2.run("reconcileProceeds", { delivery_id: DLV, llpa_expected_cents: "70000", file_adjustment_request: true }), "ADJUSTMENT_REQUEST_NEEDS_OFFICER");
});

test("29.4-T10: Given a fatal 3000-series commitment edit at import (commitment amount mismatch after a pair-off), then the operator task is returned `blocked{reason=commitment_edit}`, `delivery.edit.observed{fatal, prefix=numeric}` is emitted, 29.1 is notified, and no rebuild occurs in 29.3.", async () => {
  const cls = classifyImportEdits([{ edit_code: "3021", severity: "fatal", message: "commitment amount mismatch" }], []); assert.equal(cls.block, "commitment_edit"); assert.equal(cls.observed[0]!.prefix, "numeric"); assert.equal(cls.observed[0]!.owner_process, "29.1"); assert.equal(cls.observed[0]!.rebuild_required, false);
  assert.equal(classifyImportEdits([{ edit_code: "C0012", severity: "fatal" }], []).observed[0]!.rebuild_required, true); assert.equal(classifyImportEdits([{ edit_code: "D0450", severity: "warning" }], ["D0450"]).block, null); assert.equal(classifyImportEdits([{ edit_code: "D0451", severity: "warning" }], ["D0450"]).block, "unexpected_edit");
  const h = harness(mst("2026-11-13", "10:05")); h.register(); await h.freeze(mst("2026-11-13", "10:05")); const t = await h.openTask(mst("2026-11-13", "10:06"));
  const out = await h.submit(String(t.task_id), et("2026-11-16", "13:20"), { fnma_loan_number: undefined, submitted_at: undefined }, [{ edit_code: "3021", severity: "fatal", message: "commitment amount mismatch after pair-off" }]);
  assert.equal(out.outcome, "blocked"); assert.equal(out.blocked, "commitment_edit"); assert.equal(out.submitted, null);
  const task = h.svc.tasks.find((x) => x.task_id === t.task_id)!; assert.equal(task.outcome, "blocked"); assert.equal(task.block_reason, "commitment_edit");
  assert.equal(h.ofType("delivery.operator_task.blocked").at(-1)!.payload.reason, "commitment_edit");
  const edit = h.ofType("delivery.edit.observed").at(-1)!; assert.equal(edit.payload.fatal, true); assert.equal(edit.payload.prefix, "numeric"); assert.equal(edit.payload.owner_process, "29.1"); assert.equal(edit.payload.rebuild_required, false); assert.equal(edit.payload.source, "loan_delivery"); assert.equal(edit.payload.edit_code, "3021");
  const notified = h.ofType("delivery.commitment_edit.notified").at(-1)!; assert.equal(notified.payload.process, "29.1"); assert.deepEqual(notified.payload.edit_codes, ["3021"]); assert.equal(notified.payload.rebuild, false);
  assert.deepEqual(h.build.superseded, []); assert.equal(h.ofType("delivery.package.superseded").length, 0); assert.deepEqual(h.build.submitted, []);   // no 29.3 rebuild, no submission
  assert.equal(h.svc.get(DLV).loan_delivery_status, "draft"); assert.equal(h.ofType("delivery.submitted").length, 0); assert.equal(h.timer("SM_LOAN_DELIVERY_OPERATOR_SLA_1BD")!.status, "armed");
  // by contrast a fatal C-prefix (UCD) edit supersedes 29.3's package
  await h.freeze(mst("2026-11-16", "14:00"), REFI, "pkg-refi-1b", "c".repeat(64)); const t2 = await h.openTask(mst("2026-11-16", "14:01"));
  const out2 = await h.submit(String(t2.task_id), et("2026-11-16", "16:20"), {}, [{ edit_code: "C0012", severity: "fatal" }]); assert.equal(out2.blocked, "unexpected_edit"); assert.deepEqual(h.build.superseded, [`${DLV}:loan_delivery_fatal_edit`]);
});

test("29.4-T11: Given a post-purchase discovery on Mon Mar 8, 2027 that the delivered representative score should be 754 rather than 762, then a `post_purchase_adjustments` row is opened with `repricing_eligible = true` (acquisition Nov 19, 2026 + 18 months = May 19, 2028), the PPA .csv and evidence are prepared, and processing is expected by Mon Mar 22, 2027 (10 `business_days_fannie_et` from Mar 9); given an LLPA delta of −$50, no draft is expected ($100 minimum).", async () => {
  const attrs = [{ attribute: "Borrower Credit Score", delivered_value: "762", corrected_value: "754", evidence_document_id: "doc-score-1" }, { attribute: "Borrower Credit Score Source Type", delivered_value: "FICO", corrected_value: "FICO", evidence_document_id: "doc-score-1" }];
  const plan = preparePpa({ fnma_loan_number: FNMA_NO, acquisition_date: D("2026-11-19"), discovered_on: D("2027-03-08"), attributes: attrs, expected_llpa_delta_cents: 0n, submitted_on: D("2027-03-09") });
  assert.equal(plan.repricing_due_on, "2028-05-19"); assert.equal(addMonths(D("2026-11-19"), 18), "2028-05-19"); assert.equal(plan.repricing_eligible, true); assert.equal(plan.correction_required, true); assert.equal(plan.llpa_draft_expected, false);
  assert.deepEqual(plan.csv_rows[0], { "Fannie Mae Loan Number": FNMA_NO, Attribute: "Borrower Credit Score", "Delivered Value": "762", "Corrected Value": "754" }); assert.deepEqual([...plan.document_names], [`${FNMA_NO}_BorrowerCreditScore.pdf`, `${FNMA_NO}_BorrowerCreditScoreSourceType.pdf`]);
  // 10 business_days_fannie_et after Tue Mar 9, 2027 is Tue Mar 23 (Mar 10–12, 15–19, 22–23); the T-id's "Mon Mar 22" counts the submission day itself — R8 says Mar 23 (spec discrepancy, reported)
  assert.equal(plan.processing_expected_on, "2027-03-23"); assert.equal(ppaProcessingExpected(D("2027-03-09")), "2027-03-23"); assert.equal(addBusinessDays(D("2027-03-09"), 10, fannieSifma), "2027-03-23");
  assert.equal(preparePpa({ fnma_loan_number: FNMA_NO, acquisition_date: D("2026-11-19"), discovered_on: D("2028-05-20"), attributes: attrs, expected_llpa_delta_cents: -25_000n }).repricing_eligible, false);
  assert.equal(preparePpa({ fnma_loan_number: FNMA_NO, acquisition_date: D("2026-11-19"), discovered_on: D("2027-03-08"), attributes: attrs, expected_llpa_delta_cents: -5_000n }).llpa_draft_expected, false); assert.equal(PPA_LLPA_MINIMUM_CENTS, 10_000n);
  assert.equal(preparePpa({ fnma_loan_number: FNMA_NO, acquisition_date: D("2026-11-19"), discovered_on: D("2027-03-08"), attributes: attrs, expected_llpa_delta_cents: -10_000n }).llpa_draft_expected, true);
  const h = harness(mst("2026-11-13", "10:05")); await h.throughCertification(); await h.purchase();
  assert.equal(h.timer("FNMA_C1_2_02_PPA_LLPA_REPRICING_18M")!.dueDate, "2028-05-19");
  h.at(et("2027-03-08", "10:00")); const opened = await h.run("preparePpa", { delivery_id: DLV, discovered_at: et("2027-03-08", "10:00"), attributes: attrs, expected_llpa_delta_cents: "-5000", at: et("2027-03-08", "10:00") });
  assert.equal(opened.status, "open"); assert.equal(opened.repricing_eligible, true); assert.equal(opened.repricing_due_on, "2028-05-19"); assert.equal(opened.llpa_draft_expected, false);
  const row = h.rt.store.get("post_purchase_adjustments", String(opened.ppa_id))!.data; assert.equal(row.initiated_by, "seller"); assert.equal(row.repricing_eligible, true); assert.equal(row.status, "open");
  h.at(et("2027-03-09", "11:00")); const sub = await h.run("preparePpa", { op: "submitted", delivery_id: DLV, ppa_id: opened.ppa_id, operator_id: OPERATOR.id, at: et("2027-03-09", "11:00") }, OPERATOR);
  assert.equal(sub.status, "submitted"); assert.equal(sub.processing_expected_on, "2027-03-23"); assert.equal(h.ofType("ppa.requested").at(-1)!.payload.channel, "lsdu"); assert.equal(h.ofType("ppa.requested").at(-1)!.payload.llpa_relevant, false);
  const proc = h.timer("FNMA_PPA_PROCESSING_10BD")!; assert.equal(proc.status, "armed"); assert.equal(proc.dueDate, "2027-03-23");
  h.at(et("2027-03-19", "09:00")); const done = await h.run("preparePpa", { op: "processed", delivery_id: DLV, ppa_id: opened.ppa_id, notification_report_document_id: "doc-ppa-notice-1", llpa_draft_or_refund_cents: "0", at: et("2027-03-19", "09:00") });
  assert.equal(done.status, "processed"); assert.equal(h.timer("FNMA_PPA_PROCESSING_10BD")!.status, "satisfied"); assert.equal(h.ofType("ppa.resolved").at(-1)!.payload.llpa_draft_or_refund_cents, "0");
  // an LLPA-moving PPA needs the partner officer before the LSDU upload
  const open2 = await h.run("preparePpa", { delivery_id: DLV, discovered_at: et("2027-03-20", "10:00"), attributes: attrs, expected_llpa_delta_cents: "-25000", at: et("2027-03-20", "10:00") }); assert.equal(open2.llpa_draft_expected, true);
  await h.refused(h.run("preparePpa", { op: "submitted", delivery_id: DLV, ppa_id: open2.ppa_id, llpa_draft_expected: true }, OPERATOR), "PPA_MONEY_NEEDS_OFFICER");
  await h.refused(h.run("preparePpa", { op: "submitted", delivery_id: DLV, ppa_id: open2.ppa_id }, OPERATOR), "PPA_NEEDS_OFFICER");
});

test("29.4-T12: Given the loan is delivered with SFC 127, SID 322 populated, the final DU findings showing income and employment validated with close-by date Mon Dec 7, 2026 and consummation Fri Nov 6, then `rep_warrant_relief{limited_waiver_du, income_validated, employment_validated}.delivered_with_conditions_met = true` and `status = eligible`; given Fannie Mae's relief report lists the loan, then `confirmed_by_fnma` with `fnma_report_id`; given a Fannie Mae QC finding of undisclosed employment change, then `lost` (28.2).", async () => {
  const facts = { du_recommendation: "approve_eligible", sfc_codes: ["127", "007"], sid_322_casefile_id: "DU-CF-REFI-1", data_hash_matches: true, du_income_validated: true, du_employment_validated: true, close_by_date: D("2026-12-07"), consummation_date: D("2026-11-06"), unresolved_verification_messages: 0 };
  const ev = evaluateRelief(["limited_waiver_du", "income_validated", "employment_validated"], facts);
  assert.deepEqual(ev.map((e) => [e.component, e.delivered_with_conditions_met, e.status]), [["limited_waiver_du", true, "eligible"], ["income_validated", true, "eligible"], ["employment_validated", true, "eligible"]]);
  assert.equal(evaluateRelief(["limited_waiver_du"], { ...facts, sfc_codes: ["007"] })[0]!.delivered_with_conditions_met, false); assert.equal(evaluateRelief(["employment_validated"], { ...facts, consummation_date: D("2026-12-08") })[0]!.status, "at_risk");
  assert.equal(evaluateRelief(["payment_history_36"], { first_payment_date: D("2027-01-01"), purchase_date: D("2026-11-19") })[0]!.target_date, "2029-12-01");   // the 36th payment due date
  const h = harness(mst("2026-11-13", "10:05")); h.register(); await h.freeze(mst("2026-11-13", "10:05")); const t = await h.openTask(mst("2026-11-13", "10:06"));
  const out = await h.submit(String(t.task_id), et("2026-11-16", "13:31"), { relief_facts: { ...facts, close_by_date: "2026-12-07", consummation_date: "2026-11-06" }, relief_components: ["limited_waiver_du", "income_validated", "employment_validated"] });
  assert.deepEqual(out.relief, [{ component: "limited_waiver_du", delivered_with_conditions_met: true, status: "eligible" }, { component: "income_validated", delivered_with_conditions_met: true, status: "eligible" }, { component: "employment_validated", delivered_with_conditions_met: true, status: "eligible" }]);
  assert.equal(h.ofType("rep_warrant_relief.delivered").length, 3); assert.equal(h.svc.relief.find((r) => r.component === "limited_waiver_du")!.relief_id, `rwr:${APP}:limited_waiver_du`);
  await h.refused(h.run("evaluateRelief", { op: "confirm", delivery_id: DLV, component: "income_validated" }), "RELIEF_CONFIRM_NEEDS_FNMA_REPORT");
  const conf = await h.run("evaluateRelief", { op: "confirm", delivery_id: DLV, component: "income_validated", fnma_report_id: "RELIEF-2027Q1-0042", at: et("2027-02-15", "09:00") });
  assert.equal(conf.status, "confirmed_by_fnma"); assert.equal(conf.fnma_report_id, "RELIEF-2027Q1-0042"); assert.equal(h.ofType("rep_warrant_relief.confirmed").at(-1)!.payload.component, "income_validated");
  const lost = await h.run("observeStatus", { op: "relief_lost", delivery_id: DLV, component: "employment_validated", finding: "undisclosed employment change", qc_case_id: "lqc-case-7", at: et("2027-03-01", "09:00") });
  assert.equal(lost.status, "lost"); assert.equal(h.ofType("rep_warrant_relief.lost").at(-1)!.payload.owner, "28.2"); assert.equal(h.ofType("rep_warrant_relief.lost").at(-1)!.payload.qc_case_id, "lqc-case-7");
  assert.equal(h.svc.relief.find((r) => r.component === "limited_waiver_du")!.status, "eligible");
});

test("29.4-T13: Given a repurchase demand paid by the partner on Thu Apr 15, 2027 (within 60 days of a Mon Feb 22 demand), then 29.4 requests the note release (Form 2009-equivalent) or the eNote Transfer of Control from Fannie Mae, and servicing 5.6 reports LAR action code 65 on the removal clock; the platform blocks any 27.1 re-advance unless the facility flag `warehouse.repurchase_advance` is on.", async () => {
  const plan = remedyPlan({ demand_on: D("2027-02-22"), paid_on: D("2027-04-15"), note_form: "paper" }); assert.equal(plan.pay_by, "2027-04-23"); assert.equal(plan.within_60_days, true); assert.equal(plan.collateral_return.kind, "note_release_request"); assert.match(plan.collateral_return.form!, /Form 2009/); assert.equal(plan.lar_action_code, "65"); assert.equal(plan.readvance_allowed, false);
  assert.equal(remedyPlan({ demand_on: D("2027-02-22"), paid_on: D("2027-04-24"), note_form: "paper" }).within_60_days, false); assert.equal(remedyPlan({ demand_on: D("2027-02-22"), paid_on: null, note_form: "enote" }).collateral_return.kind, "enote_transfer_of_control"); assert.equal(remedyPlan({ demand_on: D("2027-02-22"), paid_on: null, note_form: "paper", liquidated: true }).collateral_return.kind, "none");
  assert.equal(remedyPlan({ demand_on: D("2027-02-22"), paid_on: null, note_form: "paper", flags: { "warehouse.repurchase_advance": true } }).readvance_allowed, true); assert.equal(remedyPlan({ demand_on: D("2027-02-22"), paid_on: null, note_form: "paper", arm_modification_feature: true }).lar_action_code, "67");
  const h = harness(mst("2026-11-13", "10:05")); await h.throughCertification(); await h.purchase();
  await h.refused(h.run("prepareRemedyPackage", { delivery_id: DLV, repurchase_id: "rp-1", demand_on: "2027-02-22", paid_on: "2027-04-15", officer_approved: true }), "REMEDY_PAYMENT_OFFICER");
  await h.refused(h.run("prepareRemedyPackage", { delivery_id: DLV, repurchase_id: "rp-1", demand_on: "2027-02-22", paid_on: "2027-04-15", readvance: true, flags: {} }), "READVANCE_NEEDS_FACILITY_FLAG");
  h.at(et("2027-04-15", "15:00"));
  await h.refused(h.run("prepareRemedyPackage", { delivery_id: DLV, repurchase_id: "rp-1", demand_on: "2027-02-22", paid_on: "2027-04-15", at: et("2027-04-15", "15:00") }), "REMEDY_PAYMENT_NEEDS_OFFICER");
  const r = await h.run("prepareRemedyPackage", { delivery_id: DLV, repurchase_id: "rp-1", demand_on: "2027-02-22", paid_on: "2027-04-15", officer_approval_document_id: "doc-officer-repurchase-1", at: et("2027-04-15", "15:00") });
  assert.equal(r.within_60_days, true); assert.equal(r.collateral_event, "remedy.collateral_return.requested"); assert.equal(r.lar_action_code, "65"); assert.equal(r.lar_blocked, false); assert.equal(r.readvance_event, "remedy.readvance.refused"); assert.equal(r.case_owner, "28.2");
  assert.match(String(h.ofType("remedy.collateral_return.requested").at(-1)!.payload.form), /Form 2009-equivalent/);
  const lar = h.ofType("investor_events.projected").at(-1)!; assert.equal(lar.payload.action_code, "65"); assert.equal(lar.payload.event_type, "removal.repurchase"); assert.equal(lar.payload.effective_date, "2027-04-15"); assert.equal(h.ofType("repurchase.processed").length, 1);
  assert.equal(String(lar.payload.due_at), et("2027-04-16", "20:00"));   // 5.6's removal clock: next Fannie Mae business day 20:00 ET
  assert.equal(h.ofType("remedy.readvance.refused").at(-1)!.payload.flag, "warehouse.repurchase_advance");
  const eh = harness(et("2026-11-19", "10:00")); eh.register(PURCH); eh.svc.get(DLV_P).purchase_date = D("2026-11-20");
  const er = eh.svc.remedy({ delivery_id: DLV_P, repurchase_id: "rp-2", demand_on: D("2027-02-22"), paid_on: D("2027-04-15"), officer_approval_document_id: "doc-officer-repurchase-2", flags: { "warehouse.repurchase_advance": true }, at: et("2027-04-15", "15:00") });
  assert.equal(er.collateral!.type, "enote.transfer_of_control.requested"); assert.equal(er.collateral!.payload.direction, "fannie_mae_to_partner"); assert.equal(er.readvance, null); assert.equal(er.plan.readvance_allowed, true);
});

test("29.4-T14: Given the Purchase Advice Sellers API returns no advice for two consecutive business days after `purchase_ready`, then a `fnma_portal_operator` task to download the Fannie Mae Connect Whole Loan Purchase Advice report is opened and `FNMA_C2_2_04_PURCHASE_EXPECTED_1BD` breach handling verifies payee code and commitment status.", async () => {
  assert.equal(adviceLagCheck(D("2026-11-18"), D("2026-11-19"), false).connect_report_task, false); assert.equal(adviceLagCheck(D("2026-11-18"), D("2026-11-20"), false).business_days_without_advice, 2); assert.equal(adviceLagCheck(D("2026-11-18"), D("2026-11-20"), true).connect_report_task, false);
  assert.deepEqual([...adviceLagCheck(D("2026-11-18"), D("2026-11-20"), false).checks], ["payee_code_active", "no_purchase_error", "commitment_valid"]);
  const h = harness(mst("2026-11-13", "10:05")); await h.throughCertification();
  h.at(et("2026-11-19", "06:00")); const day1 = await h.run("ingestPurchaseAdvice", { op: "lag", delivery_id: DLV, today: "2026-11-19", at: et("2026-11-19", "06:00") }); assert.equal(day1.task_id, null);
  h.at(et("2026-11-20", "06:00")); const breaches = h.timers.evaluate(et("2026-11-20", "06:00")); assert.ok(breaches.some((b) => b.def.code === "FNMA_C2_2_04_PURCHASE_EXPECTED_1BD")); assert.equal(h.timer("FNMA_C2_2_04_PURCHASE_EXPECTED_1BD")!.status, "breached");
  const day2 = await h.run("ingestPurchaseAdvice", { op: "lag", delivery_id: DLV, today: "2026-11-20", at: et("2026-11-20", "06:00") });
  assert.equal(day2.business_days_without_advice, 2); assert.ok(day2.task_id); assert.ok(day2.breach_check_task_id);
  const task = h.svc.tasks.find((t) => t.task_id === day2.task_id)!; assert.equal(task.kind, "connect_purchase_advice_download");
  const esc = h.escalations.list().find((e) => e.id === task.escalation_id)!; assert.equal(esc.kind, "human_portal_task"); assert.equal(esc.ownerRole, "fnma_portal_operator"); assert.equal(esc.payload.report, "Fannie Mae Connect Whole Loan Purchase Advice"); assert.equal(esc.payload.fnma_loan_number, FNMA_NO);
  const check = h.svc.tasks.find((t) => t.task_id === day2.breach_check_task_id)!; const cesc = h.escalations.list().find((e) => e.id === check.escalation_id)!;
  assert.equal(cesc.payload.timer, "FNMA_C2_2_04_PURCHASE_EXPECTED_1BD"); assert.equal(cesc.payload.payee_code_active, true); assert.equal(cesc.payload.no_purchase_error, true); assert.equal(cesc.payload.commitment_valid, true); assert.deepEqual(cesc.payload.checks, ["payee_code_active", "no_purchase_error", "commitment_valid"]);
  // the Connect report resolves it: the ingest from the report closes the breached row late
  const r = await h.purchase(ADVICE({ source: "connect_report", raw_payload_document_id: "doc-connect-report-1" }), et("2026-11-20", "11:00")); assert.equal(r.loan_purchased_emitted, true); assert.equal(h.svc.get(DLV).status_source, "connect_report"); assert.equal(h.timer("FNMA_C2_2_04_PURCHASE_EXPECTED_1BD")!.status, "satisfied_late");
  assert.equal(warehouseReleaseGate({ release_effective_on: "2026-11-19", purchase_date: "2026-11-19" }).open, true); assert.equal(warehouseReleaseGate({ release_effective_on: "2026-11-20", purchase_date: "2026-11-19" }).open, false); assert.equal(evaluateGate("29.4.warehouseReleaseByAcquisition", { purchase_date: "2026-11-19" }).open, false);
  const decision = h.svc.decisionRecord(DLV, "worked example A"); assert.equal(decision.deadlines.custodian_receipt, et("2026-12-04", "07:30")); assert.equal(decision.deadlines.lpi_45, "2027-01-15"); assert.equal(decision.deadlines.loan_age_6m, "2027-06-30"); assert.equal(decision.wire!.payee_code, "SMWH1"); assert.equal(decision.rule_set_versions.selling, "fnma.selling.2026-09-02");
});

test("29.4 worked figures: principal proceeds $566,300.00 (56,000,000 × 1.01125); prepaid interest Nov 19–30 = 12 days −$1,096.67 (30/360) / −$1,081.64 (act/365); LLPA 0.125% = $700.00; net $564,503.33 (range to $564,518.36); variance case $563,803.33; SM advance $548,800.00 (98%) × 6.80% ÷ 360 = $103.66 for the one-day slip", () => {
  assert.equal(principalProceedsCents(56_000_000n, "101.125000"), 56_630_000n); assert.equal(formatCents(56_630_000n), "$566,300.00");
  const ia = interestAdjustment(56_000_000n, "5.875", D("2026-11-19"), D("2026-12-01")); assert.equal(ia.days, 12); assert.equal(ia.prepaid, true); assert.equal(ia.cents_30_360, -109_667n); assert.equal(ia.cents_act_365, -108_164n);
  assert.equal(formatCents(-ia.cents_30_360), "$1,096.67"); assert.equal(formatCents(-ia.cents_act_365), "$1,081.64");
  assert.equal(interestAdjustment(56_000_000n, "5.875", D("2026-12-10"), D("2026-12-01")).prepaid, false); assert.equal(interestAdjustment(56_000_000n, "5.875", D("2026-12-10"), D("2026-12-01")).days, 9);   // LPI before the purchase date: Fannie Mae purchases accrued interest
  assert.equal(interestAdjustment(56_000_000n, "5.875", D("2026-11-19"), D("2026-12-01"), "scheduled_scheduled").days, 18);   // S/S: from the first of the purchase month
  const exp = expectedProceeds({ upb_cents: 56_000_000n, price: "101.125000", pass_through_rate: "5.875", purchase_date: D("2026-11-19"), lpi_due_date: D("2026-12-01"), llpa_total_cents: 70_000n });
  assert.equal(exp.principal_proceeds_cents, 56_630_000n); assert.equal(exp.llpa_total_cents, 70_000n); assert.equal(formatCents(70_000n), "$700.00");
  assert.equal(exp.expected_net_cents, 56_630_000n - 109_667n - 70_000n); assert.equal(exp.expected_net_cents, 56_450_333n); assert.equal(formatCents(exp.expected_net_cents), "$564,503.33"); assert.equal(exp.expected_net_high_cents, 56_451_836n); assert.equal(formatCents(exp.expected_net_high_cents), "$564,518.36");
  assert.equal(reconcileProceeds(ADVICE({ net_proceeds_cents: 56_380_333n, llpa_total_cents: 140_000n, llpa_lines: [{ code: "A", pct: "0.125", cents: 70_000n }, { code: "B", pct: "0.125", cents: 70_000n }] }), exp).variance_cents, -70_000n); assert.equal(formatCents(56_380_333n), "$563,803.33");
  assert.equal(advanceCents(56_000_000n, 98), 54_880_000n); assert.equal(formatCents(54_880_000n), "$548,800.00");
  assert.equal(warehouseSlipCostCents(54_880_000n, 680, 1), 10_366n); assert.equal(formatCents(10_366n), "$103.66");   // 548,800 × 0.0680 ÷ 360 = 103.66 (SOFR 4.30% + 2.50%, act/360)
  assert.equal(warehouseSlipCostCents(54_880_000n, 680, 7), 72_564n);   // 27.1's 7-day fixture total ($725.64, cumulative rounding)
});
