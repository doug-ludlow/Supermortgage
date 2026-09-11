// 20.1 Portfolio rate monitoring and refinance-opportunity detection on the subserviced book (self-improving-mortgage trigger)
// spec/sections/20-refinance-triggers-solicitation-lead-intake-and-pricing/20-1-portfolio-rate-monitoring-and-refinance-opportunity-detectio.md
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
import { TOOLS_20_1 } from "../../app/tools/section20-1.ts";
import { EVALUATORS_20_1 } from "./evaluators-20-1.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { type RateSheet, type LlpaTable, type SmCostSchedule, type QuoteContext, FNMA_LLPA_09_09_2026, publishRateSheet, loadLlpaTables } from "./ops-20-4.ts";
import { type UniverseLoan, type GateFacts, type PipelineContext, type RefiOpportunity, DEFAULT_PROGRAM, SM_REFI_RULE_SET_V1, MA_183_28C, NO_GATE_FACTS, RefiRefused,
  scheduledUpb, perDiem365, payoffEstimate, remainingInterest, npvOfDelta, balanceAfter, assertPi, buildCandidate, priceCandidate, computeBenefit, fireRule, borrowerInterestRule, cashoutNoteSeasoningGate, titleSeasoningGate, resolicitCooldownGate, premiumRecaptureGate, checkGates, assertGateOpen,
  loadUniverse, staticCheckRuleSet, evaluateLoan, runTrigger, requestOpportunity, recordOffered, engageOpportunity, declineOpportunity, fnmaOwnershipCheck, assessPremiumRecapture, defaultSchedule, monthsBetween } from "./ops-20-1.ts";

const AGENT: Actor = { kind: "agent", id: "intake" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const ET = (date: string, hhmm: string, offset = "-04:00"): string => new Date(`${date}T${hhmm}:00${offset}`).toISOString();
const store = (now = ET("2026-10-01", "06:41")) => new MemoryEventStore(new FixedClock(now));
const cost = (fee_code: string, description: string, mismo: string, le_section: SmCostSchedule["items"][number]["le_section"], vendor: string, amount_cents: bigint, provider_source: SmCostSchedule["items"][number]["provider_source"] = "creditor_selected_third_party", shoppable = false) => ({ fee_code, description, mismo_fee_type: mismo, le_section, vendor, amount_cents, provider_source, shoppable });
/** Worked example 1's third-party costs (AZ, LCOR, hybrid): $84 + $450 + $10 + $1,650 + $950 + $61 + $280 = $3,485.00. */
const COST_AZ: SmCostSchedule = { cost_schedule_id: "cs-az-lcor-hybrid-2026-09", partner_id: "partner-1", state: "AZ", transaction_type: "limited_cash_out", valuation_method: "hybrid", effective_from: D("2026-09-01"), approved_by: "human:u-officer", items: [
  cost("credit_report", "Credit report", "CreditReportFee", "B_cannot_shop", "CRA", 8400n), cost("appraisal_hybrid", "Hybrid appraisal / PDC", "AppraisalFee", "B_cannot_shop", "AMC", 45000n), cost("flood_determination", "Flood determination", "FloodCertification", "B_cannot_shop", "FloodCo", 1000n),
  cost("title_lenders_policy", "Lender's title policy", "TitleLendersCoveragePremium", "C_can_shop", "Grand Canyon Title", 165000n, "list_provider", true), cost("settlement_agent_fee", "Settlement fee", "TitleSettlementAgentFee", "C_can_shop", "Grand Canyon Title", 95000n, "list_provider", true), cost("recording_fee", "Recording", "RecordingFeeForDeed", "E_taxes_gov", "Maricopa County", 6100n, "government"), cost("ron_enote", "eNote / RON", "NotaryFee", "B_cannot_shop", "RON vendor", 28000n)] };
/** T2: the same schedule with the settlement fee at $1,765 → $4,300.00. */
const COST_AZ_4300: SmCostSchedule = { ...COST_AZ, cost_schedule_id: "cs-az-lcor-hybrid-4300", items: COST_AZ.items.map((c) => (c.fee_code === "settlement_agent_fee" ? { ...c, amount_cents: 176500n } : c)) };
const grid45 = (rows: [string, string][]) => rows.map(([r, p]) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 45, price: p }));
/** Worked example 1's illustrative 45-day best-efforts sheet (6.375 → 101.875 … 5.875 → 99.750), published 06:35 ET, expiring 17:00 ET. */
const SHEET = (events: MemoryEventStore, date = "2026-10-01", offset = "-04:00"): RateSheet => publishRateSheet(events, { rate_sheet_id: `rs-${date}`, partner_id: "partner-1", source: "pe_whole_loan_api", published_at: ET(date, "06:35", offset), expires_at: ET(date, "17:00", offset), published_by: "agent:pricing", prices: grid45([["6.375", "101.875"], ["6.250", "101.375"], ["6.125", "100.875"], ["6.000", "100.375"], ["5.875", "99.750"]]) }).sheet;
const TABLES = (events: MemoryEventStore): LlpaTable[] => loadLlpaTables(events, FNMA_LLPA_09_09_2026, { at: ET("2026-09-10", "12:00"), status: "active" }).tables;
/** The fixture loan on the subserviced book: $565,000, 30-year fixed 7.000 %, note Fri Sept 18, 2024, first payment Nov 1, 2024, 24 payments made; escrowed, no MI, Phoenix AZ; investor field populated in `loans` but hidden by `v_refi_universe`. */
const LOAN_A: UniverseLoan = { loan_id: "L-565", partner_id: "partner-1", status: "active", product_code: "FRM30", amortization: "fixed", note_date: D("2024-09-18"), first_payment_date: D("2024-11-01"), consummation_date: D("2024-09-18"), title_date: D("2019-06-14"),
  original_upb_cents: 56500000n, original_term_months: 360, note_rate_pct: "7.000", pi_cents: 375896n, payments_made: 24, upb_cents: 55310641n, next_due_date: D("2026-11-01"), remaining_term_months: 336,
  escrowed: true, escrow_monthly_cents: 55500n, net_escrow_deposit_estimate_cents: 300000n, taxes_annual_cents: 480000n, insurance_annual_cents: 186000n, mi_status: "none", mi_monthly_cents: 0n, occupancy: "primary", property_type: "sfr", units: 1, property_state: "AZ", county: "Maricopa", county_limit_cents: 83275000n,
  value_estimate: { source: "origination_indexed", value_cents: 80000000n, as_of: D("2026-09-30"), confidence: "high" }, representative_score: 765, score_source: "origination_file",
  regx_days_delinquent: 0, bankruptcy_active: false, foreclosure_referred: false, lossmit_plan_active: false, deceased_or_sii_pending: false, transfer_out_pending: false, refi_do_not_solicit: false, refi_last_offered_at: null, refi_offers_12m: 0, arm_first_adjustment_date: null };
const JURIS = { MA: MA_183_28C };
const ctxOf = (events: MemoryEventStore, o: { as_of?: string; at?: string; sheet?: RateSheet; cost?: SmCostSchedule; run_id?: string | null; schedule?: PipelineContext["schedule"] } = {}): PipelineContext => ({ program: DEFAULT_PROGRAM, rule_set: SM_REFI_RULE_SET_V1, pricing: { sheet: o.sheet ?? SHEET(events), tables: TABLES(events), cost_schedule: o.cost ?? COST_AZ, fee_schedule: null }, jurisdiction_rules: JURIS, as_of: D(o.as_of ?? "2026-10-01"), at: o.at ?? ET("2026-10-01", "06:41"), run_id: o.run_id === undefined ? "run-2026-10-01" : o.run_id, ...(o.schedule ? { schedule: o.schedule } : {}) });
const runOnce = (events: MemoryEventStore, ctx: PipelineContext, loans: UniverseLoan[], facts: Record<string, GateFacts> = {}, prior: RefiOpportunity[] = [], extracts: ReturnType<typeof runTrigger>["extract"][] = []) => runTrigger(events, ctx, { run_id: ctx.run_id!, trigger_kind: "scheduled", loans, gate_facts: facts, prior_opportunities: prior, prior_extracts: extracts });
const ofType = (events: MemoryEventStore, type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
/** 20.2's first-touch confirmation and 20.3's linked lead, appended as platform records (those processes land in parallel). */
const touchSent = (events: MemoryEventStore, o: RefiOpportunity, at: string) => events.append({ type: "marketing.touch.sent", actor: { kind: "agent", id: "intake" }, occurredAt: at, loanId: o.loan_id, aggregate: { kind: "marketing_touch", id: `touch-${o.opportunity_id}` }, payload: { opportunity_id: o.opportunity_id, touch_id: `touch-${o.opportunity_id}`, campaign_id: "camp-refi-2026-10", channel: "email", origination: true } });
const leadCreated = (events: MemoryEventStore, o: RefiOpportunity, at: string) => events.append({ type: "lead.created", actor: { kind: "agent", id: "intake" }, occurredAt: at, loanId: o.loan_id, aggregate: { kind: "lead", id: `lead-${o.loan_id}` }, payload: { lead_id: `lead-${o.loan_id}`, opportunity_id: o.opportunity_id, channel: "organic", origination: true } });

/** The 20.1 tools on the bus over the overridden registry (20.1 rows), the entity store and the escalation service. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["20.1"] });
  const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_20_1); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("20.1", name))!, actor, input, uow)).output as Record<string, unknown>;
  /** Seed the store the way the runtime would: the program, the view rows, the gate facts and 20.4's pricing inputs. */
  const seed = (loans: UniverseLoan[], facts: Record<string, GateFacts> = {}, o: { sheetDate?: string; offset?: string; cost?: SmCostSchedule } = {}) => {
    rt.store.put("partner_programs", DEFAULT_PROGRAM.program_id, DEFAULT_PROGRAM as unknown as Record<string, unknown>, AGENT, nowIso);
    for (const l of loans) { rt.store.put("refi_universe", l.loan_id, l as unknown as Record<string, unknown>, AGENT, nowIso); rt.store.put("refi_gate_facts", l.loan_id, { ...NO_GATE_FACTS, ...(facts[l.loan_id] ?? {}) }, AGENT, nowIso); }
    const sheet = SHEET(events, o.sheetDate ?? "2026-10-01", o.offset ?? "-04:00"); rt.store.put("rate_sheets", sheet.rate_sheet_id, sheet as unknown as Record<string, unknown>, AGENT, nowIso);
    rt.store.put("llpa_tables", "llpa-09.09.2026", { matrix_version: "09.09.2026", status: "active", tables: TABLES(events) }, AGENT, nowIso);
    rt.store.put("sm_cost_schedules", (o.cost ?? COST_AZ).cost_schedule_id, (o.cost ?? COST_AZ) as unknown as Record<string, unknown>, AGENT, nowIso);
    return sheet;
  };
  return { rt, uow, events, timers, run, seed, at: (iso: string) => clock.set(iso), decisions };
}

test("20.1-T1: Given the worked-example-1 loan and rate sheet on Thu Oct 1, 2026, when the run executes, then `candidate_terms.note_rate = 0.06125`, `pi_cents = 340262`, `rate_delta_bps = 87.5`, `pi_delta_cents = 35634`, `npv_cents = 2429278`, `lifetime_interest_delta_cents = -4496095`, status `offer_ready`, `SM_REFI_OFFER_SLA_2BD.due_at = 2026-10-05`.", () => {
  const h = harness(ET("2026-10-01", "06:41")); const ctx = ctxOf(h.events);
  const daily = h.timers.byCode("SM_REFI_TRIGGER_DAILY"); assert.equal(daily.length, 1); assert.equal(daily[0]!.status, "armed");      // armed by 20.4's rate_sheet.published (06:35 ET)
  const r = runOnce(h.events, ctx, [LOAN_A]);
  const o = r.opportunities[0]!; const c = o.candidate_terms!, m = o.benefit_metrics!;
  assert.equal(o.status, "offer_ready"); assert.equal(o.trigger_kind, "scheduled"); assert.deepEqual(o.suppression_reasons, []);
  assert.equal(c.transaction_type, "limited_cash_out"); assert.equal(c.term_months, 360); assert.equal(c.loan_amount_cents, 56000000n); assert.equal(c.ltv, "0.7000"); assert.equal(c.payoff_estimate_cents, 55427329n); assert.equal(c.cash_back_cents, 394128n); assert.equal(c.cash_back_cap_cents, 560000n);
  assert.equal(c.note_rate, "0.06125"); assert.equal(c.pi_cents, 340262n);
  assert.equal(m.rate_delta_bps, 87.5); assert.equal(m.pi_delta_cents, 35634n); assert.equal(m.npv_cents, 2429278n); assert.equal(m.lifetime_interest_delta_cents, -4496095n);
  assert.equal(m.breakeven_months, 0); assert.equal(m.borrower_paid_costs_cents, 0n); assert.equal(m.seven_year_total_cost_delta_cents, 2243654n); assert.equal(o.present_same_term_first, false);
  assert.equal(o.eligibility_prescreen!.requires_fnma_ownership_check, false);
  const ready = ofType(h.events, "refi.opportunity.offer_ready"); assert.equal(ready.length, 1); assert.equal(ready[0]!.loanId, "L-565"); assert.equal(ready[0]!.payload.detected_at, ET("2026-10-01", "06:41")); assert.equal(ready[0]!.payload.origination, true);
  const sla = h.timers.byCode("SM_REFI_OFFER_SLA_2BD").at(-1)!;
  assert.equal(sla.status, "armed"); assert.equal(sla.anchorDate, "2026-10-01"); assert.equal(sla.dueDate, "2026-10-05");                         // Fri Oct 2 BD1, Mon Oct 5 BD2
  assert.equal(r.run.opportunities_detected, 1); assert.equal(r.run.loans_in_universe, 1); assert.equal(r.run.rule_set_version, "sm.refi_trigger.v1"); assert.equal(r.run.purpose, "partner_program:prog-refi-partner-1");
  assert.equal(daily[0]!.status, "satisfied");                                                                                                    // refi.trigger.run_completed on the sheet
  assert.equal(h.timers.byCode("SM_REFI_TRIGGER_DAILY").length, 2);                                                                              // recurring: re-armed for the next day
  // 20.2 sends the offer Fri Oct 2: marketing.touch.sent satisfies the SLA and `offered` anchors the expiry / frequency cap
  const touch = touchSent(h.events, o, ET("2026-10-02", "09:00")); const offered = recordOffered(h.events, o, touch);
  assert.equal(offered.opportunity.status, "offered"); assert.equal(sla.status, "satisfied"); assert.equal(offered.event.payload.offered_at, ET("2026-10-02", "09:00"));
  assert.equal(h.timers.byCode("SM_REFI_OPPORTUNITY_EXPIRY_30").at(-1)!.dueDate, "2026-11-01");
});

test("20.1-T2: Given the same loan with third-party costs $4,300, then 6.125% nets $4,200 < $4,300 and 6.250% nets $7,000 ≥ $4,300 → `note_rate = 0.06250`, `pi_cents = 340262 + (P&I at 6.250% − P&I at 6.125%)` recomputed by formula, `rate_delta_bps = 75`.", () => {
  const events = store(); const ctx = ctxOf(events, { cost: COST_AZ_4300 });
  const r = evaluateLoan(events, ctx, LOAN_A, NO_GATE_FACTS, { trigger_kind: "scheduled", path: "proactive" });
  const q = r.quote!; const c = r.opportunity.candidate_terms!;
  assert.equal(q.third_party_costs_cents, 430000n);
  const at = (pct: string) => q.solve_trace.find((t) => t.rate_pct === pct)!;
  assert.deepEqual([at("6.125").net_cents, at("6.125").pass], [420000n, false]); assert.deepEqual([at("6.250").net_cents, at("6.250").pass], [700000n, true]);
  assert.equal(c.note_rate, "0.06250");
  const piAt = (pct: string) => levelPayment(56000000n, ratePercent(pct), 360);
  assert.equal(c.pi_cents, 340262n + (piAt("6.250") - piAt("6.125"))); assert.equal(c.pi_cents, 344802n);
  assert.equal(r.opportunity.benefit_metrics!.rate_delta_bps, 75); assert.equal(r.opportunity.status, "offer_ready");
});

test("20.1-T3: Given a loan whose `fnma_purchase_date = 2026-08-20`, when the run executes on 2026-10-01, then status `suppressed{reason=premium_recapture_window}` and `FNMA_C1_1_01_PREMIUM_RECAPTURE_120.due_at = 2026-12-18`; a borrower request on 2026-10-05 creates `requested` with an `officer` escalation.", async () => {
  const h = harness(ET("2026-10-01", "06:41")); const loan: UniverseLoan = { ...LOAN_A, loan_id: "L-fnma" }; const facts: GateFacts = { fnma_purchase_date: D("2026-08-20"), declined_on: null, offered_at: [] };
  // 29.4's purchase event (platform record): the gate arms from purchase_date + 120 calendar days
  h.events.append({ type: "loan.purchased", actor: { kind: "agent", id: "secondary" }, occurredAt: ET("2026-08-20", "15:00"), loanId: "L-fnma", payload: { purchase_date: "2026-08-20", acquisition_date: "2026-08-20", fnma_purchase_date: "2026-08-20", fnma_loan_number: "1234567890", application_id: "app-fnma", origination: true } });
  const gate = h.timers.byCode("FNMA_C1_1_01_PREMIUM_RECAPTURE_120").at(-1)!; assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2026-08-20"); assert.equal(gate.dueDate, "2026-12-18");
  assert.deepEqual(premiumRecaptureGate({ fnma_purchase_date: D("2026-08-20"), as_of: D("2026-10-01") }), { open: false, opens_on: "2026-12-18", reason: "inside the premium-recapture window (C1-1-01): opens 2026-12-18" });
  const r = runOnce(h.events, ctxOf(h.events), [loan], { "L-fnma": facts });
  const o = r.opportunities[0]!; assert.equal(o.status, "suppressed"); assert.deepEqual(o.suppression_reasons, ["premium_recapture_window"]);
  const sup = ofType(h.events, "refi.opportunity.suppressed")[0]!; assert.equal(sup.payload.reason, "premium_recapture_window"); assert.equal(sup.payload.due_at, "2026-12-18"); assert.equal(sup.payload.gate, "FNMA_C1_1_01_PREMIUM_RECAPTURE_120");
  assert.equal(r.run.suppressed_by_reason.premium_recapture_window, 1); assert.equal(ofType(h.events, "refi.opportunity.offer_ready").length, 0);
  // the borrower calls Mon Oct 5: the request path creates `requested` and opens the partner officer's acknowledgment of the modelled recapture
  h.at(ET("2026-10-05", "09:30")); h.seed([loan], { "L-fnma": facts }, { sheetDate: "2026-10-05" });
  const req = await h.run("emitOfferReady", { op: "request", loan_id: "L-fnma", free_text: "can I refinance?" });
  assert.equal(req.status, "requested"); assert.equal(req.officer_acknowledgment_required, true); assert.equal(req.escalation_kind, "officer"); assert.equal(req.recapture_estimate_cents, "483968");   // 0.875 % × $553,106.41
  assert.equal(h.rt.escalations.list().filter((e) => e.kind === "officer" && e.loanId === "L-fnma").length, 1);
  const reqEv = ofType(h.events, "refi.opportunity.requested").at(-1)!; assert.equal(reqEv.payload.officer_acknowledgment_required, true); assert.equal(reqEv.payload.recapture_window_opens_on, "2026-12-18");
  await assert.rejects(h.run("emitOfferReady", { op: "request", loan_id: "L-fnma", officer_acknowledged: true }), (e: unknown) => e instanceof CommandRefused && e.code === "OFFICER_ACKNOWLEDGES_RECAPTURE");
  const ack = await h.run("emitOfferReady", { op: "request", loan_id: "L-fnma", officer_acknowledged: true }, OFFICER);
  assert.equal(ack.status, "offer_ready"); assert.equal(ack.note_rate, "0.06125");                                                               // the request path proceeds after the acknowledgment
  // the window closes Dec 18: the assessment (27.2's event, recorded here as a platform record) satisfies the gate
  h.at(ET("2026-12-18", "09:00", "-05:00"));
  const closed = assessPremiumRecapture(h.events, loan, facts, ET("2026-12-18", "09:00", "-05:00")); assert.equal(closed.open, true); assert.equal(closed.event!.type, "premium_recapture.assessed"); assert.equal(gate.status, "satisfied");
});

test("20.1-T4: Given a cash-out request on 2026-10-05 for an existing loan with note date 2025-11-20, then `FNMA_B2_1_3_03_CASHOUT_NOTE_SEASONING_12M` reports earliest new note date 2026-11-20, the cash-out candidate is not offered for a 2026-11-06 consummation, and an LCOR candidate with cash back ≤ $5,600 is offered instead.", () => {
  const h = harness(ET("2026-10-05", "09:00")); const sheet = SHEET(h.events, "2026-10-05");
  // O1-IT4's fixture: the $565,000 / 7.000 % balances with a Thu Nov 20, 2025 note (title taken at that purchase)
  const loan: UniverseLoan = { ...LOAN_A, loan_id: "L-cashout", note_date: D("2025-11-20"), consummation_date: D("2025-11-20"), title_date: D("2025-11-20"), first_payment_date: D("2026-01-01") };
  const schedule = { consummation_date: D("2026-11-06"), disbursement_date: D("2026-11-12"), first_payment_date: D("2027-01-01"), expected_purchase_ready_date: D("2026-11-19") };
  const gate = cashoutNoteSeasoningGate({ note_date: D("2025-11-20"), new_note_date: D("2026-11-06") });
  assert.equal(gate.open, false); assert.equal(gate.earliest_new_note_date, "2026-11-20"); assert.equal(gate.earliest_disbursement_date, "2026-11-25");   // rescission through midnight Tue Nov 24 (Sat Nov 21 counts)
  assert.match(gate.reason!, /351 days old/);
  assert.deepEqual(titleSeasoningGate({ title_date: D("2025-11-20"), disbursement_date: D("2026-11-12") }), { open: true, opens_on: "2026-05-20", reason: null });  // six months elapsed Wed May 20, 2026
  assert.equal(cashoutNoteSeasoningGate({ note_date: D("2025-11-20"), new_note_date: D("2026-11-20") }).open, true);
  const ctx = ctxOf(h.events, { as_of: "2026-10-05", at: ET("2026-10-05", "09:00"), sheet, run_id: null, schedule });
  const r = requestOpportunity(h.events, ctx, loan, NO_GATE_FACTS, { requested_at: ET("2026-10-05", "09:00"), free_text: "I'd like to take $40,000 cash out", cash_out_requested_cents: 4000000n });
  const o = r.opportunity; const c = o.candidate_terms!;
  assert.equal(ofType(h.events, "refi.opportunity.requested")[0]!.payload.transaction_type, "cash_out");
  assert.equal(c.transaction_type, "limited_cash_out"); assert.ok(c.cash_back_cents <= 560000n); assert.equal(c.cash_back_cap_cents, 560000n); assert.equal(c.cash_out_requested_cents, 0n);
  assert.deepEqual(o.alternatives, [{ transaction_type: "cash_out", status: "deferred", earliest_note_date: "2026-11-20", earliest_disbursement_date: "2026-11-25", reason: gate.reason! }]);
  assert.equal(o.status, "offer_ready"); assert.equal(o.trigger_kind, "borrower_request");
  const detected = ofType(h.events, "refi.opportunity.detected")[0]!; assert.equal(detected.payload.transaction_type, "cash_out");                 // the cash-out request arms both seasoning gates
  assert.equal(h.timers.byCode("FNMA_B2_1_3_03_CASHOUT_NOTE_SEASONING_12M").at(-1)!.anchorDate, "2025-11-20"); assert.equal(h.timers.byCode("FNMA_B2_1_3_03_TITLE_SEASONING_6M").at(-1)!.anchorDate, "2025-11-20");
  assert.deepEqual(EVALUATORS_20_1["20.1.cashoutNoteSeasoningGate"]!({ note_date: "2025-11-20", new_note_date: "2026-11-06" }).open, false);
  assert.deepEqual(EVALUATORS_20_1["20.1.cashoutNoteSeasoningGate"]!({ note_date: "2025-11-20", new_note_date: "2026-11-20" }), { open: true });
  assert.throws(() => buildCandidate(loan, { transaction_type: "cash_out", schedule, as_of: D("2026-10-05") }), (e: unknown) => e instanceof RefiRefused && e.code === "cash_out_requires_borrower_request");
});

test("20.1-T5: Given the rule set references column `investor_id` (injected in a test build), then the static check fails and the run cannot start; given a `partner_programs.kind` whose product owner is SM, then `loadUniverse` refuses with `glba_use_violation`.", async () => {
  const events = store(); const ctx = ctxOf(events); const before = events.all().length;
  const injected = { ...SM_REFI_RULE_SET_V1, referenced_columns: [...SM_REFI_RULE_SET_V1.referenced_columns, "investor_id"] };
  assert.throws(() => staticCheckRuleSet(injected), (e: unknown) => e instanceof RefiRefused && e.code === "rule_set_static_check_failed" && /investor_id/.test(e.message));
  assert.throws(() => runOnce(events, { ...ctx, rule_set: injected }, [LOAN_A]), (e: unknown) => e instanceof RefiRefused && e.code === "rule_set_static_check_failed");
  assert.equal(events.all().length, before);                                                                                                     // the run did not start: no detection, no run_completed
  assert.throws(() => staticCheckRuleSet({ ...SM_REFI_RULE_SET_V1, referenced_columns: [...SM_REFI_RULE_SET_V1.referenced_columns, "census_tract"] }), (e: unknown) => e instanceof RefiRefused && e.code === "rule_set_static_check_failed");
  assert.deepEqual(staticCheckRuleSet(SM_REFI_RULE_SET_V1), { ok: true, columns: SM_REFI_RULE_SET_V1.referenced_columns.length });
  const smProgram = { ...DEFAULT_PROGRAM, program_id: "prog-sm-own", product_owner: "sm" as const };
  assert.throws(() => loadUniverse(smProgram, SM_REFI_RULE_SET_V1, [LOAN_A], {}, D("2026-10-01")), (e: unknown) => e instanceof RefiRefused && e.code === "glba_use_violation");
  assert.throws(() => runOnce(events, { ...ctx, program: smProgram }, [LOAN_A]), (e: unknown) => e instanceof RefiRefused && e.code === "glba_use_violation");
  const ok = loadUniverse(DEFAULT_PROGRAM, SM_REFI_RULE_SET_V1, [LOAN_A], {}, D("2026-10-01")); assert.equal(ok.purpose, "partner_program:prog-refi-partner-1"); assert.deepEqual(ok.included.map((l) => l.loan_id), ["L-565"]);
  assert.throws(() => loadUniverse(DEFAULT_PROGRAM, SM_REFI_RULE_SET_V1, [{ ...LOAN_A, fnma_loan_number: "1234567890" } as unknown as UniverseLoan], {}, D("2026-10-01")), (e: unknown) => e instanceof RefiRefused && e.code === "investor_field_visible");
  // the bus: investor fields refused at the tool boundary; the SM-owned program refused at registration
  const h = harness(ET("2026-10-01", "06:41")); h.seed([LOAN_A]);
  await assert.rejects(h.run("loadUniverse", { columns: ["investor_id"] }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_INVESTOR_FIELDS");
  await assert.rejects(h.run("loadUniverse", { credit_pull: true }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_CREDIT_PULL");
  await assert.rejects(h.run("loadUniverse", { op: "register_program", program: smProgram }), (e: unknown) => e instanceof RefiRefused && e.code === "glba_use_violation");
  await assert.rejects(h.run("loadUniverse", { op: "approve_rule_set" }), (e: unknown) => e instanceof CommandRefused && e.code === "OFFICER_APPROVES_RULE_SET");
  const u = await h.run("loadUniverse", {}); assert.deepEqual(u.included, ["L-565"]); assert.equal(u.investor_blind, true);
});

test("20.1-T6: Given a MA property with existing consummation 2023-02-06 and candidate consummation 2026-11-06, when `pi_delta_cents = 35634` and `borrower_paid_costs = 0`, then `MA_183_28C_BORROWER_INTEREST_60M` is satisfied with factors `[payment_reduction, rate_reduction]`; given instead `pi_delta_cents = 0` and no other factor, then the gate blocks and no offer issues.", () => {
  assert.equal(monthsBetween(D("2023-02-06"), D("2026-11-06")), 45);
  const d = borrowerInterestRule({ property_state: "MA", existing_consummation_date: D("2023-02-06"), candidate_consummation_date: D("2026-11-06"), rules: JURIS, pi_delta_cents: 35634n, borrower_paid_costs_cents: 0n, rate_delta_bps: 87.5 });
  assert.deepEqual(d, { applies: true, months_since_consummation: 45, pass: true, factors: ["payment_reduction", "rate_reduction"], rule: "M.G.L. c.183 §28C" });
  const h = harness(ET("2026-10-01", "06:41"));
  const ma: UniverseLoan = { ...LOAN_A, loan_id: "L-ma", property_state: "MA", county: "Worcester", consummation_date: D("2023-02-06"), note_date: D("2023-02-06"), title_date: D("2023-02-06"), first_payment_date: D("2023-04-01"), payments_made: 43, upb_cents: scheduledUpb(56500000n, "7.000", 360, 43), remaining_term_months: 317 };
  const r = evaluateLoan(h.events, { ...ctxOf(h.events), pricing: { ...ctxOf(h.events).pricing, cost_schedule: { ...COST_AZ, state: "MA" } } }, ma, NO_GATE_FACTS, { trigger_kind: "scheduled", path: "proactive" });
  assert.equal(r.opportunity.state_determination!.pass, true); assert.deepEqual(r.opportunity.state_determination!.factors, ["payment_reduction", "rate_reduction"]); assert.equal(r.opportunity.status, "offer_ready");
  const det = ofType(h.events, "refi.borrower_interest.determined")[0]!; assert.equal(det.payload.pass, true); assert.deepEqual(det.payload.factors, ["payment_reduction", "rate_reduction"]); assert.equal(det.payload.months_since_consummation, 45);
  const detected = ofType(h.events, "refi.opportunity.detected")[0]!; assert.equal(detected.payload.property_state, "MA"); assert.equal(detected.payload.borrower_interest_rule_applies, true);
  const t = h.timers.byCode("MA_183_28C_BORROWER_INTEREST_60M").at(-1)!; assert.equal(t.anchorDate, "2023-02-06"); assert.equal(t.status, "satisfied");
  assert.equal(r.opportunity.gates.find((g) => g.code === "MA_183_28C_BORROWER_INTEREST_60M")!.status, "open");
  // no payment reduction and no other factor: the gate blocks and no offer issues
  const none = borrowerInterestRule({ property_state: "MA", existing_consummation_date: D("2023-02-06"), candidate_consummation_date: D("2026-11-06"), rules: JURIS, pi_delta_cents: 0n, borrower_paid_costs_cents: 0n, rate_delta_bps: 0 });
  assert.deepEqual([none.applies, none.pass, none.factors], [true, false, []]);
  assert.equal(EVALUATORS_20_1["20.1.borrowerInterestGate"]!({ pass: false }).open, false); assert.equal(EVALUATORS_20_1["20.1.borrowerInterestGate"]!({ property_state: "MA", existing_consummation_date: "2023-02-06", candidate_consummation_date: "2026-11-06", pi_delta_cents: "0", borrower_paid_costs_cents: "0", rate_delta_bps: 0 }).open, false);
  const gates = checkGates({ path: "proactive", transaction_type: "limited_cash_out", as_of: D("2026-10-01"), program: DEFAULT_PROGRAM, facts: NO_GATE_FACTS, loan: ma, schedule: defaultSchedule(D("2026-10-01")), state_determination: none });
  assert.throws(() => assertGateOpen(gates, "MA_183_28C_BORROWER_INTEREST_60M"), (e: unknown) => e instanceof RefiRefused && e.code === "gate_closed:MA_183_28C_BORROWER_INTEREST_60M");
  const fire = fireRule({ rate_delta_bps: 87.5, npv_cents: 2429278n, seven_year_total_cost_delta_cents: 2243654n, lifetime_interest_delta_cents: -4496095n, same_term_npv_cents: 1n }, DEFAULT_PROGRAM, { prescreen_ok: true, state_rule_ok: none.pass, suppression_reasons: [] });
  assert.equal(fire.fire, false); assert.deepEqual(fire.reasons, ["state_rule_failed"]);
  // outside the 60-month window the rule does not apply
  assert.equal(borrowerInterestRule({ property_state: "MA", existing_consummation_date: D("2021-02-06"), candidate_consummation_date: D("2026-11-06"), rules: JURIS, pi_delta_cents: 0n, borrower_paid_costs_cents: 0n, rate_delta_bps: 0 }).applies, false);
});

test("20.1-T7: Given a loan `declined` on 2026-10-09, then proactive detection on 2026-12-15 is suppressed (`cooldown` until 2027-01-07) and a borrower request on 2026-12-15 proceeds.", () => {
  const h = harness(ET("2026-10-01", "06:41")); const first = runOnce(h.events, ctxOf(h.events), [LOAN_A]).opportunities[0]!;
  const offered = recordOffered(h.events, first, touchSent(h.events, first, ET("2026-10-02", "09:00"))).opportunity;
  const declined = declineOpportunity(h.events, offered, { declined_at: ET("2026-10-09", "14:00"), reason: "borrower says no" });
  assert.equal(declined.opportunity.status, "declined"); assert.equal(declined.cooldown_until, "2027-01-07"); assert.equal(declined.event.payload.declined_on, "2026-10-09");
  const t = h.timers.byCode("SM_REFI_RESOLICIT_COOLDOWN_90").at(-1)!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-09"); assert.equal(t.note, "evaluator:20.1.resolicitCooldownGate");
  const facts: GateFacts = { fnma_purchase_date: null, declined_on: D("2026-10-09"), offered_at: [ET("2026-10-02", "09:00")] };
  assert.deepEqual(resolicitCooldownGate({ declined_on: D("2026-10-09"), as_of: D("2026-12-15") }), { open: false, opens_on: "2027-01-07", reason: "cooldown after the 2026-10-09 decline: opens 2027-01-07" });
  assert.equal(EVALUATORS_20_1["20.1.resolicitCooldownGate"]!({ declined_on: "2026-10-09", as_of: "2026-12-15" }).open, false); assert.deepEqual(EVALUATORS_20_1["20.1.resolicitCooldownGate"]!({ declined_on: "2026-10-09", as_of: "2027-01-07" }), { open: true });
  h.at(ET("2026-12-15", "06:41", "-05:00")); const dec = ctxOf(h.events, { as_of: "2026-12-15", at: ET("2026-12-15", "06:41", "-05:00"), sheet: SHEET(h.events, "2026-12-15", "-05:00"), run_id: "run-2026-12-15" });
  const r = runOnce(h.events, dec, [LOAN_A], { "L-565": facts });
  assert.equal(r.opportunities[0]!.status, "suppressed"); assert.deepEqual(r.opportunities[0]!.suppression_reasons, ["cooldown"]); assert.equal(r.run.suppressed_by_reason.cooldown, 1);
  const sup = ofType(h.events, "refi.opportunity.suppressed").at(-1)!; assert.equal(sup.payload.reason, "cooldown"); assert.equal(sup.payload.opens_on, "2027-01-07");
  const req = requestOpportunity(h.events, { ...dec, run_id: null }, LOAN_A, facts, { requested_at: ET("2026-12-15", "10:00", "-05:00"), free_text: "can I refinance?" });
  assert.equal(req.opportunity.status, "offer_ready"); assert.equal(req.opportunity.trigger_kind, "borrower_request"); assert.equal(req.escalation, null);           // the request path bypasses the cooldown
  assert.equal(req.opportunity.gates.find((g) => g.code === "SM_REFI_RESOLICIT_COOLDOWN_90")!.status, "not_applicable");
});

test("20.1-T8: Given `lifetime_interest_delta_cents > 0` for the 30-year candidate but the same-remaining-term candidate has `npv > 0`, then `offer_ready` with `present_same_term_first=true`; given both ≤ 0, then no offer.", () => {
  const gates = { prescreen_ok: true, state_rule_ok: true, suppression_reasons: [] };
  const reset = fireRule({ rate_delta_bps: 50, npv_cents: 1500000n, seven_year_total_cost_delta_cents: 800000n, lifetime_interest_delta_cents: 2500000n, same_term_npv_cents: 400000n }, DEFAULT_PROGRAM, gates);
  assert.deepEqual(reset, { fire: true, present_same_term_first: true, reasons: [] });
  const none = fireRule({ rate_delta_bps: 50, npv_cents: 1500000n, seven_year_total_cost_delta_cents: 800000n, lifetime_interest_delta_cents: 2500000n, same_term_npv_cents: 0n }, DEFAULT_PROGRAM, gates);
  assert.equal(none.fire, false); assert.equal(none.present_same_term_first, false); assert.deepEqual(none.reasons, ["lifetime_interest_delta > 0 and same_term_npv ≤ 0"]);
  const neither = fireRule({ rate_delta_bps: 50, npv_cents: 0n, seven_year_total_cost_delta_cents: 0n, lifetime_interest_delta_cents: 2500000n, same_term_npv_cents: -100n }, DEFAULT_PROGRAM, gates);
  assert.equal(neither.fire, false); assert.deepEqual(neither.reasons, ["npv_cents 0 ≤ 0", "seven_year_total_cost_delta ≤ 0", "lifetime_interest_delta > 0 and same_term_npv ≤ 0"]);
  // the fixture saves interest even with the 24-month reset: no same-term-first requirement
  assert.deepEqual(fireRule({ rate_delta_bps: 87.5, npv_cents: 2429278n, seven_year_total_cost_delta_cents: 2243654n, lifetime_interest_delta_cents: -4496095n, same_term_npv_cents: 1840000n }, DEFAULT_PROGRAM, gates), { fire: true, present_same_term_first: false, reasons: [] });
  assert.equal(fireRule({ rate_delta_bps: 24.9, npv_cents: 1n, seven_year_total_cost_delta_cents: 1n, lifetime_interest_delta_cents: -1n, same_term_npv_cents: 1n }, DEFAULT_PROGRAM, gates).fire, false);   // 25 bps floor (open question 2)
  // through the pipeline: a 20-year-remaining loan reset to 30 years costs more over the full term, the same-term alternative carries the offer
  const events = store(); const loan: UniverseLoan = { ...LOAN_A, loan_id: "L-reset", note_date: D("2016-09-18"), consummation_date: D("2016-09-18"), title_date: D("2016-09-18"), first_payment_date: D("2016-11-01"), payments_made: 120, upb_cents: scheduledUpb(56500000n, "7.000", 360, 120), remaining_term_months: 240 };
  const r = evaluateLoan(events, ctxOf(events), loan, NO_GATE_FACTS, { trigger_kind: "scheduled", path: "proactive" }); const m = r.opportunity.benefit_metrics!;
  assert.ok(m.lifetime_interest_delta_cents > 0n); assert.ok(m.same_term_npv_cents > 0n); assert.equal(r.opportunity.status, "offer_ready"); assert.equal(r.opportunity.present_same_term_first, true);
  assert.equal(ofType(events, "refi.opportunity.offer_ready")[0]!.payload.present_same_term_first, true); assert.match(r.opportunity.explanation_text, /^Over the same 240 months you have left/);
});

test("20.1-T9: Given LTV estimate 0.9620 on a 1-unit principal residence, then `requires_fnma_ownership_check=true`, no Loan Lookup call before `engaged`, and a Loan Lookup call after `engaged` records `fnma_owned` without altering any earlier selection.", () => {
  const events = store(); const loan: UniverseLoan = { ...LOAN_A, loan_id: "L-hi-ltv", value_estimate: { ...LOAN_A.value_estimate, value_cents: 58212000n } };
  const built = buildCandidate(loan, { as_of: D("2026-10-01") }); assert.equal(built.candidate.ltv, "0.9620"); assert.equal(built.prescreen.requires_fnma_ownership_check, true); assert.equal(built.prescreen.ltv_ok, true); assert.equal(built.prescreen.fnma_owned, null);
  let calls = 0; const port = { lookup: (_id: string) => { calls++; return { owned: true, checked_at: ET("2026-10-05", "09:00") }; } };
  const r = evaluateLoan(events, ctxOf(events), loan, NO_GATE_FACTS, { trigger_kind: "scheduled", path: "proactive" });
  assert.equal(r.opportunity.status, "offer_ready"); assert.equal(r.opportunity.eligibility_prescreen!.requires_fnma_ownership_check, true); assert.equal(calls, 0);   // selection never called Loan Lookup
  assert.throws(() => fnmaOwnershipCheck(events, r.opportunity, port, ET("2026-10-02", "09:00")), (e: unknown) => e instanceof RefiRefused && e.code === "lookup_before_engaged"); assert.equal(calls, 0);
  const offered = recordOffered(events, r.opportunity, touchSent(events, r.opportunity, ET("2026-10-02", "09:00"))).opportunity;
  assert.throws(() => fnmaOwnershipCheck(events, offered, port, ET("2026-10-03", "09:00")), RefiRefused); assert.equal(calls, 0);
  const engaged = engageOpportunity(events, offered, leadCreated(events, offered, ET("2026-10-05", "08:40", "-07:00"))).opportunity; assert.equal(engaged.status, "engaged"); assert.equal(engaged.lead_id, "lead-L-hi-ltv");
  const selectionBefore = JSON.stringify({ c: engaged.candidate_terms, m: engaged.benefit_metrics, g: engaged.gates, s: engaged.suppression_reasons }, (_k, v) => (typeof v === "bigint" ? String(v) : v));
  const checked = fnmaOwnershipCheck(events, engaged, port, ET("2026-10-05", "09:00", "-07:00"));
  assert.equal(calls, 1); assert.equal(checked.opportunity.eligibility_prescreen!.fnma_owned, true); assert.equal(checked.event.type, "refi.opportunity.fnma_ownership.recorded"); assert.equal(checked.event.payload.selection_unchanged, true);
  assert.equal(JSON.stringify({ c: checked.opportunity.candidate_terms, m: checked.opportunity.benefit_metrics, g: checked.opportunity.gates, s: checked.opportunity.suppression_reasons }, (_k, v) => (typeof v === "bigint" ? String(v) : v)), selectionBefore);
  assert.throws(() => fnmaOwnershipCheck(events, { ...engaged, eligibility_prescreen: { ...engaged.eligibility_prescreen!, requires_fnma_ownership_check: false } }, port, ET("2026-10-05", "09:01", "-07:00")), (e: unknown) => e instanceof RefiRefused && e.code === "lookup_not_required");
  assert.equal(calls, 1);
});

test("20.1-T10: Given two runs on the same `as_of_date`, then exactly one `refi_opportunities` row per loan exists (idempotency) and the fair-lending extract is written once.", async () => {
  const events = store(); const ctx = ctxOf(events); const loans = [LOAN_A, { ...LOAN_A, loan_id: "L-566" }];
  const first = runOnce(events, ctx, loans); assert.equal(first.extract_written, true); assert.equal(first.opportunities.length, 2);
  const second = runOnce(events, { ...ctx, run_id: "run-2026-10-01-b", at: ET("2026-10-01", "11:00") }, loans, {}, first.opportunities, [first.extract]);
  assert.equal(second.extract_written, false); assert.deepEqual(second.reused.sort(), first.opportunities.map((o) => o.opportunity_id).sort()); assert.equal(second.run.loans_evaluated, 0);
  assert.equal(new Set([...first.opportunities, ...second.opportunities].map((o) => `${o.loan_id}|${o.as_of_date}|${o.program_id}`)).size, 2);
  assert.equal(ofType(events, "refi.fair_lending_extract.written").length, 1); assert.equal(ofType(events, "refi.opportunity.offer_ready").length, 2); assert.equal(ofType(events, "refi.trigger.run_completed").length, 2);
  assert.equal(first.extract.document_id, "fle-prog-refi-partner-1-2026-10-01"); assert.equal(first.extract.universe, 2); assert.equal(first.extract.offers, 2); assert.equal(first.extract.access_log, "applicant_demographics");
  // through the bus: the store holds one refi_opportunities row per loan and one extract after two runs
  const h = harness(ET("2026-10-01", "06:41")); h.seed(loans);
  const a = await h.run("emitOfferReady", { op: "run", run_id: "run-a" }); assert.equal(a.extract_written, true); assert.equal((a.opportunities as unknown[]).length, 2);
  h.at(ET("2026-10-01", "11:00")); const b = await h.run("emitOfferReady", { op: "run", run_id: "run-b" }); assert.equal(b.extract_written, false); assert.equal((b.reused as string[]).length, 2);
  assert.equal(h.rt.store.list("refi_opportunities").length, 2); assert.equal(h.rt.store.list("fair_lending_extracts").length, 1); assert.equal(h.rt.store.list("refi_trigger_runs").length, 2);
  const again = await h.run("writeFairLendingExtract", { run_id: "run-b" }); assert.equal(again.written, false);
  await assert.rejects(h.run("emitOfferReady", { op: "run", run_id: "run-c", send: true }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_BORROWER_CONTACT");
});

test("20.1-T11: Given the fixture $560,000 at 6.125%, then the engine's P&I is $3,402.62 and a test asserting $3,402.63 fails with the formula trace.", () => {
  const ok = assertPi(56000000n, "6.125", 360, 340262n);
  assert.equal(ok.pi_cents, 340262n); assert.match(ok.trace, /^P&I = L × r\/12 ÷ \(1 − \(1 \+ r\/12\)\^−n\) = \$560,000\.00 × 6\.125%\/12 ÷ \(1 − \(1 \+ 0\.0051041667\)\^−360\) = 3402\.6190 → round_half_up = \$3,402\.62$/);
  assert.throws(() => assertPi(56000000n, "6.125", 360, 340263n), (e: unknown) => e instanceof RefiRefused && e.code === "pi_mismatch" && /asserted \$3,402\.63 does not reproduce: P&I = L × r\/12 ÷ \(1 − \(1 \+ r\/12\)\^−n\) .* 3402\.6190 → round_half_up = \$3,402\.62/.test(e.message));
  assert.equal(levelPayment(56000000n, ratePercent("6.125"), 360), 340262n);                                                                     // verified requirement, discrepancy 5: $3,402.62, not $3,402.63
});

test("20.1 worked figures: existing P&I $3,758.96, UPB after 24 payments $553,106.41, per diem $106.08, payoff $554,273.29, cash to borrower $3,941.28, new P&I $3,402.62 (Δ $356.34), same-term $3,488.97 (Δ $269.99), remaining interest $709,904.15 vs $664,943.20 (−$44,960.95) and $612,293.92 (−$97,610.23), NPV $24,292.78, balances $495,596.33 vs $503,092.35 (−$7,496.02), seven-year delta $22,436.54", () => {
  assert.equal(levelPayment(56500000n, ratePercent("7.000"), 360), 375896n);
  assert.equal(scheduledUpb(56500000n, "7.000", 360, 24), 55310641n);
  assert.equal(perDiem365(55310641n, "7.000"), 10608n);
  const payoff = payoffEstimate(LOAN_A, D("2026-11-12")); assert.deepEqual([payoff.days, payoff.payoff_cents], [11, 55427329n]);
  const built = buildCandidate(LOAN_A, { as_of: D("2026-10-01") }); const events = store();
  const priced = priceCandidate(events, ctxOf(events).pricing, LOAN_A, built.candidate, { run_id: "wf", quoted_at: ET("2026-10-01", "06:41") });
  assert.equal(priced.candidate.loan_amount_cents, 56000000n); assert.equal(priced.candidate.prepaid_interest_cents, 178543n); assert.equal(priced.candidate.cash_back_cents, 394128n);   // 560,000.00 − 554,273.29 − 1,785.43
  assert.equal(priced.candidate.pi_cents, 340262n); assert.equal(priced.quote.llpa_cents, 70000n); assert.equal(priced.quote.lender_credit_cents, 70000n);
  const m = computeBenefit(LOAN_A, priced.candidate, priced.quote, DEFAULT_PROGRAM);
  assert.equal(m.pi_delta_cents, 35634n); assert.equal(m.same_term_pi_cents, 348897n); assert.equal(m.same_term_pi_delta_cents, 26999n);
  assert.equal(remainingInterest(375896n, 336, 55310641n), 70990415n); assert.equal(m.existing_remaining_interest_cents, 70990415n);
  assert.equal(m.new_lifetime_interest_cents, 66494320n); assert.equal(m.lifetime_interest_delta_cents, -4496095n);
  assert.equal(m.same_term_lifetime_interest_cents, 61229392n); assert.equal(m.same_term_lifetime_interest_delta_cents, -9761023n);
  assert.equal(npvOfDelta(35634n, "0.06125", 84), 2429278n); assert.equal(m.npv_cents, 2429278n);
  assert.equal(balanceAfter(55310641n, "7.000", 375896n, 84), 49559633n); assert.equal(balanceAfter(56000000n, "6.125", 340262n, 84), 50309235n);
  assert.deepEqual([m.existing_balance_at_h_cents, m.new_balance_at_h_cents, m.balance_delta_at_h_cents], [49559633n, 50309235n, -749602n]);
  assert.equal(m.seven_year_total_cost_delta_cents, 2243654n); assert.equal(m.seven_year_total_cost_delta_cents, (84n * 375896n + 49559633n) - (84n * 340262n + 50309235n));
});
