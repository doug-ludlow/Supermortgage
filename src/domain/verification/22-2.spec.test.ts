// 22.2 Credit report ordering, credit-score model and merge rules, analysis, freezes/disputes, inquiries, and pre-closing refresh (undisclosed-debt monitoring)
// spec/sections/22-documents-credit-income-assets-liabilities-identity-and-frau/22-2-credit-report-ordering-credit-score-model-and-merge-rules-an.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { toIso, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_22_2 } from "../../app/tools/section22-2.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { checkFeeGate } from "../application/ops-21-4.ts";
import { scoreBand } from "../leads-pricing/ops-20-4.ts";
import {
  CreditGateClosed, CreditRefused, applicableScore, assertDuSubmittable, assertGateOpen, b3210ToleranceCheck, chargeCreditReportFee, collectionsCondition, computeScores, dtiTenths, dtiText, expiresAt, newDebtImpact, refreshWindowStart, repullBy, scoreDisclosurePayloads, sfcAssertion, waitingPeriod, warnDate,
  type BorrowerCredit, type CreditBureauPort, type CreditOrder, type CreditReport, type CreditReportResponse, type FreezeAction, type Repository,
} from "./ops-22-2.ts";

const AGENT: Actor = { kind: "agent", id: "verification" };
const APP = "app-refi-1", LOAN = "L-REFI-1", A = "B-A", B = "B-B";
const SUBSCRIBER = "SUB-PARTNER-0417";
const CRA = { name: "Xactus360 (reseller for Equifax, Experian, TransUnion)", address: "PO Box 1000, Broomall PA 19008", phone: "800-555-0100" };
/** Creditor time (Phoenix: MST all year, UTC−7). */
const mst = (date: string, hhmm: string): string => toIso(zonedEpochMs(D(date), hhmm, "America/Phoenix"));
const sc = (score: number | null, key_factors = ["Proportion of balances to credit limits is too high", "Too many inquiries last 12 months"]) => ({ score, model_version: "Classic FICO", key_factors });
const ALL: Repository[] = ["efx", "exp", "tu"];
/** Refinance fixture, two borrowers, Classic FICO: A 742/751/760, B 698/712/705. */
const borrowerA = (): BorrowerCredit => ({ borrower_id: A, scores: { efx: sc(742), exp: sc(751), tu: sc(760) }, returned: ALL, frozen: [] });
const borrowerB = (): BorrowerCredit => ({ borrower_id: B, scores: { efx: sc(698), exp: sc(712), tu: sc(705) }, returned: ALL, frozen: [] });
const JOINT_INTENT = { trid_received_at: mst("2026-10-05", "10:41"), borrowers: [{ id: A, joint_intent_affirmed_at: mst("2026-10-05", "10:20"), added_at: mst("2026-10-05", "10:05") }, { id: B, joint_intent_affirmed_at: mst("2026-10-05", "10:22"), added_at: mst("2026-10-05", "10:06") }] };
const ORDER: ToolInput = { borrower_ids: [A, B], permissible_purpose: "credit_transaction_604a3A", certification_ref: "CERT-PARTNER-1681E-2026", borrower_authorization_ref: "AUTH-BLANKET-2026-10-05", subscriber_code: SUBSCRIBER };

interface Scenario { report_date: PlainDate; received_at: string; borrowers: BorrowerCredit[]; extra?: Partial<CreditReportResponse>; }
class FakeBureau implements CreditBureauPort {
  readonly orders: CreditOrder[] = [];
  scenario: Scenario;
  constructor(s: Scenario) { this.scenario = s; }
  async order(o: CreditOrder): Promise<CreditReportResponse> {
    this.orders.push(o);
    const s = this.scenario;
    return { credit_reference_number: `CRN-${o.order_type}-${o.attempt}-${s.report_date}`, du_credit_provider_code: "DUP-0417", reseller: "Xactus360", report_date: s.report_date, received_at: s.received_at, borrowers: s.borrowers.filter((b) => o.borrower_ids.includes(b.borrower_id)), trended_data: true, cra: CRA, fee_cents: 3_500n, ...(s.extra ?? {}) };
  }
}
const OCT5: Scenario = { report_date: D("2026-10-05"), received_at: mst("2026-10-05", "10:52"), borrowers: [borrowerA(), borrowerB()] };

/** The 22.2 tools on the bus over the overridden registry (22.2 rows plus 21.3's score-notice clock and 22.6's alert gate that arm on this process's events), the fake reseller, the escalation service and an entity store seeded with the application. */
function harness(nowIso: string, scenario: Scenario = OCT5, app: Record<string, unknown> = {}) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock, { applicationId: APP });
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["22.2", "21.3", "22.6"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId: LOAN, applicationId: APP, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const bureau = new FakeBureau(scenario);
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: { credit_bureau: bureau }, ports: {} };
  rt.store.put("applications", APP, { occupancy: "primary", units: 1, borrower_ids: [A, B], joint_intent_facts: JOINT_INTENT, ...app }, AGENT, nowIso);
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_22_2); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("22.2", name))!, actor, { application_id: APP, ...input }, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.ofType(type).filter((e) => e.applicationId === APP);
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt = clock.now(), actor: Actor = { kind: "agent", id: "intake" }) => events.append({ type, applicationId: APP, aggregate: { kind: "application", id: APP }, actor, occurredAt, payload: { application_id: APP, ...payload } });
  /** Six items Mon Oct 5 10:41 MST (21.1) and the credit-report fee handled under §1026.19(e)(2)(i)(B) through 21.4's gate (fee.gate.checked{fee_kind=credit_report}). */
  const prerequisites = (tridAt = mst("2026-10-05", "10:41"), feeAt = mst("2026-10-05", "10:45")) => {
    upstream("application.trid_received", { trid_received_at: tridAt, trid_application_date: "2026-10-05" }, tridAt);
    checkFeeGate(events, { application_id: APP, command: "order_credit_report", fee_kind: "credit_report", amount_cents: 3_500n, checked_at: feeAt, le_effective_receipt_date: null, intent: null, vendor_invoice_cents: 3_500n, time_zone: "America/Phoenix" });
  };
  const report = (id: string): CreditReport => rt.store.require("credit_reports", id).data as unknown as CreditReport;
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  /** The application's hard tri-merge: order (validated, reseller, received), then parse. */
  const pull = async (extra: ToolInput = {}) => { prerequisites(); const o = await run("orderCreditReport", { ...ORDER, at: scenario.received_at, ...extra }); const p = await run("parseCreditReport", { report_id: o.report_id }); return { order: o, parsed: p, id: String(o.report_id) }; };
  return { clock, events, timers, rt, bureau, run, at, timer, ofType, upstream, prerequisites, report, refused, pull, decisions };
}

test("22.2-T1: (representative score) Given Borrower A scores 742/751/760 and Borrower B 698/712/705, when computed, then applicable scores are 751 and 705 and `representative_score = 705` with `representative_score_borrower_id = B`.", async () => {
  assert.equal(applicableScore([742, 751, 760]), 751); assert.equal(applicableScore([698, 712, 705]), 705); assert.equal(applicableScore([698, 705]), 698); assert.equal(applicableScore([712]), 712); assert.equal(applicableScore([]), null);
  const pure = computeScores([borrowerA(), borrowerB()]);
  assert.deepEqual(pure.borrower_applicable_scores, { [A]: 751, [B]: 705 }); assert.equal(pure.representative_score, 705); assert.equal(pure.representative_score_borrower_id, B); assert.deepEqual(pure.no_score_borrowers, []);
  const h = harness(mst("2026-10-05", "11:00"));
  const out = await h.run("computeScores", { borrowers: [borrowerA(), borrowerB()], score_model: "classic_fico" });
  assert.equal(out.representative_score, 705); assert.equal(out.representative_score_borrower_id, B); assert.deepEqual(out.borrower_applicable_scores, { [A]: 751, [B]: 705 });
  assert.deepEqual(out.llpa_band, { row: "700–719", no_score: false });   // R2: band 700–719 on the Classic FICO LCOR grid (20.4 loads the value)
  // the full pull records the same computation on the report and emits credit.representative_score.computed
  const { id, parsed } = await h.pull();
  assert.equal(parsed.representative_score, 705); assert.equal(h.report(id).representative_score_borrower_id, B); assert.equal(h.report(id).score_model, "classic_fico");
  assert.equal((h.ofType("credit.representative_score.computed")[0]!.payload as { representative_score: number }).representative_score, 705);
  // a borrower without a score is left out (B3-5.1-02); nobody scored → null and the lowest band
  const mixed = computeScores([borrowerA(), { borrower_id: B, scores: {}, returned: ALL, frozen: [] }]); assert.equal(mixed.representative_score, 751); assert.deepEqual(mixed.no_score_borrowers, [B]);
  assert.equal(computeScores([{ borrower_id: A, scores: {}, returned: ALL, frozen: [] }]).representative_score, null); assert.equal(scoreBand("classic_fico", null).row, "≤639");
});

test("22.2-T2: (single freeze) Given Borrower B's Experian file is frozen and EFX 698 / TU 705 are returned on a requested tri-merge, when parsed, then the report is `usable`, B's applicable score is 698, `representative_score = 698`, and `credit.freeze.detected` is emitted with a borrower notice offering a lift and re-pull.", async () => {
  const frozenB: BorrowerCredit = { borrower_id: B, scores: { efx: sc(698), tu: sc(705) }, returned: ["efx", "tu"], frozen: ["exp"] };
  const h = harness(mst("2026-10-05", "11:00"), { ...OCT5, borrowers: [borrowerA(), frozenB] });
  const { id, parsed, order } = await h.pull();
  assert.deepEqual((order.order as CreditOrder).repositories, ALL);   // a tri-merge was requested (three repositories)
  assert.equal(parsed.state, "usable"); assert.equal(h.report(id).borrower_applicable_scores[B], 698); assert.equal(parsed.representative_score, 698); assert.equal(h.report(id).representative_score_borrower_id, B);
  assert.deepEqual(h.report(id).frozen_repositories, ["exp"]); assert.deepEqual(h.report(id).repositories_returned, ALL);
  assert.equal((parsed.du as { submittable: boolean }).submittable, true);
  assert.equal(scoreBand("classic_fico", 698).row, "680–699");   // R2: a different price than 705's 700–719 band, which is why the freeze workflow runs before the lock is priced as final (21.4)
  h.at(mst("2026-10-06", "14:10"));
  const d = await h.run("detectFreezes", { report_id: id, at: mst("2026-10-06", "14:10") });
  assert.equal(d.blocks_du, false);
  const ev = h.ofType("credit.freeze.detected"); assert.equal(ev.length, 1);
  const p = ev[0]!.payload as Record<string, unknown>;
  assert.equal(p.borrower_id, B); assert.deepEqual(p.repositories, ["exp"]); assert.equal(p.frozen_count, 1); assert.equal(p.blocks_du, false); assert.equal(p.borrower_notified_at, mst("2026-10-06", "14:10"));
  const notice = p.borrower_notice as Record<string, unknown>;
  assert.equal(notice.template_code, "NTC_SM_NEEDS_LIST"); assert.deepEqual(notice.offers, ["lift_freeze", "re_pull"]); assert.deepEqual(notice.items, ["lift the security freeze at Experian"]);
  assert.match(String(notice.statement), /may change the price/); assert.doesNotMatch(String(notice.statement), /will improve/); assert.match(String(notice.lift_instructions), /1 hour/);
  const actions = d.actions as FreezeAction[]; assert.equal(actions.length, 1); assert.equal(actions[0]!.status, "open"); assert.equal(actions[0]!.repository, "exp");
  // SM_CREDIT_FREEZE_FOLLOWUP_2 anchors on borrower_notified_at (Tue Oct 6 MST) → +2 calendar days
  const t = h.timer("SM_CREDIT_FREEZE_FOLLOWUP_2")!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-06"); assert.equal(t.dueDate, "2026-10-08");
});

test("22.2-T3: (two freezes) Given freezes at EXP and TU, when parsed, then the report is `freeze_blocked`, `submitDu` is refused, and after `credit.freeze.lifted` on Wed Oct 7, 2026 the re-pull supersedes the Oct 5 report with `expires_at = Feb 7, 2027`.", async () => {
  const twoFrozen: BorrowerCredit = { borrower_id: B, scores: { efx: sc(698) }, returned: ["efx"], frozen: ["exp", "tu"] };
  const h = harness(mst("2026-10-05", "11:00"), { ...OCT5, borrowers: [borrowerA(), twoFrozen] });
  const { id, parsed } = await h.pull();
  assert.equal(parsed.state, "freeze_blocked"); assert.match(String(parsed.state_reason), /two or more repositories/);
  assert.equal(h.report(id).expires_at, "2027-02-05");
  const du = parsed.du as { submittable: boolean; reason: string }; assert.equal(du.submittable, false); assert.match(du.reason, /freeze_blocked/);
  assert.throws(() => assertDuSubmittable(h.report(id), "classic_fico"), (e: unknown) => e instanceof CreditRefused && e.code === "FREEZE_BLOCKED");
  // Tue Oct 6 14:10: detected → both repositories ineligible_two_or_more, blocks_du
  h.at(mst("2026-10-06", "14:10"));
  const d = await h.run("detectFreezes", { report_id: id, at: mst("2026-10-06", "14:10") });
  assert.equal(d.blocks_du, true); const actions = d.actions as FreezeAction[]; assert.deepEqual(actions.map((a) => a.status), ["ineligible_two_or_more", "ineligible_two_or_more"]); assert.deepEqual(actions.map((a) => a.repository), ["exp", "tu"]);
  assert.equal(h.timer("SM_CREDIT_FREEZE_FOLLOWUP_2")!.status, "armed");
  // Wed Oct 7 09:30: borrower lifts electronically with a window Oct 7–14 (re-pull day + 7 for the DU reissue)
  const liftedAt = mst("2026-10-07", "09:30");
  h.at(liftedAt);
  for (const a of actions) await h.run("detectFreezes", { op: "lift", action_id: a.action_id, lifted_at: liftedAt, lift_window_start: "2026-10-07", lift_window_end: "2026-10-14", method: "electronic" });
  const lifted = h.ofType("credit.freeze.lifted"); assert.equal(lifted.length, 2); assert.equal((lifted[0]!.payload as { lift_window_end: string }).lift_window_end, "2026-10-14");
  assert.equal(h.timer("SM_CREDIT_FREEZE_FOLLOWUP_2")!.status, "satisfied");
  // Wed Oct 7 10:45: re-pull returns three repositories → report_date Oct 7, expires Sun Feb 7, 2027; the Oct 5 report is superseded
  h.bureau.scenario = { report_date: D("2026-10-07"), received_at: mst("2026-10-07", "10:45"), borrowers: [borrowerA(), borrowerB()] };
  h.at(mst("2026-10-07", "10:45"));
  const re = await h.run("detectFreezes", { op: "repull", report_id: id, ...ORDER, at: mst("2026-10-07", "10:45"), attempt: 2 });
  assert.equal(re.superseded_report_id, id); assert.equal(re.report_date, "2026-10-07"); assert.equal(re.expires_at, "2027-02-07"); assert.equal(re.score_model, "classic_fico");
  assert.equal(h.report(id).state, "superseded"); assert.equal(h.report(String(re.report_id)).supersedes_report_id, id); assert.equal(h.report(String(re.report_id)).representative_score, 705);
  assert.equal(h.bureau.orders.length, 2); assert.equal(h.bureau.orders[1]!.score_model, "classic_fico"); assert.deepEqual(h.bureau.orders[1]!.repositories, ALL);
  const sup = h.ofType("credit.report.superseded"); assert.equal(sup.length, 1); assert.equal((sup[0]!.payload as { by_expires_at: string }).by_expires_at, "2027-02-07");
  assert.deepEqual(h.rt.store.list("credit_freeze_actions").map((r) => r.data.status), ["re_pulled", "re_pulled"]);
  const p2 = await h.run("parseCreditReport", { report_id: re.report_id }); assert.equal(p2.state, "usable"); assert.equal((p2.du as { submittable: boolean }).submittable, true);
  // DU is submitted with the Oct 7 reference; the Oct 5 report's warning clock is retired by the supersession
  assert.equal(h.report(String(re.report_id)).credit_reference_number, "CRN-tri_merge-2-2026-10-07");
  assert.equal(h.timers.byCode("SM_CREDIT_EXPIRY_WARN_21")[0]!.status, "satisfied");
});

test("22.2-T4: (expiry gate) Given `report_date` Oct 5, 2026 and scheduled note date Mon Feb 8, 2027, when `assertGateOpen('FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M')` runs, then it fails (expires Feb 5, 2027), `SM_CREDIT_EXPIRY_WARN_21` fired Jan 15, 2027, and a re-pull is scheduled no later than Jan 29, 2027.", async () => {
  assert.equal(expiresAt(D("2026-10-05")), "2027-02-05"); assert.equal(warnDate(D("2027-02-05")), "2027-01-15"); assert.equal(repullBy(D("2027-02-08")), "2027-01-29");
  const h = harness(mst("2026-10-05", "11:00"));
  const { id } = await h.pull();
  assert.equal(h.report(id).expires_at, "2027-02-05");
  // the gate is open for the fixture's Fri Nov 6, 2026 note date and closed for Mon Feb 8, 2027
  assertGateOpen("FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M", { report_date: "2026-10-05", scheduled_note_date: "2026-11-06" });
  assert.throws(() => assertGateOpen("FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M", { report_date: "2026-10-05", scheduled_note_date: "2027-02-08" }), (e: unknown) => e instanceof CreditGateClosed && e.code === "FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M" && /expires 2027-02-05/.test(e.reason));
  assert.equal(evaluateGate("22.2.creditReportExpiry4m", { expires_at: "2027-02-05", scheduled_note_date: "2027-02-05" }).open, true);
  await h.refused(h.run("scheduleRepull", { op: "assert_gate", report_id: id, scheduled_note_date: "2027-02-08" }), "FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M");
  // the expiry gate instance is evaluator-backed and the warning anchors on expires_at −21 calendar days = Fri Jan 15, 2027
  const gate = h.timer("FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M")!; assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2026-10-05"); assert.match(String(gate.note), /22\.2\.creditReportExpiry4m/);
  const warn = h.timer("SM_CREDIT_EXPIRY_WARN_21")!; assert.equal(warn.anchorDate, "2027-02-05"); assert.equal(warn.dueDate, "2027-01-15"); assert.equal(warn.status, "armed");
  const isWarn = (b: { instance: { code: string } }) => b.instance.code === "SM_CREDIT_EXPIRY_WARN_21";
  assert.equal(h.timers.evaluate("2027-01-15T12:00:00.000Z").filter(isWarn).length, 0);   // not before the end of Fri Jan 15, 2027
  const breaches = h.timers.evaluate("2027-01-16T05:30:00.000Z").filter(isWarn); assert.equal(breaches.length, 1); assert.equal(warn.status, "breached");
  assert.equal(h.ofType("timer.breached").filter((e) => (e.payload as { code: string }).code === "SM_CREDIT_EXPIRY_WARN_21").length, 1);
  // breach action: the agent schedules the re-pull ≥ 10 calendar days before the note date, same score_model
  h.at("2027-01-16T16:00:00.000Z");
  const s = await h.run("scheduleRepull", { report_id: id, scheduled_note_date: "2027-02-08", at: "2027-01-16T16:00:00.000Z" });
  assert.equal(s.gate_open, false); assert.equal(s.repull_by, "2027-01-29"); assert.equal(s.warn_on, "2027-01-15"); assert.equal(s.expires_at, "2027-02-05"); assert.equal(s.same_score_model, "classic_fico");
  assert.equal((h.ofType("credit.repull.scheduled")[0]!.payload as { repull_by: string }).repull_by, "2027-01-29");
  assert.ok(s.repull_by <= "2027-01-29");
});

test("22.2-T5: (model invariant) Given `applications.score_model = vantagescore_4`, when an order for Borrower B requests Classic FICO codes, then the order is rejected before transmission; and at delivery `SFC 067` is asserted present.", async () => {
  const h = harness(mst("2026-10-05", "11:00"), OCT5, { score_model: "vantagescore_4" });
  h.prerequisites();
  const classicCodes = { efx: "Equifax Beacon 5.0", exp: "Experian/Fair Isaac Risk Model V2", tu: "TransUnion FICO Risk Score, Classic 04" };
  const e = await h.refused(h.run("orderCreditReport", { ...ORDER, borrower_ids: [B], score_model: "vantagescore_4", requested_model_codes: classicCodes, at: mst("2026-10-05", "10:52") }), "SCORE_MODEL_MISMATCH");
  assert.match(e.citation, /LL-2026-06/);
  // and an order under the other model outright
  await h.refused(h.run("orderCreditReport", { ...ORDER, borrower_ids: [B], score_model: "classic_fico", at: mst("2026-10-05", "10:52") }), "SCORE_MODEL_MISMATCH");
  assert.equal(h.bureau.orders.length, 0, "rejected before transmission"); assert.equal(h.ofType("credit.report.ordered").length, 0); assert.equal(h.ofType("credit.report.received").length, 0);
  // the consistent order (VantageScore 4.0 codes from all three bureaus) goes through and keeps the model
  const ok = await h.run("orderCreditReport", { ...ORDER, score_model: "vantagescore_4", requested_model_codes: { efx: "Equifax VantageScore 4.0", exp: "Experian VantageScore 4.0", tu: "TransUnion VantageScore 4.0" }, at: mst("2026-10-05", "10:52") });
  assert.equal(ok.score_model, "vantagescore_4"); assert.deepEqual(h.bureau.orders[0]!.model_codes, { efx: "Equifax VantageScore 4.0", exp: "Experian VantageScore 4.0", tu: "TransUnion VantageScore 4.0" });
  assert.equal(h.rt.store.require("applications", APP).data.score_model, "vantagescore_4");
  // delivery (29.3): SFC 067 present iff score_model = vantagescore_4
  assert.deepEqual(sfcAssertion("vantagescore_4", ["067", "007"]), { ok: true, sfc_067_present: true, expected: true, reason: "SFC 067 present — consistent with score_model vantagescore_4" });
  assert.equal(sfcAssertion("vantagescore_4", ["007"]).ok, false); assert.equal(sfcAssertion("classic_fico", ["067"]).ok, false); assert.equal(sfcAssertion("classic_fico", ["007"]).ok, true);
  const viaTool = await h.run("emitScoreDisclosureData", { op: "sfc", score_model: "vantagescore_4", sfc_codes: ["067", "007"] }); assert.equal(viaTool.sfc_067_present, true); assert.equal(viaTool.ok, true);
  // a mid-loan model change needs a full re-pull and a written decision
  await h.refused(h.run("orderCreditReport", { ...ORDER, change_score_model: true, score_model: "classic_fico" }), "SCORE_MODEL_CHANGE_NEEDS_DECISION");
});

test("22.2-T6: (collections by occupancy) Given collections of $3,200.00 and $2,150.00, when occupancy is second home, then a PTF condition \"pay $5,350.00 in full prior to or at closing\" is proposed; when occupancy is one-unit principal residence, then no payoff condition is proposed.", async () => {
  const collections = [{ borrower_id: A, creditor_name: "Midland Credit", kind: "collection" as const, balance_cents: 320_000n }, { borrower_id: A, creditor_name: "Portfolio Recovery", kind: "collection" as const, balance_cents: 215_000n }];
  const second = collectionsCondition({ occupancy: "second_home", units: 1 }, collections)!;
  assert.equal(second.kind, "ptf_collections_payoff"); assert.equal(second.text, "pay $5,350.00 in full prior to or at closing"); assert.equal(second.amount_cents, 535_000n); assert.equal(second.clear_by, "prior_to_or_at_closing");
  assert.equal(collectionsCondition({ occupancy: "primary", units: 1 }, collections), null);
  assert.equal(collectionsCondition({ occupancy: "primary", units: 2 }, collections)!.amount_cents, 535_000n);   // 2–4 unit principal residence: same > $5,000 rule
  assert.equal(collectionsCondition({ occupancy: "second_home", units: 1 }, [collections[0]!]), null);   // $3,200.00 alone ≤ $5,000
  assert.equal(collectionsCondition({ occupancy: "investment", units: 1 }, [{ ...collections[0]!, balance_cents: 25_000n }])!.amount_cents, 25_000n);   // investment: individual ≥ $250
  assert.equal(collectionsCondition({ occupancy: "investment", units: 1 }, [{ ...collections[0]!, balance_cents: 24_999n }]), null);
  // through the DU message mapping on the purchase fixture (second home) and the refinance fixture (one-unit principal residence)
  const withCollections: Scenario = { ...OCT5, extra: { collections } };
  const h = harness(mst("2026-10-05", "11:00"), withCollections, { occupancy: "second_home", units: 1 });
  const { id } = await h.pull();
  const m = await h.run("mapDuCreditMessages", { report_id: id, du_messages: [], du_findings_received_at: mst("2026-10-06", "09:00") });
  const conds = m.conditions as { kind: string; text: string }[]; assert.equal(conds.length, 1); assert.equal(conds[0]!.text, "pay $5,350.00 in full prior to or at closing");
  assert.equal(h.rt.store.list("conditions").length, 1); assert.equal(h.rt.store.list("conditions")[0]!.data.amount_cents, "535000");
  const h2 = harness(mst("2026-10-05", "11:00"), withCollections, { occupancy: "primary", units: 1 });
  const p2 = await h2.pull();
  const m2 = await h2.run("mapDuCreditMessages", { report_id: p2.id, du_messages: [], du_findings_received_at: mst("2026-10-06", "09:00") });
  assert.deepEqual(m2.conditions, []); assert.equal(h2.rt.store.list("conditions").length, 0);
});

test("22.2-T7: (waiting period date basis) Given a Chapter 7 discharge Nov 20, 2022 and disbursement Nov 19, 2026, when evaluated, then the loan is not eligible; with disbursement Nov 20, 2026 the lender-confirmed basis passes while DU's report-date test (Oct 5, 2026) is recorded as failing with the written confirmation.", async () => {
  const short = waitingPeriod({ kind: "chapter_7", event_date: D("2022-11-20"), report_date: D("2026-10-05"), scheduled_disbursement_date: D("2026-11-19") });
  assert.equal(short.years, 4); assert.equal(short.eligible_on, "2026-11-20"); assert.equal(short.eligible, false); assert.equal(short.du_test.passes, false); assert.equal(short.lender_test.passes, false); assert.equal(short.documented_basis, null); assert.equal(short.written_confirmation, null);
  assert.match(short.recommendation!, /reschedule disbursement to Nov 20, 2026 or later \(1 day short\)/);
  const ok = waitingPeriod({ kind: "chapter_7", event_date: D("2022-11-20"), report_date: D("2026-10-05"), scheduled_disbursement_date: D("2026-11-20") });
  assert.equal(ok.eligible, true); assert.equal(ok.documented_basis, "lender_disbursement_date_confirmation");
  assert.deepEqual(ok.du_test, { basis: "report_date", date: "2026-10-05", passes: false }); assert.deepEqual(ok.lender_test, { basis: "disbursement_date", date: "2026-11-20", passes: true });
  assert.match(ok.written_confirmation!, /from the credit report date Oct 5, 2026 and recorded it as not met/); assert.match(ok.written_confirmation!, /B3-5\.3-09/); assert.match(ok.written_confirmation!, /Nov 20, 2026 is on\/after Nov 20, 2026/);
  // the refinance fixture's Thu Nov 12, 2026 disbursement also fails (8 days short); extenuating circumstances (2 years) → eligible from Nov 20, 2024
  const refi = waitingPeriod({ kind: "chapter_7", event_date: D("2022-11-20"), report_date: D("2026-10-05"), scheduled_disbursement_date: D("2026-11-12") }); assert.equal(refi.eligible, false); assert.match(refi.recommendation!, /8 days short/);
  const ext = waitingPeriod({ kind: "chapter_7", event_date: D("2022-11-20"), extenuating: true, report_date: D("2026-10-05"), scheduled_disbursement_date: D("2026-11-12") }); assert.equal(ext.eligible_on, "2024-11-20"); assert.equal(ext.documented_basis, "du_report_date");
  // through the tool
  const h = harness(mst("2026-10-05", "11:00"));
  const out = await h.run("mapDuCreditMessages", { op: "waiting_period", kind: "chapter_7", event_date: "2022-11-20", report_date: "2026-10-05", scheduled_disbursement_date: "2026-11-20" });
  assert.equal(out.eligible, true); assert.equal((out.du_test as { passes: boolean }).passes, false); assert.ok(out.written_confirmation);
});

test("22.2-T8: (inquiry → new debt) Given qualifying income 1,350,000 cents, obligations 513,000 cents, an inquiry dated Sept 12, 2026 and a borrower-reported new $612.40 monthly payment, when recorded, then `application_liabilities` gains the debt, DTI moves 38.0% → 42.5% (+4.5 points), and 23.1's tolerance check returns \"resubmission required\"; with a $150.00 payment DTI moves to 39.1% and the check returns \"no resubmission required\" while the final submission still includes the debt.", async () => {
  assert.equal(dtiTenths(513_000n, 1_350_000n), 380); assert.equal(dtiText(380), "38.0%");
  const inquiries = [{ borrower_id: B, creditor_name: "AutoLender Finance", inquiry_date: D("2026-09-12"), repository: "exp" as const, subscriber_code: "AUTO-4411", purpose: "auto loan" },
    { borrower_id: A, creditor_name: "Partner Bank, N.A.", inquiry_date: D("2026-10-05"), repository: "efx" as const, subscriber_code: SUBSCRIBER, purpose: "mortgage" }, { borrower_id: A, creditor_name: "Old Card Co", inquiry_date: D("2026-06-01"), repository: "tu" as const, subscriber_code: "CARD-1" }];
  const h = harness(mst("2026-10-05", "11:00"), { ...OCT5, extra: { inquiries } });
  const { id } = await h.pull();
  const opened = await h.run("openInquiryItems", { report_id: id, subscriber_code: SUBSCRIBER });
  const items = opened.items as { inquiry_id: string; creditor_name: string; inquiry_date: string; status: string }[];
  assert.equal(items.length, 1); assert.equal(items[0]!.creditor_name, "AutoLender Finance"); assert.equal(items[0]!.inquiry_date, "2026-09-12"); assert.equal(items[0]!.status, "open");   // the partner's own pull and the >90-day inquiry open nothing
  h.at(mst("2026-10-08", "15:20"));
  const x = await h.run("openInquiryItems", { op: "explain", inquiry_id: items[0]!.inquiry_id, explanation: "Financed a 2024 sedan in September", new_credit_obtained: true, creditor_name: "AutoLender Finance", liability_kind: "installment", monthly_payment_cents: 61_240n, balance_cents: 2_890_000n, qualifying_income_cents: 1_350_000n, obligations_cents: 513_000n, explained_at: mst("2026-10-08", "15:20") });
  const impact = x.impact as { new_obligations_cents: bigint; previous_dti_tenths: number; new_dti_tenths: number; tolerance: { result: string; increase_tenths: number; exceeds_45: boolean; increase_3_points: boolean; final_submission_must_include_debt: boolean }; liability: { monthly_payment_cents: bigint; source: string } };
  assert.equal(impact.new_obligations_cents, 574_240n); assert.equal(impact.previous_dti_tenths, 380); assert.equal(impact.new_dti_tenths, 425); assert.equal(dtiText(impact.new_dti_tenths), "42.5%");
  assert.equal(impact.tolerance.increase_tenths, 45); assert.equal(impact.tolerance.exceeds_45, false); assert.equal(impact.tolerance.increase_3_points, true); assert.equal(impact.tolerance.result, "resubmission required");
  assert.equal(impact.liability.monthly_payment_cents, 61_240n); assert.equal(impact.liability.source, "inquiry_review");
  const liabilities = h.rt.store.list("application_liabilities"); assert.equal(liabilities.length, 1); assert.equal(liabilities[0]!.data.monthly_payment_cents, "61240"); assert.equal(liabilities[0]!.data.creditor_name, "AutoLender Finance"); assert.equal(liabilities[0]!.data.application_borrower_id, B);
  assert.equal((h.rt.store.require("inquiry_explanations", items[0]!.inquiry_id).data as { status: string; new_credit_obtained: boolean }).new_credit_obtained, true);
  assert.equal(h.ofType("credit.inquiry.explained").length, 1); assert.equal((h.ofType("credit.undisclosed_debt.found")[0]!.payload as { tolerance_result: string }).tolerance_result, "resubmission required");
  // a $150.00 payment instead: 528,000 / 1,350,000 = 39.1 % (+1.1) → no resubmission required by tolerance; the liability is still added and the final submission reflects it
  const small = newDebtImpact({ application_id: APP, borrower_id: B, creditor_name: "AutoLender Finance", liability_kind: "installment", monthly_payment_cents: 15_000n, qualifying_income_cents: 1_350_000n, obligations_cents: 513_000n, source: "inquiry_review" });
  assert.equal(small.new_obligations_cents, 528_000n); assert.equal(small.new_dti_tenths, 391); assert.equal(dtiText(391), "39.1%"); assert.equal(small.tolerance.increase_tenths, 11); assert.equal(small.tolerance.result, "no resubmission required"); assert.equal(small.tolerance.final_submission_must_include_debt, true);
  assert.equal(small.liability.monthly_payment_cents, 15_000n); assert.equal(small.dti_recalculation_for, "22.5"); assert.equal(small.tolerance_check_for, "23.1");
  assert.equal(b3210ToleranceCheck(380, 451).result, "resubmission required");   // > 45 % even with a small increase
});

test("22.2-T9: (pre-closing refresh window) Given consummation Fri Nov 6, 2026, when the refresh is dated Tue Nov 3, 2026 with all alerts resolved, then `SM_CREDIT_REFRESH_PRECLOSE_GATE` is open; dated Mon Nov 2, 2026 → not open.", async () => {
  assert.equal(refreshWindowStart(D("2026-11-06")), "2026-11-03");   // Nov 5, 4, 3 counting back three creditor business days
  assert.equal(refreshWindowStart(D("2026-11-18")), "2026-11-13");   // purchase fixture: Nov 17, 16, 13 (Sat/Sun excluded)
  const resolved = [{ alert_id: "al-1", status: "resolved" }];
  assert.equal(evaluateGate("22.2.refreshPrecloseGate", { scheduled_consummation_date: "2026-11-06", refresh_report_date: "2026-11-03", refresh_report_type: "soft_refresh", alerts: resolved }).open, true);
  const closed = evaluateGate("22.2.refreshPrecloseGate", { scheduled_consummation_date: "2026-11-06", refresh_report_date: "2026-11-02", refresh_report_type: "soft_refresh", alerts: resolved });
  assert.equal(closed.open, false); assert.match(closed.reason!, /earlier than 2026-11-03/);
  assert.equal(evaluateGate("22.2.refreshPrecloseGate", { scheduled_consummation_date: "2026-11-06", refresh_report_date: "2026-11-03", refresh_report_type: "soft_refresh", alerts: [{ alert_id: "al-2", status: "verified_new_debt" }] }).open, false);
  assert.throws(() => assertGateOpen("SM_CREDIT_REFRESH_PRECLOSE_GATE", { scheduled_consummation_date: "2026-11-06", refresh_report_date: "2026-11-02", alerts: [] }), (e: unknown) => e instanceof CreditGateClosed && e.code === "SM_CREDIT_REFRESH_PRECLOSE_GATE");
  // on the bus: the tri-merge Oct 5, the CD delivered Mon Nov 2 (arms the gate), the refresh ordered Tue Nov 3 → clean → gate open and the instance satisfied
  const tradelines = [{ borrower_id: A, creditor_name: "Visa", account_ref: "V-1", liability_kind: "revolving", monthly_payment_cents: 4_500n, balance_cents: 120_000n }];
  const h = harness(mst("2026-10-05", "11:00"), { ...OCT5, extra: { tradelines } }, { scheduled_consummation_date: "2026-11-06" });
  await h.pull();
  h.at(mst("2026-11-02", "16:00")); h.upstream("disclosure.cd.delivered", { disclosure_id: "cd-1", kind: "cd", scheduled_consummation_date: "2026-11-06" }, mst("2026-11-02", "16:00"), { kind: "agent", id: "disclosure" });
  const gate = h.timer("SM_CREDIT_REFRESH_PRECLOSE_GATE")!; assert.equal(gate.status, "armed"); assert.match(String(gate.note), /22\.2\.refreshPrecloseGate/);
  await h.refused(h.run("orderRefresh", { op: "assert_gate" }), "SM_CREDIT_REFRESH_PRECLOSE_GATE");   // no refresh yet
  h.bureau.scenario = { report_date: D("2026-11-03"), received_at: mst("2026-11-03", "09:10"), borrowers: [borrowerA(), borrowerB()], extra: { tradelines } };
  h.at(mst("2026-11-03", "09:10"));
  const r = await h.run("orderRefresh", { ...ORDER, at: mst("2026-11-03", "09:10") });
  assert.equal(r.report_date, "2026-11-03"); assert.equal(r.new_tradelines, 0); assert.equal(r.alerts_open, 0); assert.deepEqual(r.gate, { open: true });
  assert.equal(h.bureau.orders.at(-1)!.order_type, "soft_refresh"); assert.equal(h.report(String(r.report_id)).report_type, "soft_refresh");
  assert.equal((h.ofType("credit.refresh.received")[0]!.payload as { alerts_open: number; window_start: string }).window_start, "2026-11-03");
  assert.equal(gate.status, "satisfied");
  assert.equal((await h.run("orderRefresh", { op: "assert_gate" })).open, true);
});

test("22.2-T10: (UDM verified new debt) Given a UDM alert \"new tradeline\" received Thu Oct 29, 2026 that the borrower confirms as a $410.00 installment, when triaged as `verified_new_debt`, then 22.5 recalculates DTI, 23.1 evaluates B3-2-10, and the relief record notes the debt was disclosed before closing.", async () => {
  const h = harness(mst("2026-10-05", "11:00"));
  await h.pull();
  assert.equal(h.timer("SM_UDM_MONITOR_ACTIVE")!.status, "armed");   // monitoring runs from report_date
  h.at(mst("2026-10-29", "08:05"));
  const hb = await h.run("triageUdmAlert", { op: "heartbeat", vendor: "Xactus UDV", at: mst("2026-10-29", "08:05"), alerts_delivered: 1 }); assert.equal(hb.event, "credit.udm.heartbeat");
  assert.equal(h.timers.byCode("SM_UDM_MONITOR_ACTIVE")[0]!.status, "satisfied"); assert.equal(h.timer("SM_UDM_MONITOR_ACTIVE")!.status, "armed");   // recurring: re-armed by the heartbeat
  const rec = await h.run("triageUdmAlert", { op: "receive", borrower_id: B, alert_type: "new_tradeline", vendor_alert_id: "UDV-77103", payload: { creditor_name: "Conn's Home Plus", account_ref: "CHP-5521", opened: "2026-10-22" }, received_at: mst("2026-10-29", "08:05") });
  const alert = rec.alert as { alert_id: string; status: string; received_at: string }; assert.equal(alert.status, "open"); assert.equal(alert.received_at, mst("2026-10-29", "08:05")); assert.equal(rec.suggested_status, "open");
  assert.equal((h.ofType("credit.udm.alert.received")[0]!.payload as { alert_type: string }).alert_type, "new_tradeline");
  // Fri Oct 30: the borrower confirms a $410.00 installment → verified_new_debt
  h.at(mst("2026-10-30", "10:15"));
  const t = await h.run("triageUdmAlert", { alert_id: alert.alert_id, status: "verified_new_debt", rationale: "borrower confirmed the furniture installment; statement uploaded", explanation: "Furniture financing opened Oct 22", evidence_document_id: "doc-chp-stmt", creditor_name: "Conn's Home Plus", liability_kind: "installment", monthly_payment_cents: 41_000n, balance_cents: 1_480_000n, qualifying_income_cents: 1_350_000n, obligations_cents: 513_000n, triaged_at: mst("2026-10-30", "10:15") });
  const impact = t.impact as { new_obligations_cents: bigint; new_dti_tenths: number; previous_dti_tenths: number; tolerance: { result: string; citation: string }; dti_recalculation_for: string; tolerance_check_for: string; liability: { monthly_payment_cents: bigint; source: string } };
  assert.equal(impact.liability.monthly_payment_cents, 41_000n); assert.equal(impact.liability.source, "udm_alert"); assert.equal(impact.new_obligations_cents, 554_000n); assert.equal(impact.previous_dti_tenths, 380); assert.equal(impact.new_dti_tenths, 410);
  assert.equal(impact.dti_recalculation_for, "22.5"); assert.equal(impact.tolerance_check_for, "23.1"); assert.equal(impact.tolerance.citation, "B3-2-10"); assert.equal(impact.tolerance.result, "resubmission required");
  assert.deepEqual(t.next, { dti_recalculation: "22.5", tolerance_evaluation: "23.1", resubmission_before_signing: true });
  assert.match(String(t.relief_note), /was disclosed and verified before closing on Oct 30, 2026/); assert.match(String(t.relief_note), /A2-2-04 relief \(DU message 3941\) requires closing by the credit report expiration date/);
  const stored = h.rt.store.require("credit_alerts", alert.alert_id).data as { status: string; dti_impact_cents: bigint; resolution: { relief_note: string; liability_id: string } };
  assert.equal(stored.status, "verified_new_debt"); assert.equal(stored.dti_impact_cents, 41_000n); assert.match(stored.resolution.relief_note, /disclosed and verified before closing/);
  assert.equal(h.rt.store.list("application_liabilities").length, 1); assert.equal(h.rt.store.list("application_liabilities")[0]!.data.monthly_payment_cents, "41000");
  const found = h.ofType("credit.undisclosed_debt.found"); assert.equal(found.length, 1); assert.equal((found[0]!.payload as { disclosed_before_closing: boolean; source: string }).disclosed_before_closing, true); assert.equal((found[0]!.payload as { source: string }).source, "udm_alert");
  assert.equal((h.ofType("credit.udm.alert.resolved")[0]!.payload as { status: string }).status, "verified_new_debt");
  // the unresolved verified_new_debt keeps the pre-closing gate closed until 22.5/23.1 act
  assert.match(evaluateGate("22.2.refreshPrecloseGate", { scheduled_consummation_date: "2026-11-06", refresh_report_date: "2026-11-03", alerts: [{ alert_id: alert.alert_id, status: stored.status }] }).reason!, /22\.5 recalculation and 23\.1 resubmission/);
  // a matched known tradeline is a false positive; a second triage of the same alert is refused
  const fp = await h.run("triageUdmAlert", { op: "receive", borrower_id: A, alert_type: "secondary_reissue", payload: { creditor_name: "Partner Bank, N.A." }, received_at: mst("2026-10-30", "11:00") }); assert.equal(fp.suggested_status, "false_positive");
  await assert.rejects(h.run("triageUdmAlert", { alert_id: alert.alert_id, status: "explained", rationale: "x" }), /already verified_new_debt/);
  // closing.consummated ends monitoring
  const stop = await h.run("triageUdmAlert", { op: "stop" }); assert.equal((stop.cancelled as string[]).length, 1); assert.equal(h.timer("SM_UDM_MONITOR_ACTIVE")!.status, "cancelled");
});

test("22.2-T11: (credit-report fee) Given the LE not yet delivered, when the credit-report fee is charged Mon Oct 5, 2026, then the charge is permitted (§1026.19(e)(2)(i)(B)) and the `fee_items` row has `tolerance_class = zero` under \"Services You Cannot Shop For\"; any other fee on that date is refused (21.4 gate).", async () => {
  const chargedAt = mst("2026-10-05", "10:45");
  const fee = chargeCreditReportFee({ application_id: APP, fee_kind: "credit_report", amount_cents: 3_500n, vendor_invoice_cents: 3_500n, charged_at: chargedAt, le_effective_receipt_date: null, reseller: "Xactus360", borrower_paid: true });
  assert.equal(fee.permitted, true); assert.equal(fee.gate_result, "exempt_credit_report"); assert.match(fee.citation, /1026\.19\(e\)\(2\)\(i\)\(B\)/); assert.equal(fee.collected_cents, 3_500n); assert.equal(fee.ledger_account, "origination_fees_receivable");
  assert.equal(fee.fee_item!.tolerance_class, "zero"); assert.equal(fee.fee_item!.le_section, "B_cannot_shop"); assert.equal(fee.fee_item!.le_section_label, "Services You Cannot Shop For"); assert.equal(fee.fee_item!.fee_code, "credit_report"); assert.equal(fee.fee_item!.shoppable, false); assert.equal(fee.fee_item!.estimated_at, "2026-10-05"); assert.equal(fee.fee_item!.current_amount_cents, 3_500n);
  // the fee is capped at the vendor invoice (bona fide and reasonable)
  assert.equal(chargeCreditReportFee({ application_id: APP, fee_kind: "credit_report", amount_cents: 4_500n, vendor_invoice_cents: 3_500n, charged_at: chargedAt, le_effective_receipt_date: null, reseller: "Xactus360", borrower_paid: false }).collected_cents, 3_500n);
  // any other fee on that date is refused by 21.4's gate (no LE received, no intent)
  const appraisal = chargeCreditReportFee({ application_id: APP, fee_kind: "appraisal", amount_cents: 65_000n, vendor_invoice_cents: 65_000n, charged_at: chargedAt, le_effective_receipt_date: null, reseller: "AMC", borrower_paid: true });
  assert.equal(appraisal.permitted, false); assert.equal(appraisal.gate_result, "closed_no_receipt"); assert.equal(appraisal.fee_item, null); assert.equal(appraisal.collected_cents, 0n); assert.match(appraisal.citation, /1026\.19\(e\)\(2\)\(i\)\(A\)/);
  // 21.4's checkFeeGate records the attempt (fee.gate.checked) and that record is the fee-handling prerequisite the hard pull reads; without it the order is refused
  const h = harness(mst("2026-10-05", "11:00"));
  h.upstream("application.trid_received", { trid_received_at: mst("2026-10-05", "10:41"), trid_application_date: "2026-10-05" }, mst("2026-10-05", "10:41"));
  await h.refused(h.run("orderCreditReport", { ...ORDER, at: mst("2026-10-05", "10:52") }), "SIX_ITEMS_AND_FEE_FIRST");
  const gate = checkFeeGate(h.events, { application_id: APP, command: "order_credit_report", fee_kind: "credit_report", amount_cents: 3_500n, checked_at: chargedAt, le_effective_receipt_date: null, intent: null, vendor_invoice_cents: 3_500n, time_zone: "America/Phoenix" });
  assert.equal(gate.open, true); assert.equal(gate.check.result, "exempt_credit_report");
  const refusedOther = checkFeeGate(h.events, { application_id: APP, command: "impose_fee", fee_kind: "appraisal", amount_cents: 65_000n, checked_at: chargedAt, le_effective_receipt_date: null, intent: null, time_zone: "America/Phoenix" }); assert.equal(refusedOther.open, false); assert.equal(refusedOther.check.result, "closed_no_receipt");
  const o = await h.run("orderCreditReport", { ...ORDER, at: mst("2026-10-05", "10:52") }); assert.equal(o.report_date, "2026-10-05");
  assert.equal(h.report(String(o.report_id)).fee_cents, 3_500n);
});

test("22.2-T12: (disclosure data) Given the report received Oct 5, 2026, when scores are computed, then 21.3 receives per-borrower payloads containing only that borrower's scores, key factors, range, date and the CRA identity.", async () => {
  const h = harness(mst("2026-10-05", "11:00"));
  const { id } = await h.pull();
  const out = await h.run("emitScoreDisclosureData", { report_id: id, at: mst("2026-10-05", "11:05") });
  const payloads = out.payloads as ReturnType<typeof scoreDisclosurePayloads>;
  assert.equal(payloads.length, 2); assert.equal(out.events, 2);
  const pa = payloads.find((p) => p.borrower_id === A)!, pb = payloads.find((p) => p.borrower_id === B)!;
  assert.deepEqual(pa.scores.map((s) => [s.repository, s.bureau, s.score]), [["efx", "Equifax", 742], ["exp", "Experian", 751], ["tu", "TransUnion", 760]]); assert.equal(pa.applicable_score, 751);
  assert.deepEqual(pb.scores.map((s) => s.score), [698, 712, 705]); assert.equal(pb.applicable_score, 705);
  for (const p of [pa, pb]) { assert.deepEqual(p.range, { min: 300, max: 850 }); assert.equal(p.date, "2026-10-05"); assert.deepEqual(p.cra, CRA); assert.equal(p.creditor_is_partner, true); assert.deepEqual(p.for_templates, ["NTC_FCRA_609G_CREDIT_SCORE", "NTC_REGV_1022_74_RBP_EXCEPTION"]); assert.ok(p.scores.every((s) => s.key_factors.length > 0 && s.key_factors.length <= 4)); }
  // only that borrower's data: A's payload carries none of B's scores and neither carries the representative score or the other borrower's id (§1022.75(c))
  // (ids are random UUIDs and may contain any three digits by chance — they are scrubbed before the substring check)
  const scrub = (v: unknown): string => JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
  const ja = scrub(pa), jb = scrub(pb);
  for (const s of ["698", "712", "705", B]) assert.ok(!ja.includes(s), `A's payload leaks ${s}`);
  for (const s of ["742", "751", "760", A]) assert.ok(!jb.includes(s), `B's payload leaks ${s}`);
  assert.ok(!("representative_score" in pa));
  const ev = h.ofType("credit.score_disclosure.prepared"); assert.equal(ev.length, 2); assert.deepEqual(ev.map((e) => (e.payload as { borrower_id: string }).borrower_id).sort(), [A, B]);
  assert.ok(!scrub(ev.find((e) => (e.payload as { borrower_id: string }).borrower_id === A)!.payload).includes("698"));
  // the HMDA feed (28.3): model and the scores relied on
  assert.deepEqual(out.hmda, { score_model: "classic_fico", representative_score: 705, applicant_scores: { [A]: 751, [B]: 705 } });
  await h.refused(h.run("emitScoreDisclosureData", { report_id: id, borrower_id: A, recipient_borrower_id: B }), "NO_CROSS_BORROWER_DISCLOSURE");
  // the decision record per report
  const d = await h.run("writeDecision", { report_id: id, action: "credit.analysis", rationale: "tri-merge parsed; representative 705 (B)", confidence: 0.99, conditions_proposed: [] });
  const rec = d.record as { representative_score: number; model: string; permissible_purpose: string; rule_set_version: string; applicable_scores: Record<string, number> };
  assert.equal(rec.representative_score, 705); assert.equal(rec.model, "classic_fico"); assert.equal(rec.permissible_purpose, "credit_transaction_604a3A"); assert.equal(rec.rule_set_version, "fnma.selling.2026-09-02"); assert.deepEqual(rec.applicable_scores, { [A]: 751, [B]: 705 });
  assert.ok(h.decisions.some((x) => x.action === "credit.analysis" && x.ruleSetVersion === "fnma.selling.2026-09-02" && x.subject?.kind === "credit_report" && x.subject.id === id));
});

test("22.2 worked figures: income $13,500.00 (1,350,000 cents) with obligations 513,000 cents = 38.0%; a $612.40 auto payment → 574,240 cents = 42.5% (+4.5, resubmit); $150.00 → 528,000 cents = 39.1% (+1.1, no resubmission); collections $3,200.00 + $2,150.00 = $5,350.00 > $5,000 on a second home; report Oct 5 → expires Feb 5, 2027; Oct 19 → Feb 19, 2027; Oct 7 → Feb 7, 2027; Ch. 7 discharge Nov 20, 2022 + 4 years = Nov 20, 2026", () => {
  assert.equal(1_350_000n, 13_500n * 100n); assert.equal(dtiTenths(513_000n, 1_350_000n), 380); assert.equal(dtiText(dtiTenths(513_000n, 1_350_000n)), "38.0%");
  const auto = newDebtImpact({ application_id: APP, borrower_id: B, creditor_name: "AutoLender Finance", liability_kind: "installment", monthly_payment_cents: 61_240n, qualifying_income_cents: 1_350_000n, obligations_cents: 513_000n, source: "inquiry_review" });
  assert.equal(auto.new_obligations_cents, 574_240n); assert.equal(auto.new_dti_tenths, 425); assert.equal(auto.tolerance.increase_tenths, 45); assert.equal(auto.tolerance.result, "resubmission required");
  const small = newDebtImpact({ application_id: APP, borrower_id: B, creditor_name: "AutoLender Finance", liability_kind: "installment", monthly_payment_cents: 15_000n, qualifying_income_cents: 1_350_000n, obligations_cents: 513_000n, source: "inquiry_review" });
  assert.equal(small.new_obligations_cents, 528_000n); assert.equal(small.new_dti_tenths, 391); assert.equal(small.tolerance.increase_tenths, 11); assert.equal(small.tolerance.result, "no resubmission required");
  const coll = collectionsCondition({ occupancy: "second_home", units: 1 }, [{ borrower_id: A, creditor_name: "Midland Credit", kind: "collection", balance_cents: 320_000n }, { borrower_id: A, creditor_name: "Portfolio Recovery", kind: "collection", balance_cents: 215_000n }])!;
  assert.equal(coll.amount_cents, 535_000n); assert.equal(coll.text, "pay $5,350.00 in full prior to or at closing"); assert.ok(coll.amount_cents > 500_000n);
  assert.equal(expiresAt(D("2026-10-05")), "2027-02-05"); assert.equal(expiresAt(D("2026-10-19")), "2027-02-19"); assert.equal(expiresAt(D("2026-10-07")), "2027-02-07");
  assert.equal(evaluateGate("22.2.creditReportExpiry4m", { report_date: "2026-10-19", scheduled_note_date: "2026-11-18" }).open, true); assert.equal(evaluateGate("22.2.creditReportExpiry4m", { report_date: "2026-10-05", scheduled_note_date: "2026-12-18" }).open, true);   // O3-IT5: closing slips to Dec 18 — still valid
  assert.equal(waitingPeriod({ kind: "chapter_7", event_date: D("2022-11-20"), report_date: D("2026-10-05"), scheduled_disbursement_date: D("2026-11-20") }).eligible_on, "2026-11-20");
  assert.equal(scoreBand("classic_fico", 705).row, "700–719"); assert.equal(scoreBand("classic_fico", 698).row, "680–699");
});
