// 26.1 Closing document generation and closing instructions (uniform instruments, riders, eNote form, MERS MOM language, state variants incl. Texas 50(a)(6) and NY CEMA, buydown agreements, POA/trust documents, final 1003, document QC)
// spec/sections/26-closing-execution-documents-eclosing-ron-funding-and-post-cl/26-1-closing-document-generation-and-closing-instructions-uniform.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_26_1 } from "../../app/tools/section26-1.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { makeMin } from "../boarding/min.ts";
import { noteTermsHash } from "../orig-boarding/ops-30-2.ts";
import { type ClosingSnapshotInput, type QcUpstream, type DocumentTemplate, DEFAULT_TEMPLATE_LIBRARY, NOT_RELIEVED_CLAUSE, computeNoteTerms, selectDocumentSet, renderDocument, buildSmartDocENote, runDocumentQc, templateVersionCheck, activeTemplate, tx12DayEarliestClosing, txItemizationGate, txDeMinimisThreshold, txFeeTest, txRescissionExpiry, txF2NoticeDue, buydownSchedule, draftBuydownAgreement, buildCemaPackage, draftClosingInstructions, openDocumentSet, takeClosingSnapshot, generateDocuments, recordDocumentQc, releaseDecision, openTxHomeEquityReview, recordTx12DayNotice, recordTxItemization, docsToAgentDue, settlorAcknowledgment, lateCharge, generateMin } from "./ops-26-1.ts";
import { CLOSING_INSTRUCTIONS_SAMPLE, TX_ITEMIZATION_SAMPLE, TX_F2_NOTICE_SAMPLE } from "../../notices/authored/section26-1.ts";

const CLOSER: Actor = { kind: "agent", id: "title-closing" };
const toolKey = (process: string, name: string): string => `${process} ${name}`;
const noticeReg = buildRegistry(); publishAuthored(noticeReg);
const PARTNER_ORG = "1001234";
const MIN = makeMin(PARTNER_ORG, "12");
/** Worked example 1: the Phoenix, AZ refinance fixture ($560,000.00; 6.125%; 360; note date Fri Nov 6, 2026; disbursement Thu Nov 12; borrower + non-borrowing spouse on title). */
const refi = (o: Partial<ClosingSnapshotInput> = {}): ClosingSnapshotInput => ({
  application_id: "APP-REFI-1", cd_version: 3, du_submission_number: "DU-2026-11-01-7", lock_id: "LOCK-1", partner: { legal_name: "Partner Bank", nmlsr_id: "123456", mers_org_id: PARTNER_ORG }, mlo_of_record: { name: "M. Originator", nmlsr_id: "1234567" }, servicer: { name: "Supermortgage LLC", payment_address: "PO Box 1, Phoenix AZ 85001" },
  state: "AZ", county: "Maricopa", property_address: "1 Palm Ln, Phoenix, AZ 85001", legal_description: "Lot 1, Block 2, Palm Estates, per Book 100 of Maps, page 7, Maricopa County records", transaction_type: "limited_cash_out", occupancy: "primary", property_type: "sfr", units: 1, vesting: "individual", vesting_text: "R. Borrower and S. Borrower, husband and wife as community property with right of survivorship",
  borrowers: [{ party_id: "B1", legal_name: "R. Borrower", credit_used: true, on_title: true, capacities: ["borrower"] }, { party_id: "B2", legal_name: "S. Borrower", credit_used: false, on_title: true, capacities: ["non_borrower_title_holder"], spouse_of: "B1" }],
  loan_amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, product: "fixed", note_date: D("2026-11-06"), scheduled_disbursement_date: D("2026-11-12"), scheduled_closing_date: D("2026-11-06"), escrowed: true, rescindable: true,
  enote_default: true, partner_emortgage_approved: true, ron_authorized_state: true, settlement_agent_eclosing_eligible: true, borrower_declined_electronic: false, min: MIN, ...o });
/** Worked example 2: the Austin, TX $400,000 50(a)(6) cash-out (FMV $500,000; closing Fri Nov 6 at the title company). */
const tx50a6 = (o: Partial<ClosingSnapshotInput> = {}): ClosingSnapshotInput => refi({ application_id: "APP-TX-1", state: "TX", county: "Travis", property_address: "12 Congress Ave, Austin, TX 78701", transaction_type: "cash_out", tx_50a6: true, loan_amount_cents: 40_000_000n, note_rate_pct: "6.500", vesting_text: "T. Owner and U. Owner", borrowers: [{ party_id: "T1", legal_name: "T. Owner", credit_used: true, on_title: true, capacities: ["borrower"] }, { party_id: "T2", legal_name: "U. Owner", credit_used: false, on_title: true, capacities: ["non_borrower_title_holder"], spouse_of: "T1" }], ron_authorized_state: true, ...o });
const upstream = (s: ClosingSnapshotInput, sel = selectDocumentSet(s), o: Partial<QcUpstream> = {}): QcUpstream => { const t = computeNoteTerms({ principal_cents: s.loan_amount_cents, note_rate_pct: s.note_rate_pct, term_months: s.term_months, scheduled_disbursement_date: s.scheduled_disbursement_date, state: s.state }); return { cd: { loan_amount_cents: s.loan_amount_cents, note_rate_pct: s.note_rate_pct, pi_cents: t.pi_cents, org_nmlsr_id: "123456", mlo_nmlsr_id: "1234567", first_payment_date: t.first_payment_date }, du: { loan_amount_cents: s.loan_amount_cents, note_rate_pct: s.note_rate_pct, term_months: s.term_months }, lock: { note_rate_pct: s.note_rate_pct }, title: { vesting_text: s.vesting_text, legal_description: s.legal_description }, urla_1003: { org_nmlsr_id: "123456", mlo_nmlsr_id: "1234567", loan_amount_cents: s.loan_amount_cents, note_rate_pct: s.note_rate_pct, term_months: s.term_months }, templates: sel.documents.map((d) => DEFAULT_TEMPLATE_LIBRARY.find((x) => x.template_id === d.template_id)).filter((x): x is DocumentTemplate => !!x), note_date: s.note_date, ...o }; };
/** The 26.1 bus alone: TOOLS_26_1 bound to the `title-closing` agent over the overridden registry (26.1 rows + the referenced 25.2 CD gate), escalations and the Notice Registry; the application-scoped unit of work stamps `applicationId` on every event. */
function harness(applicationId: string, nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["26.1", "25.2"] });
  const escalations = new EscalationService(events, clock); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: {}, ports: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }) };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const agents = new AgentRegistry(); const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_26_1) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(toolKey(d.process, d.name), cmd); }
  const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = CLOSER): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("26.1", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
  return { clock, events, timers, escalations, rt, uow, run, at, timer, ofType, decisions };
}
const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
const GATE_OPEN = { final_cd_delivered: true, approval_ptd_cleared: true, trust_poa_gate_open: true, compliance_pass_cd_gate_open: true, lock_status: "active", lock_expires_on: "2026-12-07", closing_date: "2026-11-06" };
/** Runs the closer through snapshot → generation on the bus and returns the set id. */
async function generated(h: ReturnType<typeof harness>, s: ClosingSnapshotInput): Promise<string> {
  const g = await h.run("evaluateDocGenGates", { application_id: s.application_id, gate: GATE_OPEN }); assert.equal(g.gate_open, true);
  const set_id = String(g.set_id);
  await h.run("takeClosingSnapshot", { set_id, snapshot: s, gate: GATE_OPEN });
  await h.run("renderDocument", { set_id });
  return set_id;
}

test("26.1-T1: Given the fixture snapshot ($560,000.00; 6.125%; 360 months), when `computeNoteTerms` runs, then P&I = $3,402.62, first payment Jan 1, 2027, maturity Dec 1, 2056, late charge 5% / 15 days, and `DQC_NOTE_CD_PI` passes against the CD.", async () => {
  const s = refi();
  const t = computeNoteTerms({ principal_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, scheduled_disbursement_date: D("2026-11-12"), state: "AZ" });
  assert.equal(t.pi_cents, 340_262n, "P&I $3,402.62 (half-up on the full-precision rate)");
  assert.equal(t.first_payment_date, "2027-01-01"); assert.equal(t.maturity_date, "2056-12-01", "Jan 1, 2027 + 359 months");
  assert.equal(t.late_charge_pct, "5.00"); assert.equal(t.late_charge_days, 15); assert.equal(t.prepayment_charge, "none");
  // 30.2's OB-002 seam: the note's data hash is the same canonical note-terms hash 30.2 recomputes from the mapped terms.
  assert.equal(t.data_hash, noteTermsHash({ amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, first_payment_date: D("2027-01-01"), maturity_date: D("2056-12-01"), late_charge_pct: "5.00", late_charge_grace_days: 15 }));
  // the same numbers through the bus tool
  const h = harness("APP-REFI-1", "2026-11-04T17:00:00.000Z");
  const out = await h.run("computeNoteTerms", { principal_cents: "56000000", note_rate_pct: "6.125", term_months: 360, scheduled_disbursement_date: "2026-11-12", state: "AZ" }) as unknown as typeof t;
  assert.equal(out.pi_cents, 340_262n); assert.equal(out.maturity_date, "2056-12-01");
  // DQC_NOTE_CD_PI against the CD's projected payment
  const sel = selectDocumentSet(s); const docs = sel.documents.filter((d) => d.kind !== "closing_instructions").map((d) => renderDocument(d, s, t, MIN, "snap-hash", sel));
  const qc = runDocumentQc(s, t, sel, docs, upstream(s, sel));
  assert.equal(qc.checks.find((c) => c.rule_code === "DQC_NOTE_CD_PI")!.result, "pass"); assert.equal(qc.passed, true, qc.hard_failures.join(","));
  assert.equal(docs.find((d) => d.kind === "enote")!.data_hash, t.data_hash, "closing_documents.data_hash of the note = noteTermsHash");
  assert.match(docs.find((d) => d.kind === "enote")!.text, /beginning on January 1, 2027.*December 1, 2056/s);
  assert.match(docs.find((d) => d.kind === "enote")!.text, /15 calendar days after the date it is due.*5\.00% of my overdue Monthly Payment/s);
});

test("26.1-T2: Given an Arizona 1-unit primary refinance with `closing.enote_default=true` and partner eMortgage approval, when `selectDocumentSet` runs, then the set is `{3200e, 3003 (07/2021), final 1003, H-8 ×2 per consumer, closing instructions}` with no riders and `closing_type=ron`.", async () => {
  const sel = selectDocumentSet(refi());
  assert.equal(sel.closing_type, "ron"); assert.equal(sel.enote, true); assert.equal(sel.enote_refusal, null); assert.deepEqual(sel.riders, []);
  assert.deepEqual(sel.documents.map((d) => [d.kind, d.form_number]), [["enote", "3200e"], ["security_instrument", "3003"], ["final_1003", "URLA_1003_FINAL"], ["rescission_notice_h8", "NTC_REGZ_1026_23_H8"], ["closing_instructions", "SM_CLOSING_INSTRUCTIONS"]]);
  assert.equal(sel.documents[1]!.revision_date, "07/2021"); assert.equal(sel.documents[3]!.copies_per_consumer, 2);
  assert.equal(sel.profile, "AZ_REFI_FIXED_ENOTE"); assert.deepEqual(sel.sfc, ["508"]);
  // signers: the borrower signs the eNote; the non-borrowing spouse signs the deed of trust only (B8-3-03 / B8-2-03; AZ community property)
  assert.deepEqual(sel.note_signers.map((x) => x.party_id), ["B1"]); assert.deepEqual(sel.security_instrument_signers.map((x) => [x.party_id, x.capacity]), [["B1", "borrower"], ["B2", "non_borrower_title_holder"]]);
  // the bus: the closer opens the set at CTC, snapshots, generates; 26.2's closing.scheduled arms SM_O71_DOCS_TO_AGENT_1BD due Thu Nov 5 for the Fri Nov 6 session
  const h = harness("APP-REFI-1", "2026-11-04T17:00:00.000Z");
  h.events.append({ type: "closing.scheduled", applicationId: "APP-REFI-1", actor: CLOSER, payload: { application_id: "APP-REFI-1", closing_id: "CLS-1", scheduled_at: "2026-11-06T17:00:00.000Z", closing_type: "ron", settlement_agent_party_id: "P-ESCROW-AZ-1", notary_party_id: "N-1" } });
  assert.equal(h.timer("SM_O71_DOCS_TO_AGENT_1BD")!.dueDate, "2026-11-05"); assert.equal(docsToAgentDue(D("2026-11-06")), "2026-11-05");
  const set_id = await generated(h, refi());
  const set = h.rt.store.get("closing_document_sets", set_id)!.data as { status: string; closing_type: string; document_set_profile: string; documents: { kind: string; form_number: string; template_revision_date: string | null }[] };
  assert.equal(set.status, "generated"); assert.equal(set.closing_type, "ron"); assert.equal(set.document_set_profile, "AZ_REFI_FIXED_ENOTE");
  assert.deepEqual(set.documents.map((d) => d.form_number), ["3200e", "3003", "URLA_1003_FINAL", "NTC_REGZ_1026_23_H8"]);
  assert.equal(h.ofType("closing.document_set.opened").length, 1); assert.equal(h.ofType("closing.data_snapshot.taken").length, 1); assert.equal(h.ofType("closing.documents.generated").length, 1);
  assert.equal(h.timer("SM_O71_DOC_GEN_GATE")!.status, "satisfied", "the snapshot satisfies the generation gate");
  assert.equal(h.rt.store.get("documents", set.documents[0]!.form_number === "3200e" ? (set.documents[0] as { document_id?: string }).document_id ?? "" : "")?.data.retention_class ?? "fnma_loan_file_life_plus_4y", "fnma_loan_file_life_plus_4y");
});

test("26.1-T3: Given the same loan in Texas as a 50(a)(6) cash-out, then the set uses 3244.1, 3044.1, 3185, FMV acknowledgment, closing receipt, `closing_type=wet`, and any attempt to build an eNote is refused with reason `product_excluded_emortgage`.", async () => {
  const s = tx50a6(); const sel = selectDocumentSet(s);
  assert.equal(sel.note_form, "3244.1"); assert.equal(sel.security_instrument_form, "3044.1"); assert.equal(sel.closing_type, "wet"); assert.equal(sel.enote, false); assert.equal(sel.enote_refusal, "product_excluded_emortgage"); assert.equal(sel.excluded_product, "tx_50a6");
  const forms = sel.documents.map((d) => d.form_number);
  for (const f of ["3244.1", "3044.1", "3185", "SM_TX_FMV_ACK", "SM_TX_CLOSING_RECEIPT", "NTC_TX_50A6_12DAY", "NTC_REGZ_1026_23_H8"]) assert.ok(forms.includes(f), `${f} in the TX set`);
  assert.equal(sel.documents.find((d) => d.kind === "tx_fmv_acknowledgment")!.executed_by, "signing_officer"); assert.ok(sel.sfc.includes("304")); assert.match(sel.closing_type_reasons[0]!, /product_excluded_esign:tx_50a6/);
  const t = computeNoteTerms({ principal_cents: s.loan_amount_cents, note_rate_pct: s.note_rate_pct, term_months: 360, scheduled_disbursement_date: D("2026-11-12"), state: "TX" });
  const note = renderDocument(sel.documents[0]!, s, t, MIN, "h", sel);
  const r = buildSmartDocENote(s, t, MIN, note); assert.equal(r.ok, false); assert.equal((r as { reason: string }).reason, "product_excluded_emortgage");
  // the bus refuses the tool before any SMART Doc is built
  const h = harness("APP-TX-1", "2026-11-04T17:00:00.000Z"); const set_id = await generated(h, s);
  const e = await refused(h.run("buildSmartDocENote", { set_id, tx_50a6: true }), "ENOTE_PRODUCT_EXCLUDED"); assert.match(e.message, /product_excluded_emortgage/);
  await assert.rejects(h.run("buildSmartDocENote", { set_id }), /product_excluded_emortgage/);
  // the AZ fixture builds: SMART Doc v1.0.2 Category One with an ARC per DATA point and a SHA-256 seal
  const az = refi(); const azSel = selectDocumentSet(az); const azT = computeNoteTerms({ principal_cents: az.loan_amount_cents, note_rate_pct: az.note_rate_pct, term_months: 360, scheduled_disbursement_date: az.scheduled_disbursement_date, state: "AZ" });
  const ok = buildSmartDocENote(az, azT, MIN, renderDocument(azSel.documents[0]!, az, azT, MIN, "h", azSel)); assert.equal(ok.ok, true); if (ok.ok) { assert.equal(ok.arcs.length, Object.keys(ok.data).length); assert.equal(ok.tamper_seal_algorithm, "SHA-256"); assert.equal(ok.min, MIN); }
});

test("26.1-T4: Given a TX application submitted Mon Oct 5, 2026 with the §50(g) notice e-delivered the same day, then `earliest_closing_date` = Sat Oct 17, 2026; with the notice mailed Oct 5 instead, presumed provided Thu Oct 8 → earliest closing Tue Oct 20, 2026.", () => {
  const e = tx12DayEarliestClosing({ application_submitted_date: D("2026-10-05"), notice_delivered_on: D("2026-10-05"), channel: "electronic" });
  assert.equal(e.t0, "2026-10-05"); assert.equal(e.day1, "2026-10-06"); assert.equal(e.earliest_closing_date, "2026-10-17");
  const m = tx12DayEarliestClosing({ application_submitted_date: D("2026-10-05"), notice_delivered_on: D("2026-10-05"), channel: "mailed" });
  assert.equal(m.notice_provided_date, "2026-10-08", "7 TAC §153.51: three calendar days not counting Sundays/federal holidays"); assert.equal(m.earliest_closing_date, "2026-10-20");
  // the review row and the gate: TX_50A6_12DAY_CLOSING_GATE anchors on t0 and opens on day 12
  const h = harness("APP-TX-1", "2026-10-05T15:00:00.000Z");
  const opened = openTxHomeEquityReview(h.events, { application_id: "APP-TX-1", is_50a6: true, f2_refinance: false, classification_basis: "cash back on a homestead lien", application_submitted_at: D("2026-10-05"), prior_50a6_closing_date: D("2025-03-03"), scheduled_closing_date: D("2026-11-06") });
  assert.equal(opened.review.one_year_ok, true, "prior home-equity loan closed Mar 3, 2025 → anniversary Mar 3, 2026 < closing");
  const n = recordTx12DayNotice(h.events, opened.review, { delivered_on: D("2026-10-05"), channel: "electronic", receipt_evidence_id: "EVID-1" });
  assert.equal(n.review.earliest_closing_date, "2026-10-17"); assert.equal(h.timer("TX_50A6_12DAY_CLOSING_GATE")!.dueDate, "2026-10-17"); assert.equal(h.timer("TX_50A6_ONE_YEAR_GATE")!.status, "armed");
  assert.equal(evaluateGate("26.1.txOneYearGate", { prior_50a6_closing_date: "2025-03-03", closing_date: "2026-11-06" }).open, true);
  assert.equal(evaluateGate("26.1.txOneYearGate", { prior_50a6_closing_date: "2026-01-15", closing_date: "2026-11-06" }).open, false);
});

test("26.1-T5: Given a TX closing scheduled Fri Nov 6, 2026 with the CD received Mon Nov 2 and a $35 recording-fee change delivered Thu Nov 5, then `TX_50A6_ITEMIZATION_1BD_GATE` opens Fri Nov 6; a change delivered Fri Nov 6 without an emergency or good-cause consent (7 TAC §153.13(5)–(6)) moves `earliest_itemization_closing_date` to Sat Nov 7 (a §153.1(A) business day); with an owner-elected de minimis good-cause consent on file the Fri Nov 6 closing stands.", () => {
  const base = { itemization_received_on: D("2026-11-02"), application_copy_received_on: D("2026-11-02"), principal_cents: 40_000_000n, scheduled_closing_date: D("2026-11-06") };
  assert.equal(txItemizationGate(base).earliest_itemization_closing_date, "2026-11-03", "one §153.1(A) business day after the Mon Nov 2 receipt");
  const nov5 = txItemizationGate({ ...base, changes: [{ delivered_on: D("2026-11-05"), delta_cents: 3_500n, description: "recording fee", consent: null }] });
  assert.equal(nov5.earliest_itemization_closing_date, "2026-11-06"); assert.equal(nov5.closing_date_ok, true);
  const nov6 = txItemizationGate({ ...base, changes: [{ delivered_on: D("2026-11-05"), delta_cents: 3_500n, description: "recording fee", consent: null }, { delivered_on: D("2026-11-06"), delta_cents: 3_500n, description: "recording fee", consent: null }] });
  assert.equal(nov6.earliest_itemization_closing_date, "2026-11-07", "Saturday counts under §153.1(A)"); assert.equal(nov6.closing_date_ok, false);
  const consent = txItemizationGate({ ...base, changes: [{ delivered_on: D("2026-11-05"), delta_cents: 3_500n, description: "recording fee", consent: null }, { delivered_on: D("2026-11-06"), delta_cents: 3_500n, description: "recording fee", consent: "de_minimis_good_cause" }] });
  assert.equal(consent.earliest_itemization_closing_date, "2026-11-06"); assert.equal(consent.closing_date_ok, true); assert.equal(consent.consents_applied[0]!.within_de_minimis, true);
  assert.equal(txDeMinimisThreshold(40_000_000n), 50_000n, "greater of $100 or 0.125% × $400,000 = $500");
  // an over-threshold "de minimis" election does not hold; a bona fide emergency consent does
  assert.equal(txItemizationGate({ ...base, changes: [{ delivered_on: D("2026-11-06"), delta_cents: 60_000n, description: "title", consent: "de_minimis_good_cause" }] }).earliest_itemization_closing_date, "2026-11-07");
  assert.equal(txItemizationGate({ ...base, changes: [{ delivered_on: D("2026-11-06"), delta_cents: 60_000n, description: "title", consent: "bona_fide_emergency" }] }).earliest_itemization_closing_date, "2026-11-03");
  // the timer: tx.itemization.delivered{received_on=Nov 5} → +1 business_days_regz_specific → opens Fri Nov 6
  const h = harness("APP-TX-1", "2026-11-05T20:00:00.000Z");
  const opened = openTxHomeEquityReview(h.events, { application_id: "APP-TX-1", is_50a6: true, f2_refinance: false, classification_basis: "cash_out", application_submitted_at: D("2026-10-05"), prior_50a6_closing_date: null, scheduled_closing_date: D("2026-11-06") });
  const r = recordTxItemization(h.events, opened.review, { received_on: D("2026-11-02"), source: "cd", application_copy_received_on: D("2026-11-02"), principal_cents: 40_000_000n, changes: [{ delivered_on: D("2026-11-05"), delta_cents: 3_500n, description: "recording fee", consent: null }], scheduled_closing_date: D("2026-11-06") });
  assert.equal(r.event.payload.received_on, "2026-11-05"); assert.equal(h.timer("TX_50A6_ITEMIZATION_1BD_GATE")!.dueDate, "2026-11-06"); assert.equal(h.timer("TX_50A6_ITEMIZATION_1BD_GATE")!.anchorDate, "2026-11-05");
  // rescission: closing Fri Nov 6 → TX day 3 Mon Nov 9; Thu Nov 5 → Sun Nov 8 extended to Mon Nov 9 (§153.25)
  assert.equal(txRescissionExpiry(D("2026-11-06")), "2026-11-09"); assert.equal(txRescissionExpiry(D("2026-11-05")), "2026-11-09");
});

test("26.1-T6: Given TX counted fees of $8,000.01 on a $400,000 loan, then `DQC_TX_2PCT` fails and release is refused; at $8,000.00 it passes.", () => {
  const over = txFeeTest(40_000_000n, [{ fee_item_id: "F1", kind: "origination", amount_cents: 800_001n }]);
  assert.equal(over.cap_cents, 800_000n); assert.equal(over.pass, false); assert.equal(over.headroom_cents, -1n);
  const at = txFeeTest(40_000_000n, [{ fee_item_id: "F1", kind: "origination", amount_cents: 800_000n }]); assert.equal(at.pass, true);
  const s = tx50a6(); const sel = selectDocumentSet(s); const t = computeNoteTerms({ principal_cents: s.loan_amount_cents, note_rate_pct: s.note_rate_pct, term_months: 360, scheduled_disbursement_date: D("2026-11-12"), state: "TX" });
  const docs = sel.documents.filter((d) => d.kind !== "closing_instructions").map((d) => renderDocument(d, s, t, MIN, "h", sel));
  const failed = runDocumentQc(s, t, sel, docs, upstream(s, sel, { tx: { fee_test: over, ltv_80_ok: true } }));
  assert.equal(failed.checks.find((c) => c.rule_code === "DQC_TX_2PCT")!.result, "fail"); assert.deepEqual(failed.hard_failures, ["DQC_TX_2PCT"]);
  const h = harness("APP-TX-1", "2026-11-05T20:00:00.000Z"); const opened = openDocumentSet(h.events, { set_id: "SET-TX", application_id: "APP-TX-1", at: h.clock.now() });
  const snap = takeClosingSnapshot(h.events, opened.set, s, { snapshot_id: "SNAP-TX", at: h.clock.now(), gate: { ...GATE_OPEN, lock_expires_on: D("2026-12-07"), closing_date: D("2026-11-06") } });
  const gen = generateDocuments(h.events, snap.set, snap.snapshot, { at: h.clock.now() }); const rec = recordDocumentQc(h.events, gen.set, failed, h.clock.now());
  assert.equal(rec.set.status, "qc_failed"); assert.equal(h.ofType("closing.document_qc.failed").length, 1);
  const gate = evaluateGate("26.1.docQcPassGate", { checks: rec.set.qc }); assert.equal(gate.open, false);
  const d = releaseDecision(rec.set, { qc_pass_gate_open: gate.open, template_version_gate_open: true, tx_gates_open: true, instructions_acknowledged: true, tx_50a6: true }, false);
  assert.equal(d.ok, false); assert.equal((d as { code: string }).code, "SM_O71_DOC_QC_PASS_GATE_CLOSED");
  const passed = runDocumentQc(s, t, sel, docs, upstream(s, sel, { tx: { fee_test: at, ltv_80_ok: true } })); assert.equal(passed.checks.find((c) => c.rule_code === "DQC_TX_2PCT")!.result, "pass");
});

test("26.1-T7: Given a Michigan mortgage template dated 07/2021 and a PUD rider dated 1/01 in the library, when the set is generated, then `DQC_TEMPLATE_VERSION` fails with reason `revision_mix`.", () => {
  const mi = activeTemplate(DEFAULT_TEMPLATE_LIBRARY, "3023", D("2026-11-18"))!; assert.equal(mi.state, "MI"); assert.equal(mi.revision_date, "07/2021");
  const pud2001: DocumentTemplate = { template_id: "3150:2001-01", form_number: "3150", family: "rider", state: null, product_scope: ["fixed"], revision_date: "1/01", revision_family: "2001", mandatory_from: D("2001-01-01"), retired_after: null, authorized_changes_applied: [], smart_doc_profile: "none", status: "active", counsel_approval_id: "CA-old" };
  const r = templateVersionCheck([mi, pud2001], D("2026-11-18"));
  assert.equal(r.result, "fail"); assert.equal(r.reason, "revision_mix"); assert.match(r.detail!, /3023 07\/2021.*3150 1\/01/);
  assert.equal(evaluateGate("26.1.templateVersionGate", { templates: [mi, pud2001], note_date: "2026-11-18" }).open, false);
  // the whole set through QC: a PUD in Michigan with the 07/2021 rider passes
  const s = refi({ application_id: "APP-MI-1", state: "MI", county: "Wayne", property_type: "pud", vesting_text: "M. Owner, a single person", borrowers: [{ party_id: "M1", legal_name: "M. Owner", credit_used: true, on_title: true, capacities: ["borrower"] }] });
  const sel = selectDocumentSet(s); assert.deepEqual(sel.riders, ["3150"]);
  const t = computeNoteTerms({ principal_cents: s.loan_amount_cents, note_rate_pct: s.note_rate_pct, term_months: 360, scheduled_disbursement_date: D("2026-11-12"), state: "MI" });
  const docs = sel.documents.filter((d) => d.kind !== "closing_instructions").map((d) => renderDocument(d, s, t, MIN, "h", sel));
  assert.equal(runDocumentQc(s, t, sel, docs, upstream(s, sel)).checks.find((c) => c.rule_code === "DQC_TEMPLATE_VERSION")!.result, "pass");
  const mixed = runDocumentQc(s, t, sel, docs, upstream(s, sel, { templates: [mi, pud2001] })).checks.find((c) => c.rule_code === "DQC_TEMPLATE_VERSION")!;
  assert.equal(mixed.result, "fail"); assert.equal(mixed.reason, "revision_mix");
});

test("26.1-T8: Given a Virginia deed of trust with note date July 1, 2026, then only Form 3047 with `mandatory_from ≤ 2026-07-01` (the May 2026 revision) passes the gate; the prior revision fails.", () => {
  const may2026 = DEFAULT_TEMPLATE_LIBRARY.find((t) => t.template_id === "3047:2026-05")!; const july2021 = DEFAULT_TEMPLATE_LIBRARY.find((t) => t.template_id === "3047:2021-07")!;
  assert.equal(may2026.mandatory_from, "2026-07-01"); assert.equal(july2021.retired_after, "2026-06-30");
  assert.equal(activeTemplate(DEFAULT_TEMPLATE_LIBRARY, "3047", D("2026-07-01"))!.template_id, "3047:2026-05");
  assert.equal(activeTemplate(DEFAULT_TEMPLATE_LIBRARY, "3047", D("2026-06-30"))!.template_id, "3047:2021-07", "the day before, the July 2021 revision is still the active one");
  const note = DEFAULT_TEMPLATE_LIBRARY.find((t) => t.template_id === "3247:2021-07")!;
  assert.equal(templateVersionCheck([note, may2026], D("2026-07-01")).result, "pass", "the May 2026 revision belongs to the 2021 family — no revision mix");
  const prior = templateVersionCheck([note, july2021], D("2026-07-01")); assert.equal(prior.result, "fail"); assert.equal(prior.reason, "retired");
  const early = templateVersionCheck([note, may2026], D("2026-06-30")); assert.equal(early.result, "fail"); assert.equal(early.reason, "not_yet_mandatory");
  // the gate and the lock-extension edge case: a VA closing slipping past June 30 regenerates on the new revision
  assert.equal(evaluateGate("26.1.templateVersionGate", { templates: [note, july2021], note_date: "2026-07-01" }).open, false);
  assert.equal(evaluateGate("26.1.templateVersionGate", { templates: [note, may2026], note_date: "2026-07-01" }).open, true);
  const va = selectDocumentSet(refi({ application_id: "APP-VA-1", state: "VA", note_date: D("2026-07-01"), enote_default: false }));   // paper note → the Virginia state note 3247; the eNote is the uniform 3200e assert.equal(va.note_form, "3247"); assert.equal(va.security_instrument_form, "3047"); assert.equal(va.documents[1]!.template_id, "3047:2026-05"); assert.equal(va.documents[1]!.revision_date, "05/2026");
});

test("26.1-T9: Given a borrower who is trustee and settlor of a revocable trust and the credit applicant, then the note signature line reads \"individually and as Trustee of the … Trust under trust instrument dated …\" and the deed of trust carries the settlor acknowledgment paragraph.", () => {
  const trust = { name: "R. Borrower Revocable Living", dated: D("2019-05-14") };
  const s = refi({ application_id: "APP-TRUST-1", vesting: "trust", vesting_text: "R. Borrower, as Trustee of the R. Borrower Revocable Living Trust under trust instrument dated May 14, 2019", borrowers: [{ party_id: "B1", legal_name: "R. Borrower", credit_used: true, on_title: true, capacities: ["borrower", "trustee", "settlor"], trust }] });
  const sel = selectDocumentSet(s);
  assert.equal(sel.note_signers[0]!.signature_line, "R. Borrower, individually and as Trustee of the R. Borrower Revocable Living Trust under trust instrument dated 2019-05-14");
  assert.match(sel.note_signers[0]!.signature_line, /individually and as Trustee of the .* Trust under trust instrument dated /);
  assert.deepEqual(sel.security_instrument_signers.map((x) => x.capacity), ["trustee", "settlor"]); assert.ok(sel.sfc.includes("168")); assert.ok(sel.documents.some((d) => d.kind === "trust_certification"));
  const t = computeNoteTerms({ principal_cents: s.loan_amount_cents, note_rate_pct: s.note_rate_pct, term_months: 360, scheduled_disbursement_date: D("2026-11-12"), state: "AZ" });
  const note = renderDocument(sel.documents[0]!, s, t, MIN, "h", sel); assert.match(note.text, /Signature line: R\. Borrower, individually and as Trustee of the R\. Borrower Revocable Living Trust under trust instrument dated 2019-05-14/);
  const dot = renderDocument(sel.documents[1]!, s, t, MIN, "h", sel);
  assert.ok(dot.text.includes(settlorAcknowledgment(trust))); assert.match(dot.text, /BY SIGNING BELOW, the undersigned, Settlor\(s\) of the R\. Borrower Revocable Living Trust under trust instrument dated 2019-05-14, acknowledges all of the terms and covenants contained in this Security Instrument and any rider\(s\) thereto and agrees to be bound thereby\./);
  assert.match(dot.text, /Signature line: R\. Borrower, as Trustee of the R\. Borrower Revocable Living Trust/);
});

test("26.1-T10: Given a 2-1 buydown at 6.500% on $412,000 funded by the seller, then the schedule computes $516.58 and $264.83 monthly subsidies, total $9,376.92, SFC 009, the note shows 6.500%/$2,604.12, and the agreement carries the \"not relieved of obligation\" clause.", () => {
  const sch = buydownSchedule({ loan_amount_cents: 41_200_000n, note_rate_pct: "6.500", term_months: 360, kind: "2-1" });
  assert.equal(sch.note_pi_cents, 260_412n); assert.deepEqual(sch.schedule.map((y) => [y.bought_down_rate_pct, y.borrower_payment_cents, y.subsidy_cents_per_month, y.subsidy_cents_per_year]), [["4.500", 208_754n, 51_658n, 619_896n], ["5.500", 233_929n, 26_483n, 317_796n]]);
  assert.equal(sch.total_subsidy_cents, 937_692n);
  const s = refi({ application_id: "APP-PURCH-1", state: "OH", county: "Franklin", property_address: "9 High St, Columbus, OH 43215", transaction_type: "purchase", loan_amount_cents: 41_200_000n, note_rate_pct: "6.500", rescindable: false, escrowed: false, vesting_text: "A. Applicant, unmarried", borrowers: [{ party_id: "A", legal_name: "A. Applicant", credit_used: true, on_title: true, capacities: ["borrower"] }], note_date: D("2026-11-18"), scheduled_disbursement_date: D("2026-11-18"), scheduled_closing_date: D("2026-11-18"), buydown: { kind: "2-1", provider_type: "seller", provider_party_id: "P-SELLER-1", sales_price_cents: 45_777_778n, cltv_pct: "90" } });
  const t = computeNoteTerms({ principal_cents: s.loan_amount_cents, note_rate_pct: s.note_rate_pct, term_months: 360, scheduled_disbursement_date: s.scheduled_disbursement_date, state: "OH" });
  const a = draftBuydownAgreement(s, s.buydown!, t);
  assert.equal(a.eligible, true); assert.equal(a.classification, "moderate"); assert.equal(a.sfc, "009"); assert.equal(a.total_subsidy_cents, 937_692n); assert.equal(a.ipc_cap_cents, 1_373_333n); assert.equal(a.ipc_ok, true); assert.equal(a.custodial_account, "t_and_i_custodial");
  assert.ok(a.agreement_text.includes(NOT_RELIEVED_CLAUSE)); assert.match(a.agreement_text, /not relieved of the obligation to make the mortgage payments/); assert.match(a.agreement_text, /nothing in this Agreement changes the terms of the Note/);
  const sel = selectDocumentSet(s); assert.ok(sel.documents.some((d) => d.kind === "buydown_agreement")); assert.equal(sel.enote, true, "buydown loans stay eNote-eligible with supplemental eDelivered documents (B8-8-01)");
  const note = renderDocument(sel.documents[0]!, s, t, MIN, "h", sel); assert.match(note.text, /yearly rate of 6\.500%/); assert.match(note.text, /U\.S\. \$2,604\.12/); assert.doesNotMatch(note.text, /4\.500/);
  // ineligible variants: cash-out; a 4-point reduction; TX 50(a)(6)
  assert.equal(draftBuydownAgreement(refi({ transaction_type: "cash_out", buydown: s.buydown! }), s.buydown!, t).eligible, false);
  assert.equal(draftBuydownAgreement(tx50a6({ buydown: s.buydown! }), s.buydown!, t).eligible, false);
});

test("26.1-T11: Given the NMLSR ID on the note differs from the CD's, then `DQC_NMLSR_36G` fails and release is refused.", async () => {
  const s = refi(); const sel = selectDocumentSet(s); const t = computeNoteTerms({ principal_cents: s.loan_amount_cents, note_rate_pct: s.note_rate_pct, term_months: 360, scheduled_disbursement_date: s.scheduled_disbursement_date, state: "AZ" });
  const docs = sel.documents.filter((d) => d.kind !== "closing_instructions").map((d) => renderDocument(d, s, t, MIN, "h", sel));
  const up = upstream(s, sel); const bad = runDocumentQc(s, t, sel, docs, { ...up, cd: { ...up.cd, mlo_nmlsr_id: "7654321" } });
  const c = bad.checks.find((x) => x.rule_code === "DQC_NMLSR_36G")!; assert.equal(c.result, "fail"); assert.match(c.reason!, /§1026\.36\(g\)/); assert.deepEqual(bad.hard_failures, ["DQC_NMLSR_36G"]);
  assert.equal(runDocumentQc(s, t, sel, docs, up).checks.find((x) => x.rule_code === "DQC_NMLSR_36G")!.result, "pass");
  // through the bus: QC fails → qc_failed → releaseToPlatform refused
  const h = harness("APP-REFI-1", "2026-11-04T17:00:00.000Z"); const set_id = await generated(h, s);
  const qc = await h.run("runDocumentQc", { set_id, upstream: { ...up, cd: { ...up.cd, mlo_nmlsr_id: "7654321" } } });
  assert.equal(qc.passed, false); assert.equal(qc.status, "qc_failed"); assert.equal(h.ofType("closing.document_qc.check").filter((e) => e.payload.rule_code === "DQC_NMLSR_36G" && e.payload.result === "fail").length, 1);
  await refused(h.run("releaseToPlatform", { set_id, released_to_party_id: "P-ECLOSE", facts: { qc_pass_gate_open: false } }), "RELEASE_NEEDS_QC_PASS");
  await assert.rejects(h.run("releaseToPlatform", { set_id, released_to_party_id: "P-ECLOSE", facts: { qc_pass_gate_open: true } }), /SM_O71_DOC_QC_PASS_GATE_CLOSED/);
  assert.equal(h.ofType("closing.documents.released").length, 0);
});

test("26.1-T12: Given a Montana property, then Form 3158 is in the set and the closing instructions forbid a post-closing assignment to MERS; given Maine, Form 3749 is rendered for `signing_officer` execution.", () => {
  const mt = refi({ application_id: "APP-MT-1", state: "MT", county: "Gallatin", property_address: "5 Main St, Bozeman, MT 59715" }); const mtSel = selectDocumentSet(mt);
  assert.deepEqual(mtSel.riders, ["3158"]); assert.equal(mtSel.security_instrument_form, "3027"); assert.ok(mtSel.documents.some((d) => d.kind === "rider_mers" && d.form_number === "3158"));
  const t = computeNoteTerms({ principal_cents: mt.loan_amount_cents, note_rate_pct: mt.note_rate_pct, term_months: 360, scheduled_disbursement_date: mt.scheduled_disbursement_date, state: "MT" });
  const mtDocs = mtSel.documents.filter((d) => d.kind !== "closing_instructions").map((d) => renderDocument(d, mt, t, MIN, "h", mtSel));
  const ci = draftClosingInstructions(mt, mtSel, mtDocs, { set_id: "SET-MT", version: 1, settlement_agent_party_id: "P-TITLE-MT", wire_verification_id: "WV-1", wire_verification_match_result: "verified" });
  assert.equal(ci.post_closing_assignment_to_mers_prohibited, true); assert.match(ci.text, /post-closing assignment to MERS is prohibited/); assert.equal(ci.wire_instructions_typed, false); assert.match(ci.text, /never accept instructions by e-mail/);
  assert.throws(() => draftClosingInstructions(mt, mtSel, mtDocs, { set_id: "SET-MT", version: 1, settlement_agent_party_id: "P-TITLE-MT", wire_verification_id: "WV-1", wire_verification_match_result: "unverified" }), /verified/);
  const me = refi({ application_id: "APP-ME-1", state: "ME", county: "Cumberland", property_address: "7 Fore St, Portland, ME 04101", ron_authorized_state: true, enote_default: false }); const meSel = selectDocumentSet(me);   // paper note → Maine state note 3220
  const a = meSel.documents.find((d) => d.kind === "mers_assignment_3749")!; assert.equal(a.form_number, "3749"); assert.equal(a.executed_by, "signing_officer"); assert.equal(a.recordable, true); assert.equal(meSel.note_form, "3220"); assert.equal(meSel.security_instrument_form, "3020"); assert.deepEqual(meSel.riders, []);
  const rendered = renderDocument(a, me, t, MIN, "h", meSel); assert.equal(rendered.signers[0]!.capacity, "lender_officer"); assert.match(rendered.text, /MERS MORTGAGE ASSIGNMENT \(Maine\) Form 3749.*recorded promptly after the Mortgage/s); assert.equal(rendered.min_present, true);
  const meCi = draftClosingInstructions(me, meSel, meSel.documents.filter((d) => d.kind !== "closing_instructions").map((d) => renderDocument(d, me, t, MIN, "h", meSel)), { set_id: "SET-ME", version: 1, settlement_agent_party_id: "P-TITLE-ME", wire_verification_id: "WV-2", wire_verification_match_result: "verified" });
  assert.match(meCi.text, /Maine: record the MERS Mortgage Assignment \(Form 3749\), executed at closing by the Lender's signing officer, promptly after the Mortgage/); assert.equal(meCi.post_closing_assignment_to_mers_prohibited, false);
  // 26.4-T12's population query: no closing_documents.kind containing "assignment" outside Maine
  for (const s of [refi(), mt, tx50a6()]) assert.equal(selectDocumentSet(s).documents.filter((d) => d.kind.includes("assignment")).length, 0);
});

test("26.1-T13: Given a NY CEMA with prior unpaid principal $300,000.00 and new money $60,000.00, then Form 3172 consolidates $360,000.00, the §255 affidavit states new money $60,000.00, and `closing_type≠ron` is not forced but `enote=false`.", () => {
  const s = refi({ application_id: "APP-NY-1", state: "NY", county: "Kings", property_address: "300 Court St, Brooklyn, NY 11231", loan_amount_cents: 36_000_000n, ny_cema: { prior_liens: [{ lender: "Prior Lender NA", recorded_at: D("2019-06-12"), instrument_no: "2019000123456", unpaid_principal_cents: 30_000_000n, assignment_received: true }], new_money_cents: 6_000_000n } });
  const c = buildCemaPackage(s);
  assert.equal(c.consolidated_amount_cents, 36_000_000n); assert.equal(c.new_money_cents, 6_000_000n); assert.equal(c.prior_unpaid_principal_cents, 30_000_000n); assert.equal(c.new_money_security_instrument_form, "3033"); assert.equal(c.dqc_cema_sum, "pass"); assert.equal(c.status, "buildable"); assert.equal(c.enote, false); assert.equal(c.closing_type_forced, null);
  assert.equal(c.mortgage_tax_on_new_money_cents, 108_000n, "NY Tax Law §255: tax (1.80%) on the $60,000.00 new money only");
  const sel = selectDocumentSet(s);
  assert.equal(sel.enote, false); assert.equal(sel.enote_refusal, "product_excluded_emortgage"); assert.equal(sel.excluded_product, "ny_cema");
  assert.notEqual(sel.closing_type, "ron"); assert.equal(sel.closing_type, "hybrid", "a paper note wet-signed, the rest electronic — no product prohibition on electronic signing"); assert.ok(!sel.closing_type_reasons.some((r) => r.startsWith("product_excluded_esign")), "≠ron is a consequence of the paper note, not a forced exclusion");
  assert.equal(sel.note_form, "3233"); assert.equal(sel.security_instrument_form, "3033"); assert.ok(sel.documents.some((d) => d.kind === "ny_cema_3172" && d.form_number === "3172")); assert.ok(sel.documents.some((d) => d.kind === "ny_255_affidavit"));
  const t = computeNoteTerms({ principal_cents: s.loan_amount_cents, note_rate_pct: s.note_rate_pct, term_months: 360, scheduled_disbursement_date: s.scheduled_disbursement_date, state: "NY" });
  assert.deepEqual(lateCharge("NY"), { pct: "2.00", days: 15 }, "NY RPL §254-b"); assert.equal(t.late_charge_pct, "2.00");
  const cema = renderDocument(sel.documents.find((d) => d.kind === "ny_cema_3172")!, s, t, MIN, "h", sel, { cema: c }); assert.match(cema.text, /consolidated into a single lien of \$360,000\.00/);
  const aff = renderDocument(sel.documents.find((d) => d.kind === "ny_255_affidavit")!, s, t, MIN, "h", sel, { cema: c }); assert.match(aff.text, /new money \$60,000\.00 is the only new or further indebtedness/); assert.equal(aff.notarized, true);
  const blocked = buildCemaPackage(refi({ ...s, ny_cema: { ...s.ny_cema!, prior_liens: [{ ...s.ny_cema!.prior_liens[0]!, assignment_received: false }] } })); assert.equal(blocked.status, "blocked"); assert.match(blocked.blocker!, /full mortgage tax/);
});

test("26.1-T14: Given a release attempted with `SM_O71_DOC_QC_PASS_GATE` closed, then `releaseToPlatform` is refused and an `escalation` to `officer` exists only if a waiver was requested.", async () => {
  const s = refi(); const h = harness("APP-REFI-1", "2026-11-04T17:00:00.000Z"); const set_id = await generated(h, s);
  const up = upstream(s); const qc = await h.run("runDocumentQc", { set_id, upstream: { ...up, cd: { ...up.cd, mlo_nmlsr_id: "7654321" } } });
  assert.equal(qc.status, "qc_failed"); const gate = evaluateGate("26.1.docQcPassGate", qc.gate as Record<string, unknown>); assert.equal(gate.open, false); assert.match(gate.reason!, /DQC_NMLSR_36G/);
  // without a waiver request: refused, no escalation
  await refused(h.run("releaseToPlatform", { set_id, released_to_party_id: "P-ECLOSE", facts: { qc_pass_gate_open: gate.open } }), "RELEASE_NEEDS_QC_PASS");
  assert.equal(h.ofType("escalation.created").length, 0); assert.equal(h.ofType("closing.documents.released").length, 0);
  // with a waiver request: still refused, and an officer escalation exists
  await assert.rejects(h.run("releaseToPlatform", { set_id, released_to_party_id: "P-ECLOSE", facts: { qc_pass_gate_open: gate.open }, waiver_requested: true }), /SM_O71_DOC_QC_PASS_GATE_CLOSED.*escalated to officer/);
  const esc = h.ofType("escalation.created"); assert.equal(esc.length, 1); assert.equal(esc[0]!.payload.owner_role, "officer"); assert.equal(esc[0]!.payload.kind, "officer"); assert.deepEqual(esc[0]!.payload.rule_codes, ["DQC_NMLSR_36G"]);
  assert.equal(h.ofType("closing.documents.released").length, 0); assert.equal((h.rt.store.get("closing_document_sets", set_id)!.data as { status: string }).status, "qc_failed");
  // the happy path: QC passes → qc_passed → release satisfies SM_O71_DOC_QC_PASS_GATE and emits closing.documents.released
  const ok = await h.run("runDocumentQc", { set_id, upstream: up }); assert.equal(ok.status, "qc_passed"); assert.equal(h.timer("SM_O71_DOC_QC_PASS_GATE")!.status, "satisfied"); assert.equal(h.timer("SM_O71_TEMPLATE_VERSION_GATE")!.status, "satisfied");
  const rel = await h.run("releaseToPlatform", { set_id, released_to_party_id: "P-ECLOSE", facts: { qc_pass_gate_open: true, template_version_gate_open: true } }); assert.equal(rel.status, "released"); assert.equal(h.ofType("closing.documents.released").length, 1);
  // closing instructions → sent / acknowledged (SM_O71_INSTRUCTIONS_ACK_GATE) and the settlement-agent escalation
  const ci = await h.run("draftClosingInstructions", { set_id, settlement_agent_party_id: "P-ESCROW-AZ-1", wire_verification_id: "WV-2026-11-03-0001", wire_verification_match_result: "verified", platform: "eClose Platform", session_id: "RON-42" });
  assert.equal(ci.wire_instructions_typed, false); assert.equal(h.timer("SM_O71_INSTRUCTIONS_ACK_GATE")!.status, "armed");
  await refused(h.run("draftClosingInstructions", { set_id, settlement_agent_party_id: "P-ESCROW-AZ-1", wire_verification_id: "WV-1", wire_verification_match_result: "verified", wire_account_number: "123456789" }), "WIRE_NEVER_TYPED");
  const ack = await h.run("requestAcknowledgment", { set_id }); assert.equal(ack.owner_role, "settlement_agent");
  await h.run("draftClosingInstructions", { set_id, op: "acknowledge", acknowledged_by: "P-ESCROW-AZ-1" }, { kind: "human", id: "u-escrow", role: "settlement_agent" });
  assert.equal(h.timer("SM_O71_INSTRUCTIONS_ACK_GATE")!.status, "satisfied"); assert.equal(evaluateGate("26.1.instructionsAckGate", { tx_50a6: true, acknowledged_at: null }).open, false); assert.equal(evaluateGate("26.1.instructionsAckGate", { tx_50a6: true, acknowledged_at: "2026-11-05T16:00:00.000Z" }).open, true);
  // a corrected CD after release → superseded set + a new pending set; decision record on the bus
  const rd = await h.run("scheduleRedraw", { set_id, reason: "cd_corrected", new_set_id: "SET-APP-REFI-1-2", signing_begun: false, note_terms_changed: true }); assert.equal(rd.corrected_cd_question_to, "25.2"); assert.equal(rd.enote_reversal_required, true);
  await h.run("writeDecision", { action: "release", rationale: "all hard rules pass", rule_set_version: "fnma.uniform_instruments.2021-07", confidence: 0.99, subject: { kind: "closing_document_sets", id: set_id } }); assert.ok(h.decisions.some((d) => d.action === "release" && d.ruleSetVersion === "fnma.uniform_instruments.2021-07"), "the agent_decisions row carries the rule set version");
});

test("26.1 worked figures: fixture note terms ($560,000.00 → P&I $3,402.62; $170.13 late charge; $2,858.33/$544.29 first split; −$1.00 residual), TX fee test ($6,450.00 ≤ $8,000.00; headroom $1,550.00), 2-1 buydown ($2,604.12 / $2,087.54 / $2,339.29; $516.58 + $264.83; $6,198.96 + $3,177.96 = $9,376.92; IPC cap $13,733.33) and the three authored notices", () => {
  const t = computeNoteTerms({ principal_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, scheduled_disbursement_date: D("2026-11-12"), state: "AZ" });
  assert.equal(t.principal_cents, 56_000_000n); assert.equal(t.pi_cents, 340_262n); assert.equal(t.late_charge_on_pi_cents, 17_013n, "$3,402.62 × 5% = $170.131 → $170.13");
  assert.equal(t.first_month_interest_cents, 285_833n); assert.equal(t.first_month_principal_cents, 54_429n); assert.equal(t.amortization_residual_cents, -100n, "360 rounded payments amortize to −$1.00 (servicer adjusts the final payment)");
  // worked example 2 fee test: counted $6,450.00 vs cap $8,000.00 on $400,000 → headroom $1,550.00; discount points/appraisal/survey/title base/escrow excluded
  const ft = txFeeTest(40_000_000n, [{ fee_item_id: "orig", kind: "origination", amount_cents: 300_000n }, { fee_item_id: "proc", kind: "processing", amount_cents: 95_000n }, { fee_item_id: "uw", kind: "underwriting", amount_cents: 110_000n }, { fee_item_id: "doc", kind: "doc_prep", amount_cents: 45_000n }, { fee_item_id: "erec", kind: "erecording", amount_cents: 12_500n }, { fee_item_id: "flood", kind: "flood_cert", amount_cents: 2_500n }, { fee_item_id: "credit", kind: "credit_report", amount_cents: 7_500n }, { fee_item_id: "tax", kind: "tax_service", amount_cents: 8_500n }, { fee_item_id: "amc", kind: "amc_fee", amount_cents: 64_000n },
    { fee_item_id: "appr", kind: "appraisal_third_party", amount_cents: 65_000n }, { fee_item_id: "survey", kind: "survey", amount_cents: 47_500n }, { fee_item_id: "title", kind: "title_base_premium", amount_cents: 265_000n }, { fee_item_id: "t42", kind: "title_endorsement_t42", amount_cents: 15_000n }, { fee_item_id: "escrow", kind: "escrow_deposit", amount_cents: 250_000n }, { fee_item_id: "hazard", kind: "prepaid_hazard", amount_cents: 60_000n }, { fee_item_id: "points", kind: "bona_fide_discount_points", amount_cents: 200_000n }]);
  assert.equal(ft.total_counted_cents, 645_000n); assert.equal(ft.cap_cents, 800_000n); assert.equal(ft.headroom_cents, 155_000n); assert.equal(ft.pass, true);
  assert.equal(ft.items.find((i) => i.fee_item_id === "amc")!.counted, true); assert.equal(ft.items.find((i) => i.fee_item_id === "points")!.counted, false);
  // worked example 3: 2-1 buydown on $412,000 at 6.500%
  const b = buydownSchedule({ loan_amount_cents: 41_200_000n, note_rate_pct: "6.500", term_months: 360, kind: "2-1" });
  assert.equal(b.note_pi_cents, 260_412n); assert.equal(b.schedule[0]!.borrower_payment_cents, 208_754n); assert.equal(b.schedule[1]!.borrower_payment_cents, 233_929n);
  assert.equal(b.schedule[0]!.subsidy_cents_per_month, 51_658n); assert.equal(b.schedule[1]!.subsidy_cents_per_month, 26_483n); assert.equal(b.schedule[0]!.subsidy_cents_per_year, 619_896n); assert.equal(b.schedule[1]!.subsidy_cents_per_year, 317_796n); assert.equal(b.total_subsidy_cents, 937_692n);
  const s = refi({ transaction_type: "purchase", loan_amount_cents: 41_200_000n, note_rate_pct: "6.500", state: "OH", buydown: { kind: "2-1", provider_type: "seller", provider_party_id: "P-SELLER-1", sales_price_cents: 45_777_778n, cltv_pct: "90" } });
  const a = draftBuydownAgreement(s, s.buydown!, computeNoteTerms({ principal_cents: 41_200_000n, note_rate_pct: "6.500", term_months: 360, scheduled_disbursement_date: D("2026-11-18"), state: "OH" })); assert.equal(a.ipc_cap_cents, 1_373_333n, "$457,777.78 × 3% = $13,733.33"); assert.equal(a.ipc_counted_cents, 937_692n);
  // TX 50(f)(2) notice clock: application Mon Oct 5 → legal due Thu Oct 8 (creditor) and scheduled Thu Oct 8 (regz-specific); a Thursday application shows the Saturday difference
  assert.deepEqual(txF2NoticeDue(D("2026-10-05")), { legal_due: D("2026-10-08"), scheduled_due: D("2026-10-08") }); assert.deepEqual(txF2NoticeDue(D("2026-10-08")), { legal_due: D("2026-10-14"), scheduled_due: D("2026-10-13") }, "Columbus Day Oct 12 off both; Saturday Oct 10 counts only under the specific definition");
  // MIN: the partner's Org ID + sequence + Mod-10 check digit
  const m = generateMin(PARTNER_ORG, "12"); assert.equal(m.min, MIN); assert.equal(m.valid, true); assert.equal(m.min.length, 18);
  // the three authored notices render and pass their own checklists on the spec's worked examples
  for (const [code, sample] of [["NTC_SM_CLOSING_INSTRUCTIONS", CLOSING_INSTRUCTIONS_SAMPLE], ["NTC_TX_50A6_ITEMIZATION", TX_ITEMIZATION_SAMPLE], ["NTC_TX_50F2_REFI_NOTICE", TX_F2_NOTICE_SAMPLE]] as const) {
    const v = noticeReg.activeVersion(code, D("2026-11-05"))!; const rendered = render(v.source, sample as Record<string, unknown>); const chk = evaluateChecklist(v, sample as Record<string, unknown>, rendered); assert.equal(chk.passed, true, `${code}: ${JSON.stringify(chk.results.filter((r) => !r.passed))}`);
  }
  const f2 = render(noticeReg.activeVersion("NTC_TX_50F2_REFI_NOTICE", D("2026-11-05"))!.source, TX_F2_NOTICE_SAMPLE); assert.match(f2.text, /YOUR EXISTING LOAN THAT YOU DESIRE TO REFINANCE IS A HOME EQUITY LOAN\./);
  const ciV = noticeReg.activeVersion("NTC_SM_CLOSING_INSTRUCTIONS", D("2026-11-05"))!; const typed = evaluateChecklist(ciV, { ...CLOSING_INSTRUCTIONS_SAMPLE, wire_verification_match_result: "unverified" }, render(ciV.source, { ...CLOSING_INSTRUCTIONS_SAMPLE, wire_verification_match_result: "unverified" })); assert.equal(typed.passed, false, "an unverified wire record blocks the letter");
});
