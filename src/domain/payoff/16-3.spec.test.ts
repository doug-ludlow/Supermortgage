// 16.3 Lien release / satisfaction recording
// spec/sections/16-payoff-lien-release/16-3-lien-release-satisfaction-recording.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandContext } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_16_3, releaseReactors_16_3 } from "../../app/tools/section16-3.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeCustodian } from "../../infra/integrations/custody.ts";
import { FakeErecording } from "../../infra/integrations/legal.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { recorderReject, recordingSubmission, recordedRelease, recorderFee, assignmentGap, releaseFeePosting, penaltyPosting, payoffReversal, executionCommand, selectInstrument, instrumentTypeFor, lpoaGate, openReleaseTask, custodyRequest, releaseChecklist, borrowerNotification, njCancellationNotice, caTrusteePath, mdDelivery, fnmaExecutionPackage, penaltyExposureReport, statutoryDeadline, releaseRule, sha256, fundsAnchor, ledgerEntrySet, paperRecordingPackage, mailTrackingBarcode, reversalState, statutoryDutyEvent, PENALTY_FORBIDDEN_TARGETS, RELEASE_TIMERS_16_3 } from "./ops-16-3.ts";
import type { AccountRef } from "../../kernel/ledger/ledger.ts";
import { deactivationClocks } from "./release.ts";

const AGENT: Actor = { kind: "agent", id: "payoff-release" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const ATTORNEY: Actor = { kind: "human", id: "u-attorney", role: "attorney" };
const AGENT_CTX = { actor: AGENT, now: "2026-10-23T14:00:00.000Z" } as unknown as CommandContext;
const tool = (name: string) => TOOLS_16_3.find((t) => t.name === name)!;
const guard = (name: string, code: string) => tool(name).guardrails!.find((g) => g.code === code)!;
const ALL_PRESENT = Object.fromEntries(["instrument_title", "min", "fnma_loan_number", "original_recording_reference", "legal_description", "borrower_names_as_recorded", "property_address_apn", "full_satisfaction_statement", "signatory_block", "notary_acknowledgment_form", "pria_cover_sheet", "return_to_address", "fees_from_recorder_schedule"].map((k) => [k, true]));
const RECIPIENTS = [{ partyId: "B1", name: "A. Borrower", mailingAddress: "12 Elm St, Columbus OH 43215" }];
const noticeReg = buildRegistry(); publishAuthored(noticeReg);
const sample = (code: string) => noticeReg.activeVersion(code, D("2026-10-27"))!.samplePayload;

/** The 16.3 tools on the bus over the overridden timer registry (16.3 rows only), the Notice Registry, the custodian / eRecording / print-mail fakes and the module's event reactors (`loan.paid_in_full` opens the task, `payoff.reversed` voids it); `loan` seeds the `loans` row the automatic open reads. */
function harness(loanId: string, nowIso: string, opts: { loan?: Record<string, unknown> | null; reactors?: boolean } = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["16.3"] });
  const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const custodian = new FakeCustodian(); custodian.holdingsByLoan.set("1234567890", { fnmaLoanNumber: "1234567890", custodianLoanId: "C-1", status: "certified", exceptions: [], documents: ["note", "security_instrument"] });
  const erecording = new FakeErecording(); erecording.coverage.add("OH:Franklin"); const printMail = new FakePrintMail();
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }), ports: { custodian, erecording, printMail, edelivery: new FakeEdelivery() } };
  if (opts.loan) rt.store.put("loans", loanId, opts.loan, OFFICER, nowIso);
  const off = opts.reactors === false ? () => {} : releaseReactors_16_3({ events, timers, store: rt.store, escalations: rt.escalations });
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_16_3); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("16.3", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const paidInFull = (payoffOn: string, extra: Record<string, unknown> = {}) => events.append({ type: "loan.paid_in_full", loanId, actor: AGENT, payload: { settlement_id: `ps-${loanId}-${payoffOn}`, payoff_date: payoffOn, funds_received_on: payoffOn, remittance_type: "aa", ...extra } });
  /** 16.2's reversal event as postPayoff op=reverse emits it (pre-close branch unless `extra` says otherwise). */
  const reverse = (returnedOn: string, cause: string, extra: Record<string, unknown> = {}) => events.append({ type: "payoff.reversed", loanId, actor: AGENT, payload: { settlement_id: `ps-${loanId}-2026-10-16`, branch: "pre_close", cause, returned_on: returnedOn, ...extra } });
  const ofType = (type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
  const armedTimers = () => timers.forSubject("loan", loanId).filter((t) => t.status === "armed" || t.status === "breached");
  const row = (id: string) => rt.store.get("release_tasks", id)!.data;
  return { rt, uow, events, timers, run, at, timer, paidInFull, reverse, ofType, armedTimers, row, decisions, erecording, custodian, printMail, off };
}
/** The Ohio loan of worked example 1 as the `loans` row the payoff event's automatic open reads. */
const OH_LOAN = { state: "OH", county: "Franklin", security_instrument: "mortgage", mortgagee_of_record: "mers", min: "1000123-0000456789-0", min_active: true, fnma_loan_number: "1234567890" };
const corpAcct = (account: string): AccountRef => ({ scope: "corporate", account: account as "corporate_cash" });
const loanAcct = (loanId: string, account: string): AccountRef => ({ scope: "loan", loanId, account: account as "principal" });
const lines = (set: { lines: readonly { account: AccountRef; amountCents: bigint }[] }) => set.lines.map((l) => [l.account.scope === "loan" ? `loan:${l.account.loanId}:${l.account.account}` : `corporate:${l.account.account}`, l.amountCents]);
const OH_OPEN = { loan_id: "L-OH", state: "OH", county: "Franklin", security_instrument: "mortgage", mortgagee_of_record: "mers", min_active: true, mers_registered: true, min: "1000123-0000456789-0", fnma_loan_number: "1234567890", payoff_on: "2026-10-16", settlement_id: "ps-L-OH-2026-10-16", payoff_evidence_document_id: "doc-payoff-L-OH" };
const OH_DRAFT = { borrower_names: ["A. Borrower"], property_address: "12 Elm St, Columbus OH 43215", original_recording_reference: "Instrument No. 201905030054321", original_recording_date: "2019-05-03", county: "Franklin", original_lender: "Acme Lending LLC", partner_name: "Partner Bank" };
const refusedWith = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
/** Drafts, checks, routes, executes/notarizes, submits and records the task on the bus (worked example 1's steps at the clock's current date). */
async function throughRecording(h: ReturnType<typeof harness>, rid: string, o: { county: string; state: string; recorded_on: string; reference?: string; image?: string; submit?: Record<string, unknown> }) {
  await h.run("draftReleaseInstrument", { release_task_id: rid, ...OH_DRAFT, county: o.county }); await h.run("runReleaseChecklist", { release_task_id: rid, present: ALL_PRESENT, county_requires_legal_description: false });
  await h.run("routeForExecution", { release_task_id: rid }); await h.run("scheduleNotarySession", { release_task_id: rid, recording_state: o.state, op: "completed", signing_officer_id: "so-1", audit_trail: "journal", executed_document: "release /s/" });
  const sub = await h.run("submitRecording", { release_task_id: rid, pages: 2, ...(o.submit ?? {}) });
  const rec = await h.run("submitRecording", { release_task_id: rid, op: "recorded", submission_id: sub.submission_id, recording_reference: o.reference ?? "Instrument No. 202610260012345", recorded_on: o.recorded_on, recorded_image: o.image ?? `%PDF recorded ${rid}` });
  return { sub, rec };
}

test("16.3-T1: Given worked example 1, then `STATE_LIEN_RELEASE_DEADLINE.due_at` = 2027-01-14, the instrument recites the MIN and Fannie Mae loan number, and recording on 10/26 satisfies the timer with the recorded image hashed.", async () => {
  const h = harness("L-OH", "2026-10-16T15:00:00.000Z", { loan: OH_LOAN }); const rid = "rt-L-OH-Franklin-2026-10-16";
  // `loan.paid_in_full` → open release_tasks: the payoff event itself opens the task (state from the loans row) and the statutory clock arms before any agent acts
  h.paidInFull("2026-10-16");
  assert.equal(h.ofType("lien_release.task_opened").length, 1); assert.equal(h.row(rid).opened_by, "payoff_event"); assert.equal(h.row(rid).selection_pending, false); assert.equal(h.row(rid).status, "opened"); assert.equal(h.ofType("lien_release.task_opened")[0]!.causationId, h.ofType("loan.paid_in_full")[0]!.id);
  // the statutory clock arms from the task-opened event on the computed anchor: 10/16 + 90 = Thu 2027-01-14 (R.C. §5301.36), no roll-forward
  const statutory = h.timer("STATE_LIEN_RELEASE_DEADLINE")!; assert.equal(statutory.dueDate, "2027-01-14"); assert.equal(statutory.anchorDate, "2027-01-14"); assert.equal(statutory.status, "armed");
  assert.equal(h.timer("SM_RELEASE_PREPARE_5BD")!.dueDate, "2026-10-23", "loan.paid_in_full payoff_date + 5 servicer BD"); assert.equal(h.timer("SM_RELEASE_SUBMIT_21")!.dueDate, "2026-11-06"); assert.equal(h.timer("FNMA_F110_FORM2009_CUSTODY_REQUEST_1BD"), undefined, "no originals required in Ohio");
  // the agent's rule-1 selection from the title chain refreshes the same row: no second task, no re-arming
  const sel = await h.run("selectReleaseInstrument", OH_OPEN);
  assert.equal(sel.release_task_id, rid); assert.equal(sel.created, false); assert.equal(sel.instrument_type, "release_of_mortgage"); assert.equal(sel.signatory_path, "mers_signing_officer"); assert.equal((sel.task as { status: string }).status, "opened");
  assert.equal(h.ofType("lien_release.task_updated").length, 1); assert.equal(h.ofType("lien_release.task_opened").length, 1); assert.equal(h.timers.byCode("STATE_LIEN_RELEASE_DEADLINE").length, 1); assert.equal(h.rt.store.list("release_tasks").length, 1);
  // a payoff whose state is on neither the event nor the loan/property rows cannot open: ops escalation, `lien_release.task_open_failed`, and no clock until the agent opens it
  const blind = harness("L-NOSTATE", "2026-10-16T15:00:00.000Z"); blind.paidInFull("2026-10-16");
  assert.equal(blind.ofType("lien_release.task_open_failed")[0]!.payload.missing, "state"); assert.equal(blind.rt.escalations.opened[0]!.ownerRole, "ops_analyst"); assert.equal(blind.timer("STATE_LIEN_RELEASE_DEADLINE"), undefined);
  await blind.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-NOSTATE" }); assert.equal(blind.timer("STATE_LIEN_RELEASE_DEADLINE")!.dueDate, "2027-01-14"); assert.equal(blind.row("rt-L-NOSTATE-Franklin-2026-10-16").opened_by, "agent");
  // the drafted instrument recites the MIN and the Fannie Mae loan number (F-1-09) and is hashed into documents
  const inst = await h.run("draftReleaseInstrument", { release_task_id: rid, ...OH_DRAFT });
  assert.equal(inst.recites_min, true); assert.equal(inst.recites_fnma_loan_number, true); assert.match(inst.text as string, /MIN: 1000123-0000456789-0/); assert.match(inst.text as string, /Fannie Mae Loan No\.: 1234567890/); assert.match(inst.signatory_block as string, /MERS Signing Officer/); assert.equal(inst.sha256, sha256(inst.text as string));
  assert.equal(h.rt.store.get("documents", inst.document_id as string)!.data.kind, "release_instrument_unsigned");
  // prepared Wed 10/21 (checklist passed) → SM_RELEASE_PREPARE_5BD satisfied; execute clock from prepared_at
  h.at("2026-10-21T16:00:00.000Z"); const chk = await h.run("runReleaseChecklist", { release_task_id: rid, present: ALL_PRESENT, county_requires_legal_description: false });
  assert.equal(chk.passed, true); assert.equal(chk.status, "prepared"); assert.equal(h.timer("SM_RELEASE_PREPARE_5BD")!.status, "satisfied");
  assert.equal(h.timer("SM_RELEASE_EXECUTE_3BD")!.dueDate, "2026-10-26", "registry row: prepared_at (10/21) + 3 BD = 10/26 (WE1's 10/28 is the policy prepare_by 10/23 + 3 BD — docs discrepancy)");
  const route = await h.run("routeForExecution", { release_task_id: rid }); assert.equal(route.status, "awaiting_execution"); assert.equal(h.rt.escalations.opened.at(-1)!.kind, "signing_officer"); assert.equal(h.ofType("lien_release.execution_requested").at(-1)!.payload.path, "mers");
  // signing_officer e-signs with RON acknowledgment Fri 10/23; the platform's completion evidence is ingested → lien_release.executed
  h.at("2026-10-23T17:00:00.000Z"); await h.run("scheduleNotarySession", { release_task_id: rid, recording_state: "OH", ron: true, ron_accepted: true, esign: true, esign_accepted: true, signing_officer_id: "so-1" });
  const done = await h.run("scheduleNotarySession", { release_task_id: rid, recording_state: "OH", op: "completed", signing_officer_id: "so-1", audit_trail: "signer so-1; ip 10.0.0.1; 2026-10-23T17:00Z; journal 1", executed_document: `${inst.text}\n/s/ MERS Signing Officer` });
  assert.equal(done.status, "notarized"); assert.equal(done.ron, true); assert.equal(h.timer("SM_RELEASE_EXECUTE_3BD")!.status, "satisfied");
  // Simplifile package submitted the same day: fee from the recorder's schedule ($34.00 for two pages), borrower-funded under C-1.2-05
  const sub = await h.run("submitRecording", { release_task_id: rid, pages: 2, disclosed_on_statement: true, permitted_by_security_instrument: true, c1205_conditions: true, charge_borrower: true, borrower_collected_cents: 3_400n });
  assert.equal(sub.channel, "simplifile"); assert.equal(sub.fees_cents, 3_400n); assert.equal((sub.fee as { chargeable: boolean }).chargeable, true); assert.equal(h.ofType("fee.posting_requested").at(-1)!.payload.charge_target, "borrower");
  // Outputs "Ledger": the $34.00 books as one balanced set — Dr recording_fee_payable (the borrower-collected loan liability) / Cr corporate_cash — and `fee.posted` names it
  assert.equal(h.uow.ledger.sets().length, 1); const feeSet = h.uow.ledger.sets()[0]!; assert.equal(feeSet.id, sub.ledger_set_id); assert.deepEqual(lines(feeSet), [["loan:L-OH:recording_fee_payable", 3_400n], ["corporate:corporate_cash", -3_400n]]);
  assert.ok(feeSet.lines.every((l) => l.ruleRef === "16.3.fee:C-1.2-05:borrower_funded")); assert.equal(feeSet.effectiveDate, "2026-10-23"); assert.equal(feeSet.sourceEventId, h.ofType("fee.posting_requested").at(-1)!.id);
  assert.equal(h.uow.ledger.balance(corpAcct("corporate_cash")), -3_400n); assert.equal(h.uow.ledger.balance(loanAcct("L-OH", "recording_fee_payable")), 3_400n);
  const posted = h.ofType("fee.posted").at(-1)!; assert.equal(posted.payload.ledger_set_id, feeSet.id); assert.equal(posted.payload.kind, "recording_fee"); assert.equal(posted.payload.charge_target, "borrower"); assert.equal(h.rt.store.get("recording_submissions", sub.submission_id as string)!.data.fee_ledger_set_id, feeSet.id);
  assert.equal(h.timer("SM_RELEASE_SUBMIT_21")!.status, "satisfied"); assert.equal(h.timer("SM_RECORDING_CONFIRM_30")!.dueDate, "2026-11-22");
  // county accepted and recorded Mon 10/26: the recorded image is hashed; lien_release.recorded satisfies the statutory clock and the monitor
  h.at("2026-10-26T20:00:00.000Z"); const image = "%PDF-1.7 recorded Release of Mortgage, Franklin County Recorder, Instrument No. 202610260012345";
  const rec = await h.run("submitRecording", { release_task_id: rid, op: "recorded", submission_id: sub.submission_id, recording_reference: "Instrument No. 202610260012345", recorded_on: "2026-10-26", recorded_image: image });
  assert.equal(rec.recorded_image_sha256, sha256(image)); assert.match(rec.recorded_image_sha256 as string, /^[0-9a-f]{64}$/); assert.equal(rec.on_time, true);
  assert.equal(statutory.status, "satisfied"); const satEvt = h.events.all().find((e) => e.id === statutory.satisfiedByEventId)!; assert.equal(satEvt.type, "lien_release.recorded"); assert.equal(satEvt.payload.statutory_duty, "satisfied"); assert.equal(satEvt.payload.recorded_image_sha256, sha256(image)); assert.equal(satEvt.payload.recording_reference, "Instrument No. 202610260012345");
  assert.equal(h.rt.store.get("documents", rec.recorded_document_id as string)!.data.sha256, sha256(image)); assert.equal(h.rt.store.get("release_tasks", rid)!.data.status, "recorded"); assert.equal(h.rt.store.get("recording_submissions", sub.submission_id as string)!.data.status, "recorded");
  assert.equal(h.timer("SM_RECORDING_CONFIRM_30")!.status, "satisfied"); assert.equal(h.timer("SM_BORROWER_RELEASE_NOTICE_5BD")!.dueDate, "2026-11-02");
  assert.deepEqual([rec.mers_deactivation_due, rec.mers_deactivation_target], ["2026-12-25", "2026-11-02"]);
  // NTC_LIEN_RELEASE_RECORDED with the image Tue 10/27 → notice.sent satisfies SM_BORROWER_RELEASE_NOTICE_5BD
  h.at("2026-10-27T15:00:00.000Z"); const ntc = await h.run("notifyBorrower", { loan_id: "L-OH", release_task_id: rid, op: "release_recorded", state: "OH", recorded_on: "2026-10-26", recorded_document_id: rec.recorded_document_id, consent_on_file: true, recipients: RECIPIENTS, payload: sample("NTC_LIEN_RELEASE_RECORDED") });
  assert.equal((ntc.notice as { status: string }).status, "sent"); assert.equal(h.timer("SM_BORROWER_RELEASE_NOTICE_5BD")!.status, "satisfied"); assert.equal(h.rt.store.get("release_tasks", rid)!.data.status, "borrower_notified");
  assert.deepEqual([...new Set(h.timers.all().map((t) => t.status))], ["satisfied"], "every 16.3 timer of worked example 1 is satisfied");
});
test("16.3-T2: Given a Florida payoff on 10/16/2026, then the deadline is 11/30/2026 (45 days, §701.03), the recorded release must be sent to the mortgagor, and a breach computes attorney-fee exposure.", async () => {
  const fl = openReleaseTask({ state: "FL", payoff_on: D("2026-10-16") });
  assert.equal(fl.deadline_at, "2026-11-30"); assert.equal(fl.cite, "Fla. Stat. §701.03; §701.04(2)"); assert.equal(statutoryDeadline("FL", D("2026-10-16")).deadline_days, 45);
  // §701.04(2): the recorded release itself goes to the mortgagor — statutory, sev-1 on breach of the 5-BD notice clock
  const bn = borrowerNotification({ state: "FL", recorded_on: D("2026-11-20"), consent_on_file: false });
  assert.equal(bn.statutory, true); assert.equal(releaseRule("FL").borrower_delivery_required, true); assert.equal(bn.attach_recorded_image, true); assert.equal(bn.breach_severity, "sev1"); assert.equal(bn.send_by, "2026-11-30", "5 servicer BD after Fri 11/20 skips Thanksgiving 11/26");
  const v = noticeReg.activeVersion("NTC_LIEN_RELEASE_RECORDED", D("2026-11-20"))!; const flPayload = { ...v.samplePayload, state: "FL", florida: true, property_address: "9 Palm Ct, Miami FL 33101", recording_office: "Miami-Dade County Clerk" };
  assert.equal(evaluateChecklist(v, flPayload, render(v.source, flPayload)).passed, true); assert.match(render(v.source, flPayload).text, /section 701\.04\(2\), Florida Statutes/);
  assert.equal(evaluateChecklist(v, { ...flPayload, florida: false }, render(v.source, { ...flPayload, florida: false })).passed, false, "a Florida letter must cite §701.04(2)");
  assert.equal(evaluateChecklist(v, { ...flPayload, recorded_image_attached: false }, render(v.source, { ...flPayload, recorded_image_attached: false })).passed, false, "the recorded release itself is enclosed");
  // a breach: no fixed statutory penalty — prevailing-party attorney fees (§701.04) are the exposure, reported by compliance-sentinel, never passed through
  const late = penaltyExposureReport({ state: "FL", payoff_on: D("2026-10-16"), deadline_at: fl.deadline_at, as_of: D("2026-12-10"), satisfied_on: null });
  assert.equal(late.breached, true); assert.equal(late.days_late, 10); assert.equal(late.attorney_fee_exposure, true); assert.equal(late.penalty_exposure_cents, 0n); assert.match(late.basis, /prevailing-party attorney fees/); assert.equal(late.severity, "sev1"); assert.equal(late.charge_target, "corporate_expense"); assert.equal(late.pass_through_to_borrower_or_fnma, false);
  assert.equal(penaltyExposureReport({ state: "FL", payoff_on: D("2026-10-16"), deadline_at: fl.deadline_at, as_of: D("2026-12-10"), satisfied_on: D("2026-11-25") }).attorney_fee_exposure, false);
  // through the bus: the breached task informs the officer once and carries the exposure
  const h = harness("L-FL", "2026-10-16T15:00:00.000Z"); const sel = await h.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-FL", state: "FL", county: "Miami-Dade" }); assert.equal(h.timer("STATE_LIEN_RELEASE_DEADLINE")!.dueDate, "2026-11-30");
  h.at("2026-12-10T12:00:00.000Z"); const r = await h.run("computePenaltyExposure", { release_task_id: sel.release_task_id, state: "FL", deadline_at: "2026-11-30" });
  assert.equal(r.attorney_fee_exposure, true); assert.equal(h.rt.escalations.opened.filter((e) => e.kind === "officer").length, 1); assert.equal(h.rt.store.get("release_tasks", sel.release_task_id as string)!.data.status, "penalty_exposure");
  await h.run("computePenaltyExposure", { release_task_id: sel.release_task_id, state: "FL", deadline_at: "2026-11-30" }); assert.equal(h.rt.escalations.opened.filter((e) => e.kind === "officer").length, 1, "daily recomputation does not re-page the officer");
  // the recorded release goes to the mortgagor: notifyBorrower takes the state off the release task (never the caller) and encloses the `documents` row the task recorded — a Florida letter cannot leave without §701.04(2) or without the image
  const g = harness("L-FL2", "2026-10-16T15:00:00.000Z"); g.erecording.coverage.add("FL:Miami-Dade"); const rid = (await g.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-FL2", state: "FL", county: "Miami-Dade" })).release_task_id as string;
  g.at("2026-11-20T15:00:00.000Z"); const { rec } = await throughRecording(g, rid, { county: "Miami-Dade", state: "FL", recorded_on: "2026-11-20", reference: "OR Book 33001 Page 1201" });
  assert.equal(g.timer("SM_BORROWER_RELEASE_NOTICE_5BD")!.dueDate, "2026-11-30");
  await refusedWith(g.run("notifyBorrower", { loan_id: "L-FL2", release_task_id: rid, op: "release_recorded", recorded_document_id: "doc-any-string", consent_on_file: false, recipients: RECIPIENTS, payload: sample("NTC_LIEN_RELEASE_RECORDED") }), "RECORDED_IMAGE_REQUIRED");
  g.at("2026-11-23T15:00:00.000Z"); const ntc = await g.run("notifyBorrower", { loan_id: "L-FL2", release_task_id: rid, op: "release_recorded", state: "OH", consent_on_file: false, recipients: RECIPIENTS, payload: sample("NTC_LIEN_RELEASE_RECORDED") });
  assert.equal(ntc.state, "FL", "the row's state, not the caller's OH"); const np = ntc.payload as { florida: boolean; recorded_image_attached: boolean; recorded_document_id: string; enclosures: { document_id: string; sha256: string }[]; recording_reference: string };
  assert.equal(np.florida, true); assert.equal(np.recorded_image_attached, true); assert.equal(np.recorded_document_id, rec.recorded_document_id); assert.equal(np.enclosures[0]!.sha256, rec.recorded_image_sha256); assert.equal(np.recording_reference, "OR Book 33001 Page 1201");
  const n = ntc.notice as { status: string; rendered: { text: string } }; assert.equal(n.status, "sent"); assert.match(n.rendered.text, /section 701\.04\(2\), Florida Statutes/); assert.match(n.rendered.text, /OR Book 33001 Page 1201/);
  assert.equal(g.timer("SM_BORROWER_RELEASE_NOTICE_5BD")!.status, "satisfied"); assert.deepEqual(g.ofType("lien_release.borrower_notified").at(-1)!.payload.enclosure_document_ids, [rec.recorded_document_id]); assert.equal(g.ofType("lien_release.borrower_notified").at(-1)!.payload.florida, true);
  assert.equal((ntc.plan as { breach_severity: string }).breach_severity, "sev1");
});
test("16.3-T3: Given worked example 2, then a Form 2009 request is sent 10/16, the trustee delivery timer is due 11/15/2026, and the trustee-record monitor is due 21 days after the trustee's receipt.", async () => {
  const h = harness("L-CA", "2026-10-16T15:00:00.000Z", { loan: { ...OH_LOAN, state: "CA", county: "Los Angeles", security_instrument: "deed_of_trust" } }); h.paidInFull("2026-10-16");
  assert.equal(h.row("rt-L-CA-Los Angeles-2026-10-16").status, "awaiting_custody_docs", "opened from the payoff event: CA trustee package needs the originals");
  const sel = await h.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-CA", state: "CA", county: "Los Angeles", security_instrument: "deed_of_trust" }); const rid = sel.release_task_id as string;
  assert.equal(sel.instrument_type, "request_for_full_reconveyance"); assert.equal(sel.recording_path, "trustee_third_party"); assert.equal(sel.signatory_path, "mers_signing_officer"); assert.equal((sel.task as { status: string; original_note_required: boolean }).status, "awaiting_custody_docs"); assert.equal((sel.task as { original_note_required: boolean }).original_note_required, true);
  assert.equal(h.timer("FNMA_F110_FORM2009_CUSTODY_REQUEST_1BD")!.dueDate, "2026-10-19", "+1 BD from Fri 10/16"); assert.equal(h.timer("CA_CC2941_TRUSTEE_DELIVERY_30")!.dueDate, "2026-11-15", "Sun 11/15, no roll-forward"); assert.equal(h.timer("STATE_LIEN_RELEASE_DEADLINE")!.dueDate, "2026-11-15");
  // Form 2009 to the custodian Fri 10/16 → FNMA_F110 satisfied; the 10-BD return monitor runs to Fri 10/30; originals received Fri 10/23
  const cr = await h.run("requestCustodyDocuments", { loan_id: "L-CA", release_task_id: rid, state: "CA", payoff_on: "2026-10-16", fnma_loan_number: "1234567890" });
  assert.equal(cr.requested, true); assert.equal(cr.sent_on, "2026-10-16"); assert.deepEqual(cr.documents, ["original_note", "original_deed_of_trust"]); assert.equal(h.custodian.requests[0]!.form, "2009");
  assert.equal(h.timer("FNMA_F110_FORM2009_CUSTODY_REQUEST_1BD")!.status, "satisfied"); assert.equal(h.timer("SM_CUSTODY_DOCS_RETURN_10BD")!.dueDate, "2026-10-30");
  h.at("2026-10-23T15:00:00.000Z"); await h.run("requestCustodyDocuments", { op: "received", custody_request_id: cr.custody_request_id, received_on: "2026-10-23" });
  assert.equal(h.timer("SM_CUSTODY_DOCS_RETURN_10BD")!.status, "satisfied"); assert.equal(h.rt.store.get("release_tasks", rid)!.data.status, "opened");
  // prepared, then the MERS Signing Officer executes the request for full reconveyance Tue 10/27; package couriered to the trustee 10/28 with delivery evidence
  await h.run("draftReleaseInstrument", { release_task_id: rid, ...OH_DRAFT, county: "Los Angeles", property_address: "1 Sunset Blvd, Los Angeles CA 90028" });
  await h.run("runReleaseChecklist", { release_task_id: rid, present: ALL_PRESENT, county_requires_legal_description: true }); await h.run("routeForExecution", { release_task_id: rid });
  h.at("2026-10-27T18:00:00.000Z"); await h.run("scheduleNotarySession", { release_task_id: rid, recording_state: "CA", op: "completed", signing_officer_id: "so-1", audit_trail: "journal", executed_document: "request for full reconveyance /s/" });
  h.at("2026-10-28T18:00:00.000Z");
  await refusedWith(h.run("submitRecording", { release_task_id: rid, op: "trustee_delivery" }), "DELIVERY_NEEDS_EVIDENCE");
  const del = await h.run("submitRecording", { release_task_id: rid, op: "trustee_delivery", delivery_evidence_document_id: "doc-courier-1" });
  assert.equal(del.status, "delivered_to_trustee"); assert.equal(h.timer("CA_CC2941_TRUSTEE_DELIVERY_30")!.status, "satisfied");
  assert.equal(h.timer("CA_CC2941_TRUSTEE_RECORD_21")!.dueDate, "2026-11-18", "21 calendar days after the trustee's receipt 10/28"); assert.equal(h.timer("CA_CC2941_TRUSTEE_RECORD_21")!.anchorDate, "2026-10-28");
  // §2941(b)(1)(A): the beneficiary's statutory duty is the delivery — the same evidence satisfies STATE_LIEN_RELEASE_DEADLINE (due 11/15) and the exposure report reads the delivery date off the row, so a trustee recording inside its own 21 days after 11/15 is no $500 breach
  assert.equal(del.statutory_duty, "satisfied"); const ca30 = h.timer("STATE_LIEN_RELEASE_DEADLINE")!; assert.equal(ca30.status, "satisfied"); assert.equal(h.events.all().find((e) => e.id === ca30.satisfiedByEventId)!.type, "lien_release.delivered_to_trustee"); assert.equal(h.row(rid).statutory_duty_satisfied_by, "delivery_to_trustee");
  h.at("2026-11-16T15:00:00.000Z"); const ex = await h.run("computePenaltyExposure", { release_task_id: rid }); assert.equal(ex.breached, false); assert.equal(ex.penalty_exposure_cents, 0n); assert.equal(ex.satisfied_on, "2026-10-28"); assert.equal(ex.timer_status, "satisfied"); assert.equal(h.rt.escalations.opened.filter((e) => e.kind === "officer").length, 0);
  // reconveyance recorded 11/05 → the trustee monitor satisfied (the statutory clock already was); borrower notified by 11/12 (11/09 in WE2)
  h.at("2026-11-05T18:00:00.000Z"); const rec = await h.run("submitRecording", { release_task_id: rid, op: "trustee_recorded", recording_reference: "Doc No. 20261105-0001", recorded_on: "2026-11-05", recorded_image: "%PDF reconveyance" });
  assert.equal(rec.status, "trustee_recorded"); assert.equal(h.timer("CA_CC2941_TRUSTEE_RECORD_21")!.status, "satisfied"); assert.equal(h.timer("STATE_LIEN_RELEASE_DEADLINE")!.status, "satisfied"); assert.equal(h.timer("SM_BORROWER_RELEASE_NOTICE_5BD")!.dueDate, "2026-11-13", "5 servicer BD after Thu 11/05 skips Veterans Day 11/11 (WE2's 11/09 notification is inside the window)");
  // the calculators behind it
  const ca = caTrusteePath({ payoff_on: D("2026-10-16"), custody_sent_on: D("2026-10-16"), originals_received_on: D("2026-10-23"), executed_on: D("2026-10-27"), delivered_to_trustee_on: D("2026-10-28"), delivery_evidence_document_id: "doc-courier-1", reconveyance_recorded_on: D("2026-11-05") });
  assert.deepEqual([ca.custody_request_by, ca.deliver_by, ca.operational_target, ca.trustee_record_by], ["2026-10-19", "2026-11-15", "2026-11-13", "2026-11-18"]); assert.equal(ca.delivery_satisfies_timer, true); assert.equal(ca.trustee_on_time, true);
  assert.equal(caTrusteePath({ payoff_on: D("2026-10-16"), custody_sent_on: null, originals_received_on: null, delivered_to_trustee_on: D("2026-10-28") }).delivery_satisfies_timer, false, "delivery without evidence does not satisfy");
  // substitution of trustee + full reconveyance (decision 2) records directly and never arms the trustee delivery row
  assert.equal(instrumentTypeFor("CA", "deed_of_trust", { substitution_permitted: true }), "substitution_of_trustee_and_full_reconveyance"); assert.equal(instrumentTypeFor("CA", "deed_of_trust"), "request_for_full_reconveyance"); assert.equal(instrumentTypeFor("CA", "mortgage"), "certificate_of_discharge"); assert.equal(instrumentTypeFor("WA", "deed_of_trust"), "request_for_full_reconveyance");
  const h2 = harness("L-CA2", "2026-10-16T15:00:00.000Z"); const s2 = await h2.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-CA2", state: "CA", county: "Los Angeles", security_instrument: "deed_of_trust", substitution_permitted: true });
  assert.equal(s2.instrument_type, "substitution_of_trustee_and_full_reconveyance"); assert.equal(s2.recording_path, "direct"); assert.equal(h2.timer("CA_CC2941_TRUSTEE_DELIVERY_30"), undefined);
});
test("16.3-T4: Given a Maryland payoff by wire on Fri 10/16, then `MD_RP_7106_RELEASE_DELIVERY_7` is due 10/23 and delivery evidence to the settlement agent satisfies it while recording is still monitored.", async () => {
  const h = harness("L-MD", "2026-10-16T15:00:00.000Z", { loan: { ...OH_LOAN, state: "MD", county: "Baltimore", security_instrument: "deed_of_trust" } }); h.paidInFull("2026-10-16");
  const sel = await h.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-MD", state: "MD", county: "Baltimore", security_instrument: "deed_of_trust", funds_received_on: "2026-10-16" }); const rid = sel.release_task_id as string;
  assert.equal(sel.instrument_type, "certificate_of_satisfaction"); assert.equal((sel.task as { status: string }).status, "opened", "WE3: the custody request for the original note runs in parallel"); assert.equal((sel.task as { custody_in_parallel: boolean }).custody_in_parallel, true);
  const md = h.timer("MD_RP_7106_RELEASE_DELIVERY_7")!; assert.equal(md.dueDate, "2026-10-23"); assert.equal(md.anchorDate, "2026-10-16"); assert.equal(h.timer("STATE_LIEN_RELEASE_DEADLINE")!.dueDate, "2026-10-23"); assert.equal(h.timer("SM_RELEASE_SUBMIT_21")!.dueDate, "2026-10-16", "deadline − 7 when shorter than +21"); assert.equal(h.timer("FNMA_F110_FORM2009_CUSTODY_REQUEST_1BD")!.dueDate, "2026-10-19");
  // prepared 10/19, executed and notarized 10/20, delivered to the settlement agent 10/21 with delivery evidence
  h.at("2026-10-19T15:00:00.000Z"); assert.deepEqual(h.timers.evaluate("2026-10-19T15:00:00.000Z").map((b) => b.instance.code), ["SM_RELEASE_SUBMIT_21"], "the policy submit window (deadline − 7 = 10/16) is already breached at sev-2; the statutory clocks are not");
  await h.run("draftReleaseInstrument", { release_task_id: rid, ...OH_DRAFT, county: "Baltimore" }); await h.run("runReleaseChecklist", { release_task_id: rid, present: ALL_PRESENT, county_requires_legal_description: false }); await h.run("routeForExecution", { release_task_id: rid });
  h.at("2026-10-20T15:00:00.000Z"); await h.run("scheduleNotarySession", { release_task_id: rid, recording_state: "MD", op: "completed", signing_officer_id: "so-1", audit_trail: "journal", executed_document: "certificate of satisfaction /s/" });
  h.at("2026-10-21T15:00:00.000Z");
  await refusedWith(h.run("submitRecording", { release_task_id: rid, op: "settlement_agent_delivery" }), "DELIVERY_NEEDS_EVIDENCE");
  const del = await h.run("submitRecording", { release_task_id: rid, op: "settlement_agent_delivery", delivery_evidence_document_id: "doc-agent-ack-1" });
  assert.equal(del.status, "delivered"); assert.equal(del.statute_satisfied_by_delivery, true); assert.equal(md.status, "satisfied");
  const satEvt = h.events.all().find((e) => e.id === md.satisfiedByEventId)!; assert.equal(satEvt.type, "lien_release.delivered"); assert.equal(satEvt.payload.evidence_document_id, "doc-agent-ack-1"); assert.equal(satEvt.payload.to, "settlement_agent");
  // the statutory clock is *satisfied* by the delivery event (registry: "or `delivered` where the statute is satisfied by delivery: MA, MD"; Real Prop. §7-106) — never cancelled — and recording is still monitored
  const statutory = h.timer("STATE_LIEN_RELEASE_DEADLINE")!; assert.equal(statutory.status, "satisfied"); assert.equal(statutory.satisfiedByEventId, satEvt.id); assert.equal(satEvt.payload.statutory_duty, "satisfied"); assert.match(String(satEvt.payload.cite), /7-106/); assert.equal(del.statutory_duty, "satisfied"); assert.deepEqual(del.statutory_timer, { id: statutory.id, status: "satisfied" });
  assert.equal(h.ofType("timer.cancelled").length, 0, "no statutory sev-1 clock is cancelled in the audit's timer history"); assert.equal(h.row(rid).statutory_duty_satisfied_on, "2026-10-21");
  const monitor = h.timer("SM_RECORDING_CONFIRM_30")!; assert.equal(monitor.status, "armed"); assert.equal(monitor.dueDate, "2026-11-20", "delivery 10/21 + 30"); assert.equal(h.timer("SM_RELEASE_SUBMIT_21")!.status, "satisfied_late");
  h.at("2026-11-10T15:00:00.000Z"); await h.run("submitRecording", { release_task_id: rid, op: "recorded", via: "third_party", recording_reference: "Liber 12345 Folio 678", recorded_on: "2026-11-10", recorded_image: "%PDF recorded certificate" }); assert.equal(monitor.status, "satisfied");
  const ex = await h.run("computePenaltyExposure", { release_task_id: rid }); assert.equal(ex.breached, false); assert.equal(ex.satisfied_on, "2026-10-21", "exposure ends at the delivery the statute is satisfied by, not at the 11/10 recording");
  // the §7-106 anchor: receipt for a wire/certified funds; *clearance* for other paper (10/20 → due 10/27); a clearance not yet known keeps the earliest date, flagged
  const paper = harness("L-MD2", "2026-10-16T15:00:00.000Z"); await paper.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-MD2", state: "MD", county: "Baltimore", security_instrument: "deed_of_trust", funds_received_on: "2026-10-16", funds_kind: "check", funds_cleared_on: "2026-10-20" });
  assert.equal(paper.timer("MD_RP_7106_RELEASE_DELIVERY_7")!.anchorDate, "2026-10-20"); assert.equal(paper.timer("MD_RP_7106_RELEASE_DELIVERY_7")!.dueDate, "2026-10-27"); assert.equal(paper.row("rt-L-MD2-Baltimore-2026-10-16").funds_anchor_basis, "clearance"); assert.equal(paper.timer("STATE_LIEN_RELEASE_DEADLINE")!.dueDate, "2026-10-23", "the policy clock stays at payoff + 7 (rule 6: earliest anchor)");
  const pending = harness("L-MD3", "2026-10-16T15:00:00.000Z"); const p3 = await pending.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-MD3", state: "MD", county: "Baltimore", security_instrument: "deed_of_trust", funds_received_on: "2026-10-16", funds_kind: "check" });
  assert.equal(p3.funds_anchor_basis, "receipt_pending_clearance"); assert.equal(pending.timer("MD_RP_7106_RELEASE_DELIVERY_7")!.dueDate, "2026-10-23");
  assert.deepEqual(fundsAnchor({ funds_received_on: D("2026-10-16"), funds_kind: "wire" }), { anchor: "2026-10-16", basis: "receipt_certified_or_wire" }); assert.deepEqual(fundsAnchor({ funds_received_on: D("2026-10-16"), funds_kind: "check", cleared_on: D("2026-10-20") }), { anchor: "2026-10-20", basis: "clearance" }); assert.equal(fundsAnchor({ funds_received_on: D("2026-10-16") }).basis, "receipt_certified_or_wire", "unknown kind: earliest anchor");
  // the calculator: evidence and the 7-day window both required; other paper anchors on clearance
  const ok = mdDelivery({ funds_received_on: D("2026-10-16"), certified_or_wire: true, delivered_on: D("2026-10-21"), evidence_document_id: "doc-agent-ack-1", submitted_on: D("2026-10-21") });
  assert.equal(ok.due, "2026-10-23"); assert.equal(ok.satisfied, true); assert.equal(ok.recording_confirm_by, "2026-11-20"); assert.equal(ok.recording_monitor, "SM_RECORDING_CONFIRM_30");
  assert.equal(mdDelivery({ funds_received_on: D("2026-10-16"), certified_or_wire: true, delivered_on: D("2026-10-21") }).satisfied, false, "no evidence"); assert.equal(mdDelivery({ funds_received_on: D("2026-10-16"), certified_or_wire: true, delivered_on: D("2026-10-24"), evidence_document_id: "d" }).satisfied, false, "late");
  assert.equal(mdDelivery({ funds_received_on: D("2026-10-16"), certified_or_wire: false, cleared_on: D("2026-10-20"), delivered_on: D("2026-10-27"), evidence_document_id: "d" }).due, "2026-10-27");
});
test("16.3-T5: Given Fannie Mae is assignee of record in a state with no recorded LPOA, then execution is blocked by `SM_LPOA_RECORDED_GATE`, the document is e-mailed to SF CPM Documents within 2 BD with the required package, and a 15-BD follow-up timer runs.", async () => {
  // the evaluator the gate row names, over the lpoas rows for the state
  assert.equal(evaluateGate("16.3.lpoaRecordedForState", lpoaGate("TX", [{ state: "TX", status: "requested" }, { state: "FL", status: "recorded" }]).facts).open, false); assert.equal(evaluateGate("16.3.lpoaRecordedForState", lpoaGate("FL", [{ state: "FL", status: "recorded", scope: ["full satisfaction or release"] }]).facts).open, true);
  assert.equal(lpoaGate("TX", []).fallback, "fnma_execution"); assert.equal(lpoaGate("TX", [{ state: "TX", status: "recorded", scope: ["foreclosure"] }]).open, false, "scope must cover release/satisfaction");
  const h = harness("L-TX", "2026-10-16T15:00:00.000Z"); h.rt.store.put("lpoas", "lpoa-tx", { state: "TX", status: "requested", grantee: "partner", scope: ["full satisfaction or release"] }, OFFICER, "2026-09-01T00:00:00.000Z");
  const sel = await h.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-TX", state: "TX", county: "Dallas", security_instrument: "deed_of_trust", mortgagee_of_record: "fannie_mae", min_active: false }); const rid = sel.release_task_id as string;
  assert.equal(sel.signatory_path, "fnma_execution"); assert.equal(sel.lpoa_gate, "SM_LPOA_RECORDED_GATE"); assert.equal(sel.lpoa_gate_open, false); assert.equal((sel.lpoa as { lpoa_status: string }).lpoa_status, "requested");
  h.at("2026-10-21T15:00:00.000Z"); await h.run("draftReleaseInstrument", { release_task_id: rid, ...OH_DRAFT, county: "Dallas" }); await h.run("runReleaseChecklist", { release_task_id: rid, present: ALL_PRESENT, county_requires_legal_description: false });
  assert.equal(h.timer("FNMA_A2104_SEND_FOR_EXECUTION_2BD")!.dueDate, "2026-10-23", "prepared Wed 10/21 + 2 BD");
  h.at("2026-10-22T15:00:00.000Z"); const r = await h.run("routeForExecution", { release_task_id: rid });
  assert.equal(r.status, "sent_to_fnma"); assert.equal(r.channel, "email"); assert.equal(r.to, "sfcpm.servicingdocuments@fanniemae.com"); assert.deepEqual([...(r.package as string[])], ["fnma_loan_number", "reason", "executable_document", "cover_letter", "return_shipping_label"]); assert.equal(r.reason, "Satisfaction — no LPOA for TX"); assert.equal(r.send_by, "2026-10-23");
  assert.equal(h.timer("FNMA_A2104_SEND_FOR_EXECUTION_2BD")!.status, "satisfied"); const follow = h.timer("SM_FNMA_EXECUTION_RETURN_15BD")!; assert.equal(follow.status, "armed"); assert.equal(follow.dueDate, "2026-11-13", "15 BD from 10/22 skips Veterans Day 11/11"); assert.equal(h.rt.escalations.opened.some((e) => e.kind === "signing_officer"), false, "nothing for a Supermortgage signer");
  assert.equal(h.rt.store.get("integration_messages", r.message_id as string)!.data.to, "sfcpm.servicingdocuments@fanniemae.com");
  // the executed document comes back from SF CPM 11/05 → follow-up satisfied, lien_release.executed for the Fannie Mae path
  h.at("2026-11-05T15:00:00.000Z"); const back = await h.run("routeForExecution", { release_task_id: rid, op: "fnma_returned", returned_on: "2026-11-05", executed_document: "release of lien /s/ Fannie Mae" });
  assert.equal(back.status, "notarized"); assert.equal(follow.status, "satisfied"); assert.equal(h.ofType("lien_release.executed").at(-1)!.payload.signatory_path, "fnma_execution");
  // an LPOA path whose recording lapses before execution is blocked by the gate on the bus and falls back to SF CPM
  const g = harness("L-TX2", "2026-10-16T15:00:00.000Z"); g.rt.store.put("lpoas", "lpoa-tx", { state: "TX", status: "recorded", grantee: "partner", scope: ["full satisfaction or release"], recorded_at: "2026-08-01" }, OFFICER, "2026-08-01T00:00:00.000Z");
  const s2 = await g.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-TX2", state: "TX", county: "Dallas", security_instrument: "deed_of_trust", mortgagee_of_record: "fannie_mae", min_active: false }); const rid2 = s2.release_task_id as string;
  assert.equal(s2.signatory_path, "lpoa_attorney_in_fact"); assert.equal(s2.lpoa_gate_open, true);
  await g.run("draftReleaseInstrument", { release_task_id: rid2, ...OH_DRAFT, county: "Dallas" }); await g.run("runReleaseChecklist", { release_task_id: rid2, present: ALL_PRESENT, county_requires_legal_description: false });
  g.rt.store.put("lpoas", "lpoa-tx", { status: "revoked" }, OFFICER, "2026-10-21T00:00:00.000Z");
  const blocked = await g.run("routeForExecution", { release_task_id: rid2 });
  assert.equal(blocked.blocked_by_gate, true); assert.match(blocked.gate_reason as string, /LPOA is revoked/); assert.equal(blocked.status, "sent_to_fnma"); assert.equal(blocked.signatory_path, "fnma_execution");
  const gate = g.timer("SM_LPOA_RECORDED_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:16.3.lpoaRecordedForState"); assert.equal(g.ofType("lien_release.execution_requested").at(-1)!.payload.path, "lpoa"); assert.equal(g.rt.store.get("release_tasks", rid2)!.data.signatory_path, "fnma_execution");
  // the calculator: no LPOA → e-mail (mail when an original must be executed); 2 BD / 15 BD clocks
  const f = fnmaExecutionPackage({ state: "TX", prepared_on: D("2026-10-21"), lpoa_recorded: false, original_required: false, fnma_loan_number: "1234567890", sent_on: D("2026-10-22") });
  assert.equal(f.blocked, true); assert.equal(f.send_by, "2026-10-23"); assert.equal(f.follow_up_by, "2026-11-13"); assert.equal(fnmaExecutionPackage({ state: "TX", prepared_on: D("2026-10-21"), lpoa_recorded: false, original_required: true, fnma_loan_number: "1234567890" }).channel, "mail");
});
test("16.3-T6: Given a New York payoff with recording delayed 61 days, then `penalty_exposure_cents` = 100000 and 150000 at day 91; a New Jersey nonbank payoff triggers `NTC_NJ_CANCELLATION_RIGHT` by day 10.", async () => {
  // RPL §275 tiers key on days since payoff: 10/16 + 30 = 11/15 deadline; recorded 12/16 (day 61) → $1,000; 2027-01-15 (day 91) → $1,500; day 35 → $500; day 30 → nothing
  const ny = (satisfied_on: string) => penaltyExposureReport({ state: "NY", payoff_on: D("2026-10-16"), deadline_at: statutoryDeadline("NY", D("2026-10-16")).deadline_at, as_of: D("2027-03-01"), satisfied_on: D(satisfied_on) });
  assert.equal(statutoryDeadline("NY", D("2026-10-16")).deadline_at, "2026-11-15");
  assert.equal(ny("2026-12-16").days_since_anchor, 61); assert.equal(ny("2026-12-16").penalty_exposure_cents, 100_000n); assert.equal(ny("2027-01-15").days_since_anchor, 91); assert.equal(ny("2027-01-15").penalty_exposure_cents, 150_000n);
  assert.equal(ny("2026-11-20").penalty_exposure_cents, 50_000n); assert.equal(ny("2026-11-15").penalty_exposure_cents, 0n); assert.equal(ny("2026-11-15").breached, false); assert.equal(ny("2026-12-16").attorney_fee_exposure, false); assert.equal(ny("2026-12-16").cite, "RPL §275; RPAPL §1921");
  // New Jersey nonbank: NJ_46_18_112_RIGHT_TO_DEMAND_NOTICE_10 arms from the task-opened event (mortgagee_kind=nonbank) and is satisfied by notice.sent
  const h = harness("L-NJ", "2026-10-16T15:00:00.000Z", { loan: { ...OH_LOAN, state: "NJ", county: "Essex" } }); h.paidInFull("2026-10-16");
  assert.equal(h.timer("NJ_46_18_112_RIGHT_TO_DEMAND_NOTICE_10")!.dueDate, "2026-10-26", "armed from the payoff event: an unknown mortgagee kind is treated as nonbank (conservative)");
  await h.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-NJ", state: "NJ", county: "Essex", mortgagee_kind: "nonbank" });
  const nj = h.timer("NJ_46_18_112_RIGHT_TO_DEMAND_NOTICE_10")!; assert.equal(nj.dueDate, "2026-10-26"); assert.equal(nj.status, "armed");
  h.at("2026-10-21T15:00:00.000Z"); const sent = await h.run("notifyBorrower", { loan_id: "L-NJ", op: "nj_cancellation_right", state: "NJ", payoff_on: "2026-10-16", fee_cents: 2_500n, recipients: RECIPIENTS, payload: sample("NTC_NJ_CANCELLATION_RIGHT") });
  assert.equal((sent.payload as { days_after_payoff: number }).days_after_payoff, 5, "computed from the letter's dates, not asserted"); assert.equal((sent.notice as { status: string }).status, "sent"); assert.equal(nj.status, "satisfied"); assert.equal(h.events.all().find((e) => e.id === nj.satisfiedByEventId)!.payload.template, "NTC_NJ_CANCELLATION_RIGHT");
  const plan = sent.plan as ReturnType<typeof njCancellationNotice>; assert.equal(plan.notice_by, "2026-10-26"); assert.equal(plan.on_time, true); assert.equal(plan.fee_within_cap, true); assert.equal(plan.cap_cents, 2_500n);
  // a letter dated day 30 is held by the template's ten-days rule; a bank mortgagee never arms the row
  const late = harness("L-NJ2", "2026-11-15T15:00:00.000Z"); await late.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-NJ2", state: "NJ", county: "Essex", mortgagee_kind: "nonbank" });
  await assert.rejects(late.run("notifyBorrower", { loan_id: "L-NJ2", op: "nj_cancellation_right", state: "NJ", payoff_on: "2026-10-16", fee_cents: 2_500n, recipients: RECIPIENTS, payload: sample("NTC_NJ_CANCELLATION_RIGHT") }), /ten-days/);
  const bank = harness("L-NJ3", "2026-10-16T15:00:00.000Z"); await bank.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-NJ3", state: "NJ", county: "Essex", mortgagee_kind: "bank" }); assert.equal(bank.timer("NJ_46_18_112_RIGHT_TO_DEMAND_NOTICE_10"), undefined);
  const bank2 = harness("L-NJ4", "2026-10-16T15:00:00.000Z", { loan: { ...OH_LOAN, state: "NJ", county: "Essex" } }); bank2.paidInFull("2026-10-16"); assert.equal(bank2.timer("NJ_46_18_112_RIGHT_TO_DEMAND_NOTICE_10")!.status, "armed");
  await bank2.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-NJ4", state: "NJ", county: "Essex", mortgagee_kind: "bank" }); assert.equal(bank2.timer("NJ_46_18_112_RIGHT_TO_DEMAND_NOTICE_10")!.status, "cancelled", "the bank selection retires the conservatively armed nonbank clock");
  assert.equal(njCancellationNotice({ payoff_on: D("2026-10-16"), nonbank: false, fee_cents: 2_500n }).notice, null); assert.equal(njCancellationNotice({ payoff_on: D("2026-10-16"), nonbank: true, fee_cents: 2_600n }).fee_within_cap, false); assert.equal(njCancellationNotice({ payoff_on: D("2026-10-16"), nonbank: true, fee_cents: 2_500n, fee_received_on: D("2026-10-30") }).cancel_by, "2026-11-29");
});
test("16.3-T7: Given a recorder rejection for a missing legal description, then the package is corrected and resubmitted within 2 BD and the original deadline is unchanged.", async () => {
  // Worked example 1 package (submitted Fri 10/23) comes back Tue 10/27 for a missing legal description.
  const r = recorderReject({ rejected_on: D("2026-10-27"), reject_code: "MISSING_LEGAL_DESCRIPTION", deadline_at: D("2027-01-14"), prior_rejects: 0, attempt: 1 });
  assert.equal(r.timer, "SM_ERECORD_REJECT_FIX_2BD"); assert.equal(r.fix_by, "2026-10-29"); assert.equal(r.deadline_at, "2027-01-14", "the statutory deadline never moves");
  assert.match(r.correction, /legal description transcribed from the recorded security instrument image/); assert.equal(r.status, "rejected"); assert.equal(r.status_after_fix, "prepared"); assert.equal(r.resubmission_attempt, 2); assert.equal(r.escalation, null);
  // the corrected package is a resubmission of the same task: the plan keeps the statutory deadline and the 30-day confirmation monitor
  const resub = recordingSubmission({ payoff_on: D("2026-10-16"), deadline_at: D("2027-01-14"), erecord_covered: true, fee_cents: 3_400n, submitted_on: D("2026-10-29") });
  assert.equal(resub.statutory_deadline_unchanged, "2027-01-14"); assert.equal(resub.channel, "simplifile"); assert.equal(resub.confirm_chase_on, "2026-11-28");
  // repeated rejects go to the attorney (edge case: "repeated rejects → attorney")
  const again = recorderReject({ rejected_on: D("2026-11-02"), reject_code: "MARGIN", deadline_at: D("2027-01-14"), prior_rejects: 1, attempt: 2 }); assert.equal(again.escalation!.kind, "attorney"); assert.equal(again.fix_by, "2026-11-04"); assert.equal(again.resubmission_attempt, 3);
  // on the bus: the reject arms SM_ERECORD_REJECT_FIX_2BD (due 10/29) and the resubmission satisfies it; STATE_LIEN_RELEASE_DEADLINE keeps its instance and due date
  const h = harness("L-OH", "2026-10-16T15:00:00.000Z"); const rid = (await h.run("selectReleaseInstrument", OH_OPEN)).release_task_id as string; const statutory = h.timer("STATE_LIEN_RELEASE_DEADLINE")!;
  await h.run("draftReleaseInstrument", { release_task_id: rid, ...OH_DRAFT }); await h.run("runReleaseChecklist", { release_task_id: rid, present: ALL_PRESENT, county_requires_legal_description: false });
  h.at("2026-10-23T17:00:00.000Z"); await h.run("scheduleNotarySession", { release_task_id: rid, recording_state: "OH", op: "completed", signing_officer_id: "so-1", audit_trail: "journal", executed_document: "release /s/" });
  const first = await h.run("submitRecording", { release_task_id: rid, pages: 2 }); assert.equal(first.attempt, 1);
  h.at("2026-10-27T15:00:00.000Z"); const rej = await h.run("handleRecorderReject", { release_task_id: rid, submission_id: first.submission_id, reject_code: "MISSING_LEGAL_DESCRIPTION", rejected_on: "2026-10-27" });
  assert.equal(rej.fix_by, "2026-10-29"); const fix = h.timer("SM_ERECORD_REJECT_FIX_2BD")!; assert.equal(fix.dueDate, "2026-10-29"); assert.equal(fix.anchorDate, "2026-10-27"); assert.equal(h.rt.store.get("recording_submissions", first.submission_id as string)!.data.status, "rejected");
  h.at("2026-10-29T15:00:00.000Z"); const second = await h.run("submitRecording", { release_task_id: rid, pages: 2 }); assert.equal(second.attempt, 2); assert.equal(h.ofType("lien_release.submitted").at(-1)!.payload.resubmission, true);
  assert.equal(fix.status, "satisfied"); assert.equal(statutory.status, "armed"); assert.equal(statutory.dueDate, "2027-01-14"); assert.equal(h.timers.byCode("STATE_LIEN_RELEASE_DEADLINE").length, 1);
});
test("16.3-T8: Given a county without eRecording, then a paper package with a positive-pay fee check is mailed within the policy window and tracked; recording confirmation is chased at 30 days.", async () => {
  // A non-participating Ohio county: paper package, positive-pay fee check, mailed inside the 21-day policy window, tracked by barcode; chase at 30 days.
  const r = recordingSubmission({ payoff_on: D("2026-10-16"), deadline_at: D("2027-01-14"), erecord_covered: false, fee_cents: 3_400n, submitted_on: D("2026-10-26"), today: D("2026-10-26") });
  assert.equal(r.channel, "paper_mail"); assert.deepEqual(r.fee_check, { positive_pay: true, amount_cents: 3_400n }); assert.ok(r.package.includes("recording_fee_check_positive_pay") && r.package.includes("self_addressed_return_envelope"));
  assert.equal(r.submit_by, "2026-11-06", "SM_RELEASE_SUBMIT_21: payoff + 21 calendar days"); assert.ok("2026-10-26" <= r.submit_by); assert.equal(r.tracked_by, "mail_tracking_barcode");
  assert.equal(r.confirm_chase_on, "2026-11-25", "SM_RECORDING_CONFIRM_30: submitted_at + 30"); assert.deepEqual(r.timers, ["SM_RELEASE_SUBMIT_21", "SM_RECORDING_CONFIRM_30"]);
  // the policy window shortens to deadline − 7 where the statute is shorter than 28 days (Maryland: 10/16 + 7 = 10/23 → 10/16)
  assert.equal(recordingSubmission({ payoff_on: D("2026-10-16"), deadline_at: D("2026-10-23"), erecord_covered: false, fee_cents: 2_000n }).submit_by, "2026-10-16");
  // walk-in only via a local agent for an imminent statutory breach
  assert.equal(recordingSubmission({ payoff_on: D("2026-10-16"), deadline_at: D("2027-01-14"), erecord_covered: false, fee_cents: 3_400n, today: D("2027-01-12") }).channel, "walk_in");
  // on the bus: Delaware County OH is not an eRecording county → paper package via print-mail; the monitor chases 30 days after mailing; submission before notarization is refused on the persisted row
  const h = harness("L-OH-DEL", "2026-10-16T15:00:00.000Z"); const rid = (await h.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-OH-DEL", county: "Delaware" })).release_task_id as string;
  await h.run("draftReleaseInstrument", { release_task_id: rid, ...OH_DRAFT, county: "Delaware" }); await h.run("runReleaseChecklist", { release_task_id: rid, present: ALL_PRESENT, county_requires_legal_description: false });
  const early = await refusedWith(h.run("submitRecording", { release_task_id: rid, pages: 2, notarized: true }), "EXECUTED_AND_NOTARIZED_FIRST"); assert.match(early.message, /executed and notarized/); assert.equal(h.ofType("command.refused").at(-1)!.payload.command, "submitRecording");
  h.at("2026-10-26T15:00:00.000Z"); await h.run("scheduleNotarySession", { release_task_id: rid, recording_state: "OH", op: "completed", signing_officer_id: "so-1", audit_trail: "journal", executed_document: "release /s/" });
  const sub = await h.run("submitRecording", { release_task_id: rid, pages: 2 });
  assert.equal(sub.channel, "paper_mail"); assert.deepEqual(sub.fee_check, { positive_pay: true, amount_cents: 3_400n, check_number: `RF-${sub.submission_id}` }); assert.equal(sub.tracked_by, "mail_tracking_barcode"); assert.equal(sub.vendor, null); assert.equal(sub.pria_version, null);
  // the package left through the print-mail port: one job (printed instrument, fee check, return envelope, PRIA cover sheet) to the county recorder, tracked by the 31-digit mail-tracking barcode on the submission row
  assert.equal(h.printMail.jobs.size, 1); const job = [...h.printMail.jobs.values()][0]!; assert.equal(job.jobId, sub.mail_job_id); assert.equal(job.job.template, "RECORDING_PACKAGE_PAPER"); assert.equal(job.job.recipient.name, "Delaware County Recorder"); assert.equal(job.job.pages, 4); assert.equal(job.status, "received"); assert.equal(sub.mail_job_status, "received");
  assert.match(sub.mail_tracking_barcode as string, /^\d{31}$/); assert.equal(sub.tracking_id, sub.mail_tracking_barcode); assert.equal(mailTrackingBarcode(job.jobId), sub.mail_tracking_barcode); assert.equal(h.rt.store.get("recording_submissions", sub.submission_id as string)!.data.mail_tracking_barcode, sub.mail_tracking_barcode);
  assert.deepEqual([...(sub.package as string[])], ["printed_instrument", "recording_fee_check_positive_pay", "self_addressed_return_envelope", "pria_cover_sheet"]); assert.equal(h.ofType("lien_release.submitted").at(-1)!.payload.tracking_id, sub.mail_tracking_barcode);
  // the fee check is issued on positive pay (6.4 outstanding_checks; `disbursement.issued`) and the fee — no C-1.2-05 pass-through asserted — books as corporate expense with the F-1-05 claim receivable
  const chk = h.rt.store.get("outstanding_checks", `RF-${sub.submission_id}`)!.data; assert.equal(chk.amount_cents, 3_400n); assert.equal(chk.positive_pay, true); assert.equal(chk.status, "outstanding"); assert.equal(chk.positive_pay_status, "issued_sent"); assert.equal(chk.payee, "Delaware County Recorder"); assert.equal(chk.issued_on, "2026-10-26");
  const issued = h.ofType("disbursement.issued").at(-1)!; assert.equal(issued.payload.instrument, "check"); assert.equal(issued.payload.check_number, `RF-${sub.submission_id}`); assert.equal(issued.payload.positive_pay, true); assert.equal(issued.payload.amount_cents, 3_400n);
  assert.equal(h.uow.ledger.sets().length, 1); assert.deepEqual(lines(h.uow.ledger.sets()[0]!), [["corporate:release_recording_expense", 3_400n], ["corporate:corporate_cash", -3_400n], ["corporate:f105_claim_receivable", 3_400n], ["corporate:release_recording_expense", -3_400n]]); assert.equal(h.ofType("fee.posted").at(-1)!.payload.ledger_set_id, h.uow.ledger.sets()[0]!.id);
  assert.equal(h.timer("SM_RECORDING_CONFIRM_30")!.dueDate, "2026-11-25"); assert.equal(h.timer("SM_RELEASE_SUBMIT_21")!.status, "satisfied");
  h.at("2026-11-26T15:00:00.000Z"); const breaches = h.timers.evaluate("2026-11-26T15:00:00.000Z"); assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity]), [["SM_RECORDING_CONFIRM_30", 2]], "chase recorder/vendor; sev-2");
});
test("16.3-T9: Given the loan's mortgagee of record is a prior lender with no recorded assignment, then the task is held, an `attorney` escalation opens immediately, and the statutory timer keeps running with exposure reported.", async () => {
  // New York payoff Fri 10/16; the title chain shows a prior lender of record with no recorded assignment, found the same day.
  const r = assignmentGap({ state: "NY", payoff_on: D("2026-10-16"), discovered_on: D("2026-10-16"), mers_registered: true, as_of: D("2026-12-20") });
  assert.equal(r.held, true); assert.equal(r.status, "held"); assert.equal(r.corrective_action, "mers_assignment");
  assert.equal(r.escalation.kind, "attorney"); assert.equal(r.escalation.opened_on, "2026-10-16", "attorney engaged immediately"); assert.equal(r.escalation.severity, "sev1"); assert.match(r.escalation.reason, /statutory clock keeps running/);
  assert.equal(r.statutory_due, "2026-11-15", "RPL §275: payoff + 30 calendar days, unchanged by the hold"); assert.equal(r.timer_running, true);
  assert.equal(r.exposure.breached, true); assert.equal(r.exposure.days_late, 35); assert.equal(r.exposure.days_since_anchor, 65); assert.equal(r.exposure.penalty_exposure_cents, 100_000n, "RPL §275: $1,000 beyond 60 days from payoff"); assert.equal(r.exposure.reported_by, "compliance-sentinel"); assert.equal(r.exposure.officer_notified, true); assert.equal(r.exposure.pass_through_to_borrower_or_fnma, false);
  assert.equal(assignmentGap({ state: "NY", payoff_on: D("2026-10-16"), discovered_on: D("2026-10-16"), mers_registered: true, as_of: D("2026-11-20") }).exposure.penalty_exposure_cents, 50_000n, "$500 beyond 30 days");
  assert.equal(assignmentGap({ state: "NY", payoff_on: D("2026-10-16"), discovered_on: D("2026-10-16"), mers_registered: false, as_of: D("2026-11-15") }).corrective_action, "prior_lender_assignment");
  assert.equal(assignmentGap({ state: "NY", payoff_on: D("2026-10-16"), discovered_on: D("2026-10-16"), mers_registered: true, as_of: D("2026-11-15") }).exposure.penalty_exposure_cents, 0n);
  // rule 1(d) through the selector: no signatory path until the assignment is recorded
  const sel = selectInstrument({ state: "NY", security_instrument: "mortgage", mortgagee_of_record: "prior_lender_unassigned", min_active: true, lpoa_recorded: false, mers_registered: true, discovered_on: D("2026-10-16") });
  assert.equal(sel.status, "held"); assert.equal(sel.signatory_path, null); assert.equal(sel.escalation!.kind, "attorney"); assert.equal(sel.corrective_action, "mers_assignment");
  // on the bus: the task opens held, the attorney escalation opens the same day, the statutory clock is armed and breaches; the exposure report pages the officer; the penalty posts only as corporate expense (F-1-09 gate)
  const h = harness("L-NY", "2026-10-16T15:00:00.000Z"); const t = await h.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-NY", state: "NY", county: "Kings", mortgagee_of_record: "prior_lender_unassigned" }); const rid = t.release_task_id as string;
  assert.equal(t.status, "held"); assert.equal(h.rt.escalations.opened[0]!.kind, "attorney"); assert.equal(h.rt.escalations.opened[0]!.openedAt, "2026-10-16T15:00:00.000Z"); assert.equal(h.rt.escalations.opened[0]!.payload.statutory_clock, "running");
  const statutory = h.timer("STATE_LIEN_RELEASE_DEADLINE")!; assert.equal(statutory.dueDate, "2026-11-15"); assert.equal(statutory.status, "armed");
  await refusedWith(h.run("routeForExecution", { release_task_id: rid }), "NO_EXECUTION_WITHOUT_CHECKLIST");
  h.at("2026-12-20T12:00:00.000Z"); assert.equal(h.timers.evaluate("2026-12-20T12:00:00.000Z")[0]!.instance.code, "STATE_LIEN_RELEASE_DEADLINE"); assert.equal(statutory.status, "breached");
  const exp = await h.run("computePenaltyExposure", { release_task_id: rid, state: "NY", deadline_at: "2026-11-15" }); assert.equal(exp.penalty_exposure_cents, 100_000n); assert.equal(h.rt.escalations.opened.at(-1)!.kind, "officer"); assert.equal(h.rt.store.get("release_tasks", rid)!.data.penalty_exposure_cents, 100_000n);
  await refusedWith(h.run("computePenaltyExposure", { release_task_id: rid, state: "NY", deadline_at: "2026-11-15", op: "post", charge_target: "borrower" }), "SM_RELEASE_PENALTY_NONPASS_GATE");
  await refusedWith(h.run("computePenaltyExposure", { release_task_id: rid, state: "NY", deadline_at: "2026-11-15", op: "post", charge_target: "fnma_claim" }, OFFICER), "SM_RELEASE_PENALTY_NONPASS_GATE");
  // the caller cannot move the deadline or the amount: state/deadline/satisfaction come off the row and STATE_LIEN_RELEASE_DEADLINE's persisted status; a different penalty_cents is an officer-only money waiver
  const tamper = await h.run("computePenaltyExposure", { release_task_id: rid, state: "NY", deadline_at: "2027-12-31" }); assert.equal(tamper.breached, true); assert.equal(tamper.penalty_exposure_cents, 100_000n); assert.equal(tamper.deadline_at, "2026-11-15"); assert.deepEqual(tamper.inputs_ignored, ["deadline_at"]); assert.equal(tamper.timer_status, "breached");
  await refusedWith(h.run("computePenaltyExposure", { release_task_id: rid, op: "post", charge_target: "corporate_expense", penalty_cents: 1n }), "PENALTY_AMOUNT_IS_COMPUTED");
  for (const target of ["loan", "fnma", "fannie_mae", "f105_claim"]) await refusedWith(h.run("computePenaltyExposure", { release_task_id: rid, op: "post", charge_target: target }), "SM_RELEASE_PENALTY_NONPASS_GATE");
  assert.equal(h.uow.ledger.sets().length, 0, "nothing books behind a closed gate");
  const posted = await h.run("computePenaltyExposure", { release_task_id: rid, state: "NY", deadline_at: "2026-11-15", op: "post", charge_target: "corporate_expense" });
  assert.equal(posted.allowed, true); assert.equal(posted.penalty_cents, 100_000n); assert.deepEqual((posted.postings as { account: string; debit: bigint; credit: bigint }[]).map((p) => [p.account, p.debit, p.credit]), [["release_penalty_expense", 100_000n, 0n], ["corporate_cash", 0n, 100_000n]]);
  // Outputs "Ledger": penalties Dr release_penalty_expense / Cr corporate_cash — booked as a balanced corporate set (never a loan account) before `fee.posted` satisfies the gate
  assert.equal(h.uow.ledger.sets().length, 1); const penSet = h.uow.ledger.sets()[0]!; assert.equal(penSet.id, posted.ledger_set_id); assert.deepEqual(lines(penSet), [["corporate:release_penalty_expense", 100_000n], ["corporate:corporate_cash", -100_000n]]); assert.ok(penSet.lines.every((l) => l.account.scope === "corporate" && l.ruleRef === "16.3.penalty:F-1-09:corporate_expense"));
  const gate = h.timer("SM_RELEASE_PENALTY_NONPASS_GATE")!; assert.equal(gate.note, "evaluator:16.3.penaltyNeverPassedThrough"); assert.equal(gate.status, "satisfied"); const fp = h.ofType("fee.posted").at(-1)!; assert.equal(fp.payload.charge_target, "corporate_expense"); assert.equal(fp.payload.ledger_set_id, penSet.id); assert.ok(fp.sequence > h.events.all().find((e) => e.id === penSet.sourceEventId)!.sequence);
  assert.equal((h.rt.store.get("release_tasks", rid)!.data.penalty_postings as { ledger_set_id: string }[])[0]!.ledger_set_id, penSet.id);
  assert.equal(penaltyPosting({ state: "NY", penalty_cents: 100_000n, charge_target: "loan", as_of: D("2026-12-20") }).allowed, false);
  // the registered gate evaluator closes on every target ops-16-3 forbids (F-1-09: borrower or Fannie Mae, by any account name) and on an unknown one; only corporate_expense opens it
  for (const target of PENALTY_FORBIDDEN_TARGETS) assert.equal(evaluateGate("16.3.penaltyNeverPassedThrough", { penalty_charge_target: target }).open, false, target);
  assert.equal(evaluateGate("16.3.penaltyNeverPassedThrough", { penalty_charge_target: "corporate_expense" }).open, true); assert.equal(evaluateGate("16.3.penaltyNeverPassedThrough", { penalty_charge_target: "misc_income" }).open, false); assert.equal(evaluateGate("16.3.penaltyNeverPassedThrough", {}).open, false);
});
test("16.3-T10: Given a CA release fee of $45.00 disclosed on the payoff statement and permitted by the DOT, then the fee posts to `recording_fee_payable` and is paid to the trustee/recorder; given a state where the borrower cannot be charged on a portfolio loan, then the cost posts to corporate expense and an F-1-05 claim is prepared within the 60-day window.", async () => {
  // California: $45.00 reconveyance fee disclosed on the payoff statement, permitted by the DOT, C-1.2-05 conditions met → borrower-funded, paid to the trustee/recorder.
  const ca = releaseFeePosting({ state: "CA", fee_cents: 4_500n, fee_kind: "trustee", disclosed_on_statement: true, permitted_by_security_instrument: true, c1205_conditions: true, payoff_on: D("2026-10-16"), borrower_collected_cents: 4_500n });
  assert.equal(ca.chargeable, true); assert.equal(ca.cap_cents, releaseRule("CA").fee_cap_cents, "§2941(e): ≤ $45 conclusively presumed reasonable"); assert.equal(ca.borrower_charge_cents, 4_500n); assert.equal(ca.charge_target, "borrower");
  assert.deepEqual(ca.postings.map((p) => [p.account, p.debit, p.credit]), [["recording_fee_payable", 4_500n, 0n], ["corporate_cash", 0n, 4_500n]]); assert.equal(ca.balanced, true); assert.equal(ca.paid_to, "trustee_or_recorder"); assert.equal(ca.matched_to_borrower_collection, true); assert.equal(ca.f105_claim, null);
  assert.ok(ca.postings.every((p) => p.rule_ref.includes("C-1.2-05"))); assert.equal(ca.event.type, "fee.posting_requested"); assert.equal(ca.event.payload.kind, "trustee_fee");
  // a $46.00 fee breaches the CA presumption → not chargeable; an undisclosed fee → not chargeable
  assert.equal(releaseFeePosting({ state: "CA", fee_cents: 4_600n, fee_kind: "trustee", disclosed_on_statement: true, permitted_by_security_instrument: true, c1205_conditions: true, payoff_on: D("2026-10-16") }).chargeable, false);
  assert.equal(releaseFeePosting({ state: "CA", fee_cents: 4_500n, fee_kind: "trustee", disclosed_on_statement: false, permitted_by_security_instrument: true, c1205_conditions: true, payoff_on: D("2026-10-16") }).chargeable, false);
  // a state whose jurisdiction_rules.release.fee_pass_through_allowed=false on this portfolio loan → corporate expense and an F-1-05 claim within the 60-day window
  const corp = releaseFeePosting({ state: "MA", fee_cents: 7_500n, fee_kind: "recording", disclosed_on_statement: true, permitted_by_security_instrument: true, c1205_conditions: true, fee_pass_through_allowed: false, payoff_on: D("2026-10-16") });
  assert.equal(corp.chargeable, false); assert.equal(corp.borrower_charge_cents, 0n); assert.equal(corp.charge_target, "corporate_expense"); assert.equal(corp.postings[0]!.account, "release_recording_expense"); assert.equal(corp.postings[0]!.debit, 7_500n); assert.equal(corp.balanced, true);
  assert.deepEqual(corp.f105_claim, { prepare_by: D("2026-12-15"), window_days: 60, amount_cents: 7_500n, timer: "FNMA_F105_EXPENSE_CLAIM_60" });
  assert.ok(corp.postings.some((p) => p.account === "f105_claim_receivable" && p.debit === 7_500n));
  // the tool guardrail sits on the posting op (submitRecording): no borrower charge outside C-1.2-05
  const g = guard("submitRecording", "NO_BORROWER_CHARGE_OUTSIDE_C1205");
  assert.match(g.refuse({ charge_borrower: true, state: "CA", fee_kind: "trustee", fee_cents: 4_500n, disclosed_on_statement: false, permitted_by_security_instrument: true, c1205_conditions: true }, AGENT_CTX)!, /C-1\.2-05/);
  assert.match(g.refuse({ charge_borrower: true, state: "CA", fee_kind: "trustee", fee_cents: 4_600n, disclosed_on_statement: true, permitted_by_security_instrument: true, c1205_conditions: true }, AGENT_CTX)!, /state cap/);
  assert.equal(g.refuse({ charge_borrower: true, state: "CA", fee_kind: "trustee", fee_cents: 4_500n, disclosed_on_statement: true, permitted_by_security_instrument: true, c1205_conditions: true }, AGENT_CTX), undefined);
  assert.equal(g.refuse({ charge_borrower: true, state: "CA", fee_kind: "trustee", fee_cents: 4_500n, disclosed_on_statement: true, permitted_by_security_instrument: true, c1205_conditions: true }, { ...AGENT_CTX, actor: OFFICER } as unknown as CommandContext), undefined);
  // the postings are ledger entry sets: borrower-funded → Dr loan:recording_fee_payable / Cr corporate_cash; corporate → Dr release_recording_expense with the F-1-05 receivable; balanced, rule_ref on every line, penalties never on a loan account
  assert.deepEqual(lines(ledgerEntrySet(ca.postings, { loan_id: "L-CA", effective_on: D("2026-10-28"), description: "CA trustee fee" })), [["loan:L-CA:recording_fee_payable", 4_500n], ["corporate:corporate_cash", -4_500n]]);
  const corpSet = ledgerEntrySet(corp.postings, { loan_id: "L-MA", effective_on: D("2026-10-28"), description: "MA recording fee", source_event_id: "evt-1" }); assert.deepEqual(lines(corpSet), [["corporate:release_recording_expense", 7_500n], ["corporate:corporate_cash", -7_500n], ["corporate:f105_claim_receivable", 7_500n], ["corporate:release_recording_expense", -7_500n]]); assert.equal(corpSet.lines.reduce((a, l) => a + l.amountCents, 0n), 0n); assert.equal(corpSet.sourceEventId, "evt-1"); assert.ok(corpSet.lines.every((l) => l.ruleRef.startsWith("16.3.fee:")));
  assert.ok(ledgerEntrySet(penaltyPosting({ state: "NY", penalty_cents: 100_000n, charge_target: "corporate_expense", as_of: D("2026-12-20") }).postings, { loan_id: "L-NY", effective_on: D("2026-12-20"), description: "penalty" }).lines.every((l) => l.account.scope === "corporate"));
  // on the bus: a Massachusetts portfolio loan whose fee cannot be charged books the recording fee as corporate expense with the F-1-05 claim receivable and prepares the claim within 60 days of payoff
  const h = harness("L-MA", "2026-10-16T15:00:00.000Z"); h.erecording.coverage.add("MA:Suffolk"); const rid = (await h.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-MA", state: "MA", county: "Suffolk" })).release_task_id as string;
  h.at("2026-10-23T15:00:00.000Z"); const { sub } = await throughRecording(h, rid, { county: "Suffolk", state: "MA", recorded_on: "2026-10-26", submit: { fee_cents: 7_500n, fee_pass_through_allowed: false, disclosed_on_statement: true, permitted_by_security_instrument: true, c1205_conditions: true } });
  assert.equal((sub.fee as { charge_target: string }).charge_target, "corporate_expense"); assert.deepEqual((sub.fee as { f105_claim: { prepare_by: string } }).f105_claim.prepare_by, "2026-12-15");
  assert.equal(h.uow.ledger.sets().length, 1); assert.deepEqual(lines(h.uow.ledger.sets()[0]!), [["corporate:release_recording_expense", 7_500n], ["corporate:corporate_cash", -7_500n], ["corporate:f105_claim_receivable", 7_500n], ["corporate:release_recording_expense", -7_500n]]);
  assert.equal(h.uow.ledger.balance(corpAcct("f105_claim_receivable")), 7_500n); assert.equal(h.uow.ledger.balance(corpAcct("release_recording_expense")), 0n); assert.equal(h.uow.ledger.balance(loanAcct("L-MA", "recording_fee_payable")), 0n, "nothing on the loan: the borrower was not charged");
  const fp = h.ofType("fee.posted").at(-1)!; assert.equal(fp.payload.charge_target, "corporate_expense"); assert.equal((fp.payload.f105_claim as { prepare_by: string }).prepare_by, "2026-12-15"); assert.equal(h.ofType("fee.posting_requested").filter((e) => e.payload.charge_target === "borrower").length, 0);
});
test("16.3-T11: Given a payoff reversed on 10/28 before execution, then the task is voided and no instrument is signed; given reversal after recording, then an `attorney` escalation opens and no borrower charge occurs.", async () => {
  // Worked example 1 timeline: prepared 10/21; a reversal on Wed 10/28 before any execution voids the task — no instrument is signed.
  const before = payoffReversal({ reversed_on: D("2026-10-28"), executed_at: null, recorded_at: null });
  assert.equal(before.status, "void"); assert.equal(before.instrument_signed, false); assert.equal(before.escalation, null); assert.equal(before.borrower_charge_cents, 0n); assert.equal(before.loan_serviced_as, "secured");
  // reversal after recording (executed 10/23, recorded 10/26): attorney for re-recording/reinstatement; no borrower charge; officer informed
  const after = payoffReversal({ reversed_on: D("2026-10-28"), executed_at: D("2026-10-23"), recorded_at: D("2026-10-26") });
  assert.equal(after.status, "post_recording_reversal"); assert.equal(after.escalation!.kind, "attorney"); assert.equal(after.escalation!.severity, "sev1"); assert.equal(after.borrower_charge_cents, 0n); assert.equal(after.officer_informed, true); assert.equal(after.loan_serviced_as, "unsecured_pending_cure");
  // executed but unrecorded → stop
  assert.equal(payoffReversal({ reversed_on: D("2026-10-28"), executed_at: D("2026-10-23"), submitted_at: D("2026-10-23"), recorded_at: null }).status, "stopped_unrecorded");
  // no release for a loan with payoff_reversed without officer approval (tool guardrail on every write/act step)
  for (const name of ["selectReleaseInstrument", "draftReleaseInstrument", "routeForExecution", "submitRecording"]) assert.match(guard(name, "REVERSED_PAYOFF_NEEDS_OFFICER").refuse({ payoff_reversed: true }, AGENT_CTX)!, /requires officer/);
  assert.match(guard("routeForExecution", "REVERSED_PAYOFF_NEEDS_OFFICER").refuse({ fnma_liquidated_in_error_open: true }, AGENT_CTX)!, /requires officer/);
  assert.equal(guard("routeForExecution", "REVERSED_PAYOFF_NEEDS_OFFICER").refuse({ payoff_reversed: true }, { ...AGENT_CTX, actor: OFFICER } as unknown as CommandContext), undefined);
  // the reversal is read off the loan's persisted events, never a caller flag: 16.2's payoff.reversed after the last loan.paid_in_full; a re-posted payoff clears it; the liquidated-in-error branch stays open until resolved
  const ev = (type: string, sequence: number, payload: Record<string, unknown> = {}) => ({ id: `e${sequence}`, type, occurredAt: "2026-10-28T15:00:00.000Z", sequence, payload });
  assert.equal(reversalState([ev("loan.paid_in_full", 1, { payoff_date: "2026-10-16" })]).reversed, false);
  const rs = reversalState([ev("loan.paid_in_full", 1, { payoff_date: "2026-10-16" }), ev("payoff.reversed", 2, { returned_on: "2026-10-28", cause: "nsf_return" })]); assert.deepEqual([rs.reversed, rs.reversed_on, rs.reversal_event_id, rs.cause, rs.fnma_liquidated_in_error_open], [true, "2026-10-28", "e2", "nsf_return", false]);
  assert.equal(reversalState([ev("loan.paid_in_full", 1), ev("payoff.reversed", 2), ev("loan.paid_in_full", 3, { payoff_date: "2026-11-02" })]).reversed, false, "re-posted payoff");
  assert.equal(reversalState([ev("loan.paid_in_full", 1), ev("payoff.reversed", 2, { fnma_liquidated_in_error: true })]).fnma_liquidated_in_error_open, true); assert.equal(reversalState([ev("loan.paid_in_full", 1), ev("payoff.reversed", 2, { fnma_liquidated_in_error: true }), ev("payoff.liquidated_in_error.resolved", 3)]).fnma_liquidated_in_error_open, false);
  // on the bus, before execution: worked example 1 prepared Wed 10/21; 16.2's payoff.reversed lands Wed 10/28 → the reactor voids the task, releases every 16.3 clock and signs nothing; the agent's next step is refused on the persisted reversal (no input flag), while the officer may proceed
  const h = harness("L-OH", "2026-10-16T15:00:00.000Z", { loan: OH_LOAN }); h.paidInFull("2026-10-16"); const rid = "rt-L-OH-Franklin-2026-10-16"; await h.run("selectReleaseInstrument", OH_OPEN);
  await h.run("draftReleaseInstrument", { release_task_id: rid, ...OH_DRAFT }); h.at("2026-10-21T16:00:00.000Z"); await h.run("runReleaseChecklist", { release_task_id: rid, present: ALL_PRESENT, county_requires_legal_description: false }); assert.equal(h.row(rid).status, "prepared");
  const armedBefore = h.armedTimers().map((t) => t.code).sort(); assert.deepEqual(armedBefore, ["SM_RELEASE_EXECUTE_3BD", "SM_RELEASE_SUBMIT_21", "STATE_LIEN_RELEASE_DEADLINE"]);
  h.at("2026-10-28T15:00:00.000Z"); h.reverse("2026-10-28", "nsf_return");
  const voided = h.row(rid); assert.equal(voided.status, "void"); assert.equal(voided.status_before_reversal, "prepared"); assert.equal((voided.reversal as { instrument_signed: boolean; status: string }).instrument_signed, false); assert.equal((voided.reversal as { status: string }).status, "void"); assert.equal(voided.reversed_on, "2026-10-28"); assert.equal(voided.borrower_charge_cents, 0n);
  const ve = h.ofType("lien_release.voided"); assert.equal(ve.length, 1); assert.equal(ve[0]!.payload.branch, "void"); assert.equal(ve[0]!.payload.instrument_signed, false); assert.deepEqual([...(ve[0]!.payload.timers_released as string[])].sort(), armedBefore); assert.equal(ve[0]!.causationId, h.ofType("payoff.reversed")[0]!.id); assert.deepEqual(ve[0]!.actor, { kind: "system", id: "platform" });
  assert.equal(h.armedTimers().length, 0); const st = h.timer("STATE_LIEN_RELEASE_DEADLINE")!; assert.equal(st.status, "cancelled"); assert.match(st.cancelledReason!, /payoff reversed 2026-10-28/); assert.equal(h.rt.escalations.opened.filter((e) => e.kind === "attorney").length, 0, "no attorney before recording");
  await refusedWith(h.run("routeForExecution", { release_task_id: rid }), "REVERSED_PAYOFF_NEEDS_OFFICER"); const refusedLog = h.ofType("command.refused").at(-1)!; assert.equal(refusedLog.payload.code, "REVERSED_PAYOFF_NEEDS_OFFICER"); assert.equal(refusedLog.payload.task_status, "void");
  await refusedWith(h.run("submitRecording", { release_task_id: rid, pages: 2 }), "REVERSED_PAYOFF_NEEDS_OFFICER"); await refusedWith(h.run("requestCustodyDocuments", { loan_id: "L-OH", state: "OH", payoff_on: "2026-10-16", borrower_requested_note: true }), "REVERSED_PAYOFF_NEEDS_OFFICER");
  assert.equal(h.rt.escalations.opened.filter((e) => e.kind === "signing_officer").length, 0, "no package to the signing officer"); assert.equal(h.ofType("lien_release.execution_requested").length, 0); assert.equal(h.ofType("lien_release.executed").length, 0); assert.equal(h.rt.store.list("documents", (d) => d.kind === "release_instrument_executed").length, 0);
  assert.equal((await h.run("routeForExecution", { release_task_id: rid }, OFFICER)).status, "awaiting_execution", "officer approval: the officer's own command proceeds");
  // a cured, re-posted payoff re-opens the voided task and re-arms the clocks
  const g2 = harness("L-OH-RE", "2026-10-16T15:00:00.000Z", { loan: OH_LOAN }); g2.paidInFull("2026-10-16"); const rid2 = "rt-L-OH-RE-Franklin-2026-10-16"; g2.at("2026-10-28T15:00:00.000Z"); g2.reverse("2026-10-28", "nsf_return"); assert.equal(g2.row(rid2).status, "void"); assert.equal(g2.armedTimers().length, 0);
  g2.at("2026-11-02T15:00:00.000Z"); g2.paidInFull("2026-10-16", { settlement_id: "ps-L-OH-RE-2" }); assert.equal(g2.row(rid2).status, "opened"); assert.equal(g2.row(rid2).reversal, null); assert.equal(g2.ofType("lien_release.task_opened").length, 2); assert.equal(g2.timer("STATE_LIEN_RELEASE_DEADLINE")!.status, "armed"); assert.equal(g2.timer("STATE_LIEN_RELEASE_DEADLINE")!.dueDate, "2027-01-14");
  assert.equal((await g2.run("runReleaseChecklist", { release_task_id: rid2, present: ALL_PRESENT, county_requires_legal_description: false })).passed, true, "the re-posted payoff stands: the agent proceeds");
  // after recording: worked example 1 recorded Mon 10/26; the reversal on Wed 10/28 → post_recording_reversal, attorney (sev-1) for re-recording/reinstatement, officer informed, loan serviced as unsecured pending cure, no borrower charge, the borrower notice held
  const k = harness("L-OH-R", "2026-10-16T15:00:00.000Z", { loan: OH_LOAN }); k.paidInFull("2026-10-16"); const rid3 = "rt-L-OH-R-Franklin-2026-10-16"; await k.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-OH-R" });
  k.at("2026-10-23T17:00:00.000Z"); await throughRecording(k, rid3, { county: "Franklin", state: "OH", recorded_on: "2026-10-26", submit: { disclosed_on_statement: true, permitted_by_security_instrument: true, c1205_conditions: true, charge_borrower: true, borrower_collected_cents: 3_400n } });
  assert.equal(k.row(rid3).status, "recorded"); const borrowerPostings = k.ofType("fee.posting_requested").length; assert.equal(k.timer("SM_BORROWER_RELEASE_NOTICE_5BD")!.status, "armed");
  k.at("2026-10-28T15:00:00.000Z"); k.reverse("2026-10-28", "nsf_return");
  const post = k.row(rid3); assert.equal(post.status, "post_recording_reversal"); assert.equal(post.status_before_reversal, "recorded"); assert.equal(post.loan_serviced_as, "unsecured_pending_cure"); assert.equal(post.borrower_charge_cents, 0n); assert.equal(post.borrower_notice_hold, true);
  const att = k.rt.escalations.opened.find((e) => e.kind === "attorney")!; assert.equal(att.severity, "sev1"); assert.match(String(att.payload.reason), /re-recording \/ reinstatement of lien/); assert.equal(att.payload.borrower_charge_cents, 0n); assert.ok(k.rt.escalations.opened.some((e) => e.kind === "officer"), "officer informed");
  const pe = k.ofType("lien_release.post_recording_reversal")[0]!; assert.equal(pe.payload.attorney_escalation_id, att.id); assert.deepEqual(pe.payload.timers_released, ["SM_BORROWER_RELEASE_NOTICE_5BD"]); assert.equal(k.timer("SM_BORROWER_RELEASE_NOTICE_5BD")!.status, "cancelled"); assert.equal(k.timer("STATE_LIEN_RELEASE_DEADLINE")!.status, "satisfied", "the statutory duty was met; only the borrower-notice clock is released");
  await refusedWith(k.run("notifyBorrower", { loan_id: "L-OH-R", release_task_id: rid3, op: "release_recorded", consent_on_file: true, recipients: RECIPIENTS, payload: sample("NTC_LIEN_RELEASE_RECORDED") }), "REVERSED_PAYOFF_NEEDS_OFFICER");
  await refusedWith(k.run("submitRecording", { release_task_id: rid3, pages: 2, charge_borrower: true, disclosed_on_statement: true, permitted_by_security_instrument: true, c1205_conditions: true }), "REVERSED_PAYOFF_NEEDS_OFFICER");
  assert.equal(k.ofType("fee.posting_requested").length, borrowerPostings, "no borrower charge after the reversal"); assert.equal(k.ofType("notice.sent").length, 0); assert.equal(k.uow.ledger.sets().length, 1, "the $34.00 already booked stays; nothing new");
  // without the reactor wired, the next tool call settles the same reversal from the persisted events before refusing
  const lazy = harness("L-OH-L", "2026-10-16T15:00:00.000Z", { loan: OH_LOAN, reactors: false }); const rid4 = (await lazy.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-OH-L" })).release_task_id as string;
  await lazy.run("draftReleaseInstrument", { release_task_id: rid4, ...OH_DRAFT }); await lazy.run("runReleaseChecklist", { release_task_id: rid4, present: ALL_PRESENT, county_requires_legal_description: false });
  lazy.at("2026-10-28T15:00:00.000Z"); lazy.reverse("2026-10-28", "nsf_return"); assert.equal(lazy.row(rid4).status, "prepared", "no reactor: nothing yet");
  await refusedWith(lazy.run("routeForExecution", { release_task_id: rid4 }), "REVERSED_PAYOFF_NEEDS_OFFICER"); assert.equal(lazy.row(rid4).status, "void"); assert.equal(lazy.ofType("lien_release.voided").length, 1); assert.equal(lazy.armedTimers().length, 0);
});
test("16.3-T12: Given an agent attempts to execute without a passed checklist, then the command is rejected and logged.", async () => {
  const r = executionCommand({ checklist_passed: false, payoff_evidence_document_id: "doc-payoff-1", actor: "agent:payoff-release", attempted_at: "2026-10-21T15:00:00.000Z" });
  assert.equal(r.accepted, false); assert.equal(r.refusal!.code, "NO_EXECUTION_WITHOUT_CHECKLIST"); assert.match(r.refusal!.citation, /no execution without a passed checklist and proof of payoff/);
  assert.equal(r.event.type, "command.refused"); assert.equal(r.event.command, "routeForExecution"); assert.equal(r.event.actor, "agent:payoff-release"); assert.equal(r.event.at, "2026-10-21T15:00:00.000Z"); assert.equal(r.logged, true);
  assert.equal(executionCommand({ checklist_passed: true, payoff_evidence_document_id: null, actor: "agent:payoff-release", attempted_at: "2026-10-21T15:00:00.000Z" }).refusal!.code, "NO_PROOF_OF_PAYOFF");
  assert.equal(executionCommand({ checklist_passed: true, payoff_evidence_document_id: "doc-payoff-1", actor: "agent:payoff-release", attempted_at: "2026-10-21T15:00:00.000Z", agent_signs: true }).refusal!.code, "AGENT_NEVER_SIGNS");
  assert.equal(executionCommand({ checklist_passed: true, payoff_evidence_document_id: "doc-payoff-1", actor: "agent:payoff-release", attempted_at: "2026-10-21T15:00:00.000Z", hold_reason: "confidence 0.6 < 0.9" }).refusal!.code, "HELD_FOR_REVIEW");
  const ok = executionCommand({ checklist_passed: true, payoff_evidence_document_id: "doc-payoff-1", actor: "agent:payoff-release", attempted_at: "2026-10-21T15:00:00.000Z" }); assert.equal(ok.accepted, true); assert.equal(ok.event.type, "lien_release.execution_requested"); assert.equal(ok.accepted && ok.escalation.kind, "signing_officer");
  // the machine checklist itself: a missing legal description in a county that requires it fails the pass
  assert.deepEqual(releaseChecklist({ present: { ...ALL_PRESENT, legal_description: false }, county_requires_legal_description: true, mers: true }).failed, ["legal_description"]); assert.equal(releaseChecklist({ present: { ...ALL_PRESENT, legal_description: false }, county_requires_legal_description: false, mers: true }).passed, true);
  // on the bus: the gate reads the persisted checklist and payoff evidence — the agent's own `checklist_passed: true` is not evidence
  const h = harness("L-OH", "2026-10-21T15:00:00.000Z"); const rid = (await h.run("selectReleaseInstrument", OH_OPEN)).release_task_id as string; await h.run("draftReleaseInstrument", { release_task_id: rid, ...OH_DRAFT });
  const chk = await h.run("runReleaseChecklist", { release_task_id: rid, present: { ...ALL_PRESENT, legal_description: false }, county_requires_legal_description: true }); assert.equal(chk.passed, false); assert.deepEqual(chk.failed, ["legal_description"]);
  const refused = await refusedWith(h.run("routeForExecution", { release_task_id: rid, checklist_passed: true, payoff_evidence_document_id: "doc-payoff-L-OH" }), "NO_EXECUTION_WITHOUT_CHECKLIST");
  assert.match(refused.citation, /no execution without a passed checklist and proof of payoff/);
  const logged = h.ofType("command.refused").at(-1)!; assert.equal(logged.payload.command, "routeForExecution"); assert.equal(logged.payload.code, "NO_EXECUTION_WITHOUT_CHECKLIST"); assert.equal(logged.payload.checklist_passed, false); assert.deepEqual(logged.actor, AGENT); assert.equal(logged.occurredAt, "2026-10-21T15:00:00.000Z");
  assert.equal(h.rt.escalations.opened.length, 0, "no signing_officer package"); assert.equal(h.ofType("lien_release.execution_requested").length, 0); assert.equal(h.rt.store.get("release_tasks", rid)!.data.status, "opened");
  await refusedWith(h.run("runReleaseChecklist", { release_task_id: rid, present: {}, force_pass: true }), "CHECKLIST_IS_MACHINE_CHECKED");
  // a passed checklist without payoff evidence on the row is still refused; the agent asking to sign is refused before the handler runs
  const bare = harness("L-OH-2", "2026-10-21T15:00:00.000Z"); const rid2 = (await bare.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-OH-2", settlement_id: "", payoff_evidence_document_id: "" })).release_task_id as string;
  await bare.run("draftReleaseInstrument", { release_task_id: rid2, ...OH_DRAFT }); await bare.run("runReleaseChecklist", { release_task_id: rid2, present: ALL_PRESENT, county_requires_legal_description: false });
  await refusedWith(bare.run("routeForExecution", { release_task_id: rid2 }), "NO_PROOF_OF_PAYOFF");
  await refusedWith(h.run("routeForExecution", { release_task_id: rid, sign: true }), "AGENT_NEVER_SIGNS");
  // a held task (confidence 0.6 on the mortgagee of record) stays held until the attorney clears the title review
  const held = harness("L-OH-3", "2026-10-21T15:00:00.000Z"); const rid3 = (await held.run("selectReleaseInstrument", { ...OH_OPEN, loan_id: "L-OH-3", confidence: 0.6 })).release_task_id as string;
  assert.equal(held.rt.store.get("release_tasks", rid3)!.data.status, "held"); assert.equal(held.rt.store.get("release_tasks", rid3)!.data.review_by, "2026-12-30", "deadline 2027-01-14 − 15 days"); assert.equal(held.rt.escalations.opened[0]!.kind, "attorney");
  await held.run("draftReleaseInstrument", { release_task_id: rid3, ...OH_DRAFT }); await held.run("runReleaseChecklist", { release_task_id: rid3, present: ALL_PRESENT, county_requires_legal_description: false });
  await refusedWith(held.run("routeForExecution", { release_task_id: rid3 }), "HELD_FOR_REVIEW"); await refusedWith(held.run("routeForExecution", { release_task_id: rid3, confidence: 0.6 }), "HOLD_UNTIL_TITLE_REVIEW");
  await refusedWith(held.run("routeForExecution", { release_task_id: rid3, op: "title_review_cleared" }), "TITLE_REVIEW_CLEARED_BY_HUMAN"); await held.run("routeForExecution", { release_task_id: rid3, op: "title_review_cleared" }, ATTORNEY);
  assert.equal((await held.run("routeForExecution", { release_task_id: rid3 })).status, "awaiting_execution");
});

test("16.3 worked figures: Ohio MERS MOM payoff Fri 10/16/2026 → deadline Thu 01/14/2027, prepared by 10/23, executed by 10/28, submitted by 11/06, recording fee $34.00 (R.C. §317.32: two pages) borrower-funded via recording_fee_payable and matched to the vendor ACH, NTC_LIEN_RELEASE_RECORDED by 11/02 (sent 10/27), MERS deactivation due 12/25 (target 11/02); California Form 2009 10/16 → trustee delivery by Sun 11/15 (target Fri 11/13), trustee record by 11/18, $500 forfeiture; Maryland wire 10/16 → delivery by 10/23 with custody in parallel; NJ notice by 10/26, fee ≤ $25; SF CPM package within 2 BD / 15 BD follow-up; penalty models (OH $250 then $100/day after notice capped $5,000; CT $200/week)", () => {
  // worked example 1
  const oh = openReleaseTask({ state: "OH", payoff_on: D("2026-10-16") });
  assert.equal(oh.status, "opened"); assert.equal(oh.original_note_required, false); assert.equal(oh.deadline_at, "2027-01-14"); assert.equal(oh.cite, "R.C. §5301.36"); assert.equal(oh.statutory_anchor, "payoff");
  assert.deepEqual(oh.timers, { STATE_LIEN_RELEASE_DEADLINE: "2027-01-14", SM_RELEASE_PREPARE_5BD: "2026-10-23", SM_RELEASE_SUBMIT_21: "2026-11-06", FNMA_F110_FORM2009_CUSTODY_REQUEST_1BD: null });
  const sel = selectInstrument({ state: "OH", security_instrument: "mortgage", mortgagee_of_record: "mers", min_active: true, lpoa_recorded: false, min: "1000123-0000456789-0", fnma_loan_number: "1234567890", deadline_at: D("2027-01-14") });
  assert.equal(sel.instrument_type, "release_of_mortgage"); assert.equal(sel.signatory_path, "mers_signing_officer"); assert.equal(sel.recording_path, "direct"); assert.deepEqual(sel.recites, { mers_as_nominee: true, min: "1000123-0000456789-0", fnma_loan_number: "1234567890" });
  // the recording fee is computed from the recorder's schedule (rule 3): Ohio $34 for the first two pages, $8 each additional; a two-page release = $34.00, matched to the vendor ACH and the borrower-collected recording_fee_payable
  const fee = recorderFee({ state: "OH", pages: 2, vendor_ach_cents: 3_400n, borrower_collected_cents: 3_400n });
  assert.equal(fee.fee_cents, 3_400n); assert.equal(fee.schedule_cite, "Ohio R.C. §317.32"); assert.equal(fee.matches_vendor_ach, true); assert.equal(fee.matches_borrower_collection, true); assert.equal(fee.account, "recording_fee_payable");
  assert.equal(recorderFee({ state: "OH", pages: 3 }).fee_cents, 4_200n); assert.equal(recorderFee({ state: "OH", pages: 2, vendor_ach_cents: 4_200n }).matches_vendor_ach, false);
  const posting = releaseFeePosting({ state: "OH", fee_cents: fee.fee_cents, fee_kind: "recording", disclosed_on_statement: true, permitted_by_security_instrument: true, c1205_conditions: true, payoff_on: D("2026-10-16"), borrower_collected_cents: 3_400n });
  assert.equal(posting.chargeable, true); assert.equal(posting.postings[0]!.account, "recording_fee_payable"); assert.equal(posting.postings[0]!.debit, fee.fee_cents); assert.equal(posting.postings[1]!.credit, fee.fee_cents); assert.equal(posting.matched_to_borrower_collection, true); assert.equal(posting.borrower_charge_cents, fee.fee_cents);
  const bn = borrowerNotification({ state: "OH", recorded_on: D("2026-10-26"), consent_on_file: true });
  assert.equal(bn.send_by, "2026-11-02"); assert.equal(bn.channel, "edelivery"); assert.equal(bn.breach_severity, "sev3"); assert.equal(bn.note_return, null); assert.ok("2026-10-27" <= bn.send_by, "e-delivered Tue 10/27 satisfies SM_BORROWER_RELEASE_NOTICE_5BD");
  const rec = recordedRelease({ state: "OH", recorded_on: D("2026-10-26"), recording_reference: "Instrument No. 202610260012345", image: "%PDF image", deadline_at: D("2027-01-14"), via: "erecord" });
  assert.equal(rec.on_time, true); assert.equal(rec.borrower_notice_by, "2026-11-02"); assert.deepEqual([rec.mers_deactivation_due, rec.mers_deactivation_target], ["2026-12-25", "2026-11-02"]); assert.equal(rec.document.sha256, sha256("%PDF image")); assert.equal(rec.document.retention_class, "life_of_loan_plus_4y");
  assert.equal(penaltyExposureReport({ state: "OH", payoff_on: D("2026-10-16"), deadline_at: D("2027-01-14"), as_of: D("2027-02-01"), satisfied_on: D("2026-10-26") }).breached, false);
  assert.deepEqual([deactivationClocks(D("2026-10-26")).due_on, deactivationClocks(D("2026-10-26")).policy_target], ["2026-12-25", "2026-11-02"]);
  assert.equal(borrowerNotification({ state: "FL", recorded_on: D("2026-10-26"), consent_on_file: false }).breach_severity, "sev1");
  // penalty models: OH $250 on breach, +$100/day after notice, capped $5,000; CT $200/week past the 60 days, capped $5,000
  const ohLate = (as_of: string, notice?: string) => penaltyExposureReport({ state: "OH", payoff_on: D("2026-10-16"), deadline_at: D("2027-01-14"), as_of: D(as_of), satisfied_on: null, notice_given_on: notice ? D(notice) : null });
  assert.equal(ohLate("2027-01-20").penalty_exposure_cents, 25_000n); assert.equal(ohLate("2027-01-20", "2027-01-16").penalty_exposure_cents, 65_000n); assert.equal(ohLate("2027-03-31", "2027-01-16").penalty_exposure_cents, 500_000n); assert.equal(ohLate("2027-01-20").attorney_fee_exposure, true);
  const ct = penaltyExposureReport({ state: "CT", payoff_on: D("2026-10-16"), deadline_at: statutoryDeadline("CT", D("2026-10-16")).deadline_at, as_of: D("2027-03-25"), satisfied_on: null }); assert.equal(ct.days_late, 100); assert.equal(ct.penalty_exposure_cents, 300_000n);
  assert.equal(penaltyExposureReport({ state: "CT", payoff_on: D("2026-10-16"), deadline_at: D("2026-12-15"), as_of: D("2027-12-01"), satisfied_on: null }).penalty_exposure_cents, 500_000n);
  // worked example 2
  const ca = caTrusteePath({ payoff_on: D("2026-10-16"), custody_sent_on: D("2026-10-16"), originals_received_on: D("2026-10-23"), executed_on: D("2026-10-27"), delivered_to_trustee_on: D("2026-10-28"), delivery_evidence_document_id: "doc-courier-1", reconveyance_recorded_on: D("2026-11-05") });
  assert.equal(ca.instrument_type, "request_for_full_reconveyance"); assert.equal(ca.custody_request_by, "2026-10-19"); assert.equal(ca.deliver_by, "2026-11-15"); assert.equal(ca.operational_target, "2026-11-13"); assert.equal(ca.trustee_record_by, "2026-11-18"); assert.equal(ca.delivery_on_time, true); assert.equal(ca.trustee_on_time, true);
  const caModel = releaseRule("CA").penalty_model; assert.equal(ca.forfeiture_cents, caModel.kind === "forfeiture" ? caModel.cents : -1n); assert.equal(ca.forfeiture_cents, 50_000n, "§2941(d): $500 forfeiture"); assert.equal(penaltyExposureReport({ state: "CA", payoff_on: D("2026-10-16"), deadline_at: ca.deliver_by, as_of: D("2026-11-20"), satisfied_on: null }).penalty_exposure_cents, ca.forfeiture_cents);
  assert.equal(caTrusteePath({ payoff_on: D("2026-10-16"), custody_sent_on: null, originals_received_on: null, substitution_permitted: true }).instrument_type, "substitution_of_trustee_and_full_reconveyance");
  const cr = custodyRequest({ state: "CA", payoff_on: D("2026-10-16"), sent_on: D("2026-10-16"), received_on: D("2026-10-23") });
  assert.equal(cr.required, true); assert.equal(cr.form, "2009"); assert.equal(cr.request_by, "2026-10-19"); assert.equal(cr.sent_on_time, true); assert.equal(cr.return_monitor_by, "2026-10-30"); assert.equal(cr.received_on_time, true); assert.equal(cr.status, "received");
  assert.equal(openReleaseTask({ state: "CA", payoff_on: D("2026-10-16") }).status, "awaiting_custody_docs"); assert.equal(openReleaseTask({ state: "CO", payoff_on: D("2026-10-16") }).status, "awaiting_custody_docs");
  // worked example 3
  const md = mdDelivery({ funds_received_on: D("2026-10-16"), certified_or_wire: true, delivered_on: D("2026-10-21"), evidence_document_id: "doc-agent-ack-1", submitted_on: D("2026-10-21") });
  assert.equal(md.due, "2026-10-23"); assert.equal(md.satisfied, true); assert.equal(md.satisfied_by, "delivery_to_settlement_agent"); assert.equal(md.recording_monitor, "SM_RECORDING_CONFIRM_30"); assert.equal(md.recording_confirm_by, "2026-11-20");
  const mdTask = openReleaseTask({ state: "MD", payoff_on: D("2026-10-16") }); assert.equal(mdTask.status, "opened"); assert.equal(mdTask.original_note_required, true); assert.equal(mdTask.custody_in_parallel, true); assert.equal(mdTask.timers.FNMA_F110_FORM2009_CUSTODY_REQUEST_1BD, "2026-10-19"); assert.equal(mdTask.timers.SM_RELEASE_SUBMIT_21, "2026-10-16");
  assert.equal(statutoryDeadline("MD", D("2026-10-16")).satisfied_by, "delivery"); assert.equal(statutoryDeadline("FL", D("2026-10-16")).deadline_at, "2026-11-30");
  // T6 New Jersey and T5 SF CPM
  const nj = njCancellationNotice({ payoff_on: D("2026-10-16"), nonbank: true, fee_cents: 2_500n, fee_received_on: D("2026-10-30"), notice_date: D("2026-10-21") }); assert.equal(nj.notice, "NTC_NJ_CANCELLATION_RIGHT"); assert.equal(nj.notice_by, "2026-10-26"); assert.equal(nj.fee_within_cap, true); assert.equal(nj.cap_cents, releaseRule("NJ").fee_cap_cents); assert.equal(nj.cancel_by, "2026-11-29"); assert.equal(nj.days_after_payoff, 5);
  const f = fnmaExecutionPackage({ state: "TX", prepared_on: D("2026-10-21"), lpoa_recorded: false, original_required: false, fnma_loan_number: "1234567890", sent_on: D("2026-10-22") });
  assert.equal(f.blocked, true); assert.equal(f.signatory_path, "fnma_execution"); assert.equal(f.channel, "email"); assert.equal(f.to, "sfcpm.servicingdocuments@fanniemae.com"); assert.equal(f.send_by, "2026-10-23"); assert.equal(f.follow_up_by, "2026-11-13", "15 BD from 10/22 skips Veterans Day 11/11"); assert.deepEqual([...f.package], ["fnma_loan_number", "reason", "executable_document", "cover_letter", "return_shipping_label"]); assert.equal(f.reason, "Satisfaction — no LPOA for TX");
  assert.equal(fnmaExecutionPackage({ state: "TX", prepared_on: D("2026-10-21"), lpoa_recorded: false, original_required: true, fnma_loan_number: "1234567890" }).channel, "mail");
  // the four 16.3 notices publish and their samples pass their own checklists; the recorded-release letter carries the reference, release statement and MERS note; the Maryland note-return letter (no request) passes
  for (const code of ["NTC_LIEN_RELEASE_RECORDED", "NTC_NJ_CANCELLATION_RIGHT", "NTC_ENOTE_PAPER_COPY", "NTC_NOTE_RETURNED"]) { const v = noticeReg.activeVersion(code, D("2026-10-27"))!; assert.equal(evaluateChecklist(v, v.samplePayload, render(v.source, v.samplePayload)).passed, true, code); }
  const v = noticeReg.activeVersion("NTC_LIEN_RELEASE_RECORDED", D("2026-10-27"))!; const out = render(v.source, v.samplePayload);
  assert.match(out.text, /Instrument No\. 202610260012345/); assert.match(out.text, /lien on your property has been released/); assert.match(out.text, /MIN 1000123-0000456789-0/);
  assert.equal(evaluateChecklist(v, { ...v.samplePayload, recorded_image_attached: false }, render(v.source, { ...v.samplePayload, recorded_image_attached: false })).passed, false, "the recorded image is mandatory");
  const nj2 = noticeReg.activeVersion("NTC_NJ_CANCELLATION_RIGHT", D("2026-10-27"))!; assert.equal(evaluateChecklist(nj2, { ...nj2.samplePayload, cancellation_fee_cents: 2_600n }, render(nj2.source, { ...nj2.samplePayload, cancellation_fee_cents: 2_600n })).passed, false, "fee above $25 is a block");
  const nr = noticeReg.activeVersion("NTC_NOTE_RETURNED", D("2026-11-12"))!; const { requested_on: _r, days_after_request: _d, ...mdPayload } = { ...nr.samplePayload, property_address: "7 Charles St, Baltimore MD 21201", statutory_basis: "Md. Real Prop. §7-106" } as Record<string, unknown>;
  assert.equal(evaluateChecklist(nr, mdPayload, render(nr.source, mdPayload)).passed, true, "Maryland return without a borrower request"); assert.match(render(nr.source, mdPayload).text, /as required by Md\. Real Prop\. §7-106/);
  assert.equal(evaluateChecklist(nr, { ...nr.samplePayload, days_after_request: 46 }, render(nr.source, { ...nr.samplePayload, days_after_request: 46 })).passed, false, "NY: 46 days after the request is late");
  assert.equal(noticeReg.template("NTC_ENOTE_PAPER_COPY").channelPolicy, "mail_only"); assert.equal(noticeReg.template("NTC_NOTE_RETURNED").channelPolicy, "mail_only");
  // which event closes the statutory duty (registry: recorded, or delivered where the statute is satisfied by delivery; CA §2941(b)(1)(A): delivery to the trustee)
  assert.deepEqual(["OH", "MD", "MA", "CA", "NY", "XX"].map(statutoryDutyEvent), ["lien_release.recorded", "lien_release.delivered", "lien_release.delivered", "lien_release.delivered_to_trustee", "lien_release.recorded", "lien_release.recorded"]);
  // the paper package (T8): print-mail job to the recorder, positive-pay fee check on corporate cash, 31-digit mail-tracking barcode, the four contents
  const pkg = paperRecordingPackage({ submission_id: "rs-1", recorder_name: "Delaware County Recorder", recorder_address: "145 N Union St, Delaware OH 43015", fee_cents: 3_400n, pages: 2, submitted_on: D("2026-10-26") });
  assert.equal(pkg.mail_job.jobId, "mail-rs-1"); assert.equal(pkg.mail_job.template, "RECORDING_PACKAGE_PAPER"); assert.equal(pkg.mail_job.pages, 4); assert.equal(pkg.mail_job.separateDocument, true); assert.deepEqual(pkg.check, { check_number: "RF-rs-1", payee: "Delaware County Recorder", amount_cents: 3_400n, positive_pay: true, issued_on: "2026-10-26", funding_account: "corporate_cash" });
  assert.match(pkg.mail_tracking_barcode, /^\d{31}$/); assert.equal(pkg.mail_tracking_barcode, mailTrackingBarcode("mail-rs-1")); assert.notEqual(mailTrackingBarcode("mail-rs-2"), pkg.mail_tracking_barcode); assert.deepEqual([...pkg.contents], ["printed_instrument", "recording_fee_check_positive_pay", "self_addressed_return_envelope", "pria_cover_sheet"]);
  // the exposure report defers to the persisted clock: a breached STATE_LIEN_RELEASE_DEADLINE is a breach whatever dates the caller offers
  assert.equal(penaltyExposureReport({ state: "OH", payoff_on: D("2026-10-16"), deadline_at: D("2027-12-31"), as_of: D("2027-01-20"), satisfied_on: null, timer_breached: true }).breached, true);
  assert.equal(RELEASE_TIMERS_16_3.length, 18, "the process's Timers attribute");
});
