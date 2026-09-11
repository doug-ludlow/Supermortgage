// 24.4 Title, vesting, settlement-agent vetting, existing-lien payoffs, subordinations, and curative
// spec/sections/24-property-valuation-eligibility-title-hazard-flood-insurance/24-4-title-vesting-settlement-agent-vetting-existing-lien-payoffs.md
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
import { TOOLS_24_4 } from "../../app/tools/section24-4.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { payoffRefundDue } from "../escrow/refund.ts";
import { perDiem as servicerPerDiem } from "../payoff/quote.ts";
import { FakeStateDoi, FakeWireVerification, FakeAltaRegistry, FakeTitleVendor, computeRequiredEndorsements, missingEndorsements, endorsementClears, titleEvidenceGate, policyFormCheck, checkInsurer, classifyTaxCertificate, parsePayoffStatement, computePayoffAtDate, payoffFollowUpDue, decideEscrowTreatment, helocRatios, checkSubordinateTerms, resubordinationGate, subordinationRequestDue, reviewTrust, reviewPOA, evaluateAolPath, tx50a6TitleCheck, cemaNewMoney, cplBeforeFundingGate, verifyWireInstructions, releaseWireBlock, wireVerificationGate, commitmentDatedownGate,
  type ScheduleItem, type CurativeItem } from "./ops-24-4.ts";

const AGENT: Actor = { kind: "agent", id: "title-closing" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const FUNDING_APPROVER: Actor = { kind: "human", id: "u-funding", role: "funding_approver" };
const REFI = "APP-REFI-560K";
const AGENT_PARTY = "PARTY-TITLE-AGENCY-AZ", UNDERWRITER = "PARTY-TITLE-INSURER-1", PARTNER = "Partner Bank, N.A.", OLD_SERVICER = "PARTY-OLD-SERVICER", SERVICING_LOAN = "L-PRIOR-531240";
/** MST wall-clock instants of the refinance fixture (America/Phoenix, UTC−7). */
const MST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-07:00`).toISOString();
const INSURED = `${PARTNER}, its successors and/or assigns, as their interests may appear`;
const LEGAL = "Lot 12, Block 3, Arcadia Estates, per Book 45 of Maps, page 17, Maricopa County, Arizona";
/** 21.4's intent record for the fixture: LE received Thu Oct 8, intent Fri Oct 9, 2026 — the order_title fee gate is open from then. */
const INTENT = { intent_id: "INT-REFI-1", application_id: REFI, disclosure_id: "LE-REFI-1", le_effective_receipt_date: D("2026-10-08"), received_at: MST("2026-10-09", "10:00"), channel: "esign" as const, statement_text: "I intend to proceed", evidence_document_id: "DOC-INTENT-1", recorded_by: "agent:mlo", valid: true, withdrawn_at: null };
const FEE_GATE = { amount_cents: 45_000n, le_effective_receipt_date: "2026-10-08", intent: INTENT };
const commitment = (o: Record<string, unknown> = {}) => ({ order_id: "", commitment_number: "AZ-2026-118842", commitment_effective_date: "2026-10-14", underwriter_party_id: UNDERWRITER, underwriter_state: "AZ", strength_basis: "rating", proposed_insured_text: INSURED, policy_form: "ALTA Loan Policy (07-01-2021)", policy_amount_cents: 56_000_000n, note_amount_cents: 56_000_000n,
  vesting: { names: ["Alex Fixture"], tenancy: "sole_and_separate", trust: false, estate: "fee_simple" }, legal_description: LEGAL, appraisal_legal_description: LEGAL, apn: "171-22-045", schedule_b1_requirements: ["payoff of the deed of trust recorded 2019-06-03"], schedule_b2_exceptions: [{ kind: "utility_easement", text: "10 ft public utility easement along the rear lot line", width_ft: 10, along_property_line: true }] as ScheduleItem[], endorsements_committed: ["ALTA 8.1-06"], property: { state: "AZ" }, ...o });

function harness(nowIso: string, applicationId = REFI) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["24.4"] });
  const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", applicationId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const escalations = new EscalationService(events, clock);
  const doi = new FakeStateDoi(); doi.seed(UNDERWRITER, "AZ", true);
  const wire = new FakeWireVerification(); const alta = new FakeAltaRegistry(); alta.seed(AGENT_PARTY, { alta_registry_id: "ALTA-REG-88213", underwriter_confirmed_by: UNDERWRITER, phone: "+1-602-555-0100" });
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: { stateDoi: doi, wireVerification: wire, altaRegistry: alta, title: new FakeTitleVendor() }, ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_24_4); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("24.4", name))!, actor, { application_id: applicationId, ...input }, uow)).output as Record<string, unknown>;
  const timer = (code: string) => timers.byCode(code).at(-1);
  const evts = (type: string) => events.all().filter((e) => e.type === type);
  /** The refinance fixture's title order (intent Fri Oct 9 → ordered Mon Oct 12, 2026 — inside SM_TITLE_ORDER_2BD) with the 21.4 fee gate. */
  const order = async (o: Record<string, unknown> = {}) => { clock.set(MST("2026-10-12", "09:00")); const r = await run("orderTitle", { settlement_agent_party_id: AGENT_PARTY, underwriter_party_id: UNDERWRITER, apn: "171-22-045", note_amount_cents: 56_000_000n, proposed_insured_text: INSURED, closing_date: "2026-11-06", fee_gate: FEE_GATE, property: { state: "AZ" }, ...o }); return (r.order as { id: string }).id; };
  const gate = async (command: string, extra: Record<string, unknown> = {}) => { const r = await run("evaluateGates", { command, partner_name: PARTNER, ...extra }); return { ...r, by: Object.fromEntries((r.gates as { code: string; open: boolean; reason: string | null }[]).map((g) => [g.code, g])) } as unknown as Record<string, unknown> & { open: boolean; refused_by: string | null; by: Record<string, { open: boolean; reason: string | null }> }; };
  return { clock, events, timers, uow, escalations, rt, doi, wire, alta, run, timer, evts, decisions, order, gate };
}

test("24.4-T1: Given the refinance fixture (application Oct 5, 2026) and a commitment proposing the \"ALTA Loan Policy (6-17-06)\", when `FNMA_B7_2_01_TITLE_EVIDENCE_GATE` is evaluated on Nov 10, 2026, then the gate fails with reason `policy_form_not_2021` and a curative item addressed to the agent; a corrected pro forma on the 2021 form passes.", async () => {
  const h = harness(MST("2026-10-05", "09:00"));
  const orderId = await h.order();
  assert.equal(h.evts("fee.gate.checked")[0]!.payload.command, "order_title");                      // 21.4's gate precedes the order
  assert.equal(h.timer("SM_SETTLEMENT_AGENT_VETTING_GATE")!.status, "armed");                        // "agent assigned" with the order
  h.clock.set(MST("2026-10-15", "11:00"));
  const first = await h.run("parseCommitment", commitment({ order_id: orderId, policy_form: "ALTA Loan Policy (6-17-06)" }));
  assert.equal(first.status, "curative_open");
  assert.deepEqual(first.policy_form, { ok: false, reason: "policy_form_not_2021", proposed: "ALTA Loan Policy (6-17-06)" });
  const curative = (first.curative_opened as CurativeItem[]).find((c) => /policy form/.test(c.description))!;
  assert.equal(curative.owner, "settlement_agent"); assert.equal(curative.blocks_consummation, true);
  assert.equal(h.evts("title.commitment.received")[0]!.payload.apn, "171-22-045");                    // 30.4's tax service reads the APN from here
  // gate evaluated Tue Nov 10, 2026 on the `funding.authorized` request (26.3)
  h.clock.set(MST("2026-11-10", "10:00"));
  h.events.append({ type: "funding.authorized", applicationId: REFI, actor: AGENT, payload: { application_id: REFI, request: true, disbursement_date: "2026-11-12" } });
  assert.equal(h.timer("FNMA_B7_2_01_TITLE_EVIDENCE_GATE")!.status, "armed");
  const fail = await h.gate("disburse", { disbursement_date: "2026-11-12" });
  assert.equal(fail.open, false); assert.equal(fail.refused_by, "FNMA_B7_2_01_TITLE_EVIDENCE_GATE"); assert.equal(fail.by.FNMA_B7_2_01_TITLE_EVIDENCE_GATE!.reason, "policy_form_not_2021");
  await assert.rejects(h.run("evaluateGates", { command: "disburse", accept_non_2021_form: true }), (e: Error) => e instanceof CommandRefused && e.code === "ALTA_2021_FORM_REQUIRED");
  // corrected pro forma on the 2021 form: the superseded form item clears and the evidence gate passes
  h.clock.set(MST("2026-11-10", "15:00"));
  const fixed = await h.run("parseCommitment", commitment({ order_id: orderId, policy_form: "ALTA Loan Policy (07-01-2021)", commitment_document_id: "DOC-PROFORMA-2" }));
  assert.equal(fixed.status, "reviewed"); assert.equal((fixed.policy_form as { ok: boolean }).ok, true);
  assert.equal(h.evts("title.curative.cleared").at(-1)!.payload.curative_id, curative.id);
  const pass = await h.gate("disburse", { disbursement_date: "2026-11-12" });
  assert.equal(pass.by.FNMA_B7_2_01_TITLE_EVIDENCE_GATE!.open, true);
  assert.equal(policyFormCheck("ALTA Loan Policy (6-17-06)").ok, false); assert.equal(policyFormCheck("ALTA Loan Policy (07-01-2021)").ok, true);
});
test("24.4-T2: Given a commitment for the Phoenix property (1-unit, fixed rate, not condo/PUD) listing endorsements {none}, when endorsements are computed, then `required_endorsements = [ALTA 8.1]` and the gate fails until 8.1 is committed; given the same property on a 7/6 ARM, then `[ALTA 8.1, ALTA 6]`.", async () => {
  const h = harness(MST("2026-10-15", "11:00"));
  const fixed = await h.run("computeRequiredEndorsements", { property: { state: "AZ", condo: false, pud: false, arm: false } });
  assert.deepEqual(fixed.required_endorsements, ["ALTA 8.1"]); assert.deepEqual(fixed.missing_endorsements, ["ALTA 8.1"]); assert.equal(fixed.gate_passes, false);
  const closed = titleEvidenceGate({ policy_form: "ALTA Loan Policy (07-01-2021)", required_endorsements: ["ALTA 8.1"], issued_endorsements: [], policy_amount_cents: 56_000_000n, note_amount_cents: 56_000_000n, proposed_insured_text: INSURED });
  assert.equal(closed.open, false); assert.equal(closed.reason, "alta_8_1_missing");
  const committed = titleEvidenceGate({ policy_form: "ALTA Loan Policy (07-01-2021)", required_endorsements: ["ALTA 8.1"], issued_endorsements: [], committed_endorsements: ["ALTA 8.1-06"], policy_amount_cents: 56_000_000n, note_amount_cents: 56_000_000n, proposed_insured_text: INSURED });
  assert.equal(committed.open, true);
  const arm = await h.run("computeRequiredEndorsements", { property: { state: "AZ", arm: true }, committed_endorsements: ["ALTA 8.1"] });
  assert.deepEqual(arm.required_endorsements, ["ALTA 8.1", "ALTA 6"]); assert.deepEqual(arm.missing_endorsements, ["ALTA 6"]);
  assert.deepEqual(computeRequiredEndorsements({ arm: true }), ["ALTA 8.1", "ALTA 6"]);
  assert.deepEqual(missingEndorsements(["ALTA 8.1", "ALTA 6"], ["ALTA 8.1-06", "ALTA 6-06"]), []);
  const evaluator = evaluateGate("24.4.titleEvidenceGate", { policy_form: "ALTA Loan Policy (07-01-2021)", required_endorsements: ["ALTA 8.1"], issued_endorsements: [], policy_amount_cents: 56_000_000n, note_amount_cents: 56_000_000n, proposed_insured_text: INSURED });
  assert.equal(evaluator.open, false); assert.equal(evaluator.reason, "alta_8_1_missing");
});
test("24.4-T3: Given a condo unit with a commitment lacking ALTA 4/4.1, when reviewed, then a blocking curative item opens; given the endorsement issued as \"ALTA 4.1-06\", then the item clears.", async () => {
  const h = harness(MST("2026-10-12", "09:00"));
  const orderId = await h.order({ property: { state: "AZ", condo: true } });
  h.clock.set(MST("2026-10-15", "11:00"));
  const r = await h.run("parseCommitment", commitment({ order_id: orderId, property: { state: "AZ", condo: true }, endorsements_committed: ["ALTA 8.1-06"] }));
  assert.deepEqual(r.required_endorsements, ["ALTA 8.1", "ALTA 4"]); assert.deepEqual(r.missing_endorsements, ["ALTA 4"]); assert.equal(r.status, "curative_open");
  const item = (r.curative_opened as CurativeItem[]).find((c) => /ALTA 4/.test(c.description))!;
  assert.equal(item.blocks_consummation, true); assert.equal(item.owner, "settlement_agent");
  assert.equal(h.evts("title.curative.opened").length, 1); assert.equal(h.timer("SM_TITLE_ORDER_2BD")?.status ?? "not_armed_here", "not_armed_here"); // 21.4's intent event arms it; this harness starts at the order
  // the endorsement issued as "ALTA 4.1-06" clears the item (4 or 4.1 satisfy B7-2-04)
  h.clock.set(MST("2026-10-20", "11:00"));
  const cleared = await h.run("openCurative", { op: "clear", curative_id: item.id, resolution: "endorsement", issued_endorsement: "ALTA 4.1-06", required_endorsement: "ALTA 4", evidence_document_id: "DOC-END-41" });
  assert.equal((cleared.item as CurativeItem).resolution, "endorsement"); assert.equal(cleared.open_blocking_items, 0); assert.equal(cleared.order_status, "reviewed");
  assert.equal(endorsementClears("ALTA 4", "ALTA 4.1-06"), true); assert.equal(endorsementClears("ALTA 4", "ALTA 5.1-06"), false);
  await assert.rejects(h.run("openCurative", { op: "clear", curative_id: item.id, resolution: "endorsement", issued_endorsement: "ALTA 5.1-06", required_endorsement: "ALTA 4" }), RangeError);
  assert.equal(titleEvidenceGate({ policy_form: "ALTA Loan Policy (07-01-2021)", required_endorsements: ["ALTA 8.1", "ALTA 4"], issued_endorsements: ["ALTA 8.1-06", "ALTA 4.1-06"], policy_amount_cents: 56_000_000n, note_amount_cents: 56_000_000n, proposed_insured_text: INSURED }).open, true);
  assert.equal(h.evts("title.curative.cleared").length, 1); assert.equal(h.evts("title.order.status_changed").at(-1)!.payload.status, "reviewed");
});
test("24.4-T4: Given a title insurer not licensed in Arizona per the state DOI lookup, when the commitment is parsed, then the order is rejected with reason `insurer_not_licensed` and the agent is asked to re-issue under a licensed underwriter.", async () => {
  const h = harness(MST("2026-10-12", "09:00"));
  const orderId = await h.order();
  h.doi.seed("PARTY-TITLE-INSURER-UNLICENSED", "AZ", false);
  h.clock.set(MST("2026-10-15", "11:00"));
  const r = await h.run("parseCommitment", commitment({ order_id: orderId, underwriter_party_id: "PARTY-TITLE-INSURER-UNLICENSED" }));
  assert.equal(r.accepted, false); assert.equal(r.rejection_reason, "insurer_not_licensed"); assert.equal(r.escalated_to, "settlement_agent");
  assert.match(String(r.action), /re-issue the commitment under a title insurer licensed in AZ/);
  const rejected = h.evts("title.order.rejected")[0]!; assert.equal(rejected.payload.reason, "insurer_not_licensed"); assert.equal(rejected.payload.addressed_to, "settlement_agent");
  const task = h.escalations.list().find((e) => e.kind === "settlement_agent")!; assert.equal((task.payload as { reason: string }).reason, "insurer_not_licensed");
  assert.equal(h.evts("title.commitment.received").length, 0);
  assert.equal(h.rt.store.get("title_orders", orderId)!.data.underwriter_license_state_ok, false);
  assert.deepEqual(checkInsurer({ insurer_party_id: "X", state: "AZ", doi_licensed: false, strength_basis: "rating" }).reason, "insurer_not_licensed");
  assert.deepEqual(checkInsurer({ insurer_party_id: "X", state: "AZ", doi_licensed: true, strength_basis: null }).reason, "strength_basis_unknown");
  assert.equal(checkInsurer({ insurer_party_id: "X", state: "IA", doi_licensed: true, strength_basis: "iowa_title_guaranty" }).ok, true);
});
test("24.4-T5: Given an external payoff statement good through Nov 12, 2026 and a planned disbursement Thu Nov 12, then `SM_PAYOFF_GOOD_THROUGH_GATE` passes; when disbursement moves to Fri Nov 13, then the statement becomes `stale`, a refresh is requested, and `disburse` is refused until the refreshed statement (good through ≥ Nov 13) arrives.", async () => {
  const h = harness(MST("2026-10-26", "10:00"));
  // written payoff request to the external servicer Mon Oct 26, 2026 → expected by Wed Nov 4 (SM_PAYOFF_DEMAND_FOLLOWUP_7BD)
  const rq = await h.run("requestPayoff", { liability_id: "LIAB-1ST", existing_servicer_party_id: OLD_SERVICER, requested_good_through: "2026-11-12", state: "AZ", written_authorization_document_id: "DOC-AUTH-1", request_channel: "email", requested_on: "2026-10-26" });
  assert.equal(rq.follow_up_due, "2026-11-04"); assert.equal(rq.same_servicer, false);
  const fu = h.timer("SM_PAYOFF_DEMAND_FOLLOWUP_7BD")!; assert.equal(fu.dueDate, "2026-11-04"); assert.equal(fu.status, "armed");
  assert.equal(payoffFollowUpDue(D("2026-10-26")), "2026-11-04");
  // statement dated Wed Nov 4: principal $531,240.00, interest paid through Oct 31, per diem $105.52, good through Thu Nov 12; release recording fee $30.00
  h.clock.set(MST("2026-11-04", "14:00"));
  const st = await h.run("parsePayoffStatement", { liability_id: "LIAB-1ST", statement_document_id: "DOC-PAYOFF-1", statement_date: "2026-11-04", principal_cents: 53_124_000n, rate_pct: "7.25", interest_paid_through: "2026-10-31", per_diem_cents: 10_552n, good_through_date: "2026-11-12", recording_fee_cents: 3_000n, disbursement_date: "2026-11-12" });
  assert.equal(st.status, "received"); assert.equal(st.covers_disbursement, true); assert.equal(st.total_cents, 53_253_624n); assert.equal(st.per_diem_reconciles, true);
  assert.equal(fu.status, "satisfied");
  h.events.append({ type: "funding.authorized", applicationId: REFI, actor: AGENT, payload: { application_id: REFI, request: true, disbursement_date: "2026-11-12" } });
  assert.equal(h.timer("SM_PAYOFF_GOOD_THROUGH_GATE")!.status, "armed");
  const ok = await h.gate("disburse", { disbursement_date: "2026-11-12" });
  assert.equal(ok.by.SM_PAYOFF_GOOD_THROUGH_GATE!.open, true);
  assert.equal(evaluateGate("24.4.payoffGoodThroughGate", { payoffs: [{ liability_id: "LIAB-1ST", status: "received", good_through_date: "2026-11-12" }], disbursement_date: "2026-11-12" }).open, true);
  // disbursement moves to Fri Nov 13: stale → refresh requested → `disburse` refused until the refreshed statement arrives
  h.clock.set(MST("2026-11-10", "09:00"));
  const plan = await h.run("computePayoffAtDate", { liability_id: "LIAB-1ST", on: "2026-11-13", planned_disbursement: true, state: "AZ" });
  assert.equal(plan.status, "stale"); assert.equal(plan.refresh_requested, true); assert.equal(plan.total_at_cents, 53_264_176n); assert.equal(plan.planning_only, true); assert.equal(plan.funding_figure, null);
  assert.equal(h.evts("payoff.statement.stale").length, 1); assert.equal(h.evts("payoff.demand.requested").at(-1)!.payload.refresh, true);
  await assert.rejects(h.run("computePayoffAtDate", { liability_id: "LIAB-1ST", on: "2026-11-13", use_for_funding: true }), (e: Error) => e instanceof CommandRefused && e.code === "FUNDING_PAYOFF_NEVER_FROM_STALE_STATEMENT");
  const refused = await h.gate("disburse", { disbursement_date: "2026-11-13" });
  assert.equal(refused.by.SM_PAYOFF_GOOD_THROUGH_GATE!.open, false); assert.equal(refused.by.SM_PAYOFF_GOOD_THROUGH_GATE!.reason, "payoff_LIAB-1ST_stale"); assert.equal(refused.open, false);
  assert.equal(evaluateGate("24.4.payoffGoodThroughGate", { payoffs: [{ liability_id: "LIAB-1ST", status: "received", good_through_date: "2026-11-12" }], disbursement_date: "2026-11-13" }).reason, "payoff_LIAB-1ST_stale");
  h.clock.set(MST("2026-11-11", "14:00"));
  const re = await h.run("parsePayoffStatement", { liability_id: "LIAB-1ST", statement_document_id: "DOC-PAYOFF-2", statement_date: "2026-11-11", principal_cents: 53_124_000n, rate_pct: "7.25", interest_paid_through: "2026-10-31", per_diem_cents: 10_552n, good_through_date: "2026-11-16", recording_fee_cents: 3_000n, disbursement_date: "2026-11-13" });
  assert.equal(re.status, "refreshed"); assert.equal(re.covers_disbursement, true);
  const again = await h.gate("disburse", { disbursement_date: "2026-11-13" });
  assert.equal(again.by.SM_PAYOFF_GOOD_THROUGH_GATE!.open, true);
  assert.equal(h.timer("SM_PAYOFF_GOOD_THROUGH_GATE")!.status, "satisfied");
});
test("24.4-T6: Given the same-servicer case with payoff posted Nov 12, 2026 and an escrow balance of $2,347.18 and no consent, then servicing 3.5's refund is due Fri Dec 11, 2026; given the `escrow_credit_to_new_loan` consent signed Nov 6, then the CD's initial escrow deposit is reduced from $2,912.50 to $565.32 and no refund check is issued.", async () => {
  const h = harness(MST("2026-11-06", "10:00"));
  // the same-servicer request goes through 16.1's intake on the existing loan (7.6's clock), never a vendor demand
  const rq = await h.run("requestPayoff", { liability_id: "LIAB-1ST", same_servicer: true, servicing_loan_id: SERVICING_LOAN, existing_servicer_party_id: "PARTY-SM", requested_good_through: "2026-11-12", state: "AZ", written_authorization_document_id: "DOC-AUTH-1", requested_on: "2026-11-02" });
  assert.equal(rq.same_servicer, true); assert.equal(h.timer("SM_PAYOFF_DEMAND_FOLLOWUP_7BD"), undefined);
  const intake = h.evts("payoff.request.received")[0]!; assert.equal(intake.loanId, SERVICING_LOAN); assert.equal(intake.payload.requester_type, "lender_or_title"); assert.ok((intake.payload.timers as string[]).includes("REGZ_1026_36C3_PAYOFF_STMT_7BD"));
  assert.equal((rq.servicing_request as { federal_statement_due: string }).federal_statement_due, "2026-11-12");   // 7 servicer business days from Mon Nov 2 skip Veterans Day (Wed Nov 11)
  // path (a): no consent → 3.5's refund: 20 federal business days from Thu Nov 12 (Thanksgiving Nov 26 excluded) → Fri Dec 11, 2026
  h.clock.set(MST("2026-11-12", "16:00"));
  const a = await h.run("decideEscrowTreatment", { liability_id: "LIAB-1ST", servicing_loan_id: SERVICING_LOAN, payoff_posted_on: "2026-11-12", escrow_balance_cents: 234_718n, settlement_date: "2026-11-12", initial_escrow_deposit_cents: 291_250n, consent: null });
  assert.equal(a.escrow_treatment, "refund_by_servicer"); assert.equal(a.refund_due_on, "2026-12-11"); assert.equal(a.refund_check_issued, true); assert.equal(a.new_initial_deposit_cents, 291_250n); assert.equal(a.credited_cents, 0n);
  assert.equal(payoffRefundDue(D("2026-11-12")), "2026-12-11");
  assert.equal(h.evts("payoff.escrow_treatment.decided")[0]!.payload.escrow_treatment, "refund_by_servicer");
  // path (b): `escrow_credit_to_new_loan` consent signed Fri Nov 6 → the CD's initial escrow deposit $2,912.50 → $565.32; no refund check
  const b = await h.run("decideEscrowTreatment", { liability_id: "LIAB-1ST", servicing_loan_id: SERVICING_LOAN, payoff_posted_on: "2026-11-12", escrow_balance_cents: 234_718n, settlement_date: "2026-11-12", initial_escrow_deposit_cents: 291_250n, consent: { kind: "escrow_credit_to_new_loan", captured_at: "2026-11-06" }, consent_id: "consent:escrow_credit_to_new_loan:L-PRIOR-531240:APP-REFI-560K" });
  assert.equal(b.escrow_treatment, "credit_to_new_loan"); assert.equal(b.credited_cents, 234_718n); assert.equal(b.new_initial_deposit_cents, 56_532n); assert.equal(b.refund_check_issued, false); assert.equal(b.refund_method, "credit_to_new_loan"); assert.equal(b.excess_refund_cents, 0n);
  assert.equal((b.consent_gate as { captured_by_settlement: boolean }).captured_by_settlement, true);
  assert.equal(h.rt.store.get("payoff_demands", `${REFI}:LIAB-1ST`)!.data.escrow_treatment, "credit_to_new_loan");
  const pure = decideEscrowTreatment({ same_servicer: true, payoff_posted_on: D("2026-11-12"), escrow_balance_cents: 234_718n, consent: { kind: "escrow_credit_to_new_loan", captured_at: D("2026-11-06") }, settlement_date: D("2026-11-12"), initial_escrow_deposit_cents: 291_250n });
  assert.equal(pure.new_initial_deposit_cents, 291_250n - 234_718n);
  await assert.rejects(h.run("decideEscrowTreatment", { liability_id: "LIAB-1ST", servicing_loan_id: SERVICING_LOAN, payoff_posted_on: "2026-11-12", escrow_balance_cents: 234_718n, settlement_date: "2026-11-12", force_credit_without_consent: true }), (e: Error) => e instanceof CommandRefused && e.code === "ESCROW_CREDIT_NEEDS_CONSENT");
});
test("24.4-T7: Given a HELOC ($50,000 line, $18,000 drawn) staying in place on the $560,000/$800,000 refinance, then `cltv_bps=7225`, `hcltv_bps=7625`; when no executed resubordination exists on Nov 5, 2026, then `consummate` is refused by `FNMA_B2_1_2_04_RESUBORDINATION_GATE`; when an agreement with a balloon 3 years after the note date is received, then `terms_ok=false` and the lien must be paid off.", async () => {
  const h = harness(MST("2026-10-07", "15:00"));
  // DU findings Wed Oct 7 with the retained HELOC → request due Tue Oct 13 (Mon Oct 12 is Columbus Day); sent Thu Oct 8
  h.events.append({ type: "du.findings.received", applicationId: REFI, actor: AGENT, payload: { application_id: REFI, findings_date: "2026-10-07", retained_subordinate_lien: true } });
  const t3 = h.timer("SM_SUBORDINATION_REQUEST_3BD")!; assert.equal(t3.dueDate, "2026-10-13"); assert.equal(subordinationRequestDue(D("2026-10-07")), "2026-10-13");
  h.clock.set(MST("2026-10-08", "10:00"));
  const rq = await h.run("requestSubordination", { liability_id: "LIAB-HELOC", lienholder_party_id: "PARTY-HELOC-BANK", lien_kind: "heloc", first_cents: 56_000_000n, value_cents: 80_000_000n, heloc_line_cents: 5_000_000n, heloc_drawn_cents: 1_800_000n, requested_on: "2026-10-08" });
  assert.equal(rq.cltv_bps, 7225); assert.equal(rq.hcltv_bps, 7625); assert.equal(rq.status, "requested"); assert.equal(t3.status, "satisfied");
  assert.deepEqual(helocRatios({ first_cents: 56_000_000n, drawn_cents: 1_800_000n, line_cents: 5_000_000n, value_cents: 80_000_000n }), { cltv_bps: 7225, hcltv_bps: 7625 });
  // no executed resubordination on Thu Nov 5, 2026 → `consummate` refused by FNMA_B2_1_2_04_RESUBORDINATION_GATE
  h.clock.set(MST("2026-11-05", "09:00"));
  h.events.append({ type: "closing.scheduled", applicationId: REFI, actor: AGENT, payload: { application_id: REFI, scheduled_at: "2026-11-06", closing_id: "CL-1" } });
  assert.equal(h.timer("FNMA_B2_1_2_04_RESUBORDINATION_GATE")!.status, "armed");
  const refused = await h.gate("consummate", { consummation_on: "2026-11-06" });
  assert.equal(refused.open, false); assert.equal(refused.refused_by, "FNMA_B2_1_2_04_RESUBORDINATION_GATE"); assert.equal(refused.by.FNMA_B2_1_2_04_RESUBORDINATION_GATE!.reason, "subordination_LIAB-HELOC_requested");
  assert.equal(resubordinationGate({ subordinations: [{ liability_id: "LIAB-HELOC", status: "requested" }] }).open, false);
  // an agreement with a balloon 3 years after the note date fails B2-1.2-04 → terms_ok=false; the lien must be paid off
  const bad = await h.run("checkSubordinateTerms", { liability_id: "LIAB-HELOC", agreement_document_id: "DOC-SUB-1", executed_at: "2026-11-05", recordable: true, terms: { note_date: "2026-11-06", maturity_or_balloon_on: "2029-11-06", payments_cover_interest: true, negative_amortization: false, market_rate: true, clearly_subordinate: true, lien_kind: "heloc" } });
  assert.equal(bad.terms_ok, false); assert.deepEqual(bad.reasons, ["balloon_or_maturity_within_5_years_of_note_date"]); assert.equal(bad.lien_must_be_paid_off, true); assert.equal(bad.status, "rejected");
  assert.equal(h.evts("subordination.rejected").length, 1); assert.equal(h.evts("subordination.executed").length, 0);
  assert.ok(h.escalations.list().some((e) => e.kind === "underwriting_reviewer"));
  assert.equal(checkSubordinateTerms({ note_date: D("2026-11-06"), maturity_or_balloon_on: D("2031-11-06"), payments_cover_interest: true, negative_amortization: false, market_rate: true, clearly_subordinate: true, lien_kind: "heloc" }).terms_ok, true);
  const still = await h.gate("consummate", { consummation_on: "2026-11-06" }); assert.equal(still.by.FNMA_B2_1_2_04_RESUBORDINATION_GATE!.reason, "subordination_LIAB-HELOC_rejected");
  // a compliant agreement executed Wed Oct 28 satisfies the gate for consummation Fri Nov 6
  const good = await h.run("checkSubordinateTerms", { liability_id: "LIAB-HELOC", agreement_document_id: "DOC-SUB-2", executed_at: "2026-10-28", recordable: true, terms: { note_date: "2026-11-06", maturity_or_balloon_on: "2046-11-06", payments_cover_interest: true, negative_amortization: false, market_rate: true, clearly_subordinate: true, lien_kind: "heloc" } });
  assert.equal(good.status, "executed"); assert.equal(h.timer("FNMA_B2_1_2_04_RESUBORDINATION_GATE")!.status, "satisfied");
  assert.equal((await h.gate("consummate", { consummation_on: "2026-11-06" })).by.FNMA_B2_1_2_04_RESUBORDINATION_GATE!.open, true);
});
test("24.4-T8: Given verified wire instructions dated Oct 30, 2026, when new instructions arrive by e-mail on Nov 11 at 3:00 p.m. (funding Nov 12), then the wire is blocked, the vendor check returns `changed`, and only a `funding_approver` release after a second callback to the ALTA-Registry number can unblock it.", async () => {
  const h = harness(MST("2026-10-30", "10:00"));
  h.wire.register(AGENT_PARTY, "122105155", "000123456789");
  const ok = await h.run("verifyWireInstructions", { purpose: "closing_funds", beneficiary_party_id: AGENT_PARTY, routing_number: "122105155", account_number: "000123456789", instructions_channel: "letterhead", vendor: "fundingshield", callback: { number_source: "alta_registry", completed: true }, funding_at: MST("2026-11-12", "09:00") });
  const v0 = ok.verification as { verified_at: string; match_result: string; blocks_disbursement: boolean; id: string };
  assert.equal(v0.match_result, "verified"); assert.equal(v0.blocks_disbursement, false); assert.equal(v0.verified_at, MST("2026-10-30", "10:00"));
  assert.equal(h.evts("wire.instructions.verified").length, 1);
  await assert.rejects(h.run("verifyWireInstructions", { purpose: "closing_funds", beneficiary_party_id: AGENT_PARTY, routing_number: "122105155", account_number: "000123456789", instructions_channel: "letterhead", skip_callback: true }), (e: Error) => e instanceof CommandRefused && e.code === "WIRE_CALLBACK_NEVER_SKIPPED");
  await assert.rejects(h.run("verifyWireInstructions", { purpose: "closing_funds", beneficiary_party_id: AGENT_PARTY, routing_number: "122105155", account_number: "000123456789", instructions_channel: "letterhead", alter_instructions: true }), (e: Error) => e instanceof CommandRefused && e.code === "WIRE_INSTRUCTIONS_NEVER_ALTERED");
  h.clock.set(MST("2026-11-04", "10:00"));
  h.events.append({ type: "closing.scheduled", applicationId: REFI, actor: AGENT, payload: { application_id: REFI, scheduled_at: "2026-11-06", funding_at: MST("2026-11-12", "09:00") } });
  assert.equal(h.timer("SM_WIRE_VERIFICATION_GATE")!.status, "armed");
  assert.equal((await h.gate("disburse", { disbursement_date: "2026-11-12" })).by.SM_WIRE_VERIFICATION_GATE!.open, true);
  // new instructions by e-mail Wed Nov 11 at 3:00 p.m. (funding Thu Nov 12 09:00 → 18 hours away): blocked, vendor returns `changed`
  h.clock.set(MST("2026-11-11", "15:00"));
  const chg = await h.run("verifyWireInstructions", { purpose: "closing_funds", beneficiary_party_id: AGENT_PARTY, routing_number: "122105155", account_number: "999888777666", instructions_channel: "email", instructions_email_domain: "az-title-agency-secure.com", registered_email_domain: "aztitleagency.com", vendor: "fundingshield", callback: { number_source: "alta_registry", completed: true }, funding_at: MST("2026-11-12", "09:00") });
  const v1 = chg.verification as { id: string; match_result: string; blocks_disbursement: boolean; block_reason: string; hours_to_funding: number; release_requires: string | null };
  assert.equal(v1.match_result, "changed"); assert.equal(v1.blocks_disbursement, true); assert.equal(v1.hours_to_funding, 18); assert.equal(v1.block_reason, "instructions_changed_since_verification"); assert.equal(v1.release_requires, "funding_approver_after_second_callback");
  assert.equal(h.evts("wire.instructions.change_detected")[0]!.payload.blocked, true); assert.ok(h.escalations.list().some((e) => e.kind === "funding_approver")); assert.equal(h.evts("fraud.case.candidate").length, 1);
  assert.equal(h.timer("SM_WIRE_VERIFICATION_GATE")!.status, "armed");                                // armed by 26.2's `closing.scheduled`; the evaluator now closes it
  const blocked = await h.gate("disburse", { disbursement_date: "2026-11-12" });
  assert.equal(blocked.by.SM_WIRE_VERIFICATION_GATE!.open, false); assert.equal(blocked.by.SM_WIRE_VERIFICATION_GATE!.reason, "wire_not_verified");
  // only a funding_approver release after a SECOND callback to the ALTA-Registry number unblocks it
  await assert.rejects(h.run("placeCallback", { op: "release", wire_verification_id: v1.id, number_source: "alta_registry", completed: true }), (e: Error) => e instanceof CommandRefused && e.code === "LATE_WIRE_CHANGE_FUNDING_APPROVER");
  await assert.rejects(h.run("placeCallback", { op: "release", wire_verification_id: v1.id, number_source: "email", completed: true }, FUNDING_APPROVER), (e: Error) => e instanceof CommandRefused && e.code === "CALLBACK_NUMBER_NEVER_FROM_EMAIL");
  await assert.rejects(h.run("placeCallback", { op: "release", wire_verification_id: v1.id, number_source: "alta_registry", completed: false }, FUNDING_APPROVER), RangeError);
  h.clock.set(MST("2026-11-11", "16:30"));
  const rel = await h.run("placeCallback", { op: "release", wire_verification_id: v1.id, number_source: "alta_registry", completed: true }, FUNDING_APPROVER);
  assert.equal(rel.unblocked, true); assert.equal((rel.verification as { callback_number_source: string }).callback_number_source, "alta_registry");
  assert.equal(h.evts("wire.instructions.verified").length, 2); assert.equal(h.timer("SM_WIRE_VERIFICATION_GATE")!.status, "satisfied");
  assert.equal((await h.gate("disburse", { disbursement_date: "2026-11-12" })).by.SM_WIRE_VERIFICATION_GATE!.open, true);
  // pure rules
  const pv = verifyWireInstructions({ application_id: REFI, purpose: "closing_funds", beneficiary_party_id: AGENT_PARTY, routing_number: "122105155", account_number: "999888777666", instructions_channel: "email", vendor: "certifid", vendor_match: "changed", prior_verified: { instructions_hash: v0.id && "sha256:other", verified_at: MST("2026-10-30", "10:00") }, callback: { number_source: "alta_registry", completed: true }, received_at: MST("2026-11-11", "15:00"), funding_at: MST("2026-11-12", "09:00") });
  assert.equal(pv.release_requires, "funding_approver_after_second_callback");
  assert.throws(() => releaseWireBlock(pv, { actor_role: "officer", second_callback_number_source: "alta_registry", second_callback_completed: true, released_at: MST("2026-11-11", "16:00") }), /funding_approver/);
  assert.equal(wireVerificationGate({ verified_at: MST("2026-09-25", "10:00"), as_of: MST("2026-11-12", "09:00") }).reason, "wire_verification_older_than_30_days");
});
test("24.4-T9: Given a cash-out refinance with a POA presented by the borrower's spouse, when reviewed, then `result='ineligible'` (transaction type) unless `applicable_law_override` with a written file statement; given a limited cash-out with the title agency's employee as attorney-in-fact, then eligibility requires the recorded interactive session and a CPL.", async () => {
  const h = harness(MST("2026-10-20", "10:00"));
  const base = { agent_relationship: "relative", agent_ineligible_class: "none", interactive_session_recording_id: null, cpl_document_id: null, notarized: true, dated_valid: true, references_property: true, names_match: true, applicable_law_override: false, override_statement_document_id: null };
  const cashOut = await h.run("reviewPOA", { borrower_id: "B1", poa: { ...base, transaction_type: "cash_out" } });
  assert.equal(cashOut.result, "ineligible"); assert.deepEqual(cashOut.reasons, ["transaction_type_cash_out_ineligible"]); assert.equal(cashOut.all_vesting_reviews_eligible, false);
  await assert.rejects(h.run("reviewPOA", { borrower_id: "B1", poa: { ...base, transaction_type: "cash_out" }, force_eligible: true }), (e: Error) => e instanceof CommandRefused && e.code === "POA_CASH_OUT_NEVER");
  // the applicable-law override needs the written file statement
  assert.equal(reviewPOA({ ...base, transaction_type: "cash_out", applicable_law_override: true, override_statement_document_id: null } as Parameters<typeof reviewPOA>[0]).result, "ineligible");
  const overridden = await h.run("reviewPOA", { borrower_id: "B1", poa: { ...base, transaction_type: "cash_out", applicable_law_override: true, override_statement_document_id: "DOC-LAW-STATEMENT-1" } });
  assert.equal(overridden.result, "eligible"); assert.equal(h.evts("poa.reviewed").length, 2);
  // limited cash-out with the title agency's employee as attorney-in-fact: recorded interactive session + CPL required
  const employee = await h.run("reviewPOA", { borrower_id: "B2", poa: { ...base, transaction_type: "limited_cash_out", agent_relationship: "other", agent_ineligible_class: "title_employee" } });
  assert.equal(employee.result, "needs_documents"); assert.equal(employee.cpl_required, true); assert.equal(employee.interactive_session_required, true);
  assert.deepEqual(employee.reasons, ["recorded_interactive_session_required", "cpl_required_for_title_employee_agent"]);
  const complete = await h.run("reviewPOA", { borrower_id: "B2", poa: { ...base, transaction_type: "limited_cash_out", agent_relationship: "other", agent_ineligible_class: "title_employee", interactive_session_recording_id: "REC-SESSION-77", cpl_document_id: "DOC-CPL-1" } });
  assert.equal(complete.result, "eligible"); assert.equal(complete.aol_barred, true); assert.equal(complete.all_vesting_reviews_eligible, true);
  assert.equal(h.evts("vesting.reviews.completed").at(-1)!.payload.all_eligible, true);
  await assert.rejects(h.run("reviewPOA", { borrower_id: "B2", poa: { ...base, transaction_type: "purchase" }, use_aol: true }), (e: Error) => e instanceof CommandRefused && e.code === "AOL_BARRED_ON_POA");
  assert.equal(evaluateGate("24.4.trustPoaReviewGate", { trust_reviews: [], poa_reviews: [{ borrower_id: "B2", result: "eligible" }] }).open, true);
});
test("24.4-T10: Given an inter vivos trust whose sole trustee is the settlor's adult child (not institutional), when reviewed, then `result='ineligible'`; given the settlor as co-trustee with the child, then eligible, SFC 168 is set, and the signature plan includes the settlor acknowledgment.", async () => {
  const h = harness(MST("2026-10-20", "10:00"));
  const trust = { trust_name: "Fixture Family Revocable Trust dated 2019-03-01", revocable: true, settlor_is_trustee: false, institutional_trustee: false, primary_beneficiary_is_settlor: true, power_to_mortgage: true, occupancy_ok: true, qualifying_party_ok: true, certification_document_id: "DOC-TRUST-CERT-1", certification_statute: true, title_insures_without_trustee_exception: true, state: "AZ" };
  const child = await h.run("reviewTrust", { borrower_id: "B1", trust });
  assert.equal(child.result, "ineligible"); assert.deepEqual(child.reasons, ["trustee_neither_settlor_nor_institutional"]); assert.equal(child.sfc_168, false); assert.deepEqual(child.signature_plan, []);
  assert.equal(h.evts("delivery.sfc.queued").length, 0);
  const co = await h.run("reviewTrust", { borrower_id: "B1", trust: { ...trust, settlor_is_trustee: true } });
  assert.equal(co.result, "eligible"); assert.equal(co.sfc_168, true);
  assert.ok((co.signature_plan as string[]).some((s) => /settlor_acknowledgment/.test(s))); assert.ok((co.signature_plan as string[]).some((s) => /trustee_capacity_signature/.test(s)));
  assert.equal(h.evts("delivery.sfc.queued")[0]!.payload.code, "168"); assert.equal(h.evts("trust.reviewed").at(-1)!.payload.result, "eligible");
  assert.equal(co.all_vesting_reviews_eligible, true); assert.equal(h.rt.store.get("trust_reviews", `${REFI}:B1`)!.data.sfc_168, true);
  h.events.append({ type: "closing.scheduled", applicationId: REFI, actor: AGENT, payload: { application_id: REFI, scheduled_at: "2026-11-06" } });
  assert.equal(h.timer("SM_TRUST_POA_REVIEW_GATE")!.status, "armed");
  assert.equal((await h.gate("generate_documents", { consummation_on: "2026-11-06" })).open, true);
  assert.equal(reviewTrust({ ...trust, settlor_is_trustee: false, institutional_trustee: true }).result, "eligible");   // an institutional trustee also satisfies B2-2-05
  assert.equal(reviewTrust({ ...trust, settlor_is_trustee: true, revocable: false }).result, "ineligible");
});
test("24.4-T11: Given a Texas 50(a)(6) loan requesting an attorney opinion letter, when the AOL path is evaluated, then it is refused (ineligible transaction) and T-2/T-42/T-42.1 are required; given a T-42 with paragraph 2(c) deleted, then the gate fails.", async () => {
  const h = harness(MST("2026-10-20", "10:00"));
  const orderId = await h.order({ property: { state: "TX", tx_50a6: true, state_promulgated_forms: true } });
  const r = await h.run("evaluateGates", { command: "consummate", partner_name: PARTNER, order_id: orderId, aol: { aol_enabled: true, tx_50a6: true, attorney_licensed_in_state: true, malpractice_prevailing: true, elements: { addressee: true, indemnity: true, gap: true, priority_fee_simple: true, subordinate_liens_listed: true, alta_8_1_language: true, no_survey_exception: true, jurisdiction_test_documented: true } } });
  const aol = r.aol as { allowed: boolean; reason: string; required_instead: string[] };
  assert.equal(aol.allowed, false); assert.equal(aol.reason, "ineligible_transaction:texas_50a6"); assert.deepEqual(aol.required_instead, ["T-2", "T-42", "T-42.1"]);
  assert.equal(h.evts("title.aol.refused")[0]!.payload.reason, "ineligible_transaction:texas_50a6");
  await assert.rejects(h.run("evaluateGates", { command: "consummate", aol: { aol_enabled: true, tx_50a6: true }, force_aol: true }), (e: Error) => e instanceof CommandRefused && e.code === "AOL_WHERE_BARRED");
  const req = await h.run("computeRequiredEndorsements", { property: { state: "TX", tx_50a6: true }, committed_endorsements: ["T-2", "T-42", "T-42.1"] });
  assert.deepEqual(req.required_endorsements, ["T-2", "T-42", "T-42.1"]); assert.equal(req.gate_passes, true);
  // a T-42 with paragraph 2(c) deleted fails the gate
  const del = await h.run("computeRequiredEndorsements", { property: { state: "TX", tx_50a6: true }, committed_endorsements: ["T-2", "T-42", "T-42.1"], t42_deleted_paragraphs: ["2(c)"] });
  assert.equal(del.gate_passes, false); assert.equal((del.tx_50a6 as { reason: string }).reason, "t42_paragraph_deleted:2(c)");
  assert.equal(tx50a6TitleCheck({ endorsements: ["T-2", "T-42", "T-42.1"], t42_deleted_paragraphs: ["2(c)"] }).open, false);
  assert.equal(tx50a6TitleCheck({ endorsements: ["T-2", "T-42", "T-42.1"], closing_type: "ron" }).reason, "ron_closing_not_permitted_tx_50a6");
  assert.equal(titleEvidenceGate({ policy_form: "Texas T-2 Mortgagee Policy (state promulgated)", state_promulgated_equivalent: true, required_endorsements: ["T-2", "T-42", "T-42.1"], issued_endorsements: ["T-2", "T-42", "T-42.1"], t42_deletions: ["2(c)"], policy_amount_cents: 56_000_000n, note_amount_cents: 56_000_000n, proposed_insured_text: INSURED }).reason, "t42_paragraph_deleted:2(c)");
  assert.equal(evaluateAolPath({ aol_enabled: true, poa: true }).reason, "ineligible_transaction:power_of_attorney");
  assert.equal(evaluateAolPath({ aol_enabled: false }).allowed, false);
});
test("24.4-T12: Given a NY CEMA refinance of $560,000 consolidating $531,240, then `new_money_cents = 2,876,000`, the §255 affidavit is generated, the existing lender's assignment is a required deliverable, and the mortgage-tax fee item is computed on $28,760 only.", async () => {
  const h = harness(MST("2026-10-20", "10:00"));
  const r = await h.run("evaluateGates", { command: "consummate", partner_name: PARTNER, cema: { new_note_cents: 56_000_000n, consolidated_upb_cents: 53_124_000n, existing_lender_will_assign: true, mortgage_tax_rate_bps: 180 } });
  const cema = r.cema as { new_money_cents: bigint; mortgage_tax_base_cents: bigint; mortgage_tax_cents: bigint; deliverables: string[]; cema_available: boolean };
  assert.equal(cema.new_money_cents, 2_876_000n); assert.equal(cema.mortgage_tax_base_cents, 2_876_000n); assert.equal(cema.cema_available, true);
  assert.equal(cema.mortgage_tax_cents, (2_876_000n * 180n) / 10_000n);                              // the fee item is computed on $28,760 only
  assert.ok(cema.deliverables.includes("section_255_affidavit")); assert.ok(cema.deliverables.includes("assignment_of_mortgage_from_existing_lender"));
  const pure = cemaNewMoney({ new_note_cents: 56_000_000n, consolidated_upb_cents: 53_124_000n, existing_lender_will_assign: true });
  assert.equal(pure.new_money_cents, 56_000_000n - 53_124_000n); assert.equal(pure.mortgage_tax_cents, null);
  const declined = cemaNewMoney({ new_note_cents: 56_000_000n, consolidated_upb_cents: 53_124_000n, existing_lender_will_assign: false });
  assert.equal(declined.cema_available, false); assert.equal(declined.mortgage_tax_base_cents, 56_000_000n); assert.match(String(declined.fallback), /full mortgage tax/);
});
test("24.4-T13: Given a tax certificate showing the second-half 2026 Maricopa County installment delinquent, when classified, then `to_be_paid` blocks consummation until the settlement statement shows the payment.", async () => {
  const h = harness(MST("2026-10-12", "09:00"));
  const orderId = await h.order();
  const cert = [{ label: "2026 first half — Maricopa County", due_on: D("2026-10-01"), amount_cents: 214_000n, delinquent: false, paid: true }, { label: "2026 second half — Maricopa County", due_on: D("2027-03-01"), amount_cents: 214_000n, delinquent: true, paid: false }];
  const cls = classifyTaxCertificate({ installments: cert, consummation_on: D("2026-11-06") });
  assert.equal(cls.blocks_consummation, true); assert.equal(cls.items[1]!.classification, "to_be_paid"); assert.equal(cls.items[1]!.blocking, true); assert.equal(cls.items[0]!.classification, "ok");
  h.clock.set(MST("2026-10-15", "11:00"));
  const r = await h.run("parseCommitment", commitment({ order_id: orderId, tax_certificate: cert, consummation_on: "2026-11-06" }));
  assert.equal(r.status, "curative_open");
  const item = (r.curative_opened as CurativeItem[]).find((c) => c.kind === "tax_delinquent")!;
  assert.equal(item.source, "tax_cert"); assert.equal(item.blocks_consummation, true); assert.equal(item.owner, "settlement_agent");
  h.events.append({ type: "closing.scheduled", applicationId: REFI, actor: AGENT, payload: { application_id: REFI, scheduled_at: "2026-11-06" } });
  const blocked = await h.gate("consummate", { consummation_on: "2026-11-06" });
  assert.equal(blocked.open, false); assert.equal((blocked.clearance as { missing: string[] }).missing[0], "1 blocking curative item(s)");
  // the settlement statement shows the payment → cleared as paid_at_closing
  const shown = classifyTaxCertificate({ installments: cert, consummation_on: D("2026-11-06"), settlement_statement_shows_payment: ["2026 second half — Maricopa County"] });
  assert.equal(shown.blocks_consummation, false); assert.equal(shown.items[1]!.cleared, true);
  const cleared = await h.run("openCurative", { op: "clear", curative_id: item.id, resolution: "paid_at_closing", evidence_document_id: "DOC-SETTLEMENT-STMT-1" });
  assert.equal(cleared.open_blocking_items, 0); assert.equal(cleared.order_status, "reviewed");
  assert.equal(h.evts("title.curative.cleared")[0]!.payload.resolution, "paid_at_closing");
  // an installment due within 60 days after consummation is also paid at closing (rule 5)
  assert.equal(classifyTaxCertificate({ installments: [{ label: "due soon", due_on: D("2026-12-15"), amount_cents: 1n, delinquent: false, paid: false }], consummation_on: D("2026-11-06") }).items[0]!.classification, "to_be_paid");
});
test("24.4-T14: Given a CPL naming a different agent than `settlement_agent_party_id`, when `SM_CPL_BEFORE_FUNDING_GATE` runs, then `disburse` is refused with reason `cpl_agent_mismatch`.", async () => {
  const h = harness(MST("2026-10-12", "09:00"));
  const orderId = await h.order();
  h.clock.set(MST("2026-11-04", "10:00"));
  h.events.append({ type: "closing.scheduled", applicationId: REFI, actor: AGENT, payload: { application_id: REFI, scheduled_at: "2026-11-06" } });
  assert.equal(h.timer("SM_CPL_BEFORE_FUNDING_GATE")!.status, "armed");
  const wrong = await h.run("requestCPL", { op: "receive", order_id: orderId, cpl_document_id: "DOC-CPL-1", cpl_date: "2026-11-04", cpl_underwriter_party_id: UNDERWRITER, cpl_agent_party_id: "PARTY-OTHER-AGENCY", addressees: [`${PARTNER}, its successors and/or assigns`], partner_name: PARTNER, funding_date: "2026-11-12" });
  assert.equal(wrong.open, false); assert.equal(wrong.reason, "cpl_agent_mismatch"); assert.equal(wrong.cpl_agent_ok, false); assert.equal(wrong.cpl_addressee_ok, true);
  assert.equal(h.evts("cpl.received")[0]!.payload.cpl_addressee_ok, false); assert.equal(h.timer("SM_CPL_BEFORE_FUNDING_GATE")!.status, "armed");
  const refused = await h.gate("disburse", { disbursement_date: "2026-11-12" });
  assert.equal(refused.open, false); assert.equal(refused.by.SM_CPL_BEFORE_FUNDING_GATE!.open, false); assert.equal(refused.by.SM_CPL_BEFORE_FUNDING_GATE!.reason, "cpl_agent_mismatch");
  assert.equal(evaluateGate("24.4.cplBeforeFundingGate", { cpl_underwriter_party_id: UNDERWRITER, underwriter_party_id: UNDERWRITER, cpl_agent_party_id: "PARTY-OTHER-AGENCY", settlement_agent_party_id: AGENT_PARTY, addressees: [PARTNER], partner_name: PARTNER, transaction_ref: REFI, application_ref: REFI, cpl_date: "2026-11-04", funding_date: "2026-11-12" }).reason, "cpl_agent_mismatch");
  // the re-issued CPL for the assigned agent satisfies the gate
  const right = await h.run("requestCPL", { op: "receive", order_id: orderId, cpl_document_id: "DOC-CPL-2", cpl_date: "2026-11-05", cpl_underwriter_party_id: UNDERWRITER, cpl_agent_party_id: AGENT_PARTY, addressees: [`${PARTNER}, its successors and/or assigns`], partner_name: PARTNER, funding_date: "2026-11-12" });
  assert.equal(right.open, true); assert.equal(h.timer("SM_CPL_BEFORE_FUNDING_GATE")!.status, "satisfied");
  assert.equal((await h.gate("disburse", { disbursement_date: "2026-11-12" })).by.SM_CPL_BEFORE_FUNDING_GATE!.open, true);
  assert.equal(cplBeforeFundingGate({ cpl_underwriter_party_id: UNDERWRITER, underwriter_party_id: UNDERWRITER, cpl_agent_party_id: AGENT_PARTY, settlement_agent_party_id: AGENT_PARTY, addressees: ["Some Other Lender"], partner_name: PARTNER, transaction_ref: REFI, application_ref: REFI, cpl_date: D("2026-11-05"), funding_date: D("2026-11-12") }).reason, "cpl_addressee_not_partner");
  assert.equal(cplBeforeFundingGate({ cpl_underwriter_party_id: UNDERWRITER, underwriter_party_id: UNDERWRITER, cpl_agent_party_id: AGENT_PARTY, settlement_agent_party_id: AGENT_PARTY, addressees: [PARTNER], partner_name: PARTNER, transaction_ref: REFI, application_ref: REFI, cpl_date: D("2026-11-13"), funding_date: D("2026-11-12") }).reason, "cpl_dated_after_funding");
});
test("24.4 worked figures: external payoff (rule 6), same-servicer escrow (rule 7), HELOC ratios (rule 9), coverage floor (rule 3)", () => {
  // Rule 6: principal $531,240.00 at 7.25% → per diem $105.52 (531,240 × 0.0725 ÷ 365 = 105.5186…, rounded by the servicer); interest Nov 1–12 = 12 × $105.52 = $1,266.24; release recording fee $30.00; total $532,536.24
  const stmt = parsePayoffStatement({ principal_cents: 53_124_000n, rate_pct: "7.25", interest_paid_through: D("2026-10-31"), per_diem_cents: 10_552n, good_through_date: D("2026-11-12"), recording_fee_cents: 3_000n, statement_date: D("2026-11-04"), stated_total_cents: 53_253_624n });
  assert.equal(servicerPerDiem(53_124_000n, "7.25"), 10_552n);
  assert.equal(stmt.computed_per_diem_cents, 10_552n); assert.equal(stmt.per_diem_reconciles, true);
  assert.equal(stmt.interest_days, 12); assert.equal(stmt.interest_cents, 126_624n);
  assert.equal(stmt.fees_cents, 3_000n); assert.equal(stmt.total_cents, 53_253_624n); assert.equal(stmt.stated_total_matches, true);
  // planning figure if funding slipped to Fri Nov 13: $532,536.24 + $105.52 = $532,641.76 — never the funding figure
  const slip = computePayoffAtDate({ total_cents: stmt.total_cents, per_diem_cents: 10_552n, good_through_date: D("2026-11-12") }, D("2026-11-13"));
  assert.equal(slip.extra_days, 1); assert.equal(slip.total_at_cents, 53_264_176n); assert.equal(slip.stale, true);
  assert.equal(computePayoffAtDate({ total_cents: stmt.total_cents, per_diem_cents: 10_552n, good_through_date: D("2026-11-12") }, D("2026-11-12")).total_at_cents, 53_253_624n);
  // Rule 7: escrow balance $2,347.18 after the Nov 12 posting; (a) refund due Fri Dec 11, 2026; (b) initial deposit $2,912.50 → $565.32
  const a = decideEscrowTreatment({ same_servicer: true, payoff_posted_on: D("2026-11-12"), escrow_balance_cents: 234_718n, consent: null, settlement_date: D("2026-11-12"), initial_escrow_deposit_cents: 291_250n });
  assert.equal(a.refund_due_on, "2026-12-11"); assert.equal(a.excess_refund_cents, 234_718n);
  const b = decideEscrowTreatment({ same_servicer: true, payoff_posted_on: D("2026-11-12"), escrow_balance_cents: 234_718n, consent: { kind: "escrow_credit_to_new_loan", captured_at: D("2026-11-06") }, settlement_date: D("2026-11-12"), initial_escrow_deposit_cents: 291_250n });
  assert.equal(b.credited_cents, 234_718n); assert.equal(b.new_initial_deposit_cents, 56_532n); assert.equal(b.refund_check_issued, false);
  // Rule 9: HELOC line $50,000.00, drawn $18,000.00, value $800,000.00, first $560,000.00 → CLTV 72.25% (7225 bps), HCLTV 76.25% (7625 bps)
  assert.deepEqual(helocRatios({ first_cents: 56_000_000n, drawn_cents: 1_800_000n, line_cents: 5_000_000n, value_cents: 80_000_000n }), { cltv_bps: 7225, hcltv_bps: 7625 });
  // Rule 3: $560,000.00 note → policy amount ≥ 56,000,000 cents
  assert.equal(titleEvidenceGate({ policy_form: "ALTA Loan Policy (07-01-2021)", required_endorsements: ["ALTA 8.1"], issued_endorsements: ["ALTA 8.1"], policy_amount_cents: 55_999_999n, note_amount_cents: 56_000_000n, proposed_insured_text: INSURED }).reason, "policy_amount_below_original_principal");
  assert.equal(titleEvidenceGate({ policy_form: "ALTA Loan Policy (07-01-2021)", required_endorsements: ["ALTA 8.1"], issued_endorsements: ["ALTA 8.1"], policy_amount_cents: 56_000_000n, note_amount_cents: 56_000_000n, proposed_insured_text: INSURED }).open, true);
  // Rule 15: NY CEMA $560,000.00 consolidating $531,240.00 → new money $28,760.00
  assert.equal(cemaNewMoney({ new_note_cents: 56_000_000n, consolidated_upb_cents: 53_124_000n, existing_lender_will_assign: true }).new_money_cents, 2_876_000n);
  // Q2 policy: commitment effective Oct 14 is inside the 30-day window for a Nov 6 consummation (window opens Oct 7)
  assert.deepEqual(commitmentDatedownGate({ commitment_effective_date: D("2026-10-14"), consummation_on: D("2026-11-06") }), { open: true, reason: null, reasons: [], window_opens: "2026-10-07" });
});
