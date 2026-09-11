// 22.1 Document intake, classification, extraction, integrity/freshness checks, and the borrower needs-list loop
// spec/sections/22-documents-credit-income-assets-liabilities-identity-and-frau/22-1-document-intake-classification-extraction-integrity-freshnes.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_22_1, applyRetentionOnFunded, applyRetentionOnWithdrawal } from "../../app/tools/section22-1.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry } from "../../notices/catalog.ts";
import { publishCheck } from "../../notices/checklist.ts";
import { VERSIONS_22_1 } from "../../notices/authored/section22-1.ts";
import {
  DocumentGateClosed, arithmeticCheck, assertGateOpen, bps, computeFreshness, creditDocsGate, paystubFloor, paystubFloorForApplication, paystubGate, paystubRequestText, requestSchedule, reviewDue, taxYearGate, taxYearRequirement, withdrawalRetention, withholdingTolerance,
  MEDICARE_RATE_BPS, type DocumentRecord, type DocumentRequest,
} from "./ops-22-1.ts";

const AGENT: Actor = { kind: "agent", id: "verification" };
const APP = "app-refi-1", LOAN = "L-REFI-1", B1 = "borrower-1";
const RECIPIENTS = [{ partyId: "B1", name: "Alex Fixture", mailingAddress: "4120 N 44th St, Phoenix AZ 85018", email: "alex@example.com" }];
const PARTY = { borrower_names: ["Alex Fixture"], partner_name: "Partner Bank, N.A.", mlo_name: "Jordan Originator", mlo_nmlsr_id: "1234567", upload_url: "https://borrower.partnerbank.example/upload", human_contact: "Jordan Originator at (602) 555-0142" };
/** Creditor time (Phoenix: MST all year, UTC−7). */
const mst = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/Phoenix"));
/** The registry with only 22.1's versions published (the whole authored set is published by src/notices/notices.test.ts). */
const noticeReg = buildRegistry(); for (const v of VERSIONS_22_1) noticeReg.publish(v.templateCode, v.version, "counsel", "2026-09-01T00:00:00.000Z", publishCheck);
/** Refinance fixture: application Mon Oct 5, 2026; closing scheduled Fri Nov 6, 2026 (note date); disbursement Thu Nov 12, 2026. */
const NOTE_DATE = "2026-11-06", APPLICATION_DATE = "2026-10-05";

/** The 22.1 tools on the bus over the overridden registry (22.1 rows only), the escalation service and the Notice Registry; the harness appends the upstream events (21.1 / 21.2 / 26.x / 23.1) with origination context. */
function harness(nowIso: string, o: { noteDate?: string | null; leDelivered?: boolean } = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId: APP });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["22.1"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId: LOAN, applicationId: APP, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }) };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_22_1); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("22.1", name))!, actor, { application_id: APP, ...input }, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === APP);
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt = clock.now(), actor: Actor = { kind: "agent", id: "closing" }) => events.append({ type, applicationId: APP, aggregate: { kind: "application", id: APP }, actor, occurredAt, payload: { application_id: APP, ...payload } });
  rt.store.put("applications", APP, { id: APP, application_date: APPLICATION_DATE, transaction: "refinance" }, AGENT, nowIso);
  if (o.noteDate !== null) upstream("closing.scheduled", { scheduled_note_date: o.noteDate ?? NOTE_DATE, scheduled_disbursement_date: "2026-11-12" }, mst("2026-10-06", "09:00"));
  if (o.leDelivered !== false) upstream("disclosure.le.delivered", { disclosure_id: "le-1", le_version: 1, channel: "esign_portal", delivered_at: mst("2026-10-05", "16:10") }, mst("2026-10-05", "16:10"), { kind: "agent", id: "disclosure" });
  const doc = (id: string): DocumentRecord => rt.store.require("documents", id).data as unknown as DocumentRecord;
  const request = (id: string): DocumentRequest => rt.store.require("document_requests", id).data as unknown as DocumentRequest;
  const requests = (): DocumentRequest[] => rt.store.list("document_requests").map((r) => r.data as unknown as DocumentRequest);
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  /** Upload → classify → extract (one document) with the fixture's scheduled note date. */
  const intake = async (id: string, doc_class: string, fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    await run("ingestDocument", { document_id: id, source_channel: "borrower_upload", sha256: `sha-${id}`, subject_borrower_id: B1, applicant_borrower_ids: [B1], page_count: 2, ...extra });
    await run("classifyDocument", { document_id: id, doc_class, confidence: 0.98 });
    return run("extractFields", { document_id: id, fields, extraction_id: `x-${id}` });
  };
  return { rt, uow, events, ledger, timers, run, at, timer, ofType, upstream, doc, request, requests, refused, intake, decisions, clock };
}

test("22.1-T1: (four-month gate, refinance fixture) Given scheduled note date Fri Nov 6, 2026 and a bank statement with `period_end` Jun 30, 2026, when freshness is computed, then `expires_at = Oct 30, 2026`, `freshness_status = expired`, and `assertGateOpen('FNMA_B1_1_03_CREDIT_DOCS_4M')` fails for any decision relying on it; a statement with `period_end` Jul 31, 2026 yields `expires_at = Nov 30, 2026` and `fresh`.", async () => {
  const june = computeFreshness({ doc_class: "bank_statement", document_date: D("2026-06-30"), scheduled_note_date: D(NOTE_DATE) });
  assert.equal(june.basis, "b1_1_03_4m"); assert.equal(june.expires_at, "2026-10-30"); assert.equal(june.status, "expired");
  const july = computeFreshness({ doc_class: "bank_statement", document_date: D("2026-07-31"), scheduled_note_date: D(NOTE_DATE) });
  assert.equal(july.expires_at, "2026-11-30"); assert.equal(july.status, "fresh");
  // R2: Nov 6 note date → a document dated on or after Mon Jul 6, 2026 is fresh (add_months(Jul 6, 4) = Nov 6 ≥ Nov 6).
  assert.equal(computeFreshness({ doc_class: "bank_statement", document_date: D("2026-07-06"), scheduled_note_date: D(NOTE_DATE) }).status, "fresh");
  assert.equal(computeFreshness({ doc_class: "bank_statement", document_date: D("2026-07-05"), scheduled_note_date: D(NOTE_DATE) }).status, "expired");
  // assertGateOpen refuses any decision that relies on the June statement.
  const relying = { scheduled_note_date: NOTE_DATE, relied_documents: [{ document_id: "stmt-jun", doc_class: "bank_statement", document_date: "2026-06-30", account_last4: "1234" }] };
  assert.throws(() => assertGateOpen(APP, "FNMA_B1_1_03_CREDIT_DOCS_4M", relying), (e: unknown) => e instanceof DocumentGateClosed && e.code === "FNMA_B1_1_03_CREDIT_DOCS_4M" && /expired 2026-10-30/.test(e.reason));
  assert.equal(evaluateGate("22.1.creditDocs4m", relying).open, false);
  assert.doesNotThrow(() => assertGateOpen(APP, "FNMA_B1_1_03_CREDIT_DOCS_4M", { scheduled_note_date: NOTE_DATE, relied_documents: [{ document_id: "stmt-jul", doc_class: "bank_statement", document_date: "2026-07-31", account_last4: "1234" }] }));
  // Through the bus: the extracted June statement arms the gate (evaluator-backed) and the 14-day warning anchored on expires_at; computeFreshness{op=gate} refuses.
  const h = harness(mst("2026-10-07", "10:00"));
  const x = await h.intake("stmt-jun", "bank_statement", { institution: "Desert Credit Union", account_last4: "1234", period_start: "2026-06-01", period_end: "2026-06-30", opening_balance_cents: "1000000", ending_balance_cents: "1000000", transactions: [] });
  assert.equal(x.expires_at, "2026-10-30"); assert.equal(x.freshness_status, "expired");
  assert.equal(h.doc("stmt-jun").freshness_status, "expired");
  assert.equal(h.timer("FNMA_B1_1_03_CREDIT_DOCS_4M")!.note, "evaluator:22.1.creditDocs4m");
  const warn = h.timer("SM_DOC_EXPIRY_WARN_14")!; assert.equal(warn.anchorDate, "2026-10-30"); assert.equal(warn.dueDate, "2026-10-16");
  const r = await h.refused(h.run("computeFreshness", { op: "gate", gate: "FNMA_B1_1_03_CREDIT_DOCS_4M" }), "FNMA_B1_1_03_CREDIT_DOCS_4M");
  assert.match(r.citation, /B1-1-03/);
  await h.intake("stmt-jul", "bank_statement", { institution: "Desert Credit Union", account_last4: "1234", period_start: "2026-07-01", period_end: "2026-07-31", opening_balance_cents: "1000000", ending_balance_cents: "1000000", transactions: [] });
  assert.equal(h.doc("stmt-jul").expires_at, "2026-11-30"); assert.equal(h.doc("stmt-jul").freshness_status, "fresh");
  const g = await h.run("computeFreshness", { op: "gate", gate: "FNMA_B1_1_03_CREDIT_DOCS_4M" }); assert.equal(g.open, true);
});

test("22.1-T2: (consecutive statements rule) Given July and August 2026 statements in the file and note date Dec 7, 2026, when the gate is evaluated, then only the August statement (`expires_at = Dec 31, 2026`) is tested and the gate is open even though the July statement expired Nov 30.", () => {
  const g = creditDocsGate({ scheduled_note_date: D("2026-12-07"), relied_documents: [
    { document_id: "stmt-jul", doc_class: "bank_statement", document_date: D("2026-07-31"), subject_borrower_id: B1, account_last4: "1234" },
    { document_id: "stmt-aug", doc_class: "bank_statement", document_date: D("2026-08-31"), subject_borrower_id: B1, account_last4: "1234" }] });
  assert.equal(g.open, true);
  assert.equal(g.threshold_date, "2026-08-07");                                   // R2: closing slips to Mon Dec 7 → threshold Fri Aug 7, 2026
  assert.deepEqual(g.tested.map((t) => t.document_id), ["stmt-aug"]);
  assert.equal(g.tested[0]!.expires_at, "2026-12-31"); assert.equal(g.tested[0]!.status, "fresh");
  assert.deepEqual(g.not_tested_superseded, ["stmt-jul"]);
  assert.equal(computeFreshness({ doc_class: "bank_statement", document_date: D("2026-07-31"), scheduled_note_date: D("2026-12-07") }).status, "expired");   // Nov 30 < Dec 7
  // The July statement alone would close the gate against Dec 7 — the most recent statement in the file is the one tested.
  assert.equal(creditDocsGate({ scheduled_note_date: D("2026-12-07"), relied_documents: [{ document_id: "stmt-jul", doc_class: "bank_statement", document_date: D("2026-07-31"), account_last4: "1234" }] }).open, false);
  assert.equal(evaluateGate("22.1.creditDocs4m", { scheduled_note_date: "2026-12-07", relied_documents: [{ document_id: "stmt-jul", doc_class: "bank_statement", document_date: "2026-07-31", account_last4: "1234" }, { document_id: "stmt-aug", doc_class: "bank_statement", document_date: "2026-08-31", account_last4: "1234" }] }).open, true);
  // SM_DOC_EXPIRY_WARN_14 for the July statement fires Nov 16 (14 days before Nov 30).
  assert.equal(computeFreshness({ doc_class: "bank_statement", document_date: D("2026-07-31"), scheduled_note_date: D("2026-12-07") }).warn_on, "2026-11-16");
});

test("22.1-T3: (paystub floor) Given initial application date Mon Oct 5, 2026, when a paystub with pay date Fri Sept 4, 2026 is classified, then `FNMA_B3_3_2_01_PAYSTUB_30D_GATE` is not satisfied and a request for \"most recent paystub (dated on/after Sept 5, 2026) with year-to-date earnings\" is opened; a paystub dated Fri Oct 2, 2026 with YTD satisfies it.", async () => {
  assert.equal(paystubFloor(D(APPLICATION_DATE)), "2026-09-05");
  assert.equal(paystubFloor(D("2026-10-19")), "2026-09-19");                                     // purchase fixture
  assert.equal(paystubRequestText(D("2026-09-05")), "most recent paystub (dated on/after Sept 5, 2026) with year-to-date earnings");
  const h = harness(mst("2026-10-07", "10:00"));
  await h.intake("stub-sep4", "paystub", { employer_name: "Acme Manufacturing", pay_date: "2026-09-04", pay_period_start: "2026-08-16", pay_period_end: "2026-08-31", gross_current_cents: "625000", gross_ytd_cents: "10000000" });
  const armed = h.timer("FNMA_B3_3_2_01_PAYSTUB_30D_GATE")!; assert.equal(armed.status, "armed"); assert.equal(armed.note, "evaluator:22.1.paystubFloor");
  assert.equal(h.ofType("document.classified").at(-1)!.payload.doc_class, "paystub");
  const closed = await h.refused(h.run("computeFreshness", { op: "gate", gate: "FNMA_B3_3_2_01_PAYSTUB_30D_GATE" }), "FNMA_B3_3_2_01_PAYSTUB_30D_GATE");
  assert.match(closed.message, /2026-09-04 is before the floor 2026-09-05/);
  const floor = await h.run("computeFreshness", { op: "paystub_floor" }); assert.equal(floor.open, false); assert.equal(floor.floor, "2026-09-05");
  // The request the breach opens: the spec's text, linked to the paystub-floor rule.
  const req = await h.run("openRequest", { borrower_id: B1, doc_class: "paystub", qualifier: { employer: "Acme Manufacturing", ytd: true }, reason_code: "sm_paystub_floor", reason_text: String(floor.request_text) });
  assert.equal(req.opened, true); assert.equal(h.request(String(req.request_id)).reason_text, "most recent paystub (dated on/after Sept 5, 2026) with year-to-date earnings");
  assert.equal(h.ofType("document_request.opened").length, 1);
  // Fri Oct 2 paystub (period Sept 16–30) with YTD earnings opens the gate; the Sept 4 stub stays as history and is not the qualifying paystub.
  await h.intake("stub-oct2", "paystub", { employer_name: "Acme Manufacturing", pay_date: "2026-10-02", pay_period_start: "2026-09-16", pay_period_end: "2026-09-30", gross_current_cents: "625000", gross_ytd_cents: "11250000" });
  const open = await h.run("computeFreshness", { op: "gate", gate: "FNMA_B3_3_2_01_PAYSTUB_30D_GATE" }); assert.equal(open.open, true);
  const g = paystubGate({ initial_application_date: D(APPLICATION_DATE), paystubs: [{ document_id: "stub-sep4", pay_date: D("2026-09-04"), gross_ytd_cents: 10_000_000n, employer_name: "Acme Manufacturing" }, { document_id: "stub-oct2", pay_date: D("2026-10-02"), gross_ytd_cents: 11_250_000n, employer_name: "Acme Manufacturing" }] });
  assert.equal(g.open, true); assert.equal(g.qualifying_document_id, "stub-oct2"); assert.deepEqual(g.rejected.map((r) => r.document_id), ["stub-sep4"]);
  // Without YTD earnings the Oct 2 paystub does not satisfy the floor either.
  assert.equal(paystubGate({ initial_application_date: D(APPLICATION_DATE), paystubs: [{ document_id: "stub-oct2-noytd", pay_date: D("2026-10-02"), gross_ytd_cents: null, employer_name: "Acme Manufacturing" }] }).open, false);
});

test("22.1-T4: (paystub floor not re-based) Given the same application amended on Mon Oct 26, 2026, when the floor is recomputed, then it remains Sept 5, 2026.", async () => {
  const r = paystubFloorForApplication({ initial_application_date: D(APPLICATION_DATE), amended_on: D("2026-10-26") });
  assert.equal(r.floor, "2026-09-05"); assert.equal(r.rebased, false); assert.equal(r.amended_on, "2026-10-26");
  assert.notEqual(r.floor, "2026-09-26");                                                          // a rolling window from the amendment would give Sept 26 — never used
  const h = harness(mst("2026-10-26", "10:00"));
  h.rt.store.put("applications", APP, { application_date: APPLICATION_DATE, amended_on: "2026-10-26", amendment_reason: "loan amount changed" }, AGENT, h.clock.now());
  const out = await h.run("computeFreshness", { op: "paystub_floor", amended_on: "2026-10-26" });
  assert.equal(out.floor, "2026-09-05"); assert.equal(out.rebased, false);
  // The Sept 4 paystub is still short of the floor after the amendment; the gate evaluator reads the initial date only.
  assert.equal(evaluateGate("22.1.paystubFloor", { initial_application_date: APPLICATION_DATE, amended_on: "2026-10-26", paystubs: [{ document_id: "stub-sep4", pay_date: "2026-09-04", gross_ytd_cents: 10_000_000n, employer_name: "Acme" }] }).open, false);
});

test("22.1-T5: (tax-year table) Given application Oct 5, 2026 and disbursement Fri Jan 15, 2027, when `FNMA_B1_1_03_TAX_YEAR_GATE` is evaluated, then the 2025 return is required and a Form 4868 extension path is rejected; given disbursement Nov 12, 2026 instead, then the 2024 return is acceptable only with extension evidence, the tax-liability comparison and an IRS no-transcript response recorded.", async () => {
  const jan = taxYearRequirement(D(APPLICATION_DATE), D("2027-01-15"));
  assert.equal(jan.row, 5); assert.equal(jan.most_recent_year, 2025); assert.equal(jan.most_recent_required, true); assert.equal(jan.extension_permitted, false); assert.deepEqual(jan.required_years, [2025]);
  const rejected = taxYearGate({ application_date: D(APPLICATION_DATE), scheduled_disbursement_date: D("2027-01-15"), returns: [{ tax_year: 2024, kind: "form_1040" }], extension_evidence: true, tax_liability_comparison_recorded: true, irs_no_transcript_response_recorded: true });
  assert.equal(rejected.open, false); assert.match(rejected.reason!, /2025 return is required/); assert.match(rejected.reason!, /Form 4868\) is not permitted/);
  assert.equal(taxYearGate({ application_date: D(APPLICATION_DATE), scheduled_disbursement_date: D("2027-01-15"), returns: [{ tax_year: 2025, kind: "form_1040" }] }).open, true);
  const nov = taxYearRequirement(D(APPLICATION_DATE), D("2026-11-12"));
  assert.equal(nov.row, 4); assert.equal(nov.partially_verified, true); assert.deepEqual(nov.acceptable_years, [2025, 2024]); assert.equal(nov.fallback, "form_4868_path");
  const base = { application_date: D(APPLICATION_DATE), scheduled_disbursement_date: D("2026-11-12"), returns: [{ tax_year: 2024, kind: "form_1040" as const }] };
  assert.equal(taxYearGate(base).open, false);
  assert.match(taxYearGate({ ...base, extension_evidence: true }).reason!, /missing: total tax liability comparison, IRS no-transcript response/);
  const ok = taxYearGate({ ...base, extension_evidence: true, tax_liability_comparison_recorded: true, irs_no_transcript_response_recorded: true });
  assert.equal(ok.open, true); assert.equal(ok.year_relied_on, 2024); assert.equal(ok.path, "form_4868_path");
  // Row (1): application Mon Jan 11, 2027 with disbursement Fri Feb 26, 2027 → the 2025 return (2026 not yet scheduled to have been filed), no extension path.
  const row1 = taxYearRequirement(D("2027-01-11"), D("2027-02-26")); assert.equal(row1.row, 1); assert.equal(row1.most_recent_year, 2025); assert.equal(row1.extension_permitted, false);
  // Through the bus: a 2024 Form 1040 classified in the tax family arms the gate; the Jan 15 disbursement refuses, the Nov 12 path with the three elements opens.
  const h = harness(mst("2026-10-07", "10:00"));
  await h.intake("ret-2024", "form_1040", { tax_year: 2024, filing_status: "single" });
  assert.equal(h.ofType("document.classified").at(-1)!.payload.doc_family, "tax");
  assert.equal(h.timer("FNMA_B1_1_03_TAX_YEAR_GATE")!.note, "evaluator:22.1.taxYear");
  await h.refused(h.run("computeFreshness", { op: "gate", gate: "FNMA_B1_1_03_TAX_YEAR_GATE", scheduled_disbursement_date: "2027-01-15", extension_evidence: true }), "FNMA_B1_1_03_TAX_YEAR_GATE");
  const opened = await h.run("computeFreshness", { op: "gate", gate: "FNMA_B1_1_03_TAX_YEAR_GATE", scheduled_disbursement_date: "2026-11-12", extension_evidence: true, tax_liability_comparison_recorded: true, irs_no_transcript_response_recorded: true });
  assert.equal(opened.open, true);
  assert.equal(evaluateGate("22.1.taxYear", { application_date: APPLICATION_DATE, scheduled_disbursement_date: "2026-11-12", returns: [{ tax_year: 2024, kind: "form_1040" }], extension_evidence: true }).open, false);
});

test("22.1-T6: (arithmetic integrity) Given a paystub with `gross_ytd = 11,250,000` cents and Medicare YTD 150,000 cents, when the battery runs, then `arithmetic = warn` (deviation 13,125 cents > tolerance 816 cents), the document is `flagged`, and a source-obtained VOE/validation report is requested before 22.3 may use the income; with Medicare YTD 163,125 cents the check passes.", async () => {
  const warn = arithmeticCheck({ gross_ytd_cents: 11_250_000n, medicare_withholding_ytd_cents: 150_000n });
  assert.equal(warn.result, "warn");
  assert.equal(warn.details.medicare_expected_cents, "163125"); assert.equal(warn.details.medicare_deviation_cents, "13125"); assert.equal(warn.details.medicare_tolerance_cents, "816");
  assert.match(String((warn.details.findings as string[])[0]), /Withholding not calculated correctly/);
  assert.equal(arithmeticCheck({ gross_ytd_cents: 11_250_000n, medicare_withholding_ytd_cents: 163_125n }).result, "pass");
  const h = harness(mst("2026-10-07", "10:00"));
  await h.intake("stub-oct2", "paystub", { employer_name: "Acme Manufacturing", pay_date: "2026-10-02", pay_period_start: "2026-09-16", pay_period_end: "2026-09-30", gross_current_cents: "625000", gross_ytd_cents: "11250000", medicare_withholding_ytd_cents: "150000" });
  const out = await h.run("runIntegrityBattery", { document_id: "stub-oct2", sole_evidence: true });
  const checks = out.checks as { check_type: string; result: string }[];
  assert.equal(checks.find((c) => c.check_type === "arithmetic")!.result, "warn");
  assert.equal(out.integrity_status, "flagged"); assert.equal(h.doc("stub-oct2").integrity_status, "flagged"); assert.equal(h.doc("stub-oct2").status, "flagged");
  assert.equal(out.income_usable_by_22_3, false);
  assert.equal((out.follow_up_request as { doc_class: string }).doc_class, "form_1005_voe");
  const req = h.request(String(out.follow_up_request_id));
  assert.equal(req.reason_code, "sm_integrity_source_verification"); assert.match(req.reason_text, /source-obtained verification of employment .*DU validation report/);
  assert.equal(h.ofType("document.integrity.flagged").length, 1); assert.equal(h.ofType("document_request.opened").length, 1);
  // A request cannot be satisfied by the flagged paystub (integrity ≠ passed).
  await h.run("openRequest", { borrower_id: B1, doc_class: "paystub", request_id: "req-stub", qualifier: { employer: "Acme Manufacturing" }, reason_code: "DU-1001", reason_text: "most recent paystub with year-to-date earnings", condition_id: "cond-1" });
  await h.run("matchToRequests", { document_id: "stub-oct2" });
  const review = await h.run("matchToRequests", { document_id: "stub-oct2", op: "review", request_id: "req-stub" });
  const rv = (review.reviews as { satisfied: boolean; reason: string }[])[0]!; assert.equal(rv.satisfied, false); assert.match(rv.reason, /integrity_status flagged/);
  // The corrected paystub passes the arithmetic check; the $112,500.00 YTD still trips the even-dollar red flag (one warn), which alone flags only a sole-evidence document.
  await h.intake("stub-oct2-b", "paystub", { employer_name: "Acme Manufacturing", pay_date: "2026-10-02", pay_period_start: "2026-09-16", pay_period_end: "2026-09-30", gross_current_cents: "625000", gross_ytd_cents: "11250000", medicare_withholding_ytd_cents: "163125" });
  const ok = await h.run("runIntegrityBattery", { document_id: "stub-oct2-b", sole_evidence: false });
  const okChecks = ok.checks as { check_type: string; result: string }[];
  assert.equal(okChecks.find((c) => c.check_type === "arithmetic")!.result, "pass"); assert.equal(okChecks.find((c) => c.check_type === "even_dollar")!.result, "warn");
  assert.equal(ok.integrity_status, "passed"); assert.equal(ok.income_usable_by_22_3, true); assert.equal(ok.follow_up_request, null);
  assert.equal((await h.run("runIntegrityBattery", { document_id: "stub-oct2-b", sole_evidence: true })).integrity_status, "flagged");
});

test("22.1-T7: (running balance) Given a bank statement whose transactions do not reconcile to the ending balance, when the battery runs, then `running_balance = fail`, `integrity_status = failed`, an `escalation{role=underwriting_reviewer}` with a 1 `business_days_creditor` SLA is created, and 22.6 opens a fraud case candidate.", async () => {
  const h = harness(mst("2026-10-22", "10:00"));                                                  // O3-IT3: Thu Oct 22 integrity failed
  await h.intake("stmt-sep", "bank_statement", { institution: "Desert Credit Union", account_last4: "1234", period_start: "2026-09-01", period_end: "2026-09-30", opening_balance_cents: "1000000", ending_balance_cents: "1500000",
    transactions: [{ date: "2026-09-04", description: "ACME MFG PAYROLL", amount_cents: "480000", running_balance_cents: "1480000" }, { date: "2026-09-10", description: "RENT", amount_cents: "-200000", running_balance_cents: "1280000" }] });
  const out = await h.run("runIntegrityBattery", { document_id: "stmt-sep" });
  const checks = out.checks as { check_type: string; result: string; details: Record<string, unknown> }[];
  const rb = checks.find((c) => c.check_type === "running_balance")!; assert.equal(rb.result, "fail");
  assert.match(String((rb.details.mismatches as string[]).at(-1)), /1280000 ≠ ending 1500000/);
  assert.equal(out.integrity_status, "failed"); assert.equal(h.doc("stmt-sep").integrity_status, "failed"); assert.equal(h.doc("stmt-sep").status, "failed");
  assert.equal(out.escalation_role, "underwriting_reviewer");
  assert.deepEqual(out.escalation_sla, { n: 1, unit: "business_days_creditor", due: "2026-10-23" });   // Thu Oct 22 + 1 creditor business day = Fri Oct 23
  const esc = h.rt.escalations.opened.find((e) => e.id === out.escalation_id)!;
  assert.equal(esc.kind, "underwriting_reviewer"); assert.equal(esc.ownerRole, "underwriting_reviewer"); assert.equal(esc.severity, "sev-2"); assert.equal(esc.applicationId, APP); assert.equal(esc.payload.fraud_case_candidate, true);
  assert.equal(out.fraud_case_candidate, true);
  const failed = h.ofType("document.integrity.failed")[0]!; assert.equal(failed.payload.hand_off, "22.6"); assert.equal(failed.payload.fraud_case_candidate, true);
  const cand = h.ofType("fraud.case.candidate")[0]!; assert.equal(cand.payload.owner, "22.6"); assert.equal(cand.payload.document_id, "stmt-sep");
  // Never accepted: op=clear on a failed document is refused by the code path.
  await assert.rejects(h.run("runIntegrityBattery", { document_id: "stmt-sep", op: "clear", rationale: "looks fine", resolving_evidence_document_ids: ["x"], decision_id: "d1" }), /may never accept a failed document/);
  await h.refused(h.run("runIntegrityBattery", { document_id: "stmt-sep", op: "clear", accept_failed: true, rationale: "x", resolving_evidence_document_ids: ["x"], decision_id: "d1" }), "ACCEPT_FAILED_DOCUMENT");
  // A reconciling statement passes.
  await h.intake("stmt-sep-ok", "bank_statement", { institution: "Desert Credit Union", account_last4: "5678", period_start: "2026-09-01", period_end: "2026-09-30", opening_balance_cents: "1000000", ending_balance_cents: "1280000",
    transactions: [{ date: "2026-09-04", description: "ACME MFG PAYROLL", amount_cents: "480000", running_balance_cents: "1480000" }, { date: "2026-09-10", description: "RENT", amount_cents: "-200000", running_balance_cents: "1280000" }] });
  assert.equal((await h.run("runIntegrityBattery", { document_id: "stmt-sep-ok" })).integrity_status, "passed");
});

test("22.1-T8: (needs-list SLA with holiday) Given three requests opened Wed Oct 7, 2026, when the borrower uploads Sat Oct 10, 2026, then reminders were sent Oct 9 only, `document.received{request_id}` is logged Oct 10 (satisfying `SM_NEEDS_LIST_BORROWER_RESPONSE_5`), and `SM_NEEDS_LIST_REVIEW_1BD` is due Tue Oct 13, 2026 (Columbus Day Oct 12 closed in calendar `creditor`).", async () => {
  const s = requestSchedule(mst("2026-10-07", "14:05"));
  assert.equal(s.due_at, "2026-10-12"); assert.deepEqual(s.reminder_dates, ["2026-10-09", "2026-10-11"]); assert.equal(s.noia_evaluation_on, "2026-10-17");
  assert.equal(reviewDue(mst("2026-10-10", "09:30")), "2026-10-13");                              // Sat receipt → Mon Oct 12 is Columbus Day → Tue Oct 13
  const h = harness(mst("2026-10-07", "14:05"));
  const derived = await h.run("deriveNeedsList", { source: "du", batch_id: "nl-1", conditions: [
    { borrower_id: B1, condition_id: "cond-1", du_message_id: "DU-1001" }, { borrower_id: B1, condition_id: "cond-2", du_message_id: "DU-1002" }, { borrower_id: B1, condition_id: "cond-3", du_message_id: "DU-2001", qualifier: { account_last4: "1234" } }] });
  const reqs = derived.requests as { request_id: string; due_at: string; reminder_dates: string[] }[];
  assert.equal(reqs.length, 3); assert.equal(derived.batch_status, "released");
  for (const r of reqs) { assert.equal(r.due_at, "2026-10-12"); assert.deepEqual(r.reminder_dates, ["2026-10-09", "2026-10-11"]); }
  assert.equal(h.timers.byCode("SM_NEEDS_LIST_BORROWER_RESPONSE_5").length, 3);
  for (const t of h.timers.byCode("SM_NEEDS_LIST_BORROWER_RESPONSE_5")) { assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-07"); assert.equal(t.dueDate, "2026-10-12"); }
  // Reminders: Fri Oct 9 goes out; the Sun Oct 11 reminder never does because the upload lands Sat Oct 10.
  h.at(mst("2026-10-09", "08:00"));
  const rem = await h.run("renderNeedsListNotice", { op: "reminder", party: PARTY, recipients: RECIPIENTS });
  assert.deepEqual((rem.reminded as { sent_on: string[] }[]).map((r) => r.sent_on), [["2026-10-09"], ["2026-10-09"], ["2026-10-09"]]);
  assert.equal(h.ofType("document_request.reminded").length, 3);
  h.at(mst("2026-10-10", "09:30"));
  const paystubReq = reqs[0]!.request_id;
  const up = await h.run("ingestDocument", { document_id: "stub-oct2", source_channel: "borrower_upload", sha256: "sha-stub", subject_borrower_id: B1, applicant_borrower_ids: [B1], request_id: paystubReq });
  assert.deepEqual(up.matched_request_ids, [paystubReq]); assert.equal(up.review_due, "2026-10-13");
  const received = h.ofType("document.received")[0]!;
  assert.equal(received.payload.request_id, paystubReq); assert.equal(received.occurredAt.slice(0, 10), "2026-10-10");
  // The engine keys instances to the application; the paystub request's clock is satisfied by the upload, and the W-2 and statement requests keep an armed clock with the same Oct 12 due date.
  const clocksOf = (id: string) => h.timers.byCode("SM_NEEDS_LIST_BORROWER_RESPONSE_5").filter((t) => (h.events.all().find((e) => e.id === t.armedByEventId)!.payload as Record<string, unknown>).request_id === id);
  assert.ok(clocksOf(paystubReq).length >= 1 && clocksOf(paystubReq).every((t) => t.status === "satisfied" && t.satisfiedByEventId === received.id));
  for (const id of [reqs[1]!.request_id, reqs[2]!.request_id]) assert.ok(clocksOf(id).some((t) => t.status === "armed" && t.dueDate === "2026-10-12"), `${id} still waits`);
  assert.equal(h.timers.byCode("SM_NEEDS_LIST_BORROWER_RESPONSE_5").filter((t) => t.status === "armed").length, 2);   // the W-2 and statement requests still wait
  const review = h.timer("SM_NEEDS_LIST_REVIEW_1BD")!;
  assert.equal(review.status, "armed"); assert.equal(review.anchorDate, "2026-10-10"); assert.equal(review.dueDate, "2026-10-13");
  h.at(mst("2026-10-11", "08:00"));
  const rem2 = await h.run("renderNeedsListNotice", { op: "reminder", party: PARTY, recipients: RECIPIENTS });
  assert.ok(!(rem2.reminded as { request_id: string }[]).some((r) => r.request_id === paystubReq), "the received request gets no Oct 11 reminder");
  assert.equal(h.request(paystubReq).reminders_sent_on.length, 1);
  // Classified, extracted and passed → the review satisfies SM_NEEDS_LIST_REVIEW_1BD (`document_request.satisfied`) and proposes the condition clear to 23.3.
  h.at(mst("2026-10-12", "10:00"));
  await h.run("classifyDocument", { document_id: "stub-oct2", doc_class: "paystub", confidence: 0.99 });
  await h.run("extractFields", { document_id: "stub-oct2", fields: { employer_name: "Acme Manufacturing", pay_date: "2026-10-02", pay_period_start: "2026-09-16", pay_period_end: "2026-09-30", gross_current_cents: "625000", gross_ytd_cents: "11250000", medicare_withholding_ytd_cents: "163125" } });
  await h.run("runIntegrityBattery", { document_id: "stub-oct2" });
  const rv = await h.run("matchToRequests", { document_id: "stub-oct2", op: "review" });
  assert.equal((rv.reviews as { satisfied: boolean }[])[0]!.satisfied, true);
  assert.equal(h.timer("SM_NEEDS_LIST_REVIEW_1BD")!.status, "satisfied");
  assert.equal(h.ofType("condition.clear.proposed")[0]!.payload.condition_id, "cond-1");
  const clear = await h.run("proposeConditionClear", { request_id: paystubReq }); assert.equal(clear.owner, "23.3");
});

test("22.1-T9: (DU validation waiver) Given a DU employment validation outcome `validated` for borrower 1 with employer Acme, when the finding is received, then the open `form_1005_voe`/`paystub` requests for that borrower and employer are `waived_by = du_validation` with the submission number, and no needs-list notice mentions them.", async () => {
  const h = harness(mst("2026-10-07", "14:05"));
  await h.run("openRequest", { request_id: "req-voe", borrower_id: B1, doc_class: "form_1005_voe", qualifier: { employer: "Acme" }, reason_code: "DU-1005", reason_text: "written verification of employment (Form 1005) sent directly by the employer", condition_id: "cond-voe" });
  await h.run("openRequest", { request_id: "req-stub", borrower_id: B1, doc_class: "paystub", qualifier: { employer: "Acme" }, reason_code: "DU-1001", reason_text: "most recent paystub with year-to-date earnings", condition_id: "cond-stub" });
  await h.run("openRequest", { request_id: "req-stmt", borrower_id: B1, doc_class: "bank_statement", qualifier: { account_last4: "1234" }, reason_code: "DU-2001", reason_text: "most recent bank statement covering the required period", condition_id: "cond-stmt" });
  await h.run("openRequest", { request_id: "req-w2-b2", borrower_id: "borrower-2", doc_class: "w2", qualifier: { employer: "Acme" }, reason_code: "DU-1002", reason_text: "W-2 forms for the most recent year", condition_id: "cond-w2-b2" });
  const w = await h.run("waiveRequest", { op: "du_validation", borrower_id: B1, component: "employment", outcome: "validated", submission_number: "DU-SUB-1592837", employer: "Acme" });
  assert.deepEqual((w.waived as { request_id: string }[]).map((x) => x.request_id).sort(), ["req-stub", "req-voe"]);
  for (const id of ["req-voe", "req-stub"]) { const r = h.request(id); assert.equal(r.status, "waived"); assert.equal(r.waived_by, "du_validation"); assert.equal(r.waiver_reference, "DU-SUB-1592837"); }
  assert.equal(h.request("req-stmt").status, "open"); assert.equal(h.request("req-w2-b2").status, "open");   // the asset request and borrower 2's W-2 are untouched
  const waivedEvents = h.ofType("document_request.waived"); assert.equal(waivedEvents.length, 2); assert.equal(waivedEvents[0]!.payload.du_submission_number, "DU-SUB-1592837");
  // The consolidated notice lists only the still-open statement request; the waived items are absent from the rendered text and the payload.
  const nl = await h.run("deriveNeedsList", { source: "manual", batch_id: "nl-1", items: [{ borrower_id: B1, doc_class: "bank_statement", qualifier: { account_last4: "1234" }, reason_code: "DU-2001", reason_text: "most recent bank statement covering the required period", condition_id: "cond-stmt" }] });
  assert.equal(nl.batch_status, "released");
  const rendered = await h.run("renderNeedsListNotice", { batch_id: "nl-1", party: PARTY, recipients: RECIPIENTS });
  assert.equal(rendered.items, 2); assert.deepEqual([...(rendered.request_ids as string[])].sort(), ["req-stmt", "req-w2-b2"]);
  const notice = h.rt.notices!.get(String(rendered.notice_id));
  assert.equal(notice.status, "rendered");
  assert.doesNotMatch(notice.rendered.text, /paystub|Form 1005|verification of employment/);
  assert.match(notice.rendered.text, /bank statement/); assert.match(notice.rendered.text, /Lender: Partner Bank, N\.A\./); assert.match(notice.rendered.text, /NMLSR ID 1234567/); assert.match(notice.rendered.text, /generated by an automated system on behalf of Partner Bank/);
  // A free waiver outside the DU/owning-process paths is refused.
  await h.refused(h.run("waiveRequest", { request_id: "req-stmt", waived_by: "agent_judgment", reference: "x", rule: "x" }), "WAIVER_OUTSIDE_RULE");
  // Not validated → nothing waived.
  const nv = await h.run("waiveRequest", { op: "du_validation", borrower_id: B1, component: "assets", outcome: "unable_to_validate", submission_number: "DU-SUB-1592838" });
  assert.deepEqual(nv.waived, []); assert.equal(h.request("req-stmt").status, "open");
});

test("22.1-T10: (TRID ordering) Given an application whose LE has not been delivered, when DU opens verification conditions, then the needs-list notice is queued and released only after `disclosure.le.delivered`.", async () => {
  const h = harness(mst("2026-10-06", "11:00"), { leDelivered: false });
  const d = await h.run("deriveNeedsList", { source: "du", batch_id: "nl-1", conditions: [{ borrower_id: B1, condition_id: "cond-1", du_message_id: "DU-1001" }, { borrower_id: B1, condition_id: "cond-3", du_message_id: "DU-2001", qualifier: { account_last4: "1234" } }] });
  assert.equal(d.batch_status, "queued"); assert.equal(d.queued_reason, "loan_estimate_not_delivered"); assert.equal(d.released_after, "disclosure.le.delivered");
  assert.equal(h.ofType("needs_list.queued").length, 1);
  assert.equal(h.timers.byCode("SM_NEEDS_LIST_BORROWER_RESPONSE_5").length, 2);                    // the requests exist and their clocks run; only the notice waits
  const r = await h.refused(h.run("renderNeedsListNotice", { batch_id: "nl-1", party: PARTY, recipients: RECIPIENTS }), "NEEDS_LIST_BEFORE_LE");
  assert.match(r.citation, /TRID FAQ/);
  await h.refused(h.run("deriveNeedsList", { source: "manual", items: [], condition_le_on_documents: true }), "VERIFYING_DOC_BEFORE_LE");
  assert.equal(h.ofType("needs_list.sent").length, 0);
  // 21.2 delivers the LE → the queued batch is released, rendered and sent once.
  h.at(mst("2026-10-06", "16:10"));
  h.upstream("disclosure.le.delivered", { disclosure_id: "le-1", le_version: 1, channel: "esign_portal", delivered_at: h.clock.now() }, h.clock.now(), { kind: "agent", id: "disclosure" });
  const rel = await h.run("renderNeedsListNotice", { op: "release", delivered_at: h.clock.now() });
  assert.deepEqual(rel.released_batch_ids, ["nl-1"]);
  const rendered = await h.run("renderNeedsListNotice", { batch_id: "nl-1", party: PARTY, recipients: RECIPIENTS });
  assert.equal(rendered.notice_status, "rendered"); assert.equal(rendered.items, 2);
  const sent = await h.run("sendNotice", { notice_id: rendered.notice_id, batch_id: "nl-1" });
  assert.equal(sent.status, "sent"); assert.equal(h.ofType("needs_list.sent").length, 1); assert.equal(h.ofType("needs_list.sent")[0]!.payload.notice_id, rendered.notice_id);
  const reqs = h.requests(); assert.ok(reqs.every((q) => q.notice_ids.includes(String(rendered.notice_id))));
  // A batch derived after the LE is released immediately.
  const later = await h.run("deriveNeedsList", { source: "du", batch_id: "nl-2", conditions: [{ borrower_id: B1, condition_id: "cond-4", du_message_id: "DU-4001" }] });
  assert.equal(later.batch_status, "released");
});

test("22.1-T11: (e-mail authentication) Given an e-mail attachment from a sender failing DMARC alignment, when ingested, then the document is quarantined (`integrity_status = failed`, `sender_authentication = fail`), no request is satisfied, and the borrower receives a portal-upload prompt.", async () => {
  const h = harness(mst("2026-10-08", "09:00"));
  await h.run("openRequest", { request_id: "req-stub", borrower_id: B1, doc_class: "paystub", reason_code: "DU-1001", reason_text: "most recent paystub with year-to-date earnings", condition_id: "cond-1" });
  const armedBefore = h.timer("SM_NEEDS_LIST_BORROWER_RESPONSE_5")!; assert.equal(armedBefore.status, "armed");
  const q = await h.run("ingestDocument", { document_id: "email-1", source_channel: "borrower_email", sha256: "sha-email-1", subject_borrower_id: B1, applicant_borrower_ids: [B1], request_id: "req-stub", declared_class: "paystub",
    sender_identity: { from: "alex@example.com", message_id: "<m1@mail>" }, email_authentication: { spf: "pass", dkim: "pass", dmarc_aligned: false, sender_verified: true } });
  assert.equal(q.quarantined, true); assert.equal(q.quarantine_reason, "sender_authentication"); assert.equal(q.integrity_status, "failed"); assert.equal(q.sender_authentication, "fail"); assert.equal(q.portal_upload_prompt, true); assert.equal(q.request_satisfied, false);
  const d = h.doc("email-1"); assert.equal(d.status, "quarantined"); assert.equal(d.integrity_status, "failed"); assert.deepEqual(d.request_ids, []);
  assert.equal(h.request("req-stub").status, "open");
  assert.equal(h.ofType("document.received").length, 0);                                            // no `document.received{request_id}` → the borrower clock is not satisfied
  assert.equal(h.timer("SM_NEEDS_LIST_BORROWER_RESPONSE_5")!.status, "armed");
  assert.equal(h.timers.byCode("SM_NEEDS_LIST_REVIEW_1BD").length, 0);
  const qe = h.ofType("document.quarantined")[0]!; assert.equal(qe.payload.sender_authentication, "fail"); assert.equal(qe.payload.prompt, "portal_upload");
  const chk = h.rt.store.list("document_integrity_checks", (c) => c.document_id === "email-1"); assert.equal(chk.length, 1); assert.equal(chk[0]!.data.check_type, "sender_authentication"); assert.equal(chk[0]!.data.result, "fail");
  // The same attachment through the portal is received against the request.
  const ok = await h.run("ingestDocument", { document_id: "portal-1", source_channel: "borrower_upload", sha256: "sha-portal-1", subject_borrower_id: B1, applicant_borrower_ids: [B1], request_id: "req-stub" });
  assert.equal(ok.quarantined, false); assert.deepEqual(ok.matched_request_ids, ["req-stub"]); assert.equal(h.timer("SM_NEEDS_LIST_BORROWER_RESPONSE_5")!.status, "satisfied");
  // An aligned e-mail from the borrower's verified address is accepted; a non-applicant subject is quarantined.
  const aligned = await h.run("ingestDocument", { document_id: "email-2", source_channel: "borrower_email", sha256: "sha-email-2", subject_borrower_id: B1, applicant_borrower_ids: [B1], email_authentication: { spf: "pass", dkim: "pass", dmarc_aligned: true, sender_verified: true } });
  assert.equal(aligned.quarantined, false);
  const stranger = await h.run("ingestDocument", { document_id: "upload-x", source_channel: "borrower_upload", sha256: "sha-x", subject_borrower_id: "someone-else", applicant_borrower_ids: [B1] });
  assert.equal(stranger.quarantine_reason, "non_applicant");
  await h.refused(h.run("ingestDocument", { document_id: "upload-y", source_channel: "borrower_upload", sha256: "sha-y", subject_is_applicant: false }), "NON_APPLICANT_DOCUMENT");
});

test("22.1-T12: (retention transitions) Given a loan funded Thu Nov 12, 2026, when `loan.funded` is processed, then every file document carries `fnma_loan_file_life_plus_4y`, the ATR evidence set also carries `regz_atr_3y`, and a withdrawn application notified Mon Nov 2, 2026 carries `regb_25m` with purge eligibility on Dec 2, 2028.", async () => {
  const h = harness(mst("2026-10-07", "10:00"));
  await h.intake("stub-oct2", "paystub", { employer_name: "Acme Manufacturing", pay_date: "2026-10-02", gross_ytd_cents: "11250000" });
  await h.intake("stmt-sep", "bank_statement", { institution: "Desert Credit Union", account_last4: "1234", period_end: "2026-09-30" });
  await h.intake("id-1", "drivers_license", { id_number_last4: "4321" });
  for (const id of ["stub-oct2", "stmt-sep", "id-1"]) assert.deepEqual(h.doc(id).retention_classes, ["regb_25m"]);      // R9: Reg B minimum at intake
  h.at(mst("2026-11-12", "12:00"));
  const funded = h.upstream("loan.funded", { funding_date: "2026-11-12", disbursement_date: "2026-11-12", loan_id: LOAN }, h.clock.now(), { kind: "agent", id: "funding" });
  assert.equal(funded.applicationId, APP);
  const ctx = { ...h.uow, actor: AGENT, now: h.clock.now() };
  const out = applyRetentionOnFunded(h.rt, ctx, { application_id: APP, funded_on: D("2026-11-12"), atr_evidence_document_ids: ["stub-oct2", "stmt-sep"] });
  assert.equal(out.length, 3);
  for (const id of ["stub-oct2", "stmt-sep", "id-1"]) { const d = h.doc(id); assert.ok(d.retention_classes.includes("fnma_loan_file_life_plus_4y"), `${id} carries the Fannie Mae class`); assert.equal(d.retention_anchor, "2026-11-12"); assert.equal(d.status, "retained"); }
  assert.ok(h.doc("stub-oct2").retention_classes.includes("regz_atr_3y")); assert.ok(h.doc("stmt-sep").retention_classes.includes("regz_atr_3y"));
  assert.ok(!h.doc("id-1").retention_classes.includes("regz_atr_3y"));
  assert.equal(h.ofType("document.retention.assigned").length, 3);
  // Withdrawn application notified Mon Nov 2, 2026 → regb_25m from the notification date; purge eligible Dec 2, 2028 unless legal_hold; open requests expire.
  assert.deepEqual(withdrawalRetention(D("2026-11-02")), { retention_class: "regb_25m", anchor: "2026-11-02", purge_eligible_on: "2028-12-02" });
  const w = harness(mst("2026-10-07", "10:00"));
  await w.intake("stub-w", "paystub", { employer_name: "Acme Manufacturing", pay_date: "2026-10-02", gross_ytd_cents: "11250000" });
  await w.run("openRequest", { request_id: "req-w", borrower_id: B1, doc_class: "w2", reason_code: "DU-1002", reason_text: "W-2 forms for the most recent year", condition_id: "cond-w" });
  w.at(mst("2026-11-02", "15:00"));
  w.upstream("decision.issued", { kind: "withdrawal", notified_on: "2026-11-02" }, w.clock.now(), { kind: "agent", id: "decision" });
  applyRetentionOnWithdrawal(w.rt, { ...w.uow, actor: AGENT, now: w.clock.now() }, { application_id: APP, notified_on: D("2026-11-02") });
  const wd = w.doc("stub-w"); assert.deepEqual(wd.retention_classes, ["regb_25m"]); assert.equal(wd.retention_anchor, "2026-11-02"); assert.equal(wd.purge_eligible_on, "2028-12-02");
  assert.equal(w.request("req-w").status, "expired");
  assert.equal(w.ofType("document_request.expired").length, 1);
  // A legal hold blocks purge eligibility.
  w.rt.store.put("documents", "stub-w", { legal_hold: true }, AGENT, w.clock.now());
  applyRetentionOnWithdrawal(w.rt, { ...w.uow, actor: AGENT, now: w.clock.now() }, { application_id: APP, notified_on: D("2026-11-02") });
  assert.equal(w.doc("stub-w").purge_eligible_on, null);
});

test("22.1 worked figures: semi-monthly gross $6,250.00 × 18 pay periods = $112,500.00 YTD; Medicare 1.45 % = $1,631.25 (tolerance 816 cents); a stub showing $1,500.00 deviates 13,125 cents → warn", () => {
  const gross_current = 625_000n;                                   // $6,250.00 semi-monthly
  const gross_ytd = gross_current * 18n;                            // 18 pay periods through Sept 30, 2026
  assert.equal(gross_ytd, 11_250_000n);                             // $112,500.00
  const expectedMedicare = bps(gross_ytd, MEDICARE_RATE_BPS);
  assert.equal(expectedMedicare, 163_125n);                         // $1,631.25
  assert.equal(withholdingTolerance(expectedMedicare), 816n);       // max(500, 0.5 % × 163,125 = 815.625 → 816)
  const pass = arithmeticCheck({ gross_current_cents: gross_current, earnings_lines_cents: [gross_current], gross_ytd_cents: gross_ytd, medicare_withholding_ytd_cents: 163_125n });
  assert.equal(pass.result, "pass"); assert.equal(pass.details.medicare_deviation_cents, "0");
  const warn = arithmeticCheck({ gross_current_cents: gross_current, earnings_lines_cents: [gross_current], gross_ytd_cents: gross_ytd, medicare_withholding_ytd_cents: 150_000n });   // $1,500.00
  assert.equal(warn.result, "warn"); assert.equal(warn.details.medicare_deviation_cents, "13125"); assert.equal(warn.details.medicare_tolerance_cents, "816");
  // Social Security at 6.2 % of min(gross YTD, wage base) with the loaded wage-base parameter: 6.2 % × $112,500.00 = $6,975.00, tolerance max(500, 3,488) = 3,488 cents.
  const ss = arithmeticCheck({ gross_ytd_cents: gross_ytd, ss_withholding_ytd_cents: 697_500n, ssa_wage_base_cents: 18_450_000n });
  assert.equal(ss.result, "pass"); assert.equal(ss.details.ss_expected_cents, "697500"); assert.equal(ss.details.ss_tolerance_cents, "3488");
});
