// 22.3 Income and employment verification (documentation standards, DU validation service, Income Calculator, IRS transcripts, self-employment, rental/other income, VVOE timing)
// spec/sections/22-documents-credit-income-assets-liabilities-identity-and-frau/22-3-income-and-employment-verification-documentation-standards-d.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { creditor } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_22_3 } from "../../app/tools/section22-3.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import {
  FORMULAS, RegBViolation, IncomeRuleRefused, aduCap, assertUnderCalculatorCeiling, assessTrend, baseMonthly, baseSalary, bonusMonthly, businessVerificationWindow, calculateIncome, closeByGate, continuance3y, continuanceEndFromChildAge, evaluateContinuance, form4506cGate, form4506cValidUntil, grossUp, hourlyBase, hourlyClassification,
  incomeCalculatorCeiling, offerOption2, offerStartWindow, orderTranscript, reassessCloseBy, recordCalculatorFindings, recordDuValidation, recordVvoe, regbCheck, selectOfferOption, signAuthorization, socialSecurity, subjectRental, supportIncome, totalQualifying, variableIncome, verifyBusinessExistence, vvoeAlternativeWindow, vvoeWindow, withinWindow,
} from "./ops-22-3.ts";

const AGENT: Actor = { kind: "agent", id: "verification" };
const APP = "app-refi-1", LOAN = "L-REFI-1", B1 = "borrower-1", B2 = "borrower-2";
/** Refinance fixture: application Mon Oct 5, 2026; note date Fri Nov 6, 2026. Purchase fixture: closing Wed Nov 18, 2026. */
const NOTE_DATE = D("2026-11-06"), PURCHASE_NOTE_DATE = D("2026-11-18");

/** The 22.3 tools on the bus over the overridden registry (22.3 rows only); the harness appends the upstream events (26.x closing, 23.2 DU) with origination context. */
function harness(nowIso = "2026-10-07T16:00:00.000Z") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId: APP });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["22.3"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId: LOAN, applicationId: APP, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_22_3); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("22.3", name))!, actor, { application_id: APP, ...input }, uow)).output as Record<string, unknown>;
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === APP);
  const upstream = (type: string, payload: Record<string, unknown>, actor: Actor = { kind: "agent", id: "closing" }) => events.append({ type, applicationId: APP, aggregate: { kind: "application", id: APP }, actor, payload: { application_id: APP, ...payload } });
  const schedule = (noteDate: string, type: "closing.scheduled" | "closing.rescheduled" = "closing.scheduled") => upstream(type, { closing_id: "c-1", scheduled_note_date: noteDate, scheduled_at: `${noteDate}T17:00:00.000Z` });
  return { clock, events, timers, uow, rt, run, timer, ofType, upstream, schedule, decisions };
}
const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } throw new Error(`expected refusal ${code}`); };

test("22.3-T1: (VVOE window, refinance) Given note date Fri Nov 6, 2026, when the window is computed on calendar `creditor`, then `window_start = Fri Oct 23, 2026`; a VVOE contacted Thu Oct 22 is `within_window = false` and Fri Oct 23 is `true`.", () => {
  const w = vvoeWindow(NOTE_DATE, creditor);
  assert.equal(w.window_start, "2026-10-23");
  assert.equal(withinWindow(w, D("2026-10-22")), false);
  assert.equal(withinWindow(w, D("2026-10-23")), true);
  assert.equal(withinWindow(w, D("2026-11-06")), true);
  // the engine arms FNMA_B3_3_1_04_VVOE_10BD from the closing event as a window opening Oct 23 and due on the note date; the recorded VVOEs carry within_window
  const h = harness(); h.schedule("2026-11-06");
  const t = h.timer("FNMA_B3_3_1_04_VVOE_10BD")!;
  assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2026-11-06"); assert.equal(t.anchorDate, "2026-11-06"); assert.match(t.note ?? "", /window opens 2026-10-23/);
  const early = recordVvoe(h.events, { application_id: APP, borrower_id: B1, method: "verbal_ai_voice", employer_name: "Acme Manufacturing", employer_phone: "602-555-0100", phone_source: "internet_listing", phone_source_evidence_document_id: "doc-listing-1", contact_name: "Pat HR", contact_title: "HR Manager", verifier_identity: "run-1", contacted_at: "2026-10-22T17:00:00.000Z", note_date: NOTE_DATE });
  assert.equal(early.record.within_window, false); assert.equal(early.record.window_start, "2026-10-23"); assert.equal(early.missed?.type, "vvoe.window.missed");
  assert.equal(h.timer("FNMA_B3_3_1_04_VVOE_10BD")!.status, "armed", "an early VVOE does not satisfy the gate");
  const timely = recordVvoe(h.events, { application_id: APP, borrower_id: B1, method: "verbal_ai_voice", employer_name: "Acme Manufacturing", employer_phone: "602-555-0100", phone_source: "internet_listing", phone_source_evidence_document_id: "doc-listing-1", contact_name: "Pat HR", contact_title: "HR Manager", verifier_identity: "run-1", contacted_at: "2026-10-23T17:00:00.000Z", note_date: NOTE_DATE });
  assert.equal(timely.record.within_window, true); assert.equal(timely.missed, null);
  assert.equal(h.timer("FNMA_B3_3_1_04_VVOE_10BD")!.status, "satisfied");
  // R1: a reschedule recomputes the window — a VVOE done Oct 26 is valid for a Nov 9 closing (Oct 26–Nov 9) but not for Nov 10 (Oct 27–Nov 10)
  assert.equal(withinWindow(vvoeWindow(D("2026-11-09")), D("2026-10-26")), true);
  assert.equal(withinWindow(vvoeWindow(D("2026-11-10")), D("2026-10-26")), false);
  // the employer's number never comes from a borrower-supplied document
  assert.throws(() => recordVvoe(h.events, { application_id: APP, borrower_id: B1, method: "verbal_human", employer_name: "Acme", phone_source: "borrower_paystub", contact_name: "Pat", contact_title: "HR", verifier_identity: "u-1", contacted_at: "2026-10-26", note_date: NOTE_DATE }), (e: unknown) => e instanceof IncomeRuleRefused && e.code === "VVOE_PHONE_SOURCE");
});

test("22.3-T2: (VVOE window across Veterans Day, purchase) Given closing Wed Nov 18, 2026, when computed, then `window_start = Tue Nov 3, 2026` (Nov 11 excluded) and the 15-business-day paystub alternative floor is Tue Oct 27, 2026.", () => {
  assert.equal(vvoeWindow(PURCHASE_NOTE_DATE, creditor).window_start, "2026-11-03");
  assert.equal(vvoeAlternativeWindow(PURCHASE_NOTE_DATE, creditor).window_start, "2026-10-27");
  // refinance alternative floor (spec R1): Fri Oct 16, 2026
  assert.equal(vvoeAlternativeWindow(NOTE_DATE, creditor).window_start, "2026-10-16");
  const h = harness(); h.schedule("2026-11-18");
  const alt = h.timer("FNMA_B3_3_1_04_VVOE_ALT_15BD")!; assert.match(alt.note ?? "", /window opens 2026-10-27/); assert.equal(alt.dueDate, "2026-11-18");
  assert.match(h.timer("FNMA_B3_3_1_04_VVOE_10BD")!.note ?? "", /window opens 2026-11-03/);
  // a paystub dated Mon Oct 26 misses the alternative floor; one dated Tue Oct 27 satisfies FNMA_B3_3_1_04_VVOE_ALT_15BD
  const late = recordVvoe(h.events, { application_id: APP, borrower_id: B1, method: "paystub_15bd", employer_name: "Acme", verifier_identity: "run-2", contacted_at: "2026-10-26", note_date: PURCHASE_NOTE_DATE });
  assert.equal(late.record.within_window, false); assert.equal(h.timer("FNMA_B3_3_1_04_VVOE_ALT_15BD")!.status, "armed");
  const ok = recordVvoe(h.events, { application_id: APP, borrower_id: B1, method: "paystub_15bd", employer_name: "Acme", verifier_identity: "run-2", contacted_at: "2026-10-27", note_date: PURCHASE_NOTE_DATE });
  assert.equal(ok.record.within_window, true); assert.equal(ok.record.window_start, "2026-10-27");
  assert.equal(h.timer("FNMA_B3_3_1_04_VVOE_ALT_15BD")!.status, "satisfied");
});

test("22.3-T3: (self-employment verification window) Given note date Nov 6, 2026, when `FNMA_B3_3_1_04_SE_VERIFY_120` is evaluated, then a Secretary-of-State/licensing verification dated Thu Jul 9, 2026 passes and Wed Jul 8, 2026 fails; for closing Nov 18 the floor is Tue Jul 21, 2026.", () => {
  assert.equal(businessVerificationWindow(NOTE_DATE).window_start, "2026-07-09");
  assert.equal(businessVerificationWindow(PURCHASE_NOTE_DATE).window_start, "2026-07-21");
  const h = harness(); h.schedule("2026-11-06");
  const t = h.timer("FNMA_B3_3_1_04_SE_VERIFY_120")!; assert.equal(t.status, "armed"); assert.match(t.note ?? "", /window opens 2026-07-09/); assert.equal(t.dueDate, "2026-11-06");
  const fail = verifyBusinessExistence(h.events, { application_id: APP, borrower_id: B1, business_name: "Fixture Consulting LLC", source: "secretary_of_state", source_reference: "AZ-CC L23456789", verified_at: D("2026-07-08"), note_date_used: NOTE_DATE, evidence_document_id: "doc-sos-1" });
  assert.equal(fail.record.within_window, false); assert.equal(fail.record.window_start, "2026-07-09");
  assert.equal(h.timer("FNMA_B3_3_1_04_SE_VERIFY_120")!.status, "armed");
  const pass = verifyBusinessExistence(h.events, { application_id: APP, borrower_id: B1, business_name: "Fixture Consulting LLC", source: "licensing_bureau", source_reference: "AZ ROC 345678", verified_at: D("2026-07-09"), note_date_used: NOTE_DATE, evidence_document_id: "doc-roc-1" });
  assert.equal(pass.record.within_window, true); assert.equal(pass.event.payload.within_window, true);
  assert.equal(h.timer("FNMA_B3_3_1_04_SE_VERIFY_120")!.status, "satisfied");
});

test("22.3-T4: (trending, increasing) Given overtime prior year 1,080,000 cents and YTD 855,000 cents over 9 months, when calculated, then `trend = increasing` and `monthly_qualifying_cents = 92,143`.", () => {
  const t = assessTrend({ ytd_cents: 855000n, ytd_months: 9, prior_year_cents: 1080000n });
  assert.equal(t.ytd_monthly_cents, 95000n); assert.equal(t.prior_monthly_cents, 90000n); assert.equal(t.trend, "increasing");
  const v = variableIncome({ income_type: "overtime", ytd_cents: 855000n, ytd_months: 9, prior_year_cents: 1080000n, history_months: 24 });
  assert.equal(v.trend, "increasing"); assert.equal(v.monthly_qualifying_cents, 92143n);       // (855,000 + 1,080,000) / 21 = 92,142.857… → 92,143
  assert.equal(v.formula_version, FORMULAS.variable_trending);
  assert.deepEqual(v.steps.at(-2), { label: "ytd + prior_year", cents: "1935000" });
  // the calculation event carries the trend and arms the continuance gate; the trend event carries the compared monthly figures
  const h = harness(); h.schedule("2026-11-06");
  const r = calculateIncome(h.events, { application_id: APP, borrower_id: B1, income_id: "inc-ot", income_type: "overtime", scheduled_note_date: NOTE_DATE, evidence_document_ids: ["doc-w2-2025", "doc-paystub-sep"], inputs: { ytd_cents: 855000n, ytd_months: 9, prior_year_cents: 1080000n, history_months: 24 } });
  assert.equal(r.event.payload.trend, "increasing"); assert.equal(r.event.payload.monthly_qualifying_cents, "92143");
  assert.equal(r.trend_event?.payload.ytd_monthly_cents, "95000"); assert.equal(r.trend_event?.payload.prior_monthly_cents, "90000");
});

test("22.3-T5: (trending, decreasing with stabilization) Given prior year 1,440,000 cents and YTD 855,000 over 9 months with a documented flat run since Apr 1, 2026 totaling 570,000 over 6 months, when calculated, then `trend = decreasing`, `stabilized_since = 2026-04-01`, and `monthly_qualifying_cents = 95,000`; with no stabilization evidence the result is 0 with reason `not_stabilized`.", () => {
  const t = assessTrend({ ytd_cents: 855000n, ytd_months: 9, prior_year_cents: 1440000n });
  assert.equal(t.prior_monthly_cents, 120000n); assert.equal(t.trend, "decreasing"); assert.equal(t.change_pct, "-2083");   // −20.83%
  const v = variableIncome({ income_type: "overtime", ytd_cents: 855000n, ytd_months: 9, prior_year_cents: 1440000n, stabilization: { since: D("2026-04-01"), cents_since: 570000n, months_since: 6, evidence_document_ids: ["doc-paystubs-apr-sep"] } });
  assert.equal(v.trend, "decreasing"); assert.equal(v.stabilized_since, "2026-04-01"); assert.equal(v.monthly_qualifying_cents, 95000n); assert.equal(v.reason, null);
  const none = variableIncome({ income_type: "overtime", ytd_cents: 855000n, ytd_months: 9, prior_year_cents: 1440000n, stabilization: null });
  assert.equal(none.trend, "decreasing"); assert.equal(none.monthly_qualifying_cents, 0n); assert.equal(none.reason, "not_stabilized"); assert.equal(none.stabilized_since, null);
});

test("22.3-T6: (hourly base) Given $32.50/hour and 40 guaranteed hours, when calculated, then `monthly_qualifying_cents = 563,333`; given hours of 28–44 with no guaranteed minimum, then the source is reclassified `base_hourly_variable` and R3 applies.", () => {
  const fixed = hourlyBase({ rate_cents: 3250n, guaranteed_hours_per_week: 40 });
  assert.equal(fixed.monthly_qualifying_cents, 563333n);                                                        // 3,250 × 40 × 52 / 12 = 563,333.33…
  assert.equal(fixed.income_type, "base_hourly_fixed"); assert.equal(fixed.formula_version, FORMULAS.base_hourly_fixed); assert.equal(fixed.reclassified_to, null);
  assert.equal(hourlyClassification({ rate_cents: 3250n, hours_min: 28, hours_max: 44, guaranteed_hours_per_week: null }), "base_hourly_variable");
  const variable = hourlyBase({ rate_cents: 3250n, hours_min: 28, hours_max: 44, guaranteed_hours_per_week: null });
  assert.equal(variable.reclassified_to, "base_hourly_variable"); assert.equal(variable.income_type, "base_hourly_variable"); assert.equal(variable.formula_version, FORMULAS.variable_trending); assert.equal(variable.reason, "reclassified_variable_hours");
  // R3 applies to the reclassified source: trended on YTD vs prior-year earnings
  const h = harness();
  const r = calculateIncome(h.events, { application_id: APP, borrower_id: B1, income_id: "inc-hourly", income_type: "base_hourly_variable", inputs: { ytd_cents: 855000n, ytd_months: 9, prior_year_cents: 1080000n, history_months: 24 } });
  assert.equal(r.calculation.formula_version, FORMULAS.variable_trending); assert.equal(r.calculation.trend, "increasing"); assert.equal(r.calculation.monthly_qualifying_cents, 92143n);
});

test("22.3-T7: (Social Security gross-up) Given $2,000.00 SS retirement on the borrower's own record with no tax return, when calculated, then `nontaxable_cents = 30,000`, `gross_up_cents = 7,500`, qualifying 207,500 cents, `continuance_basis = retirement_own_record`.", () => {
  const ss = socialSecurity({ amount_cents: 200000n, record: "own", benefit: "retirement", documented_nontaxable_pct: null });
  assert.equal(ss.nontaxable_cents, 30000n); assert.equal(ss.gross_up_cents, 7500n); assert.equal(ss.qualifying_cents, 207500n); assert.equal(ss.monthly_qualifying_cents, 200000n);
  assert.equal(ss.continuance_basis, "retirement_own_record"); assert.equal(ss.continuance_end_date, null); assert.equal(ss.income_type, "social_security_retirement");
  assert.equal(grossUp(30000n), 7500n);
  // a tax return showing a larger nontaxable share is used instead; benefits on another's record need three-year continuance
  assert.equal(socialSecurity({ amount_cents: 200000n, record: "own", benefit: "retirement", documented_nontaxable_pct: 40 }).nontaxable_cents, 80000n);
  assert.equal(socialSecurity({ amount_cents: 200000n, record: "dependent", benefit: "survivor", continuance_end_date: D("2028-05-01") }).continuance_basis, "documented_3y");
  // the calculated event and the continuance gate: own-record retirement passes without a continuance end date
  const h = harness(); h.schedule("2026-11-06");
  const r = calculateIncome(h.events, { application_id: APP, borrower_id: B1, income_id: "inc-ss", income_type: "social_security_retirement", regb_flags: ["retirement"], scheduled_note_date: NOTE_DATE, inputs: { amount_cents: 200000n, record: "own", benefit: "retirement" } });
  assert.equal(r.event.payload.qualifying_cents, "207500"); assert.equal(r.event.payload.continuance_basis, "retirement_own_record"); assert.equal(r.regb.regb_check, "pass");
  assert.equal(evaluateGate("22.3.continuance3y", { scheduled_note_date: "2026-11-06", continuance_end_date: null, continuance_basis: "retirement_own_record" }).open, true);
});

test("22.3-T8: (child support continuance) Given $800.00 child support with the child turning 18 on Mar 3, 2029 and note date Nov 6, 2026, when evaluated, then `FNMA_B3_3_1_01_CONTINUANCE_3Y` fails (end Mar 3, 2029 < Nov 6, 2029) and the income is excluded with a written reason; with a child born after Nov 6, 2011 it passes and qualifying = 100,000 cents.", () => {
  const h = harness(); h.schedule("2026-11-06");
  const cs = supportIncome({ amount_cents: 80000n, kind: "child_support", receipts_months: 6, receipts_full_regular_timely: true, agreement_document_id: "doc-decree-1", child_date_of_birth: D("2011-03-03") });
  assert.equal(cs.nontaxable_cents, 80000n); assert.equal(cs.gross_up_cents, 20000n); assert.equal(cs.qualifying_cents, 100000n); assert.equal(cs.continuance_end_date, "2029-03-03");
  assert.equal(continuanceEndFromChildAge(D("2011-03-03")), "2029-03-03");
  const r = calculateIncome(h.events, { application_id: APP, borrower_id: B1, income_id: "inc-cs", income_type: "child_support", regb_flags: ["alimony_child_support"], scheduled_note_date: NOTE_DATE, inputs: { amount_cents: 80000n, receipts_months: 6, receipts_full_regular_timely: true, agreement_document_id: "doc-decree-1", child_date_of_birth: "2011-03-03" } });
  assert.equal(r.event.payload.continuance_end_date, "2029-03-03");
  const gate = h.timer("FNMA_B3_3_1_01_CONTINUANCE_3Y")!; assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2026-11-06"); assert.match(gate.note ?? "", /evaluator:22.3.continuance3y/);
  const fail = evaluateGate("22.3.continuance3y", { scheduled_note_date: "2026-11-06", continuance_end_date: "2029-03-03", continuance_basis: "documented_3y" });
  assert.equal(fail.open, false); assert.match(fail.reason ?? "", /2029-03-03.*2029-11-06/);
  assert.equal(continuance3y(D("2029-03-03"), NOTE_DATE).required_through, "2029-11-06");
  const ev = evaluateContinuance(h.events, { application_id: APP, income_id: "inc-cs", income_type: "child_support", note_date: NOTE_DATE, continuance_end_date: D("2029-03-03"), qualifying_cents: 100000n });
  assert.equal(ev.pass, false); assert.equal(ev.qualifying_cents, 0n); assert.equal(ev.excluded?.type, "income.excluded");
  assert.match(String(ev.excluded?.payload.written_reason), /2029-03-03/); assert.match(String(ev.excluded?.payload.written_reason), /not on the nature of the income/);
  assert.equal(h.timer("FNMA_B3_3_1_01_CONTINUANCE_3Y")!.status, "armed", "a failed evaluation does not close the gate");
  // a child born after Nov 6, 2011 turns 18 on/after Nov 6, 2029 → passes; qualifying 100,000 cents; the gate is satisfied by the evaluation
  const later = supportIncome({ amount_cents: 80000n, kind: "child_support", receipts_months: 6, receipts_full_regular_timely: true, agreement_document_id: "doc-decree-1", child_date_of_birth: D("2011-11-07") });
  assert.equal(later.continuance_end_date, "2029-11-07");
  assert.equal(evaluateGate("22.3.continuance3y", { scheduled_note_date: "2026-11-06", continuance_end_date: "2029-11-07", continuance_basis: "documented_3y" }).open, true);
  const pass = evaluateContinuance(h.events, { application_id: APP, income_id: "inc-cs", income_type: "child_support", note_date: NOTE_DATE, continuance_end_date: D("2029-11-07"), qualifying_cents: later.qualifying_cents });
  assert.equal(pass.pass, true); assert.equal(pass.qualifying_cents, 100000n); assert.equal(pass.excluded, null);
  assert.equal(h.timer("FNMA_B3_3_1_01_CONTINUANCE_3Y")!.status, "satisfied");
});

test("22.3-T9: (rental 75% and experience) Given Form 1007 gross rent $2,400.00 and PITIA $1,650.00 on a purchase, when the borrower has 365 Fair Rental Days on the 2025 Schedule E, then +15,000 cents is added to income; with no management history, `offset_only = true` and 0 is added; with PITIA $2,150.00, 35,000 cents is added to liabilities in both cases.", () => {
  const experienced = subjectRental({ gross_rent_cents: 240000n, pitia_cents: 165000n, transaction: "purchase", fair_rental_days: 365 });
  assert.equal(experienced.net_cents, 180000n); assert.equal(experienced.anri_cents, 15000n); assert.equal(experienced.income_added_cents, 15000n); assert.equal(experienced.liability_added_cents, 0n); assert.equal(experienced.offset_only, false);
  const novice = subjectRental({ gross_rent_cents: 240000n, pitia_cents: 165000n, transaction: "purchase", fair_rental_days: 0, management_experience_months: 0 });
  assert.equal(novice.offset_only, true); assert.equal(novice.income_added_cents, 0n); assert.equal(novice.liability_added_cents, 0n); assert.match(novice.reason ?? "", /offsets PITIA only/);
  for (const exp of [{ fair_rental_days: 365 }, { fair_rental_days: 0, management_experience_months: 0 }]) {
    const loss = subjectRental({ gross_rent_cents: 240000n, pitia_cents: 215000n, transaction: "purchase", ...exp });
    assert.equal(loss.anri_cents, -35000n); assert.equal(loss.liability_added_cents, 35000n); assert.equal(loss.income_added_cents, 0n); assert.equal(loss.offset_only, false);
  }
  // the rule set is mandatory for applications on/after Nov 1, 2026 (the Oct 5 refinance fixture is grandfathered; the platform applies B3-3.8 anyway)
  const h = harness();
  const r = calculateIncome(h.events, { application_id: APP, borrower_id: B1, income_id: "inc-rent", income_type: "rental_subject", inputs: { gross_rent_cents: 240000n, pitia_cents: 165000n, transaction: "purchase", fair_rental_days: 365 } });
  assert.equal(r.calculation.monthly_qualifying_cents, 15000n); assert.equal(r.calculation.formula_version, FORMULAS.rental_subject);
});

test("22.3-T10: (ADU cap) Given total qualifying income 900,000 cents and ADU rent yielding 300,000 cents net, when applied, then ADU income is capped at 270,000 cents on a purchase/LCOR and excluded on a cash-out refinance.", () => {
  for (const transaction of ["purchase", "lcor"] as const) {
    const a = aduCap({ total_qualifying_cents: 900000n, adu_net_cents: 300000n, transaction });
    assert.equal(a.allowed_cents, 270000n); assert.equal(a.cap_cents, 270000n); assert.equal(a.capped, true); assert.equal(a.excluded, false);
  }
  const co = aduCap({ total_qualifying_cents: 900000n, adu_net_cents: 300000n, transaction: "cash_out_refinance" });
  assert.equal(co.allowed_cents, 0n); assert.equal(co.excluded, true); assert.match(co.reason ?? "", /purchase or limited cash-out/);
  assert.equal(aduCap({ total_qualifying_cents: 900000n, adu_net_cents: 250000n, transaction: "purchase" }).allowed_cents, 250000n);
});

test("22.3-T11: (Close by Date) Given a DU employment validation with Close by Date Nov 20, 2026, when consummation moves to Nov 23, then `FNMA_B3_2_02_DU_CLOSE_BY_GATE` breaches, a supplemental report or VVOE (window Nov 6–23) is required, DU is resubmitted, and the employment relief record is updated.", () => {
  const h = harness("2026-10-07T16:00:00.000Z"); h.schedule("2026-11-06");
  const du = recordDuValidation(h.events, { application_id: APP, borrower_id: B1, component: "employment", outcome: "validated", report_reference_id: "TWN-889900", supplier_code: "equifax_twn", employer_name: "Acme Manufacturing", close_by_date: D("2026-11-20"), message_date: D("2026-10-07") });
  assert.equal(du.validated, true); assert.equal(du.relief.status, "granted_subject_to_conditions");
  const gate = h.timer("FNMA_B3_2_02_DU_CLOSE_BY_GATE")!;
  assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2026-11-20"); assert.equal(gate.dueDate, "2026-11-20");
  assert.equal(closeByGate(D("2026-11-20"), D("2026-11-06")).open, true);
  // the closing moves to Mon Nov 23
  h.schedule("2026-11-23", "closing.rescheduled");
  const g = closeByGate(D("2026-11-20"), D("2026-11-23")); assert.equal(g.open, false);
  const r = reassessCloseBy(h.events, { application_id: APP, borrower_id: B1, close_by_date: D("2026-11-20"), scheduled_note_date: D("2026-11-23"), report_reference_id: "TWN-889900" });
  assert.equal(r.breached, true); assert.deepEqual(r.cure_options, ["supplemental_report", "vvoe"]);
  assert.equal(r.vvoe_window?.window_start, "2026-11-06"); assert.equal(r.vvoe_window?.note_date, "2026-11-23");        // ten creditor business days back, Veterans Day skipped
  assert.equal(h.ofType("du.resubmission.requested").length, 1); assert.equal(h.ofType("du.resubmission.requested")[0]!.payload.reason, "close_by_date_missed");
  assert.equal(h.ofType("rep_warrant_relief.updated")[0]!.payload.status, "lost_unless_cured"); assert.equal(r.relief.component, "employment");
  const breaches = h.timers.evaluate("2026-11-23T16:00:00.000Z");
  assert.ok(breaches.some((b) => b.instance.code === "FNMA_B3_2_02_DU_CLOSE_BY_GATE")); assert.equal(h.timer("FNMA_B3_2_02_DU_CLOSE_BY_GATE")!.status, "breached");
  // a DU "not validated" is never a validation
  const nv = recordDuValidation(h.events, { application_id: APP, borrower_id: B2, component: "employment", outcome: "not_validated", report_reference_id: "TWN-889901", supplier_code: "equifax_twn", documentation_required: ["form_1005_voe"], message_date: D("2026-10-07") });
  assert.equal(nv.validated, false); assert.equal(nv.event.type, "income.not_validated"); assert.equal(nv.relief.status, "none");
});

test("22.3-T12: (4506-C validity and exemption) Given a 4506-C signed Mon Oct 5, 2026, when validity is computed, then `valid_until = Tue Feb 2, 2027`; given Borrower B's only income is DU-validated, then no 4506-C is required for B and the `consummate` gate passes with A's form alone.", () => {
  assert.equal(form4506cValidUntil(D("2026-10-05")), "2027-02-02");
  const h = harness("2026-10-05T20:00:00.000Z");
  const s = signAuthorization(h.events, { application_id: APP, borrower_id: B1, form: "4506c", signed_at: "2026-10-05T20:00:00.000Z", signed_by: "borrower", signature_method: "esign_2fa", signature_audit_log_document_id: "doc-esign-log-1", tax_years: [2024, 2025] });
  assert.equal(s.record.signed_on, "2026-10-05"); assert.equal(s.record.valid_until, "2027-02-02"); assert.equal(s.record.status, "signed"); assert.equal(s.record.retention_class, "irs_ives_2y");
  const t = h.timer("FNMA_B3_3_1_02_4506C_VALID_120")!; assert.equal(t.status, "armed"); assert.equal(t.dueDate, "2027-02-02");
  // Borrower B: all income DU-validated → no 4506-C required; the consummate gate passes with A's form alone
  const gate = form4506cGate([{ borrower_id: B1, income_used_for_qualifying: true, all_income_du_validated: false, authorization_signed: true, authorization_valid_until: s.record.valid_until }, { borrower_id: B2, income_used_for_qualifying: true, all_income_du_validated: true, authorization_signed: false }], D("2026-11-06"));
  assert.equal(gate.open, true); assert.deepEqual(gate.required, [B1]); assert.deepEqual(gate.exempt, [B2]); assert.deepEqual(gate.missing, []);
  assert.equal(form4506cGate([{ borrower_id: B1, income_used_for_qualifying: true, all_income_du_validated: false, authorization_signed: false }], D("2026-11-06")).open, false);
  // an order inside validity satisfies the clock (400 cents per transcript); one after Feb 2, 2027 is refused
  const o = orderTranscript(h.events, s.record, { channel: "ives_a2a", ordered_at: "2026-10-06T15:00:00.000Z", participant_id_masked: "******1234" });
  assert.equal(o.fee_cents, 800n); assert.equal(o.record.status, "ordered"); assert.equal(h.timer("FNMA_B3_3_1_02_4506C_VALID_120")!.status, "satisfied");
  assert.throws(() => orderTranscript(h.events, s.record, { channel: "ives_webui", ordered_at: "2027-02-03T15:00:00.000Z", participant_id_masked: "******1234" }), (e: unknown) => e instanceof IncomeRuleRefused && e.code === "FORM_4506C_EXPIRED");
  // the agent never signs
  assert.throws(() => signAuthorization(h.events, { application_id: APP, borrower_id: B1, form: "4506c", signed_at: "2026-10-05T20:00:00.000Z", signed_by: "agent:verification", signature_method: "esign_2fa", signature_audit_log_document_id: "doc-x", tax_years: [2025] }), (e: unknown) => e instanceof IncomeRuleRefused && e.code === "FORM_4506C_SIGNER");
});

test("22.3-T13: (Reg B no-discount) Given a part-time base income of $1,800.00/month with 24 months history, when calculated, then the formula id equals the full-time base formula and `regb_check = pass`; any attempt to apply a factor < 1.0 is rejected by the engine.", async () => {
  const partTime = baseMonthly(180000n, ["part_time"]);
  assert.equal(partTime.monthly_qualifying_cents, 180000n);
  assert.equal(partTime.formula_version, baseSalary(7500000n).formula_version); assert.equal(partTime.formula_version, FORMULAS.base_salary);
  const check = regbCheck({ income_type: "base_salary", regb_flags: ["part_time"], formula_version: partTime.formula_version, factor: null, history_months: 24 });
  assert.equal(check.regb_check, "pass"); assert.deepEqual(check.permitted_variables, ["amount", "probable_continuance"]);
  assert.throws(() => regbCheck({ income_type: "base_salary", regb_flags: ["part_time"], formula_version: FORMULAS.base_salary, factor: "0.9" }), (e: unknown) => e instanceof RegBViolation && e.code === "REGB_1002_6_B_NO_DISCOUNT");
  assert.throws(() => regbCheck({ income_type: "base_salary", regb_flags: ["part_time"], formula_version: FORMULAS.base_salary, exclusion_reason: "part-time job" }), RegBViolation);
  // through the bus: the guardrail refuses a factor < 1.0 before the handler runs; the calculation records regb_check = pass with the formula id
  const h = harness(); h.schedule("2026-11-06");
  await refused(h.run("buildDocumentationMatrix", { op: "calculate", borrower_id: B1, income_id: "inc-pt", income_type: "base_salary", regb_flags: ["part_time"], factor: "0.75", inputs: { monthly_cents: "180000", history_months: 24 } }), "REGB_1002_6_B_NO_DISCOUNT");
  const out = await h.run("buildDocumentationMatrix", { op: "calculate", borrower_id: B1, income_id: "inc-pt", income_type: "base_salary", regb_flags: ["part_time"], inputs: { monthly_cents: "180000", history_months: 24 }, evidence_document_ids: ["doc-paystub-1", "doc-w2-2025"] });
  assert.equal(out.formula_version, FORMULAS.base_salary); assert.equal(out.regb_check, "pass"); assert.equal(out.monthly_qualifying_cents, 180000n);
  const d = h.decisions.find((x) => x.action === "income.calculate")!; assert.match(d.rationale, /"regb_check":"pass"/); assert.equal(d.ruleCode, FORMULAS.base_salary);
  assert.deepEqual(h.rt.store.get("application_income", "inc-pt")!.data.regb_flags, ["part_time"]);
});

test("22.3-T14: (employment offer option 2) Given a purchase closing Nov 18, 2026 with a non-contingent offer starting Mon Feb 15, 2027 and 6 months PITIA reserves, when evaluated, then option 2 is available (start ≤ Feb 16, 2027) and SFC 707 is queued; with a start of Wed Feb 17, 2027 option 2 is refused.", () => {
  assert.deepEqual(offerStartWindow(PURCHASE_NOTE_DATE), { start: "2026-10-19", end: "2027-02-16" });
  const offer = { note_date: PURCHASE_NOTE_DATE, start_date: D("2027-02-15"), monthly_income_cents: 650000n, non_contingent: true, fully_executed: true, transaction: "purchase" as const, occupancy: "principal_residence" as const, units: 1, fixed_base_income: true, family_or_interested_party: false, reserves_months_pitia: 6 };
  const ok = offerOption2(offer);
  assert.equal(ok.available, true); assert.equal(ok.within_window, true); assert.deepEqual(ok.sfc_codes, ["707"]); assert.deepEqual(ok.refusal_reasons, []);
  const late = offerOption2({ ...offer, start_date: D("2027-02-17") });
  assert.equal(late.available, false); assert.equal(late.within_window, false); assert.match(late.refusal_reasons[0] ?? "", /2027-02-17 outside \[2026-10-19, 2027-02-16\]/); assert.deepEqual(late.sfc_codes, []);
  assert.equal(offerOption2({ ...offer, non_contingent: false }).available, false, "a contingent offer is unavailable for option 2");
  // the selection arms FNMA_B3_3_3_03_OFFER_START_WINDOW (window Oct 19, 2026 – Feb 16, 2027); the verified offer satisfies it and queues SFC 707
  const h = harness(); h.schedule("2026-11-18");
  const sel = selectOfferOption(h.events, { application_id: APP, income_id: "inc-offer", borrower_id: B1, option: 2, offer });
  const t = h.timer("FNMA_B3_3_3_03_OFFER_START_WINDOW")!; assert.equal(t.anchorDate, "2026-11-18"); assert.match(t.note ?? "", /window opens 2026-10-19/); assert.equal(t.dueDate, "2027-02-16"); assert.equal(t.status, "satisfied");
  assert.equal(sel.outcome.type, "employment.offer.verified"); assert.equal(sel.sfc?.type, "delivery.sfc.queued"); assert.equal(sel.sfc?.payload.code, "707"); assert.equal(sel.qualifying_cents, 650000n);
  const ref = selectOfferOption(h.events, { application_id: APP, income_id: "inc-offer-2", borrower_id: B1, option: 2, offer: { ...offer, start_date: D("2027-02-17") } });
  assert.equal(ref.outcome.type, "employment.offer.option.refused"); assert.equal(ref.sfc, null); assert.equal(ref.qualifying_cents, 0n);
  assert.equal(h.timers.byCode("FNMA_B3_3_3_03_OFFER_START_WINDOW").at(-1)!.status, "armed", "the refused option leaves its window gate open for option 1 or exclusion");
});

test("22.3-T15: (Income Calculator ceiling) Given a calculator result of 812,500 cents for a Schedule C borrower, when the agent's Form 1084 analysis yields 830,000 cents, then qualifying is 812,500 cents and the Findings Report id is attached; a manual override above the ceiling is rejected.", async () => {
  const c = incomeCalculatorCeiling({ calculator_result_cents: 812500n, agent_result_cents: 830000n, findings_report_id: "IC-2026-000123" });
  assert.equal(c.qualifying_cents, 812500n); assert.equal(c.ceiling_applied, true); assert.equal(c.income_calculator_report_id, "IC-2026-000123");
  assert.throws(() => assertUnderCalculatorCeiling(830000n, 812500n), (e: unknown) => e instanceof IncomeRuleRefused && e.code === "INCOME_CALCULATOR_CEILING");
  assertUnderCalculatorCeiling(812500n, 812500n);
  const h = harness();
  const f = recordCalculatorFindings(h.events, { application_id: APP, income_id: "inc-se", findings_report_id: "IC-2026-000123", calculator_result_cents: 812500n, agent_result_cents: 830000n });
  assert.equal(f.qualifying_cents, 812500n); assert.equal(f.du_fields["DU:VerificationReportIdentifier"], "IC-2026-000123"); assert.equal(f.event.payload.ceiling_applied, true);
  const calc = calculateIncome(h.events, { application_id: APP, borrower_id: B1, income_id: "inc-se", income_type: "self_employment_sole_prop", calculator_result_cents: 812500n, income_calculator_report_id: "IC-2026-000123", inputs: { form_1084_result_cents: 830000n, ownership_pct: 100 } });
  assert.equal(calc.calculation.monthly_qualifying_cents, 812500n); assert.equal(calc.calculation.inputs.income_calculator_report_id, "IC-2026-000123");
  // through the bus: the findings attach the report id to the source; a manual override above the ceiling is refused by the guardrail and by the engine
  const out = await h.run("submitIncomeCalculator", { op: "findings", income_id: "inc-se", findings_report_id: "IC-2026-000123", calculator_result_cents: "812500", agent_result_cents: "830000" });
  assert.equal(out.qualifying_cents, 812500n); assert.equal(h.rt.store.get("application_income", "inc-se")!.data.income_calculator_report_id, "IC-2026-000123");
  await refused(h.run("submitIncomeCalculator", { op: "override", income_id: "inc-se", qualifying_cents: "830000", calculator_result_cents: "812500", formula_version: FORMULAS.self_employment, rationale: "manual" }), "INCOME_CALCULATOR_CEILING");
  await refused(h.run("submitIncomeCalculator", { op: "override", income_id: "inc-se", qualifying_cents: "830000", calculator_result_cents: "812500", formula_version: FORMULAS.self_employment, rationale: "manual", bypass: true }), "INCOME_CALCULATOR_CEILING");
});

test("22.3 worked figures: base $6,250.00, hourly $5,633.33, overtime $921.43 / $950.00, bonus $1,000.00, Social Security $2,075.00, child support $1,000.00, rental $350.00 / $150.00, ADU $2,700.00, total $9,246.43", () => {
  // R2 — base income: $75,000.00 → 7,500,000 / 12 = 625,000 cents ($6,250.00); $32.50 × 40 × 52 / 12 → 563,333 cents ($5,633.33)
  assert.equal(baseSalary(7500000n).monthly_qualifying_cents, 625000n);
  assert.equal(hourlyBase({ rate_cents: 3250n, guaranteed_hours_per_week: 40 }).monthly_qualifying_cents, 563333n);
  // R3 — example A: 2025 W-2 $10,800.00 (1,080,000), 2026 YTD through Sept $8,550.00 (855,000): $950.00 vs $900.00 → increasing → $921.43
  const a = variableIncome({ ytd_cents: 855000n, ytd_months: 9, prior_year_cents: 1080000n });
  assert.equal(a.trend_detail.ytd_monthly_cents, 95000n); assert.equal(a.trend_detail.prior_monthly_cents, 90000n); assert.equal(a.monthly_qualifying_cents, 92143n);
  // R3 — example B: 2025 overtime 1,440,000 ($1,200.00/mo) vs $950.00/mo → decreasing; flat since Apr 1, 2026 at 570,000 / 6 → $950.00
  const b = variableIncome({ ytd_cents: 855000n, ytd_months: 9, prior_year_cents: 1440000n, stabilization: { since: D("2026-04-01"), cents_since: 570000n, months_since: 6 } });
  assert.equal(b.trend_detail.prior_monthly_cents, 120000n); assert.equal(b.monthly_qualifying_cents, 95000n);
  // R3 — bonus: $12,000.00 paid Mar 31 → 1,200,000 / 12 = 100,000 cents ($1,000.00) per month
  assert.equal(bonusMonthly(1200000n).monthly_cents, 100000n);
  // R6 — Social Security $2,000.00: nontaxable 30,000, gross-up 7,500 → $2,075.00; child support $800.00: gross-up 20,000 → $1,000.00
  assert.equal(socialSecurity({ amount_cents: 200000n, record: "own", benefit: "retirement" }).qualifying_cents, 207500n);
  assert.equal(supportIncome({ amount_cents: 80000n, kind: "child_support", receipts_months: 6, receipts_full_regular_timely: true, agreement_document_id: "doc-decree-1", child_date_of_birth: D("2011-11-07") }).qualifying_cents, 100000n);
  // R5 — rental: $2,400.00 × 75% = $1,800.00; PITIA $2,150.00 → −$350.00 to obligations; PITIA $1,650.00 → +$150.00 income (experienced)
  const loss = subjectRental({ gross_rent_cents: 240000n, pitia_cents: 215000n, transaction: "purchase", fair_rental_days: 365 });
  assert.equal(loss.net_cents, 180000n); assert.equal(loss.liability_added_cents, 35000n);
  assert.equal(subjectRental({ gross_rent_cents: 240000n, pitia_cents: 165000n, transaction: "purchase", fair_rental_days: 365 }).income_added_cents, 15000n);
  // R5 — ADU: total qualifying $9,000.00 → cap 270,000 cents ($2,700.00)
  assert.equal(aduCap({ total_qualifying_cents: 900000n, adu_net_cents: 300000n, transaction: "purchase" }).allowed_cents, 270000n);
  // R13 — total: base $6,250.00 + overtime $921.43 + Social Security $2,075.00 (200,000 + gross-up 7,500) = 924,643 cents ($9,246.43); rental losses go to 22.5
  const total = totalQualifying([
    { income_id: "base", monthly_qualifying_cents: 625000n, gross_up_cents: 0n, used_for_qualifying: true },
    { income_id: "ot", monthly_qualifying_cents: 92143n, gross_up_cents: 0n, used_for_qualifying: true },
    { income_id: "ss", monthly_qualifying_cents: 200000n, gross_up_cents: 7500n, used_for_qualifying: true },
    { income_id: "rent", monthly_qualifying_cents: 0n, gross_up_cents: 0n, used_for_qualifying: false, liability_added_cents: 35000n },
  ]);
  assert.equal(total.total_qualifying_cents, 924643n); assert.equal(total.obligations_from_rental_cents, 35000n); assert.deepEqual(total.counted, ["base", "ot", "ss"]);
});
