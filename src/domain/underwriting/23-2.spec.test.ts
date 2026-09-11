// 23.2 DU findings interpretation, recommendation policy, and conditions generation (incl. HomeReady/AMI, homebuyer education, value acceptance offers, MI messages, red flags)
// spec/sections/23-desktop-underwriter-and-the-credit-decision/23-2-du-findings-interpretation-recommendation-policy-and-conditi.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_23_2 } from "../../app/tools/section23-2.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { policyGeneration } from "./ops-23-1.ts";
import type { DuMessage } from "./ops-23-1.ts";
import { interpretFindings, mapMessages, evaluateHomeReady, computeRestructure, pitiaFor, miCoverage, counselingCredit12m, homeownershipEducationGate, educationBasis, deliveryOffer, ctcBlockers, closeInvestigation, supersedeDroppedConditions, sfcAssembly, borrowerSafe, loanLimitCheck, recommendationDrift, policyOutcome, decisionRecord23_2, InterpretationRefused, DU_MESSAGE_RULES_2026_09_25, UNMAPPED_TEMPLATE,
  type ApplicationFacts, type StructureFinancials, type InterpretInput, type Condition, type EducationRecord } from "./ops-23-2.ts";

const AGENT: Actor = { kind: "agent", id: "underwriter" };
const REVIEWER: Actor = { kind: "human", id: "u-uw-reviewer", role: "underwriting_reviewer" };
const FNMA: Actor = { kind: "external", id: "fnma" };
const REFI = "APP-REFI-560K", PURCHASE = "APP-PURCH-412K";
const RELEASE = "2026-09-25";

const msg = (id: string, category: string, text: string, borrower_id: string | null = null): DuMessage => ({ id, category, text, borrower_id });
/** Refinance fixture findings Tue Oct 6, 2026: 14 verification messages, 1 MI message (none at 70 % LTV), 1 value-acceptance offer, 2 observations. */
const REFI_VERIFICATION: DuMessage[] = [
  msg("V1001", "verification", "Verify base income with the most recent paystub (30 days) and W-2 (1 year)", "B1"), msg("V1002", "verification", "Verify bonus income history — 2 years W-2 or written VOE", "B1"), msg("V1003", "verification", "Verbal verification of employment within 10 business days of the note date", "B1"),
  msg("V1004", "verification", "Total Funds to be Verified: $18,400.00", null), msg("V1005", "verification", "Reserves Required to be Verified: $6,805.24", null), msg("V1006", "verification", "Verify 12-month mortgage payment history on the existing lien", null),
  msg("V1007", "verification", "Obtain a signed explanation for credit inquiries in the last 120 days", "B2"), msg("V1008", "verification", "Obtain evidence of hazard insurance coverage", null), msg("V1009", "verification", "Obtain the title commitment", null),
  msg("V1010", "verification", "Obtain the payoff statement for the existing first mortgage", null), msg("V1011", "verification", "Verify the subject property is the borrower's primary residence", "B1"), msg("V1012", "verification", "Verify the borrowers' identity", null),
  msg("V1013", "verification", "Obtain IRS Form 4506-C signed by each borrower", null), msg("V1014", "verification", "Obtain the flood zone determination", null),
];
const REFI_MESSAGES: DuMessage[] = [...REFI_VERIFICATION, msg("M2000", "mi", "No mortgage insurance is required at 70.00% LTV"), msg("A3001", "value_acceptance", "This loan casefile is eligible for value acceptance"), msg("O4001", "observation", "Attachment type: detached"), msg("O4002", "observation", "Doc File ID observed")];
const REFI_FACTS: ApplicationFacts = { transaction_type: "limited_cash_out", product: "standard", term_months: 360, ltv_x100: 7000, loan_amount_cents: 56_000_000n, units: 1, county_limit_cents: null, score_model: "classic_fico", borrower_ids: ["B1", "B2"], all_occupying_first_time: false, all_borrowers_first_time: false, du_no_tradelines: false, closing_date: D("2026-11-06") };
/** Purchase fixture (Columbus, OH; application Mon Oct 19, 2026): sales price $458,000.00, loan $412,000.00 (89.96 % LTV), HomeReady, two occupying first-time homebuyers, closing Wed Nov 18, 2026. */
const PURCHASE_FACTS: ApplicationFacts = { transaction_type: "purchase", product: "homeready", term_months: 360, ltv_x100: 8996, loan_amount_cents: 41_200_000n, units: 1, county_limit_cents: null, score_model: "classic_fico", borrower_ids: ["B1", "B2"], all_occupying_first_time: true, all_borrowers_first_time: true, du_no_tradelines: false, closing_date: D("2026-11-18") };
/** Rule 2 / rule 7 worked-example inputs: 6.375 % 30-year fixed, taxes $520.00, insurance $95.00, debts $410.00, illustrative MI 0.40 %/yr. */
const purchaseFinancials = (monthly_income_cents: bigint, o: Partial<StructureFinancials> = {}): StructureFinancials => ({ monthly_income_cents, loan_amount_cents: 41_200_000n, value_cents: 45_800_000n, purchase_price_cents: 45_800_000n, transaction_type: "purchase", note_rate_pct: "6.375", term_months: 360, taxes_monthly_cents: 52_000n, insurance_monthly_cents: 9_500n, other_debts_monthly_cents: 41_000n, mi_annual_rate_pct: "0.40", product: "homeready", ...o });
const interpretInput = (o: Partial<InterpretInput> & { application_id: string; submission_id: string }): InterpretInput => ({ submission_number: 1, is_final: false, recommendation: "approve_eligible", messages: REFI_MESSAGES, validation_results: [], value_acceptance_offer: null, mi_requirement: null, du_release: RELEASE, policy_generation: "2026_09_26", request_hash: "req-1", findings_received_at: "2026-10-06T10:00:00.000Z", interpreted_at: "2026-10-06T13:12:00.000Z", facts: REFI_FACTS, ...o });

/** The 23.2 tools on the bus over the overridden timer registry (23.2 rows only) and an entity store; `now` is the wall clock. */
function harness(applicationId: string, nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["23.2"] });
  const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const escalations = new EscalationService(events, clock);
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: {}, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_23_2); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("23.2", name))!, actor, { application_id: applicationId, ...input }, uow)).output as Record<string, unknown>;
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (t: string) => events.all().filter((e) => e.type === t);
  return { clock, events, timers, uow, escalations, rt, run, timer, decisions, ofType };
}
/** 23.1's `du.findings.received` as receiveFindings emits it (appended by the harness — 23.1 is in flight). */
const receivedPayload = (o: { submission_number: number; recommendation: string; messages: DuMessage[]; offer?: { offered: boolean; property_value_cents?: string } | null; mi?: { required: boolean; coverage_pct: string | null } | null; is_final?: boolean; request_hash?: string }) =>
  ({ casefile_id: "CF-REFI-1", submission_number: o.submission_number, recommendation: o.recommendation, messages: o.messages, validation_results: [], value_acceptance_offer: o.offer ?? null, mi_requirement: o.mi ?? { required: false, coverage_pct: null }, risk_factors: {}, dti_du: "38.00", ltv_du: "70.00", reserves_required_cents: "680524", findings_hash: `fh-${o.submission_number}`, request_hash: o.request_hash ?? "req-1", is_final_candidate: o.is_final ?? false, du_release_applied: RELEASE, policy_generation: "2026_09_26", submitted_via: "di" });

test("23.2-T1: Given findings Tue Oct 6, 2026 (refinance fixture) with 14 verification messages, 1 MI message (\"no MI\" at 70% LTV → none), 1 value-acceptance offer and 2 observations, when interpreted, then 14 PTD conditions are opened by 10:00 the same day (`SM_DU_CONDITIONS_SLA_4H` satisfied), `value_acceptance_offer = value_acceptance`, `sfc_required = {127, 007}`, and no borrower-facing text contains a DU message ID.", async () => {
  const h = harness(REFI, "2026-10-06T13:12:00.000Z");   // the agent interprets at 09:12 ET
  // 23.1 delivers the findings at 06:00 ET (10:00Z): the 4-hour clock arms and is due 10:00 ET the same creditor business day
  h.events.append({ type: "du.findings.received", applicationId: REFI, actor: FNMA, occurredAt: "2026-10-06T10:00:00.000Z", payload: receivedPayload({ submission_number: 1, recommendation: "approve_eligible", messages: REFI_MESSAGES, offer: { offered: true, property_value_cents: "80000000" } }) });
  const armed = h.timer("SM_DU_CONDITIONS_SLA_4H")!; assert.equal(armed.status, "armed"); assert.equal(armed.dueAt, Date.parse("2026-10-06T14:00:00.000Z")); assert.equal(armed.dueDate, "2026-10-06");
  const out = await h.run("parseFindings", { op: "interpret", submission_id: "SUB-REFI-1", submission_number: 1, recommendation: "approve_eligible", messages: REFI_MESSAGES, validation_results: [], value_acceptance_offer: { offered: true, property_value_cents: "80000000" }, mi_requirement: { required: false, coverage_pct: null }, du_release: RELEASE, policy_generation: "2026_09_26", request_hash: "req-1", findings_received_at: "2026-10-06T10:00:00.000Z", facts: REFI_FACTS });
  const interp = out.interpretation as Record<string, unknown>;
  assert.equal(interp.policy_outcome, "proceed"); assert.equal(interp.ptd_conditions_opened, 14); assert.equal(interp.value_acceptance_offer, "value_acceptance"); assert.deepEqual(interp.sfc_required, ["007", "127"]);
  assert.equal(interp.mi_coverage_pct, null); assert.equal(interp.investigations_opened, 0); assert.equal(interp.unmapped_messages, 0);
  const conds = h.rt.store.list("conditions").map((r) => r.data as unknown as Condition);
  const ptd = conds.filter((c) => c.stage === "ptd"); assert.equal(ptd.length, 14); assert.ok(ptd.every((c) => c.status === "open" && c.source === "du"));
  assert.deepEqual(conds.filter((c) => c.stage === "post_closing").map((c) => c.template_code).sort(), ["COND_DELIVERY_SFC_007", "COND_DELIVERY_SFC_127"]);
  assert.equal(conds.some((c) => c.template_code === "COND_DU_MI_CERT"), false);
  const ids = REFI_MESSAGES.map((m) => m.id);
  for (const c of conds.filter((c) => c.borrower_visible)) { assert.ok(borrowerSafe(c.text, ids), c.text); assert.ok(!/\bDU\b/.test(c.text)); assert.ok(!ids.some((id) => c.text.includes(id))); }
  assert.equal(h.ofType("condition.opened").length, 16); assert.equal(h.ofType("condition.opened")[0]!.applicationId, REFI);
  // the SLA clock is satisfied by du.findings.interpreted{conditions_materialized=true} at 09:12 ET, before the 10:00 due time
  const sla = h.timer("SM_DU_CONDITIONS_SLA_4H")!; assert.equal(sla.status, "satisfied"); assert.equal(sla.satisfiedAt, "2026-10-06T13:12:00.000Z"); assert.ok(Date.parse(sla.satisfiedAt!) < sla.dueAt!);
  const done = h.ofType("du.findings.interpreted")[0]!; assert.equal(done.payload.conditions_materialized, true); assert.equal(done.payload.ptd_conditions_opened, 14); assert.deepEqual(done.payload.consumers, ["23.3", "24.1", "24.6", "29.3"]);
  const va = h.ofType("value_acceptance.offer.received")[0]!; assert.equal(va.payload.offer, "value_acceptance"); assert.equal(va.payload.is_final, false);
});

test("23.2-T2: Given a message ID not in `du_message_rules` for release `2026-09-25`, then a `COND_DU_UNMAPPED_MESSAGE` PTD condition is opened, the triage queue receives the message, and CTC (23.3) is blocked until it is mapped or cleared by `underwriting_reviewer`.", async () => {
  const mapped = mapMessages([msg("V1001", "verification", "…"), msg("X7777", "unknown", "New Sept 25, 2026 message with no catalog row")], DU_MESSAGE_RULES_2026_09_25, RELEASE);
  assert.equal(mapped[0]!.action, "open_condition"); assert.equal(mapped[1]!.action, "unmapped"); assert.equal(mapped[1]!.rule, null);
  const h = harness(REFI, "2026-10-06T13:12:00.000Z");
  const out = await h.run("parseFindings", { op: "interpret", submission_id: "SUB-REFI-1", submission_number: 1, recommendation: "approve_eligible", messages: [msg("V1001", "verification", "Verify base income", "B1"), msg("X7777", "unknown", "New Sept 25, 2026 message with no catalog row", "B1")], du_release: RELEASE, policy_generation: "2026_09_26", request_hash: "req-1", findings_received_at: "2026-10-06T10:00:00.000Z", facts: REFI_FACTS });
  assert.deepEqual(out.triage, ["X7777"]); assert.equal((out.interpretation as Record<string, unknown>).unmapped_messages, 1);
  const conds = () => h.rt.store.list("conditions").map((r) => r.data as unknown as Condition);
  const un = conds().find((c) => c.template_code === UNMAPPED_TEMPLATE)!;
  assert.equal(un.stage, "ptd"); assert.equal(un.status, "open"); assert.equal(un.du_message_id, "X7777"); assert.equal(un.requires_role, "underwriting_reviewer"); assert.ok(!un.text.includes("X7777"));
  const triage = h.rt.store.list("du_message_triage").map((r) => r.data); assert.equal(triage.length, 1); assert.equal(triage[0]!.message_id, "X7777"); assert.equal(triage[0]!.status, "queued");
  assert.equal(h.ofType("du.message.unmapped")[0]!.payload.queue, "du_message_triage");
  // 23.3's CTC checklist is blocked on the unmapped message; the agent cannot clear it, the underwriting_reviewer can
  const blocked = ctcBlockers(conds(), []); assert.equal(blocked.open, false); assert.ok(blocked.blocking_codes.includes("CTC_UNMAPPED_DU_MESSAGE"));
  await assert.rejects(h.run("openCondition", { op: "clear_unmapped", condition_id: un.condition_id, reason: "mapped to COND_DU_VERIFY_INCOME_BASE" }), (e: unknown) => e instanceof CommandRefused && e.code === "UNMAPPED_CLEAR_NEEDS_REVIEWER");
  const cleared = await h.run("openCondition", { op: "clear_unmapped", condition_id: un.condition_id, reason: "catalog row added", mapped_to: "COND_DU_VERIFY_INCOME_BASE" }, REVIEWER);
  assert.equal(cleared.status, "cleared"); assert.equal(cleared.cleared_by, "u-uw-reviewer");
  assert.ok(!ctcBlockers(conds(), []).blocking_codes.includes("CTC_UNMAPPED_DU_MESSAGE"));
  assert.equal(h.ofType("condition.cleared").length, 1);
});

test("23.2-T3: Given the purchase fixture with qualifying income $98,400.00/year and API AMI $124,000.00, then `homeready_evaluations.eligible = true` (limit $99,200.00); with $100,800.00 it is `false` and a `remove_homeready` proposal is created whose expected DTI is 44.44%.", async () => {
  const h = harness(PURCHASE, "2026-10-20T15:00:00.000Z");
  const ok = await h.run("evaluateHomeReady", { property_fips: "39049", ami_source: "ami_api", ami_annual_cents: "12400000", qualifying_monthly_income_cents: ["820000"], ami_dataset_version: "2026" });
  const e1 = ok.evaluation as Record<string, unknown>;
  assert.equal(e1.qualifying_income_annual_cents, 9_840_000n); assert.equal(e1.income_limit_annual_cents, 9_920_000n); assert.equal(e1.limit_pct, "80.00"); assert.equal(e1.eligible, true); assert.equal(e1.ami_source, "ami_api");
  assert.equal(h.rt.store.list("homeready_evaluations").length, 1); assert.deepEqual(h.ofType("homeready.evaluated")[0]!.payload.sfc, ["900"]);
  // fail case: $8,400.00/month → $100,800.00 > $99,200.00 → not eligible → remove_homeready lever with the full arithmetic
  const bad = await h.run("evaluateHomeReady", { property_fips: "39049", ami_source: "ami_api", ami_annual_cents: "12400000", qualifying_monthly_income_cents: ["840000"], ami_dataset_version: "2026", financials: purchaseFinancials(840_000n) });
  assert.equal((bad.evaluation as Record<string, unknown>).qualifying_income_annual_cents, 10_080_000n); assert.equal((bad.evaluation as Record<string, unknown>).eligible, false);
  const lever = bad.remove_homeready_lever as Record<string, unknown>; assert.equal(lever.kind, "remove_homeready"); assert.equal((lever.pitia as Record<string, unknown>).dti_display, "44.44"); assert.equal(lever.expected_recommendation, "approve_eligible");
  // the interpretation of DU's Approve/Ineligible (income-limit eligibility message) creates the proposal
  const r = interpretFindings(h.events, interpretInput({ application_id: PURCHASE, submission_id: "SUB-PUR-1", recommendation: "approve_ineligible", messages: [msg("E5003", "eligibility", "Total qualifying income exceeds the HomeReady income limit for the property location")], facts: PURCHASE_FACTS, financials: purchaseFinancials(840_000n), interpreted_at: "2026-10-20T15:00:00.000Z" }));
  assert.equal(r.interpretation.policy_outcome, "restructure_required"); assert.deepEqual(r.interpretation.structural_reasons.map((s) => s.reason_code), ["HOMEREADY_INCOME_OVER_AMI_LIMIT"]);
  assert.equal(r.proposals.length, 1); const p = r.proposals[0]!;
  assert.equal(p.kind, "remove_homeready"); assert.equal(p.expected_dti_bps, 4444); assert.equal(p.expected_dti_display, "44.44"); assert.equal(p.expected_recommendation, "approve_eligible"); assert.equal(p.status, "proposed");
  assert.equal(p.to.mi_coverage_pct, "25.00");   // 85.01–90 % is 25 % under both the standard and the HomeReady table
  assert.equal(p.arithmetic.obligations_cents, "373267"); assert.equal(p.arithmetic.pi_cents, "257034"); assert.equal(p.arithmetic.mi_cents, "13733");
  const ev = h.ofType("restructure.proposed")[0]!; assert.equal(ev.payload.kind, "remove_homeready"); assert.equal(ev.payload.expected_dti_display, "44.44"); assert.ok((ev.payload.consumers as string[]).includes("21.5"));
  // never a non-Fannie-Mae AMI
  await assert.rejects(h.run("evaluateHomeReady", { property_fips: "39049", ami_source: "hud_published", ami_annual_cents: "12400000", qualifying_monthly_income_cents: ["820000"], ami_dataset_version: "2026" }), (e: unknown) => e instanceof CommandRefused && e.code === "NON_FNMA_AMI");
  assert.throws(() => evaluateHomeReady({ application_id: PURCHASE, property_fips: "39049", ami_source: "hud_published", ami_annual_cents: 12_400_000n, qualifying_monthly_income_cents: [820_000n], ami_dataset_version: "2026", evaluated_at: "2026-10-20T15:00:00.000Z" }), (e: unknown) => e instanceof InterpretationRefused && e.code === "NON_FNMA_AMI");
});

test("23.2-T4: Given two occupying first-time homebuyers on a HomeReady purchase closing Wed Nov 18, 2026 and no certificate on file Mon Nov 16, then `FNMA_B2_2_06_HOMEOWNERSHIP_ED_GATE` blocks `clear_to_close` and an `escalation{underwriting_reviewer}` is opened (closing < 3 BD away); a HomeView certificate dated Fri Oct 30, 2026 verified Nov 16 satisfies the gate.", async () => {
  assert.equal(educationBasis({ purchase: true, homeready: true, all_occupying_first_time: true, all_borrowers_first_time: true, ltv_x100: 8996, du_no_tradelines: false }), "homeready_all_ftb");
  assert.equal(educationBasis({ purchase: true, homeready: true, all_occupying_first_time: false, all_borrowers_first_time: false, ltv_x100: 8996, du_no_tradelines: false }), "none");   // a non-first-time co-borrower added
  const h = harness(PURCHASE, "2026-11-16T15:00:00.000Z");
  const req = await h.run("verifyEducationCertificate", { op: "require", borrower_id: "B1", borrower_ids: ["B1", "B2"], basis: "homeready_all_ftb", closing_date: "2026-11-18" });
  assert.equal(req.required, true); assert.equal(h.ofType("homeownership_education.required")[0]!.payload.basis, "homeready_all_ftb");
  const gate = h.timer("FNMA_B2_2_06_HOMEOWNERSHIP_ED_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.dueAt, undefined);
  const records = () => h.rt.store.list("homeownership_education_records").map((r) => r.data as unknown as EducationRecord);
  assert.ok(records().every((r) => r.status === "required_open"));
  // Mon Nov 16: no certificate on file, closing in 2 creditor business days → blocked + underwriting_reviewer
  const g1 = homeownershipEducationGate({ basis: "homeready_all_ftb", records: records(), closing_date: D("2026-11-18"), as_of: D("2026-11-16") });
  assert.equal(g1.open, false); assert.deepEqual(g1.blocking_codes, ["CTC_EDUCATION_NOT_VERIFIED"]); assert.equal(g1.business_days_to_closing, 2); assert.equal(g1.escalate, "underwriting_reviewer");
  const ev1 = evaluateGate("23.2.homeownershipEducationGate", { basis: "homeready_all_ftb", records: records(), closing_date: "2026-11-18", as_of: "2026-11-16", command: "clear_to_close" });
  assert.equal(ev1.open, false); assert.match(ev1.reason!, /prior to loan closing/); assert.match(ev1.reason!, /escalate underwriting_reviewer/);
  await h.run("openEscalation", { kind: "underwriting_reviewer", reason: g1.reason, payload: { gate: "FNMA_B2_2_06_HOMEOWNERSHIP_ED_GATE", closing_date: "2026-11-18", business_days_to_closing: g1.business_days_to_closing } });
  assert.equal(h.escalations.list().length, 1); assert.equal(h.escalations.list()[0]!.kind, "underwriting_reviewer"); assert.equal(h.escalations.list()[0]!.ownerRole, "underwriting_reviewer");
  // a certificate without the document is never verified
  await assert.rejects(h.run("verifyEducationCertificate", { borrower_id: "B1", borrower_name: "Ana Borrower", name_on_certificate: "Ana Borrower", closing_date: "2026-11-18" }), (e: unknown) => e instanceof CommandRefused && e.code === "EDUCATION_VERIFIED_WITHOUT_CERTIFICATE");
  // HomeView certificate dated Fri Oct 30, 2026 (no expiration), classified by 22.1 and verified Nov 16
  const rec = await h.run("verifyEducationCertificate", { op: "receive", borrower_id: "B1", certificate_document_id: "DOC-HOMEVIEW-B1", provider_name: "Fannie Mae HomeView", provider_type: "homeview", course_type: "education", completed_on: "2026-10-30" });
  assert.equal(rec.status, "received"); assert.equal(rec.completed_on, "2026-10-30");
  const ver = await h.run("verifyEducationCertificate", { borrower_id: "B1", certificate_document_id: "DOC-HOMEVIEW-B1", borrower_name: "Ana Borrower", name_on_certificate: "ANA BORROWER", closing_date: "2026-11-18" });
  const checks = ver.checks as Record<string, boolean>; assert.equal(checks.provider_accepted, true); assert.equal(checks.name_match, true); assert.equal(checks.completed_before_closing, true); assert.equal(checks.counseling_within_12m, false);
  assert.equal((ver.record as EducationRecord).status, "verified"); assert.equal((ver.record as EducationRecord).verified_at, "2026-11-16T15:00:00.000Z");
  const done = h.ofType("homeownership_education.verified")[0]!; assert.equal(done.payload.borrower_id, "B1"); assert.equal(done.payload.sfc_184, false);
  assert.equal(h.timer("FNMA_B2_2_06_HOMEOWNERSHIP_ED_GATE")!.status, "satisfied");
  assert.equal(homeownershipEducationGate({ basis: "homeready_all_ftb", records: records(), closing_date: D("2026-11-18"), as_of: D("2026-11-16") }).open, true);
  assert.equal(evaluateGate("23.2.homeownershipEducationGate", { basis: "homeready_all_ftb", records: records(), closing_date: "2026-11-18", as_of: "2026-11-16" }).open, true);
});

test("23.2-T5: Given HUD-agency counseling completed Nov 10, 2025 for a closing on Nov 18, 2026, then `FNMA_B5_6_01_COUNSELING_CREDIT_12M` is not satisfied (> 12 months) and SFC 184 is not emitted; completed Nov 20, 2025 → satisfied.", async () => {
  const early = counselingCredit12m(D("2025-11-10"), D("2026-11-18")); assert.equal(early.satisfied, false); assert.equal(early.window_opens, "2025-11-18"); assert.equal(early.sfc_184, false);
  const late = counselingCredit12m(D("2025-11-20"), D("2026-11-18")); assert.equal(late.satisfied, true); assert.equal(late.sfc_184, true);
  assert.equal(evaluateGate("23.2.counselingCredit12m", { completed_on: "2025-11-10", closing_date: "2026-11-18" }).open, false);
  assert.equal(evaluateGate("23.2.counselingCredit12m", { completed_on: "2025-11-20", closing_date: "2026-11-18" }).open, true);
  const h = harness(PURCHASE, "2026-11-16T15:00:00.000Z");
  await h.run("verifyEducationCertificate", { op: "require", borrower_id: "B1", borrower_ids: ["B1", "B2"], basis: "homeready_all_ftb", closing_date: "2026-11-18" });
  const agency = { name: "Columbus Housing Partnership", type: "hud_approved_agency" };
  // borrower 1: counseling completed Nov 10, 2025 — the window row arms on the certificate (anchor completed_on) and is not satisfied
  await h.run("verifyEducationCertificate", { op: "receive", borrower_id: "B1", certificate_document_id: "DOC-HUD-B1", provider_name: agency.name, provider_type: agency.type, course_type: "counseling", completed_on: "2025-11-10" });
  const w1 = h.timers.byCode("FNMA_B5_6_01_COUNSELING_CREDIT_12M"); assert.equal(w1.length, 1); assert.equal(w1[0]!.status, "armed"); assert.equal(w1[0]!.anchorDate, "2025-11-10");
  const v1 = await h.run("verifyEducationCertificate", { borrower_id: "B1", certificate_document_id: "DOC-HUD-B1", borrower_name: "Ana Borrower", name_on_certificate: "Ana Borrower", closing_date: "2026-11-18", provider_allowlist: [agency] });
  assert.equal((v1.record as EducationRecord).status, "verified"); assert.equal((v1.record as EducationRecord).counseling_within_12m, false);
  const e1 = h.ofType("homeownership_education.verified")[0]!; assert.equal(e1.payload.counseling_within_12m, false); assert.equal(e1.payload.sfc_184, false);
  assert.equal(h.timers.byCode("FNMA_B5_6_01_COUNSELING_CREDIT_12M")[0]!.status, "armed");
  assert.ok(!sfcAssembly({ transaction_type: "purchase", score_model: "classic_fico", homeready: true, counseling_credit: false, value_acceptance_exercised: false, va_pd_exercised: false, high_balance: false, community_seconds: false, temporary_buydown: false, inter_vivos_trust: false, texas_50a6: false }).includes("184"));
  // borrower 2: counseling completed Nov 20, 2025 → inside the window → SFC 184 + the row is satisfied
  await h.run("verifyEducationCertificate", { op: "receive", borrower_id: "B2", certificate_document_id: "DOC-HUD-B2", provider_name: agency.name, provider_type: agency.type, course_type: "counseling", completed_on: "2025-11-20" });
  const v2 = await h.run("verifyEducationCertificate", { borrower_id: "B2", certificate_document_id: "DOC-HUD-B2", borrower_name: "Ben Borrower", name_on_certificate: "Ben Borrower", closing_date: "2026-11-18", provider_allowlist: [agency] });
  assert.equal((v2.record as EducationRecord).counseling_within_12m, true);
  const e2 = h.ofType("homeownership_education.verified")[1]!; assert.equal(e2.payload.sfc_184, true);
  const w2 = h.timers.byCode("FNMA_B5_6_01_COUNSELING_CREDIT_12M"); assert.equal(w2.length, 2); assert.equal(w2[1]!.anchorDate, "2025-11-20"); assert.equal(w2[1]!.status, "satisfied");
  assert.ok(sfcAssembly({ transaction_type: "purchase", score_model: "classic_fico", homeready: true, counseling_credit: true, value_acceptance_exercised: false, va_pd_exercised: false, high_balance: false, community_seconds: false, temporary_buydown: false, inter_vivos_trust: false, texas_50a6: false }).includes("184"));
});

test("23.2-T6: Given Approve/Ineligible with an eligibility message \"loan amount exceeds the county loan limit\" ($840,000 in a baseline county, limit $832,750), then `policy_outcome = restructure_required`, a `loan_amount` proposal to $832,750 is computed, and `regb_treatment = counteroffer` requiring `underwriting_reviewer` before any borrower contact.", async () => {
  const limits = loanLimitCheck(84_000_000n, 1, null); assert.equal(limits.county_limit_cents, 83_275_000n); assert.equal(limits.over_limit, true); assert.equal(limits.over_ceiling, false);
  const h = harness("APP-JUMBO-840K", "2026-10-21T16:00:00.000Z");
  const facts: ApplicationFacts = { ...REFI_FACTS, transaction_type: "purchase", ltv_x100: 8000, loan_amount_cents: 84_000_000n, closing_date: D("2026-12-04") };
  const financials: StructureFinancials = { monthly_income_cents: 2_100_000n, loan_amount_cents: 84_000_000n, value_cents: 105_000_000n, purchase_price_cents: 105_000_000n, transaction_type: "purchase", note_rate_pct: "6.375", term_months: 360, taxes_monthly_cents: 110_000n, insurance_monthly_cents: 18_000n, other_debts_monthly_cents: 60_000n, mi_annual_rate_pct: null, product: "standard" };
  const out = await h.run("parseFindings", { op: "interpret", submission_id: "SUB-J-1", submission_number: 1, recommendation: "approve_ineligible", messages: [msg("E5001", "eligibility", "The loan amount exceeds the county loan limit"), ...REFI_VERIFICATION.slice(0, 3)], du_release: RELEASE, policy_generation: "2026_09_26", request_hash: "req-j1", findings_received_at: "2026-10-21T14:00:00.000Z", facts, financials });
  const interp = out.interpretation as Record<string, unknown>;
  assert.equal(interp.policy_outcome, "restructure_required"); assert.deepEqual((interp.structural_reasons as { reason_code: string }[]).map((s) => s.reason_code), ["LOAN_AMOUNT_OVER_COUNTY_LIMIT"]);
  assert.deepEqual(interp.lawful_paths, ["borrower_accepted_restructure", "regb_counteroffer", "regb_denial"]);
  const p = h.rt.store.list("restructure_proposals").map((r) => r.data)[0]!;
  assert.equal(p.kind, "loan_amount"); assert.equal((p.to as Record<string, unknown>).loan_amount_cents, "83275000"); assert.equal(p.expected_recommendation, "approve_eligible"); assert.equal(p.regb_treatment, "counteroffer"); assert.equal(p.initiated_by, "sm"); assert.equal(p.status, "proposed");
  const ev = h.ofType("restructure.proposed")[0]!; assert.equal(ev.payload.requires_reviewer_before_borrower_contact, true); assert.equal(ev.payload.reviewer_role, "underwriting_reviewer"); assert.ok((ev.payload.consumers as string[]).includes("21.6"));
  // the agent may compute and propose, never communicate: borrower contact needs underwriting_reviewer
  const lever = (await h.run("computeRestructure", { financials, structural_reasons: interp.structural_reasons, recommendation: "approve_ineligible" })).recommended as Record<string, unknown>;
  assert.equal(lever.kind, "loan_amount"); assert.equal(lever.to && (lever.to as Record<string, unknown>).loan_amount_cents, "83275000");
  await assert.rejects(h.run("proposeRestructure", { lever, from: { loan_amount_cents: "84000000" }, communicate_to_borrower: true }), (e: unknown) => e instanceof CommandRefused && e.code === "COUNTEROFFER_NEEDS_REVIEWER");
  const approved = await h.run("proposeRestructure", { lever, from: { loan_amount_cents: "84000000" }, communicate_to_borrower: true, trigger_submission_id: "SUB-J-1" }, REVIEWER);
  assert.equal(approved.regb_treatment, "counteroffer");
  await assert.rejects(h.run("proposeRestructure", { op: "accept", proposal_id: approved.proposal_id, changed_circumstance_id: "CC-1", regb_treatment: "counteroffer" }), (e: unknown) => e instanceof CommandRefused && e.code === "COUNTEROFFER_NEEDS_REVIEWER");
  const accepted = await h.run("proposeRestructure", { op: "accept", proposal_id: approved.proposal_id, changed_circumstance_id: "CC-1", reviewer_id: "u-uw-reviewer" }, REVIEWER);
  assert.equal(accepted.status, "accepted"); assert.equal(h.ofType("restructure.accepted")[0]!.payload.reason, "counteroffer_accepted");
});

test("23.2-T7: Given Refer with Caution on the purchase fixture at $7,000.00 income (DTI 53.32%), then the agent produces the $360,000.00 proposal (DTI 46.73%, no MI) and a decline candidate; no manual underwriting path is offered; the reviewer's approval is required for the counteroffer notice.", async () => {
  const r = computeRestructure(purchaseFinancials(700_000n), { recommendation: "refer_with_caution" });
  assert.equal(r.current.dti_display, "53.32"); assert.equal(r.current.over_du_cap, true); assert.equal(r.current.obligations_cents, 373_267n);
  const [a, b] = r.levers; assert.equal(a!.kind, "loan_amount"); assert.equal(a!.pitia.loan_amount_cents, 38_000_000n); assert.equal(a!.pitia.ltv_display, "82.97"); assert.equal(a!.pitia.dti_display, "50.32"); assert.equal(a!.within_policy, false);
  assert.equal(b!.kind, "loan_amount"); assert.equal(b!.pitia.loan_amount_cents, 36_000_000n); assert.equal(b!.pitia.ltv_display, "78.60"); assert.equal(b!.pitia.mi_cents, 0n); assert.equal(b!.pitia.dti_display, "46.73"); assert.equal(b!.expected_recommendation, "approve_eligible");
  assert.equal(r.recommended, b); assert.equal(r.decline_candidate, true); assert.equal(r.manual_underwriting_offered, false);
  assert.ok(r.levers.every((l) => !["manual_underwrite", "occupancy_change", "income_change"].includes(l.kind)));
  const h = harness(PURCHASE, "2026-10-21T16:00:00.000Z");
  const out = await h.run("parseFindings", { op: "interpret", submission_id: "SUB-PUR-2", submission_number: 2, recommendation: "refer_with_caution", messages: [msg("E5004", "eligibility", "Total expense ratio exceeds 50%"), ...REFI_VERIFICATION.slice(0, 4)], du_release: RELEASE, policy_generation: "2026_09_26", request_hash: "req-p2", findings_received_at: "2026-10-21T14:00:00.000Z", facts: PURCHASE_FACTS, financials: purchaseFinancials(700_000n) });
  const interp = out.interpretation as Record<string, unknown>;
  assert.equal(interp.policy_outcome, "restructure_required"); assert.equal(interp.decline_candidate, true); assert.equal(interp.manual_underwriting_offered, false);
  assert.ok(!(interp.lawful_paths as string[]).some((p) => /manual/.test(p))); assert.deepEqual(interp.lawful_paths, ["borrower_accepted_restructure", "regb_counteroffer", "regb_denial"]);
  const p = h.rt.store.list("restructure_proposals").map((r) => r.data)[0]!;
  assert.equal((p.to as Record<string, unknown>).loan_amount_cents, "36000000"); assert.equal(p.expected_dti_display, "46.73"); assert.equal((p.arithmetic as Record<string, unknown>).mi_cents, "0"); assert.equal(p.regb_treatment, "counteroffer");
  assert.equal(h.ofType("restructure.proposed")[0]!.payload.requires_reviewer_before_borrower_contact, true);
  await assert.rejects(h.run("computeRestructure", { financials: purchaseFinancials(700_000n), manual_underwrite: true }), (e: unknown) => e instanceof CommandRefused && e.code === "MANUAL_UNDERWRITING_NOT_IN_POLICY");
  await assert.rejects(h.run("proposeRestructure", { lever: r.recommended, from: {}, send_counteroffer: true }), (e: unknown) => e instanceof CommandRefused && e.code === "COUNTEROFFER_NEEDS_REVIEWER");
  await assert.rejects(h.run("proposeRestructure", { lever: { ...r.recommended!, kind: "occupancy_change", to: { occupancy: "primary" } }, from: {} }), (e: unknown) => e instanceof CommandRefused && e.code === "RESTRUCTURE_CHANGES_OCCUPANCY_OR_INCOME");
  // the decision record's reason is specific, never the DU recommendation
  assert.throws(() => decisionRecord23_2(interpretFindings(h.events, interpretInput({ application_id: PURCHASE, submission_id: "SUB-PUR-3", recommendation: "refer_with_caution", messages: [], facts: PURCHASE_FACTS, financials: purchaseFinancials(700_000n) })), { model_version: "m", prompt_version: "p", rationale: "DU returned Refer with Caution" }), (e: unknown) => e instanceof InterpretationRefused && e.code === "REASON_TEXT_NAMES_DU");
  const rec = decisionRecord23_2(interpretFindings(h.events, interpretInput({ application_id: PURCHASE, submission_id: "SUB-PUR-4", recommendation: "refer_with_caution", messages: [], facts: PURCHASE_FACTS, financials: purchaseFinancials(700_000n) })), { model_version: "m", prompt_version: "p", rationale: "debt-to-income ratio of 53.32% exceeds the 50% maximum" });
  assert.equal(rec.regb_treatment, "counteroffer"); assert.equal(rec.rule_set_versions["fnma.du"], "12.1"); assert.equal(rec.restructure_proposals.length, 1);
});

test("23.2-T8: Given a potential red flag \"Occupancy Modified\" (investor → primary), then an `investigation.opened{kind=du_red_flag}` is created for 22.6, no condition is shown to the borrower, and CTC is blocked until the investigation closes with rationale.", async () => {
  const h = harness(REFI, "2026-10-06T13:12:00.000Z");
  const out = await h.run("parseFindings", { op: "interpret", submission_id: "SUB-REFI-1", submission_number: 1, recommendation: "approve_eligible", messages: [...REFI_VERIFICATION.slice(0, 2), msg("R9004", "potential_red_flag", "Occupancy Modified: the occupancy was modified from investor to primary")], du_release: RELEASE, policy_generation: "2026_09_26", request_hash: "req-1", findings_received_at: "2026-10-06T10:00:00.000Z", facts: REFI_FACTS });
  assert.equal((out.interpretation as Record<string, unknown>).investigations_opened, 1); assert.equal((out.interpretation as Record<string, unknown>).policy_outcome, "proceed");   // "does not affect the underwriting recommendation"
  const ev = h.ofType("investigation.opened")[0]!; assert.equal(ev.payload.kind, "du_red_flag"); assert.equal(ev.payload.red_flag, "occupancy_modified"); assert.deepEqual(ev.payload.hypotheses, ["occupancy_misrepresentation"]); assert.equal(ev.payload.blocks_ctc, true); assert.ok((ev.payload.consumers as string[]).includes("22.6")); assert.equal(ev.payload.borrower_visible, false);
  const conds = h.rt.store.list("conditions").map((r) => r.data as unknown as Condition);
  assert.equal(conds.some((c) => c.du_message_id === "R9004"), false); assert.ok(conds.filter((c) => c.borrower_visible).every((c) => !/occupancy|investor|red flag/i.test(c.text)));
  const inv = h.rt.store.list("investigations").map((r) => r.data)[0]!; assert.equal(inv.status, "open"); assert.equal(inv.borrower_visible, false);
  const blocked = ctcBlockers([], h.rt.store.list("investigations").map((r) => r.data as never)); assert.equal(blocked.open, false); assert.deepEqual(blocked.blocking_codes, ["CTC_NO_OPEN_INVESTIGATION"]);
  await assert.rejects(h.run("openInvestigation", { op: "close", investigation_id: inv.investigation_id, rationale: "" }), (e: unknown) => e instanceof RangeError);
  assert.throws(() => closeInvestigation(h.events, inv as never, "   ", "2026-10-08T15:00:00.000Z", REVIEWER), RangeError);
  await assert.rejects(h.run("openInvestigation", { open_condition: true, submission_id: "SUB-REFI-1", message_id: "R9004", red_flag: "occupancy_modified" }), (e: unknown) => e instanceof CommandRefused && e.code === "RED_FLAG_SHOWN_TO_BORROWER");
  const closed = await h.run("openInvestigation", { op: "close", investigation_id: inv.investigation_id, rationale: "22.6: borrower's prior investor application was withdrawn; primary occupancy evidenced by employer relocation letter and utility connection" }, REVIEWER);
  assert.equal(closed.status, "closed"); assert.equal(h.ofType("investigation.closed").length, 1);
  assert.equal(ctcBlockers([], h.rt.store.list("investigations").map((r) => r.data as never)).open, true);
});

test("23.2-T9: Given a resubmission whose findings drop a previously-open liability message after the borrower paid the account, then the condition is superseded (status `superseded`) with the payoff evidence retained.", () => {
  const events = new MemoryEventStore(new FixedClock("2026-10-20T15:00:00.000Z"), { applicationId: REFI });
  const first = interpretFindings(events, interpretInput({ application_id: REFI, submission_id: "SUB-REFI-1", messages: [...REFI_VERIFICATION.slice(0, 3), msg("V1017", "verification", "Undisclosed liability: revolving account $4,200 balance — verify or pay", "B1")] }));
  const liability = first.conditions.find((c) => c.du_message_id === "V1017")!; assert.equal(liability.template_code, "COND_DU_LIABILITY_UNDISCLOSED"); assert.equal(liability.status, "open");
  // the borrower paid the account; 22.1 attached the payoff evidence (condition.clear.proposed) and 23.3 holds it pending review
  const withEvidence: Condition = { ...liability, status: "satisfied_pending_review", clear_evidence_document_ids: ["DOC-PAYOFF-4200"] };
  const cleared: Condition = { ...first.conditions[0]!, status: "cleared", cleared_at: "2026-10-15T12:00:00.000Z", cleared_by: "run-1", clear_evidence_document_ids: ["DOC-PAYSTUB-1"] };
  const second = interpretFindings(events, interpretInput({ application_id: REFI, submission_id: "SUB-REFI-2", submission_number: 2, messages: REFI_VERIFICATION.slice(0, 3), request_hash: "req-2", interpreted_at: "2026-10-20T15:00:00.000Z", prior_conditions: [withEvidence, cleared, ...first.conditions.slice(1, 3)] }));
  assert.equal(second.superseded.length, 1); const s = second.superseded[0]!;
  assert.equal(s.condition_id, liability.condition_id); assert.equal(s.status, "superseded"); assert.equal(s.superseded_by_submission_id, "SUB-REFI-2"); assert.deepEqual(s.clear_evidence_document_ids, ["DOC-PAYOFF-4200"]);
  const ev = events.ofType("condition.superseded")[0]!; assert.equal(ev.payload.condition_id, liability.condition_id); assert.equal(ev.payload.evidence_retained, true); assert.deepEqual(ev.payload.clear_evidence_document_ids, ["DOC-PAYOFF-4200"]); assert.equal(ev.payload.prior_status, "satisfied_pending_review");
  // messages still present are not superseded; a condition already cleared by evidence is untouched
  const again = supersedeDroppedConditions(events, [cleared, ...first.conditions.slice(1, 3)], new Set(["V1002", "V1003"]), { submission_id: "SUB-REFI-3", at: "2026-10-21T15:00:00.000Z" });
  assert.equal(again.superseded.length, 0); assert.equal(again.unchanged.length, 3);
});

test("23.2-T10: Given a casefile created Sept 24, 2026 that returned Approve/Eligible and a resubmission on Oct 2, 2026 returning Approve/Ineligible with no data change, then `du.recommendation.changed{cause=du_policy}` is recorded citing the June 26, 2026 release, and the outcome is `restructure_required`.", () => {
  const generation = policyGeneration(D("2026-09-24")); assert.equal(generation, "2026_06_27");   // 23.1: creation-keyed policy generation
  const drift = recommendationDrift({ prior: { recommendation: "approve_eligible", request_hash: "req-same" }, current: { recommendation: "approve_ineligible", request_hash: "req-same" }, policy_generation: generation })!;
  assert.equal(drift.cause, "du_policy"); assert.equal(drift.du_release, "2026_06_26"); assert.equal(drift.du_release_date, "2026-06-26"); assert.equal(drift.from, "approve_eligible"); assert.equal(drift.to, "approve_ineligible");
  assert.equal(recommendationDrift({ prior: { recommendation: "approve_eligible", request_hash: "a" }, current: { recommendation: "approve_ineligible", request_hash: "b" }, policy_generation: generation })!.cause, "data_change");
  assert.equal(recommendationDrift({ prior: { recommendation: "approve_ineligible", request_hash: "a" }, current: { recommendation: "approve_eligible", request_hash: "a" }, policy_generation: generation }), null);
  const events = new MemoryEventStore(new FixedClock("2026-10-02T16:00:00.000Z"), { applicationId: "APP-SEPT24" });
  const r = interpretFindings(events, interpretInput({ application_id: "APP-SEPT24", submission_id: "SUB-S24-2", submission_number: 2, recommendation: "approve_ineligible", messages: [msg("E5002", "eligibility", "LTV exceeds the maximum allowable for this transaction"), ...REFI_VERIFICATION.slice(0, 2)], policy_generation: generation, du_release: "2026-09-25", request_hash: "req-same", prior: { recommendation: "approve_eligible", request_hash: "req-same" }, findings_received_at: "2026-10-02T15:00:00.000Z", interpreted_at: "2026-10-02T16:00:00.000Z" }));
  assert.equal(r.interpretation.policy_outcome, "restructure_required"); assert.equal(r.interpretation.recommendation_drift?.cause, "du_policy");
  const ev = events.ofType("du.recommendation.changed")[0]!; assert.equal(ev.payload.cause, "du_policy"); assert.equal(ev.payload.du_release, "2026_06_26"); assert.equal(ev.payload.du_release_date, "2026-06-26"); assert.equal(ev.payload.policy_generation, "2026_06_27"); assert.equal(ev.payload.outcome, "restructure_required");
  assert.equal(policyOutcome("approve_ineligible", true), "restructure_required"); assert.equal(policyOutcome("approve_ineligible", false), "decline_candidate"); assert.equal(policyOutcome("out_of_scope", true), "out_of_policy_manual"); assert.equal(policyOutcome("error", true), "error");
});

test("23.2-T11: Given the refinance fixture MI message absent (LTV 70%), when 24.6 asks for coverage, then `mi_coverage_pct = null` and no MI condition exists; given a 92% LTV HomeReady loan, then `mi_coverage_pct = 25.00` (vs 30.00 standard) and `COND_DU_MI_CERT` is opened.", () => {
  assert.deepEqual(miCoverage(7000, "standard", 360), { required_pct: null, standard_pct: null, minimum_option_pct: null, band: null });
  assert.equal(miCoverage(9200, "homeready", 360).required_pct, "25.00"); assert.equal(miCoverage(9200, "standard", 360).required_pct, "30.00"); assert.equal(miCoverage(9200, "homeready", 360).standard_pct, "30.00"); assert.equal(miCoverage(9200, "homeready", 360).minimum_option_pct, "16.00");
  assert.equal(miCoverage(8996, "homeready", 360).required_pct, "25.00"); assert.equal(miCoverage(8996, "standard", 360).required_pct, "25.00");   // 85.01–90 % is 25 % under both tables
  assert.equal(miCoverage(9600, "homeready", 360).required_pct, "25.00"); assert.equal(miCoverage(9600, "standard", 360).required_pct, "35.00"); assert.equal(miCoverage(9200, "standard", 180).required_pct, "25.00");
  const events = new MemoryEventStore(new FixedClock("2026-10-06T13:12:00.000Z"));
  const refi = interpretFindings(events, interpretInput({ application_id: REFI, submission_id: "SUB-REFI-1", mi_requirement: { required: false, coverage_pct: null } }));
  assert.equal(refi.interpretation.mi_coverage_pct, null); assert.equal(refi.conditions.some((c) => c.category === "mi"), false);
  const mi1 = events.ofType("mi.requirement.set")[0]!; assert.equal(mi1.payload.mi_required, false); assert.equal(mi1.payload.mi_coverage_pct, null); assert.equal(mi1.payload.condition_id, null); assert.ok((mi1.payload.consumers as string[]).includes("24.6"));
  const hr = interpretFindings(events, interpretInput({ application_id: PURCHASE, submission_id: "SUB-HR-1", messages: [...REFI_VERIFICATION.slice(0, 3), msg("M2001", "mi", "Mortgage insurance coverage of 25% is required")], mi_requirement: { required: true, coverage_pct: "25.00" }, facts: { ...PURCHASE_FACTS, ltv_x100: 9200 }, interpreted_at: "2026-10-20T15:00:00.000Z" }));
  assert.equal(hr.interpretation.mi_coverage_pct, "25.00"); assert.equal(hr.interpretation.mi_standard_coverage_pct, "30.00");
  const cert = hr.conditions.find((c) => c.template_code === "COND_DU_MI_CERT")!; assert.equal(cert.stage, "ptd"); assert.equal(cert.category, "mi"); assert.deepEqual(cert.evidence_kinds, ["mi_certificate"]);
  const mi2 = events.ofType("mi.requirement.set")[1]!; assert.equal(mi2.payload.mi_coverage_pct, "25.00"); assert.equal(mi2.payload.standard_coverage_pct, "30.00"); assert.equal(mi2.payload.condition_id, cert.condition_id); assert.equal(mi2.payload.product, "homeready");
});

test("23.2-T12: Given a value-acceptance offer on the Oct 6 submission but none on the final-match submission Nov 3, then `value_acceptance_offer = none` on the interpretation used for delivery and 24.1 is notified that SFC 801 may not be used.", () => {
  const events = new MemoryEventStore(new FixedClock("2026-11-03T16:00:00.000Z"), { applicationId: REFI });
  const first = interpretFindings(events, interpretInput({ application_id: REFI, submission_id: "SUB-REFI-1", value_acceptance_offer: { offered: true, property_value_cents: 80_000_000n } }));
  assert.equal(first.interpretation.value_acceptance_offer, "value_acceptance"); assert.equal(first.interpretation.value_acceptance_offer_at, "2026-10-06T10:00:00.000Z"); assert.equal(first.interpretation.sfc_801_permitted, false);   // an interim offer is not yet exercisable
  const final = interpretFindings(events, interpretInput({ application_id: REFI, submission_id: "SUB-REFI-3", submission_number: 3, is_final: true, messages: REFI_VERIFICATION, value_acceptance_offer: null, request_hash: "req-3", findings_received_at: "2026-11-03T15:00:00.000Z", interpreted_at: "2026-11-03T16:00:00.000Z", prior_conditions: first.conditions }));
  assert.equal(final.interpretation.value_acceptance_offer, "none"); assert.equal(final.interpretation.value_acceptance_offer_at, null); assert.equal(final.interpretation.sfc_801_permitted, false); assert.ok(!final.interpretation.sfc_required.includes("801"));
  const delivery = deliveryOffer([first.interpretation, final.interpretation]); assert.equal(delivery.offer, "none"); assert.equal(delivery.sfc_801_permitted, false); assert.equal(delivery.from_submission, 3);
  const notices = events.ofType("value_acceptance.offer.received"); assert.equal(notices.length, 2);
  assert.equal(notices[1]!.payload.is_final, true); assert.equal(notices[1]!.payload.offer, "none"); assert.equal(notices[1]!.payload.sfc_801_permitted, false); assert.deepEqual(notices[1]!.payload.consumers, ["24.1"]);
  // the interim offer's condition (none for value acceptance) and the interim-only offer cannot be exercised; had the offer stayed on the final submission it would be
  const kept = interpretFindings(events, interpretInput({ application_id: REFI, submission_id: "SUB-REFI-4", submission_number: 4, is_final: true, value_acceptance_offer: { offered: true, property_value_cents: 80_000_000n }, request_hash: "req-4", findings_received_at: "2026-11-03T15:30:00.000Z", interpreted_at: "2026-11-03T16:00:00.000Z" }));
  assert.equal(kept.interpretation.sfc_801_permitted, true); assert.equal(deliveryOffer([first.interpretation, kept.interpretation]).sfc_801_permitted, true);
});

test("23.2 worked figures: refinance value $800,000.00 (LTV 70.00 %); purchase price $458,000.00, loan $412,000.00 at 6.375 %: P&I $2,570.34 + MI $137.33 + taxes $520.00 + insurance $95.00 + debts $410.00 = $3,732.67 → 44.44 % at $8,400.00, 53.32 % at $7,000.00; $380,000.00: $2,370.71 + $126.67 + $615.00 + $410.00 = $3,522.38 → 50.32 %; $360,000.00: $2,245.93 + $615.00 + $410.00 = $3,270.93 → 46.73 %; HomeReady $8,200.00/mo = $98,400.00 ≤ 80 % of $124,000.00 = $99,200.00; $100,800.00 fails", () => {
  const value_cents = 80_000_000n; assert.equal(loanLimitCheck(56_000_000n, 1, null).high_balance, false); assert.equal(pitiaFor({ ...purchaseFinancials(1_450_000n), loan_amount_cents: 56_000_000n, value_cents, purchase_price_cents: null, transaction_type: "limited_cash_out", product: "standard", note_rate_pct: "6.125" }).ltv_display, "70.00");
  const at8400 = pitiaFor(purchaseFinancials(840_000n));
  assert.equal(at8400.loan_amount_cents, 41_200_000n); assert.equal(at8400.ltv_display, "89.96"); assert.equal(at8400.pi_cents, 257_034n); assert.equal(at8400.mi_cents, 13_733n); assert.equal(at8400.taxes_cents, 52_000n); assert.equal(at8400.insurance_cents, 9_500n); assert.equal(at8400.debts_cents, 41_000n);
  assert.equal(at8400.obligations_cents, 373_267n); assert.equal(at8400.dti_bps, 4444); assert.equal(at8400.dti_display, "44.44"); assert.equal(at8400.mi_coverage_pct, "25.00");
  const at7000 = pitiaFor(purchaseFinancials(700_000n)); assert.equal(at7000.obligations_cents, 373_267n); assert.equal(at7000.dti_display, "53.32"); assert.equal(at7000.over_du_cap, true);
  const at380 = pitiaFor(purchaseFinancials(700_000n), 38_000_000n); assert.equal(at380.pi_cents, 237_071n); assert.equal(at380.mi_cents, 12_667n); assert.equal(at380.taxes_cents + at380.insurance_cents, 61_500n); assert.equal(at380.obligations_cents, 352_238n); assert.equal(at380.dti_display, "50.32"); assert.equal(at380.ltv_display, "82.97");
  const at360 = pitiaFor(purchaseFinancials(700_000n), 36_000_000n); assert.equal(at360.pi_cents, 224_593n); assert.equal(at360.mi_cents, 0n); assert.equal(at360.obligations_cents, 327_093n); assert.equal(at360.dti_display, "46.73"); assert.equal(at360.ltv_display, "78.60"); assert.equal(at360.mi_coverage_pct, null);
  const hr = evaluateHomeReady({ application_id: PURCHASE, property_fips: "39049", ami_source: "ami_api", ami_annual_cents: 12_400_000n, qualifying_monthly_income_cents: [820_000n], ami_dataset_version: "2026", evaluated_at: "2026-10-20T15:00:00.000Z" });
  assert.equal(hr.qualifying_income_annual_cents, 9_840_000n); assert.equal(hr.income_limit_annual_cents, 9_920_000n); assert.equal(hr.eligible, true);
  const over = evaluateHomeReady({ application_id: PURCHASE, property_fips: "39049", ami_source: "du_message", ami_annual_cents: 12_400_000n, qualifying_monthly_income_cents: [840_000n], ami_dataset_version: "2026", evaluated_at: "2026-10-20T15:00:00.000Z" });
  assert.equal(over.qualifying_income_annual_cents, 10_080_000n); assert.equal(over.eligible, false);
  assert.equal(computeRestructure(purchaseFinancials(700_000n)).recommended!.pitia.loan_amount_cents, 36_000_000n);
});
