// 24.5 Hazard, flood, and other property insurance (coverage, deductibles, carrier ratings, mortgagee clause, flood determination and notice, NFIP/private flood, condo master/HO-6, escrow implications)
// spec/sections/24-property-valuation-eligibility-title-hazard-flood-insurance/24-5-hazard-flood-and-other-property-insurance-coverage-deductibl.md
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
import { TOOLS_24_5 } from "../../app/tools/section24-5.ts";
import { assertGate, GateClosed } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { deductiblePct } from "../insurance/hazard.ts";
import { evaluateHazardAdequacy, hazardDeductibleMax, floodRequirement, evaluateFloodPolicy, evaluateRcbap, evaluateProjectInsurance, checkMortgageeClause, carrierRatingTest, seedEscrowLines, monthlyEscrowCents, floodNoticeGate, noticeEffectiveReceipt, earliestConsummationAfterNotice, parseSfhdf, sfhdfFormAccepted, receiveFloodDetermination, orderFloodDetermination, deliverFloodNotice, handOffToServicing, deliveryFloodData, MASTER_PER_UNIT_DEDUCTIBLE_MAX_CENTS, NFIP_OTHER_RESIDENTIAL_MAX, SFHDF_CONFIG_DEFAULT, type OrigHazardPolicy, type SfhdfResult, type FloodPolicyEvidence } from "./ops-24-5.ts";
import { NFIP_BUILDING_MAX, NFIP_MAX_DEDUCTIBLE } from "../insurance/flood.ts";

const AGENT: Actor = { kind: "agent", id: "title-closing" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const PARTNER = { legal_name: "Partner Bank, N.A." };
const CLAUSE_OK = "Partner Bank, N.A., its successors and/or assigns, c/o Supermortgage, P.O. Box 7900, Phoenix AZ 85011";
const TITLE = ["Alex Fixture", "Jordan Fixture"];
/** Refinance fixture: $560,000 LCOR, Phoenix AZ, escrowed; insurer's replacement-cost estimate $520,000; consummation Fri Nov 6, 2026, disbursement Thu Nov 12. */
const REFI = { app: "APP-REFI-1", loan: "L-REFI-1", property: "PROP-REFI-1", upb: 56_000_000n, rcv: 52_000_000n, consummation: D("2026-11-06"), disbursement: D("2026-11-12") };
/** Purchase fixture: $412,000, Columbus OH; application Mon Oct 19, closing Wed Nov 18, 2026. */
const PUR = { app: "APP-PUR-1", loan: "L-PUR-1", property: "PROP-PUR-1", upb: 41_200_000n, application_date: D("2026-10-19"), consummation: D("2026-11-18") };

/** The refinance fixture's hazard declarations: dwelling $520,000 replacement cost (roof ACV), Special form, AM Best A, $5,000 deductible, 2% wind/hail deductible, effective Nov 1, 2026 in force. */
const hazardPolicy = (over: Partial<OrigHazardPolicy> = {}): OrigHazardPolicy => ({ policy_id: "HZ-REFI-1", policy_kind: "hazard", policy_number: "HO-4471-2026", carrier: "Desert Mutual", coverage_dwelling_cents: 52_000_000n, coverage_basis: "replacement_cost", roof_basis: "acv", coverage_form: "special", deductible_cents: 500_000n, per_peril_deductibles: [{ peril: "windstorm_hail", pct: "2" }],
  ratings: [{ agency: "am_best", grade: "A" }], mortgagee_clause_text: CLAUSE_OK, named_insureds: TITLE, effective_date: D("2026-11-01"), expiration_date: D("2027-11-01"), first_year_premium_cents: 195_000n, policy_in_force: true, premium_paid_through: D("2027-11-01"), evidence_kind: "declarations", evidence_document_id: "DOC-HZ-1", ...over });
const policyInput = (over: Partial<OrigHazardPolicy> = {}): Record<string, unknown> => { const p = hazardPolicy(over); return { ...p, coverage_dwelling_cents: p.coverage_dwelling_cents.toString(), deductible_cents: p.deductible_cents.toString(), first_year_premium_cents: p.first_year_premium_cents.toString() }; };
const AE: SfhdfResult = { certificate_id: "SFHDF-AE-1", zone: "AE", map_panel: "04013C2210M", map_date: D("2020-10-16"), community_number: "040051", community_name: "City of Phoenix", community_participating: true, program_status: "regular", structures: [{ kind: "principal", in_sfha: true, zone: "AE" }], lol_purchased: true, sfhdf_form_version: "FF-206-FY-21-116", sfhdf_document_id: "DOC-SFHDF-1", vendor_ref: "CTL-9917" };
const ZONE_X: SfhdfResult = { ...AE, certificate_id: "SFHDF-X-1", zone: "X", structures: [{ kind: "principal", in_sfha: false, zone: "X" }], sfhdf_document_id: "DOC-SFHDF-2" };

/** The 24.5 tools on the bus over the overridden registry (24.5 rows only), a memory ledger and the escalation service; the harness appends the upstream events (24.4 / 26.1 / 26.3) with origination context. */
function harness(nowIso: string, fx: { app: string; loan: string } = REFI) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId: fx.app });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["24.5"] });
  const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: fx.loan, applicationId: fx.app, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  rt.store.put("applications", fx.app, { partner_legal_name: PARTNER.legal_name, project_type: "detached" }, OFFICER, nowIso);
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_24_5); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("24.5", name))!, actor, { application_id: fx.app, ...input }, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === fx.app);
  const upstream = (type: string, payload: Record<string, unknown>, actor: Actor = { kind: "agent", id: "closer" }) => events.append({ type, applicationId: fx.app, aggregate: { kind: "application", id: fx.app }, actor, payload: { application_id: fx.app, source: "origination", ...payload } });
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  /** Title ordered → determination ordered the same day (INT-O5-1: Tue Oct 6, 2026) → the SFHDF received. */
  const determination = async (sfhdf: SfhdfResult, orderedAt = "2026-10-06T16:00:00.000Z", receivedAt = "2026-10-06T19:30:00.000Z") => { at(orderedAt); upstream("title.ordered", { ordered_at: orderedAt, property_id: "PROP-1" }); await run("orderFloodDetermination", { property_id: "PROP-1", address_hash: "sha256:phx-4120", fee_gate_result: "open", ordered_at: orderedAt }); at(receivedAt); return run("parseSFHDF", { sfhdf, received_at: receivedAt }); };
  return { rt, uow, events, timers, run, at, timer, ofType, upstream, refused, determination, decisions };
}
const requirement = (h: ReturnType<typeof harness>, at: string, flood: { in_sfha: boolean } | null = null) => h.run("computeInsuranceRequirements", { computed_at: at, facts: { computed_from: "du_findings", property: { units: 1, project_type: "detached" }, hazard: { coverage_dwelling_cents: "52000000" }, flood: flood ? { in_sfha: flood.in_sfha, rcv_improvements_cents: "52000000", note_amount_cents: "56000000" } : undefined } });

test("24.5-T1: Given the refinance fixture with dwelling coverage $520,000 on a replacement-cost basis (roof ACV), Special form, AM Best A carrier, deductible $5,000, wind deductible 2%, when evaluated, then `verified` with `hazard_deductible_max_cents=2600000` and all tests PASS.", async () => {
  const h = harness("2026-10-07T17:00:00.000Z");
  // DU findings Wed Oct 7 → the requirement record (rule 1) with the 5% cap on the carrier's $520,000 dwelling coverage; SM_INSURANCE_EVIDENCE_REQUEST_3BD arms (+3 business_days_creditor → Mon Oct 12 is Columbus Day → Tue Oct 13)
  const req = (await requirement(h, "2026-10-07T17:00:00.000Z")).requirement as { hazard_deductible_max_cents: bigint; rule_set: string; flood_required: boolean };
  assert.equal(req.hazard_deductible_max_cents, 2_600_000n); assert.equal(req.rule_set, "fnma.insurance.2026-08"); assert.equal(req.flood_required, false);
  assert.equal(h.timer("SM_INSURANCE_EVIDENCE_REQUEST_3BD")?.status, "armed"); assert.equal(h.timer("SM_INSURANCE_EVIDENCE_REQUEST_3BD")?.dueDate, "2026-10-13");
  await h.run("requestEvidence", { kinds: ["declarations"], to: "borrower_agent", requested_at: "2026-10-07T17:05:00.000Z" });
  assert.equal(h.timer("SM_INSURANCE_EVIDENCE_REQUEST_3BD")?.status, "satisfied");
  // the declarations page (extraction ≥ 0.90 on every critical field → no carrier confirmation) evaluated Thu Oct 22
  h.at("2026-10-22T15:00:00.000Z");
  const ex = await h.run("extractEvidence", { kind: "declarations", document_id: "DOC-HZ-1", fields: { deductible: "5000" }, confidence: { policy_number: 0.99, effective_date: 0.98, expiration_date: 0.98, coverage_amount: 0.97, deductible: 0.95, mortgagee_clause: 0.93, property_address: 0.99 } });
  assert.deepEqual(ex.confirmation_required, []);
  const r = await h.run("evaluateAdequacy", { policy: policyInput(), title_holders: TITLE, transaction_type: "refinance", disbursement_date: "2026-11-12", verified_at: "2026-10-22T15:00:00.000Z" });
  assert.equal(r.status, "verified"); assert.deepEqual(r.deficiencies, []); assert.equal(r.hazard_deductible_max_cents, 2_600_000n);
  const tests = r.tests as Record<string, string>; assert.ok(Object.keys(tests).length >= 8); for (const [k, v] of Object.entries(tests)) assert.equal(v, "PASS", `${k} PASS`);
  assert.equal(r.deductible_pct, "0.009615");   // $5,000 ÷ $520,000 compared without rounding
  const ev = h.ofType("insurance.policy.verified").at(-1)!; assert.equal(ev.payload.policy_kind, "hazard"); assert.equal(ev.payload.rule_set, "fnma.insurance.2026-08"); assert.equal(ev.payload.stage, "origination");
  assert.equal(h.rt.store.get("insurance_policies", "HZ-REFI-1")!.data.status, "verified");
  // FNMA_B7_3_02_HAZARD_EVIDENCE_GATE arms on 26.3's funding.authorized request and is satisfied by the hazard verification; the gate itself is open for the Nov 12 disbursement
  h.upstream("funding.authorized", { requested_at: "2026-11-12T15:00:00.000Z", disbursement_date: "2026-11-12" });
  assert.equal(h.timer("FNMA_B7_3_02_HAZARD_EVIDENCE_GATE")?.status, "armed");
  await h.run("evaluateAdequacy", { policy: policyInput(), title_holders: TITLE, transaction_type: "refinance", disbursement_date: "2026-11-12", verified_at: "2026-11-12T15:01:00.000Z" });
  assert.equal(h.timer("FNMA_B7_3_02_HAZARD_EVIDENCE_GATE")?.status, "satisfied");
  const gates = (await h.run("evaluateGates", { disbursement_date: "2026-11-12", transaction_type: "refinance" })).gates as Record<string, { open: boolean }>;
  assert.equal(gates.FNMA_B7_3_02_HAZARD_EVIDENCE_GATE!.open, true); assert.equal(gates.FNMA_B7_3_03_PROJECT_INSURANCE_GATE!.open, true, "detached: project gate not applicable");
  // guardrail: never mark a policy adequate without the carrier-rating and mortgagee-clause checks
  await h.refused(h.run("evaluateAdequacy", { policy: policyInput(), skip_rating_check: true }), "ADEQUACY_NEEDS_RATING_AND_CLAUSE_CHECKS");
});

test("24.5-T2: Given the same policy with a named-storm deductible of 6% ($31,200), when evaluated, then `deductible_excess` deficiency; given exactly 5% ($26,000), then PASS.", async () => {
  const h = harness("2026-10-22T15:00:00.000Z");
  const six = await h.run("evaluateAdequacy", { policy: policyInput({ policy_id: "HZ-REFI-6", per_peril_deductibles: [{ peril: "windstorm_hail", pct: "2" }, { peril: "named_storm", cents: 3_120_000n }] }), title_holders: TITLE, transaction_type: "refinance" });
  assert.equal(six.status, "deficient"); assert.deepEqual(six.deficiencies, ["deductible_excess"]); assert.equal((six.tests as Record<string, string>).per_peril_deductibles_le_5pct, "FAIL");
  assert.equal(deductiblePct(3_120_000n, 52_000_000n).toFixed(4), "0.0600");
  const def = h.ofType("insurance.deficiency.opened").at(-1)!; assert.equal(def.payload.kind, "deductible_excess"); assert.equal(def.payload.stage, "origination"); assert.equal(def.payload.condition, "ptf");
  assert.equal(h.rt.store.list("insurance_deficiencies", (d) => d.kind === "deductible_excess").length, 1);
  // exactly 5% ($26,000 = 5.0000% of $520,000) passes — compared without rounding
  const five = await h.run("evaluateAdequacy", { policy: policyInput({ policy_id: "HZ-REFI-5", per_peril_deductibles: [{ peril: "windstorm_hail", pct: "2" }, { peril: "hurricane", cents: 2_600_000n }] }), title_holders: TITLE, transaction_type: "refinance" });
  assert.equal(five.status, "verified"); assert.deepEqual(five.deficiencies, []); assert.equal((five.tests as Record<string, string>).per_peril_deductibles_le_5pct, "PASS");
  assert.equal(deductiblePct(2_600_000n, 52_000_000n).cmp(Decimal.parse("0.05")), 0);
  // the pure rule agrees, and the 6% percentage form fails too
  assert.deepEqual(evaluateHazardAdequacy(hazardPolicy({ per_peril_deductibles: [{ peril: "named_storm", pct: "6" }] }), { title_holders: TITLE, partner: PARTNER }).deficiencies, ["deductible_excess"]);
});

test("24.5-T3: Given a policy written on an actual-cash-value basis for the dwelling, when evaluated, then `acv_dwelling` deficiency (roof ACV alone would pass).", async () => {
  const h = harness("2026-10-22T15:00:00.000Z");
  const acv = await h.run("evaluateAdequacy", { policy: policyInput({ policy_id: "HZ-ACV", coverage_basis: "acv", roof_basis: "acv" }), title_holders: TITLE, transaction_type: "refinance" });
  assert.equal(acv.status, "deficient"); assert.deepEqual(acv.deficiencies, ["acv_dwelling"]); assert.equal((acv.tests as Record<string, string>).coverage_basis_replacement_cost, "FAIL");
  assert.equal(h.ofType("insurance.deficiency.opened").at(-1)!.payload.kind, "acv_dwelling");
  // LL-2026-03: "Roofs must be insured, but do not have to be insured on a replacement cost basis" — roof ACV alone passes
  const roof = evaluateHazardAdequacy(hazardPolicy({ coverage_basis: "replacement_cost", roof_basis: "acv" }), { title_holders: TITLE, partner: PARTNER });
  assert.equal(roof.pass, true); assert.equal(roof.tests.roof_basis, "PASS"); assert.equal(roof.tests.coverage_basis_replacement_cost, "PASS");
  // extended / guaranteed replacement cost are replacement-cost bases too; no amount test against the $560,000 UPB is applied (retired)
  assert.equal(evaluateHazardAdequacy(hazardPolicy({ coverage_basis: "guaranteed_rc", coverage_dwelling_cents: 40_000_000n, deductible_cents: 100_000n }), { title_holders: TITLE, partner: PARTNER }).pass, true);
});

test("24.5-T4: Given a Zone AE determination received Tue Oct 6, 2026 and the notice e-signed Wed Oct 7, when consummation is Fri Nov 6, then `FDPA_4104A_FLOOD_NOTICE_GATE` passes (30 days); given the notice first delivered Mon Nov 2, then the gate fails and `consummate` is refused unless the short-period path (reason + acknowledgment) is recorded.", async () => {
  const h = harness("2026-10-06T16:00:00.000Z");
  const det = await h.determination(AE);
  assert.equal(det.status, "notice_due"); assert.equal(det.in_sfha, true); assert.equal(det.sfc_180, false); assert.equal(det.notice_required, true);
  // title.ordered armed SM_FLOOD_DETERMINATION_ORDER_1BD (+1 business_days_creditor → Wed Oct 7); the same-day receipt satisfied it
  assert.equal(h.timer("SM_FLOOD_DETERMINATION_ORDER_1BD")?.dueDate, "2026-10-07"); assert.equal(h.timer("SM_FLOOD_DETERMINATION_ORDER_1BD")?.status, "satisfied");
  // `flood.determination.received{in_sfha=true}` armed the notice gate and the 1-BD delivery clock (anchor Tue Oct 6 → due Wed Oct 7)
  assert.equal(h.timer("FDPA_4104A_FLOOD_NOTICE_GATE")?.status, "armed"); assert.equal(h.timer("SM_FLOOD_NOTICE_DELIVER_1BD")?.status, "armed"); assert.equal(h.timer("SM_FLOOD_NOTICE_DELIVER_1BD")?.dueDate, "2026-10-07");
  // Wed Oct 7: rendered and e-delivered under E-SIGN scope flood_notice, e-sign confirmed the same day → effective receipt Oct 7
  h.at("2026-10-07T15:00:00.000Z");
  const rendered = await h.run("renderFloodNotice", { borrower_names: TITLE, property_address: "4120 N 44th St, Phoenix AZ 85018", loan_number_last4: "0917", notice_date: "2026-10-07", scheduled_consummation_date: "2026-11-06" });
  assert.equal(rendered.template_code, "NTC_FDPA_4104A_FLOOD_NOTICE"); assert.equal((rendered.payload as Record<string, unknown>).flood_zone, "AE");
  const del = await h.run("deliverNotice", { channel: "esign", notice_document_id: "DOC-FLOOD-NOTICE-1", delivered_at: "2026-10-07T15:10:00.000Z", esign_confirmed_at: "2026-10-07T18:40:00.000Z", scheduled_consummation_date: "2026-11-06", esign_consent_scope: "flood_notice" });
  assert.equal(del.effective_receipt_date, "2026-10-07"); assert.equal(del.days_before_consummation, 30); assert.equal(del.reasonable_period_ok, true); assert.equal(del.status, "notice_delivered");
  assert.equal(h.timer("SM_FLOOD_NOTICE_DELIVER_1BD")?.status, "satisfied"); assert.equal(h.timer("FDPA_4104A_FLOOD_NOTICE_GATE")?.status, "satisfied");
  const gates = (await h.run("evaluateGates", { consummation_date: "2026-11-06" })).gates as Record<string, { open: boolean; reason?: string }>;
  assert.equal(gates.FDPA_4104A_FLOOD_NOTICE_GATE!.open, true);
  assert.deepEqual(floodNoticeGate({ in_sfha: true, consummation_date: REFI.consummation, effective_receipt_date: D("2026-10-07") }), { open: true, days_before_consummation: 30, path: "standard", earliest_consummation: "2026-10-17" });
  // purchase fixture: determination Mon Oct 19, notice Tue Oct 20, closing Wed Nov 18 → 29 days
  assert.equal(floodNoticeGate({ in_sfha: true, consummation_date: PUR.consummation, effective_receipt_date: D("2026-10-20") }).days_before_consummation, 29);
  // a mailed notice takes the mailbox rule: mailed Wed Oct 7 → received Sat Oct 10 (+3 business_days_regz_specific counts Saturday)
  assert.equal(noticeEffectiveReceipt({ delivered_on: D("2026-10-07"), channel: "mail" }).effective_receipt_date, "2026-10-10");

  // Variant: the notice first delivered Mon Nov 2 for the Nov 6 consummation → 4 days → the gate fails; `consummate` is refused
  const late = harness("2026-10-06T16:00:00.000Z"); await late.determination(AE); late.at("2026-11-02T16:00:00.000Z");
  const l = await late.run("deliverNotice", { channel: "esign", notice_document_id: "DOC-FLOOD-NOTICE-2", delivered_at: "2026-11-02T16:00:00.000Z", esign_confirmed_at: "2026-11-02T16:30:00.000Z", scheduled_consummation_date: "2026-11-06" });
  assert.equal(l.days_before_consummation, 4); assert.equal(l.reasonable_period_ok, false); assert.equal(l.earliest_consummation, "2026-11-12", "the agent either moves consummation to ≥ Thu Nov 12 …");
  assert.equal(earliestConsummationAfterNotice(D("2026-11-02")), "2026-11-12");
  const lateGates = (await late.run("evaluateGates", { consummation_date: "2026-11-06" })).gates as Record<string, { open: boolean; reason?: string }>;
  assert.equal(lateGates.FDPA_4104A_FLOOD_NOTICE_GATE!.open, false); assert.match(lateGates.FDPA_4104A_FLOOD_NOTICE_GATE!.reason!, /4 days before consummation/);
  const facts = { in_sfha: true, consummation_date: "2026-11-06", effective_receipt_date: "2026-11-02" };
  assert.throws(() => assertGate("24.5.floodNoticeGate", facts), GateClosed);
  // … or records the reason and obtains the borrower's acknowledgment before signing (24.5-Q1) → the short-period path opens the gate
  late.at("2026-11-03T15:00:00.000Z");
  await late.run("deliverNotice", { op: "acknowledge", acknowledged_at: "2026-11-03T15:00:00.000Z", method: "esign", short_period_reason: "SFHA discovered on the Nov 2 map-revision reissue; borrower declined the rescheduling offer", before_signing: true });
  assert.equal(late.ofType("flood.notice.acknowledged").length, 1);
  const shortGates = (await late.run("evaluateGates", { consummation_date: "2026-11-06" })).gates as Record<string, { open: boolean }>;
  assert.equal(shortGates.FDPA_4104A_FLOOD_NOTICE_GATE!.open, true);
  assert.doesNotThrow(() => assertGate("24.5.floodNoticeGate", { ...facts, short_period_reason: "map revision", acknowledged_on: "2026-11-03", acknowledged_before_signing: true }));
  // never for a purchase contract signed after the determination without the notice
  assert.equal(floodNoticeGate({ in_sfha: true, consummation_date: REFI.consummation, effective_receipt_date: D("2026-11-02"), short_period_reason: "x", acknowledged_on: D("2026-11-03"), purchase_contract_signed_after_determination_without_notice: true }).open, false);
  // guardrail: the notice is never skipped on an SFHA loan
  await late.refused(late.run("renderFloodNotice", { borrower_names: TITLE, property_address: "x", skip_notice: true }), "FLOOD_NOTICE_NEVER_SKIPPED");
});

test("24.5-T5: Given Zone AE, RCV $520,000, UPB $560,000, when the requirement is computed, then `flood_required_amount_cents=25000000` and `flood_deductible_max_cents=1000000`; an NFIP policy of $250,000 with a $5,000 deductible applied and paid Nov 5 passes; a $200,000 policy fails (`flood_insufficient`).", async () => {
  const h = harness("2026-10-06T16:00:00.000Z"); await h.determination(AE);
  h.at("2026-10-07T17:00:00.000Z");
  const req = (await requirement(h, "2026-10-07T17:00:00.000Z", { in_sfha: true })).requirement as { flood_required: boolean; flood_required_amount_cents: bigint; flood_deductible_max_cents: bigint; nfip_max_cents: bigint };
  assert.equal(req.flood_required, true); assert.equal(req.flood_required_amount_cents, 25_000_000n); assert.equal(req.flood_deductible_max_cents, 1_000_000n); assert.equal(req.nfip_max_cents, 25_000_000n);
  assert.deepEqual(await h.run("computeFloodAmount", { rcv_improvements_cents: "52000000", note_amount_cents: "56000000" }), { flood_required_amount_cents: 25_000_000n, flood_deductible_max_cents: 1_000_000n, nfip_max_cents: 25_000_000n });
  assert.deepEqual(floodRequirement({ rcv_improvements_cents: 52_000_000n, note_amount_cents: 56_000_000n }), { flood_required_amount_cents: NFIP_BUILDING_MAX, flood_deductible_max_cents: NFIP_MAX_DEDUCTIBLE, nfip_max_cents: 25_000_000n });
  // 26.1 schedules the closing → FNMA_B7_3_06_FLOOD_COVERAGE_GATE arms; the NFIP Dwelling Form policy applied for and paid Thu Nov 5 (44 CFR 61.11: at or prior to the loan closing) passes
  h.upstream("closing.scheduled", { scheduled_consummation_date: "2026-11-06", transaction_type: "refinance" });
  assert.equal(h.timer("FNMA_B7_3_06_FLOOD_COVERAGE_GATE")?.status, "armed");
  h.at("2026-11-05T21:00:00.000Z");
  const NFIP_POLICY: FloodPolicyEvidence = { policy_id: "FL-NFIP-1", nfip: true, building_coverage_cents: 25_000_000n, deductible_cents: 500_000n, applied_on: D("2026-11-05"), premium_paid_on: D("2026-11-05"), effective_date: D("2026-11-06"), expiration_date: D("2027-11-06"), annual_premium_cents: 115_000n, mortgagee_clause_text: CLAUSE_OK, evidence_kind: "flood_declarations", evidence_document_id: "DOC-FLOOD-DEC-1" };
  const nfip = { ...NFIP_POLICY, building_coverage_cents: "25000000", deductible_cents: "500000", annual_premium_cents: "115000" };
  const ok = await h.run("computeFloodAmount", { op: "verify", policy: nfip, closing_date: "2026-11-06", transaction_type: "purchase", verified_at: "2026-11-05T21:00:00.000Z" });
  assert.equal(ok.pass, true); assert.equal(ok.status, "verified"); assert.equal(ok.flood_status, "coverage_verified"); assert.equal(ok.required_cents, 25_000_000n);
  const fv = h.ofType("flood.coverage.verified").at(-1)!; assert.equal(fv.payload.amount_cents, "25000000"); assert.equal(fv.payload.required_cents, "25000000"); assert.equal(fv.payload.premium_paid_on, "2026-11-05");
  assert.equal(h.timer("FNMA_B7_3_06_FLOOD_COVERAGE_GATE")?.status, "satisfied");
  assert.equal(((await h.run("evaluateGates", { consummation_date: "2026-11-06" })).gates as Record<string, { open: boolean }>).FNMA_B7_3_06_FLOOD_COVERAGE_GATE!.open, true);
  // a $200,000 policy is short of the $250,000 requirement → flood_insufficient
  const two = harness("2026-10-06T16:00:00.000Z"); await two.determination(AE); two.at("2026-11-05T21:00:00.000Z");
  const short = await two.run("computeFloodAmount", { op: "verify", policy: { ...nfip, policy_id: "FL-NFIP-2", building_coverage_cents: "20000000" }, rcv_improvements_cents: "52000000", note_amount_cents: "56000000", closing_date: "2026-11-06", verified_at: "2026-11-05T21:00:00.000Z" });
  assert.equal(short.pass, false); assert.deepEqual(short.deficiencies, ["flood_insufficient"]); assert.equal(short.flood_status, "coverage_pending");
  assert.equal(two.ofType("flood.coverage.verified").length, 0); assert.equal(two.ofType("insurance.deficiency.opened").at(-1)!.payload.kind, "flood_insufficient");
  assert.equal(((await two.run("evaluateGates", { consummation_date: "2026-11-06" })).gates as Record<string, { open: boolean }>).FNMA_B7_3_06_FLOOD_COVERAGE_GATE!.open, false);
  // rule 6: an NFIP policy without the application and premium at or before closing is never accepted
  const noPay = evaluateFloodPolicy({ ...NFIP_POLICY, premium_paid_on: null }, { flood_required_amount_cents: 25_000_000n, flood_deductible_max_cents: 1_000_000n }, { closing_date: REFI.consummation, partner: PARTNER });
  assert.deepEqual(noPay.deficiencies, ["nfip_not_applied_paid_at_closing"]);
  await two.refused(two.run("computeFloodAmount", { op: "verify", policy: nfip, closing_date: "2026-11-06", accept_without_premium_evidence: true }), "NFIP_NEEDS_APPLICATION_AND_PREMIUM_AT_CLOSING");
  // a deductible above the $10,000 NFIP option fails on the deductible
  assert.deepEqual(evaluateFloodPolicy({ ...NFIP_POLICY, deductible_cents: 1_500_000n }, { flood_required_amount_cents: 25_000_000n, flood_deductible_max_cents: 1_000_000n }, { closing_date: REFI.consummation, partner: PARTNER }).deficiencies, ["flood_deductible"]);
  // 2–4 units fall under "other residential" ($500,000)
  assert.equal(floodRequirement({ rcv_improvements_cents: 80_000_000n, note_amount_cents: 60_000_000n, units: 2 }).nfip_max_cents, NFIP_OTHER_RESIDENTIAL_MAX);
});

test("24.5-T6: Given a 40-unit RCBAP with RCV $12,000,000 and coverage $9,600,000 and a unit with UPB $412,000, when evaluated, then the building passes (80% rule) and the unit requires a $10,000 supplemental policy (`flood_insufficient` until provided).", async () => {
  const r = evaluateRcbap({ units: 40, rcv_building_cents: 1_200_000_000n, rcbap_coverage_cents: 960_000_000n, unit_upb_cents: 41_200_000n });
  assert.equal(r.eighty_pct_rcv_cents, 960_000_000n); assert.equal(r.nfip_units_max_cents, 1_000_000_000n); assert.equal(r.required_rcbap_cents, 960_000_000n, "min(80% × $12,000,000; $250,000 × 40)");
  assert.equal(r.building_pass, true); assert.equal(r.allocation_cents, 24_000_000n, "per-unit allocation $240,000");
  assert.equal(r.unit_requirement_cents, 25_000_000n, "min(unit RCV share $300,000, $250,000, UPB $412,000)"); assert.equal(r.supplemental_required_cents, 1_000_000n);
  assert.equal(r.unit_pass, false); assert.equal(r.deficiency, "flood_insufficient");
  // the supplemental unit policy of ≥ $10,000 clears it
  const withSupp = evaluateRcbap({ units: 40, rcv_building_cents: 1_200_000_000n, rcbap_coverage_cents: 960_000_000n, unit_upb_cents: 41_200_000n, supplemental_unit_policy_cents: 1_000_000n });
  assert.equal(withSupp.unit_pass, true); assert.equal(withSupp.deficiency, null);
  // a building short of the 80% rule fails outright
  assert.equal(evaluateRcbap({ units: 40, rcv_building_cents: 1_200_000_000n, rcbap_coverage_cents: 900_000_000n, unit_upb_cents: 41_200_000n }).building_pass, false);
  const h = harness("2026-11-10T15:00:00.000Z", PUR);
  const viaBus = await h.run("evaluateAdequacy", { op: "rcbap", facts: { units: 40, rcv_building_cents: "1200000000", rcbap_coverage_cents: "960000000", unit_upb_cents: "41200000" } });
  assert.equal(viaBus.supplemental_required_cents, 1_000_000n); assert.equal(viaBus.deficiency, "flood_insufficient");
});

test("24.5-T7: Given a condo master policy with a $60,000 per-unit deductible on an application dated Oct 19, 2026, when evaluated, then FAIL (cap $50,000); given $25,000 and an HO-6 of $40,000 with a $2,500 deductible, then PASS.", async () => {
  const h = harness("2026-11-10T15:00:00.000Z", PUR);
  const master = (perUnit: string) => ({ policy_id: "MP-COL-1", rcv_cents: "1200000000", coverage_cents: "1200000000", rcv_documentation: "insurer_statement", coverage_form: "special", deductible_cents: "25000000", per_unit_deductible_cents: perUnit, covers_interior: false, condo_association_form_endorsed: true, evidence_document_id: "DOC-MASTER-1" });
  const liability = { coverage_cents: "100000000", separation_of_insureds: true, evidence_document_id: "DOC-LIAB-1" }; const fidelity = { coverage_cents: "9000000", evidence_document_id: "DOC-FID-1" };
  const ho6 = { policy_id: "HO6-COL-1", coverage_cents: "4000000", deductible_cents: "250000", restoration_estimate_cents: "4000000", evidence_document_id: "DOC-HO6-1" };
  // $60,000 per-unit deductible → FAIL the $50,000 cap (master_lapse-class deficiency; the project must amend or the unit is ineligible)
  const fail = await h.run("evaluateAdequacy", { op: "project", facts: { application_date: "2026-10-19", project_type: "condo", units_total: 40, master: master("6000000"), ho6, liability, fidelity, fidelity_need_cents: "8500000" }, verified_at: "2026-11-10T15:00:00.000Z" });
  assert.equal(fail.pass, false); assert.ok((fail.deficiencies as string[]).includes("master_lapse")); assert.equal((fail.tests as Record<string, string>).master_per_unit_deductible_le_50000, "FAIL"); assert.equal(fail.mandatory_rules_apply, true, "application Oct 19, 2026 ≥ July 1, 2026");
  assert.equal(fail.master_per_unit_deductible_max_cents, MASTER_PER_UNIT_DEDUCTIBLE_MAX_CENTS); assert.equal(MASTER_PER_UNIT_DEDUCTIBLE_MAX_CENTS, 5_000_000n);
  // the $60,000 per-unit deductible also lifts the HO-6 minimum to max($40,000, $60,000) = $60,000, so the $40,000 HO-6 is short until the project amends
  assert.deepEqual(fail.deficiencies, ["master_lapse", "ho6_insufficient"]);
  assert.equal(h.ofType("project.insurance.verified").length, 0); assert.deepEqual(h.ofType("insurance.deficiency.opened").map((e) => e.payload.kind), ["master_lapse", "ho6_insufficient"]);
  // the project amends the master policy; the corrected certificate cures both deficiencies (rule 9: cured / waived_by_policy / withdrawn only)
  for (const row of h.rt.store.list("insurance_deficiencies", (d) => d.resolved_at === null)) await h.run("openDeficiency", { op: "clear", deficiency_id: row.id, resolution: "cured", evidence_document_id: "DOC-MASTER-2", resolved_at: "2026-11-10T15:03:00.000Z" });
  assert.equal(h.ofType("insurance.deficiency.cleared").length, 2); assert.equal(h.rt.store.list("insurance_deficiencies", (d) => d.resolved_at === null).length, 0);
  // $25,000 per-unit deductible (2.08% master deductible) → HO-6 required: ≥ max($40,000 restoration, $25,000) = $40,000; deductible ≤ max(5% × $40,000 = $2,000; $2,500) = $2,500 → PASS
  h.upstream("funding.authorized", { requested_at: "2026-11-18T15:00:00.000Z", project_type: "condo" });
  assert.equal(h.timer("FNMA_B7_3_03_PROJECT_INSURANCE_GATE")?.status, "armed");
  const pass = await h.run("evaluateAdequacy", { op: "project", facts: { application_date: "2026-10-19", project_type: "condo", units_total: 40, master: master("2500000"), ho6, liability, fidelity, fidelity_need_cents: "8500000" }, verified_at: "2026-11-10T15:05:00.000Z" });
  assert.equal(pass.pass, true); assert.deepEqual(pass.deficiencies, []); assert.equal(pass.ho6_required, true); assert.equal(pass.ho6_min_amount_cents, 4_000_000n); assert.equal(pass.ho6_deductible_max_cents, 250_000n); assert.equal(pass.master_deductible_max_cents, 60_000_000n);
  assert.equal(h.ofType("project.insurance.verified").length, 1); assert.equal(h.timer("FNMA_B7_3_03_PROJECT_INSURANCE_GATE")?.status, "satisfied");
  assert.equal(((await h.run("evaluateGates", { project_type: "condo" })).gates as Record<string, { open: boolean }>).FNMA_B7_3_03_PROJECT_INSURANCE_GATE!.open, true);
  // the pure rule: an HO-6 deductible of $2,600 fails; a $2,500 HO-6 deductible passes even though 5% × $40,000 is only $2,000
  const base = { application_id: PUR.app, application_date: PUR.application_date, project_type: "condo" as const, units_total: 40, master: { policy_id: "MP", rcv_cents: 1_200_000_000n, coverage_cents: 1_200_000_000n, rcv_documentation: "insurer_statement" as const, coverage_form: "special" as const, deductible_cents: 25_000_000n, per_unit_deductible_cents: 2_500_000n, covers_interior: false, evidence_document_id: "DOC-MASTER-1" }, liability: { coverage_cents: 100_000_000n, separation_of_insureds: true, evidence_document_id: "DOC-LIAB-1" }, fidelity: { coverage_cents: 9_000_000n, evidence_document_id: "DOC-FID-1" }, fidelity_need_cents: 8_500_000n };
  assert.deepEqual(evaluateProjectInsurance({ ...base, ho6: { policy_id: "HO6", coverage_cents: 4_000_000n, deductible_cents: 260_000n, restoration_estimate_cents: 4_000_000n, evidence_document_id: "DOC-HO6-1" } }).deficiencies, ["ho6_deductible_excess"]);
  assert.deepEqual(evaluateProjectInsurance({ ...base, ho6: null }).deficiencies, ["unit_policy_missing"]);
  // guardrail: the $50,000 / 5% / $2,500 tests are never overridden
  await h.refused(h.run("evaluateAdequacy", { op: "project", facts: { application_date: "2026-10-19", project_type: "condo", units_total: 40, master: master("6000000"), ho6, liability, fidelity }, override_50000_cap: true }), "MASTER_HO6_TESTS_NEVER_OVERRIDDEN");
});

test("24.5-T8: Given a mortgagee clause naming \"MERS as nominee for [Partner]\", when checked, then `mortgagee_clause` deficiency; given \"[Partner], its successors and/or assigns, c/o Supermortgage, P.O. Box …\", then PASS (with or without \"as their interests may appear\").", async () => {
  const h = harness("2026-10-22T15:00:00.000Z");
  const mers = await h.run("checkMortgageeClause", { clause_text: "MERS as nominee for Partner Bank, N.A." });
  assert.equal(mers.pass, false); assert.equal(mers.mers_absent, false); assert.equal(mers.successors_assigns_phrase, false); assert.equal(mers.servicer_address, false);
  const r = await h.run("evaluateAdequacy", { policy: policyInput({ policy_id: "HZ-MERS", mortgagee_clause_text: "MERS as nominee for Partner Bank, N.A." }), title_holders: TITLE, transaction_type: "refinance" });
  assert.equal(r.status, "deficient"); assert.deepEqual(r.deficiencies, ["mortgagee_clause"]); assert.equal((r.mortgagee_clause_check as { pass: boolean }).pass, false);
  assert.equal(h.rt.store.get("insurance_policies", "HZ-MERS")!.data.mortgagee_clause_status, "invalid");
  const isaoa = checkMortgageeClause("[Partner], its successors and/or assigns, c/o Supermortgage, P.O. Box 7900, Phoenix AZ 85011", PARTNER);
  assert.equal(isaoa.pass, true); assert.equal(isaoa.atima_present, false); assert.deepEqual([isaoa.partner_named, isaoa.successors_assigns_phrase, isaoa.servicer_address, isaoa.mers_absent], [true, true, true, true]);
  const atima = checkMortgageeClause("Partner Bank, N.A., its successors and/or assigns, as their interests may appear, c/o Supermortgage, P.O. Box 7900, Phoenix AZ 85011", PARTNER);
  assert.equal(atima.pass, true); assert.equal(atima.atima_present, true);
  // the Fannie Mae form of the clause and the ISAOA abbreviation are accepted; a clause without the servicer address is not
  assert.equal(checkMortgageeClause("Fannie Mae, in care of Supermortgage, P.O. Box 7900, Phoenix AZ 85011", PARTNER).pass, true);
  assert.equal(checkMortgageeClause("Partner Bank, N.A. ISAOA ATIMA c/o Supermortgage, P.O. Box 7900", PARTNER).pass, true);
  assert.equal(checkMortgageeClause("Partner Bank, N.A., its successors and/or assigns", PARTNER).pass, false);
  assert.equal(evaluateHazardAdequacy(hazardPolicy({ mortgagee_clause_text: CLAUSE_OK }), { title_holders: TITLE, partner: PARTNER }).tests.mortgagee_clause, "PASS");
});

test("24.5-T9: Given a Zone X determination with no residential structure in an SFHA, when finalized, then `not_required`, `sfc_180=true`, no notice, and 29.3 receives SFC 180.", async () => {
  const h = harness("2026-10-06T16:00:00.000Z");
  const det = await h.determination(ZONE_X);
  assert.equal(det.status, "not_required"); assert.equal(det.sfc_180, true); assert.equal(det.in_sfha, false); assert.equal(det.notice_required, false); assert.deepEqual(det.special_feature_codes, ["180"]);
  const ev = h.ofType("flood.determination.received").at(-1)!; assert.equal(ev.payload.in_sfha, false); assert.equal(ev.payload.sfc_180, true); assert.deepEqual(ev.payload.special_feature_codes, ["180"]); assert.equal(ev.payload.lol_purchased, true);
  // no notice: the SFHA rows never armed, no flood.notice.* event, and delivery is refused
  assert.equal(h.timer("FDPA_4104A_FLOOD_NOTICE_GATE"), undefined); assert.equal(h.timer("SM_FLOOD_NOTICE_DELIVER_1BD"), undefined);
  await assert.rejects(h.run("deliverNotice", { channel: "esign", notice_document_id: "DOC-X" }), (e: Error) => /not in an SFHA/.test(e.message));
  assert.equal(h.ofType("flood.notice.delivered").length, 0);
  // 29.3's delivery data carries SFC 180
  const delivery = await h.run("parseSFHDF", { op: "delivery_data" }); assert.deepEqual(delivery.special_feature_codes, ["180"]); assert.equal(delivery.flood_zone, "X");
  // gates: notice and coverage gates are not applicable off the SFHA
  const gates = (await h.run("evaluateGates", { consummation_date: "2026-11-06" })).gates as Record<string, { open: boolean }>;
  assert.equal(gates.FDPA_4104A_FLOOD_NOTICE_GATE!.open, true); assert.equal(gates.FNMA_B7_3_06_FLOOD_COVERAGE_GATE!.open, true);
  // multiple structures: only a non-residential detached structure in the SFHA → not required and SFC 180; a residential detached structure in the SFHA → required, never SFC 180
  const shed = parseSfhdf({ ...AE, zone: "X", structures: [{ kind: "principal", in_sfha: false }, { kind: "non_residential_detached", in_sfha: true, zone: "AE" }] }, D("2026-10-06"));
  assert.equal(shed.status, "not_required"); assert.equal(shed.sfc_180, true); assert.equal(shed.non_residential_detached_only, true);
  const guest = parseSfhdf({ ...AE, zone: "X", structures: [{ kind: "principal", in_sfha: false }, { kind: "residential_detached", in_sfha: true, zone: "AE" }] }, D("2026-10-06"));
  assert.equal(guest.status, "notice_due"); assert.equal(guest.sfc_180, false); assert.equal(guest.in_sfha, true);
  assert.throws(() => deliveryFloodData({ ...(h.rt.store.list("flood_determinations")[0]!.data as unknown as Parameters<typeof deliveryFloodData>[0]), sfc_180: true, in_sfha: true }), RangeError);
  await h.refused(h.run("parseSFHDF", { sfhdf: AE, force_sfc_180: true }), "SFC_180_NEVER_IN_SFHA");
  // the SFHDF form version is configuration: the expired FF-206-FY-21-116 is accepted only while the extension flag stands
  assert.equal(sfhdfFormAccepted("FF-206-FY-21-116", D("2026-10-06")).accepted, true);
  assert.equal(sfhdfFormAccepted("FF-206-FY-21-116", D("2026-10-06"), { ...SFHDF_CONFIG_DEFAULT, form_version_accepted: false }).accepted, false);
  assert.equal(sfhdfFormAccepted("FF-206-FY-21-116", D("2026-09-30"), { ...SFHDF_CONFIG_DEFAULT, form_version_accepted: false }).accepted, true);
});

test("24.5-T10: Given a non-participating community, when the determination is received, then `ineligible` and the loan is stopped with a collateral-based reason.", async () => {
  const h = harness("2026-10-06T16:00:00.000Z");
  const det = await h.run("orderFloodDetermination", { property_id: "PROP-1", address_hash: "sha256:np", fee_gate_result: "open", ordered_at: "2026-10-06T16:00:00.000Z" });
  assert.equal(det.status, "ordered"); assert.equal(h.ofType("flood.determination.ordered").length, 1);
  const r = await h.run("parseSFHDF", { sfhdf: { ...AE, community_participating: false, program_status: "non_participating" }, received_at: "2026-10-06T19:30:00.000Z" });
  assert.equal(r.status, "ineligible"); assert.equal(r.in_sfha, true); assert.equal(r.sfc_180, false);
  const stop = r.stop as { basis: string; reason_code: string; statement_text: string; hmda_denial_code: number; notify: string[] };
  assert.equal(stop.basis, "collateral"); assert.equal(stop.reason_code, "collateral_flood_nonparticipating_community"); assert.equal(stop.hmda_denial_code, 4); assert.deepEqual(stop.notify, ["23.1", "21.6"]);
  assert.match(stop.statement_text, /community that does not participate in the National Flood Insurance Program/); assert.doesNotMatch(stop.statement_text, /borrower|credit|income/i);
  const ev = h.ofType("application.ineligible.determined").at(-1)!; assert.equal(ev.payload.basis, "collateral"); assert.equal(ev.payload.reason_code, "collateral_flood_nonparticipating_community"); assert.equal(ev.payload.source_process, "24.5");
  assert.equal(h.ofType("flood.determination.received").at(-1)!.payload.status, "ineligible");
  assert.equal(h.rt.escalations.list().filter((e) => e.kind === "officer").length, 1);
  assert.equal(((await h.run("evaluateGates", { consummation_date: "2026-11-06" })).gates as Record<string, { open: boolean; reason?: string }>).FNMA_B7_3_06_FLOOD_COVERAGE_GATE!.open, false);
  // pure rule: a participating community in Zone AE is notice_due; CBRS/OPA follows the 24.5-Q2 default (ineligible)
  assert.equal(parseSfhdf(AE, D("2026-10-06")).status, "notice_due");
  assert.equal(parseSfhdf({ ...AE, cbrs_opa: true }, D("2026-10-06")).ineligible_reason, "collateral_flood_cbrs_opa");
  // the fee gate precedes the order (21.4 order_flood)
  await h.refused(h.run("orderFloodDetermination", { property_id: "PROP-2", address_hash: "sha256:x", fee_gate_result: "closed_no_intent" }), "FEE_GATE_BEFORE_FLOOD_ORDER");
});

test("24.5-T11: Given the partner flagged `regulated_lending_institution=false` and an escrow-waived non-HPML loan in an SFHA, when escrow lines are seeded, then the flood line is `waivable=true`; given the flag true, then `waivable=false` (12 CFR 22.5).", async () => {
  const events = new MemoryEventStore(new FixedClock("2026-11-12T16:00:00.000Z"));
  const input = (rli: boolean) => ({ application_id: REFI.app, escrowed: false, hpml: false, regulated_lending_institution: rli, in_sfha: true, hazard: { policy_id: "HZ-REFI-1", policy_number: "HO-4471-2026", annual_premium_cents: 195_000n, premium_paid_through: D("2027-11-01"), paid_at_closing: false }, flood: { policy_id: "FL-NFIP-1", annual_premium_cents: 115_000n, premium_paid_through: D("2027-11-06"), paid_at_closing: true }, ho6: null });
  const nonBank = seedEscrowLines(events, input(false), "2026-11-12T16:00:00.000Z");
  const flood = nonBank.lines.find((l) => l.line_kind === "flood")!;
  assert.equal(flood.waivable, true); assert.equal(flood.waived, true, "escrow-waived, non-HPML, partner not a regulated lending institution → the borrower's written election governs (24.5-Q3)"); assert.equal(nonBank.escrow_established, false);
  assert.match(flood.basis, /24\.5-Q3/);
  const bank = seedEscrowLines(events, input(true), "2026-11-12T16:00:00.000Z");
  const bankFlood = bank.lines.find((l) => l.line_kind === "flood")!;
  assert.equal(bankFlood.waivable, false); assert.equal(bankFlood.waived, false); assert.match(bankFlood.basis, /12 CFR 22\.5/);
  // an HPML escrows everything regardless of the flood-escrow finding (§1026.35(b))
  const hpml = seedEscrowLines(events, { ...input(false), hpml: true }, "2026-11-12T16:00:00.000Z");
  assert.equal(hpml.lines.find((l) => l.line_kind === "flood")!.waivable, false); assert.equal(hpml.lines.find((l) => l.line_kind === "hazard")!.waivable, false); assert.equal(hpml.escrow_established, true);
  // the event 30.3 consumes carries the lines
  const ev = events.ofType("insurance.escrow_lines.seeded").at(-1)!; assert.equal(ev.applicationId, REFI.app); assert.equal(ev.payload.consumer, "30.3"); assert.equal((ev.payload.lines as { line_kind: string }[]).length, 2);
  // on the bus the seeds are stored for 30.3; the guardrail refuses waiving the flood line for a regulated lending institution
  const h = harness("2026-11-12T16:00:00.000Z");
  const viaBus = await h.run("seedEscrowLines", { escrowed: true, hpml: false, regulated_lending_institution: false, in_sfha: true, hazard: { policy_id: "HZ-REFI-1", annual_premium_cents: "195000", premium_paid_through: "2027-11-01", paid_at_closing: true }, flood: { policy_id: "FL-NFIP-1", annual_premium_cents: "115000", premium_paid_through: "2027-11-06", paid_at_closing: true } });
  assert.equal(viaBus.escrow_established, true); assert.equal((viaBus.lines as { line_kind: string; waivable: boolean; active: boolean }[]).find((l) => l.line_kind === "flood")!.active, true);
  await h.refused(h.run("seedEscrowLines", { escrowed: false, regulated_lending_institution: true, waive_flood_line: true, in_sfha: true }), "FLOOD_ESCROW_NOT_WAIVABLE_RLI_HPML");
});

test("24.5-T12: Given a carrier rated only by Demotech at \"A\" and unrated elsewhere, when evaluated, then the rating test PASSES (one agency suffices); given Demotech \"S\" with no other rating, then `rating_fail` unless FAIR plan/mortgage-impairment relief applies.", async () => {
  const h = harness("2026-10-22T15:00:00.000Z");
  const demotechA = await h.run("lookupCarrierRating", { ratings: [{ agency: "demotech", grade: "A" }] });
  assert.equal(demotechA.pass, true); assert.deepEqual(demotechA.met_by, ["demotech"]); assert.equal(demotechA.basis, "rating");
  const pol = await h.run("evaluateAdequacy", { policy: policyInput({ policy_id: "HZ-DEMO-A", ratings: [{ agency: "demotech", grade: "A" }] }), title_holders: TITLE, transaction_type: "refinance" });
  assert.equal(pol.status, "verified"); assert.equal((pol.tests as Record<string, string>).carrier_rating_one_agency, "PASS");
  // Demotech "S" (Substantial) with no other rating → rating_fail
  const s = carrierRatingTest([{ agency: "demotech", grade: "S" }]);
  assert.equal(s.pass, false); assert.equal(s.deficiency, "rating_fail");
  const failed = await h.run("evaluateAdequacy", { policy: policyInput({ policy_id: "HZ-DEMO-S", ratings: [{ agency: "demotech", grade: "S" }] }), title_holders: TITLE, transaction_type: "refinance" });
  assert.equal(failed.status, "deficient"); assert.deepEqual(failed.deficiencies, ["rating_fail"]); assert.equal(h.ofType("insurance.deficiency.opened").at(-1)!.payload.kind, "rating_fail");
  // unless the policy is a FAIR-plan policy (the only coverage available; officer acknowledgment) or SM's mortgage-impairment policy applies
  const fair = carrierRatingTest([{ agency: "demotech", grade: "S" }], { fair_plan: true, fair_plan_only_coverage_available: true });
  assert.equal(fair.pass, true); assert.equal(fair.basis, "fair_plan"); assert.equal(fair.officer_acknowledgment_required, true);
  assert.equal(carrierRatingTest([{ agency: "demotech", grade: "S" }], { fair_plan: true, fair_plan_only_coverage_available: false }).pass, false, "FAIR plan only when it is the only coverage available");
  const mi = carrierRatingTest([], { mortgage_impairment_relief: true }); assert.equal(mi.pass, true); assert.equal(mi.basis, "mortgage_impairment");
  assert.equal((await h.run("evaluateAdequacy", { policy: policyInput({ policy_id: "HZ-FAIR", ratings: [{ agency: "demotech", grade: "S" }], fair_plan: true, fair_plan_only_coverage_available: true }), title_holders: TITLE, transaction_type: "refinance" })).status, "verified");
  // the other agencies' thresholds: AM Best B passes, B- fails; S&P / KBRA BBB pass, BB fails
  assert.equal(carrierRatingTest([{ agency: "am_best", grade: "B" }]).pass, true); assert.equal(carrierRatingTest([{ agency: "am_best", grade: "B-" }]).pass, false);
  assert.equal(carrierRatingTest([{ agency: "sp", grade: "BBB-" }]).pass, true); assert.equal(carrierRatingTest([{ agency: "kroll", grade: "BB+" }]).pass, false);
  // the rating exception itself is the partner officer's
  await h.refused(h.run("evaluateAdequacy", { policy: policyInput({ policy_id: "HZ-EXC", ratings: [{ agency: "demotech", grade: "S" }] }), rating_exception_approved: true }), "RATING_EXCEPTION_IS_OFFICER");
  const exc = await h.run("evaluateAdequacy", { policy: policyInput({ policy_id: "HZ-EXC", ratings: [{ agency: "demotech", grade: "S" }], mortgage_impairment_relief: true }), title_holders: TITLE, transaction_type: "refinance", rating_exception_approved: true }, OFFICER);
  assert.equal(exc.status, "verified"); assert.equal((exc.rating as { basis: string }).basis, "mortgage_impairment");
});

test("24.5 worked figures: the refinance fixture's deductible arithmetic, the Zone AE flood amount, the Columbus master/HO-6 amounts and the 30.3 escrow lines", async () => {
  // Rule 2: loan $560,000.00, insurer's replacement-cost estimate $520,000.00 → dwelling coverage as written $520,000.00; cap 5% × 52,000,000 = 2,600,000 cents ($26,000.00)
  const coverage = 52_000_000n; const loan = 56_000_000n;
  assert.equal(hazardDeductibleMax(coverage), 2_600_000n);
  assert.equal(deductiblePct(500_000n, coverage).toFixed(6), "0.009615");                       // $5,000 all-peril deductible (0.9615%) passes
  const wind = 1_040_000n; assert.equal(deductiblePct(wind, coverage).cmp(Decimal.parse("0.02")), 0); // 2% wind/hail deductible = $10,400.00
  const hurricane = 2_600_000n; assert.equal(deductiblePct(hurricane, coverage).cmp(Decimal.parse("0.05")), 0); // 5% hurricane deductible = $26,000.00, exactly 5.0000%
  const namedStorm = 3_120_000n; assert.equal(deductiblePct(namedStorm, coverage).toFixed(4), "0.0600");  // 6% named-storm deductible = $31,200.00
  const r = evaluateHazardAdequacy(hazardPolicy({ per_peril_deductibles: [{ peril: "windstorm_hail", cents: wind }, { peril: "hurricane", cents: hurricane }] }), { title_holders: TITLE, partner: PARTNER });
  assert.equal(r.pass, true); assert.equal(r.hazard_deductible_max_cents, 2_600_000n);
  assert.deepEqual(evaluateHazardAdequacy(hazardPolicy({ per_peril_deductibles: [{ peril: "named_storm", cents: namedStorm }] }), { title_holders: TITLE, partner: PARTNER }).deficiencies, ["deductible_excess"]);
  assert.ok(coverage < loan, "under the retired pre-March-2026 rule $520,000 would have been compared with the $560,000 UPB — the engine no longer does this");
  assert.equal(evaluateHazardAdequacy(hazardPolicy(), { title_holders: TITLE, partner: PARTNER }).tests.coverage_basis_replacement_cost, "PASS");
  // Rule 4: RCV $520,000, NFIP max $250,000, UPB $560,000 → required $250,000.00; deductible ≤ $10,000
  assert.deepEqual(floodRequirement({ rcv_improvements_cents: coverage, note_amount_cents: loan }), { flood_required_amount_cents: 25_000_000n, flood_deductible_max_cents: 1_000_000n, nfip_max_cents: 25_000_000n });
  // RCBAP: 40 units, RCV $12,000,000 → min(80% = $9,600,000; $250,000 × 40 = $10,000,000) = $9,600,000; allocation $240,000; unit min($300,000, $250,000, $412,000) = $250,000 → short $10,000
  const rc = evaluateRcbap({ units: 40, rcv_building_cents: 1_200_000_000n, rcbap_coverage_cents: 960_000_000n, unit_upb_cents: 41_200_000n });
  assert.deepEqual([rc.required_rcbap_cents, rc.allocation_cents, rc.unit_requirement_cents, rc.supplemental_required_cents], [960_000_000n, 24_000_000n, 25_000_000n, 1_000_000n]);
  // Rule 3: master RCV statement $12,000,000, coverage $12,000,000 (100%), master deductible $250,000 (2.08%), per-unit $25,000 → HO-6 ≥ max($40,000, $25,000) = $40,000; HO-6 deductible ≤ max($2,000, $2,500) = $2,500
  const p = evaluateProjectInsurance({ application_id: PUR.app, application_date: PUR.application_date, project_type: "condo", units_total: 40, master: { policy_id: "MP", rcv_cents: 1_200_000_000n, coverage_cents: 1_200_000_000n, rcv_documentation: "insurer_statement", coverage_form: "special", deductible_cents: 25_000_000n, per_unit_deductible_cents: 2_500_000n, covers_interior: false, evidence_document_id: "DOC-MASTER-1" }, ho6: { policy_id: "HO6", coverage_cents: 4_000_000n, deductible_cents: 250_000n, restoration_estimate_cents: 4_000_000n, evidence_document_id: "DOC-HO6-1" }, liability: { coverage_cents: 100_000_000n, separation_of_insureds: true, evidence_document_id: "DOC-LIAB-1" }, fidelity: { coverage_cents: 9_000_000n, evidence_document_id: "DOC-FID-1" }, fidelity_need_cents: 8_500_000n });
  assert.equal(p.pass, true); assert.equal(p.ho6_min_amount_cents, 4_000_000n); assert.equal(p.ho6_deductible_max_cents, 250_000n); assert.equal(Decimal.ratio(25_000_000n, 1_200_000_000n).toFixed(4), "0.0208");
  // Rule 8 (30.3): hazard $1,950.00/yr paid at closing for 12 months (purchase) and a flood NFIP premium $1,150.00/yr → monthly lines $162.50 and $95.83
  assert.equal(monthlyEscrowCents(195_000n), 16_250n); assert.equal(monthlyEscrowCents(115_000n), 9_583n);
  const events = new MemoryEventStore(new FixedClock("2026-11-18T16:00:00.000Z"));
  const seeded = seedEscrowLines(events, { application_id: PUR.app, escrowed: true, hpml: false, regulated_lending_institution: false, in_sfha: true, hazard: { policy_id: "HZ-PUR-1", annual_premium_cents: 195_000n, premium_paid_through: D("2027-11-18"), paid_at_closing: true }, flood: { policy_id: "FL-PUR-1", annual_premium_cents: 115_000n, premium_paid_through: D("2027-11-18"), paid_at_closing: true }, ho6: null }, "2026-11-18T16:00:00.000Z");
  assert.deepEqual(seeded.lines.map((l) => [l.line_kind, l.monthly_cents, l.next_due_on, l.active]), [["hazard", 16_250n, "2027-11-18", true], ["flood", 9_583n, "2027-11-18", true]]);
  // Hand-off at funding (INT-O5-8): the 9.6 row seeded with the LOL contract linked → `flood.lol.enrolled{lol_purchased=true}` satisfies FDPA_4012A_LOL_ENROLLED_GATE (armed on loan.funded); without the link, boarding warning W-007
  const h = harness("2026-10-06T16:00:00.000Z"); await h.determination(AE);
  h.at("2026-11-12T17:00:00.000Z"); h.upstream("loan.funded", { loan_id: REFI.loan, funded_at: "2026-11-12T17:00:00.000Z" });
  assert.equal(h.timer("FDPA_4012A_LOL_ENROLLED_GATE")?.status, "armed");
  const off = await h.run("seedEscrowLines", { op: "handoff", loan_id: REFI.loan, lol_contract_linked: true, funded_at: "2026-11-12T17:00:00.000Z" });
  assert.equal(off.warning, null); assert.equal(off.event, "flood.lol.enrolled"); assert.equal((off.flood_row as { determination_type: string; loan_id: string; lol: boolean }).determination_type, "boarding"); assert.equal((off.flood_row as { loan_id: string }).loan_id, REFI.loan);
  assert.equal(h.timer("FDPA_4012A_LOL_ENROLLED_GATE")?.status, "satisfied");
  const unlinked = new MemoryEventStore(new FixedClock("2026-11-12T17:00:00.000Z"));
  const ordered = orderFloodDetermination(unlinked, { application_id: REFI.app, property_id: REFI.property, address_hash: "sha256:phx", ordered_at: "2026-10-06T16:00:00.000Z" }).record;
  const received = receiveFloodDetermination(unlinked, ordered, AE, "2026-10-06T19:30:00.000Z").record;
  const w = handOffToServicing(unlinked, { application_id: REFI.app, loan_id: REFI.loan, funded_at: "2026-11-12T17:00:00.000Z", determination: received, policies: [], lol_contract_linked: false });
  assert.equal(w.warning, "W-007"); assert.equal(w.event, null); assert.equal(unlinked.ofType("flood.lol.enrolled").length, 0);
  // the notice's own dates: received Tue Oct 6, delivered Wed Oct 7 (esign) → gate figure 30 for the Fri Nov 6 consummation
  const d = deliverFloodNotice(unlinked, received, { delivered_at: "2026-10-07T15:10:00.000Z", channel: "esign", notice_document_id: "DOC-N", esign_confirmed_at: "2026-10-07T18:40:00.000Z", scheduled_consummation_date: REFI.consummation });
  assert.equal(d.gate.days_before_consummation, 30); assert.equal(d.record.notice_reasonable_period_days, 30);
});
