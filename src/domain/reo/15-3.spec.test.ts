// 15.3 MI claim filing
// spec/sections/15-reo-claims-expense-reimbursement/15-3-mi-claim-filing.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, daysBetween, addMonths } from "../../kernel/calendar/date.ts";
import { monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { shadowClaim, filer, miClaimClocks } from "./mi-claim.ts";
import { directClaimPackage, interestCapWatch, shadowClaimItemized, dailyInterestAtRisk, curtailmentMonitor, validateInsurerIdentity, nodDueDate, nodLateness, trackDocRequests, reconcileEob, appealRouting, appealSubmissionCheck, unpaidClaimEscalation, benefitReceipt, supplementalClaimPlan, attributeShortfall, micpDocsOfficerAlert, curtailmentRiskRow, miDefaultStart, ingestDefaultReports, statusReportsCurrent, resolveMasterPolicyTerms, calculationRow, miClaimEventRow, remittanceSettlement, interestCapFacts, MI_CLAIM_EVENT_KINDS, MI_BENEFIT_REMIT_RULE, type ClaimAdvance, type DirectClaimInput } from "./ops-15-3.ts";

// Fixture L15 (spec rule 4 worked example): REO sale Tue Oct 5, 2027; UPB $249,088.61 at 6.25%, interest paid to Nov 1, 2026;
// itemized advances as the ledger holds them — the calculator decides which are claimable.
const L15_ADVANCES: ClaimAdvance[] = [
  { advance_id: "adv-tax", kind: "taxes", amount_cents: 482_000n },               // taxes $4,820.00
  { advance_id: "adv-haz", kind: "hazard_premium", amount_cents: 145_000n },      // hazard $1,450.00
  { advance_id: "adv-haz-ref", kind: "hazard_refund", amount_cents: 65_945n },    // − refund $659.45
  { advance_id: "adv-insp", kind: "inspection", amount_cents: 27_000n },          // inspections $270.00
  { advance_id: "adv-pres", kind: "preservation", amount_cents: 44_500n },        // preservation $445.00
  { advance_id: "adv-atty", kind: "attorney_fee", amount_cents: 230_000n },       // attorney fee $2,300.00
  { advance_id: "adv-costs", kind: "attorney_cost", amount_cents: 56_500n },      // costs $565.00
  { advance_id: "adv-mi", kind: "mi_premium", amount_cents: 136_994n },           // MI premiums $1,369.94 — excluded
  { advance_id: "adv-tech", kind: "technology_fee", amount_cents: 3_000n },       // tech fees $30.00 — excluded
];
const L15 = { upb_cents: 24_908_861n, note_rate_pct: "6.25", interest_paid_to: D("2026-11-01"), anchor: D("2027-10-05"), default_date: D("2026-12-01"), advances: L15_ADVANCES, credits_cents: 0n, coverage_pct: "25" } as const;
// the same fixture as the tools take it (ISO strings; Radian = MICP participant since Oct 18, 2021; Triad = run-off non-participant)
const RADIAN = { loan_id: "L15", claim_id: "mic-L15", insurer_code: "RADIAN", micp_participant: true, micp_effective_date: "2021-10-18", liquidation_type: "fcl_fnma", liquidation_date: "2027-10-05", claim_anchor_date: "2027-10-05" } as const;
const TRIAD = { ...RADIAN, insurer_code: "TRIAD", micp_participant: false, micp_effective_date: "" } as const;
const SHADOW_IN = { claim_id: "mic-L15", loan_id: "L15", upb_cents: 24_908_861n, note_rate_pct: "6.25", interest_paid_to: "2026-11-01", anchor: "2027-10-05", default_date: "2026-12-01", advances: L15_ADVANCES, credits_cents: 0n, coverage_pct: "25" } as const;
// the master-policy terms version in force for Radian (Participants Exhibit June 1, 2025: Radian — Oct. 18, 2021; MGIC-template day counts, open question 2)
const RADIAN_TERMS = { insurer_code: "RADIAN", policy_form: "RAF-2020", effective_from: "2020-03-01", effective_to: null, claim_filing_days: 60, late_deny_days: 120, settlement_days: 60, supplemental_days: 90, interest_advance_cap_months: 36, appeal_days: null, micp_participant: true, micp_effective_date: "2021-10-18" } as const;

// Tool harness: the 15.3 tools on the bus for the `claims-reo` agent, the section's overridden timer registry armed for 15.3 (and, where a
// test needs 15.2's row, 15.2), an in-memory ledger and escalation service — so a test can prove what each step emits, arms, satisfies, posts and escalates.
const AGENT: Actor = { kind: "agent", id: "claims-reo" };
const REVIEWER: Actor = { kind: "human", id: "reviewer-1", role: "human_agent" };
const REG = loadOverriddenRegistry();
const def = (code: string) => REG.get(code)!;
type Out = Record<string, any>;
function harness(nowIso = "2027-10-06T14:00:00.000Z", loanId = "L15", processes: readonly string[] = ["15.3"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const ctx: UowContext = { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadOverriddenRegistry(), events, { processes }), clock, decide: () => {} };
  const escalations = new EscalationService(events, clock); const store = new EntityStore();
  const agents = new AgentRegistry(); const cmds = bindTools({ store, ports: {}, escalations, services: {} }, agents); const bus = new CommandBus(agents);
  const run = async (tool: string, input: Record<string, unknown>, actor: Actor = AGENT): Promise<Out> => (await bus.execute(cmds.get(toolKey("15.3", tool))!, actor, input, ctx)).output as Out;
  const timer = (code: string) => ctx.timers.byCode(code);
  const last = (code: string) => { const t = timer(code).at(-1); assert.ok(t, `${code} was never armed`); return t; };
  const ev = (type: string) => events.ofType(type);
  const refused = async (p: Promise<unknown>, code: string) => { await assert.rejects(p, (e: unknown) => e instanceof CommandRefused && e.code === code); };
  const claimEvents = (claimId: string) => store.list("mi_claim_events", (d) => d.claim_id === claimId).map((r) => r.data);
  return { ctx, events, escalations, store, run, timer, last, ev, refused, claimEvents };
}

test("15.3-T1: Given fixture L15 (Radian, sale Oct 5, 2027), then `filer = fnma_micp`, `claim_filing_deadline` = Dec 4, 2027, `micp_docs_due_at` = Nov 19, 2027, `SM_MICP_DOCS_TARGET_15` = Oct 20, 2027, and the shadow calc yields claim amount $272,720.51 and benefit $68,180.13.", async () => {
  // routing: Radian participates in MICP since Oct 18, 2021 and the sale (Oct 5, 2027) is after it → Fannie Mae files
  assert.equal(filer({ micp_participant: true, micp_effective: D("2021-10-18"), liquidation_date: D("2027-10-05") }), "fnma_micp");
  const terms = resolveMasterPolicyTerms({ insurer_code: "Radian", liquidation_date: D("2027-10-05"), terms: [{ id: "terms-radian", ...RADIAN_TERMS }], input: { micp_participant: false, micp_effective_date: null } });
  assert.equal(terms.source, "mi_master_policy_terms"); assert.equal(terms.micp_participant, true); assert.equal(terms.micp_effective_date, D("2021-10-18")); assert.equal(terms.claim_filing_days, 60); assert.match(terms.input_disagrees!, /micp_participant input false vs terms true/);
  assert.equal(resolveMasterPolicyTerms({ insurer_code: "TRIAD", liquidation_date: D("2027-10-05"), terms: [{ id: "terms-radian", ...RADIAN_TERMS }], input: { micp_participant: false, micp_effective_date: null } }).source, "agent_input", "no terms loaded → the agent's Participants Exhibit reading fills the gap");
  const h = harness();
  h.store.put("mi_master_policy_terms", "terms-radian", { ...RADIAN_TERMS }, AGENT, "2027-10-06T14:00:00.000Z");
  const r = await h.run("routeMiClaim", { ...RADIAN, micp_participant: false, micp_effective_date: "" });   // the loaded terms row, not the agent's flags, decides the filer
  assert.equal(r.filer, "fnma_micp"); assert.equal(r.status, "routed"); assert.equal(r.master_policy_terms_id, "terms-radian"); assert.equal(r.terms_source, "mi_master_policy_terms");
  assert.equal(r.claim_filing_deadline, "2027-12-04");                       // Sat Dec 4, 2027 = anchor + 60 (master policy §64(b))
  assert.equal(r.micp_docs_due_at, "2027-11-19");                            // 10 fannie_et BD earlier (Nov 25 Thanksgiving skipped)
  assert.equal(r.internal_target, "2027-10-20"); assert.equal(r.direct_file_due_at, null);
  assert.equal(r.officer_alert_on, "2027-11-16", "guardrail: officer alert 3 BD before micp_docs_due_at");
  // the liquidation fact (`mi_claims.opened`) arms the master-policy clocks; the routing arms the MICP document clocks — on the dates the spec names
  assert.equal(h.ev("mi_claims.opened")[0]!.payload.claim_filing_deadline, "2027-12-04");
  assert.equal(h.last("MI_MP_CLAIM_FILE_60").dueDate, "2027-12-04"); assert.equal(h.last("MI_MP_CLAIM_FILE_60").armedByEventId, h.ev("mi_claims.opened")[0]!.id);
  assert.equal(h.last("MI_MP_LATE_DENY_120").dueDate, "2028-02-02"); assert.equal(h.last("MI_MP_SUPPLEMENTAL_90").dueDate, "2028-01-03");
  assert.equal(h.last("FNMA_F106_MICP_DOCS_10BD").dueDate, "2027-11-19"); assert.equal(h.last("FNMA_F106_MICP_DOCS_10BD").armedByEventId, h.ev("mi_claims.routed")[0]!.id);
  assert.equal(h.last("SM_MICP_DOCS_TARGET_15").dueDate, "2027-10-20");
  assert.equal(h.timer("FNMA_F106_MI_DIRECT_FILE_30").length, 0, "no direct-filing clock when Fannie Mae files");
  // the shadow calc: claim amount $272,720.51, benefit $68,180.13 — versioned in mi_claim_calculations with the table's columns
  const s = await h.run("computeShadowClaim", SHADOW_IN);
  assert.equal(s.claim_amount_cents, 27_272_051n); assert.equal(s.benefit_cents, 6_818_013n); assert.equal(s.version, 1);
  assert.equal(s.interest_from, "2026-11-01"); assert.equal(s.interest_to, "2027-10-05"); assert.equal(s.interest_rate_bps, 625); assert.equal(s.interest_cents, 1_444_135n); assert.equal(s.interest_months_capped, false);
  assert.equal(s.advances.length, 9); assert.equal(s.attorney_fee_cap_cents, 747_266n); assert.deepEqual(s.credits, []); assert.equal(s.coverage_pct, "25"); assert.equal(s.loss_cents, null);
  assert.match(s.method_notes, /11 whole month\(s\)/); assert.match(s.method_notes, /4 stub day\(s\)/);
  assert.equal(s.interest_cap_gate.open, true, "interest to Oct 5, 2027 is inside the 36-month cap (first uninsured installment Dec 1, 2029)"); assert.equal(s.interest_cap_gate.not_after, "2029-12-01");
  assert.equal(h.store.get("mi_claims", "mic-L15")!.data.expected_benefit_cents, 6_818_013n);
  // guardrail: the daily MICP dashboard check raises the officer alert at −3 BD (Nov 16) when the package is not up, not before
  assert.equal((await h.run("trackDocRequests", { claim_id: "mic-L15", today: "2027-11-15" })).officer_alert, null);
  const alert = (await h.run("trackDocRequests", { claim_id: "mic-L15", today: "2027-11-16" })).officer_alert;
  assert.equal(alert.kind, "officer"); assert.equal(alert.severity, "sev1"); assert.equal(alert.payload.alert_on, "2027-11-16"); assert.equal(alert.payload.micp_docs_due_at, "2027-11-19");
  assert.equal((await h.run("trackDocRequests", { claim_id: "mic-L15", today: "2027-11-17" })).officer_alert, null, "alerted once");
  // the operator's recorded upload (all mandatory kinds) satisfies both document clocks; the MICP filing observed by the operator satisfies the 60-day clock
  const pkg = await h.run("assembleMiPackage", { claim_id: "mic-L15", loan_id: "L15", liquidation_type: "fcl_fnma", route: "fnma_micp", documents: (pkg_kinds() as string[]).map((k) => ({ id: `doc-${k}`, doc_kind: k, sha256: "h" })) });
  assert.equal(pkg.complete, true);
  await h.run("openPortalTask", { op: "record_result", claim_id: "mic-L15", task_type: "micp.docs.upload", package_id: h.store.list("mi_claim_packages")[0]!.id, uploaded_at: "2027-11-18" });
  assert.equal(h.ev("mi_claims.package.uploaded")[0]!.payload.mandatory_complete, true);
  assert.equal(h.last("FNMA_F106_MICP_DOCS_10BD").status, "satisfied"); assert.equal(h.last("SM_MICP_DOCS_TARGET_15").status, "satisfied");
  await h.run("trackDocRequests", { claim_id: "mic-L15", today: "2027-11-30", micp_claim_status: "filed_by_fnma", filed_at: "2027-11-29" });
  assert.deepEqual(h.ev("mi.claim.filed").map((e) => [e.payload.route, e.payload.filed_by]), [["fnma_micp", "fannie_mae"]]);
  assert.equal(h.last("MI_MP_CLAIM_FILE_60").status, "satisfied"); assert.equal(h.last("MI_MP_LATE_DENY_120").status, "satisfied");
  // every step left its mi_claim_events row, with the kinds the data model / 0036 CHECK enumerate
  assert.deepEqual(h.claimEvents("mic-L15").map((e) => e.kind), ["doc_uploaded", "filed"]);
  assert.ok(h.claimEvents("mic-L15").every((e) => (MI_CLAIM_EVENT_KINDS as readonly string[]).includes(String(e.kind)) && e.occurred_at && e.source && e.actor_kind && e.actor_id));
  assert.equal(h.claimEvents("mic-L15")[1]!.filer, "fnma_micp"); assert.equal(h.claimEvents("mic-L15")[1]!.source, "fnma");
  assert.throws(() => miClaimEventRow({ claim_id: "mic-L15", loan_id: "L15", kind: "followup" as never, occurred_on: D("2027-11-01"), source: "servicer", actor: AGENT }), RangeError);
  await assert.rejects(h.run("openPortalTask", {}), RangeError, "an empty portal task is refused, not opened");
  function pkg_kinds() { return ["payment_history", "servicing_notes", "collection_chronology", "borrower_correspondence", "valuation", "property_preservation_invoices", "tax_bills", "insurance_evidence", "hoa_statements", "attorney_invoices", "bidding_instructions", "foreclosure_deed"]; }
});
test("15.3-T2: Given the same loan insured by a non-participant, then `direct_file_due_at` = Nov 4, 2027 (30 days), the Claim for Loss package is generated with payee = Fannie Mae, and follow-ups recur weekly after filing.", async () => {
  // the same L15 loan (sale Oct 5, 2027) insured by an insurer absent from the Participants Exhibit (run-off Triad)
  const given: DirectClaimInput = { insurer_code: "TRIAD", micp_participant: false, micp_effective: null, liquidation_type: "fcl_fnma", liquidation_date: D("2027-10-05"), claim_anchor_date: D("2027-10-05"), expense_anchor_date: D("2027-10-05"), filed_on: D("2027-11-01"), paid_on: D("2027-12-13") };
  const r = directClaimPackage(given);
  assert.equal(r.filer, "servicer_direct");
  assert.equal(r.direct_file_due_at, D("2027-11-04")); assert.equal(daysBetween(given.claim_anchor_date, r.direct_file_due_at), 30);
  assert.equal(r.claim_filing_deadline, D("2027-12-04"), "the master policy's 60 days still runs; F-1-06's 30 days governs the servicer");
  assert.equal(r.package!.payee, "Fannie Mae"); assert.equal(r.package!.payee_role, "GSE Beneficiary"); assert.match(r.package!.payee_instruction, /GSE Beneficiary/);
  assert.equal(r.package!.form, "TRIAD Claim for Loss");
  assert.ok(r.package!.documents.includes("claim_form") && r.package!.documents.includes("payment_history") && r.package!.documents.includes("foreclosure_deed") && r.package!.documents.includes("attorney_invoices"));
  assert.ok(!r.package!.documents.includes("origination_file_item"), "origination-file items only on request");
  // follow-ups: every 7 calendar days after filing (Nov 1) until the benefit is paid (Dec 13)
  assert.equal(r.followups.timer, "SM_MI_SETTLEMENT_FOLLOWUP_7"); assert.equal(r.followups.every_days, 7);
  assert.deepEqual(r.followups.schedule, [D("2027-11-08"), D("2027-11-15"), D("2027-11-22"), D("2027-11-29"), D("2027-12-06")]);
  for (let k = 1; k < r.followups.schedule.length; k++) assert.equal(daysBetween(r.followups.schedule[k - 1]!, r.followups.schedule[k]!), 7);
  const radian = directClaimPackage({ ...given, insurer_code: "RADIAN", micp_participant: true, micp_effective: D("2021-10-18") });
  assert.equal(radian.filer, "fnma_micp"); assert.equal(radian.package, null); assert.deepEqual(radian.followups.schedule, []);
  assert.equal(filer({ micp_participant: true, micp_effective: D("2021-10-18"), liquidation_date: D("2021-10-01") }), "servicer_direct", "a liquidation before the effective date is direct-filed even for a participant");
  // on the bus: routing arms the 30-day clock; without an insurer adapter the filing is an operator task and nothing is `filed` yet
  const h = harness();
  const routed = await h.run("routeMiClaim", TRIAD);
  assert.equal(routed.filer, "servicer_direct"); assert.equal(routed.direct_file_due_at, "2027-11-04"); assert.equal(h.last("FNMA_F106_MI_DIRECT_FILE_30").dueDate, "2027-11-04");
  const filed = await h.run("fileDirectClaim", { ...TRIAD, today: "2027-10-25" });
  assert.equal(filed.status, "docs_pending"); assert.equal(filed.acknowledgment, null); assert.equal(filed.portal_task.kind, "human_portal_task"); assert.equal(filed.portal_task.ownerRole, "fnma_portal_operator");
  assert.equal(filed.portal_task.payload.payee_instruction, r.package!.payee_instruction); assert.equal(filed.portal_task.payload.due_at, "2027-11-04");
  assert.equal(h.ev("mi.claim.filed").length, 0, "no filing event before the insurer acknowledges"); assert.equal(h.timer("SM_MI_SETTLEMENT_FOLLOWUP_7").length, 0);
  await h.refused(h.run("fileDirectClaim", { ...TRIAD, payee: "Supermortgage LLC" }), "PAYEE_IS_FNMA");
  await h.refused(h.run("fileDirectClaim", { ...RADIAN }), "DIRECT_ONLY_FOR_NON_PARTICIPANTS");
  // the insurer's acknowledgment (Nov 1) makes it `filed`: the 30-day and 60-day clocks close and the weekly follow-up clock starts (Nov 8)
  await h.run("fileDirectClaim", { op: "record_acknowledgment", claim_id: "mic-L15", loan_id: "L15", acknowledgment_id: "TRIAD-ACK-1", filed_at: "2027-11-01", today: "2027-11-01" });
  assert.equal(h.store.get("mi_claims", "mic-L15")!.data.status, "filed"); assert.deepEqual(h.claimEvents("mic-L15").map((e) => e.kind), ["filed"]);
  assert.equal(h.last("FNMA_F106_MI_DIRECT_FILE_30").status, "satisfied"); assert.equal(h.last("MI_MP_CLAIM_FILE_60").status, "satisfied"); assert.equal(h.last("MI_MP_LATE_DENY_120").status, "satisfied");
  const first = h.last("SM_MI_SETTLEMENT_FOLLOWUP_7");
  assert.equal(first.dueDate, "2027-11-08"); assert.equal(first.anchorDate, "2027-11-01"); assert.equal(first.armedByEventId, h.ev("mi.claim.filed")[0]!.id);
  // the recurrence: a `recurring` row satisfied by the logged follow-up, re-anchored on the follow-up's own date every 7 calendar days
  const fdef = def("SM_MI_SETTLEMENT_FOLLOWUP_7");
  assert.equal(fdef.kindNorm, "recurring"); assert.match(fdef.offset, /every 7 calendar_days/); assert.equal(fdef.anchorField, "followup_from");
  assert.equal(fdef.satisfiedPattern!.type, "mi.claim.followup.logged"); assert.equal(fdef.triggerPattern!.type, "mi.claim.filed");
  // Nov 8: the follow-up logged closes the Nov 8 cycle (satisfied by the log event) and re-arms the next from its own date (Nov 15)
  const f1 = await h.run("fileDirectClaim", { op: "followup", claim_id: "mic-L15", loan_id: "L15", today: "2027-11-08", note: "called claims desk; documents under review" });
  const logged = h.ev("mi.claim.followup.logged")[0]!;
  assert.equal(eventMatches(fdef.satisfiedPattern!, logged), true, "the log event is what the registry's satisfied pattern names");
  assert.equal(logged.payload.route, "servicer_direct"); assert.equal(logged.payload.followup_from, "2027-11-08"); assert.equal(logged.payload.next_followup_on, "2027-11-15");
  assert.equal(first.status, "satisfied"); assert.equal(first.satisfiedByEventId, logged.id);
  assert.equal(h.ev("timer.satisfied").filter((e) => e.payload.code === "SM_MI_SETTLEMENT_FOLLOWUP_7").length, 1);
  assert.equal(f1.next_followup_on, "2027-11-15"); assert.equal(f1.timer.rearmed.due_date, "2027-11-15"); assert.equal(f1.timer.rearmed.anchor_date, "2027-11-08");
  assert.equal(h.last("SM_MI_SETTLEMENT_FOLLOWUP_7").dueDate, "2027-11-15"); assert.equal(h.last("SM_MI_SETTLEMENT_FOLLOWUP_7").status, "armed"); assert.equal(h.last("SM_MI_SETTLEMENT_FOLLOWUP_7").armedByEventId, logged.id);
  // Nov 15: the second cycle rolls the same way; a breached cycle closes as satisfied_late
  h.ctx.timers.evaluate("2027-11-16T12:00:00.000Z");
  assert.equal(h.last("SM_MI_SETTLEMENT_FOLLOWUP_7").status, "breached");
  await h.run("fileDirectClaim", { op: "followup", claim_id: "mic-L15", loan_id: "L15", today: "2027-11-16" });
  const cycles = h.timer("SM_MI_SETTLEMENT_FOLLOWUP_7");
  assert.deepEqual(cycles.map((t) => [t.dueDate, t.status]), [["2027-11-08", "satisfied"], ["2027-11-15", "satisfied_late"], ["2027-11-23", "armed"]]);
  assert.deepEqual(h.claimEvents("mic-L15").filter((e) => e.kind === "message").map((e) => [(e.payload as Out).direction, (e.payload as Out).on]), [["outbound", "2027-11-08"], ["outbound", "2027-11-16"]]);
  // 'until paid': the benefit received by Fannie Mae (Dec 13) ends the recurrence — the open cycle is cancelled, not rolled
  await h.run("computeShadowClaim", SHADOW_IN);
  await h.run("reconcileEob", { claim_id: "mic-L15", loan_id: "L15", eob_benefit_cents: 6_818_013n, paid_to: "fnma", received_on: "2027-12-13", today: "2027-12-13" });
  assert.equal(h.last("SM_MI_SETTLEMENT_FOLLOWUP_7").status, "cancelled"); assert.match(h.last("SM_MI_SETTLEMENT_FOLLOWUP_7").cancelledReason!, /weekly follow-ups end/);
  assert.equal((await h.run("fileDirectClaim", { op: "followup", claim_id: "mic-L15", loan_id: "L15", today: "2027-12-20" })).timer.rearmed, null, "no further cycle after payment");
});
test("15.3-T3: Given a Minnesota sale on Oct 5, 2027 with a six-month redemption (expiry Apr 5, 2028), then the direct-filing and expense anchors are Apr 5, 2028 (+30 → May 5, 2028) while the master-policy deadline for a MICP claim stays Dec 4, 2027 and documents are due Nov 19, 2027.", async () => {
  // Minnesota: six-month redemption after the Oct 5, 2027 sale → the F-1-06 direct-filing / expense anchor is the expiry, Apr 5, 2028
  const mn = miClaimClocks(D("2027-10-05"), D("2028-04-05"));
  assert.equal(mn.direct_file_due, D("2028-05-05")); assert.equal(daysBetween(D("2028-04-05"), mn.direct_file_due), 30);
  assert.equal(mn.claim_filing_deadline, D("2027-12-04")); assert.equal(mn.micp_docs_due, D("2027-11-19"));
  // 15.2's expense row (FNMA_F106_MI_EXPENSE_FINAL_30) counts from the same moved anchor, so the harness arms 15.2's rows too
  const h = harness("2027-10-06T14:00:00.000Z", "L15", ["15.3", "15.2"]);
  // a non-participant is direct-filed on the redemption anchor
  const direct = await h.run("routeMiClaim", { ...TRIAD, claim_id: "mic-L15-mn", liquidation_type: "redemption_expired", expense_anchor_date: "2028-04-05" });
  assert.equal(direct.filer, "servicer_direct"); assert.equal(direct.direct_file_anchor_date, "2028-04-05"); assert.equal(direct.direct_file_due_at, "2028-05-05");
  assert.equal(h.last("FNMA_F106_MI_DIRECT_FILE_30").dueDate, "2028-05-05"); assert.equal(h.last("FNMA_F106_MI_DIRECT_FILE_30").anchorDate, "2028-04-05");
  assert.equal(direct.claim_filing_deadline, "2027-12-04", "the master policy counts from the sale regardless of redemption");
  // the moved anchor is the milestone 15.2's final-expense row counts from: 30 days → May 5, 2028 (F-1-06 'within 30 days after the redemption period expiration')
  const milestone = h.ev("claim.milestone.reached")[0]!;
  assert.equal(milestone.payload.mi_insured, true); assert.equal(milestone.payload.milestone_date, "2028-04-05"); assert.equal(milestone.payload.legal_date, "2027-10-05"); assert.equal(milestone.payload.kind, "redemption_expired");
  assert.equal(eventMatches(def("FNMA_F106_MI_EXPENSE_FINAL_30").triggerPattern!, milestone), true);
  assert.equal(h.last("FNMA_F106_MI_EXPENSE_FINAL_30").dueDate, "2028-05-05"); assert.equal(h.last("FNMA_F106_MI_EXPENSE_FINAL_30").anchorDate, "2028-04-05"); assert.equal(h.last("FNMA_F106_MI_EXPENSE_FINAL_30").armedByEventId, milestone.id);
  // a MICP claim on the same sale keeps the sale-based master-policy deadline and the Nov 19 document date; its expense anchor moves the same way
  const micp = await h.run("routeMiClaim", { ...RADIAN, claim_id: "mic-L15-mn-radian", expense_anchor_date: "2028-04-05" });
  assert.equal(micp.filer, "fnma_micp"); assert.equal(micp.claim_filing_deadline, "2027-12-04"); assert.equal(micp.micp_docs_due_at, "2027-11-19");
  assert.equal(h.last("FNMA_F106_MICP_DOCS_10BD").dueDate, "2027-11-19"); assert.equal(h.last("MI_MP_CLAIM_FILE_60").dueDate, "2027-12-04");
  assert.equal(h.ev("claim.milestone.reached").length, 2); assert.equal(h.timer("FNMA_F106_MI_EXPENSE_FINAL_30").length, 2);
  // without a redemption the F-1-06 anchor is the sale itself — no separate milestone from 15.3 (15.2's sweep emits the sale milestone)
  await h.run("routeMiClaim", { ...RADIAN, claim_id: "mic-L15-plain" });
  assert.equal(h.ev("claim.milestone.reached").length, 2);
});
test("15.3-T4: Given the NOD was reported Jan 30, 2027 instead of by Jan 25, 2027 (second missed payment Jan 1), then the curtailment monitor projects 5 days of excluded interest ($213.26 at $42.6522/day) and the attribution is `servicer_caused`.", async () => {
  // master policy §53: the NOD is due by the 25th of the month in which the second consecutive missed payment (Jan 1, 2027) remains unpaid
  assert.equal(nodDueDate(D("2027-01-01")), D("2027-01-25"));
  const nod = nodLateness({ second_missed_payment_due: D("2027-01-01"), reported_on: D("2027-01-30"), upb_cents: 24_908_861n, note_rate_pct: "6.25" });
  assert.equal(nod.nod_due, D("2027-01-25")); assert.equal(nod.days, 5);
  assert.equal(nod.daily_rate_4dp, 426_522n);                                   // $42.6522/day = $249,088.61 × 6.25% ÷ 365
  assert.equal(nod.excluded_interest_cents, 21_326n);                            // 5 × $42.6522 = $213.26
  assert.equal(nod.attribution, "servicer_caused"); assert.equal(nod.timer, "MI_MP_NOD_25TH"); assert.equal(nod.breach, "sev1");
  assert.deepEqual([nodLateness({ ...nod, second_missed_payment_due: D("2027-01-01"), reported_on: D("2027-01-25"), upb_cents: 24_908_861n, note_rate_pct: "6.25" }).days, nodLateness({ second_missed_payment_due: D("2027-01-01"), reported_on: D("2027-01-25"), upb_cents: 24_908_861n, note_rate_pct: "6.25" }).attribution], [0, null]);
  // the default watch: first unpaid Dec 1, 2026 → second missed Jan 1, 2027 → NOD due Jan 25, first monthly update Feb 25, cap not-after Dec 1, 2029
  const start = miDefaultStart({ second_missed_payment_due: D("2027-01-01") });
  assert.deepEqual([start.first_unpaid_due_date, start.nod_due, start.report_due_on, start.first_status_due, start.interest_cap_not_after], [D("2026-12-01"), D("2027-01-25"), D("2027-01-25"), D("2027-02-25"), D("2029-12-01")]);
  assert.throws(() => miDefaultStart({ first_unpaid_due_date: D("2026-12-01"), second_missed_payment_due: D("2027-02-01") }), /consecutive/);
  // the insurer's acceptance record ingested: NOD due Jan 25, accepted Jan 30 → 5 days late, $213.26 excluded
  const ingested = ingestDefaultReports({ records: [{ kind: "nod", due_on: "2027-01-25", reported_on: "2027-01-30", accepted_on: "2027-01-30" }], upb_cents: 24_908_861n, note_rate_pct: "6.25" })[0]!;
  assert.deepEqual([ingested.late, ingested.days_late, ingested.excluded_interest_cents, ingested.accepted, ingested.period], [true, 5, 21_326n, true, "2027-01"]);
  assert.throws(() => ingestDefaultReports({ records: [{ kind: "nod", due_on: "2027-01-24" }], upb_cents: 1n, note_rate_pct: "6" }), /25th/);
  assert.throws(() => ingestDefaultReports({ records: [{ kind: "quarterly", due_on: "2027-01-25" }], upb_cents: 1n, note_rate_pct: "6" }), RangeError);
  // on the bus: the daily monitor observes the second consecutive missed payment unpaid (Jan 26) → `mi.default.started` arms the NOD, monthly-status and cap watches
  const h = harness("2027-01-26T14:00:00.000Z");
  const day1 = await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2027-01-26", second_missed_payment_due: "2027-01-01", insurer_code: "RADIAN", fcl_days_used: 0, fcl_days_allowable: 300, upb_cents: 24_908_861n, note_rate_pct: "6.25" });
  const started = h.ev("mi.default.started")[0]!;
  assert.equal(day1.default_started.nod_due, "2027-01-25"); assert.equal(started.payload.first_unpaid_due_date, "2026-12-01"); assert.equal(started.payload.missed_payments, 2);
  assert.equal(eventMatches(def("MI_MP_NOD_25TH").triggerPattern!, started), true); assert.equal(eventMatches(def("MI_MP_INTEREST_CAP_36M").triggerPattern!, started), true);
  assert.equal(h.last("MI_MP_NOD_25TH").dueDate, "2027-01-25"); assert.equal(h.last("MI_MP_NOD_25TH").anchorDate, "2027-01-01");
  assert.equal(h.last("MI_MP_STATUS_MONTHLY_25TH").dueDate, "2027-02-25", "the first monthly update is due one month after the NOD's due date");
  assert.equal(h.last("MI_MP_INTEREST_CAP_36M").anchorDate, "2026-12-01"); assert.equal(h.last("MI_MP_INTEREST_CAP_36M").note, "evaluator:15.3.interestWithinCap");
  assert.equal(day1.row.status_reports_current, false, "the NOD due Jan 25 is not accepted yet"); assert.equal(day1.status_gap, true);
  assert.equal((await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2027-01-27", second_missed_payment_due: "2027-01-01", fcl_days_used: 0, fcl_days_allowable: 300, upb_cents: 24_908_861n, note_rate_pct: "6.25" })).default_started, null, "the watch opens once");
  assert.deepEqual(h.ctx.timers.evaluate("2027-01-26T23:59:59.000Z").map((b) => [b.instance.code, b.severity]), [["MI_MP_NOD_25TH", 1]]);
  // Jan 30: the insurer accepts the NOD → the accepted record satisfies the (breached) NOD clock late; the row carries the 5-day lateness and its excluded interest
  const day5 = await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2027-01-30", fcl_days_used: 0, fcl_days_allowable: 300, upb_cents: 24_908_861n, note_rate_pct: "6.25", default_reports: [{ kind: "nod", due_on: "2027-01-25", reported_on: "2027-01-30", accepted_on: "2027-01-30", insurer_ref: "RAD-NOD-1" }] });
  const acceptedNod = h.ev("mi.default_report.accepted")[0]!;
  assert.equal(acceptedNod.payload.kind, "nod"); assert.equal(acceptedNod.payload.days_late, 5); assert.equal(acceptedNod.payload.excluded_interest_cents, 21_326n);
  assert.equal(eventMatches(def("MI_MP_NOD_25TH").satisfiedPattern!, acceptedNod), true);
  assert.equal(h.last("MI_MP_NOD_25TH").status, "satisfied_late"); assert.equal(h.last("MI_MP_NOD_25TH").satisfiedByEventId, acceptedNod.id);
  assert.equal(day5.row.nod_on_time, false); assert.equal(day5.nod_excluded_interest_cents, 21_326n); assert.equal(h.store.get("mi_curtailment_risk", "L15-2027-01-30")!.data.nod_on_time, false);
  assert.equal(day5.row.status_reports_current, true); assert.equal(h.store.get("mi_default_reports", "L15-nod-2027-01")!.data.accepted, true);
  assert.equal((await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2027-01-31", fcl_days_used: 0, fcl_days_allowable: 300, upb_cents: 24_908_861n, note_rate_pct: "6.25", default_reports: [{ kind: "nod", due_on: "2027-01-25", reported_on: "2027-01-30", accepted_on: "2027-01-30" }] })).accepted_reports.length, 0, "an acceptance is ingested once");
  // the shortfall it causes is servicer-caused (A1-3-02 exposure) — conceded only with the default-reporting timeline reviewed
  await h.refused(h.run("attributeShortfall", { claim_id: "mic-L15", loan_id: "L15", cause: "late_nod", amount_cents: nod.excluded_interest_cents, timeline_evidence_reviewed: false }), "NO_SERVICER_CAUSED_WITHOUT_TIMELINE_REVIEW");
  const a = await h.run("attributeShortfall", { claim_id: "mic-L15", loan_id: "L15", cause: "late_nod", amount_cents: nod.excluded_interest_cents, timeline_evidence_reviewed: true, timeline_evidence: { nod_due: "2027-01-25", accepted_on: "2027-01-30", insurer_ref: "RAD-NOD-1" } });
  assert.equal(a.attribution, "servicer_caused"); assert.equal(a.servicer_caused_shortfall_cents, 21_326n); assert.equal(a.exposure, "A1-3-02"); assert.equal(a.memo_account, "contingent_make_whole_fnma");
  assert.match(attributeShortfall({ cause: "late_nod", amount_cents: 21_326n, timeline_evidence_reviewed: false }).refusal!, /default-reporting timeline/);
});
test("15.3-T5: Given the foreclosure exceeded the state allowable time frame by 40 days with 25 days of documented bankruptcy delay, then `projected_excess_days = 15`, risk ≥ 0.6, and a diligence-evidence task opens for `foreclosure-ops`.", async () => {
  // 40 days over the state time frame, 25 of them documented bankruptcy delay → 15 excess days at $42.65/day
  const m = curtailmentMonitor({ nod_late_days: 0, fcl_days_used: 340, fcl_days_allowable: 300, allowable_delays: 25, interest_months: 11, property_condition_flags: 0, premium_gap: false, docs_ready: true, upb_cents: 24_908_861n, note_rate_pct: "6.25" });
  assert.equal(m.projected_excess_days, 15); assert.ok(m.score >= 0.6); assert.equal(m.diligence_task, true);
  assert.deepEqual(m.task, { owner: "foreclosure-ops", kind: "diligent_servicing_evidence" });
  assert.equal(m.daily_interest_at_risk_cents, 4_265n); assert.equal(m.excess_interest_at_risk_cents, 15n * 4_265n);
  assert.equal(curtailmentMonitor({ ...m, nod_late_days: 0, fcl_days_used: 320, fcl_days_allowable: 300, allowable_delays: 25, interest_months: 11, property_condition_flags: 0, premium_gap: false, docs_ready: true, upb_cents: 24_908_861n, note_rate_pct: "6.25" }).task, null, "within the allowable frame plus documented delays");
  // rule 5 also scores monthly status gaps: a missing status report for the cycle adds 0.2 (the shared calculator has no status term)
  const quiet = curtailmentMonitor({ nod_late_days: 0, fcl_days_used: 300, fcl_days_allowable: 300, allowable_delays: 0, interest_months: 11, property_condition_flags: 0, premium_gap: false, docs_ready: true, upb_cents: 24_908_861n, note_rate_pct: "6.25" });
  const gap = curtailmentMonitor({ nod_late_days: 0, fcl_days_used: 300, fcl_days_allowable: 300, allowable_delays: 0, interest_months: 11, property_condition_flags: 0, premium_gap: false, docs_ready: true, upb_cents: 24_908_861n, note_rate_pct: "6.25", status_reports_current: false });
  assert.equal(quiet.score, 0); assert.equal(gap.score, 0.2); assert.equal(gap.status_gap, true);
  const { row } = curtailmentRiskRow({ loan_id: "L15", as_of: D("2027-09-01"), nod_late_days: 0, status_reports_current: true, fcl_days_used: 340, fcl_days_allowable: 300, allowable_delays: 25, interest_months: 11, property_condition_flags: 0, docs_ready_pct: 100, premium_gap: false, upb_cents: 24_908_861n, note_rate_pct: "6.25" });
  assert.equal(row.projected_excess_days, 15); assert.equal(row.allowable_delays_days, 25); assert.equal(row.cap_months_remaining, 25); assert.ok(row.risk_score >= 0.6);
  // on the bus: the projection row is written and the diligence-evidence task opens for foreclosure-ops
  const h = harness();
  const r = await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2027-09-01", fcl_days_used: 340, fcl_days_allowable: 300, allowable_delays: 25, interest_months: 11, upb_cents: 24_908_861n, note_rate_pct: "6.25" });
  assert.equal(r.projected_excess_days, 15); assert.ok(r.score >= 0.6);
  assert.equal(h.store.get("mi_curtailment_risk", "L15-2027-09-01")!.data.risk_score, r.score);
  const task = h.escalations.opened.find((e) => e.ownerRole === "foreclosure-ops")!;
  assert.equal(task.kind, "human_agent"); assert.equal(task.payload.kind, "diligent_servicing_evidence"); assert.equal(task.payload.projected_excess_days, 15);
  assert.match(String(task.payload.reason), /despite diligent servicing/); assert.match(String(task.payload.reason), /A1-4\.2-02/);
  // a foreclosure-delay shortfall is conceded only after the timeline review, and not at all when diligence is evidenced
  await h.refused(h.run("attributeShortfall", { claim_id: "mic-L15", loan_id: "L15", cause: "foreclosure_delay", amount_cents: 15n * 4_265n, timeline_evidence_reviewed: false }), "NO_SERVICER_CAUSED_WITHOUT_TIMELINE_REVIEW");
  assert.equal((await h.run("attributeShortfall", { claim_id: "mic-L15", loan_id: "L15", cause: "foreclosure_delay", amount_cents: 15n * 4_265n, timeline_evidence_reviewed: true, diligence_evidenced: true })).attribution, "insurer_other");
});
test("15.3-T6: Given a MICP document request dated Nov 8 with Due Date Nov 15, then the task is due Nov 15 (earlier of Due Date and 5 BD = Nov 15) and breach escalates sev-1.", async () => {
  // request dated Mon Nov 8, 2027 with MICP Due Date Nov 15 → due Nov 15, the earlier of the Due Date and 5 BD. The spec's hand count puts 5 BD at
  // Nov 15 too; the engine skips Thu Nov 11 (Veterans Day, fannie_et) and puts 5 BD at Nov 16 — the earlier date, Nov 15, is unchanged.
  const req = { request_id: "REQ-1", doc_kind: "valuation", requested_on: D("2027-11-08"), micp_due_date: D("2027-11-15") };
  const open = trackDocRequests({ requests: [req], today: D("2027-11-10") })[0]!;
  assert.equal(open.due_at, D("2027-11-15")); assert.equal(open.status, "open"); assert.equal(open.breach, null); assert.equal(open.timer, "SM_MICP_DOC_REQUEST_DUE");
  assert.equal(trackDocRequests({ requests: [{ ...req, micp_due_date: D("2027-11-30") }], today: D("2027-11-10") })[0]!.due_at, D("2027-11-16"), "5 BD governs when the MICP Due Date is later (spec: Nov 15; Veterans Day makes it Nov 16)");
  const breached = trackDocRequests({ requests: [req], today: D("2027-11-16") })[0]!;
  assert.equal(breached.status, "breached"); assert.equal(breached.breach, "sev1");
  const late = trackDocRequests({ requests: [{ ...req, uploaded_on: D("2027-11-16") }], today: D("2027-11-16") })[0]!;
  assert.equal(late.status, "uploaded_late"); assert.equal(late.breach, "sev1", "a late upload keeps the sev-1 on record");
  assert.equal(trackDocRequests({ requests: [{ ...req, uploaded_on: D("2027-11-12") }], today: D("2027-11-16") })[0]!.breach, null);
  // on the bus: the observed request arms SM_MICP_DOC_REQUEST_DUE for Nov 15; past due → sev-1 escalation; the recorded upload satisfies (late)
  const h = harness();
  await h.run("routeMiClaim", RADIAN);
  const seen = await h.run("trackDocRequests", { claim_id: "mic-L15", today: "2027-11-10", requests: [{ request_id: "REQ-1", doc_kind: "valuation", requested_on: "2027-11-08", micp_due_date: "2027-11-15" }] });
  assert.equal(seen.requests[0].due_at, "2027-11-15"); assert.equal(h.last("SM_MICP_DOC_REQUEST_DUE").dueDate, "2027-11-15"); assert.equal(seen.breaches.length, 0);
  await h.run("trackDocRequests", { claim_id: "mic-L15", today: "2027-11-12", requests: [{ request_id: "REQ-1", doc_kind: "valuation", requested_on: "2027-11-08", micp_due_date: "2027-11-15" }] });
  assert.equal(h.ev("micp.document_request.observed").length, 1, "observed once per request id");
  assert.deepEqual(h.claimEvents("mic-L15").map((e) => [e.kind, e.micp_request_id]), [["doc_requested", "REQ-1"]]);
  assert.deepEqual(h.ctx.timers.evaluate("2027-11-16T12:00:00.000Z").map((b) => [b.instance.code, b.severity]).filter(([c]) => c === "SM_MICP_DOC_REQUEST_DUE"), [["SM_MICP_DOC_REQUEST_DUE", 1]]);
  assert.equal(h.last("SM_MICP_DOC_REQUEST_DUE").status, "breached");
  const past = await h.run("trackDocRequests", { claim_id: "mic-L15", today: "2027-11-16", requests: [{ request_id: "REQ-1", doc_kind: "valuation", requested_on: "2027-11-08", micp_due_date: "2027-11-15" }] });
  assert.equal(past.requests[0].status, "breached"); assert.equal(past.breaches.length, 1); assert.equal(past.breaches[0].kind, "sev1"); assert.equal(past.breaches[0].payload.micp_request_id, "REQ-1");
  await h.run("openPortalTask", { op: "record_result", claim_id: "mic-L15", task_type: "micp.doc_request.respond", micp_request_id: "REQ-1", uploaded_at: "2027-11-16" });
  assert.equal(h.ev("micp.document_request.fulfilled")[0]!.payload.late, true); assert.equal(h.last("SM_MICP_DOC_REQUEST_DUE").status, "satisfied_late");
  assert.deepEqual(h.claimEvents("mic-L15").map((e) => e.kind), ["doc_requested", "doc_uploaded"]);
  assert.equal(h.escalations.opened.filter((e) => e.kind === "sev1").length, 1, "one sev-1 per breached request");
  await assert.rejects(h.run("trackDocRequests", { claim_id: "mic-L15", requests: [{ request_id: "REQ-2" }] }), RangeError);
});
test(`15.3-T7: Given the EOB shows benefit $67,000.00 vs. shadow $68,180.13 with a curtailment "attorney fees over cap," then the variance ($1,180.13) is analyzed; because our fees were within the 3% cap, an appeal is drafted with the exhibit and invoices.`, async () => {
  // shadow $68,180.13 vs EOB $67,000.00: variance $1,180.13 (> $250) is analyzed; the "attorney fees over cap" curtailment contradicts our itemized calc
  const shadow = shadowClaimItemized(L15);
  const r = reconcileEob({ shadow, eob_benefit_cents: 6_700_000n, curtailments: [{ reason: "attorney fees over cap", amount_cents: 118_013n }] });
  assert.equal(r.variance_cents, 118_013n); assert.equal(r.analyze, true); assert.equal(r.attorney_within_cap, true);
  assert.ok(shadow.attorney_fees_costs_cents < shadow.attorney_cap_cents);                     // $2,865.00 < $7,472.66 (3% of UPB)
  assert.equal(r.curtailments[0]!.disputed, true); assert.match(r.curtailments[0]!.basis, /within the master policy §56\(e\) cap/);
  assert.equal(r.appeal!.draft, true); assert.equal(r.appeal!.amount_cents, 118_013n);
  assert.ok(r.appeal!.exhibits.includes("attorney_fee_cap_exhibit") && r.appeal!.exhibits.includes("attorney_invoices"));
  assert.equal(appealRouting({ reason: "curtailment", amount_cents: r.appeal!.amount_cents }).approval, "agent", "≤ $10,000: the agent files it");
  assert.equal(appealRouting({ reason: "curtailment", amount_cents: 1_500_000n }).approval, "human_agent");
  assert.equal(appealSubmissionCheck({ amount_cents: 1_500_000n, approval: "human_agent", status: "awaiting_human_agent_review", actor_is_reviewer: false }).allowed, false);
  assert.equal(appealSubmissionCheck({ amount_cents: 1_500_000n, approval: "human_agent", status: "approved", actor_is_reviewer: false }).allowed, true);
  // fees actually over the cap → accepted, no appeal; a plain (already clamped) calculator cannot verify the cap → not disputed
  const over = shadowClaimItemized({ ...L15, advances: [...L15_ADVANCES, { advance_id: "adv-atty-2", kind: "attorney_fee", amount_cents: 600_000n }] });
  const ro = reconcileEob({ shadow: over, eob_benefit_cents: 6_700_000n, curtailments: [{ reason: "attorney fees over cap", amount_cents: 118_013n }] });
  assert.equal(ro.attorney_within_cap, false); assert.equal(ro.curtailments[0]!.disputed, false); assert.equal(ro.appeal, null); assert.match(ro.curtailments[0]!.basis, /exceeded the cap/);
  const plain = reconcileEob({ shadow: shadowClaim({ upb_cents: 24_908_861n, note_rate_pct: "6.25", interest_paid_to: D("2026-11-01"), anchor: D("2027-10-05"), default_date: D("2026-12-01"), taxes_cents: 482_000n, hazard_cents: 145_000n, hazard_refund_cents: 65_945n, hoa_cents: 0n, preservation_inspection_cents: 71_500n, attorney_fees_costs_cents: 286_500n, credits_cents: 0n, coverage_pct: "25" }), eob_benefit_cents: 6_700_000n, curtailments: [{ reason: "attorney fees over cap", amount_cents: 118_013n }] });
  assert.equal(plain.attorney_within_cap, null); assert.equal(plain.curtailments[0]!.disputed, false); assert.match(plain.curtailments[0]!.basis, /cannot verify/);
  assert.equal(reconcileEob({ shadow, eob_benefit_cents: 6_800_000n, curtailments: [] }).analyze, false, "$180.13 and 0.26%: below both thresholds");
  // on the bus: the EOB is reconciled against the stored calc only (never an agent-supplied shadow), the insurer's decision arms the appeal window, the filed appeal closes it
  const h = harness("2027-12-20T14:00:00.000Z");
  await h.run("routeMiClaim", RADIAN);
  await assert.rejects(h.run("reconcileEob", { claim_id: "mic-L15", loan_id: "L15", shadow: { benefit_cents: 9_999_999n, attorney_cap_cents: 1n, attorney_fees_costs_cents: 0n }, eob_benefit_cents: 6_700_000n }), /run computeShadowClaim first/);
  await h.run("computeShadowClaim", SHADOW_IN);
  const out = await h.run("reconcileEob", { claim_id: "mic-L15", loan_id: "L15", shadow: { benefit_cents: 9_999_999n }, eob_benefit_cents: 6_700_000n, curtailments: [{ reason: "attorney fees over cap", amount_cents: 118_013n }], today: "2027-12-20" });
  assert.equal(out.variance_cents, 118_013n, "the stored calculation, not the input's figure, is reconciled"); assert.equal(out.shadow_calc_version, 1); assert.equal(out.appeal.draft, true); assert.equal(out.decision_outcome, "curtailment");
  assert.equal(h.ev("mi.claim.decision.received")[0]!.payload.outcome, "curtailment"); assert.equal(h.last("SM_MI_APPEAL_WINDOW").dueDate, "2028-01-19");
  assert.equal(h.store.get("mi_claims", "mic-L15")!.data.status, "curtailed"); assert.deepEqual(h.claimEvents("mic-L15").map((e) => e.kind), ["eob_received", "curtailed"]);
  const appeal = await h.run("draftAppeal", { claim_id: "mic-L15", loan_id: "L15", reason: "curtailment", amount_cents: 118_013n, exhibits: out.appeal.exhibits, basis: out.curtailments[0].basis, submit: true });
  assert.equal(appeal.approval, "agent"); assert.equal(appeal.status, "filed");
  assert.equal(h.ev("mi.claim.appeal.filed")[0]!.payload.amount_cents, 118_013n); assert.equal(h.last("SM_MI_APPEAL_WINDOW").status, "satisfied");
  assert.equal(h.claimEvents("mic-L15").at(-1)!.kind, "appealed");
  // over $10,000: the agent drafts, the human_agent reviewer approves — no path files it before that (submit, op=file, the operator's MICP result)
  await h.refused(h.run("draftAppeal", { claim_id: "mic-L15", reason: "curtailment", amount_cents: 1_500_000n, submit: true }), "APPEAL_OVER_10K_HUMAN_REVIEW");
  const big = await h.run("draftAppeal", { claim_id: "mic-L15", loan_id: "L15", reason: "curtailment", amount_cents: 1_500_000n, exhibits: ["timeline_exhibit"] });
  assert.equal(big.status, "awaiting_human_agent_review"); assert.equal(big.approval, "human_agent"); assert.equal(big.review_task.kind, "human_agent");
  await h.refused(h.run("openPortalTask", { op: "record_result", claim_id: "mic-L15", loan_id: "L15", task_type: "micp.appeal.submit", appeal_id: big.id }), "APPEAL_OVER_10K_HUMAN_REVIEW");
  await h.refused(h.run("draftAppeal", { op: "file", appeal_id: big.id, loan_id: "L15" }), "APPEAL_OVER_10K_HUMAN_REVIEW");
  await h.refused(h.run("draftAppeal", { op: "approve", appeal_id: big.id, loan_id: "L15" }), "APPEAL_APPROVAL_IS_HUMAN");
  assert.equal(h.store.get("mi_claim_appeals", big.id)!.data.status, "awaiting_human_agent_review"); assert.equal(h.ev("mi.claim.appeal.filed").length, 1, "nothing filed by the refused attempts");
  const approved = await h.run("draftAppeal", { op: "approve", appeal_id: big.id, loan_id: "L15" }, REVIEWER);
  assert.equal(approved.status, "approved"); assert.equal(approved.approved_by, "human:reviewer-1");
  const filedBig = await h.run("openPortalTask", { op: "record_result", claim_id: "mic-L15", loan_id: "L15", task_type: "micp.appeal.submit", appeal_id: big.id, submitted_at: "2027-12-21" });
  assert.equal(filedBig.filed_at, "2027-12-21"); assert.equal(h.ev("mi.claim.appeal.filed").at(-1)!.payload.approved_by, "human:reviewer-1");
  // rule 10: a rescission is the officer's repurchase path, not an appeal — unless rescission relief is evidenced, then the attorney reviews the dispute
  const resc = await h.run("draftAppeal", { claim_id: "mic-L15", loan_id: "L15", reason: "rescission", amount_cents: 500_000n });
  assert.equal(resc.kind, "officer");
  const relief = await h.run("draftAppeal", { claim_id: "mic-L15", loan_id: "L15", reason: "rescission", amount_cents: 500_000n, rescission_relief_evidenced: true });
  assert.equal(relief.attorney_review, true); assert.equal(relief.attorney_review_task.kind, "attorney"); assert.equal(relief.attorney_review_task.ownerRole, "attorney");
});
test("15.3-T8: Given a direct-filed claim perfected Dec 10, 2027 and unpaid on Feb 8, 2028 (60 days), then an `officer` escalation carries the perfected date, follow-up log and insurer responses.", async () => {
  // perfected Fri Dec 10, 2027 → Claim Settlement Period ends Feb 8, 2028 (60 days, master policy §1)
  const log = [{ on: D("2027-12-24"), note: "second follow-up" }, { on: D("2027-12-17"), note: "first follow-up" }];
  const responses = [{ on: D("2027-12-10"), response: "all required documents received" }, { on: D("2028-01-14"), response: "claim in final review" }];
  const notYet = unpaidClaimEscalation({ perfected_at: D("2027-12-10"), today: D("2028-02-07"), paid: false, followup_log: log, insurer_responses: responses });
  assert.equal(notYet.settlement_due_at, D("2028-02-08")); assert.equal(notYet.escalation, null);
  const e = unpaidClaimEscalation({ perfected_at: D("2027-12-10"), today: D("2028-02-08"), paid: false, followup_log: log, insurer_responses: responses }).escalation!;
  assert.equal(e.kind, "officer"); assert.equal(e.severity, "sev1"); assert.equal(e.timer, "MI_MP_SETTLEMENT_60");
  assert.equal(e.perfected_at, D("2027-12-10")); assert.equal(e.documentation_complete_date, D("2027-12-10")); assert.equal(e.settlement_due_at, D("2028-02-08")); assert.equal(e.days_past_due, 0);
  assert.deepEqual(e.followup_dates, [D("2027-12-17"), D("2027-12-24")]); assert.deepEqual(e.insurer_responses, responses);
  assert.match(e.reason, /A1-3-02/); assert.match(e.reason, /advance the claim amount/);
  assert.equal(unpaidClaimEscalation({ perfected_at: D("2027-12-10"), today: D("2028-02-08"), paid: true }).escalation, null);
  // on the bus (the settlement clock): the insurer's "documents complete" response perfects the direct claim → MI_MP_SETTLEMENT_60 due Feb 8, 2028;
  // paid to Fannie Mae → no custodial entry, the EOB is recorded, the claim closes and the clock is satisfied
  const h = harness();
  await h.run("routeMiClaim", TRIAD); await h.run("computeShadowClaim", SHADOW_IN);
  await h.run("fileDirectClaim", { op: "record_acknowledgment", claim_id: "mic-L15", loan_id: "L15", acknowledgment_id: "TRIAD-ACK-1", filed_at: "2027-11-01", today: "2027-11-01" });
  await h.run("fileDirectClaim", { op: "record_response", claim_id: "mic-L15", loan_id: "L15", today: "2027-12-10", response: "all required documents received", perfected_at: "2027-12-10" });
  assert.equal(h.ev("mi.claim.perfected")[0]!.payload.settlement_due_at, "2028-02-08"); assert.equal(h.last("MI_MP_SETTLEMENT_60").dueDate, "2028-02-08");
  assert.equal(h.store.get("mi_claims", "mic-L15")!.data.status, "perfected"); assert.deepEqual(h.claimEvents("mic-L15").map((x) => x.kind), ["filed", "message", "perfected"]);
  const paid = await h.run("reconcileEob", { claim_id: "mic-L15", loan_id: "L15", eob_benefit_cents: 6_818_013n, paid_to: "fnma", received_on: "2028-01-20", today: "2028-01-20" });
  assert.equal(paid.receipt.custodial_entry, false); assert.equal(paid.receipt.ledger, null); assert.equal(paid.receipt.next_status, "closed");
  assert.equal(h.ctx.ledger.sets().length, 0); assert.equal(h.ev("mi.claim.benefit_received")[0]!.payload.payee, "fnma");
  assert.equal(h.last("MI_MP_SETTLEMENT_60").status, "satisfied"); assert.equal(h.timer("SM_MI_PROCEEDS_REMIT_2BD").length, 0);
  assert.equal(h.store.get("mi_claims", "mic-L15")!.data.status, "closed"); assert.deepEqual(h.claimEvents("mic-L15").slice(-3).map((x) => x.kind), ["eob_received", "paid", "closed"]);
  // on the bus (the unpaid path): weekly follow-ups and insurer responses are logged (each follow-up rolls the weekly clock), and at settlement_due_at the daily
  // check escalates to the officer with the documentation-complete date, the follow-up dates and the responses; the settlement clock breaches sev-1 the day after
  const u = harness("2027-11-01T14:00:00.000Z");
  await u.run("routeMiClaim", TRIAD);
  await u.run("fileDirectClaim", { op: "record_acknowledgment", claim_id: "mic-L15", loan_id: "L15", acknowledgment_id: "TRIAD-ACK-1", filed_at: "2027-11-01", today: "2027-11-01" });
  await u.run("fileDirectClaim", { op: "record_response", claim_id: "mic-L15", loan_id: "L15", today: "2027-12-10", response: "all required documents received", perfected_at: "2027-12-10" });
  await u.run("fileDirectClaim", { op: "followup", claim_id: "mic-L15", loan_id: "L15", today: "2027-12-17", note: "first follow-up" });
  await u.run("fileDirectClaim", { op: "followup", claim_id: "mic-L15", loan_id: "L15", today: "2027-12-24", note: "second follow-up" });
  await u.run("fileDirectClaim", { op: "record_response", claim_id: "mic-L15", loan_id: "L15", today: "2028-01-14", response: "claim in final review" });
  assert.deepEqual(u.timer("SM_MI_SETTLEMENT_FOLLOWUP_7").map((t) => [t.dueDate, t.status]), [["2027-11-08", "satisfied"], ["2027-12-24", "satisfied"], ["2027-12-31", "armed"]]);
  assert.equal((await u.run("trackDocRequests", { claim_id: "mic-L15", today: "2028-02-07" })).unpaid_escalation, null);
  const esc = (await u.run("trackDocRequests", { claim_id: "mic-L15", today: "2028-02-08" })).unpaid_escalation;
  assert.equal(esc.kind, "officer"); assert.equal(esc.severity, "sev1"); assert.equal(esc.payload.timer, "MI_MP_SETTLEMENT_60");
  assert.equal(esc.payload.perfected_at, "2027-12-10"); assert.equal(esc.payload.documentation_complete_date, "2027-12-10"); assert.equal(esc.payload.settlement_due_at, "2028-02-08");
  assert.deepEqual(esc.payload.followup_dates, ["2027-12-17", "2027-12-24"]);
  assert.deepEqual(esc.payload.insurer_responses.map((x: { on: string; response: string }) => [x.on, x.response]), [["2027-12-10", "all required documents received"], ["2028-01-14", "claim in final review"]]);
  assert.match(String(esc.payload.reason), /advance the claim amount/);
  assert.equal(u.store.get("mi_claims", "mic-L15")!.data.status, "advance_demand_risk");
  assert.equal((await u.run("trackDocRequests", { claim_id: "mic-L15", today: "2028-02-09" })).unpaid_escalation, null, "escalated once");
  const breaches = u.ctx.timers.evaluate("2028-02-09T12:00:00.000Z");
  assert.deepEqual(breaches.filter((b) => b.instance.code === "MI_MP_SETTLEMENT_60").map((b) => [b.severity, b.breachText]), [[1, def("MI_MP_SETTLEMENT_60").breach]]);
  assert.match(def("MI_MP_SETTLEMENT_60").breach, /A1-3-02/);
});
test("15.3-T9: Given a benefit wire of $68,180.13 lands in the servicer's clearing account on Jan 5, 2028, then a special remittance is instructed by Jan 7, 2028 and no netting occurs.", async () => {
  // Wed Jan 5, 2028 receipt → special remittance instructed within 2 fannie_et BD = Fri Jan 7, 2028; the full benefit, never netted
  const r = benefitReceipt({ claim_id: "mic-L15", loan_id: "L15", amount_cents: 6_818_013n, received_on: D("2028-01-05"), payee: "servicer", custodial_account_id: "cust-clearing-1" });
  assert.equal(r.remit_by, D("2028-01-07")); assert.equal(r.timer, "SM_MI_PROCEEDS_REMIT_2BD"); assert.equal(r.custodial_entry, true); assert.equal(r.next_status, "remit_pending");
  assert.deepEqual(r.remittance, { kind: "special", crs_code: "316", crs_code_verified: false, payee: "Fannie Mae", amount_cents: 6_818_013n });
  assert.equal(r.netting_allowed, false); assert.equal(r.refusal, null);
  // Dr custodial/clearing Cr fnma_remittance_payable — balanced, every line with the rule_ref; the credit sits on the custodial liability the 5.2 CRS draft debits
  const lines = r.ledger!.lines;
  assert.equal(lines.reduce((s, l) => s + l.amountCents, 0n), 0n);
  assert.deepEqual(lines.map((l) => [l.account.scope, l.account.account, l.amountCents]), [["custodial", "clearing_cash", 6_818_013n], ["custodial", "fnma_remittance_payable", -6_818_013n]]);
  assert.ok(lines.every((l) => l.ruleRef === MI_BENEFIT_REMIT_RULE)); assert.match(lines[1]!.memo!, /never netted/);
  assert.match(benefitReceipt({ claim_id: "mic-L15", loan_id: "L15", amount_cents: 6_818_013n, received_on: D("2028-01-05"), payee: "servicer", net_against_advances: true }).refusal!, /never netted against advances/);
  // the CRS confirmation is validated against what was drafted before the clock closes: same code, the full amount
  assert.equal(remittanceSettlement({ drafted: { crs_code: "316", amount_cents: 6_818_013n }, remit_by: D("2028-01-07"), code: "316", amount_cents: 6_818_013n, settled_on: D("2028-01-07") }).on_time, true);
  assert.throws(() => remittanceSettlement({ drafted: { crs_code: "316", amount_cents: 6_818_013n }, remit_by: D("2028-01-07"), code: "316", amount_cents: 6_000_000n, settled_on: D("2028-01-07") }), /never netted/);
  // on the bus: the receipt posts the set, drafts the special remittance, arms the 2 BD clock; netting is refused; the recorded CRS settlement closes it
  const h = harness("2028-01-05T15:00:00.000Z");
  await h.run("routeMiClaim", TRIAD); await h.run("computeShadowClaim", SHADOW_IN);
  await h.refused(h.run("reconcileEob", { claim_id: "mic-L15", loan_id: "L15", eob_benefit_cents: 6_818_013n, paid_to: "servicer", received_on: "2028-01-05", net_against_advances: true }), "NEVER_NET_PROCEEDS");
  assert.equal(h.ctx.ledger.sets().length, 0, "a refused command posts nothing");
  await assert.rejects(h.run("reconcileEob", { op: "record_remittance", claim_id: "mic-L15", loan_id: "L15", code: "316", amount_cents: 6_818_013n, settled_on: "2028-01-06" }), /no special remittance was drafted/);
  const out = await h.run("reconcileEob", { claim_id: "mic-L15", loan_id: "L15", eob_benefit_cents: 6_818_013n, paid_to: "servicer", received_on: "2028-01-05", custodial_account_id: "cust-clearing-1" });
  assert.equal(out.receipt.remit_by, "2028-01-07");
  const set = h.ctx.ledger.sets()[0]!;
  assert.equal(set.lines.length, 2); assert.equal(set.lines.reduce((s, l) => s + l.amountCents, 0n), 0n); assert.equal(set.effectiveDate, "2028-01-05");
  assert.equal(h.ctx.ledger.balance({ scope: "custodial", custodialAccountId: "cust-clearing-1", account: "fnma_remittance_payable" as never }), -6_818_013n);
  const received = h.ev("mi.claim.benefit_received")[0]!.payload;
  assert.equal(received.payee, "servicer"); assert.equal(received.amount_cents, 6_818_013n); assert.equal(received.remit_by, "2028-01-07");
  const drafted = h.ev("remittance.special.drafted")[0]!.payload;
  assert.equal(drafted.kind, "mi_benefit"); assert.equal(drafted.code, "316"); assert.equal(drafted.amount_cents, 6_818_013n); assert.equal(drafted.netted, false); assert.equal(drafted.ledger_set_id, set.id);
  assert.equal(h.last("SM_MI_PROCEEDS_REMIT_2BD").dueDate, "2028-01-07"); assert.equal(h.last("SM_MI_PROCEEDS_REMIT_2BD").anchorDate, "2028-01-05");
  assert.equal(h.store.get("mi_claims", "mic-L15")!.data.status, "remit_pending"); assert.equal(h.claimEvents("mic-L15").at(-1)!.kind, "paid");
  // a netted settlement (short amount) is refused; the CRS confirmation for the full amount settles the special remittance and closes the 2 BD clock
  await assert.rejects(h.run("reconcileEob", { op: "record_remittance", claim_id: "mic-L15", loan_id: "L15", code: "316", amount_cents: 6_000_000n, settled_on: "2028-01-07" }), /never netted/);
  assert.equal(h.last("SM_MI_PROCEEDS_REMIT_2BD").status, "armed");
  const settled = await h.run("reconcileEob", { op: "record_remittance", claim_id: "mic-L15", loan_id: "L15", code: "316", amount_cents: 6_818_013n, settled_on: "2028-01-07", confirmation_id: "CRS-2028-0107-316" });
  assert.equal(settled.on_time, true); assert.equal(settled.status, "closed");
  const settledEvent = h.ev("remittance.special.settled")[0]!;
  assert.deepEqual([settledEvent.payload.code, settledEvent.payload.kind, settledEvent.payload.amount_cents, settledEvent.payload.settled_on], ["316", "mi_benefit", 6_818_013n, "2028-01-07"]);
  assert.equal(eventMatches(def("SM_MI_PROCEEDS_REMIT_2BD").satisfiedPattern!, settledEvent), true);
  assert.equal(h.last("SM_MI_PROCEEDS_REMIT_2BD").status, "satisfied"); assert.equal(h.last("SM_MI_PROCEEDS_REMIT_2BD").satisfiedByEventId, settledEvent.id);
  assert.equal(h.store.get("mi_claims", "mic-L15")!.data.status, "closed"); assert.equal(h.claimEvents("mic-L15").at(-1)!.kind, "closed");
});
test("15.3-T10: Given servicer-counsel eviction costs of $1,200 paid Nov 30, 2027, then a supplemental package is uploaded by Dec 20, 2027 (90-day window Jan 3, 2028 − 10 BD).", async () => {
  // anchor Oct 5, 2027 + 90 = Jan 3, 2028; MICP loans upload 10 fannie_et BD earlier. The spec's hand count says Dec 20, 2027; counting back from
  // Jan 3 the engine skips Fri Dec 31 (New Year's Day 2028 observed) and Fri Dec 24 (Christmas observed) and lands on Thu Dec 16, 2027 — asserted as computed.
  const plan = supplementalClaimPlan({ claim_anchor_date: D("2027-10-05"), route: "fnma_micp", post_claim_advances: [{ advance_id: "adv-evict", kind: "eviction_cost", amount_cents: 120_000n, paid_on: D("2027-11-30") }] });
  assert.equal(plan.supplemental_due_at, D("2028-01-03")); assert.equal(daysBetween(D("2027-10-05"), plan.supplemental_due_at), 90);
  assert.equal(plan.upload_by, D("2027-12-16"));                                  // spec: Dec 20 (no holidays counted); engine: Dec 16 (Dec 24 and Dec 31 observed)
  assert.equal(plan.needed, true); assert.equal(plan.amount_cents, 120_000n); assert.equal(plan.result, "filed_by_fnma_from_upload"); assert.equal(plan.timer, "MI_MP_SUPPLEMENTAL_90");
  assert.deepEqual(plan.documents, ["eviction_costs"]); assert.match(plan.items[0]!.cap_reason!, /E-4\.3-04/);
  assert.equal(supplementalClaimPlan({ ...plan, claim_anchor_date: D("2027-10-05"), route: "servicer_direct", post_claim_advances: [{ advance_id: "adv-evict", kind: "eviction_cost", amount_cents: 120_000n, paid_on: D("2027-11-30") }] }).upload_by, D("2028-01-03"), "a direct filer files with the insurer by the window end");
  // "none needed" is a finding: only once the advances ledger is swept through the upload-by date
  assert.equal(supplementalClaimPlan({ claim_anchor_date: D("2027-10-05"), route: "fnma_micp", post_claim_advances: [] }).result, "pending_sweep");
  assert.equal(supplementalClaimPlan({ claim_anchor_date: D("2027-10-05"), route: "fnma_micp", post_claim_advances: [], advances_swept_through: D("2027-12-15") }).result, "pending_sweep");
  assert.equal(supplementalClaimPlan({ claim_anchor_date: D("2027-10-05"), route: "fnma_micp", post_claim_advances: [], advances_swept_through: D("2027-12-16") }).result, "none_needed");
  // on the bus: the liquidation fact arms the 90-day clock; the supplemental package is planned, its recorded upload closes the clock
  const h = harness();
  await h.run("routeMiClaim", RADIAN);
  assert.equal(h.last("MI_MP_SUPPLEMENTAL_90").dueDate, "2028-01-03"); assert.equal(h.last("MI_MP_SUPPLEMENTAL_90").armedByEventId, h.ev("mi_claims.opened")[0]!.id);
  const pkg = await h.run("assembleMiPackage", { kind: "supplemental", claim_id: "mic-L15", loan_id: "L15", liquidation_type: "fcl_fnma", route: "fnma_micp", post_claim_advances: [{ advance_id: "adv-evict", kind: "eviction_cost", amount_cents: 120_000n, paid_on: "2027-11-30" }], documents: [{ id: "inv-evict", doc_kind: "eviction_costs", sha256: "e1" }] });
  assert.equal(pkg.upload_by, "2027-12-16"); assert.equal(pkg.complete, true); assert.equal(h.store.get("mi_claims", "mic-L15")!.data.supplemental_upload_by, "2027-12-16");
  await h.run("openPortalTask", { op: "record_result", claim_id: "mic-L15", task_type: "micp.docs.upload", package_id: h.store.list("mi_claim_packages", (d) => d.kind === "supplemental")[0]!.id, uploaded_at: "2027-12-16" });
  assert.deepEqual(h.ev("mi.claim.supplemental.closed").map((e) => [e.payload.result, e.payload.amount_cents]), [["filed", 120_000n]]);
  assert.equal(h.last("MI_MP_SUPPLEMENTAL_90").status, "satisfied");
  assert.deepEqual(h.claimEvents("mic-L15").map((e) => [e.kind, e.amount_cents]), [["supplemental_filed", 120_000n]]);
  // another claim with no post-claim advances: the clock stays open until the advances ledger is swept through upload-by — then "none needed" closes it
  await h.run("routeMiClaim", { ...RADIAN, claim_id: "mic-L15-b" });
  const early = await h.run("assembleMiPackage", { kind: "supplemental", claim_id: "mic-L15-b", loan_id: "L15", liquidation_type: "fcl_fnma", route: "fnma_micp", post_claim_advances: [], today: "2027-10-06" });
  assert.equal(early.result, "pending_sweep"); assert.equal(h.last("MI_MP_SUPPLEMENTAL_90").status, "armed", "day 1 cannot close the 90-day window");
  await h.run("assembleMiPackage", { kind: "supplemental", claim_id: "mic-L15-b", loan_id: "L15", liquidation_type: "fcl_fnma", route: "fnma_micp", post_claim_advances: [], advances_swept_through: "2027-12-16" });
  assert.equal(h.ev("mi.claim.supplemental.closed").at(-1)!.payload.result, "none_needed"); assert.equal(h.last("MI_MP_SUPPLEMENTAL_90").status, "satisfied");
});
test('15.3-T11: Given the REOgram MI company field shows "Essent" while `mi_policies` says Radian, then a correction is submitted within 1 BD and the claim routing is re-evaluated.', async () => {
  // mi_policies says Radian, the REOgram MI company field shows Essent: found Thu Oct 7, 2027 → correction due Fri Oct 8 (1 fannie_et BD)
  const c = validateInsurerIdentity({ policy_insurer_code: "RADIAN", reogram_insurer_code: "Essent", micp_insurer_code: null, found_on: D("2027-10-07") });
  assert.equal(c.mismatch, true); assert.equal(c.correction_due_at, D("2027-10-08")); assert.equal(c.timer, "FNMA_E4501_MICP_DATA_CORRECTION_1BD"); assert.equal(c.breach, "sev2");
  assert.deepEqual(c.sources.map((s) => [s.source, s.insurer_code, s.agrees]), [["mi_policies", "RADIAN", true], ["reogram", "ESSENT", false], ["micp", null, true]]);
  assert.deepEqual(c.correction_targets, ["reogram"]); assert.match(c.refusal!, /re-evaluate the routing/);
  assert.equal(validateInsurerIdentity({ policy_insurer_code: "RADIAN", reogram_insurer_code: "radian", micp_insurer_code: "RADIAN", found_on: D("2027-10-07") }).mismatch, false);
  // on the bus: the mismatch opens the correction task and arms the 1 BD clock; the routing waits and cannot be forced — but the liquidation fact has
  // already opened the claim, so the master-policy clocks (sale-based, §64(b) 'regardless of') run through the hold
  const h = harness("2027-10-07T14:00:00.000Z");
  const pending = await h.run("routeMiClaim", { ...RADIAN, reogram_insurer_code: "Essent", today: "2027-10-07" });
  assert.equal(pending.status, "data_correction_pending"); assert.equal(pending.filer, null); assert.equal(pending.correction_due_at, "2027-10-08");
  assert.equal(pending.correction_task.kind, "human_portal_task"); assert.equal(pending.correction_task.ownerRole, "fnma_portal_operator"); assert.equal(pending.correction_task.payload.due_at, "2027-10-08");
  assert.deepEqual(pending.correction_task.payload.correction.to, "RADIAN");
  assert.equal(h.ev("mi_claims.data_mismatch.detected").length, 1); assert.equal(h.ev("mi_claims.routed").length, 0); assert.equal(h.ev("mi_claims.opened").length, 1);
  assert.equal(h.last("FNMA_E4501_MICP_DATA_CORRECTION_1BD").dueDate, "2027-10-08");
  assert.equal(h.last("MI_MP_CLAIM_FILE_60").dueDate, "2027-12-04"); assert.equal(h.last("MI_MP_LATE_DENY_120").dueDate, "2028-02-02"); assert.equal(h.last("MI_MP_SUPPLEMENTAL_90").dueDate, "2028-01-03");
  assert.equal(h.timer("FNMA_F106_MICP_DOCS_10BD").length, 0, "the route-dependent document clock waits for the routing");
  await h.refused(h.run("routeMiClaim", { ...RADIAN, reogram_insurer_code: "Essent", force_route: true }), "ROUTE_PAST_UNRESOLVED_MISMATCH");
  // the correction is submitted on Oct 8 (REOgram MI field edited to Radian) → the clock closes and the routing is re-evaluated: Radian → fnma_micp
  const routed = await h.run("routeMiClaim", { ...RADIAN, reogram_insurer_code: "Radian", correction_submitted_on: "2027-10-08", today: "2027-10-08" });
  const corr = h.ev("mi_claims.data_correction.submitted")[0]!.payload;
  assert.equal(corr.submitted_on, "2027-10-08"); assert.equal(corr.correction_due_at, "2027-10-08"); assert.equal(corr.on_time, true);
  assert.equal(h.last("FNMA_E4501_MICP_DATA_CORRECTION_1BD").status, "satisfied");
  assert.equal(routed.status, "routed"); assert.equal(routed.filer, "fnma_micp"); assert.equal(routed.re_evaluated, true);
  assert.equal(h.ev("mi_claims.routed")[0]!.payload.re_evaluated, true); assert.equal(h.last("FNMA_F106_MICP_DOCS_10BD").dueDate, "2027-11-19");
  assert.equal(h.ev("mi_claims.opened").length, 1, "the claim was opened once"); assert.equal(h.timer("MI_MP_CLAIM_FILE_60").length, 1);
  // had the policy really been Essent (participant since Oct 1, 2021) the routing would also be fnma_micp; a run-off insurer would flip it to servicer_direct
  assert.equal(filer({ micp_participant: true, micp_effective: D("2021-10-01"), liquidation_date: D("2027-10-05") }), "fnma_micp");
  assert.equal(filer({ micp_participant: false, micp_effective: null, liquidation_date: D("2027-10-05") }), "servicer_direct");
});
test("15.3-T12: Given interest accrual reaches 30 months on an unresolved judicial foreclosure, then an `officer` briefing is generated with the cap date and projected uninsured interest.", async () => {
  // L15 in a judicial state: interest accrues from Nov 1, 2026 (first unpaid due date Dec 1, 2026); 30 months later (May 1, 2029) the foreclosure is
  // still unresolved, sale projected Feb 1, 2030. The master policy covers 36 accrual months (paid-to + 36 = Nov 1, 2029 — the 36 unpaid installments
  // Dec 1, 2026 … Nov 1, 2029); the registry anchors MI_MP_INTEREST_CAP_36M on the first unpaid due date + 36 months = Dec 1, 2029, the first
  // uninsured installment — one month apart by construction, both reported.
  const given = { accrual_from: D("2026-11-01"), default_date: D("2026-12-01"), as_of: D("2029-05-01"), upb_cents: 24_908_861n, note_rate_pct: "6.25", resolved: false, judicial: true, projected_resolution_on: D("2030-02-01") };
  const w = interestCapWatch(given);
  assert.equal(w.months_accrued, 30); assert.equal(w.cap_date, D("2029-11-01")); assert.equal(w.timer_not_after, D("2029-12-01")); assert.equal(w.cap_months_remaining, 6);
  const b = w.briefing!;
  assert.equal(b.kind, "officer"); assert.equal(b.timer, "MI_MP_INTEREST_CAP_36M"); assert.equal(b.cap_date, D("2029-11-01")); assert.equal(b.timer_not_after, D("2029-12-01"));
  assert.equal(b.monthly_interest_cents, monthlyInterest(24_908_861n, ratePercent("6.25")));
  assert.equal(b.projected_uninsured_months, 3, "Nov 1, 2029 cap → Feb 1, 2030 projected sale");
  assert.equal(b.projected_uninsured_interest_cents, 3n * b.monthly_interest_cents);
  assert.match(b.reason, /30 months/); assert.match(b.reason, /judicial/); assert.match(b.reason, /2029-11-01/); assert.match(b.reason, /2029-12-01/);
  // no briefing at 29 months, and none once the foreclosure resolves
  assert.equal(interestCapWatch({ ...given, as_of: D("2029-04-30") }).months_accrued, 29);
  assert.equal(interestCapWatch({ ...given, as_of: D("2029-04-30") }).briefing, null);
  assert.equal(interestCapWatch({ ...given, resolved: true }).briefing, null);
  // past the cap the remaining months are 0 and every further month is uninsured
  const late = interestCapWatch({ ...given, as_of: D("2030-01-01") });
  assert.equal(late.cap_months_remaining, 0); assert.equal(late.briefing!.projected_uninsured_months, 3);
  // the not_after gate the registry row carries ('Satisfied by —'): open through Nov 1, 2029, closed from the first uninsured installment Dec 1, 2029
  const facts = interestCapFacts({ first_unpaid_due_date: D("2026-12-01"), interest_to: D("2029-11-01") });
  assert.equal(facts.not_after, D("2029-12-01")); assert.equal(evaluateGate("15.3.interestWithinCap", facts).open, true);
  const closed = evaluateGate("15.3.interestWithinCap", interestCapFacts({ first_unpaid_due_date: D("2026-12-01"), interest_to: D("2029-12-01") }));
  assert.equal(closed.open, false); assert.match(closed.reason!, /36-month cap/); assert.match(closed.reason!, /2029-12-01/);
  assert.equal(def("MI_MP_INTEREST_CAP_36M").offsetParsed.kind, "evaluator"); assert.equal(def("MI_MP_INTEREST_CAP_36M").anchorField, "first_unpaid_due_date");
  // on the bus: the daily monitor at 30 months opens the officer briefing carrying both dates and the projected uninsured interest; the default watch it
  // opened arms MI_MP_INTEREST_CAP_36M on the first unpaid due date with the evaluator, still open on May 1, 2029
  const h = harness("2029-05-01T12:00:00.000Z");
  const r = await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2029-05-01", accrual_from: "2026-11-01", default_date: "2026-12-01", judicial: true, projected_resolution_on: "2030-02-01", fcl_days_used: 900, fcl_days_allowable: 600, allowable_delays: 200, upb_cents: 24_908_861n, note_rate_pct: "6.25" });
  assert.equal(r.interest_cap.months_accrued, 30); assert.equal(r.officer_briefing.kind, "officer");
  assert.equal(r.officer_briefing.payload.cap_date, "2029-11-01"); assert.equal(r.officer_briefing.payload.timer_not_after, "2029-12-01");
  assert.equal(r.officer_briefing.payload.projected_uninsured_interest_cents, 3n * monthlyInterest(24_908_861n, ratePercent("6.25")));
  assert.equal(r.row.interest_months_accrued, 30); assert.equal(r.row.cap_months_remaining, 6);
  assert.equal(h.ev("mi.default.started")[0]!.payload.interest_cap_not_after, "2029-12-01");
  assert.equal(h.last("MI_MP_INTEREST_CAP_36M").anchorDate, "2026-12-01"); assert.equal(h.last("MI_MP_INTEREST_CAP_36M").note, "evaluator:15.3.interestWithinCap"); assert.equal(h.last("MI_MP_INTEREST_CAP_36M").status, "armed");
  assert.equal(r.interest_cap_gate.open, true); assert.equal(r.interest_cap_gate.not_after, "2029-12-01"); assert.equal(r.row.interest_cap_open, true);
  assert.equal((await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2029-04-30", accrual_from: "2026-11-01", judicial: true, fcl_days_used: 900, fcl_days_allowable: 600, allowable_delays: 200, upb_cents: 24_908_861n, note_rate_pct: "6.25" })).officer_briefing, null);
  // past the cap the monitor reports the gate closed and the shadow calc caps the interest it claims (37 months → 36)
  assert.equal((await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2029-12-01", accrual_from: "2026-11-01", judicial: true, fcl_days_used: 900, fcl_days_allowable: 600, allowable_delays: 200, upb_cents: 24_908_861n, note_rate_pct: "6.25" })).interest_cap_gate.open, false);
  await h.run("routeMiClaim", { ...RADIAN, liquidation_date: "2029-12-01", claim_anchor_date: "2029-12-01" });
  const capped = await h.run("computeShadowClaim", { ...SHADOW_IN, anchor: "2029-12-01" });
  assert.equal(capped.interest_months, 36); assert.equal(capped.interest_months_capped, true); assert.equal(capped.interest_to, "2029-11-01"); assert.equal(capped.interest_cap_gate.open, false);
  assert.equal(capped.interest_cents, 36n * monthlyInterest(24_908_861n, ratePercent("6.25")));
});

test("15.3 default-reporting and premium gates on the bus: MI_MP_STATUS_MONTHLY_25TH rolls on each accepted monthly status and ends when the loan leaves default; SM_MI_PREMIUM_PAID_THROUGH_GATE arms on the scheduled sale and flags the sale package when premium_paid_through < the liquidation month", async () => {
  const h = harness("2027-02-26T14:00:00.000Z");
  // the watch opened on Jan 26 (second missed payment Jan 1): NOD accepted on time Jan 22; the monthly status due Feb 25 accepted Feb 26 (late)
  await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2027-01-26", second_missed_payment_due: "2027-01-01", insurer_code: "RADIAN", fcl_days_used: 0, fcl_days_allowable: 300, upb_cents: 24_908_861n, note_rate_pct: "6.25", default_reports: [{ kind: "nod", due_on: "2027-01-25", reported_on: "2027-01-22", accepted_on: "2027-01-22" }] });
  assert.equal(h.last("MI_MP_NOD_25TH").status, "satisfied"); assert.equal(h.ev("mi.default_report.accepted")[0]!.payload.days_late, 0);
  const cycle1 = h.last("MI_MP_STATUS_MONTHLY_25TH");
  assert.equal(cycle1.dueDate, "2027-02-25"); assert.equal(def("MI_MP_STATUS_MONTHLY_25TH").kindNorm, "recurring");
  assert.deepEqual(h.ctx.timers.evaluate("2027-02-26T12:00:00.000Z").map((b) => [b.instance.code, b.severity]), [["MI_MP_STATUS_MONTHLY_25TH", 2]]);
  const feb = await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2027-02-26", fcl_days_used: 0, fcl_days_allowable: 300, upb_cents: 24_908_861n, note_rate_pct: "6.25", default_reports: [{ kind: "monthly_status", due_on: "2027-02-25", reported_on: "2027-02-26", accepted_on: "2027-02-26" }] });
  const febAccepted = h.ev("mi.default_report.accepted").at(-1)!;
  assert.equal(febAccepted.payload.kind, "monthly_status"); assert.equal(eventMatches(def("MI_MP_STATUS_MONTHLY_25TH").satisfiedPattern!, febAccepted), true);
  assert.equal(cycle1.status, "satisfied_late"); assert.equal(cycle1.satisfiedByEventId, febAccepted.id);
  assert.deepEqual(feb.status_cycles[0].closed, [{ id: cycle1.id, status: "satisfied_late" }]); assert.equal(feb.status_cycles[0].rearmed.due_date, "2027-03-25");
  assert.equal(h.last("MI_MP_STATUS_MONTHLY_25TH").dueDate, "2027-03-25"); assert.equal(h.last("MI_MP_STATUS_MONTHLY_25TH").anchorDate, "2027-02-25"); assert.equal(h.last("MI_MP_STATUS_MONTHLY_25TH").armedByEventId, febAccepted.id);
  assert.equal(feb.row.status_reports_current, true);
  // 13.x schedules the sale for Apr 20, 2027 while the premium is paid only through Mar 31 → the gate arms on the observed sale, closes, the package is flagged to pmi
  const mar = await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2027-03-10", fcl_days_used: 0, fcl_days_allowable: 300, upb_cents: 24_908_861n, note_rate_pct: "6.25", scheduled_sale_date: "2027-04-20", premium_paid_through: "2027-03-31" });
  const scheduled = h.ev("foreclosure.sale.scheduled")[0]!;
  assert.equal(scheduled.payload.mi_insured, true); assert.equal(scheduled.payload.scheduled_sale_date, "2027-04-20"); assert.equal(eventMatches(def("SM_MI_PREMIUM_PAID_THROUGH_GATE").triggerPattern!, scheduled), true);
  assert.equal(h.last("SM_MI_PREMIUM_PAID_THROUGH_GATE").note, "evaluator:15.3.premiumPaidThroughLiquidationMonth"); assert.equal(h.last("SM_MI_PREMIUM_PAID_THROUGH_GATE").status, "armed");
  assert.equal(mar.sale_gate.open, false); assert.match(mar.sale_gate.reason, /paid through 2027-03 is before the liquidation month 2027-04/); assert.equal(mar.row.premium_gap, undefined); assert.equal(h.ev("mi_curtailment_risk.projected").at(-1)!.payload.premium_gap, true);
  assert.equal(mar.sale_gate.flag.kind, "sev2"); assert.equal(mar.sale_gate.flag.ownerRole, "pmi"); assert.match(String(mar.sale_gate.flag.payload.action), /advance the MI renewal premium/);
  assert.equal(mar.score, 0.2, "the premium gap raises the curtailment score");
  assert.equal((await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2027-03-11", fcl_days_used: 0, fcl_days_allowable: 300, upb_cents: 24_908_861n, note_rate_pct: "6.25", scheduled_sale_date: "2027-04-20", premium_paid_through: "2027-03-31" })).sale_gate.flag, null, "flagged once per scheduled sale");
  assert.equal(h.ev("foreclosure.sale.scheduled").length, 1);
  // Section 10 advances the premium through April → the gate opens on the next run
  const apr = await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2027-03-12", fcl_days_used: 0, fcl_days_allowable: 300, upb_cents: 24_908_861n, note_rate_pct: "6.25", scheduled_sale_date: "2027-04-20", premium_paid_through: "2027-04-30" });
  assert.equal(apr.sale_gate.open, true); assert.equal(apr.score, 0);
  // the loan leaves default (reinstated) → the monthly-status cycle is cancelled, not rolled
  await h.run("scoreCurtailmentRisk", { loan_id: "L15", today: "2027-03-20", in_default: false, fcl_days_used: 0, fcl_days_allowable: 300, upb_cents: 24_908_861n, note_rate_pct: "6.25" });
  assert.equal(h.last("MI_MP_STATUS_MONTHLY_25TH").status, "cancelled"); assert.match(h.last("MI_MP_STATUS_MONTHLY_25TH").cancelledReason!, /no longer in default/);
  assert.equal(statusReportsCurrent({ reports: [{ due_on: D("2027-02-25"), accepted: true }], nod_due: D("2027-01-25"), as_of: D("2027-03-24") }), true);
  assert.equal(statusReportsCurrent({ reports: [{ due_on: D("2027-02-25"), accepted: true }], nod_due: D("2027-01-25"), as_of: D("2027-03-25") }), false, "the Mar 25 update is due and not accepted");
});

test("15.3 worked figures: L15 UPB $249,088.61 at 6.25% → 11 × $1,297.34 = $14,270.74 + 4 days × $42.6522 = $170.61 → $14,441.35; taxes $4,820.00, hazard $1,450.00 − $659.45 = $790.55, inspections $270.00, preservation $445.00, attorney $2,300.00 + $565.00 = $2,865.00 (cap $7,472.66); MI premiums $1,369.94 and tech fees $30.00 excluded → claim $272,720.51, benefit $68,180.13; TPS $270,000 → loss $2,720.51; $42.65/day at risk", () => {
  const s = shadowClaimItemized(L15);
  // interest: per-month rounding, 11 whole months from the paid-to date, then the 4-day stub at UPB × rate ÷ 365 (4 dp)
  assert.equal(monthlyInterest(24_908_861n, ratePercent("6.25")), 129_734n);          // $1,297.34
  assert.equal(s.interest_months, 11); assert.equal(s.capped, false);
  assert.equal(s.monthly_interest_cents, 129_734n);
  assert.equal(s.monthly_interest_cents * 11n, 1_427_074n);                              // $14,270.74
  assert.equal(s.stub_days, 4); assert.equal(s.stub_cents, 17_061n);                     // 4 × $42.6522 = $170.61
  assert.equal(s.interest_cents, 1_444_135n);                                            // $14,441.35
  assert.equal(s.interest_cents, s.monthly_interest_cents * 11n + s.stub_cents);
  // advances: what the ledger holds vs what the master policy lets us claim
  assert.equal(s.taxes_cents, 482_000n);                                                 // $4,820.00
  assert.equal(s.hazard_net_cents, 145_000n - 65_945n); assert.equal(s.hazard_net_cents, 79_055n);   // $790.55
  assert.equal(s.preservation_inspection_cents, 27_000n + 44_500n);                     // $270.00 + $445.00
  assert.equal(s.attorney_fees_costs_cents, 230_000n + 56_500n); assert.equal(s.attorney_fees_costs_cents, 286_500n); // $2,865.00
  assert.equal(s.attorney_cap_cents, 747_266n);                                          // 3% × $249,088.61 = $7,472.66
  assert.ok(s.attorney_fees_costs_cents < s.attorney_cap_cents);
  assert.equal(s.excluded_cents, 136_994n + 3_000n);                                     // MI premiums $1,369.94 + tech fees $30.00
  assert.deepEqual(s.lines.filter((l) => !l.claimable).map((l) => l.advance_id), ["adv-mi", "adv-tech"]);
  assert.ok(s.lines.every((l) => l.claimable || /not a claimable advance/.test(l.cap_reason ?? "")));
  assert.equal(s.claimable_advances_cents, 482_000n + 79_055n + 27_000n + 44_500n + 286_500n);
  // claim amount and the percentage-option benefit
  assert.equal(s.claim_amount_cents, 24_908_861n + 1_444_135n + s.claimable_advances_cents);
  assert.equal(s.claim_amount_cents, 27_272_051n);                                       // $272,720.51
  assert.equal(s.benefit_cents, 6_818_013n); assert.equal(s.settlement_option, "percentage"); assert.equal(s.loss_cents, null);
  // the calculator alone reproduces the same figures from the spec's grouped inputs
  const grouped = shadowClaim({ upb_cents: 24_908_861n, note_rate_pct: "6.25", interest_paid_to: D("2026-11-01"), anchor: D("2027-10-05"), default_date: D("2026-12-01"), taxes_cents: 482_000n, hazard_cents: 145_000n, hazard_refund_cents: 65_945n, hoa_cents: 0n, preservation_inspection_cents: 71_500n, attorney_fees_costs_cents: 286_500n, credits_cents: 0n, coverage_pct: "25" });
  assert.equal(grouped.claim_amount_cents, s.claim_amount_cents); assert.equal(grouped.benefit_cents, s.benefit_cents);
  // the mi_claim_calculations row: interest window Nov 1, 2026 → Oct 5, 2027 at 625 bps, the advances jsonb, the cap, no credits
  const row = calculationRow({ claim_id: "mic-L15", version: 1, as_of: D("2027-10-06"), input: L15, shadow: s });
  assert.deepEqual([row.interest_from, row.interest_to, row.interest_rate_bps, row.interest_months_capped, row.advances.length, row.attorney_fee_cap_cents, row.credits, row.benefit_cents], [D("2026-11-01"), D("2027-10-05"), 625, false, 9, 747_266n, [], 6_818_013n]);
  assert.equal(calculationRow({ claim_id: "mic-L15", version: 2, as_of: D("2029-12-02"), input: { ...L15, anchor: D("2029-12-01") }, shadow: shadowClaimItemized({ ...L15, anchor: D("2029-12-01") }) }).interest_to, addMonths(D("2026-11-01"), 36));
  // TPS option: had the $270,000 third-party bid prevailed, loss = claim amount − net proceeds and the benefit is the lesser
  const tps = shadowClaimItemized({ ...L15, net_proceeds_cents: 27_000_000n });
  assert.equal(tps.settlement_option, "third_party_sale"); assert.equal(tps.loss_cents, 272_051n); assert.equal(tps.benefit_cents, 272_051n); // $2,720.51
  assert.equal(tps.percentage_benefit_cents, 6_818_013n);
  // rule 5: each excess foreclosure day puts one day's note-rate interest at risk — $42.65/day for L15
  assert.equal(dailyInterestAtRisk(24_908_861n, "6.25"), 4_265n);
  assert.equal(s.daily_interest_cents, 4_265n);
  const m = curtailmentMonitor({ nod_late_days: 0, fcl_days_used: 340, fcl_days_allowable: 300, allowable_delays: 25, interest_months: 11, property_condition_flags: 0, premium_gap: false, docs_ready: true, upb_cents: 24_908_861n, note_rate_pct: "6.25" });
  assert.equal(m.projected_excess_days, 15); assert.equal(m.excess_interest_at_risk_cents, 15n * 4_265n); assert.deepEqual(m.task, { owner: "foreclosure-ops", kind: "diligent_servicing_evidence" });
  // rule 2 worked example: docs 10 fannie_et BD before Sat Dec 4, 2027 = Fri Nov 19; the −3 BD officer alert point is Tue Nov 16
  assert.equal(miClaimClocks(D("2027-10-05"), D("2027-10-05")).micp_docs_due, D("2027-11-19"));
  assert.deepEqual([micpDocsOfficerAlert({ micp_docs_due_at: D("2027-11-19"), today: D("2027-11-16"), uploaded: false, officer_alerted: false }).alert_on, micpDocsOfficerAlert({ micp_docs_due_at: D("2027-11-19"), today: D("2027-11-15"), uploaded: false, officer_alerted: false }).alert_required], [D("2027-11-16"), false]);
  // rule 9: the servicer-caused shortfall sits on the contingent_make_whole_fnma memo until Fannie Mae demands it — after the timeline evidence review; conveyance defects go to the attorney
  assert.equal(attributeShortfall({ cause: "late_documents", amount_cents: 118_013n, timeline_evidence_reviewed: true }).memo_account, "contingent_make_whole_fnma");
  assert.match(attributeShortfall({ cause: "late_documents", amount_cents: 118_013n, timeline_evidence_reviewed: false }).refusal!, /timeline evidence review/);
  assert.match(attributeShortfall({ cause: "foreclosure_delay", amount_cents: 118_013n, timeline_evidence_reviewed: false }).refusal!, /timeline evidence review/);
  assert.equal(attributeShortfall({ cause: "improper_conveyance", amount_cents: 118_013n, timeline_evidence_reviewed: true }).escalate_to, "attorney");
  assert.equal(attributeShortfall({ cause: "insurer_error", amount_cents: 118_013n, timeline_evidence_reviewed: false }).next, "appeal_or_accept");
});
