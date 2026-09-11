// 30.2 New-origination boarding onto the Supermortgage servicing platform at funding (origination-to-servicing data mapping, DQ gate, opening ledger, documents, consents, timers seeded, welcome/first-payment communications, no-transfer-notice design)
// spec/sections/30-post-purchase-servicing-setup-and-boarding-to-the-subservice/30-2-new-origination-boarding-onto-the-supermortgage-servicing-pl.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_30_2 } from "../../app/tools/section30-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { makeMin } from "../boarding/min.ts";
import { PARTNER_ORG } from "../boarding/fixtures.ts";
import { b1EvidenceOnFile } from "../credit-reporting/ops-8-1.ts";
import { allocate } from "../cashiering/allocation.ts";
import {
  OriginationBoardingService, boardFundedApplication, noteTermsHash, prepaidInterest, perDiem365Rounded, recomputePi, firstInstallmentSplit, lateChargeCents, firstStatementFigures, firstPaymentWindow, activeBeforeFirstDueGateDate, firstPaymentLetterTarget,
  servicingLoanNumber, isValidServicingLoanNumber, ulddLenderLoanNumber, fnmaEstablishmentIdentifierCheck, consentScopeAtBoarding, mapFieldGuard, mersRegistrationDue, sentinelBoardingReport, cashStateAtBoarding, openingLedgerLines, sumLines, origFundingClearing, retentionClassFor,
  SERVICING_CONSENT_CLASSES, ORIGINATION_CONSENT_CLASSES, FIRST_PAYMENT_LETTER, B1_TEMPLATE, ESIGN_INVITATION, PI_TOLERANCE_CENTS_30_2,
  type OriginationSnapshot, type LoanFundedPayload, type OrigExternal,
} from "./ops-30-2.ts";

// ───────────────────────────── fixtures (section 30 README; worked examples 1 and 2) ─────────────────────────────
const NOTE_REFI = { amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360, first_payment_date: D("2027-01-01"), maturity_date: D("2056-12-01"), late_charge_pct: "5.00", late_charge_grace_days: 15 };
const NOTE_PURCHASE = { amount_cents: 41_200_000n, note_rate_pct: "6.375", term_months: 360, first_payment_date: D("2027-01-01"), maturity_date: D("2056-12-01"), late_charge_pct: "5.00", late_charge_grace_days: 15 };
const MIN_REFI = makeMin(PARTNER_ORG, "77001"), MIN_PURCHASE = makeMin(PARTNER_ORG, "77002");
const V20 = [...ORIGINATION_CONSENT_CLASSES, ...SERVICING_CONSENT_CLASSES];
const DISCLOSURES: OriginationSnapshot["disclosure_versions"] = {
  "2.0": { categories: V20, providers: ["Partner Bank", "its servicer Supermortgage"], delivery_form: "portal_pdf" },
  "1.4": { categories: [...ORIGINATION_CONSENT_CLASSES], providers: ["Partner Bank"], delivery_form: "portal_pdf" },
};
const borrowerA = (): OriginationSnapshot["borrowers"][number] => ({ party_id: "B-A", legal_name: "Alex Borrower", tin: "123456789", dob: D("1985-04-02"), phone: "(602) 555-0101", email: "alex@example.com", mailing_address: "100 N Central Ave, Phoenix, AZ 85004", language_preference: "en", acp_enrolled: false, role: "borrower",
  demographics: { race: ["white"], ethnicity: ["not_hispanic_or_latino"], sex: "female", age: 41, preferred_language: "en", collected_via: "self_reported" } });
const borrowerB = (): OriginationSnapshot["borrowers"][number] => ({ party_id: "B-B", legal_name: "Blake Borrower", tin: "987654321", dob: D("1983-09-14"), phone: "(602) 555-0102", email: "blake@example.com", mailing_address: "100 N Central Ave, Phoenix, AZ 85004", language_preference: "en", acp_enrolled: false, role: "coborrower",
  demographics: { race: "not_provided", ethnicity: "not_provided", sex: "not_provided", age: 43, preferred_language: "en", collected_via: "not_provided" } });   // 21.1: "information not provided"
function refinanceSnapshot(o: Partial<OriginationSnapshot> = {}): OriginationSnapshot {
  const note: OriginationSnapshot["note"] = { document_id: "DOC-NOTE", data_hash: "note-render-hash", note_date: D("2026-11-06"), ...NOTE_REFI, amortization: "fixed", arm: null, buydown_schedule: null, partner_nmlsr_id: "123456", mlo_nmlsr_id: "654321", security_instrument_version: "uniform_2021" };
  return {
    application_id: "APP-REFI-1", partner_id: "P-PARTNER", partner_name: "Partner Bank", partner_mers_org_id: PARTNER_ORG, loan_purpose: "refinance", rescindable: true, rescission_expires_at: "2026-11-11T06:59:59.000Z",   // Tue Nov 10, 2026 23:59:59 MST
    note, closing: { consummation_date: D("2026-11-06"), note_terms_hash: noteTermsHash(NOTE_REFI), security_instrument_document_id: "DOC-DOT" },
    final_cd: { document_id: "DOC-CD", pi_cents: 340_262n, monthly_escrow_cents: 68_750n, initial_escrow_deposit_cents: 206_250n, prepaid_interest_cents: 178_543n, prepaid_interest_days: 19, compliance_tests_passed: true },
    // 30.3 initial analysis: base $687.50 + cushion $1,375.00 = deposit $2,062.50; taxes $6,400/yr, hazard $1,850/yr
    escrow_analysis: { source: "origination", type: "initial", required_start_balance_cents: 68_750n, cushion_cents: 137_500n, monthly_escrow_cents: 68_750n, lines: [{ line_type: "county_tax", annual_amount_cents: 640_000n, monthly_cents: 53_333n }, { line_type: "hazard", annual_amount_cents: 185_000n, monthly_cents: 15_417n }], status: "active" },
    hpml: false, qm_type: "general_qm", ltv_pct: "70.00", mi: null,
    hazard: { verified: true, mortgagee_clause_partner_isaoa_co_sm: true, expires_on: D("2027-11-12") }, flood: { determination_present: true, lol_purchased: true, lol_contract_linked: true, sfha: false, policy_verified: false },
    min: { value: MIN_REFI, registration: "active" }, custody: { kind: "paper", custodian: "Custodian Bank NA", status: "received" }, warehouse_advance_id: "WA-REFI-1",
    borrowers: [borrowerA(), borrowerB()],
    consents: [
      { id: "C-A-ESIGN", party_id: "B-A", kind: "esign", disclosure_version: "2.0", servicing_group_elected: true, demonstration_passed: true, demonstration_channel: "portal", captured_via: "portal", captured_at: "2026-10-05T16:00:00.000Z" },
      { id: "C-B-ESIGN", party_id: "B-B", kind: "esign", disclosure_version: "1.4", servicing_group_elected: false, demonstration_passed: true, demonstration_channel: "portal", captured_via: "portal", captured_at: "2026-10-05T16:10:00.000Z" },
      { id: "C-A-TCPA", party_id: "B-A", kind: "tcpa_voice", captured_via: "portal", captured_at: "2026-10-05T16:05:00.000Z" },
    ],
    disclosure_versions: DISCLOSURES,
    property: { address_line1: "100 N Central Ave", city: "Phoenix", state: "AZ", postal_code: "85004", county: "Maricopa", apn: "112-23-045", property_type: "sfr", units: 1, occupancy: "primary", flood_zone: "X", sfha: false, appraised_value_cents: 80_000_000n, original_value_cents: 80_000_000n },
    documents: [{ id: "DOC-NOTE", kind: "note", sha256: "a".repeat(64), custody: "custodian" }, { id: "DOC-DOT", kind: "security_instrument", sha256: "b".repeat(64), custody: "platform" }, { id: "DOC-CD", kind: "closing_disclosure_final", sha256: "c".repeat(64), custody: "platform" }, { id: "DOC-LE", kind: "loan_estimate", sha256: "d".repeat(64), custody: "platform" }, { id: "DOC-APPR", kind: "appraisal", sha256: "e".repeat(64), custody: "platform" }, { id: "DOC-ESIGN", kind: "esign_consent", sha256: "f".repeat(64), custody: "platform" }, { id: "DOC-IES", kind: "escrow_initial_statement", sha256: "1".repeat(64), custody: "platform" }, { id: "DOC-SFHDF", kind: "sfhdf", sha256: "2".repeat(64), custody: "platform" }],
    trailing: { recorded_security_instrument_received: false, final_title_policy_received: false }, tax_service_parcel_verified: false, initial_escrow_statement_delivered: true, ach_autopay_elected: false,
    ...o,
  };
}
const REFI_FUNDED: LoanFundedPayload = { application_id: "APP-REFI-1", funded_at: "2026-11-12T18:40:00.000Z" /* 11:40 MST Thu Nov 12 */, funding_date: D("2026-11-12"), disbursement_date: D("2026-11-12"), wire_id: "IMAD-20261112-001", funded_amount_cents: 56_000_000n, per_diem_cents: 9_397n, prepaid_interest_cents: 178_543n, interest_credit: false, rescission_expires_at: "2026-11-11T06:59:59.000Z" };
function purchaseSnapshot(): OriginationSnapshot {
  const base = refinanceSnapshot();
  return { ...base, application_id: "APP-PURCH-1", loan_purpose: "purchase", rescindable: false, rescission_expires_at: null,
    note: { ...base.note, ...NOTE_PURCHASE, note_date: D("2026-11-18") }, closing: { ...base.closing, consummation_date: D("2026-11-18"), note_terms_hash: noteTermsHash(NOTE_PURCHASE) },
    final_cd: { ...base.final_cd, pi_cents: 257_034n, monthly_escrow_cents: 88_797n, initial_escrow_deposit_cents: 266_391n, prepaid_interest_cents: 93_548n, prepaid_interest_days: 13 },   // county taxes + hazard + MI $130.47; 26.3 T8: 13 × $71.96 = $935.48
    escrow_analysis: { source: "origination", type: "initial", required_start_balance_cents: 88_797n, cushion_cents: 177_594n, monthly_escrow_cents: 88_797n, lines: [{ line_type: "county_tax", annual_amount_cents: 720_000n, monthly_cents: 60_000n }, { line_type: "hazard", annual_amount_cents: 189_000n, monthly_cents: 15_750n }, { line_type: "mi", annual_amount_cents: 156_564n, monthly_cents: 13_047n }], status: "active" },
    ltv_pct: "90.00", mi: { certificate_number: "MI-2026-1188", status: "active", coverage_pct: "25", premium_plan: "bpmi_monthly", monthly_premium_cents: 13_047n, hpa_disclosure_kind: "initial_fixed" },
    min: { value: MIN_PURCHASE, registration: "pending" }, warehouse_advance_id: "WA-PURCH-1",
    property: { ...base.property, address_line1: "44 E Broad St", city: "Columbus", state: "OH", postal_code: "43215", county: "Franklin", apn: "010-044556", appraised_value_cents: 45_780_000n, original_value_cents: 45_780_000n },
    borrowers: [{ ...borrowerA(), mailing_address: "44 E Broad St, Columbus, OH 43215" }], consents: base.consents.filter((c) => c.party_id === "B-A"), trailing: { recorded_security_instrument_received: false, final_title_policy_received: false } };
}
const PURCHASE_FUNDED: LoanFundedPayload = { application_id: "APP-PURCH-1", funded_at: "2026-11-18T20:20:00.000Z" /* 15:20 EST Wed Nov 18 */, funding_date: D("2026-11-18"), disbursement_date: D("2026-11-18"), wire_id: "IMAD-20261118-007", funded_amount_cents: 41_200_000n, per_diem_cents: 7_196n, prepaid_interest_cents: 93_548n, interest_credit: false, rescission_expires_at: null };

class FakeExternal implements OrigExternal {
  readonly licensedStates = new Set(["AZ", "OH", "TX"]); readonly platform = new Set<string>(); readonly mersRecords = new Map<string, { status: "Active" | "Pending" | "Inactive"; org_id: string }>();
  licensed(state: string): boolean { return this.licensedStates.has(state); }
  onPlatform(kind: "servicing_loan_number" | "min", value: string): boolean { return this.platform.has(`${kind}:${value}`); }
  mers(min: string) { return this.mersRecords.get(min); }
}
/** The 30.2 lifecycle on the event store: the service, the ledger, escalations and the TimerEngine arming the 30.2 rows plus the reference rows 30.2 satisfies (25.4's letter clock, 7.1/8.1 consumers). */
function harness(nowIso: string, o: { processes?: readonly string[]; mers?: "active" | "pending"; tz?: string } = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const registry = loadOverriddenRegistry();
  const timers = new TimerEngine(registry, events, { processes: [...(o.processes ?? ["30.2", "25.4", "7.1", "8.1", "26.4"])] });
  const esc = new EscalationService(events, clock); const ext = new FakeExternal();
  if ((o.mers ?? "active") === "active") { ext.mersRecords.set(MIN_REFI, { status: "Active", org_id: PARTNER_ORG }); ext.mersRecords.set(MIN_PURCHASE, { status: "Active", org_id: PARTNER_ORG }); }
  const svc = new OriginationBoardingService({ events, ledger, clock, ext, timers, escalations: esc, prepurchaseTiAccountId: "CUST-TI-PREPURCHASE", servicerTz: o.tz ?? "America/Phoenix", loanIdFor: (a) => `L-${a}` });
  const emitted = (type: string) => events.all().filter((e) => e.type === type);
  return { clock, events, ledger, timers, esc, ext, svc, registry, emitted };
}
const BOARDING: Actor = { kind: "agent", id: "boarding" };
const toolKey = (process: string, name: string): string => `${process} ${name}`;
/** The 30.2 bus alone (the 12-8 pattern): TOOLS_30_2 bound to the `boarding` agent with the service on the runtime. */
function bindSection302(rt: ToolRuntime, agents: AgentRegistry): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_30_2) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); out.set(toolKey(d.process, d.name), cmd); }
  return out;
}
function busFor(h: ReturnType<typeof harness>, loanId: string) {
  const ctx: UowContext = { loanId, events: h.events, ledger: h.ledger, timers: h.timers, clock: h.clock, decide: () => {} };
  const agents = new AgentRegistry(); const rt: ToolRuntime = { store: new EntityStore(), ports: {}, escalations: h.esc, services: { "orig-boarding": h.svc } };
  return { ctx, cmds: bindSection302(rt, agents), bus: new CommandBus(agents) };
}
/** Worked example 1: `loan.funded` 11:40 MST, staged 11:41, boarded 12:05 MST Thu Nov 12, 2026. */
async function boardRefinance(h: ReturnType<typeof harness>, snapshot = refinanceSnapshot(), funded = REFI_FUNDED, opts: { sent_on?: ReturnType<typeof D>; mailed_at?: string } = {}) {
  h.clock.set("2026-11-12T19:05:00.000Z");
  return boardFundedApplication(h.svc, snapshot, funded, { sent_on: opts.sent_on ?? D("2026-11-16"), mailed_at: opts.mailed_at ?? "2026-11-16T17:00:00.000Z" });
}

test("30.2-T1: Given `loan.funded` for the refinance fixture at 11:40 MST Thu Nov 12, 2026, when boarding runs, then `loans.boarded_at` is the same day, `SM_ORIG_BOARD_T1BD` (due Fri Nov 13 23:59 MST) is satisfied, and `OB-001`…`OB-022` all `pass`.", async () => {
  const h = harness("2026-11-12T18:40:00.000Z");
  const r = await boardRefinance(h);
  assert.equal(r.duplicate, false); assert.equal(r.refusal, null); assert.equal(r.loan_id, "L-APP-REFI-1");
  const rec = h.svc.record("APP-REFI-1");
  // `loans.boarded_at` is the funding day in the servicer's (property) time zone: 12:05 MST Thu Nov 12, 2026.
  assert.equal(wallClock(Date.parse(rec.boarded_at!), "America/Phoenix").date, "2026-11-12");
  assert.equal(rec.mapped.loans.origination_application_id, "APP-REFI-1"); assert.equal(rec.mapped.loans.investor, "partner_warehouse"); assert.equal(rec.mapped.loans.boarding_source, "origination"); assert.equal(rec.mapped.loans.fnma_loan_number, null);
  assert.equal(rec.mapped.loans.interest_paid_through_date, "2026-11-30"); assert.equal(rec.mapped.loans.first_payment_date, "2027-01-01"); assert.equal(rec.mapped.loans.maturity_date, "2056-12-01"); assert.equal(rec.mapped.loan_terms.late_charge_pct, "5.00"); assert.equal(rec.mapped.loan_terms.late_charge_grace_days, 15);
  // OB-001…OB-022 all pass; the worked example's open warnings are OW-002 (borrower B), OW-006, OW-008, OW-009 — so the loan sits in boarded_with_warnings.
  const ob = r.validations.filter((v) => v.code.startsWith("OB-"));
  assert.equal(ob.length, 22); assert.deepEqual(ob.filter((v) => v.result !== "pass").map((v) => v.code), []);
  assert.deepEqual(r.validations.filter((v) => v.code.startsWith("OW-") && v.result === "fail").map((v) => v.code), ["OW-002", "OW-006", "OW-008", "OW-009"]);
  assert.equal(r.status, "boarded_with_warnings");
  // SM_ORIG_BOARD_T1BD: armed by `loan.funded` (funding_date Nov 12 + 1 servicer BD = Fri Nov 13), satisfied by `loan.boarded` the same day.
  const t1bd = h.timers.byCode("SM_ORIG_BOARD_T1BD"); assert.equal(t1bd.length, 1);
  assert.equal(t1bd[0]!.anchorDate, "2026-11-12"); assert.equal(t1bd[0]!.dueDate, "2026-11-13"); assert.equal(t1bd[0]!.status, "satisfied");
  const boarded = h.emitted("loan.boarded")[0]!;
  assert.equal(boarded.loanId, "L-APP-REFI-1"); assert.equal(boarded.applicationId, "APP-REFI-1"); assert.equal(boarded.payload.source, "origination"); assert.equal(boarded.payload.first_payment_date, "2027-01-01");
  assert.equal(t1bd[0]!.satisfiedByEventId, boarded.id);
  // every 30.2 emission during the hand-off carries both ids
  for (const e of h.events.all().filter((e) => e.actor.id === "boarding")) { assert.equal(e.applicationId, "APP-REFI-1", e.type); assert.equal(e.loanId, "L-APP-REFI-1", e.type); }
  assert.equal(h.emitted("loan.staged")[0]!.payload.source, "origination"); assert.equal(h.emitted("loan.validated").length, 1);
  // OB-006 re-asserts 26.3's C2-2-01 rule (first payment ≤ disbursement + 2 months, ≥ disbursement + 1 day) as a validation: Nov 12 → Jan 1 passes (limit Jan 12, 2027); the shared timer code stays 26.3's
  assert.equal(ob.find((v) => v.code === "OB-006")!.result, "pass");
});

test("30.2-T2: Given the signed note ($560,000, 6.125%, 360) and a CD P&I of $3,402.63, when `OB-003` runs, then it fails (recomputed $3,402.62), the loan is `exception`, the defect is routed to 25.2/26.1, and the boarding command is refused until the source record is corrected.", async () => {
  const pi = recomputePi({ amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360 }, 340_263n);
  assert.equal(pi.recomputed_cents, 340_262n); assert.equal(pi.within_tolerance, false); assert.match(pi.recomputed_unrounded, /^3402\.619/);
  assert.equal(recomputePi({ amount_cents: 56_000_000n, note_rate_pct: "6.125", term_months: 360 }, 340_262n).within_tolerance, true);
  const h = harness("2026-11-12T18:40:00.000Z");
  const snapshot = refinanceSnapshot({ final_cd: { ...refinanceSnapshot().final_cd, pi_cents: 340_263n } });
  const r = await boardRefinance(h, snapshot);
  assert.equal(r.status, "exception"); assert.match(r.refusal!, /OB-003/);
  const ob3 = r.validations.find((v) => v.code === "OB-003")!;
  assert.equal(ob3.result, "fail"); assert.equal(ob3.money_field, true); assert.deepEqual(ob3.expected, { recomputed_cents: "340262" }); assert.deepEqual(ob3.actual, { cd_pi_cents: "340263" });
  // the exception is raised once (SM_ORIG_BOARD_EXCEPTION_SLA_1BD arms on it) and the money-field defect is routed to the CD (25.2) and note (26.1) owners
  const raised = h.emitted("loan.boarding_exception.raised"); assert.equal(raised.length, 1); assert.equal(raised[0]!.payload.severity, "hard"); assert.equal(raised[0]!.payload.money_field, true);
  assert.equal(h.timers.byCode("SM_ORIG_BOARD_EXCEPTION_SLA_1BD")[0]?.status, "armed"); assert.equal(h.timers.byCode("SM_ORIG_BOARD_EXCEPTION_SLA_1BD")[0]?.dueDate, "2026-11-13");
  const routed = h.emitted("boarding.defect.routed"); assert.equal(routed.length, 1); assert.deepEqual(routed[0]!.payload.owner_processes, ["25.2", "26.1"]);
  // the boarding command stays refused; the agent cannot correct the CD figure itself (money field) — only the corrected source record boards it
  const b = h.svc.board("APP-REFI-1"); assert.equal(b.ok, false); assert.match((b as { reason: string }).reason, /exception.*OB-003/);   // 1.1's machine: no `board` transition from `exception`
  assert.equal(h.emitted("loan.boarded").length, 0); assert.equal(h.ledger.sets().length, 0);
  const agentFix = h.svc.proposeCorrection("APP-REFI-1", { final_cd: refinanceSnapshot().final_cd }, BOARDING, { provenance: "agent" });
  assert.equal(agentFix.ok, false); assert.equal((agentFix as { code: string }).code, "MONEY_FIELD_GUARD");
  const sourceFix = h.svc.proposeCorrection("APP-REFI-1", { final_cd: refinanceSnapshot().final_cd }, BOARDING, { provenance: "source", evidence_document_ids: ["DOC-CD-CORRECTED"] });
  assert.equal(sourceFix.ok, true); assert.equal((sourceFix as { status: string }).status, "validated");
  assert.equal(h.emitted("loan.boarding_exception.resolved").length, 1); assert.equal(h.timers.byCode("SM_ORIG_BOARD_EXCEPTION_SLA_1BD")[0]?.status, "satisfied");
  assert.equal(h.svc.board("APP-REFI-1").ok, true);
});

test("30.2-T3: Given the opening ledger, then `principal` = 56,000,000, `escrow` = 206,250 (matching 30.3's analysis and the CD (g)(3) total), `prepaid_interest` = 178,543 (26.3's cent-rounded per diem × 19 days), and the entry set balances to zero against `origination_funding_clearing`.", async () => {
  const h = harness("2026-11-12T18:40:00.000Z");
  const r = await boardRefinance(h);
  const set = r.ledger_set!; const loanId = r.loan_id;
  assert.equal(h.ledger.sets().length, 1); assert.equal(set.effectiveDate, "2026-11-12");
  const loan = (account: string) => ({ scope: "loan" as const, loanId, account: account as "principal" });
  assert.equal(h.ledger.balance(loan("principal")), 56_000_000n);
  assert.equal(-h.ledger.balance(loan("escrow")), 206_250n);            // borrower liability (credit balance) = CD (g)(3) = 30.3 required start balance $687.50 + cushion $1,375.00
  assert.equal(-h.ledger.balance(loan("prepaid_interest")), 178_543n);  // 19 × 9,397 cents (26.3 `365_rounded_per_diem`)
  assert.equal(h.ledger.balance({ scope: "custodial", custodialAccountId: "CUST-TI-PREPURCHASE", account: "custodial_ti_prepurchase_cash" as "custodial_ti_cash" }), 206_250n);
  assert.equal(sumLines(set.lines), 0n);                                   // Σ Dr = Σ Cr
  assert.equal(h.ledger.balance(origFundingClearing(loanId)), -56_000_000n + 178_543n);   // cleared by 27.1's warehouse advance posting
  assert.ok(set.lines.every((l) => l.ruleRef.startsWith("30.2:opening:")));
  const snapshot = refinanceSnapshot();
  assert.equal(snapshot.escrow_analysis!.required_start_balance_cents + snapshot.escrow_analysis!.cushion_cents, snapshot.final_cd.initial_escrow_deposit_cents);
  const p = prepaidInterest(56_000_000n, "6.125", D("2026-11-12"));
  assert.equal(p.days, 19); assert.equal(p.per_diem_cents, 9_397n); assert.equal(p.prepaid_interest_cents, 178_543n); assert.equal(p.interest_paid_through_date, "2026-11-30");
  assert.equal(h.svc.record("APP-REFI-1").mapped.loans.interest_paid_through_date, "2026-11-30");
  const posted = h.emitted("ledger.opening_posted")[0]!; assert.equal(posted.payload.entry_set_id, set.id); assert.equal(posted.payload.prepaid_interest_cents, "178543");
  // the pure lines for a buydown/holdback loan still balance
  assert.equal(sumLines(openingLedgerLines("L-x", "TI", { principal_cents: 56_000_000n, escrow_deposit_cents: 206_250n, prepaid_interest_cents: 178_543n, buydown_funds_cents: 500_000n, holdback_escrow_cents: 250_000n })), 0n);
});

test("30.2-T4: Given borrower A's E-SIGN consent under disclosure v2.0 (servicing categories listed; demonstration passed) and borrower B's consent under v1.4 (origination only), then A's servicing `consents.scope` includes `periodic_statements` and B's does not; `OW-002` is open for B and B's first-payment letter carries the 7.4 invitation.", async () => {
  const s = refinanceSnapshot();
  const a = consentScopeAtBoarding(s.consents[0]!, s.disclosure_versions), b = consentScopeAtBoarding(s.consents[1]!, s.disclosure_versions);
  assert.equal(a.provenance, "origination"); assert.equal(a.captured_via, "origination_portal"); assert.equal(a.verified, true); assert.equal(a.basis_disclosure_version, "2.0");
  assert.ok(a.scope.includes("periodic_statements")); assert.deepEqual(a.scope_servicing, [...SERVICING_CONSENT_CLASSES]); assert.equal(a.invitation_required, false);
  assert.ok(!b.scope.includes("periodic_statements")); assert.deepEqual(b.scope_servicing, []); assert.deepEqual(b.scope, [...ORIGINATION_CONSENT_CLASSES]); assert.equal(b.invitation_required, true);
  // tax_statements (IRS 1098 e-furnishing) is never inferred from the E-SIGN scope; an oral "yes" is evidence, not consent; a v2.0 election without the servicing group grants no servicing class
  assert.ok(!a.scope.includes("tax_statements"));
  assert.deepEqual(consentScopeAtBoarding({ ...s.consents[0]!, captured_via: "voice", demonstration_channel: "voice" }, s.disclosure_versions).scope_servicing, []);
  assert.deepEqual(consentScopeAtBoarding({ ...s.consents[0]!, servicing_group_elected: false }, s.disclosure_versions).scope_servicing, []);
  const h = harness("2026-11-12T18:40:00.000Z");
  const r = await boardRefinance(h);
  const ow2 = r.validations.find((v) => v.code === "OW-002")!; assert.equal(ow2.result, "fail"); assert.deepEqual(ow2.actual, ["B-B"]);
  assert.deepEqual(r.consents.map((c) => [c.party_id, c.kind, c.scope.includes("periodic_statements")]), [["B-A", "esign", true], ["B-B", "esign", false], ["B-A", "tcpa_voice", false]]);
  const letters = r.letters; assert.equal(letters.length, 2);
  const la = letters.find((l) => l.party_id === "B-A")!, lb = letters.find((l) => l.party_id === "B-B")!;
  assert.equal(lb.status, "sent"); assert.ok(lb.carries.includes(ESIGN_INVITATION)); assert.match(lb.rendered, /enroll in electronic delivery/); assert.equal(lb.channel, "mail_first_class");
  assert.ok(!la.carries.includes(ESIGN_INVITATION)); assert.equal(la.channel, "mail_and_portal");   // A's electronic copy posted the same day (general_correspondence in scope)
  assert.ok(h.svc.noticeRows().some((n) => n.template_code === ESIGN_INVITATION && n.party_id === "B-B"));
  const boarded = h.emitted("consents.boarded")[0]!; assert.equal((boarded.payload.consents as { invitation_required: boolean }[])[1]!.invitation_required, true);
});

test("30.2-T5: Given first payment due Fri Jan 1, 2027, then `SM_ORIG_FIRST_STATEMENT_LEAD_15` is due Thu Dec 17, 2026 and the first statement shows amount due $4,090.12 (P&I $3,402.62 + escrow $687.50), no past-due, and the late-fee line \"$170.13 after Jan 16, 2027\".", async () => {
  const f = firstStatementFigures({ first_payment_date: D("2027-01-01"), pi_cents: 340_262n, escrow_payment_cents: 68_750n, late_charge_pct: "5.00", late_charge_grace_days: 15 });
  assert.equal(f.amount_due_cents, 409_012n); assert.equal(f.pi_cents + f.escrow_cents, 340_262n + 68_750n); assert.equal(f.past_due_cents, 0n);
  assert.equal(f.late_fee_cents, 17_013n); assert.equal(f.late_fee_after_date, "2027-01-16"); assert.equal(f.late_fee_line, "$170.13 after Jan 16, 2027");
  assert.equal(f.statement_due_by, "2026-12-17");
  assert.equal(f.courtesy_period_end, "2027-01-16"); assert.equal(f.second_statement_due_by, "2027-01-20");   // 7.1's clock from the first due date: courtesy ends Sat Jan 16 → second statement by Wed Jan 20
  const h = harness("2026-11-12T18:40:00.000Z");
  await boardRefinance(h);
  const lead = h.timers.byCode("SM_ORIG_FIRST_STATEMENT_LEAD_15"); assert.equal(lead.length, 1);
  assert.equal(lead[0]!.anchorDate, "2027-01-01"); assert.equal(lead[0]!.dueDate, "2026-12-17"); assert.equal(lead[0]!.status, "armed");   // −15 calendar days, no business-day roll
  const opened = h.emitted("statement.cycle.opened")[0]!;
  assert.equal(opened.payload.first_cycle, true); assert.equal(opened.payload.cycle_due_date, "2027-01-01"); assert.equal(opened.payload.amount_due_cents, "409012"); assert.equal(opened.payload.past_due_cents, "0"); assert.equal(opened.payload.late_fee_cents, "17013"); assert.equal(opened.payload.late_fee_after_date, "2027-01-16"); assert.equal(opened.payload.template, "NTC_REGZ_41_STMT_STD");
  // 7.1's `statement.sent` for the first cycle closes the lead timer
  h.clock.set("2026-12-17T15:00:00.000Z");
  h.events.append({ type: "statement.sent", loanId: "L-APP-REFI-1", actor: { kind: "agent", id: "disclosures" }, payload: { cycle_due_date: "2027-01-01", template: "NTC_REGZ_41_STMT_STD", variant: "standard", mailed_at: "2026-12-17T15:00:00.000Z" } });
  assert.equal(lead[0]!.status, "satisfied");
});

test("30.2-T6: Given a first-payment letter rendered without the B-1 credit-reporting sentence, then the checklist blocks release; rendered with it and mailed Mon Nov 16, 2026, then a `notices` row with template `NTC_FCRA_1681S2A7_B1` exists and 8.1's negative-information timer is pre-satisfied.", async () => {
  const h = harness("2026-11-12T18:40:00.000Z");
  const svc = h.svc; h.clock.set("2026-11-12T19:05:00.000Z");
  svc.ingestFunded(refinanceSnapshot(), REFI_FUNDED); svc.validate("APP-REFI-1"); assert.equal(svc.board("APP-REFI-1").ok, true); svc.boardConsents("APP-REFI-1");
  const loanId = "L-APP-REFI-1";
  const held = await svc.sendFirstPaymentLetter("APP-REFI-1", { sent_on: D("2026-11-16"), payloadOverride: (p) => ({ ...p, b1_text: null }) });
  assert.deepEqual(held.map((l) => l.status), ["held", "held"]);
  assert.ok(held[0]!.checklist.blocking.some((b) => b.rule_id === "i-fcra-b1")); assert.equal(h.emitted("notice.sent").length, 0); assert.equal(h.emitted("notice.held").length, 2);
  assert.equal(b1EvidenceOnFile(h.events.byLoan(loanId)), false); assert.equal(svc.noticeRows().length, 0);
  // rendered with the model B-1 text and mailed Mon Nov 16, 2026 (the internal +3 BD target Tue Nov 17; 25.4's +5 BD clock Thu Nov 19)
  assert.equal(firstPaymentLetterTarget(D("2026-11-12")), "2026-11-17");
  const sent = await svc.sendFirstPaymentLetter("APP-REFI-1", { sent_on: D("2026-11-16"), mailed_at: "2026-11-16T17:00:00.000Z" });
  assert.deepEqual(sent.map((l) => l.status), ["sent", "sent"]);
  assert.ok(sent[0]!.rendered.includes("We may report information about your account to credit bureaus. Late payments, missed payments, or other defaults on your account may be reflected in your credit report."));
  assert.match(sent[0]!.rendered, /servicing on behalf of Partner Bank/); assert.match(sent[0]!.rendered, /not a notice of servicing transfer/);
  const rows = svc.noticeRows().filter((n) => n.template_code === B1_TEMPLATE && n.loan_id === loanId);
  assert.equal(rows.length, 2); assert.equal(rows[0]!.sent_at, "2026-11-16T17:00:00.000Z"); assert.equal(rows[0]!.carrier_notice_id, sent[0]!.notice_id);
  assert.equal(b1EvidenceOnFile(h.events.byLoan(loanId)), true);   // 8.1: FCRA_1681S2A7_NEG_INFO_NOTICE_30 pre-satisfied by pre-existing B-1 evidence
  const letterEvents = h.emitted("notice.sent").filter((e) => e.payload.template === FIRST_PAYMENT_LETTER);
  assert.equal(letterEvents.length, 2); assert.ok((letterEvents[0]!.payload.carries as string[]).includes(B1_TEMPLATE)); assert.equal(letterEvents[0]!.payload.mailed_at, "2026-11-16T17:00:00.000Z");
  // 25.4's SM_O64_FIRST_PAYMENT_LETTER_5BD (armed on `loan.funded`, disbursement + 5 BD = Thu Nov 19) is satisfied by `notice.sent{template=NTC_SM_FIRST_PAYMENT_LETTER}`
  const fpl = h.timers.byCode("SM_O64_FIRST_PAYMENT_LETTER_5BD")[0]!; assert.equal(fpl.dueDate, "2026-11-19"); assert.equal(fpl.status, "satisfied");
  await assert.rejects(svc.sendFirstPaymentLetter("APP-REFI-1", { sent_on: D("2026-11-17") }), /already sent/);
});

test("30.2-T7: Given `applicant_demographics` shows \"information not provided\" for race, then `borrower_fair_lending.collected_via='not_provided'` and `OB-013` passes; given a mapping attempt to infer race from surname, then the command is refused.", async () => {
  const h = harness("2026-11-12T18:40:00.000Z");
  const r = await boardRefinance(h);
  const fl = h.svc.record("APP-REFI-1").mapped.borrower_fair_lending;
  const b = fl.find((x) => x.party_id === "B-B")!; assert.equal(b.collected_via, "not_provided"); assert.equal(b.race, null); assert.equal(b.source, "application");
  const a = fl.find((x) => x.party_id === "B-A")!; assert.equal(a.collected_via, "self_reported"); assert.deepEqual(a.race, ["white"]);
  assert.equal(r.validations.find((v) => v.code === "OB-013")!.result, "pass");
  // a mapping attempt that derives race from the surname is refused — by the pure guard and by the bus (never a write, never a decision)
  const g = mapFieldGuard({ canonical_path: "PARTY/ROLES/ROLE/BORROWER/GOVERNMENT_MONITORING/Race", derivation: "inferred_from_surname" });
  assert.equal(g.ok, false); assert.equal((g as { code: string }).code, "INFERRED_DEMOGRAPHICS");
  assert.equal(mapFieldGuard({ canonical_path: "PARTY/ROLES/ROLE/BORROWER/GOVERNMENT_MONITORING/Race", derivation: "not_provided" }).ok, true);
  const { ctx, cmds, bus } = busFor(h, r.loan_id);
  const before = h.events.all().length;
  await assert.rejects(bus.execute(cmds.get(toolKey("30.2", "mapField"))!, BOARDING, { application_id: "APP-REFI-1", canonical_path: "PARTY/ROLES/ROLE/BORROWER/GOVERNMENT_MONITORING/Race", raw_value: "Borrower", canonical_value: ["inferred"], derivation: "inferred_from_surname" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "INFERRED_DEMOGRAPHICS");
  assert.deepEqual(h.events.all().slice(before).map((e) => e.type), ["command.refused"]);
  const ok = await bus.execute(cmds.get(toolKey("30.2", "mapField"))!, BOARDING, { application_id: "APP-REFI-1", canonical_path: "PARTY/ROLES/ROLE/BORROWER/GOVERNMENT_MONITORING/Race", raw_value: "information not provided", canonical_value: null, derivation: "not_provided", source_document_id: "DOC-1003" }, ctx);
  assert.equal((ok.output as { derivation: string }).derivation, "not_provided");
});

test("30.2-T8: Given the purchase fixture funded Wed Nov 18, 2026 with the MIN not yet registered, then the loan boards with `OW-004`, 26.4's 7-day timer is due Wed Nov 25, and `OW-004` clears on the MERS acknowledgment.", async () => {
  const h = harness("2026-11-18T20:20:00.000Z", { mers: "pending", tz: "America/New_York" });
  // 26.4 owns MERS_PROC_MOM_REGISTER_7 (the registry's default row for the code is 26.2's blank cross-reference): arm 26.4's own row in this harness.
  const row264 = loadRegistry().forProcess("26.4").find((t) => t.code === "MERS_PROC_MOM_REGISTER_7")!;
  h.registry.override("MERS_PROC_MOM_REGISTER_7", { trigger: row264.trigger, anchor: row264.anchor, offset: row264.offset, satisfied: row264.satisfied, why: "test harness: 26.4's definition of its own code" });
  h.clock.set("2026-11-18T21:00:00.000Z");
  const r = await boardFundedApplication(h.svc, purchaseSnapshot(), PURCHASE_FUNDED, { sent_on: D("2026-11-23"), mailed_at: "2026-11-23T17:00:00.000Z" });
  assert.equal(r.refusal, null); assert.equal(r.status, "boarded_with_warnings");
  assert.equal(r.validations.find((v) => v.code === "OB-008")!.result, "pass");                  // MIN valid, Org ID = partner — registration may still be pending
  assert.equal(r.validations.find((v) => v.code === "OB-009")!.result, "pass");                  // BPMI: certificate active, 25% coverage, $130.47 monthly, HPA disclosure
  const ow4 = r.validations.find((v) => v.code === "OW-004")!; assert.equal(ow4.result, "fail"); assert.equal(ow4.actual, "pending");
  assert.equal(recomputePi(NOTE_PURCHASE, 257_034n).recomputed_cents, 257_034n);
  assert.equal(firstPaymentWindow(D("2026-11-18"), D("2027-01-01")).latest, "2027-01-18");
  assert.equal(firstPaymentLetterTarget(D("2026-11-18")), "2026-11-23");                        // 3 BDs: Nov 19, 20, 23
  // 26.4's MOM clock: wet state, purchase → note date Nov 18 + 7 calendar days = Wed Nov 25 (MERS Procedures Rel. 26.1)
  const due = mersRegistrationDue({ loan_purpose: "purchase", escrow_state: false, note_date: D("2026-11-18"), funding_date: D("2026-11-18") });
  assert.equal(due.anchor_date, "2026-11-18"); assert.equal(due.due, "2026-11-25");
  const consummated = h.events.append({ type: "closing.consummated", loanId: r.loan_id, applicationId: "APP-PURCH-1", actor: { kind: "agent", id: "title-closing" }, payload: { application_id: "APP-PURCH-1", anchor_date: due.anchor_date, instrument: "mom", note_date: "2026-11-18" } });
  const mers7 = h.timers.byCode("MERS_PROC_MOM_REGISTER_7")[0] ?? h.timers.arm(h.registry.get("MERS_PROC_MOM_REGISTER_7")!, consummated);
  assert.equal(mers7.anchorDate, "2026-11-18"); assert.equal(mers7.dueDate, "2026-11-25"); assert.equal(mers7.status, "armed");
  // the MERS acknowledgment: `mers.min.registered{status=active}` (26.4's event) satisfies the clock and clears OW-004
  h.clock.set("2026-11-20T15:00:00.000Z");
  const ack = h.svc.recordMersAcknowledgment("APP-PURCH-1", { min: MIN_PURCHASE, status: "active", acknowledged_at: "2026-11-20T15:00:00.000Z" });
  assert.equal(ack.cleared, true); assert.equal(ack.event.type, "mers.min.registered"); assert.equal(ack.event.loanId, r.loan_id); assert.equal(ack.event.applicationId, "APP-PURCH-1");
  assert.equal(eventMatches(h.registry.get("MERS_PROC_MOM_REGISTER_7")!.satisfiedPattern!, ack.event), true); assert.equal(mers7.status, "satisfied");
  const rec = h.svc.record("APP-PURCH-1");
  assert.equal(rec.validations.find((v) => v.code === "OW-004")!.resolved?.resolution, "cleared");
  assert.deepEqual(h.emitted("loan.boarding_warning.resolved").map((e) => e.payload.rule_code), ["OW-004"]);
  assert.deepEqual(h.svc.openWarnings(rec).map((v) => v.code), ["OW-006", "OW-008", "OW-009"]);   // the trailing / tax-service warnings stay open
});

test("30.2-T9: Given a property in a state where SM holds no servicer license, then `OB-020` fails, the loan cannot board, and an `officer` escalation is created.", async () => {
  const h = harness("2026-11-12T18:40:00.000Z");
  const s = refinanceSnapshot(); const snapshot = refinanceSnapshot({ property: { ...s.property, state: "NV", city: "Las Vegas", postal_code: "89101", county: "Clark" } });
  assert.equal(h.ext.licensed("NV"), false);
  const r = await boardRefinance(h, snapshot);
  assert.equal(r.status, "exception"); assert.match(r.refusal!, /OB-020/);
  const ob20 = r.validations.find((v) => v.code === "OB-020")!; assert.equal(ob20.result, "fail"); assert.equal(ob20.actual, "NV"); assert.equal(ob20.money_field, false);
  assert.equal(h.svc.board("APP-REFI-1").ok, false); assert.equal(h.emitted("loan.boarded").length, 0); assert.equal(h.ledger.sets().length, 0);
  const esc = h.esc.list(); assert.equal(esc.length, 1); assert.equal(esc[0]!.kind, "officer"); assert.equal(esc[0]!.ownerRole, "officer"); assert.equal(esc[0]!.applicationId, "APP-REFI-1"); assert.equal(esc[0]!.payload.rule_code, "OB-020");
  assert.equal(h.emitted("escalation.created")[0]!.payload.kind, "officer");
  // an officer may waive the non-money hard rule with a written reason (interim servicing by a licensed sub-servicer is a partner decision); the agent cannot
  assert.equal(h.svc.waive("APP-REFI-1", "OB-020", BOARDING, "agent attempt").ok, false);
  const w = h.svc.waive("APP-REFI-1", "OB-020", { kind: "human", id: "u-officer", role: "officer" }, "partner-approved interim sub-servicing pending NV license");
  assert.equal(w.ok, true); assert.equal((w as { status: string }).status, "validated");
});

test("30.2-T10: Given the servicing loan number allocated at staging, then 29.3's ULDD export carries it as the Lender Loan Number and, after purchase, `fnma_establishment_checks` shows the same identifier (no LAR 81).", async () => {
  assert.equal(servicingLoanNumber(1).length, 10); assert.equal(isValidServicingLoanNumber(servicingLoanNumber(1)), true); assert.equal(isValidServicingLoanNumber("0000000019"), false);
  const h = harness("2026-11-12T18:40:00.000Z");
  const r = await boardRefinance(h);
  const staged = h.emitted("loan.staged")[0]!;
  assert.equal(staged.payload.servicing_loan_number, r.servicing_loan_number); assert.equal(isValidServicingLoanNumber(r.servicing_loan_number), true);
  assert.ok(h.svc.record("APP-REFI-1").mapped.staging.some((row) => row.canonical_path.includes("LoanIdentifierType=SellerLoan") && row.canonical_value === r.servicing_loan_number));
  const uldd = ulddLenderLoanNumber({ servicing_loan_number: r.servicing_loan_number });
  assert.equal(uldd.LoanIdentifierType, "SellerLoan"); assert.equal(uldd.LoanIdentifier, r.servicing_loan_number);
  // purchase Thu Nov 19 (30.1's `loan.purchased`): investor flips to fnma, OB-022 re-runs inverted, Fannie Mae's recorded servicer loan identifier equals SM's → no LAR 81
  h.clock.set("2026-11-19T20:00:00.000Z");
  h.events.append({ type: "loan.purchased", loanId: r.loan_id, applicationId: "APP-REFI-1", actor: { kind: "external", id: "fnma" }, payload: { application_id: "APP-REFI-1", fnma_loan_number: "4000000777", purchase_date: "2026-11-19" } });
  const p = h.svc.recordPurchase("APP-REFI-1", { fnma_loan_number: "4000000777", purchase_date: D("2026-11-19"), purchase_advice_document_id: "DOC-PA" });
  assert.equal(p.ob_022.result, "pass"); assert.equal(h.svc.record("APP-REFI-1").mapped.loans.investor, "fnma");
  assert.deepEqual(p.identifier_check, { check: "servicer_loan_identifier", result: "pass", lar_81_required: false, fnma_loan_number: "4000000777" });
  assert.equal(fnmaEstablishmentIdentifierCheck({ servicing_loan_number: r.servicing_loan_number, fnma_recorded_servicer_loan_identifier: "0000000000", fnma_loan_number: "4000000777" }).lar_81_required, true);
  assert.ok(h.svc.record("APP-REFI-1").documents_index.some((d) => d.kind === "purchase_advice"));
});

test("30.2-T11: Given the §1024.38(c)(2) compile command for the boarded loan on day 1, then the servicing file (transaction schedule, security-instrument copy, empty contact log, LBDS data-field report, no borrower submissions) is produced within 5 minutes (well inside five days).", async () => {
  const h = harness("2026-11-12T18:40:00.000Z");
  const r = await boardRefinance(h);
  h.clock.set("2026-11-13T16:00:00.000Z");   // day 1
  const file = h.svc.compileServicingFile("APP-REFI-1");
  assert.equal(file.loan_id, r.loan_id);
  assert.equal(file.transaction_schedule.length, r.ledger_set!.lines.length); assert.ok(file.transaction_schedule.some((l) => l.account === "loan:principal" && l.amount_cents === "56000000"));
  assert.equal(file.security_instrument?.document_id, "DOC-DOT"); assert.equal(file.security_instrument?.required_for_servicing_file, true); assert.equal(file.security_instrument?.retention_class, "fnma_loan_file_life_plus_4y");
  assert.deepEqual(file.contact_log, []); assert.deepEqual(file.borrower_submissions, []);
  assert.equal(file.data_field_report.length, h.svc.record("APP-REFI-1").mapped.staging.length); assert.ok(file.data_field_report.every((row) => row.source === "origination" && row.canonical_path.length > 0));
  assert.ok(file.compile_ms < 5 * 60 * 1000); assert.equal(file.within_five_minutes, true); assert.equal(file.within_five_days, true);
  assert.equal(h.emitted("servicing_file.compiled").length, 1);
  // rule 6 retention classes on the index
  const idx = h.svc.record("APP-REFI-1").documents_index;
  assert.equal(idx.find((d) => d.kind === "closing_disclosure_final")!.retention_class, "regz_cd_5y"); assert.equal(idx.find((d) => d.kind === "loan_estimate")!.retention_class, "regz_le_3y"); assert.equal(idx.find((d) => d.kind === "sfhdf")!.retention_class, "fdpa_life_of_loan"); assert.equal(idx.find((d) => d.kind === "esign_consent")!.retention_class, "esign_consent_life");
  assert.equal(retentionClassFor(["closing_disclosure_final", "note"]), "fnma_loan_file_life_plus_4y");   // the longest class wins
});

test("30.2-T12: Given a rescindable refinance with `rescission_expires_at` = Nov 10, 2026 23:59:59 MST and a `loan.funded` timestamp of Nov 10 09:00, then `OB-018` fails and boarding is refused (funding itself would have been blocked by 26.3).", async () => {
  const h = harness("2026-11-10T16:00:00.000Z");
  const funded: LoanFundedPayload = { ...REFI_FUNDED, funded_at: "2026-11-10T16:00:00.000Z" /* 09:00 MST Tue Nov 10 */, funding_date: D("2026-11-10"), disbursement_date: D("2026-11-10") };
  h.clock.set("2026-11-10T16:05:00.000Z");
  const r = await boardFundedApplication(h.svc, refinanceSnapshot(), funded);
  assert.equal(r.status, "exception"); assert.match(r.refusal!, /OB-018/);
  const ob18 = r.validations.find((v) => v.code === "OB-018")!; assert.equal(ob18.result, "fail"); assert.equal(ob18.expected, "2026-11-11T06:59:59.000Z"); assert.equal(ob18.actual, "2026-11-10T16:00:00.000Z");
  const b = h.svc.board("APP-REFI-1"); assert.equal(b.ok, false); assert.match((b as { reason: string }).reason, /rescission_expires_at .* is not before loan.funded/);
  assert.equal(h.emitted("loan.boarded").length, 0); assert.equal(h.ledger.sets().length, 0);
  // the bus refuses the boardLoan command on the same fact, before the handler runs
  const { ctx, cmds, bus } = busFor(h, r.loan_id);
  await assert.rejects(bus.execute(cmds.get(toolKey("30.2", "boardLoan"))!, BOARDING, { application_id: "APP-REFI-1", rescindable: true, rescission_expires_at: "2026-11-11T06:59:59.000Z", funded_at: "2026-11-10T16:00:00.000Z" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "RESCISSION_PENDING");
  // funded after the period ran (Thu Nov 12 11:40 MST): OB-018 passes
  const ok = harness("2026-11-12T18:40:00.000Z"); const r2 = await boardRefinance(ok);
  assert.equal(r2.validations.find((v) => v.code === "OB-018")!.result, "pass");
});

test("30.2-T13: Given the same `loan.funded` event delivered twice, then the second is ignored and no duplicate `loans` row, ledger entry or letter exists.", async () => {
  const h = harness("2026-11-12T18:40:00.000Z");
  const first = await boardRefinance(h);
  const second = await boardRefinance(h);
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true); assert.equal(second.loan_id, first.loan_id); assert.match(second.refusal!, /duplicate loan.funded ignored/);
  assert.equal(h.svc.all().length, 1);                                                   // one `loans` row
  assert.equal(h.ledger.sets().length, 1);                                               // one opening entry set
  assert.equal(h.emitted("loan.boarded").length, 1); assert.equal(h.emitted("loan.staged").length, 1);
  assert.equal(h.emitted("notice.sent").filter((e) => e.payload.template === FIRST_PAYMENT_LETTER).length, 2);   // one letter per borrower, not per delivery
  assert.equal(h.svc.record("APP-REFI-1").letters.filter((l) => l.status === "sent").length, 2);
  const receipt = h.emitted("loan.funded.duplicate_ignored"); assert.equal(receipt.length, 1); assert.equal(receipt[0]!.payload.receipt, "duplicate"); assert.equal(receipt[0]!.applicationId, "APP-REFI-1");
  assert.equal(h.emitted("loan.funded").length, 1); assert.equal(h.timers.byCode("SM_ORIG_BOARD_T1BD").length, 1);
});

test("30.2-T14: Given the loan is not `active` by Thu Dec 24, 2026 because the tax-service match is still open, then `SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE` breaches (sev-1), the Sentinel report lists it, and cashiering still applies the Jan 1 payment.", async () => {
  assert.equal(activeBeforeFirstDueGateDate(D("2027-01-01")), "2026-12-24");   // 5 servicer BDs before Jan 1: Dec 31, 30, 29, 28, 24 (Dec 25 holiday)
  const h = harness("2026-11-12T18:40:00.000Z");
  const r = await boardRefinance(h);
  const gate = h.timers.byCode("SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE")[0]!; assert.equal(gate.dueDate, "2026-12-24"); assert.equal(gate.status, "armed");
  // trailing documents and the LOL link arrive; the tax-service match does not — the loan stays boarded_with_warnings
  h.svc.clearWarning("APP-REFI-1", "OW-008", "recorded deed of trust confirmation"); h.svc.clearWarning("APP-REFI-1", "OW-009", "final title policy received");
  h.svc.waive("APP-REFI-1", "OW-002", { kind: "human", id: "u-lead", role: "ops_analyst" }, "borrower B declined electronic delivery; invitation sent with the letter");
  h.svc.recordVendorActivation("APP-REFI-1", "flood_lol"); h.svc.recordVendorActivation("APP-REFI-1", "insurance_tracking");
  const act = h.svc.activate("APP-REFI-1"); assert.equal(act.ok, false); assert.match((act as { reason: string }).reason, /open OW-\* warning/);
  assert.deepEqual(h.svc.openWarnings(h.svc.record("APP-REFI-1")).map((v) => v.code), ["OW-006"]);
  h.clock.set("2026-12-25T07:00:00.000Z");   // after Thu Dec 24 23:59
  const breaches = h.timers.evaluate("2026-12-25T07:00:00.000Z");
  const b = breaches.find((x) => x.instance.code === "SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE")!;
  assert.ok(b); assert.equal(b.severity, 1); assert.ok(b.escalateTo.includes("officer")); assert.equal(gate.status, "breached");
  const report = sentinelBoardingReport(breaches, "2026-12-25T07:00:00.000Z");
  const listed = report.items.find((i) => i.code === "SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE")!;
  assert.deepEqual([listed.loan_id, listed.code, listed.severity, listed.due_date, listed.escalate_to.includes("officer")], [r.loan_id, "SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE", 1, "2026-12-24", true]);
  assert.ok(report.items.every((i) => i.loan_id === r.loan_id));   // the daily report also carries the loan's other open 30.2 breaches (statement lead, 10-BD warning aging)
  assert.equal(h.emitted("timer.breached").some((e) => e.payload.code === "SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE" && e.loanId === r.loan_id), true);
  // cashiering accepts the January payment against the boarded record regardless (received Wed Dec 30; F-1-09 30/360 split)
  const state = cashStateAtBoarding({ loan_id: r.loan_id, note_date: D("2026-11-06"), note_rate_pct: "6.125", amount_cents: 56_000_000n, pi_cents: 340_262n, escrow_payment_cents: 68_750n, first_payment_date: D("2027-01-01"), late_charge_pct: "5.00", late_charge_grace_days: 15, escrowed: true });
  const plan = allocate(state, { payment_id: "PAY-1", amount_cents: 409_012n, received_on: D("2026-12-30"), credited_as_of: D("2026-12-30"), designation: "contractual" });
  assert.ok(plan.outcome === "applied" || plan.outcome === "prepaid", plan.outcome);
  assert.equal(plan.installments.length, 1); assert.equal(plan.installments[0]!.due_date, "2027-01-01");
  assert.equal(plan.installments[0]!.interest_cents, 285_833n); assert.equal(plan.installments[0]!.principal_cents, 54_429n); assert.equal(plan.installments[0]!.escrow_cents, 68_750n); assert.equal(plan.installments[0]!.upb_after_cents, 55_945_571n);
  assert.equal(plan.to_suspense_cents, 0n); assert.equal(plan.next.lpi_date, "2027-01-01");
  // the tax-service match finally lands: OW-006 clears, warnings_cleared closes SM_ORIG_WARNING_CLEAR_10BD (breached Nov 27 → satisfied_late), and `loan.active` closes the gate late
  h.svc.recordVendorActivation("APP-REFI-1", "tax_service");
  assert.equal(h.emitted("loan.boarding.warnings_cleared").length, 1);
  const a2 = h.svc.activate("APP-REFI-1"); assert.equal(a2.ok, true);
  assert.equal(h.emitted("loan.active")[0]!.loanId, r.loan_id); assert.equal(gate.status, "satisfied_late");
});

test("30.2 worked figures: refinance fixture ($560,000 / 6.125% / 360 / Phoenix AZ) and purchase fixture ($412,000 / 6.375% / BPMI $130.47)", () => {
  // OB-003: 560,000 × 0.00510416… / (1 − 1.00510416…^−360) = 3,402.619… → $3,402.62; tolerance $0.01 (1 cent)
  const pi = recomputePi(NOTE_REFI, 340_262n);
  assert.equal(pi.recomputed_cents, 340_262n); assert.equal(pi.within_tolerance, true); assert.equal(PI_TOLERANCE_CENTS_30_2, 1n);
  assert.equal(recomputePi(NOTE_REFI, 340_263n).within_tolerance, false);
  // December interest 560,000 × 0.06125 ÷ 12 = $2,858.33, principal $544.29, UPB after payment 1 $559,455.71
  const split = firstInstallmentSplit(NOTE_REFI, 340_262n);
  assert.equal(split.interest_cents, 285_833n); assert.equal(split.principal_cents, 54_429n); assert.equal(split.upb_after_cents, 55_945_571n);
  // OB-004: Nov 12–30, 2026 = 19 days × the cent-rounded 365-basis per diem $93.97 = $1,785.43; the unrounded product $1,785.48 is not used (26.3 `365_rounded_per_diem`)
  assert.equal(perDiem365Rounded(56_000_000n, "6.125"), 9_397n);
  const p = prepaidInterest(56_000_000n, "6.125", D("2026-11-12"));
  assert.equal(p.days, 19); assert.equal(p.prepaid_interest_cents, 178_543n); assert.equal(p.unrounded_product_cents, 178_548n); assert.notEqual(p.prepaid_interest_cents, p.unrounded_product_cents);
  // first statement: P&I $3,402.62 + escrow $687.50 = $4,090.12; late fee 5% × P&I = $170.13 after Jan 16, 2027
  const f = firstStatementFigures({ first_payment_date: D("2027-01-01"), pi_cents: 340_262n, escrow_payment_cents: 68_750n, late_charge_pct: "5.00", late_charge_grace_days: 15 });
  assert.equal(f.escrow_cents, 68_750n); assert.equal(f.amount_due_cents, 409_012n); assert.equal(lateChargeCents(340_262n, "5.00"), 17_013n); assert.equal(f.late_fee_line, "$170.13 after Jan 16, 2027");
  // purchase fixture: 412,000 × 0.0053125 ÷ (1 − 1.0053125^−360) = $2,570.34; BPMI monthly $130.47 on the escrow line; first payment ≤ Jan 18, 2027
  assert.equal(recomputePi({ amount_cents: 41_200_000n, note_rate_pct: "6.375", term_months: 360 }, 257_034n).recomputed_cents, 257_034n);
  const ps = purchaseSnapshot();
  assert.equal(ps.note.amount_cents, 41_200_000n); assert.equal(ps.mi!.monthly_premium_cents, 13_047n); assert.equal(ps.escrow_analysis!.lines.find((l) => l.line_type === "mi")!.monthly_cents, 13_047n);
  assert.deepEqual(firstPaymentWindow(D("2026-11-18"), D("2027-01-01")), { earliest: D("2026-11-19"), latest: D("2027-01-18"), ok: true });
  assert.deepEqual(firstPaymentWindow(D("2026-11-12"), D("2027-01-01")), { earliest: D("2026-11-13"), latest: D("2027-01-12"), ok: true });
});
