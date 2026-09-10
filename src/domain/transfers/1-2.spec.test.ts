// 1.2 Servicing transfer approval from Fannie Mae
// spec/sections/01-boarding-servicing-transfer-in/1-2-servicing-transfer-approval-from-fannie-mae.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { loadRegistry, TimerEngine } from "../../kernel/timers/index.ts";
import { EscalationService } from "../../app/escalations.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { applyTransferTimerOverrides } from "./timers.ts";
import { applySatisfiedOverrides_1_2 } from "./timers-1-2.ts";
import { form629Clocks, transferDateGate } from "./batch.ts";
import { openForm629PortalTask, packageReadyGates, packageReadyGateBlock, FORM629_PORTAL_TASK_SLA } from "./ops-1-2.ts";
import { batchTransitionBlock, portalTaskStatus, parseConsentNotice, withdrawFromList, attestationSatisfies, attestList, proposeBatch, TransferBatchService, TransferDateGateClosed, BatchTransitionRefused, escalateBreach, batchReport, loanListFreezeOn, type LoanListLoan, type LoanListVersion } from "./inbound.ts";
const OFFICER = { kind: "human" as const, id: "u-officer", role: "officer" };
const OPERATOR: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };
const AGENT: Actor = { kind: "agent", id: "transfer" };
const PACKAGE = { form629_document_id: "doc-629", loan_list_version: 1, custodian_matrix_document_id: "doc-matrix", dq_precheck_passed: true };
/** A partner's first batch: Form 101 at inception, CBAM-executed Forms 1013/1014 (6.1/6.2) and the Form 2017 for the transferee custodian (1.4). */
const FIRST_BATCH_FORMS = { form101_document_id: "doc-101", form1013_document_id: "doc-1013", form1014_document_id: "doc-1014", form2017_document_id: "doc-2017", form2017_custodian: "custodian-x", transferee_custodian: "custodian-x" };
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const registry = loadRegistry(); applyTransferTimerOverrides(registry); applySatisfiedOverrides_1_2(registry);
  const timers = new TimerEngine(registry, events, { processes: ["1.2"] });
  const esc = new EscalationService(events, clock);
  return { clock, events, timers, esc, registry, svc: new TransferBatchService({ events, clock }) };
}

test("1.2-T1: Given a master-to-sub batch with transfer date Oct. 1, 2026, when proposed on Aug. 20, 2026, then `FNMA_A2_7_03_FORM629_SUBSERVICING_30` due = Sept. 1, 2026 and `SM_FORM629_INTERNAL_BUFFER_7` = Aug. 25, 2026.", () => {
  const { clock, events, timers, esc, registry, svc } = harness("2026-08-20T14:00:00.000Z");
  const b = svc.propose({ batch_id: "B1", type: "master_to_sub", transfer_date: D("2026-10-01"), first_batch_for_partner: false, loan_count: 5000 }, AGENT);
  assert.equal(b.status, "proposed");
  const thirty = timers.byCode("FNMA_A2_7_03_FORM629_SUBSERVICING_30"), buffer = timers.byCode("SM_FORM629_INTERNAL_BUFFER_7");
  assert.equal(thirty.length, 1); assert.equal(thirty[0]!.dueDate, "2026-09-01"); assert.equal(thirty[0]!.anchorDate, "2026-10-01");
  assert.equal(buffer.length, 1); assert.equal(buffer[0]!.dueDate, "2026-08-25");                       // Form 629 deadline − 7
  assert.equal(timers.byCode("FNMA_A2_7_03_FORM629_SERVICING_60").length, 0);                            // the 60-day clock is for servicing sales only
  assert.deepEqual(form629Clocks("master_to_sub", D("2026-10-01")), { deadline: D("2026-09-01"), internal_buffer: D("2026-08-25"), rule: "30_day_subservicing", liability_start: D("2026-10-01") });
  // The Form 629 portal task is filed from `package_ready`: its `escalation.created{kind=human_portal_task, task=form629}` is the registry trigger of SM_PORTAL_TASK_FORM629_SLA_2 (+2 servicer business days from `created_at`).
  svc.transition("B1", "package_ready", { ...PACKAGE, form101_document_id: "doc-101" }, AGENT);
  const task = openForm629PortalTask({ events, clock, escalations: esc, batch: svc.get("B1") }, { batch_id: "B1", package_document_id: "doc-629", custodian_matrix_document_id: "doc-matrix", loan_list_version: 1, transfer_type: "master_to_sub", transfer_date: D("2026-10-01"), transferor_servicer_number: "123456789", transferee_servicer_number: "987654321" }, AGENT);
  assert.deepEqual([task.kind, task.task, task.ownerRole, task.batchId, task.status, task.checklist.missing], ["human_portal_task", "form629", "fnma_portal_operator", "B1", "open", []]);
  assert.equal(task.event.type, "escalation.created"); assert.equal(eventMatches(registry.get(FORM629_PORTAL_TASK_SLA)!.triggerPattern!, task.event), true);
  assert.deepEqual([task.event.payload.kind, task.event.payload.task, task.event.payload.batch_id, task.event.payload.package_document_id, task.event.payload.created_at], ["human_portal_task", "form629", "B1", "doc-629", "2026-08-20T14:00:00.000Z"]);
  assert.equal(svc.get("B1").portal_task_ids[0], task.id);                                              // the batch tracks its portal task
  const sla = timers.byCode(FORM629_PORTAL_TASK_SLA); assert.equal(sla.length, 1);
  assert.deepEqual([sla[0]!.status, sla[0]!.anchorDate, sla[0]!.dueDate, sla[0]!.subject], ["armed", "2026-08-20", addBusinessDays(D("2026-08-20"), 2, servicer), { kind: "escalation", id: task.id }]);
  assert.equal(sla[0]!.dueDate, "2026-08-24");                                                          // Thu Aug 20 + 2 servicer business days = Mon Aug 24
  assert.equal(task.sla.due, "2026-08-24");
  // Completed by the fnma_portal_operator on Aug 24 with the Quick Exchange confirmation: `escalation.completed` satisfies the SLA; the completion record moves the batch to `submitted`; `transfer.form629.submitted` satisfies both Form 629 clocks.
  clock.set("2026-08-24T15:00:00.000Z");
  assert.throws(() => esc.complete(task.id, AGENT, "doc-qx-confirmation"), RangeError);                  // the agent never submits (portal-only)
  esc.complete(task.id, OPERATOR, "doc-qx-confirmation");
  assert.equal(svc.get("B1").status, "submitted"); assert.equal(svc.get("B1").evidence.portal_completion_record_id, "doc-qx-confirmation");
  assert.equal(events.ofType("transfer.form629.submitted")[0]!.payload.form629_submitted_by, "u-portal");
  assert.equal(thirty[0]!.status, "satisfied"); assert.equal(buffer[0]!.status, "satisfied");
  assert.equal(sla[0]!.status, "satisfied"); assert.equal(sla[0]!.satisfiedByEventId, events.ofType("escalation.completed")[0]!.id);
});
test("1.2-T2: Given a proposed transfer date of Oct. 2, 2026, then the `proposeBatch` command is rejected by `FNMA_A2_7_03_TRANSFER_DATE_GATE`.", () => {
  const { events, timers, svc } = harness("2026-08-20T14:00:00.000Z");
  assert.throws(() => proposeBatch(events, { batch_id: "B2", type: "master_to_sub", transfer_date: D("2026-10-02") }, AGENT), (e: unknown) => e instanceof TransferDateGateClosed && e.gate === "FNMA_A2_7_03_TRANSFER_DATE_GATE" && e.expected === "2026-10-01");
  assert.throws(() => svc.propose({ batch_id: "B2", type: "master_to_sub", transfer_date: D("2026-10-02") }, AGENT), TransferDateGateClosed);
  assert.equal(events.all().length, 0, "a refused command writes nothing"); assert.equal(timers.all().length, 0);
  assert.deepEqual(transferDateGate(D("2026-10-02")), { ok: false, gate: "FNMA_A2_7_03_TRANSFER_DATE_GATE", expected: D("2026-10-01") });
  assert.equal(evaluateGate("1.2.transferDateIsFirstFannieBusinessDay", { transfer_date: "2026-10-02", first_fannie_business_day_of_month: "2026-10-01" }).open, false);
  assert.equal(svc.propose({ batch_id: "B3", type: "master_to_sub", transfer_date: D("2026-11-02") }, AGENT).status, "proposed");   // Nov 1, 2026 is a Sunday → Mon Nov 2
});
test("1.2-T3: Given a servicing sale with sale date Sept. 15, 2026, then the 60-day deadline anchors on Sept. 15 (July 17, 2026), not on the transfer date.", () => {
  const { timers, svc } = harness("2026-07-01T14:00:00.000Z");
  svc.propose({ batch_id: "B1", type: "servicing_sale_with_sub", transfer_date: D("2026-10-01"), sale_date: D("2026-09-15") }, AGENT);
  const sixty = timers.byCode("FNMA_A2_7_03_FORM629_SERVICING_60");
  assert.equal(sixty.length, 1); assert.equal(sixty[0]!.anchorDate, "2026-09-15"); assert.equal(sixty[0]!.dueDate, "2026-07-17");
  assert.equal(timers.byCode("SM_FORM629_INTERNAL_BUFFER_7")[0]!.dueDate, "2026-07-10");
  assert.equal(timers.byCode("FNMA_A2_7_03_FORM629_SUBSERVICING_30").length, 0);
  const c = form629Clocks("servicing_sale_with_sub", D("2026-10-01"), D("2026-09-15")); assert.equal(c.deadline, "2026-07-17"); assert.equal(c.liability_start, "2026-09-15");   // joint-and-several liability from the earlier date
  assert.equal(form629Clocks("servicing_sale_with_sub", D("2026-10-01"), D("2026-10-15")).deadline, "2026-08-02");   // a later sale date does not move the anchor off the transfer date
});
test("1.2-T4: Given no Form 101 evidence for a first batch, then the batch cannot reach `package_ready`.", () => {
  assert.match(batchTransitionBlock("proposed", "package_ready", { ...PACKAGE, ...FIRST_BATCH_FORMS, first_batch_for_partner: true, form101_document_id: null })!, /FNMA_A2_1_07_FORM101_INCEPTION/);
  assert.equal(batchTransitionBlock("proposed", "package_ready", { ...PACKAGE, ...FIRST_BATCH_FORMS, first_batch_for_partner: true }), null);
  assert.equal(batchTransitionBlock("proposed", "package_ready", { ...PACKAGE, first_batch_for_partner: false }), null);   // a later batch needs no new Form 101: the arrangement's forms are on file
  // The two "same"-trigger gates of the timer table close `package_ready` the same way (Forms 1013/1014 via CBAM, 6.1/6.2; Form 2017 for the transferee custodian, 1.4).
  assert.match(packageReadyGateBlock({ ...PACKAGE, ...FIRST_BATCH_FORMS, first_batch_for_partner: true, form1014_document_id: null })!, /^FNMA_A2_1_07_FORMS_1013_1014_GATE/);
  assert.match(packageReadyGateBlock({ ...PACKAGE, ...FIRST_BATCH_FORMS, first_batch_for_partner: true, form2017_document_id: null })!, /^FNMA_A2_7_03_FORM2017_GATE/);
  assert.match(packageReadyGateBlock({ ...PACKAGE, ...FIRST_BATCH_FORMS, first_batch_for_partner: true, form2017_custodian: "custodian-y" })!, /FNMA_A2_7_03_FORM2017_GATE: Form 2017 names custodian custodian-y, not the transferee custodian custodian-x/);
  assert.deepEqual(packageReadyGates({ ...PACKAGE, first_batch_for_partner: true }).map((g) => [g.code, g.applies, g.ok]), [["FNMA_A2_1_07_FORM101_INCEPTION", true, false], ["FNMA_A2_1_07_FORMS_1013_1014_GATE", true, false], ["FNMA_A2_7_03_FORM2017_GATE", true, false]]);
  assert.deepEqual(packageReadyGates({ ...PACKAGE, first_batch_for_partner: false }).map((g) => [g.applies, g.ok]), [[false, true], [false, true], [false, true]]);
  assert.equal(evaluateGate("1.2.form101Present", { form101_document_id: null }).open, false); assert.equal(evaluateGate("1.2.form101Present", { form101_document_id: "doc-101" }).open, true);
  assert.equal(evaluateGate("1.2.forms1013And1014Executed", { form_1013_executed: true, form_1014_executed: false }).open, false);
  assert.equal(evaluateGate("1.2.form2017ValidForCustodian", { form_2017_valid: true, form_2017_custodian: "custodian-y", transferee_custodian: "custodian-x" }).open, false);
  // On the batch case: the first batch is refused at every missing form and stays `proposed`; with the full evidence it reaches `package_ready`.
  const { svc } = harness("2026-08-20T14:00:00.000Z");
  svc.propose({ batch_id: "B4", type: "master_to_sub", transfer_date: D("2026-10-01"), first_batch_for_partner: true }, AGENT);
  assert.throws(() => svc.transition("B4", "package_ready", PACKAGE, AGENT), (e: unknown) => e instanceof BatchTransitionRefused && /^FNMA_A2_1_07_FORM101_INCEPTION/.test(e.block));
  assert.throws(() => svc.transition("B4", "package_ready", { ...PACKAGE, form101_document_id: "doc-101" }, AGENT), (e: unknown) => e instanceof BatchTransitionRefused && /^FNMA_A2_1_07_FORMS_1013_1014_GATE/.test(e.block));
  assert.throws(() => svc.transition("B4", "package_ready", { ...PACKAGE, form101_document_id: "doc-101", form1013_document_id: "doc-1013", form1014_document_id: "doc-1014" }, AGENT), (e: unknown) => e instanceof BatchTransitionRefused && /^FNMA_A2_7_03_FORM2017_GATE/.test(e.block));
  assert.equal(svc.get("B4").status, "proposed");
  assert.equal(svc.transition("B4", "package_ready", { ...PACKAGE, ...FIRST_BATCH_FORMS }, AGENT).status, "package_ready");
});
test("1.2-T5: Given the portal task is not completed within 2 servicer business days, then an `officer` escalation is created and the batch report shows the breach.", () => {
  const s = portalTaskStatus(D("2026-09-24"), D("2026-09-28"));            // Thu → due Mon Sep 28
  assert.equal(s.due, "2026-09-28"); assert.equal(s.breached, false); assert.equal(s.escalation, null);
  const late = portalTaskStatus(D("2026-09-24"), D("2026-09-29"));
  assert.deepEqual([late.breached, late.escalation], [true, "officer"]);
  assert.equal(batchTransitionBlock("package_ready", "submitted", { portal_completion_record_id: null }), "submitted requires a fnma_portal_operator completion record");
  // Through the timers: the filed portal task (`escalation.created{kind=human_portal_task, task=form629}`) arms SM_PORTAL_TASK_FORM629_SLA_2 on the escalation; on Sept 29 it breaches, the officer escalation is opened from the breach and the batch report lists it.
  const { clock, events, timers, esc } = harness("2026-09-24T14:00:00.000Z");
  assert.throws(() => openForm629PortalTask({ events, clock, escalations: esc }, { batch_id: "", package_document_id: "doc-629" }, AGENT), RangeError);
  assert.throws(() => openForm629PortalTask({ events, clock, escalations: esc }, { batch_id: "B1", package_document_id: "" }, AGENT), RangeError);
  assert.throws(() => openForm629PortalTask({ events, clock, escalations: esc, batch: { status: "proposed" } }, { batch_id: "B1", package_document_id: "doc-629" }, AGENT), /is proposed: the Form 629 portal task is filed from package_ready/);
  assert.equal(events.all().length, 0, "a refused command writes nothing");
  const task = openForm629PortalTask({ events, clock, escalations: esc }, { batch_id: "B1", package_document_id: "doc-629" }, AGENT);
  assert.deepEqual([task.sla.timer_code, task.sla.assigned_on, task.sla.due, task.checklist.attached], [FORM629_PORTAL_TASK_SLA, "2026-09-24", "2026-09-28", ["form_629"]]);
  assert.equal(esc.opened[0], task, "registered with the EscalationService so the operator's completion closes it");
  const sla = timers.byCode(FORM629_PORTAL_TASK_SLA); assert.equal(sla.length, 1); assert.equal(sla[0]!.dueDate, "2026-09-28"); assert.equal(sla[0]!.armedByEventId, task.event.id);
  assert.deepEqual(timers.forSubject("escalation", task.id).map((t) => t.code), [FORM629_PORTAL_TASK_SLA]);
  assert.equal(timers.evaluate("2026-09-28T20:00:00.000Z").length, 0);
  clock.set("2026-09-29T14:00:00.000Z");
  const breaches = timers.evaluate(clock.now()); assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, FORM629_PORTAL_TASK_SLA); assert.ok(breaches[0]!.escalateTo.includes("officer"));
  const e = escalateBreach(esc, breaches[0]!, AGENT, { batchId: "B1" });
  assert.equal(e.ownerRole, "officer"); assert.equal(esc.opened.filter((x) => x.ownerRole === "officer").length, 1);
  assert.ok(events.ofType("escalation.created").some((x) => x.payload.owner_role === "officer" && x.payload.timer_code === FORM629_PORTAL_TASK_SLA));
  const report = batchReport(timers, "B1", [task.id]);
  assert.deepEqual(report.breaches, [{ code: FORM629_PORTAL_TASK_SLA, due_date: D("2026-09-28"), breached_at: "2026-09-29T14:00:00.000Z" }]);
  // The late completion still closes the task: the SLA ends `satisfied_late`, and the report keeps the breach.
  esc.complete(task.id, OPERATOR, "doc-qx-confirmation");
  assert.equal(sla[0]!.status, "satisfied_late"); assert.equal(batchReport(timers, "B1", [task.id]).breaches.length, 1);
});
test("1.2-T6: Given a consent notice with conditions, when parsed, then `approved` is blocked until an `officer` confirms the parsed D-Code and conditions.", () => {
  const parsed = parseConsentNotice("Fannie Mae approves the servicing transfer effective 2026-10-01, D-Code D12, subject to delivery of custodial documents to Custodian X; provided that Form 2017 is executed.");
  assert.equal(parsed.outcome, "approved"); assert.equal(parsed.d_code, "D12"); assert.equal(parsed.effective_date, "2026-10-01");
  assert.equal(parsed.conditions.length, 2); assert.equal(parsed.officer_confirmation_required, true);
  assert.match(batchTransitionBlock("submitted", "approved", { consent_document_hash: "sha256:abc", consent_conditions: parsed.conditions })!, /officer must confirm/);
  assert.equal(batchTransitionBlock("submitted", "approved", { consent_document_hash: "sha256:abc", consent_conditions: parsed.conditions, officer_confirmed_conditions: true }), null);
  assert.equal(parseConsentNotice("Request denied.").outcome, "denied");
  // On the batch case: the agent records the parse; `approved` is refused until the officer's confirmation, then `transfer.batch.approved` carries the D-Code, consent and freeze date.
  const { events, svc, timers } = harness("2026-09-05T14:00:00.000Z");
  svc.propose({ batch_id: "B1", type: "master_to_sub", transfer_date: D("2026-10-01"), first_batch_for_partner: false }, AGENT);
  svc.transition("B1", "package_ready", PACKAGE, AGENT); svc.transition("B1", "submitted", { portal_completion_record_id: "doc-qx" }, OPERATOR);
  svc.recordApproval("B1", { d_code: parsed.d_code, fnma_consent_document_id: "doc-consent", consent_document_hash: "sha256:abc", conditions: parsed.conditions }, false);
  assert.throws(() => svc.transition("B1", "approved", {}, AGENT), /officer must confirm/);
  assert.equal(events.ofType("transfer.batch.approved").length, 0);
  svc.recordApproval("B1", { d_code: parsed.d_code, fnma_consent_document_id: "doc-consent", consent_document_hash: "sha256:abc", conditions: parsed.conditions }, true);
  assert.equal(svc.transition("B1", "approved", {}, OFFICER).status, "approved");
  const approved = events.ofType("transfer.batch.approved"); assert.equal(approved.length, 1);
  assert.equal(approved[0]!.payload.d_code, "D12"); assert.equal(approved[0]!.payload.respa_effective_date, "2026-10-01"); assert.equal(approved[0]!.payload.loan_list_freeze_on, "2026-09-25");
  assert.equal(timers.byCode("FNMA_IRM_TT32_TRANSFER_RECORD_15")[0]!.dueDate, "2026-09-16"); assert.equal(timers.byCode("FNMA_QX_LOAN_LIST_FREEZE_CD25")[0]!.dueDate, "2026-09-25");
  assert.equal(loanListFreezeOn(D("2026-11-02")), "2026-10-25");
});
test("1.2-T7: Given a loan on the approved list that pays off Sept. 20, 2026, then it is `withdrawn`, a new loan-list version is created, and the CD25 attestation timer is satisfied only by an attested version.", () => {
  const loans: LoanListLoan[] = [{ fnma_loan_number: "1000000001", status: "listed" }, { fnma_loan_number: "1000000002", status: "listed" }];
  const v1: LoanListVersion = { version: 1, loans: loans.map((l) => l.fnma_loan_number), attested: true, attested_by: "u-officer", created_on: D("2026-09-01") };
  const v2 = withdrawFromList([v1], loans, "1000000002", "paid_off", D("2026-09-20"));
  assert.equal(loans[1]!.status, "withdrawn"); assert.equal(loans[1]!.withdrawn_reason, "paid_off");
  assert.deepEqual([v2.version, v2.loans, v2.attested], [2, ["1000000001"], false]);
  assert.equal(attestationSatisfies(v2), false);                              // FNMA_QX_LOAN_LIST_FREEZE_CD25 stays open
  assert.throws(() => attestList(v2, { kind: "agent", id: "transfer" }), /officer act/);
  assert.equal(attestationSatisfies(attestList(v2, OFFICER)), true);
  // The timer itself: armed by `transfer.batch.approved` (due CD25 = Sept 25), satisfied only by `transfer.loan_list.attested` — the officer-attested freeze of the batch.
  const { events, svc, timers } = harness("2026-09-05T14:00:00.000Z");
  svc.propose({ batch_id: "B1", type: "master_to_sub", transfer_date: D("2026-10-01"), first_batch_for_partner: false }, AGENT);
  svc.transition("B1", "package_ready", PACKAGE, AGENT); svc.transition("B1", "submitted", { portal_completion_record_id: "doc-qx" }, OPERATOR);
  svc.recordApproval("B1", { d_code: "D12", fnma_consent_document_id: "doc-consent", consent_document_hash: "sha256:abc" }, true); svc.transition("B1", "approved", {}, OFFICER);
  const cd25 = timers.byCode("FNMA_QX_LOAN_LIST_FREEZE_CD25")[0]!; assert.equal(cd25.dueDate, "2026-09-25"); assert.equal(cd25.status, "armed");
  events.append({ type: "transfer.loan_list.version_created", aggregate: { kind: "transfer_batch", id: "B1" }, actor: AGENT, payload: { version: 2, attested: false } });
  assert.equal(cd25.status, "armed", "an unattested version does not satisfy the CD25 timer");
  assert.throws(() => svc.transition("B1", "loan_list_frozen", { loan_list_version: 2 }, AGENT), /attestation evidence/);
  svc.transition("B1", "loan_list_frozen", { loan_list_version: 2, officer_attestation_document_id: "doc-attest-v2" }, OFFICER);
  assert.equal(cd25.status, "satisfied"); assert.equal(events.ofType("transfer.loan_list.attested")[0]!.payload.version, 2);
});
