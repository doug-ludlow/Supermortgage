// 27.1 Warehouse facility mechanics: advance requests, wet/dry funding limits, collateral control (bailee letters, interim funder, UCC), aging and curtailments, interest/fees, kick-outs and repurchases, borrowing-base and covenant monitoring
// spec/sections/27-warehouse-funding-and-settlement-economics-supermortgage-as/27-1-warehouse-facility-mechanics-advance-requests-wet-dry-fundin.md
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
import { TOOLS_27_1, warehouseServices } from "../../app/tools/section27-1.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { origFundingClearing } from "../orig-boarding/ops-30-2.ts";
import {
  FACILITY_FIXTURE, SM_MERS_ORG_ID, FANNIE_MAE_ORG_ID, GuardrailViolation, FakeWarehouseBank,
  advanceAmount, netDisbursement, collateralValue, wetSublimitCents, accrualSchedule, naivePerDiemTotal, segmentInterest, payoffStatement, capitalizeMonth, curtailmentAt45, repurchaseSchedule, wetNoteDeadline, wetOverdue, interimFunderDeadline, issueBaileeLetter, releaseConditionText, assessFee, wireValueDate, evaluateEligibility, computeBorrowingBase, indexRateFor, allInRateBps,
  type EligibilityFacts, type OpenAdvance, type SofrPoint,
} from "./ops-27-1.ts";

const AGENT: Actor = { kind: "agent", id: "warehouse" };
const OFFICER: Actor = { kind: "human", id: "u-officer-sm", role: "officer" };
const FUNDING_APPROVER: Actor = { kind: "human", id: "u-fa-sm", role: "funding_approver" };
const LOAN = "L-REFI-1", APP = "app-refi-1", ADV = "adv-refi-1", MIN = "100012300004567890", PARTNER_ORG = "1000123";
const PLOAN = "L-PUR-1", PAPP = "app-pur-1", PADV = "adv-pur-1", PMIN = "100012300009876543";
const et = (date: string, hhmm: string): string => { const [h, m] = hhmm.split(":").map(Number) as [number, number]; return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h + 5, m)).toISOString(); };   // EST (UTC−5) in Nov–Jan
/** SOFR 4.30% flat on every federal business day of the fixture window (Nov 11 Veterans Day, Nov 26 Thanksgiving, Dec 25, Jan 1, Jan 18 unpublished — the lookback reuses the last value). */
const SOFR: SofrPoint[] = ["2026-11-06", "2026-11-09", "2026-11-10", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-30", "2026-12-01", "2026-12-15", "2026-12-24", "2026-12-28", "2026-12-31", "2027-01-04", "2027-01-08", "2027-01-11"].map((d) => ({ publication_date: D(d), rate_bps: 430 }));
const NO_FLAGS = { dwell_stepup_active: false, wet_overdue: false };

/** Worked example A — fixture refinance (eNote, dry state, Phoenix AZ): $560,000 note; net disbursement $557,249.57; Secured Party = SM added Mon Nov 9; funding.authorized Thu Nov 12 08:12 ET. */
const refiRequest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ advance_id: ADV, facility_id: FACILITY_FIXTURE.facility_id, loan_id: LOAN, application_id: APP, funding_id: "fund-refi-1", requested_at: et("2026-11-12", "08:12"), note_form: "enote", closing_type: "ron", wet_dry: "dry", note_amount_cents: "56000000", net_disbursement_cents: "55724957", note_date: "2026-11-06", transaction_type: "limited_cash_out", commitment_price: "101.375", commitment_id_fnma: "BE-2026-11-0001", wire_verification_id: "wv-refi-1", property_state: "AZ", enote_registered_at: "2026-11-06", secured_party_added_at: et("2026-11-09", "10:00"), trust_receipt_at: null, ...over });
const refiFacts = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ du_recommendation: "approve_eligible", du_final_matches_closing: true, ctc_issued: false, disbursement_gate_opened: false, commitment: { commitment_id_fnma: "BE-2026-11-0001", live: true, expires_on: "2026-11-21", type: "best_efforts" }, wire_verification: { id: "wv-refi-1", match_result: "verified", expires_at: et("2026-12-03", "23:59"), blocks_disbursement: false }, transaction_type: "limited_cash_out", rescission_gate_open: true, wet_dry: "dry", dry_recording_condition_met: true, note_amount_cents: "56000000", units: 1, program_in_scope: true, first_payment_date: "2027-01-01", disbursement_date: "2026-11-12", qc_prefunding_blocking: false, ltv_pct: 70, mi_active: false, flood_gate_open: true, insurance_gate_open: true, cpl_names_partner: true, duplicate_advance: false, partner_suspended: false, facility_status: "active", appraisal_expires_at: "2027-03-01", lock_extension_count: 0, evidence: { du_submission_id: "du-3", ctc_checklist_id: "ctc-1", compliance_test_run_id: "ctr-9", commitment_id: "BE-2026-11-0001", wire_verification_id: "wv-refi-1", rescission_id: "resc-1", cpl_document_id: "doc-cpl-1" }, ...over });
/** Worked example B — purchase fixture (paper note, wet state, Columbus OH): $412,000 note; closing and funding Wed Nov 18, 2026. */
const purchaseRequest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ advance_id: PADV, facility_id: FACILITY_FIXTURE.facility_id, loan_id: PLOAN, application_id: PAPP, funding_id: "fund-pur-1", requested_at: et("2026-11-18", "09:00"), note_form: "paper", closing_type: "hybrid", wet_dry: "wet", note_amount_cents: "41200000", net_disbursement_cents: "41200000", note_date: "2026-11-18", transaction_type: "purchase", commitment_price: "101.000", commitment_id_fnma: "BE-2026-11-0002", wire_verification_id: "wv-pur-1", property_state: "OH", enote_registered_at: null, secured_party_added_at: null, trust_receipt_at: null, ...over });
const purchaseFacts = (over: Record<string, unknown> = {}): Record<string, unknown> => refiFacts({ commitment: { commitment_id_fnma: "BE-2026-11-0002", live: true, expires_on: "2026-12-18", type: "best_efforts" }, wire_verification: { id: "wv-pur-1", match_result: "verified", expires_at: et("2026-12-10", "23:59"), blocks_disbursement: false }, transaction_type: "purchase", rescission_gate_open: null, wet_dry: "wet", dry_recording_condition_met: null, note_amount_cents: "41200000", disbursement_date: "2026-11-18", ltv_pct: 95, mi_active: true, ...over });
const haircut = { partner_haircut_reserve_cents: "25000000", partner_contribution_cents: "844957" };

/** The 27.1 tools on the bus over the overridden registry (27.1 rows), a memory ledger, the escalation service and the fake bank / eRegistry / custodian ports; the harness appends the upstream events (23.3, 25.1, 26.3, 27.2) with origination context. */
function harness(nowIso: string, loanId = LOAN, appId = APP) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["27.1"] });
  const decisions: DecisionInput[] = []; const ledger = new MemoryLedger();
  const uow: UowContext = { loanId, events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const svc = warehouseServices(rt);
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_27_1); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("27.1", name))!, actor, input, uow)).output as Record<string, unknown>;
  const at = (iso: string) => clock.set(iso);
  const timer = (code: string) => timers.byCode(code).at(-1);
  const ofType = (type: string): DomainEvent[] => events.all().filter((e) => e.type === type);
  const upstream = (type: string, payload: Record<string, unknown>, occurredAt = clock.now(), keys: { loanId: string; applicationId: string } = { loanId, applicationId: appId }) => events.append({ type, ...keys, actor: { kind: "external", id: "platform" }, occurredAt, payload: { application_id: keys.applicationId, ...payload } });
  const refused = async (p: Promise<unknown>, code: string): Promise<CommandRefused> => { try { await p; } catch (e) { assert.ok(e instanceof CommandRefused, `expected CommandRefused ${code}, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected refusal ${code}`); };
  const violated = async (p: Promise<unknown>, code: string): Promise<GuardrailViolation> => { try { await p; } catch (e) { assert.ok(e instanceof GuardrailViolation, `expected GuardrailViolation ${code}, got ${(e as Error).message}`); assert.equal(e.code, code); return e; } assert.fail(`expected guardrail violation ${code}`); };
  /** The fixture-A gates as the platform records them: CTC issued Nov 4 (23.3), disbursement gate opened 08:05 ET Nov 12 (25.1), funding.authorized 08:12 ET (26.3). */
  const refiUpstream = () => { upstream("clear_to_close.issued", { checklist_id: "ctc-1", passed: true, gate: "SM_UW_CTC_GATE" }, et("2026-11-04", "15:00")); upstream("compliance.gate.opened", { gate: "disbursement", run_id: "ctr-9" }, et("2026-11-12", "08:05")); upstream("funding.authorized", { funding_id: "fund-refi-1", net_disbursement_cents: "55724957", closing_type: "ron", note_form: "enote" }, et("2026-11-12", "08:12")); };
  /** T1 on the bus: approved 08:14 ET, wire released 09:40 ET by funding_approver → funded Nov 12, secured_control, $25.00 wire fee assessed. */
  const fundRefi = async () => {
    refiUpstream(); at(et("2026-11-12", "08:14"));
    const d = await run("approveAdvance", { request: refiRequest(), facts: refiFacts() }); assert.equal(d.outcome, "approved");
    await run("prepareWire", { advance_id: ADV, facts: haircut });
    at(et("2026-11-12", "09:40")); const f = await run("funding_approver", { advance_id: ADV }, FUNDING_APPROVER);
    await run("assessFee", { advance_id: ADV, kind: "wire_out", on: "2026-11-12" });
    return f;
  };
  const purchaseUpstream = () => { upstream("clear_to_close.issued", { checklist_id: "ctc-2", passed: true }, et("2026-11-13", "15:00"), { loanId: PLOAN, applicationId: PAPP }); upstream("compliance.gate.opened", { gate: "disbursement", run_id: "ctr-10" }, et("2026-11-18", "08:30"), { loanId: PLOAN, applicationId: PAPP }); };
  /** Fixture B on the bus: funded wet on Wed Nov 18, 2026 with a paper note (unsecured_wet; wet_reason wet_state_paper). */
  const fundPurchase = async () => {
    purchaseUpstream(); at(et("2026-11-18", "09:05"));
    const d = await run("approveAdvance", { request: purchaseRequest(), facts: purchaseFacts() }); assert.equal(d.outcome, "approved", JSON.stringify(d.reasons));
    await run("prepareWire", { advance_id: PADV, facts: { partner_haircut_reserve_cents: "25000000", partner_contribution_cents: "824000" } });
    at(et("2026-11-18", "10:00")); return run("funding_approver", { advance_id: PADV }, FUNDING_APPROVER);
  };
  /** Daily accruals for [from, to] with the clock at 00:30 ET of the following day (the SM_WH_DAILY_ACCRUAL slot). */
  const accrue = async (advanceId: string, from: string, to: string): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = [];
    for (let d = D(from); d <= D(to); d = D(new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10))) { at(et(new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10), "00:30")); out.push(await run("accrueInterest", { advance_id: advanceId, accrual_date: d, sofr: SOFR })); }
    return out;
  };
  const advance = (id: string) => rt.store.get("warehouse_advances", id)!.data;
  return { rt, uow, events, ledger, timers, run, at, timer, ofType, upstream, refused, violated, refiUpstream, fundRefi, purchaseUpstream, fundPurchase, accrue, advance, decisions, clock, svc };
}

test("27.1-T1: Given the fixture refinance with `funding.authorized` at 08:12 ET Thu Nov 12, 2026, all hard criteria passing and Secured Party confirmed Nov 9, when the `warehouse` agent evaluates, then the advance is approved within 2 business hours with `advance_cents = 54,880,000`, `partner_contribution_cents = 844,957`, `collateral_status = secured_control`, and the wire is released only after `funding_approver` approval.", async () => {
  const h = harness(et("2026-11-12", "08:12"));
  h.refiUpstream(); h.at(et("2026-11-12", "08:14"));
  const d = await h.run("approveAdvance", { request: refiRequest(), facts: refiFacts() });
  assert.equal(d.outcome, "approved"); assert.deepEqual(d.reasons, []);
  assert.equal(d.advance_cents, "54880000"); assert.equal(d.partner_contribution_cents, "844957"); assert.equal(d.collateral_plan, "secured_control"); assert.equal(d.wet, false);
  assert.deepEqual(d.soft_flags, ["commitment_expiry_lt_15d"], "the Nov 21 commitment expiry is flagged, not blocking");
  // the 2-business-hour SLA armed on `warehouse.advance.requested` (08:12 ET → due 10:12 ET) and satisfied by the 08:14 ET approval
  const sla = h.timer("SM_WH_ADVANCE_APPROVAL_2BH")!;
  assert.equal(sla.anchorDate, "2026-11-12"); assert.equal(new Date(sla.dueAt!).toISOString(), et("2026-11-12", "10:12")); assert.equal(sla.status, "satisfied");
  const approved = h.ofType("warehouse.advance.approved")[0]!; assert.equal(sla.satisfiedByEventId, approved.id); assert.equal(approved.payload.decision, "approved");
  assert.equal(h.advance(ADV).status, "approved"); assert.equal(h.advance(ADV).eligibility_snapshot && (h.advance(ADV).eligibility_snapshot as { hard_pass: boolean }).hard_pass, true);
  // the decision record per LL-2026-04
  const rec = d.decision_record as Record<string, unknown>; assert.equal(rec.outcome, "approved"); assert.equal(rec.policy_version, "sm.warehouse.v1"); assert.equal(rec.advance_cents, "54880000"); assert.ok(rec.eligibility_snapshot); assert.equal(h.decisions.at(-1)!.action, "approveAdvance:approved");
  // the agent prepares the wire package and hands it to funding_approver; the cut-off and haircut gates are armed on the approval
  const pkg = await h.run("prepareWire", { advance_id: ADV, facts: haircut });
  assert.equal(pkg.released, false); assert.equal(pkg.handed_to, "funding_approver"); assert.equal(pkg.wire_cents, "55724957"); assert.equal(pkg.value_date, "2026-11-12"); assert.equal(pkg.same_day, true);
  assert.equal(h.rt.escalations.opened.filter((e) => e.kind === "funding_approver").length, 1);
  assert.equal(h.timer("SM_WH_ADVANCE_CUTOFF_GATE")!.status, "armed"); assert.equal(new Date(h.timer("SM_WH_ADVANCE_CUTOFF_GATE")!.dueAt!).toISOString(), et("2026-11-12", "13:00")); assert.equal(h.timer("SM_WH_HAIRCUT_RESERVE_GATE")!.status, "armed");
  assert.equal(h.ofType("warehouse.advance.funded").length, 0, "no wire before funding_approver approval");
  // funding_approver releases at 09:40 ET → funded, advance_date Nov 12, secured_control, both gates satisfied, ledger balanced against 30.2's clearing
  h.at(et("2026-11-12", "09:40"));
  const f = await h.run("funding_approver", { advance_id: ADV }, FUNDING_APPROVER);
  assert.equal(f.advance_date, "2026-11-12"); assert.equal(f.collateral_status, "secured_control"); assert.equal(f.wire_cents, "55724957"); assert.ok(f.approval_id);
  const funded = h.ofType("warehouse.advance.funded")[0]!; assert.equal(funded.payload.funding_approver_approval_id, f.approval_id); assert.ok(Date.parse(funded.occurredAt) > Date.parse(approved.occurredAt));
  assert.equal(h.timer("SM_WH_ADVANCE_CUTOFF_GATE")!.status, "satisfied"); assert.equal(h.timer("SM_WH_HAIRCUT_RESERVE_GATE")!.status, "satisfied");
  assert.equal(h.timers.byCode("SM_WH_ENOTE_SECURED_PARTY_1BD").length, 0, "Secured Party confirmed Nov 9: no eNote Secured Party clock");
  for (const code of ["SM_WH_AGING_45_CURTAIL", "SM_WH_AGING_60_REPURCHASE", "SM_WH_AGING_90_KICKOUT", "SM_WH_DAILY_ACCRUAL", "SM_WH_INTEREST_CAPITALIZE_MONTHLY"]) assert.equal(h.timer(code)!.status, "armed", code);
  assert.deepEqual([h.timer("SM_WH_AGING_45_CURTAIL")!.dueDate, h.timer("SM_WH_AGING_60_REPURCHASE")!.dueDate, h.timer("SM_WH_AGING_90_KICKOUT")!.dueDate], ["2026-12-28", "2027-01-11", "2027-02-10"]);
  assert.equal(h.ledger.sets().length, 2); for (const s of h.ledger.sets()) assert.equal(s.lines.reduce((t, l) => t + l.amountCents, 0n), 0n);
  assert.equal(h.ledger.balance(origFundingClearing(LOAN)), 55_724_957n, "30.2's per-loan clearing credit is cleared by the advance posting");
  assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "warehouse_advance_receivable.principal" as never }), 54_880_000n);
  assert.equal(h.advance(ADV).status, "funded"); assert.equal(h.advance(ADV).outstanding_principal_cents, "54880000");
});

test("27.1-T2: Given the same request but `compliance.gate.opened{gate=disbursement}` absent, then the advance is rejected with reason `disbursement_gate_closed` and no wire is prepared; given `wire_verifications.match_result = changed`, then rejected with `wire_verification_failed`.", async () => {
  const h = harness(et("2026-11-12", "08:12"));
  h.upstream("clear_to_close.issued", { checklist_id: "ctc-1", passed: true }, et("2026-11-04", "15:00"));
  h.upstream("funding.authorized", { funding_id: "fund-refi-1" }, et("2026-11-12", "08:12")); h.at(et("2026-11-12", "08:14"));
  const d = await h.run("approveAdvance", { request: refiRequest(), facts: refiFacts() });
  assert.equal(d.outcome, "rejected"); assert.deepEqual(d.reasons, ["disbursement_gate_closed"]);
  assert.equal(h.ofType("warehouse.advance.rejected").length, 1); assert.equal(h.timer("SM_WH_ADVANCE_APPROVAL_2BH")!.status, "satisfied");
  assert.equal(h.advance(ADV).status, "rejected"); assert.equal(h.advance(ADV).advance_cents, "0");
  await assert.rejects(h.run("prepareWire", { advance_id: ADV, facts: haircut }), (e: unknown) => e instanceof RangeError && /rejected/.test(e.message));
  assert.equal(h.rt.escalations.opened.filter((e) => e.kind === "funding_approver").length, 0, "no wire prepared"); assert.equal(h.timers.byCode("SM_WH_ADVANCE_CUTOFF_GATE").length, 0);
  assert.equal(h.decisions.at(-1)!.action, "approveAdvance:rejected"); assert.equal(h.decisions.at(-1)!.ruleCode, "disbursement_gate_closed");
  // the settlement-agent wire verification changed (24.4) → wire_verification_failed
  const h2 = harness(et("2026-11-12", "08:12")); h2.refiUpstream(); h2.at(et("2026-11-12", "08:14"));
  const d2 = await h2.run("approveAdvance", { request: refiRequest(), facts: refiFacts({ wire_verification: { id: "wv-refi-1", match_result: "changed", expires_at: et("2026-12-03", "23:59"), blocks_disbursement: true } }) });
  assert.equal(d2.outcome, "rejected"); assert.deepEqual(d2.reasons, ["wire_verification_failed"]);
  // the pure evaluator names every hard criterion with its evidence id
  const snap = evaluateEligibility({ ...(refiFacts() as unknown as EligibilityFacts), note_amount_cents: 56_000_000n, first_payment_date: D("2027-01-01"), disbursement_date: D("2026-11-12"), appraisal_expires_at: D("2027-03-01"), ctc_issued: true, disbursement_gate_opened: true, commitment: { commitment_id_fnma: "BE-2026-11-0001", live: true, expires_on: D("2026-11-21"), type: "best_efforts" } }, FACILITY_FIXTURE);
  assert.equal(snap.hard_pass, true); assert.equal(snap.criteria.filter((c) => c.kind === "hard").length, 15); assert.equal(snap.criteria.find((c) => c.code === "c_disbursement_gate")!.evidence_id, "ctr-9");
});

test("27.1-T3: Given the fixture advance funded Nov 12 with SOFR 4.30% and spread 2.50%, when 7 daily accruals run, then postings are 103.66, 103.66, 103.67, 103.66, 103.66, 103.66, 103.67 cents×100 and `interest_accrued_cents = 72,564` on Nov 19 before repayment; a per-diem-rounding implementation (72,562) fails.", async () => {
  const h = harness(et("2026-11-12", "08:12")); await h.fundRefi();
  const rows = await h.accrue(ADV, "2026-11-12", "2026-11-18");
  assert.deepEqual(rows.map((r) => r.posted_cents), ["10366", "10366", "10367", "10366", "10366", "10366", "10367"]);
  assert.deepEqual(rows.map((r) => r.all_in_rate_bps), [680, 680, 680, 680, 680, 680, 680]); assert.equal(rows[0]!.index_rate_bps, 430);
  assert.deepEqual(rows.map((r) => r.index_publication_date), ["2026-11-10", "2026-11-12", "2026-11-13", "2026-11-13", "2026-11-13", "2026-11-16", "2026-11-17"], "one-business-day lookback; Veterans Day and the weekend reuse the last published value");
  h.at(et("2026-11-19", "09:00"));
  assert.equal(h.advance(ADV).interest_accrued_cents, "72564"); assert.equal(rows.at(-1)!.interest_accrued_cents, "72564");
  assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "warehouse_interest_receivable" as never }), 72_564n);
  assert.equal(h.ledger.balance({ scope: "corporate", account: "warehouse_interest_income" as never }), -72_564n);
  // the rejected implementation: $103.66 per diem × 7 = $725.62
  assert.equal(naivePerDiemTotal(54_880_000n, 680, 7), 72_562n); assert.notEqual(naivePerDiemTotal(54_880_000n, 680, 7), 72_564n);
  // SM_WH_DAILY_ACCRUAL: armed at funding, satisfied and re-armed by every `warehouse.interest.accrued`
  const inst = h.timers.byCode("SM_WH_DAILY_ACCRUAL"); assert.equal(inst.length, 8); assert.equal(inst.filter((t) => t.status === "satisfied").length, 7); assert.equal(inst.at(-1)!.status, "armed"); assert.equal(inst[0]!.dueDate, "2026-11-13"); assert.equal(new Date(inst[0]!.dueAt!).toISOString(), et("2026-11-13", "00:30"));
  // a duplicate accrual date is a replay
  assert.equal((await h.run("accrueInterest", { advance_id: ADV, accrual_date: "2026-11-18", sofr: SOFR })).duplicate, true); assert.equal(h.advance(ADV).interest_accrued_cents, "72564");
});

test("27.1-T4: Given the purchase fixture funded wet on Wed Nov 18, 2026 with a paper note, then `SM_WH_WET_NOTE_DELIVERY_5BD.due_at` = Wed Nov 25, 2026 (Thanksgiving excluded); a trust receipt on Fri Nov 20 satisfies it and sets `secured_possession`; no receipt by Nov 25 sets `wet_overdue`, +100 bps from Nov 26, and a full-repayment curtailment due at day 10.", async () => {
  const h = harness(et("2026-11-18", "09:00"), PLOAN, PAPP); const f = await h.fundPurchase();
  assert.equal(f.advance_date, "2026-11-18"); assert.equal(f.collateral_status, "unsecured_wet"); assert.equal(h.advance(PADV).wet_reason, "wet_state_paper"); assert.equal(h.advance(PADV).advance_cents, "40376000");
  const wet = h.timer("SM_WH_WET_NOTE_DELIVERY_5BD")!; assert.equal(wet.status, "armed"); assert.equal(wet.dueDate, "2026-11-25"); assert.equal(new Date(wet.dueAt!).toISOString(), et("2026-11-25", "23:59"));
  assert.equal(wetNoteDeadline(FACILITY_FIXTURE, D("2026-11-18")), "2026-11-25");
  // trust receipt Fri Nov 20 → satisfied, secured_possession (day 2)
  h.at(et("2026-11-20", "11:00"));
  const tr = await h.run("trackCollateral", { op: "trust_receipt", advance_id: PADV, receipt_id: "TR-1", received_at: et("2026-11-20", "10:30"), custody_record_id: PLOAN, bailee_letter_id: "BL-2026-11-18" });
  assert.equal(tr.collateral_status, "secured_possession"); assert.equal(wet.status, "satisfied"); assert.equal(wet.satisfiedByEventId, h.ofType("warehouse.note.received")[0]!.id);
  assert.equal(h.advance(PADV).collateral_status, "secured_possession"); assert.equal(h.advance(PADV).custody_record_id, PLOAN);
  // no receipt by Nov 25: breached at end of day; day 6 (Nov 26) wet_overdue, +100 bps, full-repayment curtailment at day 10
  const h2 = harness(et("2026-11-18", "09:00"), PLOAN, PAPP); await h2.fundPurchase();
  h2.at(et("2026-11-26", "00:05")); const breaches = h2.timers.evaluate(h2.clock.now());
  assert.ok(breaches.some((b) => b.instance.code === "SM_WH_WET_NOTE_DELIVERY_5BD")); assert.equal(h2.timer("SM_WH_WET_NOTE_DELIVERY_5BD")!.status, "breached");
  const aged = await h2.run("ageAdvances", { as_of: "2026-11-26" }); const row = (aged.advances as Record<string, unknown>[])[0]!;
  assert.equal(row.wet_overdue, true); assert.equal(h2.advance(PADV).wet_overdue, true);
  const curt = h2.ofType("warehouse.curtailment.due")[0]!; assert.equal(curt.payload.kind, "wet_overdue"); assert.equal(curt.payload.amount_cents, "40376000", "full repayment"); assert.equal(curt.payload.due_on, "2026-11-30");
  const wo = wetOverdue(FACILITY_FIXTURE, D("2026-11-18"), D("2026-11-26"), null); assert.equal(wo.overdue_from, "2026-11-26"); assert.equal(wo.stepup_bps, 100); assert.equal(wo.full_repayment_day, "2026-11-28", "day 10"); assert.equal(wo.full_repayment_due_on, "2026-11-30", "Sat Nov 28 rolls to the next servicer business day");
  assert.ok(h2.rt.escalations.opened.some((e) => e.kind === "sev1" && e.payload.reason === "wet_overdue"));
  const before = await h2.run("accrueInterest", { advance_id: PADV, accrual_date: "2026-11-25", sofr: SOFR }); const after = await h2.run("accrueInterest", { advance_id: PADV, accrual_date: "2026-11-26", sofr: SOFR });
  assert.equal(before.all_in_rate_bps, 680); assert.equal(after.all_in_rate_bps, 780); assert.equal(after.stepup_bps, 100);
});

test("27.1-T5: Given a wet-state paper advance with the MIN registered without SM's Interim Funder Org ID, then `SM_WH_INTERIM_FUNDER_DESIGNATION_7` breaches at note date + 7 calendar days, the advance is marked ineligible in the next borrowing-base snapshot, and an escalation to `post-closing` and `signing_officer{partner}` is opened.", async () => {
  const h = harness(et("2026-11-18", "09:00"), PLOAN, PAPP); await h.fundPurchase();
  const t = h.timer("SM_WH_INTERIM_FUNDER_DESIGNATION_7")!; assert.equal(t.anchorDate, "2026-11-18"); assert.equal(t.dueDate, "2026-11-25"); assert.equal(interimFunderDeadline(D("2026-11-18")), "2026-11-25");
  // 26.4 registers the MIN Mon Nov 23 with the partner's Org ID in the Interim Funder field, not SM's
  h.at(et("2026-11-23", "10:00"));
  const v = await h.run("trackCollateral", { op: "interim_funder", advance_id: PADV, min: PMIN, interim_funder_org_id: PARTNER_ORG, registered_at: et("2026-11-23", "09:30") });
  assert.equal(v.designated, false); assert.equal(h.ofType("warehouse.interim_funder.designated").length, 0);
  const esc = h.rt.escalations.opened; assert.ok(esc.some((e) => e.ownerRole === "post-closing")); const so = esc.find((e) => e.kind === "signing_officer")!; assert.equal(so.payload.party, "partner"); assert.equal(so.payload.reason, "interim_funder_missing");
  assert.equal(h.ofType("warehouse.collateral.defect_recorded")[0]!.payload.source, "mers_mismatch");
  h.at(et("2026-11-26", "00:05")); h.timers.evaluate(h.clock.now()); assert.equal(t.status, "breached");
  await h.run("trackCollateral", { op: "trust_receipt", advance_id: PADV, receipt_id: "TR-2", received_at: et("2026-11-20", "10:30"), custody_record_id: PLOAN });   // the note itself arrived on time
  const bb = await h.run("computeBorrowingBase", { as_of: "2026-11-26" });
  assert.equal((bb.ineligible_cents as Record<string, string>).interim_funder_missing, "40376000"); assert.equal((bb.rows as Record<string, unknown>[])[0]!.eligible, false); assert.equal(bb.eligible_collateral_value_cents, "0");
  assert.deepEqual(h.ofType("warehouse.borrowing_base.computed")[0]!.payload.ineligible_advances, [{ advance_id: PADV, reason: "interim_funder_missing" }]);
  // cured: the MIN Update adds SM's Org ID → designated (satisfied_late), eligible again
  h.at(et("2026-11-27", "10:00")); const ok = await h.run("trackCollateral", { op: "interim_funder", advance_id: PADV, min: PMIN, interim_funder_org_id: SM_MERS_ORG_ID, registered_at: et("2026-11-27", "09:30") });
  assert.equal(ok.designated, true); assert.equal(t.status, "satisfied_late"); assert.equal((await h.run("computeBorrowingBase", { as_of: "2026-11-27" })).eligible_collateral_value_cents, "40376000");
});

test("27.1-T6: Given a bailee letter whose `letter_name` differs from `warehouse_facilities.bailee_letter_name` by one character, when `issueBaileeLetter` runs, then rendering is refused; given a letter whose `wire_instructions_hash` ≠ the partner's Form 482 payee-code hash for SM, then refused with `form_482_mismatch`.", async () => {
  const h = harness(et("2026-11-18", "09:00"), PLOAN, PAPP);
  const letter = (over: Record<string, unknown> = {}) => ({ bailee_letter_id: "BL-2026-11-18", custodian_party_id: "party-fcc-1", letter_name: FACILITY_FIXTURE.bailee_letter_name, letter_date: "2026-11-18", loan_list: [{ advance_id: PADV, seller_loan_number: "SM-000000002", borrower_last_name: "Ortiz", note_amount_cents: "41200000", note_date: "2026-11-18" }], wire_instructions_hash: FACILITY_FIXTURE.form_482_payee_hash, fnma_letter_type: "bailee", signature_kind: "esign", ...over });
  const v1 = await h.violated(h.run("issueBaileeLetter", { letter: letter({ letter_name: "Supermortgage Warehouse Finance, LLC." }) }), "letter_name_mismatch");
  assert.match(v1.message, /character-for-character/); assert.equal(h.rt.store.get("bailee_letters", "BL-2026-11-18"), undefined, "nothing rendered");
  const v2 = await h.violated(h.run("issueBaileeLetter", { letter: letter({ wire_instructions_hash: "sha256:some-other-account" }) }), "form_482_mismatch");
  assert.match(v2.message, /Form 482/);
  assert.deepEqual(h.ofType("warehouse.guardrail.violated").map((e) => e.payload.code), ["letter_name_mismatch", "form_482_mismatch"]);
  const pure = issueBaileeLetter(FACILITY_FIXTURE, { bailee_letter_id: "BL-x", facility_id: FACILITY_FIXTURE.facility_id, custodian_party_id: "party-fcc-1", letter_name: "supermortgage warehouse finance, llc", letter_date: D("2026-11-18"), loan_list: [{ advance_id: PADV, seller_loan_number: "SM-000000002", borrower_last_name: "Ortiz", note_amount_cents: 41_200_000n, note_date: D("2026-11-18") }], wire_instructions_hash: FACILITY_FIXTURE.form_482_payee_hash, fnma_letter_type: "bailee", signature_kind: "esign" });
  assert.equal(pure.ok, false); assert.equal(!pure.ok && pure.refusal, "letter_name_mismatch");
  // the conforming letter renders with the C1-2-05 release condition and routes to officer{sm} for e-signature; the agent may not sign; the officer's signature issues it
  const r = await h.run("issueBaileeLetter", { letter: letter() });
  assert.equal(r.rendered, true); assert.equal(r.release_condition_text, releaseConditionText("Supermortgage Warehouse Finance, LLC")); assert.match(String(r.release_condition_text), /released only if the proceeds from the transfer of the mortgages to Fannie Mae are delivered to/); assert.equal(r.expires_on, "2027-02-16"); assert.equal(r.routed_to, "officer"); assert.equal(r.status, "draft");
  assert.equal(h.ofType("warehouse.bailee_letter.issued").length, 0);
  await h.refused(h.run("issueBaileeLetter", { op: "sign", bailee_letter_id: "BL-2026-11-18" }), "BAILEE_LETTER_SIGNATURE_IS_OFFICER");
  const s = await h.run("issueBaileeLetter", { op: "sign", bailee_letter_id: "BL-2026-11-18" }, OFFICER); assert.equal(s.status, "issued"); assert.equal(h.ofType("warehouse.bailee_letter.issued").length, 1);
  await h.refused(h.run("issueBaileeLetter", { op: "render", letter: letter(), change_letter_name: true }), "LETTER_NAME_IMMUTABLE");
});

test("27.1-T7: Given the fixture advance unpurchased at day 45 (Sun Dec 27, 2026), then a curtailment of $54,880.00 is due Mon Dec 28, the step-up applies from Dec 28 (day 46), and the payoff computed for a Tue Jan 5, 2027 purchase is $499,514.71; unpaid at day 60 (Mon Jan 11, 2027), then a repurchase demand of $500,115.64 is issued with `SM_WH_REPURCHASE_PAYMENT_5BD.due_at` = Tue Jan 19, 2027.", async () => {
  const h = harness(et("2026-11-12", "08:12")); await h.fundRefi();
  await h.accrue(ADV, "2026-11-12", "2026-11-30");
  h.at(et("2026-12-01", "06:00")); const cap = await h.run("capitalizeInterest", { advance_id: ADV, on: "2026-12-01" });
  assert.equal(cap.capitalized_cents, "196958", "Nov 12–30: 19 × $103.6622… = $1,969.58 capitalized on Dec 1"); assert.equal(h.timer("SM_WH_INTEREST_CAPITALIZE_MONTHLY")!.dueDate, "2027-01-01", "re-armed for the next 1st");
  await h.accrue(ADV, "2026-12-01", "2026-12-27");
  // day 45 = Sun Dec 27 → curtailment 10% × $548,800 = $54,880.00 due Mon Dec 28
  h.at(et("2026-12-27", "07:00")); const aged = await h.run("ageAdvances", { as_of: "2026-12-27" }); const row = (aged.advances as Record<string, unknown>[])[0]!;
  assert.equal(row.aged_days, 45); assert.equal(row.bucket, "d31_45"); assert.equal(row.curtailment_due_cents, "5488000");
  const due = h.ofType("warehouse.curtailment.due")[0]!; assert.equal(due.payload.kind, "aging_45"); assert.equal(due.payload.amount_cents, "5488000"); assert.equal(due.payload.due_on, "2026-12-28");
  const c45 = h.timer("SM_WH_AGING_45_CURTAIL")!; assert.equal(c45.dueDate, "2026-12-28"); assert.equal(c45.status, "armed");
  const c = curtailmentAt45(FACILITY_FIXTURE, D("2026-11-12"), 54_880_000n); assert.equal(c.day45_on, "2026-12-27"); assert.equal(c.due_on, "2026-12-28"); assert.equal(c.amount_cents, 5_488_000n); assert.equal(c.stepup_from, "2026-12-28"); assert.equal(c.balance_after_cents, 49_392_000n);
  // paid Dec 28 → balance $493,920.00; the step-up applies from day 46 (Dec 28): 7.30%
  h.at(et("2026-12-28", "11:00")); const paid = await h.run("issueCurtailment", { op: "paid", advance_id: ADV, curtailment_id: String(due.payload.curtailment_id), paid_at: et("2026-12-28", "10:45"), wire_in_ref: "wire-in-1" });
  assert.equal(paid.outstanding_principal_cents, "49392000"); assert.equal(c45.status, "satisfied"); assert.equal(h.ledger.balance({ scope: "loan", loanId: LOAN, account: "warehouse_advance_receivable.principal" as never }), 49_392_000n);
  assert.equal(((await h.run("ageAdvances", { as_of: "2026-12-28" })).advances as Record<string, unknown>[])[0]!.dwell_stepup_active, true);
  const dec28 = await h.accrue(ADV, "2026-12-28", "2026-12-31"); assert.equal(dec28[0]!.all_in_rate_bps, 730); assert.equal(dec28[0]!.stepup_bps, 50); assert.equal(dec28[0]!.principal_basis_cents, "49392000");
  h.at(et("2027-01-01", "06:00")); await h.run("capitalizeInterest", { advance_id: ADV, on: "2027-01-01" });
  await h.accrue(ADV, "2027-01-01", "2027-01-04");
  // payoff for a Tue Jan 5, 2027 purchase: $493,920.00 + $5,569.71 + $25.00 = $499,514.71
  h.at(et("2027-01-05", "09:00")); const a = h.advance(ADV);
  const accrued = h.rt.store.list("warehouse_interest_accruals", (d) => d.advance_id === ADV).map((r) => r.data);
  const totalInterest = accrued.reduce((s, r) => s + BigInt(String(r.posted_cents)), 0n); assert.equal(totalInterest, 556_971n); assert.equal(accrued.length, 54);
  const payoff = payoffStatement({ outstanding_principal_cents: BigInt(String(a.outstanding_principal_cents)), capitalized_interest_cents: BigInt(String(a.capitalized_interest_cents)), accrued_not_capitalized_cents: accrued.filter((r) => !r.capitalized).reduce((s, r) => s + BigInt(String(r.posted_cents)), 0n), fees_cents: BigInt(String(a.fees_outstanding_cents)), repayment_on: D("2027-01-05") });
  assert.equal(payoff.total_cents, 49_951_471n); assert.equal(payoff.through, "2027-01-04"); assert.equal(payoff.fees_cents, 2_500n);
  // unpaid at day 60 (Mon Jan 11, 2027): the repurchase demand (officer{sm} acknowledgment) with payment due Tue Jan 19, 2027 (MLK Day Jan 18 excluded)
  await h.accrue(ADV, "2027-01-05", "2027-01-10");
  h.at(et("2027-01-11", "07:00")); const aged60 = await h.run("ageAdvances", { as_of: "2027-01-11" }); assert.equal(((aged60.advances as Record<string, unknown>[])[0]!.aged_days), 60);
  const pkg = h.rt.escalations.opened.find((e) => e.payload.reason === "repurchase_demand")!; assert.equal(pkg.payload.demand_on, "2027-01-11"); assert.equal(pkg.payload.payment_due_on, "2027-01-19");
  assert.equal(h.timer("SM_WH_AGING_60_REPURCHASE")!.status, "armed"); h.timers.evaluate(et("2027-01-12", "00:01")); assert.equal(h.timer("SM_WH_AGING_60_REPURCHASE")!.status, "breached");
  const rs = repurchaseSchedule(FACILITY_FIXTURE, D("2026-11-12")); assert.deepEqual(rs, { demand_on: D("2027-01-11"), payment_due_on: D("2027-01-19") });
  h.at(et("2027-01-11", "10:00"));
  const demand = await h.run("demandRepurchase", { advance_id: ADV, officer_ack_id: "ack-officer-sm-1", reason: "aged_60" });
  assert.equal(demand.payment_due_on, "2027-01-19");
  // spec worked example C sums separately rounded segments ($4,768.46 + $1,402.18 → $500,115.64); rule 6's single cumulative gives $6,170.65 of interest → $500,115.65 (one cent; reported as a discrepancy)
  assert.equal(demand.payoff_cents, "50011565", "spec: $500,115.64 = $493,920.00 + $4,768.46 + $1,402.18 + $25.00; the cumulative method carries the segments' fractions across the Dec 28 principal change");
  assert.equal(segmentInterest(54_880_000n, 680, 46) + segmentInterest(49_392_000n, 730, 14) + 49_392_000n + 2_500n, 50_011_564n, "the spec's own arithmetic, segment by segment");
  const rp = h.timer("SM_WH_REPURCHASE_PAYMENT_5BD")!; assert.equal(rp.anchorDate, "2027-01-11"); assert.equal(rp.dueDate, "2027-01-19"); assert.equal(new Date(rp.dueAt!).toISOString(), et("2027-01-19", "23:59"));
  assert.equal(h.ofType("warehouse.repurchase.demanded")[0]!.payload.officer_ack_id, "ack-officer-sm-1");
  // the partner repurchases from its own funds → completed, repaid_from partner_repurchase, both clocks satisfied
  h.at(et("2027-01-15", "14:00")); const done = await h.run("demandRepurchase", { op: "completed", advance_id: ADV, paid_at: et("2027-01-15", "13:30"), wire_in_ref: "wire-in-2", amount_cents: "50011565" });
  assert.equal(done.status, "repurchased"); assert.equal(done.repaid_from, "partner_repurchase"); assert.equal(rp.status, "satisfied"); assert.equal(h.timer("SM_WH_AGING_90_KICKOUT")!.status, "satisfied"); assert.equal(h.timer("SM_WH_AGING_60_REPURCHASE")!.status, "satisfied_late");
});

test("27.1-T8: Given an eNote advance where the partner initiates the Transfer of Control and Location to Fannie Mae on Nov 17, when SM confirms as Secured Party and the registry accepts, then `collateral_status = transferred_pending_payment`, `enotes.secured_party_released_at` is set from the registry notification, and the advance remains in the borrowing base (Funding Agreement); when Fannie Mae later returns Control, then `secured_control` again and a defect is recorded.", async () => {
  const h = harness(et("2026-11-12", "08:12")); await h.fundRefi();
  h.at(et("2026-11-17", "10:15"));
  const r = await h.run("confirmTransferOfControl", { advance_id: ADV, transfer: { transfer_id: "xfer-1", min: MIN, from_controller_org_id: PARTNER_ORG, to_controller_org_id: FANNIE_MAE_ORG_ID, effective_date: "2026-11-17", initiated_by_org_id: PARTNER_ORG } });
  assert.equal(r.accepted, true); assert.equal(r.collateral_status, "transferred_pending_payment"); assert.equal(r.secured_party_released_at, et("2026-11-17", "10:15")); assert.equal(r.in_borrowing_base, true);
  assert.equal(h.advance(ADV).collateral_status, "transferred_pending_payment"); assert.equal(h.advance(ADV).status, "transferred_pending_payment"); assert.equal(h.advance(ADV).secured_party_released_at, et("2026-11-17", "10:15"));
  const enote = h.rt.store.get("enotes", LOAN)!.data; assert.equal(enote.secured_party_released_at, et("2026-11-17", "10:15")); assert.equal(enote.secured_party_org_id, null); assert.equal(enote.controller, "FNMA");
  const rel = h.ofType("warehouse.secured_party.released")[0]!; assert.equal(rel.payload.reason, "transfer_of_control"); assert.equal(rel.payload.confirmed_by_org_id, SM_MERS_ORG_ID); assert.equal(rel.payload.funding_agreement_reference, FACILITY_FIXTURE.funding_agreement_fnma_executed_at);
  assert.equal(await h.svc.registry.secured_party(MIN), null, "the registry removed SM as Secured Party on acceptance (eRegistry p. 33)");
  const bb = await h.run("computeBorrowingBase", { as_of: "2026-11-17" }); assert.equal((bb.rows as Record<string, unknown>[])[0]!.eligible, true); assert.equal(bb.eligible_collateral_value_cents, "54880000"); assert.equal(bb.outstanding_cents, "54880000");
  // Fannie Mae declines and returns Control (Funding Agreement) → secured_control, `returned`, a purchase_error defect with its 10-BD cure clock
  h.at(et("2026-11-20", "15:00"));
  const back = await h.run("trackCollateral", { op: "control_returned", advance_id: ADV, min: MIN, returned_at: et("2026-11-20", "14:50"), reason: "UCDP Doc File ID mismatch" });
  assert.equal(back.collateral_status, "secured_control"); assert.equal(back.status, "returned"); assert.equal(h.advance(ADV).secured_party_added_at, et("2026-11-20", "14:50"));
  const defect = h.ofType("warehouse.collateral.defect_recorded")[0]!; assert.equal(defect.payload.source, "purchase_error"); assert.equal(defect.payload.cure_due_at, "2026-12-07"); assert.equal(defect.payload.cure_owner, "secondary");
  assert.equal(h.timer("SM_WH_DEFECT_CURE_10BD")!.dueDate, "2026-12-07"); assert.equal(h.rt.store.get("warehouse_collateral_defects", String(defect.payload.defect_id))!.data.cured_at, null);
  // a retroactive effective date is rejected in full (eRegistry p. 27–28)
  const h2 = harness(et("2026-11-12", "08:12")); await h2.fundRefi(); h2.at(et("2026-11-18", "10:00"));
  assert.equal((await h2.run("confirmTransferOfControl", { advance_id: ADV, transfer: { transfer_id: "xfer-2", min: MIN, from_controller_org_id: PARTNER_ORG, to_controller_org_id: FANNIE_MAE_ORG_ID, effective_date: "2026-11-17", initiated_by_org_id: PARTNER_ORG } })).accepted, false);
  assert.equal(h2.advance(ADV).collateral_status, "secured_control");
});

test("27.1-T9: Given facility limit $50,000,000, wet sublimit 40%, wet outstanding $19,800,000, when a $403,760 wet advance is requested, then it is rejected for `wet_sublimit_exceeded` while an eNote advance with Secured Party confirmed of the same size is approved.", async () => {
  const h = harness(et("2026-11-18", "09:00"), PLOAN, PAPP);
  assert.equal(FACILITY_FIXTURE.facility_limit_cents, 5_000_000_000n); assert.equal(FACILITY_FIXTURE.wet_sublimit_pct, 40); assert.equal(wetSublimitCents(FACILITY_FIXTURE), 2_000_000_000n);
  // the book: one wet paper advance of $19,800,000 outstanding (eligible, within its delivery window)
  h.rt.store.put("warehouse_advances", "adv-book-wet", { advance_id: "adv-book-wet", loan_id: "L-BOOK-1", application_id: "app-book-1", facility_id: FACILITY_FIXTURE.facility_id, funding_id: "f-book", requested_at: et("2026-11-16", "09:00"), approved_at: et("2026-11-16", "09:30"), advance_date: "2026-11-16", value_date: "2026-11-16", note_form: "paper", wet_reason: "wet_state_paper", wet: true, note_amount_cents: "2020408200", net_disbursement_cents: "2020408200", advance_cents: "1980000000", partner_contribution_cents: "40408200", outstanding_principal_cents: "1980000000", capitalized_interest_cents: "0", fees_outstanding_cents: "0", interest_accrued_cents: "0", index_rate_bps: null, all_in_rate_bps: null, dwell_stepup_active: false, wet_overdue: false, collateral_value_cents: "1980000036", eligibility_snapshot: null, collateral_status: "unsecured_wet", custody_record_id: null, bailee_letter_id: null, interim_funder_designated_at: null, secured_party_added_at: null, secured_party_released_at: null, aging_bucket: "d0_30", aged_days: 2, curtailment_due_cents: "0", repurchase_demanded_at: null, kickout_at: null, status: "funded", wire_out_id: "fedwire-book", agent_decision_id: null, repaid_at: null, repaid_from: null, note_date: "2026-11-16", transaction_type: "purchase", wet_dry: "wet", commitment_price: "100.500", commitment_id_fnma: "BE-book", wire_verification_id: "wv-book", property_state: "OH", enote_registered_at: null, wet_deadline_on: "2026-11-23", interim_funder_due_on: "2026-11-23", reasons: [] }, AGENT, h.clock.now());
  const base = await h.run("computeBorrowingBase", { as_of: "2026-11-18" });
  assert.equal(base.wet_outstanding_cents, "1980000000"); assert.equal(base.wet_sublimit_cents, "2000000000"); assert.equal(base.wet_availability_cents, "20000000");
  h.purchaseUpstream(); h.at(et("2026-11-18", "09:05"));
  const wet = await h.run("approveAdvance", { request: purchaseRequest(), facts: purchaseFacts() });
  assert.equal(wet.outcome, "rejected"); assert.deepEqual(wet.reasons, ["wet_sublimit_exceeded"]); assert.equal(h.advance(PADV).status, "rejected"); assert.equal(h.advance(PADV).advance_cents, "0");
  assert.deepEqual(wet.wet_check, { wet_availability_cents: "20000000", required_cents: "40376000", pass: false });
  // the same size as an eNote with SM confirmed as Secured Party is dry — approved against the facility availability
  h.upstream("clear_to_close.issued", { checklist_id: "ctc-3", passed: true }, et("2026-11-13", "15:00"), { loanId: "L-ENOTE-2", applicationId: "app-enote-2" }); h.upstream("compliance.gate.opened", { gate: "disbursement" }, et("2026-11-18", "08:40"), { loanId: "L-ENOTE-2", applicationId: "app-enote-2" });
  const dry = await h.run("approveAdvance", { request: purchaseRequest({ advance_id: "adv-enote-2", loan_id: "L-ENOTE-2", application_id: "app-enote-2", funding_id: "fund-enote-2", note_form: "enote", closing_type: "ron", wet_dry: "dry", enote_registered_at: "2026-11-17", secured_party_added_at: et("2026-11-17", "16:00"), property_state: "AZ", wire_verification_id: "wv-enote-2", commitment_id_fnma: "BE-2026-11-0003" }), facts: purchaseFacts({ wet_dry: "dry", dry_recording_condition_met: true, wire_verification: { id: "wv-enote-2", match_result: "verified", expires_at: et("2026-12-10", "23:59"), blocks_disbursement: false }, commitment: { commitment_id_fnma: "BE-2026-11-0003", live: true, expires_on: "2026-12-18", type: "best_efforts" } }) });
  assert.equal(dry.outcome, "approved", JSON.stringify(dry.reasons)); assert.equal(dry.advance_cents, "40376000"); assert.equal(dry.wet, false); assert.equal(dry.collateral_plan, "secured_control"); assert.equal((dry.wet_check as { pass: boolean }).pass, true);
});

test("27.1-T10: Given a best-efforts commitment re-priced to 99.500 for a pledged loan with outstanding $548,800, when the borrowing base runs, then `collateral_value_cents` = 98% × 99.5% × $560,000 = $546,056.00, a margin call of $2,744.00 is issued, and `SM_WH_MARGIN_CALL_1BD` is opened.", async () => {
  const h = harness(et("2026-11-12", "08:12")); await h.fundRefi();
  assert.equal(h.advance(ADV).collateral_value_cents, "54880000", "at 101.375 the premium commitment caps at par: 98% × $560,000");
  assert.equal(collateralValue(FACILITY_FIXTURE, 56_000_000n, "99.500"), 54_605_600n); assert.equal(collateralValue(FACILITY_FIXTURE, 56_000_000n, "101.375"), 54_880_000n);
  h.at(et("2026-11-16", "07:00"));
  const bb = await h.run("computeBorrowingBase", { as_of: "2026-11-16", commitment_reprices: [{ advance_id: ADV, commitment_price: "99.500" }] });
  const row = (bb.rows as Record<string, unknown>[])[0]!; assert.equal(row.collateral_value_cents, "54605600"); assert.equal(row.outstanding_cents, "54880000"); assert.equal(row.margin_call_cents, "274400"); assert.equal(row.eligible, true);
  assert.equal(bb.margin_call_cents, "274400"); assert.deepEqual(bb.margin_calls, [{ advance_id: ADV, amount_cents: "274400", collateral_value_cents: "54605600", due_on: "2026-11-17" }]);
  const mc = h.ofType("warehouse.margin_call.issued")[0]!; assert.equal(mc.payload.amount_cents, "274400"); assert.equal(mc.payload.due_on, "2026-11-17");
  const t = h.timer("SM_WH_MARGIN_CALL_1BD")!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-11-16"); assert.equal(t.dueDate, "2026-11-17");
  assert.equal(h.ofType("warehouse.curtailment.due")[0]!.payload.kind, "margin_call"); assert.equal(h.advance(ADV).collateral_value_cents, "54605600"); assert.equal(h.advance(ADV).curtailment_due_cents, "274400");
  // a second run the same day does not double-issue; the partner's payment satisfies the clock
  assert.deepEqual((await h.run("computeBorrowingBase", { as_of: "2026-11-16" })).margin_calls, []);
  h.at(et("2026-11-17", "10:00")); const paid = await h.run("issueCurtailment", { op: "paid", advance_id: ADV, curtailment_id: String(mc.payload.curtailment_id ?? h.ofType("warehouse.curtailment.due")[0]!.payload.curtailment_id), paid_at: et("2026-11-17", "09:45"), wire_in_ref: "wire-in-mc" });
  assert.equal(paid.status, "paid"); assert.equal(t.status, "satisfied"); assert.equal(paid.outstanding_principal_cents, "54605600");
  assert.equal(h.ofType("warehouse.borrowing_base.computed").length, 2); assert.equal(h.timer("SM_WH_DAILY_REPORT_0900ET")!.status, "armed");
  const rep = await h.run("renderDailyReport", { as_of: "2026-11-16" }); assert.equal(h.timer("SM_WH_DAILY_REPORT_0900ET")!.status, "satisfied"); assert.equal((rep.curtailments_due as unknown[]).length, 0); assert.equal((rep.advances as Record<string, unknown>[])[0]!.bucket, "d0_30");
});

test("27.1-T11: Given the partner's quarterly package arrives 50 days after quarter end, then `SM_WH_COVENANT_QUARTERLY_45` breaches, `warehouse.covenant.breached{reporting}` fires, the facility is `suspended` for new advances, and existing advances continue to accrue and repay normally.", async () => {
  const h = harness(et("2026-09-30", "23:59"));
  const pe = await h.run("testCovenants", { op: "period_end", period_end: "2026-09-30", frequency: "quarterly" }); assert.equal(pe.package_due_on, "2026-11-14");
  const t = h.timer("SM_WH_COVENANT_QUARTERLY_45")!; assert.equal(t.anchorDate, "2026-09-30"); assert.equal(t.dueDate, "2026-11-14"); assert.equal(t.subject.kind, "warehouse_facility");
  h.at(et("2026-11-12", "08:12")); await h.fundRefi(); await h.accrue(ADV, "2026-11-12", "2026-11-18");
  h.at(et("2026-11-19", "10:00")); const breaches = h.timers.evaluate(h.clock.now()); assert.ok(breaches.some((b) => b.instance.code === "SM_WH_COVENANT_QUARTERLY_45")); assert.equal(t.status, "breached");
  // the package arrives Nov 19 (day 50): every covenant tested (period_complete → satisfied_late) but late → reporting breach → suspended
  const pkg = await h.run("testCovenants", { op: "package", period_end: "2026-09-30", frequency: "quarterly", received_at: et("2026-11-19", "09:30"), reported: { tangible_net_worth: "410000000", liquidity_30d: "30000000", leverage: "9.2", fnma_approval_maintained: "true", negative_pledge: "true", haircut_reserve_maintained: "true" }, evidence_document_id: "doc-q3-package", certified_by: "partner-officer-1" });
  assert.equal(pkg.late, true); assert.deepEqual(pkg.failed, []); assert.equal(pkg.breached, true); assert.equal(pkg.facility_status, "suspended"); assert.equal((pkg.rows as unknown[]).length, 6);
  assert.equal(t.status, "satisfied_late");
  const br = h.ofType("warehouse.covenant.breached")[0]!; assert.equal(br.payload.reporting, true); assert.equal(br.payload.kind, "reporting"); assert.equal(br.payload.facility_status, "suspended"); assert.equal(br.payload.waiver_window_ends_on, "2026-11-27");
  assert.equal(h.ofType("warehouse.facility.suspended").length, 1); assert.equal(h.rt.store.get("warehouse_facilities", FACILITY_FIXTURE.facility_id)!.data.status, "suspended");
  assert.ok(h.rt.escalations.opened.some((e) => e.kind === "officer" && e.payload.reason === "covenant_breach"));
  // no new advances while suspended
  h.upstream("clear_to_close.issued", { passed: true }, et("2026-11-13", "15:00"), { loanId: PLOAN, applicationId: PAPP }); h.upstream("compliance.gate.opened", { gate: "disbursement" }, et("2026-11-19", "08:30"), { loanId: PLOAN, applicationId: PAPP });
  const d = await h.run("approveAdvance", { request: purchaseRequest({ requested_at: et("2026-11-19", "09:40") }), facts: purchaseFacts({ disbursement_date: "2026-11-19" }) }); assert.equal(d.outcome, "rejected"); assert.ok((d.reasons as string[]).includes("facility_not_active"));
  // existing advances accrue and repay normally: the Nov 19 accrual posts, 27.2's repayment satisfies the aging clocks, the daily report still issues
  const acc = await h.run("accrueInterest", { advance_id: ADV, accrual_date: "2026-11-19", sofr: SOFR }); assert.equal(acc.posted_cents, "10366"); assert.equal(h.advance(ADV).interest_accrued_cents, "82930");
  h.upstream("warehouse.advance.repaid", { advance_id: ADV, repaid_at: "2026-11-19", repaid_from: "purchase_proceeds", bank_matched: true, note_form: "enote" }, et("2026-11-19", "15:00"));
  assert.equal(h.timer("SM_WH_AGING_60_REPURCHASE")!.status, "satisfied"); assert.equal(h.timer("SM_WH_AGING_90_KICKOUT")!.status, "satisfied");
  await h.run("computeBorrowingBase", { as_of: "2026-11-19" }); const rep = await h.run("renderDailyReport", { as_of: "2026-11-19" }); assert.equal(rep.covenant_status, "suspended");
  // waiver: the agent never waives; officer{sm} within 5 business days resumes the facility
  await h.refused(h.run("testCovenants", { op: "waive", covenant_code: "reporting", period_end: "2026-09-30", breached_on: "2026-11-19", waiver_id: "waiver-1" }), "COVENANT_WAIVER_IS_OFFICER");
  h.at(et("2026-11-24", "10:00")); assert.equal((await h.run("testCovenants", { op: "waive", covenant_code: "reporting", period_end: "2026-09-30", breached_on: "2026-11-19", waiver_id: "waiver-1" }, OFFICER)).facility_status, "active"); assert.equal(h.ofType("warehouse.facility.resumed").length, 1);
});

test("27.1-T12: Given any attempt by the `warehouse` agent to call the bank wire API without a `funding_approver` approval record, or to issue a kick-out without an `officer{sm}` acknowledgment, then the platform refuses the call and logs a guardrail violation.", async () => {
  const h = harness(et("2026-11-12", "08:12")); h.refiUpstream(); h.at(et("2026-11-12", "08:14"));
  await h.run("approveAdvance", { request: refiRequest(), facts: refiFacts() }); await h.run("prepareWire", { advance_id: ADV, facts: haircut });
  const before = h.events.all().length;
  // (a) the human-only release tool refused to the agent; (b) the release op without an approval record refused; (c) the bank port itself refuses a wire without the approval record
  const r1 = await h.refused(h.run("funding_approver", { advance_id: ADV }), "HUMAN_ONLY");
  assert.match(r1.message, /human act/);
  const r2 = await h.refused(h.run("prepareWire", { op: "release", advance_id: ADV, facts: haircut }), "WIRE_NEEDS_FUNDING_APPROVER");
  assert.match(r2.citation, /funding_approver/);
  const r3 = await h.violated(h.run("prepareWire", { op: "release", advance_id: ADV, funding_approver_approval_id: "fa-forged", facts: haircut }), "WIRE_NEEDS_FUNDING_APPROVER");
  assert.match(r3.message, /fa-forged/);
  const bank = h.svc.bank as FakeWarehouseBank;
  await h.violated(bank.releaseWire({ advance_id: ADV, value_date: D("2026-11-12"), amount_cents: 55_724_957n, beneficiary_wire_verification_id: "wv-refi-1", funding_account_ref: FACILITY_FIXTURE.funding_account_ref, idempotency_key: "x" }, null), "WIRE_NEEDS_FUNDING_APPROVER");
  await h.violated(bank.releaseWire({ advance_id: ADV, value_date: D("2026-11-12"), amount_cents: 55_724_957n, beneficiary_wire_verification_id: "wv-refi-1", funding_account_ref: FACILITY_FIXTURE.funding_account_ref, idempotency_key: "x" }, { approval_id: "self", approved_by: AGENT, approved_at: h.clock.now(), wire_cents: 55_724_957n }), "WIRE_NEEDS_FUNDING_APPROVER");
  assert.equal(bank.wires.length, 0); assert.equal(bank.refusals.length, 2); assert.equal(h.ofType("warehouse.advance.funded").length, 0);
  const logged = h.events.all().slice(before).filter((e) => e.type === "command.refused");
  assert.deepEqual(logged.map((e) => e.payload.code), ["HUMAN_ONLY", "WIRE_NEEDS_FUNDING_APPROVER"]);
  assert.equal(h.ofType("warehouse.guardrail.violated").filter((e) => e.payload.code === "WIRE_NEEDS_FUNDING_APPROVER").length, 1, "the forged approval id is logged by the handler as a guardrail violation");
  // the release with the real approval record goes through (dual control)
  h.at(et("2026-11-12", "09:40")); const f = await h.run("funding_approver", { advance_id: ADV }, FUNDING_APPROVER); assert.equal(bank.wires.length, 1); assert.equal(bank.wires[0]!.approval_id, f.approval_id);
  // kick-out without an officer{sm} acknowledgment: refused and logged; with the acknowledgment: issued, the facility suspended for new advances
  const r4 = await h.refused(h.run("issueKickout", { advance_id: ADV, reason: "aged_90" }), "KICKOUT_NEEDS_OFFICER_ACK");
  assert.match(r4.citation, /officer\{sm\} acknowledgment/); assert.equal(h.ofType("command.refused").at(-1)!.payload.code, "KICKOUT_NEEDS_OFFICER_ACK"); assert.equal(h.ofType("warehouse.kickout.issued").length, 0); assert.equal(h.advance(ADV).status, "funded");
  await h.refused(h.run("issueKickout", { advance_id: ADV, reason: "aged_90", officer_ack_id: "ack-1", liquidate: true }), "NO_AUTOMATED_LIQUIDATION");
  await h.refused(h.run("demandRepurchase", { advance_id: ADV, reason: "aged_60" }), "REPURCHASE_NEEDS_OFFICER_ACK");
  h.at(et("2027-02-10", "09:00")); const k = await h.run("issueKickout", { advance_id: ADV, reason: "aged_90", officer_ack_id: "ack-officer-sm-9" });
  assert.equal(k.status, "kicked_out"); assert.equal(k.facility_status, "suspended"); assert.equal(h.ofType("warehouse.kickout.issued")[0]!.payload.officer_ack_id, "ack-officer-sm-9"); assert.equal(h.ofType("warehouse.facility.suspended")[0]!.payload.reason, "kickout");
  assert.equal((await h.run("computeBorrowingBase", { as_of: "2027-02-10" })).eligible_collateral_value_cents, "0", "removed from the borrowing base");
  // the remaining guardrails of the paragraph
  await h.refused(h.run("evaluateEligibility", { facts: refiFacts(), reunderwrite: true }), "NO_REUNDERWRITE");
  await h.refused(h.run("evaluateEligibility", { facts: refiFacts(), read_applicant_demographics: true }), "NO_DEMOGRAPHICS");
  await h.refused(h.run("approveAdvance", { request: refiRequest(), facts: refiFacts(), legal_form: "purchase_at_closing" }), "NO_TABLE_FUNDING");
  await h.refused(h.run("assessFee", { advance_id: ADV, kind: "unused_line" }), "NO_UNUSED_LINE_FEE");
});

test("27.1 worked figures: fixture A $560,000.00 × 98% = $548,800.00 advance, $557,249.57 net disbursement (− $1,785.43 = 19 × $93.97 − $1,665.00 + $700.00), $8,449.57 partner contribution, 7 days at 6.80% act/360 = $725.64 by the cumulative method ($103.66/$103.67 postings; per-diem $725.62 rejected), payoff $549,550.64 with the $25.00 wire fee; fixture B $403,760.00, 14 days $1,067.72 ($76.27/$76.26), payoff $404,852.72; example C $54,880.00 curtailment → $493,920.00, $4,768.46 + $801.25 = $5,569.71, payoff $499,514.71, $1,969.58 capitalized Dec 1, $1,402.18 for 14 days at 7.30%", () => {
  const F = FACILITY_FIXTURE;
  // example A — advance and net disbursement (26.3 owns the figure; the composition is illustrative)
  const nd = netDisbursement({ note_amount_cents: 56_000_000n, per_diem_cents: 9_397n, prepaid_days: 19, initial_escrow_deposit_cents: 166_500n, lender_credit_cents: 70_000n });
  assert.equal(nd.prepaid_interest_cents, 178_543n); assert.equal(nd.net_disbursement_cents, 55_724_957n);
  const amt = advanceAmount(F, 56_000_000n, nd.net_disbursement_cents); assert.equal(amt.advance_cents, 54_880_000n); assert.equal(amt.partner_contribution_cents, 844_957n); assert.equal(amt.wire_cents, 55_724_957n);
  assert.equal(advanceAmount(F, 56_000_000n, 54_000_000n).advance_cents, 54_000_000n, "capped at the net disbursement");
  // example A — interest: SOFR 4.30% + 250 bps = 6.80%; daily unrounded $103.6622…; postings by the cumulative method
  assert.deepEqual(allInRateBps(F, 430, NO_FLAGS), { all_in_rate_bps: 680, stepup_bps: 0 }); assert.deepEqual(allInRateBps(F, 430, { dwell_stepup_active: true, wet_overdue: true }), { all_in_rate_bps: 830, stepup_bps: 150 }); assert.equal(allInRateBps(F, -5, NO_FLAGS).all_in_rate_bps, 250, "floor 0%");
  assert.deepEqual(indexRateFor(D("2026-11-12"), SOFR), { rate_bps: 430, publication_date: D("2026-11-10") }, "Nov 12 looks back one federal business day across Veterans Day");
  const a = accrualSchedule(F, { from: D("2026-11-12"), to: D("2026-11-18"), principalOn: () => 54_880_000n, flagsOn: () => NO_FLAGS, sofr: SOFR });
  assert.deepEqual(a.rows.map((r) => r.posted_cents), [10_366n, 10_366n, 10_367n, 10_366n, 10_366n, 10_366n, 10_367n]); assert.equal(a.total_posted_cents, 72_564n); assert.equal(a.rows[0]!.cumulative_interest_dollars, "103.66222222");
  assert.equal(naivePerDiemTotal(54_880_000n, 680, 7), 72_562n);
  const payoffA = payoffStatement({ outstanding_principal_cents: 54_880_000n, capitalized_interest_cents: 0n, accrued_not_capitalized_cents: a.total_posted_cents, fees_cents: assessFee(F, "wire_out").amount_cents, repayment_on: D("2026-11-19") });
  assert.equal(assessFee(F, "wire_out").amount_cents, 2_500n); assert.equal(payoffA.total_cents, 54_955_064n); assert.equal(payoffA.through, "2026-11-18");
  assert.deepEqual(wireValueDate(et("2026-11-12", "09:40")), { value_date: D("2026-11-12"), same_day: true }); assert.deepEqual(wireValueDate(et("2026-11-12", "13:30")), { value_date: D("2026-11-13"), same_day: false }); assert.deepEqual(wireValueDate(et("2026-11-11", "09:00")), { value_date: D("2026-11-12"), same_day: false }, "Veterans Day: Fedwire closed");
  // example B — purchase fixture: $412,000 × 98% = $403,760.00; 14 accrual days Nov 18–Dec 1 = $1,067.72; postings alternate $76.27 / $76.26
  const b = advanceAmount(F, 41_200_000n, 41_200_000n); assert.equal(b.advance_cents, 40_376_000n);
  const bs = accrualSchedule(F, { from: D("2026-11-18"), to: D("2026-12-01"), principalOn: () => 40_376_000n, flagsOn: () => NO_FLAGS, sofr: SOFR });
  assert.equal(bs.rows.length, 14); assert.equal(bs.total_posted_cents, 106_772n); assert.deepEqual(bs.rows.slice(0, 4).map((r) => r.posted_cents), [7_627n, 7_626n, 7_627n, 7_626n]); assert.equal(segmentInterest(40_376_000n, 680, 14), 106_772n);
  assert.equal(payoffStatement({ outstanding_principal_cents: 40_376_000n, capitalized_interest_cents: 0n, accrued_not_capitalized_cents: bs.total_posted_cents, fees_cents: 2_500n, repayment_on: D("2026-12-02") }).total_cents, 40_485_272n);
  assert.equal(wetNoteDeadline(F, D("2026-11-18")), "2026-11-25"); assert.equal(interimFunderDeadline(D("2026-11-18")), "2026-11-25");
  // example C — aging path: day 45 Sun Dec 27 → $54,880.00 due Mon Dec 28; balance $493,920.00; step-up to 7.30% from day 46; purchased Tue Jan 5, 2027
  const c45 = curtailmentAt45(F, D("2026-11-12"), 54_880_000n); assert.equal(c45.amount_cents, 5_488_000n); assert.equal(c45.due_on, "2026-12-28"); assert.equal(c45.balance_after_cents, 49_392_000n);
  assert.equal(segmentInterest(54_880_000n, 680, 46), 476_846n); assert.equal(segmentInterest(49_392_000n, 730, 8), 80_125n); assert.equal(segmentInterest(49_392_000n, 730, 14), 140_218n);
  const path = accrualSchedule(F, { from: D("2026-11-12"), to: D("2027-01-10"), principalOn: (d) => (d >= D("2026-12-28") ? 49_392_000n : 54_880_000n), flagsOn: (d) => ({ dwell_stepup_active: d >= D("2026-12-28"), wet_overdue: false }), sofr: SOFR });
  const thru = (to: string) => path.rows.filter((r) => r.accrual_date <= D(to)).reduce((s, r) => s + r.posted_cents, 0n);
  assert.equal(thru("2026-11-30"), 196_958n, "Nov 12–30 capitalized Dec 1: 19 × $103.6622… = $1,969.58"); assert.equal(capitalizeMonth(F, path.rows, D("2026-12-01")).capitalized_cents, 196_958n); assert.equal(capitalizeMonth(F, path.rows, D("2026-12-01")).month, "2026-11");
  assert.equal(thru("2027-01-04"), 556_971n, "$4,768.46 + $801.25 = $5,569.71"); assert.equal(path.rows.find((r) => r.accrual_date === D("2026-12-28"))!.all_in_rate_bps, 730);
  const payoffC = payoffStatement({ outstanding_principal_cents: 49_392_000n, capitalized_interest_cents: 196_958n, accrued_not_capitalized_cents: thru("2027-01-04") - 196_958n, fees_cents: 2_500n, repayment_on: D("2027-01-05") }); assert.equal(payoffC.total_cents, 49_951_471n);
  // the counterfactual day-60 demand: the spec sums rounded segments to $500,115.64; the single cumulative of rule 6 carries the Dec 28 fraction and gives $500,115.65
  assert.equal(thru("2027-01-10"), 617_065n); assert.equal(49_392_000n + thru("2027-01-10") + 2_500n, 50_011_565n); assert.equal(49_392_000n + 476_846n + 140_218n + 2_500n, 50_011_564n, "$500,115.64 as the spec adds it");
  assert.deepEqual(repurchaseSchedule(F, D("2026-11-12")), { demand_on: D("2027-01-11"), payment_due_on: D("2027-01-19") });
  // T10 mark-to-commitment and the wet sublimit
  assert.equal(collateralValue(F, 56_000_000n, "99.500"), 54_605_600n); assert.equal(54_880_000n - collateralValue(F, 56_000_000n, "99.500"), 274_400n); assert.equal(wetSublimitCents(F), 2_000_000_000n);
  const open: OpenAdvance = { advance_id: ADV, loan_id: LOAN, application_id: APP, note_amount_cents: 56_000_000n, outstanding_principal_cents: 54_880_000n, capitalized_interest_cents: 0n, commitment_price: "99.500", advance_date: D("2026-11-12"), note_form: "enote", wet: false, wet_deadline_on: null, collateral_status: "secured_control", interim_funder_designated_at: null, interim_funder_due_on: null, open_incurable_defect: false, status: "funded", state: "AZ", arm: false, occupancy: "primary", units: 1, tx_50a6: false };
  const snap = computeBorrowingBase(F, [open], D("2026-11-16")); assert.equal(snap.margin_call_cents, 274_400n); assert.equal(snap.availability_cents, 54_605_600n - 54_880_000n); assert.equal(snap.rows[0]!.aged_days, 4);
});
