// 1.1 Loan data intake & validation (note terms, remittance type A/A–S/A–S/S, escrow flags, MERS MIN)
// spec/sections/01-boarding-servicing-transfer-in/1-1-loan-data-intake-validation-note-terms-remittance-type-a-as.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "../../kernel/money/cents.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import type { CommandContext } from "../../app/commands.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { SECTION_01_TOOLS, MONEY_FIELDS } from "../../app/tools/section01.ts";
import { TransferBatchService, recordMersAcknowledgement, SUPERMORTGAGE_ORG_ID } from "../transfers/inbound.ts";
import { principalPortion } from "./amortization.ts";
import { boardingHarness, stagedLoan, history, PARTNER_ORG } from "./fixtures.ts";
import { makeMin } from "./min.ts";
import { BoardingService, type CorrectionResult } from "./service.ts";
import { handleBoardingBreach, postTransferMonitoringReport, manualBoardingQueue, monthsBetween } from "./ops-1-1.ts";

const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const ANALYST: Actor = { kind: "human", id: "u-analyst", role: "analyst" };
const AGENT: Actor = { kind: "agent", id: "boarding" };
const TRANSFER: Actor = { kind: "agent", id: "transfer" };
const OPERATOR: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };

/** The 1.2 batch state machine (TransferBatchService, the real `transfer.batch.*` emitter) driven to `approved` for transfer date `T` on `events`. */
function approveBatch(events: MemoryEventStore, clock: FixedClock, batchId: string, T: ReturnType<typeof D>): TransferBatchService {
  const tb = new TransferBatchService({ events, clock });
  tb.propose({ batch_id: batchId, type: "master_to_sub", transfer_date: T, sale_date: null, loan_count: 2 }, TRANSFER);
  tb.transition(batchId, "package_ready", { form629_document_id: "doc-629", loan_list_version: 1, custodian_matrix_document_id: "doc-matrix", dq_precheck_passed: true }, TRANSFER);
  tb.transition(batchId, "submitted", { portal_completion_record_id: "portal-rec-1" }, OPERATOR);
  tb.recordApproval(batchId, { d_code: "D-2026-10", fnma_consent_document_id: "doc-consent", consent_document_hash: "sha256:consent" }, true);
  tb.transition(batchId, "approved", {}, OFFICER);
  return tb;
}
/** The same machine run to `closed` on its own store: the `transfer.batch.closed` the 1.1 monitor waits for, as 1.2 emits it. */
function closedBatchEvent(batchId: string, T: ReturnType<typeof D>): DomainEvent {
  const clock = new FixedClock("2026-08-20T14:00:00.000Z"); const store = new MemoryEventStore(clock);
  const tb = approveBatch(store, clock, batchId, T);
  tb.transition(batchId, "loan_list_frozen", { officer_attestation_document_id: "doc-attest" }, OFFICER);
  for (const to of ["pre_boarding", "notice_window", "cutover", "post_transfer"] as const) tb.transition(batchId, to, {}, TRANSFER);
  clock.set("2027-04-01T15:00:00.000Z");
  tb.transition(batchId, "closed", {}, OFFICER);
  return store.ofType("transfer.batch.closed")[0]!;
}

test("1.1-T1: Given a 5,000-loan preliminary tape with all hard rules satisfied, when validated, then 100% `validated` within the nightly job and a DQ scorecard is produced.", () => {
  const { svc, ext, events } = boardingHarness("2026-09-17T02:00:00.000Z");
  const rows = Array.from({ length: 5000 }, (_, i) => stagedLoan({ seq: i + 1 }));
  for (const r of rows) ext.agree(r);
  assert.equal(svc.ingestTape("B1", "preliminary", `tape-bytes-${rows.length}`, rows.length).status, "accepted");
  assert.equal(events.ofType("transfer.tape.received")[0]!.payload.transfer_date, "2026-10-01");
  svc.stage("B1", rows);
  const card = svc.validate("B1");                                              // the nightly `boarding.stage.validate` job
  assert.deepEqual([card.loans.validated, card.loans.exception, card.loans.staged], [5000, 0, 0]);
  assert.deepEqual(card.hard, {}); assert.equal(card.hard_fail_rate, 0); assert.equal(card.rule_set_version, "boarding.dq.v1");
  assert.equal(events.ofType("loan.validated").length, 5000);
});
test("1.1-T2: Given a loan whose tape UPB is $245,634.12 and Fannie Mae position shows $245,634.13, when validated, then `HF-003` fails, the loan is `exception`, and the transferor query lists both values in cents.", () => {
  const { svc, ext } = boardingHarness("2026-09-17T02:00:00.000Z");
  const loan = stagedLoan({ upb_cents: cents("245634.12") }); ext.agree(loan);
  ext.fnmaRows.set(loan.fnma_loan_number!, { ...ext.fnmaRows.get(loan.fnma_loan_number!)!, upb_cents: cents("245634.13") });
  const [bl] = svc.stage("B1", [loan]);
  const card = svc.validate("B1");
  assert.equal(bl!.status, "exception"); assert.equal(card.hard["HF-003"], 1);
  const q = svc.transferorQuery(bl!.id);
  assert.equal(q.items.length, 1); assert.equal(q.items[0]!.rule_code, "HF-003"); assert.equal(q.items[0]!.money_field, true);
  assert.deepEqual(q.items[0]!.expected, { fnma_position_cents: "24563413" }); assert.deepEqual(q.items[0]!.actual, { tape_cents: "24563412" });
});
test("1.1-T3: Given a fixed-rate loan (6.375%, UPB $245,634.12) with tape P&I $1,616.03, when `HF-005` runs, then recomputed P&I is within $0.01 and monthly interest equals $1,304.93.", () => {
  const { svc, ext } = boardingHarness("2026-09-17T02:00:00.000Z");
  const loan = stagedLoan({ pi_cents: cents("1616.03") }); ext.agree(loan);
  const [bl] = svc.stage("B1", [loan]); svc.validate("B1");
  assert.equal(bl!.validations.find((v) => v.code === "HF-005")!.result, "pass");
  assert.equal(svc.scheduledInterest(bl!), cents("1304.93"));                   // 245,634.12 × 6.375% / 12 = 1,304.9313 → $1,304.93
  const off = stagedLoan({ seq: 2, pi_cents: cents("1616.10") }); ext.agree(off);
  const [bl2] = svc.stage("B1", [off]); svc.validate("B1");
  const v = bl2!.validations.find((x) => x.code === "HF-005")!; assert.equal(v.result, "fail"); assert.deepEqual(v.actual, { tape_pi_cents: "161610" });
});
test("1.1-T4: Given a MIN with a wrong check digit, then `HF-008` fails and the loan cannot board.", () => {
  const { svc, ext, clock } = boardingHarness("2026-09-17T02:00:00.000Z");
  const good = makeMin(PARTNER_ORG, "77");
  const loan = stagedLoan({ min: good.slice(0, 17) + String((Number(good[17]) + 5) % 10) }); ext.agree(loan);
  const [bl] = svc.stage("B1", [loan]); svc.validate("B1");
  assert.equal(bl!.status, "exception"); assert.equal(bl!.validations.find((v) => v.code === "HF-008")!.result, "fail");
  clock.set("2026-10-01T14:00:00.000Z");
  assert.equal(svc.board("B1", { finalTapeReconciled: true }).boarded.length, 0); assert.equal(bl!.status, "exception");
});
test("1.1-T5: Given a loan with earliest unpaid due date Aug. 1, 2026 and transfer date Oct. 1, 2026, then `regx_days_delinquent_at_boarding` = 61, `fdcpa_debt_collector_flag` = true, and 11.1/11.2 timers are seeded as already breached (immediate action).", () => {
  const { svc, ext, timers, clock } = boardingHarness("2026-10-01T14:00:00.000Z");
  const pi = stagedLoan().pi_cents!, esc = stagedLoan().escrow_payment_cents;
  const h = history(D("2026-06-01"), 5, pi + esc, 2);                           // Jun, Jul paid; Aug 1, Sep 1, Oct 1 unpaid
  const loan = stagedLoan({ installments: h.installments, payments: h.payments }); ext.agree(loan);
  const [bl] = svc.stage("B1", [loan]); svc.validate("B1");
  assert.equal(svc.board("B1", { finalTapeReconciled: true }).boarded.length, 1);
  assert.deepEqual([bl!.regx_days_delinquent_at_boarding, bl!.fnma_delinquency_status_at_boarding, bl!.fdcpa_debt_collector_flag, bl!.default_status_at_boarding], [61, "60", true, true]);
  const live = timers.byCode("REGX_1024_39A_LIVE_CONTACT_36").filter((t) => t.loanId === bl!.id), notice = timers.byCode("REGX_1024_39B_WRITTEN_NOTICE_45").filter((t) => t.loanId === bl!.id);
  assert.deepEqual(live.map((t) => t.dueDate), ["2026-09-06", "2026-10-07"]); assert.deepEqual(notice.map((t) => t.dueDate), ["2026-09-15", "2026-10-16"]);
  const codes = timers.evaluate(clock.now()).map((b) => `${b.def.code}@${b.instance.dueDate}`).sort();
  assert.deepEqual(codes, ["REGX_1024_39A_LIVE_CONTACT_36@2026-09-06", "REGX_1024_39B_WRITTEN_NOTICE_45@2026-09-15"]);   // already past due at boarding → immediate action
});
test("1.1-T6: Given transfer date Oct. 1, 2026 (Thursday) and a loan whose next due date is Oct. 1, then `SM_BOARD_FIRST_CYCLE` due = Oct. 1, 2026; boarded Oct. 2 → breach recorded and escalated.", () => {
  const { svc, ext, timers, clock, events, esc } = boardingHarness("2026-09-20T14:00:00.000Z");
  const loan = stagedLoan({ next_due_date: D("2026-10-01") }); ext.agree(loan);
  const [bl] = svc.stage("B1", [loan]);
  assert.equal(bl!.first_cycle_due, "2026-10-01");
  const fc = timers.byCode("SM_BOARD_FIRST_CYCLE")[0]!; assert.equal(fc.dueDate, "2026-10-01"); assert.equal(toIso(fc.dueAt!), toIso(zonedEpochMs(D("2026-10-01"), "23:59", "America/New_York")));
  svc.validate("B1");
  clock.set("2026-10-02T12:00:00.000Z");
  const breaches = timers.evaluate(clock.now());
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, "SM_BOARD_FIRST_CYCLE"); assert.equal(breaches[0]!.severity, 1);
  assert.equal(events.ofType("timer.breached").length, 1);                       // breach recorded …
  // … and escalated: "sev 1 escalation; loan enters manual boarding; payment intake for the loan falls back to suspense (2.2)"
  const out = handleBoardingBreach({ events, esc, svc, timers }, breaches[0]!);
  assert.equal(out.escalation!.ownerRole, "officer"); assert.equal(esc.opened[0]!.severity, "sev-1"); assert.equal(esc.opened[0]!.loanId, bl!.id); assert.equal(esc.opened[0]!.slaTimerId, fc.id);
  const created = events.ofType("escalation.created")[0]!;
  assert.deepEqual([created.payload.timer_code, created.payload.owner_role, created.payload.due_date], ["SM_BOARD_FIRST_CYCLE", "officer", "2026-10-01"]);
  const manual = events.ofType("loan.boarding.manual_required")[0]!;
  assert.deepEqual([manual.loanId, manual.payload.payment_fallback, manual.payload.escalation_id, manual.payload.boarding_status], [bl!.id, "suspense", out.escalation!.id, "validated"]);
  assert.deepEqual(manualBoardingQueue(events, svc, "B1").map((l) => l.id), [bl!.id]);
  svc.board("B1", { finalTapeReconciled: true });                                // boarded Oct 2 (manually): the timer closes late and the loan leaves the manual queue
  assert.equal(fc.status, "satisfied_late"); assert.deepEqual(manualBoardingQueue(events, svc, "B1"), []);
  const later = stagedLoan({ seq: 2, next_due_date: D("2026-11-01") }); ext.agree(later);
  assert.equal(svc.stage("B1", [later])[0]!.first_cycle_due, "2026-10-06");    // next due later than T+3 BD → anchors on T+3 servicer BD
});
test("1.1-T7: Given an escrowed loan boarded Dec. 2, 2026 (Wednesday) at 16:00 ET, then `EscrowSetup` events are due 03:00 ET Dec. 3, 2026; a rejected event re-queues and breaches if not acked by then.", () => {
  const boardedAt = toIso(zonedEpochMs(D("2026-12-02"), "16:00", "America/New_York"));
  const { svc, ext, timers, events, clock } = boardingHarness(boardedAt, D("2026-12-01"), ["1.1"]);
  const h = history(D("2026-09-01"), 4, stagedLoan().pi_cents! + stagedLoan().escrow_payment_cents, 4);
  const escrowed = stagedLoan({ escrowed: true, next_due_date: D("2027-01-01"), installments: h.installments, payments: h.payments });
  const nonEscrowed = stagedLoan({ seq: 2, escrowed: false, escrow_lines: [], escrow_balance_cents: 0n, escrow_payment_cents: 0n, next_due_date: D("2027-01-01"), installments: h.installments, payments: h.payments });
  ext.agree(escrowed); ext.agree(nonEscrowed);
  const [bl] = svc.stage("B1", [escrowed, nonEscrowed]); svc.validate("B1");
  assert.equal(svc.board("B1", { finalTapeReconciled: true }).boarded.length, 2);
  const setup = timers.byCode("LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1");
  assert.equal(setup.length, 1); assert.equal(setup[0]!.loanId, bl!.id);       // only the escrowed loan
  assert.equal(toIso(setup[0]!.dueAt!), "2026-12-03T08:00:00.000Z");            // 03:00 ET Dec 3
  assert.deepEqual(BoardingService.escrowCategoriesOf(escrowed), ["tax", "hazard"]);
  clock.set("2026-12-02T23:00:00.000Z");
  const rejected = events.append({ type: "investor_events.rejected", loanId: bl!.id, actor: { kind: "external", id: "fnma" }, payload: { type: "EscrowSetup", category: "hazard", attempt: 1, reason: "invalid category" } });
  svc.requeueInvestorEvent(rejected);
  assert.equal(events.ofType("investor_events.queued").length, 1); assert.equal(setup[0]!.status, "armed");
  assert.equal(timers.evaluate("2026-12-03T07:59:00.000Z").length, 0);
  const breaches = timers.evaluate("2026-12-03T08:01:00.000Z");
  assert.equal(breaches.length, 1); assert.equal(breaches[0]!.severity, 2); assert.ok(breaches[0]!.escalateTo.includes("investor-reporting"));
  // "for every escrow category": the tax ack alone does not close it; the hazard ack that completes the set closes it late.
  const tax = svc.recordEscrowSetupAck(bl!.id, "tax");
  assert.deepEqual([tax.every_category, setup[0]!.status], [false, "breached"]);
  const hazard = svc.recordEscrowSetupAck(bl!.id, "hazard");
  assert.deepEqual([hazard.every_category, hazard.acked, setup[0]!.status], [true, ["tax", "hazard"], "satisfied_late"]);
});
test("1.1-T8: Given a money-field hard failure, when the agent proposes a waiver, then the command is refused without an `officer` approval record.", () => {
  const { svc, ext } = boardingHarness("2026-09-17T02:00:00.000Z");
  const loan = stagedLoan(); ext.agree(loan);
  ext.tb.set(loan.transferor_loan_number, cents("245600.00"));                  // trial balance disagrees → HF-003 (money field)
  const [bl] = svc.stage("B1", [loan]); svc.validate("B1");
  assert.equal(bl!.status, "exception");
  const byAgent = svc.proposeWaiver(bl!.id, "HF-003", AGENT, "looks like a rounding difference");
  assert.equal(byAgent.ok, false); if (!byAgent.ok) assert.equal(byAgent.code, "ROLE_DENIED");
  const byAnalyst = svc.proposeWaiver(bl!.id, "HF-003", ANALYST, "transferor confirmed by phone");
  assert.equal(byAnalyst.ok, false); if (!byAnalyst.ok) assert.equal(byAnalyst.code, "ROLE_DENIED");
  assert.equal(bl!.status, "exception"); assert.equal(svc.decisionsFor(bl!.id).length, 0);
  const byOfficer = svc.proposeWaiver(bl!.id, "HF-003", OFFICER, "transferor correction letter received", ["doc-123"]);
  assert.equal(byOfficer.ok, true);
  if (byOfficer.ok) { assert.equal(byOfficer.decision.approved_by, "u-officer"); assert.equal(byOfficer.decision.approved_role, "officer"); assert.deepEqual(byOfficer.decision.evidence_document_ids, ["doc-123"]); }
  assert.equal(bl!.status, "validated"); assert.equal(svc.decisionsFor(bl!.id).length, 1);
  // The same guardrail on the bus: `applyCorrection` refuses every canonical money field (UPB, escrow, suspense, advances, fees, P&I, rate) unless the
  // correction is the transferor's — `provenance=transferor` backed by the correction file / letter; a bare provenance flag is the agent's own word.
  const tool = SECTION_01_TOOLS.find((t) => t.process === "1.1" && t.name === "applyCorrection")!; const g = tool.guardrails![0]!;
  const ctx = (actor: Actor) => ({ actor } as unknown as CommandContext);
  for (const f of ["upb_cents", "escrow_balance_cents", "unapplied_cents", "corporate_advances_cents", "fees_advances_cents", "late_charges_due_cents", "pi_cents", "note_rate_pct", "deferred_principal_cents", "original_upb_cents", "escrow_payment_cents"]) {
    assert.ok((MONEY_FIELDS as readonly string[]).includes(f), f);
    assert.match(g.refuse({ id: "bl-1", changes: { [f]: "1" } }, ctx(AGENT))!, new RegExp(f));
  }
  assert.match(g.refuse({ id: "bl-1", changes: { unapplied_cents: "1" }, provenance: "transferor" }, ctx(AGENT))!, /evidence_document_ids/);   // self-declared provenance, no evidence
  assert.match(g.refuse({ id: "bl-1", changes: { unapplied_cents: "1" } }, ctx(OFFICER))!, /proposeWaiver/);                                  // the officer waives, never keys a money value
  assert.equal(g.refuse({ id: "bl-1", changes: { unapplied_cents: "1" }, provenance: "transferor", evidence_document_ids: ["doc-corr-1"] }, ctx(AGENT)), undefined);
  assert.equal(g.refuse({ id: "bl-1", changes: { borrower: { phone: "+15125550100" } } }, ctx(AGENT)), undefined);   // a non-money field is the agent's to correct
  // And in the service, whoever calls it: a money change is refused without the transferor's evidence; with it, the correction is recorded as the transferor's.
  const byAgentCorr = svc.applyCorrection(bl!.id, { upb_cents: cents("245600.00") }, AGENT, { provenance: "agent", rationale: "make the tape agree with the trial balance" });
  assert.equal(byAgentCorr.ok, false); if (!byAgentCorr.ok) assert.equal(byAgentCorr.code, "MONEY_FIELD_GUARD");
  const noEvidence = svc.applyCorrection(bl!.id, { upb_cents: cents("245600.00") }, AGENT, { provenance: "transferor" });
  assert.equal(noEvidence.ok, false); if (!noEvidence.ok) assert.equal(noEvidence.code, "EVIDENCE_REQUIRED");
  const byOfficerCorr = svc.applyCorrection(bl!.id, { late_charge_pct: "5" }, OFFICER, { provenance: "agent", rationale: "keyed from memory" });
  assert.equal(byOfficerCorr.ok, false); if (!byOfficerCorr.ok) assert.equal(byOfficerCorr.code, "MONEY_FIELD_GUARD");
  assert.equal(bl!.staged.upb_cents, cents("245634.12")); assert.equal(svc.decisionsFor(bl!.id).length, 1);        // nothing moved
  const transferor = svc.applyCorrection(bl!.id, { late_charge_pct: "5" }, AGENT, { provenance: "transferor", evidence_document_ids: ["doc-corr-1"], rationale: "transferor correction file 2026-09-17 row 1" });
  assert.equal(transferor.ok, true);
  if (transferor.ok) { assert.deepEqual(transferor.money_fields, ["late_charge_pct"]); assert.equal(transferor.decision.action, "transferor_corrected"); assert.deepEqual(transferor.decision.evidence_document_ids, ["doc-corr-1"]); assert.equal(transferor.status, "validated"); }
  assert.equal(bl!.staged.late_charge_pct, "5"); assert.equal(svc.decisionsFor(bl!.id).length, 2);
});
test("1.1-T9: Given a property in a state without a Supermortgage servicer license, then `HF-020` fails and the batch report shows it at T-14.", () => {
  const { svc, ext, clock } = boardingHarness("2026-09-17T02:00:00.000Z");      // T-14 for an Oct 1 transfer
  const loan = stagedLoan({ property: { address_line1: "1 Elm", city: "Burlington", state: "VT", postal_code: "05401", occupancy: "owner_occupied" } }); ext.agree(loan);
  svc.ingestTape("B1", "preliminary", "prelim-tape", 1); svc.stage("B1", [loan]);
  const card = svc.validate("B1");
  assert.equal(card.hard["HF-020"], 1); assert.equal(card.generated_at, clock.now()); assert.equal(card.loans.exception, 1);
});
test("1.1-T10: Given a duplicate file upload (same hash), then the second is ignored with an idempotent receipt.", () => {
  const { svc, events } = boardingHarness("2026-09-17T02:00:00.000Z");
  const bytes = new TextEncoder().encode("LOAN,UPB\nTR-1,24563412\n");
  const first = svc.ingestTape("B1", "preliminary", bytes, 1), second = svc.ingestTape("B1", "preliminary", bytes, 1);
  assert.equal(first.status, "accepted"); assert.equal(second.status, "duplicate");
  assert.equal(second.tape_id, first.tape_id); assert.equal(second.sha256, first.sha256);
  assert.equal(events.ofType("transfer.tape.received").length, 1);
});

// 1.1 worked example (HF-005): tape P&I $1,616.03 less scheduled interest $1,304.93 → principal portion $311.10; a history showing $311.11 is a W-014 interest-method review, not a hard fail.
test("1.1 worked example: principal portion $311.10 and expected UPB 24,532,302 cents; $311.11 in history → W-014 review", () => {
  const r = principalPortion(24_563_412n, cents("1616.03"), cents("1304.93"));
  assert.equal(r.principal_portion_cents, cents("311.10"));
  assert.equal(r.expected_upb_after_next_payment_cents, 24_532_302n);
  assert.equal(r.review, null);
  const w = principalPortion(24_563_412n, cents("1616.03"), cents("1304.93"), cents("311.11"));
  assert.equal(w.review, "W-014");
  assert.match(w.review_reason!, /31111 vs computed 31110/);
});

// ---- 1.1 timers not named by a T-id: each armed by the event this process emits and closed by the event the platform emits ----
test("1.1 timers: SM_BOARD_PRELIM_TAPE_14 and SM_BOARD_FINAL_TAPE_1 arm on the 1.2 `transfer.batch.approved` (transfer_date −14 calendar days / +1 servicer business day) and are satisfied by the tapes `readTape` ingests", () => {
  const { svc, events, timers, clock, esc } = boardingHarness("2026-08-20T14:00:00.000Z");
  approveBatch(events, clock, "B1", D("2026-10-01"));
  const prelim = timers.byCode("SM_BOARD_PRELIM_TAPE_14"), fin = timers.byCode("SM_BOARD_FINAL_TAPE_1");
  assert.deepEqual([prelim.length, prelim[0]!.dueDate, prelim[0]!.subject], [1, "2026-09-17", { kind: "transfer_batch", id: "B1" }]);   // Oct 1 − 14 calendar days
  assert.deepEqual([fin.length, fin[0]!.dueDate], [1, "2026-10-02"]);                                                                    // Thu Oct 1 + 1 servicer business day = Fri Oct 2
  clock.set("2026-09-16T12:00:00.000Z");
  svc.ingestTape("B1", "payment_history", "history-bytes", 2);                   // another kind does not close the preliminary-tape clock
  assert.equal(prelim[0]!.status, "armed");
  assert.equal(svc.ingestTape("B1", "preliminary", "prelim-bytes", 2).status, "accepted");
  assert.deepEqual([prelim[0]!.status, fin[0]!.status], ["satisfied", "armed"]);
  assert.equal(events.ofType("transfer.tape.received").find((e) => e.payload.kind === "preliminary")!.payload.transfer_date, "2026-10-01");
  clock.set("2026-10-05T12:00:00.000Z");                                        // Monday: the final tape (close of business T-1, received by T+1) is late
  const breaches = timers.evaluate(clock.now());
  assert.deepEqual(breaches.map((b) => [b.def.code, b.severity, [...b.escalateTo]]), [["SM_BOARD_FINAL_TAPE_1", 1, ["officer"]]]);   // "sev 1; hold cutover; `officer`"
  const out = handleBoardingBreach({ events, esc, svc, timers }, breaches[0]!);
  assert.deepEqual([out.escalation!.ownerRole, esc.opened[0]!.batchId, esc.opened[0]!.severity], ["officer", "B1", "sev-1"]);
  svc.ingestTape("B1", "final", "final-bytes", 2);
  assert.equal(fin[0]!.status, "satisfied_late");
});
test("1.1 timers: SM_BOARD_EXCEPTION_SLA_2 arms once on the hard exception `runValidation` raises (raised_at + 2 servicer business days), survives the nightly re-run, is satisfied by the correction that re-validates the loan, and past due on a money field goes to the officer", () => {
  const { svc, ext, timers, clock, events, esc } = boardingHarness("2026-09-17T14:00:00.000Z");   // Thu Sep 17, 10:00 ET
  const money = stagedLoan({ seq: 1 }); ext.agree(money);
  ext.fnmaRows.set(money.fnma_loan_number!, { ...ext.fnmaRows.get(money.fnma_loan_number!)!, upb_cents: cents("245634.13") });   // transferor's late LAR: position off by a cent → HF-003 (money)
  const tin = stagedLoan({ seq: 2, borrower: { legal_name: "Borrower 2", tin: null, phone: "+15125550100", email: "b2@example.com", preferred_language: "en" } }); ext.agree(tin);   // HF-013 (non-money)
  const [blMoney, blTin] = svc.stage("B1", [money, tin]);
  svc.validate("B1");
  const sla = timers.byCode("SM_BOARD_EXCEPTION_SLA_2");
  assert.deepEqual(sla.map((t) => [t.loanId, t.anchorDate, t.dueDate, t.status]), [[blMoney!.id, "2026-09-17", "2026-09-21", "armed"], [blTin!.id, "2026-09-17", "2026-09-21", "armed"]]);   // Thu + 2 servicer BD = Mon Sep 21
  assert.deepEqual(events.ofType("loan.boarding_exception.raised").map((e) => [e.payload.rule_code, e.payload.severity, e.payload.money_field]), [["HF-003", "hard", true], ["HF-013", "hard", false]]);
  clock.set("2026-09-18T06:00:00.000Z"); svc.validate("B1");                     // the nightly re-run raises nothing new: no second SLA, the first raised_at stands
  assert.equal(events.ofType("loan.boarding_exception.raised").length, 2); assert.equal(timers.byCode("SM_BOARD_EXCEPTION_SLA_2").length, 2);
  // Non-money: the agent corrects it with a decision record; the loan re-validates → `loan.boarding_exception.resolved` → satisfied on time.
  const fix = svc.applyCorrection(blTin!.id, { borrower: { ...tin.borrower, tin: "***-**-5678" } }, AGENT, { provenance: "agent", rationale: "TIN from the transferor's 1098 image", confidence: 0.99, rule_code: "HF-013" });
  assert.equal(fix.ok, true); if (fix.ok) { assert.deepEqual([fix.status, fix.decision.action, fix.decision.confidence, fix.money_fields], ["validated", "agent_corrected", 0.99, []]); }
  assert.equal(events.ofType("loan.boarding_exception.resolved").filter((e) => e.loanId === blTin!.id).length, 1);
  assert.equal(sla[1]!.status, "satisfied");
  // Money: past the SLA → "sev 2 → `officer` if money field".
  clock.set("2026-09-22T14:00:00.000Z");
  const breaches = timers.evaluate(clock.now());
  assert.deepEqual(breaches.map((b) => [b.def.code, b.severity, b.instance.loanId]), [["SM_BOARD_EXCEPTION_SLA_2", 2, blMoney!.id]]);
  const out = handleBoardingBreach({ events, esc, svc, timers }, breaches[0]!);
  assert.deepEqual([out.escalation!.ownerRole, esc.opened[0]!.severity, esc.opened[0]!.loanId], ["officer", "sev-2", blMoney!.id]);
  assert.deepEqual(events.ofType("loan.boarding_exception.escalated")[0]!.payload.money_fields, ["HF-003"]);
  // The agent may not "correct" the UPB into agreement; the transferor's final LAR posts (edge case: hold in `exception` until then) and the run resolves it late.
  const denied = svc.applyCorrection(blMoney!.id, { upb_cents: cents("245634.13") }, AGENT, { provenance: "agent" });
  assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.code, "MONEY_FIELD_GUARD");
  ext.fnmaRows.set(money.fnma_loan_number!, { ...ext.fnmaRows.get(money.fnma_loan_number!)!, upb_cents: cents("245634.12") });
  svc.validate("B1");
  assert.deepEqual([blMoney!.status, sla[0]!.status], ["validated", "satisfied_late"]);
  // An agent-raised hard exception (a defect the rule set cannot see) arms the SLA the same way and outlives the nightly run until it is cured.
  const third = stagedLoan({ seq: 3 }); ext.agree(third); const [bl3] = svc.stage("B1", [third]); svc.validate("B1"); assert.equal(bl3!.status, "validated");
  clock.set("2026-09-23T14:00:00.000Z");
  const raised = svc.raiseException(bl3!.id, { rule_code: "DOC-001", severity: "hard", message: "note image illegible", evidence_document_ids: ["img-9"] }, AGENT);
  assert.deepEqual([raised.status, raised.event.type, raised.event.payload.severity, raised.event.payload.raised_at], ["exception", "loan.boarding_exception.raised", "hard", "2026-09-23T14:00:00.000Z"]);
  const t3 = timers.byCode("SM_BOARD_EXCEPTION_SLA_2").filter((t) => t.loanId === bl3!.id); assert.deepEqual([t3.length, t3[0]!.dueDate], [1, "2026-09-25"]);   // Wed Sep 23 + 2 BD = Fri Sep 25
  svc.validate("B1"); assert.equal(bl3!.status, "exception"); assert.equal(timers.byCode("SM_BOARD_EXCEPTION_SLA_2").filter((t) => t.loanId === bl3!.id).length, 1);
  const cured = svc.applyCorrection(bl3!.id, { custody: { ...third.custody!, enote_evault_ref: null } }, AGENT, { provenance: "agent", rule_code: "DOC-001", rationale: "re-imaged note received from the transferor" });
  assert.equal(cured.ok && cured.status, "validated"); assert.equal(t3[0]!.status, "satisfied");
});
test("1.1 timers: MERS_PROC_REGISTER_UNREGISTERED_7 arms on the `loan.boarded{min is null, mers_eligible=true}` boarding emits (transfer_date + 7 calendar days) and is satisfied by the MERS registration acknowledgment", () => {
  const { svc, ext, timers, clock, events, esc } = boardingHarness("2026-10-01T14:00:00.000Z");
  const unregistered = stagedLoan({ seq: 1, min: null, mers_eligible: true }), registered = stagedLoan({ seq: 2 }), ineligible = stagedLoan({ seq: 3, min: null, mers_eligible: false });
  for (const l of [unregistered, registered, ineligible]) ext.agree(l);
  const [bl] = svc.stage("B1", [unregistered, registered, ineligible]); svc.validate("B1");
  assert.equal(svc.board("B1", { finalTapeReconciled: true }).boarded.length, 3);
  const boarded = events.ofType("loan.boarded").find((e) => e.loanId === bl!.id)!;
  assert.deepEqual([boarded.payload.min, boarded.payload.mers_eligible, boarded.payload.transfer_date], [null, true, "2026-10-01"]);
  const t = timers.byCode("MERS_PROC_REGISTER_UNREGISTERED_7");
  assert.deepEqual([t.length, t[0]!.loanId, t[0]!.dueDate], [1, bl!.id, "2026-10-08"]);   // only the MERS-eligible loan without a MIN; Oct 1 + 7 calendar days
  const newMin = makeMin(SUPERMORTGAGE_ORG_ID, "77");
  clock.set("2026-10-06T14:00:00.000Z");
  const ack = recordMersAcknowledgement(events, "B1", [{ min: newMin, loan_id: bl!.id, txn_type: "registration", effective_date: D("2026-10-06"), submitted_by_org_id: SUPERMORTGAGE_ORG_ID, status: "prepared" }], [{ min: newMin, accepted: true }], D("2026-10-06"));
  assert.deepEqual([ack.accepted, ack.rejected, t[0]!.status], [1, 0, "satisfied"]);
  // A rejected registration leaves the clock open; past Oct 8 it is the transfer agent's ("sev 2 → `transfer` agent; QA log").
  const late = stagedLoan({ seq: 4, min: null, mers_eligible: true, next_due_date: D("2026-11-01") }); ext.agree(late);
  const [bl4] = svc.stage("B1", [late]); svc.validate("B1"); assert.equal(svc.board("B1", { finalTapeReconciled: true }).boarded.length, 1);
  const t4 = timers.byCode("MERS_PROC_REGISTER_UNREGISTERED_7").filter((x) => x.loanId === bl4!.id); assert.equal(t4[0]!.dueDate, "2026-10-08");
  const min4 = makeMin(SUPERMORTGAGE_ORG_ID, "78");
  recordMersAcknowledgement(events, "B1", [{ min: min4, loan_id: bl4!.id, txn_type: "registration", effective_date: D("2026-10-06"), submitted_by_org_id: SUPERMORTGAGE_ORG_ID, status: "prepared" }], [{ min: min4, accepted: false, reason: "Org ID not a Member" }], D("2026-10-06"));
  assert.equal(t4[0]!.status, "armed");
  clock.set("2026-10-09T14:00:00.000Z");
  const breach = timers.evaluate(clock.now()).find((b) => b.def.code === "MERS_PROC_REGISTER_UNREGISTERED_7")!;
  assert.deepEqual([breach.instance.loanId, breach.severity, [...breach.escalateTo]], [bl4!.id, 2, ["transfer"]]);
  const out = handleBoardingBreach({ events, esc, svc, timers }, breach); assert.equal(out.escalation!.ownerRole, "officer");   // no human role in the column: a sev-2 work item for the officer
  recordMersAcknowledgement(events, "B1", [{ min: min4, loan_id: bl4!.id, txn_type: "registration", effective_date: D("2026-10-09"), submitted_by_org_id: SUPERMORTGAGE_ORG_ID, status: "prepared" }], [{ min: min4, accepted: true }], D("2026-10-09"));
  assert.equal(t4[0]!.status, "satisfied_late");
});
test("1.1 timers: SM_BOARD_POST_TRANSFER_MONITOR_180 arms on the `transfer.batch.cutover_completed` boarding emits (transfer_date + 6 months), the Bulletin 2020-02 monthly monitoring report runs against it, and the 1.2 `transfer.batch.closed` satisfies it", () => {
  const { svc, ext, timers, clock, events, esc, registry } = boardingHarness("2026-10-01T14:00:00.000Z");
  const loans = [stagedLoan({ seq: 1 }), stagedLoan({ seq: 2 })]; for (const l of loans) ext.agree(l);
  svc.stage("B1", loans); svc.validate("B1"); assert.equal(svc.board("B1", { finalTapeReconciled: true }).boarded.length, 2);
  const cutover = svc.completeCutover("B1");
  assert.deepEqual([cutover.type, cutover.payload.transfer_date, cutover.payload.boarded_count], ["transfer.batch.cutover_completed", "2026-10-01", 2]);
  const t = timers.byCode("SM_BOARD_POST_TRANSFER_MONITOR_180");
  assert.deepEqual([t.length, t[0]!.dueDate, t[0]!.subject], [1, "2027-04-01", { kind: "transfer_batch", id: "B1" }]);   // 6 × months from Oct 1, 2026
  assert.deepEqual([monthsBetween(D("2026-10-01"), D("2026-11-01")), monthsBetween(D("2026-10-01"), D("2027-03-31")), monthsBetween(D("2026-10-01"), D("2027-04-01"))], [1, 5, 6]);
  const m1 = postTransferMonitoringReport({ events, esc, svc, timers }, "B1", D("2026-11-01"));
  assert.deepEqual([m1.months_since_transfer, m1.loans.boarded, m1.open_hard, m1.breached_timers], [1, 2, {}, []]);
  assert.equal(events.ofType("transfer.post_transfer_monitoring.reported")[0]!.payload.month_n, 1);
  assert.throws(() => postTransferMonitoringReport({ events, esc, svc, timers }, "B1", D("2026-09-30")), RangeError);
  // The six-month de-brief: past Apr 1, 2027 the report goes to the officer with the escalation ("Bulletin 2020-02 4–6-month monitoring report to `officer`").
  clock.set("2027-04-02T14:00:00.000Z");
  const breach = timers.evaluate(clock.now()).find((b) => b.def.code === "SM_BOARD_POST_TRANSFER_MONITOR_180")!;
  assert.deepEqual([...breach.escalateTo], ["officer"]);
  const out = handleBoardingBreach({ events, esc, svc, timers }, breach);
  assert.deepEqual([out.escalation!.ownerRole, out.report!.months_since_transfer, esc.opened[0]!.batchId], ["officer", 6, "B1"]);
  assert.ok(out.report!.breached_timers.some((x) => x.code === "LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1"));   // the de-brief lists the batch's breached loan clocks (unacked Escrow Setup events)
  assert.equal(events.ofType("transfer.post_transfer_monitoring.debrief")[0]!.payload.escalation_id, out.escalation!.id);
  // Satisfaction: `transfer.batch.closed` as the 1.2 batch state machine emits it (TransferBatchService, post_transfer → closed) matches the registry's
  // satisfied pattern for the batch and closes the clock when it reaches this store (late here: the de-brief was due Apr 1). The engine then re-arms the
  // row once — it is `recurring (monthly)` — which is the kernel's recurring rule, not a second monitoring obligation on a closed batch.
  const closed = closedBatchEvent("B1", D("2026-10-01"));
  assert.deepEqual([closed.type, closed.aggregate, closed.payload.transfer_date], ["transfer.batch.closed", { kind: "transfer_batch", id: "B1" }, "2026-10-01"]);
  assert.ok(eventMatches(registry.get("SM_BOARD_POST_TRANSFER_MONITOR_180")!.satisfiedPattern!, closed));
  assert.ok(!eventMatches(registry.get("SM_BOARD_POST_TRANSFER_MONITOR_180")!.satisfiedPattern!, cutover));
  events.append({ type: closed.type, aggregate: closed.aggregate!, actor: closed.actor, payload: closed.payload });
  assert.equal(t[0]!.status, "satisfied_late");
  assert.equal(events.ofType("timer.satisfied").filter((e) => e.payload.code === "SM_BOARD_POST_TRANSFER_MONITOR_180").length, 1);
});
test("1.1 tools: `applyCorrection` and `raiseException` run through the boarding service on the bus — a non-money correction re-validates the loan and closes its SLA, an agent-raised hard exception arms SM_BOARD_EXCEPTION_SLA_2", async () => {
  const { svc, ext, timers, clock, events, esc, ledger } = boardingHarness("2026-09-17T14:00:00.000Z");
  const loan = stagedLoan({ property: { address_line1: null, city: "Austin", state: "TX", postal_code: "78701", occupancy: "owner_occupied" } }); ext.agree(loan);   // HF-014
  const [bl] = svc.stage("B1", [loan]); svc.validate("B1"); assert.equal(bl!.status, "exception");
  const rt = { store: new EntityStore(), escalations: esc, services: { boarding: svc }, ports: {} } as unknown as ToolRuntime;
  const ctx = (actor: Actor) => ({ actor, now: clock.now(), events, ledger, timers, clock, loanId: bl!.id, decide: () => {} } as unknown as CommandContext);
  const apply = SECTION_01_TOOLS.find((t) => t.process === "1.1" && t.name === "applyCorrection")!;
  const r = (await apply.handler({ batch_loan_id: bl!.id, changes: { property: { ...loan.property, address_line1: "1 Main St" } }, rationale: "address from the mortgage image", confidence: 0.98 }, ctx(AGENT), rt)) as CorrectionResult;
  assert.equal(r.ok, true); if (r.ok) assert.deepEqual([r.status, r.decision.action, r.decision.rationale], ["validated", "agent_corrected", "address from the mortgage image"]);
  assert.deepEqual([bl!.status, bl!.staged.property.address_line1, timers.byCode("SM_BOARD_EXCEPTION_SLA_2")[0]!.status], ["validated", "1 Main St", "satisfied"]);
  assert.equal(events.ofType("boarding.correction.applied").length, 1);
  await assert.rejects(async () => apply.handler({ batch_loan_id: bl!.id, changes: { upb_cents: cents("1.00") } }, ctx(AGENT), rt), /MONEY_FIELD_GUARD/);   // the service refuses even past the bus guard
  const raise = SECTION_01_TOOLS.find((t) => t.process === "1.1" && t.name === "raiseException")!;
  clock.set("2026-09-18T14:00:00.000Z");
  const x = (await raise.handler({ batch_loan_id: bl!.id, rule_code: "DOC-002", severity: "hard", reason: "allonge missing from the image set", evidence_document_ids: ["img-2"] }, ctx(AGENT), rt)) as ReturnType<BoardingService["raiseException"]>;
  assert.deepEqual([x.status, x.event.type, x.event.payload.raised_at, x.validation.code], ["exception", "loan.boarding_exception.raised", "2026-09-18T14:00:00.000Z", "DOC-002"]);
  const sla = timers.byCode("SM_BOARD_EXCEPTION_SLA_2"); assert.deepEqual([sla.length, sla[1]!.dueDate], [2, "2026-09-22"]);   // Fri Sep 18 + 2 servicer BD = Tue Sep 22
  assert.equal(svc.board("B1", { finalTapeReconciled: true }).boarded.length, 0);   // an open hard failure never boards
});
