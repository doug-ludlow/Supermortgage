// 17.1 Fannie Mae transfer approval
// spec/sections/17-servicing-transfer-out/17-1-fannie-mae-transfer-approval.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { TOOLS_17_1 } from "../../app/tools/section17-1.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { applyTransferTimerOverrides } from "./timers.ts";
import { withdrawFromList, attestationSatisfies, type LoanListLoan, type LoanListVersion } from "./inbound.ts";
import { reconcileQxDownload, attestationGate, qxDifferenceResolution, attestLoanList, submitLoanListVersion, goodbyeRunForBatch, payoffAfterAttestation, transfereeTapeRows, voluntaryTerminationEffective, allBatchesCutover, withoutCauseTermination, computeDeadlines, transferPlan, approvePlan, form629Package, validateLoanList, terminationPortfolioScope, servicingStopGate, parseApprovalLetter, applyFnmaOutcome, form101TerminationDraft, submitForm101Termination, partnerAccessRevocation, partnerNotification, proposeBatch, transitionTransferOut, transferOutTransitionBlock, recordNotice, counselReviewAllowed, fnmaProcessingConfirmation, quickExchangeCadenceOut, form629ClocksOut, lastBatchForPartner, form582TerminationReflected, form629PortalTaskOpened, CUSTODIAN_MATRIX_ENOTE, type TransferOutBatch, type OutEvent } from "./ops-17-1.ts";
const OFFICER: Actor = { kind: "human" as const, id: "u-officer", role: "officer" };
const AGENT: Actor = { kind: "agent", id: "transfer" };
const OPERATOR: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };
const T = D("2026-12-01");                                                    // worked example used throughout Section 17

/** The engine arms only this process's rows (the seven codes shared with §1.2 are registered under 1.2). Scoping is also a workaround for a kernel
 *  defect outside this process: TimerEngine.onEvent iterates `this.instances` while a satisfied *recurring* timer (SM_BOARD_POST_TRANSFER_MONITOR_180,
 *  §1.1, satisfied by `transfer.batch.closed`) re-arms into the same array and is re-satisfied by the same event, without end. */
const PROCESSES = ["17.1", "1.2"];
const registry = () => { const r = loadRegistry(); applyTransferTimerOverrides(r); return r; };
/** The live registry (section overrides applied) on a memory event store: what `transfer.batch.*` and the loan-list/termination events actually arm and satisfy. */
function liveEngine(nowIso = "2026-10-05T14:00:00.000Z") {
  const reg = loadRegistry(); applyTransferTimerOverrides(reg);
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const engine = new TimerEngine(reg, events, { processes: PROCESSES });
  const emit = (e: OutEvent, on: PlainDate, batchId: string, actor: Actor = AGENT) => events.append({ type: e.type, aggregate: e.aggregate ?? { kind: "transfer_batch", id: batchId }, actor, occurredAt: `${on}T15:00:00.000Z`, payload: e.payload });
  const timer = (code: string, subjectId?: string) => engine.all().filter((t) => t.code === code && (subjectId === undefined || t.subject.id === subjectId)).at(-1);
  return { reg, clock, events, engine, emit, timer };
}
/** The 17.1 tools on the command bus (the shape src/app/tools.test.ts uses). */
function bus(nowIso = "2026-10-05T14:00:00.000Z") {
  const reg = loadRegistry(); applyTransferTimerOverrides(reg);
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const decisions: unknown[] = [];
  const ctx: UowContext = { loanId: "L-1", events, ledger: new MemoryLedger(), timers: new TimerEngine(reg, events, { processes: PROCESSES }), clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const escalates = loadAgentsFile().processes.find((p) => p.process === "17.1")!.escalates_to;   // what src/app/tools/index.ts bindTools does, for the 17.1 tools alone
  const cmds = new Map(TOOLS_17_1.map((d) => { const cmd = toolCommand(d, rt, escalates); agents.registerTool(d.agent, cmd.name); return [d.name, cmd] as const; })); const b = new CommandBus(agents);
  const run = (name: string, actor: Actor, input: Record<string, unknown>) => b.execute(cmds.get(name)!, actor, input, ctx);
  return { ctx, rt, events, run, decisions };
}
const proposedSubToSub = (batchId = "TB-out-1") => proposeBatch({ batch_id: batchId, partner_id: "P-1", transfer_type: "sub_to_sub", transfer_date: T, transferee_servicer_number: "987654321", loan_count: 1_250, last_batch_for_partner: true, source: "partner_instruction", proposed_on: D("2026-10-05") });

test("17.1-T1: Given a `sub_to_sub` batch with transfer date Dec 1, 2026 proposed Oct 5, then the Form 629 deadline is Nov 1, 2026, the buffer Oct 25, adds CD10 = Nov 10, freeze/attestation Nov 25, processing gate Dec 3.", () => {
  const { batch, event, events } = proposedSubToSub();
  assert.deepEqual([batch.status, batch.direction, batch.form629_rule, batch.form629_deadline, batch.anchor_basis, batch.liability_start_date], ["proposed", "out", "30_day_subservicing", "2026-11-01", "transfer_date", "2026-12-01"]);
  assert.equal(event.type, "transfer.batch.proposed"); assert.deepEqual([event.payload.direction, event.payload.type, event.payload.form629_deadline, event.payload.form629_anchor_date, event.payload.proposed_on], ["out", "sub_to_sub", "2026-11-01", "2026-12-01", "2026-10-05"]);
  assert.deepEqual(events.map((e) => [e.type, e.aggregate?.kind ?? "transfer_batch"]), [["transfer.batch.proposed", "transfer_batch"], ["partner.transfer_batch.proposed", "partner"]]);
  // the deadline table the agent files: Form 629 Sun Nov 1, buffer Oct 25, adds CD10 Nov 10, reconciliation CD20 Nov 20, freeze/attestation Wed Nov 25 (Thanksgiving Nov 26), processing Thu Dec 3 (BD3)
  const d = computeDeadlines({ transfer_type: "sub_to_sub", transfer_date: T, proposed_on: D("2026-10-05") });
  const due = Object.fromEntries(d.rows.map((r) => [r.code, r.due]));
  assert.deepEqual([due.FNMA_A2_7_03_FORM629_SUBSERVICING_30, due.SM_FORM629_INTERNAL_BUFFER_7, due.FNMA_QX_LOAN_LIST_ADDS_CD10, due.FNMA_QX_LOAN_LIST_FREEZE_CD25, due.FNMA_QX_PROCESSING_BD3], ["2026-11-01", "2026-10-25", "2026-11-10", "2026-11-25", "2026-12-03"]);
  assert.equal(d.rows.find((r) => r.code === "FNMA_QX_PROCESSING_BD3")!.kind, "not_before_gate");
  const qx = quickExchangeCadenceOut(T, D("2026-11-01"));
  assert.deepEqual([qx.adds_by, qx.reconciliation_by, qx.attestation_by, qx.processing_on], ["2026-11-10", "2026-11-20", "2026-11-25", "2026-12-03"]);
  // on the live engine the proposal arms the same dates: Form 629 −30 CD (Nov 1), buffer −7 (Oct 25), plan T−45 (Oct 17); the approval arms CD10/CD20/CD25/TT32
  const L = liveEngine(); L.emit(event, D("2026-10-05"), batch.batch_id);
  assert.deepEqual([L.timer("FNMA_A2_7_03_FORM629_SUBSERVICING_30")!.dueDate, L.timer("SM_FORM629_INTERNAL_BUFFER_7")!.dueDate, L.timer("SM_TRANSFER_PLAN_APPROVED_T45")!.dueDate], ["2026-11-01", "2026-10-25", "2026-10-17"]);
  assert.equal(L.timer("FNMA_A2_7_03_FORM629_SERVICING_60"), undefined);
  let b = transitionTransferOut(batch, "plan_approved", { actor: OFFICER }, D("2026-10-06")); L.emit(b.events[0]!, D("2026-10-06"), batch.batch_id);
  b = transitionTransferOut(b.batch, "package_ready", { form629_document_id: "doc-629", custodian_matrix_document_id: "doc-cm", loan_list_version: 1, subservicer_answer_recorded: true, special_notifications_listed: true, form101_termination_draft_document_id: "doc-101" }, D("2026-10-20"));
  b = transitionTransferOut(b.batch, "submitted", { portal_completion_record_id: "esc-1", qx_request_id: "QX-4711" }, D("2026-10-30")); assert.equal(b.batch.qx_status, "New");   // Quick Exchange ladder starts at New
  L.emit({ type: "transfer.form629.submitted", payload: { batch_id: batch.batch_id, qx_request_id: "QX-4711" } }, D("2026-10-30"), batch.batch_id);
  assert.deepEqual([L.timer("FNMA_A2_7_03_FORM629_SUBSERVICING_30")!.status, L.timer("SM_FORM629_INTERNAL_BUFFER_7")!.status], ["satisfied", "satisfied"]);
  assert.match(transferOutTransitionBlock(b.batch, "approved", { actor: AGENT, approval_letter_document_hash: "sha256:abc", d_code: "D27" }, D("2026-11-04"))!, /partner officer's confirmation of the D-Code/);   // the officer confirms before `approved`
  b = transitionTransferOut(b.batch, "approved", { actor: OFFICER, approval_letter_document_hash: "sha256:abc", d_code: "D27" }, D("2026-11-04")); assert.equal(b.batch.qx_status, "Approval Letters Sent");
  assert.deepEqual([b.batch.status, b.batch.d_code, b.batch.approval_on, b.events[0]!.type, b.events[0]!.payload.loan_list_adds_by, b.events[0]!.payload.loan_list_reconciliation_by, b.events[0]!.payload.loan_list_freeze_on], ["approved", "D27", "2026-11-04", "transfer.batch.approved", "2026-11-10", "2026-11-20", "2026-11-25"]);
  L.emit(b.events[0]!, D("2026-11-04"), batch.batch_id);
  assert.deepEqual([L.timer("FNMA_QX_LOAN_LIST_ADDS_CD10")!.dueDate, L.timer("SM_QX_RECONCILIATION_CD20")!.dueDate, L.timer("FNMA_QX_LOAN_LIST_FREEZE_CD25")!.dueDate, L.timer("FNMA_IRM_TT32_TRANSFER_RECORD_15")!.dueDate], ["2026-11-10", "2026-11-20", "2026-11-25", "2026-11-16"]);
  // proposing Oct 5 leaves the gate open: the transfer date is the first Fannie Mae business day of December
  assert.equal(d.transfer_date_gate.ok, true); assert.equal(transferOutTransitionBlock(batch, "plan_approved", { actor: AGENT }, D("2026-10-06")), "plan approval is a partner officer act (Bulletin 2020-02)");
});
test("17.1-T2: Given a proposed transfer date of Dec 2, 2026, then `proposeBatch` is rejected by `FNMA_A2_7_03_TRANSFER_DATE_GATE`.", async () => {
  assert.throws(() => proposeBatch({ batch_id: "TB-out-2", transfer_type: "sub_to_sub", transfer_date: D("2026-12-02"), source: "partner_instruction" }), (e: unknown) => e instanceof RangeError && /^FNMA_A2_7_03_TRANSFER_DATE_GATE: 2026-12-02 is not the first Fannie Mae business day of the month \(expected 2026-12-01\)/.test(e.message));
  assert.equal(computeDeadlines({ transfer_type: "sub_to_sub", transfer_date: D("2026-12-02") }).transfer_date_gate.ok, false);
  // on the bus the `transfer` agent's proposeBatch (buildTransferPlan op=propose) is refused with the gate's code before anything is written
  const B = bus();
  await assert.rejects(B.run("buildTransferPlan", AGENT, { op: "propose", batch_id: "TB-out-2", transfer_type: "sub_to_sub", transfer_date: "2026-12-02", source: "partner_instruction" }), (e: unknown) => e instanceof CommandRefused && e.code === "FNMA_A2_7_03_TRANSFER_DATE_GATE");
  assert.equal(B.rt.store.get("transfer_batches", "TB-out-2"), undefined); assert.deepEqual(B.events.all().map((e) => e.type), ["command.refused"]);
  const ok = await B.run("buildTransferPlan", AGENT, { op: "propose", batch_id: "TB-out-1", partner_id: "P-1", transfer_type: "sub_to_sub", transfer_date: "2026-12-01", source: "partner_instruction" });
  assert.equal((ok.output as { batch: TransferOutBatch }).batch.status, "proposed"); assert.equal(B.rt.store.get("transfer_batches", "TB-out-1")!.data.status, "proposed");
  assert.ok(B.events.all().some((e) => e.type === "transfer.batch.proposed" && e.payload.direction === "out"));
  // a re-based transfer date on hold must itself be a first business day; Fannie Mae's own instruction may set any date
  const { batch } = proposedSubToSub("TB-out-3");
  assert.match(transferOutTransitionBlock({ ...batch, status: "submitted" }, "on_hold", { new_transfer_date: D("2027-01-05") }, D("2026-11-10"))!, /not a first Fannie Mae business day \(expected 2027-01-04\)/);   // Jan 1, 2027 is a holiday: Mon Jan 4 is the first business day
  assert.equal(transferOutTransitionBlock({ ...batch, status: "submitted" }, "on_hold", { new_transfer_date: D("2027-02-01") }, D("2026-11-10")), null);
  assert.equal(proposeBatch({ batch_id: "TB-fc", partner_id: "P-1", transfer_type: "fnma_directed", transfer_date: D("2026-12-02"), termination_basis: "fnma_for_cause", fnma_instruction: { received_on: D("2026-10-15"), transfer_date: D("2026-12-02"), for_cause: true }, source: "fnma_termination_notice" }).batch.anchor_basis, "fnma_instruction");
  // a termination batch names its partner (the A1-2-01/A1-2-02 clocks and the portfolio scope are the partner's); the stored batch, not a caller-supplied one, is what a milestone moves
  assert.throws(() => proposeBatch({ batch_id: "TB-np", transfer_type: "fnma_directed", transfer_date: T, termination_basis: "fnma_for_cause", source: "fnma_termination_notice" }), /partner_id is required for a fnma_for_cause batch/);
  await assert.rejects(B.run("buildTransferPlan", AGENT, { op: "milestone", batch: { batch_id: "TB-out-1", status: "pre_cutover", d_code: "FAKE" }, batch_id: "TB-out-1", to: "cutover", evidence: { goodbye_run_status: "complete", preliminary_tape_acknowledged: true } }), (e: unknown) => e instanceof CommandRefused && e.code === "BATCH_STATE_IS_THE_STORE");
  assert.equal(B.rt.store.get("transfer_batches", "TB-out-1")!.data.status, "proposed");
});
test("17.1-T3: Given a `servicing_sale` with sale date Nov 16, 2026, then the 60-day deadline is Sept 17, 2026.", () => {
  const c = form629ClocksOut("servicing_sale", T, D("2026-11-16"));
  assert.deepEqual([c.rule, c.anchor_date, c.deadline, c.internal_buffer, c.liability_start], ["60_day_servicing", "2026-11-16", "2026-09-17", "2026-09-10", "2026-11-16"]);
  const s = computeDeadlines({ transfer_type: "servicing_sale", transfer_date: T, sale_date: D("2026-11-16") });
  assert.equal(s.rows.find((r) => r.code === "FNMA_A2_7_03_FORM629_SERVICING_60")!.due, "2026-09-17"); assert.equal(s.rows.find((r) => r.code === "FNMA_A2_7_03_FORM629_SUBSERVICING_30"), undefined); assert.equal(s.liability_start_date, "2026-11-16");
  // the proposal carries the anchor (earlier of sale/transfer) and the live engine arms the 60-day row on it
  const { batch, event } = proposeBatch({ batch_id: "TB-sale", partner_id: "P-1", transfer_type: "servicing_sale", transfer_date: T, sale_date: D("2026-11-16"), termination_basis: "sale", source: "partner_instruction", proposed_on: D("2026-09-01") });
  assert.deepEqual([event.payload.form629_anchor_date, event.payload.form629_deadline, batch.liability_start_date], ["2026-11-16", "2026-09-17", "2026-11-16"]);
  const L = liveEngine("2026-09-01T14:00:00.000Z"); L.emit(event, D("2026-09-01"), batch.batch_id);
  assert.deepEqual([L.timer("FNMA_A2_7_03_FORM629_SERVICING_60")!.dueDate, L.timer("SM_FORM629_INTERNAL_BUFFER_7")!.dueDate, L.timer("FNMA_A2_7_03_FORM629_SUBSERVICING_30")], ["2026-09-17", "2026-09-10", undefined]);
  // a sale date after the transfer date does not move the clock: transfer_date − 60
  assert.equal(form629ClocksOut("servicing_sale", T, D("2026-12-15")).deadline, "2026-10-02");
});
test("17.1-T4: Given the Quick Exchange CD20 download differs from `transfer_batch_loans` by one loan, then attestation is blocked until a new list version resolves it.", async () => {
  const cadence = quickExchangeCadenceOut(T);                                    // adds Nov 10, reconciliation Nov 20, attestation Nov 25
  const loans: LoanListLoan[] = [{ fnma_loan_number: "1000000001", status: "listed" }, { fnma_loan_number: "1000000002", status: "listed" }, { fnma_loan_number: "1000000003", status: "listed" }];
  const v1: LoanListVersion = { version: 1, loans: loans.map((l) => l.fnma_loan_number), attested: false, created_on: D("2026-10-30") };
  const download = ["1000000001", "1000000003"];                               // Fannie Mae's CD20 download lacks 1000000002 (paid off after submission)
  const r1 = reconcileQxDownload({ download, version: v1, downloaded_on: cadence.reconciliation_by });
  assert.deepEqual([r1.difference_count, r1.only_in_system, r1.only_in_download, r1.zero_differences, r1.event], [1, ["1000000002"], [], false, null]);
  const g1 = attestationGate(r1, v1);
  assert.equal(g1.ok, false); assert.equal(g1.timer, "FNMA_QX_LOAN_LIST_FREEZE_CD25"); assert.match(g1.block!, /1 difference.*blocked until a new loan-list version/);
  assert.throws(() => attestLoanList(g1, v1, OFFICER), /blocked until a new loan-list version/);
  assert.deepEqual(qxDifferenceResolution(r1, cadence.reconciliation_by, cadence.adds_by).map((x) => [x.fnma_loan_number, x.action]), [["1000000002", "delete_from_list"]]);
  // the new list version (withdrawal) resolves the difference; a re-reconciliation of that version opens the gate
  const v2 = withdrawFromList([v1], loans, "1000000002", "paid_off", D("2026-11-20"));
  assert.deepEqual([v2.version, v2.loans, v2.attested], [2, ["1000000001", "1000000003"], false]);
  const r2 = reconcileQxDownload({ download, version: v2, downloaded_on: cadence.reconciliation_by });
  assert.deepEqual([r2.zero_differences, r2.event], [true, "transfer.loan_list.reconciled"]);   // satisfies SM_QX_RECONCILIATION_CD20
  assert.equal(attestationGate(r2, v1).ok, false);                            // the reconciled version must be the one attested
  const g2 = attestationGate(r2, v2); assert.equal(g2.ok, true); assert.equal(g2.block, null);
  const attested = attestLoanList(g2, v2, OFFICER, D("2026-11-25"));
  assert.equal(attested.event, "transfer.loan_list.attested"); assert.equal(attestationSatisfies(attested), true); assert.equal(attested.attested_by, "u-officer");
  assert.deepEqual(attested.events.map((e) => e.type), ["transfer.loan_list.attested", "transfer.loan_list.finalized"]);
  assert.throws(() => attestLoanList(g2, v2, AGENT), /officer act/);
  // a download-only loan after CD10 cannot be added: Fannie Mae is queried instead; the deletion is a new version even after CD10
  const r3 = reconcileQxDownload({ download: [...download, "1000000009"], version: v2 });
  const res = qxDifferenceResolution(r3, D("2026-11-20"), cadence.adds_by);
  assert.equal(res[0]!.action, "query_fannie_mae"); assert.match(res[0]!.reason, /after CD10 2026-11-10/);
  assert.equal(qxDifferenceResolution(r3, D("2026-11-05"), cadence.adds_by)[0]!.action, "add_to_list");
  assert.throws(() => submitLoanListVersion({ previous: v2, loans: [...v2.loans, "1000000009"], submitted_on: D("2026-11-20"), transfer_date: T }), /nothing may be added after CD10 2026-11-10/);
  const v3 = submitLoanListVersion({ previous: v2, loans: ["1000000001"], submitted_on: D("2026-11-21"), transfer_date: T, reason: "1000000003 repurchased" });
  assert.deepEqual([v3.version.version, v3.adds, v3.deletes, v3.event.payload.adds, v3.event.payload.deletes], [3, [], ["1000000003"], 0, 1]);
  assert.throws(() => submitLoanListVersion({ previous: attested, loans: ["1000000001"], submitted_on: D("2026-11-26"), transfer_date: T }), /after "Agree" no changes can be made/);
  // through the bus: the agent's attest is refused (officer act); the officer's attest with a difference is refused; the officer attests the reconciled version and the batch freezes
  const B = bus("2026-11-20T14:00:00.000Z");
  await B.run("buildTransferPlan", AGENT, { op: "propose", batch_id: "TB-out-1", partner_id: "P-1", transfer_type: "sub_to_sub", transfer_date: "2026-12-01", source: "partner_instruction", proposed_on: "2026-10-05" });
  B.rt.store.put("transfer_batches", "TB-out-1", { ...(B.rt.store.get("transfer_batches", "TB-out-1")!.data), status: "approved", d_code: "D27", approval_on: "2026-11-04" }, OFFICER, B.ctx.clock.now());
  await assert.rejects(B.run("reconcileQxDownload", AGENT, { batch_id: "TB-out-1", download, version: v2, attest: true }), (e: unknown) => e instanceof CommandRefused && e.code === "ATTESTATION_IS_OFFICER");
  await assert.rejects(B.run("reconcileQxDownload", OFFICER, { batch_id: "TB-out-1", download, version: v1, attest: true }), (e: unknown) => e instanceof CommandRefused && e.code === "ATTEST_NEEDS_ZERO_DIFFERENCES");
  const r = await B.run("reconcileQxDownload", OFFICER, { batch_id: "TB-out-1", download, version: v2, attest: true, today: "2026-11-25" });
  assert.deepEqual((r.output as { events: string[] }).events, ["transfer.loan_list.attested", "transfer.loan_list.finalized"]);
  assert.equal(B.rt.store.get("transfer_batches", "TB-out-1")!.data.status, "loan_list_frozen");
  assert.deepEqual(B.events.all().filter((e) => e.type.startsWith("transfer.loan_list") || e.type === "transfer.batch.loan_list_frozen").map((e) => e.type), ["transfer.loan_list.reconciled", "transfer.loan_list.attested", "transfer.loan_list.finalized", "transfer.batch.loan_list_frozen"]);   // the two refused calls wrote only command.refused
});
test("17.1-T5: Given a `master_change_sub_retained` batch with identical payee/address/account/amount, then no goodbye run is created and an `officer` exclusion record exists.", async () => {
  const same = { payee: true, address: true, account: true, amount: true };
  const r = goodbyeRunForBatch({ transfer_type: "master_change_sub_retained", transfer_date: T, sale_date: D("2026-11-16"), unchanged: same, officer: OFFICER });
  assert.equal(r.goodbye_run, null); assert.equal(r.respa_notice_required, false); assert.equal(r.block, null);
  assert.equal(r.exclusion_record!.approved_by, "u-officer"); assert.equal(r.exclusion_record!.rule, "§1024.33(b)(2)(i)(C)"); assert.match(r.exclusion_record!.basis, /master servicer change, subservicer retained/);
  assert.deepEqual(r.form629, { filed_by: "selling_master", rule: "60_day_servicing", deadline: "2026-09-17" });   // Form 629 by the selling master, 60 days from the Nov 16 sale
  assert.deepEqual(r.retained, { form101: "re_execute_with_new_master", forms_1013_1014: "re_evidence_under_new_master", mers: "tos_by_sellers", custodial_accounts: "retained_open", custodial_close_timer: null });
  // without the officer sign-off the exclusion is not recorded and the batch is blocked — still no goodbye run
  const noOfficer = goodbyeRunForBatch({ transfer_type: "master_change_sub_retained", transfer_date: T, sale_date: D("2026-11-16"), unchanged: same, officer: null });
  assert.equal(noOfficer.goodbye_run, null); assert.equal(noOfficer.exclusion_record, null); assert.match(noOfficer.block!, /officer sign-off/);
  assert.equal(goodbyeRunForBatch({ transfer_type: "master_change_sub_retained", transfer_date: T, sale_date: D("2026-11-16"), unchanged: same, officer: AGENT }).exclusion_record, null);
  // a changed payment amount is a RESPA transfer: the 17.2 goodbye run is planned and no exclusion exists
  const changed = goodbyeRunForBatch({ transfer_type: "master_change_sub_retained", transfer_date: T, sale_date: D("2026-11-16"), unchanged: { ...same, amount: false }, officer: OFFICER });
  assert.deepEqual([changed.respa_notice_required, changed.goodbye_run, changed.exclusion_record], [true, { kind: "goodbye", status: "planned", process: "17.2" }, null]);
  const sub = goodbyeRunForBatch({ transfer_type: "sub_to_sub", transfer_date: T, unchanged: same, officer: OFFICER });
  assert.equal(sub.goodbye_run!.kind, "goodbye"); assert.deepEqual(sub.form629, { filed_by: "partner", rule: "30_day_subservicing", deadline: "2026-11-01" }); assert.equal(sub.retained, null);
  // the state machine accepts the exclusion record as the notice_window evidence for this batch type
  const { batch } = proposeBatch({ batch_id: "TB-mc", transfer_type: "master_change_sub_retained", transfer_date: T, sale_date: D("2026-11-16"), source: "partner_instruction" });
  assert.equal(transferOutTransitionBlock({ ...batch, status: "loan_list_frozen", d_code: "D31" }, "notice_window", { goodbye_run_status: "excluded" }, D("2026-11-25")), null);
  assert.match(transferOutTransitionBlock({ ...batch, status: "loan_list_frozen", d_code: "D31" }, "notice_window", {}, D("2026-11-25"))!, /goodbye run \(or the §1024.33\(b\)\(2\)\(i\)\(C\) exclusion record\)/);
  // through the bus: the exclusion is the partner officer's recorded sign-off on the stored batch (`transfer.respa_exclusion.recorded`); the agent's is refused; a milestone reads the status from the store, never from the caller
  const B = bus("2026-11-25T14:00:00.000Z");
  await B.run("buildTransferPlan", AGENT, { op: "propose", batch_id: "TB-mc", partner_id: "P-1", transfer_type: "master_change_sub_retained", transfer_date: "2026-12-01", sale_date: "2026-11-16", source: "partner_instruction", proposed_on: "2026-09-01" });
  await assert.rejects(B.run("buildTransferPlan", AGENT, { op: "respa_exclusion", batch_id: "TB-mc", unchanged: same }), (e: unknown) => e instanceof CommandRefused && e.code === "RESPA_EXCLUSION_IS_OFFICER");
  const ex = await B.run("buildTransferPlan", OFFICER, { op: "respa_exclusion", batch_id: "TB-mc", unchanged: same });
  assert.deepEqual([(ex.output as { goodbye_run_status: string }).goodbye_run_status, (ex.output as { goodbye_run: unknown }).goodbye_run, (ex.output as { exclusion_record: { approved_by: string } }).exclusion_record.approved_by], ["excluded", null, "u-officer"]);
  const rec = B.rt.store.get("transfer_batches", "TB-mc")!.data; assert.equal(rec.goodbye_run_status, "excluded"); assert.deepEqual([(rec.respa_exclusion as { approved_by: string; rule: string }).approved_by, (rec.respa_exclusion as { rule: string }).rule], ["u-officer", "§1024.33(b)(2)(i)(C)"]);
  const ev = B.events.all().findLast((e) => e.type === "transfer.respa_exclusion.recorded")!; assert.deepEqual([ev.aggregate, ev.payload.rule, ev.payload.approved_by], [{ kind: "transfer_batch", id: "TB-mc" }, "§1024.33(b)(2)(i)(C)", "u-officer"]);
  B.rt.store.put("transfer_batches", "TB-mc", { ...B.rt.store.get("transfer_batches", "TB-mc")!.data, status: "loan_list_frozen", d_code: "D31" }, OFFICER, B.ctx.clock.now());
  await assert.rejects(B.run("buildTransferPlan", AGENT, { op: "milestone", batch_id: "TB-mc", to: "notice_window", evidence: { goodbye_run_status: "complete" } }), (e: unknown) => e instanceof CommandRefused && e.code === "GOODBYE_RUN_STATUS_IS_RECORDED");
  assert.equal(((await B.run("buildTransferPlan", AGENT, { op: "milestone", batch_id: "TB-mc", to: "notice_window" })).output as { batch: TransferOutBatch }).batch.status, "notice_window");
  // a changed payment amount is a RESPA transfer: the sign-off records `planned` for 17.2 and no exclusion; a batch with no recorded run or exclusion cannot enter the notice window
  await B.run("buildTransferPlan", AGENT, { op: "propose", batch_id: "TB-mc2", partner_id: "P-1", transfer_type: "master_change_sub_retained", transfer_date: "2026-12-01", sale_date: "2026-11-16", source: "partner_instruction", proposed_on: "2026-09-01" });
  B.rt.store.put("transfer_batches", "TB-mc2", { ...B.rt.store.get("transfer_batches", "TB-mc2")!.data, status: "loan_list_frozen", d_code: "D32" }, OFFICER, B.ctx.clock.now());
  await assert.rejects(B.run("buildTransferPlan", AGENT, { op: "milestone", batch_id: "TB-mc2", to: "notice_window" }), /notice_window requires the 17.2 goodbye run/);
  const pl = await B.run("buildTransferPlan", OFFICER, { op: "respa_exclusion", batch_id: "TB-mc2", unchanged: { ...same, amount: false } });
  assert.deepEqual([(pl.output as { goodbye_run_status: string }).goodbye_run_status, (pl.output as { exclusion_record: unknown }).exclusion_record, B.rt.store.get("transfer_batches", "TB-mc2")!.data.goodbye_run_status, B.events.all().some((e) => e.type === "transfer.goodbye_run.required" && e.aggregate?.id === "TB-mc2")], ["planned", null, "planned", true]);
});
test("17.1-T6: Given the last batch for a partner cuts over Dec 1, 2026, then Form 101 termination is due Dec 8, 2026 and partner-scoped credentials are revoked by Dec 8.", async () => {
  const d = computeDeadlines({ transfer_type: "sub_to_sub", transfer_date: T, last_batch_for_partner: true });
  const due = Object.fromEntries(d.rows.map((r) => [r.code, r.due]));
  assert.deepEqual([due.FNMA_A2_1_07_FORM101_TERMINATION_5BD, due.SM_XFER_OUT_ACCESS_REVOCATION_5BD], ["2026-12-08", "2026-12-08"]);   // Dec 1 + 5 servicer BD
  assert.equal(computeDeadlines({ transfer_type: "sub_to_sub", transfer_date: T }).rows.some((r) => r.code === "FNMA_A2_1_07_FORM101_TERMINATION_5BD"), false);   // not the last batch: no termination rows
  // the last batch's cutover on the live engine arms both rows on `transfer.batch.cutover_completed{last_batch_for_partner=true}` (and BD3 for Fannie Mae's processing)
  const { batch } = proposedSubToSub(); assert.equal(batch.last_batch_for_partner, true);
  const pre: TransferOutBatch = { ...batch, status: "pre_cutover", d_code: "D27", approval_on: D("2026-11-04") };
  assert.match(transferOutTransitionBlock(pre, "cutover", { goodbye_run_status: "complete", preliminary_tape_acknowledged: true }, D("2026-11-30"))!, /servicing may not stop 2026-11-30, before the approved transfer date 2026-12-01/);
  assert.match(transferOutTransitionBlock(pre, "cutover", { goodbye_run_status: "planned", preliminary_tape_acknowledged: true }, T)!, /goodbye run `complete`/);
  const cut = transitionTransferOut(pre, "cutover", { goodbye_run_status: "complete", preliminary_tape_acknowledged: true }, T);
  assert.match(transferOutTransitionBlock(cut.batch, "post_transfer", { final_tape_delivered: true, trial_balance_delivered: true, funds_wired: true }, T)!, /cutover incomplete: payment_holds_set/);
  const done = transitionTransferOut(cut.batch, "post_transfer", { final_tape_delivered: true, trial_balance_delivered: true, funds_wired: true, payment_holds_set: true }, T);
  assert.deepEqual(done.events.map((e) => [e.type, e.aggregate?.kind ?? "transfer_batch"]), [["transfer.batch.cutover_completed", "transfer_batch"], ["partner.transfer_batch.cutover_completed", "partner"]]);
  assert.deepEqual([done.events[0]!.payload.last_batch_for_partner, done.events[0]!.payload.transfer_date, done.events[0]!.payload.fnma_processing_on], [true, "2026-12-01", "2026-12-03"]);
  // "last batch for this partner" is measured from the partner's batches at the transition, not remembered from the proposal: a sibling still pre_cutover means this is not the last; a denied sibling never cuts over and does not count
  const full = { final_tape_delivered: true, trial_balance_delivered: true, funds_wired: true, payment_holds_set: true } as const;
  const sib = transitionTransferOut(cut.batch, "post_transfer", { ...full, partner_batches: [{ batch_id: batch.batch_id, status: "cutover" }, { batch_id: "TB-out-9", status: "pre_cutover" }] }, T);
  assert.deepEqual([sib.batch.last_batch_for_partner, sib.events[0]!.payload.last_batch_for_partner, sib.events[1]!.payload.last_batch_for_partner], [false, false, false]);
  assert.equal(transitionTransferOut(cut.batch, "post_transfer", { ...full, partner_batches: [{ batch_id: batch.batch_id, status: "cutover" }, { batch_id: "TB-out-9", status: "denied" }, { batch_id: "TB-out-8", status: "closed" }] }, T).batch.last_batch_for_partner, true);
  assert.deepEqual([lastBatchForPartner(batch, [{ batch_id: batch.batch_id, status: "cutover" }]), lastBatchForPartner(batch, [{ batch_id: "TB-out-8", status: "loan_list_frozen" }])], [true, false]);
  const Ls = liveEngine("2026-12-01T22:00:00.000Z"); for (const e of sib.events) Ls.emit(e, T, batch.batch_id);
  assert.deepEqual([Ls.timer("FNMA_A2_1_07_FORM101_TERMINATION_5BD"), Ls.timer("SM_XFER_OUT_ACCESS_REVOCATION_5BD"), Ls.timer("FNMA_QX_PROCESSING_BD3")!.dueDate], [undefined, undefined, "2026-12-03"]);   // not the last batch: no termination rows
  const L = liveEngine("2026-12-01T22:00:00.000Z"); for (const e of done.events) L.emit(e, T, batch.batch_id);
  assert.deepEqual([L.timer("FNMA_A2_1_07_FORM101_TERMINATION_5BD")!.dueDate, L.timer("SM_XFER_OUT_ACCESS_REVOCATION_5BD")!.dueDate, L.timer("FNMA_QX_PROCESSING_BD3")!.dueDate], ["2026-12-08", "2026-12-08", "2026-12-03"]);
  // the officer's Form 101 e-mail (evidence) on Dec 7 and Supermortgage's fnma-* adapter revocation on Dec 8 satisfy them on time
  const draft = form101TerminationDraft({ batch_id: batch.batch_id, partner_servicer_number: "123456789", last_cutover_on: T });
  assert.deepEqual([draft.to, draft.due, draft.status, draft.sent_by, draft.access_revocation_by], ["Technology_Registration@fanniemae.com", "2026-12-08", "draft_pending_officer", "officer", "2026-12-08"]);
  assert.throws(() => submitForm101Termination(draft, { actor: AGENT, evidence_document_id: "doc-mail", submitted_on: D("2026-12-07"), batch_id: batch.batch_id }), /e-mailed by the partner officer/);
  const sub = submitForm101Termination(draft, { actor: OFFICER, evidence_document_id: "doc-mail", submitted_on: D("2026-12-07"), batch_id: batch.batch_id });
  assert.deepEqual([sub.status, sub.on_time, sub.event.type, sub.event.payload.to], ["submitted", true, "transfer.form101_termination.submitted", "Technology_Registration@fanniemae.com"]);
  assert.throws(() => partnerAccessRevocation({ partner_id: "P-1", last_cutover_on: T, revoked_on: D("2026-12-08"), revocation_log_id: "rev-1", adapters: ["fnma-lsdu", "core-db"], related_party_users_removed: true }), /only fnma-\* adapters/);
  const rev = partnerAccessRevocation({ partner_id: "P-1", last_cutover_on: T, revoked_on: D("2026-12-08"), revocation_log_id: "rev-1", adapters: ["fnma-lsdu", "fnma-smdu", "fnma-connect"], related_party_users_removed: true });
  assert.deepEqual([rev.due, rev.on_time, rev.event.type], ["2026-12-08", true, "credentials.partner_scoped.revoked"]);
  assert.equal(partnerAccessRevocation({ ...{ partner_id: "P-1", last_cutover_on: T, revocation_log_id: "rev-1", adapters: ["fnma-lsdu"], related_party_users_removed: true }, revoked_on: D("2026-12-09") }).on_time, false);
  L.emit(sub.event, D("2026-12-07"), batch.batch_id, OFFICER); L.emit(rev.event, D("2026-12-08"), batch.batch_id);
  assert.deepEqual([L.timer("FNMA_A2_1_07_FORM101_TERMINATION_5BD")!.status, L.timer("SM_XFER_OUT_ACCESS_REVOCATION_5BD")!.status, L.timer("FNMA_QX_PROCESSING_BD3")!.status], ["satisfied", "satisfied", "armed"]);
  // BD3: the Connect report on Dec 3 shows every loan under the transferee → fnma.transfer.processed; a Dec 2 report or a loan still under the partner does not
  const rows = [{ fnma_loan_number: "1000000001", servicer_number: "987654321" }, { fnma_loan_number: "1000000003", servicer_number: "987654321" }];
  assert.equal(fnmaProcessingConfirmation({ transfer_date: T, report_as_of: D("2026-12-02"), transferee_servicer_number: "987654321", expected: ["1000000001", "1000000003"], rows }).confirmed, false);
  const c = fnmaProcessingConfirmation({ transfer_date: T, report_as_of: D("2026-12-03"), transferee_servicer_number: "987654321", expected: ["1000000001", "1000000003"], rows });
  assert.deepEqual([c.processing_on, c.confirmed, c.event!.type], ["2026-12-03", true, "fnma.transfer.processed"]);
  assert.deepEqual(fnmaProcessingConfirmation({ transfer_date: T, report_as_of: D("2026-12-03"), transferee_servicer_number: "987654321", expected: ["1000000001", "1000000003"], rows: [rows[0]!, { fnma_loan_number: "1000000003", servicer_number: "123456789" }] }).not_yet_transferred, ["1000000003"]);
  L.emit(c.event!, D("2026-12-03"), batch.batch_id); assert.equal(L.timer("FNMA_QX_PROCESSING_BD3")!.status, "satisfied");
  // closing the last batch arms the Form 582 confirmation on the partner's next due date (FYE + 90 days)
  const ret = transitionTransferOut(done.batch, "retention", { final_accounting_delivered: true }, D("2026-12-31"));
  assert.match(transferOutTransitionBlock(ret.batch, "closed", {}, D("2027-06-01"))!, /one-year NoE\/RFI window to end \(2027-12-01\)/);
  const closed = transitionTransferOut(ret.batch, "closed", {}, D("2027-12-01"));
  L.emit({ ...closed.events[0]!, payload: { ...closed.events[0]!.payload, partner_next_form582_due_on: "2028-03-30" } }, D("2027-12-01"), batch.batch_id);
  assert.equal(L.timer("FNMA_A2_1_07_FORM582_TERMINATION_REFLECTED")!.dueDate, "2028-03-30");
  // A2-1-07: the partner's next Form 582 (18.4 filing, FYE Dec 31, 2027 → due Mar 30, 2028) reflects the termination only once its Subservicing screen no longer lists Supermortgage (555555555)
  const filing = { form: "form_582" as const, filing_id: "F582-2027", entity: "partner" as const, period_end: D("2027-12-31"), submitted_on: D("2028-03-15"), ecrm_confirmation_document_id: "doc-ecrm", approved_by_officer_id: "u-partner-officer" };
  const arrangements = (status: string) => [{ subservicer_servicer_number: "555555555", status }, { subservicer_servicer_number: "444444444", status: "active" }];
  assert.throws(() => form582TerminationReflected({ batch: { ...closed.batch, last_batch_for_partner: false }, filing: { ...filing, subservicing_arrangements: [] }, supermortgage_servicer_number: "555555555" }), /not the partner's last batch/);
  assert.throws(() => form582TerminationReflected({ batch: { ...closed.batch, status: "loan_list_frozen" }, filing: { ...filing, subservicing_arrangements: [] }, supermortgage_servicer_number: "555555555" }), /has not cut over/);
  assert.throws(() => form582TerminationReflected({ batch: closed.batch, filing: { ...filing, ecrm_confirmation_document_id: "", subservicing_arrangements: [] }, supermortgage_servicer_number: "555555555" }), /ECRM confirmation document/);
  assert.throws(() => form582TerminationReflected({ batch: closed.batch, filing: { ...filing, entity: "supermortgage" as never, subservicing_arrangements: [] }, supermortgage_servicer_number: "555555555" }), /the partner's/);
  const still = form582TerminationReflected({ batch: closed.batch, filing: { ...filing, subservicing_arrangements: arrangements("active") }, supermortgage_servicer_number: "555555555" });
  assert.deepEqual([still.subservicer_removed, still.still_listed, still.form582_due, still.on_time, still.event.type, still.event.payload.subservicer_removed], [false, ["555555555"], "2028-03-30", true, "form582.submitted", false]);
  L.emit(still.event, D("2028-03-15"), batch.batch_id); assert.equal(L.timer("FNMA_A2_1_07_FORM582_TERMINATION_REFLECTED")!.status, "armed");   // still listed: recorded, not reflected — the row stays for the officer
  const gone = form582TerminationReflected({ batch: closed.batch, filing: { ...filing, subservicing_arrangements: arrangements("terminated") }, supermortgage_servicer_number: "555555555" });
  assert.deepEqual([gone.subservicer_removed, gone.still_listed, gone.event.payload.filing_id, gone.event.payload.ecrm_confirmation_document_id], [true, [], "F582-2027", "doc-ecrm"]);
  L.emit(gone.event, D("2028-03-15"), batch.batch_id); assert.equal(L.timer("FNMA_A2_1_07_FORM582_TERMINATION_REFLECTED")!.status, "satisfied");
  assert.equal(eventMatches(L.reg.get("FNMA_A2_1_07_FORM582_TERMINATION_REFLECTED")!.satisfiedPattern!, L.events.all().findLast((e) => e.type === "form582.submitted")!), true);
  // through the bus (draftForm101Termination op=form582_reflected): the closed last batch on the store; the filing is ingested, the event lands on the batch and the batch records the filing
  const B = bus("2028-03-15T14:00:00.000Z");
  await B.run("buildTransferPlan", AGENT, { op: "propose", batch_id: "TB-out-1", partner_id: "P-1", transfer_type: "sub_to_sub", transfer_date: "2026-12-01", source: "partner_instruction", proposed_on: "2026-10-05", last_batch_for_partner: true });
  B.rt.store.put("transfer_batches", "TB-out-1", { ...B.rt.store.get("transfer_batches", "TB-out-1")!.data, status: "closed", d_code: "D27" }, OFFICER, B.ctx.clock.now());
  await assert.rejects(B.run("draftForm101Termination", AGENT, { op: "form582_reflected", batch_id: "TB-out-1", filing: { ...filing, subservicing_arrangements: [] } }), /supermortgage_servicer_number is required/);
  const f = await B.run("draftForm101Termination", AGENT, { op: "form582_reflected", batch_id: "TB-out-1", supermortgage_servicer_number: "555555555", filing: { ...filing, subservicing_arrangements: arrangements("terminated") } });
  assert.equal((f.output as { subservicer_removed: boolean }).subservicer_removed, true);
  const fe = B.events.all().findLast((e) => e.type === "form582.submitted")!; assert.deepEqual([fe.aggregate, fe.payload.subservicer_removed, fe.payload.filing_id, fe.payload.form582_due], [{ kind: "transfer_batch", id: "TB-out-1" }, true, "F582-2027", "2028-03-30"]);
  assert.deepEqual([B.rt.store.get("transfer_batches", "TB-out-1")!.data.form582_reflected_at, B.rt.store.get("transfer_batches", "TB-out-1")!.data.form582_reflected_filing_id], ["2028-03-15", "F582-2027"]);
});
test("17.1-T7: Given a Fannie Mae without-cause termination notice dated Oct 1, 2026, then `FNMA_A1_2_02_SALE_ARRANGEMENT_90` is due Dec 30, 2026 and an `officer` task exists.", async () => {
  const wc = withoutCauseTermination({ notice_on: D("2026-10-01"), approval_on: D("2026-11-02") });
  assert.deepEqual([wc.sale_arrangement_due, wc.officer_task.kind, wc.officer_task.task, wc.officer_task.due, wc.transfer_after_approval_due, wc.termination_fee], ["2026-12-30", "officer", "arrange_servicing_sale", "2026-12-30", "2027-01-01", "recorded_never_computed"]);
  const n = recordNotice({ partner_id: "P-1", kind: "fnma_termination_without_cause", notice_on: D("2026-10-01"), document_id: "doc-fnma-term" });
  assert.deepEqual([n.events[0]!.type, n.events[0]!.aggregate, n.events[0]!.payload.without_cause, n.events[0]!.payload.notice_on, n.events[0]!.payload.sale_arrangement_due, n.termination_fee], ["fnma.termination_notice.received", { kind: "partner", id: "P-1" }, true, "2026-10-01", "2026-12-30", "recorded_never_computed"]);
  assert.deepEqual(n.tasks.map((t) => [t.kind, t.task, t.due]), [["officer", "arrange_servicing_sale", "2026-12-30"], ["officer", "termination_fee_facts", "2026-12-30"]]);
  // the live engine arms the 90-day row on the notice date (not the day it was ingested) and the partner's servicing_sale proposal satisfies it
  const L = liveEngine("2026-10-03T14:00:00.000Z"); L.emit(n.events[0]!, D("2026-10-03"), "P-1");
  const t = L.timer("FNMA_A1_2_02_SALE_ARRANGEMENT_90")!; assert.deepEqual([t.dueDate, t.subject, t.status], ["2026-12-30", { kind: "partner", id: "P-1" }, "armed"]);
  const sale = proposeBatch({ batch_id: "TB-sale", partner_id: "P-1", transfer_type: "servicing_sale", transfer_date: D("2027-02-01"), sale_date: D("2027-01-15"), termination_basis: "fnma_without_cause", source: "fnma_termination_notice", proposed_on: D("2026-11-16") });
  assert.deepEqual(sale.events.map((e) => [e.type, e.aggregate ?? { kind: "transfer_batch", id: sale.batch.batch_id }, e.payload.type]), [["transfer.batch.proposed", { kind: "transfer_batch", id: "TB-sale" }, "servicing_sale"], ["partner.transfer_batch.proposed", { kind: "partner", id: "P-1" }, "servicing_sale"]]);
  for (const e of sale.events) L.emit(e, D("2026-11-16"), sale.batch.batch_id);
  assert.equal(L.timer("FNMA_A1_2_02_SALE_ARRANGEMENT_90")!.status, "satisfied");
  assert.equal(eventMatches(L.reg.get("FNMA_A1_2_02_SALE_ARRANGEMENT_90")!.satisfiedPattern!, L.events.all().find((e) => e.type === "partner.transfer_batch.proposed")!), true);
  assert.throws(() => proposeBatch({ batch_id: "TB-np", transfer_type: "servicing_sale", transfer_date: D("2027-02-01"), sale_date: D("2027-01-15"), termination_basis: "fnma_without_cause", source: "fnma_termination_notice" }), /partner_id is required for a fnma_without_cause batch/);   // the 90-day clock is the partner's
  // Fannie Mae's approval of that sale on Nov 2 starts the 60-day transfer clock (Jan 1, 2027), satisfied by the cutover
  const appr = transitionTransferOut({ ...sale.batch, status: "submitted" }, "approved", { actor: OFFICER, approval_letter_document_hash: "sha256:sale", d_code: "D40" }, D("2026-11-02"));
  L.emit(appr.events[0]!, D("2026-11-02"), sale.batch.batch_id);
  assert.deepEqual([L.timer("FNMA_A1_2_02_TRANSFER_AFTER_APPROVAL_60")!.dueDate, L.timer("FNMA_A1_2_02_TRANSFER_AFTER_APPROVAL_60")!.anchorDate], ["2027-01-01", "2026-11-02"]);
  const wcRows = Object.fromEntries(computeDeadlines({ transfer_type: "servicing_sale", transfer_date: D("2027-02-01"), termination_basis: "fnma_without_cause", fnma_termination_notice_on: D("2026-10-01"), approval_on: D("2026-11-02") }).rows.map((r) => [r.code, r.due]));
  assert.deepEqual([wcRows.FNMA_A1_2_02_SALE_ARRANGEMENT_90, wcRows.FNMA_A1_2_02_TRANSFER_AFTER_APPROVAL_60], ["2026-12-30", "2027-01-01"]);
  // through the bus the notice opens the officer task; counsel is not an option for a without-cause notice, and never without the partner's request
  const B = bus("2026-10-03T14:00:00.000Z");
  const r = await B.run("buildTransferPlan", AGENT, { op: "record_notice", partner_id: "P-1", kind: "fnma_termination_without_cause", notice_on: "2026-10-01" });
  const tasks = (r.output as { tasks: { kind: string; owner_role: string; task: string; due: string }[] }).tasks;
  assert.deepEqual(tasks.map((x) => [x.kind, x.owner_role, x.task, x.due]), [["officer", "officer", "arrange_servicing_sale", "2026-12-30"], ["officer", "officer", "termination_fee_facts", "2026-12-30"]]);
  assert.equal(B.rt.escalations.opened.filter((e) => e.kind === "officer").length, 2); assert.equal(B.ctx.timers.all().find((x) => x.code === "FNMA_A1_2_02_SALE_ARRANGEMENT_90")!.dueDate, "2026-12-30");
  await B.run("buildTransferPlan", AGENT, { op: "propose", batch_id: "TB-sale", partner_id: "P-1", transfer_type: "servicing_sale", transfer_date: "2027-02-01", sale_date: "2027-01-15", termination_basis: "fnma_without_cause", source: "fnma_termination_notice", proposed_on: "2026-11-16" });
  assert.deepEqual([B.ctx.timers.all().find((x) => x.code === "FNMA_A1_2_02_SALE_ARRANGEMENT_90")!.status, B.events.all().findLast((e) => e.type === "partner.transfer_batch.proposed")!.aggregate], ["satisfied", { kind: "partner", id: "P-1" }]);   // the partner's sale proposal on the bus satisfies the 90-day row
  await assert.rejects(B.run("buildTransferPlan", AGENT, { op: "record_notice", partner_id: "P-1", kind: "fnma_termination_without_cause", notice_on: "2026-10-01", counsel_review_requested_by_partner: true }), (e: unknown) => e instanceof CommandRefused && e.code === "ATTORNEY_ONLY_FOR_CAUSE_ON_PARTNER_REQUEST");
  await assert.rejects(B.run("createPortalTask", AGENT, { batch_id: "TB-sale", task: "counsel_review", kind: "attorney", termination_basis: "fnma_without_cause", counsel_review_requested_by_partner: true }), (e: unknown) => e instanceof CommandRefused && e.code === "ATTORNEY_ONLY_FOR_CAUSE_ON_PARTNER_REQUEST");
  await assert.rejects(B.run("createPortalTask", AGENT, { batch_id: "TB-sale", task: "termination_fee_facts", kind: "human_portal_task" }), (e: unknown) => e instanceof CommandRefused && e.code === "TERMINATION_FEE_MATTERS_TO_OFFICER");
  await assert.rejects(B.run("computeDeadlines", AGENT, { transfer_type: "servicing_sale", transfer_date: "2027-02-01", compute_termination_fee: true }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_TERMINATION_FEE_COMPUTATION");
  const fc = recordNotice({ partner_id: "P-1", kind: "fnma_termination_for_cause", notice_on: D("2026-10-01"), counsel_review_requested_by_partner: true });
  assert.deepEqual([fc.termination_fee, fc.termination_effective_on, fc.tasks.map((x) => x.kind)], ["none_a1_4_1_02", "2026-10-01", ["officer", "attorney"]]);
  assert.deepEqual([counselReviewAllowed("fnma_termination_for_cause", false), counselReviewAllowed("fnma_without_cause", true), counselReviewAllowed("fnma_for_cause", true)], [false, false, true]);
});
test("17.1-T8: Given a loan pays off Nov 27 after attestation, then it is flagged `withdrawn_after_attestation`, the removal is reported by BD2 and the transferee tape marks it.", async () => {
  const attestedOn = quickExchangeCadenceOut(T).attestation_by; assert.equal(attestedOn, "2026-11-25");
  const w = payoffAfterAttestation({ fnma_loan_number: "1000000002", paid_off_on: D("2026-11-27"), attested_on: attestedOn, transfer_date: T });
  assert.equal(w.flag, "withdrawn_after_attestation"); assert.equal(w.offboarding_status, "withdrawn"); assert.equal(w.new_list_version, false);   // after "Agree" no changes can be made
  assert.equal(w.removal_report_by, "2026-12-02");                              // BD2 (Dec 1 = BD1, Dec 2 = BD2)
  assert.equal(w.report_via, "5.3"); assert.equal(w.inform, "servicing_transfers@fanniemae.com");
  assert.equal(w.fnma_processes_on, "2026-12-03"); assert.equal(w.moves_on_bd3_unless_fnma_removes, true);
  assert.deepEqual(w.transferee_tape_marker, { fnma_loan_number: "1000000002", marker: "withdrawn_after_attestation", paid_off_on: "2026-11-27" });
  const tape = transfereeTapeRows([{ fnma_loan_number: "1000000001", offboarding_status: "frozen" }, { fnma_loan_number: "1000000002", offboarding_status: "frozen" }], [w]);
  assert.deepEqual(tape, [{ fnma_loan_number: "1000000001", offboarding_status: "frozen", marker: null, paid_off_on: null }, { fnma_loan_number: "1000000002", offboarding_status: "withdrawn", marker: "withdrawn_after_attestation", paid_off_on: "2026-11-27" }]);
  // a payoff before attestation is an ordinary deletion in a new list version (1.2-T7), not the post-attestation flag
  const before = payoffAfterAttestation({ fnma_loan_number: "1000000002", paid_off_on: D("2026-11-20"), attested_on: attestedOn, transfer_date: T });
  assert.deepEqual([before.flag, before.new_list_version, before.moves_on_bd3_unless_fnma_removes, before.transferee_tape_marker, before.removal_task], ["withdrawn", true, false, null, null]);
  assert.deepEqual([w.event.type, w.event.payload.flag, w.event.payload.removal_report_by, w.removal_task], ["transfer.loan.withdrawn", "withdrawn_after_attestation", "2026-12-02", { kind: "human_portal_task", task: "fnma_removal_report_5_3", due: "2026-12-02", inform: "servicing_transfers@fanniemae.com" }]);
  // through the bus (validateLoanList op=withdraw): the stored batch's attestation date is the fact; the loan row is flagged, `transfer.loan.withdrawn` lands on the batch and the 5.3 removal report is a portal-operator task due BD2
  const B = bus("2026-11-27T14:00:00.000Z");
  await B.run("buildTransferPlan", AGENT, { op: "propose", batch_id: "TB-out-1", partner_id: "P-1", transfer_type: "sub_to_sub", transfer_date: "2026-12-01", source: "partner_instruction", proposed_on: "2026-10-05" });
  B.rt.store.put("transfer_batches", "TB-out-1", { ...B.rt.store.get("transfer_batches", "TB-out-1")!.data, status: "loan_list_frozen", d_code: "D27", attested_at: "2026-11-25" }, OFFICER, B.ctx.clock.now());
  const r = await B.run("validateLoanList", AGENT, { op: "withdraw", batch_id: "TB-out-1", fnma_loan_number: "1000000002", paid_off_on: "2026-11-27" });
  const o = r.output as { flag: string; removal_report_by: string; removal_task_id: string | null; transferee_tape_marker: { marker: string } };
  assert.deepEqual([o.flag, o.removal_report_by, o.transferee_tape_marker.marker], ["withdrawn_after_attestation", "2026-12-02", "withdrawn_after_attestation"]);
  assert.deepEqual([B.rt.store.get("transfer_batch_loans", "TB-out-1:1000000002")!.data.withdrawal_flag, B.rt.store.get("transfer_batch_loans", "TB-out-1:1000000002")!.data.offboarding_status], ["withdrawn_after_attestation", "withdrawn"]);
  const ev = B.events.all().findLast((e) => e.type === "transfer.loan.withdrawn")!; assert.deepEqual([ev.aggregate, ev.payload.flag, ev.payload.removal_report_by, ev.payload.inform], [{ kind: "transfer_batch", id: "TB-out-1" }, "withdrawn_after_attestation", "2026-12-02", "servicing_transfers@fanniemae.com"]);
  const task = B.rt.escalations.opened.find((e) => e.id === o.removal_task_id)!; assert.deepEqual([task.kind, task.ownerRole, task.payload.task, task.payload.due], ["human_portal_task", "fnma_portal_operator", "fnma_removal_report_5_3", "2026-12-02"]);
  assert.equal(((await B.run("validateLoanList", AGENT, { op: "withdraw", batch_id: "TB-out-1", fnma_loan_number: "1000000003", paid_off_on: "2026-11-20" })).output as { removal_task_id: string | null; flag: string }).flag, "withdrawn");   // before "Agree": an ordinary deletion
});

test("17.1 worked example: Dec 1, 2026 deadline table, Quick Exchange cadence for Nov 2, 2026 and Aug 2, 2027, A1-2-01 voluntary termination effective date, fnma_directed anchors, package and termination rules", async () => {
  // rule 17.1 worked example: sub_to_sub proposed Oct 5 → Form 629 Nov 1, buffer Oct 25, portal task Fri Oct 30 (SLA +2 servicer BD → Tue Nov 3), adds Nov 10, reconciliation Nov 20, attestation Wed Nov 25 (Thanksgiving Nov 26), processing Thu Dec 3
  const d = computeDeadlines({ transfer_type: "sub_to_sub", transfer_date: T, proposed_on: D("2026-10-05"), last_batch_for_partner: true });
  const due = Object.fromEntries(d.rows.map((r) => [r.code, r.due]));
  assert.equal(d.transfer_date_gate.ok, true); assert.equal(d.anchor_basis, "transfer_date"); assert.equal(d.liability_start_date, "2026-12-01"); assert.equal(d.portal_task_on, "2026-10-30");
  assert.deepEqual([due.FNMA_A2_7_03_FORM629_SUBSERVICING_30, due.SM_FORM629_INTERNAL_BUFFER_7, due.SM_PORTAL_TASK_FORM629_SLA_2, due.SM_TRANSFER_PLAN_APPROVED_T45], ["2026-11-01", "2026-10-25", "2026-11-03", "2026-10-17"]);
  assert.match(d.rows.find((r) => r.code === "SM_PORTAL_TASK_FORM629_SLA_2")!.basis, /scheduled 2026-10-30 .*created_at \+ 2 servicer business days/);
  assert.deepEqual([due.FNMA_QX_LOAN_LIST_ADDS_CD10, due.SM_QX_RECONCILIATION_CD20, due.FNMA_QX_LOAN_LIST_FREEZE_CD25, due.FNMA_IRM_TT32_TRANSFER_RECORD_15, due.FNMA_QX_PROCESSING_BD3], ["2026-11-10", "2026-11-20", "2026-11-25", "2026-11-16", "2026-12-03"]);
  assert.deepEqual([due.FNMA_A2_1_07_FORM101_TERMINATION_5BD, due.SM_XFER_OUT_ACCESS_REVOCATION_5BD], ["2026-12-08", "2026-12-08"]);   // 17.1-T6 figures
  assert.equal(due.FNMA_A2_7_03_FORM629_SERVICING_60, undefined); assert.equal(due.FNMA_A2_1_01_TECH_PROVIDER_NOTICE_180, undefined);
  // the cadence sits in the month BEFORE the transfer date even when the first Fannie Mae business day is not the 1st: Nov 2, 2026 → Oct 10 / Oct 20 / Fri Oct 23 (Oct 25 is a Sunday) / BD3 Wed Nov 4; Aug 2, 2027 → Jul 10 / Jul 20 / Fri Jul 23 (Jul 25 is a Sunday) / BD3 Wed Aug 4
  const nov = quickExchangeCadenceOut(D("2026-11-02")); assert.deepEqual([nov.adds_by, nov.reconciliation_by, nov.attestation_by, nov.processing_on, nov.portal_task_on, nov.portal_task_sla_due], ["2026-10-10", "2026-10-20", "2026-10-23", "2026-11-04", "2026-10-02", "2026-10-06"]);
  const aug = quickExchangeCadenceOut(D("2027-08-02")); assert.deepEqual([aug.adds_by, aug.reconciliation_by, aug.attestation_by, aug.processing_on], ["2027-07-10", "2027-07-20", "2027-07-23", "2027-08-04"]);
  const vl2 = validateLoanList({ loans: [{ fnma_loan_number: "1000000004", active: true, added_on: D("2026-10-15") }], transfer_date: D("2026-11-02"), package_date: D("2026-10-01") });
  assert.deepEqual([vl2.ok, vl2.adds_by, vl2.refused_adds], [false, "2026-10-10", ["1000000004"]]);   // added Oct 15, after CD10 Oct 10
  // the portal task's SLA on the live engine: created Fri Oct 30 → due Tue Nov 3; the operator's completion satisfies it and files the Form 629 (batch `submitted`)
  const B = bus("2026-10-30T14:00:00.000Z");
  await B.run("buildTransferPlan", AGENT, { op: "propose", batch_id: "TB-out-1", partner_id: "P-1", transfer_type: "sub_to_sub", transfer_date: "2026-12-01", source: "partner_instruction", proposed_on: "2026-10-05", last_batch_for_partner: true });
  await B.run("buildTransferPlan", OFFICER, { batch_id: "TB-out-1", transfer_type: "sub_to_sub", transfer_date: "2026-12-01", elements: { communications: "c", testing: "t", milestones: "m", escalation: "e" }, approve: true });
  assert.equal(B.rt.store.get("transfer_batches", "TB-out-1")!.data.status, "plan_approved");
  const row = { transferor_servicer_number: "123456789", transferee_servicer_number: "987654321", fnma_loan_number: "1000000001", upb_cents: 24_563_412n, transferor_custodian: "Custodian A", transferee_custodian: CUSTODIAN_MATRIX_ENOTE };
  await B.run("buildForm629", AGENT, { batch_id: "TB-out-1", transfer_type: "sub_to_sub", transfer_date: "2026-12-01", rows: [row], custodian_matrix: ["Custodian A"], transferee_uses_subservicer: false, evidence: { form629_document_id: "doc-629", custodian_matrix_document_id: "doc-cm", loan_list_version: 1, form101_termination_draft_document_id: "doc-101" } });
  assert.equal(B.rt.store.get("transfer_batches", "TB-out-1")!.data.status, "package_ready");
  const task = await B.run("createPortalTask", AGENT, { batch_id: "TB-out-1", task: "form629", package: { form629_document_id: "doc-629" }, expected_artifacts: ["request ID", "validation e-mail", "approval letter"] });
  const esc = task.output as { escalation_id: string; kind: string; owner_role: string; sla: string };
  assert.deepEqual([esc.kind, esc.owner_role, esc.sla], ["human_portal_task", "fnma_portal_operator", "SM_PORTAL_TASK_FORM629_SLA_2"]);
  const sla = B.ctx.timers.all().find((t) => t.code === "SM_PORTAL_TASK_FORM629_SLA_2")!; assert.deepEqual([sla.dueDate, sla.status, sla.subject], ["2026-11-03", "armed", { kind: "escalation", id: esc.escalation_id }]);
  // the arming event is the EscalationService's `escalation.created{kind=human_portal_task, task=form629}`; the tool projects it onto the batch (portal_task_ids, SLA anchor = created_at Fri Oct 30, due Tue Nov 3)
  const createdEv = B.events.ofType("escalation.created").find((e) => e.payload.escalation_id === esc.escalation_id)!;
  assert.deepEqual([createdEv.payload.kind, createdEv.payload.task, createdEv.payload.batch_id, createdEv.aggregate, eventMatches(registry().get("SM_PORTAL_TASK_FORM629_SLA_2")!.triggerPattern!, createdEv)], ["human_portal_task", "form629", "TB-out-1", { kind: "escalation", id: esc.escalation_id }, true]);
  assert.deepEqual(form629PortalTaskOpened(createdEv), { timer: "SM_PORTAL_TASK_FORM629_SLA_2", escalation_id: esc.escalation_id, batch_id: "TB-out-1", created_at: "2026-10-30", sla_due: "2026-11-03", satisfied_by: "escalation.completed" });
  assert.equal(form629PortalTaskOpened({ ...createdEv, payload: { ...createdEv.payload, task: "connect_bd3" } }), null);
  const esc2 = task.output as { sla_created_at: string; sla_due: string };
  assert.deepEqual([esc2.sla_created_at, esc2.sla_due, B.rt.store.get("transfer_batches", "TB-out-1")!.data.portal_task_ids, B.rt.store.get("transfer_batches", "TB-out-1")!.data.form629_portal_task_sla_due], ["2026-10-30", "2026-11-03", [esc.escalation_id], "2026-11-03"]);
  await assert.rejects(B.run("createPortalTask", AGENT, { op: "complete", escalation_id: esc.escalation_id, task: "form629", batch_id: "TB-out-1", qx_request_id: "QX-4711" }), /completed by role fnma_portal_operator/);
  await B.run("createPortalTask", OPERATOR, { op: "complete", escalation_id: esc.escalation_id, task: "form629", batch_id: "TB-out-1", qx_request_id: "QX-4711", evidence_document_id: "doc-qx-confirmation" });
  assert.deepEqual([sla.status, B.rt.store.get("transfer_batches", "TB-out-1")!.data.status, B.rt.store.get("transfer_batches", "TB-out-1")!.data.qx_request_id, B.rt.store.get("transfer_batches", "TB-out-1")!.data.qx_status], ["satisfied", "submitted", "QX-4711", "New"]);
  assert.equal(eventMatches(registry().get("SM_PORTAL_TASK_FORM629_SLA_2")!.satisfiedPattern!, B.events.all().findLast((e) => e.type === "escalation.completed")!), true);
  assert.deepEqual(B.ctx.timers.all().filter((t) => t.code === "FNMA_A2_7_03_FORM629_SUBSERVICING_30" || t.code === "SM_FORM629_INTERNAL_BUFFER_7").map((t) => t.status), ["satisfied", "satisfied"]);
  // servicing sale: sale date Nov 16 → 60-day clock → Sept 17, 2026; liability starts on the earlier of sale/transfer; ≥20,000 loans with Supermortgage as technology provider → 180-day notice Jun 4, 2026
  const s = computeDeadlines({ transfer_type: "servicing_sale", transfer_date: T, sale_date: D("2026-11-16"), loan_count: 20_000, supermortgage_is_tech_provider: true });
  const sdue = Object.fromEntries(s.rows.map((r) => [r.code, r.due]));
  assert.deepEqual([sdue.FNMA_A2_7_03_FORM629_SERVICING_60, sdue.SM_FORM629_INTERNAL_BUFFER_7, s.liability_start_date, sdue.FNMA_A2_1_01_TECH_PROVIDER_NOTICE_180, s.portal_task_on, sdue.SM_PORTAL_TASK_FORM629_SLA_2], ["2026-09-17", "2026-09-10", "2026-11-16", "2026-06-04", "2026-09-16", "2026-09-18"]);
  // A2-1-01 on the live engine: the proposal states the technology-provider fact as it is and carries the ≥20,000-loan applicability separately; the 180-day row arms only for the large portfolio (T−180 = Jun 4, 2026) and the partner's notice, recorded against that batch, satisfies it
  const tech = { partner_id: "P-1", transfer_type: "servicing_sale" as const, transfer_date: T, sale_date: D("2026-11-16"), termination_basis: "sale" as const, supermortgage_is_tech_provider: true, source: "partner_instruction" as const, proposed_on: D("2026-05-01") };
  const small = proposeBatch({ ...tech, batch_id: "TB-small", loan_count: 500 }), big = proposeBatch({ ...tech, batch_id: "TB-big", loan_count: 20_000 });
  assert.deepEqual([small.event.payload.supermortgage_is_tech_provider, small.event.payload.tech_provider_notice_required, big.event.payload.tech_provider_notice_required, small.batch.supermortgage_is_tech_provider], [true, false, true, true]);
  const LT = liveEngine("2026-05-01T14:00:00.000Z"); LT.emit(small.event, D("2026-05-01"), "TB-small"); assert.equal(LT.timer("FNMA_A2_1_01_TECH_PROVIDER_NOTICE_180"), undefined);
  LT.emit(big.event, D("2026-05-01"), "TB-big"); assert.deepEqual([LT.timer("FNMA_A2_1_01_TECH_PROVIDER_NOTICE_180")!.dueDate, LT.timer("FNMA_A2_1_01_TECH_PROVIDER_NOTICE_180")!.subject], ["2026-06-04", { kind: "transfer_batch", id: "TB-big" }]);
  const tn = recordNotice({ partner_id: "P-1", kind: "fnma_tech_provider_notice_sent", notice_on: D("2026-06-01"), batch_id: "TB-big" }); assert.deepEqual([tn.events[0]!.type, tn.events[0]!.aggregate], ["fnma.tech_provider_notice.sent", { kind: "transfer_batch", id: "TB-big" }]);
  LT.emit(tn.events[0]!, D("2026-06-01"), "TB-big"); assert.equal(LT.timer("FNMA_A2_1_01_TECH_PROVIDER_NOTICE_180")!.status, "satisfied");
  assert.equal(computeDeadlines({ transfer_type: "sub_to_sub", transfer_date: D("2026-12-02") }).transfer_date_gate.ok, false);   // 17.1-T2: Dec 2 is not the first Fannie Mae business day
  // fnma_directed without an instruction date follows the registry row: earlier of sale/transfer − 60 = Oct 2, 2026 (A2-7-03 "at least 60 days prior")
  const fd = computeDeadlines({ transfer_type: "fnma_directed", transfer_date: T, termination_basis: "fnma_without_cause" });
  assert.deepEqual([fd.anchor_basis, fd.rows.find((r) => r.code === "FNMA_A2_7_03_FORM629_SERVICING_60")!.due, fd.rows.find((r) => r.code === "SM_FORM629_INTERNAL_BUFFER_7")!.due], ["transfer_date", "2026-10-02", "2026-09-25"]);
  // fnma_directed for cause with immediate effect: Fannie Mae's instruction (received Oct 15) overrides the cadence — every pre-transfer row moves to the instruction's anchors, BD3 stays Fannie Mae's processing day, the termination rows still run +5 BD from the transfer date
  const f = computeDeadlines({ transfer_type: "fnma_directed", transfer_date: T, termination_basis: "fnma_for_cause", fnma_instruction_date: D("2026-10-15"), last_batch_for_partner: true });
  const fdue = Object.fromEntries(f.rows.map((r) => [r.code, r.due]));
  assert.equal(f.anchor_basis, "fnma_instruction"); assert.ok(f.rows.every((r) => r.basis.includes("[anchor: fnma_instruction")));
  assert.deepEqual([fdue.FNMA_A2_7_03_FORM629_SERVICING_60, fdue.SM_FORM629_INTERNAL_BUFFER_7, fdue.SM_TRANSFER_PLAN_APPROVED_T45, fdue.SM_PORTAL_TASK_FORM629_SLA_2, fdue.FNMA_QX_LOAN_LIST_ADDS_CD10, fdue.SM_QX_RECONCILIATION_CD20, fdue.FNMA_QX_LOAN_LIST_FREEZE_CD25, fdue.FNMA_IRM_TT32_TRANSFER_RECORD_15], ["2026-10-15", "2026-10-15", "2026-10-15", "2026-10-19", "2026-10-15", "2026-10-15", "2026-10-15", "2026-10-15"]);
  assert.deepEqual([fdue.FNMA_QX_PROCESSING_BD3, fdue.FNMA_A2_1_07_FORM101_TERMINATION_5BD, fdue.SM_XFER_OUT_ACCESS_REVOCATION_5BD], ["2026-12-03", "2026-12-08", "2026-12-08"]);
  const f2 = computeDeadlines({ transfer_type: "fnma_directed", transfer_date: T, termination_basis: "fnma_for_cause", fnma_instruction: { received_on: D("2026-10-15"), form629_by: D("2026-10-22"), loan_list_by: D("2026-11-06") } });
  const f2due = Object.fromEntries(f2.rows.map((r) => [r.code, r.due]));
  assert.deepEqual([f2due.FNMA_A2_7_03_FORM629_SERVICING_60, f2due.FNMA_QX_LOAN_LIST_ADDS_CD10, f2due.FNMA_QX_LOAN_LIST_FREEZE_CD25, f2due.FNMA_QX_PROCESSING_BD3], ["2026-10-22", "2026-11-06", "2026-11-06", "2026-12-03"]);
  // A1-2-01: voluntary termination effective on the last Fannie Mae business day of the third month after the notice month; the partner's notice arms it on the live engine and the last batch's cutover (partner subject) satisfies it
  assert.equal(voluntaryTerminationEffective(D("2026-09-10")), "2026-12-31");
  assert.equal(voluntaryTerminationEffective(D("2026-10-15")), "2027-01-29");   // Jan 31, 2027 is a Sunday
  const vn = recordNotice({ partner_id: "P-1", kind: "partner_voluntary_termination", notice_on: D("2026-09-10") });
  assert.deepEqual([vn.events[0]!.type, vn.events[0]!.payload.voluntary_termination_effective_on, vn.events[0]!.payload.scope, vn.termination_effective_on], ["partner.termination_notice.sent", "2026-12-31", "all_loans", "2026-12-31"]);
  const L = liveEngine("2026-09-10T14:00:00.000Z"); L.emit(vn.events[0]!, D("2026-09-10"), "P-1");
  const vt = L.timer("FNMA_A1_2_01_VOLUNTARY_TERMINATION_EFFECTIVE")!; assert.deepEqual([vt.dueDate, vt.subject], ["2026-12-31", { kind: "partner", id: "P-1" }]);
  const last = proposeBatch({ batch_id: "TB-last", partner_id: "P-1", transfer_type: "sub_to_master", transfer_date: T, termination_basis: "partner_voluntary_termination", last_batch_for_partner: true, source: "partner_instruction" });
  assert.equal(last.batch.form629_rule, "30_day_subservicing"); for (const e of last.events) L.emit(e, D("2026-09-15"), last.batch.batch_id);
  assert.equal(L.timer("FNMA_A2_7_03_FORM629_SUBSERVICING_30", "TB-last")!.dueDate, "2026-11-01");   // sub_to_master arms the shared 30-day row too
  const cut = transitionTransferOut({ ...last.batch, status: "cutover", d_code: "D50" }, "post_transfer", { final_tape_delivered: true, trial_balance_delivered: true, funds_wired: true, payment_holds_set: true }, T);
  for (const e of cut.events) L.emit(e, T, last.batch.batch_id);
  assert.equal(vt.status, "satisfied");
  assert.equal(allBatchesCutover([{ status: "cutover" }, { status: "post_transfer" }]), true); assert.equal(allBatchesCutover([{ status: "cutover" }, { status: "loan_list_frozen" }]), false); assert.equal(allBatchesCutover([]), false);
  const cn = recordNotice({ partner_id: "P-1", kind: "contract_termination_notice_received", notice_on: D("2026-10-09"), loan_count: 21_000 });
  L.emit(cn.events[0]!, D("2026-10-13"), "P-1"); assert.equal(L.timer("FNMA_A2_1_01_CONTRACT_NOTICE_5BD")!.dueDate, "2026-10-19");   // Fri Oct 9 + 5 servicer BD, anchored on the notice date not the Oct 13 ingestion; Columbus Day (Mon Oct 12) is observed
  // Bulletin 2020-02 plan: all four elements, officer approval by T−45 (Oct 17)
  const plan = transferPlan({ batch_id: "TB-out-1", transfer_type: "sub_to_sub", transfer_date: T, elements: { communications: "c", testing: "t", milestones: "m" } });
  assert.deepEqual([plan.status, plan.missing_elements, plan.approve_by, plan.approval_required_by], ["draft", ["escalation"], "2026-10-17", "officer"]);
  assert.throws(() => approvePlan(plan, OFFICER), /missing escalation/);
  const full = transferPlan({ ...{ batch_id: "TB-out-1", transfer_type: "sub_to_sub" as const, transfer_date: T }, elements: { communications: "c", testing: "t", milestones: "m", escalation: "e" } });
  assert.throws(() => approvePlan(full, AGENT), /officer act/); assert.deepEqual(approvePlan(full, OFFICER), { status: "plan_approved", approved_by: "u-officer", event: "transfer.plan.approved" });
  // Form 629 template: 9-digit servicer numbers, 10-digit loan numbers, custodians exactly as in the matrix, a separate form for acquired properties, subservicer question
  const ok = form629Package({ transfer_type: "sub_to_sub", transfer_date: T, rows: [row, { ...row, fnma_loan_number: "1000000002", kind: "acquired_property", special_notification: "emortgage" }], custodian_matrix: ["Custodian A", CUSTODIAN_MATRIX_ENOTE], transferee_uses_subservicer: true, transferee_subservicer_number: "111111111" });
  assert.deepEqual([ok.ok, ok.loan_rows, ok.acquired_property_rows, ok.separate_forms, ok.subservicer_question, ok.special_notifications, ok.deadline, ok.event], [true, 1, 1, ["acquired_properties"], { will_subservicer_be_used: true, subservicer_number: "111111111" }, [{ fnma_loan_number: "1000000002", kind: "emortgage" }], "2026-11-01", "transfer.form629.prepared"]);
  const bad = form629Package({ transfer_type: "sub_to_sub", transfer_date: D("2026-12-02"), rows: [{ ...row, transferee_servicer_number: "98765", transferor_custodian: "custodian a" }], custodian_matrix: ["Custodian A"], transferee_uses_subservicer: true, transferee_subservicer_number: null });
  assert.equal(bad.ok, false); assert.equal(bad.errors.length, 4); assert.match(bad.errors[0]!, /first Fannie Mae business day/); assert.match(bad.errors.join("\n"), /exactly as shown in the Custodian Matrix/); assert.match(bad.errors.join("\n"), /A2-1-07/);
  // loan-list integrity: nothing may be added after CD10; no loan on two open batches
  const vl = validateLoanList({ loans: [{ fnma_loan_number: "1000000001", active: true }, { fnma_loan_number: "1000000004", active: true, added_on: D("2026-11-11") }, { fnma_loan_number: "1000000005", active: true, other_open_batch_id: "TB-out-2" }], transfer_date: T, package_date: D("2026-10-30") });
  assert.deepEqual([vl.ok, vl.adds_by, vl.refused_adds, vl.listed], [false, "2026-11-10", ["1000000004"], ["1000000001", "1000000005"]]); assert.match(vl.errors.join("\n"), /already on open batch TB-out-2/);
  await assert.rejects(B.run("validateLoanList", AGENT, { op: "submit_version", batch_id: "TB-out-1", transfer_date: "2026-12-01", submitted_on: "2026-11-12", previous: { version: 1, loans: ["1000000001"], attested: false, created_on: "2026-10-30" }, loans: ["1000000001", "1000000006"] }), (e: unknown) => e instanceof CommandRefused && e.code === "NOTHING_ADDED_AFTER_CD10");
  const sv = await B.run("validateLoanList", AGENT, { op: "submit_version", batch_id: "TB-out-1", transfer_date: "2026-12-01", submitted_on: "2026-11-06", previous: { version: 1, loans: ["1000000001"], attested: false, created_on: "2026-10-30" }, loans: ["1000000001", "1000000006"] });
  const vs = B.events.all().findLast((e) => e.type === "transfer.loan_list.version_submitted")!; assert.deepEqual([(sv.output as { adds: string[] }).adds, vs.payload.adds, vs.payload.added, vs.payload.version], [["1000000006"], 1, ["1000000006"], 2]);
  // termination scope: zero-fee loans included; acquired properties on a separate Form 629 unless closed / claim-only
  const scope = terminationPortfolioScope({ termination_basis: "partner_voluntary_termination", loans: [{ id: "L1", kind: "loan", active: true, servicing_fee_cents: 0n }, { id: "L2", kind: "loan", active: true, servicing_fee_cents: 12_500n }, { id: "REO1", kind: "acquired_property", active: false, servicing_fee_cents: 0n }, { id: "REO2", kind: "acquired_property", active: false, servicing_fee_cents: 0n, fnma_records_closed: true }, { id: "REO3", kind: "acquired_property", active: false, servicing_fee_cents: 0n, awaiting_claim_reimbursement_only: true }] });
  assert.deepEqual([scope.applies, scope.included, scope.acquired_properties_separate_form629, scope.excluded.map((e) => e.id)], [true, ["L1", "L2"], ["REO1"], ["REO2", "REO3"]]);
  assert.equal(terminationPortfolioScope({ termination_basis: "partner_instruction", loans: [{ id: "L1", kind: "loan", active: true, servicing_fee_cents: 0n }] }).applies, false);
  // Supermortgage may not stop servicing before the approved transfer date — the rule and the cutover guardrail on the bus
  assert.match(servicingStopGate({ proposed_stop_on: D("2026-11-30"), transfer_date: T, fnma_approved: true }).refusal!, /before the approved transfer date 2026-12-01/);
  assert.match(servicingStopGate({ proposed_stop_on: T, transfer_date: T, fnma_approved: false }).refusal!, /unauthorized transfer will not be recognized/); assert.equal(servicingStopGate({ proposed_stop_on: T, transfer_date: T, fnma_approved: true }).ok, true);
  await assert.rejects(B.run("buildTransferPlan", AGENT, { op: "milestone", batch_id: "TB-out-1", to: "cutover", on: "2026-11-30", transfer_date: "2026-12-01" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_SERVICING_STOP_BEFORE_TRANSFER_DATE");
  // approval letter parse (loan count "1,250 loans" = 1250) → officer confirmation; the officer's acceptance moves the batch to `approved` and arms the Quick Exchange rows; the agent cannot
  const letter = parseApprovalLetter("Fannie Mae approves the servicing transfer of 1,250 loans effective 2026-12-01. D-Code D27, subject to delivery of custodial documents to the transferee custodian.");
  assert.deepEqual([letter.outcome, letter.d_code, letter.effective_date, letter.conditions.length, letter.loan_count, letter.officer_confirmation_required, letter.next_status], ["approved", "D27", "2026-12-01", 1, 1250, true, "approved"]);
  assert.equal(parseApprovalLetter("approved: 250 loans").loan_count, 250); assert.equal(parseApprovalLetter("approved: 12,345,678 mortgage loans").loan_count, 12_345_678);
  assert.equal(parseApprovalLetter("Fannie Mae requires a longer timeframe for this request.").next_status, "on_hold"); assert.equal(parseApprovalLetter("Request denied.").next_status, "denied");
  await assert.rejects(B.run("parseApprovalLetter", AGENT, { batch_id: "TB-out-1", text: "Fannie Mae approves the servicing transfer of 1,250 loans effective 2026-12-01. D-Code D27.", mark_approved: true }), (e: unknown) => e instanceof CommandRefused && e.code === "CONDITIONS_ACCEPTED_BY_OFFICER");
  // neither a milestone with a hash and D-Code (no officer) nor a caller-supplied batch state moves the stored batch to `approved`
  await assert.rejects(B.run("buildTransferPlan", AGENT, { op: "milestone", batch_id: "TB-out-1", to: "approved", evidence: { approval_letter_document_hash: "sha256:fake", d_code: "D99" } }), (e: unknown) => e instanceof CommandRefused && e.code === "APPROVAL_CONFIRMED_BY_OFFICER");
  await assert.rejects(B.run("buildTransferPlan", OFFICER, { op: "milestone", batch: { batch_id: "TB-out-1", status: "submitted", d_code: "FAKE" }, batch_id: "TB-out-1", to: "approved", evidence: { approval_letter_document_hash: "sha256:fake", d_code: "D99" } }), (e: unknown) => e instanceof CommandRefused && e.code === "BATCH_STATE_IS_THE_STORE");
  assert.deepEqual([B.rt.store.get("transfer_batches", "TB-out-1")!.data.status, B.rt.store.get("transfer_batches", "TB-out-1")!.data.d_code], ["submitted", null]);
  assert.throws(() => applyFnmaOutcome({ ...last.batch, status: "submitted" }, letter, { actor: OFFICER, on: D("2026-11-04"), approval_letter_document_hash: "sha256:x" }), /1 condition\(s\): the officer must accept them/);
  const ap = await B.run("parseApprovalLetter", OFFICER, { batch_id: "TB-out-1", text: "Fannie Mae approves the servicing transfer of 1,250 loans effective 2026-12-01. D-Code D27, subject to delivery of custodial documents to the transferee custodian.", accept_conditions: true, approval_letter_document_hash: "sha256:letter", on: "2026-11-04" });
  assert.deepEqual([(ap.output as { status: string; events: string[] }).status, (ap.output as { events: string[] }).events], ["approved", ["transfer.form629.approved", "transfer.batch.approved"]]);
  const armed = Object.fromEntries(B.ctx.timers.all().map((t) => [t.code, t.dueDate])); assert.deepEqual([armed.FNMA_QX_LOAN_LIST_ADDS_CD10, armed.SM_QX_RECONCILIATION_CD20, armed.FNMA_QX_LOAN_LIST_FREEZE_CD25, armed.FNMA_IRM_TT32_TRANSFER_RECORD_15], ["2026-11-10", "2026-11-20", "2026-11-25", "2026-11-16"]);
  assert.equal(B.rt.store.get("transfer_batches", "TB-out-1")!.data.qx_status, "Approval Letters Sent");
  // `loan_list_frozen` takes only the attestation reconcileQxDownload recorded: a caller-supplied version is refused and, with none recorded, the milestone is blocked
  await assert.rejects(B.run("buildTransferPlan", OFFICER, { op: "milestone", batch_id: "TB-out-1", to: "loan_list_frozen", evidence: { attested_version: { version: 1, loans: ["1000000001"], attested: true, attested_by: "nobody", created_on: "2026-10-30" } } }), (e: unknown) => e instanceof CommandRefused && e.code === "ATTESTATION_EVIDENCE_IS_RECORDED");
  await assert.rejects(B.run("buildTransferPlan", OFFICER, { op: "milestone", batch_id: "TB-out-1", to: "loan_list_frozen" }), /loan_list_frozen requires the attestation evidence/);
  assert.equal(B.rt.store.get("transfer_batches", "TB-out-1")!.data.status, "approved");
  // Form 101 termination draft → officer e-mails by Dec 8 (the agent's `submit` is refused); Fannie Mae correspondence is officer-sent; no borrower contact
  const f101 = form101TerminationDraft({ batch_id: "TB-out-1", partner_servicer_number: "123456789", last_cutover_on: T });
  assert.deepEqual([f101.to, f101.due, f101.status, f101.sent_by, f101.access_revocation_by, f101.satisfied_by], ["Technology_Registration@fanniemae.com", "2026-12-08", "draft_pending_officer", "officer", "2026-12-08", "transfer.form101_termination.submitted"]);
  await assert.rejects(B.run("draftForm101Termination", AGENT, { batch_id: "TB-out-1", partner_servicer_number: "123456789", last_cutover_on: "2026-12-01", submit: true, evidence_document_id: "doc-mail" }), (e: unknown) => e instanceof CommandRefused && e.code === "FORM101_TERMINATION_IS_OFFICER");
  const f101s = await B.run("draftForm101Termination", OFFICER, { batch_id: "TB-out-1", partner_servicer_number: "123456789", last_cutover_on: "2026-12-01", submit: true, evidence_document_id: "doc-mail", on: "2026-12-07" });
  assert.deepEqual([(f101s.output as { status: string; on_time: boolean }).status, (f101s.output as { on_time: boolean }).on_time, B.events.all().findLast((e) => e.type === "transfer.form101_termination.submitted")!.payload.evidence_document_id], ["submitted", true, "doc-mail"]);
  await assert.rejects(B.run("draftFnmaResponse", AGENT, { batch_id: "TB-out-1", query: "please confirm the custodian", send: true }), (e: unknown) => e instanceof CommandRefused && e.code === "FNMA_CORRESPONDENCE_IS_OFFICER");
  await B.run("draftFnmaResponse", OFFICER, { batch_id: "TB-out-1", query: "please confirm the custodian", qx_request_id: "QX-4711", send: true }); assert.deepEqual(B.events.all().findLast((e) => e.type === "transfer.fnma_correspondence.sent")!.payload.to, "servicing_transfers@fanniemae.com");
  assert.throws(() => partnerNotification({ batch_id: "TB-out-1", subject: "x", audience: "borrower" }), /no borrower contact in 17\.1/); assert.equal(partnerNotification({ batch_id: "TB-out-1", subject: "package ready" }).event, "partner.notified");
  await assert.rejects(B.run("notifyPartner", AGENT, { batch_id: "TB-out-1", subject: "x", audience: "borrower" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_BORROWER_CONTACT");
});
