// 23.1 DU casefile creation, submission, resubmission tolerances, versioning, and casefile lifecycle
// spec/sections/23-desktop-underwriter-and-the-credit-decision/23-1-du-casefile-creation-submission-resubmission-tolerances-vers.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { formatCents } from "../../kernel/money/index.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolDef, type ToolInput } from "../../app/tools.ts";
import { TOOLS_23_1 } from "../../app/tools/section23-1.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import type { CreditReport, ScoreModel } from "../verification/ops-22-2.ts";
import { createCasefile, associateCredit, buildDuRequest, submitCasefile, receiveFindings, ingestOperatorFindings, evaluateResubmission, assertFinalSubmissionMatches, recordFinalSubmission, archivalWatch, archivalClocks, policyGeneration, duReleaseApplied, detectIdentityChange, recordIdentityChange, recordImpactMemo, tagAdapterRelease, confirmReturnFileFormat, returnFileTypeGate, finalMatchGate, finalMatchFacts, closedLoanSnapshotHash,
  dtiBps, dtiTest, rateTest, loanAmountTest, refiAmountTolerance, reservesTest, incomeLimitedTest, closedLoanFieldsTest, ltvPct, llpaLtvBand, piCents, piUnrounded, decisionRecord, FakeDuPort, OutageDuPort, DuRefused, DI_OUTAGE_AFTER_MINUTES, AGENT,
  type DuCasefile, type DuSubmission, type UladSnapshot, type BorrowerIdentity, type DuRequest, type SubmissionReason, type SubmissionType } from "./ops-23-1.ts";

// ─────────────────────────────────────────────────────────────── fixtures (spec README: refinance Mon Oct 5, 2026; purchase Mon Oct 19, 2026)
const B1: BorrowerIdentity = { borrower_id: "B1", last_name: "Rivera", suffix: null, ssn_last4: "1234" };
const B2: BorrowerIdentity = { borrower_id: "B2", last_name: "Rivera", suffix: null, ssn_last4: "5678" };
/** Worked example 1: $560,000 LCOR, 30-year fixed at 6.125 %, appraised $800,000 (LTV 70.00 %), income $12,000.00, obligations $4,560.00 → DTI 38.00 %. */
const REFI: UladSnapshot = { application_id: "APP-R", loan_purpose: "limited_cash_out_refinance", occupancy: "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached", sales_price_cents: null, appraised_value_cents: 80_000_000n, loan_amount_cents: 56_000_000n,
  note_rate_pct: "6.125", qualifying_income_cents: 1_200_000n, total_obligations_cents: 456_000n, borrowers: [B1, B2], max_ltv_pct: "95.00" };
/** Worked example 4 / O4-IT2: Columbus, OH purchase, $412,000, HomeReady, qualifying income $6,250.00. */
const PURCHASE: UladSnapshot = { application_id: "APP-P", loan_purpose: "purchase", occupancy: "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached", sales_price_cents: 51_500_000n, appraised_value_cents: 51_500_000n, loan_amount_cents: 41_200_000n,
  note_rate_pct: "6.250", qualifying_income_cents: 625_000n, total_obligations_cents: 250_000n, borrowers: [{ borrower_id: "B3", last_name: "Okafor", suffix: null, ssn_last4: "9012" }], income_limited_product: true, max_ltv_pct: "97.00" };
const REPORT_DATE = D("2026-10-05");
function mkReport(o: { report_id: string; application_id: string; borrower_ids: readonly string[]; score_model?: ScoreModel; report_date?: PlainDate; state?: CreditReport["state"]; provider?: string | null }): CreditReport {
  const report_date = o.report_date ?? REPORT_DATE;
  return { report_id: o.report_id, application_id: o.application_id, report_type: "tri_merge_infile", reseller: "Xactus", du_credit_provider_code: o.provider === undefined ? "XAC01" : o.provider, credit_reference_number: o.provider === null ? null : `REF-${o.report_id}`, borrower_ids: o.borrower_ids, repositories_requested: ["efx", "exp", "tu"], repositories_returned: ["efx", "exp", "tu"], frozen_repositories: [],
    borrowers: o.borrower_ids.map((b) => ({ borrower_id: b, scores: { efx: { score: 742, model_version: "FICO 5", key_factors: [] } }, returned: ["efx", "exp", "tu"], frozen: [] })), fraud_alerts: [], score_model: o.score_model ?? "classic_fico", borrower_applicable_scores: {}, representative_score: 742, representative_score_borrower_id: o.borrower_ids[0]!, no_score_borrowers: [], key_factors: {}, inquiries_90d: [], disputed_tradelines: [], public_records: [], collections: [], mortgage_tradelines: [], tradelines: [], identity_headers: [], trended_data: true,
    permissible_purpose: "credit_transaction_604a3A", certification_ref: "cert-1", pulled_at: `${report_date}T14:00:00.000Z`, report_date, expires_at: D("2027-02-05"), fee_cents: 4_500n, fee_item_id: null, document_id: null, supersedes_report_id: null, cra: { name: "Xactus", address: "—", phone: "—" }, state: o.state ?? "usable", state_reason: null, fraud_alert_cleared: true };
}
const scifFacts = (s: UladSnapshot): Record<string, unknown> => ({ borrowers: s.borrowers.map((b) => ({ id: b.borrower_id, scif_presented_at: "2026-10-05T16:00:00.000Z" })) });
const OPERATOR: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };
const toolKey = (process: string, name: string): string => `${process} ${name}`;

/** The 23.1 lifecycle on the event store: casefile → credit association → request → submission over the fake DI port → findings, with the TimerEngine arming the 23.1 rows (and 22.5's resubmission SLA). */
function harness(nowIso: string, opts: { port?: FakeDuPort | OutageDuPort; recommend?: ConstructorParameters<typeof FakeDuPort>[1] } = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["23.1", "22.5"] });
  const escalations = new EscalationService(events, clock);
  const port = opts.port ?? new FakeDuPort(clock, opts.recommend ?? {});
  const emitted = (type: string) => events.all().filter((e) => e.type === type);
  const byCode = (code: string) => timers.byCode(code);
  const create = (s: UladSnapshot, created_at: string, extra: Partial<Parameters<typeof createCasefile>[1]> = {}) => createCasefile(events, { application_id: s.application_id, seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at, ...extra }).casefile;
  const associate = (cf: DuCasefile, s: UladSnapshot, reports?: readonly CreditReport[]) => associateCredit(events, cf, { reports: reports ?? [mkReport({ report_id: `R-${s.application_id}`, application_id: s.application_id, borrower_ids: s.borrowers.map((b) => b.borrower_id) })], borrowers: s.borrowers, app_score_model: "classic_fico", at: clock.now() }).casefile;
  /** submit + findings in one run (the agent's end-to-end step). */
  const submit = async (cf: DuCasefile, s: UladSnapshot, prior: readonly DuSubmission[], o: { type?: SubmissionType; reason?: SubmissionReason; at?: string; note?: PlainDate | null; escalate?: boolean; built_at?: string; return_file_types?: DuRequest["return_file_types"] } = {}) => {
    const at = o.at ?? clock.now(); clock.set(at);
    const request = buildDuRequest(cf, { submission_type: o.type ?? (prior.length ? "underwriting_only" : "credit_and_underwriting"), reason: o.reason ?? (prior.length ? "tolerance_breach" : "initial"), built_at: o.built_at ?? at, snapshot: s, prior_submission_number: prior.at(-1)?.submission_number ?? null, ...(o.return_file_types ? { return_file_types: o.return_file_types } : {}) });
    const r = await submitCasefile(events, port, cf, { request, at, prior, projected_note_date: o.note === undefined ? D("2026-11-06") : o.note, scif_facts: scifFacts(s), escalations: o.escalate ? escalations : null });
    if (r.outage) return { ...r, request, findings: null };
    const f = await port.fetchFindings(cf.casefile_id, r.submission.submission_number);
    const got = receiveFindings(events, r.casefile, r.submission, f);
    return { ...r, request, submission: got.submission, casefile: got.casefile, findings: f };
  };
  return { clock, events, timers, escalations, port, emitted, byCode, create, associate, submit };
}
/** Worked example 1's first run: casefile Tue Oct 6, 2026 → credit_and_underwriting submission → Approve/Eligible. */
async function firstRun(h: ReturnType<typeof harness>, s: UladSnapshot = REFI, created_at = "2026-10-06T15:00:00.000Z") {
  const cf0 = h.create(s, created_at); const cf1 = h.associate(cf0, s);
  const r = await h.submit(cf1, s, [], { at: created_at });
  return { casefile: r.casefile, submission: r.submission, request: r.request };
}
/** The §23.1 bus (the 12-7 pattern): 23.1's tools bound to the `underwriter` agent. */
function bindSection23(rt: ToolRuntime, agents: AgentRegistry, defs: readonly ToolDef[] = TOOLS_23_1): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of defs) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); out.set(toolKey(d.process, d.name), cmd); }
  return out;
}
function uow(h: ReturnType<typeof harness>, applicationId: string): UowContext & { decisions: DecisionInput[] } {
  const decisions: DecisionInput[] = [];
  return { loanId: "", applicationId, events: h.events, ledger: new MemoryLedger(), timers: h.timers, clock: h.clock, decide: (d) => { decisions.push(d); }, decisions };
}

test("23.1-T1: Given the refinance fixture with credit received Mon Oct 5, 2026 for both borrowers, when the `underwriter` agent runs, then a `du_casefiles` row is created Tue Oct 6, 2026 with `policy_generation = 2026_09_26`, `archive_540_due_at = 2028-03-29`, and a `credit_and_underwriting` submission with `request_hash` set; `du.submitted` and `du.findings.received` are emitted within the same run.", async () => {
  const h = harness("2026-10-06T15:00:00.000Z");
  // credit received Mon Oct 5 for both borrowers (22.2); the underwriter agent runs Tue Oct 6
  const cf0 = h.create(REFI, "2026-10-06T15:00:00.000Z");
  assert.equal(cf0.created_on, "2026-10-06"); assert.equal(cf0.policy_generation, "2026_09_26"); assert.equal(cf0.archive_540_due_at, "2028-03-29"); assert.equal(cf0.status, "draft"); assert.equal(cf0.du_version, "12.1");
  assert.equal(policyGeneration(D("2026-09-24")), "2026_06_27"); assert.equal(policyGeneration(D("2026-06-27")), "pre_2026_06_27"); assert.equal(policyGeneration(D("2026-06-28")), "2026_06_27");
  const cf1 = h.associate(cf0, REFI);
  assert.equal(cf1.status, "credit_associated"); assert.equal(cf1.credit_association.length, 2); assert.equal(cf1.credit_association[0]!.mode, "reissue"); assert.equal(cf1.credit_association[0]!.report_type, "joint");
  const r = await h.submit(cf1, REFI, []);
  assert.equal(r.submission.submission_type, "credit_and_underwriting"); assert.equal(r.submission.submission_number, 1); assert.match(r.submission.request_hash, /^[0-9a-f]{64}$/); assert.equal(r.submission.reason, "initial");
  assert.equal(r.submission.du_release_applied, "2026_09_25"); assert.equal(duReleaseApplied("2026-09-25T15:00:00.000Z"), "2026_09_09"); assert.equal(duReleaseApplied("2026-09-25T23:30:00.000Z"), "2026_09_25");
  assert.equal(r.submission.status, "findings_received"); assert.equal(r.submission.recommendation, "approve_eligible"); assert.equal(r.submission.dti_du, "38.00"); assert.equal(r.submission.ltv_du, "70.0000"); assert.equal(r.casefile.status, "findings_received"); assert.equal(r.casefile.submission_count, 1);
  // `du.submitted` and `du.findings.received` within the same run, both keyed by application_id
  const submitted = h.emitted("du.submitted"), findings = h.emitted("du.findings.received");
  assert.equal(submitted.length, 1); assert.equal(findings.length, 1); assert.equal(submitted[0]!.applicationId, "APP-R"); assert.equal(findings[0]!.payload.application_id, "APP-R");
  assert.equal(submitted[0]!.payload.submission_number, 1); assert.equal(findings[0]!.payload.recommendation, "approve_eligible"); assert.ok(Array.isArray(findings[0]!.payload.messages)); assert.ok(findings[0]!.payload.value_acceptance_offer); assert.ok(findings[0]!.payload.mi_requirement);
  assert.equal(findings[0]!.payload.borrower_deliverable, false);
  // the archival clocks armed by the run: 540 from creation, 270 from the last update (the findings)
  assert.equal(h.byCode("FNMA_B3_2_01_DU_ARCHIVE_540")[0]!.dueDate, "2028-03-29"); assert.equal(h.byCode("FNMA_B3_2_01_DU_ARCHIVE_270")[0]!.dueDate, "2027-07-03"); assert.equal(h.byCode("FNMA_B3_2_01_DU_ARCHIVE_270")[0]!.status, "armed");
  // decision record carries both version keys (LL-2026-04)
  const rec = decisionRecord(r.casefile, { submission: r.submission, reason: "initial", rationale: "first submission after 1003 + credit", model_version: "m1", prompt_version: "p1", confidence: 0.99 });
  assert.equal(rec.policy_generation, "2026_09_26"); assert.equal(rec.du_release_applied, "2026_09_25"); assert.equal(rec.request_hash, r.submission.request_hash); assert.equal(rec.recommendation_after, "approve_eligible");
});

test("23.1-T2: Given baseline DTI 38.00% on $12,000.00 income, when a $450.00/month liability is added Oct 20, 2026, then `du_resubmission_checks.result = resubmission_required` with `rule_code = B3_2_10_DTI_45_OR_3PT` (dti_after 41.75, delta 3.75) and `SM_DU_RESUBMIT_SLA_1BD` due Wed Oct 21, 2026; a $300.00 liability yields `within_tolerance` (40.50, delta 2.50) and `du.resubmission.waived`.", async () => {
  const h = harness("2026-10-06T15:00:00.000Z");
  const first = await firstRun(h);
  assert.equal(first.submission.dti_du, "38.00");
  // Tue Oct 20: the 22.2 undisclosed-debt monitor reports a new auto loan at $450.00/month → 22.5 recomputes DTI and hands 23.1 the tolerance decision
  const at = "2026-10-20T15:00:00.000Z"; h.clock.set(at);
  const withAuto: UladSnapshot = { ...REFI, total_obligations_cents: REFI.total_obligations_cents + 45_000n };
  const ev = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: withAuto, trigger_event: "liabilities.changed", at });
  assert.equal(ev.result, "resubmission_required"); assert.deepEqual(ev.rule_codes, ["B3_2_10_DTI_45_OR_3PT"]); assert.equal(ev.reason, "tolerance_breach");
  const chk = ev.checks.find((c) => c.field === "liabilities")!;
  assert.equal(chk.result, "resubmission_required"); assert.equal(chk.rule_code, "B3_2_10_DTI_45_OR_3PT"); assert.equal(chk.arithmetic.dti_after, "41.75"); assert.equal(chk.arithmetic.dti_before, "38.00"); assert.equal(chk.arithmetic.delta, "3.75"); assert.equal(chk.arithmetic.exceeds_45, false); assert.equal(chk.arithmetic.increase_3_points, true);
  assert.equal(chk.arithmetic.check_22_2, "resubmission required");
  assert.equal(h.emitted("du.resubmission.required").length, 1);
  // SM_DU_RESUBMIT_SLA_1BD (+1 business_days_creditor) arms on 22.5's `liabilities.changed{tolerance_result=resubmission_required}` → due Wed Oct 21, 2026
  h.events.append({ type: "liabilities.changed", applicationId: "APP-R", actor: { kind: "agent", id: "verification" }, occurredAt: at, payload: { application_id: "APP-R", trigger: "udm_alert", dti_before: "38.00", dti_after: "41.75", dti_before_bps: 3800, dti_after_bps: 4175, delta_bps: 375, tolerance_result: "resubmission_required", rule_code: "B3_2_10_DTI_45_OR_3PT", tolerance_check_for: "23.1", changed_at: at } });
  const sla = h.byCode("SM_DU_RESUBMIT_SLA_1BD");
  assert.equal(sla.length, 1); assert.equal(sla[0]!.dueDate, "2026-10-21"); assert.equal(sla[0]!.status, "armed");
  // resubmitted Oct 20 (underwriting_only, tolerance_breach); findings remain Approve/Eligible with the updated liability message
  const r2 = await h.submit(first.casefile, withAuto, [first.submission], { at });
  assert.equal(r2.submission.submission_number, 2); assert.equal(r2.submission.submission_type, "underwriting_only"); assert.equal(r2.submission.reason, "tolerance_breach"); assert.equal(r2.submission.recommendation, "approve_eligible"); assert.equal(r2.submission.dti_du, "41.75");
  assert.ok(r2.submission.messages.some((m) => /liabilit/i.test(m.text)));
  // Had the new payment been $300.00: DTI 40.50 %, increase 2.50 → within_tolerance, `du.resubmission.waived` — the liability still goes into the final closed-loan submission (rule 5)
  const with300: UladSnapshot = { ...REFI, total_obligations_cents: REFI.total_obligations_cents + 30_000n };
  const w = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: with300, trigger_event: "liabilities.changed", at });
  assert.equal(w.result, "within_tolerance"); assert.equal(w.arithmetic.dti_after, "40.50"); assert.equal(w.arithmetic.dti_delta, "2.50"); assert.equal(w.event.type, "du.resubmission.waived"); assert.equal(w.event.payload.final_submission_will_carry_change, true);
  assert.equal(dtiBps(456_000n + 45_000n, 1_200_000n), 4175); assert.equal(dtiBps(456_000n + 30_000n, 1_200_000n), 4050);
});

test("23.1-T3: Given a refinance loan amount of $560,000 (LTV 70.00%, LLPA column 60.01–70.00%), when the amount changes to $560,500, then the amount test passes (cap $500) but LTV becomes 70.0625%, which falls in the 70.01–75.00% LLPA column (LLPA Matrix 09.09.2026 nine LTV bands), so the check returns `resubmission_required` on the LLPA condition; when the amount changes to $565,600 the amount test fails outright (`B3_2_10_REFI_AMOUNT_500_1PCT`).", async () => {
  const base = { loan_purpose: REFI.loan_purpose, loan_amount_cents: 56_000_000n, appraised_value_cents: 80_000_000n } as const;
  assert.equal(ltvPct(56_000_000n, 80_000_000n).toFixed(4), "70.0000"); assert.equal(llpaLtvBand(ltvPct(56_000_000n, 80_000_000n)), "60.01–70.00%");
  // +$500: inside the cap (min($500, 1 % = $5,600) = $500) but LTV 70.0625 % crosses into the 70.01–75.00 % column → resubmission on the LLPA condition
  const t500 = loanAmountTest(base, { loan_amount_cents: 56_050_000n, appraised_value_cents: 80_000_000n });
  assert.equal(t500.amount_test, "pass"); assert.equal(t500.tolerance!.max_increase_cents, 50_000n); assert.equal(t500.tolerance!.one_pct_cents, 560_000n); assert.equal(t500.tolerance!.ceiling_cents, 56_050_000n);
  assert.equal(t500.ltv_after, "70.0625"); assert.equal(t500.llpa_band_before, "60.01–70.00%"); assert.equal(t500.llpa_band_after, "70.01–75.00%"); assert.equal(t500.condition_failed, "llpa_band"); assert.equal(t500.result, "resubmission_required"); assert.equal(t500.rule_code, "B3_2_10_REFI_AMOUNT_500_1PCT");
  assert.match(t500.citation, /LLPA Matrix 09\.09\.2026/);
  // $565,600 (worked example 2): the amount test fails outright; LTV 70.70 %
  const t5600 = loanAmountTest(base, { loan_amount_cents: 56_560_000n, appraised_value_cents: 80_000_000n });
  assert.equal(t5600.amount_test, "fail"); assert.equal(t5600.rule_code, "B3_2_10_REFI_AMOUNT_500_1PCT"); assert.equal(t5600.result, "resubmission_required"); assert.equal(t5600.ltv_after, "70.7000"); assert.equal(t5600.condition_failed, null);
  // $560,400 (+$400, LTV 70.05 %): inside the cap, still resubmission on the LLPA condition
  const t400 = loanAmountTest(base, { loan_amount_cents: 56_040_000n, appraised_value_cents: 80_000_000n });
  assert.equal(t400.amount_test, "pass"); assert.equal(t400.ltv_after, "70.0500"); assert.equal(t400.condition_failed, "llpa_band"); assert.equal(t400.result, "resubmission_required");
  // through evaluateResubmission: the loan_amount row plus the llpa_band row
  const h = harness("2026-10-06T15:00:00.000Z"); const first = await firstRun(h);
  const ev = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: { ...REFI, loan_amount_cents: 56_050_000n }, trigger_event: "changed_circumstance.recorded", at: "2026-10-22T15:00:00.000Z" });
  assert.equal(ev.result, "resubmission_required"); assert.deepEqual(ev.checks.map((c) => c.field), ["loan_amount", "llpa_band"]); assert.equal(ev.checks[1]!.old_value, "60.01–70.00%"); assert.equal(ev.checks[1]!.new_value, "70.01–75.00%");
});

test("23.1-T4: Given a refinance amount decrease from $560,000 to $532,000 (−5.00%), then `within_tolerance` provided no MI/LLPA/eligibility change; $531,999 → `resubmission_required` (`B3_2_10_REFI_AMOUNT_MINUS_5PCT`).", async () => {
  const base = { loan_purpose: REFI.loan_purpose, loan_amount_cents: 56_000_000n, appraised_value_cents: 80_000_000n } as const;
  assert.equal(refiAmountTolerance(56_000_000n).max_decrease_cents, 2_800_000n); assert.equal(refiAmountTolerance(56_000_000n).floor_cents, 53_200_000n);
  // −5.00 % → $532,000: LTV 66.50 % stays in 60.01–70.00 %, no MI (≤ 80 %), no eligibility change → within_tolerance
  const ok = loanAmountTest(base, { loan_amount_cents: 53_200_000n, appraised_value_cents: 80_000_000n });
  assert.equal(ok.result, "within_tolerance"); assert.equal(ok.amount_test, "pass"); assert.equal(ok.condition_failed, null); assert.equal(ok.ltv_after, "66.5000"); assert.equal(ok.llpa_band_after, "60.01–70.00%"); assert.equal(ok.mi_band_before, null); assert.equal(ok.mi_band_after, null); assert.equal(ok.rule_code, "B3_2_10_REFI_AMOUNT_MINUS_5PCT");
  // $531,999 → below the floor → resubmission_required (B3_2_10_REFI_AMOUNT_MINUS_5PCT)
  const bad = loanAmountTest(base, { loan_amount_cents: 53_199_900n, appraised_value_cents: 80_000_000n });
  assert.equal(bad.result, "resubmission_required"); assert.equal(bad.rule_code, "B3_2_10_REFI_AMOUNT_MINUS_5PCT"); assert.equal(bad.amount_test, "fail");
  // the proviso: a decrease inside 5 % that drops the MI coverage band (B7-1-02) still resubmits
  const mi = loanAmountTest({ ...base, loan_amount_cents: 68_400_000n }, { loan_amount_cents: 67_900_000n, appraised_value_cents: 80_000_000n });
  assert.equal(mi.mi_band_before, "85.01–90.00%"); assert.equal(mi.mi_band_after, "80.01–85.00%"); assert.equal(mi.condition_failed, "mi_coverage"); assert.equal(mi.result, "resubmission_required");
  const h = harness("2026-10-06T15:00:00.000Z"); const first = await firstRun(h);
  const ev = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: { ...REFI, loan_amount_cents: 53_200_000n }, trigger_event: "application.data.changed", at: "2026-10-22T15:00:00.000Z" });
  assert.equal(ev.result, "within_tolerance"); assert.equal(ev.event.type, "du.resubmission.waived");
});

test("23.1-T5: Given a purchase casefile ($412,000) whose loan amount changes by $1, then `resubmission_required` (`B3_2_10_PURCHASE_AMOUNT`) — no purchase tolerance exists.", async () => {
  const t = loanAmountTest({ loan_purpose: "purchase", loan_amount_cents: 41_200_000n, appraised_value_cents: 51_500_000n }, { loan_amount_cents: 41_200_100n, appraised_value_cents: 51_500_000n });
  assert.equal(t.result, "resubmission_required"); assert.equal(t.rule_code, "B3_2_10_PURCHASE_AMOUNT"); assert.equal(t.tolerance, null); assert.equal(t.amount_test, "fail"); assert.match(t.citation, /no loan-amount tolerance for purchase/);
  const down = loanAmountTest({ loan_purpose: "purchase", loan_amount_cents: 41_200_000n, appraised_value_cents: 51_500_000n }, { loan_amount_cents: 41_199_900n, appraised_value_cents: 51_500_000n });
  assert.equal(down.rule_code, "B3_2_10_PURCHASE_AMOUNT");
  const h = harness("2026-10-20T15:00:00.000Z"); const first = await firstRun(h, PURCHASE, "2026-10-20T15:00:00.000Z");
  assert.equal(first.casefile.archive_540_due_at, "2028-04-12");   // worked example 4: casefile created Tue Oct 20 → Wed Apr 12, 2028
  const ev = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: { ...PURCHASE, loan_amount_cents: 41_200_100n }, trigger_event: "application.data.changed", at: "2026-10-22T15:00:00.000Z" });
  assert.equal(ev.result, "resubmission_required"); assert.deepEqual(ev.rule_codes, ["B3_2_10_PURCHASE_AMOUNT"]);
});

test("23.1-T6: Given \"Reserves Required to be Verified\" $8,000.00, when verified reserves are $7,300.00 then `within_tolerance`; $7,200.00 (exactly 90.00%) `within_tolerance`; $7,100.00 `resubmission_required`.", async () => {
  const r7300 = reservesTest(800_000n, 730_000n);
  assert.equal(r7300.result, "within_tolerance"); assert.equal(r7300.threshold_cents, 720_000n); assert.equal(r7300.verified_pct, "91.25");
  const r7200 = reservesTest(800_000n, 720_000n);
  assert.equal(r7200.result, "within_tolerance"); assert.equal(r7200.verified_pct, "90.00");
  const r7100 = reservesTest(800_000n, 710_000n);
  assert.equal(r7100.result, "resubmission_required"); assert.equal(r7100.rule_code, "B3_2_10_RESERVES_90PCT"); assert.equal(r7100.verified_pct, "88.75");
  const h = harness("2026-10-20T15:00:00.000Z"); const first = await firstRun(h, PURCHASE, "2026-10-20T15:00:00.000Z");
  const ev = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: PURCHASE, trigger_event: "verification.received", at: "2026-10-26T15:00:00.000Z", reserves_required_cents: 800_000n, verified_reserves_cents: 710_000n });
  assert.equal(ev.result, "resubmission_required"); assert.deepEqual(ev.rule_codes, ["B3_2_10_RESERVES_90PCT"]); assert.equal(ev.checks[0]!.arithmetic.threshold_cents, "720000");
  const ok = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: PURCHASE, trigger_event: "verification.received", at: "2026-10-26T15:00:00.000Z", reserves_required_cents: 800_000n, verified_reserves_cents: 730_000n });
  assert.equal(ok.result, "within_tolerance"); assert.equal(ok.event.type, "du.resubmission.waived");
});

test("23.1-T7: Given the note rate falls from 6.250% to 6.125% (no buydown), then `within_tolerance`; given the decrease results from a permanent buydown, then `resubmission_required` (`B3_2_10_RATE_DECREASE_BUYDOWN`).", async () => {
  const dec = rateTest("6.250", "6.125", false);
  assert.equal(dec.direction, "decrease"); assert.equal(dec.rule_code, "B3_2_10_RATE_DECREASE"); assert.equal(dec.result, "within_tolerance"); assert.equal(dec.evaluate_dti, false);
  const buy = rateTest("6.250", "6.125", true);
  assert.equal(buy.rule_code, "B3_2_10_RATE_DECREASE_BUYDOWN"); assert.equal(buy.result, "resubmission_required"); assert.match(buy.citation, /permanent buydown/);
  const inc = rateTest("6.125", "6.250");
  assert.equal(inc.direction, "increase"); assert.equal(inc.rule_code, null); assert.equal(inc.evaluate_dti, true);
  const h = harness("2026-10-06T15:00:00.000Z"); const first = await firstRun(h, { ...REFI, note_rate_pct: "6.250" });
  const waived = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: { ...REFI, note_rate_pct: "6.125" }, trigger_event: "lock.executed", at: "2026-10-07T15:00:00.000Z" });
  assert.equal(waived.result, "within_tolerance"); assert.equal(waived.event.type, "du.resubmission.waived"); assert.deepEqual(waived.event.payload.waived_rule_codes, ["B3_2_10_RATE_DECREASE"]);
  const required = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: { ...REFI, note_rate_pct: "6.125", permanent_buydown: true }, trigger_event: "lock.executed", at: "2026-10-07T15:00:00.000Z" });
  assert.equal(required.result, "resubmission_required"); assert.deepEqual(required.rule_codes, ["B3_2_10_RATE_DECREASE_BUYDOWN"]);
});

test("23.1-T8: Given recalculated DTI 50.25%, then `ineligible_change` (`B3_2_10_DTI_OVER_50`) and 23.2's restructuring loop is invoked; no submission is sent until the structure changes.", async () => {
  const h = harness("2026-10-06T15:00:00.000Z"); const first = await firstRun(h);
  // obligations $6,030.00 on $12,000.00 → 50.25 %
  const c: UladSnapshot = { ...REFI, total_obligations_cents: 603_000n };
  const d = dtiTest({ obligations_cents: REFI.total_obligations_cents, income_cents: REFI.qualifying_income_cents }, { obligations_cents: c.total_obligations_cents, income_cents: c.qualifying_income_cents });
  assert.equal(d.dti_after, "50.25"); assert.equal(d.over_50, true); assert.equal(d.result, "ineligible_change"); assert.equal(d.rule_code, "B3_2_10_DTI_OVER_50"); assert.match(d.citation, /B3-6-02/);
  const ev = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: c, trigger_event: "liabilities.changed", at: "2026-10-20T15:00:00.000Z" });
  assert.equal(ev.result, "ineligible_change"); assert.deepEqual(ev.rule_codes, ["B3_2_10_DTI_OVER_50"]); assert.equal(ev.submission_blocked, true); assert.equal(ev.restructure_hand_off, "23.2"); assert.equal(ev.casefile_status, "resubmission_required");
  assert.equal(ev.event.type, "du.resubmission.required"); assert.equal(ev.event.payload.submission_blocked, true); assert.equal(ev.event.payload.restructure_hand_off, "23.2");
  // no submission is sent until the structure changes: the agent's step only resubmits on `resubmission_required`
  const before = h.port instanceof FakeDuPort ? h.port.requests.length : 0;
  if ((ev.result as string) === "resubmission_required") await h.submit(first.casefile, c, [first.submission]);
  assert.equal((h.port as FakeDuPort).requests.length, before); assert.equal(h.emitted("du.submitted").length, 1);
  // after 23.2 restructures (obligations back under 50 %) the resubmission goes out
  const restructured: UladSnapshot = { ...REFI, total_obligations_cents: 540_000n };   // 45.00 % → resubmission_required, not ineligible
  const ev2 = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: restructured, trigger_event: "restructure.proposed", at: "2026-10-21T15:00:00.000Z" });
  assert.equal(ev2.result, "resubmission_required"); assert.equal(ev2.arithmetic.dti_after, "45.00");
  const r2 = await h.submit(first.casefile, restructured, [first.submission], { at: "2026-10-21T15:00:00.000Z" });
  assert.equal(r2.submission.recommendation, "approve_eligible"); assert.equal((h.port as FakeDuPort).requests.length, before + 1);
});

test("23.1-T9: Given closing documents are requested Tue Nov 3, 2026 and the last findings (Oct 20) carry `appraised_value = $800,000` while the CD-final data carry $795,000, then `FNMA_B3_2_10_DU_FINAL_MATCH_GATE` blocks `generateClosingDocs`, a `final_closed_loan_match` submission is sent, and the gate opens only when the new findings hash matches and the recommendation is `approve_eligible`.", async () => {
  const h = harness("2026-10-06T15:00:00.000Z"); const first = await firstRun(h);
  // Oct 20 resubmission (the last findings) carries appraised_value = $800,000
  const oct20 = await h.submit(first.casefile, { ...REFI, total_obligations_cents: 501_000n }, [first.submission], { at: "2026-10-20T15:00:00.000Z" });
  assert.equal(oct20.submission.snapshot.appraised_value_cents, 80_000_000n); assert.equal(oct20.findings!.evaluated.appraised_value_cents, 80_000_000n);
  // Tue Nov 3: closing documents requested (26.1 `closing.document_set.opened`) — the CD-final data carry $795,000
  const at = "2026-11-03T15:00:00.000Z"; h.clock.set(at);
  const cdFinal: UladSnapshot = { ...REFI, total_obligations_cents: 501_000n, appraised_value_cents: 79_500_000n };
  h.events.append({ type: "closing.document_set.opened", applicationId: "APP-R", actor: { kind: "agent", id: "closer" }, occurredAt: at, payload: { set_id: "CDS-1", application_id: "APP-R" } });
  const gateInst = h.byCode("FNMA_B3_2_10_DU_FINAL_MATCH_GATE"); assert.equal(gateInst.length, 1); assert.equal(gateInst[0]!.status, "armed"); assert.equal(gateInst[0]!.note, "evaluator:23.1.finalMatchGate");
  const a = assertFinalSubmissionMatches(h.events, oct20.casefile, oct20.submission, cdFinal, "generateClosingDocs", at);
  assert.equal(a.gate.open, false); assert.match(a.gate.reason!, /no du_submissions row with is_final=true/); assert.equal(a.resubmit!.reason, "final_closed_loan_match"); assert.deepEqual(a.resubmit!.differences.map((d) => d.field), ["appraised_value"]);
  assert.equal(a.event!.type, "du.resubmission.required"); assert.equal(a.event!.payload.blocks, "generateClosingDocs"); assert.deepEqual(a.event!.payload.rule_codes, ["B3_2_10_CLOSED_LOAN_FIELD"]);
  assert.equal(evaluateGate("23.1.finalMatchGate", finalMatchFacts(oct20.submission, cdFinal)).open, false);
  // the final_closed_loan_match submission is sent with the closed-loan data (rule 5); its findings hash must match the closing-data hash
  const fin = await h.submit(oct20.casefile, cdFinal, [first.submission, oct20.submission], { type: "underwriting_only", reason: "final_closed_loan_match", at });
  assert.equal(fin.submission.submission_number, 3); assert.equal(fin.submission.reason, "final_closed_loan_match"); assert.equal(fin.submission.closed_loan_snapshot_hash, closedLoanSnapshotHash(cdFinal)); assert.equal(fin.submission.findings_hash, closedLoanSnapshotHash(cdFinal));
  const rec = recordFinalSubmission(h.events, fin.casefile, fin.submission, cdFinal, at);
  assert.equal(rec.submission.is_final, true); assert.equal(rec.gate.open, true); assert.equal(rec.casefile.status, "final"); assert.equal(rec.casefile.final_submission_id, fin.submission.submission_id); assert.equal(rec.escalate, null);
  assert.equal(evaluateGate("23.1.finalMatchGate", finalMatchFacts(rec.submission, cdFinal)).open, true);
  assert.equal(h.byCode("FNMA_B3_2_10_DU_FINAL_MATCH_GATE")[0]!.status, "satisfied");   // `du.final_submission.recorded{is_final=true, recommendation=approve_eligible}`
  // the gate opens only when BOTH hold: a matching hash with a downgraded recommendation stays closed and reopens 23.3's decision
  assert.equal(finalMatchGate({ is_final: true, closed_loan_snapshot_hash: closedLoanSnapshotHash(cdFinal), current_closing_hash: closedLoanSnapshotHash(cdFinal), recommendation: "approve_ineligible" }).open, false);
  const downgrade = recordFinalSubmission(h.events, fin.casefile, { ...fin.submission, recommendation: "refer_with_caution" }, cdFinal, at);
  assert.equal(downgrade.gate.open, false); assert.equal(downgrade.escalate, "underwriting_reviewer"); assert.equal(downgrade.event.payload.decision_reopen, "23.3 decision.reopened");
  // a later CD-final change (hash drift) closes it again
  assert.equal(finalMatchGate(finalMatchFacts(rec.submission, { ...cdFinal, appraised_value_cents: 79_000_000n })).open, false);
});

test("23.1-T10: Given a casefile last updated Thu Nov 5, 2026 with no further activity, then `FNMA_B3_2_01_DU_ARCHIVE_270` fires the warning on Sat Jul 3, 2027 (day 240) and marks `archived` on Mon Aug 2, 2027; if the loan was purchased Nov 19, 2026, the archive event is informational only.", async () => {
  const h = harness("2026-11-05T15:00:00.000Z"); const first = await firstRun(h, REFI, "2026-10-06T15:00:00.000Z");
  const last = await h.submit(first.casefile, REFI, [first.submission], { type: "underwriting_only", reason: "final_closed_loan_match", at: "2026-11-05T15:00:00.000Z" });
  assert.equal(last.casefile.last_updated_on, "2026-11-05");
  const clocks = archivalClocks(D("2026-10-06"), D("2026-11-05"));
  assert.equal(clocks.archive_270_due_at, "2027-08-02"); assert.equal(clocks.archive_540_due_at, "2028-03-29"); assert.equal(clocks.archive_due_at, "2027-08-02"); assert.equal(clocks.archive_warning_at, "2027-07-03");
  assert.equal(last.casefile.archive_due_at, "2027-08-02"); assert.equal(h.byCode("FNMA_B3_2_01_DU_ARCHIVE_270").at(-1)!.dueDate, "2027-08-02");
  // no further activity: Fri Jul 2 nothing; Sat Jul 3, 2027 (day 240) the warning; Mon Aug 2, 2027 (day 270) archived
  assert.equal(archivalWatch(h.events, last.casefile, D("2027-07-02"), { loan_purchased: false }).action, "none");
  const warn = archivalWatch(h.events, last.casefile, D("2027-07-03"), { loan_purchased: false });
  assert.equal(warn.action, "warning"); assert.equal(warn.day, 240); assert.equal(warn.casefile.status, "archive_warning"); assert.equal(warn.event!.type, "du.casefile.archive_warning"); assert.equal(warn.event!.payload.non_blocking, true);
  assert.equal(archivalWatch(h.events, warn.casefile, D("2027-07-10"), { loan_purchased: false }).action, "none");   // sent once
  assert.equal(archivalWatch(h.events, warn.casefile, D("2027-08-01"), { loan_purchased: false }).action, "none");
  const arch = archivalWatch(h.events, warn.casefile, D("2027-08-02"), { loan_purchased: false });
  assert.equal(arch.action, "archived"); assert.equal(arch.day, 270); assert.equal(arch.casefile.status, "archived"); assert.equal(arch.informational, false); assert.equal(arch.next, "open_new_casefile"); assert.equal(arch.event!.payload.severity, "sev2"); assert.equal(arch.event!.payload.owner, "underwriter");
  // the new casefile under current policies supersedes the archived one (B3-2-01: "subject to the policies in effect for the current version of DU")
  const re = createCasefile(h.events, { application_id: "APP-R", seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at: "2027-08-02T15:00:00.000Z", supersedes: arch.casefile, supersede_reason: "archived" });
  assert.equal(re.superseded!.superseded_by_casefile_id, re.casefile.casefile_id); assert.equal(re.superseded!.supersede_reason, "archived"); assert.equal(h.emitted("du.casefile.superseded").length, 1); assert.deepEqual(h.emitted("du.casefile.superseded")[0]!.payload.rerun, ["23.2", "23.3"]);
  // purchased Thu Nov 19, 2026 → the archive event is informational only (Fannie Mae holds the findings)
  const purchased = archivalWatch(h.events, warn.casefile, D("2027-08-02"), { loan_purchased: true });
  assert.equal(purchased.action, "archived"); assert.equal(purchased.informational, true); assert.equal(purchased.next, null); assert.equal(purchased.event!.payload.informational, true); assert.equal(purchased.event!.payload.severity, null);
  // `loan.purchased` (30.1) on Nov 19 closes the 540 clock
  h.events.append({ type: "loan.purchased", applicationId: "APP-R", loanId: "L-R", actor: { kind: "agent", id: "delivery" }, occurredAt: "2026-11-19T20:00:00.000Z", payload: { application_id: "APP-R", loan_id: "L-R", purchase_date: "2026-11-19" } });
  assert.equal(h.byCode("FNMA_B3_2_01_DU_ARCHIVE_540")[0]!.status, "satisfied");
});

test("23.1-T11: Given two borrowers whose reports carry different score models (one VantageScore 4.0, one Classic FICO), then `associateCredit` refuses the submission with `error_code = SCORE_MODEL_MIXED` and 22.2 is asked to re-order.", async () => {
  const h = harness("2026-10-06T15:00:00.000Z");
  const cf0 = h.create(REFI, "2026-10-06T15:00:00.000Z");
  const mixed = [mkReport({ report_id: "R-B1", application_id: "APP-R", borrower_ids: ["B1"], score_model: "vantagescore_4" }), mkReport({ report_id: "R-B2", application_id: "APP-R", borrower_ids: ["B2"], score_model: "classic_fico" })];
  assert.throws(() => associateCredit(h.events, cf0, { reports: mixed, borrowers: REFI.borrowers, app_score_model: "classic_fico", at: h.clock.now() }), (e: unknown) => e instanceof DuRefused && e.error_code === "SCORE_MODEL_MIXED" && e.next === "22.2 re-order" && /cannot mix credit score models/.test(e.citation));
  const errored = h.emitted("du.submission.errored"); assert.equal(errored.length, 1); assert.equal(errored[0]!.payload.error_code, "SCORE_MODEL_MIXED"); assert.match(String(errored[0]!.payload.next), /22\.2 re-orders/);
  assert.equal(h.emitted("du.credit.associated").length, 0);
  // one model on both reports but not the application's → still refused (22.2 R11); one model everywhere → associated
  assert.throws(() => associateCredit(h.events, cf0, { reports: [mkReport({ report_id: "R-VS", application_id: "APP-R", borrower_ids: ["B1", "B2"], score_model: "vantagescore_4" })], borrowers: REFI.borrowers, app_score_model: "classic_fico", at: h.clock.now() }), (e: unknown) => e instanceof DuRefused && e.error_code === "SCORE_MODEL_MIXED");
  assert.equal(h.associate(cf0, REFI).status, "credit_associated");
  // the same refusal through the `associateCredit` bus tool (guardrail 'never mix score models' refuses before the handler runs)
  const agents = new AgentRegistry(); const ctx = uow(h, "APP-R");
  const rt: ToolRuntime = { store: new EntityStore(), escalations: h.escalations, services: { "fnma-du": h.port }, ports: {} };
  const cmds = bindSection23(rt, agents); const bus = new CommandBus(agents);
  await assert.rejects(bus.execute(cmds.get(toolKey("23.1", "associateCredit"))!, AGENT, { casefile: cf0, reports: mixed, borrowers: REFI.borrowers, app_score_model: "classic_fico" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "SCORE_MODEL_MIXED");
});

test("23.1-T12: Given a borrower SSN correction after credit association, then the casefile requires a new credit association (`DU_JOBAID_IDENTITY_CHANGE`), a fraud signal is sent to 22.6, and the prior submission is marked `superseded`.", async () => {
  const h = harness("2026-10-06T15:00:00.000Z"); const first = await firstRun(h);
  // 22.6 corrects B2's SSN after credit association
  const corrected: BorrowerIdentity[] = [B1, { ...B2, ssn_last4: "5679" }];
  const changes = detectIdentityChange(REFI.borrowers, corrected);
  assert.deepEqual(changes, [{ borrower_id: "B2", field: "ssn", old_value: "***-**-5678", new_value: "***-**-5679" }]);
  const r = recordIdentityChange(h.events, first.casefile, first.submission, changes[0]!, "2026-10-12T15:00:00.000Z");
  assert.equal(r.check.rule_code, "DU_JOBAID_IDENTITY_CHANGE"); assert.equal(r.check.result, "resubmission_required"); assert.equal(r.check.field, "borrower_identity"); assert.equal(r.check.arithmetic.new_credit_association_required, true);
  assert.equal(r.prior!.status, "superseded"); assert.equal(r.casefile.status, "draft"); assert.deepEqual(r.casefile.credit_association.map((a) => a.borrower_id), ["B1"]);
  const signal = h.emitted("du.identity_change.detected"); assert.equal(signal.length, 1); assert.equal(signal[0]!.payload.fraud_signal_to, "22.6"); assert.equal(signal[0]!.payload.borrower_id, "B2"); assert.equal(signal[0]!.payload.superseded_submission_id, first.submission.submission_id);
  assert.equal(h.emitted("du.resubmission.required").at(-1)!.payload.new_credit_association_required, true);
  // no request can be built until B2's report is re-associated; after the new association (22.2 re-pull, 4-month clock restarted) the resubmission goes out
  assert.throws(() => buildDuRequest(r.casefile, { submission_type: "underwriting_only", reason: "credit_refresh", built_at: "2026-10-12T15:00:00.000Z", snapshot: { ...REFI, borrowers: corrected } }), (e: unknown) => e instanceof DuRefused && e.error_code === "REPORT_MISSING_FOR_BORROWER");
  const re = h.associate(r.casefile, { ...REFI, borrowers: corrected }, [mkReport({ report_id: "R-new", application_id: "APP-R", borrower_ids: ["B1", "B2"], report_date: D("2026-10-12") })]);
  assert.equal(re.status, "credit_associated"); assert.equal(re.credit_association.length, 2);
  const r2 = await h.submit(re, { ...REFI, borrowers: corrected }, [r.prior!], { type: "underwriting_only", reason: "credit_refresh", at: "2026-10-12T16:00:00.000Z" });
  assert.equal(r2.submission.submission_number, 2); assert.equal(r2.submission.reason, "credit_refresh"); assert.equal(r2.submission.status, "findings_received");
});

test("23.1-T13: Given the DI channel returns transport errors for 30 minutes on Wed Nov 4, 2026, then an `escalation{fnma_portal_operator}` is opened with the request file attached; on manual submission the operator-uploaded findings are ingested and matched to the queued `du_submissions` row by casefile ID.", async () => {
  const outage = new OutageDuPort();
  const h = harness("2026-11-04T15:00:00.000Z", { port: outage });
  const cf0 = h.create(REFI, "2026-10-06T15:00:00.000Z"); const cf1 = h.associate(cf0, REFI);
  const r = await h.submit(cf1, REFI, [], { at: "2026-11-04T15:00:00.000Z", escalate: true });
  // exponential backoff: 4 attempts over 30 minutes (2 + 4 + 8 + 16), then the operator path
  assert.equal(outage.attempts, 4); assert.equal(DI_OUTAGE_AFTER_MINUTES, 30); assert.equal(r.outage!.attempts, 4); assert.equal(r.outage!.declared_at, "2026-11-04T15:30:00.000Z");
  assert.equal(r.submission.status, "queued"); assert.equal(r.submission.error_code, "DI_TRANSPORT_OUTAGE"); assert.equal(r.casefile.status, "error"); assert.equal(h.emitted("du.submitted").length, 0);
  const attempts = h.emitted("du.submission.errored").filter((e) => e.payload.error_code === "DI_TRANSPORT");
  assert.deepEqual(attempts.map((e) => e.occurredAt), ["2026-11-04T15:00:00.000Z", "2026-11-04T15:02:00.000Z", "2026-11-04T15:06:00.000Z", "2026-11-04T15:14:00.000Z"]);
  // escalation{fnma_portal_operator} with the exact request file attached
  const esc = r.outage!.escalation!;
  assert.equal(esc.kind, "human_portal_task"); assert.equal(esc.ownerRole, "fnma_portal_operator"); assert.equal(esc.applicationId, "APP-R"); assert.equal(esc.payload.request_file, r.request.xml_document); assert.equal(esc.payload.request_hash, r.request.request_hash); assert.equal(esc.payload.casefile_id, cf1.casefile_id);
  assert.match(String(esc.payload.reason), /accessdodu\.fanniemae\.com/); assert.match(String(esc.payload.reason), /no scraping\/RPA/);
  assert.equal(h.escalations.list().length, 1);
  // manual submission: the operator uploads the SM-generated file and the exported findings are ingested, matched to the queued du_submissions row by casefile ID
  const fake = new FakeDuPort(h.clock); await fake.submit(r.request, 99);
  const uploaded = { ...(await fake.fetchFindings(cf1.casefile_id, 99)), submission_number: 99 };
  assert.throws(() => ingestOperatorFindings(h.events, r.casefile, [r.submission], uploaded, AGENT), /fnma_portal_operator/);
  const got = ingestOperatorFindings(h.events, r.casefile, [r.submission], uploaded, OPERATOR);
  assert.equal(got.submission.submission_id, r.submission.submission_id); assert.equal(got.submission.submission_number, 1); assert.equal(got.submission.status, "findings_received"); assert.equal(got.submission.submitted_via, "du_ui_fallback"); assert.equal(got.submission.error_code, null); assert.equal(got.submission.recommendation, "approve_eligible");
  assert.equal(got.casefile.status, "findings_received"); assert.equal(h.emitted("du.findings.received")[0]!.payload.submitted_via, "du_ui_fallback");
  assert.throws(() => ingestOperatorFindings(h.events, got.casefile, [got.submission], uploaded, OPERATOR), (e: unknown) => e instanceof DuRefused && e.error_code === "NO_QUEUED_SUBMISSION");
});

test("23.1-T14: Given a request built on Dec 1, 2026 with `return_file_types` containing type 16, then the adapter rejects it before transmission (`FNMA_DU_RETURN_FILE_16_17_RETIRE`).", async () => {
  const h = harness("2026-12-01T15:00:00.000Z");
  const cf1 = h.associate(h.create(REFI, "2026-10-06T15:00:00.000Z"), REFI);
  const build = (built_at: string, types: DuRequest["return_file_types"]) => buildDuRequest(cf1, { submission_type: "underwriting_only", reason: "data_change", built_at, snapshot: REFI, return_file_types: types });
  assert.throws(() => build("2026-12-01T15:00:00.000Z", ["json_v2", "16"]), (e: unknown) => e instanceof DuRefused && e.error_code === "FNMA_DU_RETURN_FILE_16_17_RETIRE" && /retired Nov 30, 2026/.test(e.message));
  assert.throws(() => build("2026-12-01T15:00:00.000Z", ["17"]), (e: unknown) => e instanceof DuRefused && e.error_code === "FNMA_DU_RETURN_FILE_16_17_RETIRE");
  assert.equal(h.port instanceof FakeDuPort ? h.port.requests.length : -1, 0);   // rejected before transmission
  assert.deepEqual(build("2026-11-30T15:00:00.000Z", ["json_v2", "16"]).return_file_types, ["json_v2", "16"]);   // still accepted on Nov 30
  assert.deepEqual(build("2026-12-01T15:00:00.000Z", ["json_v2", "pdf_standard"]).return_file_types, ["json_v2", "pdf_standard"]);
  assert.equal(returnFileTypeGate({ built_on: "2026-12-01", return_file_types: ["16"] }).open, false); assert.equal(evaluateGate("23.1.returnFileTypeGate", { built_on: "2026-12-01", return_file_types: ["json_v2"] }).open, true);
  // the platform rows: the Sept 25, 2026 memo (published July 29) arms the 120-day support clock (Nov 26, 2026) and the retirement gate; the adapter release tag satisfies the clock
  const memo = recordImpactMemo(h.events, { memo_id: "du-v121-impact-memo-sept-25-2026", memo_date: D("2026-07-29"), spec_version: "DU Spec 2026-09 (MISMO 3.4 B324)", return_file_types_retired: { types: ["16", "17"], retire_on: D("2026-11-30") }, at: "2026-07-29T15:00:00.000Z" });
  assert.equal(memo.support_due, "2026-11-26"); assert.equal(memo.event.payload.return_file_retirement_date, "2026-11-30");
  assert.equal(h.byCode("FNMA_DU_IMPACT_MEMO_SUPPORT_120")[0]!.dueDate, "2026-11-26"); assert.equal(h.byCode("FNMA_DU_RETURN_FILE_16_17_RETIRE")[0]!.note, "evaluator:23.1.returnFileTypeGate");
  tagAdapterRelease(h.events, { spec_version: "DU Spec 2026-09 (MISMO 3.4 B324)", tag: "integrations/fnma-du@2026.09", at: "2026-08-26T15:00:00.000Z" });
  assert.equal(h.byCode("FNMA_DU_IMPACT_MEMO_SUPPORT_120")[0]!.status, "satisfied");
  confirmReturnFileFormat(h.events, { formats: ["json_v2", "pdf_standard"], environment: "production", at: "2026-11-15T15:00:00.000Z" });
  assert.equal(h.byCode("FNMA_DU_RETURN_FILE_16_17_RETIRE")[0]!.status, "satisfied");
  assert.throws(() => confirmReturnFileFormat(h.events, { formats: ["json_v2", "16"], environment: "production", at: "2026-11-15T15:00:00.000Z" }), (e: unknown) => e instanceof DuRefused && e.error_code === "FNMA_DU_RETURN_FILE_16_17_RETIRE");
});

test("23.1-T15: Given a HomeReady casefile submitted with $6,250.00 monthly qualifying income, when verified income is $6,400.00, then `du_resubmission_checks.result = resubmission_required` with `rule_code = B3_2_10_INCOME_LIMITED` (B3-2-10: \"Income is greater than the loan application indicates\") and 23.2 re-runs the AMI test; when verified income is $6,100.00 and the recalculated DTI stays under 45% with a delta below 3 points, then the income-limited rule does not fire and the result is `within_tolerance` (the DTI test alone governs the decrease).", async () => {
  const h = harness("2026-10-20T15:00:00.000Z"); const first = await firstRun(h, PURCHASE, "2026-10-20T15:00:00.000Z");
  assert.equal(first.submission.snapshot.qualifying_income_cents, 625_000n); assert.equal(first.submission.dti_du, "40.00");
  // verified income $6,400.00 > $6,250.00 → B3_2_10_INCOME_LIMITED, AMI re-test by 23.2
  const up = incomeLimitedTest(625_000n, 640_000n, true);
  assert.equal(up.rule_code, "B3_2_10_INCOME_LIMITED"); assert.equal(up.result, "resubmission_required"); assert.equal(up.ami_retest, "23.2"); assert.match(up.citation, /Income is greater than the loan application indicates/);
  const ev = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: { ...PURCHASE, qualifying_income_cents: 640_000n }, trigger_event: "income.finalized", at: "2026-10-26T15:00:00.000Z" });
  assert.equal(ev.result, "resubmission_required"); assert.deepEqual(ev.rule_codes, ["B3_2_10_INCOME_LIMITED"]); assert.equal(ev.ami_retest, "23.2"); assert.equal(ev.event.payload.ami_retest, "23.2");
  const row = ev.checks.find((c) => c.rule_code === "B3_2_10_INCOME_LIMITED")!; assert.equal(row.field, "income"); assert.equal(row.old_value, 625_000n); assert.equal(row.new_value, 640_000n);
  assert.equal(ev.checks.find((c) => c.rule_code === "B3_2_10_DTI_45_OR_3PT")!.result, "within_tolerance");   // 39.06 %, −0.94
  // verified income $6,100.00: the income-limited rule does not fire; DTI 40.98 % (+0.98 < 3, < 45) → within_tolerance, AMI re-run on the verified figure
  const down = incomeLimitedTest(625_000n, 610_000n, true);
  assert.equal(down.rule_code, null); assert.equal(down.evaluate_dti, true); assert.equal(down.ami_retest, "23.2");
  const ev2 = evaluateResubmission(h.events, first.casefile, { baseline: first.submission, candidate: { ...PURCHASE, qualifying_income_cents: 610_000n }, trigger_event: "income.finalized", at: "2026-10-26T15:00:00.000Z" });
  assert.equal(ev2.result, "within_tolerance"); assert.deepEqual(ev2.checks.map((c) => c.rule_code), ["B3_2_10_DTI_45_OR_3PT"]); assert.equal(ev2.arithmetic.dti_after, "40.98"); assert.equal(ev2.arithmetic.dti_delta, "0.98"); assert.equal(ev2.event.type, "du.resubmission.waived");
  // not an income-limited product: the same increase is governed by DTI alone
  assert.equal(incomeLimitedTest(1_200_000n, 1_250_000n, false).rule_code, null);
});

test("23.1 worked figures: P&I $3,402.62 (fixture $3,402.63) / $3,448.02, obligations $4,560.00 → DTI 38.00 % (+$450.00 → 41.75 %), 1 % = $5,600.00 vs the $500 cap, reserves $8,000.00 → $7,300.00 / $7,100.00, archival Mar 29, 2028 / Aug 2, 2027, the Sept 25, 2026 cutover", async () => {
  // Worked example 1 (rule 7): $560,000 × 0.0051041667 / (1 − 1.0051041667^−360) = $3,402.619 → $3,402.62 half-up; the fixture's $3,402.63 is a round-up convention (26.1 owns note rounding)
  const pi = piCents(56_000_000n, "6.125", 360); assert.equal(pi, 340_262n);
  const unrounded = piUnrounded(56_000_000n, "6.125", 360);
  assert.equal(unrounded.toFixed(3, "DOWN"), "3402.619"); assert.equal(formatCents(unrounded.toCents("DOWN")), "$3,402.61");   // truncated: the spec's "$3,402.619" reads $3,402.61 before rounding
  assert.equal(formatCents(pi), "$3,402.62"); const fixturePi = 340_263n; assert.equal(fixturePi - pi, 1n); assert.equal(formatCents(fixturePi), "$3,402.63");   // the fixture's round-up convention sits one cent above half-up (26.1 owns note rounding; results identical at either value)
  // taxes $500.00 + insurance $120.00 = $620.00; other debts $537.37; obligations (at the fixture's $3,402.63) $4,560.00 → DTI 38.00 % — identical at $3,402.62 (455,999 → 38.00)
  const escrow = 50_000n + 12_000n; assert.equal(escrow, 62_000n); assert.equal(formatCents(escrow), "$620.00"); assert.equal(formatCents(12_000n), "$120.00");
  const obligations = 340_263n + escrow + 53_737n; assert.equal(obligations, 456_000n); assert.equal(formatCents(obligations), "$4,560.00"); assert.equal(formatCents(53_737n), "$537.37");
  assert.equal(dtiBps(obligations, 1_200_000n), 3800); assert.equal(dtiBps(340_262n + escrow + 53_737n, 1_200_000n), 3800);
  // + $450.00 auto loan → 41.75 % (+3.75 → resubmit); + $300.00 → 40.50 % (+2.50 → waived)
  assert.equal(formatCents(45_000n), "$450.00"); assert.equal(dtiTest({ obligations_cents: obligations, income_cents: 1_200_000n }, { obligations_cents: obligations + 45_000n, income_cents: 1_200_000n }).dti_after, "41.75");
  assert.equal(dtiTest({ obligations_cents: obligations, income_cents: 1_200_000n }, { obligations_cents: obligations + 30_000n, income_cents: 1_200_000n }).result, "within_tolerance");
  // Worked example 2 (rule 8): max_increase = min($500.00, 1 % × $560,000 = $5,600.00) = $500.00 → ceiling $560,500; $565,600 exceeds it; LTV 70.00 % → 70.70 %
  const tol = refiAmountTolerance(56_000_000n); assert.equal(tol.one_pct_cents, 560_000n); assert.equal(formatCents(tol.one_pct_cents), "$5,600.00"); assert.equal(tol.max_increase_cents, 50_000n); assert.equal(tol.ceiling_cents, 56_050_000n);
  assert.equal(loanAmountTest({ loan_purpose: "limited_cash_out_refinance", loan_amount_cents: 56_000_000n, appraised_value_cents: 80_000_000n }, { loan_amount_cents: 56_560_000n, appraised_value_cents: 80_000_000n }).ltv_after, "70.7000");
  // Worked example 3 (rule 9): re-locked at 6.250 % → P&I $3,448.02; DTI = ($3,448.02 + $620.00 + $537.37) / $12,000.00 = 38.38 % (+0.38 < 3) → no B3-2-10 resubmission; rule 5 resubmits anyway
  const pi625 = piCents(56_000_000n, "6.250", 360); assert.equal(pi625, 344_802n); assert.equal(formatCents(pi625), "$3,448.02");
  const d = dtiTest({ obligations_cents: obligations, income_cents: 1_200_000n }, { obligations_cents: pi625 + escrow + 53_737n, income_cents: 1_200_000n });
  assert.equal(d.dti_after, "38.38"); assert.equal(d.delta, "0.38"); assert.equal(d.result, "within_tolerance"); assert.equal(rateTest("6.125", "6.250").evaluate_dti, true);
  // Worked example 4 (rule 10): "Reserves Required to be Verified" $8,000.00; $7,300.00 = 91.25 % → within; $7,100.00 = 88.75 % → resubmit; casefile Tue Oct 20 → archive_540 Wed Apr 12, 2028
  assert.equal(formatCents(800_000n), "$8,000.00"); assert.equal(reservesTest(800_000n, 730_000n).verified_pct, "91.25"); assert.equal(formatCents(730_000n), "$7,300.00"); assert.equal(reservesTest(800_000n, 710_000n).verified_pct, "88.75"); assert.equal(formatCents(710_000n), "$7,100.00");
  assert.equal(reservesTest(800_000n, 710_000n).result, "resubmission_required"); assert.equal(archivalClocks(D("2026-10-20"), D("2026-10-20")).archive_540_due_at, "2028-04-12");
  // Rule 1 (archival) and rule 11 (version cutover): casefile Thu Sept 24, 2026 keeps policy generation 2026_06_27 (creation-keyed) but its first resubmission after the evening of Sept 25 carries du_release_applied 2026_09_25
  assert.equal(archivalClocks(D("2026-10-06"), D("2026-11-05")).archive_540_due_at, "2028-03-29"); assert.equal(archivalClocks(D("2026-10-06"), D("2026-11-05")).archive_270_due_at, "2027-08-02");
  const h = harness("2026-09-24T15:00:00.000Z"); const sep24 = await firstRun(h, REFI, "2026-09-24T15:00:00.000Z");
  assert.equal(sep24.casefile.policy_generation, "2026_06_27"); assert.equal(sep24.submission.du_release_applied, "2026_09_09");
  const sep28 = await h.submit(sep24.casefile, { ...REFI, total_obligations_cents: 501_000n }, [sep24.submission], { at: "2026-09-28T15:00:00.000Z" });
  assert.equal(sep28.submission.du_release_applied, "2026_09_25"); assert.equal(sep28.casefile.policy_generation, "2026_06_27");
  const cut = h.emitted("du.version.cutover_applied"); assert.equal(cut.length, 1); assert.equal(cut[0]!.payload.from, "2026_09_09"); assert.equal(cut[0]!.payload.to, "2026_09_25"); assert.ok((cut[0]!.payload.creation_keyed_unchanged as string[]).includes("du_validation_service.close_by_business_days"));
  // Rule 3 idempotency: an identical whole-file snapshot is suppressed unless error_retry / final_closed_loan_match; rule 6: rationale after 10, reviewer after 15
  await assert.rejects(h.submit(sep28.casefile, { ...REFI, total_obligations_cents: 501_000n }, [sep24.submission, sep28.submission], { at: "2026-09-29T15:00:00.000Z" }), (e: unknown) => e instanceof DuRefused && e.error_code === "DUPLICATE_REQUEST_SUPPRESSED");
  const capped = { ...sep28.casefile, submission_count: 15 };
  await assert.rejects(h.submit(capped, { ...REFI, total_obligations_cents: 502_000n }, [sep24.submission, sep28.submission], { at: "2026-09-29T15:00:00.000Z" }), (e: unknown) => e instanceof DuRefused && e.error_code === "RESUBMISSION_CAP_REVIEW" && e.next === "underwriting_reviewer");
  await assert.rejects(h.submit({ ...capped, submission_count: 10 }, { ...REFI, total_obligations_cents: 502_000n }, [sep24.submission, sep28.submission], { at: "2026-09-29T15:00:00.000Z" }), (e: unknown) => e instanceof DuRefused && e.error_code === "RESUBMISSION_RATIONALE_REQUIRED");
  // guard: 21.1's SCIF gate blocks du.submit
  const req = buildDuRequest(sep28.casefile, { submission_type: "underwriting_only", reason: "data_change", built_at: "2026-09-29T15:00:00.000Z", snapshot: { ...REFI, total_obligations_cents: 503_000n } });
  await assert.rejects(submitCasefile(h.events, h.port, sep28.casefile, { request: req, at: "2026-09-29T15:00:00.000Z", prior: [sep24.submission, sep28.submission], projected_note_date: D("2026-11-06"), scif_facts: { borrowers: [{ id: "B1", scif_presented_at: "2026-10-05T16:00:00.000Z" }, { id: "B2" }] } }), (e: unknown) => e instanceof DuRefused && e.error_code === "SM_O21_SCIF_PRESENT_GATE" && /du\.submit blocked/.test(e.message));
  // guard: a report expiring before the projected note date blocks a non-refresh resubmission (22.2's four-month gate); the closed-loan-field rule is unconditional
  await assert.rejects(submitCasefile(h.events, h.port, sep28.casefile, { request: req, at: "2026-09-29T15:00:00.000Z", prior: [sep24.submission, sep28.submission], projected_note_date: D("2027-02-06"), scif_facts: scifFacts(REFI) }), /B1-1-03/);
  assert.equal(closedLoanFieldsTest(REFI, { ...REFI, occupancy: "second_home" }).rule_code, "B3_2_10_CLOSED_LOAN_FIELD");
});
