// 28.3 HMDA data capture, ULI generation, rate-spread and other derived fields, LAR editing, annual/quarterly submission, and public disclosure obligations
// spec/sections/28-quality-control-hmda-and-fraud-aml-reporting/28-3-hmda-data-capture-uli-generation-rate-spread-and-other-deriv.md
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
import { TOOLS_28_3 } from "../../app/tools/section28-3.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { EVALUATORS_28_3 } from "./evaluators-28-3.ts";
import type { LockRow } from "../underwriting/ops-23-4.ts";
import type { AporTable } from "../compliance-disclosures/ops-25-1.ts";
import { hmdaActionFor, ECOA_REASONS, type PrincipalReason } from "../application/ops-21-6.ts";
import { DISCLOSURE_STMT_NOTICE_SAMPLE } from "../../notices/authored/section28-3.ts";
import { type HmdaRecord, type PartnerFiling, type LarFile, createHmdaRecord, checkDigit, validateUli, assignUli, loanIdentifier, localFfiecCheckDigitApi, validateUliFfiec, applyGeocode, collectDemographics, demographicCodes, noCoApplicant, applicantScore, ausCodes, computeRateSpread, applyRateSpread, localRateSpreadApi, finalizeActionTaken, applyAdverseAction, applyPurchase, yearEndPurchaserJob, applyClosingDisclosure, larEntryDue, quarterEnd, runLocalEdits, runCompletenessJob, dailyCompletenessTick, coverageTest, recordCoverageDecision, coverageTestTick, annualDeadline, quarterlyDeadline, buildLarFile, uploadSubmission, receiveEdits, correctAtSource, explainEdit, verifyQualityEdits, verifyMacroEdits, officerSignDue, signSubmission, markFiled, larMoneyField, larDollars, larRow, disclosureNoticeDue, receiveFfiecDisclosureNotice, makePublicNoticeAvailable, attestNoticeAvailability, readApplicantDemographics, demographicsAccessLog, incomeThousands, filingCalendar, derive, FIXTURE_LEI, HMDA_AGENT, NOTICE_CODES_28_3 } from "./ops-28-3.ts";

const OFFICER: Actor = { kind: "human", id: "u-officer-1", role: "officer" };
const OPERATOR: Actor = { kind: "human", id: "u-hmda-op", role: "ops_analyst" };
const toolKey = (process: string, name: string): string => `${process} ${name}`;
const noticeReg = buildRegistry(); publishAuthored(noticeReg);
const REFI = "APP-REFI-560K", PURCHASE = "APP-PURCH-412K", DENIED = "APP-DENIED-1";
const PARTNER: PartnerFiling = { partner_id: "P-1", institution_name: "Partner Bank", lei: FIXTURE_LEI, tin: "86-1234567", contact: { name: "HMDA Compliance Officer", phone: "1-800-555-0100", email: "hmda@partnerbank.example", address: "100 Partner Plaza", city: "Phoenix", state: "AZ", zip: "85004" } };
/** APOR snapshots for the fixture weeks (README: 6.020 % fixture value; 30-year fixed; tables effective the Monday of each week). */
const APOR: AporTable[] = ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16"].map((d) => ({ table_date: D(d), term_years: 30, product: "fixed" as const, apor_pct: "6.020" }));
const LOCK_REFI: LockRow = { lock_id: "LK-REFI-1", kind: "initial", locked_at: "2026-10-07T15:10:00.000Z", rate_pct: "6.125", product: "fixed", term_years: 30 };
const LOCK_PURCHASE: LockRow = { lock_id: "LK-PUR-1", kind: "initial", locked_at: "2026-10-21T15:10:00.000Z", rate_pct: "6.375", product: "fixed", term_years: 30 };
const RELOCK_PURCHASE: LockRow = { lock_id: "LK-PUR-2", kind: "relock", locked_at: "2026-11-02T16:00:00.000Z", rate_pct: "6.375", product: "fixed", term_years: 30 };
/** Worked example 1: Mon Oct 5, 2026 09:58 MST `application.received` for the Phoenix refinance (amount applied for $560,000). */
const REFI_INPUT = { application_id: REFI, partner_id: "P-1", lei: FIXTURE_LEI, sequence: 101, received_at: "2026-10-05T16:58:00.000Z", application_date: D("2026-10-05"), transaction_type: "limited_cash_out" as const, occupancy: "primary" as const, loan_amount_cents: 56_000_000n, property: { street_address: "1 Palm Ln", city: "Phoenix", state: "AZ", zip: "85001" }, nmlsr_id: "123456" };
const PHOENIX_GEO = { state: "AZ", county_fips: "04013", census_tract: "04013111200", county_population: 4_420_568, source: "ffiec_geocoder", version: "2026" };

/** The 28.3 bus alone: TOOLS_28_3 bound to the `hmda` agent over the overridden registry (28.3 rows), escalations and the Notice Registry; the application-scoped unit of work stamps `applicationId` on every event. */
function harness(applicationId: string | null, nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, applicationId ? { applicationId } : {});
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["28.3"] });
  const escalations = new EscalationService(events, clock); const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId: applicationId ?? "", events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: {}, ports: {} };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const agents = new AgentRegistry(); const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of TOOLS_28_3) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(toolKey(d.process, d.name), cmd); }
  const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = HMDA_AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("28.3", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
  return { clock, events, timers, escalations, rt, uow, run, at, timer, ofType, decisions };
}
const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
/** The refinance record through worked example 1 up to the final CD (Nov 2) and funding (Nov 12): every data point derived with provenance. */
function refinanceThroughFunding(h: ReturnType<typeof harness>): HmdaRecord {
  let rec = createHmdaRecord(h.events, REFI_INPUT).record;
  rec = applyGeocode(rec, PHOENIX_GEO, "2026-10-05T17:00:00.000Z");
  const row = collectDemographics({ collection_method: "telephone", ethnicity: ["not_hispanic_or_latino"], race: ["white"], sex: "male", collected_at: "2026-10-05T16:30:00.000Z" });
  rec = { ...rec, applicant: demographicCodes(row, { dob: D("1985-03-14"), application_date: rec.application_date }), co_applicant: noCoApplicant() };
  const s = applicantScore({ score_model: "classic_fico", scores: { efx: 740, exp: 748, tu: 752 } });
  rec = { ...rec, applicant_credit_score: s.score, applicant_score_model: s.model, applicant_score_model_text: s.model_text, ...ausCodes("approve_eligible") };
  rec = applyClosingDisclosure(h.events, rec, { total_loan_costs_cents: 124_500n, origination_charges_cents: 0n, discount_points_cents: 0n, lender_credits_cents: 0n, interest_rate: "6.125", loan_term_months: 360, intro_rate_period_months: null, apr: "6.159", cd_version: 1, dti: "38.000", cltv: "70.000", property_value_cents: 80_000_000n, hoepa_status: 2 }, "2026-11-02T20:00:00.000Z");
  rec = finalizeActionTaken(h.events, rec, { consummation_date: D("2026-11-06"), funded_on: D("2026-11-12"), rescindable: true, rescission_expires_on: D("2026-11-10"), rescission_exercised_on: null, note_amount_cents: 56_000_000n }, "2026-11-12T17:00:00.000Z").record;
  rec = applyRateSpread(h.events, rec, computeRateSpread({ apr: "6.159", locks: [LOCK_REFI], final_action_on: D("2026-11-06"), apor_tables: APOR, action_taken: 1, loan_amount_cents: 56_000_000n }), "2026-11-12T17:05:00.000Z");
  rec = derive(null, rec, "income_thousands", incomeThousands(14_500_000n), { source: "decisions.risk_assessment.capacity.income_sources", ref: "D-REFI-1", version: 1, derived_at: "2026-11-12T17:05:00.000Z" }, "2026-11-12T17:05:00.000Z");
  return rec;
}
/** Worked example 2's denied application (21.6 worked example 1): notice Tue Oct 27, 2026; DTI 51.3 and a 30-day late → HMDA reasons 1 and 3 through 21.6's taxonomy. */
function deniedRecord(events: MemoryEventStore): HmdaRecord {
  let rec = createHmdaRecord(events, { ...REFI_INPUT, application_id: DENIED, sequence: 103, property: { street_address: "5 Cactus Ct", city: "Phoenix", state: "AZ", zip: "85002" } }).record;
  rec = applyGeocode(rec, { ...PHOENIX_GEO, census_tract: "04013111300" }, "2026-10-05T17:00:00.000Z");
  const row = collectDemographics({ collection_method: "internet", ethnicity: ["not_hispanic_or_latino"], race: ["white"], sex: "female", collected_at: "2026-10-05T16:30:00.000Z" });
  rec = { ...rec, applicant: demographicCodes(row, { dob: D("1990-07-01"), application_date: rec.application_date }), co_applicant: noCoApplicant(), applicant_credit_score: 712, applicant_score_model: 2, ...ausCodes("refer_with_caution"), dti: "51.300", cltv: "70.000", property_value_cents: 80_000_000n };
  const reasons: PrincipalReason[] = [{ reason_code: "dti_excessive", statement_text: ECOA_REASONS.dti_excessive!.statement_text, factor_ref: "dti_max_50", source: "rules", hmda_denial_code: ECOA_REASONS.dti_excessive!.hmda_denial_code, automatic: false, materiality: 1 }, { reason_code: "credit_delinquent", statement_text: ECOA_REASONS.credit_delinquent!.statement_text, factor_ref: "credit_delinquent", source: "credit_report", hmda_denial_code: ECOA_REASONS.credit_delinquent!.hmda_denial_code, automatic: false, materiality: 0.6 }];
  const h21 = hmdaActionFor({ kind: "denial", notice_sent_on: D("2026-10-27"), reasons });
  return applyAdverseAction(events, rec, { action_taken: h21.action_taken as 3, action_taken_date: h21.action_taken_date, denial_reasons: h21.denial_reasons, denial_reason_other_text: h21.denial_reason_other_text, basis: h21.basis }, "2026-10-27T16:00:00.000Z").record;
}

test("28.3-T1: Given `application.received` on Mon Oct 5, 2026 for the refinance fixture, then a `hmda_records` row exists within the same transaction with `uli = 549300SMPARTNER00155A26R00010149`, `check_digit = 49`, `application_date = 2026-10-05`, `loan_purpose = 31`, and the FFIEC validate call returns `isValid = true`.", async () => {
  const h = harness(REFI, "2026-10-05T16:58:00.000Z");
  const before = h.events.all().length;
  const out = await h.run("createRecord", { partner_id: "P-1", lei: FIXTURE_LEI, sequence: 101, application_date: "2026-10-05", transaction_type: "limited_cash_out", occupancy: "primary", loan_amount_cents: 56_000_000n, property: REFI_INPUT.property, nmlsr_id: "123456" });
  assert.equal(out.uli, "549300SMPARTNER00155A26R00010149"); assert.equal(out.check_digit, "49"); assert.equal(out.loan_identifier, "A26R000101");
  assert.equal(out.application_date, "2026-10-05"); assert.equal(out.loan_purpose, 31); assert.equal(out.completeness_status, "open");
  // the row and its ULI registry entry exist in the same unit of work as the creation events (one transaction: record, hmda_ulis, applications.uli)
  const rec = h.rt.store.get("hmda_records", REFI)!.data as unknown as HmdaRecord;
  assert.equal(rec.uli, "549300SMPARTNER00155A26R00010149"); assert.equal(rec.lei, FIXTURE_LEI); assert.equal(rec.preapproval, 2); assert.equal(rec.construction_method, 1); assert.equal(rec.occupancy_type, 1); assert.equal(rec.loan_amount_cents, 56_000_000n);
  assert.equal(h.rt.store.get("hmda_ulis", rec.uli)!.data.application_id, REFI); assert.equal(h.rt.store.get("applications", REFI)!.data.uli, rec.uli);
  const created = h.events.all().slice(before).filter((e) => e.type === "hmda.record.created" || e.type === "hmda.uli.assigned");
  assert.equal(created.length, 2); assert.ok(created.every((e) => e.applicationId === REFI && e.occurredAt === "2026-10-05T16:58:00.000Z"));
  // the FFIEC Check Digit API validate call (`POST /v2/public/uli/validate {"uli"}`) → {"isValid": true}; validated_by_ffiec_api recorded once
  const v = await h.run("validateUliFfiec", { uli: rec.uli });
  assert.equal(v.isValid, true); assert.equal(v.validated_by_ffiec_api, true); assert.equal(v.remainder, 1);
  assert.deepEqual(localFfiecCheckDigitApi.validate(rec.uli), { uli: rec.uli, isValid: true });
  assert.equal(localFfiecCheckDigitApi.checkDigit(`${FIXTURE_LEI}A26R000101`).checkDigit, "49");
  // rule 2: the identifier is opaque — an SSN-shaped or DOB-shaped identifier is refused
  await refused(h.run("assignUli", { lei: FIXTURE_LEI, loan_identifier: "A26R123456789" }), "ULI_NEVER_PII");
});

test("28.3-T2: Given the FFIEC example loan ID `EILKZAIZF6TX4HB8ZDX33H`, when the check digit is computed, then it equals `54`; given the ULI `549300SMPARTNER00155A260R0010149` (transposed), then validation fails (remainder 60).", () => {
  assert.equal(checkDigit("EILKZAIZF6TX4HB8ZDX33H"), "54");
  assert.deepEqual(localFfiecCheckDigitApi.checkDigit("EILKZAIZF6TX4HB8ZDX33H"), { loanId: "EILKZAIZF6TX4HB8ZDX33H", checkDigit: "54" });
  assert.equal(checkDigit("eilkzaizf6tx4hb8zdx33h"), "54", "not case-sensitive (Appendix C step 1)");
  // the fixture ULI validates (remainder 1); the transposition R0 → 0R fails with remainder 60; the last digit 1 → 7 fails with remainder 19
  assert.deepEqual(validateUli("549300SMPARTNER00155A26R00010149"), { valid: true, remainder: 1 });
  assert.deepEqual(validateUli("549300SMPARTNER00155A260R0010149"), { valid: false, remainder: 60 });
  assert.deepEqual(validateUli("549300SMPARTNER00155A26R00010749"), { valid: false, remainder: 19 });
  assert.equal(localFfiecCheckDigitApi.validate("549300SMPARTNER00155A260R0010149").isValid, false);
  // purchase fixture identifier A26P000102 → check digit 14
  assert.equal(assignUli(FIXTURE_LEI, loanIdentifier({ application_date: D("2026-10-19"), transaction_type: "purchase", sequence: 102 })).uli, "549300SMPARTNER00155A26P00010214");
  assert.throws(() => assignUli("SHORT", "A26R000101"), /LEI is 20 alphanumeric/);
  assert.throws(() => assignUli(FIXTURE_LEI, "A26R0001010000000000000X"), /1…23/);
});

test("28.3-T3: Given APR 6.159% (25.1's fixture result), APOR 6.020% for the week containing Wed Oct 7, 2026, a 30-year fixed loan and action 1, then `rate_spread = 0.139` locally and the FFIEC API response is `\"0.139\"`; given a relock on Mon Nov 2, 2026, then `rate_set_date = 2026-11-02` and the APOR of that week is used.", async () => {
  const r = computeRateSpread({ apr: "6.159", locks: [LOCK_REFI], final_action_on: D("2026-11-06"), apor_tables: APOR, action_taken: 1, loan_amount_cents: 56_000_000n });
  assert.equal(r.rate_spread, "0.139"); assert.equal(r.rate_set_date, "2026-10-07"); assert.equal(r.apor, "6.020"); assert.equal(r.apor_table_date, "2026-10-05");
  assert.deepEqual(r.api_request, { actionTakenType: 1, loanTerm: 30, amortizationType: "FixedRate", apr: 6.159, lockInDate: "2026-10-07", reverseMortgage: 2 });
  assert.deepEqual(r.api_response, { rateSpread: "0.139" });
  assert.deepEqual(localRateSpreadApi(r.api_request!, APOR), { rateSpread: "0.139" });
  // the purchase fixture: lock Wed Oct 21, relock at the counteroffer amount Mon Nov 2 → the last rate-set before final action (Nov 18) and that week's table
  const p = computeRateSpread({ apr: "6.421", locks: [LOCK_PURCHASE, RELOCK_PURCHASE], final_action_on: D("2026-11-18"), apor_tables: APOR, action_taken: 1, loan_amount_cents: 36_000_000n });
  assert.equal(p.rate_set_date, "2026-11-02"); assert.equal(p.apor_table_date, "2026-11-02"); assert.equal(p.rate_spread, "0.401");
  // an extension keeps the prior rate-set date (23.4 rateSetDate); a lower APR gives a negative spread; a denied application is NA (comment 4(a)(12)-6)
  const ext = computeRateSpread({ apr: "6.159", locks: [LOCK_REFI, { ...LOCK_REFI, lock_id: "LK-REFI-EXT", kind: "extension", locked_at: "2026-10-28T15:00:00.000Z" }], final_action_on: D("2026-11-06"), apor_tables: APOR, action_taken: 1, loan_amount_cents: 56_000_000n });
  assert.equal(ext.rate_set_date, "2026-10-07");
  assert.equal(computeRateSpread({ apr: "5.900", locks: [LOCK_REFI], final_action_on: D("2026-11-06"), apor_tables: APOR, action_taken: 1, loan_amount_cents: 56_000_000n }).rate_spread, "-0.120");
  const na = computeRateSpread({ apr: "6.159", locks: [LOCK_REFI], final_action_on: D("2026-10-27"), apor_tables: APOR, action_taken: 3, loan_amount_cents: 56_000_000n });
  assert.equal(na.rate_spread, "NA"); assert.deepEqual(na.api_response, { rateSpread: "NA" });
  // through the bus: the local computation is authoritative and the API cross-check must agree
  const h = harness(REFI, "2026-11-12T17:00:00.000Z");
  const out = await h.run("validateUliFfiec", { op: "rate_spread", apr: "6.159", locks: [LOCK_REFI], final_action_on: "2026-11-06", apor_tables: APOR, action_taken: 1, loan_amount_cents: 56_000_000n });
  assert.equal(out.rate_spread, "0.139"); assert.deepEqual(out.api_response, { rateSpread: "0.139" });
});

test("28.3-T4: Given the loan funds Thu Nov 12, 2026 after rescission expires Tue Nov 10, then `action_taken = 1` and `action_taken_date = 2026-11-06`; given a rescission on Mon Nov 9, then `action_taken = 2`.", () => {
  const h = harness(REFI, "2026-11-12T17:00:00.000Z");
  const rec = createHmdaRecord(h.events, REFI_INPUT).record;
  const funded = finalizeActionTaken(h.events, rec, { consummation_date: D("2026-11-06"), funded_on: D("2026-11-12"), rescindable: true, rescission_expires_on: D("2026-11-10"), rescission_exercised_on: null, note_amount_cents: 56_000_000n }, "2026-11-12T17:00:00.000Z");
  assert.equal(funded.record.action_taken, 1); assert.equal(funded.record.action_taken_date, "2026-11-06"); assert.equal(funded.record.reporting_year, 2026);
  assert.equal(funded.record.completeness_status, "final_action_pending_fields"); assert.equal(funded.record.lar_entry_due_on, "2027-01-30");
  assert.equal(funded.event.type, "hmda.action_taken.recorded"); assert.equal(funded.event.payload.quarter_end, "2026-12-31"); assert.equal(funded.event.applicationId, REFI);
  // a rescission exercised Mon Nov 9 → approved but not accepted (2) with the rescission date; loan costs NA
  const rescinded = finalizeActionTaken(h.events, { ...rec, total_loan_costs_cents: 124_500n }, { consummation_date: D("2026-11-06"), funded_on: D("2026-11-12"), rescindable: true, rescission_expires_on: D("2026-11-10"), rescission_exercised_on: D("2026-11-09"), note_amount_cents: 56_000_000n }, "2026-11-09T20:00:00.000Z");
  assert.equal(rescinded.record.action_taken, 2); assert.equal(rescinded.record.action_taken_date, "2026-11-09"); assert.equal(rescinded.record.total_loan_costs_cents, null);
  // guards: no code 1 before the rescission period expires; one action code per application
  assert.throws(() => finalizeActionTaken(h.events, rec, { consummation_date: D("2026-11-06"), funded_on: D("2026-11-09"), rescindable: true, rescission_expires_on: D("2026-11-10"), rescission_exercised_on: null, note_amount_cents: 56_000_000n }, "2026-11-09T17:00:00.000Z"), /rescission\.period\.expired/);
  assert.throws(() => finalizeActionTaken(h.events, funded.record, { consummation_date: D("2026-11-06"), funded_on: D("2026-11-12"), rescindable: true, rescission_expires_on: D("2026-11-10"), rescission_exercised_on: D("2026-11-09"), note_amount_cents: 56_000_000n }, "2026-11-12T17:00:00.000Z"), /already reports action 1/);
  // a purchase (not rescindable) is originated at consummation: Wed Nov 18 wet-funded same day → 1 on 20261118
  const purchase = finalizeActionTaken(h.events, createHmdaRecord(h.events, { ...REFI_INPUT, application_id: PURCHASE, sequence: 102, application_date: D("2026-10-19"), transaction_type: "purchase", loan_amount_cents: 41_200_000n }).record, { consummation_date: D("2026-11-18"), funded_on: D("2026-11-18"), rescindable: false, rescission_expires_on: null, rescission_exercised_on: null, note_amount_cents: 36_000_000n }, "2026-11-18T22:00:00.000Z").record;
  assert.equal(purchase.action_taken, 1); assert.equal(purchase.action_taken_date, "2026-11-18"); assert.equal(purchase.loan_amount_cents, 36_000_000n, "the record follows the terms of the counteroffer (comment 4(a)(8)(i)-9)");
});

test("28.3-T5: Given the loan is purchased by Fannie Mae Thu Nov 19, 2026, then `purchaser_type = 1`; given no sale by Dec 31, 2026, then the Jan 1, 2027 job sets `purchaser_type = 0`.", () => {
  const h = harness(REFI, "2026-11-19T20:00:00.000Z");
  const rec = refinanceThroughFunding(h);
  assert.equal(rec.purchaser_type, null, "pending the sale or year-end");
  const sold = applyPurchase(h.events, rec, { purchase_date: D("2026-11-19"), investor: "fnma" }, "2026-11-19T20:00:00.000Z");
  assert.equal(sold.purchaser_type, 1); assert.equal(sold.field_sources.purchaser_type!.source, "loan.purchased");
  // not sold by Dec 31, 2026: the daily job of Jan 1, 2027 sets 0 (no later restatement when sold in 2027)
  assert.equal(yearEndPurchaserJob(null, rec, D("2026-12-31")).purchaser_type, null);
  const unsold = yearEndPurchaserJob(null, rec, D("2027-01-01"));
  assert.equal(unsold.purchaser_type, 0);
  assert.equal(applyPurchase(null, rec, { purchase_date: D("2027-01-14"), investor: "fnma" }, "2027-01-14T20:00:00.000Z").purchaser_type, 0, "a sale in the following calendar year is not reported for the origination year");
  assert.throws(() => applyPurchase(null, createHmdaRecord(h.events, { ...REFI_INPUT, application_id: DENIED, sequence: 103 }).record, { purchase_date: D("2026-11-19"), investor: "fnma" }, "2026-11-19T20:00:00.000Z"), /only an originated loan/);
  const run = runCompletenessJob(h.events, [rec], { as_of: D("2027-01-01") });
  assert.equal(run.records[0]!.purchaser_type, 0); assert.equal(run.records[0]!.completeness_status, "complete");
});

test("28.3-T6: Given the denied application (notice Tue Oct 27, 2026) with reasons DTI and credit history, then `action_taken = 3`, `action_taken_date = 2026-10-27`, `denial_reasons = {1, 3}`, `rate_spread = NA`, money fields NA, `aus_1 = 1`, `aus_result_1 = 5`.", () => {
  const h = harness(DENIED, "2026-10-27T16:00:00.000Z");
  const rec = deniedRecord(h.events);
  assert.equal(rec.action_taken, 3); assert.equal(rec.action_taken_date, "2026-10-27"); assert.deepEqual(rec.denial_reasons, [1, 3]);
  assert.equal(rec.rate_spread, null); assert.equal(rec.rate_spread_ffiec_response, "NA");
  assert.equal(rec.total_loan_costs_cents, null); assert.equal(rec.origination_charges_cents, null); assert.equal(rec.discount_points_cents, null); assert.equal(rec.lender_credits_cents, null); assert.equal(rec.interest_rate, null);
  assert.equal(rec.aus_1, 1); assert.equal(rec.aus_result_1, 5, "Refer with Caution — the result relied on");
  assert.equal(rec.dti, "51.300"); assert.equal(rec.property_value_cents, 80_000_000n); assert.equal(rec.lar_entry_due_on, "2027-01-30");
  const row = larRow(rec).split("|");
  assert.equal(row[10], "3"); assert.equal(row[11], "20261027"); assert.equal(row[58], "NA", "rate spread NA"); assert.deepEqual(row.slice(67, 71), ["1", "3", "", ""]);
  assert.deepEqual(row.slice(72, 77), ["NA", "NA", "NA", "NA", "NA"], "money fields NA"); assert.equal(row[77], "NA", "interest rate NA"); assert.equal(row[95], "1"); assert.equal(row[101], "5");
  assert.deepEqual(ausCodes(null), { aus_1: 6, aus_result_1: 17 }, "denied before any DU submission");
  assert.throws(() => applyAdverseAction(h.events, createHmdaRecord(h.events, { ...REFI_INPUT, application_id: "APP-X", sequence: 104 }).record, { action_taken: 3, action_taken_date: D("2026-10-27"), denial_reasons: [1, 2, 3, 4, 5] }, "2026-10-27T16:00:00.000Z"), /one to four/);
  // the daily job completes the denied record the next day (worked example 2: complete Oct 28)
  const run = runCompletenessJob(h.events, [rec], { as_of: D("2026-10-28") });
  assert.equal(run.results[0]!.status, "complete"); assert.deepEqual(run.results[0]!.missing_fields, []);
});

test("28.3-T7: Given final action in Q4 2026, then `HMDA_1003_4F_LAR_ENTRY_Q30` is due Sat Jan 30, 2027 and the daily job marks the record `complete` no later than that date; a record still incomplete on Jan 31 raises `hmda.completeness.failed` at sev 2.", () => {
  assert.deepEqual(larEntryDue(D("2026-11-06")), { quarter_end: D("2026-12-31"), due_on: D("2027-01-30") });
  assert.equal(quarterEnd(D("2026-10-27")), "2026-12-31"); assert.equal(larEntryDue(D("2027-02-03")).due_on, "2027-04-30");
  const h = harness(REFI, "2026-11-12T17:00:00.000Z");
  const rec = refinanceThroughFunding(h);
  const t = h.timer("HMDA_1003_4F_LAR_ENTRY_Q30")!;
  assert.equal(t.anchorDate, "2026-12-31"); assert.equal(t.dueDate, "2027-01-30"); assert.equal(t.status, "armed");
  // Thu Nov 19 purchase → Fri Nov 20 daily run marks the record complete (until then final_action_pending_fields{purchaser_type})
  const pending = runCompletenessJob(h.events, [rec], { as_of: D("2026-11-19") });
  assert.equal(pending.results[0]!.status, "final_action_pending_fields"); assert.deepEqual(pending.results[0]!.missing_fields, ["purchaser_type"]); assert.equal(pending.results[0]!.days_to_due, 72);
  h.at("2026-11-20T09:00:00.000Z"); dailyCompletenessTick(h.events, D("2026-11-20"));
  const daily = h.timer("SM_HMDA_LAR_COMPLETENESS_DAILY")!; assert.equal(daily.status, "armed"); assert.equal(daily.dueDate, "2026-11-21");
  const sold = applyPurchase(h.events, pending.records[0]!, { purchase_date: D("2026-11-19"), investor: "fnma" }, "2026-11-19T20:00:00.000Z");
  const done = runCompletenessJob(h.events, [sold], { as_of: D("2026-11-20") });
  assert.equal(done.results[0]!.status, "complete"); assert.equal(done.records[0]!.completeness_status, "complete"); assert.equal(done.failed.length, 0);
  assert.equal(h.ofType("hmda.record.finalized").length, 1); assert.equal(t.status, "satisfied", "completeness_status = complete satisfies the §1003.4(f) clock");
  assert.equal(h.ofType("hmda.completeness.checked").length, 2); assert.equal(daily.status, "satisfied", "the job run with results satisfies the daily row");
  assert.ok(h.timers.byCode("SM_HMDA_LAR_COMPLETENESS_DAILY").length >= 2, "the recurring row re-arms for the next day");
  // a record still incomplete on Sun Jan 31, 2027 (rate spread never derived) → hmda.completeness.failed at sev 2 to compliance-sentinel and the clock breaches
  const h2 = harness(PURCHASE, "2026-11-18T22:00:00.000Z");
  let stale = createHmdaRecord(h2.events, { ...REFI_INPUT, application_id: PURCHASE, sequence: 102, application_date: D("2026-10-19"), transaction_type: "purchase", loan_amount_cents: 41_200_000n }).record;
  stale = applyGeocode(stale, { state: "OH", county_fips: "39049", census_tract: "39049001100", county_population: 1_323_807, source: "ffiec_geocoder", version: "2026" }, "2026-10-19T17:00:00.000Z");
  stale = { ...stale, applicant: noCoApplicant(), co_applicant: noCoApplicant(), applicant_credit_score: 702, applicant_score_model: 3, ...ausCodes("approve_eligible") };
  stale = finalizeActionTaken(h2.events, stale, { consummation_date: D("2026-11-18"), funded_on: D("2026-11-18"), rescindable: false, rescission_expires_on: null, rescission_exercised_on: null, note_amount_cents: 36_000_000n }, "2026-11-18T22:00:00.000Z").record;
  const clock = h2.timer("HMDA_1003_4F_LAR_ENTRY_Q30")!; assert.equal(clock.dueDate, "2027-01-30");
  h2.at("2027-01-31T09:00:00.000Z");
  const late = runCompletenessJob(h2.events, [stale], { as_of: D("2027-01-31"), escalations: h2.escalations });
  assert.equal(late.failed.length, 1); assert.ok(late.failed[0]!.missing_fields.includes("rate_spread")); assert.equal(late.failed[0]!.overdue, true);
  const failedEvent = h2.ofType("hmda.completeness.failed")[0]!; assert.equal(failedEvent.payload.severity, 2); assert.equal(failedEvent.payload.route, "compliance-sentinel"); assert.equal(failedEvent.payload.lar_entry_due_on, "2027-01-30");
  assert.equal(late.escalations[0]!.kind, "sev2"); assert.equal(late.escalations[0]!.severity, "sev2");
  const breaches = h2.timers.evaluate("2027-01-31T09:00:00.000Z"); assert.ok(breaches.some((b) => b.instance.code === "HMDA_1003_4F_LAR_ENTRY_Q30"), "the §1003.4(f) clock breaches on Jan 31");
});

test("28.3-T8: Given `applications.score_model = vantagescore_4`, then `applicant_score_model = 15`; given Classic FICO with the middle score from Experian, then `2`; a borrower with no score → score `8888`, model `9`.", () => {
  const vantage = applicantScore({ score_model: "vantagescore_4", scores: { efx: 740, exp: 748, tu: 752 } });
  assert.equal(vantage.model, 15); assert.equal(vantage.score, 748); assert.equal(vantage.model_text, "VantageScore 4.0");
  // Classic FICO: middle of three from Experian → 2 (Experian Fair Isaac Risk Model v2); the same scores with the middle from Equifax → 1; TransUnion → 3
  const fico = applicantScore({ score_model: "classic_fico", scores: { efx: 740, exp: 748, tu: 752 } });
  assert.equal(fico.model, 2); assert.equal(fico.score, 748); assert.equal(fico.bureau, "Experian"); assert.equal(fico.model_text, "Experian Fair Isaac Risk Model v2");
  assert.equal(applicantScore({ score_model: "classic_fico", scores: { efx: 688, exp: 680, tu: 695 } }).model, 1);
  assert.equal(applicantScore({ score_model: "classic_fico", scores: { efx: 690, exp: 720, tu: 702 } }).model, 3, "worked example 2: 702 TransUnion middle → model 3");
  assert.equal(applicantScore({ score_model: "classic_fico", scores: { efx: 700, exp: 710 } }).score, 700, "two scores → the lower (22.2)");
  const none = applicantScore({ score_model: "classic_fico", scores: { efx: null, exp: null, tu: null } });
  assert.equal(none.score, 8888); assert.equal(none.model, 9); assert.equal(none.bureau, null);
  assert.deepEqual(applicantScore({ score_model: "vantagescore_4", scores: {} }), none);
});

test("28.3-T9: Given the annual file for 2026 uploaded Tue Jan 5, 2027 with one validity edit, then the record is corrected at source, a new submission sequence is created, and status 14 is reached only after quality and macro edits are verified with stored explanations; the `/sign` call succeeds only under the officer's token and stores a receipt; `HMDA_1003_5_ANNUAL_0301` (Mon Mar 1, 2027) is satisfied.", async () => {
  assert.equal(annualDeadline(2026), "2027-03-01"); assert.equal(annualDeadline(2027), "2028-03-01");
  assert.deepEqual([quarterlyDeadline(2027, 1), quarterlyDeadline(2027, 2), quarterlyDeadline(2027, 3)], ["2027-05-30", "2027-08-29", "2027-11-29"]);
  assert.deepEqual(filingCalendar(2026), { build_on: D("2027-01-05"), edits_target_on: D("2027-02-01"), sign_by_on: D("2027-02-20"), deadline: D("2027-03-01"), coverage_tick_on: D("2027-01-02"), coverage_decide_by: D("2027-01-31"), modified_lar_notice_by: D("2027-03-31"), q1: D("2027-05-30"), q2: D("2027-08-29"), q3: D("2027-11-29") });
  const h = harness(null, "2027-01-02T13:00:00.000Z");
  // Jan 2 coverage tick → the officer's decision (covered) arms the Mar 1 deadline
  coverageTestTick(h.events, D("2027-01-02"), "P-1"); const cov = h.timer("HMDA_1003_2G_COVERAGE_TEST_ANNUAL")!; assert.equal(cov.dueDate, "2027-01-31");
  recordCoverageDecision(h.events, coverageTest({ partner_id: "P-1", reporting_year: 2026, msa_office_on_dec31: true, closed_end_y1: 1_140, closed_end_y2: 310 }), OFFICER, "2027-01-04T18:00:00.000Z");
  assert.equal(cov.status, "satisfied"); assert.equal(h.timers.byCode("HMDA_1003_2G_COVERAGE_TEST_ANNUAL").length, 2, "the recurring row re-arms for next year");
  const annual = h.timer("HMDA_1003_5_ANNUAL_0301")!; assert.equal(annual.dueDate, "2027-03-01"); assert.equal(annual.status, "armed");
  // the records of the year: the refinance (complete Nov 20) and the denied application (complete Oct 28)
  const hr = harness(REFI, "2026-11-20T09:00:00.000Z"); const refi = runCompletenessJob(hr.events, [applyPurchase(null, refinanceThroughFunding(hr), { purchase_date: D("2026-11-19"), investor: "fnma" }, "2026-11-19T20:00:00.000Z")], { as_of: D("2026-11-20") }).records[0]!;
  const hd = harness(DENIED, "2026-10-28T09:00:00.000Z"); const denied = runCompletenessJob(hd.events, [deniedRecord(hd.events)], { as_of: D("2026-10-28") }).records[0]!;
  let records: HmdaRecord[] = [refi, denied];
  // Tue Jan 5, 2027: build + upload sequence 1
  h.at("2027-01-05T15:00:00.000Z");
  const built = buildLarFile(h.events, records, { partner: PARTNER, reporting_year: 2026, built_at: "2027-01-05T15:00:00.000Z" });
  assert.equal(built.file.kind, "annual"); assert.equal(built.file.lar_row_count, 2); assert.equal(built.file.filing_deadline, "2027-03-01"); assert.equal(built.file.edits_target_on, "2027-02-01");
  assert.ok(built.text.startsWith(`1|Partner Bank|2026|4|HMDA Compliance Officer|1-800-555-0100|hmda@partnerbank.example|100 Partner Plaza|Phoenix|AZ|85004|9|2|86-1234567|${FIXTURE_LEI}\n2|${FIXTURE_LEI}|549300SMPARTNER00155A26R00010149|20261005|1|31|2|1|1|560000|1|20261106|`));
  assert.equal(h.timer("SM_HMDA_PRE_SUBMISSION_EDITS_0201")!.dueDate, "2027-02-01");
  let file: LarFile = uploadSubmission(h.events, built.file, { sequence_number: 1, at: "2027-01-05T15:30:00.000Z", operator: OPERATOR }).file;
  assert.equal(file.platform_sequence_number, 1); assert.throws(() => uploadSubmission(h.events, file, { sequence_number: 2, at: "2027-01-05T16:00:00.000Z", operator: OPERATOR }), /already uploaded/);
  // Jan 6: status 9 — one validity edit (county/tract mismatch on the denied record) → corrected at source, rebuilt, new sequence 2
  h.at("2027-01-06T15:00:00.000Z");
  const edits = receiveEdits(h.events, file, records, { status_code: 9, edits: [{ edit_code: "V625", edit_type: "V", affected_ulis: [denied.uli], description: "census tract not in county" }], at: "2027-01-06T15:00:00.000Z" });
  assert.deepEqual(edits.failed_ulis, [denied.uli]); assert.equal(edits.records[1]!.completeness_status, "edits_failed");
  assert.throws(() => explainEdit(edits.file, { edit_code: "V625", explanation: "1 of 2 records: tract corrected", verified_by: "agent:hmda", at: "2027-01-06T15:10:00.000Z" }), /corrected at source, never explained/);
  const corrected = correctAtSource(h.events, edits.records[1]!, { data_point: "census_tract", value: "04013111400", source: { source: "ffiec_geocoder", ref: "re-geocode 5 Cactus Ct (address correction)", version: "2026.1", derived_at: "2027-01-06T15:20:00.000Z" }, error_class: "county_tract_mismatch", discovery_route: "platform_edit", owning_process: "28.3", corrected_by: "agent:hmda", at: "2027-01-06T15:20:00.000Z" });
  assert.equal(corrected.record.completeness_status, "complete"); assert.equal(corrected.entry.discovery_route, "platform_edit"); assert.deepEqual(corrected.entry.ulis, [denied.uli]);
  records = [edits.records[0]!, corrected.record];
  const rebuilt = buildLarFile(h.events, records, { partner: PARTNER, reporting_year: 2026, built_at: "2027-01-06T16:00:00.000Z", supersedes: edits.file });
  assert.equal(rebuilt.file.kind, "resubmission"); assert.equal(rebuilt.file.supersedes_lar_file_id, file.lar_file_id); assert.notEqual(rebuilt.file.sha256, built.file.sha256);
  file = uploadSubmission(h.events, rebuilt.file, { sequence_number: 2, at: "2027-01-06T16:10:00.000Z", operator: OPERATOR }).file; assert.equal(file.platform_sequence_number, 2);
  // Jan 8: status 11 quality edit → explanation stored, then verified; status 13 macro edit → likewise; status 14 only after both
  h.at("2027-01-08T15:00:00.000Z");
  file = receiveEdits(h.events, file, records, { status_code: 11, edits: [{ edit_code: "Q614", edit_type: "Q", affected_ulis: [refi.uli], description: "income vs loan amount" }], at: "2027-01-08T15:00:00.000Z" }).file;
  assert.throws(() => verifyQualityEdits(h.events, file, { by: "agent:hmda", at: "2027-01-08T15:05:00.000Z" }), /without a stored explanation: Q614/);
  assert.throws(() => explainEdit(file, { edit_code: "Q614", explanation: "looks fine", verified_by: "agent:hmda", at: "2027-01-08T15:05:00.000Z" }), /must cite the data/);
  file = explainEdit(file, { edit_code: "Q614", explanation: "1 of 2 records has income $145,000 against a $560,000 loan; verified against decisions D-REFI-1 (DTI 38.000)", verified_by: "agent:hmda", at: "2027-01-08T15:10:00.000Z" }).file;
  assert.throws(() => verifyMacroEdits(h.events, file, { by: "agent:hmda", at: "2027-01-08T15:11:00.000Z" }), /needs status 12\/13/);
  file = verifyQualityEdits(h.events, file, { by: "agent:hmda", at: "2027-01-08T15:15:00.000Z" }).file; assert.equal(file.status_code, 12);
  file = receiveEdits(h.events, file, records, { status_code: 13, edits: [{ edit_code: "M001", edit_type: "M", affected_ulis: [], description: "share of withdrawn applications" }], at: "2027-01-08T16:00:00.000Z" }).file;
  await refused(h.run("createRecord", { op: "sign", lar_file_id: file.lar_file_id, receipt: "R-1" }), "OFFICER_SIGNS");
  assert.throws(() => signSubmission(h.events, file, { officer: OFFICER, at: "2027-01-08T16:05:00.000Z", receipt: "R-1" }), /needs status 14/);
  file = explainEdit(file, { edit_code: "M001", explanation: "0 of 2 records withdrawn (0%) against the prior-year 4%; verified against decisions", verified_by: "agent:hmda", at: "2027-01-08T16:10:00.000Z" }).file;
  const macro = verifyMacroEdits(h.events, file, { by: "agent:hmda", at: "2027-01-08T16:20:00.000Z" }); file = macro.file;
  assert.equal(file.status_code, 14); assert.equal(macro.sign_due_on, "2027-01-15"); assert.equal(officerSignDue(D("2027-01-08"), D("2027-03-01")), "2027-01-15"); assert.equal(officerSignDue(D("2027-02-26"), D("2027-03-01")), "2027-03-01", "never later than Mar 1");
  assert.equal(h.timer("SM_HMDA_PRE_SUBMISSION_EDITS_0201")!.status, "satisfied"); const sla = h.timer("SM_HMDA_OFFICER_SIGN_SLA_5BD")!; assert.equal(sla.dueDate, "2027-01-15");
  // the /sign call: the hmda agent is refused; the officer's token (Tue Jan 12, 2027) → status 15, receipt stored, records filed, the Mar 1 deadline satisfied 48 days early
  h.at("2027-01-12T17:00:00.000Z");
  assert.throws(() => signSubmission(h.events, file, { officer: HMDA_AGENT, at: "2027-01-12T17:00:00.000Z", receipt: "R-1" }), /only with the officer's token/);
  h.rt.store.put("hmda_lar_files", file.lar_file_id, file as unknown as Record<string, unknown>, OPERATOR, "2027-01-12T17:00:00.000Z");
  h.rt.store.put("hmda_coverage_tests", "COV-P-1-2026", { covered: true, decided_by_officer_id: OFFICER.id } as Record<string, unknown>, OFFICER, "2027-01-04T18:00:00.000Z");
  await refused(h.run("createRecord", { op: "sign", lar_file_id: file.lar_file_id, receipt: "R-1" }), "OFFICER_SIGNS");
  const signed = signSubmission(h.events, file, { officer: OFFICER, at: "2027-01-12T17:00:00.000Z", receipt: "HMDA-2026-P1-RECEIPT-7f3a" }); file = signed.file;
  assert.equal(file.status_code, 15); assert.equal(file.signed_by_officer_id, OFFICER.id); assert.equal(file.signed_at, "2027-01-12T17:00:00.000Z"); assert.equal(file.receipt, "HMDA-2026-P1-RECEIPT-7f3a");
  assert.deepEqual(signed.events.map((e) => e.type), ["hmda.lar.signed", "hmda.lar.accepted"]); assert.equal(signed.events[1]!.payload.status_code, 15); assert.equal(signed.events[1]!.payload.retention_class, "hmda_3y");
  assert.equal(sla.status, "satisfied"); assert.equal(annual.status, "satisfied"); assert.equal(annual.satisfiedAt, "2027-01-12T17:00:00.000Z");
  assert.ok(markFiled(records, file).every((r) => r.completeness_status === "filed" && r.lar_file_id === file.lar_file_id));
  assert.throws(() => signSubmission(h.events, file, { officer: OFFICER, at: "2027-01-13T17:00:00.000Z", receipt: "R-2" }), /already accepted/);
});

test("28.3-T10: Given a partner with 0 closed-end originations in 2024 and 900 in 2025, then `hmda_coverage_tests{2026}.covered = false`, no filing timer is armed for 2026 data, and every record is still captured and edit-checked; given 310 and 1,140, then `covered = true`.", () => {
  const h = harness(null, "2027-01-02T13:00:00.000Z");
  const formed2025 = coverageTest({ partner_id: "P-NEW", reporting_year: 2026, msa_office_on_dec31: true, closed_end_y1: 900, closed_end_y2: 0 });
  assert.equal(formed2025.covered, false); assert.equal(formed2025.quarterly_reporter, false); assert.match(formed2025.basis, /2024 = 0, 2025 = 900 \(each ≥ 25: false\)/);
  assert.throws(() => recordCoverageDecision(h.events, formed2025, HMDA_AGENT, "2027-01-04T18:00:00.000Z"), /partner officer's own act/);
  recordCoverageDecision(h.events, formed2025, OFFICER, "2027-01-04T18:00:00.000Z");
  assert.equal(h.ofType("hmda.coverage.determined")[0]!.payload.covered, false);
  assert.equal(h.timers.byCode("HMDA_1003_5_ANNUAL_0301").length, 0, "no filing timer for an uncovered partner"); assert.equal(h.timers.byCode("HMDA_1003_5_QUARTERLY_60").length, 0);
  // every record is still captured and edit-checked regardless of coverage (31.2 fair-lending data; future coverage)
  const hr = harness(REFI, "2026-11-20T09:00:00.000Z"); const rec = applyPurchase(null, refinanceThroughFunding(hr), { purchase_date: D("2026-11-19"), investor: "fnma" }, "2026-11-19T20:00:00.000Z");
  assert.equal(rec.uli, "549300SMPARTNER00155A26R00010149"); assert.deepEqual(runLocalEdits(rec), []); assert.equal(runCompletenessJob(hr.events, [rec], { as_of: D("2026-11-20") }).results[0]!.status, "complete");
  assert.equal(runLocalEdits({ ...rec, census_tract: "39049001100" })[0]!.edit_code, "V625", "tract/county consistency edit runs locally");
  // 310 (2024) and 1,140 (2025) with a Phoenix office on Dec 31, 2025 → covered for 2026 data; the officer's decision arms Mar 1, 2027; a 2028-data test for the new partner needs 2026 ≥ 25 and 2027 ≥ 25
  const covered = coverageTest({ partner_id: "P-1", reporting_year: 2026, msa_office_on_dec31: true, closed_end_y1: 1_140, closed_end_y2: 310 });
  assert.equal(covered.covered, true); assert.equal(covered.filing_deadline, "2027-03-01"); assert.match(covered.basis, /file by 2027-03-01/);
  recordCoverageDecision(h.events, covered, OFFICER, "2027-01-04T18:30:00.000Z");
  assert.equal(h.timers.byCode("HMDA_1003_5_ANNUAL_0301").length, 1); assert.equal(h.timer("HMDA_1003_5_ANNUAL_0301")!.dueDate, "2027-03-01");
  assert.equal(coverageTest({ partner_id: "P-NEW", reporting_year: 2028, msa_office_on_dec31: true, closed_end_y1: 40, closed_end_y2: 30 }).covered, true);
  assert.equal(coverageTest({ partner_id: "P-1", reporting_year: 2026, msa_office_on_dec31: false, closed_end_y1: 1_140, closed_end_y2: 310 }).covered, false, "(g)(2)(i): an MSA office on the preceding Dec 31");
  assert.equal(coverageTest({ partner_id: "P-1", reporting_year: 2026, msa_office_on_dec31: true, closed_end_y1: 1_140, closed_end_y2: 310, preceding_year_total_records: 61_000 }).quarterly_reporter, true, "§1003.5(a)(1)(ii)");
});

test("28.3-T11: Given a telephone/internet application where the applicant declines to provide demographics, then ethnicity `3`, race `6`, sex `3`, observed flags `3`, and no `visual_observation_used = true` is possible (constraint violation if attempted).", async () => {
  const declined = collectDemographics({ collection_method: "internet", declined_ethnicity: true, declined_race: true, declined_sex: true, collected_at: "2026-10-05T16:30:00.000Z" });
  const codes = demographicCodes(declined, { dob: D("1985-03-14"), application_date: D("2026-10-05") });
  assert.deepEqual(codes.ethnicity, [3]); assert.deepEqual(codes.race, [6]); assert.equal(codes.sex, 3);
  assert.deepEqual([codes.ethnicity_observed, codes.race_observed, codes.sex_observed], [3, 3, 3]); assert.equal(codes.age, 41);
  // the 0057 CHECK constraint: visual observation is possible only in person — telephone, internet and video attempts are refused before a row exists
  for (const method of ["telephone", "internet", "video"]) assert.throws(() => collectDemographics({ collection_method: method, visual_observation_used: true, collected_at: "2026-10-05T16:30:00.000Z" }), /applicant_demographics_no_observation_remote/);
  assert.throws(() => demographicCodes({ ...declined, visual_observation_used: true }, { dob: null, application_date: D("2026-10-05") }), /only for an in-person application/);
  // worked example 1: the borrower answered (ethnicity 2, race 5, sex 1; observed 2/2/2); no co-applicant → 5/8/5/9999
  const answered = demographicCodes(collectDemographics({ collection_method: "telephone", ethnicity: ["not_hispanic_or_latino"], race: ["white"], sex: "male", collected_at: "2026-10-05T16:30:00.000Z" }), { dob: D("1985-03-14"), application_date: D("2026-10-05") });
  assert.deepEqual([answered.ethnicity, answered.race, answered.sex, answered.ethnicity_observed, answered.race_observed, answered.sex_observed], [[2], [5], 1, 2, 2, 2]);
  const none = noCoApplicant(); assert.deepEqual([none.ethnicity, none.race, none.sex, none.age], [[5], [8], 5, 9999]);
  assert.deepEqual(demographicCodes(collectDemographics({ collection_method: "internet", ethnicity: ["hispanic_or_latino", "mexican"], race: ["asian", "asian_indian", "white"], sex: "female", collected_at: "2026-10-19T16:30:00.000Z" }), { dob: D("1993-05-02"), application_date: D("2026-10-19") }).race, [2, 21, 5], "disaggregated codes never collapsed");
  // through the bus: the guardrail refuses inference and remote observation before anything runs
  const h = harness(REFI, "2026-10-05T17:00:00.000Z");
  createHmdaRecord(h.events, REFI_INPUT); h.rt.store.put("hmda_records", REFI, createHmdaRecord(new MemoryEventStore(), REFI_INPUT).record as unknown as Record<string, unknown>, HMDA_AGENT, "2026-10-05T17:00:00.000Z");
  await refused(h.run("createRecord", { op: "demographics", borrower_id: "B1", collection_method: "internet", visual_observation_used: true, collected_at: "2026-10-05T16:30:00.000Z" }), "NEVER_INFER_DEMOGRAPHICS");
  await refused(h.run("createRecord", { op: "demographics", borrower_id: "B1", collection_method: "internet", inferred_from: "surname", collected_at: "2026-10-05T16:30:00.000Z" }), "NEVER_INFER_DEMOGRAPHICS");
  const out = await h.run("createRecord", { op: "demographics", borrower_id: "B1", collection_method: "internet", declined_ethnicity: true, declined_race: true, declined_sex: true, collected_at: "2026-10-05T16:30:00.000Z" });
  assert.deepEqual([out.ethnicity, out.race, out.sex, out.observed], [[3], [6], 3, [3, 3, 3]]); assert.equal(out.access_logged, true);
});

test("28.3-T12: Given a discount-point amount of $0 on the final CD, then the LAR field is blank (not `0`, not `NA`); given Total Loan Costs of $1,245.00, then `1245.00`; given origination charges $0, then `0`.", () => {
  assert.equal(larMoneyField("discount_points", 0n, 1), ""); assert.equal(larMoneyField("discount_points", null, 1), ""); assert.equal(larMoneyField("lender_credits", 0n, 1), "");
  assert.equal(larMoneyField("total_loan_costs", 124_500n, 1), "1245.00"); assert.equal(larMoneyField("origination_charges", 0n, 1), "0");
  assert.equal(larMoneyField("discount_points", 280_000n, 1), "2800.00"); assert.equal(larMoneyField("lender_credits", 150_050n, 1), "1500.50");
  assert.equal(larMoneyField("total_points_and_fees", 500_000n, 1), "NA", "TRID loans report the §1026.38 figures, not points and fees");
  for (const action of [2, 3, 4, 5]) assert.equal(larMoneyField("total_loan_costs", 124_500n, action), "NA");
  assert.throws(() => larMoneyField("total_loan_costs", null, 1), /required for an originated loan/);
  assert.equal(larDollars(-12_345n), "-123.45");
  // the final CD applied to the record: $0 points and $0 credits are stored blank (null), never 0
  const h = harness(REFI, "2026-11-02T20:00:00.000Z");
  const rec = applyClosingDisclosure(null, createHmdaRecord(h.events, REFI_INPUT).record, { total_loan_costs_cents: 124_500n, origination_charges_cents: 0n, discount_points_cents: 0n, lender_credits_cents: 0n, interest_rate: "6.125", loan_term_months: 360, intro_rate_period_months: null, apr: "6.159", cd_version: 1, dti: "38.000", cltv: "70.000", property_value_cents: 80_000_000n, hoepa_status: 2 }, "2026-11-02T20:00:00.000Z");
  assert.equal(rec.discount_points_cents, null); assert.equal(rec.lender_credits_cents, null); assert.equal(rec.origination_charges_cents, 0n); assert.equal(rec.total_loan_costs_cents, 124_500n);
  const row = larRow({ ...rec, action_taken: 1, action_taken_date: D("2026-11-06") }).split("|");
  assert.deepEqual(row.slice(72, 78), ["1245.00", "NA", "0", "", "", "6.125"]); assert.equal(row.length, 110);
});

test("28.3-T13: Given the FFIEC disclosure-statement notice is received Wed Jun 16, 2027, then the (b)(2) written notice is available at the home office and MSA branches by Mon Jun 21, 2027 (3 business days) with `available_until = 2032-06-21`.", () => {
  // The spec's hand count (Mon Jun 21) ignored the Juneteenth observance on Fri Jun 18, 2027: Thu 17, Mon 21, Tue 22 → the engine's calendar-correct due date is Tue Jun 22, 2027 (the notice is still made available Mon Jun 21, so available_until = 2032-06-21 as the spec states).
  assert.equal(disclosureNoticeDue(D("2027-06-16")), "2027-06-22");
  assert.equal(disclosureNoticeDue(D("2027-06-09")), "2027-06-14", "a week without a holiday: Wed + 3 creditor business days = Mon");
  const h = harness(null, "2027-06-16T15:00:00.000Z");
  const received = receiveFfiecDisclosureNotice(h.events, { partner_id: "P-1", year: 2026, received_on: D("2027-06-16"), at: "2027-06-16T15:00:00.000Z" });
  assert.equal(received.due_on, "2027-06-22");
  const t = h.timer("HMDA_1003_5B_DISCLOSURE_NOTICE_3BD")!; assert.equal(t.anchorDate, "2027-06-16"); assert.equal(t.dueDate, "2027-06-22");
  const locations = ["Home office — 100 Partner Plaza, Phoenix, AZ 85004 (Phoenix-Mesa-Chandler MSA)", "Branch — 200 High Street, Columbus, OH 43215 (Columbus MSA)"];
  assert.throws(() => makePublicNoticeAvailable(h.events, { partner_id: "P-1", kind: "disclosure_statement_notice_b2", year: 2026, made_available_on: D("2027-06-23"), locations, ffiec_notice_received_on: D("2027-06-16") }), /was due 2027-06-22/);
  assert.throws(() => makePublicNoticeAvailable(h.events, { partner_id: "P-1", kind: "disclosure_statement_notice_b2", year: 2026, made_available_on: D("2027-06-21"), locations: ["Branch — Columbus"], ffiec_notice_received_on: D("2027-06-16") }), /home office/);
  h.at("2027-06-21T17:00:00.000Z");
  const made = makePublicNoticeAvailable(h.events, { partner_id: "P-1", kind: "disclosure_statement_notice_b2", year: 2026, made_available_on: D("2027-06-21"), locations, ffiec_notice_received_on: D("2027-06-16"), evidence_document_id: "doc-attest-2027-06-21" });
  assert.equal(made.notice.available_until, "2032-06-21"); assert.equal(made.notice.due_on, "2027-06-22"); assert.equal(made.notice.made_available_at, "2027-06-21", "available by Mon Jun 21 as the spec requires"); assert.equal(made.notice.template_code, NOTICE_CODES_28_3.b2); assert.deepEqual(made.notice.locations, locations);
  assert.equal(made.event.payload.kind, "b2"); assert.equal(t.status, "satisfied");
  // the availability window (5 years) is a condition attested annually; the c1 notice runs 3 years; the lobby notice is permanent
  const win = h.timer("HMDA_1003_5D_NOTICE_AVAILABILITY")!; assert.equal(win.status, "armed"); assert.equal(win.anchorDate, "2027-06-21");
  const gate = EVALUATORS_28_3["28.3.noticeAvailabilityWindow"]!;
  assert.equal(gate({ made_available_on: "2027-06-21", available_until: "2032-06-21", last_attested_on: "2027-06-21", as_of: "2028-03-01" }).open, true);
  assert.equal(gate({ made_available_on: "2027-06-21", available_until: "2032-06-21", last_attested_on: "2027-06-21", as_of: "2028-09-01" }).open, false, "attestation older than 12 months");
  const attested = attestNoticeAvailability(h.events, made.notice, { attested_on: D("2028-06-15"), attested_by: "office-manager-phx", evidence_document_id: "doc-attest-2028" });
  assert.equal(gate({ made_available_on: "2027-06-21", available_until: "2032-06-21", last_attested_on: attested.notice.last_attested_at, as_of: "2028-09-01" }).open, true);
  assert.equal(gate({ made_available_on: "2027-06-21", available_until: "2032-06-21", last_attested_on: "2027-06-21", as_of: "2032-07-01" }).open, true, "window closed: no duty remains");
  assert.equal(makePublicNoticeAvailable(h.events, { partner_id: "P-1", kind: "modified_lar_notice_c1", year: 2026, made_available_on: D("2027-03-01"), locations }).notice.available_until, "2030-03-01");
  assert.equal(makePublicNoticeAvailable(h.events, { partner_id: "P-1", kind: "lobby_notice_e", year: 2026, made_available_on: D("2027-03-01"), locations }).notice.available_until, null);
  // the written notice itself (Notice Registry template): the regulation's words, the five-year period, the offices; no borrower data
  const version = noticeReg.activeVersion(NOTICE_CODES_28_3.b2, D("2027-06-21"))!;
  const payload = { ...DISCLOSURE_STMT_NOTICE_SAMPLE, made_available_on: made.notice.made_available_at, available_until: made.notice.available_until, due_on: made.notice.due_on, made_available_within_3bd: String(made.notice.made_available_at) <= String(made.notice.due_on), locations };
  const rendered = render(version.source, payload);
  assert.match(rendered.text, /may be obtained on the Bureau's Web site at www\.consumerfinance\.gov\/hmda/); assert.match(rendered.text, /for a period of five years/); assert.match(rendered.text, /Home office — 100 Partner Plaza/);
  const check = evaluateChecklist(version, payload, rendered);
  assert.equal(check.passed, true, JSON.stringify(check.blocking));
});

test("28.3-T14: Given any `hmda` agent run, then the access log shows reads of `applicant_demographics` only by the `hmda` agent identity and 31.2, and no production agent.", () => {
  const events = new MemoryEventStore(new FixedClock("2026-10-05T17:00:00.000Z"), { applicationId: REFI });
  const rows = { B1: collectDemographics({ collection_method: "telephone", ethnicity: ["not_hispanic_or_latino"], race: ["white"], sex: "male", collected_at: "2026-10-05T16:30:00.000Z" }) };
  const hmda = readApplicantDemographics(events, { actor: HMDA_AGENT, process: "28.3", application_id: REFI, borrower_id: "B1", purpose: "hmda_derivation", at: "2026-10-05T17:00:00.000Z" }, rows);
  assert.equal(hmda.event.type, "applicant_demographics.access_logged"); assert.equal(hmda.row.sex, "male");
  const monitoring = readApplicantDemographics(events, { actor: { kind: "agent", id: "qc-audit" }, process: "31.2", application_id: REFI, borrower_id: "B1", purpose: "fair_lending_monitoring", at: "2026-12-01T17:00:00.000Z" }, rows);
  assert.equal(monitoring.event.payload.process, "31.2");
  // production agents (underwriter, pricing, intake, disclosure) are refused and the refusal is logged; qc-audit outside 31.2 too; a human officer is not an agent read path
  for (const [id, process] of [["underwriter", "21.6"], ["pricing", "20.4"], ["intake", "21.1"], ["disclosure", "25.2"], ["qc-audit", "28.1"]] as const)
    assert.throws(() => readApplicantDemographics(events, { actor: { kind: "agent", id }, process, application_id: REFI, borrower_id: "B1", purpose: "decision", at: "2026-10-06T17:00:00.000Z" }, rows), /refused — only the hmda agent \(28\.3\) and 31\.2 monitoring/);
  assert.throws(() => readApplicantDemographics(events, { actor: OFFICER, process: "28.3", application_id: REFI, borrower_id: "B1", purpose: "console", at: "2026-10-06T17:00:00.000Z" }, rows), /refused/);
  const log = demographicsAccessLog(events);
  assert.deepEqual(log.filter((l) => l.allowed).map((l) => [l.actor_id, l.process]), [["hmda", "28.3"], ["qc-audit", "31.2"]]);
  assert.deepEqual(log.filter((l) => !l.allowed).map((l) => l.actor_id), ["underwriter", "pricing", "intake", "disclosure", "qc-audit", "u-officer-1"]);
  assert.ok(log.filter((l) => l.allowed).every((l) => (l.actor_id === "hmda" && l.process === "28.3") || l.process === "31.2"), "no production agent reads");
  // the derived record exposes FIG codes only — never the answers themselves
  const codes = demographicCodes(rows.B1, { dob: D("1985-03-14"), application_date: D("2026-10-05") });
  assert.ok(!JSON.stringify(codes).includes("male") && !JSON.stringify(codes).includes("white"));
});

test("28.3 worked figures: the refinance fixture's LAR row reproduces Total Loan Costs $1,245.00 → 1245.00, origination charges 0, blank points/credits, rate 6.125, spread 0.139, DTI 38.000, CLTV 70.000, value 800000, amount 560000, purchaser 1, action 1 on 20261106", () => {
  const h = harness(REFI, "2026-11-20T09:00:00.000Z");
  const rec = runCompletenessJob(h.events, [applyPurchase(null, refinanceThroughFunding(h), { purchase_date: D("2026-11-19"), investor: "fnma" }, "2026-11-19T20:00:00.000Z")], { as_of: D("2026-11-20") }).records[0]!;
  assert.equal(rec.total_loan_costs_cents, 124_500n); assert.equal(larMoneyField("total_loan_costs", rec.total_loan_costs_cents, rec.action_taken), "1245.00");
  assert.equal(larDollars(124_500n), "1245.00"); assert.equal(rec.income_thousands, 145);
  const f = larRow(rec).split("|");
  assert.equal(f.length, 110);
  assert.deepEqual(f.slice(0, 12), ["2", FIXTURE_LEI, "549300SMPARTNER00155A26R00010149", "20261005", "1", "31", "2", "1", "1", "560000", "1", "20261106"]);
  assert.deepEqual(f.slice(12, 18), ["1 Palm Ln", "Phoenix", "AZ", "85001", "04013", "04013111200"]);
  assert.deepEqual([f[18], f[24], f[30], f[32], f[40], f[48], f[50], f[52], f[54]], ["2", "5", "2", "5", "8", "2", "1", "2", "41"], "applicant 2/5/1 observed 2; no co-applicant 5/8/5/9999");
  assert.deepEqual([f[55], f[56], f[57], f[58], f[59], f[60]], ["9999", "145", "1", "0.139", "2", "1"], "co-applicant age 9999; income 145; purchaser 1; spread 0.139; HOEPA 2; lien 1");
  assert.deepEqual([f[61], f[63]], ["748", "2"], "credit score 748, model 2 (Experian middle, Classic FICO)");
  assert.deepEqual(f.slice(67, 71), ["10", "", "", ""], "denial reasons 10 = not applicable");
  assert.deepEqual(f.slice(72, 78), ["1245.00", "NA", "0", "", "", "6.125"]);
  assert.deepEqual(f.slice(78, 88), ["NA", "38.000", "70.000", "360", "NA", "2", "2", "2", "2", "800000"]);
  assert.deepEqual(f.slice(88, 95), ["3", "5", "1", "NA", "1", "1", "123456"]);
  assert.deepEqual([f[95], f[101], f[107], f[108], f[109]], ["1", "1", "2", "2", "2"], "AUS 1 result 1; reverse 2; open-end 2; business purpose 2");
  // worked example 2: HomeReady income $98,400 → 98 (thousands); $1,528.30 loan costs would render 1528.30
  assert.equal(incomeThousands(9_840_000n), 98); assert.equal(incomeThousands(14_550_000n), 146, "round half up"); assert.equal(larDollars(152_830n), "1528.30");
});
