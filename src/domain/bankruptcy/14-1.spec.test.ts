// 14.1 Bankruptcy monitoring & Proof of Claim
// spec/sections/14-bankruptcy/14-1-bankruptcy-monitoring-proof-of-claim.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, dayOfWeek, addDays } from "../../kernel/calendar/date.ts";
import { levelPayment, monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import { MemoryLedger, UnbalancedEntrySet, type LineInput, type LoanAccount } from "../../kernel/ledger/ledger.ts";
import { computeDue, defaultAnchorResolver } from "../../kernel/timers/engine.ts";
import * as C from "./case.ts";
import { ingestNotice, verifyNotice, pclMatch, postpetitionLateCharge, convertCase, ledgersFrozen, applyContractualFifo, applyDebtorPayment, postpetitionStatus, dischargeMode, planReview, arrearageTolerance, cramdownRequest, reliefOrderGate, assertGateOpen, GateClosed, postSaleIdentified, dismissalReversion, documentRequestDue, expenseClaim, allowableBkFee, docketClassification,
  clocks14_1, pocFiled, form410aPart5, petitionEscrowStatement, prepetitionFees, postpetitionSchedule, scheduledSplit, arrearageCureOrder, applyTrusteeVoucher, normalizeDesignation, mfrReferral, scoreMfrPath, serialFilerStay, referralPackage, completionClock, adequateProtectionCheck, orphanTrusteePayment, breachLetterPayload, type PriorCase } from "./ops-14-1.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_14_1 } from "../../app/tools/section14-1.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine, type TimerInstance } from "../../kernel/timers/engine.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { postpetitionEscrowChange } from "./ops-14-2.ts";
import { EVALUATORS_14_1 } from "./evaluators-14-1.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";
import { bankruptcyStayEnded } from "../foreclosure/ops-13-1.ts";
import { phaseForEvent } from "./ops-14-4.ts";
import { lateChargeAmount } from "../cashiering/latecharges.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import type { DomainEvent } from "../../kernel/events/types.ts";
import type { TimerDef } from "../../kernel/timers/registry.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";

// Fixture BK-13-A (spec rule 5 worked example): $325,000.00 at 6.500%, 360 months, first payment 2023-08-01; Chapter 13 petition Tuesday 2026-09-08.
const PETITION = D("2026-09-08");
const LOAN = "BK-13-A";
const NOTE = { original_upb_cents: 32_500_000n, rate_pct: "6.500", term_months: 360, pi_cents: 205_422n } as const;
const BORROWER = { last_name: "Borrower", ssn4: "1234", first_name: "Alex", property_address: "1 Test St, Houston TX 77001" };
const HIT = { last_name: "Borrower", ssn4: "1234", first_name: "Alex", address: "1 Test St, Houston TX 77001", case_number_full: "4:26-bk-31234", chapter: "13" as const, date_filed: PETITION };
const fixture = () => { const upb33 = balanceAfter(32_500_000n, "6.500", 360, 33); const unpaid = C.unpaidSplits(upb33, "6.500", 205_422n, D("2026-05-01"), PETITION, 10_271n, 15); return { upb33, unpaid, poc: C.proofOfClaim({ ib_upb_cents: upb33, nib_cents: 0n, unpaid, other_prepetition_fees_cents: 4_000n, escrow_balance_at_petition_cents: 112_000n - 234_000n - 270_000n, funds_on_hand_cents: 40_000n, pi_cents: 205_422n, escrow_monthly_cents: 64_500n }) }; };
const exampleALedgers = (): C.Ledgers => ({ prepetition_arrearage_cents: 1_424_194n, postpetition: [{ due: D("2026-10-01"), amount_cents: 269_922n, paid_cents: 0n }, { due: D("2026-11-01"), amount_cents: 280_672n, paid_cents: 0n }, { due: D("2026-12-01"), amount_cents: 280_672n, paid_cents: 0n }], postpetition_suspense_cents: 0n });
// Worked example A: the plan-terms schedule (payments #39–#41 of the note's amortization), the claim's cure order (14.1-Q5) and the filed 410S-1 (14.2 example).
const exampleA = () => { const { unpaid } = fixture(); return { a: exampleALedgers(), schedule: postpetitionSchedule({ first_postpetition_due: D("2026-10-01"), first_postpetition_payment_number: 39, months: 3, pi_cents: 205_422n, escrow_cents: 64_500n, escrow_change: { escrow_new_cents: 75_250n, effective_due_date: D("2026-11-01") } }), claim: { total_cents: 1_424_194n, components: arrearageCureOrder({ installments: unpaid, fees_cents: 45_084n, escrow_deficiency_cents: 392_000n, funds_on_hand_cents: 40_000n }) }, payment_change: { prior_amount_cents: 269_922n, new_amount_cents: 280_672n, effective_due_date: D("2026-11-01"), form_410s1_filed_on: D("2026-10-09"), form_410s1_docket_no: "27" } }; };
const asEvent = (e: { type: string; occurred_at: string; payload: Record<string, unknown> }, sequence: number): DomainEvent => ({ id: `e-${sequence}`, type: e.type, occurredAt: e.occurred_at, loanId: LOAN, actor: { kind: "agent", id: "bankruptcy-ops" }, payload: e.payload, sequence });
/** Registry-driven due date: the row must be armed by `ev` and its offset run from the row's anchor field. */
const dueFromRegistry = (def: TimerDef, ev: DomainEvent): string | undefined => { assert.ok(eventMatches(def.triggerPattern!, ev), `${def.code} is armed by ${ev.type}`); return computeDue(def.offsetParsed, defaultAnchorResolver(def, ev)!, Date.parse(ev.occurredAt)).dueDate; };
const byAccount = (lines: readonly LineInput[]): Record<string, bigint> => { const out: Record<string, bigint> = {}; for (const l of lines) { const k = l.account.account; out[k] = (out[k] ?? 0n) + l.amountCents; } return out; };
// ---- the §14.1 tools on the command bus with a TimerEngine over the overridden registry (only 14.1 rows arm): every timer is armed by the event a tool appends and satisfied by the event the responding tool appends.
const BK_OPS: Actor = { kind: "agent", id: "bankruptcy-ops" };
const ATTORNEY: Actor = { kind: "human", id: "u-attorney", role: "attorney" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
function bus(startIso: string, loanId = LOAN) {
  const clock = new FixedClock(startIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["14.1"] });
  const ctx: UowContext = { loanId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push({ loanId, ...d }); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const cmds = new Map<string, CommandSpec<ToolInput, unknown>>(); for (const d of TOOLS_14_1) { const c = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, c.name); cmds.set(d.name, c); }
  const cb = new CommandBus(agents);
  const run = async <O = Record<string, unknown>>(tool: string, input: Record<string, unknown>, opts: { actor?: Actor; now?: string } = {}): Promise<O> => { if (opts.now) clock.set(opts.now); return (await cb.execute(cmds.get(tool)!, opts.actor ?? BK_OPS, input, ctx)).output as O; };
  const one = (code: string): TimerInstance => { const all = timers.byCode(code); assert.equal(all.length, 1, `${code}: expected exactly one instance, found ${all.length}`); return all[0]!; };
  const armed = (code: string, due: string, subject = loanId): TimerInstance => { const t = timers.byCode(code).filter((x) => x.subject.id === subject).at(-1); assert.ok(t, `${code} armed for ${subject}`); assert.equal(t.status, "armed", `${code} status`); assert.equal(t.dueDate, due, `${code} due`); return t; };
  const satisfied = (code: string, byType: string, status: "satisfied" | "satisfied_late" = "satisfied", subject = loanId): void => { const t = timers.byCode(code).filter((x) => x.subject.id === subject).find((x) => x.status === status); assert.ok(t, `${code} ${status}`); assert.equal(events.all().find((e) => e.id === t.satisfiedByEventId)!.type, byType, `${code} satisfied by ${byType}`); };
  return { clock, events, timers, rt, run, decisions, one, armed, satisfied, refused: async (tool: string, input: Record<string, unknown>, code: string, actor: Actor = BK_OPS) => { await assert.rejects(cb.execute(cmds.get(tool)!, actor, input, ctx), (e: unknown) => e instanceof CommandRefused && e.code === code); } };
}

test("14.1-T1: Given an EBN notice for fixture BK-13-A received 2026-09-09 10:00, when ingested, then `stay_gates` show all blocks within 5 minutes, `FNMA_E2_1_03_SUSPEND_COLLECTION_0` is satisfied, and a scheduled D2-2-02 call for 2026-09-09 14:00 is cancelled.", () => {
  const r = ingestNotice({ source: "ebn", received_at: "2026-09-09T10:00:00-04:00", now: "2026-09-09T10:03:30-04:00", loan_id: LOAN, chapter: "13", case_number_full: "4:26-bk-31234", scheduled_contacts: [{ id: "call-1", kind: "d2202_call", at: "2026-09-09T14:00:00-04:00" }, { id: "insp-1", kind: "property_inspection", at: "2026-09-15T09:00:00-04:00" }] });
  assert.equal(r.applied_within_minutes, 3.5); assert.ok(r.applied_within_minutes <= 5, `gates applied ${r.applied_within_minutes} minutes after the notice`); assert.equal(r.applied_at, "2026-09-09T10:03:30-04:00"); assert.equal(r.gates.computed_at, "2026-09-09T10:03:30-04:00"); assert.equal(r.sla.breached, false); assert.equal(r.sla.escalation, null);
  assert.deepEqual([r.gates.collections_blocked, r.gates.foreclosure_blocked, r.gates.late_charges_blocked, r.gates.nsf_fees_blocked, r.gates.autodraft_paused], [true, true, true, true, true]); assert.equal(r.gates.contact_route, "counsel_only"); assert.equal(r.gates.escrow_mode, "postpetition_ch13");
  assert.deepEqual(r.cancelled_contacts.map((c) => c.id), ["call-1"]);   // the D2-2-02 call is cancelled; the property inspection (lien protection) is not
  assert.deepEqual(r.events.map((e) => e.type), ["bankruptcy.notice.received", "bankruptcy.gates.applied", "contact.scheduled.cancelled"]); assert.equal(r.events[1]!.payload.applied_within_minutes, 3.5);
  const def = loadOverriddenRegistry().get("FNMA_E2_1_03_SUSPEND_COLLECTION_0")!;
  assert.ok(eventMatches(def.triggerPattern!, asEvent(r.events[0]!, 1)), "armed by bankruptcy.notice.received"); assert.ok(eventMatches(def.satisfiedPattern!, asEvent(r.events[1]!, 2)), "satisfied by bankruptcy.gates.applied"); assert.equal(r.satisfies, "FNMA_E2_1_03_SUSPEND_COLLECTION_0");
  assert.deepEqual(r.verification, { status: "verifying", due: "2026-09-10", timer: "SM_BK_VERIFY_1BD" });
  // gates written six minutes after the notice breach the not-before gate: sev-1 (§362(k) exposure), Compliance Sentinel
  const late = ingestNotice({ source: "ebn", received_at: "2026-09-09T10:00:00-04:00", now: "2026-09-09T10:06:00-04:00", loan_id: LOAN, chapter: "13" });
  assert.equal(late.applied_within_minutes, 6); assert.equal(late.sla.breached, true); assert.equal(late.sla.escalation!.severity, "sev1"); assert.match(late.sla.escalation!.reason, /§362\(k\)/);
  assert.throws(() => ingestNotice({ source: "ebn", received_at: "2026-09-09T10:00:00-04:00", now: "2026-09-09T09:59:00-04:00", loan_id: LOAN }), RangeError);
  // on the bus the gate latency is measured against the unit of work's clock (the ingesting transaction), not a caller-supplied timestamp; the engine arms the gate on the notice and satisfies it on the gate recomputation
  return (async () => {
    const b = bus("2026-09-09T14:03:30.000Z");   // 10:03:30 ET
    const out = await b.run<ReturnType<typeof ingestNotice>>("bk.case.read/write", { op: "ingest_notice", loan_id: LOAN, source: "ebn", received_at: "2026-09-09T10:00:00-04:00", chapter: "13", case_number_full: "4:26-bk-31234", notice_id: "ebn-1", scheduled_contacts: [{ id: "call-1", kind: "d2202_call", at: "2026-09-09T14:00:00-04:00" }] });
    assert.equal(out.applied_within_minutes, 3.5); assert.equal(out.applied_at, "2026-09-09T14:03:30.000Z"); assert.deepEqual(out.cancelled_contacts.map((c) => c.id), ["call-1"]);
    assert.deepEqual(b.events.all().filter((e) => e.loanId === LOAN && /^(bankruptcy|contact)\./.test(e.type)).map((e) => e.type), ["bankruptcy.notice.received", "bankruptcy.gates.applied", "contact.scheduled.cancelled"]);
    b.satisfied("FNMA_E2_1_03_SUSPEND_COLLECTION_0", "bankruptcy.gates.applied"); b.armed("SM_BK_VERIFY_1BD", "2026-09-10");
    const gates = b.rt.store.get("stay_gates", LOAN)!.data; assert.deepEqual([gates.collections_blocked, gates.foreclosure_blocked, gates.autodraft_paused, gates.contact_route], [true, true, true, "counsel_only"]); assert.equal(b.rt.store.get("bankruptcy_cases", "bkcase-BK-13-A")!.data.status, "verifying");
    // a transaction clock six minutes after the notice breaches the not-before gate: the sev-1 escalation is opened on the bus
    const late = bus("2026-09-09T14:06:00.000Z"); await late.run("bk.case.read/write", { op: "ingest_notice", loan_id: LOAN, source: "ebn", received_at: "2026-09-09T10:00:00-04:00", chapter: "13" });
    assert.ok(late.events.all().some((e) => e.type === "escalation.created" && e.payload.severity === "sev1" && /§362\(k\)/.test(String(e.payload.reason))));
  })();
});
test("14.1-T2: Given the PCL party search returns a same-surname debtor with a different SSN4, then no case is opened, the notice is rejected with a decision record, and gates are released.", () => {
  const borrower = BORROWER;
  const hit = { last_name: "Borrower", ssn4: "9876", first_name: "Zed", address: "9 Other Rd, Dallas TX 75201", case_number_full: "4:26-bk-30001", chapter: "13" as const, date_filed: D("2026-09-08") };
  assert.equal(pclMatch(borrower, hit).matched, false); assert.match(pclMatch(borrower, hit).reason, /same surname, SSN4 9876 ≠ borrower SSN4 1234/);
  const r = verifyNotice({ notice_id: "ebn-1", loan_id: LOAN, borrower, hits: [hit], verified_at: "2026-09-09T11:00:00-04:00" });
  assert.equal(r.case_opened, false); assert.equal(r.case_number_full, null); assert.equal(r.decision.decision_type, "verify"); assert.equal(r.decision.outcome, "rejected"); assert.match(r.decision.rationale, /4:26-bk-30001 — same surname, SSN4 9876/);
  assert.equal(r.event.type, "bankruptcy.notice.rejected"); assert.equal((r.event.payload.evidence as unknown[]).length, 1);
  assert.deepEqual([r.gates.collections_blocked, r.gates.foreclosure_blocked, r.gates.late_charges_blocked, r.gates.autodraft_paused, r.gates.contact_route], [false, false, false, false, "borrower"]);
  // the rejection (with evidence) satisfies the 1-BD verification clock exactly as an opened case does
  const verify = loadOverriddenRegistry().get("SM_BK_VERIFY_1BD")!; const rejectedResolution = r.events.find((e) => e.type === "bankruptcy.notice.verified")!;
  assert.equal(rejectedResolution.payload.result, "rejected"); assert.equal((rejectedResolution.payload.evidence as unknown[]).length, 1); assert.ok(eventMatches(verify.satisfiedPattern!, asEvent(rejectedResolution, 1)), "a rejected notice satisfies SM_BK_VERIFY_1BD");
  const ok = verifyNotice({ notice_id: "ebn-1", loan_id: LOAN, borrower, hits: [{ ...hit, ssn4: "1234", first_name: "Alex", case_number_full: "4:26-bk-31234" }], verified_at: "2026-09-09T11:00:00-04:00" });
  assert.equal(ok.case_opened, true); assert.equal(ok.case_number_full, "4:26-bk-31234"); assert.equal(ok.event.type, "bankruptcy.petition.filed"); assert.equal(ok.gates.foreclosure_blocked, true);
  assert.ok(eventMatches(verify.satisfiedPattern!, asEvent(ok.events.find((e) => e.type === "bankruptcy.notice.verified")!, 2)), "an opened case satisfies SM_BK_VERIFY_1BD");
});
test("14.1-T3: Given petition 2026-09-08 (Ch. 13) and 130 days of delinquency, then timers due: referral 2026-09-22, prior-filing check 2026-09-22, POC bar 2026-11-17, supplement 2027-01-06; the POC package is ready by 2026-10-13.", () => {
  const c = clocks14_1({ petition_on: PETITION, chapter: "13", fnma_delinquency_days: 130 });
  assert.equal(c.order_for_relief_on, "2026-09-08"); assert.equal(c.referral.type, "full"); assert.equal(c.referral.timer, "FNMA_F2_01_BK_REFERRAL_14"); assert.equal(c.referral.due, "2026-09-22"); assert.match(c.referral.basis, /130 days delinquent/);
  assert.deepEqual(c.prior_filing_check, { timer: "FNMA_E2_1_02_PRIOR_FILING_CHECK_14", anchor: "petition_date", anchored_on: "2026-09-08", due: "2026-09-22", roll: "none" });
  assert.deepEqual(c.poc_bar, { timer: "FRBP_3002C_POC_BAR_70", anchor: "order_for_relief_date", anchored_on: "2026-09-08", due: "2026-11-17", roll: "frbp_9006_forward" }); assert.equal(dayOfWeek(c.poc_bar!.due), 2);   // Tuesday
  assert.equal(c.poc_supplement!.due, "2027-01-06"); assert.equal(dayOfWeek(c.poc_supplement!.due), 3);   // Wednesday
  assert.equal(c.poc_package!.due, "2026-10-13"); assert.equal(c.poc_package!.timer, "SM_BK_POC_PACKAGE_T35"); assert.equal(c.poc_package_target, "2026-10-13");
  // the same dates fall out of the registry rows when the verified petition arms them (registry-driven timers)
  const v = verifyNotice({ notice_id: "ebn-1", loan_id: LOAN, borrower: BORROWER, hits: [HIT], verified_at: "2026-09-09T11:00:00-04:00", fnma_delinquency_days_at_filing: 130 });
  assert.equal(v.referral, "full"); assert.equal(v.event.payload.petition_date, "2026-09-08"); assert.equal(v.event.payload.order_for_relief_date, "2026-09-08");
  const reg = loadOverriddenRegistry(); const filed = asEvent(v.event, 1); const window = asEvent(v.events.find((e) => e.type === "bankruptcy.claims_window.opened")!, 2);
  assert.equal(dueFromRegistry(reg.get("FNMA_F2_01_BK_REFERRAL_14")!, filed), "2026-09-22"); assert.equal(dueFromRegistry(reg.get("FNMA_E2_1_02_PRIOR_FILING_CHECK_14")!, filed), "2026-09-22"); assert.equal(dueFromRegistry(reg.get("SM_BK_POC_PACKAGE_T35")!, filed), "2026-10-13");
  assert.equal(window.payload.cause, "order_for_relief"); assert.equal(dueFromRegistry(reg.get("FRBP_3002C_POC_BAR_70")!, window), "2026-11-17");
  const poc = pocFiled({ loan_id: LOAN, order_for_relief_on: PETITION, filed_on: D("2026-11-10"), bar_date: c.poc_bar!.due, writings_complete: false });
  assert.equal(poc.timely, true); assert.equal(poc.status, "supplement_due"); assert.equal(poc.supplement!.due, "2027-01-06"); assert.equal(dueFromRegistry(reg.get("FRBP_3002C7_POC_SUPPLEMENT_120")!, asEvent(poc.event, 3)), "2027-01-06");
  assert.equal(eventMatches(reg.get("FRBP_3002C7_POC_SUPPLEMENT_120")!.triggerPattern!, asEvent(pocFiled({ loan_id: LOAN, order_for_relief_on: PETITION, filed_on: D("2026-11-10"), bar_date: c.poc_bar!.due, writings_complete: true }).event, 4)), false, "a claim filed with complete 3001(c)(1)/(d) writings arms no supplement clock");
  // < 60 days delinquent → poc_only referral sent immediately (14.1-Q3): no F-2-01 clock; the verified petition does not arm it
  const pocOnly = clocks14_1({ petition_on: PETITION, chapter: "13", fnma_delinquency_days: 20 }); assert.equal(pocOnly.referral.type, "poc_only"); assert.equal(pocOnly.referral.timer, null); assert.equal(pocOnly.referral.due, "2026-09-08");
  const vPocOnly = verifyNotice({ notice_id: "ebn-2", loan_id: LOAN, borrower: BORROWER, hits: [HIT], verified_at: "2026-09-09T11:00:00-04:00", fnma_delinquency_days_at_filing: 20 }); assert.equal(eventMatches(reg.get("FNMA_F2_01_BK_REFERRAL_14")!.triggerPattern!, asEvent(vPocOnly.event, 5)), false);
  // Rule 9006(a)(1)(C): a Saturday bar date rolls to Monday — calculator and registry alike (petition Saturday 2026-09-05 → 11-14 Sat → 2026-11-16)
  assert.equal(clocks14_1({ petition_on: D("2026-09-05"), chapter: "13", fnma_delinquency_days: 130 }).poc_bar!.due, "2026-11-16");
  const sat = asEvent({ type: "bankruptcy.claims_window.opened", occurred_at: "2026-09-05T12:00:00Z", payload: { chapter: "13", anchored_on: "2026-09-05" } }, 6); assert.equal(dueFromRegistry(reg.get("FRBP_3002C_POC_BAR_70")!, sat), "2026-11-16");
  assert.equal(clocks14_1({ petition_on: PETITION, chapter: "11", fnma_delinquency_days: 0 }).poc_bar, null);   // Chapter 11: court-set bar date (Rule 3003(c)(3))
});
test("14.1-T4: Given the fixture ledger, when the POC is computed, then Part 3 = $14,241.94 (1,774.81 + 8,496.29 + 450.84 + 3,920.00 − 400.00), Part 2 = $326,882.35, Part 4 = $2,699.22, Part 5 starts 2026-05-01, and every Part 5 row ties to ledger entry ids.", () => {
  const { upb33, unpaid, poc } = fixture();
  assert.deepEqual(poc.part3, { principal_due_cents: 177_481n, interest_due_cents: 849_629n, prepetition_fees_due_cents: 45_084n, escrow_deficiency_cents: 392_000n, funds_on_hand_cents: 40_000n, total_prepetition_arrearage_cents: 1_424_194n });
  assert.equal(poc.part3.total_prepetition_arrearage_cents, 177_481n + 849_629n + 45_084n + 392_000n - 40_000n); assert.equal(poc.part2_total_debt_cents, 32_688_235n); assert.equal(poc.part4_monthly_cents, 269_922n); assert.equal(poc.part5_starts, "2026-05-01");
  // the fixture ledger: every pre-petition money event is a balanced entry set with a rule_ref
  const ledger = new MemoryLedger();
  const loan = (account: LoanAccount, cents: bigint, ruleRef: string): LineInput => ({ account: { scope: "loan", loanId: LOAN, account }, amountCents: cents, ruleRef });
  const ti = (cents: bigint, ruleRef: string): LineInput => ({ account: { scope: "custodial", custodialAccountId: "custodial-ti", account: "custodial_ti_cash" }, amountCents: cents, ruleRef });
  ledger.post({ effectiveDate: D("2026-04-30"), description: "escrow balance after the 2026-04-01 installment", lines: [ti(112_000n, "3.x:escrow:balance"), loan("escrow", -112_000n, "3.x:escrow:balance")] });
  for (const u of unpaid) {
    ledger.post({ effectiveDate: u.due, description: `installment due ${u.due}: scheduled interest ${u.interest_cents} / principal ${u.principal_cents}`, lines: [loan("interest_due", u.interest_cents, "5.x:scheduled_interest:accrual"), { account: { scope: "corporate", account: "fnma_payable" }, amountCents: -u.interest_cents, ruleRef: "5.x:scheduled_interest:accrual" }] });
    if (u.late_charge_cents > 0n) ledger.post({ effectiveDate: addDays(u.due, 16), description: `late charge on the ${u.due} installment (grace ended ${addDays(u.due, 15)})`, lines: [loan("late_charges", u.late_charge_cents, "2.7:late_charge:assess"), { account: { scope: "corporate", account: "late_charge_income" }, amountCents: -u.late_charge_cents, ruleRef: "2.7:late_charge:assess" }] });
  }
  ledger.post({ effectiveDate: D("2026-06-15"), description: "hazard premium disbursed", lines: [loan("escrow", 234_000n, "3.x:escrow:disburse"), ti(-234_000n, "3.x:escrow:disburse")] });
  for (const on of ["2026-07-05", "2026-08-05"]) ledger.post({ effectiveDate: D(on), description: "property inspection", lines: [loan("other_fees", 2_000n, "9.x:inspection:fee"), { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -2_000n, ruleRef: "9.x:inspection:fee" }] });
  ledger.post({ effectiveDate: D("2026-08-20"), description: "taxes disbursed", lines: [loan("escrow", 270_000n, "3.x:escrow:disburse"), ti(-270_000n, "3.x:escrow:disburse")] });
  ledger.post({ effectiveDate: D("2026-08-25"), description: "partial payment received — suspense", lines: [{ account: { scope: "custodial", custodialAccountId: "custodial-pi", account: "clearing_cash" }, amountCents: 40_000n, ruleRef: "2.2:partial:suspense" }, loan("suspense_unapplied", -40_000n, "2.2:partial:suspense")] });
  const p5 = form410aPart5({ loan_id: LOAN, sets: ledger.sets(), first_default_due: D("2026-05-01"), petition_on: PETITION, principal_balance_cents: upb33, pi_cents: 205_422n, escrow_monthly_cents: 64_500n, part3: poc.part3 });
  assert.equal(p5.starts, "2026-05-01"); assert.equal(p5.ends, "2026-09-08"); assert.equal(p5.columns.length, 17); assert.equal(p5.columns[0], "A date"); assert.equal(p5.columns[16], "Q unapplied funds balance");
  assert.equal(p5.rows.length, 14);   // 5 installments + 4 late charges + 2 escrow disbursements + 2 inspections + 1 receipt; the 04-30 opening balance seeds column O without a row
  assert.deepEqual(p5.checks, { FORM410A_PART5_LEDGER_TIE: true, FORM410A_FIRST_DEFAULT_ANCHOR: true, FORM410A_PART3_SUM: true, FORM410A_PART5_TIES_TO_PART3: true });
  assert.deepEqual(p5.totals, poc.part3);   // the history reproduces Part 3 from the ledger alone
  const lineIds = new Set(ledger.sets().flatMap((s) => s.lines.map((l) => l.id)));
  assert.ok(p5.rows.every((r) => r.ledger_entry_ids.length === 2 && r.ledger_entry_ids.every((id) => lineIds.has(id)) && ledger.sets().some((s) => s.id === r.ledger_entry_set_id)), "every Part 5 row carries the ids of the ledger lines it came from");
  assert.equal(new Set(p5.rows.flatMap((r) => r.ledger_entry_ids)).size, 28);
  const first = p5.rows[0]!, receipt = p5.rows.find((r) => r.date === "2026-08-25")!, last = p5.rows[13]!;
  assert.deepEqual([first.date, first.contractual_due_date, first.contractual_payment_cents, first.accrued_interest_balance_cents, first.escrow_balance_cents, first.past_due_balance_cents], ["2026-05-01", "2026-05-01", 269_922n, 170_308n, 112_000n, 269_922n]);
  assert.deepEqual([receipt.funds_received_cents, receipt.unapplied_cents, receipt.to_principal_cents, receipt.to_interest_cents, receipt.unapplied_balance_cents], [40_000n, 40_000n, 0n, 0n, 40_000n]);
  assert.deepEqual([last.date, last.contractual_due_date, last.principal_balance_cents, last.accrued_interest_balance_cents, last.escrow_balance_cents, last.fees_balance_cents, last.unapplied_balance_cents, last.past_due_balance_cents], ["2026-09-01", "2026-09-01", 31_441_522n, 849_629n, -392_000n, 45_084n, 40_000n, 5n * 269_922n]);   // closing balances = Part 3's components
  assert.equal(p5.rows.filter((r) => r.contractual_due_date !== null).length, 5); assert.equal(p5.rows.find((r) => r.date === "2026-06-15")!.amount_incurred_cents, 234_000n); assert.equal(p5.rows.find((r) => r.date === "2026-05-17")!.fees_balance_cents, 10_271n);
  assert.equal(form410aPart5({ loan_id: LOAN, sets: ledger.sets(), first_default_due: D("2026-04-01"), petition_on: PETITION, principal_balance_cents: upb33, pi_cents: 205_422n, escrow_monthly_cents: 64_500n }).checks.FORM410A_FIRST_DEFAULT_ANCHOR, false);   // the history must open on the first date of default
  assert.equal(form410aPart5({ loan_id: LOAN, sets: ledger.sets(), first_default_due: D("2026-05-01"), petition_on: PETITION, principal_balance_cents: upb33, pi_cents: 205_422n, escrow_monthly_cents: 64_500n, part3: { ...poc.part3, funds_on_hand_cents: 0n } }).checks.FORM410A_PART5_TIES_TO_PART3, false);
  // Rule 3001(c)(2)(C): the escrow statement as of the petition date
  const es = petitionEscrowStatement({ opening_balance_cents: 112_000n, opening_on: D("2026-04-30"), petition_on: PETITION, disbursements: [{ on: D("2026-06-15"), kind: "hazard premium", cents: 234_000n }, { on: D("2026-08-20"), kind: "taxes", cents: 270_000n }] });
  assert.equal(es.balance_at_petition_cents, -392_000n); assert.equal(es.escrow_deficiency_for_funds_advanced_cents, poc.part3.escrow_deficiency_cents); assert.deepEqual(es.lines.map((l) => l.balance_cents), [-122_000n, -392_000n]);
});
test("14.1-T5: Given the Sept-1 installment's grace ends 2026-09-16 (post-petition), then no late charge is assessed and the claim's fees are $450.84.", () => {
  const lc = postpetitionLateCharge({ due: D("2026-09-01"), grace_days: 15, petition_on: PETITION, late_charge_cents: 10_271n });
  assert.equal(lc.grace_ends, "2026-09-16"); assert.equal(lc.postpetition, true); assert.equal(lc.assessed_cents, 0n); assert.equal(lc.memo_cents, 10_271n); assert.equal(lc.claim_item, false); assert.equal(lc.overlay, "bankruptcy_active"); assert.equal(lc.billable_via_14_2, false);
  const aug = postpetitionLateCharge({ due: D("2026-08-01"), grace_days: 15, petition_on: PETITION, late_charge_cents: 10_271n }); assert.equal(aug.grace_ends, "2026-08-16"); assert.equal(aug.assessed_cents, 10_271n); assert.equal(aug.claim_item, true);
  const { unpaid, poc } = fixture(); assert.equal(unpaid[4]!.due, "2026-09-01"); assert.equal(unpaid[4]!.late_charge_cents, 0n); assert.equal(unpaid.slice(0, 4).reduce((s, u) => s + u.late_charge_cents, 0n), 41_084n);
  assert.equal(poc.part3.prepetition_fees_due_cents, 45_084n);   // $410.84 late charges (May–Aug) + $40.00 inspections; nothing for September
});
test("14.1-T6: Given a conversion order on 2027-02-03, then a new 70-day POC timer is due 2027-04-14 and the Chapter 13 ledgers are frozen.", () => {
  const l = exampleALedgers(); C.applyVoucher(l, { amount_cents: 539_844n, designation: "post-petition", conduit_district: true }); C.applyVoucher(l, { amount_cents: 315_159n, designation: "unlabelled", conduit_district: true });
  const r = convertCase({ loan_id: LOAN, petition_on: PETITION, chapter_from: "13", chapter_to: "7", conversion_on: D("2027-02-03"), ledgers: l });
  assert.equal(r.poc_bar, "2027-04-14"); assert.deepEqual(r.poc_timer, { code: "FRBP_3002C_POC_BAR_70", anchor: "conversion_date", anchored_on: "2027-02-03", days: 70, due: "2027-04-14" });
  assert.equal(r.ledgers_frozen, true); assert.deepEqual(r.frozen_snapshot, { prepetition_arrearage_cents: 1_400_457n, postpetition_unpaid: [], postpetition_suspense_cents: 0n });
  assert.equal(r.petition_date, "2026-09-08"); assert.equal(r.chapter, "7"); assert.equal(r.converted_from_chapter, "13"); assert.equal(r.payment_application, "contractual_fifo"); assert.deepEqual(r.referral, { type: "conversion", to: "attorney" }); assert.ok(r.events.includes("bankruptcy.case.converted"));
  // the conversion order arms the registry's 70-day clock anchored on the conversion date (Rule 3002(c): "or entry of an order converting the case")
  const def = loadOverriddenRegistry().get("FRBP_3002C_POC_BAR_70")!; const window = r.emitted.find((e) => e.type === "bankruptcy.claims_window.opened")!;
  assert.deepEqual([window.payload.cause, window.payload.anchor, window.payload.anchored_on, window.payload.chapter], ["conversion", "conversion_date", "2027-02-03", "7"]);
  assert.equal(def.anchorField, "anchored_on"); assert.equal(dueFromRegistry(def, asEvent(window, 1)), "2027-04-14"); assert.match(def.overrideWhy!, /order converting the case/);
  // "the Chapter 13 ledgers are frozen": the plan-terms ledgers are immutable after conversion — a later voucher or debtor application throws; payments revert to contractual FIFO (rule 10)
  assert.equal(ledgersFrozen(l), true); assert.throws(() => C.applyVoucher(l, { amount_cents: 1n, designation: "arrearage", conduit_district: true }), TypeError); assert.throws(() => applyDebtorPayment(l, 280_672n, D("2027-02-10")), TypeError); assert.equal(l.prepetition_arrearage_cents, 1_400_457n);
  const ch11 = exampleALedgers(); assert.equal(convertCase({ petition_on: PETITION, chapter_from: "13", chapter_to: "11", conversion_on: D("2027-02-03"), ledgers: ch11 }).emitted.some((e) => e.type === "bankruptcy.claims_window.opened"), false);   // Chapter 11: Rule 3003(c)(3) bar date instead
  assert.equal(ledgersFrozen(ch11), false);   // 13 → 11 keeps a plan-terms ledger (a plan is still possible)
});
test("14.1-T7: Given the trustee voucher of 2026-12-18 ($5,398.44, Oct + Nov), then Oct is fully applied, Nov shows `short_cents=10750`, no suspense is created, the loan is post-petition current, and a payment-change reminder goes to counsel/trustee.", () => {
  const { a, schedule, claim, payment_change } = exampleA();
  assert.deepEqual(schedule.map((s) => [s.due, s.payment_number, s.amount_cents]), [["2026-10-01", 39, 269_922n], ["2026-11-01", 40, 280_672n], ["2026-12-01", 41, 280_672n]]);
  const r = applyTrusteeVoucher({ loan_id: LOAN, ledgers: a, schedule, note: NOTE, voucher: { amount_cents: 539_844n, designation: "post-petition", received_on: D("2026-12-18"), case_number_full: "4:26-bk-31234", claim_no: "7", memo: "post-petition Oct + Nov" }, conduit_district: true, claim, payment_change, chapter: "13" });
  assert.equal(r.designation, "post-petition"); assert.equal(r.applied_postpetition_cents, 539_844n); assert.equal(r.applied_arrearage_cents, 0n); assert.equal(r.arrearage_after_cents, 1_424_194n);
  // Oct = payment #39's scheduled split (plan-terms view), Nov = #40 with the $107.50 escrow shortfall on the escrow line (14.1-Q5)
  assert.deepEqual(r.allocations.map((x) => [x.due, x.payment_number, x.applied_cents, x.interest_cents, x.principal_cents, x.escrow_cents, x.short_cents]), [["2026-10-01", 39, 269_922n, 169_347n, 36_075n, 64_500n, 0n], ["2026-11-01", 40, 269_922n, 169_151n, 36_271n, 64_500n, 10_750n]]);
  assert.equal(a.postpetition[0]!.paid_cents, 269_922n); assert.equal(a.postpetition[1]!.paid_cents, 269_922n); assert.deepEqual(r.short, [{ due: "2026-11-01", short_cents: 10_750n }]);
  assert.equal(r.suspense_cents, 0n); assert.equal(a.postpetition_suspense_cents, 0n); assert.equal(r.postings.lines.some((l) => String(l.account.account) === "suspense_unapplied" || String(l.account.account) === "bk_postpetition_suspense"), false);
  assert.equal(r.status.current, true); assert.equal(r.status.fnma_bucket, 0); assert.deepEqual(r.status.short, [{ due: "2026-11-01", short_cents: 10_750n }]); assert.equal(r.status.event, null);
  assert.equal(r.decision.decision_type, "payment_application"); assert.match(r.decision.rationale, /short: 2026-11-01 10750/);
  // rule 6(a): set 1 posts the voucher to bk_trustee_clearing (Dr custodial cash per allocation / Cr clearing), set 2 splits it (Dr clearing / Cr interest, principal, escrow) — both balanced, posted through the ledger, which refuses an unbalanced set
  assert.equal(r.postings_sum_cents, 0n); assert.deepEqual(byAccount(r.receipt_postings.lines), { custodial_pi_cash: 410_844n, custodial_ti_cash: 129_000n, bk_trustee_clearing: -539_844n }); assert.deepEqual(byAccount(r.postings.lines), { bk_trustee_clearing: 539_844n, interest_due: -338_498n, principal: -72_346n, escrow: -129_000n }); assert.equal(r.clearing_residual_cents, 0n);
  const ledger = new MemoryLedger(); for (const set of [ledger.post(r.receipt_postings), ledger.post(r.postings)]) { assert.equal(set.lines.reduce((s, l) => s + l.amountCents, 0n), 0n); assert.ok(set.lines.every((l) => /^14\.1:rule6a:/.test(l.ruleRef))); }
  assert.equal(ledger.balance({ scope: "loan", loanId: LOAN, account: r.clearing_account as LoanAccount }), 0n);   // the voucher the event names as posted to clearing has been split in full — nothing pending in bk_trustee_clearing
  assert.equal(ledger.balance({ scope: "custodial", custodialAccountId: "custodial-pi", account: "custodial_pi_cash" }) + ledger.balance({ scope: "custodial", custodialAccountId: "custodial-ti", account: "custodial_ti_cash" }), 539_844n);
  // the payment-change reminder (informational, mail-only) goes to the trustee and counsel citing the filed 410S-1
  assert.deepEqual([r.reminder!.template, [...r.reminder!.recipients], r.reminder!.channel, r.reminder!.informational], ["NTC_BK_PAYMENT_INSTRUCTIONS", ["trustee", "counsel"], "mail_only", true]);
  assert.deepEqual([r.reminder!.payload.postpetition_amount_cents, r.reminder!.payload.prior_amount_cents, r.reminder!.payload.shortfall_cents, r.reminder!.payload.shortfall_due_date, r.reminder!.payload.form_410s1_filed_on, r.reminder!.payload.conduit], [280_672n, 269_922n, 10_750n, "2026-11-01", "2026-10-09", true]);
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_BK_PAYMENT_INSTRUCTIONS", D("2026-12-18"))!;
  const payload = { ...v.samplePayload, ...r.reminder!.payload }; const out = render(v.source, payload);
  assert.match(out.text, /post-petition installment amount is \$2,806\.72 beginning with the installment due November 1, 2026 \(previously \$2,699\.22\)/); assert.match(out.text, /Official Form 410S-1\) filed on October 9, 2026, docket no\. 27/); assert.match(out.text, /escrow shortfall of \$107\.50/); assert.match(out.text, /not an attempt to collect a debt from you personally/);
  assert.equal(evaluateChecklist(v, payload, out).passed, true); assert.equal(reg.template("NTC_BK_PAYMENT_INSTRUCTIONS").channelPolicy, "mail_only");
  assert.deepEqual(r.events.map((e) => e.type), ["bankruptcy.trustee_payment.received", "bankruptcy.postpetition.payment.applied", "bankruptcy.payment_change_reminder.requested"]);
  assert.equal(r.receipt_postings.lines.find((l) => l.amountCents < 0n)!.account.account, r.events[0]!.payload.clearing_account);   // the account the receipt event names is the one the voucher was actually credited to
  assert.throws(() => applyTrusteeVoucher({ loan_id: LOAN, ledgers: exampleALedgers(), schedule, note: NOTE, voucher: { amount_cents: 1n, designation: "Arrearage-ish", received_on: D("2026-12-18") }, conduit_district: true, claim }), RangeError);   // unknown designations are refused, never silently applied
  assert.equal(normalizeDesignation("conduit"), "conduit"); assert.equal(normalizeDesignation(""), "unlabelled");
});
test("14.1-T8: Given the 2027-01-20 voucher ($3,151.59), then Dec is paid, the Nov shortfall clears, `bk_prepetition_arrearage` = $14,004.57 and the ledger entries balance to zero.", () => {
  const { a, schedule, claim, payment_change } = exampleA();
  applyTrusteeVoucher({ loan_id: LOAN, ledgers: a, schedule, note: NOTE, voucher: { amount_cents: 539_844n, designation: "post-petition", received_on: D("2026-12-18") }, conduit_district: true, claim, payment_change, chapter: "13" });
  const r = applyTrusteeVoucher({ loan_id: LOAN, ledgers: a, schedule, note: NOTE, voucher: { amount_cents: 315_159n, designation: "unlabelled", received_on: D("2027-01-20"), memo: "Dec conduit 2,806.72; Nov catch-up 107.50; arrearage 237.37" }, conduit_district: true, claim, payment_change, chapter: "13" });
  assert.equal(r.designation, "unlabelled"); assert.equal(r.designation_applied, "post-petition"); assert.equal(r.decision.outcome, "unlabelled → post-petition first (conduit district)");
  assert.deepEqual(r.allocations.map((x) => [x.due, x.payment_number, x.applied_cents, x.interest_cents, x.principal_cents, x.escrow_cents, x.short_cents]), [["2026-11-01", 40, 10_750n, 0n, 0n, 10_750n, 0n], ["2026-12-01", 41, 280_672n, 168_955n, 36_467n, 75_250n, 0n]]);
  assert.deepEqual(r.short, []); assert.equal(a.postpetition[1]!.paid_cents, 280_672n); assert.equal(a.postpetition[2]!.paid_cents, 280_672n); assert.equal(r.status.current, true); assert.deepEqual(r.status.whole_unpaid, []);
  assert.equal(r.applied_postpetition_cents, 291_422n); assert.equal(r.applied_arrearage_cents, 23_737n); assert.equal(r.arrearage_after_cents, 1_400_457n); assert.equal(a.prepetition_arrearage_cents, 1_400_457n);
  assert.deepEqual(r.arrearage_allocations, [{ component: "interest", installment_due: "2026-05-01", cents: 23_737n, of_cents: 170_308n }]);   // component order: P&I first — interest 237.37 of May's 1,703.08
  assert.equal(r.arrearage_cured_bp, 1155); assert.equal(Math.round(r.arrearage_cured_bp / 10), 116);   // May's P&I ($2,054.22) 11.6% cured
  // Dr custodial_pi_cash / custodial_ti_cash per allocation into bk_trustee_clearing; then Cr interest_due 1,689.55, Cr principal 364.67, Cr escrow 752.50 + 107.50, Cr bk_prepetition_arrearage 237.37 out of clearing — balanced, linked to bankruptcy.trustee_payment.received
  assert.equal(r.postings_sum_cents, 0n); assert.deepEqual(byAccount(r.receipt_postings.lines), { custodial_pi_cash: 229_159n, custodial_ti_cash: 86_000n, bk_trustee_clearing: -315_159n }); assert.deepEqual(byAccount(r.postings.lines), { bk_trustee_clearing: 315_159n, interest_due: -168_955n, principal: -36_467n, escrow: -86_000n, bk_prepetition_arrearage: -23_737n });
  assert.deepEqual(r.postings.lines.filter((l) => l.account.account === "escrow").map((l) => l.amountCents), [-10_750n, -75_250n]);
  const ledger = new MemoryLedger(); ledger.post(r.receipt_postings, "2027-01-20T15:00:00Z"); const set = ledger.post(r.postings, "2027-01-20T15:00:00Z");
  assert.equal(set.lines.reduce((s, l) => s + l.amountCents, 0n), 0n); assert.equal(set.lines.length, 6); assert.equal(ledger.balance({ scope: "loan", loanId: LOAN, account: "bk_prepetition_arrearage" as LoanAccount }), -23_737n); assert.equal(ledger.balance({ scope: "loan", loanId: LOAN, account: "bk_trustee_clearing" as LoanAccount }), 0n); assert.match(set.lines.find((l) => String(l.account.account) === "bk_prepetition_arrearage")!.memo!, /interest 23737 of 170308 \(2026-05-01\)/);
  assert.throws(() => ledger.post({ ...r.postings, lines: r.postings.lines.filter((l) => String(l.account.account) !== "bk_prepetition_arrearage") }), UnbalancedEntrySet);   // a mis-split voucher never posts
  assert.deepEqual(r.events.map((e) => e.type), ["bankruptcy.trustee_payment.received", "bankruptcy.postpetition.payment.applied", "bankruptcy.prepetition.payment.applied"]); assert.equal(r.events[2]!.payload.bk_prepetition_arrearage_cents, 1_400_457n); assert.equal(r.reminder, null);
  // a non-conduit district applies unlabelled funds to the arrearage first, with the decision recorded
  const nonConduit = applyTrusteeVoucher({ loan_id: LOAN, ledgers: exampleALedgers(), schedule, note: NOTE, voucher: { amount_cents: 23_737n, designation: "", received_on: D("2027-01-20") }, conduit_district: false, claim });
  assert.equal(nonConduit.designation_applied, "arrearage"); assert.equal(nonConduit.applied_arrearage_cents, 23_737n); assert.equal(nonConduit.decision.outcome, "unlabelled → arrearage first (non-conduit district)");
});
test("14.1-T9: Given direct-pay example B, when Jan 1 and Feb 1 2027 are unpaid on 2027-02-02, then `bankruptcy.postpetition.delinquency.60` fires, the MFR package is assembled the same day and the referral timer is due 2027-02-16; a referral on 2027-02-17 breaches with sev-1.", () => {
  const b: C.Ledgers = { prepetition_arrearage_cents: 1_424_194n, postpetition: [{ due: D("2026-10-01"), amount_cents: 269_922n, paid_cents: 0n }, { due: D("2026-11-01"), amount_cents: 280_672n, paid_cents: 0n }, { due: D("2026-12-01"), amount_cents: 280_672n, paid_cents: 0n }, { due: D("2027-01-01"), amount_cents: 280_672n, paid_cents: 0n }, { due: D("2027-02-01"), amount_cents: 280_672n, paid_cents: 0n }], postpetition_suspense_cents: 0n };
  applyDebtorPayment(b, 269_922n, D("2026-10-05")); applyDebtorPayment(b, 280_672n, D("2026-11-20")); applyDebtorPayment(b, 150_000n, D("2027-01-15")); applyDebtorPayment(b, 130_672n, D("2027-01-28"));
  const base = { loan_id: LOAN, ledgers: b, chapter: "13" as const, petition_on: PETITION, conduit_district: false, plan_confirmed: true, fnma_delinquency_days_at_filing: 130, firm_id: "firm-1" };
  assert.equal(mfrReferral({ ...base, today: D("2027-01-02") }).fired, false);   // Jan 1 alone, one day unpaid: no bucket
  const r = mfrReferral({ ...base, today: D("2027-02-02") });
  assert.equal(r.fired, true); assert.equal(r.event!.type, "bankruptcy.postpetition.delinquency.60"); assert.deepEqual(r.status.whole_unpaid, ["2027-01-01", "2027-02-01"]); assert.equal(r.status.fnma_bucket, 60); assert.equal(r.status.days_delinquent, 32); assert.equal(r.status.current, false);
  assert.equal(r.day_60, "2027-02-02"); assert.equal(r.referral_due, "2027-02-16"); assert.equal(r.timer, "FNMA_E2_1_08_POSTPETITION_60DPD_REFERRAL_14"); assert.equal(r.path, "mfr");
  assert.deepEqual([r.package!.template, r.package!.assembled_on, r.package!.same_day, r.package!.declaration_signer, r.package!.to, r.package!.fee_cents, r.package!.escalation.kind], ["CRT_MFR_DECL", "2027-02-02", true, "signing_officer", "attorney", 135_000n, "attorney"]);
  assert.ok(r.package!.contents.some((c) => /CRT_MFR_DECL/.test(c)) && r.package!.contents.includes("proof of claim")); assert.equal(r.trustee_status_confirm, null);   // direct-pay district: no trustee confirmation step
  assert.deepEqual(r.completion, { timer: "FNMA_E2_2_04_POSTCONF_COMPLETION_2M2W", anchor: "day_60", anchored_on: "2027-02-02", due: "2027-04-16", months: 2, days: 14 });   // E-2.2-04: two months and two weeks from day 60
  const reg = loadOverriddenRegistry(); const ev = asEvent(r.event!, 1);
  assert.equal(dueFromRegistry(reg.get("FNMA_E2_1_08_POSTPETITION_60DPD_REFERRAL_14")!, ev), "2027-02-16"); assert.equal(dueFromRegistry(reg.get("FNMA_E2_2_04_POSTCONF_COMPLETION_2M2W")!, ev), "2027-04-16");
  assert.equal(eventMatches(reg.get("FNMA_E2_2_04_TRUSTEE_STATUS_CONFIRM_5BD")!.triggerPattern!, ev), false, "a direct-pay district arms no trustee-confirmation clock");
  assert.ok(eventMatches(reg.get("FNMA_E2_2_04_POSTCONF_COMPLETION_2M2W")!.satisfiedPattern!, asEvent(reliefOrderGate({ entered_on: D("2027-04-06"), waived_stay: false, today: D("2027-04-06") }).emitted.find((e) => e.type === "bankruptcy.status.changed")!, 2)), "relief satisfies the post-confirmation completion clock");
  // a referral on 2027-02-17 breaches with sev-1; on 2027-02-16 it is in time and satisfies the clock
  const late = mfrReferral({ ...base, today: D("2027-02-02"), referral_sent_on: D("2027-02-17") });
  assert.equal(late.referral!.breached, true); assert.equal(late.referral!.in_time, false); assert.equal(late.referral!.escalation!.severity, "sev1"); assert.match(late.referral!.escalation!.reason, /E-2\.1-08.*two weeks from the 60th day/); assert.ok(eventMatches(reg.get("FNMA_E2_1_08_POSTPETITION_60DPD_REFERRAL_14")!.satisfiedPattern!, asEvent(late.referral!.event, 3)));
  const onTime = mfrReferral({ ...base, today: D("2027-02-02"), referral_sent_on: D("2027-02-16") }); assert.equal(onTime.referral!.in_time, true); assert.equal(onTime.referral!.escalation, null); assert.equal(onTime.referral!.event.payload.type, "mfr");
  assert.equal(mfrReferral({ ...base, today: D("2027-02-17") }).breached_unsent, true);
  // conduit district: confirm plan-payment status with the trustee within 5 BD before the referral (E-2.2-04)
  const conduit = mfrReferral({ ...base, conduit_district: true, today: D("2027-02-02") }); assert.deepEqual(conduit.trustee_status_confirm, { timer: "FNMA_E2_2_04_TRUSTEE_STATUS_CONFIRM_5BD", due: "2027-02-09", before_referral: true }); assert.equal(dueFromRegistry(reg.get("FNMA_E2_2_04_TRUSTEE_STATUS_CONFIRM_5BD")!, asEvent(conduit.event!, 4)), "2027-02-09");
  assert.equal(mfrReferral({ ...base, today: D("2027-02-02"), agreed_order_cure_months: 6, debtor_otherwise_performing: true }).path, "agreed_order");   // 14.1-Q7
  // rule 8 scores all five paths: motion to dismiss (counsel, local practice), adequate protection (conduit, confirmation > 45 days after the 341 meeting), sequestration of rents (investment property) — an agreed order (≤ 6 months, otherwise performing) outranks the MFR
  const score = (o: Partial<Parameters<typeof scoreMfrPath>[0]>) => scoreMfrPath({ chapter: "13", whole_unpaid: 2, conduit_district: false, plan_confirmed: true, agreed_order_cure_months: null, debtor_otherwise_performing: false, investment_property: false, investment_property_no_equity: false, soi_surrender: false, counsel_recommends_dismissal: false, meeting_341_on: null, today: D("2027-02-02"), ...o });
  assert.deepEqual([score({}).path, score({ counsel_recommends_dismissal: true }).path, score({ whole_unpaid: 0, conduit_district: true, plan_confirmed: false, meeting_341_on: D("2026-10-14") }).path, score({ whole_unpaid: 0, investment_property: true }).path, score({ agreed_order_cure_months: 4, debtor_otherwise_performing: true }).path], ["mfr", "motion_to_dismiss", "adequate_protection", "sequestration_of_rents", "agreed_order"]);
  assert.deepEqual(score({ investment_property: true, investment_property_no_equity: true }).companions, ["sequestration_of_rents"]); assert.equal(score({ agreed_order_cure_months: 9, debtor_otherwise_performing: true }).path, "mfr");   // a 9-month cure is the 12.x workout path, not an agreed order (14.1-Q7)
  assert.equal(score({ whole_unpaid: 0, conduit_district: true, plan_confirmed: false, meeting_341_on: D("2027-01-01") }).candidates.find((c) => c.path === "adequate_protection")!.applies, false);   // 32 days after the 341 meeting: not yet
});
test("14.1-T10: Given Chapter 7 example C, when $2,699.22 is received 2026-10-05, then it applies to the 2026-05-01 installment; after discharge 2026-12-15 the loan enters discharge-injunction mode and the 13.x breach letter uses the informational variant.", () => {
  const installments = ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"].map((d) => ({ due: D(d), amount_cents: 269_922n, paid_cents: 0n }));
  const pay = applyContractualFifo(installments, 269_922n); assert.deepEqual(pay.applied, [{ due: "2026-05-01", cents: 269_922n }]); assert.deepEqual(pay.remaining_unpaid, ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"]); assert.equal(pay.unapplied_cents, 0n);
  const d = dischargeMode({ chapter: "7", discharge_on: D("2026-12-15"), reaffirmed: false, fnma_delinquency_days: 130 });
  assert.equal(d.debt_discharged, true); assert.equal(d.mode, "discharge_injunction"); assert.equal(d.stay_status, "ended_discharge"); assert.equal(d.gates.collections_blocked, true); assert.equal(d.gates.foreclosure_blocked, false); assert.equal(d.contact_route, "informational_only");
  assert.equal(d.breach_letter_template, "NTC_BK_BREACH_INFORMATIONAL"); assert.equal(d.foreclosure, "in_rem_only"); assert.equal(d.personal_liability_demands, false); assert.equal(d.statement_mode, "informational_h30e"); assert.equal(d.credit_cii, "E"); assert.equal(d.referral_after_breach_allowed, true); assert.equal(d.fnma_status_code_while_open, "65");
  assert.equal(dischargeMode({ chapter: "7", discharge_on: D("2026-12-15"), reaffirmed: true, fnma_delinquency_days: 0 }).breach_letter_template, "standard"); assert.equal(dischargeMode({ chapter: "13", discharge_on: D("2031-07-01"), reaffirmed: false, cured_and_maintained: true, fnma_delinquency_days: 0 }).debt_discharged, false);
  // E-2.2-01: the Chapter 7 full referral (130 dpd at filing) runs the "two months and two weeks" completion clock from the filing → 2026-11-22; the discharge is the completion event
  const ch7 = loadOverriddenRegistry().get("FNMA_E2_2_01_CH7_COMPLETION_2M2W")!;
  const ref = referralPackage({ loan_id: LOAN, chapter: "7", petition_on: PETITION, sent_on: D("2026-09-10"), type: "full", firm_id: "firm-1", fnma_delinquency_days_at_filing: 130 });
  assert.deepEqual(ref.completion, { timer: "FNMA_E2_2_01_CH7_COMPLETION_2M2W", anchor: "petition_date", anchored_on: "2026-09-08", due: "2026-11-22", months: 2, days: 14 }); assert.equal(dueFromRegistry(ch7, asEvent(ref.event, 1)), "2026-11-22");
  assert.deepEqual(d.emitted.map((e) => [e.type, e.payload.to ?? e.payload.reason]), [["bankruptcy.case.discharged", undefined], ["bankruptcy.stay.terminated", "discharge"], ["bankruptcy.status.changed", "discharged"]]); assert.ok(eventMatches(ch7.satisfiedPattern!, asEvent(d.emitted[2]!, 2)), "the discharge satisfies the Chapter 7 completion clock");
  assert.equal(eventMatches(ch7.triggerPattern!, asEvent(referralPackage({ loan_id: LOAN, chapter: "7", petition_on: PETITION, sent_on: D("2026-09-10"), type: "poc_only", firm_id: "firm-1", fnma_delinquency_days_at_filing: 20 }).event, 3)), false, "a poc_only referral arms no completion clock");
  assert.equal(referralPackage({ loan_id: LOAN, chapter: "7", petition_on: PETITION, sent_on: D("2026-10-27"), type: "full", firm_id: "firm-1", fnma_delinquency_days_at_filing: 20, day_60_on: D("2026-10-19") }).completion.due, "2027-01-02");   // <60 dpd at filing: from the 60th day of delinquency
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_BK_BREACH_INFORMATIONAL", D("2026-12-22"))!; const out = render(v.source, v.samplePayload);
  assert.match(out.text, /not an attempt to collect a debt from you personally/); assert.match(out.text, /discharged in bankruptcy on December 15, 2026/); assert.match(out.text, /against the property only \(in rem\)/); assert.doesNotMatch(out.text, /you must pay|you owe/i);
  assert.equal(evaluateChecklist(v, v.samplePayload, out).passed, true); assert.equal(reg.template("NTC_BK_BREACH_INFORMATIONAL").channelPolicy, "mail_only");
  const shortCure = { ...v.samplePayload, cure_days: 10 }; assert.equal(evaluateChecklist(v, shortCure, render(v.source, shortCure)).passed, false);
  // `notice.send` recomputes `cure_days` from the dates the letter states (breachLetterPayload): a payload claiming 30 days with a cure date five days out fails the cure-period rule
  const reconciled = breachLetterPayload({ ...v.samplePayload, notice_date: "2026-12-22", cure_by: "2026-12-27", cure_days: 30 }); assert.equal(reconciled.cure_days, 5); assert.equal(evaluateChecklist(v, reconciled, render(v.source, reconciled)).passed, false);
  assert.equal(breachLetterPayload({ ...v.samplePayload, notice_date: "2026-12-22", cure_by: "2027-01-21", cure_days: 1 }).cure_days, 30);
});
test("14.1-T11: Given one prior case dismissed 2026-03-01, then `serial_filer_class=one_prior_dismissed_1y`, the referral is marked \"repeat filer\", and on 2026-10-09 (day 31) with no extension order the stay status becomes `terminated_362c3` only after counsel's written confirmation.", () => {
  const prior: PriorCase[] = [{ case_number_full: "4:25-bk-20001", chapter: "13", filed_on: D("2025-11-03"), disposition: "dismissed", disposed_on: D("2026-03-01") }];
  const base = { loan_id: LOAN, petition_on: PETITION, chapter: "13" as const, prior_cases: prior };
  const early = serialFilerStay({ ...base, today: D("2026-09-22") });
  assert.equal(early.serial_filer_class, "one_prior_dismissed_1y"); assert.deepEqual(early.prior_dismissed_within_1y.map((p) => p.case_number_full), ["4:25-bk-20001"]); assert.equal(early.checked.type, "bankruptcy.prior_filings.checked"); assert.equal(early.checked.payload.serial_filer_class, "one_prior_dismissed_1y");
  assert.deepEqual([early.referral!.type, early.referral!.label, early.referral!.immediate, early.referral!.due], ["repeat_filer", "repeat filer", true, "2026-09-08"]); assert.ok(early.referral!.requests.some((q) => /§362\(d\)\(4\)/.test(q)));
  assert.deepEqual([early.stay.status, early.stay.day_30, early.stay.day_31, early.stay.awaiting_counsel_confirmation], ["in_effect", "2026-10-08", "2026-10-09", false]); assert.deepEqual(early.timer, { code: "USC_362C3_SERIAL_STAY_30", due: "2026-10-08", satisfied: false }); assert.equal(early.gates.foreclosure_blocked, true);
  // day 31, no extension order, no confirmation yet: the platform keeps every gate on and asks counsel for written confirmation
  const day31 = serialFilerStay({ ...base, today: D("2026-10-09") });
  assert.equal(day31.stay.status, "in_effect"); assert.equal(day31.stay.awaiting_counsel_confirmation, true); assert.equal(day31.stay.terminated_on, null); assert.match(day31.stay.basis, /operation of law.*counsel's written confirmation/); assert.deepEqual([day31.gates.foreclosure_blocked, day31.gates.collections_blocked, day31.gates.contact_route], [true, true, "counsel_only"]);
  assert.deepEqual([day31.escalation!.kind, day31.escalation!.severity], ["attorney", "sev2"]); assert.equal(day31.events.some((e) => e.type === "bankruptcy.stay.terminated"), false);
  // counsel confirms in writing → terminated_362c3, gates released, the spec's events plus the one resolution event the registry row is satisfied by
  const confirmed = serialFilerStay({ ...base, today: D("2026-10-12"), counsel_written_confirmation_on: D("2026-10-09"), counsel_confirmation_document_id: "doc-counsel-1" });
  assert.deepEqual([confirmed.stay.status, confirmed.stay.terminated_on, confirmed.stay.confirmed_on, confirmed.stay.awaiting_counsel_confirmation], ["terminated_362c3", "2026-10-09", "2026-10-09", false]); assert.deepEqual([confirmed.gates.foreclosure_blocked, confirmed.gates.collections_blocked], [false, false]); assert.equal(confirmed.timer!.satisfied, true); assert.equal(confirmed.escalation, null);
  assert.deepEqual(confirmed.events.map((e) => e.type), ["bankruptcy.prior_filings.checked", "bankruptcy.stay.terminated", "bankruptcy.stay.serial_30.resolved", "bankruptcy.status.changed"]); assert.equal(confirmed.events[1]!.payload.reason, "362c3"); assert.equal(confirmed.events[1]!.payload.terminated_on, "2026-10-09"); assert.equal(confirmed.events[3]!.payload.to, "stay_terminated");
  const reg = loadOverriddenRegistry(); const c3 = reg.get("USC_362C3_SERIAL_STAY_30")!;
  const v = verifyNotice({ notice_id: "ebn-1", loan_id: LOAN, borrower: BORROWER, hits: [HIT], verified_at: "2026-09-09T11:00:00-04:00", prior_cases: prior, fnma_delinquency_days_at_filing: 130 });
  assert.equal(v.serial_filer_class, "one_prior_dismissed_1y"); assert.equal(v.referral, "repeat_filer"); assert.equal(dueFromRegistry(c3, asEvent(v.event, 1)), "2026-10-08"); assert.ok(eventMatches(c3.satisfiedPattern!, asEvent(confirmed.events[2]!, 2)));
  assert.equal(eventMatches(c3.triggerPattern!, asEvent(verifyNotice({ notice_id: "ebn-1", loan_id: LOAN, borrower: BORROWER, hits: [HIT], verified_at: "2026-09-09T11:00:00-04:00" }).event, 3)), false, "an ordinary filer never arms the 30-day clock");
  // an extension order entered before day 30 keeps the stay (§362(c)(3)(B)) and satisfies the clock
  const extended = serialFilerStay({ ...base, today: D("2026-10-12"), extension_order_on: D("2026-10-06") }); assert.equal(extended.stay.status, "in_effect"); assert.equal(extended.timer!.satisfied, true); assert.ok(eventMatches(c3.satisfiedPattern!, asEvent(extended.events.find((e) => e.type === "bankruptcy.stay.serial_30.resolved")!, 4))); assert.ok(extended.events.some((e) => e.type === "bankruptcy.stay.extended"));
  // the referral package is marked "repeat filer" and carries the E-2.2-04 completion date (five months + two weeks from the filing: ≥60 dpd)
  const ref = referralPackage({ loan_id: LOAN, chapter: "13", petition_on: PETITION, sent_on: D("2026-09-09"), type: "repeat_filer", firm_id: "firm-1", fnma_delinquency_days_at_filing: 130, serial_filer_class: "one_prior_dismissed_1y" });
  assert.equal(ref.label, "repeat filer"); assert.equal(ref.event.payload.label, "repeat filer"); assert.equal(ref.full, true); assert.equal(ref.in_time, true); assert.equal(ref.ack_due, "2026-09-11"); assert.deepEqual(ref.completion, { timer: "FNMA_E2_2_04_CH13_COMPLETION_5M2W", anchor: "petition_date", anchored_on: "2026-09-08", due: "2027-02-22", months: 5, days: 14 });
  assert.equal(dueFromRegistry(reg.get("FNMA_E2_2_04_CH13_COMPLETION_5M2W")!, asEvent(ref.event, 5)), "2027-02-22"); assert.equal(dueFromRegistry(reg.get("FNMA_E2_1_04_LAWFIRM_ACK_2BD")!, asEvent(ref.event, 6)), "2026-09-11");
  assert.ok(eventMatches(reg.get("FNMA_E2_2_04_CH13_COMPLETION_5M2W")!.satisfiedPattern!, asEvent({ ...dismissalReversion({ dismissed_on: D("2027-06-05"), cured_cents: 0n, prepetition_installments: [], suspended_late_charges_cents: 0n }).events.find((e) => e.type === "bankruptcy.status.changed")!, occurred_at: "2027-06-05T12:00:00.000Z" }, 7)));
  assert.equal(completionClock({ chapter: "13", petition_on: PETITION, fnma_delinquency_days_at_filing: 20, open_foreclosure: false, day_60_on: D("2026-10-19") }).due, "2027-04-02");   // <60 dpd at filing: from day 60
  // two or more prior dismissals: no stay (§362(c)(4)); foreclosure stays blocked until counsel's written confirmation, due 5 BD
  const two = serialFilerStay({ ...base, prior_cases: [...prior, { case_number_full: "4:25-bk-10001", chapter: "13", filed_on: D("2025-08-01"), disposition: "dismissed", disposed_on: D("2025-10-15") }], today: D("2026-09-10") });
  assert.equal(two.serial_filer_class, "two_plus_prior_dismissed_1y"); assert.equal(two.stay.status, "not_in_effect_362c4"); assert.equal(two.gates.foreclosure_blocked, true); assert.deepEqual(two.timer, { code: "USC_362C4_NO_STAY_CONFIRM_5BD", due: "2026-09-15", satisfied: false });
  const twoConfirmed = serialFilerStay({ ...base, prior_cases: two.prior_dismissed_within_1y, today: D("2026-09-14"), counsel_written_confirmation_on: D("2026-09-14") }); assert.equal(twoConfirmed.gates.foreclosure_blocked, false); assert.ok(eventMatches(reg.get("USC_362C4_NO_STAY_CONFIRM_5BD")!.satisfiedPattern!, asEvent(twoConfirmed.events.find((e) => e.type === "attorney.confirmation")!, 8)));
});
test("14.1-T12: Given a plan proposing an arrearage of $9,800.00 and a 6-year cure, then an objection package is produced (variance > $50; cure > 60 months) before the docketed objection deadline.", () => {
  const plan = { arrearage_proposed_cents: 980_000n, cure_months: 72, plan_length_months: 60, arrearage_interest_rate_pct: null, treatment: "cure_and_maintain" as const, modifies: [], attorney_fees_included: true };
  const r = planReview({ plan, claim_arrearage_cents: 1_424_194n, note_interest_on_arrears: false, principal_residence: true, conduit_district: true, objection_deadline: D("2026-12-03"), today: D("2026-11-05") });
  assert.equal(r.objection, true); assert.equal(r.variance_cents, 444_194n); assert.equal(r.tolerance_cents, 7_121n); assert.equal(arrearageTolerance(100_000n), 5_000n); assert.ok(r.variance_cents > 5_000n);
  // rule 7 "tolerance $50 or 0.5%" is read as the larger of the two (a $50 floor so a small claim is not litigated over rounding; 0.5% = $71.21 on the $14,241.94 claim): a $60.00 variance draws no objection on this claim, $72.00 does
  const within = (v: bigint) => planReview({ plan: { ...plan, arrearage_proposed_cents: 1_424_194n - v, cure_months: 60 }, claim_arrearage_cents: 1_424_194n, note_interest_on_arrears: false, principal_residence: true, conduit_district: true, objection_deadline: D("2026-12-03"), today: D("2026-11-05") }).objection;
  assert.equal(within(6_000n), false); assert.equal(within(7_200n), true); assert.equal(arrearageTolerance(1_424_194n), 7_121n);
  assert.equal(r.grounds.length, 2); assert.match(r.grounds[0]!, /arrearage variance 444194 cents exceeds tolerance 7121/); assert.match(r.grounds[1]!, /cure period 72 months exceeds 60 months/);
  assert.equal(r.package!.template, "CRT_OBJ_CONFIRMATION"); assert.equal(r.package!.fee_cents, 70_000n); assert.equal(r.package!.escalation.kind, "attorney"); assert.equal(r.package!.due_before, "2026-12-03"); assert.equal(r.package!.produced_on, "2026-11-05"); assert.equal(r.package!.in_time, true); assert.equal(r.package!.warn_at, "2026-11-24"); assert.equal(r.package!.timer, "SM_BK_PLAN_OBJECTION_DEADLINE");
  assert.equal(r.decision.decision_type, "objection"); assert.equal(r.decision.outcome, "object");
  const fine = planReview({ plan: { ...plan, arrearage_proposed_cents: 1_420_000n, cure_months: 60 }, claim_arrearage_cents: 1_424_194n, note_interest_on_arrears: false, principal_residence: true, conduit_district: true, objection_deadline: D("2026-12-03"), today: D("2026-11-05") });
  assert.equal(fine.objection, false); assert.equal(fine.package, null); assert.equal(fine.decision.outcome, "no_objection"); assert.match(fine.decision.rationale, /§1327/);
  // an investment-property plan that both bifurcates (cramdown path, rule 9) and misstates the arrearage still draws the objection
  const both = planReview({ plan: { ...plan, cure_months: 60, treatment: "cramdown", modifies: ["principal"] }, claim_arrearage_cents: 1_424_194n, note_interest_on_arrears: false, principal_residence: false, conduit_district: true, objection_deadline: D("2026-12-03"), today: D("2026-11-05") });
  assert.equal(both.cramdown_path, true); assert.equal(both.objection, true); assert.equal(both.package!.template, "CRT_OBJ_CONFIRMATION"); assert.equal(both.decision.outcome, "object_and_cramdown_path");
});
test("14.1-T13: Given a plan that bifurcates a $325,000 claim on an investment property, then `bankruptcy.cramdown.requested` fires, the Form 20 package is ready within 1 BD, no Form 3179 is created, and the SMDU reporting task is created only after confirmation.", () => {
  const r = cramdownRequest({ claim_cents: 32_500_000n, secured_value_cents: 26_000_000n, bifurcates: true, modifies: ["principal"], principal_residence: false, requested_on: D("2026-11-12"), recourse_or_indemnification: false });
  assert.equal(r.cramdown, true); assert.equal(r.event, "bankruptcy.cramdown.requested"); assert.equal(r.form20!.due, "2026-11-13"); assert.equal(r.form20!.status, "package_ready"); assert.equal(r.form20!.timer, "FNMA_E2_3_03_FORM20_IMMEDIATE_1BD"); assert.equal(r.form20!.review, "attorney"); assert.equal(r.form20!.submits, "officer");
  assert.equal(r.form_3179_created, false); assert.equal(r.note_modified, false); assert.equal(r.late_charges_capitalized, false); assert.equal(r.smdu_task, null); assert.equal(r.bk_unsecured_cramdown_opened, false); assert.equal(r.secured_cents, 26_000_000n); assert.equal(r.unsecured_cents, 6_500_000n);
  assert.deepEqual(r.escalations.map((e) => e.kind), ["attorney", "officer"]);
  // the registry's Form 20 clock is armed by the cramdown request and by a verified Chapter 11 petition alike (E-2.3-03; E-2.2-02)
  const reg = loadOverriddenRegistry(); const f20 = reg.get("FNMA_E2_3_03_FORM20_IMMEDIATE_1BD")!;
  assert.deepEqual(r.emitted.map((e) => e.type), ["bankruptcy.cramdown.requested", "bankruptcy.form20.required"]); assert.equal(dueFromRegistry(f20, asEvent(r.emitted[1]!, 1)), "2026-11-13");
  const ch11 = verifyNotice({ notice_id: "ebn-1", loan_id: LOAN, borrower: BORROWER, hits: [{ ...HIT, chapter: "11" }], verified_at: "2026-09-09T11:00:00-04:00" }); assert.equal(ch11.referral, "ch11"); assert.equal(dueFromRegistry(f20, asEvent(ch11.events.find((e) => e.type === "bankruptcy.form20.required")!, 2)), "2026-09-10");
  const confirmed = cramdownRequest({ claim_cents: 32_500_000n, secured_value_cents: 26_000_000n, bifurcates: true, modifies: ["principal"], principal_residence: false, requested_on: D("2026-11-12"), recourse_or_indemnification: true, confirmed_on: D("2027-01-14") });
  assert.deepEqual(confirmed.smdu_task, { kind: "human_portal_task", owner_role: "fnma_portal_operator", plan_terms_view: "pending_fnma_booking", created_on: "2027-01-14" }); assert.equal(confirmed.repurchase.required_before_implementation, true); assert.equal(confirmed.repurchase.decided_by, "officer"); assert.equal(confirmed.bk_unsecured_cramdown_opened, true); assert.equal(confirmed.form_3179_created, false);
  assert.equal(cramdownRequest({ claim_cents: 32_500_000n, bifurcates: true, modifies: ["principal"], principal_residence: true, requested_on: D("2026-11-12"), recourse_or_indemnification: false }).cramdown, false);   // principal residence → §1322(b)(2) objection path, not a cramdown
});
test("14.1-T14: Given a relief order entered 2027-04-20, then `foreclosure_blocked` remains true until 2027-05-04 and `assertGateOpen` blocks a referral on 2027-05-01.", () => {
  const on = (d: string) => reliefOrderGate({ entered_on: D("2027-04-20"), waived_stay: false, today: D(d) });
  assert.equal(on("2027-04-20").stayed_through, "2027-05-04"); assert.equal(on("2027-04-20").opens_on, "2027-05-05"); assert.equal(on("2027-05-01").foreclosure_blocked, true); assert.equal(on("2027-05-04").foreclosure_blocked, true); assert.equal(on("2027-05-05").foreclosure_blocked, false); assert.equal(on("2027-05-01").collections_blocked, true); assert.equal(on("2027-05-01").stay_status, "relief_granted");
  assert.throws(() => assertGateOpen({ action: "foreclosure.refer", entered_on: D("2027-04-20"), waived_stay: false, today: D("2027-05-01") }), (e: unknown) => e instanceof GateClosed && e.gate === "FRBP_4001A3_ORDER_STAY_14" && e.action === "foreclosure.refer" && e.opens_on === "2027-05-05" && /stayed through 2027-05-04/.test(e.message));
  assert.equal(assertGateOpen({ action: "foreclosure.refer", entered_on: D("2027-04-20"), waived_stay: false, today: D("2027-05-05") }).allowed, true);
  assert.equal(assertGateOpen({ action: "foreclosure.refer", entered_on: D("2027-04-20"), waived_stay: true, today: D("2027-04-21") }).allowed, true);   // the order waived the 14-day stay
  const ev = EVALUATORS_14_1["14.1.reliefOrderStayLapsed"]!; assert.equal(ev({ relief_order_entered_on: "2027-04-20", today: "2027-05-01" }).open, false); assert.match(ev({ relief_order_entered_on: "2027-04-20", today: "2027-05-01" }).reason!, /4001\(a\)\(3\)/); assert.equal(ev({ relief_order_entered_on: "2027-04-20", today: "2027-05-05" }).open, true); assert.equal(ev({}).open, false);
  const def = loadOverriddenRegistry().get("FRBP_4001A3_ORDER_STAY_14")!; assert.equal(def.offset, "evaluator:14.1.reliefOrderStayLapsed");
  // the daily stay-gate recomputation emits the expiry once the stay has run — the event the gate is satisfied by; before expiry nothing is emitted
  assert.equal(on("2027-05-01").emitted.some((e) => e.type === "bankruptcy.stay.relief_effective"), false);
  const effective = on("2027-05-05").emitted.find((e) => e.type === "bankruptcy.stay.relief_effective")!; assert.equal(effective.payload.opened_on, "2027-05-05"); assert.ok(eventMatches(def.satisfiedPattern!, asEvent(effective, 1)));
  assert.equal(C.stayGates("relief_granted", false, false).foreclosure_blocked, true); assert.equal(C.stayGates("relief_granted", false, true).foreclosure_blocked, false);
});
test("14.1-T15: Given a foreclosure sale held 2027-03-03 and a petition dated 2027-03-02 discovered 2027-03-10, then the Bankruptcy Notification Template is sent by 2027-03-12 and counsel is engaged the same day.", () => {
  const r = postSaleIdentified({ sale_held_on: D("2027-03-03"), petition_on: D("2027-03-02"), learned_on: D("2027-03-10") });
  assert.equal(r.post_sale, true); assert.equal(r.event, "bankruptcy.post_sale.identified"); assert.equal(r.template!.due, "2027-03-12"); assert.equal(r.template!.name, "Bankruptcy Notification Template"); assert.equal(r.template!.to, "SF CPM"); assert.equal(r.template!.timer, "FNMA_E2_3_06_POST_SALE_NOTIFY_2BD"); assert.equal(r.template!.includes_reogram_status, true);
  assert.equal(r.counsel!.engaged_on, "2027-03-10"); assert.equal(r.counsel!.escalation.kind, "attorney"); assert.equal(r.counsel!.escalation.severity, "sev1"); assert.match(r.counsel!.escalation.reason, /petition 2027-03-02 predates the foreclosure sale held 2027-03-03.*void as a stay violation/);
  assert.equal(r.gates.foreclosure_blocked, true); assert.equal(r.gates.collections_blocked, true); assert.equal(r.eviction_reo_frozen, true); assert.equal(r.reogram_p360_update, "per_fnma_direction_15_1"); assert.equal(r.sale_validity, "attorney_review_possible_stay_violation");
  const after = postSaleIdentified({ sale_held_on: D("2027-03-03"), petition_on: D("2027-03-04"), learned_on: D("2027-03-10") }); assert.equal(after.post_sale, false); assert.equal(after.event, null); assert.equal(after.counsel, null);
});
test("14.1-T16: Given the case is dismissed 2027-06-05 with $9,500.00 of arrearage cured through the trustee, then the contract-terms view shows the cured amounts applied FIFO to May–Aug 2026, suspended late charges are waived, and 13.x receives `bankruptcy.case.dismissed`.", () => {
  const inst = ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"].map((d) => ({ due: D(d), pi_cents: 205_422n, escrow_cents: 64_500n }));
  const r = dismissalReversion({ dismissed_on: D("2027-06-05"), cured_cents: 950_000n, prepetition_installments: inst, suspended_late_charges_cents: 41_084n });
  assert.deepEqual(r.cured_installments, ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"]); assert.deepEqual(r.partially_cured, { due: "2026-09-01", cured_cents: 128_312n, remaining_cents: 77_110n }); assert.equal(r.residual_unapplied_cents, 0n);
  assert.deepEqual(r.contract_terms_view.map((v) => [v.due, v.status, v.cured_cents]), [["2026-05-01", "cured", 205_422n], ["2026-06-01", "cured", 205_422n], ["2026-07-01", "cured", 205_422n], ["2026-08-01", "cured", 205_422n], ["2026-09-01", "partially_cured", 128_312n]]); assert.equal(r.ledger_of_record, "contract_terms");
  assert.deepEqual(r.late_charges, { suspended_cents: 41_084n, waived_cents: 41_084n, decision: "waived_default", rule: "2.7" });
  const dismissed = r.events.find((e) => e.type === "bankruptcy.case.dismissed")!; assert.ok(dismissed.consumers.includes("13.x")); assert.equal(dismissed.payload.cured_cents, 950_000n); assert.deepEqual(r.foreclosure, { resumes: true, requires_breach_letter: true, guide: "E-2.2-01/-04" });
  assert.equal(r.stay_status, "ended_dismissal"); assert.deepEqual([r.gates.collections_blocked, r.gates.foreclosure_blocked, r.gates.late_charges_blocked], [false, false, false]); assert.equal(r.serial_filer_precompute.counts_toward_362c3_until, "2028-06-05");
  assert.equal(dismissalReversion({ dismissed_on: D("2027-06-05"), cured_cents: 950_000n, prepetition_installments: inst, suspended_late_charges_cents: 41_084n, counsel_confirmed_stay_ended: false }).gates.foreclosure_blocked, true);
  // the phase change 14.1 emits with the dismissal is the completion event the Fannie Mae timelines are satisfied by (E-2.2-01 / E-2.2-04)
  const reg = loadOverriddenRegistry(); const phase = asEvent({ ...r.events.find((e) => e.type === "bankruptcy.status.changed")!, occurred_at: "2027-06-05T12:00:00.000Z" }, 1); assert.equal(phase.type, "bankruptcy.status.changed"); assert.equal(phase.payload.to, "dismissed");
  for (const code of ["FNMA_E2_2_01_CH7_COMPLETION_2M2W", "FNMA_E2_2_04_CH13_COMPLETION_5M2W", "FNMA_E2_2_04_POSTCONF_COMPLETION_2M2W"]) assert.ok(eventMatches(reg.get(code)!.satisfiedPattern!, phase), `${code} satisfied by the dismissal`);
  // "13.x receives `bankruptcy.case.dismissed`": on the bus the dismissal is appended to the shared event store and the consumers read it from there — 13.1's stay-end ingestion opens the BK_362_STAY_GATE on the `bankruptcy.stay.terminated{reason=dismissal}` 14.1 appends with it, and 14.4 maps the dismissal to the `dismissed` reporting phase
  return (async () => {
    const b = bus("2027-06-05T16:00:00.000Z");
    const dismiss = { op: "dismiss", loan_id: LOAN, case_number_full: "4:26-bk-31234", dismissed_on: "2027-06-05", cured_cents: 950_000n, prepetition_installments: inst.map((x) => ({ due: x.due, pi_cents: x.pi_cents, escrow_cents: x.escrow_cents })), suspended_late_charges_cents: 41_084n, docket_order_document_id: "doc-dismissal-order-1" };
    await b.refused("bk.case.read/write", dismiss, "DISMISSAL_DISCHARGE_RELIEF_HUMAN_VERIFIED");   // guardrail: a dismissal is always human-verified by counsel or human_agent against the PDF — the agent alone cannot close the case
    const out = await b.run<ReturnType<typeof dismissalReversion>>("bk.case.read/write", dismiss, { actor: ATTORNEY });
    assert.deepEqual(out.cured_installments, r.cured_installments); assert.equal(out.late_charges.waived_cents, 41_084n);
    const stored = b.events.all().filter((e) => e.loanId === LOAN); const dismissedEv = stored.find((e) => e.type === "bankruptcy.case.dismissed")!; const stayEnded = stored.find((e) => e.type === "bankruptcy.stay.terminated")!;
    assert.deepEqual([dismissedEv.payload.dismissed_on, dismissedEv.payload.cured_cents, dismissedEv.payload.case_number_full, stayEnded.payload.reason], ["2027-06-05", 950_000n, "4:26-bk-31234", "dismissal"]);
    assert.equal(b.rt.store.get("bankruptcy_cases", "bkcase-BK-13-A")!.data.status, "dismissed"); assert.equal(b.rt.store.get("stay_gates", LOAN)!.data.foreclosure_blocked, false); assert.ok(b.decisions.some((d) => d.action === "dismissal_close"));
    const received = bankruptcyStayEnded({ events: b.events, store: b.rt.store }, { loan_id: LOAN, event: stayEnded, actor: BK_OPS, now: b.clock.now() });
    assert.deepEqual([received.opened, received.reason, received.refusal], [true, "dismissal", null]); const opened = b.events.all().find((e) => e.id === received.event_id)!; assert.equal(opened.type, "foreclosure.gate.opened"); assert.equal(opened.payload.code, "BK_362_STAY_GATE"); assert.equal(opened.causationId, stayEnded.id);
    assert.equal(phaseForEvent({ event: "bankruptcy.case.dismissed", prior_phase: "confirmed" }), "dismissed"); assert.equal(phaseForEvent({ event: "bankruptcy.case.dismissed", prior_phase: "confirmed", debtor_motion: true }), "withdrawn");   // 14.4 maps the received dismissal to its reporting phase (14.4-Q3), from which its own credit-freeze release row arms
  })();
});
test("14.1-T17: Given a counsel document request at 15:00 Friday 2026-10-16, then the fulfilment deadline is Wednesday 2026-10-21 (3 servicer business days).", () => {
  const r = documentRequestDue({ requested_at: "2026-10-16T15:00:00-04:00" });
  assert.equal(r.requested_on, "2026-10-16"); assert.equal(r.requested_weekday, 5); assert.equal(r.due, "2026-10-21"); assert.equal(dayOfWeek(r.due), 3); assert.equal(r.business_days, 3); assert.equal(r.calendar, "business_days_servicer"); assert.equal(r.timer, "FNMA_E2_1_04_DOCS_TO_FIRM_3BD"); assert.equal(r.breached, false); assert.equal(r.escalation, null);
  const late = documentRequestDue({ requested_at: "2026-10-16T15:00:00-04:00", fulfilled_on: null, today: D("2026-10-22") }); assert.equal(late.breached, true); assert.equal(late.escalation!.severity, "sev2"); assert.match(late.escalation!.reason, /E-2\.1-04/);
  assert.equal(documentRequestDue({ requested_at: "2026-10-16T15:00:00-04:00", fulfilled_on: D("2026-10-20"), today: D("2026-10-22") }).breached, false);
  assert.equal(documentRequestDue({ requested_at: "2026-10-09T15:00:00-04:00" }).due, "2026-10-15");   // Columbus Day 2026-10-12 is not a servicer business day
});
test("14.1-T18: Given an MFR relief order on 2027-04-20, then the expense claim is due by 2027-06-19 and the invoice lines match $1,350 (MFR), $1,225 (POC & plan review), $325 (410A).", () => {
  const r = expenseClaim({ milestone: "relief_granted", milestone_on: D("2027-04-20"), chapter: "13", lines: [{ kind: "mfr", invoiced_cents: 135_000n }, { kind: "poc_plan_review", invoiced_cents: 122_500n }, { kind: "form_410a", invoiced_cents: 32_500n }] });
  assert.equal(r.due, "2027-06-19"); assert.equal(r.timer, "FNMA_E5_01_BK_EXPENSE_CLAIM_60"); assert.equal(r.channel, "p360"); assert.equal(r.all_match, true); assert.equal(r.claim_cents, 290_000n); assert.equal(r.excess_requires_approval, false); assert.equal(r.fee_schedule, "fnma.bk_fees.2025-11-12");
  assert.deepEqual(r.lines.map((l) => [l.kind, l.allowable_cents, l.matches, l.excess_cents]), [["mfr", 135_000n, true, 0n], ["poc_plan_review", 122_500n, true, 0n], ["form_410a", 32_500n, true, 0n]]);
  assert.equal(allowableBkFee("7", "mfr"), 122_500n); assert.equal(allowableBkFee("7", "poc_plan_review"), null); assert.equal(allowableBkFee("13", "objection_to_plan"), 70_000n); assert.equal(allowableBkFee("13", "payment_change_notice"), 17_500n); assert.equal(allowableBkFee("7", "reaffirmation"), 32_500n); assert.equal(allowableBkFee("13", "noa"), 0n);
  const over = expenseClaim({ milestone: "relief_granted", milestone_on: D("2027-04-20"), chapter: "13", lines: [{ kind: "mfr", invoiced_cents: 150_000n }] }); assert.equal(over.lines[0]!.excess_cents, 15_000n); assert.equal(over.excess_requires_approval, true); assert.equal(over.claim_cents, 135_000n); assert.equal(over.all_match, false);
});

test("14.1 worked figures: fixture BK-13-A $325,000.00 at 6.500% → P&I $2,054.22, late charge $102.71, escrow $645.00; UPB after payment 33 $314,415.22; Part 3 $1,774.81 + $8,496.29 + $450.84 ($410.84 + 2 × $20.00 = $40.00) + $3,920.00 ($1,120.00 − $2,340.00 − $2,700.00) − $400.00 = $14,241.94; Part 2 $326,882.35; Part 4 $2,699.22; cure $237.37 (residual $0.26); example A $752.50 → $2,806.72, vouchers $5,398.44 / $3,151.59 → $107.50 short then $14,004.57; example B $1,500.00 suspense", () => {
  assert.equal(levelPayment(32_500_000n, ratePercent("6.500"), 360), 205_422n);
  assert.equal(lateChargeAmount(205_422n, "5", null), 10_271n);
  const upb33 = balanceAfter(32_500_000n, "6.500", 360, 33); assert.equal(upb33, 31_441_522n);
  const unpaid = C.unpaidSplits(upb33, "6.500", 205_422n, D("2026-05-01"), PETITION, 10_271n, 15);
  assert.deepEqual(unpaid.map((u) => [u.due, u.interest_cents, u.principal_cents]), [["2026-05-01", 170_308n, 35_114n], ["2026-06-01", 170_118n, 35_304n], ["2026-07-01", 169_927n, 35_495n], ["2026-08-01", 169_735n, 35_687n], ["2026-09-01", 169_541n, 35_881n]]);
  assert.equal(monthlyInterest(upb33, ratePercent("6.500")), 170_308n);
  const lateCharges = unpaid.reduce((s, u) => s + u.late_charge_cents, 0n); assert.equal(lateCharges, 41_084n); assert.equal(lateCharges, 4n * 10_271n);
  // pre-petition fee items (property inspections 07-05 and 08-05 at $20.00) and the petition-date escrow statement ($1,120.00 on 04-30, hazard $2,340.00 on 06-15, taxes $2,700.00 on 08-20)
  const fees = prepetitionFees({ items: [{ kind: "inspection", on: D("2026-07-05"), cents: 2_000n }, { kind: "inspection", on: D("2026-08-05"), cents: 2_000n }, { kind: "inspection", on: D("2026-09-09"), cents: 2_000n }], petition_on: PETITION }); assert.equal(fees.total_cents, 4_000n); assert.equal(fees.items.length, 2);
  const escrow = petitionEscrowStatement({ opening_balance_cents: 112_000n, opening_on: D("2026-04-30"), petition_on: PETITION, disbursements: [{ on: D("2026-06-15"), kind: "hazard premium", cents: 234_000n }, { on: D("2026-08-20"), kind: "taxes", cents: 270_000n }] });
  assert.equal(escrow.balance_at_petition_cents, -392_000n); assert.equal(escrow.escrow_deficiency_for_funds_advanced_cents, 392_000n);
  const poc = C.proofOfClaim({ ib_upb_cents: upb33, nib_cents: 0n, unpaid, other_prepetition_fees_cents: fees.total_cents, escrow_balance_at_petition_cents: escrow.balance_at_petition_cents, funds_on_hand_cents: 40_000n, pi_cents: 205_422n, escrow_monthly_cents: 64_500n });
  assert.deepEqual(poc.part3, { principal_due_cents: 177_481n, interest_due_cents: 849_629n, prepetition_fees_due_cents: 45_084n, escrow_deficiency_cents: 392_000n, funds_on_hand_cents: 40_000n, total_prepetition_arrearage_cents: 1_424_194n });
  assert.equal(poc.part3.prepetition_fees_due_cents, lateCharges + fees.total_cents); assert.equal(poc.part3.principal_due_cents + poc.part3.interest_due_cents, 5n * 205_422n); assert.equal(poc.part2_total_debt_cents, 32_688_235n); assert.equal(poc.part4_monthly_cents, 269_922n); assert.equal(poc.part5_starts, "2026-05-01");
  const cure = C.planCureInstallment(1_424_194n, 60); assert.equal(cure.installment_cents, 23_737n); assert.equal(cure.installment_cents * 60n - 1_424_194n, 26n); assert.equal(cure.last_installment_cents, 23_737n - 26n);
  // worked example A (conduit): the post-petition escrow analysis (14.2 example: $1,290.00 shortage ÷ 12) raises escrow to $752.50 from 2026-11-01 → installments $2,699.22 then $2,806.72
  const change = postpetitionEscrowChange({ pi_cents: 205_422n, escrow_old_cents: 64_500n, shortage_cents: 129_000n, effective_due_date: D("2026-11-01") }); assert.equal(change.escrow_new_cents, 75_250n); assert.equal(change.new_total_cents, 280_672n);
  const schedule = postpetitionSchedule({ first_postpetition_due: D("2026-10-01"), first_postpetition_payment_number: 39, months: 3, pi_cents: 205_422n, escrow_cents: 64_500n, escrow_change: { escrow_new_cents: change.escrow_new_cents, effective_due_date: D("2026-11-01") } });
  assert.deepEqual(schedule.map((s) => s.amount_cents), [269_922n, 280_672n, 280_672n]); assert.deepEqual([scheduledSplit(NOTE, 39).interest_cents, scheduledSplit(NOTE, 39).principal_cents, scheduledSplit(NOTE, 41).interest_cents, scheduledSplit(NOTE, 41).principal_cents], [169_347n, 36_075n, 168_955n, 36_467n]);
  const a = exampleALedgers();
  const v1 = C.applyVoucher(a, { amount_cents: 539_844n, designation: "post-petition", conduit_district: true }); assert.equal(v1.applied_postpetition_cents, 539_844n); assert.deepEqual(v1.short, [{ due: "2026-11-01", short_cents: 10_750n }]); assert.equal(a.postpetition_suspense_cents, 0n);
  // the voucher leaves the loan post-petition current with only the escrow shortfall: a short installment is not a whole unpaid one, and Dec (due 12-01) is inside its 30-day cycle until the 2027-01-20 conduit disbursement
  const s1 = postpetitionStatus(a, D("2026-12-19")); assert.equal(s1.current, true); assert.deepEqual(s1.whole_unpaid, ["2026-12-01"]); assert.equal(s1.days_delinquent, 18); assert.deepEqual(s1.short, [{ due: "2026-11-01", short_cents: 10_750n }]); assert.equal(s1.fnma_bucket, 0); assert.equal(s1.event, null);
  const s30 = postpetitionStatus(a, D("2027-01-02")); assert.equal(s30.fnma_bucket, 30); assert.equal(s30.current, false);   // one installment 30+ days unpaid → the 30 bucket (case.ts postpetitionDelinquencyDays would count the short Nov installment instead — defect noted)
  const v2 = C.applyVoucher(a, { amount_cents: 315_159n, designation: "unlabelled", conduit_district: true }); assert.equal(v2.applied_postpetition_cents, 280_672n + 10_750n); assert.equal(v2.applied_arrearage_cents, 23_737n); assert.equal(a.prepetition_arrearage_cents, 1_400_457n); assert.equal(v2.short.length, 0);
  // worked example B (direct pay): $1,500.00 on 2027-01-15 is less than one installment → bk_postpetition_suspense (bankruptcy_hold, no 30-day return clock); $1,306.72 on 01-28 completes $2,806.72 → Dec 1
  const b: C.Ledgers = { prepetition_arrearage_cents: 1_424_194n, postpetition: [{ due: D("2026-10-01"), amount_cents: 269_922n, paid_cents: 0n }, { due: D("2026-11-01"), amount_cents: 280_672n, paid_cents: 0n }, { due: D("2026-12-01"), amount_cents: 280_672n, paid_cents: 0n }, { due: D("2027-01-01"), amount_cents: 280_672n, paid_cents: 0n }, { due: D("2027-02-01"), amount_cents: 280_672n, paid_cents: 0n }], postpetition_suspense_cents: 0n };
  assert.deepEqual(applyDebtorPayment(b, 269_922n, D("2026-10-05")).applied, [{ due: "2026-10-01", cents: 269_922n }]); assert.deepEqual(applyDebtorPayment(b, 280_672n, D("2026-11-20")).applied, [{ due: "2026-11-01", cents: 280_672n }]);
  const jan15 = applyDebtorPayment(b, 150_000n, D("2027-01-15")); assert.deepEqual(jan15.applied, []); assert.equal(jan15.suspense_cents, 150_000n); assert.equal(jan15.hold, "bankruptcy_hold"); assert.equal(jan15.return_clock, null);
  const jan28 = applyDebtorPayment(b, 130_672n, D("2027-01-28")); assert.deepEqual(jan28.applied, [{ due: "2026-12-01", cents: 280_672n }]); assert.equal(jan28.suspense_cents, 0n); assert.equal(jan28.applied_arrearage_cents, 0n); assert.equal(b.prepetition_arrearage_cents, 1_424_194n);
  const s2 = postpetitionStatus(b, D("2027-02-02")); assert.deepEqual(s2.whole_unpaid, ["2027-01-01", "2027-02-01"]); assert.equal(s2.fnma_bucket, 60); assert.equal(s2.event, "bankruptcy.postpetition.delinquency.60"); assert.equal(C.mfrReferralDue(D("2027-02-02")), "2027-02-16");
  assert.equal(docketClassification({ event_type: "plan_confirmed", confidence: 0.95 }).state_change_allowed, true); assert.equal(docketClassification({ event_type: "plan_confirmed", confidence: 0.85 }).human_verification_required, true); assert.equal(docketClassification({ event_type: "discharge_order", confidence: 0.99 }).verifier, "attorney_or_human_agent");
  // E-2.1-06 adequate protection (conduit, 341 meeting 2026-10-14, confirmation 2026-12-10 > 45 days) and the orphan trustee payment detection source
  const ap = adequateProtectionCheck({ loan_id: LOAN, meeting_341_on: D("2026-10-14"), conduit_district: true, plan_confirmed_on: D("2026-12-10"), today: D("2026-12-10") }); assert.equal(ap.due, "2026-11-28"); assert.equal(ap.applies, true); assert.equal(ap.resolution!.payload.result, "plan_confirmed");
  const reg = loadOverriddenRegistry(); assert.ok(eventMatches(reg.get("FNMA_E2_1_06_ADEQUATE_PROTECTION_45")!.triggerPattern!, asEvent(ap.trigger!, 1))); assert.ok(eventMatches(reg.get("FNMA_E2_1_06_ADEQUATE_PROTECTION_45")!.satisfiedPattern!, asEvent(ap.resolution!, 2)));
  const orphan = orphanTrusteePayment({ loan_id: LOAN, received_at: "2026-09-10T14:00:00-04:00", amount_cents: 23_737n, payer_type: "trustee", open_case: false }); assert.equal(orphan.due, "2026-09-14"); assert.ok(eventMatches(reg.get("SM_BK_ORPHAN_TRUSTEE_PAYMENT_2BD")!.triggerPattern!, asEvent(orphan.events[0]!, 3))); assert.ok(eventMatches(reg.get("SM_BK_ORPHAN_TRUSTEE_PAYMENT_2BD")!.satisfiedPattern!, asEvent(orphan.resolve("case_opened", "2026-09-11T10:00:00-04:00"), 4)));
  assert.equal(orphanTrusteePayment({ loan_id: LOAN, received_at: "2026-12-18T14:00:00-04:00", amount_cents: 539_844n, payer_type: "trustee", open_case: true }).orphan, false);   // a conduit disbursement on an open case arms nothing
});
