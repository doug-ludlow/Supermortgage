// 32.14 DELTA-11 / DELTA-13 — the anonymous minute on the 20.3 lead: the rule-6 facts (setFact), the published range as an
// advertisement through 20.2's checklist (rangeAdvertisement / showRange), the party link and the deferred intent, and the three
// 32.14 bus tools (src/app/tools/section32-14.ts) with their refusals. node:test, in memory, no database; the T-ids themselves
// live in src/domain/borrower/32-14.spec.test.ts (API level) — this file is the domain/tool coverage behind them.
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
import { TOOLS_20_3 } from "../../app/tools/section20-3.ts";
import { TOOLS_32_14, EntryRefused, stepCard, USPS_STATES } from "../../app/tools/section32-14.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { type RateSheet, publishRateSheet } from "./ops-20-4.ts";
import { newLicense, type LicenseRequirement, type MloRosterMember } from "../governance/ops-31-1.ts";
import { type Lead, IntakeRefused, createLead, startInteraction, deliverDisclosure, closeLead, setFact, linkParty, deferIntent, showRange, rangeAdvertisement, nextEntryStep, entryFacts, l0ProhibitedKeys, transactionTypeOf, L0_PROHIBITED_FACTS, ENTRY_STEPS, GOAL_TRANSACTION_TYPES, PROGRAM_MAX_LTV_PCT, RANGE_REPRESENTATIVE_LOAN_CENTS } from "./ops-20-3.ts";

const INTAKE: Actor = { kind: "agent", id: "intake" };
const APP: Actor = { kind: "agent", id: "borrower-app" };
const NOW = "2026-10-05T15:41:00.000Z";   // Mon Oct 5, 2026 08:41 MST / 11:41 EDT — inside SHEET_A's 06:35–17:00 ET window
const ET = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-04:00`).toISOString();
const ofType = (events: MemoryEventStore, type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
const leadEvents = (events: MemoryEventStore, lead_id: string): DomainEvent[] => events.all().filter((e) => e.aggregate?.kind === "lead" && e.aggregate.id === lead_id);
const rejectsCode = (code: string) => (e: unknown): boolean => (e instanceof CommandRefused || e instanceof EntryRefused || e instanceof IntakeRefused) && (e as { code: string }).code === code;

/** 20.4 worked example A's Oct 5 sheet: five FRM30 rows 5.875–6.375. */
const SHEET_A = (events: MemoryEventStore): RateSheet => publishRateSheet(events, { rate_sheet_id: "rs-2026-10-05", partner_id: "partner-1", source: "pe_whole_loan_api", published_at: ET("2026-10-05", "06:35"), expires_at: ET("2026-10-05", "17:00"), published_by: "agent:pricing", prices: ([["6.375", "101.875"], ["6.250", "101.375"], ["6.125", "100.875"], ["6.000", "100.375"], ["5.875", "99.750"]] as [string, string][]).map(([r, p]) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 45, price: p })) }).sheet;
/** 31.1 readiness rows that open a state: the partner's lender licence in good standing, a verified matrix (lend + no SM processing credential), an assignable MLO. A state with no rows is `matrix_unverified` and closed (fail-closed). */
const req = (st: string, applies_to: "partner" | "sm", activity: LicenseRequirement["activity"], kind: LicenseRequirement["requirement_kind"], code: string | null): LicenseRequirement =>
  ({ requirement_id: `R-${st}-${applies_to}-${activity}`, jurisdiction: st, activity, applies_to, requirement_kind: kind, license_type_code: code, citation: `${st} statute`, quoted_text: "…", verification_status: "verified", verified_at: D("2026-09-11"), verified_by: "u-counsel", source_url: null, effective_from: D("2026-09-11"), superseded_by: null });
function seedReadiness(rt: ToolRuntime, states: readonly string[], now: string): void {
  for (const st of states) {
    for (const r of [req(st, "partner", "lend", "license", `${st}_MORTGAGE_BANKER`), req(st, "sm", "processing_underwriting_entity", "none", null)]) rt.store.put("license_requirements", r.requirement_id, { ...r }, INTAKE, now);
    const l = newLicense({ license_id: `L-${st}-PARTNER`, holder_kind: "partner_company", holder_ref: "partner-1", jurisdiction: st, license_type_code: `${st}_MORTGAGE_BANKER`, activity_scope: ["lend"], status: "approved", issued_at: D("2026-01-15"), expires_at: D("2026-12-31"), evidence_document_id: "DOC-LIC", nmls_status_raw: "Approved" });
    rt.store.put("licenses", l.license_id, { ...l }, INTAKE, now);
  }
  const m: MloRosterMember = { mlo_id: "M-LEE", person_id: "p-lee", name: "A. Lee", nmls_id: "222333", employer: "partner", sponsor_license_id: "L-AZ-PARTNER", state_licenses: [], states_assignable: [...states], lo_comp_plan_id: null, capacity_per_day: 10, status: "active", assignable: true, open_queue: 0 };
  rt.store.put("mlo_roster", m.mlo_id, { ...m }, INTAKE, now);
}
const OPEN_STATES = ["AZ", "CO", "UT", "CA"];

/** Events + the overridden registry (20.3 and the rows it references), the 20.3 and 32.14 tools on one bus over one in-memory runtime. */
function harness(nowIso = NOW) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["20.3", "20.4", "21.1", "21.2", "21.6", "31.1"] });
  const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); rt.services["agents"] = agents;
  const cmds = bindTools(rt, agents, [...TOOLS_20_3, ...TOOLS_32_14]); const bus = new CommandBus(agents);
  const run = async (process: string, name: string, input: ToolInput, actor: Actor = process === "20.3" ? INTAKE : APP): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey(process, name))!, actor, input, uow)).output as Record<string, unknown>;
  const lead = (id: string): Lead => rt.store.require("leads", id).data as unknown as Lead;
  const sheet = SHEET_A(events); rt.store.put("rate_sheets", sheet.rate_sheet_id, sheet as unknown as Record<string, unknown>, INTAKE, nowIso);
  seedReadiness(rt, OPEN_STATES, nowIso);
  return { rt, uow, events, timers, decisions, run, lead, sheet, clock };
}
type H = ReturnType<typeof harness>;
/** S0 through the 20.3 tools: the organic lead, the AI web-chat interaction, the disclosure delivered and logged before anything else. */
async function organicLead(h: H, lead_id = "lead-entry-1", over: Record<string, unknown> = {}): Promise<string> {
  await h.run("20.3", "deliverDisclosure", { op: "create", lead_id, partner_id: "partner-1", partner_name: "Partner Bank", channel: "organic", time_zone: "America/Phoenix", ...over });
  await h.run("20.3", "deliverDisclosure", { op: "start", lead_id, interaction_id: `${lead_id}:i-1`, channel: "web_chat", ai: true });
  await h.run("20.3", "deliverDisclosure", { lead_id, interaction_id: `${lead_id}:i-1`, notice_id: "n-disc-1" });
  return lead_id;
}
/** The refi path's four chips through lead.answer (goal → occupancy → state → estimate). */
async function refiChips(h: H, lead_id: string, state = "AZ"): Promise<Record<string, unknown>> {
  await h.run("32.14", "lead.answer", { lead_id, step: "goal", value: "lower_rate" });
  await h.run("32.14", "lead.answer", { lead_id, step: "occupancy", value: "primary" });
  const st = await h.run("32.14", "lead.answer", { lead_id, step: "state", value: state });
  if (st["closed"]) return st;
  return h.run("32.14", "lead.answer", { lead_id, step: "estimate", value: { value_estimate_cents: "80000000", stated_existing_balance_cents: "56000000" } });
}
const domainLead = (events: MemoryEventStore, id = "lead-d-1"): Lead => {
  let lead = createLead(events, { lead_id: id, partner_id: "partner-1", partner_name: "Partner Bank", channel: "organic", at: NOW, time_zone: "America/Phoenix" }).lead;
  lead = startInteraction(events, lead, { interaction_id: "i-1", channel: "web_chat", started_at: NOW, ai: true }).lead;
  return deliverDisclosure(events, lead, { interaction_id: "i-1", at: NOW, notice_id: "n-disc-1" }).lead;
};

// ---------------------------------------------------------------- the domain: setFact (rule 6), linkParty, deferIntent
test("setFact (20.3 rule 6 / 32.14 S1): the permitted chips write lead.goal.set (goal, then re-emitted with occupancy), lead.state.set and lead.estimate.set in the fixed order; every prohibited fact is L0_FACTS_ONLY and writes nothing", () => {
  const events = new MemoryEventStore(new FixedClock(NOW)); let lead = domainLead(events);
  assert.equal(nextEntryStep(lead), "goal"); assert.equal(transactionTypeOf(lead), null);
  const g = setFact(events, lead, { kind: "goal", transaction_intent: GOAL_TRANSACTION_TYPES.lower_rate }, NOW); lead = g.lead;
  assert.equal(g.event.type, "lead.goal.set"); assert.equal(g.event.payload["transaction_intent"], "limited_cash_out"); assert.equal(g.event.payload["step"], "goal"); assert.equal(g.next_step, "occupancy");
  const o = setFact(events, lead, { kind: "occupancy", occupancy: "primary" }, NOW); lead = o.lead;
  assert.equal(o.event.type, "lead.goal.set"); assert.equal(o.event.payload["occupancy"], "primary"); assert.equal(o.event.payload["step"], "occupancy"); assert.equal(o.next_step, "state");
  const s = setFact(events, lead, { kind: "state", consumer_state: "az" }, NOW); lead = s.lead;
  assert.equal(s.event.type, "lead.state.set"); assert.equal(s.event.payload["consumer_state"], "AZ"); assert.equal(lead.consumer_state, "AZ"); assert.equal(lead.property_state, "AZ"); assert.equal(s.next_step, "estimate");
  const e = setFact(events, lead, { kind: "estimate", value_estimate_cents: "80000000", stated_existing_balance_cents: 56_000_000n }, NOW); lead = e.lead;
  assert.equal(e.event.type, "lead.estimate.set"); assert.equal(e.event.payload["value_estimate_cents"], "80000000"); assert.equal(e.event.payload["stated_existing_balance_cents"], "56000000"); assert.equal(e.event.payload["max_ltv_pct"], 97); assert.equal(e.event.payload["counted_as_trid_item"], false);
  assert.equal(e.next_step, null); assert.equal(lead.value_estimate_cents, 80_000_000n);
  assert.deepEqual(entryFacts(lead), { transaction_type: "limited_cash_out", contract_status: null, occupancy: "primary", consumer_state: "AZ", value_estimate_cents: "80000000", stated_existing_balance_cents: "56000000", price_range_cents: null, down_payment_cents: null, next_step: null });
  // the six items never counted: no trid_items touched by any chip
  assert.equal(lead.trid_items.value_estimate.present, false); assert.equal(lead.trid_items.income.present, false);
  // rule 6: income, a name, an e-mail, a phone, an SSN, a demographic answer, marital status, citizenship, documents, military service — refused, nothing written
  const before = events.all().length;
  for (const kind of ["income", "name", "email", "phone", "ssn", "demographics", "race", "marital_status", "citizenship", "documents", "military_service", "date_of_birth", "loan_amount_sought", ""]) {
    assert.throws(() => setFact(events, lead, { kind, value: "x" } as unknown as Parameters<typeof setFact>[2], NOW), rejectsCode("L0_FACTS_ONLY"), kind || "(empty)");
    assert.ok(L0_PROHIBITED_FACTS.includes(kind) || kind === "" || !(ENTRY_STEPS as readonly string[]).includes(kind));
  }
  assert.equal(events.all().length, before, "a refused fact appends no event");
  // the guardrail's predicate sees the same set on the wire: a step outside the set, or a prohibited key inside fact / value
  assert.deepEqual(l0ProhibitedKeys({ step: "income", value: "178000" }), ["income"]);
  assert.deepEqual(l0ProhibitedKeys({ step: "estimate", value: { value_estimate_cents: "1", ssn: "123-45-6789" } }), ["ssn"]);
  assert.deepEqual(l0ProhibitedKeys({ fact: { kind: "goal", transaction_intent: "purchase" } }), []); assert.deepEqual(l0ProhibitedKeys({}), []);
});

test("setFact validation: contract status only on a Buy lead, occupancy after the goal, the estimate pair the goal implies (purchase: price + down payment; cash-out shows the 80% cap as a limit), a goal change clears its refinements; no fact before the disclosure; none on a closed lead", () => {
  const events = new MemoryEventStore(new FixedClock(NOW)); let lead = domainLead(events);
  assert.throws(() => setFact(events, lead, { kind: "contract", contract_status: "signed" }, NOW), RangeError);
  assert.throws(() => setFact(events, lead, { kind: "occupancy", occupancy: "primary" }, NOW), RangeError);
  assert.throws(() => setFact(events, lead, { kind: "estimate", value_estimate_cents: 1n, stated_existing_balance_cents: 0n }, NOW), RangeError);
  lead = setFact(events, lead, { kind: "goal", transaction_intent: "purchase" }, NOW).lead; assert.equal(nextEntryStep(lead), "contract");
  assert.throws(() => setFact(events, lead, { kind: "contract", contract_status: "maybe" as "signed" }, NOW), RangeError);
  const c = setFact(events, lead, { kind: "contract", contract_status: "looking" }, NOW); lead = c.lead; assert.equal(c.event.payload["contract_status"], "looking"); assert.equal(c.event.payload["step"], "contract"); assert.equal(nextEntryStep(lead), "state");
  lead = setFact(events, lead, { kind: "state", consumer_state: "TX" }, NOW).lead;
  assert.throws(() => setFact(events, lead, { kind: "estimate", value_estimate_cents: 80_000_000n, stated_existing_balance_cents: 0n }, NOW), /purchase estimate/);
  assert.throws(() => setFact(events, lead, { kind: "estimate", price_range_cents: 50_000_000n, down_payment_cents: 60_000_000n }, NOW), /between 0 and the price/);
  const e = setFact(events, lead, { kind: "estimate", price_range_cents: "50000000", down_payment_cents: "10000000" }, NOW); lead = e.lead;
  assert.equal(e.event.payload["price_range_cents"], "50000000"); assert.equal(e.event.payload["down_payment_cents"], "10000000"); assert.equal(e.event.payload["value_estimate_cents"], null); assert.equal(e.event.payload["max_ltv_pct"], 97); assert.equal(nextEntryStep(lead), null);
  // a goal change (cash out) clears the refinements and estimates; the cash-out estimate carries the 80% cap as a plain limit
  const g = setFact(events, lead, { kind: "goal", transaction_intent: "cash_out" }, NOW); lead = g.lead;
  assert.equal(lead.contract_status, null); assert.equal(lead.price_range_cents, null); assert.equal(nextEntryStep(lead), "occupancy");
  lead = setFact(events, lead, { kind: "occupancy", occupancy: "investment" }, NOW).lead;
  const co = setFact(events, lead, { kind: "estimate", value_estimate_cents: 80_000_000n, stated_existing_balance_cents: 70_000_000n }, NOW);
  assert.equal(co.event.payload["max_ltv_pct"], PROGRAM_MAX_LTV_PCT.cash_out); assert.equal(co.event.payload["max_ltv_pct"], 80);
  assert.equal(String(co.event.payload["stated_existing_balance_cents"]), "70000000", "an own-stated balance above the cap is recorded as stated — a limit, never a decline");
  // rule 1: no fact before the disclosure on an AI interaction
  let undisclosed = createLead(events, { lead_id: "lead-d-2", partner_id: "partner-1", partner_name: "Partner Bank", channel: "organic", at: NOW }).lead;
  undisclosed = startInteraction(events, undisclosed, { interaction_id: "i-1", channel: "web_chat", started_at: NOW, ai: true }).lead;
  assert.throws(() => setFact(events, undisclosed, { kind: "goal", transaction_intent: "purchase" }, NOW), rejectsCode("SM_AI_INTERACTION_DISCLOSURE_GATE"));
  // a closed lead takes no fact, no link, no deferral
  const closed = closeLead(events, domainLead(events, "lead-d-3"), { at: NOW, reason: "state_not_licensed" }).lead;
  assert.throws(() => setFact(events, closed, { kind: "goal", transaction_intent: "purchase" }, NOW), rejectsCode("LEAD_CLOSED"));
  assert.throws(() => linkParty(events, closed, { party_id: "p-1", at: NOW }), rejectsCode("LEAD_CLOSED"));
  assert.throws(() => deferIntent(events, closed, { at: NOW }), rejectsCode("LEAD_CLOSED"));
});

test("linkParty → lead.linked{party_id} (linked, never copied; never re-pointed to another party); deferIntent → intent.deferred{lead_id, status} with nothing ordered, pulled or converted", () => {
  const events = new MemoryEventStore(new FixedClock(NOW)); let lead = domainLead(events);
  const l = linkParty(events, lead, { party_id: "p-alex", at: NOW, method: "otp_phone", session_id: "s-1" }); lead = l.lead;
  assert.equal(l.event.type, "lead.linked"); assert.equal(l.event.payload["party_id"], "p-alex"); assert.equal(l.event.payload["lead_id"], lead.lead_id); assert.equal(lead.party_id, "p-alex"); assert.equal(lead.status, "disclosed", "the link changes no other field");
  assert.throws(() => linkParty(events, lead, { party_id: "p-other", at: NOW }), /linked to party p-alex/);
  const d = deferIntent(events, lead, { at: NOW });
  assert.equal(d.event.type, "intent.deferred"); assert.deepEqual([d.event.payload["ordered"], d.event.payload["pulled"], d.event.payload["document"]], [false, false, null]); assert.deepEqual(d.event.payload["clocks"], ["SM_LEAD_INACTIVITY_EXPIRY_90"]); assert.equal(d.lead.status, lead.status);
});

// ---------------------------------------------------------------- the range as an advertisement (32.14 S2, 20.3 rule 7, 20.2 §1026.24)
test("rangeAdvertisement: the sheet's FRM30 low–high with an APR beside each rate (20.4's APR on the representative loan when the rows carry none) and the not-a-commitment footer passes 20.2's checklist (regz_1026_24.apr_stated, not_a_commitment, the NMLS ID); no tier, LLPA or borrower figure; without the partner's NMLSR ID the checklist fails", () => {
  const events = new MemoryEventStore(new FixedClock(NOW)); const sheet = SHEET_A(events);
  const ad = rangeAdvertisement(sheet, { partner_name: "Partner Bank", partner_nmlsr_id: "123456", at: NOW, time_zone: "America/Phoenix" });
  assert.equal(ad.product_code, "FRM30"); assert.equal(ad.low_pct, "5.875"); assert.equal(ad.high_pct, "6.375"); assert.equal(ad.apr_source, "computed_representative_loan"); assert.equal(ad.representative_loan_cents, RANGE_REPRESENTATIVE_LOAN_CENTS);
  for (const apr of [ad.apr_low_pct, ad.apr_high_pct]) { assert.match(apr, /^\d\.\d{3}$/, "APR is a 3-decimal string, never a number"); }
  assert.ok(Math.abs(Number(ad.apr_low_pct) - 5.875) < 0.5 && Number(ad.apr_low_pct) >= 5.875, `APR ${ad.apr_low_pct} sits at or above its note rate on a no-point loan`);
  assert.ok(ad.text.includes(`5.875% (${ad.apr_low_pct}% APR)`) && ad.text.includes(`6.375% (${ad.apr_high_pct}% APR)`), ad.text);
  assert.match(ad.text, /30-year fixed rates for this program range from/); assert.match(ad.text, /not a commitment to lend; rates change daily/); assert.match(ad.text, /Partner Bank, NMLSR ID 123456\./); assert.match(ad.text, /representative loan with no points/);
  assert.equal(ad.checklist.regz_1026_24.apr_stated, true); assert.equal(ad.checklist.regz_1026_24.apr_term_used, true); assert.equal(ad.checklist.regz_1026_24.not_a_commitment, true); assert.equal(ad.checklist.regz_1026_24.d2_disclosures_present, true); assert.equal(ad.checklist.state.nmls_id_present, true); assert.equal(ad.checklist.fnma_b2_1_3_04.no_investor_reference, true); assert.equal(ad.checklist.map_1014_3.a_rate_accurate, true);
  assert.deepEqual(ad.failures, []); assert.equal(ad.passes, true); assert.equal(ad.personal_terms, false);
  // RANGE_IS_PUBLISHED: no tier, LLPA band, score or dollar figure in the creative; every stated rate is a sheet rate
  assert.doesNotMatch(ad.text, /\$|tier|LLPA|score|≥|–\d{3}%|Fannie|investor/i);
  const stated = [...ad.text.matchAll(/(\d\.\d{3})%(?! APR)/g)].map((m) => m[1]); assert.deepEqual(stated, ["5.875", "6.375"]); for (const r of stated) assert.ok(ad.sheet_rates_pct.includes(r));
  // the ordinary failure: no NMLSR ID → state.nmls_id_present false → the card is refused (RANGE_CONTENT_CHECK at the tool)
  const bad = rangeAdvertisement(sheet, { partner_name: "Partner Bank", partner_nmlsr_id: "", at: NOW });
  assert.equal(bad.passes, false); assert.ok(bad.failures.includes("state.nmls_id_present"), bad.failures.join(","));
  // a sheet whose rows carry an APR uses it verbatim and says so
  const withApr = rangeAdvertisement({ prices: sheet.prices.map((p) => ({ ...p, apr_pct: (Number(p.note_rate) * 100 + 0.02).toFixed(3) })) }, { partner_name: "Partner Bank", partner_nmlsr_id: "123456", at: NOW });
  assert.equal(withApr.apr_source, "sheet"); assert.equal(withApr.apr_low_pct, "5.895"); assert.match(withApr.text, /APR as published on the rate sheet in force/); assert.equal(withApr.passes, true);
  assert.throws(() => rangeAdvertisement(sheet, { product_code: "FRM15", partner_name: "Partner Bank", partner_nmlsr_id: "123456", at: NOW }), /no FRM15 prices/);
  // showRange logs it on the lead and refuses a lead a closed state ended
  let lead = domainLead(events); const shown = showRange(events, lead, { at: NOW, product_code: "FRM30", rate_sheet_id: sheet.rate_sheet_id, low_pct: ad.low_pct, high_pct: ad.high_pct, apr_low_pct: ad.apr_low_pct, apr_high_pct: ad.apr_high_pct, apr_source: ad.apr_source, checklist_run_id: "chk-1" });
  assert.equal(shown.event.type, "lead.range.shown"); assert.equal(shown.event.payload["rate_sheet_id"], "rs-2026-10-05"); assert.equal(shown.event.payload["checklist_run_id"], "chk-1"); assert.equal(shown.event.payload["personal_terms"], false); assert.equal(shown.event.payload["tier"], null);
  lead = closeLead(events, lead, { at: NOW, reason: "state_not_licensed" }).lead;
  assert.throws(() => showRange(events, lead, { at: NOW, product_code: "FRM30", rate_sheet_id: sheet.rate_sheet_id, low_pct: "5.875", high_pct: "6.375", apr_low_pct: "5.9", apr_high_pct: "6.4", apr_source: "sheet", checklist_run_id: "chk-2" }), rejectsCode("STATE_GATE_FIRST"));
});

// ---------------------------------------------------------------- the 32.14 tools on the bus
test("lead.answer: goal → occupancy → state (AZ open: licensing.gate.opened) → estimate, one 20.3 event per chip and the next-step card after each; STEP_ORDER, STATE_GATE_FIRST and L0_FACTS_ONLY refuse and write nothing on the lead", async () => {
  const h = harness(); const lead_id = await organicLead(h);
  const before = leadEvents(h.events, lead_id).map((e) => e.type); assert.deepEqual(before.slice(-2), ["lead.disclosure.delivered", "consent.granted"]);
  // out of order: occupancy before the goal, the estimate before the state
  await assert.rejects(h.run("32.14", "lead.answer", { lead_id, step: "occupancy", value: "primary" }), rejectsCode("STEP_ORDER"));
  const g = await h.run("32.14", "lead.answer", { lead_id, step: "goal", value: "lower_rate" });
  assert.equal(g["outcome"], "accepted"); assert.deepEqual(g["lines"], []); assert.equal((g["next_step"] as Record<string, unknown>)["id"], "occupancy"); assert.equal((g["next_step"] as Record<string, unknown>)["copy_key"], "entry.occupancy.question"); assert.equal((g["next_step"] as Record<string, unknown>)["preselected"], null);
  assert.equal((g["facts"] as Record<string, unknown>)["transaction_type"], "limited_cash_out");
  await assert.rejects(h.run("32.14", "lead.answer", { lead_id, step: "contract", value: "signed" }), rejectsCode("STEP_ORDER"));
  const o = await h.run("32.14", "lead.answer", { lead_id, step: "occupancy", value: "primary" }); assert.equal((o["next_step"] as Record<string, unknown>)["id"], "state"); assert.equal((o["next_step"] as Record<string, unknown>)["copy_key"], "entry.state.question"); assert.equal(((o["next_step"] as Record<string, unknown>)["options"] as unknown[]).length, 51);
  await assert.rejects(h.run("32.14", "lead.answer", { lead_id, step: "estimate", value: { value_estimate_cents: "80000000", stated_existing_balance_cents: "56000000" } }), rejectsCode("STATE_GATE_FIRST"));
  const s = await h.run("32.14", "lead.answer", { lead_id, step: "state", value: "az" });
  assert.equal(s["closed"], null); assert.deepEqual(s["lines"], []); assert.equal((s["next_step"] as Record<string, unknown>)["id"], "estimate"); assert.equal((s["next_step"] as Record<string, unknown>)["copy_key"], "entry.estimate.value");
  assert.equal(ofType(h.events, "licensing.gate.opened").length, 1); assert.equal(ofType(h.events, "licensing.gate.opened")[0]!.payload["state"], "AZ"); assert.equal(ofType(h.events, "licensing.gate.blocked").length, 0);
  const e = await h.run("32.14", "lead.answer", { lead_id, step: "estimate", value: { value_estimate_cents: "80000000", stated_existing_balance_cents: "56000000" } });
  assert.equal(e["next_step"], null); assert.equal(e["max_ltv_pct"], 97);
  assert.deepEqual(leadEvents(h.events, lead_id).map((x) => x.type).slice(before.length), ["lead.goal.set", "lead.goal.set", "lead.state.set", "lead.estimate.set"]);
  assert.equal(h.lead(lead_id).status, "disclosed"); assert.equal(h.lead(lead_id).party_id, null); assert.equal(h.lead(lead_id).assurance_level, "L0_contact_unverified");
  await assert.rejects(h.run("32.14", "lead.answer", { lead_id, step: "goal", value: "buy" }), rejectsCode("STEP_ORDER"));
  // 32.14 T6: income, a name, an SSN, a demographic answer, marital status, citizenship as a lead fact → L0_FACTS_ONLY (the guardrail), nothing written
  const count = leadEvents(h.events, lead_id).length; const snap = (l: Lead): string => JSON.stringify(l, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)); const snapshot = snap(h.lead(lead_id));
  for (const [step, value] of [["income", "178000"], ["name", "Alex Borrower"], ["ssn", "123-45-6789"], ["demographics", { race: "x" }], ["marital_status", "married"], ["citizenship", "us"], ["email", "a@b.c"], ["military_service", "yes"]] as [string, unknown][]) {
    await assert.rejects(h.run("32.14", "lead.answer", { lead_id, step, value }), (err: unknown) => err instanceof CommandRefused && err.code === "L0_FACTS_ONLY", step);
  }
  await assert.rejects(h.run("32.14", "lead.answer", { lead_id, step: "estimate", value: { value_estimate_cents: "1", income: "178000" } }), rejectsCode("L0_FACTS_ONLY"));
  await assert.rejects(h.run("20.3", "explainProgram", { op: "set_fact", lead_id, fact: { kind: "income", value: "178000" } }), rejectsCode("L0_FACTS_ONLY"));
  assert.equal(leadEvents(h.events, lead_id).length, count, "no lead event on a refused fact"); assert.equal(snap(h.lead(lead_id)), snapshot, "the stored lead is untouched");
  // a bad value is a BAD_REQUEST-shaped RangeError, never a TypeError; a bypass flag is the STATE_GATE_FIRST guardrail
  const fresh = await organicLead(h, "lead-entry-2");
  await assert.rejects(h.run("32.14", "lead.answer", { lead_id: fresh, step: "goal", value: "sell" }), RangeError);
  await assert.rejects(h.run("32.14", "lead.answer", { lead_id: fresh, step: "goal", value: "buy", bypass_state_gate: true }), rejectsCode("STATE_GATE_FIRST"));
  // every decision row names the lead id and the step (32.2's shape)
  const rows = h.decisions.filter((d) => String(d.action).startsWith("borrower.command:lead.answer"));
  assert.ok(rows.length >= 4); for (const d of rows) { assert.equal(d.subject?.kind, "lead"); assert.match(String(d.rationale), /lead_id=lead-entry-\d step=(goal|occupancy|state|estimate)/); }
});

test("lead.answer state NY (32.14 T3): licensing.gate.blocked{state=NY} is logged, the lead is closed_lost{reason=state_not_licensed}, the reply is the lead.state_closed line with no next step; lead.requestRange and any further chip refuse STATE_GATE_FIRST", async () => {
  const h = harness(); const lead_id = await organicLead(h);
  const r = await refiChips(h, lead_id, "NY");
  assert.deepEqual(r["closed"], { reason: "state_not_licensed", copy_key: "lead.state_closed", gate: "SM_LICENSE_STATE_GATE", state: "NY", readiness_reason: "matrix_unverified" });
  assert.equal(r["next_step"], null); const lines = r["lines"] as Record<string, unknown>[]; assert.equal(lines.length, 1); assert.equal(lines[0]!["copy_key"], "lead.state_closed"); assert.equal(lines[0]!["automation_marker"], true);
  const blocked = ofType(h.events, "licensing.gate.blocked"); assert.equal(blocked.length, 1); assert.equal(blocked[0]!.payload["state"], "NY"); assert.equal(blocked[0]!.payload["lead_id"], lead_id); assert.equal(blocked[0]!.payload["command"], "lead.answer");
  assert.equal(h.lead(lead_id).status, "closed_lost"); assert.equal(h.lead(lead_id).closed_reason, "state_not_licensed"); assert.equal(ofType(h.events, "lead.closed")[0]!.payload["reason"], "state_not_licensed");
  assert.equal(ofType(h.events, "lead.range.shown").length, 0);
  await assert.rejects(h.run("32.14", "lead.requestRange", { lead_id }), rejectsCode("STATE_GATE_FIRST"));
  await assert.rejects(h.run("32.14", "lead.answer", { lead_id, step: "estimate", value: { value_estimate_cents: "1", stated_existing_balance_cents: "0" } }), rejectsCode("STATE_GATE_FIRST"));
  await assert.rejects(h.run("32.14", "lead.proceed", { lead_id, choice: "not_yet" }), rejectsCode("STATE_GATE_FIRST"));
  // the range before any state is known is STATE_GATE_FIRST too
  const second = await organicLead(h, "lead-entry-2"); await h.run("32.14", "lead.answer", { lead_id: second, step: "goal", value: "cash_out" });
  await assert.rejects(h.run("32.14", "lead.requestRange", { lead_id: second }), rejectsCode("STATE_GATE_FIRST"));
});

test("lead.answer state CO / UT / CA (32.14 T2): CO → co_admt.preuse_notice.delivered before lead.range.shown; UT and CA → a second lead.disclosure.delivered{state_variant} before the next chip, as one appended entry.disclosure.first line", async () => {
  const h = harness();
  const co = await organicLead(h, "lead-co"); const rc = await refiChips(h, co, "CO");
  assert.equal(rc["closed"], null); assert.equal(rc["next_step"], null);
  await h.run("32.14", "lead.requestRange", { lead_id: co, partner_nmlsr_id: "123456" });
  const types = h.events.all().filter((e) => e.payload["lead_id"] === co || e.payload["application_id"] === co).map((e) => e.type);
  assert.ok(types.indexOf("co_admt.preuse_notice.delivered") >= 0 && types.indexOf("co_admt.preuse_notice.delivered") < types.indexOf("lead.range.shown"), types.join(" → "));
  assert.equal(ofType(h.events, "lead.disclosure.delivered").filter((e) => e.payload["lead_id"] === co).length, 1, "Colorado re-delivers no disclosure — its variant is the pre-use notice");
  assert.ok(h.lead(co).co_admt_preuse_notice_id);
  for (const [st, variant] of [["UT", "ut_high_risk_upfront"], ["CA", "ca_admt_preuse"]] as const) {
    const id = await organicLead(h, `lead-${st.toLowerCase()}`);
    await h.run("32.14", "lead.answer", { lead_id: id, step: "goal", value: "buy" }); await h.run("32.14", "lead.answer", { lead_id: id, step: "contract", value: "looking" });
    const s = await h.run("32.14", "lead.answer", { lead_id: id, step: "state", value: st });
    const lines = s["lines"] as Record<string, unknown>[]; assert.equal(lines.length, 1); assert.equal(lines[0]!["copy_key"], "entry.disclosure.first"); assert.equal(lines[0]!["state_variant"], variant); assert.equal(lines[0]!["reason"], "channel_change");
    const delivered = ofType(h.events, "lead.disclosure.delivered").filter((e) => e.payload["lead_id"] === id); assert.equal(delivered.length, 2); assert.equal(delivered[1]!.payload["state_variant"], variant); assert.equal(delivered[1]!.payload["reason"], "channel_change");
    assert.equal((s["next_step"] as Record<string, unknown>)["id"], "estimate", "the next chip follows the re-log"); assert.equal((s["next_step"] as Record<string, unknown>)["copy_key"], "entry.estimate.price_range");
  }
});

test("lead.requestRange (32.14 T4): lead.range.shown carries the sheet's FRM30 low and high, an APR beside each rate, the product, the sheet id and the checklist run; the StatusCard is entry.range.card with personal_terms=false and the identity ask follows; RANGE_IS_PUBLISHED refuses a tier; a failing checklist answers range=null + RANGE_CONTENT_CHECK with the identity ask and no lead.range.shown", async () => {
  const h = harness(); const lead_id = await organicLead(h); await refiChips(h, lead_id, "AZ");
  await assert.rejects(h.run("32.14", "lead.requestRange", { lead_id, tier: "≥780" }), (e: unknown) => e instanceof CommandRefused && e.code === "RANGE_IS_PUBLISHED");
  await assert.rejects(h.run("32.14", "lead.requestRange", { lead_id, personal_terms: true }), rejectsCode("RANGE_IS_PUBLISHED"));
  // the checklist fails without the partner's NMLSR ID: no number, the identity ask still renders, nothing logged as shown
  const refused = await h.run("32.14", "lead.requestRange", { lead_id });
  assert.equal(refused["outcome"], "refused"); assert.equal(refused["refused"], "RANGE_CONTENT_CHECK"); assert.equal(refused["range"], null); assert.ok((refused["failures"] as string[]).includes("state.nmls_id_present")); assert.equal((refused["next"] as Record<string, unknown>)["copy_key"], "auth.choose_method");
  assert.equal(ofType(h.events, "lead.range.shown").length, 0); assert.equal(h.rt.store.list("content_checklist_runs").length, 1);
  const r = await h.run("32.14", "lead.requestRange", { lead_id, partner_nmlsr_id: "123456" });
  assert.equal(r["outcome"], "accepted"); const range = r["range"] as Record<string, unknown>;
  assert.equal(range["product_code"], "FRM30"); assert.equal(range["low_pct"], "5.875"); assert.equal(range["high_pct"], "6.375"); assert.equal(range["rate_sheet_id"], "rs-2026-10-05"); assert.equal(typeof range["checklist_run_id"], "string");
  assert.match(String(range["apr_low_pct"]), /^\d\.\d{3}$/); assert.match(String(range["apr_high_pct"]), /^\d\.\d{3}$/); assert.match(String(range["text"]), /not a commitment to lend/); assert.match(String(range["text"]), /NMLSR ID 123456/);
  assert.deepEqual(r["card"], { kind: "StatusCard", copy_key: "entry.range.card", personal_terms: false, copy_tokens: { low_pct: "5.875", high_pct: "6.375", apr_low_pct: range["apr_low_pct"], apr_high_pct: range["apr_high_pct"], product: "30-year fixed", "partner.legal_name": "Partner Bank", "partner.nmlsr_id": "123456" } });
  assert.equal(r["promise_copy_key"], "entry.range.promise"); assert.equal(r["disclaimer_copy_key"], "entry.range.disclaimer"); assert.deepEqual(r["next"], { id: "identify", kind: "ChoiceCard", copy_key: "auth.choose_method", options: [{ id: "sms" }, { id: "email" }, { id: "google" }] });
  const shown = ofType(h.events, "lead.range.shown"); assert.equal(shown.length, 1);
  assert.deepEqual({ low: shown[0]!.payload["low_pct"], high: shown[0]!.payload["high_pct"], product: shown[0]!.payload["product_code"], sheet: shown[0]!.payload["rate_sheet_id"], run: shown[0]!.payload["checklist_run_id"], personal: shown[0]!.payload["personal_terms"] }, { low: "5.875", high: "6.375", product: "FRM30", sheet: "rs-2026-10-05", run: range["checklist_run_id"], personal: false });
  assert.equal(shown[0]!.payload["apr_low_pct"], range["apr_low_pct"]); assert.equal(shown[0]!.payload["apr_high_pct"], range["apr_high_pct"]);
  const run = h.rt.store.require("content_checklist_runs", String(range["checklist_run_id"])).data; assert.equal((run["checklist"] as { regz_1026_24: { apr_stated: boolean } }).regz_1026_24.apr_stated, true); assert.equal(run["passes"], true);
  assert.equal(h.lead(lead_id).party_id, null, "no session, no party — the range lives on the lead");
  // the Buy path: contract then price / down payment; the same published range (no LTV, no tier)
  const buy = await organicLead(h, "lead-buy"); await h.run("32.14", "lead.answer", { lead_id: buy, step: "goal", value: "buy" });
  const c = await h.run("32.14", "lead.answer", { lead_id: buy, step: "contract", value: "signed" }); assert.equal((c["next_step"] as Record<string, unknown>)["id"], "state");
  await h.run("32.14", "lead.answer", { lead_id: buy, step: "state", value: "CA" });
  const e = await h.run("32.14", "lead.answer", { lead_id: buy, step: "estimate", value: { price_range_cents: "50000000", down_payment_cents: "10000000" } }); assert.equal(e["next_step"], null); assert.equal((e["facts"] as Record<string, unknown>)["down_payment_cents"], "10000000");
  const rb = await h.run("32.14", "lead.requestRange", { lead_id: buy, partner_nmlsr_id: "123456" }); assert.equal((rb["range"] as Record<string, unknown>)["low_pct"], "5.875");
  assert.throws(() => stepCard("state", h.lead(buy)) && USPS_STATES.includes("XX") ? null : (() => { throw new RangeError("XX"); })(), RangeError);
});

test("lead.proceed (32.14 T14/T15, DELTA-13): Not yet → intent.deferred and the lead keeps its status; Get my real numbers before terms.presented under assisted → TERMS_NOT_PRESENTED; at terms_presented → 20.3 convert → application.received on the lead's id (REGB_1002_9_DECISION_30 arms) and the lead is converted; link_party → lead.linked", async () => {
  const h = harness(); const lead_id = await organicLead(h); await refiChips(h, lead_id, "AZ");
  const d = await h.run("32.14", "lead.proceed", { lead_id, choice: "not_yet" });
  assert.equal(d["deferred"], true); assert.deepEqual([d["ordered"], d["pulled"], d["document"]], [false, false, null]); assert.equal(d["copy_key"], "entry.proceed.not_yet");
  assert.equal(ofType(h.events, "intent.deferred").length, 1); assert.equal(ofType(h.events, "intent.deferred")[0]!.payload["lead_id"], lead_id); assert.equal(h.lead(lead_id).status, "disclosed");
  assert.equal(ofType(h.events, "credit.softpull.requested").length, 0); assert.equal(ofType(h.events, "application.received").length, 0);
  await assert.rejects(h.run("32.14", "lead.proceed", { lead_id, choice: "proceed" }), rejectsCode("TERMS_NOT_PRESENTED"));
  await assert.rejects(h.run("32.14", "lead.proceed", { lead_id, choice: "proceed", personal_terms: true }), rejectsCode("NO_RATE_BEFORE_MLO_REVIEW"));
  await assert.rejects(h.run("32.14", "lead.proceed", { lead_id, choice: "later" }), RangeError);
  // the link at verify (D's route calls 20.3's op with the party from the session)
  const linked = await h.run("20.3", "explainProgram", { op: "link_party", lead_id, party_id: "p-alex", method: "otp_phone", session_id: "s-1" });
  assert.equal(linked["party_id"], "p-alex"); assert.equal(ofType(h.events, "lead.linked")[0]!.payload["party_id"], "p-alex"); assert.equal(h.lead(lead_id).transaction_intent, "limited_cash_out", "the link keeps every fact");
  // S4 ran (20.3's own path): terms presented by the MLO of record — stand the lead at terms_presented and proceed
  h.rt.store.put("leads", lead_id, { status: "terms_presented", assurance_level: "L1_channel_otp" }, INTAKE, NOW);
  const p = await h.run("32.14", "lead.proceed", { lead_id, choice: "proceed", borrower_name: "Alex Borrower" });
  assert.equal(p["application_id"], lead_id, "one id space: the application is the lead"); assert.equal(p["transaction_type"], "limited_cash_out"); assert.equal(p["occupancy"], "primary"); assert.equal(p["occupancy_defaulted"], false); assert.equal(p["ai_mlo_intake"], "assisted");
  const received = ofType(h.events, "application.received"); assert.equal(received.length, 1); assert.equal(received[0]!.applicationId, lead_id);
  assert.equal(h.lead(lead_id).status, "converted"); assert.equal(h.lead(lead_id).application_id, lead_id);
  assert.ok(h.timers.byCode("REGB_1002_9_DECISION_30").length >= 1, "Reg B's 30-day decision clock arms on application.received");
  await assert.rejects(h.run("32.14", "lead.proceed", { lead_id, choice: "not_yet" }), rejectsCode("LEAD_CLOSED"));
  await assert.rejects(h.run("32.14", "lead.answer", { lead_id, step: "goal", value: "buy" }), rejectsCode("LEAD_CLOSED"));
});

test("every 32.14 tool refuses an empty input with a typed RangeError (never a TypeError) and names only the four spec tools", async () => {
  const h = harness();
  assert.deepEqual(TOOLS_32_14.map((t) => t.name), ["lead.answer", "lead.requestRange", "lead.proceed", "party.linkLoan"]); for (const t of TOOLS_32_14) { assert.equal(t.process, "32.14"); assert.equal(t.agent, "borrower-app"); }
  for (const t of TOOLS_32_14) await assert.rejects(h.run("32.14", t.name, {}), (e: unknown) => e instanceof RangeError && !(e instanceof TypeError), t.name);
});
