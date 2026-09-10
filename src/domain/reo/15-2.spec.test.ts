// 15.2 Expense reimbursement submission
// spec/sections/15-reo-claims-expense-reimbursement/15-2-expense-reimbursement-submission.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { TOOLS_15_2 } from "../../app/tools/section15-2.ts";
import { FakeFnmaP360 } from "../../infra/integrations/fnma.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { unearnedPremiumCredit, claimTotals, achExpected, attachmentContainsSsn } from "./claims.ts";
import { EVALUATORS_15_2 } from "./evaluators-15-2.ts";
import { validateLine152 as validateLine, claimContext152, exhibitFor, allowableFor, allowableRowKey, ALLOWABLE_FEE_SCHEDULES, FCL_FEE_RULE_SET, PPM_RULE_SET, F105_LIMITS_RULE_SET, TECH_FEE_RULE_SET, itemize, milestoneBilling, excessFeeApprovalRequest, assembleClaim, buildBulkPackage, submissionChannel, resubmissionCheck,
  psaOutcome, psaAutoDenialSweep, achMatchOutcome, projectStatusUpdate, triageDenial, denialBriefing, irtInquiryDue, irtReplyDue, postPaymentCredit, creditReceivedEvent, reconcileReport, sweepClaimCandidates, milestoneReached, recoveryRepaymentBatch, reimbursedAdvancesFromClaims, incentiveRepayment, deferralExpenseClaim, deferralRule, escrowAdvanceCutoff, overAllowableConditions, ingestHomeTrackerBid, bidReconsideration, POST_PAYOFF_PD_SUBTYPE, WORKOUT_INCENTIVE_CAP_CENTS, FNMA_REO_DISBURSEMENTS_MAILBOX, type AssembleInput, type ClaimContext152 } from "./ops-15-2.ts";

// Fixture L15 (rule 9): REO, MI-insured, TX non-judicial, sale Tue Oct 5, 2027; special servicing option; default date Dec 1, 2026 (LPI Nov 1, 2026);
// Fannie Mae acquired at the sale. The TX exhibit ($2,300) comes from the versioned schedule, never from the caller.
const CTX: ClaimContext152 = claimContext152({ event_date: D("2027-10-05"), state: "TX", track: "non_judicial", servicing_option: "special", default_date: D("2026-12-01"), acquired_by_fnma: true });
const L15: AssembleInput["lines"] = [
  { advance_id: "adv-tax-2026", kind: "taxes", unit_cents: 482_000n, quantity: 1, paid_on: D("2027-01-31"), invoice: true },
  { advance_id: "adv-hazard", kind: "hazard", unit_cents: 145_000n, quantity: 1, paid_on: D("2027-03-15"), invoice: true },
  { advance_id: "adv-mi", kind: "mi_premium", unit_cents: 12_454n, quantity: 11, paid_on: D("2027-10-01"), invoice: true, service_start: D("2026-12-01"), service_end: D("2027-10-31") },
  { advance_id: "adv-insp", kind: "inspection", unit_cents: 3_000n, quantity: 9, paid_on: D("2027-09-30"), invoice: true, inspection_type: "exterior", f105_inspection_type: "exterior" },
  // rule 5: the $445 preservation bundle is itemized under PPM codes (vacant Jul 9, 2027)
  { advance_id: "adv-ppm-lock", kind: "preservation", preservation_code: "lock_change", unit_cents: 6_000n, quantity: 1, paid_on: D("2027-08-01"), invoice: true, service_date: D("2027-07-09") },
  { advance_id: "adv-ppm-cut", kind: "preservation", preservation_code: "initial_grass_cut", unit_cents: 12_500n, quantity: 1, paid_on: D("2027-08-01"), invoice: true, service_date: D("2027-07-09") },
  { advance_id: "adv-ppm-recut", kind: "preservation", preservation_code: "grass_recut", unit_cents: 8_000n, quantity: 2, paid_on: D("2027-09-01"), invoice: true, service_date: D("2027-08-20") },
  { advance_id: "adv-ppm-debris", kind: "preservation", preservation_code: "debris_removal_cy", unit_cents: 5_000n, quantity: 2, paid_on: D("2027-08-01"), invoice: true, service_date: D("2027-07-09") },
  { advance_id: "adv-fcl-fee", kind: "attorney_fee", unit_cents: 230_000n, quantity: 1, paid_on: D("2027-10-06"), invoice: true, milestone_pct: 100 },
  { advance_id: "adv-fcl-cost", kind: "attorney_cost", unit_cents: 56_500n, quantity: 1, paid_on: D("2027-10-06"), invoice: true },
  { advance_id: "adv-tech", kind: "technology", unit_cents: 2_500n, quantity: 1, paid_on: D("2027-10-06"), invoice: true },
  { advance_id: "adv-einv", kind: "einvoice", einvoice_kind: "fcl", unit_cents: 500n, quantity: 1, paid_on: D("2027-10-06"), invoice: true },
];
const HAZARD_REFUND = { kind: "hazard_refund" as const, amount_cents: unearnedPremiumCredit(145_000n, D("2027-03-20"), D("2028-03-20"), D("2027-10-05")), received_at: D("2027-11-02") };
const l15Input = (over: Partial<AssembleInput> = {}): AssembleInput => ({ loan_id: "L15", claim_type: "571", milestone_kind: "foreclosure_sale", milestone_date: D("2027-10-05"), mi_insured: true, disposition_date: null, lines: L15, credits: [HAZARD_REFUND], context: CTX, hazard_refund_expected: true, ...over });
const l15Claim = () => assembleClaim(l15Input());

// ---- harness: the overridden timer registry on a memory event store, and the 15.2 tools bound to the bus ----
const CLAIMS_REO: Actor = { kind: "agent", id: "claims-reo" };
const OPERATOR: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };
function harness(nowIso: string, ports: ToolRuntime["ports"] = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["15.2", "9.9"] });   // 9.9 owns the two PPM codes the 15.2 timer table reuses
  const decisions: DecisionInput[] = [];
  const ctx: UowContext = { loanId: "L15", events, ledger: new MemoryLedger(), timers: engine, clock, decide: (d) => { decisions.push({ loanId: "L15", ...d }); } };
  const rt: ToolRuntime = { store: new EntityStore(), ports, escalations: new EscalationService(events, clock), services: {} };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const cmds = new Map(TOOLS_15_2.map((d) => { const c = toolCommand(d, rt, ["attorney", "fnma_portal_operator", "officer"]); agents.registerTool(d.agent, c.name); return [d.name, c] as const; }));
  const run = (tool: string, actor: Actor, input: Record<string, unknown>) => bus.execute(cmds.get(tool)!, actor, input, ctx);
  const types = () => events.all().map((e) => e.type);
  return { clock, events, engine, ctx, rt, run, types, decisions };
}
const claimInput = { loan_id: "L15", claim_id: "SM-L15-571-001", claim_number: "SM-L15-571-001", claim_type: "571", milestone_kind: "foreclosure_sale", milestone_date: "2027-10-05", mi_insured: true, lines: L15, credits: [HAZARD_REFUND], context: CTX, hazard_refund_expected: true };

test("15.2-T1: Given fixture L15 (REO, MI-insured, sale Oct 5, 2027), then `final_due_at` = Nov 4, 2027, the claim gross is $11,249.94, credit $659.45, net $10,590.49, and every line passes validation with the allowable code and cap recorded.", () => {
  const claim = l15Claim();
  assert.equal(claim.final_due_at, D("2027-11-04")); assert.equal(claim.internal_target_at, D("2027-10-25"));
  assert.equal(claim.gross, 1_124_994n); assert.equal(HAZARD_REFUND.amount_cents, 65_945n); assert.equal(claim.net, 1_059_049n);
  assert.equal(claim.status, "validated"); assert.deepEqual(claim.exceptions, []); assert.deepEqual(claim.excluded, []); assert.deepEqual(claim.escalations, []);
  assert.ok(claim.lines.every((l) => l.validation === "pass" && l.indicator === "blank"), "liquidation claim: every line passes with the indicator blank");
  // the allowable code, cap and schedule version recorded per line (rule 2; F-1-05 inspection $30 exterior; PPM caps; TX exhibit $2,300; E-5-06 $25 / $5)
  assert.deepEqual(claim.lines.map((l) => [l.advance_id, l.code, l.cap, l.rule_set]), [
    ["adv-tax-2026", "taxes", null, F105_LIMITS_RULE_SET], ["adv-hazard", "hazard", null, F105_LIMITS_RULE_SET], ["adv-mi", "mi_premium", null, F105_LIMITS_RULE_SET], ["adv-insp", "inspection_exterior", 3_000n, F105_LIMITS_RULE_SET],
    ["adv-ppm-lock", "lock_change", 6_000n, PPM_RULE_SET], ["adv-ppm-cut", "initial_grass_cut", 12_500n, PPM_RULE_SET], ["adv-ppm-recut", "grass_recut", 8_000n, PPM_RULE_SET], ["adv-ppm-debris", "debris_removal_cy", 5_000n, PPM_RULE_SET],
    ["adv-fcl-fee", "attorney_fee_TX_100", 230_000n, FCL_FEE_RULE_SET], ["adv-fcl-cost", "attorney_cost", null, F105_LIMITS_RULE_SET], ["adv-tech", "technology_fee", 2_500n, TECH_FEE_RULE_SET], ["adv-einv", "einvoice_fcl", 500n, TECH_FEE_RULE_SET]]);
  assert.equal(exhibitFor("TX", "non_judicial")!.cap_cents, 230_000n); assert.equal(CTX.attorney_fee_exhibit_cents, 230_000n);
  // the versioned schedule loads into `allowable_fee_schedules` (0035: PK rule_set, code, jurisdiction, track, variant) — the exhibit's variant rows (TX 50(a)(6), FL trial, NY co-op, WA judicial, CT foreclosure-by-sale, MN registered land) no longer collide
  assert.equal(new Set(ALLOWABLE_FEE_SCHEDULES.map(allowableRowKey)).size, ALLOWABLE_FEE_SCHEDULES.length, "every schedule row has a distinct table key");
  assert.equal(exhibitFor("TX", "judicial", "50(a)(6)")!.cap_cents, 380_000n); assert.equal(exhibitFor("FL", "judicial", "trial")!.cap_cents, 690_000n);
  // the rule-2 checks the spec enumerates fail when their inputs break the limit
  assert.deepEqual(validateLine({ ...L15[3]!, unit_cents: 4_500n }, CTX).messages, ["inspection_over_cap cap=3000"]);
  assert.deepEqual(validateLine({ kind: "hoa", unit_cents: 999_999n, quantity: 1, paid_on: D("2027-06-01"), invoice: true }, { ...CTX, hoa_declaration_max_cents: 30_000n, hoa_state_statutory_max_cents: 45_000n }).messages, ["hoa_over_lowest_of cap=30000"]);
  assert.deepEqual(validateLine({ ...L15[2]!, service_end: D("2027-12-15") }, CTX).messages, ["mi_premium_after_event_month through=2027-10-31"]);
  assert.deepEqual(validateLine({ ...L15[2]!, service_start: D("2026-11-01") }, CTX).messages, ["mi_premium_before_default default=2026-12-01"]);
  assert.deepEqual(validateLine({ kind: "code_violation", unit_cents: 100_000n, quantity: 4, paid_on: D("2027-06-01"), invoice: true }, CTX).messages, ["code_violation_life_cap life=300000"]);
  assert.deepEqual(validateLine({ ...L15[11]!, quantity: 3 }, CTX).messages, ["einvoice_over_cap cap=500 fcl", "einvoice_life_cap life=1000"]);
  assert.deepEqual(validateLine({ ...L15[11]!, einvoice_kind: "bk" }, { ...CTX, life_of_loan_used: { einvoice_fcl: 500n, einvoice_bk: 500n } }).messages, ["einvoice_over_cap cap=500 bk", "einvoice_life_cap life=1000"]);
  assert.deepEqual(validateLine({ ...L15[10]! }, { ...CTX, life_of_loan_used: { technology_fee: 2_500n } }).messages, ["technology_fee_over_cap cap=2500 life_of_default"]);
  assert.deepEqual(validateLine({ kind: "preservation", unit_cents: 999_999n, quantity: 1, paid_on: D("2027-08-01"), invoice: true }, CTX).messages, ["preservation_code_missing: itemize under a PPM code or attach the approved hometracker_bid_id"]);
  assert.deepEqual(validateLine({ ...L15[4]!, unit_cents: 9_000n }, CTX).messages, ["preservation_over_allowable cap=6000"]);
  assert.ok(validateLine({ ...L15[4]!, unit_cents: 9_000n, hometracker_bid_id: "HT-1" }, CTX).ok, "an approved HomeTracker bid lifts the PPM cap");
  assert.deepEqual(validateLine({ ...L15[4]!, service_date: D("2027-10-12"), paid_on: D("2027-10-20") }, CTX).messages, ["post_acquisition_nonreimbursable"]);
  assert.deepEqual(validateLine({ kind: "overhead", unit_cents: 1_000n, quantity: 1, paid_on: D("2027-10-06"), invoice: true }, CTX).messages, ["overhead_rejected"]);
  assert.equal(allowableFor("mortgage_release_doc_prep")!.cap_cents, 65_000n);
});
test("15.2-T2: Given an uninsured REO with the same lines, then `final_due_at` is null until `reo.disposed_by_fnma` and the internal policy claim is filed by Dec 4, 2027 (sale + 60).", async () => {
  const uninsured = assembleClaim(l15Input({ mi_insured: false }));
  assert.equal(uninsured.final_due_at, null); assert.equal(uninsured.policy_due_at, D("2027-12-04")); assert.equal(uninsured.internal_target_at, D("2027-10-25"));
  assert.equal(uninsured.status, "validated"); assert.equal(uninsured.gross, 1_124_994n);
  // reo.disposed_by_fnma on Jan 10, 2028 (REO reports / P360) → final_due_at = disposition + 60
  const disposed = assembleClaim(l15Input({ mi_insured: false, milestone_kind: "reo_disposition", milestone_date: D("2028-01-10"), disposition_date: D("2028-01-10") }));
  assert.equal(disposed.final_due_at, D("2028-03-10"));
  assert.equal(assembleClaim(l15Input({ mi_insured: false, disposition_date: D("2028-01-10") })).final_due_at, D("2028-03-10"));
  const m = milestoneReached({ event_type: "reo.disposed_by_fnma", loan_id: "L15", milestone_date: D("2028-01-10"), mi_insured: false })!;
  assert.equal(m.type, "claim.milestone.reached"); assert.equal(m.payload.kind, "reo_disposition");
  assert.equal(milestoneReached({ event_type: "lossmit.modification.effective", loan_id: "L15", milestone_date: D("2028-01-10"), mi_insured: false }), null, "never keyed on lossmit.modification.effective");
  // a Mortgage Release is "a property acquired through … a Fannie Mae Mortgage Release" (E-5-01): the same disposition anchor, null until then (30 days from the release when MI-insured, F-1-06)
  assert.equal(assembleClaim(l15Input({ mi_insured: false, milestone_kind: "mortgage_release" })).final_due_at, null); assert.equal(assembleClaim(l15Input({ milestone_kind: "mortgage_release" })).final_due_at, D("2027-11-04"));
  // on the bus (rule 3): the Oct 5 sale as the sweep records it arms no E501 (anchor unknown) — the disposition observed Jan 10, 2028 arms it at Mar 10; a short sale arms it at the close + 60
  const h = harness("2027-10-05T23:30:00.000Z");
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "candidates", milestones: [{ event_type: "foreclosure.sale.held", loan_id: "L15", milestone_date: "2027-10-05", mi_insured: false }] });
  assert.equal(h.engine.byCode("FNMA_E501_EXPENSE_FINAL_60").length, 0, "uninsured REO: the E-5-01 anchor is Fannie Mae's disposition — unknown at sale"); assert.equal(h.engine.byCode("FNMA_F106_MI_EXPENSE_FINAL_30").length, 0);
  assert.equal(h.engine.byCode("SM_EXPENSE_CLAIM_TARGET_20")[0]!.dueDate, D("2027-10-25"), "the internal target drives the policy filing by Dec 4");
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "candidates", milestones: [{ event_type: "reo.disposed_by_fnma", loan_id: "L15", milestone_date: "2028-01-10", mi_insured: false }] });
  assert.equal(h.engine.byCode("FNMA_E501_EXPENSE_FINAL_60")[0]!.dueDate, D("2028-03-10"));
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "candidates", milestones: [{ event_type: "shortsale.closed", loan_id: "L15", milestone_date: "2027-10-05", mi_insured: false }] });
  assert.equal(h.engine.byCode("FNMA_E501_EXPENSE_FINAL_60")[1]!.dueDate, D("2027-12-04"), "E-5-01: 'the completion of a workout option (including … short sale)' + 60");
});
test("15.2-T3: Given a TX attorney invoice of $2,500 without an excess-fee approval id, then the line fails validation (cap $2,300) and the agent requests the approval id from the firm before submission.", async () => {
  const line = { advance_id: "adv-fcl-fee", kind: "attorney_fee" as const, unit_cents: 250_000n, quantity: 1, paid_on: D("2027-10-06"), invoice: true };
  const v = validateLine(line, CTX);
  assert.equal(v.ok, false); assert.equal(v.cap_cents, 230_000n); assert.deepEqual(v.messages, ["attorney_fee_over_exhibit cap=230000"]); assert.equal(v.rule_set, FCL_FEE_RULE_SET);
  const req = excessFeeApprovalRequest(line, v, "TX")!;
  assert.equal(req.escalation.kind, "attorney"); assert.equal(req.before_submission, true); assert.equal(req.line_claimable, false); assert.match(req.escalation.reason, /approval id from the firm \(P360 Excess Fees and Costs\) before submission/);
  assert.ok(validateLine({ ...line, approval_id: "EFC-2027-0451" }, CTX).ok); assert.equal(excessFeeApprovalRequest({ ...line, approval_id: "EFC-2027-0451" }, validateLine({ ...line, approval_id: "EFC-2027-0451" }, CTX), "TX"), null);
  const claim = assembleClaim(l15Input({ lines: [...L15.slice(0, 8), line, ...L15.slice(9)] }));
  assert.equal(claim.status, "draft"); assert.deepEqual(claim.exceptions, ["adv-fcl-fee: attorney_fee_over_exhibit cap=230000"]); assert.equal(claim.escalations[0]!.kind, "attorney");
  assert.equal(buildBulkPackage(claim, "SM-L15-571-001", []).ok, false, "not submittable until the approval id arrives");
  // on the bus the assembly opens the `attorney` escalation (escalates_to) before any package exists
  const h = harness("2027-10-20T14:00:00.000Z");
  await h.run("assembleClaim", CLAIMS_REO, { ...claimInput, lines: [...L15.slice(0, 8), line, ...L15.slice(9)] });
  assert.deepEqual(h.rt.escalations.opened.map((e) => [e.kind, e.ownerRole]), [["attorney", "attorney"]]); assert.match(String(h.rt.escalations.opened[0]!.payload.reason), /exceeds the exhibit cap 230000/);
});
test("15.2-T4: Given hazard premium advanced Oct 25, 2027 (20 days after the sale), then the line is tagged `post_sale_nonreimbursable` and excluded.", async () => {
  const late = { advance_id: "adv-hazard-2", kind: "hazard" as const, unit_cents: 145_000n, quantity: 1, paid_on: D("2027-10-25"), invoice: true };
  assert.deepEqual(validateLine(late, CTX).messages, ["post_sale_nonreimbursable"]);
  assert.deepEqual(validateLine({ ...late, paid_on: D("2027-10-19") }, CTX).messages, [], "Oct 19 (day 14) still passes");
  // tagged and excluded (rule 4): the line leaves the claim — it is not a defect that holds the final claim in draft
  const claim = assembleClaim(l15Input({ lines: [...L15, late] }));
  assert.equal(claim.lines.find((l) => l.advance_id === "adv-hazard-2"), undefined, "not a claim line");
  assert.deepEqual(claim.excluded, [{ advance_id: "adv-hazard-2", reason: "post_sale_nonreimbursable", tag: "post_sale_nonreimbursable", amount: 145_000n, messages: ["post_sale_nonreimbursable"] }]);
  assert.equal(claim.status, "validated"); assert.deepEqual(claim.exceptions, []);
  assert.equal(claim.gross, 1_124_994n, "excluded from the gross"); assert.equal(claim.net, 1_059_049n);
  assert.equal(buildBulkPackage(claim, "SM-L15-571-001", []).ok, true, "the final claim stays submittable without the late advance"); assert.equal(buildBulkPackage(claim, "SM-L15-571-001", []).json.line_count, 12);
  assert.equal(claimTotals([validateLine(late, CTX)], []).blocked, 1);
  // the FNMA_F105_ESCROW_ADV_CUTOFF_14 gate evaluator decides the tag on {advance_kind, legal_date, paid_on}; the milestone fact's own `kind` cannot open it
  assert.equal(EVALUATORS_15_2["15.2.escrowAdvanceWithinCutoff"]!({ advance_kind: "hazard", legal_date: "2027-10-05", paid_on: "2027-10-25" }).open, false);
  assert.equal(EVALUATORS_15_2["15.2.escrowAdvanceWithinCutoff"]!({ advance_kind: "hazard", legal_date: "2027-10-05", paid_on: "2027-10-19" }).open, true);
  assert.equal(EVALUATORS_15_2["15.2.escrowAdvanceWithinCutoff"]!({ advance_kind: "taxes", legal_date: "2027-10-05", paid_on: "2027-12-25" }).open, true, "taxes are outside the insurance/HOA cut-off");
  assert.equal(EVALUATORS_15_2["15.2.escrowAdvanceWithinCutoff"]!({ kind: "foreclosure_sale", legal_date: "2027-10-05", paid_on: "2027-12-25" }).open, false, "the arming event's milestone kind does not short-circuit the gate");
  assert.deepEqual(escrowAdvanceCutoff(late, CTX), { open: false, reason: "post_sale_nonreimbursable: advance paid 2027-10-25 is 6 day(s) after the cut-off 2027-10-19 (legal date 2027-10-05 + 14; F-1-05)", legal_date: D("2027-10-05"), cutoff: D("2027-10-19") });
  // a TPS runs the cut-off from the later of completion and court confirmation (jurisdiction override): legal_date Oct 20 admits the Oct 25 advance
  assert.deepEqual(validateLine(late, { ...CTX, legal_date: D("2027-10-20") }).messages, []);
  // on the bus: the sweep's Oct 5 sale (kind foreclosure_sale) arms the gate on the legal date; the assembly tags the advance and excludes it, and the claim validates
  const h = harness("2027-10-26T14:00:00.000Z");
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "candidates", milestones: [{ event_type: "foreclosure.sale.held", loan_id: "L15", milestone_date: "2027-10-05", mi_insured: true }] });
  const gate = h.engine.byCode("FNMA_F105_ESCROW_ADV_CUTOFF_14")[0]!;
  assert.deepEqual([gate.status, gate.anchorDate, gate.dueDate, gate.note], ["armed", D("2027-10-05"), undefined, "evaluator:15.2.escrowAdvanceWithinCutoff"]);
  await h.run("assembleClaim", CLAIMS_REO, { ...claimInput, lines: [...L15, late] });
  const stored = h.rt.store.get("expense_claims", "SM-L15-571-001")!.data as { status: string; excluded: { advance_id: string; tag: string }[]; lines: unknown[] };
  assert.equal(stored.status, "validated"); assert.equal(stored.lines.length, 12); assert.deepEqual(stored.excluded.map((x) => [x.advance_id, x.tag]), [["adv-hazard-2", "post_sale_nonreimbursable"]]);
  const excluded = h.events.all().find((e) => e.type === "expense_claim.line.excluded")!; assert.deepEqual([excluded.payload.advance_id, excluded.payload.tag, excluded.payload.legal_date], ["adv-hazard-2", "post_sale_nonreimbursable", "2027-10-05"]);
  assert.equal(h.rt.store.get("advances", "adv-hazard-2")!.data.post_sale_nonreimbursable, true, "advances.post_sale_nonreimbursable carries the tag");
  const built = (await h.run("buildBulkPackage", CLAIMS_REO, { claim_id: "SM-L15-571-001", today: "2027-11-03", api_credentialed: true, api_status: 503 })).output as { package: { ok: boolean; json: { line_count: number } } };
  assert.equal(built.package.ok, true); assert.equal(built.package.json.line_count, 12); assert.equal(h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.status, "package_ready");
  // short-sale close and TPS completion arm the same gate on their legal dates
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "candidates", milestones: [{ event_type: "shortsale.closed", loan_id: "L15", milestone_date: "2027-10-05" }, { event_type: "tps.completed", loan_id: "L15", milestone_date: "2027-10-05", legal_date: "2027-10-20" }] });
  assert.deepEqual(h.engine.byCode("FNMA_F105_ESCROW_ADV_CUTOFF_14").map((t) => t.anchorDate), [D("2027-10-05"), D("2027-10-05"), D("2027-10-20")]);
});
test('15.2-T5: Given a judicial foreclosure invoiced at "judgment to court" (90%), then the fee line = 0.90 × exhibit amount and a later "sale held" invoice adds the remaining 10%, never prorated between milestones.', () => {
  // FL judicial exhibit $5,400 (Dec. 18, 2024): judgment to court = 90% → $4,860; sale held → the remaining 10% = $540
  const fl = claimContext152({ event_date: D("2027-10-05"), state: "FL", track: "judicial", servicing_option: "special" });
  assert.equal(fl.attorney_fee_exhibit_cents, 540_000n);
  const judgment = validateLine({ kind: "attorney_fee", unit_cents: 486_000n, quantity: 1, paid_on: D("2027-06-01"), invoice: true, milestone_pct: 90 }, fl);
  assert.ok(judgment.ok); assert.equal(judgment.cap_cents, 486_000n); assert.equal(judgment.allowable_code, "attorney_fee_FL_90");
  const fee = milestoneBilling(540_000n, "judicial", [{ milestone: "judgment_to_court", invoice_cents: 486_000n }, { milestone: "sale_held", invoice_cents: 54_000n }]);
  assert.deepEqual(fee.bills.map((b) => [b.milestone, b.cumulative_pct, b.earned_cents, b.fee_line_cents, b.over_cents]), [["judgment_to_court", 90, 486_000n, 486_000n, 0n], ["sale_held", 100, 54_000n, 54_000n, 0n]]);
  assert.equal(fee.total_fee_cents, 540_000n);
  // never prorated: an invoice above the milestone's share is capped; a non-milestone stage is refused; an earlier milestone billed after a later one earns nothing more
  assert.deepEqual(milestoneBilling(540_000n, "judicial", [{ milestone: "judgment_to_court", invoice_cents: 500_000n }]).bills.map((b) => [b.fee_line_cents, b.over_cents]), [[486_000n, 14_000n]]);
  assert.throws(() => milestoneBilling(540_000n, "judicial", [{ milestone: "halfway_to_judgment", invoice_cents: 1n }]), /not prorated between milestones/);
  const late = milestoneBilling(540_000n, "judicial", [{ milestone: "sale_held", invoice_cents: 540_000n }, { milestone: "judgment_to_court", invoice_cents: 486_000n }]);
  assert.deepEqual(late.bills.map((b) => [b.earned_cents, b.fee_line_cents, b.over_cents, b.out_of_order]), [[540_000n, 540_000n, 0n, false], [0n, 0n, 486_000n, true]]); assert.equal(late.total_fee_cents, 540_000n);
  assert.equal(validateLine({ kind: "attorney_fee", unit_cents: 500_000n, quantity: 1, paid_on: D("2027-06-01"), invoice: true, milestone_pct: 90 }, fl).ok, false);
});
test("15.2-T6: Given a claim enters PSA on Nov 10, 2027, then `SM_P360_PSA_INTERNAL_10` is due Nov 20 and `FNMA_P360_PSA_RESPONSE_60` on Jan 9, 2028; no response by Jan 9 → auto-denial recorded with sev-1.", async () => {
  assert.deepEqual(psaOutcome(D("2027-11-10"), null, D("2028-01-10")), { internal_due: D("2027-11-20"), response_due: D("2028-01-09"), status: "denied", severity: "sev1", auto_denied: true });
  assert.equal(psaOutcome(D("2027-11-10"), null, D("2027-11-25")).severity, "sev2"); assert.equal(psaOutcome(D("2027-11-10"), D("2027-11-18"), D("2027-11-25")).status, "submitted");
  // the weekly poll projects P360's PSA status into the claim and the events the registry rows are armed and satisfied by
  const h = harness("2027-11-10T15:00:00.000Z");
  h.rt.store.put("expense_claims", "SM-L15-571-001", { loan_id: "L15", status: "submitted", p360_status: "submitted", claim_number: "SM-L15-571-001" }, SYSTEM, h.clock.now());
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "status_poll", updates: [{ claim_id: "SM-L15-571-001", p360_status: "psa", at: "2027-11-10" }] });
  assert.deepEqual(h.types().filter((t) => t.startsWith("p360.")), ["p360.claim.status_refreshed", "p360.claim.status_changed"]);
  assert.equal(h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.status, "psa"); assert.equal(h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.psa_due_at, "2028-01-09");
  assert.equal(h.engine.byCode("SM_P360_PSA_INTERNAL_10")[0]!.dueDate, D("2027-11-20")); assert.equal(h.engine.byCode("FNMA_P360_PSA_RESPONSE_60")[0]!.dueDate, D("2028-01-09"));
  assert.equal(h.engine.byCode("SM_P360_PROCESSING_30").length, 0, "the PSA status change arms nothing else");
  // the operator's PSA response (attachment/comment, not a re-submission) satisfies both; the agent may not click for them
  await assert.rejects(h.run("buildBulkPackage", CLAIMS_REO, { claim_id: "SM-L15-571-001", op: "psa_response", responded_on: "2027-11-18" }), (e: unknown) => e instanceof CommandRefused && e.code === "PORTAL_ACTS_ARE_HUMAN");
  await assert.rejects(h.run("buildBulkPackage", OPERATOR, { claim_id: "SM-L15-571-001", op: "psa_response", responded_on: "2027-11-18", resubmit: true }), (e: unknown) => e instanceof CommandRefused && e.code === "PSA_IS_NOT_RESUBMISSION");
  await h.run("buildBulkPackage", OPERATOR, { claim_id: "SM-L15-571-001", op: "psa_response", responded_on: "2027-11-18", attachments: [{ name: "hazard-dec-page.pdf", line_index: 1, text: "policy declarations" }] });
  assert.deepEqual([h.engine.byCode("SM_P360_PSA_INTERNAL_10")[0]!.status, h.engine.byCode("FNMA_P360_PSA_RESPONSE_60")[0]!.status], ["satisfied", "satisfied"]);
  assert.equal(h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.status, "submitted");
  // Hold is grouped with Submitted: it refreshes the poll but moves nothing
  const hold = projectStatusUpdate({ status: "submitted", p360_status: "submitted" }, { claim_id: "c", p360_status: "hold", at: D("2027-11-12") });
  assert.equal(hold.changed, true); assert.equal(hold.patch.status, "submitted"); assert.equal(hold.events[1]!.payload.status, "submitted");
  // no response by Jan 9 → the engine breaches FNMA_P360_PSA_RESPONSE_60 with sev-1 and the weekly poll records the auto-denial on the claim
  const late = harness("2027-11-10T15:00:00.000Z");
  late.rt.store.put("expense_claims", "SM-L15-571-002", { loan_id: "L15", status: "submitted", p360_status: "submitted", claim_number: "SM-L15-571-002" }, SYSTEM, late.clock.now());
  await late.run("sweepClaimCandidates", CLAIMS_REO, { op: "status_poll", updates: [{ claim_id: "SM-L15-571-002", p360_status: "psa", at: "2027-11-10" }] });
  await late.run("sweepClaimCandidates", CLAIMS_REO, { op: "status_poll", today: "2027-11-25" });
  assert.equal(late.rt.store.get("expense_claims", "SM-L15-571-002")!.data.status, "psa"); assert.deepEqual(late.rt.escalations.opened.map((e) => e.kind), ["sev2"], "past the internal Nov 20 target: sev-2, still in PSA");
  assert.deepEqual(late.engine.evaluate("2028-01-09T12:00:00.000Z").map((b) => [b.instance.code, b.severity]), [["SM_P360_PSA_INTERNAL_10", 2]], "on Jan 9 itself only the internal target has breached");
  const breaches = late.engine.evaluate("2028-01-10T05:00:00.000Z");
  assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity]), [["FNMA_P360_PSA_RESPONSE_60", 1]]);
  assert.equal(late.events.all().find((e) => e.type === "timer.breached" && e.payload.code === "FNMA_P360_PSA_RESPONSE_60")!.payload.severity, 1);
  const polled = (await late.run("sweepClaimCandidates", CLAIMS_REO, { op: "status_poll", today: "2028-01-10" })).output as { auto_denials: { claim_id: string; status: string }[] };
  assert.deepEqual(polled.auto_denials, [{ claim_id: "SM-L15-571-002", status: "denied" }]);
  const denied = late.rt.store.get("expense_claims", "SM-L15-571-002")!.data; assert.deepEqual([denied.status, denied.p360_status, denied.auto_denied, denied.denial_reason], ["denied", "denied", true, "psa_no_response"]);
  const autoEvent = late.events.all().filter((e) => e.type === "p360.claim.status_changed").at(-1)!; assert.deepEqual([autoEvent.payload.status, autoEvent.payload.auto_denied, autoEvent.payload.psa_due_at], ["denied", true, "2028-01-09"]);
  const sev1 = late.rt.escalations.opened.find((e) => e.kind === "sev1")!; assert.equal(sev1.severity, "sev1"); assert.match(String(sev1.payload.reason), /auto-denied: PSA of 2027-11-10 unanswered by 2028-01-09/);
  assert.deepEqual(psaAutoDenialSweep([{ claim_id: "c", psa_at: D("2027-11-10") }], D("2028-01-09")).map((x) => [x.outcome.auto_denied, x.outcome.severity]), [[false, "sev2"]], "the countdown ends at day 60, not before");
  assert.deepEqual(psaAutoDenialSweep([{ claim_id: "c", psa_at: D("2027-11-10"), psa_responded_at: D("2027-11-18") }], D("2028-01-10")), [], "an answered PSA is not swept");
});
test('15.2-T7: Given a line denied "late claim" because P360 was unavailable on the deadline day, then an IRT inquiry with outage evidence is filed within 5 BD; a Fannie Mae response on Dec 1 makes our reply due Dec 8 (7 CD).', async () => {
  // denial observed Wed Nov 24, 2027 → 5 fannie_et BD (Nov 25 Thanksgiving skipped) → file by Thu Dec 2
  const t = triageDenial({ advance_id: "adv-tax-2026", loan_id: "L15", amount_cents: 482_000n, reason: "late_claim_fnma_outage", denied_on: D("2027-11-24") });
  assert.equal(t.action, "dispute_with_outage_evidence"); assert.equal(t.irt!.category, "Expense Denied"); assert.equal(t.irt!.file_by, D("2027-12-02")); assert.equal(irtInquiryDue(D("2027-11-24")), D("2027-12-02"));
  assert.deepEqual(t.irt!.evidence, ["p360_outage_screenshots", "single_entry_attempt_log", "submission_timestamps"]); assert.equal(t.write_off, null);
  assert.equal(irtReplyDue(D("2027-12-01")), D("2027-12-08"));
  // policy denials are write-offs: $500 or less is the agent's, above it the officer's
  assert.deepEqual(triageDenial({ advance_id: "a", loan_id: "L15", amount_cents: 50_000n, reason: "over_allowable", denied_on: D("2027-11-24") }).write_off, { amount_cents: 50_000n, authority: "agent", root_cause: "over_allowable" });
  assert.equal(triageDenial({ advance_id: "a", loan_id: "L15", amount_cents: 50_001n, reason: "late_claim", denied_on: D("2027-11-24") }).write_off!.authority, "officer");
  // on the bus: the poll's denied line opens the `irt.inquiry.create` task with the evidence and the 5-BD date; the analyst's response arms the 7-day reply clock; the operator's reply satisfies it
  const h = harness("2027-11-24T15:00:00.000Z");
  h.rt.store.put("expense_claims", "SM-L15-571-001", { loan_id: "L15", status: "submitted", p360_status: "submitted", claim_number: "SM-L15-571-001" }, SYSTEM, h.clock.now());
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "status_poll", updates: [{ claim_id: "SM-L15-571-001", p360_status: "denied", at: "2027-11-24", line_outcomes: [{ advance_id: "adv-tax-2026", status: "denied", amount_cents: 482_000n, reason: "late_claim_fnma_outage" }] }] });
  const task = h.rt.escalations.opened.find((e) => e.kind === "human_portal_task")!;
  assert.equal(task.payload.task, "irt.inquiry.create"); assert.equal(task.payload.file_by, "2027-12-02"); assert.deepEqual(task.payload.evidence, ["p360_outage_screenshots", "single_entry_attempt_log", "submission_timestamps"]);
  assert.equal(h.rt.store.get("irt_inquiries", "irt-SM-L15-571-001-adv-tax-2026")!.data.status, "draft");
  await h.run("buildBulkPackage", OPERATOR, { claim_id: "SM-L15-571-001", op: "irt_inquiry", inquiry_id: "irt-SM-L15-571-001-adv-tax-2026", filed_on: "2027-11-30", category: "Expense Denied" });
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "status_poll", irt_responses: [{ inquiry_id: "irt-SM-L15-571-001-adv-tax-2026", claim_id: "SM-L15-571-001", response_at: "2027-12-01" }] });
  assert.equal(h.engine.byCode("FNMA_IRT_RESPONSE_7")[0]!.dueDate, D("2027-12-08")); assert.equal(h.rt.store.get("irt_inquiries", "irt-SM-L15-571-001-adv-tax-2026")!.data.response_due_at, "2027-12-08");
  await h.run("buildBulkPackage", OPERATOR, { claim_id: "SM-L15-571-001", op: "irt_response", inquiry_id: "irt-SM-L15-571-001-adv-tax-2026", responded_on: "2027-12-06" });
  assert.equal(h.engine.byCode("FNMA_IRT_RESPONSE_7")[0]!.status, "satisfied");
  assert.deepEqual(h.types().filter((x) => x.startsWith("irt.") || x.startsWith("p360.inquiry")), ["irt.inquiry.filed", "p360.inquiry.response_received", "irt.inquiry.responded"]);
  // the $5,000 officer briefing is cumulative per loan across polls: $3,000 denied in November and $3,000 more in December brief the officer once, on the crossing
  assert.equal(h.rt.escalations.opened.filter((e) => e.kind === "officer").length, 0, "$4,820 denied so far — under the threshold");
  const den = (loan: string, amount: bigint, reason: string) => ({ loan_id: loan, amount_cents: amount, reason });
  assert.equal(denialBriefing([den("L15", 300_000n, "late_claim")]).officer_briefing, false);
  assert.deepEqual(denialBriefing([den("L15", 300_000n, "late_claim"), den("L15", 300_000n, "over_allowable")], [den("L15", 300_000n, "late_claim")]).newly_over_threshold, ["L15"]);
  assert.equal(denialBriefing([den("L15", 300_000n, "late_claim"), den("L15", 300_000n, "over_allowable")], [den("L15", 300_000n, "late_claim"), den("L15", 300_000n, "over_allowable")]).officer_briefing, false, "already briefed — not again on the next poll");
  assert.equal(denialBriefing([den("L1", 100n, "wrong_subtype"), den("L2", 100n, "wrong_subtype"), den("L3", 100n, "wrong_subtype")]).systematic_reason, "wrong_subtype");
  const cum = harness("2027-11-24T15:00:00.000Z");
  cum.rt.store.put("expense_claims", "SM-L15-571-003", { loan_id: "L15", status: "submitted", p360_status: "submitted", claim_number: "SM-L15-571-003" }, SYSTEM, cum.clock.now());
  cum.rt.store.put("expense_claims", "SM-L15-571-004", { loan_id: "L15", status: "submitted", p360_status: "submitted", claim_number: "SM-L15-571-004" }, SYSTEM, cum.clock.now());
  await cum.run("sweepClaimCandidates", CLAIMS_REO, { op: "status_poll", updates: [{ claim_id: "SM-L15-571-003", p360_status: "curtailed", at: "2027-11-24", line_outcomes: [{ advance_id: "a1", status: "curtailed", amount_cents: 300_000n, reason: "over_allowable" }] }] });
  assert.deepEqual(cum.rt.escalations.opened.map((e) => [e.kind, String(e.payload.reason).slice(0, 9)]), [["officer", "write-off"]], "$3,000 on the loan: the policy write-off above $500 is the officer's, but no $5,000 briefing yet");
  await cum.run("sweepClaimCandidates", CLAIMS_REO, { op: "status_poll", updates: [{ claim_id: "SM-L15-571-004", p360_status: "denied", at: "2027-12-15", line_outcomes: [{ advance_id: "a2", status: "denied", amount_cents: 300_000n, reason: "late_claim" }] }] });
  const briefing = cum.rt.escalations.opened.filter((e) => e.kind === "officer" && String(e.payload.reason).startsWith("denials > $5,000"));
  assert.equal(briefing.length, 1); assert.deepEqual([briefing[0]!.payload.newly_over_threshold, briefing[0]!.payload.denied_lines], [["L15"], 2]); assert.equal((briefing[0]!.payload.per_loan as Record<string, bigint>).L15, 600_000n);
  assert.equal(cum.rt.store.get("expense_claim_denials", "L15")!.data.lines instanceof Array && (cum.rt.store.get("expense_claim_denials", "L15")!.data.lines as unknown[]).length, 2, "the loan's denial history accumulates");
});
test("15.2-T8: Given Paid on Fri Nov 19, 2027, then ACH is expected by Wed Nov 24 and unmatched by Mon Nov 29 → escalation package to `FannieMae_REO_Disbursements@fanniemae.com`.", async () => {
  assert.deepEqual(achExpected(D("2027-11-19")), { expected: D("2027-11-24"), escalate_after: D("2027-11-29") });
  assert.deepEqual(achMatchOutcome(D("2027-11-19"), null, D("2027-11-30")), { expected: D("2027-11-24"), escalate_after: D("2027-11-29"), status: "unmatched", escalation: { severity: "sev2", package_to: FNMA_REO_DISBURSEMENTS_MAILBOX } });
  assert.equal(achMatchOutcome(D("2027-11-19"), null, D("2027-11-29")).status, "awaiting_ach"); assert.equal(achMatchOutcome(D("2027-11-19"), D("2027-11-24"), D("2027-11-30")).status, "paid");
  const paid = { claim_id: "SM-L15-571-001", loan_id: "L15", paid_at: D("2027-11-19"), paid_amount_cents: 1_059_049n };
  const un = reconcileReport({ paid_claims: [paid], bank_credits: [], remittances: [], today: D("2027-11-30") });
  assert.deepEqual(un.unmatched, [{ claim_id: "SM-L15-571-001", expected: D("2027-11-24"), escalate_after: D("2027-11-29"), status: "unmatched", package: { to: FNMA_REO_DISBURSEMENTS_MAILBOX, contents: ["P360 File Details (check #/date/amount)", "bank statement for the ACH window", "claim number and servicer number"] } }]);
  const ok = reconcileReport({ paid_claims: [paid], bank_credits: [{ entry_id: "bank-771", amount_cents: 1_059_049n, posted_on: D("2027-11-24"), originator: "FANNIE MAE REO DISB" }], remittances: [], today: D("2027-11-30") });
  assert.deepEqual(ok.matched, [{ claim_id: "SM-L15-571-001", entry_id: "bank-771", matched_on: D("2027-11-24") }]); assert.equal(ok.events[0]!.type, "p360.payment.ach_matched");
  // on the bus: Paid arms SM_P360_ACH_MATCH_3BD (Nov 24); the reconciliation opens the sev-2 package while unmatched, and the matched credit satisfies the timer
  const h = harness("2027-11-19T20:00:00.000Z");
  h.rt.store.put("expense_claims", "SM-L15-571-001", { loan_id: "L15", status: "approved", p360_status: "approved", claim_number: "SM-L15-571-001" }, SYSTEM, h.clock.now());
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "status_poll", updates: [{ claim_id: "SM-L15-571-001", p360_status: "paid", at: "2027-11-19", paid_amount_cents: 1_059_049n, check_number: "ACH" }] });
  assert.equal(h.engine.byCode("SM_P360_ACH_MATCH_3BD")[0]!.dueDate, D("2027-11-24")); assert.equal(h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.ach_expected_by, "2027-11-24");
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "reconcile", today: "2027-11-30", bank_credits: [] });
  const esc = h.rt.escalations.opened.find((e) => e.kind === "sev2")!; assert.equal(esc.payload.package_to, FNMA_REO_DISBURSEMENTS_MAILBOX); assert.match(String(esc.payload.reason), /not matched by 2027-11-29/);
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "reconcile", today: "2027-12-01", bank_credits: [{ entry_id: "bank-771", amount_cents: 1_059_049n, posted_on: "2027-11-30", originator: "FANNIE MAE" }] });
  assert.equal(h.engine.byCode("SM_P360_ACH_MATCH_3BD")[0]!.status, "satisfied"); assert.equal(h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.ach_matched_entry_id, "bank-771");
});
test("15.2-T9: Given Fannie Mae reimbursed $3,000 of advances and the borrower later reinstates on Jan 15, 2028 paying $3,000 of them, then CRS 353 for $3,000 is due by Mar 15, 2028.", async () => {
  const rp = recoveryRepaymentBatch({ completion_on: D("2028-01-15"), source: "borrower_reinstatement", collected_cents: 300_000n, reimbursed: [{ advance_id: "a2", reimbursed_cents: 200_000n, reimbursed_on: D("2027-12-01") }, { advance_id: "a1", reimbursed_cents: 200_000n, reimbursed_on: D("2027-11-20") }] });
  assert.equal(rp.crs_code, "353"); assert.equal(rp.fnma_repay_due_at, D("2028-03-15")); assert.equal(rp.total_cents, 300_000n);
  assert.deepEqual(rp.recoveries, [{ advance_id: "a1", amount_cents: 200_000n }, { advance_id: "a2", amount_cents: 100_000n }], "the collected portion of each reimbursed advance, FIFO by advance");
  assert.equal(recoveryRepaymentBatch({ completion_on: D("2028-01-15"), source: "payoff", collected_cents: 1n, reimbursed: [] }).crs_code, "352");
  assert.deepEqual(reimbursedAdvancesFromClaims([{ paid_at: D("2027-11-20"), lines: [{ advance_id: "a1", amount: 200_000n }] }, { paid_at: null, lines: [{ advance_id: "x", amount: 1n }] }]), [{ advance_id: "a1", reimbursed_cents: 200_000n, reimbursed_on: D("2027-11-20") }]);
  // on the bus (`scheduleRepayment`, rule 8): the reinstatement collection against the advances the Paid claims reimbursed books advance_recoveries FIFO and emits the fact that arms
  // FNMA_F105_RECOVERABLE_REPAY_60 (Mar 15, 2028); the settled 353 (reconciliation report / CRS) satisfies it and stamps fnma_repaid_at
  const h = harness("2028-01-15T15:00:00.000Z");
  h.rt.store.put("expense_claims", "SM-L15-571-A", { loan_id: "L15", status: "paid", paid_at: "2027-11-20", lines: [{ advance_id: "a1", amount: 200_000n }] }, SYSTEM, h.clock.now());
  h.rt.store.put("expense_claims", "SM-L15-571-B", { loan_id: "L15", status: "paid", paid_at: "2027-12-01", lines: [{ advance_id: "a2", amount: 200_000n }] }, SYSTEM, h.clock.now());
  const booked = (await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "recoveries", loan_id: "L15", completion_on: "2028-01-15", source: "borrower_reinstatement", collected_cents: 300_000n })).output as { crs_code: string; total_cents: bigint; fnma_repay_due_at: string; scheduled: boolean };
  assert.deepEqual([booked.crs_code, booked.total_cents, booked.fnma_repay_due_at, booked.scheduled], ["353", 300_000n, "2028-03-15", true]);
  const scheduled = h.events.all().find((e) => e.type === "advance_recovery.repayment_scheduled")!;
  assert.deepEqual([scheduled.payload.fnma_reimbursed_advances, scheduled.payload.completion_date, scheduled.payload.crs_code, scheduled.payload.total_cents], [true, "2028-01-15", "353", 300_000n]);
  assert.deepEqual(h.rt.store.list("advance_recoveries").map((r) => [r.data.advance_id, r.data.amount_cents, r.data.source, r.data.fnma_repay_due_at, r.data.crs_code, r.data.fnma_repaid_at]), [["a1", 200_000n, "borrower_reinstatement", "2028-03-15", "353", null], ["a2", 100_000n, "borrower_reinstatement", "2028-03-15", "353", null]]);
  assert.equal(h.engine.byCode("FNMA_F105_RECOVERABLE_REPAY_60")[0]!.dueDate, D("2028-03-15")); assert.equal(h.engine.byCode("FNMA_F105_RECOVERABLE_REPAY_60")[0]!.anchorDate, D("2028-01-15"));
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "reconcile", today: "2028-03-12", remittances: [{ code: "353", amount_cents: 300_000n, settled_on: "2028-03-10", loan_id: "L15" }] });
  assert.equal(h.engine.byCode("FNMA_F105_RECOVERABLE_REPAY_60")[0]!.status, "satisfied"); assert.equal(h.events.all().find((e) => e.type === "remittance.special.settled")!.payload.code, "353");
  assert.deepEqual(h.rt.store.list("advance_recoveries").map((r) => r.data.fnma_repaid_at), ["2028-03-10", "2028-03-10"]);
  // nothing reimbursed → nothing scheduled, no timer
  const none = harness("2028-01-15T15:00:00.000Z");
  assert.equal(((await none.run("sweepClaimCandidates", CLAIMS_REO, { op: "recoveries", loan_id: "L15", completion_on: "2028-01-15", collected_cents: 300_000n })).output as { scheduled: boolean }).scheduled, false); assert.equal(none.engine.byCode("FNMA_F105_RECOVERABLE_REPAY_60").length, 0);
});
test("15.2-T10: Given an MI premium refund of $249.08 arrives Dec 3, 2027 after the claim was paid, then a 336 remittance is due by Jan 2, 2028.", async () => {
  assert.deepEqual(postPaymentCredit({ kind: "mi_refund", amount_cents: 24_908n, received_at: D("2027-12-03"), claim_paid: true }), { treatment: "remit", remit_code: "336", due: D("2028-01-02"), amount_cents: 24_908n });
  assert.deepEqual(postPaymentCredit({ kind: "hazard_refund", amount_cents: 65_945n, received_at: D("2027-12-03"), claim_paid: true }).remit_code, "318");
  assert.deepEqual(postPaymentCredit({ kind: "mi_refund", amount_cents: 24_908n, received_at: D("2027-11-02"), claim_paid: false }), { treatment: "claim_credit", remit_code: null, due: null, amount_cents: 24_908n });
  // the fact 15.2 emits from 10.5's refund against the stored claim: only a Paid claim that carried the MI premium line makes the refund a 336 remittance
  const paidClaim = { paid_at: D("2027-11-20"), status: "paid", lines: [{ code: "mi_premium" }, { code: "taxes" }] };
  assert.deepEqual(creditReceivedEvent("L15", "c", { kind: "mi_refund", amount_cents: 24_908n, received_at: D("2027-12-03") }, paidClaim).payload, { loan_id: "L15", claim_id: "c", kind: "mi_refund", amount_cents: 24_908n, received_at: D("2027-12-03"), treatment: "remit", remit_code: "336", remit_due: D("2028-01-02"), fnma_reimbursed_premium: true, claim_paid: true });
  assert.equal(creditReceivedEvent("L15", "c", { kind: "mi_refund", amount_cents: 24_908n, received_at: D("2027-12-03") }, { ...paidClaim, lines: [{ code: "taxes" }] }).payload.fnma_reimbursed_premium, false, "no MI premium reimbursed on that claim");
  assert.equal(creditReceivedEvent("L15", "c", { kind: "mi_refund", amount_cents: 24_908n, received_at: D("2027-11-02") }, { status: "submitted", lines: paidClaim.lines }).payload.treatment, "claim_credit");
  // on the bus: sweepClaimCandidates op=credit on the Paid claim arms FNMA_F105_MI_REFUND_336_30 (Jan 2, 2028) from `received_at`; the settled 336 satisfies it
  const h = harness("2027-12-03T15:00:00.000Z");
  h.rt.store.put("expense_claims", "SM-L15-571-001", { loan_id: "L15", status: "paid", p360_status: "paid", paid_at: "2027-11-20", claim_number: "SM-L15-571-001", lines: [{ advance_id: "adv-mi", code: "mi_premium", amount: 136_994n }] }, SYSTEM, h.clock.now());
  const credited = (await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "credit", claim_id: "SM-L15-571-001", kind: "mi_refund", amount_cents: 24_908n, received_at: "2027-12-03" })).output as { treatment: string; remit_code: string; due: string; fnma_reimbursed_premium: boolean };
  assert.deepEqual([credited.treatment, credited.remit_code, credited.due, credited.fnma_reimbursed_premium], ["remit", "336", "2028-01-02", true]);
  assert.equal(h.events.all().find((e) => e.type === "expense_claim.credit.received")!.payload.remit_code, "336");
  assert.deepEqual(h.rt.store.list("claim_credits").map((r) => [r.data.kind, r.data.amount_cents, r.data.remit_code_if_post_claim, r.data.remit_due, r.data.remitted_at]), [["mi_refund", 24_908n, "336", "2028-01-02", null]]);
  assert.equal(h.engine.byCode("FNMA_F105_MI_REFUND_336_30")[0]!.dueDate, D("2028-01-02")); assert.equal(h.engine.byCode("FNMA_F105_MI_REFUND_336_30")[0]!.anchorDate, D("2027-12-03"));
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "reconcile", today: "2027-12-20", remittances: [{ code: "336", amount_cents: 24_908n, settled_on: "2027-12-18", loan_id: "L15" }] });
  assert.equal(h.engine.byCode("FNMA_F105_MI_REFUND_336_30")[0]!.status, "satisfied");
  // a refund received before the final claim is paid is a claim_credits netting (rule 7) — no remittance clock
  h.rt.store.put("expense_claims", "SM-L15-571-005", { loan_id: "L15", status: "submitted", claim_number: "SM-L15-571-005", lines: [{ advance_id: "adv-mi", code: "mi_premium", amount: 136_994n }], credits: [] }, SYSTEM, h.clock.now());
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "credit", claim_id: "SM-L15-571-005", kind: "mi_refund", amount_cents: 24_908n, received_at: "2027-11-02" });
  assert.equal(h.engine.byCode("FNMA_F105_MI_REFUND_336_30").length, 1); assert.deepEqual(h.rt.store.get("expense_claims", "SM-L15-571-005")!.data.credits, [{ kind: "mi_refund", amount_cents: 24_908n, received_at: "2027-11-02" }]);
});
test("15.2-T11: Given the API returns 5xx on Nov 3, then the bulk package is generated and a portal task is opened the same day with the deadline shown.", async () => {
  const claim = l15Claim();
  assert.equal(claim.status, "validated"); assert.equal(claim.final_due_at, D("2027-11-04"));
  const pkg = buildBulkPackage(claim, "SM-L15-571-001", [{ name: "tax-bill-2026.pdf", line_index: 0, text: "Harris County 2026 tax bill parcel 0123" }, { name: "fcl-invoice-100.pdf", line_index: 8, text: "sale held milestone 100% TX exhibit" }]);
  assert.equal(pkg.ok, true); assert.deepEqual(pkg.manifest, ["SM-L15-571-001.xlsx", "SM-L15-571-001.json", "tax-bill-2026.pdf", "fcl-invoice-100.pdf"]); assert.equal(pkg.json.line_count, 12);
  assert.equal(pkg.xlsx_rows[0]!.attachment_names, "tax-bill-2026.pdf"); assert.equal(pkg.xlsx_rows[8]!.amount_cents, 230_000n); assert.equal(pkg.xlsx_rows[8]!.nonrecoverable_indicator, "blank");
  // Nov 3: the Expense Claims API answers 503 → bulk ZIP generated, `p360.claims.bulk_upload` task for fnma_portal_operator opened Nov 3 showing the Nov 4 deadline.
  const fb = submissionChannel({ api_credentialed: true, api_status: 503, today: D("2027-11-03"), final_due_at: claim.final_due_at, line_count: claim.lines.length });
  assert.equal(fb.channel, "bulk_upload"); assert.equal(fb.package_generated, true);
  assert.deepEqual(fb.portal_task, { kind: "human_portal_task", task: "p360.claims.bulk_upload", owner: "fnma_portal_operator", opened_on: D("2027-11-03"), deadline_shown: D("2027-11-04") });
  assert.equal(fb.fallback_by, D("2027-10-30")); assert.match(fb.reason, /503 on 2027-11-03/); assert.equal(fb.irt_late_filing_dispute, false);
  // A 2xx keeps the API channel and opens no task.
  const ok = submissionChannel({ api_credentialed: true, api_status: 200, today: D("2027-11-03"), final_due_at: claim.final_due_at, line_count: 12 });
  assert.equal(ok.channel, "api"); assert.equal(ok.package_generated, false); assert.equal(ok.portal_task, null);
  // P360 down on the deadline day itself: single-entry attempt with screenshots and the IRT late-filing dispute.
  const down = submissionChannel({ api_credentialed: true, api_status: 503, bulk_available: false, today: D("2027-11-04"), final_due_at: claim.final_due_at, line_count: 12 });
  assert.equal(down.channel, "single_entry"); assert.equal(down.portal_task!.task, "p360.claims.single_entry"); assert.equal(down.screenshots_required, true); assert.equal(down.irt_late_filing_dispute, true);
  // on the bus (Nov 3): assemble → build with the API 503 → package_ready satisfies SM_EXPENSE_CLAIM_TARGET_20, the same-day task shows Nov 4; the operator's upload record emits `p360.claim.submitted{kind=final}` which satisfies F106
  const h = harness("2027-11-03T14:00:00.000Z");
  // the milestone fact as the Oct 5 sweep records it: `foreclosure.sale.held` → kind foreclosure_sale (MI-insured) arms F106 on `milestone_date` (Nov 4), the internal target (Oct 25) and the escrow cut-off gate — never E501, whose REO anchor is the disposition (rule 3)
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "candidates", milestones: [{ event_type: "foreclosure.sale.held", loan_id: "L15", milestone_date: "2027-10-05", mi_insured: true }] });
  assert.equal(h.events.all().find((e) => e.type === "claim.milestone.reached")!.payload.kind, "foreclosure_sale");
  assert.equal(h.engine.byCode("SM_EXPENSE_CLAIM_TARGET_20")[0]!.dueDate, D("2027-10-25")); assert.equal(h.engine.byCode("FNMA_F106_MI_EXPENSE_FINAL_30")[0]!.dueDate, D("2027-11-04")); assert.equal(h.engine.byCode("FNMA_E501_EXPENSE_FINAL_60").length, 0);
  assert.equal(h.engine.byCode("FNMA_F105_ESCROW_ADV_CUTOFF_14").length, 1);
  await h.run("assembleClaim", CLAIMS_REO, claimInput);
  assert.equal(h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.status, "validated"); assert.deepEqual(h.decisions.map((d) => d.action), ["sweepClaimCandidates:candidates", "assembleClaim"]);
  const built = await h.run("buildBulkPackage", CLAIMS_REO, { claim_id: "SM-L15-571-001", today: "2027-11-03", api_credentialed: true, api_status: 503, attachments: [{ name: "tax-bill-2026.pdf", line_index: 0, text: "Harris County 2026 tax bill" }] });
  const out = built.output as { channel: { channel: string }; portal_task_id: string };
  assert.equal(out.channel.channel, "bulk_upload"); assert.equal(h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.status, "package_ready");
  const task = h.rt.escalations.opened.find((e) => e.id === out.portal_task_id)!;
  assert.deepEqual([task.kind, task.ownerRole, task.payload.task, task.payload.deadline, task.payload.opened_on], ["human_portal_task", "fnma_portal_operator", "p360.claims.bulk_upload", "2027-11-04", "2027-11-03"]);
  const target = h.engine.byCode("SM_EXPENSE_CLAIM_TARGET_20")[0]!; assert.equal(target.status, "satisfied"); assert.ok(target.satisfiedAt!.slice(0, 10) > target.dueDate!, "package_ready on Nov 3 closes the Oct 25 internal target (late: sev-3 breach on the next tick)");
  await assert.rejects(h.run("buildBulkPackage", CLAIMS_REO, { claim_id: "SM-L15-571-001", op: "record_upload", p360_claim_id: "P360-8841" }), (e: unknown) => e instanceof CommandRefused && e.code === "PORTAL_ACTS_ARE_HUMAN");
  await h.run("buildBulkPackage", OPERATOR, { claim_id: "SM-L15-571-001", op: "record_upload", p360_claim_id: "P360-8841", submitted_on: "2027-11-03" });
  const submitted = h.events.all().find((e) => e.type === "p360.claim.submitted")!;
  assert.deepEqual([submitted.payload.kind, submitted.payload.interim, submitted.payload.milestone_kind, submitted.payload.channel], ["final", false, "foreclosure_sale", "bulk_upload"]);
  assert.deepEqual([h.engine.byCode("FNMA_F106_MI_EXPENSE_FINAL_30")[0]!.status, h.engine.byCode("SM_P360_PROCESSING_30")[0]!.dueDate], ["satisfied", D("2027-12-03")]);
  assert.equal(h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.submitted_at, "2027-11-03"); assert.equal(h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.age_reset_count, 0);
  // rule 6 as a guardrail on the claim's own event history: a re-build (or upload record) after submission dated past final_due_at is refused before anything runs, whatever the caller passes; before it, the age resets and counts
  await assert.rejects(h.run("buildBulkPackage", CLAIMS_REO, { claim_id: "SM-L15-571-001", today: "2027-11-05", api_credentialed: true, api_status: 503 }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_RESUBMIT_PAST_FINAL_DUE");
  await assert.rejects(h.run("buildBulkPackage", OPERATOR, { claim_id: "SM-L15-571-001", op: "record_upload", p360_claim_id: "P360-8841", submitted_on: "2027-11-05" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_RESUBMIT_PAST_FINAL_DUE");
  assert.equal(h.events.all().filter((e) => e.type === "command.refused" && e.payload.code === "NO_RESUBMIT_PAST_FINAL_DUE").length, 2); assert.equal(h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.status, "submitted", "the refusal wrote nothing");
  assert.equal(h.types().filter((t) => t === "expense_claim.resubmission.refused").length, 0, "the guardrail refused before the handler's own rule-6 check ran");
  await h.run("assembleClaim", CLAIMS_REO, claimInput);   // the unavoidable edit re-validates the claim; submitted_at is kept
  await h.run("buildBulkPackage", CLAIMS_REO, { claim_id: "SM-L15-571-001", today: "2027-11-04", api_credentialed: true, api_status: 503 });
  const rebuilt = h.rt.store.get("expense_claims", "SM-L15-571-001")!.data; assert.deepEqual([rebuilt.status, rebuilt.age_reset_count, rebuilt.submitted_at], ["package_ready", 1, "2027-11-03"]);
  await h.run("buildBulkPackage", OPERATOR, { claim_id: "SM-L15-571-001", op: "record_upload", p360_claim_id: "P360-8841", submitted_on: "2027-11-04" });
  assert.deepEqual([h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.age_reset_count, h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.submitted_at], [1, "2027-11-04"], "the deadlines re-evaluate against the new submission date; the reset counted once");
  assert.deepEqual(resubmissionCheck({ submitted_at: "2027-11-03", final_due_at: D("2027-11-04"), age_reset_count: 0 }, D("2027-11-05")).allowed, false);
  // the API path: a credentialed, wired Expense Claims API accepts the payload (idempotent by claim_number) and the tool emits the submission itself
  const api = harness("2027-11-03T14:00:00.000Z", { p360: new FakeFnmaP360() });
  await api.run("assembleClaim", CLAIMS_REO, claimInput);
  const viaApi = (await api.run("buildBulkPackage", CLAIMS_REO, { claim_id: "SM-L15-571-001", today: "2027-11-03", api_credentialed: true, fnma_loan_number: "1234567890" })).output as { channel: { channel: string }; portal_task_id: string | null };
  assert.equal(viaApi.channel.channel, "api"); assert.equal(viaApi.portal_task_id, null);
  assert.equal(api.events.all().find((e) => e.type === "p360.claim.submitted")!.payload.channel, "api"); assert.equal(api.rt.store.get("expense_claims", "SM-L15-571-001")!.data.submission_channel, "api");
  // only the decision assembleClaim recorded reaches the API: a caller-supplied claim (a line with no paid invoice) is refused, and an unassembled claim id has nothing to package
  const bogus = { status: "validated", loan_id: "L15", claim_type: "571", milestone: "foreclosure_sale", interim: false, final_due_at: "2027-11-04", exceptions: [], lines: [{ advance_id: "no-invoice", code: "taxes", amount: 999_999n, validation: "pass", indicator: "blank", messages: [] }] };
  await assert.rejects(api.run("buildBulkPackage", CLAIMS_REO, { claim_id: "BOGUS-1", claim: bogus, today: "2027-11-03", api_credentialed: true }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_UNASSEMBLED_CLAIM");
  await assert.rejects(api.run("buildBulkPackage", CLAIMS_REO, { claim_id: "BOGUS-1", today: "2027-11-03", api_credentialed: true }), /expense claim BOGUS-1 not found/);
  assert.equal(api.events.all().filter((e) => e.type === "p360.claim.submitted").length, 1); assert.equal(api.rt.store.get("expense_claims", "BOGUS-1"), undefined);
});
test("15.2-T12: Given a payment-deferral completed Sep 30, 2027 with $240 of title/recording costs, then a claim with those lines is due by Nov 29, 2027 and the capitalized-advance rule (post-Oct-2023) is applied.", async () => {
  const lines = [{ label: "title", unit_cents: 15_000n, quantity: 1 }, { label: "recording", unit_cents: 9_000n, quantity: 1 }];
  const pd = deferralExpenseClaim({ completed_on: D("2027-09-30"), closed_on: D("2027-09-30"), lines, incentive_cents: 120_000n });
  assert.equal(pd.due_at, D("2027-11-29")); assert.equal(pd.total_cents, 24_000n); assert.equal(pd.capitalized_advance_rule, "claim_required_no_auto_generation"); assert.equal(pd.claim_type, "fnma_mod");
  // the rule applied: closed on/after Oct 1, 2023 → the $240 of capitalized advances are our lines to claim (no auto-generation); the incentive stays P360AutoGenerated, capped at $1,000, never duplicated on our claim
  assert.deepEqual(pd.lines.map((l) => [l.label, l.amount_cents]), [["title", 15_000n], ["recording", 9_000n]]); assert.deepEqual(pd.auto_generated_lines, []); assert.equal(pd.lines_claimed_by_us, true);
  assert.deepEqual(pd.incentive, { p360_line: "P360AutoGenerated", on_claim: false, cap_cents: WORKOUT_INCENTIVE_CAP_CENTS, paid_cents: 120_000n, expected_cents: 100_000n });
  // the "General Services – Post Payoff PD Reimbursement" subtype is reserved for post-payoff deferral reimbursements: an active loan's lines keep their own types
  assert.equal(pd.p360_subtype, null);
  assert.equal(deferralExpenseClaim({ completed_on: D("2027-09-30"), closed_on: D("2027-09-30"), lines, post_payoff: true }).p360_subtype, POST_PAYOFF_PD_SUBTYPE);
  const pre = deferralExpenseClaim({ completed_on: D("2023-09-15"), closed_on: D("2023-09-15"), lines });
  assert.equal(pre.capitalized_advance_rule, "auto_generated"); assert.deepEqual(pre.lines, []); assert.equal(pre.auto_generated_lines.length, 2); assert.equal(pre.total_cents, 0n);
  assert.equal(deferralRule({ completed_on: D("2027-09-30"), closed_on: D("2023-10-01") }).capitalized_advance_rule, "claim_required_no_auto_generation");
  // the deferral milestone: final_due_at Nov 29, indicator `not_yet_recovered` (rule 1: a workout claim, not a liquidation); the assembly carries the rule and stamps the subtype only after a payoff
  const ctx12 = claimContext152({ event_date: D("2027-09-30"), state: "TX", track: "non_judicial", servicing_option: "special" });
  const dLines: AssembleInput["lines"] = [{ advance_id: "adv-title", kind: "attorney_cost", unit_cents: 15_000n, quantity: 1, paid_on: D("2027-09-20"), invoice: true }, { advance_id: "adv-rec", kind: "attorney_cost", unit_cents: 9_000n, quantity: 1, paid_on: D("2027-09-28"), invoice: true }];
  const claim = assembleClaim({ loan_id: "L12", claim_type: "fnma_mod", milestone_kind: "deferral_completed", milestone_date: D("2027-09-30"), mi_insured: false, disposition_date: null, context: ctx12, credits: [], lines: dLines, deferral: { closed_on: D("2027-09-30"), incentive_cents: 120_000n } });
  assert.equal(claim.final_due_at, D("2027-11-29")); assert.equal(claim.gross, 24_000n); assert.deepEqual(claim.lines.map((l) => [l.indicator, l.p360_subtype]), [["not_yet_recovered", null], ["not_yet_recovered", null]]);
  assert.deepEqual([claim.deferral!.capitalized_advance_rule, claim.deferral!.incentive.expected_cents, claim.deferral!.p360_subtype], ["claim_required_no_auto_generation", 100_000n, null]);
  assert.deepEqual(assembleClaim({ loan_id: "L12", claim_type: "fnma_mod", milestone_kind: "deferral_completed", milestone_date: D("2027-09-30"), mi_insured: false, disposition_date: null, context: ctx12, credits: [], lines: dLines, deferral: { post_payoff: true } }).lines.map((l) => l.p360_subtype), [POST_PAYOFF_PD_SUBTYPE, POST_PAYOFF_PD_SUBTYPE]);
  assert.equal(assembleClaim(l15Input()).deferral, null);
  assert.equal(milestoneReached({ event_type: "lossmit.deferral.completed", loan_id: "L12", milestone_date: D("2027-09-30"), mi_insured: false })!.payload.kind, "deferral_completed");
  // on the bus: the sweep's `lossmit.deferral.completed` arms FNMA_F105_PD_EXPENSE_60 (and E-5-01's workout-completion row) at Nov 29; the deferral claim's submission satisfies both
  const h = harness("2027-10-01T14:00:00.000Z");
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "candidates", milestones: [{ event_type: "lossmit.deferral.completed", loan_id: "L15", milestone_date: "2027-09-30" }] });
  assert.deepEqual([h.engine.byCode("FNMA_F105_PD_EXPENSE_60")[0]!.dueDate, h.engine.byCode("FNMA_E501_EXPENSE_FINAL_60")[0]!.dueDate], [D("2027-11-29"), D("2027-11-29")]);
  await h.run("assembleClaim", CLAIMS_REO, { loan_id: "L15", claim_id: "SM-L15-MOD-001", claim_type: "fnma_mod", milestone_kind: "deferral_completed", milestone_date: "2027-09-30", lines: dLines, credits: [], context: { state: "TX", track: "non_judicial", event_date: "2027-09-30" }, deferral: { closed_on: "2027-09-30", incentive_cents: 120_000n } });
  const storedMod = h.rt.store.get("expense_claims", "SM-L15-MOD-001")!.data as { status: string; deferral: { capitalized_advance_rule: string } }; assert.equal(storedMod.status, "validated"); assert.equal(storedMod.deferral.capitalized_advance_rule, "claim_required_no_auto_generation");
  await h.run("buildBulkPackage", CLAIMS_REO, { claim_id: "SM-L15-MOD-001", today: "2027-10-20", api_credentialed: true, api_status: 503 });
  await h.run("buildBulkPackage", OPERATOR, { claim_id: "SM-L15-MOD-001", op: "record_upload", p360_claim_id: "P360-9002", submitted_on: "2027-10-20" });
  assert.deepEqual([h.engine.byCode("FNMA_F105_PD_EXPENSE_60")[0]!.status, h.engine.byCode("FNMA_E501_EXPENSE_FINAL_60")[0]!.status], ["satisfied", "satisfied"]);
  // the cancelled-workout incentive (edge case): cancelled Dec 1, 2027 and not re-entered within 30 days → CRS 350 repaid by Jan 30, 2028 (FNMA_F105_INCENTIVE_REPAY_60); the settled 350 satisfies it
  assert.deepEqual(incentiveRepayment({ cancellation_date: D("2027-12-01"), re_entered_on: null, incentive_cents: 100_000n, today: D("2028-01-05") }), { reenter_by: D("2027-12-31"), re_entered_within_30: false, repay: true, crs_code: "350", fnma_repay_due_at: D("2028-01-30"), amount_cents: 100_000n });
  assert.equal(incentiveRepayment({ cancellation_date: D("2027-12-01"), re_entered_on: D("2027-12-20"), incentive_cents: 100_000n, today: D("2028-01-05") }).repay, false, "re-entered within 30 days: the incentive stays");
  assert.equal(incentiveRepayment({ cancellation_date: D("2027-12-01"), re_entered_on: null, incentive_cents: 100_000n, today: D("2027-12-15") }).re_entered_within_30, null, "the 30-day window is still open");
  const inc = harness("2028-01-05T14:00:00.000Z");
  assert.equal(((await inc.run("sweepClaimCandidates", CLAIMS_REO, { op: "incentive_repayment", loan_id: "L15", workout_id: "PD-7", cancellation_date: "2027-12-01", incentive_cents: 100_000n, today: "2027-12-15" })).output as { scheduled: boolean }).scheduled, false); assert.equal(inc.engine.byCode("FNMA_F105_INCENTIVE_REPAY_60").length, 0);
  await inc.run("sweepClaimCandidates", CLAIMS_REO, { op: "incentive_repayment", loan_id: "L15", workout_id: "PD-7", cancellation_date: "2027-12-01", incentive_cents: 100_000n });
  const incEvent = inc.events.all().find((e) => e.type === "workout_incentive.repayment_scheduled")!; assert.deepEqual([incEvent.payload.re_entered_within_30, incEvent.payload.cancellation_date, incEvent.payload.crs_code, incEvent.payload.amount_cents], [false, "2027-12-01", "350", 100_000n]);
  assert.equal(inc.engine.byCode("FNMA_F105_INCENTIVE_REPAY_60")[0]!.dueDate, D("2028-01-30")); assert.equal(inc.engine.byCode("FNMA_F105_INCENTIVE_REPAY_60")[0]!.anchorDate, D("2027-12-01"));
  await inc.run("sweepClaimCandidates", CLAIMS_REO, { op: "reconcile", today: "2028-01-25", remittances: [{ code: "350", amount_cents: 100_000n, settled_on: "2028-01-20", loan_id: "L15" }] });
  assert.equal(inc.engine.byCode("FNMA_F105_INCENTIVE_REPAY_60")[0]!.status, "satisfied");
});
test("15.2-T13: Given an attachment containing an SSN, then the redaction check blocks the package and logs the finding.", async () => {
  const claim = l15Claim();
  const npi = buildBulkPackage(claim, "SM-L15-571-001", [{ name: "hazard-invoice.pdf", line_index: 1, text: "insured SSN 123-45-6789" }]);
  assert.equal(npi.ok, false); assert.deepEqual(npi.findings, [{ attachment: "hazard-invoice.pdf", finding: "ssn_detected" }]); assert.match(npi.blocked_by[0]!, /redaction check failed: hazard-invoice\.pdf contain NPI/);
  assert.ok(attachmentContainsSsn("SSN 123-45-6789")); assert.equal(attachmentContainsSsn("loan 1234567890"), false);
  // on the bus the guardrail refuses before any package or task exists and the refusal event logs the finding
  const h = harness("2027-11-03T14:00:00.000Z");
  await h.run("assembleClaim", CLAIMS_REO, claimInput);
  await assert.rejects(h.run("buildBulkPackage", CLAIMS_REO, { claim_id: "SM-L15-571-001", today: "2027-11-03", attachments: [{ name: "hazard-invoice.pdf", line_index: 1, text: "insured SSN 123-45-6789" }] }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_NPI_ATTACHMENTS");
  const refused = h.events.all().find((e) => e.type === "command.refused")!; assert.equal(refused.payload.code, "NO_NPI_ATTACHMENTS"); assert.match(String(refused.payload.reason), /redact SSNs/);
  assert.equal(h.rt.store.get("expense_claims", "SM-L15-571-001")!.data.status, "validated"); assert.equal(h.rt.escalations.opened.length, 0);
  // the operator's PSA upload is screened the same way
  await assert.rejects(h.run("buildBulkPackage", OPERATOR, { claim_id: "SM-L15-571-001", op: "psa_response", attachments: [{ name: "id.pdf", line_index: 0, text: "SSN 987-65-4321" }] }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_NPI_ATTACHMENTS");
});

test("15.2 worked figures: fixture L15 — taxes $4,820.00; hazard $1,450.00; MI 11 × $124.54 = $1,369.94; inspections 9 × $30.00 = $270.00; preservation lock $60.00 + cut $125.00 + re-cuts 2 × $80.00 = $160.00 + debris 2 × $50.00 = $100.00 → $445.00; TX fee $2,300.00; costs $350.00 + $215.00 = $565.00; tech $25.00 + e-invoice $5.00 = $30.00; gross $11,249.94; credit $659.45; net $10,590.49", async () => {
  // Rule 5 itemization — quantity × unit price, whole numbers, no rounding.
  const mi = itemize([{ label: "MI premium Dec 2026–Oct 2027", unit_cents: 12_454n, quantity: 11 }]);
  assert.equal(mi.lines[0]!.amount_cents, 136_994n); assert.equal(mi.total_cents, 136_994n);
  const insp = itemize([{ label: "exterior inspection Jan–Sep 2027", unit_cents: 3_000n, quantity: 9 }]);
  assert.equal(insp.total_cents, 27_000n);
  const ppm = itemize([{ label: "lock change", unit_cents: 6_000n, quantity: 1 }, { label: "initial grass cut", unit_cents: 12_500n, quantity: 1 }, { label: "re-cut", unit_cents: 8_000n, quantity: 2 }, { label: "debris removal (CY)", unit_cents: 5_000n, quantity: 2 }]);
  assert.deepEqual(ppm.lines.map((l) => l.amount_cents), [6_000n, 12_500n, 16_000n, 10_000n]); assert.equal(ppm.total_cents, 44_500n);
  assert.throws(() => itemize([{ label: "half a cut", unit_cents: 8_000n, quantity: 1.5 }]), RangeError);
  // E-5-05 non-judicial milestone billing at 30/65/75/85/95/100% of the TX exhibit ($2,300.00) sums to the exhibit, never prorated between milestones.
  const fee = milestoneBilling(230_000n, "non_judicial", [{ milestone: "title_requested", invoice_cents: 69_000n }, { milestone: "title_reviewed", invoice_cents: 80_500n }, { milestone: "notices_started", invoice_cents: 23_000n }, { milestone: "first_legal", invoice_cents: 23_000n }, { milestone: "sale_package", invoice_cents: 23_000n }, { milestone: "sale_held", invoice_cents: 11_500n }]);
  assert.deepEqual(fee.bills.map((b) => b.earned_cents), [69_000n, 80_500n, 23_000n, 23_000n, 23_000n, 11_500n]); assert.equal(fee.total_fee_cents, 230_000n);
  assert.throws(() => milestoneBilling(230_000n, "non_judicial", [{ milestone: "complaint_filed", invoice_cents: 1n }]), /not prorated between milestones/);
  const costs = itemize([{ label: "title", unit_cents: 35_000n, quantity: 1 }, { label: "posting/filing/recording", unit_cents: 21_500n, quantity: 1 }]);
  assert.equal(costs.total_cents, 56_500n);
  const tech = itemize([{ label: "technology fee", unit_cents: 2_500n, quantity: 1 }, { label: "e-invoice fee (FCL)", unit_cents: 500n, quantity: 1 }]);
  assert.equal(tech.total_cents, 3_000n);
  // Rule 2 caps recorded per line from the versioned schedules: technology $25.00, e-invoice $5.00, exterior inspection $30.00 (F-1-05; ./claims.ts records $45 — corrected in validateLine152), PPM lock $60.00 / cut $125.00 / re-cut $80.00 / debris $50.00 per CY, TX exhibit $2,300.00.
  assert.equal(validateLine(L15[10]!, CTX).cap_cents, 2_500n); assert.equal(validateLine(L15[11]!, CTX).cap_cents, 500n);
  assert.equal(validateLine(L15[3]!, CTX).cap_cents, 3_000n); assert.equal(validateLine(L15[8]!, CTX).cap_cents, 230_000n);
  assert.deepEqual(L15.slice(4, 8).map((l) => validateLine(l, CTX).cap_cents), [6_000n, 12_500n, 8_000n, 5_000n]);
  // Gross = 4,820.00 + 1,450.00 + 1,369.94 + 270.00 + 445.00 + 2,300.00 + 565.00 + 30.00 = $11,249.94.
  const v = L15.map((l) => validateLine(l, CTX));
  assert.deepEqual(v.map((x) => x.amount_cents), [482_000n, 145_000n, 136_994n, 27_000n, 6_000n, 12_500n, 16_000n, 10_000n, 230_000n, 56_500n, 2_500n, 500n]);
  assert.equal(482_000n + 145_000n + mi.total_cents + insp.total_cents + ppm.total_cents + fee.total_fee_cents + costs.total_cents + tech.total_cents, 1_124_994n);
  // Credit: unearned hazard premium Oct 5, 2027–Mar 20, 2028 = 166/365 × $1,450.00 = $659.45 → net $10,590.49.
  assert.equal(HAZARD_REFUND.amount_cents, 65_945n);
  const t = claimTotals(v, [HAZARD_REFUND.amount_cents]); assert.equal(t.gross_cents, 1_124_994n); assert.equal(t.net_cents, 1_059_049n); assert.equal(t.blocked, 0);
  const claim = l15Claim();
  assert.equal(claim.gross, 1_124_994n); assert.equal(claim.net, 1_059_049n); assert.equal(claim.status, "validated"); assert.deepEqual(claim.exceptions, []);
  assert.ok(claim.lines.every((l) => l.validation === "pass" && l.indicator === "blank"));
  // final_due_at = min(disposition + 60 [unknown], Oct 5 + 30 = Thu Nov 4, 2027); package ready by Oct 25 (SM_EXPENSE_CLAIM_TARGET_20); policy claim by Dec 4.
  assert.equal(claim.final_due_at, D("2027-11-04")); assert.equal(claim.internal_target_at, D("2027-10-25")); assert.equal(claim.policy_due_at, D("2027-12-04"));
  // E-4.4-02: without the credit line or a refusal comment the final claim is blocked; the refusal comment clears it and the $659.45 is remitted with code 318 on receipt after payment.
  const noCredit = assembleClaim(l15Input({ credits: [] }));
  assert.equal(noCredit.status, "draft"); assert.match(noCredit.exceptions[0]!, /FNMA_E4402_REFUND_CREDIT_ON_FINAL/);
  const refused = assembleClaim(l15Input({ credits: [], refund_refusal_comment: "carrier refused refund — E-4.4-02 comment" }));
  assert.equal(refused.status, "validated"); assert.equal(refused.gross, 1_124_994n); assert.equal(refused.net, 1_124_994n); assert.match(refused.e4402_comment!, /E-4\.4-02/);
  assert.deepEqual(postPaymentCredit({ kind: "hazard_refund", amount_cents: 65_945n, received_at: D("2027-11-22"), claim_paid: true }), { treatment: "remit", remit_code: "318", due: D("2027-12-22"), amount_cents: 65_945n });
  // Paid Nov 20 → ACH expected Wed Nov 24, 2027 (3 fannie_et BD; Nov 25 holiday tolerance to Nov 29).
  assert.equal(achExpected(D("2027-11-20")).expected, D("2027-11-24")); assert.equal(achExpected(D("2027-11-20")).escalate_after, D("2027-11-29"));
  // Rule 1 sweep: delinquency P&I never claimable (15.4); collected-from-borrower → advance_recoveries; recoverable-but-omitted → e505_not_included.
  const sw = sweepClaimCandidates([
    { id: "adv-tax-2026", loan_id: "L15", kind: "escrow_tax", amount_cents: 482_000n, paid_at: D("2027-01-31"), invoice_document_id: "doc-1", allowable_code: "taxes", borrower_recoverable: true },
    { id: "adv-pi", loan_id: "L15", kind: "delinquency_pi", amount_cents: 147_600n, paid_at: D("2027-01-18"), invoice_document_id: null, allowable_code: null, borrower_recoverable: true },
    { id: "adv-hoa", loan_id: "L15", kind: "hoa", amount_cents: 30_000n, paid_at: D("2027-06-01"), invoice_document_id: "doc-2", allowable_code: "hoa", borrower_recoverable: true, collected_from_borrower: true },
    { id: "adv-late-fee", loan_id: "L15", kind: "legal_cost", amount_cents: 5_000n, paid_at: D("2027-06-01"), invoice_document_id: "doc-3", allowable_code: "legal_cost", borrower_recoverable: true, omitted_from_payoff_figure: true },
    { id: "adv-unpaid", loan_id: "L15", kind: "preservation", amount_cents: 44_500n, paid_at: null, invoice_document_id: "doc-4", allowable_code: "preservation", borrower_recoverable: false },
  ]);
  assert.deepEqual(sw.candidates.map((a) => a.id), ["adv-tax-2026"]); assert.equal(sw.by_loan.L15, 482_000n);
  assert.deepEqual(sw.skipped, [{ advance_id: "adv-pi", reason: "pi_advances_not_claimable" }, { advance_id: "adv-hoa", reason: "collected_from_borrower" }, { advance_id: "adv-late-fee", reason: "e505_not_included" }, { advance_id: "adv-unpaid", reason: "not_paid" }]);
  // Rule 1 at reinstatement: the indicator per line — collected → excluded (advance_recoveries), non_recoverable needs its legal basis, the rest not_yet_recovered.
  const reinstated = assembleClaim({ loan_id: "L15", claim_type: "571", milestone_kind: "reinstatement", milestone_date: D("2027-08-02"), mi_insured: false, disposition_date: null, credits: [], context: claimContext152({ event_date: D("2027-08-02"), state: "TX", track: "non_judicial", servicing_option: "special" }), lines: [
    { advance_id: "adv-insp", kind: "inspection", unit_cents: 3_000n, quantity: 3, paid_on: D("2027-06-30"), invoice: true, f105_inspection_type: "exterior", nonrecoverable_indicator: "non_recoverable", legal_basis: "TX Prop. Code §51.002 — inspection fees not chargeable under the deed of trust (jurisdiction_rules)" },
    { advance_id: "adv-hoa", kind: "hoa", unit_cents: 30_000n, quantity: 1, paid_on: D("2027-06-01"), invoice: true, collected_from_borrower: true },
    { advance_id: "adv-bpo", kind: "attorney_cost", unit_cents: 12_500n, quantity: 1, paid_on: D("2027-06-01"), invoice: true },
    { advance_id: "adv-basisless", kind: "attorney_cost", unit_cents: 5_000n, quantity: 1, paid_on: D("2027-06-01"), invoice: true, nonrecoverable_indicator: "non_recoverable" }] });
  assert.deepEqual(reinstated.excluded, [{ advance_id: "adv-hoa", reason: "collected_from_borrower", tag: null, amount: 30_000n, messages: ["collected_from_borrower"] }]);
  assert.deepEqual(reinstated.lines.map((l) => [l.advance_id, l.indicator, l.validation]), [["adv-insp", "non_recoverable", "pass"], ["adv-bpo", "not_yet_recovered", "pass"], ["adv-basisless", "non_recoverable", "fail"]]);
  assert.match(reinstated.exceptions[0]!, /nonrecoverable_without_basis/);
  // on the bus the same line is refused by the guardrail before anything runs
  const h = harness("2027-08-10T14:00:00.000Z");
  await assert.rejects(h.run("validateLine", CLAIMS_REO, { line: { kind: "attorney_cost", unit_cents: 5_000n, quantity: 1, paid_on: "2027-06-01", invoice: true, nonrecoverable_indicator: "non_recoverable" }, context: CTX }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_NONRECOVERABLE_WITHOUT_BASIS");
  const vl = (await h.run("validateLine", CLAIMS_REO, { line: L15[3], context: { state: "TX", track: "non_judicial", event_date: "2027-10-05", servicing_option: "special" } })).output as { cap_cents: bigint; rule_set: string };
  assert.equal(vl.cap_cents, 3_000n); assert.equal(vl.rule_set, F105_LIMITS_RULE_SET);
  // T9 batch and T12 deferral figures stay reproducible from the calculators.
  assert.equal(recoveryRepaymentBatch({ completion_on: D("2028-01-15"), source: "borrower_reinstatement", collected_cents: 300_000n, reimbursed: [{ advance_id: "a1", reimbursed_cents: 300_000n, reimbursed_on: D("2027-11-20") }] }).fnma_repay_due_at, D("2028-03-15"));
  assert.equal(deferralExpenseClaim({ completed_on: D("2027-09-30"), closed_on: D("2027-09-30"), lines: [{ label: "title", unit_cents: 15_000n, quantity: 1 }, { label: "recording", unit_cents: 9_000n, quantity: 1 }] }).total_cents, 24_000n);
  assert.equal(recoveryRepaymentBatch({ completion_on: D("2028-01-15"), source: "borrower_reinstatement", collected_cents: 300_000n, reimbursed: [{ advance_id: "a1", reimbursed_cents: 300_000n, reimbursed_on: D("2027-11-20") }] }).crs_code, "353");
});

test("15.2 timers reused from 9.9: a preservation line over its PPM cap with no bid id is the over-allowable condition (FNMA_PPM_OVER_ALLOWABLE_BID_15: HomeTracker bid within 15 days); a denied/modified decision starts FNMA_PPM_BID_RECONSIDER_7 (7 days) and an unreconsidered denial leaves the line at the cap", async () => {
  // lock change invoiced at $90.00 against the PPM cap $60.00 with no hometracker_bid_id: the line fails (rule 2) and the condition is discovered when the claim is assembled on Oct 20, 2027
  const overLock = { ...L15[4]!, unit_cents: 9_000n };
  const claim = assembleClaim(l15Input({ lines: [...L15.slice(0, 4), overLock, ...L15.slice(5)] }));
  assert.equal(claim.status, "draft"); assert.deepEqual(claim.exceptions, ["adv-ppm-lock: preservation_over_allowable cap=6000"]);
  assert.deepEqual(overAllowableConditions(claim, D("2027-10-20")), [{ advance_id: "adv-ppm-lock", item: "lock_change", amount_cents: 9_000n, cap_cents: 6_000n, discovered_on: D("2027-10-20"), bid_due: D("2027-11-04") }]);
  assert.deepEqual(overAllowableConditions(l15Claim(), D("2027-10-20")), [], "within the cap: nothing to bid");
  assert.deepEqual(overAllowableConditions(assembleClaim(l15Input({ lines: [...L15.slice(0, 4), { ...overLock, hometracker_bid_id: "HT-77" }, ...L15.slice(5)] })), D("2027-10-20")), [], "an approved bid id lifts the cap — no condition");
  // the inbound HomeTracker record is validated before anything is appended
  assert.throws(() => ingestHomeTrackerBid("L15", { bid_id: "HT-77", advance_id: "adv-ppm-lock", bid_cents: 9_000n, submitted_on: D("2027-10-28"), outcome: "denied" }), /needs decided_on/);
  assert.throws(() => ingestHomeTrackerBid("L15", { bid_id: "HT-77", advance_id: "adv-ppm-lock", bid_cents: 9_000n, submitted_on: D("2027-10-28"), outcome: "modified", decided_on: D("2027-11-01") }), /needs approved_cents/);
  assert.throws(() => ingestHomeTrackerBid("L15", { bid_id: "HT-77", advance_id: "adv-ppm-lock", bid_cents: 0n, submitted_on: D("2027-10-28") }), /positive bid_cents/);
  assert.throws(() => ingestHomeTrackerBid("L15", { bid_id: "HT-77", advance_id: "adv-ppm-lock", bid_cents: 9_000n, submitted_on: D("2027-10-28"), outcome: "withdrawn" as never, decided_on: D("2027-11-01") }), /approved, denied or modified/);
  const denied = ingestHomeTrackerBid("L15", { bid_id: "HT-77", advance_id: "adv-ppm-lock", bid_cents: 9_000n, submitted_on: D("2027-10-28"), outcome: "denied", decided_on: D("2027-11-01"), cap_cents: 6_000n });
  assert.deepEqual([denied.claimable_cents, denied.reconsider_by, denied.events.map((e) => e.type)], [6_000n, D("2027-11-08"), ["preservation.bid.submitted", "preservation.bid.decided"]], "an unreconsidered denial reduces the claimable amount to the PPM cap");
  assert.equal(ingestHomeTrackerBid("L15", { bid_id: "HT-78", advance_id: "adv-ppm-lock", bid_cents: 9_000n, submitted_on: D("2027-10-28"), outcome: "approved", decided_on: D("2027-11-01"), cap_cents: 6_000n }).claimable_cents, 9_000n);
  assert.deepEqual([ingestHomeTrackerBid("L15", { bid_id: "HT-79", advance_id: "adv-ppm-lock", bid_cents: 9_000n, submitted_on: D("2027-10-28"), outcome: "modified", decided_on: D("2027-11-01"), approved_cents: 7_500n }).claimable_cents, ingestHomeTrackerBid("L15", { bid_id: "HT-80", advance_id: "adv-ppm-lock", bid_cents: 9_000n, submitted_on: D("2027-10-28"), cap_cents: 6_000n }).reconsider_by], [7_500n, null]);
  assert.throws(() => bidReconsideration("L15", { ...denied, outcome: "approved" }, D("2027-11-05"), ["photos"]), /only a denied or modified bid is reconsidered/);
  assert.throws(() => bidReconsideration("L15", denied, D("2027-11-05"), []), /needs supporting evidence/);
  assert.deepEqual([bidReconsideration("L15", denied, D("2027-11-05"), ["photos"]).late, bidReconsideration("L15", denied, D("2027-11-05"), ["photos"]).claimable_cents, bidReconsideration("L15", denied, D("2027-11-09"), ["photos"]).late, bidReconsideration("L15", denied, D("2027-11-09"), ["photos"]).claimable_cents], [false, 9_000n, true, 6_000n]);
  // the registry's own patterns (9.9's, reused by the 15.2 table) match the facts the tools append
  const reg = loadOverriddenRegistry(); const asEvent = (e: { type: string; payload: Record<string, unknown> }) => ({ id: "e", type: e.type, occurredAt: "2027-10-20T14:00:00.000Z", actor: SYSTEM, payload: e.payload }) as unknown as Parameters<typeof eventMatches>[1];
  assert.ok(eventMatches(reg.get("FNMA_PPM_OVER_ALLOWABLE_BID_15")!.satisfiedPattern!, asEvent(denied.events[0]!))); assert.ok(eventMatches(reg.get("FNMA_PPM_BID_RECONSIDER_7")!.triggerPattern!, asEvent(denied.events[1]!)));
  assert.equal(eventMatches(reg.get("FNMA_PPM_BID_RECONSIDER_7")!.triggerPattern!, asEvent(ingestHomeTrackerBid("L15", { bid_id: "HT-78", advance_id: "adv-ppm-lock", bid_cents: 9_000n, submitted_on: D("2027-10-28"), outcome: "approved", decided_on: D("2027-11-01") }).events[1]!)), false, "an approved bid arms no reconsideration clock");
  assert.ok(eventMatches(reg.get("FNMA_PPM_BID_RECONSIDER_7")!.satisfiedPattern!, asEvent(bidReconsideration("L15", denied, D("2027-11-05"), ["photos"]).event)));
  // on the bus: assembly on Oct 20 discovers the condition → FNMA_PPM_OVER_ALLOWABLE_BID_15 armed on discovered_on, due Nov 4; the HomeTracker feed's bid of Oct 28 satisfies it; the Nov 1 denial arms FNMA_PPM_BID_RECONSIDER_7 (Nov 8); the reconsideration of Nov 5 satisfies it
  const h = harness("2027-10-20T14:00:00.000Z");
  const out = (await h.run("assembleClaim", CLAIMS_REO, { ...claimInput, lines: [...L15.slice(0, 4), overLock, ...L15.slice(5)] })).output as { status: string; over_allowable: { advance_id: string; bid_due: string }[] };
  assert.equal(out.status, "draft"); assert.deepEqual(out.over_allowable.map((c) => [c.advance_id, c.bid_due]), [["adv-ppm-lock", "2027-11-04"]]);
  const discovered = h.events.all().find((e) => e.type === "preservation.condition.discovered")!;
  assert.deepEqual([discovered.payload.over_allowable, discovered.payload.advance_id, discovered.payload.item, discovered.payload.discovered_on, discovered.payload.cap_cents, discovered.payload.amount_cents], [true, "adv-ppm-lock", "lock_change", "2027-10-20", 6_000n, 9_000n]);
  const bidTimer = h.engine.byCode("FNMA_PPM_OVER_ALLOWABLE_BID_15")[0]!; assert.deepEqual([bidTimer.status, bidTimer.anchorDate, bidTimer.dueDate], ["armed", D("2027-10-20"), D("2027-11-04")]);
  assert.deepEqual([h.rt.store.get("advances", "adv-ppm-lock")!.data.over_allowable_discovered_on, h.rt.store.get("advances", "adv-ppm-lock")!.data.bid_due], ["2027-10-20", "2027-11-04"]);
  await h.run("assembleClaim", CLAIMS_REO, { ...claimInput, lines: [...L15.slice(0, 4), overLock, ...L15.slice(5)] });
  assert.equal(h.engine.byCode("FNMA_PPM_OVER_ALLOWABLE_BID_15").length, 1, "re-assembling the same draft discovers the same advance once");
  assert.equal(h.engine.byCode("FNMA_PPM_BID_RECONSIDER_7").length, 0);
  await assert.rejects(h.run("sweepClaimCandidates", CLAIMS_REO, { op: "hometracker", bids: [] }), /bids is required/);
  await assert.rejects(h.run("sweepClaimCandidates", CLAIMS_REO, { op: "hometracker", bids: [{ bid_id: "HT-77", advance_id: "adv-ppm-lock", bid_cents: 9_000n }] }), RangeError);
  assert.equal(h.types().filter((t) => t.startsWith("preservation.bid")).length, 0, "an invalid feed record appends nothing");
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "hometracker", bids: [{ bid_id: "HT-77", advance_id: "adv-ppm-lock", bid_cents: 9_000n, submitted_on: "2027-10-28" }] });
  assert.equal(h.engine.byCode("FNMA_PPM_OVER_ALLOWABLE_BID_15")[0]!.status, "satisfied"); assert.equal(h.rt.store.get("advances", "adv-ppm-lock")!.data.hometracker_bid_id, "HT-77");
  assert.equal(h.rt.store.get("hometracker_bids", "HT-77")!.data.claimable_cents, 6_000n, "undecided: the line is claimable at the cap until Fannie Mae answers");
  await h.run("sweepClaimCandidates", CLAIMS_REO, { op: "hometracker", bids: [{ bid_id: "HT-77", advance_id: "adv-ppm-lock", bid_cents: 9_000n, submitted_on: "2027-10-28", outcome: "denied", decided_on: "2027-11-01" }] });
  const decided = h.events.all().find((e) => e.type === "preservation.bid.decided")!; assert.deepEqual([decided.payload.outcome, decided.payload.decided_on, decided.payload.claimable_cents, decided.payload.reconsider_by], ["denied", "2027-11-01", 6_000n, "2027-11-08"]);
  const recon = h.engine.byCode("FNMA_PPM_BID_RECONSIDER_7")[0]!; assert.deepEqual([recon.status, recon.anchorDate, recon.dueDate], ["armed", D("2027-11-01"), D("2027-11-08")]);
  await assert.rejects(h.run("buildBulkPackage", CLAIMS_REO, { claim_id: "SM-L15-571-001", op: "bid_reconsideration", bid_id: "HT-99", submitted_on: "2027-11-05", evidence: ["photos"] }), /HomeTracker bid HT-99 not found/);
  const rc = (await h.run("buildBulkPackage", CLAIMS_REO, { claim_id: "SM-L15-571-001", op: "bid_reconsideration", bid_id: "HT-77", submitted_on: "2027-11-05", evidence: ["photos", "contractor estimate"] })).output as { late: boolean; reconsider_by: string; claimable_cents: bigint };
  assert.deepEqual([rc.late, rc.reconsider_by, rc.claimable_cents], [false, "2027-11-08", 9_000n]);
  assert.equal(h.engine.byCode("FNMA_PPM_BID_RECONSIDER_7")[0]!.status, "satisfied"); assert.equal(h.rt.store.get("hometracker_bids", "HT-77")!.data.reconsideration_submitted_on, "2027-11-05");
  assert.deepEqual(h.types().filter((t) => t.startsWith("preservation.")), ["preservation.condition.discovered", "preservation.bid.submitted", "preservation.bid.submitted", "preservation.bid.decided", "preservation.bid.reconsideration_submitted"]);
  // no reconsideration by Nov 8 → the engine breaches the 7-day row (sev-3) and the line stays claimable at the $60.00 cap
  const late = harness("2027-11-01T14:00:00.000Z");
  await late.run("assembleClaim", CLAIMS_REO, { ...claimInput, today: "2027-10-20", lines: [...L15.slice(0, 4), overLock, ...L15.slice(5)] });
  assert.equal(late.engine.byCode("FNMA_PPM_OVER_ALLOWABLE_BID_15")[0]!.dueDate, D("2027-11-04"), "discovery dated by the caller's `today` anchors the 15 days");
  await late.run("sweepClaimCandidates", CLAIMS_REO, { op: "hometracker", loan_id: "L15", bids: [{ bid_id: "HT-81", advance_id: "adv-ppm-lock", bid_cents: 9_000n, submitted_on: "2027-10-28", outcome: "modified", decided_on: "2027-11-01", approved_cents: 7_500n, cap_cents: 6_000n }] });
  assert.equal(late.rt.store.get("advances", "adv-ppm-lock")!.data.claimable_cents, 7_500n);
  assert.deepEqual(late.engine.evaluate("2027-11-09T05:00:00.000Z").map((b) => [b.instance.code, b.severity]), [["FNMA_PPM_BID_RECONSIDER_7", 3]]);
  const lateRc = (await late.run("buildBulkPackage", CLAIMS_REO, { claim_id: "SM-L15-571-001", op: "bid_reconsideration", bid_id: "HT-81", submitted_on: "2027-11-09", evidence: ["photos"] })).output as { late: boolean; claimable_cents: bigint };
  assert.deepEqual([lateRc.late, lateRc.claimable_cents, late.engine.byCode("FNMA_PPM_BID_RECONSIDER_7")[0]!.status], [true, 7_500n, "satisfied_late"]);
});
