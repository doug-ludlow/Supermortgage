// 29.3 Delivery data preparation and pre-delivery validation (ULDD, Special Feature Codes, UCD/UCDP/DU identifiers, MI data, EarlyCheck)
// spec/sections/29-secondary-marketing-and-delivery-to-fannie-mae-whole-loan-se/29-3-delivery-data-preparation-and-pre-delivery-validation-uldd-s.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_29_3 } from "../../app/tools/section29-3.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { luhnCheckDigit } from "../boarding/min.ts";
import { FACILITY_FIXTURE } from "../warehouse/ops-27-1.ts";
import { deliveryData as valuationDeliveryData } from "../property/ops-24-1.ts";
import { DeliveryBuildService, FakeEarlyCheck, DeliveryRefused, collectPrerequisites, harvestSfcs, reconcileIdentifiers, assignSfcs, sfc067Gate, valueAcceptanceGate, valueAcceptanceOfferAge, deriveMiAbsenceReason, miCertificateIdentifier, baseLtvPct, priceAtLtv, priceLockDate, docFileIdCheck, mapEditToOwner, derivedFixAllowed, computedFieldVariances, sha256Hex, earlycheckCleanGate, ULDD_PHASE, SFC_CAP, type LoanFileBase, type EarlyCheckResult, type UlddDataPoint } from "./ops-29-3.ts";

const AGENT: Actor = { kind: "agent", id: "secondary" };
const OPERATOR: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };
const SLN = (seed: string): string => `${seed}${luhnCheckDigit(seed)}`;   // 30.2: the servicing loan number IS the Lender Loan Number (10 digits, Luhn check digit)
const DU_REFI = "2087654321", DU_PUR = "2087700123";
/** The refinance fixture: $560,000 LCOR 6.125% 30y, Phoenix AZ, appraised $800,000 (UAD 3.6, Doc File ID begins with "2"), escrowed ($3,120.00 initial deposit), no MI, note Fri Nov 6, disbursed Thu Nov 12, first payment Fri Jan 1, 2027, Classic FICO 762, lock Wed Oct 7, best-efforts commitment expiring Mon Dec 7, warehouse advance outstanding under SM's bailee letter, paper note, RON'd deed of trust. */
const refiBase = (over: Partial<LoanFileBase> = {}): LoanFileBase => ({ application_id: "APP-REFI-1", loan_id: "L-REFI-1", partner_id: "PARTNER-1", seller_number: "123456789", servicing_loan_number: SLN("300000001"), purpose: "limited_cash_out", loan_amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, note_date: D("2026-11-06"), disbursement_date: D("2026-11-12"), first_payment_date: D("2027-01-01"), maturity_date: D("2056-12-01"), sales_price_cents: null, appraised_value_cents: 80_000_000n,
  property: { property_id: "PROP-REFI-1", street: "4120 North 7th Street", city: "Phoenix", state: "AZ", zip: "85014", units: 1, usage: "PrimaryResidence", type: "detached" }, escrowed: true, initial_escrow_deposit_cents: 312_000n,
  du: { casefile_id: DU_REFI, is_final: true, recommendation: "approve_eligible", closed_loan_snapshot_hash: "sha256:closed-refi-cd2", du_spec_file_sha256: "sha256:du-spec-refi-final", du_spec_document_id: "DOC-DUSPEC-REFI" },
  valuation: { method: "traditional", offer_date: null, property_data_id: null, special_feature_codes: [] }, lock: { locked_on: D("2026-10-07"), extensions: [] },
  warehouse: { advance_outstanding: true, payee_code: "SMWH482A", warehouse_lender_id: FACILITY_FIXTURE.fnma_warehouse_lender_id, custodian_fin: "FIN-770021", bailee_letter_name: FACILITY_FIXTURE.bailee_letter_name },
  note: { form: "paper", enote_registered_at: null, min: null, closing_type: "hybrid" }, notarization_kind: "ron",
  credit: { borrowers: [{ borrower_id: "B1", score_model: "classic_fico" }, { borrower_id: "B2", score_model: "classic_fico" }], representative_score: 762, selection_method: "MiddleOrLowerThenLowest" },
  hmda: { rate_spread_pct: "0.42", uli: "PARTNER1BANK00000000000000000000000000012" }, subordinations: [], ...over });
/** The purchase fixture (Columbus, OH): $412,000 at 90% LTV (price $457,800 per the contract; appraised $460,000), BPMI monthly 25% (85.01–90% band), HomeReady, Classic FICO 701, wet funding Wed Nov 18, first payment Fri Jan 1, 2027. */
const purchaseBase = (over: Partial<LoanFileBase> = {}): LoanFileBase => refiBase({ application_id: "APP-PUR-1", loan_id: "L-PUR-1", servicing_loan_number: SLN("300000002"), purpose: "purchase", loan_amount_cents: 41_200_000n, note_rate_pct: "6.250", note_date: D("2026-11-18"), disbursement_date: D("2026-11-18"), maturity_date: D("2056-12-01"), sales_price_cents: 45_780_000n, appraised_value_cents: 46_000_000n,
  property: { property_id: "PROP-PUR-1", street: "2210 Indianola Avenue", city: "Columbus", state: "OH", zip: "43201", units: 1, usage: "PrimaryResidence", type: "detached" }, initial_escrow_deposit_cents: 245_000n,
  du: { casefile_id: DU_PUR, is_final: true, recommendation: "approve_eligible", closed_loan_snapshot_hash: "sha256:closed-pur-cd2", du_spec_file_sha256: "sha256:du-spec-pur-final", du_spec_document_id: "DOC-DUSPEC-PUR" },
  mi: { certificate_number: "0004812093", mi_company_code: "MGIC", coverage_pct: "25.00", premium_plan: "bpmi_monthly", financed_premium_cents: 0n, status: "pending", activated_at: null },
  credit: { borrowers: [{ borrower_id: "B1", score_model: "classic_fico" }], representative_score: 701, selection_method: "MiddleOrLowerThenLowest" }, hmda: { rate_spread_pct: "0.35", uli: "PARTNER1BANK00000000000000000000000000077" }, ...over });
const CLEAN: EarlyCheckResult = { edits: [], result_document_id: "DOC-EC-RESULT-CLEAN", computed_fields: { LTV: "70.00", CLTV: "70.00", DTI: "38.00" } };

/** The 29.3 lifecycle on the event store: DeliveryBuildService over the fake EarlyCheck DI port, the escalation service, the TimerEngine arming the 29.3 rows, and the 29.3 tools on the bus sharing the same service. */
function harness(nowIso: string, base: LoanFileBase) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId: base.application_id });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["29.3"] });
  const escalations = new EscalationService(events, clock); const ec = new FakeEarlyCheck();
  const svc = new DeliveryBuildService({ events, clock, escalations, earlycheck: ec, agent_run_id: "run-29-3-1" });
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: { "delivery-29-3": svc, earlycheck: ec }, ports: {} };
  const uow: UowContext = { loanId: base.loan_id, applicationId: base.application_id, events, ledger: new MemoryLedger(), timers, clock, decide: () => {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_29_3); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("29.3", name))!, actor, { application_id: base.application_id, ...input }, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === base.application_id);
  /** A finished process's event, spelled as that process emits it (origination context; the loan id once the loan row exists). */
  const seam = (type: string, payload: Record<string, unknown>, opts: { at?: string; actor?: Actor; loanId?: string | null } = {}): DomainEvent => { if (opts.at) clock.set(opts.at); return events.append({ type, applicationId: base.application_id, ...(opts.loanId === null ? {} : { loanId: opts.loanId ?? base.loan_id }), actor: opts.actor ?? { kind: "agent", id: "upstream" }, payload: { application_id: base.application_id, source: "origination", ...payload } }); };
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  const file = (over: Partial<LoanFileBase> = {}) => collectPrerequisites(events, { ...base, ...over });
  const sid = (points: readonly UlddDataPoint[], s: string) => points.find((p) => p.sort_id === s) ?? null;
  const dp = (points: readonly UlddDataPoint[], name: string) => points.find((p) => p.data_point_name === name) ?? null;
  return { clock, events, timers, escalations, ec, svc, rt, uow, run, at, timer, ofType, seam, refused, file, sid, dp, base };
}
type H = ReturnType<typeof harness>;
/** The refinance fixture's prerequisite trail as the finished processes emit it (Oct 7 lock … Fri Nov 13 09:30 MST compliance checkpoint). */
function fundRefi(h: H, o: { sfcs?: string[]; scoreModels?: [string, string]; ucdCasefile?: string; ucdRateSetDate?: string; enote?: boolean; skipFlood?: boolean; extraSeams?: () => void } = {}): void {
  const du = h.base.du!.casefile_id; const models = o.scoreModels ?? ["classic_fico", "classic_fico"];
  h.seam("lock.executed", { lock_id: "LOCK-1", locked_at: "2026-10-07T16:19:00.000Z", rate_set_date: "2026-10-07", note_rate: "6.125" }, { at: "2026-10-07T16:19:00.000Z", loanId: null });
  h.seam("quote.locked", { quote_id: "Q-1", lock_id: "LOCK-1", sfcs: o.sfcs ?? ["007"], origination: true }, { loanId: null });
  h.seam("commitment.executed", { commitment_id_fnma: "BE-2026-100045", type: "best_efforts", price: "101.375", ptr: "5.8750", expires_on: "2026-12-07", original_expires_on: "2026-12-07", commitment_period_days: 61, underwriting_method: "du", du_casefile_id: du }, { at: "2026-10-07T16:30:00.000Z", loanId: null });
  h.seam("du.credit.associated", { casefile_id: du, score_model: models[0], borrowers: [{ borrower_id: "B1", score_model: models[0] }, { borrower_id: "B2", score_model: models[1] }] }, { at: "2026-10-08T15:00:00.000Z", loanId: null });
  h.seam("valuation.review.completed", { appraisal_id: "APR-1", version_no: 2, review_status: "accepted", completion_at: "2026-10-27T20:00:00.000Z", is_final_version: true, ucdp_status: "successful", doc_file_id: "2000418877", uad_version: "3.6" }, { at: "2026-10-27T20:00:00.000Z", loanId: null });
  if (!o.skipFlood) h.seam("flood.determination.received", { determination_id: "SFHDF-X-1", zone: "X", sfha: false, in_sfha: false, sfc_180: true, status: "not_required", special_feature_codes: ["180"] }, { at: "2026-10-06T19:30:00.000Z", loanId: null });
  h.seam("compliance.high_cost.determined", { determination_id: "hc-1", stage: "final", is_hoepa: false, is_state_high_cost: false, fnma_eligible: true }, { at: "2026-11-03T18:00:00.000Z", loanId: null });
  h.seam("du.findings.interpreted", { submission_id: "DU-SUB-3", recommendation: "approve_eligible", sfc_required: ["127", "007"], value_acceptance_offer: null, mi_coverage_pct: null }, { at: "2026-11-03T18:10:00.000Z", loanId: null });
  h.seam("du.final_submission.recorded", { submission_number: 3, recommendation: "approve_eligible", closed_loan_snapshot_hash: h.base.du!.closed_loan_snapshot_hash, casefile_id: du, is_final: true, du_spec_file_sha256: h.base.du!.du_spec_file_sha256, du_spec_document_id: h.base.du!.du_spec_document_id }, { at: "2026-11-03T18:20:00.000Z", loanId: null });
  h.seam("rep_warrant_relief.evaluated", { stage: "final", closing_date: "2026-11-06", components: [{ component: "limited_waiver_du", status: "eligible" }, { component: "income_validated", status: "eligible" }, { component: "employment_validated", status: "eligible" }] }, { at: "2026-11-03T18:30:00.000Z", loanId: null });
  h.seam("ucd.accepted", { ucd_submission_id: "UCD-2", status: "accepted", casefile_id_ucd: o.ucdCasefile ?? du, critical_edit_failures: 0, embedded_cd_disclosure_id: "CD-2", embedded_cd_version: 2, is_final: true, current_rate_set_date: o.ucdRateSetDate ?? "2026-10-07" }, { at: "2026-11-09T17:00:00.000Z", loanId: null });
  h.seam("loan.funded", { funding_date: "2026-11-12", disbursement_date: "2026-11-12", first_payment_date: "2027-01-01", funded_at: "2026-11-12T20:40:00.000Z", loan_id: h.base.loan_id }, { at: "2026-11-12T20:40:00.000Z", actor: { kind: "agent", id: "funding" } });
  h.seam("warehouse.advance.funded", { advance_id: "ADV-1", note_form: o.enote ? "enote" : "paper", wet: false, collateral_status: "bailee", advance_date: "2026-11-12" }, { at: "2026-11-12T21:00:00.000Z" });
  if (o.enote) h.seam("enote.registered", { min: "1000123-0000456789-0", registered_at: "2026-11-12T22:30:00.000Z", eregistry: "mers", controller_org_id: "1000123" }, { at: "2026-11-12T22:30:00.000Z" });
  else h.seam("mers.min.registered", { min: "1000123-0000456789-0", status: "active", registration_kind: "mom", acknowledged_at: "2026-11-13T15:05:00.000Z" }, { at: "2026-11-13T15:05:00.000Z", actor: { kind: "external", id: "mers" } });
  h.seam("compliance.test.passed", { checkpoint: "pre_delivery", result: "pass" }, { at: "2026-11-13T16:30:00.000Z" });
  o.extraSeams?.();
}
/** Build → EarlyCheck (clean unless scripted) → freeze, at the worked-example clock. */
function buildAndFreeze(h: H, over: Partial<LoanFileBase> = {}, when = { build: "2026-11-13T16:42:00.000Z", freeze: "2026-11-13T17:05:00.000Z" }) {
  h.at(when.build); const row = h.svc.open(h.file(over)); const out = h.svc.assemble(row.delivery_id);
  assert.equal(out.status, "built", out.reason ?? ""); h.svc.runEarlyCheck(row.delivery_id); h.at(when.freeze); const pkg = h.svc.freeze(row.delivery_id);
  return { row, out, pkg };
}

test("29.3-T1: Given the refinance fixture funded Thu Nov 12, 2026 with every prerequisite present, when the `secondary` agent runs, then a ULDD Phase 5 (5.2.0) file is built Fri Nov 13 with SID 322 = the final DU casefile ID, SID 82 a 10-character Doc File ID beginning with \"2\", SID 376 blank, SID 429 = `NoMIBasedOnOriginalLTV`, SID 311 = 2026-10-07, SID 642 = the SM payee code, SID 650.1 = SM's warehouse-lender identifier, SFCs {127, 007, 861, 180}, and `SM_O103_ULDD_BUILD_SLA_1BD` is satisfied.", () => {
  const h = harness("2026-10-07T16:00:00.000Z", refiBase()); fundRefi(h);
  // `loan.funded{disbursement_date=2026-11-12}` arms the build SLA: +1 business_days_creditor → due Fri Nov 13 (worked example B).
  const sla = h.timer("SM_O103_ULDD_BUILD_SLA_1BD")!; assert.equal(sla.status, "armed"); assert.equal(sla.anchorDate, "2026-11-12"); assert.equal(sla.dueDate, "2026-11-13");
  h.at("2026-11-13T16:42:00.000Z");   // Fri Nov 13, 09:42 MST
  const file = h.file(); assert.ok(file.prerequisite_checks.every((c) => c.present), file.prerequisite_checks.filter((c) => !c.present).map((c) => c.name).join(","));
  // Every SFC on the file is a finished process's event, never recomputed here.
  assert.deepEqual(harvestSfcs(h.events.all()).map((c) => c.code), ["007", "127", "180"]);
  assert.equal(file.sfc_queue.find((c) => c.code === "180")!.source_event.split("#")[0], "flood.determination.received");
  const row = h.svc.open(file); const out = h.svc.assemble(row.delivery_id);
  assert.equal(out.status, "built", out.reason ?? ""); const b = out.build!;
  assert.equal(b.build_no, 1); assert.equal(row.uldd_phase, ULDD_PHASE); assert.equal(row.loan_state_at_current_date, "2026-11-13"); assert.equal(row.build_status, "uldd_built");
  assert.equal(h.sid(b.points, "322")!.value, DU_REFI);
  const doc = h.sid(b.points, "82")!.value!; assert.equal(doc.length, 10); assert.ok(doc.startsWith("2")); assert.equal(doc, "2000418877"); assert.deepEqual(docFileIdCheck(doc, "3.6"), { ok: true, reason: null });
  assert.equal(h.sid(b.points, "376")!.value, null); assert.equal(h.sid(b.points, "376")!.condition_evaluated, true);
  assert.equal(h.sid(b.points, "429")!.value, "NoMIBasedOnOriginalLTV"); assert.equal(h.sid(b.points, "412")!.value, null); assert.equal(h.sid(b.points, "430.1")!.value, null);
  assert.equal(h.sid(b.points, "311")!.value, "2026-10-07");
  assert.equal(h.sid(b.points, "642")!.value, "SMWH482A"); assert.equal(h.sid(b.points, "650.1")!.value, FACILITY_FIXTURE.fnma_warehouse_lender_id); assert.equal(h.sid(b.points, "398.3")!.value, null);
  assert.equal(h.sid(b.points, "620")!.value, "FIN-770021"); assert.equal(h.sid(b.points, "401")!.value, "1000123-0000456789-0"); assert.equal(h.sid(b.points, "363")!.value, "3120.00");
  assert.equal(h.sid(b.points, "251")!.value, "762"); assert.equal(h.sid(b.points, "249")!.value, "MiddleOrLowerThenLowest"); assert.equal(h.sid(b.points, "251.1")!.value, "ClassicFICO"); assert.equal(h.sid(b.points, "208")!.value, "0.42");
  assert.equal(h.dp(b.points, "LoanIdentifier[SellerLoan]")!.value, SLN("300000001"));   // 30.2: the servicing loan number is the Lender Loan Number
  assert.equal(h.dp(b.points, "InvestorCommitmentIdentifier")!.value, "BE-2026-100045"); assert.equal(h.dp(b.points, "NoteDate")!.value, "2026-11-06"); assert.equal(h.dp(b.points, "DisbursementDate")!.value, "2026-11-12"); assert.equal(h.dp(b.points, "ScheduledFirstPaymentDate")!.value, "2027-01-01"); assert.equal(h.dp(b.points, "LoanMaturityDate")!.value, "2056-12-01");
  assert.equal(h.dp(b.points, "NoteAmount")!.value, "560000.00"); assert.equal(h.dp(b.points, "NoteRatePercent")!.value, "6.12500"); assert.equal(h.dp(b.points, "ScheduledPrincipalAndInterestPayment")!.value, "3402.62"); assert.equal(h.dp(b.points, "LTVRatioPercent")!.value, "70.00");
  assert.equal(h.dp(b.points, "ENoteIndicator")!.value, "false"); assert.equal(h.dp(b.points, "RemoteOnlineNotarizationIndicator")!.value, "true");
  assert.deepEqual([...b.sfcs].sort(), ["007", "127", "180", "861"]); assert.ok(!b.sfcs.includes("067") && !b.sfcs.includes("508") && !b.sfcs.includes("801") && !b.sfcs.includes("900")); assert.ok(b.sfcs.length <= SFC_CAP);
  assert.equal(b.schema.valid, true); assert.equal(b.sha256, sha256Hex(b.xml)); assert.match(b.xml, /ULDD:ULDDVersionIdentifier="5\.2\.0"/); assert.match(b.xml, /SortID="322"[^>]*>2087654321</);
  // Events and timers: `delivery.uldd.built` satisfies the SLA the same day; the assembling gates opened; the clean gate is now armed on the build.
  const built = h.ofType("delivery.uldd.built")[0]!; assert.equal(built.payload.sha256, b.sha256); assert.equal(built.loanId, "L-REFI-1"); assert.equal(built.payload.phase, "5.2.0");
  assert.equal(sla.status, "satisfied"); assert.equal(sla.satisfiedByEventId, built.id);
  assert.equal(h.timer("FNMA_ULDD_IDENTIFIER_CONSISTENCY_GATE")!.status, "satisfied"); assert.equal(h.timer("FNMA_C1_2_02_SFC_COMPLETENESS_GATE")!.status, "satisfied"); assert.equal(h.timer("FNMA_LL_2026_06_SFC_067_CONSISTENCY_GATE")!.status, "satisfied"); assert.equal(h.timer("FNMA_B4_1_4_10_VALUE_ACCEPTANCE_SFC_GATE")!.status, "satisfied");
  assert.equal(h.timer("FNMA_C1_2_02_DU_FILE_EARLYCHECK_GATE")!.status, "satisfied"); assert.equal(h.timer("FNMA_C1_2_02_EARLYCHECK_CLEAN_GATE")!.status, "armed");
  const dec = h.svc.decisionRecord(row.delivery_id)!; assert.equal(dec.build_no, 1); assert.deepEqual(dec.rule_set_versions.uldd, "fnma.uldd.5.2.0"); assert.ok(dec.conditionality_decisions.some((c) => c.sort_id === "376" && c.result === false)); assert.deepEqual(dec.sfc_set.map((s) => s.code).sort(), ["007", "127", "180", "861"]);
});
test("29.3-T2: Given build 1 returns an EarlyCheck fatal edit on SID 429, when the agent derives `NoMIBasedOnOriginalLTV` from `mi_certificates` (no row) and base LTV 70.00%, then build 2 is created, EarlyCheck run 2 is `clean = true`, both runs are retained, and `delivery_packages.uldd_sha256` equals the SHA-256 of build 2's bytes.", () => {
  const h = harness("2026-10-07T16:00:00.000Z", refiBase()); fundRefi(h);
  h.at("2026-11-13T16:42:00.000Z"); const row = h.svc.open(h.file()); const b1 = h.svc.assemble(row.delivery_id).build!;
  // Worked example B: DI result 09:44 — one fatal on PrimaryMIAbsenceReasonType, two warnings (DU Compare identical value; standardized address), one observational.
  h.ec.script(b1.sha256, { edits: [{ edit_code: "LD-MI-0429", severity: "fatal", message: "PrimaryMIAbsenceReasonType must be reported when no MI is reported and LTV ≤ 80%", sort_ids: ["429"], kind: "enumeration_default" },
    { edit_code: "D1042", severity: "warning", message: "DU Compare: appraised value in DU $800,000 vs ULDD At Closing $800,000", sort_ids: ["PropertyValuationAmount"], kind: "du_compare", details: { du: "800000.00", uldd: "800000.00" } },
    { edit_code: "ADDR-STD", severity: "warning", message: "Standardized address: N 7TH ST", sort_ids: ["AddressLineText"], kind: "standardized_address" }, { edit_code: "OBS-1", severity: "observational", message: "eNote indicator false", sort_ids: [] }], standardized_address: { street: "4120 N 7TH ST", city: "PHOENIX", state: "AZ", zip: "85014" }, result_document_id: "DOC-EC-RESULT-1" });
  h.at("2026-11-13T16:44:00.000Z"); const run1 = h.svc.runEarlyCheck(row.delivery_id);
  assert.equal(run1.clean, false); assert.deepEqual(run1.edit_count_by_severity, { fatal: 1, warning_to_fatal: 0, warning: 2, informational: 0, observational: 1 }); assert.equal(row.build_status, "earlycheck_failed");
  assert.throws(() => h.svc.freeze(row.delivery_id), (e: unknown) => e instanceof DeliveryRefused && e.code === "FNMA_C1_2_02_EARLYCHECK_CLEAN_GATE");
  // The fatal edit maps to rule R3(f): derived (enumeration default), not overridden — no mi_certificates row, base LTV 70.00% → NoMIBasedOnOriginalLTV.
  const fatal = h.svc.edits.find((e) => e.edit_code === "LD-MI-0429")!; assert.equal(fatal.owner_process, "29.3"); assert.equal(mapEditToOwner({ edit_code: "LD-MI-0429", severity: "fatal", message: "", sort_ids: ["429"], kind: "enumeration_default" }).derivable, true);
  assert.equal(baseLtvPct(56_000_000n, null, 80_000_000n), "70.00"); assert.equal(deriveMiAbsenceReason(null, "70.00"), "NoMIBasedOnOriginalLTV"); assert.equal(deriveMiAbsenceReason(null, "80.01"), null); assert.equal(deriveMiAbsenceReason({ status: "active" }, "70.00"), null);
  const duc = h.svc.edits.find((e) => e.edit_code === "D1042")!; h.svc.resolveEdit(duc.edit_id, "not_applicable", { resolution_ref: "reconciled: identical $800,000" });
  const addr = h.svc.edits.find((e) => e.edit_code === "ADDR-STD")!; h.svc.resolveEdit(addr.edit_id, "data_corrected", { resolution_ref: "rule:standardized_address" });
  h.at("2026-11-13T16:51:00.000Z"); const fix = h.svc.applyDerivedFix(fatal.edit_id, h.base);
  assert.equal(fix.edit.resolution, "data_corrected"); assert.equal(fix.edit.resolution_ref, "rule:enumeration_default"); assert.equal(fix.build!.build_no, 2); assert.equal(row.uldd_build_no, 2); assert.equal(h.sid(fix.build!.points, "429")!.value, "NoMIBasedOnOriginalLTV"); assert.equal(h.sid(fix.build!.points, "429")!.override_value, null);
  assert.notEqual(fix.build!.sha256, b1.sha256); assert.equal(h.ofType("delivery.uldd.rebuilt")[0]!.payload.reason, "earlycheck_edit:LD-MI-0429");
  h.at("2026-11-13T16:53:00.000Z"); const run2 = h.svc.runEarlyCheck(row.delivery_id);
  assert.equal(run2.clean, true); assert.equal(run2.file_sha256, fix.build!.sha256); assert.equal(row.build_status, "earlycheck_clean");
  const runs = h.svc.runs.filter((r) => r.file_kind === "uldd_3_0"); assert.equal(runs.length, 2); assert.deepEqual(runs.map((r) => [r.build_no, r.clean]), [[1, false], [2, true]]);
  assert.ok(h.svc.documents.has(b1.document_id) && h.svc.documents.has(fix.build!.document_id)); assert.equal(h.svc.documents.get(b1.document_id)!.retention_class, "fnma_loan_file_life_plus_4y");
  h.at("2026-11-13T17:05:00.000Z"); const pkg = h.svc.freeze(row.delivery_id);   // 10:05 MST
  assert.equal(pkg.version, 1); assert.equal(pkg.uldd_sha256, sha256Hex(h.svc.documents.get(fix.build!.document_id)!.bytes)); assert.equal(pkg.uldd_sha256, fix.build!.sha256); assert.equal(pkg.earlycheck_run_id, run2.run_id); assert.equal(pkg.status, "handed_to_operator");
  assert.equal(pkg.gate_results.FNMA_B3_2_10_DU_FINAL_MATCH_GATE!.result, "open"); assert.equal(pkg.gate_results.FNMA_UCD_ACCEPTED_GATE!.result, "open"); assert.equal(pkg.gate_results.FNMA_B4_1_1_06_UCDP_SUCCESSFUL_GATE!.result, "open"); assert.equal(pkg.gate_results.FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE!.result, "n/a"); assert.equal(pkg.gate_results.FNMA_B4_2_1_01_CPM_CERT_VALID_GATE!.result, "n/a"); assert.equal(pkg.gate_results.SM_O61_PRE_DELIVERY_COMPLIANCE_CHECKPOINT!.result, "open");
  // Both SLAs satisfied (build Fri Nov 13; freeze due Mon Nov 16); the clean run over build 1's bytes never certifies build 2.
  const fz = h.timer("SM_O103_PACKAGE_FREEZE_SLA_2BD")!; assert.equal(fz.dueDate, "2026-11-16"); assert.equal(fz.status, "satisfied"); assert.equal(h.timer("SM_O103_PACKAGE_FREEZE_GATE")!.status, "satisfied");
  assert.equal(earlycheckCleanGate({ run_clean: true, run_file_sha256: b1.sha256, uldd_sha256: fix.build!.sha256 }).open, false); assert.equal(evaluateGate("29.3.earlycheckClean", { run_clean: true, run_file_sha256: fix.build!.sha256, uldd_sha256: fix.build!.sha256 }).open, true);
  assert.deepEqual(h.svc.decisionRecord(row.delivery_id)!.earlycheck.resolutions.map((r) => r.resolution).sort(), ["data_corrected", "data_corrected", "not_applicable", "unresolved"]);
});
test("29.3-T3: Given `ucd_submissions.casefile_id_ucd` ≠ `du_casefiles.casefile_id` (UCD submitted before the DU casefile existed and UCD assigned its own ID), then `FNMA_ULDD_IDENTIFIER_CONSISTENCY_GATE` fails with `delivery.identifier.mismatch.detected{identifier=casefile}`, no ULDD is built, and 25.2 receives a resubmission request.", () => {
  const h = harness("2026-10-07T16:00:00.000Z", refiBase()); fundRefi(h, { ucdCasefile: "2099000777" });
  h.at("2026-11-13T16:42:00.000Z"); const file = h.file(); assert.equal(file.ucd!.casefile_id_ucd, "2099000777"); assert.equal(file.du!.casefile_id, DU_REFI);
  const ids = reconcileIdentifiers(file, D("2026-11-13")); assert.equal(ids.complete, false); assert.deepEqual(ids.mismatches.map((m) => [m.identifier, m.expected, m.found, m.owner_process]), [["casefile", DU_REFI, "2099000777", "25.2"]]);
  assert.match(evaluateGate("29.3.identifierConsistency", { mismatches: ids.mismatches }).reason ?? "", /casefile/);
  const row = h.svc.open(file); const out = h.svc.assemble(row.delivery_id);
  assert.equal(out.status, "refused"); assert.equal(out.gate, "FNMA_ULDD_IDENTIFIER_CONSISTENCY_GATE"); assert.equal(out.build, null);
  const mm = h.ofType("delivery.identifier.mismatch.detected"); assert.equal(mm.length, 1); assert.equal(mm[0]!.payload.identifier, "casefile"); assert.equal(mm[0]!.payload.expected, DU_REFI); assert.equal(mm[0]!.payload.found, "2099000777"); assert.equal(mm[0]!.payload.owner, "25.2");
  assert.equal(h.ofType("delivery.uldd.built").length, 0); assert.equal(row.uldd_sha256, null); assert.equal(row.uldd_build_no, 0);
  const req = h.ofType("delivery.correction.requested")[0]!; assert.equal(req.payload.owner_process, "25.2"); assert.equal(req.payload.kind, "ucd_resubmission");
  assert.equal(h.timer("FNMA_ULDD_IDENTIFIER_CONSISTENCY_GATE")!.status, "armed"); assert.equal(h.timer("SM_O103_ULDD_BUILD_SLA_1BD")!.status, "armed");
});
test("29.3-T4: Given `applications.score_model = vantagescore_4` for both borrowers, then SFC 067 is included and SID 251.1 reflects the VantageScore 4.0 category; given `score_model` differs between borrowers, then `FNMA_LL_2026_06_SFC_067_CONSISTENCY_GATE` refuses the build.", () => {
  const vs = refiBase({ credit: { borrowers: [{ borrower_id: "B1", score_model: "vantagescore_4" }, { borrower_id: "B2", score_model: "vantagescore_4" }], representative_score: 771, selection_method: "MiddleOrLowerThenLowest" } });
  const h = harness("2026-10-07T16:00:00.000Z", vs); fundRefi(h, { sfcs: ["007", "067"], scoreModels: ["vantagescore_4", "vantagescore_4"] });   // 20.4 staged SFC 067 (29.1-T16)
  h.at("2026-11-13T16:42:00.000Z"); const row = h.svc.open(h.file()); const out = h.svc.assemble(row.delivery_id);
  assert.equal(out.status, "built", out.reason ?? ""); assert.ok(out.build!.sfcs.includes("067")); assert.equal(h.sid(out.build!.points, "251.1")!.value, "VantageScore4"); assert.equal(h.sid(out.build!.points, "251")!.value, "771");
  assert.equal(h.svc.assignments.find((a) => a.sfc_code === "067")!.rule_ref, "LL-2026-06/score_model=vantagescore_4"); assert.equal(h.timer("FNMA_LL_2026_06_SFC_067_CONSISTENCY_GATE")!.status, "satisfied");
  // The gate as an assertion: 067 present ⇔ vantagescore_4; absent on a VantageScore loan or present on a Classic FICO loan both fail.
  assert.equal(sfc067Gate(vs, ["127", "067"]).open, true); assert.equal(sfc067Gate(vs, ["127"]).open, false); assert.equal(sfc067Gate(refiBase(), ["127", "067"]).open, false);
  // Mixed models: LL-2026-06 "the same credit score model must be used for all borrowers" — refused, 22.2 notified.
  const mixed = refiBase({ application_id: "APP-REFI-MIXED", loan_id: "L-REFI-MIXED", credit: { borrowers: [{ borrower_id: "B1", score_model: "vantagescore_4" }, { borrower_id: "B2", score_model: "classic_fico" }], representative_score: 760, selection_method: "MiddleOrLowerThenLowest" } });
  const h2 = harness("2026-10-07T16:00:00.000Z", mixed); fundRefi(h2, { sfcs: ["007", "067"], scoreModels: ["vantagescore_4", "classic_fico"] });
  h2.at("2026-11-13T16:42:00.000Z"); const row2 = h2.svc.open(h2.file()); const out2 = h2.svc.assemble(row2.delivery_id);
  assert.equal(out2.status, "refused"); assert.equal(out2.gate, "FNMA_LL_2026_06_SFC_067_CONSISTENCY_GATE"); assert.match(out2.reason!, /same credit score model/); assert.equal(h2.ofType("delivery.uldd.built").length, 0);
  assert.equal(h2.ofType("delivery.correction.requested").at(-1)!.payload.owner_process, "22.2"); assert.equal(evaluateGate("29.3.sfc067Consistency", { borrower_score_models: ["vantagescore_4", "classic_fico"], sfc_codes: ["067"] }).open, false);
  assert.equal(h2.timer("FNMA_LL_2026_06_SFC_067_CONSISTENCY_GATE")!.status, "armed");
});
test("29.3-T5: Given a value-acceptance loan with the DU offer dated Wed Jul 8, 2026 and note date Fri Nov 6, 2026 (offer 3 months 29 days old), then SID 376 = `ValueAcceptance`, SFC 801 is included, SID 82 is blank and the gate opens; given the offer dated Mon Jul 6, 2026 (four months exceeded on Nov 6), then `FNMA_B4_1_4_10_VALUE_ACCEPTANCE_SFC_GATE` fails and 24.1 is notified.", () => {
  const dd = valuationDeliveryData({ method: "value_acceptance" }, null); assert.deepEqual(dd.special_feature_codes, ["801"]);   // 24.1's deliveryData() supplies the code
  const va = (offer: string, ids: { application_id: string; loan_id: string }) => refiBase({ ...ids, valuation: { method: "value_acceptance", offer_date: D(offer), property_data_id: null, special_feature_codes: dd.special_feature_codes }, ucdp: null });
  const h = harness("2026-10-07T16:00:00.000Z", va("2026-07-08", { application_id: "APP-VA-1", loan_id: "L-VA-1" })); fundRefi(h);
  h.at("2026-11-13T16:42:00.000Z");
  const file = { ...h.file(), ucdp: null };   // no appraisal was ordered: 24.2 never produced a Doc File ID
  assert.deepEqual(valueAcceptanceOfferAge(D("2026-07-08"), D("2026-11-06")), { stale: false, four_months_on: "2026-11-08" });
  const row = h.svc.open(file); const out = h.svc.assemble(row.delivery_id);
  assert.equal(out.status, "built", out.reason ?? ""); const b = out.build!;
  assert.equal(h.sid(b.points, "376")!.value, "ValueAcceptance"); assert.ok(b.sfcs.includes("801")); assert.equal(h.sid(b.points, "82")!.value, null); assert.equal(h.sid(b.points, "82")!.condition_evaluated, true); assert.equal(h.sid(b.points, "85")!.value, null);
  assert.equal(valueAcceptanceGate(file, b.sfcs).open, true); assert.equal(h.timer("FNMA_B4_1_4_10_VALUE_ACCEPTANCE_SFC_GATE")!.status, "satisfied"); assert.equal(row.identifier_snapshot!.ucdp_doc_file_id, null);
  // Jul 6 → four months on Nov 6 = the note date: the offer is more than four months old (spec: "four months exceeded on Nov 6"); the build is refused and 24.1 notified.
  assert.deepEqual(valueAcceptanceOfferAge(D("2026-07-06"), D("2026-11-06")), { stale: true, four_months_on: "2026-11-06" });
  const h2 = harness("2026-10-07T16:00:00.000Z", va("2026-07-06", { application_id: "APP-VA-2", loan_id: "L-VA-2" })); fundRefi(h2);
  h2.at("2026-11-13T16:42:00.000Z"); const row2 = h2.svc.open({ ...h2.file(), ucdp: null }); const out2 = h2.svc.assemble(row2.delivery_id);
  assert.equal(out2.status, "refused"); assert.equal(out2.gate, "FNMA_B4_1_4_10_VALUE_ACCEPTANCE_SFC_GATE"); assert.match(out2.reason!, /more than four months old/); assert.equal(h2.ofType("delivery.uldd.built").length, 0);
  const req = h2.ofType("delivery.correction.requested").at(-1)!; assert.equal(req.payload.owner_process, "24.1"); assert.equal(req.payload.kind, "appraisal_required");
  assert.equal(evaluateGate("29.3.valueAcceptanceSfc", { valuation_method: "value_acceptance", offer_date: "2026-07-06", note_date: "2026-11-06", sfc_codes: ["127", "801"] }).open, false);
  assert.equal(evaluateGate("29.3.valueAcceptanceSfc", { valuation_method: "traditional", note_date: "2026-11-06", sfc_codes: ["127", "801"] }).open, false);   // 801 without an exercised offer is equally inconsistent
  assert.equal(evaluateGate("29.3.valueAcceptanceSfc", { valuation_method: "value_acceptance", offer_date: "2026-07-08", note_date: "2026-11-06", sfc_codes: ["127"] }).open, false);   // the offer exercised without SFC 801
});
test("29.3-T6: Given an eNote closing (RON) registered on the eRegistry within one business day, then `enote_indicator = true`, SFC 508 and SFC 861 are included, SID 401 carries the MIN, and the package freezes without any custodian FIN dependency for the note (29.4 handles the eVault path).", () => {
  const en = refiBase({ application_id: "APP-ENOTE-1", loan_id: "L-ENOTE-1", note: { form: "enote", enote_registered_at: null, min: null, closing_type: "ron" }, warehouse: { advance_outstanding: true, payee_code: "SMWH482A", warehouse_lender_id: FACILITY_FIXTURE.fnma_warehouse_lender_id, custodian_fin: null, bailee_letter_name: FACILITY_FIXTURE.bailee_letter_name } });
  const h = harness("2026-10-07T16:00:00.000Z", en); fundRefi(h, { enote: true });
  h.at("2026-11-13T16:42:00.000Z"); const file = h.file();
  assert.equal(file.note.form, "enote"); assert.equal(file.note.enote_registered_at, "2026-11-12T22:30:00.000Z"); assert.equal(file.note.min, "1000123-0000456789-0"); assert.equal(file.warehouse.custodian_fin, null);
  const ids = reconcileIdentifiers(file, D("2026-11-13")); assert.equal(ids.complete, true, ids.mismatches.map((m) => m.identifier).join(",")); assert.equal(ids.snapshot.enote_indicator, true); assert.equal(ids.snapshot.custodian_fin, null);
  const { row, out, pkg } = buildAndFreeze(h);
  assert.equal(row.enote_indicator, true); assert.equal(h.dp(out.build!.points, "ENoteIndicator")!.value, "true"); assert.equal(h.sid(out.build!.points, "401")!.value, "1000123-0000456789-0");
  assert.ok(out.build!.sfcs.includes("508") && out.build!.sfcs.includes("861")); assert.deepEqual([...out.build!.sfcs].sort(), ["007", "127", "180", "508", "861"]);
  assert.equal(h.sid(out.build!.points, "620")!.value, null); assert.equal(h.sid(out.build!.points, "620")!.condition, "paper note"); assert.equal(h.sid(out.build!.points, "652")!.value, null);
  assert.equal(pkg.status, "handed_to_operator"); assert.equal(pkg.identifier_snapshot.custodian_fin, null); assert.equal(pkg.gate_results.MERS_PROC_ENOTE_REGISTER_1BD!.result, "open"); assert.equal(pkg.gate_results.MERS_PROC_MOM_REGISTER_7, undefined);
  assert.equal(h.ofType("delivery.package.frozen")[0]!.payload.enote_indicator, true);
  // A paper note without the custodian FIN would not reconcile (R3(j)); the eNote path never asks for one.
  const paper = reconcileIdentifiers({ ...file, note: { ...file.note, form: "paper" } }, D("2026-11-13")); assert.ok(paper.mismatches.some((m) => m.identifier === "custodian_fin" && m.owner_process === "29.4"));
});
test("29.3-T7: Given twelve candidate SFCs, then `FNMA_C1_2_02_SFC_COMPLETENESS_GATE` fails, an `officer` escalation is opened with the candidate list and rule references, and no code is dropped automatically.", async () => {
  const twelve = refiBase({ application_id: "APP-SFC12", loan_id: "L-SFC12", subordinations: [{ amount_cents: 2_000_000n, community_seconds: true }] });
  const h = harness("2026-10-07T16:00:00.000Z", twelve);
  fundRefi(h, { sfcs: ["007", "900", "874", "808"], extraSeams: () => {
    h.seam("delivery.sfc.queued", { code: 707, reason: "employment offer option 2 (B3-3.3-03)" }); h.seam("subordinate_financing.declared", { kind: "community_second", eligible: true, special_feature_codes: ["118"] });
    h.seam("trust.reviewed", { result: "eligible", sfc_168: true }); h.seam("title.aol.evaluated", { allowed: true, sfc_155: true }); h.seam("homeownership_education.verified", { sfc_184: true, counseling_within_12m: true }); } });
  h.at("2026-11-13T16:42:00.000Z"); const file = h.file(); const sfc = assignSfcs(file);
  // 127 (DU), 007 / 900 / 874 / 808 (20.4), 180 (24.5), 861 (RON), 707 (22.3), 118 (22.4), 168 / 155 (24.4), 184 (23.2) — twelve candidates, each with its owner's rule reference.
  assert.deepEqual(sfc.included, ["007", "118", "127", "155", "168", "180", "184", "707", "808", "861", "874", "900"]);
  assert.equal(sfc.count, 12); assert.equal(sfc.over_cap, true); assert.equal(sfc.assignments.filter((a) => a.included_in_uldd).length, sfc.count); assert.ok(sfc.assignments.every((a) => a.rule_ref.length > 0)); assert.deepEqual(sfc.contradictions, []);
  const row = h.svc.open(file); const out = h.svc.assemble(row.delivery_id);
  assert.equal(out.status, "refused"); assert.equal(out.gate, "FNMA_C1_2_02_SFC_COMPLETENESS_GATE"); assert.match(out.reason!, /exceed the cap of 10/); assert.equal(h.ofType("delivery.uldd.built").length, 0);
  const esc = h.escalations.list().find((e) => e.id === out.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.ownerRole, "officer"); assert.equal(esc.payload.reason, "sfc_over_cap");
  const candidates = esc.payload.candidates as { code: string; rule_ref: string }[]; assert.equal(candidates.length, 12); assert.ok(candidates.every((c) => /\//.test(c.rule_ref))); assert.equal(candidates.find((c) => c.code === "118")!.rule_ref, "22.4/subordinate_financing.declared{kind=community_second}");
  assert.equal(h.timer("FNMA_C1_2_02_SFC_COMPLETENESS_GATE")!.status, "armed"); assert.equal(evaluateGate("29.3.sfcCompleteness", { sfc_count: 12, contradictions: [] }).open, false); assert.equal(evaluateGate("29.3.sfcCompleteness", { sfc_count: 10, contradictions: [] }).open, true);
  // On the bus: the agent may not fit the set to the cap; the tool reports the same twelve with their rule references and the officer task.
  await h.refused(h.run("assignSfcs", { delivery_id: row.delivery_id, fit_to_cap: true }), "SFC_NEVER_DROPPED");
  await h.refused(h.run("assignSfcs", { delivery_id: row.delivery_id, drop_codes: ["874", "184"] }), "SFC_NEVER_DROPPED");
  const viaBus = await h.run("assignSfcs", { delivery_id: row.delivery_id }); assert.equal(viaBus.count, 12); assert.equal(viaBus.over_cap, true); assert.equal((viaBus.gates as Record<string, { open: boolean }>).FNMA_C1_2_02_SFC_COMPLETENESS_GATE!.open, false);
});
test("29.3-T8: Given a package frozen Fri Nov 13 and a corrected CD delivered Tue Nov 17 before the operator import, then `delivery.package.superseded{reason=cd_corrected}` fires, 29.4's operator task is cancelled, and a new package is frozen only after `ucd.accepted{is_final}` for CD v3.", () => {
  const h = harness("2026-10-07T16:00:00.000Z", refiBase()); fundRefi(h); const { row, pkg } = buildAndFreeze(h);
  // 29.4 opens its import_and_submit operator task on the frozen package.
  const task = h.escalations.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", applicationId: row.application_id, loanId: row.loan_id, payload: { task: "import_and_submit", package_id: pkg.package_id, hash: pkg.uldd_sha256 } }, { kind: "agent", id: "secondary" });
  // Tue Nov 17: 25.2 delivers a corrected CD (v3) before the import.
  h.seam("disclosure.cd.corrected", { disclosure_id: "CD-3", cd_version: 3, reason: "post_consummation_correction" }, { at: "2026-11-17T18:00:00.000Z" });
  const watch = h.timer("SM_O103_REBUILD_ON_CHANGE")!; assert.equal(watch.status, "armed"); assert.equal(watch.anchorDate, "2026-11-17");
  const sup = h.svc.onCdCorrected(row.application_id, { cd_version: 3 })!;
  assert.equal(sup.package!.package_id, pkg.package_id); assert.equal(pkg.status, "superseded"); assert.equal(pkg.supersede_reason, "cd_corrected"); assert.equal(row.build_status, "superseded"); assert.equal(row.package_id, null);
  const ev = h.ofType("delivery.package.superseded")[0]!; assert.equal(ev.payload.reason, "cd_corrected"); assert.equal(ev.payload.package_id, pkg.package_id); assert.equal(ev.payload.awaiting_cd_version, 3);
  assert.equal(watch.status, "satisfied"); assert.equal(watch.satisfiedByEventId, ev.id);
  assert.deepEqual(sup.cancelled_task_ids, [task.id]); assert.deepEqual(h.ofType("delivery.operator_task.cancelled")[0]!.payload.escalation_ids, [task.id]);
  // No new package until 25.2's UCD for CD v3 is accepted as final (SM_O62_UCD_RESUBMIT_ON_CORRECTION).
  h.at("2026-11-17T19:00:00.000Z"); h.svc.refresh(row.delivery_id, h.base); const blocked = h.svc.assemble(row.delivery_id);
  assert.equal(blocked.status, "refused"); assert.equal(blocked.gate, "SM_O62_UCD_RESUBMIT_ON_CORRECTION"); assert.match(blocked.reason!, /CD v3/); assert.equal(h.svc.packages.length, 1);
  assert.throws(() => h.svc.freeze(row.delivery_id), (e: unknown) => e instanceof DeliveryRefused);
  h.seam("ucd.accepted", { ucd_submission_id: "UCD-3", status: "accepted", casefile_id_ucd: DU_REFI, critical_edit_failures: 0, embedded_cd_disclosure_id: "CD-3", embedded_cd_version: 3, is_final: true, current_rate_set_date: "2026-10-07" }, { at: "2026-11-18T16:00:00.000Z" });
  assert.equal(h.svc.onUcdAccepted(row.application_id, { is_final: true, embedded_cd_version: 3, casefile_id_ucd: DU_REFI }), true);
  h.svc.refresh(row.delivery_id, h.base); const rebuilt = h.svc.assemble(row.delivery_id); assert.equal(rebuilt.status, "built", rebuilt.reason ?? ""); assert.equal(rebuilt.build!.build_no, 2);
  h.svc.runEarlyCheck(row.delivery_id); h.at("2026-11-18T16:30:00.000Z"); const pkg2 = h.svc.freeze(row.delivery_id);
  assert.equal(pkg2.version, 2); assert.equal(pkg2.gate_results.FNMA_UCD_ACCEPTED_GATE!.evidence_ref, "ucd cd_v3"); assert.notEqual(pkg2.uldd_sha256, pkg.uldd_sha256); assert.equal(h.ofType("delivery.package.frozen").length, 2);
  // After submission a correction never rebuilds here (29.4's data-revision / PPA paths).
  h.svc.markSubmitted(row.delivery_id); assert.equal(h.svc.onCdCorrected(row.application_id, { cd_version: 4 }), null); assert.throws(() => h.svc.supersede(row.delivery_id, "cd_corrected"), (e: unknown) => e instanceof DeliveryRefused && e.code === "REBUILD_AFTER_SUBMISSION");
});
test("29.3-T9: Given the EarlyCheck DI endpoint returns no result within 60 minutes, then a `fnma_portal_operator` task is opened with the same file (hash shown), the UI export is attached as `channel = ui`, and the gate evaluates the hash of the file actually run.", () => {
  const h = harness("2026-10-07T16:00:00.000Z", refiBase()); fundRefi(h);
  h.at("2026-11-13T16:42:00.000Z"); const row = h.svc.open(h.file()); const b = h.svc.assemble(row.delivery_id).build!;
  h.ec.outage = true; const run = h.svc.runEarlyCheck(row.delivery_id);
  assert.equal(run.completed_at, null); assert.equal(run.channel, "di"); assert.equal(row.build_status, "earlycheck_pending"); assert.equal(h.ec.requests.at(-1)!.file_sha256, b.sha256);
  assert.deepEqual(h.svc.sweep("2026-11-13T17:30:00.000Z"), []);   // 48 minutes: still waiting
  const [fb] = h.svc.sweep("2026-11-13T17:43:00.000Z"); assert.equal(fb!.run_id, run.run_id);
  const task = h.escalations.list().find((e) => e.id === fb!.escalation_id)!; assert.equal(task.kind, "human_portal_task"); assert.equal(task.ownerRole, "fnma_portal_operator"); assert.equal(task.payload.file_sha256, b.sha256); assert.equal(task.payload.file_document_id, b.document_id); assert.equal(task.payload.task, "earlycheck_ui_run");
  assert.equal(h.ofType("earlycheck.ui_fallback.opened")[0]!.payload.file_sha256, b.sha256);
  // The operator ran the identical file: the export is attached as channel = ui and the gate opens on that hash.
  h.at("2026-11-13T18:20:00.000Z"); const done = h.svc.attachUiResult(run.run_id, { file_sha256_run: b.sha256, result: { ...CLEAN, result_document_id: "DOC-EC-UI-EXPORT-1" }, operator: OPERATOR });
  assert.equal(done.channel, "ui"); assert.equal(done.clean, true); assert.equal(done.file_sha256, b.sha256); assert.equal(done.submitted_by, "human:u-portal"); assert.equal(done.result_document_id, "DOC-EC-UI-EXPORT-1");
  const ev = h.ofType("earlycheck.completed").find((e) => e.payload.file_kind === "uldd_3_0")!; assert.equal(ev.payload.channel, "ui"); assert.equal(ev.payload.clean, true); assert.equal(ev.payload.file_sha256, b.sha256);
  assert.equal(h.timer("FNMA_C1_2_02_EARLYCHECK_CLEAN_GATE")!.status, "satisfied"); const pkg = h.svc.freeze(row.delivery_id); assert.equal(pkg.earlycheck_run_id, run.run_id);
  // Had the operator run a different file, the run is recorded against the hash actually run and the freeze stays refused.
  const h2 = harness("2026-10-07T16:00:00.000Z", refiBase({ application_id: "APP-EC-2", loan_id: "L-EC-2" })); fundRefi(h2);
  h2.at("2026-11-13T16:42:00.000Z"); const row2 = h2.svc.open(h2.file()); const b2 = h2.svc.assemble(row2.delivery_id).build!; h2.ec.outage = true; const run2 = h2.svc.runEarlyCheck(row2.delivery_id);
  h2.svc.sweep("2026-11-13T17:45:00.000Z"); const wrong = h2.svc.attachUiResult(run2.run_id, { file_sha256_run: sha256Hex("some other export"), result: CLEAN, operator: OPERATOR });
  assert.equal(wrong.clean, true); assert.notEqual(wrong.file_sha256, b2.sha256); assert.equal(earlycheckCleanGate({ run_clean: true, run_file_sha256: wrong.file_sha256, uldd_sha256: b2.sha256 }).open, false);
  assert.throws(() => h2.svc.freeze(row2.delivery_id), (e: unknown) => e instanceof DeliveryRefused && e.code === "FNMA_C1_2_02_EARLYCHECK_CLEAN_GATE" && /same file, same hash/.test(e.detail));
  assert.throws(() => h2.svc.attachUiResult(run2.run_id, { file_sha256_run: b2.sha256, result: CLEAN, operator: AGENT }), (e: unknown) => e instanceof DeliveryRefused);
});
test("29.3-T10: Given the purchase fixture (Columbus) with MI activation confirmed Thu Nov 19, 2026 09:10 ET, then SID 412 = `4812093` (no leading zeros), coverage 25.00, SID 429 blank, SFC 900 present, and the freeze is timestamped after `mi.activated`.", () => {
  const h = harness("2026-10-19T16:00:00.000Z", purchaseBase());
  h.seam("lock.executed", { lock_id: "LOCK-P", locked_at: "2026-10-20T17:00:00.000Z", rate_set_date: "2026-10-20", note_rate: "6.250" }, { at: "2026-10-20T17:00:00.000Z", loanId: null });
  h.seam("quote.locked", { quote_id: "Q-P", lock_id: "LOCK-P", sfcs: ["900"], origination: true }, { loanId: null });   // HomeReady staged by 20.4
  h.seam("commitment.executed", { commitment_id_fnma: "BE-2026-100211", type: "best_efforts", price: "101.125", ptr: "6.0000", expires_on: "2026-12-21", original_expires_on: "2026-12-21", underwriting_method: "du", du_casefile_id: DU_PUR }, { at: "2026-10-20T17:30:00.000Z", loanId: null });
  h.seam("du.credit.associated", { casefile_id: DU_PUR, score_model: "classic_fico", borrowers: [{ borrower_id: "B1", score_model: "classic_fico" }] }, { at: "2026-10-21T15:00:00.000Z", loanId: null });
  h.seam("valuation.review.completed", { appraisal_id: "APR-P", version_no: 1, review_status: "accepted", completion_at: "2026-11-05T20:00:00.000Z", is_final_version: true, ucdp_status: "successful", doc_file_id: "2000551902", uad_version: "3.6" }, { at: "2026-11-05T20:00:00.000Z", loanId: null });
  h.seam("flood.determination.received", { determination_id: "SFHDF-P", zone: "X", in_sfha: false, sfc_180: true, special_feature_codes: ["180"] }, { at: "2026-10-21T19:30:00.000Z", loanId: null });
  h.seam("compliance.high_cost.determined", { stage: "final", is_hoepa: false, is_state_high_cost: false, fnma_eligible: true }, { at: "2026-11-16T18:00:00.000Z", loanId: null });
  h.seam("du.findings.interpreted", { submission_id: "DU-P-3", recommendation: "approve_eligible", sfc_required: ["127", "900"], value_acceptance_offer: null, mi_coverage_pct: "25" }, { at: "2026-11-16T18:10:00.000Z", loanId: null });
  h.seam("du.final_submission.recorded", { submission_number: 3, recommendation: "approve_eligible", closed_loan_snapshot_hash: "sha256:closed-pur-cd2", casefile_id: DU_PUR, is_final: true, du_spec_file_sha256: "sha256:du-spec-pur-final", du_spec_document_id: "DOC-DUSPEC-PUR" }, { at: "2026-11-16T18:20:00.000Z", loanId: null });
  h.seam("ucd.accepted", { ucd_submission_id: "UCD-P2", status: "accepted", casefile_id_ucd: DU_PUR, critical_edit_failures: 0, embedded_cd_disclosure_id: "CD-P2", embedded_cd_version: 2, is_final: true, current_rate_set_date: "2026-10-20" }, { at: "2026-11-17T17:00:00.000Z", loanId: null });
  h.seam("loan.funded", { funding_date: "2026-11-18", disbursement_date: "2026-11-18", first_payment_date: "2027-01-01", funded_at: "2026-11-18T20:15:00.000Z", loan_id: "L-PUR-1" }, { at: "2026-11-18T20:15:00.000Z", actor: { kind: "agent", id: "funding" } });
  h.seam("warehouse.advance.funded", { advance_id: "ADV-P", note_form: "paper", wet: true, collateral_status: "bailee", advance_date: "2026-11-18" }, { at: "2026-11-18T20:30:00.000Z" });
  h.seam("mers.min.registered", { min: "1000123-0000456790-8", status: "active", registration_kind: "mom" }, { at: "2026-11-19T13:00:00.000Z", actor: { kind: "external", id: "mers" } });
  h.seam("compliance.test.passed", { checkpoint: "pre_delivery", result: "pass" }, { at: "2026-11-19T13:30:00.000Z" });
  const sla = h.timer("SM_O103_ULDD_BUILD_SLA_1BD")!; assert.equal(sla.dueDate, "2026-11-19"); assert.equal(h.timer("SM_O103_PACKAGE_FREEZE_SLA_2BD")!.dueDate, "2026-11-20");
  // Before activation the MI is pending: the build carries no certificate and the freeze is blocked by 24.6's gate.
  h.at("2026-11-19T13:45:00.000Z"); const row = h.svc.open(h.file()); const pre = h.svc.assemble(row.delivery_id); assert.equal(pre.status, "built", pre.reason ?? ""); assert.equal(h.sid(pre.build!.points, "412")!.value, null); h.svc.runEarlyCheck(row.delivery_id);
  assert.throws(() => h.svc.freeze(row.delivery_id), (e: unknown) => e instanceof DeliveryRefused && e.code === "FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE");
  // 24.6 confirms activation Thu Nov 19 09:10 ET, effective Nov 18 (24.6-T9).
  const mi = h.seam("mi.activated", { certificate_id: "MIC-P", mi_company_code: "MGIC", certificate_number: "4812093", activation_effective_date: "2026-11-18", coverage_pct: "25.00", premium_plan: "bpmi_monthly", activated_at: "2026-11-19T14:10:00.000Z" }, { at: "2026-11-19T14:10:00.000Z", actor: { kind: "agent", id: "mi" } });
  h.at("2026-11-19T15:00:00.000Z"); const out = h.svc.rebuild(row.delivery_id, h.base, "mi.activated"); assert.equal(out.status, "built", out.reason ?? ""); const b = out.build!;
  assert.equal(row.file.mi!.status, "active"); assert.equal(h.sid(b.points, "412")!.value, "4812093"); assert.equal(miCertificateIdentifier("0004812093"), "4812093"); assert.equal(h.dp(b.points, "MICoveragePercent")!.value, "25.00"); assert.equal(h.dp(b.points, "MICompanyNameType")!.value, "MGIC");
  assert.equal(h.sid(b.points, "429")!.value, null); assert.equal(h.sid(b.points, "429")!.condition_evaluated, true); assert.equal(h.sid(b.points, "430.1")!.value, null);
  assert.ok(b.sfcs.includes("900") && b.sfcs.includes("127")); assert.ok(!b.sfcs.includes("019") && !b.sfcs.includes("281") && !b.sfcs.includes("118")); assert.equal(h.dp(b.points, "LoanAffordableIndicator")!.value, "true"); assert.equal(h.dp(b.points, "LTVRatioPercent")!.value, "90.00"); assert.equal(h.sid(b.points, "251")!.value, "701"); assert.equal(h.sid(b.points, "311")!.value, "2026-10-20");
  h.svc.runEarlyCheck(row.delivery_id); h.at("2026-11-19T15:20:00.000Z"); const pkg = h.svc.freeze(row.delivery_id);
  assert.ok(Date.parse(pkg.frozen_at) > Date.parse(mi.occurredAt), "freeze timestamped after mi.activated"); assert.equal(pkg.gate_results.FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE!.result, "open"); assert.equal(pkg.gate_results.FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE!.evidence_ref, "2026-11-19T14:10:00.000Z");
  assert.equal(pkg.identifier_snapshot.mi_certificate_number, "4812093"); assert.equal(h.timer("SM_O103_PACKAGE_FREEZE_SLA_2BD")!.status, "satisfied"); assert.equal(sla.status, "satisfied");
  assert.throws(() => miCertificateIdentifier("48120930001"), (e: unknown) => e instanceof DeliveryRefused && e.code === "ULDD_SID_412_LENGTH");
});
test("29.3-T11: Given a warning edit on the standardized address, when the agent accepts EarlyCheck's standardized output, then `properties` is updated with a `source = earlycheck_standardization` audit row and the `delivery_edits.resolution = data_corrected`; given the warning is a DU Compare value difference of $5,000, then the resolution must be `source_corrected_upstream` via 23.1 — a bypass is refused.", async () => {
  const h = harness("2026-10-07T16:00:00.000Z", refiBase()); fundRefi(h);
  h.at("2026-11-13T16:42:00.000Z"); const row = h.svc.open(h.file()); const b1 = h.svc.assemble(row.delivery_id).build!;
  h.ec.script(b1.sha256, { edits: [{ edit_code: "ADDR-STD", severity: "warning", message: "Standardized address differs: N 7TH ST", sort_ids: ["AddressLineText"], kind: "standardized_address" },
    { edit_code: "D1042", severity: "warning", message: "DU Compare: property value in DU $805,000 vs ULDD $800,000", sort_ids: ["PropertyValuationAmount"], kind: "du_compare", details: { du: "805000.00", uldd: "800000.00", difference_cents: "500000" } }], standardized_address: { street: "4120 N 7TH ST", city: "PHOENIX", state: "AZ", zip: "85014" }, result_document_id: "DOC-EC-RESULT-11" });
  const run = h.svc.runEarlyCheck(row.delivery_id); assert.equal(run.clean, true);   // warnings only — clean, but each needs a recorded resolution
  const addr = h.svc.edits.find((e) => e.edit_code === "ADDR-STD")!; assert.equal(addr.owner_process, "29.3"); assert.deepEqual(derivedFixAllowed({ edit_code: "ADDR-STD", severity: "warning", message: "", sort_ids: ["AddressLineText"], kind: "standardized_address" }), { allowed: true, reason: null });
  const fix = h.svc.applyDerivedFix(addr.edit_id, h.base);
  assert.equal(fix.property_audit!.source, "earlycheck_standardization"); assert.equal(fix.property_audit!.property_id, "PROP-REFI-1"); assert.equal(fix.property_audit!.before.street, "4120 North 7th Street"); assert.equal(fix.property_audit!.after.street, "4120 N 7TH ST"); assert.equal(fix.property_audit!.run_id, run.run_id);
  assert.equal(h.svc.propertyAudit.length, 1); const pe = h.ofType("property.address.standardized")[0]!; assert.equal(pe.payload.source, "earlycheck_standardization"); assert.equal((pe.payload.after as { street: string }).street, "4120 N 7TH ST");
  assert.equal(fix.edit.resolution, "data_corrected"); assert.equal(fix.build!.build_no, 2); assert.equal(h.dp(fix.build!.points, "AddressLineText")!.value, "4120 N 7TH ST");
  // DU Compare $5,000: owner 23.1, source_corrected_upstream — a bypass or a "data_corrected" here is refused (R5: beyond the $1 tolerance, must be resolved, not bypassed).
  const duc = h.svc.edits.find((e) => e.edit_code === "D1042")!; assert.equal(duc.owner_process, "23.1"); assert.equal(mapEditToOwner({ edit_code: "D1042", severity: "warning", message: "", sort_ids: ["PropertyValuationAmount"], kind: "du_compare" }).expected_resolution, "source_corrected_upstream");
  assert.equal(computedFieldVariances({ PropertyValuationAmount: "800000.00" }, { PropertyValuationAmount: "805000.00" })[0]!.beyond_tolerance, true);
  assert.equal(h.ofType("delivery.correction.requested").find((e) => e.payload.edit_code === "D1042")!.payload.owner_process, "23.1");
  assert.throws(() => h.svc.resolveEdit(duc.edit_id, "bypassed_with_justification", { resolution_ref: "agent judgment" }), (e: unknown) => e instanceof DeliveryRefused && e.code === "EDIT_BYPASS_REFUSED");
  assert.throws(() => h.svc.resolveEdit(duc.edit_id, "data_corrected", { resolution_ref: "typed 805000" }), (e: unknown) => e instanceof DeliveryRefused && e.code === "EDIT_NOT_DERIVABLE");
  assert.throws(() => h.svc.applyDerivedFix(duc.edit_id, h.base), (e: unknown) => e instanceof DeliveryRefused && e.code === "DERIVED_FIX_NOT_ALLOWED");
  await h.refused(h.run("applyDerivedFix", { edit_id: duc.edit_id, op: "resolve", resolution: "bypassed_with_justification", resolution_ref: "x", kind: "du_compare" }), "DU_COMPARE_UPSTREAM_ONLY");
  await h.refused(h.run("applyDerivedFix", { edit_id: duc.edit_id, op: "resolve", resolution: "bypassed_with_justification", resolution_ref: "x", severity: "fatal" }), "NEVER_BYPASS_FATAL");
  assert.equal(duc.resolution, "unresolved");
  const resolved = await h.run("applyDerivedFix", { edit_id: duc.edit_id, op: "resolve", resolution: "source_corrected_upstream", resolution_ref: "23.1 du.resubmission.required#final_closed_loan_match" });
  assert.equal(resolved.resolution, "source_corrected_upstream"); assert.equal(duc.resolution, "source_corrected_upstream"); assert.equal(duc.resolved_by, "agent:secondary");
});
test("29.3-T12: Given a lock extended on Mon Nov 2 without a rate change, then SID 311 remains 2026-10-07 and equals UCD 3.038; given the extension changed the rate, then both carry 2026-11-02 (25.2 must have submitted the UCD with that date).", () => {
  assert.equal(priceLockDate({ locked_on: D("2026-10-07"), extensions: [{ on: D("2026-11-02"), rate_changed: false }] }), "2026-10-07");
  assert.equal(priceLockDate({ locked_on: D("2026-10-07"), extensions: [{ on: D("2026-11-02"), rate_changed: true }] }), "2026-11-02");
  // Extension without a rate change: SID 311 stays the lock date and equals UCD CurrentRateSetDate (3.038) = 2026-10-07.
  const h = harness("2026-10-07T16:00:00.000Z", refiBase()); fundRefi(h, { extraSeams: () => h.seam("lock.extended", { lock_id: "LOCK-1", extended_on: "2026-11-02", days: 10, rate_changed: false }, { at: "2026-11-02T18:00:00.000Z", loanId: null }) });
  h.at("2026-11-13T16:42:00.000Z"); const file = h.file(); assert.deepEqual(file.lock, { locked_on: "2026-10-07", extensions: [{ on: "2026-11-02", rate_changed: false }] }); assert.equal(file.ucd!.current_rate_set_date, "2026-10-07");
  const row = h.svc.open(file); const b = h.svc.assemble(row.delivery_id).build!; assert.equal(h.sid(b.points, "311")!.value, "2026-10-07"); assert.equal(row.identifier_snapshot!.price_lock_date, "2026-10-07");
  // Extension with a rate change: both carry 2026-11-02 when 25.2 submitted the UCD with that date …
  const h2 = harness("2026-10-07T16:00:00.000Z", refiBase({ application_id: "APP-EXT-2", loan_id: "L-EXT-2" })); fundRefi(h2, { ucdRateSetDate: "2026-11-02", extraSeams: () => h2.seam("lock.extended", { lock_id: "LOCK-1", extended_on: "2026-11-02", days: 10, rate_changed: true, new_note_rate: "6.250" }, { at: "2026-11-02T18:00:00.000Z", loanId: null }) });
  h2.at("2026-11-13T16:42:00.000Z"); const f2 = h2.file(); const row2 = h2.svc.open(f2); const b2 = h2.svc.assemble(row2.delivery_id).build!;
  assert.equal(h2.sid(b2.points, "311")!.value, "2026-11-02"); assert.equal(f2.ucd!.current_rate_set_date, "2026-11-02"); assert.equal(reconcileIdentifiers(f2, D("2026-11-13")).complete, true);
  // … and a UCD still carrying the original lock date is an R3(g) mismatch owned by 25.2 (FAQ Q23), so nothing is built.
  const h3 = harness("2026-10-07T16:00:00.000Z", refiBase({ application_id: "APP-EXT-3", loan_id: "L-EXT-3" })); fundRefi(h3, { extraSeams: () => h3.seam("lock.extended", { lock_id: "LOCK-1", extended_on: "2026-11-02", days: 10, rate_changed: true }, { at: "2026-11-02T18:00:00.000Z", loanId: null }) });
  h3.at("2026-11-13T16:42:00.000Z"); const f3 = h3.file(); const ids = reconcileIdentifiers(f3, D("2026-11-13"));
  assert.deepEqual(ids.mismatches.map((m) => [m.identifier, m.expected, m.found, m.owner_process]), [["price_lock_date", "2026-11-02", "2026-10-07", "25.2"]]);
  const out3 = h3.svc.assemble(h3.svc.open(f3).delivery_id); assert.equal(out3.status, "refused"); assert.equal(out3.gate, "FNMA_ULDD_IDENTIFIER_CONSISTENCY_GATE"); assert.equal(h3.ofType("delivery.identifier.mismatch.detected")[0]!.payload.identifier, "price_lock_date");
});
test("29.3 worked figures: refinance P&I $3,402.62 on $560,000 at 6.125%/360, base LTV 70.00 (EarlyCheck LTV/CLTV 70.00, DTI 38.00 within tolerance), SID 363 EscrowBalanceAmount $3,120.00; purchase $412,000 at 90% LTV — price at exactly 90% $457,777.78, contract price $457,800 → LTV 90.00", () => {
  const pi = levelPayment(56_000_000n, ratePercent("6.125"), 360); assert.equal(pi, 340_262n);   // $3,402.62
  const h = harness("2026-10-07T16:00:00.000Z", refiBase()); fundRefi(h); h.at("2026-11-13T16:42:00.000Z"); const b = h.svc.assemble(h.svc.open(h.file()).delivery_id).build!;
  assert.equal(h.dp(b.points, "ScheduledPrincipalAndInterestPayment")!.value, "3402.62"); assert.equal(h.sid(b.points, "363")!.value, "3120.00"); assert.equal(h.sid(b.points, "363")!.source_table, "escrow_accounts");   // $3,120.00 from the CD Section G (30.3 computes)
  assert.equal(baseLtvPct(56_000_000n, null, 80_000_000n), "70.00"); assert.equal(h.dp(b.points, "LTVRatioPercent")!.value, "70.00"); assert.equal(h.dp(b.points, "CombinedLTVRatioPercent")!.value, "70.00");
  const variances = computedFieldVariances({ LTV: "70.00", CLTV: "70.00", DTI: "38.00" }, CLEAN.computed_fields!); assert.deepEqual(variances.map((v) => v.beyond_tolerance), [false, false, false]);
  assert.equal(computedFieldVariances({ LTV: "70.00" }, { LTV: "70.02" })[0]!.beyond_tolerance, true); assert.equal(computedFieldVariances({ NoteAmount: "560000.00" }, { NoteAmount: "560001.00" })[0]!.beyond_tolerance, false);
  // Purchase fixture: 412,000 / 0.90 = $457,777.78 is the price at exactly 90%; the contract's rounded $457,800 gives 412,000 / 457,800 = 0.89995 → 90.00 after 23.1 rounding (25% BPMI band 85.01–90%).
  assert.equal(priceAtLtv(41_200_000n, "90.00"), 45_777_778n);   // $457,777.78
  assert.equal(baseLtvPct(41_200_000n, 45_780_000n, 46_000_000n), "90.00"); assert.equal(baseLtvPct(41_200_000n, 45_777_778n, 46_000_000n), "90.00"); assert.equal(deriveMiAbsenceReason({ status: "active" }, "90.00"), null);
  assert.equal(baseLtvPct(41_200_000n, 47_000_000n, 46_000_000n), "89.57");   // the lesser of price and appraised value is the denominator
});
